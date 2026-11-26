import { randomUUID } from 'node:crypto';
import { openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, chmodSync } from 'node:fs';
import path from 'node:path';

const error = (code, message) => Object.assign(new Error(message), { code });

export function normalizeMemoryScope(scope = 'global') {
  if (scope === undefined || scope === null || scope === '') return 'global';
  if (typeof scope !== 'string') throw error('INVALID_MEMORY', 'Memory scope must be "global" or "project:<path>".');
  const trimmed = scope.trim();
  if (trimmed === 'global') return 'global';
  if (trimmed.startsWith('project:')) {
    const rest = trimmed.slice('project:'.length).trim();
    if (!rest || rest.length > 500 || /[\0\r\n]/.test(rest)) {
      throw error('INVALID_MEMORY', 'Project memory scope must be "project:<path>" with 1–500 printable characters.');
    }
    return `project:${rest}`;
  }
  throw error('INVALID_MEMORY', 'Memory scope must be "global" or "project:<path>".');
}

function normalizeTags(tags = []) {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags) || tags.length > 20) {
    throw error('INVALID_MEMORY', 'Memory tags must be an array of at most 20 strings.');
  }
  const seen = new Set();
  const normalized = [];
  for (const raw of tags) {
    if (typeof raw !== 'string') throw error('INVALID_MEMORY', 'Each memory tag must be a string.');
    const tag = raw.trim();
    if (!tag || tag.length > 40 || /[\0\r\n]/.test(tag)) {
      throw error('INVALID_MEMORY', 'Each memory tag must be 1–40 single-line characters.');
    }
    const key = tag.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(tag);
    }
  }
  return normalized;
}

/**
 * Tokenize arbitrary user or objective text into a safe FTS5 query.
 * Every token is stripped of punctuation/operators and double-quoted so
 * FTS5 keywords (AND, OR, NOT, NEAR) or punctuation can never trigger syntax errors.
 */
export function sanitizeFtsQuery(query) {
  if (typeof query !== 'string') return '';
  const rawTokens = query.match(/[\p{L}\p{N}_]+/gu) || [];
  const seen = new Set();
  const tokens = [];
  for (const token of rawTokens) {
    if (token.length < 2 && rawTokens.length > 1) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push(`"${token.replace(/"/g, '')}"`);
    if (tokens.length >= 16) break;
  }
  return tokens.join(' OR ');
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, ch => '\\' + ch);
}

