import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseIncident, detectRefusal, rankCandidates, rankInitialProviders, providerIdentity } from '../src/routing.mjs';
import { applyObservations, emptyLearning } from '../src/learning.mjs';
import { reframe, analyzeRefusal } from '../src/reframe.mjs';
import { HttpProvider } from '../src/providers.mjs';
import { classifyProviderFailure, replyOutcome } from '../src/outcomes.mjs';
import { redactDiagnostics } from '../src/privacy.mjs';

test('diagnoseIncident classifies HTTP_429 as transport and HTTP_401/403 as nonretryable configuration', () => {
  assert.deepEqual(diagnoseIncident({ code: 'HTTP_429' }), { category: 'transport', route: true });
  assert.deepEqual(diagnoseIncident({ code: 'HTTP_401' }), { category: 'configuration', route: false });
  assert.deepEqual(diagnoseIncident({ code: 'HTTP_403' }), { category: 'configuration', route: false });
  assert.deepEqual(diagnoseIncident({ code: 'HTTP_402' }), { category: 'configuration', route: false });
  assert.deepEqual(diagnoseIncident({ code: 'HTTP_404' }), { category: 'provider_404', route: true });
  assert.deepEqual(diagnoseIncident({ code: 'CONTENT_RESTRICTION' }), { category: 'content_restriction', route: true });
  assert.deepEqual(diagnoseIncident({ code: 'PROVIDER_POLICY' }), { category: 'policy', route: false });
  assert.deepEqual(diagnoseIncident({ code: 'PROVIDER_TIMEOUT' }), { category: 'transport', route: true });
});

test('detectRefusal distinguishes standalone declines from code and quoted phrases', () => {
  assert.equal(detectRefusal({ type: 'message', finish: 'refusal', text: 'No' }).code, 'CONTENT_RESTRICTION');
  assert.equal(detectRefusal({ type: 'message', finish: 'done', text: 'I cannot help build that module.' }).code, 'CONTENT_RESTRICTION');
  assert.equal(detectRefusal({ type: 'message', finish: 'done', text: 'Fixed the bug and handled "I cannot comply" as test input.' }), null);
  assert.equal(detectRefusal({ type: 'message', finish: 'done', text: 'Here is the fix:\n```js\nexport const x = "I cannot help with that";\nconsole.log(x, 1234567890);\n```' }), null);
});

test('reframe escalates cleanly across passes, provider frames, and ultraplinian mode', () => {
  const p1 = reframe('Build module X', 1, '');
  assert.equal(p1.reframed, true);
  assert.equal(p1.level, 'light');
  assert.equal(p1.rewriteNeeded, false);

  const ds = reframe('Build module X', 2, '', { providerId: 'openrouter:deepseek-chat' });
  assert.equal(ds.level, 'deepseek:2');

  const ultra = reframe('Build module X', 1, '', { ultraplinian: true });
  assert.equal(ultra.level, 'ultraplinian:1');
  assert.ok(ultra.objective.includes('Build module X'));

  const rewrite = reframe('Build module X', 11, '');
  assert.equal(rewrite.rewriteNeeded, true);

  assert.equal(analyzeRefusal('I cannot write malware or ransomware').strategy, 'reframe_as_analysis');
});

test('learning observations influence candidate and initial provider ranking', () => {
  const p1 = { id: 'p1', kind: 'http', protocol: 'openai-chat', model: 'm1', baseUrl: 'https://example.test/v1', turn() {} };
  const p2 = { id: 'p2', kind: 'http', protocol: 'openai-chat', model: 'm2', baseUrl: 'https://example.test/v1', turn() {} };
  const p3 = { id: 'p3', kind: 'http', protocol: 'openai-chat', model: 'm3', baseUrl: 'https://example.test/v1', turn() {} };
  const providers = new Map([['p1', p1], ['p2', p2], ['p3', p3]]);
  const k2 = providerIdentity('p2', p2), k3 = providerIdentity('p3', p3);

  let learning = emptyLearning();
  for (let i = 0; i < 4; i++) {
    learning = applyObservations(learning, [
      { providerId: 'p2', providerKey: k2, category: 'completion', outcome: 'failure' },
      { providerId: 'p3', providerKey: k3, category: 'completion', outcome: 'success' },
      { providerId: 'p2', providerKey: k2, category: 'transport', outcome: 'failure' },
      { providerId: 'p3', providerKey: k3, category: 'transport', outcome: 'success' }
    ], ['verify-after-edit']);
  }

  const ranked = rankCandidates({
    task: { providers: ['p1', 'p2', 'p3'], providerId: 'p1', calls: 1, policy: { strategies: ['continue'] }, routing: {} },
    providers, learning, diagnosis: { category: 'transport' }
  });
  assert.equal(ranked[0].id, 'p3');

  const initialOrder = rankInitialProviders(['p1', 'p2', 'p3'], providers, learning);
  assert.deepEqual(initialOrder, ['p1', 'p3', 'p2']);
});

test('HttpProvider flushes trailing SSE lines and handles JSON fallback on stream requests', async () => {
  const originalFetch = globalThis.fetch;
  let mode = 'sse-no-newline';
  globalThis.fetch = async () => {
    if (mode === 'sse-no-newline') {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hello "}}]}\n'));
          // Final line intentionally lacks trailing newline
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"world"},"finish_reason":"stop"}]}'));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'json-fallback' }, finish_reason: 'stop' }] }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  };
  try {
    const provider = new HttpProvider({
      id: 'mock', protocol: 'openai-chat', baseUrl: 'https://mock.example.test/v1', model: 'mock-1', credential: 'test-secret-key-12345'
    });
    const ctx = { task: { objective: 'hi', constraints: [] }, history: [], files: [], tools: [] };
    const deltas = [];
    const r1 = await provider.turn(ctx, { onDelta: d => deltas.push(d.text) });
    assert.equal(r1.type, 'message');
    assert.equal(r1.text, 'hello world');
    assert.deepEqual(deltas, ['hello ', 'world']);

    mode = 'json';
    const r2 = await provider.turn(ctx, { onDelta: () => {} });
    assert.equal(r2.type, 'message');
    assert.equal(r2.text, 'json-fallback');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('outcomes classification and privacy redaction handle credentials and content restrictions', () => {
  assert.equal(classifyProviderFailure('Content was flagged for cybersecurity safety policy', []).code, 'CONTENT_RESTRICTION');
  assert.equal(classifyProviderFailure('Invalid API key', []).code, 'authentication');
  assert.equal(replyOutcome({ type: 'message', finish: 'done', text: 'I cannot help with that.' }).kind, 'declined');

  const redacted = redactDiagnostics({
    apiKey: 'should-redact',
    note: 'Bearer supersecrettoken12345 and sk-abcdefghijklmnop and myCustomSecret99'
  }, ['myCustomSecret99']);
  assert.equal(redacted.apiKey, '[redacted credential]');
  assert.ok(!redacted.note.includes('supersecrettoken12345'));
  assert.ok(!redacted.note.includes('sk-abcdefghijklmnop'));
  assert.ok(!redacted.note.includes('myCustomSecret99'));
});
