import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';
import { Broker, sha256, taskTools } from '../src/broker.mjs';
import { Runtime, normalizePolicy, buildContext, extractFileMentions } from '../src/runtime.mjs';
import { compileInstructions, taskContextData } from '../src/prompts.mjs';
import { WORKFLOW_PRESETS } from '../src/workflows.mjs';
import { HttpProvider, environmentProviders, inferProviderTier, toolAliases } from '../src/providers.mjs';
import { rankCandidates, providerIdentity, recencyWeight } from '../src/routing.mjs';
import { applyObservations, emptyLearning } from '../src/learning.mjs';
import { gitInit, gitCommit, gitCheckpoints, gitRewind } from '../src/git.mjs';
import { detectProjectChecks, previewWorkspace } from '../src/workspaces.mjs';
import { createApp } from '../src/server.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0dc0d3-sota-test-'));
  try { return await fn(dir); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}

function makeBrokerTask(store, workspace, extra = {}) {
  return store.createTask({
    id: extra.id || 'task-1', title: 'SOTA test', objective: 'Test tools', constraints: [],
    workspace, status: 'running', providers: ['p'], providerId: 'p', providerIndex: 0,
    epoch: 1, step: 0, calls: 0, recoveries: 0, policy: normalizePolicy({}), strategy: 'continue',
    version: 1, eventSeq: 0, execution: { enabled: false, network: false, timeoutMs: 30000 }, checks: [],
    verification: { status: 'pass', snapshotHash: '0'.repeat(64), checks: [{ name: 'ok', status: 'pass' }] },
    ...extra
  });
}

