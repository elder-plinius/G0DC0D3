import { spawn } from 'node:child_process';
import { constants as fsConstants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLI_NO_TELEMETRY_ENV, DEFAULT_PRIVACY_SETTINGS, environmentSecrets, redactOutboundText } from './privacy.mjs';
import {
  cliEnvironment,
  claudeSubscriptionEnvironment,
  copilotSubscriptionEnvironment,
  geminiSubscriptionEnvironment
} from './providers.mjs';
import { loadBenchmarkMatrix, matchBenchmarkEntry, ROUTER_DOMAINS } from './ultra-router.mjs';
import { providerDomainStats } from './learning.mjs';

const VALID_DOMAINS = new Set(ROUTER_DOMAINS.map(d => d.id));
const VALID_AUTONOMY = new Set(['read_only', 'workspace_builder', 'external_harness']);
const VALID_EFFORTS = new Set(['fast', 'medium', 'high', 'max']);
const VALID_SIGILS = Object.freeze(['✦', '⚡', '◈', '⛨', '⌘', 'λ', 'Ω', 'Δ']);

export const AGENT_ARCHETYPES = Object.freeze([
  {
    id: 'code_surgeon',
    name: 'Code Surgeon',
    sigil: '⌘',
    primarySpecialty: 'swe_coding',
    secondarySpecialty: 'math_reasoning',
    autonomy: 'workspace_builder',
    effort: 'high',
    instructions: 'Inspect call sites before editing, isolate root causes cleanly, write minimal surgical diffs, and verify with real tests before reporting completion.'
  },
  {
    id: 'visual_alchemist',
    name: 'Visual Alchemist',
    sigil: '✦',
    primarySpecialty: 'frontend_ui',
    secondarySpecialty: 'vision_multimodal',
    autonomy: 'workspace_builder',
    effort: 'high',
    instructions: 'Craft cohesive visual hierarchy, balanced spacing, accessible dark/light contrast, and zero-CDN runnable UI artifacts verified visually.'
  },
  {
    id: 'redteam_oracle',
    name: 'Red-Team Oracle',
    sigil: '⛨',
    primarySpecialty: 'security_research',
    secondarySpecialty: 'swe_coding',
    autonomy: 'read_only',
    effort: 'high',
    instructions: 'Operate strictly within authorized local workspaces. Trace attack surfaces, concrete preconditions, and exploit/mitigation mechanics directly without fluff.'
  },
  {
    id: 'deep_architect',
    name: 'Deep Architect',
    sigil: '◈',
    primarySpecialty: 'long_context',
    secondarySpecialty: 'swe_coding',
    autonomy: 'read_only',
    effort: 'max',
    instructions: 'Map whole-repository architecture, surface subtle cross-file invariants and contradictions, and anchor every recommendation to exact file:line evidence.'
  },
  {
    id: 'harness_envoy',
    name: 'Cross-Harness Envoy',
    sigil: '⚡',
    primarySpecialty: 'swe_coding',
    secondarySpecialty: 'frontend_ui',
    autonomy: 'external_harness',
    effort: 'high',
    instructions: 'Coordinate tasks with an external AI coding harness (Codex, Claude Code, Antigravity, Gemini CLI, Hermes, or Grok), translating specs cleanly and auditing returned diffs.'
  }
]);

