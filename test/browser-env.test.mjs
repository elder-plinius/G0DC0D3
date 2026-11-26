import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertBrowserUrlAllowed, buildChromiumLaunchArgs, BrowserPool, findChromiumBinary } from '../src/browser-env.mjs';
import { createApp } from '../src/server.mjs';
import { Store } from '../src/store.mjs';
import { Broker, taskTools } from '../src/broker.mjs';
import { compileInstructions } from '../src/prompts.mjs';
import { buildContext } from '../src/runtime.mjs';
import { HttpProvider } from '../src/providers.mjs';
import { veniceEndpoint } from '../src/venice-catalog.mjs';
import { promptNeedsLiveTools } from '../src/ultra-router.mjs';

test('assertBrowserUrlAllowed enforces http/https, blocks SSRF/private LAN, enforces Local-Only, and allows localhost dev servers', () => {
  assert.throws(() => assertBrowserUrlAllowed('file:///etc/passwd'), { code: 'BROWSER_URL_DENIED' });
  assert.throws(() => assertBrowserUrlAllowed('javascript:alert(1)'), { code: 'BROWSER_URL_DENIED' });
  assert.throws(() => assertBrowserUrlAllowed('http://169.254.169.254/latest/meta-data'), { code: 'SSRF_BLOCKED' });
  assert.throws(() => assertBrowserUrlAllowed('http://192.168.1.10/admin'), { code: 'SSRF_BLOCKED' });
  assert.throws(() => assertBrowserUrlAllowed('http://10.0.0.5/internal'), { code: 'SSRF_BLOCKED' });

  // Local-Only blocks external domains & audits the block, but ALLOWS localhost dev servers
  const audited = [];
  assert.throws(
    () => assertBrowserUrlAllowed('https://example.com/docs', { privacy: { localOnly: true }, onOutbound: r => audited.push(r) }),
    { code: 'PRIVACY_LOCAL_ONLY' }
  );
  assert.equal(audited.length, 1);
  assert.equal(audited[0].blocked, true);
  assert.equal(audited[0].providerId, 'browser');

  const localOk = assertBrowserUrlAllowed('http://127.0.0.1:4321/app', { privacy: { localOnly: true }, onOutbound: r => audited.push(r) });
  assert.equal(localOk, 'http://127.0.0.1:4321/app');
  assert.equal(audited.length, 1, 'loopback navigation should not log external egress');

  // External allowed when Local-Only is off, and recorded to outbound audit
  const extOk = assertBrowserUrlAllowed('https://example.com/docs', { privacy: { localOnly: false }, onOutbound: r => audited.push(r) });
  assert.equal(extOk, 'https://example.com/docs');
  assert.equal(audited.length, 2);
  assert.equal(audited[1].blocked, false);
});

