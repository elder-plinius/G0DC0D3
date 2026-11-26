import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyProviderZdr, isPrivateLanHost, isPrivateLanUrl } from '../src/privacy.mjs';
import { HttpProvider, canonicalTools, extractTextToolCalls, toolAliases } from '../src/providers.mjs';
import { bwrapCommandArgs, bwrapWorkerArgs, executionBoundaryForPlatform, isSandboxSupportedPlatform } from '../src/runner.mjs';

test('Linux bwrapCommandArgs enforces PID/IPC/UTS/network namespaces, clearenv, usr-merged symlinks, and .git/.g0dc0d3 masking', () => {
  assert.equal(isSandboxSupportedPlatform('linux'), true);
  assert.equal(isSandboxSupportedPlatform('darwin'), true);
  assert.equal(isSandboxSupportedPlatform('win32'), false);
  assert.equal(executionBoundaryForPlatform('linux'), 'linux-bwrap');
  assert.equal(executionBoundaryForPlatform('linux', { readOnly: true }), 'linux-bwrap-read-only');
  assert.equal(executionBoundaryForPlatform('darwin'), 'macos-seatbelt');

  const closedArgs = bwrapCommandArgs({
    workspace: '/tmp/ws',
    cwd: '/tmp/ws',
    scratch: '/tmp/scratch',
    deniedDir: '/tmp/scratch/.denied-dir',
    deniedFile: '/tmp/scratch/.denied-file',
    nodeFile: '/usr/bin/node',
    npmRoot: '/usr/lib/node_modules/npm',
    runtimeFiles: ['/usr/bin/npm'],
    toolchainRoots: ['/usr/local/bin'],
    systemEntries: [
      { kind: 'ro-bind', path: '/usr' },
      { kind: 'symlink', path: '/bin', target: 'usr/bin' },
      { kind: 'symlink', path: '/lib64', target: 'usr/lib64' },
    ],
    maskedDirs: ['/tmp/ws/.git'],
    maskedFiles: ['/tmp/ws/.g0dc0d3'],
    env: { PATH: '/usr/bin:/bin', G0DC0D3_EXECUTION: 'sandboxed' },
    network: false,
    command: 'echo ok',
  });

  assert.ok(closedArgs.includes('--unshare-pid'));
  assert.ok(closedArgs.includes('--unshare-net'));
  assert.ok(closedArgs.includes('--die-with-parent'));
  assert.ok(closedArgs.includes('--clearenv'));
  const roRootIdx = closedArgs.indexOf('--remount-ro');
  assert.ok(roRootIdx > 0 && closedArgs[roRootIdx + 1] === '/');
  assert.equal(closedArgs.includes('/tmp'), false, 'Command sandbox must not mount a writable /tmp tmpfs over ancestor dirs');
  // Symlinks preserved cleanly for Ubuntu usr-merged rootfs
  const symIdx = closedArgs.indexOf('--symlink');
  assert.equal(closedArgs[symIdx + 1], 'usr/bin');
  assert.equal(closedArgs[symIdx + 2], '/bin');
  // Workspace and scratch rw-bound, .git/.g0dc0d3 masked with chmod 0000 sentinels
  const gitMaskIdx = closedArgs.indexOf('/tmp/scratch/.denied-dir');
  assert.ok(gitMaskIdx > 0);
  assert.equal(closedArgs[gitMaskIdx - 1], '--ro-bind');
  assert.equal(closedArgs[gitMaskIdx + 1], '/tmp/ws/.git');
  assert.ok(closedArgs.includes('/tmp/ws/.g0dc0d3'));
  // Network grant omits --unshare-net
  const openArgs = bwrapCommandArgs({
    workspace: '/tmp/ws',
    cwd: '/tmp/ws',
    scratch: '/tmp/scratch',
    nodeFile: '/usr/bin/node',
    network: true,
    command: 'echo net',
  });
  assert.equal(openArgs.includes('--unshare-net'), false);
});

