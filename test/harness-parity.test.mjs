import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { MemoryStore, sanitizeFtsQuery } from '../src/memory.mjs';
import { discoverSkills, saveUserSkill, deleteUserSkill } from '../src/skills.mjs';
import { evaluatePermission, validatePermissionRules, DEFAULT_SAFE_PRESET } from '../src/permissions.mjs';
import { Runtime } from '../src/runtime.mjs';
import { createApp } from '../src/server.mjs';
import {
  GeminiCliProvider,
  CopilotCliProvider,
  geminiSubscriptionEnvironment,
  copilotSubscriptionEnvironment,
  parsePlannerDecisionEnvelope
} from '../src/providers.mjs';
import { createCliConnections } from '../src/provider-connections.mjs';
import { gitCommit } from '../src/git.mjs';

async function mkTemp(prefix = 'g0d-parity-') {
  return fs.mkdtemp(path.join(tmpdir(), prefix));
}

function dispatch(app, { method = 'GET', url = '/', headers = {}, body } = {}) {
  const address = app.server.address() || { address: '127.0.0.1', port: 4317 };
  if (!app.server.address()) app.server.address = () => address;
  const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const req = Readable.from(payload ? [payload] : []);
  req.method = method;
  req.url = url;
  req.headers = {
    host: `127.0.0.1:${address.port}`,
    ...(['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) ? { origin: `http://127.0.0.1:${address.port}`, 'x-g0d-request': '1' } : {}),
    ...(payload ? { 'content-type': 'application/json' } : {}),
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  };
  req.setTimeout = () => {};
  return new Promise((resolve, reject) => {
    const resHeaders = new Map();
    const chunks = [];
    const res = {
      statusCode: 200,
      headersSent: false,
      setTimeout() {},
      setHeader(name, value) { resHeaders.set(name.toLowerCase(), value); },
      getHeader(name) { return resHeaders.get(name.toLowerCase()); },
      writeHead(status, hdrs = {}) {
        this.statusCode = status;
        this.headersSent = true;
        for (const [k, v] of Object.entries(hdrs)) resHeaders.set(k.toLowerCase(), v);
      },
      write(chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); },
      end(chunk) {
        if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: this.statusCode, headers: resHeaders, text, json });
      }
    };
    try { app.server.emit('request', req, res); }
    catch (err) { reject(err); }
  });
}

function makeStubProvider(id, turns) {
  let idx = 0;
  return {
    id,
    label: id,
    kind: 'http',
    tier: 'frontier',
    available: true,
    accounting: 'stub',
    capabilities: { tools: true, nativeTools: true, portableContext: true },
    async turn(context) {
      const fn = turns[Math.min(idx++, turns.length - 1)];
      return typeof fn === 'function' ? fn(context, idx) : fn;
    }
  };
}

