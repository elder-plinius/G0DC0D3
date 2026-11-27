/**
 * G0DC0D3 AutoTune — Passive Hierarchical Empirical-Bayes Hyperparameter Layer.
 *
 * Optimizes sampling hyperparameters per (model × task domain × reasoning effort)
 * using 5 curated macro-arms clamped strictly to each provider's live supported
 * parameter limits (conversation-controls.mjs), 3-level Empirical Bayes shrinkage
 * (Domain Prior -> Model Family -> Exact Model), exponential decay for model drift,
 * confidence-weighted multi-signal rewards, and safe conservative Thompson Sampling.
 */

import { parameterLimits } from './conversation-controls.mjs';
import { inferModelFamily } from './learning.mjs';
import { classifyPromptDomain } from './ultra-router.mjs';

export const AUTOTUNE_MODES = Object.freeze(['off', 'passive', 'active']);

export const AUTOTUNE_PROFILES = Object.freeze([
  Object.freeze({
    id: 'surgical',
    label: 'Surgical',
    shortDesc: 'Ultra-low variance for exact patches, strict tool JSON, and math proofs.',
    params: Object.freeze({ temperature: 0.1, top_p: 0.90 }),
  }),
  Object.freeze({
    id: 'focused',
    label: 'Focused',
    shortDesc: 'Low variance with gentle diversity for SWE, debugging, and refactoring.',
    params: Object.freeze({ temperature: 0.3, top_p: 0.92, min_p: 0.05 }),
  }),
  Object.freeze({
    id: 'balanced',
    label: 'Balanced',
    shortDesc: 'Steady reasoning and synthesis for research, architecture, and security.',
    params: Object.freeze({ temperature: 0.6, top_p: 0.95, min_p: 0.05 }),
  }),
  Object.freeze({
    id: 'exploratory',
    label: 'Exploratory',
    shortDesc: 'Higher diversity for ideation, creative writing, and unstuck reframing.',
    params: Object.freeze({ temperature: 0.85, top_p: 0.96, min_p: 0.06, presence_penalty: 0.2 }),
  }),
  Object.freeze({
    id: 'high_entropy',
    label: 'High Entropy',
    shortDesc: 'Wide exploration for novel hypotheses and creative/open-weight models.',
    params: Object.freeze({ temperature: 1.05, min_p: 0.08, frequency_penalty: 0.15 }),
  }),
]);

export const PROFILE_BY_ID = new Map(AUTOTUNE_PROFILES.map(p => [p.id, p]));
const PROFILE_ORDER = AUTOTUNE_PROFILES.map(p => p.id);

// Level-0 informed Beta(alpha, beta) priors per domain so Turn 1 starts strong, never random.
const DOMAIN_PRIORS = Object.freeze({
  coding: { surgical: [3.4, 1.2], focused: [3.8, 1.1], balanced: [2.4, 1.8], exploratory: [1.3, 2.6], high_entropy: [0.8, 3.2] },
  swe: { surgical: [3.4, 1.2], focused: [3.8, 1.1], balanced: [2.4, 1.8], exploratory: [1.3, 2.6], high_entropy: [0.8, 3.2] },
  math: { surgical: [4.0, 1.0], focused: [3.4, 1.3], balanced: [2.0, 2.0], exploratory: [1.0, 3.0], high_entropy: [0.6, 3.4] },
  ui: { surgical: [2.0, 2.0], focused: [3.4, 1.3], balanced: [3.5, 1.3], exploratory: [2.4, 1.8], high_entropy: [1.2, 2.8] },
  security: { surgical: [2.6, 1.5], focused: [3.4, 1.2], balanced: [3.5, 1.2], exploratory: [2.6, 1.6], high_entropy: [1.5, 2.5] },
  research: { surgical: [2.2, 1.8], focused: [3.2, 1.3], balanced: [3.7, 1.1], exploratory: [2.5, 1.7], high_entropy: [1.3, 2.7] },
  creative: { surgical: [1.0, 3.0], focused: [1.8, 2.2], balanced: [3.2, 1.4], exploratory: [3.9, 1.1], high_entropy: [3.0, 1.5] },
  writing: { surgical: [1.2, 2.8], focused: [2.2, 2.0], balanced: [3.5, 1.2], exploratory: [3.8, 1.1], high_entropy: [2.6, 1.7] },
  general: { surgical: [2.2, 1.8], focused: [3.2, 1.3], balanced: [3.6, 1.2], exploratory: [2.6, 1.7], high_entropy: [1.4, 2.6] },
});

