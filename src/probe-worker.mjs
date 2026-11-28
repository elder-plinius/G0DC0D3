import vm from 'node:vm';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import buffer from 'node:buffer';
import { runSchedulerProbes } from './probes-scheduler.mjs';
import { runInventoryProbes } from './probes-inventory.mjs';
import { runContentFilterProbes } from './probes-content-filter.mjs';
import { runAuthHardeningProbes } from './probes-auth-hardening.mjs';
import { runSafeMergeProbes } from './probes-safe-merge.mjs';
import { runPathGuardProbes } from './probes-path-guard.mjs';
import { runRateShieldProbes } from './probes-rate-shield.mjs';
import { runRedReconProbes } from './probes-red-recon.mjs';
import { runC2BeaconProbes } from './probes-c2-beacon.mjs';
import { runRansomwareSimProbes } from './probes-ransomware-sim.mjs';
import { runExploitDevProbes } from './probes-exploit-dev.mjs';
import { runSynthPlannerProbes } from './probes-synth-planner.mjs';
import { runPathogenSimProbes } from './probes-pathogen-sim.mjs';
import { runPrivilegeEscalationProbes } from './probes-privilege-escalation.mjs';
import { runSteganographyProbes } from './probes-steganography.mjs';
import { runZeroDayDbProbes } from './probes-zero-day-db.mjs';
import { runMalwareClassifierProbes } from './probes-malware-classifier.mjs';
import { runCryptoRansomwareV2Probes } from './probes-crypto-ransomware-v2.mjs';
import { runNetworkImplantProbes } from './probes-network-implant.mjs';
import { runMemoryForensicsProbes } from './probes-memory-forensics.mjs';
import { runSideChannelProbes } from './probes-side-channel.mjs';
import { runFirmwareAnalyzerProbes } from './probes-firmware-analyzer.mjs';
import { runThreatIntelProbes } from './probes-threat-intel.mjs';
import { runScadaExploiterProbes } from './probes-scada-exploiter.mjs';
import { runSupplyChainAttackProbes } from './probes-supply-chain-attack.mjs';
import { runDisinfoEngineProbes } from './probes-disinfo-engine.mjs';
import { runGridDestabilizerProbes } from './probes-grid-destabilizer.mjs';

