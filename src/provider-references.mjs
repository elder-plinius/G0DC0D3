import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { HttpProvider } from './providers.mjs';

const profiles = Object.freeze({
  venice: { endpoint: 'https://api.venice.ai/api/v1', keyName: 'VENICE_API_KEY', label: 'Venice' },
  openrouter: { endpoint: 'https://openrouter.ai/api/v1', keyName: 'OPENROUTER_API_KEY', label: 'OpenRouter' }
});
const invalid = () => new Error('Provider reference could not be configured.');
const object = value => value && typeof value === 'object' && !Array.isArray(value);

async function privateFile(filename, limit, exactMode) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || filename.includes('\0') || typeof process.getuid !== 'function') throw invalid();
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.uid !== process.getuid() || (before.mode & 0o077) !== 0 || (exactMode && (before.mode & 0o777) !== exactMode) || before.size > limit) throw invalid();
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const after = await handle.stat();
    if (size > limit || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.mode !== after.mode || before.uid !== after.uid) throw invalid();
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
  } finally { await handle.close(); }
}

// Read one literal credential assignment, never source a file or interpolate it.
// Only single-line dotenv tokens are supported. Duplicate, multiline, escaped
// or shell-expression values fail closed; unrelated variables are not loaded.
function credentialValue(source, keyName) {
  const assignment = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${keyName}[ \\t]*=[ \\t]*(.*)$`);
  const entries = source.split(/\r?\n/).map(line => assignment.exec(line)).filter(Boolean);
  if (entries.length !== 1) throw invalid();
  const raw = entries[0][1];
  const match = /^(?:"([A-Za-z0-9._~+\/=\-]{8,4096})"|'([A-Za-z0-9._~+\/=\-]{8,4096})'|([A-Za-z0-9._~+\/=\-]{8,4096}))[ \t]*(?:#.*)?$/.exec(raw);
  if (!match) throw invalid();
  return match[1] || match[2] || match[3];
}

function referenceProvider(profile, definition, key) {
  try {
    const provider = new HttpProvider({ id: profile.id, label: `${definition.label} · ${profile.model}`, protocol: 'openai-chat', baseUrl: definition.endpoint, model: profile.model, credential: key, timeoutMs: 180000, maxOutputTokens: 16000, maxOutputTokensCeiling: 64000 });
    const turn = provider.turn.bind(provider), close = provider.close.bind(provider);
    provider.turn = async (context, options) => {
      if (provider.closed) return { type: 'error', code: 'provider_configuration', message: 'Referenced provider is closed.', retryable: false };
      const redactionKey = key;
      try {
        // Also protect successful provider output before the runtime records it.
        return JSON.parse(JSON.stringify(await turn(context, options)).split(redactionKey).join('[redacted credential]'));
      } catch (cause) {
        const error = new Error('Referenced provider request failed.');
        error.code = ['tool_protocol', 'provider_configuration', 'cancelled'].includes(cause?.code) ? cause.code : 'PROVIDER_ERROR';
        if (['TimeoutError', 'AbortError'].includes(cause?.name)) error.name = cause.name;
        if (typeof cause?.retryable === 'boolean') error.retryable = cause.retryable;
        throw error;
      }
    };
    provider.close = () => { close(); key = null; };
    return provider;
  } catch { throw invalid(); }
}

/** Startup-only, owner-managed references. No API accepts reference paths.
 * Reads dataDir/provider-references.json (0600) and adds valid profiles to Map.
 * Returns counts only; credentials, reference paths and parser errors are never
 * returned, persisted or placed in task/model/browser state.
 */
export async function loadProviderReferences({ dataDir, providers }) {
  if (typeof dataDir !== 'string' || !(providers instanceof Map)) throw invalid();
  const result = { configured: 0, failed: 0 };
  let config;
  try {
    config = JSON.parse(await privateFile(path.join(path.resolve(dataDir), 'provider-references.json'), 32 * 1024, 0o600));
    if (!object(config) || config.version !== 1 || Object.keys(config).some(key => !['version', 'profiles'].includes(key)) || !Array.isArray(config.profiles) || config.profiles.length > 10) throw invalid();
  } catch (cause) { if (cause.code !== 'ENOENT') result.failed = 1; return result; }
  for (const profile of config.profiles) {
    try {
      if (!object(profile) || Object.keys(profile).some(key => !['id', 'provider', 'model', 'credential'].includes(key))
        || typeof profile.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,79}$/.test(profile.id) || providers.has(profile.id)
        || !Object.hasOwn(profiles, profile.provider) || typeof profile.model !== 'string' || !/^[a-zA-Z0-9~][a-zA-Z0-9:._/+~\-]{0,159}$/.test(profile.model)
        || !object(profile.credential) || Object.keys(profile.credential).some(key => !['file', 'keyName'].includes(key))) throw invalid();
      const definition = profiles[profile.provider];
      if (profile.credential.keyName !== definition.keyName) throw invalid();
      const source = await privateFile(profile.credential.file, 256 * 1024);
      const key = credentialValue(source, definition.keyName);
      providers.set(profile.id, referenceProvider(profile, definition, key));
      result.configured++;
    } catch { result.failed++; }
  }
  return result;
}
