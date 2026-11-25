import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TELEMETRY_POLICY,
  CLI_NO_TELEMETRY_ENV,
  classifyProviderZdr,
  checkProviderPrivacyAllowed,
  applyZdrRequestPolicy,
  redactOutboundText,
  OutboundAuditLog
} from '../src/privacy.mjs';
import { HttpProvider, cliEnvironment, claudeSubscriptionEnvironment, geminiSubscriptionEnvironment, copilotSubscriptionEnvironment } from '../src/providers.mjs';
import { createApp } from '../src/server.mjs';
import { createScriptedProviders } from '../bench/scripted.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

function dispatch(app, { method = 'GET', url = '/', headers = {}, body } = {}) {
  const address = app.server.address() || { address: '127.0.0.1', port: 4317 };
  if (!app.server.address()) app.server.address = () => address;
  const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const req = Readable.from(payload ? [payload] : []);
  req.method = method;
  req.url = url;
  req.headers = {
    host: `127.0.0.1:${address.port}`,
    ...(['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) ? { origin: `http://127.0.0.1:${address.port}`, 'x-g0d-request': '1' } : {}),
    ...(payload ? { 'content-type': 'application/json' } : {}),
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  };
  req.setTimeout = () => {};
  return new Promise((resolve, reject) => {
    const resHeaders = new Map();
    const chunks = [];
    const res = {
      statusCode: 200,
      headersSent: false,
      setTimeout() {},
      setHeader(name, value) { resHeaders.set(name.toLowerCase(), value); },
      getHeader(name) { return resHeaders.get(name.toLowerCase()); },
      writeHead(status, hdrs = {}) {
        this.statusCode = status;
        this.headersSent = true;
        for (const [k, v] of Object.entries(hdrs)) resHeaders.set(k.toLowerCase(), v);
      },
      write(chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); },
      end(chunk) {
        if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: this.statusCode, headers: resHeaders, text, json });
      }
    };
    try { app.server.emit('request', req, res); }
    catch (err) { reject(err); }
  });
}

