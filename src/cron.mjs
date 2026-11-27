import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const READ_ONLY_SCHEDULE_RULES = Object.freeze([
  Object.freeze({ tool: 'repo.write', action: 'deny', reason: 'Read-only scheduled job: file writes denied' }),
  Object.freeze({ tool: 'repo.patch', action: 'deny', reason: 'Read-only scheduled job: file patches denied' }),
  Object.freeze({ tool: 'repo.move', action: 'deny', reason: 'Read-only scheduled job: file moves denied' }),
  Object.freeze({ tool: 'repo.delete', action: 'deny', reason: 'Read-only scheduled job: file deletions denied' }),
  Object.freeze({ tool: 'git.commit', action: 'deny', reason: 'Read-only scheduled job: git commits denied' }),
  Object.freeze({ tool: 'process.run', action: 'deny', reason: 'Read-only scheduled job: shell commands denied' }),
  Object.freeze({ tool: 'memory.save', action: 'deny', reason: 'Read-only scheduled job: memory writes denied' }),
  Object.freeze({ tool: 'memory.delete', action: 'deny', reason: 'Read-only scheduled job: memory deletes denied' }),
  Object.freeze({ tool: 'browser.act', action: 'deny', reason: 'Read-only scheduled job: browser mutations denied' }),
  Object.freeze({ tool: 'browser.eval', action: 'deny', reason: 'Read-only scheduled job: browser eval denied' }),
]);

export const CRON_PRESETS = Object.freeze([
  { id: 'every_15m', label: 'Every 15 min', expression: '*/15 * * * *', description: 'Runs every 15 minutes' },
  { id: 'every_30m', label: 'Every 30 min', expression: '*/30 * * * *', description: 'Runs every 30 minutes' },
  { id: 'hourly', label: 'Hourly', expression: '0 * * * *', description: 'Runs at the top of every hour' },
  { id: 'daily_9am', label: 'Daily 9:00 AM', expression: '0 9 * * *', description: 'Runs every day at 9:00 AM' },
  { id: 'weekdays_9am', label: 'Weekdays 9:00 AM', expression: '0 9 * * 1-5', description: 'Runs Mon–Fri at 9:00 AM' },
  { id: 'weekly_mon', label: 'Weekly Mon 9:00 AM', expression: '0 9 * * 1', description: 'Runs every Monday at 9:00 AM' },
]);

const CRON_ALIASES = Object.freeze({
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
  '@weekdays': '0 9 * * 1-5',
  '@every_5m': '*/5 * * * *',
  '@every_15m': '*/15 * * * *',
  '@every_30m': '*/30 * * * *',
});

const MONTH_NAMES = Object.freeze({
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
});

const DOW_NAMES = Object.freeze({
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
});

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_JOBS = 100;
const VALID_PERMISSION_PRESETS = new Set(['safe', 'read_only', 'dontAsk', 'default', 'acceptEdits']);
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'max']);
const VALID_MODES = new Set(['godmode', 'godcode']);
const VALID_OVERLAP = new Set(['skip', 'queue']);

function cronError(message, code = 'INVALID_CRON') {
  return Object.assign(new Error(message), { code, status: 400 });
}

function parseFieldAtom(token, min, max, names, allowSevenAsZero = false) {
  const raw = String(token || '').trim().toLowerCase();
  if (!raw) throw cronError('Empty cron field value.');
  if (names && Object.hasOwn(names, raw)) return names[raw];
  if (!/^\d+$/.test(raw)) throw cronError(`Invalid cron token "${token}".`);
  let value = Number(raw);
  if (allowSevenAsZero && value === 7) value = 0;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw cronError(`Cron value "${token}" out of range (${min}–${max}).`);
  }
  return value;
}

