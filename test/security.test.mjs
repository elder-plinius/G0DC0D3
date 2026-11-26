import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Broker, taskTools } from '../src/broker.mjs';
import { evaluateTask } from '../src/evaluator.mjs';
import { gitInit } from '../src/git.mjs';
import { HttpProvider, toolAliases } from '../src/providers.mjs';
import { executionBoundaryForPlatform, isSandboxSupportedPlatform, runCommand, runReadOnlyWorker } from '../src/runner.mjs';
import { getFixture } from '../fixtures/index.mjs';
import { repairFiles } from '../bench/scripted.mjs';
import { createApp } from '../src/server.mjs';
import { Store } from '../src/store.mjs';
import { MemoryStore } from '../src/memory.mjs';
import { TOOLS, validateTool } from '../src/tool-schema.mjs';

const sandboxSupported = { skip: !isSandboxSupportedPlatform() && 'Requires macOS Seatbelt or Linux bwrap' };
const expectedBoundary = executionBoundaryForPlatform();
const expectedReadOnlyBoundary = executionBoundaryForPlatform(process.platform, { readOnly: true });

test('fixture worker gets its snapshot over stdin and cannot read neighbors, write, fork, or connect', sandboxSupported, async t => {
  const root = await temporaryRoot(t);
  const entry = path.join(root, 'check.mjs');
  const url = await listener(t, (_req, res) => { res.end(); });
  await writeFile(path.join(root, 'neighbor.txt'), 'private');
  await writeFile(entry, [
    "import assert from 'node:assert/strict'; import fs from 'node:fs'; import http from 'node:http';",
    "import { spawnSync } from 'node:child_process';",
    "const denied = e => ['EPERM','EACCES','ENOENT','EROFS','ENETUNREACH','ECONNREFUSED'].includes(e.code);",
    "assert.throws(() => fs.readFileSync(new URL('./neighbor.txt', import.meta.url)), denied);",
    "assert.throws(() => fs.writeFileSync(new URL('./new.txt', import.meta.url), 'x'), denied);",
    "assert.ok(denied(spawnSync('/usr/bin/true').error));",
    "await assert.rejects(new Promise((resolve,reject) => http.get(" + JSON.stringify(url) + ", resolve).on('error', reject)), denied);",
    "for await (const chunk of process.stdin) process.stdout.write(chunk);",
  ].join('\n'));
  const result = await runReadOnlyWorker(entry, [], 'snapshot', { timeoutMs: 5000 });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, 'snapshot');
});