test('Commit 1: repo.read line mode, repo.search regex/glob, repo.glob, multi-hunk repo.patch, repo.delete/move & diagnostics', async () => {
  await withTempDir(async dir => {
    const ws = path.join(dir, 'ws');
    await fs.mkdir(path.join(ws, 'src', 'sub'), { recursive: true });
    await fs.mkdir(path.join(ws, 'node_modules', 'pkg'), { recursive: true });
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`).join('\n') + '\n';
    await fs.writeFile(path.join(ws, 'src', 'a.mjs'), lines);
    await fs.writeFile(path.join(ws, 'src', 'sub', 'b.js'), 'export const val = 10;\nexport const other = 20;\n');
    await fs.writeFile(path.join(ws, 'config.json'), '{"ok": true}\n');
    await fs.writeFile(path.join(ws, 'node_modules', 'pkg', 'ignored.mjs'), 'export const nope = 1;\n');
    await fs.symlink(path.join(ws, 'config.json'), path.join(ws, 'link.json'));

    const store = new Store(path.join(dir, 'state'));
    try {
      const task = makeBrokerTask(store, await fs.realpath(ws));
      const broker = new Broker({ store });

      // 1. repo.read line mode + backwards compat
      const lr = await broker.execute(task.id, { id: 'lr1', name: 'repo.read', args: { path: 'src/a.mjs', startLine: 3, endLine: 5 } }, { epoch: 1 });
      assert.equal(lr.ok, true);
      assert.equal(lr.content, 'line-3\nline-4\nline-5\n');
      assert.equal(lr.startLine, 3);
      assert.equal(lr.endLine, 5);
      assert.equal(lr.totalLines, 20);
      assert.equal(lr.truncated, true);
      assert.ok(Number.isInteger(lr.nextOffset));

      const badRange = await broker.execute(task.id, { id: 'lr2', name: 'repo.read', args: { path: 'src/a.mjs', startLine: 10, endLine: 5 } }, { epoch: 1 });
      assert.equal(badRange.ok, false);
      assert.equal(badRange.error.code, 'INVALID_TOOL');

      // 2. repo.glob ignores node_modules & symlinks, supports **, *, ?, {a,b}
      const gl = await broker.execute(task.id, { id: 'g1', name: 'repo.glob', args: { pattern: 'src/**/*.{mjs,js}' } }, { epoch: 1 });
      assert.equal(gl.ok, true);
      assert.deepEqual(gl.files.map(f => f.path), ['src/a.mjs', 'src/sub/b.js']);
      assert.equal(gl.truncated, false);

      // Remove symlink before snapshot-based search
      await fs.unlink(path.join(ws, 'link.json'));

      // 3. repo.search with regex + glob + clean INVALID_TOOL on bad regex
      const sr = await broker.execute(task.id, { id: 's1', name: 'repo.search', args: { query: 'val\\s*=\\s*\\d+', regex: true, glob: 'src/**/*.js' } }, { epoch: 1 });
      assert.equal(sr.ok, true);
      assert.equal(sr.matches.length, 1);
      assert.equal(sr.matches[0].path, 'src/sub/b.js');

      const badRe = await broker.execute(task.id, { id: 's2', name: 'repo.search', args: { query: '[unclosed', regex: true } }, { epoch: 1 });
      assert.equal(badRe.ok, false);
      assert.equal(badRe.error.code, 'INVALID_TOOL');

      // 4. repo.patch multi-hunk atomic edits + rollback on ambiguous hunk
      const bHash = sha256(await fs.readFile(path.join(ws, 'src', 'sub', 'b.js')));
      const badMulti = await broker.execute(task.id, {
        id: 'mp-bad', name: 'repo.patch',
        args: { path: 'src/sub/b.js', expectedHash: bHash, edits: [{ oldText: 'val = 10', newText: 'val = 99' }, { oldText: 'missing', newText: 'x' }] }
      }, { epoch: 1 });
      assert.equal(badMulti.ok, false);
      assert.equal(badMulti.error.code, 'PATCH_AMBIGUOUS');
      assert.equal(await fs.readFile(path.join(ws, 'src', 'sub', 'b.js'), 'utf8'), 'export const val = 10;\nexport const other = 20;\n');

      const goodMulti = await broker.execute(task.id, {
        id: 'mp-ok', name: 'repo.patch',
        args: { path: 'src/sub/b.js', expectedHash: bHash, edits: [{ oldText: 'val = 10', newText: 'val = 100' }, { oldText: 'other = 20', newText: 'other = 200' }] }
      }, { epoch: 1 });
      assert.equal(goodMulti.ok, true);
      assert.equal(goodMulti.diagnostics, undefined);
      assert.equal(await fs.readFile(path.join(ws, 'src', 'sub', 'b.js'), 'utf8'), 'export const val = 100;\nexport const other = 200;\n');

      // 5. Post-edit syntax diagnostics on invalid JSON & JS, absent on valid
      const badJson = await broker.execute(task.id, { id: 'w-bad-json', name: 'repo.write', args: { path: 'broken.json', content: '{"a": 1,}', expectedHash: null } }, { epoch: 1 });
      assert.equal(badJson.ok, true);
      assert.ok(Array.isArray(badJson.diagnostics) && badJson.diagnostics.length === 1);

      const badJs = await broker.execute(task.id, { id: 'w-bad-js', name: 'repo.write', args: { path: 'broken.mjs', content: 'export const x = (;\n', expectedHash: null } }, { epoch: 1 });
      assert.equal(badJs.ok, true);
      assert.ok(Array.isArray(badJs.diagnostics) && badJs.diagnostics.length === 1);
      assert.equal(badJs.diagnostics[0].line, 1);

      // 6. repo.move & repo.delete with expectedHash + verification invalidation
      store.updateTask(task.id, t => { t.verification = { status: 'pass', snapshotHash: '1'.repeat(64), checks: [{ name: 'c', status: 'pass' }] }; return t; });
      const mv = await broker.execute(task.id, { id: 'mv1', name: 'repo.move', args: { from: 'src/sub/b.js', to: 'src/sub/b-renamed.js', expectedHash: goodMulti.sha256 } }, { epoch: 1 });
      assert.equal(mv.ok, true);
      assert.equal(mv.to, 'src/sub/b-renamed.js');
      assert.equal(store.requireTask(task.id).verification, null);
      await assert.rejects(() => fs.access(path.join(ws, 'src', 'sub', 'b.js')));
      assert.ok(await fs.readFile(path.join(ws, 'src', 'sub', 'b-renamed.js'), 'utf8'));

      const del = await broker.execute(task.id, { id: 'del1', name: 'repo.delete', args: { path: 'src/sub/b-renamed.js', expectedHash: mv.sha256 } }, { epoch: 1 });
      assert.equal(del.ok, true);
      assert.equal(del.deleted, true);
      await assert.rejects(() => fs.access(path.join(ws, 'src', 'sub', 'b-renamed.js')));

      // Crash reconciliation for repo.delete and repo.move
      const fakeDel = { id: `${task.id}:crash-del`, taskId: task.id, callId: 'crash-del', name: 'repo.delete', args: { path: 'src/sub/b-renamed.js', expectedHash: mv.sha256 }, argsHash: 'a'.repeat(64), epoch: 1, status: 'dispatching', preHash: mv.sha256, postHash: null };
      store.putOperation(fakeDel);
      const recDel = await broker.reconcile(fakeDel);
      assert.equal(recDel.status, 'succeeded');
      assert.equal(recDel.result.reconciled, true);

      // Challenger tool set includes repo.glob
      assert.ok(taskTools({ crewMember: { role: 'challenger' } }).some(t => t.name === 'repo.glob'));
    } finally { store.close(); }
  });
});

test('Commit 1: parallel read-only tool batch executes concurrently and tracks observedHashes', async () => {
  await withTempDir(async dir => {
    const ws = path.join(dir, 'ws');
    await fs.mkdir(ws, { recursive: true });
    await fs.writeFile(path.join(ws, 'a.txt'), 'alpha\n');
    await fs.writeFile(path.join(ws, 'b.txt'), 'beta\n');

    let turn = 0;
    const provider = {
      id: 'batcher', label: 'Batcher', kind: 'http',
      async turn() {
        turn++;
        if (turn === 1) {
          return {
            type: 'tool',
            calls: [
              { id: 'r-a', name: 'repo.read', args: { path: 'a.txt' } },
              { id: 'r-b', name: 'repo.read', args: { path: 'b.txt' } },
              { id: 'g-all', name: 'repo.glob', args: { pattern: '*.txt' } }
            ]
          };
        }
        return { type: 'message', finish: 'done', text: 'Read all files in parallel.' };
      }
    };
    const runtime = new Runtime({ dataDir: path.join(dir, 'state'), providers: new Map([['batcher', provider]]) });
    try {
      const task = await runtime.createTask({
        workspace: ws, objective: 'Inspect files', providers: ['batcher'],
        acceptance: { mode: 'owner' }, policy: { mode: 'adaptive', maxCalls: 5, maxAttempts: 2 }
      });
      const result = await runtime.run(task.id);
      assert.equal(result.status, 'waiting_input');
      const ops = runtime.getOperations(task.id);
      assert.equal(ops.length, 3);
      assert.ok(ops.every(op => op.status === 'succeeded'));
      assert.deepEqual(ops.map(op => op.callId), ['r-a', 'r-b', 'g-all']);
    } finally { await runtime.close(); }
  });
});

test('Commit 2: dynamic real-repo prompt + AGENTS.md, fixture prompt preservation, workflows, Anthropic cache_control, and fresh-eyes compaction', async () => {
  // Real-world prompt vs fixture prompt
  const realPrompt = compileInstructions({
    task: { workspaceKind: 'project', execution: { enabled: true, network: false, timeoutMs: 30000 }, persona: 'plinian' },
    files: [
      { path: 'package.json', content: '{"name":"demo"}' },
      { path: 'tsconfig.json', content: '{}' },
      { path: 'AGENTS.md', content: 'Always run npm test before finishing.' }
    ],
    tools: [{ name: 'repo.read' }, { name: 'repo.patch' }, { name: 'repo.glob' }]
  });
  assert.ok(!realPrompt.includes('sealed sandbox'));
  assert.ok(!realPrompt.includes('write ALL files in your first response'));
  assert.ok(realPrompt.includes('Node.js (package.json)'));
  assert.ok(realPrompt.includes('TypeScript (tsconfig.json)'));
  assert.ok(realPrompt.includes('Repository guidance data'));
  assert.ok(realPrompt.includes('Always run npm test before finishing.'));

  const fixturePrompt = compileInstructions({
    task: { fixtureId: 'task-board', persona: 'plinian' },
    files: [],
    tools: []
  });
  assert.ok(fixturePrompt.includes('SOVEREIGN CODE ENGINE'));

  // Workflow preset fixes
  assert.ok(!WORKFLOW_PRESETS.ultra.description.includes('execution + network'));
  assert.equal(WORKFLOW_PRESETS.ultra.execution.network, false);
  assert.equal(WORKFLOW_PRESETS['ultra-plinian'].policy.requestTimeoutMs, 600000);
  assert.equal(WORKFLOW_PRESETS['ultra-plinian'].policy.maxNoProgressTurns, 6);

  // Anthropic prompt caching
  const originalFetch = globalThis.fetch;
  let capturedBody = null;
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'cached ok' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  };
  try {
    const provider = new HttpProvider({
      id: 'claude-test', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-20250514', credential: 'sk-ant-test-key'
    });
    assert.equal(provider.tier, 'frontier');
    await provider.turn({
      task: { objective: 'Hi', constraints: [] },
      history: [], files: [],
      tools: [{ name: 'repo.list', description: 'List', parameters: { type: 'object', properties: {} } }]
    });
    assert.ok(Array.isArray(capturedBody.system));
    assert.deepEqual(capturedBody.system[0].cache_control, { type: 'ephemeral' });
    assert.deepEqual(capturedBody.tools.at(-1).cache_control, { type: 'ephemeral' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Fresh-eyes compaction via runtime.compactTask()
  await withTempDir(async dir => {
    const ws = path.join(dir, 'ws');
    await fs.mkdir(ws, { recursive: true });
    await fs.writeFile(path.join(ws, 'app.js'), 'export const v = 1;\n');
    const p = { id: 'p1', label: 'P1', kind: 'http', async turn() { return { type: 'message', finish: 'done', text: 'ok' }; } };
    const runtime = new Runtime({ dataDir: path.join(dir, 'state'), providers: new Map([['p1', p]]) });
    try {
      const task = await runtime.createTask({ workspace: ws, objective: 'Compact test', providers: ['p1'] });
      await fs.writeFile(path.join(ws, 'app.js'), 'export const v = 2;\n');
      const compacted = await runtime.compactTask(task.id);
      assert.ok(compacted.workingSummary);
      assert.equal(compacted.workingSummary.modifiedFiles.length, 1);
      assert.equal(compacted.workingSummary.modifiedFiles[0].path, 'app.js');
      const ctx = await runtime.contextForTask(task.id);
      const projected = taskContextData(ctx);
      assert.equal(projected.workingSummary.modifiedFiles[0].path, 'app.js');
      assert.ok(runtime.getEvents(task.id).some(e => e.type === 'task.compacted'));
    } finally { await runtime.close(); }
  });
});

test('Commit 3: provider tiers, Ollama env registration, local escalation/de-escalation, and recency/latency learning', async () => {
  // Tier inference & Ollama env registration
  assert.equal(inferProviderTier({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder:14b' }), 'local');
  assert.equal(inferProviderTier({ baseUrl: 'http://localhost:8080/v1', model: 'mlx-model' }), 'local');
  assert.equal(inferProviderTier({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' }), 'standard');
  assert.equal(inferProviderTier({ baseUrl: 'https://api.anthropic.com/v1', model: 'claude-opus-4' }), 'frontier');

  const prevModels = process.env.G0D_OLLAMA_MODELS;
  const prevUrl = process.env.G0D_OLLAMA_URL;
  process.env.G0D_OLLAMA_MODELS = 'qwen2.5-coder:14b,llama3.3';
  process.env.G0D_OLLAMA_URL = 'http://127.0.0.1:11434/v1';
  try {
    const envProvs = environmentProviders();
    const qwen = envProvs.get('ollama:qwen2.5-coder-14b');
    assert.ok(qwen);
    assert.equal(qwen.tier, 'local');
    assert.equal(qwen.available, true);
    assert.equal(qwen.apiKeyEnv, undefined);
  } finally {
    if (prevModels === undefined) delete process.env.G0D_OLLAMA_MODELS; else process.env.G0D_OLLAMA_MODELS = prevModels;
    if (prevUrl === undefined) delete process.env.G0D_OLLAMA_URL; else process.env.G0D_OLLAMA_URL = prevUrl;
  }

  // Ranking escalation: local -> frontier beats another local when escalation is auto
  const local1 = { id: 'local-1', kind: 'http', tier: 'local', turn() {} };
  const local2 = { id: 'local-2', kind: 'http', tier: 'local', turn() {} };
  const frontier = { id: 'cloud-frontier', kind: 'http', tier: 'frontier', turn() {} };
  const providers = new Map([['local-1', local1], ['local-2', local2], ['cloud-frontier', frontier]]);
  const rankedAuto = rankCandidates({
    task: { providers: ['local-1', 'local-2', 'cloud-frontier'], providerId: 'local-1', calls: 3, recoveries: 1, policy: normalizePolicy({ escalation: 'auto' }), routing: {} },
    providers, learning: null, diagnosis: { category: 'stalled' }
  });
  assert.equal(rankedAuto[0].id, 'cloud-frontier');
  assert.equal(rankedAuto[0].escalated, true);

  const rankedOff = rankCandidates({
    task: { providers: ['local-1', 'local-2', 'cloud-frontier'], providerId: 'local-1', calls: 3, recoveries: 1, policy: normalizePolicy({ escalation: 'off' }), routing: {} },
    providers, learning: null, diagnosis: { category: 'stalled' }
  });
  assert.equal(rankedOff[0].id, 'local-2');
  assert.equal(rankedOff[0].escalated, false);

  // Runtime end-to-end local -> frontier escalation & de-escalation back to local primary
  await withTempDir(async dir => {
    const ws = path.join(dir, 'ws');
    await fs.mkdir(ws, { recursive: true });
    await fs.writeFile(path.join(ws, 'file.txt'), 'init\n');
    const seen = [];
    const localPrimary = {
      id: 'ollama:small', label: 'Local Small', kind: 'http', tier: 'local',
      async turn(context) {
        seen.push('local');
        if (context.files.find(f => f.path === 'file.txt')?.content === 'fixed\n') {
          return { type: 'message', finish: 'done', text: 'Verified by local after de-escalation.' };
        }
        return { type: 'error', code: 'INVALID_TOOL', message: 'Local model failed tool call.' };
      }
    };
    const cloudFrontier = {
      id: 'cloud:big', label: 'Cloud Frontier', kind: 'http', tier: 'frontier',
      async turn() {
        seen.push('frontier');
        return { type: 'tool', calls: [{ id: 'fix-1', name: 'repo.write', args: { path: 'file.txt', content: 'fixed\n' } }] };
      }
    };
    const runtime = new Runtime({
      dataDir: path.join(dir, 'state'),
      providers: new Map([['ollama:small', localPrimary], ['cloud:big', cloudFrontier]]),
      evaluator: async task => {
        const txt = await fs.readFile(path.join(task.workspace, 'file.txt'), 'utf8');
        return { status: txt === 'fixed\n' ? 'pass' : 'fail', snapshotHash: (await runtime.snapshotTask(task.id)).snapshotHash, checks: [{ name: 'fixed', status: txt === 'fixed\n' ? 'pass' : 'fail' }] };
      }
    });
    try {
      const task = await runtime.createTask({
        workspace: ws, objective: 'Fix file', providers: ['ollama:small', 'cloud:big'],
        policy: { mode: 'adaptive', maxCalls: 8, maxAttempts: 4, returnToPrimary: true, escalation: 'auto' }
      });
      const done = await runtime.run(task.id);
      assert.equal(done.status, 'completed');
      assert.deepEqual(seen, ['local', 'frontier', 'local']);
      const events = runtime.getEvents(task.id);
      assert.ok(events.some(e => e.type === 'routing.escalated' && e.data.fromTier === 'local' && e.data.toTier === 'frontier'));
      assert.ok(events.some(e => e.type === 'model.switched' && e.data.reason === 'RETURN_TO_PRIMARY' && e.data.deescalated === true));
    } finally { await runtime.close(); }
  });

  // Recency & durationMs learning stats
  const key = providerIdentity('p', local1);
  let learning = emptyLearning();
  learning = applyObservations(learning, [{ providerId: 'p', providerKey: key, category: 'completion', outcome: 'failure', durationMs: 5000 }]);
  learning = applyObservations(learning, [{ providerId: 'p', providerKey: key, category: 'completion', outcome: 'success', durationMs: 1000 }]);
  const stat = learning.stats[0];
  assert.equal(stat.lastDurationMs, 1000);
  assert.ok(stat.avgDurationMs > 1000 && stat.avgDurationMs < 5000);
  assert.ok(stat.recencyEstimate > stat.successEstimate);
  assert.ok(recencyWeight(new Date(Date.now() - 14 * 86400 * 1000).toISOString()) < 0.5);
});

test('Commit 4: Plan Mode enforcement, Git checkpoint rewind, server endpoints, and CLI chat/workflow', async () => {
  await withTempDir(async dir => {
    const ws = path.join(dir, 'ws');
    await fs.mkdir(ws, { recursive: true });
    await fs.writeFile(path.join(ws, 'index.mjs'), 'export const a = 1;\n');
    await gitInit(ws);
    await fs.writeFile(path.join(ws, 'index.mjs'), 'export const a = 2;\n');
    await gitCommit(ws, { message: 'checkpoint 2' });

    // Direct gitRewind guard against rewinding past initial commit
    await assert.rejects(() => gitRewind(ws, 2), err => err.code === 'REWIND_LIMIT');

    // Plan Mode runtime enforcement
    const planner = {
      id: 'planner', label: 'Planner', kind: 'http', tier: 'standard',
      async turn(context) {
        const toolNames = context.tools.map(t => t.name);
        assert.ok(toolNames.includes('repo.read') && toolNames.includes('repo.glob'));
        assert.ok(!toolNames.includes('repo.write') && !toolNames.includes('process.run'));
        const instr = compileInstructions(context);
        assert.ok(instr.includes('Plan Mode (read-only)'));
        return { type: 'message', finish: 'done', text: 'Plan:\n```js\n// should not auto-write\n```\n1. Edit index.mjs' };
      }
    };
    const runtime = new Runtime({ dataDir: path.join(dir, 'state'), providers: new Map([['planner', planner]]) });
    try {
      const task = await runtime.createTask({ workspace: ws, objective: 'Plan changes', providers: ['planner'], planMode: true });
      // Broker rejects mutating tool directly while in planMode
      runtime.store.updateTask(task.id, t => { t.status = 'running'; t.epoch = 1; return t; });
      await assert.rejects(
        () => runtime.broker.execute(task.id, { id: 'bad-w', name: 'repo.write', args: { path: 'x.js', content: 'hi' } }, { epoch: 1 }),
        err => err.code === 'PERMISSION_DENIED'
      );
      runtime.store.updateTask(task.id, t => { t.status = 'queued'; return t; });

      const planned = await runtime.run(task.id);
      assert.equal(planned.status, 'waiting_input');
      assert.equal(planned.blocker?.code, 'PLAN_READY');
      assert.equal(await fs.readFile(path.join(ws, 'index.mjs'), 'utf8'), 'export const a = 2;\n');

      // Rewind task checkpoint via runtime.rewindTask
      const { task: rewoundTask, rewind } = await runtime.rewindTask(task.id, 1);
      assert.equal(rewind.ok, true);
      assert.equal(rewind.steps, 1);
      assert.equal(await fs.readFile(path.join(ws, 'index.mjs'), 'utf8'), 'export const a = 1;\n');
      assert.ok(rewoundTask.epoch > planned.epoch);
      assert.ok(runtime.getEvents(task.id).some(e => e.type === 'task.rewound'));

      // Toggle out of plan mode
      const buildTask = runtime.setPlanMode(task.id, false);
      assert.equal(buildTask.planMode, false);
      assert.equal(buildTask.blocker, null);
    } finally { await runtime.close(); }
  });

  // Server endpoints: /api/state tier, /plan-mode, /compact, /rewind
  const dispatch = (app, { method = 'GET', url = '/', headers = {}, body } = {}) => {
    const address = app.server.address() || { address: '127.0.0.1', port: 4317 };
    if (!app.server.address()) app.server.address = () => address;
    const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = Readable.from(payload ? [payload] : []);
    req.method = method;
    req.url = url;
    req.headers = { host: `127.0.0.1:${address.port}`, ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) };
    req.setTimeout = () => {};
    return new Promise((resolve, reject) => {
      const resHeaders = new Map();
      const chunks = [];
      const res = {
        statusCode: 200, headersSent: false, setTimeout() {},
        setHeader(name, value) { resHeaders.set(name.toLowerCase(), value); },
        getHeader(name) { return resHeaders.get(name.toLowerCase()); },
        writeHead(status, hdrs = {}) { this.statusCode = status; this.headersSent = true; for (const [k, v] of Object.entries(hdrs)) resHeaders.set(k.toLowerCase(), v); },
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
  };
  await withTempDir(async dir => {
    const app = await createApp({ dataDir: path.join(dir, 'server-state'), auth: false });
    const headers = { 'content-type': 'application/json', 'x-g0d-request': '1' };
    try {
      const stateRes = await dispatch(app, { url: '/api/state' });
      assert.equal(stateRes.status, 200);
      assert.ok(stateRes.json.providers.every(p => ['local', 'standard', 'frontier'].includes(p.tier)));

      const createRes = await dispatch(app, {
        method: 'POST', url: '/api/tasks', headers,
        body: { fixtureId: 'task-board', autoRun: false }
      });
      const { task } = createRes.json;
      assert.equal(createRes.status, 201);

      const pmRes = await dispatch(app, {
        method: 'POST', url: `/api/tasks/${task.id}/plan-mode`, headers,
        body: { enabled: true }
      });
      assert.equal(pmRes.status, 200);
      assert.equal(pmRes.json.task.planMode, true);

      const cmpRes = await dispatch(app, {
        method: 'POST', url: `/api/tasks/${task.id}/compact`, headers,
        body: {}
      });
      assert.equal(cmpRes.status, 200);
      assert.ok(cmpRes.json.workingSummary);

      // Make a commit in workspace then rewind via HTTP
      await fs.writeFile(path.join(task.workspace, 'extra.txt'), 'v1\n');
      await gitCommit(task.workspace, { message: 'server checkpoint' });
      const rwRes = await dispatch(app, {
        method: 'POST', url: `/api/tasks/${task.id}/rewind`, headers,
        body: { steps: 1 }
      });
      assert.equal(rwRes.status, 200);
      assert.equal(rwRes.json.rewind.steps, 1);
      await assert.rejects(() => fs.access(path.join(task.workspace, 'extra.txt')));
    } finally { await app.close(); }
  });

  // CLI chat REPL and --workflow flag
  await withTempDir(async dir => {
    const cliPath = path.join(projectRoot, 'src', 'cli.mjs');
    const chatOut = await new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [cliPath, 'chat', '--data', path.join(dir, 'cli-chat'), '--plan', '--workflow', 'quick'], { timeout: 15000 }, (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stdout, stderr }));
        else resolve(stdout);
      });
      child.stdin.end('/status\n/build\n/status\n/help\n/quit\n');
    });
    assert.ok(chatOut.includes('Plan Mode'));
    assert.ok(chatOut.includes('Switched to Build Mode'));
    assert.ok(chatOut.includes('/compact'));
    assert.ok(chatOut.includes('Bye.'));

    const runOut = await new Promise((resolve, reject) => {
      execFile(process.execPath, [cliPath, 'run', '--data', path.join(dir, 'cli-run'), '--fixture', 'task-board', '--workflow', 'standard'], { timeout: 30000 }, (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stdout, stderr }));
        else resolve(stdout);
      });
    });
    const parsed = JSON.parse(runOut);
    assert.equal(parsed.status, 'completed');
    assert.equal(parsed.workflow, 'standard');
  });
});

