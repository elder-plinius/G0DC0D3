import { randomUUID } from 'node:crypto';

/**
 * G0DC0D3 Privacy & Zero Data Retention (ZDR) Engine
 *
 * Guarantees by construction:
 * - Zero telemetry, zero analytics, zero crash beacons, zero phone-home endpoints.
 * - Never reads local CLI auth files to extract or hash user identities.
 * - Honest per-provider ZDR posture classification (no privacy-washing).
 * - Automatic ZDR request shaping (OpenRouter provider.zdr + data_collection=deny, OpenAI store=false).
 * - Optional Strict ZDR Gate and Local-Only Airgap Mode enforced at runtime & provider boundaries.
 * - Pre-flight outbound secret redaction before prompts leave the machine for cloud endpoints.
 */

export const TELEMETRY_POLICY = Object.freeze({
  enabled: false,
  analytics: false,
  crashReporting: false,
  readsLocalAuthFilesForIds: false,
  endpoints: Object.freeze([]),
  statement: 'Zero telemetry by construction. G0DC0D3 has no analytics SDKs, no crash beacons, and no phone-home endpoints.'
});

export const CLI_NO_TELEMETRY_ENV = Object.freeze({
  DO_NOT_TRACK: '1',
  OTEL_SDK_DISABLED: 'true',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  NO_UPDATE_NOTIFIER: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  GEMINI_TELEMETRY_ENABLED: 'false',
  CODEX_DISABLE_TELEMETRY: '1',
  POSTHOG_DISABLED: 'true',
  SENTRY_DSN: ''
});

export const SECURITY_PROFILES = Object.freeze({
  standard: Object.freeze({
    id: 'standard',
    label: 'Standard',
    zdrRouting: true,
    strictZdr: false,
    localOnly: false,
    redactOutboundSecrets: true,
    ephemeralSession: false,
    permissionPreset: null,
  }),
  hardened: Object.freeze({
    id: 'hardened',
    label: 'Hardened (Red Team / Bounty)',
    zdrRouting: true,
    strictZdr: true,
    localOnly: false,
    redactOutboundSecrets: true,
    ephemeralSession: true,
    permissionPreset: 'safe',
  }),
  lockdown: Object.freeze({
    id: 'lockdown',
    label: 'Airgap Lockdown (Zero Egress)',
    zdrRouting: true,
    strictZdr: true,
    localOnly: true,
    redactOutboundSecrets: true,
    ephemeralSession: true,
    permissionPreset: 'default',
  }),
});

export const DEFAULT_PRIVACY_SETTINGS = Object.freeze({
  securityProfile: 'standard',
  zdrRouting: true,
  strictZdr: false,
  localOnly: false,
  redactOutboundSecrets: true,
  ephemeralSession: false,
  scopeAllow: Object.freeze([]),
  scopeDeny: Object.freeze([]),
});

function normalizeScopePatterns(raw, fieldName) {
  if (raw === undefined) return undefined;
  const list = typeof raw === 'string'
    ? raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean)
    : Array.isArray(raw) ? raw : null;
  if (!list) {
    throw Object.assign(new Error(`Privacy setting "${fieldName}" must be an array of host patterns.`), { code: 'INVALID_PRIVACY', status: 400 });
  }
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') {
      throw Object.assign(new Error(`Invalid host pattern in ${fieldName}.`), { code: 'INVALID_PRIVACY', status: 400 });
    }
    let clean = item.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const bracketedIpv6 = clean.match(/^\[([^\]]+)\](?::\d+)?$/);
    if (bracketedIpv6) {
      clean = bracketedIpv6[1];
    } else if ((clean.match(/:/g) || []).length === 1) {
      clean = clean.replace(/:\d+$/, '');
    }
    clean = clean.replace(/\.+$/, '');
    if (clean.includes(':') && !clean.includes('*')) {
      try { clean = new URL(`http://[${clean}]/`).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch {}
    }
    if (!clean) continue;
    if (clean.length > 200 || !/^[a-z0-9*._:-]+$/.test(clean)) {
      throw Object.assign(new Error(`Invalid host pattern "${item.slice(0, 60)}" in ${fieldName}. Use hostnames or *.domain wildcards.`), { code: 'INVALID_PRIVACY', status: 400 });
    }
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= 64) break;
  }
  return out;
}

