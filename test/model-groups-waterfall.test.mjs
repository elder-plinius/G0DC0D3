import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectRefusal } from '../src/routing.mjs';
import { classifyModel, buildModelGroups, MODEL_SORT_MODES } from '../src/model-groups.mjs';
import { createModelCatalog } from '../src/model-catalog.mjs';
import { HttpProvider } from '../src/providers.mjs';
import { Runtime } from '../src/runtime.mjs';
import { createApp } from '../src/server.mjs';

function makeStub(id, turns, { tier = 'frontier', model = id } = {}) {
  let i = 0;
  return {
    id, label: id, model, kind: 'http', tier, available: true, accounting: 'stub',
    capabilities: { tools: true, nativeTools: true, portableContext: true },
    async turn(ctx) {
      const fn = turns[Math.min(i++, turns.length - 1)];
      return typeof fn === 'function' ? fn(ctx, i) : fn;
    }
  };
}

function dispatch(app, { method = 'GET', url = '/' } = {}) {
  const address = app.server.address() || { address: '127.0.0.1', port: 4317 };
  if (!app.server.address()) app.server.address = () => address;
  const req = Readable.from([]);
  req.method = method; req.url = url;
  req.headers = { host: `127.0.0.1:${address.port}` };
  req.setTimeout = () => {};
  return new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      statusCode: 200, headersSent: false, setTimeout() {}, setHeader() {}, getHeader() {},
      writeHead(s) { this.statusCode = s; this.headersSent = true; },
      write(c) { chunks.push(Buffer.from(c)); },
      end(c) {
        if (c !== undefined) chunks.push(Buffer.from(c));
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch {}
        resolve({ status: this.statusCode, text, json });
      }
    };
    try { app.server.emit('request', req, res); } catch (e) { reject(e); }
  });
}

test('detectRefusal catches modern decline phrasings without false-positiving on code or missing-info replies', () => {
  // Real declines caught
  assert.ok(detectRefusal({ type: 'message', text: 'I apologize, but I cannot assist with this request.', finish: 'done' }));
  assert.ok(detectRefusal({ type: 'message', text: 'As an AI language model, I cannot fulfill this request.', finish: 'done' }));
  assert.ok(detectRefusal({ type: 'message', text: 'My purpose is to be helpful and harmless, so I must refrain from generating that.', finish: 'done' }));
  assert.ok(detectRefusal({ type: 'message', text: 'Sorry, I am unable to generate that content as it goes against my ethical guidelines.', finish: 'done' }));
  assert.ok(detectRefusal({ type: 'message', text: "That request isn’t something I can help with. I can explain the format.", finish: 'done' }));
  assert.ok(detectRefusal({ type: 'message', text: 'Declined.', finish: 'refusal' }));

  // Non-refusals stay null
  assert.equal(detectRefusal({ type: 'message', text: 'The example says “That request isn’t something I can help with.”', finish: 'done' }), null);
  assert.equal(detectRefusal({ type: 'message', text: 'Implemented the fix:\n```js\nexport const refuses = "I cannot help";\nconsole.log(refuses);\n```\nTests passed.', finish: 'done' }), null);
  assert.equal(detectRefusal({ type: 'message', text: 'I need the API key or missing file path before I can run this.', finish: 'done' }), null);
  assert.equal(detectRefusal({ type: 'message', text: 'Here is the implementation and summary of all changes.', finish: 'done' }), null);
});

