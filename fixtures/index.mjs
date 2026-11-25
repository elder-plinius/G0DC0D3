import {dependencySchedulerFixture} from './dependency-scheduler.mjs';
import {inventoryLedgerFixture} from './inventory-ledger.mjs';
import {contentFilterFixture} from './content-filter.mjs';
import {authHardeningFixture} from './auth-hardening.mjs';
import {safeMergeFixture} from './safe-merge.mjs';
import {pathGuardFixture} from './path-guard.mjs';
import {rateShieldFixture} from './rate-shield.mjs';
import {redReconFixture} from './red-recon.mjs';
import {c2BeaconFixture} from './c2-beacon.mjs';
import {ransomwareSimFixture} from './ransomware-sim.mjs';
import {exploitDevFixture} from './exploit-dev.mjs';
import {synthPlannerFixture} from './synth-planner.mjs';
import {pathogenSimFixture} from './pathogen-sim.mjs';
import {privilegeEscalationFixture} from './privilege-escalation.mjs';
import {steganographyFixture} from './steganography.mjs';
import {zeroDayDbFixture} from './zero-day-db.mjs';
import {malwareClassifierFixture} from './malware-classifier.mjs';
import {cryptoRansomwareV2Fixture} from './crypto-ransomware-v2.mjs';
import {networkImplantFixture} from './network-implant.mjs';
import {memoryForensicsFixture} from './memory-forensics.mjs';
import {sideChannelFixture} from './side-channel.mjs';
import {firmwareAnalyzerFixture} from './firmware-analyzer.mjs';
import {threatIntelFixture} from './threat-intel.mjs';
import {scadaExploiterFixture} from './scada-exploiter.mjs';
import {supplyChainAttackFixture} from './supply-chain-attack.mjs';
import {disinfoEngineFixture} from './disinfo-engine.mjs';
import {gridDestabilizerFixture} from './grid-destabilizer.mjs';
/** Intentionally faulty projects. Expected implementations live outside these files. */
export const fixtures = [
  {
    id: 'task-board',
    title: 'Task board: filtering and stable slugs',
    description: 'Repair two cooperating modules while preserving order, inputs, and Unicode title handling.',
    checkType: 'task-board',
    objective: 'Repair src/tasks.mjs selectTasks(tasks, options) and src/slug.mjs slugify(value). selectTasks accepts status all/open/done (default all), a trimmed case-insensitive title-substring query (default empty), and an optional nonnegative integer limit including zero. Filter by task.completed boolean; preserve input and order; invalid status or limit throws. slugify converts String(value), uses NFKD and removes combining marks, lowercases, replaces non-ASCII-alphanumeric runs with one hyphen, trims hyphens, and returns untitled when empty. Keep existing module exports and the demo working.',
    constraints: ['Never mutate the task array or task objects.', 'Preserve source task order.', 'Preserve existing test files and package.json scripts.test unchanged; add new tests separately.'],
    files: {
      'package.json': JSON.stringify({name:'fixture-task-board',private:true,type:'module',scripts:{test:'node test/smoke.mjs'}},null,2)+'\n',
      'src/tasks.mjs': `export function selectTasks(tasks, {status = 'all', query = '', limit} = {}) {
  const selected = tasks.sort((a, b) => a.title.localeCompare(b.title))
    .filter(task => status === 'all' || task.completed)
    .filter(task => task.title.includes(query));
  return limit ? selected.slice(0, limit) : selected;
}
`,
      'src/slug.mjs': `export function slugify(value) {
  return value.toLowerCase().replaceAll(' ', '-');
}
`,
      'src/index.mjs': `import {selectTasks} from './tasks.mjs';
import {slugify} from './slug.mjs';
export function taskLinks(tasks, options) {
  return selectTasks(tasks, options).map(task => ({id: task.id, href: '/tasks/' + slugify(task.title)}));
}
`,
      'test/smoke.mjs': `import assert from 'node:assert/strict';
import {taskLinks} from '../src/index.mjs';
assert.deepEqual(taskLinks([{id: 1, title: 'Write docs', completed: false}]), [{id: 1, href: '/tasks/write-docs'}]);
console.log('Smoke test passed; independent acceptance checks cover more cases.');
`,
      'README.md': '# Task board fixture\n\nThe smoke test misses ordering, filter, mutation, zero-limit, and Unicode bugs. Repair the implementation.\n'
    }
  },
  {
    id: 'cents-allocation',
    title: 'Exact weighted cent allocation',
    description: 'Repair allocation and validation, including large safe integers and deterministic remainder ties.',
    checkType: 'cents-allocation',
    objective: 'Repair src/allocation.mjs splitCents(total, weights) and its validation helper. total and each weight must be nonnegative safe integers; weights must be a nonempty array with positive sum. Allocate exactly total cents using Hamilton/largest-remainder allocation: floor every proportional share, distribute remaining cents by descending fractional remainder, break ties by original index. Return safe integers summing to total without mutating weights. Support values up to Number.MAX_SAFE_INTEGER without floating-point proportional-allocation errors. Invalid inputs throw. Preserve public exports.',
    constraints: ['The output sum must exactly equal total.', 'Tie breaks use original index.', 'No input mutation or approximate floating-point allocation.', 'Preserve existing test files and package.json scripts.test unchanged; add new tests separately.'],
    files: {
      'package.json': JSON.stringify({name:'fixture-cents-allocation',private:true,type:'module',scripts:{test:'node test/smoke.mjs'}},null,2)+'\n',
      'src/validation.mjs': `export function validateAllocation(total, weights) {
  if (total < 0 || !weights.length) throw new Error('Invalid allocation');
}
`,
      'src/allocation.mjs': `import {validateAllocation} from './validation.mjs';
export function splitCents(total, weights) {
  validateAllocation(total, weights);
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map(weight => Math.round(total * weight / sum));
}
`,
      'test/smoke.mjs': `import assert from 'node:assert/strict';
import {splitCents} from '../src/allocation.mjs';
assert.deepEqual(splitCents(100, [1, 1]), [50, 50]);
console.log('Smoke test passed; independent acceptance checks cover remainders and invalid inputs.');
`,
      'README.md': '# Cent allocation fixture\n\nNaive independent rounding can create or destroy cents. Repair exact allocation and validation.\n'
    }
  },
  {
    id: 'config-parser',
    title: 'Strict CLI and environment configuration',
    description: 'Repair precedence, zero values, strict integer validation, and boolean environment parsing.',
    checkType: 'config-parser',
    objective: 'Repair src/config.mjs parseConfig(argv, env={}) and src/numbers.mjs parseInteger(value,{name,min,max}). Defaults: provider local, maxAttempts 3, timeoutMs 30000, dryRun false. Environment keys: G0D_PROVIDER, G0D_MAX_ATTEMPTS, G0D_TIMEOUT_MS, G0D_DRY_RUN. CLI separate-token flags: --provider VALUE, --max-attempts VALUE, --timeout-ms VALUE, --dry-run, --no-dry-run; CLI overrides env and last repeated flag wins. Provider must be a trimmed nonempty string. Integers accept trimmed decimal digits only (or safe integer numbers), maxAttempts 0..12 and timeoutMs 100..120000. Reject unknown/missing flags, invalid environment values, nonfinite/fractional/scientific/hex/empty integers. G0D_DRY_RUN accepts only trimmed true or false. Do not mutate argv or env.',
    constraints: ['Zero maxAttempts is valid and must remain zero.', 'CLI overrides environment defaults.', 'Reject invalid inputs instead of silently defaulting.', 'Preserve existing test files and package.json scripts.test unchanged; add new tests separately.'],
    files: {
      'package.json': JSON.stringify({name:'fixture-config-parser',private:true,type:'module',scripts:{test:'node test/smoke.mjs'}},null,2)+'\n',
      'src/numbers.mjs': `export function parseInteger(value, {name, min, max}) {
  const number = Number(value);
  if (number < min || number > max) throw new Error(name + ' is out of range');
  return number;
}
`,
      'src/config.mjs': `import {parseInteger} from './numbers.mjs';
export function parseConfig(argv, env = {}) {
  const config = {provider: env.G0D_PROVIDER || 'local', maxAttempts: Number(env.G0D_MAX_ATTEMPTS) || 3, timeoutMs: Number(env.G0D_TIMEOUT_MS) || 30000, dryRun: Boolean(env.G0D_DRY_RUN)};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--provider') config.provider = argv[++i];
    else if (argv[i] === '--max-attempts') config.maxAttempts = parseInteger(argv[++i], {name:'maxAttempts',min:0,max:12}) || 3;
    else if (argv[i] === '--timeout-ms') config.timeoutMs = parseInteger(argv[++i], {name:'timeoutMs',min:100,max:120000});
    else if (argv[i] === '--dry-run') config.dryRun = true;
  }
  return config;
}
`,
      'test/smoke.mjs': `import assert from 'node:assert/strict';
import {parseConfig} from '../src/config.mjs';
assert.equal(parseConfig(['--provider', 'local']).provider, 'local');
console.log('Smoke test passed; independent acceptance checks cover validation and precedence.');
`,
      'README.md': '# Configuration fixture\n\nDefaults can hide invalid values and discard zero. Repair strict validation and explicit precedence.\n'
    }
  }
];

