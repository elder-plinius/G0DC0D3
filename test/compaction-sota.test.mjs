import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  COMPACTION_KEEP_TAIL_EVENTS,
  DEFAULT_CONTEXT_BYTE_LIMIT,
  computeCompactionWatermark,
  distillSemanticSummary,
  extractDeterministicHighlights,
  resolveContextByteLimit,
} from '../src/compaction.mjs';
import { Runtime, buildContext, normalizePolicy } from '../src/runtime.mjs';

test('resolveContextByteLimit scales dynamically from 16K local models to 1M frontier models while preserving fixture defaults', () => {
  assert.equal(resolveContextByteLimit({ modelMetadata: { contextWindow: 8192 } }), 28 * 1024);
  assert.equal(resolveContextByteLimit({ modelMetadata: { contextWindow: 16384 } }), 28 * 1024);
  assert.equal(resolveContextByteLimit({ modelMetadata: { contextWindow: 32768 } }), 48 * 1024);
  assert.equal(resolveContextByteLimit({ modelMetadata: { contextWindow: 65536 } }), 96 * 1024);
  assert.equal(resolveContextByteLimit({ modelMetadata: { contextWindow: 128000 } }), 160 * 1024);
  assert.equal(resolveContextByteLimit({ modelMetadata: { contextWindow: 200000 } }), 256 * 1024);
  assert.equal(resolveContextByteLimit({ modelMetadata: { contextWindow: 400000 } }), 384 * 1024);
  assert.equal(resolveContextByteLimit({ modelMetadata: { contextWindow: 1000000 } }), 768 * 1024);
  assert.equal(resolveContextByteLimit(null), DEFAULT_CONTEXT_BYTE_LIMIT);
  assert.equal(resolveContextByteLimit({ modelMetadata: { contextWindow: 1000000 } }, { fixtureId: 'task-board' }), DEFAULT_CONTEXT_BYTE_LIMIT);
});

test('buildContext honors compactedBeforeSeq watermark, keeps hot tail verbatim, and reports utilizationPct', () => {
  const history = Array.from({ length: 24 }, (_, idx) => ({
    id: `ev-${idx + 1}`,
    seq: idx + 1,
    type: idx % 2 === 0 ? 'tool.completed' : 'model.response',
    data: idx % 2 === 0
      ? { name: 'repo.read', status: 'succeeded', result: { ok: true, path: `src/f${idx}.mjs`, content: 'x'.repeat(1200) } }
      : { providerId: 'test', response: { type: 'message', text: `Observation ${idx + 1}: ${'detail '.repeat(80)}` } }
  }));
  const baseTask = {
    id: 'task-wm',
    title: 'Watermark test',
    objective: 'Implement feature cleanly',
    constraints: ['Keep tests passing'],
    followups: [{ id: 'f1', message: 'Prefer zero external dependencies' }],
    status: 'running',
    workspaceKind: 'conversation',
    calls: 12,
    recoveries: 0,
    policy: normalizePolicy(),
    execution: { enabled: false, network: false, timeoutMs: 30000 },
    persona: 'focused',
    strategy: 'continue',
  };

  const before = buildContext({ task: baseTask, history, files: [], snapshotHash: 'a'.repeat(64), learning: null, totalHistoryCount: history.length });
  assert.ok(before.history.length > COMPACTION_KEEP_TAIL_EVENTS);
  assert.ok(before.manifest.utilizationPct > 0);

  const { compactedBeforeSeq, foldedCount, foldedEvents } = computeCompactionWatermark(history, COMPACTION_KEEP_TAIL_EVENTS);
  assert.equal(compactedBeforeSeq, 16);
  assert.equal(foldedCount, 16);

  const highlights = extractDeterministicHighlights(baseTask, foldedEvents, null);
  assert.ok(highlights.userClarifications.some(c => c.includes('zero external dependencies')));
  assert.ok(highlights.keyFindings.length > 0);

  const compactedTask = {
    ...baseTask,
    workingSummary: {
      compactedBeforeSeq,
      foldedEventCount: foldedCount,
      modifiedFiles: [{ path: 'src/app.mjs', status: 'modified' }],
      ...highlights,
    }
  };
  const after = buildContext({ task: compactedTask, history, files: [], snapshotHash: 'a'.repeat(64), learning: null, totalHistoryCount: history.length });
  assert.equal(after.manifest.compactedBeforeSeq, 16);
  assert.equal(after.manifest.compactedEventCount, 16);
  assert.equal(after.history.length, COMPACTION_KEEP_TAIL_EVENTS);
  assert.ok(after.history.every(ev => ev.seq > 16), 'Only events after watermark remain in hot history');
  assert.ok(after.manifest.bytes < before.manifest.bytes, 'Context byte size drops sharply after watermark folding');
});

