import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { formatPricePer1M, computeBlendedPrice, createModelCatalog, resolveCatalogEntry } from '../src/model-catalog.mjs';
import { createServiceStatus } from '../src/services.mjs';

test('price labels retain integer zeroes and unknown prices never become free', () => {
  for (const value of [10, 20, 100, 150]) assert.equal(formatPricePer1M(value), '$' + value);
  assert.equal(formatPricePer1M(0), '$0');
  assert.equal(formatPricePer1M(0.025), '$0.025');
  for (const value of [null, undefined, '', -1, Infinity]) assert.equal(formatPricePer1M(value), null);
  assert.equal(computeBlendedPrice({ inputPer1M: null, outputPer1M: 0 }), null);
  assert.equal(computeBlendedPrice({ inputPer1M: -1, outputPer1M: 1 }), null);
});

test('OpenRouter quotes apply only to OpenRouter; incomplete prices remain unknown', async () => {
  let calls = 0;
  const catalog = await createModelCatalog({ fetchImpl: async () => {
    calls++;
    return { ok: true, json: async () => ({data: [
      { id: 'anthropic/claude-haiku-4.5', pricing: { prompt: '0.000010', completion: '0.000020' }, context_length: 123456 },
      { id: 'vendor/unknown-model', pricing: { prompt: null, completion: '' } }
    ]}) };
  }});
  const model = { model: 'anthropic/claude-haiku-4.5', kind: 'http', baseUrl: 'https://api.venice.ai/api/v1' };
  const baseline = catalog.lookup(model);
  assert.equal(calls, 0, 'loading and looking up the catalog is offline');
  await assert.rejects(catalog.refresh({ privacy: { localOnly: true } }), { code: 'PRIVACY_LOCAL_ONLY' });
  assert.equal(calls, 0);
  await catalog.refresh();
  assert.equal(calls, 1);
  const live = catalog.lookup({ ...model, baseUrl: 'https://openrouter.ai/api/v1' });
  assert.deepEqual(live.pricing, { ...baseline.pricing, inputPer1M: 10, outputPer1M: 20 });
  assert.equal(live.contextWindow, 123456);
  assert.equal(live.pricingSource, 'openrouter-live');
  assert.deepEqual(catalog.lookup(model).pricing, baseline.pricing);
  assert.equal(catalog.lookup(model).contextWindow, baseline.contextWindow);
  const unknown = catalog.lookup({ model: 'vendor/unknown-model', baseUrl: 'https://openrouter.ai/api/v1' });
  assert.equal(unknown.pricing, null);
  assert.equal(unknown.pricingSource, 'unknown');
  assert.equal(live.rankingSource, 'heuristic');
  assert.equal(resolveCatalogEntry({ model: 'claude-haiku-4.5', kind: 'claude' }).coding, baseline.coding,
    'an explicit smaller subscription model is not promoted to a flagship score');
  assert.notEqual(resolveCatalogEntry({ model: 'o3-mini' }).family, 'OpenAI o3');
});

test('services scan only probes developer CLI versions, including in local-only mode', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'godmode-services-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = path.join(dir, 'fake-cli'), log = path.join(dir, 'calls');
  await writeFile(log, '');
  await writeFile(binary, `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))+'\\n');
console.log('test version 2.0.0');
`, { mode: 0o755 });
  const status = createServiceStatus({ providers: new Map(), home: dir,
    environment: { HOME: dir, PATH: process.env.PATH, G0D_GH_BINARY: binary, G0D_GIT_BINARY: binary, G0D_OLLAMA_BINARY: binary },
    getPrivacy: () => ({ localOnly: true }),
    cliConnections: { status: async () => ({ connections: [{id:'codex-cli',name:'Codex',installed:true,ready:true,authenticated:true,enabled:false}] }) }
  });
  for (const refresh of [false, true]) {
    const result = await status.status({refresh});
    assert.equal(result.devtools.find(service => service.id === 'github-cli').authenticated, null);
    assert.equal(result.subscriptions[0].enabled, false);
    assert.equal(result.subscriptions[0].statusLabel, 'Signed in · not added');
  }
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 6);
  assert.ok(calls.every(args => args.length === 1 && args[0] === '--version'), 'no implicit gh auth status network call');
});
