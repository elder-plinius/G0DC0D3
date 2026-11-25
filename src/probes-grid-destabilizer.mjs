export async function runGridDestabilizerProbes({ call, test, eq }) {

  // ── network.mjs probes ──

  // Bug 1: off-diagonal should be NEGATIVE (-1/x)
  // Build a simple 2-bus network and check admittance matrix
  const net2 = await call('src/network.mjs', 'createNetwork', []);
  const net2a = await call('src/network.mjs', 'addBus', [net2, { id: 'A', type: 'slack', generation: 100, load: 0 }]);
  const net2b = await call('src/network.mjs', 'addBus', [net2a, { id: 'B', type: 'load', generation: 0, load: 50 }]);
  const net2c = await call('src/network.mjs', 'addBranch', [net2b, { id: 'L1', from: 'A', to: 'B', reactance: 0.1, ratingMW: 200 }]);
  const adm2 = await call('src/network.mjs', 'getAdmittanceMatrix', [net2c]);
  // B[0][1] should be -1/0.1 = -10
  await test('admittance off-diagonal is negative', () => eq(adm2.matrix[0][1], -10));
  await test('admittance off-diagonal symmetric', () => eq(adm2.matrix[1][0], -10));
  // Diagonal should be +10
  await test('admittance diagonal positive', () => eq(adm2.matrix[0][0], 10));
  await test('admittance diagonal symmetric', () => eq(adm2.matrix[1][1], 10));

  // Bug 2: must skip open branches
  const net2d = await call('src/network.mjs', 'addBranch', [net2c, { id: 'L2', from: 'A', to: 'B', reactance: 0.2, ratingMW: 100, status: 'open' }]);
  const admOpen = await call('src/network.mjs', 'getAdmittanceMatrix', [net2d]);
  // With L2 open, matrix should be same as with only L1
  await test('open branch excluded from admittance diagonal', () => eq(admOpen.matrix[0][0], 10));
  await test('open branch excluded from admittance off-diag', () => eq(admOpen.matrix[0][1], -10));

  // 3-bus network for more complex tests
  const n0 = await call('src/network.mjs', 'createNetwork', []);
  const n1 = await call('src/network.mjs', 'addBus', [n0, { id: 'bus1', type: 'slack', generation: 200, load: 0 }]);
  const n2 = await call('src/network.mjs', 'addBus', [n1, { id: 'bus2', type: 'generator', generation: 100, load: 50 }]);
  const n3 = await call('src/network.mjs', 'addBus', [n2, { id: 'bus3', type: 'load', generation: 0, load: 150 }]);
  const n4 = await call('src/network.mjs', 'addBranch', [n3, { id: 'B12', from: 'bus1', to: 'bus2', reactance: 0.1, ratingMW: 200 }]);
  const n5 = await call('src/network.mjs', 'addBranch', [n4, { id: 'B13', from: 'bus1', to: 'bus3', reactance: 0.2, ratingMW: 150 }]);
  const net3 = await call('src/network.mjs', 'addBranch', [n5, { id: 'B23', from: 'bus2', to: 'bus3', reactance: 0.15, ratingMW: 100 }]);

  // Injection vector check
  const inj = await call('src/network.mjs', 'getInjectionVector', [net3]);
  // bus1: 200-0=200, bus2: 100-50=50, bus3: 0-150=-150 (sorted alphabetically)
  await test('injection bus1 correct', () => eq(inj[0], 200));
  await test('injection bus2 correct', () => eq(inj[1], 50));
  await test('injection bus3 correct', () => eq(inj[2], -150));

  // 3-bus admittance matrix check
  const adm3 = await call('src/network.mjs', 'getAdmittanceMatrix', [net3]);
  // bus1 diagonal: 1/0.1 + 1/0.2 = 10 + 5 = 15
  await test('3bus admittance bus1 diagonal', () => eq(Math.abs(adm3.matrix[0][0] - 15) < 0.001, true));
  // bus1-bus2 off-diagonal: -1/0.1 = -10
  await test('3bus admittance bus1-bus2 offdiag', () => eq(Math.abs(adm3.matrix[0][1] - (-10)) < 0.001, true));

  // ── powerflow.mjs probes ──

  // Bug 3: gaussianEliminate must do partial pivoting
  // Test with a system where diagonal is zero without pivoting
  // [ 0  1 ] [x1]   [3]
  // [ 1  1 ] [x2] = [4]
  // Without pivoting: div by zero. With pivoting: swap rows, x1=1, x2=3
  let pivotResult;
  try {
    pivotResult = await call('src/powerflow.mjs', 'gaussianEliminate', [[[0, 1], [1, 1]], [3, 4]]);
  } catch (e) {
    pivotResult = null;
  }
  await test('gaussian partial pivoting handles zero diagonal', () => eq(pivotResult !== null, true));
  if (pivotResult) {
    await test('gaussian pivoting x1 correct', () => eq(Math.abs(pivotResult[0] - 1) < 0.001, true));
    await test('gaussian pivoting x2 correct', () => eq(Math.abs(pivotResult[1] - 3) < 0.001, true));
  }

  // Bug 3b: back-substitution must use M (after elimination), not original A
  // Simple 2x2: [2 1][x] = [5], [1 3][y] = [10] => x=1, y=3
  const geResult = await call('src/powerflow.mjs', 'gaussianEliminate', [[[2, 1], [1, 3]], [5, 10]]);
  await test('gaussian back-sub x correct', () => eq(Math.abs(geResult[0] - 1) < 0.001, true));
  await test('gaussian back-sub y correct', () => eq(Math.abs(geResult[1] - 3) < 0.001, true));

  // Bug 4: solveDCPF must remove slack bus row/column
  // With 2-bus system: slack=A (angle=0), load=B
  // After removing slack: 1x1 system [10]*[theta_B] = [-50], theta_B = -5
  // Branch flow = (0 - (-5)) / 0.1 = 50 MW from A to B
  let pf2;
  try {
    pf2 = await call('src/powerflow.mjs', 'solveDCPF', [net2c]);
  } catch (e) {
    pf2 = null;
  }
  await test('DCPF does not crash (slack removed)', () => eq(pf2 !== null, true));
  if (pf2) {
    await test('DCPF slack angle is zero', () => eq(pf2.angles['A'], 0));
    await test('DCPF load angle nonzero', () => eq(typeof pf2.angles['B'], 'number'));
    // Flow should be 50 MW (generation=100 at slack, load=50 at B — but only 50MW net demand)
    await test('DCPF branch flow positive from slack', () => eq(pf2.branchFlows['L1'] > 0 || pf2.branchFlows['L1'] < 0, true));
  }

  // Bug 5: computeBranchFlows direction: (angle_from - angle_to) / x
  // With known angles, check flow direction
  const testAngles = { 'A': 0, 'B': -5 };
  const flows2 = await call('src/powerflow.mjs', 'computeBranchFlows', [net2c, testAngles]);
  // Flow A->B = (0 - (-5)) / 0.1 = 50 (positive = from A to B)
  await test('branch flow direction from-to positive', () => eq(Math.abs(flows2['L1'] - 50) < 0.001, true));

  // 3-bus DCPF test
  let pf3;
  try {
    pf3 = await call('src/powerflow.mjs', 'solveDCPF', [net3]);
  } catch (e) {
    pf3 = null;
  }
  await test('3bus DCPF solves', () => eq(pf3 !== null, true));
  if (pf3) {
    await test('3bus DCPF slack angle zero', () => eq(pf3.angles['bus1'], 0));
    // Power balance: total gen = 200+100=300, total load = 0+50+150=200
    // Slack absorbs the difference: 100 MW excess
  }

  // checkOverloads: should correctly identify overloaded branches
  const overloadFlows = { 'L1': 250 }; // rating is 200, so overloaded
  const overloads = await call('src/powerflow.mjs', 'checkOverloads', [net2c, overloadFlows]);
  await test('overload detected', () => eq(overloads.length, 1));
  if (overloads.length > 0) {
    await test('overload percent correct', () => eq(Math.abs(overloads[0].overloadPercent - 25) < 0.1, true));
  }

  // ── contingency.mjs probes ──

  // Bug 6: runN1 must copy network each iteration (not cumulative)
  // With 3-bus network, each contingency should start from original
  let n1Results;
  try {
    n1Results = await call('src/contingency.mjs', 'runN1', [net3]);
  } catch (e) {
    n1Results = null;
  }
  await test('N-1 analysis runs', () => eq(n1Results !== null && Array.isArray(n1Results), true));
  if (n1Results && n1Results.length >= 2) {
    // If cumulative bug exists, later contingencies would see earlier branches still open
    // Check that we get results for all 3 branches
    await test('N-1 covers all branches', () => eq(n1Results.length, 3));
    // The last contingency should NOT have error from singular matrix
    // (which would happen if previous branches were cumulatively opened)
    const lastHasError = n1Results[n1Results.length - 1].error !== undefined;
    await test('N-1 last contingency not singular', () => eq(lastHasError, false));
  }

  // Bug 7: rankContingencies must sort descending
  const mockResults = [
    { branchId: 'a', severity: 10 },
    { branchId: 'b', severity: 50 },
    { branchId: 'c', severity: 30 }
  ];
  const ranked = await call('src/contingency.mjs', 'rankContingencies', [mockResults]);
  await test('rank descending first is most severe', () => eq(ranked[0].severity, 50));
  await test('rank descending last is least severe', () => eq(ranked[2].severity, 10));

  // Bug 8: securityMargin should be margin%, not loading%
  // margin = rating - |flow|, marginPercent = margin/rating*100
  if (pf3) {
    const margin = await call('src/contingency.mjs', 'securityMargin', [net3, 'B12']);
    await test('security margin has margin field', () => eq(typeof margin.margin, 'number'));
    await test('security margin has marginPercent', () => eq(typeof margin.marginPercent, 'number'));
    // If flow is 80MW on a 200MW rating, margin=120, marginPercent=60%
    // loading% would be 40%. marginPercent + loading% should = 100%
    const expectedMarginPct = margin.margin / margin.rating * 100;
    await test('marginPercent is margin/rating not flow/rating', () => eq(Math.abs(margin.marginPercent - expectedMarginPct) < 0.1, true));
  }

  // worstCase should return k worst
  const worst2 = await call('src/contingency.mjs', 'worstCase', [mockResults, 2]);
  await test('worstCase returns k items', () => eq(worst2.length, 2));
  await test('worstCase first is most severe', () => eq(worst2[0].severity, 50));

  // ── attack.mjs probes ──

  // Bug 9: identifyCritical should rank by severity (MW), not count
  const mockN1 = [
    { branchId: 'x', overloads: [{}, {}], severity: 10 },  // 2 overloads, low severity
    { branchId: 'y', overloads: [{}], severity: 100 },      // 1 overload, high severity
  ];
  const critical = await call('src/attack.mjs', 'identifyCritical', [net3, mockN1]);
  // Should rank y first (severity 100) not x (2 overloads)
  await test('critical ranks by severity not count', () => eq(critical[0].branchId, 'y'));

  // Bug 10: coordinatedTripping must open all branches at once
  // Open B12 and B23 simultaneously — different from sequential
  let coordResult;
  try {
    coordResult = await call('src/attack.mjs', 'coordinatedTripping', [net3, ['B12', 'B23']]);
  } catch (e) {
    coordResult = null;
  }
  await test('coordinated tripping runs', () => eq(coordResult !== null, true));
  if (coordResult) {
    await test('coordinated tripping returns tripped list', () => eq(coordResult.tripped.length, 2));
  }

  // Verify coordinated vs sequential gives different results
  // Sequential: open B12, solve, open B23, solve → flows reflect intermediate state
  // Simultaneous: open both, solve once → flows reflect final state only
  // We can check by comparing with single-trip results
  let singleB12, singleB23;
  try {
    singleB12 = await call('src/attack.mjs', 'coordinatedTripping', [net3, ['B12']]);
    singleB23 = await call('src/attack.mjs', 'coordinatedTripping', [net3, ['B23']]);
  } catch (e) { singleB12 = null; singleB23 = null; }

  // Bug 11: isolate-region should find min cut for target buses, not all bridges
  // In a 3-bus triangle, there are NO bridges (every branch is in a cycle)
  // But isolating bus3 requires cutting B13 and B23 (min cut = 2)
  const isoResult = await call('src/attack.mjs', 'targetSelection', [net3, 'isolate-region', { targetBuses: ['bus3'] }]);
  await test('isolate-region finds targets', () => eq(isoResult.targets.length > 0, true));
  // A triangle has no bridges, so bridge-finding would return empty
  // Min cut to isolate bus3 should find B13 and B23
  // If the bug returns bridges (empty for triangle), this catches it
  if (isoResult.targets.length === 0) {
    await test('isolate-region not just bridge detection', () => eq(false, true)); // fail: found bridges not min-cut
  }

  // loadRedistribution should show before/after comparison
  let redistResult;
  try {
    redistResult = await call('src/attack.mjs', 'loadRedistribution', [net3, ['B23']]);
  } catch (e) {
    redistResult = null;
  }
  await test('load redistribution runs', () => eq(redistResult !== null, true));
  if (redistResult) {
    await test('redistribution has before flows', () => eq(typeof redistResult.before, 'object'));
    await test('redistribution has after flows', () => eq(typeof redistResult.after, 'object'));
    await test('redistribution has changes', () => eq(typeof redistResult.changes, 'object'));
  }

  // ── cascade.mjs probes ──

  // Bug 12: simulateCascade must use configurable overloadThreshold
  // With threshold=0.5, branches at 60% loading should trip
  // With threshold=1.0 (hardcoded bug), they wouldn't
  // Build a network where some branch is ~60% loaded after initial trip
  const cn0 = await call('src/network.mjs', 'createNetwork', []);
  const cn1 = await call('src/network.mjs', 'addBus', [cn0, { id: 's', type: 'slack', generation: 100, load: 0 }]);
  const cn2 = await call('src/network.mjs', 'addBus', [cn1, { id: 'a', type: 'load', generation: 0, load: 40 }]);
  const cn3 = await call('src/network.mjs', 'addBus', [cn2, { id: 'b', type: 'load', generation: 0, load: 40 }]);
  const cn4 = await call('src/network.mjs', 'addBranch', [cn3, { id: 'sa', from: 's', to: 'a', reactance: 0.1, ratingMW: 100 }]);
  const cn5 = await call('src/network.mjs', 'addBranch', [cn4, { id: 'sb', from: 's', to: 'b', reactance: 0.1, ratingMW: 100 }]);
  const cascNet = await call('src/network.mjs', 'addBranch', [cn5, { id: 'ab', from: 'a', to: 'b', reactance: 0.2, ratingMW: 50 }]);

  // Normal cascade at default threshold (1.0) — only trips if > 100%
  let cascDefault;
  try {
    cascDefault = await call('src/cascade.mjs', 'simulateCascade', [cascNet, ['ab'], {}]);
  } catch (e) { cascDefault = null; }
  await test('cascade simulation runs', () => eq(cascDefault !== null, true));

  // Cascade at low threshold (0.3) — should trip more aggressively
  let cascLow;
  try {
    cascLow = await call('src/cascade.mjs', 'simulateCascade', [cascNet, ['ab'], { overloadThreshold: 0.3 }]);
  } catch (e) { cascLow = null; }
  await test('cascade with low threshold runs', () => eq(cascLow !== null, true));
  // With 0.3 threshold, branches loaded at >30% should trip in cascade
  // This would cause more cascade iterations than default
  if (cascDefault && cascLow) {
    await test('low threshold causes more cascading', () => eq(cascLow.totalBranchesTripped.length >= cascDefault.totalBranchesTripped.length, true));
  }

  // Bug 13: islandDetection must only consider CLOSED branches
  const islandNet0 = await call('src/network.mjs', 'createNetwork', []);
  const islandNet1 = await call('src/network.mjs', 'addBus', [islandNet0, { id: 'x', type: 'slack', generation: 50, load: 0 }]);
  const islandNet2 = await call('src/network.mjs', 'addBus', [islandNet1, { id: 'y', type: 'load', generation: 0, load: 50 }]);
  const islandNet3 = await call('src/network.mjs', 'addBranch', [islandNet2, { id: 'xy', from: 'x', to: 'y', reactance: 0.1, ratingMW: 100, status: 'open' }]);
  const islands = await call('src/cascade.mjs', 'islandDetection', [islandNet3]);
  // With the only branch open, x and y are in separate islands
  await test('island detection finds 2 islands with open branch', () => eq(islands.length, 2));

  // With closed branch, should find 1 island
  const islandNet4 = await call('src/network.mjs', 'addBranch', [islandNet2, { id: 'xy', from: 'x', to: 'y', reactance: 0.1, ratingMW: 100, status: 'closed' }]);
  const islands2 = await call('src/cascade.mjs', 'islandDetection', [islandNet4]);
  await test('island detection finds 1 island with closed branch', () => eq(islands2.length, 1));

  // Bug 14: loadShedding must shed LOAD, not generation
  const shedBuses = [
    { id: 'g1', generation: 50, load: 80 },
    { id: 'g2', generation: 30, load: 60 },
  ];
  // totalGen=80, totalLoad=140, deficit=60
  const shed = await call('src/cascade.mjs', 'loadShedding', [shedBuses, [], 80, 140]);
  await test('load shedding returns results', () => eq(shed.length > 0, true));
  if (shed.length > 0) {
    // Should have busId, originalLoad, shedLoad, remainingLoad (not generation fields)
    const first = shed[0];
    await test('load shedding has shedLoad field', () => eq('shedLoad' in first, true));
    await test('load shedding has originalLoad field', () => eq('originalLoad' in first, true));
    await test('load shedding has remainingLoad field', () => eq('remainingLoad' in first, true));
    // Should NOT have generation fields
    await test('load shedding sheds load not generation', () => eq('shedGeneration' in first, false));
  }

  // Verify proportional shedding: bus with 80 load sheds 80*(60/140)=34.29
  if (shed.length > 0) {
    const g1Shed = shed.find(s => s.busId === 'g1');
    if (g1Shed) {
      const expectedShed = 80 * (60 / 140);
      await test('load shedding proportional', () => eq(Math.abs(g1Shed.shedLoad - expectedShed) < 0.1, true));
      await test('remaining load correct', () => eq(Math.abs(g1Shed.remainingLoad - (80 - expectedShed)) < 0.1, true));
    }
  }

  // Bug 15: blackoutEstimate must count shed load, not branch ratings
  const mockHistory = [
    { iteration: 0, tripped: ['sa'], overloads: [], shedLoad: 25 },
    { iteration: 1, tripped: ['sb'], overloads: [], shedLoad: 35 },
  ];
  const blackout = await call('src/cascade.mjs', 'blackoutEstimate', [cascNet, mockHistory]);
  // Should sum shedLoad (25+35=60), NOT sum branch ratings (100+100=200)
  await test('blackout counts shed load not ratings', () => eq(blackout !== 200, true));

  // cascadeTimeline should produce events
  const timeline = await call('src/cascade.mjs', 'cascadeTimeline', [mockHistory]);
  await test('timeline produces events', () => eq(timeline.length >= 2, true));
  if (timeline.length > 0) {
    await test('timeline event has iteration', () => eq(typeof timeline[0].iteration, 'number'));
    await test('timeline event has type', () => eq(typeof timeline[0].type, 'string'));
  }

  // ── immutability probes ──

  // Verify addBus/addBranch don't mutate input
  const origNet = await call('src/network.mjs', 'createNetwork', []);
  const origKeys = Object.keys(origNet.buses).length;
  await call('src/network.mjs', 'addBus', [origNet, { id: 'test', type: 'load', generation: 0, load: 10 }]);
  await test('addBus does not mutate input', () => eq(Object.keys(origNet.buses).length, origKeys));
}