test('Contained headless Chromium agent browser runs open, snapshot, act (type/click), eval, screenshot HTTP API, and wipes profile on close', async t => {
  const binary = await findChromiumBinary();
  if (!binary) {
    t.skip('No Chromium binary installed on this host');
    return;
  }

  // Spin up an interactive local test page on 127.0.0.1:0
  const targetServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html>
      <html>
        <head><title>G0DM0D3 Contained Browser Target</title></head>
        <body style="font-family:system-ui;padding:24px;background:#111;color:#fff">
          <h1>Agent Sandbox App</h1>
          <input id="name" name="agentName" placeholder="Enter agent name" />
          <button id="go" type="button">Greet</button>
          <button id="inc" type="button">Count: 0</button>
          <p id="out">Waiting...</p>
          <script>
            let n = 0;
            document.getElementById('go').addEventListener('click', () => {
              const v = document.getElementById('name').value;
              document.getElementById('out').textContent = 'Hello, ' + v + '!';
            });
            document.getElementById('inc').addEventListener('click', (e) => {
              n += 1;
              e.target.textContent = 'Count: ' + n;
              if (n === 2) console.error('TEST_CONSOLE_WARN_2');
            });
          </script>
        </body>
      </html>`);
  });
  await new Promise(resolve => targetServer.listen(0, '127.0.0.1', resolve));
  const targetPort = targetServer.address().port;
  const targetUrl = `http://127.0.0.1:${targetPort}/`;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-browser-e2e-'));
  const app = await createApp({ dataDir: dir, auth: false });
  const root = await app.listen(0);
  t.after(async () => {
    await app.close();
    targetServer.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  // Create a task via runtime store so we can drive all 6 browser.* tools directly through Broker + HTTP screenshot route
  const taskWs = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-browser-ws-'));
  t.after(() => fs.rm(taskWs, { recursive: true, force: true }));
  const task = app.runtime.store.createTask({
    id: randomUUID(),
    title: 'Browser test task',
    status: 'running',
    epoch: 1,
    workspace: taskWs,
    workspaceKind: 'conversation',
    execution: { enabled: false, network: false, timeoutMs: 10000 },
    checksContractVersion: 1,
    checks: [],
  });

  const call = (name, args = {}) =>
    app.runtime.broker.execute(task.id, { name, args, id: randomUUID() }, { epoch: task.epoch, outbound: { privacy: { localOnly: true } } });

  // 1) browser.open (works on localhost even with Local-Only mode ON!)
  const opened = await call('browser.open', { url: targetUrl, viewport: { width: 1024, height: 640 } });
  assert.equal(opened.ok, true, opened.error?.message);
  assert.equal(opened.title, 'G0DM0D3 Contained Browser Target');
  assert.match(opened.text, /Agent Sandbox App/);
  assert.ok(opened.elements.length >= 3, 'should discover input and buttons as refs');
  assert.ok(opened.screenshotBytes > 1000, 'should capture live PNG screenshot');
  assert.match(opened.screenshotUrl, /\/api\/tasks\/.+\/browser\/screenshot\?v=1/);

  const session = app.runtime.broker.browser.sessions.get(task.id);
  const ephemeralProfileDir = session.profileDir;
  assert.ok(ephemeralProfileDir && ephemeralProfileDir.includes('g0dc0d3-browser-'));

  // 2) Verify HTTP GET /api/tasks/:id/browser/screenshot serves a valid PNG
  const shotRes = await fetch(root + opened.screenshotUrl);
  assert.equal(shotRes.status, 200);
  assert.equal(shotRes.headers.get('content-type'), 'image/png');
  const pngBytes = Buffer.from(await shotRes.arrayBuffer());
  assert.deepEqual(pngBytes.subarray(0, 4), Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'valid PNG magic header');

  // 3) browser.act type into input by ref + click Greet button by ref
  const inputRef = opened.elements.find(e => e.tag === 'input')?.ref;
  const greetRef = opened.elements.find(e => e.tag === 'button' && e.text.includes('Greet'))?.ref;
  const incRef = opened.elements.find(e => e.tag === 'button' && e.text.includes('Count'))?.ref;
  assert.ok(inputRef && greetRef && incRef);

  const typed = await call('browser.act', { action: 'type', ref: inputRef, text: 'Pliny' });
  assert.equal(typed.ok, true);
  const clicked = await call('browser.act', { action: 'click', ref: greetRef });
  assert.equal(clicked.ok, true);
  assert.match(clicked.text, /Hello, Pliny!/);

  // 4) Double-click/click counter twice and verify browser console error capture
  await call('browser.act', { action: 'click', ref: incRef });
  const clicked2 = await call('browser.act', { action: 'click', ref: incRef });
  assert.match(clicked2.text, /Count: 2/);
  assert.ok(clicked2.consoleErrors.some(e => e.message.includes('TEST_CONSOLE_WARN_2')), 'should capture console.error from page');

  // 5) browser.eval + browser.snapshot + browser.screenshot
  const ev = await call('browser.eval', { expression: 'document.getElementById("out").textContent' });
  assert.equal(ev.ok, true);
  assert.equal(ev.result, 'Hello, Pliny!');

  const snap = await call('browser.snapshot', { maxChars: 2000 });
  assert.equal(snap.ok, true);
  assert.match(snap.text, /Hello, Pliny!/);

  const shot2 = await call('browser.screenshot', {});
  assert.equal(shot2.ok, true);
  assert.ok(shot2.bytes > 1000);

  // 6) browser.close kills Chromium & wipes ephemeral profile directory cleanly
  const closed = await call('browser.close', {});
  assert.equal(closed.ok, true);
  assert.equal(closed.closed, true);
  await assert.rejects(fs.access(ephemeralProfileDir), 'ephemeral browser profile dir must be deleted on close');
});

test('Contained browser edge cases: alert/confirm dialogs never hang, target=_blank stays in tab, redirect SSRF blocked, clear+select+scroll+canvas+error recovery work', async t => {
  const binary = await findChromiumBinary();
  if (!binary) {
    t.skip('No Chromium binary installed on this host');
    return;
  }

  const targetServer = http.createServer((req, res) => {
    if (req.url === '/redirect-ext') {
      res.writeHead(302, { Location: 'https://example.com/' });
      res.end();
      return;
    }
    if (req.url === '/page2') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Page Two</title></head><body><h1>Arrived on Page 2</h1></body></html>`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html>
      <html>
        <head><title>Edge Cases Page</title></head>
        <body style="height:2200px;font-family:system-ui;padding:24px">
          <h1>Edge Cases</h1>
          <input id="field" value="OldValue" />
          <select id="mode">
            <option value="alpha">Alpha Option</option>
            <option value="beta">Beta Option</option>
          </select>
          <button id="dlgBtn" type="button">Trigger Dialog</button>
          <a id="blankLink" href="/page2" target="_blank">Open Page 2</a>
          <canvas id="game" width="240" height="120"></canvas>
          <p id="status">Idle</p>
          <script>
            document.getElementById('dlgBtn').addEventListener('click', () => {
              alert('HELLO_ALERT');
              const ok = confirm('CONFIRM_PROCEED');
              document.getElementById('status').textContent = ok ? 'DialogAccepted' : 'DialogDenied';
            });
            document.getElementById('mode').addEventListener('change', e => {
              document.getElementById('status').textContent = 'Selected:' + e.target.value;
            });
          </script>
        </body>
      </html>`);
  });
  await new Promise(resolve => targetServer.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${targetServer.address().port}`;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-browser-edge-'));
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-browser-edge-ws-'));
  const store = new Store(path.join(dir, 'state'));
  const broker = new Broker({ store });
  t.after(async () => {
    await broker.close();
    store.close();
    targetServer.close();
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(ws, { recursive: true, force: true });
  });

  const task = store.createTask({
    id: randomUUID(),
    title: 'Browser edge cases',
    status: 'running',
    epoch: 1,
    workspace: ws,
    workspaceKind: 'conversation',
    execution: { enabled: false, network: false, timeoutMs: 10000 },
    checksContractVersion: 1,
    checks: [],
  });
  const call = (name, args = {}, privacy = { localOnly: true }) =>
    broker.execute(task.id, { name, args, id: randomUUID() }, { epoch: task.epoch, outbound: { privacy } });

  // 1) Concurrent open calls reuse one single Chromium launch without leaking processes
  const [o1, o2] = await Promise.all([
    call('browser.open', { url: base + '/' }),
    call('browser.open', { url: base + '/' }),
  ]);
  assert.equal(o1.ok, true);
  assert.equal(o2.ok, true);
  assert.equal(broker.browser.sessions.size, 1);
  assert.ok(o2.elements.some(e => e.tag === 'canvas'), 'canvas element should be discoverable as interactive ref');

  // 2) alert() + confirm() auto-accepted without hanging CDP
  const dlgBtnRef = o2.elements.find(e => e.text.includes('Trigger Dialog'))?.ref;
  assert.ok(dlgBtnRef);
  const afterDlg = await call('browser.act', { action: 'click', ref: dlgBtnRef });
  assert.equal(afterDlg.ok, true);
  assert.match(afterDlg.text, /DialogAccepted/);
  assert.ok(afterDlg.consoleErrors.some(e => e.message.includes('HELLO_ALERT')));

  // 3) Clear + type on prefilled input & select by visible label text
  const fieldRef = afterDlg.elements.find(e => e.tag === 'input')?.ref;
  const selectRef = afterDlg.elements.find(e => e.tag === 'select')?.ref;
  const typed = await call('browser.act', { action: 'type', ref: fieldRef, clear: true, text: 'FreshValue' });
  assert.equal(typed.ok, true);
  assert.equal((await call('browser.eval', { expression: 'document.getElementById("field").value' })).result, 'FreshValue');

  const selected = await call('browser.act', { action: 'select', ref: selectRef, text: 'Beta Option' });
  assert.equal(selected.ok, true);
  assert.match(selected.text, /Selected:beta/);

  // 4) Scroll + bad selector / syntax error recovery (session remains healthy!)
  await call('browser.act', { action: 'scroll', deltaY: 600 });
  const scrollY = Number((await call('browser.eval', { expression: 'window.scrollY' })).result);
  assert.ok(scrollY >= 400, `expected scrollY >= 400, got ${scrollY}`);

  const missing = await call('browser.act', { action: 'click', selector: '#does-not-exist' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'BROWSER_ELEMENT_NOT_FOUND');

  const badEval = await call('browser.eval', { expression: '(() => { throw new Error("BOOM_EVAL"); })()' });
  assert.equal(badEval.ok, false);
  assert.equal(badEval.error.code, 'BROWSER_EVAL_ERROR');

  // 5) target="_blank" link navigates inside the SAME contained tab!
  const blankRef = selected.elements.find(e => e.text.includes('Open Page 2'))?.ref;
  assert.ok(blankRef);
  const navigated = await call('browser.act', { action: 'click', ref: blankRef });
  assert.equal(navigated.ok, true);
  assert.equal(navigated.title, 'Page Two');
  assert.match(navigated.text, /Arrived on Page 2/);

  // 6) HTTP 302 redirect to external origin while Local-Only is ON is caught & blocked!
  const redirected = await call('browser.open', { url: base + '/redirect-ext' }, { localOnly: true });
  assert.equal(redirected.ok, false);
  assert.equal(redirected.error.code, 'PRIVACY_LOCAL_ONLY');

  await call('browser.close', {});
});

test('Agent prompts teach strong browser/web/todo tool use (non-fixture only) and buildContext preserves large browser snapshots', () => {
  const convTask = { workspaceKind: 'conversation', execution: { enabled: false, network: false, timeoutMs: 30000 }, persona: 'plinian', policy: { maxCalls: 50, maxAttempts: 5 }, calls: 1 };
  const convPrompt = compileInstructions({ task: convTask, files: [], tools: taskTools(convTask) });
  assert.match(convPrompt, /Tool Playbook/);
  assert.match(convPrompt, /browser\.open\(\{ url \}\)/);
  assert.match(convPrompt, /browser\.act using ref first/);
  assert.match(convPrompt, /browser\.close\(\{\}\)/);
  assert.match(convPrompt, /web\.search/);
  assert.match(convPrompt, /proactively call your advertised browser\.\*/);

  // Challenger only gets read-only repo tools — must NOT receive browser playbook
  const challengerTask = { workspaceKind: 'project', crewMember: { role: 'challenger' }, persona: 'focused' };
  const challengerPrompt = compileInstructions({ task: challengerTask, files: [], tools: taskTools(challengerTask) });
  assert.doesNotMatch(challengerPrompt, /browser\.open\(\{ url \}\)/);

  // Fixture tasks keep their exact legacy sovereign prompt without browser playbook
  const fixturePrompt = compileInstructions({ task: { fixtureId: 'task-board', persona: 'plinian' }, files: [], tools: taskTools(convTask) });
  assert.match(fixturePrompt, /SOVEREIGN CODE ENGINE/);
  assert.doesNotMatch(fixturePrompt, /Tool Playbook/);

  // buildContext preserves structured browser refs & url even when snapshot JSON exceeds 14 KiB!
  const bigBrowserEvent = {
    id: 42,
    seq: 42,
    type: 'tool.completed',
    time: new Date().toISOString(),
    data: {
      name: 'browser.open',
      ok: true,
      result: {
        ok: true,
        url: 'http://127.0.0.1:4321/app',
        title: 'Live App',
        text: 'A'.repeat(16000),
        truncated: false,
        elements: [
          { ref: 'e1', tag: 'input', role: 'textbox', text: 'Email', rect: { x: 10, y: 10, w: 200, h: 32 } },
          { ref: 'e2', tag: 'button', role: 'button', text: 'Sign In', rect: { x: 10, y: 50, w: 120, h: 36 } },
        ],
        consoleErrors: [{ level: 'error', message: 'Boom', time: '2026-01-01T00:00:00Z' }],
        screenshotUrl: '/api/tasks/t1/browser/screenshot?v=1',
        screenshotBytes: 8192,
      },
    },
  };
  const ctx = buildContext({
    task: { ...convTask, id: 't1', objective: 'Test the live app', constraints: [], followups: [], strategy: 'continue', contractVersion: 1, checks: [] },
    history: [bigBrowserEvent],
    files: [],
    snapshotHash: '0'.repeat(64),
  });
  const kept = ctx.history.find(e => e.id === 42);
  assert.ok(kept, 'browser.open result must survive buildContext');
  assert.equal(typeof kept.data.result, 'object', 'browser snapshot must stay a structured object, never wiped to a string');
  assert.equal(kept.data.result.url, 'http://127.0.0.1:4321/app');
  assert.equal(kept.data.result.elements.length, 2);
  assert.equal(kept.data.result.elements[1].ref, 'e2');
  assert.equal(kept.data.result.consoleErrors[0].message, 'Boom');
});

test('Conversation task using browser.open -> browser.act -> browser.close completes cleanly as answered (no bogus UNREGISTERED_ACCEPTANCE blocker)', async t => {
  const binary = await findChromiumBinary();
  if (!binary) {
    t.skip('No Chromium binary installed on this host');
    return;
  }
  const targetServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>Quick</title></head><body><button id="b">Go</button></body></html>');
  });
  await new Promise(resolve => targetServer.listen(0, '127.0.0.1', resolve));
  const targetUrl = `http://127.0.0.1:${targetServer.address().port}/`;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-browser-conv-'));
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-browser-conv-ws-'));
  let step = 0;
  const scripted = {
    id: 'browser-conv-bot',
    label: 'Browser Conv Bot',
    kind: 'scripted',
    available: true,
    protocol: 'openai-chat',
    model: 'browser-conv-bot',
    maxOutputTokens: 2048,
    maxOutputTokensCeiling: 4096,
    capabilities: { tools: true, nativeTools: true, portableContext: true, outputTokens: { initial: 2048, max: 4096 } },
    async turn() {
      step += 1;
      if (step === 1) return { type: 'tool', calls: [{ id: 'c1', name: 'browser.open', args: { url: targetUrl } }] };
      if (step === 2) return { type: 'tool', calls: [{ id: 'c2', name: 'browser.close', args: {} }] };
      return { type: 'message', finish: 'done', text: 'Visited and closed cleanly.' };
    },
  };
  const app = await createApp({ dataDir: dir, auth: false, providers: new Map([[scripted.id, scripted]]) });
  t.after(async () => {
    await app.close();
    targetServer.close();
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(ws, { recursive: true, force: true });
  });
  const task = await app.runtime.createTask({
    workspace: ws,
    workspaceKind: 'conversation',
    objective: 'Check the local page and report back',
    providers: [scripted.id],
  });
  await app.runtime.run(task.id);
  const done = app.runtime.getTask(task.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.completionKind, 'answered');
  assert.equal(done.blocker, null);
});

test('Venice catalog models with supportsFunctionCalling receive native browser.* tools, execute real headless Chromium tool_calls, and Auto-Arena bypasses tool-less race for browser prompts', async t => {
  const binary = await findChromiumBinary();
  if (!binary) {
    t.skip('No Chromium binary installed on this host');
    return;
  }

  assert.equal(promptNeedsLiveTools('go to google.com'), true);
  assert.equal(promptNeedsLiveTools('open https://news.ycombinator.com and click the top story'), true);
  assert.equal(promptNeedsLiveTools('use your browser to check localhost:3000'), true);
  assert.equal(promptNeedsLiveTools('write a haiku about volcanoes'), false);

  const targetServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>Venice Browser Target</title></head><body><h1>Hello From Contained Chrome</h1><button id="ok">Done</button></body></html>');
  });
  await new Promise(resolve => targetServer.listen(0, '127.0.0.1', resolve));
  const targetUrl = `http://127.0.0.1:${targetServer.address().port}/`;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-venice-tools-'));
  const providers = new Map([
    ['venice', new HttpProvider({ id: 'venice', label: 'Venice', model: 'venice-uncensored-1-2', baseUrl: veniceEndpoint, credential: 'test-key' })],
  ]);
  const app = await createApp({
    dataDir: dir,
    auth: false,
    providers,
    fetchCatalog: async () => Response.json({
      data: [
        { id: 'claude-opus-5-5', type: 'text', model_spec: { name: 'Claude Opus 5.5', maxCompletionTokens: 128000, capabilities: { supportsReasoning: true, supportsFunctionCalling: true } } },
        { id: 'venice-uncensored-1-2', type: 'text', model_spec: { name: 'Venice Uncensored 1.2', maxCompletionTokens: 8192, capabilities: { supportsReasoning: false, supportsFunctionCalling: false } } },
      ],
    }),
  });
  t.after(async () => {
    await app.close();
    targetServer.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const root = await app.listen(0);
  const nativeFetch = globalThis.fetch;
  const api = async (route, method = 'GET', body) => {
    const res = await nativeFetch(root + route, {
      method,
      headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, ...await res.json() };
  };

  await api('/api/providers/venice-models');

  const seenBodies = [];
  let turn = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url !== veniceEndpoint + '/chat/completions') return nativeFetch(url, init);
    const body = JSON.parse(init.body);
    seenBodies.push(body);
    turn += 1;
    if (turn === 1) {
      return Response.json({
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_open_1', type: 'function', function: { name: 'browser__open', arguments: JSON.stringify({ url: targetUrl }) } }],
          },
        }],
      });
    }
    if (turn === 2) {
      // Deliberately trigger a BROWSER_EVAL_ERROR (like parsing HTML as JSON) and verify the agent recovers on turn 3 instead of pausing!
      return Response.json({
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_bad_eval', type: 'function', function: { name: 'browser__eval', arguments: JSON.stringify({ expression: 'JSON.parse("<!DOCTYPE html>")' }) } }],
          },
        }],
      });
    }
    if (turn === 3) {
      return Response.json({
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_close_1', type: 'function', function: { name: 'browser__close', arguments: '{}' } }],
          },
        }],
      });
    }
    return Response.json({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Recovered from eval JSON error and closed cleanly.' } }],
    });
  });

  // Enable Ultra-Plinian Auto-Arena; a browser prompt MUST bypass tool-less answerRace and select the tool-capable model!
  await api('/api/router', 'PATCH', { mode: 'auto_arena' });
  const created = await api('/api/conversations', 'POST', {
    objective: `go to ${targetUrl} and check the heading`,
    providerIds: ['venice-catalog:claude-opus-5-5'],
  });
  assert.equal(created.status, 201);
  assert.equal(created.task.answerRace, undefined, 'Auto-Arena must bypass tool-less race when prompt needs live browser tools');
  assert.equal(created.task.providerId, 'venice-catalog:claude-opus-5-5');

  await app.runtime.run(created.task.id);
  const finalTask = app.runtime.getTask(created.task.id);
  assert.equal(finalTask.status, 'completed');
  assert.equal(finalTask.completionKind, 'answered');
  assert.equal(finalTask.blocker, null);

  assert.equal(seenBodies.length, 4);
  assert.ok(Array.isArray(seenBodies[0].tools) && seenBodies[0].tools.some(t => t.function?.name === 'browser__open'), 'Venice catalog model must receive native browser__open tool');
  assert.ok(!seenBodies[0].tools.some(t => t.function?.name === 'process__run'), 'process.run must NOT be advertised when execution is disabled');
  assert.match(seenBodies[0].messages[0].content, /Live Tools Enabled/);
  const toolReplyMsg = seenBodies[1].messages.find(m => m.role === 'tool' && m.tool_call_id === 'call_open_1');
  assert.ok(toolReplyMsg, 'Turn 2 must replay browser.open result as role:tool message');
  assert.match(toolReplyMsg.content, /Hello From Contained Chrome/);
  const evalErrReply = seenBodies[2].messages.find(m => m.role === 'tool' && m.tool_call_id === 'call_bad_eval');
  assert.ok(evalErrReply, 'Turn 3 must replay BROWSER_EVAL_ERROR back to the model so it can recover seamlessly');
  assert.match(evalErrReply.content, /BROWSER_EVAL_ERROR/);
});

