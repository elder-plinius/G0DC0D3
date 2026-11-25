import { constants as fsConstants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { globMatch, toolTarget } from './permissions.mjs';
import { isSandboxSupportedPlatform, runCommand } from './runner.mjs';

const VALID_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
const MAX_HOOKS_PER_EVENT = 16;
const MAX_HOOK_TIMEOUT_MS = 15000;

function normalizeHookEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const tool = typeof raw.tool === 'string' && raw.tool.trim()
    ? raw.tool.trim()
    : typeof raw.matcher === 'string' && raw.matcher.trim()
      ? raw.matcher.trim()
      : '*';
  const command = typeof raw.command === 'string' ? raw.command.trim() : '';
  if (!command || command.length > 4000 || command.includes('\0')) return null;
  const pattern = typeof raw.pattern === 'string' && raw.pattern.trim() ? raw.pattern.trim() : undefined;
  const timeoutMs = Number.isInteger(raw.timeoutMs) && raw.timeoutMs >= 100 && raw.timeoutMs <= MAX_HOOK_TIMEOUT_MS
    ? raw.timeoutMs
    : 5000;
  return { tool, ...(pattern ? { pattern } : {}), command, timeoutMs };
}

async function resolveNoSymlinkFile(rootDir, segments, { requireOwnerPerms = false } = {}) {
  try {
    const rootReal = await fs.realpath(rootDir);
    let current = rootReal;
    for (let i = 0; i < segments.length; i++) {
      current = path.join(current, segments[i]);
      const st = await fs.lstat(current);
      if (st.isSymbolicLink()) return null;
      const isLast = i === segments.length - 1;
      if (isLast ? !st.isFile() : !st.isDirectory()) return null;
      if (requireOwnerPerms && typeof process.getuid === 'function') {
        if (st.uid !== process.getuid() || (st.mode & 0o022) !== 0) return null;
      }
    }
    const finalReal = await fs.realpath(current);
    if (finalReal !== rootReal && !finalReal.startsWith(rootReal + path.sep)) return null;
    return finalReal;
  } catch {
    return null;
  }
}

