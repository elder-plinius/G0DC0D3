import { fileURLToPath } from 'node:url';
import { snapshotWorkspace } from './broker.mjs';
import { getFixture } from '../fixtures/index.mjs';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { executionBoundaryForPlatform, runCommand, runReadOnlyWorker, validateChecks } from './runner.mjs';
export { snapshotWorkspace } from './broker.mjs';

const worker = fileURLToPath(new URL('./probe-worker.mjs', import.meta.url));
const verifierFiles = ['./runner.mjs','./evaluator.mjs','./probe-worker.mjs','./probes-scheduler.mjs','./probes-inventory.mjs','./probes-content-filter.mjs','./probes-auth-hardening.mjs','./probes-safe-merge.mjs','./probes-path-guard.mjs','./probes-rate-shield.mjs','./probes-red-recon.mjs','./probes-c2-beacon.mjs','./probes-ransomware-sim.mjs','./probes-exploit-dev.mjs','./probes-synth-planner.mjs','./probes-pathogen-sim.mjs','./probes-privilege-escalation.mjs','./probes-steganography.mjs','./probes-zero-day-db.mjs','./probes-malware-classifier.mjs','./probes-crypto-ransomware-v2.mjs','./probes-network-implant.mjs','./probes-memory-forensics.mjs','./probes-side-channel.mjs','./probes-firmware-analyzer.mjs','./probes-threat-intel.mjs','./probes-scada-exploiter.mjs','./probes-supply-chain-attack.mjs','./probes-disinfo-engine.mjs','./probes-grid-destabilizer.mjs','../fixtures/index.mjs','../fixtures/dependency-scheduler.mjs','../fixtures/inventory-ledger.mjs','../fixtures/content-filter.mjs','../fixtures/auth-hardening.mjs','../fixtures/safe-merge.mjs','../fixtures/path-guard.mjs','../fixtures/rate-shield.mjs','../fixtures/red-recon.mjs','../fixtures/c2-beacon.mjs','../fixtures/ransomware-sim.mjs','../fixtures/exploit-dev.mjs','../fixtures/synth-planner.mjs','../fixtures/pathogen-sim.mjs','../fixtures/privilege-escalation.mjs','../fixtures/steganography.mjs','../fixtures/zero-day-db.mjs','../fixtures/malware-classifier.mjs','../fixtures/crypto-ransomware-v2.mjs','../fixtures/network-implant.mjs','../fixtures/memory-forensics.mjs','../fixtures/side-channel.mjs','../fixtures/firmware-analyzer.mjs','../fixtures/threat-intel.mjs','../fixtures/scada-exploiter.mjs','../fixtures/supply-chain-attack.mjs','../fixtures/disinfo-engine.mjs','../fixtures/grid-destabilizer.mjs'];
const workerModules = verifierFiles.filter(name => name.startsWith('./probes-')).map(name => fileURLToPath(new URL(name, import.meta.url)));
async function verifierHash() {
  const contents=await Promise.all(verifierFiles.map(name=>fs.readFile(fileURLToPath(new URL(name,import.meta.url)))));
  const hash=createHash('sha256');for(const content of contents)hash.update(content);return hash.digest('hex');
}

