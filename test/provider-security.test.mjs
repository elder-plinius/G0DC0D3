import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HttpProvider } from '../src/providers.mjs';
import { createProviderSettings } from '../src/provider-settings.mjs';
import { createApp } from '../src/server.mjs';
import { listWorkflows, resolveWorkflow } from '../src/workflows.mjs';

test('provider URLs require TLS off loopback and reject credentials embedded in the URL', () => {
  const connect = baseUrl => new HttpProvider({ id: 'test', model: 'test', baseUrl });
  for (const address of ['http://api.example.invalid/v1', 'http://localhost.example.invalid', 'http://192.0.2.1',
    'https://user:password@model.example.invalid', 'http://127.0.0.1/?token=example', 'file:///tmp/model'])
    assert.throws(() => connect(address));
  for (const address of ['http://127.0.0.1:8000', 'http://127.1.2.3', 'http://[::1]:8000', 'https://model.example.invalid/v1'])
    assert.equal(connect(address).baseUrl, address);
  assert.equal(connect('http://localhost:9000/v1').baseUrl, 'http://127.0.0.1:9000/v1');
});

test('command networking requires an explicit grant in every workflow', () => {
  for (const { name } of listWorkflows()) assert.equal(resolveWorkflow(name).execution.network, false, name);
  assert.equal(resolveWorkflow('ultra-plinian').execution.enabled, true);
});

test('Keychain records restore and rotate the credential for every saved model', async t => {
  const records = new Map();
  const keychain = {
    read: id => records.get(id),
    write: (id, record) => records.set(id, structuredClone(record)),
  };
  const original = process.env.VENICE_API_KEY;
  const first = await createProviderSettings(new Map(), keychain);
  await first.connect({ provider: 'venice', key: 'synthetic-key-one', models: ['alpha'] });
  const providers = new Map();
  const restored = await createProviderSettings(providers, keychain);
  assert.equal(providers.get('venice:alpha').available, true);
  const rotated = await restored.connect({ provider: 'venice', key: 'synthetic-key-two', models: ['beta'] });
  assert.equal(rotated.storage, 'keychain');
  assert.deepEqual(rotated.registered, ['venice:alpha', 'venice:beta']);
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    seen.push({ url, auth: options.headers.authorization });
    return Response.json({ choices: [{ message: { content: 'synthetic' } }] });
  });
  for (const instance of providers.values())
    await instance.proposePatch({ objective: 'test', files: [], parameters: {}, signal: new AbortController().signal });
  assert.equal(seen.length, 2);
  for (const item of seen) assert.deepEqual(item, {
    url: 'https://api.venice.ai/api/v1/chat/completions', auth: 'Bearer synthetic-key-two',
  });
  assert.ok(process.env.VENICE_API_KEY === original);
  assert.ok(!JSON.stringify([...providers.values()]).includes('synthetic-key'));
  keychain.write = () => { throw new Error('Keychain unavailable'); };
  await assert.rejects(restored.connect({ key: 'unwritten-key', models: ['gamma'] }), /Keychain unavailable/);
  assert.equal(providers.has('venice:gamma'), false);
  assert.equal(records.get('venice').key, 'synthetic-key-two');
});

test('a standalone server accepts a session key without persisting it across restart', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'godcode-session-key-'));
  const original = process.env.VENICE_API_KEY;
  let app;
  try {
    app = await createApp({ dataDir, providers: new Map() });
    const url = await app.listen(0);
    const token = new URLSearchParams(new URL(app.accessUrl).hash.slice(1)).get('session');
    const result = await fetch(url + '/api/providers/key', {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-g0d-request': '1' },
      body: JSON.stringify({ provider: 'venice', key: 'synthetic-session-key', models: ['alpha'] }),
    });
    assert.equal(result.status, 200);
    const response = await result.json();
    assert.equal(response.storage, 'session');
    assert.deepEqual(response.registered, ['venice:alpha']);
    assert.ok(!JSON.stringify(response).includes('synthetic-session-key'));
    assert.ok(process.env.VENICE_API_KEY === original);
    await app.close();
    app = await createApp({ dataDir, providers: new Map() });
    assert.equal(app.runtime.providers.has('venice:alpha'), false);
  } finally {
    try { await app?.close(); } finally { await rm(dataDir, { recursive: true, force: true }); }
  }
});