async function readHooksFile(filePath, { requireOwnerPerms = false } = {}) {
  let handle;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const st = await handle.stat();
    if (!st.isFile() || st.size > 256 * 1024) return null;
    if (requireOwnerPerms && typeof process.getuid === 'function') {
      if (st.uid !== process.getuid() || (st.mode & 0o022) !== 0) return null;
    }
    const raw = await handle.readFile('utf8');
    if (raw.length > 256 * 1024) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const container = parsed.hooks && typeof parsed.hooks === 'object' ? parsed.hooks : parsed;
    const out = { PreToolUse: [], PostToolUse: [] };
    for (const event of VALID_EVENTS) {
      const list = Array.isArray(container[event]) ? container[event] : [];
      for (const item of list) {
        if (out[event].length >= MAX_HOOKS_PER_EVENT) break;
        // Support both flat G0DC0D3 entries and Claude Code nested { matcher, hooks: [{ type:'command', command }] } entries.
        if (Array.isArray(item?.hooks)) {
          for (const inner of item.hooks) {
            if (out[event].length >= MAX_HOOKS_PER_EVENT) break;
            const norm = normalizeHookEntry({ ...inner, matcher: item.matcher || inner?.matcher || '*' });
            if (norm) out[event].push(norm);
          }
        } else {
          const norm = normalizeHookEntry(item);
          if (norm) out[event].push(norm);
        }
      }
    }
    return out;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function discoverHooks(task, { allowProjectHooks = false } = {}) {
  // Always trust owner's home hooks (~/.g0dc0d3/hooks.json).
  // Untrusted repository hooks NEVER auto-execute on execution.enabled alone; require explicit opt-in
  // (allowProjectHooks or G0D_ALLOW_PROJECT_HOOKS=1) and never load from writable workspace when sourcePath exists.
  const canLoadProjectHooks = Boolean(
    !task?.planMode &&
    (allowProjectHooks || task?.allowProjectHooks === true || process.env.G0D_ALLOW_PROJECT_HOOKS === '1') &&
    (allowProjectHooks || task?.execution?.enabled === true)
  );
  const candidates = [
    { root: os.homedir(), segments: ['.g0dc0d3', 'hooks.json'], requireOwnerPerms: true },
    ...(canLoadProjectHooks && task?.sourcePath ? [{ root: task.sourcePath, segments: ['.g0dc0d3', 'hooks.json'], requireOwnerPerms: false }] : []),
    ...(canLoadProjectHooks && !task?.sourcePath && task?.workspace ? [{ root: task.workspace, segments: ['.g0dc0d3', 'hooks.json'], requireOwnerPerms: false }] : [])
  ];
  const seen = new Set();
  const merged = { PreToolUse: [], PostToolUse: [] };
  for (const { root, segments, requireOwnerPerms } of candidates) {
    const safeFile = await resolveNoSymlinkFile(root, segments, { requireOwnerPerms });
    if (!safeFile || seen.has(safeFile)) continue;
    seen.add(safeFile);
    const loaded = await readHooksFile(safeFile, { requireOwnerPerms });
    if (!loaded) continue;
    for (const event of VALID_EVENTS) {
      for (const hook of loaded[event]) {
        if (merged[event].length < MAX_HOOKS_PER_EVENT) merged[event].push({ ...hook, source: safeFile });
      }
    }
  }
  return merged;
}

export function matchHooks(hooksForEvent, toolName, args = {}) {
  if (!Array.isArray(hooksForEvent) || !hooksForEvent.length) return [];
  const target = toolTarget(toolName, args);
  return hooksForEvent.filter(hook => {
    if (!globMatch(hook.tool, toolName)) return false;
    if (hook.pattern && !globMatch(hook.pattern, target)) return false;
    return true;
  });
}

/**
 * Execute matching deterministic lifecycle hooks inside OS sandbox (macOS Seatbelt or Linux bwrap, network disabled).
 * Claude Code hook contract: exit code 2 on PreToolUse blocks the tool call and returns stderr to the model.
 */
export async function runLifecycleHooks(event, task, toolName, args = {}, { signal } = {}) {
  if (!VALID_EVENTS.has(event) || !task?.workspace || !isSandboxSupportedPlatform()) {
    return { blocked: false, results: [] };
  }
  const all = await discoverHooks(task);
  const matching = matchHooks(all[event], toolName, args);
  if (!matching.length) return { blocked: false, results: [] };
  const target = toolTarget(toolName, args);
  const results = [];
  for (const hook of matching) {
    try {
      const res = await runCommand(
        { workspace: task.workspace, execution: { enabled: true, network: false, timeoutMs: hook.timeoutMs } },
        { command: hook.command, timeoutMs: hook.timeoutMs },
        {
          signal,
          extraEnv: {
            G0D_HOOK_EVENT: String(event),
            G0D_HOOK_TOOL: String(toolName),
            G0D_HOOK_TARGET: String(target).slice(0, 2048),
          }
        }
      );
      const entry = {
        event,
        tool: toolName,
        target,
        command: hook.command,
        exitCode: res.exitCode,
        stdout: (res.stdout || '').slice(0, 2000),
        stderr: (res.stderr || '').slice(0, 2000),
        timedOut: Boolean(res.timedOut)
      };
      results.push(entry);
      if (event === 'PreToolUse' && res.exitCode === 2) {
        return {
          blocked: true,
          reason: (res.stderr || res.stdout || `PreToolUse hook blocked ${toolName}.`).trim().slice(0, 600),
          results
        };
      }
    } catch (err) {
      results.push({ event, tool: toolName, target, command: hook.command, error: err.message });
      if (event === 'PreToolUse' && err?.code !== 'EXECUTION_CANCELLED') {
        return {
          blocked: true,
          reason: `PreToolUse hook failed closed (${err.message || 'error'}).`,
          results
        };
      }
    }
  }
  return { blocked: false, results };
}
