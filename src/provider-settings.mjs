import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { HttpProvider } from './providers.mjs';

const profiles = {
  venice: { label: 'Venice', protocol: 'openai-chat', endpoint: 'https://api.venice.ai/api/v1', apiKeyEnv: 'VENICE_API_KEY', defaults: ['venice-uncensored-1-2'] },
  openrouter: {
    label: 'OpenRouter',
    protocol: 'openai-chat',
    endpoint: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    defaults: [
      'nousresearch/hermes-4-405b',
      'anthropic/claude-sonnet-5.5',
      'anthropic/claude-opus-4.6',
      'openai/gpt-6.2-astra',
      'openai/gpt-5.4',
      'google/gemini-4-neon',
      'deepseek/deepseek-v4.1-flash',
      'z-ai/glm-5.3-flash',
      'qwen/qwen3.8-max-prime',
      'qwen/qwen3-coder',
      'moonshotai/kimi-k3.1-pro',
      'x-ai/grok-4.7',
    ],
  },
  anthropic: { label: 'Anthropic', protocol: 'anthropic', endpoint: 'https://api.anthropic.com/v1', apiKeyEnv: 'ANTHROPIC_API_KEY', defaults: ['claude-sonnet-4-6', 'claude-opus-4-6'] },
  openai: { label: 'OpenAI', protocol: 'openai-responses', endpoint: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', defaults: ['gpt-5.4', 'o3'] },
  gemini: { label: 'Gemini API', protocol: 'openai-chat', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKeyEnv: 'GEMINI_API_KEY', defaults: ['gemini-2.5-pro', 'gemini-2.5-flash'] },
  nous: { label: 'Nous Portal', protocol: 'openai-chat', endpoint: 'https://inference-api.nousresearch.com/v1', apiKeyEnv: 'NOUS_API_KEY', defaults: ['Hermes-4-405B', 'Hermes-4-70B'] },
};

export function nativeKeychain(executable, dataDir) {
  if (process.platform !== 'darwin' || !path.isAbsolute(executable)) throw new Error('Invalid native Keychain helper.');
  const scope = createHash('sha256').update(path.resolve(dataDir)).digest('hex');
  function request(operation, provider, value) {
    return new Promise((resolve, reject) => {
      const child = execFile(executable, ['--provider-keychain', operation, scope + '.' + provider], {
        env: {}, timeout: 120000, maxBuffer: 16384, encoding: 'utf8',
      }, (error, output) => {
        if (error) reject(new Error('macOS Keychain could not ' + operation + ' this provider key.'));
        else resolve(output);
      });
      child.stdin.on('error', () => {}); // The exit status reports a refused or interrupted operation.
      child.stdin.end(value);
    });
  }
  return {
    async read(provider) {
      const data = await request('read', provider);
      return data ? JSON.parse(data) : null;
    },
    async write(provider, record) { await request('write', provider, JSON.stringify(record)); },
  };
}

/** Linux libsecret keyring adapter via GNOME/KDE `secret-tool` (stdin-only secrets, fixed binary path, allowlisted env). */
export function linuxSecretToolKeychain(dataDir, { binary } = {}) {
  if (process.platform !== 'linux') return undefined;
  if (!binary && !process.env.DBUS_SESSION_BUS_ADDRESS) return undefined;
  const scope = createHash('sha256').update(path.resolve(dataDir)).digest('hex');
  const candidates = binary ? [binary] : ['/usr/bin/secret-tool', '/bin/secret-tool', '/usr/local/bin/secret-tool'];
  let resolvedBinary = null;
  for (const cand of candidates) {
    if (typeof cand !== 'string' || !path.isAbsolute(cand)) continue;
    try { accessSync(cand, fsConstants.X_OK); resolvedBinary = cand; break; } catch {}
  }
  if (!resolvedBinary) return undefined;
  const safeEnv = {};
  for (const key of ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'DISPLAY', 'WAYLAND_DISPLAY', 'HOME', 'USER']) {
    if (typeof process.env[key] === 'string') safeEnv[key] = process.env[key];
  }
  const assertProviderName = provider => {
    if (typeof provider !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(provider)) {
      throw new Error('Invalid keyring provider identifier.');
    }
  };
  return {
    async read(provider) {
      assertProviderName(provider);
      return new Promise((resolve, reject) => {
        execFile(resolvedBinary, ['lookup', 'application', 'g0dm0d3', 'scope', scope, 'provider', provider], {
          env: safeEnv, timeout: 15000, maxBuffer: 16384, encoding: 'utf8',
        }, (error, stdout) => {
          if (error) {
            if (error.code === 1) { resolve(null); return; } // Not found
            reject(new Error('Linux keyring (secret-tool) could not read this provider key.'));
            return;
          }
          const trimmed = String(stdout || '').trim();
          if (!trimmed) { resolve(null); return; }
          try { resolve(JSON.parse(trimmed)); }
          catch { reject(new Error('Linux keyring (secret-tool) entry is corrupted JSON.')); }
        });
      });
    },
    async write(provider, record) {
      assertProviderName(provider);
      return new Promise((resolve, reject) => {
        const label = `G0DM0D3 ${provider} API Key`;
        const child = execFile(resolvedBinary, ['store', `--label=${label}`, 'application', 'g0dm0d3', 'scope', scope, 'provider', provider], {
          env: safeEnv, timeout: 15000, maxBuffer: 16384, encoding: 'utf8',
        }, error => {
          if (error) reject(new Error('Linux keyring (secret-tool) could not save this provider key.'));
          else resolve();
        });
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify(record));
      });
    },
  };
}