function parseCronField(field, min, max, { names = null, allowSevenAsZero = false } = {}) {
  const raw = String(field || '').trim();
  if (!raw) throw cronError('Cron expression is missing a field.');
  const values = new Set();
  const isWildcard = raw === '*';
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) throw cronError(`Empty list item in cron field "${field}".`);
    const slashParts = trimmed.split('/');
    if (slashParts.length > 2) throw cronError(`Invalid step syntax "${trimmed}".`);
    const [rangePart, stepPart] = slashParts;
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) throw cronError(`Invalid step "${stepPart}".`);
      step = Number(stepPart);
      if (step < 1 || step > (max - min + 1)) throw cronError(`Step "${stepPart}" out of range.`);
    }
    if (rangePart === '*') {
      for (let v = min; v <= max; v += step) values.add(v);
      continue;
    }
    const dashIdx = rangePart.indexOf('-');
    if (dashIdx !== -1) {
      const startTok = rangePart.slice(0, dashIdx);
      const endTok = rangePart.slice(dashIdx + 1);
      if (endTok.includes('-')) throw cronError(`Invalid range "${rangePart}".`);
      const startRaw = startTok.trim().toLowerCase();
      const endRaw = endTok.trim().toLowerCase();
      const start = parseFieldAtom(startTok, min, max, names, allowSevenAsZero);
      let end;
      if (allowSevenAsZero && (endRaw === '7' || (endRaw === 'sun' && start > 0))) {
        end = 7;
      } else {
        end = parseFieldAtom(endTok, min, max, names, allowSevenAsZero);
      }
      if (allowSevenAsZero && startRaw === '7' && endRaw === '7') {
        values.add(0);
        continue;
      }
      if (end < start) throw cronError(`Cron range "${rangePart}" end is before start.`);
      for (let v = start; v <= end; v += step) {
        values.add(allowSevenAsZero && v === 7 ? 0 : v);
      }
      continue;
    }
    const single = parseFieldAtom(rangePart, min, max, names, allowSevenAsZero);
    if (stepPart !== undefined) {
      for (let v = single; v <= max; v += step) values.add(v);
    } else {
      values.add(single);
    }
  }
  if (!values.size) throw cronError(`Cron field "${field}" matched no values.`);
  const sorted = [...values].sort((a, b) => a - b);
  return { raw, isWildcard, values, sorted };
}

export function normalizeCronExpression(expression) {
  const trimmed = String(expression || '').trim();
  if (!trimmed) throw cronError('Cron expression is required.');
  if (trimmed.length > 120) throw cronError('Cron expression is too long.');
  const lower = trimmed.toLowerCase();
  if (Object.hasOwn(CRON_ALIASES, lower)) return CRON_ALIASES[lower];
  return trimmed.replace(/\s+/g, ' ');
}

export function parseCron(expression) {
  const normalized = normalizeCronExpression(expression);
  const parts = normalized.split(' ');
  if (parts.length !== 5) {
    throw cronError(`Expected 5-field cron expression (min hour dom month dow), got ${parts.length} fields.`);
  }
  return {
    normalized,
    minute: parseCronField(parts[0], 0, 59),
    hour: parseCronField(parts[1], 0, 23),
    dom: parseCronField(parts[2], 1, 31),
    month: parseCronField(parts[3], 1, 12, { names: MONTH_NAMES }),
    dow: parseCronField(parts[4], 0, 6, { names: DOW_NAMES, allowSevenAsZero: true }),
  };
}

function dayMatches(parsed, date) {
  const domMatch = parsed.dom.values.has(date.getDate());
  const dowMatch = parsed.dow.values.has(date.getDay());
  if (parsed.dom.isWildcard && parsed.dow.isWildcard) return true;
  if (parsed.dom.isWildcard) return dowMatch;
  if (parsed.dow.isWildcard) return domMatch;
  // Standard POSIX cron: when both DOM and DOW are restricted, either matching triggers
  return domMatch || dowMatch;
}