test('UI/UX Polish: POST /api/providers/local validation & registration and message-format checklists/strikethrough/XSS', async () => {
  const dispatch = (app, { method = 'GET', url = '/', headers = {}, body } = {}) => {
    const address = app.server.address() || { address: '127.0.0.1', port: 4317 };
    if (!app.server.address()) app.server.address = () => address;
    const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = Readable.from(payload ? [payload] : []);
    req.method = method;
    req.url = url;
    req.headers = { host: `127.0.0.1:${address.port}`, ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) };
    req.setTimeout = () => {};
    return new Promise((resolve, reject) => {
      const resHeaders = new Map();
      const chunks = [];
      const res = {
        statusCode: 200, headersSent: false, setTimeout() {},
        setHeader(name, value) { resHeaders.set(name.toLowerCase(), value); },
        getHeader(name) { return resHeaders.get(name.toLowerCase()); },
        writeHead(status, hdrs = {}) { this.statusCode = status; this.headersSent = true; for (const [k, v] of Object.entries(hdrs)) resHeaders.set(k.toLowerCase(), v); },
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
  };

  await withTempDir(async dir => {
    const app = await createApp({ dataDir: path.join(dir, 'local-prov-state'), auth: false });
    const headers = { 'content-type': 'application/json', 'x-g0d-request': '1' };
    try {
      // Defaults: baseUrl -> http://127.0.0.1:11434/v1, tier -> 'local'
      const reg1 = await dispatch(app, {
        method: 'POST', url: '/api/providers/local', headers,
        body: { model: 'qwen2.5-coder:14b' }
      });
      assert.equal(reg1.status, 200);
      assert.equal(reg1.json.id, 'local:qwen2.5-coder-14b');
      assert.equal(reg1.json.provider.tier, 'local');
      assert.equal(reg1.json.provider.available, true);
      assert.ok(reg1.json.providers.some(p => p.id === 'local:qwen2.5-coder-14b' && p.tier === 'local'));

      // Custom baseUrl, label, tier
      const reg2 = await dispatch(app, {
        method: 'POST', url: '/api/providers/local', headers,
        body: { baseUrl: 'http://localhost:8080/v1', model: 'mlx/DeepSeek-R1', label: 'MLX DeepSeek', tier: 'standard' }
      });
      assert.equal(reg2.status, 200);
      assert.equal(reg2.json.id, 'local:mlx-deepseek-r1');
      assert.equal(reg2.json.provider.label, 'MLX DeepSeek');
      assert.equal(reg2.json.provider.tier, 'standard');

      // Validation rejects bad protocol, missing model, control chars, invalid tier
      for (const badBody of [
        { baseUrl: 'file:///etc/passwd', model: 'x' },
        { baseUrl: 'javascript:alert(1)', model: 'x' },
        { baseUrl: 'http://127.0.0.1:11434/v1', model: '   ' },
        { baseUrl: 'http://127.0.0.1:11434/v1', model: 'bad\nmodel' },
        { baseUrl: 'http://127.0.0.1:11434/v1', model: 'ok', label: 'bad\rlabel' },
        { baseUrl: 'http://127.0.0.1:11434/v1', model: 'ok', tier: 'godmode' }
      ]) {
        const res = await dispatch(app, { method: 'POST', url: '/api/providers/local', headers, body: badBody });
        assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(badBody)}`);
      }
    } finally {
      await app.close();
    }
  });

  // message-format.js: checklists, strikethrough, bold+code, XSS escaping
  const fmtSource = await fs.readFile(path.join(projectRoot, 'public', 'message-format.js'), 'utf8');
  const sandbox = {};
  vm.runInNewContext(fmtSource, sandbox);

  const checklistHtml = sandbox.messageMarkdown([
    '- [x] Audit `src/server.mjs`',
    '- [X] Add **bold `inline_code`** step',
    '- [ ] Remove ~~legacy `oldFn()`~~ fallback',
    '- [ ] Safe <script>alert(1)</script> & [bad](javascript:alert(1))'
  ].join('\n'));

  assert.ok(checklistHtml.includes('<ul class="md-task-list">'));
  assert.ok(checklistHtml.includes('class="md-task-item is-checked"'));
  assert.ok(checklistHtml.includes('<input class="md-checkbox is-checked" type="checkbox" disabled checked aria-label="Checked">'));
  assert.ok(checklistHtml.includes('<input class="md-checkbox" type="checkbox" disabled aria-label="Unchecked">'));
  assert.ok(checklistHtml.includes('<strong>bold <code>inline_code</code></strong>'));
  assert.ok(checklistHtml.includes('<del>legacy <code>oldFn()</code></del>'));
  assert.ok(!checklistHtml.includes('<script>'));
  assert.ok(!checklistHtml.includes('href="javascript:'));
  assert.ok(checklistHtml.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));

  const boldCodeOnly = sandbox.messageInline('**`package.json`** and ~~deprecated~~ and [docs](https://example.com)');
  assert.equal(
    boldCodeOnly,
    '<strong><code>package.json</code></strong> and <del>deprecated</del> and <a href="https://example.com" target="_blank" rel="noopener noreferrer">docs</a>'
  );
});

function sseResponse(lines, status = 200) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    }
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}

test('Pass 3 Commit 1: Anthropic, OpenAI Responses & OpenAI Chat SSE streaming + thinking deltas + JSON fallback + portable context isolation', async () => {
  const originalFetch = globalThis.fetch;
  const tools = [{ name: 'repo.read', description: 'Read file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];
  const aliasedRead = toolAliases(tools).forward.get('repo.read');
  const ctx = { task: { objective: 'Inspect app', constraints: [] }, history: [], files: [], tools };

  try {
    // 1. Anthropic SSE: thinking + text + tool_use input_json_delta + usage + stop_reason
    const anthDeltas = [];
    let anthReqBody = null;
    globalThis.fetch = async (_url, init) => {
      anthReqBody = JSON.parse(init.body);
      return sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4","usage":{"input_tokens":42}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Check file "}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"first."}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Reading "}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"app.mjs"}}\n\n',
        `event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"${aliasedRead}","input":{}}}\n\n`,
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\\"app.mjs\\"}"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":19}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      ]);
    };
    const anth = new HttpProvider({ id: 'anth-sse', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4', credential: 'sk-ant-test' });
    const anthRes = await anth.turn(ctx, { onDelta: d => anthDeltas.push(d) });
    assert.equal(anthReqBody.stream, true);
    assert.equal(anthRes.type, 'tool');
    assert.equal(anthRes.text, 'Reading app.mjs');
    assert.equal(anthRes.thinking, 'Check file first.');
    assert.deepEqual(anthRes.calls, [{ id: 'toolu_1', name: 'repo.read', args: { path: 'app.mjs' } }]);
    assert.equal(anthRes.usage.input_tokens, 42);
    assert.equal(anthRes.usage.output_tokens, 19);
    assert.deepEqual(anthDeltas, [
      { type: 'thinking', text: 'Check file ' },
      { type: 'thinking', text: 'first.' },
      { type: 'text', text: 'Reading ' },
      { type: 'text', text: 'app.mjs' }
    ]);

    // 2. Anthropic JSON fallback when server ignores stream:true
    globalThis.fetch = async () => new Response(JSON.stringify({
      model: 'claude-sonnet-4', stop_reason: 'end_turn',
      content: [{ type: 'thinking', thinking: 'Quick thought.' }, { type: 'text', text: 'Fallback ok.' }],
      usage: { input_tokens: 10, output_tokens: 4 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const anthFallback = await anth.turn(ctx, { onDelta: () => {} });
    assert.equal(anthFallback.type, 'message');
    assert.equal(anthFallback.text, 'Fallback ok.');
    assert.equal(anthFallback.thinking, 'Quick thought.');

    // 3. OpenAI Responses SSE: reasoning summary + output_text + function_call + response.completed
    const respDeltas = [];
    let respReqBody = null;
    globalThis.fetch = async (_url, init) => {
      respReqBody = JSON.parse(init.body);
      return sseResponse([
        'event: response.created\ndata: {"type":"response.created","response":{"model":"gpt-5"}}\n\n',
        'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"Step 1: "}\n\n',
        'event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","delta":"inspect."}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Opening file."}\n\n',
        `event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"id":"fc_item_1","type":"function_call","call_id":"call_42","name":"${aliasedRead}","arguments":""}}\n\n`,
        'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_item_1","output_index":1,"delta":"{\\"path\\":\\"src/"}\n\n',
        'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_item_1","output_index":1,"delta":"index.mjs\\"}"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","model":"gpt-5","usage":{"input_tokens":55,"output_tokens":21}}}\n\n'
      ]);
    };
    const oaiResp = new HttpProvider({ id: 'oai-resp-sse', protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', credential: 'sk-test' });
    const oaiRes = await oaiResp.turn(ctx, { onDelta: d => respDeltas.push(d) });
    assert.equal(respReqBody.stream, true);
    assert.equal(oaiRes.type, 'tool');
    assert.equal(oaiRes.text, 'Opening file.');
    assert.equal(oaiRes.thinking, 'Step 1: inspect.');
    assert.deepEqual(oaiRes.calls, [{ id: 'call_42', name: 'repo.read', args: { path: 'src/index.mjs' } }]);
    assert.equal(oaiRes.usage.output_tokens, 21);
    assert.deepEqual(respDeltas, [
      { type: 'thinking', text: 'Step 1: ' },
      { type: 'thinking', text: 'inspect.' },
      { type: 'text', text: 'Opening file.' }
    ]);

    // 4. OpenAI Responses JSON fallback
    globalThis.fetch = async () => new Response(JSON.stringify({
      status: 'completed', model: 'gpt-5',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'JSON fallback ok' }] }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const oaiFallback = await oaiResp.turn(ctx, { onDelta: () => {} });
    assert.equal(oaiFallback.type, 'message');
    assert.equal(oaiFallback.text, 'JSON fallback ok');

    // 5. OpenAI Chat SSE + non-streaming reasoning_content
    const chatDeltas = [];
    globalThis.fetch = async () => sseResponse([
      'data: {"model":"deepseek-r1","choices":[{"delta":{"reasoning_content":"Analyze bug..."}}]}\n\n',
      'data: {"model":"deepseek-r1","choices":[{"delta":{"content":"Fixed it."},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":8}}\n\n',
      'data: [DONE]\n\n'
    ]);
    const chat = new HttpProvider({ id: 'chat-r1', protocol: 'openai-chat', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek-r1', credential: 'sk-or-test' });
    const chatRes = await chat.turn(ctx, { onDelta: d => chatDeltas.push(d) });
    assert.equal(chatRes.type, 'message');
    assert.equal(chatRes.thinking, 'Analyze bug...');
    assert.equal(chatRes.text, 'Fixed it.');
    assert.deepEqual(chatDeltas, [
      { type: 'thinking', text: 'Analyze bug...' },
      { type: 'text', text: 'Fixed it.' }
    ]);

    globalThis.fetch = async () => new Response(JSON.stringify({
      model: 'deepseek-r1',
      choices: [{ finish_reason: 'stop', message: { content: 'Done.', reasoning_content: 'Non-stream thoughts.' } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const chatNonStream = await chat.turn(ctx);
    assert.equal(chatNonStream.thinking, 'Non-stream thoughts.');

    // 6. Verify buildContext() strips response.thinking so private reasoning never enters portable context
    const built = buildContext({
      task: { id: 't1', objective: 'Do thing', constraints: [], policy: normalizePolicy({}), calls: 1, recoveries: 0, providers: ['chat-r1'], providerId: 'chat-r1', strategy: 'continue' },
      history: [{ id: 'ev1', seq: 1, type: 'model.response', data: { providerId: 'chat-r1', response: { type: 'message', text: 'Done.', thinking: 'SECRET_PRIVATE_THOUGHT' } } }],
      files: [], snapshotHash: '0'.repeat(64), learning: null
    });
    assert.ok(!JSON.stringify(built.history).includes('SECRET_PRIVATE_THOUGHT'));
    assert.equal(built.history[0].data.response.text, 'Done.');
    assert.equal(built.history[0].data.response.thinking, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Pass 3 Commit 2: detectProjectChecks across Node/Python/Rust/Go/Makefile & @file priority in buildContext()', async () => {
  // Node.js project with scripts + placeholder test check
  const nodeChecks = detectProjectChecks([
    { path: 'package.json', content: JSON.stringify({ scripts: { test: 'node --test', typecheck: 'tsc --noEmit', lint: 'eslint .', build: 'vite build' } }) }
  ]);
  assert.deepEqual(nodeChecks.map(c => c.command), ['npm test', 'npm run typecheck', 'npm run lint', 'npm run build']);
  assert.ok(nodeChecks.every(c => c.source === 'package.json'));

  const placeholderNode = detectProjectChecks([
    { path: 'package.json', content: JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }
  ]);
  assert.deepEqual(placeholderNode, []);

  // Python, Rust, Go, Makefile
  const polyChecks = detectProjectChecks([
    { path: 'pyproject.toml', content: '[tool.pytest.ini_options]\n' },
    { path: 'Cargo.toml', content: '[package]\nname = "demo"\n' },
    { path: 'go.mod', content: 'module example.com/demo\n' },
    { path: 'Makefile', content: 'all:\n\techo hi\ntest:\n\t./run-tests.sh\n' }
  ]);
  assert.deepEqual(polyChecks.map(c => c.command), ['pytest', 'cargo test', 'go test ./...', 'make test']);

  // previewWorkspace exposes suggestedChecks even with includeContent: false
  await withTempDir(async dir => {
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node --test', lint: 'eslint .' } }));
    await fs.writeFile(path.join(dir, 'index.mjs'), 'export const ok = true;\n');
    const preview = await previewWorkspace(dir);
    assert.deepEqual(preview.suggestedChecks.map(c => c.command), ['npm test', 'npm run lint']);
  });

  // @file priority inclusion in buildContext() under tight byte limit
  const bigFiller = 'x'.repeat(4000);
  const targetBody = 'export const targetPriority = true;\n' + '// t\n'.repeat(300);
  const followupBody = 'export const followupPriority = true;\n' + '// f\n'.repeat(300);
  const files = [
    { path: 'a-big-1.js', sha256: '1'.repeat(64), bytes: bigFiller.length, content: bigFiller },
    { path: 'b-big-2.js', sha256: '2'.repeat(64), bytes: bigFiller.length, content: bigFiller },
    { path: 'c-big-3.js', sha256: '3'.repeat(64), bytes: bigFiller.length, content: bigFiller },
    { path: 'z-target.js', sha256: '4'.repeat(64), bytes: targetBody.length, content: targetBody },
    { path: 'z-followup.js', sha256: '5'.repeat(64), bytes: followupBody.length, content: followupBody }
  ];
  const extracted = extractFileMentions(['Fix bug in @z-target.js.', 'Also inspect @./z-followup.js! And ignore @nonexistent.js'], files);
  assert.deepEqual(extracted, ['z-target.js', 'z-followup.js']);

  const tightCtx = buildContext({
    task: {
      id: 'tight-1', objective: 'Update @z-target.js carefully.', constraints: [],
      followups: [{ id: 'f1', message: 'Check @z-followup.js too', contractVersion: 2 }],
      policy: normalizePolicy({}), calls: 0, recoveries: 0, providers: ['p'], providerId: 'p', strategy: 'continue'
    },
    history: [], files, snapshotHash: '0'.repeat(64), learning: null, byteLimit: 30000
  });
  assert.deepEqual(tightCtx.manifest.prioritizedFiles, ['z-target.js', 'z-followup.js']);
  assert.ok(tightCtx.manifest.includedFiles.includes('z-target.js'), 'objective @file must be included');
  assert.ok(tightCtx.manifest.includedFiles.includes('z-followup.js'), 'followup @file must be included');
  assert.ok(tightCtx.manifest.omittedFiles.some(f => f.path.startsWith('a-big-') || f.path.startsWith('b-big-') || f.path.startsWith('c-big-')), 'non-mentioned large files should yield budget');
});

test('Pass 3 Commit 3 & 4: gitCheckpoints, hash rewind, /checkpoints API, completed planMode guard & zero inline style= CSP audit', async () => {
  await withTempDir(async dir => {
    const ws = path.join(dir, 'ws');
    await fs.mkdir(ws, { recursive: true });
    await fs.writeFile(path.join(ws, 'app.mjs'), 'export const v = 0;\n');
    await gitInit(ws);
    await fs.writeFile(path.join(ws, 'app.mjs'), 'export const v = 1;\n');
    await gitCommit(ws, { message: 'turn 1 [p1]' });
    await fs.writeFile(path.join(ws, 'app.mjs'), 'export const v = 2;\n');
    await gitCommit(ws, { message: 'turn 2 [p1]' });

    const cps = await gitCheckpoints(ws, { limit: 10 });
    assert.equal(cps.length, 3);
    assert.equal(cps[0].subject, 'turn 2 [p1]');
    assert.equal(cps[1].subject, 'turn 1 [p1]');
    assert.equal(cps[2].subject, 'initial workspace');
    assert.ok(/^[0-9a-f]{40}$/.test(cps[1].hash));
    assert.ok(cps[1].shortHash.length >= 7);
    assert.ok(cps[1].date.includes('T'));

    // Reject hash outside repo history and invalid hashes
    await assert.rejects(() => gitRewind(ws, { hash: 'deadbeefdeadbeef' }), err => err.code === 'INVALID_REWIND');
    await assert.rejects(() => gitRewind(ws, { hash: 'not-a-hash!' }), err => err.code === 'INVALID_REWIND');
    await assert.rejects(() => gitRewind(ws, { hash: cps[0].hash }), err => err.code === 'INVALID_REWIND');

    // Hash-targeted rewind via Runtime
    const provider = { id: 'p1', label: 'P1', kind: 'http', async turn() { return { type: 'message', finish: 'done', text: 'done' }; } };
    const runtime = new Runtime({ dataDir: path.join(dir, 'state'), providers: new Map([['p1', provider]]) });
    try {
      const task = await runtime.createTask({ workspace: ws, objective: 'Checkpoints test', providers: ['p1'] });
      const listed = await runtime.listCheckpoints(task.id);
      assert.equal(listed.length, 3);

      const { rewind } = await runtime.rewindTask(task.id, { hash: cps[1].hash });
      assert.equal(rewind.ok, true);
      assert.equal(rewind.steps, 1);
      assert.equal(rewind.hash, cps[1].hash);
      assert.equal(await fs.readFile(path.join(ws, 'app.mjs'), 'utf8'), 'export const v = 1;\n');

      // Completed task cannot be mutated by setPlanMode (never unexpectedly flips to paused)
      runtime.store.updateTask(task.id, current => { current.status = 'completed'; current.completionKind = 'verified'; return current; });
      assert.throws(() => runtime.setPlanMode(task.id, true), err => err.code === 'TASK_TERMINAL');
      assert.throws(() => runtime.setPlanMode(task.id, false), err => err.code === 'TASK_TERMINAL');
      assert.equal(runtime.getTask(task.id).status, 'completed');
    } finally {
      await runtime.close();
    }
  });

  // HTTP GET /api/tasks/:id/checkpoints, POST /api/tasks/:id/rewind { hash }, POST /api/workspaces/preview
  const dispatch = (app, { method = 'GET', url = '/', headers = {}, body } = {}) => {
    const address = app.server.address() || { address: '127.0.0.1', port: 4317 };
    if (!app.server.address()) app.server.address = () => address;
    const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = Readable.from(payload ? [payload] : []);
    req.method = method;
    req.url = url;
    req.headers = { host: `127.0.0.1:${address.port}`, ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) };
    req.setTimeout = () => {};
    return new Promise((resolve, reject) => {
      const resHeaders = new Map();
      const chunks = [];
      const res = {
        statusCode: 200, headersSent: false, setTimeout() {},
        setHeader(name, value) { resHeaders.set(name.toLowerCase(), value); },
        getHeader(name) { return resHeaders.get(name.toLowerCase()); },
        writeHead(status, hdrs = {}) { this.statusCode = status; this.headersSent = true; for (const [k, v] of Object.entries(hdrs)) resHeaders.set(k.toLowerCase(), v); },
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
  };
  await withTempDir(async dir => {
    const sampleRepo = path.join(dir, 'sample-repo');
    await fs.mkdir(sampleRepo, { recursive: true });
    await fs.writeFile(path.join(sampleRepo, 'Cargo.toml'), '[package]\nname = "demo"\n');
    await fs.writeFile(path.join(sampleRepo, 'main.rs'), 'fn main() {}\n');

    const app = await createApp({ dataDir: path.join(dir, 'http-state'), auth: false });
    const headers = { 'content-type': 'application/json', 'x-g0d-request': '1' };
    try {
      const prevRes = await dispatch(app, { method: 'POST', url: '/api/workspaces/preview', headers, body: { sourcePath: sampleRepo } });
      assert.equal(prevRes.status, 200);
      assert.deepEqual(prevRes.json.suggestedChecks.map(c => c.command), ['cargo test']);

      const created = await dispatch(app, { method: 'POST', url: '/api/tasks', headers, body: { fixtureId: 'task-board', autoRun: false } });
      const { task } = created.json;
      await fs.writeFile(path.join(task.workspace, 'cp1.txt'), 'one\n');
      await gitCommit(task.workspace, { message: 'checkpoint one' });
      await fs.writeFile(path.join(task.workspace, 'cp2.txt'), 'two\n');
      await gitCommit(task.workspace, { message: 'checkpoint two' });

      const cpRes = await dispatch(app, { url: `/api/tasks/${task.id}/checkpoints` });
      assert.equal(cpRes.status, 200);
      assert.equal(cpRes.json.checkpoints.length, 3);
      const targetHash = cpRes.json.checkpoints[1].hash;

      const rwRes = await dispatch(app, { method: 'POST', url: `/api/tasks/${task.id}/rewind`, headers, body: { hash: targetHash } });
      assert.equal(rwRes.status, 200);
      assert.equal(rwRes.json.rewind.hash, targetHash);
      await assert.rejects(() => fs.access(path.join(task.workspace, 'cp2.txt')));
      assert.equal(await fs.readFile(path.join(task.workspace, 'cp1.txt'), 'utf8'), 'one\n');
    } finally {
      await app.close();
    }
  });

  // Strict CSP audit: zero inline style="..." attributes in public/*.js and public/*.html
  const publicDir = path.join(projectRoot, 'public');
  for (const name of ['index.html', 'app.js', 'settings.js', 'message-format.js', 'recovery.js']) {
    const src = await fs.readFile(path.join(publicDir, name), 'utf8');
    assert.ok(!/\bstyle\s*=\s*["']/.test(src), `CSP violation: inline style= attribute found in public/${name}`);
  }
});

test('unfinished emphasis renders promptly without losing nested formatting or HTML escaping', async () => {
  const context = vm.createContext({});
  vm.runInContext(await fs.readFile(path.join(projectRoot, 'public/message-format.js'), 'utf8'), context);
  for (const delimiter of ['**', '~~']) {
    context.input = delimiter + 'a'.repeat(10000);
    const rendered = vm.runInContext('messageInline(input)', context, { timeout: 500 });
    assert.equal(rendered, context.input);
  }
  assert.equal(vm.runInContext('messageInline("**bold *nested* `code`**")', context), '<strong>bold <em>nested</em> <code>code</code></strong>');
  assert.equal(vm.runInContext('messageInline("~~strike `code`~~ <script>")', context), '<del>strike <code>code</code></del> &lt;script&gt;');
});

test('repo.search times out pathological regexes without blocking the server and cancels in read batches', async () => {
  await withTempDir(async dir => {
    const ws = path.join(dir, 'ws');
    await fs.mkdir(ws);
    await fs.writeFile(path.join(ws, 'sample.txt'), 'a'.repeat(40) + '!\nmatch 1\nmatch 2\n');
    const store = new Store(path.join(dir, 'state'));
    try {
      const task = makeBrokerTask(store, await fs.realpath(ws));
      const broker = new Broker({ store });
      const search = (id, query, extras = {}) => ({ id, name: 'repo.search', args: { query, regex: true, ...extras } });
      const start = performance.now();
      let tickMs;
      const timer = setTimeout(() => { tickMs = performance.now() - start; }, 20);
      try {
        const result = await broker.execute(task.id, search('slow', '(a+)+$'), { epoch: 1 });
        assert.equal(result.ok, false);
        assert.equal(result.error.code, 'SEARCH_TIMEOUT');
        assert.ok(tickMs < 500, `Server timer was delayed: ${tickMs} ms`);
      } finally { clearTimeout(timer); }
      assert.equal(broker.locks.has(task.id), false);
      const valid = await broker.execute(task.id, search('valid', '^match \\d$', { limit: 1 }), { epoch: 1 });
      assert.equal(valid.ok, true);
      assert.deepEqual(valid.matches.map(({ path, line, text }) => ({ path, line, text })), [{ path: 'sample.txt', line: 2, text: 'match 1' }]);
      assert.equal(valid.truncated, true);
      const invalid = await broker.execute(task.id, search('invalid', '['), { epoch: 1 });
      assert.equal(invalid.error.code, 'INVALID_TOOL');

      for (const batch of [false, true]) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 100);
        try {
          const call = search(`cancel-${batch}`, '(a+)+$');
          const operation = batch
            ? broker.executeReadBatch(task.id, [call], { epoch: 1, signal: controller.signal })
            : broker.execute(task.id, call, { epoch: 1, signal: controller.signal });
          await assert.rejects(operation, { code: 'STALE_RUN' });
          assert.equal(broker.locks.has(task.id), false);
          assert.ok(store.getOperations(task.id).every(op => ['succeeded', 'failed'].includes(op.status)));
        } finally { clearTimeout(timer); }
      }
    } finally { store.close(); }
  });
});

test('rewind excludes concurrent run, resume and acceptance, releases failed rewinds, and drains on close', async () => {
  await withTempDir(async dir => {
    const ws = path.join(dir, 'ws');
    await fs.mkdir(ws);
    await fs.writeFile(path.join(ws, 'hello.txt'), 'initial');
    await gitInit(ws);
    await fs.writeFile(path.join(ws, 'hello.txt'), 'second');
    await gitCommit(ws, { message: 'second' });
    let turns = 0;
    const provider = { id: 'planner', kind: 'http', async turn() {
      turns++;
      return { type: 'message', finish: 'done', text: 'Plan ready.' };
    } };
    const runtime = new Runtime({ dataDir: path.join(dir, 'state'), providers: new Map([[provider.id, provider]]) });
    try {
      const task = await runtime.createTask({ workspace: ws, objective: 'Plan changes', providers: [provider.id], planMode: true });
      runtime.pause(task.id);
      const rewinding = runtime.rewindTask(task.id);
      assert.throws(() => runtime.resume(task.id), { code: 'RUN_DRAINING' });
      const blockedRun = assert.rejects(runtime.run(task.id), { code: 'RUN_DRAINING' });
      const blockedAcceptance = assert.rejects(runtime.accept(task.id), { code: 'TASK_ACTIVE' });
      assert.throws(() => runtime.setProviders(task.id, [provider.id]), { code: 'RUN_DRAINING' });
      assert.throws(() => runtime.setPlanMode(task.id, false), { code: 'RUN_DRAINING' });
      await Promise.all([rewinding, blockedRun, blockedAcceptance]);
      assert.equal(turns, 0);
      assert.equal(runtime.getTask(task.id).status, 'paused');
      assert.equal(await fs.readFile(path.join(ws, 'hello.txt'), 'utf8'), 'initial');
      assert.equal(runtime.broker.locks.has(task.id), false);
      await assert.rejects(runtime.rewindTask(task.id, { hash: 'f'.repeat(40) }), { code: 'INVALID_REWIND' });
      assert.equal(runtime.broker.locks.has(task.id), false);
      runtime.resume(task.id);
      assert.equal((await runtime.run(task.id)).status, 'waiting_input');
      assert.equal(turns, 1);
      assert.equal(runtime.runs.has(task.id), false);

      await fs.writeFile(path.join(ws, 'hello.txt'), 'third');
      await gitCommit(ws, { message: 'third' });
      const finalRewind = runtime.rewindTask(task.id);
      await Promise.all([finalRewind, runtime.close()]);
      assert.equal(await fs.readFile(path.join(ws, 'hello.txt'), 'utf8'), 'initial');
    } finally { await runtime.close(); }
  });
});

test('SSE requires protocol completion before returning final text or dispatchable tools', async () => {
  const originalFetch = globalThis.fetch;
  const tools = [{ name: 'repo.read', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];
  const alias = toolAliases(tools).forward.get('repo.read');
  const ctx = { task: { objective: 'Inspect', constraints: [] }, files: [], history: [], tools };
  try {
    for (const protocol of ['anthropic', 'openai-responses']) {
      const provider = new HttpProvider({ id: 'mock', protocol, baseUrl: 'https://example.test/v1', model: 'mock' });
      for (const withTool of [false, true]) {
        const events = protocol === 'anthropic' ? [
          { type: 'message_start', message: { model: 'mock', usage: { input_tokens: 7 } } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial reply' } },
          ...(withTool ? [{ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call1', name: alias, input: { path: 'a.txt' } } }] : [])
        ] : [
          { type: 'response.created', response: { model: 'mock' } },
          { type: 'response.output_text.delta', delta: 'Partial reply' },
          ...(withTool ? [{ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'item1', call_id: 'call1', name: alias, arguments: '{"path":"a.txt"}' } }] : [])
        ];
        const respond = () => sseResponse(events.map(event => `data: ${JSON.stringify(event)}\n\n`));
        globalThis.fetch = async () => respond();
        const early = await provider.turn(ctx, { onDelta() {} });
        assert.equal(early.type, 'error', `${protocol} ${withTool}`);
        assert.equal(early.code, 'provider_incomplete');
        assert.equal(early.retryable, true);
        assert.equal(early.calls, undefined);
        if (protocol === 'anthropic') {
          assert.equal(early.usage.input_tokens, 7);
          events.push({ type: 'message_delta', delta: { stop_reason: withTool ? 'tool_use' : 'end_turn' } });
          assert.equal((await provider.turn(ctx, { onDelta() {} })).code, 'provider_incomplete');
          events.push({ type: 'message_stop' });
        } else {
          // The event name itself is authoritative when status is omitted.
          events.push({ type: 'response.completed', response: { model: 'mock', usage: { input_tokens: 7 } } });
        }
        const complete = await provider.turn(ctx, { onDelta() {} });
        assert.equal(complete.type, withTool ? 'tool' : 'message');
        assert.equal(complete.text, 'Partial reply');
        assert.equal(complete.usage.input_tokens, 7);
        if (withTool) assert.deepEqual(complete.calls, [{ id: 'call1', name: 'repo.read', args: { path: 'a.txt' } }]);
        else assert.equal(complete.finish, 'done');
      }
    }
  } finally { globalThis.fetch = originalFetch; }
});
