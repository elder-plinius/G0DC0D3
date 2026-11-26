import { spawn } from 'node:child_process';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const fault = (code, message) => Object.assign(new Error(message), { code });
const sbQuote = value => JSON.stringify(value);
export const RUNNER_LIMITS = Object.freeze({ maxTimeoutMs: 120000, defaultTimeoutMs: 30000, maxOutputBytes: 65536, maxCommandChars: 16000 });
export const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";

export function isSandboxSupportedPlatform(platform = process.platform) {
  return platform === 'darwin' || platform === 'linux';
}

export function executionBoundaryForPlatform(platform = process.platform, { readOnly = false } = {}) {
  if (platform === 'darwin') return readOnly ? 'macos-seatbelt-read-only' : 'macos-seatbelt';
  if (platform === 'linux') return readOnly ? 'linux-bwrap-read-only' : 'linux-bwrap';
  return undefined;
}

const MACOS_TOOLCHAIN_READ_CANDIDATES = ['/opt/homebrew', '/usr/local/bin', '/usr/local/lib', '/Library/Developer/CommandLineTools'];
const LINUX_TOOLCHAIN_READ_CANDIDATES = ['/usr/local/bin', '/usr/local/lib', '/snap/bin'];
const LINUX_SYSTEM_READ_CANDIDATES = [
  '/usr', '/bin', '/sbin', '/lib', '/lib64', '/lib32',
  '/etc/alternatives', '/etc/ld.so.cache', '/etc/ld.so.conf', '/etc/ld.so.conf.d',
  '/etc/localtime', '/etc/ssl/certs', '/etc/ca-certificates', '/etc/ca-certificates.conf',
  '/etc/hosts', '/etc/nsswitch.conf', '/etc/passwd', '/etc/group'
];
const LINUX_WORKER_READ_CANDIDATES = [
  '/usr/lib', '/usr/lib64', '/lib', '/lib64', '/lib32',
  '/etc/ld.so.cache', '/etc/ld.so.conf', '/etc/ld.so.conf.d', '/etc/localtime'
];

async function existingToolchainRoots(platform = process.platform) {
  const candidates = platform === 'linux' ? LINUX_TOOLCHAIN_READ_CANDIDATES : MACOS_TOOLCHAIN_READ_CANDIDATES;
  const roots = [];
  for (const candidate of candidates) {
    try {
      const real = await fs.realpath(candidate);
      if ((await fs.stat(real)).isDirectory()) roots.push(real);
    } catch {}
  }
  return [...new Set(roots)];
}

