import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server.mjs';
import { Store } from '../src/store.mjs';
import { Broker, sha256 } from '../src/broker.mjs';
import { Runtime, normalizePolicy } from '../src/runtime.mjs';
import { gitInit, gitLog } from '../src/git.mjs';
import { BrowserPool, findChromiumBinary } from '../src/browser-env.mjs';

test('Browsing tool E2E: Shadow DOM, modal prioritization, async SPA wait, network 500 capture, and select option diagnostics', async t => {
  const binary = await findChromiumBinary();
  if (!binary) {
    t.skip('No Chromium binary installed on this host');
    return;
  }

  const targetServer = http.createServer((req, res) => {
    if (req.url === '/api/fail') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'simulated backend 500' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    const navLinks = Array.from({ length: 68 }, (_, i) => `<a href="#nav-${i}" style="display:inline-block;margin:2px;font-size:11px">Nav ${i}</a>`).join('');
    res.end(`<!doctype html>
      <html>
        <head><title>Complex SPA Smoke Target</title></head>
        <body style="font-family:system-ui;padding:20px;min-height:1800px">
          <nav>${navLinks}</nav>
          <h1>SPA Control Center</h1>
          <select id="plan-select">
            <option value="starter">Starter Tier</option>
            <option value="pro">Pro Tier</option>
            <option value="enterprise">Enterprise Tier</option>
          </select>
          <button id="toggle-panel" type="button" aria-expanded="false">Expand Details</button>
          <button id="load-async" type="button">Load Async Data</button>
          <button id="open-modal" type="button">Open Modal</button>
          <div id="async-slot">Idle</div>
          <god-widget id="widget"></god-widget>
          <dialog id="confirm-modal">
            <h2>Confirm Deployment</h2>
            <button id="modal-confirm" type="button">Ship Release</button>
            <button id="modal-close" type="button">Cancel</button>
          </dialog>
          <script>
            class GodWidget extends HTMLElement {
              constructor() {
                super();
                const root = this.attachShadow({ mode: 'open' });
                root.innerHTML = \`
                  <div style="margin-top:12px;padding:12px;border:1px solid #666">
                    <input id="shadow-input" placeholder="Shadow query" />
                    <button id="shadow-btn" type="button">Run Shadow Action</button>
                    <span id="shadow-out">ShadowIdle</span>
                  </div>
                \`;
                root.getElementById('shadow-btn').addEventListener('click', () => {
                  const val = root.getElementById('shadow-input').value;
                  root.getElementById('shadow-out').textContent = 'ShadowOK:' + val;
                });
              }
            }
            customElements.define('god-widget', GodWidget);

            document.getElementById('toggle-panel').addEventListener('click', e => {
              const next = e.target.getAttribute('aria-expanded') !== 'true';
              e.target.setAttribute('aria-expanded', String(next));
            });

            document.getElementById('load-async').addEventListener('click', () => {
              fetch('/api/fail').catch(() => {});
              setTimeout(() => {
                const el = document.createElement('div');
                el.id = 'async-ready';
                el.textContent = 'Hydrated Payload Ready!';
                const slot = document.getElementById('async-slot');
                slot.innerHTML = '';
                slot.appendChild(el);
              }, 350);
            });

            document.getElementById('open-modal').addEventListener('click', () => {
              document.getElementById('confirm-modal').showModal();
            });
            document.getElementById('modal-confirm').addEventListener('click', () => {
              document.getElementById('async-slot').textContent = 'ModalShipped!';
              document.getElementById('confirm-modal').close();
            });
          </script>
        </body>
      </html>`);
  });
  await new Promise(resolve => targetServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${targetServer.address().port}/`;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-v03-browser-'));
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-v03-browser-ws-'));
  const store = new Store(path.join(dir, 'state'));
  const broker = new Broker({ store });
  t.after(async () => {
    await broker.close();
    store.close();
    targetServer.close();
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(ws, { recursive: true, force: true });
  });

  const task = store.createTask({
    id: randomUUID(),
    title: 'Complex SPA browser smoke',
    status: 'running',
    epoch: 1,
    workspace: ws,
    workspaceKind: 'conversation',
    execution: { enabled: false, network: false, timeoutMs: 10000 },
    checksContractVersion: 1,
    checks: [],
  });
  const call = (name, args = {}) =>
    broker.execute(task.id, { name, args, id: randomUUID() }, { epoch: task.epoch, outbound: { privacy: { localOnly: true } } });

  // 1) Open SPA: verify scroll bounds, <select> options, and Shadow DOM controls discovered!
  const opened = await call('browser.open', { url, viewport: { width: 1200, height: 800 } });
  assert.equal(opened.ok, true, opened.error?.message);
  assert.ok(opened.scroll && opened.scroll.maxY > 500, 'should report page scroll bounds');
  const selectEl = opened.elements.find(e => e.tag === 'select');
  assert.ok(selectEl, 'select element discovered');
  assert.deepEqual(selectEl.options, ['Starter Tier', 'Pro Tier', 'Enterprise Tier']);
  const shadowInput = opened.elements.find(e => e.tag === 'input' && e.text.includes('Shadow query'));
  const shadowBtn = opened.elements.find(e => e.tag === 'button' && e.text.includes('Run Shadow Action'));
  assert.ok(shadowInput && shadowBtn, 'open Shadow DOM input and button must be discovered with refs');

  // 2) Drive open Shadow DOM controls by ref (type + click)!
  const typedShadow = await call('browser.act', { action: 'type', ref: shadowInput.ref, text: 'DeepDom42' });
  assert.equal(typedShadow.ok, true);
  const clickedShadow = await call('browser.act', { action: 'click', ref: shadowBtn.ref });
  assert.equal(clickedShadow.ok, true);
  assert.match(clickedShadow.text, /ShadowOK:DeepDom42/);

  // 3) Invalid <select> option gives actionable BROWSER_OPTION_NOT_FOUND with available options
  const badOpt = await call('browser.act', { action: 'select', selector: '#plan-select', text: 'Nonexistent' });
  assert.equal(badOpt.ok, false);
  assert.equal(badOpt.error.code, 'BROWSER_OPTION_NOT_FOUND');
  assert.match(badOpt.error.message, /Pro Tier/);

  const goodOpt = await call('browser.act', { action: 'select', selector: '#plan-select', text: 'Enterprise Tier' });
  assert.equal(goodOpt.ok, true);

  // 4) Toggle aria-expanded button & verify state flag in snapshot
  const toggled = await call('browser.act', { action: 'click', selector: '#toggle-panel' });
  assert.equal(toggled.ok, true);
  const toggleEl = toggled.elements.find(e => e.text.includes('Expand Details'));
  assert.equal(toggleEl?.state, 'expanded');

  // 5) Trigger async render + HTTP 500 fetch -> use browser.act wait for selector & text -> verify network error captured!
  await call('browser.act', { action: 'click', selector: '#load-async', waitMs: 50 });
  const waited = await call('browser.act', { action: 'wait', selector: '#async-ready', text: 'Hydrated Payload Ready!', waitMs: 3000 });
  assert.equal(waited.ok, true, waited.error?.message);
  assert.match(waited.text, /Hydrated Payload Ready!/);
  assert.ok(
    waited.consoleErrors.some(e => e.level === 'network' && e.message.includes('HTTP 500') && e.message.includes('/api/fail')),
    `expected HTTP 500 network error captured, got: ${JSON.stringify(waited.consoleErrors)}`
  );

  // 6) Timeout on unreachable selector returns BROWSER_WAIT_TIMEOUT cleanly without crashing session
  const timedOut = await call('browser.act', { action: 'wait', selector: '#never-appears', waitMs: 250 });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error.code, 'BROWSER_WAIT_TIMEOUT');

  // 7) Open <dialog> modal despite 68 nav links: modal button must be prioritized at top of elements!
  const modalOpened = await call('browser.act', { action: 'click', selector: '#open-modal' });
  assert.equal(modalOpened.ok, true);
  const shipBtn = modalOpened.elements.find(e => e.text.includes('Ship Release'));
  assert.ok(shipBtn, 'open modal button must be prioritized ahead of background links');
  assert.ok(modalOpened.elements.indexOf(shipBtn) < 5, 'modal controls should be prioritized first');
  const shipped = await call('browser.act', { action: 'click', ref: shipBtn.ref });
  assert.equal(shipped.ok, true);
  assert.match(shipped.text, /ModalShipped!/);

  await call('browser.close', {});
});

test('Complex multi-file codegen E2E: parallel reads, syntax diagnostic self-heal, failing test -> multi-hunk patch -> pass, git checkpoint/rewind, and Live Preview', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-v03-codegen-'));
  const ws = path.join(dir, 'ws');
  await fs.mkdir(path.join(ws, 'src'), { recursive: true });
  await fs.mkdir(path.join(ws, 'public'), { recursive: true });
  await fs.writeFile(path.join(ws, 'src', 'ledger.mjs'), 'export function total(items) {\n  return items.reduce((a, b) => a + b.price, 0);\n}\nexport function formatUsd(n) {\n  return "$" + n;\n}\n');
  await fs.writeFile(path.join(ws, 'src', 'tax.mjs'), 'export const TAX_RATE = 0.08;\n');
  await fs.writeFile(path.join(ws, 'public', 'index.html'), '<!doctype html><html><body><h1 id="title">Ledger</h1></body></html>\n');
  await gitInit(ws);

  let step = 0;
  let ledgerHash = '';
  const codegenAgent = {
    id: 'codegen-bot',
    label: 'Complex Codegen Bot',
    kind: 'http',
    tier: 'frontier',
    available: true,
    async turn(context) {
      step += 1;
      if (step === 1) {
        // Turn 1: parallel read batch across multiple files + glob
        return {
          type: 'tool',
          calls: [
            { id: 'r1', name: 'repo.read', args: { path: 'src/ledger.mjs' } },
            { id: 'r2', name: 'repo.read', args: { path: 'src/tax.mjs' } },
            { id: 'g1', name: 'repo.glob', args: { pattern: '**/*.{mjs,html}' } },
          ],
          usage: { input_tokens: 2400, output_tokens: 320 },
        };
      }
      if (step === 2) {
        // Turn 2: intentionally write a syntax-broken helper to verify immediate diagnostics feedback
        return {
          type: 'tool',
          calls: [{ id: 'w-bad', name: 'repo.write', args: { path: 'src/discount.mjs', content: 'export function applyDiscount(v, pct { return v * (1 - pct); }\n', expectedHash: null } }],
          usage: { input_tokens: 3100, output_tokens: 210 },
        };
      }
      if (step === 3) {
        // Verify the broker returned syntax diagnostics in history, then self-heal discount.mjs + update UI
        const badEvt = context.history.find(e => e.type === 'tool.completed' && e.data?.name === 'repo.write' && e.data?.result?.path === 'src/discount.mjs');
        assert.ok(badEvt?.data?.result?.diagnostics?.length >= 1, 'syntax diagnostic must reach model context');
        const badHash = badEvt.data.result.sha256;
        return {
          type: 'tool',
          calls: [
            { id: 'w-fix', name: 'repo.write', args: { path: 'src/discount.mjs', content: 'export function applyDiscount(v, pct) { return Number((v * (1 - pct)).toFixed(2)); }\n', expectedHash: badHash } },
          ],
          usage: { input_tokens: 3600, output_tokens: 290 },
        };
      }
      if (step === 4) {
        // Turn 4: run check.run -> fails because ledger.mjs isn't patched yet!
        return {
          type: 'tool',
          calls: [{ id: 'chk1', name: 'check.run', args: {} }],
          usage: { input_tokens: 4000, output_tokens: 150 },
        };
      }
      if (step === 5) {
        // Turn 5: atomic multi-hunk repo.patch on src/ledger.mjs + update public/index.html
        const ledgerFile = context.files.find(f => f.path === 'src/ledger.mjs');
        ledgerHash = ledgerFile.sha256;
        return {
          type: 'tool',
          calls: [{
            id: 'p1',
            name: 'repo.patch',
            args: {
              path: 'src/ledger.mjs',
              expectedHash: ledgerHash,
              edits: [
                { oldText: 'return items.reduce((a, b) => a + b.price, 0);', newText: 'return Number(items.reduce((a, b) => a + b.price * (b.qty ?? 1), 0).toFixed(2));' },
                { oldText: 'return "$" + n;', newText: 'return "$" + Number(n).toFixed(2);' },
              ],
            },
          }],
          usage: { input_tokens: 4500, output_tokens: 410 },
        };
      }
      if (step === 6) {
        const htmlFile = context.files.find(f => f.path === 'public/index.html');
        return {
          type: 'tool',
          calls: [{
            id: 'w-ui',
            name: 'repo.write',
            args: {
              path: 'public/index.html',
              expectedHash: htmlFile.sha256,
              content: '<!doctype html><html><body><h1 id="title">Ledger v2</h1><button id="calc-btn" class="cta">Calculate Total</button></body></html>\n',
            },
          }],
          usage: { input_tokens: 4800, output_tokens: 310 },
        };
      }
      return {
        type: 'message',
        finish: 'done',
        text: 'Implemented quantity-aware total(), formatted USD output, fixed discount.mjs syntax, and updated public/index.html.',
        usage: { input_tokens: 5100, output_tokens: 190 },
      };
    },
  };

  const runtime = new Runtime({
    dataDir: path.join(dir, 'state'),
    providers: new Map([['codegen-bot', codegenAgent]]),
    evaluator: async task => {
      const modUrl = `file://${path.join(task.workspace, 'src', 'ledger.mjs')}?t=${Date.now()}-${Math.random()}`;
      const discUrl = `file://${path.join(task.workspace, 'src', 'discount.mjs')}?t=${Date.now()}-${Math.random()}`;
      const snap = await runtime.snapshotTask(task.id);
      try {
        const { total, formatUsd } = await import(modUrl);
        const { applyDiscount } = await import(discUrl);
        const sub = total([{ price: 10.5, qty: 2 }, { price: 4.25, qty: 1 }]);
        const disc = applyDiscount(sub, 0.1);
        const ok = sub === 25.25 && formatUsd(disc) === '$22.73';
        return {
          status: ok ? 'pass' : 'fail',
          snapshotHash: snap.snapshotHash,
          checks: [{ name: 'ledger-math-and-discount', status: ok ? 'pass' : 'fail', detail: `sub=${sub} fmt=${formatUsd(disc)}` }],
        };
      } catch (err) {
        return {
          status: 'fail',
          snapshotHash: snap.snapshotHash,
          checks: [{ name: 'ledger-math-and-discount', status: 'fail', detail: err.message }],
        };
      }
    },
  });
  t.after(async () => {
    await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const task = await runtime.createTask({
    workspace: ws,
    objective: 'Support qty in ledger.mjs total(), 2-decimal USD formatting, add discount.mjs, and upgrade public/index.html',
    providers: ['codegen-bot'],
    policy: normalizePolicy({ mode: 'adaptive', maxCalls: 12, maxAttempts: 4 }),
  });
  const done = await runtime.run(task.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.verification?.status, 'pass');
  const commits = (await gitLog(ws, { limit: 10 })).trim().split('\n').filter(Boolean);
  assert.ok(commits.length >= 2, 'expected git auto-commit checkpoint');

  // Rewind 1 step restores public/index.html, and rewinding to initial checkpoint restores ledger.mjs
  const checkpoints = await runtime.listCheckpoints(task.id);
  assert.ok(checkpoints.length >= 2, 'expected multiple git checkpoints');
  const { rewind: rewind1 } = await runtime.rewindTask(task.id, 1);
  assert.equal(rewind1.ok, true);
  assert.match(await fs.readFile(path.join(ws, 'public', 'index.html'), 'utf8'), />Ledger</);

  const initialHash = checkpoints.at(-1).hash;
  const { rewind: rewindInit } = await runtime.rewindTask(task.id, { hash: initialHash });
  assert.equal(rewindInit.ok, true);
  const rewoundLedger = await fs.readFile(path.join(ws, 'src', 'ledger.mjs'), 'utf8');
  assert.match(rewoundLedger, /return "\$" \+ n;/);
});

