'use strict';

(function initG0DNorthStar() {
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  let runs = [];
  let templates = [];
  let selectedRunId = null;
  let selectedExps = [];
  let pollTimer = null;
  let formExpanded = false;
  let draftGoal = '';

  async function req(url, opts = {}) {
    const res = await fetch(url, {
      ...opts,
      headers: {
        'content-type': 'application/json',
        'x-g0d-request': '1',
        ...(opts.headers || {}),
      },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
    return json;
  }

  function renderSparkline(run) {
    const pts = (run?.scoreHistory || []).filter(p => Number.isFinite(Number(p.bestScore)));
    if (pts.length < 2) return '<span class="ns-spark-empty">Awaiting baseline &amp; first iteration…</span>';
    const vals = pts.map(p => Number(p.bestScore));
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    const w = 260, h = 54, pad = 6;
    const coords = pts.map((p, idx) => {
      const x = pad + (idx / Math.max(1, pts.length - 1)) * (w - pad * 2);
      const norm = (Number(p.bestScore) - min) / span;
      const y = h - pad - norm * (h - pad * 2);
      return { x: x.toFixed(1), y: y.toFixed(1), kept: p.status === 'kept' };
    });
    const poly = coords.map(c => `${c.x},${c.y}`).join(' ');
    const dots = coords.filter(c => c.kept).map(c => `<circle cx="${c.x}" cy="${c.y}" r="3" class="ns-spark-win"></circle>`).join('');
    return `<svg class="ns-sparkline" viewBox="0 0 ${w} ${h}" role="img" aria-label="Score progression sparkline"><polyline points="${poly}" fill="none" class="ns-spark-line"></polyline>${dots}</svg>`;
  }

  function fmtElapsed(ms) {
    const s = Math.max(0, Math.round(Number(ms || 0) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }

  async function refresh() {
    try {
      const data = await req('/api/northstar');
      runs = Array.isArray(data.runs) ? data.runs : [];
      templates = Array.isArray(data.templates) ? data.templates : [];
      if (window.state) window.state.northStarSummary = data.summary || null;
      if (typeof window.updateSettingsNavBadges === 'function') window.updateSettingsNavBadges();
      if (!selectedRunId && runs.length) selectedRunId = runs[0].id;
      if (selectedRunId && !runs.some(r => r.id === selectedRunId)) selectedRunId = runs[0]?.id || null;
      if (selectedRunId) {
        const detail = await req(`/api/northstar/${encodeURIComponent(selectedRunId)}`).catch(() => null);
        if (detail) selectedExps = detail.experiments || [];
      } else {
        selectedExps = [];
      }
      render();
      const anyRunning = runs.some(r => r.status === 'running');
      if (anyRunning && !pollTimer) {
        pollTimer = setInterval(() => { refresh().catch(() => {}); }, 3500);
      } else if (!anyRunning && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    } catch {}
  }

  function render() {
    const anchor = document.getElementById('northstar-runs-anchor');
    if (!anchor) return;
    const activeRun = runs.find(r => r.id === selectedRunId) || runs[0] || null;
    const tplChips = templates.map(t => `<button type="button" class="clp-tpl-chip" data-ns-template="${esc(t.id)}" title="${esc(t.description)}"><span>${esc(t.icon)}</span>${esc(t.label)}</button>`).join('');
    const runsListHtml = runs.length
      ? `<div class="ns-runs-strip">${runs.map(r => `<button type="button" class="ns-run-pill${activeRun?.id === r.id ? ' active' : ''} status-${esc(r.status)}" data-ns-select="${esc(r.id)}"><strong>${esc(r.name)}</strong><small>${esc(r.status)} · ${esc(r.iterations)}/${esc(r.maxIterations)}${r.bestScore !== null ? ` · ${r.bestScore}` : ''}</small></button>`).join('')}</div>`
      : '';

    const activeCardHtml = activeRun ? `
      <div class="ns-mission-control">
        <div class="ns-mc-head">
          <div>
            <h4>★ ${esc(activeRun.name)}</h4>
            <p class="field-help">${esc(activeRun.direction)} · <code>${esc(activeRun.evalCommand)}</code> · ${esc(activeRun.repoPath)}</p>
          </div>
          <span class="meta-chip">${esc(activeRun.status.toUpperCase())}</span>
        </div>
        <div class="ns-mc-metrics">
          <div class="ns-metric-box"><span>Baseline</span><strong>${esc(activeRun.baselineScore ?? '—')}</strong></div>
          <div class="ns-metric-box is-best"><span>Champion</span><strong>${esc(activeRun.bestScore ?? '—')}</strong></div>
          <div class="ns-metric-box"><span>Kept / Iter</span><strong>${esc(activeRun.keptCount)} / ${esc(activeRun.iterations)}</strong></div>
          <div class="ns-metric-box"><span>Elapsed</span><strong>${esc(fmtElapsed(activeRun.elapsedMs))}</strong></div>
        </div>
        <div class="ns-spark-wrap">${renderSparkline(activeRun)}</div>
        ${activeRun.pauseReason ? `<p class="field-help">${esc(activeRun.pauseReason)}</p>` : ''}
        <div class="ns-mc-actions">
          ${activeRun.status === 'running'
            ? `<button type="button" class="button button-secondary" data-ns-action="pause" data-ns-id="${esc(activeRun.id)}">Pause</button>`
            : activeRun.status !== 'completed'
              ? `<button type="button" class="button button-primary" data-ns-action="start" data-ns-id="${esc(activeRun.id)}">${activeRun.iterations > 0 ? 'Resume Run →' : 'Start Run →'}</button>`
              : ''}
          <button type="button" class="button button-secondary" data-ns-action="diff" data-ns-id="${esc(activeRun.id)}">Inspect Champion Diff</button>
          <button type="button" class="button button-secondary" data-ns-action="apply" data-ns-id="${esc(activeRun.id)}" ${activeRun.status === 'running' ? 'disabled' : ''}>Apply to Repo</button>
          <button type="button" class="button button-quiet" data-ns-action="delete" data-ns-id="${esc(activeRun.id)}">Delete</button>
        </div>
        <form class="ns-steer-form" id="ns-steer-form" data-ns-id="${esc(activeRun.id)}" autocomplete="off">
          <input type="text" id="ns-steer-input" placeholder="Steer next iteration mid-flight (e.g. try batching or cache lookups)…" aria-label="Steer next North Star iteration" maxlength="1000">
          <button type="submit" class="button button-secondary">Queue Steer</button>
        </form>
        <pre id="ns-diff-output" class="wire-pre hidden" tabindex="0"></pre>
        ${selectedExps.length ? `<div class="ns-exp-tape" aria-label="Experiment tape">${selectedExps.slice(-12).reverse().map(e => `<div class="ns-exp-row status-${esc(e.status)}"><span class="ns-exp-tag">${e.status === 'kept' ? '✓' : e.status === 'reverted' ? '✗' : '⚠'} #${esc(e.iteration)}</span><span class="ns-exp-hyp">${esc(e.hypothesis)}</span><span class="ns-exp-score">${e.score !== null && e.score !== undefined ? esc(e.score) : esc(e.status)}</span></div>`).join('')}</div>` : ''}
      </div>` : '';

    anchor.innerHTML = `
      <section class="settings-card ns-card" id="northstar-card">
        <div class="settings-card-head">
          <div>
            <h4>★ North Star AutoResearch (Multi-Hour / Multi-Day Hill Climbs)</h4>
            <p>Git-atomic keep-or-revert optimization with fresh context per iteration, dead-end graveyard, plateau escalation &amp; crash-proof resume.</p>
          </div>
          <button type="button" class="button button-primary" id="ns-toggle-new">${formExpanded ? 'Hide Launcher' : '+ New North Star'}</button>
        </div>
        ${runsListHtml}
        ${activeCardHtml}
        <form id="ns-create-form" class="ns-create-form${formExpanded || !runs.length ? '' : ' hidden'}" autocomplete="off">
          <div class="clp-templates">${tplChips}</div>
          <div class="ns-step-grid">
            <label class="field-label">1. North Star Goal
              <textarea id="ns-goal" rows="2" placeholder="e.g. Minimize p50 benchmark latency in src/parser.mjs while keeping npm test green…" required>${esc(draftGoal)}</textarea>
            </label>
            <div class="two-fields">
              <label class="field-label">Repository Path
                <input type="text" id="ns-repo" placeholder="/path/to/your/repo" required>
              </label>
              <label class="field-label">2. Eval Command
                <input type="text" id="ns-eval-cmd" placeholder="e.g. npm run bench or python3 train.py" required>
              </label>
            </div>
            <div class="three-fields">
              <label class="field-label">Metric Regex / JSON Key
                <input type="text" id="ns-metric-pattern" placeholder="score:\\s*([0-9.]+)" value="(?:score|ms|val_bpb|loss)\\s*[:=]\\s*([0-9]+(?:\\.[0-9]+)?)">
              </label>
              <label class="field-label">Direction
                <select id="ns-direction"><option value="minimize">Minimize (lower is better)</option><option value="maximize">Maximize (higher is better)</option></select>
              </label>
              <label class="field-label">3. Budget (Hours · Iters)
                <div class="ns-budget-pair"><input type="number" id="ns-hours" min="0.1" max="168" step="0.5" value="8" aria-label="Max hours"><input type="number" id="ns-iters" min="1" max="5000" value="50" aria-label="Max iterations"></div>
              </label>
            </div>
            <details class="settings-disclosure">
              <summary>Advanced: Guardrail tests, editable file allowlist, beams &amp; keep-awake</summary>
              <div class="two-fields">
                <label class="field-label">Guardrail Command (must exit 0)
                  <input type="text" id="ns-guardrail" placeholder="e.g. npm test">
                </label>
                <label class="field-label">Target Score (optional early stop)
                  <input type="number" id="ns-target" step="any" placeholder="e.g. 0.85">
                </label>
              </div>
              <div class="two-fields">
                <label class="field-label">Editable Files Allowlist (optional)
                  <input type="text" id="ns-allowlist" placeholder="e.g. src/parser.mjs, train.py">
                </label>
                <label class="field-label">Evolutionary Beam Width (1–3)
                  <select id="ns-beam"><option value="1">1 · Greedy Champion</option><option value="2">2 · Dual Beam</option><option value="3">3 · Top-3 Islands</option></select>
                </label>
              </div>
              <div class="setting-row"><label for="ns-keep-awake">Keep Mac awake while running (<code>caffeinate -i</code>)<small>Prevents macOS idle sleep during overnight or multi-day runs.</small></label><input type="checkbox" role="switch" class="toggle" id="ns-keep-awake" checked></div>
            </details>
            <div class="ns-form-actions">
              <button type="submit" class="button button-primary" id="ns-launch-btn">★ Launch North Star Run →</button>
              <span class="field-help" id="ns-form-feedback" role="status"></span>
            </div>
          </div>
        </form>
      </section>
    `;
  }

  document.addEventListener('click', async event => {
    const anchor = document.getElementById('northstar-runs-anchor');
    if (!anchor || !anchor.contains(event.target)) return;
    if (event.target.closest('#ns-toggle-new')) {
      formExpanded = !formExpanded;
      render();
      return;
    }
    const tplBtn = event.target.closest('[data-ns-template]');
    if (tplBtn) {
      const tpl = templates.find(t => t.id === tplBtn.dataset.nsTemplate);
      if (tpl) {
        const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
        setVal('ns-goal', tpl.goal);
        setVal('ns-eval-cmd', tpl.evalCommand);
        setVal('ns-metric-pattern', tpl.metricPattern);
        setVal('ns-direction', tpl.direction);
        setVal('ns-guardrail', tpl.guardrailCommand || '');
        setVal('ns-hours', String(tpl.maxHours));
        setVal('ns-iters', String(tpl.maxIterations));
      }
      return;
    }
    const selBtn = event.target.closest('[data-ns-select]');
    if (selBtn) {
      selectedRunId = selBtn.dataset.nsSelect;
      await refresh();
      return;
    }
    const actBtn = event.target.closest('[data-ns-action]');
    if (actBtn) {
      const action = actBtn.dataset.nsAction;
      const id = actBtn.dataset.nsId;
      try {
        if (action === 'start') {
          await req(`/api/northstar/${encodeURIComponent(id)}/start`, { method: 'POST', body: '{}' });
          window.toast?.('★ North Star run started.');
        } else if (action === 'pause') {
          await req(`/api/northstar/${encodeURIComponent(id)}/pause`, { method: 'POST', body: '{}' });
          window.toast?.('North Star run paused cleanly.');
        } else if (action === 'diff') {
          const res = await req(`/api/northstar/${encodeURIComponent(id)}/diff`);
          const pre = document.getElementById('ns-diff-output');
          if (pre) {
            pre.textContent = res.diff ? `${res.stat}\n\n${res.diff}` : 'Champion matches baseline (no diff yet).';
            pre.classList.remove('hidden');
          }
          return;
        } else if (action === 'apply') {
          const res = await req(`/api/northstar/${encodeURIComponent(id)}/apply`, { method: 'POST', body: '{}' });
          window.toast?.(res.applied ? `✓ Applied champion patch (score ${res.bestScore}) to repo!` : (res.message || 'Nothing to apply.'));
        } else if (action === 'delete') {
          await req(`/api/northstar/${encodeURIComponent(id)}`, { method: 'DELETE' });
          if (selectedRunId === id) selectedRunId = null;
          window.toast?.('Deleted North Star run.');
        }
        await refresh();
      } catch (err) {
        window.toast?.(err.message || 'North Star action failed.');
      }
    }
  });

  document.addEventListener('submit', async event => {
    if (event.target?.id === 'ns-create-form') {
      event.preventDefault();
      const fb = document.getElementById('ns-form-feedback');
      const btn = document.getElementById('ns-launch-btn');
      if (btn) btn.disabled = true;
      if (fb) fb.textContent = 'Creating isolated git worktree & measuring baseline…';
      try {
        const payload = {
          goal: document.getElementById('ns-goal')?.value || '',
          repoPath: document.getElementById('ns-repo')?.value || '',
          evalCommand: document.getElementById('ns-eval-cmd')?.value || '',
          metricMode: 'regex',
          metricPattern: document.getElementById('ns-metric-pattern')?.value || '',
          direction: document.getElementById('ns-direction')?.value || 'minimize',
          maxHours: Number(document.getElementById('ns-hours')?.value || 8),
          maxIterations: Number(document.getElementById('ns-iters')?.value || 50),
          guardrailCommand: document.getElementById('ns-guardrail')?.value || '',
          targetScore: document.getElementById('ns-target')?.value || null,
          editableFiles: document.getElementById('ns-allowlist')?.value || '',
          beamWidth: Number(document.getElementById('ns-beam')?.value || 1),
          keepAwake: Boolean(document.getElementById('ns-keep-awake')?.checked),
          autoStart: true,
        };
        const res = await req('/api/northstar', { method: 'POST', body: JSON.stringify(payload) });
        selectedRunId = res.run?.id || null;
        formExpanded = false;
        draftGoal = '';
        window.toast?.(`★ North Star "${res.run?.name}" launched in isolated worktree!`);
        await refresh();
      } catch (err) {
        if (fb) fb.textContent = err.message || 'Failed to launch run.';
        window.toast?.(err.message || 'Failed to launch North Star run.');
      } finally {
        if (btn) btn.disabled = false;
      }
      return;
    }
    if (event.target?.id === 'ns-steer-form') {
      event.preventDefault();
      const id = event.target.dataset.nsId;
      const input = document.getElementById('ns-steer-input');
      const note = (input?.value || '').trim();
      if (!id || !note) return;
      try {
        await req(`/api/northstar/${encodeURIComponent(id)}/steer`, { method: 'POST', body: JSON.stringify({ note }) });
        if (input) input.value = '';
        window.toast?.('★ Steering directive queued for the next iteration.');
        await refresh();
      } catch (err) {
        window.toast?.(err.message || 'Could not queue steering note.');
      }
    }
  });

  window.G0DNorthStar = {
    refresh,
    openLauncher(prefillGoal = '') {
      formExpanded = true;
      if (prefillGoal) draftGoal = prefillGoal;
      if (typeof window.openSettings === 'function') {
        window.openSettings('schedules').then(() => {
          refresh().then(() => {
            const repoInput = document.getElementById('ns-repo');
            if (repoInput && !repoInput.value) {
              const activePath = window.selectedData?.task?.sourcePath || window.pendingProject?.path || '';
              if (activePath) repoInput.value = activePath;
            }
          });
        });
      }
    },
  };
})();
