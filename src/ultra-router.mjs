import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveCatalogEntry } from './model-catalog.mjs';
import { providerDomainStats, providerObservedStats } from './learning.mjs';
import { providerIdentity } from './routing.mjs';

const BENCHMARK_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'model-benchmarks.json');

export const ROUTER_DOMAINS = Object.freeze([
  { id: 'swe_coding', label: 'SWE & Systems Coding', shortLabel: 'SWE Coding', description: 'Multi-file engineering, APIs, refactoring, debugging, and tests.' },
  { id: 'frontend_ui', label: 'Frontend, Games & UI', shortLabel: 'Frontend & Games', description: 'HTML/CSS/Canvas games, interactive apps, SVG, animations, and UX.' },
  { id: 'math_reasoning', label: 'Math, Shaders & Deep Logic', shortLabel: 'Math & Logic', description: 'Algorithms, proofs, shaders, optimization, and hard architecture.' },
  { id: 'security_research', label: 'Security & Red-Team Research', shortLabel: 'Security Research', description: 'Reverse engineering, vulnerability analysis, fuzzing, and adversarial evals (high compliance weight).' },
  { id: 'creative_writing', label: 'Creative & Technical Prose', shortLabel: 'Writing', description: 'Copywriting, storytelling, documentation, and strong persona voice.' },
  { id: 'long_context', label: 'Long Context & Repo Synthesis', shortLabel: 'Long Context', description: 'Large multi-file codebases, transcripts, and massive documents.' },
  { id: 'vision_multimodal', label: 'Vision & Screenshots', shortLabel: 'Vision', description: 'Image attachments, UI mockups, diagrams, and visual debugging.' },
  { id: 'fast_general', label: 'Fast General Q&A', shortLabel: 'Fast Chat', description: 'Quick questions, lightweight lookups, and snappy iterations.' }
]);

const DOMAIN_IDS = new Set(ROUTER_DOMAINS.map(d => d.id));
const VALID_MODES = new Set(['off', 'auto_route', 'auto_arena', 'manual_arena']);
const VALID_METACOG_MODES = new Set(['off', 'smart', 'auto_forge']);

export const DEFAULT_ROUTER_SETTINGS = Object.freeze({
  mode: 'off', // 'off' | 'auto_route' | 'auto_arena' | 'manual_arena'
  arenaSize: 3, // 2 | 3 | 4 contenders in Auto-Arena
  metacognition: 'smart', // 'off' | 'smart' | 'auto_forge'
  weights: Object.freeze({ quality: 0.72, compliance: 0.20, speed: 0.05, cost: 0.03 }),
  exploration: true,
  domainPins: Object.freeze({}),
  customBenchmarks: Object.freeze({})
});

let _bundledCache = null;
export function bundledBenchmarkMatrix() {
  if (!_bundledCache) {
    const raw = JSON.parse(readFileSync(BENCHMARK_FILE, 'utf8'));
    _bundledCache = raw;
  }
  return _bundledCache;
}

