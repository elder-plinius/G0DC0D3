import { sha256, stableJson } from './broker.mjs';
const VALID_ACTIONS = new Set(['allow', 'ask', 'deny', 'auto']);
const ALLOWED_KEYS = new Set(['tool', 'pattern', 'action', 'reason', 'argsHash']);
const MAX_RULES = 50;
const error = (code, message) => Object.assign(new Error(message), { code });

export const HARD_DENY_SHELL_RULES = Object.freeze([
  Object.freeze({ tool: 'process.run', pattern: '*rm -rf /*', action: 'deny', reason: 'Block destructive root deletion' }),
  Object.freeze({ tool: 'process.run', pattern: '*rm -fr /*', action: 'deny', reason: 'Block destructive root deletion' }),
  Object.freeze({ tool: 'process.run', pattern: '*rm -rf ~*', action: 'deny', reason: 'Block destructive home deletion' }),
  Object.freeze({ tool: 'process.run', pattern: '*rm -fr ~*', action: 'deny', reason: 'Block destructive home deletion' }),
  Object.freeze({ tool: 'process.run', pattern: '*sudo *', action: 'deny', reason: 'Block privilege escalation via sudo' }),
  Object.freeze({ tool: 'process.run', pattern: '*mkfs*', action: 'deny', reason: 'Block filesystem formatting commands' }),
  Object.freeze({ tool: 'process.run', pattern: '*dd if=*of=/dev/*', action: 'deny', reason: 'Block raw block-device writes' }),
  Object.freeze({ tool: 'process.run', pattern: '*git push*--force*', action: 'deny', reason: 'Block force push' }),
  Object.freeze({ tool: 'process.run', pattern: '*git push* -f*', action: 'deny', reason: 'Block force push' }),
  Object.freeze({ tool: 'process.run', pattern: '*curl*|* sh*', action: 'deny', reason: 'Block piped remote shell execution' }),
  Object.freeze({ tool: 'process.run', pattern: '*curl*|*/sh*', action: 'deny', reason: 'Block piped remote shell execution' }),
  Object.freeze({ tool: 'process.run', pattern: '*curl*|sh*', action: 'deny', reason: 'Block piped remote shell execution' }),
  Object.freeze({ tool: 'process.run', pattern: '*curl*|*bash*', action: 'deny', reason: 'Block piped remote shell execution' }),
  Object.freeze({ tool: 'process.run', pattern: '*curl*|*zsh*', action: 'deny', reason: 'Block piped remote shell execution' }),
  Object.freeze({ tool: 'process.run', pattern: '*wget*|* sh*', action: 'deny', reason: 'Block piped remote shell execution' }),
  Object.freeze({ tool: 'process.run', pattern: '*wget*|*/sh*', action: 'deny', reason: 'Block piped remote shell execution' }),
  Object.freeze({ tool: 'process.run', pattern: '*wget*|sh*', action: 'deny', reason: 'Block piped remote shell execution' }),
  Object.freeze({ tool: 'process.run', pattern: '*wget*|*bash*', action: 'deny', reason: 'Block piped remote shell execution' }),
  Object.freeze({ tool: 'process.run', pattern: '*wget*|*zsh*', action: 'deny', reason: 'Block piped remote shell execution' }),
]);

export const DEFAULT_SAFE_PRESET = Object.freeze([
  Object.freeze({ tool: 'process.run', action: 'ask', reason: 'Confirm shell commands before execution' }),
  Object.freeze({ tool: 'repo.delete', action: 'ask', reason: 'Confirm file deletions' }),
  ...HARD_DENY_SHELL_RULES,
]);

export const ACCEPT_EDITS_PRESET = Object.freeze([
  Object.freeze({ tool: 'repo.write', action: 'allow', reason: 'Auto-approve workspace file writes' }),
  Object.freeze({ tool: 'repo.patch', action: 'allow', reason: 'Auto-approve surgical file patches' }),
  Object.freeze({ tool: 'repo.move', action: 'allow', reason: 'Auto-approve workspace file moves' }),
  Object.freeze({ tool: 'process.run', action: 'ask', reason: 'Confirm shell commands before execution' }),
  Object.freeze({ tool: 'repo.delete', action: 'ask', reason: 'Confirm file deletions' }),
  Object.freeze({ tool: 'git.commit', action: 'ask', reason: 'Confirm git commits' }),
  ...HARD_DENY_SHELL_RULES,
]);

