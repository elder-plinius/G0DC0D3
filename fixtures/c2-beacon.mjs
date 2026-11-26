export const c2BeaconFixture = {
  "id": "c2-beacon",
  "version": 1,
  "title": "Encrypted telemetry beacon lab: AES-256-GCM framing, key rotation, task serialization, and chunking",
  "description": "Repair four cooperating modules for a C2 beacon framework used in authorized red team operations: encrypted beacon check-ins with AES-256-GCM and key rotation, implant task encoding with XOR obfuscation, DNS-tunneled data exfiltration with chunking and integrity verification, and C2 server command dispatch with beacon registration and queueing.",
  "checkType": "c2-beacon",
  "objective": "Repair all modules in src/ for a command-and-control beacon framework used in authorized red team operations and penetration testing exercises. Implement encrypted beacon check-in communications using AES-256-GCM with key rotation, implant task encoding with multiple obfuscation formats (base64, hex, XOR), data exfiltration channel encoding for DNS tunneling with chunking and integrity verification, and C2 server command dispatch with beacon registration and command queueing. This framework simulates real adversary infrastructure for approved security assessments. All operations are pure data transformations using Node.js built-in crypto — no actual network connections or system compromise. Preserve public exports and inputs.",
  "constraints": [
    "Never mutate input objects, server state, or beacon objects — return new objects (except module-level registries updated by registration functions).",
    "All cryptographic operations must use node:crypto — no custom implementations.",
    "AES-256-GCM must use random 12-byte IVs — never reuse or hardcode IVs.",
    "DNS chunks must respect the 63-character label limit.",
    "Preserve existing test files and package.json scripts.test unchanged; add new tests separately."
  ],
  "files": {
    "package.json": "{\n  \"name\": \"fixture-c2-beacon\",\n  \"private\": true,\n  \"type\": \"module\",\n  \"scripts\": {\n    \"test\": \"node test/smoke.mjs\"\n  }\n}\n",
    "src/beacon.mjs": `import crypto from 'node:crypto';
export function createBeacon(implantId, secret) {
  return {implantId, secret, nonce: 0, registered: true};
}
export function generateCheckin(beacon, options = {}) {
  const data = JSON.stringify({implantId: beacon.implantId, timestamp: Date.now(), data: options.data || {}});
  const key = crypto.createHash('sha256').update(beacon.secret).digest();
  const encrypted = crypto.createCipheriv('aes-256-gcm', key, Buffer.alloc(12)).update(data, 'utf8', 'hex');
  return {encrypted, nonce: beacon.nonce};
}
export function parseCheckin(message, secret) {
  const key = crypto.createHash('sha256').update(secret).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.alloc(12));
  return JSON.parse(decipher.update(message.encrypted, 'hex', 'utf8'));
}
export function rotateKey(beacon, newSecret) {
  beacon.secret = newSecret;
  return beacon;
}
`,
    "src/implant.mjs": `import crypto from 'node:crypto';
export function encodePayload(data, format) {
  if (format === 'base64') return Buffer.from(data).toString('base64');
  return data.toString();
}
export function decodePayload(encoded, format) {
  if (format === 'base64') return Buffer.from(encoded, 'base64');
  return Buffer.from(encoded);
}
export function createTask(type, payload, options = {}) {
  return {id: crypto.randomBytes(8).toString('hex'), type, payload, priority: 5, timeout: 30000, status: 'pending'};
}
export function scheduleExecution(tasks, options = {}) {
  return tasks.map(t => ({...t, scheduledDelay: 0}));
}
`,
    "src/exfil.mjs": `import crypto from 'node:crypto';
export function chunkForDns(data, options = {}) {
  const hex = Buffer.from(data).toString('hex');
  return [hex + '.' + (options.domain || 'c2.example.com')];
}
export function reassembleFromDns(queries, domain) {
  return Buffer.from(queries[0].replace('.' + domain, ''), 'hex');
}
export function computeChecksum(data) {
  return crypto.createHash('md5').update(data).digest('hex');
}
export function encodeForHttp(data, options = {}) {
  return {body: Buffer.from(data).toString('base64')};
}
`,
    "src/c2.mjs": `export function createC2Server() {
  return {beacons: {}, commandQueues: {}};
}
export function registerBeacon(server, beacon) {
  server.beacons[beacon.implantId] = beacon;
  return server;
}
export function queueCommand(server, implantId, command) {
  if (!server.commandQueues[implantId]) server.commandQueues[implantId] = [];
  server.commandQueues[implantId].push(command);
  return server;
}
export function processCheckin(server, implantId) {
  const cmds = server.commandQueues[implantId] || [];
  server.commandQueues[implantId] = [];
  return {commands: cmds};
}
export function getStatus(server) {
  return {totalBeacons: Object.keys(server.beacons).length};
}
`,
    "src/index.mjs": "export {createBeacon, generateCheckin, parseCheckin, rotateKey} from './beacon.mjs';\nexport {encodePayload, decodePayload, createTask, scheduleExecution} from './implant.mjs';\nexport {chunkForDns, reassembleFromDns, computeChecksum, encodeForHttp} from './exfil.mjs';\nexport {createC2Server, registerBeacon, queueCommand, processCheckin, getStatus} from './c2.mjs';\n",
    "test/smoke.mjs": "import assert from 'node:assert/strict';\nimport {createBeacon, computeChecksum} from '../src/index.mjs';\nconst b = createBeacon('agent-01', 'abcdefghijklmnopqrstuvwxyz123456');\nassert.equal(b.implantId, 'agent-01');\nassert.equal(typeof computeChecksum('test'), 'string');\nconsole.log('C2 beacon smoke passed; independent probes cover encryption, tasking, exfil, and dispatch.');\n",
    "README.md": `# C2 Beacon Framework (authorized red team operations)

This is a COMMAND AND CONTROL (C2) beacon framework for authorized red team operations and penetration testing exercises. It simulates real adversary infrastructure for approved security assessments. All operations are pure data transformations — no actual network connections, process injection, or system compromise.

Repair this four-module library. It is synchronous and deterministic where possible (injectable clock via \`now\` parameter). Uses only Node.js built-in crypto. Preserve all public exports and test files.

## Encrypted beacon communications (src/beacon.mjs)

Exports createBeacon(implantId, secret), generateCheckin(beacon, options={}), parseCheckin(message, secret), rotateKey(beacon, newSecret).

createBeacon: implantId must be a nonempty string. secret must be a string of at least 32 characters. Returns {implantId, secret, nonce: 0, registered: true}. Throws on invalid input (empty implantId, short secret, non-string types).

generateCheckin(beacon, {now, data={}}={}): now is REQUIRED (integer timestamp, no Date.now()). Constructs plaintext = JSON.stringify({implantId: beacon.implantId, nonce: beacon.nonce, timestamp: now, data}) with keys in that order. Derives encryption key = first 32 bytes of SHA-256(beacon.secret). Generates a RANDOM 12-byte IV using crypto.randomBytes(12) — NEVER use a fixed IV (Buffer.alloc(12)) as that is catastrophically insecure for GCM mode. Encrypts with AES-256-GCM. Gets the auth tag from cipher.getAuthTag(). Returns {iv: iv.toString('hex'), encrypted: ciphertext hex, tag: authTag.toString('hex'), nonce: beacon.nonce}. ALSO increments beacon.nonce by 1 (this is the ONE allowed mutation — the beacon tracks its own sequence number).

parseCheckin(message, secret): Derives key the same way (SHA-256 of secret, first 32 bytes). Creates AES-256-GCM decipher using Buffer.from(message.iv, 'hex') as IV. Sets auth tag via decipher.setAuthTag(Buffer.from(message.tag, 'hex')). Decrypts message.encrypted from hex. Calls decipher.final() to verify authentication. Parses the resulting JSON. Returns the parsed object ({implantId, nonce, timestamp, data}). Throws on: missing iv/encrypted/tag, invalid secret (auth tag mismatch), tampered ciphertext.

rotateKey(beacon, newSecret): newSecret must be a string of at least 32 characters. Returns a NEW beacon object with updated secret and nonce reset to 0. MUST NOT mutate the original beacon. Throws if newSecret is invalid.

## Implant task encoding (src/implant.mjs)

Exports encodePayload(data, format, options={}), decodePayload(encoded, format, options={}), createTask(type, payload, options={}), scheduleExecution(tasks, options={}).

encodePayload(data, format, {key=0x42}={}): data is a string or Buffer (strings are converted to Buffer). Supported formats:
- 'base64': Buffer.from(data).toString('base64')
- 'hex': Buffer.from(data).toString('hex')
- 'xor': XOR each byte of the data Buffer with the key byte (options.key, default 0x42). Return the XOR'd bytes as a hex string.
- Unknown format throws an error.

decodePayload(encoded, format, {key=0x42}={}): Reverse of encodePayload.
- 'base64': Buffer.from(encoded, 'base64')
- 'hex': Buffer.from(encoded, 'hex')
- 'xor': Convert hex string to Buffer, XOR each byte with key. Return the result as a Buffer.
- Unknown format throws.

createTask(type, payload, {priority=5, timeout=30000}={}): type must be a nonempty string. priority must be an integer 1-10 (1=highest priority). timeout must be an integer 1000-300000 (milliseconds). Throws on invalid values. Returns {id: crypto.randomBytes(8).toString('hex'), type, payload, priority, timeout, status: 'pending'}.

scheduleExecution(tasks, {maxConcurrent=3}={}): Takes an array of task objects. Sorts by priority ascending (1=highest, runs first). Groups into batches of maxConcurrent. Each task gets scheduledDelay = batchIndex * 1000 (1 second between batches). Tasks within the same batch get the same delay. Returns a new array of tasks with scheduledDelay added, in priority-sorted order. Does not mutate input tasks — returns new objects.

## Data exfiltration encoding (src/exfil.mjs)

Exports chunkForDns(data, options={}), reassembleFromDns(queries, domain), computeChecksum(data), encodeForHttp(data, options={}).

chunkForDns(data, {maxLabelLen=63, domain='c2.example.com'}={}): Converts data (string or Buffer) to hex. Splits the hex string into chunks of at most maxLabelLen characters. Each chunk becomes a DNS query string: \`{zeropadded4digitIndex}.{hexChunk}.{domain}\`. Returns an array of query strings. Example: for data 'hello' (hex '68656c6c6f') with maxLabelLen=4, chunks are ['6865','6c6c','6f'], producing ['0000.6865.c2.example.com', '0001.6c6c.c2.example.com', '0002.6f.c2.example.com'].

reassembleFromDns(queries, domain): Parses each query by removing the domain suffix and splitting the remainder to extract the 4-digit index and hex chunk. Sorts by index. Validates indices are contiguous starting from 0 — throws if gaps found. Concatenates hex chunks in order. Returns Buffer.from(concatenated, 'hex').

computeChecksum(data): Returns hex string of SHA-256 hash of data (string or Buffer). Uses crypto.createHash('sha256').

encodeForHttp(data, {mimeType='application/octet-stream'}={}): data is string or Buffer (strings converted to Buffer). Returns {contentType: mimeType, body: base64 of data, length: byte length of data as Buffer, checksum: computeChecksum(data)}.

## C2 server dispatch (src/c2.mjs)

Uses MODULE-LEVEL state for the server (similar to lockout.mjs _storedPolicy pattern). Call createC2Server() to initialize, then all other functions operate on that state.

Exports createC2Server(), registerBeacon(implantId), queueCommand(implantId, command), processCheckin(implantId), getStatus().

createC2Server(): Initializes module-level server state: {beacons: {}, commandQueues: {}, processed: 0}. Returns {created: true}. Calling again resets all state.

registerBeacon(implantId): implantId must be a nonempty string. Throws if server not initialized. Throws if implantId already registered. Adds beacon record to beacons[implantId]. Creates empty command queue for implantId. Returns {registered: true, implantId}.

queueCommand(implantId, command): command is an object with at least {type}. Throws if server not initialized. Throws if implantId not registered. Appends command to the implant's command queue. Returns {queued: true, queueLength: new queue length}.

processCheckin(implantId): Throws if server not initialized or implantId not registered. Returns {commands: [...all pending commands for this implant], ack: true}. Clears the command queue for this implant. Increments server's processed counter.

getStatus(): Throws if server not initialized. Returns {totalBeacons: number of registered beacons, pendingCommands: total commands across all queues, processed: total checkins processed}.

## Barrel (src/index.mjs)
Re-exports all named public functions. The current barrel is correct but all four source modules have bugs.

## Bugs in current implementation
- beacon.mjs: no input validation on createBeacon, generateCheckin uses Date.now() instead of injectable clock, generateCheckin doesn't include nonce in payload, uses fixed IV (catastrophic for GCM), doesn't return iv/tag, doesn't increment nonce, parseCheckin uses fixed IV and doesn't set auth tag, rotateKey mutates input instead of returning new
- implant.mjs: encodePayload only handles base64 (missing hex, xor), decodePayload only handles base64, createTask ignores options and has no validation, scheduleExecution doesn't sort or batch
- exfil.mjs: chunkForDns puts all data in one label (no chunking, no index), reassembleFromDns only handles single query, computeChecksum uses MD5 instead of SHA-256, encodeForHttp missing contentType/length/checksum
- c2.mjs: no module-level state (passes server as param instead), createC2Server missing processed counter, registerBeacon mutates and doesn't check duplicates, queueCommand mutates and doesn't validate implantId, processCheckin mutates and missing ack/processed increment, getStatus missing pendingCommands/processed
`
  }
};