export function normalizeRouterSettings(input = {}, base = DEFAULT_ROUTER_SETTINGS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('Router settings must be an object.'), { code: 'INVALID_ROUTER_SETTINGS', status: 400 });
  }
  const mode = input.mode !== undefined ? String(input.mode).trim() : (base.mode || 'off');
  if (!VALID_MODES.has(mode)) {
    throw Object.assign(new Error(`Router mode must be one of: ${[...VALID_MODES].join(', ')}.`), { code: 'INVALID_ROUTER_SETTINGS', status: 400 });
  }
  const rawW = { ...(DEFAULT_ROUTER_SETTINGS.weights), ...(base.weights || {}), ...(input.weights || {}) };
  const clamp01 = v => Math.max(0, Math.min(1, Number.isFinite(Number(v)) ? Number(v) : 0));
  const wq = clamp01(rawW.quality), wc = clamp01(rawW.compliance), ws = clamp01(rawW.speed), wcost = clamp01(rawW.cost);
  const sum = wq + wc + ws + wcost || 1;
  const weights = {
    quality: Number((wq / sum).toFixed(3)),
    compliance: Number((wc / sum).toFixed(3)),
    speed: Number((ws / sum).toFixed(3)),
    cost: Number((wcost / sum).toFixed(3))
  };

  const exploration = input.exploration !== undefined ? Boolean(input.exploration) : (base.exploration !== false);
  let arenaSize = [2, 3, 4].includes(Number(base.arenaSize)) ? Number(base.arenaSize) : 3;
  if (input.arenaSize !== undefined) {
    const parsedSize = Number(input.arenaSize);
    if (!Number.isInteger(parsedSize) || ![2, 3, 4].includes(parsedSize)) {
      throw Object.assign(new Error('arenaSize must be 2, 3, or 4.'), { code: 'INVALID_ROUTER_SETTINGS', status: 400 });
    }
    arenaSize = parsedSize;
  }
  const rawMeta = input.metacognition !== undefined ? String(input.metacognition).trim().toLowerCase() : (base.metacognition || 'smart');
  if (!VALID_METACOG_MODES.has(rawMeta)) {
    throw Object.assign(new Error(`Metacognition mode must be one of: ${[...VALID_METACOG_MODES].join(', ')}.`), { code: 'INVALID_ROUTER_SETTINGS', status: 400 });
  }
  const metacognition = rawMeta;

  const domainPins = { ...(base.domainPins || {}) };
  if (input.domainPins && typeof input.domainPins === 'object' && !Array.isArray(input.domainPins)) {
    for (const [dom, val] of Object.entries(input.domainPins)) {
      if (!DOMAIN_IDS.has(dom)) continue;
      if (val === null || val === '') delete domainPins[dom];
      else if (typeof val === 'string' && val.trim().length <= 200) domainPins[dom] = val.trim();
    }
  }

  let customBenchmarks = { ...(base.customBenchmarks || {}) };
  if (input.customBenchmarks !== undefined) {
    if (input.customBenchmarks === null) {
      customBenchmarks = {};
    } else if (typeof input.customBenchmarks === 'object' && !Array.isArray(input.customBenchmarks)) {
      const cleaned = {};
      const entries = Object.entries(input.customBenchmarks).slice(0, 128);
      for (const [key, entry] of entries) {
        if (!key || key.length > 160 || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const nextEntry = {};
        if (Number.isFinite(Number(entry.compliance))) nextEntry.compliance = Math.max(0, Math.min(100, Math.round(Number(entry.compliance))));
        if (Number.isFinite(Number(entry.speed))) nextEntry.speed = Math.max(0, Math.min(100, Math.round(Number(entry.speed))));
        if (Number.isFinite(Number(entry.costIndex))) nextEntry.costIndex = Math.max(0, Math.min(100, Math.round(Number(entry.costIndex))));
        if (entry.domains && typeof entry.domains === 'object' && !Array.isArray(entry.domains)) {
          nextEntry.domains = {};
          for (const [dom, score] of Object.entries(entry.domains)) {
            if (DOMAIN_IDS.has(dom) && Number.isFinite(Number(score))) {
              nextEntry.domains[dom] = Math.max(0, Math.min(100, Math.round(Number(score))));
            }
          }
        }
        cleaned[key] = nextEntry;
      }
      customBenchmarks = cleaned;
    } else {
      throw Object.assign(new Error('customBenchmarks must be an object keyed by model ID or family.'), { code: 'INVALID_ROUTER_SETTINGS', status: 400 });
    }
  }

  return { mode, arenaSize, metacognition, weights, exploration, domainPins, customBenchmarks };
}

export function loadBenchmarkMatrix(customBenchmarks = {}) {
  const base = bundledBenchmarkMatrix();
  const models = base.models.map(entry => {
    const override = customBenchmarks?.[entry.id];
    if (!override) return entry;
    return {
      ...entry,
      ...(override.compliance !== undefined ? { compliance: override.compliance } : {}),
      ...(override.speed !== undefined ? { speed: override.speed } : {}),
      ...(override.costIndex !== undefined ? { costIndex: override.costIndex } : {}),
      domains: { ...entry.domains, ...(override.domains || {}) },
      customized: true
    };
  });
  return { ...base, models, customBenchmarks: customBenchmarks || {} };
}

