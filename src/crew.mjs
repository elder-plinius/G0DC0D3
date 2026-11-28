import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { snapshotWorkspace, sha256, stableJson, scopedPath } from './broker.mjs';
import { diagnoseIncident, providerIdentity } from './routing.mjs';

const working = new Set(['preparing', 'running', 'verifying', 'applying']);
const locked = new Set([...working, 'paused', 'ready']);
const activeTask = new Set(['running', 'recovering', 'verifying']);
const fault = (code, message) => Object.assign(new Error(message), { code });
const snapshot = workspace => snapshotWorkspace(workspace, { expectedRoot: workspace });
const contractHash = task => sha256(stableJson({ objective: task.objective, constraints: task.constraints, followups: task.followups || [], contractVersion: task.contractVersion, checks: task.checks, checksContractVersion: task.checksContractVersion, acceptance: task.acceptance, execution: task.execution, providers: task.providers, persona: task.persona, policy: task.policy }));
const problem = error => ({ code: error.code || 'CREW_ERROR', message: error.message });

/** One task owns the contract and budget. Members only work on disposable copies. */
export class CrewController {
  constructor(runtime) {
    this.runtime = runtime; this.store = runtime.store; this.jobs = new Map(); this.closed = false;
    for (const crew of this.store.listCrews()) if (working.has(crew.status)) {
      if (crew.status === 'applying' && crew.candidate) {
        crew.status = 'ready';
        crew.error = { code: 'CREW_RESTART', message: 'Adoption was interrupted before completion. Review and apply the verified candidate again.' };
        this.store.putCrew(crew, 'crew.ready');
      } else {
        crew.status = 'paused';
        crew.error = { code: 'CREW_RESTART', message: 'Crew interrupted. Resume continues with the original budget and deadline.' };
        this.store.putCrew(crew, 'crew.paused');
      }
    }
  }
  record(parentId) { return this.store.latestCrew(parentId); }
  unresolved(parentId) {
    return this.store.listCrewsForParent(parentId).flatMap(crew => Object.entries(crew.members).flatMap(([role, workerId]) => this.runtime.getOperations(workerId)
      .filter(op => !['succeeded','failed'].includes(op.status)).map(op => ({ crewId: crew.id, workerId, role, operationId: op.id, name: op.name, status: op.status }))));
  }
  busy(parentId) { return this.jobs.has(parentId) || locked.has(this.record(parentId)?.status) || this.unresolved(parentId).length > 0; }
  assertIdle(id) {
    if (this.unresolved(id).length) throw fault('OUTCOME_UNKNOWN', 'Inspect unresolved crew effects before continuing this task.');
    if (this.jobs.has(id) || locked.has(this.record(id)?.status)) throw fault('CREW_BUSY', 'Finish or cancel the crew before changing this task.');
  }
  workerCurrent(task) {
    if (!task.crewMember) return true;
    const crew = this.store.getCrew(task.crewMember.runId);
    return Boolean(crew && ['running', 'verifying'].includes(crew.status) && Date.now() < crew.deadlineAt && this.store.requireTask(crew.parentId).epoch === crew.parentEpoch && Object.values(crew.members).includes(task.id));
  }
  reserveCall(id, epoch, eventData) {
    return this.runtime.getTask(id).crewMember ? this.store.reserveCrewCall(id, epoch, eventData) : null;
  }
  reserveRecovery(id) { return !this.runtime.getTask(id).crewMember || this.store.reserveCrewRecovery(id); }
  finishReview(id, response) {
    const task = this.runtime.getTask(id);
    if (!this.workerCurrent(task)) throw fault('STALE_RUN', 'Review no longer belongs to an active crew.');
    let review;
    try {
      if (typeof response.text !== 'string' || response.text.length > 10000 || response.finish !== 'done') throw new Error();
      review = JSON.parse(response.text);
      if (!review || Object.keys(review).some(key => !['verdict', 'findings'].includes(key)) || !['approve', 'changes_requested'].includes(review.verdict) || !Array.isArray(review.findings) || review.findings.length > 6) throw new Error();
      if (review.verdict === 'approve' && review.findings.length || review.verdict === 'changes_requested' && !review.findings.length) throw new Error();
      for (const finding of review.findings) if (!finding || Object.keys(finding).some(key => !['path','detail'].includes(key)) || typeof finding.path !== 'string' || finding.path.length > 400 || typeof finding.detail !== 'string' || !finding.detail.trim() || finding.detail.length > 1200) throw new Error();
    } catch { throw fault('INVALID_REVIEW', 'Return a JSON verdict with approve and no findings, or changes_requested with 1–6 {path, detail} findings.'); }
    return this.store.updateTask(id, current => {
      current.crewReview = { ...review, snapshotHash: current.initialSnapshot.snapshotHash, authority: 'model-authored advisory evidence' };
      current.status = 'completed'; current.completionKind = 'reviewed'; current.completedAt = new Date().toISOString(); current.blocker = null;
      return current;
    }, 'crew.reviewed', { verdict: review.verdict, findings: review.findings });
  }
  summary(parentId) {
    const crew = this.record(parentId); if (!crew) return null;
    const workers = ['solver','challenger','verifier'].map(role => {
      const task = crew.members[role] && this.store.getTask(crew.members[role]);
      return { role, taskId: task?.id || null, status: task?.status || 'pending', providerId: role === 'verifier' ? null : task?.providerId || null, calls: task?.calls || 0,
        summary: role === 'challenger' && task?.crewReview ? (task.crewReview.verdict === 'approve' ? 'No findings' : `${task.crewReview.findings.length} findings${crew.revisionDone ? ' · repair checked separately' : ''}`) : role === 'verifier' && task?.verification ? `${task.verification.checks?.filter(check => check.status === 'pass').length || 0} checks passed` : task?.blocker?.message || null };
    });
    const { id, status, phase, calls, maxCalls, recoveries, maxRecoveries, deadlineAt, error } = crew;
    return { id, status, phase, calls, maxCalls, recoveries, maxRecoveries, deadlineAt, workers, error: error || null,
      candidate: crew.candidate ? { taskId: crew.candidate.taskId, snapshotHash: crew.candidate.snapshotHash, verification: crew.candidate.verification } : null,
      review: crew.review || null, unresolved: this.unresolved(parentId), copyPolicy: 'Checked UTF-8 source snapshot; existing project-copy bounds apply.' };
  }
  _update(id, patch, event) {
    const current = this.store.getCrew(id);
    const updated = this.store.putCrew({ ...current, ...patch }, event);
    try {
      this.runtime._emitStream(updated.parentId, { type: 'conclave.update', kind: 'crew', crew: this.summary(updated.parentId) });
    } catch {}
    return updated;
  }
  _assertParent(crew) {
    const parent = this.runtime.getTask(crew.parentId);
    if (parent.crewMember || parent.status === 'cancelled' || parent.epoch !== crew.parentEpoch || parent.workspace !== crew.originalWorkspace || contractHash(parent) !== crew.parentContractHash || parent.pendingMessages?.length) throw fault('CREW_STALE_PARENT', 'The task contract or workspace changed. Start a new crew from the current task.');
    if (this.runtime.runs.has(parent.id) || this.runtime.broker.locks.has(parent.id) || this.runtime.sourceChanges.busy(parent.id) || this.runtime.getOperations(parent.id).some(op => !['succeeded','failed'].includes(op.status))) throw fault('CREW_BUSY', 'Parent task effects must settle before crew work.');
    return parent;
  }
  _live(id, signal) {
    const crew = this.store.getCrew(id);
    if (signal?.aborted || !['preparing','running','verifying'].includes(crew.status)) throw fault('CREW_STOPPED', 'Crew stopped.');
    if (Date.now() >= crew.deadlineAt) throw fault('CREW_DEADLINE', 'Crew time limit reached.');
    this._assertParent(crew);
    return crew;
  }
  _canStart(parent) {
    if (this.closed || this.runtime.closed) throw fault('RUNTIME_CLOSED', 'Runtime is closed.');
    if (parent.crewMember) throw fault('CREW_MEMBER', 'Start a crew from its parent conversation.');
    this.assertIdle(parent.id);
    if (activeTask.has(parent.status) || parent.status === 'cancelled' || this.runtime.runs.has(parent.id) || this.runtime.broker.locks.has(parent.id) || this.runtime.sourceChanges.busy(parent.id)) throw fault('CREW_BUSY', 'Pause and settle the task before starting a crew.');
    if (parent.pendingMessages?.length) throw fault('PENDING_MESSAGES', 'Apply or remove queued instructions before starting a crew.');
    if (this.runtime.getOperations(parent.id).some(op => !['succeeded','failed'].includes(op.status))) throw fault('OUTCOME_UNKNOWN', 'Resolve uncertain task effects before starting a crew.');
    const ownerChecks = parent.checks?.length && parent.checksContractVersion === parent.contractVersion;
    const registered = !parent.followups?.length && (parent.fixtureId || parent.acceptance?.checkType);
    if (!ownerChecks && !registered) throw fault('CREW_CHECKS_REQUIRED', 'Add checks for the current task before using a crew.');
    if (ownerChecks && !parent.execution?.enabled) throw fault('EXECUTION_DISABLED', 'Enable the task command grant to run its configured checks.');
  }
  async start(parentId, options = {}) {
    if (Object.keys(options).some(key => !['maxCalls','timeoutMs'].includes(key))) throw fault('INVALID_CREW', 'Crew accepts maxCalls and timeoutMs only.');
    const parent = this.runtime.getTask(parentId); this._canStart(parent);
    const requested = options.maxCalls ?? 12, timeoutMs = options.timeoutMs ?? 600000;
    if (!Number.isInteger(requested) || requested < 3 || requested > 30 || !Number.isInteger(timeoutMs) || timeoutMs < 20 || timeoutMs > 600000) throw fault('INVALID_CREW', 'Crew limits are 3–30 calls and 20–600000 ms.');
    const maxCalls = Math.min(requested, parent.policy.maxCalls - parent.calls);
    if (maxCalls < 3) throw fault('CREW_BUDGET', 'A crew needs at least three remaining task calls.');
    const crew = { id: randomUUID(), parentId, parentEpoch: parent.epoch, contractVersion: parent.contractVersion, parentContractHash: contractHash(parent), originalWorkspace: parent.workspace,
      status: 'preparing', phase: 'solver', members: {}, calls: 0, recoveries: 0, maxCalls, maxRecoveries: Math.max(0, parent.policy.maxAttempts - parent.recoveries),
      deadlineAt: Date.now() + timeoutMs, createdAt: new Date().toISOString(), baseSnapshot: null, candidate: null, error: null };
    this.store.putCrew(crew, 'crew.started');
    this._launch(crew);
    return this.summary(parentId);
  }
  _launch(crew) {
    const controller = new AbortController(), entry = { controller, promise: null, timer: null };
    this.jobs.set(crew.parentId, entry);
    entry.timer = setTimeout(() => {
      try {
        if (this.closed || this.runtime.closed) return;
        const current = this.store.getCrew(crew.id);
        if (current && working.has(current.status)) {
          this._stop(crew.parentId, 'failed', { code: 'CREW_DEADLINE', message: 'Crew time limit reached.' });
        }
      } catch {}
    }, Math.max(1, crew.deadlineAt - Date.now()));
    entry.timer.unref?.();
    entry.promise = this._drive(crew.id, controller.signal).catch(error => {
      const current = this.store.getCrew(crew.id);
      if (working.has(current.status)) this._stop(crew.parentId, 'failed', problem(error));
    }).finally(async () => {
      clearTimeout(entry.timer);
      const current = this.store.getCrew(crew.id);
      await Promise.allSettled(Object.values(current.members).map(id => this.runtime.runs.get(id)?.promise).filter(Boolean));
      if (this.jobs.get(crew.parentId) === entry) this.jobs.delete(crew.parentId);
      const settled = this.store.getCrew(crew.id);
      if (settled && ['cancelled', 'failed'].includes(settled.status)) {
        this._cleanupDisposableDirs(settled).catch(() => {});
      }
    });
  }
  async _cleanupDisposableDirs(crew, { preservePath = null } = {}) {
    if (!crew?.id) return;
    const baseDir = path.join(this.store.dataDir, 'crews', crew.id);
    const keepReal = preservePath ? await fs.realpath(preservePath).catch(() => path.resolve(preservePath)) : null;
    let entries;
    try { entries = await fs.readdir(baseDir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const full = path.join(baseDir, ent.name);
      const fullReal = await fs.realpath(full).catch(() => full);
      if (keepReal && fullReal === keepReal) continue;
      if (/^(?:solver|challenger|verifier|adopted)-/.test(ent.name)) {
        await fs.rm(full, { recursive: true, force: true }).catch(() => {});
      }
    }
    if (!keepReal) await fs.rmdir(baseDir).catch(() => {});
  }
  async wait(parentId) { await this.jobs.get(parentId)?.promise; return this.summary(parentId); }
  async inspect(parentId) {
    if (this.closed || this.runtime.closed) throw fault('RUNTIME_CLOSED', 'Runtime is closed.');
    const crew = this.record(parentId);
    if (!crew || this.jobs.has(parentId) || working.has(crew.status)) throw fault('CREW_BUSY', 'Pause and settle the crew before inspecting its effects.');
    const workerIds = [...new Set(this.unresolved(parentId).map(op => op.workerId))];
    const entry = { controller: new AbortController(), promise: null }; this.jobs.set(parentId, entry);
    entry.promise = (async () => {
      try {
        // Inspect recorded effects only. Reconciliation never dispatches a tool
        // or repeats a command whose external outcome could be unknown.
        for (const workerId of workerIds) await this.runtime.broker.reconcileTask(workerId);
        const unresolved = this.unresolved(parentId);
        this._update(crew.id, { error: unresolved.length ? { code: 'OUTCOME_UNKNOWN', message: 'Some command effects are still unknown. Inspect the exported operation records before proceeding.' } : null }, 'crew.inspected');
        return this.summary(parentId);
      } finally { if (this.jobs.get(parentId) === entry) this.jobs.delete(parentId); }
    })();
    return entry.promise;
  }
  _stop(parentId, status, error = null) {
    const crew = this.record(parentId); if (!crew || ['applied','cancelled','failed'].includes(crew.status)) return this.summary(parentId);
    if (crew.status === 'applying') throw fault('CREW_BUSY', 'Candidate adoption is settling.');
    this._update(crew.id, { status, error }, `crew.${status}`);
    const job = this.jobs.get(parentId);
    if (job?.timer) clearTimeout(job.timer);
    job?.controller.abort();
    for (const id of Object.values(crew.members)) {
      const task = this.store.getTask(id);
      if (task && !['completed','cancelled'].includes(task.status)) this.runtime.pause(id);
    }
    return this.summary(parentId);
  }
  pause(parentId) { return this._stop(parentId, 'paused'); }
  cancel(parentId) { return this._stop(parentId, 'cancelled'); }
  async resume(parentId) {
    if (this.closed || this.runtime.closed) throw fault('RUNTIME_CLOSED', 'Runtime is closed.');
    const crew = this.record(parentId);
    if (!crew || crew.status !== 'paused') throw fault('CREW_STATE', 'Only a paused crew can resume.');
    if (this.jobs.has(parentId)) throw fault('RUN_DRAINING', 'Crew workers are still settling.');
    this._assertParent(crew);
    if (Date.now() >= crew.deadlineAt) { this._update(crew.id, { status: 'failed', error: { code: 'CREW_DEADLINE', message: 'The original crew deadline expired.' } }, 'crew.failed'); throw fault('CREW_DEADLINE', 'The original crew deadline expired.'); }
    if (crew.baseSnapshot && (await snapshot(crew.originalWorkspace)).snapshotHash !== crew.baseSnapshot.snapshotHash) throw fault('CREW_STALE_PARENT', 'Parent files changed while the crew was paused.');
    if (this.closed || this.runtime.closed) throw fault('RUNTIME_CLOSED', 'Runtime is closed.');
    if (this.jobs.has(parentId)) throw fault('RUN_DRAINING', 'Crew workers are still settling.');
    this._assertParent(this.store.getCrew(crew.id));
    if (this.record(parentId)?.id !== crew.id || this.store.getCrew(crew.id).status !== 'paused') throw fault('CREW_STATE', 'Crew changed while resuming.');
    this._update(crew.id, { status: 'running', error: null }, 'crew.resumed'); this._launch(this.store.getCrew(crew.id));
    return this.summary(parentId);
  }
  async _copy(crew, from, captured, suffix) {
    if (captured.files.some(file => typeof file.content !== 'string')) throw fault('CREW_BINARY_UNSUPPORTED', 'Crew copies currently require UTF-8 source files.');
    const directory = path.join(this.store.dataDir, 'crews', crew.id);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const target = await fs.realpath(await fs.mkdtemp(path.join(directory, suffix + '-')));
    try {
      for (const file of captured.files) {
        const source = await scopedPath(from, file.path), info = await fs.lstat(source);
        const destination = await scopedPath(target, file.path, { writing: true });
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, file.content, { mode: info.mode & 0o777, flag: 'wx' });
      }
      const [original, copy] = await Promise.all([snapshot(from), snapshot(target)]);
      if (original.snapshotHash !== captured.snapshotHash || copy.snapshotHash !== captured.snapshotHash) throw fault('CREW_STALE_CANDIDATE', 'Files changed while copying the crew snapshot.');
      return target;
    } catch (err) {
      await fs.rm(target, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }
  async _member(crewId, role, from, captured, signal) {
    let crew = this._live(crewId, signal);
    if (crew.members[role]) return this.runtime.getTask(crew.members[role]);
    const workspace = await this._copy(crew, from, captured, role);
    try {
      crew = this._live(crewId, signal);
      const parent = this._assertParent(crew), remaining = crew.maxCalls - crew.calls;
      const providers = role === 'challenger' && parent.providers.length > 1 ? [...parent.providers.slice(1), parent.providers[0]] : parent.providers;
      const maxCalls = role === 'solver' ? Math.max(2, crew.maxCalls - 3) : role === 'challenger' ? Math.max(1, Math.min(3, remaining)) : 1;
      const effectivePermissionRules = this.runtime._effectivePermissionRules(parent);
      return await this.runtime.createTask({ title: `${role[0].toUpperCase() + role.slice(1)} · ${parent.title}`, objective: parent.objective, constraints: parent.constraints, workspace, workspaceKind: parent.workspaceKind, providers,
        fixtureId: parent.fixtureId, scenario: parent.scenario, acceptance: parent.acceptance, persona: parent.persona, checks: parent.checks,
        ...(effectivePermissionRules.length ? { permissionRules: effectivePermissionRules } : {}),
        ...(parent.effort !== undefined ? { effort: parent.effort } : {}),
        ...(parent.generation !== undefined ? { generation: parent.generation } : {}),
        execution: role === 'challenger' ? { enabled: false, network: false, timeoutMs: parent.execution.timeoutMs } : parent.execution,
        policy: { ...parent.policy, maxCalls, requestTimeoutMs: Math.max(10, Math.min(parent.policy.requestTimeoutMs, crew.deadlineAt - Date.now())) },
        crewMember: { runId: crew.id, parentId: parent.id, role },
        crewContract: { followups: parent.followups || [], contractVersion: parent.contractVersion, checksContractVersion: parent.checksContractVersion, originalAcceptance: parent.originalAcceptance } });
    } catch (err) {
      await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }
  async _runMember(crewId, taskId, signal) {
    this._live(crewId, signal);
    let task = this.runtime.getTask(taskId);
    if (task.status !== 'completed') {
      if (task.status !== 'queued') this.runtime.resume(taskId);
      await this.runtime.run(taskId);
    }
    this._live(crewId, signal); task = this.runtime.getTask(taskId);
    if (this.runtime.getOperations(taskId).some(op => !['succeeded','failed'].includes(op.status))) throw fault('OUTCOME_UNKNOWN', 'Crew worker has unresolved tool effects. Inspect its recorded operations before continuing.');
    const allowedHandoff = ['CALL_BUDGET', 'CREW_BUDGET', 'UNREGISTERED_ACCEPTANCE', 'RECOVERY_LIMIT'];
    if (task.blocker && !allowedHandoff.includes(task.blocker.code) && !diagnoseIncident(task.blocker).route) throw fault(task.blocker.code, task.blocker.message);
    if (task.status === 'failed' || task.status === 'cancelled') throw fault(task.blocker?.code || 'CREW_WORKER_FAILED', task.blocker?.message || 'Crew worker failed.');
    if ((task.status === 'paused' || task.status === 'blocked') && !allowedHandoff.includes(task.blocker?.code)) {
      throw fault(task.blocker?.code || 'CREW_WORKER_STOPPED', task.blocker?.message || `Crew worker stopped (${task.status}).`);
    }
    return task;
  }
  async _drive(id, signal) {
    let crew = this._live(id, signal);
    if (!crew.baseSnapshot) {
      const baseSnapshot = await snapshot(crew.originalWorkspace); this._live(id, signal);
      crew = this._update(id, { baseSnapshot, status: 'running' });
    }
    if ((await snapshot(crew.originalWorkspace)).snapshotHash !== crew.baseSnapshot.snapshotHash) throw fault('CREW_STALE_PARENT', 'Parent files changed before crew execution.');
    this._live(id, signal);
    const solver = await this._member(id, 'solver', crew.originalWorkspace, crew.baseSnapshot, signal);
    crew = this._live(id, signal);
    if (!crew.solverDone) {
      this._update(id, { phase: 'solver', status: 'running' }, 'crew.phase');
      await this._runMember(id, solver.id, signal);
      crew = this._update(id, { solverDone: true });
    }
    if (!crew.reviewDone) {
      const existingChallenger = crew.members.challenger ? this.store.getTask(crew.members.challenger) : null;
      if (crew.calls >= crew.maxCalls && existingChallenger?.status !== 'completed') throw fault('CREW_BUDGET', 'No crew calls remain for the challenger.');
      this._update(id, { phase: 'challenger', status: 'running' }, 'crew.phase');
      const captured = await snapshot(solver.workspace); this._live(id, signal);
      const challenger = await this._member(id, 'challenger', solver.workspace, captured, signal);
      const reviewed = await this._runMember(id, challenger.id, signal);
      if (!reviewed.crewReview || reviewed.completionKind !== 'reviewed') throw fault(reviewed.blocker?.code || 'CREW_REVIEW_INCOMPLETE', 'Challenger did not finish its review.');
      crew = this._update(id, { review: reviewed.crewReview, reviewDone: true });
    }
    if (crew.review.verdict === 'changes_requested' && !crew.revisionDone) {
      const currentSolver = this.store.getTask(solver.id);
      if (crew.calls >= crew.maxCalls && !(crew.revisionStarted && currentSolver?.status === 'completed')) throw fault('CREW_BUDGET', 'No crew calls remain to investigate the findings.');
      this._update(id, { phase: 'revision', status: 'running' }, 'crew.phase');
      if (!crew.revisionStarted) {
        this.store.updateTask(solver.id, task => {
          task.crewEvidence = crew.review; task.status = 'queued'; task.epoch += 1; task.verification = null; task.completionKind = null;
          task.policy.maxCalls = task.calls + crew.maxCalls - crew.calls; task.blocker = null;
          delete task.completedAt;
          return task;
        }, 'crew.findings', { ...crew.review, source: 'challenger', authority: 'advisory evidence' });
        this._update(id, { revisionStarted: true });
      }
      await this._runMember(id, solver.id, signal);
      if ((await snapshot(solver.workspace)).snapshotHash === crew.review.snapshotHash) throw fault('CREW_REVIEW_UNRESOLVED', 'The challenger requested changes, but the repair produced no changed candidate.');
      this._live(id, signal); crew = this._update(id, { revisionDone: true });
    }
    this._update(id, { phase: 'verifier', status: 'verifying' }, 'crew.phase');
    const captured = await snapshot(solver.workspace); this._live(id, signal);
    // If an interrupted verifier workspace was dirtied by a previous aborted check, recreate a clean copy.
    const existingVerifierId = this.store.getCrew(id)?.members?.verifier;
    if (existingVerifierId) {
      const existingVerifier = this.store.getTask(existingVerifierId);
      const existingSnap = existingVerifier?.workspace ? await snapshot(existingVerifier.workspace).catch(() => null) : null;
      if (!existingSnap || existingSnap.snapshotHash !== captured.snapshotHash) {
        const curCrew = this.store.getCrew(id);
        delete curCrew.members.verifier;
        this.store.putCrew(curCrew);
      }
    }
    const verifier = await this._member(id, 'verifier', solver.workspace, captured, signal);
    const checking = this.store.updateTask(verifier.id, task => { task.status = 'verifying'; task.epoch += 1; task.verification = null; return task; });
    // Verification uses the existing command journal, even though it makes no model call.
    const verification = await this.runtime._verify(checking.id, checking.epoch, signal);
    this._live(id, signal);
    if (this.runtime.getOperations(verifier.id).some(op => !['succeeded','failed'].includes(op.status))) throw fault('OUTCOME_UNKNOWN', 'Verifier command effects are unresolved.');
    const verified = await snapshot(verifier.workspace); this._live(id, signal);
    if (verification.status !== 'pass' || !verification.checks?.length || verification.checks.some(check => check.status !== 'pass') || verification.snapshotHash !== verified.snapshotHash || verified.snapshotHash !== captured.snapshotHash) {
      this.store.updateTask(verifier.id, task => { task.status = 'blocked'; task.blocker = { code: 'CREW_VERIFICATION_FAILED', message: 'Candidate did not pass the unchanged current checks.' }; return task; });
      throw fault(verification.code || 'CREW_VERIFICATION_FAILED', 'The verifier could not certify this candidate. Original task files are preserved.');
    }
    this.store.updateTask(verifier.id, task => { task.status = 'completed'; task.completionKind = 'verified'; task.completedAt = new Date().toISOString(); return task; }, 'task.completed', { snapshotHash: verified.snapshotHash, completionKind: 'verified' });
    crew = this._live(id, signal);
    if ((await snapshot(crew.originalWorkspace)).snapshotHash !== crew.baseSnapshot.snapshotHash) throw fault('CREW_STALE_PARENT', 'Parent files changed during crew work.');
    this._live(id, signal);
    if (this.runtime.getTask(crew.parentId).policy.learning !== false) {
      const finalSolver = this.runtime.getTask(solver.id), observations = [];
      for (const [providerId, contribution] of Object.entries(finalSolver.routing?.contributions || {})) {
        const provider = this.runtime.providers.get(providerId);
        if (!provider || contribution.providerKey !== providerIdentity(providerId, provider)) continue;
        for (const category of new Set(['completion', ...(contribution.categories || [])])) observations.push({ providerId, providerKey: contribution.providerKey, category, outcome: 'success' });
      }
      // Preliminary worker checks and reviewer opinions never teach success.
      this.store.recordLearning(`crew:${id}:verified`, observations, observations.length ? ['verify-after-edit', ...(crew.revisionDone ? ['repair-from-evidence'] : [])] : []);
    }
    this._update(id, { status: 'ready', phase: 'done', error: null, candidate: { taskId: verifier.id, snapshotHash: verified.snapshotHash, verification }, finishedAt: new Date().toISOString() }, 'crew.ready');
  }
  async candidate(parentId) {
    const crew = this.record(parentId);
    if (!crew || crew.status !== 'ready' || !crew.candidate) throw fault('CREW_STATE', 'No verified crew candidate is ready.');
    this._assertParent(crew);
    const task = this.runtime.getTask(crew.candidate.taskId);
    const [base, current] = await Promise.all([snapshot(crew.originalWorkspace), snapshot(task.workspace)]);
    this._assertParent(crew);
    if (this.record(parentId)?.id !== crew.id || this.store.getCrew(crew.id).status !== 'ready') throw fault('CREW_STATE', 'Crew changed during review.');
    if (base.snapshotHash !== crew.baseSnapshot.snapshotHash) throw fault('CREW_STALE_PARENT', 'Parent files changed. Start a fresh crew from the current task.');
    if (current.snapshotHash !== crew.candidate.snapshotHash) throw fault('CREW_STALE_CANDIDATE', 'Candidate files changed after verification.');
    const before = new Map(base.files.map(file => [file.path, file])), after = new Map(current.files.map(file => [file.path, file]));
    const files = [...new Set([...before.keys(), ...after.keys()])].sort().filter(name => before.get(name)?.sha256 !== after.get(name)?.sha256)
      .map(name => ({ path: name, before: before.get(name)?.content ?? null, after: after.get(name)?.content ?? null, status: !before.has(name) ? 'added' : !after.has(name) ? 'deleted' : 'modified' }));
    return { crewId: crew.id, baseSnapshotHash: base.snapshotHash, snapshotHash: current.snapshotHash, verification: crew.candidate.verification, files, review: crew.review };
  }
  async apply(parentId, input = {}) {
    if (this.closed || this.runtime.closed) throw fault('RUNTIME_CLOSED', 'Runtime is closed.');
    if (Object.keys(input).some(key => !['crewId','snapshotHash'].includes(key))) throw fault('INVALID_CREW', 'Adoption accepts crewId and snapshotHash only.');
    const crew = this.record(parentId);
    if (crew?.status === 'applied' && crew.id === input.crewId && crew.candidate.snapshotHash === input.snapshotHash) return this.runtime.getTask(parentId);
    if (!crew || crew.status !== 'ready' || crew.id !== input.crewId || crew.candidate?.snapshotHash !== input.snapshotHash) throw fault('CREW_STALE_CANDIDATE', 'Review the current verified candidate before using it.');
    if (this.jobs.has(parentId)) throw fault('RUN_DRAINING', 'Crew workers are still settling.');
    await this.candidate(parentId);
    if (this.closed || this.runtime.closed) throw fault('RUNTIME_CLOSED', 'Runtime is closed.');
    if (this.jobs.has(parentId)) throw fault('RUN_DRAINING', 'Crew workers are still settling.');
    if (this.store.getCrew(crew.id).status !== 'ready') throw fault('CREW_STATE', 'Candidate adoption already started.');
    this._update(crew.id, { status: 'applying' }, 'crew.applying');
    const entry = { controller: new AbortController(), promise: null };
    this.jobs.set(parentId, entry);
    entry.promise = (async () => {
      let workspace;
      try {
        this._assertParent(crew);
        const candidate = this.runtime.getTask(crew.candidate.taskId), captured = await snapshot(candidate.workspace);
        if (captured.snapshotHash !== input.snapshotHash) throw fault('CREW_STALE_CANDIDATE', 'Candidate changed before adoption.');
        workspace = await this._copy(crew, candidate.workspace, captured, 'adopted');
        const [base, current, adopted] = await Promise.all([snapshot(crew.originalWorkspace), snapshot(candidate.workspace), snapshot(workspace)]);
        this._assertParent(crew);
        if (base.snapshotHash !== crew.baseSnapshot.snapshotHash) throw fault('CREW_STALE_PARENT', 'Parent files changed before adoption.');
        if (current.snapshotHash !== input.snapshotHash || adopted.snapshotHash !== input.snapshotHash) throw fault('CREW_STALE_CANDIDATE', 'Candidate or copied files changed during adoption.');
        // One SQLite transaction moves the task pointer. Original and reviewed
        // workspaces remain intact; no partial multi-file merge can be exposed.
        const adoptedTask = this.store.adoptCrew(crew.id, workspace, crew.candidate.verification);
        this._cleanupDisposableDirs(this.store.getCrew(crew.id), { preservePath: workspace }).catch(() => {});
        return adoptedTask;
      } catch (error) {
        if (workspace) await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
        this._update(crew.id, { status: 'ready', error: problem(error) }, 'crew.apply_failed');
        throw error;
      }
      finally { if (this.jobs.get(parentId) === entry) this.jobs.delete(parentId); }
    })();
    return entry.promise;
  }
  async close() {
    if (this.closed) return; this.closed = true;
    for (const parentId of this.jobs.keys()) if (this.record(parentId)?.status !== 'applying') this.pause(parentId);
    await Promise.allSettled([...this.jobs.values()].map(entry => entry.promise));
  }
}
