import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildDomainMetacognition,
  detectModelFamily,
  forgeTaskMegaprompt,
  formatJudgeRubricBlock,
  shouldAutoForge
} from '../src/metacognition.mjs';
import { compileInstructions, taskContextData } from '../src/prompts.mjs';
import { createApp } from '../src/server.mjs';
import { BrowserPool } from '../src/browser-env.mjs';

test('Tier 1 0ms Domain × Model-Family Metacognition frames all 7 deep domains, skips fast_general/fast effort, and keeps system prefix cache-stable', () => {
  assert.equal(detectModelFamily('gemini:gemini-4-neon'), 'gemini');
  assert.equal(detectModelFamily('openrouter:anthropic-claude-sonnet-5.5'), 'anthropic');
  assert.equal(detectModelFamily('codex-cli:gpt-5.4-codex'), 'openai');
  assert.equal(detectModelFamily('openrouter:deepseek-v4'), 'deepseek');
  assert.equal(detectModelFamily('venice:hermes-4-405b'), 'open_weight');

  // Instant chat bypass
  assert.equal(buildDomainMetacognition({ domain: 'fast_general', modelFamily: 'gemini' }), null);
  assert.equal(buildDomainMetacognition({ domain: 'swe_coding', modelFamily: 'gemini', effort: 'fast' }), null);

  for (const dom of ['swe_coding', 'frontend_ui', 'math_reasoning', 'security_research', 'creative_writing', 'long_context', 'vision_multimodal']) {
    const brief = buildDomainMetacognition({ domain: dom, modelFamily: 'gemini', effort: 'high' });
    assert.ok(brief && brief.tier === 'smart' && brief.durationMs === 0);
    assert.ok(brief.compiledBrief.includes('gemini'));
    assert.ok(brief.rubric.length >= 3);
  }

  // Prefix-cache stability: static compileInstructions() must NOT change when metacognitionBrief is present
  const baseTask = { id: 't1', objective: 'Refactor auth middleware', workspaceKind: 'project', calls: 1, policy: { maxCalls: 50 }, execution: { enabled: false } };
  const framedTask = { ...baseTask, routing: { metacognition: buildDomainMetacognition({ domain: 'swe_coding', modelFamily: 'gemini' }) } };
  assert.equal(compileInstructions({ task: baseTask }), compileInstructions({ task: framedTask }));
  assert.ok(taskContextData({ task: framedTask }).metacognitionBrief.includes('Systems & SWE Metacognition'));
  assert.equal(taskContextData({ task: baseTask }).metacognitionBrief, undefined);
});

test('Tier 2 Ultra-Forge LLM Megaprompt Architect synthesizes intent lock + rubric, falls back cleanly on bad JSON, and injects rubric into Arena Blind Judge', async () => {
  assert.equal(shouldAutoForge({ objective: 'Hi', domain: 'swe_coding', mode: 'auto_forge', isFirstTurn: true }), false);
  assert.equal(shouldAutoForge({ objective: 'Design a lock-free concurrent ring buffer in Rust with loom verification tests.', domain: 'swe_coding', mode: 'auto_forge', isFirstTurn: true }), true);
  assert.equal(shouldAutoForge({ objective: 'Design a lock-free concurrent ring buffer in Rust with loom verification tests.', domain: 'swe_coding', mode: 'auto_forge', isFirstTurn: false }), false);

  const goodArchitect = {
    id: 'gemini:gemini-4-neon',
    label: 'Gemini 4 Neon',
    available: true,
    async draft() {
      return {
        type: 'message',
        finish: 'done',
        text: JSON.stringify({
          intentLock: 'Implement a lock-free SPSC ring buffer in Rust without adding external dependencies.',
          failureModes: ['Weak memory ordering on head/tail atomics', 'Wrap-around off-by-one capacity check'],
          rubric: ['Uses Acquire/Release atomics correctly', 'Handles full and empty wrap-around cleanly', 'Zero unsafe UB'],
          executionPlan: 'Define invariants for head/tail indices first, write minimal SPSC struct, then prove wrap-around edge cases.'
        })
      };
    }
  };

  const forged = await forgeTaskMegaprompt({
    objective: 'Implement a lock-free SPSC ring buffer in Rust with wrap-around tests.',
    domain: 'swe_coding',
    targetProvider: goodArchitect,
    architectProvider: goodArchitect
  });
  assert.equal(forged.tier, 'forged');
  assert.ok(forged.compiledBrief.includes('Intent lock:'));
  assert.equal(forged.rubric.length, 3);

  const judgeBlock = formatJudgeRubricBlock(forged);
  assert.ok(judgeBlock.includes('Uses Acquire/Release atomics correctly'));

  // Graceful fallback when architect outputs malformed JSON
  const badArchitect = { id: 'mock:bad', available: true, async draft() { return { type: 'message', finish: 'done', text: 'not json at all' }; } };
  const fallback = await forgeTaskMegaprompt({
    objective: 'Implement a lock-free SPSC ring buffer in Rust with wrap-around tests.',
    domain: 'swe_coding',
    architectProvider: badArchitect
  });
  assert.equal(fallback.tier, 'smart');
  assert.equal(fallback.fallbackReason, 'forge_parse_fallback');
});