async function resolvePsBinary() {
  for (const candidate of ['/bin/ps', '/usr/bin/ps']) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

export async function findBwrapBinary(env = process.env) {
  const candidates = [
    env.G0D_BWRAP_BINARY,
    '/usr/bin/bwrap',
    '/bin/bwrap',
    '/usr/local/bin/bwrap',
  ].filter(v => typeof v === 'string' && v.trim());
  for (const candidate of candidates) {
    try {
      const real = await fs.realpath(candidate.trim());
      await fs.access(real, fsConstants.X_OK);
      if ((await fs.stat(real)).isFile()) return real;
    } catch {}
  }
  return null;
}

async function inspectHostMountEntries(paths) {
  const entries = [];
  const seen = new Set();
  for (const target of paths) {
    if (!target || seen.has(target)) continue;
    seen.add(target);
    try {
      const lst = await fs.lstat(target);
      if (lst.isSymbolicLink()) {
        const linkTarget = await fs.readlink(target);
        entries.push({ kind: 'symlink', path: target, target: linkTarget });
      } else if (lst.isDirectory() || lst.isFile()) {
        entries.push({ kind: 'ro-bind', path: target });
      }
    } catch {}
  }
  return entries;
}

/**
 * Pure builder for bubblewrap (bwrap) command sandbox argv on Linux.
 * Mirrors macOS Seatbelt's deny-by-default filesystem & network isolation while
 * leveraging Linux PID/IPC/UTS/network namespaces + --die-with-parent cleanup.
 */
export function bwrapCommandArgs({
  workspace,
  cwd,
  scratch,
  homeDir,
  tmpDir,
  deniedDir,
  deniedFile,
  nodeFile,
  npmRoot = null,
  runtimeFiles = [],
  runtimeFileEntries = null,
  toolchainRoots = [],
  systemEntries = [],
  resolvConfRealPath = null,
  maskedDirs = [],
  maskedFiles = [],
  env = {},
  network = false,
  command,
}) {
  if (typeof nodeFile !== 'string' || !path.isAbsolute(nodeFile)) {
    throw fault('ISOLATION_UNAVAILABLE', 'A canonical Node executable is required.');
  }
  const args = [
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--die-with-parent',
    '--new-session',
    '--cap-drop', 'ALL',
  ];
  if (!network) args.push('--unshare-net');
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run');

  const bound = new Set();
  const addRoBind = p => {
    if (!p || bound.has(p)) return;
    bound.add(p);
    args.push('--ro-bind', p, p);
  };
  for (const entry of systemEntries) {
    if (entry.kind === 'symlink') {
      if (!bound.has(entry.path)) {
        bound.add(entry.path);
        args.push('--symlink', entry.target, entry.path);
      }
    } else if (entry.kind === 'ro-bind') {
      addRoBind(entry.path);
    }
  }
  // Resolve systemd-resolved /etc/resolv.conf symlink target directly so DNS works under --tmpfs /run when network: true.
  if (network && resolvConfRealPath) {
    args.push('--ro-bind', resolvConfRealPath, '/etc/resolv.conf');
    bound.add('/etc/resolv.conf');
  }
  for (const root of toolchainRoots) addRoBind(root);
  if (npmRoot) addRoBind(npmRoot);
  addRoBind(nodeFile);
  if (Array.isArray(runtimeFileEntries) && runtimeFileEntries.length) {
    for (const entry of runtimeFileEntries) {
      if (entry.kind === 'symlink' && !bound.has(entry.path)) {
        bound.add(entry.path);
        args.push('--symlink', entry.target, entry.path);
      } else if (entry.kind === 'ro-bind') {
        addRoBind(entry.path);
      }
    }
  } else {
    for (const file of runtimeFiles) addRoBind(file);
  }

  // Only workspace, homeDir, and tmpDir are writable; .denied-* sentinels stay outside writable mounts.
  args.push('--bind', workspace, workspace);
  if (homeDir && tmpDir) {
    args.push('--bind', homeDir, homeDir);
    args.push('--bind', tmpDir, tmpDir);
  } else if (scratch) {
    args.push('--bind', scratch, scratch);
  }

  // Mask protected metadata (.git, .g0dc0d3) with chmod 0000 read-only sentinels so reads & writes return EACCES.
  for (const dir of maskedDirs) {
    if (deniedDir) args.push('--ro-bind', deniedDir, dir);
  }
  for (const file of maskedFiles) {
    if (deniedFile) args.push('--ro-bind', deniedFile, file);
  }

  args.push('--chdir', cwd || workspace);
  args.push('--clearenv');
  for (const [k, v] of Object.entries(env)) {
    args.push('--setenv', k, String(v));
  }
  args.push('--');
  if (Array.isArray(command)) args.push(...command);
  else args.push('/bin/sh', '-c', 'umask 077; ulimit -f 262144; ' + command);
  return args;
}

/**
 * Pure builder for bubblewrap (bwrap) read-only fixture worker argv on Linux.
 * No writable mounts, no network namespace, no /usr/bin shell utilities bound.
 */
export function bwrapWorkerArgs({ nodeFile, files = [], systemEntries = [], entry }) {
  if (typeof nodeFile !== 'string' || !path.isAbsolute(nodeFile)) {
    throw fault('ISOLATION_UNAVAILABLE', 'A canonical Node executable is required.');
  }
  const args = [
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-net',
    '--die-with-parent',
    '--new-session',
    '--cap-drop', 'ALL',
    '--proc', '/proc',
    '--dev', '/dev',
  ];
  const bound = new Set();
  for (const entryItem of systemEntries) {
    if (entryItem.kind === 'symlink') {
      if (!bound.has(entryItem.path)) {
        bound.add(entryItem.path);
        args.push('--symlink', entryItem.target, entryItem.path);
      }
    } else if (entryItem.kind === 'ro-bind') {
      if (!bound.has(entryItem.path)) {
        bound.add(entryItem.path);
        args.push('--ro-bind', entryItem.path, entryItem.path);
      }
    }
  }
  for (const file of [nodeFile, ...files]) {
    if (!bound.has(file)) {
      bound.add(file);
      args.push('--ro-bind', file, file);
    }
  }
  args.push(
    '--chdir', '/',
    '--clearenv',
    '--setenv', 'NODE_NO_WARNINGS', '1',
    '--',
    nodeFile,
    '--experimental-vm-modules',
    '--disable-proto=throw',
    '--max-old-space-size=128',
    entry,
  );
  return args;
}

/** A deny-by-default Seatbelt profile. Grants contain only canonical task/runtime paths. */
export function sandboxProfile({ workspace, scratch, nodeFile, npmRoot = null, runtimeFiles = [], toolchainRoots = [], network = false }) {
  const readRoots = ['/System/Library', '/System/Cryptexes', '/usr/bin', '/usr/lib', '/usr/libexec', '/usr/share', '/bin', '/sbin', '/Library/Apple', ...(npmRoot ? [npmRoot] : []), ...toolchainRoots, workspace, scratch];
  if (typeof nodeFile !== 'string' || !path.isAbsolute(nodeFile)) throw fault('ISOLATION_UNAVAILABLE', 'A canonical Node executable is required.');
  const ancestors = new Set(); for (const root of [...readRoots, nodeFile, ...runtimeFiles]) { let part = path.dirname(root); while (part !== path.dirname(part)) { ancestors.add(part); part = path.dirname(part); } }
  return `(version 1)\n(deny default)\n(allow process-exec process-fork)\n(allow signal (target self))\n(allow sysctl-read)\n(allow mach-lookup (global-name "com.apple.system.logger"))\n(allow file-read-metadata ${[...ancestors].map(root => `(literal ${sbQuote(root)})`).join(' ')})\n(allow file-read* file-map-executable ${[nodeFile, ...runtimeFiles].map(file => `(literal ${sbQuote(file)})`).join(' ')} ${readRoots.map(root => `(subpath ${sbQuote(root)})`).join(' ')})\n(allow file-read* (literal "/") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random") (literal "/private/var/select/sh") (literal "/private/etc/localtime") (literal "/private/etc/hosts") (literal "/private/etc/resolv.conf") (literal "/private/var/run/resolv.conf"))\n(allow file-write* (subpath ${sbQuote(workspace)}) (subpath ${sbQuote(scratch)}) (literal "/dev/null"))\n(deny file-read* file-write* (subpath ${sbQuote(path.join(workspace, '.git'))}) (subpath ${sbQuote(path.join(workspace, '.g0dc0d3'))}))\n${network ? '(allow network*)' : '(deny network*)'}\n`;
}

/** Grant the exact executable and the verified npm package, never its install
 * prefix: standalone ~/node and /usr/local/bin/node must not expose sibling data.
 */
export async function nodeRuntimePaths(executable = process.execPath) {
  const nodeFile = await fs.realpath(executable);
  if (!(await fs.stat(nodeFile)).isFile()) throw fault('ISOLATION_UNAVAILABLE', 'Node executable must be a regular file.');
  let npmRoot = null; const runtimeFiles = [];
  try {
    const npmFile = await fs.realpath(path.join(path.dirname(nodeFile), 'npm'));
    const candidate = path.dirname(path.dirname(npmFile));
    if (path.basename(npmFile) === 'npm-cli.js' && path.basename(path.dirname(npmFile)) === 'bin' && path.basename(candidate) === 'npm' && path.basename(path.dirname(candidate)) === 'node_modules' && await fs.realpath(candidate) === candidate) {
      const manifest = JSON.parse(await fs.readFile(path.join(candidate, 'package.json'), 'utf8'));
      if (manifest.name === 'npm') {
        npmRoot = candidate;
        for (const [binary, script] of [['npm', 'npm-cli.js'], ['npx', 'npx-cli.js']]) {
          const entry = path.join(path.dirname(nodeFile), binary);
          try { if (await fs.realpath(entry) === path.join(candidate, 'bin', script)) runtimeFiles.push(entry); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
        }
      }
    }
  } catch (cause) { if (!['ENOENT', 'ENOTDIR'].includes(cause.code)) throw fault('ISOLATION_UNAVAILABLE', 'Could not validate the installed npm runtime.'); }
  return { nodeFile, npmRoot, runtimeFiles };
}

export function validateExecution(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['enabled', 'network', 'timeoutMs'].includes(key))) throw fault('INVALID_EXECUTION', 'Execution settings contain unsupported fields.');
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean' || value.network !== undefined && typeof value.network !== 'boolean') throw fault('INVALID_EXECUTION', 'Execution grants must be booleans.');
  const timeoutMs = value.timeoutMs ?? RUNNER_LIMITS.defaultTimeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > RUNNER_LIMITS.maxTimeoutMs) throw fault('INVALID_EXECUTION', `Execution timeout must be 100–${RUNNER_LIMITS.maxTimeoutMs} ms.`);
  return { enabled: value.enabled === true, network: value.network === true, timeoutMs };
}
export function validateChecks(checks = []) {
  if (!Array.isArray(checks) || checks.length > 8) throw fault('INVALID_CHECKS', 'Configure at most eight checks.');
  const names = new Set();
  return checks.map(check => {
    if (!check || typeof check !== 'object' || Array.isArray(check) || Object.keys(check).some(key => !['name', 'command'].includes(key)) || typeof check.name !== 'string' || !check.name.trim() || check.name.length > 100 || typeof check.command !== 'string' || !check.command.trim() || check.command.length > RUNNER_LIMITS.maxCommandChars || check.command.includes('\0') || names.has(check.name)) throw fault('INVALID_CHECKS', 'Each check needs a unique name (1–100 characters) and a nonempty command (up to 16000 characters).');
    names.add(check.name); return { name: check.name, command: check.command };
  });
}