test('Contained browser deep stress test: below-the-fold scroll-click, contenteditable, checkbox state, disabled guard, key combos, raw XML/JSON, connection refused, and crash auto-respawn', async t => {
  const binary = await findChromiumBinary();
  if (!binary) {
    t.skip('No Chromium binary installed on this host');
    return;
  }

  const targetServer = http.createServer((req, res) => {
    if (req.url === '/raw.xml') {
      res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' });
      res.end('<?xml version="1.0"?><response><domain>example.test</domain></response>');
      return;
    }
    if (req.url === '/api.json') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'ok', inbox: 'ghost@example.test' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html>
      <html>
        <head><title>Stress Edge Cases</title></head>
        <body style="font-family:system-ui;padding:24px">
          <h1>Deep Browser Stress</h1>
          <label><input id="chk" type="checkbox" /> Accept Terms</label>
          <div id="editor" contenteditable="true" style="min-height:36px;border:1px solid #999;padding:6px">InitialRichText</div>
          <button id="disabledBtn" type="button" disabled>Locked Button</button>
          <p id="keylog">NoKey</p>
          <div style="height:2200px"></div>
          <button id="deepBtn" type="button">Deep Below Fold</button>
          <p id="deepStatus">Unclicked</p>
          <script>
            document.getElementById('deepBtn').addEventListener('click', () => {
              document.getElementById('deepStatus').textContent = 'DeepClicked!';
            });
            document.addEventListener('keydown', e => {
              if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                document.getElementById('keylog').textContent = 'ShortcutTriggered';
              }
            });
          </script>
        </body>
      </html>`);
  });
  await new Promise(resolve => targetServer.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${targetServer.address().port}`;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-browser-stress-'));
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-browser-stress-ws-'));
  const store = new Store(path.join(dir, 'state'));
  const broker = new Broker({ store });
  t.after(async () => {
    await broker.close();
    store.close();
    targetServer.close();
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(ws, { recursive: true, force: true });
  });

  const task = store.createTask({
    id: randomUUID(),
    title: 'Browser stress',
    status: 'running',
    epoch: 1,
    workspace: ws,
    workspaceKind: 'conversation',
    execution: { enabled: false, network: false, timeoutMs: 10000 },
    checksContractVersion: 1,
    checks: [],
  });
  const call = (name, args = {}) =>
    broker.execute(task.id, { name, args, id: randomUUID() }, { epoch: task.epoch, outbound: { privacy: { localOnly: true } } });

  // 1) Open page, verify checkbox starts unchecked, toggle it to checked
  const opened = await call('browser.open', { url: base + '/' });
  assert.equal(opened.ok, true);
  const chkEl = opened.elements.find(e => e.type === 'checkbox');
  assert.ok(chkEl);
  assert.equal(chkEl.value, 'unchecked');
  const afterChk = await call('browser.act', { action: 'click', ref: chkEl.ref });
  assert.equal(afterChk.ok, true);
  assert.equal(afterChk.elements.find(e => e.type === 'checkbox')?.value, 'checked');

  // 2) contenteditable clear + type
  const edEl = afterChk.elements.find(e => e.text.includes('InitialRichText'));
  assert.ok(edEl, 'contenteditable div should be discovered as interactive ref');
  const typedEd = await call('browser.act', { action: 'type', ref: edEl.ref, clear: true, text: 'EditedRichText' });
  assert.equal(typedEd.ok, true);
  assert.equal((await call('browser.eval', { expression: 'document.getElementById("editor").textContent' })).result, 'EditedRichText');

  // 3) Disabled button returns clean BROWSER_ELEMENT_DISABLED
  const disabledEl = typedEd.elements.find(e => e.text.includes('Locked Button'));
  assert.ok(disabledEl && disabledEl.disabled === true);
  const disabledClick = await call('browser.act', { action: 'click', ref: disabledEl.ref });
  assert.equal(disabledClick.ok, false);
  assert.equal(disabledClick.error.code, 'BROWSER_ELEMENT_DISABLED');

  // 4) Modifier keyboard shortcut (Control+k)
  const pressed = await call('browser.act', { action: 'press', key: 'Control+k' });
  assert.equal(pressed.ok, true);
  assert.match(pressed.text, /ShortcutTriggered/);

  // 5) Below-the-fold button at y > 2200px auto-scrolls into view and clicks cleanly
  const deepRef = pressed.elements.find(e => e.text.includes('Deep Below Fold'))?.ref;
  assert.ok(deepRef);
  const deepClicked = await call('browser.act', { action: 'click', ref: deepRef });
  assert.equal(deepClicked.ok, true);
  assert.match(deepClicked.text, /DeepClicked!/);

  // 6) Raw XML & raw JSON endpoints extract readable text cleanly
  const xmlPage = await call('browser.open', { url: base + '/raw.xml' });
  assert.equal(xmlPage.ok, true);
  assert.match(xmlPage.text, /example\.test/);

  const jsonPage = await call('browser.open', { url: base + '/api.json' });
  assert.equal(jsonPage.ok, true);
  assert.match(jsonPage.text, /ghost@example\.test/);

  // 7) Unreachable loopback port fails cleanly with BROWSER_NAV_FAILED without killing session
  const refused = await call('browser.open', { url: 'http://127.0.0.1:1/' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'BROWSER_NAV_FAILED');

  // 8) Simulated Chromium crash (SIGKILL) auto-marks closed & cleanly respawns on next browser.open!
  const deadSession = broker.browser.sessions.get(task.id);
  assert.ok(deadSession?.proc);
  deadSession.proc.kill('SIGKILL');
  await new Promise(r => setTimeout(r, 350));
  const afterCrash = await call('browser.open', { url: base + '/api.json' });
  assert.equal(afterCrash.ok, true, afterCrash.error?.message);
  assert.match(afterCrash.text, /ghost@example\.test/);

  await call('browser.close', {});
});

test('Non-catalog HTTP providers keep the same model on recoverable BROWSER_EVAL_ERROR instead of rotating to fallback mid-browse', async t => {
  const binary = await findChromiumBinary();
  if (!binary) {
    t.skip('No Chromium binary installed on this host');
    return;
  }
  const targetServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>Stay Same Model</title></head><body><h1>Same Model Recovered</h1></body></html>');
  });
  await new Promise(resolve => targetServer.listen(0, '127.0.0.1', resolve));
  const targetUrl = `http://127.0.0.1:${targetServer.address().port}/`;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-browser-same-prov-'));
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-browser-same-ws-'));
  let primaryTurns = 0;
  let fallbackTurns = 0;
  const primary = {
    id: 'primary-http',
    label: 'Primary HTTP',
    kind: 'http',
    baseUrl: 'http://127.0.0.1:11434/v1',
    available: true,
    protocol: 'openai-chat',
    model: 'primary-http',
    maxOutputTokens: 4096,
    maxOutputTokensCeiling: 8192,
    capabilities: { tools: true, nativeTools: true, portableContext: true, outputTokens: { initial: 4096, max: 8192 } },
    async turn() {
      primaryTurns += 1;
      if (primaryTurns === 1) return { type: 'tool', calls: [{ id: 'p1', name: 'browser.open', args: { url: targetUrl } }] };
      if (primaryTurns === 2) return { type: 'tool', calls: [{ id: 'p2', name: 'browser.eval', args: { expression: 'JSON.parse("<!DOCTYPE html>")' } }] };
      if (primaryTurns === 3) return { type: 'tool', calls: [{ id: 'p3', name: 'browser.close', args: {} }] };
      return { type: 'message', finish: 'done', text: 'Same primary model recovered from BROWSER_EVAL_ERROR.' };
    },
  };
  const fallback = {
    id: 'fallback-http',
    label: 'Fallback HTTP',
    kind: 'http',
    baseUrl: 'http://127.0.0.1:11434/v1',
    available: true,
    protocol: 'openai-chat',
    model: 'fallback-http',
    maxOutputTokens: 4096,
    maxOutputTokensCeiling: 8192,
    capabilities: { tools: true, nativeTools: true, portableContext: true, outputTokens: { initial: 4096, max: 8192 } },
    async turn() {
      fallbackTurns += 1;
      return { type: 'message', finish: 'done', text: 'Should never be called.' };
    },
  };
  const app = await createApp({ dataDir: dir, auth: false, providers: new Map([[primary.id, primary], [fallback.id, fallback]]) });
  t.after(async () => {
    await app.close();
    targetServer.close();
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(ws, { recursive: true, force: true });
  });
  const task = await app.runtime.createTask({
    workspace: ws,
    workspaceKind: 'conversation',
    objective: 'Browse and recover from an eval error without switching models',
    providers: [primary.id, fallback.id],
    policy: { mode: 'adaptive', maxAttempts: 5, maxCalls: 20 },
  });
  await app.runtime.run(task.id);
  const done = app.runtime.getTask(task.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.providerId, primary.id, 'Must stay on primary provider after recoverable BROWSER_EVAL_ERROR');
  assert.equal(fallbackTurns, 0, 'Fallback provider must NOT be triggered by a single recoverable BROWSER_EVAL_ERROR');
  assert.equal(primaryTurns, 4);
});