export const EXTERNAL_HARNESSES = Object.freeze([
  {
    id: 'codex-cli',
    name: 'OpenAI Codex CLI',
    shortName: 'Codex',
    command: 'codex',
    providerPrefix: 'codex-cli:',
    benchmarkProbe: { id: 'codex-cli:gpt-6.2-astra', model: 'gpt-6.2-astra', label: 'GPT-6.2-Astra · Codex' },
    description: 'OpenAI Codex local coding harness subscription.'
  },
  {
    id: 'claude-code',
    name: 'Claude Code CLI',
    shortName: 'Claude Code',
    command: 'claude',
    providerPrefix: 'claude-code:',
    benchmarkProbe: { id: 'claude-code:claude-opus-5-5', model: 'claude-opus-5-5', label: 'Claude Opus 5.5 · Claude Code' },
    description: 'Anthropic Claude Code CLI agent harness.'
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI & API',
    shortName: 'Gemini',
    command: 'gemini',
    providerPrefix: 'gemini-cli:',
    providerRegex: /^(?:gemini|gemini-cli):/i,
    benchmarkProbe: { id: 'gemini-cli:gemini-4-neon', model: 'gemini-4-neon', label: 'Gemini 4 Neon · Gemini' },
    description: 'Google Gemini CLI & direct Gemini 4 Neon / Pro models.'
  },
  {
    id: 'antigravity',
    name: 'Google Antigravity (agy)',
    shortName: 'Antigravity',
    command: 'agy',
    providerPrefix: 'antigravity-cli:',
    providerRegex: /^antigravity-cli(?::|$)/i,
    benchmarkProbe: { id: 'antigravity-cli:gemini-4-neon-high', model: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High) · Antigravity' },
    description: 'Google Antigravity CLI (agy) — Gemini 4 Neon, Carbon, Argon & Hydrogen.'
  },
  {
    id: 'hermes',
    name: 'Hermes / Nous',
    shortName: 'Hermes',
    command: 'hermes',
    providerRegex: /hermes|nous/i,
    benchmarkProbe: { id: 'nous:hermes-4-405b', model: 'hermes-4-405b', label: 'Hermes 4 405B · Nous' },
    description: 'High-agency Nous Hermes inference or local Hermes agent.'
  },
  {
    id: 'grok',
    name: 'Grok / xAI',
    shortName: 'Grok',
    command: 'grok',
    providerPrefix: 'xai:',
    providerRegex: /grok|xai|x-ai/i,
    benchmarkProbe: { id: 'xai:grok-4.7', model: 'grok-4.7', label: 'Grok 4.7 · xAI' },
    description: 'xAI Grok 4.7 frontier reasoning & high-agency API/CLI.'
  },
  {
    id: 'meta',
    name: 'Meta AI (Muse / Llama)',
    shortName: 'Muse / Meta',
    command: 'llama',
    providerPrefix: 'meta:',
    providerRegex: /^meta:|muse[-_.]?spark|meta-llama|llama[-_.]?4/i,
    benchmarkProbe: { id: 'meta:Muse-Spark', model: 'Muse-Spark', label: 'Muse Spark · Meta AI' },
    description: 'Meta AI Muse Spark & Llama 4 Maverick / Scout multimodal agents.'
  },
  {
    id: 'copilot-cli',
    name: 'GitHub Copilot CLI',
    shortName: 'Copilot',
    command: 'copilot',
    providerPrefix: 'copilot-cli:',
    benchmarkProbe: { id: 'copilot-cli:gpt-5', model: 'gpt-5', label: 'GitHub Copilot · CLI' },
    description: 'GitHub Copilot coding agent CLI.'
  },
  {
    id: 'ollama',
    name: 'Local Ollama / LM Studio',
    shortName: 'Local LLM',
    command: 'ollama',
    providerRegex: /^local:|ollama/i,
    benchmarkProbe: { id: 'local:qwen-3-coder', model: 'qwen-3-coder', label: 'Local Open-Weight', tier: 'local' },
    description: 'Air-gapped local open-weight models on your GPU.'
  }
]);

const ALLOWED_CLI_BINARIES = new Set([
  'claude', 'claude-code-acp', 'codex', 'codex-acp', 'gemini', 'agy', 'copilot', 'opencode', 'aider', 'ollama', 'llm'
]);

async function checkCommandOnPath(cmd, env = process.env) {
  if (!cmd || !/^[a-z0-9._-]+$/i.test(cmd)) return null;
  if (!ALLOWED_CLI_BINARIES.has(cmd.toLowerCase())) return null;
  const home = os.homedir();
  const pathDirs = String(env.PATH || '').split(path.delimiter).filter(dir => dir && path.isAbsolute(dir));
  const extras = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', path.join(home, '.local/bin'), path.join(home, '.npm-global/bin')];
  const seen = new Set();
  for (const dir of [...pathDirs, ...extras]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const full = path.join(dir, cmd);
    try {
      const st = await fs.stat(full);
      if (!st.isFile()) continue;
      await fs.access(full, fsConstants.X_OK);
      return full;
    } catch {}
  }
  return null;
}