async function resolveDirectory(workspace, relative = '.') {
  const root = await fs.realpath(workspace);
  if (root !== path.resolve(workspace)) throw fault('WORKSPACE_CHANGED', 'Canonical task workspace was replaced or redirected.');
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\') || relative.includes('\0') || relative.split('/').some(part => part === '..' || ['.git', '.g0dc0d3'].includes(part.toLowerCase()))) throw fault('PATH_DENIED', 'Use a repository-relative working directory.');
  const candidate = path.resolve(root, relative);
  const canonical = await fs.realpath(candidate);
  if (canonical !== candidate || !(canonical === root || canonical.startsWith(root + path.sep)) || !(await fs.stat(canonical)).isDirectory()) throw fault('PATH_DENIED', 'Working directory is outside the copied project or traverses a link.');
  return { root, cwd: canonical };
}

function boundedStreamBuffer(maxBytes) {
  const headCap = Math.floor(maxBytes * 0.25);
  const tailCap = Math.max(0, maxBytes - headCap);
  const head = [];
  let headLen = 0;
  let tail = Buffer.alloc(0);
  let total = 0;
  let truncated = false;
  return {
    push(chunk) {
      total += chunk.length;
      if (!truncated && headLen + tail.length + chunk.length <= maxBytes) {
        head.push(chunk);
        headLen += chunk.length;
        return;
      }
      if (!truncated) {
        truncated = true;
        const combined = Buffer.concat([...head, chunk]);
        head.length = 0;
        const keepHead = combined.subarray(0, headCap);
        head.push(keepHead);
        headLen = keepHead.length;
        tail = tailCap > 0 ? Buffer.from(combined.subarray(Math.max(headCap, combined.length - tailCap))) : Buffer.alloc(0);
        return;
      }
      if (tailCap > 0) {
        if (chunk.length >= tailCap) tail = Buffer.from(chunk.subarray(chunk.length - tailCap));
        else {
          const next = Buffer.concat([tail, chunk]);
          tail = next.length > tailCap ? Buffer.from(next.subarray(next.length - tailCap)) : next;
        }
      }
    },
    get truncated() { return truncated; },
    toString() {
      if (!truncated) return Buffer.concat(head).toString('utf8');
      const dropped = Math.max(0, total - headLen - tail.length);
      return Buffer.concat(head).toString('utf8') + `\n… [${dropped} bytes omitted] …\n` + tail.toString('utf8');
    }
  };
}

