import { redactOutboundText } from './privacy.mjs';

export const LEARNING_VERSION = 1;
const categories = new Set(['refusal', 'capability', 'protocol', 'transport', 'output_limit', 'stalled', 'verification', 'tool_error', 'completion', 'content_restriction', 'provider_404', 'configuration', 'policy', 'provider_failure', 'permission', 'workspace', 'owner_input', 'cancelled']);
export const PROCEDURES = Object.freeze({
  'verify-after-edit': 'After editing, run the owner-configured checks and inspect their actual output before claiming completion.',
  'checkpoint-handoff': 'At a model handoff, inspect current files and completed operation results. Continue unfinished work without replaying completed writes.',
  'repair-from-evidence': 'When a check fails, use its concrete failure evidence to make a focused repair, then rerun the check.',
  'retrieve-before-edit': 'Read the current file and its hash before preparing a patch; omitted context is unknown, not an empty file.'
});

export function emptyLearning() {
  return {
    version: LEARNING_VERSION,
    localOnly: true,
    stats: [],
    strategyStats: [],
    refusalPatterns: [],
    modelPreferences: {},
    domainElo: {},
    notes: [],
    updatedAt: null,
    retention: { maxStats: 256, maxStrategyStats: 128, maxRefusalPatterns: 64, noteTemplates: Object.keys(PROCEDURES).length },
    scope: 'Minimized local aggregate outcomes only; task transcripts remain in the separate task event log.'
  };
}

export function inferModelFamily(providerId = '') {
  const s = String(providerId || '').toLowerCase();
  if (/claude|anthropic/.test(s)) return 'claude';
  if (/gpt-|codex|\bo3\b|\bo4\b|openai/.test(s)) return 'gpt';
  if (/gemini/.test(s)) return 'gemini';
  if (/deepseek/.test(s)) return 'deepseek';
  if (/qwen/.test(s)) return 'qwen';
  if (/llama/.test(s)) return 'llama';
  if (/hermes|nous/.test(s)) return 'hermes';
  if (/venice/.test(s)) return 'venice';
  if (/mistral|codestral|devstral/.test(s)) return 'mistral';
  if (/neon/.test(s)) return 'neon';
  if (/kimi/.test(s)) return 'kimi';
  if (/glm/.test(s)) return 'glm';
  if (/grok/.test(s)) return 'grok';
  return 'other';
}

export function applyObservations(previous, observations = [], noteIds = []) {
  const next = {
    ...emptyLearning(),
    ...previous,
    stats: [...(previous?.stats || [])],
    strategyStats: [...(previous?.strategyStats || [])],
    notes: [...(previous?.notes || [])]
  };
  const DECAY = 0.9;
  for (const observation of observations) {
    if (!categories.has(observation.category) || !['success', 'failure'].includes(observation.outcome) || !/^[a-f0-9]{64}$/.test(observation.providerKey)) throw new Error('Invalid minimized learning observation');
    const index = next.stats.findIndex(item => item.providerKey === observation.providerKey && item.category === observation.category);
    const old = index < 0 ? { providerKey: observation.providerKey, providerId: String(observation.providerId).slice(0, 160), category: observation.category, successes: 0, failures: 0, samples: 0 } : next.stats[index];
    const isSuccess = observation.outcome === 'success';
    const prevDecayedS = Number.isFinite(old.decayedSuccesses) ? old.decayedSuccesses : old.successes;
    const prevDecayedF = Number.isFinite(old.decayedFailures) ? old.decayedFailures : old.failures;
    const decayedSuccesses = Number((prevDecayedS * DECAY + (isSuccess ? 1 : 0)).toFixed(4));
    const decayedFailures = Number((prevDecayedF * DECAY + (isSuccess ? 0 : 1)).toFixed(4));
    const durationValid = Number.isFinite(observation.durationMs) && observation.durationMs >= 0;
    const avgDurationMs = durationValid
      ? (Number.isFinite(old.avgDurationMs) ? Math.round(old.avgDurationMs * 0.7 + observation.durationMs * 0.3) : Math.round(observation.durationMs))
      : old.avgDurationMs;
    const stat = {
      ...old,
      successes: old.successes + (isSuccess ? 1 : 0),
      failures: old.failures + (isSuccess ? 0 : 1),
      samples: old.samples + 1,
      decayedSuccesses,
      decayedFailures,
      ...(avgDurationMs !== undefined ? { avgDurationMs } : {}),
      ...(durationValid ? { lastDurationMs: Math.round(observation.durationMs) } : {}),
      updatedAt: new Date().toISOString()
    };
    stat.successEstimate = (stat.successes + 1) / (stat.samples + 2);
    stat.recencyEstimate = Number(((decayedSuccesses + 1) / (decayedSuccesses + decayedFailures + 2)).toFixed(4));
    stat.confidence = stat.samples / (stat.samples + 5);
    if (index < 0) next.stats.push(stat); else next.stats[index] = stat;
  }
  next.stats = next.stats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 256);
  for (const id of new Set(noteIds)) {
    if (!Object.hasOwn(PROCEDURES, id)) continue;
    const index = next.notes.findIndex(note => note.id === id), old = next.notes[index];
    const note = { id, text: PROCEDURES[id], evidenceCount: (old?.evidenceCount || 0) + 1 };
    if (index < 0) next.notes.push(note); else next.notes[index] = note;
  }
  next.updatedAt = new Date().toISOString();
  return next;
}

