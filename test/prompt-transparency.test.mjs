import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_TRANSPARENCY_CONFIG,
  SYSTEM_PROMPT_CATALOG,
  normalizeTransparencyConfig,
  applyToolOverrides,
  applyMessageInjections,
  stitchPrefillIntoText,
  buildTransparencySnapshot,
} from '../src/prompt-transparency.mjs';
import { compileInstructions } from '../src/prompts.mjs';
import { TOOLS } from '../src/tool-schema.mjs';
import { createApp } from '../src/server.mjs';
import { HttpProvider } from '../src/providers.mjs';
import { effectiveTurnTimeoutMs } from '../src/runtime.mjs';

test('transparency config normalizes prompt overrides, tool schema edits, and lab injections', () => {
  const cfg = normalizeTransparencyConfig({
    prompts: {
      customAppend: 'Always include concrete benchmarks.',
      personaPlinian: 'Speak like a crisp systems engineer.',
    },
    tools: {
      'web.fetch': { enabled: false },
      'repo.read': {
        description: 'Custom read description for testing.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, startLine: { type: 'integer', minimum: 1 } },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    injections: {
      enabled: true,
      systemPrefix: '[SYS_TOP]',
      systemSuffix: '[SYS_BOT]',
      fewShotUser: 'Demo question?',
      fewShotAssistant: 'Demo answer.',
      userPrefix: '<req>',
      userSuffix: '</req>',
      reasoningPrefill: 'Step 1: inspect inputs.',
      assistantPrefill: 'Direct answer:\n',
      stitchPrefill: true,
    },
  });

  assert.equal(cfg.prompts.customAppend, 'Always include concrete benchmarks.');
  assert.equal(cfg.tools['web.fetch'].enabled, false);
  assert.equal(cfg.tools['repo.read'].description, 'Custom read description for testing.');
  assert.equal(cfg.injections.enabled, true);

  // Invalid tool parameter schema rejected cleanly
  assert.throws(
    () => normalizeTransparencyConfig({ tools: { 'repo.read': { parameters: { type: 'array' } } } }),
    /parameters\.type must be "object"/
  );
  assert.throws(
    () => normalizeTransparencyConfig({ prompts: { nonexistentBlock: 'hi' } }),
    /Unknown system prompt block/
  );

  // Tool overrides filter disabled tools and update description/schema
  const filtered = applyToolOverrides(TOOLS, cfg);
  assert.equal(filtered.some(t => t.name === 'web.fetch'), false);
  const customRead = filtered.find(t => t.name === 'repo.read');
  assert.equal(customRead.description, 'Custom read description for testing.');
  assert.deepEqual(Object.keys(customRead.parameters.properties), ['path', 'startLine']);

  // Compiled instructions honor prompt overrides + systemPrefix/Suffix on non-fixture tasks
  const compiled = compileInstructions({
    task: { workspaceKind: 'conversation', persona: 'plinian', effort: 'medium' },
    files: [],
    tools: filtered,
    transparency: cfg,
  });
  assert.ok(compiled.startsWith('[SYS_TOP]'));
  assert.ok(compiled.includes('Speak like a crisp systems engineer.'));
  assert.ok(compiled.includes('Always include concrete benchmarks.'));
  assert.ok(compiled.endsWith('[SYS_BOT]'));

  // Fixture tasks stay isolated from custom prompt/injection overrides
  const fixtureCompiled = compileInstructions({
    task: { fixtureId: 'task-board', persona: 'plinian' },
    files: [],
    tools: filtered,
    transparency: cfg,
  });
  assert.equal(fixtureCompiled.includes('[SYS_TOP]'), false);
  assert.equal(fixtureCompiled.includes('Always include concrete benchmarks.'), false);

  // Message injections & reasoning + assistant prefill pipeline
  const injected = applyMessageInjections(
    [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'Hello world' }],
    cfg
  );
  assert.equal(injected.messages.length, 5);
  assert.equal(injected.messages[1].role, 'user');
  assert.equal(injected.messages[1].content, 'Demo question?');
  assert.equal(injected.messages[2].role, 'assistant');
  assert.equal(injected.messages[2].content, 'Demo answer.');
  assert.equal(injected.messages[3].role, 'user');
  assert.equal(injected.messages[3].content, '<req>Hello world</req>');
  assert.equal(injected.messages[4].role, 'assistant');
  assert.equal(injected.messages[4].content, '<think>\nStep 1: inspect inputs.\n</think>\nDirect answer:\n');

  // Stitch helper avoids duplicating prefix
  assert.equal(stitchPrefillIntoText('42', { assistantPrefill: 'Direct answer:\n', stitchPrefill: true }), 'Direct answer:\n42');
  assert.equal(stitchPrefillIntoText('Direct answer:\n42', { assistantPrefill: 'Direct answer:\n', stitchPrefill: true }), 'Direct answer:\n42');

  // Snapshot exposes all 13 prompt blocks + all 27 tools
  const snap = buildTransparencySnapshot(cfg);
  assert.equal(snap.prompts.length, SYSTEM_PROMPT_CATALOG.length);
  assert.equal(snap.tools.length, TOOLS.length);
  assert.equal(snap.overrideCount.prompts, 2);
  assert.equal(snap.overrideCount.tools, 2);
  assert.equal(snap.overrideCount.disabledTools, 1);
  assert.equal(snap.overrideCount.injectionsActive, true);
});

