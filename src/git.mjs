import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const GIT = '/usr/bin/git';
const MAX_OUTPUT = 32768;
const MAX_BUFFER = 4 * 1024 * 1024;
export const SAFE_GIT_FLAGS = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'commit.gpgsign=false',
  '-c', 'core.pager=cat',
  '-c', 'diff.external=',
  '-c', 'core.attributesfile=/dev/null',
  '-c', 'core.sshCommand=/usr/bin/false',
];

export async function neutralizeRepoGitConfigFlags(repoRoot) {
  const extra = [];
  if (!repoRoot) return extra;
  try {
    const cfgPath = path.join(repoRoot, '.git', 'config');
    const st = await fs.lstat(cfgPath);
    if (st.isSymbolicLink() || !st.isFile() || st.size > 256 * 1024) return extra;
    const raw = await fs.readFile(cfgPath, 'utf8');
    const filterNames = new Set();
    const diffNames = new Set();
    for (const m of raw.matchAll(/\[\s*filter\s+"([^"\n]+)"\s*\]/gi)) filterNames.add(m[1]);
    for (const m of raw.matchAll(/\[\s*diff\s+"([^"\n]+)"\s*\]/gi)) diffNames.add(m[1]);
    for (const name of filterNames) {
      extra.push('-c', `filter.${name}.clean=`, '-c', `filter.${name}.smudge=`, '-c', `filter.${name}.process=`);
    }
    for (const name of diffNames) {
      extra.push('-c', `diff.${name}.textconv=`, '-c', `diff.${name}.command=`);
    }
  } catch {}
  return extra;
}

async function run(args, { cwd, timeout = 5000 } = {}) {
  const extraFlags = cwd ? await neutralizeRepoGitConfigFlags(cwd) : [];
  return new Promise((resolve, reject) => {
    const ceiling = cwd ? path.dirname(path.resolve(cwd)) : undefined;
    execFile(GIT, [...SAFE_GIT_FLAGS, ...extraFlags, ...args], {
      cwd,
      timeout,
      maxBuffer: MAX_BUFFER,
      env: {
        ...process.env,
        ...(ceiling ? { GIT_CEILING_DIRECTORIES: ceiling } : {}),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: 'g0dc0d3',
        GIT_AUTHOR_EMAIL: 'g0dc0d3@local',
        GIT_COMMITTER_NAME: 'g0dc0d3',
        GIT_COMMITTER_EMAIL: 'g0dc0d3@local'
      }
    }, (error, stdout, stderr) => {
      if (error) { error.stderr = stderr; reject(error); }
      else resolve(stdout);
    });
  });
}

async function hasHead(workspace) {
  try {
    await run(['rev-parse', '--verify', 'HEAD'], { cwd: workspace, timeout: 3000 });
    return true;
  } catch { return false; }
}

export async function gitInit(workspace) {
  await run(['init', '-b', 'main'], { cwd: workspace });
  await run(['add', '-A'], { cwd: workspace });
  await run(['commit', '-q', '-m', 'initial workspace', '--allow-empty'], { cwd: workspace });
}

export async function gitAutoCommit(workspace, message = 'auto') {
  try {
    if (!await hasGit(workspace)) return false;
    const status = await run(['status', '--porcelain'], { cwd: workspace });
    if (!status.trim()) return false;
    await run(['add', '-A'], { cwd: workspace });
    await run(['commit', '-q', '-m', message, '--allow-empty-message'], { cwd: workspace });
    return true;
  } catch { return false; }
}

export async function gitDiff(workspace, { staged = false } = {}) {
  try {
    if (!await hasGit(workspace)) return '';
    const args = ['diff', '--no-ext-diff', '--no-textconv', '--stat', '--patch'];
    if (staged) args.push('--cached');
    else if (await hasHead(workspace)) args.push('HEAD');
    const output = await run(args, { cwd: workspace, timeout: 10000 });
    return output.slice(0, MAX_OUTPUT);
  } catch { return ''; }
}

export async function gitLog(workspace, { limit = 20 } = {}) {
  try {
    if (!await hasGit(workspace)) return '';
    const output = await run(['log', '--oneline', '--no-decorate', `-${Math.min(limit, 50)}`], { cwd: workspace, timeout: 5000 });
    return output.slice(0, MAX_OUTPUT);
  } catch { return ''; }
}

export async function gitDiffSummary(workspace) {
  try {
    if (!await hasGit(workspace)) return '';
    const args = ['diff', '--no-ext-diff', '--no-textconv', '--stat'];
    if (await hasHead(workspace)) args.push('HEAD');
    const output = await run(args, { cwd: workspace, timeout: 5000 });
    return output.slice(0, 4096);
  } catch { return ''; }
}

export async function gitCommit(workspace, { message = 'commit' } = {}) {
  if (!await hasGit(workspace)) return { ok: true, committed: false, hash: null, summary: 'No git repository in this workspace.' };
  const status = await run(['status', '--porcelain'], { cwd: workspace });
  if (!status.trim()) return { ok: true, committed: false, hash: null, summary: 'Nothing to commit — working tree clean.' };
  await run(['add', '-A'], { cwd: workspace });
  const output = await run(['commit', '-m', message], { cwd: workspace, timeout: 10000 });
  const hash = (await run(['rev-parse', '--short', 'HEAD'], { cwd: workspace, timeout: 5000 })).trim() || null;
  return { ok: true, committed: true, hash, summary: output.trim().slice(0, 500) };
}

export async function hasGit(workspace) {
  try {
    const wsReal = await fs.realpath(workspace);
    const gitDir = path.join(wsReal, '.git');
    const st = await fs.lstat(gitDir);
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
    return (await fs.realpath(gitDir)) === gitDir;
  } catch { return false; }
}

export async function gitCheckpoints(workspace, { limit = 25 } = {}) {
  try {
    if (!await hasGit(workspace)) return [];
    const max = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 25, 100));
    const output = await run(['log', `-n${max}`, '--format=%H%x1f%h%x1f%s%x1f%cI'], { cwd: workspace, timeout: 5000 });
    return output
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [hash = '', shortHash = '', subject = '', date = ''] = line.split('\x1f');
        return { hash, shortHash, subject, date };
      })
      .filter(item => item.hash);
  } catch { return []; }
}

