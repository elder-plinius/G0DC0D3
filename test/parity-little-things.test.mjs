import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseDuckDuckGoHtml, safeWebSearch, extractPdfText } from '../src/web-fetch.mjs';
import { Broker, TOOLS } from '../src/broker.mjs';
import { Store } from '../src/store.mjs';
import { AUTO_JUDGE_PRESET, toolTarget } from '../src/permissions.mjs';
import { createApp } from '../src/server.mjs';
import { createScriptedProviders } from '../bench/scripted.mjs';

const projectDir = fileURLToPath(new URL('../', import.meta.url));

function buildSyntheticPdf(text) {
  const escaped = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const streamContent = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET\n`;
  const compressed = zlib.deflateSync(Buffer.from(streamContent, 'latin1'));
  const header = Buffer.from(
    `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n` +
    `2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n` +
    `3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj\n` +
    `4 0 obj << /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`,
    'latin1'
  );
  const footer = Buffer.from(`\nendstream\nendobj\n%%EOF\n`, 'latin1');
  return Buffer.concat([header, compressed, footer]);
}

function dispatch(app, { method = 'GET', url = '/', headers = {}, body } = {}) {
  const address = app.server.address() || { address: '127.0.0.1', port: 4317 };
  if (!app.server.address()) app.server.address = () => address;
  const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const req = Readable.from(payload ? [payload] : []);
  req.method = method;
  req.url = url;
  req.headers = {
    host: `127.0.0.1:${address.port}`,
    ...(payload ? { 'content-type': 'application/json', 'x-g0d-request': '1' } : {}),
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
  };
  req.setTimeout = () => {};
  return new Promise((resolve, reject) => {
    const resHeaders = new Map();
    const chunks = [];
    const res = {
      statusCode: 200,
      headersSent: false,
      setTimeout() {},
      setHeader(name, value) { resHeaders.set(name.toLowerCase(), value); },
      getHeader(name) { return resHeaders.get(name.toLowerCase()); },
      writeHead(status, hdrs = {}) {
        this.statusCode = status;
        this.headersSent = true;
        for (const [k, v] of Object.entries(hdrs)) resHeaders.set(k.toLowerCase(), v);
      },
      write(chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); },
      end(chunk) {
        if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: this.statusCode, headers: resHeaders, text, json });
      },
    };
    try { app.server.emit('request', req, res); } catch (err) { reject(err); }
  });
}

test('parseDuckDuckGoHtml and safeWebSearch parse results, enforce localOnly, and audit outbound calls', async () => {
  const sampleHtml = `
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&rut=abc">Example Docs &amp; Guide</a>
      <a class="result__snippet">Learn how <b>G0DM0D3</b> works locally.</a>
    </div>
    <div class="result">
      <a class="result__a" href="https://openai.example.org/spec">Spec Overview</a>
      <div class="result__snippet">Zero-tracking HTML parser test.</div>
    </div>
  `;
  const parsed = parseDuckDuckGoHtml(sampleHtml, 5);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].title, 'Example Docs & Guide');
  assert.equal(parsed[0].url, 'https://example.com/docs');
  assert.match(parsed[0].snippet, /Learn how G0DM0D3 works locally/);
  assert.equal(parsed[1].url, 'https://openai.example.org/spec');

  // localOnly blocks outbound web.search and audits the block
  const blockedAudit = [];
  await assert.rejects(
    safeWebSearch({ query: 'node test runner' }, { privacy: { localOnly: true }, onOutbound: rec => blockedAudit.push(rec) }),
    err => err.code === 'PRIVACY_LOCAL_ONLY'
  );
  assert.equal(blockedAudit.length, 1);
  assert.equal(blockedAudit[0].blocked, true);

  // Mock fetchImpl + outbound audit callback
  const audited = [];
  const res = await safeWebSearch({ query: 'g0dm0d3 search', limit: 3 }, {
    onOutbound: rec => audited.push(rec),
    fetchImpl: async () => new Response(sampleHtml, { status: 200, headers: { 'content-type': 'text/html' } }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.query, 'g0dm0d3 search');
  assert.equal(res.results.length, 2);
  assert.equal(audited.length, 1);
  assert.equal(audited[0].providerId, 'web.search');
  assert.equal(audited[0].blocked, false);
});

test('web.search is registered in TOOLS, Broker read-only dispatch, and AUTO_JUDGE_PRESET', async () => {
  assert.ok(TOOLS.some(t => t.name === 'web.search'), 'web.search must be exposed in TOOLS');
  assert.ok(AUTO_JUDGE_PRESET.some(r => r.tool === 'web.search'), 'web.search must be covered by AUTO_JUDGE_PRESET');
  assert.equal(toolTarget('web.search', { query: 'local llm benchmarks' }), 'local llm benchmarks');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-websearch-'));
  const store = new Store(path.join(dir, 'state'));
  try {
    const task = store.createTask({
      id: randomUUID(), title: 'Search test', status: 'running', epoch: 1, workspace: dir,
      execution: { enabled: false, network: false, timeoutMs: 10000 }, checksContractVersion: 1, checks: [],
    });
    const broker = new Broker({ store });
    const out = await broker.execute(
      task.id,
      { name: 'web.search', args: { query: 'privacy test' }, id: randomUUID() },
      { epoch: task.epoch, outbound: { privacy: { localOnly: true } } }
    );
    assert.equal(out.error.code, 'PRIVACY_LOCAL_ONLY');
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('extractPdfText decodes FlateDecode PDF streams and POST /api/attachments/extract works end-to-end', async () => {
  const pdfBuf = buildSyntheticPdf('Hello G0DM0D3 Offline PDF Extractor!');
  const extracted = extractPdfText(pdfBuf);
  assert.equal(extracted.pages, 1);
  assert.match(extracted.text, /Hello G0DM0D3 Offline PDF Extractor!/);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-parity-srv-'));
  const mockChat = {
    id: 'mock-chat',
    label: 'Mock Chat',
    kind: 'openai',
    configured: true,
    async complete() { return { text: 'ok', toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } }; },
  };
  const providers = new Map([[mockChat.id, mockChat]]);
  const firstProviderId = mockChat.id;
  const app = await createApp({ dataDir: dir, providers, auth: false });
  try {
    const res = await dispatch(app, {
      method: 'POST',
      url: '/api/attachments/extract',
      body: { name: 'notes.pdf', dataBase64: pdfBuf.toString('base64') },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.pages, 1);
    assert.match(res.json.text, /Hello G0DM0D3 Offline PDF Extractor!/);

    // Reject non-PDF header cleanly
    const bad = await dispatch(app, {
      method: 'POST',
      url: '/api/attachments/extract',
      body: { name: 'fake.pdf', dataBase64: Buffer.from('not a pdf').toString('base64') },
    });
    assert.equal(bad.status, 400);

    // Attached-file follow-up larger than 12,000 chars is accepted cleanly
    const created = await dispatch(app, {
      method: 'POST',
      url: '/api/conversations',
      body: { objective: 'Initial prompt', providerIds: [firstProviderId] },
    });
    assert.equal(created.status, 201);
    const bigAttachment = `<attached_file name="big.log" info="20.0 KB">\n${'X'.repeat(20000)}\n</attached_file>\n\nSummarize this log.`;
    const follow = await dispatch(app, {
      method: 'POST',
      url: `/api/tasks/${created.json.task.id}/message`,
      body: { message: bigAttachment, messageId: 'att-1' },
    });
    assert.equal(follow.status, 200);

    // /mermaid-lite.js is served with 200 and JavaScript content-type
    const mmdAsset = await dispatch(app, { method: 'GET', url: '/mermaid-lite.js' });
    assert.equal(mmdAsset.status, 200);
    assert.match(mmdAsset.headers.get('content-type') || '', /javascript/);
    assert.match(mmdAsset.text, /renderMermaidToSvg/);
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('public/mermaid-lite.js renders flowchart, sequenceDiagram, and stateDiagram to standalone SVG', async () => {
  const code = await fs.readFile(path.join(projectDir, 'public/mermaid-lite.js'), 'utf8');
  const sandbox = { window: {} };
  vm.runInNewContext(code, sandbox);
  const render = sandbox.window.renderMermaidToSvg;
  assert.equal(typeof render, 'function');

  const flow = render(`flowchart LR\n  A[Prompt] --> B{Router}\n  B -->|Fast| C((Venice))\n  B -->|Deep| D[Anthropic]`);
  assert.ok(flow && flow.startsWith('<svg ') && flow.includes('</svg>'));
  assert.match(flow, /Prompt/);
  assert.match(flow, /Router/);
  assert.match(flow, /Venice/);

  const seq = render(`sequenceDiagram\n  User->>G0DM0D3: Attach PDF\n  G0DM0D3-->>User: Extracted & Answered`);
  assert.ok(seq && seq.startsWith('<svg ') && seq.includes('</svg>'));
  assert.match(seq, /Attach PDF/);
  assert.match(seq, /Extracted &amp; Answered/);

  const state = render(`stateDiagram-v2\n  [*] --> Running\n  Running --> Completed: verified`);
  assert.ok(state && state.startsWith('<svg ') && state.includes('</svg>'));
  assert.match(state, /Running/);
  assert.match(state, /Completed/);
});

import { stitchContinuation, HttpProvider } from '../src/providers.mjs';
import { veniceEndpoint } from '../src/venice-catalog.mjs';

test('stitchContinuation removes duplicate code-fence openers and suffix/prefix overlaps cleanly', () => {
  const part1 = 'Here is the game:\n```html\n<!doctype html>\n<body>\n  <canvas id="c"></canvas>\n  <script>\n    const speed = 4;\n';
  const part2 = '```html\n    const speed = 4;\n    console.log(speed);\n  </script>\n</body>\n```';
  const stitched = stitchContinuation(part1, part2);
  assert.equal((stitched.match(/```html/g) || []).length, 1, 'should not duplicate opening ```html fence');
  assert.equal((stitched.match(/const speed = 4;/g) || []).length, 1, 'should deduplicate repeated tail line');
  assert.ok(stitched.endsWith('</body>\n```'));
});

test('Venice direct chat auto-continues seamlessly across finish_reason=length into one unbroken response', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-venice-autocont-'));
  const veniceBase = new HttpProvider({ id: 'venice-key', label: 'Venice', model: 'venice-base', baseUrl: veniceEndpoint, credential: 'test-key' });
  const app = await createApp({
    dataDir: dir,
    auth: false,
    providers: new Map([['venice-key', veniceBase]]),
    fetchCatalog: async () => Response.json({
      data: [{ id: 'big-writer', type: 'text', model_spec: { name: 'Big Writer', maxCompletionTokens: 32768 } }],
    }),
  });
  t.after(async () => {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const nativeFetch = globalThis.fetch;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url !== veniceEndpoint + '/chat/completions') return nativeFetch(url, init);
    calls += 1;
    if (calls === 1) {
      return Response.json({ choices: [{ message: { content: '```html\n<!doctype html><html><body><h1>Part 1' }, finish_reason: 'length' }] });
    }
    if (calls === 2) {
      return Response.json({ choices: [{ message: { content: '```html\n<h1>Part 1 + Part 2' }, finish_reason: 'length' }] });
    }
    return Response.json({ choices: [{ message: { content: ' + Final</h1></body></html>\n```' }, finish_reason: 'stop' }] });
  });

  const root = await app.listen(0);
  const catalogRes = await (await nativeFetch(root + '/api/providers/venice-models')).json();
  const modelId = catalogRes.models[0].id;
  const created = await (await nativeFetch(root + '/api/conversations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
    body: JSON.stringify({ objective: 'Build a complete HTML page', providerIds: [modelId] }),
  })).json();
  await app.runtime.run(created.task.id);
  const detail = await (await nativeFetch(root + '/api/tasks/' + created.task.id)).json();
  assert.equal(calls, 3, 'should auto-continue across 2 length truncations until stop');
  assert.equal(detail.task.status, 'completed');
  const replies = detail.events.filter(e => e.type === 'model.response');
  assert.equal(replies.length, 1, 'should emit one single stitched assistant response');
  assert.equal(replies[0].data.response.continuations, 2);
  assert.equal(replies[0].data.response.text, '```html\n<!doctype html><html><body><h1>Part 1 + Part 2 + Final</h1></body></html>\n```');
  const contEvents = detail.events.filter(e => e.type === 'routing.auto_continued');
  assert.equal(contEvents.length, 2);
});

