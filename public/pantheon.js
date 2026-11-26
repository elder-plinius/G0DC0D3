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

  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

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
            <h2 class="pantheon-title">THE PANTHEON</h2>
            <p class="pantheon-subtitle" id="pantheon-subtitle">Multi-Agent Constellation &amp; Arena Stage</p>
          </div>
        </div>
        <div class="pantheon-header-controls">
          <div class="pantheon-lenses" role="tablist" aria-label="Pantheon views">
            <button type="button" class="pantheon-lens active" role="tab" aria-selected="true" data-pantheon-lens="stage">✦ Stage</button>
            <button type="button" class="pantheon-lens" role="tab" aria-selected="false" data-pantheon-lens="cards">▤ Cards</button>
            <button type="button" class="pantheon-lens" role="tab" aria-selected="false" data-pantheon-lens="timeline">◫ Timeline</button>
          </div>
          <button type="button" class="icon-button pantheon-expand-btn" id="pantheon-expand" title="Expand or restore Pantheon stage" aria-label="Expand Pantheon stage" aria-pressed="false">⤢</button>
          <button type="button" class="icon-button" id="pantheon-close" title="Close Pantheon" aria-label="Close Pantheon">×</button>
        </div>
      </header>
      <div class="pantheon-telemetry-bar" id="pantheon-telemetry-bar">
        <span class="pantheon-mode-pill" id="pantheon-mode-pill">Standby</span>
        <div class="pantheon-stat"><span class="pantheon-stat-label">Active</span><strong id="pantheon-stat-active">0</strong></div>
        <div class="pantheon-stat"><span class="pantheon-stat-label">Done</span><strong id="pantheon-stat-done">0</strong></div>
        <div class="pantheon-stat"><span class="pantheon-stat-label">Calls</span><strong id="pantheon-stat-calls">0</strong></div>
        <div class="pantheon-stat"><span class="pantheon-stat-label">Overlaps</span><strong id="pantheon-stat-conflicts">0</strong></div>
        <div class="pantheon-telemetry-actions">
          <button type="button" class="button button-quiet pantheon-demo-toggle" id="pantheon-demo-btn" title="Preview an interactive multi-agent constellation">Preview Swarm</button>
        </div>
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
            <p class="pantheon-standby-copy">Launch a parallel specialist squad, run a verified Coding Crew, or race two frontier models head-to-head.</p>
            <div class="pantheon-presets">
              <button type="button" class="button button-primary" data-pantheon-preset="research">✦ Parallel Research Squad</button>
              <button type="button" class="button button-secondary" data-pantheon-preset="crew">⚙ Code &amp; Review Crew</button>
              <button type="button" class="button button-secondary" data-pantheon-preset="arena">⚡ Head-to-Head Arena</button>
            </div>
          </div>
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
      const preset = e.target.closest('[data-pantheon-preset]');
      if (preset) { triggerPreset(preset.dataset.pantheonPreset); return; }
      const cardBtn = e.target.closest('[data-pantheon-select]');
      if (cardBtn) { selectWorker(cardBtn.dataset.pantheonSelect); return; }
      const approveBtn = e.target.closest('[data-pantheon-approve]');
      if (approveBtn) { resolveApprovalFromPantheon(approveBtn.dataset.pantheonApprove); return; }
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
        body: JSON.stringify({ approvalId: data.pendingApproval.id, decision }),
      });
      if (!res.ok) throw new Error('Approval action failed.');
      await loadSnapshot(currentTaskId);
      if (typeof window.refresh === 'function') window.refresh();
    } catch (err) {
      if (typeof window.toast === 'function') window.toast(err.message);
    }
  }

  function triggerPreset(preset) {
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
        title: 'Pantheon Preview · Ultra-Plinian Arena',
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
      title: 'Pantheon Live Preview',
      status: cycle >= 4 ? 'completed' : 'running',
      mode: 'swarm',
      orchestrator: { modelLabel: 'Gemini 4 Neon', status: cycle >= 4 ? 'completed' : 'running', calls: 5 + cycle, maxCalls: 250, recoveries: cycle >= 2 ? 1 : 0 },
      workers: [
        {
          workerId: 'demo-explore', kind: 'subagent', role: 'explore',
          modelLabel: 'Gemini 4 Neon', status: w1Status,
          tool: w1Status === 'tool' ? 'repo.search' : '', target: 'src/runtime.mjs',
          files: ['src/runtime.mjs', 'src/providers.mjs'], tools: ['repo.glob', 'repo.search', 'repo.read'],
          calls: 2, startedAt: new Date(base).toISOString(), endedAt: w1Status === 'completed' ? new Date(base + 6200).toISOString() : null,
          durationMs: w1Status === 'completed' ? 6200 : 3200 + cycle * 900,
          streamTail: 'Mapped tool dispatch loop in src/runtime.mjs:1169 and Gemini wire serializer in src/providers.mjs:442.',
          summary: 'Mapped tool dispatch loop in src/runtime.mjs:1169 and Gemini wire serializer in src/providers.mjs:442. Found 2 parallelizable batch paths.',
        },
        {
          workerId: 'demo-reviewer', kind: 'subagent', role: 'reviewer',
          modelLabel: 'Claude Sonnet 5.5', status: w2Status,
          tool: w2Status === 'tool' ? 'git.diff' : '', target: 'src/runtime.mjs',
          files: ['src/runtime.mjs', 'src/server.mjs'], tools: ['git.diff', 'repo.read'],
          calls: 2, startedAt: new Date(base + 400).toISOString(), endedAt: w2Status === 'completed' ? new Date(base + 9800).toISOString() : null,
          durationMs: w2Status === 'completed' ? 9400 : 2900 + cycle * 1100,
          streamTail: w2Status === 'recovering' ? 'GODMODƎ surge: switching fallback route after transient 429…' : 'Audited SSE cleanup on disconnect and verified zero inline style= CSP compliance.',
          summary: 'Audited SSE cleanup on disconnect and verified zero inline style= CSP compliance across public/pantheon.js and public/settings.js.',
        },
        {
          workerId: 'demo-verifier', kind: 'subagent', role: 'verifier',
          modelLabel: 'Hermes 4 405B', status: w3Status,
          tool: w3Status === 'tool' ? 'repo.read' : '', target: 'test/pantheon.test.mjs',
          files: ['test/pantheon.test.mjs'], tools: ['repo.read'],
          calls: 1, startedAt: new Date(base + 900).toISOString(), endedAt: w3Status === 'completed' ? new Date(base + 11200).toISOString() : null,
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
      },
    };
  }

  function startDemo(initialTick = 1) {
    stopDemo();
    demoMode = true;
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
    btn.textContent = demoMode ? 'Exit Preview' : 'Preview Swarm';
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
    activeLens = ['stage', 'cards', 'timeline'].includes(lens) ? lens : 'stage';
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
    if (activeLens === 'stage') drawStage();
    if (activeLens === 'cards') renderCards();
    if (activeLens === 'timeline') drawTimeline();
  }

  function selectWorker(workerId) {
    selectedWorkerId = workerId || null;
    renderInspector();
    if (activeLens === 'stage') drawStage();
    if (activeLens === 'cards') renderCards();
  }

  function startLoop() {
    if (rafId !== null) return;
    lastFrameMs = performance.now();
    const tick = (now) => {
      if (!isOpenState) { rafId = null; return; }
      const dt = Math.min(0.05, (now - lastFrameMs) / 1000);
      lastFrameMs = now;
      if (!motionReduced()) {
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

  function renderAll() {
    if (!dockEl()?.dataset.pantheonInit) return;
    const mode = data?.mode || 'standby';
    const modeLabels = { arena: 'Arena Race', crew: 'Coding Crew', swarm: 'Constellation', standby: 'Standby' };
    const pill = document.getElementById('pantheon-mode-pill');
    if (pill) {
      pill.textContent = demoMode ? `${modeLabels[mode] || 'Preview'} · Demo` : (modeLabels[mode] || 'Standby');
      pill.className = `pantheon-mode-pill mode-${mode}`;
    }
    const sub = document.getElementById('pantheon-subtitle');
    if (sub) {
      sub.textContent = data?.title
        ? `${data.title} · ${data.orchestrator?.modelLabel ? shortModel(data.orchestrator.modelLabel) : 'Orchestrator'}`
        : 'Multi-Agent Constellation & Arena Stage';
    }
    const setT = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = String(v); };
    setT('pantheon-stat-active', data?.stats?.activeWorkers ?? 0);
    setT('pantheon-stat-done', data?.stats?.completedWorkers ?? 0);
    setT('pantheon-stat-calls', data?.stats?.totalCalls ?? 0);
    setT('pantheon-stat-conflicts', data?.fileConflicts?.length ?? 0);

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
    }

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
      return `<article class="pantheon-card ${selected ? 'is-selected' : ''} tone-${st.tone}">
        <header class="pantheon-card-head">
          <span class="pantheon-role-chip">${esc(w.role)}</span>
          <span class="pantheon-status-pill tone-${st.tone}">${esc(w.tool && st.active ? w.tool : st.label)}</span>
        </header>
        <strong class="pantheon-card-model">${esc(shortModel(w.modelLabel || w.providerId || 'Auto'))}</strong>
        <p class="pantheon-card-meta">${esc(`${w.calls || 0} call${w.calls === 1 ? '' : 's'} · ${fmtMs(w.durationMs)}`)}</p>
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
    setT('pi-meta', `${worker.kind === 'crew' ? 'Coding Crew' : 'Specialist Subagent'} · ${worker.calls || 0} calls · ${fmtMs(worker.durationMs)}${worker.tools?.length ? ` · Tools: ${[...new Set(worker.tools)].join(', ')}` : ''}`);
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

    if (data?.mode === 'arena' && data?.arena) {
      drawArenaRace(ctx, w, h, pal, data.arena);
      return;
    }

    const cx = w * 0.5;
    const cy = data?.mode === 'standby' ? h * 0.37 : h * 0.48;
    const rx = Math.min(w * 0.34, 230);
    const ry = Math.min(h * 0.32, 148);

    // Concentric orbital guides
    ctx.save();
    ctx.strokeStyle = pal.isLight ? 'rgba(24,25,27,0.09)' : 'rgba(255,255,255,0.08)';
    ctx.setLineDash([4, 6]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx * 0.52, ry * 0.52, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    const workers = (data?.workers || []).length
      ? data.workers
      : [
          { workerId: '_ghost_1', role: 'explore', modelLabel: 'Standby', status: 'queued', ghost: true },
          { workerId: '_ghost_2', role: 'reviewer', modelLabel: 'Standby', status: 'queued', ghost: true },
          { workerId: '_ghost_3', role: 'verifier', modelLabel: 'Standby', status: 'queued', ghost: true },
        ];

    const coords = new Map();
    const count = workers.length;
    workers.forEach((wk, i) => {
      const angle = -Math.PI / 2 + (i * Math.PI * 2) / Math.max(1, count);
      const x = cx + Math.cos(angle) * rx;
      const y = cy + Math.sin(angle) * ry;
      coords.set(wk.workerId, { x, y, angle });
    });

    // Draw file conflict arcs between workers touching the same file
    for (const conflict of (data?.fileConflicts || [])) {
      const a = coords.get(conflict.owners[0]?.workerId);
      const b = coords.get(conflict.owners[1]?.workerId);
      if (a && b) {
        ctx.save();
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.55)';
        ctx.lineWidth = 1.6;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(cx, cy - 22, b.x, b.y);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Draw signal conduits from Orchestrator Core to each Worker
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
      ctx.globalAlpha = wk.ghost ? 0.5 : st.active ? 0.65 : 0.35;
      ctx.lineWidth = st.active ? 2.2 : 1.4;
      ctx.stroke();

      // Travelling luminous energy packets on active conduits
      if (st.active && !wk.ghost) {
        for (let p = 0; p < 2; p++) {
          const t = (animPhase * 0.65 + idx * 0.23 + p * 0.5) % 1;
          const u = 1 - t;
          const px = u * u * cx + 2 * u * t * mx + t * t * pos.x;
          const py = u * u * cy + 2 * u * t * my + t * t * pos.y;
          ctx.globalAlpha = 0.95;
          ctx.fillStyle = st.tone === 'gold' ? pal.gold : stroke;
          ctx.beginPath();
          ctx.arc(px, py, 3.6, 0, Math.PI * 2);
          ctx.fill();
        }
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

      ctx.fillStyle = pal.text;
      ctx.font = '600 9px ui-monospace, SFMono-Regular, monospace';
      ctx.fillText(String(wk.role || 'agent').toUpperCase().slice(0, 9), pos.x, pos.y + 10);

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

  function drawArenaRace(ctx, w, h, pal, arena) {
    const contenders = arena.contenders || [];
    const leftX = 28;
    const judgeX = w - 92;
    const trackW = Math.max(120, judgeX - leftX - 42);
    const lanes = [h * 0.34, h * 0.68];

    // Header title inside stage
    ctx.save();
    ctx.fillStyle = pal.muted;
    ctx.font = '600 10px ui-monospace, SFMono-Regular, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('ULTRA-PLINIAN HEAD-TO-HEAD ARENA', leftX, 24);
    ctx.restore();

    contenders.slice(0, 2).forEach((c, idx) => {
      const ly = lanes[idx] || h * 0.5;
      const done = c.status === 'completed';
      const failed = c.status === 'declined' || c.status === 'failed';
      const prog = done ? 1 : failed ? 0.45 : (0.28 + 0.58 * ((Math.sin(animPhase * 1.8 + idx * 1.4) + 1) / 2));
      const color = c.isWinner ? pal.gold : done ? pal.sage : failed ? pal.coral : (idx === 0 ? pal.violet : pal.blue);

      ctx.save();
      // Label above track
      ctx.fillStyle = pal.text;
      ctx.font = '600 12px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`${c.isWinner ? '♛ ' : ''}${c.slot} · ${c.label}`, leftX, ly - 16);

      // Duration / Score right-aligned
      ctx.fillStyle = c.isWinner ? pal.gold : pal.muted;
      ctx.font = '600 11px ui-monospace, SFMono-Regular, monospace';
      ctx.textAlign = 'right';
      const rightTxt = c.grade ? `${c.grade.total}/15 · ${fmtMs(c.durationMs)}` : (done ? fmtMs(c.durationMs) : c.status.toUpperCase());
      ctx.fillText(rightTxt, leftX + trackW, ly - 16);

      // Track rail
      ctx.fillStyle = pal.isLight ? 'rgba(24,25,27,0.08)' : 'rgba(255,255,255,0.08)';
      drawRoundedRect(ctx, leftX, ly - 6, trackW, 12, 6);
      ctx.fill();

      // Active bar
      ctx.fillStyle = color;
      drawRoundedRect(ctx, leftX, ly - 6, Math.max(16, trackW * prog), 12, 6);
      ctx.fill();

      // Converging smooth S-curve wire to Judge
      ctx.strokeStyle = color;
      ctx.globalAlpha = c.isWinner ? 0.9 : 0.45;
      ctx.lineWidth = c.isWinner ? 2.4 : 1.5;
      ctx.beginPath();
      ctx.moveTo(leftX + trackW, ly);
      ctx.bezierCurveTo(leftX + trackW + 32, ly, judgeX - 58, h * 0.51, judgeX - 30, h * 0.51);
      ctx.stroke();

      if (c.grade) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = pal.muted;
        ctx.font = '500 10px ui-monospace, SFMono-Regular, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`Fidelity ${c.grade.fidelity}/5 · Completeness ${c.grade.completeness}/5 · Clarity ${c.grade.clarity}/5`, leftX, ly + 22);
      }
      ctx.restore();
    });

    // Blind Judge Diamond Node
    const jy = h * 0.51;
    ctx.save();
    ctx.translate(judgeX, jy);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = pal.panel;
    ctx.strokeStyle = arena.winnerId ? pal.gold : pal.amber;
    ctx.lineWidth = 2.2;
    drawRoundedRect(ctx, -24, -24, 48, 48, 8);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.fillStyle = arena.winnerId ? pal.gold : pal.amber;
    ctx.font = '700 11px ui-monospace, SFMono-Regular, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(arena.winnerId ? '♛' : '⚖', judgeX, jy - 3);
    ctx.fillStyle = pal.text;
    ctx.font = '600 9px ui-monospace, SFMono-Regular, monospace';
    ctx.fillText('JUDGE', judgeX, jy + 11);
    if (arena.judge?.label) {
      ctx.fillStyle = pal.muted;
      ctx.font = '500 9.5px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(shortModel(arena.judge.label).slice(0, 14), judgeX, jy + 46);
    }
    ctx.restore();
  }

  function drawTimeline() {
    const canvas = document.getElementById('pantheon-timeline-canvas');
    const emptyEl = document.getElementById('pantheon-timeline-empty');
    const workers = data?.workers || [];
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

    const labelW = 112;
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
      const bw = Math.max(24, ((e - s) / span) * barAreaW);
      const color = st.tone === 'sage' ? pal.sage : st.tone === 'amber' ? pal.amber : st.tone === 'gold' ? pal.gold : st.tone === 'coral' ? pal.coral : roleColor(wk.role);

      timelineHitTargets.push({ workerId: wk.workerId, x: 8, y, w: w - 16, h: rowH - 6 });

      // Row divider
      ctx.strokeStyle = pal.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(8, y + rowH - 6);
      ctx.lineTo(w - 8, y + rowH - 6);
      ctx.stroke();

      // Label
      ctx.fillStyle = pal.text;
      ctx.font = '600 11px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(String(wk.role || 'worker').toUpperCase(), 12, y + 14);
      ctx.fillStyle = pal.muted;
      ctx.font = '500 9.5px ui-monospace, SFMono-Regular, monospace';
      ctx.fillText(shortModel(wk.modelLabel || wk.providerId || 'Auto').slice(0, 14), 12, y + 28);

      // Swimlane bar
      ctx.fillStyle = color;
      ctx.globalAlpha = wk.workerId === selectedWorkerId ? 0.98 : 0.78;
      drawRoundedRect(ctx, x1, y + 7, bw, 22, 6);
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.fillStyle = pal.isLight ? '#ffffff' : '#0c0d10';
      ctx.font = '700 10px ui-monospace, SFMono-Regular, monospace';
      ctx.textAlign = 'left';
      const barTxt = `${st.label} · ${fmtMs(wk.durationMs || (e - s))}`;
      if (bw > 74) ctx.fillText(barTxt, x1 + 8, y + 21);
    });
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

  window.G0DPantheon = {
    open,
    close,
    toggle,
    setLens,
    syncTask,
    ingestStreamEvent,
    loadSnapshot,
    startDemo,
    stopDemo,
    isOpen: () => isOpenState,
    getState: () => data,
  };
})();
