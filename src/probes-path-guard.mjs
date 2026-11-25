export async function runPathGuardProbes({call, test, eq}) {
  const rejects = async (fn) => { let threw = false; try { await fn(); } catch { threw = true; } if (!threw) throw new Error('Expected rejection'); };

  // === normalize.mjs ===
  await test('normalizePath: clean path unchanged', async () => {
    eq(await call('src/normalize.mjs', 'normalizePath', ['/files/doc.txt']), '/files/doc.txt');
  });

  await test('normalizePath: single URL encoding decoded', async () => {
    eq(await call('src/normalize.mjs', 'normalizePath', ['/%66iles/doc.txt']), '/files/doc.txt');
  });

  await test('normalizePath: double URL encoding fully decoded', async () => {
    eq(await call('src/normalize.mjs', 'normalizePath', ['/%252e%252e/etc/passwd']), '/etc/passwd');
  });

  await test('normalizePath: triple encoding decoded to fixpoint', async () => {
    // %25 → %, so %25252e → %252e → %2e → .
    eq(await call('src/normalize.mjs', 'normalizePath', ['/%25252e%25252e/secret']), '/secret');
  });

  await test('normalizePath: null bytes stripped', async () => {
    eq(await call('src/normalize.mjs', 'normalizePath', ['/files/doc\0.txt']), '/files/doc.txt');
  });

  await test('normalizePath: backslashes converted to forward slashes', async () => {
    eq(await call('src/normalize.mjs', 'normalizePath', ['\\files\\doc.txt']), '/files/doc.txt');
  });

  await test('normalizePath: multiple separators collapsed', async () => {
    eq(await call('src/normalize.mjs', 'normalizePath', ['///files///doc.txt']), '/files/doc.txt');
  });

  await test('normalizePath: dot segments resolved', async () => {
    eq(await call('src/normalize.mjs', 'normalizePath', ['/files/./sub/../doc.txt']), '/files/doc.txt');
  });

  await test('normalizePath: .. at root absorbed', async () => {
    eq(await call('src/normalize.mjs', 'normalizePath', ['/../../../etc/passwd']), '/etc/passwd');
  });

  await test('normalizePath: ....// bypass defeated', async () => {
    // Naive replace('../','') turns '....//foo' into '../foo' — proper normalization keeps .... as literal
    eq(await call('src/normalize.mjs', 'normalizePath', ['/files/....//....//etc/passwd']), '/files/..../..../etc/passwd');
  });

  await test('normalizePath: encoded traversal decoded then resolved', async () => {
    eq(await call('src/normalize.mjs', 'normalizePath', ['/files/%2e%2e/%2e%2e/etc/passwd']), '/etc/passwd');
  });

  await test('normalizePath: trailing slash stripped except root', async () => {
    eq(await call('src/normalize.mjs', 'normalizePath', ['/files/sub/']), '/files/sub');
    eq(await call('src/normalize.mjs', 'normalizePath', ['/']), '/');
  });

  await test('normalizePath: empty and whitespace become root', async () => {
    eq(await call('src/normalize.mjs', 'normalizePath', ['']), '/');
    eq(await call('src/normalize.mjs', 'normalizePath', ['   ']), '/');
  });

  await test('normalizePath: idempotent on complex input', async () => {
    const input = '/files/%2e%2e/sub/./doc%2etxt';
    const once = await call('src/normalize.mjs', 'normalizePath', [input]);
    const twice = await call('src/normalize.mjs', 'normalizePath', [once]);
    eq(once, twice);
  });

  await test('normalizePath: malformed percent encoding kept gracefully', async () => {
    const result = await call('src/normalize.mjs', 'normalizePath', ['/files/%GGbad']);
    eq(typeof result, 'string');
    eq(result.startsWith('/'), true);
  });

  await test('isTraversalFree: distinguishes .. segment from substring', async () => {
    eq(await call('src/normalize.mjs', 'isTraversalFree', ['/food..bar/baz']), true);
    eq(await call('src/normalize.mjs', 'isTraversalFree', ['/foo/../bar']), false);
    eq(await call('src/normalize.mjs', 'isTraversalFree', ['/..']), false);
    eq(await call('src/normalize.mjs', 'isTraversalFree', ['/../']), false);
    eq(await call('src/normalize.mjs', 'isTraversalFree', ['/clean/path']), true);
  });

  // === jail.mjs ===
  await test('createJail: valid root accepted, invalid rejected', async () => {
    const jail = await call('src/jail.mjs', 'createJail', ['/srv/data']);
    eq(jail.root, '/srv/data');
    await rejects(() => call('src/jail.mjs', 'createJail', ['relative/path']));
    await rejects(() => call('src/jail.mjs', 'createJail', ['']));
    await rejects(() => call('src/jail.mjs', 'createJail', ['/srv/../escape']));
    await rejects(() => call('src/jail.mjs', 'createJail', ['/srv/data\0bad']));
  });

  await test('resolve: clean path within jail allowed', async () => {
    const jail = await call('src/jail.mjs', 'createJail', ['/srv/data']);
    const result = await call('src/jail.mjs', 'resolve', [jail, '/files/doc.txt']);
    eq(result.allowed, true);
    eq(result.resolved, '/srv/data/files/doc.txt');
  });

  await test('resolve: root path resolves to jail root', async () => {
    const jail = await call('src/jail.mjs', 'createJail', ['/srv/data']);
    const result = await call('src/jail.mjs', 'resolve', [jail, '/']);
    eq(result.allowed, true);
    eq(result.resolved, '/srv/data');
  });

  await test('resolve: traversal escape detected and blocked', async () => {
    const jail = await call('src/jail.mjs', 'createJail', ['/srv/data']);
    // After normalization this would be /srv/data + /../../../etc/passwd
    // But resolve assumes input is already normalized. If someone passes
    // a non-normalized path, the defense-in-depth .. check catches it.
    const result = await call('src/jail.mjs', 'resolve', [jail, '/../../../etc/passwd']);
    eq(result.allowed, false);
  });

  await test('resolve: non-absolute untrusted path rejected', async () => {
    const jail = await call('src/jail.mjs', 'createJail', ['/srv/data']);
    // Untrusted path without leading / is rejected (caller must normalize first)
    const result = await call('src/jail.mjs', 'resolve', [jail, 'base']);
    eq(result.allowed, false);
  });

  // === policy.mjs ===
  await test('globMatch: single star matches one segment', async () => {
    eq(await call('src/policy.mjs', 'globMatch', ['/files/*.txt', '/files/doc.txt']), true);
    eq(await call('src/policy.mjs', 'globMatch', ['/files/*.txt', '/files/sub/doc.txt']), false);
  });

  await test('globMatch: double star matches across segments', async () => {
    eq(await call('src/policy.mjs', 'globMatch', ['/files/**', '/files/a/b/c.txt']), true);
    eq(await call('src/policy.mjs', 'globMatch', ['/files/**', '/files']), true);
  });

  await test('globMatch: double star mid-pattern', async () => {
    eq(await call('src/policy.mjs', 'globMatch', ['/files/**/secret', '/files/a/b/secret']), true);
    eq(await call('src/policy.mjs', 'globMatch', ['/files/**/secret', '/files/secret']), true);
    eq(await call('src/policy.mjs', 'globMatch', ['/files/**/secret', '/files/a/b/notsecret']), false);
  });

  await test('globMatch: exact literal match', async () => {
    eq(await call('src/policy.mjs', 'globMatch', ['/files/doc.txt', '/files/doc.txt']), true);
    eq(await call('src/policy.mjs', 'globMatch', ['/files/doc.txt', '/files/doc.txtz']), false);
  });

  await test('createPolicy: valid rules accepted, invalid rejected', async () => {
    const policy = await call('src/policy.mjs', 'createPolicy', [
      [{ pattern: '/public/**', action: 'allow', priority: 10 }]
    ]);
    eq(policy.rules.length, 1);
    await rejects(() => call('src/policy.mjs', 'createPolicy', [
      [{ pattern: 'no-slash', action: 'allow', priority: 10 }]
    ]));
    await rejects(() => call('src/policy.mjs', 'createPolicy', [
      [{ pattern: '/ok', action: 'invalid', priority: 10 }]
    ]));
  });

  await test('evaluate: highest priority wins', async () => {
    const policy = await call('src/policy.mjs', 'createPolicy', [[
      { pattern: '/files/**', action: 'allow', priority: 5 },
      { pattern: '/files/secret/**', action: 'deny', priority: 10 }
    ]]);
    const result = await call('src/policy.mjs', 'evaluate', [policy, '/files/secret/key.pem']);
    eq(result.action, 'deny');
  });

  await test('evaluate: deny wins ties at same priority', async () => {
    const policy = await call('src/policy.mjs', 'createPolicy', [[
      { pattern: '/files/**', action: 'allow', priority: 10 },
      { pattern: '/files/config/**', action: 'deny', priority: 10 }
    ]]);
    const result = await call('src/policy.mjs', 'evaluate', [policy, '/files/config/db.yml']);
    eq(result.action, 'deny');
  });

  await test('evaluate: no match returns none', async () => {
    const policy = await call('src/policy.mjs', 'createPolicy', [[
      { pattern: '/public/**', action: 'allow', priority: 10 }
    ]]);
    const result = await call('src/policy.mjs', 'evaluate', [policy, '/private/secret.txt']);
    eq(result.action, 'none');
    eq(result.matchedRule, null);
  });

  // === index.mjs: createRouter + check ===
  await test('check: clean path through full pipeline', async () => {
    const router = await call('src/index.mjs', 'createRouter', [{
      root: '/srv/data', rules: [{ pattern: '/files/**', action: 'allow', priority: 10 }], defaultAction: 'deny'
    }]);
    const result = await call('src/index.mjs', 'check', [router, '/files/doc.txt']);
    eq(result.allowed, true);
    eq(result.resolvedPath, '/srv/data/files/doc.txt');
  });

  await test('check: encoded traversal attack blocked', async () => {
    const router = await call('src/index.mjs', 'createRouter', [{
      root: '/srv/data', rules: [{ pattern: '/files/**', action: 'allow', priority: 10 }], defaultAction: 'deny'
    }]);
    const result = await call('src/index.mjs', 'check', [router, '/files/%2e%2e/%2e%2e/etc/passwd']);
    eq(result.allowed, false);
  });

  await test('check: double-encoded traversal attack blocked', async () => {
    const router = await call('src/index.mjs', 'createRouter', [{
      root: '/srv/data', rules: [{ pattern: '/files/**', action: 'allow', priority: 10 }], defaultAction: 'deny'
    }]);
    const result = await call('src/index.mjs', 'check', [router, '/files/%252e%252e/%252e%252e/etc/passwd']);
    eq(result.allowed, false);
  });

  await test('check: backslash traversal attack blocked', async () => {
    const router = await call('src/index.mjs', 'createRouter', [{
      root: '/srv/data', rules: [{ pattern: '/files/**', action: 'allow', priority: 10 }], defaultAction: 'deny'
    }]);
    const result = await call('src/index.mjs', 'check', [router, '/files/..\\..\\etc\\passwd']);
    eq(result.allowed, false);
  });

  await test('check: null-byte injection blocked', async () => {
    const router = await call('src/index.mjs', 'createRouter', [{
      root: '/srv/data', rules: [{ pattern: '/files/**', action: 'allow', priority: 10 }], defaultAction: 'deny'
    }]);
    const result = await call('src/index.mjs', 'check', [router, '/files/doc.txt\0.jpg']);
    eq(result.allowed, true);
    // The null byte is stripped, so it resolves to /files/doc.txt.jpg
    eq(result.resolvedPath, '/srv/data/files/doc.txt.jpg');
  });

  await test('check: denied by policy', async () => {
    const router = await call('src/index.mjs', 'createRouter', [{
      root: '/srv/data',
      rules: [
        { pattern: '/public/**', action: 'allow', priority: 10 },
        { pattern: '/private/**', action: 'deny', priority: 20 }
      ],
      defaultAction: 'deny'
    }]);
    eq((await call('src/index.mjs', 'check', [router, '/private/secret.txt'])).allowed, false);
    eq((await call('src/index.mjs', 'check', [router, '/public/index.html'])).allowed, true);
  });

  await test('check: defaultAction deny blocks unmatched paths', async () => {
    const router = await call('src/index.mjs', 'createRouter', [{
      root: '/srv/data', rules: [{ pattern: '/allowed/**', action: 'allow', priority: 10 }], defaultAction: 'deny'
    }]);
    const result = await call('src/index.mjs', 'check', [router, '/other/file.txt']);
    eq(result.allowed, false);
  });

  await test('check: defaultAction allow permits unmatched paths', async () => {
    const router = await call('src/index.mjs', 'createRouter', [{
      root: '/srv/data', rules: [{ pattern: '/blocked/**', action: 'deny', priority: 10 }], defaultAction: 'allow'
    }]);
    const result = await call('src/index.mjs', 'check', [router, '/other/file.txt']);
    eq(result.allowed, true);
  });

  await test('check: audit trail has three stages', async () => {
    const router = await call('src/index.mjs', 'createRouter', [{
      root: '/srv/data', rules: [{ pattern: '/files/**', action: 'allow', priority: 10 }], defaultAction: 'deny'
    }]);
    const result = await call('src/index.mjs', 'check', [router, '/files/doc.txt']);
    eq(result.steps.length, 3);
    eq(result.steps[0].stage, 'normalize');
    eq(result.steps[1].stage, 'jail');
    eq(result.steps[2].stage, 'policy');
  });

  await test('createRouter: invalid config rejected', async () => {
    await rejects(() => call('src/index.mjs', 'createRouter', [{ root: 'relative', rules: [], defaultAction: 'deny' }]));
    await rejects(() => call('src/index.mjs', 'createRouter', [{ root: '/ok', rules: [], defaultAction: 'invalid' }]));
  });
}
