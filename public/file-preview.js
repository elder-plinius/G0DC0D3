'use strict';
function tabularPreview(text, delimiter) {
  const rows = [],
    row = [];
  let field = '',
    quoted = false,
    started = false,
    begun = false,
    pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; pos < text.length && rows.length < 100; pos++) {
    const c = text[pos];
    started = true;
    if (c === '"' && quoted) {
      if (text[pos + 1] === '"') {
        field += '"';
        pos++;
      } else quoted = false;
    } else if (c === '"' && !begun) {
      quoted = true;
      begun = true;
    } else if (!quoted && c === delimiter) {
      row.push(field);
      field = '';
      begun = false;
    } else if (!quoted && (c === '\n' || c === '\r')) {
      if (c === '\r' && text[pos + 1] === '\n') pos++;
      row.push(field);
      rows.push(row.splice(0));
      field = '';
      started = false;
      begun = false;
    } else {
      field += c;
      begun = true;
    }
  }
  if (rows.length < 100 && started) rows.push([...row, field]);
  return (
    '<table><tbody>' +
    rows
      .map(
        (r, i) =>
          '<tr>' +
          r
            .slice(0, 40)
            .map((cell) =>
              i === 0
                ? '<th scope="col">' + messageEscape(cell) + '</th>'
                : '<td>' + messageEscape(cell) + '</td>',
            )
            .join('') +
          '</tr>',
      )
      .join('') +
    '</tbody></table>' +
    (pos < text.length || rows.some((r) => r.length > 40)
      ? '<small>Preview shows up to 100 rows and 40 columns.</small>'
      : '')
  );
}
function richDocument(name) {
  return /\.(?:md|markdown|html?|csv|tsv|json)$/i.test(name);
}
function renderDocumentPreview(pane, name, source) {
  const extension = name.split('.').pop().toLowerCase();
  const text = source.slice(0, 160000);
  if (['md', 'markdown'].includes(extension)) {
    const sections = text.split(/(```[\s\S]*?(?:```|$))/g);
    pane.innerHTML = sections
      .map((section) => {
        if (!section.startsWith('```')) return messageMarkdown(section);
        const match = /^```([^\n]*)\n([\s\S]*?)(?:```$|$)/.exec(section);
        return match
          ? '<pre><code>' + highlightCode(match[2], match[1].trim()) + '</code></pre>'
          : messageEscape(section);
      })
      .join('');
  } else if (extension === 'csv' || extension === 'tsv') {
    pane.innerHTML = tabularPreview(text, extension === 'tsv' ? '\t' : ',');
  } else if (extension === 'html' || extension === 'htm') {
    const frame = document.createElement('iframe');
    frame.sandbox = '';
    frame.title = 'Preview of ' + name;
    const cspMeta = '<meta http-equiv="Content-Security-Policy" content="default-src &apos;none&apos;; style-src &apos;unsafe-inline&apos;; img-src data:">';
    frame.srcdoc = /<head\b[^>]*>/i.test(text)
      ? text.replace(/<head\b[^>]*>/i, match => match + cspMeta)
      : /^\s*<!doctype\b[^>]*>/i.test(text)
        ? text.replace(/^\s*<!doctype\b[^>]*>/i, match => match + cspMeta)
        : cspMeta + text;
    pane.replaceChildren(frame);
  } else {
    const pre = document.createElement('pre');
    const baseName = name.split('/').pop().toLowerCase();
    const fallbackAliases = {
      mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', js: 'javascript',
      mts: 'typescript', cts: 'typescript', tsx: 'typescript', ts: 'typescript',
      py: 'python', pyi: 'python', sh: 'bash', zsh: 'bash', yml: 'yaml',
      rs: 'rust', rb: 'ruby', kt: 'kotlin', kts: 'kotlin', swift: 'swift',
      c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', cs: 'csharp',
      java: 'java', go: 'go', php: 'php', lua: 'lua', sql: 'sql', r: 'r',
      ex: 'elixir', exs: 'elixir', hs: 'haskell', scala: 'scala', zig: 'zig',
      toml: 'toml', ini: 'ini', cfg: 'ini', env: 'env', proto: 'protobuf',
      gql: 'graphql', graphql: 'graphql', sol: 'solidity', tf: 'hcl', hcl: 'hcl',
      ps1: 'powershell', nix: 'nix', tex: 'latex', asm: 'x86asm', s: 'x86asm',
      dockerfile: 'dockerfile', makefile: 'makefile', mk: 'makefile', cmake: 'cmake',
      xml: 'xml', svg: 'xml', svelte: 'xml', vue: 'xml', css: 'css', scss: 'scss', less: 'less'
    };
    const rawLang = baseName === 'dockerfile' ? 'dockerfile'
      : baseName === 'makefile' ? 'makefile'
      : baseName === 'cmakelists.txt' ? 'cmake'
      : baseName.startsWith('.env') ? 'env'
      : extension;
    const language = (typeof normalizeCodeLanguage === 'function' ? normalizeCodeLanguage(rawLang) : null) || (Object.hasOwn(fallbackAliases, rawLang) ? fallbackAliases[rawLang] : null) || rawLang;
    let content = text;
    if (extension === 'json') {
      pre.tabIndex = 0;
      pre.setAttribute('role', 'region');
      pre.setAttribute('aria-label', 'JSON preview of ' + name);
    }
    if (extension === 'json' && text.length === source.length) {
      try {
        content = JSON.stringify(JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text), null, 2);
      } catch {}
    }
    if (window.hljs?.getLanguage(language)) pre.innerHTML = highlightCode(content, language);
    else pre.textContent = content;
    pane.replaceChildren(pre);
  }
  if (source.length > text.length) {
    const note = document.createElement('small');
    note.textContent = 'Preview limited to 160,000 characters.';
    pane.append(note);
  }
}
