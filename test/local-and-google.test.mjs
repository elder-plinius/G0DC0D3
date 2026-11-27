import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCliConnections } from '../src/provider-connections.mjs';
import { AntigravityCliProvider, antigravitySubscriptionEnvironment } from '../src/providers.mjs';
import { createLocalProviderManager, normalizeHuggingFaceRef } from '../src/local-providers.mjs';
import { createApp } from '../src/server.mjs';
import { createScriptedProviders } from '../bench/scripted.mjs';

function dispatch(app, { method = 'GET', url = '/', body } = {}) {
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
  };
  req.setTimeout = () => {};
  return new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      statusCode: 200,
      setHeader() {},
      getHeader() {},
      writeHead(status) { this.statusCode = status; },
      write(chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); },
      end(chunk) {
        if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: this.statusCode, text, json });
      },
    };
    try { app.server.emit('request', req, res); }
    catch (err) { reject(err); }
  });
}

test('Google Antigravity CLI (agy) discovery parses live models, strips API keys, and executes planner turns', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'g0d-agy-cli-'));
  try {
    const binDir = path.join(dir, 'bin');
    await fs.mkdir(binDir, { recursive: true });
    const fakeAgy = path.join(binDir, 'agy');
    await fs.writeFile(fakeAgy, `#!/bin/sh
if [ "$1" = "models" ]; then
  printf "\\033[?25lFetching...\\rgemini-4-neon-live-preview     Gemini 4 Neon Live\\nMODEL                          DESCRIPTION\\ngemini-4-neon-high             Gemini 4 Neon (High)\\ngemini-4-carbon-high           Gemini 4 Carbon (High)\\n"
  exit 0
fi
if [ -n "$GEMINI_API_KEY" ]; then
  echo "LEAKED_API_KEY" >&2
  exit 1
fi
cat >/dev/null
cat <<'EOF'
{"conversation_id":"c1","status":"SUCCESS","num_turns":1,"response":"{\\"type\\":\\"message\\",\\"calls\\":[],\\"text\\":\\"Antigravity Neon reply\\",\\"finish\\":\\"done\\"}","usage":{"input_tokens":120,"output_tokens":18,"total_tokens":138}}
EOF
`, { mode: 0o755 });

    const envOut = antigravitySubscriptionEnvironment({ HOME: dir, PATH: '/usr/bin', GEMINI_API_KEY: 'secret', GOOGLE_API_KEY: 'secret2' });
    assert.equal(envOut.GEMINI_API_KEY, undefined);
    assert.equal(envOut.GOOGLE_API_KEY, undefined);
    assert.equal(envOut.DO_NOT_TRACK, '1');

    const providers = new Map();
    const connections = await createCliConnections({
      dataDir: path.join(dir, 'data'),
      providers,
      home: dir,
      environment: {
        HOME: dir,
        PATH: '/usr/bin:/bin',
        GEMINI_API_KEY: 'must-be-stripped',
        G0D_ANTIGRAVITY_BINARY: fakeAgy,
        G0D_CLAUDE_BINARY: path.join(binDir, 'missing-claude'),
        G0D_CODEX_BINARY: path.join(binDir, 'missing-codex'),
        G0D_GEMINI_BINARY: path.join(binDir, 'missing-gemini'),
        G0D_COPILOT_BINARY: path.join(binDir, 'missing-copilot'),
      },
    });

    const st = await connections.status({ refresh: true });
    const agy = st.connections.find(c => c.id === 'antigravity-cli');
    assert.equal(agy?.installed, true);
    assert.equal(agy?.authenticated, true);
    assert.equal(agy?.ready, true);
    assert.equal(agy?.localCacheCount, 3);
    assert.ok(agy.availableModels.includes('gemini-4-neon-live-preview'));
    assert.equal(agy.availableModels.includes('MODEL'), false);

    const conn = await connections.connect({ id: 'antigravity-cli', model: 'gemini-4-neon-high', consentVersion: 1 });
    assert.equal(conn.providerId, 'antigravity-cli');
    assert.equal(providers.get('antigravity-cli') instanceof AntigravityCliProvider, true);

    const turn = await providers.get('antigravity-cli').turn({
      task: { id: 't1', title: 'Test', objective: 'Say hi', constraints: [], status: 'running', calls: 0, recoveries: 0 },
      files: [], events: [], tools: [],
    });
    assert.equal(turn.type, 'message');
    assert.equal(turn.text, 'Antigravity Neon reply');
    assert.equal(turn.evidenceKind, 'live_antigravity_cli');
    assert.equal(turn.usage?.total_tokens, 138);

    await connections.disconnect({ id: 'antigravity-cli' });
    assert.equal(providers.has('antigravity-cli'), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Local & HuggingFace provider manager persists models, redacts bearer keys, discovers stacks, and handles HF pulls/recipes', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'g0d-local-hf-'));
  try {
    // 1. HuggingFace ref normalization & recipe generation
    const hf1 = normalizeHuggingFaceRef('https://huggingface.co/unsloth/Qwen3-Coder-30B-A3B-GGUF/tree/main');
    assert.equal(hf1.repo, 'unsloth/Qwen3-Coder-30B-A3B-GGUF');
    assert.equal(hf1.ollamaTag, 'hf.co/unsloth/Qwen3-Coder-30B-A3B-GGUF');
    assert.match(hf1.recipes.llamacpp, /llama-server -hf unsloth\/Qwen3-Coder-30B-A3B-GGUF/);
    assert.match(hf1.recipes.vllm, /vllm serve unsloth\/Qwen3-Coder-30B-A3B-GGUF/);
    assert.match(hf1.recipes.mlx, /mlx_lm\.server --model unsloth\/Qwen3-Coder-30B-A3B-GGUF/);

    const hf2 = normalizeHuggingFaceRef('hf.co/bartowski/DeepSeek-R1-GGUF:Q4_K_M');
    assert.equal(hf2.quant, 'Q4_K_M');
    assert.equal(hf2.ollamaTag, 'hf.co/bartowski/DeepSeek-R1-GGUF:Q4_K_M');

    assert.throws(() => normalizeHuggingFaceRef('not-a-valid-repo; rm -rf /'), /valid HuggingFace/i);

    // 2. Mock local discovery & Ollama pull fetch
    const pullCalls = [];
    const fakeFetch = async (url, init = {}) => {
      const u = String(url);
      if (u === 'http://127.0.0.1:11434/api/tags') {
        return { ok: true, status: 200, json: async () => ({ models: [{ name: 'qwen2.5-coder:32b', size: 19e9, details: { parameter_size: '32B', quantization_level: 'Q4_K_M' } }] }) };
      }
      if (u === 'http://127.0.0.1:1234/v1/models') {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'mlx-community/Qwen3-Coder-4bit', owned_by: 'lmstudio' }] }) };
      }
      if (u === 'http://127.0.0.1:11434/api/pull' && init.method === 'POST') {
        pullCalls.push(JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => ({ status: 'success' }) };
      }
      throw new Error('ECONNREFUSED');
    };

    // 3. Register + persist + reload across fresh manager instance
    const providersA = new Map();
    const mgrA = await createLocalProviderManager({ dataDir: dir, providers: providersA, fetchImpl: fakeFetch });
    const reg = await mgrA.register({
      baseUrl: 'http://192.168.1.50:8000/v1',
      model: 'Qwen/Qwen3-Coder-30B-A3B-Instruct',
      apiKey: 'local-vllm-secret-token',
      stack: 'vllm',
    });
    assert.equal(reg.id, 'local:qwen-qwen3-coder-30b-a3b-instruct');
    assert.equal(reg.entry.hasApiKey, true);
    assert.equal(reg.entry.networkClass, 'lan');
    assert.equal('apiKey' in reg.entry, false); // never leak raw token in public view

    // Reload from disk in a brand-new manager
    const providersB = new Map();
    const mgrB = await createLocalProviderManager({ dataDir: dir, providers: providersB, fetchImpl: fakeFetch });
    assert.equal(providersB.has(reg.id), true);
    assert.equal(mgrB.list().registered.length, 1);
    assert.equal(mgrB.list().registered[0].hasApiKey, true);
    assert.deepEqual(mgrB.secrets(), ['local-vllm-secret-token']);

    // Cross-origin model collision MUST NOT carry over apiKey to a different host
    const moved = await mgrB.register({
      baseUrl: 'http://127.0.0.1:8000/v1',
      model: 'Qwen/Qwen3-Coder-30B-A3B-Instruct',
      stack: 'vllm',
    });
    assert.equal(moved.entry.hasApiKey, false);
    assert.deepEqual(mgrB.secrets(), []);

    // SSRF & fragment rejection in pullOllamaModel
    await assert.rejects(
      () => mgrB.pullOllamaModel({ model: 'qwen2.5:7b', baseUrl: 'http://127.0.0.1:11434/evil#' }),
      /fragments|credentials/i
    );

    // 4. Auto-discover running Ollama + LM Studio stacks
    const disc = await mgrB.discover();
    assert.equal(disc.models.length, 2);
    assert.ok(disc.models.some(m => m.stack === 'ollama' && m.model === 'qwen2.5-coder:32b' && m.parameterSize === '32B'));
    assert.ok(disc.models.some(m => m.stack === 'lmstudio' && m.model === 'mlx-community/Qwen3-Coder-4bit'));

    // 5. Pull HuggingFace GGUF into local Ollama (blocked in airgap, allowed normally)
    await assert.rejects(
      () => mgrB.pullOllamaModel({ model: 'unsloth/Qwen3-Coder-30B-A3B-GGUF:Q4_K_M', privacy: { localOnly: true } }),
      /Local-Only Airgap Mode/i
    );
    await assert.rejects(
      () => mgrB.pullOllamaModel({ model: 'qwen2.5:7b', baseUrl: 'http://192.168.1.50:11434' }),
      /loopback/i
    );
    const pulled = await mgrB.pullOllamaModel({ model: 'unsloth/Qwen3-Coder-30B-A3B-GGUF:Q4_K_M' });
    assert.equal(pulled.pulled, 'hf.co/unsloth/Qwen3-Coder-30B-A3B-GGUF:Q4_K_M');
    assert.equal(pullCalls[0]?.name, 'hf.co/unsloth/Qwen3-Coder-30B-A3B-GGUF:Q4_K_M');
    assert.equal(providersB.has(pulled.id), true);

    // 6. Full HTTP API roundtrip through createApp
    const app = await createApp({ dataDir: path.join(dir, 'srv'), providers: createScriptedProviders(), auth: false, startScheduler: false, fetchLocal: fakeFetch });
    try {
      const listRes = await dispatch(app, { method: 'GET', url: '/api/providers/local' });
      assert.equal(listRes.status, 200);
      assert.ok(Array.isArray(listRes.json.presets) && listRes.json.presets.length >= 6);

      const discRes = await dispatch(app, { method: 'POST', url: '/api/providers/local/discover', body: {} });
      assert.equal(discRes.status, 200);
      assert.equal(discRes.json.models.length, 2);

      const addRes = await dispatch(app, { method: 'POST', url: '/api/providers/local', body: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder:32b', apiKey: 'top-secret-local-tok' } });
      assert.equal(addRes.status, 200);
      assert.equal(addRes.json.localProviders.registered.length, 1);
      assert.equal(addRes.json.localProviders.registered[0].hasApiKey, true);
      assert.equal(addRes.text.includes('top-secret-local-tok'), false);

      const pullRes = await dispatch(app, { method: 'POST', url: '/api/providers/local/ollama-pull', body: { model: 'unsloth/Qwen3-Coder-30B-A3B-GGUF:Q4_K_M' } });
      assert.equal(pullRes.status, 200);
      assert.equal(pullRes.json.pulled, 'hf.co/unsloth/Qwen3-Coder-30B-A3B-GGUF:Q4_K_M');

      const delRes = await dispatch(app, { method: 'DELETE', url: `/api/providers/local?id=${encodeURIComponent(addRes.json.id)}` });
      assert.equal(delRes.status, 200);
      assert.equal(delRes.json.localProviders.registered.length, 1);

      const recRes = await dispatch(app, { method: 'POST', url: '/api/providers/local/hf-recipes', body: { ref: 'Qwen/Qwen3-Coder-30B-A3B-Instruct' } });
      assert.equal(recRes.status, 200);
      assert.match(recRes.json.recipes.ollama, /ollama pull hf\.co\/Qwen\/Qwen3-Coder-30B-A3B-Instruct/);
    } finally {
      await app.close();
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
