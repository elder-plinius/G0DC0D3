/* Markdown rendering for model replies with syntax highlighting. */
function messageEscape(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

const TEX_SYMBOLS = Object.freeze({
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', theta: 'θ',
  lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', tau: 'τ', phi: 'φ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Pi: 'Π', Sigma: 'Σ', Omega: 'Ω',
  rightarrow: '→', to: '→', leftarrow: '←', Rightarrow: '⇒', Leftarrow: '⇐', leftrightarrow: '↔',
  leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈', equiv: '≡',
  times: '×', cdot: '·', pm: '±', mp: '∓', infty: '∞', sum: '∑', prod: '∏', int: '∫',
  partial: '∂', nabla: '∇', forall: '∀', exists: '∃', in: '∈', notin: '∉', subset: '⊂',
  cup: '∪', cap: '∩', sqrt: '√', deg: '°', ldots: '…', cdots: '⋯'
});

function formatMathTex(raw) {
  let out = messageEscape(String(raw || '').trim());
  out = out.replace(/\\([A-Za-z]+)/g, (m, name) => Object.hasOwn(TEX_SYMBOLS, name) ? TEX_SYMBOLS[name] : m);
  out = out.replace(/\^\{([^}]+)\}/g, '<sup>$1</sup>').replace(/\^([A-Za-z0-9+-])/g, '<sup>$1</sup>');
  out = out.replace(/_\{([^}]+)\}/g, '<sub>$1</sub>').replace(/_([A-Za-z0-9])/g, '<sub>$1</sub>');
  return out;
}