let cachedPsBinary;
// All processes inherit the OS sandbox. A separate process group is killed even
// after the shell exits, so ordinary background children cannot outlive a call.
async function spawnBounded(executable, args, { cwd, env, timeoutMs, signal, input, maxOutputBytes = RUNNER_LIMITS.maxOutputBytes, onOutput, sampleDescendants = true } = {}) {
  if (cachedPsBinary === undefined) cachedPsBinary = await resolvePsBinary();
  const psBin = sampleDescendants ? cachedPsBinary : null;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let child, timer, grace, monitor, sampling = false, detachedObserved = false, drainUncertain = false, settled = false, timedOut = false, cancelled = false;
    const stdoutBuf = boundedStreamBuffer(maxOutputBytes);
    const stderrBuf = boundedStreamBuffer(Math.max(16384, Math.floor(maxOutputBytes / 2)));
    const observed = new Set();
    const kill = () => { for (const pid of observed) { try { process.kill(pid, 'SIGKILL'); } catch {} } if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} try { child.kill('SIGKILL'); } catch {} } };
    const finish = (cause, code = null, sig = null) => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(grace); clearInterval(monitor); signal?.removeEventListener('abort', abort); kill();
      if (cause) reject(cause); else resolve({ ok: true, exitCode: code, signal: sig, stdout: stdoutBuf.toString(), stderr: stderrBuf.toString(), timedOut, cancelled, truncated: stdoutBuf.truncated || stderrBuf.truncated, detachedObserved, drainUncertain, durationMs: Date.now() - started });
    };
    const stop = () => { kill(); grace ||= setTimeout(() => { drainUncertain = true; finish(null, null, 'SIGKILL'); }, 1000); };
    const abort = () => { cancelled = true; stop(); };
    try { child = spawn(executable, args, { cwd, env, detached: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }); }
    catch (cause) { finish(cause); return; }
    // Best-effort lineage sampling catches observed setsid descendants on macOS
    // (on Linux, bwrap --unshare-pid --die-with-parent enforces PID tree teardown in the kernel).
    if (psBin) {
      const sample = () => {
        if (sampling || settled || !child.pid) return; sampling = true;
        const ps = spawn(psBin, ['-axo', 'pid=,ppid=,pgid='], { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'ignore'] });
        let listing = ''; ps.stdout.on('data', bytes => { if (listing.length < 1024 * 1024) listing += bytes; });
        ps.on('error', () => { sampling = false; });
        ps.on('close', () => {
          sampling = false; if (settled) return;
          const rows = listing.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
          const family = new Set([child.pid, ...observed]); let added = true;
          while (added) { added = false; for (const [pid, ppid] of rows) if (family.has(ppid) && !family.has(pid)) { family.add(pid); observed.add(pid); added = true; } }
          for (const [pid, , pgid] of rows) if (observed.has(pid) && pgid !== child.pid) { detachedObserved = true; try { process.kill(pid, 'SIGKILL'); } catch {} }
        });
      };
      sample(); monitor = setInterval(sample, 25); monitor.unref();
    }
    let streamedBytes = 0;
    const receive = (buf, streamName) => bytes => {
      buf.push(bytes);
      if (typeof onOutput === 'function' && streamedBytes < maxOutputBytes) {
        const chunk = bytes.subarray(0, Math.min(bytes.length, maxOutputBytes - streamedBytes));
        streamedBytes += chunk.length;
        try { onOutput(streamName, chunk.toString('utf8')); } catch {}
      }
    };
    child.stdout.on('data', receive(stdoutBuf, 'stdout')); child.stderr.on('data', receive(stderrBuf, 'stderr'));
    child.on('error', cause => finish(cause));
    if (input !== undefined) {
      child.stdin.on('error', cause => { if (cause.code !== 'EPIPE') finish(cause); });
      child.stdin.end(input);
    }
    // exit fires before close; kill children holding inherited pipe handles.
    child.on('exit', () => { kill(); grace ||= setTimeout(() => { drainUncertain = true; finish(null, child.exitCode, child.signalCode); }, 1000); });
    child.on('close', (code, sig) => finish(null, code, sig));
    timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  });
}