export async function detectExternalHarnesses({ providers = new Map(), catalog = null, env = process.env } = {}) {
  const liveProviders = [...providers.values()].filter(p => p && p.available !== false && !p.closed && p.kind !== 'scripted');
  const matrix = loadBenchmarkMatrix();
  const out = [];
  for (const h of EXTERNAL_HARNESSES) {
    const matchedProvider = liveProviders.find(p => {
      if (p.id === h.id) return true;
      if (h.providerPrefix && p.id.startsWith(h.providerPrefix)) return true;
      if (h.providerRegex && h.providerRegex.test(`${p.id} ${p.model || ''} ${p.label || ''}`)) return true;
      return false;
    }) || null;
    let binPath = null;
    try { binPath = await checkCommandOnPath(h.command, env); } catch {}
    const status = matchedProvider ? 'connected' : binPath ? 'installed' : 'external';
    const bench = matchBenchmarkEntry(matchedProvider || h.benchmarkProbe, matrix);
    out.push({
      id: h.id,
      name: h.name,
      shortName: h.shortName,
      command: h.command,
      description: h.description,
      status, // 'connected' | 'installed' | 'external'
      installed: Boolean(binPath),
      binaryPath: binPath ? path.basename(binPath) : null,
      providerId: matchedProvider?.id || null,
      providerLabel: matchedProvider?.label || h.benchmarkProbe.label,
      stats: computeAgentStats({
        candidate: matchedProvider || h.benchmarkProbe,
        primarySpecialty: h.id === 'hermes' || h.id === 'grok' ? 'security_research' : 'swe_coding',
        secondarySpecialty: 'math_reasoning',
        matrix,
        benchOverride: bench
      })
    });
  }
  return out;
}

export function slugifyAgent(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'agent';
}

export function computeAgentStats({
  candidate = null,
  harnessId = null,
  primarySpecialty = 'swe_coding',
  secondarySpecialty = 'math_reasoning',
  matrix = null,
  learning = null,
  benchOverride = null
} = {}) {
  const mat = matrix || loadBenchmarkMatrix();
  const harness = harnessId ? EXTERNAL_HARNESSES.find(h => h.id === harnessId) : null;
  const target = candidate || harness?.benchmarkProbe || { id: 'generic', model: 'generic', label: 'Balanced Model' };
  const bench = benchOverride || matchBenchmarkEntry(target, mat);
  const d = bench.domains || {};
  const clamp = v => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));

  const radar = {
    swe: clamp(d.swe_coding ?? 80),
    ui: clamp(d.frontend_ui ?? 78),
    math: clamp(d.math_reasoning ?? 78),
    sec: clamp(d.security_research ?? 75),
    prose: clamp(d.creative_writing ?? 78),
    agency: clamp(bench.compliance ?? 70)
  };

  const primScore = clamp(d[primarySpecialty] ?? 82);
  const secScore = clamp(d[secondarySpecialty] ?? primScore);
  const domStats = learning && target.id ? providerDomainStats(learning, primarySpecialty, target.id) : null;
  const userElo = domStats?.elo ?? 1500;
  const eloSamples = domStats?.samples ?? 0;
  const eloBoost = eloSamples > 0 ? Math.max(-6, Math.min(6, Math.round(((userElo - 1500) / 35) * (eloSamples / (eloSamples + 3))))) : 0;

  const overall = clamp(
    primScore * 0.42 +
    secScore * 0.22 +
    radar.agency * 0.16 +
    clamp(bench.speed ?? 75) * 0.10 +
    clamp(d.long_context ?? 82) * 0.10 +
    eloBoost
  );

  const tier = overall >= 93 ? 'S+' : overall >= 88 ? 'S' : overall >= 82 ? 'A+' : overall >= 75 ? 'A' : 'B';

  return {
    overall,
    tier,
    family: bench.family || 'Model',
    entryId: bench.entryId || 'heuristic',
    radar,
    speed: clamp(bench.speed ?? 75),
    costIndex: clamp(bench.costIndex ?? 70),
    longContext: clamp(d.long_context ?? 82),
    vision: clamp(d.vision_multimodal ?? (bench.vision ? 90 : 35)),
    hasVision: Boolean(bench.vision),
    contextWindow: Number(bench.contextWindow) || 128000,
    userElo,
    eloSamples,
    domains: {
      swe_coding: radar.swe,
      frontend_ui: radar.ui,
      math_reasoning: radar.math,
      security_research: radar.sec,
      creative_writing: radar.prose,
      long_context: clamp(d.long_context ?? 82),
      vision_multimodal: clamp(d.vision_multimodal ?? 45),
      fast_general: clamp(d.fast_general ?? 80)
    }
  };
}

