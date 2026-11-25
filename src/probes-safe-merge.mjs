export async function runSafeMergeProbes({call, test, eq}) {
  const rejects = async (fn) => { let threw = false; try { await fn(); } catch { threw = true; } if (!threw) throw new Error('Expected rejection'); };
  const proto = (json) => JSON.parse(json); // own enumerable dangerous key, as from untrusted JSON

  // === keys.mjs ===
  await test('UNSAFE_KEYS is the exact dangerous-key set', async () => {
    const mod = await call('src/keys.mjs', 'isUnsafeKey', ['__proto__']); // force module load
    eq(mod, true);
    eq(await call('src/keys.mjs', 'isUnsafeKey', ['constructor']), true);
    eq(await call('src/keys.mjs', 'isUnsafeKey', ['prototype']), true);
    eq(await call('src/keys.mjs', 'isUnsafeKey', ['name']), false);
    eq(await call('src/keys.mjs', 'isUnsafeKey', ['']), false);
  });

  await test('assertSafeKey throws on dangerous keys, passes safe ones', async () => {
    for (const k of ['__proto__', 'constructor', 'prototype']) await rejects(() => call('src/keys.mjs', 'assertSafeKey', [k]));
    eq(await call('src/keys.mjs', 'assertSafeKey', ['username']), undefined);
  });

  // === clone.mjs ===
  await test('deepClone copies nested JSON data structurally', async () => {
    const input = {a: 1, b: {c: [1, 2, {d: 'x'}]}, e: null, f: true};
    eq(await call('src/clone.mjs', 'deepClone', [input]), input);
  });

  await test('deepClone does not mutate its input', async () => {
    const input = {a: {b: 1}, list: [1, 2, 3]};
    await call('src/clone.mjs', 'deepClone', [input], {immutable: true});
  });

  await test('deepClone rejects an own __proto__ key from untrusted JSON', async () => {
    await rejects(() => call('src/clone.mjs', 'deepClone', [proto('{"__proto__":{"polluted":true}}')]));
  });

  await test('deepClone rejects a nested __proto__ key at depth', async () => {
    await rejects(() => call('src/clone.mjs', 'deepClone', [proto('{"outer":{"__proto__":{"polluted":true}}}')]));
  });

  await test('deepClone rejects constructor and prototype keys', async () => {
    await rejects(() => call('src/clone.mjs', 'deepClone', [{constructor: {x: 1}}]));
    await rejects(() => call('src/clone.mjs', 'deepClone', [{nested: {prototype: {x: 1}}}]));
  });

  // === merge.mjs ===
  await test('deepMerge combines disjoint keys', async () => {
    eq(await call('src/merge.mjs', 'deepMerge', [{a: 1}, {b: 2}]), {a: 1, b: 2});
  });

  await test('deepMerge recurses into nested plain objects', async () => {
    eq(await call('src/merge.mjs', 'deepMerge', [{a: {x: 1, y: 2}}, {a: {y: 3, z: 4}}]), {a: {x: 1, y: 3, z: 4}});
  });

  await test('deepMerge replaces arrays as whole values', async () => {
    eq(await call('src/merge.mjs', 'deepMerge', [{a: [1, 2, 3]}, {a: [9]}]), {a: [9]});
  });

  await test('deepMerge overrides primitives with later source', async () => {
    eq(await call('src/merge.mjs', 'deepMerge', [{a: 1, b: 2}, {b: 99}]), {a: 1, b: 99});
  });

  await test('deepMerge mutates neither target nor source', async () => {
    await call('src/merge.mjs', 'deepMerge', [{a: {x: 1}}, {a: {y: 2}, b: 3}], {immutable: true});
  });

  await test('deepMerge rejects a top-level __proto__ injection', async () => {
    await rejects(() => call('src/merge.mjs', 'deepMerge', [{}, proto('{"__proto__":{"polluted":true}}')]));
  });

  await test('deepMerge rejects a nested __proto__ injection', async () => {
    await rejects(() => call('src/merge.mjs', 'deepMerge', [{a: {}}, proto('{"a":{"__proto__":{"polluted":true}}}')]));
  });

  await test('deepMerge rejects constructor and prototype injections', async () => {
    await rejects(() => call('src/merge.mjs', 'deepMerge', [{}, {constructor: {bad: 1}}]));
    await rejects(() => call('src/merge.mjs', 'deepMerge', [{}, {prototype: {bad: 1}}]));
  });

  await test('deepMerge rejects non-object arguments', async () => {
    await rejects(() => call('src/merge.mjs', 'deepMerge', [[1, 2], {a: 1}]));
    await rejects(() => call('src/merge.mjs', 'deepMerge', [{a: 1}, [1, 2]]));
    await rejects(() => call('src/merge.mjs', 'deepMerge', ['str', {a: 1}]));
  });

  // === index.mjs: setPath + mergeConfig ===
  await test('setPath sets a nested value and returns new structure', async () => {
    eq(await call('src/index.mjs', 'setPath', [{a: {b: 1}}, 'a.c', 2]), {a: {b: 1, c: 2}});
  });

  await test('setPath creates missing intermediate objects', async () => {
    eq(await call('src/index.mjs', 'setPath', [{}, 'x.y.z', 7]), {x: {y: {z: 7}}});
  });

  await test('setPath does not mutate the original object', async () => {
    await call('src/index.mjs', 'setPath', [{a: {b: 1}}, 'a.c', 2], {immutable: true});
  });

  await test('setPath rejects dangerous keys in the path', async () => {
    await rejects(() => call('src/index.mjs', 'setPath', [{}, '__proto__.polluted', true]));
    await rejects(() => call('src/index.mjs', 'setPath', [{}, 'a.constructor', 1]));
    await rejects(() => call('src/index.mjs', 'setPath', [{}, 'prototype', 1]));
  });

  await test('setPath rejects empty path and empty segments', async () => {
    await rejects(() => call('src/index.mjs', 'setPath', [{}, '', 1]));
    await rejects(() => call('src/index.mjs', 'setPath', [{}, 'a..b', 1]));
  });

  await test('mergeConfig deep-merges and rejects pollution', async () => {
    eq(await call('src/index.mjs', 'mergeConfig', [{a: {p: 1}}, {a: {q: 2}}]), {a: {p: 1, q: 2}});
    await rejects(() => call('src/index.mjs', 'mergeConfig', [{}, proto('{"__proto__":{"polluted":true}}')]));
  });
}