/**
 * Zero-latency local task-domain and refusal-risk classifier.
 */
export function classifyPromptDomain(objective = '', { files = [], attachments = [], history = [] } = {}) {
  const text = String(objective || '').trim();
  const lower = text.toLowerCase();
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  const totalFileBytes = (Array.isArray(files) ? files : []).reduce((s, f) => s + (f?.bytes || f?.content?.length || 0), 0);
  const signals = [];

  const scores = {
    swe_coding: 10,
    frontend_ui: 5,
    math_reasoning: 5,
    security_research: 0,
    creative_writing: 5,
    long_context: 0,
    vision_multimodal: 0,
    fast_general: text.length < 140 ? 22 : 8
  };

  if (hasAttachments) {
    scores.vision_multimodal += 95;
    signals.push('image_attachments');
  }
  if (totalFileBytes > 80000 || text.length > 10000 || (Array.isArray(files) && files.length > 25) || /\b(?:entire repo|whole codebase|summarize all files|across the repo|large transcript)\b/i.test(lower)) {
    scores.long_context += 65;
    signals.push('large_context');
  }

  // Security / red-team / reverse engineering / adversarial research
  const securityHits = (lower.match(/\b(?:red[- ]?team|pentest\w*|penetration test\w*|exploit\w*|payload\w*|shellcode|reverse engineer\w*|decompil\w*|disassembl\w*|malware|ransomware|rootkit|c2|beacon|fuzz(?:ing|er)?|bypass\w*|jailbreak\w*|uncensored|buffer overflow|rop chain|privilege escalation|lateral movement|credential\w*|phish\w*|inject(?:ion)?|sqli|xss|ssrf|zero[- ]?day|cve|scada|implant\w*|keylog\w*|steganograph\w*|offensive security|adversarial|obliterat\w*|abliterat\w*|weaponiz\w*)\b/g) || []).length;
  if (securityHits > 0) {
    scores.security_research += 45 + Math.min(55, securityHits * 18);
    signals.push(`security_terms:${securityHits}`);
  }

  // Frontend / UI / HTML5 Games / Visual apps
  const uiHits = (lower.match(/\b(?:html|css|canvas|webgl|three\.?js|svg|react|svelte|vue|tailwind|website|landing page|dashboard|ui\/ux|ux|frontend|game|breakout|tetris|snake|pong|platformer|shader|animation|responsive|layout|button|modal|theme|pixel art|sprite|browser preview)\b/g) || []).length;
  if (uiHits > 0) {
    scores.frontend_ui += 30 + Math.min(60, uiHits * 16);
    signals.push(`frontend_terms:${uiHits}`);
  }

  // SWE & Systems coding
  const sweHits = (lower.match(/\b(?:refactor|debug|fix (?:the |this )?bug|unit test|integration test|api|endpoint|server|database|sql|sqlite|postgres\w*|redis|docker|kubernetes|git|pr|diff|commit|typescript|javascript|python|rust|golang|swift|node\.?js|cli|sdk|module|function|class|race condition|memory leak|benchmark|compiler|parser|architecture|backend|distributed|idempoten\w*|event[- ]?sourc\w*|microservice\w*|middleware|schema|webhook|concurrency|lock[- ]?free)\b|\bc\+\+(?=\s|$|[,.;:!?)/])/g) || []).length;
  if (sweHits > 0) {
    scores.swe_coding += 28 + Math.min(60, sweHits * 14);
    signals.push(`swe_terms:${sweHits}`);
  }

  // Math, Algorithms & Deep Reasoning
  const mathHits = (lower.match(/\b(?:prove|proof|theorem|lemma|algorithm\w*|dynamic programming|complexity|big[- ]?o|np[- ]?hard|graph theory|matrix|eigen\w*|calculus|integral|differential|bayesian|probability|cryptograph\w*|elliptic curve|lattice|zk[- ]?snark|raymarch\w*|sdf|physics engine|collision math|optimiz\w*|formal verification)\b/g) || []).length;
  if (mathHits > 0) {
    scores.math_reasoning += 32 + Math.min(60, mathHits * 18);
    signals.push(`math_terms:${mathHits}`);
  }

  // Creative & Technical Writing
  const writingHits = (lower.match(/\b(?:write a (?:story|poem|essay|blog|tweet|thread|email|manifesto|script|pitch)|copywriting|narrative|dialogue|fiction|screenplay|headline|tagline|press release|tone|voice|prose|lyrics|creative)\b/g) || []).length;
  if (writingHits > 0) {
    scores.creative_writing += 38 + Math.min(55, writingHits * 18);
    signals.push(`writing_terms:${writingHits}`);
  }

  // Refusal-risk heuristic (0.0 to 1.0): drives how aggressively Ultra-Plinian weights compliance & observed refusal history
  let refusalRisk = 0.05;
  if (securityHits >= 3) refusalRisk = 0.92;
  else if (securityHits === 2) refusalRisk = 0.78;
  else if (securityHits === 1) refusalRisk = 0.58;
  else if (/\b(?:nsfw|uncensored|controversial|dark fiction|unfiltered|no refusal|taboo|edgy)\b/i.test(lower)) {
    refusalRisk = 0.72;
    signals.push('uncensored_signal');
  }

  const ordered = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const primaryDomain = ordered[0][0];
  const secondaryDomain = ordered[1][1] >= 25 ? ordered[1][0] : null;

  return {
    primaryDomain,
    secondaryDomain,
    domainScores: scores,
    refusalRisk: Number(refusalRisk.toFixed(2)),
    needsVision: hasAttachments,
    needsLongContext: scores.long_context >= 50,
    signals
  };
}