export function normalizeRosterAgent(input = {}, existing = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('Agent payload must be an object.'), { code: 'INVALID_AGENT', status: 400 });
  }
  const name = String(input.name ?? existing?.name ?? '').trim().slice(0, 64);
  if (!name) throw Object.assign(new Error('Agent name is required.'), { code: 'INVALID_AGENT', status: 400 });
  const slug = slugifyAgent(input.slug || existing?.slug || name);
  const sigil = VALID_SIGILS.includes(input.sigil) ? input.sigil : (existing?.sigil || '✦');
  const engineType = ['api', 'harness', 'custom_cli'].includes(input.engineType) ? input.engineType : (input.harnessId ? 'harness' : 'api');
  const providerId = input.providerId ? String(input.providerId).trim().slice(0, 200) : null;
  const harnessId = input.harnessId && EXTERNAL_HARNESSES.some(h => h.id === input.harnessId) ? input.harnessId : null;
  const rawCmd = input.harnessCommand ? String(input.harnessCommand).trim().toLowerCase().slice(0, 120) : null;
  if (rawCmd && (!/^[a-z0-9._-]+$/i.test(rawCmd) || !ALLOWED_CLI_BINARIES.has(rawCmd))) {
    throw Object.assign(new Error('Harness command must be an approved CLI binary name (e.g. claude, codex, gemini, agy, copilot, opencode, ollama).'), { code: 'INVALID_AGENT', status: 400 });
  }
  const harnessCommand = rawCmd;
  const primarySpecialty = VALID_DOMAINS.has(input.primarySpecialty) ? input.primarySpecialty : (existing?.primarySpecialty || 'swe_coding');
  const secondarySpecialty = VALID_DOMAINS.has(input.secondarySpecialty) ? input.secondarySpecialty : (existing?.secondarySpecialty || 'math_reasoning');
  const autonomy = VALID_AUTONOMY.has(input.autonomy) ? input.autonomy : (existing?.autonomy || 'read_only');
  const effort = VALID_EFFORTS.has(input.effort) ? input.effort : (existing?.effort || 'high');
  const instructions = String(input.instructions ?? existing?.instructions ?? '').trim().slice(0, 4000) || `You are ${name}, a specialist focused on ${primarySpecialty.replace(/_/g, ' ')}.`;
  const description = String(input.description ?? existing?.description ?? '').trim().slice(0, 240)
    || `${primarySpecialty.replace(/_/g, ' ')} & ${secondarySpecialty.replace(/_/g, ' ')} specialist`;
  const now = new Date().toISOString();

  return {
    slug,
    name,
    sigil,
    engineType,
    providerId,
    harnessId,
    harnessCommand,
    primarySpecialty,
    secondarySpecialty,
    autonomy,
    effort,
    description,
    instructions,
    builtin: Boolean(existing?.builtin && input.builtin !== false),
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
}

