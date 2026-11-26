import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApp } from '../src/server.mjs';
import { Runtime } from '../src/runtime.mjs';
import { HttpProvider, catalogMessages } from '../src/providers.mjs';
import { veniceEndpoint } from '../src/venice-catalog.mjs';
import { evaluatePermission, globMatch } from '../src/permissions.mjs';

const secret = 'synthetic-keychain-secret-for-regression';
const models = ['swift', 'careful', 'editor'];
const modelId = id => 'venice-catalog:' + id;
const race = { models: models.slice(0, 2).map(modelId), judge: modelId('editor') };
const response = text => Response.json({ choices: [{ message: { content: text }, finish_reason: 'stop' }] });
async function harness(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'godmode-pr5-'));
  const providers = new Map([
    ['venice', new HttpProvider({ id: 'venice', model: 'swift', baseUrl: veniceEndpoint, credential: secret })],
    ['router', new HttpProvider({ id: 'router', model: 'writer', baseUrl: 'https://openrouter.ai/api/v1', credential: secret })],
  ]);
  let catalogCalls = 0;
  const app = await createApp({ dataDir: path.join(dir, 'state'), auth: false, providers, fetchCatalog: async () => {
    catalogCalls++;
    return Response.json({ data: models.map(id => ({ id, type: 'text', model_spec: { maxCompletionTokens: 4000 } })) });
  } });
  app.runtime.outboundSecrets = () => [secret];
  const root = await app.listen(0), originalFetch = globalThis.fetch;
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const api = async (route, body, method = body ? 'POST' : 'GET') => {
    const res = await originalFetch(root + route, { method, headers: { 'content-type': 'application/json', 'x-g0d-request': '1' }, body: body && JSON.stringify(body) });
    return { status: res.status, ...await res.json() };
  };
  return { dir, app, api, originalFetch, catalogCalls: () => catalogCalls };
}

test('privacy applies to race writers, judge and catalog refresh; fork keeps context and precise parameters', async t => {
  const { app, api, originalFetch, catalogCalls } = await harness(t);
  const { task } = await api('/api/conversations', { objective: 'Remember the phrase Violet Harbor. ' + secret, providerIds: [modelId('swift')], answerRace: race });
  assert.ok(task);
  app.runtime.updateGeneration(task.id, { temperature: 0.314159265358979, top_p: 0.876543210123456 });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (!url.startsWith(veniceEndpoint)) return originalFetch(url, init);
    calls++;
    const body = JSON.parse(init.body);
    assert.ok(!init.body.includes(secret), 'all cloud messages must redact the configured credential');
    if (body.model === 'editor') return response(JSON.stringify({ winner: 'A', grades: [
      { id: 'A', fidelity: 5, completeness: 5, clarity: 5, reason: 'Clear and complete.' },
      { id: 'B', fidelity: 4, completeness: 4, clarity: 4, reason: 'Less precise.' },
    ] }));
    assert.equal(body.temperature, 0.314159265358979);
    return response('Violet Harbor is remembered.');
  });
  app.runtime.updatePrivacy({ localOnly: true });
  const before = catalogCalls();
  const cached = await app.runtime.catalog.list(true);
  assert.equal(catalogCalls(), before);
  assert.equal(cached.models.length, 3);
  await app.runtime.run(task.id);
  assert.equal(calls, 0);
  assert.equal(app.runtime.getPrivacy().audit.filter(entry => entry.blocked).length, 2);
  app.runtime.updatePrivacy({ localOnly: false });
  app.runtime.resume(task.id);
  await app.runtime.run(task.id);
  assert.equal(calls, 3);
  assert.equal(app.runtime.getTask(task.id).status, 'completed');
  assert.equal(app.runtime.getPrivacy().audit.filter(entry => !entry.blocked).length, 3);
  const fork = await app.runtime.forkTask(task.id);
  assert.deepEqual(fork.generation, app.runtime.getTask(task.id).generation);
  assert.deepEqual(fork.answerRace, race);
  const context = catalogMessages({ task: fork, history: app.runtime.getRecentEvents(fork.id, 200) });
  assert.ok(context.some(message => message.role === 'assistant' && message.content === 'Violet Harbor is remembered.'));
});

