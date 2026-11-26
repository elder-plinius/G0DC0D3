import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { computeAgentStats, EXTERNAL_HARNESSES, normalizeRosterAgent } from '../src/conclave-roster.mjs';
import { discoverSubagents } from '../src/subagents.mjs';
import { createApp } from '../src/server.mjs';
import { BrowserPool } from '../src/browser-env.mjs';

test('Conclave Agent Stats Engine computes real benchmark radar stats & OVR across frontier APIs and external harnesses', () => {
  const geminiStats = computeAgentStats({
    candidate: { id: 'gemini:gemini-4-neon', model: 'gemini-4-neon', label: 'Gemini 4 Neon' },
    primarySpecialty: 'swe_coding',
    secondarySpecialty: 'math_reasoning'
  });
  const hermesStats = computeAgentStats({
    candidate: { id: 'nous:hermes-4-405b', model: 'hermes-4-405b', label: 'Hermes 4 405B' },
    primarySpecialty: 'security_research',
    secondarySpecialty: 'swe_coding'
  });
  const codexStats = computeAgentStats({ harnessId: 'codex-cli', primarySpecialty: 'swe_coding', secondarySpecialty: 'math_reasoning' });
  const agyStats = computeAgentStats({ harnessId: 'antigravity', primarySpecialty: 'swe_coding', secondarySpecialty: 'frontend_ui' });

  assert.ok(geminiStats.overall >= 85 && geminiStats.radar.swe >= 85);
  assert.ok(hermesStats.radar.agency >= 90, `Expected high agency for Hermes, got ${hermesStats.radar.agency}`);
  assert.ok(codexStats.overall >= 80 && agyStats.overall >= 80);
  assert.ok(EXTERNAL_HARNESSES.some(h => h.id === 'antigravity'));
  assert.ok(EXTERNAL_HARNESSES.some(h => h.id === 'codex-cli'));
  assert.ok(EXTERNAL_HARNESSES.some(h => h.id === 'claude-code'));
  assert.ok(EXTERNAL_HARNESSES.some(h => h.id === 'hermes'));
  assert.ok(EXTERNAL_HARNESSES.some(h => h.id === 'grok'));

  const norm = normalizeRosterAgent({ name: 'Grok Red Teamer', harnessId: 'grok', primarySpecialty: 'security_research', sigil: '⛨' });
  assert.equal(norm.slug, 'grok-red-teamer');
  assert.equal(norm.harnessId, 'grok');
  assert.equal(norm.sigil, '⛨');
});

