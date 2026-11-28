'use strict';

(() => {
  const STORAGE_KEY = 'g0dc0d3.alerts.v1';
  const LEGACY_QOL_KEY = 'g0dc0d3.qol.v1';

  const SOUND_PACKS = Object.freeze([
    { id: 'glass', label: 'Crystal Glass', hint: 'Clean harmonic chime' },
    { id: 'synth', label: 'Warm Synth', hint: 'Warm polyphonic chord' },
    { id: 'minimal', label: 'Studio Tap', hint: 'Soft, low-profile pulse' },
    { id: 'retro', label: 'Retro 8-bit', hint: 'Crisp chiptune arpeggio' },
    { id: 'system', label: 'macOS System', hint: 'Native macOS NSSound (falls back in browser)' },
  ]);
  const PACK_IDS = new Set(SOUND_PACKS.map(p => p.id));

  const EVENT_META = Object.freeze({
    completed: {
      label: 'Task or reply finished',
      hint: 'Alert when an active build, chat reply, or agent run completes.',
      sampleTitle: 'Build finished',
      sampleBody: 'Your task completed and passed checks.',
      systemSound: 'Glass',
      urgent: false,
    },
    approval: {
      label: 'Approval required',
      hint: 'Alert when a tool call or command pauses waiting for your permission.',
      sampleTitle: 'Approval required',
      sampleBody: 'A command is waiting for your confirmation.',
      systemSound: 'Ping',
      urgent: true,
    },
    error: {
      label: 'Error, blocked, or paused',
      hint: 'Alert when a task fails, hits a budget limit, or gets blocked.',
      sampleTitle: 'Task needs attention',
      sampleBody: 'A run paused or hit an error and needs review.',
      systemSound: 'Basso',
      urgent: true,
    },
    schedule: {
      label: 'Scheduled cron job finished',
      hint: 'Alert when a recurring or one-shot scheduled automation completes.',
      sampleTitle: 'Scheduled job finished',
      sampleBody: 'Your background cron automation completed.',
      systemSound: 'Purr',
      urgent: false,
    },
    conclave: {
      label: 'Conclave squad or race finished',
      hint: 'Alert when a multi-agent squad or Diff Race finishes.',
      sampleTitle: 'Conclave finished',
      sampleBody: 'All parallel agents finished reporting results.',
      systemSound: 'Hero',
      urgent: false,
    },
  });
  const EVENT_KEYS = Object.keys(EVENT_META);

  const DEFAULT_PREFS = Object.freeze({
    muted: false,
    soundsEnabled: true,
    soundPack: 'glass',
    volume: 65,
    onlySoundWhenUnfocused: false,
    notificationsEnabled: false,
    onlyWhenUnfocused: true,
    dockBounce: true,
    events: {
      completed: true,
      approval: true,
      error: true,
      schedule: true,
      conclave: true,
    },
  });

  function hasNativeBridge() {
    try {
      return Boolean(window.webkit?.messageHandlers?.alerts?.postMessage);
    } catch {
      return false;
    }
  }

  function postNative(payload) {
    try {
      const handler = window.webkit?.messageHandlers?.alerts;
      if (handler && typeof handler.postMessage === 'function') {
        handler.postMessage(payload);
        return true;
      }
    } catch {}
    return false;
  }

  function clampVolume(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return DEFAULT_PREFS.volume;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  function normalizePrefs(raw, fallbackLegacyChime = true) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const rawEvents = src.events && typeof src.events === 'object' ? src.events : {};
    const events = {};
    for (const key of EVENT_KEYS) {
      events[key] = rawEvents[key] !== undefined ? Boolean(rawEvents[key]) : DEFAULT_PREFS.events[key];
    }
    const pack = typeof src.soundPack === 'string' && PACK_IDS.has(src.soundPack) ? src.soundPack : DEFAULT_PREFS.soundPack;
    return {
      muted: src.muted === true,
      soundsEnabled: src.soundsEnabled !== undefined ? Boolean(src.soundsEnabled) : Boolean(fallbackLegacyChime),
      soundPack: pack,
      volume: clampVolume(src.volume !== undefined ? src.volume : DEFAULT_PREFS.volume),
      onlySoundWhenUnfocused: src.onlySoundWhenUnfocused === true,
      notificationsEnabled: src.notificationsEnabled === true,
      onlyWhenUnfocused: src.onlyWhenUnfocused !== false,
      dockBounce: src.dockBounce !== false,
      events,
    };
  }

  function loadPrefs() {
    let legacyChime = true;
    try {
      const qol = JSON.parse(localStorage.getItem(LEGACY_QOL_KEY) || '{}');
      if (qol && typeof qol === 'object' && qol.completionChime === false) legacyChime = false;
    } catch {}
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) return normalizePrefs(JSON.parse(stored), legacyChime);
    } catch {}
    return normalizePrefs({}, legacyChime);
  }

  let prefs = loadPrefs();
  let nativePermission = hasNativeBridge() ? 'default' : null;
  let pendingEnableOnGrant = false;
  let nativeFocused = true;
  let sharedAudioCtx = null;
  const listeners = new Set();
  const recentDedupe = new Map();
  const taskSnapshot = new Map();
  let seededTasks = false;
  let lastSeenScheduleTs = 0;
  const seenScheduleRunIds = new Set();
  let seededSchedule = false;

  const ACTIVE_STATUSES = new Set(['running', 'queued', 'starting', 'recovering', 'verifying']);
  const ERROR_STATUSES = new Set(['failed', 'blocked', 'paused', 'paused_budget', 'waiting_input']);

  function emitChange() {
    const snapshot = getPrefs();
    for (const fn of listeners) {
      try { fn(snapshot); } catch {}
    }
    try {
      window.dispatchEvent(new CustomEvent('godcode-alerts-changed', { detail: snapshot }));
    } catch {}
  }

  function savePrefs() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch {}
    // Keep legacy qolPrefs.completionChime in sync so existing code stays coherent
    try {
      const qolRaw = JSON.parse(localStorage.getItem(LEGACY_QOL_KEY) || '{}');
      if (qolRaw && typeof qolRaw === 'object' && !Array.isArray(qolRaw)) {
        const nextChime = !prefs.muted && prefs.soundsEnabled;
        if (qolRaw.completionChime !== nextChime) {
          qolRaw.completionChime = nextChime;
          localStorage.setItem(LEGACY_QOL_KEY, JSON.stringify(qolRaw));
        }
      }
    } catch {}
  }

  function getPrefs() {
    return {
      ...prefs,
      events: { ...prefs.events },
    };
  }

  function updatePrefs(patch = {}) {
    if (!patch || typeof patch !== 'object') return getPrefs();
    const merged = {
      ...prefs,
      ...patch,
      events: {
        ...prefs.events,
        ...(patch.events && typeof patch.events === 'object' ? patch.events : {}),
      },
    };
    prefs = normalizePrefs(merged);
    savePrefs();
    emitChange();
    return getPrefs();
  }

  function isAppFocused() {
    if (hasNativeBridge()) {
      return Boolean(nativeFocused && document.visibilityState !== 'hidden');
    }
    try {
      return document.visibilityState !== 'hidden' && document.hasFocus();
    } catch {
      return true;
    }
  }

  function getPermissionStatus() {
    if (hasNativeBridge()) return nativePermission || 'default';
    if (typeof window === 'undefined' || typeof window.Notification === 'undefined') return 'unsupported';
    return window.Notification.permission || 'default';
  }

  function refreshNativePermission() {
    if (hasNativeBridge()) postNative({ action: 'permissionStatus' });
  }

  let nativeRequestPending = false;

  async function requestNotificationPermission({ enableOnGrant = false } = {}) {
    if (hasNativeBridge()) {
      if (enableOnGrant) pendingEnableOnGrant = true;
      nativeRequestPending = true;
      return new Promise(resolve => {
        let settled = false;
        let timer = null;
        const onEvent = ev => {
          if (settled) return;
          // Ignore background permissionStatus probes while waiting for explicit requestPermission dialog
          if (ev?.detail?.source && ev.detail.source !== 'request') return;
          settled = true;
          nativeRequestPending = false;
          if (timer) { clearTimeout(timer); timer = null; }
          window.removeEventListener('godcode-alerts-permission', onEvent);
          const status = ev?.detail?.status || nativePermission || 'default';
          nativePermission = status;
          if (status === 'granted' && pendingEnableOnGrant) {
            pendingEnableOnGrant = false;
            updatePrefs({ notificationsEnabled: true });
          } else {
            pendingEnableOnGrant = false;
            emitChange();
          }
          resolve(status);
        };
        window.addEventListener('godcode-alerts-permission', onEvent);
        postNative({ action: 'requestPermission' });
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          nativeRequestPending = false;
          pendingEnableOnGrant = false;
          window.removeEventListener('godcode-alerts-permission', onEvent);
          emitChange();
          resolve(nativePermission || 'default');
        }, 30000);
      });
    }
    if (typeof window === 'undefined' || typeof window.Notification === 'undefined') {
      return 'unsupported';
    }
    try {
      const result = await window.Notification.requestPermission();
      if (result === 'granted' && enableOnGrant) updatePrefs({ notificationsEnabled: true });
      else emitChange();
      return result;
    } catch {
      return getPermissionStatus();
    }
  }

  function getAudioContext() {
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return null;
    try {
      if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
        sharedAudioCtx = new AC();
      }
      return sharedAudioCtx;
    } catch {
      return null;
    }
  }

  let audioUnlockAttached = false;
  let pendingForcedSound = null;

  function attachUnlockListeners() {
    if (audioUnlockAttached || typeof window === 'undefined') return;
    audioUnlockAttached = true;
    window.addEventListener('pointerdown', tryUnlockAudio, { passive: true });
    window.addEventListener('keydown', tryUnlockAudio, { passive: true });
  }

  function detachUnlockListeners() {
    if (!audioUnlockAttached || typeof window === 'undefined') return;
    audioUnlockAttached = false;
    window.removeEventListener('pointerdown', tryUnlockAudio);
    window.removeEventListener('keydown', tryUnlockAudio);
  }

  function tryUnlockAudio() {
    try {
      const ctx = getAudioContext();
      if (!ctx) return;
      if (!ctx.__g0dStateHooked) {
        ctx.__g0dStateHooked = true;
        ctx.onstatechange = () => {
          if (ctx.state === 'running') {
            detachUnlockListeners();
            if (pendingForcedSound) {
              const p = pendingForcedSound;
              pendingForcedSound = null;
              try { scheduleOscillators(ctx, p.notes, p.vol); } catch {}
            }
          } else {
            attachUnlockListeners();
          }
        };
      }
      if (ctx.state === 'running') {
        detachUnlockListeners();
        return;
      }
      if (typeof ctx.resume === 'function') {
        Promise.resolve(ctx.resume()).then(() => {
          if (ctx.state === 'running') detachUnlockListeners();
        }).catch(() => {});
      }
    } catch {}
  }

  function focusTaskFromNotification({ taskId = null, openPane = null } = {}) {
    try {
      if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
        document.querySelectorAll('dialog[open]').forEach(d => { try { d.close(); } catch {} });
      }
    } catch {}
    if (taskId && typeof window.selectTask === 'function') {
      window.selectTask(taskId);
    } else if (openPane && typeof window.openSettings === 'function') {
      window.openSettings(openPane);
    }
  }

  if (typeof window !== 'undefined') {
    attachUnlockListeners();
    window.addEventListener('godcode-alerts-permission', ev => {
      if (nativeRequestPending && (!ev?.detail?.source || ev.detail.source === 'request')) return;
      const status = ev?.detail?.status;
      if (typeof status === 'string') {
        nativePermission = status;
        if (status === 'granted' && pendingEnableOnGrant) {
          pendingEnableOnGrant = false;
          updatePrefs({ notificationsEnabled: true });
        } else {
          emitChange();
        }
      }
    });
    window.addEventListener('godcode-app-focus', ev => {
      if (typeof ev?.detail?.focused === 'boolean') {
        nativeFocused = ev.detail.focused;
      }
    });
    window.addEventListener('godcode-focus-task', ev => {
      focusTaskFromNotification({ taskId: ev?.detail?.taskId || null, openPane: ev?.detail?.openPane || null });
    });
    refreshNativePermission();
  }

  // Synthesized sound recipes per pack + event kind.
  // Each note: [freqHz, startOffsetSec, durationSec, waveType, gainScale]
  const RECIPES = {
    glass: {
      completed: [[587.33, 0, 0.28, 'sine', 0.9], [880, 0.09, 0.36, 'sine', 1.0], [1760, 0.09, 0.22, 'sine', 0.22]],
      approval:  [[523.25, 0, 0.22, 'sine', 0.95], [659.25, 0.11, 0.22, 'sine', 0.95], [783.99, 0.22, 0.34, 'sine', 0.85]],
      error:     [[392.0, 0, 0.24, 'triangle', 0.85], [311.13, 0.13, 0.34, 'triangle', 0.9]],
      schedule:  [[659.25, 0, 0.2, 'sine', 0.85], [987.77, 0.1, 0.32, 'sine', 0.9]],
      conclave:  [[523.25, 0, 0.22, 'sine', 0.85], [659.25, 0.07, 0.24, 'sine', 0.85], [783.99, 0.14, 0.26, 'sine', 0.85], [1046.5, 0.21, 0.38, 'sine', 0.95]],
    },
    synth: {
      completed: [[440, 0, 0.35, 'triangle', 0.7], [554.37, 0.05, 0.38, 'triangle', 0.7], [659.25, 0.1, 0.44, 'sine', 0.85]],
      approval:  [[493.88, 0, 0.22, 'triangle', 0.85], [659.25, 0.12, 0.32, 'triangle', 0.9]],
      error:     [[293.66, 0, 0.26, 'sawtooth', 0.35], [220, 0.14, 0.38, 'triangle', 0.8]],
      schedule:  [[523.25, 0, 0.28, 'triangle', 0.75], [783.99, 0.1, 0.36, 'sine', 0.85]],
      conclave:  [[392, 0, 0.3, 'triangle', 0.65], [493.88, 0.06, 0.32, 'triangle', 0.7], [587.33, 0.12, 0.36, 'triangle', 0.75], [783.99, 0.18, 0.46, 'sine', 0.9]],
    },
    minimal: {
      completed: [[740, 0, 0.11, 'sine', 0.75], [988, 0.07, 0.14, 'sine', 0.65]],
      approval:  [[660, 0, 0.09, 'sine', 0.8], [660, 0.12, 0.12, 'sine', 0.85]],
      error:     [[280, 0, 0.16, 'sine', 0.85], [220, 0.11, 0.18, 'sine', 0.85]],
      schedule:  [[820, 0, 0.12, 'sine', 0.7]],
      conclave:  [[660, 0, 0.09, 'sine', 0.7], [880, 0.07, 0.1, 'sine', 0.75], [1100, 0.14, 0.15, 'sine', 0.7]],
    },
    retro: {
      completed: [[523.25, 0, 0.07, 'square', 0.32], [659.25, 0.07, 0.07, 'square', 0.32], [783.99, 0.14, 0.07, 'square', 0.32], [1046.5, 0.21, 0.16, 'square', 0.36]],
      approval:  [[587.33, 0, 0.08, 'square', 0.35], [880, 0.09, 0.12, 'square', 0.38]],
      error:     [[330, 0, 0.1, 'square', 0.34], [247, 0.1, 0.18, 'square', 0.36]],
      schedule:  [[659.25, 0, 0.07, 'square', 0.3], [987.77, 0.08, 0.14, 'square', 0.34]],
      conclave:  [[440, 0, 0.06, 'square', 0.3], [554.37, 0.06, 0.06, 'square', 0.3], [659.25, 0.12, 0.06, 'square', 0.3], [880, 0.18, 0.16, 'square', 0.36]],
    },
  };

  function canonicalKind(kind) {
    if (kind === 'done') return 'completed';
    return EVENT_META[kind] ? kind : 'completed';
  }

  function scheduleOscillators(ctx, notes, vol) {
    const now = ctx.currentTime;
    const masterGain = 0.14 * vol;
    for (const [freq, offset, dur, type, scale] of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, now + offset);
      const peak = Math.max(0.0005, masterGain * (scale || 1));
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(peak, now + offset + Math.min(0.018, dur * 0.25));
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + dur + 0.02);
    }
  }

  function playSound(kind = 'completed', { force = false, packOverride = null, volumeOverride = null } = {}) {
    const eventKind = canonicalKind(kind);
    if (!force) {
      if (prefs.muted || !prefs.soundsEnabled) return false;
      if (prefs.events[eventKind] === false) return false;
      if (prefs.onlySoundWhenUnfocused && isAppFocused()) return false;
    }
    const vol = clampVolume(volumeOverride !== null ? volumeOverride : prefs.volume) / 100;
    if (vol <= 0) return false;

    const pack = (packOverride && PACK_IDS.has(packOverride)) ? packOverride : prefs.soundPack;
    if (pack === 'system' && hasNativeBridge()) {
      const soundName = EVENT_META[eventKind]?.systemSound || 'Glass';
      return postNative({ action: 'sound', sound: soundName, volume: vol });
    }

    const ctx = getAudioContext();
    if (!ctx) return false;
    try {
      const effectivePack = RECIPES[pack] ? pack : 'glass';
      const notes = RECIPES[effectivePack][eventKind] || RECIPES.glass.completed;
      if (ctx.state !== 'running') {
        // Never stack pending resume().then() callbacks for background chimes (causes bursts on next gesture);
        // only coalesce the latest user-initiated test click (force: true).
        attachUnlockListeners();
        if (force) pendingForcedSound = { notes, vol };
        if (typeof ctx.resume === 'function') {
          Promise.resolve(ctx.resume()).then(() => {
            if (ctx.state === 'running' && pendingForcedSound) {
              const p = pendingForcedSound;
              pendingForcedSound = null;
              try { scheduleOscillators(ctx, p.notes, p.vol); } catch {}
            }
          }).catch(() => {});
        }
        return false;
      }
      scheduleOscillators(ctx, notes, vol);
      return true;
    } catch {
      return false;
    }
  }

  function sendNotification(kind = 'completed', { title, body, taskId = null, openPane = null, force = false } = {}) {
    const eventKind = canonicalKind(kind);
    const meta = EVENT_META[eventKind] || EVENT_META.completed;
    const focused = isAppFocused();

    if (!force) {
      if (prefs.muted || !prefs.notificationsEnabled) return false;
      if (prefs.events[eventKind] === false) return false;
      if (prefs.onlyWhenUnfocused && focused) return false;
    }

    const safeTitle = String(title || meta.sampleTitle || 'G0DM0D3').slice(0, 120);
    const safeBody = String(body || meta.sampleBody || '').slice(0, 260);

    if (hasNativeBridge()) {
      return postNative({
        action: 'notify',
        title: safeTitle,
        body: safeBody,
        taskId: taskId ? String(taskId) : '',
        openPane: openPane ? String(openPane) : '',
        urgent: Boolean(meta.urgent),
        alwaysShow: Boolean(force || !prefs.onlyWhenUnfocused),
      });
    }

    if (typeof window === 'undefined' || typeof window.Notification === 'undefined') return false;
    if (window.Notification.permission !== 'granted') return false;

    try {
      const note = new window.Notification(safeTitle, {
        body: safeBody,
        tag: taskId ? `g0d-${eventKind}-${taskId}` : `g0d-${eventKind}`,
        silent: true, // G0DAlerts controls sound playback itself to avoid double-chimes
      });
      note.onclick = () => {
        try { window.focus(); } catch {}
        focusTaskFromNotification({ taskId, openPane });
        try { note.close(); } catch {}
      };
      return true;
    } catch {
      return false;
    }
  }

  function bounceDock(kind = 'completed', { force = false } = {}) {
    const eventKind = canonicalKind(kind);
    if (!hasNativeBridge()) return false;
    if (!force) {
      if (prefs.muted || !prefs.dockBounce) return false;
      if (prefs.events[eventKind] === false) return false;
      if (isAppFocused()) return false;
    }
    const critical = Boolean(EVENT_META[eventKind]?.urgent);
    return postNative({ action: 'bounce', critical });
  }

  function shouldDedupe(dedupeKey, cooldownMs = 3000) {
    if (!dedupeKey) return false;
    const now = Date.now();
    const prev = recentDedupe.get(dedupeKey);
    if (prev && now - prev < cooldownMs) return true;
    recentDedupe.set(dedupeKey, now);
    if (recentDedupe.size > 120) {
      for (const [k, ts] of recentDedupe) {
        if (now - ts > 30000) recentDedupe.delete(k);
      }
    }
    return false;
  }

  function notifyEvent(kind, { title, body, taskId = null, openPane = null, dedupeKey = null, force = false } = {}) {
    const eventKind = canonicalKind(kind);
    if (!force && dedupeKey && shouldDedupe(dedupeKey)) {
      return { deduped: true, sound: false, notification: false, bounce: false };
    }
    const sound = playSound(eventKind, { force });
    const notification = sendNotification(eventKind, { title, body, taskId, openPane, force });
    const bounce = bounceDock(eventKind, { force });
    return { deduped: false, sound, notification, bounce };
  }

  function taskErrorLabel(status) {
    if (status === 'paused_budget') return 'Task paused (budget limit)';
    if (status === 'waiting_input') return 'Task waiting for input';
    if (status === 'paused') return 'Task paused';
    if (status === 'blocked') return 'Task blocked';
    return 'Task failed';
  }

  function approvalDedupeKey(task) {
    const aid = task?.pendingApprovalId || task?.pendingApproval?.id || task?.eventSeq || '';
    return `approval:${task.id}:${aid}`;
  }

  function observeTasks(tasks) {
    if (!Array.isArray(tasks)) return [];
    const triggered = [];
    const liveIds = new Set();

    for (const task of tasks) {
      if (!task || !task.id) continue;
      liveIds.add(task.id);
      const prev = taskSnapshot.get(task.id);
      const cur = {
        status: String(task.status || ''),
        pendingApproval: Boolean(task.pendingApproval),
        title: String(task.title || 'Conversation'),
      };

      if (seededTasks && prev) {
        if (!prev.pendingApproval && cur.pendingApproval && cur.status !== 'cancelled') {
          const toolName = task.pendingApprovalTool || task.pendingApproval?.tool || '';
          const tool = toolName ? ` (${toolName})` : '';
          triggered.push({ kind: 'approval', taskId: task.id });
          notifyEvent('approval', {
            title: `Approval required${tool}`,
            body: cur.title,
            taskId: task.id,
            dedupeKey: approvalDedupeKey(task),
          });
        } else if (ACTIVE_STATUSES.has(prev.status) && cur.status === 'completed') {
          triggered.push({ kind: 'completed', taskId: task.id });
          notifyEvent('completed', {
            title: 'Task finished',
            body: cur.title,
            taskId: task.id,
            dedupeKey: `completed:${task.id}:${task.version ?? ''}`,
          });
        } else if (ACTIVE_STATUSES.has(prev.status) && ERROR_STATUSES.has(cur.status)) {
          triggered.push({ kind: 'error', taskId: task.id });
          notifyEvent('error', {
            title: taskErrorLabel(cur.status),
            body: cur.title,
            taskId: task.id,
            dedupeKey: `error:${task.id}:${cur.status}:${task.version ?? ''}`,
          });
        }
      }
      taskSnapshot.set(task.id, cur);
    }

    for (const id of [...taskSnapshot.keys()]) {
      if (!liveIds.has(id)) taskSnapshot.delete(id);
    }
    seededTasks = true;
    return triggered;
  }

  function observeSchedulesSummary(summary) {
    if (!summary || typeof summary !== 'object') return null;
    const runs = Array.isArray(summary.recentRuns) && summary.recentRuns.length
      ? summary.recentRuns
      : (summary.latestRun ? [summary.latestRun] : []);

    if (!seededSchedule) {
      for (const r of runs) {
        const key = r.runId || `${r.jobId || ''}:${r.finishedAt || ''}:${r.status || ''}`;
        if (key) seenScheduleRunIds.add(key);
        const ts = Date.parse(r.finishedAt || '');
        if (Number.isFinite(ts) && ts > lastSeenScheduleTs) lastSeenScheduleTs = ts;
      }
      seededSchedule = true;
      return null;
    }

    let notified = null;
    // Process oldest-to-newest among unseen runs with strictly non-historical timestamps
    const fresh = [];
    for (const r of runs) {
      if (!r || !r.finishedAt) continue;
      const key = r.runId || `${r.jobId || ''}:${r.finishedAt}:${r.status || ''}`;
      if (seenScheduleRunIds.has(key)) continue;
      const ts = Date.parse(r.finishedAt);
      if (!Number.isFinite(ts) || ts < lastSeenScheduleTs) {
        // Historical run surfaced after deleting a newer job — record as seen without replaying
        seenScheduleRunIds.add(key);
        continue;
      }
      fresh.push({ r, key, ts });
    }
    fresh.sort((a, b) => a.ts - b.ts);

    for (const { r, key, ts } of fresh) {
      seenScheduleRunIds.add(key);
      if (ts > lastSeenScheduleTs) lastSeenScheduleTs = ts;
      if (seenScheduleRunIds.size > 200) {
        const first = seenScheduleRunIds.values().next().value;
        seenScheduleRunIds.delete(first);
      }
      const failed = ['failed', 'error', 'blocked', 'interrupted'].includes(r.status);
      const title = r.status === 'blocked' ? 'Scheduled job blocked' : failed ? 'Scheduled job failed' : 'Scheduled job finished';
      const body = r.jobName ? `${r.jobName} (${r.status || 'completed'})` : 'A scheduled automation completed.';
      notifyEvent(failed ? 'error' : 'schedule', {
        title,
        body,
        taskId: r.taskId || null,
        openPane: r.taskId ? null : 'schedules',
        dedupeKey: `schedule:${key}`,
      });
      notified = r;
    }
    return notified;
  }

  function statusBadgeText() {
    if (prefs.muted) return 'Muted';
    if (!prefs.soundsEnabled && !prefs.notificationsEnabled) return 'Off';
    if (prefs.soundsEnabled && prefs.notificationsEnabled) return 'On';
    if (prefs.notificationsEnabled) return 'Notify';
    return 'Sound';
  }

  function resetObserversForTest() {
    taskSnapshot.clear();
    recentDedupe.clear();
    seenScheduleRunIds.clear();
    seededTasks = false;
    lastSeenScheduleTs = 0;
    seededSchedule = false;
  }

  const api = {
    SOUND_PACKS,
    EVENT_META,
    EVENT_KEYS,
    get: getPrefs,
    update: updatePrefs,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    hasNativeBridge,
    getPermissionStatus,
    refreshNativePermission,
    requestNotificationPermission,
    isAppFocused,
    playSound,
    sendNotification,
    bounceDock,
    notifyEvent,
    observeTasks,
    observeSchedulesSummary,
    statusBadgeText,
    _resetObserversForTest: resetObserversForTest,
  };

  if (typeof window !== 'undefined') {
    window.G0DAlerts = api;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.__G0DAlertsModule = api;
  }
})();
