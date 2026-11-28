import { createHash } from 'node:crypto';

/** Controller diagnoses are deliberately narrower than model-generated prose. */
export function diagnoseIncident(incident = {}) {
  const code = String(incident.code || 'UNKNOWN').toUpperCase();
  if (code === 'PROVIDER_POLICY') return { category: 'policy', route: false };
  if (code === 'CONTENT_RESTRICTION') return { category: 'content_restriction', route: true };
  if (code === 'PROVIDER_FAILURE') return { category: 'provider_failure', route: false };
  if (['ABORTED', 'CANCELLED', 'CANCELED', 'STALE_RUN', 'TASK_CANCELLED', 'EXECUTION_CANCELLED', 'EVALUATION_CANCELLED'].includes(code)) return { category: 'cancelled', route: false };
  if (/AUTH|CREDENTIAL|PROVIDER_CONFIGURATION|PROVIDER_CLOSED|PRIVACY_LOCAL_ONLY|PRIVACY_STRICT_ZDR/.test(code)) return { category: 'configuration', route: false };
  if (/DENIED|PERMISSION|SANDBOX|ISOLATION_UNAVAILABLE|EXECUTION_DISABLED|NETWORK_DISABLED|PROTECTED|GRANT|EACCES|EPERM|APPROVAL_REQUIRED|SCOPE_EXCLUDED|SCOPE_OUT_OF_BOUNDS|EPHEMERAL_SESSION/.test(code)) return { category: 'permission', route: false };
  if (/OUTCOME_UNKNOWN|WORKSPACE_|WRITE_CONFLICT|STALE_HASH|HASH_MISMATCH/.test(code)) return { category: 'workspace', route: false };
  if (/CONTEXT_LIMIT|CALL_BUDGET|RECOVERY_LIMIT|UNREGISTERED_ACCEPTANCE|USER_INPUT|MISSING_INPUT/.test(code)) return { category: 'owner_input', route: false };
  if (/HTTP_401|HTTP_402|HTTP_403/.test(code)) return { category: 'configuration', route: false };
  if (/HTTP_429/.test(code)) return { category: 'transport', route: true };
  if (incident.kind === 'refusal' || /REFUSAL|CONTENT_FILTER/.test(code)) return { category: 'refusal', route: true };
  if (incident.retryable === false) return { category: 'configuration', route: false };
  if (/HTTP_4\d\d/.test(code)) return { category: 'provider_404', route: true };
  if (/CAPABILITY|UNSUPPORTED_MODEL|UNSUPPORTED_TOOL/.test(code)) return { category: 'capability', route: true };
  if (code === 'OUTPUT_LIMIT') return { category: 'output_limit', route: true };
  if (/INVALID_RESPONSE|INVALID_TOOL|TOOL_PROTOCOL|RESULT_SCHEMA|OPERATION_ID_COLLISION/.test(code)) return { category: 'protocol', route: true };
  if (/TIMEOUT|ETIMEDOUT|ECONN|ENET|EAI_|FETCH|RATE_LIMIT|QUOTA_EXHAUSTED|HTTP_5\d\d|HTTP_429|PROVIDER_ERROR|OVERLOADED_ERROR|API_ERROR|PROVIDER_INCOMPLETE|PROVIDER_RESPONSE_FAILED/.test(code)) return { category: 'transport', route: true };
  if (/NO_PROGRESS|DOOM_LOOP/.test(code)) return { category: 'stalled', route: true };
  if (/INCOMPLETE_TASK|VERIFICATION_UNKNOWN|CHECK_FAILED/.test(code)) return { category: 'verification', route: true };
  return { category: 'tool_error', route: true };
}