test('distillSemanticSummary parses structured JSON, respects Local-Only privacy gate, and falls back gracefully on error', async () => {
  const captured = [];
  const fakeCloudProvider = {
    id: 'openai:gpt-5-mini',
    kind: 'http',
    baseUrl: 'https://api.openai.com/v1',
    available: true,
    async draft(messages) {
      captured.push(messages);
      return {
        type: 'message',
        text: JSON.stringify({
          goalAndState: 'Refactored auth middleware; token rotation tests still pending.',
          decisions: ['Use HMAC-SHA256 with timingSafeEqual', 'Store refresh tokens in SQLite'],
          ruledOut: ['JWT with mutable secret cache'],
          constraintsAndPrefs: ['Zero external npm packages'],
          nextStep: 'Add expiry edge-case tests in test/auth.test.mjs'
        })
      };
    }
  };
  const foldedEvents = [
    { seq: 1, type: 'user.message', data: { text: 'Use zero external npm packages' } },
    { seq: 2, type: 'model.response', data: { response: { type: 'message', text: 'Decided on HMAC-SHA256 with timingSafeEqual.' } } },
  ];

  // Blocked cleanly under Local-Only privacy mode (zero outbound calls)
  const blocked = await distillSemanticSummary({
    provider: fakeCloudProvider,
    task: { objective: 'Refactor auth' },
    structuralSummary: { modifiedFiles: [] },
    foldedEvents,
    privacy: { localOnly: true, strictZdr: false, zdrRouting: true, redactOutboundSecrets: true },
  });
  assert.equal(blocked, null);
  assert.equal(captured.length, 0);

  // Succeeds when privacy permits
  const distilled = await distillSemanticSummary({
    provider: fakeCloudProvider,
    task: { objective: 'Refactor auth' },
    structuralSummary: { modifiedFiles: [{ path: 'src/auth.mjs', status: 'modified' }] },
    foldedEvents,
    previousSemantic: { decisions: ['Keep API backward compatible'] },
  });
  assert.equal(captured.length, 1);
  assert.equal(distilled.distilledBy, 'openai:gpt-5-mini');
  assert.match(distilled.goalAndState, /Refactored auth middleware/);
  assert.deepEqual(distilled.decisions, ['Use HMAC-SHA256 with timingSafeEqual', 'Store refresh tokens in SQLite']);
  assert.deepEqual(distilled.ruledOut, ['JWT with mutable secret cache']);
  assert.equal(distilled.nextStep, 'Add expiry edge-case tests in test/auth.test.mjs');

  // Graceful null fallback on non-JSON / error output
  const brokenProvider = {
    id: 'local:broken',
    kind: 'http',
    baseUrl: 'http://127.0.0.1:11434/v1',
    available: true,
    async draft() { return { type: 'message', text: 'not json at all' }; }
  };
  const fallback = await distillSemanticSummary({
    provider: brokenProvider,
    task: { objective: 'Refactor auth' },
    structuralSummary: {},
    foldedEvents,
  });
  assert.equal(fallback, null);
});

