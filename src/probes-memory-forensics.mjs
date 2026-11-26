export async function runMemoryForensicsProbes({call, test, eq}) {
  // === Region parsing ===
  await test('parseRegion parses standard maps line', async () => {
    const r = await call('src/regions.mjs', 'parseRegion', ['00400000-00401000 r-xp 00000000 08:01 123456 /usr/bin/test']);
    eq(r.start, 0x400000);
    eq(r.end, 0x401000);
    eq(r.size, 0x1000);
    eq(r.perms.r, true);
    eq(r.perms.w, false);
    eq(r.perms.x, true);
    eq(r.perms.p, true);
    eq(r.path, '/usr/bin/test');
  });

  await test('parseRegion permission order is rwxp not xwr', async () => {
    const r = await call('src/regions.mjs', 'parseRegion', ['7f000000-7f001000 rw-p 00000000 00:00 0 [heap]']);
    eq(r.perms.r, true);
    eq(r.perms.w, true);
    eq(r.perms.x, false);
  });

  await test('parseRegion r--p permissions', async () => {
    const r = await call('src/regions.mjs', 'parseRegion', ['10000000-10001000 r--p 00000000 00:00 0 ']);
    eq(r.perms.r, true);
    eq(r.perms.w, false);
    eq(r.perms.x, false);
  });

  await test('parseRegion ---p permissions', async () => {
    const r = await call('src/regions.mjs', 'parseRegion', ['20000000-20001000 ---p 00000000 00:00 0 ']);
    eq(r.perms.r, false);
    eq(r.perms.w, false);
    eq(r.perms.x, false);
  });

  await test('parseRegion rejects invalid line', async () => {
    let threw = false;
    try { await call('src/regions.mjs', 'parseRegion', ['not a valid line']); } catch { threw = true; }
    eq(threw, true);
  });

  await test('classifyRegion identifies stack', async () => {
    const r = { path: '[stack]', perms: { r: true, w: true, x: false } };
    const type = await call('src/regions.mjs', 'classifyRegion', [r]);
    eq(type, 'stack');
  });

  await test('classifyRegion identifies code', async () => {
    const r = { path: '/usr/lib/libc.so', perms: { r: true, w: false, x: true } };
    const type = await call('src/regions.mjs', 'classifyRegion', [r]);
    eq(type, 'code');
  });

  await test('classifyRegion identifies anonymous', async () => {
    const r = { path: '', perms: { r: true, w: true, x: false } };
    const type = await call('src/regions.mjs', 'classifyRegion', [r]);
    eq(type, 'anonymous');
  });

  await test('permBits encodes correctly', async () => {
    eq(await call('src/regions.mjs', 'permBits', [{r: true, w: true, x: true}]), 7);
    eq(await call('src/regions.mjs', 'permBits', [{r: true, w: false, x: true}]), 5);
    eq(await call('src/regions.mjs', 'permBits', [{r: true, w: true, x: false}]), 6);
    eq(await call('src/regions.mjs', 'permBits', [{r: false, w: false, x: false}]), 0);
  });

  await test('fromPermBits reverses permBits', async () => {
    const p = await call('src/regions.mjs', 'fromPermBits', [5]);
    eq(p.r, true);
    eq(p.w, false);
    eq(p.x, true);
  });

  await test('findOverlaps detects overlapping regions', async () => {
    const regions = [
      { start: 0, end: 100 },
      { start: 50, end: 150 },
      { start: 200, end: 300 }
    ];
    const overlaps = await call('src/regions.mjs', 'findOverlaps', [regions]);
    eq(overlaps.length, 1);
    eq(overlaps[0][0], 0);
    eq(overlaps[0][1], 1);
  });

  // === Heap chunk parsing ===
  await test('parseChunk reads size with flag bits cleared', async () => {
    const buf = Buffer.alloc(16);
    buf.writeUInt32LE(0, 0);
    buf.writeUInt32LE(0x23, 4);
    const chunk = await call('src/heap.mjs', 'parseChunk', [buf]);
    eq(chunk.size, 0x20);
    eq(chunk.flags.prevInuse, true);
    eq(chunk.flags.isMmapped, true);
    eq(chunk.flags.nonMainArena, false);
  });

  await test('parseChunk clears all three flag bits', async () => {
    const buf = Buffer.alloc(16);
    buf.writeUInt32LE(0, 0);
    buf.writeUInt32LE(0x47, 4);
    const chunk = await call('src/heap.mjs', 'parseChunk', [buf]);
    eq(chunk.size, 0x40);
    eq(chunk.flags.prevInuse, true);
    eq(chunk.flags.isMmapped, true);
    eq(chunk.flags.nonMainArena, true);
  });

  await test('parseChunk size without flags', async () => {
    const buf = Buffer.alloc(16);
    buf.writeUInt32LE(0, 0);
    buf.writeUInt32LE(0x30, 4);
    const chunk = await call('src/heap.mjs', 'parseChunk', [buf]);
    eq(chunk.size, 0x30);
    eq(chunk.flags.prevInuse, false);
  });

  await test('parseChunk throws on small buffer', async () => {
    let threw = false;
    try { await call('src/heap.mjs', 'parseChunk', [Buffer.alloc(8)]); } catch { threw = true; }
    eq(threw, true);
  });

  await test('walkChunks walks consecutive chunks', async () => {
    const buf = Buffer.alloc(64);
    buf.writeUInt32LE(0, 0); buf.writeUInt32LE(32, 4);
    buf.writeUInt32LE(0, 32); buf.writeUInt32LE(32, 36);
    const chunks = await call('src/heap.mjs', 'walkChunks', [buf]);
    eq(chunks.length, 2);
    eq(chunks[0].offset, 0);
    eq(chunks[1].offset, 32);
  });

  await test('walkChunks stops on zero size', async () => {
    const buf = Buffer.alloc(32);
    buf.writeUInt32LE(0, 0); buf.writeUInt32LE(16, 4);
    buf.writeUInt32LE(0, 16); buf.writeUInt32LE(0, 20);
    const chunks = await call('src/heap.mjs', 'walkChunks', [buf]);
    eq(chunks.length, 1);
  });

  await test('parseFreeChunk reads fd/bk as little-endian', async () => {
    const buf = Buffer.alloc(24);
    buf.writeUInt32LE(0, 0);
    buf.writeUInt32LE(32, 4);
    buf.writeUInt32LE(0x12345678, 8);
    buf.writeUInt32LE(0xABCDEF01, 12);
    const chunk = await call('src/heap.mjs', 'parseFreeChunk', [buf]);
    eq(chunk.fd, 0x12345678);
    eq(chunk.bk, 0xABCDEF01);
    eq(chunk.isFree, true);
  });

  await test('parseFreeChunk fd/bk not big-endian', async () => {
    const buf = Buffer.alloc(24);
    buf.writeUInt32LE(0, 0);
    buf.writeUInt32LE(32, 4);
    buf.writeUInt32LE(0x01020304, 8);
    const chunk = await call('src/heap.mjs', 'parseFreeChunk', [buf]);
    eq(chunk.fd, 0x01020304);
    if (chunk.fd === buf.readUInt32BE(8)) throw new Error('fd should be little-endian, not big-endian');
  });

  await test('detectDoubleFree finds duplicates', async () => {
    const freeList = [
      { offset: 100 }, { offset: 200 }, { offset: 100 }
    ];
    const doubles = await call('src/heap.mjs', 'detectDoubleFree', [freeList]);
    eq(doubles.length, 1);
    eq(doubles[0], 100);
  });

  // === Pattern scanning ===
  await test('boyerMooreSearch finds all occurrences', async () => {
    const haystack = Buffer.from('abcabcabc');
    const needle = Buffer.from('abc');
    const matches = await call('src/scanner.mjs', 'boyerMooreSearch', [haystack, needle]);
    eq(matches.length, 3);
    eq(matches[0], 0);
    eq(matches[1], 3);
    eq(matches[2], 6);
  });

  await test('boyerMooreSearch finds match at end', async () => {
    const haystack = Buffer.from('xxxy');
    const needle = Buffer.from('xy');
    const matches = await call('src/scanner.mjs', 'boyerMooreSearch', [haystack, needle]);
    eq(matches.length, 1);
    eq(matches[0], 2);
  });

  await test('boyerMooreSearch empty needle returns empty', async () => {
    const matches = await call('src/scanner.mjs', 'boyerMooreSearch', [Buffer.from('test'), Buffer.alloc(0)]);
    eq(matches.length, 0);
  });

  await test('boyerMooreSearch single byte pattern', async () => {
    const haystack = Buffer.from([1, 2, 1, 3, 1]);
    const needle = Buffer.from([1]);
    const matches = await call('src/scanner.mjs', 'boyerMooreSearch', [haystack, needle]);
    eq(matches.length, 3);
    eq(matches[0], 0);
    eq(matches[1], 2);
    eq(matches[2], 4);
  });

  await test('hexPatternSearch with wildcards', async () => {
    const haystack = Buffer.from([0x48, 0x8b, 0xAA, 0xBB, 0x89]);
    const matches = await call('src/scanner.mjs', 'hexPatternSearch', [haystack, '48 8b ?? ?? 89']);
    eq(matches.length, 1);
    eq(matches[0], 0);
  });

  await test('hexPatternSearch no match', async () => {
    const haystack = Buffer.from([0x48, 0x8b, 0xAA]);
    const matches = await call('src/scanner.mjs', 'hexPatternSearch', [haystack, '48 8b ?? ?? 89']);
    eq(matches.length, 0);
  });

  await test('multiPatternSearch finds multiple patterns', async () => {
    const haystack = Buffer.from([1, 2, 3, 4, 5, 1, 2]);
    const patterns = { 'pat1': Buffer.from([1, 2]), 'pat2': Buffer.from([4, 5]) };
    const results = await call('src/scanner.mjs', 'multiPatternSearch', [haystack, patterns]);
    eq(results.pat1.length, 2);
    eq(results.pat2.length, 1);
  });

  await test('extractIpAddresses finds plausible IPs', async () => {
    const buf = Buffer.from([192, 168, 1, 1, 0, 0, 10, 0, 0, 1]);
    const ips = await call('src/scanner.mjs', 'extractIpAddresses', [buf]);
    eq(ips.length >= 1, true);
    eq(ips[0].ip, '192.168.1.1');
  });

  await test('extractUrls finds http URLs', async () => {
    const buf = Buffer.from('visit http://evil.com/payload and https://c2.attacker.io/exfil end');
    const urls = await call('src/scanner.mjs', 'extractUrls', [buf]);
    eq(urls.length, 2);
  });

  // === Artifact reconstruction ===
  await test('reassembleTcpStream sorts and concatenates', async () => {
    const frags = [
      { seq: 200, data: Buffer.from(' world') },
      { seq: 100, data: Buffer.from('hello') }
    ];
    const result = await call('src/reconstruct.mjs', 'reassembleTcpStream', [frags]);
    eq(Buffer.from(result).toString(), 'hello world');
  });

  await test('reassembleTcpStream handles wrap-around', async () => {
    const frags = [
      { seq: 0xFFFFFFF0, data: Buffer.from('first') },
      { seq: 5, data: Buffer.from('second') }
    ];
    const result = await call('src/reconstruct.mjs', 'reassembleTcpStream', [frags]);
    eq(Buffer.from(result).toString(), 'firstsecond');
  });

  await test('findByMagic finds all occurrences including last position', async () => {
    const buf = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0x89, 0x50, 0x4E, 0x47]);
    const magic = Buffer.from([0x89, 0x50, 0x4E, 0x47]);
    const positions = await call('src/reconstruct.mjs', 'findByMagic', [buf, magic]);
    eq(positions.length, 2);
    eq(positions[0], 0);
    eq(positions[1], 5);
  });

  await test('findByMagic finds match at exact end', async () => {
    const buf = Buffer.from([0x00, 0x01, 0x02]);
    const magic = Buffer.from([0x01, 0x02]);
    const positions = await call('src/reconstruct.mjs', 'findByMagic', [buf, magic]);
    eq(positions.length, 1);
    eq(positions[0], 1);
  });

  await test('extractFile returns new buffer not slice', async () => {
    const buf = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const extracted = await call('src/reconstruct.mjs', 'extractFile', [buf, 2, 4]);
    eq(extracted.length, 4);
    eq(extracted[0], 3);
    eq(extracted[3], 6);
  });

  await test('buildTimeline sorts by timestamp', async () => {
    const artifacts = [
      { name: 'c', timestamp: 300 },
      { name: 'a', timestamp: 100 },
      { name: 'b', timestamp: 200 }
    ];
    const tl = await call('src/reconstruct.mjs', 'buildTimeline', [artifacts]);
    eq(tl[0].name, 'a');
    eq(tl[1].name, 'b');
    eq(tl[2].name, 'c');
  });

  await test('hashFragment returns SHA-256 hex', async () => {
    const h = await call('src/reconstruct.mjs', 'hashFragment', [Buffer.from('test')]);
    eq(h, '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');
  });

  // === Cross-module integration ===
  await test('Parse region → scan heap → find artifacts', async () => {
    const r = await call('src/regions.mjs', 'parseRegion', ['00600000-00601000 rw-p 00000000 00:00 0 [heap]']);
    eq(await call('src/regions.mjs', 'classifyRegion', [r]), 'heap');

    const heapBuf = Buffer.alloc(48);
    heapBuf.writeUInt32LE(0, 0); heapBuf.writeUInt32LE(48, 4);
    heapBuf[16] = 0x89; heapBuf[17] = 0x50; heapBuf[18] = 0x4E; heapBuf[19] = 0x47;

    const chunks = await call('src/heap.mjs', 'walkChunks', [heapBuf]);
    eq(chunks.length, 1);

    const pngMagic = Buffer.from([0x89, 0x50, 0x4E, 0x47]);
    const found = await call('src/reconstruct.mjs', 'findByMagic', [heapBuf, pngMagic]);
    eq(found.length, 1);
    eq(found[0], 16);
  });
}