test('Zero-Telemetry Structural Audit: zero analytics SDKs, zero phone-home URLs, and zero auth-file reads in source', async () => {
  assert.equal(TELEMETRY_POLICY.enabled, false);
  assert.deepEqual(TELEMETRY_POLICY.endpoints, []);

  // Explicitly allowlisted outbound inference provider hosts in src/ (excluding fixture probes & docs)
  const ALLOWED_HOSTS = new Set([
    'api.openai.com',
    'api.anthropic.com',
    'openrouter.ai',
    'api.venice.ai',
    'generativelanguage.googleapis.com',
    'inference-api.nousresearch.com',
    'html.duckduckgo.com', // explicit user/agent web.search tool only (gated by privacy.localOnly + outbound audit)
    '127.0.0.1',
    'localhost'
  ]);
  // Banned analytics / telemetry domains & SDK identifiers
  const BANNED_TELEMETRY = /\b(?:posthog\.com|ingest\.t3\.codes|sentry\.io|axiom\.co|mixpanel\.com|amplitude\.com|segment\.io|datadoghq\.com|google-analytics\.com|plausible\.io)\b/i;

  const srcEntries = await fs.readdir(path.join(repoRoot, 'src'));
  for (const name of srcEntries) {
    if (!name.endsWith('.mjs') || name.startsWith('probes-')) continue;
    const text = await fs.readFile(path.join(repoRoot, 'src', name), 'utf8');
    assert.equal(BANNED_TELEMETRY.test(text), false, `Banned telemetry reference found in src/${name}`);
    for (const match of text.matchAll(/https?:\/\/([a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9])/g)) {
      const host = match[1].toLowerCase();
      assert.equal(ALLOWED_HOSTS.has(host), true, `Unexpected outbound host "${host}" in src/${name}`);
    }
  }

  // Verify public/ has zero external analytics/telemetry URLs and zero inline style= attributes
  const publicEntries = await fs.readdir(path.join(repoRoot, 'public'));
  for (const name of publicEntries) {
    if (!/\.(?:js|html|css)$/.test(name)) continue;
    const text = await fs.readFile(path.join(repoRoot, 'public', name), 'utf8');
    assert.equal(BANNED_TELEMETRY.test(text), false, `Banned telemetry reference found in public/${name}`);
    if (name.endsWith('.html') || name.endsWith('.js')) {
      assert.equal(/\sstyle\s*=\s*["']/.test(text), false, `CSP violation: inline style= found in public/${name}`);
    }
  }

  // Verify provider-connections.mjs never calls readFile on ~/.claude, ~/.codex, ~/.gemini, ~/.copilot, or ~/.config/gh
  const connSrc = await fs.readFile(path.join(repoRoot, 'src', 'provider-connections.mjs'), 'utf8');
  assert.doesNotMatch(connSrc, /readFile.*(?:oauth_creds|auth\.json|\.claude\.json|hosts\.yml)/i);
});

test('CLI telemetry kill-switch forcibly disables vendor telemetry across all 4 CLI subscription environments', () => {
  const baseEnv = { HOME: '/tmp/home', PATH: '/usr/bin' };
  for (const builder of [cliEnvironment, claudeSubscriptionEnvironment, geminiSubscriptionEnvironment, copilotSubscriptionEnvironment]) {
    const out = builder(baseEnv);
    for (const [k, v] of Object.entries(CLI_NO_TELEMETRY_ENV)) {
      assert.equal(out[k], v, `${builder.name} must set ${k}=${v}`);
    }
  }
});

test('Honest provider ZDR classification, request shaping (OpenRouter ZDR + OpenAI store=false), and Strict ZDR / Local-Only gates', async () => {
  const localProv = new HttpProvider({ id: 'ollama:qwen', model: 'qwen2.5-coder:14b', baseUrl: 'http://127.0.0.1:11434/v1', tier: 'local' });
  const veniceProv = new HttpProvider({ id: 'venice:m', model: 'venice-uncensored-1-2', baseUrl: 'https://api.venice.ai/api/v1', credential: 'test-key' });
  const orProv = new HttpProvider({ id: 'openrouter:m', model: 'deepseek/deepseek-chat', baseUrl: 'https://openrouter.ai/api/v1', credential: 'test-key' });
  const openaiProv = new HttpProvider({ id: 'openai:m', model: 'gpt-5.4', protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1', credential: 'test-key' });
  const anthProv = new HttpProvider({ id: 'anthropic:m', model: 'claude-sonnet-4-6', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', credential: 'test-key' });

  assert.equal(classifyProviderZdr(localProv).zdrClass, 'local-only');
  assert.equal(classifyProviderZdr(veniceProv).zdrClass, 'native-zdr');
  assert.equal(classifyProviderZdr(orProv).zdrClass, 'zdr-enforced');
  assert.equal(classifyProviderZdr(openaiProv).zdrClass, 'no-store');
  assert.equal(classifyProviderZdr(anthProv).zdrClass, 'provider-policy');

  // OpenRouter ZDR body shaping: default vs strictZdr
  const orBody = { model: 'deepseek/deepseek-chat', messages: [] };
  const r1 = applyZdrRequestPolicy(orProv, orBody, { zdrRouting: true, strictZdr: false, localOnly: false, redactOutboundSecrets: true });
  assert.deepEqual(orBody.provider, { zdr: true, data_collection: 'deny' });
  assert.ok(r1.zdrFlags.includes('openrouter:zdr=true'));

  const orStrictBody = { model: 'deepseek/deepseek-chat', messages: [] };
  applyZdrRequestPolicy(orProv, orStrictBody, { zdrRouting: true, strictZdr: true, localOnly: false, redactOutboundSecrets: true });
  assert.deepEqual(orStrictBody.provider, { zdr: true, data_collection: 'deny', allow_fallbacks: false });

  // OpenAI chat/responses gets store=false
  const oaBody = { model: 'gpt-5.4', messages: [] };
  applyZdrRequestPolicy(openaiProv, oaBody, { zdrRouting: true, strictZdr: false, localOnly: false, redactOutboundSecrets: true });
  assert.equal(oaBody.store, false);

  // Strict ZDR Gate allows Local, Venice, OpenRouter — blocks Anthropic & OpenAI API (unless ZDR addendum)
  const strict = { zdrRouting: true, strictZdr: true, localOnly: false, redactOutboundSecrets: true };
  assert.equal(checkProviderPrivacyAllowed(localProv, strict).allowed, true);
  assert.equal(checkProviderPrivacyAllowed(veniceProv, strict).allowed, true);
  assert.equal(checkProviderPrivacyAllowed(orProv, strict).allowed, true);
  assert.equal(checkProviderPrivacyAllowed(anthProv, strict).allowed, false);
  assert.equal(checkProviderPrivacyAllowed(anthProv, strict).code, 'PRIVACY_STRICT_ZDR');

  // Local-Only Airgap Mode allows ONLY loopback local providers — blocks ALL cloud providers including Venice & OpenRouter
  const airgap = { zdrRouting: true, strictZdr: false, localOnly: true, redactOutboundSecrets: true };
  assert.equal(checkProviderPrivacyAllowed(localProv, airgap).allowed, true);
  assert.equal(checkProviderPrivacyAllowed(veniceProv, airgap).allowed, false);
  assert.equal(checkProviderPrivacyAllowed(orProv, airgap).allowed, false);
  assert.equal(checkProviderPrivacyAllowed(veniceProv, airgap).code, 'PRIVACY_LOCAL_ONLY');

  // Blocking happens BEFORE fetch() and records an audit entry
  const audit = new OutboundAuditLog();
  const blockedRes = await anthProv.turn(
    { task: { id: 't1', title: 'Secret', objective: 'hi', constraints: [], status: 'running', calls: 0, recoveries: 0 }, files: [], events: [], tools: [] },
    { privacy: strict, onOutbound: e => audit.record(e) }
  );
  assert.equal(blockedRes.type, 'error');
  assert.equal(blockedRes.code, 'PRIVACY_STRICT_ZDR');
  assert.equal(audit.list()[0].blocked, true);

  localProv.close(); veniceProv.close(); orProv.close(); openaiProv.close(); anthProv.close();
});

test('Pre-flight outbound secret redactor scrubs API keys, AWS keys, and PEM private keys', () => {
  const sample = [
    'ANTHROPIC=sk-ant-api03-abcdefghijklmnopqrstuvwx',
    'AWS=AKIAIOSFODNN7EXAMPLE',
    'GH=ghp_1234567890abcdef1234567890abcdef1234',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAtestersecretkeymaterial1234567890\n-----END RSA PRIVATE KEY-----',
    'safe line stays untouched'
  ].join('\n');
  const { text, count } = redactOutboundText(sample);
  assert.equal(count, 4);
  assert.doesNotMatch(text, /sk-ant-api03/);
  assert.doesNotMatch(text, /AKIAIOSFODNN7EXAMPLE/);
  assert.doesNotMatch(text, /ghp_1234567890/);
  assert.doesNotMatch(text, /BEGIN RSA PRIVATE KEY/);
  assert.match(text, /safe line stays untouched/);
});

test('HTTP Privacy API (/api/privacy, /api/privacy/audit) and zero-trace task purge (DELETE /api/tasks/:id)', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'g0d-priv-http-'));
  const app = await createApp({ dataDir: dir, providers: createScriptedProviders(), auth: false });
  const req = (method, url, body) => dispatch(app, { method, url, body });
  try {
    const initial = await req('GET', '/api/privacy');
    assert.equal(initial.status, 200);
    assert.equal(initial.json.telemetry.enabled, false);
    assert.equal(initial.json.settings.zdrRouting, true);
    assert.equal(initial.json.settings.redactOutboundSecrets, true);

    const updated = await req('PATCH', '/api/privacy', { strictZdr: true, localOnly: true });
    assert.equal(updated.status, 200);
    assert.equal(updated.json.settings.strictZdr, true);
    assert.equal(updated.json.settings.localOnly, true);

    // Clear audit endpoint
    app.runtime.outboundAudit.record({ providerId: 'test', host: '127.0.0.1', protocol: 'openai-chat', zdrClass: 'local-only', zdrFlags: ['local-only:no-egress'] });
    assert.equal((await req('GET', '/api/privacy')).json.audit.length, 1);
    const cleared = await req('DELETE', '/api/privacy/audit', {});
    assert.equal(cleared.status, 200);
    assert.equal(cleared.json.audit.length, 0);

    // Create task and verify DELETE /api/tasks/:id purges SQLite rows AND workspace directory
    const created = await req('POST', '/api/tasks', { fixtureId: 'task-board', autoRun: false });
    assert.equal(created.status, 201);
    const taskId = created.json.task.id;
    const ws = app.runtime.getTask(taskId).workspace;
    await fs.access(ws);

    const purged = await req('DELETE', `/api/tasks/${taskId}`, {});
    assert.equal(purged.status, 200);
    assert.equal(purged.json.deleted, true);
    assert.equal(purged.json.workspaceDeleted, true);
    assert.equal((await req('GET', `/api/tasks/${taskId}`)).status, 404);
    await assert.rejects(() => fs.access(ws));
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
