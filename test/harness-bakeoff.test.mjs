import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  BAKEOFF_SUITES,
  loadBakeoffTasks,
  detectAvailableHarnesses,
  buildHarnessExecSpec,
  materializeTaskWorkspace,
  classifyBakeoffOutcome,
  runHarnessBakeoff,
} from '../bench/harness-bakeoff.mjs';
import { repairFiles } from '../bench/scripted.mjs';

test('Harness Bakeoff: suite loading, SWE-bench JSONL loader, CLI command builders, and refusal/timeout classifier', async () => {
  const core = await loadBakeoffTasks({ suite: 'core' });
  assert.equal(core.length, BAKEOFF_SUITES.core.length);
  assert.ok(core.every(t => t.fixtureId && t.prompt.length > 20));

  const sec = await loadBakeoffTasks({ suite: 'adversarial-security', limit: 2 });
  assert.equal(sec.length, 2);
  assert.equal(sec[0].category, 'adversarial-security');

  // SWE-bench style JSONL manifest loader
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'g0d-bakeoff-jsonl-'));
  const jsonlPath = path.join(dir, 'swebench-slice.jsonl');
  await fs.writeFile(jsonlPath, [
    JSON.stringify({ instance_id: 'repo__issue-1', problem_statement: 'Fix parser edge case', files: { 'index.js': 'export const x = 1;\n' }, test_cmd: 'node -e "process.exit(0)"' }),
    JSON.stringify({ instance_id: 'repo__issue-2', problem_statement: 'Fix cache leak', files: { 'cache.js': 'export const c = 2;\n' }, test_cmd: 'node -e "process.exit(0)"' }),
  ].join('\n'));
  const loaded = await loadBakeoffTasks({ tasksFile: jsonlPath });
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].id, 'repo__issue-1');
  assert.equal(loaded[0].verifyCommand, 'node -e "process.exit(0)"');
  await fs.rm(dir, { recursive: true, force: true });

  // External harness invocation specs keep prompts on stdin (never raw shell args)
  const codex = buildHarnessExecSpec('codex', { prompt: 'Fix --flag bug', workspace: '/tmp/ws', model: 'gpt-5.4' });
  assert.equal(codex.binName, 'codex');
  assert.equal(codex.stdinText, 'Fix --flag bug');
  assert.ok(codex.args.includes('--sandbox') && codex.args.includes('workspace-write') && codex.args.includes('gpt-5.4'));
  assert.ok(!codex.args.includes('Fix --flag bug'));

  const claude = buildHarnessExecSpec('claude', { prompt: 'Audit', workspace: '/tmp/ws', model: 'claude-sonnet-4-6' });
  assert.equal(claude.outputFormat, 'claude_json');
  assert.ok(claude.args.includes('--output-format') && claude.args.includes('json') && claude.args.includes('claude-sonnet-4-6'));

  const agy = buildHarnessExecSpec('agy', { prompt: 'Fix', workspace: '/tmp/ws' });
  assert.deepEqual(agy.acpArgs, ['--acp']);

  // Outcome classifier distinguishes pass, timeout, refusal, no_edits, and wrong patch
  assert.equal(classifyBakeoffOutcome({ verified: { status: 'pass' } }).status, 'pass');
  assert.equal(classifyBakeoffOutcome({ verified: { status: 'fail' }, timedOut: true }).status, 'timeout');
  assert.equal(
    classifyBakeoffOutcome({
      verified: { status: 'fail' },
      diffStat: { filesTouched: 0, insertions: 0, deletions: 0 },
      outputText: 'I cannot assist with this security-related request.',
    }).status,
    'refusal'
  );
  assert.equal(
    classifyBakeoffOutcome({
      verified: { status: 'fail' },
      diffStat: { filesTouched: 1, insertions: 12, deletions: 3 },
      outputText: 'Applied patch.',
    }).status,
    'fail'
  );
});

