import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { readBoundedFile, scopedPath, sha256 } from './broker.mjs';
import { evaluatePermission, HARD_DENY_SHELL_RULES, STRICT_DEFAULT_PRESET } from './permissions.mjs';
import { checkTargetScope, CLI_NO_TELEMETRY_ENV, DEFAULT_PRIVACY_SETTINGS, environmentSecrets, redactDiagnostics, redactOutboundText } from './privacy.mjs';
import { runCommand } from './runner.mjs';

const ACP_PROTOCOL_VERSION = 1;
const MAX_STDERR_BYTES = 8192;
const MAX_WRITE_BYTES = 256 * 1024;
const MAX_TERMINAL_OUTPUT_BYTES = 65536;
const MAX_ACTIVE_TERMINALS = 4;
const MAX_TRACKED_TERMINALS = 16;
const MAX_STDOUT_LINE_BYTES = 16 * 1024 * 1024;
const MAX_PROMPT_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_PROMPT_THOUGHT_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_TOOL_CALLS = 500;
const DEFAULT_RPC_TIMEOUT_MS = 30000;
const DEFAULT_PROMPT_TIMEOUT_MS = 180000;
const CANCEL_GRACE_MS = 1500;

export const ACP_HARNESS_SPECS = Object.freeze([
  Object.freeze({
    id: 'antigravity-cli',
    acpId: 'acp:antigravity',
    label: 'Google Antigravity',
    binary: 'agy',
    envOverride: 'G0D_ANTIGRAVITY_BINARY',
    args: Object.freeze(['acp', '--disable-telemetry']),
    nativeAcp: true,
    defaultModel: 'gemini-4-neon-high',
  }),
  Object.freeze({
    id: 'claude-code',
    acpId: 'acp:claude-code',
    label: 'Claude Code',
    binary: 'claude-code-acp',
    envOverride: 'G0D_CLAUDE_ACP_BINARY',
    args: Object.freeze([]),
    nativeAcp: true,
    defaultModel: 'claude-sonnet-5-5',
  }),
  Object.freeze({
    id: 'codex-cli',
    acpId: 'acp:codex',
    label: 'Codex CLI',
    binary: 'codex-acp',
    envOverride: 'G0D_CODEX_ACP_BINARY',
    args: Object.freeze([]),
    nativeAcp: true,
    defaultModel: 'gpt-5.4',
  }),
  Object.freeze({
    id: 'gemini-cli',
    acpId: 'acp:gemini',
    label: 'Gemini CLI',
    binary: 'gemini',
    envOverride: 'G0D_GEMINI_BINARY',
    args: Object.freeze(['--experimental-acp']),
    nativeAcp: true,
    defaultModel: 'gemini-2.5-pro',
  }),
  Object.freeze({
    id: 'opencode',
    acpId: 'acp:opencode',
    label: 'OpenCode',
    binary: 'opencode',
    envOverride: 'G0D_OPENCODE_BINARY',
    args: Object.freeze(['acp']),
    nativeAcp: true,
    defaultModel: 'default',
  }),
]);

function minimalSafeEnv(source = process.env) {
  const allow = new Set(['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'TZ', 'TERM', 'COLORTERM', 'NO_COLOR', 'CI', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']);
  const out = Object.fromEntries(Object.entries(source || {}).filter(([k]) => allow.has(k) || /^LC_[A-Z_]+$/.test(k)));
  return { ...out, ...CLI_NO_TELEMETRY_ENV };
}

async function resolveExecutable(binary, env = process.env) {
  if (!binary || typeof binary !== 'string') return null;
  if (binary.includes('/') || binary.includes('\\')) {
    try {
      await fs.access(binary, fsConstants.X_OK ?? 1);
      return binary;
    } catch {
      return null;
    }
  }
  const home = env.HOME || process.env.HOME || '';
  const searchDirs = [
    ...String(env.PATH || process.env.PATH || '').split(path.delimiter).filter(Boolean),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...(home ? [path.join(home, '.local', 'bin'), path.join(home, '.cargo', 'bin'), path.join(home, '.npm-global', 'bin')] : []),
  ];
  const seen = new Set();
  for (const dir of searchDirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const candidate = path.join(dir, binary);
    try {
      await fs.access(candidate, fsConstants.X_OK ?? 1);
      return candidate;
    } catch {}
  }
  return null;
}

/** Passively discovers installed ACP-capable CLI harnesses without executing them. */
export async function discoverAcpHarnesses({ env = process.env, binaryOverrides = {} } = {}) {
  const results = [];
  for (const spec of ACP_HARNESS_SPECS) {
    const requested = binaryOverrides[spec.id] || env[spec.envOverride] || spec.binary;
    const resolvedPath = await resolveExecutable(requested, env);
    results.push({
      id: spec.id,
      acpId: spec.acpId,
      label: spec.label,
      binary: requested,
      resolvedPath,
      args: [...spec.args],
      installed: Boolean(resolvedPath),
      protocol: 'acp-v1',
      defaultModel: spec.defaultModel,
    });
  }
  return results;
}

function classifyAcpError(message = '', stderr = '') {
  const combined = `${message}\n${stderr}`;
  if (/quota\s+reached|third-party\s+quota|daily\s+limit\s+reached|resets?\s+in\s+\d+\s*[mh]/i.test(combined)) {
    const resetMatch = combined.match(/resets?\s+in\s+[0-9]+[mh](?:[0-9]+[ms])?/i);
    const hint = resetMatch ? ` (${resetMatch[0]})` : '';
    return Object.assign(new Error(`ACP harness quota reached${hint}. Switch models or wait before retrying.`), {
      code: 'quota_exhausted',
      retryable: true,
      quotaExhausted: true,
      retryAfterMs: 300000,
    });
  }
  if (/429|rate[\s_-]?limit|too many requests|resource_exhausted|overloaded|temporarily unavailable/i.test(combined)) {
    return Object.assign(new Error('ACP harness is temporarily rate-limited or overloaded.'), {
      code: 'rate_limit',
      retryable: true,
      retryAfterMs: 2500,
    });
  }
  if (/not logged in|unauthenticated|sign[\s-]?in|login required|expired token|invalid credentials/i.test(combined)) {
    return Object.assign(new Error('ACP harness authentication required. Sign in to the CLI and retry.'), {
      code: 'provider_configuration',
      retryable: false,
    });
  }
  const safeMsg = redactDiagnostics(String(message || 'ACP request failed.').slice(0, 400));
  return Object.assign(new Error(safeMsg), {
    code: 'acp_error',
    retryable: true,
  });
}

function effectiveAcpRules(permissionRules) {
  const base = Array.isArray(permissionRules) && permissionRules.length > 0
    ? permissionRules
    : STRICT_DEFAULT_PRESET;
  // evaluatePermission is last-match-wins, so HARD_DENY_SHELL_RULES MUST come last!
  return [...base, ...HARD_DENY_SHELL_RULES];
}