// Trusted worker code is loaded by exact filename. Candidate files are supplied
// through stdin. The worker needs neither a writable directory nor a child process.
export async function runReadOnlyWorker(entry, modules, input, { signal, timeoutMs }) {
  if (!isSandboxSupportedPlatform()) throw fault('ISOLATION_UNAVAILABLE', 'Fixture evaluation requires macOS Seatbelt or Linux bubblewrap (bwrap).');
  if (signal?.aborted) throw fault('EVALUATION_CANCELLED', 'Evaluation cancelled.');
  const node = await fs.realpath(process.execPath);
  const files = await Promise.all([entry, ...modules].map(async filename => {
    const canonical = await fs.realpath(filename);
    if (canonical !== filename || !(await fs.stat(canonical)).isFile())
      throw fault('ISOLATION_UNAVAILABLE', 'Fixture worker modules must be regular files at their canonical paths.');
    return canonical;
  }));
  if (process.platform === 'linux') {
    const bwrap = await findBwrapBinary();
    if (!bwrap) throw fault('ISOLATION_UNAVAILABLE', 'Linux fixture evaluation requires bubblewrap (bwrap). Install it with: sudo apt install bubblewrap');
    const systemEntries = await inspectHostMountEntries(LINUX_WORKER_READ_CANDIDATES);
    const args = bwrapWorkerArgs({ nodeFile: node, files, systemEntries, entry });
    return spawnBounded(bwrap, args, {
      cwd: '/', env: { NODE_NO_WARNINGS: '1' }, input, signal, timeoutMs, maxOutputBytes: 512000, sampleDescendants: false,
    });
  }
  const literals = names => names.map(name => '(literal ' + sbQuote(name) + ')').join(' ');
  const ancestors = new Set(['/']);
  for (const file of [node, ...files]) {
    for (let dir = path.dirname(file); dir !== '/'; dir = path.dirname(dir)) ancestors.add(dir);
  }
  const profile = [
    '(version 1)', '(deny default)',
    '(allow process-exec ' + literals([node]) + ')',
    '(allow sysctl-read)', '(allow signal (target self))',
    '(allow file-read-metadata ' + literals([...ancestors]) + ')',
    '(allow file-read* file-map-executable ' + literals([node, ...files]) +
      ' (subpath "/System/Library") (subpath "/System/Cryptexes") (subpath "/usr/lib") (subpath "/Library/Apple"))',
    '(allow file-read* (literal "/") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random") (literal "/private/etc/localtime"))',
  ].join('\n');
  return spawnBounded('/usr/bin/sandbox-exec', ['-p', profile, node, '--experimental-vm-modules',
    '--disable-proto=throw', '--max-old-space-size=128', entry], {
    cwd: '/', env: { NODE_NO_WARNINGS: '1' }, input, signal, timeoutMs, maxOutputBytes: 512000,
  });
}

