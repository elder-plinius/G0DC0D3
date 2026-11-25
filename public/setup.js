'use strict';
window.SetupUI = (() => {
  let shown = false, loading = false, submitting = false, data = null, opener = null;
  const chosen = new Set();
  document.body.insertAdjacentHTML('beforeend', `<dialog id="setup-dialog" class="modal setup-modal" aria-labelledby="setup-title" aria-describedby="setup-intro">
    <header class="modal-header"><div class="setup-heading"><span class="brand-mark" aria-hidden="true"></span><div><span class="eyebrow">WELCOME TO GODMODƎ</span><h2 id="setup-title">Your models. Your permissions.</h2></div></div><button type="button" class="icon-button" id="setup-close" aria-label="Close setup">×</button></header>
    <div class="setup-body"><p id="setup-intro">Choose which local CLI logins to add as inference options. New connections are off until you select them.</p>
      <section aria-labelledby="setup-connections-title"><div class="setup-section-heading"><h3 id="setup-connections-title">Available on this device</h3><button type="button" class="button button-quiet" id="setup-refresh">Check again</button></div><div id="setup-connections" aria-live="polite"><p class="field-help">Checking local CLI status…</p></div></section>
      <section id="setup-disclosure" aria-label="Inference permission"></section>
      <section class="setup-permissions" aria-labelledby="setup-permissions-title"><h3 id="setup-permissions-title">Workspace permissions stay separate</h3><p>Attaching a project, allowing commands, and allowing network access are separate controls. New chats start with commands and command network access off. Adding a model changes none of those grants.</p></section>
      <p class="setup-note">Your chats and settings stay on this device; model requests go to your chosen provider. Use of third-party APIs and CLI subscriptions is governed by each provider’s Terms of Service. Recovery can retry requests, and Ultra-Plinian sends context to its selected writers and judge. Models can make mistakes—review code and commands before running them.</p>
    </div>
    <footer class="setup-footer"><p id="setup-feedback" class="form-feedback" role="status"></p><div class="setup-actions"><button type="button" class="button button-quiet" id="setup-api">Use an API key</button><span class="setup-actions-spacer"></span><button type="button" class="button button-secondary" id="setup-skip">Not now</button><button type="button" class="button button-primary" id="setup-continue" disabled>Continue</button></div></footer>
  </dialog>`);
  const dialog = $('#setup-dialog');
  function disclosureHTML(consent) {
    if (!consent?.version || !Array.isArray(consent.disclosures)) return '';
    return `<div class="inference-disclosure"><h3>What adding a connection allows</h3><ul>${consent.disclosures.map(text => `<li>${escapeHTML(text)}</li>`).join('')}</ul></div>`;
  }
  function controls() {
    const locked = loading || submitting;
    $$('#setup-dialog button').forEach(button => {
      if (button.id === 'setup-close' || button.id === 'setup-skip' || button.id === 'setup-api') {
        button.disabled = submitting;
      } else {
        button.disabled = locked;
      }
    });
    $('#setup-continue').disabled = locked || !data;
    $('#setup-continue').textContent = chosen.size ? `Add ${chosen.size} ${chosen.size === 1 ? 'option' : 'options'} & continue` : 'Continue';
    $$('[data-setup-cli]').forEach(input => { const connection = data?.connections.find(item => item.id === input.dataset.setupCli); input.disabled = locked || !connection?.ready || connection.enabled; });
  }
  function render() {
    const rows = data?.connections || [];
    for (const id of chosen) if (!rows.some(connection => connection.id === id && connection.ready && !connection.enabled)) chosen.delete(id);
    const available = rows.filter(connection => connection.installed || connection.enabled);
    $('#setup-connections').innerHTML = available.length ? available.map(connection => {
      const prompt = connection.enabled ? 'Already added. Manage or disconnect in Settings → Models.'
        : connection.authenticated ? `${connection.name} is signed in. Add it as an inference option?` : connection.detail;
      const status = connection.enabled ? 'Added' : connection.authenticated ? 'Signed in' : connection.ready ? 'Sign-in unverified' : 'Sign in required';
      return `<label class="setup-connection ${connection.enabled ? 'is-added' : ''}"><input type="checkbox" data-setup-cli="${escapeHTML(connection.id)}" ${chosen.has(connection.id) ? 'checked' : ''} ${connection.enabled || !connection.ready ? 'disabled' : ''}><span><span class="setup-connection-title"><strong>${escapeHTML(connection.name)}</strong><span class="meta-chip">${escapeHTML(status)}</span></span><span class="field-help">${escapeHTML(prompt)}</span></span></label>`;
    }).join('') : '<p class="field-help">No supported CLI was found. You can connect with an API key or sign in to a CLI and check again.</p>';
    const missing = rows.filter(connection => !connection.installed && !connection.enabled);
    if (missing.length) $('#setup-connections').insertAdjacentHTML('beforeend', `<details class="setup-other"><summary>Other supported CLIs</summary>${missing.map(connection => `<p><strong>${escapeHTML(connection.name)}</strong><span class="field-help">${escapeHTML(connection.loginHint)}</span></p>`).join('')}</details>`);
    $('#setup-disclosure').innerHTML = disclosureHTML(data?.consent);
    controls();
  }
  async function load(force = false) {
    if (loading || submitting) return;
    loading = true; controls(); setText('#setup-feedback', 'Checking local CLI status. No model prompts are sent.');
    try {
      const result = await api('/api/setup' + (force ? '?refresh=1' : ''));
      if (!dialog.open) return;
      data = result; render();
      setText('#setup-feedback', result.preferenceError || 'Only selected connections will be added.');
    } catch (error) { setText('#setup-feedback', error.message); }
    finally { loading = false; controls(); }
  }
  async function acknowledge(status) {
    const result = await api('/api/setup', { method: 'POST', body: JSON.stringify({ version: data?.setup?.version || state.setup?.version || 1, status }) });
    state.setup = result.setup;
  }
  async function defer(openModels = false) {
    if (submitting) {
      if (dialog.open) dialog.close();
      return;
    }
    submitting = true; controls();
    try {
      await acknowledge('deferred');
    } catch (error) {
      setText('#setup-feedback', error.message);
    } finally {
      submitting = false; controls();
      if (dialog.open) dialog.close();
    }
    if (openModels) {
      await openSettings('models');
      $('#api-key-setup')?.scrollIntoView({ block: 'start' });
      $('#api-key-input')?.focus({ preventScroll: true });
    }
  }
  async function complete() {
    if (loading || submitting || !data) return;
    submitting = true; controls();
    try {
      for (const id of [...chosen]) {
        const connection = data.connections.find(item => item.id === id);
        if (!connection || connection.enabled || !connection.ready) continue;
        setText('#setup-feedback', `Adding ${connection.name} for inference…`);
        const result = await api('/api/providers/connections', { method: 'POST', body: JSON.stringify({ id, consentVersion: data.consent.version }) });
        chosen.delete(id);
        data = { ...data, ...result };
        render();
      }
      await acknowledge('completed');
      dialog.close();
      await refresh();
      if ($('#settings-dialog').open) {
        await Promise.all([loadModelConnections(), typeof loadServices === 'function' ? loadServices() : Promise.resolve()]);
        renderModelSettings();
      }
      window.TourUI?.offer();
    } catch (error) {
      render(); setText('#setup-feedback', error.message + ' Any options already added are shown above.');
    } finally { submitting = false; controls(); }
  }
  async function open() {
    if (dialog.open) return;
    shown = true; data = null; chosen.clear(); opener = document.activeElement;
    $('#setup-connections').innerHTML = '<p class="field-help">Checking local CLI status…</p>';
    $('#setup-disclosure').replaceChildren();
    dialog.showModal(); controls();
    $('#setup-close')?.focus({ preventScroll: true });
    await load();
  }
  function maybeOpen(setup) {
    if (shown || setup?.status !== 'pending' || document.querySelector('dialog[open]') || ACTIVE.has(selectedData?.task?.status)) return;
    void open();
  }
  dialog.addEventListener('change', event => { const input = event.target.closest('[data-setup-cli]'); if (!input || loading || submitting) return; input.checked ? chosen.add(input.dataset.setupCli) : chosen.delete(input.dataset.setupCli); controls(); });
  dialog.addEventListener('cancel', event => { event.preventDefault(); void defer(); });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); void defer(); }
  });
  dialog.addEventListener('close', () => { if (opener?.isConnected) opener.focus({preventScroll:true}); });
  $('#setup-close').addEventListener('click', () => defer());
  $('#setup-skip').addEventListener('click', () => defer());
  $('#setup-api').addEventListener('click', () => defer(true));
  $('#setup-continue').addEventListener('click', complete);
  $('#setup-refresh').addEventListener('click', () => load(true));
  document.addEventListener('click', event => { if (event.target.closest('[data-open-setup]')) void open(); });
  return { open, maybeOpen, disclosureHTML };
})();

