import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runtime, buildContext, normalizePolicy } from '../src/runtime.mjs';
import { snapshotWorkspace } from '../src/broker.mjs';
import { evaluateTask } from '../src/evaluator.mjs';
import { materializeFixture, fixtureTask } from '../bench/helpers.mjs';
import { repairFiles } from '../bench/scripted.mjs';

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0dc0d3-runtime-test-'));
  try { return await fn(dir); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test('buildContext preserves chronological event order across tier-0 and tier-1 compaction', () => {
  const task = {
    id: 't1', title: 'Compaction test', objective: 'Keep history ordered', constraints: [],
    workspace: '/tmp/ws', status: 'running', providers: ['p1'], providerId: 'p1', providerIndex: 0,
    epoch: 1, step: 40, calls: 40, recoveries: 0, policy: normalizePolicy({}), strategy: 'continue',
    version: 1, eventSeq: 45, execution: { enabled: false, network: false, timeoutMs: 30000 },
    checks: [], persona: 'plinian', initialSnapshot: { snapshotHash: '0'.repeat(64) }
  };
  const history = [];
  for (let seq = 1; seq <= 45; seq++) {
    if (seq % 3 === 0) {
      history.push({ id: seq, seq, type: 'model.response', time: '2026-01-01T00:00:00Z', data: { providerId: 'p1', response: { type: 'message', finish: 'continue', text: 'x'.repeat(5000) } } });
    } else if (seq % 3 === 1) {
      history.push({ id: seq, seq, type: 'tool.completed', time: '2026-01-01T00:00:00Z', data: { name: 'repo.read', ok: true, result: 'y'.repeat(5000) } });
    } else {
      history.push({ id: seq, seq, type: 'model.request', time: '2026-01-01T00:00:00Z', data: { providerId: 'p1', call: seq, strategy: 'continue' } });
    }
  }
  const ctx = buildContext({ task, history, files: [], snapshotHash: '1'.repeat(64), learning: null, totalHistoryCount: 45 });
  assert.ok(ctx.history.length >= 30, 'Expected recent and older events included');
  for (let i = 1; i < ctx.history.length; i++) {
    assert.ok(ctx.history[i].seq > ctx.history[i - 1].seq, `Out of order at index ${i}: ${ctx.history[i - 1].seq} -> ${ctx.history[i].seq}`);
  }
  const tier1Response = ctx.history.find(e => e.type === 'model.response' && e.data._compacted === 'tier1');
  assert.ok(tier1Response, 'Expected older model.response compacted at tier1');
  assert.equal(tier1Response.data.response?.type, 'message');
  assert.equal(tier1Response.data.response?.finish, 'continue');
});

test('transient socket error retries in-place within requestTimeoutMs without burning recovery', async () => {
  await withTempDir(async dir => {
    const ws = path.join(dir, 'ws');
    await fs.mkdir(ws, { recursive: true });
    let attempts = 0;
    const provider = {
      id: 'flaky', label: 'Flaky', kind: 'http',
      async turn() {
        attempts++;
        if (attempts === 1) throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
        return { type: 'message', finish: 'done', text: 'Recovered cleanly.' };
      }
    };
    const runtime = new Runtime({ dataDir: path.join(dir, 'state'), providers: new Map([['flaky', provider]]) });
    try {
      const task = await runtime.createTask({
        workspace: ws, workspaceKind: 'conversation', objective: 'Say hello',
        providers: ['flaky'], policy: { mode: 'adaptive', maxCalls: 5, maxAttempts: 3, requestTimeoutMs: 5000 }
      });
      const done = await runtime.run(task.id);
      assert.equal(done.status, 'completed');
      assert.equal(done.completionKind, 'answered');
      assert.equal(attempts, 2);
      assert.equal(done.calls, 1);
      assert.equal(done.recoveries, 0);
      assert.ok(runtime.getEvents(task.id).some(e => e.type === 'provider.retry'));
    } finally { await runtime.close(); }
  });
});

test('PROVIDER_TIMEOUT respects requestTimeoutMs without multi-second retry backoff', async () => {
  await withTempDir(async dir => {
    const ws = path.join(dir, 'ws');
    await fs.mkdir(ws, { recursive: true });
    const hung = { id: 'hung', label: 'Hung', kind: 'http', async turn() { return new Promise(() => {}); } };
    const runtime = new Runtime({ dataDir: path.join(dir, 'state'), providers: new Map([['hung', hung]]) });
    try {
      const task = await runtime.createTask({
        workspace: ws, objective: 'Timeout check', providers: ['hung'],
        policy: { mode: 'prompt_strategies', maxCalls: 1, maxAttempts: 2, requestTimeoutMs: 30, strategies: ['continue'] }
      });
      const start = performance.now();
      const result = await runtime.run(task.id);
      const elapsed = performance.now() - start;
      assert.equal(result.status, 'paused_budget');
      assert.equal(result.recoveries, 1);
      assert.ok(elapsed < 500, `Expected < 500ms, got ${elapsed}ms`);
    } finally { await runtime.close(); }
  });
});

test('plain conversations do not convert code blocks in answers into workspace file writes', async () => {
  await withTempDir(async dir => {
    const ws = path.join(dir, 'ws');
    await fs.mkdir(ws, { recursive: true });
    const helper = {
      id: 'helper', label: 'Helper', kind: 'http',
      async turn() {
        return { type: 'message', finish: 'done', text: 'Here is `example.js`:\n```js\nconsole.log("hi");\n```' };
      }
    };
    const runtime = new Runtime({ dataDir: path.join(dir, 'state'), providers: new Map([['helper', helper]]) });
    try {
      const task = await runtime.createTask({
        workspace: ws, workspaceKind: 'conversation', objective: 'Show an example.js snippet',
        providers: ['helper'], acceptance: { mode: 'owner' }
      });
      const done = await runtime.run(task.id);
      assert.equal(done.status, 'completed');
      assert.equal(done.completionKind, 'answered');
      assert.equal((await snapshotWorkspace(ws)).files.length, 0);
    } finally { await runtime.close(); }
  });
});

test('periodic probe binds verification snapshot and cannot certify empty checks', async () => {
  await withTempDir(async dir => {
    const ws = path.join(dir, 'ws');
    const fixture = await materializeFixture('task-board', ws);
    const badEvaluator = async task => ({ status: 'pass', snapshotHash: (await snapshotWorkspace(task.workspace)).snapshotHash, checks: [] });
    const writer = {
      id: 'writer', label: 'Writer', kind: 'scripted',
      async turn(context) {
        if (context.task.calls === 1) {
          return { type: 'tool', calls: [{ id: 'w1', name: 'repo.write', args: { path: 'src/slug.mjs', content: repairFiles['task-board']['src/slug.mjs'] } }] };
        }
        return { type: 'message', finish: 'done', text: 'Done.' };
      }
    };
    const runtime = new Runtime({ dataDir: path.join(dir, 'state'), providers: new Map([['writer', writer]]), evaluator: badEvaluator });
    try {
      const task = await runtime.createTask(fixtureTask(fixture, ws, {
        providers: ['writer'], policy: { mode: 'adaptive', maxCalls: 2, maxAttempts: 0, strategies: ['continue'] }
      }));
      const result = await runtime.run(task.id);
      assert.notEqual(result.status, 'completed');
    } finally { await runtime.close(); }
  });
});

test('adaptive refusal recovery switches provider and preserves constraints without fixture cheating', async () => {
  await withTempDir(async dir => {
    const ws = path.join(dir, 'ws');
    const fixture = await materializeFixture('task-board', ws);
    const seenProviders = [];
    const primary = { id: 'p1', label: 'Primary', kind: 'http', async turn() { seenProviders.push('p1'); return { type: 'message', finish: 'refusal', text: 'I cannot help with this request.' }; } };
    const fallback = {
      id: 'p2', label: 'Fallback', kind: 'http',
      async turn(context) {
        seenProviders.push('p2');
        assert.deepEqual(context.task.constraints, fixture.constraints);
        const existing = new Map(context.files.map(f => [f.path, f.content]));
        for (const [p, c] of Object.entries(repairFiles['task-board'])) {
          if (existing.get(p) !== c) return { type: 'tool', calls: [{ id: `w-${context.task.calls}`, name: 'repo.write', args: { path: p, content: c } }] };
        }
        return { type: 'message', finish: 'done', text: 'Repaired.' };
      }
    };
    const runtime = new Runtime({ dataDir: path.join(dir, 'state'), providers: new Map([['p1', primary], ['p2', fallback]]), evaluator: evaluateTask });
    try {
      const task = await runtime.createTask(fixtureTask(fixture, ws, {
        providers: ['p1', 'p2'], policy: { mode: 'adaptive', maxCalls: 10, maxAttempts: 5, returnToPrimary: false }
      }));
      const result = await runtime.run(task.id);
      assert.equal(result.status, 'completed');
      assert.equal(result.verification.status, 'pass');
      assert.ok(seenProviders.includes('p1') && seenProviders.includes('p2'));
      assert.ok(runtime.getEvents(task.id).some(e => e.type === 'reframe.applied'));
      assert.ok(runtime.getEvents(task.id).some(e => e.type === 'model.switched'));
    } finally { await runtime.close(); }
  });
});
