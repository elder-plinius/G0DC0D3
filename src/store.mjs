import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync, fsyncSync, linkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { emptyLearning, applyObservations, applyStrategyObservation, applyLearnedRefusalPattern, removeLearnedRefusalPattern, applyModelPreference, applyDomainOutcome } from './learning.mjs';

const json = value => JSON.stringify(value);
const parse = row => row ? JSON.parse(row.data) : undefined;
const safeParse = row => {
  if (!row) return undefined;
  try { return JSON.parse(row.data); } catch { return undefined; }
};

export class Store {
  constructor(dataDir) {
    this.dataDir = resolve(dataDir);
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    try { chmodSync(this.dataDir, 0o700); } catch {}
    this.lockPath = join(this.dataDir, 'owner.lock');
    this.ownerToken = randomUUID();
    this._acquireOwnership();
    try {
      this.db = new DatabaseSync(join(this.dataDir, 'state.sqlite'));
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(task_id,seq));
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS local_state(key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS learned_events(key TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS crews(id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_applications(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_application_backups(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, scope TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, tags TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_task ON events(task_id,seq);
      CREATE INDEX IF NOT EXISTS operations_task ON operations(task_id);
      CREATE INDEX IF NOT EXISTS crews_parent ON crews(parent_id);
      CREATE INDEX IF NOT EXISTS source_applications_task ON source_applications(task_id);
      CREATE INDEX IF NOT EXISTS memories_scope_title ON memories(scope, lower(title));`);
      this.hasMemoryFts = false;
      try {
        this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, scope, title, content, tags);`);
        this.hasMemoryFts = true;
      } catch {
        this.hasMemoryFts = false;
      }
    } catch (cause) { try { this.db?.close(); } catch {} this._releaseOwnership(); throw cause; }
    for (const file of ['state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm', 'owner.lock']) {
      try { chmodSync(join(this.dataDir, file), 0o600); } catch {}
    }
    this.closed = false;
    this._txDepth = 0;
  }
  _acquireOwnership() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const tmpPath = `${this.lockPath}.${randomUUID()}.tmp`;
      let handle;
      try {
        handle = openSync(tmpPath, 'wx', 0o600);
        writeFileSync(handle, json({ pid: process.pid, token: this.ownerToken, createdAt: new Date().toISOString() }));
        fsyncSync(handle);
        closeSync(handle);
        handle = undefined;
        linkSync(tmpPath, this.lockPath);
        try { unlinkSync(tmpPath); } catch {}
        return;
      } catch (cause) {
        if (handle !== undefined) { try { closeSync(handle); } catch {} handle = undefined; }
        try { unlinkSync(tmpPath); } catch {}
        if (cause.code !== 'EEXIST') throw cause;
        let raw, owner;
        try { raw = readFileSync(this.lockPath, 'utf8'); owner = JSON.parse(raw); }
        catch { throw Object.assign(new Error('Data directory has an unreadable ownership lock; inspect it before starting.'), { code: 'STORE_LOCKED' }); }
        if (!Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string') throw Object.assign(new Error('Data directory has an invalid ownership lock.'), { code: 'STORE_LOCKED' });
        let alive = true;
        try { process.kill(owner.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') alive = false; }
        if (alive) throw Object.assign(new Error(`Data directory is already owned by process ${owner.pid}.`), { code: 'STORE_LOCKED' });
        // Conservative stale-owner recovery. This PID/token protocol prevents
        // ordinary duplicate launches; it is not an OS advisory lock and cannot
        // protect against another same-user process deliberately replacing files.
        try { if (readFileSync(this.lockPath, 'utf8') === raw) unlinkSync(this.lockPath); }
        catch (readError) { if (readError.code !== 'ENOENT') throw readError; }
      }
    }
    throw Object.assign(new Error('Could not acquire data-directory ownership.'), { code: 'STORE_LOCKED' });
  }
  _releaseOwnership() {
    try { if (JSON.parse(readFileSync(this.lockPath, 'utf8')).token === this.ownerToken) unlinkSync(this.lockPath); }
    catch (cause) { if (cause.code !== 'ENOENT') { /* Leave uncertain locks for inspection. */ } }
  }
  transaction(fn) {
    const depth = this._txDepth || 0;
    this._txDepth = depth + 1;
    const sp = `sp_${depth}`;
    try {
      if (depth === 0) this.db.exec('BEGIN IMMEDIATE');
      else this.db.exec(`SAVEPOINT ${sp}`);
      const value = fn();
      if (depth === 0) this.db.exec('COMMIT');
      else this.db.exec(`RELEASE ${sp}`);
      return value;
    } catch (error) {
      try {
        if (depth === 0) {
          if (this.db.isTransaction !== false) this.db.exec('ROLLBACK');
        } else {
          this.db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
        }
      } catch {}
      throw error;
    } finally {
      this._txDepth = depth;
    }
  }
  getTask(id) { return parse(this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id)); }
  requireTask(id) { const task = this.getTask(id); if (!task) throw Object.assign(new Error('Task not found'), { code: 'TASK_NOT_FOUND' }); return task; }
  listTasks() { return this.db.prepare('SELECT data FROM tasks ORDER BY rowid DESC').all().map(safeParse).filter(Boolean); }
  createTask(task) {
    return this.transaction(() => {
      // This check belongs in the same transaction as insertion: concurrent callers
      // may both have awaited filesystem capture before arriving here.
      for (const existing of this.listTasks()) {
        const overlaps = existing.workspace === task.workspace || existing.workspace.startsWith(task.workspace + sep) || task.workspace.startsWith(existing.workspace + sep);
        if (!overlaps) continue;
        const unresolved = this.getOperations(existing.id).some(operation => !['succeeded', 'failed'].includes(operation.status));
        const crewOwns = ['preparing','running','verifying','applying','ready','paused'].includes(this.latestCrew(existing.id)?.status);
        if (!['completed', 'cancelled'].includes(existing.status) || unresolved || crewOwns) throw Object.assign(new Error('Another unfinished task owns this workspace or an overlapping directory.'), { code: 'WORKSPACE_BUSY' });
      }
      if (task.crewMember) {
        const crew = this.getCrew(task.crewMember.runId), parent = crew && this.requireTask(crew.parentId);
        if (!crew || !['running','verifying'].includes(crew.status) || crew.parentId !== task.crewMember.parentId || parent.epoch !== crew.parentEpoch || crew.members[task.crewMember.role] || Date.now() >= crew.deadlineAt) throw Object.assign(new Error('Crew no longer owns this worker creation.'), { code: 'STALE_RUN' });
        crew.members[task.crewMember.role] = task.id;
        task.providerNotBefore = { ...(parent.providerNotBefore || {}) };
        this._writeCrew(crew);
      }
      this.db.prepare('INSERT INTO tasks(id,data) VALUES(?,?)').run(task.id, json(task));
      this._appendEvent(task.id, 'task.created', { title: task.title });
      return this.getTask(task.id);
    });
  }
  _appendEvent(taskId, type, data = {}, time = new Date().toISOString()) {
    const task = this.requireTask(taskId);
    const seq = (task.eventSeq || 0) + 1;
    const event = { taskId, seq, type, time, data };
    const inserted = this.db.prepare('INSERT INTO events(task_id,seq,data) VALUES(?,?,?)').run(taskId, seq, json(event));
    task.eventSeq = seq;
    this.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(json(task), taskId);
    return { id: Number(inserted.lastInsertRowid), ...event };
  }
  appendEvent(taskId, type, data = {}) { return this.transaction(() => this._appendEvent(taskId, type, data)); }
  copyConversationHistory(targetId, events) {
    const types = new Set(['user.message', 'user.messages.applied', 'conversation.rewound', 'model.response', 'code.intent']);
    return this.transaction(() => {
      for (const event of events) if (types.has(event.type))
        this._appendEvent(targetId, event.type, { ...structuredClone(event.data),
          forkSource: { taskId: event.taskId, seq: event.seq } }, event.time);
    });
  }
  updateTask(id, mutate, type, data = {}) {
    return this.transaction(() => {
      const task = this.requireTask(id);
      const updated = mutate(task) || task;
      updated.id = id;
      updated.version = (task.version || 0) + 1;
      updated.updatedAt = new Date().toISOString();
      this.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(json(updated), id);
      if (type) this._appendEvent(id, type, typeof data === 'function' ? data(updated) : data);
      return this.getTask(id);
    });
  }
  getEvents(taskId, after = 0) {
    return this.db.prepare('SELECT id,data FROM events WHERE task_id=? AND seq>? ORDER BY seq').all(taskId, Number(after) || 0).map(row => ({ id: Number(row.id), ...JSON.parse(row.data) }));
  }
  getRecentEvents(taskId, limit = 80) {
    const count = Math.max(1, Math.min(1000, Math.trunc(limit) || 80));
    return this.db.prepare('SELECT id,data FROM events WHERE task_id=? ORDER BY seq DESC LIMIT ?').all(taskId, count).reverse().map(row => ({ id: Number(row.id), ...JSON.parse(row.data) }));
  }
  latestModelResponse(taskId) {
    const row = this.db.prepare(`SELECT json_extract(data,'$.data.response') AS reply FROM events
      WHERE task_id=? AND json_extract(data,'$.type')='model.response'
      AND coalesce(json_extract(data,'$.data.superseded'),0)=0 ORDER BY seq DESC LIMIT 1`).get(taskId);
    return row?.reply ? JSON.parse(row.reply) : null;
  }
  searchEvents(taskId, { query = '', afterSeq = 0, limit = 10 } = {}) {
    // Search only this task. Exclude retrieval traffic so earlier excerpts do not
    // recursively become the principal search results.
    const rows = this.db.prepare(`SELECT id, seq, json_extract(data,'$.type') AS type,
      json_extract(data,'$.time') AS time, length(data) AS total_chars,
      CASE WHEN ?='' THEN 1 ELSE MAX(1,instr(lower(data),lower(?))-120) END AS snippet_start,
      substr(data,CASE WHEN ?='' THEN 1 ELSE MAX(1,instr(lower(data),lower(?))-120) END,1600) AS snippet
      FROM events WHERE task_id=? AND seq>? AND (?='' OR instr(lower(data),lower(?))>0)
      AND instr(data,'"name":"task.history"')=0 ORDER BY seq LIMIT ?`).all(query, query, query, query, taskId, afterSeq, query, query, limit + 1);
    const events = [];
    let bytes = 0;
    for (const row of rows.slice(0, limit)) {
      let snippet = row.snippet;
      const event = { id: Number(row.id), seq: Number(row.seq), type: row.type, time: row.time, snippet, snippetStart: row.snippet_start - 1, totalChars: row.total_chars, truncated: row.snippet_start > 1 || [...snippet].length < row.total_chars };
      // A single result must fit even if the source is multibyte text.
      while (Buffer.byteLength(JSON.stringify(event)) > 4096 && snippet.length > 128) { snippet = snippet.slice(0, Math.floor(snippet.length * 0.75)); event.snippet = snippet; event.truncated = true; }
      const itemBytes = Buffer.byteLength(JSON.stringify(event));
      if (bytes + itemBytes > 14 * 1024 && events.length) break;
      events.push(event); bytes += itemBytes;
    }
    return { ok: true, events, nextAfterSeq: events.at(-1)?.seq ?? afterSeq, hasMore: rows.length > events.length, truncated: rows.length > events.length || events.some(event => event.truncated), excludedRetrievalTraffic: true };
  }
  getOperation(id) { return parse(this.db.prepare('SELECT data FROM operations WHERE id=?').get(id)); }
  getCrew(id) { return parse(this.db.prepare('SELECT data FROM crews WHERE id=?').get(id)); }
  latestCrew(parentId) { return parse(this.db.prepare('SELECT data FROM crews WHERE parent_id=? ORDER BY rowid DESC LIMIT 1').get(parentId)); }
  listCrews() { return this.db.prepare('SELECT data FROM crews ORDER BY rowid').all().map(safeParse).filter(Boolean); }
  listCrewsForParent(parentId) { return this.db.prepare('SELECT data FROM crews WHERE parent_id=? ORDER BY rowid').all(parentId).map(safeParse).filter(Boolean); }
  _writeCrew(crew) {
    crew.updatedAt = new Date().toISOString();
    this.db.prepare('INSERT INTO crews(id,parent_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(crew.id, crew.parentId, json(crew));
    return crew;
  }
  _writeTask(task) {
    task.version = (task.version || 0) + 1; task.updatedAt = new Date().toISOString();
    this.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(json(task), task.id);
    return task;
  }
  putCrew(crew, eventType) {
    return this.transaction(() => {
      this._writeCrew(crew);
      if (eventType) this._appendEvent(crew.parentId, eventType, { crewId: crew.id, status: crew.status, phase: crew.phase, calls: crew.calls, error: crew.error || null });
      return crew;
    });
  }
  reserveCrewCall(taskId, epoch, data) {
    return this.transaction(() => {
      const child = this.requireTask(taskId), crew = this.getCrew(child.crewMember?.runId);
      const parent = crew && this.requireTask(crew.parentId);
      const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
      if (!crew || !['running','verifying'].includes(crew.status) || child.epoch !== epoch || !['running','recovering','verifying'].includes(child.status) || parent.epoch !== crew.parentEpoch || !Object.values(crew.members).includes(child.id)) fail('STALE_RUN', 'Crew no longer owns this worker.');
      if (Date.now() >= crew.deadlineAt) fail('CREW_DEADLINE', 'Crew time limit reached.');
      if (crew.calls >= crew.maxCalls || parent.calls >= parent.policy.maxCalls || child.calls >= child.policy.maxCalls) fail('CREW_BUDGET', 'Crew call budget exhausted.');
      child.calls += 1; child.status = 'running'; child.lastSnapshotHash = data.snapshotHash;
      if (child.routing) delete child.routing.pendingRetry;
      parent.calls += 1; crew.calls += 1;
      this._writeTask(child); this._writeTask(parent); this._writeCrew(crew);
      this._appendEvent(child.id, 'model.request', { ...data, call: child.calls, crewId: crew.id });
      this._appendEvent(parent.id, 'crew.call', { crewId: crew.id, workerId: child.id, role: child.crewMember.role, providerId: child.providerId, calls: crew.calls, totalCalls: parent.calls });
      return this.getTask(child.id);
    });
  }
  recordProviderDelay(taskId, providerKey, retryAt) {
    return this.transaction(() => {
      const task = this.requireTask(taskId);
      const targets = [task, ...(task.crewMember ? [this.requireTask(task.crewMember.parentId)] : [])];
      for (const target of targets) {
        target.providerNotBefore ||= {};
        target.providerNotBefore[providerKey] = Math.max(target.providerNotBefore[providerKey] || 0, retryAt);
        this._writeTask(target);
        this._appendEvent(target.id, 'provider.wait_recorded', { providerKey, retryAt: target.providerNotBefore[providerKey], workerId: task.id });
      }
      return this.getTask(taskId);
    });
  }
  reserveCrewRecovery(taskId) {
    return this.transaction(() => {
      const child = this.requireTask(taskId), crew = this.getCrew(child.crewMember?.runId);
      if (!crew || !['running','verifying'].includes(crew.status) || Date.now() >= crew.deadlineAt) return false;
      const parent = this.requireTask(crew.parentId);
      if (parent.epoch !== crew.parentEpoch || crew.recoveries >= crew.maxRecoveries || parent.recoveries >= parent.policy.maxAttempts) return false;
      parent.recoveries += 1; crew.recoveries += 1;
      this._writeTask(parent); this._writeCrew(crew);
      this._appendEvent(parent.id, 'crew.recovery', { crewId: crew.id, workerId: child.id, recoveries: crew.recoveries });
      return true;
    });
  }
  adoptCrew(crewId, workspace, verification) {
    return this.transaction(() => {
      const crew = this.getCrew(crewId), parent = this.requireTask(crew.parentId);
      if (crew.status !== 'applying' || parent.epoch !== crew.parentEpoch || parent.workspace !== crew.originalWorkspace || parent.contractVersion !== crew.contractVersion) throw Object.assign(new Error('Task changed before candidate adoption.'), { code: 'CREW_STALE_PARENT' });
      parent.workspace = workspace; parent.epoch += 1; parent.status = 'completed'; parent.completionKind = 'verified';
      parent.verification = verification; parent.blocker = null; parent.completedAt = new Date().toISOString();
      delete parent.acceptedSnapshotHash;
      crew.status = 'applied'; crew.phase = 'done'; crew.adoptedWorkspace = workspace; crew.appliedAt = parent.completedAt;
      this._writeTask(parent); this._writeCrew(crew);
      this._appendEvent(parent.id, 'crew.applied', { crewId, snapshotHash: verification.snapshotHash, previousWorkspace: crew.originalWorkspace, workspace, completionKind: 'verified' });
      return this.getTask(parent.id);
    });
  }
  _sourceWithBackup(record) {
    if (!record) return record;
    const backup = safeParse(this.db.prepare('SELECT data FROM source_application_backups WHERE id=?').get(record.id));
    if (Array.isArray(backup)) {
      const byPath = new Map(backup.map(file => [file.path, file]));
      record.files = record.files.map(file => {
        const entry = byPath.get(file.path);
        return entry ? { ...file, before: entry.before, after: entry.after } : file;
      });
    }
    return record;
  }
  getSourceApplication(id) { return this._sourceWithBackup(parse(this.db.prepare('SELECT data FROM source_applications WHERE id=?').get(id))); }
  getSourceApplications(taskId) {
    return this.getSourceApplicationSummaries(taskId).map(record => this._sourceWithBackup(record));
  }
  getSourceApplicationSummaries(taskId) {
    return (taskId ? this.db.prepare('SELECT data FROM source_applications WHERE task_id=? ORDER BY rowid').all(taskId) : this.db.prepare('SELECT data FROM source_applications ORDER BY rowid').all()).map(parse);
  }
  putSourceApplication(application, eventType) {
    return this.transaction(() => {
      // Commit the immutable originals once. Updating progress or polling the
      // receipt must not rewrite or load every source file on every step.
      const hasContentPayload = Array.isArray(application.files) && application.files.some(f => Object.hasOwn(f, 'before') || Object.hasOwn(f, 'after'));
      if (hasContentPayload && !this.db.prepare('SELECT id FROM source_application_backups WHERE id=?').get(application.id)) {
        this.db.prepare('INSERT INTO source_application_backups(id,data) VALUES(?,?)').run(application.id, json(application.files.map(({ path, before, after }) => ({ path, before, after }))));
      }
      const metadata = { ...application, files: application.files.map(({ before, after, observed, ...file }) => ({ ...file, ...(observed ? { observed: { hash: observed.hash, mode: observed.mode, identity: observed.identity, parents: observed.parents } } : {}) })) };
      this.db.prepare('INSERT INTO source_applications(id,task_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(application.id, application.taskId, json(metadata));
      if (eventType) this._appendEvent(application.taskId, eventType, { applicationId: application.id, status: application.status, files: application.files.map(({ path, state }) => ({ path, state })), error: application.error || null });
      return application;
    });
  }
  getLocalState(key, fallback = undefined) {
    const value = safeParse(this.db.prepare('SELECT data FROM local_state WHERE key=?').get(String(key)));
    return value === undefined ? fallback : value;
  }
  setLocalState(key, value) {
    return this.transaction(() => {
      this.db.prepare('INSERT INTO local_state(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data').run(String(key), json(value));
      return value;
    });
  }
  getLearning() { return safeParse(this.db.prepare("SELECT data FROM local_state WHERE key='learning'").get()) || emptyLearning(); }
  recordLearning(key, observations = [], noteIds = []) {
    return this.transaction(() => {
      if (this.db.prepare('SELECT key FROM learned_events WHERE key=?').get(key)) return this.getLearning();
      const learning = applyObservations(this.getLearning(), observations, noteIds);
      this.db.prepare("INSERT INTO local_state(key,data) VALUES('learning',?) ON CONFLICT(key) DO UPDATE SET data=excluded.data").run(json(learning));
      this.db.prepare('INSERT INTO learned_events(key) VALUES(?)').run(key);
      return learning;
    });
  }
  recordStrategyLearning(key, observation) {
    return this.transaction(() => {
      if (this.db.prepare('SELECT key FROM learned_events WHERE key=?').get(key)) return this.getLearning();
      const learning = applyStrategyObservation(this.getLearning(), observation);
      this.db.prepare("INSERT INTO local_state(key,data) VALUES('learning',?) ON CONFLICT(key) DO UPDATE SET data=excluded.data").run(json(learning));
      this.db.prepare('INSERT INTO learned_events(key) VALUES(?)').run(key);
      return learning;
    });
  }
  recordRefusalPattern(pattern) {
    return this.transaction(() => {
      const learning = applyLearnedRefusalPattern(this.getLearning(), pattern);
      this.db.prepare("INSERT INTO local_state(key,data) VALUES('learning',?) ON CONFLICT(key) DO UPDATE SET data=excluded.data").run(json(learning));
      return learning;
    });
  }
  deleteRefusalPattern(signature = null) {
    return this.transaction(() => {
      const learning = removeLearnedRefusalPattern(this.getLearning(), signature);
      this.db.prepare("INSERT INTO local_state(key,data) VALUES('learning',?) ON CONFLICT(key) DO UPDATE SET data=excluded.data").run(json(learning));
      return learning;
    });
  }
  setModelPreference(providerId, signal, domain = null) {
    return this.transaction(() => {
      let learning = applyModelPreference(this.getLearning(), { providerId, signal });
      if (domain && (signal === 'pin' || signal === 'demote')) {
        learning = applyDomainOutcome(learning, { domain, providerId, outcome: signal === 'pin' ? 'prefer' : 'demote' });
      }
      this.db.prepare("INSERT INTO local_state(key,data) VALUES('learning',?) ON CONFLICT(key) DO UPDATE SET data=excluded.data").run(json(learning));
      return learning;
    });
  }
  recordDomainOutcome(outcome) {
    return this.transaction(() => {
      const learning = applyDomainOutcome(this.getLearning(), outcome);
      this.db.prepare("INSERT INTO local_state(key,data) VALUES('learning',?) ON CONFLICT(key) DO UPDATE SET data=excluded.data").run(json(learning));
      return learning;
    });
  }
  resetDomainElo() {
    return this.transaction(() => {
      const learning = { ...this.getLearning(), domainElo: {}, updatedAt: new Date().toISOString() };
      this.db.prepare("INSERT INTO local_state(key,data) VALUES('learning',?) ON CONFLICT(key) DO UPDATE SET data=excluded.data").run(json(learning));
      return learning;
    });
  }
  resetLearning() {
    return this.transaction(() => {
      this.db.prepare("DELETE FROM local_state WHERE key='learning'").run();
      this.db.prepare('DELETE FROM learned_events').run();
      return this.getLearning();
    });
  }
  getOperations(taskId) { return this.db.prepare('SELECT data FROM operations WHERE task_id=? ORDER BY rowid').all(taskId).map(parse); }
  putOperation(operation, eventType, eventData) {
    return this.transaction(() => {
      this.db.prepare('INSERT INTO operations(id,task_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(operation.id, operation.taskId, json(operation));
      if (eventType) this._appendEvent(operation.taskId, eventType, eventData || { operationId: operation.id, name: operation.name, status: operation.status });
      return operation;
    });
  }
  purgeTask(taskId) {
    return this.transaction(() => {
      const task = this.getTask(taskId);
      if (!task) return { deleted: false, task: null };
      const apps = this.db.prepare('SELECT id FROM source_applications WHERE task_id=?').all(taskId);
      for (const row of apps) {
        this.db.prepare('DELETE FROM source_application_backups WHERE id=?').run(row.id);
      }
      this.db.prepare('DELETE FROM source_applications WHERE task_id=?').run(taskId);
      this.db.prepare('DELETE FROM crews WHERE parent_id=?').run(taskId);
      this.db.prepare('DELETE FROM operations WHERE task_id=?').run(taskId);
      this.db.prepare('DELETE FROM events WHERE task_id=?').run(taskId);
      this.db.prepare('DELETE FROM tasks WHERE id=?').run(taskId);
      return { deleted: true, task };
    });
  }
  close() { if (!this.closed) { this.db.close(); this.closed = true; this._releaseOwnership(); } }
}
