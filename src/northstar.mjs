import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { hasGit, gitInit, gitCommit } from './git.mjs';

const execFileAsync = promisify(execFile);

export const NORTHSTAR_TEMPLATES = Object.freeze([
  {
    id: 'ml_train',
    label: 'ML / Training Climb',
    icon: '◈',
    description: 'Karpathy autoresearch loop — iteratively modify training code to minimize validation loss.',
    goal: 'Iteratively improve model architecture, optimizer, and hyperparameters in train.py to minimize validation loss without modifying data loading or evaluation logic.',
    evalCommand: 'python3 train.py',
    metricMode: 'regex',
    metricPattern: '(?:val_bpb|val_loss)\\s*[:=]\\s*([0-9]+(?:\\.[0-9]+)?)',
    direction: 'minimize',
    guardrailCommand: '',
    maxHours: 12,
    maxIterations: 100,
  },
  {
    id: 'perf_speed',
    label: 'Speed / Size Optimization',
    icon: '⚡',
    description: 'Minimize latency, runtime, or bundle size while keeping the full test suite green.',
    goal: 'Optimize hot paths and memory allocations to minimize benchmark runtime (ms) while keeping all tests passing with clean, maintainable code.',
    evalCommand: 'npm run bench',
    metricMode: 'regex',
    metricPattern: '(?:median|p50|ms|elapsed)\\s*[:=]\\s*([0-9]+(?:\\.[0-9]+)?)',
    direction: 'minimize',
    guardrailCommand: 'npm test',
    maxHours: 8,
    maxIterations: 60,
  },
  {
    id: 'bench_eval',
    label: 'Benchmark / Eval Climb',
    icon: '★',
    description: 'Maximize pass rate or accuracy score on an automated evaluation harness.',
    goal: 'Analyze failing benchmark cases, fix root causes systematically, and maximize the overall evaluation score without hardcoding test inputs.',
    evalCommand: 'npm run eval',
    metricMode: 'regex',
    metricPattern: '(?:score|pass_rate|accuracy)\\s*[:=]\\s*([0-9]+(?:\\.[0-9]+)?)',
    direction: 'maximize',
    guardrailCommand: 'npm test',
    maxHours: 24,
    maxIterations: 120,
  },
  {
    id: 'prompt_opt',
    label: 'Prompt / Agent Optimization',
    icon: '✦',
    description: 'GEPA/DSPy-style iterative evolution of system prompts or agent heuristics against an eval script.',
    goal: 'Refine prompt instructions, structure, and few-shot guidance to maximize evaluation score while keeping prompts concise and generalizable.',
    evalCommand: 'node eval-prompts.mjs',
    metricMode: 'regex',
    metricPattern: 'score\\s*[:=]\\s*([0-9]+(?:\\.[0-9]+)?)',
    direction: 'maximize',
    guardrailCommand: '',
    maxHours: 6,
    maxIterations: 50,
  },
]);

const VALID_DIRECTIONS = new Set(['minimize', 'maximize']);
const VALID_METRIC_MODES = new Set(['regex', 'json', 'exit_code']);
const STRATEGY_STAGES = Object.freeze(['refine', 'refactor', 'paradigm_shift']);
const MAX_RUNS = 50;