export const STRICT_DEFAULT_PRESET = Object.freeze([
  Object.freeze({ tool: 'repo.write', action: 'ask', reason: 'Confirm file writes' }),
  Object.freeze({ tool: 'repo.patch', action: 'ask', reason: 'Confirm file patches' }),
  Object.freeze({ tool: 'repo.move', action: 'ask', reason: 'Confirm file moves' }),
  Object.freeze({ tool: 'repo.delete', action: 'ask', reason: 'Confirm file deletions' }),
  Object.freeze({ tool: 'git.commit', action: 'ask', reason: 'Confirm git commits' }),
  Object.freeze({ tool: 'process.run', action: 'ask', reason: 'Confirm shell commands' }),
  ...HARD_DENY_SHELL_RULES,
]);

export const DONT_ASK_PRESET = Object.freeze([
  Object.freeze({ tool: 'process.run', action: 'deny', reason: 'Headless mode: deny shell commands automatically' }),
  Object.freeze({ tool: 'repo.delete', action: 'deny', reason: 'Headless mode: deny file deletions automatically' }),
  Object.freeze({ tool: 'git.commit', action: 'deny', reason: 'Headless mode: deny git commits automatically' }),
]);

export const AUTO_JUDGE_PRESET = Object.freeze([
  Object.freeze({ tool: 'repo.write', action: 'allow', reason: 'Auto-approve workspace file writes' }),
  Object.freeze({ tool: 'repo.patch', action: 'allow', reason: 'Auto-approve surgical file patches' }),
  Object.freeze({ tool: 'repo.move', action: 'allow', reason: 'Auto-approve workspace file moves' }),
  Object.freeze({ tool: 'process.run', action: 'auto', reason: 'Overseer AI judges shell command safety' }),
  Object.freeze({ tool: 'repo.delete', action: 'auto', reason: 'Overseer AI judges file deletion safety' }),
  Object.freeze({ tool: 'git.commit', action: 'auto', reason: 'Overseer AI judges git commit safety' }),
  Object.freeze({ tool: 'web.fetch', action: 'auto', reason: 'Overseer AI judges outbound web fetch safety' }),
  Object.freeze({ tool: 'web.search', action: 'auto', reason: 'Overseer AI judges outbound web search safety' }),
  Object.freeze({ tool: 'browser.open', action: 'auto', reason: 'Overseer AI judges contained browser navigation safety' }),
  Object.freeze({ tool: 'browser.act', action: 'auto', reason: 'Overseer AI judges contained browser interaction safety' }),
  Object.freeze({ tool: 'browser.eval', action: 'auto', reason: 'Overseer AI judges browser page JS evaluation safety' }),
  ...HARD_DENY_SHELL_RULES,
]);

export const PERMISSION_PRESETS = Object.freeze({
  permissive: Object.freeze([]),
  auto: AUTO_JUDGE_PRESET,
  acceptEdits: ACCEPT_EDITS_PRESET,
  safe: DEFAULT_SAFE_PRESET,
  default: STRICT_DEFAULT_PRESET,
  dontAsk: DONT_ASK_PRESET,
});

const UNSAFE_WILDCARD_BINARIES = new Set([
  'rm', 'dd', 'mkfs', 'sudo', 'su', 'chmod', 'chown', 'curl', 'wget',
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'eval', 'exec',
  'python', 'python3', 'node', 'deno', 'perl', 'ruby', 'php', 'lua',
  'find', 'env', 'xargs', 'awk', 'gawk', 'sed', 'tar', 'npx', 'bunx',
  'osascript', 'open', 'ssh', 'scp', 'rsync', 'nc', 'ncat',
]);
const TWO_WORD_PREFIX_BINARIES = new Set(['npm', 'pnpm', 'yarn', 'bun', 'git', 'cargo', 'go', 'docker', 'kubectl', 'make', 'pytest', 'uv', 'pip', 'swift']);

