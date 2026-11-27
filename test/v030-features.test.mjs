import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { APP_VERSION } from '../src/version.mjs';
import {
  AUTOTUNE_PROFILES,
  defaultAutoTuneState,
  clampProfileToProvider,
  selectAutoTuneParams,
  recordAutoTuneOutcome,
  summarizeAutoTuneState,
} from '../src/autotune.mjs';
import {
  VISUALIZER_CSP,
  generateTaskVisualizer,
  readTaskVisualizerHtml,
  deleteTaskVisualizer,
} from '../src/visualizer.mjs';
import { BrowserPool } from '../src/browser-env.mjs';
import { normalizeRosterAgent } from '../src/conclave-roster.mjs';
import { createApp } from '../src/server.mjs';
import { implementationManifest } from '../bench/run.mjs';

function dispatch(app, { method = 'GET', url = '/', headers = {}, body } = {}) {
  const address = app.server.address() || { address: '127.0.0.1', port: 4317 };
  if (!app.server.address()) app.server.address = () => address;
  const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const req = Readable.from(payload ? [payload] : []);
  req.method = method;
  req.url = url;
  req.headers = { host: `127.0.0.1:${address.port}`, ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) };
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
        let json; try { json = JSON.parse(text); } catch {}
        resolve({ status: this.statusCode, headers: resHeaders, text, json });
      },
    };
    try { app.server.emit('request', req, res); }
    catch (err) { reject(err); }
  });
}

async function mkTempDir(prefix) {
  return fs.mkdtemp(path.join(tmpdir(), prefix));
}

test('v0.3.0 version centralization, CLI --version, and packaged bench manifest guard', async () => {
  const pkg = JSON.parse(await fs.readFile(path.resolve('package.json'), 'utf8'));
  assert.equal(APP_VERSION, pkg.version);
  assert.equal(APP_VERSION, '0.3.0');

  const cliRes = spawnSync(process.execPath, [path.resolve('src/cli.mjs'), '--version'], { encoding: 'utf8' });
  assert.equal(cliRes.status, 0);
  assert.match(cliRes.stdout, /g0d[mc]0d3\s+0\.3\.0/i);

  // implementationManifest() must never throw ENOENT even if a packaged runtime lacks scripts/
  const manifest = await implementationManifest();
  assert.ok(manifest && typeof manifest === 'object');
});

