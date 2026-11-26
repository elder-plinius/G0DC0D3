import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

test('OpenRouter connects with expanded defaults, discovers live catalog models, and adds/removes any model using saved key', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'godcode-openrouter-catalog-'));
  const keychainRecords = new Map();
  const keychain = {
    read: id => keychainRecords.get(id) ?? null,
    write: (id, record) => keychainRecords.set(id, structuredClone(record)),
  };
  let catalogFetches = 0;
  const fakeOpenRouterModels = [
    {
      id: 'anthropic/claude-sonnet-4.6',
      name: 'Anthropic: Claude Sonnet 4.6',
      context_length: 200000,
      top_provider: { max_completion_tokens: 64000 },
      pricing: { prompt: '0.000003', completion: '0.000015' },
      supported_parameters: ['tools', 'reasoning'],
      architecture: { output_modalities: ['text'] },
    },
    {
      id: 'moonshotai/kimi-k2',
      name: 'MoonshotAI: Kimi K2',
      context_length: 131072,
      top_provider: { max_completion_tokens: 32768 },
      pricing: { prompt: '0.0000005', completion: '0.000002' },
      supported_parameters: ['tools'],
      architecture: { output_modalities: ['text'] },
    },
    {
      id: 'mistralai/devstral-small',
      name: 'Mistral: Devstral Small',
      context_length: 131072,
      pricing: { prompt: '0', completion: '0' },
      supported_parameters: ['tools'],
      architecture: { output_modalities: ['text'] },
    },
    {
      id: 'black-forest-labs/flux-pro',
      name: 'Flux Pro (Image only)',
      context_length: 0,
      architecture: { output_modalities: ['image'] },
    },
  ];

  const app = await createApp({
    dataDir,
    auth: false,
    keychain,
    providers: new Map(),
    fetchOpenRouterCatalog: async (url, init) => {
      assert.equal(url, 'https://openrouter.ai/api/v1/models');
      assert.equal(init.redirect, 'error');
      catalogFetches++;
      return Response.json({ data: fakeOpenRouterModels });
    },
  });
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const base = await app.listen(0);
  const req = async (method, route, body) => {
    const res = await fetch(base + route, {
      method,
      headers: { 'x-g0d-request': '1', 'content-type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };

  // Before connecting, OpenRouter catalog reports disconnected and makes no network call.
  const before = await req('GET', '/api/providers/openrouter-models');
  assert.equal(before.status, 200);
  assert.equal(before.data.connected, false);
  assert.equal(before.data.models.length, 0);
  assert.equal(catalogFetches, 0);

  // Connecting with an sk-or-v1-* key auto-detects OpenRouter and registers the expanded default set (>= 10 models).
  const connected = await req('POST', '/api/providers/key', { key: 'sk-or-v1-synthetic-openrouter-test-key' });
  assert.equal(connected.status, 200);
  assert.equal(connected.data.provider, 'openrouter');
  assert.equal(connected.data.storage, 'keychain');
  assert.ok(connected.data.registered.length >= 10, `expected >= 10 default OpenRouter models, got ${connected.data.registered.length}`);
  assert.ok(!JSON.stringify(connected.data).includes('synthetic-openrouter-test-key'));

  // Discovering live OpenRouter models returns all text models (skipping pure image-only) and caches them.
  const catalogRes = await req('GET', '/api/providers/openrouter-models');
  assert.equal(catalogRes.status, 200);
  assert.equal(catalogRes.data.connected, true);
  assert.equal(catalogFetches, 1);
  const slugs = catalogRes.data.models.map(m => m.model);
  assert.ok(slugs.includes('moonshotai/kimi-k2'));
  assert.ok(slugs.includes('mistralai/devstral-small'));
  assert.ok(!slugs.includes('black-forest-labs/flux-pro'));
  const kimi = catalogRes.data.models.find(m => m.model === 'moonshotai/kimi-k2');
  assert.equal(kimi.registered, false);
  assert.equal(kimi.name, 'MoonshotAI: Kimi K2');
  assert.equal(kimi.contextWindow, 131072);
  assert.deepEqual(kimi.pricing, { inputPer1M: 0.5, outputPer1M: 2 });

  // Adding any OpenRouter model reuses the saved Keychain key and persists it.
  const added = await req('POST', '/api/providers/models', { provider: 'openrouter', models: ['moonshotai/kimi-k2'] });
  assert.equal(added.status, 200);
  assert.deepEqual(added.data.added, ['openrouter:moonshotai-kimi-k2']);
  assert.ok(added.data.registered.includes('openrouter:moonshotai-kimi-k2'));
  assert.ok(keychainRecords.get('openrouter').models.includes('moonshotai/kimi-k2'));
  assert.ok(!JSON.stringify(added.data).includes('synthetic-openrouter-test-key'));

  // /api/state exposes openrouterConnectionId, connectedApiProviders, and provider.model.
  const stateRes = await req('GET', '/api/state');
  assert.equal(stateRes.status, 200);
  assert.ok(stateRes.data.openrouterConnectionId?.startsWith('openrouter:'));
  assert.ok(stateRes.data.connectedApiProviders.some(c => c.provider === 'openrouter'));
  const kimiProvider = stateRes.data.providers.find(p => p.id === 'openrouter:moonshotai-kimi-k2');
  assert.equal(kimiProvider?.model, 'moonshotai/kimi-k2');

  // Removing a model cleans it up from runtime providers and keychain.
  const removed = await req('DELETE', '/api/providers/models', { provider: 'openrouter', models: ['moonshotai/kimi-k2'] });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.data.removed, ['moonshotai/kimi-k2']);
  assert.ok(!keychainRecords.get('openrouter').models.includes('moonshotai/kimi-k2'));
  assert.equal(app.runtime.providers.has('openrouter:moonshotai-kimi-k2'), false);

  // Rejects adding models to an unconnected provider or with invalid model IDs.
  const unconnected = await req('POST', '/api/providers/models', { provider: 'anthropic', models: ['claude-sonnet-4-6'] });
  assert.equal(unconnected.status, 400);
  const invalid = await req('POST', '/api/providers/models', { provider: 'openrouter', models: ['bad model id!'] });
  assert.equal(invalid.status, 400);

  // Local-only privacy mode pauses OpenRouter catalog network refreshes.
  const localOnly = await req('PATCH', '/api/privacy', { localOnly: true });
  assert.equal(localOnly.status, 200);
  const paused = await req('GET', '/api/providers/openrouter-models?refresh=1');
  assert.equal(paused.status, 200);
  assert.equal(catalogFetches, 1);
  assert.equal(paused.data.stale, true);
  assert.match(paused.data.warning, /Local-only/i);
});
