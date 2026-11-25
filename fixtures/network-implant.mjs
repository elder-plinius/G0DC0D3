export const networkImplantFixture = {
  "id": "network-implant",
  "version": 1,
  "title": "Network protocol simulation: TCP/UDP/ICMP packet crafting, DNS tunneling, covert channels, and heartbeat state machine",
  "description": "Repair four cooperating modules for a network protocol simulation framework used in security research training: TCP/UDP/ICMP packet header construction with internet checksums, DNS tunneling with hex-encoded payloads and sequence-numbered queries, covert channel encoding via timing delays and IP ID fields, and an implant heartbeat state machine with timeout detection. All operations are pure data transformations — no actual network connections or system compromise.",
  "checkType": "network-implant",
  "objective": "Repair all modules in src/ for a network protocol simulation framework. Implement TCP/UDP/ICMP packet header construction as Uint8Array with correct big-endian byte layout and RFC 1071 internet checksum. Implement DNS tunneling with hex-encoded data chunked into DNS query labels with 4-digit zero-padded sequence numbers, and reassembly with numeric sorting and contiguity validation. Implement covert channel encoding via timing delays and IP ID field steganography with proper offsets. Implement a heartbeat state machine with states dormant→alive→exfil→dead, timeout detection, missed-beat counting, and deterministic jitter. All operations produce data structures — no actual network traffic. Preserve public exports.",
  "constraints": [
    "Never mutate input arrays, Uint8Arrays, or state objects — return new objects.",
    "All multi-byte header fields must be big-endian.",
    "Internet checksum must fold carries repeatedly per RFC 1071.",
    "DNS labels must respect the maxLabelLen parameter.",
    "State machine transitions must be validated — invalid transitions must throw.",
    "Preserve existing test files and package.json scripts.test unchanged."
  ],
  "files": {
    "package.json": "{\n  \"name\": \"fixture-network-implant\",\n  \"private\": true,\n  \"type\": \"module\",\n  \"scripts\": {\n    \"test\": \"node test/smoke.mjs\"\n  }\n}\n",
    "src/packet.mjs": `// TCP/UDP/ICMP packet header construction

export function buildTcpHeader({srcPort, dstPort, seqNum = 0, ackNum = 0, flags = 0, windowSize = 65535, urgent = 0}) {
  if (srcPort < 0 || srcPort > 65535) throw new Error('srcPort out of range');
  if (dstPort < 0 || dstPort > 65535) throw new Error('dstPort out of range');

  const header = new Uint8Array(20);

  // BUG: ports written little-endian instead of big-endian
  header[0] = srcPort & 0xFF;
  header[1] = (srcPort >> 8) & 0xFF;
  header[2] = dstPort & 0xFF;
  header[3] = (dstPort >> 8) & 0xFF;

  // seqNum (4 bytes big-endian)
  header[4] = (seqNum >>> 24) & 0xFF;
  header[5] = (seqNum >>> 16) & 0xFF;
  header[6] = (seqNum >>> 8) & 0xFF;
  header[7] = seqNum & 0xFF;

  // ackNum (4 bytes big-endian)
  header[8] = (ackNum >>> 24) & 0xFF;
  header[9] = (ackNum >>> 16) & 0xFF;
  header[10] = (ackNum >>> 8) & 0xFF;
  header[11] = ackNum & 0xFF;

  // BUG: dataOffset in low nibble instead of high nibble (writes 0x05 instead of 0x50)
  header[12] = 5;

  // BUG: flags written to byte 12 instead of byte 13
  header[12] = flags;

  // windowSize (big-endian)
  header[14] = (windowSize >> 8) & 0xFF;
  header[15] = windowSize & 0xFF;

  // checksum = 0
  header[16] = 0;
  header[17] = 0;

  // urgent pointer
  header[18] = (urgent >> 8) & 0xFF;
  header[19] = urgent & 0xFF;

  return header;
}

export function buildUdpHeader({srcPort, dstPort, payload}) {
  const header = new Uint8Array(8);

  // srcPort big-endian
  header[0] = (srcPort >> 8) & 0xFF;
  header[1] = srcPort & 0xFF;

  // dstPort big-endian
  header[2] = (dstPort >> 8) & 0xFF;
  header[3] = dstPort & 0xFF;

  // BUG: length = payload.length, missing the 8-byte header size
  const length = payload.length;
  header[4] = (length >> 8) & 0xFF;
  header[5] = length & 0xFF;

  // checksum = 0
  header[6] = 0;
  header[7] = 0;

  return header;
}

export function buildIcmpEchoRequest({id, seq, payload = new Uint8Array(0)}) {
  const packet = new Uint8Array(8 + payload.length);

  // BUG: type set to 0 (echo reply) instead of 8 (echo request)
  packet[0] = 0;
  packet[1] = 0; // code

  // checksum placeholder
  packet[2] = 0;
  packet[3] = 0;

  // id big-endian
  packet[4] = (id >> 8) & 0xFF;
  packet[5] = id & 0xFF;

  // seq big-endian
  packet[6] = (seq >> 8) & 0xFF;
  packet[7] = seq & 0xFF;

  // copy payload
  for (let i = 0; i < payload.length; i++) {
    packet[8 + i] = payload[i];
  }

  // compute checksum over entire packet
  const cksum = internetChecksum(packet);
  packet[2] = (cksum >> 8) & 0xFF;
  packet[3] = cksum & 0xFF;

  return packet;
}

export function parseFlags(flagByte) {
  // BUG: all masks shifted left by 1 bit
  return {
    FIN: !!(flagByte & 0x02),  // should be 0x01
    SYN: !!(flagByte & 0x04),  // should be 0x02
    RST: !!(flagByte & 0x08),  // should be 0x04
    PSH: !!(flagByte & 0x10),  // should be 0x08
    ACK: !!(flagByte & 0x20),  // should be 0x10
    URG: !!(flagByte & 0x40),  // should be 0x20
    ECE: !!(flagByte & 0x80),  // should be 0x40
    CWR: !!(flagByte & 0x100), // should be 0x80 — always false since byte max is 0xFF
  };
}

export function internetChecksum(bytes) {
  let sum = 0;
  const len = bytes.length;

  for (let i = 0; i < len - 1; i += 2) {
    sum += (bytes[i] << 8) | bytes[i + 1];
  }

  // handle odd byte
  if (len % 2 !== 0) {
    sum += bytes[len - 1] << 8;
  }

  // BUG: no carry fold loop — just one's complement without folding
  return (~sum) & 0xFFFF;
}
`,
    "src/dns-tunnel.mjs": `// DNS tunneling via hex-encoded payloads in query labels

export function encodeDnsQuery(data, domain, {maxLabelLen = 63} = {}) {
  if (!domain || typeof domain !== 'string') throw new Error('domain required');

  const buf = (data instanceof Uint8Array || Buffer.isBuffer(data))
    ? data
    : Buffer.from(data);

  const hex = Buffer.from(buf).toString('hex');
  const chunks = [];

  for (let i = 0; i < hex.length; i += maxLabelLen) {
    chunks.push(hex.slice(i, i + maxLabelLen));
  }

  if (chunks.length === 0) chunks.push('');

  // BUG: seqNum not zero-padded — uses String(i) instead of padStart(4, '0')
  return chunks.map((chunk, i) => \`\${String(i)}.\${chunk}.\${domain}\`);
}

export function decodeDnsQueries(queries, domain) {
  if (!Array.isArray(queries) || queries.length === 0) {
    throw new Error('queries must be a non-empty array');
  }

  const suffix = '.' + domain;
  const parsed = queries.map(q => {
    if (!q.endsWith(suffix)) throw new Error('query does not match domain');
    const withoutDomain = q.slice(0, -suffix.length);
    const dotIdx = withoutDomain.indexOf('.');
    if (dotIdx === -1) throw new Error('malformed query');
    const seqNum = withoutDomain.slice(0, dotIdx);
    const chunk = withoutDomain.slice(dotIdx + 1);
    return {seqNum, chunk};
  });

  // BUG: sort is alphabetic/lexicographic, not numeric
  parsed.sort((a, b) => (a.seqNum < b.seqNum ? -1 : a.seqNum > b.seqNum ? 1 : 0));

  // BUG: no contiguity validation — should check 0,1,2,...,n-1

  const hexStr = parsed.map(p => p.chunk).join('');
  return Buffer.from(hexStr, 'hex');
}

export function buildDnsPacket({id, qr = 0, opcode = 0, aa = 0, tc = 0, rd = 1, ra = 0, rcode = 0, questions = [], answers = []}) {
  const packet = new Uint8Array(12);

  // id big-endian
  packet[0] = (id >> 8) & 0xFF;
  packet[1] = id & 0xFF;

  // BUG: opcode and rcode positions are swapped
  // Correct: QR(bit15) OPCODE(bits14-11) AA(bit10) TC(bit9) RD(bit8) | RA(bit7) Z(bits6-4) RCODE(bits3-0)
  // Buggy:  QR(bit15) RCODE(bits14-11) AA(bit10) TC(bit9) RD(bit8) | RA(bit7) Z(bits6-4) OPCODE(bits3-0)
  const byte2 = ((qr & 1) << 7) | ((rcode & 0xF) << 3) | ((aa & 1) << 2) | ((tc & 1) << 1) | (rd & 1);
  const byte3 = ((ra & 1) << 7) | (opcode & 0xF);
  packet[2] = byte2;
  packet[3] = byte3;

  // QDCOUNT
  packet[4] = (questions.length >> 8) & 0xFF;
  packet[5] = questions.length & 0xFF;

  // ANCOUNT
  packet[6] = (answers.length >> 8) & 0xFF;
  packet[7] = answers.length & 0xFF;

  // NSCOUNT = 0, ARCOUNT = 0
  return packet;
}

export function parseDnsResponse(packet) {
  if (packet.length < 12) throw new Error('packet too short');

  const id = (packet[0] << 8) | packet[1];
  const byte2 = packet[2];
  const byte3 = packet[3];

  const qr = (byte2 >> 7) & 1;
  const opcode = (byte2 >> 3) & 0xF;
  const qdcount = (packet[4] << 8) | packet[5];
  const ancount = (packet[6] << 8) | packet[7];

  // BUG: rcode hardcoded to 0 instead of extracting from byte3
  return {id, qr, opcode, rcode: 0, qdcount, ancount};
}
`,
    "src/covert.mjs": `// Covert channel encoding — timing delays and IP ID steganography

export function timingEncode(bits, {baseDelay, bitDelay}) {
  if (!Array.isArray(bits)) throw new Error('bits must be an array');
  if (typeof baseDelay !== 'number' || typeof bitDelay !== 'number') {
    throw new Error('baseDelay and bitDelay required');
  }

  let cumulative = 0;
  return bits.map(bit => {
    // BUG: always uses baseDelay regardless of bit value
    const delay = baseDelay;
    cumulative += delay;
    return {bit, delay, cumulative};
  });
}

export function timingDecode(delays, {baseDelay, bitDelay, tolerance = 5}) {
  if (!Array.isArray(delays)) throw new Error('delays must be an array');

  const threshold = baseDelay + bitDelay / 2;
  let errors = 0;

  // BUG: always decodes as 0 — ignores the threshold comparison
  const bits = delays.map(d => {
    const diff = Math.abs(d - baseDelay);
    if (diff > tolerance && Math.abs(d - (baseDelay + bitDelay)) > tolerance) {
      errors++;
    }
    return 0;
  });

  // convert bits to bytes (MSB first)
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) {
      byte = (byte << 1) | bits[i + j];
    }
    bytes.push(byte);
  }

  return {bits, errors, data: Buffer.from(bytes)};
}

export function ipIdEncode(data, {startId}) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const result = [];

  for (let i = 0; i < buf.length; i++) {
    // BUG: no startId offset applied — just uses byte value directly
    result.push({seqNum: i, ipId: buf[i]});
  }

  return result;
}

export function ipIdDecode(ids, {startId}) {
  // sort by seqNum
  const sorted = [...ids].sort((a, b) => a.seqNum - b.seqNum);

  // BUG: doesn't subtract startId
  const bytes = sorted.map(entry => entry.ipId);
  return Buffer.from(bytes);
}

export function buildCovertPacket(payload, {method}) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);

  // BUG: ignores method parameter, always uses timing
  const bits = [];
  for (let i = 0; i < buf.length; i++) {
    for (let j = 7; j >= 0; j--) {
      bits.push((buf[i] >> j) & 1);
    }
  }
  return timingEncode(bits, {baseDelay: 100, bitDelay: 50});
}
`,
    "src/heartbeat.mjs": `// Heartbeat state machine for implant simulation

export function createAgent({id, interval, jitter, maxMissed}) {
  if (!id || typeof id !== 'string') throw new Error('id must be a non-empty string');
  if (typeof interval !== 'number' || interval <= 0) throw new Error('interval must be positive');
  if (typeof jitter !== 'number' || jitter < 0) throw new Error('jitter must be non-negative');
  if (typeof maxMissed !== 'number' || maxMissed < 1) throw new Error('maxMissed must be >= 1');

  return {
    id,
    // BUG: starts 'alive' instead of 'dormant'
    state: 'alive',
    interval,
    jitter,
    maxMissed,
    lastBeat: null,
    missedCount: 0,
    history: []
  };
}

export function activate(agent, {now}) {
  // BUG: no state check — allows activation from any state
  return {
    ...agent,
    state: 'alive',
    lastBeat: now,
    history: [...agent.history, {action: 'activate', timestamp: now, from: agent.state, to: 'alive'}]
  };
}

export function heartbeat(agent, {now}) {
  if (agent.state !== 'alive' && agent.state !== 'exfil') {
    throw new Error(\`Cannot heartbeat in state: \${agent.state}\`);
  }

  return {
    ...agent,
    lastBeat: now,
    // BUG: missedCount not reset to 0
    history: [...agent.history, {action: 'heartbeat', timestamp: now, state: agent.state}]
  };
}

export function checkTimeout(agent, {now}) {
  if (agent.lastBeat === null) return {...agent};

  const elapsed = now - agent.lastBeat;
  const threshold = agent.interval + agent.jitter;
  let newState = agent.state;
  let missedCount = agent.missedCount;

  // BUG: uses < instead of > for comparison
  // BUG: doesn't increment missedCount
  if (elapsed < threshold) {
    // should be: if (elapsed > threshold) { missedCount++; ... }
    if (missedCount >= agent.maxMissed) {
      newState = 'dead';
    }
  }

  return {
    ...agent,
    state: newState,
    missedCount
  };
}

export function startExfil(agent, {now}) {
  // BUG: allows transition from any state, not just 'alive'
  return {
    ...agent,
    state: 'exfil',
    history: [...agent.history, {action: 'startExfil', timestamp: now, from: agent.state, to: 'exfil'}]
  };
}

export function stopExfil(agent, {now}) {
  if (agent.state !== 'exfil') {
    throw new Error(\`Cannot stop exfil in state: \${agent.state}\`);
  }

  return {
    ...agent,
    state: 'alive',
    history: [...agent.history, {action: 'stopExfil', timestamp: now, from: 'exfil', to: 'alive'}]
  };
}

export function nextBeatTime(agent) {
  if (agent.lastBeat === null) throw new Error('No lastBeat set');

  // BUG: no jitter added — returns lastBeat + interval only
  return agent.lastBeat + agent.interval;
}

export function getTimeline(agent) {
  const sorted = [...agent.history];
  // BUG: sorts descending instead of ascending
  sorted.sort((a, b) => b.timestamp - a.timestamp);
  return sorted;
}
`,
    "src/index.mjs": `export { buildTcpHeader, buildUdpHeader, buildIcmpEchoRequest, parseFlags, internetChecksum } from './packet.mjs';
export { encodeDnsQuery, decodeDnsQueries, buildDnsPacket, parseDnsResponse } from './dns-tunnel.mjs';
export { timingEncode, timingDecode, ipIdEncode, ipIdDecode, buildCovertPacket } from './covert.mjs';
export { createAgent, activate, heartbeat, checkTimeout, startExfil, stopExfil, nextBeatTime, getTimeline } from './heartbeat.mjs';
`,
    "test/smoke.mjs": `import assert from 'node:assert/strict';
import { buildTcpHeader, encodeDnsQuery, timingEncode, createAgent } from '../src/index.mjs';

const tcp = buildTcpHeader({srcPort: 1234, dstPort: 80});
assert.ok(tcp instanceof Uint8Array);
assert.equal(tcp.length, 20);

const queries = encodeDnsQuery(Buffer.from('test'), 'c2.example.com');
assert.ok(Array.isArray(queries));
assert.ok(queries.length >= 1);

const timing = timingEncode([1, 0, 1], {baseDelay: 100, bitDelay: 50});
assert.equal(timing.length, 3);

const agent = createAgent({id: 'test-01', interval: 5000, jitter: 1000, maxMissed: 3});
assert.equal(agent.id, 'test-01');

console.log('Network implant smoke passed; independent probes cover packets, DNS tunneling, covert channels, and heartbeat.');
`,
    "README.md": `# Network Protocol Simulation — Security Research Training

Repair these four modules for a network protocol simulation framework used in security research and penetration testing training. All operations are pure data transformations — no actual network connections, no actual implants, no system compromise. Uses only built-in Node.js modules. Preserve all public exports and test files.

## Packet crafting (src/packet.mjs)

Exports buildTcpHeader(options), buildUdpHeader(options), buildIcmpEchoRequest(options), parseFlags(flagByte), internetChecksum(bytes).

### buildTcpHeader({srcPort, dstPort, seqNum, ackNum, flags, windowSize, urgent})

Build a 20-byte Uint8Array TCP header. All multi-byte fields are big-endian.

Byte layout:
- Bytes 0-1: srcPort (16-bit big-endian). srcPort 0x3039 → byte[0]=0x30, byte[1]=0x39.
- Bytes 2-3: dstPort (16-bit big-endian).
- Bytes 4-7: seqNum (32-bit big-endian, default 0).
- Bytes 8-11: ackNum (32-bit big-endian, default 0).
- Byte 12: high nibble = data offset (always 5 for 20-byte header, so value = 0x50), low nibble = reserved.
- Byte 13: flags byte. FIN=0x01, SYN=0x02, RST=0x04, PSH=0x08, ACK=0x10, URG=0x20, ECE=0x40, CWR=0x80.
- Bytes 14-15: windowSize (16-bit big-endian, default 65535).
- Bytes 16-17: checksum (0).
- Bytes 18-19: urgent pointer (16-bit big-endian, default 0).

Validate: srcPort and dstPort must be integers 0-65535. Return the Uint8Array.

### buildUdpHeader({srcPort, dstPort, payload})

Build an 8-byte Uint8Array UDP header.

Byte layout:
- Bytes 0-1: srcPort (16-bit big-endian).
- Bytes 2-3: dstPort (16-bit big-endian).
- Bytes 4-5: length (16-bit big-endian) = 8 + payload.length (total UDP datagram length INCLUDING the 8-byte header).
- Bytes 6-7: checksum (0).

Validate ports 0-65535.

### buildIcmpEchoRequest({id, seq, payload})

Build an ICMP echo request packet as a Uint8Array. payload defaults to empty Uint8Array.

Byte layout:
- Byte 0: type = 8 (echo request — NOT 0, which is echo reply).
- Byte 1: code = 0.
- Bytes 2-3: checksum (computed over the entire ICMP message).
- Bytes 4-5: id (16-bit big-endian).
- Bytes 6-7: seq (16-bit big-endian).
- Bytes 8+: payload data.

Checksum computation: set checksum bytes to 0 first, compute internetChecksum over the entire packet (header + payload), then write the result into bytes 2-3. When internetChecksum is called on the complete packet (with checksum filled in), it should return 0.

### parseFlags(flagByte)

Parse a TCP flags byte into an object with boolean fields. Takes a single byte (0-255).

Return object with fields: {FIN, SYN, RST, PSH, ACK, URG, ECE, CWR}.

Flag masks (standard TCP flag positions):
- FIN = 0x01 (bit 0)
- SYN = 0x02 (bit 1)
- RST = 0x04 (bit 2)
- PSH = 0x08 (bit 3)
- ACK = 0x10 (bit 4)
- URG = 0x20 (bit 5)
- ECE = 0x40 (bit 6)
- CWR = 0x80 (bit 7)

Each field = !!(flagByte & mask).

### internetChecksum(bytes)

RFC 1071 internet checksum over a Uint8Array.

Algorithm:
1. Sum all 16-bit big-endian words from the buffer.
2. If the buffer has odd length, pad the last byte with 0x00 to form a final 16-bit word.
3. Fold carries repeatedly: while sum > 0xFFFF, add carry (sum >> 16) to lower 16 bits (sum & 0xFFFF).
4. Return one's complement: (~sum) & 0xFFFF.

The carry folding is critical — without it, large sums produce incorrect checksums. The fold must repeat until no carry remains (a single fold is insufficient when the addition itself produces a carry).

## DNS tunneling (src/dns-tunnel.mjs)

Exports encodeDnsQuery(data, domain, options), decodeDnsQueries(queries, domain), buildDnsPacket(options), parseDnsResponse(packet).

### encodeDnsQuery(data, domain, {maxLabelLen=63}={})

Hex-encode the data buffer, split the hex string into chunks of at most maxLabelLen characters, prefix each chunk with a 4-digit zero-padded sequence number, and format as DNS query strings.

Steps:
1. Convert data to Buffer if needed, then to hex string.
2. Split hex string into chunks of maxLabelLen characters.
3. For each chunk at index i, construct: \`\${String(i).padStart(4, '0')}.\${chunk}.\${domain}\`
4. Return array of query strings.

The 4-digit zero-padded sequence number ensures correct reassembly when sorted. Without zero-padding, sequence "10" sorts before "2" in lexicographic order.

### decodeDnsQueries(queries, domain)

Parse DNS query strings, extract sequence-numbered chunks, sort numerically, validate contiguity, and decode.

Steps:
1. For each query, strip the \`.\${domain}\` suffix.
2. Split the remainder on the first '.' to get seqNum (string) and chunk.
3. Sort by seqNum NUMERICALLY (parseInt), not lexicographically.
4. Validate contiguity: sequence must be 0, 1, 2, ..., n-1 with no gaps. Throw if a gap is found.
5. Concatenate chunks in order.
6. Hex-decode the concatenated string to Buffer.

### buildDnsPacket({id, qr, opcode, aa, tc, rd, ra, rcode, questions, answers})

Build a 12-byte DNS header Uint8Array. Defaults: qr=0, opcode=0, aa=0, tc=0, rd=1, ra=0, rcode=0, questions=[], answers=[].

Byte layout (all big-endian):
- Bytes 0-1: id (16-bit).
- Byte 2: QR(bit7) | OPCODE(bits6-3) | AA(bit2) | TC(bit1) | RD(bit0).
  Computed as: ((qr & 1) << 7) | ((opcode & 0xF) << 3) | ((aa & 1) << 2) | ((tc & 1) << 1) | (rd & 1)
- Byte 3: RA(bit7) | Z(bits6-4, always 0) | RCODE(bits3-0).
  Computed as: ((ra & 1) << 7) | (rcode & 0xF)
- Bytes 4-5: QDCOUNT = questions.length.
- Bytes 6-7: ANCOUNT = answers.length.
- Bytes 8-9: NSCOUNT = 0.
- Bytes 10-11: ARCOUNT = 0.

### parseDnsResponse(packet)

Parse a DNS packet Uint8Array (at least 12 bytes). Extract fields from the header.

Return: {id, qr, opcode, rcode, qdcount, ancount}.

- id: bytes 0-1 as 16-bit big-endian.
- qr: bit 7 of byte 2.
- opcode: bits 6-3 of byte 2.
- rcode: bits 3-0 of byte 3 (NOT hardcoded to 0 — must actually extract from the packet).
- qdcount: bytes 4-5 as 16-bit big-endian.
- ancount: bytes 6-7 as 16-bit big-endian.

## Covert channels (src/covert.mjs)

Exports timingEncode(bits, options), timingDecode(delays, options), ipIdEncode(data, options), ipIdDecode(ids, options), buildCovertPacket(payload, options).

### timingEncode(bits, {baseDelay, bitDelay})

Encode an array of bit values (0 or 1) into timing delays.

For each bit:
- bit=0 → delay = baseDelay (ms)
- bit=1 → delay = baseDelay + bitDelay (ms)

Return array of {bit, delay, cumulative} where cumulative is the running sum of all delays up to and including the current one.

### timingDecode(delays, {baseDelay, bitDelay, tolerance=5})

Decode an array of delay values (milliseconds) back to bits.

For each delay d:
- If d > baseDelay + bitDelay/2 → bit = 1
- Else → bit = 0

An error is counted when the delay is outside tolerance of both baseDelay and baseDelay+bitDelay.

Return {bits: array, errors: count, data: Buffer from bits (8 bits per byte, MSB first)}.

### ipIdEncode(data, {startId})

Encode each byte of a data Buffer into an IP ID field value.

For each byte at index i with value v: ipId = startId + v.

Return array of {seqNum: i, ipId: startId + v}.

### ipIdDecode(ids, {startId})

Decode IP ID field values back to data bytes.

Sort by seqNum. For each entry: byte = ipId - startId.

Return Buffer.

### buildCovertPacket(payload, {method})

Dispatch to the appropriate encoder based on the method string:
- 'timing': convert payload bytes to bits (MSB first), call timingEncode with baseDelay=100, bitDelay=50.
- 'ipid': call ipIdEncode with startId=0.

Throw on unknown method.

## Heartbeat state machine (src/heartbeat.mjs)

Exports createAgent(options), activate(agent, options), heartbeat(agent, options), checkTimeout(agent, options), startExfil(agent, options), stopExfil(agent, options), nextBeatTime(agent), getTimeline(agent).

### State diagram

dormant → (activate) → alive → (startExfil) → exfil → (stopExfil) → alive
alive → (heartbeat) → alive (self-loop, updates lastBeat)
exfil → (heartbeat) → exfil (self-loop, updates lastBeat)
alive|exfil → (checkTimeout, missedCount >= maxMissed) → dead
dead is terminal — no transitions out.

### createAgent({id, interval, jitter, maxMissed})

Validate:
- id: non-empty string.
- interval: positive number (milliseconds between beats).
- jitter: non-negative number (ms of jitter range).
- maxMissed: integer >= 1.

Return {id, state: 'dormant', interval, jitter, maxMissed, lastBeat: null, missedCount: 0, history: []}.

### activate(agent, {now})

Transition dormant → alive. Set lastBeat = now. Append to history: {action: 'activate', timestamp: now, from: 'dormant', to: 'alive'}. Throw if agent.state !== 'dormant'. Never mutate input — return new object.

### heartbeat(agent, {now})

Update lastBeat = now and reset missedCount = 0. Throw if state is not 'alive' or 'exfil'. Append to history. Return new object.

### checkTimeout(agent, {now})

If lastBeat is null, return agent copy unchanged. Calculate elapsed = now - lastBeat. If elapsed > interval + jitter, increment missedCount. If missedCount >= maxMissed, set state to 'dead'. Return new object.

### startExfil(agent, {now})

Transition alive → exfil. Throw if state !== 'alive'. Append to history. Return new object.

### stopExfil(agent, {now})

Transition exfil → alive. Throw if state !== 'exfil'. Append to history. Return new object.

### nextBeatTime(agent)

Calculate next expected beat time. Throw if lastBeat is null.

Compute deterministic jitter: use a simple hash of agent.id to produce a consistent jitter factor between 0 and 1, then multiply by the jitter parameter.

Return: lastBeat + interval + (jitterFactor * jitter).

Example jitter hash: sum all char codes of agent.id, take modulo 1000, divide by 1000. This gives a repeatable fraction.

### getTimeline(agent)

Return a COPY of agent.history sorted by timestamp in ascending order (earliest first).

## Barrel (src/index.mjs)

Re-exports all named public functions from all four modules.

## Bugs in current implementation

- packet.mjs: buildTcpHeader writes ports in little-endian instead of big-endian; dataOffset written to low nibble of byte 12 (0x05) then immediately overwritten by flags (should be high nibble 0x50 in byte 12, flags in byte 13); buildUdpHeader length field is payload.length instead of 8+payload.length; buildIcmpEchoRequest sets type=0 (echo reply) instead of type=8 (echo request); parseFlags masks are all shifted left by 1 bit (FIN=0x02 instead of 0x01, etc.); internetChecksum doesn't fold carries (large sums wrap incorrectly)
- dns-tunnel.mjs: encodeDnsQuery doesn't zero-pad sequence numbers (uses String(i) not padStart(4,'0')); decodeDnsQueries sorts lexicographically not numerically (sequence "10" before "2"); decodeDnsQueries doesn't validate contiguity of sequence numbers; buildDnsPacket swaps opcode and rcode bit positions in the flags field; parseDnsResponse hardcodes rcode to 0 instead of extracting from packet
- covert.mjs: timingEncode uses fixed baseDelay for all bits ignoring bitDelay for 1-bits; timingDecode always decodes every delay as 0; ipIdEncode doesn't apply startId offset; ipIdDecode doesn't subtract startId; buildCovertPacket ignores method parameter and always uses timing encoding
- heartbeat.mjs: createAgent starts in 'alive' state instead of 'dormant'; activate doesn't check current state (allows activation from any state); heartbeat doesn't reset missedCount to 0; checkTimeout uses < instead of > for elapsed comparison and doesn't increment missedCount; startExfil allows transition from any state not just 'alive'; nextBeatTime omits jitter from calculation; getTimeline sorts descending instead of ascending
`
  }
};
