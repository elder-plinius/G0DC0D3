#!/usr/bin/env node
/**
 * G0DC0D3 Head-to-Head Harness Bakeoff (`npm run bench:bakeoff`).
 *
 * Benchmarks coding-agent harnesses on identical isolated Git workspaces with an
 * untouched external verifier — comparing G0DC0D3 against Codex CLI (`codex`),
 * Antigravity (`agy`), and Claude Code (`claude`), or A/B testing G0DC0D3 modes
 * (e.g. HyperTuner Off vs Passive vs Active).
 *
 * Supports:
 *   - Built-in multi-file & adversarial-security suites (`quick`, `core`, `adversarial-security`, `all`)
 *   - Custom SWE-bench Verified / Terminal-Bench / private Git repo JSON or JSONL task manifests (`--tasks`)
 *   - Iso-model override (`--model`) so you isolate pure harness lift from base model quality
 *   - Reproducible artifacts: `bakeoff-report.json`, `SCOREBOARD.md`, and offline `scoreboard.html`
 */

import { promises as fs, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { fixtures, getFixture } from '../fixtures/index.mjs';
import { evaluateTask } from '../src/evaluator.mjs';
import { Runtime } from '../src/runtime.mjs';
import { environmentProviders } from '../src/providers.mjs';
import { resolveHarnessBinary } from '../src/conclave-roster.mjs';
import { AcpClient, createAcpSandboxHandlers, createAcpPermissionHandler } from '../src/acp-client.mjs';
import { detectRefusal } from '../src/routing.mjs';
import { APP_VERSION } from '../src/version.mjs';

const execFileAsync = promisify(execFile);

export const BAKEOFF_SUITES = Object.freeze({
  quick: Object.freeze(['task-board', 'auth-hardening', 'path-guard']),
  core: Object.freeze([
    'task-board',
    'dependency-scheduler',
    'inventory-ledger',
    'auth-hardening',
    'safe-merge',
    'rate-shield',
  ]),
  'adversarial-security': Object.freeze([
    'path-guard',
    'content-filter',
    'memory-forensics',
    'firmware-analyzer',
    'side-channel',
    'threat-intel',
  ]),
  all: Object.freeze(fixtures.map(f => f.id)),
});

export const SUPPORTED_HARNESSES = Object.freeze(['g0dc0d3', 'codex', 'agy', 'claude']);

export const HARNESS_META = Object.freeze({
  g0dc0d3: Object.freeze({ id: 'g0dc0d3', label: 'G0DC0D3 (Native)', kind: 'native', binary: null }),
  codex: Object.freeze({ id: 'codex', label: 'Codex CLI', kind: 'cli', binary: 'codex' }),
  agy: Object.freeze({ id: 'agy', label: 'Antigravity (agy)', kind: 'acp_or_cli', binary: 'agy' }),
  claude: Object.freeze({ id: 'claude', label: 'Claude Code', kind: 'cli', binary: 'claude' }),
});

function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx]);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeMdCell(str) {
  return String(str ?? '').replaceAll('|', '\\|').replace(/\s+/g, ' ').trim();
}

/** Loads tasks from a built-in suite or a SWE-bench / custom JSON/JSONL manifest. */
export async function loadBakeoffTasks({ suite = 'core', tasksFile = null, limit = null } = {}) {
  let tasks = [];
  if (tasksFile) {
    const raw = await fs.readFile(path.resolve(tasksFile), 'utf8');
    const trimmed = raw.trim();
    let parsed;
    if (trimmed.startsWith('[')) {
      parsed = JSON.parse(trimmed);
    } else {
      parsed = trimmed.split('\n').map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l));
    }
    if (!Array.isArray(parsed) || !parsed.length) {
      throw new Error(`No tasks found in ${tasksFile}`);
    }
    tasks = parsed.map((item, idx) => {
      const id = String(item.id || item.instance_id || `custom-${idx + 1}`).replace(/[^a-zA-Z0-9._-]/g, '-');
      const prompt = String(item.prompt || item.problem_statement || item.objective || '').trim();
      if (!prompt) throw new Error(`Task "${id}" is missing prompt/problem_statement/objective.`);
      return {
        id,
        title: String(item.title || id),
        category: String(item.category || 'custom'),
        kind: item.fixtureId ? 'fixture' : 'repo',
        fixtureId: item.fixtureId || null,
        repo: item.repo || null,
        baseCommit: item.baseCommit || item.base_commit || null,
        files: item.files && typeof item.files === 'object' ? item.files : null,
        prompt,
        constraints: Array.isArray(item.constraints) ? item.constraints : [],
        verifyCommand: item.verifyCommand || item.test_cmd || null,
        timeoutMs: Number.isFinite(Number(item.timeoutMs)) ? Number(item.timeoutMs) : null,
      };
    });
  } else {
    const ids = BAKEOFF_SUITES[suite];
    if (!ids) {
      throw new Error(`Unknown suite "${suite}". Choose one of: ${Object.keys(BAKEOFF_SUITES).join(', ')}`);
    }
    tasks = ids.map(id => {
      const fx = getFixture(id);
      return {
        id: fx.id,
        title: fx.title,
        category: BAKEOFF_SUITES['adversarial-security'].includes(fx.id) ? 'adversarial-security' : 'engineering',
        kind: 'fixture',
        fixtureId: fx.id,
        repo: null,
        baseCommit: null,
        files: fx.files,
        prompt: [
          fx.objective,
          ...(Array.isArray(fx.constraints) && fx.constraints.length
            ? ['', 'Constraints:', ...fx.constraints.map(c => `- ${c}`)]
            : []),
        ].join('\n'),
        constraints: fx.constraints || [],
        verifyCommand: null,
        timeoutMs: null,
      };
    });
  }
  const n = Number(limit);
  if (Number.isInteger(n) && n > 0) tasks = tasks.slice(0, n);
  return tasks;
}

