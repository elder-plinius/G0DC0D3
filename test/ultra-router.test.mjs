import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { HttpProvider, toolAliases } from '../src/providers.mjs';
import { compileInstructions, PROMPT_VERSION } from '../src/prompts.mjs';
import { veniceEndpoint } from '../src/venice-catalog.mjs';
import { classifyPromptDomain, routeUltraPlinian, loadBenchmarkMatrix, ROUTER_DOMAINS } from '../src/ultra-router.mjs';
import { emptyLearning, applyDomainOutcome } from '../src/learning.mjs';
import { TOOLS } from '../src/tool-schema.mjs';

const veniceSpec = (id, name, { maxCompletionTokens = 128000, supportsReasoning = true } = {}) => ({
  id,
  type: 'text',
  model_spec: { name, maxCompletionTokens, capabilities: { supportsReasoning, supportsFunctionCalling: true } }
});

const ROUTER_CATALOG = [
  veniceSpec('claude-opus-5-5', 'Claude Opus 5.5', { maxCompletionTokens: 128000, supportsReasoning: true }),
  veniceSpec('openai-gpt-6-astra', 'GPT-6 Astra', { maxCompletionTokens: 128000, supportsReasoning: true }),
  veniceSpec('gemini-4-carbon', 'Gemini 4 Carbon', { maxCompletionTokens: 65536, supportsReasoning: true }),
  veniceSpec('deepseek-v4-1-flash-uncensored', 'DeepSeek V4.1 Flash Uncensored', { maxCompletionTokens: 131072, supportsReasoning: true }),
  veniceSpec('z-ai-glm-5-3-flash', 'GLM 5.3 Flash', { maxCompletionTokens: 131072, supportsReasoning: true }),
  veniceSpec('venice-uncensored-1-2', 'Venice Uncensored 1.2', { maxCompletionTokens: 8192, supportsReasoning: false }),
];

test('Semantic tool aliases use clean repo__read names while preserving legacy g0d_ hash decoding, and prompt v18 includes long-horizon discipline', () => {
  const aliases = toolAliases(TOOLS);
  assert.equal(aliases.forward.get('repo.read'), 'repo__read');
  assert.equal(aliases.forward.get('repo.patch'), 'repo__patch');
  assert.equal(aliases.forward.get('process.run'), 'process__run');
  assert.equal(aliases.reverse.get('repo__read'), 'repo.read');
  assert.equal(PROMPT_VERSION, 'g0dc0d3-worker/18');

  const prompt = compileInstructions({
    task: { workspaceKind: 'project', persona: 'plinian', execution: { enabled: true, network: false, timeoutMs: 30000 } },
    files: [],
    tools: TOOLS
  });
  assert.match(prompt, /Long-horizon discipline/i);
  assert.match(prompt, /task\.todo/);
  assert.match(prompt, /workingSummary/);
  assert.match(prompt, /agent\.spawn/);
});

test('Ultra-Plinian task classifier & dual-objective router pick peak frontier models for SWE/UI/Math and preemptively route security research toward high-agency uncensored models', () => {
  assert.equal(ROUTER_DOMAINS.length, 8);
  const matrix = loadBenchmarkMatrix();
  assert.ok(matrix.models.length >= 20);

  const candidates = ROUTER_CATALOG.map(m => ({
    id: 'venice-catalog:' + m.id,
    model: m.id,
    label: m.model_spec.name,
    available: true
  }));

  // 1) Frontend / HTML5 game -> Claude Opus 5.5
  const uiDecision = routeUltraPlinian({
    objective: 'Build an interactive HTML5 Canvas Breakout game with responsive CSS layout and neon shaders.',
    candidates
  });
  assert.equal(uiDecision.domain, 'frontend_ui');
  assert.equal(uiDecision.selectedId, 'venice-catalog:claude-opus-5-5');
  assert.ok(uiDecision.waterfallIds.includes('venice-catalog:venice-uncensored-1-2') || uiDecision.waterfallIds.includes('venice-catalog:deepseek-v4-1-flash-uncensored'));

  // 2) Deep math / algorithms -> GPT-6 Astra
  const mathDecision = routeUltraPlinian({
    objective: 'Prove the convergence bound of this dynamic programming graph algorithm and derive the elliptic curve complexity.',
    candidates
  });
  assert.equal(mathDecision.domain, 'math_reasoning');
  assert.equal(mathDecision.selectedId, 'venice-catalog:openai-gpt-6-astra');

  // 3) Huge context -> Gemini 4 Carbon (1M context)
  const longCtx = routeUltraPlinian({
    objective: 'Summarize all files across the entire repo architecture.',
    files: Array.from({ length: 30 }, (_, i) => ({ path: `src/f${i}.mjs`, bytes: 4000 })),
    candidates
  });
  assert.equal(longCtx.domain, 'long_context');
  assert.equal(longCtx.selectedId, 'venice-catalog:gemini-4-carbon');

  // 4) High-sensitivity security research -> preemptively routes away from censored frontier toward DeepSeek V4.1 Flash Uncensored!
  const secDecision = routeUltraPlinian({
    objective: 'Write a red-team reverse engineering ROP chain exploit payload and shellcode fuzzing harness.',
    candidates
  });
  assert.equal(secDecision.domain, 'security_research');
  assert.ok(secDecision.refusalRisk >= 0.9);
  assert.equal(secDecision.selectedId, 'venice-catalog:deepseek-v4-1-flash-uncensored');
});