/**
 * Local per-model-family recovery strategy bandit (zero telemetry).
 * Learns which unblock strategy (e.g. switch_model, overseer_reframe, decompose, role)
 * converts best for each model family so future recoveries skip wasted passes.
 */
export function applyStrategyObservation(previous, { modelFamily, strategy, outcome } = {}) {
  const family = String(modelFamily || 'other').toLowerCase().slice(0, 40);
  const strat = String(strategy || '').trim().slice(0, 64);
  if (!strat || !['success', 'failure'].includes(outcome)) return previous || emptyLearning();
  const next = {
    ...emptyLearning(),
    ...previous,
    stats: [...(previous?.stats || [])],
    strategyStats: [...(previous?.strategyStats || [])],
    notes: [...(previous?.notes || [])]
  };
  const DECAY = 0.9;
  const idx = next.strategyStats.findIndex(item => item.modelFamily === family && item.strategy === strat);
  const old = idx < 0
    ? { modelFamily: family, strategy: strat, successes: 0, failures: 0, samples: 0 }
    : next.strategyStats[idx];
  const isSuccess = outcome === 'success';
  const prevS = Number.isFinite(old.decayedSuccesses) ? old.decayedSuccesses : old.successes;
  const prevF = Number.isFinite(old.decayedFailures) ? old.decayedFailures : old.failures;
  const decayedSuccesses = Number((prevS * DECAY + (isSuccess ? 1 : 0)).toFixed(4));
  const decayedFailures = Number((prevF * DECAY + (isSuccess ? 0 : 1)).toFixed(4));
  const row = {
    ...old,
    successes: old.successes + (isSuccess ? 1 : 0),
    failures: old.failures + (isSuccess ? 0 : 1),
    samples: old.samples + 1,
    decayedSuccesses,
    decayedFailures,
    recencyEstimate: Number(((decayedSuccesses + 1) / (decayedSuccesses + decayedFailures + 2)).toFixed(4)),
    updatedAt: new Date().toISOString()
  };
  if (idx < 0) next.strategyStats.push(row); else next.strategyStats[idx] = row;
  next.strategyStats = next.strategyStats.sort((a, b) => b.recencyEstimate - a.recencyEstimate || b.samples - a.samples).slice(0, 128);
  next.updatedAt = new Date().toISOString();
  return next;
}

export function bestStrategyForFamily(learning, modelFamily) {
  const family = String(modelFamily || 'other').toLowerCase();
  const rows = (learning?.strategyStats || []).filter(r => r.modelFamily === family && r.samples >= 1 && r.successes >= 1);
  if (!rows.length) return null;
  const best = [...rows].sort((a, b) => b.recencyEstimate - a.recencyEstimate || b.samples - a.samples)[0];
  return best && best.recencyEstimate >= 0.55 ? best : null;
}

/**
 * Aggregates local observed completion & refusal rates for a specific provider
 * to display honest win-rate badges and gently self-optimize waterfall ordering.
 */
export function providerObservedStats(learning, providerId, providerKey = null) {
  const stats = Array.isArray(learning?.stats) ? learning.stats : [];
  const matching = stats.filter(s => (providerKey && s.providerKey === providerKey) || (providerId && s.providerId === providerId));
  if (!matching.length) return null;
  const completions = matching.filter(s => s.category === 'completion');
  const refusals = matching.filter(s => s.category === 'content_restriction' || s.category === 'refusal');
  const refusalFailures = refusals.reduce((sum, r) => sum + (r.failures || 0), 0);
  const wins = completions.reduce((sum, c) => sum + (c.successes || 0), 0);
  const otherFailures = matching
    .filter(s => s.category !== 'completion' && s.category !== 'content_restriction' && s.category !== 'refusal')
    .reduce((sum, r) => sum + (r.failures || 0), 0);
  const totalEvents = wins + refusalFailures + otherFailures;
  if (totalEvents <= 0) return null;
  const winRate = Math.round((wins / totalEvents) * 100);
  const refusalRate = Math.round((refusalFailures / totalEvents) * 100);
  const durationRows = completions.filter(c => Number.isFinite(c.avgDurationMs));
  const avgDurationMs = durationRows.length ? Math.round(durationRows.reduce((s, c) => s + c.avgDurationMs, 0) / durationRows.length) : null;
  return {
    winRate,
    refusalRate,
    wins,
    refusals: refusalFailures,
    samples: totalEvents,
    avgDurationMs
  };
}