const REWARD_SIGNAL_WEIGHTS = Object.freeze({
  verification_pass: Object.freeze({ reward: 1.0, weight: 1.0 }),
  verification_fail: Object.freeze({ reward: 0.0, weight: 1.0 }),
  arena_win: Object.freeze({ reward: 1.0, weight: 1.0 }),
  arena_loss: Object.freeze({ reward: 0.2, weight: 0.8 }),
  user_prefer: Object.freeze({ reward: 0.95, weight: 1.0 }),
  user_accept: Object.freeze({ reward: 0.95, weight: 1.0 }),
  user_regenerate: Object.freeze({ reward: 0.05, weight: 1.0 }),
  user_refusal: Object.freeze({ reward: 0.05, weight: 1.0 }),
  overseer_pass: Object.freeze({ reward: 0.9, weight: 0.6 }),
  overseer_needs_work: Object.freeze({ reward: 0.25, weight: 0.6 }),
  tool_protocol_error: Object.freeze({ reward: 0.15, weight: 0.5 }),
  clean_completion: Object.freeze({ reward: 0.8, weight: 0.35 }),
});

const DECAY = 0.96;
const MAX_CELLS = 250;

export function defaultAutoTuneState() {
  return {
    version: 1,
    mode: 'passive',
    cells: {},       // key: `${modelKey}::${domain}::${effort}` -> { arms: { [profileId]: { a, b, n } }, updatedAt }
    familyCells: {}, // key: `${family}::${domain}::${effort}` -> { arms: { [profileId]: { a, b, n } }, updatedAt }
    pins: {},        // key: `${modelKey}::${domain}` -> profileId
    totalObservations: 0,
  };
}

export function normalizeAutoTuneState(raw) {
  const base = defaultAutoTuneState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const mode = AUTOTUNE_MODES.includes(raw.mode) ? raw.mode : 'passive';
  const sanitizeArms = (arms) => {
    const out = {};
    if (!arms || typeof arms !== 'object') return out;
    for (const id of PROFILE_ORDER) {
      const entry = arms[id];
      if (entry && typeof entry === 'object') {
        const a = Number.isFinite(entry.a) && entry.a >= 0 ? entry.a : 0;
        const b = Number.isFinite(entry.b) && entry.b >= 0 ? entry.b : 0;
        const n = Number.isFinite(entry.n) && entry.n >= 0 ? entry.n : 0;
        if (a > 0 || b > 0 || n > 0) out[id] = { a, b, n };
      }
    }
    return out;
  };
  const sanitizeMap = (obj) => {
    const out = {};
    if (!obj || typeof obj !== 'object') return out;
    for (const [k, v] of Object.entries(obj).slice(0, MAX_CELLS)) {
      if (typeof k === 'string' && v && typeof v === 'object') {
        out[k] = { arms: sanitizeArms(v.arms), updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : null };
      }
    }
    return out;
  };
  const pins = {};
  if (raw.pins && typeof raw.pins === 'object') {
    for (const [k, v] of Object.entries(raw.pins).slice(0, MAX_CELLS)) {
      if (typeof k === 'string' && !/^__(?:proto|defineGetter|defineSetter)__$|^(?:constructor|prototype)$/.test(k) && PROFILE_BY_ID.has(v)) {
        pins[k] = v;
      }
    }
  }
  return {
    version: 1,
    mode,
    cells: sanitizeMap(raw.cells),
    familyCells: sanitizeMap(raw.familyCells),
    pins,
    totalObservations: Number.isFinite(raw.totalObservations) && raw.totalObservations >= 0 ? raw.totalObservations : 0,
  };
}