test('Conclave Roster API CRUD, live stats preview, custom agent.spawn hydration, and headless Chromium Builder UI', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-roster-e2e-'));
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-roster-repo-'));
  await fs.writeFile(path.join(workDir, 'main.js'), 'export const ok = true;\n');

  const gemini = {
    id: 'gemini:gemini-4-neon',
    label: 'Gemini 4 Neon · Gemini',
    model: 'gemini-4-neon',
    kind: 'http',
    tier: 'frontier',
    available: true,
    capabilities: { tools: true, nativeTools: true, portableContext: true },
    async turn() { return { type: 'message', finish: 'done', text: 'ok' }; }
  };
  const hermes = {
    id: 'venice:hermes-4-405b',
    label: 'Hermes 4 405B · Venice',
    model: 'hermes-4-405b',
    kind: 'http',
    tier: 'frontier',
    available: true,
    capabilities: { tools: true, nativeTools: true, portableContext: true },
    async turn() { return { type: 'message', finish: 'done', text: 'hermes ok' }; }
  };

  const app = await createApp({
    dataDir: dir,
    auth: false,
    providers: new Map([[gemini.id, gemini], [hermes.id, hermes]]),
    cliDiscovery: { probes: [] }
  });
  const root = await app.listen(0);
  const pool = new BrowserPool();

  try {
    // 1. GET /api/conclave/roster returns starter agents, external harnesses, and real engines
    const initial = await fetch(`${root}/api/conclave/roster`).then(r => r.json());
    assert.ok(initial.agents.length >= 3);
    assert.ok(initial.harnesses.length >= 6);
    assert.ok(initial.engines.length === 2);

    // 2. POST /api/conclave/stats/preview returns real benchmark stats + bestEngine
    const preview = await fetch(`${root}/api/conclave/stats/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
      body: JSON.stringify({ providerId: hermes.id, primarySpecialty: 'security_research', secondarySpecialty: 'swe_coding' })
    }).then(r => r.json());
    assert.ok(preview.stats.radar.agency >= 90);
    assert.ok(preview.bestEngine?.id);

    // 3. POST /api/conclave/roster creates a custom agent & hydrates discoverSubagents()
    const created = await fetch(`${root}/api/conclave/roster`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
      body: JSON.stringify({
        name: 'Valkyrie Red-Team',
        sigil: '⛨',
        engineType: 'api',
        providerId: hermes.id,
        primarySpecialty: 'security_research',
        secondarySpecialty: 'math_reasoning',
        autonomy: 'read_only',
        effort: 'high',
        instructions: 'Audit security boundaries ruthlessly.'
      })
    }).then(r => r.json());
    assert.equal(created.ok, true);
    assert.equal(created.agent.slug, 'valkyrie-red-team');

    const discovered = await discoverSubagents({ workspace: workDir }, app.runtime);
    assert.ok(discovered.has('valkyrie-red-team'), 'Expected forged Conclave agent to be discoverable by agent.spawn');
    assert.equal(discovered.get('valkyrie-red-team').model, hermes.id);

    // 4. Headless Chromium UI check: Roster lens, Radar canvases, Harness click -> Builder, Save, Squad Deploy, 0 inline style=, 0 JS errors
    await pool.open('roster-ui', { url: root + '/', viewport: { width: 1440, height: 900 }, waitMs: 1000 }, { privacy: { localOnly: false } });
    await pool.evaluate('roster-ui', {
      expression: `window.__RE=[]; window.addEventListener('error', e => window.__RE.push(e.message)); true;`
    });
    const dlgs = JSON.parse((await pool.evaluate('roster-ui', { expression: `[...document.querySelectorAll('dialog[open]')].map(d => d.id)` })).result);
    if (dlgs.length) await pool.act('roster-ui', { action: 'press', key: 'Escape', waitMs: 180 }, { privacy: { localOnly: false } });

    await pool.act('roster-ui', { action: 'click', selector: '#conclave-toggle-btn', waitMs: 300 }, { privacy: { localOnly: false } });
    await pool.act('roster-ui', { action: 'click', selector: '[data-conclave-lens="roster"]', waitMs: 450 }, { privacy: { localOnly: false } });

    const rosterCheck = JSON.parse((await pool.evaluate('roster-ui', {
      expression: `(() => ({
        cards: document.querySelectorAll('.roster-card').length,
        radars: document.querySelectorAll('.roster-mini-radar').length,
        harnesses: document.querySelectorAll('.roster-harness-pill').length,
        inlineStyles: document.querySelectorAll('#conclave-dock [style]').length,
      }))()`
    })).result);
    assert.ok(rosterCheck.cards >= 4, `Expected >=4 roster cards including Valkyrie, got ${rosterCheck.cards}`);
    assert.equal(rosterCheck.radars, rosterCheck.cards);
    assert.ok(rosterCheck.harnesses >= 6);
    assert.equal(rosterCheck.inlineStyles, 0);

    // Click Antigravity harness pill to open Builder pre-bound to Antigravity!
    await pool.act('roster-ui', { action: 'click', selector: '[data-roster-harness="antigravity"]', waitMs: 350 }, { privacy: { localOnly: false } });
    const builderCheck = JSON.parse((await pool.evaluate('roster-ui', {
      expression: `(() => ({
        visible: Boolean(document.querySelector('#conclave-builder')),
        ovr: Number(document.querySelector('#pb-ovr-num')?.textContent || 0),
        nameVal: document.querySelector('#pb-name')?.value || '',
        inlineStyles: document.querySelectorAll('#conclave-dock [style]').length,
      }))()`
    })).result);
    assert.equal(builderCheck.visible, true);
    assert.ok(builderCheck.ovr >= 75);
    assert.ok(builderCheck.nameVal.includes('Antigravity'));
    assert.equal(builderCheck.inlineStyles, 0);

    // Save the Antigravity agent right from UI, add 2 agents to Squad, click Deploy Squad!
    await pool.act('roster-ui', { action: 'click', selector: '#pb-save', waitMs: 400 }, { privacy: { localOnly: false } });
    await pool.act('roster-ui', { action: 'click', selector: '[data-roster-squad="valkyrie-red-team"]', waitMs: 200 }, { privacy: { localOnly: false } });
    await pool.act('roster-ui', { action: 'click', selector: '#roster-deploy-squad', waitMs: 250 }, { privacy: { localOnly: false } });
    const composerVal = (await pool.evaluate('roster-ui', { expression: `document.querySelector('#composer-input')?.value || ''` })).result;
    assert.ok(composerVal.includes('valkyrie-red-team'), 'Expected Squad Deploy to load custom agent into composer');

    const errs = JSON.parse((await pool.evaluate('roster-ui', { expression: `window.__RE || []` })).result);
    assert.deepEqual(errs, []);

    // 5. DELETE custom agent cleanly
    const delRes = await fetch(`${root}/api/conclave/roster/valkyrie-red-team`, {
      method: 'DELETE',
      headers: { 'x-g0d-request': '1' }
    }).then(r => r.json());
    assert.equal(delRes.deleted, true);
  } finally {
    await pool.closeAll();
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(workDir, { recursive: true, force: true });
  }
});
