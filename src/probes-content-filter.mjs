export async function runContentFilterProbes({call, test, eq}) {
  // === Normalization ===
  await test('Homoglyph normalization', async () => {
    const result = await call('src/normalize.mjs', 'normalizeText', ['АВС']);  // Cyrillic АВС
    eq(result, 'abc');
  });

  await test('Leetspeak deobfuscation', async () => {
    eq(await call('src/normalize.mjs', 'normalizeText', ['h3ll0 w0rld']), 'hello world');
    eq(await call('src/normalize.mjs', 'normalizeText', ['$p@m']), 'spam');
    eq(await call('src/normalize.mjs', 'normalizeText', ['7e57']), 'test');
  });

  await test('Zero-width character removal', async () => {
    eq(await call('src/normalize.mjs', 'normalizeText', ['he​llo']), 'hello');
    eq(await call('src/normalize.mjs', 'normalizeText', ['w‌‍o﻿r­d']), 'word');
  });

  await test('Run collapse (3+ identical → 2)', async () => {
    eq(await call('src/normalize.mjs', 'normalizeText', ['heeello']), 'heello');
    eq(await call('src/normalize.mjs', 'normalizeText', ['aaa']), 'aa');
    eq(await call('src/normalize.mjs', 'normalizeText', ['ab']), 'ab');
    eq(await call('src/normalize.mjs', 'normalizeText', ['aabb']), 'aabb');
  });

  await test('Normalization idempotency', async () => {
    const inputs = ['H3LL​O', 'ААА@$7', '', '   ', 'normaltext'];
    for (const input of inputs) {
      const once = await call('src/normalize.mjs', 'normalizeText', [input]);
      const twice = await call('src/normalize.mjs', 'normalizeText', [once]);
      eq(twice, once);
    }
  });

  await test('Deobfuscate strips non-alpha after normalization', async () => {
    eq(await call('src/normalize.mjs', 'deobfuscate', ['b.a.d.w.o.r.d']), 'badword');
    eq(await call('src/normalize.mjs', 'deobfuscate', ['H-3-L-L-0']), 'hello');
    eq(await call('src/normalize.mjs', 'deobfuscate', ['$p @ m']), 'spam');
  });

  await test('Normalization handles coercion and edge cases', async () => {
    eq(await call('src/normalize.mjs', 'normalizeText', [123]), '123');
    eq(await call('src/normalize.mjs', 'normalizeText', [null]), 'null');
    eq(await call('src/normalize.mjs', 'normalizeText', ['']), '');
  });

  // === Pattern compilation and matching ===
  const validRule = {id: 'rule1', pattern: 'test', category: 'profanity', severity: 50, mode: 'unanchored'};

  await test('CompileRules validates and compiles', async () => {
    const compiled = await call('src/patterns.mjs', 'compileRules', [[validRule]]);
    eq(Array.isArray(compiled), true);
  });

  await test('CompileRules rejects invalid rules', async () => {
    const {throws} = await import('node:assert/strict');
    // missing fields
    for (const bad of [
      {id: 'r1', pattern: 'x', category: 'profanity', severity: 50},  // missing mode
      {id: 'r1', pattern: 'x', category: 'profanity', mode: 'anchored'},  // missing severity
      {id: 'r1', pattern: 'x', severity: 50, mode: 'anchored'},  // missing category
      {id: '1bad', pattern: 'x', category: 'profanity', severity: 50, mode: 'anchored'},  // bad id
      {id: 'r1', pattern: 'x', category: 'invalid', severity: 50, mode: 'anchored'},  // bad category
      {id: 'r1', pattern: 'x', category: 'profanity', severity: 0, mode: 'anchored'},  // severity 0
      {id: 'r1', pattern: 'x', category: 'profanity', severity: 101, mode: 'anchored'},  // severity 101
      {id: 'r1', pattern: 'x', category: 'profanity', severity: 50, mode: 'bogus'},  // bad mode
    ]) {
      let threw = false;
      try { await call('src/patterns.mjs', 'compileRules', [[bad]]); } catch { threw = true; }
      if (!threw) throw new Error('Expected rejection for: ' + JSON.stringify(bad));
    }
  });

  await test('CompileRules rejects duplicate IDs', async () => {
    const dup = [{...validRule, id: 'dup1'}, {...validRule, id: 'dup1'}];
    let threw = false;
    try { await call('src/patterns.mjs', 'compileRules', [dup]); } catch { threw = true; }
    if (!threw) throw new Error('Expected rejection for duplicate IDs');
  });

  await test('matchPatterns with unanchored mode returns spans', async () => {
    const compiled = await call('src/patterns.mjs', 'compileRules', [[
      {id: 'w1', pattern: 'bad', category: 'profanity', severity: 50, mode: 'unanchored'}
    ]]);
    const matches = await call('src/patterns.mjs', 'matchPatterns', ['this is bad stuff', compiled]);
    eq(matches.length, 1);
    eq(matches[0].id, 'w1');
    eq(matches[0].span.start, 8);
    eq(matches[0].span.end, 11);
  });

  await test('matchPatterns with anchored mode', async () => {
    const compiled = await call('src/patterns.mjs', 'compileRules', [[
      {id: 'a1', pattern: 'exactmatch', category: 'threat', severity: 80, mode: 'anchored'}
    ]]);
    eq((await call('src/patterns.mjs', 'matchPatterns', ['exactmatch', compiled])).length, 1);
    eq((await call('src/patterns.mjs', 'matchPatterns', ['not exactmatch here', compiled])).length, 0);
  });

  await test('matchPatterns sorted by start, severity, id', async () => {
    const compiled = await call('src/patterns.mjs', 'compileRules', [[
      {id: 'b1', pattern: 'xyz', category: 'profanity', severity: 30, mode: 'unanchored'},
      {id: 'a1', pattern: 'abc', category: 'spam', severity: 50, mode: 'unanchored'},
      {id: 'a2', pattern: 'abc', category: 'threat', severity: 50, mode: 'unanchored'},
    ]]);
    const matches = await call('src/patterns.mjs', 'matchPatterns', ['abcxyz', compiled]);
    eq(matches.length, 3);
    eq(matches[0].id, 'a1');  // start=0, severity=50, id=a1
    eq(matches[1].id, 'a2');  // start=0, severity=50, id=a2
    eq(matches[2].id, 'b1');  // start=3
  });

  // === Redaction ===
  await test('Redact non-overlapping spans', async () => {
    const matches = [{id: 'r1', span: {start: 0, end: 3}}, {id: 'r2', span: {start: 7, end: 10}}];
    const result = await call('src/redact.mjs', 'redactMatches', ['badxxxxbad', matches]);
    eq(result.redacted, '[REDACTED]xxxx[REDACTED]');
    eq(result.spans.length, 2);
  });

  await test('Redact overlapping spans merge', async () => {
    const matches = [{id: 'r1', span: {start: 0, end: 5}}, {id: 'r2', span: {start: 3, end: 8}}];
    const result = await call('src/redact.mjs', 'redactMatches', ['abcdefghij', matches]);
    eq(result.redacted, '[REDACTED]ij');
    eq(result.spans.length, 1);
    eq(result.spans[0].ruleIds.length, 2);
  });

  await test('Redact custom marker', async () => {
    const matches = [{id: 'r1', span: {start: 0, end: 3}}];
    const result = await call('src/redact.mjs', 'redactMatches', ['badstuff', matches, {marker: '***'}]);
    eq(result.redacted, '***stuff');
  });

  await test('Redact preserves original offsets', async () => {
    const matches = [{id: 'r1', span: {start: 5, end: 8}}];
    const result = await call('src/redact.mjs', 'redactMatches', ['good bad good', matches]);
    eq(result.spans[0].originalStart, 5);
    eq(result.spans[0].originalEnd, 8);
  });

  // === Scoring ===
  await test('Score empty matches', async () => {
    const result = await call('src/scorer.mjs', 'scoreRisk', [[]]);
    eq(result, {compositeScore: 0, categoryScores: {}, decision: 'allow', matchCount: 0});
  });

  await test('Score with default weights and thresholds', async () => {
    const matches = [
      {id: 'r1', category: 'profanity', severity: 50},
      {id: 'r2', category: 'profanity', severity: 30},
    ];
    const result = await call('src/scorer.mjs', 'scoreRisk', [matches]);
    // Each: severity * weight(10). profanity: (50+30)*10 = 800
    eq(result.compositeScore, 800);
    eq(result.categoryScores.profanity, 800);
    eq(result.decision, 'allow');  // 800 < 2500
    eq(result.matchCount, 2);
  });

  await test('Score with custom weights triggers flag', async () => {
    const matches = [{id: 'r1', category: 'threat', severity: 80}];
    const result = await call('src/scorer.mjs', 'scoreRisk', [matches, {threat: 50}]);
    // 80 * 50 = 4000
    eq(result.compositeScore, 4000);
    eq(result.decision, 'flag');  // 2500 <= 4000 < 7500
  });

  await test('Score block threshold', async () => {
    const matches = [{id: 'r1', category: 'threat', severity: 100}];
    const result = await call('src/scorer.mjs', 'scoreRisk', [matches, {threat: 100}]);
    // 100 * 100 = 10000, capped at 10000
    eq(result.compositeScore, 10000);
    eq(result.decision, 'block');
  });

  await test('Score rejects invalid thresholds', async () => {
    let threw = false;
    try { await call('src/scorer.mjs', 'scoreRisk', [[], {}, {flag: 5000, block: 3000}]); } catch { threw = true; }
    if (!threw) throw new Error('Expected rejection when flag >= block');
  });

  await test('Score boundary: exactly at flag', async () => {
    const matches = [{id: 'r1', category: 'profanity', severity: 25}];
    const result = await call('src/scorer.mjs', 'scoreRisk', [matches, {profanity: 100}, {flag: 2500, block: 7500}]);
    eq(result.compositeScore, 2500);
    eq(result.decision, 'flag');
  });

  // === Integration: classify ===
  await test('classify is synchronous and integrates all modules', async () => {
    const rules = [
      {id: 'test1', pattern: 'spam', category: 'spam', severity: 30, mode: 'unanchored'}
    ];
    const result = await call('src/index.mjs', 'classify', ['this is spam content', rules]);
    eq(result.decision, 'allow');
    eq(result.matchCount, 1);
    eq(typeof result.redacted, 'string');
    eq(result.redacted.includes('[REDACTED]'), true);
  });

  await test('classify handles homoglyph evasion', async () => {
    const rules = [{id: 'homo1', pattern: 'test', category: 'profanity', severity: 50, mode: 'unanchored'}];
    // Cyrillic е (0x0435) and ѕ (0x0455) to evade
    const result = await call('src/index.mjs', 'classify', ['tеst', rules]);
    eq(result.matchCount, 1);
  });

  await test('No mutation of rules or options in classify', async () => {
    const rules = [{id: 'mut1', pattern: 'test', category: 'spam', severity: 10, mode: 'unanchored'}];
    const options = {weights: {spam: 5}, thresholds: {flag: 100, block: 500}};
    const rulesCopy = JSON.parse(JSON.stringify(rules));
    const optsCopy = JSON.parse(JSON.stringify(options));
    await call('src/index.mjs', 'classify', ['test data', rules, options], {immutable: true});
    eq(rules, rulesCopy);
    eq(options, optsCopy);
  });
}
