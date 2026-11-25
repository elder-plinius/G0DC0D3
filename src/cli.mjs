#!/usr/bin/env node
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { Runtime } from './runtime.mjs';
import { evaluateTask } from './evaluator.mjs';
import { environmentProviders } from './providers.mjs';
import { createScriptedProviders } from '../bench/scripted.mjs';
import { fixtures } from '../fixtures/index.mjs';
import { createConversationTask, createFixtureTask, createImportedTask, fileDiff } from './workspaces.mjs';
import { resolveWorkflow, WORKFLOW_NAMES } from './workflows.mjs';
import { gitDiff, gitInit, hasGit } from './git.mjs';

const rawArgv = process.argv.slice(2), command = rawArgv.shift() || 'help';
const BOOLEAN_FLAGS = new Set(['plan', 'help', 'h']);
const parsedOptions = new Map();
const parsedFlags = new Set();
const positionals = [];
for (let i = 0; i < rawArgv.length; i++) {
  const tok = rawArgv[i];
  if (tok.startsWith('--')) {
    const eq = tok.indexOf('=');
    if (eq > 2) {
      parsedOptions.set(tok.slice(2, eq), tok.slice(eq + 1));
    } else {
      const name = tok.slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
        parsedFlags.add(name);
      } else if (i + 1 < rawArgv.length && !rawArgv[i + 1].startsWith('--')) {
        parsedOptions.set(name, rawArgv[++i]);
      } else {
        parsedFlags.add(name);
      }
    }
  } else {
    positionals.push(tok);
  }
}
const option = name => parsedOptions.get(name);
const hasFlag = name => parsedFlags.has(name) || parsedOptions.has(name);
const dataDir = path.resolve(option('data') || process.env.G0D_DATA_DIR || fileURLToPath(new URL('../.g0dc0d3', import.meta.url)));
const print = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');

function resolveCliWorkflow() {
  const name = option('workflow');
  if (!name) return null;
  const preset = resolveWorkflow(name);
  if (!preset) throw new Error(`Unknown workflow "${name}". Available: ${WORKFLOW_NAMES.join(', ')}`);
  return { name, ...preset };
}

function buildCliPolicy(workflow) {
  const base = workflow?.policy ? { ...workflow.policy } : { maxCalls: 30, maxAttempts: 6, requestTimeoutMs: 120000 };
  if (option('calls') !== undefined) base.maxCalls = Number(option('calls'));
  if (option('recoveries') !== undefined) base.maxAttempts = Number(option('recoveries'));
  if (option('timeout') !== undefined) base.requestTimeoutMs = Number(option('timeout'));
  return base;
}

function chatHelpText() {
  return [
    'G0DC0D3 interactive chat commands:',
    '  /plan           Switch to read-only Plan Mode',
    '  /build          Switch to Build Mode (allow file edits & commands)',
    '  /compact        Compact context into a fresh-eyes working summary',
    '  /diff           Show workspace git/file diff',
    '  /undo [steps]   Rewind workspace git checkpoints (default 1)',
    '  /verify         Run acceptance evaluator on current workspace',
    '  /status         Show task status, provider, tier, calls, and mode',
    '  /help           Show this help message',
    '  /quit           Exit chat cleanly'
  ].join('\n');
}

