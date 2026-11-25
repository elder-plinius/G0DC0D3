export async function runZeroDayDbProbes({ call, test, eq }) {
  // --- cvss.mjs: parseVector ---

  await test('parseVector extracts all 8 metrics', async () => {
    const r = await call('src/cvss.mjs', 'parseVector', ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H']);
    eq(r.AV, 'N');
    eq(r.AC, 'L');
    eq(r.PR, 'N');
    eq(r.UI, 'N');
    eq(r.S, 'U');
    eq(r.C, 'H');
    eq(r.I, 'H');
    eq(r.A, 'H');
  });

  await test('parseVector rejects missing prefix', async () => {
    let threw = false;
    try { await call('src/cvss.mjs', 'parseVector', ['AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H']); } catch { threw = true; }
    if (!threw) throw new Error('Expected error for missing CVSS:3.1 prefix');
  });

  await test('parseVector rejects incomplete metrics', async () => {
    let threw = false;
    try { await call('src/cvss.mjs', 'parseVector', ['CVSS:3.1/AV:N/AC:L']); } catch { threw = true; }
    if (!threw) throw new Error('Expected error for incomplete metrics');
  });

  await test('parseVector rejects invalid metric value', async () => {
    let threw = false;
    try { await call('src/cvss.mjs', 'parseVector', ['CVSS:3.1/AV:Z/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H']); } catch { threw = true; }
    if (!threw) throw new Error('Expected error for invalid AV value');
  });

  // --- cvss.mjs: baseScore ---

  await test('baseScore critical vector = 9.8', async () => {
    const r = await call('src/cvss.mjs', 'baseScore', ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H']);
    eq(r, 9.8);
  });

  await test('baseScore zero impact = 0', async () => {
    const r = await call('src/cvss.mjs', 'baseScore', ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N']);
    eq(r, 0);
  });

  await test('baseScore changed scope XSS vector = 6.1', async () => {
    const r = await call('src/cvss.mjs', 'baseScore', ['CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N']);
    eq(r, 6.1);
  });

  await test('baseScore low severity vector', async () => {
    const r = await call('src/cvss.mjs', 'baseScore', ['CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N']);
    if (r >= 3) throw new Error('Expected low score, got ' + r);
  });

  await test('baseScore uses scope-dependent PR weights', async () => {
    // Same vector with S:U vs S:C should give different scores due to PR weight change
    const u = await call('src/cvss.mjs', 'baseScore', ['CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H']);
    const c = await call('src/cvss.mjs', 'baseScore', ['CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:H']);
    if (u === c) throw new Error('S:U and S:C should produce different scores when PR=L');
  });

  await test('baseScore roundUp: ceil(x*10)/10', async () => {
    const r = await call('src/cvss.mjs', 'baseScore', ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H']);
    if (r !== Math.ceil(r * 10) / 10) throw new Error('Score not rounded up');
  });

  await test('baseScore capped at 10.0', async () => {
    const r = await call('src/cvss.mjs', 'baseScore', ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H']);
    if (r > 10.0) throw new Error('Score exceeds 10.0');
  });

  await test('baseScore accepts parsed object', async () => {
    const parsed = await call('src/cvss.mjs', 'parseVector', ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H']);
    const r = await call('src/cvss.mjs', 'baseScore', [parsed]);
    eq(r, 9.8);
  });

  // --- cvss.mjs: severity ---

  await test('severity 0 = None', async () => {
    eq(await call('src/cvss.mjs', 'severity', [0]), 'None');
  });

  await test('severity 3.5 = Low', async () => {
    eq(await call('src/cvss.mjs', 'severity', [3.5]), 'Low');
  });

  await test('severity 5.0 = Medium', async () => {
    eq(await call('src/cvss.mjs', 'severity', [5.0]), 'Medium');
  });

  await test('severity 8.0 = High', async () => {
    eq(await call('src/cvss.mjs', 'severity', [8.0]), 'High');
  });

  await test('severity 9.5 = Critical', async () => {
    eq(await call('src/cvss.mjs', 'severity', [9.5]), 'Critical');
  });

  await test('severity boundary 3.9 = Low', async () => {
    eq(await call('src/cvss.mjs', 'severity', [3.9]), 'Low');
  });

  await test('severity boundary 4.0 = Medium', async () => {
    eq(await call('src/cvss.mjs', 'severity', [4.0]), 'Medium');
  });

  // --- cvss.mjs: compareVulnerabilities ---

  await test('compareVulnerabilities returns scores and comparison', async () => {
    const r = await call('src/cvss.mjs', 'compareVulnerabilities', [
      'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
      'CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N'
    ]);
    eq(r.aScore, 9.8);
    if (r.bScore >= 9.8) throw new Error('b should be lower');
    eq(r.moreSevere, 'a');
    if (r.riskDelta <= 0) throw new Error('riskDelta should be positive');
  });

  await test('compareVulnerabilities equal vectors', async () => {
    const v = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';
    const r = await call('src/cvss.mjs', 'compareVulnerabilities', [v, v]);
    eq(r.moreSevere, 'equal');
    eq(r.riskDelta, 0);
  });

  // --- cve.mjs: createCve ---

  await test('createCve creates valid record', async () => {
    const r = await call('src/cve.mjs', 'createCve', ['CVE-2024-12345', {
      description: 'RCE vuln', vendor: 'Apache', product: 'httpd',
      versions: ['2.4.49'], discoveredDate: '2024-01-15'
    }]);
    eq(r.id, 'CVE-2024-12345');
    eq(r.status, 'new');
    eq(r.publishedDate, null);
    eq(r.references.length, 0);
  });

  await test('createCve rejects invalid ID format', async () => {
    let threw = false;
    try { await call('src/cve.mjs', 'createCve', ['BAD-ID', {
      description: 'd', vendor: 'v', product: 'p', versions: ['1'], discoveredDate: '2024-01-01'
    }]); } catch { threw = true; }
    if (!threw) throw new Error('Expected error for invalid CVE ID');
  });

  await test('createCve rejects too few digits', async () => {
    let threw = false;
    try { await call('src/cve.mjs', 'createCve', ['CVE-2024-123', {
      description: 'd', vendor: 'v', product: 'p', versions: ['1'], discoveredDate: '2024-01-01'
    }]); } catch { threw = true; }
    if (!threw) throw new Error('Expected error for 3-digit sequence');
  });

  await test('createCve accepts 5+ digit sequence', async () => {
    const r = await call('src/cve.mjs', 'createCve', ['CVE-2024-123456', {
      description: 'd', vendor: 'v', product: 'p', versions: ['1'], discoveredDate: '2024-01-01'
    }]);
    eq(r.id, 'CVE-2024-123456');
  });

  // --- cve.mjs: updateStatus ---

  await test('updateStatus new -> analyzing', async () => {
    const cve = { id: 'CVE-2024-0001', status: 'new', publishedDate: null };
    const r = await call('src/cve.mjs', 'updateStatus', [cve, 'analyzing']);
    eq(r.status, 'analyzing');
  });

  await test('updateStatus confirmed -> published sets publishedDate', async () => {
    const cve = { id: 'CVE-2024-0001', status: 'confirmed', publishedDate: null };
    const r = await call('src/cve.mjs', 'updateStatus', [cve, 'published', { now: '2024-06-15' }]);
    eq(r.status, 'published');
    eq(r.publishedDate, '2024-06-15');
  });

  await test('updateStatus rejects invalid transition', async () => {
    const cve = { id: 'CVE-2024-0001', status: 'new', publishedDate: null };
    let threw = false;
    try { await call('src/cve.mjs', 'updateStatus', [cve, 'published']); } catch { threw = true; }
    if (!threw) throw new Error('Expected error for invalid transition new->published');
  });

  await test('updateStatus does not mutate input', async () => {
    const cve = { id: 'CVE-2024-0001', status: 'new', publishedDate: null };
    await call('src/cve.mjs', 'updateStatus', [cve, 'analyzing'], { immutable: true });
  });

  // --- cve.mjs: addReference ---

  await test('addReference adds valid reference', async () => {
    const cve = { id: 'CVE-2024-0001', references: [] };
    const r = await call('src/cve.mjs', 'addReference', [cve, { url: 'https://example.com/advisory', type: 'advisory' }]);
    eq(r.references.length, 1);
    eq(r.references[0].url, 'https://example.com/advisory');
  });

  await test('addReference rejects invalid URL', async () => {
    let threw = false;
    try { await call('src/cve.mjs', 'addReference', [{ references: [] }, { url: 'ftp://bad', type: 'advisory' }]); } catch { threw = true; }
    if (!threw) throw new Error('Expected error for invalid URL');
  });

  await test('addReference rejects invalid type', async () => {
    let threw = false;
    try { await call('src/cve.mjs', 'addReference', [{ references: [] }, { url: 'https://x.com', type: 'blog' }]); } catch { threw = true; }
    if (!threw) throw new Error('Expected error for invalid type');
  });

  await test('addReference rejects duplicate URL', async () => {
    const cve = { references: [{ url: 'https://x.com', type: 'advisory' }] };
    let threw = false;
    try { await call('src/cve.mjs', 'addReference', [cve, { url: 'https://x.com', type: 'patch' }]); } catch { threw = true; }
    if (!threw) throw new Error('Expected error for duplicate URL');
  });

  // --- cve.mjs: searchCves ---

  await test('searchCves filters by vendor (case-insensitive substring)', async () => {
    const cves = [
      { id: 'CVE-2024-0001', vendor: 'Apache', product: 'httpd', status: 'new' },
      { id: 'CVE-2024-0002', vendor: 'Nginx', product: 'nginx', status: 'new' },
    ];
    const r = await call('src/cve.mjs', 'searchCves', [cves, { vendor: 'apache' }]);
    eq(r.length, 1);
    eq(r[0].id, 'CVE-2024-0001');
  });

  await test('searchCves filters by status exact match', async () => {
    const cves = [
      { id: 'CVE-2024-0001', vendor: 'v', product: 'p', status: 'new' },
      { id: 'CVE-2024-0002', vendor: 'v', product: 'p', status: 'published' },
    ];
    const r = await call('src/cve.mjs', 'searchCves', [cves, { status: 'published' }]);
    eq(r.length, 1);
    eq(r[0].id, 'CVE-2024-0002');
  });

  await test('searchCves filters by year range', async () => {
    const cves = [
      { id: 'CVE-2022-0001', vendor: 'v', product: 'p', status: 'new' },
      { id: 'CVE-2024-0001', vendor: 'v', product: 'p', status: 'new' },
      { id: 'CVE-2025-0001', vendor: 'v', product: 'p', status: 'new' },
    ];
    const r = await call('src/cve.mjs', 'searchCves', [cves, { minYear: 2023, maxYear: 2024 }]);
    eq(r.length, 1);
    eq(r[0].id, 'CVE-2024-0001');
  });

  await test('searchCves AND logic on multiple filters', async () => {
    const cves = [
      { id: 'CVE-2024-0001', vendor: 'Apache', product: 'httpd', status: 'published' },
      { id: 'CVE-2024-0002', vendor: 'Apache', product: 'tomcat', status: 'new' },
      { id: 'CVE-2024-0003', vendor: 'Nginx', product: 'nginx', status: 'published' },
    ];
    const r = await call('src/cve.mjs', 'searchCves', [cves, { vendor: 'apache', status: 'published' }]);
    eq(r.length, 1);
    eq(r[0].id, 'CVE-2024-0001');
  });

  // --- cpe.mjs: parseCpe ---

  await test('parseCpe parses all fields', async () => {
    const r = await call('src/cpe.mjs', 'parseCpe', ['cpe:2.3:a:apache:http_server:2.4.49:*:*:*:*:*:*:*']);
    eq(r.part, 'a');
    eq(r.vendor, 'apache');
    eq(r.product, 'http_server');
    eq(r.version, '2.4.49');
  });

  await test('parseCpe rejects invalid prefix', async () => {
    let threw = false;
    try { await call('src/cpe.mjs', 'parseCpe', ['cpe:2.2:a:v:p:1.0:*:*:*:*:*:*:*']); } catch { threw = true; }
    if (!threw) throw new Error('Expected error for wrong CPE version');
  });

  await test('parseCpe rejects wrong field count', async () => {
    let threw = false;
    try { await call('src/cpe.mjs', 'parseCpe', ['cpe:2.3:a:v:p']); } catch { threw = true; }
    if (!threw) throw new Error('Expected error for insufficient fields');
  });

  // --- cpe.mjs: matchCpe ---

  await test('matchCpe wildcard matches anything', async () => {
    const pat = await call('src/cpe.mjs', 'parseCpe', ['cpe:2.3:a:apache:*:*:*:*:*:*:*:*:*']);
    const tgt = await call('src/cpe.mjs', 'parseCpe', ['cpe:2.3:a:apache:http_server:2.4.49:*:*:*:*:*:*:*']);
    eq(await call('src/cpe.mjs', 'matchCpe', [tgt, pat]), true);
  });

  await test('matchCpe case-insensitive', async () => {
    const pat = await call('src/cpe.mjs', 'parseCpe', ['cpe:2.3:a:Apache:*:*:*:*:*:*:*:*:*']);
    const tgt = await call('src/cpe.mjs', 'parseCpe', ['cpe:2.3:a:apache:http_server:2.4.49:*:*:*:*:*:*:*']);
    eq(await call('src/cpe.mjs', 'matchCpe', [tgt, pat]), true);
  });

  await test('matchCpe rejects vendor mismatch', async () => {
    const pat = await call('src/cpe.mjs', 'parseCpe', ['cpe:2.3:a:nginx:*:*:*:*:*:*:*:*:*']);
    const tgt = await call('src/cpe.mjs', 'parseCpe', ['cpe:2.3:a:apache:http_server:2.4.49:*:*:*:*:*:*:*']);
    eq(await call('src/cpe.mjs', 'matchCpe', [tgt, pat]), false);
  });

  // --- cpe.mjs: versionInRange ---

  await test('versionInRange dot-separated integer comparison', async () => {
    eq(await call('src/cpe.mjs', 'versionInRange', ['2.4.49', { min: '2.4.0', max: '2.5.0' }]), true);
  });

  await test('versionInRange 2.10 > 2.9 (not string comparison)', async () => {
    eq(await call('src/cpe.mjs', 'versionInRange', ['2.10', { min: '2.9' }]), true);
  });

  await test('versionInRange excludes max by default', async () => {
    eq(await call('src/cpe.mjs', 'versionInRange', ['2.5.0', { min: '2.0', max: '2.5.0' }]), false);
  });

  await test('versionInRange includeMax', async () => {
    eq(await call('src/cpe.mjs', 'versionInRange', ['2.5.0', { min: '2.0', max: '2.5.0', includeMax: true }]), true);
  });

  await test('versionInRange missing segment = 0', async () => {
    eq(await call('src/cpe.mjs', 'versionInRange', ['1.0', { min: '1.0.0' }]), true);
  });

  // --- cpe.mjs: findAffected ---

  await test('findAffected filters by pattern and version range', async () => {
    const cpes = [
      'cpe:2.3:a:apache:http_server:2.4.49:*:*:*:*:*:*:*',
      'cpe:2.3:a:apache:http_server:2.4.50:*:*:*:*:*:*:*',
      'cpe:2.3:a:nginx:nginx:1.21:*:*:*:*:*:*:*',
    ];
    const advisory = {
      cpe: 'cpe:2.3:a:apache:http_server:*:*:*:*:*:*:*:*',
      versionRange: { min: '2.4.0', max: '2.4.50' }
    };
    const r = await call('src/cpe.mjs', 'findAffected', [cpes, advisory]);
    eq(r.length, 1);
    if (!r[0].includes('2.4.49')) throw new Error('Should include 2.4.49');
  });

  // --- temporal.mjs: temporalScore ---

  await test('temporalScore X modifiers = no change', async () => {
    const r = await call('src/temporal.mjs', 'temporalScore', [9.8, { ECM: 'X', RL: 'X', RC: 'X' }]);
    eq(r, 9.8);
  });

  await test('temporalScore P/T/R reduces score', async () => {
    const r = await call('src/temporal.mjs', 'temporalScore', [9.8, { ECM: 'P', RL: 'T', RC: 'R' }]);
    const expected = Math.ceil(9.8 * 0.94 * 0.96 * 0.96 * 10) / 10;
    eq(r, expected);
  });

  await test('temporalScore U exploit maturity', async () => {
    const r = await call('src/temporal.mjs', 'temporalScore', [10.0, { ECM: 'U', RL: 'X', RC: 'X' }]);
    const expected = Math.ceil(10.0 * 0.91 * 10) / 10;
    eq(r, expected);
  });

  // --- temporal.mjs: environmentalScore ---

  await test('environmentalScore medium = no change', async () => {
    const r = await call('src/temporal.mjs', 'environmentalScore', [9.8, 9.8, { CR: 'M', IR: 'M', AR: 'M' }]);
    eq(r, 9.8);
  });

  await test('environmentalScore high reqs increase score', async () => {
    const r = await call('src/temporal.mjs', 'environmentalScore', [8.0, 8.0, { CR: 'H', IR: 'H', AR: 'H' }]);
    if (r <= 8.0) throw new Error('High reqs should increase score');
  });

  await test('environmentalScore low reqs decrease score', async () => {
    const r = await call('src/temporal.mjs', 'environmentalScore', [8.0, 8.0, { CR: 'L', IR: 'L', AR: 'L' }]);
    if (r >= 8.0) throw new Error('Low reqs should decrease score');
  });

  await test('environmentalScore capped at 10', async () => {
    const r = await call('src/temporal.mjs', 'environmentalScore', [9.8, 9.8, { CR: 'H', IR: 'H', AR: 'H' }]);
    if (r > 10.0) throw new Error('Score should be capped at 10');
  });

  // --- temporal.mjs: prioritize ---

  await test('prioritize sorts by environmental DESC', async () => {
    const vulns = [
      { id: 'CVE-2024-0001', baseScore: 9.0, environmentalScore: 7.0 },
      { id: 'CVE-2024-0002', baseScore: 5.0, environmentalScore: 9.0 },
    ];
    const r = await call('src/temporal.mjs', 'prioritize', [vulns]);
    eq(r[0].id, 'CVE-2024-0002');
  });

  await test('prioritize uses temporal as second sort', async () => {
    const vulns = [
      { id: 'CVE-2024-0001', baseScore: 9.0, environmentalScore: 8.0, temporalScore: 7.0 },
      { id: 'CVE-2024-0002', baseScore: 5.0, environmentalScore: 8.0, temporalScore: 9.0 },
    ];
    const r = await call('src/temporal.mjs', 'prioritize', [vulns]);
    eq(r[0].id, 'CVE-2024-0002');
  });

  await test('prioritize CVE ID ASC as tiebreaker', async () => {
    const vulns = [
      { id: 'CVE-2024-0002', baseScore: 9.0 },
      { id: 'CVE-2024-0001', baseScore: 9.0 },
    ];
    const r = await call('src/temporal.mjs', 'prioritize', [vulns]);
    eq(r[0].id, 'CVE-2024-0001');
  });

  await test('prioritize does not mutate input', async () => {
    const vulns = [
      { id: 'CVE-2024-0002', baseScore: 5.0 },
      { id: 'CVE-2024-0001', baseScore: 9.0 },
    ];
    await call('src/temporal.mjs', 'prioritize', [vulns], { immutable: true });
  });
}
