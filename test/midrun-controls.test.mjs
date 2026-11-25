import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Runtime } from '../src/runtime.mjs';

test('Thinking effort and generation parameters can be changed while a task is actively inferencing and apply on the next turn', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-midrun-controls-'));
  const wsDir = path.join(dir, 'ws');
  await fs.mkdir(wsDir, { recursive: true });

  let turnCount = 0;
  let releaseFirstTurn;
  let firstTurnStarted;
  const firstTurnGate = new Promise(resolve => { releaseFirstTurn = resolve; });
  const firstTurnReady = new Promise(resolve => { firstTurnStarted = resolve; });
  const observedTurns = [];

  const provider = {
    id: 'local:midrun-test',
    label: 'Midrun Test Model',
    kind: 'http',
    protocol: 'openai-chat',
    maxOutputTokensCeiling: 4096,
    tier: 'local',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'midrun-model',
    available: true,
    async turn(context) {
      turnCount += 1;
      observedTurns.push({
        turn: turnCount,
        effort: context.task.effort,
        generation: structuredClone(context.task.generation || {}),
      });
      if (turnCount === 1) {
        firstTurnStarted();
        await firstTurnGate;
        return {
          type: 'tool',
          calls: [{ id: 'c-1', name: 'repo.write', args: { path: 'midrun.txt', content: 'step 1\n' } }],
        };
      }
      return { type: 'message', finish: 'done', text: 'Done with updated settings.' };
    },
  };

  const runtime = new Runtime({ dataDir: dir, providers: new Map([[provider.id, provider]]) });
  try {
    const task = await runtime.createTask({
      workspace: wsDir,
      workspaceKind: 'conversation',
      acceptance: { mode: 'owner' },
      objective: 'Test changing effort and generation parameters while inferencing.',
      providers: [provider.id],
      effort: 'fast',
      generation: { temperature: 0.9 },
    });

    const runPromise = runtime.run(task.id);
    await firstTurnReady;

    // Task is actively running inside turn 1 right now
    const runningTask = runtime.getTask(task.id);
    assert.equal(runningTask.status, 'running');

    // Update both thinking effort and generation parameters mid-inference
    const afterEffort = runtime.setEffort(task.id, 'high');
    assert.equal(afterEffort.effort, 'high');
    const afterGen = runtime.updateGeneration(task.id, { temperature: 0.25, max_tokens: 1024 });
    assert.equal(afterGen.generation.temperature, 0.25);
    assert.equal(afterGen.generation.max_tokens, 1024);

    // Release turn 1 so turn 2 starts and picks up the new settings
    releaseFirstTurn();
    const finished = await runPromise;
    assert.equal(finished.status, 'waiting_input');
    assert.equal(finished.effort, 'high');
    assert.equal(finished.generation.temperature, 0.25);

    assert.equal(observedTurns.length, 2);
    assert.equal(observedTurns[0].effort, 'fast');
    assert.equal(observedTurns[0].generation.temperature, 0.9);
    assert.equal(observedTurns[1].effort, 'high');
    assert.equal(observedTurns[1].generation.temperature, 0.25);
    assert.equal(observedTurns[1].generation.max_tokens, 1024);
  } finally {
    await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
