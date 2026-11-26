import assert from 'node:assert/strict';

export async function runRedReconProbes({call, test, eq}) {

  // ── Scanner probes ──────────────────────────────────────────────

  await test('SSH service identification on default port', async () => {
    const r = await call('src/scanner.mjs', 'identifyService', [22, 'SSH-2.0-OpenSSH_8.9']);
    eq(r, {port: 22, service: 'ssh', version: 'OpenSSH_8.9', confidence: 1.0});
  });

  await test('HTTP service identification', async () => {
    const r = await call('src/scanner.mjs', 'identifyService', [80, 'HTTP/1.1 200 OK']);
    eq(r, {port: 80, service: 'http', version: '200 OK', confidence: 1.0});
  });

  await test('FTP identification on port 21', async () => {
    const r = await call('src/scanner.mjs', 'identifyService', [21, '220 Welcome to FTP']);
    eq(r, {port: 21, service: 'ftp', version: 'Welcome to FTP', confidence: 1.0});
  });

  await test('SMTP identification on port 25 (220 prefix → smtp not ftp)', async () => {
    const r = await call('src/scanner.mjs', 'identifyService', [25, '220 mail.example.com ESMTP']);
    eq(r.service, 'smtp');
    eq(r.port, 25);
  });

  await test('SSH on non-standard port gets reduced confidence', async () => {
    const r = await call('src/scanner.mjs', 'identifyService', [2222, 'SSH-2.0-OpenSSH_8.9']);
    eq(r.service, 'ssh');
    eq(r.confidence, 0.7);
    eq(r.version, 'OpenSSH_8.9');
  });

  await test('Unknown service returns confidence 0', async () => {
    const r = await call('src/scanner.mjs', 'identifyService', [31337, 'HELLO']);
    eq(r, {port: 31337, service: 'unknown', version: null, confidence: 0});
  });

  await test('Redis service identification', async () => {
    const r = await call('src/scanner.mjs', 'identifyService', [6379, 'REDIS:6.2.7']);
    eq(r.service, 'redis');
    eq(r.version, '6.2.7');
    eq(r.confidence, 1.0);
  });

  await test('MySQL service identification', async () => {
    const r = await call('src/scanner.mjs', 'identifyService', [3306, 'MySQL 8.0.32']);
    eq(r.service, 'mysql');
    eq(r.confidence, 1.0);
  });

  await test('Honeypot detection — excessive open ports', async () => {
    const scanResults = Array.from({length: 150}, (_, i) => ({port: 1000 + i, banner: 'SSH-2.0-OpenSSH_8.9'}));
    const r = await call('src/scanner.mjs', 'detectHoneypot', [scanResults]);
    assert.ok(r.isHoneypot, 'Should detect honeypot with 150 open ports');
    assert.ok(r.indicators.includes('excessive_open_ports'), 'Should include excessive_open_ports indicator');
  });

  await test('Honeypot detection — normal host is clean', async () => {
    const scanResults = [
      {port: 22, banner: 'SSH-2.0-OpenSSH_8.9'},
      {port: 80, banner: 'HTTP/1.1 200 OK'},
      {port: 443, banner: 'HTTP/1.1 200 OK'},
    ];
    const r = await call('src/scanner.mjs', 'detectHoneypot', [scanResults]);
    assert.ok(!r.isHoneypot, 'Normal host should not be flagged');
    eq(r.indicators, []);
  });

  await test('generateReport sorts by confidence desc then port asc', async () => {
    const scanResults = [
      {port: 8080, banner: 'HTTP/1.1 200 OK'},
      {port: 22, banner: 'SSH-2.0-OpenSSH_8.9'},
      {port: 31337, banner: 'HELLO'},
      {port: 80, banner: 'HTTP/1.1 200 OK'},
    ];
    const report = await call('src/scanner.mjs', 'generateReport', [scanResults]);
    eq(report[0].port, 22);
    eq(report[0].confidence, 1.0);
    eq(report[1].port, 80);
    eq(report[1].confidence, 1.0);
    eq(report[2].port, 8080);
    eq(report[2].confidence, 0.7);
    eq(report[3].port, 31337);
    eq(report[3].confidence, 0);
  });

  // ── Credential spray probes ─────────────────────────────────────

  await test('Horizontal spray pattern (password-first)', async () => {
    const r = await call('src/spray.mjs', 'generateCredentials', [
      ['admin', 'root'], ['pass1', 'pass2'], {pattern: 'horizontal'}
    ]);
    eq(r, [
      {username: 'admin', password: 'pass1'},
      {username: 'root', password: 'pass1'},
      {username: 'admin', password: 'pass2'},
      {username: 'root', password: 'pass2'},
    ]);
  });

  await test('Vertical spray pattern (user-first)', async () => {
    const r = await call('src/spray.mjs', 'generateCredentials', [
      ['admin', 'root'], ['pass1', 'pass2'], {pattern: 'vertical'}
    ]);
    eq(r, [
      {username: 'admin', password: 'pass1'},
      {username: 'admin', password: 'pass2'},
      {username: 'root', password: 'pass1'},
      {username: 'root', password: 'pass2'},
    ]);
  });

  await test('Credential deduplication', async () => {
    const r = await call('src/spray.mjs', 'generateCredentials', [
      ['admin', 'admin'], ['pass1'], {pattern: 'horizontal'}
    ]);
    eq(r, [{username: 'admin', password: 'pass1'}]);
  });

  await test('Spray plan has inter-attempt delays', async () => {
    const creds = [{username: 'admin', password: 'pass1'}, {username: 'admin', password: 'pass2'}];
    const plan = await call('src/spray.mjs', 'buildSprayPlan', [
      ['target1'], creds, {delayMs: 500}
    ]);
    eq(plan[0].delayBefore, 0);
    eq(plan[1].delayBefore, 500);
  });

  await test('Spray plan inserts cooldown at lockout threshold', async () => {
    const creds = [
      {username: 'a', password: '1'},
      {username: 'b', password: '2'},
      {username: 'c', password: '3'},
      {username: 'd', password: '4'},
    ];
    const plan = await call('src/spray.mjs', 'buildSprayPlan', [
      ['t1'], creds, {delayMs: 100, lockoutThreshold: 3, cooldownMs: 5000}
    ]);
    assert.ok(plan.length === 4);
    assert.ok(plan[3].delayBefore >= 5000, 'Fourth attempt should trigger cooldown delay after 3-attempt threshold');
  });

  await test('Lockout detection from HTTP 429', async () => {
    const r = await call('src/spray.mjs', 'detectLockout', [[
      {target: 'host1', username: 'admin', statusCode: 429, body: ''},
    ]]);
    assert.ok(r.locked);
    eq(r.accounts.length, 1);
    eq(r.accounts[0].reason, 'rate_limited');
  });

  await test('Lockout detection from body text', async () => {
    const r = await call('src/spray.mjs', 'detectLockout', [[
      {target: 'host1', username: 'admin', statusCode: 200, body: 'Account locked due to too many attempts'},
    ]]);
    assert.ok(r.locked);
    assert.ok(r.accounts.length >= 1);
  });

  await test('No lockout for normal responses', async () => {
    const r = await call('src/spray.mjs', 'detectLockout', [[
      {target: 'host1', username: 'admin', statusCode: 200, body: 'Login successful'},
      {target: 'host2', username: 'root', statusCode: 401, body: 'Invalid credentials'},
    ]]);
    assert.ok(!r.locked);
    eq(r.accounts, []);
  });

  // ── WAF bypass probes ───────────────────────────────────────────

  await test('WAF URL encoding of special characters', async () => {
    const r = await call('src/waf.mjs', 'encodePayload', ['<script>', 'url']);
    eq(r, '%3Cscript%3E');
  });

  await test('WAF double-URL encoding', async () => {
    const r = await call('src/waf.mjs', 'encodePayload', ['<script>', 'double-url']);
    assert.ok(r.includes('%253C'), 'Double-URL should encode % from first pass');
    assert.ok(r.includes('%253E'), 'Double-URL should double-encode >');
  });

  await test('WAF case toggling evasion', async () => {
    const r = await call('src/waf.mjs', 'encodePayload', ['alert', 'case']);
    eq(r, 'AlErT');
  });

  await test('WAF hex encoding', async () => {
    const r = await call('src/waf.mjs', 'encodePayload', ['<', 'hex']);
    eq(r, '\\x3c');
  });

  await test('WAF unknown technique throws', async () => {
    let threw = false;
    try { await call('src/waf.mjs', 'encodePayload', ['test', 'bogus']); }
    catch { threw = true; }
    assert.ok(threw, 'Unknown encoding technique should throw');
  });

  await test('WAF testRule uses regex matching', async () => {
    const match = await call('src/waf.mjs', 'testRule', ['<script>alert(1)</script>', '<script>']);
    assert.ok(match, 'Regex pattern should match');
    const noMatch = await call('src/waf.mjs', 'testRule', ['normal text', '<script>']);
    assert.ok(!noMatch, 'Should not match benign text');
  });

  await test('WAF testRule handles invalid regex gracefully', async () => {
    const r = await call('src/waf.mjs', 'testRule', ['test', '[invalid(']);
    eq(r, false);
  });

  await test('WAF findBypass returns first successful technique', async () => {
    const rules = ['<script', 'alert\\('];
    const r = await call('src/waf.mjs', 'findBypass', ['<script>alert(1)</script>', rules]);
    assert.ok(r !== null, 'Should find at least one bypass');
    assert.ok(typeof r.technique === 'string');
    assert.ok(typeof r.encoded === 'string');
    const matchesAnyRule = rules.some(rule => {
      try { return new RegExp(rule, 'i').test(r.encoded); } catch { return false; }
    });
    assert.ok(!matchesAnyRule, 'Encoded payload should evade all rules');
  });

  await test('WAF findBypass returns null when no technique works', async () => {
    const rules = ['.'];
    const r = await call('src/waf.mjs', 'findBypass', ['test', rules]);
    eq(r, null);
  });
}