function nsError(message, code = 'INVALID_NORTHSTAR', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function slugify(text) {
  return String(text || 'run')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'run';
}

function parseJsonPath(obj, dotPath) {
  const parts = String(dotPath || '').split('.').map(s => s.trim()).filter(Boolean);
  let cur = obj;
  for (const key of parts) {
    if (cur == null || typeof cur !== 'object') return null;
    cur = cur[key];
  }
  const n = Number(cur);
  return Number.isFinite(n) ? n : null;
}

export function extractMetric(output, { metricMode = 'regex', metricPattern = '', exitCode = 0 } = {}) {
  const fullText = String(output || '');
  const text = fullText.length > 32768 ? fullText.slice(-32768) : fullText;
  if (metricMode === 'exit_code') {
    return exitCode === 0 ? 1 : 0;
  }
  if (metricMode === 'json') {
    const trimmed = text.trim();
    const candidates = [trimmed];
    const lines = trimmed.split(/\r?\n/).reverse();
    for (const line of lines) {
      const l = line.trim();
      if (l.startsWith('{') && l.endsWith('}')) candidates.push(l);
    }
    for (const raw of candidates) {
      try {
        const parsed = JSON.parse(raw);
        const val = parseJsonPath(parsed, metricPattern || 'score');
        if (Number.isFinite(val)) return val;
      } catch {}
    }
    return null;
  }
  const pattern = String(metricPattern || '').trim() || '([0-9]+(?:\\.[0-9]+)?)';
  let re;
  try {
    re = new RegExp(pattern, 'gim');
  } catch {
    return null;
  }
  let lastVal = null;
  let m;
  while ((m = re.exec(text)) !== null) {
    const rawNum = m[1] !== undefined ? m[1] : m[0];
    const n = Number(String(rawNum).replace(/,/g, ''));
    if (Number.isFinite(n)) lastVal = n;
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return lastVal;
}

export function isStrictlyBetter(candidate, champion, direction = 'minimize') {
  if (!Number.isFinite(candidate)) return false;
  if (!Number.isFinite(champion)) return true;
  const eps = 1e-9;
  return direction === 'maximize' ? candidate > champion + eps : candidate < champion - eps;
}

export function targetReached(score, targetScore, direction = 'minimize') {
  if (!Number.isFinite(score) || !Number.isFinite(targetScore)) return false;
  return direction === 'maximize' ? score >= targetScore : score <= targetScore;
}

export function normalizeNorthStarInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw nsError('North Star run config must be an object.');
  }
  const goal = String(input.goal || '').trim().slice(0, 8000);
  if (!goal) throw nsError('Describe your North Star goal.');
  const evalCommand = String(input.evalCommand || '').trim().slice(0, 1000);
  if (!evalCommand) throw nsError('Provide an evaluation command (e.g. npm run bench or python3 train.py).');
  const repoPath = String(input.repoPath || '').trim();
  if (!repoPath) throw nsError('Provide a local repository or workspace folder path.');
  const resolvedRepo = path.resolve(repoPath);
  if (resolvedRepo === path.parse(resolvedRepo).root) {
    throw nsError('Repository path cannot be the filesystem root.');
  }

  const metricMode = VALID_METRIC_MODES.has(String(input.metricMode || 'regex')) ? String(input.metricMode || 'regex') : 'regex';
  const metricPattern = String(input.metricPattern || '').trim().slice(0, 300);
  if (metricMode === 'regex' && metricPattern) {
    if (/\([^)]*[+*][^)]*\)[+*?]/.test(metricPattern)) {
      throw nsError('Metric regex contains unsafe nested quantifiers.');
    }
    try { new RegExp(metricPattern); } catch (err) { throw nsError(`Invalid metric regex: ${err.message}`); }
  }
  const direction = VALID_DIRECTIONS.has(String(input.direction || 'minimize')) ? String(input.direction || 'minimize') : 'minimize';
  const guardrailCommand = String(input.guardrailCommand || '').trim().slice(0, 1000);
  const name = String(input.name || '').trim().slice(0, 80) || goal.split(/\r?\n/)[0].slice(0, 56);

  const maxHours = Math.max(0.05, Math.min(168, Number(input.maxHours) || 8));
  const maxIterations = Math.max(1, Math.min(5000, Math.round(Number(input.maxIterations) || 50)));
  const evalTimeoutMs = Math.max(5000, Math.min(3_600_000, Math.round(Number(input.evalTimeoutMs) || 120_000)));
  const plateauThreshold = Math.max(2, Math.min(30, Math.round(Number(input.plateauThreshold) || 5)));
  const reflectEvery = Math.max(3, Math.min(50, Math.round(Number(input.reflectEvery) || 10)));
  const beamWidth = Math.max(1, Math.min(3, Math.round(Number(input.beamWidth) || 1)));
  const rawTarget = input.targetScore;
  const targetScore = rawTarget !== undefined && rawTarget !== null && rawTarget !== '' && Number.isFinite(Number(rawTarget))
    ? Number(rawTarget)
    : null;
  const editableFiles = Array.isArray(input.editableFiles)
    ? input.editableFiles.map(f => String(f || '').trim().replace(/^\/+/, '')).filter(Boolean).slice(0, 40)
    : typeof input.editableFiles === 'string' && input.editableFiles.trim()
      ? input.editableFiles.split(/[,\n]+/).map(f => f.trim().replace(/^\/+/, '')).filter(Boolean).slice(0, 40)
      : [];
  const providerIds = Array.isArray(input.providerIds)
    ? [...new Set(input.providerIds.map(p => String(p || '').trim()).filter(Boolean))].slice(0, 8)
    : [];
  const keepAwake = Boolean(input.keepAwake);

  return {
    name,
    goal,
    repoPath: resolvedRepo,
    evalCommand,
    metricMode,
    metricPattern,
    direction,
    guardrailCommand,
    maxHours,
    maxIterations,
    evalTimeoutMs,
    plateauThreshold,
    reflectEvery,
    beamWidth,
    targetScore,
    editableFiles,
    providerIds,
    keepAwake,
  };
}

async function runShellCommand(command, cwd, { timeoutMs = 120_000, signal = null } = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    const shell = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command];
    const child = spawn(shell, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', DO_NOT_TRACK: '1', OTEL_SDK_DISABLED: '1' },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    const cap = 64 * 1024;
    const appendCap = (buf, chunk) => {
      const next = buf + chunk.toString('utf8');
      return next.length > cap ? next.slice(-cap) : next;
    };
    child.stdout.on('data', d => { stdout = appendCap(stdout, d); });
    child.stderr.on('data', d => { stderr = appendCap(stderr, d); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2500).unref();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1000).unref();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', err => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ exitCode: -1, stdout, stderr: `${stderr}\n${err.message}`.trim(), timedOut, aborted, durationMs: Date.now() - start });
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ exitCode: code ?? -1, stdout, stderr, timedOut, aborted, durationMs: Date.now() - start });
    });
  });
}

async function gitExec(args, cwd) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'G0DC0D3 North Star',
      GIT_AUTHOR_EMAIL: 'northstar@g0dc0d3.local',
      GIT_COMMITTER_NAME: 'G0DC0D3 North Star',
      GIT_COMMITTER_EMAIL: 'northstar@g0dc0d3.local',
    },
  });
  return stdout.trim();
}

