import { APP_VERSION } from './version.mjs';

export const UPDATES_REPO = 'elder-plinius/G0DC0D3';
export const RELEASES_API_URL = `https://api.github.com/repos/${UPDATES_REPO}/releases/latest`;
export const RELEASES_WEB_URL = `https://github.com/${UPDATES_REPO}/releases`;
export const SITE_URL = 'https://godcode.gg';

const MAX_RELEASE_BYTES = 256 * 1024;
const ALLOWED_GITHUB_PREFIX = `/${UPDATES_REPO}/releases`;

export function parseSemver(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/^v/i, '');
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(trimmed);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return null;
  return { major, minor, patch, prerelease: match[4] || '' };
}

export function compareSemver(aRaw, bRaw) {
  const a = typeof aRaw === 'string' ? parseSemver(aRaw) : aRaw;
  const b = typeof bRaw === 'string' ? parseSemver(bRaw) : bRaw;
  if (!a || !b) return 0;
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  const aParts = a.prerelease.split('.');
  const bParts = b.prerelease.split('.');
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const ap = aParts[i];
    const bp = bParts[i];
    if (ap === undefined) return -1;
    if (bp === undefined) return 1;
    const aNum = /^\d+$/.test(ap);
    const bNum = /^\d+$/.test(bp);
    if (aNum && bNum) {
      const diff = Number(ap) - Number(bp);
      if (diff !== 0) return diff > 0 ? 1 : -1;
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1;
    } else if (ap !== bp) {
      return ap > bp ? 1 : -1;
    }
  }
  return 0;
}

