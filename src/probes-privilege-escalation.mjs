export async function runPrivilegeEscalationProbes({ call, test, eq }) {
  // --- permissions.mjs ---
  await test('parseOctal 755 = 493', async () => {
    const r = await call('src/permissions.mjs', 'parseOctal', ['755']);
    eq(r, 493);
  });
  await test('parseOctal 4755 = 2541', async () => {
    const r = await call('src/permissions.mjs', 'parseOctal', ['4755']);
    eq(r, 2541);
  });
  await test('parseOctal 0644 = 420', async () => {
    const r = await call('src/permissions.mjs', 'parseOctal', ['0644']);
    eq(r, 420);
  });
  await test('parseOctal rejects non-octal digits', async () => {
    let threw = false;
    try { await call('src/permissions.mjs', 'parseOctal', ['999']); } catch { threw = true; }
    if (!threw) throw new Error('Expected rejection for non-octal digits');
  });
  await test('parseOctal rejects empty string', async () => {
    let threw = false;
    try { await call('src/permissions.mjs', 'parseOctal', ['']); } catch { threw = true; }
    if (!threw) throw new Error('Expected rejection for empty string');
  });

  await test('toRwx 0o755 = rwxr-xr-x', async () => {
    const r = await call('src/permissions.mjs', 'toRwx', [0o755]);
    eq(r, 'rwxr-xr-x');
  });
  await test('toRwx 0o644 = rw-r--r--', async () => {
    const r = await call('src/permissions.mjs', 'toRwx', [0o644]);
    eq(r, 'rw-r--r--');
  });
  await test('toRwx 0o4755 = rwsr-xr-x (SUID+x)', async () => {
    const r = await call('src/permissions.mjs', 'toRwx', [0o4755]);
    eq(r, 'rwsr-xr-x');
  });
  await test('toRwx 0o4644 = rwSr--r-- (SUID no x)', async () => {
    const r = await call('src/permissions.mjs', 'toRwx', [0o4644]);
    eq(r, 'rwSr--r--');
  });
  await test('toRwx 0o2755 = rwxr-sr-x (SGID)', async () => {
    const r = await call('src/permissions.mjs', 'toRwx', [0o2755]);
    eq(r, 'rwxr-sr-x');
  });
  await test('toRwx 0o1755 = rwxr-xr-t (sticky)', async () => {
    const r = await call('src/permissions.mjs', 'toRwx', [0o1755]);
    eq(r, 'rwxr-xr-t');
  });
  await test('toRwx 0o1754 = rwxr-xr-T (sticky no x)', async () => {
    const r = await call('src/permissions.mjs', 'toRwx', [0o1754]);
    eq(r, 'rwxr-xr-T');
  });
  await test('toRwx 0o000 = ---------', async () => {
    const r = await call('src/permissions.mjs', 'toRwx', [0o000]);
    eq(r, '---------');
  });

  await test('specialBits 0o4755 suid only', async () => {
    const r = await call('src/permissions.mjs', 'specialBits', [0o4755]);
    eq(r.suid, true);
    eq(r.sgid, false);
    eq(r.sticky, false);
  });
  await test('specialBits 0o7777 all true', async () => {
    const r = await call('src/permissions.mjs', 'specialBits', [0o7777]);
    eq(r.suid, true);
    eq(r.sgid, true);
    eq(r.sticky, true);
  });
  await test('specialBits 0o644 all false', async () => {
    const r = await call('src/permissions.mjs', 'specialBits', [0o644]);
    eq(r.suid, false);
    eq(r.sgid, false);
    eq(r.sticky, false);
  });
  await test('specialBits 0o2755 sgid only', async () => {
    const r = await call('src/permissions.mjs', 'specialBits', [0o2755]);
    eq(r.suid, false);
    eq(r.sgid, true);
    eq(r.sticky, false);
  });

  await test('effectiveAccess owner gets rwx for 0o750', async () => {
    const r = await call('src/permissions.mjs', 'effectiveAccess', [
      { mode: 0o750, ownerUid: 1000, ownerGid: 100 }, 1000, 200
    ]);
    eq(r.read, true);
    eq(r.write, true);
    eq(r.execute, true);
  });
  await test('effectiveAccess group gets r-x for 0o750', async () => {
    const r = await call('src/permissions.mjs', 'effectiveAccess', [
      { mode: 0o750, ownerUid: 1000, ownerGid: 100 }, 2000, 100
    ]);
    eq(r.read, true);
    eq(r.write, false);
    eq(r.execute, true);
  });
  await test('effectiveAccess world gets --- for 0o750', async () => {
    const r = await call('src/permissions.mjs', 'effectiveAccess', [
      { mode: 0o750, ownerUid: 1000, ownerGid: 100 }, 9999, 9999
    ]);
    eq(r.read, false);
    eq(r.write, false);
    eq(r.execute, false);
  });

  // --- discovery.mjs ---
  const entries = [
    { path: '/usr/bin/sudo', mode: 0o4755, ownerUid: 0, ownerGid: 0, type: 'file' },
    { path: '/tmp', mode: 0o1777, ownerUid: 0, ownerGid: 0, type: 'dir' },
    { path: '/usr/bin/passwd', mode: 0o4755, ownerUid: 0, ownerGid: 0, type: 'file' },
    { path: '/var/log', mode: 0o755, ownerUid: 0, ownerGid: 0, type: 'dir' },
    { path: '/usr/bin/bad', mode: 0o4777, ownerUid: 0, ownerGid: 0, type: 'file' },
  ];

  await test('scanEntries finds 3 SUID entries', async () => {
    const r = await call('src/discovery.mjs', 'scanEntries', [entries]);
    eq(r.suid.length, 3);
  });
  await test('scanEntries finds 2 world-writable', async () => {
    const r = await call('src/discovery.mjs', 'scanEntries', [entries]);
    eq(r.writable.length, 2);
  });
  await test('scanEntries suid sorted by path', async () => {
    const r = await call('src/discovery.mjs', 'scanEntries', [entries]);
    eq(r.suid[0].path, '/usr/bin/bad');
  });
  await test('scanEntries misconfigs = suid+world-writable', async () => {
    const r = await call('src/discovery.mjs', 'scanEntries', [entries]);
    eq(r.misconfigs.length, 1);
  });
  await test('scanEntries misconfig is /usr/bin/bad', async () => {
    const r = await call('src/discovery.mjs', 'scanEntries', [entries]);
    eq(r.misconfigs[0].path, '/usr/bin/bad');
  });

  await test('findSuidBinaries returns only files with SUID', async () => {
    const r = await call('src/discovery.mjs', 'findSuidBinaries', [entries]);
    eq(r.length, 3);
  });
  await test('findSuidBinaries excludes dirs', async () => {
    const r = await call('src/discovery.mjs', 'findSuidBinaries', [entries]);
    const allFiles = r.every(e => e.type === 'file');
    if (!allFiles) throw new Error('Expected all results to be files');
  });

  await test('findWritablePaths for world user', async () => {
    const r = await call('src/discovery.mjs', 'findWritablePaths', [entries, 9999, 9999]);
    eq(r.length, 2);
  });

  await test('detectMisconfigs finds suid-world-writable file', async () => {
    const r = await call('src/discovery.mjs', 'detectMisconfigs', [entries]);
    eq(r.length, 1);
  });
  await test('detectMisconfigs risk is critical', async () => {
    const r = await call('src/discovery.mjs', 'detectMisconfigs', [entries]);
    eq(r[0].risk, 'critical');
  });
  await test('detectMisconfigs reason', async () => {
    const r = await call('src/discovery.mjs', 'detectMisconfigs', [entries]);
    eq(r[0].reason, 'suid-world-writable');
  });

  // --- capabilities.mjs ---
  await test('validateCap known cap = true', async () => {
    const r = await call('src/capabilities.mjs', 'validateCap', ['CAP_SYS_ADMIN']);
    eq(r, true);
  });
  await test('validateCap unknown cap = false', async () => {
    const r = await call('src/capabilities.mjs', 'validateCap', ['CAP_BOGUS']);
    eq(r, false);
  });

  await test('capIntersection returns common caps sorted', async () => {
    const r = await call('src/capabilities.mjs', 'capIntersection', [
      ['CAP_SYS_ADMIN', 'CAP_NET_RAW', 'CAP_KILL'],
      ['CAP_NET_RAW', 'CAP_CHOWN', 'CAP_KILL']
    ]);
    eq(r.length, 2);
    eq(r[0], 'CAP_KILL');
    eq(r[1], 'CAP_NET_RAW');
  });
  await test('capIntersection throws on invalid cap', async () => {
    let threw = false;
    try { await call('src/capabilities.mjs', 'capIntersection', [['FAKE'], ['CAP_KILL']]); } catch { threw = true; }
    if (!threw) throw new Error('Expected rejection for invalid cap');
  });

  await test('capUnion returns all unique caps', async () => {
    const r = await call('src/capabilities.mjs', 'capUnion', [
      ['CAP_SYS_ADMIN', 'CAP_KILL'],
      ['CAP_KILL', 'CAP_CHOWN']
    ]);
    eq(r.length, 3);
  });

  await test('capDifference removes b from a', async () => {
    const r = await call('src/capabilities.mjs', 'capDifference', [
      ['CAP_SYS_ADMIN', 'CAP_NET_RAW', 'CAP_KILL'],
      ['CAP_NET_RAW']
    ]);
    eq(r.length, 2);
  });
  await test('capDifference contains SYS_ADMIN', async () => {
    const r = await call('src/capabilities.mjs', 'capDifference', [
      ['CAP_SYS_ADMIN', 'CAP_NET_RAW', 'CAP_KILL'],
      ['CAP_NET_RAW']
    ]);
    const has = r.includes('CAP_SYS_ADMIN');
    if (!has) throw new Error('Expected CAP_SYS_ADMIN in result');
  });

  await test('scoreVector SYS_ADMIN = 10', async () => {
    const r = await call('src/capabilities.mjs', 'scoreVector', [['CAP_SYS_ADMIN']]);
    eq(r, 10);
  });
  await test('scoreVector SYS_ADMIN+SETUID = 19', async () => {
    const r = await call('src/capabilities.mjs', 'scoreVector', [['CAP_SYS_ADMIN', 'CAP_SETUID']]);
    eq(r, 19);
  });

  await test('classifyRisk 5 = low', async () => {
    const r = await call('src/capabilities.mjs', 'classifyRisk', [5]);
    eq(r, 'low');
  });
  await test('classifyRisk 15 = medium', async () => {
    const r = await call('src/capabilities.mjs', 'classifyRisk', [15]);
    eq(r, 'medium');
  });
  await test('classifyRisk 25 = high', async () => {
    const r = await call('src/capabilities.mjs', 'classifyRisk', [25]);
    eq(r, 'high');
  });
  await test('classifyRisk 30 = critical', async () => {
    const r = await call('src/capabilities.mjs', 'classifyRisk', [30]);
    eq(r, 'critical');
  });

  // --- exploit-chain.mjs ---
  const nodes = [
    { id: 'webuser', level: 'user', caps: [] },
    { id: 'apache', level: 'service', caps: ['CAP_NET_BIND_SERVICE'] },
    { id: 'dbadmin', level: 'service', caps: ['CAP_DAC_OVERRIDE'] },
    { id: 'root', level: 'root', caps: ['CAP_SYS_ADMIN'] },
  ];
  const edges = [
    { from: 'webuser', to: 'apache', method: 'sql-injection', reliability: 0.8 },
    { from: 'apache', to: 'dbadmin', method: 'cred-theft', reliability: 0.6 },
    { from: 'dbadmin', to: 'root', method: 'kernel-exploit', reliability: 0.3 },
    { from: 'webuser', to: 'root', method: 'zero-day', reliability: 0.1 },
  ];

  await test('buildPrivGraph nodeCount', async () => {
    const g = await call('src/exploit-chain.mjs', 'buildPrivGraph', [nodes, edges]);
    eq(g.nodeCount, 4);
  });
  await test('buildPrivGraph edgeCount', async () => {
    const g = await call('src/exploit-chain.mjs', 'buildPrivGraph', [nodes, edges]);
    eq(g.edgeCount, 4);
  });
  await test('buildPrivGraph nodes is map', async () => {
    const g = await call('src/exploit-chain.mjs', 'buildPrivGraph', [nodes, edges]);
    eq(g.nodes['root'].level, 'root');
  });
  await test('buildPrivGraph edges adjacency list', async () => {
    const g = await call('src/exploit-chain.mjs', 'buildPrivGraph', [nodes, edges]);
    eq(g.edges['webuser'].length, 2);
  });

  await test('findChain finds shortest path (1 hop direct)', async () => {
    const g = await call('src/exploit-chain.mjs', 'buildPrivGraph', [nodes, edges]);
    const chain = await call('src/exploit-chain.mjs', 'findChain', [g, 'webuser', 'root']);
    eq(chain.hops, 1);
  });
  await test('findChain path starts at source', async () => {
    const g = await call('src/exploit-chain.mjs', 'buildPrivGraph', [nodes, edges]);
    const chain = await call('src/exploit-chain.mjs', 'findChain', [g, 'webuser', 'root']);
    eq(chain.path[0], 'webuser');
  });
  await test('findChain path ends at target', async () => {
    const g = await call('src/exploit-chain.mjs', 'buildPrivGraph', [nodes, edges]);
    const chain = await call('src/exploit-chain.mjs', 'findChain', [g, 'webuser', 'root']);
    eq(chain.path[chain.path.length - 1], 'root');
  });

  await test('findChain self = 0 hops', async () => {
    const g = await call('src/exploit-chain.mjs', 'buildPrivGraph', [nodes, edges]);
    const chain = await call('src/exploit-chain.mjs', 'findChain', [g, 'webuser', 'webuser']);
    eq(chain.hops, 0);
  });
  await test('findChain self path = [source]', async () => {
    const g = await call('src/exploit-chain.mjs', 'buildPrivGraph', [nodes, edges]);
    const chain = await call('src/exploit-chain.mjs', 'findChain', [g, 'webuser', 'webuser']);
    eq(chain.path.length, 1);
  });

  await test('findChain unreachable returns null path', async () => {
    const nodesIsland = [
      { id: 'a', level: 'user', caps: [] },
      { id: 'b', level: 'root', caps: [] },
    ];
    const g = await call('src/exploit-chain.mjs', 'buildPrivGraph', [nodesIsland, []]);
    const chain = await call('src/exploit-chain.mjs', 'findChain', [g, 'a', 'b']);
    eq(chain.path, null);
  });
  await test('findChain unreachable hops = -1', async () => {
    const nodesIsland = [
      { id: 'a', level: 'user', caps: [] },
      { id: 'b', level: 'root', caps: [] },
    ];
    const g = await call('src/exploit-chain.mjs', 'buildPrivGraph', [nodesIsland, []]);
    const chain = await call('src/exploit-chain.mjs', 'findChain', [g, 'a', 'b']);
    eq(chain.hops, -1);
  });

  await test('validateChain valid chain', async () => {
    const g = await call('src/exploit-chain.mjs', 'buildPrivGraph', [nodes, edges]);
    const chain = await call('src/exploit-chain.mjs', 'findChain', [g, 'webuser', 'root']);
    const v = await call('src/exploit-chain.mjs', 'validateChain', [g, chain]);
    eq(v.valid, true);
  });
  await test('validateChain null path = invalid', async () => {
    const g = await call('src/exploit-chain.mjs', 'buildPrivGraph', [nodes, edges]);
    const v = await call('src/exploit-chain.mjs', 'validateChain', [g, { path: null, hops: -1, methods: [] }]);
    eq(v.valid, false);
  });
  await test('validateChain null path reason = no_path', async () => {
    const g = await call('src/exploit-chain.mjs', 'buildPrivGraph', [nodes, edges]);
    const v = await call('src/exploit-chain.mjs', 'validateChain', [g, { path: null, hops: -1, methods: [] }]);
    eq(v.reason, 'no_path');
  });

  await test('estimateProbability is a number in [0,1]', async () => {
    const g = await call('src/exploit-chain.mjs', 'buildPrivGraph', [nodes, edges]);
    const chain = await call('src/exploit-chain.mjs', 'findChain', [g, 'webuser', 'root']);
    const p = await call('src/exploit-chain.mjs', 'estimateProbability', [chain, { 'zero-day': 0.5 }]);
    if (typeof p !== 'number') throw new Error('Expected number');
    if (p < 0 || p > 1) throw new Error('Expected 0 <= p <= 1');
  });
  await test('estimateProbability 0 hops = 1.0', async () => {
    const g = await call('src/exploit-chain.mjs', 'buildPrivGraph', [nodes, edges]);
    const chain = await call('src/exploit-chain.mjs', 'findChain', [g, 'webuser', 'webuser']);
    const p = await call('src/exploit-chain.mjs', 'estimateProbability', [chain, {}]);
    eq(p, 1.0);
  });

  await test('buildPrivGraph rejects self-loops', async () => {
    let threw = false;
    try {
      await call('src/exploit-chain.mjs', 'buildPrivGraph', [
        [{ id: 'x', level: 'user', caps: [] }],
        [{ from: 'x', to: 'x', method: 'loop', reliability: 1 }]
      ]);
    } catch { threw = true; }
    if (!threw) throw new Error('Expected rejection for self-loops');
  });
}
