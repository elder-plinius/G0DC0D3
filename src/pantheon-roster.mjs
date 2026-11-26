import { constants as fsConstants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    benchmarkProbe: { id: 'codex-cli:gpt-5.4-codex', model: 'gpt-5.4-codex', label: 'GPT-5.4 Codex · CLI' },
    description: 'OpenAI Codex local coding harness subscription.'
  },
  {
    id: 'claude-code',
    name: 'Claude Code CLI',
    shortName: 'Claude Code',
    command: 'claude',
    providerPrefix: 'claude-cli:',
    benchmarkProbe: { id: 'claude-cli:claude-opus-5-5', model: 'claude-opus-5-5', label: 'Claude Opus 5.5 · Claude Code' },
    description: 'Anthropic Claude Code CLI agent harness.'
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    shortName: 'Gemini CLI',
    command: 'gemini',
    providerPrefix: 'gemini-cli:',
    benchmarkProbe: { id: 'gemini-cli:gemini-4-neon', model: 'gemini-4-neon', label: 'Gemini 4 Neon · CLI' },
    description: 'Google Gemini CLI agent harness.'
  },
  {
    id: 'antigravity',
    name: 'Antigravity (agy)',
    shortName: 'Antigravity',
    command: 'agy',
    providerPrefix: 'antigravity:',
    benchmarkProbe: { id: 'gemini:gemini-4-neon', model: 'gemini-4-neon', label: 'Gemini 4 Neon · Antigravity' },
    description: 'Google Antigravity agentic IDE & CLI harness.'
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
    providerRegex: /grok|xai/i,
    benchmarkProbe: { id: 'xai:grok-4', model: 'grok-4', label: 'Grok 4 · xAI' },
    description: 'xAI Grok frontier reasoning & high-agency API/CLI.'
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

async function checkCommandOnPath(cmd, env = process.env) {
  if (!cmd || !/^[a-z0-9._-]+$/i.test(cmd)) return null;
  const home = os.homedir();
  const pathDirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
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
  const harnessCommand = input.harnessCommand ? String(input.harnessCommand).trim().slice(0, 120) : null;
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
  const topSec = pickBest('security_research', true);
  const connectedHarness = harnesses.find(h => h.status === 'connected' || h.status === 'installed') || harnesses[0];

  return [
    {
      slug: 'explore',
      name: 'Atlas · Code Explorer',
      sigil: '◈',
      engineType: 'api',
      providerId: topSwe?.id || null,
      harnessId: null,
      primarySpecialty: 'long_context',
      secondarySpecialty: 'swe_coding',
      autonomy: 'read_only',
      effort: 'medium',
      description: 'Fast read-only codebase cartographer citing exact file:line findings.',
      instructions: 'Map architecture, trace call paths, and return high-signal file:line briefs.',
      builtin: true
    },
    {
      slug: 'reviewer',
      name: 'Athena · Adversarial Reviewer',
      sigil: '⌘',
      engineType: 'api',
      providerId: topUi?.id || topSwe?.id || null,
      harnessId: null,
      primarySpecialty: 'swe_coding',
      secondarySpecialty: 'frontend_ui',
      autonomy: 'read_only',
      effort: 'high',
      description: 'Audits diffs for subtle bugs, race conditions, CSP violations, and regressions.',
      instructions: 'Inspect diffs critically and report concrete bugs with file:line fixes.',
      builtin: true
    },
    {
      slug: 'uncensored',
      name: 'Hermes · Red-Team Oracle',
      sigil: '⛨',
      engineType: topSec ? 'api' : 'harness',
      providerId: topSec?.id || null,
      harnessId: topSec ? null : (connectedHarness?.id || 'hermes'),
      primarySpecialty: 'security_research',
      secondarySpecialty: 'math_reasoning',
      autonomy: 'read_only',
      effort: 'high',
      description: 'High-agency technical & security research specialist with zero hedging.',
      instructions: 'Provide direct, objective, deeply technical analysis inside authorized local workspaces.',
      builtin: true
    }
  ];
}