export function nextCronTime(expression, fromDate = new Date()) {
  const parsed = typeof expression === 'string' ? parseCron(expression) : expression;
  const start = new Date(fromDate instanceof Date ? fromDate.getTime() : Number(fromDate));
  if (Number.isNaN(start.getTime())) throw cronError('Invalid reference timestamp.');

  // Strictly after start, aligned to next whole minute
  const cursor = new Date(start.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const maxYear = cursor.getFullYear() + 4;
  let guard = 0;
  while (cursor.getFullYear() <= maxYear && guard++ < 50000) {
    const month = cursor.getMonth() + 1;
    if (!parsed.month.values.has(month)) {
      const nextMonth = parsed.month.sorted.find(m => m > month);
      if (nextMonth !== undefined) {
        cursor.setMonth(nextMonth - 1, 1);
      } else {
        cursor.setFullYear(cursor.getFullYear() + 1, parsed.month.sorted[0] - 1, 1);
      }
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(parsed, cursor)) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    const hour = cursor.getHours();
    if (!parsed.hour.values.has(hour)) {
      const nextHour = parsed.hour.sorted.find(h => h > hour);
      if (nextHour !== undefined) {
        cursor.setHours(nextHour, parsed.minute.sorted[0], 0, 0);
      } else {
        cursor.setDate(cursor.getDate() + 1);
        cursor.setHours(0, 0, 0, 0);
      }
      continue;
    }
    const minute = cursor.getMinutes();
    if (!parsed.minute.values.has(minute)) {
      const nextMinute = parsed.minute.sorted.find(m => m > minute);
      if (nextMinute !== undefined) {
        cursor.setMinutes(nextMinute, 0, 0);
      } else {
        // Advance by epoch minutes so DST fall-back repeated hours are never skipped
        cursor.setTime(cursor.getTime() + (60 - minute) * 60_000);
        cursor.setSeconds(0, 0);
      }
      continue;
    }
    return new Date(cursor.getTime());
  }
  throw cronError(`Cron expression "${parsed.normalized}" has no valid run time within 4 years.`);
}

export function previewCronRuns(expression, count = 3, fromDate = new Date()) {
  const parsed = parseCron(expression);
  const runs = [];
  let cursor = fromDate instanceof Date ? fromDate : new Date(fromDate);
  const limit = Math.max(1, Math.min(10, Number(count) || 3));
  for (let i = 0; i < limit; i++) {
    const next = nextCronTime(parsed, cursor);
    runs.push(next.toISOString());
    cursor = next;
  }
  return runs;
}

function formatClock(hour, minute) {
  const h = Number(hour);
  const m = String(minute).padStart(2, '0');
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m} ${suffix}`;
}

export function describeCron(expression) {
  try {
    const normalized = normalizeCronExpression(expression);
    const [min, hr, dom, mon, dow] = normalized.split(' ');
    if (normalized === '* * * * *') return 'Every minute';
    const stepMin = min.match(/^\*\/(\d+)$/);
    if (stepMin && hr === '*' && dom === '*' && mon === '*' && dow === '*') {
      return `Every ${stepMin[1]} minutes`;
    }
    const stepHr = hr.match(/^\*\/(\d+)$/);
    if (min === '0' && stepHr && dom === '*' && mon === '*' && dow === '*') {
      return `Every ${stepHr[1]} hours`;
    }
    if (/^\d+$/.test(min) && hr === '*' && dom === '*' && mon === '*' && dow === '*') {
      return min === '0' ? 'Hourly' : `Hourly at :${String(min).padStart(2, '0')}`;
    }
    if (/^\d+$/.test(min) && /^\d+$/.test(hr) && dom === '*' && mon === '*') {
      const clock = formatClock(hr, min);
      if (dow === '*') return `Daily at ${clock}`;
      if (dow === '1-5') return `Weekdays at ${clock}`;
      if (dow === '0,6' || dow === '6,0') return `Weekends at ${clock}`;
      if (/^\d$/.test(dow)) {
        const rawDow = Number(dow);
        if (rawDow >= 0 && rawDow <= 7) {
          const dayIdx = rawDow === 7 ? 0 : rawDow;
          return `Every ${DOW_LABELS[dayIdx]} at ${clock}`;
        }
      }
      return `${dow} at ${clock}`;
    }
    if (/^\d+$/.test(min) && /^\d+$/.test(hr) && /^\d+$/.test(dom) && mon === '*' && dow === '*') {
      return `Day ${dom} monthly at ${formatClock(hr, min)}`;
    }
    return normalized;
  } catch {
    return String(expression || '');
  }
}

export function validateScheduleInput(input = {}, now = new Date()) {
  const kind = input.kind === 'once' ? 'once' : 'cron';
  if (kind === 'once') {
    const raw = input.runAt;
    const target = new Date(raw);
    if (!raw || Number.isNaN(target.getTime())) {
      throw cronError('One-shot schedules require a valid ISO date/time.', 'INVALID_SCHEDULE');
    }
    return {
      valid: true,
      kind: 'once',
      expression: null,
      normalized: null,
      runAt: target.toISOString(),
      humanLabel: `Once at ${target.toLocaleString()}`,
      nextRunAt: target.toISOString(),
      previewRuns: [target.toISOString()],
    };
  }
  const exprInput = input.expression === undefined ? '0 9 * * *' : input.expression;
  const parsed = parseCron(exprInput);
  const previewRuns = previewCronRuns(parsed.normalized, 3, now);
  return {
    valid: true,
    kind: 'cron',
    expression: parsed.normalized,
    normalized: parsed.normalized,
    runAt: null,
    humanLabel: describeCron(parsed.normalized),
    nextRunAt: previewRuns[0],
    previewRuns,
  };
}

export function normalizeScheduledJobInput(input = {}, existing = null, now = new Date()) {
  const name = String(input.name ?? existing?.name ?? '').trim().slice(0, 120);
  if (!name) throw cronError('Schedule name is required.', 'INVALID_SCHEDULE');

  const prompt = String(input.prompt ?? existing?.prompt ?? '').trim().slice(0, 16000);
  if (!prompt) throw cronError('Schedule prompt/objective is required.', 'INVALID_SCHEDULE');

  const kind = input.kind ?? existing?.kind ?? 'cron';
  const expression = input.expression !== undefined ? input.expression : existing?.expression;
  const runAt = input.runAt !== undefined ? input.runAt : existing?.runAt;
  const schedule = validateScheduleInput({ kind, expression, runAt }, now);

  const modeRaw = String(input.mode ?? existing?.mode ?? 'godmode').toLowerCase();
  const mode = VALID_MODES.has(modeRaw) ? modeRaw : 'godmode';

  const sourcePathRaw = input.sourcePath !== undefined ? input.sourcePath : (existing?.sourcePath ?? '');
  const sourcePath = typeof sourcePathRaw === 'string' && sourcePathRaw.trim() ? sourcePathRaw.trim().slice(0, 1024) : null;
  if (mode === 'godcode') {
    if (!sourcePath || sourcePath.includes('\0') || !path.isAbsolute(sourcePath)) {
      throw cronError('GODCODƎ scheduled jobs require an absolute local repository path.', 'INVALID_SCHEDULE');
    }
  }

  const providerIdsRaw = input.providerIds !== undefined ? input.providerIds : (existing?.providerIds ?? []);
  const providerIds = Array.isArray(providerIdsRaw)
    ? [...new Set(providerIdsRaw.map(v => String(v || '').trim()).filter(Boolean))].slice(0, 6)
    : [];

  const effortRaw = String(input.effort ?? existing?.effort ?? 'medium').toLowerCase();
  const effort = VALID_EFFORTS.has(effortRaw) ? effortRaw : 'medium';

  const presetRaw = String(input.permissionPreset ?? existing?.permissionPreset ?? 'safe').toLowerCase();
  const permissionPreset = VALID_PERMISSION_PRESETS.has(presetRaw) ? presetRaw : 'safe';

  const overlapRaw = String(input.overlapPolicy ?? existing?.overlapPolicy ?? 'skip').toLowerCase();
  const overlapPolicy = VALID_OVERLAP.has(overlapRaw) ? overlapRaw : 'skip';

  const planMode = Boolean(input.planMode ?? existing?.planMode ?? false);
  const enabled = input.enabled !== undefined ? Boolean(input.enabled) : (existing ? Boolean(existing.enabled) : true);
  const maxRunsRaw = input.maxRuns !== undefined ? input.maxRuns : existing?.maxRuns;
  const maxRuns = (maxRunsRaw === null || maxRunsRaw === '' || maxRunsRaw === undefined)
    ? null
    : (Number.isInteger(Number(maxRunsRaw)) && Number(maxRunsRaw) >= 1 && Number(maxRunsRaw) <= 100000 ? Number(maxRunsRaw) : null);

  const createdAt = existing?.createdAt || now.toISOString();
  const updatedAt = now.toISOString();
  const scheduleChanged = !existing
    || existing.kind !== schedule.kind
    || existing.expression !== schedule.expression
    || existing.runAt !== schedule.runAt
    || (!existing.enabled && enabled);

  let nextRunAt = existing?.nextRunAt || null;
  if (!enabled) {
    nextRunAt = null;
  } else if (scheduleChanged || !nextRunAt) {
    if (schedule.kind === 'once') {
      nextRunAt = schedule.runAt;
    } else {
      nextRunAt = nextCronTime(schedule.expression, now).toISOString();
    }
  }

  return {
    id: existing?.id || `sched_${randomUUID().slice(0, 12)}`,
    name,
    prompt,
    kind: schedule.kind,
    expression: schedule.expression,
    runAt: schedule.runAt,
    humanLabel: schedule.humanLabel,
    mode,
    sourcePath: mode === 'godcode' ? sourcePath : null,
    providerIds,
    effort,
    permissionPreset,
    planMode,
    overlapPolicy,
    enabled,
    maxRuns,
    runCount: existing?.runCount || 0,
    lastRunAt: existing?.lastRunAt || null,
    lastStatus: existing?.lastStatus || null,
    lastError: existing?.lastError || null,
    lastTaskId: existing?.lastTaskId || null,
    nextRunAt,
    createdAt,
    updatedAt,
  };
}

function xmlEscape(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function renderLaunchdPlist(job, { nodePath = process.execPath, cliPath = 'src/cli.mjs', dataDir = '' } = {}) {
  const safeId = String(job.id || 'job').replace(/[^a-zA-Z0-9._-]/g, '-');
  const label = `gg.godmode.schedule.${safeId}`;
  const args = [nodePath, cliPath, 'cron', 'run', job.id, '--respect-enabled'];
  if (dataDir) args.push('--data', dataDir);

  const buildDict = ({ m = null, h = null, d = null, mo = null, w = null }) => {
    const lines = [];
    if (m !== null) lines.push(`      <key>Minute</key><integer>${m}</integer>`);
    if (h !== null) lines.push(`      <key>Hour</key><integer>${h}</integer>`);
    if (d !== null) lines.push(`      <key>Day</key><integer>${d}</integer>`);
    if (mo !== null) lines.push(`      <key>Month</key><integer>${mo}</integer>`);
    if (w !== null) lines.push(`      <key>Weekday</key><integer>${w}</integer>`);
    return `    <dict>\n${lines.join('\n')}\n    </dict>`;
  };

  let intervalXml = '';
  if (job.kind === 'once' && job.runAt) {
    const dt = new Date(job.runAt);
    if (!Number.isNaN(dt.getTime())) {
      const dict = buildDict({ m: dt.getMinutes(), h: dt.getHours(), d: dt.getDate(), mo: dt.getMonth() + 1 });
      intervalXml = `  <key>StartCalendarInterval</key>\n${dict.replace(/^    /gm, '  ')}`;
    }
  } else if (job.kind === 'cron' && job.expression) {
    try {
      const parsed = parseCron(job.expression);
      if (parsed.normalized === '* * * * *') {
        intervalXml = `  <key>StartInterval</key>\n  <integer>60</integer>`;
      } else {
        const mins = parsed.minute.isWildcard ? [null] : parsed.minute.sorted;
        const hrs = parsed.hour.isWildcard ? [null] : parsed.hour.sorted;
        const mons = parsed.month.isWildcard ? [null] : parsed.month.sorted;
        const bothRestricted = !parsed.dom.isWildcard && !parsed.dow.isWildcard;
        const entries = [];
        if (bothRestricted) {
          // Standard POSIX OR semantics: emit separate DOM-only and DOW-only calendar dicts
          const total = mins.length * hrs.length * mons.length * (parsed.dom.sorted.length + parsed.dow.sorted.length);
          if (total > 0 && total <= 48) {
            for (const m of mins) for (const h of hrs) for (const mo of mons) {
              for (const d of parsed.dom.sorted) entries.push(buildDict({ m, h, d, mo }));
              for (const w of parsed.dow.sorted) entries.push(buildDict({ m, h, mo, w }));
            }
          }
        } else {
          const doms = parsed.dom.isWildcard ? [null] : parsed.dom.sorted;
          const dows = parsed.dow.isWildcard ? [null] : parsed.dow.sorted;
          const total = mins.length * hrs.length * doms.length * mons.length * dows.length;
          if (total > 0 && total <= 48) {
            for (const m of mins) for (const h of hrs) for (const d of doms) for (const mo of mons) for (const w of dows) {
              entries.push(buildDict({ m, h, d, mo, w }));
            }
          }
        }
        if (entries.length === 1) {
          intervalXml = `  <key>StartCalendarInterval</key>\n${entries[0].replace(/^    /gm, '  ')}`;
        } else if (entries.length > 1) {
          intervalXml = `  <key>StartCalendarInterval</key>\n  <array>\n${entries.join('\n')}\n  </array>`;
        }
      }
    } catch {}
  }
  if (!intervalXml) {
    // Complex cron (>48 calendar entries): poll every minute with --due-only so CLI checks exact cron match
    args.push('--due-only');
    intervalXml = `  <key>StartInterval</key>\n  <integer>60</integer>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(a => `    <string>${xmlEscape(a)}</string>`).join('\n')}
  </array>
