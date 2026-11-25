import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { createScriptedProviders } from '../bench/scripted.mjs';

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0dc0d3-server-test-'));
  try { return await fn(dir); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}

/** Dispatch an HTTP request directly to createApp's server handler (no TCP socket required). */
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
      }
    };
    try { app.server.emit('request', req, res); }
    catch (err) { reject(err); }
  });
}

test('createApp with auth:true enforces session token via Bearer and /api/session cookie', async () => {
  await withTempDir(async dir => {
    const app = await createApp({ dataDir: dir, providers: createScriptedProviders(), auth: true });
    try {
      await app.listen(0);
      const liveToken = new URL(app.accessUrl).hash.replace(/^#session=/, '');
      assert.match(liveToken, /^[0-9a-f]{64}$/);

      const health = await dispatch(app, { url: '/api/health' });
      assert.equal(health.status, 200);
      assert.equal(health.json.authRequired, true);

      const unauth = await dispatch(app, { url: '/api/state' });
      assert.equal(unauth.status, 401);

      const bearer = await dispatch(app, { url: '/api/state', headers: { authorization: `Bearer ${liveToken}` } });
      assert.equal(bearer.status, 200);
      assert.equal(bearer.json.sessionProtected, true);

      const exchange = await dispatch(app, {
        method: 'POST', url: '/api/session',
        headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
        body: { token: liveToken }
      });
      assert.equal(exchange.status, 200);
      const cookie = String(exchange.headers.get('set-cookie') || '').split(';')[0];
      assert.ok(cookie.startsWith('g0d_session='));

      const withCookie = await dispatch(app, { url: '/api/state', headers: { cookie } });
      assert.equal(withCookie.status, 200);

      // Cross-origin and missing header rejections
      const badHost = await dispatch(app, { url: '/api/health', headers: { host: 'evil.example:4317' } });
      assert.equal(badHost.status, 403);
      const noHeader = await dispatch(app, { method: 'POST', url: '/api/session', headers: { 'content-type': 'application/json' }, body: { token: liveToken } });
      assert.equal(noHeader.status, 403);
    } finally { await app.close(); }
  });
});

test('POST /api/tasks/:id/hunk invalidates verification, bumps epoch, and rejects bad paths', async () => {
  await withTempDir(async dir => {
    const app = await createApp({ dataDir: dir, providers: createScriptedProviders(), auth: false });
    try {
      const created = await dispatch(app, {
        method: 'POST', url: '/api/tasks',
        headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
        body: { fixtureId: 'task-board', autoRun: false }
      });
      assert.equal(created.status, 201);
      const { task } = created.json;

      const completed = await app.runtime.run(task.id);
      assert.equal(completed.status, 'completed');
      assert.equal(completed.verification.status, 'pass');
      const prevEpoch = completed.epoch;

      const badHunk = await dispatch(app, {
        method: 'POST', url: `/api/tasks/${task.id}/hunk`,
        headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
        body: { path: '../escape.txt', content: 'bad' }
      });
      assert.equal(badHunk.status, 404);

      const goodHunk = await dispatch(app, {
        method: 'POST', url: `/api/tasks/${task.id}/hunk`,
        headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
        body: { path: 'src/slug.mjs', content: 'export function slugify() { return "edited"; }\n' }
      });
      assert.equal(goodHunk.status, 200);
      const updated = app.runtime.getTask(task.id);
      assert.equal(updated.verification, null);
      assert.equal(updated.status, 'paused');
      assert.ok(updated.epoch > prevEpoch);
    } finally { await app.close(); }
  });
});

test('POST /api/providers/key rejects newline injection', async () => {
  await withTempDir(async dir => {
    const app = await createApp({ dataDir: dir, providers: createScriptedProviders(), auth: false });
    try {
      const res = await dispatch(app, {
        method: 'POST', url: '/api/providers/key',
        headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
        body: { provider: 'venice', key: 'validkey\nINJECTED=1' }
      });
      assert.equal(res.status, 400);
    } finally { await app.close(); }
  });
});

test('POST /api/tasks/race runs lanes and server closes cleanly without timer leaks', async () => {
  await withTempDir(async dir => {
    const app = await createApp({ dataDir: dir, providers: createScriptedProviders(), auth: false });
    try {
      const res = await dispatch(app, {
        method: 'POST', url: '/api/tasks/race',
        headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
        body: { fixtureId: 'task-board', racers: 2, providerIds: ['scripted-primary', 'scripted-fallback'] }
      });
      assert.equal(res.status, 201);
      assert.equal(res.json.lanes, 2);
      assert.equal(res.json.tasks.length, 2);
    } finally { await app.close(); }
  });
});

test('race watcher survives all lanes pausing and cancels the loser after a resumed winner', { timeout: 20000 }, async () => {
  await withTempDir(async dir => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    let winnerId = null;
    const providers = createScriptedProviders();
    for (const [id, provider] of providers) providers.set(id, { ...provider, async turn(context, options) {
      if (context.task.id === winnerId) return provider.turn(context, options);
      return new Promise((resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
        options.signal.addEventListener('abort', abort, { once: true });
        if (options.signal.aborted) abort();
      });
    } });
    const app = await createApp({ dataDir: dir, providers, auth: false });
    try {
      const response = await dispatch(app, {
        method: 'POST', url: '/api/tasks/race',
        headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
        body: { fixtureId: 'task-board', racers: 2, providerIds: ['scripted-primary', 'scripted-fallback'] }
      });
      assert.equal(response.status, 201);
      const ids = response.json.tasks.map(task => task.id);
      for (const id of ids) app.runtime.pause(id);
      // Cross a full watcher interval with every lane paused.
      await sleep(5200);
      assert.deepEqual(ids.map(id => app.runtime.getTask(id).status), ['paused', 'paused']);
      winnerId = ids[0];
      for (const id of ids) { app.runtime.resume(id); void app.runtime.run(id); }
      for (let n = 0; n < 100 && app.runtime.getTask(winnerId).status !== 'completed'; n++) await sleep(50);
      assert.equal(app.runtime.getTask(winnerId).status, 'completed');
      for (let n = 0; n < 110 && app.runtime.getTask(ids[1]).status !== 'cancelled'; n++) await sleep(50);
      assert.equal(app.runtime.getTask(ids[1]).status, 'cancelled');
    } finally { await app.close(); }
  });
});