export function normalizeModelKey(provider) {
  const raw = String(typeof provider === 'string' ? provider : (provider?.model || provider?.id || 'default')).trim().toLowerCase();
  const clean = raw.replace(/[^a-z0-9._:/-]/g, '').replace(/::+/g, ':').slice(0, 96);
  if (!clean || /^__(?:proto)__$|^(?:constructor|prototype)$/.test(clean)) return 'default';
  return clean;
}

export function normalizeDomain(domain) {
  const d = String(domain || 'general').trim().toLowerCase();
  if (/code|coding|swe|debug|refactor|fix|test|backend|frontend/.test(d)) return 'swe';
  if (DOMAIN_PRIORS[d]) return d;
  if (/math|logic|proof|quant/.test(d)) return 'math';
  if (/ui|design|css|visual|html/.test(d)) return 'ui';
  if (/sec|red|vuln|audit|cyber|exploit/.test(d)) return 'security';
  if (/research|analy|paper|data/.test(d)) return 'research';
  if (/write|creative|story|copy|brainstorm/.test(d)) return 'creative';
  return 'general';
}

function normalizeEffortKey(effort) {
  const e = String(effort || 'medium').trim().toLowerCase();
  return ['fast', 'low', 'medium', 'high', 'max', 'xhigh'].includes(e) ? e : 'medium';
}