/** Detects which harnesses are available on the current machine. */
export async function detectAvailableHarnesses({ env = process.env } = {}) {
  const out = {};
  for (const id of SUPPORTED_HARNESSES) {
    const meta = HARNESS_META[id];
    if (!meta.binary) {
      out[id] = { ...meta, available: true, binPath: process.execPath };
    } else {
      const binPath = await resolveHarnessBinary(meta.binary, env);
      out[id] = { ...meta, available: Boolean(binPath), binPath: binPath || null };
    }
  }
  return out;
}

/**
 * Builds strict non-shell argv + stdin specs for external CLI harnesses.
 * Prompt text is piped via stdin (never unescaped shell strings) and workspace-scoped.
 */
export function buildHarnessExecSpec(harnessId, { prompt, workspace, model = null } = {}) {
  const cleanPrompt = String(prompt || '').trim();
  const cleanModel = model ? String(model).trim() : null;
  if (harnessId === 'codex') {
    const args = [
      'exec',
      '--full-auto',
      '--sandbox', 'workspace-write',
      '--ephemeral',
      '--cd', workspace,
    ];
    if (cleanModel) args.push('-m', cleanModel);
    args.push('-');
    return { binName: 'codex', args, stdinText: cleanPrompt, outputFormat: 'text' };
  }
  if (harnessId === 'claude') {
    const args = [
      '--print',
      '--output-format', 'json',
      '--permission-mode', 'acceptEdits',
      '--no-session-persistence',
    ];
    if (cleanModel) args.push('--model', cleanModel);
    return { binName: 'claude', args, stdinText: cleanPrompt, outputFormat: 'claude_json' };
  }
  if (harnessId === 'agy') {
    const args = ['--disable-slash-commands'];
    if (cleanModel) args.push('--model', cleanModel);
    return { binName: 'agy', args, stdinText: cleanPrompt, outputFormat: 'text', acpArgs: ['--acp'] };
  }
  return null;
}

/** Materializes a clean, isolated Git workspace for a single (harness × task) cell. */
export async function materializeTaskWorkspace(task, targetDir) {
  const resolvedTarget = path.resolve(targetDir);
  await fs.mkdir(resolvedTarget, { recursive: true });
  if (task.repo) {
    const repoSource = String(task.repo).trim();
    if (!repoSource || repoSource.startsWith('-')) {
      throw new Error(`Invalid repository source for task "${task.id}".`);
    }
    await execFileAsync('git', ['clone', '--quiet', '--', repoSource, resolvedTarget], { timeout: 120_000 });
    if (task.baseCommit) {
      const commit = String(task.baseCommit).trim();
      if (!commit || commit.startsWith('-')) {
        throw new Error(`Invalid baseCommit for task "${task.id}".`);
      }
      await execFileAsync('git', ['checkout', '--quiet', commit, '--'], { cwd: resolvedTarget, timeout: 30_000 });
    }
  } else if (task.files && typeof task.files === 'object') {
    for (const [relPath, content] of Object.entries(task.files)) {
      const full = path.resolve(resolvedTarget, relPath);
      if (!full.startsWith(resolvedTarget + path.sep)) {
        throw new Error(`Unsafe file path "${relPath}" escapes task workspace.`);
      }
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, 'utf8');
    }
    await execFileAsync('git', ['init', '--quiet'], { cwd: resolvedTarget });
    await execFileAsync('git', ['config', 'user.name', 'G0DC0D3 Bakeoff'], { cwd: resolvedTarget });
    await execFileAsync('git', ['config', 'user.email', 'bakeoff@local.invalid'], { cwd: resolvedTarget });
    await execFileAsync('git', ['add', '-A'], { cwd: resolvedTarget });
    await execFileAsync('git', ['commit', '--quiet', '-m', 'baseline'], { cwd: resolvedTarget });
  } else {
    throw new Error(`Task "${task.id}" must provide either files or repo.`);
  }
  return resolvedTarget;
}

