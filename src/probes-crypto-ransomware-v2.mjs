export async function runCryptoRansomwareV2Probes({call, test, eq}) {
  // === chacha.mjs ===

  await test('generateKey returns 64 hex chars (32 bytes)', async () => {
    const key = await call('src/chacha.mjs', 'generateKey', []);
    eq(typeof key, 'string');
    eq(key.length, 64);
    eq(/^[0-9a-f]{64}$/.test(key), true);
  });

  await test('generateKey returns different values each call', async () => {
    const k1 = await call('src/chacha.mjs', 'generateKey', []);
    const k2 = await call('src/chacha.mjs', 'generateKey', []);
    eq(k1 !== k2, true);
  });

  await test('encrypt returns object with iv, ciphertext, tag, aad', async () => {
    const key = 'a'.repeat(64);
    const env = await call('src/chacha.mjs', 'encrypt', ['hello', key, '']);
    eq(typeof env.iv, 'string');
    eq(typeof env.ciphertext, 'string');
    eq(typeof env.tag, 'string');
    eq('aad' in env, true);
  });

  await test('encrypt iv is 24 hex chars (12 bytes)', async () => {
    const key = 'ab'.repeat(32);
    const env = await call('src/chacha.mjs', 'encrypt', ['test', key, '']);
    eq(env.iv.length, 24);
  });

  await test('encrypt throws on short key', async () => {
    let threw = false;
    try { await call('src/chacha.mjs', 'encrypt', ['data', 'abcd', '']); } catch { threw = true; }
    eq(threw, true);
  });

  await test('decrypt reverses encrypt', async () => {
    const key = '0123456789abcdef'.repeat(4);
    const env = await call('src/chacha.mjs', 'encrypt', ['hello world', key, '']);
    const plain = await call('src/chacha.mjs', 'decrypt', [env, key]);
    eq(plain, 'hello world');
  });

  await test('decrypt throws on tampered ciphertext', async () => {
    const key = 'ff'.repeat(32);
    const env = await call('src/chacha.mjs', 'encrypt', ['secret', key, '']);
    const tampered = { ...env, ciphertext: '00'.repeat(env.ciphertext.length / 2) };
    let threw = false;
    try { await call('src/chacha.mjs', 'decrypt', [tampered, key]); } catch { threw = true; }
    eq(threw, true);
  });

  await test('encrypt/decrypt with AAD round-trips', async () => {
    const key = 'aa'.repeat(32);
    const env = await call('src/chacha.mjs', 'encrypt', ['payload', key, 'metadata']);
    eq(env.aad, 'metadata');
    const plain = await call('src/chacha.mjs', 'decrypt', [env, key]);
    eq(plain, 'payload');
  });

  await test('deriveKey is deterministic', async () => {
    const d1 = await call('src/chacha.mjs', 'deriveKey', ['password', 'salt', { iterations: 1000, keyLen: 32 }]);
    const d2 = await call('src/chacha.mjs', 'deriveKey', ['password', 'salt', { iterations: 1000, keyLen: 32 }]);
    eq(d1, d2);
  });

  await test('deriveKey uses sha256 not md5', async () => {
    // PBKDF2-SHA256('password', 'salt', 1000, 32) has a known output
    // PBKDF2-MD5 gives a different result. SHA-256 hex output is 64 chars.
    const derived = await call('src/chacha.mjs', 'deriveKey', ['password', 'salt', { iterations: 1000, keyLen: 32 }]);
    eq(derived.length, 64);
    // crypto.pbkdf2Sync('password', 'salt', 1000, 32, 'sha256').toString('hex')
    // starts with '632c2812'
    eq(derived.startsWith('632c2812'), true);
  });

  // === shamir.mjs ===

  await test('gf256Add is XOR', async () => {
    const r = await call('src/shamir.mjs', 'gf256Add', [0x53, 0xCA]);
    eq(r, 0x53 ^ 0xCA);
  });

  await test('gf256Mul known value: 0x53 * 0xCA = 0x01 in GF(256)', async () => {
    // 0x53 and 0xCA are multiplicative inverses in GF(256) with 0x11B
    const r = await call('src/shamir.mjs', 'gf256Mul', [0x53, 0xCA]);
    eq(r, 0x01);
  });

  await test('gf256Mul by zero is zero', async () => {
    const r = await call('src/shamir.mjs', 'gf256Mul', [0x57, 0]);
    eq(r, 0);
  });

  await test('gf256Mul by one is identity', async () => {
    const r = await call('src/shamir.mjs', 'gf256Mul', [0xAB, 1]);
    eq(r, 0xAB);
  });

  await test('gf256Mul is commutative', async () => {
    const r1 = await call('src/shamir.mjs', 'gf256Mul', [0x13, 0x07]);
    const r2 = await call('src/shamir.mjs', 'gf256Mul', [0x07, 0x13]);
    eq(r1, r2);
  });

  await test('gf256Inv: a * inv(a) = 1', async () => {
    const inv = await call('src/shamir.mjs', 'gf256Inv', [0x53]);
    const product = await call('src/shamir.mjs', 'gf256Mul', [0x53, inv]);
    eq(product, 1);
  });

  await test('gf256Inv(0) throws', async () => {
    let threw = false;
    try { await call('src/shamir.mjs', 'gf256Inv', [0]); } catch { threw = true; }
    eq(threw, true);
  });

  await test('split returns n shares with correct structure', async () => {
    const secret = Buffer.from([42, 99, 200]);
    const shares = await call('src/shamir.mjs', 'split', [secret, 5, 3]);
    eq(shares.length, 5);
    eq(typeof shares[0].x, 'number');
    eq(Buffer.isBuffer(shares[0].y) || shares[0].y.length === 3, true);
  });

  await test('reconstruct recovers secret with k shares', async () => {
    const secret = Buffer.from([42, 17, 255]);
    const shares = await call('src/shamir.mjs', 'split', [secret, 5, 3]);
    const recovered = await call('src/shamir.mjs', 'reconstruct', [shares.slice(0, 3), 3]);
    const recBuf = Buffer.from(recovered);
    eq(recBuf[0], 42);
    eq(recBuf[1], 17);
    eq(recBuf[2], 255);
  });

  await test('reconstruct with different k-subsets gives same result', async () => {
    const secret = Buffer.from([100, 200]);
    const shares = await call('src/shamir.mjs', 'split', [secret, 5, 3]);
    const r1 = await call('src/shamir.mjs', 'reconstruct', [[shares[0], shares[1], shares[2]], 3]);
    const r2 = await call('src/shamir.mjs', 'reconstruct', [[shares[2], shares[3], shares[4]], 3]);
    eq(Buffer.from(r1)[0], Buffer.from(r2)[0]);
    eq(Buffer.from(r1)[1], Buffer.from(r2)[1]);
  });

  await test('verifyShare true for valid, false for tampered', async () => {
    const secret = Buffer.from([77]);
    const shares = await call('src/shamir.mjs', 'split', [secret, 5, 3]);
    const valid = await call('src/shamir.mjs', 'verifyShare', [shares[0], shares, 3]);
    eq(valid, true);
    const tampered = { x: shares[0].x, y: Buffer.from([shares[0].y[0] ^ 0xFF]) };
    const invalid = await call('src/shamir.mjs', 'verifyShare', [tampered, shares, 3]);
    eq(invalid, false);
  });

  // === selective.mjs ===

  await test('classifyFile documents category', async () => {
    const r = await call('src/selective.mjs', 'classifyFile', ['report.docx']);
    eq(r.category, 'documents');
    eq(r.priority, 1);
  });

  await test('classifyFile handles uppercase extensions', async () => {
    const r = await call('src/selective.mjs', 'classifyFile', ['PHOTO.JPG']);
    eq(r.category, 'media');
    eq(r.priority, 3);
  });

  await test('classifyFile uses lastIndexOf for double-dot filenames', async () => {
    const r = await call('src/selective.mjs', 'classifyFile', ['archive.tar.gz']);
    eq(r.category, 'archive');
    eq(r.priority, 3);
  });

  await test('classifyFile unknown extension gets other/4', async () => {
    const r = await call('src/selective.mjs', 'classifyFile', ['readme.txt']);
    eq(r.category, 'other');
    eq(r.priority, 4);
  });

  await test('buildTargetList filters by maxSize', async () => {
    const files = [
      { name: 'small.docx', size: 100 },
      { name: 'big.pdf', size: 10000 },
      { name: 'medium.xls', size: 5000 }
    ];
    const result = await call('src/selective.mjs', 'buildTargetList', [files, { maxSize: 5000 }]);
    eq(result.length, 2);
    const names = result.map(f => f.name);
    eq(names.includes('big.pdf'), false);
  });

  await test('buildTargetList sorts priority ASC then size DESC', async () => {
    const files = [
      { name: 'photo.jpg', size: 5000 },
      { name: 'report.pdf', size: 1000 },
      { name: 'code.js', size: 3000 },
      { name: 'data.sql', size: 2000 }
    ];
    const result = await call('src/selective.mjs', 'buildTargetList', [files, {}]);
    // priority 1 (pdf, sql) should come before priority 2 (js), before priority 3 (jpg)
    eq(result[0].priority <= result[1].priority, true);
    eq(result[result.length - 2].priority <= result[result.length - 1].priority, true);
  });

  await test('buildTargetList applies skipPatterns', async () => {
    const files = [
      { name: 'report.docx', size: 100 },
      { name: 'temp_backup.docx', size: 200 },
      { name: 'data.sql', size: 300 }
    ];
    const result = await call('src/selective.mjs', 'buildTargetList', [files, { skipPatterns: ['temp_'] }]);
    eq(result.length, 2);
    eq(result.every(f => !f.name.includes('temp_')), true);
  });

  await test('encryptHeader only encrypts header portion', async () => {
    const key = 'ab'.repeat(32);
    const fileBytes = Buffer.alloc(8192, 0x41);
    const result = await call('src/selective.mjs', 'encryptHeader', [fileBytes, key, { headerSize: 4096 }]);
    eq(result.originalSize, 8192);
    eq(result.headerSize, 4096);
    // The encrypted data should correspond to only 4096 bytes, not full 8192
    // 4096 bytes hex-encoded = 8192 hex chars input to encrypt
    const ctBytes = result.encrypted.length / 2;
    eq(ctBytes <= 8192, true);
  });

  await test('generateManifest uses SHA-256 checksum', async () => {
    const files = [{ name: 'a.doc', size: 100, encrypted: true }];
    const manifest = await call('src/selective.mjs', 'generateManifest', [files]);
    eq(manifest.version, 1);
    eq(manifest.fileCount, 1);
    eq(manifest.totalSize, 100);
    // SHA-256 produces 64 hex chars, MD5 produces 32
    eq(manifest.checksum.length, 64);
  });

  await test('generateManifest totalSize sums correctly', async () => {
    const files = [
      { name: 'a.doc', size: 100, encrypted: true },
      { name: 'b.pdf', size: 250, encrypted: false },
      { name: 'c.sql', size: 50, encrypted: true }
    ];
    const manifest = await call('src/selective.mjs', 'generateManifest', [files]);
    eq(manifest.totalSize, 400);
    eq(manifest.fileCount, 3);
  });

  // === negotiate.mjs ===

  await test('createSession validates amount > 0', async () => {
    let threw = false;
    try {
      await call('src/negotiate.mjs', 'createSession', ['victim', { amount: -5, currency: 'BTC', deadline: '2026-01-01T00:00:00Z', now: '2025-01-01T00:00:00Z' }]);
    } catch { threw = true; }
    eq(threw, true);
  });

  await test('createSession validates currency', async () => {
    let threw = false;
    try {
      await call('src/negotiate.mjs', 'createSession', ['victim', { amount: 10, currency: 'USD', deadline: '2026-01-01T00:00:00Z', now: '2025-01-01T00:00:00Z' }]);
    } catch { threw = true; }
    eq(threw, true);
  });

  await test('createSession validates deadline > now', async () => {
    let threw = false;
    try {
      await call('src/negotiate.mjs', 'createSession', ['victim', { amount: 10, currency: 'BTC', deadline: '2024-01-01T00:00:00Z', now: '2025-01-01T00:00:00Z' }]);
    } catch { threw = true; }
    eq(threw, true);
  });

  await test('createSession returns valid session', async () => {
    const sess = await call('src/negotiate.mjs', 'createSession', ['victim-1', { amount: 5, currency: 'ETH', deadline: '2026-12-31T00:00:00Z', now: '2025-06-01T00:00:00Z' }]);
    eq(sess.state, 'initial');
    eq(sess.victimId, 'victim-1');
    eq(sess.amount, 5);
    eq(sess.currency, 'ETH');
    eq(Array.isArray(sess.history), true);
  });

  await test('demand only from initial state', async () => {
    const sess = await call('src/negotiate.mjs', 'createSession', ['v', { amount: 1, currency: 'BTC', deadline: '2026-01-01T00:00:00Z', now: '2025-01-01T00:00:00Z' }]);
    const demanded = await call('src/negotiate.mjs', 'demand', [sess, { now: '2025-01-02T00:00:00Z' }]);
    eq(demanded.state, 'demanded');
    // demanding again from demanded should throw
    let threw = false;
    try { await call('src/negotiate.mjs', 'demand', [demanded, { now: '2025-01-03T00:00:00Z' }]); } catch { threw = true; }
    eq(threw, true);
  });

  await test('negotiate rejects escalation', async () => {
    const sess = await call('src/negotiate.mjs', 'createSession', ['v', { amount: 10, currency: 'BTC', deadline: '2026-01-01T00:00:00Z', now: '2025-01-01T00:00:00Z' }]);
    const demanded = await call('src/negotiate.mjs', 'demand', [sess, { now: '2025-01-02T00:00:00Z' }]);
    let threw = false;
    try { await call('src/negotiate.mjs', 'negotiate', [demanded, { counterOffer: 15, now: '2025-01-03T00:00:00Z' }]); } catch { threw = true; }
    eq(threw, true);
  });

  await test('negotiate accepts lower counter-offer', async () => {
    const sess = await call('src/negotiate.mjs', 'createSession', ['v', { amount: 10, currency: 'BTC', deadline: '2026-01-01T00:00:00Z', now: '2025-01-01T00:00:00Z' }]);
    const demanded = await call('src/negotiate.mjs', 'demand', [sess, { now: '2025-01-02T00:00:00Z' }]);
    const negotiated = await call('src/negotiate.mjs', 'negotiate', [demanded, { counterOffer: 5, now: '2025-01-03T00:00:00Z' }]);
    eq(negotiated.state, 'negotiating');
    eq(negotiated.amount, 5);
  });

  await test('pay validates txHash non-empty', async () => {
    const sess = await call('src/negotiate.mjs', 'createSession', ['v', { amount: 10, currency: 'XMR', deadline: '2026-01-01T00:00:00Z', now: '2025-01-01T00:00:00Z' }]);
    const demanded = await call('src/negotiate.mjs', 'demand', [sess, { now: '2025-01-02T00:00:00Z' }]);
    let threw = false;
    try { await call('src/negotiate.mjs', 'pay', [demanded, { txHash: '', now: '2025-01-03T00:00:00Z' }]); } catch { threw = true; }
    eq(threw, true);
  });

  await test('pay only from demanded or negotiating', async () => {
    const sess = await call('src/negotiate.mjs', 'createSession', ['v', { amount: 10, currency: 'BTC', deadline: '2026-01-01T00:00:00Z', now: '2025-01-01T00:00:00Z' }]);
    let threw = false;
    try { await call('src/negotiate.mjs', 'pay', [sess, { txHash: 'abc123', now: '2025-01-02T00:00:00Z' }]); } catch { threw = true; }
    eq(threw, true);
  });

  await test('expire checks deadline', async () => {
    const sess = await call('src/negotiate.mjs', 'createSession', ['v', { amount: 10, currency: 'BTC', deadline: '2026-01-01T00:00:00Z', now: '2025-01-01T00:00:00Z' }]);
    const demanded = await call('src/negotiate.mjs', 'demand', [sess, { now: '2025-01-02T00:00:00Z' }]);
    // expiring before deadline should throw
    let threw = false;
    try { await call('src/negotiate.mjs', 'expire', [demanded, { now: '2025-06-01T00:00:00Z' }]); } catch { threw = true; }
    eq(threw, true);
    // expiring after deadline should work
    const expired = await call('src/negotiate.mjs', 'expire', [demanded, { now: '2027-01-01T00:00:00Z' }]);
    eq(expired.state, 'expired');
  });

  await test('decrypt only from paid state', async () => {
    const sess = await call('src/negotiate.mjs', 'createSession', ['v', { amount: 10, currency: 'BTC', deadline: '2026-01-01T00:00:00Z', now: '2025-01-01T00:00:00Z' }]);
    // decrypt from initial should throw
    let threw = false;
    try { await call('src/negotiate.mjs', 'decrypt', [sess]); } catch { threw = true; }
    eq(threw, true);
    // full path to decrypted
    const demanded = await call('src/negotiate.mjs', 'demand', [sess, { now: '2025-01-02T00:00:00Z' }]);
    const paid = await call('src/negotiate.mjs', 'pay', [demanded, { txHash: 'tx_abc', now: '2025-01-03T00:00:00Z' }]);
    const decrypted = await call('src/negotiate.mjs', 'decrypt', [paid]);
    eq(decrypted.state, 'decrypted');
  });

  await test('getTimeline sorted by timestamp', async () => {
    const sess = await call('src/negotiate.mjs', 'createSession', ['v', { amount: 10, currency: 'BTC', deadline: '2026-01-01T00:00:00Z', now: '2025-01-01T00:00:00Z' }]);
    const s1 = await call('src/negotiate.mjs', 'demand', [sess, { now: '2025-03-01T00:00:00Z' }]);
    const s2 = await call('src/negotiate.mjs', 'negotiate', [s1, { counterOffer: 5, now: '2025-04-01T00:00:00Z' }]);
    const s3 = await call('src/negotiate.mjs', 'pay', [s2, { txHash: 'hash123', now: '2025-05-01T00:00:00Z' }]);
    const timeline = await call('src/negotiate.mjs', 'getTimeline', [s3]);
    eq(timeline.length, 3);
    eq(new Date(timeline[0].timestamp) <= new Date(timeline[1].timestamp), true);
    eq(new Date(timeline[1].timestamp) <= new Date(timeline[2].timestamp), true);
  });
}
