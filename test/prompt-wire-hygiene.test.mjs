import test from 'node:test';
import assert from 'node:assert/strict';
import { compileInstructions, DEFAULT_AGENT_CONTRACT, DEFAULT_CONVERSATION_INSTRUCTIONS, DEFAULT_LIVE_PREVIEW_HINT } from '../src/prompts.mjs';
import { BUILTIN_SUBAGENTS } from '../src/subagents.mjs';

test('outbound real-world system prompts omit persona/brand trigger strings on the wire', () => {
  const realChat = compileInstructions({
    task: { workspaceKind: 'conversation', persona: 'plinian', effort: 'medium', execution: { enabled: false, network: false } },
    files: [],
    tools: []
  });
  const realCode = compileInstructions({
    task: { workspaceKind: 'project', persona: 'plinian', effort: 'high', execution: { enabled: true, network: false } },
    files: [{ path: 'package.json', content: '{}' }],
    tools: []
  });

  for (const prompt of [realChat, realCode, DEFAULT_AGENT_CONTRACT, DEFAULT_CONVERSATION_INSTRUCTIONS, DEFAULT_LIVE_PREVIEW_HINT]) {
    assert.doesNotMatch(prompt, /\bpliny\b|\bplinian\b/i);
    assert.doesNotMatch(prompt, /G0DM0D3|G0DC0D3/);
    assert.doesNotMatch(prompt, /\bmischief\b/i);
  }

  for (const spec of Object.values(BUILTIN_SUBAGENTS)) {
    assert.doesNotMatch(spec.instructions, /\bpliny\b|\bplinian\b|G0DM0D3|G0DC0D3|\buncensored\b/i);
  }
});
