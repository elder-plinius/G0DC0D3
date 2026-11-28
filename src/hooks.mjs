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

async function resolveNoSymlinkFile(rootDir, segments, { requireOwnerPerms = false, onError = null } = {}) {
  try {
    const rootReal = await fs.realpath(rootDir);
    let current = rootReal;
    for (let i = 0; i < segments.length; i++) {
      current = path.join(current, segments[i]);
      const st = await fs.lstat(current);
      if (st.isSymbolicLink()) { onError?.('Symlink rejected for hooks path.'); return null; }
      const isLast = i === segments.length - 1;
      if (isLast ? !st.isFile() : !st.isDirectory()) return null;
      if (requireOwnerPerms && typeof process.getuid === 'function') {
        const forbiddenBits = isLast ? 0o022 : 0o002;
        if (st.uid !== process.getuid() || (st.mode & forbiddenBits) !== 0) {
          onError?.(`Unsafe owner/permissions on ${segments.join('/')}.`);
          return null;
        }
      }
    }
    const finalReal = await fs.realpath(current);
    if (finalReal !== rootReal && !finalReal.startsWith(rootReal + path.sep)) return null;
    return finalReal;
  } catch (err) {
    if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') onError?.(err?.message || 'Unable to inspect hooks path.');
    return null;
  }
}

async function readHooksFile(filePath, { requireOwnerPerms = false, onError = null } = {}) {
  let handle;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const st = await handle.stat();
    if (!st.isFile() || st.size > 256 * 1024) { onError?.('Hooks file is not a regular file or exceeds 256 KiB.'); return null; }
    if (requireOwnerPerms && typeof process.getuid === 'function') {
      if (st.uid !== process.getuid() || (st.mode & 0o022) !== 0) { onError?.('Hooks file has unsafe owner or group/world-writable permissions.'); return null; }
    }
    const raw = await handle.readFile('utf8');
    if (raw.length > 256 * 1024) { onError?.('Hooks file exceeds 256 KiB.'); return null; }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { onError?.('Hooks file must contain a JSON object.'); return null; }
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
  } catch (err) {
    onError?.(`Malformed hooks file: ${err?.message || 'parse error'}`);
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function discoverHooks(task, { allowProjectHooks = false } = {}) {
  // Always trust owner's home hooks (~/.g0dc0d3/hooks.json).
  // Untrusted repository hooks NEVER auto-execute on execution.enabled alone; require explicit opt-in
  // and NEVER auto-load from a writable workspace via env var when sourcePath is absent.
  const explicitOptIn = Boolean(allowProjectHooks || task?.allowProjectHooks === true);
  const canLoadSourceHooks = Boolean(
    !task?.planMode &&
    (explicitOptIn || process.env.G0D_ALLOW_PROJECT_HOOKS === '1') &&
    (allowProjectHooks || task?.execution?.enabled === true)
  );
  const candidates = [
    { root: os.homedir(), segments: ['.g0dc0d3', 'hooks.json'], requireOwnerPerms: true, ownerGlobal: true },
    ...(canLoadSourceHooks && task?.sourcePath ? [{ root: task.sourcePath, segments: ['.g0dc0d3', 'hooks.json'], requireOwnerPerms: false, ownerGlobal: false }] : []),
    ...(explicitOptIn && !task?.planMode && !task?.sourcePath && task?.workspace ? [{ root: task.workspace, segments: ['.g0dc0d3', 'hooks.json'], requireOwnerPerms: false, ownerGlobal: false }] : [])
  ];
  const seen = new Set();
  const merged = { PreToolUse: [], PostToolUse: [], loadErrors: [] };
  for (const { root, segments, requireOwnerPerms, ownerGlobal } of candidates) {
    const onError = ownerGlobal ? (msg => merged.loadErrors.push(msg)) : null;
    const safeFile = await resolveNoSymlinkFile(root, segments, { requireOwnerPerms, onError });
    if (!safeFile || seen.has(safeFile)) continue;
    seen.add(safeFile);
    const loaded = await readHooksFile(safeFile, { requireOwnerPerms, onError });
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
  const targets = toolName === 'repo.move'
    ? [String(args?.from || ''), String(args?.to || '')].filter(Boolean)
    : [toolTarget(toolName, args)];
  return hooksForEvent.filter(hook => {
    if (!globMatch(hook.tool, toolName)) return false;
    if (hook.pattern && !targets.some(t => globMatch(hook.pattern, t))) return false;
    return true;
  });
}

/**
 * Execute matching deterministic lifecycle hooks inside OS sandbox (macOS Seatbelt or Linux bwrap, network disabled).
 * Claude Code hook contract: exit code 2 on PreToolUse blocks the tool call and returns stderr to the model.
 * Any PreToolUse hook timeout, crash, cancellation, missing sandbox, or corrupt owner hooks.json fails closed.
 */
export async function runLifecycleHooks(event, task, toolName, args = {}, { signal } = {}) {
  if (!VALID_EVENTS.has(event) || !task?.workspace) {
    return { blocked: false, results: [] };
  }
  const all = await discoverHooks(task);
  if (event === 'PreToolUse' && Array.isArray(all.loadErrors) && all.loadErrors.length > 0) {
    return {
      blocked: true,
      reason: `PreToolUse owner hooks failed closed (${all.loadErrors[0]}).`,
      results: [{ event, tool: toolName, error: all.loadErrors[0] }]
    };
  }
  const matching = matchHooks(all[event], toolName, args);
  if (!matching.length) return { blocked: false, results: [] };
  if (!isSandboxSupportedPlatform()) {
    if (event === 'PreToolUse') {
      return {
        blocked: true,
        reason: 'PreToolUse hook failed closed: OS sandbox is unavailable on this platform.',
        results: [{ event, tool: toolName, error: 'ISOLATION_UNAVAILABLE' }]
      };
    }
    return { blocked: false, results: [] };
  }
  const target = toolName === 'repo.move'
    ? `${String(args?.from || '')} -> ${String(args?.to || '')}`.trim()
    : toolTarget(toolName, args);
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
      if (event === 'PreToolUse') {
        if (res.exitCode === 2) {
          return {
            blocked: true,
            reason: (res.stderr || res.stdout || `PreToolUse hook blocked ${toolName}.`).trim().slice(0, 600),
            results
          };
        }
        if (res.timedOut || res.cancelled || res.exitCode !== 0) {
          const detail = res.timedOut ? 'hook timed out' : res.cancelled ? 'hook cancelled' : `hook exited ${res.exitCode ?? 'signal ' + (res.signal || 'unknown')}`;
          return {
            blocked: true,
            reason: `PreToolUse hook failed closed (${detail})${res.stderr ? ': ' + res.stderr.trim().slice(0, 400) : '.'}`,
            results
          };
        }
      }
    } catch (err) {
      results.push({ event, tool: toolName, target, command: hook.command, error: err.message });
      if (event === 'PreToolUse') {
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
