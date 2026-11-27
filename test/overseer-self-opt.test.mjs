import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { looksAmbiguousEvasion, judgeAmbiguousReply, adviseUnblock, auditCompletion, coachTrajectory, normalizeOverseerSettings } from '../src/overseer.mjs';
import { emptyLearning, applyStrategyObservation, bestStrategyForFamily, applyObservations, providerObservedStats } from '../src/learning.mjs';
import { buildModelGroups } from '../src/model-groups.mjs';
import { detectRefusal, providerIdentity } from '../src/routing.mjs';
import { runSelfOptEval } from '../bench/self-opt-eval.mjs';
import { HttpProvider } from '../src/providers.mjs';
import { Runtime } from '../src/runtime.mjs';
import { createApp } from '../src/server.mjs';

function makeStub(id, turns, { tier = 'frontier', model = id, kind = 'http', baseUrl = 'http://127.0.0.1:11434/v1' } = {}) {
  let i = 0;
  return {
    id, label: id, model, kind, tier, baseUrl, available: true, accounting: 'stub',
    capabilities: { tools: true, nativeTools: true, portableContext: true },
    async turn(ctx) {
      const fn = turns[Math.min(i++, turns.length - 1)];
      return typeof fn === 'function' ? fn(ctx, i) : fn;
    }
  };
}

function dispatch(app, { method = 'GET', url = '/', body } = {}) {
  const address = app.server.address() || { address: '127.0.0.1', port: 4317 };
  if (!app.server.address()) app.server.address = () => address;
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const req = Readable.from(payload ? [payload] : []);
  req.method = method; req.url = url;
  req.headers = {
    host: `127.0.0.1:${address.port}`,
    ...(['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) ? { origin: `http://127.0.0.1:${address.port}`, 'x-g0d-request': '1' } : {}),
    ...(payload ? { 'content-type': 'application/json' } : {})
  };
  req.setTimeout = () => {};
  return new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      statusCode: 200, headersSent: false, setTimeout() {}, setHeader() {}, getHeader() {},
      writeHead(s) { this.statusCode = s; this.headersSent = true; },
      write(c) { chunks.push(Buffer.from(c)); },
      end(c) {
        if (c !== undefined) chunks.push(Buffer.from(c));
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch {}
        resolve({ status: this.statusCode, text, json });
      }
    };
    try { app.server.emit('request', req, res); } catch (e) { reject(e); }
  });
}

