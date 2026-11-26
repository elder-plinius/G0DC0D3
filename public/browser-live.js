'use strict';

(function initG0DBrowserLive() {
  let isOpenState = false;
  let isExpanded = false;
  let currentTaskId = null;
  let statusData = null;
  let browserSettings = { visibleWindow: false, liveMirror: true, autoOpenMirror: true };
  let autoOpenedTaskIds = new Set();
  let recentActions = [];
  let consoleOpen = false;
  let modeBusy = false;

  // Live frame & reticle animation state
  let currentImg = null;
  let currentImgSeq = 0;
  let frameInFlight = false;
  let pendingFrameUrl = null;
  let pendingFrameSeq = 0;
  let reticle = null; // { x, y, action, label, bornAt, viewport }
  let rafId = null;

  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const dockEl = () => document.getElementById('browser-dock');

  function motionReduced() {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return true;
    try { return Boolean(window.G0DQol?.get?.()?.pauseBackdrop); } catch { return false; }
  }

  function themePalette() {
    const cs = getComputedStyle(document.documentElement);
    const isLight = document.documentElement.dataset.theme === 'light';
    return {
      isLight,
      bg: cs.getPropertyValue('--surface').trim() || (isLight ? '#f4f2ee' : '#0f1012'),
      panel: cs.getPropertyValue('--panel').trim() || (isLight ? '#ffffff' : '#16171a'),
      line: cs.getPropertyValue('--line').trim() || (isLight ? 'rgba(20,24,31,0.12)' : 'rgba(255,255,255,0.1)'),
      text: cs.getPropertyValue('--text').trim() || (isLight ? '#18191b' : '#f4f4f6'),
      muted: cs.getPropertyValue('--text-muted').trim() || (isLight ? '#646873' : '#8d92a0'),
      violet: cs.getPropertyValue('--violet').trim() || (isLight ? '#6d28d9' : '#a78bfa'),
      sage: cs.getPropertyValue('--sage').trim() || (isLight ? '#15803d' : '#4ade80'),
      gold: '#fbbf24',
      coral: '#f87171',
    };
  }

  function ensureShell() {
    const dock = dockEl();
    if (!dock || dock.dataset.browserInit) return dock;
    dock.dataset.browserInit = '1';
    dock.innerHTML = `
      <header class="bl-header">
        <div class="bl-title-wrap">
          <span class="bl-live-dot" id="bl-live-dot" aria-hidden="true"></span>
          <div class="bl-title-copy">
            <h2 class="bl-title">LIVE BROWSER</h2>
            <p class="bl-subtitle" id="bl-subtitle">Contained agent Chromium viewport</p>
          </div>
        </div>
        <div class="bl-header-actions">
          <span class="bl-mode-chip" id="bl-mode-chip">Standby</span>
          <button type="button" class="button button-secondary bl-mode-btn" id="bl-mode-toggle" title="Switch between headless mirror and visible Chromium window">↗ Pop Out</button>
          <button type="button" class="icon-button" id="bl-expand" title="Expand or restore browser mirror" aria-label="Expand browser mirror" aria-pressed="false">⤢</button>
          <button type="button" class="icon-button" id="bl-close" title="Close live browser panel" aria-label="Close live browser panel">×</button>
        </div>
      </header>
      <div class="bl-url-bar">
        <span class="bl-lock-icon" aria-hidden="true">◎</span>
        <code class="bl-url-text" id="bl-url-text">about:blank</code>
        <button type="button" class="button button-quiet bl-console-btn hidden" id="bl-console-toggle" title="Toggle browser console &amp; network log">0 logs</button>
        <button type="button" class="button button-quiet bl-stop-btn hidden" id="bl-stop-session" title="Close contained browser session">Stop</button>
      </div>
      <div class="bl-window-banner hidden" id="bl-window-banner">
        <span>Visible Chromium window is open — click directly inside it for logins, 2FA, or 60fps interaction.</span>
        <button type="button" class="button button-quiet" id="bl-return-headless">Return to Headless</button>
      </div>
      <div class="bl-stage-wrap">
        <canvas id="browser-live-canvas" class="bl-canvas" aria-label="Live agent browser viewport"></canvas>
        <div class="bl-empty" id="bl-empty">
          <div class="bl-empty-icon" aria-hidden="true">◎</div>
          <strong>No active browser session</strong>
          <p>Ask an agent to open a URL or test a local app (e.g. <code>go to http://localhost:3000</code>). Frames stream live right here—or click <strong>Pop Out</strong> anytime to watch in a real window.</p>
          <div class="bl-empty-actions">
            <button type="button" class="button button-secondary" id="bl-empty-mode-btn">Enable Visible Window by Default</button>
          </div>
        </div>
      </div>
      <div class="bl-console hidden" id="bl-console"></div>
      <footer class="bl-ribbon" id="bl-ribbon" aria-label="Recent browser actions">
        <span class="bl-ribbon-empty">Waiting for agent browser actions…</span>
      </footer>
    `;

    dock.addEventListener('click', (e) => {
      if (e.target.closest('#bl-close')) { close(); return; }
      if (e.target.closest('#bl-expand')) { toggleExpand(); return; }
      if (e.target.closest('#bl-mode-toggle')) { toggleWindowMode(); return; }
      if (e.target.closest('#bl-return-headless')) { setWindowMode(false); return; }
      if (e.target.closest('#bl-empty-mode-btn')) { toggleDefaultVisibleWindow(); return; }
      if (e.target.closest('#bl-stop-session')) { stopSession(); return; }
      if (e.target.closest('#bl-console-toggle')) {
        consoleOpen = !consoleOpen;
        renderConsole();
      }
    });

    window.addEventListener('resize', () => {
      if (isOpenState) drawCanvas();
    });

    return dock;
  }

  function updateHeaderButton() {
    const btn = document.getElementById('browser-toggle-btn');
    if (!btn) return;
    const active = Boolean(statusData?.active);
    btn.classList.toggle('hidden', !active && !isOpenState);
    btn.classList.toggle('is-open', isOpenState);
    btn.classList.toggle('is-live', active);
    btn.setAttribute('aria-pressed', String(isOpenState));
    const tag = btn.querySelector('.browser-btn-tag');
    if (tag) {
      if (!active) {
        tag.textContent = '';
        tag.className = 'browser-btn-tag hidden';
      } else {
        tag.textContent = statusData?.visibleWindow ? 'WIN' : 'LIVE';
        tag.className = `browser-btn-tag ${statusData?.visibleWindow ? 'is-win' : 'is-live'}`;
      }
    }
  }

  function renderUI() {
    updateHeaderButton();
    if (!dockEl()?.dataset.browserInit) return;
    const active = Boolean(statusData?.active);
    const visibleWin = Boolean(active ? statusData?.visibleWindow : browserSettings?.visibleWindow);

    const dot = document.getElementById('bl-live-dot');
    if (dot) dot.className = `bl-live-dot ${active ? (visibleWin ? 'is-win' : 'is-live') : ''}`;

    const chip = document.getElementById('bl-mode-chip');
    if (chip) {
      chip.textContent = !active ? (visibleWin ? 'Window Ready' : 'Standby') : visibleWin ? 'Visible Window' : 'Live Mirror';
      chip.className = `bl-mode-chip ${active ? (visibleWin ? 'is-win' : 'is-live') : ''}`;
    }

    const sub = document.getElementById('bl-subtitle');
    if (sub) {
      sub.textContent = active && statusData?.title
        ? statusData.title
        : visibleWin
          ? 'Non-headless isolated Chromium window'
          : 'Headless CDP screencast · ephemeral profile';
    }

    const urlEl = document.getElementById('bl-url-text');
    if (urlEl) {
      urlEl.textContent = active && statusData?.url ? statusData.url : 'about:blank';
      urlEl.title = active && statusData?.url ? statusData.url : '';
    }

    const modeBtn = document.getElementById('bl-mode-toggle');
    if (modeBtn) {
      modeBtn.disabled = modeBusy;
      modeBtn.textContent = modeBusy ? 'Switching…' : (visibleWin ? '▣ Headless' : '↗ Pop Out');
      modeBtn.title = visibleWin
        ? 'Relaunch this isolated session in headless mirror mode (preserves page & cookies)'
        : 'Pop out this isolated session into a real visible Chromium window (preserves page & cookies)';
    }

    const emptyModeBtn = document.getElementById('bl-empty-mode-btn');
    if (emptyModeBtn) {
      emptyModeBtn.disabled = modeBusy;
      emptyModeBtn.textContent = browserSettings?.visibleWindow
        ? 'Visible Window Default: ON (Switch to Headless)'
        : 'Enable Visible Window by Default';
    }

    const banner = document.getElementById('bl-window-banner');
    if (banner) banner.classList.toggle('hidden', !(active && visibleWin));

    const stopBtn = document.getElementById('bl-stop-session');
    if (stopBtn) stopBtn.classList.toggle('hidden', !active);

    const errs = statusData?.consoleErrors || [];
    const consBtn = document.getElementById('bl-console-toggle');
    if (consBtn) {
      consBtn.classList.toggle('hidden', !active);
      consBtn.textContent = `${errs.length} log${errs.length === 1 ? '' : 's'}`;
      consBtn.classList.toggle('has-errors', errs.some(e => e.level === 'error' || e.level === 'network'));
    }

    const emptyEl = document.getElementById('bl-empty');
    const canvas = document.getElementById('browser-live-canvas');
    const showCanvas = active && Boolean(currentImg || statusData?.hasFrame);
    if (emptyEl) emptyEl.classList.toggle('hidden', showCanvas);
    if (canvas) canvas.classList.toggle('hidden', !showCanvas);

    renderConsole();
    renderRibbon();
    if (showCanvas) requestAnimationFrame(() => { if (isOpenState) drawCanvas(); });
  }

  function renderConsole() {
    const el = document.getElementById('bl-console');
    if (!el) return;
    const errs = statusData?.consoleErrors || [];
    const show = consoleOpen && Boolean(statusData?.active);
    el.classList.toggle('hidden', !show);
    if (!show) return;
    el.innerHTML = errs.length
      ? errs.slice(-10).reverse().map(e => `<div class="bl-log-row level-${esc(e.level || 'info')}"><span class="bl-log-lvl">${esc(String(e.level || 'log').toUpperCase())}</span><code>${esc(e.message || '')}</code></div>`).join('')
      : '<div class="bl-log-empty">No console or network errors recorded.</div>';
  }

  function renderRibbon() {
    const el = document.getElementById('bl-ribbon');
    if (!el) return;
    if (!recentActions.length) {
      el.innerHTML = '<span class="bl-ribbon-empty">Waiting for agent browser actions…</span>';
      return;
    }
    el.innerHTML = recentActions.slice(0, 4).map((a, idx) => {
      const coords = Number.isFinite(a.x) && Number.isFinite(a.y) ? ` (${a.x},${a.y})` : '';
      return `<span class="bl-act-chip ${idx === 0 ? 'is-latest' : ''}"><strong>${esc(String(a.action || 'act').toUpperCase())}</strong><span>${esc(String(a.label || '').slice(0, 28))}${esc(coords)}</span></span>`;
    }).join('');
  }

  function fetchFrame(url, seq = 0) {
    if (!url || !isOpenState) return;
    if (frameInFlight) {
      pendingFrameUrl = url;
      pendingFrameSeq = seq;
      return;
    }
    frameInFlight = true;
    const img = new Image();
    img.onload = () => {
      frameInFlight = false;
      currentImg = img;
      if (seq > currentImgSeq) currentImgSeq = seq;
      if (statusData) statusData.hasFrame = true;
      renderUI();
      if (pendingFrameUrl) {
        const nextUrl = pendingFrameUrl;
        const nextSeq = pendingFrameSeq;
        pendingFrameUrl = null;
        pendingFrameSeq = 0;
        fetchFrame(nextUrl, nextSeq);
      }
    };
    img.onerror = () => {
      frameInFlight = false;
      pendingFrameUrl = null;
      pendingFrameSeq = 0;
    };
    img.src = url;
  }

  function drawCanvas() {
    const canvas = document.getElementById('browser-live-canvas');
    if (!canvas || canvas.classList.contains('hidden')) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pal = themePalette();
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, w, h);

    if (!currentImg || !currentImg.naturalWidth || !currentImg.naturalHeight) return;

    // Aspect-fit frame inside viewport with subtle rounded frame shadow
    const pad = 10;
    const availW = Math.max(40, w - pad * 2);
    const availH = Math.max(40, h - pad * 2);
    const scale = Math.min(availW / currentImg.naturalWidth, availH / currentImg.naturalHeight);
    const drawW = currentImg.naturalWidth * scale;
    const drawH = currentImg.naturalHeight * scale;
    const ox = (w - drawW) / 2;
    const oy = (h - drawH) / 2;

    ctx.save();
    ctx.drawImage(currentImg, ox, oy, drawW, drawH);
    ctx.strokeStyle = pal.line;
    ctx.lineWidth = 1;
    ctx.strokeRect(ox + 0.5, oy + 0.5, drawW - 1, drawH - 1);

    // Animated agent cursor + click-ripple reticle
    if (reticle && Number.isFinite(reticle.x) && Number.isFinite(reticle.y)) {
      const age = Date.now() - reticle.bornAt;
      if (age < 2600) {
        const vpW = reticle.viewport?.width || statusData?.viewport?.width || currentImg.naturalWidth || 1280;
        const vpH = reticle.viewport?.height || statusData?.viewport?.height || currentImg.naturalHeight || 800;
        const rx = ox + (reticle.x / vpW) * drawW;
        const ry = oy + (reticle.y / vpH) * drawH;
        const fade = Math.max(0, 1 - age / 2600);
        const rippleP = Math.min(1, age / 700);
        const accent = reticle.action === 'type' ? pal.gold : pal.violet;

        // Expanding ripple ring
        ctx.strokeStyle = accent;
        ctx.globalAlpha = fade * (1 - rippleP * 0.75);
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.arc(rx, ry, 8 + rippleP * 26, 0, Math.PI * 2);
        ctx.stroke();

        // Inner target core
        ctx.globalAlpha = Math.min(1, fade * 1.4);
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(rx, ry, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Action tag pill next to cursor
        const tag = `${String(reticle.action || 'ACT').toUpperCase()}${reticle.label ? ` · ${String(reticle.label).slice(0, 18)}` : ''}`;
        ctx.font = '700 10px ui-monospace, SFMono-Regular, monospace';
        const tw = ctx.measureText(tag).width + 14;
        const tx = Math.min(ox + drawW - tw - 6, Math.max(ox + 6, rx + 12));
        const ty = Math.max(oy + 6, ry - 26);
        ctx.fillStyle = 'rgba(14, 15, 19, 0.88)';
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(tx, ty, tw, 20, 6);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(tag, tx + 7, ty + 10);
      } else {
        reticle = null;
      }
    }
    ctx.restore();
  }

  function startReticleLoop() {
    if (rafId !== null || motionReduced()) return;
    const step = () => {
      if (!isOpenState || !reticle || Date.now() - reticle.bornAt >= 2600) {
        rafId = null;
        if (isOpenState) drawCanvas();
        return;
      }
      if (!document.hidden) drawCanvas();
      rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
  }

  async function setScreencast(taskId, active) {
    if (!taskId) return;
    try {
      await fetch(`/api/tasks/${encodeURIComponent(taskId)}/browser/screencast`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
        body: JSON.stringify({ active: Boolean(active) }),
      });
    } catch {}
  }

  async function loadStatus(taskId = currentTaskId) {
    try {
      const sRes = await fetch('/api/browser/settings');
      if (sRes.ok) {
        const sJson = await sRes.json();
        if (sJson?.settings) browserSettings = sJson.settings;
      }
    } catch {}
    if (!taskId) {
      statusData = null;
      renderUI();
      return null;
    }
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/browser/status`);
      if (!res.ok) return null;
      const st = await res.json();
      if (taskId !== currentTaskId) return null;
      statusData = st;
      if (st.settings) browserSettings = st.settings;
      if (st.lastAction) pushAction(st.lastAction);
      renderUI();
      if (isOpenState && st.active && st.hasFrame) {
        fetchFrame(`/api/tasks/${encodeURIComponent(taskId)}/browser/frame?v=${st.frameSeq || Date.now()}`, st.frameSeq || 0);
      }
      return st;
    } catch {
      return null;
    }
  }

  function pushAction(act) {
    if (!act || !act.action) return;
    const prev = recentActions[0];
    if (prev && prev.time === act.time && prev.action === act.action) return;
    recentActions.unshift(act);
    if (recentActions.length > 8) recentActions.length = 8;
  }

  async function toggleDefaultVisibleWindow() {
    modeBusy = true;
    renderUI();
    try {
      const next = !browserSettings.visibleWindow;
      const res = await fetch('/api/browser/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
        body: JSON.stringify({ visibleWindow: next }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not update browser settings.');
      if (json.settings) browserSettings = json.settings;
      if (typeof window.toast === 'function') {
        window.toast(next ? 'Visible Chromium window enabled for new browser sessions.' : 'Headless mirror restored as default.');
      }
      if (typeof window.loadBrowserSettings === 'function') window.loadBrowserSettings();
    } catch (err) {
      if (typeof window.toast === 'function') window.toast(err.message || 'Could not update browser mode.');
    } finally {
      modeBusy = false;
      renderUI();
    }
  }

  async function setWindowMode(visibleWindow, { persist = false } = {}) {
    if (!currentTaskId || !statusData?.active) {
      await fetch('/api/browser/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
        body: JSON.stringify({ visibleWindow: Boolean(visibleWindow) }),
      }).then(r => r.json()).then(j => { if (j?.settings) browserSettings = j.settings; }).catch(() => {});
      renderUI();
      if (typeof window.loadBrowserSettings === 'function') window.loadBrowserSettings();
      if (typeof window.toast === 'function') {
        window.toast(visibleWindow ? 'Next browser session will open in a visible Chromium window.' : 'Browser sessions set to headless live mirror.');
      }
      return;
    }
    modeBusy = true;
    renderUI();
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(currentTaskId)}/browser/mode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
        body: JSON.stringify({ visibleWindow: Boolean(visibleWindow), persist }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not switch browser mode.');
      statusData = json;
      if (json.settings) browserSettings = json.settings;
      if (isOpenState && json.active && json.hasFrame) {
        fetchFrame(`/api/tasks/${encodeURIComponent(currentTaskId)}/browser/frame?v=${json.frameSeq || Date.now()}`, json.frameSeq || 0);
      }
      if (typeof window.toast === 'function') {
        window.toast(json.visibleWindow
          ? 'Popped out into a visible isolated Chromium window (session preserved).'
          : 'Returned to headless live mirror (session preserved).');
      }
    } catch (err) {
      if (typeof window.toast === 'function') window.toast(err.message || 'Mode switch failed.');
    } finally {
      modeBusy = false;
      renderUI();
    }
  }

  function toggleWindowMode() {
    const active = Boolean(statusData?.active);
    const curVisible = Boolean(active ? statusData?.visibleWindow : browserSettings?.visibleWindow);
    return setWindowMode(!curVisible);
  }

  async function stopSession() {
    if (!currentTaskId) return;
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(currentTaskId)}/browser/close`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
        body: '{}',
      });
      if (res.ok) statusData = await res.json();
      currentImg = null;
      reticle = null;
      renderUI();
      if (typeof window.toast === 'function') window.toast('Contained browser session closed.');
    } catch {}
  }

  function toggleExpand() {
    isExpanded = !isExpanded;
    const dock = dockEl();
    dock?.classList.toggle('is-expanded', isExpanded);
    const btn = document.getElementById('bl-expand');
    if (btn) btn.setAttribute('aria-pressed', String(isExpanded));
    requestAnimationFrame(() => drawCanvas());
  }

  function open() {
    const dock = ensureShell();
    if (!dock) return;
    // Keep right-hand split docks mutually exclusive
    const artDock = document.getElementById('artifact-dock');
    const artSplit = document.getElementById('artifact-splitter');
    if (artDock && !artDock.classList.contains('hidden')) {
      artDock.classList.add('hidden');
      artSplit?.classList.add('hidden');
    }
    if (window.G0DConclave?.isOpen?.()) window.G0DConclave.close();
    isOpenState = true;
    dock.classList.remove('hidden');
    document.body.classList.add('browser-open');
    renderUI();
    if (currentTaskId) {
      setScreencast(currentTaskId, true);
      loadStatus(currentTaskId);
    }
  }

  function close() {
    const prevTask = currentTaskId;
    isOpenState = false;
    isExpanded = false;
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    const dock = dockEl();
    if (dock) {
      dock.classList.add('hidden');
      dock.classList.remove('is-expanded');
    }
    document.body.classList.remove('browser-open');
    if (prevTask) setScreencast(prevTask, false);
    updateHeaderButton();
  }

  function toggle() {
    if (isOpenState) close();
    else open();
  }

  function syncTask(task) {
    const nextId = task?.id || null;
    if (nextId !== currentTaskId) {
      if (currentTaskId && isOpenState) setScreencast(currentTaskId, false);
      currentTaskId = nextId;
      statusData = null;
      currentImg = null;
      currentImgSeq = 0;
      recentActions = [];
      reticle = null;
      if (nextId && isOpenState) setScreencast(nextId, true);
    }
    loadStatus(nextId);
  }

  function ingestStreamEvent(delta) {
    if (!delta || !currentTaskId) return;
    if (delta.taskId && delta.taskId !== currentTaskId) return;
    if (delta.type === 'browser.closed') {
      statusData = { ...(statusData || {}), active: false, screencastActive: false, hasFrame: false };
      currentImg = null;
      reticle = null;
      renderUI();
      return;
    }
    if (delta.type === 'browser.status' || delta.type === 'browser.activity' || delta.type === 'browser.frame') {
      statusData = {
        ...(statusData || {}),
        active: delta.active !== false,
        headless: typeof delta.headless === 'boolean' ? delta.headless : (statusData?.headless ?? true),
        visibleWindow: typeof delta.headless === 'boolean' ? !delta.headless : (statusData?.visibleWindow ?? false),
        url: delta.url || statusData?.url || 'about:blank',
        title: delta.title ?? statusData?.title ?? '',
        viewport: delta.viewport || statusData?.viewport || { width: 1280, height: 800 },
        hasFrame: delta.type === 'browser.frame' ? true : (statusData?.hasFrame || false),
      };
      if (delta.type === 'browser.activity') {
        pushAction({ action: delta.action, label: delta.label, x: delta.x, y: delta.y, url: delta.url, time: delta.time || Date.now() });
        if (Number.isFinite(delta.x) && Number.isFinite(delta.y)) {
          reticle = { x: delta.x, y: delta.y, action: delta.action, label: delta.label, viewport: delta.viewport || statusData.viewport, bornAt: Date.now() };
          if (isOpenState) startReticleLoop();
        }
        // Gently auto-open Live Browser mirror the first time an agent browses on this task (unless Conclave is open)
        if (browserSettings.liveMirror && browserSettings.autoOpenMirror && !isOpenState && !window.G0DConclave?.isOpen?.() && !autoOpenedTaskIds.has(currentTaskId)) {
          autoOpenedTaskIds.add(currentTaskId);
          open();
        }
      }
      if (delta.type === 'browser.frame' && isOpenState && delta.frameUrl) {
        fetchFrame(delta.frameUrl, Number(delta.seq) || Date.now());
      } else {
        renderUI();
      }
    }
  }

  window.G0DBrowserLive = {
    open,
    close,
    toggle,
    syncTask,
    ingestStreamEvent,
    loadStatus,
    setWindowMode,
    toggleWindowMode,
    stopSession,
    isOpen: () => isOpenState,
    getStatus: () => statusData,
  };
})();
