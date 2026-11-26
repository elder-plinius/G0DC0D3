import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import {
  HttpProvider,
  buildCodexExecArgs,
  buildClaudeExecArgs,
  normalizeCliSettings,
} from '../src/providers.mjs';
import { readLocalCodexConfig } from '../src/provider-connections.mjs';

async function fakeCli(dir, name, script) {
  const file = path.join(dir, name);
  await writeFile(file, '#!/bin/sh\n' + script + '\n');
  await chmod(file, 0o755);
  return file;
}

test('buildCodexExecArgs propagates native reasoning effort, service tier, verbosity, and composer effort fallback', () => {
  const base = buildCodexExecArgs({
    schemaPath: '/tmp/schema.json',
    cwd: '/tmp/ws',
    model: 'gpt-5.4',
    taskEffort: 'max',
    cliSettings: {},
  });
  assert.ok(base.includes('--model'));
  assert.ok(base.includes('gpt-5.4'));
  assert.ok(base.includes('model_reasoning_effort="xhigh"'));

  const fast = buildCodexExecArgs({
    schemaPath: '/tmp/schema.json',
    cwd: '/tmp/ws',
    model: 'gpt-5.3-codex',
    taskEffort: 'fast',
    cliSettings: {},
  });
  assert.ok(fast.includes('model_reasoning_effort="low"'));

  const explicit = buildCodexExecArgs({
    schemaPath: '/tmp/schema.json',
    cwd: '/tmp/ws',
    model: 'gpt-5.4',
    taskEffort: 'medium',
    cliSettings: { reasoningEffort: 'high', serviceTier: 'fast', verbosity: 'low' },
  });
  assert.ok(explicit.includes('model_reasoning_effort="high"'));
  assert.ok(explicit.includes('service_tier="fast"'));
  assert.ok(explicit.includes('model_verbosity="low"'));

  assert.deepEqual(normalizeCliSettings('codex-cli', { reasoningEffort: 'xhigh', serviceTier: 'flex', verbosity: 'high' }), {
    reasoningEffort: 'xhigh',
    serviceTier: 'flex',
    verbosity: 'high',
  });
  assert.deepEqual(normalizeCliSettings('codex-cli', { reasoningEffort: 'invalid', serviceTier: 'bogus', verbosity: 'nope' }), {
    reasoningEffort: null,
    serviceTier: null,
    verbosity: null,
  });
});

test('buildClaudeExecArgs propagates --effort and supports fallback without --effort', () => {
  const withEffort = buildClaudeExecArgs({
    schemaJson: '{}',
    systemPrompt: 'sys',
    model: 'claude-opus-4-6',
    taskEffort: 'max',
    cliSettings: {},
  });
  const effIdx = withEffort.indexOf('--effort');
  assert.ok(effIdx > -1);
  assert.equal(withEffort[effIdx + 1], 'max');
  assert.ok(withEffort.includes('claude-opus-4-6'));

  const override = buildClaudeExecArgs({
    schemaJson: '{}',
    systemPrompt: 'sys',
    model: 'claude-sonnet-4-6',
    taskEffort: 'medium',
    cliSettings: { effort: 'high' },
  });
  assert.equal(override[override.indexOf('--effort') + 1], 'high');

  const withoutEffort = buildClaudeExecArgs({
    schemaJson: '{}',
    systemPrompt: 'sys',
    model: 'claude-sonnet-4-6',
    taskEffort: 'max',
    cliSettings: { effort: 'max' },
    includeEffort: false,
  });
  assert.ok(!withoutEffort.includes('--effort'));
});

test('readLocalCodexConfig reads top-level model, reasoning effort, and service tier without touching credentials', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'godmode-codex-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, '.codex'), { recursive: true });
  await writeFile(
    path.join(home, '.codex', 'config.toml'),
    [
      '# user codex defaults',
      'model = "gpt-5.4-custom"',
      'model_reasoning_effort = "xhigh"',
      'service_tier = "fast"',
      '',
      '[profiles.other]',
      'model = "ignored-in-section"',
    ].join('\n')
  );
  const cfg = await readLocalCodexConfig({}, home);
  assert.deepEqual(cfg, {
    model: 'gpt-5.4-custom',
    reasoningEffort: 'xhigh',
    serviceTier: 'fast',
  });
});

