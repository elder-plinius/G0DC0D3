export async function runThreatIntelProbes({call, test, eq}) {
  // === IOC management ===
  await test('detectType identifies IPv4', async () => {
    eq(await call('src/ioc.mjs', 'detectType', ['192.168.1.1']), 'ipv4');
  });

  await test('detectType identifies domain', async () => {
    eq(await call('src/ioc.mjs', 'detectType', ['evil.example.com']), 'domain');
  });

  await test('detectType identifies URL', async () => {
    eq(await call('src/ioc.mjs', 'detectType', ['https://evil.com/payload']), 'url');
  });

  await test('detectType identifies MD5', async () => {
    eq(await call('src/ioc.mjs', 'detectType', ['d41d8cd98f00b204e9800998ecf8427e']), 'md5');
  });

  await test('detectType identifies SHA-1', async () => {
    eq(await call('src/ioc.mjs', 'detectType', ['da39a3ee5e6b4b0d3255bfef95601890afd80709']), 'sha1');
  });

  await test('detectType identifies SHA-256 (64 chars not 60)', async () => {
    const sha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    eq(sha256.length, 64);
    eq(await call('src/ioc.mjs', 'detectType', [sha256]), 'sha256');
  });

  await test('detectType 60-char hex is unknown not sha256', async () => {
    const hex60 = 'a'.repeat(60);
    const result = await call('src/ioc.mjs', 'detectType', [hex60]);
    if (result === 'sha256') throw new Error('60-char hex should NOT be sha256 — sha256 is 64 chars');
  });

  await test('detectType identifies CVE', async () => {
    eq(await call('src/ioc.mjs', 'detectType', ['CVE-2024-1234']), 'cve');
  });

  await test('detectType identifies email', async () => {
    eq(await call('src/ioc.mjs', 'detectType', ['attacker@evil.com']), 'email');
  });

  await test('validate IPv4 correct', async () => {
    eq(await call('src/ioc.mjs', 'validate', ['192.168.1.1', 'ipv4']), true);
    eq(await call('src/ioc.mjs', 'validate', ['0.0.0.0', 'ipv4']), true);
    eq(await call('src/ioc.mjs', 'validate', ['255.255.255.255', 'ipv4']), true);
  });

  await test('validate IPv4 rejects bad values', async () => {
    eq(await call('src/ioc.mjs', 'validate', ['256.1.1.1', 'ipv4']), false);
    eq(await call('src/ioc.mjs', 'validate', ['1.1.1', 'ipv4']), false);
    eq(await call('src/ioc.mjs', 'validate', ['01.1.1.1', 'ipv4']), false);
  });

  await test('validate SHA-256 requires 64 chars', async () => {
    eq(await call('src/ioc.mjs', 'validate', ['e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'sha256']), true);
    eq(await call('src/ioc.mjs', 'validate', ['a'.repeat(60), 'sha256']), false);
  });

  await test('defang replaces dots and protocol', async () => {
    const result = await call('src/ioc.mjs', 'defang', ['https://evil.com/path']);
    eq(result.includes('hxxps'), true);
    eq(result.includes('[.]'), true);
    if (result.includes('.com')) throw new Error('Dots should be replaced with [.]');
  });

  await test('defang http protocol', async () => {
    const result = await call('src/ioc.mjs', 'defang', ['http://test.org']);
    eq(result.includes('hxxp:'), true);
  });

  await test('refang reverses defang', async () => {
    const original = 'https://evil.com/payload';
    const defanged = await call('src/ioc.mjs', 'defang', [original]);
    const refanged = await call('src/ioc.mjs', 'refang', [defanged]);
    eq(refanged, original);
  });

  await test('normalize trims and lowercases', async () => {
    eq(await call('src/ioc.mjs', 'normalize', ['  EVIL.COM  ']), 'evil.com');
  });

  await test('deduplicate removes duplicates by normalized value', async () => {
    const iocs = [
      { value: 'evil.com', type: 'domain' },
      { value: 'EVIL.COM', type: 'domain' },
      { value: 'other.com', type: 'domain' }
    ];
    const deduped = await call('src/ioc.mjs', 'deduplicate', [iocs]);
    eq(deduped.length, 2);
  });

  await test('extractFromText finds IPs and hashes', async () => {
    const text = 'The attacker used 192.168.1.100 and hash d41d8cd98f00b204e9800998ecf8427e in the campaign';
    const iocs = await call('src/ioc.mjs', 'extractFromText', [text]);
    eq(iocs.length >= 2, true);
    const hasIp = iocs.some(i => i.type === 'ipv4');
    const hasHash = iocs.some(i => i.type === 'md5');
    eq(hasIp, true);
    eq(hasHash, true);
  });

  // === STIX 2.1 bundles ===
  await test('uuidv5 uses SHA-1 not MD5', async () => {
    const id = await call('src/stix.mjs', 'uuidv5', ['test', '00abedb4-aa42-466c-9c01-fed23315a9b7']);
    eq(typeof id, 'string');
    eq(id.length, 36);
    eq(id[14], '5');
    const variant = parseInt(id[19], 16);
    eq(variant >= 8 && variant <= 11, true);
  });

  await test('uuidv5 is deterministic', async () => {
    const id1 = await call('src/stix.mjs', 'uuidv5', ['hello', '00abedb4-aa42-466c-9c01-fed23315a9b7']);
    const id2 = await call('src/stix.mjs', 'uuidv5', ['hello', '00abedb4-aa42-466c-9c01-fed23315a9b7']);
    eq(id1, id2);
  });

  await test('uuidv5 different inputs produce different IDs', async () => {
    const id1 = await call('src/stix.mjs', 'uuidv5', ['foo', '00abedb4-aa42-466c-9c01-fed23315a9b7']);
    const id2 = await call('src/stix.mjs', 'uuidv5', ['bar', '00abedb4-aa42-466c-9c01-fed23315a9b7']);
    if (id1 === id2) throw new Error('Different inputs should produce different UUIDs');
  });

  await test('createIndicator produces valid STIX object', async () => {
    const ind = await call('src/stix.mjs', 'createIndicator', ["[ipv4-addr:value = '1.2.3.4']", { name: 'Bad IP' }]);
    eq(ind.type, 'indicator');
    eq(ind.spec_version, '2.1');
    eq(ind.id.startsWith('indicator--'), true);
    eq(ind.name, 'Bad IP');
    eq(ind.pattern_type, 'stix');
  });

  await test('createMalware produces valid STIX object', async () => {
    const mal = await call('src/stix.mjs', 'createMalware', ['EvilBot', { malware_types: ['trojan'], is_family: true }]);
    eq(mal.type, 'malware');
    eq(mal.id.startsWith('malware--'), true);
    eq(mal.is_family, true);
  });

  await test('createThreatActor produces valid STIX object', async () => {
    const ta = await call('src/stix.mjs', 'createThreatActor', ['APT99', { sophistication: 'expert' }]);
    eq(ta.type, 'threat-actor');
    eq(ta.id.startsWith('threat-actor--'), true);
    eq(ta.sophistication, 'expert');
  });

  await test('createRelationship validates type', async () => {
    const rel = await call('src/stix.mjs', 'createRelationship', ['indicator--abc', 'indicates', 'malware--xyz']);
    eq(rel.type, 'relationship');
    eq(rel.relationship_type, 'indicates');
  });

  await test('createRelationship rejects invalid type', async () => {
    let threw = false;
    try {
      await call('src/stix.mjs', 'createRelationship', ['indicator--abc', 'friend-of', 'malware--xyz']);
    } catch { threw = true; }
    eq(threw, true);
  });

  await test('createBundle wraps objects', async () => {
    const ind = await call('src/stix.mjs', 'createIndicator', ['test-pattern', {}]);
    const bundle = await call('src/stix.mjs', 'createBundle', [[ind]]);
    eq(bundle.type, 'bundle');
    eq(bundle.objects.length, 1);
    eq(bundle.id.startsWith('bundle--'), true);
  });

  await test('validateBundle catches missing fields', async () => {
    const bad = { type: 'bundle', objects: [{ type: 'malware' }] };
    const result = await call('src/stix.mjs', 'validateBundle', [bad]);
    eq(result.valid, false);
    eq(result.errors.length >= 1, true);
  });

  await test('validateBundle passes valid bundle', async () => {
    const ind = await call('src/stix.mjs', 'createIndicator', ['test', {}]);
    const bundle = await call('src/stix.mjs', 'createBundle', [[ind]]);
    const result = await call('src/stix.mjs', 'validateBundle', [bundle]);
    eq(result.valid, true);
  });

  // === MITRE ATT&CK mapping ===
  await test('parseTechniqueId parses technique', async () => {
    const t = await call('src/mitre.mjs', 'parseTechniqueId', ['T1059']);
    eq(t.full, 'T1059');
    eq(t.isSubTechnique, false);
    eq(t.parent, null);
  });

  await test('parseTechniqueId parses sub-technique', async () => {
    const t = await call('src/mitre.mjs', 'parseTechniqueId', ['T1059.001']);
    eq(t.full, 'T1059.001');
    eq(t.isSubTechnique, true);
    eq(t.parent, 'T1059');
    eq(t.sub, '.001');
  });

  await test('parseTechniqueId rejects invalid', async () => {
    let threw = false;
    try { await call('src/mitre.mjs', 'parseTechniqueId', ['INVALID']); } catch { threw = true; }
    eq(threw, true);
  });

  await test('createTechnique returns valid structure', async () => {
    const t = await call('src/mitre.mjs', 'createTechnique', ['T1059', { name: 'Command and Scripting Interpreter', tactic: 'execution' }]);
    eq(t.id, 'T1059');
    eq(t.name, 'Command and Scripting Interpreter');
    eq(t.tactic, 'execution');
  });

  await test('mapToKillChain includes all 14 phases', async () => {
    const techs = [
      { tactic: 'execution', id: 'T1059', name: 'test' },
      { tactic: 'reconnaissance', id: 'T1595', name: 'test2' },
      { tactic: 'resource-development', id: 'T1583', name: 'test3' }
    ];
    const chain = await call('src/mitre.mjs', 'mapToKillChain', [techs]);
    eq('reconnaissance' in chain, true);
    eq('resource-development' in chain, true);
    eq('execution' in chain, true);
    eq('impact' in chain, true);
    const phases = Object.keys(chain);
    eq(phases.length, 14);
  });

  await test('coverageScore uses 14 phases', async () => {
    const techs = [
      { tactic: 'execution' },
      { tactic: 'persistence' },
      { tactic: 'discovery' }
    ];
    const score = await call('src/mitre.mjs', 'coverageScore', [techs]);
    eq(score.total, 14);
    eq(score.covered, 3);
    const expectedScore = 3 / 14;
    if (Math.abs(score.score - expectedScore) > 0.001) throw new Error(`Expected score ${expectedScore}, got ${score.score}`);
  });

  await test('lookupTechnique finds by ID', async () => {
    const techs = [
      { id: 'T1059', name: 'Command and Scripting' },
      { id: 'T1053', name: 'Scheduled Task' }
    ];
    const t = await call('src/mitre.mjs', 'lookupTechnique', [techs, 'T1053']);
    eq(t.name, 'Scheduled Task');
  });

  await test('lookupTechnique returns null for missing', async () => {
    const t = await call('src/mitre.mjs', 'lookupTechnique', [[], 'T9999']);
    eq(t, null);
  });

  await test('getSubTechniques finds children', async () => {
    const techs = [
      { id: 'T1059.001', parent: 'T1059', isSubTechnique: true },
      { id: 'T1059.002', parent: 'T1059', isSubTechnique: true },
      { id: 'T1053.001', parent: 'T1053', isSubTechnique: true }
    ];
    const subs = await call('src/mitre.mjs', 'getSubTechniques', [techs, 'T1059']);
    eq(subs.length, 2);
  });

  // === IOC correlation ===
  await test('sameSubnet with proper mask computation', async () => {
    const r1 = await call('src/correlate.mjs', 'sameSubnet', ['192.168.1.1', '192.168.1.254', 24]);
    eq(r1, true);
    const r2 = await call('src/correlate.mjs', 'sameSubnet', ['192.168.1.1', '192.168.2.1', 24]);
    eq(r2, false);
  });

  await test('sameSubnet /16 mask', async () => {
    const r1 = await call('src/correlate.mjs', 'sameSubnet', ['10.0.1.1', '10.0.2.2', 16]);
    eq(r1, true);
    const r2 = await call('src/correlate.mjs', 'sameSubnet', ['10.0.1.1', '10.1.1.1', 16]);
    eq(r2, false);
  });

  await test('sameSubnet /32 exact match', async () => {
    eq(await call('src/correlate.mjs', 'sameSubnet', ['1.2.3.4', '1.2.3.4', 32]), true);
    eq(await call('src/correlate.mjs', 'sameSubnet', ['1.2.3.4', '1.2.3.5', 32]), false);
  });

  await test('sameDomain compares hostnames', async () => {
    eq(await call('src/correlate.mjs', 'sameDomain', ['https://evil.com/a', 'https://evil.com/b']), true);
    eq(await call('src/correlate.mjs', 'sameDomain', ['https://evil.com/a', 'https://good.com/b']), false);
  });

  await test('buildCorrelationGraph connects same-subnet IPs', async () => {
    const iocs = [
      { value: '192.168.1.1', type: 'ipv4' },
      { value: '192.168.1.2', type: 'ipv4' },
      { value: '10.0.0.1', type: 'ipv4' }
    ];
    const graph = await call('src/correlate.mjs', 'buildCorrelationGraph', [iocs]);
    eq(graph.nodes, 3);
    const subnetEdge = graph.edges.find(e => e.reason === 'same-subnet');
    eq(subnetEdge !== undefined, true);
  });

  await test('union-find with path compression', async () => {
    const uf = await call('src/correlate.mjs', 'createUnionFind', [5]);
    await call('src/correlate.mjs', 'union', [uf, 0, 1]);
    await call('src/correlate.mjs', 'union', [uf, 1, 2]);
    await call('src/correlate.mjs', 'union', [uf, 3, 4]);
    const r0 = await call('src/correlate.mjs', 'find', [uf, 2]);
    const r1 = await call('src/correlate.mjs', 'find', [uf, 0]);
    eq(r0, r1);
    eq(uf.parent[2], r0);
  });

  await test('clusterIOCs groups connected nodes', async () => {
    const graph = {
      nodes: 4,
      edges: [
        { from: 0, to: 1, reason: 'same-subnet' },
        { from: 2, to: 3, reason: 'same-domain' }
      ]
    };
    const clusters = await call('src/correlate.mjs', 'clusterIOCs', [graph]);
    eq(clusters.length, 2);
    const sizes = clusters.map(c => c.length).sort();
    eq(sizes[0], 2);
    eq(sizes[1], 2);
  });

  await test('clusterIOCs single cluster when all connected', async () => {
    const graph = {
      nodes: 3,
      edges: [
        { from: 0, to: 1, reason: 'test' },
        { from: 1, to: 2, reason: 'test' }
      ]
    };
    const clusters = await call('src/correlate.mjs', 'clusterIOCs', [graph]);
    eq(clusters.length, 1);
    eq(clusters[0].length, 3);
  });

  await test('scoreSeverity computes correctly', async () => {
    const ioc = { type: 'cve', index: 0 };
    const graph = {
      edges: [
        { from: 0, to: 1 },
        { from: 0, to: 2 }
      ]
    };
    const score = await call('src/correlate.mjs', 'scoreSeverity', [ioc, graph, { ageDays: 0 }]);
    eq(score.typeScore, 4);
    eq(score.connectivity, 2);
    eq(score.ageDecay, 1);
    eq(score.score, 6);
  });

  await test('scoreSeverity age decay', async () => {
    const ioc = { type: 'ipv4', index: 0 };
    const graph = { edges: [] };
    const fresh = await call('src/correlate.mjs', 'scoreSeverity', [ioc, graph, { ageDays: 0 }]);
    const old = await call('src/correlate.mjs', 'scoreSeverity', [ioc, graph, { ageDays: 180 }]);
    eq(old.score < fresh.score, true);
    eq(old.ageDecay < 1, true);
  });

  // === Cross-module integration ===
  await test('Full pipeline: detect IOCs → create STIX → map ATT&CK → correlate', async () => {
    const ip = '192.168.1.100';
    const type = await call('src/ioc.mjs', 'detectType', [ip]);
    eq(type, 'ipv4');
    eq(await call('src/ioc.mjs', 'validate', [ip, type]), true);

    const ind = await call('src/stix.mjs', 'createIndicator', [`[ipv4-addr:value = '${ip}']`, { name: 'Suspicious IP' }]);
    eq(ind.type, 'indicator');

    const tech = await call('src/mitre.mjs', 'createTechnique', ['T1071', { name: 'Application Layer Protocol', tactic: 'command-and-control' }]);
    eq(tech.tactic, 'command-and-control');

    const iocs = [
      { value: '192.168.1.100', type: 'ipv4' },
      { value: '192.168.1.200', type: 'ipv4' },
      { value: 'https://evil.com/c2', type: 'url' }
    ];
    const graph = await call('src/correlate.mjs', 'buildCorrelationGraph', [iocs]);
    eq(graph.edges.length >= 1, true);
    const clusters = await call('src/correlate.mjs', 'clusterIOCs', [graph]);
    eq(clusters.length >= 1, true);
  });
}
