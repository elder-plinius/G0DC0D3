import { randomUUID } from 'node:crypto';
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';

export const SKILL_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,48}$/;
const MAX_SKILL_BYTES = 32 * 1024;
const VALID_MODES = new Set(['plan', 'build', 'any']);
const error = (code, message) => Object.assign(new Error(message), { code });

function unquoteYaml(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try { return JSON.parse(trimmed); } catch { return trimmed.slice(1, -1); }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseSkillMarkdown(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n');
  const meta = { name: null, description: '', mode: null };
  let body = text;
  if (text.startsWith('---\n') || text === '---') {
    const closeIdx = text.indexOf('\n---', 3);
    if (closeIdx > 0) {
      const header = text.slice(4, closeIdx);
      const afterClose = text.slice(closeIdx + 4);
      if (afterClose === '' || afterClose.startsWith('\n')) {
        body = afterClose.replace(/^\n/, '');
        for (const line of header.split('\n')) {
          const match = line.match(/^\s*([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
          if (!match) continue;
          const key = match[1].toLowerCase();
          const val = unquoteYaml(match[2]);
          if (key === 'name' && val) meta.name = val;
          else if (key === 'description') meta.description = val.slice(0, 240);
          else if (key === 'mode' && val) meta.mode = val.toLowerCase();
        }
      }
    }
  }
  return { meta, body: body.trim() };
}

async function resolveNoSymlinkPath(rootDir, segments) {
  let rootReal;
  try {
    const rootStat = await fs.lstat(rootDir);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;
    rootReal = await fs.realpath(rootDir);
  } catch {
    return null;
  }
  let current = rootReal;
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\') || segment.includes('\0')) {
      return null;
    }
    current = path.join(current, segment);
    let stat;
    try { stat = await fs.lstat(current); }
    catch { return null; }
    if (stat.isSymbolicLink()) return null;
    let real;
    try { real = await fs.realpath(current); }
    catch { return null; }
    if (real !== current || !real.startsWith(rootReal + path.sep)) return null;
  }
  return { rootReal, target: current };
}

async function readSafeSkillFile(rootReal, filePath) {
  let stat;
  try { stat = await fs.lstat(filePath); }
  catch { return null; }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_SKILL_BYTES) return null;
  let real;
  try { real = await fs.realpath(filePath); }
  catch { return null; }
  if (real !== filePath || !real.startsWith(rootReal + path.sep)) return null;

  let handle;
  try {
    handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const fstat = await handle.stat();
    if (!fstat.isFile() || fstat.size > MAX_SKILL_BYTES) return null;
    const buf = Buffer.alloc(MAX_SKILL_BYTES + 1);
    let offset = 0;
    while (offset < buf.length) {
      const { bytesRead } = await handle.read(buf, offset, buf.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > MAX_SKILL_BYTES) return null;
    const slice = buf.subarray(0, offset);
    if (slice.includes(0)) return null;
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(slice);
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function scanFlatMarkdownDir(rootDir, relSegments, { scope, source, skillsByName }) {
  const resolved = await resolveNoSymlinkPath(rootDir, relSegments);
  if (!resolved) return;
  let entries;
  try { entries = await fs.readdir(resolved.target, { withFileTypes: true }); }
  catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith('.md')) continue;
    const full = path.join(resolved.target, entry.name);
    const content = await readSafeSkillFile(resolved.rootReal, full);
    if (content === null) continue;
    const { meta, body } = parseSkillMarkdown(content);
    if (!body) continue;
    const stem = entry.name.slice(0, -3).toLowerCase();
    const slug = (meta.name || stem).toLowerCase();
    if (!SKILL_SLUG_RE.test(slug)) continue;
    const mode = meta.mode && VALID_MODES.has(meta.mode) ? meta.mode : null;
    skillsByName.set(slug, {
      name: slug,
      command: `/${slug}`,
      description: meta.description || body.split('\n').find(l => l.trim())?.replace(/^#+\s*/, '').slice(0, 140) || '',
      mode,
      source,
      scope,
      body
    });
  }
}

async function scanNestedSkillsDir(rootDir, relSegments, { scope, source, skillsByName }) {
  const resolved = await resolveNoSymlinkPath(rootDir, relSegments);
  if (!resolved) return;
  let entries;
  try { entries = await fs.readdir(resolved.target, { withFileTypes: true }); }
  catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const subDir = path.join(resolved.target, entry.name);
    let subStat;
    try { subStat = await fs.lstat(subDir); } catch { continue; }
    if (subStat.isSymbolicLink() || !subStat.isDirectory()) continue;
    const skillFile = path.join(subDir, 'SKILL.md');
    const content = await readSafeSkillFile(resolved.rootReal, skillFile);
    if (content === null) continue;
    const { meta, body } = parseSkillMarkdown(content);
    if (!body) continue;
    const slug = (meta.name || entry.name).toLowerCase();
    if (!SKILL_SLUG_RE.test(slug)) continue;
    const mode = meta.mode && VALID_MODES.has(meta.mode) ? meta.mode : null;
    skillsByName.set(slug, {
      name: slug,
      command: `/${slug}`,
      description: meta.description || body.split('\n').find(l => l.trim())?.replace(/^#+\s*/, '').slice(0, 140) || '',
      mode,
      source,
      scope,
      body
    });
  }
}

export async function discoverSkills({ dataDir, workspace, sourcePath } = {}) {
  const skillsByName = new Map();

  if (typeof dataDir === 'string' && dataDir) {
    await scanFlatMarkdownDir(dataDir, ['commands'], { scope: 'global', source: 'global:commands', skillsByName });
    await scanFlatMarkdownDir(dataDir, ['skills'], { scope: 'global', source: 'global:skills', skillsByName });
  }

  const projectRoots = [];
  for (const candidate of [sourcePath, workspace]) {
    if (typeof candidate !== 'string' || !candidate) continue;
    try {
      const resolved = await fs.realpath(candidate);
      if (!projectRoots.includes(resolved)) projectRoots.push(resolved);
    } catch {}
  }

  for (const root of projectRoots) {
    await scanFlatMarkdownDir(root, ['.claude', 'commands'], { scope: 'project', source: '.claude/commands', skillsByName });
    await scanFlatMarkdownDir(root, ['.opencode', 'commands'], { scope: 'project', source: '.opencode/commands', skillsByName });
    await scanFlatMarkdownDir(root, ['.g0dc0d3', 'commands'], { scope: 'project', source: '.g0dc0d3/commands', skillsByName });
    await scanNestedSkillsDir(root, ['.g0dc0d3', 'skills'], { scope: 'project', source: '.g0dc0d3/skills', skillsByName });
  }

  return [...skillsByName.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

export async function saveUserSkill(dataDir, { name, description = '', body, mode = null } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw error('INVALID_SKILL', 'dataDir is required.');
  if (typeof name !== 'string' || !SKILL_SLUG_RE.test(name.trim())) {
    throw error('INVALID_SKILL', 'Skill name must match ^[a-z0-9][a-z0-9_-]{0,48}$.');
  }
  const slug = name.trim();
  if (description !== undefined && description !== null && (typeof description !== 'string' || description.length > 240 || /[\0\r\n]/.test(description))) {
    throw error('INVALID_SKILL', 'Skill description must be a single-line string of at most 240 characters.');
  }
  const cleanDescription = typeof description === 'string' ? description.trim() : '';
  let cleanMode = null;
  if (mode !== undefined && mode !== null && mode !== '') {
    if (typeof mode !== 'string' || !VALID_MODES.has(mode.trim().toLowerCase())) {
      throw error('INVALID_SKILL', 'Skill mode must be "plan", "build", or "any".');
    }
    cleanMode = mode.trim().toLowerCase();
  }
  if (typeof body !== 'string' || !body.trim() || body.includes('\0')) {
    throw error('INVALID_SKILL', 'Skill body must be a non-empty UTF-8 string without NUL bytes.');
  }
  const cleanBody = body.trim();

  const frontmatterLines = ['---', `name: ${slug}`];
  if (cleanDescription) frontmatterLines.push(`description: ${JSON.stringify(cleanDescription)}`);
  if (cleanMode) frontmatterLines.push(`mode: ${cleanMode}`);
  frontmatterLines.push('---', '');
  const fullContent = `${frontmatterLines.join('\n')}\n${cleanBody}\n`;
  if (Buffer.byteLength(fullContent, 'utf8') > MAX_SKILL_BYTES) {
    throw error('INVALID_SKILL', 'Skill file exceeds the 32 KiB size limit.');
  }

  const rootPath = path.resolve(dataDir);
  await fs.mkdir(rootPath, { recursive: true, mode: 0o700 });
  const rootReal = await fs.realpath(rootPath);
  const skillsDir = path.join(rootReal, 'skills');
  await fs.mkdir(skillsDir, { recursive: true, mode: 0o700 });
  const dirStat = await fs.lstat(skillsDir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw error('SYMLINK_DENIED', 'User skills directory cannot be a symbolic link.');
  }
  const target = path.join(skillsDir, `${slug}.md`);
  try {
    const existingStat = await fs.lstat(target);
    if (existingStat.isSymbolicLink()) throw error('SYMLINK_DENIED', 'Cannot overwrite a symbolic link.');
  } catch (cause) {
    if (cause.code !== 'ENOENT') throw cause;
  }

  const tmpPath = path.join(skillsDir, `.skill-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(tmpPath, 'wx', 0o600);
    await handle.writeFile(fullContent, 'utf8');
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tmpPath, target);
    await fs.chmod(target, 0o600).catch(() => {});
  } catch (cause) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(tmpPath).catch(() => {});
    throw cause;
  }

  return {
    name: slug,
    command: `/${slug}`,
    description: cleanDescription || cleanBody.split('\n').find(l => l.trim())?.replace(/^#+\s*/, '').slice(0, 140) || '',
    mode: cleanMode,
    source: 'global:skills',
    scope: 'global',
    body: cleanBody
  };
}

export async function deleteUserSkill(dataDir, name) {
  if (typeof dataDir !== 'string' || !dataDir) throw error('INVALID_SKILL', 'dataDir is required.');
  if (typeof name !== 'string' || !SKILL_SLUG_RE.test(name.trim())) {
    throw error('INVALID_SKILL', 'Skill name must match ^[a-z0-9][a-z0-9_-]{0,48}$.');
  }
  const slug = name.trim();
  let rootReal;
  try { rootReal = await fs.realpath(path.resolve(dataDir)); }
  catch (err) { if (err.code === 'ENOENT') return { ok: true, name: slug, deleted: false }; throw err; }
  const resolved = await resolveNoSymlinkPath(rootReal, ['skills', `${slug}.md`]);
  if (!resolved) return { ok: true, name: slug, deleted: false };
  const stat = await fs.lstat(resolved.target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw error('SYMLINK_DENIED', 'Refusing to delete a symbolic link or non-regular file.');
  }
  await fs.unlink(resolved.target);
  return { ok: true, name: slug, deleted: true };
}
