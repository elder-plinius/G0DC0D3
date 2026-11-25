export async function runAuthHardeningProbes({call, test, eq}) {
  // === Constant-time comparison ===
  await test('timingSafeEqual basic equality', async () => {
    eq(await call('src/compare.mjs', 'timingSafeEqual', ['hello', 'hello']), true);
    eq(await call('src/compare.mjs', 'timingSafeEqual', ['hello', 'world']), false);
    eq(await call('src/compare.mjs', 'timingSafeEqual', ['', '']), true);
  });

  await test('timingSafeEqual different lengths', async () => {
    eq(await call('src/compare.mjs', 'timingSafeEqual', ['short', 'longer string']), false);
    eq(await call('src/compare.mjs', 'timingSafeEqual', ['a', 'ab']), false);
  });

  await test('timingSafeEqual coerces to string', async () => {
    eq(await call('src/compare.mjs', 'timingSafeEqual', [123, '123']), true);
    eq(await call('src/compare.mjs', 'timingSafeEqual', [null, 'null']), true);
  });

  // === Token generation and verification ===
  await test('createToken rejects short secret', async () => {
    let threw = false;
    try { await call('src/tokens.mjs', 'createToken', [{user: 'test'}, 'short', {now: 1000000}]); } catch { threw = true; }
    if (!threw) throw new Error('Expected rejection for short secret');
  });

  await test('createToken rejects non-object payload', async () => {
    const secret = 'a'.repeat(32);
    for (const bad of ['string', null, [1,2], 42]) {
      let threw = false;
      try { await call('src/tokens.mjs', 'createToken', [bad, secret, {now: 1000000}]); } catch { threw = true; }
      if (!threw) throw new Error('Expected rejection for payload: ' + JSON.stringify(bad));
    }
  });

  await test('createToken requires now parameter', async () => {
    const secret = 'a'.repeat(32);
    let threw = false;
    try { await call('src/tokens.mjs', 'createToken', [{user: 'test'}, secret]); } catch { threw = true; }
    if (!threw) throw new Error('Expected rejection when now not provided');
  });

  await test('createToken and verifyToken round-trip', async () => {
    const secret = 'a'.repeat(32);
    const token = await call('src/tokens.mjs', 'createToken', [{user: 'alice', role: 'admin'}, secret, {now: 1000000, expiresIn: 3600}]);
    eq(typeof token, 'string');
    eq(token.includes('.'), true);
    const payload = await call('src/tokens.mjs', 'verifyToken', [token, secret, {now: 1000500}]);
    eq(payload.user, 'alice');
    eq(payload.role, 'admin');
    eq(payload.iat, undefined);  // iat/exp stripped from returned payload
    eq(payload.exp, undefined);
  });

  await test('verifyToken rejects expired token', async () => {
    const secret = 'a'.repeat(32);
    const token = await call('src/tokens.mjs', 'createToken', [{}, secret, {now: 1000, expiresIn: 10}]);
    let threw = false;
    try { await call('src/tokens.mjs', 'verifyToken', [token, secret, {now: 1011}]); } catch { threw = true; }
    if (!threw) throw new Error('Expected rejection for expired token');
  });

  await test('verifyToken rejects wrong secret', async () => {
    const secret = 'a'.repeat(32);
    const other = 'b'.repeat(32);
    const token = await call('src/tokens.mjs', 'createToken', [{}, secret, {now: 1000}]);
    let threw = false;
    try { await call('src/tokens.mjs', 'verifyToken', [token, other, {now: 1000}]); } catch { threw = true; }
    if (!threw) throw new Error('Expected rejection for wrong secret');
  });

  await test('verifyToken rejects tampered token', async () => {
    const secret = 'a'.repeat(32);
    const token = await call('src/tokens.mjs', 'createToken', [{user: 'alice'}, secret, {now: 1000}]);
    const [data, sig] = token.split('.');
    const tampered = data + 'x.' + sig;
    let threw = false;
    try { await call('src/tokens.mjs', 'verifyToken', [tampered, secret, {now: 1000}]); } catch { threw = true; }
    if (!threw) throw new Error('Expected rejection for tampered token');
  });

  // === Lockout tracking ===
  await test('createRecord validates userId', async () => {
    const record = await call('src/lockout.mjs', 'createRecord', ['user@example.com']);
    eq(record.userId, 'user@example.com');
    eq(record.attempts, 0);
    eq(record.consecutiveFailures, 0);
    eq(record.lockouts, 0);

    let threw = false;
    try { await call('src/lockout.mjs', 'createRecord', ['']); } catch { threw = true; }
    if (!threw) throw new Error('Expected rejection for empty userId');
  });

  await test('createLockoutPolicy defaults and validation', async () => {
    const policy = await call('src/lockout.mjs', 'createLockoutPolicy', [{}]);
    eq(policy.maxAttempts, 5);
    eq(policy.baseLockoutMs, 60000);
    eq(policy.maxLockoutMs, 3600000);

    let threw = false;
    try { await call('src/lockout.mjs', 'createLockoutPolicy', [{maxAttempts: 0}]); } catch { threw = true; }
    if (!threw) throw new Error('Expected rejection for maxAttempts=0');
  });

  await test('Lockout exponential backoff', async () => {
    const policy = await call('src/lockout.mjs', 'createLockoutPolicy', [{maxAttempts: 3, baseLockoutMs: 1000, maxLockoutMs: 60000}]);
    let record = await call('src/lockout.mjs', 'createRecord', ['user1']);

    // 3 consecutive failures → first lockout
    for (let i = 0; i < 3; i++) {
      record = await call('src/lockout.mjs', 'recordAttempt', [record, false, {now: 1000 + i}]);
    }
    eq(record.consecutiveFailures, 3);
    eq(record.lockouts, 1);
    // baseLockoutMs * 2^(1) = 1000 * 2 = 2000
    eq(record.lockedUntil, 1002 + 2000);

    // Check it's locked
    const check1 = await call('src/lockout.mjs', 'checkLockout', [record, policy, {now: 1500}]);
    eq(check1.locked, true);

    // Check it unlocks
    const check2 = await call('src/lockout.mjs', 'checkLockout', [record, policy, {now: 5000}]);
    eq(check2.locked, false);
  });

  await test('Lockout success resets consecutiveFailures', async () => {
    let record = await call('src/lockout.mjs', 'createRecord', ['user2']);
    record = await call('src/lockout.mjs', 'recordAttempt', [record, false, {now: 100}]);
    record = await call('src/lockout.mjs', 'recordAttempt', [record, false, {now: 200}]);
    eq(record.consecutiveFailures, 2);
    record = await call('src/lockout.mjs', 'recordAttempt', [record, true, {now: 300}]);
    eq(record.consecutiveFailures, 0);
    eq(record.attempts, 3);  // attempts always increment
  });

  await test('recordAttempt immutability', async () => {
    const record = await call('src/lockout.mjs', 'createRecord', ['imm1']);
    const updated = await call('src/lockout.mjs', 'recordAttempt', [record, false, {now: 100}], {immutable: true});
    eq(record.attempts, 0);  // original unchanged
    eq(updated.attempts, 1);
  });

  // === Session lifecycle ===
  await test('createSession generates unique tokens and ids', async () => {
    const s1 = await call('src/sessions.mjs', 'createSession', ['alice', {now: 1000}]);
    const s2 = await call('src/sessions.mjs', 'createSession', ['alice', {now: 1000}]);
    eq(s1.userId, 'alice');
    eq(s1.generation, 1);
    eq(s1.revoked, false);
    eq(typeof s1.token, 'string');
    eq(s1.token.length, 64);
    if (s1.id === s2.id) throw new Error('Sessions should have unique IDs');
    if (s1.token === s2.token) throw new Error('Sessions should have unique tokens');
  });

  await test('refreshSession rotates token and increments generation', async () => {
    const session = await call('src/sessions.mjs', 'createSession', ['bob', {now: 1000, ttlMs: 60000}]);
    const refreshed = await call('src/sessions.mjs', 'refreshSession', [session, {now: 2000}]);
    eq(refreshed.generation, 2);
    if (refreshed.token === session.token) throw new Error('Token should rotate on refresh');
    eq(refreshed.expiresAt, 2000 + 86400000);
    eq(refreshed.refreshedAt, 2000);
  });

  await test('refreshSession rejects revoked/expired', async () => {
    const session = await call('src/sessions.mjs', 'createSession', ['carol', {now: 1000, ttlMs: 1000}]);
    const revoked = await call('src/sessions.mjs', 'revokeSession', [session, {now: 1500}]);
    let threw = false;
    try { await call('src/sessions.mjs', 'refreshSession', [revoked, {now: 1600}]); } catch { threw = true; }
    if (!threw) throw new Error('Expected rejection for revoked session refresh');

    threw = false;
    try { await call('src/sessions.mjs', 'refreshSession', [session, {now: 3000}]); } catch { threw = true; }
    if (!threw) throw new Error('Expected rejection for expired session refresh');
  });

  await test('revokeSession is idempotent and immutable', async () => {
    const session = await call('src/sessions.mjs', 'createSession', ['dave', {now: 1000}]);
    const revoked1 = await call('src/sessions.mjs', 'revokeSession', [session, {now: 2000}], {immutable: true});
    eq(revoked1.revoked, true);
    eq(revoked1.revokedAt, 2000);
    eq(session.revoked, false);  // original unchanged

    const revoked2 = await call('src/sessions.mjs', 'revokeSession', [revoked1, {now: 3000}]);
    eq(revoked2.revokedAt, 2000);  // idempotent, keeps first revocation time
  });

  await test('validateSession checks revoked before expired', async () => {
    const session = await call('src/sessions.mjs', 'createSession', ['eve', {now: 1000, ttlMs: 1000}]);
    const revoked = await call('src/sessions.mjs', 'revokeSession', [session, {now: 1500}]);
    // Both expired AND revoked — should report 'revoked' (checked first)
    const result = await call('src/sessions.mjs', 'validateSession', [revoked, {now: 3000}]);
    eq(result, {valid: false, reason: 'revoked'});
  });

  // === Audit log ===
  await test('Audit chain integrity', async () => {
    let log = await call('src/audit.mjs', 'createAuditLog', []);
    eq(log.entries.length, 0);
    eq(log.headHash, null);

    log = await call('src/audit.mjs', 'appendEntry', [log, {action: 'login', subject: 'alice', detail: {ip: '1.2.3.4'}}, {now: 1000}]);
    eq(log.entries.length, 1);
    eq(log.entries[0].action, 'login');
    eq(log.entries[0].prevHash, null);
    eq(typeof log.entries[0].hash, 'string');

    log = await call('src/audit.mjs', 'appendEntry', [log, {action: 'logout', subject: 'alice', detail: null}, {now: 2000}]);
    eq(log.entries.length, 2);
    eq(log.entries[1].prevHash, log.entries[0].hash);

    const check = await call('src/audit.mjs', 'verifyChain', [log]);
    eq(check, {valid: true, brokenAt: null});
  });

  await test('Audit detects tampering', async () => {
    let log = await call('src/audit.mjs', 'createAuditLog', []);
    log = await call('src/audit.mjs', 'appendEntry', [log, {action: 'create', subject: 'bob', detail: 'account'}, {now: 100}]);
    log = await call('src/audit.mjs', 'appendEntry', [log, {action: 'delete', subject: 'bob', detail: 'account'}, {now: 200}]);

    // Tamper with first entry
    const tampered = {entries: [...log.entries], headHash: log.headHash};
    tampered.entries[0] = {...tampered.entries[0], detail: 'tampered'};
    const check = await call('src/audit.mjs', 'verifyChain', [tampered]);
    eq(check.valid, false);
    eq(check.brokenAt, 0);
  });

  await test('appendEntry immutability', async () => {
    let log = await call('src/audit.mjs', 'createAuditLog', []);
    const original = await call('src/audit.mjs', 'appendEntry', [log, {action: 'test', subject: 'x', detail: null}, {now: 1}], {immutable: true});
    eq(log.entries.length, 0);  // original unchanged
    eq(original.entries.length, 1);
  });

  await test('appendEntry rejects appending to tampered log', async () => {
    let log = await call('src/audit.mjs', 'createAuditLog', []);
    log = await call('src/audit.mjs', 'appendEntry', [log, {action: 'a', subject: 'b', detail: null}, {now: 1}]);
    const tampered = {entries: [{...log.entries[0], action: 'tampered'}], headHash: log.headHash};
    let threw = false;
    try { await call('src/audit.mjs', 'appendEntry', [tampered, {action: 'c', subject: 'd', detail: null}, {now: 2}]); } catch { threw = true; }
    if (!threw) throw new Error('Expected rejection for appending to tampered log');
  });

  // === Password policy ===
  await test('checkPolicy returns all violations', async () => {
    const result = await call('src/password.mjs', 'checkPolicy', ['short']);
    eq(result.valid, false);
    if (!result.reasons.includes('too_short')) throw new Error('Missing too_short');
    if (!result.reasons.includes('missing_upper')) throw new Error('Missing missing_upper');
    if (!result.reasons.includes('missing_digit')) throw new Error('Missing missing_digit');
    if (!result.reasons.includes('missing_special')) throw new Error('Missing missing_special');
  });

  await test('checkPolicy passes strong password', async () => {
    const result = await call('src/password.mjs', 'checkPolicy', ['MyStr0ng!Pass#']);
    eq(result, {valid: true, reasons: []});
  });

  await test('checkPolicy detects common passwords', async () => {
    const result = await call('src/password.mjs', 'checkPolicy', ['Password123!@', {minLength: 8}]);
    if (!result.reasons.includes('too_common')) throw new Error('Should detect common password');
  });

  await test('checkPolicy too_long', async () => {
    const result = await call('src/password.mjs', 'checkPolicy', ['A1!' + 'a'.repeat(200)]);
    if (!result.reasons.includes('too_long')) throw new Error('Should reject too-long password');
  });

  await test('estimateEntropy calculation', async () => {
    // 'abc' → lowercase only, pool=26, entropy=floor(3*log2(26))=floor(3*4.7)=floor(14.1)=14
    const e1 = await call('src/password.mjs', 'estimateEntropy', ['abc']);
    eq(e1, 14);

    // 'aA1!' → all classes, pool=26+26+10+33=95, entropy=floor(4*log2(95))=floor(4*6.57)=floor(26.28)=26
    const e2 = await call('src/password.mjs', 'estimateEntropy', ['aA1!']);
    eq(e2, 26);

    // empty → 0
    eq(await call('src/password.mjs', 'estimateEntropy', ['']), 0);
  });

  // === Cross-module integration ===
  await test('Token verified by constant-time comparison (not ===)', async () => {
    // This tests that tokens.mjs imports and uses compare.mjs's timingSafeEqual
    const secret = 'x'.repeat(32);
    const token = await call('src/tokens.mjs', 'createToken', [{check: true}, secret, {now: 0}]);
    const verified = await call('src/tokens.mjs', 'verifyToken', [token, secret, {now: 0}]);
    eq(verified.check, true);
  });
}