${intervalXml}
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
`;
}

export class CronScheduler {
  constructor({ store, onTrigger, onChange = null, tickMs = 15000, now = () => new Date() } = {}) {
    this.store = store;
    this.onTrigger = onTrigger;
    this.onChange = onChange;
    this.tickMs = Math.max(50, Number(tickMs) || 15000);
    this.now = now;
    this._timer = null;
    this._running = new Map();
    this._queued = new Set();
    this._closed = false;
    this._reconcileOnBoot();
  }

  _reconcileOnBoot() {
    const now = this.now();
    const jobs = this.store.listScheduledJobs();
    for (const job of jobs) {
      // Mark any leftover in-flight run from an earlier crash as interrupted
      const runs = this.store.listScheduledRuns(job.id, 5);
      for (const run of runs) {
        if (run.status === 'running') {
          this.store.putScheduledRun({
            ...run,
            status: 'interrupted',
            finishedAt: now.toISOString(),
            error: 'Runtime restarted while scheduled run was active.',
          });
        }
      }
      // Advance stale cron nextRunAt strictly forward so waking a laptop never triggers a storm
      if (job.enabled && job.kind === 'cron' && job.expression) {
        const nextMs = job.nextRunAt ? Date.parse(job.nextRunAt) : 0;
        if (!Number.isFinite(nextMs) || nextMs <= now.getTime()) {
          try {
            const nextRunAt = nextCronTime(job.expression, now).toISOString();
            this.store.putScheduledJob({ ...job, nextRunAt });
          } catch {}
        }
      }
    }
  }

  start() {
    if (this._closed || this._timer) return;
    this._timer = setInterval(() => {
      this.tick().catch(() => {});
    }, this.tickMs);
    this._timer.unref?.();
  }

  stop() {
    this._closed = true;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._queued.clear();
  }

  async close() {
    this.stop();
    await Promise.allSettled([...this._running.values()]);
  }

  listJobs() {
    return this.store.listScheduledJobs().map(job => ({
      ...job,
      running: this._running.has(job.id),
      queued: this._queued.has(job.id),
    }));
  }

  getJob(id) {
    const job = this.store.getScheduledJob(id);
    if (!job) throw Object.assign(new Error('Scheduled job not found.'), { code: 'SCHEDULE_NOT_FOUND', status: 404 });
    return {
      ...job,
      running: this._running.has(job.id),
      queued: this._queued.has(job.id),
    };
  }

  getRuns(id, limit = 25) {
    this.getJob(id);
    return this.store.listScheduledRuns(id, limit);
  }

  summary() {
    const jobs = this.store.listScheduledJobs();
    const enabled = jobs.filter(j => j.enabled);
    const nextTimes = enabled.map(j => Date.parse(j.nextRunAt || '')).filter(Number.isFinite).sort((a, b) => a - b);
    const completedJobs = jobs
      .map(j => ({ j, ts: Date.parse(j.lastRunAt || '') }))
      .filter(x => Number.isFinite(x.ts))
      .sort((a, b) => b.ts - a.ts);
    const recentRuns = completedJobs.slice(0, 8).map(({ j }) => ({
      runId: j.lastRunId || `${j.id}:${j.lastRunAt}:${j.lastStatus || 'completed'}`,
      jobId: j.id,
      jobName: j.name || 'Scheduled job',
      status: j.lastStatus || 'completed',
      taskId: j.lastTaskId || null,
      finishedAt: j.lastRunAt,
    }));
    const latestRun = recentRuns[0] || null;
    return {
      total: jobs.length,
      enabled: enabled.length,
      running: this._running.size,
      nextRunAt: nextTimes.length ? new Date(nextTimes[0]).toISOString() : null,
      latestRun,
      recentRuns,
    };
  }

  createJob(input) {
    const existing = this.store.listScheduledJobs();
    if (existing.length >= MAX_JOBS) {
      throw cronError(`Maximum of ${MAX_JOBS} scheduled jobs reached.`, 'SCHEDULE_LIMIT');
    }
    const job = normalizeScheduledJobInput(input, null, this.now());
    this.store.putScheduledJob(job);
    this.onChange?.('created', job);
    return this.getJob(job.id);
  }

  updateJob(id, patch = {}) {
    const current = this.store.getScheduledJob(id);
    if (!current) throw Object.assign(new Error('Scheduled job not found.'), { code: 'SCHEDULE_NOT_FOUND', status: 404 });
    const updated = normalizeScheduledJobInput(patch, current, this.now());
    this.store.putScheduledJob(updated);
    this.onChange?.('updated', updated);
    return this.getJob(updated.id);
  }

  deleteJob(id) {
    const current = this.store.getScheduledJob(id);
    if (!current) throw Object.assign(new Error('Scheduled job not found.'), { code: 'SCHEDULE_NOT_FOUND', status: 404 });
    this._queued.delete(id);
    this.store.deleteScheduledJob(id);
    this.onChange?.('deleted', current);
    return { deleted: true, id };
  }

  async tick() {
    if (this._closed) return [];
    const now = this.now();
    const nowMs = now.getTime();
    const jobs = this.store.listScheduledJobs();
    const triggered = [];

    for (const job of jobs) {
      if (!job.enabled || !job.nextRunAt) continue;
      const dueMs = Date.parse(job.nextRunAt);
      if (!Number.isFinite(dueMs) || dueMs > nowMs) continue;

      // Compute and persist the NEXT occurrence BEFORE dispatching so a slow run cannot re-fire the same slot
      let nextRunAt = null;
      let stillEnabled = job.enabled;
      if (job.kind === 'once') {
        stillEnabled = false;
      } else {
        try {
          nextRunAt = nextCronTime(job.expression, now).toISOString();
        } catch {
          stillEnabled = false;
        }
      }
      if (job.maxRuns && (job.runCount + 1) >= job.maxRuns) {
        stillEnabled = false;
        nextRunAt = null;
      }

      if (this._running.has(job.id)) {
        this.store.putScheduledJob({ ...job, enabled: stillEnabled, nextRunAt, updatedAt: now.toISOString() });
        if (job.overlapPolicy === 'queue') {
          this._queued.add(job.id);
        } else {
          this.store.putScheduledRun({
            id: `srun_${randomUUID().slice(0, 12)}`,
            jobId: job.id,
            trigger: 'schedule',
            status: 'skipped',
            startedAt: now.toISOString(),
            finishedAt: now.toISOString(),
            durationMs: 0,
            taskId: null,
            summary: 'Skipped because a previous run is still active.',
            error: null,
          });
        }
        continue;
      }

      const updatedJob = {
        ...job,
        enabled: stillEnabled,
        nextRunAt,
        updatedAt: now.toISOString(),
      };
      this.store.putScheduledJob(updatedJob);
      const dispatched = this._dispatch(updatedJob, 'schedule');
      dispatched.promise.catch(() => {});
      triggered.push(dispatched);
    }

    return triggered;
  }

  triggerNow(id, { respectEnabled = false } = {}) {
    if (this._closed) {
      throw Object.assign(new Error('Scheduler is closed.'), { code: 'SCHEDULER_CLOSED', status: 503 });
    }
    const job = this.store.getScheduledJob(id);
    if (!job) throw Object.assign(new Error('Scheduled job not found.'), { code: 'SCHEDULE_NOT_FOUND', status: 404 });
    if (respectEnabled && (!job.enabled || (job.maxRuns && (job.runCount || 0) >= job.maxRuns))) {
      return { skipped: true, reason: 'Scheduled job is paused or reached maxRuns.', run: null, promise: Promise.resolve(null) };
    }
    if (this._running.has(id)) {
      throw Object.assign(new Error('This scheduled job already has an active run.'), { code: 'SCHEDULE_BUSY', status: 409 });
    }
    if (respectEnabled && job.kind === 'once') {
      this.store.putScheduledJob({ ...job, enabled: false, nextRunAt: null, updatedAt: this.now().toISOString() });
    }
    return this._dispatch(job, respectEnabled ? 'schedule' : 'manual');
  }

  _dispatch(job, trigger = 'schedule') {
    const started = this.now();
    const run = {
      id: `srun_${randomUUID().slice(0, 12)}`,
      jobId: job.id,
      trigger,
      status: 'running',
      startedAt: started.toISOString(),
      finishedAt: null,
      durationMs: null,
      taskId: null,
      summary: null,
      error: null,
    };
    this.store.putScheduledRun(run);
    this.onChange?.('run.started', { jobId: job.id, run });

    const promise = (async () => {
      let result = null;
      let errMsg = null;
      let status = 'completed';
      try {
        result = await this.onTrigger(job, run);
        if (result?.status && ['completed', 'failed', 'blocked', 'paused', 'cancelled'].includes(result.status)) {
          status = result.status;
        }
        if (result?.error) errMsg = String(result.error).slice(0, 1000);
      } catch (error) {
        status = 'failed';
        errMsg = String(error?.message || error).slice(0, 1000);
      }
      const finished = this.now();
      const finalRun = {
        ...run,
        status,
        finishedAt: finished.toISOString(),
        durationMs: Math.max(0, finished.getTime() - started.getTime()),
        taskId: result?.taskId || null,
        summary: result?.summary ? String(result.summary).slice(0, 500) : null,
        error: errMsg,
      };
      if (!this.store.closed) {
        try {
          const latest = this.store.getScheduledJob(job.id);
          if (latest) {
            this.store.putScheduledRun(finalRun);
            const nextCount = (latest.runCount || 0) + 1;
            const hitMax = latest.maxRuns && nextCount >= latest.maxRuns;
            this.store.putScheduledJob({
              ...latest,
              runCount: nextCount,
              lastRunId: finalRun.id,
              lastRunAt: finalRun.finishedAt,
              lastStatus: finalRun.status,
              lastError: finalRun.error,
              lastTaskId: finalRun.taskId || null,
              enabled: hitMax ? false : latest.enabled,
              nextRunAt: hitMax ? null : latest.nextRunAt,
              updatedAt: finalRun.finishedAt,
            });
            this.onChange?.('run.finished', { jobId: job.id, run: finalRun });
          }
        } catch {}
      }
      return finalRun;
    })().finally(() => {
      this._running.delete(job.id);
      if (!this._closed && this._queued.has(job.id) && !this.store.closed) {
        this._queued.delete(job.id);
        try {
          const queuedJob = this.store.getScheduledJob(job.id);
          if (queuedJob && queuedJob.enabled) {
            this._dispatch(queuedJob, 'queued').promise.catch(() => {});
          }
        } catch {}
      }
    });

    this._running.set(job.id, promise);
    return { run, promise };
  }
}
