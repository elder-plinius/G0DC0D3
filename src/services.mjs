import { promises as fs, constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { cliEnvironment } from './providers.mjs';
import { classifyProviderZdr, checkProviderPrivacyAllowed, DEFAULT_PRIVACY_SETTINGS } from './privacy.mjs';

/**
 * Unified Connected Coding & AI Services Inspector.
 *
 * Surfaces every service relevant to coding & CLI workflows in one clear status model:
 * - AI CLI Subscriptions (Claude Code, OpenAI Codex, Gemini CLI, GitHub Copilot)
 * - Developer & Local CLIs (GitHub `gh`, Git, Ollama / Local Runtime)
 * - Direct API Key Services (Anthropic, OpenAI, Google Gemini, OpenRouter, Nous Portal, Venice)
 *
 * Security & Privacy:
 * - Read-only local binary probes only with CLI_NO_TELEMETRY_ENV enforced.
 * - Never reads local OAuth/token files (no ~/.config/gh/hosts.yml, ~/.claude.json, etc.).
 */

const API_SERVICES = Object.freeze([
  { id: 'anthropic', name: 'Anthropic API', host: 'api.anthropic.com', baseUrl: 'https://api.anthropic.com/v1', billing: 'API Key', description: 'Direct Claude 5.5 / 4.6 Opus, Sonnet & Haiku API' },
  { id: 'openai', name: 'OpenAI API', host: 'api.openai.com', baseUrl: 'https://api.openai.com/v1', billing: 'API Key', description: 'Direct GPT-6.2 Astra / Sol / GPT-5.6 / o3 Responses API (store=false)' },
  { id: 'xai', name: 'xAI (Grok)', host: 'api.x.ai', baseUrl: 'https://api.x.ai/v1', billing: 'API Key', description: 'Direct Grok 4.7 / Grok Code Fast API' },
  { id: 'gemini', name: 'Gemini API', host: 'generativelanguage.googleapis.com', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', billing: 'API Key', description: 'Google Gemini 4 Neon / 3 Pro / 2.5 Pro & Flash API' },
  { id: 'meta', name: 'Meta AI (Muse / Llama)', host: 'api.llama.com', baseUrl: 'https://api.llama.com/compat/v1', billing: 'API Key', description: 'Direct Meta Muse Spark & Llama 4 Maverick / Scout API' },
  { id: 'openrouter', name: 'OpenRouter', host: 'openrouter.ai', baseUrl: 'https://openrouter.ai/api/v1', billing: 'API Key', description: 'Multi-model router with ZDR & data_collection=deny' },
  { id: 'nous', name: 'Nous Portal', host: 'inference-api.nousresearch.com', baseUrl: 'https://inference-api.nousresearch.com/v1', billing: 'API Key', description: 'Hermes 4 405B / 70B inference portal' },
  { id: 'venice', name: 'Venice AI', host: 'api.venice.ai', baseUrl: 'https://api.venice.ai/api/v1', billing: 'API Key', description: 'Vendor-documented Zero Data Retention inference' }
]);

async function findBinary(candidates) {
  for (const bin of candidates) {
    if (!bin) continue;
    try {
      const st = await fs.stat(bin);
      if (!st.isFile()) continue;
      await fs.access(bin, constants.X_OK);
      return bin;
    } catch {}
  }
  return null;
}

function runProbe(binary, args, env, timeoutMs = 3500) {
  return new Promise(resolve => {
    const child = spawn(binary, args, {
      cwd: tmpdir(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    });
    let output = '', bytes = 0, timedOut = false, failed = false, closed = false, terminating = false, killTimer;
    const kill = () => {
      if (closed || terminating || !Number.isInteger(child.pid)) return;
      terminating = true;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {}
      killTimer = setTimeout(() => {
        try {
          if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {}
      }, 100);
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const onData = chunk => {
      bytes += chunk.length;
      if (bytes > 32768) { failed = true; kill(); return; }
      output += chunk;
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', () => { failed = true; });
    child.on('close', code => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ code: failed || timedOut ? -1 : code, output: failed || timedOut ? '' : output, timedOut });
    });
  });
}

function parseVersion(text) {
  const m = String(text || '').match(/(\d+\.\d+(?:\.\d+)?)/);
  return m ? `v${m[1]}` : null;
}

export function createServiceStatus({
  providers,
  cliConnections = null,
  getPrivacy = () => DEFAULT_PRIVACY_SETTINGS,
  environment = process.env,
  home = homedir(),
  probeTimeoutMs = 3500
} = {}) {
  let toolCache = null;
  let probing = null;

  async function probeDevTools() {
    if (probing) return probing;
    const env = cliEnvironment(environment);
    probing = (async () => {
      // 1. GitHub CLI (`gh`)
      const ghBin = await findBinary([
        environment.G0D_GH_BINARY && path.isAbsolute(environment.G0D_GH_BINARY) ? environment.G0D_GH_BINARY : null,
        '/opt/homebrew/bin/gh',
        '/usr/local/bin/gh',
        '/usr/bin/gh',
        path.join(home, '.local/bin/gh')
      ]);
      let ghInfo = {
        id: 'github-cli',
        name: 'GitHub CLI',
        category: 'devtools',
        command: 'gh',
        installed: Boolean(ghBin),
        authenticated: null,
        status: ghBin ? 'ready' : 'missing',
        statusLabel: ghBin ? 'Installed' : 'Not installed',
        version: null,
        account: null,
        detail: ghBin ? 'GitHub CLI is installed. Account access is checked when you run a GitHub command; this scan does not contact GitHub.' : 'Install GitHub CLI (brew install gh) for PRs and issues.',
        hint: 'gh auth login'
      };
      if (ghBin) {
        const verRes = await runProbe(ghBin, ['--version'], env, probeTimeoutMs);
        ghInfo.version = parseVersion(verRes.output);
      }

      // 2. Git (`git`)
      const gitBin = await findBinary([
        environment.G0D_GIT_BINARY && path.isAbsolute(environment.G0D_GIT_BINARY) ? environment.G0D_GIT_BINARY : null,
        '/opt/homebrew/bin/git',
        '/usr/local/bin/git',
        '/usr/bin/git'
      ]);
      let gitVersion = null;
      if (gitBin) {
        const verRes = await runProbe(gitBin, ['--version'], env, probeTimeoutMs);
        gitVersion = parseVersion(verRes.output);
      }
      const gitInfo = {
        id: 'git-cli',
        name: 'Git',
        category: 'devtools',
        command: 'git',
        installed: Boolean(gitBin),
        authenticated: Boolean(gitBin),
        status: gitBin ? 'connected' : 'missing',
        statusLabel: gitBin ? (gitVersion || 'Ready') : 'Not installed',
        version: gitVersion,
        account: null,
        detail: gitBin ? 'Worktrees, checkpoints, diffs, undo, and commits ready.' : 'Install Git to enable worktrees, checkpoints, and commits.',
        hint: 'xcode-select --install'
      };

      // 3. Ollama local binary
      const ollamaBin = await findBinary([
        environment.G0D_OLLAMA_BINARY && path.isAbsolute(environment.G0D_OLLAMA_BINARY) ? environment.G0D_OLLAMA_BINARY : null,
        '/opt/homebrew/bin/ollama',
        '/usr/local/bin/ollama',
        '/usr/bin/ollama',
        '/Applications/Ollama.app/Contents/Resources/ollama'
      ]);
      let ollamaVersion = null;
      if (ollamaBin) {
        const verRes = await runProbe(ollamaBin, ['--version'], env, probeTimeoutMs);
        ollamaVersion = parseVersion(verRes.output);
      }

      const result = { ghInfo, gitInfo, ollamaInstalled: Boolean(ollamaBin), ollamaVersion };
      toolCache = result;
      return result;
    })().finally(() => { probing = null; });
    return probing;
  }

  return {
    async status({ refresh = false } = {}) {
      const privacy = getPrivacy();
      const [cliRes, tools] = await Promise.all([
        cliConnections ? cliConnections.status({ refresh }) : Promise.resolve({ connections: [] }),
        (!toolCache || refresh) ? probeDevTools() : Promise.resolve(toolCache)
      ]);

      const allLiveProviders = [...providers.values()].filter(p => p && p.kind !== 'scripted' && !p.closed);

      // 1. AI CLI Subscriptions
      const subscriptions = (cliRes.connections || []).map(conn => {
        const provider = providers.get(conn.id);
        const privacyCheck = provider ? checkProviderPrivacyAllowed(provider, privacy) : null;
        const blocked = Boolean(conn.enabled && privacyCheck && !privacyCheck.allowed);
        const status = blocked
          ? 'blocked'
          : conn.enabled && conn.ready
            ? 'connected'
            : conn.ready
              ? 'ready'
              : conn.installed
                ? 'signin'
                : 'missing';
        const statusLabel = blocked
          ? (privacy.localOnly ? 'Blocked (Local-Only)' : 'Blocked (Strict ZDR)')
          : status === 'connected'
            ? 'Connected'
            : status === 'ready'
              ? (conn.authenticated ? 'Signed in · not added' : 'Sign-in unverified')
              : status === 'signin'
                ? 'Sign in required'
                : 'Not installed';
        return {
          id: conn.id,
          name: conn.name,
          category: 'subscription',
          billing: 'Account plan',
          subscription: conn.subscription,
          installed: conn.installed,
          authenticated: conn.authenticated,
          enabled: conn.enabled,
          ready: conn.ready,
          blocked,
          model: conn.model,
          models: conn.models || [],
          availableModels: conn.availableModels || [],
          modelCount: Array.isArray(conn.models) ? conn.models.length : (conn.enabled ? 1 : 0),
          settings: conn.settings || {},
          status,
          statusLabel,
          zdr: classifyProviderZdr({ kind: conn.id === 'claude-code' ? 'claude' : conn.id === 'codex-cli' ? 'codex' : conn.id }),
          detail: conn.detail,
          hint: conn.loginHint
        };
      });

      // 2. Local Inference Engines (Ollama / LM Studio / MLX / vLLM)
      const localProviders = allLiveProviders.filter(p => classifyProviderZdr(p).localOnly && p.available !== false);
      const localService = {
        id: 'local-inference',
        name: 'Local Models (Ollama / MLX)',
        category: 'devtools',
        command: 'ollama',
        billing: 'Local',
        installed: tools.ollamaInstalled || localProviders.length > 0,
        authenticated: localProviders.length > 0,
        modelCount: localProviders.length,
        models: localProviders.map(p => p.model || p.label || p.id),
        version: tools.ollamaVersion,
        status: localProviders.length > 0 ? 'connected' : tools.ollamaInstalled ? 'ready' : 'missing',
        statusLabel: localProviders.length > 0
          ? `${localProviders.length} local ${localProviders.length === 1 ? 'model' : 'models'}`
          : tools.ollamaInstalled
            ? 'Installed · Add model'
            : 'Not detected',
        zdr: { zdrClass: 'local-only', label: 'LOCAL ONLY', strictZdrEligible: true, localOnly: true },
        detail: localProviders.length > 0
          ? `100% on-device loopback: ${localProviders.map(p => p.model || p.id).slice(0, 3).join(', ')}${localProviders.length > 3 ? ` +${localProviders.length - 3} more` : ''}.`
          : 'Connect Ollama, LM Studio, MLX, or vLLM on 127.0.0.1 for on-device inference.',
        hint: 'ollama pull qwen2.5-coder:32b'
      };

      const devtools = [tools.ghInfo, tools.gitInfo, localService];

      // 3. Direct API Key Providers
      const apis = API_SERVICES.map(svc => {
        const allForService = allLiveProviders.filter(p => {
          if (String(p.id || '').startsWith(`${svc.id}:`)) return true;
          try { return p.baseUrl && new URL(p.baseUrl).hostname.toLowerCase() === svc.host; } catch { return false; }
        });
        const matched = allForService.filter(p => p.available !== false);
        const pausedByUser = matched.length === 0 && allForService.length > 0 && allForService.every(p => p.disabledByUser);
        const zdr = classifyProviderZdr({ baseUrl: svc.baseUrl, kind: 'http' });
        const privacyCheck = checkProviderPrivacyAllowed({ id: svc.id, label: svc.name, baseUrl: svc.baseUrl, kind: 'http' }, privacy);
        const blocked = matched.length > 0 && !privacyCheck.allowed;
        return {
          id: svc.id,
          name: svc.name,
          category: 'api',
          billing: svc.billing,
          connected: matched.length > 0 || pausedByUser,
          enabled: matched.length > 0,
          pausedByUser,
          blocked,
          modelCount: matched.length || allForService.length,
          models: (matched.length ? matched : allForService).map(p => p.model || p.label || p.id),
          status: blocked ? 'blocked' : matched.length > 0 ? 'connected' : pausedByUser ? 'paused' : 'unconfigured',
          statusLabel: blocked
            ? (privacy.localOnly ? 'Blocked (Local-Only)' : 'Blocked (Strict ZDR)')
            : matched.length > 0
              ? `Active · ${matched.length} ${matched.length === 1 ? 'model' : 'models'}`
              : pausedByUser
                ? 'Disabled'
                : 'Not connected',
          zdr,
          detail: matched.length > 0
            ? matched.map(p => p.model || p.id).slice(0, 3).join(', ') + (matched.length > 3 ? ` +${matched.length - 3} more` : '')
            : pausedByUser
              ? `Key saved (${allForService.length} ${allForService.length === 1 ? 'model' : 'models'}) — currently disabled. Enable to include in model picker & routing.`
              : svc.description
        };
      });

      const connectedSubscriptions = subscriptions.filter(s => s.status === 'connected').length;
      const readySubscriptions = subscriptions.filter(s => s.status === 'ready').length;
      const connectedApis = apis.filter(a => a.status === 'connected').length;
      const connectedDevtools = devtools.filter(d => d.status === 'connected').length;

      return {
        summary: {
          connectedTotal: connectedSubscriptions + connectedApis + connectedDevtools,
          connectedAiCount: connectedSubscriptions + connectedApis + (localProviders.length > 0 ? 1 : 0),
          connectedSubscriptions,
          readySubscriptions,
          connectedApis,
          connectedDevtools,
          localModelCount: localProviders.length,
          githubAuthenticated: tools.ghInfo.authenticated,
          githubAccount: tools.ghInfo.account
        },
        subscriptions,
        devtools,
        apis
      };
    }
  };
}