export const MAX_MODELS_PER_PROVIDER = 128;

export async function createProviderSettings(providers, keychain, { dataDir } = {}) {
  const secrets = new Set();
  const savedModels = new Map();
  const savedKeys = new Map();
  const disabledProfiles = new Set();
  const togglesFile = dataDir ? path.join(dataDir, 'provider-toggles.json') : null;
  let pending = Promise.resolve();

  if (togglesFile) {
    try {
      const parsed = JSON.parse(await fs.readFile(togglesFile, 'utf8'));
      if (Array.isArray(parsed?.disabled)) {
        for (const name of parsed.disabled) {
          if (typeof name === 'string' && Object.hasOwn(profiles, name)) disabledProfiles.add(name);
        }
      }
    } catch {}
  }

  async function saveToggles() {
    if (!togglesFile) return;
    await fs.mkdir(path.dirname(togglesFile), { recursive: true, mode: 0o700 });
    const tmp = `${togglesFile}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify({ version: 1, disabled: [...disabledProfiles].sort() }) + '\n', { mode: 0o600, flag: 'wx' });
      await fs.rename(tmp, togglesFile);
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }

  function matchesProfile(item, provider) {
    const profile = profiles[provider];
    if (!profile || !item || item.closed) return false;
    const expectedProto = profile.protocol || 'openai-chat';
    if (item.protocol && item.protocol !== expectedProto) return false;
    return item.baseUrl === profile.endpoint || String(item.id || '').startsWith(provider + ':');
  }

  function applyProfileEnabledState(provider) {
    const disabled = disabledProfiles.has(provider);
    for (const item of providers.values()) {
      if (!matchesProfile(item, provider)) continue;
      if (disabled) {
        if (item.available !== false) item._wasAvailableBeforeDisable = true;
        item.available = false;
        item.disabledByUser = true;
      } else if (item.disabledByUser) {
        item.available = item._wasAvailableBeforeDisable !== false;
        item.disabledByUser = false;
      }
    }
  }

  function validateModels(models) {
    if (!Array.isArray(models) || !models.length || models.length > MAX_MODELS_PER_PROVIDER ||
        models.some(model => typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:._/+~-]{0,159}$/.test(model)))
      throw Object.assign(new Error(`Choose one to ${MAX_MODELS_PER_PROVIDER} valid model IDs.`), { status: 400 });
  }

  function prepare(provider, key, models, { useEnv = false } = {}) {
    if (!Object.hasOwn(profiles, provider)) throw Object.assign(new Error(`Choose one of: ${Object.keys(profiles).join(', ')}.`), { status: 400 });
    if (!useEnv && (typeof key !== 'string' || !key.trim() || key.length > 512 || /[\x00-\x20\x7f]/.test(key)))
      throw Object.assign(new Error('Provide a valid API key.'), { status: 400 });
    validateModels(models);
    const profile = profiles[provider];
    const protocol = profile.protocol || 'openai-chat';
    const instances = new Map();
    for (const model of models) {
      const id = provider + ':' + model.replaceAll('/', '-');
      if (instances.has(id)) throw Object.assign(new Error('Choose distinct model IDs.'), { status: 400 });
      const existing = providers.get(id);
      if (existing && (existing.model !== model || existing.baseUrl !== profile.endpoint || existing.protocol !== protocol))
        throw Object.assign(new Error('This model ID is already configured for another connection.'), { status: 400 });
      instances.set(id, new HttpProvider({
        id, label: existing?.label ?? model + ' · ' + profile.label, protocol, model, baseUrl: profile.endpoint,
        ...(useEnv ? { apiKeyEnv: profile.apiKeyEnv } : { credential: key }),
        timeoutMs: existing?.timeoutMs ?? 600000, maxOutputTokens: existing?.maxOutputTokens ?? 16000,
        maxOutputTokensCeiling: existing?.maxOutputTokensCeiling ?? 64000,
      }));
    }
    return instances;
  }
  function install(provider, record, instances) {
    for (const [id, instance] of instances) {
      const prev = providers.get(id);
      if (prev && prev !== instance && typeof prev.close === 'function') {
        try { prev.close(); } catch {}
      }
      providers.set(id, instance);
    }
    if (record.key) {
      secrets.add(record.key);
      savedKeys.set(provider, record.key);
    }
    savedModels.set(provider, record.models);
  }
  if (keychain) {
    for (const provider of Object.keys(profiles)) {
      try {
        const record = await keychain.read(provider);
        if (record) install(provider, record, prepare(provider, record.key, record.models));
      } catch {
        process.stderr.write('Godcode could not restore the ' + profiles[provider].label + ' connection from device keychain.\n');
      }
    }
  }
  for (const provider of Object.keys(profiles)) applyProfileEnabledState(provider);

  function profileModelsFromProviders(provider, { includeDisabled = false } = {}) {
    const profile = profiles[provider];
    if (!profile) return [];
    const found = [];
    for (const item of providers.values()) {
      if (!matchesProfile(item, provider)) continue;
      if (!includeDisabled && item.available === false) continue;
      if (includeDisabled && item.available === false && !item.disabledByUser) continue;
      if (typeof item.model === 'string') found.push(item.model);
    }
    return [...new Set(found)];
  }
  function isEnvConnected(provider) {
    const profile = profiles[provider];
    if (!profile?.apiKeyEnv) return false;
    return Boolean(process.env[profile.apiKeyEnv]) || profileModelsFromProviders(provider, { includeDisabled: true }).length > 0;
  }
  return {
    secrets,
    isProviderDisabled(provider) {
      return disabledProfiles.has(provider);
    },
    connectedProfiles() {
      const list = [];
      for (const [provider, profile] of Object.entries(profiles)) {
        const hasKey = savedKeys.has(provider);
        const allModels = profileModelsFromProviders(provider, { includeDisabled: true });
        const hasEnv = Boolean(profile.apiKeyEnv && process.env[profile.apiKeyEnv]);
        if (!hasKey && !allModels.length && !hasEnv) continue;
        const models = allModels.length ? allModels : [...(savedModels.get(provider) ?? [])];
        list.push({
          provider,
          label: profile.label,
          enabled: !disabledProfiles.has(provider),
          modelCount: models.length,
          models,
          storage: hasKey ? (keychain ? 'keychain' : 'session') : 'env',
        });
      }
      return list;
    },
    setProviderEnabled(body) {
      const operation = pending.then(async () => {
        const provider = typeof body?.provider === 'string' ? body.provider.trim().toLowerCase() : '';
        if (!Object.hasOwn(profiles, provider)) throw Object.assign(new Error(`Choose one of: ${Object.keys(profiles).join(', ')}.`), { status: 400 });
        if (typeof body?.enabled !== 'boolean') throw Object.assign(new Error('Specify enabled: true or false.'), { status: 400 });
        const hasAny = savedKeys.has(provider) || profileModelsFromProviders(provider, { includeDisabled: true }).length > 0 || Boolean(profiles[provider].apiKeyEnv && process.env[profiles[provider].apiKeyEnv]);
        if (!hasAny) throw Object.assign(new Error(`${profiles[provider].label} is not connected yet.`), { status: 400 });
        if (body.enabled) disabledProfiles.delete(provider);
        else disabledProfiles.add(provider);
        applyProfileEnabledState(provider);
        await saveToggles();
        return {
          provider,
          label: profiles[provider].label,
          enabled: !disabledProfiles.has(provider),
          models: profileModelsFromProviders(provider, { includeDisabled: true }),
        };
      });
      pending = operation.catch(() => {});
      return operation;
    },
    connect(body) {
      const operation = pending.then(async () => {
        const key = typeof body.key === 'string' ? body.key.trim() : '';
        const detected = key.startsWith('sk-ant-') ? 'anthropic'
          : key.startsWith('sk-or-') ? 'openrouter'
          : key.startsWith('AIza') ? 'gemini'
          : key.startsWith('sk-') ? 'openai'
          : 'venice';
        const provider = body.provider || detected;
        if (!Object.hasOwn(profiles, provider)) throw Object.assign(new Error(`Choose one of: ${Object.keys(profiles).join(', ')}.`), { status: 400 });
        const previous = savedModels.get(provider) ?? [];
        const selected = body.models ?? [...profiles[provider].defaults, ...previous];
        if (!Array.isArray(selected) || !selected.length) throw Object.assign(new Error('Choose at least one model.'), { status: 400 });
        const models = [...new Set([...previous, ...selected])];
        const record = { key, models };
        const instances = prepare(provider, key, models);
        if (keychain) await keychain.write(provider, record);
        install(provider, record, instances);
        if (disabledProfiles.has(provider)) {
          disabledProfiles.delete(provider);
          await saveToggles();
        }
        applyProfileEnabledState(provider);
        return { provider, registered: [...instances.keys()], storage: keychain ? 'keychain' : 'session' };
      });
      pending = operation.catch(() => {});
      return operation;
    },
    addModels(body) {
      const operation = pending.then(async () => {
        const provider = typeof body?.provider === 'string' ? body.provider.trim().toLowerCase() : '';
        if (!Object.hasOwn(profiles, provider)) throw Object.assign(new Error(`Choose one of: ${Object.keys(profiles).join(', ')}.`), { status: 400 });
        const rawModels = Array.isArray(body?.models) ? body.models : (typeof body?.model === 'string' ? [body.model] : []);
        const cleaned = [...new Set(rawModels.map(m => typeof m === 'string' ? m.trim() : '').filter(Boolean))];
        validateModels(cleaned);
        const key = savedKeys.get(provider);
        const profile = profiles[provider];
        if (key) {
          const previous = savedModels.get(provider) ?? [];
          const models = [...new Set([...previous, ...cleaned])];
          const record = { key, models };
          const instances = prepare(provider, key, models);
          if (keychain) await keychain.write(provider, record);
          install(provider, record, instances);
          const added = cleaned.map(m => provider + ':' + m.replaceAll('/', '-'));
          return { provider, added, registered: [...instances.keys()], storage: keychain ? 'keychain' : 'session' };
        }
        if (isEnvConnected(provider) && process.env[profile.apiKeyEnv]) {
          const existing = profileModelsFromProviders(provider);
          const models = [...new Set([...existing, ...cleaned])];
          const instances = prepare(provider, null, cleaned, { useEnv: true });
          for (const [id, instance] of instances) {
            if (!providers.has(id)) providers.set(id, instance);
          }
          const added = cleaned.map(m => provider + ':' + m.replaceAll('/', '-'));
          return { provider, added, registered: models.map(m => provider + ':' + m.replaceAll('/', '-')), storage: 'env' };
        }
        const cloneSource = [...providers.values()].find(
          item => item.baseUrl === profile.endpoint
            && item.protocol === (profile.protocol || 'openai-chat')
            && item.available !== false
            && !item.closed
            && typeof item.cloneWithModel === 'function'
        );
        if (cloneSource) {
          const added = [];
          for (const model of cleaned) {
            const id = provider + ':' + model.replaceAll('/', '-');
            if (!providers.has(id)) {
              providers.set(id, cloneSource.cloneWithModel({ id, label: `${model} · ${profile.label}`, model }));
            }
            added.push(id);
          }
          const allModels = profileModelsFromProviders(provider);
          return { provider, added, registered: allModels.map(m => provider + ':' + m.replaceAll('/', '-')), storage: 'reference' };
        }
        throw Object.assign(new Error(`Connect a ${profile.label} API key first before adding models.`), { status: 400 });
      });
      pending = operation.catch(() => {});
      return operation;
    },
    removeModels(body) {
      const operation = pending.then(async () => {
        const provider = typeof body?.provider === 'string' ? body.provider.trim().toLowerCase() : '';
        if (!Object.hasOwn(profiles, provider)) throw Object.assign(new Error(`Choose one of: ${Object.keys(profiles).join(', ')}.`), { status: 400 });
        const rawModels = Array.isArray(body?.models) ? body.models : (typeof body?.model === 'string' ? [body.model] : []);
        const toRemove = new Set(rawModels.map(m => typeof m === 'string' ? m.trim() : '').filter(Boolean));
        if (!toRemove.size) throw Object.assign(new Error('Specify at least one model to remove.'), { status: 400 });
        const key = savedKeys.get(provider);
        const profile = profiles[provider];
        if (key) {
          const previous = savedModels.get(provider) ?? [];
          const remaining = previous.filter(m => !toRemove.has(m));
          if (!remaining.length) throw Object.assign(new Error(`Keep at least one ${profile.label} model connected.`), { status: 400 });
          const record = { key, models: remaining };
          const instances = prepare(provider, key, remaining);
          if (keychain) await keychain.write(provider, record);
          for (const m of toRemove) {
            const id = provider + ':' + m.replaceAll('/', '-');
            const prev = providers.get(id);
            if (prev && prev.baseUrl === profile.endpoint) {
              try { prev.close?.(); } catch {}
              providers.delete(id);
            }
          }
          install(provider, record, instances);
          return { provider, removed: [...toRemove], registered: [...instances.keys()], storage: keychain ? 'keychain' : 'session' };
        }
        const existing = profileModelsFromProviders(provider);
        const remaining = existing.filter(m => !toRemove.has(m));
        if (!remaining.length) throw Object.assign(new Error(`Keep at least one ${profile.label} model connected.`), { status: 400 });
        for (const m of toRemove) {
          const id = provider + ':' + m.replaceAll('/', '-');
          const prev = providers.get(id);
          if (prev && prev.baseUrl === profile.endpoint) {
            try { prev.close?.(); } catch {}
            providers.delete(id);
          }
        }
        return { provider, removed: [...toRemove], registered: remaining.map(m => provider + ':' + m.replaceAll('/', '-')), storage: 'env' };
      });
      pending = operation.catch(() => {});
      return operation;
    },
  };
}
