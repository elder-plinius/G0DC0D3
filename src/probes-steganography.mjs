export async function runSteganographyProbes({ call, test, eq }) {
  // --- lsb.mjs: embedLsb / extractLsb ---

  await test('embedLsb returns a new Uint8Array (no mutation)', async () => {
    const pixels = new Uint8Array(100).fill(0xFF);
    const result = await call('src/lsb.mjs', 'embedLsb', [pixels, 'Hi'], { immutable: true });
    if (!(result instanceof Uint8Array)) throw new Error('Expected Uint8Array');
  });

  await test('embedLsb + extractLsb round-trip short message', async () => {
    const pixels = new Uint8Array(200).fill(0xAA);
    const embedded = await call('src/lsb.mjs', 'embedLsb', [pixels, 'Hi']);
    const extracted = await call('src/lsb.mjs', 'extractLsb', [embedded]);
    eq(extracted, 'Hi');
  });

  await test('embedLsb + extractLsb round-trip longer message', async () => {
    const pixels = new Uint8Array(500).fill(0x00);
    const msg = 'Hello, World!';
    const embedded = await call('src/lsb.mjs', 'embedLsb', [pixels, msg]);
    const extracted = await call('src/lsb.mjs', 'extractLsb', [embedded]);
    eq(extracted, msg);
  });

  await test('embedLsb writes 32-bit length header in first 32 LSBs', async () => {
    const pixels = new Uint8Array(200).fill(0xFF);
    const embedded = await call('src/lsb.mjs', 'embedLsb', [pixels, 'AB']);
    // Length = 2, 32-bit big-endian: bits[30]=1, bits[31]=0, rest=0
    for (let i = 0; i < 30; i++) eq(embedded[i] & 1, 0);
    eq(embedded[30] & 1, 1);
    eq(embedded[31] & 1, 0);
  });

  await test('extractLsb reads length from header, not fixed count', async () => {
    const pixels = new Uint8Array(300).fill(0x00);
    const msg = 'ABCDEFGHIJKLMNO'; // 15 chars
    const embedded = await call('src/lsb.mjs', 'embedLsb', [pixels, msg]);
    const extracted = await call('src/lsb.mjs', 'extractLsb', [embedded]);
    eq(extracted, msg);
    eq(extracted.length, 15);
  });

  await test('embedLsb + extractLsb single char', async () => {
    const pixels = new Uint8Array(80).fill(0xCC);
    const embedded = await call('src/lsb.mjs', 'embedLsb', [pixels, 'Z']);
    const extracted = await call('src/lsb.mjs', 'extractLsb', [embedded]);
    eq(extracted, 'Z');
  });

  await test('embedLsb throws on non-Uint8Array pixels', async () => {
    let threw = false;
    try { await call('src/lsb.mjs', 'embedLsb', [[1,2,3], 'hi']); } catch { threw = true; }
    if (!threw) throw new Error('Expected TypeError');
  });

  await test('embedLsb throws on non-string message', async () => {
    let threw = false;
    try { await call('src/lsb.mjs', 'embedLsb', [new Uint8Array(100), 42]); } catch { threw = true; }
    if (!threw) throw new Error('Expected TypeError');
  });

  await test('embedLsb throws when message exceeds capacity', async () => {
    let threw = false;
    try { await call('src/lsb.mjs', 'embedLsb', [new Uint8Array(40), 'AB']); } catch { threw = true; }
    if (!threw) throw new Error('Expected RangeError');
  });

  await test('extractLsb throws when declared length exceeds capacity', async () => {
    const pixels = new Uint8Array(50);
    const len = 999;
    for (let i = 0; i < 32; i++) pixels[i] = (pixels[i] & 0xFE) | ((len >> (31 - i)) & 1);
    let threw = false;
    try { await call('src/lsb.mjs', 'extractLsb', [pixels]); } catch { threw = true; }
    if (!threw) throw new Error('Expected RangeError');
  });

  await test('embedLsb preserves non-LSB bits of modified bytes', async () => {
    const pixels = new Uint8Array(100).fill(0xFE);
    const embedded = await call('src/lsb.mjs', 'embedLsb', [pixels, 'A']);
    for (let i = 32 + 8; i < 100; i++) eq(embedded[i], 0xFE);
  });

  await test('extractLsb on empty message returns empty string', async () => {
    const pixels = new Uint8Array(100).fill(0x00);
    const embedded = await call('src/lsb.mjs', 'embedLsb', [pixels, '']);
    const extracted = await call('src/lsb.mjs', 'extractLsb', [embedded]);
    eq(extracted, '');
  });

  // --- lsb.mjs: embedLsbRgba ---

  await test('embedLsbRgba defaults to blue channel (offset 2)', async () => {
    const pixels = new Uint8Array(400).fill(0xFF);
    const embedded = await call('src/lsb.mjs', 'embedLsbRgba', [pixels, 'A']);
    eq(embedded[0], 0xFF); // red untouched
    eq(embedded[1], 0xFF); // green untouched
    eq(embedded[3], 0xFF); // alpha untouched
  });

  await test('embedLsbRgba respects red channel offset', async () => {
    const pixels = new Uint8Array(800).fill(0xFF);
    const embedded = await call('src/lsb.mjs', 'embedLsbRgba', [pixels, 'A', { channel: 'red' }]);
    eq(embedded[1], 0xFF); // green
    eq(embedded[2], 0xFF); // blue
    eq(embedded[3], 0xFF); // alpha
  });

  await test('embedLsbRgba respects alpha channel offset', async () => {
    const pixels = new Uint8Array(800).fill(0xFF);
    const embedded = await call('src/lsb.mjs', 'embedLsbRgba', [pixels, 'A', { channel: 'alpha' }]);
    eq(embedded[0], 0xFF); // red
    eq(embedded[1], 0xFF); // green
    eq(embedded[2], 0xFF); // blue
  });

  await test('embedLsbRgba throws on unknown channel', async () => {
    let threw = false;
    try { await call('src/lsb.mjs', 'embedLsbRgba', [new Uint8Array(400), 'A', { channel: 'purple' }]); } catch { threw = true; }
    if (!threw) throw new Error('Expected error for unknown channel');
  });

  await test('embedLsbRgba capacity overflow', async () => {
    let threw = false;
    try { await call('src/lsb.mjs', 'embedLsbRgba', [new Uint8Array(160), 'AB']); } catch { threw = true; }
    if (!threw) throw new Error('Expected capacity error');
  });

  // --- header.mjs ---

  await test('createExifPayload returns correct structure', async () => {
    const result = await call('src/header.mjs', 'createExifPayload', ['Test']);
    eq(result.marker, 0xE1);
    eq(result.length, 6);
    eq(result.payload, '54657374');
  });

  await test('createExifPayload validates marker range low', async () => {
    let threw = false;
    try { await call('src/header.mjs', 'createExifPayload', ['data', { marker: 0xDF }]); } catch { threw = true; }
    if (!threw) throw new Error('Expected error for marker below 0xE0');
  });

  await test('createExifPayload validates marker range high', async () => {
    let threw = false;
    try { await call('src/header.mjs', 'createExifPayload', ['data', { marker: 0xF0 }]); } catch { threw = true; }
    if (!threw) throw new Error('Expected error for marker above 0xEF');
  });

  await test('createExifPayload accepts boundary markers', async () => {
    const r0 = await call('src/header.mjs', 'createExifPayload', ['x', { marker: 0xE0 }]);
    eq(r0.marker, 0xE0);
    const rF = await call('src/header.mjs', 'createExifPayload', ['x', { marker: 0xEF }]);
    eq(rF.marker, 0xEF);
  });

  await test('parseExifPayload decodes hex to string', async () => {
    const result = await call('src/header.mjs', 'parseExifPayload', [{ marker: 0xE1, length: 6, payload: '54657374' }]);
    eq(result.data, 'Test');
    eq(result.marker, 0xE1);
  });

  await test('parseExifPayload validates length', async () => {
    let threw = false;
    try { await call('src/header.mjs', 'parseExifPayload', [{ marker: 0xE1, length: 99, payload: '54657374' }]); } catch { threw = true; }
    if (!threw) throw new Error('Expected error for length mismatch');
  });

  await test('createExifPayload + parseExifPayload round-trip', async () => {
    const created = await call('src/header.mjs', 'createExifPayload', ['Secret message!']);
    const parsed = await call('src/header.mjs', 'parseExifPayload', [created]);
    eq(parsed.data, 'Secret message!');
  });

  await test('injectComment inserts after SOI marker', async () => {
    const header = 'ffd8ffe000104a464946';
    const result = await call('src/header.mjs', 'injectComment', [header, 'Hi']);
    if (!result.startsWith('ffd8')) throw new Error('Must start with SOI');
    if (!result.startsWith('ffd8fffe')) throw new Error('Comment marker must follow SOI');
    const expected = 'ffd8' + 'fffe' + '0004' + '4869' + 'ffe000104a464946';
    eq(result, expected);
  });

  await test('injectComment rejects comment > 65533 bytes', async () => {
    let threw = false;
    try { await call('src/header.mjs', 'injectComment', ['ffd8ff', 'x'.repeat(65534)]); } catch { threw = true; }
    if (!threw) throw new Error('Expected error for oversized comment');
  });

  // --- analysis.mjs ---

  await test('shannonEntropy of uniform distribution = 8.0', async () => {
    const data = new Uint8Array(256);
    for (let i = 0; i < 256; i++) data[i] = i;
    const ent = await call('src/analysis.mjs', 'shannonEntropy', [data]);
    if (Math.abs(ent - 8.0) > 0.01) throw new Error('Expected ~8.0, got ' + ent);
  });

  await test('shannonEntropy of constant data = 0', async () => {
    const ent = await call('src/analysis.mjs', 'shannonEntropy', [new Uint8Array(100).fill(42)]);
    eq(ent, 0);
  });

  await test('shannonEntropy of empty data = 0', async () => {
    const ent = await call('src/analysis.mjs', 'shannonEntropy', [new Uint8Array(0)]);
    eq(ent, 0);
  });

  await test('shannonEntropy of two-value data = 1.0', async () => {
    const ent = await call('src/analysis.mjs', 'shannonEntropy', [new Uint8Array([0,1,0,1,0,1,0,1])]);
    if (Math.abs(ent - 1.0) > 0.01) throw new Error('Expected ~1.0, got ' + ent);
  });

  await test('shannonEntropy is in [0, 8]', async () => {
    const data = new Uint8Array(512);
    for (let i = 0; i < 512; i++) data[i] = (i * 37 + 13) & 0xFF;
    const ent = await call('src/analysis.mjs', 'shannonEntropy', [data]);
    if (ent < 0 || ent > 8) throw new Error('Entropy out of range: ' + ent);
  });

  await test('chiSquare returns chiSquare, pValue, detected', async () => {
    const data = new Uint8Array(256);
    for (let i = 0; i < 256; i++) data[i] = i;
    const result = await call('src/analysis.mjs', 'chiSquare', [data]);
    if (typeof result.chiSquare !== 'number') throw new Error('Missing chiSquare');
    if (typeof result.pValue !== 'number') throw new Error('Missing pValue');
    if (typeof result.detected !== 'boolean') throw new Error('Missing detected');
  });

  await test('chiSquare pValue is in [0, 1]', async () => {
    const data = new Uint8Array(1000);
    for (let i = 0; i < 1000; i++) data[i] = i % 256;
    const result = await call('src/analysis.mjs', 'chiSquare', [data]);
    if (result.pValue < 0 || result.pValue > 1) throw new Error('pValue not in [0,1]');
  });

  await test('chiSquare detected matches pValue < 0.05', async () => {
    const data = new Uint8Array(2000);
    for (let i = 0; i < 2000; i++) data[i] = i % 256;
    const result = await call('src/analysis.mjs', 'chiSquare', [data]);
    eq(result.detected, result.pValue < 0.05);
  });

  await test('detectAnomaly flags high entropy as suspicious', async () => {
    const data = new Uint8Array(256);
    for (let i = 0; i < 256; i++) data[i] = i;
    const result = await call('src/analysis.mjs', 'detectAnomaly', [data]);
    eq(result.suspicious, true);
  });

  await test('detectAnomaly does NOT flag low entropy', async () => {
    const result = await call('src/analysis.mjs', 'detectAnomaly', [new Uint8Array(100).fill(0)]);
    eq(result.suspicious, false);
  });

  await test('detectAnomaly respects custom threshold', async () => {
    const data = new Uint8Array([0, 1, 0, 1, 0, 1, 0, 1]);
    const result = await call('src/analysis.mjs', 'detectAnomaly', [data, { threshold: 0.5 }]);
    eq(result.suspicious, true);
  });

  // --- spread.mjs ---

  await test('generatePrn is deterministic', async () => {
    const a = await call('src/spread.mjs', 'generatePrn', [42, 50]);
    const b = await call('src/spread.mjs', 'generatePrn', [42, 50]);
    eq(a, b);
  });

  await test('generatePrn different seeds differ', async () => {
    const a = await call('src/spread.mjs', 'generatePrn', [42, 50]);
    const b = await call('src/spread.mjs', 'generatePrn', [99, 50]);
    if (JSON.stringify(a) === JSON.stringify(b)) throw new Error('Different seeds should differ');
  });

  await test('generatePrn returns only 0s and 1s', async () => {
    const bits = await call('src/spread.mjs', 'generatePrn', [7, 100]);
    for (const b of bits) {
      if (b !== 0 && b !== 1) throw new Error('Expected 0 or 1, got ' + b);
    }
  });

  await test('generatePrn uses LCG formula', async () => {
    const bits = await call('src/spread.mjs', 'generatePrn', [1, 20]);
    let state = 1;
    const expected = [];
    for (let i = 0; i < 20; i++) {
      state = (state * 1103515245 + 12345) & 0x7FFFFFFF;
      expected.push((state >> 16) & 1);
    }
    eq(bits, expected);
  });

  await test('spreadEmbed + spreadExtract round-trip', async () => {
    const pixels = new Uint8Array(600).fill(0x80);
    const embedded = await call('src/spread.mjs', 'spreadEmbed', [pixels, 'Test', 42]);
    const extracted = await call('src/spread.mjs', 'spreadExtract', [embedded, 42]);
    eq(extracted, 'Test');
  });

  await test('spreadEmbed + spreadExtract round-trip single char', async () => {
    const pixels = new Uint8Array(200).fill(0x00);
    const embedded = await call('src/spread.mjs', 'spreadEmbed', [pixels, 'Z', 7]);
    const extracted = await call('src/spread.mjs', 'spreadExtract', [embedded, 7]);
    eq(extracted, 'Z');
  });

  await test('spreadEmbed uses 8x spreading', async () => {
    // 1 char = 8 bits, 8x = 64 bytes for message + 32 for header = 96 min
    const pixels = new Uint8Array(100).fill(0x00);
    const embedded = await call('src/spread.mjs', 'spreadEmbed', [pixels, 'A', 1]);
    let changed = 0;
    for (let i = 0; i < 100; i++) if (embedded[i] !== 0x00) changed++;
    if (changed < 32) throw new Error('Too few bytes changed: ' + changed);
  });

  await test('spreadEmbed throws on capacity overflow', async () => {
    let threw = false;
    try { await call('src/spread.mjs', 'spreadEmbed', [new Uint8Array(100), 'AB', 1]); } catch { threw = true; }
    if (!threw) throw new Error('Expected capacity error');
  });

  await test('spreadEmbed does not mutate input', async () => {
    const pixels = new Uint8Array(600).fill(0xFF);
    await call('src/spread.mjs', 'spreadEmbed', [pixels, 'X', 5], { immutable: true });
  });

  await test('correlate returns values in [-1, 1]', async () => {
    const result = await call('src/spread.mjs', 'correlate', [[1,2,3,4,5,6,7,8], [1,2,3]]);
    if (!Array.isArray(result)) throw new Error('Must return array');
    for (const v of result) {
      if (v < -1.001 || v > 1.001) throw new Error('Value out of [-1,1]: ' + v);
    }
  });

  await test('correlate perfect match = 1.0', async () => {
    const result = await call('src/spread.mjs', 'correlate', [[1,2,3,4,5], [1,2,3,4,5]]);
    if (Math.abs(result[0] - 1.0) > 0.001) throw new Error('Expected 1.0, got ' + result[0]);
  });

  await test('correlate inverted = -1.0', async () => {
    const result = await call('src/spread.mjs', 'correlate', [[1,2,3,4,5], [5,4,3,2,1]]);
    if (Math.abs(result[0] - (-1.0)) > 0.001) throw new Error('Expected -1.0, got ' + result[0]);
  });

  await test('correlate result length', async () => {
    const result = await call('src/spread.mjs', 'correlate', [[1,2,3,4,5,6], [1,2]]);
    eq(result.length, 5);
  });

  await test('correlate throws on non-array', async () => {
    let threw = false;
    try { await call('src/spread.mjs', 'correlate', ['abc', [1]]); } catch { threw = true; }
    if (!threw) throw new Error('Expected TypeError');
  });
}