function messageInline(text, depth = 0) {
  if (depth > 2) return messageEscape(text);
  const source = String(text);
  // Single linear pass: index every maximal backtick run, then link each run
  // to the next run of the same length so code-span closers are O(1) lookups.
  const runs = [], runAt = new Map();
  for (let k = 0; k < source.length;) {
    if (source[k] !== '`') { k++; continue; }
    let e = k;
    while (source[e] === '`') e++;
    runAt.set(k, runs.length);
    runs.push([k, e - k]);
    k = e;
  }
  const closer = new Array(runs.length), lastByLen = new Map();
  for (let r = runs.length - 1; r >= 0; r--) {
    closer[r] = lastByLen.get(runs[r][1]);
    lastByLen.set(runs[r][1], r);
  }
  const spans = /(`+)|\*\*((?:`[^`\n]+`|[^*`\n]|\*(?!\*))+)\*\*|\*([^*\n]+)\*|~~([^~\n]+)~~|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(?<![\\$])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g;
  let html = '', end = 0, newline = -1, match;
  while ((match = spans.exec(source))) {
    const [whole, ticks, strong, em, strike, label, url, inlineMath] = match;
    if (inlineMath !== undefined) {
      // Skip likely currency spans (e.g. "$100 and $200") that contain no math operators or LaTeX macros.
      if (/^\d[\d,.\s]*(?:[kKmMbB])?$/.test(inlineMath) || (!/[\\^_=+\-*/<>α-ωΑ-Ω]/.test(inlineMath) && /\s/.test(inlineMath))) {
        spans.lastIndex = match.index + 1;
        continue;
      }
    }
    if (strike !== undefined) {
      let slashes = 0;
      for (let p = match.index - 1; p >= end && source[p] === '\\'; p--) slashes++;
      if (slashes % 2 === 1) {
        spans.lastIndex = match.index + 1;
        continue;
      }
    }
    if (ticks !== undefined) {
      const open = match.index + ticks.length;
      if (newline < open) {
        newline = source.indexOf('\n', open);
        if (newline < 0) newline = source.length;
      }
      const close = closer[runAt.get(match.index)];
      if (close === undefined || runs[close][0] > newline || runs[close][0] === open) continue;
      let code = source.slice(open, runs[close][0]);
      if (ticks.length > 1 && code.length > 2 && code[0] === ' ' && code[code.length - 1] === ' ' && code.trim()) code = code.slice(1, -1);
      html += messageEscape(source.slice(end, match.index)) + '<code>' + messageEscape(code) + '</code>';
      end = runs[close][0] + ticks.length;
      spans.lastIndex = end;
      continue;
    }
    html += messageEscape(source.slice(end, match.index));
    if (strong !== undefined) html += '<strong>' + messageInline(strong, depth + 1) + '</strong>';
    else if (em !== undefined) html += '<em>' + messageInline(em, depth + 1) + '</em>';
    else if (strike !== undefined) html += '<del>' + messageInline(strike, depth + 1) + '</del>';
    else if (inlineMath !== undefined) html += '<span class="md-math-inline">' + formatMathTex(inlineMath) + '</span>';
    else html += '<a href="' + messageEscape(url) + '" target="_blank" rel="noopener noreferrer">' + messageEscape(label) + '</a>';
    end = match.index + whole.length;
  }
  return html + messageEscape(source.slice(end));
}

const CODE_LANG_ALIASES = Object.freeze({
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', py3: 'python', python3: 'python', pyi: 'python',
  sh: 'bash', shell: 'bash', zsh: 'bash', fish: 'bash',
  yml: 'yaml',
  html: 'xml', htm: 'xml', svg: 'xml', xhtml: 'xml', svelte: 'xml', vue: 'xml',
  docker: 'dockerfile',
  rs: 'rust', rb: 'ruby', kt: 'kotlin', kts: 'kotlin',
  cs: 'csharp', 'c#': 'csharp',
  cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', 'c++': 'cpp',
  h: 'c',
  m: 'objectivec', mm: 'objectivec', objc: 'objectivec',
  pl: 'perl', pm: 'perl',
  ex: 'elixir', exs: 'elixir',
  hs: 'haskell',
  ps: 'powershell', ps1: 'powershell', psm1: 'powershell', pwsh: 'powershell',
  tf: 'hcl', tfvars: 'hcl', terraform: 'hcl',
  cfg: 'ini', conf: 'ini', properties: 'ini',
  proto: 'protobuf', gql: 'graphql',
  sol: 'solidity',
  asm: 'x86asm', s: 'x86asm', nasm: 'x86asm', arm: 'x86asm', armasm: 'x86asm',
  tex: 'latex',
  mk: 'makefile', make: 'makefile',
  md: 'markdown', mdx: 'markdown',
  dotenv: 'env',
  txt: 'plaintext', text: 'plaintext'
});

function normalizeCodeLanguage(language) {
  const raw = String(language || '').trim().toLowerCase();
  if (!raw) return '';
  return Object.hasOwn(CODE_LANG_ALIASES, raw) ? CODE_LANG_ALIASES[raw] : raw;
}

function highlightCode(code, language) {
  if (/^(diff|patch)$/i.test(language)) {
    const colors = { '+': 'patch-add', '-': 'patch-remove', '@': 'patch-hunk' };
    return messageEscape(code).replace(/^(?:[+-]|@@).*$/gm, line =>
      '<span class="' + colors[line[0]] + '">' + line + '</span>');
  }
  if (typeof hljs === 'undefined') return messageEscape(code);
  try {
    const lang = normalizeCodeLanguage(language);
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
    return hljs.highlightAuto(code).value;
  } catch {
    return messageEscape(code);
  }
}

function highlightCodeLine(line, language) {
  if (!line) return ' ';
  if (typeof hljs === 'undefined') return messageEscape(line);
  try {
    const lang = normalizeCodeLanguage(language);
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(line, { language: lang, ignoreIllegals: true }).value;
  } catch {}
  return messageEscape(line);
}

function wrapCodeLines(highlightedHtml) {
  const rawLines = String(highlightedHtml).split('\n');
  if (rawLines.length > 1 && rawLines[rawLines.length - 1] === '') rawLines.pop();
  const openTags = [];
  const wrapped = rawLines.map(line => {
    const prefix = openTags.join('');
    const tagRe = /<\/?span\b[^>]*>/gi;
    let m;
    while ((m = tagRe.exec(line)) !== null) {
      if (m[0].startsWith('</')) openTags.pop();
      else openTags.push(m[0]);
    }
    const suffix = openTags.length ? '</span>'.repeat(openTags.length) : '';
    const content = line ? `${prefix}${line}${suffix}` : '';
    return `<span class="code-line">${content}</span>`;
  });
  return wrapped.join('\n');
}

function messageMarkdown(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { blocks.push('<hr>'); i++; continue; }

    // Heading
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length + 2, 6);
      blocks.push(`<h${level}>${messageInline(heading[2])}</h${level}>`); i++; continue;
    }

    // Display Math block ($$...$$)
    if (line.trim() === '$$' || (/^\$\$.+\$\$$/.test(line.trim()) && line.trim().length > 4)) {
      const trimmed = line.trim();
      if (trimmed.length > 4 && trimmed.startsWith('$$') && trimmed.endsWith('$$')) {
        blocks.push(`<div class="md-math-block" role="math">${formatMathTex(trimmed.slice(2, -2))}</div>`);
        i++; continue;
      }
      const mathLines = [];
      i++;
      while (i < lines.length && lines[i].trim() !== '$$') { mathLines.push(lines[i++]); }
      if (i < lines.length && lines[i].trim() === '$$') i++;
      blocks.push(`<div class="md-math-block" role="math">${formatMathTex(mathLines.join('\n'))}</div>`);
      continue;
    }

    // Blockquote & GitHub-style Callouts (> [!NOTE], > [!TIP], > [!IMPORTANT], > [!WARNING], > [!CAUTION])
    if (line.startsWith('> ') || line === '>') {
      const quoteLines = [];
      while (i < lines.length && (lines[i].startsWith('> ') || lines[i] === '>')) {
        quoteLines.push(lines[i].replace(/^>\s?/, '')); i++;
      }
      const calloutMatch = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i.exec(quoteLines[0] || '');
      if (calloutMatch) {
        const kind = calloutMatch[1].toLowerCase();
        const label = calloutMatch[1].toUpperCase();
        const rest = [calloutMatch[2], ...quoteLines.slice(1)].filter(Boolean);
        blocks.push(`<aside class="md-callout callout-${kind}"><strong class="md-callout-title">${label}</strong><div class="md-callout-body">${rest.map(ql => messageInline(ql)).join('<br>')}</div></aside>`);
        continue;
      }
      blocks.push(`<blockquote>${quoteLines.map(ql => ql ? messageInline(ql) : '<br>').join('<br>')}</blockquote>`); continue;
    }

    // List (including GFM task checklists and indented sub-items)
    const list = /^(\s*)(?:([-+*])|([0-9]+)[.)])\s+(.+)$/.exec(line);
    if (list) {
      const ordered = Boolean(list[3]), baseIndent = list[1].length, items = [];
      const start = ordered ? Math.min(Number(list[3]), 1000000) : null;
      let hasTasks = false;
      while (i < lines.length) {
        const item = /^(\s*)(?:([-+*])|([0-9]+)[.)])\s+(.+)$/.exec(lines[i]);
        if (!item) break;
        const indent = item[1].length;
        const itemOrdered = Boolean(item[3]);
        if (indent <= baseIndent && itemOrdered !== ordered) break;
        const content = item[4];
        const nestedCls = indent > baseIndent ? ' class="md-nested-item"' : '';
        const taskMatch = !itemOrdered ? /^\[([ xX])\](?:\s+(.*))?$/.exec(content) : null;
        if (taskMatch) {
          hasTasks = true;
          const checked = taskMatch[1].toLowerCase() === 'x';
          items.push(`<li class="md-task-item${checked ? ' is-checked' : ''}${indent > baseIndent ? ' md-nested-item' : ''}"><input class="md-checkbox${checked ? ' is-checked' : ''}" type="checkbox" disabled${checked ? ' checked' : ''} aria-label="${checked ? 'Checked' : 'Unchecked'}"><span class="md-task-label">${messageInline(taskMatch[2] || '')}</span></li>`);
        } else {
          items.push(`<li${nestedCls}>${messageInline(content)}</li>`);
        }
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      const attrs = ordered ? ` start="${start}"` : hasTasks ? ' class="md-task-list"' : '';
      blocks.push(`<${tag}${attrs}>${items.join('')}</${tag}>`); continue;
    }

    // Table (simple GFM)
    if (line.includes('|') && i + 1 < lines.length && /^\|?\s*[-:]+[-| :]*$/.test(lines[i + 1])) {
      const parseRow = row => {
        let source = row.startsWith('|') ? row.slice(1) : row;
        if (source.endsWith('|')) {
          let slashes = 0;
          for (let k = source.length - 2; k >= 0 && source[k] === '\\'; k--) slashes++;
          if (slashes % 2 === 0) source = source.slice(0, -1);
        }
        const cells = [];
        let cell = '';
        for (let k = 0; k < source.length; k++) {
          if (source[k] === '\\' && source[k + 1] === '|') {
            let slashes = 0;
            for (let p = k; p >= 0 && source[p] === '\\'; p--) slashes++;
            if (slashes % 2 === 1) {
              cell += '|';
              k++;
              continue;
            }
          }
          if (source[k] === '|') {
            cells.push(cell.trim());
            cell = '';
          } else {
            cell += source[k];
          }
        }
        cells.push(cell.trim());
        return cells;
      };
      const headers = parseRow(line);
      const alignRow = parseRow(lines[i + 1]);
      const aligns = alignRow.map(c => {
        if (c.startsWith(':') && c.endsWith(':')) return 'center';
        if (c.endsWith(':')) return 'right';
        return 'left';
      });
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|')) {
        rows.push(parseRow(lines[i])); i++;
      }
      const headHtml = headers.map((h, j) => `<th class="md-align-${aligns[j] || 'left'}">${messageInline(h)}</th>`).join('');
      const bodyHtml = rows.map(row => `<tr>${row.map((c, j) => `<td class="md-align-${aligns[j] || 'left'}">${messageInline(c)}</td>`).join('')}</tr>`).join('');
      blocks.push(`<table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`); continue;
    }

    // Paragraph
    const paragraph = [line]; i++;
    while (i < lines.length && lines[i].trim() && !/^(?:#{1,6}\s|\s*(?:[-+*]|[0-9]+[.)])\s|>\s?|(-{3,}|\*{3,}|_{3,})\s*$)/.test(lines[i])) {
      if (lines[i].includes('|') && i + 1 < lines.length && /^\|?\s*[-:]+[-| :]*$/.test(lines[i + 1])) break;
      paragraph.push(lines[i++]);
    }
    blocks.push(`<p>${messageInline(paragraph.join('\n'))}</p>`);
  }
  return `<div class="message-markdown">${blocks.join('')}</div>`;
}

function tryFileWrite(content, language) {
  if (!/^json$/i.test(language)) return null;
  const trimmed = content.trim();
  try {
    const obj = JSON.parse(trimmed);
    if (typeof obj.path === 'string' && typeof obj.content === 'string') return obj;
  } catch {}
  const pathMatch = /^\s*\{\s*"path"\s*:\s*"([^"]+)"\s*,\s*"content"\s*:\s*"/.exec(trimmed);
  if (pathMatch) {
    let body = trimmed.slice(pathMatch[0].length);
    const truncated = /\[Display truncated/.test(body) || !trimmed.endsWith('}');
    body = body.replace(/"\s*\}\s*$/, '').replace(/\n\[Display truncated[^\]]*\]"?\s*\}?\s*$/, '');
    try { body = JSON.parse('"' + body + '"'); } catch { body = body.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\'); }
    return { path: pathMatch[1], content: body, truncated };
  }
  return null;
}

const FILE_COPY_STORE = new Map();
let fileCopyCounter = 0;
if (typeof window !== 'undefined') window.__g0dFileCopyStore = FILE_COPY_STORE;

function renderFileCard(file) {
  const ext = file.path.split('.').pop().toLowerCase();
  const lang = ext || 'text';
  const lines = file.content.split('\n').length;
  const preview = file.content.length > 2000 ? file.content.slice(0, 2000) + '\n…' : file.content;
  const highlighted = highlightCode(preview, lang);
  const copyId = `fc_${++fileCopyCounter}`;
  FILE_COPY_STORE.set(copyId, file.content);
  if (FILE_COPY_STORE.size > 400) {
    const oldest = FILE_COPY_STORE.keys().next().value;
    if (oldest) FILE_COPY_STORE.delete(oldest);
  }
  const isRenderable = /^(html?|svg)$/.test(ext) && !file.truncated;
  const encodeUtf8Base64 = str => {
    try {
      const bytes = new TextEncoder().encode(String(str));
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    } catch { return ''; }
  };
  const previewPayload = isRenderable ? encodeUtf8Base64(file.content) : '';
  const previewBtn = previewPayload ? `<button type="button" class="file-card-preview" data-preview-content="${messageEscape(previewPayload)}" aria-label="Preview ${messageEscape(file.path)}">Preview</button>` : '';
  const truncNote = file.truncated ? '<span class="file-card-truncated">Content truncated in display</span>' : '';
  const lineCount = `<span class="file-card-lines">${lines}${file.truncated ? '+' : ''} line${lines !== 1 ? 's' : ''}</span>`;
  return `<div class="file-card"><div class="file-card-header"><span class="file-card-icon" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2.5h5.5L13 6v7.5H4z"/><path d="M9.5 2.5V6H13"/></svg></span><span class="file-card-path">${messageEscape(file.path)}</span>${lineCount}${truncNote}<span class="file-card-actions"><button type="button" class="code-copy" data-copy-code data-copy-full-id="${copyId}" aria-label="Copy file content">Copy</button>${previewBtn}</span></div><pre class="message-code hljs file-card-code" tabindex="0" role="region" aria-label="Contents of ${messageEscape(file.path)}"><code>${highlighted}</code></pre></div>`;
}

function formatMessageBody(text, markdown = false) {
  return String(text ?? '').split(/(```[\s\S]*?(?:```|$))/g).filter(Boolean).map(part => {
    if (!part.startsWith('```')) return markdown ? messageMarkdown(part) : `<div class="message-text">${messageEscape(part)}</div>`;
    const match = /^```([^\n]*)\n?/.exec(part);
    const language = match[1].trim().slice(0, 32) || '';
    const displayLang = language || 'code';
    const content = part.slice(match[0].length).replace(/```$/, '');
    const fileWrite = tryFileWrite(content, language);
    if (fileWrite) return renderFileCard(fileWrite);
    const highlighted = highlightCode(content, language);
    const lineCount = content ? content.replace(/\n$/, '').split('\n').length : 0;
    const isCollapsible = lineCount >= 2;
    const startCollapsed = lineCount > 120;
    const lineLabel = lineCount > 1 ? `<span class="code-line-count">${lineCount} lines</span>` : '';
    const baseLang = language.split(/[:\s]/)[0].toLowerCase();
    const isMermaid = baseLang === 'mermaid';
    const isPreviewable = isMermaid || /^(?:html?|svg)$/i.test(baseLang) || (/^xml$/i.test(baseLang) && /^\s*<(?:!doctype\s+html|html|svg)/i.test(content));
    const previewCodeBtn = isPreviewable ? `<button type="button" class="code-action-btn code-preview-btn" data-preview-code data-preview-lang="${messageEscape(baseLang || 'html')}" aria-label="${isMermaid ? 'Render Mermaid diagram' : 'Run live preview'}">${isMermaid ? '▶ Diagram' : '▶ Preview'}</button>` : '';
    const collapseBtn = isCollapsible ? `<button type="button" class="code-action-btn" data-collapse-code aria-expanded="${startCollapsed ? 'false' : 'true'}" aria-label="${startCollapsed ? 'Expand' : 'Collapse'} code block">${startCollapsed ? 'Expand' : 'Collapse'}</button>` : '';
    const wrapBtn = `<button type="button" class="code-action-btn" data-wrap-code aria-pressed="false" aria-label="Toggle word wrap">Wrap</button>`;
    const numbered = lineCount > 1 ? wrapCodeLines(highlighted) : highlighted;
    const numberedCls = lineCount > 1 ? ' has-line-numbers' : '';
    const collapsedCls = startCollapsed ? ' is-collapsed' : '';
    return `<div class="message-code-block${collapsedCls}"><div class="message-code-header"><span class="code-lang-group"><span class="message-code-lang">${messageEscape(displayLang)}</span>${lineLabel}</span><span class="code-header-actions">${previewCodeBtn}${collapseBtn}${wrapBtn}<button type="button" class="code-copy" data-copy-code aria-label="Copy code block">Copy</button></span></div><pre class="message-code hljs${numberedCls}" tabindex="0" role="region" aria-label="Code block"><code>${numbered}</code></pre></div>`;
  }).join('');
}