export function buildStarterRoster(candidates = [], harnesses = []) {
  const matrix = loadBenchmarkMatrix();
  const pickBest = (domain, preferAgency = false) => {
    if (!candidates.length) return null;
    return [...candidates].sort((a, b) => {
      const ba = matchBenchmarkEntry(a, matrix);
      const bb = matchBenchmarkEntry(b, matrix);
      const sa = (ba.domains[domain] || 75) + (preferAgency ? ba.compliance * 0.45 : 0);
      const sb = (bb.domains[domain] || 75) + (preferAgency ? bb.compliance * 0.45 : 0);
      return sb - sa;
    })[0];
  };
  const topSwe = pickBest('swe_coding');
  const topUi = pickBest('frontend_ui');
  const topLong = pickBest('long_context');
  const topMath = pickBest('math_reasoning');
  const topWriting = pickBest('creative_writing');

  return [
    {
      slug: 'explore',
      name: 'Research Analyst',
      sigil: '◈',
      engineType: 'api',
      providerId: topLong?.id || topSwe?.id || null,
      harnessId: null,
      primarySpecialty: 'long_context',
      secondarySpecialty: 'creative_writing',
      autonomy: 'read_only',
      effort: 'medium',
      description: 'Synthesizes large codebases, docs, and multi-source notes into structured briefs with exact citations.',
      instructions: 'Research thoroughly across files and context, synthesize key findings clearly, and anchor every claim to concrete sources or file:line references.',
      builtin: true
    },
    {
      slug: 'builder',
      name: 'Full-Stack Builder',
      sigil: '⌘',
      engineType: 'api',
      providerId: topSwe?.id || null,
      harnessId: null,
      primarySpecialty: 'swe_coding',
      secondarySpecialty: 'frontend_ui',
      autonomy: 'workspace_builder',
      effort: 'high',
      description: 'Designs and implements end-to-end features, APIs, and automated tests with clean, surgical diffs.',
      instructions: 'Inspect existing architecture before editing, implement complete working code without stubs, and verify behavior with real checks.',
      builtin: true
    },
    {
      slug: 'designer',
      name: 'UI & Design Engineer',
      sigil: '✦',
      engineType: 'api',
      providerId: topUi?.id || topSwe?.id || null,
      harnessId: null,
      primarySpecialty: 'frontend_ui',
      secondarySpecialty: 'vision_multimodal',
      autonomy: 'workspace_builder',
      effort: 'high',
      description: 'Crafts responsive layouts, interactive components, visualizations, and accessible dark/light interfaces.',
      instructions: 'Prioritize visual hierarchy, crisp typography, responsive layout ergonomics, accessible contrast, and clean self-contained UI implementations.',
      builtin: true
    },
    {
      slug: 'reviewer',
      name: 'Code & QA Reviewer',
      sigil: '⚡',
      engineType: 'api',
      providerId: topSwe?.id || topMath?.id || null,
      harnessId: null,
      primarySpecialty: 'swe_coding',
      secondarySpecialty: 'math_reasoning',
      autonomy: 'read_only',
      effort: 'high',
      description: 'Audits diffs for subtle logic bugs, edge cases, race conditions, performance bottlenecks, and regressions.',
      instructions: 'Inspect diffs critically and report concrete bugs, regressions, or missing edge-case coverage with exact file:line fixes.',
      builtin: true
    },
    {
      slug: 'analyst',
      name: 'Data & Math Reasoner',
      sigil: 'λ',
      engineType: 'api',
      providerId: topMath?.id || topSwe?.id || null,
      harnessId: null,
      primarySpecialty: 'math_reasoning',
      secondarySpecialty: 'long_context',
      autonomy: 'read_only',
      effort: 'high',
      description: 'Tackles quantitative modeling, algorithmic complexity, statistical analysis, and formal verification.',
      instructions: 'Verify every calculation, invariant, and assumption step by step; surface edge cases and counterexamples explicitly.',
      builtin: true
    },
    {
      slug: 'strategist',
      name: 'Writer & Strategist',
      sigil: 'Δ',
      engineType: 'api',
      providerId: topWriting?.id || topLong?.id || topSwe?.id || null,
      harnessId: null,
      primarySpecialty: 'creative_writing',
      secondarySpecialty: 'long_context',
      autonomy: 'read_only',
      effort: 'medium',
      description: 'Drafts crisp product specs, technical documentation, launch plans, and executive summaries.',
      instructions: 'Write clear, structured, audience-aware prose and actionable plans with zero fluff or filler.',
      builtin: true
    }
  ];
}

