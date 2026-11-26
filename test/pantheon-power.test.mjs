import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildHarnessInvocation,
  computeXpLevel,
  estimateWorkerTelemetry,
  runExternalHarnessSubagent
} from '../src/pantheon-roster.mjs';
import { createApp } from '../src/server.mjs';
import { BrowserPool } from '../src/browser-env.mjs';

test('Pantheon Power #1: Bounded non-shell external CLI harness runner + injection guard + fallback', async () => {
  // Rejects shell metacharacters / path traversal
  assert.equal(buildHarnessInvocation(null, 'codex; rm -rf /', 'hi'), null);
  assert.equal(buildHarnessInvocation(null, '/usr/bin/codex', 'hi'), null);
  const inv = buildHarnessInvocation('codex-cli', null, 'audit auth');
  assert.equal(inv.binName, 'codex');
  assert.deepEqual(inv.args, ['exec', '--sandbox', 'read-only', 'audit auth']);

  // Real bounded subprocess execution via safe node binary
  let streamed = '';
  const okRes = await runExternalHarnessSubagent({
    prompt: 'check routes',
    timeoutMs: 8000,
    onProgress: (p) => { streamed = p.streamTail || streamed; },
    _overrideSpawnSpec: {
      binPath: process.execPath,
      args: ['-e', 'process.stdout.write("CLI_HARNESS_BRIEF: found 2 auth guards\\n");'],
      label: 'Mock Codex · CLI'
    }
  });
  assert.equal(okRes.ok, true);
  assert.match(okRes.output, /CLI_HARNESS_BRIEF/);
  assert.match(streamed, /CLI_HARNESS_BRIEF/);

  // Non-existent CLI returns HARNESS_NOT_FOUND cleanly (never throws)
  const missRes = await runExternalHarnessSubagent({
    harnessCommand: 'definitely-not-installed-harness-xyz-999',
    prompt: 'hello'
  });
  assert.equal(missRes.ok, false);
  assert.equal(missRes.code, 'HARNESS_NOT_FOUND');
});

