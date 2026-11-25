import crypto from 'node:crypto';

export async function runSynthPlannerProbes({call, test, eq}) {
  // --- molecule.mjs ---

  await test('createMolecule returns frozen object with atoms, bonds, adjacency', async () => {
    const mol = await call('src/molecule.mjs', 'createMolecule', [
      [{id:'O1',element:'O'},{id:'H1',element:'H'},{id:'H2',element:'H'}],
      [{from:'H1',to:'O1',order:1},{from:'H2',to:'O1',order:1}]
    ]);
    eq(mol.atoms.length, 3);
    eq(mol.bonds.length, 2);
    eq(typeof mol.adjacency, 'object');
  });

  await test('createMolecule builds bidirectional adjacency list', async () => {
    const mol = await call('src/molecule.mjs', 'createMolecule', [
      [{id:'O1',element:'O'},{id:'H1',element:'H'},{id:'H2',element:'H'}],
      [{from:'H1',to:'O1',order:1},{from:'H2',to:'O1',order:1}]
    ]);
    eq(mol.adjacency['O1'].length, 2);
    eq(mol.adjacency['H1'].length, 1);
    eq(mol.adjacency['H1'][0].neighbor, 'O1');
    eq(mol.adjacency['H2'][0].neighbor, 'O1');
  });

  await test('createMolecule defaults charge to 0', async () => {
    const mol = await call('src/molecule.mjs', 'createMolecule', [
      [{id:'A',element:'H'}],
      []
    ]);
    eq(mol.atoms[0].charge, 0);
  });

  await test('createMolecule throws on duplicate atom IDs', async () => {
    let threw = false;
    try {
      await call('src/molecule.mjs', 'createMolecule', [
        [{id:'A',element:'H'},{id:'A',element:'C'}],
        []
      ]);
    } catch { threw = true; }
    eq(threw, true);
  });

  await test('createMolecule throws on bond referencing nonexistent atom', async () => {
    let threw = false;
    try {
      await call('src/molecule.mjs', 'createMolecule', [
        [{id:'A',element:'H'}],
        [{from:'A',to:'B',order:1}]
      ]);
    } catch { threw = true; }
    eq(threw, true);
  });

  await test('createMolecule throws on self-loop', async () => {
    let threw = false;
    try {
      await call('src/molecule.mjs', 'createMolecule', [
        [{id:'A',element:'H'}],
        [{from:'A',to:'A',order:1}]
      ]);
    } catch { threw = true; }
    eq(threw, true);
  });

  await test('createMolecule throws on invalid bond order', async () => {
    let threw = false;
    try {
      await call('src/molecule.mjs', 'createMolecule', [
        [{id:'A',element:'H'},{id:'B',element:'H'}],
        [{from:'A',to:'B',order:5}]
      ]);
    } catch { threw = true; }
    eq(threw, true);
  });

  await test('molecularWeight of water = 18.015', async () => {
    const mol = await call('src/molecule.mjs', 'createMolecule', [
      [{id:'O1',element:'O'},{id:'H1',element:'H'},{id:'H2',element:'H'}],
      [{from:'H1',to:'O1',order:1},{from:'H2',to:'O1',order:1}]
    ]);
    const mw = await call('src/molecule.mjs', 'molecularWeight', [mol]);
    eq(mw, 18.015);
  });

  await test('molecularWeight of ethanol = 46.069', async () => {
    const mol = await call('src/molecule.mjs', 'createMolecule', [
      [{id:'C1',element:'C'},{id:'C2',element:'C'},{id:'O1',element:'O'},
       {id:'H1',element:'H'},{id:'H2',element:'H'},{id:'H3',element:'H'},
       {id:'H4',element:'H'},{id:'H5',element:'H'},{id:'H6',element:'H'}],
      [{from:'C1',to:'C2',order:1},{from:'C2',to:'O1',order:1},{from:'O1',to:'H6',order:1},
       {from:'C1',to:'H1',order:1},{from:'C1',to:'H2',order:1},{from:'C1',to:'H3',order:1},
       {from:'C2',to:'H4',order:1},{from:'C2',to:'H5',order:1}]
    ]);
    const mw = await call('src/molecule.mjs', 'molecularWeight', [mol]);
    eq(mw, 46.069);
  });

  await test('molecularWeight throws on unknown element', async () => {
    const mol = await call('src/molecule.mjs', 'createMolecule', [
      [{id:'X1',element:'Zz'}], []
    ]);
    let threw = false;
    try { await call('src/molecule.mjs', 'molecularWeight', [mol]); }
    catch { threw = true; }
    eq(threw, true);
  });

  await test('fingerprint returns sorted hex string array', async () => {
    const mol = await call('src/molecule.mjs', 'createMolecule', [
      [{id:'O1',element:'O'},{id:'H1',element:'H'},{id:'H2',element:'H'}],
      [{from:'H1',to:'O1',order:1},{from:'H2',to:'O1',order:1}]
    ]);
    const fp = await call('src/molecule.mjs', 'fingerprint', [mol]);
    eq(Array.isArray(fp), true);
    eq(fp.length > 0, true);
    eq(fp.every(s => /^[0-9a-f]{32}$/.test(s)), true);
    const sorted = [...fp].sort();
    eq(fp, sorted);
  });

  await test('fingerprint is deterministic', async () => {
    const atoms = [{id:'C1',element:'C'},{id:'H1',element:'H'},{id:'H2',element:'H'},
                   {id:'H3',element:'H'},{id:'H4',element:'H'}];
    const bonds = [{from:'C1',to:'H1',order:1},{from:'C1',to:'H2',order:1},
                   {from:'C1',to:'H3',order:1},{from:'C1',to:'H4',order:1}];
    const mol = await call('src/molecule.mjs', 'createMolecule', [atoms, bonds]);
    const fp1 = await call('src/molecule.mjs', 'fingerprint', [mol]);
    const fp2 = await call('src/molecule.mjs', 'fingerprint', [mol]);
    eq(fp1, fp2);
  });

  await test('fingerprint includes radius-0 element hashes', async () => {
    const mol = await call('src/molecule.mjs', 'createMolecule', [
      [{id:'O1',element:'O'},{id:'H1',element:'H'}],
      [{from:'O1',to:'H1',order:1}]
    ]);
    const fp = await call('src/molecule.mjs', 'fingerprint', [mol]);
    const hashO = crypto.createHash('md5').update('O').digest('hex');
    const hashH = crypto.createHash('md5').update('H').digest('hex');
    eq(fp.includes(hashO), true);
    eq(fp.includes(hashH), true);
  });

  await test('similarity of identical fingerprints is 1.0', async () => {
    const mol = await call('src/molecule.mjs', 'createMolecule', [
      [{id:'O1',element:'O'},{id:'H1',element:'H'}],
      [{from:'O1',to:'H1',order:1}]
    ]);
    const fp = await call('src/molecule.mjs', 'fingerprint', [mol]);
    const sim = await call('src/molecule.mjs', 'similarity', [fp, fp]);
    eq(sim, 1.0);
  });

  await test('similarity of empty fingerprints is 1.0', async () => {
    const sim = await call('src/molecule.mjs', 'similarity', [[], []]);
    eq(sim, 1.0);
  });

  await test('similarity of disjoint fingerprints is 0', async () => {
    const sim = await call('src/molecule.mjs', 'similarity', [['aaa'], ['bbb']]);
    eq(sim, 0);
  });

  // --- groups.mjs ---

  await test('detectGroups finds hydroxyl in ethanol', async () => {
    const mol = await call('src/molecule.mjs', 'createMolecule', [
      [{id:'C1',element:'C'},{id:'C2',element:'C'},{id:'O1',element:'O'},
       {id:'H1',element:'H'},{id:'H2',element:'H'},{id:'H3',element:'H'},
       {id:'H4',element:'H'},{id:'H5',element:'H'},{id:'H6',element:'H'}],
      [{from:'C1',to:'C2',order:1},{from:'C2',to:'O1',order:1},{from:'O1',to:'H6',order:1},
       {from:'C1',to:'H1',order:1},{from:'C1',to:'H2',order:1},{from:'C1',to:'H3',order:1},
       {from:'C2',to:'H4',order:1},{from:'C2',to:'H5',order:1}]
    ]);
    const groups = await call('src/groups.mjs', 'detectGroups', [mol]);
    const hydroxyl = groups.filter(g => g.group === 'hydroxyl');
    eq(hydroxyl.length, 1);
    eq(hydroxyl[0].atoms, ['O1', 'H6']);
  });

  await test('detectGroups finds carbonyl in formaldehyde', async () => {
    const mol = await call('src/molecule.mjs', 'createMolecule', [
      [{id:'C1',element:'C'},{id:'O1',element:'O'},{id:'H1',element:'H'},{id:'H2',element:'H'}],
      [{from:'C1',to:'O1',order:2},{from:'C1',to:'H1',order:1},{from:'C1',to:'H2',order:1}]
    ]);
    const groups = await call('src/groups.mjs', 'detectGroups', [mol]);
    const carbonyl = groups.filter(g => g.group === 'carbonyl');
    eq(carbonyl.length, 1);
    eq(carbonyl[0].atoms, ['C1', 'O1']);
  });

  await test('detectGroups finds carboxyl and subsumes carbonyl+hydroxyl', async () => {
    const mol = await call('src/molecule.mjs', 'createMolecule', [
      [{id:'C1',element:'C'},{id:'C2',element:'C'},{id:'O1',element:'O'},{id:'O2',element:'O'},
       {id:'H1',element:'H'},{id:'H2',element:'H'},{id:'H3',element:'H'},{id:'H4',element:'H'}],
      [{from:'C1',to:'C2',order:1},{from:'C2',to:'O1',order:2},{from:'C2',to:'O2',order:1},
       {from:'O2',to:'H4',order:1},{from:'C1',to:'H1',order:1},{from:'C1',to:'H2',order:1},
       {from:'C1',to:'H3',order:1}]
    ]);
    const groups = await call('src/groups.mjs', 'detectGroups', [mol]);
    const carboxyl = groups.filter(g => g.group === 'carboxyl');
    eq(carboxyl.length, 1);
    eq(carboxyl[0].atoms, ['C2', 'O1', 'O2', 'H4']);
    eq(groups.filter(g => g.group === 'carbonyl').length, 0);
    eq(groups.filter(g => g.group === 'hydroxyl').length, 0);
  });

  await test('detectGroups finds amine', async () => {
    const mol = await call('src/molecule.mjs', 'createMolecule', [
      [{id:'C1',element:'C'},{id:'N1',element:'N'},
       {id:'H1',element:'H'},{id:'H2',element:'H'},{id:'H3',element:'H'},
       {id:'H4',element:'H'},{id:'H5',element:'H'}],
      [{from:'C1',to:'N1',order:1},{from:'C1',to:'H1',order:1},{from:'C1',to:'H2',order:1},
       {from:'C1',to:'H3',order:1},{from:'N1',to:'H4',order:1},{from:'N1',to:'H5',order:1}]
    ]);
    const groups = await call('src/groups.mjs', 'detectGroups', [mol]);
    const amine = groups.filter(g => g.group === 'amine');
    eq(amine.length, 1);
    const sorted = [...amine[0].atoms].sort();
    eq(amine[0].atoms, sorted);
    eq(amine[0].atoms.includes('N1'), true);
    eq(amine[0].atoms.includes('C1'), true);
    eq(amine[0].atoms.includes('H4'), true);
  });

  await test('detectGroups finds thiol', async () => {
    const mol = await call('src/molecule.mjs', 'createMolecule', [
      [{id:'C1',element:'C'},{id:'S1',element:'S'},
       {id:'H1',element:'H'},{id:'H2',element:'H'},{id:'H3',element:'H'},{id:'H4',element:'H'}],
      [{from:'C1',to:'S1',order:1},{from:'C1',to:'H1',order:1},{from:'C1',to:'H2',order:1},
       {from:'C1',to:'H3',order:1},{from:'S1',to:'H4',order:1}]
    ]);
    const groups = await call('src/groups.mjs', 'detectGroups', [mol]);
    const thiol = groups.filter(g => g.group === 'thiol');
    eq(thiol.length, 1);
    eq(thiol[0].atoms, ['S1', 'H4']);
  });

  await test('detectGroups result is sorted by group name then first atom', async () => {
    const mol = await call('src/molecule.mjs', 'createMolecule', [
      [{id:'C1',element:'C'},{id:'O1',element:'O'},{id:'H1',element:'H'},{id:'H2',element:'H'},
       {id:'S1',element:'S'},{id:'H3',element:'H'},{id:'C2',element:'C'},{id:'H4',element:'H'},
       {id:'H5',element:'H'},{id:'H6',element:'H'}],
      [{from:'C1',to:'O1',order:1},{from:'O1',to:'H1',order:1},{from:'C1',to:'H2',order:1},
       {from:'C2',to:'S1',order:1},{from:'S1',to:'H3',order:1},{from:'C2',to:'H4',order:1},
       {from:'C2',to:'H5',order:1},{from:'C2',to:'H6',order:1},{from:'C1',to:'C2',order:1}]
    ]);
    const groups = await call('src/groups.mjs', 'detectGroups', [mol]);
    eq(groups.length >= 2, true);
    for (let i = 1; i < groups.length; i++) {
      const cmp = groups[i-1].group.localeCompare(groups[i].group);
      if (cmp === 0) {
        eq(groups[i-1].atoms[0] <= groups[i].atoms[0], true);
      } else {
        eq(cmp < 0, true);
      }
    }
  });

  await test('classifyReactivity scores electrophilic and nucleophilic', async () => {
    const groups = [
      {group:'carbonyl', atoms:['C1','O1']},
      {group:'hydroxyl', atoms:['O2','H1']},
      {group:'thiol', atoms:['S1','H2']}
    ];
    const r = await call('src/groups.mjs', 'classifyReactivity', [groups]);
    eq(r.electrophilic, 5);
    eq(r.nucleophilic, 10);
  });

  // --- transforms.mjs ---

  await test('applyTransform splits ethane into two fragments', async () => {
    const mol = await call('src/molecule.mjs', 'createMolecule', [
      [{id:'C1',element:'C'},{id:'C2',element:'C'},
       {id:'H1',element:'H'},{id:'H2',element:'H'},{id:'H3',element:'H'},
       {id:'H4',element:'H'},{id:'H5',element:'H'},{id:'H6',element:'H'}],
      [{from:'C1',to:'C2',order:1},
       {from:'C1',to:'H1',order:1},{from:'C1',to:'H2',order:1},{from:'C1',to:'H3',order:1},
       {from:'C2',to:'H4',order:1},{from:'C2',to:'H5',order:1},{from:'C2',to:'H6',order:1}]
    ]);
    const rule = {
      bondIndex: 0,
      products: [
        {atomIds: ['C1','H1','H2','H3']},
        {atomIds: ['C2','H4','H5','H6']}
      ]
    };
    const products = await call('src/transforms.mjs', 'applyTransform', [mol, rule]);
    eq(products.length, 2);
    eq(products[0].atoms.length, 4);
    eq(products[1].atoms.length, 4);
    eq(products[0].bonds.length, 3);
    eq(products[1].bonds.length, 3);
  });

  await test('applyTransform throws on invalid bondIndex', async () => {
    const mol = await call('src/molecule.mjs', 'createMolecule', [
      [{id:'A',element:'H'},{id:'B',element:'H'}],
      [{from:'A',to:'B',order:1}]
    ]);
    let threw = false;
    try {
      await call('src/transforms.mjs', 'applyTransform', [mol, {bondIndex:99, products:[]}]);
    } catch { threw = true; }
    eq(threw, true);
  });

  await test('applyTransform throws on nonexistent atomId in products', async () => {
    const mol = await call('src/molecule.mjs', 'createMolecule', [
      [{id:'A',element:'H'},{id:'B',element:'H'}],
      [{from:'A',to:'B',order:1}]
    ]);
    let threw = false;
    try {
      await call('src/transforms.mjs', 'applyTransform', [mol, {bondIndex:0, products:[{atomIds:['A','NOPE']}]}]);
    } catch { threw = true; }
    eq(threw, true);
  });

  await test('generatePrecursors returns results for valid rules', async () => {
    const mol = await call('src/molecule.mjs', 'createMolecule', [
      [{id:'C1',element:'C'},{id:'C2',element:'C'},
       {id:'H1',element:'H'},{id:'H2',element:'H'},{id:'H3',element:'H'},
       {id:'H4',element:'H'},{id:'H5',element:'H'},{id:'H6',element:'H'}],
      [{from:'C1',to:'C2',order:1},
       {from:'C1',to:'H1',order:1},{from:'C1',to:'H2',order:1},{from:'C1',to:'H3',order:1},
       {from:'C2',to:'H4',order:1},{from:'C2',to:'H5',order:1},{from:'C2',to:'H6',order:1}]
    ]);
    const rules = [
      {bondIndex:0, products:[{atomIds:['C1','H1','H2','H3']},{atomIds:['C2','H4','H5','H6']}]},
      {bondIndex:99, products:[{atomIds:['C1']}]}
    ];
    const results = await call('src/transforms.mjs', 'generatePrecursors', [mol, rules]);
    eq(results.length, 1);
    eq(results[0].ruleIndex, 0);
    eq(results[0].precursors.length, 2);
  });

  await test('scoreTransform computes correct score without availability', async () => {
    const mol = await call('src/molecule.mjs', 'createMolecule', [
      [{id:'C1',element:'C'},{id:'H1',element:'H'},{id:'H2',element:'H'},{id:'H3',element:'H'}],
      [{from:'C1',to:'H1',order:1},{from:'C1',to:'H2',order:1},{from:'C1',to:'H3',order:1}]
    ]);
    const mol2 = await call('src/molecule.mjs', 'createMolecule', [
      [{id:'C2',element:'C'},{id:'H4',element:'H'},{id:'H5',element:'H'},{id:'H6',element:'H'}],
      [{from:'C2',to:'H4',order:1},{from:'C2',to:'H5',order:1},{from:'C2',to:'H6',order:1}]
    ]);
    const transform = {ruleIndex:0, precursors:[mol, mol2]};
    const s = await call('src/transforms.mjs', 'scoreTransform', [transform, {}]);
    eq(s.steps, 1);
    eq(s.complexity, 8);
    eq(s.availability, 0);
    eq(s.score, 1.8);
  });

  await test('scoreTransform with availability in DB', async () => {
    const mol = await call('src/molecule.mjs', 'createMolecule', [
      [{id:'C1',element:'C'},{id:'H1',element:'H'},{id:'H2',element:'H'},{id:'H3',element:'H'}],
      [{from:'C1',to:'H1',order:1},{from:'C1',to:'H2',order:1},{from:'C1',to:'H3',order:1}]
    ]);
    const transform = {ruleIndex:0, precursors:[mol]};
    const db = {'C,H,H,H': true};
    const s = await call('src/transforms.mjs', 'scoreTransform', [transform, db]);
    eq(s.availability, 1);
    eq(s.score, 1 + 4/10 - 1*5);
  });

  // --- search.mjs ---

  await test('buildTree creates root with molecule', async () => {
    const mol = await call('src/molecule.mjs', 'createMolecule', [
      [{id:'A',element:'H'},{id:'B',element:'H'}],
      [{from:'A',to:'B',order:1}]
    ]);
    const tree = await call('src/search.mjs', 'buildTree', [mol, [], {}]);
    eq(tree.molecule.atoms.length, 2);
    eq(tree.depth, 0);
  });

  await test('buildTree marks available molecules', async () => {
    const mol = await call('src/molecule.mjs', 'createMolecule', [
      [{id:'A',element:'H'},{id:'B',element:'H'}],
      [{from:'A',to:'B',order:1}]
    ]);
    const db = {'H,H': true};
    const tree = await call('src/search.mjs', 'buildTree', [mol, [], {availabilityDB: db}]);
    eq(tree.available, true);
  });

  await test('buildTree expands non-available nodes with precursors', async () => {
    const mol = await call('src/molecule.mjs', 'createMolecule', [
      [{id:'C1',element:'C'},{id:'C2',element:'C'},
       {id:'H1',element:'H'},{id:'H2',element:'H'},{id:'H3',element:'H'},
       {id:'H4',element:'H'},{id:'H5',element:'H'},{id:'H6',element:'H'}],
      [{from:'C1',to:'C2',order:1},
       {from:'C1',to:'H1',order:1},{from:'C1',to:'H2',order:1},{from:'C1',to:'H3',order:1},
       {from:'C2',to:'H4',order:1},{from:'C2',to:'H5',order:1},{from:'C2',to:'H6',order:1}]
    ]);
    const rules = [
      {bondIndex:0, products:[{atomIds:['C1','H1','H2','H3']},{atomIds:['C2','H4','H5','H6']}]}
    ];
    const db = {'C,H,H,H': true};
    const tree = await call('src/search.mjs', 'buildTree', [mol, rules, {maxDepth:1, availabilityDB:db}]);
    eq(tree.children.length >= 1, true);
  });

  await test('extractRoutes finds complete route when leaves are available', async () => {
    const mol = await call('src/molecule.mjs', 'createMolecule', [
      [{id:'C1',element:'C'},{id:'C2',element:'C'},
       {id:'H1',element:'H'},{id:'H2',element:'H'},{id:'H3',element:'H'},
       {id:'H4',element:'H'},{id:'H5',element:'H'},{id:'H6',element:'H'}],
      [{from:'C1',to:'C2',order:1},
       {from:'C1',to:'H1',order:1},{from:'C1',to:'H2',order:1},{from:'C1',to:'H3',order:1},
       {from:'C2',to:'H4',order:1},{from:'C2',to:'H5',order:1},{from:'C2',to:'H6',order:1}]
    ]);
    const rules = [
      {bondIndex:0, products:[{atomIds:['C1','H1','H2','H3']},{atomIds:['C2','H4','H5','H6']}]}
    ];
    const db = {'C,H,H,H': true};
    const tree = await call('src/search.mjs', 'buildTree', [mol, rules, {maxDepth:2, availabilityDB:db}]);
    const routes = await call('src/search.mjs', 'extractRoutes', [tree]);
    eq(routes.length >= 1, true);
    eq(routes[0].totalSteps >= 1, true);
  });

  await test('extractRoutes returns empty when no complete route', async () => {
    const mol = await call('src/molecule.mjs', 'createMolecule', [
      [{id:'A',element:'H'},{id:'B',element:'H'}],
      [{from:'A',to:'B',order:1}]
    ]);
    const tree = await call('src/search.mjs', 'buildTree', [mol, [], {maxDepth:1}]);
    const routes = await call('src/search.mjs', 'extractRoutes', [tree]);
    eq(routes.length, 0);
  });

  await test('rankRoutes sorts by totalSteps ascending', async () => {
    const routes = [
      {steps:[], totalSteps:3, leafMolecules:[]},
      {steps:[], totalSteps:1, leafMolecules:[]},
      {steps:[], totalSteps:2, leafMolecules:[]}
    ];
    const ranked = await call('src/search.mjs', 'rankRoutes', [routes]);
    eq(ranked[0].totalSteps, 1);
    eq(ranked[1].totalSteps, 2);
    eq(ranked[2].totalSteps, 3);
  });

  await test('rankRoutes does not mutate input', async () => {
    const routes = [
      {steps:[], totalSteps:3, leafMolecules:['a','b','c']},
      {steps:[], totalSteps:1, leafMolecules:['x']}
    ];
    const ranked = await call('src/search.mjs', 'rankRoutes', [routes], {immutable:true});
    eq(ranked[0].totalSteps, 1);
  });

  // --- index.mjs ---

  await test('planSynthesis returns routes, bestRoute, and stats', async () => {
    const mol = await call('src/molecule.mjs', 'createMolecule', [
      [{id:'C1',element:'C'},{id:'C2',element:'C'},
       {id:'H1',element:'H'},{id:'H2',element:'H'},{id:'H3',element:'H'},
       {id:'H4',element:'H'},{id:'H5',element:'H'},{id:'H6',element:'H'}],
      [{from:'C1',to:'C2',order:1},
       {from:'C1',to:'H1',order:1},{from:'C1',to:'H2',order:1},{from:'C1',to:'H3',order:1},
       {from:'C2',to:'H4',order:1},{from:'C2',to:'H5',order:1},{from:'C2',to:'H6',order:1}]
    ]);
    const rules = [
      {bondIndex:0, products:[{atomIds:['C1','H1','H2','H3']},{atomIds:['C2','H4','H5','H6']}]}
    ];
    const db = {'C,H,H,H': true};
    const result = await call('src/index.mjs', 'planSynthesis', [mol, rules, {maxDepth:2, availabilityDB:db}]);
    eq(Array.isArray(result.routes), true);
    eq(result.routes.length >= 1, true);
    eq(result.bestRoute !== null, true);
    eq(typeof result.stats.totalRoutes, 'number');
    eq(typeof result.stats.maxDepth, 'number');
    eq(typeof result.stats.nodesExplored, 'number');
  });

  await test('planSynthesis returns null bestRoute when no routes exist', async () => {
    const mol = await call('src/molecule.mjs', 'createMolecule', [
      [{id:'A',element:'H'},{id:'B',element:'H'}],
      [{from:'A',to:'B',order:1}]
    ]);
    const result = await call('src/index.mjs', 'planSynthesis', [mol, [], {}]);
    eq(result.routes.length, 0);
    eq(result.bestRoute, null);
    eq(result.stats.totalRoutes, 0);
  });
}