function hostMatchesScopePattern(host, pattern) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  const p = String(pattern || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!h || !p) return false;
  if (p === '*') return true;
  if (p.startsWith('*.') && !p.slice(2).includes('*')) {
    const suffix = p.slice(2);
    return h === suffix || h.endsWith('.' + suffix);
  }
  if (!p.includes('*')) return h === p;
  // Safe literal wildcard match (no catastrophic regex backtracking)
  const parts = p.split('*');
  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    if (i === 0) {
      if (!h.startsWith(part)) return false;
      pos = part.length;
    } else if (i === parts.length - 1) {
      if (!h.endsWith(part) || h.length - part.length < pos) return false;
      pos = h.length;
    } else {
      const idx = h.indexOf(part, pos);
      if (idx === -1) return false;
      pos = idx + part.length;
    }
  }
  return true;
}

export function checkTargetScope(rawUrl, privacy = DEFAULT_PRIVACY_SETTINGS) {
  const scopeAllow = Array.isArray(privacy?.scopeAllow) ? privacy.scopeAllow : [];
  const scopeDeny = Array.isArray(privacy?.scopeDeny) ? privacy.scopeDeny : [];
  if (!scopeAllow.length && !scopeDeny.length) return { allowed: true, code: null, message: null };
  let host = '';
  try {
    const parsed = new URL(String(rawUrl || ''));
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname) {
      host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    }
  } catch {}
  if (!host) {
    let raw = String(rawUrl || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '');
    const bracketed = raw.match(/^\[([^\]]+)\](?::\d+)?$/);
    if (bracketed) raw = bracketed[1];
    else if ((raw.match(/:/g) || []).length === 1) raw = raw.replace(/:\d+$/, '');
    if (raw.includes(':')) {
      try { raw = new URL(`http://[${raw}]/`).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch {}
    }
    host = raw.replace(/\.+$/, '');
  }
  for (const deny of scopeDeny) {
    if (hostMatchesScopePattern(host, deny)) {
      return {
        allowed: false,
        code: 'SCOPE_EXCLUDED',
        message: `Target "${host}" is explicitly excluded by your Rules-of-Engagement denylist (${deny}).`
      };
    }
  }
  if (scopeAllow.length > 0 && !scopeAllow.some(allow => hostMatchesScopePattern(host, allow))) {
    return {
      allowed: false,
      code: 'SCOPE_OUT_OF_BOUNDS',
      message: `Target "${host}" is outside your active Rules-of-Engagement scope allowlist (${scopeAllow.slice(0, 4).join(', ')}${scopeAllow.length > 4 ? '…' : ''}).`
    };
  }
  return { allowed: true, code: null, message: null };
}

