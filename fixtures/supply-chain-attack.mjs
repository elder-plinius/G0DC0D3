export const supplyChainAttackFixture = {
  "id": "supply-chain-attack",
  "version": 1,
  "title": "Software supply-chain security lab: manifest parsing, semver resolution, typosquatting detection, and state machines",
  "description": "Repair eight cooperating modules for a software supply chain security research framework: npm/Python manifest parsing with dependency tree construction, semver constraint solving with topological ordering, typosquatting detection via Levenshtein/Damerau-Levenshtein distance and homoglyph generation, code injection (export wrapping, preload insertion, postinstall chaining, base64 stagers), mock package registry with semver-sorted version management, code obfuscation transforms, staged data exfiltration (DNS labels, HTTP headers, chunked transport, XOR encryption), and multi-target campaign state machine. All operations are pure data transformations — no actual software compromise.",
  "checkType": "supply-chain-attack",
  "objective": "Repair all modules in src/ for a supply chain security research framework. Implement package manifest parsing for npm (JSON) and Python (setup.cfg INI) formats with dependency tree construction and circular dependency detection. Implement semver parsing, numeric comparison (not string comparison — 2.10.0 > 2.9.0), caret/tilde/exact/range constraint matching, highest-version resolution, and topological dependency ordering. Implement Levenshtein and Damerau-Levenshtein edit distance, homoglyph generation, typosquat candidate generation, risk scoring, and detection. Implement code injection: export wrapping with interceptor code, preload insertion at module top, postinstall script chaining (preserving existing), and base64-encoded stager generation. Implement a mock package registry with publish (rejecting duplicate versions), download, semver-sorted listing, and substring search. Implement code obfuscation: consistent variable renaming (all occurrences), hex string encoding (preserving non-string content), string splitting via fromCharCode, and composed transforms. Implement data exfiltration: sequence-numbered chunking (starting at 0), DNS label encoding within length limits, HTTP header splitting, out-of-order reassembly with gap detection, and symmetric XOR encryption. Implement campaign state machine: recon→stage→deploy→persist→exfil with immutable transitions, rollback to previous state, per-target tracking, and timestamp-sorted timeline. Preserve public exports.",
  "constraints": [
    "Never mutate input objects or arrays — return new objects (campaign state, registry state, etc.).",
    "Semver comparison must be numeric, not string-based (2.10.0 must be greater than 2.9.0).",
    "Sequence numbers in chunking and reassembly start at 0, not 1.",
    "State machine transitions must be validated — invalid transitions must throw.",
    "Registry must reject publishing duplicate versions of the same package.",
    "Preserve existing test files and package.json scripts.test unchanged."
  ],
  "files": {
    "package.json": "{\n  \"name\": \"fixture-supply-chain-attack\",\n  \"private\": true,\n  \"type\": \"module\",\n  \"scripts\": {\n    \"test\": \"node test/smoke.mjs\"\n  }\n}\n",
    "src/manifest.mjs": `// Package manifest parsing for npm and Python ecosystems

export function parsePackageJson(jsonString) {
  const pkg = JSON.parse(jsonString);
  if (!pkg.name || !pkg.version) throw new Error('name and version required');

  const deps = pkg.dependencies || {};
  const devDeps = pkg.devDependencies || {};

  // BUG: dependencies and devDependencies are swapped
  const dependencies = Object.entries(devDeps).map(([name, range]) => ({name, range}));
  const devDependencies = Object.entries(deps).map(([name, range]) => ({name, range}));

  return {
    name: pkg.name,
    version: pkg.version,
    dependencies,
    devDependencies
  };
}

export function parseSetupCfg(cfgString) {
  const lines = cfgString.split('\\n');
  let inRequires = false;
  const deps = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'install_requires =') {
      inRequires = true;
      continue;
    }
    if (inRequires) {
      if (trimmed === '' || (!trimmed.startsWith(' ') && !line.startsWith('\\t') && line === trimmed && trimmed.includes('='))) break;
      if (trimmed === '') continue;
      const match = trimmed.match(/^([a-zA-Z0-9_-]+)\\s*(.*)$/);
      if (match) {
        const name = match[1];
        const range = match[2] || '';
        // BUG: empty range stays as '' instead of defaulting to '*'
        deps.push({name, range});
      }
    }
  }

  return deps;
}

export function buildDepTree(rootName, packages, _visited) {
  // BUG: no circular dependency detection — no visited set tracking
  const pkg = packages[rootName];
  if (!pkg) throw new Error(\`Package not found: \${rootName}\`);

  const children = Object.entries(pkg.deps).map(([name]) => {
    return buildDepTree(name, packages);
  });

  return {name: rootName, children};
}
`,
    "src/resolver.mjs": `// Semver constraint resolution

export function parseSemver(version) {
  const match = version.match(/^(\\d+)\\.(\\d+)\\.(\\d+)(?:-([a-zA-Z0-9.]+))?$/);
  if (!match) throw new Error(\`Invalid semver: \${version}\`);

  return {
    major: parseInt(match[1]),
    minor: parseInt(match[2]),
    patch: parseInt(match[3]),
    // BUG: prerelease is always undefined — match[4] exists but gets dropped
    prerelease: undefined
  };
}

export function compareSemver(a, b) {
  const va = parseSemver(a);
  const vb = parseSemver(b);

  // BUG: compares as strings instead of numbers (2.10.0 < 2.9.0 because "10" < "9")
  const partsA = a.split('-')[0].split('.');
  const partsB = b.split('-')[0].split('.');

  for (let i = 0; i < 3; i++) {
    if (partsA[i] < partsB[i]) return -1;
    if (partsA[i] > partsB[i]) return 1;
  }
  return 0;
}

export function satisfies(version, range) {
  if (range === '*') return true;

  const ver = parseSemver(version);

  if (range.startsWith('^')) {
    const base = parseSemver(range.slice(1));
    if (ver.major !== base.major) return false;
    return compareSemver(version, range.slice(1)) >= 0;
  }

  if (range.startsWith('~')) {
    const base = parseSemver(range.slice(1));
    // BUG: tilde acts like caret — checks major only, not major.minor
    if (ver.major !== base.major) return false;
    return compareSemver(version, range.slice(1)) >= 0;
  }

  if (range.startsWith('>=')) {
    return compareSemver(version, range.slice(2)) >= 0;
  }

  return compareSemver(version, range) === 0;
}

export function resolve(range, versions) {
  const matching = versions.filter(v => satisfies(v, range));
  if (matching.length === 0) return null;

  // BUG: returns first (lowest) instead of last (highest)
  matching.sort((a, b) => compareSemver(a, b));
  return matching[0];
}

export function resolveAll(graph, availableVersions) {
  const resolved = [];
  const visited = new Set();

  function visit(name) {
    if (visited.has(name)) return;
    visited.add(name);

    const entry = graph[name];
    if (!entry) return;

    // BUG: resolves dependencies AFTER adding self (wrong topo order)
    const version = availableVersions[name]
      ? resolve(entry.range, availableVersions[name])
      : null;

    if (version) resolved.push({name, version});

    for (const dep of Object.keys(entry.deps)) {
      visit(dep);
    }
  }

  for (const name of Object.keys(graph)) {
    visit(name);
  }

  return resolved;
}
`,
    "src/typosquat.mjs": `// Typosquatting detection via edit distance and homoglyphs

export function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({length: m + 1}, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[m][n];
}

export function damerauLevenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({length: m + 1}, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
      // BUG: transposition check is missing — this is just plain Levenshtein
      // Should add: if (i > 1 && j > 1 && a[i-1] === b[j-2] && a[i-2] === b[j-1])
      //   dp[i][j] = Math.min(dp[i][j], dp[i-2][j-2] + cost);
    }
  }

  return dp[m][n];
}

const HOMOGLYPHS = {
  'l': ['1', 'I', '|'],
  'o': ['0', 'O'],
  '0': ['o', 'O'],
  '1': ['l', 'I'],
  'i': ['1', 'l', 'j'],
  'a': ['@', '4'],
  'e': ['3'],
  's': ['5', '$'],
  'g': ['9', 'q'],
  'b': ['d', '6'],
  'n': ['m', 'r']
};

export function generateHomoglyphs(name) {
  const results = [];

  for (let i = 0; i < name.length; i++) {
    const ch = name[i].toLowerCase();
    const subs = HOMOGLYPHS[ch];
    if (subs) {
      for (const sub of subs) {
        results.push(name.slice(0, i) + sub + name.slice(i + 1));
      }
    }
  }

  return results;
}

export function generateTyposquats(name) {
  const results = new Set();

  // deletions
  for (let i = 0; i < name.length; i++) {
    results.add(name.slice(0, i) + name.slice(i + 1));
  }

  // transpositions
  for (let i = 0; i < name.length - 1; i++) {
    const arr = name.split('');
    [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
    results.add(arr.join(''));
  }

  // substitutions (adjacent keys)
  const keyboard = {
    'a': 'sqwz', 'b': 'vngh', 'c': 'xdfv', 'd': 'sfce', 'e': 'wrd',
    'f': 'dgcv', 'g': 'fhtb', 'h': 'gjyn', 'i': 'uko', 'j': 'hkun',
    'k': 'jlim', 'l': 'kop', 'm': 'njk', 'n': 'bmhj', 'o': 'iplk',
    'p': 'ol', 'q': 'wa', 'r': 'etf', 's': 'adwx', 't': 'ryg',
    'u': 'yij', 'v': 'cfgb', 'w': 'qeas', 'x': 'zsdc', 'y': 'tuh',
    'z': 'xas'
  };

  for (let i = 0; i < name.length; i++) {
    const adj = keyboard[name[i].toLowerCase()];
    if (adj) {
      for (const ch of adj) {
        results.add(name.slice(0, i) + ch + name.slice(i + 1));
      }
    }
  }

  results.delete(name);
  return [...results];
}

export function scoreRisk(candidate, target, meta) {
  const dist = levenshtein(candidate, target);
  const popularity = meta.downloads || 0;
  // BUG: risk score doesn't factor in distance properly — uses dist directly instead of inverse
  // Higher distance should mean LOWER risk, but this makes higher distance = higher score
  return dist * Math.log10(popularity + 1);
}

export function detectTyposquat(name, registry) {
  let bestTarget = null;
  let bestDist = Infinity;

  for (const pkg of registry) {
    const dist = levenshtein(name, pkg);
    if (dist < bestDist && dist > 0) {
      bestDist = dist;
      bestTarget = pkg;
    }
  }

  // BUG: threshold is 1 instead of a reasonable value like 3
  // This catches the simple cases but the scoring is still wrong
  if (bestDist <= 2 && bestTarget) {
    return {isTyposquat: true, target: bestTarget, distance: bestDist};
  }

  return {isTyposquat: false, target: null, distance: bestDist};
}
`,
    "src/inject.mjs": `// Code injection techniques

export function wrapExport(code, interceptor) {
  const exportMatch = code.match(/export\\s+default\\s+function\\s+(\\w+)/);
  if (!exportMatch) throw new Error('No default export function found');
  const fnName = exportMatch[1];

  // BUG: interceptor is placed AFTER the return, effectively dead code
  const wrapped = code.replace(
    /export\\s+default\\s+function/,
    'function'
  );

  return \`\${wrapped}
export default function \${fnName}(...args) {
  const result = \${fnName}_original(...args);
  \${interceptor}
  return result;
}\`.replace(\`function \${fnName}\`, \`function \${fnName}_original\`);
}

export function insertPreload(code, payload) {
  // BUG: appends to end instead of prepending to top
  return code + '\\n' + payload;
}

export function insertPostInstall(pkg, command) {
  const newScripts = {...(pkg.scripts || {})};

  if (newScripts.postinstall) {
    // BUG: overwrites existing postinstall instead of chaining
    newScripts.postinstall = command;
  } else {
    newScripts.postinstall = command;
  }

  return {...pkg, scripts: newScripts};
}

export function generateStager(code) {
  // BUG: uses hex encoding instead of base64
  const encoded = Buffer.from(code).toString('hex');
  return \`(function(){var d=Buffer.from('\${encoded}','hex');eval(d.toString());})()\`;
}
`,
    "src/registry.mjs": `// Mock package registry

export function createRegistry() {
  return {packages: {}};
}

export function publish(registry, {name, version, files}) {
  if (!name || !version) throw new Error('name and version required');

  const existing = registry.packages[name];

  // BUG: no duplicate version check — silently overwrites
  const versions = existing ? [...existing.versions] : [];
  const idx = versions.findIndex(v => v.version === version);
  if (idx >= 0) {
    versions[idx] = {version, files, publishedAt: Date.now()};
  } else {
    versions.push({version, files, publishedAt: Date.now()});
  }

  return {
    ...registry,
    packages: {
      ...registry.packages,
      [name]: {versions}
    }
  };
}

export function download(registry, name, version) {
  const pkg = registry.packages[name];
  if (!pkg) throw new Error(\`Package not found: \${name}\`);

  const entry = pkg.versions.find(v => v.version === version);
  if (!entry) throw new Error(\`Version not found: \${name}@\${version}\`);

  return {name, version: entry.version, files: entry.files};
}

export function listVersions(registry, name) {
  const pkg = registry.packages[name];
  if (!pkg) throw new Error(\`Package not found: \${name}\`);

  // BUG: string sort instead of semver sort — '1.10.0' comes before '1.9.0'
  return pkg.versions.map(v => v.version).sort();
}

export function search(registry, query) {
  const results = [];
  for (const name of Object.keys(registry.packages)) {
    if (name.includes(query)) {
      results.push(name);
    }
  }
  return results;
}
`,
    "src/obfuscate.mjs": `// Code obfuscation transforms

export function renameVars(code, mapping) {
  let result = code;
  for (const [oldName, newName] of Object.entries(mapping)) {
    // BUG: only replaces first occurrence — should use global regex or replaceAll
    result = result.replace(oldName, newName);
  }
  return result;
}

export function hexEncodeStrings(code) {
  // BUG: replaces ALL content between quotes, not just the string contents
  // This means non-string code between matching quotes gets mangled
  return code.replace(/"([^"]*)"/g, (match, content) => {
    const hex = [...content].map(c => '\\\\x' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    return '"' + hex + '"';
  });
}

export function splitString(str) {
  const codes = [...str].map(c => c.charCodeAt(0));
  return \`String.fromCharCode(\${codes.join(', ')})\`;
}

export function obfuscate(code) {
  // Step 1: Find variable declarations and rename them
  const varPattern = /(?:const|let|var)\\s+(\\w+)/g;
  const mapping = {};
  let match;
  let counter = 0;
  while ((match = varPattern.exec(code)) !== null) {
    if (!mapping[match[1]]) {
      mapping[match[1]] = '_0x' + (counter++).toString(16).padStart(4, '0');
    }
  }

  let result = renameVars(code, mapping);

  // Step 2: Hex-encode string literals
  result = hexEncodeStrings(result);

  return result;
}
`,
    "src/exfil.mjs": `// Staged data exfiltration encoding

export function chunkData(data, {chunkSize}) {
  const chunks = [];
  // BUG: sequence numbers start at 1 instead of 0
  let seq = 1;
  for (let i = 0; i < data.length; i += chunkSize) {
    chunks.push({seq, data: data.slice(i, i + chunkSize)});
    seq++;
  }
  return chunks;
}

export function encodeDnsLabels(data, domain, {maxLabelLen = 63} = {}) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hex = buf.toString('hex');
  const labels = [];

  // BUG: doesn't respect maxLabelLen — uses full hex in one label
  const parts = [];
  for (let i = 0; i < hex.length; i += maxLabelLen) {
    parts.push(hex.slice(i, i + maxLabelLen));
  }

  for (let i = 0; i < parts.length; i++) {
    labels.push(\`\${parts[i]}.\${domain}\`);
  }

  return labels;
}

export function encodeHttpHeaders(data, {prefix = 'X-Custom', maxValueLen = 256} = {}) {
  const headers = [];
  let idx = 0;

  for (let i = 0; i < data.length; i += maxValueLen) {
    headers.push({
      name: \`\${prefix}-\${idx}\`,
      value: data.slice(i, i + maxValueLen)
    });
    idx++;
  }

  return headers;
}

export function reassemble(chunks) {
  // BUG: sorts by seq as string instead of number — seq 10 comes before seq 2
  const sorted = [...chunks].sort((a, b) => String(a.seq) < String(b.seq) ? -1 : String(a.seq) > String(b.seq) ? 1 : 0);

  // Validate contiguity
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].seq !== sorted[0].seq + i) {
      throw new Error(\`Gap in sequence at position \${i}: expected \${sorted[0].seq + i}, got \${sorted[i].seq}\`);
    }
  }

  return sorted.map(c => c.data).join('');
}

export function xorEncrypt(data, key) {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    // BUG: key index uses data.length instead of key.length for modulo
    const keyChar = key.charCodeAt(i % data.length);
    result.push(String.fromCharCode(data.charCodeAt(i) ^ keyChar));
  }
  return result.join('');
}
`,
    "src/campaign.mjs": `// Multi-target campaign state machine

const STATES = ['recon', 'stage', 'deploy', 'persist', 'exfil'];

export function createCampaign({id, targets}) {
  return {
    id,
    state: 'recon',
    targets: targets.map(t => ({id: t, status: 'pending'})),
    history: []
  };
}

export function advance(campaign, {now}) {
  const currentIdx = STATES.indexOf(campaign.state);
  if (currentIdx === -1 || currentIdx >= STATES.length - 1) {
    throw new Error(\`Cannot advance from state: \${campaign.state}\`);
  }

  // BUG: skips 'stage' — goes from recon directly to deploy (currentIdx + 2)
  const nextState = STATES[currentIdx + 2] || STATES[currentIdx + 1];

  // BUG: mutates input instead of returning new object
  campaign.state = nextState;
  campaign.history.push({
    action: 'advance',
    from: STATES[currentIdx],
    to: nextState,
    timestamp: now
  });

  return campaign;
}

export function rollback(campaign, {now}) {
  const currentIdx = STATES.indexOf(campaign.state);
  if (currentIdx <= 0) {
    throw new Error(\`Cannot rollback from state: \${campaign.state}\`);
  }

  // BUG: always goes to 'recon' instead of previous state
  const prevState = STATES[0];

  return {
    ...campaign,
    state: prevState,
    history: [...campaign.history, {
      action: 'rollback',
      from: campaign.state,
      to: prevState,
      timestamp: now
    }]
  };
}

export function addTarget(campaign, targetId, {now}) {
  return {
    ...campaign,
    targets: [...campaign.targets, {id: targetId, status: 'pending'}],
    history: [...campaign.history, {
      action: 'addTarget',
      target: targetId,
      timestamp: now
    }]
  };
}

export function getTimeline(campaign) {
  // BUG: returns unsorted — just copies the array
  return [...campaign.history];
}
`,
    "src/index.mjs": `export { parsePackageJson, parseSetupCfg, buildDepTree } from './manifest.mjs';
export { parseSemver, compareSemver, satisfies, resolve, resolveAll } from './resolver.mjs';
export { levenshtein, damerauLevenshtein, generateHomoglyphs, generateTyposquats, scoreRisk, detectTyposquat } from './typosquat.mjs';
export { wrapExport, insertPreload, insertPostInstall, generateStager } from './inject.mjs';
export { createRegistry, publish, download, listVersions, search } from './registry.mjs';
export { renameVars, hexEncodeStrings, splitString, obfuscate } from './obfuscate.mjs';
export { chunkData, encodeDnsLabels, encodeHttpHeaders, reassemble, xorEncrypt } from './exfil.mjs';
export { createCampaign, advance, rollback, addTarget, getTimeline } from './campaign.mjs';
`,
    "test/smoke.mjs": `import assert from 'node:assert/strict';
import { parsePackageJson, parseSemver, levenshtein, createRegistry, chunkData, createCampaign } from '../src/index.mjs';

const pkg = parsePackageJson(JSON.stringify({name: 'test', version: '1.0.0', dependencies: {'a': '^1.0.0'}}));
assert.ok(pkg.name === 'test');

const ver = parseSemver('1.2.3');
assert.equal(ver.major, 1);

const dist = levenshtein('abc', 'abc');
assert.equal(dist, 0);

const reg = createRegistry();
assert.ok(reg.packages);

const chunks = chunkData('abcd', {chunkSize: 2});
assert.ok(chunks.length === 2);

const campaign = createCampaign({id: 'test', targets: ['t1']});
assert.equal(campaign.state, 'recon');

console.log('Supply chain attack smoke passed; independent probes cover all eight modules.');
`,
    "README.md": `# Supply Chain Attack Simulation — Security Research Training

Repair these eight modules for a supply chain security research framework. All operations are pure data transformations — no actual software compromise, no network connections, no system access. Uses only built-in Node.js modules. Preserve all public exports and test files.

## Manifest parsing (src/manifest.mjs)

Exports parsePackageJson(jsonString), parseSetupCfg(cfgString), buildDepTree(rootName, packages).

### parsePackageJson(jsonString)

Parse an npm-style package.json string. Extract name, version, dependencies (from the "dependencies" field), and devDependencies (from the "devDependencies" field) separately.

Return: {name, version, dependencies: [{name, range}, ...], devDependencies: [{name, range}, ...]}.

Both arrays default to empty if the corresponding field is missing from the JSON.

### parseSetupCfg(cfgString)

Parse a Python setup.cfg INI format. Extract packages from the install_requires section (which starts on the line after "install_requires =" and continues until a blank line or non-indented section header).

Each line in install_requires contains a package name optionally followed by a version constraint (e.g., "requests>=2.28", "click~=8.0", "pyyaml"). When no version constraint is provided, the range defaults to "*".

Return: [{name, range}, ...].

### buildDepTree(rootName, packages)

Build a dependency tree starting from rootName. The packages parameter maps package names to their dependencies: {name: {deps: {depName: range, ...}}}.

Return: {name, children: [{name, children: [...]}, ...]}.

Must detect circular dependencies and throw an Error. Use a visited set to track packages being resolved — if a package is encountered again during resolution of its own transitive dependencies, throw.

## Semver resolution (src/resolver.mjs)

Exports parseSemver(version), compareSemver(a, b), satisfies(version, range), resolve(range, versions), resolveAll(graph, availableVersions).

### parseSemver(version)

Parse "major.minor.patch" with optional "-prerelease" suffix.

Return: {major, minor, patch, prerelease}. prerelease is the string after the hyphen, or undefined if none.

Throw on invalid format.

### compareSemver(a, b)

Compare two semver strings. Return negative if a < b, positive if a > b, 0 if equal.

**CRITICAL**: Compare major, minor, and patch as INTEGERS, not strings. 2.10.0 must be greater than 2.9.0 (because 10 > 9), but string comparison gives the opposite result ("10" < "9").

### satisfies(version, range)

Check if a version satisfies a range constraint:
- "*": always true
- "^X.Y.Z" (caret): same major, version >= X.Y.Z
- "~X.Y.Z" (tilde): same major AND same minor, version >= X.Y.Z
- ">=X.Y.Z": version >= X.Y.Z
- "X.Y.Z" (exact): exact match only

### resolve(range, versions)

Find the HIGHEST version from the array that satisfies the range. Return null if none match. Sort matching versions and return the last (highest), not the first (lowest).

### resolveAll(graph, availableVersions)

Resolve all dependencies in topological order (leaves first). The graph maps names to {range, deps}. availableVersions maps names to arrays of available version strings.

Return: [{name, version}, ...] in topological install order — dependencies appear BEFORE their dependents. Resolve each dependency's version using resolve().

## Typosquatting detection (src/typosquat.mjs)

Exports levenshtein(a, b), damerauLevenshtein(a, b), generateHomoglyphs(name), generateTyposquats(name), scoreRisk(candidate, target, meta), detectTyposquat(name, registry).

### levenshtein(a, b)

Classic Levenshtein edit distance. Operations: insert, delete, replace. Each costs 1. Return the minimum number of operations.

### damerauLevenshtein(a, b)

Damerau-Levenshtein distance. Same as Levenshtein PLUS transposition of two adjacent characters as a single operation (cost 1). This means damerauLevenshtein("ab", "ba") = 1 (one transposition), while levenshtein("ab", "ba") = 2 (two substitutions or a delete+insert).

Implementation: extend the standard DP matrix. When computing dp[i][j], also check: if i > 1 AND j > 1 AND a[i-1] === b[j-2] AND a[i-2] === b[j-1], then dp[i][j] = min(dp[i][j], dp[i-2][j-2] + 1).

### generateHomoglyphs(name)

For each character position in name, check if it has homoglyph substitutions (visually similar characters). Generate all single-substitution variants.

Homoglyph table: l↔[1,I,|], o↔[0,O], 0↔[o,O], 1↔[l,I], i↔[1,l,j], a↔[@,4], e↔[3], s↔[5,$], g↔[9,q], b↔[d,6], n↔[m,r].

Return array of variant strings (all different from the original).

### generateTyposquats(name)

Generate typosquat candidates using: character deletion, adjacent character transposition, and keyboard-neighbor substitution. Deduplicate and exclude the original name.

### scoreRisk(candidate, target, meta)

Score the typosquatting risk. Higher score = higher risk. Close distance to a popular package = high risk.

Formula: risk = (1 / (distance + 1)) * log10(downloads + 1). A package with distance 1 and high downloads scores higher than distance 5 and high downloads.

### detectTyposquat(name, registry)

Check if name is a typosquat of any package in the registry (array of known package names). Return {isTyposquat, target, distance}. isTyposquat is true if the closest registry match has Levenshtein distance 1-2.

## Code injection (src/inject.mjs)

Exports wrapExport(code, interceptor), insertPreload(code, payload), insertPostInstall(pkg, command), generateStager(code).

### wrapExport(code, interceptor)

Wrap a default-exported function with interceptor code that runs before returning. The interceptor code string is inserted into the wrapper function body. The output must contain both "export default" and the interceptor text.

### insertPreload(code, payload)

Insert the payload code string at the TOP of the module (first line). The payload must be the first line of the output.

### insertPostInstall(pkg, command)

Add a postinstall script to a package.json object. If an existing postinstall exists, CHAIN them: "existingCommand && newCommand". Never overwrite the existing script.

Return a new package.json object (don't mutate input).

### generateStager(code)

Generate a self-executing base64-encoded payload. The output must include "Buffer.from", "base64", and the correct base64 encoding of the input code.

## Registry (src/registry.mjs)

Exports createRegistry(), publish(registry, pkg), download(registry, name, version), listVersions(registry, name), search(registry, query).

### publish(registry, {name, version, files})

Add a package version to the registry. Must REJECT (throw) if the exact name+version combination already exists. Never silently overwrite.

Return new registry object (don't mutate input).

### listVersions(registry, name)

Return version strings sorted in SEMVER order (not string order). 1.9.0 < 1.10.0 < 2.0.0.

### search(registry, query)

Find packages whose name contains the query substring. Return array of matching names.

## Obfuscation (src/obfuscate.mjs)

Exports renameVars(code, mapping), hexEncodeStrings(code), splitString(str), obfuscate(code).

### renameVars(code, mapping)

Replace ALL occurrences of each key in mapping with its value. If "secret" appears 3 times, all 3 must be replaced.

### hexEncodeStrings(code)

Find quoted string literals in the code and replace their contents with hex escape sequences (\\xHH for each character). Preserve non-string code unchanged.

Example: 'const x = 42; const s = "hi";' → the "hi" becomes hex-encoded, but 'const x = 42' stays untouched.

### splitString(str)

Convert a string to String.fromCharCode(c1, c2, ...) expression.

### obfuscate(code)

Compose renameVars and hexEncodeStrings. Variable names and string literal contents should both be obscured in the output.

## Exfiltration (src/exfil.mjs)

Exports chunkData(data, options), encodeDnsLabels(data, domain, options), encodeHttpHeaders(data, options), reassemble(chunks), xorEncrypt(data, key).

### chunkData(data, {chunkSize})

Split data into chunks of chunkSize characters, each tagged with a 0-based sequence number. First chunk has seq=0.

Return: [{seq: 0, data: '...'}, {seq: 1, data: '...'}, ...].

### encodeDnsLabels(data, domain, {maxLabelLen=63})

Hex-encode the data, split into label-sized pieces respecting maxLabelLen, format as DNS queries: "hexdata.domain". Each label part must be at most maxLabelLen characters.

### encodeHttpHeaders(data, {prefix, maxValueLen})

Split data into HTTP headers, each value at most maxValueLen characters. Header names are "prefix-0", "prefix-1", etc.

### reassemble(chunks)

Sort chunks by seq NUMERICALLY (not as strings), validate contiguity (no gaps starting from the lowest seq), concatenate data.

Throw on gaps.

### xorEncrypt(data, key)

XOR each character of data with the corresponding key character (cycling through the KEY, not the data). key index = i % key.length.

This is symmetric: encrypting then "encrypting" again with the same key recovers the original.

## Campaign (src/campaign.mjs)

Exports createCampaign(options), advance(campaign, options), rollback(campaign, options), addTarget(campaign, targetId, options), getTimeline(campaign).

### State machine

States in order: recon → stage → deploy → persist → exfil.

advance() moves to the NEXT state (not skipping any). Throw when already at the terminal state (exfil).

### createCampaign({id, targets})

Initialize campaign in 'recon' state with empty history.

### advance(campaign, {now})

Move to the next state in sequence. Record the transition in history with timestamp. NEVER mutate the input — return a new campaign object.

### rollback(campaign, {now})

Move to the PREVIOUS state (not always to recon). Throw if already at recon (can't go further back).

### addTarget(campaign, targetId, {now})

Add a target with status 'pending'. Return new campaign.

### getTimeline(campaign)

Return history entries sorted by timestamp in ASCENDING order (earliest first).

## Barrel (src/index.mjs)

Re-exports all named public functions from all eight modules.

## Bugs in current implementation

- manifest.mjs: parsePackageJson swaps dependencies and devDependencies (dependencies array is populated from the devDependencies field and vice versa); parseSetupCfg returns empty string instead of "*" for packages without version constraints; buildDepTree has no circular dependency detection (no visited set, will recurse infinitely)
- resolver.mjs: parseSemver drops prerelease (always undefined even when present); compareSemver does string comparison instead of numeric (2.10.0 < 2.9.0 because "10" < "9" lexicographically); satisfies tilde range acts like caret (checks major only, not major.minor); resolve returns lowest match instead of highest; resolveAll adds self before resolving dependencies (wrong topological order)
- typosquat.mjs: damerauLevenshtein is just regular levenshtein (missing transposition check, so "ab"→"ba" costs 2 instead of 1); scoreRisk formula is inverted (higher distance = higher score instead of lower)
- inject.mjs: insertPreload appends to end instead of prepending to top; insertPostInstall overwrites existing postinstall instead of chaining; generateStager uses hex encoding instead of base64
- registry.mjs: publish silently overwrites duplicate versions instead of throwing; listVersions uses string sort (1.10.0 before 1.9.0)
- obfuscate.mjs: renameVars only replaces first occurrence of each variable name (should replace all)
- exfil.mjs: chunkData sequence numbers start at 1 instead of 0; reassemble sorts sequence numbers as strings (10 before 2); xorEncrypt cycles through data length instead of key length
- campaign.mjs: advance skips 'stage' (jumps from recon to deploy); advance mutates input instead of returning new object; rollback always goes to 'recon' instead of the previous state; getTimeline returns unsorted history
`
  }
};
