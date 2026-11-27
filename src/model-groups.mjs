import { classifyProviderZdr, checkProviderPrivacyAllowed, DEFAULT_PRIVACY_SETTINGS } from './privacy.mjs';
import { providerObservedStats } from './learning.mjs';
import { providerIdentity } from './routing.mjs';
import {
  resolveCatalogEntry,
  computeBlendedPrice,
  computeValueScore,
  formatPricePer1M
} from './model-catalog.mjs';

/**
 * Modern Model Catalog & Ultra-Plinian Waterfall Group Engine.
 *
 * Classifies every connected provider/model using transparent coding & reasoning ratings,
 * real API / subscription / local pricing, context limits, speed bands, and ZDR posture —
 * then builds ordered waterfalls with multi-axis sorting (Smartest, Coding, Best Value,
 * Cheapest/Free, Fastest, Largest Context).
 */

export const MODEL_SORT_MODES = Object.freeze([
  { id: 'intelligence', label: 'Capability estimate', description: 'Coding + reasoning composite, then parameter size & context.' },
  { id: 'coding', label: 'Coding First', description: 'Pure engineering & SWE coding capability first.' },
  { id: 'value', label: 'Estimated value', description: 'Heuristic capability and cost ranking; account limits and hardware costs vary.' },
  { id: 'price', label: 'Estimated cost', description: 'Local models, then account plans, then estimated $/1M API cost.' },
  { id: 'speed', label: 'Speed estimate', description: 'Highest output throughput (tok/s) and lowest latency first.' },
  { id: 'context', label: 'Largest Context', description: 'Widest context window (1M → 200K → 128K) first.' }
]);

const VALID_SORT_IDS = new Set(MODEL_SORT_MODES.map(m => m.id));

export const MODEL_GROUP_PRESETS = Object.freeze([
  {
    id: 'flagship-waterfall',
    name: 'Flagship Intelligence',
    shortName: 'Flagship',
    description: 'Estimated S/A capability tiers first; recovery follows the current route and call limits.',
    sortBy: 'intelligence',
    filter: meta => meta.intelligence >= 85 || meta.size === 'frontier' || meta.tags.includes('flagship')
  },
  {
    id: 'coding-specialists',
    name: 'Coding Specialists',
    shortName: 'Coding',
    description: 'Code-tuned frontier and specialist models ranked by engineering capability.',
    sortBy: 'coding',
    filter: meta => meta.tags.includes('coding') || meta.size === 'frontier'
  },
  {
    id: 'fast-cascade',
    name: 'Fast & Efficient',
    shortName: 'Fast',
    description: 'Low-latency models prioritized by throughput while preserving high capability.',
    sortBy: 'speed',
    filter: meta => meta.speed === 'fast' || meta.tags.includes('fast')
  },
  {
    id: 'open-weight',
    name: 'Open-Weight & Uncensored',
    shortName: 'Open-Weight',
    description: 'Hermes, DeepSeek, Qwen, Llama, Venice, and local models ordered largest to compact.',
    sortBy: 'intelligence',
    filter: meta => meta.tags.includes('open-weight') || meta.capabilities?.openWeight || meta.zdr.zdrClass === 'native-zdr' || meta.zdr.localOnly
  },
  {
    id: 'zdr-fortress',
    name: 'ZDR-Only Waterfall',
    shortName: 'ZDR-Only',
    description: 'Strictly Zero Data Retention endpoints (Local, Venice Native ZDR, OpenRouter ZDR).',
    sortBy: 'intelligence',
    filter: meta => meta.zdr.strictZdrEligible === true
  },
  {
    id: 'local-only',
    name: 'Local On-Device',
    shortName: 'Local',
    description: '100% airgapped loopback models (Ollama, MLX, LM Studio, vLLM), largest first.',
    sortBy: 'intelligence',
    filter: meta => meta.zdr.localOnly === true
  },
  {
    id: 'all-smartest',
    name: 'All Connected Models',
    shortName: 'All Models',
    description: 'Every live connected provider ordered by your selected ranking strategy.',
    sortBy: 'intelligence',
    filter: () => true
  }
]);

