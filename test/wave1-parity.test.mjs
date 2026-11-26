import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { PERMISSION_PRESETS, derivePatternRule, assessToolRisk, evaluatePermission } from '../src/permissions.mjs';
import { discoverHooks, matchHooks, runLifecycleHooks } from '../src/hooks.mjs';
import { isSandboxSupportedPlatform, runCommand } from '../src/runner.mjs';
import { HttpProvider } from '../src/providers.mjs';
import { Runtime } from '../src/runtime.mjs';

const macOnly = { skip: !isSandboxSupportedPlatform() && 'Requires macOS Seatbelt or Linux bwrap' };
const readPub = rel => readFile(new URL('../public/' + rel, import.meta.url), 'utf8');

test('55+ languages highlight cleanly with line numbers, wrap/collapse controls, and nested lists', async () => {
  const ctx = vm.createContext({ window: {}, console });
  vm.runInContext(await readPub('vendor/highlight.min.js'), ctx);
  vm.runInContext(await readPub('vendor/hljs-dockerfile.min.js'), ctx);
  vm.runInContext(await readPub('vendor/hljs-extra.js'), ctx);
  vm.runInContext(await readPub('message-format.js'), ctx);

  const langs = ctx.hljs.listLanguages();
  assert.ok(langs.length >= 50, `Expected >= 50 registered hljs languages, got ${langs.length}`);
  for (const needed of ['rust', 'swift', 'cpp', 'toml', 'zig', 'powershell', 'solidity', 'x86asm', 'hcl', 'nix', 'protobuf', 'latex']) {
    assert.ok(ctx.hljs.getLanguage(needed), `Missing language grammar: ${needed}`);
  }
  assert.equal(ctx.normalizeCodeLanguage('rs'), 'rust');
  assert.equal(ctx.normalizeCodeLanguage('tf'), 'hcl');
  assert.equal(ctx.normalizeCodeLanguage('sol'), 'solidity');
  assert.equal(ctx.normalizeCodeLanguage('nasm'), 'x86asm');

  const zigHtml = ctx.highlightCode('pub fn main() void { const x: u32 = 42; }', 'zig');
  assert.match(zigHtml, /hljs-keyword/);

  const longLines = Array.from({ length: 32 }, (_, i) => `const line${i} = ${i};`).join('\n');
  const rendered = ctx.formatMessageBody('```js\n' + longLines + '\n```', true);
  assert.match(rendered, /data-collapse-code/);
  assert.match(rendered, /data-wrap-code/);
  assert.match(rendered, /has-line-numbers/);
  assert.match(rendered, /32 lines/);

  const nestedMd = ctx.messageMarkdown('- Parent\n  - Child item\n> Quote line 1\n> Quote line 2');
  assert.match(nestedMd, /md-nested-item/);
  assert.match(nestedMd, /Quote line 1<br>Quote line 2/);

  const richMd = ctx.messageMarkdown('> [!WARNING]\n> Watch out for $\\alpha + \\beta \\leq \\infty$ and $100 prices!\n\n$$E = mc^2$$\n');
  assert.match(richMd, /md-callout callout-warning/);
  assert.match(richMd, /md-math-inline/);
  assert.match(richMd, /α \+ β ≤ ∞/);
  assert.match(richMd, /\$100 prices!/);
  assert.match(richMd, /md-math-block.*mc<sup>2<\/sup>/);
});

test('Permission presets (5 modes), safe wildcard derivation, and risk assessment', () => {
  assert.deepEqual(Object.keys(PERMISSION_PRESETS).sort(), ['acceptEdits', 'auto', 'default', 'dontAsk', 'permissive', 'safe']);
  assert.equal(evaluatePermission(PERMISSION_PRESETS.acceptEdits, 'repo.write', { path: 'src/a.js' }).action, 'allow');
  assert.equal(evaluatePermission(PERMISSION_PRESETS.acceptEdits, 'process.run', { command: 'npm test' }).action, 'ask');
  assert.equal(evaluatePermission(PERMISSION_PRESETS.default, 'repo.write', { path: 'src/a.js' }).action, 'ask');
  assert.equal(evaluatePermission(PERMISSION_PRESETS.dontAsk, 'process.run', { command: 'echo hi' }).action, 'deny');

  // Safe wildcard command-family rules vs dangerous pipelines/binaries
  assert.deepEqual(derivePatternRule('process.run', { command: 'npm test test/foo.test.mjs' }), {
    tool: 'process.run', pattern: 'npm test*', label: 'npm test *'
  });
  assert.equal(derivePatternRule('process.run', { command: 'npm test && rm -rf /' }), null);
  assert.equal(derivePatternRule('process.run', { command: 'rm -rf build' }), null);
  assert.equal(derivePatternRule('process.run', { command: 'curl https://evil.test' }), null);
  assert.deepEqual(derivePatternRule('repo.write', { path: 'src/ui/button.js' }), {
    tool: 'repo.write', pattern: 'src/ui/*', label: 'src/ui/*'
  });

  assert.equal(assessToolRisk('process.run', { command: 'git push --force' }).level, 'high');
  assert.equal(assessToolRisk('repo.delete', { path: 'a.txt' }).level, 'high');
  assert.equal(assessToolRisk('repo.write', { path: 'a.txt' }).level, 'low');
});

