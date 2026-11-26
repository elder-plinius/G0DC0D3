'use strict';
(() => {
  const native = window.webkit?.messageHandlers?.dictation;
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const buttons = document.querySelectorAll('[data-dictate]');
  let active;
  function stop(cancel = false) {
    if (!active) return;
    const session = active;
    if (native) native.postMessage({ id: session.id, action: cancel ? 'cancel' : 'stop' });
    else if (cancel) session.recognition.abort();
    else session.recognition.stop();
    if (cancel) finish(session);
  }
  function finish(session) {
    if (active !== session) return;
    session.button.setAttribute('aria-pressed', 'false');
    session.button.title = 'Dictate';
    active = null;
  }
  function update(session, text, final, error) {
    if (
      active !== session ||
      session.scope !== selectedId ||
      !session.input.isConnected ||
      session.input.disabled ||
      session.input.readOnly
    ) {
      if (active === session) stop(true);
      return;
    }
    if (text) {
      session.input.setRangeText(text, session.start, session.end, 'end');
      session.end = session.start + text.length;
      session.writing = true;
      session.input.dispatchEvent(new Event('input', { bubbles: true }));
      session.writing = false;
    }
    if (error) toast(error);
    if (final) finish(session);
  }
  for (const button of buttons) {
    button.innerHTML =
      '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M6 11v1a6 6 0 0 0 12 0v-1m-6 7v3m-3 0h6"/></svg>';
    button.setAttribute('aria-pressed', 'false');
    const input = document.getElementById(button.dataset.dictate);
    if (!input) continue;
    input.addEventListener('input', () => {
      if (active?.input === input && !active.writing) stop(true);
    });
    button.onclick = () => {
      if (active?.button === button) {
        stop();
        return;
      }
      if (input.disabled || input.readOnly) return;
      stop(true);
      input.focus();
      if (!native && !Recognition) {
        toast('Use system dictation in this field, or open the Mac app for microphone input.');
        return;
      }
      const session = {
        id: crypto.randomUUID(),
        input,
        button,
        start: input.selectionStart,
        end: input.selectionEnd,
        scope: selectedId,
      };
      active = session;
      button.setAttribute('aria-pressed', 'true');
      button.title = 'Stop dictation';
      try {
        if (native) native.postMessage({ id: session.id, action: 'start' });
        else {
          const speech = new Recognition();
          session.recognition = speech;
          speech.interimResults = true;
          speech.lang = navigator.language;
          speech.onresult = (e) =>
            update(session, Array.from(e.results, (r) => r[0].transcript).join(' '), false);
          speech.onerror = (e) => update(session, '', true, 'Dictation: ' + e.error);
          speech.onend = () => finish(session);
          speech.start();
        }
      } catch (error) {
        update(session, '', true, error.message);
      }
    };
  }
  window.addEventListener('godcode-dictation', (e) => {
    const d = e.detail;
    if (active?.id === d.id) update(active, d.text, d.final, d.error);
  });
  document.addEventListener('submit', () => stop(true), true);
  document.getElementById('tree-dialog')?.addEventListener('close', () => stop(true));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop(true);
  });
  for (const id of ['tree-new', 'tree-list', 'tree-folder']) {
    const control = document.getElementById(id);
    control?.addEventListener(id === 'tree-new' ? 'click' : 'change', () => stop(true));
  }
  window.addEventListener('pagehide', () => stop(true));
})();
