import {schedulerRepairFiles} from './scheduler-repairs.mjs';
import {inventoryRepairFiles} from './inventory-repairs.mjs';
import {extraFixtureRepairs} from './fixture-repairs.mjs';
/** Deterministic fault injection and known repairs. This is not an AI model. */
export const scriptedScenarios = ['normal','refusal','timeout','premature_done','loop','malformed_tool','partial_progress','forged_report'];

export const repairFiles = {
  ...extraFixtureRepairs,
  'inventory-ledger':inventoryRepairFiles,
  'dependency-scheduler':schedulerRepairFiles,
  'task-board': {
    'src/tasks.mjs': `export function selectTasks(tasks, {status = 'all', query = '', limit} = {}) {
  if (!['all', 'open', 'done'].includes(status)) throw new TypeError('Invalid status');
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) throw new TypeError('Invalid limit');
  const needle = String(query).trim().toLowerCase();
  const selected = tasks.filter(task => status === 'all' || (status === 'done' ? task.completed === true : task.completed === false))
    .filter(task => String(task.title).toLowerCase().includes(needle));
  return limit === undefined ? selected : selected.slice(0, limit);
}
`,
    'src/slug.mjs': `export function slugify(value) {
  return String(value).normalize('NFKD').replace(/\\p{M}+/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
}
`
  },
  'cents-allocation': {
    'src/validation.mjs': `export function validateAllocation(total, weights) {
  if (!Number.isSafeInteger(total) || total < 0) throw new TypeError('Invalid total');
  if (!Array.isArray(weights) || weights.length === 0 || weights.some(weight => !Number.isSafeInteger(weight) || weight < 0) || !weights.some(weight => weight > 0)) throw new TypeError('Invalid weights');
}
`,
    'src/allocation.mjs': `import {validateAllocation} from './validation.mjs';
export function splitCents(total, weights) {
  validateAllocation(total, weights);
  const whole = BigInt(total);
  const sum = weights.reduce((value, weight) => value + BigInt(weight), 0n);
  const shares = weights.map((weight, index) => ({index, amount: whole * BigInt(weight) / sum, remainder: whole * BigInt(weight) % sum}));
  let remaining = whole - shares.reduce((value, share) => value + share.amount, 0n);
  const order = [...shares].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (const share of order) { if (remaining === 0n) break; share.amount++; remaining--; }
  return shares.map(share => Number(share.amount));
}
`
  },
  'config-parser': {
    'src/numbers.mjs': `export function parseInteger(value, {name, min, max}) {
  if (typeof value === 'string') {
    if (!/^\\d+$/.test(value.trim())) throw new TypeError(name + ' must be a decimal integer');
    value = Number(value.trim());
  }
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(name + ' is out of range');
  return value;
}
`,
    'src/config.mjs': `import {parseInteger} from './numbers.mjs';
export function parseConfig(argv, env = {}) {
  if (!Array.isArray(argv)) throw new TypeError('argv must be an array');
  const provider = value => { if (typeof value !== 'string' || !value.trim()) throw new TypeError('Invalid provider'); return value.trim(); };
  const attempts = value => parseInteger(value, {name:'maxAttempts',min:0,max:12});
  const timeout = value => parseInteger(value, {name:'timeoutMs',min:100,max:120000});
  const boolean = value => { if (typeof value !== 'string' || !['true','false'].includes(value.trim())) throw new TypeError('Invalid dryRun'); return value.trim() === 'true'; };
  const config = {
    provider: env.G0D_PROVIDER === undefined ? 'local' : provider(env.G0D_PROVIDER),
    maxAttempts: env.G0D_MAX_ATTEMPTS === undefined ? 3 : attempts(env.G0D_MAX_ATTEMPTS),
    timeoutMs: env.G0D_TIMEOUT_MS === undefined ? 30000 : timeout(env.G0D_TIMEOUT_MS),
    dryRun: env.G0D_DRY_RUN === undefined ? false : boolean(env.G0D_DRY_RUN)
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--dry-run') config.dryRun = true;
    else if (flag === '--no-dry-run') config.dryRun = false;
    else if (['--provider','--max-attempts','--timeout-ms'].includes(flag)) {
      const value = argv[++i];
      if (typeof value !== 'string' || value.startsWith('--')) throw new TypeError('Missing value for ' + flag);
      if (flag === '--provider') config.provider = provider(value);
      else if (flag === '--max-attempts') config.maxAttempts = attempts(value);
      else config.timeoutMs = timeout(value);
    } else throw new TypeError('Unknown flag: ' + flag);
  }
  return config;
}
`
  }
};

