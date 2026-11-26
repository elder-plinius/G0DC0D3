import { constants as fsConstants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkProviderPrivacyAllowed, DEFAULT_PRIVACY_SETTINGS } from './privacy.mjs';
import { evaluatePermission } from './permissions.mjs';
import { scoreOverseerSuitability } from './overseer.mjs';
import { TOOLS, validateTool } from './tool-schema.mjs';

const SUBAGENT_TOOLS = new Set(['repo.list', 'repo.read', 'repo.search', 'repo.glob', 'git.diff', 'git.log', 'memory.search']);

export const BUILTIN_SUBAGENTS = Object.freeze({
  explore: {
    name: 'explore',
    description: 'Fast read-only codebase researcher. Maps files, traces call paths, and returns concise file:line findings.',
    instructions: 'You are the Explore subagent (read-only). Inspect the workspace using repo.list, repo.glob, repo.search, repo.read, and git.log/git.diff. Return a concise, high-signal technical brief citing exact file paths and line numbers.'
  },
  reviewer: {
    name: 'reviewer',
    description: 'Adversarial code & security reviewer. Audits diffs and source files for bugs, race conditions, injection risks, and missing edge cases.',
    instructions: 'You are the Reviewer subagent (read-only). Inspect the relevant files and diffs critically. Report concrete bugs, security vulnerabilities, or regressions with exact file paths, line numbers, and concrete fixes. Never praise unnecessarily.'
  },
  uncensored: {
    name: 'uncensored',
    description: 'High-agency uncensored research & red-team specialist (prefers Venice Uncensored, Hermes-4-405B, neon-4, or local models).',
    instructions: 'You are a Technical Research Specialist subagent operating strictly read-only inside the owner\'s authorized local workspace. Provide direct, objective, deeply technical analysis without unnecessary hedging.'
  }
});