// ── Saved 1-Click Formations ──
export const STARTER_FORMATIONS = Object.freeze([
  {
    id: 'pr-gauntlet',
    name: 'PR Review Squad',
    sigil: '⚔',
    agents: ['explore', 'reviewer', 'analyst'],
    goal: 'Audit the current codebase & diffs for bugs, edge cases, and correctness before merge.',
    builtin: true
  },
  {
    id: 'deep-audit',
    name: 'Research & Build Pod',
    sigil: '✦',
    agents: ['explore', 'builder', 'designer'],
    goal: 'Map the workspace, design the solution architecture, and deliver a polished end-to-end implementation.',
    builtin: true
  }
]);

export function normalizeFormation(input = {}, existing = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('Formation payload must be an object.'), { code: 'INVALID_FORMATION', status: 400 });
  }
  const name = String(input.name ?? existing?.name ?? '').trim().slice(0, 48);
  if (!name) throw Object.assign(new Error('Formation name is required.'), { code: 'INVALID_FORMATION', status: 400 });
  const id = slugifyAgent(input.id || existing?.id || name);
  const sigil = VALID_SIGILS.includes(input.sigil) || input.sigil === '⚔' ? input.sigil : (existing?.sigil || '✦');
  const rawAgents = Array.isArray(input.agents) ? input.agents : (existing?.agents || []);
  const agents = [...new Set(rawAgents.map(s => slugifyAgent(s)).filter(Boolean))].slice(0, 4);
  if (!agents.length) throw Object.assign(new Error('Select at least one agent for a formation.'), { code: 'INVALID_FORMATION', status: 400 });
  const goal = String(input.goal ?? existing?.goal ?? '').trim().slice(0, 600);
  const now = new Date().toISOString();
  return {
    id,
    name,
    sigil,
    agents,
    goal,
    builtin: Boolean(existing?.builtin && input.builtin !== false),
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
}

// ── Agent XP / Leveling & Worker Token/Cost Telemetry ──
export function computeXpLevel(record = null) {
  const runs = Math.max(0, Number(record?.runs) || 0);
  const wins = Math.max(0, Number(record?.wins) || 0);
  const mvps = Math.max(0, Number(record?.mvps) || 0);
  const xp = Math.max(0, Number(record?.xp) || 0);
  const avgMs = Math.max(0, Math.round(Number(record?.avgMs) || 0));
  const level = 1 + Math.floor(xp / 100);
  const nextLevelXp = level * 100;
  const progressPct = xp % 100;
  return { level, xp, nextLevelXp, progressPct, runs, wins, mvps, avgMs, lastRunAt: record?.lastRunAt || null };
}

export function estimateWorkerTelemetry({ prompt = '', summary = '', calls = 1, providerId = '', costIndex = 70 } = {}) {
  const textChars = String(prompt || '').length + String(summary || '').length;
  const approxTokens = Math.max(calls > 0 ? 120 : 0, Math.round(textChars / 3.8 + Math.max(0, Number(calls) || 0) * 180));
  const isLocal = /^local:|ollama/i.test(String(providerId || ''));
  // Higher costIndex = cheaper/more efficient model (95 -> ~$0.50/1M, 55 -> ~$12/1M)
  const efficiency = Math.max(10, Math.min(100, Number(costIndex) || 70));
  const blendedPerMillion = isLocal ? 0 : Math.max(0.25, ((108 - efficiency) / 10) * 1.4);
  const estimatedCostUsd = isLocal ? 0 : Number(((approxTokens / 1_000_000) * blendedPerMillion).toFixed(5));
  return { approxTokens, estimatedCostUsd };
}

// ── Bounded Non-Shell External CLI Harness Runner ──
export async function resolveHarnessBinary(cmd, env = process.env) {
  return checkCommandOnPath(cmd, env);
}

