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
import { Runtime } from '../src/runtime.mjs';
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

test('AntigravityCliProvider reuses --conversation for KV cache, resets on recovery, and falls back on expired session', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'g0d-agy-sess-'));
  try {
    const logFile = path.join(dir, 'calls.log');
    const failOnceFlag = path.join(dir, 'fail-conv-once');
    const fakeAgy = path.join(dir, 'agy');
    await fs.writeFile(fakeAgy, `#!/bin/sh
BODY=$(cat)
printf "ARGS:%s|LEN:%s\\n" "$*" "\${#BODY}" >> "${logFile}"
case "$*" in
  *"--conversation conv-abc"*)
    if [ -f "${failOnceFlag}" ]; then
      rm -f "${failOnceFlag}"
      exit 1
    fi
    cat <<'EOF'
{"conversation_id":"conv-abc","status":"SUCCESS","num_turns":1,"response":"{\\"type\\":\\"message\\",\\"calls\\":[],\\"text\\":\\"Warm cache reply\\",\\"finish\\":\\"done\\"}","usage":{"input_tokens":80,"cache_read_tokens":5000,"output_tokens":12,"total_tokens":5092}}
EOF
    ;;
  *)
    cat <<'EOF'
{"conversation_id":"conv-abc","status":"SUCCESS","num_turns":1,"response":"{\\"type\\":\\"message\\",\\"calls\\":[],\\"text\\":\\"Fresh turn reply\\",\\"finish\\":\\"done\\"}","usage":{"input_tokens":5000,"cache_read_tokens":0,"output_tokens":20,"total_tokens":5020}}
EOF
    ;;
esac
`, { mode: 0o755 });

    const provider = new AntigravityCliProvider({ binary: fakeAgy, model: 'gemini-4-neon-medium' });
    try {
      const baseTask = { id: 'task-kv-1', title: 'KV', objective: 'Build feature', constraints: [], status: 'running', calls: 1, recoveries: 0, contractVersion: 1 };
      const bigContent = 'export const data = "' + 'x'.repeat(2000) + '";\n';
      const files = [{ path: 'src/big.mjs', content: bigContent, sha256: 'a'.repeat(64), bytes: bigContent.length }];

      // Turn 1: fresh session (no --conversation)
      const t1 = await provider.turn({ task: baseTask, files, history: [{ seq: 1, type: 'task.created', data: {} }], tools: [] });
      assert.equal(t1.text, 'Fresh turn reply');

      // Turn 2: same task, new tool event -> reuses --conversation conv-abc with compact delta payload
      const t2 = await provider.turn({
        task: { ...baseTask, calls: 2 },
        files,
        history: [
          { seq: 1, type: 'task.created', data: {} },
          { seq: 2, type: 'tool.completed', data: { name: 'repo.write', result: { ok: true, path: 'src/big.mjs' } } },
        ],
        tools: [],
      });
      assert.equal(t2.text, 'Warm cache reply');
      assert.equal(t2.usage?.cache_read_tokens, 5000);

      // Turn 3: expired warm session fails -> transparently falls back to fresh full-context turn
      await fs.writeFile(failOnceFlag, '1');
      const t3 = await provider.turn({
        task: { ...baseTask, calls: 3 },
        files,
        history: [
          { seq: 1, type: 'task.created', data: {} },
          { seq: 3, type: 'tool.completed', data: { name: 'check.run', result: { ok: true } } },
        ],
        tools: [],
      });
      assert.equal(t3.text, 'Fresh turn reply');

      // Turn 4: recovery/reframe increments recoveries -> MUST start fresh (no --conversation)
      const t4 = await provider.turn({
        task: { ...baseTask, calls: 4, recoveries: 1 },
        files,
        history: [
          { seq: 1, type: 'task.created', data: {} },
          { seq: 4, type: 'recovery.started', data: {} },
        ],
        tools: [],
      });
      assert.equal(t4.text, 'Fresh turn reply');

      // Stateless subagent call (history: []) on same task ID must NOT evict the cached parent session
      const tSub = await provider.turn({
        task: { ...baseTask, calls: 1, recoveries: 1 },
        files: [],
        history: [],
        tools: [],
      });
      assert.equal(tSub.text, 'Fresh turn reply');
      assert.equal(provider.sessions.get('task-kv-1')?.conversationId, 'conv-abc');

      const lines = (await fs.readFile(logFile, 'utf8')).trim().split('\n');
      assert.equal(lines.length, 6); // T1 fresh, T2 warm, T3 warm fail + T3 fresh fallback, T4 fresh after recovery, TSub stateless
      assert.equal(lines[0].includes('--conversation'), false);
      assert.equal(lines[1].includes('--conversation conv-abc'), true);
      const len1 = Number(lines[0].match(/LEN:(\d+)/)[1]);
      const len2 = Number(lines[1].match(/LEN:(\d+)/)[1]);
      assert.ok(len2 < len1, `Expected warm delta payload (${len2}) to be smaller than full Turn 1 payload (${len1})`);
      assert.equal(lines[2].includes('--conversation conv-abc'), true);
      assert.equal(lines[3].includes('--conversation'), false);
      assert.equal(lines[4].includes('--conversation'), false);
      assert.equal(lines[5].includes('--conversation'), false);
    } finally {
      await provider.close();
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Runtime isolates per-file INVALID_TOOL errors in multi-file repo.write batches so valid writes still land', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'g0d-batch-iso-'));
  const workDir = path.join(dir, 'work');
  await fs.mkdir(workDir, { recursive: true });
  await fs.writeFile(path.join(workDir, 'a.mjs'), 'export const a = 0;\n');
  await fs.writeFile(path.join(workDir, 'b.mjs'), 'export const b = 0;\n');
  await fs.writeFile(path.join(workDir, 'c.mjs'), 'export const c = 0;\n');

  let turnIdx = 0;
  const stub = {
    id: 'stub-batch',
    label: 'Stub Batch',
    available: true,
    capabilities: { tools: true, nativeTools: true, portableContext: true, nativeToolReplay: false, toolNames: ['repo.write'], instructionRole: 'system' },
    async turn() {
      turnIdx += 1;
      if (turnIdx === 1) {
        return {
          type: 'tool',
          calls: [
            { id: 'w1', name: 'repo.write', args: { path: 'a.mjs', content: 'export const a = 1;\n' } },
            // Malformed 63-char expectedHash typo on File #2 — must NOT abort File #3!
            { id: 'w2', name: 'repo.write', args: { path: 'b.mjs', content: 'export const b = 2;\n', expectedHash: 'f'.repeat(63) } },
            { id: 'w3', name: 'repo.write', args: { path: 'c.mjs', content: 'export const c = 3;\n' } },
          ],
        };
      }
      if (turnIdx === 2) {
        return {
          type: 'tool',
          calls: [
            { id: 'w2-fix', name: 'repo.write', args: { path: 'b.mjs', content: 'export const b = 2;\n' } },
          ],
        };
      }
      return { type: 'message', text: 'All three files written.', finish: 'done' };
    },
    close() {},
  };

  const runtime = new Runtime({ dataDir: path.join(dir, 'data'), providers: new Map([['stub-batch', stub]]), startScheduler: false });
  try {
    const task = await runtime.createTask({
      title: 'Batch Isolation Test',
      objective: 'Update a.mjs, b.mjs, c.mjs',
      workspace: workDir,
      providers: ['stub-batch'],
      policy: { mode: 'ask', maxCalls: 6, maxAttempts: 0, learning: false },
      acceptance: { mode: 'owner' },
      permissionRules: [{ tool: '*', action: 'allow', reason: 'test' }],
    });
    const done = await runtime.run(task.id);
    // Owner-acceptance tasks complete into waiting_input after the final finish="done" turn (turnIdx === 3).
    assert.equal(done.status, 'waiting_input');
    assert.equal(turnIdx, 3);
    assert.equal(await fs.readFile(path.join(workDir, 'a.mjs'), 'utf8'), 'export const a = 1;\n');
    assert.equal(await fs.readFile(path.join(workDir, 'b.mjs'), 'utf8'), 'export const b = 2;\n');
    assert.equal(await fs.readFile(path.join(workDir, 'c.mjs'), 'utf8'), 'export const c = 3;\n');
    const events = runtime.store.getEvents(task.id);
    assert.ok(events.some(e => e.type === 'tool.completed' && e.data?.operationId === `${task.id}:w2` && e.data?.result?.error?.code === 'INVALID_TOOL'));

    // Security regression: a prior recoverable INVALID_TOOL in a batch MUST NEVER mask a subsequent non-recoverable PATH_DENIED!
    const secStub = {
      id: 'stub-sec-batch',
      label: 'Stub Sec Batch',
      available: true,
      capabilities: { tools: true, nativeTools: true, portableContext: true, nativeToolReplay: false, toolNames: ['repo.write'], instructionRole: 'system' },
      async turn() {
        return {
          type: 'tool',
          calls: [
            { id: 's1', name: 'repo.write', args: { path: 'a.mjs', content: 'export const a = 2;\n' } },
            { id: 's2', name: 'repo.write', args: { path: 'b.mjs', content: 'export const b = 9;\n', expectedHash: 'f'.repeat(63) } },
            { id: 's3', name: 'repo.write', args: { path: '../escape.mjs', content: 'pwned\n' } },
          ],
        };
      },
      close() {},
    };
    const secRuntime = new Runtime({ dataDir: path.join(dir, 'sec-data'), providers: new Map([['stub-sec-batch', secStub]]), startScheduler: false });
    try {
      const secTask = await secRuntime.createTask({
        title: 'Security Non-Masking Test',
        objective: 'Attempt traversal after recoverable error',
        workspace: workDir,
        providers: ['stub-sec-batch'],
        policy: { mode: 'adaptive', maxCalls: 4, maxAttempts: 4, learning: false },
        acceptance: { mode: 'owner' },
        permissionRules: [{ tool: '*', action: 'allow', reason: 'test' }],
      });
      const blocked = await secRuntime.run(secTask.id);
      assert.equal(blocked.status, 'blocked');
      assert.equal(blocked.blocker?.code, 'PATH_DENIED');
    } finally {
      await secRuntime.close();
    }
  } finally {
    await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
