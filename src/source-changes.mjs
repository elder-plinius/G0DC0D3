import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readBoundedFile, sha256, stableJson } from './broker.mjs';
import { publishablePath } from './workspaces.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code, status: 409 });
const overlap = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
const hash = content => content === null ? null : sha256(content);
const identity = stat => ({ dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs });
const same = (a, b) => stableJson(a) === stableJson(b);
// Omission retains the original all-files API. A preview ID commits to one
// exact set, so retrying cannot silently broaden an already-recorded batch.
const selectedPaths = (paths, offered) => {
  const requested = paths === undefined ? offered : paths;
  if (!Array.isArray(requested) || !requested.length || requested.length > offered.length
    || requested.some(value => typeof value !== 'string' || !offered.includes(value))
    || new Set(requested).size !== requested.length) throw fail('SOURCE_SELECTION_INVALID', 'Select one or more distinct files from this preview.');
  const selected = new Set(requested);
  return offered.filter(value => selected.has(value));
};
export const applicationSummary = ({ files, ...application }) => ({ ...application, files: files.map(({ before, after, observed, ...file }) => file) });

/** Owner-only optimistic source application. No model tool exposes this class.
 * The journal retains exact originals before effects. This is not a multi-file
 * transaction or a lock against other processes; final pathname checks and
 * replacement have a small race window. Keep other writers idle while applying.
 */
