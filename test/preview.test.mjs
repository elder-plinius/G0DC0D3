import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { PREVIEW_CSP } from '../src/preview.mjs';

test('Sandboxed live preview serves multi-file HTML/CSS/JS workspaces and chat snippets while blocking traversal & egress', async t => {
  const dataDir = await realpath(await mkdtemp(path.join(tmpdir(), 'g0d-preview-test-')));
  const workspace = path.join(dataDir, 'ws');
  await mkdir(path.join(workspace, '.git'), { recursive: true });
  await writeFile(path.join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  await writeFile(path.join(workspace, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="./style.css"></head><body><canvas id="c"></canvas><script type="module" src="./game.js"></script></body></html>', 'utf8');
  await writeFile(path.join(workspace, 'style.css'), 'body { background: #111; }', 'utf8');
  await writeFile(path.join(workspace, 'game.js'), 'export const score = 42;', 'utf8');

  const stub = { id: 's', label: 'Stub', model: 's', kind: 'http', tier: 'frontier', baseUrl: 'https://api.venice.ai/api/v1', available: true, capabilities: { tools: true }, async turn() { return { type: 'message', text: 'ok', finish: 'done' }; } };
  const app = await createApp({ dataDir, auth: false, providers: new Map([['s', stub]]) });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const root = await app.listen(0);

  const task = await app.runtime.createTask({ objective: 'Build game', workspace, workspaceKind: 'conversation', providers: ['s'], acceptance: { mode: 'owner' } });

  // 1. Create workspace preview session
  const sessRes = await fetch(root + '/api/preview/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
    body: JSON.stringify({ taskId: task.id })
  });
  assert.equal(sessRes.status, 201);
  const sess = await sessRes.json();
  assert.equal(sess.entry, 'index.html');
  assert.match(sess.url, /^\/preview\/[a-f0-9]{32}\/index\.html$/);

  // 2. HTML serves with strict sandboxed preview CSP + injected console bridge
  const htmlRes = await fetch(root + sess.url);
  assert.equal(htmlRes.status, 200);
  assert.equal(htmlRes.headers.get('content-security-policy'), PREVIEW_CSP);
  assert.match(htmlRes.headers.get('content-security-policy'), /connect-src 'none'/);
  const htmlText = await htmlRes.text();
  assert.match(htmlText, /g0d-preview-console/);
  assert.match(htmlText, /localStorage/);
  assert.match(htmlText, /Blocked or missing resource/);
  assert.match(htmlText, /<canvas id="c">/);

  // 3. Relative CSS & ES module JS load cleanly (even with Origin: null from opaque sandboxed iframe!)
  const jsRes = await fetch(root + `/preview/${sess.token}/game.js`, { headers: { origin: 'null' } });
  assert.equal(jsRes.status, 200);
  assert.match(jsRes.headers.get('content-type'), /javascript/);
  assert.equal(jsRes.headers.get('access-control-allow-origin'), '*');
  assert.match(await jsRes.text(), /score = 42/);

  const cssRes = await fetch(root + `/preview/${sess.token}/style.css`);
  assert.equal(cssRes.status, 200);
  assert.match(cssRes.headers.get('content-type'), /text\/css/);

  // 4. Blocks .git and path traversal
  const gitRes = await fetch(root + `/preview/${sess.token}/.git/HEAD`);
  assert.equal(gitRes.status, 403);
  const travRes = await fetch(root + `/preview/${sess.token}/..%2F..%2Fetc%2Fpasswd`);
  assert.equal(travRes.status, 403);

  // 5. Standalone SVG chat snippet session wraps cleanly as HTML
  const svgSess = await (await fetch(root + '/api/preview/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
    body: JSON.stringify({ html: '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#8b5cf6"/></svg>', name: 'badge.svg' })
  })).json();
  const svgHtml = await (await fetch(root + svgSess.url)).text();
  assert.match(svgHtml, /<circle cx="50" cy="50"/);
  assert.match(svgHtml, /svg:not\(\[width\]\)/);
  assert.match(svgHtml, /g0d-preview-console/);

  // 6. Multi-file in-memory bundle (stitched direct-chat HTML + CSS + JS game)
  const bundleRes = await fetch(root + '/api/preview/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
    body: JSON.stringify({
      entry: 'index.html',
      files: {
        'index.html': '<!doctype html><html><head><link rel="stylesheet" href="./style.css"></head><body><canvas id="g"></canvas><script src="./app.js"></script></body></html>',
        'style.css': 'body { margin: 0; background: #000; }',
        'app.js': 'window.__GAME_READY = true;'
      }
    })
  });
  assert.equal(bundleRes.status, 201);
  const bundleSess = await bundleRes.json();
  assert.equal(bundleSess.entry, 'index.html');
  assert.match(bundleSess.url, /^\/preview\/[a-f0-9]{32}\/index\.html$/);
  const bundleHtml = await (await fetch(root + bundleSess.url)).text();
  assert.match(bundleHtml, /<canvas id="g">/);
  assert.match(bundleHtml, /g0d-preview-console/);
  const bundleCss = await fetch(root + `/preview/${bundleSess.token}/style.css`);
  assert.equal(bundleCss.status, 200);
  assert.match(bundleCss.headers.get('content-type'), /text\/css/);
  const bundleJs = await fetch(root + `/preview/${bundleSess.token}/app.js`, { headers: { origin: 'null' } });
  assert.equal(bundleJs.status, 200);
  assert.equal(bundleJs.headers.get('access-control-allow-origin'), '*');
  assert.match(await bundleJs.text(), /__GAME_READY = true/);

  // 7. Completed conversation task allows toggling Plan/Build mode for follow-up turns
  app.runtime.store.updateTask(task.id, current => { current.status = 'completed'; current.completionKind = 'answered'; });
  const toggled = app.runtime.setPlanMode(task.id, true);
  assert.equal(toggled.planMode, true);

  // 8. Direct-chat & conversation system prompts advertise offline split-screen live preview canvas
  // only for visual/web/game requests (and never hijack non-web scripting/coding prompts with HTML instructions)
  const { catalogMessages } = await import('../src/providers.mjs');
  const { compileInstructions } = await import('../src/prompts.mjs');
  const directSys = catalogMessages({ task, history: [] })[0].content;
  assert.match(directSys, /Live Preview Canvas/i);
  assert.match(directSys, /zero external CDN/i);
  const nonVisualSys = catalogMessages({ task: { ...task, objective: 'Write a Python CLI script to parse PCAP files' }, history: [] })[0].content;
  assert.doesNotMatch(nonVisualSys, /Live Preview Canvas/i);
  const convSys = compileInstructions({ task, files: [], tools: [] });
  assert.match(convSys, /split-screen preview canvas/i);
});