test('End-to-end Ultra-Plinian Auto-Forge HTTP API, Arena Judge rubric propagation, and Settings UI selector', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-metacog-e2e-'));
  let judgeReceivedRubric = false;

  const provA = {
    id: 'openrouter:gemini-4-neon',
    label: 'Gemini 4 Neon · OpenRouter',
    model: 'google/gemini-4-neon',
    kind: 'http',
    baseUrl: 'https://openrouter.ai/api/v1',
    protocol: 'openai-chat',
    tier: 'frontier',
    available: true,
    capabilities: { tools: true, nativeTools: true, portableContext: true },
    async turn() { return { type: 'message', finish: 'done', text: 'Done.' }; },
    async draft(messages) {
      const sys = String(messages?.[0]?.content || '');
      if (sys.includes('Ultra-Plinian Metaprompt Architect')) {
        return {
          type: 'message',
          finish: 'done',
          text: JSON.stringify({
            intentLock: 'Design an event-sourced ledger with idempotency keys.',
            failureModes: ['Duplicate event replay without idempotency check'],
            rubric: ['UNIQUE_RUBRIC_TOKEN_42: Enforces idempotent event ingestion', 'Clear schema & reconciliation flow'],
            executionPlan: 'Specify append-only schema, idempotency key constraint, and projection rebuild.'
          })
        };
      }
      if (sys.includes('blind editor')) {
        if (sys.includes('UNIQUE_RUBRIC_TOKEN_42')) judgeReceivedRubric = true;
        return {
          type: 'message',
          finish: 'done',
          text: JSON.stringify({
            winner: 'A',
            grades: [
              { id: 'A', fidelity: 5, completeness: 5, clarity: 5, reason: 'Met forged idempotency rubric.' },
              { id: 'B', fidelity: 4, completeness: 4, clarity: 5, reason: 'Good overview.' }
            ]
          })
        };
      }
      return { type: 'message', finish: 'done', text: 'Contender A answer on event-sourced ledgers.' };
    }
  };
  const provB = {
    id: 'openrouter:claude-sonnet-5.5',
    label: 'Claude Sonnet 5.5 · OpenRouter',
    model: 'anthropic/claude-sonnet-5.5',
    kind: 'http',
    baseUrl: 'https://openrouter.ai/api/v1',
    protocol: 'openai-chat',
    tier: 'frontier',
    available: true,
    capabilities: { tools: true, nativeTools: true, portableContext: true },
    async turn() { return { type: 'message', finish: 'done', text: 'Done B.' }; },
    async draft(messages) {
      const sys = String(messages?.[0]?.content || '');
      if (sys.includes('Ultra-Plinian Metaprompt Architect')) {
        return {
          type: 'message',
          finish: 'done',
          text: JSON.stringify({
            intentLock: 'Design an event-sourced ledger with idempotency keys.',
            failureModes: ['Duplicate event replay without idempotency check'],
            rubric: ['UNIQUE_RUBRIC_TOKEN_42: Enforces idempotent event ingestion', 'Clear schema & reconciliation flow'],
            executionPlan: 'Specify append-only schema, idempotency key constraint, and projection rebuild.'
          })
        };
      }
      if (sys.includes('blind editor')) {
        if (sys.includes('UNIQUE_RUBRIC_TOKEN_42')) judgeReceivedRubric = true;
        return {
          type: 'message',
          finish: 'done',
          text: JSON.stringify({
            winner: 'A',
            grades: [
              { id: 'A', fidelity: 5, completeness: 5, clarity: 5, reason: 'Met forged idempotency rubric.' },
              { id: 'B', fidelity: 4, completeness: 4, clarity: 5, reason: 'Good overview.' }
            ]
          })
        };
      }
      return { type: 'message', finish: 'done', text: 'Contender B answer on event-sourced ledgers.' };
    }
  };

  const app = await createApp({
    dataDir: dir,
    auth: false,
    providers: new Map([[provA.id, provA], [provB.id, provB]]),
    cliDiscovery: { probes: [] }
  });
  const root = await app.listen(0);
  const pool = new BrowserPool();

  try {
    // 1. Update router to auto_arena + auto_forge
    const patchRes = await fetch(`${root}/api/router`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
      body: JSON.stringify({ mode: 'auto_arena', metacognition: 'auto_forge' })
    }).then(r => r.json());
    assert.equal(patchRes.settings.metacognition, 'auto_forge');

    // 2. Test POST /api/metacognition/forge directly
    const forgeRes = await fetch(`${root}/api/metacognition/forge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
      body: JSON.stringify({ objective: 'Design an event-sourced ledger with idempotency keys and replay safety.', providerId: provA.id })
    }).then(r => r.json());
    assert.equal(forgeRes.tier, 'forged');
    assert.ok(forgeRes.rubric.some(r => r.includes('UNIQUE_RUBRIC_TOKEN_42')));

    // 3. Create auto-routed Arena conversation and verify forged metacognition + Judge rubric injection!
    const created = await fetch(`${root}/api/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
      body: JSON.stringify({
        objective: 'Design a distributed SQL database architecture for an event-sourced API ledger with idempotency keys and replay safety.'
      })
    }).then(r => r.json());
    const taskId = created.task.id;
    const stored = app.runtime.getTask(taskId);
    assert.equal(stored.routing?.metacognition?.tier, 'forged');

    // Run Arena Race and verify Blind Judge received UNIQUE_RUBRIC_TOKEN_42!
    if (stored.answerRace) {
      await app.runtime.run(taskId);
      assert.equal(judgeReceivedRubric, true, 'Expected Blind Judge to receive forged acceptance rubric');
    }

    // 4. Verify UI selector in Settings -> Models -> Routing & Arena
    await pool.open('mc-ui', { url: root + '/', viewport: { width: 1280, height: 820 }, waitMs: 900 }, { privacy: { localOnly: false } });
    const dlgs = JSON.parse((await pool.evaluate('mc-ui', { expression: `[...document.querySelectorAll('dialog[open]')].map(d => d.id)` })).result);
    if (dlgs.length) await pool.act('mc-ui', { action: 'press', key: 'Escape', waitMs: 180 }, { privacy: { localOnly: false } });
    await pool.act('mc-ui', { action: 'click', selector: '#settings-open', waitMs: 300 }, { privacy: { localOnly: false } });
    await pool.act('mc-ui', { action: 'click', selector: '#settings-tab-models', waitMs: 250 }, { privacy: { localOnly: false } });
    await pool.act('mc-ui', { action: 'click', selector: '[data-models-subtab="routing"]', waitMs: 250 }, { privacy: { localOnly: false } });
    const uiCheck = JSON.parse((await pool.evaluate('mc-ui', {
      expression: `(() => ({
        btnCount: document.querySelectorAll('[data-router-metacog]').length,
        activeMode: document.querySelector('[data-router-metacog].active')?.dataset?.routerMetacog || '',
        inlineStyles: document.querySelectorAll('#ultra-router-section [style]').length
      }))()`
    })).result);
    assert.equal(uiCheck.btnCount, 3);
    assert.equal(uiCheck.activeMode, 'auto_forge');
    assert.equal(uiCheck.inlineStyles, 0);
  } finally {
    await pool.closeAll();
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
