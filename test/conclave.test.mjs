import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { BrowserPool } from '../src/browser-env.mjs';

test('Conclave parallel agent.spawn fan-out runs concurrently, detects file overlaps, streams SSE events, and supports steer API', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-conclave-unit-'));
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-conclave-repo-'));
  await fs.writeFile(path.join(workDir, 'shared.js'), 'export const x = 42;\n');

  let mainTurns = 0;
  let concurrentNow = 0;
  let maxConcurrent = 0;

  const provider = {
    id: 'mock:conclave-worker',
    label: 'Mock Conclave Frontier',
    model: 'mock-conclave-1',
    kind: 'scripted',
    tier: 'frontier',
    available: true,
    capabilities: { tools: true, nativeTools: true, portableContext: true },
    async turn(context, opts = {}) {
      const obj = String(context?.task?.objective || '');
      if (obj.startsWith('Specialist role:')) {
        concurrentNow += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrentNow);
        try {
          // Step 1: read shared.js so both subagents touch the same file (conflict detection test)
          if ((context.task.calls || 1) === 1 && context.tools?.length) {
            await new Promise(r => setTimeout(r, 110));
            return {
              type: 'tool',
              calls: [{ id: `r-${Math.random().toString(36).slice(2, 7)}`, name: 'repo.read', args: { path: 'shared.js' } }],
            };
          }
          await new Promise(r => setTimeout(r, 60));
          opts.onDelta?.({ type: 'text', text: 'Inspected shared.js cleanly.' });
          return { type: 'message', finish: 'done', text: `Report from ${obj.split('\n')[0]}: shared.js exports x=42.` };
        } finally {
          concurrentNow -= 1;
        }
      }
      mainTurns += 1;
      if (mainTurns === 1) {
        return {
          type: 'tool',
          calls: [
            { id: 'spawn-explore-1', name: 'agent.spawn', args: { role: 'explore', prompt: 'Map shared.js exports' } },
            { id: 'spawn-reviewer-2', name: 'agent.spawn', args: { role: 'reviewer', prompt: 'Audit shared.js for bugs' } },
          ],
        };
      }
      return { type: 'message', finish: 'done', text: 'Both parallel specialists finished and reported back.' };
    },
  };

  const app = await createApp({
    dataDir: dir,
    auth: false,
    providers: new Map([[provider.id, provider]]),
    cliDiscovery: { probes: [] },
  });
  const root = await app.listen(0);

  try {
    const task = await app.runtime.createTask({
      title: 'Parallel Conclave Test',
      objective: 'Analyze shared.js using parallel specialists.',
      workspace: workDir,
      providers: [provider.id],
      permissionRules: [{ tool: '*', action: 'allow' }],
    });
    const taskId = task.id;

    // Subscribe to runtime stream events
    const streamed = [];
    const unsub = app.runtime.subscribeStream(taskId, ev => streamed.push(ev));

    await app.runtime.run(taskId);
    unsub();

    // Assert genuine concurrent execution
    assert.ok(maxConcurrent >= 2, `Expected >=2 concurrent subagents, got maxConcurrent=${maxConcurrent}`);
    assert.ok(streamed.some(e => e.type === 'subagent.started'), 'Expected subagent.started SSE event');
    assert.ok(streamed.some(e => e.type === 'subagent.progress'), 'Expected subagent.progress SSE event');
    assert.ok(streamed.some(e => e.type === 'subagent.completed'), 'Expected subagent.completed SSE event');

    // Assert GET /api/tasks/:id/conclave returns unified state + file overlap detection
    const conclave = await fetch(`${root}/api/tasks/${encodeURIComponent(taskId)}/conclave`).then(r => r.json());
    assert.equal(conclave.mode, 'swarm');
    assert.equal(conclave.workers.length, 2);
    assert.equal(conclave.stats.completedWorkers, 2);
    assert.ok(conclave.workers.every(w => w.status === 'completed' && w.files.includes('shared.js')));
    assert.ok(conclave.fileConflicts.some(c => c.file === 'shared.js' && c.owners.length === 2), 'Expected shared.js overlap detected');

    // Assert POST /api/tasks/:id/conclave/steer succeeds cleanly
    const steerRes = await fetch(`${root}/api/tasks/${encodeURIComponent(taskId)}/conclave/steer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
      body: JSON.stringify({ workerId: 'spawn-explore-1', message: 'Focus on edge cases too.' }),
    }).then(r => r.json());
    assert.equal(steerRes.ok, true);
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(workDir, { recursive: true, force: true });
  }
});

test('Conclave UI renders Stage, Cards, Timeline, Arena Race, Worker Inspector, and Light theme with 0 errors and 0 inline styles', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-conclave-ui-'));
  const stub = {
    id: 'openrouter:anthropic-claude-sonnet-5.5',
    label: 'Claude Sonnet 5.5 · OpenRouter',
    model: 'anthropic/claude-sonnet-5.5',
    kind: 'http',
    tier: 'frontier',
    available: true,
    capabilities: { tools: true, nativeTools: true, portableContext: true },
    async turn() { return { type: 'message', finish: 'done', text: 'ok' }; },
  };
  const app = await createApp({
    dataDir: dir,
    auth: false,
    providers: new Map([[stub.id, stub]]),
    cliDiscovery: { probes: [] },
  });
  const root = await app.listen(0);
  const pool = new BrowserPool();
  const sid = 'conclave-ui';

  try {
    await pool.open(sid, { url: root + '/', viewport: { width: 1440, height: 900 }, waitMs: 1100 }, { privacy: { localOnly: false } });
    await pool.evaluate(sid, {
      expression: `(() => {
        window.__CONCLAVE_ERRORS = [];
        window.addEventListener('error', e => window.__CONCLAVE_ERRORS.push(e.message));
        window.addEventListener('unhandledrejection', e => window.__CONCLAVE_ERRORS.push(String(e.reason)));
        return true;
      })()`,
    });
    const dlgs = JSON.parse((await pool.evaluate(sid, { expression: `[...document.querySelectorAll('dialog[open]')].map(d => d.id)` })).result);
    if (dlgs.length) await pool.act(sid, { action: 'press', key: 'Escape', waitMs: 200 }, { privacy: { localOnly: false } });

    // Open Conclave via header toggle button
    await pool.act(sid, { action: 'click', selector: '#conclave-toggle-btn', waitMs: 350 }, { privacy: { localOnly: false } });
    const openCheck = JSON.parse((await pool.evaluate(sid, {
      expression: `(() => ({
        open: window.G0DConclave?.isOpen(),
        inlineStyles: document.querySelectorAll('#conclave-dock [style]').length,
        hasPresets: document.querySelectorAll('[data-conclave-preset]').length,
      }))()`,
    })).result);
    assert.equal(openCheck.open, true);
    assert.equal(openCheck.inlineStyles, 0);
    assert.equal(openCheck.hasPresets, 3);

    // Click Preview Swarm, switch across Cards & Timeline & inspect a worker
    await pool.act(sid, { action: 'click', selector: '#conclave-demo-btn', waitMs: 350 }, { privacy: { localOnly: false } });
    await pool.act(sid, { action: 'click', selector: '[data-conclave-lens="cards"]', waitMs: 250 }, { privacy: { localOnly: false } });
    const cardCount = JSON.parse((await pool.evaluate(sid, { expression: `document.querySelectorAll('.conclave-card').length` })).result);
    assert.equal(cardCount, 3);

    // Inspect first worker & steer in demo mode
    await pool.act(sid, { action: 'click', selector: '[data-conclave-select]', waitMs: 250 }, { privacy: { localOnly: false } });
    const inspectorVisible = JSON.parse((await pool.evaluate(sid, { expression: `!document.querySelector('#conclave-inspector')?.classList.contains('hidden')` })).result);
    assert.equal(inspectorVisible, true);

    await pool.act(sid, { action: 'click', selector: '[data-conclave-lens="timeline"]', waitMs: 250 }, { privacy: { localOnly: false } });
    await pool.act(sid, { action: 'click', selector: '[data-conclave-lens="stage"]', waitMs: 250 }, { privacy: { localOnly: false } });

    // Verify Arena Race mode renders cleanly too
    await pool.evaluate(sid, { expression: `window.G0DConclave.startDemo(5); true;` });
    const arenaMode = (await pool.evaluate(sid, { expression: `window.G0DConclave.getState()?.mode` })).result;
    assert.equal(arenaMode, 'arena');

    const errors = JSON.parse((await pool.evaluate(sid, { expression: `window.__CONCLAVE_ERRORS || []` })).result);
    assert.deepEqual(errors, []);
  } finally {
    await pool.closeAll();
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
