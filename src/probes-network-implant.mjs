export async function runNetworkImplantProbes({call, test, eq}) {
  // === packet.mjs ===

  await test('buildTcpHeader returns 20-byte Uint8Array', async () => {
    const tcp = await call('src/packet.mjs', 'buildTcpHeader', [{srcPort: 1234, dstPort: 80}]);
    eq(tcp instanceof Uint8Array, true);
    eq(tcp.length, 20);
  });

  await test('buildTcpHeader ports are big-endian', async () => {
    const tcp = await call('src/packet.mjs', 'buildTcpHeader', [{srcPort: 0x3039, dstPort: 0x0050}]);
    // big-endian: srcPort 0x3039 → byte[0]=0x30, byte[1]=0x39
    eq(tcp[0], 0x30);
    eq(tcp[1], 0x39);
    eq(tcp[2], 0x00);
    eq(tcp[3], 0x50);
  });

  await test('buildTcpHeader dataOffset in high nibble of byte 12', async () => {
    const tcp = await call('src/packet.mjs', 'buildTcpHeader', [{srcPort: 1, dstPort: 2, flags: 0x02}]);
    // data offset = 5, stored in high nibble of byte 12 → byte 12 & 0xF0 === 0x50
    eq((tcp[12] & 0xF0), 0x50);
  });

  await test('buildTcpHeader flags in byte 13 not byte 12', async () => {
    const tcp = await call('src/packet.mjs', 'buildTcpHeader', [{srcPort: 1, dstPort: 2, flags: 0x12}]);
    eq(tcp[13], 0x12);
    // byte 12 high nibble should still be data offset 5
    eq((tcp[12] >> 4), 5);
  });

  await test('buildTcpHeader SYN+ACK flags combined', async () => {
    const tcp = await call('src/packet.mjs', 'buildTcpHeader', [{srcPort: 80, dstPort: 1234, flags: 0x12}]);
    eq(tcp[13], 0x12);
  });

  await test('buildTcpHeader seqNum and ackNum at correct offsets', async () => {
    const tcp = await call('src/packet.mjs', 'buildTcpHeader', [{
      srcPort: 1, dstPort: 2, seqNum: 0x12345678, ackNum: 0xABCDEF01
    }]);
    // seqNum at bytes 4-7 big-endian
    eq(tcp[4], 0x12);
    eq(tcp[5], 0x34);
    eq(tcp[6], 0x56);
    eq(tcp[7], 0x78);
    // ackNum at bytes 8-11 big-endian
    eq(tcp[8], 0xAB);
    eq(tcp[9], 0xCD);
    eq(tcp[10], 0xEF);
    eq(tcp[11], 0x01);
  });

  await test('buildTcpHeader windowSize at bytes 14-15', async () => {
    const tcp = await call('src/packet.mjs', 'buildTcpHeader', [{srcPort: 1, dstPort: 2, windowSize: 32768}]);
    const ws = (tcp[14] << 8) | tcp[15];
    eq(ws, 32768);
  });

  await test('buildUdpHeader length includes header size', async () => {
    const payload = new Uint8Array(12);
    const udp = await call('src/packet.mjs', 'buildUdpHeader', [{srcPort: 1234, dstPort: 53, payload}]);
    eq(udp.length, 8);
    // length field at bytes 4-5 should be 8 + 12 = 20
    const len = (udp[4] << 8) | udp[5];
    eq(len, 20);
  });

  await test('buildUdpHeader ports big-endian', async () => {
    const udp = await call('src/packet.mjs', 'buildUdpHeader', [{srcPort: 0x1234, dstPort: 0x0035, payload: new Uint8Array(0)}]);
    eq(udp[0], 0x12);
    eq(udp[1], 0x34);
    eq(udp[2], 0x00);
    eq(udp[3], 0x35);
  });

  await test('buildIcmpEchoRequest type is 8 not 0', async () => {
    const icmp = await call('src/packet.mjs', 'buildIcmpEchoRequest', [{id: 1, seq: 1}]);
    eq(icmp[0], 8);
    eq(icmp[1], 0);
  });

  await test('buildIcmpEchoRequest checksum validates to zero', async () => {
    const icmp = await call('src/packet.mjs', 'buildIcmpEchoRequest', [{id: 0x1234, seq: 0x0001, payload: new Uint8Array([1, 2, 3, 4])}]);
    // RFC 1071: checksum of complete packet with correct checksum should be 0
    const cs = await call('src/packet.mjs', 'internetChecksum', [icmp]);
    eq(cs, 0);
  });

  await test('parseFlags correct bit positions', async () => {
    // SYN only = 0x02
    const synOnly = await call('src/packet.mjs', 'parseFlags', [0x02]);
    eq(synOnly.SYN, true);
    eq(synOnly.FIN, false);
    eq(synOnly.ACK, false);

    // FIN only = 0x01
    const finOnly = await call('src/packet.mjs', 'parseFlags', [0x01]);
    eq(finOnly.FIN, true);
    eq(finOnly.SYN, false);

    // ACK = 0x10
    const ackOnly = await call('src/packet.mjs', 'parseFlags', [0x10]);
    eq(ackOnly.ACK, true);
    eq(ackOnly.SYN, false);
    eq(ackOnly.FIN, false);
  });

  await test('parseFlags CWR at bit 7', async () => {
    const cwr = await call('src/packet.mjs', 'parseFlags', [0x80]);
    eq(cwr.CWR, true);
    eq(cwr.ECE, false);
    eq(cwr.URG, false);
  });

  await test('internetChecksum folds carries correctly', async () => {
    // 0xFFFF + 0x0001 = 0x10000, carry folds to 0x0001, complement = 0xFFFE
    const buf = new Uint8Array([0xFF, 0xFF, 0x00, 0x01]);
    const cs = await call('src/packet.mjs', 'internetChecksum', [buf]);
    eq(cs, 0xFFFE);
  });

  await test('internetChecksum handles odd-length buffer', async () => {
    const buf = new Uint8Array([0x01, 0x02, 0x03]);
    const cs = await call('src/packet.mjs', 'internetChecksum', [buf]);
    eq(typeof cs, 'number');
    eq(cs >= 0, true);
    eq(cs <= 0xFFFF, true);
  });

  // === dns-tunnel.mjs ===

  await test('encodeDnsQuery zero-pads seqNum to 4 digits', async () => {
    const queries = await call('src/dns-tunnel.mjs', 'encodeDnsQuery', [Buffer.from('hi'), 'c2.test']);
    eq(queries[0].startsWith('0000.'), true);
  });

  await test('encodeDnsQuery seqNum padded for multi-chunk', async () => {
    // Force many chunks with maxLabelLen=4
    const queries = await call('src/dns-tunnel.mjs', 'encodeDnsQuery', [Buffer.from('hello world!!'), 'c2.test', {maxLabelLen: 4}]);
    if (queries.length < 2) throw new Error('Expected multiple chunks');
    eq(queries[0].startsWith('0000.'), true);
    eq(queries[1].startsWith('0001.'), true);
  });

  await test('encodeDnsQuery respects maxLabelLen', async () => {
    const queries = await call('src/dns-tunnel.mjs', 'encodeDnsQuery', [
      Buffer.from('abcdefghijklmnopqrstuvwxyz'), 'example.com', {maxLabelLen: 10}
    ]);
    // Each query: {seqNum}.{chunk}.example.com — chunk should be <= 10 chars
    for (const q of queries) {
      const withoutDomain = q.replace('.example.com', '');
      const dotIdx = withoutDomain.indexOf('.');
      const chunk = withoutDomain.slice(dotIdx + 1);
      if (chunk.length > 10) throw new Error(`chunk exceeds maxLabelLen: ${chunk.length}`);
    }
  });

  await test('encodeDnsQuery appends domain suffix', async () => {
    const queries = await call('src/dns-tunnel.mjs', 'encodeDnsQuery', [Buffer.from('x'), 'evil.com']);
    eq(queries[0].endsWith('.evil.com'), true);
  });

  await test('decodeDnsQueries sorts numerically not alphabetically', async () => {
    // Build queries out of order with seqNums 0..10
    // Alphabetic sort puts "10" before "2"
    const queries = [];
    for (let i = 0; i <= 10; i++) {
      queries.push(`${String(i).padStart(4, '0')}.${i.toString(16).padStart(2, '0')}.test.com`);
    }
    // Shuffle
    const shuffled = [queries[5], queries[10], queries[0], queries[3], queries[7], queries[1], queries[9], queries[2], queries[8], queries[4], queries[6]];
    const decoded = await call('src/dns-tunnel.mjs', 'decodeDnsQueries', [shuffled, 'test.com']);
    // Should reconstruct: "00" "01" "02" ... "0a" in order
    eq(decoded[0], 0x00);
    eq(decoded[1], 0x01);
    eq(decoded[10], 0x0a);
  });

  await test('decodeDnsQueries validates contiguity', async () => {
    const queries = [
      '0000.aa.test.com',
      '0002.bb.test.com'  // gap — missing 0001
    ];
    let threw = false;
    try { await call('src/dns-tunnel.mjs', 'decodeDnsQueries', [queries, 'test.com']); } catch { threw = true; }
    eq(threw, true);
  });

  await test('encodeDnsQuery/decodeDnsQueries round-trip', async () => {
    const original = Buffer.from('secret payload for exfiltration via DNS');
    const queries = await call('src/dns-tunnel.mjs', 'encodeDnsQuery', [original, 'c2.test', {maxLabelLen: 16}]);
    const decoded = await call('src/dns-tunnel.mjs', 'decodeDnsQueries', [queries, 'c2.test']);
    eq(Buffer.from(decoded).toString(), original.toString());
  });

  await test('buildDnsPacket flags packed correctly', async () => {
    // QR=1, opcode=0, AA=1, TC=0, RD=1, RA=1, rcode=3
    // byte2 = (1<<7) | (0<<3) | (1<<2) | (0<<1) | 1 = 0x85
    // byte3 = (1<<7) | 3 = 0x83
    const pkt = await call('src/dns-tunnel.mjs', 'buildDnsPacket', [{
      id: 0x1234, qr: 1, opcode: 0, aa: 1, tc: 0, rd: 1, ra: 1, rcode: 3,
      questions: [{name: 'test'}], answers: [{name: 'test'}]
    }]);
    eq(pkt[2], 0x85);
    eq(pkt[3], 0x83);
  });

  await test('buildDnsPacket opcode in correct position', async () => {
    // opcode=2 (STATUS), rcode=0
    // byte2 = (0<<7) | (2<<3) | 0 | 0 | 1 = 0x11
    // byte3 = 0
    const pkt = await call('src/dns-tunnel.mjs', 'buildDnsPacket', [{
      id: 1, qr: 0, opcode: 2, aa: 0, tc: 0, rd: 1, ra: 0, rcode: 0,
      questions: [], answers: []
    }]);
    const opcode = (pkt[2] >> 3) & 0xF;
    eq(opcode, 2);
    const rcode = pkt[3] & 0xF;
    eq(rcode, 0);
  });

  await test('parseDnsResponse extracts rcode from packet', async () => {
    // Build a packet with rcode=5 (REFUSED)
    const pkt = await call('src/dns-tunnel.mjs', 'buildDnsPacket', [{
      id: 42, qr: 1, opcode: 0, aa: 0, tc: 0, rd: 0, ra: 0, rcode: 5,
      questions: [], answers: []
    }]);
    const parsed = await call('src/dns-tunnel.mjs', 'parseDnsResponse', [pkt]);
    eq(parsed.rcode, 5);
    eq(parsed.id, 42);
  });

  await test('parseDnsResponse round-trips with buildDnsPacket', async () => {
    const pkt = await call('src/dns-tunnel.mjs', 'buildDnsPacket', [{
      id: 0xBEEF, qr: 1, opcode: 0, aa: 1, tc: 0, rd: 1, ra: 1, rcode: 2,
      questions: [{q: 1}, {q: 2}], answers: [{a: 1}]
    }]);
    const parsed = await call('src/dns-tunnel.mjs', 'parseDnsResponse', [pkt]);
    eq(parsed.id, 0xBEEF);
    eq(parsed.qr, 1);
    eq(parsed.opcode, 0);
    eq(parsed.rcode, 2);
    eq(parsed.qdcount, 2);
    eq(parsed.ancount, 1);
  });

  // === covert.mjs ===

  await test('timingEncode bit=0 gives baseDelay, bit=1 gives baseDelay+bitDelay', async () => {
    const result = await call('src/covert.mjs', 'timingEncode', [[0, 1, 0, 1], {baseDelay: 100, bitDelay: 50}]);
    eq(result[0].delay, 100);   // bit=0 → baseDelay
    eq(result[1].delay, 150);   // bit=1 → baseDelay+bitDelay
    eq(result[2].delay, 100);   // bit=0
    eq(result[3].delay, 150);   // bit=1
  });

  await test('timingEncode cumulative is running sum', async () => {
    const result = await call('src/covert.mjs', 'timingEncode', [[0, 1, 1], {baseDelay: 100, bitDelay: 50}]);
    eq(result[0].cumulative, 100);
    eq(result[1].cumulative, 250);   // 100 + 150
    eq(result[2].cumulative, 400);   // 250 + 150
  });

  await test('timingDecode correctly decodes 1-bits', async () => {
    // bit=1 → delay=150, bit=0 → delay=100
    const delays = [150, 100, 150, 150, 100, 100, 100, 150];
    const result = await call('src/covert.mjs', 'timingDecode', [delays, {baseDelay: 100, bitDelay: 50}]);
    eq(result.bits[0], 1);
    eq(result.bits[1], 0);
    eq(result.bits[2], 1);
    eq(result.bits[3], 1);
    eq(result.bits[4], 0);
    eq(result.bits[5], 0);
    eq(result.bits[6], 0);
    eq(result.bits[7], 1);
  });

  await test('timingEncode/timingDecode round-trip', async () => {
    const bits = [1, 0, 1, 1, 0, 0, 1, 0];
    const encoded = await call('src/covert.mjs', 'timingEncode', [bits, {baseDelay: 200, bitDelay: 100}]);
    const delays = encoded.map(e => e.delay);
    const decoded = await call('src/covert.mjs', 'timingDecode', [delays, {baseDelay: 200, bitDelay: 100}]);
    for (let i = 0; i < bits.length; i++) {
      eq(decoded.bits[i], bits[i]);
    }
  });

  await test('timingDecode produces correct data Buffer', async () => {
    // byte 0xA5 = 10100101
    const bits = [1, 0, 1, 0, 0, 1, 0, 1];
    const encoded = await call('src/covert.mjs', 'timingEncode', [bits, {baseDelay: 50, bitDelay: 50}]);
    const delays = encoded.map(e => e.delay);
    const decoded = await call('src/covert.mjs', 'timingDecode', [delays, {baseDelay: 50, bitDelay: 50}]);
    eq(decoded.data[0], 0xA5);
  });

  await test('ipIdEncode applies startId offset', async () => {
    const data = Buffer.from([10, 20, 30]);
    const result = await call('src/covert.mjs', 'ipIdEncode', [data, {startId: 1000}]);
    eq(result[0].ipId, 1010);   // 1000 + 10
    eq(result[1].ipId, 1020);   // 1000 + 20
    eq(result[2].ipId, 1030);   // 1000 + 30
    eq(result[0].seqNum, 0);
    eq(result[1].seqNum, 1);
    eq(result[2].seqNum, 2);
  });

  await test('ipIdDecode subtracts startId', async () => {
    const ids = [{seqNum: 0, ipId: 1065}, {seqNum: 1, ipId: 1066}, {seqNum: 2, ipId: 1067}];
    const result = await call('src/covert.mjs', 'ipIdDecode', [ids, {startId: 1000}]);
    eq(result[0], 65);   // 'A'
    eq(result[1], 66);   // 'B'
    eq(result[2], 67);   // 'C'
  });

  await test('ipIdEncode/ipIdDecode round-trip', async () => {
    const data = Buffer.from('Hello');
    const encoded = await call('src/covert.mjs', 'ipIdEncode', [data, {startId: 500}]);
    const decoded = await call('src/covert.mjs', 'ipIdDecode', [encoded, {startId: 500}]);
    eq(Buffer.from(decoded).toString(), 'Hello');
  });

  await test('buildCovertPacket dispatches timing method', async () => {
    const result = await call('src/covert.mjs', 'buildCovertPacket', [Buffer.from([0xFF]), {method: 'timing'}]);
    // 0xFF = 11111111 → 8 entries, all with delay = baseDelay+bitDelay = 150
    eq(result.length, 8);
    eq(result[0].delay, 150);
  });

  await test('buildCovertPacket dispatches ipid method', async () => {
    const result = await call('src/covert.mjs', 'buildCovertPacket', [Buffer.from([65, 66]), {method: 'ipid'}]);
    // ipid method with startId=0 → {seqNum:0, ipId:65}, {seqNum:1, ipId:66}
    eq(result.length, 2);
    eq(result[0].ipId, 65);
    eq(result[1].ipId, 66);
    eq(result[0].seqNum, 0);
  });

  // === heartbeat.mjs ===

  await test('createAgent starts in dormant state', async () => {
    const agent = await call('src/heartbeat.mjs', 'createAgent', [{id: 'a1', interval: 5000, jitter: 1000, maxMissed: 3}]);
    eq(agent.state, 'dormant');
    eq(agent.id, 'a1');
    eq(agent.missedCount, 0);
    eq(agent.lastBeat, null);
    eq(agent.history.length, 0);
  });

  await test('activate requires dormant state', async () => {
    const agent = await call('src/heartbeat.mjs', 'createAgent', [{id: 'a2', interval: 5000, jitter: 1000, maxMissed: 3}]);
    const alive = await call('src/heartbeat.mjs', 'activate', [agent, {now: 1000}]);
    eq(alive.state, 'alive');

    // activating again from alive should throw
    let threw = false;
    try { await call('src/heartbeat.mjs', 'activate', [alive, {now: 2000}]); } catch { threw = true; }
    eq(threw, true);
  });

  await test('activate sets lastBeat', async () => {
    const agent = await call('src/heartbeat.mjs', 'createAgent', [{id: 'a3', interval: 5000, jitter: 1000, maxMissed: 3}]);
    const active = await call('src/heartbeat.mjs', 'activate', [agent, {now: 42000}]);
    eq(active.lastBeat, 42000);
  });

  await test('heartbeat resets missedCount to 0', async () => {
    const agent = await call('src/heartbeat.mjs', 'createAgent', [{id: 'a4', interval: 5000, jitter: 1000, maxMissed: 3}]);
    const active = await call('src/heartbeat.mjs', 'activate', [agent, {now: 1000}]);

    // Simulate a timeout to get missedCount > 0
    const timedOut = await call('src/heartbeat.mjs', 'checkTimeout', [active, {now: 20000}]);

    // Heartbeat should reset missedCount
    const beaten = await call('src/heartbeat.mjs', 'heartbeat', [timedOut, {now: 20001}]);
    eq(beaten.missedCount, 0);
    eq(beaten.lastBeat, 20001);
  });

  await test('heartbeat throws in dormant state', async () => {
    const agent = await call('src/heartbeat.mjs', 'createAgent', [{id: 'a5', interval: 5000, jitter: 1000, maxMissed: 3}]);
    let threw = false;
    try { await call('src/heartbeat.mjs', 'heartbeat', [agent, {now: 1000}]); } catch { threw = true; }
    eq(threw, true);
  });

  await test('checkTimeout increments missedCount when elapsed > interval+jitter', async () => {
    const agent = await call('src/heartbeat.mjs', 'createAgent', [{id: 'a6', interval: 5000, jitter: 1000, maxMissed: 3}]);
    const active = await call('src/heartbeat.mjs', 'activate', [agent, {now: 1000}]);

    // elapsed = 7001 > 5000+1000 = 6000
    const checked = await call('src/heartbeat.mjs', 'checkTimeout', [active, {now: 7001}]);
    eq(checked.missedCount, 1);
  });

  await test('checkTimeout transitions to dead after maxMissed', async () => {
    let agent = await call('src/heartbeat.mjs', 'createAgent', [{id: 'a7', interval: 100, jitter: 0, maxMissed: 2}]);
    agent = await call('src/heartbeat.mjs', 'activate', [agent, {now: 0}]);

    // First timeout
    agent = await call('src/heartbeat.mjs', 'checkTimeout', [agent, {now: 200}]);
    eq(agent.missedCount, 1);
    eq(agent.state, 'alive');

    // Second timeout → dead
    agent = await call('src/heartbeat.mjs', 'checkTimeout', [agent, {now: 400}]);
    eq(agent.missedCount, 2);
    eq(agent.state, 'dead');
  });

  await test('startExfil only from alive state', async () => {
    const agent = await call('src/heartbeat.mjs', 'createAgent', [{id: 'a8', interval: 5000, jitter: 1000, maxMissed: 3}]);

    // dormant → startExfil should throw
    let threw = false;
    try { await call('src/heartbeat.mjs', 'startExfil', [agent, {now: 1000}]); } catch { threw = true; }
    eq(threw, true);

    // alive → startExfil should work
    const active = await call('src/heartbeat.mjs', 'activate', [agent, {now: 1000}]);
    const exfil = await call('src/heartbeat.mjs', 'startExfil', [active, {now: 2000}]);
    eq(exfil.state, 'exfil');
  });

  await test('stopExfil transitions exfil to alive', async () => {
    let agent = await call('src/heartbeat.mjs', 'createAgent', [{id: 'a9', interval: 5000, jitter: 1000, maxMissed: 3}]);
    agent = await call('src/heartbeat.mjs', 'activate', [agent, {now: 1000}]);
    agent = await call('src/heartbeat.mjs', 'startExfil', [agent, {now: 2000}]);
    eq(agent.state, 'exfil');

    const stopped = await call('src/heartbeat.mjs', 'stopExfil', [agent, {now: 3000}]);
    eq(stopped.state, 'alive');
  });

  await test('nextBeatTime includes jitter', async () => {
    const agent = await call('src/heartbeat.mjs', 'createAgent', [{id: 'beat1', interval: 5000, jitter: 2000, maxMissed: 3}]);
    const active = await call('src/heartbeat.mjs', 'activate', [agent, {now: 10000}]);
    const nextBeat = await call('src/heartbeat.mjs', 'nextBeatTime', [active]);
    // Should be > lastBeat + interval (10000 + 5000 = 15000) because jitter > 0
    // jitter factor from id hash is non-zero for most ids
    eq(nextBeat > 15000, true);
    eq(nextBeat <= 17000, true);  // max = 15000 + 2000
  });

  await test('nextBeatTime is deterministic for same agent', async () => {
    const agent = await call('src/heartbeat.mjs', 'createAgent', [{id: 'det1', interval: 5000, jitter: 2000, maxMissed: 3}]);
    const active = await call('src/heartbeat.mjs', 'activate', [agent, {now: 10000}]);
    const t1 = await call('src/heartbeat.mjs', 'nextBeatTime', [active]);
    const t2 = await call('src/heartbeat.mjs', 'nextBeatTime', [active]);
    eq(t1, t2);
  });

  await test('getTimeline sorted ascending by timestamp', async () => {
    let agent = await call('src/heartbeat.mjs', 'createAgent', [{id: 'tl1', interval: 5000, jitter: 1000, maxMissed: 3}]);
    agent = await call('src/heartbeat.mjs', 'activate', [agent, {now: 1000}]);
    agent = await call('src/heartbeat.mjs', 'heartbeat', [agent, {now: 3000}]);
    agent = await call('src/heartbeat.mjs', 'startExfil', [agent, {now: 5000}]);
    agent = await call('src/heartbeat.mjs', 'stopExfil', [agent, {now: 7000}]);

    const timeline = await call('src/heartbeat.mjs', 'getTimeline', [agent]);
    eq(timeline.length, 4);
    // ascending: each timestamp should be <= the next
    for (let i = 0; i < timeline.length - 1; i++) {
      eq(timeline[i].timestamp <= timeline[i + 1].timestamp, true);
    }
    eq(timeline[0].timestamp, 1000);
    eq(timeline[3].timestamp, 7000);
  });

  await test('activate does not mutate input', async () => {
    const agent = await call('src/heartbeat.mjs', 'createAgent', [{id: 'imm1', interval: 5000, jitter: 1000, maxMissed: 3}]);
    const active = await call('src/heartbeat.mjs', 'activate', [agent, {now: 1000}]);
    eq(agent.state, 'dormant');
    eq(active.state, 'alive');
  });
}