test('Seatbelt ring-buffer keeps head+tail without SIGKILLing noisy commands and streams chunks live', macOnly, async t => {
  const workspace = await realpath(await mkdtemp(path.join(tmpdir(), 'g0d-wave1-runner-')));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const chunks = [];
  const res = await runCommand(
    { workspace, execution: { enabled: true, timeoutMs: 10000 } },
    { command: 'node -e "process.stdout.write(\'HEAD_MARKER\\n\' + \'x\'.repeat(90000) + \'\\nTAIL_MARKER\\n\')"' },
    { onOutput: (stream, text) => chunks.push({ stream, text }) }
  );
  assert.equal(res.exitCode, 0, res.stderr);
  assert.equal(res.truncated, true);
  assert.match(res.stdout, /^HEAD_MARKER/);
  assert.match(res.stdout, /bytes omitted/);
  assert.match(res.stdout, /TAIL_MARKER\s*$/);
  assert.ok(chunks.length > 0, 'Expected live onOutput chunks');
});

test('Deterministic PreToolUse hook blocks tool calls on exit code 2 inside Seatbelt', macOnly, async t => {
  const workspace = await realpath(await mkdtemp(path.join(tmpdir(), 'g0d-wave1-hooks-')));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(path.join(workspace, '.g0dc0d3'), { recursive: true });
  await writeFile(path.join(workspace, '.g0dc0d3', 'hooks.json'), JSON.stringify({
    PreToolUse: [
      { matcher: 'process.run', hooks: [{ type: 'command', command: 'echo "Blocked by security hook: $G0D_HOOK_TARGET" >&2; exit 2' }] }
    ],
    PostToolUse: [
      { tool: 'repo.write', command: 'echo "Post hook ok for $G0D_HOOK_TARGET"' }
    ]
  }));
  const hookTask = { workspace, execution: { enabled: true }, allowProjectHooks: true };
  const discovered = await discoverHooks(hookTask);
  assert.equal(discovered.PreToolUse.length, 1);
  assert.equal(matchHooks(discovered.PreToolUse, 'process.run', { command: 'deploy.sh' }).length, 1);

  const pre = await runLifecycleHooks('PreToolUse', hookTask, 'process.run', { command: 'deploy.sh' });
  assert.equal(pre.blocked, true);
  assert.match(pre.reason, /Blocked by security hook: deploy\.sh/);

  const post = await runLifecycleHooks('PostToolUse', hookTask, 'repo.write', { path: 'src/app.js' });
  assert.equal(post.blocked, false);
  assert.equal(post.results.length, 1);
  assert.match(post.results[0].stdout, /Post hook ok for src\/app\.js/);
});

test('Multimodal image attachments format natively across Anthropic, OpenAI Responses, and OpenAI Chat', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'g0d-wave1-vision-'));
  const workspace = path.join(dataDir, 'ws');
  await mkdir(workspace, { recursive: true });
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const samplePng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({
      content: [{ type: 'text', text: 'Saw image.' }],
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Saw image.' }] }],
      choices: [{ message: { content: 'Saw image.' }, finish_reason: 'stop' }]
    });
  });

  const taskBase = {
    id: 't1', objective: 'Describe this screenshot', workspace, workspaceKind: 'conversation',
    calls: 1, policy: { maxCalls: 5, maxAttempts: 2 },
    attachments: [{ name: 'shot.png', mediaType: 'image/png', dataUrl: samplePng }]
  };
  const ctx = { task: taskBase, history: [], files: [], manifest: { bytes: 0, omittedEventCount: 0, omittedFiles: [] }, tools: [] };

  const anthropic = new HttpProvider({ id: 'a', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-opus-4-6', credential: 'k' });
  await anthropic.turn(ctx);
  assert.equal(bodies[0].messages.at(-1).content[0].type, 'image');
  assert.equal(bodies[0].messages.at(-1).content[0].source.media_type, 'image/png');

  const responses = new HttpProvider({ id: 'o', protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4', credential: 'k' });
  await responses.turn(ctx);
  assert.equal(bodies[1].input.at(-1).content[0].type, 'input_image');
  assert.equal(bodies[1].input.at(-1).content[0].image_url, samplePng);

  const chat = new HttpProvider({ id: 'c', protocol: 'openai-chat', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/v3', credential: 'k' });
  await chat.turn(ctx);
  assert.equal(bodies[2].messages.at(-1).content[0].type, 'image_url');
  assert.equal(bodies[2].messages.at(-1).content[0].image_url.url, samplePng);

  // Runtime rejects invalid attachment MIME types cleanly
  const runtime = new Runtime({ dataDir, providers: new Map([['c', chat]]) });
  t.after(() => runtime.close());
  await assert.rejects(
    () => runtime.createTask({ objective: 'Hi', workspace, providers: ['c'], attachments: [{ name: 'bad', mediaType: 'image/svg+xml', dataUrl: 'data:image/svg+xml;base64,AA==' }] }),
    { code: 'INVALID_ATTACHMENT' }
  );
});