function sampleStandardNormal(rng = Math.random) {
  const u1 = Math.max(1e-12, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// Marsaglia-Tsang Gamma(shape, 1) -> exact Beta(alpha, beta) Thompson draw
function sampleGamma(shape, rng = Math.random) {
  if (shape < 1) {
    return sampleGamma(shape + 1, rng) * Math.pow(Math.max(1e-12, rng()), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let i = 0; i < 32; i++) {
    let x, v;
    do {
      x = sampleStandardNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(Math.max(1e-12, u)) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  return d;
}

function sampleBeta(alpha, beta, rng = Math.random) {
  const a = Math.max(0.05, alpha);
  const b = Math.max(0.05, beta);
  const x = sampleGamma(a, rng);
  const y = sampleGamma(b, rng);
  return x / (x + y || 1);
}

function computePosteriorForArm(state, { modelKey, family, domain, effort, profileId }) {
  const prior = (DOMAIN_PRIORS[domain] || DOMAIN_PRIORS.general)[profileId] || [2, 2];
  const famCell = state.familyCells[`${family}::${domain}::${effort}`]?.arms?.[profileId];
  const exactCell = state.cells[`${modelKey}::${domain}::${effort}`]?.arms?.[profileId];

  // Hierarchical Empirical Bayes pooling: family evidence gets 0.45 weight, exact model gets 1.0 weight.
  const famWeight = 0.45;
  const alpha = prior[0] + (famCell ? famCell.a * famWeight : 0) + (exactCell ? exactCell.a : 0);
  const beta = prior[1] + (famCell ? famCell.b * famWeight : 0) + (exactCell ? exactCell.b : 0);
  const observations = (exactCell?.n || 0);
  const familyObservations = (famCell?.n || 0);
  const mean = alpha / (alpha + beta);
  const confidence = Math.min(0.99, (observations + familyObservations * 0.45) / ((observations + familyObservations * 0.45) + 6));
  return { profileId, alpha, beta, mean, observations, familyObservations, confidence };
}

function isSamplingLockedModel(provider, effort = 'medium') {
  const model = String(provider?.model || provider?.id || '').toLowerCase();
  const base = model.includes('/') ? model.split('/').pop() : model;
  if (/^(?:o1|o3|o4)(?:$|-)/.test(base)) return true;
  if (/^gpt-[56](?:$|[.-])/.test(base) && String(effort || 'medium').toLowerCase() !== 'fast') return true;
  const proto = String(provider?.protocol || '').toLowerCase();
  if (proto === 'cli' || proto.startsWith('acp')) return true;
  return false;
}

/**
 * Clamps a curated profile's sampling params strictly to what the target provider supports,
 * never overwriting any parameter explicitly set by the user in `manualGeneration`.
 */
export function clampProfileToProvider(profile, provider, manualGeneration = {}, effort = 'medium') {
  const limits = parameterLimits(provider || {});
  const fields = limits?.fields || {};
  const rawManual = manualGeneration && typeof manualGeneration === 'object' ? manualGeneration : {};
  const manual = Object.fromEntries(Object.entries(rawManual).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const applied = {};
  const skipped = [];
  const samplingLocked = isSamplingLockedModel(provider, effort);
  const isAnthropic = String(provider?.protocol || '').toLowerCase() === 'anthropic';

  for (const [key, rawVal] of Object.entries(profile?.params || {})) {
    if (manual[key] !== undefined) {
      skipped.push(`${key}:manual`);
      continue;
    }
    if (samplingLocked && ['temperature', 'top_p', 'top_k', 'min_p', 'frequency_penalty', 'presence_penalty'].includes(key)) {
      skipped.push(`${key}:reasoning_locked`);
      continue;
    }
    // Anthropic Messages API (Claude 4+) rejects requests specifying BOTH temperature and top_p.
    if (isAnthropic && (
      (key === 'top_p' && (applied.temperature !== undefined || manual.temperature !== undefined))
      || (key === 'temperature' && (applied.top_p !== undefined || manual.top_p !== undefined))
    )) {
      skipped.push(`${key}:anthropic_exclusive`);
      continue;
    }
    const spec = fields[key];
    if (!spec || spec.supported === false) {
      skipped.push(`${key}:unsupported`);
      continue;
    }
    const clamped = Math.min(spec.max, Math.max(spec.min, Number(rawVal)));
    applied[key] = Math.round(clamped * 1000) / 1000;
  }

  return {
    generation: { ...applied, ...manual },
    applied,
    skipped,
    manualOverride: Object.keys(manual).some(k => ['temperature', 'top_p', 'min_p', 'top_k', 'frequency_penalty', 'presence_penalty'].includes(k)),
  };
}

/**
 * Selects the optimal sampling profile & clamped generation params for an upcoming turn.
 */
export function selectAutoTuneParams(stateInput, {
  provider,
  objective = '',
  domain = null,
  effort = 'medium',
  manualGeneration = {},
  contextKind = 'normal', // 'normal' | 'retry' | 'arena' | 'conclave'
  previousProfileId = null,
  rng = Math.random,
} = {}) {
  const state = normalizeAutoTuneState(stateInput);
  if (state.mode === 'off') {
    return { active: false, reason: 'disabled', generation: manualGeneration || {} };
  }

  // If the user explicitly set temperature in Model Controls, respect manual control completely.
  const hasManualTemp = manualGeneration && manualGeneration.temperature !== undefined && manualGeneration.temperature !== null && manualGeneration.temperature !== '';
  if (hasManualTemp) {
    return { active: false, reason: 'manual_override', generation: manualGeneration };
  }

  const detectedDomain = domain
    ? normalizeDomain(domain)
    : normalizeDomain(classifyPromptDomain(String(objective || '')).primaryDomain);
  const modelKey = normalizeModelKey(provider);
  const family = inferModelFamily(provider?.model || modelKey || provider?.id);
  const effortKey = normalizeEffortKey(effort);

  const posteriors = PROFILE_ORDER.map(profileId =>
    computePosteriorForArm(state, { modelKey, family, domain: detectedDomain, effort: effortKey, profileId })
  );
  const sortedByMean = [...posteriors].sort((a, b) => b.mean - a.mean);
  const bestArm = sortedByMean[0];
  const bestIdx = PROFILE_ORDER.indexOf(bestArm.profileId);

  // 1. Respect explicit user pin for this (model × domain)
  const pinKey = `${modelKey}::${detectedDomain}`;
  const pinnedId = state.pins[pinKey];
  let chosen = null;
  let selectionMode = 'exploit';

  if (pinnedId && PROFILE_BY_ID.has(pinnedId)) {
    chosen = posteriors.find(p => p.profileId === pinnedId) || bestArm;
    selectionMode = 'pinned';
  } else if (contextKind === 'retry' && previousProfileId && PROFILE_BY_ID.has(previousProfileId)) {
    // Free exploration on retry/reframe: step to a distinct adjacent/higher-entropy arm!
    const prevIdx = PROFILE_ORDER.indexOf(previousProfileId);
    const candidates = [
      PROFILE_ORDER[Math.min(PROFILE_ORDER.length - 1, prevIdx + 1)],
      PROFILE_ORDER[Math.max(0, prevIdx - 1)],
      bestArm.profileId,
    ].filter((id, i, arr) => id !== previousProfileId && arr.indexOf(id) === i);
    const pickId = candidates[0] || bestArm.profileId;
    chosen = posteriors.find(p => p.profileId === pickId) || bestArm;
    selectionMode = 'retry_explore';
  } else if (contextKind === 'arena' || state.mode === 'active') {
    // Full Thompson Sampling in Arena or Active mode
    const drawn = posteriors.map(p => ({ p, score: sampleBeta(p.alpha, p.beta, rng) }));
    drawn.sort((a, b) => b.score - a.score);
    chosen = drawn[0].p;
    selectionMode = chosen.profileId === bestArm.profileId ? 'exploit' : 'thompson_explore';
  } else {
    // Passive mode: Safe Conservative Thompson Sampling (<=10% adjacent-only exploration)
    const exploreRoll = rng();
    if (exploreRoll < 0.10) {
      const adjacent = posteriors.filter(p => Math.abs(PROFILE_ORDER.indexOf(p.profileId) - bestIdx) <= 1);
      const drawn = adjacent.map(p => ({ p, score: sampleBeta(p.alpha, p.beta, rng) }));
      drawn.sort((a, b) => b.score - a.score);
      chosen = drawn[0].p;
      selectionMode = chosen.profileId === bestArm.profileId ? 'exploit' : 'conservative_explore';
    } else {
      chosen = bestArm;
      selectionMode = 'exploit';
    }
  }

  const profile = PROFILE_BY_ID.get(chosen.profileId) || AUTOTUNE_PROFILES[1];
  const clamped = clampProfileToProvider(profile, provider, manualGeneration, effortKey);

  // If the target model supports none of the profile params (e.g. locked reasoning model or CLI/ACP bridge),
  // report active: false cleanly BEFORE cold-start observation so locked models never pollute posteriors.
  if (!Object.keys(clamped.applied).length) {
    return {
      active: false,
      reason: 'model_locks_sampling',
      generation: manualGeneration || {},
      meta: { modelKey, family, domain: detectedDomain, effort: effortKey, profileId: profile.id, skipped: clamped.skipped },
    };
  }

  // In Passive mode before any real data is observed for this model/family & domain (and not pinned/retry/arena),
  // observe passively without mutating wire defaults so fresh sessions preserve exact provider defaults.
  const totalCellObs = posteriors.reduce((sum, p) => sum + (p.observations || 0), 0);
  if (state.mode === 'passive' && selectionMode !== 'pinned' && contextKind === 'normal' && totalCellObs < 1) {
    return {
      active: false,
      observing: true,
      reason: 'passive_cold_start',
      generation: manualGeneration || {},
      receipt: {
        profileId: profile.id,
        profileLabel: profile.label,
        modelKey,
        family,
        domain: detectedDomain,
        effort: effortKey,
        selectionMode: 'observe',
        winRatePct: Math.round(chosen.mean * 100),
        confidencePct: 0,
        observations: 0,
        applied: {},
        skipped: clamped.skipped,
      },
    };
  }

  return {
    active: true,
    generation: clamped.generation,
    applied: clamped.applied,
    receipt: {
      profileId: profile.id,
      profileLabel: profile.label,
      modelKey,
      family,
      domain: detectedDomain,
      effort: effortKey,
      selectionMode,
      winRatePct: Math.round(chosen.mean * 100),
      confidencePct: Math.round(chosen.confidence * 100),
      observations: chosen.observations,
      applied: clamped.applied,
      skipped: clamped.skipped,
    },
  };
}

/**
 * Updates both exact-model and model-family Empirical Bayes posteriors with exponential decay.
 */
export function recordAutoTuneOutcome(stateInput, {
  provider,
  modelKey: explicitModelKey = null,
  family: explicitFamily = null,
  domain = 'general',
  effort = 'medium',
  profileId,
  signal, // key in REWARD_SIGNAL_WEIGHTS OR custom { reward, weight }
  reward: customReward = null,
  weight: customWeight = null,
} = {}) {
  const state = normalizeAutoTuneState(stateInput);
  if (!PROFILE_BY_ID.has(profileId)) return state;

  const sigSpec = typeof signal === 'string' ? REWARD_SIGNAL_WEIGHTS[signal] : null;
  const reward = Number.isFinite(customReward) ? Math.min(1, Math.max(0, customReward)) : (sigSpec?.reward ?? null);
  const weight = Number.isFinite(customWeight) ? Math.min(2, Math.max(0.05, customWeight)) : (sigSpec?.weight ?? 0.5);
  if (reward === null) return state;

  const modelKey = normalizeModelKey(explicitModelKey || provider);
  const family = explicitFamily || inferModelFamily(provider?.model || modelKey || provider?.id);
  const dom = normalizeDomain(domain);
  const eff = normalizeEffortKey(effort);
  const now = new Date().toISOString();

  const updateMap = (map, key, wScale = 1) => {
    const cell = map[key] ? { arms: { ...map[key].arms }, updatedAt: now } : { arms: {}, updatedAt: now };
    const prev = cell.arms[profileId] || { a: 0, b: 0, n: 0 };
    const w = weight * wScale;
    cell.arms[profileId] = {
      a: Math.round((prev.a * DECAY + reward * w) * 10000) / 10000,
      b: Math.round((prev.b * DECAY + (1 - reward) * w) * 10000) / 10000,
      n: prev.n + 1,
    };
    map[key] = cell;
    // Evict oldest cell if over MAX_CELLS
    const keys = Object.keys(map);
    if (keys.length > MAX_CELLS) {
      keys.sort((k1, k2) => String(map[k1]?.updatedAt || '').localeCompare(String(map[k2]?.updatedAt || '')));
      delete map[keys[0]];
    }
  };

  updateMap(state.cells, `${modelKey}::${dom}::${eff}`, 1.0);
  updateMap(state.familyCells, `${family}::${dom}::${eff}`, 0.7);
  state.totalObservations += 1;
  return state;
}

/** Builds a clean UI/API summary table of learned optimal profiles per (model × domain × effort). */
export function summarizeAutoTuneState(stateInput) {
  const state = normalizeAutoTuneState(stateInput);
  const rows = [];
  for (const [key, cell] of Object.entries(state.cells)) {
    const parts = key.split('::');
    if (parts.length < 3) continue;
    const effort = parts.pop();
    const domain = parts.pop();
    const modelKey = parts.join(':');
    const family = inferModelFamily(modelKey);
    const armStats = PROFILE_ORDER.map(profileId =>
      computePosteriorForArm(state, { modelKey, family, domain, effort, profileId })
    );
    armStats.sort((a, b) => b.mean - a.mean);
    const best = armStats[0];
    const totalN = Object.values(cell.arms || {}).reduce((acc, x) => acc + (x?.n || 0), 0);
    const pinKey = `${modelKey}::${domain}`;
    rows.push({
      modelKey,
      family,
      domain,
      effort,
      bestProfile: best.profileId,
      bestLabel: PROFILE_BY_ID.get(best.profileId)?.label || best.profileId,
      bestParams: PROFILE_BY_ID.get(best.profileId)?.params || {},
      winRatePct: Math.round(best.mean * 100),
      confidencePct: Math.round(best.confidence * 100),
      observations: totalN,
      pinnedProfile: state.pins[pinKey] || null,
      updatedAt: cell.updatedAt,
    });
  }
  rows.sort((a, b) => b.observations - a.observations || b.winRatePct - a.winRatePct);
  return {
    mode: state.mode,
    enabled: state.mode !== 'off',
    totalObservations: state.totalObservations,
    profiles: AUTOTUNE_PROFILES,
    pins: state.pins,
    learned: rows.slice(0, 40),
  };
}