function contents(context) {
  return new Map((context.files || []).map(file => [file.path, file.content]));
}

function isFirstRequest(context) {
  // The controller increments calls before dispatch. Both conventions are tolerated.
  const previousResponses = (context.history || []).filter(event => event.type === 'model.response');
  return previousResponses.length === 0 && Number(context.task.calls || 0) <= 1;
}

export function scriptedRepair(context, {id='scripted-primary',inject=true} = {}) {
  const {task} = context;
  if (task.crewMember?.role === 'challenger') {
    // A deterministic fixture comparison for the crew demo, never AI review.
    const known = repairFiles[task.fixtureId], existing = contents(context);
    const findings = known ? Object.entries(known).filter(([name, content]) => existing.get(name) !== content).slice(0, 6)
      .map(([name]) => ({ path: name, detail: 'This fixture module differs from the known repair. Inspect its acceptance requirements.' })) : [{ path: '', detail: 'No known fixture repair exists for this scripted review.' }];
    return { type: 'message', finish: 'done', text: JSON.stringify({ verdict: findings.length ? 'changes_requested' : 'approve', findings }) };
  }
  if (task.planMode === true) {
    const known = repairFiles[task.fixtureId];
    const targets = known ? Object.keys(known) : (context.files || []).slice(0, 5).map(f => f.path);
    const checklist = targets.length ? targets.map(p => `- [ ] Update \`${p}\``).join('\n') : '- [ ] Inspect workspace files and apply changes';
    return { type: 'message', finish: 'done', text: `### Implementation Plan\n${checklist}\n- [ ] Verify acceptance checks after switching to Build Mode` };
  }
  const scenario = task.scenario || 'normal';
  const first = inject && isFirstRequest(context);
  if (inject && scenario === 'loop') return {type:'message',text:'I cannot complete this task with the current approach.',finish:'refusal'};
  if (first && scenario === 'refusal') return {type:'message',text:'I cannot edit this many files; I can only provide advice.',finish:'refusal'};
  if (first && scenario === 'timeout') return {type:'error',code:'ETIMEDOUT',message:'Injected transient provider timeout.',retryable:true};
  if (first && scenario === 'premature_done') return {type:'message',text:'Everything is fixed. All tests pass.',finish:'done'};
  if (first && scenario === 'malformed_tool') return {type:'tool',calls:[{id:`${id}:malformed`,name:'repo.write',args:{path:'src/broken.mjs'}}]};
  if (first && scenario === 'forged_report') return {type:'tool',calls:[{id:`${id}:forge`,name:'repo.write',args:{path:'acceptance-results.json',content:JSON.stringify({status:'pass',checks:'all passed'})}}]};
  const repairs = repairFiles[task.fixtureId];
  if (!repairs) return {type:'message',text:'No scripted repair exists for this task; this provider only demonstrates fault recovery.',finish:'continue'};
  const existing = contents(context);
  for (const [path,content] of Object.entries(repairs)) {
    if (existing.get(path) !== content) return {type:'tool',calls:[{id:`${id}:${task.id}:${path}:${task.calls}`,name:'repo.write',args:{path,content}}]};
  }
  const text = scenario === 'partial_progress' ? 'The fixture includes the phrase "I cannot comply" as test data; the implementation is complete.' : 'The requested modules are repaired. Run independent acceptance checks against this snapshot.';
  return {type:'message',text,finish:'done'};
}

export function createScriptedProviders() {
  return new Map([
    ['scripted-primary', {id:'scripted-primary',label:'Scripted primary · fault injection',kind:'scripted',async turn(context) { return scriptedRepair(context); }}],
    ['scripted-fallback', {id:'scripted-fallback',label:'Scripted fallback · known repair',kind:'scripted',async turn(context) { return scriptedRepair(context,{id:'scripted-fallback',inject:false}); }}]
  ]);
}