export function sanitizeReleaseUrl(rawUrl, fallback = RELEASES_WEB_URL) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return fallback;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return fallback;
    const host = parsed.hostname.toLowerCase();
    if (host === 'github.com' && (parsed.pathname === ALLOWED_GITHUB_PREFIX || parsed.pathname.startsWith(`${ALLOWED_GITHUB_PREFIX}/`))) {
      return parsed.href;
    }
    if (host === 'godcode.gg' || host === 'www.godcode.gg') {
      return parsed.href;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

export function pickPlatformAsset(assets, { platform = process.platform, arch = process.arch } = {}) {
  if (!Array.isArray(assets) || !assets.length) return null;
  const safe = assets
    .filter(a => a && typeof a.name === 'string' && typeof a.browser_download_url === 'string')
    .map(a => {
      const url = sanitizeReleaseUrl(a.browser_download_url, '');
      return url ? { name: a.name.trim(), url, size: Number.isFinite(Number(a.size)) ? Number(a.size) : null } : null;
    })
    .filter(Boolean);
  if (!safe.length) return null;
  const archTokens = arch === 'arm64' ? ['arm64', 'aarch64', 'apple'] : arch === 'x64' ? ['x64', 'x86_64', 'amd64', 'intel'] : [arch];
  const score = (asset) => {
    const lower = asset.name.toLowerCase();
    if (lower.endsWith('.sha256') || lower.endsWith('.sig') || lower.endsWith('.asc') || lower.includes('checksum')) return -1;
    let s = 0;
    if (platform === 'darwin') {
      if (lower.endsWith('.dmg')) s += 50;
      else if (lower.endsWith('.pkg')) s += 35;
      else if (lower.endsWith('.zip') && (lower.includes('mac') || lower.includes('darwin'))) s += 25;
      else return -1;
    } else if (platform === 'linux') {
      if (lower.endsWith('.appimage') || lower.endsWith('.tar.gz') || lower.endsWith('.deb')) s += 40;
      else return -1;
    } else if (platform === 'win32') {
      if (lower.endsWith('.exe') || lower.endsWith('.msi') || lower.endsWith('.zip')) s += 40;
      else return -1;
    } else {
      return -1;
    }
    if (archTokens.some(tok => lower.includes(tok))) s += 15;
    else if (lower.includes('universal')) s += 10;
    return s;
  };
  let best = null;
  let bestScore = -1;
  for (const asset of safe) {
    const sc = score(asset);
    if (sc > bestScore) {
      bestScore = sc;
      best = asset;
    }
  }
  return bestScore >= 0 ? best : null;
}

export function summarizeReleaseNotes(body, maxChars = 480) {
  const cleaned = String(body || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!cleaned) return '';
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars - 1).trimEnd()}…` : cleaned;
}

async function readBoundedText(response, maxBytes = MAX_RELEASE_BYTES) {
  if (!response?.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw Object.assign(new Error('Update metadata response exceeded maximum allowed size.'), { status: 502, code: 'UPDATE_RESPONSE_TOO_LARGE' });
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw Object.assign(new Error('Update metadata response exceeded maximum allowed size.'), { status: 502, code: 'UPDATE_RESPONSE_TOO_LARGE' });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function checkForUpdates({
  currentVersion = APP_VERSION,
  privacy = null,
  fetchImpl = fetch,
  timeoutMs = 8000,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (privacy?.localOnly || privacy?.settings?.localOnly) {
    throw Object.assign(
      new Error('Update checks are disabled while Local-Only privacy mode is enabled.'),
      { status: 403, code: 'PRIVACY_LOCAL_ONLY' }
    );
  }
  const normalizedCurrent = String(currentVersion || APP_VERSION).trim().replace(/^v/i, '');
  let response;
  try {
    response = await fetchImpl(RELEASES_API_URL, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(Math.max(1000, Math.min(20000, Number(timeoutMs) || 8000))),
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'G0DC0D3-UpdateCheck',
      },
    });
  } catch (error) {
    const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw Object.assign(
      new Error(isTimeout ? 'Update check timed out while contacting GitHub Releases.' : 'Could not reach GitHub Releases. Check your network connection or visit godcode.gg.'),
      { status: 502, code: isTimeout ? 'UPDATE_CHECK_TIMEOUT' : 'UPDATE_CHECK_FAILED' }
    );
  }
  if (!response.ok) {
    const detail = response.status === 403 || response.status === 429
      ? 'GitHub API rate limit reached. Try again later or check github.com/elder-plinius/G0DC0D3/releases.'
      : `GitHub Releases returned HTTP ${response.status}.`;
    throw Object.assign(new Error(detail), { status: 502, code: 'UPDATE_CHECK_HTTP_ERROR' });
  }
  const rawText = await readBoundedText(response, MAX_RELEASE_BYTES);
  let release;
  try {
    release = JSON.parse(rawText);
  } catch {
    throw Object.assign(new Error('GitHub Releases returned invalid JSON.'), { status: 502, code: 'UPDATE_CHECK_BAD_JSON' });
  }
  if (!release || typeof release !== 'object' || release.draft || release.prerelease) {
    return {
      checkedAt: new Date().toISOString(),
      currentVersion: normalizedCurrent,
      latestVersion: normalizedCurrent,
      tagName: `v${normalizedCurrent}`,
      updateAvailable: false,
      status: 'up_to_date',
      releaseName: `v${normalizedCurrent}`,
      publishedAt: null,
      releaseUrl: RELEASES_WEB_URL,
      siteUrl: SITE_URL,
      downloadAsset: null,
      notesPreview: '',
    };
  }
  const tagName = String(release.tag_name || '').trim();
  const parsedLatest = parseSemver(tagName);
  if (!parsedLatest) {
    throw Object.assign(new Error('Latest release tag is not a valid semantic version.'), { status: 502, code: 'UPDATE_CHECK_BAD_VERSION' });
  }
  const latestVersion = `${parsedLatest.major}.${parsedLatest.minor}.${parsedLatest.patch}${parsedLatest.prerelease ? `-${parsedLatest.prerelease}` : ''}`;
  const cmp = compareSemver(latestVersion, normalizedCurrent);
  const updateAvailable = cmp > 0;
  const status = cmp > 0 ? 'update_available' : cmp < 0 ? 'ahead' : 'up_to_date';
  return {
    checkedAt: new Date().toISOString(),
    currentVersion: normalizedCurrent,
    latestVersion,
    tagName: tagName || `v${latestVersion}`,
    updateAvailable,
    status,
    releaseName: String(release.name || tagName || `v${latestVersion}`).trim().slice(0, 120),
    publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
    releaseUrl: sanitizeReleaseUrl(release.html_url, RELEASES_WEB_URL),
    siteUrl: SITE_URL,
    downloadAsset: pickPlatformAsset(release.assets, { platform, arch }),
    notesPreview: summarizeReleaseNotes(release.body),
  };
}
