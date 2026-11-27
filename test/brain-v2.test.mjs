import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createApp } from '../src/server.mjs';
import { discoverSkills } from '../src/skills.mjs';

function dispatch(app, { method = 'GET', url = '/', body } = {}) {
  const address = app.server.address() || { address: '127.0.0.1', port: 4317 };
  if (!app.server.address()) app.server.address = () => address;
  const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const req = Readable.from(payload ? [payload] : []);
  req.method = method;
  req.url = url;
  req.headers = {
    host: `127.0.0.1:${address.port}`,
    ...(['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) ? { origin: `http://127.0.0.1:${address.port}`, 'x-g0d-request': '1' } : {}),
    ...(payload ? { 'content-type': 'application/json' } : {}),
  };
  req.setTimeout = () => {};
  return new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      statusCode: 200,
      setHeader() {},
      getHeader() {},
      writeHead(status) { this.statusCode = status; },
      write(chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); },
      end(chunk) {
        if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: this.statusCode, text, json });
      },
    };
    try { app.server.emit('request', req, res); }
    catch (err) { reject(err); }
  });
}

test('Brain 2.0 auto-learns durable user preferences & Conclave verdicts, respects Ephemeral privacy gate, and distills tasks into reusable Skills', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'g0d-brain2-'));
  const workDir = path.join(dir, 'work');
  await fs.mkdir(workDir, { recursive: true });
  const stub = {
    id: 'local:brain-stub',
    label: 'Brain Stub',
    model: 'brain-stub',
    kind: 'http',
    tier: 'frontier',
    baseUrl: 'http://127.0.0.1:11434/v1',
    available: true,
    capabilities: { tools: true, nativeTools: true, portableContext: true, nativeToolReplay: false, toolNames: [], instructionRole: 'system' },
    async turn() { return { type: 'message', text: 'Applied strict TypeScript types and zero-dependency helpers.', finish: 'done' }; },
    async draft() { return { type: 'message', text: 'Synthesized decision: adopt strict TypeScript and ESM modules across all services.', finish: 'done' }; },
    close() {},
  };

  const app = await createApp({
    dataDir: dir,
    providers: new Map([[stub.id, stub]]),
    auth: false,
    cliDiscovery: { probes: [] },
    startScheduler: false,
  });

  try {
    // 1. Completing a task with a durable user preference auto-learns into FTS5 MemoryStore
    const task = await app.runtime.createTask({
      title: 'API Architecture Rules',
      objective: 'Please always use pure ESM modules with zero external runtime dependencies when scaffolding services.',
      workspace: workDir,
      workspaceKind: 'conversation',
      providers: [stub.id],
      acceptance: { mode: 'owner' },
    });
    const done = await app.runtime.run(task.id);
    assert.equal(done.status, 'completed');

    const mems = app.runtime.memory.searchMemories({ query: 'ESM modules', includeGlobal: true }).memories;
    assert.ok(mems.length >= 1, 'Brain 2.0 should auto-learn durable preference into FTS5 memory');
    assert.ok(mems[0].tags.includes('auto-learned'));
    assert.ok(app.runtime.getEvents(task.id).some(e => e.type === 'memory.auto_learned'));

    // 2. 1-Click Save Run as Reusable Skill via POST /api/tasks/:id/save-skill
    const skillRes = await dispatch(app, {
      method: 'POST',
      url: `/api/tasks/${task.id}/save-skill`,
      body: { name: 'esm-service-scaffold' },
    });
    assert.equal(skillRes.status, 201);
    assert.equal(skillRes.json.ok, true);
    assert.equal(skillRes.json.skill.command, '/esm-service-scaffold');
    assert.match(skillRes.json.skill.body, /\$ARGUMENTS/);

    const discovered = await discoverSkills({ dataDir: dir });
    assert.ok(discovered.some(s => s.name === 'esm-service-scaffold'), 'Saved skill must be immediately discoverable');

    // 3. Ephemeral (Burn Bag) mode MUST block auto-learning AND save-skill (403 EPHEMERAL_SESSION)
    app.runtime.updatePrivacy({ applyProfile: 'hardened' });
    const countBefore = app.runtime.memory.listMemories({ limit: 100 }).memories.length;
    const ephemTask = await app.runtime.createTask({
      title: 'Secret Red Team Note',
      objective: 'Please always remember secret engagement target internal.corp.invalid.',
      workspace: workDir,
      workspaceKind: 'conversation',
      providers: [stub.id],
      acceptance: { mode: 'owner' },
    });
    await app.runtime.run(ephemTask.id);
    const countAfter = app.runtime.memory.listMemories({ limit: 100 }).memories.length;
    assert.equal(countAfter, countBefore, 'Ephemeral session must never persist auto-learned memory');

    const blockedSkill = await dispatch(app, {
      method: 'POST',
      url: `/api/tasks/${ephemTask.id}/save-skill`,
      body: { name: 'blocked-skill' },
    });
    assert.equal(blockedSkill.status, 403);
    assert.equal(blockedSkill.json.code, 'EPHEMERAL_SESSION');
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