test('AutoTune: Empirical Bayes priors, provider capability clamping, manual-override immunity, learning & decay', () => {
  let state = defaultAutoTuneState();
  assert.equal(state.mode, 'passive');

  const openaiProv = { id: 'openai-gpt4o', model: 'gpt-4o', kind: 'openai', protocol: 'openai-chat' };

  // 1. In active mode (or once passive mode has observed outcomes), coding starts on focused/surgical and creative starts higher temperature
  const activeState = { ...state, mode: 'active' };
  const codingPick = selectAutoTuneParams(activeState, {
    provider: openaiProv,
    objective: 'Fix the race condition in src/runtime.mjs and pass unit tests',
    effort: 'high',
    rng: () => 0.99,
  });
  assert.equal(codingPick.active, true);
  assert.ok(['surgical', 'focused'].includes(codingPick.receipt.profileId), `expected low-variance profile for coding, got ${codingPick.receipt.profileId}`);

  // Cold-start passive mode observes cleanly without mutating raw provider wire defaults
  const coldPassive = selectAutoTuneParams(state, {
    provider: openaiProv,
    objective: 'Fix the race condition in src/runtime.mjs and pass unit tests',
    effort: 'high',
    rng: () => 0.99,
  });
  assert.equal(coldPassive.active, false);
  assert.equal(coldPassive.observing, true);

  const creativePick = selectAutoTuneParams(activeState, {
    provider: openaiProv,
    objective: 'Write a vivid cyberpunk short story about a sentient cathedral in orbit',
    effort: 'medium',
    rng: () => 0.99,
  });
  assert.equal(creativePick.active, true);
  assert.ok(['exploratory', 'balanced', 'high_entropy'].includes(creativePick.receipt.profileId));

  // 2. Manual sliders are NEVER overridden
  const clampedManual = clampProfileToProvider(
    AUTOTUNE_PROFILES.find(p => p.id === 'high_entropy'),
    openaiProv,
    { temperature: 0.25 }
  );
  assert.equal(clampedManual.applied.temperature, undefined, 'manual temperature must not be overwritten by AutoTune');
  assert.equal(clampedManual.generation.temperature, 0.25);

  const manualSelection = selectAutoTuneParams(state, {
    provider: openaiProv,
    objective: 'Fix a bug',
    manualGeneration: { temperature: 0.25 },
  });
  assert.equal(manualSelection.active, false);
  assert.equal(manualSelection.reason, 'manual_override');

  // 3. Reasoning-locked models (e.g. o3, gpt-5 high) drop unsupported temperature cleanly; Anthropic never sends both temperature and top_p
  const clampedO3 = clampProfileToProvider(
    AUTOTUNE_PROFILES.find(p => p.id === 'exploratory'),
    { id: 'openai-o3', model: 'o3', kind: 'openai', protocol: 'openai-responses' },
    {}
  );
  assert.equal(clampedO3.applied.temperature, undefined, 'o3 does not allow temperature');

  const clampedAnthropic = clampProfileToProvider(
    AUTOTUNE_PROFILES.find(p => p.id === 'focused'),
    { id: 'anthropic-sonnet', model: 'claude-sonnet-4-6', kind: 'http', protocol: 'anthropic' },
    {}
  );
  assert.ok(clampedAnthropic.applied.temperature !== undefined, 'Anthropic should receive temperature');
  assert.equal(clampedAnthropic.applied.top_p, undefined, 'Anthropic must never receive both temperature and top_p');

  const clampedAnthropicManualTopP = clampProfileToProvider(
    AUTOTUNE_PROFILES.find(p => p.id === 'focused'),
    { id: 'anthropic-sonnet', model: 'claude-sonnet-4-6', kind: 'http', protocol: 'anthropic' },
    { top_p: 0.9 }
  );
  assert.equal(clampedAnthropicManualTopP.applied.temperature, undefined, 'Anthropic must skip temperature when manual top_p is set');

  // Conclave roster normalization allows allowlisted harnessCommand and blocks shells without ReferenceError
  const agentOk = normalizeRosterAgent({ name: 'Auditor', harnessCommand: 'CLAUDE' });
  assert.equal(agentOk.harnessCommand, 'claude');
  assert.throws(() => normalizeRosterAgent({ name: 'Bad', harnessCommand: 'bash' }), { code: 'INVALID_AGENT' });

  // 4. Learning shifts posterior toward rewarded profile
  const modelKey = codingPick.receipt.modelKey;
  for (let i = 0; i < 8; i++) {
    state = recordAutoTuneOutcome(state, {
      modelKey,
      domain: 'coding',
      effort: 'high',
      profileId: 'surgical',
      signal: 'verification_pass',
    });
    state = recordAutoTuneOutcome(state, {
      modelKey,
      domain: 'coding',
      effort: 'high',
      profileId: 'focused',
      signal: 'verification_fail',
    });
  }
  const afterLearn = selectAutoTuneParams(state, {
    provider: openaiProv,
    objective: 'Refactor unit test harness and fix failing assertions',
    effort: 'high',
    rng: () => 0.99,
  });
  assert.equal(afterLearn.receipt.profileId, 'surgical');

  const summary = summarizeAutoTuneState(state);
  assert.ok(summary.totalObservations >= 16);
  assert.ok(summary.learned.some(r => r.modelKey === modelKey && r.domain === 'swe' && r.bestProfile === 'surgical'));

  // 5. Off mode disables tuning completely
  const offPick = selectAutoTuneParams({ ...state, mode: 'off' }, {
    provider: openaiProv,
    objective: 'Fix a bug',
  });
  assert.equal(offPick.active, false);
});

