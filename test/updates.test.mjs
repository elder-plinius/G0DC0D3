import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  RELEASES_WEB_URL,
  SITE_URL,
  checkForUpdates,
  compareSemver,
  parseSemver,
  pickPlatformAsset,
  sanitizeReleaseUrl,
} from '../src/updates.mjs';
import { createApp } from '../src/server.mjs';

test('updates: parseSemver and compareSemver handle stable, prerelease, and v-prefixed versions', () => {
  assert.deepEqual(parseSemver('v0.3.1'), { major: 0, minor: 3, patch: 1, prerelease: '' });
  assert.equal(parseSemver('not-a-version'), null);
  assert.equal(compareSemver('0.3.1', '0.3.0'), 1);
  assert.equal(compareSemver('0.3.0', '0.3.0'), 0);
  assert.equal(compareSemver('0.2.9', '0.3.0'), -1);
  assert.equal(compareSemver('0.3.1', '0.3.1-rc.1'), 1);
  assert.equal(compareSemver('0.3.1-beta.2', '0.3.1-beta.10'), -1);
});

test('updates: sanitizeReleaseUrl strictly allowlists elder-plinius/G0DC0D3 releases and godcode.gg over HTTPS', () => {
  assert.equal(
    sanitizeReleaseUrl('https://github.com/elder-plinius/G0DC0D3/releases/tag/v0.3.1'),
    'https://github.com/elder-plinius/G0DC0D3/releases/tag/v0.3.1'
  );
  assert.equal(sanitizeReleaseUrl('https://godcode.gg/download'), 'https://godcode.gg/download');
  assert.equal(sanitizeReleaseUrl('http://github.com/elder-plinius/G0DC0D3/releases/tag/v0.3.1'), RELEASES_WEB_URL);
  assert.equal(sanitizeReleaseUrl('https://github.com/attacker/G0DC0D3/releases/tag/v9.9.9'), RELEASES_WEB_URL);
  assert.equal(sanitizeReleaseUrl('https://evil.example/payload.dmg'), RELEASES_WEB_URL);
  assert.equal(sanitizeReleaseUrl('javascript:alert(1)'), RELEASES_WEB_URL);
  assert.equal(sanitizeReleaseUrl('https://user:pass@github.com/elder-plinius/G0DC0D3/releases'), RELEASES_WEB_URL);
});

test('updates: pickPlatformAsset selects matching OS/arch asset and strips untrusted download URLs', () => {
  const assets = [
    { name: 'G0DM0D3-0.3.1-macOS-arm64.dmg.sha256', browser_download_url: 'https://github.com/elder-plinius/G0DC0D3/releases/download/v0.3.1/G0DM0D3-0.3.1-macOS-arm64.dmg.sha256', size: 96 },
    { name: 'G0DM0D3-0.3.1-macOS-arm64.dmg', browser_download_url: 'https://github.com/elder-plinius/G0DC0D3/releases/download/v0.3.1/G0DM0D3-0.3.1-macOS-arm64.dmg', size: 12000000 },
    { name: 'G0DM0D3-0.3.1-evil.dmg', browser_download_url: 'https://evil.test/G0DM0D3.dmg', size: 123 },
    { name: 'G0DM0D3-0.3.1-linux-x64.tar.gz', browser_download_url: 'https://github.com/elder-plinius/G0DC0D3/releases/download/v0.3.1/G0DM0D3-0.3.1-linux-x64.tar.gz', size: 9000000 },
  ];
  const mac = pickPlatformAsset(assets, { platform: 'darwin', arch: 'arm64' });
  assert.equal(mac?.name, 'G0DM0D3-0.3.1-macOS-arm64.dmg');
  const linux = pickPlatformAsset(assets, { platform: 'linux', arch: 'x64' });
  assert.equal(linux?.name, 'G0DM0D3-0.3.1-linux-x64.tar.gz');
  const onlyEvil = pickPlatformAsset([assets[2]], { platform: 'darwin', arch: 'arm64' });
  assert.equal(onlyEvil, null);
});

test('updates: checkForUpdates blocks Local-Only mode with zero network calls and detects available updates cleanly', async () => {
  let called = 0;
  await assert.rejects(
    () => checkForUpdates({
      currentVersion: '0.3.0',
      privacy: { localOnly: true },
      fetchImpl: async () => { called += 1; throw new Error('must not fetch'); },
    }),
    err => err.code === 'PRIVACY_LOCAL_ONLY' && err.status === 403
  );
  assert.equal(called, 0);

  let seenOpts = null;
  const res = await checkForUpdates({
    currentVersion: '0.3.0',
    privacy: { localOnly: false },
    platform: 'darwin',
    arch: 'arm64',
    fetchImpl: async (_url, opts) => {
      seenOpts = opts;
      return new Response(JSON.stringify({
        tag_name: 'v0.3.1',
        name: 'G0DC0D3 v0.3.1',
        draft: false,
        prerelease: false,
        published_at: '2026-11-28T00:00:00Z',
        html_url: 'https://github.com/elder-plinius/G0DC0D3/releases/tag/v0.3.1',
        body: '<b>Hardening</b>\n- Security & ACP upgrades',
        assets: [
          { name: 'G0DM0D3-0.3.1-arm64.dmg', browser_download_url: 'https://github.com/elder-plinius/G0DC0D3/releases/download/v0.3.1/G0DM0D3-0.3.1-arm64.dmg', size: 42000 },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(seenOpts.redirect, 'error');
  assert.equal(res.updateAvailable, true);
  assert.equal(res.status, 'update_available');
  assert.equal(res.latestVersion, '0.3.1');
  assert.equal(res.siteUrl, SITE_URL);
  assert.equal(res.downloadAsset?.name, 'G0DM0D3-0.3.1-arm64.dmg');
  assert.ok(!res.notesPreview.includes('<b>'));
});

test('updates: POST /api/updates/check enforces CSRF header and Local-Only mode on live server', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'g0d-updates-api-'));
  const app = await createApp({ dataDir: dir, auth: false });
  const baseUrl = await app.listen(0);
  try {
    // Missing x-g0d-request blocked
    const csrfRes = await fetch(`${baseUrl}/api/updates/check`, { method: 'POST', body: '{}' });
    assert.equal(csrfRes.status, 403);

    // Enable Local-Only mode -> POST /api/updates/check must fail closed with 403 PRIVACY_LOCAL_ONLY
    const patchRes = await fetch(`${baseUrl}/api/privacy`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
      body: JSON.stringify({ localOnly: true }),
    });
    assert.equal(patchRes.status, 200);

    const localRes = await fetch(`${baseUrl}/api/updates/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
      body: '{}',
    });
    assert.equal(localRes.status, 403);
    const localJson = await localRes.json();
    assert.equal(localJson.code, 'PRIVACY_LOCAL_ONLY');
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