test('Harness Bakeoff: end-to-end head-to-head execution with untouched external verifier, refusal detection & artifacts', async () => {
  const outDir = await fs.mkdtemp(path.join(tmpdir(), 'g0d-bakeoff-out-'));
  try {
    // 1. Dry-run mode works with 0 API calls and produces all 3 artifacts
    const dry = await runHarnessBakeoff({
      suite: 'quick',
      limit: 2,
      harnesses: ['g0dc0d3'],
      dryRun: true,
      outputDir: path.join(outDir, 'dry'),
    });
    assert.equal(dry.report.cells.length, 2);
    assert.ok(dry.markdown.includes('G0DC0D3 Harness Bakeoff Scoreboard'));
    assert.ok(dry.html.includes('<!doctype html>'));

    // 2. Live multi-harness comparison using deterministic executors against untouched external verifier:
    //    - `g0dc0d3` applies the real known repair for `task-board` -> PASS!
    //    - `mock-refuser` refuses without editing -> REFUSAL!
    //    - `mock-broken` writes a broken patch -> FAIL (caught by untouched external verifier)!
    const run = await runHarnessBakeoff({
      suite: 'quick',
      limit: 1, // task-board
      harnesses: ['g0dc0d3', 'mock-refuser', 'mock-broken'],
      outputDir: path.join(outDir, 'live'),
      customExecutors: {
        g0dc0d3: async ({ task, workspace }) => {
          const fixes = repairFiles[task.fixtureId];
          for (const [rel, content] of Object.entries(fixes)) {
            await fs.writeFile(path.join(workspace, rel), content, 'utf8');
          }
          return { durationMs: 420, tokens: { input: 500, output: 200, total: 700 }, costUsd: 0.004, turns: 2, toolCalls: 2, outputText: 'Repaired.', timedOut: false, exitCode: 0, error: null };
        },
        'mock-refuser': async () => ({
          durationMs: 180,
          tokens: { input: 300, output: 40, total: 340 },
          costUsd: 0.001,
          turns: 1,
          toolCalls: 0,
          outputText: 'I cannot comply with modifying this repository.',
          timedOut: false,
          exitCode: 0,
          error: null,
        }),
        'mock-broken': async ({ workspace }) => {
          await fs.writeFile(path.join(workspace, 'src/slug.mjs'), 'export function slugify() { return "wrong"; }\n', 'utf8');
          return { durationMs: 650, tokens: { input: 600, output: 120, total: 720 }, costUsd: 0.005, turns: 1, toolCalls: 1, outputText: 'All done!', timedOut: false, exitCode: 0, error: null };
        },
      },
    });

    const byId = Object.fromEntries(run.report.cells.map(c => [c.harnessId, c]));
    assert.equal(byId.g0dc0d3.outcome.status, 'pass');
    assert.equal(byId['mock-refuser'].outcome.status, 'refusal');
    assert.equal(byId['mock-broken'].outcome.status, 'fail');
    assert.equal(run.report.summary.harnesses[0].harnessId, 'g0dc0d3');
    assert.equal(run.report.summary.harnesses[0].passRatePct, 100);

    // Verify all 3 output files were persisted cleanly with zero host path leakage or inline style=
    const savedJsonRaw = await fs.readFile(path.join(outDir, 'live', 'bakeoff-report.json'), 'utf8');
    const savedJson = JSON.parse(savedJsonRaw);
    const savedMd = await fs.readFile(path.join(outDir, 'live', 'SCOREBOARD.md'), 'utf8');
    const savedHtml = await fs.readFile(path.join(outDir, 'live', 'scoreboard.html'), 'utf8');
    assert.equal(savedJson.summary.harnesses[0].passed, 1);
    assert.equal(savedJson.outputDir, undefined);
    assert.ok(Object.values(savedJson.detectedHarnesses).every(h => !('binPath' in h)));
    assert.match(savedMd, /G0DC0D3 \(Native\).*100%/);
    assert.match(savedHtml, /task-board/);
    assert.ok(!/style=/i.test(savedHtml), 'scoreboard.html should avoid inline style= attributes');

    // Security guards: reject path traversal in inline files and flag-prefixed git repo sources
    await assert.rejects(
      () => materializeTaskWorkspace({ id: 'bad-path', files: { '../escape.txt': 'nope' } }, path.join(outDir, 'sec-ws-1')),
      /Unsafe file path/
    );
    await assert.rejects(
      () => materializeTaskWorkspace({ id: 'bad-repo', repo: '--upload-pack=evil' }, path.join(outDir, 'sec-ws-2')),
      /Invalid repository source/
    );

    // CLI --help exits 0 cleanly
    const help = spawnSync(process.execPath, [path.resolve('bench/harness-bakeoff.mjs'), '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /bench:bakeoff/);

    // Harness detection returns structured map
    const det = await detectAvailableHarnesses();
    assert.equal(det.g0dc0d3.available, true);
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});
