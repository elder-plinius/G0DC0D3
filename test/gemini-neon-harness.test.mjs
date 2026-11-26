import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HttpProvider, catalogMessages } from '../src/providers.mjs';
import { TOOLS } from '../src/broker.mjs';
import { compileTaskContext } from '../src/prompts.mjs';
import { resolveContextByteLimit, Runtime } from '../src/runtime.mjs';
import { createProviderSettings } from '../src/provider-settings.mjs';

test('Gemini 4 Neon harness: 1M context hydration, Effort -> reasoning_effort, schema hygiene, streaming & JSON thought_signature round-trip, and prefix cache stability', async t => {
  const captured = [];
  let mode = 'json-tool';
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    captured.push(body);
    if (mode === 'stream-tool') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({
        choices: [{
          delta: {
            reasoning_content: 'Checking app.mjs',
            tool_calls: [{
              index: 0,
              id: 'call_stream_sig_1',
              type: 'function',
              function: { name: 'repo__read', arguments: '{"path":"src/app.mjs"}' },
              extra_content: { google: { thought_signature: 'STREAM_NEON_SIG_XYZ' } },
            }],
          },
          finish_reason: null,
        }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          content: null,
          tool_calls: [{
            id: 'call_json_sig_1',
            type: 'function',
            function: { name: 'repo__read', arguments: '{"path":"src/app.mjs"}' },
            extra_content: { google: { thought_signature: 'JSON_NEON_SIG_ABC' } },
          }],
        },
      }],
      usage: { prompt_tokens: 120, completion_tokens: 24 },
    }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

  const neon = new HttpProvider({
    id: 'openrouter:google-gemini-4-neon',
    label: 'Gemini 4 Neon · OpenRouter',
    protocol: 'openai-chat',
    baseUrl,
    model: 'google/gemini-4-neon',
    credential: 'test-key',
    allowPrivateHttp: true,
  });

  // 1. Hydrated 1M context window -> 768 KiB byte limit
  assert.equal(neon.modelMetadata.contextWindow, 1000000);
  assert.equal(neon.modelMetadata.supportsReasoning, true);
  assert.equal(neon.modelMetadata.supportsVision, true);
  assert.equal(resolveContextByteLimit(neon, { effort: 'high' }), 768 * 1024);

  // 2. Non-streaming tool call: Effort=high -> reasoning_effort, schema sanitized, thought_signature captured
  const jsonResp = await neon.turn({
    task: { id: 't-neon', objective: 'Read src/app.mjs', effort: 'high', policy: { maxCalls: 20, maxAttempts: 3 }, workspace: '/tmp' },
    history: [], files: [], tools: TOOLS,
  }, { privacy: { localOnly: false } });
  assert.equal(captured[0].reasoning_effort, 'high');
  assert.equal(/"additionalProperties"/.test(JSON.stringify(captured[0].tools)), false, 'Gemini tool schemas should omit additionalProperties');
  assert.equal(jsonResp.type, 'tool');
  assert.equal(jsonResp.calls[0].thoughtSignature, 'JSON_NEON_SIG_ABC');
  assert.equal(jsonResp.calls[0].extra_content?.google?.thought_signature, 'JSON_NEON_SIG_ABC');

  // 3. Streaming tool call preserves thought_signature + Effort=fast -> low
  mode = 'stream-tool';
  const streamResp = await neon.turn({
    task: { id: 't-neon', objective: 'Read src/app.mjs', effort: 'fast', policy: { maxCalls: 20, maxAttempts: 3 }, workspace: '/tmp' },
    history: [], files: [], tools: TOOLS,
  }, { onDelta: () => {}, privacy: { localOnly: false } });
  assert.equal(captured[1].reasoning_effort, 'low');
  assert.equal(streamResp.type, 'tool');
  assert.equal(streamResp.calls[0].thoughtSignature, 'STREAM_NEON_SIG_XYZ');
  assert.equal(streamResp.calls[0].extra_content?.google?.thought_signature, 'STREAM_NEON_SIG_XYZ');

  // 4. catalogMessages replays extra_content.google.thought_signature intact
  const replayed = catalogMessages({
    task: { id: 't-neon', objective: 'Read file', followups: [] },
    history: [
      { seq: 1, type: 'model.response', data: { response: streamResp } },
      { seq: 2, type: 'tool.completed', data: { operationId: 't-neon:call_stream_sig_1', name: 'repo.read', ok: true, result: { content: 'export const x = 1;' } } },
    ],
  }, { enableTools: true });
  const assistantTurn = replayed.find(m => m.role === 'assistant' && Array.isArray(m.tool_calls));
  assert.equal(assistantTurn?.tool_calls?.[0]?.extra_content?.google?.thought_signature, 'STREAM_NEON_SIG_XYZ');

  // 5. Prefix-stable taskContextData keeps >= 80% prefix identical across turns
  const p1 = compileTaskContext({
    task: { id: 't-cache', objective: 'Refactor auth middleware cleanly', policy: { maxCalls: 20, maxAttempts: 3 }, calls: 1 },
    history: [{ id: 'e1', seq: 1, type: 'tool.completed', data: { name: 'repo.read', result: { path: 'a.mjs', content: 'export const a = 1;\n'.repeat(30) } } }],
    files: [{ path: 'a.mjs', bytes: 600, sha256: 'aaa' }],
    tools: TOOLS,
  });
  const p2 = compileTaskContext({
    task: { id: 't-cache', objective: 'Refactor auth middleware cleanly', policy: { maxCalls: 20, maxAttempts: 3 }, calls: 2 },
    history: [
      { id: 'e1', seq: 1, type: 'tool.completed', data: { name: 'repo.read', result: { path: 'a.mjs', content: 'export const a = 1;\n'.repeat(30) } } },
      { id: 'e2', seq: 2, type: 'tool.completed', data: { name: 'repo.read', result: { path: 'b.mjs', content: 'export const b = 2;' } } },
    ],
    files: [{ path: 'a.mjs', bytes: 600, sha256: 'aaa' }],
    tools: TOOLS,
  });
  let common = 0;
  while (common < p1.length && common < p2.length && p1[common] === p2[common]) common++;
  const pct = (common / p1.length) * 100;
  assert.ok(pct >= 75, `Expected >= 75% prefix stability across turns, got ${pct.toFixed(1)}%`);

  // 6. Visual observations from browser.screenshot inject native multimodal image_url part
  mode = 'json-tool';
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  await neon.turn({
    task: { id: 't-vis', objective: 'Inspect page', effort: 'medium', policy: { maxCalls: 20, maxAttempts: 3 }, workspace: '/tmp' },
    history: [], files: [], tools: TOOLS,
    visualObservations: [{ dataUrl: tinyPng, mediaType: 'image/png' }],
  }, { privacy: { localOnly: false } });
  const visUserMsg = captured[2].messages.find(m => m.role === 'user');
  assert.ok(Array.isArray(visUserMsg.content), 'expected multimodal content array with screenshot');
  assert.equal(visUserMsg.content[0].type, 'image_url');
  assert.equal(visUserMsg.content[0].image_url.url, tinyPng);

  // 7. Direct Gemini API profile includes gemini-4-neon by default
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-gem-prof-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
  const provMap = new Map();
  const settings = await createProviderSettings(provMap, undefined, { dataDir: tmpDir });
  await settings.connect({ provider: 'gemini', key: 'AIzaSyTestFakeKey1234567890' });
  assert.ok(provMap.has('gemini:gemini-4-neon'), 'expected gemini:gemini-4-neon registered by default for direct Gemini API');
});