function mapAcpKindToTool(toolCall = {}) {
  const kind = String(toolCall.kind || '').trim().toLowerCase();
  // First pass: check ACP canonical `kind` exhaustively (never let title override kind).
  if (kind) {
    if (kind === 'execute') return 'process.run';
    if (kind === 'delete') return 'repo.delete';
    if (kind === 'move') return 'repo.move';
    if (kind === 'edit') return 'repo.write';
    if (kind === 'fetch') return 'web.fetch';
    if (kind === 'read') return 'repo.read';
    if (kind === 'search') return 'repo.search';
    return 'process.run';
  }
  // Fallback: only match strict anchored tool names (never free-form title), mutating/exec first.
  const name = String(toolCall.name || '').trim().toLowerCase();
  if (/^(?:run_command|bash|shell|terminal|exec|process\.run)$/.test(name)) return 'process.run';
  if (/^(?:delete_file|remove_file|rm|repo\.delete)$/.test(name)) return 'repo.delete';
  if (/^(?:move_file|rename_file|mv|repo\.move)$/.test(name)) return 'repo.move';
  if (/^(?:write_file|edit_file|replace_file_content|multi_replace_file_content|patch_file|repo\.write|repo\.patch)$/.test(name)) return 'repo.write';
  if (/^(?:web_fetch|fetch_url|web_search|http_request|web\.fetch|web\.search)$/.test(name)) return 'web.fetch';
  if (/^(?:read_file|view_file|repo\.read)$/.test(name)) return 'repo.read';
  if (/^(?:grep_search|find_by_name|list_dir|glob|repo\.search|repo\.list|repo\.glob)$/.test(name)) return 'repo.search';
  return 'process.run';
}

function extractAcpPaths(toolCall = {}) {
  const raw = toolCall.rawInput || toolCall.args || {};
  const found = [];
  const push = (val) => {
    if (typeof val === 'string' && val.trim()) {
      const trimmed = val.trim();
      let cleaned = trimmed;
      if (trimmed.startsWith('file://')) {
        try { cleaned = decodeURIComponent(trimmed.slice(7)); } catch { return; }
      }
      if (cleaned) found.push(cleaned);
    }
  };
  for (const key of ['path', 'Path', 'file_path', 'TargetFile', 'filePath', 'uri', 'from', 'to', 'source', 'destination', 'old_path', 'new_path', 'oldPath', 'newPath', 'dir', 'directory', 'SearchPath', 'SearchDirectory', 'DirectoryPath', 'cwd']) {
    push(raw[key]);
  }
  if (Array.isArray(raw.paths)) raw.paths.forEach(push);
  if (Array.isArray(raw.files)) raw.files.forEach(f => push(typeof f === 'string' ? f : f?.path));
  if (Array.isArray(toolCall.locations)) {
    for (const loc of toolCall.locations) push(loc?.path || loc?.uri);
  }
  return [...new Set(found)];
}

