export async function runFirmwareAnalyzerProbes({call, test, eq}) {
  // === ELF parsing ===
  await test('buildElfBuffer 32-bit LE round-trips through parseElfHeader', async () => {
    const buf = await call('src/elf.mjs', 'buildElfBuffer', [{elfClass: 1, endian: 1, type: 2, machine: 3, entry: 0x400000}]);
    const hdr = await call('src/elf.mjs', 'parseElfHeader', [buf]);
    eq(hdr.elfClass, 1);
    eq(hdr.is64, false);
    eq(hdr.littleEndian, true);
    eq(hdr.type, 2);
    eq(hdr.machine, 3);
    eq(hdr.entry, 0x400000);
  });

  await test('buildElfBuffer 64-bit LE round-trips through parseElfHeader', async () => {
    const buf = await call('src/elf.mjs', 'buildElfBuffer', [{elfClass: 2, endian: 1, type: 2, machine: 0x3E, entry: 0x401000}]);
    const hdr = await call('src/elf.mjs', 'parseElfHeader', [buf]);
    eq(hdr.elfClass, 2);
    eq(hdr.is64, true);
    eq(hdr.littleEndian, true);
    eq(hdr.type, 2);
    eq(hdr.machine, 0x3E);
    eq(hdr.entry, 0x401000);
  });

  await test('buildElfBuffer 32-bit BE round-trips', async () => {
    const buf = await call('src/elf.mjs', 'buildElfBuffer', [{elfClass: 1, endian: 2, type: 2, machine: 20, entry: 0x100000}]);
    const hdr = await call('src/elf.mjs', 'parseElfHeader', [buf]);
    eq(hdr.littleEndian, false);
    eq(hdr.machine, 20);
    eq(hdr.entry, 0x100000);
  });

  await test('parseElfHeader throws on bad magic', async () => {
    let threw = false;
    try {
      const bad = {type: 'Buffer', data: new Array(64).fill(0)};
      await call('src/elf.mjs', 'parseElfHeader', [bad]);
    } catch { threw = true; }
    if (!threw) throw new Error('Expected rejection for bad magic');
  });

  await test('parseElfHeader throws on buffer too small', async () => {
    let threw = false;
    try {
      await call('src/elf.mjs', 'parseElfHeader', [{type: 'Buffer', data: [0x7f, 0x45]}]);
    } catch { threw = true; }
    if (!threw) throw new Error('Expected rejection for small buffer');
  });

  await test('buildElfBuffer with sections sets shnum', async () => {
    const secs = [{}, {}, {}];
    const buf = await call('src/elf.mjs', 'buildElfBuffer', [{elfClass: 1, endian: 1, sections: secs}]);
    const hdr = await call('src/elf.mjs', 'parseElfHeader', [buf]);
    eq(hdr.shnum, 3);
  });

  await test('listSections returns correct count', async () => {
    const secs = [{}, {}];
    const buf = await call('src/elf.mjs', 'buildElfBuffer', [{elfClass: 1, endian: 1, sections: secs}]);
    const hdr = await call('src/elf.mjs', 'parseElfHeader', [buf]);
    const list = await call('src/elf.mjs', 'listSections', [buf, hdr]);
    eq(list.length, 2);
  });

  // === Pattern matching ===
  await test('findPattern finds single occurrence', async () => {
    const buf = {type: 'Buffer', data: [1, 2, 3, 4, 5]};
    const pat = {type: 'Buffer', data: [3, 4]};
    const r = await call('src/patterns.mjs', 'findPattern', [buf, pat]);
    eq(r.length, 1);
    eq(r[0], 2);
  });

  await test('findPattern finds multiple occurrences', async () => {
    const buf = {type: 'Buffer', data: [1, 2, 3, 2, 3]};
    const pat = {type: 'Buffer', data: [2, 3]};
    const r = await call('src/patterns.mjs', 'findPattern', [buf, pat]);
    eq(r.length, 2);
    eq(r[0], 1);
    eq(r[1], 3);
  });

  await test('findPattern finds at last valid position (no off-by-one)', async () => {
    const buf = {type: 'Buffer', data: [0, 0, 0, 0xAA, 0xBB]};
    const pat = {type: 'Buffer', data: [0xAA, 0xBB]};
    const r = await call('src/patterns.mjs', 'findPattern', [buf, pat]);
    eq(r.length, 1);
    eq(r[0], 3);
  });

  await test('findPattern empty result when no match', async () => {
    const buf = {type: 'Buffer', data: [1, 2, 3]};
    const pat = {type: 'Buffer', data: [9, 9]};
    const r = await call('src/patterns.mjs', 'findPattern', [buf, pat]);
    eq(r.length, 0);
  });

  await test('findUnsafeFunctions detects known signatures', async () => {
    const buf = {type: 'Buffer', data: [0x00, 0xe8, 0x00, 0x00, 0x00, 0x00, 0xff]};
    const r = await call('src/patterns.mjs', 'findUnsafeFunctions', [buf]);
    if (r.strcpy.length < 1) throw new Error('Expected strcpy signature match');
    eq(r.strcpy[0], 1);
  });

  await test('findBufferOverflow detects sub rsp + rep movs pair', async () => {
    const data = new Array(80).fill(0);
    data[10] = 0x48; data[11] = 0x83; data[12] = 0xec;
    data[30] = 0xf3; data[31] = 0xa4;
    const buf = {type: 'Buffer', data};
    const r = await call('src/patterns.mjs', 'findBufferOverflow', [buf]);
    eq(r.length, 1);
    eq(r[0].subRspOffset, 10);
    eq(r[0].repMovsOffset, 30);
    eq(r[0].distance, 20);
  });

  await test('matchSignatures finds custom pattern', async () => {
    const buf = {type: 'Buffer', data: [0xDE, 0xAD, 0xBE, 0xEF, 0x00]};
    const sigs = [{name: 'deadbeef', bytes: [0xDE, 0xAD, 0xBE, 0xEF], severity: 'high'}];
    const r = await call('src/patterns.mjs', 'matchSignatures', [buf, sigs]);
    eq(r.length, 1);
    eq(r[0].name, 'deadbeef');
    eq(r[0].severity, 'high');
    eq(r[0].positions[0], 0);
  });

  // === Control flow graphs ===
  await test('splitBasicBlocks branch creates new block at target', async () => {
    const insts = [
      {type: 'normal'},
      {type: 'branch', target: 3, unconditional: false},
      {type: 'normal'},
      {type: 'normal'},
      {type: 'ret'}
    ];
    const blocks = await call('src/cfg.mjs', 'splitBasicBlocks', [insts]);
    if (blocks.length < 3) throw new Error('Expected at least 3 blocks, got ' + blocks.length);
    const starts = blocks.map(b => b.start);
    if (!starts.includes(0)) throw new Error('Block at 0 missing');
    if (!starts.includes(2)) throw new Error('Fallthrough block at 2 missing');
    if (!starts.includes(3)) throw new Error('Target block at 3 missing');
  });

  await test('splitBasicBlocks empty input returns empty', async () => {
    const blocks = await call('src/cfg.mjs', 'splitBasicBlocks', [[]]);
    eq(blocks.length, 0);
  });

  await test('splitBasicBlocks single ret = one block', async () => {
    const blocks = await call('src/cfg.mjs', 'splitBasicBlocks', [[{type: 'ret'}]]);
    eq(blocks.length, 1);
    eq(blocks[0].start, 0);
  });

  await test('buildCFG branch adds edge to target and fallthrough', async () => {
    const insts = [
      {type: 'branch', target: 2, unconditional: false},
      {type: 'normal'},
      {type: 'ret'}
    ];
    const blocks = await call('src/cfg.mjs', 'splitBasicBlocks', [insts]);
    const cfg = await call('src/cfg.mjs', 'buildCFG', [blocks]);
    const fromZero = cfg.edges.filter(e => e.from === 0);
    const types = fromZero.map(e => e.type);
    if (!types.includes('branch')) throw new Error('Missing branch edge from block 0');
    if (!types.includes('fallthrough')) throw new Error('Missing fallthrough edge from block 0');
  });

  await test('buildCFG ret has no outgoing edge', async () => {
    const insts = [{type: 'normal'}, {type: 'ret'}];
    const blocks = await call('src/cfg.mjs', 'splitBasicBlocks', [insts]);
    const cfg = await call('src/cfg.mjs', 'buildCFG', [blocks]);
    const retBlock = blocks[blocks.length - 1];
    const outgoing = cfg.edges.filter(e => e.from === retBlock.id);
    eq(outgoing.length, 0);
  });

  await test('computeDominators entry dominates itself', async () => {
    const insts = [{type: 'branch', target: 2, unconditional: false}, {type: 'normal'}, {type: 'ret'}];
    const blocks = await call('src/cfg.mjs', 'splitBasicBlocks', [insts]);
    const cfg = await call('src/cfg.mjs', 'buildCFG', [blocks]);
    const doms = await call('src/cfg.mjs', 'computeDominators', [cfg]);
    eq(doms[0], 0);
  });

  await test('detectLoops finds back edge in loop', async () => {
    const insts = [
      {type: 'normal'},
      {type: 'branch', target: 0, unconditional: false},
      {type: 'ret'}
    ];
    const blocks = await call('src/cfg.mjs', 'splitBasicBlocks', [insts]);
    const cfg = await call('src/cfg.mjs', 'buildCFG', [blocks]);
    const backEdges = await call('src/cfg.mjs', 'detectLoops', [cfg]);
    if (backEdges.length < 1) throw new Error('Expected at least one back edge for a loop');
  });

  await test('detectLoops no back edges in linear code', async () => {
    const insts = [{type: 'normal'}, {type: 'normal'}, {type: 'ret'}];
    const blocks = await call('src/cfg.mjs', 'splitBasicBlocks', [insts]);
    const cfg = await call('src/cfg.mjs', 'buildCFG', [blocks]);
    const backEdges = await call('src/cfg.mjs', 'detectLoops', [cfg]);
    eq(backEdges.length, 0);
  });

  await test('cyclomaticComplexity E - N + 2', async () => {
    const cfg = {blocks: [{id:0},{id:1},{id:2}], edges: [{from:0,to:1},{from:0,to:2},{from:1,to:2}]};
    const cc = await call('src/cfg.mjs', 'cyclomaticComplexity', [cfg]);
    eq(cc, 3 - 3 + 2);
  });

  // === Binary diffing ===
  await test('hashFunction returns hex string', async () => {
    const func = {blocks: [{bytes: [1, 2, 3], instructions: []}]};
    const h = await call('src/bindiff.mjs', 'hashFunction', [func]);
    eq(typeof h, 'string');
    eq(h.length, 64);
  });

  await test('hashFunction different bytes = different hash', async () => {
    const f1 = {blocks: [{bytes: [1, 2, 3], instructions: []}]};
    const f2 = {blocks: [{bytes: [4, 5, 6], instructions: []}]};
    const h1 = await call('src/bindiff.mjs', 'hashFunction', [f1]);
    const h2 = await call('src/bindiff.mjs', 'hashFunction', [f2]);
    if (h1 === h2) throw new Error('Expected different hashes for different bytes');
  });

  await test('matchFunctions identical hash = identical type', async () => {
    const funcs = [{name: 'foo', blocks: [{bytes: [1,2,3]}]}, {name: 'bar', blocks: [{bytes: [4,5,6]}]}];
    const r = await call('src/bindiff.mjs', 'matchFunctions', [funcs, funcs]);
    const fooMatch = r.find(m => m.old === 'foo');
    eq(fooMatch.type, 'identical');
  });

  await test('matchFunctions modified by name when hash differs', async () => {
    const old = [{name: 'foo', blocks: [{bytes: [1,2,3]}]}];
    const nw = [{name: 'foo', blocks: [{bytes: [4,5,6]}]}];
    const r = await call('src/bindiff.mjs', 'matchFunctions', [old, nw]);
    const m = r.find(x => x.old === 'foo');
    eq(m.type, 'modified');
  });

  await test('matchFunctions removed when not in new', async () => {
    const old = [{name: 'gone', blocks: [{bytes: [1]}]}];
    const nw = [{name: 'other', blocks: [{bytes: [2]}]}];
    const r = await call('src/bindiff.mjs', 'matchFunctions', [old, nw]);
    const m = r.find(x => x.old === 'gone');
    eq(m.type, 'removed');
    eq(m.new, null);
  });

  await test('matchFunctions added when not in old', async () => {
    const old = [{name: 'existing', blocks: [{bytes: [1]}]}];
    const nw = [{name: 'existing', blocks: [{bytes: [1]}]}, {name: 'brand_new', blocks: [{bytes: [9]}]}];
    const r = await call('src/bindiff.mjs', 'matchFunctions', [old, nw]);
    const m = r.find(x => x.new === 'brand_new');
    eq(m.type, 'added');
    eq(m.old, null);
  });

  await test('diffScore changed = total - matched, not matched count', async () => {
    const h1 = 'aaa';
    const h2 = 'bbb';
    const oldF = {blocks: [{hash: h1}, {hash: h2}, {hash: 'ccc'}]};
    const newF = {blocks: [{hash: h1}, {hash: h2}, {hash: 'ddd'}, {hash: 'eee'}]};
    const r = await call('src/bindiff.mjs', 'diffScore', [oldF, newF]);
    eq(r.total, 4);
    eq(r.matched, 2);
    eq(r.changed, 2);
  });

  await test('diffScore score = changed/total (change ratio)', async () => {
    const oldF = {blocks: [{hash: 'a'}, {hash: 'b'}]};
    const newF = {blocks: [{hash: 'a'}, {hash: 'c'}]};
    const r = await call('src/bindiff.mjs', 'diffScore', [oldF, newF]);
    eq(r.total, 2);
    eq(r.matched, 1);
    eq(r.changed, 1);
    eq(r.score, 0.5);
  });

  await test('generateChangelog correct statuses', async () => {
    const matches = [
      {old: 'f1', new: 'f1', type: 'identical'},
      {old: 'f2', new: 'f2', type: 'modified'},
      {old: null, new: 'f3', type: 'added'},
      {old: 'f4', new: null, type: 'removed'}
    ];
    const cl = await call('src/bindiff.mjs', 'generateChangelog', [matches]);
    eq(cl[0].status, 'unchanged');
    eq(cl[1].status, 'modified');
    eq(cl[2].status, 'added');
    eq(cl[3].status, 'removed');
  });
}
