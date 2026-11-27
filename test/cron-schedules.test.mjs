import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  parseCron,
  nextCronTime,
  previewCronRuns,
  describeCron,
  validateScheduleInput,
  renderLaunchdPlist,
  CronScheduler,
} from '../src/cron.mjs';
import { Store } from '../src/store.mjs';
import { createApp } from '../src/server.mjs';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

test('Cron parser handles POSIX fields, names, aliases, leap days, and rejects impossible/malformed expressions', () => {
  const p1 = parseCron('*/15 9-17 * * mon-fri');
  assert.deepEqual(p1.minute.sorted, [0, 15, 30, 45]);
  assert.deepEqual(p1.hour.sorted, [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual(p1.dow.sorted, [1, 2, 3, 4, 5]);

  // Sunday = 7 alias & ranges (5-7, mon-sun, 7-7)
  const pSun = parseCron('30 14 * * 7');
  assert.deepEqual(pSun.dow.sorted, [0]);
  assert.deepEqual(parseCron('0 9 * * 5-7').dow.sorted, [0, 5, 6]);
  assert.deepEqual(parseCron('0 9 * * mon-sun').dow.sorted, [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(parseCron('0 9 * * 7-7').dow.sorted, [0]);
  assert.equal(describeCron('30 14 * * 7'), 'Every Sun at 2:30 PM');
  assert.equal(describeCron('0 9 * * 9'), '9 at 9:00 AM');
  assert.equal(describeCron('@weekdays'), 'Weekdays at 9:00 AM');
  assert.equal(describeCron('@every_15m'), 'Every 15 minutes');
  assert.equal(describeCron('@hourly'), 'Hourly');
  assert.equal(describeCron('@daily'), 'Daily at 12:00 AM');

  // Next-time calculation (local time)
  const base = new Date(2026, 4, 1, 8, 45, 30); // Fri May 1, 2026 08:45:30
  const nextWeekday9 = nextCronTime('0 9 * * 1-5', base);
  assert.equal(nextWeekday9.getFullYear(), 2026);
  assert.equal(nextWeekday9.getMonth(), 4);
  assert.equal(nextWeekday9.getDate(), 1);
  assert.equal(nextWeekday9.getHours(), 9);
  assert.equal(nextWeekday9.getMinutes(), 0);

  // Skip weekend cleanly from Fri 09:00 -> Mon May 4 09:00
  const nextAfterFri = nextCronTime('0 9 * * 1-5', nextWeekday9);
  assert.equal(nextAfterFri.getDay(), 1);
  assert.equal(nextAfterFri.getDate(), 4);

  // Leap year Feb 29
  const leap = nextCronTime('0 0 29 2 *', new Date(2026, 0, 1, 0, 0, 0));
  assert.equal(leap.getFullYear(), 2028);
  assert.equal(leap.getMonth(), 1);
  assert.equal(leap.getDate(), 29);

  // Preview 3 runs
  const runs = previewCronRuns('0 * * * *', 3, new Date(2026, 4, 1, 10, 5, 0));
  assert.equal(runs.length, 3);
  assert.ok(Date.parse(runs[1]) - Date.parse(runs[0]) === 3600_000);

  // Reject invalid & impossible dates without hanging
  assert.throws(() => parseCron(''), /required/i);
  assert.throws(() => parseCron('* * * *'), /5-field/i);
  assert.throws(() => parseCron('60 * * * *'), /out of range/i);
  assert.throws(() => parseCron('*/0 * * * *'), /out of range/i);
  assert.throws(() => parseCron('5-2 * * * *'), /before start/i);
  assert.throws(() => nextCronTime('0 0 31 2 *', base), /no valid run time/i);

  // Empty cron string must fail validation instead of silently defaulting
  assert.throws(() => validateScheduleInput({ kind: 'cron', expression: '' }), /required/i);

  // One-shot validation
  const once = validateScheduleInput({ kind: 'once', runAt: '2027-01-15T12:00:00.000Z' });
  assert.equal(once.valid, true);
  assert.equal(once.kind, 'once');
  assert.equal(once.nextRunAt, '2027-01-15T12:00:00.000Z');
  assert.throws(() => validateScheduleInput({ kind: 'once', runAt: 'not-a-date' }), /valid ISO/i);

  // launchd plist generation escapes XML cleanly & handles POSIX DOM/DOW OR + every-minute + one-shot
  const plist = renderLaunchdPlist(
    { id: 'sched_abc', name: 'Test & <Job>', kind: 'cron', expression: '0 9 * * 1-5' },
    { nodePath: '/usr/local/bin/node', cliPath: '/app/src/cli.mjs', dataDir: '/tmp/data&1' }
  );
  assert.ok(plist.includes('gg.godmode.schedule.sched_abc'));
  assert.ok(plist.includes('<key>StartCalendarInterval</key>'));
  assert.ok(plist.includes('/tmp/data&amp;1'));
  assert.ok(!plist.includes('www.apple.com'), 'No external DTD URLs');

  const orPlist = renderLaunchdPlist({ id: 'sched_or', kind: 'cron', expression: '0 9 15 * 1' });
  assert.ok(orPlist.includes('<key>Day</key><integer>15</integer>'));
  assert.ok(orPlist.includes('<key>Weekday</key><integer>1</integer>'));
  // Must be two separate <dict> blocks (OR), not both Day and Weekday inside one <dict>
  assert.ok(!/<dict>(?:(?!<\/dict>)[\s\S])*<key>Day<\/key>(?:(?!<\/dict>)[\s\S])*<key>Weekday<\/key>/.test(orPlist));

  const everyMinPlist = renderLaunchdPlist({ id: 'sched_min', kind: 'cron', expression: '* * * * *' });
  assert.ok(everyMinPlist.includes('<key>StartInterval</key>\n  <integer>60</integer>'));

  const oncePlist = renderLaunchdPlist({ id: 'sched_once', kind: 'once', runAt: '2027-05-10T14:30:00.000Z' });
  assert.ok(oncePlist.includes('<key>StartCalendarInterval</key>'));
  assert.ok(!oncePlist.includes('<integer>3600</integer>'));
});

test('CronScheduler handles due dispatch, overlap skip/queue, one-shot auto-disable, maxRuns, and boot reconciliation', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'godmode-cron-unit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  let fakeNow = new Date(2026, 4, 1, 8, 59, 0);
  const store = new Store(dir);
  t.after(() => store.close());

  let releaseHold = null;
  let calls = 0;
  const scheduler = new CronScheduler({
    store,
    now: () => new Date(fakeNow.getTime()),
    onTrigger: async (job) => {
      calls += 1;
      if (job.name === 'slow-skip') {
        await new Promise(resolve => { releaseHold = resolve; });
      }
      return { status: 'completed', taskId: `task_${calls}`, summary: `Run #${calls} ok` };
    },
  });

  // 1. One-shot job auto-disables after firing
  const onceJob = scheduler.createJob({
    name: 'one-shot-job',
    prompt: 'Do once',
    kind: 'once',
    runAt: new Date(2026, 4, 1, 9, 0, 0).toISOString(),
  });
  assert.equal(onceJob.enabled, true);

  // Not due yet at 08:59
  let fired = await scheduler.tick();
  assert.equal(fired.length, 0);

  // Advance to 09:00 -> fires once and disables
  fakeNow = new Date(2026, 4, 1, 9, 0, 1);
  fired = await scheduler.tick();
  assert.equal(fired.length, 1);
  const onceRes = await fired[0].promise;
  assert.equal(onceRes.status, 'completed');
  const onceAfter = scheduler.getJob(onceJob.id);
  assert.equal(onceAfter.enabled, false);
  assert.equal(onceAfter.nextRunAt, null);
  assert.equal(onceAfter.runCount, 1);

  // 2. Overlap protection (skip) + maxRuns
  const skipJob = scheduler.createJob({
    name: 'slow-skip',
    prompt: 'Every minute',
    kind: 'cron',
    expression: '* * * * *',
    overlapPolicy: 'skip',
    maxRuns: 2,
  });
  fakeNow = new Date(2026, 4, 1, 9, 1, 5);
  const firstTick = await scheduler.tick();
  assert.equal(firstTick.length, 1);
  assert.equal(scheduler.getJob(skipJob.id).running, true);

  // Next minute arrives while first run is still active -> recorded as skipped!
  fakeNow = new Date(2026, 4, 1, 9, 2, 5);
  const overlapTick = await scheduler.tick();
  assert.equal(overlapTick.length, 0);
  const runsDuringOverlap = scheduler.getRuns(skipJob.id);
  assert.ok(runsDuringOverlap.some(r => r.status === 'skipped'));

  // Release held run
  releaseHold();
  await firstTick[0].promise;
  assert.equal(scheduler.getJob(skipJob.id).runCount, 1);

  // Boot reconciliation: simulate a stale running record & past nextRunAt
  store.putScheduledRun({
    id: 'srun_stale',
    jobId: skipJob.id,
    trigger: 'schedule',
    status: 'running',
    startedAt: new Date(2026, 4, 1, 9, 2, 0).toISOString(),
    finishedAt: null,
  });
  store.putScheduledJob({
    ...store.getScheduledJob(skipJob.id),
    enabled: true,
    nextRunAt: new Date(2026, 4, 1, 9, 3, 0).toISOString(),
  });
  fakeNow = new Date(2026, 4, 1, 10, 0, 0);
  const rebooted = new CronScheduler({
    store,
    now: () => new Date(fakeNow.getTime()),
    onTrigger: async () => ({ status: 'completed' }),
  });
  const reconciledRuns = rebooted.getRuns(skipJob.id);
  const stale = reconciledRuns.find(r => r.id === 'srun_stale');
  assert.equal(stale?.status, 'interrupted');
  const reconciledJob = rebooted.getJob(skipJob.id);
  assert.ok(Date.parse(reconciledJob.nextRunAt) > fakeNow.getTime(), 'Stale nextRunAt must advance forward on boot');
  await rebooted.close();
  await scheduler.close();
});

test('Schedules HTTP API runs live scheduled jobs, enforces Airgap Lockdown, and persists across restart', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'godmode-cron-api-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  let cloudCalls = 0;
  const mockCloud = {
    id: 'openai:gpt-5.6-sol',
    label: 'GPT-5.6 Sol · OpenAI',
    model: 'gpt-5.6-sol',
    kind: 'http',
    tier: 'frontier',
    available: true,
    maxOutputTokensCeiling: 16000,
    async turn() {
      cloudCalls += 1;
      return { type: 'message', finish: 'done', text: 'Scheduled morning digest: all systems nominal.' };
    },
  };

  const app = await createApp({
    dataDir: dir,
    auth: false,
    providers: new Map([[mockCloud.id, mockCloud]]),
    cliDiscovery: { probes: [] },
    startScheduler: true,
    schedulerTickMs: 60000,
  });
  t.after(() => app.close().catch(() => {}));
  const root = await app.listen(0);
  const hdrs = { 'content-type': 'application/json', origin: root, 'x-g0d-request': '1' };

  // Preview endpoint
  const prevRes = await fetch(`${root}/api/schedules/preview`, {
    method: 'POST',
    headers: hdrs,
    body: JSON.stringify({ kind: 'cron', expression: '0 9 * * 1-5' }),
  });
  assert.equal(prevRes.status, 200);
  const prev = await prevRes.json();
  assert.equal(prev.valid, true);
  assert.equal(prev.humanLabel, 'Weekdays at 9:00 AM');
  assert.equal(prev.previewRuns.length, 3);

  // Create job
  const createRes = await fetch(`${root}/api/schedules`, {
    method: 'POST',
    headers: hdrs,
    body: JSON.stringify({
      name: 'Morning Health Check',
      prompt: 'Summarize system health in one sentence.',
      kind: 'cron',
      expression: '0 9 * * 1-5',
      mode: 'godmode',
      providerIds: [mockCloud.id],
      permissionPreset: 'safe',
    }),
  });
  assert.equal(createRes.status, 201);
  const { job } = await createRes.json();
  assert.ok(job.id.startsWith('sched_'));
  assert.equal(job.enabled, true);

  // Verify /api/state includes schedulesSummary
  const stateRes = await (await fetch(`${root}/api/state`)).json();
  assert.equal(stateRes.schedulesSummary.enabled, 1);

  // Trigger manual run and wait for completion
  const runRes = await fetch(`${root}/api/schedules/${encodeURIComponent(job.id)}/run`, {
    method: 'POST',
    headers: hdrs,
    body: JSON.stringify({ wait: true }),
  });
  assert.equal(runRes.status, 202);
  const runData = await runRes.json();
  assert.equal(runData.run.status, 'completed');
  assert.ok(runData.run.taskId);
  assert.match(runData.run.summary, /all systems nominal/i);
  assert.equal(cloudCalls, 1);

  // Verify detail endpoint returns runs & launchd plist
  const detail = await (await fetch(`${root}/api/schedules/${encodeURIComponent(job.id)}`)).json();
  assert.equal(detail.runs.length, 1);
  assert.equal(detail.runs[0].status, 'completed');
  assert.ok(detail.launchdPlist.includes('<plist version="1.0">'));

  // Verify created task carries scheduledJob metadata
  const createdTask = app.runtime.getTask(runData.run.taskId);
  assert.equal(createdTask.scheduledJob?.id, job.id);
  assert.equal(createdTask.status, 'completed');

  // Enable Airgap Lockdown -> cloud scheduled job MUST be blocked with zero cloud calls!
  app.runtime.updatePrivacy({ applyProfile: 'lockdown' });
  const lockedRunRes = await fetch(`${root}/api/schedules/${encodeURIComponent(job.id)}/run`, {
    method: 'POST',
    headers: hdrs,
    body: JSON.stringify({ wait: true }),
  });
  const lockedData = await lockedRunRes.json();
  assert.equal(lockedData.run.status, 'blocked');
  assert.match(lockedData.run.error, /Airgap Lockdown/i);
  assert.equal(cloudCalls, 1, 'Airgap Lockdown must block cloud scheduled run before provider invocation');

  // Pause & restart persistence check
  const patchRes = await fetch(`${root}/api/schedules/${encodeURIComponent(job.id)}`, {
    method: 'PATCH',
    headers: hdrs,
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(patchRes.status, 200);
  await app.close();

  // Reopen app with same dataDir -> job and run history persist!
  const app2 = await createApp({
    dataDir: dir,
    auth: false,
    providers: new Map([[mockCloud.id, mockCloud]]),
    cliDiscovery: { probes: [] },
    startScheduler: false,
  });
  t.after(() => app2.close());
  const root2 = await app2.listen(0);
  const list2 = await (await fetch(`${root2}/api/schedules`)).json();
  assert.equal(list2.jobs.length, 1);
  assert.equal(list2.jobs[0].enabled, false);
  assert.equal(list2.jobs[0].runCount, 2);

  // Delete job
  const delRes = await fetch(`${root2}/api/schedules/${encodeURIComponent(job.id)}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', origin: root2, 'x-g0d-request': '1' },
    body: '{}',
  });
  assert.equal(delRes.status, 200);
  const listAfterDel = await (await fetch(`${root2}/api/schedules`)).json();
  assert.equal(listAfterDel.jobs.length, 0);
});

test('CLI cron subcommands add, list, pause, resume, export plist, and remove schedules', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'godmode-cron-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const addOut = await execFileAsync(process.execPath, [
    cliPath, 'cron', 'add',
    '--data', dir,
    '--name', 'Nightly Audit',
    '--cron', '0 2 * * *',
    '--prompt', 'Audit dependencies',
    '--preset', 'read_only',
  ]);
  const created = JSON.parse(addOut.stdout);
  assert.ok(created.id.startsWith('sched_'));
  assert.equal(created.permissionPreset, 'read_only');

  const listOut = await execFileAsync(process.execPath, [cliPath, 'cron', 'list', '--data', dir]);
  const listed = JSON.parse(listOut.stdout);
  assert.equal(listed.jobs.length, 1);
  assert.equal(listed.jobs[0].name, 'Nightly Audit');

  const pauseOut = await execFileAsync(process.execPath, [cliPath, 'cron', 'pause', created.id, '--data', dir]);
  assert.equal(JSON.parse(pauseOut.stdout).enabled, false);

  const resumeOut = await execFileAsync(process.execPath, [cliPath, 'cron', 'resume', created.id, '--data', dir]);
  assert.equal(JSON.parse(resumeOut.stdout).enabled, true);

  const plistOut = await execFileAsync(process.execPath, [cliPath, 'cron', 'plist', created.id, '--data', dir]);
  assert.ok(plistOut.stdout.includes(`gg.godmode.schedule.${created.id}`));

  const rmOut = await execFileAsync(process.execPath, [cliPath, 'cron', 'rm', created.id, '--data', dir]);
  assert.equal(JSON.parse(rmOut.stdout).deleted, true);
});

test('Audit regressions: trailing-dot FQDN scope block, IPv6 scope, anti-spoofing securityProfile, pre-DNS scope guard, read_only rules & ephemeral memory HTTP gate', async t => {
  const { checkTargetScope, normalizePrivacySettings } = await import('../src/privacy.mjs');
  const { safeWebFetch } = await import('../src/web-fetch.mjs');
  const { READ_ONLY_SCHEDULE_RULES } = await import('../src/cron.mjs');
  const { evaluatePermission } = await import('../src/permissions.mjs');

  // Trailing-dot FQDN cannot bypass scopeDeny / scopeAllow
  const p = normalizePrivacySettings({ scopeDeny: ['prod.target.io', '[::1]:8080', '::1'], scopeAllow: ['*.target.io.'] });
  assert.ok(p.scopeDeny.includes('::1'));
  assert.equal(checkTargetScope('https://prod.target.io./v1', p).allowed, false);
  assert.equal(checkTargetScope('https://api.target.io./v1', p).allowed, true);
  assert.equal(checkTargetScope('https://evil.com./', p).allowed, false);

  // Anti-spoofing: applyProfile: 'lockdown' with localOnly: false cannot report securityProfile: 'lockdown'
  const spoofAttempt = normalizePrivacySettings({ applyProfile: 'lockdown', localOnly: false, strictZdr: false });
  assert.equal(spoofAttempt.securityProfile, 'standard');

  // Pre-DNS scope check: lookup must NEVER be called for an out-of-scope host
  let dnsCalled = false;
  await assert.rejects(
    () => safeWebFetch(
      { url: 'https://out-of-scope.example.com/secret' },
      {
        privacy: { localOnly: false, scopeAllow: ['in-scope.example.com'], scopeDeny: [] },
        lookup: async () => { dnsCalled = true; return [{ address: '93.184.216.34', family: 4 }]; },
      }
    ),
    /SCOPE_OUT_OF_BOUNDS|outside your active/i
  );
  assert.equal(dnsCalled, false, 'DNS lookup must not fire for out-of-scope targets');

  // read_only scheduled permission rules must deny writes & shell commands
  assert.equal(evaluatePermission(READ_ONLY_SCHEDULE_RULES, 'repo.write', { path: 'a.js' }).action, 'deny');
  assert.equal(evaluatePermission(READ_ONLY_SCHEDULE_RULES, 'process.run', { command: 'ls' }).action, 'deny');
  assert.equal(evaluatePermission(READ_ONLY_SCHEDULE_RULES, 'repo.read', { path: 'a.js' }).action, 'allow');

  // Ephemeral session blocks POST /api/memory with 403 EPHEMERAL_SESSION
  const dir = await mkdtemp(path.join(tmpdir(), 'godmode-ephemeral-mem-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const app = await createApp({ dataDir: dir, auth: false, cliDiscovery: { probes: [] }, startScheduler: false });
  t.after(() => app.close());
  const root = await app.listen(0);
  app.runtime.updatePrivacy({ applyProfile: 'hardened' });
  const memRes = await fetch(`${root}/api/memory`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: root, 'x-g0d-request': '1' },
    body: JSON.stringify({ title: 'Secret target', content: 'sensitive finding' }),
  });
  assert.equal(memRes.status, 403);
  assert.equal((await memRes.json()).code, 'EPHEMERAL_SESSION');
});

test('Cron Round 2 regressions: dontAsk/acceptEdits presets persist and reconcileOnBoot:false preserves due nextRunAt', async t => {
  const { normalizeScheduledJobInput, CronScheduler } = await import('../src/cron.mjs');
  const { Store } = await import('../src/store.mjs');

  const j1 = normalizeScheduledJobInput({ name: 'Headless', prompt: 'Check', kind: 'cron', expression: '0 9 * * *', permissionPreset: 'dontAsk' });
  assert.equal(j1.permissionPreset, 'dontAsk');
  const j2 = normalizeScheduledJobInput({ name: 'Edits', prompt: 'Check', kind: 'cron', expression: '0 9 * * *', permissionPreset: 'acceptEdits' });
  assert.equal(j2.permissionPreset, 'acceptEdits');

  const dir = await mkdtemp(path.join(tmpdir(), 'godmode-cron-due-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(path.join(dir, 'state.sqlite'));
  t.after(() => store.close());
  const pastDue = new Date(Date.now() - 120_000).toISOString();
  store.putScheduledJob({ ...j1, nextRunAt: pastDue });

  // Constructing scheduler with reconcileOnBoot: false (CLI --due-only path) must NOT advance pastDue nextRunAt
  const cliScheduler = new CronScheduler({ store, onTrigger: async () => ({ status: 'completed' }), reconcileOnBoot: false });
  assert.equal(store.getScheduledJob(j1.id).nextRunAt, pastDue);
  const res = cliScheduler.triggerNow(j1.id, { respectEnabled: true });
  await res.promise;
  assert.ok(Date.parse(store.getScheduledJob(j1.id).nextRunAt) > Date.now(), 'triggerNow(respectEnabled) must advance nextRunAt');
  cliScheduler.stop();
});
