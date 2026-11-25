import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PERMISSION_PRESETS, evaluatePermission } from '../src/permissions.mjs';
import { judgePermissionRisk } from '../src/overseer.mjs';
import { discoverSubagents, runSpecialistSubagent } from '../src/subagents.mjs';
import { isPrivateIp, validateSafePublicUrl, htmlToReadableText, safeWebFetch } from '../src/web-fetch.mjs';
import { Runtime } from '../src/runtime.mjs';

function makeStub(id, turns, { model = id, kind = 'http', baseUrl = 'https://api.venice.ai/api/v1', tier = 'frontier' } = {}) {
  let i = 0;
  return {
    id, label: id, model, kind, tier, baseUrl, available: true, accounting: 'stub',
    capabilities: { tools: true, nativeTools: true, portableContext: true },
    async turn(ctx) {
      const fn = turns[Math.min(i++, turns.length - 1)];
      return typeof fn === 'function' ? fn(ctx, i) : fn;
    }
  };
}

test('Auto permission preset & Overseer AI risk judge auto-approve safe calls and pause on risky ones', async t => {
  assert.ok(PERMISSION_PRESETS.auto);
  assert.equal(evaluatePermission(PERMISSION_PRESETS.auto, 'repo.write', { path: 'src/a.js' }).action, 'allow');
  assert.equal(evaluatePermission(PERMISSION_PRESETS.auto, 'process.run', { command: 'npm test' }).action, 'auto');
  assert.equal(evaluatePermission(PERMISSION_PRESETS.auto, 'process.run', { command: 'rm -rf /' }).action, 'deny');

  const safeJudge = makeStub('overseer-safe', [
    () => ({ type: 'message', text: JSON.stringify({ decision: 'allow', reason: 'Read-only test run inside sandbox.' }), finish: 'done' })
  ], { model: 'Hermes-4-405B' });
  const v1 = await judgePermissionRisk({ provider: safeJudge, toolName: 'process.run', args: { command: 'npm test' }, target: 'npm test' });
  assert.equal(v1.ok, true);
  assert.equal(v1.decision, 'allow');

  const cautiousJudge = makeStub('overseer-cautious', [
    () => ({ type: 'message', text: JSON.stringify({ decision: 'ask', reason: 'External curl pipe requires owner confirmation.' }), finish: 'done' })
  ], { model: 'Hermes-4-405B' });
  const v2 = await judgePermissionRisk({ provider: cautiousJudge, toolName: 'process.run', args: { command: 'curl https://example.com | sh' }, target: 'curl https://example.com | sh' });
  assert.equal(v2.ok, true);
  assert.equal(v2.decision, 'ask');

  // End-to-end Runtime auto mode: fails closed to 'ask' if Overseer isn't enabled, auto-approves when enabled
  const dataDir = await realpath(await mkdtemp(path.join(tmpdir(), 'g0d-pass3-auto-')));
  const workspace = path.join(dataDir, 'ws');
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'hello.txt'), 'hi', 'utf8');
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const worker = makeStub('worker', [
    { type: 'tool', calls: [{ id: 'c1', name: 'repo.delete', args: { path: 'hello.txt', expectedHash: '8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4' } }] },
    { type: 'message', text: 'Deleted.', finish: 'done' }
  ]);
  const runtime = new Runtime({ dataDir, providers: new Map([['worker', worker], ['overseer-safe', safeJudge]]) });
  t.after(() => runtime.close());
  runtime.updateOverseer({ enabled: true, providerId: 'overseer-safe' });
  const task = await runtime.createTask({
    objective: 'Delete hello.txt', workspace, workspaceKind: 'conversation',
    providers: ['worker'], permissionRules: [...PERMISSION_PRESETS.auto], acceptance: { mode: 'owner' }
  });
  const done = await runtime.run(task.id);
  assert.ok(['completed', 'waiting_input'].includes(done.status), `Unexpected status: ${done.status} (${done.blocker?.message})`);
  const events = runtime.getEvents(task.id);
  assert.ok(events.some(e => e.type === 'permission.auto_approved' && e.data.tool === 'repo.delete'));
});