export function normalizePrivacySettings(input = {}, base = DEFAULT_PRIVACY_SETTINGS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('Privacy settings must be an object.'), { code: 'INVALID_PRIVACY', status: 400 });
  }
  const allowed = new Set([...Object.keys(DEFAULT_PRIVACY_SETTINGS), 'applyProfile']);
  const boolKeys = new Set(['zdrRouting', 'strictZdr', 'localOnly', 'redactOutboundSecrets', 'ephemeralSession']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw Object.assign(new Error(`Unknown privacy setting: ${key}`), { code: 'INVALID_PRIVACY', status: 400 });
    }
    if (boolKeys.has(key) && typeof input[key] !== 'boolean') {
      throw Object.assign(new Error(`Privacy setting "${key}" must be a boolean.`), { code: 'INVALID_PRIVACY', status: 400 });
    }
  }
  let profileSeed = {};
  if (input.applyProfile !== undefined) {
    const pid = String(input.applyProfile || '').trim().toLowerCase();
    if (!Object.hasOwn(SECURITY_PROFILES, pid)) {
      throw Object.assign(new Error('Choose security profile: standard, hardened, or lockdown.'), { code: 'INVALID_PRIVACY', status: 400 });
    }
    const p = SECURITY_PROFILES[pid];
    profileSeed = {
      securityProfile: p.id,
      zdrRouting: p.zdrRouting,
      strictZdr: p.strictZdr,
      localOnly: p.localOnly,
      redactOutboundSecrets: p.redactOutboundSecrets,
      ephemeralSession: p.ephemeralSession,
    };
  }
  if (input.securityProfile !== undefined && !Object.hasOwn(SECURITY_PROFILES, input.securityProfile)) {
    throw Object.assign(new Error('Choose security profile: standard, hardened, or lockdown.'), { code: 'INVALID_PRIVACY', status: 400 });
  }
  const scopeAllow = normalizeScopePatterns(input.scopeAllow, 'scopeAllow') ?? [...(base.scopeAllow || [])];
  const scopeDeny = normalizeScopePatterns(input.scopeDeny, 'scopeDeny') ?? [...(base.scopeDeny || [])];
  const merged = {
    zdrRouting: input.zdrRouting ?? profileSeed.zdrRouting ?? base.zdrRouting ?? true,
    strictZdr: input.strictZdr ?? profileSeed.strictZdr ?? base.strictZdr ?? false,
    localOnly: input.localOnly ?? profileSeed.localOnly ?? base.localOnly ?? false,
    redactOutboundSecrets: input.redactOutboundSecrets ?? profileSeed.redactOutboundSecrets ?? base.redactOutboundSecrets ?? true,
    ephemeralSession: input.ephemeralSession ?? profileSeed.ephemeralSession ?? base.ephemeralSession ?? false,
    scopeAllow,
    scopeDeny,
  };
  // Strict ZDR always enforces ZDR request routing.
  if (merged.strictZdr) merged.zdrRouting = true;
  // Derive honest active security profile badge from effective settings
  const derivedProfile = (merged.localOnly && merged.strictZdr && merged.redactOutboundSecrets)
    ? 'lockdown'
    : (merged.strictZdr && merged.redactOutboundSecrets && (merged.ephemeralSession || scopeAllow.length > 0 || scopeDeny.length > 0))
      ? 'hardened'
      : 'standard';
  return {
    securityProfile: derivedProfile,
    ...merged,
  };
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

function isIpv4Loopback(host) {
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return Boolean(m && [m[1], m[2], m[3]].every(n => Number(n) <= 255));
}

export function extractHost(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') return '';
  try { return new URL(baseUrl).hostname.toLowerCase().replace(/\.+$/, ''); } catch { return ''; }
}

export function isLoopbackUrl(baseUrl) {
  const host = extractHost(baseUrl).replace(/^\[|\]$/g, '');
  return Boolean(host) && (LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost') || isIpv4Loopback(host));
}

export function isPrivateLanHost(rawHost) {
  const host = String(rawHost || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!host) return false;
  if (LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost') || isIpv4Loopback(host)) return true;
  if (host === 'host.docker.internal' || host === 'gateway.docker.internal' || host.endsWith('.local')) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b, c, d] = ipv4.slice(1).map(Number);
    if ([a, b, c, d].some(n => n > 255)) return false;
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (Docker bridges)
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (Tailscale / CGNAT)
  }
  if (/^(?:fc|fd)[0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host)) return true; // IPv6 ULA / link-local
  return false;
}

export function isPrivateLanUrl(baseUrl) {
  return isPrivateLanHost(extractHost(baseUrl));
}

/**
 * Honest classification of each provider's data-retention posture.
 * Never claims ZDR where retention depends on an external enterprise addendum or consumer plan.
 */
