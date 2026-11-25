export async function runSideChannelProbes({call, test, eq}) {
  // === Timing analysis ===
  await test('simulateCompareTiming leaks matching prefix length', async () => {
    const t1 = await call('src/timing.mjs', 'simulateCompareTiming', ['secret', 'sXXXXX']);
    const t2 = await call('src/timing.mjs', 'simulateCompareTiming', ['secret', 'seXXXX']);
    const t3 = await call('src/timing.mjs', 'simulateCompareTiming', ['secret', 'XXXXXX']);
    eq(t1.matching, 1);
    eq(t2.matching, 2);
    eq(t3.matching, 0);
    eq(t1.totalTime > t3.totalTime, true);
    eq(t2.totalTime > t1.totalTime, true);
  });

  await test('simulateCompareTiming base time is 100', async () => {
    const t = await call('src/timing.mjs', 'simulateCompareTiming', ['abc', 'xyz']);
    eq(t.totalTime, 100);
    eq(t.matching, 0);
  });

  await test('welchTTest with Bessel correction (n-1 denominator)', async () => {
    const a = [10, 20, 30];
    const b = [40, 50, 60];
    const result = await call('src/timing.mjs', 'welchTTest', [a, b]);
    eq(result.meanA, 20);
    eq(result.meanB, 50);
    const varA_bessel = ((10-20)**2 + (20-20)**2 + (30-20)**2) / 2;
    const varB_bessel = ((40-50)**2 + (50-50)**2 + (60-50)**2) / 2;
    const se = Math.sqrt(varA_bessel/3 + varB_bessel/3);
    const expected_t = (20 - 50) / se;
    const diff = Math.abs(result.t - expected_t);
    if (diff > 0.01) throw new Error(`Expected t≈${expected_t.toFixed(4)} but got ${result.t.toFixed(4)} — not using Bessel's correction?`);
  });

  await test('welchTTest significant result', async () => {
    const a = [100, 101, 102, 100, 101];
    const b = [200, 201, 202, 200, 201];
    const result = await call('src/timing.mjs', 'welchTTest', [a, b]);
    eq(result.significant, true);
  });

  await test('welchTTest non-significant result', async () => {
    const a = [100, 200, 150];
    const b = [120, 180, 140];
    const result = await call('src/timing.mjs', 'welchTTest', [a, b]);
    eq(result.significant, false);
  });

  await test('timingOracle recovers correct character', async () => {
    const ch = await call('src/timing.mjs', 'timingOracle', ['secret', 'abcdefghijklmnopqrstuvwxyz'.split(''), 0]);
    eq(ch, 's');
  });

  await test('timingOracle uses real prefix not x padding', async () => {
    const ch = await call('src/timing.mjs', 'timingOracle', ['hello', 'abcdefghijklmnopqrstuvwxyz'.split(''), 1]);
    eq(ch, 'e');
  });

  await test('recoverSecret works with simulated timing', async () => {
    const recovered = await call('src/timing.mjs', 'recoverSecret', [3, 'abcdefghijklmnopqrstuvwxyz'.split(''), 'abc']);
    eq(recovered, 'abc');
  });

  // === Cache modeling ===
  await test('createCache initializes correctly', async () => {
    const c = await call('src/cache.mjs', 'createCache', [{lineSize: 64, sets: 16, ways: 2}]);
    eq(c.sets, 16);
    eq(c.ways, 2);
    eq(c.lineSize, 64);
    eq(c.hits, 0);
    eq(c.misses, 0);
  });

  await test('getSetIndex divides by lineSize first', async () => {
    const c = await call('src/cache.mjs', 'createCache', [{lineSize: 64, sets: 16, ways: 2}]);
    const idx0 = await call('src/cache.mjs', 'getSetIndex', [c, 0]);
    const idx64 = await call('src/cache.mjs', 'getSetIndex', [c, 64]);
    const idx128 = await call('src/cache.mjs', 'getSetIndex', [c, 128]);
    eq(idx0, 0);
    eq(idx64, 1);
    eq(idx128, 2);
  });

  await test('getSetIndex same cache line maps to same set', async () => {
    const c = await call('src/cache.mjs', 'createCache', [{lineSize: 64, sets: 16, ways: 2}]);
    const idx1 = await call('src/cache.mjs', 'getSetIndex', [c, 0]);
    const idx2 = await call('src/cache.mjs', 'getSetIndex', [c, 32]);
    eq(idx1, idx2);
  });

  await test('accessCache hit on second access', async () => {
    const c = await call('src/cache.mjs', 'createCache', [{lineSize: 64, sets: 4, ways: 2}]);
    const results = await call('src/cache.mjs', 'accessSequence', [c, [0, 0]]);
    eq(results[0].hit, false);
    eq(results[1].hit, true);
  });

  await test('accessCache LRU eviction', async () => {
    const c = await call('src/cache.mjs', 'createCache', [{lineSize: 64, sets: 1, ways: 2}]);
    await call('src/cache.mjs', 'accessCache', [c, 0]);
    await call('src/cache.mjs', 'accessCache', [c, 64]);
    await call('src/cache.mjs', 'accessCache', [c, 128]);
    const r = await call('src/cache.mjs', 'accessCache', [c, 0]);
    eq(r.hit, false);
  });

  await test('accessSequence returns array of results', async () => {
    const c = await call('src/cache.mjs', 'createCache', [{lineSize: 64, sets: 4, ways: 2}]);
    const results = await call('src/cache.mjs', 'accessSequence', [c, [0, 0, 64, 0]]);
    eq(results.length, 4);
    eq(results[0].hit, false);
    eq(results[1].hit, true);
    eq(results[2].hit, false);
    eq(results[3].hit, true);
  });

  await test('getCacheStats computes hit rate', async () => {
    const c = await call('src/cache.mjs', 'createCache', [{}]);
    const stats = await call('src/cache.mjs', 'accessAndGetStats', [c, [0, 0, 0]]);
    eq(stats.hits, 2);
    eq(stats.misses, 1);
    const expectedRate = 2 / 3;
    if (Math.abs(stats.hitRate - expectedRate) > 0.001) throw new Error(`Expected hitRate ${expectedRate}`);
  });

  await test('detectFlushReload finds accessed lines', async () => {
    const probeResults = [{ hit: true }, { hit: false }, { hit: true }];
    const targets = [0x1000, 0x2000, 0x3000];
    const leaks = await call('src/cache.mjs', 'detectFlushReload', [{}, targets, probeResults]);
    eq(leaks.length, 2);
    eq(leaks[0].address, 0x1000);
    eq(leaks[1].address, 0x3000);
  });

  // === Power analysis ===
  await test('hammingWeight counts 1-bits', async () => {
    eq(await call('src/power.mjs', 'hammingWeight', [0]), 0);
    eq(await call('src/power.mjs', 'hammingWeight', [1]), 1);
    eq(await call('src/power.mjs', 'hammingWeight', [0xFF]), 8);
    eq(await call('src/power.mjs', 'hammingWeight', [0b10101010]), 4);
    eq(await call('src/power.mjs', 'hammingWeight', [0xFFFFFFFF]), 32);
  });

  await test('hammingWeight does not count 0-bits', async () => {
    const hw = await call('src/power.mjs', 'hammingWeight', [1]);
    eq(hw, 1);
    if (hw === 31) throw new Error('Counting zeros instead of ones');
  });

  await test('hammingDistance XOR then weight', async () => {
    eq(await call('src/power.mjs', 'hammingDistance', [0xFF, 0x00]), 8);
    eq(await call('src/power.mjs', 'hammingDistance', [0xFF, 0xFF]), 0);
    eq(await call('src/power.mjs', 'hammingDistance', [0b1010, 0b0101]), 4);
  });

  await test('simulatePowerTrace uses hamming weight', async () => {
    const trace = await call('src/power.mjs', 'simulatePowerTrace', [[{value: 0xFF}, {value: 0}]]);
    eq(trace.length, 2);
    eq(trace[0], 8);
    eq(trace[1], 0);
  });

  await test('simulatePowerTrace with seeded noise', async () => {
    const trace = await call('src/power.mjs', 'simulatePowerTrace', [[{value: 0xFF, seed: 42}]]);
    eq(trace.length, 1);
    if (trace[0] === 8) throw new Error('Seeded noise should perturb the value');
  });

  await test('pearsonCorrelation with mean subtraction', async () => {
    const xs = [1, 2, 3, 4, 5];
    const ys = [2, 4, 6, 8, 10];
    const r = await call('src/power.mjs', 'pearsonCorrelation', [xs, ys]);
    if (Math.abs(r - 1.0) > 0.001) throw new Error(`Perfect correlation should be 1.0, got ${r}`);
  });

  await test('pearsonCorrelation negative correlation', async () => {
    const xs = [1, 2, 3, 4, 5];
    const ys = [10, 8, 6, 4, 2];
    const r = await call('src/power.mjs', 'pearsonCorrelation', [xs, ys]);
    if (Math.abs(r - (-1.0)) > 0.001) throw new Error(`Perfect negative correlation should be -1.0, got ${r}`);
  });

  await test('pearsonCorrelation with offset (needs mean subtraction)', async () => {
    const xs = [101, 102, 103, 104, 105];
    const ys = [202, 204, 206, 208, 210];
    const r = await call('src/power.mjs', 'pearsonCorrelation', [xs, ys]);
    if (Math.abs(r - 1.0) > 0.001) throw new Error(`Offset data should still correlate at 1.0, got ${r} — missing mean subtraction?`);
  });

  await test('pearsonCorrelation different lengths throws', async () => {
    let threw = false;
    try { await call('src/power.mjs', 'pearsonCorrelation', [[1, 2], [1]]); } catch { threw = true; }
    eq(threw, true);
  });

  await test('dpaAttack finds correct key', async () => {
    const keyGuesses = [0x00, 0x42, 0xFF];
    const plaintexts = [0x10, 0x20, 0x30, 0x40];
    const realKey = 0x42;
    const traces = plaintexts.map(p => {
      let v = p ^ realKey;
      let hw = 0;
      while (v) { hw += v & 1; v >>>= 1; }
      return hw;
    });
    const scores = await call('src/power.mjs', 'dpaAttack', [traces, plaintexts, keyGuesses]);
    eq(scores[0].key, realKey);
  });

  // === Constant-time verification ===
  await test('constantTimeCompare equal buffers returns true', async () => {
    const a = Buffer.from([1, 2, 3, 4]);
    const b = Buffer.from([1, 2, 3, 4]);
    const result = await call('src/constant-time.mjs', 'constantTimeCompare', [a, b]);
    eq(result, true);
  });

  await test('constantTimeCompare different buffers returns false', async () => {
    const a = Buffer.from([1, 2, 3, 4]);
    const b = Buffer.from([1, 2, 3, 5]);
    const result = await call('src/constant-time.mjs', 'constantTimeCompare', [a, b]);
    eq(result, false);
  });

  await test('constantTimeCompare different lengths returns false', async () => {
    const result = await call('src/constant-time.mjs', 'constantTimeCompare', [Buffer.from([1, 2]), Buffer.from([1, 2, 3])]);
    eq(result, false);
  });

  await test('constantTimeSelect integer selection with mask', async () => {
    const a = await call('src/constant-time.mjs', 'constantTimeSelect', [1, 42, 99]);
    eq(a, 42);
    const b = await call('src/constant-time.mjs', 'constantTimeSelect', [0, 42, 99]);
    eq(b, 99);
  });

  await test('constantTimeEquals for integers', async () => {
    eq(await call('src/constant-time.mjs', 'constantTimeEquals', [5, 5]), 1);
    eq(await call('src/constant-time.mjs', 'constantTimeEquals', [5, 6]), 0);
    eq(await call('src/constant-time.mjs', 'constantTimeEquals', [0, 0]), 1);
  });

  await test('safeCompare uses timingSafeEqual', async () => {
    const result = await call('src/constant-time.mjs', 'safeCompare', [Buffer.from('abc'), Buffer.from('abc')]);
    eq(result, true);
    const result2 = await call('src/constant-time.mjs', 'safeCompare', [Buffer.from('abc'), Buffer.from('xyz')]);
    eq(result2, false);
  });

  await test('safeCompare rejects non-Buffers', async () => {
    let threw = false;
    try { await call('src/constant-time.mjs', 'safeCompare', ['abc', 'abc']); } catch { threw = true; }
    eq(threw, true);
  });

  await test('safeCompare different lengths returns false', async () => {
    const result = await call('src/constant-time.mjs', 'safeCompare', [Buffer.from('ab'), Buffer.from('abc')]);
    eq(result, false);
  });

  // === Cross-module integration ===
  await test('Timing leak → statistical detection → oracle recovery', async () => {
    const t1 = await call('src/timing.mjs', 'simulateCompareTiming', ['secret', 'sAAAAA']);
    const t2 = await call('src/timing.mjs', 'simulateCompareTiming', ['secret', 'AAAAAA']);
    eq(t1.totalTime > t2.totalTime, true);

    const samplesMatch = Array(10).fill(t1.totalTime);
    const samplesNoMatch = Array(10).fill(t2.totalTime);
    const ttest = await call('src/timing.mjs', 'welchTTest', [samplesMatch, samplesNoMatch]);
    eq(ttest.significant, true);

    const firstChar = await call('src/timing.mjs', 'timingOracle', ['secret', 'abcdefghijklmnopqrstuvwxyz'.split(''), 0]);
    eq(firstChar, 's');
  });
}