test('transparency HTTP API persists overrides and injects them into live OpenAI-chat provider requests', async (t) => {
  const receivedBodies = [];
  const mockUpstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    receivedBodies.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-test',
      model: 'mock-openai',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '42.' } }],
      usage: { prompt_tokens: 50, completion_tokens: 5 },
    }));
  });
  await new Promise(resolve => mockUpstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = mockUpstream.address().port;
  t.after(() => new Promise(resolve => mockUpstream.close(resolve)));

  const dataDir = mkdtempSync(join(tmpdir(), 'g0d-trans-test-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  process.env.G0D_MOCK_TRANS_KEY = 'test-key';
  t.after(() => { delete process.env.G0D_MOCK_TRANS_KEY; });
  const mockProvider = new HttpProvider({
    id: 'mock-live',
    label: 'Mock OpenAI Chat',
    protocol: 'openai-chat',
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    model: 'mock-openai',
    apiKeyEnv: 'G0D_MOCK_TRANS_KEY',
    timeoutMs: 10000,
  });
  const app = await createApp({
    dataDir,
    providers: new Map([[mockProvider.id, mockProvider]]),
    auth: false,
  });
  const baseUrl = await app.listen(0);
  t.after(() => app.close());

  const reqJson = async (method, path, body) => {
    const r = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, data: await r.json(), headers: r.headers };
  };

  // 1. GET default snapshot
  const initial = await reqJson('GET', '/api/transparency');
  assert.equal(initial.status, 200);
  assert.equal(initial.data.prompts.length, SYSTEM_PROMPT_CATALOG.length);
  assert.equal(initial.data.tools.length, TOOLS.length);
  assert.equal(initial.data.overrideCount.prompts, 0);

  // 2. PATCH prompt override + tool schema override + prefill lab
  const patched = await reqJson('PATCH', '/api/transparency', {
    prompts: { customAppend: 'CUSTOM_TRANSPARENCY_MARKER' },
    tools: {
      'web.search': { enabled: false },
      'repo.list': { description: 'CUSTOM_REPO_LIST_DESC' },
    },
    injections: {
      enabled: true,
      systemPrefix: 'PREFIX_LAB_MARKER',
      userSuffix: '\nSUFFIX_LAB_MARKER',
      assistantPrefill: 'Answer: ',
      stitchPrefill: true,
    },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.overrideCount.prompts, 1);
  assert.equal(patched.data.overrideCount.disabledTools, 1);
  assert.equal(patched.data.overrideCount.injectionsActive, true);
  assert.ok(patched.data.compiledPreview.agentLoop.system.includes('PREFIX_LAB_MARKER'));
  assert.ok(patched.data.compiledPreview.agentLoop.system.includes('CUSTOM_TRANSPARENCY_MARKER'));

  // 3. Dispatch a real conversation turn and verify the wire payload sent to mockUpstream
  const created = await reqJson('POST', '/api/conversations', {
    objective: 'What is six times seven?',
    providerIds: ['mock-live'],
  });
  assert.equal(created.status, 201);
  const taskId = created.data.task.id;
  await app.runtime.run(taskId);
  assert.equal(receivedBodies.length, 1);
  const sent = receivedBodies[0];
  assert.equal(sent.messages[0].role, 'system');
  assert.ok(sent.messages[0].content.startsWith('PREFIX_LAB_MARKER'));
  assert.ok(sent.messages[0].content.includes('CUSTOM_TRANSPARENCY_MARKER'));
  const lastUser = sent.messages.findLast(m => m.role === 'user');
  assert.ok(lastUser.content.endsWith('\nSUFFIX_LAB_MARKER'));
  assert.equal(sent.messages[sent.messages.length - 1].role, 'assistant');
  assert.equal(sent.messages[sent.messages.length - 1].content, 'Answer: ');
  assert.equal(sent.tools.some(t => t.function?.name?.includes('web__search')), false);
  const listTool = sent.tools.find(t => t.function?.name === 'repo__list');
  assert.equal(listTool?.function?.description, 'CUSTOM_REPO_LIST_DESC');

  // Verify stitched assistant reply text in task events
  const finalDetail = await reqJson('GET', `/api/tasks/${taskId}`);
  const replyEv = finalDetail.data.events.find(e => e.type === 'model.response');
  assert.equal(replyEv?.data?.response?.text, 'Answer: 42.');

  // 4. Reset all back to defaults
  const reset = await reqJson('POST', '/api/transparency/reset', { scope: 'all' });
  assert.equal(reset.status, 200);
  assert.equal(reset.data.overrideCount.prompts, 0);
  assert.equal(reset.data.overrideCount.tools, 0);
  assert.equal(reset.data.overrideCount.injectionsActive, false);
});

test('macOS security hardening: HTTP headers, session brute-force rate limit, 0700/0600 storage, hardened runtime & Keychain', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'g0d-sec-test-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  const app = await createApp({ dataDir, auth: true });
  const baseUrl = await app.listen(0);
  t.after(() => app.close());

  // 1. Defense-in-depth HTTP headers
  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(health.headers.get('x-frame-options'), 'DENY');
  assert.equal(health.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(health.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(health.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(health.headers.get('x-permitted-cross-domain-policies'), 'none');
  assert.ok((health.headers.get('permissions-policy') || '').includes('camera=()'));
  assert.ok((health.headers.get('content-security-policy') || '').includes("frame-ancestors 'none'"));

  // 2. Session brute-force rate limiting (10 failures -> 11th returns 429)
  for (let i = 0; i < 10; i++) {
    const res = await fetch(`${baseUrl}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
      body: JSON.stringify({ token: '0'.repeat(64) }),
    });
    assert.equal(res.status, 401);
  }
  const throttled = await fetch(`${baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
    body: JSON.stringify({ token: '0'.repeat(64) }),
  });
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers.get('retry-after'), '60');

  // 3. Storage permissions: 0700 dataDir, 0600 SQLite database
  assert.equal(statSync(dataDir).mode & 0o077, 0);
  assert.equal(statSync(join(dataDir, 'state.sqlite')).mode & 0o177, 0);

  // 4. Native macOS hardening static checks (entitlements, Keychain, WKWebView, build script)
  const entitlements = readFileSync(new URL('../native/G0DM0D3.entitlements', import.meta.url), 'utf8');
  assert.ok(entitlements.includes('com.apple.security.device.audio-input'));
  assert.equal(entitlements.includes('disable-library-validation'), false);
  assert.equal(entitlements.includes('allow-dyld-environment-variables'), false);
  assert.equal(entitlements.includes('allow-unsigned-executable-memory'), false);

  const buildScript = readFileSync(new URL('../scripts/build-macos.sh', import.meta.url), 'utf8');
  assert.ok(buildScript.includes('--options runtime'));
  assert.ok(buildScript.includes('--entitlements native/G0DM0D3.entitlements'));
  assert.ok(buildScript.includes('codesign --verify --deep --strict'));

  const keychainSwift = readFileSync(new URL('../native/ProviderKeychain.swift', import.meta.url), 'utf8');
  assert.ok(keychainSwift.includes('kSecAttrAccessibleWhenUnlockedThisDeviceOnly'));
  assert.ok(keychainSwift.includes('kSecAttrSynchronizable'));

  const mainSwift = readFileSync(new URL('../native/main.swift', import.meta.url), 'utf8');
  assert.ok(mainSwift.includes('javaScriptCanOpenWindowsAutomatically = false'));
  assert.ok(mainSwift.includes('DYLD_INSERT_LIBRARIES'));
  assert.ok(mainSwift.includes('runJavaScriptAlertPanelWithMessage'));
  assert.ok(mainSwift.includes('createWebViewWith'));
});

test('high and max effort scale turn timeouts and HttpProvider output token budgets cleanly', async (t) => {
  // Effort-aware turn timeout boosts normal timeouts while preserving small test timeouts
  assert.equal(effectiveTurnTimeoutMs({ effort: 'fast', policy: { requestTimeoutMs: 120000 } }), 120000);
  assert.equal(effectiveTurnTimeoutMs({ effort: 'high', policy: { requestTimeoutMs: 120000 } }), 360000);
  assert.equal(effectiveTurnTimeoutMs({ effort: 'max', policy: { requestTimeoutMs: 120000 } }), 600000);
  assert.equal(effectiveTurnTimeoutMs({ effort: 'max', policy: { requestTimeoutMs: 30 } }), 30);

  // Verify HttpProvider raises max_tokens for high/max effort within ceiling
  const seenMaxTokens = [];
  const mockServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    seenMaxTokens.push(body.max_tokens);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'cmpl-effort',
      model: 'mock-high',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
    }));
  });
  await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve));
  const port = mockServer.address().port;
  t.after(() => new Promise(resolve => mockServer.close(resolve)));

  process.env.G0D_EFFORT_TEST_KEY = 'secret-test';
  t.after(() => { delete process.env.G0D_EFFORT_TEST_KEY; });
  const provider = new HttpProvider({
    id: 'mock-effort',
    label: 'Mock Effort',
    protocol: 'openai-chat',
    baseUrl: `http://127.0.0.1:${port}`,
    model: 'mock-high',
    apiKeyEnv: 'G0D_EFFORT_TEST_KEY',
    timeoutMs: 15000,
    maxOutputTokens: 8000,
    maxOutputTokensCeiling: 64000,
  });
  for (const effort of ['medium', 'high', 'max']) {
    await provider.turn({
      task: { id: 't1', objective: 'hi', workspaceKind: 'conversation', effort },
      history: [],
      files: [],
      tools: [],
      remainingCalls: 100,
    }, { turnTimeoutMs: 600000 });
  }
  assert.deepEqual(seenMaxTokens, [8000, 32768, 64000]);
});