test('Visualizer sidecar: fallback generation, CSP strictness, custom metrics, and cleanup', async () => {
  const dir = await mkTempDir('g0d-viz-');
  const ws = path.join(dir, 'ws');
  await fs.mkdir(path.join(ws, '.g0dc0d3'), { recursive: true });
  await fs.writeFile(path.join(ws, '.g0dc0d3', 'viz-metrics.json'), JSON.stringify({ epoch: 4, accuracy: 0.94 }));

  const task = { id: 'task-viz-1', title: 'Benchmark Sweep', objective: 'Compare throughput', status: 'running', calls: 3, workspace: ws };
  const events = [
    { seq: 1, type: 'tool.completed', time: new Date().toISOString(), data: { name: 'repo.read', args: { path: 'src/index.mjs' }, result: { ok: true, path: 'src/index.mjs' }, durationMs: 12 } },
    { seq: 2, type: 'tool.completed', time: new Date().toISOString(), data: { name: 'process.run', args: { command: 'npm test' }, result: { ok: true, exitCode: 0 }, durationMs: 420 } },
  ];

  // CSP must include sandbox allow-scripts and forbid network/external scripts
  assert.match(VISUALIZER_CSP, /^sandbox allow-scripts;/);
  assert.match(VISUALIZER_CSP, /default-src 'none'/);
  assert.match(VISUALIZER_CSP, /connect-src 'none'/);

  // Fallback path when no provider supplied — also verifies </SCRIPT> XSS breakout escaping
  const xssTask = { ...task, objective: 'Compare </SCRIPT><img src=x onerror=alert(1)> throughput' };
  const res = await generateTaskVisualizer({ dataDir: dir, task: xssTask, events, files: [{ path: 'src/index.mjs', bytes: 1200 }] });
  assert.equal(res.generatedBy, 'deterministic_fallback');
  const html = await readTaskVisualizerHtml(dir, task.id);
  assert.ok(html && html.includes('<!doctype html>'));
  assert.ok(html.includes('Content-Security-Policy'));
  assert.ok(html.includes('g0d:viz'));
  assert.ok(html.includes('"accuracy":0.94'));
  assert.ok(!html.includes('</SCRIPT>'), 'uppercase </SCRIPT> must be escaped as \\u003c/SCRIPT\\u003e');

  // Symlinked .g0dc0d3 directory outside workspace must be rejected
  const symWs = path.join(dir, 'sym-ws');
  const secretDir = path.join(dir, 'secret-outside');
  await fs.mkdir(symWs, { recursive: true });
  await fs.mkdir(secretDir, { recursive: true });
  await fs.writeFile(path.join(secretDir, 'viz-metrics.json'), JSON.stringify({ secret: 'LEAKED' }));
  await fs.symlink(secretDir, path.join(symWs, '.g0dc0d3'));
  const symRes = await generateTaskVisualizer({ dataDir: dir, task: { ...task, id: 'task-viz-sym', workspace: symWs }, events });
  assert.equal(symRes.payload.metrics, null, 'symlinked .g0dc0d3 must never be read');
  await deleteTaskVisualizer(dir, 'task-viz-sym');

  // Unsafe AI HTML containing external <script src=...> is rejected and safely falls back
  const unsafeProvider = {
    id: 'bad-viz',
    draft: async () => ({ type: 'message', text: '<!doctype html><html><head><script src="https://evil.example/x.js"></script></head><body>hi</body></html>' }),
  };
  const safeRes = await generateTaskVisualizer({ dataDir: dir, task, events, provider: unsafeProvider });
  assert.equal(safeRes.generatedBy, 'deterministic_fallback');

  // Clean AI HTML is accepted
  const goodProvider = {
    id: 'good-viz',
    draft: async () => ({ type: 'message', text: '```html\n<!doctype html><html><body><svg id="chart"></svg><script>window.addEventListener("message",()=>{});</script></body></html>\n```' }),
  };
  const aiRes = await generateTaskVisualizer({ dataDir: dir, task, events, provider: goodProvider });
  assert.equal(aiRes.generatedBy, 'good-viz');
  const aiHtml = await readTaskVisualizerHtml(dir, task.id);
  assert.ok(aiHtml.includes('<svg id="chart"></svg>'));

  // Cleanup works
  await deleteTaskVisualizer(dir, task.id);
  assert.equal(await readTaskVisualizerHtml(dir, task.id), null);
  await fs.rm(dir, { recursive: true, force: true });
});

