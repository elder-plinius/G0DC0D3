import { constants as fsConstants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkProviderPrivacyAllowed, DEFAULT_PRIVACY_SETTINGS } from './privacy.mjs';
import { evaluatePermission } from './permissions.mjs';
import { scoreOverseerSuitability } from './overseer.mjs';
import { runExternalHarnessSubagent } from './pantheon-roster.mjs';
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

export async function discoverSubagents(task, runtime = null) {
  const agents = new Map(Object.entries(BUILTIN_SUBAGENTS));
  // Hydrate custom Pantheon Roster agents so agent.spawn(role: '<slug>') works seamlessly!
  try {
    const rosterRaw = runtime?.store?.getLocalState?.('pantheon_roster', []);
    if (Array.isArray(rosterRaw)) {
      for (const ag of rosterRaw) {
        if (!ag?.slug) continue;
        agents.set(ag.slug.toLowerCase(), {
          name: ag.slug.toLowerCase(),
          displayName: ag.name || ag.slug,
          description: ag.description || `Pantheon agent (${ag.name || ag.slug})`,
          model: ag.providerId || ag.harnessId || null,
          engineType: ag.engineType || 'api',
          harnessId: ag.harnessId || null,
          harnessCommand: ag.harnessCommand || null,
          autonomy: ag.autonomy || 'read_only',
          instructions: ag.instructions || `You are ${ag.name || ag.slug}, a Pantheon specialist.`,
          source: 'pantheon_roster'
        });
      }
    }
  } catch {}
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
export async function runSpecialistSubagent({ runtime, parentTask, role = 'explore', prompt, modelHint, maxTurns = 4, signal, workerId = null, onProgress = null }) {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const agents = await discoverSubagents(parentTask, runtime);
  const roleKey = String(role || 'explore').trim().toLowerCase();
  const spec = agents.get(roleKey) || BUILTIN_SUBAGENTS.explore;
  const outbound = runtime.outboundOptions();
  const privacy = outbound.privacy || DEFAULT_PRIVACY_SETTINGS;
  const wId = workerId || `${spec.name}-${started.toString(36)}`;

  // Atomic call budget reservation helper (prevents TOCTOU overrun across 4 parallel subagents!)
  const reserveCallSlot = () => {
    if (!runtime.store?.updateTask) return true;
    let allowed = false;
    try {
      runtime.store.updateTask(parentTask.id, cur => {
        if (Number.isInteger(cur?.policy?.maxCalls) && (cur.calls || 0) >= cur.policy.maxCalls) {
          allowed = false;
          return cur;
        }
        cur.calls = (cur.calls || 0) + 1;
        allowed = true;
        return cur;
      });
    } catch {
      return false;
    }
    return allowed;
  };

  // True Cross-Harness Execution ("Meta-Harness of Harnesses"):
  // Enforce BOTH localOnly and strictZdr privacy gates before spawning external cloud CLIs!
  const wantsExternalCli = (spec.engineType === 'custom_cli' || spec.engineType === 'harness')
    && (spec.harnessCommand || spec.harnessId)
    && (!spec.model || spec.autonomy === 'external_harness' || !runtime.providers.has(spec.model));
  if (wantsExternalCli) {
    if (privacy.localOnly || privacy.strictZdr) {
      outbound.onOutbound?.({
        providerId: `harness:${spec.harnessId || spec.harnessCommand}`,
        host: `cli:${spec.harnessCommand || spec.harnessId}`,
        protocol: 'external_harness',
        zdrClass: 'provider-policy',
        zdrFlags: [],
        secretsRedacted: 0,
        blocked: true,
        reason: privacy.localOnly ? 'PRIVACY_LOCAL_ONLY' : 'PRIVACY_STRICT_ZDR'
      });
    } else if (reserveCallSlot()) {
      const hLabel = spec.displayName ? `${spec.displayName} · CLI` : `${spec.harnessCommand || spec.harnessId} · CLI`;
      if (typeof onProgress === 'function') {
        try {
          onProgress({
            workerId: wId, role: spec.name, providerId: `harness:${spec.harnessId || spec.harnessCommand}`,
            modelLabel: hLabel, status: 'streaming', tool: 'cli.harness', target: spec.harnessCommand || spec.harnessId || '',
            files: [], tools: ['cli.harness'], streamTail: `Invoking external harness ${spec.harnessCommand || spec.harnessId}…`,
            startedAt, durationMs: Date.now() - started, calls: 1
          });
        } catch {}
      }
      const hRes = await runExternalHarnessSubagent({
        harnessId: spec.harnessId,
        harnessCommand: spec.harnessCommand,
        prompt,
        instructions: spec.instructions,
        workspace: parentTask.workspace || parentTask.sourcePath || null,
        signal,
        outbound,
        onProgress: ({ streamTail: tail, harnessLabel }) => {
          if (typeof onProgress === 'function') {
            try {
              onProgress({
                workerId: wId, role: spec.name, providerId: `harness:${spec.harnessId || spec.harnessCommand}`,
                modelLabel: harnessLabel || hLabel, status: 'streaming', tool: 'cli.harness', target: spec.harnessCommand || spec.harnessId || '',
                files: [], tools: ['cli.harness'], streamTail: tail, startedAt, durationMs: Date.now() - started, calls: 1
              });
            } catch {}
          }
        }
      });
      if (hRes.ok) {
        const endedAt = new Date().toISOString();
        const durationMs = Date.now() - started;
        if (typeof onProgress === 'function') {
          try {
            onProgress({
              workerId: wId, role: spec.name, providerId: `harness:${spec.harnessId || spec.harnessCommand}`,
              modelLabel: hRes.harnessLabel || hLabel, status: 'completed', tool: '', target: '',
              files: [], tools: ['cli.harness'], streamTail: hRes.output.slice(-360),
              startedAt, endedAt, durationMs, calls: 1, viaHarness: true, summary: hRes.output.slice(0, 400)
            });
          } catch {}
        }
        return {
          ok: true,
          workerId: wId,
          role: spec.name,
          providerId: `harness:${spec.harnessId || spec.harnessCommand}`,
          modelLabel: hRes.harnessLabel || hLabel,
          viaHarness: true,
          calls: 1,
          startedAt,
          endedAt,
          durationMs,
          files: [],
          tools: ['cli.harness'],
          summary: hRes.output
        };
      }
      if (signal?.aborted || hRes.code === 'HARNESS_CANCELLED') {
        return { ok: false, workerId: wId, role: spec.name, startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - started, files: [], tools: [], error: { code: 'SUBAGENT_CANCELLED', message: 'Subagent cancelled.' } };
      }
    }
  }

  const provider = selectSubagentProvider(runtime, parentTask, spec, modelHint, privacy);
  if (!provider) {
    return { ok: false, workerId: wId, role: spec.name, startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - started, files: [], tools: [], error: { code: 'SUBAGENT_NO_PROVIDER', message: 'No privacy-eligible provider is available for this subagent.' } };
  }
  const modelLabel = provider.label || provider.model || provider.id;
  const filesTouched = new Set();
  const toolsUsed = [];
  let streamTail = '';
  let lastTool = '';
  let lastTarget = '';
  const emitProgress = (status, extra = {}) => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress({
        workerId: wId,
        role: spec.name,
        providerId: provider.id,
        modelLabel,
        status,
        tool: lastTool,
        target: lastTarget,
        files: [...filesTouched].slice(0, 12),
        tools: toolsUsed.slice(-12),
        streamTail: streamTail.slice(-360),
        startedAt,
        durationMs: Date.now() - started,
        ...extra,
      });
    } catch {}
  };

  const readOnlyTools = TOOLS.filter(t => SUBAGENT_TOOLS.has(t.name));
  const transcript = [];
  const steerNotes = [];
  let calls = 0;
  let finalSummary = '';
  const liveParent = (() => { try { return runtime.getTask(parentTask.id); } catch { return parentTask; } })();
  const remainingBudget = Number.isInteger(liveParent?.policy?.maxCalls)
    ? Math.max(0, liveParent.policy.maxCalls - (liveParent.calls || 0))
    : 6;
  if (remainingBudget <= 0) {
    return { ok: false, workerId: wId, role: spec.name, providerId: provider.id, modelLabel, startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - started, files: [], tools: [], error: { code: 'CALL_BUDGET', message: 'Parent task has no remaining call budget for a subagent.' } };
  }
  const boundTurns = Math.max(1, Math.min(6, remainingBudget, Number(maxTurns) || 4));
  emitProgress('thinking', { calls: 0, step: 1, maxTurns: boundTurns });

  for (let step = 0; step < boundTurns; step++) {
    if (signal?.aborted) {
      emitProgress('failed', { calls, error: 'Subagent cancelled.' });
      return { ok: false, workerId: wId, role: spec.name, providerId: provider.id, modelLabel, calls, startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - started, files: [...filesTouched], tools: toolsUsed, error: { code: 'SUBAGENT_CANCELLED', message: 'Subagent cancelled.' } };
    }
    const freshSteers = runtime.drainWorkerSteer?.(parentTask.id, wId) || [];
    if (freshSteers.length) steerNotes.push(...freshSteers);
    if (!reserveCallSlot()) {
      if (calls === 0) {
        emitProgress('failed', { calls: 0, error: 'Parent task call budget exhausted.' });
        return { ok: false, workerId: wId, role: spec.name, providerId: provider.id, modelLabel, calls: 0, startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - started, files: [...filesTouched], tools: toolsUsed, error: { code: 'CALL_BUDGET', message: 'Parent task has no remaining call budget for a subagent.' } };
      }
      break;
    }
    calls += 1;
    const subPrompt = [
      `Specialist role: ${spec.name}`,
      `Instructions: ${spec.instructions}`,
      `Task: ${String(prompt || '').slice(0, 4000)}`,
      steerNotes.length ? `Live operator steering notes:\n- ${steerNotes.join('\n- ')}` : '',
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

    lastTool = '';
    lastTarget = '';
    emitProgress('streaming', { calls, step: step + 1, maxTurns: boundTurns });
    let lastDeltaAt = 0;
    const onDelta = (delta) => {
      if (delta?.type === 'text' && delta.text) {
        streamTail = (streamTail + delta.text).slice(-600);
        const now = Date.now();
        if (now - lastDeltaAt >= 180) {
          lastDeltaAt = now;
          emitProgress('streaming', { calls, step: step + 1, maxTurns: boundTurns });
        }
      }
    };

    let res;
    try {
      res = await provider.turn(context, { signal, onDelta, ...outbound });
    } catch (err) {
      emitProgress('failed', { calls, error: err?.message || 'Subagent provider call failed.' });
      return { ok: false, workerId: wId, role: spec.name, providerId: provider.id, modelLabel, calls, startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - started, files: [...filesTouched], tools: toolsUsed, error: { code: err?.code || 'SUBAGENT_ERROR', message: err?.message || 'Subagent provider call failed.' } };
    }
    if (res?.type === 'error') {
      emitProgress('failed', { calls, error: res.message || 'Subagent provider error.' });
      return { ok: false, workerId: wId, role: spec.name, providerId: provider.id, modelLabel, calls, startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - started, files: [...filesTouched], tools: toolsUsed, error: { code: res.code || 'SUBAGENT_ERROR', message: res.message || 'Subagent provider error.' } };
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
          lastTool = tc.name;
          lastTarget = String(tc.args?.path || tc.args?.pattern || tc.args?.query || '').slice(0, 120);
          toolsUsed.push(tc.name);
          if (typeof tc.args?.path === 'string' && tc.args.path.trim()) filesTouched.add(tc.args.path.trim());
          emitProgress('tool', { calls, step: step + 1, maxTurns: boundTurns });
          const toolRes = await runtime.broker._runReadOnly(parentTask, parentTask.id, tc, { signal, outbound });
          if (Array.isArray(toolRes?.files)) {
            for (const f of toolRes.files.slice(0, 4)) {
              const p = typeof f === 'string' ? f : f?.path;
              if (p) filesTouched.add(p);
            }
          }
          transcript.push(`[${tc.name} ${JSON.stringify(tc.args || {}).slice(0, 200)}]\n${JSON.stringify(toolRes).slice(0, 2500)}`);
        } catch (err) {
          transcript.push(`[${tc.name}] error: ${err.message}`);
        }
      }
      continue;
    }
    finalSummary = String(res?.text || '').trim();
    if (finalSummary) streamTail = finalSummary.slice(-600);
    break;
  }

  const endedAt = new Date().toISOString();
  const durationMs = Date.now() - started;
  const summary = (finalSummary || transcript.at(-1) || 'Subagent completed with no text output.').slice(0, 12000);
  emitProgress('completed', { calls, durationMs, endedAt, summary: summary.slice(0, 400) });
  return {
    ok: true,
    workerId: wId,
    role: spec.name,
    providerId: provider.id,
    modelLabel,
    calls,
    startedAt,
    endedAt,
    durationMs,
    files: [...filesTouched].slice(0, 24),
    tools: toolsUsed.slice(-24),
    summary
  };
}