/** Measures exact diff size (files touched, lines added/removed) against baseline HEAD. */
export async function measureWorkspaceDiff(workspace) {
  try {
    const { stdout: numstat } = await execFileAsync('git', ['diff', '--numstat', 'HEAD'], { cwd: workspace, timeout: 10_000 });
    const { stdout: untracked } = await execFileAsync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: workspace, timeout: 10_000 });
    let insertions = 0;
    let deletions = 0;
    const files = new Set();
    for (const line of numstat.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 3) {
        const add = Number(parts[0]);
        const del = Number(parts[1]);
        if (Number.isFinite(add)) insertions += add;
        if (Number.isFinite(del)) deletions += del;
        files.add(parts.slice(2).join(' '));
      }
    }
    for (const rel of untracked.split('\n').map(s => s.trim()).filter(Boolean)) {
      files.add(rel);
      try {
        const content = await fs.readFile(path.join(workspace, rel), 'utf8');
        insertions += content.split('\n').length;
      } catch {}
    }
    return { filesTouched: files.size, insertions, deletions, files: [...files] };
  } catch {
    return { filesTouched: 0, insertions: 0, deletions: 0, files: [] };
  }
}

/** Classifies a bakeoff cell into a crisp outcome category. */
export function classifyBakeoffOutcome({ verified, timedOut = false, exitCode = 0, diffStat = null, outputText = '', error = null } = {}) {
  if (verified?.status === 'pass') {
    return { status: 'pass', reason: 'verified_pass' };
  }
  if (timedOut) {
    return { status: 'timeout', reason: 'timeout_exceeded' };
  }
  const refusal = outputText ? detectRefusal({ type: 'message', text: String(outputText) }) : null;
  const noEdits = !diffStat || (diffStat.filesTouched === 0 && diffStat.insertions === 0 && diffStat.deletions === 0);
  if (refusal && noEdits) {
    return { status: 'refusal', reason: refusal.kind || 'refused_without_edits' };
  }
  if (error) {
    return { status: 'error', reason: String(error).slice(0, 160) };
  }
  if (noEdits) {
    return { status: 'no_edits', reason: exitCode !== 0 ? `exit_${exitCode}_no_edits` : 'completed_without_edits' };
  }
  return { status: 'fail', reason: 'verification_failed' };
}

/** Runs untouched external verification against a candidate workspace. */
async function verifyWorkspace(task, workspace, timeoutMs = 30_000) {
  if (task.kind === 'fixture' && task.fixtureId) {
    return evaluateTask({ workspace, fixtureId: task.fixtureId }, { timeoutMs });
  }
  if (task.verifyCommand) {
    return evaluateTask({
      workspace,
      contractVersion: 1,
      checksContractVersion: 1,
      execution: { enabled: true, network: false, timeoutMs },
      checks: [{ name: 'External Verifier', command: task.verifyCommand }],
    }, { timeoutMs });
  }
  return { status: 'unknown', checks: [{ name: 'Verifier', status: 'unknown', detail: 'No verifier configured for task.' }] };
}

/** Spawns a bounded external CLI harness (non-shell) and collects telemetry. */
function runBoundedCli(binPath, args, { cwd, stdinText = '', timeoutMs = 180_000, env = process.env } = {}) {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(binPath, args, {
      cwd,
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const MAX_CAPTURE = 512 * 1024;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000).unref();
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      if (stdout.length < MAX_CAPTURE) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', chunk => {
      if (stderr.length < MAX_CAPTURE) stderr += chunk.toString('utf8');
    });
    child.on('error', err => {
      clearTimeout(timer);
      resolve({ exitCode: -1, timedOut, stdout, stderr, error: err.message, durationMs: Math.round(performance.now() - started) });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, timedOut, stdout, stderr, error: null, durationMs: Math.round(performance.now() - started) });
    });
    try {
      if (stdinText) child.stdin.write(stdinText);
      child.stdin.end();
    } catch {}
  });
}