export function classifyModel(provider, { catalog = null, learning = null } = {}) {
  const haystack = `${provider?.id || ''} ${provider?.model || ''} ${provider?.label || ''}`;
  const zdr = classifyProviderZdr(provider);
  const entry = catalog?.lookup ? catalog.lookup(provider) : resolveCatalogEntry(provider, catalog?.liveMap || null);
  const tags = new Set(entry.tags || []);

  const isSubscription = ['claude', 'codex', 'antigravity-cli', 'gemini-cli', 'copilot-cli'].includes(provider?.kind);
  const billing = zdr.localOnly ? 'local' : isSubscription ? 'subscription' : 'api';

  if (zdr.zdrClass === 'native-zdr') tags.add('zdr-native');
  if (zdr.localOnly) { tags.add('local'); tags.add('open-weight'); }
  if (/(?:openrouter|nous|venice|ollama|local)/i.test(String(provider?.id || '')) && !/claude|gpt-|gemini|o3|o4/i.test(haystack)) {
    tags.add('open-weight');
  }

  const apiPricing = entry.pricing ? { ...entry.pricing } : null;
  const blendedApiPrice = computeBlendedPrice(apiPricing);
  const blendedPricePer1M = billing === 'api' ? blendedApiPrice : 0;

  let priceLabel = 'API';
  let pricingSource = entry.pricingSource;
  if (billing === 'local') {
    priceLabel = 'Local';
    pricingSource = 'local';
  } else if (billing === 'subscription') {
    priceLabel = 'Account plan';
    pricingSource = 'subscription';
  } else if (apiPricing && Number.isFinite(apiPricing.inputPer1M) && Number.isFinite(apiPricing.outputPer1M)) {
    priceLabel = `${pricingSource === 'bundled-estimate' ? '~' : ''}${formatPricePer1M(apiPricing.inputPer1M)} / ${formatPricePer1M(apiPricing.outputPer1M)}`;
  }

  const valueScore = computeValueScore({
    intelligence: entry.intelligence,
    billing,
    blendedPricePer1M
  });

  // Blend in optional local observed outcomes + explicit Pin/Demote preference (strictly local SQLite, zero telemetry)
  const key = provider?.id ? providerIdentity(provider.id, provider) : null;
  const observed = learning ? providerObservedStats(learning, provider?.id, key) : null;
  const observedLatencyMs = observed?.avgDurationMs || Number(learning?.[provider?.id]?.avgLatencyMs || 0) || null;
  const preference = (provider?.id && learning?.modelPreferences?.[provider.id]) || null;
  // Bounded self-optimization delta (±6 pts empirical + explicit owner preference)
  let empiricalDelta = 0;
  if (observed && observed.samples >= 2) {
    const confidence = observed.samples / (observed.samples + 4);
    const centered = (observed.winRate - 60) / 40; // +1 at 100% win, -1.5 at 0% win
    empiricalDelta = Number((Math.max(-6, Math.min(6, centered * 6 * confidence))).toFixed(2));
  }
  const preferenceDelta = preference === 'pin' ? 8 : preference === 'demote' ? -10 : 0;

  return {
    id: provider?.id || '',
    label: provider?.label || provider?.id || '',
    model: provider?.model || null,
    family: entry.family,
    kind: provider?.kind || 'http',
    tier: entry.tier,
    providerTier: provider?.tier || 'standard',
    available: provider?.available !== false,
    coding: entry.coding,
    reasoning: entry.reasoning,
    intelligence: entry.intelligence,
    effectiveIntelligence: Number((entry.intelligence + empiricalDelta + preferenceDelta).toFixed(2)),
    empiricalDelta,
    preference,
    observed,
    size: entry.size,
    paramB: entry.paramB,
    speed: entry.speed,
    tokPerSec: entry.tokPerSec,
    observedLatencyMs,
    contextWindow: entry.contextWindow,
    contextLabel: entry.contextLabel,
    maxOutput: entry.maxOutput,
    billing,
    pricing: billing === 'api' ? apiPricing : null,
    blendedPricePer1M,
    priceLabel,
    pricingSource,
    rankingSource: entry.rankingSource,
    valueScore,
    capabilities: { ...entry.capabilities, openWeight: Boolean(entry.capabilities?.openWeight || tags.has('open-weight')) },
    tags: [...tags],
    zdr
  };
}