export async function gitRewind(workspace, stepsOrOptions = 1) {
  const opts = typeof stepsOrOptions === 'object' && stepsOrOptions !== null ? stepsOrOptions : { steps: stepsOrOptions };
  const hasHash = opts.hash !== undefined && opts.hash !== null;
  if (hasHash) {
    if (typeof opts.hash !== 'string' || !/^[0-9a-f]{7,40}$/i.test(opts.hash.trim())) {
      throw Object.assign(new Error('Checkpoint hash must be 7–40 hexadecimal characters.'), { code: 'INVALID_REWIND' });
    }
    if (!await hasGit(workspace) || !await hasHead(workspace)) {
      throw Object.assign(new Error('No git history in this workspace.'), { code: 'NO_GIT_HISTORY' });
    }
    const needle = opts.hash.trim().toLowerCase();
    const listText = await run(['rev-list', 'HEAD'], { cwd: workspace, timeout: 5000 });
    const commits = listText.trim().split('\n').filter(Boolean);
    const matches = commits.map((c, idx) => ({ hash: c, idx })).filter(item => item.hash === needle || item.hash.startsWith(needle));
    if (!matches.length) {
      throw Object.assign(new Error('Target commit hash is not in this workspace\'s git history.'), { code: 'INVALID_REWIND' });
    }
    if (matches.length > 1) {
      throw Object.assign(new Error('Checkpoint hash prefix is ambiguous; specify more characters.'), { code: 'INVALID_REWIND' });
    }
    const target = matches[0];
    if (target.idx === 0) {
      const dirty = (await run(['status', '--porcelain'], { cwd: workspace, timeout: 5000 })).trim();
      if (!dirty) {
        throw Object.assign(new Error('Workspace is already at this checkpoint.'), { code: 'INVALID_REWIND' });
      }
    }
    const fromHash = (await run(['rev-parse', '--short', 'HEAD'], { cwd: workspace, timeout: 5000 })).trim();
    await run(['reset', '--hard', target.hash], { cwd: workspace, timeout: 10000 });
    await run(['clean', '-fd'], { cwd: workspace, timeout: 10000 });
    const toHash = (await run(['rev-parse', '--short', 'HEAD'], { cwd: workspace, timeout: 5000 })).trim();
    const summary = (await run(['log', '-1', '--pretty=%s'], { cwd: workspace, timeout: 5000 })).trim();
    return { ok: true, steps: target.idx, fromHash, toHash, hash: target.hash, summary, remainingCommits: commits.length - target.idx };
  }
  const steps = opts.steps === undefined ? 1 : opts.steps;
  if (!Number.isInteger(steps) || steps < 1 || steps > 50) {
    throw Object.assign(new Error('Rewind steps must be an integer from 1 to 50.'), { code: 'INVALID_REWIND' });
  }
  if (!await hasGit(workspace) || !await hasHead(workspace)) {
    throw Object.assign(new Error('No git history in this workspace.'), { code: 'NO_GIT_HISTORY' });
  }
  const countText = await run(['rev-list', '--first-parent', '--count', 'HEAD'], { cwd: workspace, timeout: 5000 });
  const count = Number(countText.trim());
  if (!Number.isInteger(count) || count <= 1 || steps >= count) {
    throw Object.assign(new Error('Cannot rewind past the initial workspace commit.'), { code: 'REWIND_LIMIT' });
  }
  const fromHash = (await run(['rev-parse', '--short', 'HEAD'], { cwd: workspace, timeout: 5000 })).trim();
  await run(['reset', '--hard', `HEAD~${steps}`], { cwd: workspace, timeout: 10000 });
  await run(['clean', '-fd'], { cwd: workspace, timeout: 10000 });
  const hash = (await run(['rev-parse', 'HEAD'], { cwd: workspace, timeout: 5000 })).trim();
  const toHash = (await run(['rev-parse', '--short', 'HEAD'], { cwd: workspace, timeout: 5000 })).trim();
  const summary = (await run(['log', '-1', '--pretty=%s'], { cwd: workspace, timeout: 5000 })).trim();
  return { ok: true, steps, fromHash, toHash, hash, summary, remainingCommits: count - steps };
}