async function gitWorktreeCommit(cwd, message) {
  await gitExec(['add', '-A'], cwd);
  await gitExec(['commit', '-q', '-m', message], cwd);
  return gitExec(['rev-parse', 'HEAD'], cwd);
}

function fileMatchesAllowlist(relPath, allowlist) {
  if (!allowlist || !allowlist.length) return true;
  const clean = String(relPath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return allowlist.some(rule => {
    const r = rule.replace(/\\/g, '/').replace(/^\.\//, '');
    if (r === clean) return true;
    if (r.endsWith('/') && clean.startsWith(r)) return true;
    if (r.endsWith('/*') && clean.startsWith(r.slice(0, -1))) return true;
    if (r.endsWith('/**') && clean.startsWith(r.slice(0, -2))) return true;
    if (r.startsWith('*.') && clean.endsWith(r.slice(1))) return true;
    return false;
  });
}

async function copyWorkspaceSnapshot(srcDir, dstDir) {
  await fs.mkdir(dstDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (['.git', 'node_modules', '.g0dc0d3', 'dist', '.next', '.venv', '__pycache__'].includes(entry.name)) continue;
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      await copyWorkspaceSnapshot(src, dst);
    } else if (entry.isFile()) {
      await fs.copyFile(src, dst);
    }
  }
}

export class NorthStarManager {
  constructor({ dataDir, runtime = null, iterationRunner = null, onEvent = null } = {}) {
    this.baseDir = path.join(dataDir, 'northstar');
    this.runtime = runtime;
    this.iterationRunner = iterationRunner;
    this.onEvent = typeof onEvent === 'function' ? onEvent : null;
    this.runs = new Map();
    this.activeControllers = new Map();
    this.activePromises = new Map();
    this.caffeinateProcs = new Map();
    this.closed = false;
  }

  async init() {
    await fs.mkdir(this.baseDir, { recursive: true });
    let entries = [];
    try { entries = await fs.readdir(this.baseDir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const stateFile = path.join(this.baseDir, ent.name, 'state.json');
      try {
        const raw = await fs.readFile(stateFile, 'utf8');
        const state = JSON.parse(raw);
        if (state && state.id) {
          if (state.status === 'running') {
            state.status = 'paused';
            state.pauseReason = 'App restarted — click Resume to continue cleanly.';
          }
          this.runs.set(state.id, state);
        }
      } catch {}
    }
  }

  _runDir(id) { return path.join(this.baseDir, id); }
  _statePath(id) { return path.join(this._runDir(id), 'state.json'); }
  _expPath(id) { return path.join(this._runDir(id), 'experiments.jsonl'); }
  _logPath(id) { return path.join(this._runDir(id), 'LAB_LOG.md'); }

  async _persist(run) {
    run.updatedAt = new Date().toISOString();
    const dir = this._runDir(run.id);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this._statePath(run.id)}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(run, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(tmp, this._statePath(run.id));
  }

  async _appendExperiment(runId, record) {
    await fs.appendFile(this._expPath(runId), JSON.stringify(record) + '\n', { mode: 0o600 });
  }

  async _writeLabLog(run, experiments) {
    const wins = experiments.filter(e => e.status === 'kept');
    const losses = experiments.filter(e => e.status !== 'kept');
    const lines = [
      `# North Star Lab Log — ${run.name}`,
      '',
      `- **Status:** ${run.status}`,
      `- **Goal:** ${run.goal}`,
      `- **Direction:** ${run.direction} (\`${run.evalCommand}\`)`,
      `- **Baseline:** ${run.baselineScore ?? 'pending'} → **Best:** ${run.bestScore ?? 'pending'}${run.targetScore !== null ? ` (Target: ${run.targetScore})` : ''}`,
      `- **Iterations:** ${run.iterations}/${run.maxIterations} · **Kept:** ${wins.length} · **Reverted:** ${losses.length}`,
      '',
      '## Kept Improvements',
      ...(wins.length
        ? wins.map(w => `- **#${w.iteration}** \`${w.commit?.slice(0, 7) || ''}\` score **${w.score}** (${w.delta >= 0 ? '+' : ''}${w.delta.toFixed(4)}) via \`${w.providerId || 'agent'}\` — ${w.hypothesis}`)
        : ['_No kept improvements yet._']),
      '',
      '## Meta-Reflections',
      ...(run.reflections?.length ? run.reflections.map(r => `- [Iter #${r.iteration}] ${r.summary}`) : ['_None yet._']),
      '',
      '## Recent Dead Ends (Do Not Repeat)',
      ...(losses.slice(-15).map(l => `- **#${l.iteration}** [${l.status}] ${l.hypothesis} — ${l.note || 'no improvement'}`)),
    ];
    await fs.writeFile(this._logPath(run.id), lines.join('\n') + '\n', { mode: 0o600 });
  }

  _emit(type, payload) {
    if (this.onEvent) {
      try { this.onEvent(type, payload); } catch {}
    }
  }

  _startKeepAwake(runId, enabled) {
    if (!enabled || process.platform !== 'darwin' || this.caffeinateProcs.has(runId)) return;
    try {
      const proc = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', detached: false });
      proc.on('error', () => { this.caffeinateProcs.delete(runId); });
      proc.on('exit', () => { this.caffeinateProcs.delete(runId); });
      this.caffeinateProcs.set(runId, proc);
    } catch {}
  }

  _stopKeepAwake(runId) {
    const proc = this.caffeinateProcs.get(runId);
    if (!proc) return;
    this.caffeinateProcs.delete(runId);
    try { proc.kill('SIGTERM'); } catch {}
  }

  summary() {
    const list = [...this.runs.values()];
    return {
      total: list.length,
      running: list.filter(r => r.status === 'running').length,
      paused: list.filter(r => r.status === 'paused').length,
      completed: list.filter(r => r.status === 'completed').length,
    };
  }

  listRuns() {
    return [...this.runs.values()].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }

  getRun(id) {
    const run = this.runs.get(id);
    if (!run) throw nsError('North Star run not found.', 'NOT_FOUND', 404);
    return run;
  }

  async getExperiments(id, limit = 100) {
    this.getRun(id);
    try {
      const raw = await fs.readFile(this._expPath(id), 'utf8');
      const rows = raw.trim().split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      return rows.slice(-Math.max(1, Math.min(500, limit)));
    } catch {
      return [];
    }
  }

  async getLabLog(id) {
    this.getRun(id);
    try { return await fs.readFile(this._logPath(id), 'utf8'); } catch { return ''; }
  }

  async createRun(input, { autoStart = false } = {}) {
    if (this.closed) throw nsError('North Star manager is closed.', 'RUNTIME_CLOSED', 503);
    if (this.runs.size >= MAX_RUNS) throw nsError(`Maximum ${MAX_RUNS} North Star runs reached; delete old runs first.`);
    const cfg = normalizeNorthStarInput(input);
    const stat = await fs.stat(cfg.repoPath).catch(() => null);
    if (!stat || !stat.isDirectory()) throw nsError(`Repository folder not found: ${cfg.repoPath}`);

    const id = `ns_${randomUUID().slice(0, 12)}`;
    const runDir = this._runDir(id);
    const worktreePath = path.join(runDir, 'worktree');
    const branch = `northstar/${slugify(cfg.name)}-${id.slice(-6)}`;
    await fs.mkdir(runDir, { recursive: true });

    let isGitWorktree = false;
    const repoHasGit = await hasGit(cfg.repoPath);
    if (repoHasGit) {
      try {
        await gitExec(['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], cfg.repoPath);
        isGitWorktree = true;
      } catch {
        // Fallback cleanly to isolated git-initialized copy if HEAD is unborn or worktree unavailable
        isGitWorktree = false;
      }
    }
    if (!isGitWorktree) {
      await copyWorkspaceSnapshot(cfg.repoPath, worktreePath);
      await gitInit(worktreePath);
      await gitCommit(worktreePath, { message: 'northstar: baseline snapshot' });
    }
    const baselineSha = await gitExec(['rev-parse', 'HEAD'], worktreePath);

    await fs.writeFile(path.join(runDir, 'NORTHSTAR.md'), [
      `# NORTHSTAR: ${cfg.name}`,
      '',
      '## Objective',
      cfg.goal,
      '',
      '## Evaluation Contract',
      `- Eval command: \`${cfg.evalCommand}\``,
      `- Direction: **${cfg.direction}** (${cfg.metricMode}${cfg.metricPattern ? `: \`${cfg.metricPattern}\`` : ''})`,
      ...(cfg.guardrailCommand ? [`- Guardrail (must exit 0): \`${cfg.guardrailCommand}\``] : []),
      ...(cfg.editableFiles.length ? [`- Editable files allowlist: ${cfg.editableFiles.map(f => `\`${f}\``).join(', ')}`] : []),
    ].join('\n') + '\n', { mode: 0o600 });

    const now = new Date().toISOString();
    const run = {
      id,
      ...cfg,
      worktreePath,
      branch,
      isGitWorktree,
      status: 'idle',
      pauseReason: null,
      baselineSha,
      championSha: baselineSha,
      baselineScore: null,
      bestScore: null,
      champions: [], // Top-K evolutionary archive: [{ sha, score, iteration, providerId }]
      iterations: 0,
      keptCount: 0,
      revertedCount: 0,
      plateauCount: 0,
      strategyStage: 0,
      activeProviderIndex: 0,
      steeringQueue: [],
      reflections: [],
      scoreHistory: [], // [{ iteration, score, bestScore, status, at }]
      startedAt: null,
      elapsedMs: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(id, run);
    await this._persist(run);
    await this._writeLabLog(run, []);
    if (autoStart) this.startRun(id);
    return run;
  }

  startRun(id) {
    if (this.closed) throw nsError('North Star manager is closed.', 'RUNTIME_CLOSED', 503);
    const run = this.getRun(id);
    if (run.status === 'running' && this.activePromises.has(id)) return run;
    if (run.status === 'completed') throw nsError('Run already completed. Create a new run to continue.');
    const controller = new AbortController();
    this.activeControllers.set(id, controller);
    run.status = 'running';
    run.pauseReason = null;
    if (!run.startedAt) run.startedAt = new Date().toISOString();
    this._startKeepAwake(id, run.keepAwake);
    const promise = this._runLoop(id, controller.signal)
      .catch(async err => {
        const cur = this.runs.get(id);
        if (cur && cur.status === 'running') {
          cur.status = 'failed';
          cur.pauseReason = err?.message || 'North Star loop error';
          await this._persist(cur).catch(() => {});
        }
      })
      .finally(() => {
        if (this.activeControllers.get(id) === controller) this.activeControllers.delete(id);
        if (this.activePromises.get(id) === promise) this.activePromises.delete(id);
        this._stopKeepAwake(id);
      });
    this.activePromises.set(id, promise);
    promise.catch(() => {});
    return run;
  }

  resumeRun(id) { return this.startRun(id); }

  async waitForRun(id) {
    const p = this.activePromises.get(id);
    if (p) await p;
    return this.getRun(id);
  }

  async pauseRun(id, reason = 'Paused by user') {
    const run = this.getRun(id);
    const ctrl = this.activeControllers.get(id);
    if (ctrl) ctrl.abort();
    const p = this.activePromises.get(id);
    if (p) await p.catch(() => {});
    run.status = 'paused';
    run.pauseReason = reason;
    this._stopKeepAwake(id);
    await this._persist(run);
    return run;
  }

  async steerRun(id, note) {
    const run = this.getRun(id);
    const clean = String(note || '').trim().slice(0, 1500);
    if (!clean) throw nsError('Provide a steering note for the next iteration.');
    run.steeringQueue = [...(run.steeringQueue || []), { id: randomUUID().slice(0, 8), note: clean, at: new Date().toISOString() }].slice(-10);
    await this._persist(run);
    return run;
  }

  async getChampionDiff(id) {
    const run = this.getRun(id);
    try {
      const diff = await gitExec(['diff', `${run.baselineSha}..${run.championSha}`], run.worktreePath);
      const stat = await gitExec(['diff', '--stat', `${run.baselineSha}..${run.championSha}`], run.worktreePath);
      return { id: run.id, baselineSha: run.baselineSha, championSha: run.championSha, baselineScore: run.baselineScore, bestScore: run.bestScore, stat, diff };
    } catch (err) {
      throw nsError(`Could not compute champion diff: ${err.message}`, 'DIFF_ERROR', 500);
    }
  }

  async applyChampionToRepo(id) {
    const run = this.getRun(id);
    if (run.status === 'running') throw nsError('Pause the North Star run before applying the champion patch.', 'RUN_ACTIVE', 409);
    const { diff } = await this.getChampionDiff(id);
    if (!diff.trim()) return { ok: true, applied: false, message: 'Champion matches baseline; nothing to apply.' };
    const patchPath = path.join(this._runDir(id), 'champion.patch');
    await fs.writeFile(patchPath, diff + '\n', { mode: 0o600 });
    try {
      await execFileAsync('git', ['apply', '--check', patchPath], { cwd: run.repoPath });
      await execFileAsync('git', ['apply', patchPath], { cwd: run.repoPath });
      return { ok: true, applied: true, championSha: run.championSha, bestScore: run.bestScore, patchPath };
    } catch (err) {
      throw nsError(`Could not cleanly apply champion patch to ${run.repoPath}: ${err.stderr || err.message}`, 'APPLY_CONFLICT', 409);
    }
  }

  async deleteRun(id) {
    const run = this.getRun(id);
    if (run.status === 'running') await this.pauseRun(id, 'Deleting run');
    this._stopKeepAwake(id);
    if (run.isGitWorktree) {
      try { await gitExec(['worktree', 'remove', '--force', run.worktreePath], run.repoPath); } catch {}
      try { await gitExec(['branch', '-D', run.branch], run.repoPath); } catch {}
    }
    this.runs.delete(id);
    await fs.rm(this._runDir(id), { recursive: true, force: true }).catch(() => {});
    return { ok: true, deleted: id };
  }

  async close() {
    this.closed = true;
    for (const [id, ctrl] of this.activeControllers.entries()) {
      ctrl.abort();
      this._stopKeepAwake(id);
    }
    await Promise.all([...this.activePromises.values()].map(p => p.catch(() => {})));
    for (const run of this.runs.values()) {
      if (run.status === 'running') {
        run.status = 'paused';
        run.pauseReason = 'App closed — click Resume to continue.';
        await this._persist(run).catch(() => {});
      }
    }
  }

  async _resetToSha(worktreePath, sha) {
    await gitExec(['reset', '--hard', sha], worktreePath);
    await gitExec(['clean', '-fd'], worktreePath);
  }

  async _changedFiles(worktreePath) {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain', '-uall'], { cwd: worktreePath, maxBuffer: 8 * 1024 * 1024 });
    const raw = stdout.replace(/[\r\n]+$/, '');
    if (!raw) return [];
    const out = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.length < 4) continue;
      const body = line.slice(3).trim();
      // Handle rename lines: "old -> new" — check both paths for scope enforcement!
      if (body.includes(' -> ')) {
        for (const part of body.split(' -> ')) out.push(part.trim().replace(/^"|"$/g, ''));
      } else {
        out.push(body.replace(/^"|"$/g, ''));
      }
    }
    return [...new Set(out.filter(Boolean))];
  }

  _resolveProvidersForIteration(run) {
    const configured = run.providerIds?.length
      ? run.providerIds
      : [...(this.runtime?.providers?.values?.() || [])].filter(p => p.available !== false && !p.closed && p.kind !== 'scripted').map(p => p.id);
    if (!configured.length) return [];
    const idx = run.activeProviderIndex % configured.length;
    return [configured[idx], ...configured.filter((_, i) => i !== idx)];
  }

  _buildIterationPrompt(run, experiments, steeringNotes, activeStage, championDiffStat) {
    const wins = experiments.filter(e => e.status === 'kept').slice(-8);
    const deadEnds = experiments.filter(e => e.status !== 'kept').slice(-10);
    const stageDirective = activeStage === 'paradigm_shift'
      ? 'PLATEAU ESCALATION (Paradigm Shift): Minor tweaks have stalled. Propose and implement a fundamentally different algorithmic, structural, or architectural approach.'
      : activeStage === 'refactor'
        ? 'PLATEAU ESCALATION (Structural Refactor): Small tweaks stalled. Try a deeper refactor or combine orthogonal improvements.'
        : 'Incremental focused experiment: Make ONE clean, high-leverage hypothesis-driven improvement.';
    return [
      `You are running Iteration #${run.iterations + 1}/${run.maxIterations} of a G0DC0D3 North Star autonomous hill-climb.`,
      `## Immutable Goal\n${run.goal}`,
      `## Current Standing\n- Direction: **${run.direction}** metric from \`${run.evalCommand}\`\n- Baseline: ${run.baselineScore} → Current Champion: ${run.bestScore}${run.targetScore !== null ? ` (Target: ${run.targetScore})` : ''}\n- Strategy Mode: ${stageDirective}`,
      ...(run.editableFiles.length ? [`## Editable Files Allowlist (STRICT)\nOnly modify files matching: ${run.editableFiles.join(', ')}. Editing any other file causes automatic revert.`] : []),
      ...(championDiffStat ? [`## Champion Diff vs Baseline\n\`\`\`\n${championDiffStat.slice(0, 1200)}\n\`\`\``] : []),
      ...(wins.length ? [`## Recent Kept Improvements\n${wins.map(w => `- #${w.iteration}: score ${w.score} (${w.delta >= 0 ? '+' : ''}${w.delta.toFixed(4)}) — ${w.hypothesis}`).join('\n')}`] : []),
      ...(deadEnds.length ? [`## Dead-End Graveyard (Do NOT Repeat)\n${deadEnds.map(d => `- #${d.iteration} [${d.status}]: ${d.hypothesis} (${d.note || 'reverted'})`).join('\n')}`] : []),
      ...(run.reflections.length ? [`## Latest Meta-Reflection\n${run.reflections.at(-1).summary}`] : []),
      ...(steeringNotes.length ? [`## Live User Steering Directives (HIGH PRIORITY)\n${steeringNotes.map(n => `- ${n.note}`).join('\n')}`] : []),
      '## Instructions\n1. State your concrete 1-sentence hypothesis clearly.\n2. Edit the target files in this workspace cleanly.\n3. Do NOT touch evaluation scripts or fake metrics.\n4. Finish cleanly once the edit is written — the North Star controller runs the official evaluation and git commit/revert automatically.',
    ].join('\n\n');
  }

  async _runDefaultIteration(run, prompt, providers, signal) {
    if (!this.runtime) throw nsError('Runtime unavailable for North Star iteration.', 'NO_RUNTIME', 500);
    if (!providers.length) throw nsError('No live AI provider connected for North Star run.', 'NO_PROVIDER', 400);
    const task = await this.runtime.createTask({
      workspace: run.worktreePath,
      objective: prompt,
      providers,
      policy: { mode: 'adaptive', maxAttempts: 4, maxCalls: 24, learning: true },
      execution: { enabled: true, network: false },
    });
    const onAbort = () => { try { this.runtime.pause(task.id); } catch {} };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const done = await this.runtime.run(task.id);
      const events = this.runtime.getEvents(task.id);
      const lastReply = [...events].reverse().find(e => e.type === 'model.response')?.data?.response?.text || '';
      const hypothesis = String(lastReply).split(/\r?\n/).map(l => l.trim()).find(Boolean)?.slice(0, 220) || `Iteration #${run.iterations + 1} (${providers[0]})`;
      return { hypothesis, providerId: done?.providerId || providers[0] };
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  async _runLoop(id, signal) {
    const run = this.getRun(id);
    const sessionStartMs = Date.now();
    const baseElapsedMs = Number(run.elapsedMs || 0);
    const budgetMs = run.maxHours * 3_600_000;
    const experiments = await this.getExperiments(id, 500);

    // Step 0: Measure verified baseline if not recorded yet
    if (!Number.isFinite(run.baselineScore)) {
      const baseEval = await runShellCommand(run.evalCommand, run.worktreePath, { timeoutMs: run.evalTimeoutMs, signal });
      if (signal.aborted) return;
      const baseMetric = extractMetric(`${baseEval.stdout}\n${baseEval.stderr}`, run);
      if (!Number.isFinite(baseMetric)) {
        run.status = 'failed';
        run.pauseReason = `Baseline eval failed to produce a numeric metric (exit ${baseEval.exitCode}). Check evalCommand / metricPattern.`;
        await this._persist(run);
        return;
      }
      run.baselineScore = baseMetric;
      run.bestScore = baseMetric;
      run.champions = [{ sha: run.baselineSha, score: baseMetric, iteration: 0, providerId: 'baseline' }];
      run.scoreHistory.push({ iteration: 0, score: baseMetric, bestScore: baseMetric, status: 'baseline', at: new Date().toISOString() });
      await this._persist(run);
      await this._writeLabLog(run, experiments);
    }

    while (!signal.aborted && !this.closed) {
      run.elapsedMs = baseElapsedMs + (Date.now() - sessionStartMs);
      if (run.iterations >= run.maxIterations) {
        run.status = 'completed';
        run.pauseReason = `Reached iteration budget (${run.maxIterations}).`;
        break;
      }
      if (run.elapsedMs >= budgetMs) {
        run.status = 'completed';
        run.pauseReason = `Reached time budget (${run.maxHours}h).`;
        break;
      }
      if (run.targetScore !== null && targetReached(run.bestScore, run.targetScore, run.direction)) {
        run.status = 'completed';
        run.pauseReason = `Target score ${run.targetScore} achieved (${run.bestScore})!`;
        break;
      }

      // Top-K Beam exploration on plateau: switch base commit to an alternate champion if beamWidth > 1
      let baseChampionSha = run.championSha;
      if (run.beamWidth > 1 && run.plateauCount >= run.plateauThreshold && run.champions.length >= 2) {
        const alt = run.champions[run.iterations % Math.min(run.beamWidth, run.champions.length)];
        if (alt?.sha) baseChampionSha = alt.sha;
      }
      await this._resetToSha(run.worktreePath, baseChampionSha);

      const steeringNotes = [...(run.steeringQueue || [])];
      if (steeringNotes.length) {
        run.steeringQueue = [];
        await this._persist(run);
      }

      const activeStage = STRATEGY_STAGES[Math.min(STRATEGY_STAGES.length - 1, run.strategyStage || 0)];
      const providers = this._resolveProvidersForIteration(run);
      const diffStat = run.championSha !== run.baselineSha
        ? await gitExec(['diff', '--stat', `${run.baselineSha}..${run.championSha}`], run.worktreePath).catch(() => '')
        : '';
      const prompt = this._buildIterationPrompt(run, experiments, steeringNotes, activeStage, diffStat);
      const iterNum = run.iterations + 1;
      const iterStarted = Date.now();

      let iterResult;
      try {
        iterResult = this.iterationRunner
          ? await this.iterationRunner({ run, iteration: iterNum, prompt, worktreePath: run.worktreePath, stage: activeStage, providerId: providers[0] || 'custom', steeringNotes, signal })
          : await this._runDefaultIteration(run, prompt, providers, signal);
      } catch (err) {
        if (signal.aborted) break;
        await this._resetToSha(run.worktreePath, run.championSha);
        run.iterations = iterNum;
        run.revertedCount += 1;
        run.plateauCount += 1;
        const rec = { iteration: iterNum, status: 'agent_error', score: null, delta: 0, hypothesis: `Iter #${iterNum}`, note: String(err?.message || 'Agent error').slice(0, 300), providerId: providers[0] || null, stage: activeStage, durationMs: Date.now() - iterStarted, at: new Date().toISOString() };
        experiments.push(rec);
        await this._appendExperiment(id, rec);
        await this._handlePlateauAndReflection(run, experiments);
        await this._persist(run);
        await this._writeLabLog(run, experiments);
        continue;
      }
      if (signal.aborted) {
        await this._resetToSha(run.worktreePath, run.championSha).catch(() => {});
        break;
      }

      const hypothesis = String(iterResult?.hypothesis || `Experiment #${iterNum}`).trim().slice(0, 260);
      const usedProvider = iterResult?.providerId || providers[0] || 'agent';
      const changed = await this._changedFiles(run.worktreePath);

      let status = 'reverted';
      let score = null;
      let delta = 0;
      let note = '';
      let commitSha = null;

      const symlinkHits = [];
      for (const rel of changed) {
        try {
          const st = await fs.lstat(path.join(run.worktreePath, rel));
          if (st.isSymbolicLink()) symlinkHits.push(rel);
        } catch {}
      }
      if (!changed.length) {
        status = 'no_op';
        note = 'No workspace files modified.';
      } else if (symlinkHits.length) {
        status = 'scope_violation';
        note = `Symlink creation is blocked in North Star worktrees: ${symlinkHits.slice(0, 4).join(', ')}`;
        await this._resetToSha(run.worktreePath, run.championSha);
      } else if (run.editableFiles.length && changed.some(f => !fileMatchesAllowlist(f, run.editableFiles))) {
        const bad = changed.filter(f => !fileMatchesAllowlist(f, run.editableFiles));
        status = 'scope_violation';
        note = `Modified locked file(s): ${bad.slice(0, 4).join(', ')}`;
        await this._resetToSha(run.worktreePath, run.championSha);
      } else {
        let guardrailOk = true;
        if (run.guardrailCommand) {
          const gr = await runShellCommand(run.guardrailCommand, run.worktreePath, { timeoutMs: run.evalTimeoutMs, signal });
          if (signal.aborted) { await this._resetToSha(run.worktreePath, run.championSha).catch(() => {}); break; }
          if (gr.exitCode !== 0 || gr.timedOut) {
            guardrailOk = false;
            status = 'guardrail_failed';
            note = gr.timedOut ? 'Guardrail command timed out.' : `Guardrail exited ${gr.exitCode}: ${(gr.stderr || gr.stdout).trim().slice(-200)}`;
            await this._resetToSha(run.worktreePath, run.championSha);
          }
        }
        if (guardrailOk) {
          const ev = await runShellCommand(run.evalCommand, run.worktreePath, { timeoutMs: run.evalTimeoutMs, signal });
          if (signal.aborted) { await this._resetToSha(run.worktreePath, run.championSha).catch(() => {}); break; }
          score = extractMetric(`${ev.stdout}\n${ev.stderr}`, run);
          if (ev.timedOut || !Number.isFinite(score)) {
            status = ev.timedOut ? 'timeout' : 'eval_error';
            note = ev.timedOut ? 'Eval command timed out.' : `No numeric metric parsed (exit ${ev.exitCode}).`;
            await this._resetToSha(run.worktreePath, run.championSha);
          } else {
            delta = score - run.bestScore;
            if (isStrictlyBetter(score, run.bestScore, run.direction)) {
              const commitMsg = `northstar(exp-${String(iterNum).padStart(3, '0')}): ${score} (${delta >= 0 ? '+' : ''}${delta.toFixed(4)})`;
              commitSha = await gitWorktreeCommit(run.worktreePath, commitMsg);
              run.championSha = commitSha;
              run.bestScore = score;
              run.keptCount += 1;
              run.plateauCount = 0;
              run.strategyStage = 0;
              run.champions = [...(run.champions || []), { sha: commitSha, score, iteration: iterNum, providerId: usedProvider }]
                .sort((a, b) => run.direction === 'maximize' ? b.score - a.score : a.score - b.score)
                .slice(0, Math.max(1, run.beamWidth));
              status = 'kept';
              note = `New record! ${score} (${delta >= 0 ? '+' : ''}${delta.toFixed(4)})`;
              try {
                this.runtime?.store?.recordDomainOutcome?.({ domain: 'swe_coding', providerId: usedProvider, outcome: 'win' });
              } catch {}
            } else {
              status = 'reverted';
              note = `Score ${score} did not beat champion ${run.bestScore}.`;
              await this._resetToSha(run.worktreePath, run.championSha);
            }
          }
        }
      }

      run.iterations = iterNum;
      if (status !== 'kept') {
        run.revertedCount += 1;
        run.plateauCount += 1;
      }
      run.elapsedMs = baseElapsedMs + (Date.now() - sessionStartMs);
      const record = {
        iteration: iterNum,
        status,
        score,
        bestScore: run.bestScore,
        delta,
        commit: commitSha,
        hypothesis,
        note,
        changedFiles: changed.slice(0, 10),
        providerId: usedProvider,
        stage: activeStage,
        durationMs: Date.now() - iterStarted,
        at: new Date().toISOString(),
      };
      experiments.push(record);
      run.scoreHistory = [...(run.scoreHistory || []), { iteration: iterNum, score, bestScore: run.bestScore, status, at: record.at }].slice(-200);
      await this._appendExperiment(id, record);
      await this._handlePlateauAndReflection(run, experiments);
      await this._persist(run);
      await this._writeLabLog(run, experiments);
      this._emit('northstar.iteration', { runId: id, record, bestScore: run.bestScore, status: run.status });
    }

    run.elapsedMs = baseElapsedMs + (Date.now() - sessionStartMs);
    if (signal.aborted && run.status === 'running') {
      run.status = 'paused';
      run.pauseReason ||= 'Paused';
    }
    await this._persist(run);
    await this._writeLabLog(run, experiments);
    this._emit('northstar.status', { runId: id, status: run.status, bestScore: run.bestScore });
  }

  async _handlePlateauAndReflection(run, experiments) {
    if (run.plateauCount > 0 && run.plateauCount % run.plateauThreshold === 0) {
      run.strategyStage = Math.min(STRATEGY_STAGES.length - 1, (run.strategyStage || 0) + 1);
      run.activeProviderIndex = (run.activeProviderIndex || 0) + 1;
    }
    if (run.iterations > 0 && run.iterations % run.reflectEvery === 0) {
      const recent = experiments.slice(-run.reflectEvery);
      const kept = recent.filter(r => r.status === 'kept');
      const failKinds = {};
      for (const r of recent.filter(x => x.status !== 'kept')) {
        failKinds[r.status] = (failKinds[r.status] || 0) + 1;
      }
      const failSummary = Object.entries(failKinds).map(([k, v]) => `${v}× ${k}`).join(', ') || 'none';
      const summary = `Window #${Math.max(1, run.iterations - run.reflectEvery + 1)}–#${run.iterations}: ${kept.length}/${recent.length} kept (best=${run.bestScore}). Failures: ${failSummary}. Next stage: ${STRATEGY_STAGES[run.strategyStage || 0]}.`;
      run.reflections = [...(run.reflections || []), { iteration: run.iterations, summary, at: new Date().toISOString() }].slice(-20);
    }
  }
}