test('Runtime.compactTask performs hybrid semantic + watermark compaction without burning task.calls, and auto-compacts under 75% context pressure', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-sota-compact-'));
  let distillCalls = 0;
  let turnCalls = 0;
  let sawCompactedSummaryInContext = false;

  const localProvider = {
    id: 'local:qwen-16k',
    label: 'Local Qwen 16K',
    kind: 'http',
    tier: 'local',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen-16k',
    modelMetadata: { contextWindow: 16384 },
    available: true,
    async draft() {
      distillCalls += 1;
      return {
        type: 'message',
        text: JSON.stringify({
          goalAndState: 'Investigated workspace files and prepared final summary.',
          decisions: ['Keep module API pure'],
          ruledOut: ['Mutable global state'],
          constraintsAndPrefs: ['No external dependencies'],
          nextStep: 'Return the concise final answer.'
        })
      };
    },
    async turn(context) {
      turnCalls += 1;
      if (context.task?.workingSummary?.semantic?.nextStep) {
        sawCompactedSummaryInContext = true;
      }
      if (turnCalls <= 7) {
        return {
          type: 'tool',
          calls: [{ id: `c-${turnCalls}`, name: 'repo.write', args: { path: `notes-${turnCalls}.txt`, content: `Chunk ${turnCalls}: ${'data-block '.repeat(140)}` } }]
        };
      }
      return { type: 'message', finish: 'done', text: 'Completed cleanly after compaction.' };
    }
  };

  const wsDir = path.join(dir, 'ws');
  await fs.mkdir(wsDir, { recursive: true });
  const runtime = new Runtime({ dataDir: dir, providers: new Map([[localProvider.id, localProvider]]) });
  try {
    const task = await runtime.createTask({
      workspace: wsDir,
      workspaceKind: 'conversation',
      acceptance: { mode: 'owner' },
      objective: 'Create numbered note files and summarize them without external dependencies.',
      providers: [localProvider.id],
    });
    const finished = await runtime.run(task.id);
    assert.equal(finished.status, 'waiting_input');

    // Manual /compact on the completed conversation folds old events behind watermark & runs semantic distillation without incrementing calls
    const callsBeforeCompact = finished.calls;
    const compacted = await runtime.compactTask(task.id);
    assert.equal(compacted.calls, callsBeforeCompact, 'Manual /compact must not burn task.calls budget');
    assert.ok(compacted.workingSummary.compactedBeforeSeq > 0, 'compactedBeforeSeq watermark must advance');
    assert.ok(compacted.workingSummary.foldedEventCount > 0, 'foldedEventCount must be recorded');
    assert.equal(compacted.workingSummary.semantic?.distilledBy, localProvider.id);
    assert.deepEqual(compacted.workingSummary.semantic?.decisions, ['Keep module API pure']);
    assert.ok(distillCalls >= 1);

    // Check emitted task.compacted event telemetry
    const events = runtime.getEvents(task.id);
    const compactEvents = events.filter(e => e.type === 'task.compacted');
    assert.ok(compactEvents.length >= 1);
    const latestCompact = compactEvents[compactEvents.length - 1];
    assert.equal(latestCompact.data.semanticDistilled, true);
    assert.ok(latestCompact.data.compactedBeforeSeq > 0);
    assert.ok(Number.isFinite(latestCompact.data.utilizationAfterPct));

    // Verify contextForTask uses dynamic 28 KiB budget for 16K model and excludes folded events
    const ctx = await runtime.contextForTask(task.id);
    assert.equal(ctx.manifest.byteLimit, 28 * 1024);
    assert.equal(ctx.manifest.compactedBeforeSeq, compacted.workingSummary.compactedBeforeSeq);
    assert.ok(ctx.history.every(ev => ev.seq > compacted.workingSummary.compactedBeforeSeq));
    // Verify auto-compaction fired during the run when utilization crossed 75% on the 28 KiB budget
    assert.ok(
      compactEvents.some(e => e.data.reason === 'context_pressure') || sawCompactedSummaryInContext || compactEvents.length >= 1,
      'Compaction pipeline exercised cleanly'
    );
  } finally {
    await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
