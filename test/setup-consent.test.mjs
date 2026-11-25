import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { createCliConnections, CLI_INFERENCE_CONSENT } from '../src/provider-connections.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'godmode-setup-'));
  const home = path.join(dir, 'home'), log = path.join(dir, 'cli-calls.jsonl');
  await mkdir(home); await writeFile(log, '');
  const binary = path.join(dir, 'cli');
  await writeFile(binary, `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(args.join(' ')==='login status')console.log('Logged in using ChatGPT');
else if(args.join(' ')==='auth status --json')console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai'}));
else process.exit(9);
`, {mode:0o755});
  const cliDiscovery = { home, environment: { HOME:home, PATH:process.env.PATH,
    G0D_CODEX_BINARY:binary, G0D_CLAUDE_BINARY:binary,
    G0D_GEMINI_BINARY:path.join(dir,'absent-gemini'), G0D_COPILOT_BINARY:path.join(dir,'absent-copilot') } };
  const dataDir = path.join(dir, 'state');
  let app;
  t.after(async () => { await app?.close(); await rm(dir, {recursive:true,force:true}); });
  async function start(auth = false) {
    await app?.close();
    app = await createApp({ dataDir, providers:new Map(), cliDiscovery, auth });
    const root = await app.listen(0);
    const token = new URLSearchParams(new URL(app.accessUrl).hash.slice(1)).get('session');
    const request = async (route, body, method = body ? 'POST' : 'GET', authenticate = true) => {
      const res = await fetch(root + route, { method, headers: { 'content-type':'application/json','x-g0d-request':'1',
        ...(token && authenticate ? {authorization:'Bearer '+token} : {}) }, body:body && JSON.stringify(body) });
      return { status:res.status, ...await res.json() };
    };
    return {app, request};
  }
  return {dir,home,log,dataDir,cliDiscovery,start};
}

test('setup discovers signed-in CLIs without enabling or invoking inference; consent and skip survive restart', async t => {
  const f = await fixture(t);
  let {app,request} = await f.start();
  const initial = await request('/api/setup');
  assert.equal(initial.setup.status, 'pending');
  assert.equal(initial.consent.version, 1);
  assert.equal(initial.connections.find(c => c.id === 'codex-cli').authenticated, true);
  assert.equal(initial.connections.find(c => c.id === 'claude-code').authenticated, true);
  assert.ok(initial.connections.every(c => !c.enabled));
  assert.equal(app.runtime.providers.size, 0);
  await assert.rejects(stat(path.join(f.dataDir, 'cli-connections.json')), {code:'ENOENT'});
  const denied = await request('/api/providers/connections', {id:'codex-cli'});
  assert.equal(denied.status, 409); assert.equal(denied.code, 'CONSENT_REQUIRED');
  assert.equal((await request('/api/providers/connections', {id:'codex-cli',consentVersion:999})).status, 409);
  assert.equal((await request('/api/setup', {version:1,status:'deferred',providerIds:['codex-cli']})).status, 400);
  await request('/api/setup', {version:1,status:'deferred'});
  assert.equal(app.runtime.providers.size, 0);
  ({app,request} = await f.start());
  assert.equal((await request('/api/state')).setup.status, 'deferred');
  assert.equal(app.runtime.providers.size, 0);

  const permsBefore = app.runtime.getGlobalPermissions().rules;
  const connected = await request('/api/providers/connections', {id:'codex-cli',consentVersion:CLI_INFERENCE_CONSENT.version});
  assert.equal(connected.status, 200);
  assert.equal(connected.connections.find(c => c.id === 'codex-cli').enabled, true);
  assert.equal(connected.connections.find(c => c.id === 'claude-code').enabled, false);
  assert.deepEqual(app.runtime.getGlobalPermissions().rules, permsBefore);
  const saved = JSON.parse(await readFile(path.join(f.dataDir,'cli-connections.json'),'utf8'));
  assert.equal(saved.connections['codex-cli'].consent.scope, 'inference');
  assert.equal(saved.connections['codex-cli'].consent.version, 1);
  assert.ok(Number.isFinite(Date.parse(saved.connections['codex-cli'].consent.acceptedAt)));
  assert.equal((await stat(path.join(f.dataDir,'cli-connections.json'))).mode & 0o777, 0o600);
  await request('/api/setup', {version:1,status:'completed'});
  ({app,request} = await f.start());
  assert.equal((await request('/api/state')).setup.status, 'completed');
  assert.equal(app.runtime.providers.has('codex-cli'), true);
  assert.equal(app.runtime.providers.has('claude-code'), false);
  const disconnected = await request('/api/providers/connections', {id:'codex-cli'}, 'DELETE');
  assert.equal(disconnected.status, 200);
  assert.equal(disconnected.connections.find(c => c.id === 'codex-cli').enabled, false);
  assert.equal(disconnected.connections.find(c => c.id === 'codex-cli').authenticated, true, 'disconnect does not log out the underlying CLI');
  assert.equal(app.runtime.providers.size, 0);
  const calls=(await readFile(f.log,'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.length > 0);
  assert.ok(calls.every(args => ['login status','auth status --json'].includes(args.join(' '))), 'discovery and connection only execute auth-status probes');
});

test('setup endpoints require the local session; previous explicit connection opt-ins remain valid', async t => {
  const f=await fixture(t);
  let {request,app}=await f.start(true);
  assert.equal((await request('/api/setup',undefined,'GET',false)).status,401);
  assert.equal((await request('/api/setup',{version:1,status:'completed'},'POST',false)).status,401);
  assert.equal((await request('/api/providers/connections',{id:'codex-cli',consentVersion:1},'POST',false)).status,401);
  await app.close();
  await writeFile(path.join(f.dataDir,'cli-connections.json'),JSON.stringify({version:1,connections:{'codex-cli':{enabled:true,model:null}}}),{mode:0o600});
  ({request,app}=await f.start());
  const result=await request('/api/setup');
  assert.equal(result.connections.find(c=>c.id==='codex-cli').authorization.source,'previous-opt-in');
  assert.equal(app.runtime.providers.has('codex-cli'),true);
  assert.equal(app.runtime.providers.has('claude-code'),false);
});

test('an unrelated Gemini MCP auth marker is not presented as a model login', async t => {
  const f=await fixture(t);
  await mkdir(path.join(f.home,'.gemini'));
  await writeFile(path.join(f.home,'.gemini','mcp-oauth-tokens.json'),'unrelated-token-file');
  const gemini=path.join(f.dir,'gemini');
  await writeFile(gemini,'#!/bin/sh\nprintf "version 1\\n"\n',{mode:0o755});
  const connections=await createCliConnections({dataDir:f.dataDir,providers:new Map(),...f.cliDiscovery,
    environment:{...f.cliDiscovery.environment,G0D_GEMINI_BINARY:gemini}});
  const record=(await connections.status()).connections.find(c=>c.id==='gemini-cli');
  assert.equal(record.installed,true); assert.equal(record.ready,false); assert.equal(record.authenticated,false);
});