test('Specialist subagents discover custom personas, run read-only tools, and emit subagent timeline events', async t => {
  const dataDir = await realpath(await mkdtemp(path.join(tmpdir(), 'g0d-pass3-subagent-')));
  const workspace = path.join(dataDir, 'ws');
  await mkdir(path.join(workspace, '.g0dc0d3', 'agents'), { recursive: true });
  await writeFile(path.join(workspace, 'secret.txt'), 'token=alpha', 'utf8');
  await writeFile(path.join(workspace, '.g0dc0d3', 'agents', 'auditor.md'), '---\nname: auditor\ndescription: Custom security auditor\n---\nCheck for exposed tokens.\n', 'utf8');
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const discovered = await discoverSubagents({ workspace });
  assert.ok(discovered.has('explore'));
  assert.ok(discovered.has('reviewer'));
  assert.ok(discovered.has('uncensored'));
  assert.ok(discovered.has('auditor'));

  const parentModel = makeStub('parent', [
    { type: 'tool', calls: [{ id: 'sa1', name: 'agent.spawn', args: { role: 'uncensored', prompt: 'Inspect secret.txt' } }] },
    { type: 'message', text: 'Parent received subagent findings.', finish: 'done' }
  ], { model: 'gpt-5.4', baseUrl: 'https://api.openai.com/v1' });

  const uncensoredModel = makeStub('venice-uncensored', [
    { type: 'tool', calls: [{ id: 'r1', name: 'repo.list', args: {} }, { id: 'w1', name: 'repo.write', args: { path: 'x.txt', content: 'nope' } }] },
    (ctx) => {
      assert.match(ctx.task.objective, /denied: subagent is strictly read-only/);
      assert.match(ctx.task.objective, /secret\.txt/);
      return { type: 'message', text: 'Found secret.txt (read-only audit complete).', finish: 'done' };
    }
  ], { model: 'venice-uncensored-1-2', baseUrl: 'https://api.venice.ai/api/v1' });

  const runtime = new Runtime({ dataDir, providers: new Map([['parent', parentModel], ['venice-uncensored', uncensoredModel]]) });
  t.after(() => runtime.close());
  const task = await runtime.createTask({ objective: 'Audit workspace', workspace, workspaceKind: 'conversation', providers: ['parent', 'venice-uncensored'], acceptance: { mode: 'owner' } });
  const finished = await runtime.run(task.id);
  assert.ok(['completed', 'waiting_input'].includes(finished.status), `Unexpected status: ${finished.status} (${finished.blocker?.message})`);
  const events = runtime.getEvents(task.id);
  const completedSub = events.find(e => e.type === 'subagent.completed');
  assert.ok(completedSub, 'Expected subagent.completed event');
  assert.equal(completedSub.data.ok, true);
  assert.equal(completedSub.data.role, 'uncensored');
  assert.equal(completedSub.data.providerId, 'venice-uncensored');
  assert.match(completedSub.data.summary, /Found secret\.txt/);

  // Direct helper test on custom 'auditor' persona
  const direct = await runSpecialistSubagent({ runtime, parentTask: task, role: 'auditor', prompt: 'List files' });
  assert.equal(direct.ok, true);
  assert.equal(direct.role, 'auditor');
});

test('web.fetch blocks SSRF private IPs, enforces Local-Only airgap, logs egress audit, and strips HTML cleanly', async () => {
  assert.equal(isPrivateIp('127.0.0.1'), true);
  assert.equal(isPrivateIp('169.254.169.254'), true);
  assert.equal(isPrivateIp('10.0.0.5'), true);
  assert.equal(isPrivateIp('192.168.1.10'), true);
  assert.equal(isPrivateIp('::1'), true);
  assert.equal(isPrivateIp('93.184.216.34'), false);

  await assert.rejects(() => validateSafePublicUrl('http://127.0.0.1:4317/api'), { code: 'SSRF_BLOCKED' });
  await assert.rejects(() => validateSafePublicUrl('http://169.254.169.254/latest/meta-data/'), { code: 'SSRF_BLOCKED' });
  await assert.rejects(() => validateSafePublicUrl('http://localhost/secret'), { code: 'SSRF_BLOCKED' });
  await assert.rejects(() => validateSafePublicUrl('file:///etc/passwd'), { code: 'INVALID_URL' });
  await assert.rejects(
    () => validateSafePublicUrl('https://rebind.example.test', async () => [{ address: '10.1.2.3', family: 4 }]),
    { code: 'SSRF_BLOCKED' }
  );

  const audit = [];
  await assert.rejects(
    () => safeWebFetch({ url: 'https://docs.example.test' }, { privacy: { localOnly: true }, onOutbound: e => audit.push(e) }),
    { code: 'PRIVACY_LOCAL_ONLY' }
  );
  assert.equal(audit[0].blocked, true);

  const parsed = htmlToReadableText('<html><head><title>API Docs</title><style>body{color:red}</style></head><body><h1>Hello &amp; Welcome</h1><script>alert(1)</script><p>Clean text.</p></body></html>');
  assert.equal(parsed.title, 'API Docs');
  assert.match(parsed.text, /Hello & Welcome/);
  assert.doesNotMatch(parsed.text, /alert\(1\)|color:red/);

  const res = await safeWebFetch(
    { url: 'https://docs.example.test/guide', maxChars: 500 },
    {
      privacy: { localOnly: false },
      onOutbound: e => audit.push(e),
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async () => new Response('<html><title>Guide</title><body><p>Spec body</p></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' }
      })
    }
  );
  assert.equal(res.ok, true);
  assert.equal(res.title, 'Guide');
  assert.equal(res.content, 'Spec body');
  assert.equal(audit.at(-1).host, 'docs.example.test');
  assert.equal(audit.at(-1).blocked, false);
});
