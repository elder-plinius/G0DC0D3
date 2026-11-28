'use strict';

/* Zero-dependency offline Mermaid -> SVG renderer for G0DC0D3 Live Artifact Canvas.
 * Supports: flowchart / graph (TD, TB, LR, RL), sequenceDiagram, stateDiagram / stateDiagram-v2. */
(function initMermaidLite() {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function parseNodeToken(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    const patterns = [
      { re: /^([A-Za-z0-9_.-]+)\(\[([^\]]+)\]\)$/, shape: 'stadium' },
      { re: /^([A-Za-z0-9_.-]+)\[\(([^)]+)\)\]$/, shape: 'cylinder' },
      { re: /^([A-Za-z0-9_.-]+)\(\(([^)]+)\)\)$/, shape: 'circle' },
      { re: /^([A-Za-z0-9_.-]+)\{([^}]+)\}$/, shape: 'diamond' },
      { re: /^([A-Za-z0-9_.-]+)\[([^\]]+)\]$/, shape: 'rect' },
      { re: /^([A-Za-z0-9_.-]+)\(([^)]+)\)$/, shape: 'round' },
      { re: /^([A-Za-z0-9_.-]+)$/, shape: 'rect' }
    ];
    for (const p of patterns) {
      const m = p.re.exec(s);
      if (m) {
        const id = m[1];
        const label = (m[2] || id).trim().replace(/^["']|["']$/g, '');
        return { id, label, shape: p.shape };
      }
    }
    return null;
  }

  function renderFlowchart(lines, dirRaw) {
    const dir = /^(LR|RL)$/i.test(dirRaw) ? dirRaw.toUpperCase() : 'TD';
    const horiz = dir === 'LR' || dir === 'RL';
    const nodes = new Map();
    const edges = [];

    const ensureNode = tok => {
      const parsed = parseNodeToken(tok);
      if (!parsed) return null;
      const existing = nodes.get(parsed.id);
      if (!existing) {
        nodes.set(parsed.id, { ...parsed, inDeg: 0, out: [] });
      } else if (parsed.label !== parsed.id && existing.label === existing.id) {
        existing.label = parsed.label;
        existing.shape = parsed.shape;
      }
      return parsed.id;
    };

    for (const rawLine of lines) {
      const line = rawLine.replace(/%%.*$/, '').trim();
      if (!line || /^(?:subgraph|end|classDef|class|style|linkStyle|click)\b/i.test(line)) continue;
      // Split chained arrows: A --> B -->|ok| C
      const edgeRe = /\s*(-->|-.->|==>|---)\s*(?:\|([^|]+)\|)?\s*/g;
      const parts = [];
      const ops = [];
      let last = 0, m;
      while ((m = edgeRe.exec(line)) !== null) {
        parts.push(line.slice(last, m.index).trim());
        ops.push({ style: m[1], label: (m[2] || '').trim() });
        last = m.index + m[0].length;
      }
      if (!ops.length) {
        ensureNode(line);
        continue;
      }
      parts.push(line.slice(last).trim());
      for (let i = 0; i < ops.length; i++) {
        const fromId = ensureNode(parts[i]);
        const toId = ensureNode(parts[i + 1]);
        if (fromId && toId) {
          edges.push({ from: fromId, to: toId, style: ops[i].style, label: ops[i].label });
          nodes.get(fromId).out.push(toId);
          nodes.get(toId).inDeg += 1;
        }
      }
    }
    if (!nodes.size) return null;

    // Assign topological layers (handles cycles safely)
    const layer = new Map();
    const queue = [...nodes.values()].filter(n => n.inDeg === 0).map(n => n.id);
    if (!queue.length) queue.push([...nodes.keys()][0]);
    for (const id of queue) layer.set(id, 0);
    const seenEdge = new Set();
    let head = 0;
    while (head < queue.length) {
      const u = queue[head++];
      const lu = layer.get(u) || 0;
      for (const v of nodes.get(u)?.out || []) {
        const ek = `${u}->${v}`;
        if (seenEdge.has(ek)) continue;
        seenEdge.add(ek);
        const nextL = Math.min(lu + 1, nodes.size);
        if (!layer.has(v) || layer.get(v) < nextL) {
          layer.set(v, nextL);
          queue.push(v);
        }
      }
    }
    for (const id of nodes.keys()) {
      if (!layer.has(id)) layer.set(id, 0);
    }

    const groups = new Map();
    for (const [id, l] of layer.entries()) {
      if (!groups.has(l)) groups.set(l, []);
      groups.get(l).push(nodes.get(id));
    }
    const maxLayer = Math.max(...groups.keys());
    const boxW = 176, boxH = 52, gapX = 76, gapY = 74, pad = 42;

    const coords = new Map();
    let maxW = 0, maxH = 0;
    for (let l = 0; l <= maxLayer; l++) {
      const list = groups.get(l) || [];
      const rank = dir === 'RL' ? (maxLayer - l) : l;
      list.forEach((node, idx) => {
        const w = Math.max(boxW, Math.min(240, node.label.length * 8.4 + 36));
        const h = node.shape === 'diamond' ? 66 : boxH;
        const cx = horiz ? pad + rank * (boxW + gapX) + w / 2 : pad + idx * (boxW + gapX) + w / 2;
        const cy = horiz ? pad + idx * (boxH + gapY) + h / 2 : pad + rank * (boxH + gapY) + h / 2;
        coords.set(node.id, { x: cx - w / 2, y: cy - h / 2, w, h, cx, cy, node });
        maxW = Math.max(maxW, cx + w / 2 + pad);
        maxH = Math.max(maxH, cy + h / 2 + pad);
      });
    }

    const svgW = Math.max(520, Math.round(maxW));
    const svgH = Math.max(260, Math.round(maxH));

    const edgeSvg = edges.map(e => {
      const a = coords.get(e.from), b = coords.get(e.to);
      if (!a || !b) return '';
      const x1 = horiz ? (a.cx <= b.cx ? a.x + a.w : a.x) : a.cx;
      const y1 = horiz ? a.cy : (a.cy <= b.cy ? a.y + a.h : a.y);
      const x2 = horiz ? (a.cx <= b.cx ? b.x : b.x + b.w) : b.cx;
      const y2 = horiz ? b.cy : (a.cy <= b.cy ? b.y : b.y + b.h);
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const d = horiz
        ? `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`
        : `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`;
      const dash = e.style === '-.->' ? ' stroke-dasharray="6 5"' : '';
      const sw = e.style === '==>' ? '3.2' : '2';
      const marker = e.style === '---' ? '' : ' marker-end="url(#m-arrow)"';
      const lbl = e.label
        ? `<rect x="${mx - e.label.length * 4 - 8}" y="${my - 11}" width="${e.label.length * 8 + 16}" height="22" rx="6" fill="#0f172a" stroke="#475569" stroke-width="1"/><text x="${mx}" y="${my + 4}" text-anchor="middle" fill="#cbd5e1" font-size="11" font-family="system-ui, sans-serif">${esc(e.label)}</text>`
        : '';
      return `<path d="${d}" fill="none" stroke="#38bdf8" stroke-width="${sw}"${dash}${marker}/>${lbl}`;
    }).join('');

    const nodeSvg = [...coords.values()].map(({ x, y, w, h, cx, cy, node }) => {
      let shapeEl;
      if (node.shape === 'diamond') {
        shapeEl = `<polygon points="${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}" fill="#2b1742" stroke="#c084fc" stroke-width="2.2"/>`;
      } else if (node.shape === 'circle') {
        const r = Math.min(w, h) / 2;
        shapeEl = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#172554" stroke="#38bdf8" stroke-width="2.2"/>`;
      } else if (node.shape === 'stadium' || node.shape === 'round') {
        shapeEl = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${node.shape === 'stadium' ? h / 2 : 12}" fill="#12263a" stroke="#34d399" stroke-width="2.2"/>`;
      } else {
        shapeEl = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="#181c2e" stroke="#818cf8" stroke-width="2.2"/>`;
      }
      return `${shapeEl}<text x="${cx}" y="${cy + 5}" text-anchor="middle" fill="#f8fafc" font-size="13.5" font-weight="600" font-family="system-ui, -apple-system, sans-serif">${esc(node.label)}</text>`;
    }).join('');

    return `<svg viewBox="0 0 ${svgW} ${svgH}" xmlns="http://www.w3.org/2000/svg"><title>Mermaid Flowchart</title><defs><marker id="m-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 1 L 10 5 L 0 9 z" fill="#38bdf8"/></marker></defs><rect width="${svgW}" height="${svgH}" rx="16" fill="#0b0f1a"/>${edgeSvg}${nodeSvg}</svg>`;
  }

  function renderSequence(lines) {
    const actors = [];
    const actorIndex = new Map();
    const actorLabels = new Map();
    const msgs = [];
    const addActor = (id, label) => {
      const cleanId = String(id || '').trim();
      const cleanLabel = String(label || cleanId).trim();
      if (!cleanId) return;
      if (!actorIndex.has(cleanId)) {
        actorIndex.set(cleanId, actors.length);
        actors.push(cleanId);
      }
      if (label || !actorLabels.has(cleanId)) actorLabels.set(cleanId, cleanLabel);
    };

    for (const rawLine of lines) {
      const line = rawLine.replace(/%%.*$/, '').trim();
      if (!line) continue;
      const p = /^(?:participant|actor)\s+([^\s]+)(?:\s+as\s+(.+))?$/i.exec(line);
      if (p) { addActor(p[1], p[2] || p[1]); continue; }
      const m = /^([^:\-]+?)\s*(-->>|->>|-->|->)\s*([^:]+?)\s*:\s*(.*)$/.exec(line);
      if (m) {
        const from = m[1].trim();
        const to = m[3].trim();
        if (from && to) {
          addActor(from); addActor(to);
          msgs.push({ from, arrow: m[2], to, text: m[4].trim() });
        }
      }
    }
    if (!actors.length) return null;

    const colW = 190, padX = 50, topY = 34, boxW = 136, boxH = 40, stepY = 56;
    const svgW = Math.max(520, padX * 2 + (actors.length - 1) * colW + boxW);
    const svgH = Math.max(240, topY + boxH + (msgs.length + 1) * stepY + 34);
    const xOf = name => padX + boxW / 2 + actorIndex.get(name) * colW;

    const lifelines = actors.map(a => {
      const cx = xOf(a);
      const label = actorLabels.get(a) || a;
      return `<line x1="${cx}" y1="${topY + boxH}" x2="${cx}" y2="${svgH - 28}" stroke="#334155" stroke-width="2" stroke-dasharray="6 5"/><rect x="${cx - boxW / 2}" y="${topY}" width="${boxW}" height="${boxH}" rx="10" fill="#1e1b4b" stroke="#8b5cf6" stroke-width="2"/><text x="${cx}" y="${topY + 25}" text-anchor="middle" fill="#f5f3ff" font-size="13.5" font-weight="600" font-family="system-ui, sans-serif">${esc(label)}</text>`;
    }).join('');

    const arrows = msgs.map((m, i) => {
      const x1 = xOf(m.from), x2 = xOf(m.to), y = topY + boxH + 38 + i * stepY;
      const dash = m.arrow.startsWith('--') ? ' stroke-dasharray="6 4"' : '';
      if (m.from === m.to) {
        const loopW = 46, loopH = 22;
        return `<path d="M ${x1} ${y - 8} H ${x1 + loopW} V ${y + loopH - 8} H ${x1 + 4}" fill="none" stroke="#38bdf8" stroke-width="2.2"${dash} marker-end="url(#s-arrow)"/><text x="${x1 + loopW + 8}" y="${y + 6}" text-anchor="start" fill="#e2e8f0" font-size="12.5" font-family="system-ui, sans-serif">${esc(m.text)}</text>`;
      }
      const mx = (x1 + x2) / 2;
      return `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="#38bdf8" stroke-width="2.2"${dash} marker-end="url(#s-arrow)"/><text x="${mx}" y="${y - 9}" text-anchor="middle" fill="#e2e8f0" font-size="12.5" font-family="system-ui, sans-serif">${esc(m.text)}</text>`;
    }).join('');

    return `<svg viewBox="0 0 ${svgW} ${svgH}" xmlns="http://www.w3.org/2000/svg"><title>Mermaid Sequence Diagram</title><defs><marker id="s-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 1 L 10 5 L 0 9 z" fill="#38bdf8"/></marker></defs><rect width="${svgW}" height="${svgH}" rx="16" fill="#0b0f1a"/>${lifelines}${arrows}</svg>`;
  }

  function renderStateDiagram(lines) {
    const converted = [];
    for (const raw of lines) {
      const line = raw.replace(/%%.*$/, '').trim();
      const m = /^(\[\*\]|[A-Za-z0-9_.-]+)\s*-->\s*(\[\*\]|[A-Za-z0-9_.-]+)(?:\s*:\s*(.*))?$/.exec(line);
      if (m) {
        const a = m[1] === '[*]' ? 'Start((Start))' : `${m[1]}(${m[1]})`;
        const b = m[2] === '[*]' ? 'End((End))' : `${m[2]}(${m[2]})`;
        converted.push(m[3] ? `${a} -->|${m[3].trim()}| ${b}` : `${a} --> ${b}`);
      }
    }
    return converted.length ? renderFlowchart(converted, 'LR') : null;
  }

  function renderMermaidToSvg(code) {
    const lines = String(code || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return null;
    const head = lines[0];
    const body = lines.slice(1);
    const flow = /^(?:flowchart|graph)\s+(TD|TB|LR|RL|BT)?/i.exec(head);
    if (flow) return renderFlowchart(body, flow[1] || 'TD');
    if (/^sequenceDiagram\b/i.test(head)) return renderSequence(body);
    if (/^stateDiagram(?:-v2)?\b/i.test(head)) return renderStateDiagram(body);
    return renderFlowchart(lines, 'TD');
  }

  window.renderMermaidToSvg = renderMermaidToSvg;
})();