test('CLI connections expose full model lineup, support PATCH settings/models, persist across restart, and cleanly disconnect all children', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'godmode-cli-multi-'));
  const home = path.join(dir, 'home');
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(home, '.codex'), { recursive: true });
  await writeFile(
    path.join(home, '.codex', 'config.toml'),
    'model = "gpt-5.4"\nmodel_reasoning_effort = "high"\nservice_tier = "fast"\n'
  );
  const codexBin = await fakeCli(dir, 'codex', 'echo "Logged in using ChatGPT"');
  const claudeBin = await fakeCli(dir, 'claude', 'echo \'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}\'');

  const start = async () => {
    const app = await createApp({
      dataDir: path.join(dir, 'data'),
      auth: false,
      providers: new Map(),
      cliDiscovery: {
        environment: { G0D_CODEX_BINARY: codexBin, G0D_CLAUDE_BINARY: claudeBin },
        home,
      },
    });
    const url = await app.listen(0);
    const api = async (route, method = 'GET', body, expected = 200) => {
      const res = await fetch(url + route, {
        method,
        headers: { 'x-g0d-request': '1', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = await res.json();
      assert.equal(res.status, expected, JSON.stringify(json));
      return json;
    };
    return { app, api };
  };

  let cur = await start();
  t.after(() => cur.app?.close());

  // Connect Codex with consent
  const connRes = await cur.api('/api/providers/connections', 'POST', { id: 'codex-cli', consentVersion: 1 });
  const codexEntry = connRes.connections.find(c => c.id === 'codex-cli');
  assert.equal(codexEntry.enabled, true);
  assert.ok(codexEntry.models.includes('gpt-5.4'));
  assert.ok(codexEntry.models.includes('gpt-5.3-codex'));
  assert.equal(codexEntry.settings.reasoningEffort, 'high');
  assert.equal(codexEntry.settings.serviceTier, 'fast');
  assert.ok(cur.app.runtime.providers.has('codex-cli'));
  assert.ok(cur.app.runtime.providers.has('codex-cli:gpt-5.4'));
  assert.ok(cur.app.runtime.providers.has('codex-cli:gpt-5.3-codex'));
  assert.equal(cur.app.runtime.providers.get('codex-cli:gpt-5.4').cliSettings.reasoningEffort, 'high');

  // Connect Claude Code with consent
  await cur.api('/api/providers/connections', 'POST', { id: 'claude-code', consentVersion: 1 });
  assert.ok(cur.app.runtime.providers.has('claude-code'));
  assert.ok(cur.app.runtime.providers.has('claude-code:claude-opus-4-6'));
  assert.ok(cur.app.runtime.providers.has('claude-code:claude-sonnet-4-6'));
  assert.ok(cur.app.runtime.providers.has('claude-code:claude-haiku-4-5'));

  // PATCH Codex models + settings
  const patchRes = await cur.api('/api/providers/connections', 'PATCH', {
    id: 'codex-cli',
    models: ['gpt-5.4', 'gpt-5.4-preview-lab'],
    settings: { reasoningEffort: 'xhigh', serviceTier: 'flex', verbosity: 'low' },
  });
  const updatedCodex = patchRes.connections.find(c => c.id === 'codex-cli');
  assert.deepEqual(updatedCodex.models, ['gpt-5.4', 'gpt-5.4-preview-lab']);
  assert.equal(updatedCodex.settings.reasoningEffort, 'xhigh');
  assert.equal(updatedCodex.settings.serviceTier, 'flex');
  assert.equal(updatedCodex.settings.verbosity, 'low');
  assert.ok(cur.app.runtime.providers.has('codex-cli:gpt-5.4-preview-lab'));
  assert.ok(!cur.app.runtime.providers.has('codex-cli:gpt-5.3-codex'));
  assert.equal(cur.app.runtime.providers.get('codex-cli:gpt-5.4-preview-lab').cliSettings.reasoningEffort, 'xhigh');

  // Restart and verify full persistence
  await cur.app.close();
  cur = await start();
  assert.ok(cur.app.runtime.providers.has('codex-cli:gpt-5.4-preview-lab'));
  assert.equal(cur.app.runtime.providers.get('codex-cli:gpt-5.4-preview-lab').cliSettings.reasoningEffort, 'xhigh');
  assert.ok(cur.app.runtime.providers.has('claude-code:claude-opus-4-6'));

  // Disconnect both and confirm zero stale child providers remain
  await cur.api('/api/providers/connections', 'DELETE', { id: 'codex-cli' });
  await cur.api('/api/providers/connections', 'DELETE', { id: 'claude-code' });
  assert.equal(cur.app.runtime.providers.size, 0);
});

test('Direct OpenAI and Anthropic catalogs fetch live /v1/models, filter non-chat models, respect localOnly, and fall back gracefully', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'godmode-direct-cat-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  let mode = 'ok';
  const calls = [];
  const fetchProviderCatalog = async (url, init) => {
    calls.push({ url, headers: init?.headers || {} });
    if (mode === 'error') return new Response('upstream error', { status: 500 });
    if (url.startsWith('https://api.openai.com/v1/models')) {
      return Response.json({
        data: [
          { id: 'gpt-5.4', created: 1790000000 },
          { id: 'gpt-5.4-pro', created: 1790000100 },
          { id: 'gpt-5.3-codex', created: 1789000000 },
          { id: 'whisper-1', created: 1700000000 },
          { id: 'dall-e-3', created: 1700000000 },
          { id: 'text-embedding-3-large', created: 1700000000 },
        ],
      });
    }
    if (url.startsWith('https://api.anthropic.com/v1/models')) {
      return Response.json({
        data: [
          { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6', created_at: '2026-08-01T00:00:00Z' },
          { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', created_at: '2026-08-01T00:00:00Z' },
          { id: 'claude-opus-4-7-preview', display_name: 'Claude Opus 4.7 Preview', created_at: '2026-11-01T00:00:00Z' },
        ],
      });
    }
    return new Response('not found', { status: 404 });
  };

  const app = await createApp({
    dataDir: dir,
    auth: false,
    providers: new Map(),
    fetchProviderCatalog,
  });
  t.after(() => app.close());
  const url = await app.listen(0);
  const api = async (route, method = 'GET', body, expected = 200) => {
    const res = await fetch(url + route, {
      method,
      headers: { 'x-g0d-request': '1', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json();
    assert.equal(res.status, expected, JSON.stringify(json));
    return json;
  };

  // Disconnected initially
  const emptyOai = await api('/api/providers/catalog?provider=openai');
  assert.equal(emptyOai.connected, false);

  // Connect OpenAI & Anthropic API keys
  await api('/api/providers/key', 'POST', { provider: 'openai', key: 'sk-test-openai-key-12345' });
  await api('/api/providers/key', 'POST', { provider: 'anthropic', key: 'sk-ant-test-key-12345' });

  // OpenAI live catalog filters out whisper/dall-e/embedding and includes gpt-5.4-pro
  const oaiCat = await api('/api/providers/catalog?provider=openai');
  assert.equal(oaiCat.connected, true);
  assert.equal(oaiCat.stale, false);
  assert.ok(oaiCat.models.some(m => m.model === 'gpt-5.4-pro'));
  assert.ok(oaiCat.models.some(m => m.model === 'gpt-5.4' && m.registered));
  assert.ok(!oaiCat.models.some(m => m.model === 'whisper-1'));
  assert.ok(!oaiCat.models.some(m => m.model === 'dall-e-3'));
  assert.ok(!oaiCat.models.some(m => m.model === 'text-embedding-3-large'));

  // Anthropic live catalog includes preview model with display_name
  const antCat = await api('/api/providers/catalog?provider=anthropic');
  assert.equal(antCat.connected, true);
  assert.equal(antCat.stale, false);
  const preview = antCat.models.find(m => m.model === 'claude-opus-4-7-preview');
  assert.ok(preview);
  assert.equal(preview.name, 'Claude Opus 4.7 Preview');

  // Local-Only blocks live refresh
  const callsBeforeAirgap = calls.length;
  await api('/api/privacy', 'PATCH', { localOnly: true });
  const airgapCat = await api('/api/providers/catalog?provider=openai&refresh=1');
  assert.equal(calls.length, callsBeforeAirgap);
  assert.equal(airgapCat.stale, true);
  assert.match(airgapCat.warning, /Local-only/i);

  // Offline / HTTP 500 fallback keeps curated + registered models usable
  await api('/api/privacy', 'PATCH', { localOnly: false });
  mode = 'error';
  const errCat = await api('/api/providers/catalog?provider=anthropic&refresh=1');
  assert.equal(errCat.connected, true);
  assert.equal(errCat.stale, true);
  assert.ok(errCat.models.some(m => m.model === 'claude-opus-4-6'));
  assert.match(errCat.warning, /HTTP 500/);
});

test('HttpProvider forwards generation parameters properly to openai-responses (max_output_tokens) and anthropic', async t => {
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url, body });
    if (String(url).includes('/responses')) {
      return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok-oai' }] }] });
    }
    return Response.json({ content: [{ type: 'text', text: 'ok-ant' }] });
  });

  const oai = new HttpProvider({
    id: 'openai:gpt-5.4',
    protocol: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.4',
    credential: 'sk-test',
  });
  await oai.turn({
    task: { objective: 'hi', effort: 'high', generation: { temperature: 0.6, top_p: 0.9, max_tokens: 2048 } },
    history: [],
    tools: [],
  });
  assert.equal(sent[0].body.max_output_tokens, 2048);
  assert.equal(sent[0].body.max_tokens, undefined);
  assert.equal(sent[0].body.temperature, 0.6);
  assert.equal(sent[0].body.top_p, 0.9);
  assert.deepEqual(sent[0].body.reasoning, { effort: 'high' });

  const ant = new HttpProvider({
    id: 'anthropic:claude-opus-4-6',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-opus-4-6',
    credential: 'sk-ant-test',
  });
  await ant.turn({
    task: { objective: 'hi', effort: 'medium', generation: { temperature: 0.4, top_p: 0.85, max_tokens: 1024 } },
    history: [],
    tools: [],
  });
  assert.equal(sent[1].body.max_tokens, 1024);
  assert.equal(sent[1].body.temperature, 0.4);
  assert.equal(sent[1].body.top_p, 0.85);
});