export class SourceChanges {
  constructor(runtime) {
    this.runtime = runtime; this.store = runtime.store; this.plans = new Map(); this.jobs = new Map(); this.faultInjector = null;
    for (const record of this.store.getSourceApplicationSummaries()) if (['applying', 'undoing'].includes(record.status)) {
      record.status = 'interrupted'; record.error = 'Application was interrupted. Inspect the receipt before continuing.';
      this.store.putSourceApplication(record, 'source.interrupted');
    }
  }
  busy(id) { return [...this.jobs.values()].some(job => job.taskId === id); }
  summaries(id) { return this.store.getSourceApplicationSummaries(id).slice(-10).map(applicationSummary); }
  assertSettled(id, expected) {
    this.runtime.crew?.assertIdle(id);
    const task = this.runtime.getTask(id);
    if (this.runtime.closed) throw fail('RUNTIME_CLOSED', 'Runtime is stopping.');
    if (['running', 'recovering', 'verifying'].includes(task.status) || this.runtime.runs.has(id) || this.runtime.broker.locks.has(id)) throw fail('TASK_ACTIVE', 'Pause and settle the task before applying source changes.');
    if (task.pendingMessages?.length) throw fail('PENDING_MESSAGES', 'Resume or remove queued instructions before applying changes.');
    if (this.runtime.getOperations(id).some(operation => !['succeeded', 'failed'].includes(operation.status))) throw fail('OUTCOME_UNKNOWN', 'Reconcile outstanding task operations first.');
    if (!task.sourcePath || !task.importManifest?.sourceIdentity) throw fail('SOURCE_IDENTITY_MISSING', 'This task has no recorded source-directory identity. Import the project again, or use the exported patch.');
    if (overlap(task.sourcePath, task.workspace) || overlap(task.sourcePath, this.store.dataDir)) throw fail('SOURCE_PATH_DENIED', 'Source application cannot target the task workspace or runtime storage.');
    if (expected && (task.epoch !== expected.epoch || task.contractVersion !== expected.contractVersion)) throw fail('SOURCE_PREVIEW_STALE', 'The task requirements changed. Preview the changes again.');
    for (const other of this.runtime.listTasks()) if (overlap(other.workspace, task.sourcePath) && (!['completed', 'cancelled'].includes(other.status) || this.runtime.getOperations(other.id).some(operation => !['succeeded', 'failed'].includes(operation.status)))) throw fail('SOURCE_BUSY', 'Another unfinished task owns part of this source directory.');
    return task;
  }
  locked(id, fn) {
    let task;
    try {
      task = this.assertSettled(id);
      if ([...this.jobs.values()].some(job => job.taskId === id || overlap(job.root, task.sourcePath))) throw fail('SOURCE_BUSY', 'Another source operation is still settling.');
    } catch (cause) { return Promise.reject(cause); }
    const job = { taskId: id, root: task.sourcePath, promise: null };
    this.jobs.set(id, job);
    job.promise = Promise.resolve().then(() => fn(task)).finally(() => this.jobs.delete(id));
    return job.promise;
  }
  async root(task) {
    const root = task.sourcePath, stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(root) !== root || !same(identity(stat), task.importManifest.sourceIdentity)) throw fail('SOURCE_IDENTITY_CHANGED', 'The original project directory was replaced or redirected. Re-import it before applying.');
    return root;
  }
  async observe(task, relative) {
    if (!publishablePath(relative)) throw fail('SOURCE_PATH_DENIED', `Unsupported source path: ${relative}`);
    const root = await this.root(task), parts = relative.split('/'), parents = [];
    let current = root, missing = false;
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      const stat = missing ? null : await fs.lstat(current).catch(cause => { if (cause.code === 'ENOENT') return null; throw cause; });
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(current) !== current)) throw fail('SOURCE_PATH_DENIED', `A source parent is not a plain directory: ${relative}`);
      missing ||= !stat; parents.push({ path: path.relative(root, current), identity: stat ? identity(stat) : null });
    }
    const target = path.join(root, relative);
    const stat = missing ? null : await fs.lstat(target).catch(cause => { if (cause.code === 'ENOENT') return null; throw cause; });
    if (!stat) return { content: null, hash: null, mode: null, identity: null, parents };
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || await fs.realpath(target) !== target) throw fail('SOURCE_PATH_DENIED', `Only unlinked regular source files can be applied: ${relative}`);
    const bytes = await readBoundedFile(target, 256 * 1024, 'SOURCE_FILE_LIMIT', { expectedIdentity: stat });
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw fail('SOURCE_TEXT_ONLY', `Source is not UTF-8 text: ${relative}`); }
    if (bytes.includes(0)) throw fail('SOURCE_TEXT_ONLY', `Source is binary: ${relative}`);
    await this.root(task);
    if (await fs.realpath(target) !== target) throw fail('SOURCE_IDENTITY_CHANGED', 'Source path changed during capture.');
    return { content, hash: sha256(bytes), mode: stat.mode & 0o777, identity: identity(stat), parents };
  }
  base(task) {
    const files = new Map(task.initialSnapshot.files.map(file => [file.path, file.content]));
    for (const application of this.store.getSourceApplications(task.id)) for (const file of application.files) {
      if (file.state === 'applied') { if (file.after === null) files.delete(file.path); else files.set(file.path, file.after); }
      if (file.state === 'undone') { if (file.before === null) files.delete(file.path); else files.set(file.path, file.before); }
    }
    return files;
  }
  hasUncertain(id) { return this.store.getSourceApplicationSummaries(id).some(record => record.files.some(file => ['writing', 'undoing', 'uncertain'].includes(file.state))); }
  preview(id) { return this.locked(id, async task => {
    if (this.hasUncertain(id)) throw fail('SOURCE_OUTCOME_UNKNOWN', 'Inspect the interrupted source application before making another preview.');
    await this.root(task);
    const snapshot = await this.runtime.snapshotTask(id), before = this.base(task), after = new Map(snapshot.files.map(file => [file.path, file.content]));
    const files = [];
    for (const relative of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      const oldText = before.get(relative) ?? null, newText = after.get(relative) ?? null;
      if (oldText === newText && before.has(relative) === after.has(relative) && !(newText === null && after.has(relative))) continue;
      const row = { path: relative, before: oldText, after: newText, beforeHash: hash(oldText), afterHash: hash(newText), kind: oldText === null ? 'add' : newText === null ? 'delete' : 'modify', state: 'pending' };
      try {
        if (newText === null && after.has(relative) || oldText === null && before.has(relative)) throw fail('SOURCE_TEXT_ONLY', 'Binary changes cannot be applied.');
        row.observed = await this.observe(task, relative);
        if (row.observed.hash !== row.beforeHash) row.conflict = 'The source differs from this task’s last imported or applied version. Your edit has been preserved.';
      } catch (cause) { row.conflict = cause.message; }
      files.push(row);
    }
    this.assertSettled(id, task);
    const plan = { id: randomUUID(), taskId: id, sourcePath: task.sourcePath, sourceIdentity: task.importManifest.sourceIdentity, epoch: task.epoch, contractVersion: task.contractVersion, snapshotHash: snapshot.snapshotHash, createdAt: new Date().toISOString(), expiresAt: Date.now() + 10 * 60 * 1000, files };
    for (const [key, value] of this.plans) if (value.expiresAt < Date.now()) this.plans.delete(key);
    while (this.plans.size >= 20) this.plans.delete(this.plans.keys().next().value);
    this.plans.set(plan.id, plan);
    return { ...plan, canApply: files.length > 0 && files.every(file => !file.conflict), files: files.map(({ observed, ...file }) => ({ ...file, sourceHash: observed?.hash ?? null })) };
  }); }
  async validateFiles(task, files, undo = false) {
    const result = [];
    for (const file of files) {
      const observed = await this.observe(task, file.path), expectedHash = undo ? file.afterHash : file.beforeHash;
      if (observed.hash !== expectedHash || !undo && file.observed && !same(observed, file.observed)
        || undo && observed.hash !== null && (observed.mode !== file.originalMode || file.appliedIdentity && !same(observed.identity, file.appliedIdentity))) throw fail('SOURCE_CONFLICT', `Source changed since review: ${file.path}. No further files were written.`);
      result.push({ ...file, observed });
    }
    return result;
  }
  async write(task, file, undo, record) {
    this.assertSettled(task.id, task);
    const content = undo ? file.before : file.after;
    record.createdDirectories ||= {};
    const expected = { ...file.observed, parents: file.observed.parents.map(parent => ({ ...parent, identity: parent.identity || record.createdDirectories[parent.path] || null })) };
    let observed = await this.observe(task, file.path);
    if (!same(observed, expected)) throw fail('SOURCE_CONFLICT', `Source changed before writing: ${file.path}`);
    const root = task.sourcePath, target = path.join(root, file.path);
    // Create missing parents individually and revalidate every ancestor. Never
    // remove directories on undo; another program may have started using them.
    for (const parent of observed.parents) if (!parent.identity) {
      await this.root(task);
      await this.observe(task, file.path);
      await fs.mkdir(path.join(root, parent.path), { mode: 0o755 });
      const created = await fs.lstat(path.join(root, parent.path));
      if (!created.isDirectory() || created.isSymbolicLink()) throw fail('SOURCE_PATH_DENIED', 'A newly created parent directory was redirected.');
      record.createdDirectories[parent.path] = identity(created);
      this.store.putSourceApplication(record);
    }
    const ready = await this.observe(task, file.path);
    if (ready.hash !== expected.hash || !same(ready.identity, expected.identity) || ready.mode !== expected.mode || expected.parents.some(parent => parent.identity && !same(parent.identity, ready.parents.find(value => value.path === parent.path)?.identity))) throw fail('SOURCE_CONFLICT', `Source changed while preparing: ${file.path}`);
    const temporary = path.join(path.dirname(target), `.g0d-apply-${randomUUID()}`);
    try {
      if (content !== null) {
        const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), file.originalMode ?? 0o644);
        try { await handle.writeFile(content); await handle.chmod(file.originalMode ?? 0o644); await handle.sync(); } finally { await handle.close(); }
      }
      if (this.faultInjector) await this.faultInjector('before_replace', { taskId: task.id, file, undo });
      this.assertSettled(task.id, task);
      observed = await this.observe(task, file.path);
      if (!same(observed, ready)) throw fail('SOURCE_CONFLICT', `Source changed during write preparation: ${file.path}`);
      if (content === null) await fs.unlink(target);
      else if (expected.hash === null) await fs.link(temporary, target); // Exclusive new-file creation; never overwrite a new owner file.
      else await fs.rename(temporary, target);
      const directory = await fs.open(path.dirname(target), constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await fs.unlink(temporary).catch(cause => { if (cause.code !== 'ENOENT') throw cause; }); }
  }
  apply(id, previewId, paths) { return this.locked(id, async task => {
    const previous = this.store.getSourceApplication(previewId);
    if (previous) {
      if (previous.taskId !== id) throw fail('SOURCE_RECEIPT_MISMATCH', 'Receipt belongs to another task.');
      const requested = selectedPaths(paths, previous.previewPaths || previous.files.map(file => file.path));
      if (!same(requested, previous.files.map(file => file.path))) throw fail('SOURCE_SELECTION_MISMATCH', 'This preview already has a recorded selection. Review again to apply a different batch.');
      return applicationSummary(previous);
    }
    const plan = this.plans.get(previewId);
    if (!plan || plan.taskId !== id || plan.expiresAt < Date.now()) throw fail('SOURCE_PREVIEW_EXPIRED', 'Preview expired or the runtime restarted. Preview again before applying.');
    const previewPaths = plan.files.map(file => file.path), selected = new Set(selectedPaths(paths, previewPaths));
    const batch = plan.files.filter(file => selected.has(file.path));
    if (batch.some(file => file.conflict)) throw fail('SOURCE_CONFLICT', 'A selected file has a conflict. Exclude it, or resolve it and preview again.');
    this.assertSettled(id, plan);
    if (this.hasUncertain(id)) throw fail('SOURCE_OUTCOME_UNKNOWN', 'Inspect the interrupted source application first.');
    if ((await this.runtime.snapshotTask(id)).snapshotHash !== plan.snapshotHash) throw fail('SOURCE_PREVIEW_STALE', 'The task files changed. Preview again.');
    const files = await this.validateFiles(task, batch);
    this.assertSettled(id, plan);
    const record = { ...plan, previewPaths, status: 'applying', files: files.map(file => ({ ...file, originalMode: file.observed.mode ?? 0o644 })), startedAt: new Date().toISOString() };
    delete record.expiresAt;
    this.store.putSourceApplication(record, 'source.apply_started'); // Exact backups committed before any effect.
    this.plans.delete(previewId);
    try {
      for (const file of record.files) {
        file.state = 'writing'; this.store.putSourceApplication(record);
        await this.write(task, file, false, record);
        if (this.faultInjector) await this.faultInjector('after_effect', { taskId: id, file, undo: false });
        const applied = await this.observe(task, file.path);
        if (applied.hash !== file.afterHash) throw fail('SOURCE_CONFLICT', `Source changed just after application: ${file.path}. Inspect the receipt.`);
        file.appliedIdentity = applied.identity;
        file.state = 'applied'; this.store.putSourceApplication(record, 'source.file_applied');
      }
      record.status = 'applied'; record.finishedAt = new Date().toISOString();
    } catch (cause) { record.status = 'interrupted'; record.error = cause.message; }
    this.store.putSourceApplication(record, 'source.apply_finished');
    return applicationSummary(record);
  }); }
  inspect(id, applicationId) { return this.locked(id, async task => {
    const record = this.receipt(id, applicationId);
    for (const file of record.files) if (['writing', 'undoing', 'uncertain'].includes(file.state)) {
      const undo = file.direction === 'undo' || file.state === 'undoing';
      try {
        const current = await this.observe(task, file.path);
        if (current.hash === file.afterHash) { file.state = 'applied'; file.appliedIdentity = current.identity; }
        else if (current.hash === file.beforeHash) file.state = undo ? 'undone' : 'not_applied';
        else file.state = 'uncertain';
      } catch { file.state = 'uncertain'; }
    }
    record.status = record.files.some(file => file.state === 'uncertain') ? 'needs_review' : record.files.every(file => file.state === 'applied') ? 'applied' : record.files.every(file => ['undone', 'not_applied', 'pending'].includes(file.state)) ? 'unchanged' : 'partial';
    record.inspectedAt = new Date().toISOString();
    this.store.putSourceApplication(record, 'source.inspected');
    return applicationSummary(record);
  }); }
  receipt(id, applicationId) {
    const record = this.store.getSourceApplication(applicationId);
    if (!record || record.taskId !== id) throw fail('SOURCE_RECEIPT_MISSING', 'Source receipt not found for this task.');
    return record;
  }
  undo(id, applicationId) { return this.locked(id, async task => {
    const record = this.receipt(id, applicationId);
    if (this.store.getSourceApplicationSummaries(id).at(-1)?.id !== record.id) throw fail('SOURCE_UNDO_ORDER', 'Only the latest source application can be undone.');
    if (record.files.some(file => ['writing', 'undoing', 'uncertain'].includes(file.state))) throw fail('SOURCE_OUTCOME_UNKNOWN', 'Inspect this interrupted application before undoing it.');
    const applied = record.files.filter(file => file.state === 'applied');
    if (!applied.length) return applicationSummary(record);
    const validated = await this.validateFiles(task, applied, true);
    this.assertSettled(id, task);
    record.status = 'undoing'; delete record.error;
    this.store.putSourceApplication(record, 'source.undo_started');
    try {
      for (const checked of [...validated].reverse()) {
        const file = record.files.find(item => item.path === checked.path);
        file.observed = checked.observed; file.state = 'undoing'; file.direction = 'undo'; this.store.putSourceApplication(record);
        await this.write(task, file, true, record);
        if (this.faultInjector) await this.faultInjector('after_effect', { taskId: id, file, undo: true });
        file.state = 'undone'; this.store.putSourceApplication(record, 'source.file_restored');
      }
      record.status = 'undone'; record.undoneAt = new Date().toISOString();
    } catch (cause) { record.status = 'interrupted'; record.error = cause.message; }
    this.store.putSourceApplication(record, 'source.undo_finished');
    return applicationSummary(record);
  }); }
}