export function derivePatternRule(toolName, args = {}) {
  if (toolName === 'process.run') {
    const cmd = String(args?.command || '').trim();
    if (!cmd || /[;&|`$<>()\r\n]/.test(cmd)) return null;
    const parts = cmd.split(/\s+/).filter(Boolean);
    if (!parts.length) return null;
    const bin = parts[0].split('/').pop().toLowerCase();
    if (!/^[a-z0-9._-]+$/i.test(bin) || UNSAFE_WILDCARD_BINARIES.has(bin)) return null;
    let prefix = parts[0];
    if (TWO_WORD_PREFIX_BINARIES.has(bin)) {
      const sub = parts[1] && /^[a-z0-9:._-]+$/i.test(parts[1]) && !parts[1].startsWith('-') ? parts[1] : null;
      if (!sub) return null; // Never derive broad `git*` or `docker*` from flag-only commands like `git --version`
      prefix = `${parts[0]} ${sub}`;
    }
    if (prefix.length > 80) return null;
    return { tool: 'process.run', pattern: `${prefix}*`, label: `${prefix} *` };
  }
  if (['repo.write', 'repo.patch', 'repo.delete'].includes(toolName) && typeof args?.path === 'string' && args.path.includes('/')) {
    const dir = args.path.split('/').slice(0, -1).join('/');
    if (dir && dir.length <= 120) {
      return { tool: toolName, pattern: `${dir}/*`, label: `${dir}/*` };
    }
  }
  return null;
}

export function assessToolRisk(toolName, args = {}) {
  const tags = [];
  if (toolName === 'process.run') {
    const cmd = String(args?.command || '');
    tags.push('shell');
    if (/\b(?:rm\s+-|dd\s+|mkfs|sudo\s+|chmod|chown|git\s+push\s+.*(?:-f|--force)|git\s+reset\s+--hard)\b/i.test(cmd)) {
      tags.push('destructive');
      return { level: 'high', tags };
    }
    if (/\b(?:curl|wget|ssh|scp|nc|ncat|npm\s+publish|pip\s+install|brew\s+install)\b/i.test(cmd)) {
      tags.push('network');
      return { level: 'medium', tags };
    }
    if (/[|;&`]|\$\(/.test(cmd)) tags.push('pipeline');
    return { level: 'medium', tags };
  }
  if (toolName === 'repo.delete') return { level: 'high', tags: ['delete'] };
  if (toolName === 'git.commit') return { level: 'medium', tags: ['git'] };
  if (['browser.open', 'browser.act', 'browser.eval'].includes(toolName)) return { level: 'medium', tags: ['browser'] };
  if (['repo.write', 'repo.patch', 'repo.move'].includes(toolName)) return { level: 'low', tags: ['edit'] };
  return { level: 'low', tags: ['read'] };
}

export function validatePermissionRules(rules) {
  if (rules === undefined || rules === null) return [];
  if (!Array.isArray(rules)) throw error('INVALID_PERMISSION_RULE', 'Permission rules must be an array.');
  if (rules.length > MAX_RULES) throw error('INVALID_PERMISSION_RULE', `At most ${MAX_RULES} permission rules are allowed.`);
  const normalized = [];
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      throw error('INVALID_PERMISSION_RULE', `Rule ${i} must be an object.`);
    }
    for (const key of Object.keys(rule)) {
      if (!ALLOWED_KEYS.has(key)) {
        throw error('INVALID_PERMISSION_RULE', `Rule ${i} has unsupported field "${key}".`);
      }
    }
    if (typeof rule.tool !== 'string' || !rule.tool.trim() || rule.tool.trim().length > 80 || /[\x00-\x1f\x7f]/.test(rule.tool)) {
      throw error('INVALID_PERMISSION_RULE', `Rule ${i}.tool must be a 1–80 character pattern without control characters.`);
    }
    if (!VALID_ACTIONS.has(rule.action)) {
      throw error('INVALID_PERMISSION_RULE', `Rule ${i}.action must be "allow", "auto", "ask", or "deny".`);
    }
    let pattern;
    if (rule.pattern !== undefined && rule.pattern !== null && rule.pattern !== '') {
      if (typeof rule.pattern !== 'string' || rule.pattern.length > 240 || /[\x00-\x1f\x7f]/.test(rule.pattern)) {
        throw error('INVALID_PERMISSION_RULE', `Rule ${i}.pattern must be at most 240 characters without control characters.`);
      }
      pattern = rule.pattern;
    }
    let reason;
    if (rule.argsHash !== undefined && (typeof rule.argsHash !== 'string' || !/^[a-f0-9]{64}$/.test(rule.argsHash))) {
      throw error('INVALID_PERMISSION_RULE', `Rule ${i}.argsHash must be a SHA-256 digest.`);
    }
    if (rule.reason !== undefined && rule.reason !== null && rule.reason !== '') {
      if (typeof rule.reason !== 'string' || rule.reason.trim().length > 240 || /[\x00-\x1f\x7f]/.test(rule.reason)) {
        throw error('INVALID_PERMISSION_RULE', `Rule ${i}.reason must be at most 240 characters without control characters.`);
      }
      reason = rule.reason.trim();
    }
    normalized.push({
      tool: rule.tool.trim(),
      ...(pattern !== undefined ? { pattern } : {}),
      ...(rule.argsHash !== undefined ? { argsHash: rule.argsHash } : {}),
      action: rule.action,
      ...(reason !== undefined ? { reason } : {})
    });
  }
  return normalized;
}

export function toolTarget(toolName, args = {}) {
  if (!args || typeof args !== 'object') return '';
  if (toolName === 'process.run') return String(args.command || '');
  if (toolName === 'repo.move') return String(args.from || args.to || '');
  if (toolName.startsWith('repo.')) {
    if (typeof args.path === 'string') return args.path;
    if (typeof args.from === 'string') return args.from;
    if (typeof args.pattern === 'string') return args.pattern;
    if (typeof args.query === 'string') return args.query;
    return '';
  }
  if (toolName === 'git.commit') return String(args.message || '');
  if (toolName === 'web.fetch') return String(args.url || '');
  if (toolName === 'web.search') return String(args.query || '');
  if (toolName === 'browser.open') return String(args.url || '');
  if (toolName === 'browser.act') return `${args.action || ''}${args.ref ? ` ${args.ref}` : args.selector ? ` ${args.selector}` : ''}`.trim();
  if (toolName === 'browser.eval') return String(args.expression || '');
  if (toolName === 'agent.spawn') return `${args.role || 'explore'}: ${String(args.prompt || '')}`;
  if (toolName === 'memory.save') return String(args.title || '');
  if (toolName === 'memory.delete') return String(args.id || '');
  if (toolName === 'memory.search' || toolName === 'task.history') return String(args.query || '');
  return '';
}

export function globMatch(pattern, value) {
  if (typeof pattern !== 'string' || typeof value !== 'string') return false;
  // Greedy wildcard matching with bounded backtracking; no exponential regex.
  let p = 0, v = 0, star = -1, restart = 0;
  while (v < value.length) {
    if (pattern[p] === '?' || (p < pattern.length && pattern[p] === value[v])) { p++; v++; }
    else if (pattern[p] === '*') { star = p++; restart = v; }
    else if (star >= 0) { p = star + 1; v = ++restart; }
    else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}

function normalizeShellForDeny(command) {
  return String(command || '')
    .replace(/\\\r?\n/g, '')
    .replace(/\\(.)/g, '$1')
    .replace(/['"]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .toLowerCase();
}

function matchSemanticHardDeny(command) {
  const norm = normalizeShellForDeny(command);
  if (!norm) return null;
  const segments = norm.split(/(?:&&|\|\||[;\n|])+/).map(s => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const tokens = seg.split(' ').filter(Boolean);
    if (!tokens.length) continue;
    const cmd = tokens[0].split('/').pop();
    if (cmd === 'sudo') return 'Block privilege escalation via sudo';
    if (cmd.startsWith('mkfs')) return 'Block filesystem formatting commands';
    if (cmd === 'dd' && tokens.some(t => t.startsWith('of=/dev/'))) return 'Block raw block-device writes';
    if (cmd === 'rm') {
      let hasR = false, hasF = false;
      const targets = [];
      for (const tok of tokens.slice(1)) {
        if (tok === '--') continue;
        if (tok === '--recursive') hasR = true;
        else if (tok === '--force') hasF = true;
        else if (tok.startsWith('-') && !tok.startsWith('--')) {
          if (tok.includes('r') || tok.includes('R')) hasR = true;
          if (tok.includes('f')) hasF = true;
        } else {
          targets.push(tok);
        }
      }
      if (hasR && hasF && targets.some(t => t === '/' || t === '/*' || t === '~' || t.startsWith('~/') || t === '$home' || t.startsWith('$home/') || t === '${home}' || t.startsWith('${home}/'))) {
        return 'Block destructive root/home deletion';
      }
    }
    if (cmd === 'git') {
      const pushIdx = tokens.indexOf('push');
      if (pushIdx > 0) {
        const pushArgs = tokens.slice(pushIdx + 1);
        if (pushArgs.some(a => a === '-f' || a === '--force' || a.startsWith('--force-') || a.startsWith('+'))) {
          return 'Block force push';
        }
      }
    }
  }
  // Detect piped or evaluated remote script execution (curl/wget -> sh/bash/zsh/dash/ksh/python/node/eval)
  if (/\b(?:curl|wget)\b[^;\n]*\|\s*(?:\/[^\s]*\/)?(?:sh|bash|zsh|dash|ksh|python3?|node|perl|ruby|eval)\b/.test(norm)
    || /\b(?:sh|bash|zsh|dash|ksh|eval|source|\.)\b[^;\n]*(?:<\(|\$\()[^)]*\b(?:curl|wget)\b/.test(norm)) {
    return 'Block piped remote shell execution';
  }
  return null;
}

/** Last-match-wins evaluation of permission rules. Defaults to { action: 'allow', rule: null }. */
export function evaluatePermission(rules, toolName, args = {}) {
  const target = toolTarget(toolName, args);
  if (!Array.isArray(rules) || !rules.length) {
    return { action: 'allow', rule: null, target, reason: null };
  }
  const hasHardShellDeny = toolName === 'process.run' && rules.some(r => r?.action === 'deny' && globMatch(r.tool, 'process.run') && typeof r.pattern === 'string' && r.pattern.includes('rm -rf'));
  let matched = null;
  for (const rule of rules) {
    if (!rule || typeof rule.tool !== 'string' || !VALID_ACTIONS.has(rule.action)) continue;
    if (!globMatch(rule.tool, toolName)) continue;
    if (rule.argsHash !== undefined && rule.argsHash !== sha256(stableJson(args || {}))) continue;
    if (rule.pattern !== undefined && rule.pattern !== '') {
      const targets = toolName === 'repo.move' ? [String(args.from || ''), String(args.to || '')] : [target];
      const isWildcardShellAllow = toolName === 'process.run' && rule.action === 'allow' && /[*?]/.test(rule.pattern);
      const caseInsensitive = toolName === 'process.run' && rule.action === 'deny';
      const matches = targets.map(value => {
        if (isWildcardShellAllow && /[;&|`$<>()\r\n]/.test(value)) return false;
        if (isWildcardShellAllow && rule.pattern.endsWith('*') && !rule.pattern.endsWith(' *')) {
          const base = rule.pattern.slice(0, -1);
          if (value !== base && !value.startsWith(base + ' ')) return false;
        }
        return caseInsensitive
          ? (globMatch(rule.pattern.toLowerCase(), value.toLowerCase()) || globMatch(rule.pattern.toLowerCase(), normalizeShellForDeny(value)))
          : globMatch(rule.pattern, value);
      });
      if (!(rule.action === 'allow' ? matches.every(Boolean) : matches.some(Boolean))) continue;
    }
    matched = rule;
  }
  if (hasHardShellDeny && matched?.action !== 'deny') {
    const semanticReason = matchSemanticHardDeny(target);
    if (semanticReason) {
      return { action: 'deny', rule: { tool: 'process.run', action: 'deny', reason: semanticReason }, target, reason: semanticReason };
    }
  }
  if (!matched) return { action: 'allow', rule: null, target, reason: null };
  return {
    action: matched.action,
    rule: matched,
    target,
    reason: matched.reason || null
  };
}

/**
 * Inserts a user-approved allow rule before trailing deny rules so task-scoped
 * approvals ("Allow pattern" / "Always allow") cannot shadow hard-deny safety rules.
 * When at MAX_RULES, evicts the oldest specific allow rule instead of base ask/deny rules.
 */
export function insertTaskAllowRule(existingRules, allowRule) {
  const next = Array.isArray(existingRules) ? [...existingRules] : [];
  while (next.length >= MAX_RULES) {
    let evictIdx = next.findIndex(r => r?.action === 'allow' && (r.pattern !== undefined || r.argsHash !== undefined));
    if (evictIdx < 0) evictIdx = next.findIndex(r => r?.action === 'allow');
    if (evictIdx >= 0) next.splice(evictIdx, 1);
    else throw error('INVALID_PERMISSION_RULE', `Cannot add permission rule: all ${MAX_RULES} rule slots are occupied by non-evictable rules.`);
  }
  // Place allowRule AFTER custom ask/auto rules (so user approvals always take effect)
  // while keeping overlapping deny rules (e.g. HARD_DENY_SHELL_RULES) trailing so safety denies still win.
  const kept = [];
  const trailingMatchingDenies = [];
  for (const r of next) {
    if (r?.action === 'deny' && (globMatch(r.tool, allowRule.tool) || globMatch(allowRule.tool, r.tool))) {
      trailingMatchingDenies.push(r);
    } else {
      kept.push(r);
    }
  }
  return validatePermissionRules([...kept, allowRule, ...trailingMatchingDenies]);
}
