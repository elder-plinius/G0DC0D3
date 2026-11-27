import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AcpClient,
  AcpSessionPool,
  createAcpPermissionHandler,
  createAcpSandboxHandlers,
  discoverAcpHarnesses,
} from '../src/acp-client.mjs';
import { AcpHarnessProvider, AntigravityCliProvider } from '../src/providers.mjs';
import { createApp } from '../src/server.mjs';

async function createMockAcpServer(dir) {
  const scriptPath = path.join(dir, 'mock-acp-server.mjs');
  const spawnLog = path.join(dir, 'spawns.log');
  await fs.writeFile(scriptPath, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const spawnLog = ${JSON.stringify(spawnLog)};
appendFileSync(spawnLog, process.pid + '\\n');

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let currentModel = 'default-model';
let cancelled = false;
let rpcSeq = 100;
const pendingClientRpcs = new Map();

const send = obj => process.stdout.write(JSON.stringify(obj) + '\\n');
const callClient = (method, params) => new Promise((resolve, reject) => {
  const id = rpcSeq++;
  pendingClientRpcs.set(id, { resolve, reject });
  send({ jsonrpc: '2.0', id, method, params });
});

rl.on('line', async line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.id !== undefined && !msg.method && pendingClientRpcs.has(msg.id)) {
    const { resolve, reject } = pendingClientRpcs.get(msg.id);
    pendingClientRpcs.delete(msg.id);
    if (msg.error) reject(msg.error);
    else resolve(msg.result);
    return;
  }

  if (msg.method === 'session/cancel') {
    cancelled = true;
    return;
  }
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'Mock ACP Server', version: '1.0.0' },
        agentCapabilities: { promptCapabilities: { image: true } },
      },
    });
    return;
  }
  if (msg.method === 'session/new') {
    send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        sessionId: 'acp-sess-1',
        models: { currentModelId: currentModel, availableModels: [{ modelId: 'gemini-4-neon-medium', name: 'Neon' }] },
        modes: { currentModeId: 'default', availableModes: [{ id: 'default' }, { id: 'auto' }, { id: 'plan' }] },
        configOptions: [{ id: 'thought_level', options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] }],
      },
    });
    return;
  }
  if (msg.method === 'session/set_model') {
    currentModel = msg.params?.modelId || currentModel;
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'session/set_mode' || msg.method === 'session/set_config_option' || msg.method === 'session/close') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'session/prompt') {
    const sid = msg.params?.sessionId;
    const text = (msg.params?.prompt || []).map(b => b.text || '').join('\\n');

    if (text.includes('TRIGGER_CANCEL')) {
      cancelled = false;
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Starting slow turn...' } } } });
      await new Promise(r => setTimeout(r, 300));
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: cancelled ? 'cancelled' : 'end_turn', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } } });
      return;
    }

    if (text.includes('TEST_CLIENT_FS')) {
      const readRes = await callClient('fs/read_text_file', { path: 'hello.txt' });
      await callClient('fs/write_text_file', { path: 'out.txt', content: 'echo:' + readRes.content.trim() });
      let traversalBlocked = false;
      try { await callClient('fs/read_text_file', { path: '../outside.txt' }); } catch { traversalBlocked = true; }
      const perm = await callClient('session/request_permission', {
        toolCall: { kind: 'edit', name: 'write_file', rawInput: { path: 'out.txt' } },
        options: [{ optionId: 'allow_once', kind: 'allow_once' }, { optionId: 'reject_once', kind: 'reject_once' }],
      });
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify({ read: readRes.content.trim(), traversalBlocked, perm: perm.outcome }) } } } });
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { inputTokens: 50, outputTokens: 30, cachedReadTokens: 20, totalTokens: 80 } } });
      return;
    }

    if (text.includes('TEST_CLIENT_TERMINAL')) {
      const created = await callClient('terminal/create', { command: 'printf', args: ['ACP_SANDBOX_OK'] });
      const exitStatus = await callClient('terminal/wait_for_exit', { terminalId: created.terminalId });
      const out = await callClient('terminal/output', { terminalId: created.terminalId });
      await callClient('terminal/release', { terminalId: created.terminalId });
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify({ exitCode: exitStatus.exitCode, output: out.output.trim() }) } } } });
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } } });
      return;
    }

    if (text.includes('PLANNER_ENVELOPE') || text.includes('Delta since your last turn')) {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Planning next broker tool step...' } } } });
      const isDelta = text.includes('Delta since your last turn');
      const reply = JSON.stringify({
        type: 'message',
        calls: [],
        text: isDelta ? 'DELTA_REUSED_ACP_OK' : 'FRESH_ACP_OK',
        finish: 'done',
      });
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } } } });
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { inputTokens: isDelta ? 40 : 120, outputTokens: 25, cachedReadTokens: isDelta ? 110 : 0, totalTokens: isDelta ? 65 : 145 } } });
      return;
    }

    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking via ' + currentModel } } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', name: 'read_file', kind: 'read', status: 'in_progress' } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', name: 'read_file', kind: 'read', status: 'completed' } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ACP World!' } } } });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 15, cachedReadTokens: 60, thoughtTokens: 10, totalTokens: 115 } } });
  }
});
`);
  await fs.chmod(scriptPath, 0o755);
  return { scriptPath, spawnLog };
}

test('AcpClient handles JSON-RPC 2.0 streaming, fs/* workspace scoping, permission enforcement, and session/cancel', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'g0d-acp-unit-'));
  const ws = path.join(dir, 'ws');
  await fs.mkdir(ws, { recursive: true });
  await fs.writeFile(path.join(ws, 'hello.txt'), 'secret-free-hello\n');
  await fs.writeFile(path.join(dir, 'outside.txt'), 'DO_NOT_READ');
  const { scriptPath } = await createMockAcpServer(dir);

  const sandboxHandlers = createAcpSandboxHandlers({
    workspace: ws,
    execution: { enabled: false, network: false, timeoutMs: 10000 },
    planMode: false,
    permissionRules: [{ tool: '*', action: 'allow', reason: 'test' }],
  });
  const permissionHandler = createAcpPermissionHandler({
    mode: 'delegated',
    workspace: ws,
    planMode: false,
    permissionRules: [{ tool: '*', action: 'allow', reason: 'test' }],
  });

  const client = new AcpClient({
    binary: process.execPath,
    args: [scriptPath],
    cwd: ws,
    capabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    permissionHandler,
    sandboxHandlers,
  });

  try {
    const sess = await client.createSession({ cwd: ws, model: 'gemini-4-neon-medium', mode: 'auto', effort: 'medium' });
    assert.equal(sess.sessionId, 'acp-sess-1');

    // 1. Live streaming of thoughts, tool_call updates, and message chunks
    const deltas = [];
    const tools = [];
    const r1 = await client.prompt({
      sessionId: sess.sessionId,
      text: 'Say hello',
      onDelta: d => deltas.push(d),
      onToolCall: tc => tools.push(tc),
    });
    assert.equal(r1.text, 'Hello ACP World!');
    assert.match(r1.reasoning, /gemini-4-neon-medium/);
    assert.equal(deltas.filter(d => d.type === 'text').length, 2);
    assert.equal(deltas.filter(d => d.type === 'reasoning').length, 1);
    assert.equal(tools.length, 2);
    assert.equal(r1.usage.cache_read_tokens, 60);

    // 2. Client-side fs/read_text_file, fs/write_text_file, traversal rejection, and permission allow
    const r2 = await client.prompt({ sessionId: sess.sessionId, text: 'TEST_CLIENT_FS' });
    const parsed = JSON.parse(r2.text);
    assert.equal(parsed.read, 'secret-free-hello');
    assert.equal(parsed.traversalBlocked, true);
    assert.equal(parsed.perm.optionId, 'allow_once');
    assert.equal(await fs.readFile(path.join(ws, 'out.txt'), 'utf8'), 'echo:secret-free-hello');

    // 3. Plan Mode strictly blocks writes & permissions
    const planPerm = createAcpPermissionHandler({ mode: 'delegated', workspace: ws, planMode: true, permissionRules: [{ tool: '*', action: 'allow' }] });
    const planVerdict = await planPerm({
      toolCall: { kind: 'edit', name: 'write_file', rawInput: { path: 'out.txt' } },
      options: [{ optionId: 'allow_once', kind: 'allow_once' }, { optionId: 'reject_once', kind: 'reject_once' }],
    });
    assert.equal(planVerdict.outcome.optionId, 'reject_once');

    // 4. AbortSignal cancels via session/cancel
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 60);
    await assert.rejects(
      () => client.prompt({ sessionId: sess.sessionId, text: 'TRIGGER_CANCEL', signal: ac.signal }),
      err => err?.code === 'cancelled'
    );
  } finally {
    await client.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('AntigravityCliProvider reuses persistent ACP session across turns (1 spawn), streams reasoning, and falls back when binary is non-ACP', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'g0d-acp-agy-'));
  try {
    const { scriptPath, spawnLog } = await createMockAcpServer(dir);
    // Wrapper binary named fake-agy-acp that runs mock-acp-server.mjs
    const fakeBin = path.join(dir, 'fake-agy-acp');
    await fs.writeFile(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}"\n`);
    await fs.chmod(fakeBin, 0o755);

    const provider = new AntigravityCliProvider({
      id: 'antigravity-cli:gemini-4-neon-medium',
      model: 'gemini-4-neon-medium',
      binary: fakeBin,
      useAcp: true,
    });
    try {
      const seenReasoning = [];
      const t1 = await provider.turn({
        task: { id: 'task-acp-1', objective: 'PLANNER_ENVELOPE step 1', calls: 1, contractVersion: 1, recoveries: 0 },
        history: [{ seq: 1, type: 'user.message', data: { text: 'step 1' } }],
        tools: [], files: [],
      }, { privacy: { localOnly: false }, onDelta: d => seenReasoning.push(d) });
      assert.equal(t1.text, 'FRESH_ACP_OK');
      assert.equal(t1.transport, 'acp-v1');
      assert.equal(seenReasoning.some(d => d.type === 'thinking'), true);
      assert.match(t1.thinking || '', /Planning next broker tool step/);

      // Turn 2: MUST reuse the exact same persistent ACP process (still only 1 PID in spawnLog!)
      const t2 = await provider.turn({
        task: { id: 'task-acp-1', objective: 'PLANNER_ENVELOPE step 1', calls: 2, contractVersion: 1, recoveries: 0 },
        history: [
          { seq: 1, type: 'user.message', data: { text: 'step 1' } },
          { seq: 2, type: 'tool.completed', data: { name: 'repo.write' } },
        ],
        tools: [], files: [],
      }, { privacy: { localOnly: false } });
      assert.equal(t2.text, 'DELTA_REUSED_ACP_OK');
      assert.equal(t2.usage.cache_read_tokens, 110);
      assert.equal(provider.acpStatus().length, 1);

      const spawns = (await fs.readFile(spawnLog, 'utf8')).trim().split('\n').filter(Boolean);
      assert.equal(spawns.length, 1, 'Expected persistent ACP server to spawn exactly once across multi-turn task');
    } finally {
      await provider.close();
    }

    // Fallback test: non-ACP subprocess binary falls back seamlessly when useAcp: true
    const legacyBin = path.join(dir, 'legacy-agy');
    await fs.writeFile(legacyBin, `#!/bin/sh
if [ "$1" = "acp" ]; then
  echo "unknown subcommand acp" >&2
  exit 2
fi
cat > /dev/null
printf '%s\\n' '{"status":"SUCCESS","response":"{\\"type\\":\\"message\\",\\"calls\\":[],\\"text\\":\\"FALLBACK_SUBPROCESS_OK\\",\\"finish\\":\\"done\\"}","usage":{"input_tokens":50,"output_tokens":10}}'
`);
    await fs.chmod(legacyBin, 0o755);
    const fbProvider = new AntigravityCliProvider({ binary: legacyBin, model: 'gemini-4-neon-medium', useAcp: true });
    try {
      const res = await fbProvider.turn({
        task: { id: 'task-fb', objective: 'hello', calls: 1 },
        history: [], tools: [], files: [],
      }, { privacy: { localOnly: false } });
      assert.equal(res.text, 'FALLBACK_SUBPROCESS_OK');
      assert.equal(fbProvider._acpUnsupported, true);
    } finally {
      await fbProvider.close();
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('AcpHarnessProvider enforces Local-Only privacy and GET /api/acp/status reports discovered harnesses & active sessions', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'g0d-acp-api-'));
  const ws = path.join(dir, 'ws');
  await fs.mkdir(ws, { recursive: true });
  const { scriptPath } = await createMockAcpServer(dir);

  const acpProv = new AcpHarnessProvider({
    id: 'acp:mock',
    harnessId: 'mock',
    label: 'Mock ACP Harness',
    binary: process.execPath,
    args: [scriptPath],
    model: 'gemini-4-neon-medium',
    delegated: true,
  });

  const app = await createApp({
    dataDir: path.join(dir, 'data'),
    providers: new Map([[acpProv.id, acpProv]]),
    auth: false,
    cliDiscovery: { probes: [] },
    startScheduler: false,
  });
  try {
    // Local-Only privacy blocks cloud ACP egress with zero spawns
    const blocked = await acpProv.draft([{ role: 'user', content: 'hi' }], undefined, 256, {}, { privacy: { localOnly: true } });
    assert.equal(blocked.type, 'error');
    assert.equal(blocked.code, 'PRIVACY_LOCAL_ONLY');

    // Run one delegated ACP turn to populate active session
    const turnRes = await acpProv.turn({
      task: { id: 't-acp-live', objective: 'Say hello', workspace: ws, permissionRules: [{ tool: '*', action: 'allow' }] },
      history: [], tools: [], files: [],
    }, { privacy: { localOnly: false } });
    assert.equal(turnRes.text, 'Hello ACP World!');
    assert.equal(turnRes.transport, 'acp-v1');

    // Verify GET /api/acp/status over HTTP as well as runtime.getAcpStatus()
    const harnesses = await discoverAcpHarnesses();
    assert.equal(harnesses.length, 5);
    const active = app.runtime.getAcpStatus();
    assert.equal(active.length, 1);
    assert.equal(active[0].providerId, 'acp:mock');
    assert.equal(active[0].sessionId, 'acp-sess-1');

    const baseUrl = await app.listen(0);
    const resp = await fetch(`${baseUrl}/api/acp/status`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.ok, true);
    assert.equal(body.protocol, 'acp-v1');
    assert.equal(body.harnesses.length, 5);
    assert.equal(body.harnesses.every(h => !('resolvedPath' in h)), true, 'API must not leak host resolvedPath');
    assert.equal(body.activeSessions.length, 1);
    assert.equal(body.activeSessions[0].providerId, 'acp:mock');
    assert.equal('sessionId' in body.activeSessions[0], false, 'API must not leak raw sessionId');
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('ACP security & concurrency regressions: kind spoofing, HARD_DENY_SHELL_RULES args, allow_always ban, secret redaction, ZDR classification, and missing-path fail-closed', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'g0d-acp-sec-'));
  const ws = path.join(dir, 'ws');
  await fs.mkdir(ws, { recursive: true });
  await fs.writeFile(path.join(ws, 'env.txt'), 'API_KEY=sk-ant-api03-SUPERSECRETVALUE1234567890\n');
  const { classifyProviderZdr } = await import('../src/privacy.mjs');

  try {
    // 1. P0-1: kind: 'execute' with title containing 'cat' or 'search' MUST NOT spoof repo.read/repo.search in Plan Mode
    const planPerm = createAcpPermissionHandler({ mode: 'delegated', workspace: ws, planMode: true, permissionRules: [{ tool: '*', action: 'allow' }] });
    const spoofExec = await planPerm({
      toolCall: { kind: 'execute', title: 'cat /etc/passwd && rm -rf /', rawInput: { command: 'cat /etc/passwd' } },
      options: [{ optionId: 'allow_once', kind: 'allow_once' }, { optionId: 'reject_once', kind: 'reject_once' }],
    });
    assert.equal(spoofExec.outcome.optionId, 'reject_once');

    // 2. P1-2: selectPermissionOption MUST NEVER pick allow_always
    const delPerm = createAcpPermissionHandler({ mode: 'delegated', workspace: ws, planMode: false, permissionRules: [{ tool: '*', action: 'allow' }] });
    const noAllowOnce = await delPerm({
      toolCall: { kind: 'read', rawInput: { path: 'env.txt' } },
      options: [{ optionId: 'allow_always', kind: 'allow_always' }],
    });
    assert.equal(noAllowOnce.outcome.outcome, 'cancelled');

    // 3. P0-4: Fail closed when file tool omits path, or repo.move destination escapes workspace/.git
    const missingPath = await delPerm({
      toolCall: { kind: 'edit', rawInput: {} },
      options: [{ optionId: 'allow_once', kind: 'allow_once' }, { optionId: 'reject_once', kind: 'reject_once' }],
    });
    assert.equal(missingPath.outcome.optionId, 'reject_once');
    const gitMove = await delPerm({
      toolCall: { kind: 'move', rawInput: { from: 'env.txt', to: '.git/hooks/pre-commit' } },
      options: [{ optionId: 'allow_once', kind: 'allow_once' }, { optionId: 'reject_once', kind: 'reject_once' }],
    });
    assert.equal(gitMove.outcome.optionId, 'reject_once');

    // 4. P0-2 & P0-6 & P1-1: Default rules are STRICT (not []), HARD_DENY_SHELL_RULES blocks structured args, and readTextFile redacts secrets
    const strictHandlers = createAcpSandboxHandlers({ workspace: ws, execution: { enabled: true }, planMode: false });
    await assert.rejects(() => strictHandlers.writeTextFile({ path: 'x.txt', content: 'hi' }), /Permission denied/i);

    const allowAllHandlers = createAcpSandboxHandlers({
      workspace: ws,
      execution: { enabled: true },
      planMode: false,
      permissionRules: [{ tool: '*', action: 'allow' }],
      extraSecrets: ['sk-ant-api03-SUPERSECRETVALUE1234567890'],
    });
    await assert.rejects(() => allowAllHandlers.terminalCreate({ command: 'rm', args: ['-rf', '/'] }), /Permission denied/i);
    await assert.rejects(() => allowAllHandlers.terminalCreate({ command: 'git', args: ['push', '--force', 'origin', 'main'] }), /Permission denied/i);
    const readOut = await allowAllHandlers.readTextFile({ path: 'env.txt' });
    assert.equal(readOut.content.includes('SUPERSECRETVALUE1234567890'), false, 'readTextFile MUST redact outbound secrets');

    // 5. P1-5: kind: 'acp' with tier: 'local' MUST NOT be misclassified as local-only
    const localTierAcp = new AcpHarnessProvider({ id: 'acp:test-local-tier', tier: 'local' });
    const zdr = classifyProviderZdr(localTierAcp);
    assert.equal(zdr.zdrClass, 'provider-policy');
    assert.equal(zdr.localOnly, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('AcpClient routes terminal/* RPCs through G0DC0D3 OS sandbox (Seatbelt/bwrap)', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'g0d-acp-term-'));
  const ws = path.join(dir, 'ws');
  await fs.mkdir(ws, { recursive: true });
  const { scriptPath } = await createMockAcpServer(dir);

  const sandboxHandlers = createAcpSandboxHandlers({
    workspace: ws,
    execution: { enabled: true, network: false, timeoutMs: 10000 },
    planMode: false,
    permissionRules: [{ tool: '*', action: 'allow', reason: 'test' }],
  });
  const client = new AcpClient({
    binary: process.execPath,
    args: [scriptPath],
    cwd: ws,
    capabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    permissionHandler: createAcpPermissionHandler({ mode: 'delegated', workspace: ws, permissionRules: [{ tool: '*', action: 'allow' }] }),
    sandboxHandlers,
  });
  try {
    const sess = await client.createSession({ cwd: ws });
    const res = await client.prompt({ sessionId: sess.sessionId, text: 'TEST_CLIENT_TERMINAL' });
    const parsed = JSON.parse(res.text);
    assert.equal(parsed.exitCode, 0);
    assert.equal(parsed.output, 'ACP_SANDBOX_OK');
  } finally {
    await client.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
