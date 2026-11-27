import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { CronScheduler } from '../src/cron.mjs';

async function loadAlertsModule({ stored = null, legacyQol = null, nativeBridge = false, notificationPerm = 'default', focused = true } = {}) {
  const code = await fs.readFile(new URL('../public/alerts.js', import.meta.url), 'utf8');
  const storage = new Map();
  if (stored !== null) storage.set('g0dc0d3.alerts.v1', JSON.stringify(stored));
  if (legacyQol !== null) storage.set('g0dc0d3.qol.v1', JSON.stringify(legacyQol));

  const nativePosts = [];
  const webNotifs = [];
  const audioOscillators = [];
  const dispatched = [];
  const listeners = new Map();

  class FakeAudioContext {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    createOscillator() {
      const osc = { type: 'sine', frequency: { setValueAtTime() {} }, connect() {}, start() {}, stop() {} };
      audioOscillators.push(osc);
      return osc;
    }
    createGain() {
      return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
    }
  }

  class FakeNotification {
    static permission = notificationPerm;
    static requestPermission() {
      FakeNotification.permission = 'granted';
      return Promise.resolve('granted');
    }
    constructor(title, opts) {
      this.title = title;
      this.opts = opts;
      this.closed = false;
      webNotifs.push(this);
    }
    close() { this.closed = true; }
  }

  const win = {
    AudioContext: FakeAudioContext,
    Notification: FakeNotification,
    webkit: nativeBridge ? { messageHandlers: { alerts: { postMessage: msg => nativePosts.push(msg) } } } : undefined,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatchEvent(ev) {
      dispatched.push(ev);
      for (const fn of listeners.get(ev.type) || []) fn(ev);
    },
    focus() {},
  };

  const sandbox = {
    window: win,
    globalThis: {},
    document: {
      visibilityState: focused ? 'visible' : 'hidden',
      hasFocus: () => focused,
    },
    localStorage: {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: k => storage.delete(k),
    },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    setTimeout,
    clearTimeout,
    Date,
    Math,
    Number,
    Boolean,
    String,
    Array,
    Object,
    Set,
    Map,
    JSON,
    Promise,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox, { filename: 'public/alerts.js' });
  return { api: win.G0DAlerts, storage, nativePosts, webNotifs, audioOscillators, dispatched, win, FakeNotification };
}

test('G0DAlerts migrates legacy completionChime=false, persists updates, and syncs legacy key', async () => {
  const { api, storage } = await loadAlertsModule({ legacyQol: { completionChime: false, sendKey: 'enter' } });
  const initial = api.get();
  assert.equal(initial.soundsEnabled, false);
  assert.equal(initial.notificationsEnabled, false);
  assert.equal(initial.soundPack, 'glass');
  assert.equal(initial.volume, 65);
  assert.equal(api.statusBadgeText(), 'Off');

  api.update({ soundsEnabled: true, soundPack: 'synth', volume: 120 });
  const next = api.get();
  assert.equal(next.soundsEnabled, true);
  assert.equal(next.soundPack, 'synth');
  assert.equal(next.volume, 100);
  assert.equal(api.statusBadgeText(), 'Sound');
  assert.equal(JSON.parse(storage.get('g0dc0d3.qol.v1')).completionChime, true);

  api.update({ muted: true });
  assert.equal(api.statusBadgeText(), 'Muted');
  assert.equal(JSON.parse(storage.get('g0dc0d3.qol.v1')).completionChime, false);
});

test('G0DAlerts observes multi-task transitions without startup spam and deduplicates events', async () => {
  const { api, audioOscillators, webNotifs } = await loadAlertsModule({
    stored: { soundsEnabled: true, notificationsEnabled: true, onlyWhenUnfocused: true, soundPack: 'glass', volume: 70 },
    notificationPerm: 'granted',
    focused: false,
  });

  // First snapshot seeds baseline without firing alerts for already-completed tasks
  const seed = api.observeTasks([
    { id: 't1', status: 'completed', title: 'Old done task' },
    { id: 't2', status: 'running', title: 'Active build' },
    { id: 't3', status: 'running', title: 'Tool task', pendingApproval: null },
    { id: 't4', status: 'running', title: 'Failing task' },
  ]);
  assert.equal(seed.length, 0);
  assert.equal(audioOscillators.length, 0);
  assert.equal(webNotifs.length, 0);

  // Transition t2 -> completed, t3 -> pendingApproval, t4 -> failed
  const fired = api.observeTasks([
    { id: 't1', status: 'completed', title: 'Old done task' },
    { id: 't2', status: 'completed', title: 'Active build', version: 2 },
    { id: 't3', status: 'running', title: 'Tool task', pendingApproval: { id: 'a1', tool: 'shell.run' }, eventSeq: 5 },
    { id: 't4', status: 'failed', title: 'Failing task', version: 3 },
  ]);
  assert.deepEqual([...fired].map(f => `${f.kind}:${f.taskId}`), ['completed:t2', 'approval:t3', 'error:t4']);
  assert.equal(webNotifs.length, 3);
  assert.ok(audioOscillators.length > 0);

  // Explicit duplicate notifyEvent with the same dedupeKey within cooldown is suppressed
  const dup = api.notifyEvent('completed', { title: 'Task finished', body: 'Active build', taskId: 't2', dedupeKey: 'completed:t2:2' });
  assert.equal(dup.deduped, true);
  assert.equal(webNotifs.length, 3);
});