/** Executes a single task through G0DC0D3's native Runtime. */
async function executeG0DC0D3Cell({ task, workspace, dataDir, providerId = null, model = null, hyperTunerMode = 'passive', timeoutMs = 180_000, customProviders = null }) {
  const started = performance.now();
  const providers = customProviders || environmentProviders();
  let chosenId = providerId && providers.has(providerId) ? providerId : null;
  if (!chosenId && model) {
    for (const [id, p] of providers.entries()) {
      if (p.available !== false && (p.model === model || id.includes(model))) { chosenId = id; break; }
    }
  }
  if (!chosenId) {
    for (const [id, p] of providers.entries()) {
      if (p.available !== false && p.kind !== 'scripted') { chosenId = id; break; }
    }
  }
  if (!chosenId && providers.size) {
    chosenId = [...providers.keys()][0];
  }
  if (!chosenId) {
    return {
      durationMs: 0,
      tokens: { input: 0, output: 0, total: 0 },
      costUsd: null,
      turns: 0,
      toolCalls: 0,
      outputText: '',
      timedOut: false,
      exitCode: -1,
      error: 'No configured G0DC0D3 provider found (set an API key env var or pass --provider).',
    };
  }

  const runtime = new Runtime({ dataDir, providers, startScheduler: false });
  try {
    runtime.updateAutoTune({ mode: hyperTunerMode });
    const created = await runtime.createTask({
      workspace,
      workspaceKind: 'directory',
      fixtureId: task.fixtureId || null,
      objective: task.prompt,
      constraints: task.constraints || [],
      providers: [chosenId],
      execution: { enabled: true, network: false, timeoutMs: Math.min(60_000, timeoutMs) },
      policy: { mode: 'adaptive', maxCalls: 40, maxAttempts: 8, requestTimeoutMs: Math.min(120_000, timeoutMs) },
    });

    let timedOut = false;
    const runPromise = runtime.run(created.id);
    const timer = setTimeout(() => {
      timedOut = true;
      try { runtime.pause(created.id); } catch {}
    }, timeoutMs);
    await runPromise.catch(() => {});
    clearTimeout(timer);

    const events = runtime.getEvents(created.id);
    const toolCalls = events.filter(e => e.type === 'tool.completed').length;
    const finalTask = runtime.getTask(created.id);
    let inputTok = 0;
    let outputTok = 0;
    let lastText = '';
    for (const ev of events) {
      if (ev.type === 'model.response') {
        const u = ev.data?.response?.usage || ev.data?.usage || {};
        inputTok += Number(u.inputTokens || u.prompt_tokens || 0);
        outputTok += Number(u.outputTokens || u.completion_tokens || 0);
        if (typeof ev.data?.response?.text === 'string' && ev.data.response.text.trim()) {
          lastText = ev.data.response.text;
        }
      }
    }

    return {
      durationMs: Math.round(performance.now() - started),
      tokens: { input: inputTok, output: outputTok, total: inputTok + outputTok },
      costUsd: null,
      turns: Number(finalTask?.calls || 0),
      toolCalls,
      outputText: lastText.slice(0, 4000),
      timedOut,
      exitCode: timedOut ? 124 : 0,
      error: null,
      providerUsed: chosenId,
    };
  } finally {
    await runtime.close().catch(() => {});
  }
}

/** Executes a single task through an external harness (Codex, Antigravity ACP/CLI, Claude Code). */
async function executeExternalCell({ harnessId, binPath, task, workspace, model = null, timeoutMs = 180_000 }) {
  const spec = buildHarnessExecSpec(harnessId, { prompt: task.prompt, workspace, model });
  if (!spec) {
    return { durationMs: 0, tokens: { input: 0, output: 0, total: 0 }, costUsd: null, turns: 0, toolCalls: 0, outputText: '', timedOut: false, exitCode: -1, error: `Unsupported harness: ${harnessId}` };
  }

  // Prefer persistent ACP JSON-RPC 2.0 for Antigravity (`agy`) with workspace-scoped fs/* & OS-sandboxed terminal/*
  if (harnessId === 'agy' && spec.acpArgs) {
    const started = performance.now();
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
    let toolCalls = 0;
    let textOut = '';
    const client = new AcpClient({
      binPath,
      args: spec.acpArgs,
      cwd: workspace,
      handlers: {
        ...createAcpSandboxHandlers({ workspace, execution: { enabled: true, network: false, timeoutMs: Math.min(60_000, timeoutMs) } }),
        requestPermission: createAcpPermissionHandler({ autoAllowAll: true }),
      },
    });
    try {
      await client.connect({ signal: ac.signal });
      const sess = await client.newSession({ cwd: workspace, signal: ac.signal });
      if (model) {
        try { await client.setModel(sess.sessionId, model, { signal: ac.signal }); } catch {}
      }
      const res = await client.prompt(sess.sessionId, task.prompt, {
        signal: ac.signal,
        onUpdate: (u) => {
          if (u?.type === 'text' && u.text) textOut += u.text;
          if (u?.type === 'tool_call') toolCalls += 1;
        },
      });
      clearTimeout(timer);
      return {
        durationMs: Math.round(performance.now() - started),
        tokens: { input: 0, output: 0, total: 0 },
        costUsd: null,
        turns: 1,
        toolCalls,
        outputText: (res?.text || textOut).slice(0, 4000),
        timedOut,
        exitCode: timedOut ? 124 : 0,
        error: null,
      };
    } catch {
      clearTimeout(timer);
      // Fall back to direct CLI invocation if installed `agy` doesn't expose `--acp`
    } finally {
      await client.close().catch(() => {});
    }
  }

  const res = await runBoundedCli(binPath, spec.args, { cwd: workspace, stdinText: spec.stdinText, timeoutMs });
  let tokens = { input: 0, output: 0, total: 0 };
  let costUsd = null;
  let turns = 1;
  let outputText = res.stdout || res.stderr || '';

  if (spec.outputFormat === 'claude_json' && res.stdout.trim()) {
    try {
      const parsed = JSON.parse(res.stdout.trim());
      if (typeof parsed.result === 'string') outputText = parsed.result;
      if (Number.isFinite(parsed.total_cost_usd)) costUsd = Number(parsed.total_cost_usd);
      if (Number.isFinite(parsed.num_turns)) turns = Number(parsed.num_turns);
      const u = parsed.usage || {};
      const inp = Number(u.input_tokens || 0) + Number(u.cache_read_input_tokens || 0) + Number(u.cache_creation_input_tokens || 0);
      const out = Number(u.output_tokens || 0);
      tokens = { input: inp, output: out, total: inp + out };
    } catch {}
  }

  return {
    durationMs: res.durationMs,
    tokens,
    costUsd,
    turns,
    toolCalls: 0,
    outputText: String(outputText).slice(0, 4000),
    timedOut: res.timedOut,
    exitCode: res.exitCode,
    error: res.error,
  };
}