test('Overseer ambiguity gate, soft-refusal judge, and privacy gate enforcement', async () => {
  // Fast heuristic gate triggers only on short evasive prose, not code or normal answers
  assert.equal(looksAmbiguousEvasion({ type: 'message', text: 'I would prefer not to go into specifics on that sensitive topic; instead, I can discuss general concepts.', finish: 'done' }), true);
  assert.equal(looksAmbiguousEvasion({ type: 'message', text: 'Here is the fix:\n```js\nexport const x = 1;\nconsole.log(x);\n```', finish: 'done' }), false);

  // Privacy gate blocks cloud Overseer under Local-Only mode BEFORE invoking provider
  let called = 0;
  const cloudOverseer = {
    id: 'openrouter:neon-4', label: 'Neon-4', kind: 'http', baseUrl: 'https://openrouter.ai/api/v1', available: true,
    async turn() { called++; return { type: 'message', text: '{"isRefusal":true}', finish: 'done' }; }
  };
  const blocked = await adviseUnblock({
    provider: cloudOverseer,
    task: { providerId: 'a', objective: 'test' },
    incident: { code: 'CONTENT_RESTRICTION', diagnosis: 'content_restriction', message: 'nope' },
    candidates: [],
    privacy: { zdrRouting: true, strictZdr: false, localOnly: true, redactOutboundSecrets: true }
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blocked, true);
  assert.equal(called, 0);

  // Allowed Overseer parses structured JSON classification cleanly
  const localOverseer = makeStub('ollama:neon-4', [
    () => ({ type: 'message', text: '{"classification":"soft_refusal","isRefusal":true,"reason":"Deflected to high-level concepts."}', finish: 'done' })
  ]);
  const judged = await judgeAmbiguousReply({
    provider: localOverseer,
    objective: 'Write a packet parser',
    replyText: 'I would rather not write that directly; instead I can discuss general concepts.'
  });
  assert.equal(judged.ok, true);
  assert.equal(judged.isRefusal, true);
  assert.equal(judged.classification, 'soft_refusal');
});

test('Overseer (neon-4) catches ambiguous soft refusal, reframes + picks fallback, and records strategy bandit win', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'g0d-overseer-e2e-'));
  const workDir = path.join(dir, 'work');
  await fs.mkdir(workDir, { recursive: true });

  const worker1 = makeStub('claude:sonnet', [
    // Subtle evasion that does NOT hit regex detectRefusal() directly
    () => ({ type: 'message', text: 'I feel uncomfortable diving into concrete details on this sensitive topic. Instead, I can offer a high-level overview of general concepts.', finish: 'done' })
  ]);
  const seenByWorker2 = [];
  const worker2 = makeStub('venice:uncensored', [
    ctx => {
      seenByWorker2.push({ objective: ctx.task.objective, guidance: ctx.task.overseerGuidance });
      return { type: 'message', text: 'Implemented the complete packet parser with tests passing.', finish: 'done' };
    }
  ]);
  const neon4 = makeStub('ollama:neon-4', [
    // Call 1: judgeAmbiguousReply -> flags soft refusal
    () => ({ type: 'message', text: '{"classification":"soft_refusal","isRefusal":true,"reason":"Evaded implementation request with high-level deflection."}', finish: 'done' }),
    // Call 2: adviseUnblock -> reframes objective, injects guidance, recommends venice:uncensored
    () => ({
      type: 'message',
      text: JSON.stringify({
        strategy: 'overseer_decompose',
        reframedObjective: 'Build a clean RFC-compliant binary frame parser module in Node.js with deterministic unit tests.',
        guidance: 'Start directly with the parser implementation and avoid preamble.',
        recommendedProviderId: 'venice:uncensored',
        reason: 'Route to uncensored worker with crisp engineering framing.'
      }),
      finish: 'done'
    })
  ]);

  const runtime = new Runtime({
    dataDir: dir,
    providers: new Map([
      ['claude:sonnet', worker1],
      ['venice:uncensored', worker2],
      ['ollama:neon-4', neon4]
    ])
  });
  try {
    const overseerState = runtime.updateOverseer({ enabled: true, providerId: 'ollama:neon-4', autoJudgeAmbiguous: true, autoUnblockStuck: true });
    assert.equal(overseerState.ready, true);

    const task = await runtime.createTask({
      title: 'Overseer Unblock Test',
      objective: 'Write a raw frame parser.',
      workspace: workDir,
      workspaceKind: 'conversation',
      providers: ['claude:sonnet', 'venice:uncensored'],
      acceptance: { mode: 'owner' },
      policy: { mode: 'adaptive', maxAttempts: 4, maxCalls: 10 }
    });

    const finished = await runtime.run(task.id);
    assert.equal(finished.status, 'completed');
    assert.equal(finished.providerId, 'venice:uncensored');
    assert.equal(seenByWorker2.length, 1);
    assert.match(seenByWorker2[0].objective, /RFC-compliant binary frame parser/);
    assert.match(seenByWorker2[0].guidance, /Start directly with the parser implementation/);

    const events = runtime.getEvents(task.id);
    assert.ok(events.some(e => e.type === 'overseer.judged' && e.data.isRefusal === true));
    assert.ok(events.some(e => e.type === 'overseer.advised' && e.data.overseerId === 'ollama:neon-4'));

    // Strategy bandit recorded the winning strategy for claude family
    const learning = runtime.getLearning();
    const best = bestStrategyForFamily(learning, 'claude');
    assert.ok(best);
    assert.equal(best.strategy, 'overseer_decompose');
    assert.equal(best.successes, 1);
  } finally {
    await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Empirical learning updates model win-rate badges and gently self-optimizes waterfall order', () => {
  const pA = new HttpProvider({ id: 'openrouter:deepseek-v3', model: 'deepseek/deepseek-chat-v3-0324', baseUrl: 'https://openrouter.ai/api/v1', credential: 'k' });
  const pB = new HttpProvider({ id: 'openrouter:kimi-k2', model: 'moonshotai/kimi-k2', baseUrl: 'https://openrouter.ai/api/v1', credential: 'k' });
  const providers = new Map([['openrouter:deepseek-v3', pA], ['openrouter:kimi-k2', pB]]);
  try {
    let learning = emptyLearning();
    const keyA = providerIdentity('openrouter:deepseek-v3', pA);
    const keyB = providerIdentity('openrouter:kimi-k2', pB);
    // DeepSeek V3 wins 6 times, Kimi K2 refuses 5 times
    for (let i = 0; i < 6; i++) {
      learning = applyObservations(learning, [{ providerId: 'openrouter:deepseek-v3', providerKey: keyA, category: 'completion', outcome: 'success', durationMs: 1200 }]);
    }
    for (let i = 0; i < 5; i++) {
      learning = applyObservations(learning, [{ providerId: 'openrouter:kimi-k2', providerKey: keyB, category: 'content_restriction', outcome: 'failure' }]);
    }
    const obsA = providerObservedStats(learning, 'openrouter:deepseek-v3', keyA);
    const obsB = providerObservedStats(learning, 'openrouter:kimi-k2', keyB);
    assert.equal(obsA.winRate, 100);
    assert.equal(obsB.winRate, 0);
    assert.equal(obsB.refusals, 5);

    // Without empirical data Kimi K2 (91) edges DeepSeek V3 (90); WITH empirical wins DeepSeek V3 rises to #1!
    const groups = buildModelGroups(providers, undefined, { learning });
    const all = groups.find(g => g.id === 'all-smartest');
    assert.equal(all.providerIds[0], 'openrouter:deepseek-v3');
    assert.equal(all.models[0].observed.winRate, 100);
    assert.ok(all.models[0].empiricalDelta > 0);
    assert.ok(all.models[1].empiricalDelta < 0);

    // Strategy bandit tracks per-family winners
    let strat = applyStrategyObservation(learning, { modelFamily: 'qwen', strategy: 'decompose', outcome: 'success' });
    strat = applyStrategyObservation(strat, { modelFamily: 'qwen', strategy: 'decompose', outcome: 'success' });
    assert.equal(bestStrategyForFamily(strat, 'qwen')?.strategy, 'decompose');
  } finally {
    pA.close();
    pB.close();
  }
});