window.TourUI = (() => {
  const storageKey = 'g0dc0d3.quickTour.v1';
  let step = 0, opener = null, outcome = 'skipped', acknowledged = false;
  try { acknowledged = ['completed', 'skipped'].includes(localStorage.getItem(storageKey)); } catch {}
  const steps = [
    {
      label: 'Chat → code', title: 'Start with an idea. Keep the thread.',
      body: 'Chat in GODMODƎ. When it’s time to build, attach a repository and continue in the same conversation with GODCODƎ.',
      visual: '<div class="tour-flow"><span>Talk it through</span><i aria-hidden="true">→</i><span>Attach a repo</span><i aria-hidden="true">→</i><span class="tour-accent">Build together</span></div>',
      tip: 'Use Add project or Attach repository beside the message box. Review patches and checks in the coding workspace.'
    },
    {
      label: 'GODMODƎ', title: 'Keep moving when a model gets stuck.',
      body: 'GODMODƎ enables recovery: supported coding routes can try another approach or switch to a configured fallback after a decline, error, or stalled task.',
      visual: '<div class="tour-flow"><span>Preferred model</span><i aria-hidden="true">→</i><span>Retry an approach</span><i aria-hidden="true">→</i><span class="tour-accent">Try a fallback</span></div>',
      tip: 'Use the GODMODƎ switch beside your message. Settings → General controls retries and call limits. Direct Venice chats currently use outage backup; recovery does not guarantee an answer.'
    },
    {
      label: 'ULTRA-PLINIAN', title: 'Two perspectives. One selected answer.',
      body: 'Two Venice models draft answers in parallel. A judge scores both for fidelity, completeness, and clarity, then selects the winner. The chat shows the scorecard.',
      visual: '<div class="tour-race"><div class="tour-writers"><span>Writer A</span><span>Writer B</span></div><i aria-hidden="true">→</i><span>Judge</span><i aria-hidden="true">→</i><span class="tour-accent">Selected answer</span></div>',
      tip: 'Open ULTRA-PLINIAN beside the message box to enable it and choose two writers and a judge. A full comparison uses three model calls. This is chat answer racing; parallel code builds live in GODCODƎ.'
    },
    {
      label: 'Your controls', title: 'Make the workspace yours.',
      body: 'Click the model name to switch models. Open Model controls for sliders and exact values; supported ranges follow the selected model. Plan explores before Build makes changes.',
      visual: '<div class="tour-controls"><span><strong>Model controls</strong><small>Temperature · top-p · more</small></span><span><strong>Plan / Build</strong><small>Explore, then make changes</small></span><span><strong>!Commands</strong><small>Your reusable prompt flows</small></span></div>',
      tip: 'Manage prompt commands in Settings → Prompts. Command and network permissions stay separate in Settings → Tools. Revisit this tour any time in Settings → General.'
    }
  ];
  document.body.insertAdjacentHTML('beforeend', `<dialog id="tour-dialog" class="modal setup-modal tour-modal" aria-labelledby="tour-title" aria-describedby="tour-description">
    <header class="modal-header"><div class="setup-heading"><span class="brand-mark" aria-hidden="true"></span><div><span class="eyebrow">GODMODƎ · QUICK TOUR</span><p class="field-help">About a minute. Skip any time.</p></div></div><button type="button" class="icon-button" id="tour-close" aria-label="Close tour">×</button></header>
    <nav class="tour-progress" aria-label="Tour steps">${steps.map((item, index) => `<button type="button" data-tour-step="${index}" aria-label="Step ${index + 1}: ${item.label}"><span aria-hidden="true">${index + 1}</span><span>${item.label}</span></button>`).join('')}</nav>
    <div class="setup-body tour-body"><p class="eyebrow" id="tour-position"></p><h2 id="tour-title" tabindex="-1"></h2><p id="tour-description"></p><div id="tour-visual" aria-hidden="true"></div><p class="tour-tip" id="tour-tip"></p></div>
    <footer class="setup-footer"><p class="field-help tour-footnote">This tour sends no prompts and changes no model or permission settings.</p><div class="setup-actions"><button type="button" class="button button-quiet" id="tour-skip">Skip tour</button><span class="setup-actions-spacer"></span><button type="button" class="button button-secondary" id="tour-back">Back</button><button type="button" class="button button-primary" id="tour-next">Next</button></div></footer>
  </dialog>`);
  const dialog = $('#tour-dialog');
  function syncEntryPoints() {
    $$('[data-open-tour]').forEach(button => { button.textContent = acknowledged ? 'Replay quick tour' : 'Take a quick tour'; });
  }
  function render() {
    const item = steps[step];
    setText('#tour-position', `STEP ${step + 1} OF ${steps.length}`);
    setText('#tour-title', item.title); setText('#tour-description', item.body); setText('#tour-tip', item.tip);
    $('#tour-visual').innerHTML = item.visual;
    $('#tour-back').disabled = step === 0;
    setText('#tour-next', step === steps.length - 1 ? 'Let’s go' : 'Next');
    $$('[data-tour-step]').forEach(button => {
      if (Number(button.dataset.tourStep) === step) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    });
    $('.tour-body').scrollTop = 0;
    if (dialog.open) $('#tour-title').focus({ preventScroll: true });
  }
  function open() {
    if (dialog.open) return;
    opener = document.activeElement; outcome = 'skipped'; step = 0;
    render(); dialog.showModal(); $('#tour-title').focus({ preventScroll: true });
  }
  function offer() {
    if (!acknowledged && !document.querySelector('dialog[open]') && !ACTIVE.has(selectedData?.task?.status)) open();
  }
  function finish(status = 'skipped') { outcome = status; dialog.close(); }
  dialog.addEventListener('close', () => {
    acknowledged = true;
    try { localStorage.setItem(storageKey, outcome); } catch {}
    syncEntryPoints();
    if (opener?.isConnected && opener !== document.body && !opener.closest('dialog:not([open])')) opener.focus({ preventScroll: true });
    else $('#composer-input')?.focus({ preventScroll: true });
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
  $('#tour-close').addEventListener('click', () => finish());
  $('#tour-skip').addEventListener('click', () => finish());
  $('#tour-back').addEventListener('click', () => { if (step > 0) { step--; render(); } });
  $('#tour-next').addEventListener('click', () => { if (step === steps.length - 1) finish('completed'); else { step++; render(); } });
  dialog.addEventListener('click', event => {
    const button = event.target.closest('[data-tour-step]');
    if (button) { step = Number(button.dataset.tourStep); render(); }
  });
  document.addEventListener('click', event => { if (event.target.closest('[data-open-tour]')) open(); });
  syncEntryPoints();
  return { open, offer };
})();
window.SetupUI.maybeOpen(state.setup);