export function buildHarnessInvocation(harnessId, harnessCommand, fullPrompt) {
  const known = harnessId ? EXTERNAL_HARNESSES.find(h => h.id === harnessId) : null;
  const cmdName = String(harnessCommand || known?.command || '').trim().toLowerCase();
  if (!cmdName || !/^[a-z0-9._-]+$/i.test(cmdName) || !ALLOWED_CLI_BINARIES.has(cmdName)) {
    return null;
  }
  // Never pass untrusted prompt text as unguarded flags; lock down tool/hook/MCP surfaces on supported CLIs
  if (harnessId === 'claude-code' || cmdName === 'claude') {
    return {
      binName: cmdName,
      args: [
        '--print', '--output-format', 'text',
        '--tools', '', '--permission-mode', 'dontAsk',
        '--setting-sources', '', '--settings', '{"disableAllHooks":true,"enabledPlugins":{}}',
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--no-session-persistence'
      ],
      stdinText: fullPrompt,
      envKind: 'claude'
    };
  }
  if (harnessId === 'codex-cli' || cmdName === 'codex') {
    return {
      binName: cmdName,
      args: [
        'exec', '--sandbox', 'read-only', '--ephemeral', '--ignore-user-config',
        '-c', 'approval_policy="never"', '-c', 'web_search="disabled"',
        '-'
      ],
      stdinText: fullPrompt,
      envKind: 'codex'
    };
  }
  if (harnessId === 'gemini-cli' || cmdName === 'gemini') {
    return { binName: cmdName, args: ['--prompt', 'Read the specialist prompt from stdin and reply directly. Do not invoke any native tools.'], stdinText: fullPrompt, envKind: 'gemini' };
  }
  if (harnessId === 'antigravity' || harnessId === 'antigravity-cli' || cmdName === 'agy') {
    return {
      binName: cmdName,
      args: ['--disable-slash-commands', '--sandbox'],
      stdinText: fullPrompt,
      envKind: 'gemini'
    };
  }
  if (harnessId === 'copilot-cli' || cmdName === 'copilot') {
    return { binName: cmdName, args: ['-p', 'Read the specialist prompt from stdin and reply directly.', '-s'], stdinText: fullPrompt, envKind: 'copilot' };
  }
  if (['opencode', 'qwen', 'goose'].includes(cmdName)) {
    return { binName: cmdName, args: [], stdinText: fullPrompt, envKind: 'generic' };
  }
  return null;
}