test('HTTP API: GET/PATCH /api/overseer and POST /api/tasks/:id/report-refusal triggers switch + learns locally', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'g0d-overseer-http-'));
  const workDir = path.join(dir, 'work');
  await fs.mkdir(workDir, { recursive: true });
  const p1 = makeStub('model-primary', [
    () => ({ type: 'message', text: 'Here is a totally unrelated generic poem instead of your code.', finish: 'done' })
  ]);
  const p2 = makeStub('model-backup', [
    () => ({ type: 'message', text: 'Here is the real working solution.', finish: 'done' })
  ]);
  const app = await createApp({ dataDir: dir, providers: new Map([['model-primary', p1], ['model-backup', p2]]), auth: false });
  try {
    const ov1 = await dispatch(app, { method: 'GET', url: '/api/overseer' });
    assert.equal(ov1.status, 200);
    assert.equal(ov1.json.settings.enabled, false);

    const ov2 = await dispatch(app, { method: 'PATCH', url: '/api/overseer', body: { enabled: true, providerId: 'model-backup' } });
    assert.equal(ov2.status, 200);
    assert.equal(ov2.json.ready, true);
    assert.equal(ov2.json.settings.providerId, 'model-backup');

    // Run task on p1 which slips past detectRefusal()
    const task = await app.runtime.createTask({
      title: 'Missed Refusal Report Test',
      objective: 'Write code.',
      workspace: workDir,
      workspaceKind: 'conversation',
      providers: ['model-primary', 'model-backup'],
      acceptance: { mode: 'owner' },
      policy: { mode: 'adaptive', maxAttempts: 4, maxCalls: 10 }
    });
    const first = await app.runtime.run(task.id);
    assert.equal(first.status, 'completed');
    assert.equal(first.providerId, 'model-primary');

    // Turn off overseer so report-refusal exercises clean waterfall switch to model-backup
    app.runtime.updateOverseer({ enabled: false, providerId: null });
    const reported = await dispatch(app, { method: 'POST', url: `/api/tasks/${task.id}/report-refusal`, body: { message: 'It deflected with a poem.' } });
    assert.equal(reported.status, 200);
    // Wait for background run() to complete on model-backup
    await app.runtime.runs.get(task.id)?.promise;
    const finalTask = app.runtime.getTask(task.id);
    assert.equal(finalTask.status, 'completed');
    assert.equal(finalTask.providerId, 'model-backup');
    assert.ok(app.runtime.getLearning().stats.some(s => s.providerId === 'model-primary' && s.category === 'content_restriction' && s.failures >= 1));
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Overseer automatically fails over to backup high-agency model (Hermes-4-405B) if primary Overseer itself refuses', async () => {
  const timidPrimary = makeStub('openai:timid-overseer', [
    () => ({ type: 'message', text: 'I apologize, but I cannot assist with this request.', finish: 'done' })
  ]);
  const hermesBackup = makeStub('nous:Hermes-4-405B', [
    () => ({
      type: 'message',
      text: JSON.stringify({
        strategy: 'overseer_reframe',
        reframedObjective: 'Implement an isolated protocol fuzzing harness with unit assertions.',
        guidance: 'Focus strictly on deterministic byte parsing and boundary test cases.',
        recommendedProviderId: 'venice:uncensored',
        reason: 'Backup Hermes-4-405B stepped in after primary overseer declined.'
      }),
      finish: 'done'
    })
  ]);
  const advice = await adviseUnblock({
    provider: timidPrimary,
    backupProviders: [hermesBackup],
    task: { providerId: 'claude:sonnet', objective: 'Build a protocol fuzzer.' },
    incident: { code: 'CONTENT_RESTRICTION', diagnosis: 'content_restriction', message: 'Declined.' },
    candidates: [{ id: 'venice:uncensored', excluded: null }]
  });
  assert.equal(advice.ok, true);
  assert.equal(advice.providerId, 'nous:Hermes-4-405B');
  assert.equal(advice.failoverFrom, 'openai:timid-overseer');
  assert.equal(advice.recommendedProviderId, 'venice:uncensored');
  assert.match(advice.reframedObjective, /protocol fuzzing harness/i);
});