const SPEED_SCORE = { fast: 2, balanced: 1, reasoning: 0 };
const BILLING_PRICE_RANK = { local: 0, subscription: 1, api: 2 };

export function sortModels(models, sortBy = 'intelligence') {
  const mode = VALID_SORT_IDS.has(sortBy) ? sortBy : 'intelligence';
  return [...models].sort((a, b) => {
    if (mode === 'coding') {
      if (b.coding !== a.coding) return b.coding - a.coding;
    } else if (mode === 'value') {
      if (b.valueScore !== a.valueScore) return b.valueScore - a.valueScore;
    } else if (mode === 'price') {
      const ba = BILLING_PRICE_RANK[a.billing] ?? 2;
      const bb = BILLING_PRICE_RANK[b.billing] ?? 2;
      if (ba !== bb) return ba - bb;
      const pa = Number.isFinite(a.blendedPricePer1M) ? a.blendedPricePer1M : 9999;
      const pb = Number.isFinite(b.blendedPricePer1M) ? b.blendedPricePer1M : 9999;
      if (pa !== pb) return pa - pb;
    } else if (mode === 'speed') {
      const dt = (b.tokPerSec || 0) - (a.tokPerSec || 0);
      if (dt !== 0) return dt;
      const ds = (SPEED_SCORE[b.speed] ?? 1) - (SPEED_SCORE[a.speed] ?? 1);
      if (ds !== 0) return ds;
    } else if (mode === 'context') {
      const dc = (b.contextWindow || 0) - (a.contextWindow || 0);
      if (dc !== 0) return dc;
    }

    const effA = a.effectiveIntelligence ?? a.intelligence;
    const effB = b.effectiveIntelligence ?? b.intelligence;
    if (effB !== effA) return effB - effA;
    if (b.intelligence !== a.intelligence) return b.intelligence - a.intelligence;
    if ((b.paramB || 0) !== (a.paramB || 0)) return (b.paramB || 0) - (a.paramB || 0);
    if ((b.contextWindow || 0) !== (a.contextWindow || 0)) return (b.contextWindow || 0) - (a.contextWindow || 0);
    return a.id.localeCompare(b.id);
  });
}

export function buildModelGroups(providers, privacy = DEFAULT_PRIVACY_SETTINGS, { sortBy = null, catalog = null, learning = null } = {}) {
  const overrideSort = VALID_SORT_IDS.has(sortBy) ? sortBy : null;
  const live = [...providers.values()]
    .filter(p => p && p.kind !== 'scripted' && p.available !== false && !p.closed)
    .filter(p => checkProviderPrivacyAllowed(p, privacy).allowed)
    .map(p => classifyModel(p, { catalog, learning }));

  return MODEL_GROUP_PRESETS.map(preset => {
    const activeSort = overrideSort || preset.sortBy;
    const matched = sortModels(live.filter(preset.filter), activeSort);
    return {
      id: preset.id,
      name: preset.name,
      shortName: preset.shortName,
      description: preset.description,
      sortBy: activeSort,
      defaultSortBy: preset.sortBy,
      count: matched.length,
      providerIds: matched.map(m => m.id),
      models: matched
    };
  });
}

export function resolveCascadeGroup(groupId, providers, privacy = DEFAULT_PRIVACY_SETTINGS, options = {}) {
  const groups = buildModelGroups(providers, privacy, options);
  return groups.find(g => g.id === groupId) || null;
}