test('Linux bwrapWorkerArgs is strictly read-only, offline, and binds only exact worker files without /usr/bin', () => {
  const args = bwrapWorkerArgs({
    nodeFile: '/usr/bin/node',
    files: ['/opt/app/src/probe-worker.mjs', '/opt/app/src/probes-auth.mjs'],
    systemEntries: [
      { kind: 'ro-bind', path: '/usr/lib' },
      { kind: 'symlink', path: '/lib64', target: 'usr/lib64' },
    ],
    entry: '/opt/app/src/probe-worker.mjs',
  });
  assert.ok(args.includes('--unshare-net'));
  assert.ok(args.includes('--unshare-pid'));
  assert.ok(args.includes('--die-with-parent'));
  assert.equal(args.includes('--bind'), false, 'Read-only worker must have zero writable binds');
  assert.equal(args.includes('--tmpfs'), false, 'Read-only worker must have zero writable tmpfs mounts');
  const roWorkerIdx = args.indexOf('--remount-ro');
  assert.ok(roWorkerIdx > 0 && args[roWorkerIdx + 1] === '/', 'Read-only worker must remount / read-only');
  assert.equal(args.includes('/usr/bin'), false, 'Read-only worker must not bind /usr/bin shell utilities');
  assert.ok(args.includes('/opt/app/src/probe-worker.mjs'));
  assert.ok(args.includes('--disable-proto=throw'));
});

test('Private Docker-bridge and LAN HTTP opt-in works for local Ollama while rejecting public non-HTTPS hosts', () => {
  assert.equal(isPrivateLanHost('172.17.0.1'), true);
  assert.equal(isPrivateLanHost('192.168.1.42'), true);
  assert.equal(isPrivateLanHost('10.0.0.5'), true);
  assert.equal(isPrivateLanHost('host.docker.internal'), true);
  assert.equal(isPrivateLanHost('8.8.8.8'), false);
  assert.equal(isPrivateLanUrl('http://172.17.0.1:11434/v1'), true);

  // Without opt-in, plain HTTP to Docker bridge is rejected
  assert.throws(() => new HttpProvider({
    id: 'local:docker-denied',
    protocol: 'openai-chat',
    baseUrl: 'http://172.17.0.1:11434/v1',
    model: 'qwen2.5-coder:7b',
  }), /Local HTTP providers/);

  // With allowPrivateHttp: true (Local Model registration / G0D_OLLAMA_URL), Docker bridge succeeds
  const dockerOllama = new HttpProvider({
    id: 'ollama:qwen2.5-coder-7b',
    protocol: 'openai-chat',
    baseUrl: 'http://172.17.0.1:11434/v1',
    model: 'qwen2.5-coder:7b',
    tier: 'local',
    allowPrivateHttp: true,
  });
  assert.equal(dockerOllama.baseUrl, 'http://172.17.0.1:11434/v1');
  const posture = classifyProviderZdr(dockerOllama);
  assert.equal(posture.localOnly, true);
  assert.equal(posture.label, 'LOCAL LAN');

  // Public plain-HTTP endpoints remain strictly blocked even with allowPrivateHttp: true
  assert.throws(() => new HttpProvider({
    id: 'public-http',
    protocol: 'openai-chat',
    baseUrl: 'http://api.example.com/v1',
    model: 'some-model',
    allowPrivateHttp: true,
  }), /Remote providers require HTTPS/);
});

test('extractTextToolCalls recovers <tool_call> and standalone JSON tool calls from small local models while ignoring prose and unknown tools', () => {
  const tools = canonicalTools.filter(t => ['repo.read', 'repo.patch'].includes(t.name));
  const aliases = toolAliases(tools);

  const qwenReply = `I'll inspect the file first.\n<tool_call>\n{"name": "repo__read", "arguments": {"path": "src/app.mjs"}}\n</tool_call>`;
  const parsed = extractTextToolCalls(qwenReply, aliases, tools);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, 'repo.read');
  assert.deepEqual(parsed[0].args, { path: 'src/app.mjs' });

  const standaloneJson = '```json\n{"name":"repo.patch","arguments":{"path":"src/app.mjs","oldText":"a","newText":"b","expectedHash":"abc"}}\n```';
  const parsed2 = extractTextToolCalls(standaloneJson, aliases, tools);
  assert.equal(parsed2.length, 1);
  assert.equal(parsed2[0].name, 'repo.patch');

  // Normal prose & unadvertised tools must NOT trigger tool execution
  assert.deepEqual(extractTextToolCalls('Here is how you can use repo.read in JSON.', aliases, tools), []);
  assert.deepEqual(extractTextToolCalls('<tool_call>{"name":"process.run","arguments":{"command":"rm -rf /"}}</tool_call>', aliases, tools), []);
});
