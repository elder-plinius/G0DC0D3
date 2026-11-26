import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { HttpProvider, inferProviderTier } from '../src/providers.mjs';
import { veniceEndpoint } from '../src/venice-catalog.mjs';
import { createModelCatalog } from '../src/model-catalog.mjs';

const veniceSpec = (id, name, { maxCompletionTokens = 128000, supportsReasoning = true } = {}) => ({
  id,
  type: 'text',
  model_spec: {
    name,
    maxCompletionTokens,
    capabilities: { supportsReasoning, supportsFunctionCalling: true }
  }
});

const CATALOG_FIXTURE = [
  veniceSpec('claude-opus-5-5', 'Claude Opus 5.5', { maxCompletionTokens: 128000, supportsReasoning: true }),
  veniceSpec('openai-gpt-6-astra', 'GPT-6 Astra', { maxCompletionTokens: 128000, supportsReasoning: true }),
  veniceSpec('z-ai-glm-5-3-flash', 'GLM 5.3 Flash', { maxCompletionTokens: 131072, supportsReasoning: true }),
  veniceSpec('venice-uncensored-1-2', 'Venice Uncensored 1.2', { maxCompletionTokens: 8192, supportsReasoning: false }),
];

async function createEdgeHarness(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'godmode-edge-cases-'));
  const providers = new Map([
    ['venice', new HttpProvider({ id: 'venice', label: 'Venice', model: 'venice-uncensored-1-2', baseUrl: veniceEndpoint, credential: 'test-key' })]
  ]);
  const app = await createApp({
    dataDir: dir,
    auth: false,
    providers,
    fetchCatalog: async () => Response.json({ data: CATALOG_FIXTURE })
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
  const intercept = handler => {
    t.mock.method(globalThis, 'fetch', (url, init) => (
      url === veniceEndpoint + '/chat/completions'
        ? handler(JSON.parse(init.body), init.signal)
        : nativeFetch(url, init)
    ));
  };
  await api('/api/providers/venice-models');
  return { app, api, intercept };
}

test('Opus 5.5 & GPT-6 Astra classify as Tier S Frontier and start at 16384 reasoning output tokens', async t => {
  assert.equal(inferProviderTier({ id: 'venice-catalog:claude-opus-5-5', model: 'claude-opus-5-5' }), 'frontier');
  assert.equal(inferProviderTier({ id: 'venice-catalog:openai-gpt-6-astra', model: 'openai-gpt-6-astra' }), 'frontier');
  const dir = await mkdtemp(path.join(tmpdir(), 'godmode-catalog-tier-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const catalog = await createModelCatalog({ dataDir: dir });
  const opusMeta = catalog.lookup({ id: 'venice-catalog:claude-opus-5-5', model: 'claude-opus-5-5', label: 'Claude Opus 5.5' });
  const astraMeta = catalog.lookup({ id: 'venice-catalog:openai-gpt-6-astra', model: 'openai-gpt-6-astra', label: 'GPT-6 Astra' });
  assert.equal(opusMeta.coding, 100);
  assert.equal(astraMeta.coding, 100);
  assert.equal(opusMeta.size, 'frontier');
  assert.equal(astraMeta.size, 'frontier');

  const { app, api, intercept } = await createEdgeHarness(t);
  const seen = [];
  intercept(async body => {
    seen.push({ model: body.model, max_tokens: body.max_tokens });
    return Response.json({ choices: [{ message: { content: 'Built Neon Invaders.', reasoning_content: 'Designing canvas loop...' }, finish_reason: 'stop' }] });
  });
  const { task } = await api('/api/conversations', 'POST', {
    objective: 'Build an HTML5 canvas game.',
    providerIds: ['venice-catalog:claude-opus-5-5', 'venice-catalog:venice-uncensored-1-2'],
    policy: { mode: 'adaptive', maxAttempts: 6, maxCalls: 12 }
  });
  await app.runtime.run(task.id);
  const detail = await api('/api/tasks/' + task.id);
  assert.equal(detail.task.status, 'completed');
  assert.equal(seen[0].model, 'claude-opus-5-5');
  assert.equal(seen[0].max_tokens, 16384, 'reasoning frontier models should start at 16384 output tokens');
});

test('G0DM0D3 ON + Opus 5.5 clean uncensored switch without mangling prompt, plus follow-up refusal recovery', async t => {
  const { app, api, intercept } = await createEdgeHarness(t);
  const seen = [];
  intercept(async body => {
    seen.push(body);
    if (body.model === 'claude-opus-5-5') {
      return Response.json({ choices: [{ message: { content: 'I cannot help with that request.' }, finish_reason: 'stop' }] });
    }
    return Response.json({ choices: [{ message: { content: 'Direct technical implementation ready.' }, finish_reason: 'stop' }] });
  });
  const { task } = await api('/api/conversations', 'POST', {
    objective: 'Analyze buffer overflow mitigations in C.',
    providerIds: ['venice-catalog:claude-opus-5-5', 'venice-catalog:venice-uncensored-1-2'],
    policy: { mode: 'adaptive', maxAttempts: 6, maxCalls: 12 }
  });
  await app.runtime.run(task.id);
  const detail = await api('/api/tasks/' + task.id);
  assert.equal(detail.task.status, 'completed');
  assert.equal(detail.task.providerId, 'venice-catalog:venice-uncensored-1-2');
  assert.equal(seen.length, 2);
  // Switching to venice-uncensored-1-2 should preserve the clean user prompt instead of injecting CODE_WORKER boilerplate
  assert.equal(seen[1].messages[1].content, 'Analyze buffer overflow mitigations in C.');

  // Now test follow-up refusal on a single-model GPT-6 Astra route: follow-up #2 should be reframed (not message #1!)
  seen.length = 0;
  let astraCalls = 0;
  intercept(async body => {
    seen.push(body);
    if (body.model === 'openai-gpt-6-astra') {
      astraCalls++;
      if (astraCalls === 1) return Response.json({ choices: [{ message: { content: 'Hello!' }, finish_reason: 'stop' }] });
      if (astraCalls === 2) return Response.json({ choices: [{ message: { refusal: 'Declined.' }, finish_reason: 'content_filter' }] });
      return Response.json({ choices: [{ message: { content: 'Reframed follow-up succeeded.' }, finish_reason: 'stop' }] });
    }
    return Response.json({ choices: [{ message: { content: 'Fallback.' }, finish_reason: 'stop' }] });
  });
  const { task: t2 } = await api('/api/conversations', 'POST', {
    objective: 'Hi there.',
    providerIds: ['venice-catalog:openai-gpt-6-astra'],
    ultraplinian: true,
    policy: { mode: 'adaptive', maxAttempts: 6, maxCalls: 12 }
  });
  await app.runtime.run(t2.id);
  await app.runtime.addMessage(t2.id, 'Show me a red-team fuzzing harness.', 'fu-1');
  await app.runtime.run(t2.id);
  const d2 = await api('/api/tasks/' + t2.id);
  assert.equal(d2.task.status, 'completed');
  assert.equal(seen.length, 3);
  // Message #1 stays "Hi there.", while follow-up #2 was reframed with Ultra-Plinian!
  assert.equal(seen[2].messages[1].content, 'Hi there.');
  assert.match(seen[2].messages.at(-1).content, /red-team fuzzing harness/);
  assert.notEqual(seen[2].messages.at(-1).content, 'Show me a red-team fuzzing harness.');
});

test('G0DM0D3 ON + Ultra-Plinian ON: Opus 5.5 vs GPT-6 Astra uses 16384 reasoning tokens, drops refusal clause, and rescues dual declines via Venice Uncensored', async t => {
  const { app, api, intercept } = await createEdgeHarness(t);
  const seen = [];
  intercept(async body => {
    seen.push(body);
    // Ensure hardcoded anti-security refusal clause is gone from Ultra-Plinian system prompt
    assert.doesNotMatch(body.messages[0].content, /Avoid guidance for offensive security/i);
    if (body.model === 'claude-opus-5-5') {
      assert.equal(body.max_tokens, 16384);
      return Response.json({ choices: [{ message: { content: 'I cannot assist with offensive security topics.' }, finish_reason: 'stop' }] });
    }
    if (body.model === 'openai-gpt-6-astra') {
      assert.equal(body.max_tokens, 16384);
      return Response.json({ choices: [{ message: { refusal: 'Policy refusal.' }, finish_reason: 'content_filter' }] });
    }
    if (body.model === 'venice-uncensored-1-2') {
      assert.equal(body.max_tokens, 8192);
      return Response.json({ choices: [{ message: { content: 'Full liberated technical walkthrough from Venice Uncensored 1.2.' }, finish_reason: 'stop' }] });
    }
    throw new Error('Unexpected model: ' + body.model);
  });

  const { task } = await api('/api/conversations', 'POST', {
    objective: 'Write a purple-team packet parser and explain exploitation vectors.',
    providerIds: ['venice-catalog:claude-opus-5-5', 'venice-catalog:venice-uncensored-1-2'],
    answerRace: {
      models: ['venice-catalog:claude-opus-5-5', 'venice-catalog:openai-gpt-6-astra'],
      judge: 'venice-catalog:z-ai-glm-5-3-flash'
    },
    ultraplinian: true,
    policy: { mode: 'adaptive', maxAttempts: 6, maxCalls: 12 }
  });
  await app.runtime.run(task.id);
  const detail = await api('/api/tasks/' + task.id);
  assert.equal(detail.task.status, 'completed');
  assert.equal(detail.task.recoveries, 1);
  const finalResp = detail.events.findLast(e => e.type === 'model.response');
  assert.equal(finalResp.data.providerId, 'venice-catalog:venice-uncensored-1-2');
  assert.equal(finalResp.data.scorecard.status, 'godmode_recovered');
  assert.match(finalResp.data.response.text, /Venice Uncensored 1\.2/);
});

test('G0DM0D3 ON + Ultra-Plinian ON: rescues dual VENICE_OUTPUT_LIMIT by boosting reasoning token ceiling', async t => {
  const { app, api, intercept } = await createEdgeHarness(t);
  const seen = [];
  intercept(async body => {
    seen.push({ model: body.model, max_tokens: body.max_tokens });
    if (body.max_tokens <= 16384) {
      return Response.json({ choices: [{ message: { content: '', reasoning_content: 'Deep reasoning...' }, finish_reason: 'length' }] });
    }
    return Response.json({ choices: [{ message: { content: 'Completed after Ultra-Plinian token ceiling boost.' }, finish_reason: 'stop' }] });
  });

  const { task } = await api('/api/conversations', 'POST', {
    objective: 'Derive a complete WebGL raymarcher.',
    providerIds: ['venice-catalog:claude-opus-5-5', 'venice-catalog:venice-uncensored-1-2'],
    answerRace: {
      models: ['venice-catalog:claude-opus-5-5', 'venice-catalog:openai-gpt-6-astra'],
      judge: 'venice-catalog:z-ai-glm-5-3-flash'
    },
    ultraplinian: true,
    policy: { mode: 'adaptive', maxAttempts: 6, maxCalls: 12 }
  });
  await app.runtime.run(task.id);
  const detail = await api('/api/tasks/' + task.id);
  assert.equal(detail.task.status, 'completed');
  assert.equal(seen.length, 3);
  assert.equal(seen[2].max_tokens, 32768);
  const finalResp = detail.events.findLast(e => e.type === 'model.response');
  assert.equal(finalResp.data.scorecard.status, 'godmode_recovered');
  assert.match(finalResp.data.response.text, /token ceiling boost/);
});