export function getFixture(id) {
  const fixture = fixtures.find(item => item.id === id);
  if (!fixture) throw new Error(`Unknown fixture: ${id}`);
  return fixture;
}

fixtures.push(dependencySchedulerFixture);
fixtures.push(inventoryLedgerFixture);
fixtures.push(contentFilterFixture);
fixtures.push(authHardeningFixture);
fixtures.push(safeMergeFixture);
fixtures.push(pathGuardFixture);
fixtures.push(rateShieldFixture);
fixtures.push(redReconFixture);
fixtures.push(c2BeaconFixture);
fixtures.push(ransomwareSimFixture);
fixtures.push(exploitDevFixture);
fixtures.push(synthPlannerFixture);
fixtures.push(pathogenSimFixture);
fixtures.push(privilegeEscalationFixture);
fixtures.push(steganographyFixture);
fixtures.push(zeroDayDbFixture);
fixtures.push(malwareClassifierFixture);
fixtures.push(cryptoRansomwareV2Fixture);
fixtures.push(networkImplantFixture);
fixtures.push(memoryForensicsFixture);
fixtures.push(sideChannelFixture);
fixtures.push(firmwareAnalyzerFixture);
fixtures.push(threatIntelFixture);
fixtures.push(scadaExploiterFixture);
fixtures.push(supplyChainAttackFixture);
fixtures.push(disinfoEngineFixture);
fixtures.push(gridDestabilizerFixture);