test('BrowserPool: _waitIfTakeover respects AbortSignal and closeAllSessions preserves reapTimer', async () => {
  const pool = new BrowserPool({ reapMs: 60_000 });
  const taskId = 'task-takeover-abort';
  pool.setTakeover(taskId, true);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 35);

  await assert.rejects(
    () => pool._waitIfTakeover(taskId, ac.signal),
    /Human Takeover/i
  );

  // closeAllSessions must clear sessions & takeover state while keeping reapTimer alive
  await pool.closeAllSessions();
  assert.equal(pool.takeoverGates.size, 0);
  assert.ok(pool.reapTimer, 'reapTimer should remain armed after closeAllSessions()');
  await pool.closeAll();
  assert.equal(pool.reapTimer, null);
});

test('Instant Steer preemption & Parallel sidecar interjection + HTTP v0.3.0 endpoints', async () => {
  const dir = await mkTempDir('g0d-v030-srv-');
  const ws = path.join(dir, 'workspace');
  await fs.mkdir(ws, { recursive: true });
  await fs.writeFile(path.join(ws, 'hello.txt'), 'hello v0.3.0\n');

  let mainCallCount = 0;
  let abortedFirstCall = false;
  let releaseFirstCall = null;
  let firstCallStartedResolve = null;
  const firstCallStarted = new Promise(r => { firstCallStartedResolve = r; });

  const slowProvider = {
    id: 'mock-slow',
    label: 'Mock Slow',
    kind: 'http',
    protocol: 'openai-chat',
    tier: 'local',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'gpt-4o',
    available: true,
    async turn(context, { signal } = {}) {
      mainCallCount += 1;
      if (mainCallCount === 1) {
        firstCallStartedResolve();
        await new Promise((resolve, reject) => {
          releaseFirstCall = resolve;
          signal?.addEventListener('abort', () => {
            abortedFirstCall = true;
            const e = new Error('Aborted by instant steer');
            e.name = 'AbortError';
            reject(e);
          }, { once: true });
        });
      }
      const hasSteer = JSON.stringify(context || {}).includes('Pivot to JSON output');
      return {
        type: 'message',
        text: hasSteer ? '{"pivoted":true}' : 'normal answer',
        finish: 'done',
      };
    },
    async draft(messages) {
      const joined = (messages || []).map(m => m.content).join('\n');
      if (/Visualizer/i.test(joined)) {
        return { type: 'message', text: '<!doctype html><html><body><h1>Live Sidecar</h1></body></html>' };
      }
      return { type: 'message', text: `Sidecar reply for: ${joined.slice(0, 40)}` };
    },
  };

  const app = await createApp({
    dataDir: dir,
    providers: new Map([[slowProvider.id, slowProvider]]),
    auth: false,
  });
  const hdrs = { 'content-type': 'application/json', 'x-g0d-request': '1' };

  try {
    // 1. /api/health exposes APP_VERSION 0.3.0 and acp: true
    const health = (await dispatch(app, { url: '/api/health' })).json;
    assert.equal(health.version, '0.3.0');
    assert.equal(health.acp, true);

    // 2. /api/autotune + /api/hypertuner alias GET / PATCH / DELETE
    const at0 = (await dispatch(app, { url: '/api/hypertuner' })).json;
    assert.equal(at0.mode, 'passive');
    const at1 = (await dispatch(app, { method: 'PATCH', url: '/api/autotune', headers: hdrs, body: { mode: 'active' } })).json;
    assert.equal(at1.mode, 'active');
    const at2 = (await dispatch(app, { method: 'DELETE', url: '/api/autotune', headers: hdrs, body: {} })).json;
    assert.equal(at2.mode, 'active');

    // 3. Start a task, wait for in-flight LLM call, test Parallel sidecar AND Instant Steer preemption!
    const createdTask = await app.runtime.createTask({
      objective: 'Analyze the workspace thoroughly',
      workspace: ws,
      workspaceKind: 'conversation',
      acceptance: { mode: 'owner' },
      providers: ['mock-slow'],
    });
    const taskId = createdTask.id;
    const runPromise = app.runtime.run(taskId);

    await firstCallStarted;

    // 3a. Parallel sidecar interjection runs concurrently WITHOUT aborting the main turn!
    const parRes = (await dispatch(app, {
      method: 'POST',
      url: `/api/tasks/${encodeURIComponent(taskId)}/message`,
      headers: hdrs,
      body: { message: 'Quick side question while working', mode: 'parallel' },
    })).json;
    assert.equal(parRes.parallel, true, `parallel sidecar should return parallel:true, got ${JSON.stringify(parRes)}`);
    assert.ok(parRes.workerId, 'parallel sidecar should return workerId');
    assert.equal(abortedFirstCall, false, 'parallel sidecar must NOT abort the main in-flight turn');

    // 3b. Instant Steer immediately aborts the in-flight turn and re-plans with the steer text!
    const steerRes = await dispatch(app, {
      method: 'POST',
      url: `/api/tasks/${encodeURIComponent(taskId)}/message`,
      headers: hdrs,
      body: { message: 'Pivot to JSON output', mode: 'steer' },
    });
    assert.ok([200, 202].includes(steerRes.status), `expected 200 or 202, got ${steerRes.status}`);

    // Wait for completion via runPromise + verify via HTTP GET /api/tasks/:id
    await runPromise;
    const detailRes = await dispatch(app, { url: `/api/tasks/${encodeURIComponent(taskId)}` });
    assert.equal(detailRes.status, 200);
    const finalTask = detailRes.json;
    assert.equal(abortedFirstCall, true, 'Instant Steer must abort the in-flight provider call');
    assert.ok(['completed', 'waiting_input'].includes(finalTask?.task?.status), `expected completed or waiting_input after steer, got ${finalTask?.task?.status}`);
    const events = finalTask.events || [];
    assert.ok(events.some(e => e.type === 'model.interrupted' && e.data?.reason === 'steer_preempted'), 'should record model.interrupted steer_preempted event');
    assert.ok(events.some(e => e.type === 'model.response' && e.data?.response?.text === '{"pivoted":true}'), 'model should pivot immediately to steered JSON output');
    assert.ok(events.some(e => e.type === 'autotune.selected'), 'should record autotune.selected receipt event');
    assert.ok(events.some(e => e.type === 'subagent.completed' && (e.data?.role === 'sidecar' || e.data?.parallelInterjection)), 'should record parallel sidecar completion');

    // 4. Live Visualizer endpoints + strict CSP header
    const vizGen = (await dispatch(app, {
      method: 'POST',
      url: `/api/tasks/${encodeURIComponent(taskId)}/visualize`,
      headers: hdrs,
      body: { instruction: 'Show timeline' },
    })).json;
    assert.ok(vizGen.ok);

    const vizDoc = await dispatch(app, { url: `/api/tasks/${encodeURIComponent(taskId)}/visualizer` });
    assert.equal(vizDoc.status, 200);
    assert.match(vizDoc.headers.get('content-security-policy') || '', /sandbox allow-scripts/);
    assert.match(vizDoc.headers.get('content-security-policy') || '', /connect-src 'none'/);
    assert.equal(vizDoc.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.ok(vizDoc.text.includes('Live Sidecar'));

    const vizTel = (await dispatch(app, { url: `/api/tasks/${encodeURIComponent(taskId)}/visualizer-telemetry` })).json;
    assert.equal(vizTel.type, 'g0d:viz');
    assert.equal(vizTel.task.id, taskId);
  } finally {
    if (releaseFirstCall) releaseFirstCall();
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
