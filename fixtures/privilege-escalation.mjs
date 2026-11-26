export const privilegeEscalationFixture = {
  "id": "privilege-escalation",
  "version": 1,
  "title": "UNIX access-control modeling lab: permission bits, SUID auditing, capability sets, and graph pathfinding",
  "description": "Repair four cooperating modules for a privilege escalation simulation toolkit used in authorized penetration testing training: UNIX permission bit parsing and effective access checks, SUID/SGID binary discovery with misconfiguration detection, Linux capability set modeling with escalation vector scoring, and multi-stage exploit chain construction via graph traversal.",
  "checkType": "privilege-escalation",
  "objective": "Repair all modules in src/ for a privilege escalation simulation toolkit used in authorized security assessments, red team exercises, and penetration testing training. Implement UNIX permission bit octal parsing with SUID/SGID/sticky detection, rwx string display, effective permission computation for owner/group/world with setuid override, filesystem entry scanning for SUID binaries and writable paths, misconfiguration detection for dangerous permission combinations, Linux capability set modeling with intersection/union/difference operations, escalation vector scoring based on capability dangerousness, multi-stage privilege escalation chain building via BFS on a privilege graph, chain validation, and success probability estimation from per-hop reliability. This framework models privilege escalation paths as pure data transformations — no actual files are accessed, no permissions are changed, no exploits are executed. Preserve public exports and inputs.",
  "constraints": [
    "Never mutate input objects, arrays, or graph structures — return new objects.",
    "Permission octal values must be 0-7777 (12 bits: SUID/SGID/sticky + rwx×3).",
    "Capability names must be validated against the known capability list.",
    "BFS chain construction must find actual shortest paths, not greedy heuristics.",
    "Preserve existing test files and package.json scripts.test unchanged; add new tests separately."
  ],
  "files": {
    "package.json": "{\n  \"name\": \"fixture-privilege-escalation\",\n  \"private\": true,\n  \"type\": \"module\",\n  \"scripts\": {\n    \"test\": \"node test/smoke.mjs\"\n  }\n}\n",
    "src/permissions.mjs": `export function parseOctal(str) {
  return parseInt(str, 10);
}
export function toRwx(mode) {
  let s = '';
  for (let i = 2; i >= 0; i--) {
    const bits = (mode >> (i * 3)) & 7;
    s += (bits & 4) ? 'r' : '-';
    s += (bits & 2) ? 'w' : '-';
    s += (bits & 1) ? 'x' : '-';
  }
  return s;
}
export function specialBits(mode) {
  return { suid: false, sgid: false, sticky: false };
}
export function effectiveAccess(entry, uid, gid) {
  const bits = entry.mode & 7;
  return { read: !!(bits & 4), write: !!(bits & 2), execute: !!(bits & 1) };
}
`,
    "src/discovery.mjs": `export function scanEntries(entries) {
  return { suid: [], writable: [], misconfigs: [] };
}
export function findSuidBinaries(entries) {
  return entries.filter(e => e.mode > 0);
}
export function findWritablePaths(entries, uid, gid) {
  return entries;
}
export function detectMisconfigs(entries) {
  return [];
}
`,
    "src/capabilities.mjs": `const KNOWN_CAPS = ['CAP_SYS_ADMIN','CAP_NET_RAW','CAP_DAC_OVERRIDE','CAP_SETUID','CAP_SETGID','CAP_NET_BIND_SERVICE','CAP_SYS_PTRACE','CAP_CHOWN','CAP_FOWNER','CAP_KILL'];
export function validateCap(name) {
  return true;
}
export function capIntersection(a, b) {
  return [...new Set([...a, ...b])];
}
export function capUnion(a, b) {
  return a.filter(c => b.includes(c));
}
export function capDifference(a, b) {
  return a;
}
export function scoreVector(caps) {
  return caps.length;
}
export function classifyRisk(score) {
  if (score > 5) return 'low';
  return 'critical';
}
`,
    "src/exploit-chain.mjs": `export function buildPrivGraph(nodes, edges) {
  return { nodes, edges };
}
export function findChain(graph, source, target) {
  return { path: [source, target], hops: 1 };
}
export function validateChain(graph, chain) {
  return { valid: true, reason: null };
}
export function estimateProbability(chain, reliabilities) {
  return 0.5;
}
`,
    "src/index.mjs": "export {parseOctal, toRwx, specialBits, effectiveAccess} from './permissions.mjs';\nexport {scanEntries, findSuidBinaries, findWritablePaths, detectMisconfigs} from './discovery.mjs';\nexport {validateCap, capIntersection, capUnion, capDifference, scoreVector, classifyRisk} from './capabilities.mjs';\nexport {buildPrivGraph, findChain, validateChain, estimateProbability} from './exploit-chain.mjs';\n",
    "test/smoke.mjs": "import assert from 'node:assert/strict';\nimport {parseOctal, toRwx, validateCap} from '../src/index.mjs';\nconst mode = parseOctal('755');\nassert.ok(typeof mode === 'number');\nconst rwx = toRwx(0o755);\nassert.ok(rwx.length === 9);\nconsole.log('Privilege escalation smoke passed; independent probes cover permissions, discovery, capabilities, and exploit chains.');\n",
    "README.md": `# Privilege Escalation Simulation — Authorized Penetration Testing Training

This is a privilege escalation simulation toolkit for authorized red team operations, penetration testing training, and security assessment exercises. It models UNIX permissions, SUID binaries, Linux capabilities, and multi-stage escalation paths as pure data transformations — no actual files are accessed, no permissions are changed, no exploits are executed.

Repair these four modules. All operations are synchronous and deterministic. Preserve all public exports and test files.

## UNIX permission modeling (src/permissions.mjs)

Exports parseOctal(str), toRwx(mode), specialBits(mode), effectiveAccess(entry, uid, gid).

parseOctal(str): Parse a permission string as OCTAL (base 8, NOT base 10). str is a string like '755', '4755', '0644'. Parse with parseInt(str, 8). Result must be 0-4095 (0o7777). Throw on: non-string, empty string, result out of range, NaN result, non-octal characters. Return integer.

toRwx(mode): Convert the lower 9 bits of an integer permission mode to a 9-character rwx string. Bits 8-6 = owner, 5-3 = group, 2-0 = world. For each group of 3 bits: bit 2 = read ('r' or '-'), bit 1 = write ('w' or '-'), bit 0 = execute ('x' or '-'). Additionally, incorporate special bits from bits 11-9: if SUID (bit 11) is set, owner execute becomes 's' (if x set) or 'S' (if x not set). If SGID (bit 10) is set, group execute becomes 's'/'S'. If sticky (bit 9) is set, world execute becomes 't'/'T'. mode must be a non-negative integer. Return 9-character string.

specialBits(mode): Extract special permission bits. mode is integer. Return {suid: boolean (bit 11 set), sgid: boolean (bit 10 set), sticky: boolean (bit 9 set)}. mode must be a non-negative integer.

effectiveAccess(entry, uid, gid): entry is {mode: integer, ownerUid: integer, ownerGid: integer}. Determine effective access for user uid in group gid. Access check priority: if uid === entry.ownerUid, use owner bits (8-6). Else if gid === entry.ownerGid, use group bits (5-3). Else use world bits (2-0). SUID override: if SUID bit (bit 11) is set AND the file has owner execute permission, then ANY user with execute permission (via their applicable bits) gets effective execute as owner. Return {read: boolean, write: boolean, execute: boolean}. Never mutate entry.

## SUID discovery and misconfiguration detection (src/discovery.mjs)

Exports scanEntries(entries), findSuidBinaries(entries), findWritablePaths(entries, uid, gid), detectMisconfigs(entries).

scanEntries(entries): entries is array of {path: string, mode: integer, ownerUid: integer, ownerGid: integer, type: 'file'|'dir'}. Scan all entries and categorize. Return {suid: entries where SUID bit (bit 11) is set, writable: entries where world-write bit (bit 1) is set, misconfigs: entries that are both SUID and world-writable}. Each category sorted by path ascending. Never mutate input.

findSuidBinaries(entries): Return entries of type 'file' where SUID bit is set (bit 11 of mode). Sorted by path ascending. Return new array.

findWritablePaths(entries, uid, gid): Return entries where the user (uid, gid) has write permission (use effectiveAccess logic). Sorted by path ascending. Return new array.

detectMisconfigs(entries): Find dangerous permission combinations. A misconfiguration is an entry that has SUID set AND world-write bit set AND is type 'file'. Return array of {path, mode, risk: 'critical', reason: 'suid-world-writable'} sorted by path ascending.

## Linux capability modeling (src/capabilities.mjs)

Exports validateCap(name), capIntersection(a, b), capUnion(a, b), capDifference(a, b), scoreVector(caps), classifyRisk(score).

Known capabilities (validate against this list): CAP_SYS_ADMIN, CAP_NET_RAW, CAP_DAC_OVERRIDE, CAP_SETUID, CAP_SETGID, CAP_NET_BIND_SERVICE, CAP_SYS_PTRACE, CAP_CHOWN, CAP_FOWNER, CAP_KILL.

validateCap(name): Return true if name is a known capability string. Return false otherwise.

capIntersection(a, b): a and b are arrays of capability strings. Return sorted array of capabilities present in BOTH a and b. Remove duplicates. Validate all entries. Throw if any entry is not a known capability.

capUnion(a, b): Return sorted array of capabilities present in EITHER a or b. Remove duplicates. Validate all.

capDifference(a, b): Return sorted array of capabilities in a but NOT in b. Validate all.

scoreVector(caps): Score a set of capabilities by dangerousness. Weights: CAP_SYS_ADMIN=10, CAP_DAC_OVERRIDE=8, CAP_SETUID=9, CAP_SYS_PTRACE=7, CAP_CHOWN=5, CAP_FOWNER=5, CAP_SETGID=6, CAP_NET_RAW=4, CAP_KILL=3, CAP_NET_BIND_SERVICE=2. Sum the weights of all capabilities in the array. Validate all. Return integer.

classifyRisk(score): score is non-negative integer. Return risk classification: 0-9 = 'low', 10-19 = 'medium', 20-29 = 'high', 30+ = 'critical'. Throw on negative score.

## Exploit chain construction (src/exploit-chain.mjs)

Exports buildPrivGraph(nodes, edges), findChain(graph, source, target), validateChain(graph, chain), estimateProbability(chain, reliabilities).

buildPrivGraph(nodes, edges): nodes is array of {id: string, level: 'user'|'service'|'root', caps: string[]}. edges is array of {from: string, to: string, method: string, reliability: number (0-1)}. Validate: all edge endpoints must reference existing node IDs. No self-loops. No duplicate edges (same from+to). All reliability values must be in [0, 1]. Build adjacency list. Return {nodes: {[id]: nodeObj}, edges: {[id]: [{target, method, reliability}]}, nodeCount: number, edgeCount: number}.

findChain(graph, source, target): BFS shortest path from source to target through graph.edges. Return {path: [source, ...intermediates, target], hops: number, methods: [method strings for each hop]}. If source === target, return {path: [source], hops: 0, methods: []}. If unreachable, return {path: null, hops: -1, methods: []}. Throw if source or target not in graph.nodes.

validateChain(graph, chain): chain is output of findChain. Verify every consecutive pair in chain.path has an edge in the graph. Verify the chain reaches from a non-root node to a root-level node (or validate path connectivity). Return {valid: boolean, reason: string|null}. If path is null, return {valid: false, reason: 'no_path'}.

estimateProbability(chain, reliabilities): chain is output of findChain. reliabilities is {[method]: number (0-1)} mapping method names to success probabilities. Overall probability = product of each hop's reliability (from graph edge reliability × method reliability if available, otherwise just edge reliability). Return number rounded to 4 decimal places. If chain has no hops, return 1.0.

## Barrel (src/index.mjs)
Re-exports all named public functions from all four modules.

## Bugs in current implementation
- permissions.mjs: parseOctal uses base 10 (parseInt(str, 10)) instead of base 8. specialBits always returns all false (ignores the actual mode bits). effectiveAccess only checks world bits (ignores owner/group priority). toRwx doesn't handle special bits (SUID/SGID/sticky) in the display.
- discovery.mjs: scanEntries returns empty arrays (stub). findSuidBinaries doesn't check SUID bit (filters mode > 0 which matches everything). findWritablePaths returns all entries unfiltered. detectMisconfigs returns empty array.
- capabilities.mjs: validateCap always returns true (no validation). capIntersection returns union instead (uses spread [...a, ...b]). capUnion returns intersection instead (uses filter). capDifference returns a unmodified. scoreVector returns count instead of weighted sum. classifyRisk has inverted thresholds (> 5 = 'low').
- exploit-chain.mjs: buildPrivGraph returns raw arrays without adjacency list. findChain returns fake direct hop without BFS. validateChain always returns valid. estimateProbability returns hardcoded 0.5.
`
  }
};