/** Only standalone, first-person declines. Quotes, source code and useful actions are not refusals. */
export function detectRefusal(response, { learnedPatterns = [] } = {}) {
  if (response?.type !== 'message') return null;
  if (response.finish === 'refusal') return { code: 'CONTENT_RESTRICTION', kind: 'refusal', source: 'typed', confidence: 'explicit', message: String(response.text || 'Model declined to continue.').slice(0, 2000), retryable: true };
  if (response.finish === 'continue') return null;
  const text = String(response.text || '').trim();
  if (!text || text.length > 5000) return null;
  if (/```[\s\S]{40,}```/m.test(text)) return null;
  const prose = text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/^\s*>.*$/gm, '')
    .replace(/`[^`]*`|"[^"\n]*"|“[^”\n]*”/g, '')
    .replace(/[‘’]/g, "'")
    .trim();
  if (!prose) return null;
  if (/\b(?:implemented|updated|fixed|patched|created|changed|here(?:'s| is) (?:the|a) (?:patch|implementation|code|fix)|tests? pass(?:ed)?|instead,? (?:here|use|run))\b/i.test(prose)
    && !/\b(?:hold up|whoa|can.?t|won.?t|refuse|inappropriate)\b/i.test(prose)) return null;
  if (/\b(?:need (?:the|your|more)|provide (?:the|your)|missing (?:file|information)|permission|credentials?|api key|access to|not found|not installed)\b/i.test(prose)
    && !/\b(?:hold up|whoa|can.?t|won.?t|refuse|inappropriate)\b/i.test(prose)) return null;
  const classic = /^(?:(?:i(?:'m| am) sorry|sorry|i apologize|apologies|unfortunately)[,:.!]?\s*(?:but\s+)?)?(?:i (?:cannot|can't|won't|will not|am unable to|must (?:decline|refrain)(?: to| from)?)|i(?:'m| am) (?:not able|unable) to)\s+(?:help|assist|provide|comply|fulfill|complete|continue|implement|write|modify|build|create|generate|do|perform|work on|answer|engage)\b/i.test(prose);
  const indirectDecline = /^(?:(?:i(?:'m| am) sorry|sorry|unfortunately)[,:.!]?\s*)?(?:that|this)(?: request| topic| question| task)?\s+(?:isn't|is not|won't be)\s+something\s+(?:that\s+)?i\s+(?:can|am able to|will)\s+(?:help|assist|do|provide|fulfill|support)\b/i.test(prose)
    || /\b(?:i(?:'m| am)\s+(?:sorry|afraid)[,:.!]?\s*(?:but\s+)?)?(?:i\s+(?:can't|cannot|won't|will not|am not able to|am unable to)\s+(?:help|assist|comply|fulfill|do|provide|generate|write|create|build)\s+(?:you\s+)?(?:with\s+)?(?:that|this)(?:\s+request)?\b|i\s+(?:have to|must)\s+(?:decline|refuse|pass on)\s+(?:this|that|your\s+request)\b)/i.test(prose);
  const aiBoilerplate = /\b(?:as an ai(?: language model| assistant)?|my purpose is to be helpful and harmless|programmed to be (?:a )?helpful and harmless)\b/i.test(prose)
    && /\b(?:can't|cannot|won't|will not|unable|not able|decline|refrain|refuse|not permitted|not allowed)\b/i.test(prose);
  const ethicsRefusal = /\b(?:unethical|illegal|harmful|malicious|against (?:my|the) (?:policy|guidelines|terms|ethics|usage polic(?:y|ies))|not (?:something|able).*(?:assist|help|provide|fulfill)|dangerous|(?:could|would) (?:cause|be used (?:for|to)) harm)\b/i.test(prose)
    && /\b(?:can.?t|cannot|won.?t|will not|refuse|unable|not able|must (?:decline|refrain)|inappropriate|irresponsible)\b/i.test(prose);
  const softRefusal = /\b(?:hold up|whoa|stop right|can.?t do that|won.?t (?:do|help|assist|create|build|write|generate)|not (?:going to|gonna)|must (?:refuse|decline|refrain)|strongly (?:advise|recommend) against|raising.{0,20}eyebrows|(?:need|have) to stop here|cannot fulfill (?:this|that|your) request|unable to (?:fulfill|assist with) (?:this|that|your) request)\b/i.test(prose)
    && /\b(?:malware|ransomware|exploit|trojan|virus|keylog|harmful|illegal|unethical|malicious|weapon|attack|hack(?:ing)?|rootkit|spyware|botnet|c2|c&c|RAT|worm|backdoor|phish|credential.?steal|supply.?chain.?attack|reverse.?shell|APT|advanced persistent|drainer|stealer|implant|request|policy|guidelines|safety|ethics)\b/i.test(prose);
  const policyRefusal = /\b(?:violat(?:es?|ing)|against|prohibited by|not (?:allowed|permitted)|breach(?:es)?|goes against)\b.*\b(?:policy|guidelines?|terms|rules?|principles?|safety|ethics)\b/i.test(prose)
    && /\b(?:i\s+(?:cannot|can't|won't|will not|must|am unable|have to|decline|refuse)|cannot\s+(?:assist|help|fulfill|provide|comply)|my\s+(?:policy|guidelines|principles|safety)|this\s+request|your\s+request)\b/i.test(prose);
  const divergenceRefusal = /\b(?:(?:massive|huge|total) divergence|totally different (?:project|task)|wires crossed|mix.?up|(?:not|doesn.?t) (?:match|align|relate)|wrong (?:project|objective))\b/i.test(prose)
    && /\b(?:hold up|whoa|wait|stop|confused|what.?s (?:going|happening))\b/i.test(prose);
  let learnedMatch = false;
  if (!classic && !indirectDecline && !aiBoilerplate && !ethicsRefusal && !softRefusal && !policyRefusal && !divergenceRefusal
    && Array.isArray(learnedPatterns) && learnedPatterns.length && prose.length <= 1200) {
    const normalizedProse = prose.replace(/\s+/g, ' ').toLowerCase();
    for (const item of learnedPatterns) {
      const sig = typeof item === 'string' ? item : item?.signature;
      if (typeof sig === 'string' && sig.length >= 20 && normalizedProse.includes(sig.toLowerCase())) {
        learnedMatch = true;
        break;
      }
    }
  }
  if (!classic && !indirectDecline && !aiBoilerplate && !ethicsRefusal && !softRefusal && !policyRefusal && !divergenceRefusal && !learnedMatch) return null;
  const source = classic ? 'standalone_decline' : indirectDecline ? 'indirect_decline' : aiBoilerplate ? 'ai_boilerplate_decline' : ethicsRefusal ? 'ethics_refusal' : softRefusal ? 'soft_refusal' : policyRefusal ? 'policy_refusal' : divergenceRefusal ? 'divergence_refusal' : 'learned_pattern';
  return { code: 'CONTENT_RESTRICTION', kind: 'refusal', source, confidence: classic || indirectDecline || aiBoilerplate ? 'heuristic' : learnedMatch ? 'learned' : 'broad_heuristic', message: text.slice(0, 2000), retryable: true };
}

// Identity includes endpoint/model configuration but stores only its digest. Keys
// cannot silently inherit evidence from a different model under the same UI ID.
export function providerIdentity(id, provider = {}) {
  const configuration = [id, provider.kind || 'custom', provider.protocol || '', provider.model || '', provider.baseUrl || ''];
  return createHash('sha256').update(JSON.stringify(configuration)).digest('hex');
}

/** Only controller-owned, declared settings can change an HTTP request. */
export function requestProfile(task, provider, id = task.providerId) {
  const limits = provider?.capabilities?.outputTokens;
  if (!Number.isInteger(limits?.initial) || !Number.isInteger(limits?.max) || limits.initial < 1 || limits.max < limits.initial || limits.max > 200000) return undefined;
  const savedEntry = task.routing?.requestProfiles?.[providerIdentity(id, provider)];
  const saved = savedEntry?.maxOutputTokens;
  const reasoningCap = ['medium', 'low'].includes(savedEntry?.reasoningCap) ? savedEntry.reasoningCap : undefined;
  return { maxOutputTokens: Number.isInteger(saved) && saved >= limits.initial && saved <= limits.max ? saved : limits.initial, ...(reasoningCap ? { reasoningCap } : {}) };
}

export function candidateEligibility(provider, requiredTools = []) {
  if (!provider || typeof provider.turn !== 'function') return 'not_configured';
  if (provider.available === false || provider.closed === true) return 'unavailable';
  const capabilities = provider.capabilities;
  if (capabilities?.tools === false || capabilities?.portableContext === false) return 'incompatible_context_or_tools';
  if (Array.isArray(capabilities?.toolNames) && requiredTools.some(name => !capabilities.toolNames.includes(name))) return 'missing_required_tool';
  return null;
}

export const TIER_RANK = Object.freeze({ local: 0, standard: 1, frontier: 2 });
const ESCALATION_CATEGORIES = new Set(['stalled', 'verification', 'capability', 'protocol', 'tool_error', 'output_limit', 'content_restriction', 'refusal']);

export function providerTier(provider) {
  return Object.hasOwn(TIER_RANK, provider?.tier) ? provider.tier : 'standard';
}

export function recencyWeight(updatedAt, now = Date.now(), halfLifeMs = 7 * 24 * 60 * 60 * 1000) {
  if (typeof updatedAt !== 'string' || !updatedAt) return 1;
  const ts = Date.parse(updatedAt);
  if (!Number.isFinite(ts) || ts >= now) return 1;
  const age = now - ts;
  return Math.max(0.25, Math.min(1, Math.pow(0.5, age / halfLifeMs)));
}

export function rankCandidates({ task, providers, learning, diagnosis, requiredTools = [], excludeCurrent = true, fingerprint }) {
  if (!task || !Array.isArray(task.providers) || !providers || typeof providers.get !== 'function') return [];
  const diagCategory = diagnosis?.category || 'unknown';
  const currentProvider = providers.get(task.providerId);
  const currentTier = providerTier(currentProvider);
  const escalationEnabled = task.policy?.escalation !== 'off';
  const escalatingFromLocal = escalationEnabled && currentTier === 'local'
    && (ESCALATION_CATEGORIES.has(diagCategory) || (task.recoveries || 0) >= 2);
  const now = Date.now();
  return task.providers.map((id, index) => {
    const provider = providers.get(id), key = providerIdentity(id, provider);
    const tier = providerTier(provider);
    const stat = learning?.stats?.find(item => item.providerKey === key && item.category === diagCategory);
    const successes = stat?.successes || 0, failures = stat?.failures || 0, samples = successes + failures;
    const confidence = (samples / (samples + 5)) * recencyWeight(stat?.updatedAt, now);
    const successEstimate = Number.isFinite(stat?.recencyEstimate) ? stat.recencyEstimate : (successes + 1) / (samples + 2);
    // Untried models get a small bonus so the index penalty alone can't shadow them.
    const explorationBonus = samples === 0 ? 0.03 : 0;
    const latencyPenalty = Number.isFinite(stat?.avgDurationMs) && stat.avgDurationMs > 0
      ? Math.min(0.015, (stat.avgDurationMs / 60000) * 0.015) : 0;
    const escalationBoost = escalatingFromLocal && TIER_RANK[tier] > TIER_RANK[currentTier]
      ? (tier === 'frontier' ? 0.35 : 0.28) : 0;
    const isRefusalWaterfall = diagnosis?.category === 'content_restriction' || diagnosis?.category === 'refusal';
    // On refusal failover, respect the ordered smartest-first waterfall list cleanly.
    const indexStep = isRefusalWaterfall ? 0.08 : 0.002;
    const score = (successEstimate - 0.5) * confidence + explorationBonus + escalationBoost - latencyPenalty - index * indexStep;
    let excluded = candidateEligibility(provider, requiredTools);
    if (!excluded && excludeCurrent && id === task.providerId) excluded = 'current_provider';
    if (!excluded && isRefusalWaterfall && Array.isArray(task.routing?.declinedProviders) && task.routing.declinedProviders.includes(id)) excluded = 'declined_previously';
    if (!excluded && (task.routing?.cooldowns?.[id] || 0) > task.calls) excluded = 'cooldown';
    if (!excluded && (task.providerNotBefore?.[key] || 0) > now) excluded = 'retry_after';
    const strategies = [...new Set(task.policy?.strategies?.length ? task.policy.strategies : ['continue'])];
    const profileKey = JSON.stringify(requestProfile(task, provider, id) || null);
    const attempts = fingerprint ? (task.routing?.attempts || []).filter(item => item.fingerprint === fingerprint && item.providerKey === key && JSON.stringify(item.requestProfile || null) === profileKey) : [];
    const nextStrategy = strategies.find(strategy => !attempts.some(item => item.strategy === strategy));
    if (!excluded && fingerprint && !nextStrategy) excluded = 'strategies_exhausted';
    return { id, providerKey: key, tier, escalated: Boolean(escalationBoost > 0), attemptsAtCheckpoint: attempts.length, nextStrategy,
      score: Number(score.toFixed(5)), samples, successes, failures, confidence: Number(confidence.toFixed(3)), successEstimate: Number(successEstimate.toFixed(3)), excluded };
  }).sort((a, b) => (Boolean(a.excluded) - Boolean(b.excluded)) || a.attemptsAtCheckpoint - b.attemptsAtCheckpoint || b.score - a.score);
}

/** Reorder provider list so the best initial provider is first, using learning data. */
export function rankInitialProviders(providerIds, providers, learning) {
  if (!Array.isArray(providerIds) || !learning?.stats?.length || providerIds.length < 2 || !providers || typeof providers.get !== 'function') return Array.isArray(providerIds) ? providerIds : [];
  const [pinned, ...rest] = providerIds;
  if (rest.length < 2) return providerIds;
  const scored = rest.map(id => {
    const provider = providers.get(id);
    const key = providerIdentity(id, provider);
    const eligible = candidateEligibility(provider, []);
    if (eligible) return { id, score: -1 };
    const completionStat = learning.stats.find(s => s.providerKey === key && s.category === 'completion');
    const restrictionStat = learning.stats.find(s => s.providerKey === key && s.category === 'content_restriction');
    const compSamples = completionStat ? (completionStat.samples ?? ((completionStat.successes || 0) + (completionStat.failures || 0))) : 0;
    const restSamples = restrictionStat ? (restrictionStat.samples ?? ((restrictionStat.successes || 0) + (restrictionStat.failures || 0))) : 0;
    const completionSuccess = completionStat ? (completionStat.successes || 0) / Math.max(1, compSamples) : 0.5;
    const restrictionRate = restrictionStat ? (restrictionStat.failures || 0) / Math.max(1, restSamples) : 0;
    const confidence = compSamples / (compSamples + 3);
    return { id, score: completionSuccess * confidence - restrictionRate * 0.3 };
  });
  scored.sort((a, b) => b.score - a.score);
  return [pinned, ...scored.map(s => s.id)];
}