test('Per-user Domain Elo self-optimization shifts routing decisions based on local race wins, refusals, and custom JSON benchmark overrides', () => {
  const candidates = ROUTER_CATALOG.map(m => ({
    id: 'venice-catalog:' + m.id,
    model: m.id,
    label: m.model_spec.name,
    available: true
  }));

  let learning = emptyLearning();
  // Simulate user's local history: GPT-6 Astra repeatedly beats Claude Opus 5.5 in swe_coding, AND Opus 5.5 refused twice
  for (let i = 0; i < 6; i++) {
    learning = applyDomainOutcome(learning, {
      domain: 'swe_coding',
      providerId: 'venice-catalog:openai-gpt-6-astra',
      opponentId: 'venice-catalog:claude-opus-5-5',
      outcome: 'race_win',
      margin: 3
    });
  }
  learning = applyDomainOutcome(learning, { domain: 'swe_coding', providerId: 'venice-catalog:claude-opus-5-5', outcome: 'refusal' });

  const adapted = routeUltraPlinian({
    objective: 'Debug the SQLite transaction race condition in our Node.js backend API server.',
    candidates,
    learning
  });
  assert.equal(adapted.domain, 'swe_coding');
  assert.equal(adapted.selectedId, 'venice-catalog:openai-gpt-6-astra', 'per-user Elo wins + refusal avoidance should elevate GPT-6 Astra over Opus 5.5');

  // Custom benchmark JSON override can elevate any model directly
  const custom = routeUltraPlinian({
    objective: 'Debug the Node.js backend API server.',
    candidates,
    settings: {
      mode: 'auto_route',
      customBenchmarks: {
        'venice-catalog:venice-uncensored-1-2': { compliance: 100, domains: { swe_coding: 100 } }
      },
      domainPins: { swe_coding: 'venice-catalog:venice-uncensored-1-2' }
    }
  });
  assert.equal(custom.selectedId, 'venice-catalog:venice-uncensored-1-2');
});

test('End-to-end Ultra-Plinian Auto-Route & Auto-Arena HTTP API routes conversations, records receipts, and trains local domain Elo', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'godmode-ultra-router-'));
  const providers = new Map([
    ['venice', new HttpProvider({ id: 'venice', label: 'Venice', model: 'venice-uncensored-1-2', baseUrl: veniceEndpoint, credential: 'test-key' })]
  ]);
  const app = await createApp({
    dataDir: dir,
    auth: false,
    providers,
    fetchCatalog: async () => Response.json({ data: ROUTER_CATALOG })
  });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const root = await app.listen(0);
  const nativeFetch = globalThis.fetch;
  const api = async (route, method = 'GET', body) => {
    const res = await nativeFetch(root + route, {
      method,
      headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    return { status: res.status, ...await res.json() };
  };

  // Enable Ultra-Plinian Auto-Route via PATCH /api/router
  const routerState = await api('/api/router', 'PATCH', { mode: 'auto_route' });
  assert.equal(routerState.status, 200);
  assert.equal(routerState.settings.mode, 'auto_route');
  assert.ok(routerState.leaderboards.swe_coding.length >= 4);

  // Preview a security prompt via POST /api/router/preview
  const preview = await api('/api/router/preview', 'POST', { objective: 'Build a red-team exploit fuzzer and reverse engineering disassembler.' });
  assert.equal(preview.domain, 'security_research');
  assert.equal(preview.selectedId, 'venice-catalog:deepseek-v4-1-flash-uncensored');

  // Run an actual conversation with Auto-Route active and verify router.selected receipt + domain Elo increment!
  const dispatched = [];
  t.mock.method(globalThis, 'fetch', (url, init) => {
    if (url !== veniceEndpoint + '/chat/completions') return nativeFetch(url, init);
    const body = JSON.parse(init.body);
    dispatched.push(body.model);
    return Response.json({ choices: [{ message: { content: 'Routed response complete.' }, finish_reason: 'stop' }] });
  });
  const created = await api('/api/conversations', 'POST', {
    objective: 'Build a responsive HTML5 Canvas Breakout game with animations.',
    providerIds: ['venice-catalog:venice-uncensored-1-2'], // Auto-Route should override toward Claude Opus 5.5!
    policy: { mode: 'adaptive', maxAttempts: 6, maxCalls: 12 }
  });
  assert.equal(created.status, 201);
  assert.equal(created.task.providerId, 'venice-catalog:claude-opus-5-5');
  await app.runtime.run(created.task.id);
  const detail = await api('/api/tasks/' + created.task.id);
  assert.equal(detail.task.status, 'completed');
  assert.deepEqual(dispatched, ['claude-opus-5-5']);
  const receipt = detail.events.find(e => e.type === 'router.selected');
  assert.ok(receipt);
  assert.equal(receipt.data.domain, 'frontend_ui');

  // Verify local domain Elo recorded the win for Claude Opus 5.5 in frontend_ui
  const afterRouter = await api('/api/router');
  assert.ok((afterRouter.domainElo.frontend_ui?.['venice-catalog:claude-opus-5-5']?.elo || 1500) > 1500);

  // Reset router & Elo cleanly
  const reset = await api('/api/router/reset', 'DELETE', {});
  assert.equal(reset.settings.mode, 'off');
  assert.deepEqual(reset.domainElo, {});
});
