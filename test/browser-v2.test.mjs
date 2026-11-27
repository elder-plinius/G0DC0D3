import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { BrowserPool, findChromiumBinary } from '../src/browser-env.mjs';

test('Live Browser 2.0: Takeover gate pauses & resumes agent browser actions cleanly', async () => {
  const pool = new BrowserPool({ forceHeadless: true });
  try {
    const stOn = pool.setTakeover('task-gate-1', true);
    assert.equal(stOn.takeover, true);

    let resumed = false;
    const waiting = pool._waitIfTakeover('task-gate-1').then(() => { resumed = true; });
    await new Promise(r => setTimeout(r, 40));
    assert.equal(resumed, false, 'Agent action must pause while human takeover is active');

    const stOff = pool.setTakeover('task-gate-1', false);
    assert.equal(stOff.takeover, false);
    await waiting;
    assert.equal(resumed, true, 'Agent action must resume immediately once human clicks Resume Agent');
  } finally {
    await pool.closeAll();
  }
});

test('Live Browser 2.0 HTTP API: Auto-QA against Live Preview & Grounding in real Chromium (plus URL boundary enforcement)', async t => {
  const chromium = await findChromiumBinary();
  if (!chromium) {
    t.skip('No local Chromium binary found');
    return;
  }
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'g0d-browser-v2-'));
  const workDir = path.join(dir, 'work');
  await fs.mkdir(workDir, { recursive: true });
  const stub = {
    id: 'local:qa-stub',
    label: 'QA Stub',
    model: 'qa-stub',
    kind: 'http',
    tier: 'frontier',
    baseUrl: 'http://127.0.0.1:11434/v1',
    available: true,
    capabilities: { tools: true },
    async turn() { return { type: 'message', text: 'ok', finish: 'done' }; },
    close() {},
  };
  const app = await createApp({
    dataDir: dir,
    providers: new Map([[stub.id, stub]]),
    auth: false,
    cliDiscovery: { probes: [] },
    startScheduler: false,
  });
  t.after(async () => {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const root = await app.listen(0);
  const task = await app.runtime.createTask({
    title: 'Preview Auto-QA Test',
    objective: 'Verify live preview page',
    workspace: workDir,
    workspaceKind: 'conversation',
    providers: [stub.id],
    acceptance: { mode: 'owner' },
  });

  // 1. Reject external / non-preview URLs on /browser/qa-preview
  const badUrlRes = await fetch(`${root}/api/tasks/${task.id}/browser/qa-preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: root, 'x-g0d-request': '1' },
    body: JSON.stringify({ url: 'https://example.com/' }),
  });
  assert.equal(badUrlRes.status, 400);

  // 2. Create a clean multi-file Live Preview bundle and run real Chromium Auto-QA
  const prevRes = await fetch(`${root}/api/preview/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: root, 'x-g0d-request': '1' },
    body: JSON.stringify({
      entry: 'index.html',
      files: {
        'index.html': '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Clean App</title><link rel="stylesheet" href="./app.css"></head><body><main><h1>Hello QA</h1><button id="go">Launch</button></main></body></html>',
        'app.css': '*{box-sizing:border-box}body{margin:0;padding:16px;font-family:sans-serif;max-width:100vw}',
      },
    }),
  });
  assert.equal(prevRes.status, 201);
  const prev = await prevRes.json();

  const qaRes = await fetch(`${root}/api/tasks/${task.id}/browser/qa-preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: root, 'x-g0d-request': '1' },
    body: JSON.stringify({ url: prev.url }),
  });
  assert.equal(qaRes.status, 200);
  const qa = await qaRes.json();
  assert.equal(qa.ok, true);
  assert.equal(qa.passed, true, `Expected clean page to pass Auto-QA, got: ${JSON.stringify(qa.checks)}`);
  assert.equal(qa.score, 100);

  // 3. Visual Element Grounding returns the visible <button id="go"> with coordinates
  const groundRes = await fetch(`${root}/api/tasks/${task.id}/browser/grounding`);
  assert.equal(groundRes.status, 200);
  const ground = await groundRes.json();
  assert.equal(ground.ok, true);
  assert.ok(ground.elements.some(e => e.tag === 'button' && e.label.includes('Launch')), 'Grounding must detect visible Launch button');

  // 4. Takeover toggle via HTTP API
  const tkRes = await fetch(`${root}/api/tasks/${task.id}/browser/takeover`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: root, 'x-g0d-request': '1' },
    body: JSON.stringify({ active: true }),
  });
  assert.equal(tkRes.status, 200);
  assert.equal((await tkRes.json()).takeover, true);
  const tkOff = await fetch(`${root}/api/tasks/${task.id}/browser/takeover`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: root, 'x-g0d-request': '1' },
    body: JSON.stringify({ active: false }),
  });
  assert.equal((await tkOff.json()).takeover, false);
});