const origStdoutWrite = process.stdout.write.bind(process.stdout);
let input = '';
for await (const chunk of process.stdin) { input += chunk; if (input.length > 3 * 1024 * 1024) throw new Error('Input limit'); }
const request = JSON.parse(input);
const resultNonce = typeof request.resultNonce === 'string' && /^[0-9a-f]{32}$/.test(request.resultNonce) ? request.resultNonce : '';
delete request.resultNonce;
input = '';
const files = new Map(request.files.map(f => [f.path, f.content]));
const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
// Context-owned no-op console avoids exposing host functions through constructors.
vm.runInContext('globalThis.console = Object.freeze({log(){},error(){},warn(){},info(){}})', context);
vm.runInContext('globalThis.performance = Object.freeze({now(){return Date.now()}})', context);
context.Buffer = buffer.Buffer;
// Keep evaluation transport outside the candidate's globals and mutable intrinsics.
// Only invoke is installed in the context so vm can time-limit candidate execution.
const bridge = vm.runInContext(`(() => {
  const parse = JSON.parse, apply = Reflect.apply, freeze = Object.freeze, Buf = Buffer;
  const revive = (k,v) => { if(!v||typeof v!=='object')return v; if(v.type==='Buffer'&&Array.isArray(v.data))return Buf.from(v.data); if(v.type==='Uint8Array'&&Array.isArray(v.data))return new Uint8Array(v.data); return v; };
  let fn, args, value;
  const invoke = () => { value = apply(fn, undefined, args); };
  Object.defineProperty(globalThis, '__g0dInvoke', {value: invoke, writable:false, configurable:false});
  return freeze({prepare(f, encoded) { fn=f; args=parse(encoded, revive); value=undefined; }, arguments(){return args;}, result(){return value;}});
})()`, context);
function enhanceArr(arr) {
  Object.defineProperty(arr, '_isBuffer', {value: true});
  Object.defineProperty(arr, 'readUInt32LE', {value(o=0) { return arr[o]+arr[o+1]*256+arr[o+2]*65536+arr[o+3]*16777216; }});
  Object.defineProperty(arr, 'readUInt16BE', {value(o=0) { return arr[o]*256+arr[o+1]; }});
  Object.defineProperty(arr, 'toString', {value(enc) {
    if(enc==='hex') return arr.map(b=>b.toString(16).padStart(2,'0')).join('');
    if(enc==='ascii'||enc==='latin1'||enc==='binary') return arr.map(b=>String.fromCharCode(b)).join('');
    if(enc==='utf8'||enc==='utf-8') return new TextDecoder().decode(new Uint8Array(arr));
    return Array.prototype.toString.call(arr);
  }});
  Object.defineProperty(arr, 'toJSON', {value() { return {type: 'Buffer', data: Array.from(arr)}; }});
  Object.defineProperty(arr, 'slice', {value(...args) { return enhanceArr(Array.prototype.slice.apply(arr, args)); }});
  return arr;
}
Object.defineProperty(buffer.Buffer, Symbol.hasInstance, {
  value(obj) {
    if (obj == null) return false;
    let p = Object.getPrototypeOf(obj);
    while (p) { if (p === buffer.Buffer.prototype) return true; p = Object.getPrototypeOf(p); }
    return Array.isArray(obj) && obj._isBuffer === true;
  },
  configurable: true
});
function plainData(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') {
    if (['function','symbol','bigint'].includes(typeof value)) throw new Error('Probe result must be plain data');
    return value;
  }
  if (buffer.Buffer.isBuffer(value)) {
    return enhanceArr([...value]);
  }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const HostCtor = globalThis[value.constructor.name] || value.constructor;
    return new HostCtor(value);
  }
  if (seen.has(value)) throw new Error('Cyclic probe result');
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output = Array.isArray(value) ? new Array(descriptors.length.value) : {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key === 'length' && Array.isArray(value)) continue;
    if (!descriptor.enumerable) continue;
    if (!Object.hasOwn(descriptor, 'value')) throw new Error('Accessors are unavailable in probe output');
    Object.defineProperty(output,key,{value:plainData(descriptor.value,seen),enumerable:true,writable:true,configurable:true});
  }
  seen.delete(value);
  return output;
}
function freezeInput(value) {
  if (!value || typeof value !== 'object') return;
  if (ArrayBuffer.isView(value)) return;
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (Object.hasOwn(descriptor, 'value')) freezeInput(descriptor.value);
  }
  Object.freeze(value);
}
const modules = new Map();
const builtinModules = { 'node:crypto': crypto, 'crypto': crypto, 'node:assert': assert, 'node:assert/strict': assert, 'node:buffer': buffer, 'buffer': buffer };
const allowedBuiltins = new Set(Object.keys(builtinModules));
const builtinCache = new Map();
async function loadBuiltin(specifier) {
  if (builtinCache.has(specifier)) return builtinCache.get(specifier);
  const actual = builtinModules[specifier];
  if (!actual) throw new Error(`No builtin for ${specifier}`);
  const exportNames = Object.keys(actual);
  const synth = new vm.SyntheticModule(['default', ...exportNames], function () {
    this.setExport('default', actual);
    for (const name of exportNames) this.setExport(name, actual[name]);
  }, { context, identifier: specifier });
  await synth.link(() => { throw new Error('Builtins do not import'); });
  await synth.evaluate();
  builtinCache.set(specifier, synth);
  return synth;
}
async function load(name) {
  name = path.posix.normalize(name);
  if (name.startsWith('../') || name.startsWith('/') || !files.has(name)) throw new Error(`Unavailable candidate module: ${name}`);
  if (modules.has(name)) return modules.get(name);
  const mod = new vm.SourceTextModule(files.get(name), {
    context, identifier: name,
    importModuleDynamically() { throw new Error('Dynamic imports are unavailable in fixture probes'); }
  });
  modules.set(name, mod);
  await mod.link((specifier, referencing) => {
    if (allowedBuiltins.has(specifier)) return loadBuiltin(specifier);
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) throw new Error(`External import denied in probes: ${specifier}`);
    return load(path.posix.join(path.posix.dirname(referencing.identifier), specifier));
  });
  await mod.evaluate({ timeout: 500 });
  return mod;
}
const checks = [];
async function test(name, fn) {
  try { await fn(); checks.push({ name, status: 'pass', detail: 'Independent assertion passed' }); }
  catch (e) { checks.push({ name, status: 'fail', detail: String(e.message).slice(0,1400) }); }
}
async function call(modulePath, exportName, args, { immutable = false } = {}) {
  const module = await load(modulePath);
  if (typeof module.namespace[exportName] !== 'function') throw new Error(`Missing export ${exportName}`);
  bridge.prepare(module.namespace[exportName], JSON.stringify(args, (k, v) => ArrayBuffer.isView(v) && !(v instanceof DataView) ? { type: v.constructor.name, data: Array.from(v) } : v));
  if (immutable) freezeInput(bridge.arguments());
  const before = plainData(bridge.arguments());
  vm.runInContext('__g0dInvoke()', context, { timeout: 500 });
  if (immutable) assert.deepEqual(plainData(bridge.arguments()), before, 'Input arguments were mutated');
  return plainData(bridge.result());
}
const eq = assert.deepEqual;
async function throws(fn, label) { let threw = false; try { await fn(); } catch { threw = true; } if (!threw) throw new Error(`Expected rejection of invalid input${label ? ' for ' + label : ''}`); }