test('worktree preview matches redacted ZDR request; local-only blocks build and attached chat deletion preserves worktree', async t => {
  const { dir, app, api, originalFetch } = await harness(t);
  const repo = path.join(dir, 'repo');
  await mkdir(repo);
  const git = (...args) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, stdio: 'pipe' });
  git('init');
  await writeFile(path.join(repo, 'label.txt'), 'Old label\n');
  git('add', '.'); git('-c', 'user.name=Regression', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  const { task } = await api('/api/conversations', { objective: 'Improve a label.', providerIds: ['venice'] });
  const tree = await api(`/api/conversations/${task.id}/repository`, { repository: repo });
  assert.equal(tree.status, 200);
  app.runtime.updatePrivacy({ strictZdr: true });
  const request = { objective: 'Use New label. ' + secret, files: ['label.txt'], providerIds: ['router'] };
  const preview = await api(`/api/worktrees/${tree.id}/build-preview`, request);
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.requests[0].body.provider, { zdr: true, data_collection: 'deny', allow_fallbacks: false });
  assert.ok(!JSON.stringify(preview).includes(secret));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (!url.startsWith('https://openrouter.ai/')) return originalFetch(url, init);
    calls++;
    assert.deepEqual(JSON.parse(init.body), preview.requests[0].body);
    return response('diff --git a/label.txt b/label.txt\n--- a/label.txt\n+++ b/label.txt\n@@ -1 +1 @@\n-Old label\n+New label\n');
  });
  const built = await api(`/api/worktrees/${tree.id}/build`, { ...request, fingerprint: preview.fingerprint });
  assert.equal(built.status, 200);
  assert.ok(built.candidates[0].patch);
  assert.equal(calls, 1);
  assert.equal(app.runtime.getPrivacy().audit[0].secretsRedacted, 1);
  const deleted = await api(`/api/tasks/${task.id}`, {}, 'DELETE');
  assert.equal(deleted.status, 409);
  assert.equal((await api(`/api/tasks/${task.id}`)).status, 200);
  assert.equal(await readFile(path.join(repo, 'label.txt'), 'utf8'), 'Old label\n');
  app.runtime.updatePrivacy({ localOnly: true });
  const blocked = await api(`/api/worktrees/${tree.id}/build`, request);
  assert.equal(blocked.status, 400);
  assert.match(blocked.error, /local.only/i);
  assert.equal(calls, 1);
});

test('once and always approvals bind every argument; wildcard rules stay bounded and protect move destinations', async t => {
  assert.equal(globMatch('*a'.repeat(100) + 'b', 'a'.repeat(30000)), false);
  assert.equal(globMatch('src/?.js', 'src/a.js'), true);
  assert.equal(evaluatePermission([{ tool: 'repo.move', pattern: 'private/*', action: 'deny' }], 'repo.move', { from: 'public/a', to: 'private/a' }).action, 'deny');
  const dir = await mkdtemp(path.join(tmpdir(), 'godmode-approvals-'));
  const ws = path.join(dir, 'workspace'); await mkdir(ws);
  let content = 'original';
  const provider = { id: 'stub', kind: 'http', available: true, capabilities: { tools: true, nativeTools: true, portableContext: true },
    async turn() { return { type: 'tool', calls: [{ id: 'write-' + content, name: 'repo.write', args: { path: 'note.txt', content, expectedHash: null } }] }; } };
  const runtime = new Runtime({ dataDir: path.join(dir, 'state'), providers: new Map([['stub', provider]]) });
  t.after(async () => { await runtime.close(); await rm(dir, { recursive: true, force: true }); });
  const task = await runtime.createTask({ objective: 'Write note.', workspace: ws, providers: ['stub'], permissionRules: [{ tool: 'repo.write', action: 'ask' }] });
  await runtime.run(task.id);
  runtime.resolveApproval(task.id, { decision: 'once', resume: false });
  content = 'changed'; runtime.resume(task.id); await runtime.run(task.id);
  assert.equal(runtime.getTask(task.id).pendingApproval.args.content, 'changed');
  await assert.rejects(readFile(path.join(ws, 'note.txt')));
  const approved = runtime.resolveApproval(task.id, { decision: 'always', resume: false });
  const rules = approved.task.permissionRules;
  assert.equal(evaluatePermission(rules, 'repo.write', { expectedHash: null, content: 'changed', path: 'note.txt' }).action, 'allow');
  assert.equal(evaluatePermission(rules, 'repo.write', { expectedHash: null, content: 'different', path: 'note.txt' }).action, 'ask');
});