function hydrateRow(row) {
  if (!row) return null;
  let tags = [];
  try {
    const parsed = JSON.parse(row.tags);
    if (Array.isArray(parsed)) tags = parsed;
  } catch {}
  return {
    id: row.id,
    scope: row.scope,
    title: row.title,
    content: row.content,
    tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function formatMemoryMarkdown(memories = []) {
  const lines = [
    '# G0DC0D3 Persistent Memory',
    '',
    '> Local human-auditable snapshot of cross-session memories stored in `state.sqlite`.',
    ''
  ];
  if (!memories.length) {
    lines.push('_No saved memories yet._', '');
    return lines.join('\n');
  }
  const byScope = new Map();
  for (const mem of memories) {
    if (!byScope.has(mem.scope)) byScope.set(mem.scope, []);
    byScope.get(mem.scope).push(mem);
  }
  const scopes = [...byScope.keys()].sort((a, b) => {
    if (a === 'global' && b !== 'global') return -1;
    if (b === 'global' && a !== 'global') return 1;
    return a.localeCompare(b, 'en');
  });
  for (const scope of scopes) {
    const heading = scope === 'global' ? 'Global' : `Project: ${scope.slice('project:'.length)}`;
    lines.push(`## ${heading}`, '');
    for (const mem of byScope.get(scope)) {
      lines.push(`### ${mem.title}`);
      const meta = [`id: \`${mem.id}\``, `updated: ${mem.updatedAt}`];
      if (mem.tags?.length) meta.push(`tags: ${mem.tags.map(t => `\`${t}\``).join(', ')}`);
      lines.push(`_${meta.join(' · ')}_`, '');
      lines.push(mem.content, '');
    }
  }
  return lines.join('\n');
}

export class MemoryStore {
  constructor(store) {
    if (!store || !store.db) throw new Error('Store instance is required for MemoryStore');
    this.store = store;
    this.db = store.db;
    this.dataDir = store.dataDir;
    this.memoryFile = path.join(this.dataDir, 'memory.md');
  }

  get hasFts() {
    return Boolean(this.store.hasMemoryFts);
  }

  saveMemory({ title, content, scope = 'global', tags = [] } = {}) {
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 120 || /[\0\r\n]/.test(title)) {
      throw error('INVALID_MEMORY', 'Memory title must be 1–120 single-line characters.');
    }
    if (typeof content !== 'string' || !content.trim() || content.trim().length > 4000 || content.includes('\0')) {
      throw error('INVALID_MEMORY', 'Memory content must be 1–4000 characters without NUL bytes.');
    }
    const cleanTitle = title.trim();
    const cleanContent = content.trim();
    const cleanScope = normalizeMemoryScope(scope);
    const cleanTags = normalizeTags(tags);
    const now = new Date().toISOString();

    const { memory, created } = this.store.transaction(() => {
      const existing = this.db.prepare(
        'SELECT id, scope, title, content, tags, created_at, updated_at FROM memories WHERE scope = ? AND lower(title) = lower(?)'
      ).get(cleanScope, cleanTitle);

      const id = existing ? existing.id : randomUUID();
      const createdAt = existing ? existing.created_at : now;
      const tagsJson = JSON.stringify(cleanTags);

      if (existing) {
        this.db.prepare(
          'UPDATE memories SET title = ?, content = ?, tags = ?, updated_at = ? WHERE id = ?'
        ).run(cleanTitle, cleanContent, tagsJson, now, id);
      } else {
        this.db.prepare(
          'INSERT INTO memories(id, scope, title, content, tags, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)'
        ).run(id, cleanScope, cleanTitle, cleanContent, tagsJson, createdAt, now);
      }

      if (this.hasFts) {
        try {
          this.db.prepare('DELETE FROM memories_fts WHERE id = ?').run(id);
          this.db.prepare('INSERT INTO memories_fts(id, scope, title, content, tags) VALUES(?, ?, ?, ?, ?)').run(
            id, cleanScope, cleanTitle, cleanContent, cleanTags.join(' ')
          );
        } catch {
          // Keep primary table authoritative even if FTS index has an issue.
        }
      }

      const saved = this.db.prepare(
        'SELECT id, scope, title, content, tags, created_at, updated_at FROM memories WHERE id = ?'
      ).get(id);
      return { memory: hydrateRow(saved), created: !existing };
    });

    this.syncMarkdown();
    return { ok: true, memory, created };
  }

  deleteMemory(id) {
    if (typeof id !== 'string' || !id.trim() || id.length > 120) {
      throw error('INVALID_MEMORY', 'Memory id must be a non-empty string.');
    }
    const cleanId = id.trim();
    const deleted = this.store.transaction(() => {
      const info = this.db.prepare('DELETE FROM memories WHERE id = ?').run(cleanId);
      if (this.hasFts) {
        try { this.db.prepare('DELETE FROM memories_fts WHERE id = ?').run(cleanId); } catch {}
      }
      return Number(info.changes) > 0;
    });
    if (deleted) this.syncMarkdown();
    return { ok: true, id: cleanId, deleted };
  }

  listMemories({ scope = null, limit = 50 } = {}) {
    const cap = Math.max(1, Math.min(200, Math.trunc(Number(limit)) || 50));
    let rows;
    if (scope && scope !== 'all') {
      const normalized = normalizeMemoryScope(scope);
      rows = this.db.prepare(
        'SELECT id, scope, title, content, tags, created_at, updated_at FROM memories WHERE scope = ? ORDER BY updated_at DESC LIMIT ?'
      ).all(normalized, cap);
    } else {
      rows = this.db.prepare(
        `SELECT id, scope, title, content, tags, created_at, updated_at
         FROM memories
         ORDER BY (CASE WHEN scope = 'global' THEN 0 ELSE 1 END) ASC, scope ASC, updated_at DESC
         LIMIT ?`
      ).all(cap);
    }
    return { ok: true, memories: rows.map(hydrateRow) };
  }

  searchMemories({ query = '', scope = null, includeGlobal = true, limit = 10 } = {}) {
    const cap = Math.max(1, Math.min(50, Math.trunc(Number(limit)) || 10));
    const trimmedQuery = typeof query === 'string' ? query.trim() : '';

    let scopeWhere = '';
    const scopeParams = [];
    let priorityScope = '';

    if (scope && scope !== 'all') {
      const normalized = normalizeMemoryScope(scope);
      if (normalized === 'global') {
        scopeWhere = "m.scope = 'global'";
      } else {
        priorityScope = normalized;
        if (includeGlobal) {
          scopeWhere = "(m.scope = ? OR m.scope = 'global')";
          scopeParams.push(normalized);
        } else {
          scopeWhere = 'm.scope = ?';
          scopeParams.push(normalized);
        }
      }
    }

    const orderPriority = '(CASE WHEN m.scope = ? THEN 0 WHEN m.scope = \'global\' THEN 1 ELSE 2 END) ASC';

    if (!trimmedQuery) {
      const whereClause = scopeWhere ? `WHERE ${scopeWhere}` : '';
      const rows = this.db.prepare(
        `SELECT m.id, m.scope, m.title, m.content, m.tags, m.created_at, m.updated_at
         FROM memories m
         ${whereClause}
         ORDER BY ${orderPriority}, m.updated_at DESC
         LIMIT ?`
      ).all(...scopeParams, priorityScope, cap);
      return { ok: true, memories: rows.map(hydrateRow) };
    }

    // Attempt FTS5 search first when available and query has searchable tokens.
    const ftsQuery = this.hasFts ? sanitizeFtsQuery(trimmedQuery) : '';
    if (this.hasFts && ftsQuery) {
      try {
        const whereClause = scopeWhere ? `WHERE memories_fts MATCH ? AND ${scopeWhere}` : 'WHERE memories_fts MATCH ?';
        const rows = this.db.prepare(
          `SELECT m.id, m.scope, m.title, m.content, m.tags, m.created_at, m.updated_at
           FROM memories_fts
           JOIN memories m ON m.id = memories_fts.id
           ${whereClause}
           ORDER BY ${orderPriority}, bm25(memories_fts) ASC, m.updated_at DESC
           LIMIT ?`
        ).all(ftsQuery, ...scopeParams, priorityScope, cap);
        if (rows.length > 0) return { ok: true, memories: rows.map(hydrateRow) };
      } catch {
        // Fall through cleanly to SQL LIKE fallback.
      }
    }

    // Fallback: safe SQL LIKE matching on title, content, and tags.
    const pattern = `%${escapeLike(trimmedQuery.toLowerCase())}%`;
    const likeExpr = `(lower(m.title) LIKE ? ESCAPE '\\' OR lower(m.content) LIKE ? ESCAPE '\\' OR lower(m.tags) LIKE ? ESCAPE '\\')`;
    const whereClause = scopeWhere ? `WHERE ${scopeWhere} AND ${likeExpr}` : `WHERE ${likeExpr}`;
    const rows = this.db.prepare(
      `SELECT m.id, m.scope, m.title, m.content, m.tags, m.created_at, m.updated_at
       FROM memories m
       ${whereClause}
       ORDER BY ${orderPriority}, m.updated_at DESC
       LIMIT ?`
    ).all(...scopeParams, pattern, pattern, pattern, priorityScope, cap);
    return { ok: true, memories: rows.map(hydrateRow) };
  }

  relevantForTask(task, { limit = 6, maxChars = 1800 } = {}) {
    if (!task || task.fixtureId || task.crewMember) return [];
    const projectScope = task.sourcePath ? `project:${task.sourcePath}` : null;
    const queryParts = [
      task.title || '',
      task.objective || '',
      ...(Array.isArray(task.followups) ? task.followups.slice(-2).map(f => f?.message || '') : [])
    ].filter(Boolean);
    const query = queryParts.join(' ').slice(0, 600);

    const picked = [];
    const seen = new Set();
    const pushAll = items => {
      for (const item of items) {
        if (picked.length >= limit) break;
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        picked.push(item);
      }
    };

    if (query.trim()) {
      const matched = this.searchMemories({
        query,
        scope: projectScope || 'global',
        includeGlobal: true,
        limit
      });
      pushAll(matched.memories);
    }

    if (picked.length < limit) {
      const recent = this.searchMemories({
        query: '',
        scope: projectScope || 'global',
        includeGlobal: true,
        limit
      });
      pushAll(recent.memories);
    }

    // Re-sort so project-scoped memories stay ahead of global memories.
    if (projectScope) {
      picked.sort((a, b) => {
        const ap = a.scope === projectScope ? 0 : 1;
        const bp = b.scope === projectScope ? 0 : 1;
        return ap - bp;
      });
    }

    const bounded = [];
    let usedChars = 0;
    for (const mem of picked) {
      const header = `[${mem.scope === 'global' ? 'global' : 'project'}] ${mem.title}${mem.tags?.length ? ` (${mem.tags.join(', ')})` : ''}: `;
      const remaining = maxChars - usedChars;
      if (remaining < header.length + 24) break;
      const maxBody = remaining - header.length - 2;
      const content = mem.content.length > maxBody ? `${mem.content.slice(0, Math.max(0, maxBody - 1)).trimEnd()}…` : mem.content;
      usedChars += header.length + content.length + 2;
      bounded.push({
        id: mem.id,
        scope: mem.scope,
        title: mem.title,
        content,
        tags: mem.tags,
        updatedAt: mem.updatedAt
      });
    }
    return bounded;
  }

  syncMarkdown() {
    const { memories } = this.listMemories({ limit: 200 });
    const markdown = formatMemoryMarkdown(memories);
    const tmpPath = path.join(this.dataDir, `.memory.md.tmp.${randomUUID()}`);
    let handle;
    try {
      handle = openSync(tmpPath, 'wx', 0o600);
      writeFileSync(handle, markdown, 'utf8');
      fsyncSync(handle);
      closeSync(handle);
      handle = undefined;
      renameSync(tmpPath, this.memoryFile);
      try { chmodSync(this.memoryFile, 0o600); } catch {}
    } catch (cause) {
      if (handle !== undefined) try { closeSync(handle); } catch {}
      try { unlinkSync(tmpPath); } catch {}
      throw cause;
    }
  }
}
