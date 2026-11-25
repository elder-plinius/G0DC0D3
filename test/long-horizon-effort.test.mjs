import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HttpProvider, catalogMessages } from '../src/providers.mjs';
import { Runtime, effectiveTurnTimeoutMs } from '../src/runtime.mjs';

function startMockServer(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise(done => server.close(() => done())),
      });
    });
  });
}

test('Long-form high/max effort: HttpProvider streams & auto-continues truncated OpenAI/Anthropic replies seamlessly without discarding text', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-longform-cont-'));
  const wsDir = path.join(dir, 'ws');
  await fs.mkdir(wsDir, { recursive: true });

  const requests = [];
  let callNum = 0;
  const mock = await startMockServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    callNum += 1;

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    if (callNum === 1) {
      res.write(`data: ${JSON.stringify({ model: 'big-reasoner', choices: [{ delta: { reasoning_content: 'Planning architecture deeply...' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ model: 'big-reasoner', choices: [{ delta: { content: 'Part 1: Deep architecture specification.\n```js\nfunction partOne() { return 1; }\n' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ model: 'big-reasoner', choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`);
    } else if (callNum === 2) {
      res.write(`data: ${JSON.stringify({ model: 'big-reasoner', choices: [{ delta: { content: '```js\nfunction partTwo() { return 2; }\n' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ model: 'big-reasoner', choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ model: 'big-reasoner', choices: [{ delta: { content: 'function partThree() { return 3; }\n```\nAll parts complete.' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ model: 'big-reasoner', choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });

  const provider = new HttpProvider({
    id: 'local:big-reasoner',
    label: 'Big Reasoner',
    protocol: 'openai-chat',
    baseUrl: mock.url,
    model: 'deepseek-r1-big',
    timeoutMs: 30000,
    maxOutputTokens: 16000,
    maxOutputTokensCeiling: 64000,
  });

  const runtime = new Runtime({ dataDir: dir, providers: new Map([[provider.id, provider]]) });
  const streamedText = [];
  const streamedThinking = [];
  try {
    const task = await runtime.createTask({
      workspace: wsDir,
      workspaceKind: 'conversation',
      acceptance: { mode: 'owner' },
      objective: 'Write a massive multi-part technical guide with complete code.',
      providers: [provider.id],
      effort: 'max',
    });
    const unsub = runtime.subscribeStream(task.id, delta => {
      if (delta.type === 'text') streamedText.push(delta.text);
      if (delta.type === 'thinking') streamedThinking.push(delta.text);
    });
    const done = await runtime.run(task.id);
    unsub();

    assert.equal(done.status, 'completed');
    assert.equal(done.completionKind, 'answered');
    assert.equal(callNum, 3, 'Should seamlessly auto-continue across 2 continuation hops');
    // First request on max effort should get boosted 64000 ceiling + high reasoning_effort
    assert.equal(requests[0].max_tokens, 64000);
    assert.equal(requests[0].reasoning_effort, 'high');

    const events = runtime.getEvents(task.id);
    const respEv = events.findLast(e => e.type === 'model.response');
    assert.ok(respEv?.data?.response?.text.includes('Part 1: Deep architecture specification.'));
    assert.ok(respEv?.data?.response?.text.includes('function partTwo()'));
    assert.ok(respEv?.data?.response?.text.includes('function partThree()'));
    assert.ok(respEv?.data?.response?.text.includes('All parts complete.'));
    assert.equal(respEv?.data?.response?.continuations, 2);
    // Duplicate opening ```js fence from part 2 should have been stripped by stitchContinuation
    assert.equal((respEv.data.response.text.match(/```js/g) || []).length, 1);
    assert.ok(streamedThinking.join('').includes('Planning architecture deeply'));
    assert.ok(streamedText.join('').includes('All parts complete.'));
  } finally {
    await runtime.close();
    await mock.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Venice catalog high effort: streams SSE live, boosts max_tokens to 32768, keeps tools on HTTP 400 reasoning_effort rejection, and steps down reasoningCap on exhaustedReasoning', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-venice-high-'));
  const wsDir = path.join(dir, 'ws');
  await fs.mkdir(wsDir, { recursive: true });

  const seenBodies = [];
  let phase = 0;
  const mock = await startMockServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    seenBodies.push(body);
    phase += 1;

    // 1) Simulate model rejecting reasoning_effort with HTTP 400 — verify retry KEEPS tools!
    if (phase === 1) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'reasoning_effort unsupported' } }));
      return;
    }
    // 2) Simulate reasoning exhausting full token ceiling with 0 visible text
    if (phase === 2) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Endless internal chain of thought...' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    // 3) After reasoningCap step-down, model succeeds via SSE stream!
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Recovered cleanly after reasoning cap step-down!' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });

  const base = new HttpProvider({
    id: 'venice-base',
    label: 'Venice Base',
    protocol: 'openai-chat',
    baseUrl: mock.url,
    model: 'venice-uncensored',
    timeoutMs: 30000,
    maxOutputTokens: 8192,
    maxOutputTokensCeiling: 32768,
  });
  const catalogProvider = base.catalogChoice({
    id: 'venice-catalog:test-reasoner',
    label: 'Test Reasoner',
    model: 'test-reasoner',
    limit: 32768,
    supportsReasoning: true,
    supportsFunctionCalling: true,
    modelMetadata: { supportsReasoning: true, supportsFunctionCalling: true, contextWindow: 200000 },
  });

  const runtime = new Runtime({
    dataDir: dir,
    providers: new Map([[base.id, base]]),
    catalog: {
      async list() { return { connected: true, models: [] }; },
      get(id) { return id === catalogProvider.id ? catalogProvider : null; },
    },
  });

  const liveChunks = [];
  try {
    const task = await runtime.createTask({
      workspace: wsDir,
      workspaceKind: 'conversation',
      acceptance: { mode: 'owner' },
      objective: 'Analyze this complex system at high effort.',
      providers: [catalogProvider.id],
      effort: 'high',
    });
    const unsub = runtime.subscribeStream(task.id, d => { if (d.type === 'text') liveChunks.push(d.text); });
    const done = await runtime.run(task.id);
    unsub();

    assert.equal(done.status, 'completed');
    // Request 1 sent boosted 32768 max_tokens + stream:true + reasoning_effort:'high' + tools
    assert.equal(seenBodies[0].max_tokens, 32768);
    assert.equal(seenBodies[0].stream, true);
    assert.equal(seenBodies[0].reasoning_effort, 'high');
    assert.ok(Array.isArray(seenBodies[0].tools) && seenBodies[0].tools.length > 0);
    // Request 2 (surgical 400 retry) stripped reasoning_effort BUT KEPT tools intact!
    assert.equal(seenBodies[1].reasoning_effort, undefined);
    assert.ok(Array.isArray(seenBodies[1].tools) && seenBodies[1].tools.length > 0, 'Surgical 400 retry must keep tools intact');
    // Request 3 stepped down reasoningCap to medium (omitted reasoning_effort) and succeeded
    assert.equal(seenBodies[2].reasoning_effort, undefined);
    assert.ok(liveChunks.join('').includes('Recovered cleanly'));
  } finally {
    await runtime.close();
    await mock.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Long-horizon max effort: allows >12 parallel tool calls, injects compacted workingSummary into catalogMessages, and scales turn timeouts', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-long-batch-'));
  const wsDir = path.join(dir, 'ws');
  await fs.mkdir(wsDir, { recursive: true });
  for (let i = 1; i <= 16; i++) {
    await fs.writeFile(path.join(wsDir, `mod-${i}.txt`), `module ${i} content\n`);
  }

  assert.equal(effectiveTurnTimeoutMs({ effort: 'high', policy: { requestTimeoutMs: 300000 } }), 360000);
  assert.equal(effectiveTurnTimeoutMs({ effort: 'max', policy: { requestTimeoutMs: 300000 } }), 600000);

  let turns = 0;
  const batchProvider = {
    id: 'local:parallel-32',
    label: 'Parallel 32',
    kind: 'http',
    tier: 'local',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'parallel-32',
    available: true,
    async turn() {
      turns += 1;
      if (turns === 1) {
        return {
          type: 'tool',
          calls: Array.from({ length: 16 }, (_, idx) => ({
            id: `read-${idx + 1}`,
            name: 'repo.read',
            args: { path: `mod-${idx + 1}.txt` },
          })),
        };
      }
      return { type: 'message', finish: 'done', text: 'Read all 16 modules in one parallel batch!' };
    },
  };

  const runtime = new Runtime({ dataDir: dir, providers: new Map([[batchProvider.id, batchProvider]]) });
  try {
    const task = await runtime.createTask({
      workspace: wsDir,
      workspaceKind: 'conversation',
      acceptance: { mode: 'owner' },
      objective: 'Audit all 16 modules in parallel.',
      providers: [batchProvider.id],
      effort: 'max',
    });
    const done = await runtime.run(task.id);
    assert.equal(done.status, 'waiting_input');
    assert.equal(turns, 2);

    // Verify catalogMessages preserves compacted workingSummary so catalog models never lose folded memory
    const msgs = catalogMessages({
      task: {
        id: 't1',
        objective: 'Build system',
        effort: 'max',
        workingSummary: {
          compactedBeforeSeq: 42,
          modifiedFiles: ['src/app.mjs'],
          todoProgress: { done: 3, total: 5, items: [] },
          userClarifications: ['Use zero external deps'],
          failedApproaches: ['sync I/O blocked loop'],
          semantic: {
            goalAndState: 'Core engine complete',
            decisions: ['Stream SSE everywhere'],
            ruledOut: ['Polling'],
            constraintsAndPrefs: ['Strict CSP'],
            nextStep: 'Finish UI wiring',
          },
        },
      },
      history: [],
    });
    assert.ok(msgs[0].content.includes('Compacted Session Memory'));
    assert.ok(msgs[0].content.includes('Stream SSE everywhere'));
    assert.ok(msgs[0].content.includes('Finish UI wiring'));
  } finally {
    await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
