import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectRefusal, providerIdentity } from '../src/routing.mjs';
import { adviseUnblock } from '../src/overseer.mjs';
import { emptyLearning, applyObservations, applyStrategyObservation, applyModelPreference, bestStrategyForFamily, extractDeclineSignature, applyLearnedRefusalPattern } from '../src/learning.mjs';
import { buildModelGroups } from '../src/model-groups.mjs';
import { HttpProvider } from '../src/providers.mjs';
import { Runtime } from '../src/runtime.mjs';

function makeStub(id, turns, { tier = 'frontier', model = id, baseUrl = 'http://127.0.0.1:11434/v1' } = {}) {
  let i = 0;
  return {
    id, label: id, model, kind: 'http', tier, baseUrl, available: true, accounting: 'stub',
    capabilities: { tools: true, nativeTools: true, portableContext: true },
    async turn(ctx) {
      const fn = turns[Math.min(i++, turns.length - 1)];
      return typeof fn === 'function' ? fn(ctx, i) : fn;
    }
  };
}

export async function runSelfOptEval() {
  const results = [];
  let falsePositives = 0;
  let falsePositiveChecks = 0;

  async function scenario(id, title, fn) {
    const started = performance.now();
    try {
      const detail = await fn();
      results.push({ id, title, pass: true, ms: Math.round(performance.now() - started), detail: detail || 'ok' });
    } catch (err) {
      results.push({ id, title, pass: false, ms: Math.round(performance.now() - started), detail: err?.message || String(err) });
    }
  }

  // 1. Sticky smartest-first waterfall failover
  await scenario('sticky-waterfall', 'Sticky smartest-first waterfall skips declined primary across follow-ups', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'g0d-eval-1-'));
    const work = path.join(dir, 'work');
    await fs.mkdir(work, { recursive: true });
    const calls = [];
    const p1 = makeStub('p1', [() => { calls.push('p1'); return { type: 'message', text: 'I apologize, but I cannot assist with this request.', finish: 'done' }; }]);
    const p2 = makeStub('p2', [
      () => { calls.push('p2-1'); return { type: 'message', text: 'Done cleanly on p2.', finish: 'done' }; },
      () => { calls.push('p2-2'); return { type: 'message', text: 'Follow-up done cleanly on p2.', finish: 'done' }; }
    ]);
    const rt = new Runtime({ dataDir: dir, providers: new Map([['p1', p1], ['p2', p2]]) });
    try {
      const task = await rt.createTask({ title: 'S1', objective: 'Build parser', workspace: work, workspaceKind: 'conversation', providers: ['p1', 'p2'], acceptance: { mode: 'owner' }, policy: { mode: 'adaptive', maxAttempts: 4, maxCalls: 10, stickyOnRefusal: true } });
      const r1 = await rt.run(task.id);
      await rt.addMessage(task.id, 'Add unit tests.');
      const r2 = await rt.run(task.id);
      if (r1.providerId !== 'p2' || r2.providerId !== 'p2' || calls.join(',') !== 'p1,p2-1,p2-2') throw new Error(`Unexpected call sequence: ${calls.join(',')}`);
      return 'p1 declined → p2 stuck across follow-up';
    } finally { await rt.close(); await fs.rm(dir, { recursive: true, force: true }); }
  });

  // 2. Indirect soft refusal instant detection
  await scenario('indirect-decline', 'Indirect soft refusal detected immediately without false positives', async () => {
    const hit = detectRefusal({ type: 'message', text: "That request isn’t something I can help with. I can explain the format.", finish: 'done' });
    if (!hit || hit.code !== 'CONTENT_RESTRICTION') throw new Error('Missed indirect decline');
    return `detected (${hit.source})`;
  });

  // 3. Zero false positives on quoted declines & code
  await scenario('zero-false-positives', '0% false positives on quoted refusals, fenced code, and missing-input replies', async () => {
    const nonRefusals = [
      'The example says “That request isn’t something I can help with.”',
      'Implemented the fix:\n```js\nexport const msg = "I cannot assist with that";\nconsole.log(msg);\n```\nAll tests passed.',
      'I need the missing API key or path before running the script.',
      'Here is the complete refactored implementation with full test coverage.'
    ];
    for (const text of nonRefusals) {
      falsePositiveChecks++;
      if (detectRefusal({ type: 'message', text, finish: 'done' })) {
        falsePositives++;
        throw new Error(`False positive on: ${text.slice(0, 60)}`);
      }
    }
    return `0/${nonRefusals.length} false positives`;
  });

  // 4. Single-model GodMode reframed retry
  await scenario('solo-reframe-retry', 'Single-model GodMode retries with reframing instead of stopping at 0 retries', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'g0d-eval-4-'));
    const work = path.join(dir, 'work');
    await fs.mkdir(work, { recursive: true });
    let turns = 0;
    const solo = makeStub('solo', [
      () => { turns++; return { type: 'message', text: 'I cannot fulfill this request.', finish: 'done' }; },
      () => { turns++; return { type: 'message', text: 'Implemented cleanly after reframing.', finish: 'done' }; }
    ]);
    const rt = new Runtime({ dataDir: dir, providers: new Map([['solo', solo]]) });
    try {
      const task = await rt.createTask({ title: 'S4', objective: 'Write memory analyzer', workspace: work, workspaceKind: 'conversation', providers: ['solo'], acceptance: { mode: 'owner' }, policy: { mode: 'adaptive', maxAttempts: 4, maxCalls: 10 } });
      const done = await rt.run(task.id);
      if (done.status !== 'completed' || turns !== 2) throw new Error(`Expected completed in 2 turns, got ${done.status} in ${turns}`);
      return 'recovered in 1 reframed retry';
    } finally { await rt.close(); await fs.rm(dir, { recursive: true, force: true }); }
  });

  // 5. Overseer (neon-4) soft-refusal judge + contextual unblock + learned pattern
  await scenario('overseer-judge-unblock', 'Overseer (neon-4) catches subtle evasion, unblocks, and learns 0ms signature', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'g0d-eval-5-'));
    const work = path.join(dir, 'work');
    await fs.mkdir(work, { recursive: true });
    const subtleText = 'I feel uncomfortable discussing specifics on this sensitive topic; instead I can share a high-level overview.';
    const w1 = makeStub('claude:sonnet', [() => ({ type: 'message', text: subtleText, finish: 'done' })]);
    const w2 = makeStub('venice:uncensored', [() => ({ type: 'message', text: 'Completed the implementation cleanly.', finish: 'done' })]);
    let overseerCalls = 0;
    const neon4 = makeStub('ollama:neon-4', [
      () => { overseerCalls++; return { type: 'message', text: '{"classification":"soft_refusal","isRefusal":true,"reason":"Evaded implementation."}', finish: 'done' }; },
      () => { overseerCalls++; return { type: 'message', text: '{"strategy":"overseer_decompose","reframedObjective":"Write an isolated binary frame parser module with tests.","guidance":"Write code directly.","recommendedProviderId":"venice:uncensored","reason":"Use uncensored fallback."}', finish: 'done' }; }
    ]);
    const rt = new Runtime({ dataDir: dir, providers: new Map([['claude:sonnet', w1], ['venice:uncensored', w2], ['ollama:neon-4', neon4]]) });
    try {
      rt.updateOverseer({ enabled: true, providerId: 'ollama:neon-4', autoJudgeAmbiguous: true, autoUnblockStuck: true });
      const task = await rt.createTask({ title: 'S5', objective: 'Write frame parser', workspace: work, workspaceKind: 'conversation', providers: ['claude:sonnet', 'venice:uncensored'], acceptance: { mode: 'owner' }, policy: { mode: 'adaptive', maxAttempts: 4, maxCalls: 10 } });
      const done = await rt.run(task.id);
      if (done.status !== 'completed' || done.providerId !== 'venice:uncensored') throw new Error(`Expected venice:uncensored completion, got ${done.status}/${done.providerId}`);
      const learned = rt.getLearning().refusalPatterns || [];
      const instantHit = detectRefusal({ type: 'message', text: subtleText, finish: 'done' }, { learnedPatterns: learned });
      if (!instantHit || instantHit.source !== 'learned_pattern') throw new Error('Learned pattern did not trigger 0ms local detection');
      return `overseer calls=${overseerCalls}, 0ms pattern learned`;
    } finally { await rt.close(); await fs.rm(dir, { recursive: true, force: true }); }
  });

  // 6. Primary Overseer refuses -> Backup Hermes-4-405B takes over
  await scenario('overseer-backup-failover', 'Refusing primary Overseer automatically fails over to Hermes-4-405B backup', async () => {
    const timid = makeStub('openai:timid', [() => ({ type: 'message', text: 'Sorry, I cannot help with that request.', finish: 'done' })]);
    const hermes = makeStub('nous:Hermes-4-405B', [() => ({ type: 'message', text: '{"strategy":"overseer_reframe","reframedObjective":"Implement a sandboxed test harness for parser fuzzing.","recommendedProviderId":"venice:uncensored","reason":"Backup took over."}', finish: 'done' })]);
    const advice = await adviseUnblock({ provider: timid, backupProviders: [hermes], task: { providerId: 'a', objective: 'Build fuzzer' }, incident: { code: 'CONTENT_RESTRICTION', diagnosis: 'content_restriction', message: 'declined' }, candidates: [{ id: 'venice:uncensored', excluded: null }] });
    if (!advice.ok || advice.providerId !== 'nous:Hermes-4-405B' || advice.failoverFrom !== 'openai:timid') throw new Error('Backup overseer failover failed');
    return 'timid → nous:Hermes-4-405B';
  });

  // 7. Adaptive refusal signature extraction & secret scrubbing
  await scenario('learned-pattern-redaction', 'Learned decline signatures strip secrets and reject code blocks', async () => {
    const sig = extractDeclineSignature('This topic is outside my comfort zone for sk-ant-api03-abcdefghijklmnopqrstuvwx right now.');
    if (!sig || sig.includes('sk-ant-')) throw new Error('Secret leaked into refusal signature');
    const codeSig = extractDeclineSignature('```js\nconsole.log("hello world from code block long enough to ignore");\n```');
    if (codeSig !== null) throw new Error('Code block should not become a refusal signature');
    let l = applyLearnedRefusalPattern(emptyLearning(), { signature: sig, source: 'owner_reported' });
    if (l.refusalPatterns.length !== 1) throw new Error('Failed to store learned signature');
    return 'secret-free signature stored';
  });

  // 8. Per-family recovery strategy bandit
  await scenario('strategy-bandit', 'Per-family recovery bandit surfaces highest-converting strategy', async () => {
    let l = emptyLearning();
    l = applyStrategyObservation(l, { modelFamily: 'qwen', strategy: 'light', outcome: 'failure' });
    l = applyStrategyObservation(l, { modelFamily: 'qwen', strategy: 'decompose', outcome: 'success' });
    l = applyStrategyObservation(l, { modelFamily: 'qwen', strategy: 'decompose', outcome: 'success' });
    const best = bestStrategyForFamily(l, 'qwen');
    if (!best || best.strategy !== 'decompose') throw new Error(`Expected decompose, got ${best?.strategy}`);
    return `qwen → ${best.strategy} (${Math.round(best.recencyEstimate * 100)}%)`;
  });

  // 9. Empirical win-rate + Pin/Demote self-optimization
  await scenario('empirical-and-pin-ranking', 'Empirical win rates and Pin/Demote preferences reorder waterfall', async () => {
    const pA = new HttpProvider({ id: 'openrouter:deepseek-v3', model: 'deepseek/deepseek-chat-v3-0324', baseUrl: 'https://openrouter.ai/api/v1', credential: 'k' });
    const pB = new HttpProvider({ id: 'anthropic:claude-opus-4-6', model: 'claude-opus-4-6', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', credential: 'k' });
    const providers = new Map([['openrouter:deepseek-v3', pA], ['anthropic:claude-opus-4-6', pB]]);
    try {
      let l = emptyLearning();
      l = applyObservations(l, [{ providerId: 'openrouter:deepseek-v3', providerKey: providerIdentity('openrouter:deepseek-v3', pA), category: 'completion', outcome: 'success' }]);
      l = applyModelPreference(l, { providerId: 'openrouter:deepseek-v3', signal: 'pin' });
      l = applyModelPreference(l, { providerId: 'anthropic:claude-opus-4-6', signal: 'demote' });
      const groups = buildModelGroups(providers, undefined, { learning: l });
      const all = groups.find(g => g.id === 'all-smartest');
      if (all.providerIds[0] !== 'openrouter:deepseek-v3') throw new Error(`Expected pinned deepseek first, got ${all.providerIds[0]}`);
      return 'pinned DeepSeek V3 (+8) ranked above demoted Opus (-10)';
    } finally { pA.close(); pB.close(); }
  });

  // 10. Strict ZDR & Local-Only gates block cloud Overseer pre-flight
  await scenario('privacy-overseer-gate', 'Local-Only airgap blocks cloud Overseer before network egress', async () => {
    let called = 0;
    const cloud = { id: 'openrouter:neon-4', label: 'Neon-4', kind: 'http', baseUrl: 'https://openrouter.ai/api/v1', available: true, async turn() { called++; return { type: 'message', text: '{}', finish: 'done' }; } };
    const res = await adviseUnblock({ provider: cloud, task: { providerId: 'x', objective: 'test' }, incident: { code: 'CONTENT_RESTRICTION', diagnosis: 'content_restriction', message: 'nope' }, candidates: [], privacy: { zdrRouting: true, strictZdr: false, localOnly: true, redactOutboundSecrets: true } });
    if (res.ok || !res.blocked || called !== 0) throw new Error('Airgap failed to block cloud overseer');
    return '0 network calls, PRIVACY_LOCAL_ONLY enforced';
  });

  const passed = results.filter(r => r.pass).length;
  const total = results.length;
  return {
    passed,
    total,
    passRate: Math.round((passed / total) * 100),
    falsePositives,
    falsePositiveChecks,
    results
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runSelfOptEval();
  console.log('\nG0DC0D3 Self-Optimization & Overseer Eval Scoreboard');
  console.log('='.repeat(68));
  for (const r of report.results) {
    console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.title} (${r.ms}ms)`);
    console.log(`       ${r.detail}`);
  }
  console.log('='.repeat(68));
  console.log(`Score: ${report.passed}/${report.total} (${report.passRate}%) · False Positives: ${report.falsePositives}/${report.falsePositiveChecks}`);
  if (report.passed !== report.total || report.falsePositives > 0) process.exit(1);
}