test('PATCH /api/tasks/:id/title renames conversations and forkTask preserves completed conversation state', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-rename-fork-'));
  const mockChat = {
    id: 'mock-qol',
    label: 'Mock QoL',
    kind: 'openai',
    available: true,
    configured: true,
    async turn() { return { type: 'message', text: 'First answer ready.', finish: 'done' }; },
  };
  const app = await createApp({ dataDir: dir, providers: new Map([[mockChat.id, mockChat]]), auth: false });
  t.after(async () => {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const created = await dispatch(app, {
    method: 'POST',
    url: '/api/conversations',
    body: { objective: 'Initial topic', providerIds: [mockChat.id] },
  });
  assert.equal(created.status, 201);
  const tid = created.json.task.id;
  await app.runtime.run(tid);
  assert.equal(app.runtime.getTask(tid).status, 'completed');

  // Rename via PATCH /api/tasks/:id/title
  const renamed = await dispatch(app, {
    method: 'PATCH',
    url: `/api/tasks/${tid}/title`,
    body: { title: 'Plinian Strategy Thread' },
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.task.title, 'Plinian Strategy Thread');

  // Reject empty or multiline title
  const badRename = await dispatch(app, {
    method: 'PATCH',
    url: `/api/tasks/${tid}/title`,
    body: { title: 'Line1\nLine2' },
  });
  assert.equal(badRename.status, 400);

  // Fork completed conversation -> stays completed (not stuck paused!) and retains message history
  const forked = await dispatch(app, {
    method: 'POST',
    url: `/api/tasks/${tid}/fork`,
    body: {},
  });
  assert.equal(forked.status, 201);
  assert.equal(forked.json.task.status, 'completed');
  assert.equal(forked.json.task.title, 'Plinian Strategy Thread (fork)');
  const forkDetail = await dispatch(app, { method: 'GET', url: `/api/tasks/${forked.json.task.id}` });
  assert.ok(forkDetail.json.events.some(e => e.type === 'model.response' && e.data?.response?.text === 'First answer ready.'));
});

test('Venice short 429 burst auto-waits and succeeds, and mid-continuation refusal does not pollute partial output', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-venice-edge-'));
  const veniceBase = new HttpProvider({ id: 'venice-key', label: 'Venice', model: 'venice-base', baseUrl: veniceEndpoint, credential: 'test-key' });
  const app = await createApp({
    dataDir: dir,
    auth: false,
    providers: new Map([['venice-key', veniceBase]]),
    fetchCatalog: async () => Response.json({
      data: [{ id: 'burst-writer', type: 'text', model_spec: { name: 'Burst Writer', maxCompletionTokens: 32768 } }],
    }),
  });
  t.after(async () => {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const nativeFetch = globalThis.fetch;
  let scenario = 'burst429';
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url !== veniceEndpoint + '/chat/completions') return nativeFetch(url, init);
    calls += 1;
    if (scenario === 'burst429') {
      if (calls === 1) {
        return Response.json({ error: { message: 'Burst limit' } }, { status: 429, headers: { 'retry-after': '1' } });
      }
      return Response.json({ choices: [{ message: { content: 'Recovered after 1s Venice burst.' }, finish_reason: 'stop' }] });
    }
    // scenario === 'refusal_mid_cont'
    if (calls === 1) {
      return Response.json({ choices: [{ message: { content: 'Valid part 1 code.' }, finish_reason: 'length' }] });
    }
    return Response.json({ choices: [{ message: { refusal: 'I cannot continue this.' }, finish_reason: 'content_filter' }] });
  });

  const root = await app.listen(0);
  const catalogRes = await (await nativeFetch(root + '/api/providers/venice-models')).json();
  const modelId = catalogRes.models[0].id;

  // 1) Short 429 burst auto-waits cleanly and completes
  const t1 = await (await nativeFetch(root + '/api/conversations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
    body: JSON.stringify({ objective: 'Say hi after burst', providerIds: [modelId] }),
  })).json();
  await app.runtime.run(t1.task.id);
  const d1 = await (await nativeFetch(root + '/api/tasks/' + t1.task.id)).json();
  assert.equal(calls, 2);
  assert.equal(d1.task.status, 'completed');
  assert.equal(d1.events.findLast(e => e.type === 'model.response').data.response.text, 'Recovered after 1s Venice burst.');

  // 2) Mid-continuation refusal never stitches refusal text onto valid partial output
  scenario = 'refusal_mid_cont';
  calls = 0;
  const t2 = await (await nativeFetch(root + '/api/conversations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
    body: JSON.stringify({ objective: 'Write long code', providerIds: [modelId] }),
  })).json();
  await app.runtime.run(t2.task.id);
  const d2 = await (await nativeFetch(root + '/api/tasks/' + t2.task.id)).json();
  assert.equal(calls, 2);
  const reply2 = d2.events.findLast(e => e.type === 'model.response').data.response;
  assert.equal(reply2.text, 'Valid part 1 code.');
  assert.doesNotMatch(reply2.text, /cannot continue/i);
});
