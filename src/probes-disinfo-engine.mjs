/**
 * Independent probes for the disinfo-engine fixture.
 * 30 probes covering 19 bugs across 5 modules.
 */
export async function runDisinfoEngineProbes({ call, test, eq }) {

  // ── graph.mjs ──────────────────────────────────────────────────

  // 1. addEdge must be directed (from→to only)
  await test('addEdge creates directed edge only', async () => {
    var g = await call('src/graph.mjs', 'createGraph', []);
    g = await call('src/graph.mjs', 'addNode', [g, 'a', { influence: 1, followerCount: 10, botProbability: 0 }]);
    g = await call('src/graph.mjs', 'addNode', [g, 'b', { influence: 1, followerCount: 10, botProbability: 0 }]);
    g = await call('src/graph.mjs', 'addEdge', [g, 'a', 'b', 1]);
    var neighborsA = await call('src/graph.mjs', 'getNeighbors', [g, 'a']);
    var neighborsB = await call('src/graph.mjs', 'getNeighbors', [g, 'b']);
    eq(neighborsA.length, 1);
    eq(neighborsB.length, 0);
  });

  // 2. addEdge: outEdges of 'from' has target, inEdges of 'to' has source
  await test('addEdge populates correct edge lists', async () => {
    var g = await call('src/graph.mjs', 'createGraph', []);
    g = await call('src/graph.mjs', 'addNode', [g, 'x', { influence: 1, followerCount: 5, botProbability: 0 }]);
    g = await call('src/graph.mjs', 'addNode', [g, 'y', { influence: 1, followerCount: 5, botProbability: 0 }]);
    g = await call('src/graph.mjs', 'addEdge', [g, 'x', 'y', 2]);
    eq(g.nodes['x'].outEdges.length, 1);
    eq(g.nodes['x'].inEdges.length, 0);
    eq(g.nodes['y'].outEdges.length, 0);
    eq(g.nodes['y'].inEdges.length, 1);
  });

  // 3. shortestPath uses BFS (finds shortest, not just any path)
  await test('shortestPath returns shortest path via BFS', async () => {
    var g = await call('src/graph.mjs', 'createGraph', []);
    var nodes = ['a', 'b', 'c', 'd'];
    for (var i = 0; i < nodes.length; i++) {
      g = await call('src/graph.mjs', 'addNode', [g, nodes[i], { influence: 1, followerCount: 1, botProbability: 0 }]);
    }
    // Long path: a→b→c→d, short path: a→d
    g = await call('src/graph.mjs', 'addEdge', [g, 'a', 'b', 1]);
    g = await call('src/graph.mjs', 'addEdge', [g, 'b', 'c', 1]);
    g = await call('src/graph.mjs', 'addEdge', [g, 'c', 'd', 1]);
    g = await call('src/graph.mjs', 'addEdge', [g, 'a', 'd', 1]);
    var result = await call('src/graph.mjs', 'shortestPath', [g, 'a', 'd']);
    eq(result.distance, 1);
    eq(result.path.length, 2);
    eq(result.path[0], 'a');
    eq(result.path[1], 'd');
  });

  // 4. shortestPath unreachable returns null
  await test('shortestPath returns null for unreachable node', async () => {
    var g = await call('src/graph.mjs', 'createGraph', []);
    g = await call('src/graph.mjs', 'addNode', [g, 'a', { influence: 1, followerCount: 1, botProbability: 0 }]);
    g = await call('src/graph.mjs', 'addNode', [g, 'b', { influence: 1, followerCount: 1, botProbability: 0 }]);
    var result = await call('src/graph.mjs', 'shortestPath', [g, 'a', 'b']);
    eq(result, null);
  });

  // 5. communityDetect tie-breaking: smallest label lexicographically
  await test('communityDetect breaks ties by smallest label', async () => {
    // Triangle: a↔b↔c, all connected equally
    var g = await call('src/graph.mjs', 'createGraph', []);
    g = await call('src/graph.mjs', 'addNode', [g, 'a', { influence: 1, followerCount: 1, botProbability: 0 }]);
    g = await call('src/graph.mjs', 'addNode', [g, 'b', { influence: 1, followerCount: 1, botProbability: 0 }]);
    g = await call('src/graph.mjs', 'addNode', [g, 'c', { influence: 1, followerCount: 1, botProbability: 0 }]);
    // Bidirectional edges to form triangle
    g = await call('src/graph.mjs', 'addEdge', [g, 'a', 'b', 1]);
    g = await call('src/graph.mjs', 'addEdge', [g, 'b', 'a', 1]);
    g = await call('src/graph.mjs', 'addEdge', [g, 'b', 'c', 1]);
    g = await call('src/graph.mjs', 'addEdge', [g, 'c', 'b', 1]);
    g = await call('src/graph.mjs', 'addEdge', [g, 'a', 'c', 1]);
    g = await call('src/graph.mjs', 'addEdge', [g, 'c', 'a', 1]);
    var labels = await call('src/graph.mjs', 'communityDetect', [g, 20]);
    // With proper tie-breaking (smallest label), all should converge to 'a'
    eq(labels['a'], labels['b']);
    eq(labels['b'], labels['c']);
    eq(labels['a'], 'a');
  });

  // ── propagation.mjs ───────────────────────────────────────────

  // 6. propagateStep must use double-buffered transitions (snapshot)
  await test('propagateStep uses snapshot (no in-place cascade)', async () => {
    // Chain: a→b→c. Infect a. With beta=1, gamma=0:
    // Step 1 should infect b (from a), but NOT c (b wasn't infected at step start)
    var g = await call('src/graph.mjs', 'createGraph', []);
    g = await call('src/graph.mjs', 'addNode', [g, 'a', { influence: 1, followerCount: 1, botProbability: 0 }]);
    g = await call('src/graph.mjs', 'addNode', [g, 'b', { influence: 1, followerCount: 1, botProbability: 0 }]);
    g = await call('src/graph.mjs', 'addNode', [g, 'c', { influence: 1, followerCount: 1, botProbability: 0 }]);
    g = await call('src/graph.mjs', 'addEdge', [g, 'a', 'b', 1]);
    g = await call('src/graph.mjs', 'addEdge', [g, 'b', 'c', 1]);
    var pop = await call('src/propagation.mjs', 'createPopulation', [g]);
    pop = await call('src/propagation.mjs', 'seedInfection', [pop, ['a']]);
    var result = await call('src/propagation.mjs', 'propagateStep', [pop, g, { beta: 1.0, gamma: 0, seed: 42 }]);
    // b should be infected, c should still be susceptible
    eq(result.population['b'].state, 'I');
    eq(result.population['c'].state, 'S');
  });

  // 7. propagateStep: gamma recovery works correctly (random < gamma → recover)
  await test('propagateStep recovers infected nodes when random < gamma', async () => {
    // With gamma=1.0, ALL infected nodes should recover (random is always < 1.0)
    var g = await call('src/graph.mjs', 'createGraph', []);
    g = await call('src/graph.mjs', 'addNode', [g, 'a', { influence: 1, followerCount: 1, botProbability: 0 }]);
    var pop = await call('src/propagation.mjs', 'createPopulation', [g]);
    pop = await call('src/propagation.mjs', 'seedInfection', [pop, ['a']]);
    var result = await call('src/propagation.mjs', 'propagateStep', [pop, g, { beta: 0, gamma: 1.0, seed: 42 }]);
    eq(result.population['a'].state, 'R');
  });

  // 8. propagateStep: gamma=0 means no recovery
  await test('propagateStep no recovery when gamma=0', async () => {
    var g = await call('src/graph.mjs', 'createGraph', []);
    g = await call('src/graph.mjs', 'addNode', [g, 'a', { influence: 1, followerCount: 1, botProbability: 0 }]);
    var pop = await call('src/propagation.mjs', 'createPopulation', [g]);
    pop = await call('src/propagation.mjs', 'seedInfection', [pop, ['a']]);
    var result = await call('src/propagation.mjs', 'propagateStep', [pop, g, { beta: 0, gamma: 0, seed: 42 }]);
    eq(result.population['a'].state, 'I');
  });

  // 9. propagateStep does not mutate input population
  await test('propagateStep returns new population without mutating input', async () => {
    var g = await call('src/graph.mjs', 'createGraph', []);
    g = await call('src/graph.mjs', 'addNode', [g, 'a', { influence: 1, followerCount: 1, botProbability: 0 }]);
    g = await call('src/graph.mjs', 'addNode', [g, 'b', { influence: 1, followerCount: 1, botProbability: 0 }]);
    g = await call('src/graph.mjs', 'addEdge', [g, 'a', 'b', 1]);
    var pop = await call('src/propagation.mjs', 'createPopulation', [g]);
    pop = await call('src/propagation.mjs', 'seedInfection', [pop, ['a']]);
    var originalAState = pop['a'].state;
    var result = await call('src/propagation.mjs', 'propagateStep', [pop, g, { beta: 1.0, gamma: 1.0, seed: 42 }]);
    eq(pop['a'].state, originalAState);
  });

  // 10. computeR0 uses mean degree, not median
  await test('computeR0 uses mean degree', async () => {
    // Star graph: center has 3 outEdges, leaves have 0. Mean=0.75, Median=0.
    var g = await call('src/graph.mjs', 'createGraph', []);
    g = await call('src/graph.mjs', 'addNode', [g, 'center', { influence: 1, followerCount: 1, botProbability: 0 }]);
    g = await call('src/graph.mjs', 'addNode', [g, 'leaf1', { influence: 1, followerCount: 1, botProbability: 0 }]);
    g = await call('src/graph.mjs', 'addNode', [g, 'leaf2', { influence: 1, followerCount: 1, botProbability: 0 }]);
    g = await call('src/graph.mjs', 'addNode', [g, 'leaf3', { influence: 1, followerCount: 1, botProbability: 0 }]);
    g = await call('src/graph.mjs', 'addEdge', [g, 'center', 'leaf1', 1]);
    g = await call('src/graph.mjs', 'addEdge', [g, 'center', 'leaf2', 1]);
    g = await call('src/graph.mjs', 'addEdge', [g, 'center', 'leaf3', 1]);
    var r0 = await call('src/propagation.mjs', 'computeR0', [g, 0.5, 0.25]);
    // meanDegree = (3+0+0+0)/4 = 0.75. R0 = 0.5 * 0.75 / 0.25 = 1.5
    eq(r0, 1.5);
  });

  // 11. runPropagation records history correctly
  await test('runPropagation records step history', async () => {
    var g = await call('src/graph.mjs', 'createGraph', []);
    g = await call('src/graph.mjs', 'addNode', [g, 'a', { influence: 1, followerCount: 1, botProbability: 0 }]);
    var pop = await call('src/propagation.mjs', 'createPopulation', [g]);
    pop = await call('src/propagation.mjs', 'seedInfection', [pop, ['a']]);
    var result = await call('src/propagation.mjs', 'runPropagation', [pop, g, 3, { beta: 0, gamma: 0, seed: 42 }]);
    eq(result.history.length, 3);
    eq(result.history[0].step, 0);
    eq(result.history[2].step, 2);
  });

  // ── bots.mjs ──────────────────────────────────────────────────

  // 12. generateBotProfile must be deterministic from seed
  await test('generateBotProfile is deterministic', async () => {
    var profile1 = await call('src/bots.mjs', 'generateBotProfile', [12345]);
    var profile2 = await call('src/bots.mjs', 'generateBotProfile', [12345]);
    eq(profile1.username, profile2.username);
    eq(profile1.createdDaysAgo, profile2.createdDaysAgo);
    eq(profile1.followerCount, profile2.followerCount);
    eq(profile1.activityPeak, profile2.activityPeak);
  });

  // 13. generateBotProfile different seeds produce different profiles
  await test('generateBotProfile varies with seed', async () => {
    var profile1 = await call('src/bots.mjs', 'generateBotProfile', [100]);
    var profile2 = await call('src/bots.mjs', 'generateBotProfile', [200]);
    if (profile1.username === profile2.username &&
        profile1.followerCount === profile2.followerCount &&
        profile1.activityPeak === profile2.activityPeak) {
      throw new Error('Different seeds produced identical profiles');
    }
  });

  // 14. activityPattern peaks at bot.activityPeak
  await test('activityPattern highest at peak hour', async () => {
    var bot = { activityPeak: 14 };
    var peakProb = await call('src/bots.mjs', 'activityPattern', [bot, 14]);
    var offProb = await call('src/bots.mjs', 'activityPattern', [bot, 2]);
    if (peakProb <= offProb) {
      throw new Error('Activity at peak (' + peakProb + ') should exceed off-peak (' + offProb + ')');
    }
  });

  // 15. activityPattern at peak should be ~0.8
  await test('activityPattern peak value approximately 0.8', async () => {
    var bot = { activityPeak: 10 };
    var prob = await call('src/bots.mjs', 'activityPattern', [bot, 10]);
    if (prob < 0.75 || prob > 0.85) {
      throw new Error('Peak probability should be ~0.8, got ' + prob);
    }
  });

  // 16. detectBotCluster normalizes by (n-1) not n
  await test('detectBotCluster normalizes by n-1', async () => {
    // With 2 nodes, denominator should be 1 (n-1=1), not 2 (n=2)
    var g = await call('src/graph.mjs', 'createGraph', []);
    g = await call('src/graph.mjs', 'addNode', [g, 'bot1', { influence: 1, followerCount: 10, botProbability: 0.9, activityPeak: 12 }]);
    g = await call('src/graph.mjs', 'addNode', [g, 'bot2', { influence: 1, followerCount: 10, botProbability: 0.9, activityPeak: 12 }]);
    g = await call('src/graph.mjs', 'addEdge', [g, 'bot1', 'bot2', 1]);
    g = await call('src/graph.mjs', 'addEdge', [g, 'bot2', 'bot1', 1]);
    var scores = await call('src/bots.mjs', 'detectBotCluster', [g, ['bot1', 'bot2']]);
    // Identical peak (dist=0), timing sim = 1. Jaccard: both have each other as followers.
    // With n-1=1, score should be > 0.5
    if (scores[0].score <= 0.5) {
      throw new Error('Score should be > 0.5 with n-1 denominator, got ' + scores[0].score);
    }
  });

  // 17. createBotNetwork generates correct count
  await test('createBotNetwork generates correct number of profiles', async () => {
    var network = await call('src/bots.mjs', 'createBotNetwork', [5, 1000]);
    eq(network.length, 5);
  });

  // ── amplify.mjs ───────────────────────────────────────────────

  // 18. viralCoefficient: K = (shares/views) * avgNewViews
  await test('viralCoefficient divides shares by views', async () => {
    // K = (100/1000) * 5 = 0.5
    var k = await call('src/amplify.mjs', 'viralCoefficient', [100, 1000, 5]);
    eq(k, 0.5);
  });

  // 19. viralCoefficient with 0 views returns 0
  await test('viralCoefficient returns 0 for zero views', async () => {
    var k = await call('src/amplify.mjs', 'viralCoefficient', [10, 0, 5]);
    eq(k, 0);
  });

  // 20. echoChamberScore excludes self-loops
  await test('echoChamberScore excludes self-loops from internal count', async () => {
    var g = await call('src/graph.mjs', 'createGraph', []);
    g = await call('src/graph.mjs', 'addNode', [g, 'a', { influence: 1, followerCount: 1, botProbability: 0 }]);
    g = await call('src/graph.mjs', 'addNode', [g, 'b', { influence: 1, followerCount: 1, botProbability: 0 }]);
    g = await call('src/graph.mjs', 'addEdge', [g, 'a', 'a', 1]); // self-loop
    g = await call('src/graph.mjs', 'addEdge', [g, 'a', 'b', 1]); // external (b not in community)
    var score = await call('src/amplify.mjs', 'echoChamberScore', [g, ['a']]);
    // Only edge from community members: a→a (self-loop, should be excluded) and a→b (external)
    // internal=0, external=1, score=0/1=0
    eq(score, 0);
  });

  // 21. echoChamberScore correct with real internal edges
  await test('echoChamberScore counts real internal edges', async () => {
    var g = await call('src/graph.mjs', 'createGraph', []);
    g = await call('src/graph.mjs', 'addNode', [g, 'a', { influence: 1, followerCount: 1, botProbability: 0 }]);
    g = await call('src/graph.mjs', 'addNode', [g, 'b', { influence: 1, followerCount: 1, botProbability: 0 }]);
    g = await call('src/graph.mjs', 'addNode', [g, 'c', { influence: 1, followerCount: 1, botProbability: 0 }]);
    g = await call('src/graph.mjs', 'addEdge', [g, 'a', 'b', 1]); // internal
    g = await call('src/graph.mjs', 'addEdge', [g, 'b', 'a', 1]); // internal
    g = await call('src/graph.mjs', 'addEdge', [g, 'a', 'c', 1]); // external
    var score = await call('src/amplify.mjs', 'echoChamberScore', [g, ['a', 'b']]);
    // internal=2, external=1, score=2/3≈0.667
    var expected = 2 / 3;
    if (Math.abs(score - expected) > 0.01) {
      throw new Error('Expected ~0.667, got ' + score);
    }
  });

  // 22. amplificationPlan decrements budget (does not infinite loop)
  await test('amplificationPlan respects budget', async () => {
    var g = await call('src/graph.mjs', 'createGraph', []);
    g = await call('src/graph.mjs', 'addNode', [g, 'a', { influence: 5, followerCount: 100, botProbability: 0 }]);
    g = await call('src/graph.mjs', 'addNode', [g, 'b', { influence: 3, followerCount: 50, botProbability: 0 }]);
    g = await call('src/graph.mjs', 'addNode', [g, 'c', { influence: 1, followerCount: 10, botProbability: 0 }]);
    g = await call('src/graph.mjs', 'addEdge', [g, 'a', 'b', 1]);
    g = await call('src/graph.mjs', 'addEdge', [g, 'a', 'c', 1]);
    g = await call('src/graph.mjs', 'addEdge', [g, 'b', 'c', 1]);
    var result = await call('src/amplify.mjs', 'amplificationPlan', [g, {}, 2]);
    eq(result.plan.length, 2);
  });

  // 23. engagementScore computation
  await test('engagementScore with triggers and media', async () => {
    var content = { text: 'BREAKING urgent news leaked from secret source', hasImage: true, hasVideo: false };
    var score = await call('src/amplify.mjs', 'engagementScore', [content]);
    // 7 words → base=0.7. Triggers: breaking, urgent, leaked, secret = 4×0.5=2. Image=1. Total=3.7
    if (score < 3.5 || score > 4.0) {
      throw new Error('Expected engagement ~3.7, got ' + score);
    }
  });

  // 24. reachEstimate counts unique nodes only
  await test('reachEstimate counts unique nodes across seeds', async () => {
    // a→c, b→c. Seeds=[a,b], steps=1. Unique reach: {a, b, c} = 3
    var g = await call('src/graph.mjs', 'createGraph', []);
    g = await call('src/graph.mjs', 'addNode', [g, 'a', { influence: 1, followerCount: 1, botProbability: 0 }]);
    g = await call('src/graph.mjs', 'addNode', [g, 'b', { influence: 1, followerCount: 1, botProbability: 0 }]);
    g = await call('src/graph.mjs', 'addNode', [g, 'c', { influence: 1, followerCount: 1, botProbability: 0 }]);
    g = await call('src/graph.mjs', 'addEdge', [g, 'a', 'c', 1]);
    g = await call('src/graph.mjs', 'addEdge', [g, 'b', 'c', 1]);
    var reach = await call('src/amplify.mjs', 'reachEstimate', [g, ['a', 'b'], 1]);
    eq(reach, 3);
  });

  // 25. reachEstimate with overlapping seeds
  await test('reachEstimate does not double-count shared reachable nodes', async () => {
    // Diamond: a→c, a→d, b→c, b→d. Seeds=[a,b], steps=1. Unique: {a,b,c,d}=4
    var g = await call('src/graph.mjs', 'createGraph', []);
    var ns = ['a', 'b', 'c', 'd'];
    for (var i = 0; i < ns.length; i++) {
      g = await call('src/graph.mjs', 'addNode', [g, ns[i], { influence: 1, followerCount: 1, botProbability: 0 }]);
    }
    g = await call('src/graph.mjs', 'addEdge', [g, 'a', 'c', 1]);
    g = await call('src/graph.mjs', 'addEdge', [g, 'a', 'd', 1]);
    g = await call('src/graph.mjs', 'addEdge', [g, 'b', 'c', 1]);
    g = await call('src/graph.mjs', 'addEdge', [g, 'b', 'd', 1]);
    var reach = await call('src/amplify.mjs', 'reachEstimate', [g, ['a', 'b'], 1]);
    eq(reach, 4);
  });

  // ── attribution.mjs ──────────────────────────────────────────

  // 26. timingFingerprint uses Bessel's correction (n-1)
  await test('timingFingerprint uses sample stddev (n-1)', async () => {
    // Posts at 0, 1000, 3000 → intervals [1000, 2000]
    // mean = 1500, diff² = 250000 + 250000 = 500000
    // sample stddev = sqrt(500000 / 1) = ~707.107 (n-1=1)
    // population stddev = sqrt(500000 / 2) = 500 (wrong)
    var fp = await call('src/attribution.mjs', 'timingFingerprint', [
      [{ timestamp: 0 }, { timestamp: 1000 }, { timestamp: 3000 }]
    ]);
    var expectedStddev = Math.sqrt(500000);
    if (Math.abs(fp.stddev - expectedStddev) > 1) {
      throw new Error('Expected sample stddev ~707.1, got ' + fp.stddev);
    }
  });

  // 27. timingFingerprint burstiness calculation
  await test('timingFingerprint burstiness is correct', async () => {
    var fp = await call('src/attribution.mjs', 'timingFingerprint', [
      [{ timestamp: 0 }, { timestamp: 1000 }, { timestamp: 3000 }]
    ]);
    // burstiness = (stddev - mean) / (stddev + mean)
    var expectedBurst = (fp.stddev - fp.mean) / (fp.stddev + fp.mean);
    if (Math.abs(fp.burstiness - expectedBurst) > 0.01) {
      throw new Error('Burstiness mismatch');
    }
  });

  // 28. correlateProfiles handles zero-magnitude vectors
  await test('correlateProfiles returns 0 for zero-magnitude profile', async () => {
    var zeroProfile = {
      hourDistribution: new Array(24).fill(0),
      vocabularyDiversity: 0,
      avgPostLength: 0
    };
    var normalProfile = {
      hourDistribution: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      vocabularyDiversity: 0.5,
      avgPostLength: 100
    };
    var sim = await call('src/attribution.mjs', 'correlateProfiles', [zeroProfile, normalProfile]);
    eq(sim, 0);
  });

  // 29. attributionScore uses correct weights (network=0.4, timing=0.3)
  await test('attributionScore weights network strongest', async () => {
    // If network signals are 1.0 and others are 0, score should be 0.4
    var score = await call('src/attribution.mjs', 'attributionScore', [
      { timing: 0, behavior: 0, network: 1 },
      { timing: 0, behavior: 0, network: 1 }
    ]);
    eq(score, 0.4);
  });

  // 30. attributionScore weights timing at 0.3, not 0.4
  await test('attributionScore timing weight is 0.3', async () => {
    var score = await call('src/attribution.mjs', 'attributionScore', [
      { timing: 1, behavior: 0, network: 0 },
      { timing: 1, behavior: 0, network: 0 }
    ]);
    if (Math.abs(score - 0.3) > 0.01) {
      throw new Error('Timing-only score should be 0.3, got ' + score);
    }
  });

  // 31. networkForensics detects star topology
  await test('networkForensics star detection', async () => {
    var g = await call('src/graph.mjs', 'createGraph', []);
    var ns = ['hub', 's1', 's2', 's3'];
    for (var i = 0; i < ns.length; i++) {
      g = await call('src/graph.mjs', 'addNode', [g, ns[i], { influence: 1, followerCount: 1, botProbability: 0 }]);
    }
    g = await call('src/graph.mjs', 'addEdge', [g, 'hub', 's1', 1]);
    g = await call('src/graph.mjs', 'addEdge', [g, 'hub', 's2', 1]);
    g = await call('src/graph.mjs', 'addEdge', [g, 'hub', 's3', 1]);
    var result = await call('src/attribution.mjs', 'networkForensics', [g, ['hub', 's1', 's2', 's3']]);
    if (result.stars.length === 0) {
      throw new Error('Should detect hub as star center');
    }
    eq(result.stars[0].centerId, 'hub');
  });

  // 32. behaviorProfile hour distribution
  await test('behaviorProfile counts hours correctly', async () => {
    // UTC hour 0 for epoch 0
    var profile = await call('src/attribution.mjs', 'behaviorProfile', [
      [{ timestamp: 0, text: 'hello world' }, { timestamp: 3600000, text: 'second post' }]
    ]);
    eq(profile.hourDistribution[0], 1); // epoch 0 = hour 0
    eq(profile.hourDistribution[1], 1); // 3600000ms = hour 1
    eq(profile.hourDistribution[2], 0);
  });

}