export function classifyProviderZdr(provider) {
  if (!provider || typeof provider !== 'object') {
    return { zdrClass: 'unknown', label: 'Unknown', detail: 'Provider retention posture unknown.', strictZdrEligible: false, localOnly: false };
  }
  if (provider.kind === 'scripted') {
    return { zdrClass: 'local-only', label: 'LOCAL ONLY', detail: 'In-process test double — zero network egress.', strictZdrEligible: true, localOnly: true, skipSecretRedaction: true };
  }
  if (['codex', 'claude', 'antigravity-cli', 'gemini-cli', 'copilot-cli', 'acp'].includes(provider.kind)) {
    return {
      zdrClass: 'provider-policy',
      label: 'CLI SUBSCRIPTION',
      detail: 'Uses your local CLI subscription login with vendor telemetry env vars disabled; retention follows your subscription terms.',
      strictZdrEligible: false,
      localOnly: false
    };
  }
  const host = extractHost(provider.baseUrl);
  if (isLoopbackUrl(provider.baseUrl)) {
    return {
      zdrClass: 'local-only',
      label: 'LOCAL ONLY',
      detail: 'On-device loopback inference — prompts and code never leave this machine.',
      strictZdrEligible: true,
      localOnly: true,
      skipSecretRedaction: true
    };
  }
  if (provider.tier === 'local' && isPrivateLanUrl(provider.baseUrl)) {
    return {
      zdrClass: 'local-lan',
      label: 'LOCAL LAN',
      detail: `Private network / Docker bridge inference (${host}) — zero public internet egress; outbound secret redaction remains active.`,
      strictZdrEligible: true,
      localOnly: true,
      skipSecretRedaction: false
    };
  }
  if (host === 'api.venice.ai' || host.endsWith('.venice.ai')) {
    return {
      zdrClass: 'native-zdr',
      label: 'NATIVE ZDR',
      detail: 'Venice zero-retention inference — prompts and responses are not stored server-side.',
      strictZdrEligible: true,
      localOnly: false
    };
  }
  if (host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) {
    return {
      zdrClass: 'zdr-enforced',
      label: 'ZDR ROUTED',
      detail: 'OpenRouter request routed with provider.zdr=true and data_collection="deny".',
      strictZdrEligible: true,
      localOnly: false
    };
  }
  if (host === 'api.openai.com') {
    return {
      zdrClass: 'no-store',
      label: 'NO STORE',
      detail: 'OpenAI API called with store=false (server storage disabled; standard API abuse-monitoring window may still apply unless ZDR addendum is active).',
      strictZdrEligible: false,
      localOnly: false
    };
  }
  if (host === 'api.anthropic.com' || host === 'generativelanguage.googleapis.com' || host === 'inference-api.nousresearch.com') {
    return {
      zdrClass: 'provider-policy',
      label: 'PROVIDER TERMS',
      detail: 'Direct API endpoint — retention governed by provider API terms (ZDR requires provider-side agreement).',
      strictZdrEligible: false,
      localOnly: false
    };
  }
  return {
    zdrClass: 'provider-policy',
    label: 'CUSTOM ENDPOINT',
    detail: `Remote endpoint (${host || 'unknown'}) — retention governed by endpoint operator.`,
    strictZdrEligible: false,
    localOnly: false
  };
}

export function checkProviderPrivacyAllowed(provider, privacy = DEFAULT_PRIVACY_SETTINGS) {
  const settings = normalizePrivacySettings(privacy);
  const posture = classifyProviderZdr(provider);
  if (settings.localOnly && !posture.localOnly) {
    return {
      allowed: false,
      code: 'PRIVACY_LOCAL_ONLY',
      posture,
      message: `Local-Only Airgap Mode is enabled. Blocked non-local provider "${provider?.label || provider?.id || 'unknown'}". Switch to a local loopback model (e.g. Ollama) or disable Local-Only Mode in Settings → Privacy.`
    };
  }
  if (settings.strictZdr && !posture.strictZdrEligible) {
    return {
      allowed: false,
      code: 'PRIVACY_STRICT_ZDR',
      posture,
      message: `Strict ZDR Gate is enabled. Blocked provider "${provider?.label || provider?.id || 'unknown'}" (${posture.label}). Use a Local, Venice (Native ZDR), or OpenRouter (ZDR-routed) model, or relax Strict ZDR in Settings → Privacy.`
    };
  }
  return { allowed: true, code: null, posture, message: null };
}