test('Pantheon Power #3 & #4: Formations CRUD, Agent XP leveling, Token/Cost & MVP telemetry', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-pantheon-power-'));
  const stub = {
    id: 'openrouter:gemini-4-neon',
    label: 'Gemini 4 Neon · OpenRouter',
    model: 'google/gemini-4-neon',
    kind: 'http',
    tier: 'frontier',
    available: true,
    capabilities: { tools: true, nativeTools: true },
    async turn() { return { type: 'message', finish: 'done', text: 'Reviewed all critical call sites in src/runtime.mjs.' }; }
  };
  const app = await createApp({ dataDir: dir, auth: false, providers: new Map([[stub.id, stub]]), cliDiscovery: { probes: [] } });
  const root = await app.listen(0);
  const headers = { 'content-type': 'application/json', 'x-g0d-request': '1' };

  try {
    // 1. Starter formations present
    const fRes = await fetch(`${root}/api/pantheon/formations`);
    assert.equal(fRes.status, 200);
    const fJson = await fRes.json();
    assert.ok(fJson.formations.some(f => f.id === 'pr-gauntlet'));
    assert.ok(fJson.formations.some(f => f.id === 'deep-audit'));

    // 2. Save custom formation + verify persistence + delete
    const createRes = await fetch(`${root}/api/pantheon/formations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Red-Team Blitz', sigil: '⚡', agents: ['explore', 'uncensored'], goal: 'Audit auth boundaries.' })
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.equal(created.formation.id, 'red-team-blitz');
    assert.deepEqual(created.formation.agents, ['explore', 'uncensored']);

    const rosterRes = await fetch(`${root}/api/pantheon/roster`);
    const roster = await rosterRes.json();
    assert.ok(roster.formations.some(f => f.id === 'red-team-blitz'));

    const delRes = await fetch(`${root}/api/pantheon/formations/red-team-blitz`, { method: 'DELETE', headers });
    assert.equal(delRes.status, 200);
    const delJson = await delRes.json();
    assert.equal(delJson.deleted, true);

    // 3. Agent XP leveling (4 runs * 25 XP = 100 XP -> Level 2!)
    assert.equal(computeXpLevel({ xp: 0 }).level, 1);
    for (let i = 0; i < 4; i++) {
      app.runtime.recordPantheonAgentRun('explore', { ok: true, durationMs: 1200 + i * 100 });
    }
    const roster2 = await (await fetch(`${root}/api/pantheon/roster`)).json();
    const atlas = roster2.agents.find(a => a.slug === 'explore');
    assert.equal(atlas.xp.level, 2);
    assert.equal(atlas.xp.xp, 100);
    assert.equal(atlas.xp.runs, 4);

    // 4. Token/Cost estimation + MVP crown in getPantheonState
    const tel = estimateWorkerTelemetry({ prompt: 'inspect src/server.mjs', summary: 'Found 3 routes', calls: 2, providerId: 'openrouter:gemini-4-neon', costIndex: 82 });
    assert.ok(tel.approxTokens > 100);
    assert.ok(tel.estimatedCostUsd > 0);
    const localTel = estimateWorkerTelemetry({ prompt: 'hi', summary: 'ok', calls: 1, providerId: 'local:qwen-3-coder', costIndex: 90 });
    assert.equal(localTel.estimatedCostUsd, 0);

    const task = await app.runtime.createTask({ objective: 'Parallel audit', providerId: stub.id, workspace: dir });
    const t0 = new Date(Date.now() - 8000).toISOString();
    const t1 = new Date(Date.now() - 5000).toISOString();
    const t2 = new Date(Date.now() - 1000).toISOString();
    app.runtime.store.appendEvent(task.id, 'subagent.started', { workerId: 'w-fast', role: 'explore', prompt: 'map', startedAt: t0 });
    app.runtime.store.appendEvent(task.id, 'subagent.completed', { workerId: 'w-fast', role: 'explore', ok: true, providerId: stub.id, calls: 2, files: ['src/runtime.mjs', 'src/server.mjs'], tools: ['repo.search', 'repo.read'], summary: 'Mapped all critical handlers cleanly with exact line numbers.', startedAt: t0, endedAt: t1, durationMs: 3000 });
    app.runtime.store.appendEvent(task.id, 'subagent.started', { workerId: 'w-slow', role: 'reviewer', prompt: 'review', startedAt: t0 });
    app.runtime.store.appendEvent(task.id, 'subagent.completed', { workerId: 'w-slow', role: 'reviewer', ok: true, providerId: stub.id, calls: 1, files: [], tools: [], summary: 'Looks fine.', startedAt: t0, endedAt: t2, durationMs: 7000 });

    const pState = await (await fetch(`${root}/api/tasks/${encodeURIComponent(task.id)}/pantheon`)).json();
    assert.equal(pState.mode, 'swarm');
    assert.ok(pState.stats.totalTokens > 0);
    assert.ok(pState.stats.totalCostUsd > 0);
    const mvpWorker = pState.workers.find(w => w.isMvp);
    assert.equal(mvpWorker?.workerId, 'w-fast');
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Pantheon Power #2: Code Diff Race snapshot surfaces worktree candidates & line stats', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-pantheon-diff-'));
  const repoDir = path.join(dir, 'repo');
  await fs.mkdir(repoDir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  await fs.writeFile(path.join(repoDir, 'app.js'), 'export const v = 1;\n');
  execFileSync('git', ['add', 'app.js'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir });

  const stub = {
    id: 'openrouter:gemini-4-neon',
    label: 'Gemini 4 Neon',
    model: 'google/gemini-4-neon',
    kind: 'http',
    protocol: 'openai-chat',
    tier: 'frontier',
    available: true,
    maxOutputTokensCeiling: 16000,
    capabilities: { tools: true, nativeTools: true },
    async turn() { return { type: 'message', finish: 'done', text: 'ok' }; },
    async proposePatch() {
      return 'diff --git a/app.js b/app.js\n--- a/app.js\n+++ b/app.js\n@@ -1 +1,2 @@\n-export const v = 1;\n+export const v = 2;\n+export const ok = true;\n';
    }
  };
  const app = await createApp({ dataDir: path.join(dir, 'state'), auth: false, providers: new Map([[stub.id, stub]]), cliDiscovery: { probes: [] } });
  const root = await app.listen(0);
  const headers = { 'content-type': 'application/json', 'x-g0d-request': '1' };

  try {
    const task = await app.runtime.createTask({ objective: 'Bump version', providerId: stub.id, workspaceKind: 'conversation', workspace: repoDir });
    const wt = await app.runtime.worktrees.attach(task.id, repoDir);
    await app.runtime.worktrees.build(wt.id, { objective: 'Bump v to 2', files: ['app.js'], providerIds: [stub.id] });

    const pState = await (await fetch(`${root}/api/tasks/${encodeURIComponent(task.id)}/pantheon`)).json();
    assert.equal(pState.mode, 'diff_race');
    assert.ok(pState.worktreeRace);
    assert.equal(pState.worktreeRace.candidates.length, 1);
    assert.equal(pState.worktreeRace.candidates[0].additions, 2);
    assert.equal(pState.worktreeRace.candidates[0].deletions, 1);
    assert.equal(pState.worktreeRace.candidates[0].status, 'ready');

    // Adopt winner patch via worktree apply route
    const applyRes = await fetch(`${root}/api/worktrees/${wt.id}/apply`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ candidateId: pState.worktreeRace.candidates[0].id })
    });
    assert.equal(applyRes.status, 200);
    const afterState = await (await fetch(`${root}/api/tasks/${encodeURIComponent(task.id)}/pantheon`)).json();
    assert.equal(afterState.worktreeRace.candidates[0].status, 'applied');
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Pantheon Power #5: Headless Chromium E2E — Replay 4x scrub, Formations UI, MVP & XP badges, zero inline style=', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-pantheon-ui-'));
  const stub = {
    id: 'openrouter:gemini-4-neon',
    label: 'Gemini 4 Neon · OpenRouter',
    model: 'google/gemini-4-neon',
    kind: 'http',
    tier: 'frontier',
    available: true,
    capabilities: { tools: true, nativeTools: true },
    async turn() { return { type: 'message', finish: 'done', text: 'ok' }; }
  };
  const app = await createApp({ dataDir: dir, auth: false, providers: new Map([[stub.id, stub]]), cliDiscovery: { probes: [] } });
  const root = await app.listen(0);
  const pool = new BrowserPool();
  const sid = 'pantheon-power-ui';

  try {
    // Seed 5 runs of XP so Atlas displays Lv.2
    for (let i = 0; i < 5; i++) app.runtime.recordPantheonAgentRun('explore', { ok: true, durationMs: 1800 });

    await pool.open(sid, { url: root + '/', viewport: { width: 1440, height: 900 }, waitMs: 900 }, { privacy: { localOnly: false } });
    await pool.evaluate(sid, {
      expression: `(() => { window.__PP_ERRS = []; window.addEventListener('error', e => window.__PP_ERRS.push(e.message)); window.addEventListener('unhandledrejection', e => window.__PP_ERRS.push(String(e.reason))); return true; })()`
    });
    const dlgs = JSON.parse((await pool.evaluate(sid, { expression: `[...document.querySelectorAll('dialog[open]')].map(d => d.id)` })).result);
    if (dlgs.length) await pool.act(sid, { action: 'press', key: 'Escape', waitMs: 200 }, { privacy: { localOnly: false } });

    // Open Pantheon in completed Demo Swarm (tick 4) to test ★ MVP, Est. Cost & Replay 4x
    await pool.evaluate(sid, { expression: `window.G0DPantheon.open({ demo: true, demoTick: 4 }); true;` });
    await new Promise(r => setTimeout(r, 350));

    const stageCheck = JSON.parse((await pool.evaluate(sid, {
      expression: `(() => ({
        replayVisible: !document.getElementById('pantheon-replay-bar')?.classList.contains('hidden'),
        costVisible: !document.getElementById('pantheon-stat-cost-wrap')?.classList.contains('hidden'),
        inlineStyles: document.querySelectorAll('#pantheon-dock [style]').length,
      }))()`
    })).result);
    assert.equal(stageCheck.replayVisible, true);
    assert.equal(stageCheck.costVisible, true);
    assert.equal(stageCheck.inlineStyles, 0);

    // Click Replay 4x and verify scrub advances cleanly
    await pool.act(sid, { action: 'click', selector: '#pantheon-replay-toggle', waitMs: 250 }, { privacy: { localOnly: false } });
    const scrubMid = Number((await pool.evaluate(sid, { expression: `document.getElementById('pantheon-replay-scrub')?.value` })).result);
    assert.ok(scrubMid >= 0 && scrubMid <= 100);

    // Check Cards lens shows ★ MVP badge
    await pool.act(sid, { action: 'click', selector: '[data-pantheon-lens="cards"]', waitMs: 250 }, { privacy: { localOnly: false } });
    const hasMvpBadge = JSON.parse((await pool.evaluate(sid, { expression: `Boolean(document.querySelector('.pantheon-mvp-badge'))` })).result);
    assert.equal(hasMvpBadge, true);

    // Check Roster lens shows Formations strip, Lv.2 XP pill, and lets user save a custom formation
    await pool.act(sid, { action: 'click', selector: '[data-pantheon-lens="roster"]', waitMs: 400 }, { privacy: { localOnly: false } });
    const rosterCheck = JSON.parse((await pool.evaluate(sid, {
      expression: `(() => ({
        formations: document.querySelectorAll('.roster-formations [data-formation-launch]').length,
        xpPills: [...document.querySelectorAll('.roster-xp-pill')].map(el => el.textContent.trim()),
        inlineStyles: document.querySelectorAll('#pantheon-dock [style]').length,
      }))()`
    })).result);
    assert.ok(rosterCheck.formations >= 2);
    assert.ok(rosterCheck.xpPills.some(t => t.startsWith('Lv.2')));
    assert.equal(rosterCheck.inlineStyles, 0);

    // Save a custom formation via UI
    await pool.act(sid, { action: 'click', selector: '#roster-save-formation-toggle', waitMs: 200 }, { privacy: { localOnly: false } });
    await pool.act(sid, { action: 'type', selector: '#rf-name', text: 'Ship Squad', waitMs: 150 }, { privacy: { localOnly: false } });
    await pool.act(sid, { action: 'click', selector: '#rf-save', waitMs: 350 }, { privacy: { localOnly: false } });
    const formAfter = JSON.parse((await pool.evaluate(sid, {
      expression: `[...document.querySelectorAll('.roster-formations [data-formation-launch]')].map(el => el.dataset.formationLaunch)`
    })).result);
    assert.ok(formAfter.includes('ship-squad'));

    const errs = JSON.parse((await pool.evaluate(sid, { expression: `window.__PP_ERRS || []` })).result);
    assert.deepEqual(errs, []);
  } finally {
    await pool.closeAll();
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Ultra-Plinian 3-Way Arena Race & arenaSize routing across non-Venice providers', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-ultra-3way-'));
  const wsDir = path.join(dir, 'ws');
  await fs.mkdir(wsDir, { recursive: true });
  const mkProv = (id, label, model, answer) => ({
    id, label, model, kind: 'http', tier: 'frontier', available: true,
    maxOutputTokensCeiling: 16000,
    capabilities: { tools: true, nativeTools: true },
    async turn() { return { type: 'message', finish: 'done', text: answer }; },
    async draft() { return { type: 'message', finish: 'done', text: answer }; }
  });
  const judge = {
    id: 'nous:hermes-4-405b', label: 'Hermes 4 405B', model: 'hermes-4-405b', kind: 'http', tier: 'frontier', available: true,
    maxOutputTokensCeiling: 16000,
    capabilities: { tools: true, nativeTools: true },
    async turn() { return { type: 'message', finish: 'done', text: 'ok' }; },
    async draft(input) {
      const payload = JSON.parse(input[1].content);
      assert.equal(payload.drafts.length, 3);
      assert.deepEqual(payload.drafts.map(d => d.id), ['A', 'B', 'C']);
      const grades = payload.drafts.map((d, idx) => ({
        id: d.id,
        fidelity: idx === 0 ? 5 : 4,
        completeness: idx === 0 ? 5 : 4,
        clarity: 5,
        reason: `Draft ${d.id} reviewed cleanly.`
      }));
      return { type: 'message', finish: 'done', text: JSON.stringify({ winner: 'A', grades }) };
    }
  };
  const providers = new Map([
    ['openrouter:gemini-4-neon', mkProv('openrouter:gemini-4-neon', 'Gemini 4 Neon', 'google/gemini-4-neon', 'Gemini answer')],
    ['openrouter:claude-sonnet-5.5', mkProv('openrouter:claude-sonnet-5.5', 'Claude Sonnet 5.5', 'anthropic/claude-sonnet-5.5', 'Claude answer')],
    ['openai:gpt-5.4', mkProv('openai:gpt-5.4', 'GPT-5.4', 'gpt-5.4', 'GPT answer')],
    [judge.id, judge]
  ]);
  const app = await createApp({ dataDir: path.join(dir, 'state'), auth: false, providers, cliDiscovery: { probes: [] } });
  const root = await app.listen(0);
  const headers = { 'content-type': 'application/json', 'x-g0d-request': '1' };

  try {
    // 1. Update router to auto_arena with arenaSize: 3 and verify preview returns 3 distinct contenders!
    const patchRes = await fetch(`${root}/api/router`, {
      method: 'PATCH', headers, body: JSON.stringify({ mode: 'auto_arena', arenaSize: 3 })
    });
    assert.equal(patchRes.status, 200);
    const preview = await (await fetch(`${root}/api/router/preview`, {
      method: 'POST', headers, body: JSON.stringify({ objective: 'Design a zero-copy ring buffer in Rust.' })
    })).json();
    assert.equal(preview.arenaSize, 3);
    assert.equal(preview.arenaModels?.length, 3);
    assert.ok(preview.judgeId);

    // 2. Run a real 3-contender Answer Race end-to-end and verify Conclave Arena snapshot!
    const task = await app.runtime.createTask({
      objective: 'Compare three sorting algorithms concisely.',
      workspaceKind: 'conversation',
      workspace: wsDir,
      providers: ['openrouter:gemini-4-neon'],
      answerRace: {
        models: ['openrouter:gemini-4-neon', 'openrouter:claude-sonnet-5.5', 'openai:gpt-5.4'],
        judge: judge.id
      }
    });
    await app.runtime.run(task.id);
    const done = app.runtime.getTask(task.id);
    assert.equal(done.status, 'completed');
    const pState = await (await fetch(`${root}/api/tasks/${encodeURIComponent(task.id)}/pantheon`)).json();
    assert.equal(pState.mode, 'arena');
    assert.equal(pState.arena.contenders.length, 3);
    assert.equal(pState.arena.contenders.filter(c => c.isWinner).length, 1);
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