test('Thinking effort levels (fast/medium/high/max) persist via PATCH /api/tasks/:id/effort, hide task.todo in fast mode, and pass reasoning_effort on reasoning models', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-effort-'));
  const providers = new Map([
    ['venice', new HttpProvider({ id: 'venice', label: 'Venice', model: 'claude-opus-5-5', baseUrl: veniceEndpoint, credential: 'test-key' })],
  ]);
  const app = await createApp({
    dataDir: dir,
    auth: false,
    providers,
    fetchCatalog: async () => Response.json({
      data: [
        { id: 'claude-opus-5-5', type: 'text', model_spec: { name: 'Claude Opus 5.5', maxCompletionTokens: 128000, capabilities: { supportsReasoning: true, supportsFunctionCalling: true } } },
      ],
    }),
  });
  t.after(async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const root = await app.listen(0);
  const nativeFetch = globalThis.fetch;
  const api = async (route, method = 'GET', body) => {
    const res = await nativeFetch(root + route, {
      method,
      headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, ...await res.json() };
  };
  await api('/api/providers/venice-models');

  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url !== veniceEndpoint + '/chat/completions') return nativeFetch(url, init);
    const body = JSON.parse(init.body);
    seen.push(body);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Fast answer.' } }] });
  });

  // 1) Start in Fast mode: no task.todo/agent.spawn advertised, reasoning_effort='low', fast prompt guidance
  const created = await api('/api/conversations', 'POST', {
    objective: 'What is 2 + 2?',
    effort: 'fast',
    providerIds: ['venice-catalog:claude-opus-5-5'],
  });
  assert.equal(created.status, 201);
  assert.equal(created.task.effort, 'fast');
  await app.runtime.run(created.task.id);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].reasoning_effort, 'low');
  assert.match(seen[0].messages[0].content, /Effort: Fast \(Instant\)/);
  assert.ok(!seen[0].tools.some(t => t.function?.name === 'task__todo'), 'fast conversation mode must omit task.todo');
  assert.ok(!seen[0].tools.some(t => t.function?.name === 'agent__spawn'), 'fast conversation mode must omit agent.spawn');
  assert.ok(seen[0].tools.some(t => t.function?.name === 'browser__open'), 'fast mode still keeps browser.open if needed');

  // 2) Switch to High via PATCH /api/tasks/:id/effort and send follow-up: task.todo restored, reasoning_effort='high'
  const patched = await api(`/api/tasks/${created.task.id}/effort`, 'PATCH', { effort: 'high' });
  assert.equal(patched.status, 200);
  assert.equal(patched.task.effort, 'high');
  await app.runtime.addMessage(created.task.id, 'Now design a full distributed consensus system.', 'm2');
  await app.runtime.run(created.task.id);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].reasoning_effort, 'high');
  assert.match(seen[1].messages[0].content, /Effort: High \(Deep\)/);
  assert.ok(seen[1].tools.some(t => t.function?.name === 'task__todo'), 'high effort restores task.todo');

  // 3) Invalid effort rejected cleanly
  const bad = await api(`/api/tasks/${created.task.id}/effort`, 'PATCH', { effort: 'turbo' });
  assert.equal(bad.status, 400);
});

