import { promises as fs, constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  CodexProvider,
  ClaudeCodeProvider,
  GeminiCliProvider,
  CopilotCliProvider,
  claudeSubscriptionEnvironment,
  geminiSubscriptionEnvironment,
  copilotSubscriptionEnvironment,
  cliEnvironment,
  normalizeCliSettings
} from './providers.mjs';

const DEFINITIONS = Object.freeze({
  'claude-code': {
    name: 'Claude Code',
    subscription: 'Claude Pro / Max / Team',
    env: 'G0D_CLAUDE_BINARY',
    modelEnv: 'G0D_CLAUDE_MODEL',
    args: ['auth', 'status', '--json'],
    loginHint: 'Run "claude auth login" in your terminal, then refresh.',
    suggestedModels: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'opus', 'sonnet', 'haiku'],
    defaultModels: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    Provider: ClaudeCodeProvider
  },
  'codex-cli': {
    name: 'Codex',
    subscription: 'ChatGPT Plus / Pro / Team',
    env: 'G0D_CODEX_BINARY',
    modelEnv: 'G0D_CODEX_MODEL',
    args: ['login', 'status'],
    loginHint: 'Run "codex login" in your terminal, then refresh.',
    suggestedModels: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2-codex', 'o3', 'o4-mini'],
    defaultModels: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2-codex', 'o3', 'o4-mini'],
    Provider: CodexProvider
  },
  'gemini-cli': {
    name: 'Gemini CLI',
    subscription: 'Google AI Pro / Ultra / Code Assist',
    env: 'G0D_GEMINI_BINARY',
    modelEnv: 'G0D_GEMINI_MODEL',
    args: ['--version'],
    loginHint: 'Run "gemini" in your terminal and sign in with Google, then refresh.',
    suggestedModels: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3-pro-preview'],
    defaultModels: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3-pro-preview'],
    Provider: GeminiCliProvider
  },
  'copilot-cli': {
    name: 'GitHub Copilot',
    subscription: 'GitHub Copilot Pro / Pro+ / Business',
    env: 'G0D_COPILOT_BINARY',
    modelEnv: 'G0D_COPILOT_MODEL',
    args: ['--version'],
    loginHint: 'Run "copilot login" (or "gh auth login") in your terminal, then refresh.',
    suggestedModels: ['claude-opus-4.6', 'claude-sonnet-4.6', 'gpt-5.4', 'gpt-5.3-codex', 'gemini-2.5-pro'],
    defaultModels: ['claude-opus-4.6', 'claude-sonnet-4.6', 'gpt-5.4', 'gpt-5.3-codex', 'gemini-2.5-pro'],
    Provider: CopilotCliProvider
  }
});

export const CLI_INFERENCE_CONSENT = Object.freeze({
  version: 1,
  scope: 'inference',
  title: 'Use your existing CLI login',
  disclosures: [
    'Your prompts and supplied task context, including file contents, go through the CLI to its provider.',
    'Requests use your existing account. Provider terms, retention policies, usage limits, and any charges apply.',
    'G0DM0D3 does not copy your login credentials. The CLI manages authentication.',
    'Adding a model grants no workspace command permissions or command network access. Those are controlled per workspace.',
    'Discovery and connection send no model prompts. Disconnect at any time in Settings → Models.'
  ]
});

const fault = (message, code = 'provider_configuration', status = 400) => Object.assign(new Error(message), { code, status, retryable: false });
const validModel = model => model === null || model === '' || (typeof model === 'string' && model.length <= 200 && /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$/.test(model));
const MAX_CLI_MODELS = 32;

function normalizeModelList(rawModels, fallbackModels = []) {
  if (!Array.isArray(rawModels)) return [...fallbackModels];
  const seen = new Set();
  const out = [];
  for (const raw of rawModels) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed || !validModel(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= MAX_CLI_MODELS) break;
  }
  return out;
}

function modelProviderId(subscriptionId, model) {
  return `${subscriptionId}:${String(model).replaceAll('/', '-')}`;
}