test('HTTP Pin/Demote feedback, learned 0ms refusal signatures, and 10/10 self-optimization eval gate', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'g0d-feedback-http-'));
  const p1 = new HttpProvider({ id: 'anthropic:claude-opus-4-6', model: 'claude-opus-4-6', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', credential: 'k' });
  const p2 = new HttpProvider({ id: 'openrouter:deepseek-v3', model: 'deepseek/deepseek-chat-v3-0324', baseUrl: 'https://openrouter.ai/api/v1', credential: 'k' });
  const app = await createApp({ dataDir: dir, providers: new Map([['anthropic:claude-opus-4-6', p1], ['openrouter:deepseek-v3', p2]]), auth: false });
  try {
    // Pin DeepSeek V3 and demote Opus -> DeepSeek moves to #1
    const pinRes = await dispatch(app, { method: 'POST', url: '/api/models/feedback', body: { providerId: 'openrouter:deepseek-v3', signal: 'pin' } });
    assert.equal(pinRes.status, 200);
    const demoteRes = await dispatch(app, { method: 'POST', url: '/api/models/feedback', body: { providerId: 'anthropic:claude-opus-4-6', signal: 'demote' } });
    assert.equal(demoteRes.status, 200);
    assert.equal(demoteRes.json.groups.find(g => g.id === 'all-smartest').providerIds[0], 'openrouter:deepseek-v3');

    // Record and delete learned refusal signature via API
    app.runtime.store.recordRefusalPattern({ signature: 'this topic falls outside my comfort zone', source: 'owner_reported', providerId: 'anthropic:claude-opus-4-6' });
    const hit = detectRefusal({ type: 'message', text: 'This topic falls outside my comfort zone right now.', finish: 'done' }, { learnedPatterns: app.runtime.getLearning().refusalPatterns });
    assert.equal(hit?.source, 'learned_pattern');
    const delRes = await dispatch(app, { method: 'DELETE', url: '/api/learning/patterns', body: { signature: 'this topic falls outside my comfort zone' } });
    assert.equal(delRes.status, 200);
    assert.equal(delRes.json.refusalPatterns.length, 0);

    // Run full 10-scenario monotonic self-optimization eval gate
    const evalReport = await runSelfOptEval();
    assert.equal(evalReport.passed, evalReport.total);
    assert.equal(evalReport.falsePositives, 0);
  } finally {
    await app.close();
    p1.close();
    p2.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Overseer 2.0: supervision postures, custom directives, pre-finish completeness audit, and on-demand /overseer-consult', async () => {
  // 1. Posture preset normalization & customInstructions sanitization
  const active = normalizeOverseerSettings({ enabled: true, providerId: 'ollama:neon-4', posture: 'active', customInstructions: 'Reject TODO stubs.\x00' });
  assert.equal(active.posture, 'active');
  assert.equal(active.autoAuditCompletion, true);
  assert.equal(active.autoCoachLongRuns, false);
  assert.equal(active.customInstructions, 'Reject TODO stubs.');

  const proactive = normalizeOverseerSettings({ posture: 'proactive' }, active);
  assert.equal(proactive.posture, 'proactive');
  assert.equal(proactive.autoAuditCompletion, true);
  assert.equal(proactive.autoCoachLongRuns, true);

  // 2. Pre-finish completeness audit catches stub output and triggers a 1-shot finishing pass
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'g0d-overseer-v2-'));
  const workDir = path.join(dir, 'work');
  await fs.mkdir(workDir, { recursive: true });

  let workerCalls = 0;
  let sawAuditGuidance = '';
  const worker = makeStub('worker:coder', [
    () => {
      workerCalls++;
      return { type: 'message', text: 'Here is a stub: // TODO: implement the rest of the parser.', finish: 'done' };
    },
    ctx => {
      workerCalls++;
      sawAuditGuidance = String(ctx.task.overseerGuidance || '');
      return { type: 'message', text: 'Implemented full parser with zero TODOs and verified edge cases.', finish: 'done' };
    }
  ]);

  let sawCustomDirective = false;
  const overseerModel = makeStub('ollama:neon-4', [
    // Call 1: pre-finish auditCompletion -> catches TODO stub!
    ctx => {
      sawCustomDirective = String(ctx.task.objective || '').includes('Reject TODO stubs');
      return {
        type: 'message',
        text: JSON.stringify({
          verdict: 'needs_work',
          completenessScore: 35,
          gaps: ['Left a // TODO placeholder instead of implementing the parser.'],
          guidance: 'Replace the TODO stub with the complete working parser before finishing.',
          reason: 'Worker stopped with a TODO placeholder.'
        }),
        finish: 'done'
      };
    },
    // Call 2: on-demand POST /api/tasks/:id/overseer-consult -> coachTrajectory
    () => ({
      type: 'message',
      text: JSON.stringify({
        status: 'on_track',
        diagnosis: 'Parser implementation is complete and verified.',
        guidance: 'Add boundary fuzz tests for empty frames if expanding scope.',
        nextActions: ['Add empty-frame test', 'Run full test suite'],
        reason: 'Clean completion with clear follow-up suggestion.'
      }),
      finish: 'done'
    })
  ]);

  const app = await createApp({
    dataDir: dir,
    providers: new Map([['worker:coder', worker], ['ollama:neon-4', overseerModel]]),
    auth: false,
    startScheduler: false
  });
  try {
    const patchRes = await dispatch(app, {
      method: 'PATCH',
      url: '/api/overseer',
      body: { enabled: true, providerId: 'ollama:neon-4', posture: 'active', customInstructions: 'Reject TODO stubs.' }
    });
    assert.equal(patchRes.status, 200);
    assert.equal(patchRes.json.settings.autoAuditCompletion, true);
    assert.ok(Array.isArray(patchRes.json.postures) && patchRes.json.postures.length === 3);

    const task = await app.runtime.createTask({
      title: 'Overseer Completeness Gate Test',
      objective: 'Implement the complete binary frame parser module with zero placeholders and full edge-case handling.',
      workspace: workDir,
      workspaceKind: 'conversation',
      providers: ['worker:coder'],
      acceptance: { mode: 'owner' },
      policy: { mode: 'adaptive', maxAttempts: 4, maxCalls: 8 }
    });
    const finished = await app.runtime.run(task.id);
    assert.equal(finished.status, 'completed');
    assert.equal(workerCalls, 2);
    assert.equal(sawCustomDirective, true);
    assert.match(sawAuditGuidance, /Replace the TODO stub/);
    const evs = app.runtime.getEvents(task.id);
    assert.ok(evs.some(e => e.type === 'overseer.audited' && e.data.verdict === 'needs_work' && e.data.completenessScore === 35));

    // 3. On-demand POST /api/tasks/:id/overseer-consult
    const consult = await dispatch(app, {
      method: 'POST',
      url: `/api/tasks/${task.id}/overseer-consult`,
      body: { question: 'What should we verify next?' }
    });
    assert.equal(consult.status, 200);
    assert.equal(consult.json.ok, true);
    assert.equal(consult.json.advice.status, 'on_track');
    assert.equal(consult.json.advice.nextActions.length, 2);
    assert.ok(app.runtime.getEvents(task.id).some(e => e.type === 'overseer.coached' && e.data.manual === true));
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