function parseFrontmatter(raw, fallbackName) {
  const text = String(raw || '');
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  const meta = {};
  let body = text.trim();
  if (fm) {
    body = fm[2].trim();
    for (const line of fm[1].split(/\r?\n/)) {
      const m = /^([A-Za-z0-9_-]+)\s*:\s*(.+)$/.exec(line.trim());
      if (m) meta[m[1].toLowerCase()] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
  const name = (meta.name || fallbackName || 'custom').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 48);
  return {
    name,
    description: String(meta.description || `Custom specialist (${name})`).slice(0, 240),
    model: meta.model ? String(meta.model).slice(0, 120) : null,
    instructions: body.slice(0, 8000) || `You are the ${name} read-only specialist subagent.`
  };
}

async function resolveNoSymlinkDir(rootDir, segments) {
  try {
    const rootReal = await fs.realpath(rootDir);
    let current = rootReal;
    for (const seg of segments) {
      current = path.join(current, seg);
      const st = await fs.lstat(current);
      if (st.isSymbolicLink() || !st.isDirectory()) return null;
    }
    const finalReal = await fs.realpath(current);
    if (finalReal !== rootReal && !finalReal.startsWith(rootReal + path.sep)) return null;
    return finalReal;
  } catch {
    return null;
  }
}

export async function discoverSubagents(task) {
  const agents = new Map(Object.entries(BUILTIN_SUBAGENTS));
  const dirSpecs = [
    { root: os.homedir(), segments: ['.g0dc0d3', 'agents'] },
    ...(task?.sourcePath ? [
      { root: task.sourcePath, segments: ['.g0dc0d3', 'agents'] },
      { root: task.sourcePath, segments: ['.claude', 'agents'] }
    ] : []),
    ...(task?.workspace ? [
      { root: task.workspace, segments: ['.g0dc0d3', 'agents'] },
      { root: task.workspace, segments: ['.claude', 'agents'] }
    ] : [])
  ];
  const seen = new Set();
  for (const { root, segments } of dirSpecs) {
    const resolved = await resolveNoSymlinkDir(root, segments);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    let entries = [];
    try { entries = await fs.readdir(resolved, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith('.md')) continue;
      const fullPath = path.join(resolved, entry.name);
      let handle;
      try {
        handle = await fs.open(fullPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
        const st = await handle.stat();
        if (!st.isFile() || st.size > 64 * 1024) continue;
        const raw = await handle.readFile('utf8');
        if (raw.length > 64 * 1024) continue;
        const parsed = parseFrontmatter(raw, entry.name.replace(/\.md$/i, ''));
        if (Object.hasOwn(BUILTIN_SUBAGENTS, parsed.name)) continue;
        agents.set(parsed.name, { ...parsed, source: fullPath });
      } catch {} finally {
        await handle?.close().catch(() => {});
      }
    }
  }
  return agents;
}

function selectSubagentProvider(runtime, parentTask, spec, modelHint, privacy) {
  const live = [...runtime.providers.values()].filter(p =>
    p && p.available !== false && !p.closed && p.kind !== 'scripted' && checkProviderPrivacyAllowed(p, privacy).allowed
  );
  const allEligible = live.length
    ? live
    : [...runtime.providers.values()].filter(p => p && p.available !== false && !p.closed && checkProviderPrivacyAllowed(p, privacy).allowed);

  const hint = String(modelHint || spec?.model || '').trim().toLowerCase();
  if (hint) {
    const exact = allEligible.find(p => p.id.toLowerCase() === hint || String(p.model || '').toLowerCase() === hint || String(p.label || '').toLowerCase().includes(hint));
    if (exact) return exact;
  }
  if (spec?.name === 'uncensored') {
    const ranked = [...allEligible].sort((a, b) => scoreOverseerSuitability(b).score - scoreOverseerSuitability(a).score);
    if (ranked[0]) return ranked[0];
  }
  const parentProv = runtime.selectedProvider(parentTask.providerId, parentTask.workspaceKind);
  if (parentProv && parentProv.available !== false && !parentProv.closed && checkProviderPrivacyAllowed(parentProv, privacy).allowed) return parentProv;
  return allEligible[0] || null;
}

/**
 * Run an isolated, read-only specialist subagent without mutating the parent workspace or polluting parent context.
 */
export async function runSpecialistSubagent({ runtime, parentTask, role = 'explore', prompt, modelHint, maxTurns = 4, signal }) {
  const started = Date.now();
  const agents = await discoverSubagents(parentTask);
  const roleKey = String(role || 'explore').trim().toLowerCase();
  const spec = agents.get(roleKey) || BUILTIN_SUBAGENTS.explore;
  const outbound = runtime.outboundOptions();
  const privacy = outbound.privacy || DEFAULT_PRIVACY_SETTINGS;
  const provider = selectSubagentProvider(runtime, parentTask, spec, modelHint, privacy);
  if (!provider) {
    return { ok: false, error: { code: 'SUBAGENT_NO_PROVIDER', message: 'No privacy-eligible provider is available for this subagent.' } };
  }

  const readOnlyTools = TOOLS.filter(t => SUBAGENT_TOOLS.has(t.name));
  const transcript = [];
  let calls = 0;
  let finalSummary = '';
  const liveParent = (() => { try { return runtime.getTask(parentTask.id); } catch { return parentTask; } })();
  const remainingBudget = Number.isInteger(liveParent?.policy?.maxCalls)
    ? Math.max(0, liveParent.policy.maxCalls - (liveParent.calls || 0))
    : 6;
  if (remainingBudget <= 0) {
    return { ok: false, error: { code: 'CALL_BUDGET', message: 'Parent task has no remaining call budget for a subagent.' } };
  }
  const boundTurns = Math.max(1, Math.min(6, remainingBudget, Number(maxTurns) || 4));

  for (let step = 0; step < boundTurns; step++) {
    if (signal?.aborted) {
      return { ok: false, error: { code: 'SUBAGENT_CANCELLED', message: 'Subagent cancelled.' } };
    }
    calls += 1;
    try {
      runtime.store?.updateTask?.(parentTask.id, cur => { cur.calls = (cur.calls || 0) + 1; return cur; });
    } catch {}
    const subPrompt = [
      `Specialist role: ${spec.name}`,
      `Instructions: ${spec.instructions}`,
      `Task: ${String(prompt || '').slice(0, 4000)}`,
      transcript.length ? `Previous read-only tool observations:\n${transcript.join('\n---\n').slice(-10000)}` : '',
      step === boundTurns - 1
        ? 'This is your final turn. Return your concise, actionable summary directly (no more tool calls).'
        : 'Use read-only tools if needed, or return your concise summary directly when ready.'
    ].filter(Boolean).join('\n\n');

    const context = {
      task: {
        id: parentTask.id,
        workspace: parentTask.workspace,
        sourcePath: parentTask.sourcePath,
        workspaceKind: 'project',
        objective: subPrompt,
        planMode: true,
        calls,
        attachments: [],
        constraints: [],
        followups: [],
        execution: { enabled: false, network: false },
        policy: { maxCalls: boundTurns, maxAttempts: 1 }
      },
      history: [],
      files: [],
      tools: step === boundTurns - 1 ? [] : readOnlyTools,
      manifest: { bytes: Buffer.byteLength(subPrompt), omittedEventCount: 0, omittedFiles: [] }
    };

    let res;
    try {
      res = await provider.turn(context, { signal, ...outbound });
    } catch (err) {
      return { ok: false, error: { code: err?.code || 'SUBAGENT_ERROR', message: err?.message || 'Subagent provider call failed.' } };
    }
    if (res?.type === 'error') {
      return { ok: false, error: { code: res.code || 'SUBAGENT_ERROR', message: res.message || 'Subagent provider error.' } };
    }
    if (res?.type === 'tool' && Array.isArray(res.calls) && res.calls.length && step < boundTurns - 1) {
      for (const tc of res.calls.slice(0, 4)) {
        if (!SUBAGENT_TOOLS.has(tc.name)) {
          transcript.push(`[${tc.name}] denied: subagent is strictly read-only`);
          continue;
        }
        try {
          validateTool(tc.name, tc.args || {});
          const effectiveRules = typeof runtime._effectivePermissionRules === 'function'
            ? runtime._effectivePermissionRules(liveParent)
            : (liveParent?.permissionRules || []);
          const perm = evaluatePermission(effectiveRules, tc.name, tc.args || {});
          if (perm.action !== 'allow') {
            transcript.push(`[${tc.name}] denied by permission policy (${perm.action}${perm.reason ? `: ${perm.reason}` : ''})`);
            continue;
          }
          const toolRes = await runtime.broker._runReadOnly(parentTask, parentTask.id, tc, { signal, outbound });
          transcript.push(`[${tc.name} ${JSON.stringify(tc.args || {}).slice(0, 200)}]\n${JSON.stringify(toolRes).slice(0, 2500)}`);
        } catch (err) {
          transcript.push(`[${tc.name}] error: ${err.message}`);
        }
      }
      continue;
    }
    finalSummary = String(res?.text || '').trim();
    break;
  }

  return {
    ok: true,
    role: spec.name,
    providerId: provider.id,
    calls,
    durationMs: Date.now() - started,
    summary: (finalSummary || transcript.at(-1) || 'Subagent completed with no text output.').slice(0, 12000)
  };
}