export function promptNeedsLiveTools(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (/https?:\/\/\S+|localhost:\d+|127\.0\.0\.1:\d+/i.test(raw)) return true;
  if (/\b(?:go to|open|visit|browse|navigate to|load|check|pull up|take a screenshot of|screenshot|click on|inspect)\s+(?:the\s+)?(?:https?:\/\/\S+|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|ai|dev|app|co|gg|edu|gov|xyz|tv|me)\b|localhost\b|(?:web\s*)?(?:browser|page|site|website|webpage|url|app))/i.test(raw)) return true;
  if (/\b(?:use|open|launch|drive)\s+(?:the\s+|your\s+)?(?:contained\s+)?browser\b|\bsearch\s+the\s+web\b|\bweb\s+search\b|\blook\s+(?:it|this|that)\s+up\s+online\b/i.test(raw)) return true;
  return false;
}

export function matchBenchmarkEntry(candidate, matrix = loadBenchmarkMatrix()) {
  const id = String(candidate?.id || '');
  const model = String(candidate?.model || '');
  const label = String(candidate?.label || '');
  const haystack = `${id} ${model} ${label}`;

  // Exact custom override by providerId or model slug takes highest precedence
  const custom = matrix.customBenchmarks || {};
  const directOverride = custom[id] || custom[model] || custom[id.replace(/^venice-catalog:/, '')];

  let matched = null;
  for (const entry of matrix.models || []) {
    try {
      if (new RegExp(entry.match, 'i').test(haystack)) {
        matched = entry;
        break;
      }
    } catch {}
  }

  const fallbackCatalog = resolveCatalogEntry(candidate);
  const isUncensored = /uncensored|abliterat|heretic|dolphin|hermes/i.test(haystack);
  const baseCompliance = matched?.compliance ?? (isUncensored ? 97 : candidate?.tier === 'local' ? 92 : 70);
  const baseSpeed = matched?.speed ?? (fallbackCatalog.speed === 'fast' ? 92 : fallbackCatalog.speed === 'reasoning' ? 62 : 78);
  const baseCost = matched?.costIndex ?? (candidate?.tier === 'local' ? 100 : 75);
  const baseDomains = matched?.domains || {
    swe_coding: fallbackCatalog.coding,
    frontend_ui: Math.max(60, fallbackCatalog.coding - 2),
    math_reasoning: fallbackCatalog.reasoning,
    security_research: isUncensored ? Math.max(88, fallbackCatalog.coding) : Math.max(65, fallbackCatalog.coding - 5),
    creative_writing: Math.max(65, fallbackCatalog.intelligence - 2),
    long_context: fallbackCatalog.contextWindow >= 500000 ? 96 : fallbackCatalog.contextWindow >= 200000 ? 90 : 82,
    vision_multimodal: fallbackCatalog.capabilities?.vision ? 90 : 35,
    fast_general: Math.round((fallbackCatalog.intelligence + baseSpeed) / 2)
  };

  return {
    entryId: matched?.id || 'heuristic',
    family: matched?.family || fallbackCatalog.family,
    compliance: directOverride?.compliance ?? baseCompliance,
    speed: directOverride?.speed ?? baseSpeed,
    costIndex: directOverride?.costIndex ?? baseCost,
    contextWindow: matched?.contextWindow ?? fallbackCatalog.contextWindow ?? 128000,
    vision: matched?.vision ?? Boolean(fallbackCatalog.capabilities?.vision),
    domains: { ...baseDomains, ...(directOverride?.domains || {}) }
  };
}