/** Independent probes live outside the editable candidate workspace. */
export async function evaluateTask(task, { signal, timeoutMs = 10000 } = {}) {
  const started = Date.now();
  let snapshot;
  try { snapshot = await snapshotWorkspace(task.workspace); }
  catch (error) { return { status: 'unknown', snapshotHash: null, checks: [{ name: 'snapshot', status: 'unknown', detail: error.message }], durationMs: Date.now() - started }; }
  if (task.checks?.length) {
    if (task.checksContractVersion !== (task.contractVersion || 1)) return { status: 'unknown', snapshotHash: snapshot.snapshotHash, checks: [{ name: 'Owner check contract', status: 'unknown', detail: 'Configured checks predate the current task requirements. Reconfirm the checks before using them as acceptance evidence.' }], durationMs: Date.now() - started };
    const checks = [];
    try {
      for (const check of validateChecks(task.checks)) {
        if (signal?.aborted) throw Object.assign(new Error('Evaluation cancelled.'), { code: 'EVALUATION_CANCELLED' });
        // Each check receives the owner command grant. The controller bounds
        // the aggregate sequence separately, including sandbox setup/drain.
        const result = await runCommand(task, { command: check.command }, { signal });
        const checkStatus = result.cancelled || result.timedOut || result.detachedObserved || result.drainUncertain || result.truncated ? 'unknown' : result.exitCode === 0 ? 'pass' : 'fail';
        checks.push({ name: check.name, status: checkStatus, detail: checkStatus === 'pass' ? 'Owner-configured command exited successfully; coverage is limited to this command.' : `Command exit ${result.exitCode}; timeout=${result.timedOut}; cancelled=${result.cancelled}; output truncated=${result.truncated}; detached=${result.detachedObserved}.`, command: check.command, ...result });
        if (result.cancelled || result.detachedObserved || result.drainUncertain) break;
      }
    } catch (cause) { checks.push({ name: 'Command evaluator', status: 'unknown', detail: cause.message, code: cause.code || 'EVALUATION_ERROR' }); }
    let after;
    try { after = await snapshotWorkspace(task.workspace); } catch (cause) { checks.push({ name: 'Result snapshot', status: 'unknown', detail: cause.message }); }
    if (after && after.snapshotHash !== snapshot.snapshotHash) checks.push({ name: 'Snapshot stable', status: 'unknown', detail: 'Commands changed the copied source files. Run checks again against the current snapshot.' });
    return { ...(checks.some(check => check.detachedObserved || check.drainUncertain) ? { code: 'EXECUTION_OUTCOME_UNKNOWN' } : checks.find(check => check.code) ? { code: checks.find(check => check.code).code } : {}), status: checks.some(check => check.status === 'unknown') ? 'unknown' : checks.some(check => check.status === 'fail') ? 'fail' : 'pass', snapshotHash: after?.snapshotHash ?? snapshot.snapshotHash, checks, durationMs: Date.now() - started, evidenceKind: 'owner_configured_commands', executionBoundary: executionBoundaryForPlatform() || 'macos-seatbelt', requirementCoverage: 'Only the owner-selected command assertions; not independent proof of every requested behavior.' };
  }
  const checkType = task.fixtureId || task.acceptance?.checkType;
  if (!['task-board', 'cents-allocation', 'config-parser', 'dependency-scheduler', 'inventory-ledger', 'content-filter', 'auth-hardening', 'safe-merge', 'path-guard', 'rate-shield', 'red-recon', 'c2-beacon', 'ransomware-sim', 'exploit-dev', 'synth-planner', 'pathogen-sim', 'privilege-escalation', 'steganography', 'zero-day-db', 'malware-classifier', 'crypto-ransomware-v2', 'network-implant', 'memory-forensics', 'side-channel', 'firmware-analyzer', 'threat-intel', 'scada-exploiter', 'supply-chain-attack', 'disinfo-engine', 'grid-destabilizer'].includes(checkType)) {
    return { status: 'unknown', snapshotHash: snapshot.snapshotHash, checks: [{ name: 'Acceptance plan', status: 'unknown', detail: 'No independent executable checks are registered for this task. Owner acceptance remains available.' }], durationMs: Date.now() - started };
  }
  if (signal?.aborted) throw signal.reason || new Error('Evaluation cancelled');
  const fixture = getFixture(checkType), source = new Map(snapshot.files.map(file=>[file.path,file.content]));
  const implementationHash=await verifierHash();
  if(task.acceptance?.fixtureVersion && task.acceptance.fixtureVersion!==(fixture.version||1))return{status:'unknown',snapshotHash:snapshot.snapshotHash,checks:[{name:'Acceptance version',status:'unknown',detail:'The registered acceptance contract has changed. Create a task with the current fixture version.'}],fixtureVersion:fixture.version||1,verifierHash:implementationHash};
  let integrity = true;
  for (const [name,content] of Object.entries(fixture.files)) if (name.startsWith('test/') && source.get(name)!==content) integrity=false;
  try {if(JSON.parse(source.get('package.json')).scripts?.test!==JSON.parse(fixture.files['package.json']).scripts.test)integrity=false;}catch{integrity=false;}
  let result;
  try {
    const input = JSON.stringify({ checkType, files: snapshot.files.map(({ path, content }) => ({ path, content })) });
    const run = await runReadOnlyWorker(worker, workerModules, input, { signal, timeoutMs });
    if (run.cancelled) throw new Error('Evaluation cancelled.');
    if (run.timedOut) throw new Error('Fixture worker exceeded its time limit.');
    if (run.truncated || run.detachedObserved || run.drainUncertain) throw new Error('Incomplete fixture worker output.');
    if (run.exitCode !== 0) throw new Error('The isolated fixture worker could not complete.');
    const parsed = JSON.parse(run.stdout);
    if (!Array.isArray(parsed?.checks) || !['pass', 'fail', 'unknown'].includes(parsed.status))
      throw new Error('Invalid fixture worker response.');
    result = { ...parsed, executionBoundary: executionBoundaryForPlatform(process.platform, { readOnly: true }) || 'macos-seatbelt-read-only' };
  } catch (error) {
    result = { status: 'unknown', checks: [{ name: 'Probe worker', status: 'unknown', detail: error.message }] };
  }
  const verifierChanged=implementationHash!==await verifierHash();
  const checks = [...result.checks, {name:'Original project tests preserved',status:integrity?'pass':'fail',detail:integrity?'Original test files and test command match the fixture.':'Candidate altered original test files or the test command.'}];
  if(verifierChanged)checks.push({name:'Verifier version stable',status:'unknown',detail:'Verifier files changed during this evaluation; run it again.'});
  return { ...result, status:verifierChanged || !result.executionBoundary?'unknown':integrity?result.status:'fail',checks,snapshotHash: snapshot.snapshotHash, fixtureId: checkType, fixtureVersion:fixture.version||1,verifierHash:implementationHash,durationMs: Date.now() - started, evidenceKind: 'independent_fixture_probes' };
}