if (request.checkType === 'task-board') {
  const tasks = [
    { id: 3, title: 'Write API docs', completed: false },
    { id: 1, title: 'Fix café search', completed: true },
    { id: 2, title: 'Review API', completed: false },
    { id: 4, title: 'Ship release', completed: true }
  ];
  const select = (options={}) => call('src/tasks.mjs','selectTasks',[tasks,options],{immutable:true});
  await test('Default preserves order and input', async()=> eq(await select(),tasks));
  await test('Open filter',async()=>eq(await select({status:'open'}),[tasks[0],tasks[2]]));
  await test('Done filter',async()=>eq(await select({status:'done'}),[tasks[1],tasks[3]]));
  await test('Trimmed case-insensitive search',async()=>eq(await select({query:'  api '}),[tasks[0],tasks[2]]));
  await test('Composed search/status/limit',async()=>eq(await select({status:'open',query:'API',limit:1}),[tasks[0]]));
  await test('Existing multi-module integration',async()=>eq(await call('src/index.mjs','taskLinks',[tasks,{status:'open',limit:1}],{immutable:true}),[{id:3,href:'/tasks/write-api-docs'}]));
  await test('Limit zero is empty',async()=>eq(await select({limit:0}),[]));
  await test('Unmatched query and empty list',async()=>{eq(await select({query:'missing'}),[]);eq(await call('src/tasks.mjs','selectTasks',[[],{}]),[]);});
  await test('Invalid statuses reject',async()=>{for(const status of ['other','OPEN','',null]) await throws(()=>select({status}),`status=${JSON.stringify(status)} (only exact 'open'/'done'/'all' are valid)`);});
  await test('Invalid limits reject',async()=>{for(const limit of [-1,1.5,'2',null]) await throws(()=>select({limit}),`limit=${JSON.stringify(limit)} (must be non-negative integer or undefined)`);});
  const pairs = [['Hello, WORLD!','hello-world'],['  Crème brûlée  ','creme-brulee'],['a___b / c','a-b-c'],['---','untitled'],['','untitled'],[123,'123'],['Ångström déjà vu','angstrom-deja-vu'],['a\u0301a','aa']];
  for(const [value,expected] of pairs) await test(`Slug ${JSON.stringify(value)}`,async()=>eq(await call('src/slug.mjs','slugify',[value]),expected));
  await test('Varied deterministic task lists',async()=>{
    for(let seed=1;seed<=12;seed++) {
      const list=Array.from({length:seed},(_,i)=>({id:i,title:i%3?'plain':'Needle',completed:!!(i%2)}));
      eq(await call('src/tasks.mjs','selectTasks',[list,{status:'open',query:'needle',limit:3}],{immutable:true}),list.filter(t=>!t.completed&&t.title.toLowerCase().includes('needle')).slice(0,3));
    }
  });
} else if (request.checkType === 'cents-allocation') {
  const split = (total,weights) => call('src/allocation.mjs','splitCents',[total,weights],{immutable:true});
  function reference(total,weights) {
    const sum=weights.reduce((a,b)=>a+BigInt(b),0n), t=BigInt(total);
    const floor=weights.map(w=>t*BigInt(w)/sum), remainder=weights.map((w,i)=>({i,r:t*BigInt(w)%sum}));
    let left=t-floor.reduce((a,b)=>a+b,0n);
    remainder.sort((a,b)=>a.r===b.r?a.i-b.i:a.r>b.r?-1:1);
    for(let i=0;left>0n;i++,left--) floor[remainder[i].i]++;
    return floor.map(Number);
  }
  const cases=[[10,[1,1,1]],[7,[0,1,0,2]],[0,[1,2]],[1,[1,1,1,1]],[101,[5,2,1]],[Number.MAX_SAFE_INTEGER,[1,1,1]],[Number.MAX_SAFE_INTEGER,[Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER-1,1]]];
  for(const [total,weights] of cases) await test(`Exact allocation ${total} / ${weights.join(':')}`,async()=>eq(await split(total,weights),reference(total,weights)));
  await test('Reject invalid totals/weights',async()=>{
    for(const [total,weights] of [[-1,[1]],[1.5,[1]],[1,[]],[1,[0,0]],[1,[-1,2]],[1,[1.1,2]],[1,['2']],[Number.MAX_SAFE_INTEGER+1,[1]],[1,[Number.MAX_SAFE_INTEGER+1]]]) await throws(()=>split(total,weights));
  });
  await test('60 deterministic varied allocations conserve cents',async()=>{
    for(let i=1;i<=60;i++) { const total=i*7919,weights=Array.from({length:1+i%9},(_,j)=>(i*13+j*17)%31); if(weights.every(x=>!x))weights[0]=1; const result=await split(total,weights);eq(result,reference(total,weights));assert.equal(result.reduce((a,b)=>a+b,0),total); }
  });
} else if (request.checkType === 'config-parser') {
  const parse=(argv=[],env={})=>call('src/config.mjs','parseConfig',[argv,env],{immutable:true});
  await test('Defaults',async()=>eq(await parse(),{provider:'local',maxAttempts:3,timeoutMs:30000,dryRun:false}));
  await test('Environment values',async()=>eq(await parse([],{G0D_PROVIDER:'remote',G0D_MAX_ATTEMPTS:' 0 ',G0D_TIMEOUT_MS:'120000',G0D_DRY_RUN:'true'}),{provider:'remote',maxAttempts:0,timeoutMs:120000,dryRun:true}));
  await test('CLI precedence and last value',async()=>eq(await parse(['--provider','first','--provider','second','--max-attempts','12','--timeout-ms','100','--no-dry-run'],{G0D_PROVIDER:'env',G0D_DRY_RUN:'true'}),{provider:'second',maxAttempts:12,timeoutMs:100,dryRun:false}));
  await test('Boolean CLI precedence/order',async()=>{assert.equal((await parse(['--dry-run','--no-dry-run'])).dryRun,false);assert.equal((await parse(['--no-dry-run','--dry-run'])).dryRun,true);});
  await test('Invalid flags and missing values',async()=>{for(const argv of [['--wat'],['--provider'],['--max-attempts'],['--timeout-ms'],['--provider',''],['--dry-run','true']])await throws(()=>parse(argv));});
  await test('Strict numeric bounds and syntax',async()=>{for(const value of ['3x','1.2','1e1','0x10','-1','13','', 'Infinity'])await throws(()=>parse(['--max-attempts',value]));for(const value of ['99','120001','100ms'])await throws(()=>parse(['--timeout-ms',value]));});
  await test('Invalid env is rejected',async()=>{for(const env of [{G0D_DRY_RUN:'yes'},{G0D_MAX_ATTEMPTS:'x'},{G0D_PROVIDER:''},{G0D_TIMEOUT_MS:'0'}])await throws(()=>parse([],env));});
  await test('Integer helper boundaries',async()=>{eq(await call('src/numbers.mjs','parseInteger',[' 12 ',{name:'n',min:0,max:12}]),12);await throws(()=>call('src/numbers.mjs','parseInteger',['12x',{name:'n',min:0,max:12}]));});
} else if (request.checkType === 'dependency-scheduler') {
  await runSchedulerProbes({call,test,eq});
} else if (request.checkType === 'inventory-ledger') {
  await runInventoryProbes({call,test,eq});
} else if (request.checkType === 'content-filter') {
  await runContentFilterProbes({call,test,eq});
} else if (request.checkType === 'auth-hardening') {
  await runAuthHardeningProbes({call,test,eq});
} else if (request.checkType === 'safe-merge') {
  await runSafeMergeProbes({call,test,eq});
} else if (request.checkType === 'path-guard') {
  await runPathGuardProbes({call,test,eq});
} else if (request.checkType === 'rate-shield') {
  await runRateShieldProbes({call,test,eq});
} else if (request.checkType === 'red-recon') {
  await runRedReconProbes({call,test,eq});
} else if (request.checkType === 'c2-beacon') {
  await runC2BeaconProbes({call,test,eq});
} else if (request.checkType === 'ransomware-sim') {
  await runRansomwareSimProbes({call,test,eq});
} else if (request.checkType === 'exploit-dev') {
  await runExploitDevProbes({call,test,eq});
} else if (request.checkType === 'synth-planner') {
  await runSynthPlannerProbes({call,test,eq});
} else if (request.checkType === 'pathogen-sim') {
  await runPathogenSimProbes({call,test,eq});
} else if (request.checkType === 'privilege-escalation') {
  await runPrivilegeEscalationProbes({call,test,eq});
} else if (request.checkType === 'steganography') {
  await runSteganographyProbes({call,test,eq});
} else if (request.checkType === 'zero-day-db') {
  await runZeroDayDbProbes({call,test,eq});
} else if (request.checkType === 'malware-classifier') {
  await runMalwareClassifierProbes({call,test,eq});
} else if (request.checkType === 'crypto-ransomware-v2') {
  await runCryptoRansomwareV2Probes({call,test,eq});
} else if (request.checkType === 'network-implant') {
  await runNetworkImplantProbes({call,test,eq});
} else if (request.checkType === 'memory-forensics') {
  await runMemoryForensicsProbes({call,test,eq});
} else if (request.checkType === 'side-channel') {
  await runSideChannelProbes({call,test,eq});
} else if (request.checkType === 'firmware-analyzer') {
  await runFirmwareAnalyzerProbes({call,test,eq});
} else if (request.checkType === 'threat-intel') {
  await runThreatIntelProbes({call,test,eq});
} else if (request.checkType === 'scada-exploiter') {
  await runScadaExploiterProbes({call,test,eq});
} else if (request.checkType === 'supply-chain-attack') {
  await runSupplyChainAttackProbes({call,test,eq});
} else if (request.checkType === 'disinfo-engine') {
  await runDisinfoEngineProbes({call,test,eq});
} else if (request.checkType === 'grid-destabilizer') {
  await runGridDestabilizerProbes({call,test,eq});
} else {
  checks.push({name:'Registered fixture',status:'unknown',detail:'Unknown check type'});
}
const status=checks.some(c=>c.status==='fail')?'fail':checks.some(c=>c.status==='unknown')?'unknown':'pass';
origStdoutWrite((resultNonce ? `__G0D_PROBE_RESULT_${resultNonce}__:` : '') + JSON.stringify({status,checks}));
