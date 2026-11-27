'use strict';
(() => {
  const get = (id) => document.getElementById(id);
  const dialog = get('tree-dialog');
  const dock = get('code-dock');
  const home = dialog.parentElement;
  let view = null;
  const selected = new Set();
  const previewDialog = get('tree-request-dialog');
  let prepared = null, watcher = null;
  const newPaths = () => get('tree-new-names').value.split('\n').map(s => s.trim()).filter(Boolean);
  const parameterControls = window.ModelParameterControls?.(get('tree-build-form').querySelector('.tree-params'));
  const refreshParameterLimits = () => parameterControls?.load([...get('tree-models').querySelectorAll('input:checked')].map(input=>input.value));
  let project,
    activeFile,
    version = 0,
    previewVersion = 0,
    blobURL,
    busy = false;
  const escape = messageEscape;
  const status = (text) => {
    get('tree-status').textContent = text;
  };
  async function read(route, options) {
    const owner = view;
    const result = await api(route, options);
    if (owner !== view) throw new Error('The workspace view changed.');
    return result;
  }
  const post = (route, body) => read(route, { method: 'POST', body: JSON.stringify(body) });
  const route = (action) => '/api/worktrees/' + project.id + (action ? '/' + action : '');
  function clearBlob() {
    if (blobURL) URL.revokeObjectURL(blobURL);
    blobURL = null;
  }
  function updateButtons() {
    const models = document.querySelectorAll('#tree-models input:checked').length;
    const locked = busy || project?.building;
    const count = selected.size + newPaths().length;
    get('tree-build').disabled = locked || !count || count > 32 || !models || models > 4;
    for (const selector of [
      '#tree-new',
      '#tree-remove',
      '#tree-list',
      '#tree-check-form button',
      '#tree-open-form button',
      '#tree-new-names',
    ]) {
      const el = document.querySelector(selector);
      if (el) el.disabled = !!locked;
    }
    const candidate = project?.candidates.find((c) => c.id === get('tree-candidates').value);
    get('tree-stop-waiting').hidden = !(project?.building && project.candidates.some(c => c.patch) && project.candidates.some(c => !c.patch && !c.error));
    get('tree-apply').disabled = locked || !candidate?.patch || !!project?.review?.applied;
  }
  async function act(fn) {
    if (busy) return;
    const owner = view;
    busy = true;
    updateButtons();
    status('Working…');
    try {
      await fn();
    } catch (err) {
      if (owner === view) status(err.message);
    } finally {
      if (owner === view) { busy = false; updateButtons(); }
    }
  }
  function files() {
    if (!project) return;
    const q = get('tree-filter').value.toLowerCase();
    const matches = project.files.filter((f) => f.toLowerCase().includes(q));
    get('tree-selection').textContent = (selected.size + newPaths().length) + ' selected · ' + matches.length + ' matching';
    get('tree-files').innerHTML =
      matches
        .slice(0, 300)
        .map(
          (f) =>
            '<div class="tree-file"><input type="checkbox" aria-label="Include ' +
            escape(f) +
            '" data-select="' +
            escape(f) +
            '" ' +
            (selected.has(f) ? 'checked' : '') +
            '><button type="button" data-view="' +
            escape(f) +
            '" aria-current="' +
            (activeFile === f) +
            '" title="' +
            escape(f) +
            '">' +
            escape(f) +
            '</button></div>',
        )
        .join('') + (matches.length > 300 ? '<small>Refine the filter to see more files.</small>' : '');
    updateButtons();
  }
  let displayedCandidateId, displayedPatch, displayedMessage;
  function renderCandidate() {
    const candidate = project?.candidates.find((c) => c.id === get('tree-candidates').value);
    const patchPane = get('tree-patch');
    const patch = candidate?.patch;
    const message = candidate?.error ?? (candidate ? 'Waiting for ' + candidate.provider + '…' : '');
    if (candidate?.id !== displayedCandidateId || patch !== displayedPatch || message !== displayedMessage) {
      displayedCandidateId = candidate?.id;
      displayedPatch = patch;
      displayedMessage = message;
      if (patch) patchPane.innerHTML = highlightCode(patch, 'diff');
      else patchPane.textContent = message;
    }
    get('tree-apply').textContent =
      candidate && project?.review?.applied === candidate.id ? 'Applied to branch' : 'Apply to branch';
    updateButtons();
  }
  function showTab(tab) {
    const reviewing = tab === 'changes' && !!project?.candidates.length;
    get('tree-preview').hidden = reviewing;
    get('tree-review').hidden = !reviewing;
    get('tree-file-tab').setAttribute('aria-pressed', String(!reviewing));
    get('tree-review-tab').setAttribute('aria-pressed', String(reviewing));
  }
  get('tree-file-tab').onclick = () => showTab('file');
  get('tree-review-tab').onclick = () => showTab('changes');
  function review(reveal = true) {
    const candidates = project.candidates;
    const previous = candidates.find(c => c.id === get('tree-candidates').value);
    get('tree-review-tab').disabled = !candidates.length;
    if (reveal) showTab(candidates.length ? 'changes' : 'file');
    get('tree-candidates').replaceChildren(...candidates.map(c => {
      const state = c.error ? 'Unavailable' : c.patch ? 'Ready' : 'Waiting';
      const duration = c.elapsedMs === undefined ? '' : ' · ' + (c.elapsedMs / 1000).toFixed(1) + ' s';
      return new Option(c.provider + ' · ' + state + duration, c.id);
    }));
    const preferred = project.review?.applied || ((previous?.patch || previous?.error) && previous.id) ||
      candidates.find(c => c.patch)?.id || previous?.id;
    if (preferred) get('tree-candidates').value = preferred;
    renderCandidate();
  }
  function stopWatching() {
    if (watcher) clearTimeout(watcher.timer);
    watcher = null;
  }
  function watchBuild(id, fingerprint, local = false) {
    stopWatching();
    const watch = { revision: '', previousBuild: local ? project?.review?.buildId : null };
    watcher = watch;
    const poll = async () => {
      if (watcher !== watch) return;
      try {
        const result = await read('/api/worktrees/' + id + '/progress?after=' + encodeURIComponent(watch.revision));
        if (watcher !== watch || project?.id !== id) return;
        watch.revision = result.revision;
        if (result.review?.fingerprint === fingerprint && result.review.buildId !== watch.previousBuild) {
          const changed = result.candidates.some((c, i) => {
            const old = project.candidates[i];
            return !old || c.id !== old.id || !!c.patch !== !!old.patch || !!c.error !== !!old.error;
          });
          const firstPatch = result.candidates.some(c => c.patch) &&
            (project.review?.buildId !== result.review.buildId || !project.candidates.some(c => c.patch));
          Object.assign(project, result);
          if (changed) review(firstPatch);
          const done = result.candidates.filter(c => c.patch || c.error).length;
          status(done + ' of ' + result.candidates.length + ' models finished.');
          updateButtons();
        }
        if (!result.building && !local) { stopWatching(); return; }
      } catch (error) {
        if (watcher !== watch) return;
        status(error.message);
      }
      watch.timer = setTimeout(poll, 600);
    };
    watch.timer = setTimeout(poll, 200);
  }
  function displayCheck(result) {
    const output = get('tree-output');
    output.hidden = !result;
    output.textContent = result ? [result.command, result.cancelled ? 'Check cancelled' : result.timedOut ? 'Check timed out' :
      'Exit ' + result.exitCode, result.stdout, result.stderr].filter(Boolean).join('\n') : '';
  }
  async function showFile(file) {
    const current = ++previewVersion;
    activeFile = file;
    get('tree-quicklook').hidden = !window.webkit?.messageHandlers?.quickLook;
    clearBlob();
    files();
    showTab('file');
    const pane = get('tree-preview');
    get('tree-file-title').textContent = file;
    pane.textContent = 'Loading…';
    try {
      const data = await read(route('file') + '?path=' + encodeURIComponent(file));
      if (current !== previewVersion) return;
      if (data.mime) {
        const bytes = Uint8Array.from(atob(data.data), (c) => c.charCodeAt(0));
        blobURL = URL.createObjectURL(new Blob([bytes], { type: data.mime }));
        const tag = data.mime.startsWith('image/')
          ? 'img'
          : data.mime.startsWith('audio/')
            ? 'audio'
            : data.mime.startsWith('video/')
              ? 'video'
              : 'iframe';
        const element = document.createElement(tag);
        if (tag === 'iframe') {
          element.sandbox = '';
          element.title = file;
        }
        if (tag === 'img') element.alt = file;
        else if (tag !== 'iframe') element.controls = true;
        element.src = blobURL;
        pane.replaceChildren(element);
      } else if (typeof data.text === 'string') {
        renderDocumentPreview(pane, file, data.text);
      } else pane.textContent = 'Binary file · ' + data.bytes + ' bytes';
    } catch (error) {
      if (current === previewVersion) pane.textContent = error.message;
    }
  }
  async function choose(id) {
    const sequence = ++version;
    const fresh = await read('/api/worktrees/' + id);
    if (version !== sequence) return;
    ++previewVersion;
    clearBlob();
    dialog.dataset.project = 'open';
    project = fresh;
    selected.clear();
    get('tree-new-names').value = (project.review?.inputs || []).filter(i => i.hash === null && !project.files.includes(i.path)).map(i => i.path).join('\n');
    get('tree-new-paths').open = !!get('tree-new-names').value;
    for (const input of project.review?.inputs ?? []) if (project.files.includes(input.path)) selected.add(input.path);
    const modelChoices = [...get('tree-models').querySelectorAll('input')];
    const restored = project.review?.providerIds ?? [view?.providerId];
    if (modelChoices.some(box => restored.includes(box.value))) {
      for (const box of modelChoices) box.checked = restored.includes(box.value);
    }
    filterModels();
    for (const input of get('tree-build-form').querySelectorAll('.tree-params input[name]'))
      input.value = project.review?.parameters?.[input.name] ?? '';
    parameterControls?.sync();
    refreshParameterLimits();
    activeFile = null;
    get('tree-quicklook').hidden = true;
    get('tree-remove').hidden = false;
    get('tree-open-form').hidden = true;
    get('tree-workspace').hidden = false;
    get('tree-list').value = id;
    get('tree-filter').value = '';
    get('tree-root').textContent = project.repository.split('/').pop() + ' · ' + project.branch;
    get('tree-root').title = project.root;
    get('tree-file-title').textContent = 'File preview';
    get('tree-preview').textContent =
      'Choose a file to inspect it. Check files to include them in a build.';
    const intent = view?.intent;
    const request = intent?.message.replace(/^(?:\/build\b|let[’']?s build this\b)[\s:,.!?…—]*/i, '').trim();
    get('tree-objective').value = intent && (!project.review || view.newIntent || project.review.intentId !== intent.id)
      ? request || 'Build the change discussed in this chat.' : project.review?.objective ?? (view?.chatId ? 'Build the change discussed in this chat.' : '');
    get('tree-share').textContent = project.chatId
      ? 'Selected models receive the opening and recent messages from this chat, your request, and checked files.'
      : 'Selected models receive your request and checked files.';
    displayCheck(project.lastCheck);
    files();
    review();
    status(project.branch + ' · ' + project.base.slice(0, 10));
    if (project.building) watchBuild(id, project.review.fingerprint);
  }
  let catalogWarning = '';
  function filterModels() {
    const query = get('tree-model-filter').value.trim().toLowerCase();
    const rows = [...get('tree-models').querySelectorAll('label')];
    let matched = 0;
    for (const row of rows) {
      const box = row.querySelector('input');
      const matches = (row.textContent + ' ' + box.value).toLowerCase().includes(query);
      row.hidden = !matches && !box.checked;
      if (matches) matched++;
    }
    const selectedCount = rows.filter(row => row.querySelector('input').checked).length;
    get('tree-model-count').textContent = [query ? matched + ' of ' + rows.length + ' choices' : rows.length + ' choices', selectedCount + ' selected', catalogWarning].filter(Boolean).join(' · ');
  }
  async function refresh(preferred) {
    const catalog = await read('/api/worktrees');
    const projects = view?.chatId ? catalog.projects.filter(p => p.chatId === view.chatId) : catalog.projects;
    const models = catalog.models;
    catalogWarning = catalog.catalogWarning || '';
    get('tree-model-filter').value = '';
    get('tree-list').replaceChildren(
      ...projects.map((p) => new Option(p.repository.split('/').pop() + ' · ' + p.branch, p.id)),
    );
    get('tree-list').hidden = !projects.length;
    get('tree-remove').hidden = !projects.length;
    get('tree-models').innerHTML = models.length
      ? models
          .map(
            (m, i) =>
              '<label><input type="checkbox" value="' +
              escape(m.id) +
              '" ' +
              (i === 0 ? 'checked' : '') +
              '> ' +
              escape(m.label) +
              '</label>',
          )
          .join('')
      : '<small>Connect a Chat Completions model in Settings → Models to generate patches.</small>';
    filterModels();
    refreshParameterLimits();
    if (projects.length) await choose(projects.some(p => p.id === preferred) ? preferred : projects[0].id);
    else {
      project = null;
      delete dialog.dataset.project;
      get('tree-open-form').hidden = false;
      get('tree-workspace').hidden = true;
      status('');
      if (view?.chatId) get('tree-folder').focus();
    }
  }
  function resetView(remember = false) {
    if (!view) return;
    if (view.chatId && !remember) {
      try { localStorage.removeItem('g0dc0d3.codePanel'); } catch {}
    }
    stopWatching();
    if (previewDialog.open) previewDialog.close();
    prepared = null;
    view = null;
    ++version; ++previewVersion;
    busy = false;
    project = null;
    selected.clear();
    clearBlob();
    if (dialog.open) dialog.close();
    home.append(dialog);
    dock.hidden = true;
    document.body.classList.remove('code-open');
    delete dialog.dataset.chat;
  }
  function openView(chat, newIntent = false) {
    if (chat && view?.chatId === chat.id && dialog.open) {
      if (newIntent && chat.codeIntent?.message) {
        view.intent = chat.codeIntent; view.newIntent = true;
        if (project) get('tree-objective').value = chat.codeIntent.message.replace(/^(?:\/build\b|let[’']?s build this\b)[\s:,.!?…—]*/i, '').trim() || 'Build the change discussed in this chat.';
      }
      return;
    }
    resetView(true);
    view = { chatId: chat?.id, intent: chat?.codeIntent, newIntent, providerId: chat?.providerId };
    delete dialog.dataset.project;
    get('tree-open-form').hidden = true;
    get('tree-workspace').hidden = true;
    get('tree-folder').value = '';
    get('tree-attach').textContent = chat ? 'Attach repository' : 'Create worktree';
    if (chat) {
      if (typeof window.closeAllRightDocks === 'function') window.closeAllRightDocks({ except: 'code' });
      else {
        window.closeArtifactDock?.({ recordDismiss: false });
        if (typeof setInspector === 'function') setInspector(false);
        if (window.G0DConclave?.isOpen?.()) window.G0DConclave.close();
        if (window.G0DBrowserLive?.isOpen?.()) window.G0DBrowserLive.close();
      }
      dialog.dataset.chat = chat.id;
      dock.append(dialog);
      dock.hidden = false;
      document.body.classList.add('code-open');
      try { localStorage.setItem('g0dc0d3.codePanel', chat.id); } catch {}
      dialog.show();
    } else dialog.showModal();
    return act(() => refresh(chat?.codeWorkspace?.id));
  }
  window.openChatCode = openView;
  window.closeChatCode = ({ remember = false } = {}) => { if (view?.chatId) resetView(remember); };
  window.restoreChatCode = chat => {
    try { if (!view && chat.codeWorkspace && localStorage.getItem('g0dc0d3.codePanel') === chat.id) openView(chat); } catch {}
  };
  get('open-worktrees').onclick = () => {
    const task = selectedData?.task;
    openView(task?.workspaceKind === 'conversation' ? task : null);
  };
  get('create-worktree').onclick = () => {
    const folder = get('create-source-path').value.trim();
    get('create-dialog').close();
    openView(null).then(() => {
      if (!view || view.chatId) return;
      get('tree-new').click();
      get('tree-folder').value = folder;
    });
  };
  get('tree-remove').onclick = () =>
    act(async () => {
      const targetId = project?.id || get('tree-list')?.value;
      if (!targetId) return;
      if (
        !window.confirm(
          'Remove this worktree folder? Git keeps its branch and refuses to remove uncommitted work unless forced.',
        )
      ) {
        if (project?.branch) status(project.branch);
        return;
      }
      const removePath = `/api/worktrees/${encodeURIComponent(targetId)}/remove`;
      let result;
      try {
        result = await post(removePath, {});
      } catch (err) {
        const msg = String(err?.message || '');
        if (/modified|untracked|dirty|contains modified|force/i.test(msg)) {
          if (!window.confirm(`Worktree has uncommitted or untracked files:\n\n${msg}\n\nForce remove this worktree and discard uncommitted files? (Committed work on its branch is kept.)`)) {
            if (project?.branch) status(project.branch);
            return;
          }
          result = await post(removePath, { force: true });
        } else {
          throw err;
        }
      }
      project = null;
      await refresh();
      status('Removed worktree. Branch ' + result.branch + ' is retained.');
    });
  get('tree-close').onclick = () => resetView();
  dialog.addEventListener('close', () => {
    if (!dialog.open) resetView();
  });
  get('tree-new').onclick = () => {
    delete dialog.dataset.project;
    get('tree-remove').hidden = true;
    get('tree-open-form').hidden = false;
    get('tree-workspace').hidden = true;
    get('tree-folder').focus();
    status('');
  };
  get('tree-list').onchange = (e) => act(() => choose(e.target.value));
  get('tree-open-form').onsubmit = (e) => {
    e.preventDefault();
    act(async () => {
      const endpoint = view?.chatId ? '/api/conversations/' + encodeURIComponent(view.chatId) + '/repository' : '/api/worktrees';
      const p = await post(endpoint, { repository: get('tree-folder').value.trim() });
      await refresh(p.id);
    });
  };
  get('tree-filter').oninput = files;
  get('tree-new-names').oninput = files;
  get('tree-files').onclick = (e) => {
    const btn = e.target.closest('button[data-view]');
    if (btn) showFile(btn.dataset.view);
  };
  get('tree-files').onchange = (e) => {
    const name = e.target.dataset.select;
    if (e.target.checked) selected.add(name);
    else selected.delete(name);
    files();
  };
  get('tree-model-filter').oninput = filterModels;
  get('tree-models').onchange = () => { filterModels(); updateButtons(); refreshParameterLimits(); };
  get('tree-candidates').onchange = renderCandidate;
  get('tree-copy').onclick = () =>
    navigator.clipboard.writeText(project.root).then(
      () => status('Worktree path copied.'),
      () => status(project.root),
    );
  function requestDetails(parent, title, content) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = title;
    const pre = document.createElement('pre');
    pre.textContent = content;
    details.append(summary, pre);
    parent.append(details);
  }
  function displayRequests({ requests }) {
    const panel = get('tree-request-content');
    const incoming = JSON.parse(requests[0].body.messages[1].content);
    const recipients = document.createElement('p');
    const names = requests.map(r => r.label);
    recipients.textContent = requests.length + (requests.length === 1 ? ' request to ' : ' requests to ') + names.join(', ');
    panel.replaceChildren(recipients);
    const objective = document.createElement('blockquote');
    objective.textContent = incoming.objective;
    panel.append(objective);
    for (const section of [
      ['Chat excerpts', (incoming.conversation || []).map(turn => [turn.role === 'user' ? 'You' : 'Assistant', turn.text])],
      ['Selected files', incoming.files.map(f => [f.path, f.content])],
      ['New files', (incoming.newFiles || []).map(path => [path, 'Requested new file. No existing content will be sent.'])],
    ]) {
      const [label, entries] = section;
      if (!entries.length) continue;
      const heading = document.createElement('h3');
      heading.textContent = label + ' (' + entries.length + ')';
      panel.append(heading);
      for (const [title, text] of entries) requestDetails(panel, title, text);
    }
    const heading = document.createElement('h3');
    heading.textContent = 'Full requests';
    panel.append(heading);
    for (const r of requests) requestDetails(panel, r.label, (r.endpoint ? r.endpoint + '\n\n' : '') + JSON.stringify(r.body, null, 2));
  }
  previewDialog.addEventListener('close', () => {
    prepared = null;
    get('tree-request-content').replaceChildren();
  });
  get('tree-build-form').onsubmit = (e) => {
    e.preventDefault();
    act(async () => {
      const parameters = {};
      for (const [key, value] of new FormData(e.target)) if (value !== '') parameters[key] = Number(value);
      const request = {
        objective: get('tree-objective').value, files: [...selected], newFiles: newPaths(),
        providerIds: [...get('tree-models').querySelectorAll('input:checked')].map(el => el.value), parameters,
      };
      const preview = await post(route('build-preview'), request);
      prepared = { ...request, fingerprint: preview.fingerprint };
      displayRequests(preview);
      previewDialog.showModal();
      status('Request preview ready.');
    });
  };
  get('tree-send').onclick = () => {
    if (!prepared) return;
    const request = prepared;
    prepared = null;
    previewDialog.close();
    act(async () => {
      status('Waiting for model proposals…');
      watchBuild(project.id, request.fingerprint, true);
      const owner = view;
      try {
        const result = await post(route('build'), request);
        view.newIntent = false;
        const firstPatch = result.candidates.some(c => c.patch) &&
          (project.review?.buildId !== result.review?.buildId || !project.candidates.some(c => c.patch));
        Object.assign(project, result, { building: false });
        review(firstPatch);
        status(result.candidates.filter(c => c.patch).length + ' of ' + result.candidates.length + ' proposals passed the Git apply check.');
      } finally {
        if (owner === view) { stopWatching(); project.building = false; }
      }
    });
  };
  get('tree-stop-waiting').onclick = async () => {
    const owner = view;
    try {
      await post(route('stop-waiting'), { buildId: project.review.buildId });
    } catch (error) { if (owner === view) status(error.message); }
  };
  get('tree-apply').onclick = () =>
    act(async () => {
      project = {
        ...project,
        ...(await post(route('apply'), { candidateId: get('tree-candidates').value })),
      };
      const added = (project.createdFiles || []).filter(name => newPaths().includes(name));
      if (added.length) {
        project.files = [...new Set([...project.files, ...added])];
        for (const name of added) selected.add(name);
        get('tree-new-names').value = newPaths().filter(name => !added.includes(name)).join('\n');
        files();
      }
      renderCandidate();
      displayCheck(project.lastCheck);
      if (activeFile) await showFile(activeFile);
      status('Patch applied to ' + project.branch + '.');
    });
  get('tree-check-form').onsubmit = (e) => {
    e.preventDefault();
    act(async () => {
      const command = get('tree-check').value;
      const result = await post(route('check'), {
        command,
        network: get('tree-net').checked,
      });
      project.lastCheck = { ...result, command };
      displayCheck(project.lastCheck);
      status(result.timedOut ? 'Check timed out.' : 'Check exited ' + result.exitCode + '.');
    });
  };
  get('tree-quicklook').onclick = () => {
    if (project && activeFile)
      window.webkit?.messageHandlers?.quickLook?.postMessage({ root: project.root, file: activeFile });
  };
  if (window.webkit?.messageHandlers?.chooseRepository) {
    get('tree-browse').hidden = false;
    get('tree-browse').onclick = () =>
      window.webkit.messageHandlers.chooseRepository.postMessage('open');
  }
  window.addEventListener('godcode-repository', (e) => {
    get('tree-folder').value = e.detail;
  });
})();