export function scoreCandidateForTask({ candidate = {}, classification = {}, matrix, learning, settings } = {}) {
  candidate = candidate && typeof candidate === 'object' ? candidate : {};
  classification = classification && typeof classification === 'object' ? classification : {};
  const cfg = normalizeRouterSettings(settings || DEFAULT_ROUTER_SETTINGS);
  const primary = classification.primaryDomain || 'swe_coding';
  const secondary = classification.secondaryDomain;
  const bench = matchBenchmarkEntry(candidate, matrix);

  const primaryPrior = bench.domains[primary] ?? 80;
  const secondaryPrior = secondary ? (bench.domains[secondary] ?? primaryPrior) : primaryPrior;
  const benchmarkPrior = Number((secondary ? primaryPrior * 0.78 + secondaryPrior * 0.22 : primaryPrior).toFixed(2));

  // Vision / long-context / live-tool hard capability adjustments
  const visionPenalty = classification.needsVision && !bench.vision ? 35 : 0;
  const toolPenalty = classification.needsTools && candidate.supportsFunctionCalling === false ? 40 : 0;
  const longCtxBonus = classification.needsLongContext && bench.contextWindow >= 400000 ? 4 : 0;

  // Per-user domain Elo self-optimization (starts at 1500)
  const domStats = learning ? providerDomainStats(learning, primary, candidate.id) : null;
  const userElo = domStats?.elo ?? 1500;
  const eloSamples = domStats?.samples ?? 0;
  const eloConfidence = eloSamples > 0 ? eloSamples / (eloSamples + 3) : 0;
  const userEloDelta = Number(Math.max(-18, Math.min(18, ((userElo - 1500) / 14) * eloConfidence)).toFixed(2));

  // Observed refusal probability (blending domain-specific + global observed stats)
  const key = candidate.id ? providerIdentity(candidate.id, candidate) : null;
  const globalObs = learning ? providerObservedStats(learning, candidate.id, key) : null;
  const domRefusalRate = domStats && domStats.samples > 0 ? domStats.refusals / domStats.samples : null;
  const globalRefusalRate = globalObs && globalObs.samples > 0 ? globalObs.refusalRate / 100 : 0;
  const observedRefusalProb = domRefusalRate !== null ? (domRefusalRate * 0.75 + globalRefusalRate * 0.25) : globalRefusalRate;

  // Dual-objective refusal penalty: static compliance gap + observed refusals, scaled by prompt refusalRisk
  const complianceGap = Math.max(0, 100 - bench.compliance);
  const risk = classification.refusalRisk ?? 0.05;
  const effectiveComplianceWeight = cfg.weights.compliance + (risk >= 0.5 ? risk * 0.35 : 0);
  const refusalPenalty = Number((
    (complianceGap * 0.48 * risk * (1 + effectiveComplianceWeight)) +
    (observedRefusalProb * 42 * Math.max(0.35, risk))
  ).toFixed(2));

  // Global & domain pins
  const isDomainPinned = cfg.domainPins?.[primary] === candidate.id;
  const globalPref = learning?.modelPreferences?.[candidate.id] || null;
  const pinDelta = (isDomainPinned ? 22 : 0) + (globalPref === 'pin' ? 8 : globalPref === 'demote' ? -12 : 0);

  // Speed & cost preferences
  const speedContribution = Number(((bench.speed - 75) * cfg.weights.speed * 0.4).toFixed(2));
  const costContribution = Number(((bench.costIndex - 70) * cfg.weights.cost * 0.4).toFixed(2));

  // Small UCB-like exploration bonus for untried strong contenders
  const exploreBonus = cfg.exploration && eloSamples === 0 && benchmarkPrior >= 85 ? 1.5 : 0;

  const qualityTerm = benchmarkPrior * (0.65 + cfg.weights.quality * 0.5);
  const totalScore = Number((
    qualityTerm +
    userEloDelta +
    pinDelta +
    speedContribution +
    costContribution +
    longCtxBonus +
    exploreBonus -
    refusalPenalty -
    visionPenalty -
    toolPenalty
  ).toFixed(2));

  return {
    id: candidate.id,
    label: candidate.label || candidate.model || candidate.id,
    model: candidate.model || null,
    family: bench.family,
    domain: primary,
    totalScore,
    benchmarkPrior,
    compliance: bench.compliance,
    userElo: Math.round(userElo),
    userEloDelta,
    samples: eloSamples,
    refusalRate: Math.round(observedRefusalProb * 100),
    refusalPenalty,
    speed: bench.speed,
    costIndex: bench.costIndex,
    pinned: isDomainPinned,
    globalPref
  };
}

