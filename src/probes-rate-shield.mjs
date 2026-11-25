export async function runRateShieldProbes({call, test, eq}) {
  const rejects = async (fn) => { let threw = false; try { await fn(); } catch { threw = true; } if (!threw) throw new Error('Expected rejection'); };

  // === bucket.mjs ===
  await test('createBucket: valid params produce correct initial state', async () => {
    const b = await call('src/bucket.mjs', 'createBucket', [100, 0.1]);
    eq(b.capacity, 100);
    eq(b.refillRate, 0.1);
    eq(b.tokens, 100);
    eq(b.lastRefill, 0);
  });

  await test('createBucket: custom initialTokens', async () => {
    const b = await call('src/bucket.mjs', 'createBucket', [100, 0.1, { initialTokens: 0 }]);
    eq(b.tokens, 0);
  });

  await test('createBucket: rejects invalid params', async () => {
    await rejects(() => call('src/bucket.mjs', 'createBucket', [0, 0.1]));
    await rejects(() => call('src/bucket.mjs', 'createBucket', [100, 0]));
    await rejects(() => call('src/bucket.mjs', 'createBucket', [100, 0.1, { initialTokens: 200 }]));
  });

  await test('refill: adds exact tokens based on elapsed time', async () => {
    const b = await call('src/bucket.mjs', 'createBucket', [100, 0.01, { initialTokens: 0 }]);
    const r = await call('src/bucket.mjs', 'refill', [b, 5000]);
    eq(r.tokens, 50); // 5000 * 0.01 = 50
    eq(r.lastRefill, 5000);
  });

  await test('refill: capped at capacity', async () => {
    const b = await call('src/bucket.mjs', 'createBucket', [100, 1]);
    // Already full, 1000ms more refill → still 100
    const r = await call('src/bucket.mjs', 'refill', [b, 1000]);
    eq(r.tokens, 100);
  });

  await test('refill: clock skew protection', async () => {
    const b = await call('src/bucket.mjs', 'createBucket', [100, 0.1]);
    const r1 = await call('src/bucket.mjs', 'refill', [b, 1000]);
    // Now go backwards — should return unchanged
    const r2 = await call('src/bucket.mjs', 'refill', [r1, 500]);
    eq(r2.tokens, r1.tokens);
    eq(r2.lastRefill, r1.lastRefill);
  });

  await test('refill: does not mutate input', async () => {
    const b = await call('src/bucket.mjs', 'createBucket', [100, 0.1, { initialTokens: 50 }]);
    await call('src/bucket.mjs', 'refill', [b, 1000], { immutable: true });
  });

  await test('tryConsume: allowed when enough tokens', async () => {
    const b = await call('src/bucket.mjs', 'createBucket', [10, 0.01]);
    const r = await call('src/bucket.mjs', 'tryConsume', [b, 5, 0]);
    eq(r.allowed, true);
    eq(r.remaining, 5);
  });

  await test('tryConsume: denied when insufficient tokens', async () => {
    const b = await call('src/bucket.mjs', 'createBucket', [10, 0.001, { initialTokens: 2 }]);
    const r = await call('src/bucket.mjs', 'tryConsume', [b, 5, 0]);
    eq(r.allowed, false);
    eq(r.remaining, 2);
    eq(typeof r.retryAfterMs, 'number');
    // Need 3 more tokens at 0.001/ms = 3000ms
    eq(r.retryAfterMs, 3000);
  });

  await test('tryConsume: refills before checking', async () => {
    const b = await call('src/bucket.mjs', 'createBucket', [10, 0.01, { initialTokens: 0 }]);
    // At t=500, refill adds 500*0.01 = 5 tokens
    const r = await call('src/bucket.mjs', 'tryConsume', [b, 3, 500]);
    eq(r.allowed, true);
    eq(r.remaining, 2);
  });

  // === window.mjs ===
  await test('createWindow: valid params', async () => {
    const w = await call('src/window.mjs', 'createWindow', [60000, 60]);
    eq(w.durationMs, 60000);
    eq(w.slotCount, 60);
    eq(w.slotDurationMs, 1000);
    eq(w.totalEvents, 0);
  });

  await test('recordEvent + countEvents: basic counting', async () => {
    let w = await call('src/window.mjs', 'createWindow', [10000, 10]);
    w = await call('src/window.mjs', 'recordEvent', [w, 1000]);
    w = await call('src/window.mjs', 'recordEvent', [w, 2000]);
    w = await call('src/window.mjs', 'recordEvent', [w, 3000]);
    const count = await call('src/window.mjs', 'countEvents', [w, 3000]);
    eq(count, 3);
  });

  await test('evict: expired slots zeroed out', async () => {
    let w = await call('src/window.mjs', 'createWindow', [10000, 10]);
    // Record 5 events in first second
    for (let i = 0; i < 5; i++) w = await call('src/window.mjs', 'recordEvent', [w, 1000]);
    eq(await call('src/window.mjs', 'countEvents', [w, 1000]), 5);
    // After full window duration, all should be evicted
    eq(await call('src/window.mjs', 'countEvents', [w, 12000]), 0);
  });

  await test('evict: partial eviction preserves recent events', async () => {
    let w = await call('src/window.mjs', 'createWindow', [10000, 10]); // 1000ms slots
    // Events at t=1000 (slot 0-ish)
    w = await call('src/window.mjs', 'recordEvent', [w, 1000]);
    w = await call('src/window.mjs', 'recordEvent', [w, 1500]);
    // Events at t=6000 (slot 5-ish)
    w = await call('src/window.mjs', 'recordEvent', [w, 6000]);
    // At t=6000, the window covers t=0..10000, so all 3 events should be visible
    eq(await call('src/window.mjs', 'countEvents', [w, 6000]), 3);
  });

  await test('recordEvent: does not mutate input', async () => {
    const w = await call('src/window.mjs', 'createWindow', [10000, 10]);
    await call('src/window.mjs', 'recordEvent', [w, 1000], { immutable: true });
  });

  // === identity.mjs ===
  await test('createIdentity: valid id', async () => {
    const id = await call('src/identity.mjs', 'createIdentity', ['user:192.168.1.1']);
    eq(id.id, 'user:192.168.1.1');
    eq(id.violations, 0);
    eq(id.penaltyUntil, null);
  });

  await test('createIdentity: rejects invalid id', async () => {
    await rejects(() => call('src/identity.mjs', 'createIdentity', ['']));
    await rejects(() => call('src/identity.mjs', 'createIdentity', ['a'.repeat(257)]));
  });

  await test('recordViolation: exponential penalty escalation', async () => {
    let id = await call('src/identity.mjs', 'createIdentity', ['attacker']);
    // First violation: penalty = 60000 * 2^1 = 120000
    // (penaltyCount goes from 0 to 1, exponent is new penaltyCount = 1)
    id = await call('src/identity.mjs', 'recordViolation', [id, 10000, { basePenaltyMs: 60000, maxPenaltyMs: 3600000, escalationFactor: 2 }]);
    eq(id.violations, 1);
    eq(id.consecutiveViolations, 1);
    eq(id.penaltyCount, 1);
    eq(id.penaltyUntil, 10000 + 60000 * 2); // 130000

    // Second violation: penalty = 60000 * 2^2 = 240000
    id = await call('src/identity.mjs', 'recordViolation', [id, 200000, { basePenaltyMs: 60000, maxPenaltyMs: 3600000, escalationFactor: 2 }]);
    eq(id.penaltyCount, 2);
    eq(id.penaltyUntil, 200000 + 60000 * 4); // 440000
  });

  await test('recordViolation: penalty capped at maxPenaltyMs', async () => {
    let id = await call('src/identity.mjs', 'createIdentity', ['attacker']);
    // Many violations to push past cap
    for (let t = 0; t < 10; t++) {
      id = await call('src/identity.mjs', 'recordViolation', [id, t * 1000000, { basePenaltyMs: 1000, maxPenaltyMs: 10000, escalationFactor: 2 }]);
    }
    // Penalty should never exceed maxPenaltyMs from now
    const penalty = id.penaltyUntil - 9000000;
    eq(penalty <= 10000, true);
  });

  await test('recordViolation: does not mutate input', async () => {
    const id = await call('src/identity.mjs', 'createIdentity', ['test']);
    await call('src/identity.mjs', 'recordViolation', [id, 1000, {}], { immutable: true });
  });

  await test('checkPenalty: active penalty detected', async () => {
    let id = await call('src/identity.mjs', 'createIdentity', ['test']);
    id = await call('src/identity.mjs', 'recordViolation', [id, 1000, { basePenaltyMs: 60000 }]);
    const check = await call('src/identity.mjs', 'checkPenalty', [id, 5000]);
    eq(check.penalized, true);
    eq(check.remainingMs > 0, true);
  });

  await test('checkPenalty: expired penalty not penalized', async () => {
    let id = await call('src/identity.mjs', 'createIdentity', ['test']);
    id = await call('src/identity.mjs', 'recordViolation', [id, 1000, { basePenaltyMs: 1000 }]);
    const check = await call('src/identity.mjs', 'checkPenalty', [id, 1000000]);
    eq(check.penalized, false);
    eq(check.remainingMs, 0);
  });

  await test('resetIdentity: clears all violation state', async () => {
    let id = await call('src/identity.mjs', 'createIdentity', ['test']);
    id = await call('src/identity.mjs', 'recordViolation', [id, 1000, {}]);
    const reset = await call('src/identity.mjs', 'resetIdentity', [id]);
    eq(reset.id, 'test');
    eq(reset.violations, 0);
    eq(reset.consecutiveViolations, 0);
    eq(reset.penaltyUntil, null);
    eq(reset.penaltyCount, 0);
  });

  // === policy.mjs ===
  await test('validateRule: accepts valid rule', async () => {
    const rule = await call('src/policy.mjs', 'validateRule', [{ route: '/api/login', method: 'POST', burstLimit: 5, sustainedLimit: 100, windowMs: 60000, bucketCapacity: 10, bucketRefillRate: 0.01, priority: 100 }]);
    eq(rule.route, '/api/login');
  });

  await test('validateRule: rejects invalid rules', async () => {
    await rejects(() => call('src/policy.mjs', 'validateRule', [{ route: 'no-slash', method: 'GET', burstLimit: 5, sustainedLimit: 100, windowMs: 60000, bucketCapacity: 10, bucketRefillRate: 0.01, priority: 10 }]));
    await rejects(() => call('src/policy.mjs', 'validateRule', [{ route: '/ok', method: 'INVALID', burstLimit: 5, sustainedLimit: 100, windowMs: 60000, bucketCapacity: 10, bucketRefillRate: 0.01, priority: 10 }]));
  });

  await test('findPolicy: exact match beats prefix, method filter works', async () => {
    const policy = await call('src/policy.mjs', 'createPolicy', [[
      { route: '/api', method: '*', burstLimit: 100, sustainedLimit: 1000, windowMs: 60000, bucketCapacity: 100, bucketRefillRate: 0.1, priority: 1 },
      { route: '/api/login', method: 'POST', burstLimit: 5, sustainedLimit: 20, windowMs: 60000, bucketCapacity: 10, bucketRefillRate: 0.01, priority: 100 }
    ]]);
    const match = await call('src/policy.mjs', 'findPolicy', [policy, '/api/login', 'POST']);
    eq(match.route, '/api/login');
    eq(match.priority, 100);
    // GET on /api/login matches /api/* wildcard
    const fallback = await call('src/policy.mjs', 'findPolicy', [policy, '/api/login', 'GET']);
    eq(fallback.route, '/api');
  });

  await test('findPolicy: no match returns null', async () => {
    const policy = await call('src/policy.mjs', 'createPolicy', [[
      { route: '/api', method: 'GET', burstLimit: 10, sustainedLimit: 100, windowMs: 60000, bucketCapacity: 10, bucketRefillRate: 0.1, priority: 1 }
    ]]);
    const match = await call('src/policy.mjs', 'findPolicy', [policy, '/other', 'GET']);
    eq(match, null);
  });

  // === index.mjs: shield orchestrator ===
  await test('evaluateRequest: allowed when within limits', async () => {
    const policy = await call('src/policy.mjs', 'createPolicy', [[
      { route: '/api', method: '*', burstLimit: 10, sustainedLimit: 100, windowMs: 60000, bucketCapacity: 10, bucketRefillRate: 0.01, priority: 1 }
    ]]);
    let shield = await call('src/index.mjs', 'createShield', [{ policy, defaultDecision: 'block', windowSlots: 60 }]);
    const result = await call('src/index.mjs', 'evaluateRequest', [shield, { identity: 'user1', route: '/api/data', method: 'GET' }, 1000]);
    eq(result.decision, 'allow');
  });

  await test('evaluateRequest: bucket exhaustion triggers throttle', async () => {
    const policy = await call('src/policy.mjs', 'createPolicy', [[
      { route: '/api', method: '*', burstLimit: 3, sustainedLimit: 100, windowMs: 60000, bucketCapacity: 3, bucketRefillRate: 0.001, priority: 1 }
    ]]);
    let shield = await call('src/index.mjs', 'createShield', [{ policy, defaultDecision: 'block', windowSlots: 60 }]);
    // Burn through all 3 tokens
    for (let i = 0; i < 3; i++) {
      const r = await call('src/index.mjs', 'evaluateRequest', [shield, { identity: 'user1', route: '/api/data', method: 'GET' }, 1000 + i]);
      shield = r.shield;
      eq(r.decision, 'allow');
    }
    // 4th request should be throttled
    const r = await call('src/index.mjs', 'evaluateRequest', [shield, { identity: 'user1', route: '/api/data', method: 'GET' }, 1003]);
    eq(r.decision, 'throttle');
    eq(r.reason, 'bucket_exhausted');
  });

  await test('evaluateRequest: penalty blocks even if tokens available', async () => {
    const policy = await call('src/policy.mjs', 'createPolicy', [[
      { route: '/api', method: '*', burstLimit: 3, sustainedLimit: 100, windowMs: 60000, bucketCapacity: 3, bucketRefillRate: 0.001, priority: 1 }
    ]]);
    let shield = await call('src/index.mjs', 'createShield', [{ policy, defaultDecision: 'block', windowSlots: 60 }]);
    // Exhaust tokens to trigger violation
    for (let i = 0; i < 4; i++) {
      const r = await call('src/index.mjs', 'evaluateRequest', [shield, { identity: 'user1', route: '/api/data', method: 'GET' }, 1000 + i]);
      shield = r.shield;
    }
    // Much later (tokens refilled) but penalty still active
    const r = await call('src/index.mjs', 'evaluateRequest', [shield, { identity: 'user1', route: '/api/data', method: 'GET' }, 5000]);
    eq(r.decision, 'block');
    eq(r.reason, 'penalty');
  });

  await test('evaluateRequest: no matching policy uses defaultDecision', async () => {
    const policy = await call('src/policy.mjs', 'createPolicy', [[
      { route: '/api', method: 'GET', burstLimit: 10, sustainedLimit: 100, windowMs: 60000, bucketCapacity: 10, bucketRefillRate: 0.1, priority: 1 }
    ]]);
    const shield = await call('src/index.mjs', 'createShield', [{ policy, defaultDecision: 'block', windowSlots: 60 }]);
    const result = await call('src/index.mjs', 'evaluateRequest', [shield, { identity: 'user1', route: '/other', method: 'GET' }, 1000]);
    eq(result.decision, 'block');
    eq(result.reason, 'no_policy');
  });

  await test('evaluateRequest: does not mutate shield', async () => {
    const policy = await call('src/policy.mjs', 'createPolicy', [[
      { route: '/api', method: '*', burstLimit: 10, sustainedLimit: 100, windowMs: 60000, bucketCapacity: 10, bucketRefillRate: 0.01, priority: 1 }
    ]]);
    const shield = await call('src/index.mjs', 'createShield', [{ policy, defaultDecision: 'block', windowSlots: 60 }]);
    await call('src/index.mjs', 'evaluateRequest', [shield, { identity: 'user1', route: '/api/data', method: 'GET' }, 1000], { immutable: true });
  });
}
