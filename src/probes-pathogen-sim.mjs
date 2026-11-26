// Pathogen simulation probes — genomics, epidemiology, phylogenetics, contact networks
export async function runPathogenSimProbes({call, test, eq}) {

  // ═══ GENOME MODULE ═══

  await test('validateSequence uppercases valid DNA', async () => {
    const r = await call('src/genome.mjs', 'validateSequence', ['atgc']);
    if (r !== 'ATGC') throw new Error('Expected ATGC, got ' + r);
  });

  await test('validateSequence rejects empty string', async () => {
    let threw = false;
    try { await call('src/genome.mjs', 'validateSequence', ['']); } catch { threw = true; }
    if (!threw) throw new Error('Expected throw on empty string');
  });

  await test('validateSequence rejects non-DNA characters', async () => {
    let threw = false;
    try { await call('src/genome.mjs', 'validateSequence', ['ATXG']); } catch { threw = true; }
    if (!threw) throw new Error('Expected throw on invalid base X');
  });

  await test('validateSequence rejects non-string input', async () => {
    let threw = false;
    try { await call('src/genome.mjs', 'validateSequence', [123]); } catch { threw = true; }
    if (!threw) throw new Error('Expected throw on non-string');
  });

  await test('gcContent computes correctly', async () => {
    const r = await call('src/genome.mjs', 'gcContent', ['ATGC']);
    if (r !== 0.5) throw new Error('Expected 0.5, got ' + r);
  });

  await test('gcContent all AT returns 0', async () => {
    const r = await call('src/genome.mjs', 'gcContent', ['AATT']);
    if (r !== 0) throw new Error('Expected 0, got ' + r);
  });

  await test('gcContent all GC returns 1', async () => {
    const r = await call('src/genome.mjs', 'gcContent', ['GGCC']);
    if (r !== 1) throw new Error('Expected 1, got ' + r);
  });

  await test('hammingDistance identical sequences is 0', async () => {
    const r = await call('src/genome.mjs', 'hammingDistance', ['ATGC', 'ATGC']);
    if (r !== 0) throw new Error('Expected 0, got ' + r);
  });

  await test('hammingDistance counts mismatches', async () => {
    const r = await call('src/genome.mjs', 'hammingDistance', ['ATGC', 'AAGC']);
    if (r !== 1) throw new Error('Expected 1, got ' + r);
  });

  await test('hammingDistance rejects unequal lengths', async () => {
    let threw = false;
    try { await call('src/genome.mjs', 'hammingDistance', ['ATG', 'ATGC']); } catch { threw = true; }
    if (!threw) throw new Error('Expected throw on unequal lengths');
  });

  await test('mutate applies substitutions', async () => {
    const r = await call('src/genome.mjs', 'mutate', ['ATGC', [{index: 1, base: 'A'}]]);
    if (r !== 'AAGC') throw new Error('Expected AAGC, got ' + r);
  });

  await test('mutate does not alter original', async () => {
    const seq = 'ATGC';
    await call('src/genome.mjs', 'mutate', [seq, [{index: 0, base: 'G'}]]);
    if (seq !== 'ATGC') throw new Error('Input was mutated');
  });

  await test('translateCodon ATG returns M', async () => {
    const r = await call('src/genome.mjs', 'translateCodon', ['ATG']);
    if (r !== 'M') throw new Error('Expected M, got ' + r);
  });

  await test('translateCodon TTT returns F', async () => {
    const r = await call('src/genome.mjs', 'translateCodon', ['TTT']);
    if (r !== 'F') throw new Error('Expected F, got ' + r);
  });

  await test('translateCodon TAA returns stop', async () => {
    const r = await call('src/genome.mjs', 'translateCodon', ['TAA']);
    if (r !== '*') throw new Error('Expected *, got ' + r);
  });

  await test('translateCodon TGG returns W', async () => {
    const r = await call('src/genome.mjs', 'translateCodon', ['TGG']);
    if (r !== 'W') throw new Error('Expected W, got ' + r);
  });

  await test('translateCodon case insensitive', async () => {
    const r = await call('src/genome.mjs', 'translateCodon', ['atg']);
    if (r !== 'M') throw new Error('Expected M, got ' + r);
  });

  await test('translate stops at stop codon', async () => {
    // ATG=M, TTT=F, TAA=stop → 'MF'
    const r = await call('src/genome.mjs', 'translate', ['ATGTTTTAA']);
    if (r !== 'MF') throw new Error('Expected MF, got ' + r);
  });

  await test('translate ignores trailing bases', async () => {
    // ATG=M, TTT=F + trailing AT → 'MF'
    const r = await call('src/genome.mjs', 'translate', ['ATGTTTAT']);
    if (r !== 'MF') throw new Error('Expected MF, got ' + r);
  });

  await test('translate full ORF', async () => {
    // ATG=M, GCT=A, GAA=E, TGA=stop → 'MAE'
    const r = await call('src/genome.mjs', 'translate', ['ATGGCTGAATGA']);
    if (r !== 'MAE') throw new Error('Expected MAE, got ' + r);
  });

  await test('reverseComplement of ATGC is GCAT', async () => {
    const r = await call('src/genome.mjs', 'reverseComplement', ['ATGC']);
    if (r !== 'GCAT') throw new Error('Expected GCAT, got ' + r);
  });

  await test('reverseComplement double application is identity', async () => {
    const r1 = await call('src/genome.mjs', 'reverseComplement', ['ATGCTA']);
    const r2 = await call('src/genome.mjs', 'reverseComplement', [r1]);
    if (r2 !== 'ATGCTA') throw new Error('Double RC should be identity, got ' + r2);
  });

  // ═══ POPULATION MODULE ═══

  await test('createSIR conserves population', async () => {
    const sir = await call('src/population.mjs', 'createSIR', [{population: 1000, infected: 10, recovered: 0, beta: 0.3, gamma: 0.1}]);
    if (sir.S + sir.I + sir.R !== 1000) throw new Error('S+I+R != N: ' + (sir.S + sir.I + sir.R));
  });

  await test('createSIR rejects invalid inputs', async () => {
    let threw = false;
    try { await call('src/population.mjs', 'createSIR', [{population: -5, infected: 1, beta: 0.3, gamma: 0.1}]); } catch { threw = true; }
    if (!threw) throw new Error('Expected throw on negative population');
  });

  await test('stepSIR conserves population', async () => {
    const sir = await call('src/population.mjs', 'createSIR', [{population: 10000, infected: 100, recovered: 0, beta: 0.3, gamma: 0.1}]);
    const next = await call('src/population.mjs', 'stepSIR', [sir, 1]);
    const sum = next.S + next.I + next.R;
    if (Math.abs(sum - 10000) > 0.01) throw new Error('Population not conserved: ' + sum);
  });

  await test('stepSIR infected increases early in epidemic', async () => {
    // R0 = 0.4/0.1 = 4, so infected should grow initially
    const s0 = await call('src/population.mjs', 'createSIR', [{population: 10000, infected: 10, recovered: 0, beta: 0.4, gamma: 0.1}]);
    const s1 = await call('src/population.mjs', 'stepSIR', [s0, 1]);
    if (s1.I <= s0.I) throw new Error('Infected should increase early: ' + s1.I + ' <= ' + s0.I);
    if (s1.S >= s0.S) throw new Error('Susceptible should decrease: ' + s1.S + ' >= ' + s0.S);
  });

  await test('simulateOutbreak returns timeline with correct length', async () => {
    const result = await call('src/population.mjs', 'simulateOutbreak', [{population: 1000, infected: 10, recovered: 0, beta: 0.3, gamma: 0.1}, 50, 1]);
    // timeline should have steps+1 entries (t=0 through t=50)
    if (result.timeline.length !== 51) throw new Error('Expected 51 timeline entries, got ' + result.timeline.length);
  });

  await test('simulateOutbreak peak I is positive', async () => {
    const result = await call('src/population.mjs', 'simulateOutbreak', [{population: 1000, infected: 10, recovered: 0, beta: 0.3, gamma: 0.1}, 100, 1]);
    if (result.peak.I <= 0) throw new Error('Peak I should be positive, got ' + result.peak.I);
  });

  await test('basicR0 computes beta/gamma', async () => {
    const r0 = await call('src/population.mjs', 'basicR0', [0.3, 0.1]);
    if (Math.abs(r0 - 3.0) > 0.001) throw new Error('Expected 3.0, got ' + r0);
  });

  await test('herdImmunityThreshold for R0=3 is ~0.667', async () => {
    const h = await call('src/population.mjs', 'herdImmunityThreshold', [3]);
    if (Math.abs(h - (1 - 1/3)) > 0.001) throw new Error('Expected ~0.667, got ' + h);
  });

  await test('herdImmunityThreshold for R0<1 is 0', async () => {
    const h = await call('src/population.mjs', 'herdImmunityThreshold', [0.5]);
    if (h !== 0) throw new Error('Expected 0, got ' + h);
  });

  // ═══ PHYLO MODULE ═══

  await test('distanceMatrix is symmetric with zero diagonal', async () => {
    const dm = await call('src/phylo.mjs', 'distanceMatrix', [['ATGC', 'AAGC', 'ATGC'], ['A', 'B', 'C']]);
    const m = dm.matrix;
    if (m[0][0] !== 0 || m[1][1] !== 0 || m[2][2] !== 0) throw new Error('Diagonal not zero');
    if (m[0][1] !== m[1][0]) throw new Error('Not symmetric');
    if (m[0][2] !== m[2][0]) throw new Error('Not symmetric');
  });

  await test('distanceMatrix computes p-distance correctly', async () => {
    // ATGC vs AAGC: 1 mismatch in 4 bases = 0.25
    const dm = await call('src/phylo.mjs', 'distanceMatrix', [['ATGC', 'AAGC'], ['A', 'B']]);
    if (Math.abs(dm.matrix[0][1] - 0.25) > 0.0001) throw new Error('Expected 0.25, got ' + dm.matrix[0][1]);
  });

  await test('jukesCantorCorrect applies formula', async () => {
    // d = -3/4 * ln(1 - 4*0.25/3) = -0.75 * ln(1/3) ≈ 0.8239
    const d = await call('src/phylo.mjs', 'jukesCantorCorrect', [0.25]);
    const expected = -0.75 * Math.log(1 - 4*0.25/3);
    if (Math.abs(d - expected) > 0.001) throw new Error('Expected ~' + expected.toFixed(4) + ', got ' + d);
  });

  await test('jukesCantorCorrect saturates at p>=0.75', async () => {
    const d = await call('src/phylo.mjs', 'jukesCantorCorrect', [0.75]);
    if (d !== Infinity) throw new Error('Expected Infinity, got ' + d);
  });

  await test('upgma produces tree with correct size', async () => {
    const dm = await call('src/phylo.mjs', 'distanceMatrix', [['ATGC', 'AAGC', 'TTGC'], ['A', 'B', 'C']]);
    const tree = await call('src/phylo.mjs', 'upgma', [dm]);
    if (tree.size !== 3) throw new Error('Expected root size 3, got ' + tree.size);
  });

  await test('upgma leaf nodes have height 0', async () => {
    const dm = await call('src/phylo.mjs', 'distanceMatrix', [['ATGC', 'ATGC'], ['X', 'Y']]);
    const tree = await call('src/phylo.mjs', 'upgma', [dm]);
    const checkLeaf = (node) => {
      if (node.label && node.height !== 0) throw new Error('Leaf height should be 0');
      if (node.left) checkLeaf(node.left);
      if (node.right) checkLeaf(node.right);
    };
    checkLeaf(tree);
  });

  await test('toNewick produces valid format with semicolon', async () => {
    const dm = await call('src/phylo.mjs', 'distanceMatrix', [['ATGC', 'AAGC'], ['A', 'B']]);
    const tree = await call('src/phylo.mjs', 'upgma', [dm]);
    const nw = await call('src/phylo.mjs', 'toNewick', [tree]);
    if (!nw.endsWith(';')) throw new Error('Newick should end with semicolon: ' + nw);
    if (!nw.includes('A') || !nw.includes('B')) throw new Error('Newick missing labels: ' + nw);
  });

  // ═══ NETWORK MODULE ═══

  await test('createNetwork makes n susceptible nodes', async () => {
    const net = await call('src/network.mjs', 'createNetwork', [5]);
    if (net.nodes.length !== 5) throw new Error('Expected 5 nodes, got ' + net.nodes.length);
    for (const n of net.nodes) {
      if (n.status !== 'susceptible') throw new Error('Node ' + n.id + ' not susceptible');
    }
  });

  await test('addEdge creates bidirectional edges', async () => {
    let net = await call('src/network.mjs', 'createNetwork', [3]);
    net = await call('src/network.mjs', 'addEdge', [net, 0, 1, 1]);
    // Should have 2 directed entries (0→1 and 1→0)
    if (net.edges.length !== 2) throw new Error('Expected 2 edges, got ' + net.edges.length);
    const has01 = net.edges.some(e => e.from === 0 && e.to === 1);
    const has10 = net.edges.some(e => e.from === 1 && e.to === 0);
    if (!has01 || !has10) throw new Error('Missing bidirectional edge');
  });

  await test('addEdge rejects self-loop', async () => {
    let net = await call('src/network.mjs', 'createNetwork', [3]);
    let threw = false;
    try { await call('src/network.mjs', 'addEdge', [net, 1, 1, 1]); } catch { threw = true; }
    if (!threw) throw new Error('Expected throw on self-loop');
  });

  await test('addEdge rejects duplicate', async () => {
    let net = await call('src/network.mjs', 'createNetwork', [3]);
    net = await call('src/network.mjs', 'addEdge', [net, 0, 1, 1]);
    let threw = false;
    try { await call('src/network.mjs', 'addEdge', [net, 0, 1, 1]); } catch { threw = true; }
    if (!threw) throw new Error('Expected throw on duplicate edge');
  });

  await test('generateERNetwork is deterministic', async () => {
    const net1 = await call('src/network.mjs', 'generateERNetwork', [10, 0.5, 'seed42']);
    const net2 = await call('src/network.mjs', 'generateERNetwork', [10, 0.5, 'seed42']);
    eq(net1.edges, net2.edges);
  });

  await test('generateERNetwork different seeds produce different graphs', async () => {
    const net1 = await call('src/network.mjs', 'generateERNetwork', [20, 0.5, 'alpha']);
    const net2 = await call('src/network.mjs', 'generateERNetwork', [20, 0.5, 'beta']);
    // Very unlikely to be identical with 20 nodes and p=0.5
    const e1 = JSON.stringify(net1.edges);
    const e2 = JSON.stringify(net2.edges);
    if (e1 === e2) throw new Error('Different seeds produced identical graphs');
  });

  await test('degreeCentrality sorted descending', async () => {
    let net = await call('src/network.mjs', 'createNetwork', [4]);
    net = await call('src/network.mjs', 'addEdge', [net, 0, 1, 1]);
    net = await call('src/network.mjs', 'addEdge', [net, 0, 2, 1]);
    net = await call('src/network.mjs', 'addEdge', [net, 0, 3, 1]);
    net = await call('src/network.mjs', 'addEdge', [net, 1, 2, 1]);
    const dc = await call('src/network.mjs', 'degreeCentrality', [net]);
    // Node 0 has degree 3, node 1 has 2, node 2 has 2, node 3 has 1
    if (dc[0].id !== 0) throw new Error('Expected node 0 first, got ' + dc[0].id);
    if (dc[0].degree !== 3) throw new Error('Expected degree 3, got ' + dc[0].degree);
    if (dc[3].degree !== 1) throw new Error('Expected last degree 1, got ' + dc[3].degree);
  });

  await test('findSuperSpreaders returns top k by degree', async () => {
    let net = await call('src/network.mjs', 'createNetwork', [4]);
    net = await call('src/network.mjs', 'addEdge', [net, 0, 1, 1]);
    net = await call('src/network.mjs', 'addEdge', [net, 0, 2, 1]);
    net = await call('src/network.mjs', 'addEdge', [net, 0, 3, 1]);
    const ss = await call('src/network.mjs', 'findSuperSpreaders', [net, 1]);
    if (ss.length !== 1) throw new Error('Expected 1 super spreader');
    if (ss[0] !== 0) throw new Error('Expected node 0 as top spreader, got ' + ss[0]);
  });

  await test('applyQuarantine removes node edges and sets status', async () => {
    let net = await call('src/network.mjs', 'createNetwork', [3]);
    net = await call('src/network.mjs', 'addEdge', [net, 0, 1, 1]);
    net = await call('src/network.mjs', 'addEdge', [net, 1, 2, 1]);
    const q = await call('src/network.mjs', 'applyQuarantine', [net, [1]]);
    // Node 1 quarantined — all edges involving node 1 removed
    if (q.edges.length !== 0) throw new Error('Expected 0 edges after quarantine of hub, got ' + q.edges.length);
    const node1 = q.nodes.find(n => n.id === 1);
    if (node1.status !== 'quarantined') throw new Error('Node 1 should be quarantined');
  });

  await test('applyQuarantine does not mutate input', async () => {
    let net = await call('src/network.mjs', 'createNetwork', [3]);
    net = await call('src/network.mjs', 'addEdge', [net, 0, 1, 1]);
    const edgesBefore = net.edges.length;
    await call('src/network.mjs', 'applyQuarantine', [net, [0]]);
    if (net.edges.length !== edgesBefore) throw new Error('Input was mutated');
  });

  // ═══ BARREL / PIPELINE ═══

  await test('analyzeOutbreak returns full result without contacts', async () => {
    const result = await call('src/index.mjs', 'analyzeOutbreak', [{population: 1000, infected: 10, beta: 0.3, gamma: 0.1, steps: 50}]);
    if (!result.sir || !result.sir.timeline) throw new Error('Missing sir.timeline');
    if (Math.abs(result.R0 - 3.0) > 0.001) throw new Error('R0 wrong: ' + result.R0);
    if (Math.abs(result.herdThreshold - (1 - 1/3)) > 0.01) throw new Error('Herd threshold wrong');
    if (result.superSpreaders !== undefined) throw new Error('superSpreaders should be absent without contacts');
  });

  await test('analyzeOutbreak with contacts returns superSpreaders', async () => {
    const contacts = [[0, 1], [0, 2], [0, 3], [1, 2]];
    const result = await call('src/index.mjs', 'analyzeOutbreak', [{population: 5, infected: 1, beta: 0.3, gamma: 0.1, steps: 10, contacts}]);
    if (!result.superSpreaders) throw new Error('Missing superSpreaders');
    if (result.superSpreaders[0] !== 0) throw new Error('Node 0 should be top spreader');
  });
}
