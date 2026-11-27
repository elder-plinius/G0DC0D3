#!/usr/bin/env node
/**
 * G0DC0D3 Automated End-to-End Smoke Suite
 * Exercises tools, prompts, tier escalation/de-escalation, Plan->Build->Git->Undo->Compact,
 * HTTP server + session auth + SSE + static assets, and CLI commands.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';
import { Broker, sha256 } from '../src/broker.mjs';
import { Runtime, normalizePolicy, buildContext } from '../src/runtime.mjs';
import { compileInstructions } from '../src/prompts.mjs';
import { gitInit, gitCommit, gitLog } from '../src/git.mjs';
import { detectProjectChecks } from '../src/workspaces.mjs';
import { createApp } from '../src/server.mjs';
import { createScriptedProviders } from './scripted.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const cliPath = path.join(projectRoot, 'src', 'cli.mjs');

function parseArgs(argv) {
  const keep = argv.includes('--keep');
  const json = argv.includes('--json');
  const dirIdx = argv.indexOf('--dir');
  const customDir = dirIdx >= 0 ? argv[dirIdx + 1] : null;
  if (dirIdx >= 0 && !customDir) throw new Error('--dir requires a path');
  const rootDir = customDir ? path.resolve(customDir) : path.join('/tmp', `g0dc0d3-smoke-${Date.now()}`);
  return { keep, json, rootDir };
}

function runCli(args, { stdin, timeout = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [cliPath, ...args], { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
    if (stdin !== undefined) child.stdin.end(stdin);
  });
}

function createInProcessDispatcher(app) {
  const address = app.server.address() || { address: '127.0.0.1', port: 4317 };
  if (!app.server.address()) app.server.address = () => address;
  const host = `127.0.0.1:${address.port}`;

  function request({ method = 'GET', url = '/', headers = {}, body } = {}) {
    const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = Readable.from(payload ? [payload] : []);
    req.method = method;
    req.url = url;
    req.headers = { host, ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) };
    req.setTimeout = () => {};
    return new Promise((resolve, reject) => {
      const resHeaders = new Map();
      const chunks = [];
      const res = {
        statusCode: 200, headersSent: false, setTimeout() {},
        setHeader(name, value) { resHeaders.set(name.toLowerCase(), value); },
        getHeader(name) { return resHeaders.get(name.toLowerCase()); },
        writeHead(status, hdrs = {}) {
          this.statusCode = status; this.headersSent = true;
          for (const [k, v] of Object.entries(hdrs)) resHeaders.set(k.toLowerCase(), v);
        },
        write(chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); },
        end(chunk) {
          if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
          const text = Buffer.concat(chunks).toString('utf8');
          let json; try { json = JSON.parse(text); } catch {}
          resolve({ status: this.statusCode, headers: resHeaders, text, json });
        }
      };
      try { app.server.emit('request', req, res); } catch (err) { reject(err); }
    });
  }

  function openStream({ url, headers = {} }) {
    const req = new EventEmitter();
    req.method = 'GET';
    req.url = url;
    req.headers = { host, ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) };
    req.setTimeout = () => {};
    const chunks = [];
    const resHeaders = new Map();
    const res = {
      statusCode: 200, headersSent: false, setTimeout() {},
      setHeader(name, value) { resHeaders.set(name.toLowerCase(), value); },
      getHeader(name) { return resHeaders.get(name.toLowerCase()); },
      writeHead(status, hdrs = {}) {
        this.statusCode = status; this.headersSent = true;
        for (const [k, v] of Object.entries(hdrs)) resHeaders.set(k.toLowerCase(), v);
      },
      write(chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)); },
      end() {}
    };
    app.server.emit('request', req, res);
    return {
      res,
      resHeaders,
      chunks,
      close() { req.emit('close'); }
    };
  }

  return { request, openStream };
}

/* ── Stage 1: Core Tool Suite + Parallel Read Batching ─────── */
async function stageCoreTools(rootDir) {
  const dir = path.join(rootDir, 'stage-1-tools');
  const ws = path.join(dir, 'ws');
  await fs.mkdir(path.join(ws, 'src', 'nested'), { recursive: true });
  await fs.mkdir(path.join(ws, 'node_modules', 'dep'), { recursive: true });
  await fs.writeFile(path.join(ws, 'src', 'lines.mjs'), Array.from({ length: 15 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join('\n') + '\n');
  await fs.writeFile(path.join(ws, 'src', 'nested', 'target.js'), 'export const alpha = 1;\nexport const beta = 2;\n');
  await fs.writeFile(path.join(ws, 'node_modules', 'dep', 'skip.js'), 'export const skip = true;\n');
  await fs.writeFile(path.join(ws, 'meta.json'), '{"ok":true}\n');
  await fs.symlink(path.join(ws, 'meta.json'), path.join(ws, 'meta-link.json'));

  const store = new Store(path.join(dir, 'state'));
  try {
    const task = store.createTask({
      id: 'smoke-tools', title: 'Smoke tools', objective: 'Exercise broker tools', constraints: [],
      workspace: await fs.realpath(ws), status: 'running', providers: ['p'], providerId: 'p', providerIndex: 0,
      epoch: 1, step: 0, calls: 0, recoveries: 0, policy: normalizePolicy({}), strategy: 'continue',
      version: 1, eventSeq: 0, execution: { enabled: false, network: false, timeoutMs: 30000 }, checks: [],
      verification: { status: 'pass', snapshotHash: '0'.repeat(64), checks: [{ name: 'ok', status: 'pass' }] }
    });
    const broker = new Broker({ store });

    // repo.glob
    const gl = await broker.execute(task.id, { id: 'g1', name: 'repo.glob', args: { pattern: 'src/**/*.{mjs,js}' } }, { epoch: 1 });
    assert.equal(gl.ok, true);
    assert.deepEqual(gl.files.map(f => f.path), ['src/lines.mjs', 'src/nested/target.js']);

    // repo.read line range
    const rd = await broker.execute(task.id, { id: 'r1', name: 'repo.read', args: { path: 'src/lines.mjs', startLine: 4, endLine: 6 } }, { epoch: 1 });
    assert.equal(rd.ok, true);
    assert.equal(rd.startLine, 4);
    assert.equal(rd.endLine, 6);
    assert.equal(rd.totalLines, 15);
    assert.equal(rd.truncated, true);
    assert.ok(rd.content.includes('line4') && rd.content.includes('line6'));

    await fs.unlink(path.join(ws, 'meta-link.json'));

    // repo.search regex + glob
    const sr = await broker.execute(task.id, { id: 's1', name: 'repo.search', args: { query: 'beta\\s*=\\s*\\d+', regex: true, glob: 'src/**/*.js' } }, { epoch: 1 });
    assert.equal(sr.ok, true);
    assert.equal(sr.matches.length, 1);
    assert.equal(sr.matches[0].path, 'src/nested/target.js');

    // repo.patch multi-hunk atomic
    const targetHash = sha256(await fs.readFile(path.join(ws, 'src', 'nested', 'target.js')));
    const mp = await broker.execute(task.id, {
      id: 'p1', name: 'repo.patch',
      args: { path: 'src/nested/target.js', expectedHash: targetHash, edits: [{ oldText: 'alpha = 1', newText: 'alpha = 11' }, { oldText: 'beta = 2', newText: 'beta = 22' }] }
    }, { epoch: 1 });
    assert.equal(mp.ok, true);
    assert.equal(mp.diagnostics, undefined);
    assert.equal(await fs.readFile(path.join(ws, 'src', 'nested', 'target.js'), 'utf8'), 'export const alpha = 11;\nexport const beta = 22;\n');

    // Post-edit syntax diagnostics on broken JS & JSON
    const badJs = await broker.execute(task.id, { id: 'bj1', name: 'repo.write', args: { path: 'broken.mjs', content: 'export const x = (;\n', expectedHash: null } }, { epoch: 1 });
    assert.equal(badJs.ok, true);
    assert.ok(Array.isArray(badJs.diagnostics) && badJs.diagnostics.length === 1);

    const badJson = await broker.execute(task.id, { id: 'bjson1', name: 'repo.write', args: { path: 'broken.json', content: '{"a": 1,}', expectedHash: null } }, { epoch: 1 });
    assert.equal(badJson.ok, true);
    assert.ok(Array.isArray(badJson.diagnostics) && badJson.diagnostics.length === 1);

    // repo.move & repo.delete
    const mv = await broker.execute(task.id, { id: 'mv1', name: 'repo.move', args: { from: 'src/nested/target.js', to: 'src/nested/moved.js', expectedHash: mp.sha256 } }, { epoch: 1 });
    assert.equal(mv.ok, true);
    const del = await broker.execute(task.id, { id: 'del1', name: 'repo.delete', args: { path: 'src/nested/moved.js', expectedHash: mv.sha256 } }, { epoch: 1 });
    assert.equal(del.ok, true);
    assert.equal(del.deleted, true);
  } finally {
    store.close();
  }

  // Parallel read batching
  const batchWs = path.join(dir, 'batch-ws');
  await fs.mkdir(batchWs, { recursive: true });
  await fs.writeFile(path.join(batchWs, 'one.txt'), 'first\n');
  await fs.writeFile(path.join(batchWs, 'two.txt'), 'second\n');
  let turn = 0;
  const batchProvider = {
    id: 'batch-p', label: 'Batcher', kind: 'http', tier: 'standard',
    async turn() {
      turn++;
      if (turn === 1) {
        return {
          type: 'tool',
          calls: [
            { id: 'b-r1', name: 'repo.read', args: { path: 'one.txt' } },
            { id: 'b-r2', name: 'repo.read', args: { path: 'two.txt' } },
            { id: 'b-g1', name: 'repo.glob', args: { pattern: '*.txt' } }
          ]
        };
      }
      return { type: 'message', finish: 'done', text: 'Parallel read batch complete.' };
    }
  };
  const runtime = new Runtime({ dataDir: path.join(dir, 'batch-state'), providers: new Map([['batch-p', batchProvider]]) });
  try {
    const t = await runtime.createTask({ workspace: batchWs, objective: 'Batch read', providers: ['batch-p'], acceptance: { mode: 'owner' } });
    const done = await runtime.run(t.id);
    assert.equal(done.status, 'waiting_input');
    const ops = runtime.getOperations(t.id);
    assert.equal(ops.length, 3);
    assert.ok(ops.every(o => o.status === 'succeeded'));
  } finally {
    await runtime.close();
  }
  return 'glob, read-lines, search-regex, multi-hunk patch, diagnostics, move/delete, 3-call parallel read batch';
}

/* ── Stage 2: Dynamic Real-Repo Prompt vs Fixture Prompt ───── */
async function stagePrompts() {
  const realPrompt = compileInstructions({
    task: { workspaceKind: 'project', execution: { enabled: true, network: false, timeoutMs: 30000 }, persona: 'plinian' },
    files: [
      { path: 'package.json', content: '{"name":"smoke-app"}' },
      { path: 'tsconfig.json', content: '{"compilerOptions":{}}' },
      { path: 'AGENTS.md', content: 'Smoke rule: always preserve public exports.' }
    ],
    tools: [{ name: 'repo.read' }, { name: 'repo.patch' }, { name: 'repo.glob' }]
  });
  assert.ok(realPrompt.includes('Node.js (package.json)'), 'expected Node.js stack detection');
  assert.ok(realPrompt.includes('TypeScript (tsconfig.json)'), 'expected TypeScript stack detection');
  assert.ok(realPrompt.includes('Smoke rule: always preserve public exports.'), 'expected AGENTS.md injection');
  assert.ok(!realPrompt.includes('sealed sandbox'), 'fixture-only sealed sandbox leaked into real-repo prompt');
  assert.ok(!realPrompt.includes('write ALL files in your first response'), 'fixture-only preamble leaked into real-repo prompt');

  const fixturePrompt = compileInstructions({
    task: { fixtureId: 'task-board', persona: 'plinian' },
    files: [],
    tools: []
  });
  assert.ok(fixturePrompt.includes('SOVEREIGN CODE ENGINE'), 'expected fixture preamble to stay intact');

  // Auto-discovered project checks
  const detected = detectProjectChecks([
    { path: 'package.json', content: JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .' } }) },
    { path: 'Makefile', content: 'test:\n\tmake check\n' }
  ]);
  assert.deepEqual(detected.map(c => c.command), ['npm test', 'npm run lint', 'make test']);

  // @file priority inclusion under tight context budget
  const filler = 'x'.repeat(5000);
  const focusBody = 'export const focus = 1;\n' + '// f\n'.repeat(250);
  const ctxFiles = [
    { path: 'a-huge.js', sha256: '1'.repeat(64), bytes: filler.length, content: filler },
    { path: 'b-huge.js', sha256: '2'.repeat(64), bytes: filler.length, content: filler },
    { path: 'z-focus.js', sha256: '3'.repeat(64), bytes: focusBody.length, content: focusBody }
  ];
  const ctx = buildContext({
    task: { id: 'p-at', objective: 'Review @z-focus.js please.', constraints: [], policy: normalizePolicy({}), calls: 0, recoveries: 0, providers: ['p'], providerId: 'p', strategy: 'continue' },
    history: [], files: ctxFiles, snapshotHash: '0'.repeat(64), learning: null, byteLimit: 28000
  });
  assert.deepEqual(ctx.manifest.prioritizedFiles, ['z-focus.js']);
  assert.ok(ctx.manifest.includedFiles.includes('z-focus.js'), 'expected @file prioritized in buildContext');

  return 'real-repo stack + AGENTS.md clean, fixture preamble intact, detectProjectChecks & @file context priority';
}

/* ── Stage 3: Local Tier-0 Escalation & De-escalation ──────── */
async function stageLocalEscalation(rootDir) {
  const dir = path.join(rootDir, 'stage-3-escalation');
  const ws = path.join(dir, 'ws');
  await fs.mkdir(ws, { recursive: true });
  await fs.writeFile(path.join(ws, 'calc.mjs'), 'export const add = (a, b) => a - b;\n');

  const turns = [];
  const localModel = {
    id: 'local:small-7b', label: 'Small 7B (Local)', kind: 'http', tier: 'local',
    async turn(context) {
      turns.push('local');
      const src = context.files.find(f => f.path === 'calc.mjs')?.content || '';
      if (src.includes('a + b')) {
        return { type: 'message', finish: 'done', text: 'Verified fix on Tier-0 local model after de-escalation.' };
      }
      return { type: 'error', code: 'INVALID_TOOL', message: 'Local model struggled with tool formatting.' };
    }
  };
  const frontierModel = {
    id: 'cloud:frontier-opus', label: 'Frontier Opus', kind: 'http', tier: 'frontier',
    async turn() {
      turns.push('frontier');
      return { type: 'tool', calls: [{ id: 'f-fix', name: 'repo.write', args: { path: 'calc.mjs', content: 'export const add = (a, b) => a + b;\n' } }] };
    }
  };

  const runtime = new Runtime({
    dataDir: path.join(dir, 'state'),
    providers: new Map([['local:small-7b', localModel], ['cloud:frontier-opus', frontierModel]]),
    evaluator: async task => {
      const text = await fs.readFile(path.join(task.workspace, 'calc.mjs'), 'utf8');
      const ok = text.includes('a + b');
      return { status: ok ? 'pass' : 'fail', snapshotHash: (await runtime.snapshotTask(task.id)).snapshotHash, checks: [{ name: 'add-fix', status: ok ? 'pass' : 'fail' }] };
    }
  });
  try {
    const task = await runtime.createTask({
      workspace: ws, objective: 'Fix add()', providers: ['local:small-7b', 'cloud:frontier-opus'],
      policy: { mode: 'adaptive', maxCalls: 8, maxAttempts: 4, returnToPrimary: true, escalation: 'auto' }
    });
    const done = await runtime.run(task.id);
    assert.equal(done.status, 'completed');
    assert.deepEqual(turns, ['local', 'frontier', 'local']);
    const events = runtime.getEvents(task.id);
    assert.ok(events.some(e => e.type === 'routing.escalated' && e.data.fromTier === 'local' && e.data.toTier === 'frontier'));
    assert.ok(events.some(e => e.type === 'model.switched' && e.data.reason === 'RETURN_TO_PRIMARY' && e.data.deescalated === true));
  } finally {
    await runtime.close();
  }
  return 'local -> frontier escalation -> fix -> clean de-escalation back to local';
}

/* ── Stage 4: Plan Mode -> Build -> Git -> Undo -> Compact ─── */
async function stagePlanBuildUndoCompact(rootDir) {
  const dir = path.join(rootDir, 'stage-4-plan-build');
  const ws = path.join(dir, 'ws');
  await fs.mkdir(ws, { recursive: true });
  await fs.writeFile(path.join(ws, 'app.mjs'), 'export const version = 1;\n');
  await gitInit(ws);

  const agent = {
    id: 'plan-build-agent', label: 'Plan/Build Agent', kind: 'http', tier: 'standard',
    async turn(context) {
      if (context.task.planMode) {
        const names = context.tools.map(t => t.name);
        assert.ok(names.includes('repo.read') && !names.includes('repo.write') && !names.includes('process.run'));
        return { type: 'message', finish: 'done', text: '### Plan\n- [ ] Bump `version` from 1 to 2 in `app.mjs`\n- [ ] Verify check passes' };
      }
      const cur = context.files.find(f => f.path === 'app.mjs')?.content || '';
      if (!cur.includes('version = 2')) {
        return { type: 'tool', calls: [{ id: 'w-v2', name: 'repo.write', args: { path: 'app.mjs', content: 'export const version = 2;\n' } }] };
      }
      return { type: 'message', finish: 'done', text: 'Updated `app.mjs` to version 2.' };
    }
  };

  const runtime = new Runtime({
    dataDir: path.join(dir, 'state'),
    providers: new Map([['plan-build-agent', agent]]),
    evaluator: async task => {
      const content = await fs.readFile(path.join(task.workspace, 'app.mjs'), 'utf8');
      const ok = content.includes('version = 2');
      return { status: ok ? 'pass' : 'fail', snapshotHash: (await runtime.snapshotTask(task.id)).snapshotHash, checks: [{ name: 'version-2', status: ok ? 'pass' : 'fail' }] };
    }
  });
  try {
    const task = await runtime.createTask({
      workspace: ws, objective: 'Bump app.mjs version to 2', providers: ['plan-build-agent'], planMode: true,
      policy: { mode: 'adaptive', maxCalls: 8, maxAttempts: 2 }
    });
    // Broker read-only enforcement in Plan Mode
    runtime.store.updateTask(task.id, t => { t.status = 'running'; t.epoch = 1; return t; });
    await assert.rejects(
      () => runtime.broker.execute(task.id, { id: 'deny-w', name: 'repo.write', args: { path: 'app.mjs', content: 'nope\n' } }, { epoch: 1 }),
      err => err.code === 'PERMISSION_DENIED'
    );
    runtime.store.updateTask(task.id, t => { t.status = 'queued'; return t; });

    // 1. Run in Plan Mode -> PLAN_READY
    const planned = await runtime.run(task.id);
    assert.equal(planned.status, 'waiting_input');
    assert.equal(planned.blocker?.code, 'PLAN_READY');
    assert.equal(await fs.readFile(path.join(ws, 'app.mjs'), 'utf8'), 'export const version = 1;\n');

    // 2. Switch to Build Mode -> resume -> execute -> verify -> git auto-commit
    const switched = runtime.setPlanMode(task.id, false);
    assert.equal(switched.planMode, false);
    assert.equal(switched.blocker, null);
    runtime.resume(task.id);
    const built = await runtime.run(task.id);
    assert.equal(built.status, 'completed');
    assert.equal(await fs.readFile(path.join(ws, 'app.mjs'), 'utf8'), 'export const version = 2;\n');
    const commits = (await gitLog(ws, { limit: 10 })).trim().split('\n').filter(Boolean);
    assert.ok(commits.length >= 2, `expected git auto-commit, got log: ${commits.join('; ')}`);

    // 3. /undo git rewind
    const { rewind } = await runtime.rewindTask(task.id, 1);
    assert.equal(rewind.ok, true);
    assert.equal(await fs.readFile(path.join(ws, 'app.mjs'), 'utf8'), 'export const version = 1;\n');

    // 4. /compact workingSummary
    const compacted = await runtime.compactTask(task.id);
    assert.ok(compacted.workingSummary && typeof compacted.workingSummary === 'object');
    assert.ok(runtime.getEvents(task.id).some(e => e.type === 'task.compacted'));
  } finally {
    await runtime.close();
  }
  return 'Plan read-only -> PLAN_READY -> Build -> verify -> git auto-commit -> /undo -> /compact';
}

/* ── Stage 5: HTTP Server + Auth + SSE + APIs + Static Assets ─ */
async function stageHttpServer(rootDir) {
  const dir = path.join(rootDir, 'stage-5-http');
  const app = await createApp({ dataDir: path.join(dir, 'server-state'), auth: true });
  let baseUrl = null;
  let liveSocketSkipped = false;

  try {
    try {
      baseUrl = await app.listen(0);
      const probe = await fetch(`${baseUrl}/api/health`);
      if (probe.status !== 200) throw new Error(`unexpected health status ${probe.status}`);
    } catch (err) {
      const code = err?.code || err?.cause?.code || err?.cause?.errors?.[0]?.code;
      if (['EPERM', 'EACCES'].includes(code) || (err?.message === 'fetch failed' && (!code || ['EPERM', 'EACCES', 'ECONNREFUSED'].includes(code)))) {
        liveSocketSkipped = true;
      } else {
        throw err;
      }
    }

    const staticPaths = [
      ['/', 'text/html', 'plan-ready-banner'],
      ['/app.js', 'text/javascript', 'approvePlanAndBuild'],
      ['/workspace.css', 'text/css', '.plan-ready-banner'],
      ['/message-format.js', 'text/javascript', 'md-task-item'],
      ['/styles.css', 'text/css', '--violet']
    ];

    if (!liveSocketSkipped && baseUrl) {
      const token = new URL(app.accessUrl).hash.split('session=')[1];
      assert.ok(token, 'expected session token in accessUrl');

      // 1. Unauthenticated API call rejected with 401
      const unauth = await fetch(`${baseUrl}/api/state`);
      assert.equal(unauth.status, 401);

      // 2. Exchange session token -> receive HttpOnly cookie
      const sessRes = await fetch(`${baseUrl}/api/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
        body: JSON.stringify({ token })
      });
      assert.equal(sessRes.status, 200);
      const setCookie = sessRes.headers.get('set-cookie') || '';
      const cookie = setCookie.split(';')[0];
      assert.ok(cookie.includes('='), 'expected session cookie');
      const authHeaders = { cookie };
      const mutHeaders = { cookie, 'content-type': 'application/json', 'x-g0d-request': '1' };

      // 3. GET /api/state
      const st = await (await fetch(`${baseUrl}/api/state`, { headers: authHeaders })).json();
      assert.ok(Array.isArray(st.providers) && st.providers.every(p => ['local', 'standard', 'frontier'].includes(p.tier)));

      // 4. POST /api/providers/local
      const locRes = await fetch(`${baseUrl}/api/providers/local`, {
        method: 'POST', headers: mutHeaders,
        body: JSON.stringify({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder:14b', label: 'Qwen Local Smoke' })
      });
      assert.equal(locRes.status, 200);
      const locJson = await locRes.json();
      assert.equal(locJson.id, 'local:qwen2.5-coder-14b');
      assert.equal(locJson.provider.tier, 'local');
      assert.ok(locJson.providers.some(p => p.id === 'local:qwen2.5-coder-14b'));

      // 5. Create task, toggle plan-mode, compact, commit + rewind
      const createRes = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST', headers: mutHeaders,
        body: JSON.stringify({ fixtureId: 'task-board', autoRun: false })
      });
      assert.equal(createRes.status, 201);
      const { task } = await createRes.json();

      const pmRes = await fetch(`${baseUrl}/api/tasks/${task.id}/plan-mode`, {
        method: 'POST', headers: mutHeaders, body: JSON.stringify({ enabled: true })
      });
      assert.equal(pmRes.status, 200);
      assert.equal((await pmRes.json()).task.planMode, true);

      const cmpRes = await fetch(`${baseUrl}/api/tasks/${task.id}/compact`, {
        method: 'POST', headers: mutHeaders, body: '{}'
      });
      assert.equal(cmpRes.status, 200);
      assert.ok((await cmpRes.json()).workingSummary);

      await fs.writeFile(path.join(task.workspace, 'smoke-checkpoint.txt'), 'v1\n');
      await gitCommit(task.workspace, { message: 'smoke checkpoint 1' });
      await fs.writeFile(path.join(task.workspace, 'smoke-checkpoint.txt'), 'v2\n');
      await gitCommit(task.workspace, { message: 'smoke checkpoint 2' });
      const cpRes = await fetch(`${baseUrl}/api/tasks/${task.id}/checkpoints`, { headers: authHeaders });
      assert.equal(cpRes.status, 200);
      const cpJson = await cpRes.json();
      assert.ok(Array.isArray(cpJson.checkpoints) && cpJson.checkpoints.length >= 3);
      const targetHash = cpJson.checkpoints[1].hash;
      const rwRes = await fetch(`${baseUrl}/api/tasks/${task.id}/rewind`, {
        method: 'POST', headers: mutHeaders, body: JSON.stringify({ hash: targetHash })
      });
      assert.equal(rwRes.status, 200);
      const rwJson = await rwRes.json();
      assert.equal(rwJson.rewind.hash, targetHash);
      assert.equal(await fs.readFile(path.join(task.workspace, 'smoke-checkpoint.txt'), 'utf8'), 'v1\n');

      // 6. SSE stream check
      const ac = new AbortController();
      const sseRes = await fetch(`${baseUrl}/api/tasks/${task.id}/stream`, { headers: authHeaders, signal: ac.signal });
      assert.equal(sseRes.status, 200);
      assert.ok((sseRes.headers.get('content-type') || '').includes('text/event-stream'));
      const reader = sseRes.body.getReader();
      const decoder = new TextDecoder();
      let sseBuf = '';
      const firstChunk = await reader.read();
      sseBuf += decoder.decode(firstChunk.value || new Uint8Array(), { stream: true });
      assert.ok(sseBuf.includes(':ok'), 'expected SSE :ok prologue');
      app.runtime._emitStream(task.id, { type: 'text_delta', text: 'hello-sse' });
      const secondChunk = await reader.read();
      sseBuf += decoder.decode(secondChunk.value || new Uint8Array(), { stream: true });
      assert.ok(sseBuf.includes('hello-sse'), 'expected live SSE event payload');
      ac.abort();
      try { await reader.cancel(); } catch {}

      // 7. Static asset delivery
      for (const [assetPath, mime, needle] of staticPaths) {
        const res = await fetch(`${baseUrl}${assetPath}`);
        assert.equal(res.status, 200, `asset ${assetPath} status`);
        assert.ok((res.headers.get('content-type') || '').includes(mime), `asset ${assetPath} mime`);
        const text = await res.text();
        assert.ok(text.includes(needle), `asset ${assetPath} missing ${needle}`);
      }
      return 'live loopback HTTP + session auth + SSE stream + local provider + plan/compact/rewind + 5 static assets';
    }

    // Fallback when sandbox blocks loopback bind: exercise every handler in-process via server.emit('request')
    const inproc = createInProcessDispatcher(app);
    const token = app.accessUrl.split('session=')[1];
    assert.ok(token && /^[0-9a-f]{64}$/.test(token), 'expected session token');

    const unauth = await inproc.request({ url: '/api/state' });
    assert.equal(unauth.status, 401);

    const badSess = await inproc.request({
      method: 'POST', url: '/api/session',
      headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
      body: { token: '0'.repeat(64) }
    });
    assert.equal(badSess.status, 401);

    const sess = await inproc.request({
      method: 'POST', url: '/api/session',
      headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
      body: { token }
    });
    assert.equal(sess.status, 200);
    const cookie = String(sess.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(cookie.startsWith('g0d_session='), 'expected g0d_session cookie');
    const authHeaders = { cookie };
    const mutHeaders = { cookie, 'content-type': 'application/json', 'x-g0d-request': '1' };

    const st = await inproc.request({ url: '/api/state', headers: authHeaders });
    assert.equal(st.status, 200);
    assert.ok(st.json.providers.every(p => ['local', 'standard', 'frontier'].includes(p.tier)));

    const loc = await inproc.request({
      method: 'POST', url: '/api/providers/local', headers: mutHeaders,
      body: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder:14b', label: 'Qwen Local Smoke' }
    });
    assert.equal(loc.status, 200);
    assert.equal(loc.json.id, 'local:qwen2.5-coder-14b');
    assert.equal(loc.json.provider.tier, 'local');

    const created = await inproc.request({ method: 'POST', url: '/api/tasks', headers: mutHeaders, body: { fixtureId: 'task-board', autoRun: false } });
    assert.equal(created.status, 201);
    const { task } = created.json;

    const pm = await inproc.request({ method: 'POST', url: `/api/tasks/${task.id}/plan-mode`, headers: mutHeaders, body: { enabled: true } });
    assert.equal(pm.status, 200);
    assert.equal(pm.json.task.planMode, true);

    const cmp = await inproc.request({ method: 'POST', url: `/api/tasks/${task.id}/compact`, headers: mutHeaders, body: {} });
    assert.equal(cmp.status, 200);
    assert.ok(cmp.json.workingSummary);

    await fs.writeFile(path.join(task.workspace, 'smoke-checkpoint.txt'), 'v1\n');
    await gitCommit(task.workspace, { message: 'smoke checkpoint 1' });
    await fs.writeFile(path.join(task.workspace, 'smoke-checkpoint.txt'), 'v2\n');
    await gitCommit(task.workspace, { message: 'smoke checkpoint 2' });
    const cp = await inproc.request({ url: `/api/tasks/${task.id}/checkpoints`, headers: authHeaders });
    assert.equal(cp.status, 200);
    assert.ok(Array.isArray(cp.json.checkpoints) && cp.json.checkpoints.length >= 3);
    const targetHash = cp.json.checkpoints[1].hash;
    const rw = await inproc.request({ method: 'POST', url: `/api/tasks/${task.id}/rewind`, headers: mutHeaders, body: { hash: targetHash } });
    assert.equal(rw.status, 200);
    assert.equal(rw.json.rewind.hash, targetHash);
    assert.equal(await fs.readFile(path.join(task.workspace, 'smoke-checkpoint.txt'), 'utf8'), 'v1\n');

    const stream = inproc.openStream({ url: `/api/tasks/${task.id}/stream`, headers: authHeaders });
    assert.equal(stream.res.statusCode, 200);
    app.runtime._emitStream(task.id, { type: 'text_delta', text: 'hello-sse' });
    const joined = stream.chunks.join('');
    assert.ok(joined.includes(':ok') && joined.includes('hello-sse'));
    stream.close();

    for (const [assetPath, mime, needle] of staticPaths) {
      const res = await inproc.request({ url: assetPath });
      assert.equal(res.status, 200, `asset ${assetPath} status`);
      assert.ok((res.headers.get('content-type') || '').includes(mime), `asset ${assetPath} mime`);
      assert.ok(res.text.includes(needle), `asset ${assetPath} missing ${needle}`);
    }
    return { status: 'skipped_sandbox', detail: 'loopback bind blocked (skipped_sandbox); full session auth + SSE + APIs + 5 static assets verified in-process' };
  } finally {
    await app.close();
  }
}

/* ── Stage 6: CLI Smoke ────────────────────────────────────── */
async function stageCli(rootDir) {
  const dir = path.join(rootDir, 'stage-6-cli');
  await fs.mkdir(dir, { recursive: true });

  const help = await runCli(['help']);
  assert.ok(help.stdout.includes('G0DC0D3') && help.stdout.includes('Workflows:'));

  const fix = await runCli(['fixtures']);
  const fixList = JSON.parse(fix.stdout);
  assert.ok(Array.isArray(fixList) && fixList.some(f => f.id === 'task-board'));

  const runRes = await runCli(['run', '--data', path.join(dir, 'run-data'), '--fixture', 'task-board', '--workflow', 'quick', '--plan']);
  const runTask = JSON.parse(runRes.stdout);
  assert.equal(runTask.planMode, true);
  assert.equal(runTask.status, 'waiting_input');
  assert.equal(runTask.blocker?.code, 'PLAN_READY');
  assert.equal(runTask.workflow, 'quick');

  const chat = await runCli(['chat', '--data', path.join(dir, 'chat-data'), '--workflow', 'quick'], {
    stdin: '/help\n/plan\n/build\n/status\n/quit\n'
  });
  assert.ok(chat.stdout.includes('/compact'));
  assert.ok(chat.stdout.includes('Switched to Plan Mode'));
  assert.ok(chat.stdout.includes('Switched to Build Mode'));
  assert.ok(chat.stdout.includes('No task yet · mode=build'));
  assert.ok(chat.stdout.includes('Bye.'));

  return 'help, fixtures, run --workflow quick --plan (PLAN_READY), chat REPL slash commands';
}

/* ── Stage 7: Harness Parity & Universal Subscription Hub ──── */
async function stageParityAndSubscriptions(rootDir) {
  const dir = path.join(rootDir, 'stage-7-parity');
  await fs.mkdir(dir, { recursive: true });
  const app = await createApp({ dataDir: dir, providers: createScriptedProviders(), auth: false });
  const inproc = createInProcessDispatcher(app);
  const mutHeaders = { 'content-type': 'application/json', 'x-g0d-request': '1' };
  try {
    // Subscription hub lists all 5 coding CLI subscriptions
    const conns = await inproc.request({ url: '/api/providers/connections' });
    assert.equal(conns.status, 200);
    const ids = (conns.json.connections || []).map(c => c.id);
    for (const expected of ['claude-code', 'codex-cli', 'antigravity-cli', 'gemini-cli', 'copilot-cli']) {
      assert.ok(ids.includes(expected), `missing subscription definition ${expected}`);
    }

    // Memory save -> FTS5 search -> delete
    const mem = await inproc.request({ method: 'POST', url: '/api/memory', headers: mutHeaders, body: { title: 'Smoke Memory', content: 'Always verify CSP style-src self', scope: 'global' } });
    assert.equal(mem.status, 201);
    const memSearch = await inproc.request({ url: '/api/memory?q=CSP' });
    assert.equal(memSearch.status, 200);
    assert.ok(memSearch.json.memories.some(m => m.id === mem.json.memory.id));
    await inproc.request({ method: 'DELETE', url: `/api/memory/${mem.json.memory.id}`, headers: mutHeaders });

    // Skills save -> discover -> delete
    const sk = await inproc.request({ method: 'POST', url: '/api/skills', headers: mutHeaders, body: { name: 'smoke-check', description: 'Smoke skill', body: 'Run smoke checks.' } });
    assert.equal(sk.status, 201);
    const skList = await inproc.request({ url: '/api/skills' });
    assert.ok(skList.json.skills.some(s => s.name === 'smoke-check'));
    await inproc.request({ method: 'DELETE', url: '/api/skills/smoke-check', headers: mutHeaders });

    // Permissions preset toggle
    const pSafe = await inproc.request({ method: 'PATCH', url: '/api/permissions', headers: mutHeaders, body: { preset: 'safe' } });
    assert.equal(pSafe.status, 200);
    assert.ok(pSafe.json.rules.length > 0);
    await inproc.request({ method: 'PATCH', url: '/api/permissions', headers: mutHeaders, body: { preset: 'permissive' } });

    // Task commit -> fork -> transcript export
    const created = await inproc.request({ method: 'POST', url: '/api/tasks', headers: mutHeaders, body: { fixtureId: 'task-board', autoRun: false } });
    assert.equal(created.status, 201);
    const taskId = created.json.task.id;
    const ws = app.runtime.getTask(taskId).workspace;
    await fs.writeFile(path.join(ws, 'parity.txt'), 'ok\n');
    const cmt = await inproc.request({ method: 'POST', url: `/api/tasks/${taskId}/commit`, headers: mutHeaders, body: { message: 'parity smoke commit' } });
    assert.equal(cmt.status, 200);
    assert.equal(cmt.json.committed, true);
    const fork = await inproc.request({ method: 'POST', url: `/api/tasks/${taskId}/fork`, headers: mutHeaders, body: { title: 'Smoke Fork' } });
    assert.equal(fork.status, 201);
    assert.equal(fork.json.task.parentTaskId, taskId);
    const tr = await inproc.request({ url: `/api/tasks/${taskId}/transcript?format=json` });
    assert.equal(tr.status, 200);
    assert.ok(tr.json.transcript.includes('# '));

    return '5 subscription CLIs, FTS5 memory CRUD, skills CRUD, permission presets, commit/fork/transcript';
  } finally {
    await app.close();
  }
}

async function main() {
  const { keep, json, rootDir } = parseArgs(process.argv.slice(2));
  await fs.mkdir(rootDir, { recursive: true });

  const stages = [
    { id: '1-core-tools', name: 'Core tool suite & parallel read batching', fn: () => stageCoreTools(rootDir) },
    { id: '2-prompts', name: 'Real-repo dynamic prompt vs fixture prompt', fn: () => stagePrompts() },
    { id: '3-escalation', name: 'Local Tier-0 escalation & de-escalation', fn: () => stageLocalEscalation(rootDir) },
    { id: '4-plan-build', name: 'Plan Mode -> Build -> Git -> /undo -> /compact', fn: () => stagePlanBuildUndoCompact(rootDir) },
    { id: '5-http-sse', name: 'HTTP server, auth, SSE, APIs & static assets', fn: () => stageHttpServer(rootDir) },
    { id: '6-cli', name: 'CLI help, fixtures, run --plan, and chat REPL', fn: () => stageCli(rootDir) },
    { id: '7-parity-subs', name: 'Harness parity (Memory, Skills, Permissions, Fork, Transcript) & 5 Subscription CLIs', fn: () => stageParityAndSubscriptions(rootDir) }
  ];

  const startedAt = performance.now();
  const results = [];

  try {
    for (const stage of stages) {
      const t0 = performance.now();
      try {
        const outcome = await stage.fn();
        const durationMs = Math.round(performance.now() - t0);
        if (outcome && typeof outcome === 'object' && outcome.status === 'skipped_sandbox') {
          results.push({ id: stage.id, name: stage.name, status: 'skipped_sandbox', durationMs, detail: outcome.detail });
        } else {
          results.push({ id: stage.id, name: stage.name, status: 'pass', durationMs, detail: String(outcome || 'ok') });
        }
      } catch (error) {
        const durationMs = Math.round(performance.now() - t0);
        results.push({ id: stage.id, name: stage.name, status: 'fail', durationMs, detail: error?.message || String(error), stack: error?.stack });
      }
    }
  } finally {
    if (!keep) {
      await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  const totalMs = Math.round(performance.now() - startedAt);
  const passed = results.filter(r => r.status === 'pass').length;
  const skipped = results.filter(r => r.status === 'skipped_sandbox').length;
  const failed = results.filter(r => r.status === 'fail').length;

  if (json) {
    process.stdout.write(JSON.stringify({ totalMs, passed, skipped, failed, rootDir: keep ? rootDir : null, results }, null, 2) + '\n');
  } else {
    process.stdout.write('\nG0DC0D3 E2E Smoke Scoreboard\n');
    process.stdout.write('============================================================\n');
    for (const r of results) {
      const tag = r.status === 'pass' ? 'PASS' : r.status === 'skipped_sandbox' ? 'SKIP(SANDBOX)' : 'FAIL';
      process.stdout.write(`[${tag.padEnd(13)}] ${r.name} (${r.durationMs}ms)\n`);
      process.stdout.write(`                ${r.detail}\n`);
    }
    process.stdout.write('============================================================\n');
    process.stdout.write(`Total: ${passed} passed, ${skipped} sandbox-skipped, ${failed} failed (${totalMs}ms)${keep ? ` · kept ${rootDir}` : ''}\n\n`);
  }

  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(err => {
  process.stderr.write(`Fatal smoke harness error: ${err?.stack || err}\n`);
  process.exitCode = 1;
});