async function runChat(runtime, providers) {
  const workflow = resolveCliWorkflow();
  const policy = buildCliPolicy(workflow);
  const sourcePath = option('source') ? path.resolve(option('source')) : undefined;
  const fixtureId = option('fixture');
  const explicitProviders = option('providers')?.split(',').map(s => s.trim()).filter(Boolean);
  const liveProviders = [...providers.values()].filter(p => p.kind !== 'scripted' && p.available !== false).map(p => p.id);
  const providerIds = explicitProviders?.length ? explicitProviders : (liveProviders.length ? liveProviders : ['scripted-primary', 'scripted-fallback']);
  let planMode = hasFlag('plan');
  let task = null;

  const out = line => process.stdout.write(line + '\n');
  const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const promptText = () => `${planMode ? '[plan]' : '[build]'} g0dc0d3> `;

  out(`G0DC0D3 interactive chat (${planMode ? 'Plan Mode' : 'Build Mode'}${workflow ? ` · workflow:${workflow.name}` : ''}). Type /help for commands, /quit to exit.`);
  if (!explicitProviders?.length && !liveProviders.length) {
    out('Note: No live provider API keys detected in environment or .env — using offline scripted test doubles. Export ANTHROPIC_API_KEY / OPENAI_API_KEY / VENICE_API_KEY / OPENROUTER_API_KEY / GEMINI_API_KEY / NOUS_API_KEY or set .env for live models.');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: isTTY });
  if (isTTY) { rl.setPrompt(promptText()); rl.prompt(); }

  const printLatestResponse = currentTask => {
    const events = runtime.getRecentEvents(currentTask.id, 30);
    const lastReply = [...events].reverse().find(e => e.type === 'model.response' && !e.data?.superseded && e.data?.response?.text);
    if (lastReply?.data?.response?.text) out('\n' + lastReply.data.response.text.trim() + '\n');
    const summary = `[status=${currentTask.status} provider=${currentTask.providerId} calls=${currentTask.calls}/${currentTask.policy?.maxCalls} mode=${currentTask.planMode ? 'plan' : 'build'}]`;
    out(summary);
    if (currentTask.blocker?.message) out(`Note: ${currentTask.blocker.message}`);
  };

  try {
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) {
        if (isTTY) { rl.setPrompt(promptText()); rl.prompt(); }
        continue;
      }
      if (line.startsWith('/')) {
        const [rawCmd, ...rest] = line.split(/\s+/);
        const cmd = rawCmd.toLowerCase();
        const arg = rest.join(' ').trim();
        try {
          if (cmd === '/quit' || cmd === '/exit') { out('Bye.'); break; }
          else if (cmd === '/help') out(chatHelpText());
          else if (cmd === '/plan') {
            planMode = true;
            if (task) task = runtime.setPlanMode(task.id, true);
            out('Switched to Plan Mode (read-only).');
          } else if (cmd === '/build') {
            planMode = false;
            if (task) task = runtime.setPlanMode(task.id, false);
            out('Switched to Build Mode.');
          } else if (cmd === '/compact') {
            if (!task) out('No active task yet. Send a message first.');
            else {
              task = await runtime.compactTask(task.id);
              const ws = task.workingSummary;
              out(`Compacted context: ${ws.modifiedFiles.length} modified file(s), ${ws.latestFailingChecks.length} failing check(s).`);
            }
          } else if (cmd === '/diff') {
            if (!task) out('No active task yet.');
            else {
              const gDiff = await hasGit(task.workspace) ? await gitDiff(task.workspace) : '';
              if (gDiff.trim()) out(gDiff.trim());
              else {
                const snap = await runtime.snapshotTask(task.id);
                const changes = fileDiff(task.initialSnapshot?.files || [], snap.files);
                out(changes.length ? changes.map(c => `${c.before === null ? 'A' : c.after === null ? 'D' : 'M'} ${c.path}`).join('\n') : 'No workspace changes.');
              }
            }
          } else if (cmd === '/undo') {
            if (!task) out('No active task yet.');
            else {
              const steps = arg ? Number(arg) : 1;
              const { task: updated, rewind } = await runtime.rewindTask(task.id, steps);
              task = updated;
              out(`Rewound ${rewind.steps} checkpoint(s): ${rewind.fromHash} -> ${rewind.toHash} (${rewind.summary})`);
            }
          } else if (cmd === '/verify') {
            if (!task) out('No active task yet.');
            else {
              const result = await evaluateTask(runtime.getTask(task.id));
              out(`Verification: ${result.status} (${result.checks?.length || 0} check(s))`);
              for (const check of result.checks || []) out(`  [${check.status}] ${check.name}: ${check.detail || ''}`);
            }
          } else if (cmd === '/status') {
            if (!task) {
              out(`No task yet · mode=${planMode ? 'plan' : 'build'} · providers=${providerIds.join(',')}`);
            } else {
              task = runtime.getTask(task.id);
              const prov = providers.get(task.providerId);
              out(`Task ${task.id} · status=${task.status} · mode=${task.planMode ? 'plan' : 'build'} · provider=${task.providerId} (${prov?.tier || 'standard'}) · calls=${task.calls}/${task.policy?.maxCalls} · recoveries=${task.recoveries}/${task.policy?.maxAttempts} · verification=${task.verification?.status || 'none'}`);
            }
          } else {
            out(`Unknown command ${cmd}. Type /help for available commands.`);
          }
        } catch (err) {
          out(`Error: ${err.message}`);
        }
        if (isTTY) { rl.setPrompt(promptText()); rl.prompt(); }
        continue;
      }

      try {
        if (!task) {
          if (sourcePath) {
            task = await createImportedTask(runtime, dataDir, {
              sourcePath, objective: line, providerIds, policy,
              execution: workflow?.execution, persona: workflow?.persona, planMode
            });
          } else if (fixtureId) {
            task = await createFixtureTask(runtime, dataDir, {
              fixtureId, objective: line, providerIds, policy,
              execution: workflow?.execution, persona: workflow?.persona, scenario: option('scenario'), planMode
            });
          } else if (providerIds.every(id => { const p = providers.get(id); return p && p.kind !== 'scripted' && p.available !== false; })) {
            task = await createConversationTask(runtime, dataDir, {
              objective: line, providerIds, policy, persona: workflow?.persona, planMode
            });
          } else {
            const workspace = path.join(path.resolve(dataDir), 'workspaces', randomUUID());
            await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
            try { await gitInit(workspace); } catch {}
            task = await runtime.createTask({
              objective: line, workspace, workspaceKind: 'conversation',
              providers: providerIds, policy, execution: workflow?.execution || { enabled: false, network: false },
              persona: workflow?.persona, checks: [], acceptance: { mode: 'owner' }, planMode
            });
          }
          out(`Task ${task.id} · workspace ${task.workspace}`);
        } else {
          await runtime.submitMessage(task.id, line);
        }
        let streamedAny = false;
        const useColor = isTTY && !process.env.NO_COLOR;
        const dim = s => useColor ? `\x1b[2m${s}\x1b[0m` : s;
        const cyan = s => useColor ? `\x1b[36m${s}\x1b[0m` : s;
        const yellow = s => useColor ? `\x1b[33m${s}\x1b[0m` : s;
        const unsub = runtime.subscribe(task.id, delta => {
          if (delta.type === 'text' && delta.text) {
            if (!streamedAny) { process.stdout.write('\n'); streamedAny = true; }
            process.stdout.write(delta.text);
          } else if (delta.type === 'tool.start') {
            if (streamedAny) { process.stdout.write('\n'); streamedAny = false; }
            const target = delta.args?.path || delta.args?.command || delta.args?.query || '';
            process.stdout.write(cyan(`  ⌁ ${delta.name}${target ? ' ' + target : ''}\n`));
          } else if (delta.type === 'command.chunk' && delta.text) {
            process.stdout.write(dim(delta.text));
          } else if (delta.type === 'hook.blocked') {
            process.stdout.write(yellow(`  [hook blocked] ${delta.reason || delta.tool}\n`));
          }
        });
        try {
          task = await runtime.run(task.id);
        } finally {
          unsub();
        }
        if (streamedAny) process.stdout.write('\n');
        planMode = Boolean(task.planMode);
        if (!streamedAny) printLatestResponse(task);
        else {
          out(dim(`[status=${task.status} provider=${task.providerId} calls=${task.calls}/${task.policy?.maxCalls} mode=${task.planMode ? 'plan' : 'build'}]`));
          if (task.blocker?.message) out(yellow(`Note: ${task.blocker.message}`));
        }
        while (task.pendingApproval && isTTY) {
          const ap = task.pendingApproval;
          const ans = (await rl.question(yellow(`Approve ${ap.tool} (${ap.target || ''})? [y] once / [p] pattern / [a] always / [n] deny: `))).trim().toLowerCase();
          const decision = ans === 'p' ? 'always_pattern' : ans === 'a' ? 'always' : ans === 'n' ? 'deny' : 'once';
          const resolved = runtime.resolveApproval(task.id, { decision, resume: false });
          task = resolved.task;
          if (decision === 'deny') break;
          task = runtime.resume(task.id);
          task = await runtime.run(task.id);
          printLatestResponse(task);
        }
      } catch (err) {
        out(`Error: ${err.message}`);
      }
      if (isTTY) { rl.setPrompt(promptText()); rl.prompt(); }
    }
  } finally {
    rl.close();
  }
}