test('built-in configuration checks report real fixture evidence behind OS sandbox', async t => {
  const workspace = await temporaryRoot(t);
  const fixture = getFixture('config-parser');
  for (const [name, content] of Object.entries(fixture.files)) {
    const file = path.join(workspace, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  const result = await evaluateTask({ workspace, fixtureId: fixture.id });
  if (!isSandboxSupportedPlatform()) {
    assert.equal(result.status, 'unknown');
    assert.equal(result.executionBoundary, undefined);
    return;
  }
  // This fixture starts with a deliberately incorrect configuration parser.
  assert.equal(result.status, 'fail', JSON.stringify(result.checks));
  assert.equal(result.executionBoundary, expectedReadOnlyBoundary);
  assert.ok(result.checks.some(check => check.status === 'fail'));
  for (const [name, content] of Object.entries(repairFiles['config-parser']))
    await writeFile(path.join(workspace, name), content);
  const repaired = await evaluateTask({ workspace, fixtureId: fixture.id });
  assert.equal(repaired.status, 'pass', JSON.stringify(repaired.checks));
  assert.equal(repaired.executionBoundary, expectedReadOnlyBoundary);
  assert.notEqual(repaired.snapshotHash, result.snapshotHash);
});

async function temporaryRoot(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'godcode-security-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function listener(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

test('all tool contracts reject extra fields, missing required inputs and malformed results', () => {
  assert.equal(new Set(TOOLS.map(tool => tool.name)).size, TOOLS.length);
  for (const { name, parameters } of TOOLS) {
    assert.equal(parameters.additionalProperties, false, name);
    assert.throws(() => validateTool(name, { unexpected: true }), { code: 'INVALID_TOOL' });
    if (parameters.required.length)
      assert.throws(() => validateTool(name, {}), { code: 'INVALID_TOOL' });
    assert.throws(() => validateTool(name, {}, { result: true }), { code: 'INVALID_TOOL_RESULT' });
    validateTool(name, { ok: false, error: { code: 'TEST', message: 'test' } }, { result: true });
  }
  assert.throws(() => validateTool('unknown', {}), { code: 'INVALID_TOOL' });
  assert.throws(() => validateTool('repo.read', { path: 'label.txt', limit: '1' }), { code: 'INVALID_TOOL' });
  assert.throws(() => validateTool('repo.read', { path: 'label.txt', limit: 0 }), { code: 'INVALID_TOOL' });
  assert.throws(() => validateTool('process.run', { command: 'true', network: true }), { code: 'INVALID_TOOL' });
  assert.deepEqual(taskTools({ crewMember: { role: 'challenger' } }).map(x => x.name).sort(),
    ['repo.glob', 'repo.list', 'repo.read', 'repo.search', 'task.history']);
});

test('every registered tool returns valid evidence on a disposable Git project', sandboxSupported, async t => {
  const root = await temporaryRoot(t);
  const workspace = path.join(root, 'project');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'label.txt'), 'alpha\n');
  await gitInit(workspace);
  const store = new Store(path.join(root, 'state'));
  try {
    const task = store.createTask({
      id: randomUUID(), title: 'Edit a label', status: 'running', epoch: 1, workspace,
      execution: { enabled: true, network: false, timeoutMs: 10000 }, checksContractVersion: 1,
      checks: [{ name: 'Label content', command: 'grep -qx beta label.txt' }],
    });
    const memory = new MemoryStore(store, store.dataDir);
    const broker = new Broker({ store, evaluator: evaluateTask, memory });
    const covered = new Set();
    async function call(name, args = {}) {
      const result = await broker.execute(task.id, { name, args, id: randomUUID() }, { epoch: task.epoch });
      validateTool(name, result, { result: true });
      covered.add(name);
      return result;
    }
    assert.deepEqual((await call('repo.list')).files.map(x => x.path), ['label.txt']);
    const first = await call('repo.read', { path: 'label.txt' });
    assert.equal(first.content, 'alpha\n');
    assert.equal((await call('repo.search', { query: 'alpha' })).matches[0].line, 1);
    assert.equal((await call('repo.write', { path: 'note.txt', content: 'review\n', expectedHash: null })).ok, true);
    assert.deepEqual((await call('repo.glob', { pattern: '*.txt' })).files.map(x => x.path).sort(), ['label.txt', 'note.txt']);
    const note = await call('repo.read', { path: 'note.txt' });
    assert.equal((await call('repo.move', { from: 'note.txt', to: 'review.txt', expectedHash: note.sha256 })).ok, true);
    assert.equal((await call('repo.delete', { path: 'review.txt', expectedHash: note.sha256 })).ok, true);

    const patch = { path: 'label.txt', oldText: 'alpha', newText: 'beta', expectedHash: first.sha256 };
    assert.equal((await call('repo.patch', patch)).ok, true);
    assert.equal((await call('repo.patch', patch)).error.code, 'PREIMAGE_MISMATCH');
    assert.equal((await call('repo.read', { path: '.git/HEAD' })).error.code, 'PATH_DENIED');
    const command = await call('process.run', { command: 'cat label.txt' });
    assert.equal(command.exitCode, 0);
    assert.equal(command.stdout, 'beta\n');
    assert.equal(command.executionBoundary, expectedBoundary);
    assert.equal((await call('check.run')).status, 'pass');
    assert.match((await call('git.diff')).diff, /\+beta/);
    assert.equal((await call('git.commit', { message: 'Update label' })).committed, true);
    assert.match((await call('git.log')).log, /Update label/);
    assert.ok((await call('task.history')).events.length > 0);
    const savedMem = await call('memory.save', { title: 'Label convention', content: 'Use beta in label.txt', scope: 'project', tags: ['label'] });
    assert.equal(savedMem.ok, true);
    assert.ok((await call('memory.search', { query: 'beta' })).memories.length >= 1);
    assert.equal((await call('memory.delete', { id: savedMem.memory.id })).deleted, true);
    assert.equal((await call('task.todo', { items: [{ id: '1', text: 'Verify label', status: 'done' }] })).done, 1);
    assert.equal((await call('web.fetch', { url: 'http://127.0.0.1/blocked' })).error.code, 'SSRF_BLOCKED');
    assert.equal((await call('web.search', { query: '   ' })).error.code, 'INVALID_QUERY');
    assert.equal((await call('browser.open', { url: 'file:///etc/passwd' })).error.code, 'BROWSER_URL_DENIED');
    assert.equal((await call('browser.snapshot')).error.code, 'BROWSER_NOT_OPEN');
    assert.equal((await call('browser.act', { action: 'click', ref: 'e1' })).error.code, 'BROWSER_NOT_OPEN');
    assert.equal((await call('browser.screenshot')).error.code, 'BROWSER_NOT_OPEN');
    assert.equal((await call('browser.eval', { expression: '1 + 1' })).error.code, 'BROWSER_NOT_OPEN');
    assert.equal((await call('browser.close')).closed, false);
    assert.equal((await call('agent.spawn', { role: 'explore', prompt: 'List files' })).error.code, 'SUBAGENT_RUNTIME_REQUIRED');
    assert.deepEqual([...covered].sort(), TOOLS.map(x => x.name).sort());
  } finally {
    store.close();
  }
});

test('a task without a command grant cannot start a process', async t => {
  const workspace = await temporaryRoot(t);
  await assert.rejects(runCommand({ workspace }, { command: 'true' }), { code: 'EXECUTION_DENIED' });
});

test('OS sandbox confines reads and writes and strips inherited environment variables', sandboxSupported, async t => {
  const root = await temporaryRoot(t);
  const workspace = path.join(root, 'project');
  await mkdir(workspace);
  await mkdir(path.join(workspace, '.git'));
  await writeFile(path.join(workspace, '.git', 'HEAD'), 'protected');
  await writeFile(path.join(root, 'outside.txt'), 'private');
  await writeFile(path.join(workspace, 'verify.cjs'), [
    "const fs = require('node:fs'), assert = require('node:assert/strict');",
    "const denied = e => ['EPERM', 'EACCES', 'ENOENT', 'EROFS'].includes(e.code);",
    "assert.throws(() => fs.readFileSync('../outside.txt'), denied);",
    "assert.throws(() => fs.writeFileSync('../outside.txt', 'changed'), denied);",
    "assert.throws(() => fs.readFileSync('.git/HEAD'), denied);",
    "assert.throws(() => fs.writeFileSync('.git/HEAD', 'changed'), denied);",
    "assert.equal(process.env.GODCODE_TEST_PARENT_ONLY, undefined);",
    "fs.writeFileSync('inside.txt', 'allowed');",
  ].join('\n'));
  const saved = process.env.GODCODE_TEST_PARENT_ONLY;
  process.env.GODCODE_TEST_PARENT_ONLY = 'synthetic-canary';
  try {
    const result = await runCommand({ workspace, execution: { enabled: true } }, { command: 'node verify.cjs' });
    assert.equal(result.exitCode, 0, result.stderr);
  } finally {
    if (saved === undefined) delete process.env.GODCODE_TEST_PARENT_ONLY;
    else process.env.GODCODE_TEST_PARENT_ONLY = saved;
  }
  assert.equal(await readFile(path.join(workspace, 'inside.txt'), 'utf8'), 'allowed');
  assert.equal(await readFile(path.join(root, 'outside.txt'), 'utf8'), 'private');
  assert.equal(await readFile(path.join(workspace, '.git', 'HEAD'), 'utf8'), 'protected');
});

test('the same loopback HTTP request is blocked by default and succeeds with a network grant', sandboxSupported, async t => {
  const workspace = await temporaryRoot(t);
  let hits = 0;
  const url = await listener(t, (_req, res) => { hits++; res.end('receipt'); });
  await writeFile(path.join(workspace, 'client.cjs'), [
    "require('node:http').get(" + JSON.stringify(url) + ", res => res.pipe(process.stdout))",
    "  .on('error', e => { process.stderr.write(e.code); process.exitCode = 1; });",
  ].join('\n'));
  const command = { command: 'node client.cjs', timeoutMs: 5000 };
  const closed = await runCommand({ workspace, execution: { enabled: true } }, command);
  assert.equal(closed.exitCode, 1);
  assert.match(closed.stderr, /^(EPERM|EACCES|ENETUNREACH|ECONNREFUSED)$/);
  assert.equal(hits, 0);
  const opened = await runCommand({ workspace, execution: { enabled: true, network: true } }, command);
  assert.equal(opened.exitCode, 0, opened.stderr);
  assert.equal(opened.stdout, 'receipt');
  assert.equal(hits, 1);
});

test('the desktop API requires a local Host, same-origin requests, a session and a mutation header', async t => {
  const app = await createApp({ dataDir: await temporaryRoot(t), providers: new Map() });
  try {
    const url = await app.listen(0);
    assert.equal(app.server.address().address, '127.0.0.1');
    const token = new URLSearchParams(new URL(app.accessUrl).hash.slice(1)).get('session');
    async function exchange(headers) {
      return fetch(url + '/api/session', {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ token }),
      });
    }
    assert.equal((await fetch(url + '/api/state')).status, 401);
    const hostStatus = await new Promise((resolve, reject) => {
      http.get(url + '/api/health', { headers: { host: 'other.invalid' } }, res => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    assert.equal(hostStatus, 403);
    assert.equal((await exchange({ origin: url })).status, 403);
    assert.equal((await exchange({ origin: 'https://other.invalid', 'x-g0d-request': '1' })).status, 403);
    const signedIn = await exchange({ origin: url, 'x-g0d-request': '1' });
    assert.equal(signedIn.status, 200);
    const session = signedIn.headers.get('set-cookie');
    assert.ok(session.includes('HttpOnly') && session.includes('SameSite=Strict'));
    const cookie = session.split(';')[0];
    assert.equal((await fetch(url + '/api/state', { headers: { cookie, origin: 'https://other.invalid' } })).status, 403);
    assert.equal((await fetch(url + '/api/state', { headers: { cookie, origin: url } })).status, 200);
  } finally {
    await app.close();
  }
});

const context = { task: { id: 'test', objective: 'Read a label.' }, tools: TOOLS };
const reader = toolAliases().forward.get('repo.read');
const args = { path: 'label.txt' };
const responses = {
  'openai-chat': {
    path: '/chat/completions',
    reply: { choices: [{ message: { tool_calls: [{ id: 'read', function: { name: reader, arguments: JSON.stringify(args) } }] } }] },
  },
  'openai-responses': {
    path: '/responses',
    reply: { output: [{ type: 'function_call', call_id: 'read', name: reader, arguments: JSON.stringify(args) }] },
  },
  anthropic: {
    path: '/messages',
    reply: { content: [{ type: 'tool_use', id: 'read', name: reader, input: args }] },
  },
};

for (const [protocol, fixture] of Object.entries(responses)) {
  test(protocol + ' sends the canonical tool schemas and decodes a read request', async t => {
    let request;
    const credential = 'synthetic-test-key';
    const baseUrl = await listener(t, async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      request = { path: req.url, headers: req.headers, body: JSON.parse(body) };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(fixture.reply));
    });
    const provider = new HttpProvider({ id: 'test', model: 'local-test', protocol, baseUrl, credential });
    t.after(() => provider.close());
    const decision = await provider.turn(context);
    assert.equal(request.path, fixture.path);
    assert.equal(protocol === 'anthropic' ? request.headers['x-api-key'] : request.headers.authorization,
      protocol === 'anthropic' ? credential : 'Bearer ' + credential);
    const sent = request.body.tools.map(entry => entry.function ?? entry);
    const aliases = toolAliases();
    assert.deepEqual(sent.map(tool => [tool.name, tool.parameters ?? tool.input_schema]),
      TOOLS.map(tool => [aliases.forward.get(tool.name), tool.parameters]));
    assert.equal(decision.type, 'tool');
    assert.deepEqual(decision.calls, [{ id: 'read', name: 'repo.read', args }]);
  });
}

test('model turns and worktree proposals reject redirects before a second server receives a request', async t => {
  let redirected = 0, original = 0;
  const destination = await listener(t, (_req, res) => { redirected++; res.end(); });
  const baseUrl = await listener(t, (_req, res) => {
    original++;
    res.writeHead(307, { location: destination });
    res.end();
  });
  const provider = new HttpProvider({ id: 'test', model: 'test', baseUrl, credential: 'synthetic-test-key' });
  t.after(() => provider.close());
  await assert.rejects(provider.turn(context));
  await assert.rejects(provider.proposePatch({
    objective: 'Edit a label', files: [], parameters: {}, signal: new AbortController().signal,
  }));
  assert.equal(original, 2);
  assert.equal(redirected, 0);
});