/**
 * Mutates an outbound HTTP provider request body in-place to apply ZDR flags
 * for supported providers without breaking non-supporting protocols.
 */
export function applyZdrRequestPolicy(provider, body, privacy = DEFAULT_PRIVACY_SETTINGS) {
  const settings = normalizePrivacySettings(privacy);
  const posture = classifyProviderZdr(provider);
  const host = extractHost(provider?.baseUrl);
  const zdrFlags = [];
  if (posture.localOnly) {
    zdrFlags.push('local-only:no-egress');
    return { posture, zdrFlags };
  }
  if (host === 'api.venice.ai' || host.endsWith('.venice.ai')) {
    zdrFlags.push('venice:native-zdr');
    return { posture, zdrFlags };
  }
  if (settings.zdrRouting && (host === 'openrouter.ai' || host.endsWith('.openrouter.ai'))) {
    const existing = body.provider && typeof body.provider === 'object' && !Array.isArray(body.provider) ? body.provider : {};
    body.provider = {
      ...existing,
      zdr: true,
      data_collection: 'deny',
      ...(settings.strictZdr ? { allow_fallbacks: false } : {})
    };
    zdrFlags.push('openrouter:zdr=true', 'openrouter:data_collection=deny');
    if (settings.strictZdr) zdrFlags.push('openrouter:allow_fallbacks=false');
    return { posture, zdrFlags };
  }
  if (settings.zdrRouting && (host === 'api.openai.com' || provider?.protocol === 'openai-responses')) {
    body.store = false;
    zdrFlags.push('openai:store=false');
    return { posture, zdrFlags };
  }
  if (provider?.protocol === 'openai-responses') {
    body.store = false;
    zdrFlags.push('openai-responses:store=false');
  }
  return { posture, zdrFlags };
}

// High-confidence secret patterns scrubbed from outbound cloud prompts when redactOutboundSecrets is enabled.
const OUTBOUND_SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]{16,8192}?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}(?![A-Za-z0-9._~+\/=-])/g,
  /\bsk-proj-[A-Za-z0-9_-]{16,}(?![A-Za-z0-9._~+\/=-])/g,
  /\bsk-or-v1-[A-Za-z0-9_-]{16,}(?![A-Za-z0-9._~+\/=-])/g,
  /\bsk-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9._~+\/=-])/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat|hf)_[A-Za-z0-9_]{16,}(?![A-Za-z0-9._~+\/=-])/g,
  /\bAIza[0-9A-Za-z_-]{30,}(?![A-Za-z0-9._~+\/=-])/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/g,
  /\b(?:xoxb|xoxp|xoxa|xoxr)-[0-9A-Za-z-]{16,}(?![A-Za-z0-9._~+\/=-])/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/=-]{24,}(?![A-Za-z0-9._~+\/=-])/gi,
  /\bBasic\s+[A-Za-z0-9+\/]{16,}={0,2}(?![A-Za-z0-9+\/=])/gi,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps|https?):\/\/[^\/\s:@]{1,64}:[^\/\s@]{6,}@/gi
];

export function redactOutboundText(text, extraSecrets = []) {
  if (typeof text !== 'string' || !text) return { text: text || '', count: 0 };
  let out = text;
  let count = 0;
  const sortedSecrets = Array.isArray(extraSecrets)
    ? [...new Set(extraSecrets.filter(s => typeof s === 'string' && s.length >= 8))].sort((a, b) => b.length - a.length)
    : [];
  for (const secret of sortedSecrets) {
    if (out.includes(secret)) {
      const parts = out.split(secret);
      count += parts.length - 1;
      out = parts.join('[redacted secret]');
    }
  }
  for (const regex of OUTBOUND_SECRET_PATTERNS) {
    out = out.replace(regex, () => {
      count += 1;
      return '[redacted secret]';
    });
  }
  return { text: out, count };
}