function extractAcpUrl(toolCall = {}) {
  const raw = toolCall.rawInput || toolCall.args || {};
  for (const key of ['url', 'Url', 'uri', 'href', 'endpoint']) {
    if (typeof raw[key] === 'string' && /^https?:\/\//i.test(raw[key].trim())) return raw[key].trim();
  }
  return null;
}

function resolveWorkspaceRelative(workspace, rawPath) {
  if (!workspace || !rawPath || typeof rawPath !== 'string') return null;
  if (rawPath.includes('\0') || rawPath.includes('\\')) return null;
  const resolvedWs = path.resolve(workspace);
  const abs = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(resolvedWs, rawPath);
  const rel = path.relative(resolvedWs, abs);
  if (!rel || rel === '.') return '.';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function hasProtectedSegment(rel) {
  if (!rel || rel === '.') return false;
  return rel.split('/').some(seg => {
    const low = seg.toLowerCase();
    return low === '.git' || low === '.g0dc0d3' || low === 'node_modules' || low.startsWith('.g0d-write-');
  });
}

function selectPermissionOption(options = [], allow = false) {
  if (!Array.isArray(options) || !options.length) {
    return { outcome: 'cancelled' };
  }
  if (allow) {
    // Strictly select allow_once only — NEVER allow_always or arbitrary regexes.
    const pick = options.find(o => o?.kind === 'allow_once');
    if (pick?.optionId) return { outcome: 'selected', optionId: pick.optionId };
    return { outcome: 'cancelled' };
  }
  const pick = options.find(o => o?.kind === 'reject_once')
    || options.find(o => o?.kind === 'reject_always');
  if (pick?.optionId) return { outcome: 'selected', optionId: pick.optionId };
  return { outcome: 'cancelled' };
}

function shellQuote(arg) {
  return `'${String(arg).replaceAll("'", "'\\''")}'`;
}

function trimUtf8Tail(buf, maxBytes) {
  if (buf.length <= maxBytes) return buf;
  let start = buf.length - maxBytes;
  // Advance past any UTF-8 continuation bytes (10xxxxxx) so we never split a multi-byte character.
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return buf.subarray(start);
}

async function ensureSafeParentDirs(canonicalWs, rel) {
  const parts = rel.split('/');
  if (parts.length <= 1) return;
  let current = canonicalWs;
  for (let i = 0; i < parts.length - 1; i++) {
    current = path.join(current, parts[i]);
    try {
      const st = await fs.lstat(current);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw Object.assign(new Error('Parent path is a symlink or non-directory.'), { code: -32001 });
      }
    } catch (err) {
      if (err?.code === 'ENOENT') {
        await fs.mkdir(current, { mode: 0o755 });
        const st = await fs.lstat(current);
        if (st.isSymbolicLink() || !st.isDirectory()) {
          throw Object.assign(new Error('Created parent path was replaced by symlink.'), { code: -32001 });
        }
      } else {
        throw err;
      }
    }
  }
}

function sanitizeRpcClientError(err) {
  const numericCode = typeof err?.code === 'number' ? err.code : -32000;
  if (err?.code === 'ENOENT') return { code: -32004, message: 'File not found in scoped workspace.' };
  if (err?.code === 'PATH_DENIED' || err?.code === 'SYMLINK_DENIED' || err?.code === 'WORKSPACE_CHANGED') {
    return { code: -32001, message: 'Access denied: path outside scoped workspace or symlink blocked.' };
  }
  if (err?.code === 'READ_LIMIT') return { code: -32002, message: 'File exceeds 256 KiB UTF-8 text limit.' };
  const safe = redactDiagnostics(String(err?.message || 'Workspace RPC error.'))
    .replace(/\/(?:Users|home|private|var|tmp)\/[^\s'"]+/g, '<path>')
    .slice(0, 300);
  return { code: numericCode, message: safe };
}

/**
 * Builds an ACP `session/request_permission` handler backed by G0DC0D3's
 * security boundaries: planner-only lock, Plan Mode lock, workspace scoping, target scope, and permission rules.
 */
export function createAcpPermissionHandler({
  mode = 'planner',
  workspace = null,
  planMode = false,
  permissionRules = null,
  privacy = DEFAULT_PRIVACY_SETTINGS,
  onPermissionDecision = null,
} = {}) {
  const rules = effectiveAcpRules(permissionRules);

  return async (params = {}) => {
    const toolCall = params.toolCall || {};
    const options = Array.isArray(params.options) ? params.options : [];
    const mappedTool = mapAcpKindToTool(toolCall);

    // Planner-only mode: child ACP server is NEVER allowed to mutate files or run commands.
    if (mode === 'planner') {
      const outcome = selectPermissionOption(options, false);
      onPermissionDecision?.({ allowed: false, reason: 'planner_only_bridge', tool: mappedTool, toolCall });
      return { outcome };
    }

    // Plan Mode hard lock: strictly block mutating, execution, and network fetch tools.
    if (planMode && ['repo.write', 'repo.patch', 'repo.delete', 'repo.move', 'process.run', 'web.fetch'].includes(mappedTool)) {
      const outcome = selectPermissionOption(options, false);
      onPermissionDecision?.({ allowed: false, reason: 'plan_mode_readonly', tool: mappedTool, toolCall });
      return { outcome };
    }

    // Web fetch SSRF & Rules-of-Engagement scope enforcement.
    if (mappedTool === 'web.fetch') {
      if (privacy?.localOnly) {
        const outcome = selectPermissionOption(options, false);
        onPermissionDecision?.({ allowed: false, reason: 'local_only_network_denied', tool: mappedTool, toolCall });
        return { outcome };
      }
      const targetUrl = extractAcpUrl(toolCall);
      if (!targetUrl) {
        const outcome = selectPermissionOption(options, false);
        onPermissionDecision?.({ allowed: false, reason: 'web_fetch_missing_url', tool: mappedTool, toolCall });
        return { outcome };
      }
      const scope = checkTargetScope(targetUrl, privacy || DEFAULT_PRIVACY_SETTINGS);
      if (!scope.allowed) {
        const outcome = selectPermissionOption(options, false);
        onPermissionDecision?.({ allowed: false, reason: scope.reason || 'target_scope_denied', tool: mappedTool, targetUrl, toolCall });
        return { outcome };
      }
      // Require an explicit web.fetch allow rule (never silently allow unsandboxed host fetches).
      const explicitAllow = Array.isArray(permissionRules) && permissionRules.some(r => r?.tool === 'web.fetch' && r?.action === 'allow');
      const verdict = explicitAllow ? evaluatePermission(rules, 'web.fetch', { url: targetUrl }) : { action: 'deny', reason: 'web_fetch_requires_explicit_rule' };
      const allowed = verdict.action === 'allow';
      const outcome = selectPermissionOption(options, allowed);
      onPermissionDecision?.({ allowed, reason: verdict.reason || verdict.action, tool: mappedTool, targetUrl, toolCall });
      return { outcome };
    }

    // Workspace boundary enforcement for all file & search operations (fail closed).
    const fileTools = ['repo.read', 'repo.write', 'repo.delete', 'repo.move', 'repo.search'];
    const extractedPaths = extractAcpPaths(toolCall);
    const resolvedRels = [];
    if (workspace && fileTools.includes(mappedTool)) {
      if (!extractedPaths.length) {
        const outcome = selectPermissionOption(options, false);
        onPermissionDecision?.({ allowed: false, reason: 'missing_target_path_denied', tool: mappedTool, toolCall });
        return { outcome };
      }
      const canonicalWs = await fs.realpath(workspace).catch(() => null);
      if (!canonicalWs) {
        const outcome = selectPermissionOption(options, false);
        onPermissionDecision?.({ allowed: false, reason: 'workspace_unresolved', tool: mappedTool, toolCall });
        return { outcome };
      }
      for (const targetPath of extractedPaths) {
        const rel = resolveWorkspaceRelative(canonicalWs, targetPath) || resolveWorkspaceRelative(workspace, targetPath);
        if (!rel || hasProtectedSegment(rel)) {
          const outcome = selectPermissionOption(options, false);
          onPermissionDecision?.({ allowed: false, reason: 'workspace_boundary_denied', tool: mappedTool, targetPath, toolCall });
          return { outcome };
        }
        if (mappedTool === 'repo.search') {
          if (rel !== '.') {
            const abs = path.join(canonicalWs, rel);
            const real = await fs.realpath(abs).catch(() => null);
            if (!real || (real !== canonicalWs && !real.startsWith(canonicalWs + path.sep))) {
              const outcome = selectPermissionOption(options, false);
              onPermissionDecision?.({ allowed: false, reason: 'search_boundary_denied', tool: mappedTool, targetPath, toolCall });
              return { outcome };
            }
          }
        } else {
          if (rel === '.') {
            const outcome = selectPermissionOption(options, false);
            onPermissionDecision?.({ allowed: false, reason: 'workspace_root_file_op_denied', tool: mappedTool, targetPath, toolCall });
            return { outcome };
          }
          try {
            await scopedPath(canonicalWs, rel, { writing: mappedTool !== 'repo.read' });
          } catch {
            const outcome = selectPermissionOption(options, false);
            onPermissionDecision?.({ allowed: false, reason: 'scoped_path_denied', tool: mappedTool, targetPath, toolCall });
            return { outcome };
          }
        }
        resolvedRels.push(rel);
      }
    }

    const args = toolCall.rawInput || toolCall.args || {};
    let normalizedArgs = {};
    if (mappedTool === 'process.run') {
      normalizedArgs = { command: String(args.command || args.CommandLine || toolCall.title || '') };
    } else if (mappedTool === 'repo.move') {
      normalizedArgs = { from: resolvedRels[0] || '', to: resolvedRels[1] || resolvedRels[0] || '' };
    } else if (resolvedRels.length) {
      normalizedArgs = { path: resolvedRels[0] };
    }

    const verdict = evaluatePermission(rules, mappedTool, normalizedArgs);
    const allowed = verdict.action === 'allow';
    const outcome = selectPermissionOption(options, allowed);
    onPermissionDecision?.({ allowed, reason: verdict.reason || verdict.action, tool: mappedTool, targetPaths: resolvedRels, toolCall });
    return { outcome };
  };
}

/**
 * Builds G0DC0D3-mediated ACP client capability handlers (`fs/*` and `terminal/*`)
 * so child ACP agents read/write strictly within the scoped workspace and run commands
 * inside G0DC0D3's OS-level macOS Seatbelt / Linux bwrap sandbox.
 */
export function createAcpSandboxHandlers({
  workspace,
  execution = { enabled: false, network: false, timeoutMs: 30000 },
  planMode = false,
  permissionRules = null,
  privacy = DEFAULT_PRIVACY_SETTINGS,
  extraSecrets = null,
  onFileModified = null,
  onTerminalEvent = null,
} = {}) {
  const rules = effectiveAcpRules(permissionRules);
  const secrets = extraSecrets || environmentSecrets();
  const shouldRedact = privacy?.redactOutboundSecrets !== false;
  const terminals = new Map();
  const modifiedFiles = new Map();
  let disposed = false;

  const cleanupTerminals = () => {
    disposed = true;
    for (const term of terminals.values()) {
      try { term.controller.abort(); } catch {}
    }
    terminals.clear();
  };

  const activeTerminalCount = () => {
    let count = 0;
    for (const term of terminals.values()) {
      if (!term.exitStatus) count++;
    }
    return count;
  };

  const pruneTrackedTerminals = () => {
    while (terminals.size >= MAX_TRACKED_TERMINALS) {
      let oldestExited = null;
      for (const [id, term] of terminals.entries()) {
        if (term.exitStatus) { oldestExited = id; break; }
      }
      if (!oldestExited) break;
      terminals.delete(oldestExited);
    }
  };

  return {
    modifiedFiles,
    cleanupTerminals,

    async readTextFile(params = {}) {
      if (!workspace) throw Object.assign(new Error('No workspace bound for fs/read_text_file.'), { code: -32602 });
      const canonicalWs = await fs.realpath(workspace);
      const rel = resolveWorkspaceRelative(canonicalWs, params.path) || resolveWorkspaceRelative(workspace, params.path);
      if (!rel || rel === '.' || hasProtectedSegment(rel)) {
        throw Object.assign(new Error('Path is outside the scoped workspace.'), { code: -32001 });
      }
      const verdict = evaluatePermission(rules, 'repo.read', { path: rel });
      if (verdict.action !== 'allow') {
        throw Object.assign(new Error(`Permission denied for read of ${rel}.`), { code: -32003 });
      }
      const inspected = await scopedPath(canonicalWs, rel, { withStat: true });
      if (!inspected?.stat) {
        throw Object.assign(new Error('File not found in scoped workspace.'), { code: -32004 });
      }
      const realParent = await fs.realpath(path.dirname(inspected.target));
      if (realParent !== canonicalWs && !realParent.startsWith(canonicalWs + path.sep)) {
        throw Object.assign(new Error('Parent directory escapes scoped workspace.'), { code: -32001 });
      }
      const buf = await readBoundedFile(inspected.target, MAX_WRITE_BYTES, 'READ_LIMIT', { expectedIdentity: inspected.stat });
      let text = buf.toString('utf8');
      if (text.includes('\0')) throw Object.assign(new Error('Binary files cannot be read as UTF-8 text.'), { code: -32002 });
      const startLine = Number.isInteger(params.line) && params.line >= 1 ? params.line : null;
      const limit = Number.isInteger(params.limit) && params.limit >= 1 ? params.limit : null;
      if (startLine !== null || limit !== null) {
        const lines = text.split('\n');
        const from = (startLine ?? 1) - 1;
        const to = limit !== null ? from + limit : lines.length;
        text = lines.slice(from, to).join('\n');
      }
      if (shouldRedact) text = redactOutboundText(text, secrets).text;
      return { content: text };
    },

    async writeTextFile(params = {}) {
      if (!workspace) throw Object.assign(new Error('No workspace bound for fs/write_text_file.'), { code: -32602 });
      if (planMode) throw Object.assign(new Error('File writes are blocked in Plan Mode.'), { code: -32003 });
      const canonicalWs = await fs.realpath(workspace);
      const rel = resolveWorkspaceRelative(canonicalWs, params.path) || resolveWorkspaceRelative(workspace, params.path);
      if (!rel || rel === '.' || hasProtectedSegment(rel)) {
        throw Object.assign(new Error('Write path is outside the scoped workspace.'), { code: -32001 });
      }
      const verdict = evaluatePermission(rules, 'repo.write', { path: rel });
      if (verdict.action !== 'allow') {
        throw Object.assign(new Error(`Permission denied for write to ${rel}.`), { code: -32003 });
      }
      const content = typeof params.content === 'string' ? params.content : null;
      if (content === null || content.includes('\0') || Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
        throw Object.assign(new Error('Write content must be valid UTF-8 up to 256 KiB without NUL bytes.'), { code: -32602 });
      }
      const target = await scopedPath(canonicalWs, rel, { writing: true });
      await ensureSafeParentDirs(canonicalWs, rel);
      const tmpTarget = path.join(path.dirname(target), `.g0d-write-${randomUUID()}.tmp`);
      const buf = Buffer.from(content, 'utf8');
      let handle = null;
      let renamed = false;
      try {
        handle = await fs.open(
          tmpTarget,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW || 0),
          0o600
        );
        await handle.writeFile(buf);
        await handle.close();
        handle = null;
        // Re-verify scopedPath right before atomic rename to prevent TOCTOU parent symlink swaps.
        const verifiedTarget = await scopedPath(canonicalWs, rel, { writing: true });
        await fs.rename(tmpTarget, verifiedTarget);
        renamed = true;
      } finally {
        if (handle) await handle.close().catch(() => {});
        if (!renamed) await fs.unlink(tmpTarget).catch(() => {});
      }
      const digest = sha256(buf);
      modifiedFiles.set(rel, { path: rel, sha256: digest, bytes: buf.length });
      onFileModified?.({ path: rel, sha256: digest, bytes: buf.length });
      return {};
    },

    async terminalCreate(params = {}) {
      if (disposed) throw Object.assign(new Error('Sandbox terminals are closed.'), { code: -32003 });
      if (!workspace) throw Object.assign(new Error('No workspace bound for terminal/create.'), { code: -32602 });
      if (planMode) throw Object.assign(new Error('Terminal execution is blocked in Plan Mode.'), { code: -32003 });
      if (!execution?.enabled) throw Object.assign(new Error('Command execution is disabled for this task.'), { code: -32003 });
      if (activeTerminalCount() >= MAX_ACTIVE_TERMINALS) {
        throw Object.assign(new Error(`Too many active terminals (max ${MAX_ACTIVE_TERMINALS}).`), { code: -32003 });
      }
      const cmdRaw = String(params.command || '').trim();
      const argsList = Array.isArray(params.args) ? params.args.map(a => String(a)) : [];
      if (!cmdRaw || cmdRaw.includes('\0') || argsList.some(a => a.includes('\0'))) {
        throw Object.assign(new Error('terminal/create requires a valid non-empty command without NUL bytes.'), { code: -32602 });
      }
      const unquotedCommand = argsList.length ? `${cmdRaw} ${argsList.join(' ')}` : cmdRaw;
      const fullCommand = argsList.length
        ? `${shellQuote(cmdRaw)} ${argsList.map(shellQuote).join(' ')}`
        : cmdRaw;

      // Evaluate permissions against BOTH unquoted and shell-quoted forms so HARD_DENY_SHELL_RULES can never be evaded.
      const v1 = evaluatePermission(rules, 'process.run', { command: unquotedCommand });
      const v2 = evaluatePermission(rules, 'process.run', { command: fullCommand });
      if (v1.action !== 'allow' || v2.action !== 'allow') {
        throw Object.assign(new Error('Permission denied for command.'), { code: -32003 });
      }

      const canonicalWs = await fs.realpath(workspace);
      if (disposed) throw Object.assign(new Error('Sandbox terminals are closed.'), { code: -32003 });
      const relCwd = params.cwd ? (resolveWorkspaceRelative(canonicalWs, params.cwd) || resolveWorkspaceRelative(workspace, params.cwd)) : '.';
      if (params.cwd && (!relCwd || hasProtectedSegment(relCwd))) {
        throw Object.assign(new Error('Terminal cwd is outside the scoped workspace.'), { code: -32001 });
      }
      pruneTrackedTerminals();
      if (terminals.size >= MAX_TRACKED_TERMINALS) {
        throw Object.assign(new Error(`Terminal retention limit reached (max ${MAX_TRACKED_TERMINALS}).`), { code: -32003 });
      }

      const outputByteLimit = Math.min(MAX_TERMINAL_OUTPUT_BYTES, Math.max(1024, Number(params.outputByteLimit) || MAX_TERMINAL_OUTPUT_BYTES));
      const terminalId = `term-${randomUUID().slice(0, 12)}`;
      const controller = new AbortController();
      const state = {
        id: terminalId,
        command: fullCommand,
        outputBuf: Buffer.alloc(0),
        truncated: false,
        exitStatus: null,
        controller,
        donePromise: null,
      };
      const appendOutput = (chunk) => {
        if (!chunk) return;
        const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
        let next = state.outputBuf.length ? Buffer.concat([state.outputBuf, incoming]) : incoming;
        if (next.length > outputByteLimit) {
          state.truncated = true;
          next = trimUtf8Tail(next, outputByteLimit);
        }
        state.outputBuf = next;
      };

      const syntheticTask = {
        workspace: canonicalWs,
        execution: {
          enabled: true,
          network: Boolean(execution.network),
          timeoutMs: Number(execution.timeoutMs) || 30000,
        },
      };
      state.donePromise = runCommand(
        syntheticTask,
        { command: fullCommand, cwd: relCwd || '.', timeoutMs: syntheticTask.execution.timeoutMs },
        {
          signal: controller.signal,
          onOutput: (_stream, text) => {
            appendOutput(text);
            onTerminalEvent?.({ type: 'output', terminalId, text });
          },
        }
      ).then(res => {
        if (!state.outputBuf.length && (res.stdout || res.stderr)) {
          appendOutput(`${res.stdout || ''}${res.stderr ? (res.stdout ? '\n' : '') + res.stderr : ''}`);
        }
        state.exitStatus = { exitCode: res.exitCode ?? (res.timedOut ? 124 : 0), signal: res.signal || null };
        onTerminalEvent?.({ type: 'exit', terminalId, exitStatus: state.exitStatus });
        return state.exitStatus;
      }).catch(() => {
        appendOutput('\n[sandbox error] Command execution failed.');
        state.exitStatus = { exitCode: 1, signal: null };
        onTerminalEvent?.({ type: 'exit', terminalId, exitStatus: state.exitStatus });
        return state.exitStatus;
      });

      terminals.set(terminalId, state);
      return { terminalId };
    },

    async terminalOutput(params = {}) {
      const term = terminals.get(params.terminalId);
      if (!term) throw Object.assign(new Error('Unknown terminalId.'), { code: -32602 });
      let text = term.outputBuf.toString('utf8');
      if (shouldRedact) text = redactOutboundText(text, secrets).text;
      return {
        output: text,
        truncated: term.truncated,
        ...(term.exitStatus ? { exitStatus: term.exitStatus } : {}),
      };
    },

    async terminalWaitForExit(params = {}) {
      const term = terminals.get(params.terminalId);
      if (!term) throw Object.assign(new Error('Unknown terminalId.'), { code: -32602 });
      return term.donePromise;
    },

    async terminalKill(params = {}) {
      const term = terminals.get(params.terminalId);
      if (!term) return {};
      try { term.controller.abort(); } catch {}
      return {};
    },

    async terminalRelease(params = {}) {
      const term = terminals.get(params.terminalId);
      if (!term) return {};
      try { term.controller.abort(); } catch {}
      terminals.delete(params.terminalId);
      return {};
    },
  };
}

function finiteOrZero(val) {
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function normalizeAcpUsage(rawUsage, latestUsage = null) {
  const hasRaw = rawUsage && typeof rawUsage === 'object' && Object.keys(rawUsage).length > 0;
  if (!hasRaw && !latestUsage) return null;
  const r = hasRaw ? rawUsage : {};
  const input = finiteOrZero(r.inputTokens ?? r.input_tokens ?? r.prompt_tokens ?? 0);
  const output = finiteOrZero(r.outputTokens ?? r.output_tokens ?? r.completion_tokens ?? 0);
  const cacheRead = finiteOrZero(r.cachedReadTokens ?? r.cacheReadTokens ?? r.cache_read_tokens ?? r.cache_read_input_tokens ?? 0);
  const cacheWrite = finiteOrZero(r.cachedWriteTokens ?? r.cacheWriteTokens ?? r.cache_write_tokens ?? r.cache_creation_input_tokens ?? 0);
  const thinking = finiteOrZero(r.thoughtTokens ?? r.thinking_tokens ?? r.reasoning_tokens ?? 0);
  const explicitTotal = finiteOrZero(r.totalTokens ?? r.total_tokens ?? 0);
  const total = explicitTotal || (input + output) || finiteOrZero(latestUsage?.used ?? 0);
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    thinking_tokens: thinking,
    total_tokens: total,
  };
}

/**
 * Zero-dependency JSON-RPC 2.0 stdio client implementing Agent Client Protocol (ACP v1).
 * Maintains a persistent child process in its own POSIX process group, enforces bounded
 * stdout line framing, handles bidirectional RPCs, streams `session/update` events live,
 * and cleanly cancels/tears down on abort or close.
 */
export class AcpClient {
  constructor({
    binary,
    args = [],
    cwd = process.cwd(),
    env = null,
    clientInfo = { name: 'g0dc0d3', version: '0.2.0' },
    capabilities = { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    permissionHandler = null,
    sandboxHandlers = null,
    rpcTimeoutMs = DEFAULT_RPC_TIMEOUT_MS,
    initTimeoutMs = 5000,
  } = {}) {
    this.binary = binary;
    this.args = Array.isArray(args) ? [...args] : [];
    this.cwd = cwd;
    this.env = env || minimalSafeEnv(process.env);
    this.clientInfo = clientInfo;
    this.capabilities = capabilities;
    this.permissionHandler = permissionHandler;
    this.sandboxHandlers = sandboxHandlers;
    this.rpcTimeoutMs = rpcTimeoutMs;
    this.initTimeoutMs = initTimeoutMs;

    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.sessionListeners = new Map();
    this.activePrompts = new Set();
    this.stderrBuf = '';
    this.stdoutLineBuf = '';
    this.initResult = null;
    this.closed = false;
    this.started = false;
    this.exitError = null;
    this._startPromise = null;
    this._closePromise = null;
  }

  isAlive() {
    return Boolean(
      this.started
      && !this.closed
      && !this.exitError
      && this.proc
      && Number.isInteger(this.proc.pid)
      && this.proc.exitCode === null
      && this.proc.signalCode === null
      && !this.proc.killed
    );
  }

  isBusy() {
    return this.pending.size > 0 || this.activePrompts.size > 0;
  }

  _signalProcGroup(proc, sig) {
    if (!proc || !Number.isInteger(proc.pid)) return false;
    try {
      if (process.platform !== 'win32') {
        process.kill(-proc.pid, sig);
        return true;
      }
      return proc.kill(sig);
    } catch {
      try { return proc.kill(sig); } catch { return false; }
    }
  }

  async start(signal = null) {
    if (this.isAlive() && this.initResult) return this.initResult;
    if (this.closed) throw Object.assign(new Error('ACP client is closed.'), { code: 'PROVIDER_CLOSED', retryable: false });
    if (signal?.aborted) throw Object.assign(new Error('ACP startup cancelled.'), { code: 'cancelled', retryable: false });
    if (this._startPromise) return this._startPromise;

    this._startPromise = (async () => {
      this.stderrBuf = '';
      this.stdoutLineBuf = '';
      this.exitError = null;
      const proc = spawn(this.binary, this.args, {
        cwd: this.cwd,
        env: this.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      this.proc = proc;
      this.started = true;

      proc.stderr.on('data', chunk => {
        if (this.stderrBuf.length < MAX_STDERR_BYTES) {
          this.stderrBuf += chunk.toString('utf8').slice(0, MAX_STDERR_BYTES - this.stderrBuf.length);
        }
      });

      proc.on('error', err => {
        const wrapped = Object.assign(new Error(`Failed to launch ACP harness (${path.basename(String(this.binary || ''))}): ${err.message}`), {
          code: 'provider_configuration',
          retryable: false,
        });
        this.exitError = wrapped;
        this.sandboxHandlers?.cleanupTerminals?.();
        this.sessionListeners.clear();
        this.activePrompts.clear();
        this._rejectAllPending(wrapped);
      });

      proc.on('close', (code, sig) => {
        const err = this.closed
          ? Object.assign(new Error('ACP client closed.'), { code: 'PROVIDER_CLOSED', retryable: false })
          : classifyAcpError(`ACP harness exited unexpectedly (code=${code}, signal=${sig || 'none'})`, this.stderrBuf);
        this.exitError = err;
        this.sandboxHandlers?.cleanupTerminals?.();
        this.sessionListeners.clear();
        this.activePrompts.clear();
        this._rejectAllPending(err);
      });

      proc.stdin.on('error', err => {
        if (this.closed) return;
        const transportErr = Object.assign(new Error(`ACP stdin pipe closed (${err?.code || 'EPIPE'}).`), {
          code: 'acp_closed',
          retryable: true,
        });
        this.exitError = this.exitError || transportErr;
        this._rejectAllPending(transportErr);
      });

      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', chunk => this._handleStdoutChunk(chunk));

      try {
        this.initResult = await this.request('initialize', {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientInfo: this.clientInfo,
          clientCapabilities: this.capabilities,
        }, this.initTimeoutMs, signal);
        return this.initResult;
      } catch (err) {
        await this.close().catch(() => {});
        if (['cancelled', 'PROVIDER_CLOSED', 'quota_exhausted', 'rate_limit', 'provider_configuration'].includes(err?.code)) {
          throw err;
        }
        throw Object.assign(new Error(`ACP initialize handshake failed (${err?.message || 'unknown'})`), {
          code: 'acp_init_failed',
          retryable: false,
        });
      }
    })();

    try {
      return await this._startPromise;
    } catch (err) {
      this._startPromise = null;
      throw err;
    }
  }

  _handleStdoutChunk(chunk) {
    if (!chunk) return;
    this.stdoutLineBuf += chunk;
    if (Buffer.byteLength(this.stdoutLineBuf, 'utf8') > MAX_STDOUT_LINE_BYTES) {
      const err = Object.assign(new Error('ACP stdout frame exceeded 16 MiB safety limit.'), { code: 'acp_error', retryable: false });
      this.stdoutLineBuf = '';
      this.exitError = err;
      this._rejectAllPending(err);
      this.close().catch(() => {});
      return;
    }
    let idx;
    while ((idx = this.stdoutLineBuf.indexOf('\n')) !== -1) {
      const line = this.stdoutLineBuf.slice(0, idx).replace(/\r$/, '');
      this.stdoutLineBuf = this.stdoutLineBuf.slice(idx + 1);
      this._handleLine(line);
    }
  }

  _send(payload) {
    if (!this.proc?.stdin || this.proc.stdin.destroyed || !this.isAlive()) {
      throw this.exitError || Object.assign(new Error('ACP process is not running.'), { code: 'acp_closed', retryable: true });
    }
    this.proc.stdin.write(JSON.stringify(payload) + '\n');
  }

  notify(method, params = {}) {
    if (!this.isAlive()) return;
    try { this._send({ jsonrpc: '2.0', method, params }); } catch {}
  }

  request(method, params = {}, timeoutMs = this.rpcTimeoutMs, signal = null) {
    if (this.closed) return Promise.reject(Object.assign(new Error('ACP client is closed.'), { code: 'PROVIDER_CLOSED', retryable: false }));
    if (signal?.aborted) return Promise.reject(Object.assign(new Error(`ACP RPC "${method}" cancelled.`), { code: 'cancelled', retryable: false }));
    if (this.exitError) return Promise.reject(this.exitError);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(Object.assign(new Error(`ACP RPC "${method}" cancelled.`), { code: 'cancelled', retryable: false }));
      };
      const timer = timeoutMs > 0 ? setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(Object.assign(new Error(`ACP RPC "${method}" timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT', retryable: true }));
      }, timeoutMs) : null;
      timer?.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });

      this.pending.set(id, {
        resolve: val => { if (settled) return; settled = true; cleanup(); resolve(val); },
        reject: err => { if (settled) return; settled = true; cleanup(); reject(err); },
        method,
      });
      try {
        this._send({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        if (!settled) {
          settled = true;
          cleanup();
          reject(err);
        }
      }
    });
  }

  _rejectAllPending(err) {
    for (const [id, entry] of [...this.pending.entries()]) {
      this.pending.delete(id);
      entry.reject(err);
    }
  }

  _handleLine(line) {
    if (!line || !line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      if (!this.initResult && this.pending.size > 0) {
        this._rejectAllPending(Object.assign(new Error('ACP binary emitted non-JSON stdout before initialize.'), { code: 'acp_init_failed', retryable: false }));
      }
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;

    const hasId = msg.id !== undefined && msg.id !== null;
    // 1. Response to one of our outgoing requests
    if (hasId && !msg.method) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      if (msg.error) {
        const errMsg = msg.error.message || JSON.stringify(msg.error);
        // Never pass stale persistent stderr into structured JSON-RPC error classification.
        const classified = classifyAcpError(errMsg, '');
        if (typeof msg.error.code === 'number') classified.rpcCode = msg.error.code;
        entry.reject(classified);
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    // Non-ACP JSON object printed before handshake completes (e.g. subprocess JSON output)
    if (!this.initResult && msg.jsonrpc !== '2.0' && this.pending.size > 0) {
      this._rejectAllPending(Object.assign(new Error('Binary output is not ACP JSON-RPC 2.0.'), { code: 'acp_init_failed', retryable: false }));
      return;
    }

    // 2. Notification from ACP server (e.g. session/update)
    if (msg.method && !hasId) {
      if (msg.method === 'session/update') {
        const sid = msg.params?.sessionId;
        const listener = sid ? this.sessionListeners.get(sid) : null;
        if (listener) {
          try { listener(msg.params?.update || {}, msg.params); } catch {}
        }
      }
      return;
    }

    // 3. Server -> Client RPC request (permission, fs/*, terminal/*)
    if (msg.method && hasId) {
      this._handleServerRpc(msg).catch(() => {});
    }
  }

  async _handleServerRpc(msg) {
    const { id, method, params = {} } = msg;
    const replyOk = result => { try { this._send({ jsonrpc: '2.0', id, result }); } catch {} };
    const replyErr = (code, message) => { try { this._send({ jsonrpc: '2.0', id, error: { code, message: String(message || 'RPC error').slice(0, 300) } }); } catch {} };

    try {
      if (method === 'session/request_permission') {
        if (!this.permissionHandler) {
          replyOk({ outcome: selectPermissionOption(params.options, false) });
          return;
        }
        const res = await this.permissionHandler(params);
        replyOk(res || { outcome: { outcome: 'cancelled' } });
        return;
      }
      if (method === 'fs/read_text_file' && this.sandboxHandlers?.readTextFile) {
        replyOk(await this.sandboxHandlers.readTextFile(params));
        return;
      }
      if (method === 'fs/write_text_file' && this.sandboxHandlers?.writeTextFile) {
        replyOk(await this.sandboxHandlers.writeTextFile(params));
        return;
      }
      if (method === 'terminal/create' && this.sandboxHandlers?.terminalCreate) {
        replyOk(await this.sandboxHandlers.terminalCreate(params));
        return;
      }
      if (method === 'terminal/output' && this.sandboxHandlers?.terminalOutput) {
        replyOk(await this.sandboxHandlers.terminalOutput(params));
        return;
      }
      if (method === 'terminal/wait_for_exit' && this.sandboxHandlers?.terminalWaitForExit) {
        replyOk(await this.sandboxHandlers.terminalWaitForExit(params));
        return;
      }
      if (method === 'terminal/kill' && this.sandboxHandlers?.terminalKill) {
        replyOk(await this.sandboxHandlers.terminalKill(params));
        return;
      }
      if (method === 'terminal/release' && this.sandboxHandlers?.terminalRelease) {
        replyOk(await this.sandboxHandlers.terminalRelease(params));
        return;
      }
      replyErr(-32601, `Method not supported by client: ${method}`);
    } catch (err) {
      const safe = sanitizeRpcClientError(err);
      replyErr(safe.code, safe.message);
    }
  }

  async createSession({ cwd = this.cwd, model = null, mode = null, effort = null, mcpServers = [], signal = null } = {}) {
    await this.start(signal);
    const res = await this.request('session/new', { cwd, mcpServers }, this.rpcTimeoutMs, signal);
    const sessionId = res?.sessionId;
    if (!sessionId) throw Object.assign(new Error('ACP session/new returned no sessionId.'), { code: 'acp_protocol', retryable: false });

    const isFatalConfigErr = err => !this.isAlive() || ['cancelled', 'PROVIDER_CLOSED', 'quota_exhausted', 'rate_limit'].includes(err?.code);

    if (model && res?.models?.currentModelId !== model) {
      try {
        await this.request('session/set_model', { sessionId, modelId: model }, 15000, signal);
      } catch (err) {
        if (isFatalConfigErr(err)) throw err;
        const modelOpt = (res?.configOptions || []).find(o => o?.id === 'model');
        if (modelOpt) {
          const match = (modelOpt.options || []).find(o => o.value === model || model.startsWith(`${o.value}-`));
          if (match) {
            try {
              await this.request('session/set_config_option', { sessionId, configId: 'model', value: match.value }, 15000, signal);
            } catch (e2) {
              if (isFatalConfigErr(e2)) throw e2;
            }
          }
        }
      }
    }

    if (mode && res?.modes?.currentModeId !== mode) {
      const validMode = (res?.modes?.availableModes || []).some(m => m.id === mode);
      if (validMode) {
        try {
          await this.request('session/set_mode', { sessionId, modeId: mode }, 15000, signal);
        } catch (err) {
          if (isFatalConfigErr(err)) throw err;
        }
      }
    }

    if (effort) {
      const effOpt = (res?.configOptions || []).find(o => o?.id === 'thought_level' || o?.category === 'thought_level');
      const normalized = effort === 'fast' ? 'low' : effort === 'max' ? 'xhigh' : effort;
      if (effOpt && (effOpt.options || []).some(o => o.value === normalized)) {
        try {
          await this.request('session/set_config_option', { sessionId, configId: effOpt.id, value: normalized }, 15000, signal);
        } catch (err) {
          if (isFatalConfigErr(err)) throw err;
        }
      }
    }

    return {
      sessionId,
      models: res?.models || null,
      modes: res?.modes || null,
      configOptions: res?.configOptions || [],
    };
  }

  async prompt({
    sessionId,
    text,
    images = [],
    signal = null,
    timeoutMs = DEFAULT_PROMPT_TIMEOUT_MS,
    onDelta = null,
    onToolCall = null,
    onUsage = null,
  } = {}) {
    if (!sessionId) throw Object.assign(new Error('ACP prompt requires sessionId.'), { code: 'acp_protocol', retryable: false });
    if (signal?.aborted) throw Object.assign(new Error('ACP prompt cancelled.'), { code: 'cancelled', retryable: false });
    if (this.activePrompts.has(sessionId)) {
      throw Object.assign(new Error('ACP session already has a prompt in flight.'), { code: 'acp_busy', retryable: true });
    }

    const blocks = [];
    for (const img of images || []) {
      if (img?.data && img?.mimeType) {
        blocks.push({ type: 'image', data: img.data, mimeType: img.mimeType });
      }
    }
    blocks.push({ type: 'text', text: String(text || '') });

    let fullText = '';
    let fullThought = '';
    const toolCalls = [];
    let latestUsage = null;
    let firstTokenMs = null;
    const startedAt = Date.now();

    const listener = (update) => {
      const kind = update?.sessionUpdate;
      if (kind === 'agent_message_chunk') {
        const chunk = update?.content?.type === 'text' ? String(update.content.text || '') : '';
        if (chunk) {
          if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt;
          if (fullText.length < MAX_PROMPT_TEXT_BYTES) {
            fullText += chunk.slice(0, MAX_PROMPT_TEXT_BYTES - fullText.length);
          }
          onDelta?.({ type: 'text', text: chunk });
        }
      } else if (kind === 'agent_thought_chunk') {
        const chunk = update?.content?.type === 'text' ? String(update.content.text || '') : '';
        if (chunk) {
          if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt;
          if (fullThought.length < MAX_PROMPT_THOUGHT_BYTES) {
            fullThought += chunk.slice(0, MAX_PROMPT_THOUGHT_BYTES - fullThought.length);
          }
          onDelta?.({ type: 'reasoning', text: chunk });
        }
      } else if (kind === 'tool_call' || kind === 'tool_call_update') {
        const tc = {
          toolCallId: update.toolCallId || null,
          name: update.name || update.title || 'tool',
          kind: update.kind || 'other',
          status: update.status || (kind === 'tool_call' ? 'in_progress' : 'completed'),
          title: update.title || update.name || '',
        };
        if (toolCalls.length < MAX_PROMPT_TOOL_CALLS) toolCalls.push(tc);
        onToolCall?.(tc);
      } else if (kind === 'usage_update') {
        latestUsage = { used: finiteOrZero(update.used), size: finiteOrZero(update.size) };
        onUsage?.(latestUsage);
      }
    };

    this.activePrompts.add(sessionId);
    this.sessionListeners.set(sessionId, listener);

    let abortGraceTimer = null;
    let rejectOnAbortGrace = null;
    const abortGracePromise = new Promise((_, reject) => { rejectOnAbortGrace = reject; });
    const onAbort = () => {
      this.notify('session/cancel', { sessionId });
      abortGraceTimer = setTimeout(() => {
        rejectOnAbortGrace?.(Object.assign(new Error('ACP prompt cancelled.'), { code: 'cancelled', retryable: false }));
      }, CANCEL_GRACE_MS);
      abortGraceTimer?.unref?.();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const reqId = this.nextId;
      const reqPromise = this.request('session/prompt', { sessionId, prompt: blocks }, timeoutMs);
      reqPromise.catch(() => {});
      let result;
      try {
        result = await Promise.race([reqPromise, abortGracePromise]);
      } catch (err) {
        if (err?.code === 'ETIMEDOUT') {
          this.notify('session/cancel', { sessionId });
          throw err;
        }
        if (signal?.aborted) {
          const pendingEntry = this.pending.get(reqId);
          if (pendingEntry) {
            this.pending.delete(reqId);
            pendingEntry.reject(Object.assign(new Error('ACP prompt cancelled.'), { code: 'cancelled', retryable: false }));
          }
          throw Object.assign(new Error('ACP prompt cancelled.'), { code: 'cancelled', retryable: false });
        }
        throw err;
      }
      if (signal?.aborted || result?.stopReason === 'cancelled') {
        throw Object.assign(new Error('ACP prompt cancelled.'), { code: 'cancelled', retryable: false });
      }
      return {
        text: fullText,
        reasoning: fullThought,
        stopReason: result?.stopReason || 'end_turn',
        toolCalls,
        usage: normalizeAcpUsage(result?.usage, latestUsage),
        ttftMs: firstTokenMs,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      if (abortGraceTimer) clearTimeout(abortGraceTimer);
      signal?.removeEventListener('abort', onAbort);
      this.activePrompts.delete(sessionId);
      if (this.sessionListeners.get(sessionId) === listener) {
        this.sessionListeners.delete(sessionId);
      }
    }
  }

  async closeSession(sessionId) {
    if (!sessionId || !this.isAlive()) return;
    try { await this.request('session/close', { sessionId }, 5000); } catch {}
  }

  close() {
    if (this._closePromise) return this._closePromise;
    this.closed = true;
    this.sandboxHandlers?.cleanupTerminals?.();
    const err = Object.assign(new Error('ACP client closed.'), { code: 'PROVIDER_CLOSED', retryable: false });
    this._rejectAllPending(err);
    this.sessionListeners.clear();
    this.activePrompts.clear();
    try { this.proc?.stdin?.end(); } catch {}
    const proc = this.proc;
    this.proc = null;

    this._closePromise = (async () => {
      if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
      await new Promise(resolve => {
        let done = false;
        const finish = () => { if (done) return; done = true; clearTimeout(sigkillTimer); clearTimeout(finalTimer); resolve(); };
        const finalTimer = setTimeout(finish, 2500);
        finalTimer?.unref?.();
        const sigkillTimer = setTimeout(() => {
          this._signalProcGroup(proc, 'SIGKILL');
        }, 1200);
        sigkillTimer?.unref?.();
        proc.once('close', finish);
        const sent = this._signalProcGroup(proc, 'SIGTERM');
        if (!sent) finish();
      });
    })();
    return this._closePromise;
  }
}

/**
 * Bounded pool of persistent ACP sessions keyed by task/session key with idle eviction,
 * in-flight protection, displaced-client cleanup, and guaranteed process teardown on shutdown.
 */
export class AcpSessionPool {
  constructor({ maxClients = 12, idleTtlMs = 15 * 60 * 1000 } = {}) {
    this.maxClients = maxClients;
    this.idleTtlMs = idleTtlMs;
    this.entries = new Map();
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (!entry.client.isAlive()) {
      this.entries.delete(key);
      entry.client.close().catch(() => {});
      return null;
    }
    entry.lastUsedAt = Date.now();
    return entry;
  }

  set(key, entry) {
    const prev = this.entries.get(key);
    if (prev && prev.client && prev.client !== entry.client) {
      prev.client.close().catch(() => {});
    }
    this.entries.set(key, { ...entry, lastUsedAt: Date.now() });
    this._evictIfNeeded(key);
  }

  async drop(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    await entry.client.close().catch(() => {});
  }

  _evictIfNeeded(keepKey) {
    const now = Date.now();
    for (const [k, e] of [...this.entries.entries()]) {
      if (k === keepKey) continue;
      if (!e.client.isAlive()) {
        this.entries.delete(k);
        e.client.close().catch(() => {});
      } else if (!e.client.isBusy() && now - e.lastUsedAt > this.idleTtlMs) {
        this.entries.delete(k);
        e.client.close().catch(() => {});
      }
    }
    while (this.entries.size > this.maxClients) {
      let oldestKey = null, oldestTs = Infinity;
      for (const [k, e] of this.entries.entries()) {
        if (k !== keepKey && !e.client.isBusy() && e.lastUsedAt < oldestTs) {
          oldestTs = e.lastUsedAt;
          oldestKey = k;
        }
      }
      if (!oldestKey) break; // Never evict an actively streaming client mid-turn!
      const old = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      old?.client?.close().catch(() => {});
    }
  }

  status() {
    const active = [];
    for (const [key, e] of this.entries.entries()) {
      if (e.client.isAlive()) {
        active.push({
          key,
          harnessId: e.harnessId || 'unknown',
          model: e.model || null,
          sessionId: e.sessionId || null,
          mode: e.mode || 'planner',
          lastUsedAt: new Date(e.lastUsedAt).toISOString(),
        });
      }
    }
    return active;
  }

  async closeAll() {
    const list = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(list.map(e => e.client.close().catch(() => {})));
  }
}