test('G0DAlerts respects mute, unfocused filters, and native macOS bridge actions', async () => {
  const { api, nativePosts } = await loadAlertsModule({
    stored: { soundsEnabled: true, notificationsEnabled: true, soundPack: 'system', volume: 80, onlyWhenUnfocused: true, dockBounce: true },
    nativeBridge: true,
    focused: true,
  });
  // Initial permissionStatus probe sent on boot
  assert.equal(nativePosts[0]?.action, 'permissionStatus');
  nativePosts.length = 0;

  // App is focused: sound plays (onlySoundWhenUnfocused=false), banner + bounce suppressed
  const resFocused = api.notifyEvent('completed', { title: 'Done', body: 'Hello', taskId: 't9' });
  assert.equal(resFocused.sound, true);
  assert.equal(resFocused.notification, false);
  assert.equal(resFocused.bounce, false);
  assert.equal(nativePosts.length, 1);
  assert.equal(nativePosts[0].action, 'sound');
  assert.equal(nativePosts[0].sound, 'Glass');

  // App is focused with onlySoundWhenUnfocused=true: sound is also suppressed!
  nativePosts.length = 0;
  api.update({ onlySoundWhenUnfocused: true });
  const resQuietFocused = api.notifyEvent('completed', { title: 'Quiet', body: 'Focused', taskId: 't9b' });
  assert.equal(resQuietFocused.sound, false);
  assert.equal(resQuietFocused.notification, false);
  assert.equal(resQuietFocused.bounce, false);
  assert.equal(nativePosts.length, 0);

  // Simulate app losing focus via native event
  const ev = { type: 'godcode-app-focus', detail: { focused: false } };
  const { api: bgApi, nativePosts: bgPosts, win } = await loadAlertsModule({
    stored: { soundsEnabled: true, notificationsEnabled: true, soundPack: 'system', volume: 50, onlyWhenUnfocused: true, onlySoundWhenUnfocused: true, dockBounce: true },
    nativeBridge: true,
    focused: true,
  });
  bgPosts.length = 0;
  win.dispatchEvent(ev);
  const resBg = bgApi.notifyEvent('approval', { title: 'Approval', body: 'Confirm rm', taskId: 't10' });
  assert.equal(resBg.sound, true);
  assert.equal(resBg.notification, true);
  assert.equal(resBg.bounce, true);
  assert.deepEqual(bgPosts.map(p => p.action), ['sound', 'notify', 'bounce']);
  assert.equal(bgPosts[0].sound, 'Ping');
  assert.equal(bgPosts[2].critical, true);

  // Muted suppresses everything unless force=true
  bgPosts.length = 0;
  bgApi.update({ muted: true });
  const resMuted = bgApi.notifyEvent('completed', { title: 'Done', body: 'Silent' });
  assert.equal(resMuted.sound, false);
  assert.equal(resMuted.notification, false);
  assert.equal(resMuted.bounce, false);
  assert.equal(bgPosts.length, 0);

  const resForced = bgApi.notifyEvent('completed', { title: 'Forced', body: 'Preview', force: true });
  assert.equal(resForced.sound, true);
  assert.equal(resForced.notification, true);
});

test('G0DAlerts detects background cron completions via CronScheduler.summary() without replaying deleted history', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'g0d-alerts-cron-'));
  const store = new Store(dir);
  let failNext = false;
  const scheduler = new CronScheduler({
    store,
    onTrigger: async () => failNext
      ? { status: 'failed', taskId: null, error: 'boom' }
      : { status: 'completed', taskId: 'task-cron-1', summary: 'ok' },
  });
  try {
    const job = scheduler.createJob({ name: 'Morning digest', prompt: 'Summarize', kind: 'cron', expression: '0 9 * * *' });
    const before = scheduler.summary();
    assert.equal(before.latestRun, null);

    const { api, webNotifs } = await loadAlertsModule({
      stored: { soundsEnabled: true, notificationsEnabled: true, onlyWhenUnfocused: false },
      notificationPerm: 'granted',
    });
    assert.equal(api.observeSchedulesSummary(before), null);

    const { promise } = scheduler.triggerNow(job.id);
    await promise;
    const after = scheduler.summary();
    assert.equal(after.latestRun?.jobId, job.id);
    assert.equal(after.latestRun?.jobName, 'Morning digest');
    assert.equal(after.latestRun?.status, 'completed');
    assert.equal(after.latestRun?.taskId, 'task-cron-1');
    assert.ok(after.latestRun?.runId);

    const hit = api.observeSchedulesSummary(after);
    assert.equal(hit?.jobId, job.id);
    assert.equal(webNotifs.length, 1);
    assert.match(webNotifs[0].title, /Scheduled job finished/);
    assert.match(webNotifs[0].opts.body, /Morning digest/);

    // Repeat poll is idempotent
    assert.equal(api.observeSchedulesSummary(after), null);
    assert.equal(webNotifs.length, 1);

    // Failed subsequent run clears stale lastTaskId and alerts as failure
    failNext = true;
    await new Promise(r => setTimeout(r, 10));
    const { promise: p2 } = scheduler.triggerNow(job.id);
    await p2;
    const afterFail = scheduler.summary();
    assert.equal(afterFail.latestRun?.status, 'failed');
    assert.equal(afterFail.latestRun?.taskId, null);
    assert.ok(api.observeSchedulesSummary(afterFail));
    assert.equal(webNotifs.length, 2);
    assert.match(webNotifs[1].title, /Scheduled job failed/);

    // Historical summary older than lastSeenScheduleTs never replays (e.g. after deleting newest job)
    assert.equal(api.observeSchedulesSummary({
      latestRun: { runId: 'srun_old', jobId: 'old', jobName: 'Old job', status: 'completed', finishedAt: '2020-01-01T00:00:00.000Z' },
    }), null);
    assert.equal(webNotifs.length, 2);
  } finally {
    scheduler.stop();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
