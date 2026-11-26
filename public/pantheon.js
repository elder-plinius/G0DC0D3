'use strict';

(function initG0DPantheon() {
  const ROLE_COLORS = {
    explore: '#60a5fa',
    reviewer: '#a78bfa',
    uncensored: '#f472b6',
    solver: '#34d399',
    challenger: '#fbbf24',
    verifier: '#2dd4bf',
    judge: '#f59e0b',
    default: '#c084fc',
  };

  const STATUS_META = {
    thinking:   { label: 'Thinking',   tone: 'violet', active: true },
    streaming:  { label: 'Streaming',  tone: 'violet', active: true },
    tool:       { label: 'Tool',       tone: 'amber',  active: true },
    recovering: { label: 'GODMODƎ',    tone: 'gold',   active: true },
    completed:  { label: 'Verified',   tone: 'sage',   active: false },
    failed:     { label: 'Failed',     tone: 'coral',  active: false },
    paused:     { label: 'Paused',     tone: 'amber',  active: false },
    queued:     { label: 'Queued',     tone: 'muted',  active: false },
  };

  let isOpenState = false;
  let isExpanded = false;
  let activeLens = 'stage'; // 'stage' | 'cards' | 'timeline'
  let currentTaskId = null;
  let data = null;
  let selectedWorkerId = null;
  let hoveredWorkerId = null;
  let demoMode = false;
  let demoTimer = null;
  let rafId = null;
  let animPhase = 0;
  let lastFrameMs = 0;
  let autoOpenedTaskIds = new Set();
  let stageHitTargets = [];
  let timelineHitTargets = [];
  let fetchToken = 0;
  let rosterData = null;
  let selectedSquad = new Set();
  let builderOpen = false;
  let builderDraft = null;
  let builderStats = null;
  let builderBestEngine = null;
  let formationFormOpen = false;
  let replayPlaying = false;
  let replayProgress = 100; // 0..100
  const SIGILS = ['✦', '⚡', '◈', '⛨', '⌘', 'λ', 'Ω', 'Δ'];

  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const fmtTokens = (n) => {
    const v = Number(n || 0);
    if (!v) return '';
    return v >= 1000 ? `~${(v / 1000).toFixed(1)}k tok` : `~${v} tok`;
  };
  const fmtCost = (usd) => {
    const v = Number(usd || 0);
    if (!v) return 'Free';
    if (v < 0.001) return '<$0.001';
    return `$${v.toFixed(3)}`;
  };

  const fmtMs = (ms) => {
    const n = Number(ms || 0);
    if (!n || n < 0) return '0.0s';
    if (n < 1000) return `${Math.round(n)}ms`;
    if (n < 60000) return `${(n / 1000).toFixed(1)}s`;
    return `${Math.floor(n / 60000)}m ${Math.round((n % 60000) / 1000)}s`;
  };

  const shortModel = (label) => {
    if (!label) return 'Auto';
    return String(label).replace(/\s*·\s*(OpenRouter|Venice|Anthropic|OpenAI|Gemini|Nous).*$/i, '').slice(0, 24);
  };

  const roleColor = (role) => ROLE_COLORS[String(role || '').toLowerCase()] || ROLE_COLORS.default;
  const statusInfo = (status) => STATUS_META[String(status || 'queued').toLowerCase()] || STATUS_META.queued;

  function themePalette() {
    const cs = getComputedStyle(document.documentElement);
    const isLight = document.documentElement.dataset.theme === 'light';
    return {
      isLight,
      bg: cs.getPropertyValue('--surface').trim() || (isLight ? '#f7f5f0' : '#121315'),
      panel: cs.getPropertyValue('--panel').trim() || (isLight ? '#ffffff' : '#191b1f'),
      line: cs.getPropertyValue('--line').trim() || (isLight ? 'rgba(20,24,31,0.12)' : 'rgba(255,255,255,0.1)'),
      text: cs.getPropertyValue('--text').trim() || (isLight ? '#18191b' : '#f4f4f6'),
      muted: cs.getPropertyValue('--text-muted').trim() || (isLight ? '#646873' : '#8d92a0'),
      violet: cs.getPropertyValue('--violet').trim() || (isLight ? '#6d28d9' : '#a78bfa'),
      sage: cs.getPropertyValue('--sage').trim() || (isLight ? '#15803d' : '#4ade80'),
      amber: '#f59e0b',
      gold: '#fbbf24',
      coral: '#f87171',
      blue: '#60a5fa',
    };
  }

  function motionReduced() {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return true;
    try {
      const qol = window.G0DQol?.get?.();
      if (qol?.pauseBackdrop) return true;
    } catch {}
    return false;
  }

  function dockEl() { return document.getElementById('pantheon-dock'); }

  function ensureShell() {
    const dock = dockEl();
    if (!dock || dock.dataset.pantheonInit) return dock;
    dock.dataset.pantheonInit = '1';
    dock.innerHTML = `
      <header class="pantheon-header">
        <div class="pantheon-title-wrap">
          <span class="pantheon-sigil" aria-hidden="true">✦</span>
          <div class="pantheon-title-copy">
            <h2 class="pantheon-title">THE CONCLAVE</h2>
            <p class="pantheon-subtitle" id="pantheon-subtitle">Multi-Agent Council &amp; Arena Stage</p>
          </div>
        </div>
        <div class="pantheon-header-controls">
          <div class="pantheon-lenses" role="tablist" aria-label="Conclave views">
            <button type="button" class="pantheon-lens active" role="tab" aria-selected="true" data-pantheon-lens="stage">✦ Stage</button>
            <button type="button" class="pantheon-lens" role="tab" aria-selected="false" data-pantheon-lens="cards">▤ Cards</button>
            <button type="button" class="pantheon-lens" role="tab" aria-selected="false" data-pantheon-lens="timeline">◫ Timeline</button>
            <button type="button" class="pantheon-lens" role="tab" aria-selected="false" data-pantheon-lens="roster">⛨ Roster</button>
          </div>
          <button type="button" class="icon-button pantheon-expand-btn" id="pantheon-expand" title="Expand or restore Conclave stage" aria-label="Expand Conclave stage" aria-pressed="false">⤢</button>
          <button type="button" class="icon-button" id="pantheon-close" title="Close Conclave" aria-label="Close Conclave">×</button>
        </div>
      </header>
      <div class="pantheon-telemetry-bar" id="pantheon-telemetry-bar">
        <span class="pantheon-mode-pill" id="pantheon-mode-pill">Standby</span>
        <div class="pantheon-stat"><span class="pantheon-stat-label">Active</span><strong id="pantheon-stat-active">0</strong></div>
        <div class="pantheon-stat"><span class="pantheon-stat-label">Done</span><strong id="pantheon-stat-done">0</strong></div>
        <div class="pantheon-stat"><span class="pantheon-stat-label">Calls</span><strong id="pantheon-stat-calls">0</strong></div>
        <div class="pantheon-stat"><span class="pantheon-stat-label">Overlaps</span><strong id="pantheon-stat-conflicts">0</strong></div>
        <div class="pantheon-stat hidden" id="pantheon-stat-cost-wrap"><span class="pantheon-stat-label">Cost</span><strong id="pantheon-stat-cost">$0.000</strong></div>
        <div class="pantheon-telemetry-actions">
          <button type="button" class="button button-quiet pantheon-demo-toggle" id="pantheon-demo-btn" title="Preview an interactive multi-agent constellation">Preview Swarm</button>
        </div>
      </div>
      <div class="pantheon-replay-bar hidden" id="pantheon-replay-bar" aria-label="Conclave Time-Travel Replay">
        <button type="button" class="button button-quiet pantheon-replay-btn" id="pantheon-replay-toggle">▶ Replay 4×</button>
        <input type="range" class="pantheon-replay-scrub" id="pantheon-replay-scrub" min="0" max="100" value="100" aria-label="Scrub replay timeline">
        <span class="pantheon-replay-time" id="pantheon-replay-time">LIVE</span>
      </div>
      <div class="pantheon-approval-strip hidden" id="pantheon-approval-strip" role="alert">
        <div class="pantheon-approval-copy">
          <span class="pantheon-approval-badge">Approval Needed</span>
          <code id="pantheon-approval-tool"></code>
          <span id="pantheon-approval-reason"></span>
        </div>
        <div class="pantheon-approval-btns">
          <button type="button" class="button button-primary" data-pantheon-approve="once">Allow once</button>
          <button type="button" class="button button-danger" data-pantheon-approve="deny">Deny</button>
        </div>
      </div>
      <div class="pantheon-stage-body">
        <section class="pantheon-view pantheon-stage-view" id="pantheon-view-stage" role="tabpanel">
          <canvas id="pantheon-canvas" class="pantheon-canvas" aria-label="Interactive multi-agent constellation stage"></canvas>
          <div class="pantheon-standby-bar hidden" id="pantheon-standby-bar">
            <p class="pantheon-standby-copy">Launch a parallel specialist squad, forge custom benchmarked agents, or race frontier models head-to-head.</p>
            <div class="pantheon-presets">
              <button type="button" class="button button-primary" data-pantheon-preset="research">✦ Parallel Research Squad</button>
              <button type="button" class="button button-secondary" data-pantheon-preset="roster">⛨ Agent Builder &amp; Roster</button>
              <button type="button" class="button button-secondary" data-pantheon-preset="arena">⚡ Head-to-Head Arena</button>
            </div>
            <div class="pantheon-standby-formations hidden" id="pantheon-standby-formations"></div>
          </div>
          <div class="pantheon-diff-actions hidden" id="pantheon-diff-actions"></div>
          <div class="pantheon-live-ticker hidden" id="pantheon-live-ticker" aria-label="Live latent activity feed"></div>
          <div class="pantheon-legend" id="pantheon-legend">
            <span><i class="p-dot p-dot-violet"></i>Streaming</span>
            <span><i class="p-dot p-dot-amber"></i>Tool</span>
            <span><i class="p-dot p-dot-gold"></i>GODMODƎ</span>
            <span><i class="p-dot p-dot-sage"></i>Verified</span>
            <span class="pantheon-legend-hint">Click any node to inspect or steer</span>
          </div>
        </section>
        <section class="pantheon-view pantheon-cards-view hidden" id="pantheon-view-cards" role="tabpanel"></section>
        <section class="pantheon-view pantheon-timeline-view hidden" id="pantheon-view-timeline" role="tabpanel">
          <canvas id="pantheon-timeline-canvas" class="pantheon-timeline-canvas" aria-label="Parallel worker execution timeline"></canvas>
          <div class="pantheon-timeline-empty hidden" id="pantheon-timeline-empty">No worker runs recorded yet. Launch a squad or click <strong>Preview Swarm</strong> above.</div>
        </section>
        <section class="pantheon-view pantheon-roster-view hidden" id="pantheon-view-roster" role="tabpanel"></section>
      </div>
      <section class="pantheon-inspector hidden" id="pantheon-inspector" aria-label="Worker inspector">
        <header class="pantheon-inspector-head">
          <div class="pantheon-inspector-title">
            <span class="pantheon-role-chip" id="pi-role">explore</span>
            <strong id="pi-model">Model</strong>
            <span class="pantheon-status-pill" id="pi-status">Streaming</span>
          </div>
          <button type="button" class="icon-button" id="pi-close" aria-label="Close worker inspector">×</button>
        </header>
        <div class="pantheon-inspector-meta" id="pi-meta"></div>
        <div class="pantheon-inspector-files hidden" id="pi-files"></div>
        <pre class="pantheon-inspector-output" id="pi-output"></pre>
        <form class="pantheon-steer-form" id="pi-steer-form" autocomplete="off">
          <input type="text" id="pi-steer-input" placeholder="Steer this worker or redirect its focus…" aria-label="Steer worker" maxlength="1000">
          <button type="submit" class="button button-primary">Steer →</button>
        </form>
      </section>
    `;

    dock.addEventListener('click', (e) => {
      const lensBtn = e.target.closest('[data-pantheon-lens]');
      if (lensBtn) { setLens(lensBtn.dataset.pantheonLens); return; }
      if (e.target.closest('#pantheon-close')) { close(); return; }
      if (e.target.closest('#pantheon-expand')) { toggleExpand(); return; }
      if (e.target.closest('#pi-close')) { selectWorker(null); return; }
      if (e.target.closest('#pantheon-demo-btn')) { toggleDemo(); return; }
      if (e.target.closest('#pantheon-replay-toggle')) { toggleReplay(); return; }
      const preset = e.target.closest('[data-pantheon-preset]');
      if (preset) { triggerPreset(preset.dataset.pantheonPreset); return; }
      const formLaunch = e.target.closest('[data-formation-launch]');
      if (formLaunch) { deployFormation(formLaunch.dataset.formationLaunch); return; }
      const formDel = e.target.closest('[data-formation-delete]');
      if (formDel) { e.stopPropagation(); deleteFormation(formDel.dataset.formationDelete); return; }
      const adoptBtn = e.target.closest('[data-diff-adopt]');
      if (adoptBtn) { adoptDiffCandidate(adoptBtn.dataset.diffWt, adoptBtn.dataset.diffAdopt); return; }
      const cardBtn = e.target.closest('[data-pantheon-select]');
      if (cardBtn) { selectWorker(cardBtn.dataset.pantheonSelect); return; }
      const tickerRow = e.target.closest('[data-ticker-select]');
      if (tickerRow) { selectWorker(tickerRow.dataset.tickerSelect); return; }
      const approveBtn = e.target.closest('[data-pantheon-approve]');
      if (approveBtn) { resolveApprovalFromPantheon(approveBtn.dataset.pantheonApprove); return; }
      if (e.target.closest('#roster-forge-new')) { openBuilder(null); return; }
      if (e.target.closest('#roster-deploy-squad')) { deploySelectedSquad(); return; }
      if (e.target.closest('#roster-save-formation-toggle')) { formationFormOpen = !formationFormOpen; renderRosterView(); return; }
      if (e.target.closest('#rf-cancel')) { formationFormOpen = false; renderRosterView(); return; }
      const harnessChip = e.target.closest('[data-roster-harness]');
      if (harnessChip) { openBuilderForHarness(harnessChip.dataset.rosterHarness); return; }
      const archBtn = e.target.closest('[data-pb-archetype]');
      if (archBtn) { applyArchetypeToDraft(archBtn.dataset.pbArchetype); return; }
      const sigilBtn = e.target.closest('[data-pb-sigil]');
      if (sigilBtn && builderDraft) { builderDraft.sigil = sigilBtn.dataset.pbSigil; renderRosterView(); return; }
      if (e.target.closest('#pb-best-fit')) { applyBestFitEngine(); return; }
      if (e.target.closest('#pb-cancel')) { builderOpen = false; renderRosterView(); return; }
      if (e.target.closest('#pb-delete') && builderDraft?.slug) { deleteRosterAgent(builderDraft.slug); return; }
      const editAg = e.target.closest('[data-roster-edit]');
      if (editAg) { openBuilder(editAg.dataset.rosterEdit); return; }
      const sqBtn = e.target.closest('[data-roster-squad]');
      if (sqBtn) { toggleSquadMember(sqBtn.dataset.rosterSquad); return; }
      const spawnAg = e.target.closest('[data-roster-spawn]');
      if (spawnAg) { deploySingleAgent(spawnAg.dataset.rosterSpawn); return; }
    });

    dock.addEventListener('change', (e) => {
      if (!builderOpen || !builderDraft) return;
      if (e.target.id === 'pb-engine') {
        const val = e.target.value || '';
        if (val.startsWith('api::')) {
          builderDraft.engineType = 'api';
          builderDraft.providerId = val.slice(5);
          builderDraft.harnessId = null;
        } else if (val.startsWith('harness::')) {
          builderDraft.engineType = 'harness';
          builderDraft.harnessId = val.slice(9);
          const h = (rosterData?.harnesses || []).find(x => x.id === builderDraft.harnessId);
          builderDraft.providerId = h?.providerId || null;
        } else if (val === 'custom_cli') {
          builderDraft.engineType = 'custom_cli';
          builderDraft.providerId = null;
          builderDraft.harnessId = null;
        } else {
          builderDraft.engineType = 'api';
          builderDraft.providerId = null;
          builderDraft.harnessId = null;
        }
        refreshBuilderStats();
        return;
      }
      if (e.target.id === 'pb-primary') { builderDraft.primarySpecialty = e.target.value; refreshBuilderStats(); return; }
      if (e.target.id === 'pb-secondary') { builderDraft.secondarySpecialty = e.target.value; refreshBuilderStats(); return; }
      if (e.target.id === 'pb-autonomy') { builderDraft.autonomy = e.target.value; return; }
      if (e.target.id === 'pb-effort') { builderDraft.effort = e.target.value; return; }
    });

    dock.addEventListener('input', (e) => {
      if (e.target.id === 'pantheon-replay-scrub') {
        replayPlaying = false;
        replayProgress = Math.max(0, Math.min(100, Number(e.target.value) || 0));
        updateReplayBar();
        renderLiveTicker();
        if (activeLens === 'stage') drawStage();
        if (activeLens === 'timeline') drawTimeline();
      }
    });

    dock.addEventListener('submit', (e) => {
      if (e.target.id === 'pb-form') {
        e.preventDefault();
        saveBuilderAgent();
      } else if (e.target.id === 'rf-form') {
        e.preventDefault();
        saveFormationFromForm();
      }
    });

    dock.querySelector('#pi-steer-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = dock.querySelector('#pi-steer-input');
      const msg = (input?.value || '').trim();
      if (!msg || !selectedWorkerId) return;
      if (demoMode) {
        const w = (data?.workers || []).find(x => x.workerId === selectedWorkerId);
        if (w) {
          w.streamTail = `${w.streamTail || ''}\n[Operator steer] ${msg}`.trim();
          w.summary = w.streamTail;
        }
        input.value = '';
        renderInspector();
        renderCards();
        if (typeof window.toast === 'function') window.toast(`Steered ${selectedWorkerId} (demo).`);
        return;
      }
      if (!currentTaskId) return;
      try {
        const res = await fetch(`/api/tasks/${encodeURIComponent(currentTaskId)}/pantheon/steer`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
          body: JSON.stringify({ workerId: selectedWorkerId, message: msg }),
        });
        if (!res.ok) throw new Error('Failed to steer worker.');
        const json = await res.json();
        input.value = '';
        if (json.pantheon) { data = json.pantheon; renderAll(); }
        if (typeof window.toast === 'function') window.toast(`Steer sent to ${selectedWorkerId}.`);
      } catch (err) {
        if (typeof window.toast === 'function') window.toast(err.message || 'Steer failed.');
      }
    });

    const stageCanvas = dock.querySelector('#pantheon-canvas');
    stageCanvas?.addEventListener('mousemove', (e) => {
      const rect = stageCanvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const hit = stageHitTargets.find(t => Math.hypot(mx - t.x, my - t.y) <= t.r + 6);
      const nextId = hit ? hit.workerId : null;
      if (nextId !== hoveredWorkerId) {
        hoveredWorkerId = nextId;
        stageCanvas.classList.toggle('is-pointer', Boolean(nextId));
        if (motionReduced()) drawStage();
      }
    });
    stageCanvas?.addEventListener('click', (e) => {
      const rect = stageCanvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const hit = stageHitTargets.find(t => Math.hypot(mx - t.x, my - t.y) <= t.r + 8);
      if (hit) {
        selectWorker(hit.workerId);
      }
    });

    const tlCanvas = dock.querySelector('#pantheon-timeline-canvas');
    tlCanvas?.addEventListener('click', (e) => {
      const rect = tlCanvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const hit = timelineHitTargets.find(t => mx >= t.x && mx <= t.x + t.w && my >= t.y && my <= t.y + t.h);
      if (hit) selectWorker(hit.workerId);
    });

    window.addEventListener('resize', () => {
      if (!isOpenState) return;
      if (activeLens === 'stage') drawStage();
      if (activeLens === 'timeline') drawTimeline();
    });

    return dock;
  }

  async function resolveApprovalFromPantheon(decision) {
    if (!currentTaskId || !data?.pendingApproval) return;
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(currentTaskId)}/approval`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
        body: JSON.stringify({ decision, resume: true }),
      });
      if (!res.ok) throw new Error('Approval action failed.');
      if (typeof window.toast === 'function') window.toast(decision === 'deny' ? 'Denied — resuming with feedback.' : 'Allowed once — resuming.');
      await loadSnapshot(currentTaskId);
      if (typeof window.refresh === 'function') window.refresh();
    } catch (err) {
      if (typeof window.toast === 'function') window.toast(err.message);
    }
  }

  function triggerPreset(preset) {
    if (preset === 'roster') {
      setLens('roster');
      openBuilder(null);
      return;
    }
    const input = document.getElementById('composer-input');
    if (preset === 'research') {
      const prompt = 'Use parallel agent.spawn subagents (explore, reviewer, and uncensored) to simultaneously map the architecture, audit for bugs/security edge cases, and synthesize a concrete action plan.';
      if (input) {
        input.value = prompt;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
      }
      if (typeof window.toast === 'function') window.toast('Parallel Research Squad prompt ready in composer — press Enter to launch.');
      return;
    }
    if (preset === 'crew') {
      const crewBtn = document.querySelector('#task-controls [data-crew-action="start"]');
      if (crewBtn && !crewBtn.disabled) {
        crewBtn.click();
        return;
      }
      if (input) {
        input.value = 'Coordinate a build-and-review pass: spawn an explore subagent to locate target files, implement the changes cleanly, then spawn a reviewer subagent to audit the diff before concluding.';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
      }
      if (typeof window.toast === 'function') window.toast('Code & Review workflow loaded into composer (or attach checks to run an isolated Coding Crew).');
      return;
    }
    if (preset === 'arena') {
      if (typeof window.openSettings === 'function') window.openSettings('models', { subtab: 'routing' });
      else if (typeof window.toast === 'function') window.toast('Open Settings → Models → Routing & Arena to configure Head-to-Head Arena.');
    }
  }

  function buildDemoState(tick = 0) {
    const now = Date.now();
    const base = now - 14000;
    const cycle = tick % 6;
    if (cycle === 5) {
      // Showcase Head-to-Head Arena Race mode on cycle 5!
      return {
        taskId: 'demo',
        title: 'Conclave Preview · Ultra-Plinian Arena',
        status: 'completed',
        mode: 'arena',
        orchestrator: { modelLabel: 'Ultra-Plinian Router', status: 'completed', calls: 3, maxCalls: 250, recoveries: 0 },
        workers: [],
        arena: {
          raceId: 'demo-race-1',
          status: 'completed',
          winnerId: 'gemini:gemini-4-neon',
          contenders: [
            { slot: 'A', providerId: 'gemini:gemini-4-neon', label: 'Gemini 4 Neon', status: 'completed', durationMs: 4120, isWinner: true, grade: { id: 'A', fidelity: 5, completeness: 5, clarity: 5, total: 15, reason: 'Deepest architectural precision and zero-dependency implementation.' } },
            { slot: 'B', providerId: 'openrouter:claude-sonnet-5.5', label: 'Claude Sonnet 5.5', status: 'completed', durationMs: 4860, isWinner: false, grade: { id: 'B', fidelity: 5, completeness: 4, clarity: 5, total: 14, reason: 'Clean structure, slightly less thorough on edge cases.' } },
          ],
          judge: { providerId: 'venice:hermes-4-405b', label: 'Hermes 4 405B', status: 'completed' },
          note: 'Blind judge awarded Contender A (15/15 vs 14/15).',
        },
        failovers: [],
        fileConflicts: [],
        pendingApproval: null,
        stats: { totalWorkers: 3, activeWorkers: 0, completedWorkers: 3, failedWorkers: 0, totalCalls: 3 },
      };
    }
    const w1Status = cycle >= 3 ? 'completed' : cycle >= 1 ? 'tool' : 'streaming';
    const w2Status = cycle >= 4 ? 'completed' : cycle === 2 ? 'recovering' : 'streaming';
    const w3Status = cycle >= 4 ? 'completed' : cycle >= 2 ? 'tool' : 'thinking';
    return {
      taskId: 'demo',
      title: 'Conclave Live Preview',
      status: cycle >= 4 ? 'completed' : 'running',
      mode: 'swarm',
      orchestrator: { modelLabel: 'Gemini 4 Neon', status: cycle >= 4 ? 'completed' : 'running', calls: 5 + cycle, maxCalls: 250, recoveries: cycle >= 2 ? 1 : 0 },
      workers: [
        {
          workerId: 'demo-explore', kind: 'subagent', role: 'explore',
          modelLabel: 'Gemini 4 Neon', status: w1Status,
          tool: w1Status === 'tool' ? 'repo.search' : '', target: 'src/runtime.mjs',
          files: ['src/runtime.mjs', 'src/providers.mjs'], tools: ['repo.glob', 'repo.search', 'repo.read'],
          calls: 2, approxTokens: 1420, estimatedCostUsd: 0.0021, isMvp: cycle >= 4,
          startedAt: new Date(base).toISOString(), endedAt: w1Status === 'completed' ? new Date(base + 6200).toISOString() : null,
          durationMs: w1Status === 'completed' ? 6200 : 3200 + cycle * 900,
          streamTail: 'Mapped tool dispatch loop in src/runtime.mjs:1169 and Gemini wire serializer in src/providers.mjs:442.',
          summary: 'Mapped tool dispatch loop in src/runtime.mjs:1169 and Gemini wire serializer in src/providers.mjs:442. Found 2 parallelizable batch paths.',
        },
        {
          workerId: 'demo-reviewer', kind: 'subagent', role: 'reviewer',
          modelLabel: 'Claude Sonnet 5.5', status: w2Status,
          tool: w2Status === 'tool' ? 'git.diff' : '', target: 'src/runtime.mjs',
          files: ['src/runtime.mjs', 'src/server.mjs'], tools: ['git.diff', 'repo.read'],
          calls: 2, approxTokens: 1680, estimatedCostUsd: 0.0054, isMvp: false,
          startedAt: new Date(base + 400).toISOString(), endedAt: w2Status === 'completed' ? new Date(base + 9800).toISOString() : null,
          durationMs: w2Status === 'completed' ? 9400 : 2900 + cycle * 1100,
          streamTail: w2Status === 'recovering' ? 'GODMODƎ surge: switching fallback route after transient 429…' : 'Audited SSE cleanup on disconnect and verified zero inline style= CSP compliance.',
          summary: 'Audited SSE cleanup on disconnect and verified zero inline style= CSP compliance across public/pantheon.js and public/settings.js.',
        },
        {
          workerId: 'demo-verifier', kind: 'subagent', role: 'verifier',
          modelLabel: 'Hermes 4 405B', status: w3Status,
          tool: w3Status === 'tool' ? 'repo.read' : '', target: 'test/pantheon.test.mjs',
          files: ['test/pantheon.test.mjs'], tools: ['repo.read'],
          calls: 1, approxTokens: 980, estimatedCostUsd: 0.0018, isMvp: false,
          startedAt: new Date(base + 900).toISOString(), endedAt: w3Status === 'completed' ? new Date(base + 11200).toISOString() : null,
          durationMs: w3Status === 'completed' ? 10300 : 2200 + cycle * 1200,
          streamTail: 'Verifying parallel agent.spawn fan-out assertions and headless Chromium stage rendering…',
          summary: 'All parallel fan-out assertions, SSE worker telemetry streams, and Pantheon canvas hit-tests verified green.',
        },
      ],
      arena: null,
      failovers: cycle >= 2 ? [{ type: 'model.switched', at: new Date(base + 4000).toISOString(), from: 'primary', to: 'fallback', reason: 'GODMODƎ recovery' }] : [],
      fileConflicts: [{ file: 'src/runtime.mjs', owners: [{ workerId: 'demo-explore', role: 'explore' }, { workerId: 'demo-reviewer', role: 'reviewer' }] }],
      pendingApproval: null,
      stats: {
        totalWorkers: 3,
        activeWorkers: [w1Status, w2Status, w3Status].filter(s => s !== 'completed').length,
        completedWorkers: [w1Status, w2Status, w3Status].filter(s => s === 'completed').length,
        failedWorkers: 0,
        totalCalls: 5 + cycle,
        totalTokens: 4080,
        totalCostUsd: 0.0093,
      },
    };
  }

  function startDemo(initialTick = 1) {
    stopDemo();
    demoMode = true;
    replayPlaying = false;
    replayProgress = 100;
    let tick = initialTick;
    data = buildDemoState(tick);
    if (!selectedWorkerId && data.workers[0]) selectedWorkerId = null;
    updateDemoButton();
    renderAll();
    if (!motionReduced()) {
      demoTimer = setInterval(() => {
        if (!demoMode || !isOpenState) return;
        tick += 1;
        data = buildDemoState(tick);
        renderAll();
      }, 2800);
    }
  }

  function stopDemo() {
    demoMode = false;
    if (demoTimer) { clearInterval(demoTimer); demoTimer = null; }
    updateDemoButton();
  }

  function toggleDemo() {
    if (demoMode) {
      stopDemo();
      if (currentTaskId) loadSnapshot(currentTaskId);
      else { data = null; renderAll(); }
    } else {
      startDemo(1);
    }
  }

  function updateDemoButton() {
    const btn = document.getElementById('pantheon-demo-btn');
    if (!btn) return;
    btn.textContent = demoMode ? 'Exit Demo' : 'Preview';
    btn.classList.toggle('is-active', demoMode);
  }

  function toggleExpand() {
    isExpanded = !isExpanded;
    const dock = dockEl();
    dock?.classList.toggle('is-expanded', isExpanded);
    const btn = document.getElementById('pantheon-expand');
    if (btn) btn.setAttribute('aria-pressed', String(isExpanded));
    requestAnimationFrame(() => {
      if (activeLens === 'stage') drawStage();
      if (activeLens === 'timeline') drawTimeline();
    });
  }

  function setLens(lens) {
    activeLens = ['stage', 'cards', 'timeline', 'roster'].includes(lens) ? lens : 'stage';
    const dock = dockEl();
    if (!dock) return;
    dock.querySelectorAll('[data-pantheon-lens]').forEach(btn => {
      const on = btn.dataset.pantheonLens === activeLens;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', String(on));
    });
    dock.querySelector('#pantheon-view-stage')?.classList.toggle('hidden', activeLens !== 'stage');
    dock.querySelector('#pantheon-view-cards')?.classList.toggle('hidden', activeLens !== 'cards');
    dock.querySelector('#pantheon-view-timeline')?.classList.toggle('hidden', activeLens !== 'timeline');
    dock.querySelector('#pantheon-view-roster')?.classList.toggle('hidden', activeLens !== 'roster');
    if (activeLens === 'stage') drawStage();
    if (activeLens === 'cards') renderCards();
    if (activeLens === 'timeline') drawTimeline();
    if (activeLens === 'roster') loadRoster();
    updateReplayBar();
  }

  function selectWorker(workerId) {
    selectedWorkerId = workerId || null;
    renderInspector();
    if (activeLens === 'stage') drawStage();
    if (activeLens === 'cards') renderCards();
  }

  function canReplay(src = data) {
    if (!src) return false;
    if (src.mode === 'arena' && src.arena?.status === 'completed') return true;
    if ((src.workers || []).length > 0 && (src.stats?.activeWorkers || 0) === 0) return true;
    return false;
  }

  function toggleReplay() {
    if (!canReplay()) return;
    if (replayPlaying) {
      replayPlaying = false;
    } else {
      if (replayProgress >= 99) replayProgress = 0;
      replayPlaying = true;
    }
    updateReplayBar();
    if (activeLens === 'stage') drawStage();
    if (activeLens === 'timeline') drawTimeline();
  }

  function updateReplayBar() {
    const bar = document.getElementById('pantheon-replay-bar');
    if (!bar) return;
    const show = canReplay() && (activeLens === 'stage' || activeLens === 'timeline');
    bar.classList.toggle('hidden', !show);
    if (!show) return;
    const btn = document.getElementById('pantheon-replay-toggle');
    if (btn) {
      btn.textContent = replayPlaying ? '❚❚ Pause' : (replayProgress < 100 ? '▶ Resume 4×' : '▶ Replay 4×');
      btn.classList.toggle('is-active', replayPlaying);
    }
    const scrub = document.getElementById('pantheon-replay-scrub');
    if (scrub) scrub.value = String(Math.round(replayProgress));
    const timeEl = document.getElementById('pantheon-replay-time');
    if (timeEl) {
      if (replayProgress >= 100 && !replayPlaying) {
        timeEl.textContent = 'DONE · 4×';
      } else {
        const span = computeReplaySpanMs(data);
        timeEl.textContent = `${fmtMs((replayProgress / 100) * span)} / ${fmtMs(span)} · 4×`;
      }
    }
  }

  function computeReplaySpanMs(src) {
    if (!src) return 4000;
    if (src.mode === 'arena' && src.arena?.contenders?.length) {
      return Math.max(1500, ...src.arena.contenders.map(c => c.durationMs || 2000));
    }
    const ws = src.workers || [];
    if (!ws.length) return 4000;
    const starts = ws.map(w => w.startedAt ? Date.parse(w.startedAt) : 0);
    const ends = ws.map((w, i) => w.endedAt ? Date.parse(w.endedAt) : starts[i] + Math.max(800, w.durationMs || 2000));
    return Math.max(1200, Math.max(...ends) - Math.min(...starts));
  }

  function getEffectiveData() {
    if (!data || !canReplay(data) || (replayProgress >= 100 && !replayPlaying)) return data;
    const frac = Math.max(0, Math.min(1, replayProgress / 100));
    if (data.mode === 'arena' && data.arena) {
      const contenders = (data.arena.contenders || []).map((c) => {
        const maxD = Math.max(1000, ...(data.arena.contenders || []).map(x => x.durationMs || 2000));
        const ratio = Math.min(1, (frac * maxD * 1.12) / Math.max(600, c.durationMs || 2000));
        const revealed = frac >= 0.88;
        return {
          ...c,
          _replayProg: ratio,
          _replayGradeRevealed: revealed,
          status: ratio >= 1 ? c.status : 'streaming',
          isWinner: revealed ? c.isWinner : false,
        };
      });
      return {
        ...data,
        arena: {
          ...data.arena,
          contenders,
          winnerId: frac >= 0.88 ? data.arena.winnerId : null,
          note: frac >= 0.88 ? data.arena.note : (frac >= 0.65 ? 'Blind judge evaluating fidelity, completeness & clarity…' : 'Contenders drafting independently in parallel…'),
          judge: data.arena.judge ? { ...data.arena.judge, status: frac >= 0.88 ? 'completed' : frac >= 0.65 ? 'grading' : 'waiting' } : null,
        },
      };
    }
    const ws = data.workers || [];
    if (!ws.length) return data;
    const times = ws.map(wk => {
      const s = wk.startedAt ? Date.parse(wk.startedAt) : 0;
      const e = wk.endedAt ? Date.parse(wk.endedAt) : s + Math.max(800, wk.durationMs || 2000);
      return { s, e };
    });
    const minT = Math.min(...times.map(t => t.s));
    const maxT = Math.max(...times.map(t => t.e), minT + 1000);
    const cursorT = minT + frac * (maxT - minT);
    const projected = ws.map((wk, idx) => {
      const { s, e } = times[idx];
      if (cursorT < s) return { ...wk, status: 'queued', tool: '', isMvp: false, _replayFrac: 0 };
      if (cursorT >= e || frac >= 0.995) return { ...wk, _replayFrac: 1 };
      const localP = (cursorT - s) / Math.max(1, e - s);
      const status = localP < 0.2 ? 'thinking' : (localP < 0.65 && wk.tools?.length) ? 'tool' : 'streaming';
      const tool = status === 'tool' ? (wk.tools[Math.min(wk.tools.length - 1, Math.floor(localP * wk.tools.length))] || wk.tool || 'tool') : '';
      return { ...wk, status, tool, isMvp: false, _replayFrac: localP };
    });
    return { ...data, workers: projected, _replayCursorFrac: frac };
  }

  function startLoop() {
    if (rafId !== null) return;
    lastFrameMs = performance.now();
    const tick = (now) => {
      if (!isOpenState) { rafId = null; return; }
      const dt = Math.min(0.05, (now - lastFrameMs) / 1000);
      lastFrameMs = now;
      if (replayPlaying) {
        const spanSec = Math.max(1.2, computeReplaySpanMs(data) / 1000);
        const speedPctPerSec = Math.max(18, Math.min(55, (400 / spanSec)));
        replayProgress = Math.min(100, replayProgress + dt * speedPctPerSec);
        if (replayProgress >= 100) replayPlaying = false;
        updateReplayBar();
        renderLiveTicker();
        if (activeLens === 'stage') drawStage();
        if (activeLens === 'timeline') drawTimeline();
      } else if (!motionReduced()) {
        animPhase = (animPhase + dt * 0.72) % 1000;
        if (activeLens === 'stage') drawStage();
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
  }

  function open(options = {}) {
    const dock = ensureShell();
    if (!dock) return;
    // Hide artifact dock if open so split-screen stays spacious
    const artDock = document.getElementById('artifact-dock');
    const artSplit = document.getElementById('artifact-splitter');
    if (artDock && !artDock.classList.contains('hidden')) {
      artDock.classList.add('hidden');
      artSplit?.classList.add('hidden');
    }
    isOpenState = true;
    dock.classList.remove('hidden');
    document.body.classList.add('pantheon-open');
    if (options.lens) setLens(options.lens);
    if (options.demo) startDemo(options.demoTick ?? 1);
    else if (currentTaskId && !demoMode) loadSnapshot(currentTaskId);
    else renderAll();
    updateHeaderBadge();
    startLoop();
  }

  function close() {
    isOpenState = false;
    stopLoop();
    const dock = dockEl();
    if (dock) {
      dock.classList.add('hidden');
      dock.classList.remove('is-expanded');
    }
    isExpanded = false;
    document.body.classList.remove('pantheon-open');
    updateHeaderBadge();
  }

  function toggle(options = {}) {
    if (isOpenState) close();
    else open(options);
  }

  function updateHeaderBadge() {
    const btn = document.getElementById('pantheon-toggle-btn');
    if (!btn) return;
    btn.classList.toggle('is-open', isOpenState);
    btn.setAttribute('aria-pressed', String(isOpenState));
    const badge = btn.querySelector('.pantheon-btn-count');
    if (!badge) return;
    const active = data?.stats?.activeWorkers || 0;
    const total = data?.stats?.totalWorkers || (data?.arena?.contenders?.length || 0);
    if (active > 0) {
      badge.textContent = String(active);
      badge.className = 'pantheon-btn-count is-live';
    } else if (total > 0) {
      badge.textContent = String(total);
      badge.className = 'pantheon-btn-count';
    } else {
      badge.textContent = '';
      badge.className = 'pantheon-btn-count hidden';
    }
  }

  function renderStandbyFormations() {
    const wrap = document.getElementById('pantheon-standby-formations');
    if (!wrap) return;
    const formations = rosterData?.formations || [];
    wrap.classList.toggle('hidden', !formations.length);
    if (!formations.length) return;
    wrap.innerHTML = `<span class="pantheon-sf-label">Formations</span>${formations.slice(0, 4).map(f => `<button type="button" class="pantheon-formation-chip" data-formation-launch="${esc(f.id)}" title="${esc(`${f.name}: ${f.agents.join(', ')}`)}">${esc(f.sigil || '✦')} ${esc(f.name)} <small>${esc(f.agents.length)}</small></button>`).join('')}`;
  }

  function renderLiveTicker() {
    const el = document.getElementById('pantheon-live-ticker');
    if (!el) return;
    const viewData = getEffectiveData();
    const workers = viewData?.workers || [];
    const show = activeLens === 'stage' && (viewData?.mode === 'swarm' || viewData?.mode === 'crew') && workers.length > 0;
    el.classList.toggle('hidden', !show);
    if (!show) return;
    el.innerHTML = workers.slice(0, 4).map(wk => {
      const st = statusInfo(wk.status);
      const isSel = wk.workerId === selectedWorkerId;
      const actionBadge = wk.status === 'recovering'
        ? '⚡ GODMODƎ surge'
        : wk.tool && st.active
          ? `⌁ ${wk.tool}${wk.target ? ` ${wk.target.split('/').pop()}` : ''}`
          : wk.isMvp
            ? '★ MVP'
            : st.label;
      const thought = String(wk.streamTail || wk.summary || wk.prompt || 'Reasoning in latent space…').replace(/\s+/g, ' ').slice(0, 88);
      return `<button type="button" class="plt-row tone-${st.tone} ${isSel ? 'is-selected' : ''}" data-ticker-select="${esc(wk.workerId)}" title="Click to inspect &amp; steer ${esc(wk.role)}">
        <i class="plt-dot ${st.active ? 'is-pulsing' : ''}"></i>
        <span class="plt-role">${esc(wk.role)}</span>
        <span class="plt-phase">${esc(actionBadge)}</span>
        <span class="plt-thought">${esc(thought)}</span>
        <span class="plt-time">${fmtMs(wk.durationMs)}</span>
      </button>`;
    }).join('');
  }

  function renderDiffActionsBar() {
    const bar = document.getElementById('pantheon-diff-actions');
    if (!bar) return;
    const race = data?.worktreeRace;
    const show = Boolean(race?.candidates?.length) && activeLens === 'stage';
    bar.classList.toggle('hidden', !show);
    if (!show) return;
    const applied = race.appliedCandidateId;
    bar.innerHTML = `<div class="pda-head"><strong>Code Diff Race</strong><span>${esc(race.repository)} · ${esc(race.branch)}</span>${race.lastCheck ? `<span class="pantheon-status-pill tone-${race.lastCheck.ok ? 'sage' : 'coral'}">${race.lastCheck.ok ? 'Checks ✓' : 'Checks ✗'}</span>` : ''}</div><div class="pda-btns">${race.candidates.map(c => {
      const isApplied = applied === c.id;
      const canAdopt = c.status === 'ready' && !applied;
      return `<button type="button" class="button ${isApplied ? 'button-primary' : 'button-secondary'} pda-btn" data-diff-wt="${esc(race.worktreeId)}" data-diff-adopt="${esc(c.id)}" ${canAdopt ? '' : 'disabled'}>${isApplied ? '✓ Adopted' : c.status === 'failed' ? '✗ Failed' : `✓ Adopt ${esc(c.slot)} (+${c.additions}/-${c.deletions})`}</button>`;
    }).join('')}</div>`;
  }

  async function adoptDiffCandidate(worktreeId, candidateId) {
    if (!worktreeId || !candidateId) return;
    try {
      const res = await fetch(`/api/worktrees/${encodeURIComponent(worktreeId)}/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
        body: JSON.stringify({ candidateId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not apply patch.');
      if (typeof window.toast === 'function') window.toast('✓ Winner patch adopted cleanly into worktree!');
      if (currentTaskId) await loadSnapshot(currentTaskId);
      if (typeof window.refresh === 'function') window.refresh();
    } catch (err) {
      if (typeof window.toast === 'function') window.toast(err.message || 'Patch apply failed.');
    }
  }

  function renderAll() {
    if (!dockEl()?.dataset.pantheonInit) return;
    const mode = data?.mode || 'standby';
    const modeLabels = { arena: 'Arena Race', crew: 'Coding Crew', swarm: 'Constellation', diff_race: 'Diff Race', standby: 'Standby' };
    const pill = document.getElementById('pantheon-mode-pill');
    if (pill) {
      pill.textContent = demoMode ? `${modeLabels[mode] || 'Preview'} · Demo` : (modeLabels[mode] || 'Standby');
      pill.className = `pantheon-mode-pill mode-${mode}`;
    }
    const sub = document.getElementById('pantheon-subtitle');
    if (sub) {
      sub.textContent = data?.title
        ? `${data.title} · ${data.orchestrator?.modelLabel ? shortModel(data.orchestrator.modelLabel) : 'Orchestrator'}`
        : 'Multi-Agent Council & Arena Stage';
    }
    const setT = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = String(v); };
    setT('pantheon-stat-active', data?.stats?.activeWorkers ?? 0);
    setT('pantheon-stat-done', data?.stats?.completedWorkers ?? 0);
    setT('pantheon-stat-calls', data?.stats?.totalCalls ?? 0);
    setT('pantheon-stat-conflicts', data?.fileConflicts?.length ?? 0);

    // Token / Cost telemetry pill
    const costWrap = document.getElementById('pantheon-stat-cost-wrap');
    if (costWrap) {
      const toks = data?.stats?.totalTokens || 0;
      costWrap.classList.toggle('hidden', toks <= 0);
      if (toks > 0) {
        setT('pantheon-stat-cost', fmtCost(data?.stats?.totalCostUsd));
        costWrap.title = `${fmtCost(data?.stats?.totalCostUsd)} estimated · ${fmtTokens(toks)}`;
      }
    }
    const legendEl = document.getElementById('pantheon-legend');
    if (legendEl) legendEl.classList.toggle('hidden', mode === 'diff_race');

    // Polish trim: only show Preview Swarm in Standby or while Demo is active
    const demoBtn = document.getElementById('pantheon-demo-btn');
    if (demoBtn) demoBtn.classList.toggle('hidden', mode !== 'standby' && !demoMode);

    // Pending approval strip
    const apprStrip = document.getElementById('pantheon-approval-strip');
    if (apprStrip) {
      const appr = data?.pendingApproval;
      apprStrip.classList.toggle('hidden', !appr);
      if (appr) {
        setT('pantheon-approval-tool', appr.tool || 'tool');
        setT('pantheon-approval-reason', appr.target || appr.reason || 'Confirmation required');
      }
    }

    const standbyBar = document.getElementById('pantheon-standby-bar');
    if (standbyBar) {
      standbyBar.classList.toggle('hidden', mode !== 'standby');
      if (mode === 'standby') {
        if (!rosterData) loadRoster(false).then(renderStandbyFormations);
        else renderStandbyFormations();
      }
    }

    updateReplayBar();
    renderDiffActionsBar();
    renderLiveTicker();
    updateHeaderBadge();
    if (activeLens === 'stage') drawStage();
    if (activeLens === 'cards') renderCards();
    if (activeLens === 'timeline') drawTimeline();
    renderInspector();
  }

  function renderCards() {
    const el = document.getElementById('pantheon-view-cards');
    if (!el) return;
    if (data?.mode === 'arena' && data?.arena) {
      const arena = data.arena;
      el.innerHTML = `<div class="pantheon-cards-grid">${(arena.contenders || []).map(c => `
        <article class="pantheon-card ${c.isWinner ? 'is-winner' : ''}">
          <header class="pantheon-card-head">
            <span class="pantheon-role-chip">Contender ${esc(c.slot)}</span>
            <span class="pantheon-status-pill tone-${c.isWinner ? 'gold' : c.status === 'completed' ? 'sage' : 'violet'}">${esc(c.isWinner ? '♛ Winner' : c.status)}</span>
          </header>
          <strong class="pantheon-card-model">${esc(c.label)}</strong>
          <p class="pantheon-card-meta">${fmtMs(c.durationMs)}${c.grade ? ` · Score ${c.grade.total}/15 (F${c.grade.fidelity} C${c.grade.completeness} L${c.grade.clarity})` : ''}</p>
          ${c.grade?.reason ? `<p class="pantheon-card-tail">${esc(c.grade.reason)}</p>` : ''}
        </article>`).join('')}${arena.judge ? `
        <article class="pantheon-card">
          <header class="pantheon-card-head">
            <span class="pantheon-role-chip">Blind Judge</span>
            <span class="pantheon-status-pill tone-amber">${esc(arena.judge.status)}</span>
          </header>
          <strong class="pantheon-card-model">${esc(arena.judge.label)}</strong>
          <p class="pantheon-card-tail">${esc(arena.note || 'Evaluates drafts blindly for fidelity, completeness, and clarity.')}</p>
        </article>` : ''}</div>`;
      return;
    }
    if (data?.mode === 'diff_race' && data?.worktreeRace?.candidates?.length) {
      const race = data.worktreeRace;
      const applied = race.appliedCandidateId;
      el.innerHTML = `<div class="pantheon-cards-grid">${race.candidates.map(c => {
        const isApplied = applied === c.id;
        const canAdopt = c.status === 'ready' && !applied;
        return `<article class="pantheon-card ${isApplied ? 'is-winner' : ''}">
          <header class="pantheon-card-head">
            <span class="pantheon-role-chip">Patch ${esc(c.slot)}</span>
            <span class="pantheon-status-pill tone-${isApplied ? 'gold' : c.status === 'ready' ? 'sage' : c.status === 'failed' ? 'coral' : 'violet'}">${esc(isApplied ? '✓ Adopted' : c.status === 'ready' ? 'Patch Ready' : c.status)}</span>
          </header>
          <strong class="pantheon-card-model">${esc(c.label)}</strong>
          <p class="pantheon-card-meta">+${c.additions} / -${c.deletions} lines · ${fmtMs(c.elapsedMs)}</p>
          ${c.error ? `<p class="pantheon-card-tail">${esc(c.error)}</p>` : ''}
          ${c.files?.length ? `<div class="pantheon-file-chips">${c.files.slice(0, 4).map(f => `<span class="pantheon-file-chip">${esc(f.split('/').pop())}</span>`).join('')}</div>` : ''}
          <footer class="pantheon-card-foot">
            <button type="button" class="button ${isApplied ? 'button-primary' : 'button-secondary'}" data-diff-wt="${esc(race.worktreeId)}" data-diff-adopt="${esc(c.id)}" ${canAdopt ? '' : 'disabled'}>${isApplied ? '✓ Winner Adopted' : '✓ Adopt Winner Patch'}</button>
          </footer>
        </article>`;
      }).join('')}</div>`;
      return;
    }
    const workers = data?.workers || [];
    if (!workers.length) {
      el.innerHTML = '<div class="pantheon-empty-cards"><p>No active or completed workers yet. Switch to <strong>✦ Stage</strong> to launch a Parallel Research Squad or click <strong>Preview Swarm</strong>.</p></div>';
      return;
    }
    const conflictFiles = new Set((data?.fileConflicts || []).map(c => c.file));
    el.innerHTML = `<div class="pantheon-cards-grid">${workers.map(w => {
      const st = statusInfo(w.status);
      const selected = w.workerId === selectedWorkerId;
      const files = (w.files || []).slice(0, 4);
      const snippet = w.streamTail || w.summary || w.prompt || 'Awaiting output…';
      const costBits = w.approxTokens ? ` · ${fmtTokens(w.approxTokens)} · ${fmtCost(w.estimatedCostUsd)}` : '';
      return `<article class="pantheon-card ${selected ? 'is-selected' : ''} ${w.isMvp ? 'is-winner' : ''} tone-${st.tone}">
        <header class="pantheon-card-head">
          <div class="pantheon-card-badges">
            <span class="pantheon-role-chip">${esc(w.role)}</span>
            ${w.isMvp ? '<span class="pantheon-mvp-badge">★ MVP</span>' : ''}
          </div>
          <span class="pantheon-status-pill tone-${st.tone}">${esc(w.tool && st.active ? w.tool : st.label)}</span>
        </header>
        <strong class="pantheon-card-model">${esc(shortModel(w.modelLabel || w.providerId || 'Auto'))}</strong>
        <p class="pantheon-card-meta">${esc(`${w.calls || 0} call${w.calls === 1 ? '' : 's'} · ${fmtMs(w.durationMs)}${costBits}`)}</p>
        <p class="pantheon-card-tail">${esc(snippet.slice(0, 180))}</p>
        ${files.length ? `<div class="pantheon-file-chips">${files.map(f => `<span class="pantheon-file-chip ${conflictFiles.has(f) ? 'is-conflict' : ''}">${esc(f.split('/').pop())}</span>`).join('')}</div>` : ''}
        <footer class="pantheon-card-foot">
          <button type="button" class="button button-secondary" data-pantheon-select="${esc(w.workerId)}">${selected ? 'Inspecting' : 'Inspect & Steer'}</button>
        </footer>
      </article>`;
    }).join('')}</div>`;
  }

  function renderInspector() {
    const panel = document.getElementById('pantheon-inspector');
    if (!panel) return;
    const worker = (data?.workers || []).find(w => w.workerId === selectedWorkerId);
    if (!worker) {
      panel.classList.add('hidden');
      return;
    }
    panel.classList.remove('hidden');
    const st = statusInfo(worker.status);
    const setT = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = String(v); };
    setT('pi-role', worker.role || 'worker');
    setT('pi-model', worker.modelLabel || worker.providerId || 'Auto');
    const stEl = document.getElementById('pi-status');
    if (stEl) { stEl.textContent = worker.tool && st.active ? `${st.label} · ${worker.tool}` : st.label; stEl.className = `pantheon-status-pill tone-${st.tone}`; }
    setT('pi-meta', `${worker.kind === 'crew' ? 'Coding Crew' : worker.viaHarness ? 'External CLI Harness' : 'Specialist Subagent'} · ${worker.calls || 0} calls · ${fmtMs(worker.durationMs)}${worker.approxTokens ? ` · ${fmtTokens(worker.approxTokens)} (${fmtCost(worker.estimatedCostUsd)})` : ''}${worker.isMvp ? ' · ★ MVP' : ''}${worker.tools?.length ? ` · Tools: ${[...new Set(worker.tools)].join(', ')}` : ''}`);
    const filesEl = document.getElementById('pi-files');
    if (filesEl) {
      const files = worker.files || [];
      filesEl.classList.toggle('hidden', files.length === 0);
      filesEl.innerHTML = files.map(f => `<span class="pantheon-file-chip">${esc(f)}</span>`).join('');
    }
    setT('pi-output', worker.summary || worker.streamTail || worker.prompt || 'Working…');
  }

  function prepCanvas(canvas) {
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(260, Math.round(rect.width));
    const h = Math.max(220, Math.round(rect.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  function drawRoundedRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }

  function drawStage() {
    const canvas = document.getElementById('pantheon-canvas');
    const prep = prepCanvas(canvas);
    if (!prep) return;
    const { ctx, w, h } = prep;
    const pal = themePalette();
    stageHitTargets = [];

    ctx.clearRect(0, 0, w, h);

    // Subtle radial atmospheric glow
    const grad = ctx.createRadialGradient(w * 0.5, h * 0.48, 12, w * 0.5, h * 0.48, Math.max(w, h) * 0.62);
    grad.addColorStop(0, pal.isLight ? 'rgba(109, 40, 217, 0.08)' : 'rgba(167, 139, 250, 0.12)');
    grad.addColorStop(0.55, pal.isLight ? 'rgba(21, 128, 61, 0.03)' : 'rgba(74, 222, 128, 0.04)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Subtle dot grid
    ctx.fillStyle = pal.isLight ? 'rgba(24,25,27,0.06)' : 'rgba(255,255,255,0.055)';
    for (let gx = 20; gx < w; gx += 28) {
      for (let gy = 20; gy < h; gy += 28) {
        ctx.fillRect(gx, gy, 1.2, 1.2);
      }
    }

    const viewData = getEffectiveData();
    if (viewData?.mode === 'arena' && viewData?.arena) {
      drawArenaRace(ctx, w, h, pal, viewData.arena);
      return;
    }
    if (viewData?.mode === 'diff_race' && viewData?.worktreeRace) {
      drawDiffRace(ctx, w, h, pal, viewData.worktreeRace);
      return;
    }

    const cx = w * 0.5;
    const hasTicker = (viewData?.mode === 'swarm' || viewData?.mode === 'crew') && (viewData?.workers || []).length > 0;
    const cy = viewData?.mode === 'standby' ? h * 0.35 : hasTicker ? h * 0.38 : h * 0.48;
    const rx = Math.min(w * 0.33, 215);
    const ry = Math.min(h * (hasTicker ? 0.25 : 0.31), hasTicker ? 132 : 148);

    // Latent-space harmonic resonance ripples & soft ambient stardust
    ctx.save();
    for (let ring = 0; ring < 3; ring++) {
      const wave = ((animPhase * 0.28 + ring / 3) % 1);
      const alpha = (1 - wave) * (pal.isLight ? 0.08 : 0.11);
      ctx.strokeStyle = pal.isLight ? `rgba(109, 40, 217, ${alpha.toFixed(3)})` : `rgba(167, 139, 250, ${alpha.toFixed(3)})`;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx * (0.28 + wave * 0.92), ry * (0.28 + wave * 0.92), 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Subtle orbital guides
    ctx.strokeStyle = pal.isLight ? 'rgba(24,25,27,0.10)' : 'rgba(255,255,255,0.09)';
    ctx.setLineDash([4, 6]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx * 0.52, ry * 0.52, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    const workers = (viewData?.workers || []).length
      ? viewData.workers
      : [
          { workerId: '_ghost_1', role: 'explore', modelLabel: 'Standby', status: 'queued', ghost: true },
          { workerId: '_ghost_2', role: 'reviewer', modelLabel: 'Standby', status: 'queued', ghost: true },
          { workerId: '_ghost_3', role: 'verifier', modelLabel: 'Standby', status: 'queued', ghost: true },
        ];

    const coords = new Map();
    const count = workers.length;
    const standbyDrift = workers[0]?.ghost ? Math.sin(animPhase * 0.35) * 0.08 : 0;
    workers.forEach((wk, i) => {
      const angle = -Math.PI / 2 + standbyDrift + (i * Math.PI * 2) / Math.max(1, count);
      const x = cx + Math.cos(angle) * rx;
      const y = cy + Math.sin(angle) * ry;
      coords.set(wk.workerId, { x, y, angle });
    });

    // Soft inter-agent latent attention web (links active peers gently)
    if (!workers[0]?.ghost && workers.length >= 2) {
      ctx.save();
      ctx.strokeStyle = pal.isLight ? 'rgba(109, 40, 217, 0.09)' : 'rgba(167, 139, 250, 0.12)';
      ctx.lineWidth = 1;
      for (let i = 0; i < workers.length; i++) {
        for (let j = i + 1; j < workers.length; j++) {
          const pA = coords.get(workers[i].workerId);
          const pB = coords.get(workers[j].workerId);
          if (!pA || !pB) continue;
          ctx.beginPath();
          ctx.moveTo(pA.x, pA.y);
          ctx.lineTo(pB.x, pB.y);
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    // Labeled shared-file overlap arcs between workers touching the same file
    for (const conflict of (data?.fileConflicts || [])) {
      const a = coords.get(conflict.owners[0]?.workerId);
      const b = coords.get(conflict.owners[1]?.workerId);
      if (a && b) {
        const ctrlX = (a.x + b.x) / 2 + (cx - (a.x + b.x) / 2) * 0.35;
        const ctrlY = (a.y + b.y) / 2 - 22;
        ctx.save();
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.62)';
        ctx.lineWidth = 1.7;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(ctrlX, ctrlY, b.x, b.y);
        ctx.stroke();
        ctx.setLineDash([]);
        // Labeled overlap pill right on arc midpoint
        const midX = 0.25 * a.x + 0.5 * ctrlX + 0.25 * b.x;
        const midY = 0.25 * a.y + 0.5 * ctrlY + 0.25 * b.y;
        const fname = `⚠ ${String(conflict.file || '').split('/').pop()}`.slice(0, 18);
        ctx.font = '600 9px ui-monospace, SFMono-Regular, monospace';
        const fw = ctx.measureText(fname).width + 12;
        ctx.fillStyle = pal.isLight ? 'rgba(255, 251, 235, 0.96)' : 'rgba(34, 24, 12, 0.92)';
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.65)';
        ctx.lineWidth = 1;
        drawRoundedRect(ctx, midX - fw / 2, midY - 8, fw, 16, 8);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = pal.amber;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(fname, midX, midY + 0.5);
        ctx.restore();
      }
    }

    // Draw bi-directional signal conduits + GODMODƎ golden lightning surge
    workers.forEach((wk, idx) => {
      const pos = coords.get(wk.workerId);
      if (!pos) return;
      const st = statusInfo(wk.status);
      const stroke = wk.ghost
        ? (pal.isLight ? 'rgba(24,25,27,0.12)' : 'rgba(255,255,255,0.12)')
        : st.tone === 'gold' ? pal.gold
        : st.tone === 'amber' ? pal.amber
        : st.tone === 'sage' ? pal.sage
        : st.tone === 'coral' ? pal.coral
        : roleColor(wk.role);

      const mx = (cx + pos.x) / 2 + (pos.y - cy) * 0.14;
      const my = (cy + pos.y) / 2 - (pos.x - cx) * 0.14;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.quadraticCurveTo(mx, my, pos.x, pos.y);
      ctx.strokeStyle = stroke;
      ctx.globalAlpha = wk.ghost ? 0.5 : st.active ? 0.68 : 0.36;
      ctx.lineWidth = st.active ? 2.2 : 1.4;
      ctx.stroke();

      // GODMODƎ golden recovery lightning bypass arc
      if (wk.status === 'recovering' && !wk.ghost) {
        ctx.beginPath();
        ctx.globalAlpha = 0.85;
        ctx.strokeStyle = pal.gold;
        ctx.lineWidth = 1.6;
        for (let s = 0; s <= 10; s++) {
          const t = s / 10;
          const u = 1 - t;
          const bx = u * u * cx + 2 * u * t * mx + t * t * pos.x;
          const by = u * u * cy + 2 * u * t * my + t * t * pos.y;
          const jitter = s > 0 && s < 10 ? Math.sin(animPhase * 18 + s * 2.7 + idx) * 6 : 0;
          if (s === 0) ctx.moveTo(bx, by);
          else ctx.lineTo(bx + jitter, by - jitter * 0.7);
        }
        ctx.stroke();
      }

      // Bi-directional travelling luminous energy packets (dispatch out + synthesis return!)
      if (st.active && !wk.ghost) {
        for (let p = 0; p < 2; p++) {
          const tOut = (animPhase * 0.68 + idx * 0.23 + p * 0.5) % 1;
          const u = 1 - tOut;
          const px = u * u * cx + 2 * u * tOut * mx + tOut * tOut * pos.x;
          const py = u * u * cy + 2 * u * tOut * my + tOut * tOut * pos.y;
          ctx.globalAlpha = 0.95;
          ctx.fillStyle = st.tone === 'gold' ? pal.gold : stroke;
          ctx.beginPath();
          ctx.arc(px, py, 3.4, 0, Math.PI * 2);
          ctx.fill();
        }
        // Return insight spark flowing back to GODMODƎ nucleus
        const tBack = 1 - ((animPhase * 0.45 + idx * 0.37) % 1);
        const ub = 1 - tBack;
        const rpx = ub * ub * cx + 2 * ub * tBack * mx + tBack * tBack * pos.x;
        const rpy = ub * ub * cy + 2 * ub * tBack * my + tBack * tBack * pos.y;
        ctx.globalAlpha = 0.72;
        ctx.fillStyle = pal.sage;
        ctx.beginPath();
        ctx.arc(rpx, rpy, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    });

    // Draw Central Orchestrator Nucleus
    const coreR = 40;
    const pulse = 1 + Math.sin(animPhase * 2.4) * 0.08;
    ctx.save();
    const coreHalo = ctx.createRadialGradient(cx, cy, 8, cx, cy, coreR * 1.9 * pulse);
    coreHalo.addColorStop(0, pal.isLight ? 'rgba(109, 40, 217, 0.20)' : 'rgba(167, 139, 250, 0.32)');
    coreHalo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = coreHalo;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR * 1.9 * pulse, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = pal.panel;
    ctx.strokeStyle = pal.violet;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = pal.text;
    ctx.font = '700 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('GODMODƎ', cx, cy - 6);
    ctx.fillStyle = pal.muted;
    ctx.font = '500 9px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(shortModel(data?.orchestrator?.modelLabel || 'Orchestrator').slice(0, 13), cx, cy + 10);
    ctx.restore();

    // Draw Orbiting Worker Nodes
    workers.forEach((wk) => {
      const pos = coords.get(wk.workerId);
      if (!pos) return;
      const st = statusInfo(wk.status);
      const r = wk.ghost ? 25 : 30;
      const isSel = wk.workerId === selectedWorkerId;
      const isHov = wk.workerId === hoveredWorkerId;
      const color = wk.ghost ? pal.muted
        : st.tone === 'sage' ? pal.sage
        : st.tone === 'amber' ? pal.amber
        : st.tone === 'gold' ? pal.gold
        : st.tone === 'coral' ? pal.coral
        : roleColor(wk.role);

      if (!wk.ghost) stageHitTargets.push({ workerId: wk.workerId, x: pos.x, y: pos.y, r });

      ctx.save();
      if (st.active && !wk.ghost) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.45 + 0.3 * Math.sin(animPhase * 4);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r + 6 + Math.sin(animPhase * 4) * 2, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (isSel || isHov) {
        ctx.strokeStyle = pal.text;
        ctx.lineWidth = 1.6;
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r + 9, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.globalAlpha = wk.ghost ? 0.55 : 1;
      ctx.fillStyle = pal.panel;
      ctx.strokeStyle = color;
      ctx.lineWidth = isSel ? 2.6 : 2;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Node glyph
      ctx.fillStyle = color;
      ctx.font = '700 12px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const glyph = wk.ghost ? '◌' : st.tone === 'sage' ? '✓' : st.tone === 'coral' ? '!' : st.tone === 'gold' ? '⚡' : st.tone === 'amber' ? '⌁' : '✦';
      ctx.fillText(glyph, pos.x, pos.y - 4);

      const roleTxt = String(wk.role || 'agent').toUpperCase().slice(0, 11);
      ctx.fillStyle = pal.text;
      ctx.font = roleTxt.length >= 9 ? '600 8px ui-monospace, SFMono-Regular, monospace' : '600 9px ui-monospace, SFMono-Regular, monospace';
      ctx.fillText(roleTxt, pos.x, pos.y + 10);

      // Caption pill beneath node
      const caption = wk.ghost
        ? 'ready'
        : wk.tool && st.active
          ? wk.tool
          : `${shortModel(wk.modelLabel || wk.providerId || 'Auto').slice(0, 16)}`;
      ctx.font = '500 10px -apple-system, BlinkMacSystemFont, sans-serif';
      const tw = Math.min(136, ctx.measureText(caption).width + 16);
      const pillX = pos.x - tw / 2;
      const pillY = pos.y + r + 8;
      ctx.fillStyle = pal.isLight ? 'rgba(255,255,255,0.9)' : 'rgba(18,19,22,0.88)';
      ctx.strokeStyle = pal.line;
      ctx.lineWidth = 1;
      drawRoundedRect(ctx, pillX, pillY, tw, 20, 10);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = pal.text;
      ctx.fillText(caption, pos.x, pillY + 10.5);

      // Rotating velocity arc + orbiting tool sparks for active workers
      if (st.active && !wk.ghost) {
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.4;
        ctx.lineCap = 'round';
        ctx.globalAlpha = 0.92;
        const arcStart = animPhase * 2.8 + (wk.workerId?.length || 1);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r + 5, arcStart, arcStart + Math.PI * 0.72);
        ctx.stroke();
        if (wk.status === 'tool') {
          for (let sp = 0; sp < 3; sp++) {
            const sa = -animPhase * 3.4 + (sp * Math.PI * 2) / 3;
            ctx.fillStyle = pal.amber;
            ctx.beginPath();
            ctx.arc(pos.x + Math.cos(sa) * (r + 9), pos.y + Math.sin(sa) * (r + 9), 2.3, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.restore();
      }

      // Golden ★ MVP crown OR live elapsed stopwatch pill above node
      if (!wk.ghost && wk.isMvp) {
        ctx.fillStyle = 'rgba(251, 191, 36, 0.18)';
        ctx.strokeStyle = pal.gold;
        ctx.lineWidth = 1.2;
        drawRoundedRect(ctx, pos.x - 24, pos.y - r - 23, 48, 16, 8);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = pal.gold;
        ctx.font = '700 8.5px ui-monospace, SFMono-Regular, monospace';
        ctx.fillText('★ MVP', pos.x, pos.y - r - 14.5);
      } else if (!wk.ghost && wk.durationMs > 0) {
        const tLabel = fmtMs(wk.durationMs);
        ctx.font = '600 8.5px ui-monospace, SFMono-Regular, monospace';
        const etw = Math.max(34, ctx.measureText(tLabel).width + 10);
        ctx.fillStyle = pal.isLight ? 'rgba(255,255,255,0.92)' : 'rgba(18,19,22,0.88)';
        ctx.strokeStyle = st.active ? color : pal.line;
        ctx.lineWidth = 1;
        drawRoundedRect(ctx, pos.x - etw / 2, pos.y - r - 22, etw, 15, 7);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = st.active ? color : pal.muted;
        ctx.fillText(tLabel, pos.x, pos.y - r - 14);
      }

      // File territory chip if present
      if (!wk.ghost && wk.files?.length) {
        const fLabel = wk.files[0].split('/').pop() + (wk.files.length > 1 ? ` +${wk.files.length - 1}` : '');
        ctx.fillStyle = pal.muted;
        ctx.font = '500 9px ui-monospace, SFMono-Regular, monospace';
        ctx.fillText(fLabel.slice(0, 22), pos.x, pillY + 29);
      }
      ctx.restore();
    });
  }

  function drawDiffRace(ctx, w, h, pal, race) {
    const cands = race.candidates || [];
    const leftX = 28;
    const rightPad = 28;
    const trackW = Math.max(140, w - leftX - rightPad);
    ctx.save();
    ctx.fillStyle = pal.muted;
    ctx.font = '600 10px ui-monospace, SFMono-Regular, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`CODE DIFF RACE · ${String(race.repository || 'worktree').toUpperCase()} (${race.branch || 'branch'})`, leftX, 26);
    ctx.restore();

    const visible = cands.slice(0, 4);
    const maxLines = Math.max(1, ...visible.map(c => (c.additions || 0) + (c.deletions || 0)));
    const readyTimes = visible.filter(c => (c.status === 'ready' || c.status === 'applied') && c.elapsedMs > 0).map(c => c.elapsedMs);
    const fastestMs = readyTimes.length > 1 ? Math.min(...readyTimes) : null;
    const readyTotals = visible.filter(c => c.status === 'ready' || c.status === 'applied').map(c => (c.additions || 0) + (c.deletions || 0));
    const tightestTotal = readyTotals.length > 1 ? Math.min(...readyTotals) : null;

    const laneStep = Math.min(112, Math.max(76, (h - 150) / Math.max(1, visible.length)));
    const totalBlockH = laneStep * visible.length;
    const startY = Math.max(64, (h - 90 - totalBlockH) / 2 + 24);

    visible.forEach((c, idx) => {
      const ly = startY + idx * laneStep;
      const done = c.status === 'ready' || c.status === 'applied';
      const failed = c.status === 'failed';
      const isApplied = c.status === 'applied';
      const totalChg = (c.additions || 0) + (c.deletions || 0);
      const isFastest = done && fastestMs !== null && c.elapsedMs === fastestMs;
      const isTightest = done && tightestTotal !== null && totalChg === tightestTotal && totalChg < maxLines;

      ctx.save();
      // Subtle lane card backdrop
      ctx.fillStyle = pal.isLight ? 'rgba(255,255,255,0.68)' : 'rgba(255,255,255,0.025)';
      ctx.strokeStyle = isApplied ? pal.gold : pal.line;
      ctx.lineWidth = isApplied ? 1.5 : 1;
      drawRoundedRect(ctx, leftX - 10, ly - 32, trackW + 20, 74, 12);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = pal.text;
      ctx.font = '600 12px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'left';
      const badge = isApplied ? ' · ♛ ADOPTED' : isTightest ? ' · ✦ SURGICAL' : isFastest ? ' · ⚡ FASTEST' : '';
      ctx.fillText(`${c.slot} · ${shortModel(c.label)}${badge}`, leftX, ly - 14);

      ctx.fillStyle = isApplied ? pal.gold : done ? pal.sage : pal.muted;
      ctx.font = '600 11px ui-monospace, SFMono-Regular, monospace';
      ctx.textAlign = 'right';
      const statTxt = done ? `+${c.additions} / -${c.deletions} · ${fmtMs(c.elapsedMs)}` : failed ? 'FAILED' : 'GENERATING PATCH…';
      ctx.fillText(statTxt, leftX + trackW, ly - 14);

      // Track rail
      ctx.fillStyle = pal.isLight ? 'rgba(24,25,27,0.08)' : 'rgba(255,255,255,0.08)';
      drawRoundedRect(ctx, leftX, ly - 2, trackW, 14, 7);
      ctx.fill();

      if (done && totalChg > 0) {
        // Proportional stacked emerald (+additions) + coral (-deletions) bar!
        const footprintW = Math.max(48, trackW * (0.35 + 0.65 * (totalChg / maxLines)));
        const addW = Math.max(c.additions ? 10 : 0, footprintW * (c.additions / totalChg));
        const delW = Math.max(c.deletions ? 8 : 0, footprintW - addW);
        ctx.fillStyle = isApplied ? pal.gold : pal.sage;
        drawRoundedRect(ctx, leftX, ly - 2, addW, 14, delW > 0 ? [7, 0, 0, 7] : 7);
        ctx.fill();
        if (delW > 0) {
          ctx.fillStyle = pal.coral;
          drawRoundedRect(ctx, leftX + addW, ly - 2, delW, 14, [0, 7, 7, 0]);
          ctx.fill();
        }
      } else {
        const prog = failed ? 0.35 : (0.25 + 0.55 * ((Math.sin(animPhase * 1.9 + idx * 1.3) + 1) / 2));
        ctx.fillStyle = failed ? pal.coral : pal.violet;
        drawRoundedRect(ctx, leftX, ly - 2, Math.max(18, trackW * prog), 14, 7);
        ctx.fill();
      }

      if (c.files?.length) {
        ctx.fillStyle = pal.muted;
        ctx.font = '500 9.5px ui-monospace, SFMono-Regular, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`Files: ${c.files.slice(0, 3).map(f => f.split('/').pop()).join(' · ')}`, leftX, ly + 26);
      }
      ctx.restore();
    });
  }

  function drawArenaRace(ctx, w, h, pal, arena) {
    const contenders = arena.contenders || [];
    const leftX = 28;
    const judgeX = w - 82;
    const trackW = Math.max(130, judgeX - leftX - 48);
    const centerY = h * 0.45;
    const lanes = [centerY - 78, centerY + 78];

    // Header title inside stage
    ctx.save();
    ctx.fillStyle = pal.muted;
    ctx.font = '600 10px ui-monospace, SFMono-Regular, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('ULTRA-PLINIAN HEAD-TO-HEAD ARENA', leftX, 26);
    ctx.restore();

    contenders.slice(0, 2).forEach((c, idx) => {
      const ly = lanes[idx] || centerY;
      const done = c.status === 'completed';
      const failed = c.status === 'declined' || c.status === 'failed';
      const gradeRevealed = c._replayGradeRevealed !== undefined ? c._replayGradeRevealed : Boolean(c.grade);
      const prog = typeof c._replayProg === 'number'
        ? c._replayProg
        : done ? 1 : failed ? 0.45 : (0.28 + 0.58 * ((Math.sin(animPhase * 1.8 + idx * 1.4) + 1) / 2));
      const color = c.isWinner ? pal.gold : done ? pal.sage : failed ? pal.coral : (idx === 0 ? pal.violet : pal.blue);

      ctx.save();
      // Subtle lane panel
      ctx.fillStyle = pal.isLight ? 'rgba(255,255,255,0.72)' : 'rgba(255,255,255,0.025)';
      ctx.strokeStyle = c.isWinner ? pal.gold : pal.line;
      ctx.lineWidth = c.isWinner ? 1.5 : 1;
      drawRoundedRect(ctx, leftX - 10, ly - 34, trackW + 20, 82, 12);
      ctx.fill();
      ctx.stroke();

      // Label above track
      ctx.fillStyle = pal.text;
      ctx.font = '600 12px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`${c.isWinner ? '♛ ' : ''}${c.slot} · ${c.label}`, leftX, ly - 15);

      // Duration / Score right-aligned (only reveal final score after Judge finishes!)
      ctx.fillStyle = c.isWinner ? pal.gold : pal.muted;
      ctx.font = '600 11px ui-monospace, SFMono-Regular, monospace';
      ctx.textAlign = 'right';
      const rightTxt = (c.grade && gradeRevealed)
        ? `${c.grade.total}/15 · ${fmtMs(c.durationMs)}`
        : (done ? `DRAFT READY · ${fmtMs(c.durationMs)}` : 'DRAFTING…');
      ctx.fillText(rightTxt, leftX + trackW, ly - 15);

      // Track rail
      ctx.fillStyle = pal.isLight ? 'rgba(24,25,27,0.08)' : 'rgba(255,255,255,0.08)';
      drawRoundedRect(ctx, leftX, ly - 3, trackW, 13, 6.5);
      ctx.fill();

      // Active velocity bar + glowing lead tip while streaming
      const barW = Math.max(16, trackW * prog);
      ctx.fillStyle = color;
      drawRoundedRect(ctx, leftX, ly - 3, barW, 13, 6.5);
      ctx.fill();
      if (!done && !failed) {
        ctx.fillStyle = '#ffffff';
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.arc(leftX + barW - 5, ly + 3.5, 3.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // Converging smooth S-curve wire + animated pulse to Blind Judge
      ctx.strokeStyle = color;
      ctx.globalAlpha = c.isWinner ? 0.92 : 0.45;
      ctx.lineWidth = c.isWinner ? 2.4 : 1.5;
      const sx = leftX + trackW + 10;
      ctx.beginPath();
      ctx.moveTo(sx, ly + 3);
      ctx.bezierCurveTo(sx + 26, ly + 3, judgeX - 48, centerY, judgeX - 30, centerY);
      ctx.stroke();

      if (c.grade && gradeRevealed) {
        ctx.globalAlpha = 1;
        // 3 mini rubric score meters (Fidelity, Completeness, Clarity)
        const rubrics = [
          ['Fidelity', c.grade.fidelity],
          ['Complete', c.grade.completeness],
          ['Clarity', c.grade.clarity]
        ];
        const colW = Math.floor(trackW / 3);
        rubrics.forEach(([lbl, val], ri) => {
          const rx0 = leftX + ri * colW;
          ctx.fillStyle = pal.muted;
          ctx.font = '500 9.5px ui-monospace, SFMono-Regular, monospace';
          ctx.textAlign = 'left';
          ctx.fillText(`${lbl} ${val}/5`, rx0, ly + 25);
          ctx.fillStyle = pal.isLight ? 'rgba(24,25,27,0.1)' : 'rgba(255,255,255,0.1)';
          drawRoundedRect(ctx, rx0, ly + 31, colW - 14, 4, 2);
          ctx.fill();
          ctx.fillStyle = color;
          drawRoundedRect(ctx, rx0, ly + 31, ((colW - 14) * Math.max(0, Math.min(5, val))) / 5, 4, 2);
          ctx.fill();
        });
      } else {
        ctx.globalAlpha = 1;
        ctx.fillStyle = pal.muted;
        ctx.font = '500 9.5px ui-monospace, SFMono-Regular, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(done ? 'Submitted blindly to Judge — awaiting rubric scores…' : 'Streaming independent draft in isolated lane…', leftX, ly + 27);
      }
      ctx.restore();
    });

    // Blind Judge Diamond Node with gentle halo
    const jy = centerY;
    ctx.save();
    const jHalo = ctx.createRadialGradient(judgeX, jy, 6, judgeX, jy, 52);
    jHalo.addColorStop(0, arena.winnerId ? 'rgba(251, 191, 36, 0.28)' : 'rgba(245, 158, 11, 0.22)');
    jHalo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = jHalo;
    ctx.beginPath();
    ctx.arc(judgeX, jy, 52, 0, Math.PI * 2);
    ctx.fill();

    ctx.translate(judgeX, jy);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = pal.panel;
    ctx.strokeStyle = arena.winnerId ? pal.gold : pal.amber;
    ctx.lineWidth = 2.4;
    drawRoundedRect(ctx, -26, -26, 52, 52, 9);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.fillStyle = arena.winnerId ? pal.gold : pal.amber;
    ctx.font = '700 13px ui-monospace, SFMono-Regular, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(arena.winnerId ? '♛' : '⚖', judgeX, jy - 3);
    ctx.fillStyle = pal.text;
    ctx.font = '600 9px ui-monospace, SFMono-Regular, monospace';
    ctx.fillText('JUDGE', judgeX, jy + 12);
    if (arena.judge?.label) {
      ctx.fillStyle = pal.muted;
      ctx.font = '500 9.5px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(shortModel(arena.judge.label).slice(0, 14), judgeX, jy + 48);
    }

    // Verdict / live phase banner neatly anchored below both lanes
    if (arena.note) {
      const bannerY = Math.min(h - 52, centerY + 150);
      ctx.fillStyle = pal.isLight ? 'rgba(255,255,255,0.82)' : 'rgba(255,255,255,0.035)';
      ctx.strokeStyle = arena.winnerId ? pal.gold : pal.line;
      ctx.lineWidth = 1;
      drawRoundedRect(ctx, leftX - 10, bannerY - 14, w - leftX * 2 + 20, 28, 8);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = arena.winnerId ? pal.gold : pal.text;
      ctx.font = '600 10.5px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(arena.note.slice(0, 78), w / 2, bannerY + 1);
    }
    ctx.restore();
  }

  function drawTimeline() {
    const canvas = document.getElementById('pantheon-timeline-canvas');
    const emptyEl = document.getElementById('pantheon-timeline-empty');
    const viewData = getEffectiveData();
    const workers = viewData?.workers || [];
    if (emptyEl) emptyEl.classList.toggle('hidden', workers.length > 0);
    if (canvas) canvas.classList.toggle('hidden', workers.length === 0);
    if (!workers.length) return;
    const prep = prepCanvas(canvas);
    if (!prep) return;
    const { ctx, w, h } = prep;
    const pal = themePalette();
    timelineHitTargets = [];
    ctx.clearRect(0, 0, w, h);

    const times = workers.map(wk => {
      const s = wk.startedAt ? Date.parse(wk.startedAt) : Date.now() - (wk.durationMs || 1000);
      const e = wk.endedAt ? Date.parse(wk.endedAt) : s + Math.max(400, wk.durationMs || 1200);
      return { wk, s, e };
    });
    const minT = Math.min(...times.map(t => t.s));
    const maxT = Math.max(...times.map(t => t.e), minT + 1000);
    const span = Math.max(1000, maxT - minT);

    const labelW = 116;
    const padR = 20;
    const barAreaW = Math.max(100, w - labelW - padR);
    const rowH = 42;
    const topPad = 28;

    // Time axis header
    ctx.fillStyle = pal.muted;
    ctx.font = '500 10px ui-monospace, SFMono-Regular, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('0.0s', labelW, 16);
    ctx.textAlign = 'center';
    ctx.fillText(fmtMs(span / 2), labelW + barAreaW / 2, 16);
    ctx.textAlign = 'right';
    ctx.fillText(fmtMs(span), labelW + barAreaW, 16);

    times.forEach(({ wk, s, e }, idx) => {
      const y = topPad + idx * rowH;
      if (y + rowH > h) return;
      const st = statusInfo(wk.status);
      const x1 = labelW + ((s - minT) / span) * barAreaW;
      const fullBw = Math.max(24, ((e - s) / span) * barAreaW);
      const replayScale = typeof wk._replayFrac === 'number' ? Math.max(0.06, wk._replayFrac) : 1;
      const bw = Math.max(10, fullBw * replayScale);
      const color = wk.isMvp ? pal.gold : st.tone === 'sage' ? pal.sage : st.tone === 'amber' ? pal.amber : st.tone === 'gold' ? pal.gold : st.tone === 'coral' ? pal.coral : roleColor(wk.role);

      timelineHitTargets.push({ workerId: wk.workerId, x: 8, y, w: w - 16, h: rowH - 6 });

      // Row divider
      ctx.strokeStyle = pal.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(8, y + rowH - 6);
      ctx.lineTo(w - 8, y + rowH - 6);
      ctx.stroke();

      // Label
      ctx.fillStyle = wk.isMvp ? pal.gold : pal.text;
      ctx.font = '600 11px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`${wk.isMvp ? '★ ' : ''}${String(wk.role || 'worker').toUpperCase()}`, 12, y + 14);
      ctx.fillStyle = pal.muted;
      ctx.font = '500 9.5px ui-monospace, SFMono-Regular, monospace';
      ctx.fillText(shortModel(wk.modelLabel || wk.providerId || 'Auto').slice(0, 14), 12, y + 28);

      // Swimlane bar
      ctx.fillStyle = color;
      ctx.globalAlpha = wk.workerId === selectedWorkerId ? 0.98 : 0.78;
      drawRoundedRect(ctx, x1, y + 7, bw, 22, 6);
      ctx.fill();
      ctx.globalAlpha = 1;

      const barTxt = `${st.label} · ${fmtMs(wk.durationMs || (e - s))}`;
      if (bw > 74) {
        ctx.fillStyle = pal.isLight ? '#ffffff' : '#0c0d10';
        ctx.font = '700 10px ui-monospace, SFMono-Regular, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(barTxt, x1 + 8, y + 21);
      } else {
        ctx.fillStyle = pal.muted;
        ctx.font = '600 10px ui-monospace, SFMono-Regular, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(barTxt, x1 + bw + 8, y + 21);
      }
    });

    // Vertical playhead line during Time-Travel Replay
    if (typeof viewData?._replayCursorFrac === 'number' && viewData._replayCursorFrac < 1) {
      const px = labelW + viewData._replayCursorFrac * barAreaW;
      ctx.save();
      ctx.strokeStyle = pal.gold;
      ctx.lineWidth = 1.8;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(px, topPad - 6);
      ctx.lineTo(px, Math.min(h - 6, topPad + times.length * rowH));
      ctx.stroke();
      ctx.restore();
    }
  }

  async function loadSnapshot(taskId) {
    if (!taskId || demoMode) return;
    const token = ++fetchToken;
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/pantheon`);
      if (!res.ok || token !== fetchToken) return;
      data = await res.json();
      renderAll();
      // Auto-open gently if multiple workers or an active arena/crew are running for the first time on this task
      const autoTrigger = (data.stats?.activeWorkers >= 2) || (data.mode === 'crew' && data.crew?.status === 'running') || (data.mode === 'arena' && (data.arena?.status === 'drafting' || data.arena?.status === 'grading'));
      if (autoTrigger && !isOpenState && !autoOpenedTaskIds.has(taskId)) {
        autoOpenedTaskIds.add(taskId);
        open();
      }
    } catch {}
  }

  function syncTask(task) {
    const nextId = task?.id || null;
    if (nextId !== currentTaskId) {
      currentTaskId = nextId;
      selectedWorkerId = null;
      if (!demoMode) data = null;
    }
    if (nextId && !demoMode) {
      loadSnapshot(nextId);
    } else {
      updateHeaderBadge();
    }
  }

  function ingestStreamEvent(delta) {
    if (!delta || !currentTaskId || demoMode) return;
    if (delta.type === 'subagent.started' || delta.type === 'subagent.progress' || delta.type === 'subagent.completed') {
      const wk = delta.worker;
      if (!wk?.workerId) return;
      if (!data) {
        data = {
          taskId: currentTaskId, title: '', status: 'running', mode: 'swarm',
          orchestrator: { modelLabel: 'Orchestrator', status: 'running', calls: 0, maxCalls: 250, recoveries: 0 },
          workers: [], arena: null, failovers: [], fileConflicts: [], pendingApproval: null,
          stats: { totalWorkers: 0, activeWorkers: 0, completedWorkers: 0, failedWorkers: 0, totalCalls: 0 },
        };
      }
      const idx = data.workers.findIndex(w => w.workerId === wk.workerId);
      if (idx >= 0) data.workers[idx] = { ...data.workers[idx], ...wk };
      else data.workers.push(wk);
      data.mode = data.crew ? 'crew' : 'swarm';
      data.stats.totalWorkers = data.workers.length;
      data.stats.activeWorkers = data.workers.filter(w => ['thinking', 'streaming', 'tool', 'recovering'].includes(w.status)).length;
      data.stats.completedWorkers = data.workers.filter(w => w.status === 'completed').length;
      if (data.stats.activeWorkers >= 2 && !isOpenState && !autoOpenedTaskIds.has(currentTaskId)) {
        autoOpenedTaskIds.add(currentTaskId);
        open();
      }
      renderAll();
      return;
    }
    if (delta.type === 'pantheon.update' || delta.type === 'race.dispatched' || delta.type === 'race.result' || delta.type === 'race.completed' || delta.type === 'permission.requested') {
      loadSnapshot(currentTaskId);
    }
  }

  // ── Pantheon Agent Stats Builder & Cross-Harness Roster ──
  function drawRadarChart(canvas, stats, { compact = false } = {}) {
    if (!canvas || !stats?.radar) return;
    const w = compact ? 92 : 196;
    const h = compact ? 84 : 176;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const pal = themePalette();
    const axes = [
      { key: 'swe', label: 'SWE' },
      { key: 'ui', label: 'UI' },
      { key: 'math', label: 'MATH' },
      { key: 'sec', label: 'SEC' },
      { key: 'prose', label: 'PROSE' },
      { key: 'agency', label: 'AGY' },
    ];
    const cx = w / 2;
    const cy = h / 2;
    const radius = compact ? 29 : 58;
    const n = axes.length;

    // Concentric hex web rings (33%, 66%, 100%)
    [0.33, 0.66, 1].forEach((ring, ri) => {
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const ang = -Math.PI / 2 + (i * Math.PI * 2) / n;
        const x = cx + Math.cos(ang) * radius * ring;
        const y = cy + Math.sin(ang) * radius * ring;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = pal.isLight ? 'rgba(24,25,27,0.12)' : 'rgba(255,255,255,0.11)';
      ctx.lineWidth = ri === 2 ? 1.2 : 0.8;
      ctx.stroke();
    });

    // Radial spokes + axis labels
    axes.forEach((ax, i) => {
      const ang = -Math.PI / 2 + (i * Math.PI * 2) / n;
      const x = cx + Math.cos(ang) * radius;
      const y = cy + Math.sin(ang) * radius;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x, y);
      ctx.strokeStyle = pal.isLight ? 'rgba(24,25,27,0.09)' : 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 0.8;
      ctx.stroke();

      const lx = cx + Math.cos(ang) * (radius + (compact ? 11 : 18));
      const ly = cy + Math.sin(ang) * (radius + (compact ? 9 : 15));
      ctx.fillStyle = pal.muted;
      ctx.font = compact ? '600 7.5px ui-monospace, SFMono-Regular, monospace' : '600 9px ui-monospace, SFMono-Regular, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(compact ? ax.label.slice(0, 3) : `${ax.label} ${stats.radar[ax.key] ?? 0}`, lx, ly);
    });

    // Data polygon
    const fillTone = stats.overall >= 92 ? (pal.isLight ? 'rgba(217, 119, 6, 0.24)' : 'rgba(251, 191, 36, 0.24)')
      : (pal.isLight ? 'rgba(109, 40, 217, 0.22)' : 'rgba(167, 139, 250, 0.28)');
    const strokeTone = stats.overall >= 92 ? pal.gold : pal.violet;

    ctx.beginPath();
    axes.forEach((ax, i) => {
      const val = Math.max(12, Math.min(100, Number(stats.radar[ax.key] ?? 70))) / 100;
      const ang = -Math.PI / 2 + (i * Math.PI * 2) / n;
      const x = cx + Math.cos(ang) * radius * val;
      const y = cy + Math.sin(ang) * radius * val;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = fillTone;
    ctx.fill();
    ctx.strokeStyle = strokeTone;
    ctx.lineWidth = compact ? 1.6 : 2.1;
    ctx.stroke();

    // Glowing vertices
    axes.forEach((ax, i) => {
      const val = Math.max(12, Math.min(100, Number(stats.radar[ax.key] ?? 70))) / 100;
      const ang = -Math.PI / 2 + (i * Math.PI * 2) / n;
      const x = cx + Math.cos(ang) * radius * val;
      const y = cy + Math.sin(ang) * radius * val;
      ctx.fillStyle = strokeTone;
      ctx.beginPath();
      ctx.arc(x, y, compact ? 2.1 : 3.2, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  async function loadRoster(force = false) {
    if (rosterData && !force) {
      renderRosterView();
      return;
    }
    try {
      const res = await fetch('/api/pantheon/roster');
      if (!res.ok) return;
      rosterData = await res.json();
      renderRosterView();
    } catch {}
  }

  function openBuilder(slug = null) {
    if (!rosterData) {
      loadRoster(true).then(() => openBuilder(slug));
      return;
    }
    const existing = slug ? (rosterData.agents || []).find(a => a.slug === slug) : null;
    if (existing) {
      builderDraft = { ...existing };
      builderStats = existing.stats || null;
    } else {
      const firstEngine = rosterData.engines?.[0] || null;
      builderDraft = {
        slug: '',
        name: '',
        sigil: '✦',
        engineType: 'api',
        providerId: firstEngine?.id || null,
        harnessId: null,
        harnessCommand: '',
        primarySpecialty: 'swe_coding',
        secondarySpecialty: 'math_reasoning',
        autonomy: 'read_only',
        effort: 'high',
        instructions: 'Deliver surgical, evidence-backed engineering output with zero hand-waving.',
        custom: false,
      };
      builderStats = firstEngine?.stats || null;
    }
    builderOpen = true;
    renderRosterView();
    refreshBuilderStats();
  }

  function openBuilderForHarness(harnessId) {
    if (!rosterData) return;
    const h = (rosterData.harnesses || []).find(x => x.id === harnessId);
    if (!h) return;
    builderDraft = {
      slug: `${h.id.replace(/[^a-z0-9]+/gi, '-')}-agent`,
      name: `${h.shortName} Specialist`,
      sigil: '⚡',
      engineType: 'harness',
      providerId: h.providerId || null,
      harnessId: h.id,
      harnessCommand: h.command || '',
      primarySpecialty: h.id === 'hermes' || h.id === 'grok' ? 'security_research' : 'swe_coding',
      secondarySpecialty: 'math_reasoning',
      autonomy: 'external_harness',
      effort: 'high',
      instructions: `Coordinate directly via ${h.name} (${h.command}). Focus on deep precision, clean diffs, and independent verification.`,
      custom: false,
    };
    builderStats = h.stats || null;
    builderOpen = true;
    renderRosterView();
    refreshBuilderStats();
  }

  function applyArchetypeToDraft(archetypeId) {
    if (!rosterData || !builderDraft) return;
    const arch = (rosterData.archetypes || []).find(a => a.id === archetypeId);
    if (!arch) return;
    builderDraft.name = builderDraft.name || arch.name;
    builderDraft.sigil = arch.sigil;
    builderDraft.primarySpecialty = arch.primarySpecialty;
    builderDraft.secondarySpecialty = arch.secondarySpecialty;
    builderDraft.autonomy = arch.autonomy;
    builderDraft.effort = arch.effort;
    builderDraft.instructions = arch.instructions;
    renderRosterView();
    refreshBuilderStats();
  }

  async function refreshBuilderStats() {
    if (!builderDraft) return;
    try {
      const res = await fetch('/api/pantheon/stats/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
        body: JSON.stringify({
          providerId: builderDraft.providerId || null,
          harnessId: builderDraft.harnessId || null,
          primarySpecialty: builderDraft.primarySpecialty,
          secondarySpecialty: builderDraft.secondarySpecialty,
        }),
      });
      if (!res.ok) return;
      const json = await res.json();
      builderStats = json.stats || builderStats;
      builderBestEngine = json.bestEngine || null;
      updateBuilderStatsDom();
    } catch {}
  }

  function applyBestFitEngine() {
    if (!builderDraft || !builderBestEngine?.id) {
      if (typeof window.toast === 'function') window.toast('Connect an API or CLI harness to auto-pick the strongest engine.');
      return;
    }
    builderDraft.engineType = 'api';
    builderDraft.providerId = builderBestEngine.id;
    builderDraft.harnessId = null;
    renderRosterView();
    refreshBuilderStats();
    if (typeof window.toast === 'function') window.toast(`Selected strongest match: ${builderBestEngine.label} (OVR ${builderBestEngine.overall}).`);
  }

  function syncDraftTextFieldsFromDom() {
    if (!builderDraft) return;
    const nameEl = document.getElementById('pb-name');
    const cmdEl = document.getElementById('pb-custom-cmd');
    const instEl = document.getElementById('pb-instructions');
    if (nameEl) builderDraft.name = nameEl.value.trim();
    if (cmdEl) builderDraft.harnessCommand = cmdEl.value.trim();
    if (instEl) builderDraft.instructions = instEl.value.trim();
  }

  async function saveBuilderAgent() {
    syncDraftTextFieldsFromDom();
    if (!builderDraft?.name) {
      if (typeof window.toast === 'function') window.toast('Give your agent a name first.');
      document.getElementById('pb-name')?.focus();
      return;
    }
    try {
      const res = await fetch('/api/pantheon/roster', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
        body: JSON.stringify(builderDraft),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not save agent.');
      rosterData = json.roster;
      builderOpen = false;
      builderDraft = null;
      renderRosterView();
      if (typeof window.toast === 'function') window.toast(`✦ Forged "${json.agent.name}" (OVR ${json.agent.stats?.overall ?? ''}) — ready for agent.spawn & Squad Deploy.`);
    } catch (err) {
      if (typeof window.toast === 'function') window.toast(err.message || 'Save failed.');
    }
  }

  async function deleteRosterAgent(slug) {
    try {
      const res = await fetch(`/api/pantheon/roster/${encodeURIComponent(slug)}`, {
        method: 'DELETE',
        headers: { 'x-g0d-request': '1' },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not delete agent.');
      rosterData = json.roster;
      selectedSquad.delete(slug);
      builderOpen = false;
      builderDraft = null;
      renderRosterView();
      if (typeof window.toast === 'function') window.toast(`Removed custom agent "${slug}".`);
    } catch (err) {
      if (typeof window.toast === 'function') window.toast(err.message || 'Delete failed.');
    }
  }

  function toggleSquadMember(slug) {
    if (selectedSquad.has(slug)) selectedSquad.delete(slug);
    else if (selectedSquad.size < 4) selectedSquad.add(slug);
    else if (typeof window.toast === 'function') window.toast('Up to 4 parallel agents per Conclave Squad.');
    renderRosterView();
  }

  function deploySquadSlugs(slugs) {
    const agents = (rosterData?.agents || []).filter(a => slugs.includes(a.slug));
    if (!agents.length) return;
    const lines = agents.map(a => `- agent.spawn(role: "${a.slug}"${a.resolvedProviderId ? `, model: "${a.resolvedProviderId}"` : ''}) — ${a.name} [${a.engineLabel}, OVR ${a.stats?.overall || 85}, ${a.primarySpecialty.replace(/_/g, ' ')}]`);
    const prompt = `Convene a parallel Conclave Squad (${agents.length} specialist${agents.length === 1 ? '' : 's'}) using agent.spawn concurrently:\n${lines.join('\n')}\n\nSynthesize their findings and deliver a verified final result for: `;
    const input = document.getElementById('composer-input');
    if (input) {
      input.value = prompt;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      input.setSelectionRange(prompt.length, prompt.length);
    }
    if (typeof window.toast === 'function') window.toast(`✦ Loaded ${agents.length}-agent Conclave Squad into composer — add your goal and press Enter!`);
  }

  function deploySelectedSquad() {
    if (!selectedSquad.size) {
      const fallback = (rosterData?.agents || []).slice(0, 3).map(a => a.slug);
      deploySquadSlugs(fallback);
      return;
    }
    deploySquadSlugs([...selectedSquad]);
  }

  function deploySingleAgent(slug) {
    deploySquadSlugs([slug]);
  }

  async function saveFormationFromForm() {
    const nameEl = document.getElementById('rf-name');
    const goalEl = document.getElementById('rf-goal');
    const name = (nameEl?.value || '').trim();
    if (!name) {
      if (typeof window.toast === 'function') window.toast('Name your formation first.');
      nameEl?.focus();
      return;
    }
    const slugs = selectedSquad.size ? [...selectedSquad] : (rosterData?.agents || []).slice(0, 3).map(a => a.slug);
    try {
      const res = await fetch('/api/pantheon/formations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
        body: JSON.stringify({ name, sigil: '⚔', agents: slugs, goal: (goalEl?.value || '').trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not save formation.');
      if (rosterData) rosterData.formations = json.formations;
      formationFormOpen = false;
      renderRosterView();
      renderStandbyFormations();
      if (typeof window.toast === 'function') window.toast(`⚔ Saved formation "${json.formation.name}" (${slugs.length} agents).`);
    } catch (err) {
      if (typeof window.toast === 'function') window.toast(err.message || 'Save formation failed.');
    }
  }

  async function deleteFormation(id) {
    try {
      const res = await fetch(`/api/pantheon/formations/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { 'x-g0d-request': '1' },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not delete formation.');
      if (rosterData) rosterData.formations = json.formations;
      renderRosterView();
      renderStandbyFormations();
      if (typeof window.toast === 'function') window.toast(`Removed formation "${id}".`);
    } catch (err) {
      if (typeof window.toast === 'function') window.toast(err.message || 'Delete failed.');
    }
  }

  function deployFormation(id) {
    const f = (rosterData?.formations || []).find(x => x.id === id);
    if (!f) return;
    const agents = (rosterData?.agents || []).filter(a => f.agents.includes(a.slug));
    const lines = agents.length
      ? agents.map(a => `- agent.spawn(role: "${a.slug}"${a.resolvedProviderId ? `, model: "${a.resolvedProviderId}"` : ''}) — ${a.name} [${a.engineLabel}, OVR ${a.stats?.overall || 85}]`)
      : f.agents.map(slug => `- agent.spawn(role: "${slug}")`);
    const prompt = `Convene Conclave Formation "${f.name}" (${lines.length} specialist${lines.length === 1 ? '' : 's'}) concurrently via agent.spawn:\n${lines.join('\n')}\n\nGoal: ${f.goal || ''}`;
    const input = document.getElementById('composer-input');
    if (input) {
      input.value = prompt;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      input.setSelectionRange(prompt.length, prompt.length);
    }
    if (typeof window.toast === 'function') window.toast(`${f.sigil || '✦'} Loaded formation "${f.name}" into composer — press Enter to launch!`);
  }

  const fmtCtx = (n) => {
    const v = Number(n) || 128000;
    return v >= 1000000 ? `${(v / 1000000).toFixed(v % 1000000 === 0 ? 0 : 1)}M ctx` : `${Math.round(v / 1000)}K ctx`;
  };
  function updateBuilderStatsDom() {
    const st = builderStats;
    if (!st) return;
    const setT = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val); };
    setT('pb-ovr-num', st.overall ?? 85);
    setT('pb-tier-badge', st.tier || 'A+');
    setT('pb-family-label', `${st.family || 'Model'} · ${fmtCtx(st.contextWindow)}`);
    setT('pb-speed-val', `${st.speed ?? 75}`);
    setT('pb-cost-val', `${st.costIndex ?? 70}`);
    const sp = document.getElementById('pb-speed-bar');
    if (sp) sp.value = st.speed ?? 75;
    const cp = document.getElementById('pb-cost-bar');
    if (cp) cp.value = st.costIndex ?? 70;
    const customWrap = document.getElementById('pb-custom-cmd-wrap');
    if (customWrap) customWrap.classList.toggle('hidden', builderDraft?.engineType !== 'custom_cli');
    drawRadarChart(document.getElementById('pb-radar-canvas'), st, { compact: false });
  }

  function renderRosterView() {
    const el = document.getElementById('pantheon-view-roster');
    if (!el) return;
    if (!rosterData) {
      el.innerHTML = '<div class="pantheon-empty-cards"><p>Loading Conclave Roster &amp; real benchmark matrix…</p></div>';
      return;
    }
    const agents = rosterData.agents || [];
    const harnesses = rosterData.harnesses || [];
    const engines = rosterData.engines || [];
    const domains = rosterData.domains || [];
    const archetypes = rosterData.archetypes || [];
    const domainOpts = (selected) => domains.map(d => `<option value="${esc(d.id)}" ${d.id === selected ? 'selected' : ''}>${esc(d.shortLabel)}</option>`).join('');

    const currentEngineVal = builderDraft
      ? (builderDraft.engineType === 'custom_cli' ? 'custom_cli' : builderDraft.engineType === 'harness' && builderDraft.harnessId ? `harness::${builderDraft.harnessId}` : builderDraft.providerId ? `api::${builderDraft.providerId}` : '')
      : '';

    const builderHtml = builderOpen && builderDraft ? `
      <section class="pb-panel" id="pantheon-builder" aria-label="Agent Stats Builder">
        <header class="pb-head">
          <div>
            <h3>⚒ Forge Conclave Agent</h3>
            <p>Stats are calculated live from real benchmark priors &amp; your local per-domain Elo.</p>
          </div>
          <button type="button" class="button button-quiet" id="pb-best-fit" title="Auto-select highest OVR engine for these specialties">✦ Best Fit</button>
        </header>
        <div class="pb-archetypes">
          ${archetypes.map(a => `<button type="button" class="pb-arch-pill" data-pb-archetype="${esc(a.id)}">${esc(a.sigil)} ${esc(a.name)}</button>`).join('')}
        </div>
        <div class="pb-hero">
          <canvas id="pb-radar-canvas" class="pb-radar-canvas" width="196" height="176" aria-label="Live 6-axis agent stat radar"></canvas>
          <div class="pb-readout">
            <div class="pb-ovr-row">
              <span class="pb-ovr-label">OVR</span>
              <strong class="pb-ovr-num" id="pb-ovr-num">${esc(builderStats?.overall ?? 85)}</strong>
              <span class="pb-tier-badge" id="pb-tier-badge">${esc(builderStats?.tier || 'A+')}</span>
            </div>
            <p class="pb-family" id="pb-family-label">${esc(builderStats?.family || 'Model')} · ${fmtCtx(builderStats?.contextWindow)}</p>
            <div class="pb-meter-row"><span>Speed</span><progress id="pb-speed-bar" max="100" value="${esc(builderStats?.speed ?? 75)}"></progress><strong id="pb-speed-val">${esc(builderStats?.speed ?? 75)}</strong></div>
            <div class="pb-meter-row"><span>Efficiency</span><progress id="pb-cost-bar" max="100" value="${esc(builderStats?.costIndex ?? 70)}"></progress><strong id="pb-cost-val">${esc(builderStats?.costIndex ?? 70)}</strong></div>
          </div>
        </div>
        <form id="pb-form" class="pb-form" autocomplete="off">
          <div class="pb-row-two">
            <label>Agent Name<input type="text" id="pb-name" value="${esc(builderDraft.name || '')}" placeholder="e.g. Hermes Red-Team Oracle" maxlength="64" required></label>
            <div class="pb-sigil-field">
              <span>Sigil</span>
              <div class="pb-sigil-row">${SIGILS.map(s => `<button type="button" class="pb-sigil-btn ${builderDraft.sigil === s ? 'active' : ''}" data-pb-sigil="${esc(s)}">${esc(s)}</button>`).join('')}</div>
            </div>
          </div>
          <label>Backing Engine or External Harness
            <select id="pb-engine">
              <option value="" ${!currentEngineVal ? 'selected' : ''}>Auto-Route Best Connected Engine</option>
              ${engines.length ? `<optgroup label="Connected Raw APIs &amp; Stack Models">${engines.map(e => `<option value="api::${esc(e.id)}" ${currentEngineVal === `api::${e.id}` ? 'selected' : ''}>${esc(e.label)} (OVR ${esc(e.stats?.overall ?? 80)})</option>`).join('')}</optgroup>` : ''}
              <optgroup label="External Harnesses (Codex, Claude Code, Antigravity, Hermes, Grok…)">
                ${harnesses.map(h => `<option value="harness::${esc(h.id)}" ${currentEngineVal === `harness::${h.id}` ? 'selected' : ''}>${esc(h.name)} · ${h.status === 'connected' ? 'Connected' : h.status === 'installed' ? 'CLI Installed' : 'Bridge'} (OVR ${esc(h.stats?.overall ?? 85)})</option>`).join('')}
              </optgroup>
              <option value="custom_cli" ${currentEngineVal === 'custom_cli' ? 'selected' : ''}>Custom Local CLI Harness Bridge…</option>
            </select>
          </label>
          <label id="pb-custom-cmd-wrap" class="${builderDraft.engineType === 'custom_cli' ? '' : 'hidden'}">Local Harness Command<input type="text" id="pb-custom-cmd" value="${esc(builderDraft.harnessCommand || '')}" placeholder="e.g. agy, codex, claude, hermes, grok" maxlength="120"></label>
          <div class="pb-row-two">
            <label>Primary Specialty<select id="pb-primary">${domainOpts(builderDraft.primarySpecialty)}</select></label>
            <label>Secondary Specialty<select id="pb-secondary">${domainOpts(builderDraft.secondarySpecialty)}</select></label>
          </div>
          <div class="pb-row-two">
            <label>Autonomy
              <select id="pb-autonomy">
                <option value="read_only" ${builderDraft.autonomy === 'read_only' ? 'selected' : ''}>Read-Only Specialist</option>
                <option value="workspace_builder" ${builderDraft.autonomy === 'workspace_builder' ? 'selected' : ''}>Workspace Builder</option>
                <option value="external_harness" ${builderDraft.autonomy === 'external_harness' ? 'selected' : ''}>External Harness Delegate</option>
              </select>
            </label>
            <label>Reasoning Effort
              <select id="pb-effort">
                <option value="fast" ${builderDraft.effort === 'fast' ? 'selected' : ''}>Fast</option>
                <option value="medium" ${builderDraft.effort === 'medium' ? 'selected' : ''}>Medium</option>
                <option value="high" ${builderDraft.effort === 'high' ? 'selected' : ''}>High</option>
                <option value="max" ${builderDraft.effort === 'max' ? 'selected' : ''}>Max</option>
              </select>
            </label>
          </div>
          <label>System Directives<textarea id="pb-instructions" rows="2" maxlength="4000" placeholder="Role instructions injected when spawned…">${esc(builderDraft.instructions || '')}</textarea></label>
          <div class="pb-actions">
            <button type="submit" class="button button-primary" id="pb-save">Save to Conclave</button>
            <button type="button" class="button button-secondary" id="pb-cancel">Cancel</button>
            ${builderDraft.custom && !builderDraft.builtin ? '<button type="button" class="button button-danger" id="pb-delete">Delete</button>' : ''}
          </div>
        </form>
      </section>` : '';

    const formations = rosterData.formations || [];
    const formationFormHtml = formationFormOpen ? `
      <form id="rf-form" class="rf-form" autocomplete="off">
        <div class="rf-row">
          <input type="text" id="rf-name" placeholder="Formation name (e.g. Security Swarm)" maxlength="48" required>
          <input type="text" id="rf-goal" placeholder="Optional starter mission prompt…" maxlength="400">
        </div>
        <div class="rf-actions">
          <span class="rf-hint">Saves ${selectedSquad.size ? `${selectedSquad.size} selected` : 'top 3'} roster agents as a 1-click preset</span>
          <button type="submit" class="button button-primary" id="rf-save">Save Formation</button>
          <button type="button" class="button button-quiet" id="rf-cancel">Cancel</button>
        </div>
      </form>` : '';

    el.innerHTML = `
      <div class="roster-toolbar">
        <button type="button" class="button button-primary" id="roster-forge-new">+ Forge Agent</button>
        <div class="roster-squad-tray">
          <span class="roster-squad-count">Squad · ${selectedSquad.size}/4</span>
          <button type="button" class="button button-quiet" id="roster-save-formation-toggle" title="Save selected agents as a 1-click formation">+ Formation</button>
          <button type="button" class="button button-secondary" id="roster-deploy-squad">✦ Deploy Squad</button>
        </div>
      </div>
      ${formationFormHtml}
      <div class="roster-formations" aria-label="Saved 1-click formations">
        <span class="roster-strip-label">Formations</span>
        <div class="roster-harness-pills">
          ${formations.map(f => `<span class="pantheon-formation-wrap"><button type="button" class="pantheon-formation-chip" data-formation-launch="${esc(f.id)}" title="${esc(`${f.name}: ${f.agents.join(', ')}`)}">${esc(f.sigil || '✦')} ${esc(f.name)} <small>${esc(f.agents.length)}</small></button>${f.custom && !f.builtin ? `<button type="button" class="pantheon-formation-del" data-formation-delete="${esc(f.id)}" aria-label="Delete formation ${esc(f.name)}">×</button>` : ''}</span>`).join('')}
        </div>
      </div>
      <div class="roster-harnesses" aria-label="External harnesses and bridges">
        <span class="roster-strip-label">Harnesses</span>
        <div class="roster-harness-pills">
          ${harnesses.map(h => `<button type="button" class="roster-harness-pill status-${esc(h.status)}" data-roster-harness="${esc(h.id)}" title="${esc(`${h.name} (${h.status}) — click to forge an agent for this harness`)}"><i class="rh-dot"></i><span>${esc(h.shortName)}</span><small>${esc(h.stats?.overall ?? 85)}</small></button>`).join('')}
        </div>
      </div>
      ${builderHtml}
      <div class="roster-grid" id="pantheon-roster-grid">
        ${agents.map(ag => {
          const inSquad = selectedSquad.has(ag.slug);
          const r = ag.stats?.radar || {};
          const xp = ag.xp || { level: 1, xp: 0, runs: 0 };
          return `<article class="roster-card ${inSquad ? 'is-in-squad' : ''}">
            <header class="roster-card-head">
              <div class="roster-card-id">
                <span class="roster-sigil">${esc(ag.sigil || '✦')}</span>
                <div>
                  <strong>${esc(ag.name)}</strong>
                  <small>${esc(ag.engineLabel)}</small>
                </div>
              </div>
              <div class="roster-badges-col">
                <span class="roster-ovr-pill tier-${esc(String(ag.stats?.tier || 'A').replace('+', 'p'))}">OVR ${esc(ag.stats?.overall ?? 85)} · ${esc(ag.stats?.tier || 'A')}</span>
                <span class="roster-xp-pill" title="${esc(`${xp.xp} XP · ${xp.runs} runs`)}">Lv.${esc(xp.level)}${xp.runs ? ` · ${xp.runs}r` : ''}</span>
              </div>
            </header>
            <div class="roster-card-body">
              <canvas class="roster-mini-radar" data-mini-radar="${esc(ag.slug)}" width="92" height="84" aria-hidden="true"></canvas>
              <div class="roster-stat-grid">
                <span>SWE <strong>${esc(r.swe ?? 80)}</strong></span>
                <span>UI <strong>${esc(r.ui ?? 78)}</strong></span>
                <span>MTH <strong>${esc(r.math ?? 78)}</strong></span>
                <span>SEC <strong>${esc(r.sec ?? 75)}</strong></span>
                <span>WRI <strong>${esc(r.prose ?? 78)}</strong></span>
                <span>AGY <strong>${esc(r.agency ?? 72)}</strong></span>
              </div>
            </div>
            <div class="roster-tags">
              <span class="pantheon-file-chip">${esc(ag.primarySpecialty.replace(/_/g, ' '))}</span>
              <span class="pantheon-file-chip">${esc(ag.autonomy === 'external_harness' ? 'harness' : ag.autonomy === 'workspace_builder' ? 'builder' : 'read-only')}</span>
              <span class="pantheon-status-pill tone-${ag.ready ? 'sage' : 'amber'}">${ag.ready ? 'Ready' : 'Bridge'}</span>
            </div>
            <footer class="roster-card-foot">
              <button type="button" class="button ${inSquad ? 'button-primary' : 'button-secondary'}" data-roster-squad="${esc(ag.slug)}">${inSquad ? '✓ In Squad' : '+ Squad'}</button>
              <button type="button" class="button button-quiet" data-roster-edit="${esc(ag.slug)}">Edit</button>
              <button type="button" class="button button-quiet" data-roster-spawn="${esc(ag.slug)}">Spawn →</button>
            </footer>
          </article>`;
        }).join('')}
      </div>
    `;

    // Paint all Retina radar canvases (builder + each roster card!)
    if (builderOpen && builderStats) {
      drawRadarChart(document.getElementById('pb-radar-canvas'), builderStats, { compact: false });
    }
    el.querySelectorAll('canvas[data-mini-radar]').forEach(cv => {
      const ag = agents.find(a => a.slug === cv.dataset.miniRadar);
      if (ag?.stats) drawRadarChart(cv, ag.stats, { compact: true });
    });
  }

  window.G0DConclave = window.G0DPantheon = {
    open,
    close,
    toggle,
    setLens,
    syncTask,
    ingestStreamEvent,
    loadSnapshot,
    loadRoster,
    openBuilder,
    startDemo,
    stopDemo,
    isOpen: () => isOpenState,
    getState: () => data,
  };
})();