export function routeUltraPlinian({ objective = '', files = [], attachments = [], history = [], candidates = [], learning = null, settings = DEFAULT_ROUTER_SETTINGS } = {}) {
  const cfg = normalizeRouterSettings(settings || DEFAULT_ROUTER_SETTINGS);
  const matrix = loadBenchmarkMatrix(cfg.customBenchmarks);
  const classification = classifyPromptDomain(objective, { files, attachments, history });
  classification.needsTools = promptNeedsLiveTools(objective);
  const validCandidates = Array.isArray(candidates)
    ? candidates.filter(c => c && typeof c.id === 'string' && c.id && c.available !== false && !c.closed && c.kind !== 'scripted')
    : [];
  const byId = new Map(validCandidates.map(c => [c.id, c]));
  const ranked = validCandidates
    .map(candidate => scoreCandidateForTask({ candidate, classification, matrix, learning, settings: cfg }))
    .sort((a, b) => b.totalScore - a.totalScore || b.benchmarkPrior - a.benchmarkPrior || a.id.localeCompare(b.id));

  const selected = ranked[0] || null;
  // Build domain-optimal waterfall: #1 winner, #2 runner-up, plus highest-compliance uncensored safety net!
  const waterfallIds = [];
  if (selected) waterfallIds.push(selected.id);
  for (const item of ranked.slice(1, 5)) {
    if (!waterfallIds.includes(item.id)) waterfallIds.push(item.id);
  }
  const topUncensored = [...ranked]
    .filter(item => item.compliance >= 95 && !waterfallIds.includes(item.id))
    .sort((a, b) => b.benchmarkPrior - a.benchmarkPrior)[0];
  if (topUncensored) waterfallIds.push(topUncensored.id);

  // For Auto-Arena: pick up to cfg.arenaSize (2..4) distinct-family contenders across connected HTTP & Venice catalog models + an independent Judge
  const draftCapable = ranked.filter(r => r.id.startsWith('venice-catalog:') || byId.get(r.id)?.kind === 'http');
  const pool = draftCapable;
  let arenaModels = null;
  let judgeId = null;
  if (pool.length >= 2) {
    // Always reserve 1 independent Judge when 3+ models are available so contenders don't self-judge
    const targetCount = pool.length >= 3 ? Math.max(2, Math.min(cfg.arenaSize || 3, pool.length - 1, 4)) : 2;
    const chosen = [];
    const usedFamilies = new Set();
    // Pass 1: maximize family diversity so the Blind Judge compares genuinely distinct models
    for (const c of pool) {
      if (chosen.length >= targetCount) break;
      if (!usedFamilies.has(c.family)) {
        chosen.push(c.id);
        usedFamilies.add(c.family);
      }
    }
    // Pass 2: fill remaining slots if fewer distinct families than targetCount
    for (const c of pool) {
      if (chosen.length >= targetCount) break;
      if (!chosen.includes(c.id)) chosen.push(c.id);
    }
    const judgeCandidate = selectBestJudge(pool, chosen, {
      refusalRisk: classification.refusalRisk,
      domain: classification.primaryDomain
    });
    if (chosen.length >= 2 && judgeCandidate) {
      arenaModels = chosen;
      judgeId = judgeCandidate.id;
    }
  }
  const arenaPair = arenaModels;

  const domainMeta = ROUTER_DOMAINS.find(d => d.id === classification.primaryDomain) || ROUTER_DOMAINS[0];
  return {
    mode: cfg.mode,
    arenaSize: cfg.arenaSize,
    domain: classification.primaryDomain,
    domainLabel: domainMeta.shortLabel,
    secondaryDomain: classification.secondaryDomain,
    refusalRisk: classification.refusalRisk,
    signals: classification.signals,
    selectedId: selected?.id || null,
    selected,
    waterfallIds: waterfallIds.slice(0, 8),
    arenaModels,
    arenaPair,
    judgeId,
    ranked: ranked.slice(0, 12),
    summary: selected
      ? `${domainMeta.shortLabel} → ${selected.label} (bench ${selected.benchmarkPrior} · Elo ${selected.userElo} · ${selected.refusalRate}% refusal)`
      : 'No eligible models available for Ultra-Plinian routing.'
  };
}