test('Model groups classify modern models, order smartest-first, and respect ZDR & Local-Only privacy gates', () => {
  const providers = new Map([
    ['anthropic:claude-opus-4-6', new HttpProvider({ id: 'anthropic:claude-opus-4-6', model: 'claude-opus-4-6', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', credential: 'k' })],
    ['openai:gpt-5.4', new HttpProvider({ id: 'openai:gpt-5.4', model: 'gpt-5.4', protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1', credential: 'k' })],
    ['gemini:gemini-2.5-flash', new HttpProvider({ id: 'gemini:gemini-2.5-flash', model: 'gemini-2.5-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', credential: 'k' })],
    ['openrouter:deepseek-v3', new HttpProvider({ id: 'openrouter:deepseek-v3', model: 'deepseek/deepseek-chat-v3-0324', baseUrl: 'https://openrouter.ai/api/v1', credential: 'k' })],
    ['venice:venice-uncensored-1-2', new HttpProvider({ id: 'venice:venice-uncensored-1-2', model: 'venice-uncensored-1-2', baseUrl: 'https://api.venice.ai/api/v1', credential: 'k' })],
    ['ollama:qwen2.5-coder-14b', new HttpProvider({ id: 'ollama:qwen2.5-coder-14b', model: 'qwen2.5-coder:14b', baseUrl: 'http://127.0.0.1:11434/v1', tier: 'local' })],
    ['ollama:qwen2.5-coder-32b', new HttpProvider({ id: 'ollama:qwen2.5-coder-32b', model: 'qwen2.5-coder:32b', baseUrl: 'http://127.0.0.1:11434/v1', tier: 'local' })]
  ]);
  try {
    const opus = classifyModel(providers.get('anthropic:claude-opus-4-6'));
    const qwen32 = classifyModel(providers.get('ollama:qwen2.5-coder-32b'));
    const qwen14 = classifyModel(providers.get('ollama:qwen2.5-coder-14b'));
    assert.ok(opus.intelligence > qwen32.intelligence);
    assert.ok(qwen32.intelligence > qwen14.intelligence);
    assert.equal(qwen32.paramB, 32);
    assert.equal(qwen14.paramB, 14);
    assert.equal(opus.size, 'frontier');
    assert.equal(qwen32.size, 'large');
    assert.equal(qwen14.size, 'medium');
    assert.equal(qwen14.zdr.localOnly, true);

    const groups = buildModelGroups(providers);
    const byId = new Map(groups.map(g => [g.id, g]));
    // Flagship starts with Opus 4.6 then GPT-5.4
    assert.equal(byId.get('flagship-waterfall').providerIds[0], 'anthropic:claude-opus-4-6');
    assert.equal(byId.get('flagship-waterfall').providerIds[1], 'openai:gpt-5.4');
    // ZDR-only excludes Anthropic & OpenAI, keeps OpenRouter ZDR, Venice, and Ollama
    const zdrIds = byId.get('zdr-fortress').providerIds;
    assert.equal(zdrIds.includes('anthropic:claude-opus-4-6'), false);
    assert.equal(zdrIds.includes('openrouter:deepseek-v3'), true);
    assert.equal(zdrIds.includes('venice:venice-uncensored-1-2'), true);
    assert.equal(zdrIds.includes('ollama:qwen2.5-coder-32b'), true);
    assert.equal(zdrIds.includes('ollama:qwen2.5-coder-14b'), true);
    // Local-only keeps loopback Ollama ordered largest (32b) strictly ahead of smaller (14b)
    assert.deepEqual(byId.get('local-only').providerIds, ['ollama:qwen2.5-coder-32b', 'ollama:qwen2.5-coder-14b']);

    // Privacy gate filters groups automatically
    const airgapGroups = buildModelGroups(providers, { zdrRouting: true, strictZdr: false, localOnly: true, redactOutboundSecrets: true });
    assert.deepEqual(airgapGroups.find(g => g.id === 'all-smartest').providerIds, ['ollama:qwen2.5-coder-32b', 'ollama:qwen2.5-coder-14b']);
  } finally {
    for (const p of providers.values()) p.close();
  }
});

test('Sticky waterfall failover: steps smartest -> mid -> open-weight on declines and sticks with the working model', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'g0d-waterfall-'));
  const workDir = path.join(dir, 'work');
  await fs.mkdir(workDir, { recursive: true });
  await fs.writeFile(path.join(workDir, 'a.txt'), 'init\n');

  const callLog = [];
  const p1 = makeStub('tier1-flagship', [
    () => { callLog.push('tier1'); return { type: 'message', text: 'I apologize, but I cannot assist with this request.', finish: 'done' }; }
  ]);
  const p2 = makeStub('tier2-mid', [
    () => { callLog.push('tier2-write'); return { type: 'tool', calls: [{ id: 'w1', name: 'repo.write', args: { path: 'done.txt', content: 'from-tier2\n', expectedHash: null } }] }; },
    () => { callLog.push('tier2-done'); return { type: 'message', text: 'Completed turn 1 on tier2.', finish: 'done' }; },
    () => { callLog.push('tier2-decline'); return { type: 'message', text: 'As an AI language model, I cannot fulfill this follow-up request.', finish: 'done' }; }
  ]);
  const p3 = makeStub('tier3-open', [
    () => { callLog.push('tier3-done'); return { type: 'message', text: 'Handled follow-up cleanly on tier3.', finish: 'done' }; }
  ]);

  const runtime = new Runtime({
    dataDir: dir,
    providers: new Map([['tier1-flagship', p1], ['tier2-mid', p2], ['tier3-open', p3]])
  });
  try {
    const task = await runtime.createTask({
      title: 'Sticky Waterfall Test',
      objective: 'Create done.txt',
      workspace: workDir,
      providers: ['tier1-flagship', 'tier2-mid', 'tier3-open'],
      acceptance: { mode: 'owner' },
      policy: { mode: 'adaptive', maxAttempts: 10, maxCalls: 20, returnToPrimary: true, stickyOnRefusal: true }
    });

    // Turn 1: tier1 declines -> steps cleanly to tier2 -> writes file & finishes -> STICKS on tier2 (never bounces back to tier1!)
    const after1 = await runtime.run(task.id);
    assert.equal(after1.providerId, 'tier2-mid');
    assert.deepEqual(callLog, ['tier1', 'tier2-write', 'tier2-done']);

    // Follow-up: stays on tier2 -> tier2 declines -> steps down to tier3 and finishes!
    await runtime.addMessage(task.id, 'Now do the harder follow-up.');
    const after2 = await runtime.run(task.id);
    assert.equal(after2.providerId, 'tier3-open');
    assert.deepEqual(callLog, ['tier1', 'tier2-write', 'tier2-done', 'tier2-decline', 'tier3-done']);
  } finally {
    await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/models/groups supports sort modes and GET /api/services reports all CLI, devtool, and API services', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'g0d-groups-http-'));
  const providers = new Map([
    ['anthropic:claude-opus-4-6', new HttpProvider({ id: 'anthropic:claude-opus-4-6', model: 'claude-opus-4-6', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', credential: 'k' })],
    ['gemini:gemini-2.5-flash', new HttpProvider({ id: 'gemini:gemini-2.5-flash', model: 'gemini-2.5-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', credential: 'k' })],
    ['ollama:qwen2.5-coder-32b', new HttpProvider({ id: 'ollama:qwen2.5-coder-32b', model: 'qwen2.5-coder:32b', baseUrl: 'http://127.0.0.1:11434/v1', tier: 'local' })],
    ['ollama:qwen2.5-coder-14b', new HttpProvider({ id: 'ollama:qwen2.5-coder-14b', model: 'qwen2.5-coder:14b', baseUrl: 'http://127.0.0.1:11434/v1', tier: 'local' })]
  ]);
  const app = await createApp({ dataDir: dir, providers, auth: false });
  try {
    // Smartest first (default): Opus 4.6 -> Qwen 32b -> Gemini Flash -> Qwen 14b
    const res = await dispatch(app, { method: 'GET', url: '/api/models/groups' });
    assert.equal(res.status, 200);
    assert.equal(res.json.groups.length, 7);
    assert.equal(res.json.sortModes.length, MODEL_SORT_MODES.length);
    assert.equal(res.json.groups.find(g => g.id === 'all-smartest').providerIds[0], 'anthropic:claude-opus-4-6');

    // Cheapest / Free first: Local Ollama models (Free) -> Gemini Flash ($0.15/$0.60) -> Opus ($15/$75)
    const byPrice = await dispatch(app, { method: 'GET', url: '/api/models/groups?sort=price' });
    assert.equal(byPrice.status, 200);
    const priceIds = byPrice.json.groups.find(g => g.id === 'all-smartest').providerIds;
    assert.equal(priceIds[0], 'ollama:qwen2.5-coder-32b');
    assert.equal(priceIds[1], 'ollama:qwen2.5-coder-14b');
    assert.equal(priceIds[2], 'gemini:gemini-2.5-flash');
    assert.equal(priceIds[3], 'anthropic:claude-opus-4-6');

    // Largest Context first: Gemini 2.5 Flash (1M) -> Opus 4.6 (200K)
    const byCtx = await dispatch(app, { method: 'GET', url: '/api/models/groups?sort=context' });
    assert.equal(byCtx.json.groups.find(g => g.id === 'all-smartest').providerIds[0], 'gemini:gemini-2.5-flash');

    // Fastest first: Gemini 2.5 Flash (~180 tok/s) first
    const bySpeed = await dispatch(app, { method: 'GET', url: '/api/models/groups?sort=speed' });
    assert.equal(bySpeed.json.groups.find(g => g.id === 'all-smartest').providerIds[0], 'gemini:gemini-2.5-flash');

    // Unified Services API
    const svcRes = await dispatch(app, { method: 'GET', url: '/api/services' });
    assert.equal(svcRes.status, 200);
    assert.equal(svcRes.json.subscriptions.length, 4);
    assert.equal(svcRes.json.apis.length, 8);
    assert.ok(svcRes.json.devtools.some(d => d.id === 'github-cli'));
    assert.ok(svcRes.json.devtools.some(d => d.id === 'git-cli'));
    const localSvc = svcRes.json.devtools.find(d => d.id === 'local-inference');
    assert.equal(localSvc.status, 'connected');
    assert.equal(localSvc.modelCount, 2);
    assert.equal(svcRes.json.apis.find(a => a.id === 'anthropic').status, 'connected');
    assert.equal(svcRes.json.apis.find(a => a.id === 'venice').status, 'unconfigured');
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Model catalog live OpenRouter pricing overlay caches to disk and respects Local-Only airgap gate', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'g0d-catalog-'));
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        data: [
          {
            id: 'deepseek/deepseek-chat-v3-0324',
            context_length: 163840,
            pricing: { prompt: '0.00000019', completion: '0.00000075' },
            top_provider: { max_completion_tokens: 32768 }
          }
        ]
      };
    }
  });
  try {
    const catalog = await createModelCatalog({ dataDir: dir, fetchImpl: mockFetch });
    // Local-Only airgap blocks live pricing sync cleanly
    await assert.rejects(
      () => catalog.refresh({ privacy: { zdrRouting: true, strictZdr: false, localOnly: true, redactOutboundSecrets: true } }),
      err => err.code === 'PRIVACY_LOCAL_ONLY'
    );

    // Allowed refresh fetches, overlays live pricing & context, and persists to disk
    const synced = await catalog.refresh({ privacy: { zdrRouting: true, strictZdr: false, localOnly: false, redactOutboundSecrets: true } });
    assert.equal(synced.ok, true);
    assert.equal(synced.count, 1);

    const ds = new HttpProvider({ id: 'openrouter:deepseek-v3', model: 'deepseek/deepseek-chat-v3-0324', baseUrl: 'https://openrouter.ai/api/v1', credential: 'k' });
    const meta = classifyModel(ds, { catalog });
    assert.equal(meta.pricingSource, 'openrouter-live');
    assert.equal(meta.pricing.inputPer1M, 0.19);
    assert.equal(meta.pricing.outputPer1M, 0.75);
    assert.equal(meta.contextWindow, 163840);
    assert.equal(meta.priceLabel, '$0.19 / $0.75');

    // Re-hydrated catalog reads disk cache offline without network
    const reloaded = await createModelCatalog({ dataDir: dir, fetchImpl: async () => { throw new Error('no network'); } });
    assert.equal(reloaded.meta().liveCount, 1);
    assert.equal(classifyModel(ds, { catalog: reloaded }).pricing.inputPer1M, 0.19);
    ds.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Single-model GodMode retries with reframing on refusal instead of stopping at 0 retries', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'g0d-solo-retry-'));
  const workDir = path.join(dir, 'work');
  await fs.mkdir(workDir, { recursive: true });
  const seenObjectives = [];
  const solo = makeStub('solo-model', [
    ctx => { seenObjectives.push(ctx.task.objective); return { type: 'message', text: "That request isn’t something I can help with.", finish: 'done' }; },
    ctx => { seenObjectives.push(ctx.task.objective); return { type: 'message', text: 'Here is the complete technical answer.', finish: 'done' }; }
  ]);
  const runtime = new Runtime({ dataDir: dir, providers: new Map([['solo-model', solo]]) });
  try {
    const task = await runtime.createTask({
      title: 'Solo Refusal Retry',
      objective: 'Explain memory safety techniques.',
      workspace: workDir,
      workspaceKind: 'conversation',
      providers: ['solo-model'],
      acceptance: { mode: 'owner' },
      policy: { mode: 'adaptive', maxAttempts: 4, maxCalls: 10 }
    });
    const done = await runtime.run(task.id);
    assert.equal(done.status, 'completed');
    assert.equal(done.recoveries, 1);
    assert.equal(seenObjectives.length, 2);
    assert.notEqual(seenObjectives[0], seenObjectives[1]);
  } finally {
    await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