test('Cross-session persistent memory: FTS5 search, upsert, punctuation safety, memory.md sync, and prompt injection', async () => {
  const dir = await mkTemp('g0d-mem-');
  const store = new Store(dir);
  try {
    const mem = new MemoryStore(store, dir);
    const first = mem.saveMemory({ title: 'Build System', content: 'Always run npm test before shipping.', scope: 'global', tags: ['ci', 'testing'] });
    assert.equal(first.created, true);
    const updated = mem.saveMemory({ title: 'build system', content: 'Run npm test and node --check.', scope: 'global', tags: ['ci'] });
    assert.equal(updated.created, false);
    assert.equal(updated.memory.id, first.memory.id);

    const projectScope = 'project:/tmp/example-app';
    mem.saveMemory({ title: 'API Auth', content: 'Uses HMAC-SHA256 bearer tokens in src/auth.mjs.', scope: projectScope, tags: ['auth'] });

    // Special FTS5 punctuation must never throw
    assert.equal(typeof sanitizeFtsQuery('foo:bar "baz" (test)* -not'), 'string');
    const punctSearch = mem.searchMemories({ query: 'HMAC-SHA256 (bearer): "tokens"*', scope: projectScope });
    assert.equal(punctSearch.ok, true);
    assert.equal(punctSearch.memories.length >= 1, true);
    assert.equal(punctSearch.memories[0].title, 'API Auth');

    // Human-auditable memory.md exists with 0o600 perms
    const mdStat = await fs.stat(mem.memoryFile);
    assert.equal(mdStat.mode & 0o777, 0o600);
    const mdText = await fs.readFile(mem.memoryFile, 'utf8');
    assert.match(mdText, /Build System|build system/);
    assert.match(mdText, /API Auth/);

    // Project memories rank ahead of global in relevantForTask
    const relevant = mem.relevantForTask({ sourcePath: '/tmp/example-app', objective: 'Update auth tokens' });
    assert.equal(relevant.length >= 2, true);
    assert.equal(relevant[0].scope, projectScope);

    // Delete removes entry and updates memory.md
    const del = mem.deleteMemory(first.memory.id);
    assert.equal(del.deleted, true);
    const afterMd = await fs.readFile(mem.memoryFile, 'utf8');
    assert.doesNotMatch(afterMd, /node --check/);
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Project & global skills discovery: overrides, frontmatter, symlink rejection, size cap, and CRUD', async () => {
  const dir = await mkTemp('g0d-skills-');
  const projectDir = await mkTemp('g0d-proj-');
  try {
    // Global skill
    const saved = await saveUserSkill(dir, {
      name: 'review',
      description: 'Global code review checklist',
      body: 'Review $ARGUMENTS for bugs and regressions.',
      mode: 'plan'
    });
    assert.equal(saved.command, '/review');

    // Project overrides global + OpenCode/Claude commands + SKILL.md format
    await fs.mkdir(path.join(projectDir, '.g0dc0d3', 'commands'), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, '.g0dc0d3', 'commands', 'review.md'),
      '---\nname: review\ndescription: Project-specific review\nmode: plan\n---\nCheck project invariants for $ARGUMENTS.'
    );
    await fs.mkdir(path.join(projectDir, '.g0dc0d3', 'skills', 'deploy-check'), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, '.g0dc0d3', 'skills', 'deploy-check', 'SKILL.md'),
      '---\nname: deploy-check\ndescription: Pre-release checks\n---\nVerify build artifacts.'
    );
    await fs.mkdir(path.join(projectDir, '.opencode', 'commands'), { recursive: true });
    await fs.writeFile(path.join(projectDir, '.opencode', 'commands', 'triage.md'), 'Triage failing tests.');

    // Symlink must be ignored
    const outside = path.join(dir, 'secret.md');
    await fs.writeFile(outside, 'DO NOT READ');
    await fs.symlink(outside, path.join(projectDir, '.g0dc0d3', 'commands', 'evil-link.md'));

    // Oversized file (>32 KiB) must be ignored
    await fs.writeFile(path.join(projectDir, '.g0dc0d3', 'commands', 'huge.md'), 'x'.repeat(40000));

    const discovered = await discoverSkills({ dataDir: dir, sourcePath: projectDir });
    const byName = new Map(discovered.map(s => [s.name, s]));
    assert.equal(byName.get('review')?.scope, 'project');
    assert.equal(byName.get('review')?.description, 'Project-specific review');
    assert.equal(byName.has('deploy-check'), true);
    assert.equal(byName.has('triage'), true);
    assert.equal(byName.has('evil-link'), false);
    assert.equal(byName.has('huge'), false);

    // Invalid slug rejected
    await assert.rejects(() => saveUserSkill(dir, { name: '../escape', body: 'nope' }));

    // Delete global skill
    const deleted = await deleteUserSkill(dir, 'review');
    assert.equal(deleted.deleted, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

test('Permission rules (allow/ask/deny), interactive approval gate (once/always/deny), and Doom-Loop guard', async () => {
  // Unit checks on last-match-wins evaluator
  const rules = validatePermissionRules([
    { tool: '*', action: 'allow' },
    { tool: 'repo.delete', action: 'ask', reason: 'Confirm deletions' },
    { tool: 'process.run', pattern: '*rm -rf*', action: 'deny', reason: 'Blocked destructive command' }
  ]);
  assert.equal(evaluatePermission(rules, 'repo.read', { path: 'a.js' }).action, 'allow');
  assert.equal(evaluatePermission(rules, 'repo.delete', { path: 'a.js' }).action, 'ask');
  assert.equal(evaluatePermission(rules, 'process.run', { command: 'rm -rf /tmp/x' }).action, 'deny');
  assert.equal(evaluatePermission(DEFAULT_SAFE_PRESET, 'process.run', { command: 'git push --force origin main' }).action, 'deny');

  // Runtime interactive approval gate (ask -> pause -> once -> executes -> done)
  const dir = await mkTemp('g0d-perm-');
  const workDir = path.join(dir, 'work');
  await fs.mkdir(workDir, { recursive: true });
  await fs.writeFile(path.join(workDir, 'note.txt'), 'hello\n');
  const stub = makeStubProvider('stub-live', [
    () => ({ type: 'tool', calls: [{ id: 'c1', name: 'repo.write', args: { path: 'created.txt', content: 'ok\n', expectedHash: null } }] }),
    () => ({ type: 'tool', calls: [{ id: 'c2', name: 'repo.write', args: { path: 'created.txt', content: 'ok\n', expectedHash: null } }] }),
    () => ({ type: 'message', text: 'Wrote created.txt after approval.', finish: 'done' })
  ]);
  const runtime = new Runtime({ dataDir: dir, providers: new Map([['stub-live', stub]]) });
  try {
    const task = await runtime.createTask({
      title: 'Approval Gate Test',
      objective: 'Create created.txt',
      workspace: workDir,
      providers: ['stub-live'],
      acceptance: { mode: 'owner' },
      permissionRules: [{ tool: 'repo.write', action: 'ask', reason: 'Confirm file writes' }]
    });

    const paused = await runtime.run(task.id);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.pendingApproval?.tool, 'repo.write');
    assert.equal(paused.pendingApproval?.target, 'created.txt');

    // Approve once (resume: false so we can resume + run deterministically)
    const resolved = await runtime.resolveApproval(task.id, { decision: 'once', resume: false });
    assert.equal(resolved.task.pendingApproval, null);
    runtime.resume(task.id);
    const finished = await runtime.run(task.id);
    assert.equal(finished.status, 'waiting_input');
    assert.equal(finished.pendingApproval, null);
    assert.equal(await fs.readFile(path.join(workDir, 'created.txt'), 'utf8'), 'ok\n');

    // Doom-loop guard: 3 consecutive identical calls return DOOM_LOOP_DETECTED
    const loopDir = path.join(dir, 'loop-work');
    await fs.mkdir(loopDir, { recursive: true });
    await fs.writeFile(path.join(loopDir, 'app.js'), 'export const x = 1;\n');
    const loopStub = makeStubProvider('loop-live', [
      () => ({ type: 'tool', calls: [{ id: 'l1', name: 'repo.read', args: { path: 'app.js' } }] }),
      () => ({ type: 'tool', calls: [{ id: 'l2', name: 'repo.read', args: { path: 'app.js' } }] }),
      () => ({ type: 'tool', calls: [{ id: 'l3', name: 'repo.read', args: { path: 'app.js' } }] }),
      () => ({ type: 'message', text: 'Broke out of loop.', finish: 'done' })
    ]);
    runtime.providers.set('loop-live', loopStub);
    const loopTask = await runtime.createTask({
      title: 'Doom Loop Test',
      objective: 'Read app.js once',
      workspace: loopDir,
      providers: ['loop-live'],
      acceptance: { mode: 'owner' }
    });
    await runtime.run(loopTask.id);
    const loopEvents = runtime.getEvents(loopTask.id);
    assert.equal(loopEvents.some(e => e.type === 'runtime.doom_loop'), true);
  } finally {
    await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('task.todo in Plan Mode, forkTask with fromHash, Markdown transcript export, and HTTP parity routes', async () => {
  const dir = await mkTemp('g0d-http-parity-');
  const stub = makeStubProvider('stub-live', [
    () => ({
      type: 'tool',
      calls: [{
        id: 't1',
        name: 'task.todo',
        args: {
          items: [
            { id: '1', text: 'Inspect files', status: 'done' },
            { id: '2', text: 'Apply fix', status: 'in_progress' }
          ]
        }
      }]
    }),
    () => ({ type: 'message', text: 'Plan checklist updated.', finish: 'done' })
  ]);
  const app = await createApp({ dataDir: dir, providers: new Map([['stub-live', stub]]), auth: false });
  const req = (method, url, body) => dispatch(app, { method, url, body });

  try {
    // Create a plan-mode conversation task and run task.todo
    const created = await req('POST', '/api/conversations', {
      title: 'Parity Flow',
      objective: 'Make a checklist',
      providerIds: ['stub-live'],
      planMode: true
    });
    assert.equal(created.status, 201);
    const taskId = created.json.task.id;

    const ran = await app.runtime.run(taskId);
    assert.equal(ran.todos?.length, 2);
    assert.equal(ran.todos[0].status, 'done');

    // Create two git commits in workspace, then test /commit and /fork with fromHash
    const ws = app.runtime.getTask(taskId).workspace;
    await fs.writeFile(path.join(ws, 'v1.txt'), 'one\n');
    const c1 = await req('POST', `/api/tasks/${taskId}/commit`, { message: 'checkpoint v1' });
    assert.equal(c1.status, 200);
    assert.equal(c1.json.committed, true);
    const v1Hash = c1.json.checkpoints[0].hash;

    await fs.writeFile(path.join(ws, 'v2.txt'), 'two\n');
    const c2 = await gitCommit(ws, { message: 'checkpoint v2' });
    assert.equal(c2.committed, true);

    const forked = await req('POST', `/api/tasks/${taskId}/fork`, { title: 'Branch from v1', fromHash: v1Hash });
    assert.equal(forked.status, 201);
    const forkTask = forked.json.task;
    assert.equal(forkTask.parentTaskId, taskId);
    const forkWs = app.runtime.getTask(forkTask.id).workspace;
    // Fork rewound to v1: has v1.txt, does NOT have v2.txt; parent still has v2.txt!
    await fs.access(path.join(forkWs, 'v1.txt'));
    await assert.rejects(() => fs.access(path.join(forkWs, 'v2.txt')));
    await fs.access(path.join(ws, 'v2.txt'));

    // Transcript export (Markdown & JSON)
    const mdRes = await req('GET', `/api/tasks/${taskId}/transcript`);
    assert.equal(mdRes.status, 200);
    assert.match(mdRes.text, /# Parity Flow/);
    assert.match(mdRes.text, /Inspect files/);
    const jsonRes = await req('GET', `/api/tasks/${taskId}/transcript?format=json`);
    assert.equal(jsonRes.status, 200);
    assert.equal(jsonRes.json.format, 'markdown');

    // Memory & Skills HTTP CRUD
    const memSave = await req('POST', '/api/memory', { title: 'Test Rule', content: 'Prefer node:test', scope: 'global' });
    assert.equal(memSave.status, 201);
    const memList = await req('GET', '/api/memory?q=node:test');
    assert.equal(memList.status, 200);
    assert.equal(memList.json.memories.length >= 1, true);
    const memDel = await req('DELETE', `/api/memory/${memSave.json.memory.id}`);
    assert.equal(memDel.status, 200);

    const skillSave = await req('POST', '/api/skills', { name: 'audit-pr', description: 'Audit a PR', body: 'Check tests and security.' });
    assert.equal(skillSave.status, 201);
    const skillList = await req('GET', `/api/skills?taskId=${taskId}`);
    assert.equal(skillList.json.skills.some(s => s.name === 'audit-pr'), true);
    const skillDel = await req('DELETE', '/api/skills/audit-pr');
    assert.equal(skillDel.status, 200);

    // Permissions preset endpoint
    const permRes = await req('PATCH', '/api/permissions', { preset: 'safe' });
    assert.equal(permRes.status, 200);
    assert.equal(permRes.json.rules.length > 0, true);
    await req('PATCH', '/api/permissions', { preset: 'permissive' });

    // Multi-provider API key registration validation (rejects bad provider & newline)
    const badKey = await req('POST', '/api/providers/key', { provider: 'unknown-vendor', key: 'test-key' });
    assert.equal(badKey.status, 400);
    const newlineKey = await req('POST', '/api/providers/key', { provider: 'nous', key: 'bad\nkey' });
    assert.equal(newlineKey.status, 400);
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Universal Subscription Hub: Gemini CLI & GitHub Copilot providers, auth probing, connect/disconnect, and multi-provider API keys', async () => {
  const dir = await mkTemp('g0d-subs-');
  const fakeHome = path.join(dir, 'home');
  const binDir = path.join(dir, 'bin');
  await fs.mkdir(path.join(fakeHome, '.gemini'), { recursive: true });
  await fs.mkdir(path.join(fakeHome, '.copilot'), { recursive: true });
  await fs.mkdir(binDir, { recursive: true });

  // Non-empty mock subscription auth markers (provider-connections only checks existence, never reads secrets)
  await fs.writeFile(path.join(fakeHome, '.gemini', 'oauth_creds.json'), '{"type":"authorized_user"}\n');
  await fs.writeFile(path.join(fakeHome, '.copilot', 'config.json'), '{"logged_in":true}\n');

  // Fake executable gemini CLI
  const fakeGemini = path.join(binDir, 'gemini');
  await fs.writeFile(fakeGemini, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('0.10.0'); process.exit(0); }
if (process.env.GEMINI_API_KEY) { process.stderr.write('API key leaked!\\n'); process.exit(2); }
console.log(JSON.stringify({
  response: JSON.stringify({ type: 'message', calls: [], text: 'Gemini subscription reply', finish: 'done' }),
  stats: { input_tokens: 42, output_tokens: 12 }
}));
`, { mode: 0o755 });

  // Fake executable copilot CLI
  const fakeCopilot = path.join(binDir, 'copilot');
  await fs.writeFile(fakeCopilot, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('1.0.0'); process.exit(0); }
console.log('\`\`\`json\\n{"type":"message","calls":[],"text":"Copilot subscription reply","finish":"done"}\\n\`\`\`');
`, { mode: 0o755 });

  try {
    // Environment isolation strips API keys from subscription bridges
    const gEnv = geminiSubscriptionEnvironment({ HOME: fakeHome, PATH: process.env.PATH, GEMINI_API_KEY: 'secret', GOOGLE_API_KEY: 'secret2' });
    assert.equal(gEnv.GEMINI_API_KEY, undefined);
    assert.equal(gEnv.GOOGLE_API_KEY, undefined);
    const cEnv = copilotSubscriptionEnvironment({ HOME: fakeHome, PATH: process.env.PATH, OPENAI_API_KEY: 'secret' });
    assert.equal(cEnv.OPENAI_API_KEY, undefined);

    // Decision envelope parser handles fenced JSON & rejects malformed envelopes
    const parsed = parsePlannerDecisionEnvelope('```json\n{"type":"message","calls":[],"text":"ok","finish":"done"}\n```', []);
    assert.equal(parsed.type, 'message');
    assert.throws(() => parsePlannerDecisionEnvelope('{"type":"tool","calls":[],"text":"","finish":"continue"}', []));

    const providers = new Map();
    const connections = await createCliConnections({
      dataDir: dir,
      providers,
      home: fakeHome,
      environment: {
        HOME: fakeHome,
        PATH: process.env.PATH,
        GEMINI_API_KEY: 'must-be-stripped',
        G0D_GEMINI_BINARY: fakeGemini,
        G0D_COPILOT_BINARY: fakeCopilot,
        G0D_CLAUDE_BINARY: path.join(binDir, 'missing-claude'),
        G0D_CODEX_BINARY: path.join(binDir, 'missing-codex')
      }
    });

    const initial = await connections.status({ refresh: true });
    const byId = new Map(initial.connections.map(c => [c.id, c]));
    assert.equal(byId.get('gemini-cli')?.ready, true);
    assert.equal(byId.get('gemini-cli')?.authenticated, false);
    assert.equal(byId.get('gemini-cli')?.signInDetected, true);
    assert.equal(byId.get('copilot-cli')?.ready, true);
    assert.equal(byId.get('claude-code')?.installed, false);
    assert.equal(Array.isArray(byId.get('gemini-cli')?.suggestedModels), true);

    // Connect Gemini CLI with custom model and run a planner turn
    const gConn = await connections.connect({ id: 'gemini-cli', model: 'gemini-2.5-pro', consentVersion: 1 });
    assert.equal(gConn.providerId, 'gemini-cli');
    assert.equal(providers.get('gemini-cli') instanceof GeminiCliProvider, true);
    const gTurn = await providers.get('gemini-cli').turn({
      task: { id: 't1', title: 'Test', objective: 'Say hi', constraints: [], status: 'running', calls: 0, recoveries: 0 },
      files: [], events: [], tools: []
    });
    assert.equal(gTurn.type, 'message');
    assert.equal(gTurn.text, 'Gemini subscription reply');
    assert.equal(gTurn.evidenceKind, 'live_gemini_cli');

    // Connect Copilot CLI and run a planner turn
    await connections.connect({ id: 'copilot-cli', model: 'gpt-5', consentVersion: 1 });
    assert.equal(providers.get('copilot-cli') instanceof CopilotCliProvider, true);
    const cTurn = await providers.get('copilot-cli').turn({
      task: { id: 't1', title: 'Test', objective: 'Say hi', constraints: [], status: 'running', calls: 0, recoveries: 0 },
      files: [], events: [], tools: []
    });
    assert.equal(cTurn.type, 'message');
    assert.equal(cTurn.text, 'Copilot subscription reply');
    assert.equal(cTurn.evidenceKind, 'live_copilot_cli');

    // Disconnect removes provider cleanly and updates persisted config
    const disc = await connections.disconnect({ id: 'gemini-cli' });
    assert.equal(disc.disconnected, 'gemini-cli');
    assert.equal(providers.has('gemini-cli'), false);
    await connections.disconnect({ id: 'copilot-cli' });
    assert.equal(providers.has('copilot-cli'), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