/** Aggregates per-harness summary statistics from raw bakeoff cell results. */
export function summarizeBakeoffResults(harnesses, tasks, cells) {
  const byHarness = [];
  for (const h of harnesses) {
    const mine = cells.filter(c => c.harnessId === h);
    const passed = mine.filter(c => c.outcome.status === 'pass').length;
    const refused = mine.filter(c => c.outcome.status === 'refusal').length;
    const timedOut = mine.filter(c => c.outcome.status === 'timeout').length;
    const durations = mine.map(c => c.durationMs);
    const passDurations = mine.filter(c => c.outcome.status === 'pass').map(c => c.durationMs);
    const totalTokens = mine.reduce((s, c) => s + Number(c.tokens?.total || 0), 0);
    const costVals = mine.map(c => c.costUsd).filter(v => Number.isFinite(v));
    const totalCostUsd = costVals.length ? Number(costVals.reduce((a, b) => a + b, 0).toFixed(4)) : null;
    const avgDiffLines = mine.length
      ? Math.round(mine.reduce((s, c) => s + (c.diff?.insertions || 0) + (c.diff?.deletions || 0), 0) / mine.length)
      : 0;
    byHarness.push({
      harnessId: h,
      label: HARNESS_META[h]?.label || h,
      total: mine.length,
      passed,
      passRatePct: mine.length ? Math.round((passed / mine.length) * 1000) / 10 : 0,
      refused,
      timedOut,
      p50DurationMs: percentile(passDurations.length ? passDurations : durations, 50),
      p95DurationMs: percentile(durations, 95),
      totalTokens,
      totalCostUsd,
      costPerResolvedUsd: totalCostUsd !== null && passed > 0 ? Number((totalCostUsd / passed).toFixed(4)) : null,
      avgDiffLines,
    });
  }
  byHarness.sort((a, b) => b.passRatePct - a.passRatePct || a.p50DurationMs - b.p50DurationMs);
  return { totalTasks: tasks.length, harnesses: byHarness };
}