const JUDGE_TASTEMAKER_TIERS = Object.freeze([
  // Tier 1: Peak editorial taste + deep code/factual discernment + low over-refusal
  /gemini[-_.]?4(?:[._-]0)?[-_.]?neon|\bneon[-_.]?4\b/i,
  // Tier 2: Frontier editorial/architectural tastemakers
  /claude[-_.]?(?:opus[-_.]?[45]|(?:4|5)(?:[-_.]?\d)?[-_.]?opus)/i,
  /(?:openai[-_.]?)?gpt[-_.]?(?:6(?:[._-]?[12])?[-_.]?(?:astra|sol|luna|terra)|5(?:[._-]?[456])(?!.*(?:mini|nano)))/i,
  // Tier 3: Strong independent frontier models & high-capacity uncensored judges
  /claude[-_.]?(?:sonnet[-_.]?[45]|(?:4|5)(?:[-_.]?\d)?[-_.]?sonnet)/i,
  /gemini[-_.]?4[-_.]?(?:pro|carbon|argon)/i,
  /abliterat(?:ion|ed)[-_.]?(?:abliterated[-_.]?)?(?:model[-_.]?)?large/i,
  /hermes[-_.]?4[-_.]?405b|deepseek[-_.]?v4(?!.*flash)|grok[-_.]?4|qwen[-_.]?3[-_.]?[67][-_.]?plus/i,
]);