function candidates(id, env, home) {
  const override = env[DEFINITIONS[id].env];
  // A launcher environment is trusted configuration; browser requests cannot supply a path.
  if (override && path.isAbsolute(override)) return [override];
  if (id === 'codex-cli') return [
    '/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/opt/homebrew/bin/codex', '/usr/local/bin/codex', path.join(home, '.local/bin/codex')
  ];
  if (id === 'claude-code') return [
    '/opt/homebrew/bin/claude', '/usr/local/bin/claude', path.join(home, '.local/bin/claude'), path.join(home, '.claude/local/claude')
  ];
  if (id === 'gemini-cli') return [
    '/opt/homebrew/bin/gemini', '/usr/local/bin/gemini', path.join(home, '.local/bin/gemini'), path.join(home, '.npm-global/bin/gemini'), '/usr/bin/gemini'
  ];
  return [
    '/opt/homebrew/bin/copilot', '/usr/local/bin/copilot', path.join(home, '.local/bin/copilot'), path.join(home, '.npm-global/bin/copilot'), '/usr/bin/copilot'
  ];
}
function codexEnvironment(env) { return cliEnvironment(env); }
async function discover(id, env, home) {
  for (const binary of candidates(id, env, home)) {
    try { if (!(await fs.stat(binary)).isFile()) continue; await fs.access(binary, constants.X_OK); return binary; } catch {}
  }
  return null;
}
async function hasNonEmptyFile(filePath) {
  try { const st = await fs.stat(filePath); return st.isFile() && st.size > 2; } catch { return false; }
}
export async function readLocalCodexConfig(env, home) {
  // Non-destructive read of top-level model & reasoning defaults from ~/.codex/config.toml (never reads auth.json or tokens).
  const codexHome = env.CODEX_HOME && path.isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : path.join(home, '.codex');
  const cfgPath = path.join(codexHome, 'config.toml');
  try {
    const handle = await fs.open(cfgPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const st = await handle.stat();
      if (!st.isFile() || st.size > 16384) return null;
      const text = await handle.readFile('utf8');
      const topLines = [];
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith('[')) break; // Stop at first TOML section header
        topLines.push(trimmed);
      }
      const top = topLines.join('\n');
      const mModel = /^model\s*=\s*["']([^"'\n]+)["']/m.exec(top);
      const mEffort = /^model_reasoning_effort\s*=\s*["']([^"'\n]+)["']/m.exec(top);
      const mTier = /^service_tier\s*=\s*["']([^"'\n]+)["']/m.exec(top);
      const model = mModel && validModel(mModel[1].trim()) ? mModel[1].trim() : null;
      const reasoningEffort = mEffort && ['low', 'medium', 'high', 'xhigh'].includes(mEffort[1].trim()) ? mEffort[1].trim() : null;
      const serviceTier = mTier && ['fast', 'flex'].includes(mTier[1].trim()) ? mTier[1].trim() : null;
      if (!model && !reasoningEffort && !serviceTier) return null;
      return { model, reasoningEffort, serviceTier };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
async function probeGeminiAuth(env, home) {
  const configDir = env.GEMINI_CONFIG_DIR && path.isAbsolute(env.GEMINI_CONFIG_DIR) ? env.GEMINI_CONFIG_DIR : path.join(home, '.gemini');
  // Non-destructive presence check only — never reads or copies OAuth credentials.
  for (const name of ['oauth_creds.json', 'google_accounts.json']) {
    if (await hasNonEmptyFile(path.join(configDir, name))) return true;
  }
  return false;
}
async function probeCopilotAuth(env, home) {
  const ghConfigDir = env.GH_CONFIG_DIR && path.isAbsolute(env.GH_CONFIG_DIR)
    ? env.GH_CONFIG_DIR
    : path.join(env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, '.config'), 'gh');
  const copilotDir = env.COPILOT_CONFIG_DIR && path.isAbsolute(env.COPILOT_CONFIG_DIR) ? env.COPILOT_CONFIG_DIR : path.join(home, '.copilot');
  if (await hasNonEmptyFile(path.join(copilotDir, 'config.json')) || await hasNonEmptyFile(path.join(ghConfigDir, 'hosts.yml'))) return true;
  return false;
}
function probe(binary, args, env, timeoutMs) {
  return new Promise(resolve => {
    const child = spawn(binary, args, { cwd: tmpdir(), env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const outChunks = [], errChunks = [];
    let bytes = 0, timedOut = false, failed = false, closed = false, terminating = false, killTimer;
    const kill = () => {
      if (closed || terminating || !Number.isInteger(child.pid)) return;
      terminating = true;
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch {}
      killTimer = setTimeout(() => { try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {} }, 100);
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const collect = bucket => chunk => { bytes += chunk.byteLength; if (bytes > 65536) { failed = true; kill(); return; } bucket.push(chunk); };
    child.stdout.on('data', collect(outChunks)); child.stderr.on('data', collect(errChunks));
    child.on('error', () => { failed = true; });
    child.on('close', code => {
      closed = true; clearTimeout(timer); clearTimeout(killTimer);
      const stdout = failed || timedOut ? '' : Buffer.concat(outChunks).toString('utf8');
      const stderr = failed || timedOut ? '' : Buffer.concat(errChunks).toString('utf8');
      resolve({ code: failed || timedOut ? -1 : code, stdout, stderr, output: stdout + stderr, timedOut });
    });
  });
}

/** Only local login probes run here. No inference, login flow, token read or credential copying. */
export async function createCliConnections({ dataDir, providers, environment = process.env, home = homedir(), probeTimeoutMs = 5000 } = {}) {
  if (!dataDir || !(providers instanceof Map)) throw new TypeError('CLI connections require a data directory and provider Map');
  const filename = path.join(path.resolve(dataDir), 'cli-connections.json');
  let preferences = {}, preferenceError = false, cache = null, refreshing = null, writeQueue = Promise.resolve();
  let localDefaultsMap = {};
  try {
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 32768) throw new Error();
      const saved = JSON.parse(await handle.readFile('utf8'));
      if (saved.version !== 1 || !saved.connections || typeof saved.connections !== 'object' || Array.isArray(saved.connections)) throw new Error();
      for (const [id, value] of Object.entries(saved.connections)) {
        if (!Object.hasOwn(DEFINITIONS, id) || !value || Object.keys(value).some(key => !['enabled', 'model', 'models', 'settings', 'consent'].includes(key)) || typeof value.enabled !== 'boolean' || !validModel(value.model)) throw new Error();
        if (value.consent && (value.consent.version !== CLI_INFERENCE_CONSENT.version || value.consent.scope !== 'inference' || !Number.isFinite(Date.parse(value.consent.acceptedAt)))) throw new Error();
        const models = Array.isArray(value.models) ? normalizeModelList(value.models) : undefined;
        const settings = value.settings && typeof value.settings === 'object' ? normalizeCliSettings(id, value.settings) : normalizeCliSettings(id, {});
        preferences[id] = {
          enabled: value.enabled,
          model: value.model,
          ...(models !== undefined ? { models } : {}),
          settings,
          ...(value.consent ? { consent: { version: value.consent.version, scope: 'inference', acceptedAt: value.consent.acceptedAt } } : {})
        };
      }
    } finally { await handle.close(); }
  } catch (error) { if (error.code !== 'ENOENT') { preferences = {}; preferenceError = true; } }

  const ownedProviderKeys = (id) => {
    const keys = [];
    for (const key of providers.keys()) {
      if (key === id || key.startsWith(`${id}:`)) keys.push(key);
    }
    return keys;
  };

  const makeProvider = (subscriptionId, binary, model, cliSettings, providerId = subscriptionId) => {
    const def = DEFINITIONS[subscriptionId];
    const Provider = def.Provider;
    const env = subscriptionId === 'claude-code'
      ? claudeSubscriptionEnvironment(environment)
      : subscriptionId === 'gemini-cli'
        ? geminiSubscriptionEnvironment(environment)
        : subscriptionId === 'copilot-cli'
          ? copilotSubscriptionEnvironment(environment)
          : codexEnvironment(environment);
    return new Provider({
      id: providerId,
      subscriptionId,
      binary,
      model: model || undefined,
      cliSettings: normalizeCliSettings(subscriptionId, cliSettings),
      label: `${def.name} · ${model || 'CLI default'}`,
      environment: env
    });
  };

  const resolveEnabledModels = (id, pref) => {
    const def = DEFINITIONS[id];
    const localModel = localDefaultsMap[id]?.model || null;
    if (Array.isArray(pref?.models)) {
      return normalizeModelList(pref.models);
    }
    const base = [...(def.defaultModels || def.suggestedModels || [])];
    if (localModel && !base.includes(localModel)) base.unshift(localModel);
    if (pref?.model && !base.includes(pref.model)) base.unshift(pref.model);
    return base;
  };

  const installSubscriptionProviders = async (id, binary, { primaryModel, models, settings, available = true }) => {
    const prevKeys = ownedProviderKeys(id);
    for (const key of prevKeys) {
      const prev = providers.get(key);
      if (prev?.children?.size) throw fault('Wait for the active CLI request before changing its models or settings.', 'PROVIDER_BUSY', 409);
    }
    for (const key of prevKeys) {
      const prev = providers.get(key);
      if (prev) await prev.close?.();
      providers.delete(key);
    }
    // Primary slot preserves exact backwards compatibility with `codex-cli` / `claude-code` IDs
    const primary = makeProvider(id, binary, primaryModel || null, settings, id);
    primary.available = available;
    providers.set(id, primary);
    // Register every enabled subscription model as a first-class selectable provider!
    const cleanModels = normalizeModelList(models);
    for (const m of cleanModels) {
      const pid = modelProviderId(id, m);
      if (pid === id || providers.has(pid)) continue;
      const inst = makeProvider(id, binary, m, settings, pid);
      inst.available = available;
      providers.set(pid, inst);
    }
  };

  const refresh = async () => {
    if (refreshing) return refreshing;
    refreshing = Promise.all(Object.entries(DEFINITIONS).map(async ([id, definition]) => {
      const kindForId = id === 'codex-cli' ? 'codex' : id === 'claude-code' ? 'claude' : id;
      const setAvailableForKind = value => {
        for (const p of providers.values()) {
          if (p && (p.id === id || p.subscriptionId === id || p.kind === kindForId)) p.available = value;
        }
      };
      if (id === 'codex-cli') {
        const localCfg = await readLocalCodexConfig(environment, home);
        if (localCfg) localDefaultsMap[id] = localCfg;
      }
      const binary = await discover(id, environment, home);
      if (!binary) { setAvailableForKind(false); return { id, binary: null, installed: false, authenticated: false, detail: `CLI not installed. ${definition.loginHint}` }; }
      const env = id === 'claude-code' ? claudeSubscriptionEnvironment(environment) : id === 'gemini-cli' ? geminiSubscriptionEnvironment(environment) : id === 'copilot-cli' ? copilotSubscriptionEnvironment(environment) : codexEnvironment(environment);
      const result = await probe(binary, definition.args, env, probeTimeoutMs);
      let authenticated = false, signInDetected = false;
      if (result.code === 0) {
        if (id === 'codex-cli') authenticated = /logged in.*chatgpt/i.test(result.output);
        else if (id === 'claude-code') {
          try { const status = JSON.parse(result.stdout.trim()); authenticated = status.loggedIn === true && ['claude.ai', 'oauth_token'].includes(status.authMethod); }
          catch { authenticated = false; }
        } else if (id === 'gemini-cli') {
          signInDetected = await probeGeminiAuth(environment, home);
        } else if (id === 'copilot-cli') {
          signInDetected = await probeCopilotAuth(environment, home);
        }
      }
      setAvailableForKind(authenticated || signInDetected);
      return {
        id, binary, installed: true, authenticated, signInDetected,
        detail: authenticated ? 'The CLI reports an existing subscription login.' : signInDetected ? 'Local sign-in configuration found. Account access is not verified until a request succeeds.' : result.timedOut ? 'Login check timed out. Try again.' : definition.loginHint
      };
    })).then(value => { cache = value; return value; }).finally(() => { refreshing = null; });
    return refreshing;
  };

  const publicStatus = () => ({
    consent: CLI_INFERENCE_CONSENT,
    connections: (cache || []).map(({ id, installed, authenticated, signInDetected = false, detail }) => {
      const configured = providers.get(id), enabled = Boolean(configured), def = DEFINITIONS[id];
      const pref = preferences[id] || {};
      const localDef = localDefaultsMap[id] || null;
      const enabledModels = resolveEnabledModels(id, pref);
      const availableModels = [...new Set([
        ...(localDef?.model ? [localDef.model] : []),
        ...(def.suggestedModels || []),
        ...enabledModels,
        ...(pref.model ? [pref.model] : [])
      ])];
      const registeredIds = ownedProviderKeys(id);
      return {
        id,
        name: def.name,
        subscription: def.subscription,
        installed,
        authenticated,
        signInDetected,
        enabled,
        ready: installed && (authenticated || signInDetected),
        authorization: pref.consent || (enabled ? { scope: 'inference', source: pref.enabled ? 'previous-opt-in' : 'launch-configuration' } : null),
        model: configured?.model || pref.model || null,
        models: enabledModels,
        availableModels,
        suggestedModels: availableModels,
        settings: normalizeCliSettings(id, configured?.cliSettings || pref.settings || {}),
        localDefaults: localDef,
        registeredIds,
        loginHint: def.loginHint,
        detail
      };
    }),
    ...(preferenceError ? { preferenceError: 'Saved CLI preferences could not be read. Reconnect to save them again.' } : {})
  });

  const save = async next => {
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = filename + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, connections: next }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, filename);
    } finally { await fs.rm(temporary, { force: true }); }
  };

  // Pre-read local Codex config (non-destructive) before restoring persisted connections
  const initialCodexCfg = await readLocalCodexConfig(environment, home);
  if (initialCodexCfg) localDefaultsMap['codex-cli'] = initialCodexCfg;

  // Restoring an explicit persisted opt-in never creates a model request.
  for (const [id, pref] of Object.entries(preferences)) if (pref.enabled && !providers.has(id)) {
    const binary = await discover(id, environment, home);
    if (binary) {
      await installSubscriptionProviders(id, binary, {
        primaryModel: pref.model || null,
        models: resolveEnabledModels(id, pref),
        settings: pref.settings || {},
        available: false
      });
    }
  }
  if (Object.values(preferences).some(pref => pref.enabled)) await refresh();

  return {
    async status({ refresh: force = false } = {}) { if (!cache || force) await refresh(); return publicStatus(); },
    connect(input) {
      const work = async () => {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['id', 'model', 'models', 'settings', 'consentVersion'].includes(key)) || !Object.hasOwn(DEFINITIONS, input.id)) {
          throw fault(`Choose one of: ${Object.keys(DEFINITIONS).join(', ')}.`);
        }
        if (input.consentVersion !== CLI_INFERENCE_CONSENT.version) {
          throw fault('Review and accept the inference connection disclosure before adding this CLI.', 'CONSENT_REQUIRED', 409);
        }
        const id = input.id;
        const rawModel = input.model === undefined ? (preferences[id]?.model || environment[DEFINITIONS[id].modelEnv] || null) : input.model;
        if (!validModel(rawModel)) throw fault('Model must be a model identifier, or blank for the CLI default.');
        const model = rawModel === '' ? null : rawModel;
        if (input.models !== undefined && (!Array.isArray(input.models) || input.models.some(m => typeof m !== 'string' || !validModel(m.trim())))) {
          throw fault('Models must be an array of valid model identifiers.');
        }
        await refresh();
        const found = cache.find(value => value.id === id);
        if (!found.installed || !(found.authenticated || found.signInDetected)) throw fault(found.detail, 'authentication', 409);
        const models = input.models !== undefined
          ? normalizeModelList(input.models)
          : resolveEnabledModels(id, { ...preferences[id], model });
        if (model && !models.includes(model)) models.unshift(model);
        const localSeed = (!preferences[id]?.enabled && localDefaultsMap[id])
          ? {
              ...(localDefaultsMap[id].reasoningEffort ? { reasoningEffort: localDefaultsMap[id].reasoningEffort } : {}),
              ...(localDefaultsMap[id].serviceTier ? { serviceTier: localDefaultsMap[id].serviceTier } : {}),
            }
          : {};
        const settings = normalizeCliSettings(
          id,
          input.settings !== undefined
            ? { ...(preferences[id]?.settings || localSeed), ...input.settings }
            : (preferences[id]?.enabled ? (preferences[id]?.settings || {}) : { ...localSeed, ...(preferences[id]?.settings || {}) })
        );
        const next = {
          ...preferences,
          [id]: {
            enabled: true,
            model,
            models,
            settings,
            consent: { version: CLI_INFERENCE_CONSENT.version, scope: 'inference', acceptedAt: new Date().toISOString() }
          }
        };
        await installSubscriptionProviders(id, found.binary, { primaryModel: model, models, settings, available: true });
        await save(next);
        preferences = next; preferenceError = false;
        return { providerId: id, registered: ownedProviderKeys(id), ...publicStatus() };
      };
      const result = writeQueue.then(work); writeQueue = result.catch(() => {}); return result;
    },
    updateSettings(input) {
      const work = async () => {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['id', 'model', 'models', 'settings'].includes(key)) || !Object.hasOwn(DEFINITIONS, input.id)) {
          throw fault(`Choose one of: ${Object.keys(DEFINITIONS).join(', ')}.`);
        }
        const id = input.id;
        const cur = preferences[id];
        if (!cur?.enabled && !providers.has(id)) {
          throw fault(`Connect ${DEFINITIONS[id].name} before updating its models or settings.`, 'NOT_CONNECTED', 409);
        }
        const rawModel = input.model === undefined ? (cur?.model ?? providers.get(id)?.model ?? null) : input.model;
        if (!validModel(rawModel)) throw fault('Model must be a model identifier, or blank for the CLI default.');
        const model = rawModel === '' ? null : rawModel;
        if (input.models !== undefined && (!Array.isArray(input.models) || input.models.some(m => typeof m !== 'string' || !validModel(m.trim())))) {
          throw fault('Models must be an array of valid model identifiers.');
        }
        const models = input.models !== undefined ? normalizeModelList(input.models) : resolveEnabledModels(id, cur);
        const settings = normalizeCliSettings(id, input.settings !== undefined ? { ...(cur?.settings || {}), ...input.settings } : (cur?.settings || {}));
        await refresh();
        const found = cache.find(value => value.id === id);
        if (!found?.installed || !(found.authenticated || found.signInDetected)) {
          throw fault(found?.detail || DEFINITIONS[id].loginHint, 'authentication', 409);
        }
        const next = {
          ...preferences,
          [id]: {
            ...(cur || {}),
            enabled: true,
            model,
            models,
            settings
          }
        };
        await installSubscriptionProviders(id, found.binary, { primaryModel: model, models, settings, available: true });
        await save(next);
        preferences = next; preferenceError = false;
        return { providerId: id, registered: ownedProviderKeys(id), ...publicStatus() };
      };
      const result = writeQueue.then(work); writeQueue = result.catch(() => {}); return result;
    },
    disconnect(input) {
      const work = async () => {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'id') || !Object.hasOwn(DEFINITIONS, input.id)) {
          throw fault(`Choose one of: ${Object.keys(DEFINITIONS).join(', ')}.`);
        }
        const id = input.id;
        const keys = ownedProviderKeys(id);
        for (const key of keys) {
          const prev = providers.get(key);
          if (prev?.children?.size) throw fault('Wait for the active CLI request before disconnecting.', 'PROVIDER_BUSY', 409);
        }
        const next = {
          ...preferences,
          [id]: { ...preferences[id], enabled: false, model: preferences[id]?.model || null }
        };
        await save(next);
        for (const key of keys) {
          const prev = providers.get(key);
          if (prev) await prev.close?.();
          providers.delete(key);
        }
        preferences = next; preferenceError = false;
        return { disconnected: id, ...publicStatus() };
      };
      const result = writeQueue.then(work); writeQueue = result.catch(() => {}); return result;
    }
  };
}