/** Renders a clean GitHub-flavored Markdown comparison scoreboard. */
export function renderScoreboardMarkdown(report) {
  const lines = [
    `# G0DC0D3 Harness Bakeoff Scoreboard`,
    '',
    `- **G0DC0D3 Version:** \`v${report.appVersion}\` · **Suite:** \`${report.suite}\` (${report.summary.totalTasks} tasks) · **Mode:** \`${report.dryRun ? 'dry-run' : 'live'}\``,
    `- **Model override:** \`${report.model || 'harness-default'}\` · **HyperTuner:** \`${report.hyperTunerMode}\` · **Run at:** \`${report.startedAt}\``,
    '',
    '## Overall Comparison',
    '',
    '| Harness | Pass@1 | Resolved | Refusals | Timeouts | p50 Latency | p95 Latency | Tokens | Cost / Resolved | Avg Diff Lines |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const h of report.summary.harnesses) {
    const p50 = `${(h.p50DurationMs / 1000).toFixed(1)}s`;
    const p95 = `${(h.p95DurationMs / 1000).toFixed(1)}s`;
    const cost = h.costPerResolvedUsd !== null ? `$${h.costPerResolvedUsd.toFixed(4)}` : '—';
    const tok = h.totalTokens ? h.totalTokens.toLocaleString('en-US') : '—';
    lines.push(`| **${safeMdCell(h.label)}** | **${h.passRatePct}%** | ${h.passed}/${h.total} | ${h.refused} | ${h.timedOut} | ${p50} | ${p95} | ${tok} | ${cost} | ${h.avgDiffLines} |`);
  }

  lines.push('', '## Per-Task Matrix', '');
  const hCols = report.summary.harnesses.map(h => h.harnessId);
  lines.push(`| Task | Category | ${hCols.map(id => safeMdCell(HARNESS_META[id]?.label || id)).join(' | ')} |`);
  lines.push(`|---|---|${hCols.map(() => '---').join('|')}|`);

  const badge = (cell) => {
    if (!cell) return '—';
    const s = cell.outcome?.status;
    const sec = `${(cell.durationMs / 1000).toFixed(1)}s`;
    if (s === 'pass') return `PASS (${sec})`;
    if (s === 'refusal') return `REFUSED (${sec})`;
    if (s === 'timeout') return `TIMEOUT`;
    if (s === 'dry_run') return `DRY-RUN`;
    return `FAIL:${s || 'err'} (${sec})`;
  };
  for (const task of report.tasks) {
    const row = hCols.map(hid => badge(report.cells.find(c => c.harnessId === hid && c.taskId === task.id)));
    lines.push(`| \`${safeMdCell(task.id)}\` | ${safeMdCell(task.category)} | ${row.join(' | ')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Renders a self-contained offline dark-mode HTML/SVG visual scoreboard. */
export function renderScoreboardHtml(report) {
  const harnesses = report.summary.harnesses || [];
  const rowsHtml = harnesses.map(h => {
    const pct = Math.max(2, Math.min(100, Number(h.passRatePct) || 0));
    return `
    <div class="bar-card">
      <div class="bar-head">
        <strong>${escapeHtml(h.label)}</strong>
        <span class="mono">${escapeHtml(h.passed)}/${escapeHtml(h.total)} · <b>${escapeHtml(h.passRatePct)}%</b></span>
      </div>
      <div class="track" role="img" aria-label="${escapeHtml(h.label)} ${escapeHtml(h.passRatePct)}% pass rate">
        <svg viewBox="0 0 100 10" preserveAspectRatio="none" class="bar-svg">
          <defs><linearGradient id="g-${escapeHtml(h.harnessId)}" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#8b5cf6"/><stop offset="100%" stop-color="#38bdf8"/></linearGradient></defs>
          <rect x="0" y="0" width="${pct}" height="10" rx="5" fill="url(#g-${escapeHtml(h.harnessId)})"/>
        </svg>
      </div>
      <div class="meta">
        <span>p50: ${(h.p50DurationMs / 1000).toFixed(1)}s</span>
        <span>p95: ${(h.p95DurationMs / 1000).toFixed(1)}s</span>
        <span>Refusals: ${h.refused}</span>
        <span>Timeouts: ${h.timedOut}</span>
        <span>Avg diff: ${h.avgDiffLines}L</span>
      </div>
    </div>`;
  }).join('');

  const hCols = harnesses.map(h => h.harnessId);
  const matrixRows = (report.tasks || []).map(t => {
    const tds = hCols.map(hid => {
      const c = report.cells.find(x => x.harnessId === hid && x.taskId === t.id);
      const st = c?.outcome?.status || 'none';
      const label = st === 'pass' ? `✓ ${(c.durationMs / 1000).toFixed(1)}s`
        : st === 'refusal' ? '⊘ Refusal'
        : st === 'timeout' ? '⏱ Timeout'
        : st === 'dry_run' ? '• Ready'
        : `✕ ${st}`;
      return `<td class="cell cell-${escapeHtml(st)}">${escapeHtml(label)}</td>`;
    }).join('');
    return `<tr><td class="mono">${escapeHtml(t.id)}</td><td class="muted">${escapeHtml(t.category)}</td>${tds}</tr>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>G0DC0D3 Harness Bakeoff — ${escapeHtml(report.suite)}</title>
<style>
  :root { --bg:#0c0e14; --panel:#141822; --line:#23293a; --text:#e8edf5; --muted:#8c96ac; --violet:#a78bfa; --ok:#4ade80; --err:#f87171; --warn:#fbbf24; }
  * { box-sizing:border-box; }
  body { margin:0; padding:24px; background:var(--bg); color:var(--text); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; max-width:1120px; margin-inline:auto; }
  h1 { margin:0 0 6px; font-size:22px; }
  .sub { color:var(--muted); margin:0 0 20px; font-size:13px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:12px; margin-bottom:22px; }
  .bar-card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px; }
  .bar-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }
  .track { height:10px; background:#1c2233; border-radius:999px; overflow:hidden; margin-bottom:10px; }
  .bar-svg { display:block; width:100%; height:100%; }
  .meta { display:flex; flex-wrap:wrap; gap:10px; font-size:12px; color:var(--muted); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  table { width:100%; border-collapse:collapse; background:var(--panel); border:1px solid var(--line); border-radius:12px; overflow:hidden; font-size:13px; }
  th, td { padding:9px 12px; border-bottom:1px solid var(--line); text-align:left; }
  th { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); background:#11151f; }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
  .muted { color:var(--muted); }
  .cell { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; font-weight:600; }
  .cell-pass { color:var(--ok); }
  .cell-refusal { color:var(--warn); }
  .cell-timeout, .cell-fail, .cell-error, .cell-no_edits { color:var(--err); }
  .cell-dry_run { color:var(--violet); }
</style>
</head>
<body>
  <h1>G0DC0D3 Head-to-Head Harness Bakeoff</h1>
  <p class="sub">v${escapeHtml(report.appVersion)} · Suite: ${escapeHtml(report.suite)} (${report.summary.totalTasks} tasks) · Model: ${escapeHtml(report.model || 'harness-default')} · HyperTuner: ${escapeHtml(report.hyperTunerMode)} · ${escapeHtml(report.startedAt)}</p>
  <div class="grid">${rowsHtml}</div>
  <table>
    <thead><tr><th>Task</th><th>Category</th>${hCols.map(id => `<th>${escapeHtml(HARNESS_META[id]?.label || id)}</th>`).join('')}</tr></thead>
    <tbody>${matrixRows}</tbody>
  </table>
</body>
</html>`;
}

/** Runs the full head-to-head harness bakeoff and writes JSON, Markdown, and HTML scoreboards. */
export async function runHarnessBakeoff({
  suite = 'core',
  tasksFile = null,
  harnesses = null,
  providerId = null,
  model = null,
  hyperTunerMode = 'passive',
  timeoutMs = 180_000,
  limit = null,
  dryRun = false,
  outputDir = null,
  customExecutors = null,
  customProviders = null,
  onProgress = null,
} = {}) {
  const startedAt = new Date().toISOString();
  const tasks = await loadBakeoffTasks({ suite, tasksFile, limit });
  const detected = await detectAvailableHarnesses();

  let selectedHarnesses;
  if (Array.isArray(harnesses) && harnesses.length) {
    selectedHarnesses = harnesses.filter(h => SUPPORTED_HARNESSES.includes(h) || Boolean(customExecutors?.[h]));
  } else {
    selectedHarnesses = SUPPORTED_HARNESSES.filter(h => detected[h]?.available);
  }
  if (!selectedHarnesses.length) {
    throw new Error('No valid harnesses selected or installed.');
  }

  const outRoot = path.resolve(outputDir || path.join('.g0dc0d3', 'bakeoff', startedAt.replaceAll(':', '-')));
  await fs.mkdir(outRoot, { recursive: true });
  const scratchRoot = await fs.mkdtemp(path.join(tmpdir(), 'g0d-bakeoff-'));
  const cells = [];

  try {
    let idx = 0;
    const totalCells = selectedHarnesses.length * tasks.length;
    for (const task of tasks) {
      for (const harnessId of selectedHarnesses) {
        idx += 1;
        onProgress?.({ index: idx, total: totalCells, harnessId, taskId: task.id, phase: 'start' });
        const cellDir = path.join(scratchRoot, `${harnessId}-${task.id}`);
        const wsDir = path.join(cellDir, 'ws');
        const dataDir = path.join(cellDir, 'data');
        await fs.mkdir(dataDir, { recursive: true });

        await materializeTaskWorkspace(task, wsDir);

        let execRes;
        let verified;
        let diff;
        let outcome;

        if (dryRun) {
          diff = await measureWorkspaceDiff(wsDir);
          execRes = { durationMs: 0, tokens: { input: 0, output: 0, total: 0 }, costUsd: null, turns: 0, toolCalls: 0, outputText: '', timedOut: false, exitCode: 0, error: null };
          verified = { status: 'dry_run', checks: [] };
          outcome = { status: 'dry_run', reason: 'dry_run_validated' };
        } else {
          if (typeof customExecutors?.[harnessId] === 'function') {
            execRes = await customExecutors[harnessId]({ task, workspace: wsDir, dataDir, model, timeoutMs });
          } else if (harnessId === 'g0dc0d3') {
            execRes = await executeG0DC0D3Cell({ task, workspace: wsDir, dataDir, providerId, model, hyperTunerMode, timeoutMs, customProviders });
          } else {
            const binPath = detected[harnessId]?.binPath;
            if (!binPath) {
              execRes = { durationMs: 0, tokens: { input: 0, output: 0, total: 0 }, costUsd: null, turns: 0, toolCalls: 0, outputText: '', timedOut: false, exitCode: -1, error: `${harnessId} CLI not installed on PATH` };
            } else {
              execRes = await executeExternalCell({ harnessId, binPath, task, workspace: wsDir, model, timeoutMs });
            }
          }
          diff = await measureWorkspaceDiff(wsDir);
          verified = await verifyWorkspace(task, wsDir, Math.min(30_000, timeoutMs));
          outcome = classifyBakeoffOutcome({
            verified,
            timedOut: execRes.timedOut,
            exitCode: execRes.exitCode,
            diffStat: diff,
            outputText: execRes.outputText,
            error: execRes.error,
          });
        }

        const cell = {
          harnessId,
          taskId: task.id,
          durationMs: execRes.durationMs,
          tokens: execRes.tokens,
          costUsd: execRes.costUsd,
          turns: execRes.turns,
          toolCalls: execRes.toolCalls,
          diff,
          verificationStatus: verified?.status || 'unknown',
          outcome,
        };
        cells.push(cell);
        onProgress?.({ index: idx, total: totalCells, harnessId, taskId: task.id, phase: 'done', cell });
      }
    }
  } finally {
    await fs.rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
  }

  const summary = summarizeBakeoffResults(selectedHarnesses, tasks, cells);
  const sanitizedDetected = Object.fromEntries(
    Object.entries(detected).map(([id, info]) => [id, {
      id: info.id,
      label: info.label,
      kind: info.kind,
      available: Boolean(info.available),
    }]),
  );
  const report = {
    appVersion: APP_VERSION,
    startedAt,
    finishedAt: new Date().toISOString(),
    suite: tasksFile ? path.basename(tasksFile) : suite,
    model: model || null,
    hyperTunerMode,
    dryRun: Boolean(dryRun),
    detectedHarnesses: sanitizedDetected,
    tasks: tasks.map(({ id, title, category, kind }) => ({ id, title, category, kind })),
    cells,
    summary,
  };

  const md = renderScoreboardMarkdown(report);
  const html = renderScoreboardHtml(report);
  await fs.writeFile(path.join(outRoot, 'bakeoff-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  await fs.writeFile(path.join(outRoot, 'SCOREBOARD.md'), md, 'utf8');
  await fs.writeFile(path.join(outRoot, 'scoreboard.html'), html, 'utf8');

  return { report, markdown: md, html, outputDir: outRoot };
}

function parseCliArgs(argv) {
  const opts = {
    suite: 'core',
    tasksFile: null,
    harnesses: null,
    providerId: null,
    model: null,
    hyperTunerMode: 'passive',
    timeoutMs: 180_000,
    limit: null,
    dryRun: false,
    outputDir: null,
    help: false,
  };
  const nextVal = (flag, idx) => {
    if (idx + 1 >= argv.length) throw new Error(`Flag ${flag} requires a value.`);
    return argv[idx + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--suite') { opts.suite = nextVal(a, i); i += 1; }
    else if (a === '--tasks') { opts.tasksFile = nextVal(a, i); i += 1; }
    else if (a === '--harnesses') { opts.harnesses = String(nextVal(a, i)).split(',').map(s => s.trim()).filter(Boolean); i += 1; }
    else if (a === '--provider') { opts.providerId = nextVal(a, i); i += 1; }
    else if (a === '--model') { opts.model = nextVal(a, i); i += 1; }
    else if (a === '--g0d-hypertuner') {
      const m = nextVal(a, i);
      if (!['off', 'passive', 'active'].includes(m)) throw new Error(`Invalid --g0d-hypertuner mode "${m}" (use off | passive | active).`);
      opts.hyperTunerMode = m;
      i += 1;
    }
    else if (a === '--timeout') { opts.timeoutMs = Math.max(5, Number(nextVal(a, i)) || 180) * 1000; i += 1; }
    else if (a === '--limit') { opts.limit = Number(nextVal(a, i)) || null; i += 1; }
    else if (a === '--output') { opts.outputDir = nextVal(a, i); i += 1; }
    else throw new Error(`Unknown flag: ${a}`);
  }
  return opts;
}

const isDirectBakeoff = process.argv[1] && (() => { const s = fileURLToPath(import.meta.url); try { return realpathSync(process.argv[1]) === realpathSync(s); } catch { return path.resolve(process.argv[1]) === path.resolve(s); } })();
if (isDirectBakeoff) {
  const opts = parseCliArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`G0DC0D3 Head-to-Head Harness Bakeoff (v${APP_VERSION})

Usage:
  npm run bench:bakeoff -- [options]

Options:
  --suite <name>             Built-in suite: quick | core | adversarial-security | all (default: core)
  --tasks <file.json|jsonl>  Load SWE-bench / Terminal-Bench / custom Git repo tasks
  --harnesses <list>         Comma-separated: g0dc0d3,codex,agy,claude (default: auto-detected)
  --provider <id>            Provider ID for g0dc0d3 harness
  --model <model>            Iso-model override passed to supported harnesses
  --g0d-hypertuner <mode>    off | passive | active (default: passive)
  --timeout <sec>            Per-task timeout in seconds (default: 180)
  --limit <n>                Limit to first N tasks
  --dry-run                  Validate task workspaces, harnesses & scoreboards with 0 API calls
  --output <dir>             Directory for bakeoff-report.json, SCOREBOARD.md & scoreboard.html`);
    process.exit(0);
  }
  const { markdown, outputDir } = await runHarnessBakeoff({
    ...opts,
    onProgress: (p) => {
      if (p.phase === 'done') {
        const st = p.cell.outcome.status.toUpperCase().padEnd(8);
        console.log(`[${p.index}/${p.total}] ${p.harnessId.padEnd(8)} × ${p.taskId.padEnd(22)} -> ${st} (${(p.cell.durationMs / 1000).toFixed(1)}s, ${p.cell.diff.filesTouched} files)`);
      }
    },
  });
  console.log('\n' + markdown);
  console.log(`Artifacts saved to: ${outputDir}`);
}