/** No host fallback: unsupported or denied isolation is an explicit failure. */
export async function runCommand(task, { command, cwd = '.', timeoutMs } = {}, { signal, onOutput, extraEnv = null } = {}) {
  const grant = validateExecution(task.execution);
  if (!grant.enabled) throw fault('EXECUTION_DENIED', 'The owner has not enabled command execution for this task.');
  if (!isSandboxSupportedPlatform()) throw fault('ISOLATION_UNAVAILABLE', 'Command execution requires macOS Seatbelt or Linux bubblewrap (bwrap); disabled on this platform.');
  if (typeof command !== 'string' || !command.trim() || command.includes('\0') || command.length > RUNNER_LIMITS.maxCommandChars) throw fault('INVALID_TOOL', 'Command must be nonempty and at most 16000 characters.');
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > RUNNER_LIMITS.maxTimeoutMs)) throw fault('INVALID_TOOL', 'Command timeout is outside the runner limits.');
  if (signal?.aborted) throw fault('EXECUTION_CANCELLED', 'Command cancelled before dispatch.');
  const { root, cwd: directory } = await resolveDirectory(task.workspace, cwd);
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'g0dc0d3-run-')));
  try {
    const [runtime, toolchainRoots] = await Promise.all([nodeRuntimePaths(), existingToolchainRoots()]);
    const node = runtime.nodeFile;
    // Home, npm cache, temporary files and configuration are private to this call.
    const home = path.join(scratch, 'home'), temporary = path.join(scratch, 'tmp');
    await fs.mkdir(home); await fs.mkdir(temporary);
    const binCandidates = process.platform === 'linux' ? ['/usr/local/bin', '/snap/bin'] : ['/opt/homebrew/bin', '/usr/local/bin'];
    const extraBins = binCandidates.filter(b => toolchainRoots.some(r => b === r || b.startsWith(r + '/')));
    const env = { PATH: [path.dirname(node), ...extraBins, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'), HOME: home, TMPDIR: temporary, TMP: temporary, TEMP: temporary, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', NO_COLOR: '1', TERM: 'dumb', CI: '1', npm_config_cache: path.join(home, 'npm-cache'), npm_config_userconfig: path.join(home, 'npmrc'), npm_config_globalconfig: path.join(home, 'global-npmrc'), npm_config_prefix: path.join(home, 'npm-prefix'), npm_config_update_notifier: 'false', DO_NOT_TRACK: '1', G0DC0D3_EXECUTION: 'sandboxed' };
    if (extraEnv && typeof extraEnv === 'object' && !Array.isArray(extraEnv)) {
      for (const [k, v] of Object.entries(extraEnv)) {
        if (/^G0D_HOOK_[A-Z0-9_]+$/.test(k) && typeof v === 'string' && !v.includes('\0')) {
          env[k] = v.slice(0, 2048);
        }
      }
    }

    if (process.platform === 'linux') {
      const bwrap = await findBwrapBinary();
      if (!bwrap) throw fault('ISOLATION_UNAVAILABLE', 'Linux command execution requires bubblewrap (bwrap). Install it with: sudo apt install bubblewrap');
      // Create chmod 0000 sentinels outside writable home/tmp mounts to mask .git and .g0dc0d3 with EACCES.
      const deniedDir = path.join(scratch, '.denied-dir');
      const deniedFile = path.join(scratch, '.denied-file');
      await fs.mkdir(deniedDir, { mode: 0o000 });
      await fs.writeFile(deniedFile, '', { mode: 0o000 });
      await fs.chmod(deniedDir, 0o000);
      await fs.chmod(deniedFile, 0o000);
      const maskedDirs = [], maskedFiles = [];
      for (const name of ['.git', '.g0dc0d3']) {
        const candidate = path.join(root, name);
        try {
          const st = await fs.lstat(candidate);
          if (st.isDirectory()) maskedDirs.push(candidate);
          else maskedFiles.push(candidate);
        } catch {}
      }
      const [systemEntries, runtimeFileEntries] = await Promise.all([
        inspectHostMountEntries(LINUX_SYSTEM_READ_CANDIDATES),
        inspectHostMountEntries(runtime.runtimeFiles),
      ]);
      let resolvConfRealPath = null;
      if (grant.network) {
        try { resolvConfRealPath = await fs.realpath('/etc/resolv.conf'); } catch {}
      }
      const common = {
        workspace: root, cwd: directory, scratch, homeDir: home, tmpDir: temporary, deniedDir, deniedFile,
        ...runtime, runtimeFileEntries, toolchainRoots, systemEntries, resolvConfRealPath, maskedDirs, maskedFiles,
        env, network: grant.network,
      };
      // Real launch probe: fails closed if user namespaces / AppArmor deny bwrap entry.
      const probeArgs = bwrapCommandArgs({ ...common, command: [node, '-e', 'process.exit(0)'] });
      const probe = await spawnBounded(bwrap, probeArgs, { cwd: directory, env, timeoutMs: 2500, signal, sampleDescendants: false });
      if (probe.exitCode !== 0 || probe.timedOut || probe.cancelled) {
        throw fault(
          probe.cancelled ? 'EXECUTION_CANCELLED' : 'ISOLATION_UNAVAILABLE',
          `Could not enter Linux bwrap sandbox (exit ${probe.exitCode}, signal ${probe.signal}, timeout ${probe.timedOut}): ${probe.stderr.slice(0, 300)}`
        );
      }
      if (signal?.aborted) throw fault('EXECUTION_CANCELLED', 'Command cancelled before dispatch.');
      const runArgs = bwrapCommandArgs({ ...common, command });
      const result = await spawnBounded(bwrap, runArgs, { cwd: directory, env, timeoutMs: Math.min(timeoutMs ?? grant.timeoutMs, grant.timeoutMs), signal, onOutput, sampleDescendants: false });
      return { ...result, executionBoundary: 'linux-bwrap', network: grant.network, lifecycleBoundary: 'linux-pid-namespace-die-with-parent' };
    }

    const profile = sandboxProfile({ workspace: root, scratch, ...runtime, toolchainRoots, network: grant.network });
    const profileFile = path.join(scratch, 'runner.sb'); await fs.writeFile(profileFile, profile, { mode: 0o600 });
    // This is a real launch probe, not binary-existence detection. It fails
    // closed when Seatbelt cannot be entered (including nested sandbox denial).
    const probe = await spawnBounded('/usr/bin/sandbox-exec', ['-f', profileFile, node, '-e', 'process.exit(0)'], { cwd: directory, env, timeoutMs: 2000, signal });
    if (probe.exitCode !== 0 || probe.timedOut || probe.cancelled) throw fault(probe.cancelled ? 'EXECUTION_CANCELLED' : 'ISOLATION_UNAVAILABLE', `Could not enter the required OS sandbox (exit ${probe.exitCode}, signal ${probe.signal}, timeout ${probe.timedOut}): ${probe.stderr.slice(0, 300)}`);
    if (signal?.aborted) throw fault('EXECUTION_CANCELLED', 'Command cancelled before dispatch.');
    const result = await spawnBounded('/usr/bin/sandbox-exec', ['-f', profileFile, '/bin/sh', '-c', 'umask 077; ulimit -f 262144; ' + command], { cwd: directory, env, timeoutMs: Math.min(timeoutMs ?? grant.timeoutMs, grant.timeoutMs), signal, onOutput });
    return { ...result, executionBoundary: 'macos-seatbelt', network: grant.network, lifecycleBoundary: 'experimental-foreground-best-effort-descendant-cleanup' };
  } finally {
    // Restore permissions on chmod 0000 sentinels before recursive cleanup.
    await fs.chmod(path.join(scratch, '.denied-dir'), 0o700).catch(() => {});
    await fs.chmod(path.join(scratch, '.denied-file'), 0o600).catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