if (command === 'help' || command === '--help' || command === '-h') {
  process.stdout.write(`G0DC0D3 — controlled coding harness\n\n  node src/cli.mjs fixtures\n  node src/cli.mjs run --fixture task-board [--providers scripted-primary,scripted-fallback] [--workflow standard] [--scenario refusal] [--plan]\n  node src/cli.mjs run --source /path/to/repo --objective "..." --providers ... [--workflow high] [--plan]\n  node src/cli.mjs chat [--source DIR] [--providers ...] [--workflow ...] [--plan]\n  node src/cli.mjs list\n  node src/cli.mjs inspect TASK_ID\n  node src/cli.mjs resume TASK_ID [--calls 30]\n  node src/cli.mjs verify TASK_ID\n  node src/cli.mjs bench [--output DIRECTORY]\n\nWorkflows: ${WORKFLOW_NAMES.join(', ')}\nAll task commands accept --data DIRECTORY. G0D_ENABLE_CODEX=1 opts in to the authenticated experimental CLI bridge.\nServer and CLI must use different data directories while running simultaneously.\n`);
} else if (command === 'fixtures') print(fixtures.map(({ files, ...fixture }) => ({ ...fixture, files: Object.keys(files) })));
else if (command === 'bench') {
  const { runBenchmark } = await import('../bench/run.mjs');
  const report = await runBenchmark({ dataDir: option('output') || path.join(dataDir, 'benchmarks', Date.now().toString()) });
  print(report);
  process.exitCode = report.summary.failed ? 1 : 0;
} else {
  const envFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
  try {
    const lines = await fs.readFile(envFile, 'utf8');
    for (const raw of lines.split(/\r?\n/)) {
      const m = raw.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !(m[1] in process.env)) {
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        process.env[m[1]] = v;
      }
    }
  } catch {}
  const providers = new Map([...createScriptedProviders(), ...environmentProviders()]);
  const runtime = new Runtime({ dataDir, providers, evaluator: evaluateTask });
  try {
    if (command === 'chat') {
      await runChat(runtime, providers);
    } else if (command === 'run') {
      const workflow = resolveCliWorkflow();
      const policy = buildCliPolicy(workflow);
      const input = {
        sourcePath: option('source'),
        objective: option('objective'),
        fixtureId: option('fixture') || 'task-board',
        providerIds: option('providers')?.split(',').map(s => s.trim()).filter(Boolean),
        scenario: option('scenario'),
        policy,
        execution: workflow?.execution,
        persona: workflow?.persona,
        planMode: hasFlag('plan')
      };
      const task = input.sourcePath ? await createImportedTask(runtime, dataDir, input) : await createFixtureTask(runtime, dataDir, input);
      if (workflow) runtime.store.updateTask(task.id, current => { current.workflow = workflow.name; return current; }, 'workflow.applied', { workflow: workflow.name });
      process.stderr.write(`Task ${task.id}\nWorkspace ${task.workspace}\n`);
      print(await runtime.run(task.id));
      const finalTask = runtime.getTask(task.id);
      process.exitCode = (finalTask.status === 'completed' || (finalTask.planMode && finalTask.blocker?.code === 'PLAN_READY')) ? 0 : 1;
    } else if (command === 'list') print(runtime.listTasks().map(({ initialSnapshot, ...task }) => task));
    else if (command === 'inspect') print({ task: runtime.getTask(positionals[0]), events: runtime.getEvents(positionals[0]), operations: runtime.getOperations(positionals[0]) });
    else if (command === 'resume') {
      const targetId = positionals[0];
      const patch = {};
      if (option('calls') !== undefined) patch.maxCalls = Number(option('calls'));
      if (option('recoveries') !== undefined) patch.maxAttempts = Number(option('recoveries'));
      if (option('timeout') !== undefined) patch.requestTimeoutMs = Number(option('timeout'));
      if (Object.keys(patch).length) runtime.updatePolicy(targetId, patch);
      runtime.resume(targetId);
      const finalTask = await runtime.run(targetId);
      print(finalTask);
      process.exitCode = (finalTask.status === 'completed' || (finalTask.planMode && finalTask.blocker?.code === 'PLAN_READY')) ? 0 : 1;
    } else if (command === 'verify') {
      const evalResult = await evaluateTask(runtime.getTask(positionals[0]));
      print(evalResult);
      process.exitCode = evalResult.status === 'pass' ? 0 : 1;
    }
    else throw new Error(`Unknown command ${command}; use help`);
  } finally { await runtime.close(); }
}