// Shared by patch previews and dispatch so the reviewed body is the body sent.
export function prepareOutboundRequest(provider, body, opts = {}) {
  const privacy = opts.privacy || DEFAULT_PRIVACY_SETTINGS;
  const gate = checkProviderPrivacyAllowed(provider, privacy);
  const entry = { providerId: provider.id, host: extractHost(provider.baseUrl), protocol: provider.protocol,
    zdrClass: gate.posture.zdrClass, zdrFlags: [], secretsRedacted: 0, blocked: !gate.allowed };
  if (!gate.allowed) {
    opts.onOutbound?.({ ...entry, reason: gate.message });
    throw Object.assign(new Error(gate.message), { code: gate.code });
  }
  const cleaned = !gate.posture.skipSecretRedaction && privacy.redactOutboundSecrets !== false
    ? redactOutboundValue(body, opts.extraSecrets || environmentSecrets()) : { value: structuredClone(body), count: 0 };
  const outgoing = cleaned.value;
  entry.secretsRedacted = cleaned.count;
  entry.zdrFlags = applyZdrRequestPolicy(provider, outgoing, privacy).zdrFlags;
  opts.onOutbound?.(entry);
  return outgoing;
}

export function redactOutboundValue(value, secrets = environmentSecrets()) {
  let count = 0;
  const seen = new WeakSet();
  function walk(item) {
    if (typeof item === 'string') { const result = redactOutboundText(item, secrets); count += result.count; return result.text; }
    if (item && typeof item === 'object') {
      if (seen.has(item)) return '[circular]';
      seen.add(item);
      if (Array.isArray(item)) return item.map(walk);
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, walk(child)]));
    }
    return item;
  }
  return { value: walk(value), count };
}

/**
 * In-memory-only ring buffer of outbound inference calls for full local transparency.
 * Never persisted to disk and never transmitted anywhere.
 */
export class OutboundAuditLog {
  constructor({ maxEntries = 100 } = {}) {
    this.maxEntries = maxEntries;
    this.entries = [];
  }
  record(entry = {}) {
    const item = {
      id: randomUUID(),
      time: new Date().toISOString(),
      providerId: String(entry.providerId || 'unknown'),
      host: String(entry.host || 'local'),
      protocol: String(entry.protocol || 'unknown'),
      zdrClass: String(entry.zdrClass || 'unknown'),
      zdrFlags: Array.isArray(entry.zdrFlags) ? [...entry.zdrFlags] : [],
      secretsRedacted: Number(entry.secretsRedacted || 0),
      blocked: Boolean(entry.blocked),
      reason: entry.reason ? String(entry.reason).slice(0, 240) : null
    };
    this.entries.push(item);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    return item;
  }
  list() { return [...this.entries].reverse(); }
  clear() { this.entries = []; }
}

// Best-effort diagnostic export redaction. Raw local task history remains owner
// data; this deliberately makes no claim that arbitrary source is secret-free.
export const environmentSecrets = () => Object.entries(process.env)
  .filter(([key, text]) => (/(?:KEY|TOKEN|PASSWORD|SECRET|PAT)(?:_[A-Z0-9]+)?$/i.test(key) || /^(?:DATABASE|REDIS|MONGODB|POSTGRES|AMQP)_URL$/i.test(key)) && typeof text === 'string' && text.length >= 8)
  .map(([, text]) => text);
export function redactDiagnostics(value, secrets = environmentSecrets(), seen = new WeakSet()) {
  const sorted = Array.isArray(secrets) ? [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length) : [];
  const redact = text => {
    let result = text;
    for (const secret of sorted) result = result.split(secret).join('[redacted credential]');
    return result.replace(/\b(?:sk[-_]|(?:ghp|github_pat|hf)_)[A-Za-z0-9_-]{12,}(?![A-Za-z0-9._~+\/=-])/g, '[redacted credential]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/=-]{12,}/gi, 'Bearer [redacted credential]');
  };
  if (typeof value === 'string') return redact(value);
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.map(item => redactDiagnostics(item, sorted, seen));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(?:api[_-]?key|access[_-]?token|authorization|password|secret)$/i.test(key) ? '[redacted credential]' : redactDiagnostics(item, sorted, seen)]));
  }
  return value;
}
