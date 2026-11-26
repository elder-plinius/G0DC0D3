'use strict';

(() => {
  const REPO = 'elder-plinius/G0DC0D3';
  const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
  const RELEASES_URL = `https://github.com/${REPO}/releases`;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // Theme toggle
  const html = document.documentElement;
  const themeBtn = $('#theme-toggle');
  const themeIcon = $('#theme-icon');
  function applyTheme(theme) {
    const next = theme === 'light' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    if (themeIcon) themeIcon.textContent = next === 'light' ? '☾' : '☀';
    try { localStorage.setItem('godcode.site.theme', next); } catch {}
  }
  try {
    const saved = localStorage.getItem('godcode.site.theme');
    if (saved === 'light' || saved === 'dark') applyTheme(saved);
  } catch {}
  themeBtn?.addEventListener('click', () => {
    applyTheme(html.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
  });

  // Showcase screenshot tabs
  const SHOTS = {
    dark: {
      src: './assets/godmode-dark.png',
      alt: 'GODMODƎ dark workspace showing multi-model chat and controls',
      title: 'GODMODƎ Workspace',
      desc: 'Multi-model chat, Ultra-Plinian answer racing, live HTML5/SVG preview canvas, and sticky fallback waterfalls.'
    },
    light: {
      src: './assets/godcode-light.png',
      alt: 'GODCODƎ light coding workspace with repository diff and build controls',
      title: 'GODCODƎ Coding Workspace',
      desc: 'Attach local Git repos, review surgical patches, switch Plan/Build mode, and rewind checkpoints cleanly.'
    },
    lab: {
      src: './assets/godmode-system-lab.png',
      alt: 'System Lab prompt transparency inspector and live wire trace',
      title: 'System Lab · Prompt Transparency',
      desc: 'Inspect and customize every system prompt block, view live wire traces, and audit outbound Zero Data Retention posture.'
    }
  };
  $$('.showcase-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const shot = SHOTS[btn.dataset.shot];
      if (!shot) return;
      $$('.showcase-tab').forEach(other => {
        const active = other === btn;
        other.classList.toggle('active', active);
        other.setAttribute('aria-selected', String(active));
      });
      const img = $('#showcase-img');
      const cap = $('#showcase-caption');
      if (img) { img.src = shot.src; img.alt = shot.alt; }
      if (cap) {
        cap.textContent = '';
        const strong = document.createElement('strong');
        strong.textContent = shot.title;
        cap.append(strong, ` — ${shot.desc}`);
      }
    });
  });

  // Copy buttons
  $$('[data-copy-target]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const target = document.getElementById(btn.dataset.copyTarget);
      if (!target) return;
      const original = btn.textContent;
      try {
        await navigator.clipboard.writeText(target.textContent.trim());
        btn.textContent = 'Copied';
      } catch {
        btn.textContent = 'Select text';
      }
      setTimeout(() => { btn.textContent = original; }, 1600);
    });
  });

  // OS detection for smart primary CTA & recommended card highlight
  function detectPlatform() {
    const ua = navigator.userAgent || '';
    const plat = navigator.userAgentData?.platform || navigator.platform || '';
    if (/mac/i.test(plat) || /macintosh|mac os x/i.test(ua)) {
      return { key: 'macos-arm64', card: 'macos-arm64', label: 'Download for macOS', sub: 'Apple Silicon (.dmg) · Node 22 bundled' };
    }
    if (/linux/i.test(plat) || /linux/i.test(ua)) {
      const isArm = /aarch64|arm64/i.test(ua);
      return {
        key: isArm ? 'linux-deb-arm64' : 'linux-deb-x64',
        card: 'linux-deb',
        label: `Download for Linux (${isArm ? 'arm64' : 'x64'})`,
        sub: 'Debian / Ubuntu .deb · portable .tar.gz below'
      };
    }
    return { key: 'macos-arm64', card: null, label: 'Download for macOS / Linux', sub: 'Self-contained · Node 22 bundled' };
  }

  const detected = detectPlatform();
  if (detected.card) {
    const card = $(`.dl-card[data-platform="${detected.card}"]`);
    card?.classList.add('is-recommended');
  }
  const primaryBtn = $('#primary-download-btn');
  const primaryLabel = $('#primary-download-label');
  const primarySub = $('#primary-download-sub');
  if (primaryLabel) primaryLabel.textContent = detected.label;
  if (primarySub) primarySub.textContent = detected.sub;

  function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function matchAssets(assets) {
    const find = rx => assets.find(a => rx.test(a?.name || ''));
    return {
      'macos-arm64': find(/macos-arm64\.dmg$/i),
      'macos-x64': find(/macos-x64\.dmg$/i),
      'linux-deb-x64': find(/_amd64\.deb$/i),
      'linux-deb-arm64': find(/_arm64\.deb$/i),
      'linux-tar-x64': find(/linux-x64\.tar\.gz$/i),
      'linux-tar-arm64': find(/linux-arm64\.tar\.gz$/i),
      checksums: find(/^SHA256SUMS\.txt$/i)
    };
  }

  async function hydrateLatestRelease() {
    try {
      const res = await fetch(RELEASES_API, { headers: { accept: 'application/vnd.github+json' } });
      if (!res.ok) return;
      const rel = await res.json();
      const tag = typeof rel?.tag_name === 'string' ? rel.tag_name : '';
      const assets = Array.isArray(rel?.assets) ? rel.assets : [];
      if (!tag) return;

      const badge = $('#release-badge-text');
      if (badge) badge.textContent = `${tag} · Open Source (AGPL-3.0) · Zero Telemetry · 0 npm Dependencies`;

      const relLink = $('#releases-page-link');
      if (relLink && rel.html_url) {
        relLink.href = rel.html_url;
        relLink.textContent = `Release ${tag} on GitHub ↗`;
      }

      const mapped = matchAssets(assets);
      for (const [key, asset] of Object.entries(mapped)) {
        if (!asset?.browser_download_url) continue;
        if (key === 'checksums') {
          const sumLink = $('#checksums-link');
          if (sumLink) sumLink.href = asset.browser_download_url;
          continue;
        }
        const link = $(`[data-asset="${key}"]`);
        if (link) link.href = asset.browser_download_url;
        const sizeEl = $(`[data-size="${key}"]`);
        if (sizeEl && asset.size) sizeEl.textContent = `${formatSize(asset.size)}`;
      }

      const primaryAsset = mapped[detected.key];
      if (primaryBtn && primaryAsset?.browser_download_url) {
        primaryBtn.href = primaryAsset.browser_download_url;
        primaryBtn.setAttribute('rel', 'noopener noreferrer');
        if (primarySub && primaryAsset.size) {
          primarySub.textContent = `${tag} · ${formatSize(primaryAsset.size)} · Node 22 bundled`;
        }
      }

      const attestCmd = $('#verify-attest-cmd');
      if (attestCmd && primaryAsset?.name) {
        attestCmd.textContent = `gh attestation verify ${primaryAsset.name} --repo ${REPO}`;
      }

      const digests = assets.filter(a => typeof a?.digest === 'string' && a.digest.startsWith('sha256:'));
      if (digests.length) {
        const list = $('#digest-list');
        const wrap = $('#digest-wrap');
        if (list && wrap) {
          list.textContent = '';
          for (const item of digests) {
            const row = document.createElement('div');
            row.className = 'digest-row';
            const name = document.createElement('span');
            name.textContent = item.name;
            const hash = document.createElement('span');
            hash.className = 'digest-hash';
            hash.textContent = item.digest.slice('sha256:'.length);
            row.append(name, hash);
            list.append(row);
          }
          wrap.hidden = false;
        }
      }
    } catch {
      const relLink = $('#releases-page-link');
      if (relLink) relLink.href = RELEASES_URL;
    }
  }

  void hydrateLatestRelease();
})();