export function extractDeclineSignature(replyText) {
  const raw = String(replyText || '').trim();
  if (!raw || raw.length > 1200) return null;
  if (/```[\s\S]{30,}```/m.test(raw)) return null;
  const cleaned = redactOutboundText(raw).text
    .replace(/`[^`]*`|"[^"\n]*"|“[^”\n]*”/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  const firstSentence = cleaned.split(/(?<=[.!?])\s+/)[0] || cleaned;
  const sig = firstSentence.slice(0, 110).replace(/[.,;:!?]+$/, '').trim().toLowerCase();
  const words = sig.match(/[a-z']{2,}/g) || [];
  if (sig.length < 20 || words.length < 4) return null;
  return sig;
}

export function applyLearnedRefusalPattern(previous, { signature, source = 'overseer', providerId = null } = {}) {
  const sig = typeof signature === 'string' ? signature.trim().toLowerCase().slice(0, 120) : '';
  if (sig.length < 20) return previous || emptyLearning();
  const next = {
    ...emptyLearning(),
    ...previous,
    stats: [...(previous?.stats || [])],
    strategyStats: [...(previous?.strategyStats || [])],
    refusalPatterns: [...(previous?.refusalPatterns || [])],
    modelPreferences: { ...(previous?.modelPreferences || {}) },
    notes: [...(previous?.notes || [])]
  };
  const idx = next.refusalPatterns.findIndex(p => p.signature === sig);
  const now = new Date().toISOString();
  if (idx < 0) {
    next.refusalPatterns.unshift({ signature: sig, source: String(source || 'local').slice(0, 40), hits: 1, lastProviderId: providerId ? String(providerId).slice(0, 160) : null, updatedAt: now });
  } else {
    const old = next.refusalPatterns[idx];
    next.refusalPatterns[idx] = { ...old, hits: (old.hits || 0) + 1, source: String(source || old.source || 'local').slice(0, 40), lastProviderId: providerId ? String(providerId).slice(0, 160) : old.lastProviderId, updatedAt: now };
  }
  next.refusalPatterns = next.refusalPatterns.sort((a, b) => (b.hits || 0) - (a.hits || 0) || b.updatedAt.localeCompare(a.updatedAt)).slice(0, 64);
  next.updatedAt = now;
  return next;
}

export function removeLearnedRefusalPattern(previous, signature = null) {
  const next = {
    ...emptyLearning(),
    ...previous,
    stats: [...(previous?.stats || [])],
    strategyStats: [...(previous?.strategyStats || [])],
    refusalPatterns: signature ? (previous?.refusalPatterns || []).filter(p => p.signature !== signature) : [],
    modelPreferences: { ...(previous?.modelPreferences || {}) },
    notes: [...(previous?.notes || [])]
  };
  next.updatedAt = new Date().toISOString();
  return next;
}

export function applyModelPreference(previous, { providerId, signal } = {}) {
  const id = typeof providerId === 'string' ? providerId.trim().slice(0, 200) : '';
  if (!id || !['pin', 'demote', 'reset'].includes(signal)) {
    throw Object.assign(new Error('Model preference requires providerId and signal (pin, demote, or reset).'), { code: 'INVALID_MODEL_FEEDBACK', status: 400 });
  }
  const next = {
    ...emptyLearning(),
    ...previous,
    stats: [...(previous?.stats || [])],
    strategyStats: [...(previous?.strategyStats || [])],
    refusalPatterns: [...(previous?.refusalPatterns || [])],
    modelPreferences: { ...(previous?.modelPreferences || {}) },
    notes: [...(previous?.notes || [])]
  };
  if (signal === 'reset') delete next.modelPreferences[id];
  else next.modelPreferences[id] = signal;
  next.updatedAt = new Date().toISOString();
  return next;
}

export function providerDomainStats(learning, domain, providerId) {
  const dom = String(domain || '').trim();
  const id = String(providerId || '').trim();
  if (!dom || !id) return null;
  const row = learning?.domainElo?.[dom]?.[id];
  if (!row || typeof row !== 'object') return null;
  return {
    elo: Number.isFinite(row.elo) ? row.elo : 1500,
    wins: row.wins || 0,
    losses: row.losses || 0,
    refusals: row.refusals || 0,
    samples: row.samples || 0,
    updatedAt: row.updatedAt || null
  };
}

/**
 * Per-user, per-domain local Elo & refusal-rate self-optimization (zero telemetry).
 * Supports 1v1 blind-judge race updates ('race_win'), solo completions ('win'),
 * refusals ('refusal'), failures ('loss'), and explicit user pins ('prefer' / 'demote').
 */
export function applyDomainOutcome(previous, { domain, providerId, outcome, opponentId = null, margin = 1 } = {}) {
  const dom = String(domain || '').trim().slice(0, 48);
  const id = String(providerId || '').trim().slice(0, 200);
  if (!dom || !id || !['win', 'loss', 'refusal', 'race_win', 'prefer', 'demote'].includes(outcome)) {
    return previous || emptyLearning();
  }
  const next = {
    ...emptyLearning(),
    ...previous,
    stats: [...(previous?.stats || [])],
    strategyStats: [...(previous?.strategyStats || [])],
    refusalPatterns: [...(previous?.refusalPatterns || [])],
    modelPreferences: { ...(previous?.modelPreferences || {}) },
    domainElo: { ...(previous?.domainElo || {}) },
    notes: [...(previous?.notes || [])]
  };
  const bucket = { ...(next.domainElo[dom] || {}) };
  const now = new Date().toISOString();
  const ensure = key => {
    const cur = bucket[key];
    return cur && typeof cur === 'object'
      ? { elo: Number.isFinite(cur.elo) ? cur.elo : 1500, wins: cur.wins || 0, losses: cur.losses || 0, refusals: cur.refusals || 0, samples: cur.samples || 0, updatedAt: cur.updatedAt || now }
      : { elo: 1500, wins: 0, losses: 0, refusals: 0, samples: 0, updatedAt: now };
  };
  const clampElo = v => Math.max(1150, Math.min(1950, Math.round(v)));
  const a = ensure(id);

  const oppId = opponentId ? String(opponentId).trim().slice(0, 200) : '';
  if (outcome === 'race_win' && oppId && oppId !== id) {
    const b = ensure(oppId);
    const expectedA = 1 / (1 + Math.pow(10, (b.elo - a.elo) / 400));
    const k = Math.min(36, Math.max(18, 22 + Math.min(10, Math.abs(Number(margin) || 1) * 2)));
    const delta = k * (1 - expectedA);
    a.elo = clampElo(a.elo + delta);
    a.wins += 1; a.samples += 1; a.updatedAt = now;
    b.elo = clampElo(b.elo - delta);
    b.losses += 1; b.samples += 1; b.updatedAt = now;
    bucket[id] = a;
    bucket[oppId] = b;
  } else if (outcome === 'win') {
    a.elo = clampElo(a.elo + 10);
    a.wins += 1; a.samples += 1; a.updatedAt = now;
    bucket[id] = a;
  } else if (outcome === 'loss') {
    a.elo = clampElo(a.elo - 10);
    a.losses += 1; a.samples += 1; a.updatedAt = now;
    bucket[id] = a;
  } else if (outcome === 'refusal') {
    a.elo = clampElo(a.elo - 20);
    a.refusals += 1; a.losses += 1; a.samples += 1; a.updatedAt = now;
    bucket[id] = a;
  } else if (outcome === 'prefer') {
    a.elo = clampElo(a.elo + 22);
    a.wins += 1; a.samples += 1; a.updatedAt = now;
    bucket[id] = a;
  } else if (outcome === 'demote') {
    a.elo = clampElo(a.elo - 26);
    a.losses += 1; a.samples += 1; a.updatedAt = now;
    bucket[id] = a;
  }

  // Bound per-domain entries to top 64 most recently active models
  const entries = Object.entries(bucket).sort((x, y) => String(y[1].updatedAt || '').localeCompare(String(x[1].updatedAt || ''))).slice(0, 64);
  next.domainElo[dom] = Object.fromEntries(entries);
  next.updatedAt = now;
  return next;
}

export function learningContext(learning, enabled = true) {
  return { version: LEARNING_VERSION, localOnly: true, notes: enabled ? (learning?.notes || []).slice(0, 4).map(({ id, text, evidenceCount }) => ({ id, text, evidenceCount })) : [] };
}