test('Live Browser Combo: non-headless launch args, settings persistence, CDP screencast frames, click reticle events & zero inline style= dock UI', async (t) => {
  // 1) Launch args cleanly toggle headless vs isolated visible window
  const headlessArgs = buildChromiumLaunchArgs({ headless: true, viewport: { width: 1280, height: 800 }, profileDir: '/tmp/p1' });
  assert.ok(headlessArgs.includes('--headless=new'));
  assert.ok(headlessArgs.includes('--mute-audio'));
  assert.ok(headlessArgs.includes('--user-data-dir=/tmp/p1'));

  const visibleArgs = buildChromiumLaunchArgs({ headless: false, viewport: { width: 1280, height: 840 }, profileDir: '/tmp/p2' });
  assert.ok(!visibleArgs.includes('--headless=new'));
  assert.ok(!visibleArgs.includes('--mute-audio'));
  assert.ok(!visibleArgs.includes('--hide-scrollbars'));
  assert.ok(visibleArgs.includes('--window-position=80,60'));
  assert.ok(visibleArgs.includes('--user-data-dir=/tmp/p2'));

  const binary = await findChromiumBinary();
  if (!binary) { t.skip('No Chromium binary installed on this host'); return; }

  const targetServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>Live Mirror Target</title></head><body><h1>Watch Me Click</h1><button id="go" onclick="this.textContent=\'Clicked!\'">Go</button></body></html>');
  });
  await new Promise(resolve => targetServer.listen(0, '127.0.0.1', resolve));
  const targetUrl = `http://127.0.0.1:${targetServer.address().port}/`;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-live-browser-'));
  const stub = {
    id: 'openrouter:gemini-4-neon',
    label: 'Gemini 4 Neon',
    model: 'google/gemini-4-neon',
    kind: 'http',
    tier: 'frontier',
    available: true,
    capabilities: { tools: true, nativeTools: true },
    async turn() { return { type: 'message', finish: 'done', text: 'ok' }; }
  };
  const app = await createApp({ dataDir: dir, auth: false, providers: new Map([[stub.id, stub]]), cliDiscovery: { probes: [] } });
  // Keep test runs strictly headless even when toggling visibleWindow settings!
  app.runtime.broker.browser.forceHeadless = true;
  const root = await app.listen(0);
  const headers = { 'content-type': 'application/json', 'x-g0d-request': '1' };
  const uiPool = new BrowserPool({ forceHeadless: true });

  t.after(async () => {
    await uiPool.closeAll();
    await app.close();
    targetServer.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  // 2) Settings API persists visibleWindow / liveMirror / autoOpenMirror
  const s0 = await (await fetch(`${root}/api/browser/settings`)).json();
  assert.equal(s0.settings.visibleWindow, false);
  assert.equal(s0.settings.liveMirror, true);
  assert.equal(s0.chromiumAvailable, true);

  const s1 = await (await fetch(`${root}/api/browser/settings`, {
    method: 'PATCH', headers, body: JSON.stringify({ visibleWindow: true, autoOpenMirror: false })
  })).json();
  assert.equal(s1.settings.visibleWindow, true);
  assert.equal(s1.settings.autoOpenMirror, false);
  await fetch(`${root}/api/browser/settings`, {
    method: 'PATCH', headers, body: JSON.stringify({ visibleWindow: false, autoOpenMirror: true })
  });

  // 3) Live session + CDP screencast + click reticle telemetry + /frame endpoint
  const task = await app.runtime.createTask({ objective: 'Inspect target page', providerId: stub.id, workspace: dir });
  const receivedEvents = [];
  const unsub = app.runtime.subscribeStream(task.id, ev => receivedEvents.push(ev));

  await app.runtime.broker.browser.setScreencastWatching(task.id, true);
  await app.runtime.broker.browser.open(task.id, { url: targetUrl, waitMs: 250 }, { privacy: { localOnly: false } });
  await app.runtime.broker.browser.act(task.id, { action: 'click', selector: '#go', waitMs: 150 }, { privacy: { localOnly: false } });
  unsub();

  const st = await (await fetch(`${root}/api/tasks/${encodeURIComponent(task.id)}/browser/status`)).json();
  assert.equal(st.active, true);
  assert.equal(st.title, 'Live Mirror Target');
  assert.equal(st.hasFrame, true);
  assert.equal(st.lastAction?.action, 'click');
  assert.ok(Number.isFinite(st.lastAction?.x) && Number.isFinite(st.lastAction?.y), 'Click action must capture reticle coordinates');
  assert.ok(receivedEvents.some(e => e.type === 'browser.activity' && e.action === 'click' && Number.isFinite(e.x)));
  assert.ok(receivedEvents.some(e => e.type === 'browser.frame'));

  const frameRes = await fetch(`${root}/api/tasks/${encodeURIComponent(task.id)}/browser/frame`);
  assert.equal(frameRes.status, 200);
  assert.match(frameRes.headers.get('content-type') || '', /^image\/(jpeg|png)/);
  const frameBuf = Buffer.from(await frameRes.arrayBuffer());
  assert.ok(frameBuf.length > 500);

  // Invalid mode payload rejected with 400
  const badMode = await fetch(`${root}/api/tasks/${encodeURIComponent(task.id)}/browser/mode`, {
    method: 'POST', headers, body: JSON.stringify({ visibleWindow: 'yes' })
  });
  assert.equal(badMode.status, 400);

  // 4) Headless Chromium UI E2E: Live Browser dock renders frame cleanly with 0 inline style= and Settings → Tools shows switches
  const sid = 'live-browser-ui';
  await uiPool.open(sid, { url: `${root}/`, viewport: { width: 1440, height: 900 }, waitMs: 800 }, { privacy: { localOnly: false } });
  await uiPool.evaluate(sid, {
    expression: `(() => { window.__BL_ERRS = []; window.addEventListener('error', e => { if (!/ResizeObserver loop/i.test(e.message || '')) window.__BL_ERRS.push(e.message); }); window.addEventListener('unhandledrejection', e => window.__BL_ERRS.push(String(e.reason))); return true; })()`
  });
  const dlgs = JSON.parse((await uiPool.evaluate(sid, { expression: `[...document.querySelectorAll('dialog[open]')].map(d => d.id)` })).result);
  if (dlgs.length) await uiPool.act(sid, { action: 'press', key: 'Escape', waitMs: 150 }, { privacy: { localOnly: false } });

  await uiPool.evaluate(sid, { expression: `window.G0DBrowserLive.syncTask({ id: ${JSON.stringify(task.id)} }); window.G0DBrowserLive.open(); true;` });
  await new Promise(r => setTimeout(r, 450));

  const dockCheck = JSON.parse((await uiPool.evaluate(sid, {
    expression: `(() => ({
      open: window.G0DBrowserLive.isOpen(),
      url: document.getElementById('bl-url-text')?.textContent || '',
      canvasVisible: !document.getElementById('browser-live-canvas')?.classList.contains('hidden'),
      inlineStyles: document.querySelectorAll('#browser-dock [style]').length,
      errors: window.__BL_ERRS || [],
    }))()`
  })).result);
  assert.equal(dockCheck.open, true);
  assert.match(dockCheck.url, /127\.0\.0\.1/);
  assert.equal(dockCheck.canvasVisible, true);
  assert.equal(dockCheck.inlineStyles, 0);
  assert.deepEqual(dockCheck.errors, []);

  // Close browser session cleanly via API
  const closeRes = await (await fetch(`${root}/api/tasks/${encodeURIComponent(task.id)}/browser/close`, {
    method: 'POST', headers, body: '{}'
  })).json();
  assert.equal(closeRes.active, false);
});