test('Desktop UI E2E in real headless Chromium: live token/cost meter, Live Preview Click-to-Inspect -> composer roundtrip, dark & light themes, 0 console errors', async t => {
  const binary = await findChromiumBinary();
  if (!binary) {
    t.skip('No Chromium binary installed on this host');
    return;
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-v03-ui-'));
  const ws = path.join(dir, 'ws');
  await fs.mkdir(ws, { recursive: true });
  await fs.writeFile(
    path.join(ws, 'index.html'),
    `<!doctype html>
    <html>
      <head><title>Interactive Artifact</title><style>*{box-sizing:border-box;margin:0}body{background:#111;color:#fff;font-family:system-ui;padding:16px}#hero-title{font-size:22px;margin-bottom:12px}.cta{display:block;width:220px;height:52px;background:#8b5cf6;color:#fff;padding:10px 18px;border:0;border-radius:8px;font-size:15px}</style></head>
      <body>
        <h1 id="hero-title">Mission Control</h1>
        <button id="launch-btn" class="cta" type="button">Launch Rocket</button>
      </body>
    </html>`,
    'utf8'
  );

  const pricedProvider = {
    id: 'openrouter:anthropic-claude-sonnet-4.6',
    label: 'Claude Sonnet 4.6 · OpenRouter',
    model: 'anthropic/claude-sonnet-4.6',
    kind: 'http',
    tier: 'frontier',
    available: true,
    pricing: { inputPer1M: 3, outputPer1M: 15 },
    capabilities: { tools: true, nativeTools: true, portableContext: true, outputTokens: { initial: 4096, max: 16384 } },
    async turn() {
      return {
        type: 'message',
        finish: 'done',
        text: 'Built `index.html` with a Launch Rocket button.',
        usage: { input_tokens: 18000, output_tokens: 4000 },
      };
    },
  };

  const app = await createApp({ dataDir: dir, auth: false, providers: new Map([[pricedProvider.id, pricedProvider]]) });
  const root = await app.listen(0);
  const pool = new BrowserPool();
  t.after(async () => {
    await pool.closeAll();
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  // Create & run a conversation task that records real usage tokens + workspace HTML artifact
  const task = await app.runtime.createTask({
    workspace: ws,
    workspaceKind: 'conversation',
    title: 'Mission Control UI',
    objective: 'Build interactive Mission Control landing page',
    providers: [pricedProvider.id],
    acceptance: { mode: 'owner' },
  });
  await app.runtime.run(task.id);

  // Open the real GODMODƎ web UI in real headless Chromium
  const opened = await pool.open('ui-smoke', { url: root + '/', viewport: { width: 1440, height: 900 }, waitMs: 1200 }, { privacy: { localOnly: true } });
  assert.equal(opened.ok, true);
  assert.deepEqual(
    (opened.consoleErrors || []).filter(e => e.level === 'error'),
    [],
    `unexpected startup errors: ${JSON.stringify(opened.consoleErrors)} | text: ${opened.text.slice(0, 300)}`
  );

  // If sidebar is collapsed or first-run tour is open, handle cleanly and click our task
  const diag = JSON.parse((await pool.evaluate('ui-smoke', {
    expression: `({
      hasBtn: Boolean(document.querySelector('[data-select-task="${task.id}"]')),
      btnRect: (() => { const el = document.querySelector('[data-select-task="${task.id}"]'); if (!el) return null; const r = el.getBoundingClientRect(); return { w: r.width, h: r.height }; })(),
      dialogs: [...document.querySelectorAll('dialog[open]')].map(d => d.id),
      bodyCls: document.body.className,
      taskCount: document.querySelectorAll('[data-select-task]').length,
      loadingVisible: !document.querySelector('#initial-loading')?.classList.contains('hidden'),
    })`,
  })).result);
  assert.ok(diag.hasBtn, `expected task button in DOM, got diag=${JSON.stringify(diag)} text=${opened.text.slice(0, 250)}`);
  if (diag.dialogs.length) {
    await pool.act('ui-smoke', { action: 'press', key: 'Escape', waitMs: 200 }, { privacy: { localOnly: true } });
  }
  if (!diag.btnRect || diag.btnRect.w < 2) {
    await pool.act('ui-smoke', { action: 'click', selector: '#sidebar-toggle', waitMs: 300 }, { privacy: { localOnly: true } });
  }
  await pool.act('ui-smoke', { action: 'wait', selector: `[data-select-task="${task.id}"]`, waitMs: 3000 }, { privacy: { localOnly: true } });
  await pool.act('ui-smoke', { action: 'click', selector: `[data-select-task="${task.id}"]`, waitMs: 600 }, { privacy: { localOnly: true } });

  // 1) Verify live token & estimated cost pill renders in #task-meta-strip!
  //    18,000 * $3/1M ($0.054) + 4,000 * $15/1M ($0.060) = $0.114 -> "22.0k tok · ~$0.114"
  const usageEval = await pool.evaluate('ui-smoke', {
    expression: `({
      stripUsage: document.querySelector('#task-meta-strip .strip-usage')?.textContent?.trim() || '',
      stripTitle: document.querySelector('#task-meta-strip .strip-usage')?.getAttribute('title') || '',
      counters: document.querySelector('#task-counters')?.textContent?.trim() || '',
      inspectBtnVisible: Boolean(document.querySelector('[data-preview-inspect]')),
      iframeLoaded: Boolean(document.querySelector('.artifact-iframe')?.getAttribute('src')),
    })`,
  });
  const uiState = JSON.parse(usageEval.result);
  assert.match(uiState.stripUsage, /22\.0k tok/, `expected token count in meta strip, got: ${uiState.stripUsage}`);
  assert.match(uiState.stripUsage, /~\$0\.114/, `expected estimated API cost in meta strip, got: ${uiState.stripUsage}`);
  assert.match(uiState.counters, /22,000 tokens/);
  assert.match(uiState.counters, /~\$0\.114 est\./);

  // Ensure Live Preview dock is open (auto-open or click Preview button in meta strip)
  if (!uiState.inspectBtnVisible) {
    await pool.act('ui-smoke', { action: 'click', selector: '[data-toggle-artifact-dock]', waitMs: 500 }, { privacy: { localOnly: true } });
  }
  await pool.act('ui-smoke', { action: 'wait', selector: '[data-preview-inspect]', waitMs: 3000 }, { privacy: { localOnly: true } });

  // 2) Click "⌖ Inspect" and click the Launch Rocket button inside the sandboxed Live Preview iframe!
  await pool.act('ui-smoke', { action: 'click', selector: '[data-preview-inspect]', waitMs: 300 }, { privacy: { localOnly: true } });
  const inspectPressed = (await pool.evaluate('ui-smoke', {
    expression: `document.querySelector('[data-preview-inspect]')?.getAttribute('aria-pressed')`,
  })).result;
  assert.equal(inspectPressed, 'true', 'Inspect button should enter active picking state');

  // Compute coordinates of the Launch Rocket button inside the iframe relative to top-level viewport
  // (iframe is sandboxed without allow-same-origin, so top-level JS cannot touch its DOM — we click by viewport coordinates just like a real user!)
  const frameRect = JSON.parse((await pool.evaluate('ui-smoke', {
    expression: `(() => { const r = document.querySelector('.artifact-iframe').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })()`,
  })).result);
  assert.ok(frameRect.w > 200 && frameRect.h > 200, 'preview iframe must have visible dimensions');

  // Hover & click at (frameRect.x + 80, frameRect.y + 72) right on top of #launch-btn
  await pool.act('ui-smoke', { action: 'hover', x: frameRect.x + 80, y: frameRect.y + 72, waitMs: 150 }, { privacy: { localOnly: true } });
  await pool.act('ui-smoke', { action: 'click', x: frameRect.x + 80, y: frameRect.y + 72, waitMs: 350 }, { privacy: { localOnly: true } });

  const afterPick = JSON.parse((await pool.evaluate('ui-smoke', {
    expression: `({
      composer: document.querySelector('#composer-input')?.value || '',
      inspectPressed: document.querySelector('[data-preview-inspect]')?.getAttribute('aria-pressed') || '',
      overflowDark: document.documentElement.scrollWidth - window.innerWidth,
    })`,
  })).result);
  assert.match(afterPick.composer, /Element `#launch-btn`/, `expected picked #launch-btn selector in composer, got: ${afterPick.composer}`);
  assert.match(afterPick.composer, /"Launch Rocket"/);
  assert.match(afterPick.composer, /in index\.html:/);
  assert.equal(afterPick.inspectPressed, 'false', 'Inspect mode should automatically disengage after pick');
  assert.ok(afterPick.overflowDark <= 1, `expected <=1px horizontal overflow in dark theme, got ${afterPick.overflowDark}`);

  // 3) Toggle light theme & verify 0px overflow + 0 console/page errors!
  const lightCheck = JSON.parse((await pool.evaluate('ui-smoke', {
    expression: `(() => {
      window.G0DThemes?.apply?.('light', { persist: false, notify: false });
      return { overflowLight: document.documentElement.scrollWidth - window.innerWidth };
    })()`,
  })).result);
  assert.ok(lightCheck.overflowLight <= 1, `expected <=1px horizontal overflow in light theme, got ${lightCheck.overflowLight}`);

  const finalSnap = await pool.snapshot('ui-smoke', { maxChars: 1000 });
  const fatalErrors = (finalSnap.consoleErrors || []).filter(e => e.level === 'error');
  assert.deepEqual(fatalErrors, [], `expected 0 JS console errors in desktop UI, got: ${JSON.stringify(fatalErrors)}`);
});

test('OpenRouter key upgrade (3 legacy models -> 12+ defaults) and API Enable/Disable toggles persist cleanly without deleting saved keys', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0d-v03-api-toggles-'));
  const keychainStore = new Map([
    ['openrouter', { key: 'sk-or-v1-legacy-key', models: ['anthropic/claude-sonnet-4-6', 'openai/gpt-5.4', 'google/gemini-2.5-pro'] }],
    ['anthropic', { key: 'sk-ant-api03-test-key', models: ['claude-sonnet-4-6'] }],
  ]);
  const fakeKeychain = {
    async read(provider) { return keychainStore.get(provider) ?? null; },
    async write(provider, record) { keychainStore.set(provider, record); },
  };
  const app = await createApp({ dataDir: dir, auth: false, keychain: fakeKeychain });
  const root = await app.listen(0);
  t.after(async () => {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  // 1) Re-connecting an OpenRouter key upgrades legacy 3-model keychain entry to all 12 defaults + preserves legacy models!
  const connRes = await fetch(root + '/api/providers/key', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
    body: JSON.stringify({ key: 'sk-or-v1-fresh-key', provider: 'openrouter' }),
  });
  assert.equal(connRes.status, 200);
  const connData = await connRes.json();
  assert.equal(connData.provider, 'openrouter');
  assert.ok(connData.registered.length >= 12, `expected >= 12 OpenRouter models after key connect, got ${connData.registered.length}`);
  assert.ok(connData.registered.includes('openrouter:nousresearch-hermes-4-405b'));

  // 2) Disable OpenRouter via PATCH /api/providers/profile -> hides models & catalog, keeps key in keychain
  const disRes = await fetch(root + '/api/providers/profile', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
    body: JSON.stringify({ provider: 'openrouter', enabled: false }),
  });
  assert.equal(disRes.status, 200);
  const disData = await disRes.json();
  assert.equal(disData.enabled, false);
  assert.equal(disData.openrouterConnectionId, null);
  assert.ok(disData.providers.filter(p => p.id.startsWith('openrouter:')).every(p => p.available === false));
  assert.ok(disData.providers.some(p => p.id.startsWith('anthropic:') && p.available === true), 'other APIs stay active');
  const orProfileOff = disData.connectedApiProviders.find(p => p.provider === 'openrouter');
  assert.equal(orProfileOff?.enabled, false, 'disabled API must still appear in connectedApiProviders so user can re-enable it');

  const orCatalogOff = await (await fetch(root + '/api/providers/openrouter-models')).json();
  assert.equal(orCatalogOff.connected, false);
  assert.equal(orCatalogOff.disabled, true);

  // 3) Re-enable OpenRouter -> restores all models immediately with zero key re-entry
  const enRes = await fetch(root + '/api/providers/profile', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
    body: JSON.stringify({ provider: 'openrouter', enabled: true }),
  });
  assert.equal(enRes.status, 200);
  const enData = await enRes.json();
  assert.equal(enData.enabled, true);
  assert.ok(enData.openrouterConnectionId);
  assert.ok(enData.providers.filter(p => p.id.startsWith('openrouter:')).every(p => p.available === true));

  // 4) Disable Anthropic and verify persistence across a fresh app restart on the same dataDir!
  const disAnth = await fetch(root + '/api/providers/profile', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-g0d-request': '1' },
    body: JSON.stringify({ provider: 'anthropic', enabled: false }),
  });
  assert.equal(disAnth.status, 200);
  await app.close();

  const app2 = await createApp({ dataDir: dir, auth: false, keychain: fakeKeychain });
  const root2 = await app2.listen(0);
  t.after(() => app2.close());
  const state2 = await (await fetch(root2 + '/api/state')).json();
  const anth2 = state2.connectedApiProviders.find(p => p.provider === 'anthropic');
  const or2 = state2.connectedApiProviders.find(p => p.provider === 'openrouter');
  assert.equal(anth2?.enabled, false, 'disabled state must persist across restarts');
  assert.equal(or2?.enabled, true);
  assert.ok(state2.providers.filter(p => p.id.startsWith('anthropic:')).every(p => p.available === false));
});