const JUDGE_LIBERATED_TIERS = Object.freeze([
  // For high-agency / security / edgy prompts: unpreachy high-intelligence judges that won't refuse or penalize direct answers
  /abliterat(?:ion|ed)[-_.]?(?:abliterated[-_.]?)?(?:model[-_.]?)?large/i,
  /hermes[-_.]?4[-_.]?405b/i,
  /deepseek[-_.]?v4.*(?:uncensored|abliterat)|qwen[-_.]?3[-_.]?[67][-_.]?plus/i,
  /gemini[-_.]?4(?:[._-]0)?[-_.]?neon|\bneon[-_.]?4\b/i,
  /venice[-_.]?uncensored|abliterat|heretic/i,
  /grok[-_.]?4|glm[-_.]?5[-_.]?3.*uncensored/i,
]);

export function selectBestJudge(pool = [], chosenIds = [], { refusalRisk = 0, domain = 'fast_general' } = {}) {
  if (!Array.isArray(pool) || !pool.length) return null;
  const chosenSet = new Set(chosenIds || []);
  const chosenFamilies = new Set(pool.filter(c => chosenSet.has(c.id)).map(c => c.family).filter(Boolean));
  const independent = pool.filter(c => !chosenSet.has(c.id));
  const distinctFamily = independent.filter(c => !c.family || !chosenFamilies.has(c.family));
  const useLiberated = Number(refusalRisk) >= 0.45 || domain === 'security_research';
  const tiers = useLiberated ? JUDGE_LIBERATED_TIERS : JUDGE_TASTEMAKER_TIERS;
  const ident = c => `${c.id || ''} ${c.model || ''} ${c.label || ''}`;
  const qualityRank = (a, b) => {
    const qa = Number(a.benchmarkPrior || 0) * 0.7 + Number(a.totalScore || 0) * 0.3 + (useLiberated ? Number(a.compliance || 0) * 0.45 : 0);
    const qb = Number(b.benchmarkPrior || 0) * 0.7 + Number(b.totalScore || 0) * 0.3 + (useLiberated ? Number(b.compliance || 0) * 0.45 : 0);
    return qb - qa;
  };
  const pickFrom = (list) => {
    if (!list.length) return null;
    for (const pattern of tiers) {
      const hits = list.filter(c => pattern.test(ident(c)));
      if (hits.length) return [...hits].sort(qualityRank)[0];
    }
    if (useLiberated) {
      const highComp = list.filter(c => Number(c.compliance || 0) >= 90);
      if (highComp.length) return [...highComp].sort(qualityRank)[0];
    }
    // Never downgrade to a small flash/mini judge when a stronger frontier model is available
    const nonLite = list.filter(c => !/(?:mini|nano|haiku|flash-lite|small|8b|7b)\b/i.test(ident(c)));
    if (nonLite.length) return [...nonLite].sort(qualityRank)[0];
    return [...list].sort(qualityRank)[0];
  };
  return pickFrom(distinctFamily) || pickFrom(independent) || pickFrom(pool) || pool[0];
}

export function buildDomainLeaderboards({ candidates = [], learning = null, settings = DEFAULT_ROUTER_SETTINGS } = {}) {
  const cfg = normalizeRouterSettings(settings || DEFAULT_ROUTER_SETTINGS);
  const matrix = loadBenchmarkMatrix(cfg.customBenchmarks);
  const boards = {};
  for (const dom of ROUTER_DOMAINS) {
    const syntheticClass = {
      primaryDomain: dom.id,
      secondaryDomain: null,
      refusalRisk: dom.id === 'security_research' ? 0.85 : 0.08,
      needsVision: dom.id === 'vision_multimodal',
      needsLongContext: dom.id === 'long_context'
    };
    boards[dom.id] = (candidates || [])
      .filter(c => c && c.id && c.available !== false && !c.closed && c.kind !== 'scripted')
      .map(candidate => scoreCandidateForTask({ candidate, classification: syntheticClass, matrix, learning, settings: cfg }))
      .sort((a, b) => b.totalScore - a.totalScore || b.benchmarkPrior - a.benchmarkPrior)
      .slice(0, 15);
  }
  return boards;
}