export async function runExternalHarnessSubagent({
  harnessId = null,
  harnessCommand = null,
  prompt = '',
  instructions = '',
  workspace = null,
  timeoutMs = 45000,
  maxOutputBytes = 64 * 1024,
  signal = null,
  env = process.env,
  outbound = null,
  onProgress = null,
  _overrideSpawnSpec = null
} = {}) {
  const started = Date.now();
  const privacy = outbound?.privacy || DEFAULT_PRIVACY_SETTINGS;
  const shouldRedact = privacy.redactOutboundSecrets !== false;
  const secretList = shouldRedact ? (outbound?.extraSecrets || environmentSecrets()) : [];
  let secretsRedacted = 0;
  const clean = (txt) => {
    if (!shouldRedact || !txt) return String(txt || '');
    const res = redactOutboundText(String(txt), secretList);
    secretsRedacted += res.count;
    return res.text;
  };

  const fullPrompt = [
    instructions ? `Role instructions: ${clean(String(instructions).slice(0, 1500))}` : '',
    'Operating mode: STRICTLY READ-ONLY advisory specialist. Do not edit files or run destructive commands. Return a concise technical brief.',
    `Task: ${clean(String(prompt || '').slice(0, 4000))}`
  ].filter(Boolean).join('\n\n');

  let binPath = null;
  let args = [];
  let stdinText = '';
  let harnessLabel = '';
  let envKind = 'generic';

  if (_overrideSpawnSpec && typeof _overrideSpawnSpec.binPath === 'string' && Array.isArray(_overrideSpawnSpec.args)) {
    binPath = _overrideSpawnSpec.binPath;
    args = _overrideSpawnSpec.args;
    stdinText = _overrideSpawnSpec.stdinText || '';
    harnessLabel = _overrideSpawnSpec.label || 'CLI Harness';
  } else {
    const inv = buildHarnessInvocation(harnessId, harnessCommand, fullPrompt);
    if (!inv) {
      return { ok: false, code: 'HARNESS_INVALID_CMD', error: 'Invalid external harness command name (alphanumeric basename only; shells disallowed).', durationMs: Date.now() - started };
    }
    binPath = await checkCommandOnPath(inv.binName, env);
    if (!binPath) {
      return { ok: false, code: 'HARNESS_NOT_FOUND', error: `External harness CLI "${inv.binName}" is not installed on PATH.`, durationMs: Date.now() - started };
    }
    args = inv.args;
    stdinText = inv.stdinText;
    envKind = inv.envKind || 'generic';
    const known = harnessId ? EXTERNAL_HARNESSES.find(h => h.id === harnessId) : null;
    harnessLabel = known ? `${known.shortName} · CLI` : `${inv.binName} · CLI`;
  }

  const safeEnv = envKind === 'claude' ? claudeSubscriptionEnvironment(env)
    : envKind === 'gemini' ? geminiSubscriptionEnvironment(env)
    : envKind === 'copilot' ? copilotSubscriptionEnvironment(env)
    : cliEnvironment(env);

  outbound?.onOutbound?.({
    providerId: `harness:${harnessId || path.basename(binPath)}`,
    host: `cli:${path.basename(binPath)}`,
    protocol: 'external_harness',
    zdrClass: 'provider-policy',
    zdrFlags: ['cli:telemetry-disabled'],
    secretsRedacted,
    blocked: false
  });

  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, code: 'HARNESS_CANCELLED', error: 'External harness subagent cancelled.', harnessLabel, durationMs: Date.now() - started });
      return;
    }
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let killTimer = null;

    const child = spawn(binPath, args, {
      cwd: _overrideSpawnSpec ? (workspace || os.tmpdir()) : os.tmpdir(),
      env: { ...safeEnv, ...CLI_NO_TELEMETRY_ENV },
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const terminate = () => {
      const pid = child.pid;
      if (!pid) return;
      const sendSig = (sig) => {
        try {
          if (process.platform !== 'win32') process.kill(-pid, sig);
          else child.kill(sig);
        } catch {}
      };
      sendSig('SIGTERM');
      if (!killTimer) {
        killTimer = setTimeout(() => sendSig('SIGKILL'), 1200);
        killTimer.unref?.();
      }
    };

    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(res);
    };

    const onAbort = () => {
      terminate();
      finish({ ok: false, code: 'HARNESS_CANCELLED', error: 'External harness subagent cancelled.', harnessLabel, durationMs: Date.now() - started });
    };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const boundedTimeout = Math.max(1000, Math.min(120000, Number(timeoutMs) || 45000));
    const timer = setTimeout(() => {
      terminate();
      finish({ ok: false, code: 'HARNESS_TIMEOUT', error: `${harnessLabel} timed out after ${Math.round(boundedTimeout / 1000)}s.`, harnessLabel, durationMs: Date.now() - started });
    }, boundedTimeout);
    timer.unref?.();

    child.stdout.on('data', (chunk) => {
      if (settled || stdoutBytes >= maxOutputBytes) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const slice = buf.subarray(0, maxOutputBytes - stdoutBytes);
      stdoutBytes += slice.length;
      stdout += slice.toString('utf8');
      if (typeof onProgress === 'function') {
        try { onProgress({ streamTail: stdout.slice(-400), harnessLabel }); } catch {}
      }
    });
    child.stderr.on('data', (chunk) => {
      if (settled || stderrBytes >= 16384) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const slice = buf.subarray(0, 16384 - stderrBytes);
      stderrBytes += slice.length;
      stderr += slice.toString('utf8');
    });

    child.on('error', (err) => {
      if (killTimer) { clearTimeout(killTimer); killTimer = null; }
      finish({ ok: false, code: 'HARNESS_SPAWN_ERROR', error: err.message || 'Failed to spawn harness CLI.', harnessLabel, durationMs: Date.now() - started });
    });

    child.on('close', (code) => {
      if (killTimer) { clearTimeout(killTimer); killTimer = null; }
      const durationMs = Date.now() - started;
      const trimmed = stdout.trim();
      if (code === 0 && trimmed) {
        finish({ ok: true, output: trimmed.slice(0, 12000), harnessLabel, binName: path.basename(binPath), durationMs });
      } else {
        finish({ ok: false, code: 'HARNESS_EXIT_NONZERO', error: (stderr.trim() || trimmed || `${harnessLabel} exited with code ${code}`).slice(0, 400), harnessLabel, durationMs });
      }
    });

    child.stdin.on('error', () => {});
    if (stdinText) child.stdin.end(stdinText);
    else child.stdin.end();
  });
}
