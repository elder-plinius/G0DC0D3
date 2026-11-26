import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { scopedPath, readBoundedFile } from './broker.mjs';

const MAX_SESSIONS = 32;
const MAX_PREVIEW_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SNIPPET_BYTES = 512 * 1024;

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm'
});

export const PREVIEW_CSP = "sandbox allow-scripts allow-pointer-lock allow-modals; default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:; style-src 'self' 'unsafe-inline' data:; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'none'; frame-ancestors 'self'";

function buildConsoleBridge(token) {
  const safeToken = JSON.stringify(String(token));
  return `<script>(function(){var T=${safeToken};function send(lvl,msg){try{window.parent.postMessage({type:'g0d-preview-console',token:T,level:lvl,message:String(msg||'').slice(0,1000)},'*');}catch(e){}}function mkStore(){var m=Object.create(null);return{get length(){return Object.keys(m).length;},key:function(i){return Object.keys(m)[i]||null;},getItem:function(k){return Object.prototype.hasOwnProperty.call(m,String(k))?m[String(k)]:null;},setItem:function(k,v){m[String(k)]=String(v);},removeItem:function(k){delete m[String(k)];},clear:function(){m=Object.create(null);}};}['localStorage','sessionStorage'].forEach(function(n){try{void window[n];}catch(_){try{Object.defineProperty(window,n,{value:mkStore(),configurable:true});}catch(__){}}});window.addEventListener('error',function(e){if(e&&e.target&&e.target!==window&&(e.target.tagName==='SCRIPT'||e.target.tagName==='LINK')){send('warn','Blocked or missing resource: '+(e.target.src||e.target.href||'unknown'));return;}send('error',(e.message||'Script error')+(e.lineno?' (line '+e.lineno+')':''));},true);window.addEventListener('unhandledrejection',function(e){send('error','Unhandled rejection: '+(e.reason&&e.reason.message?e.reason.message:String(e.reason)));});var oe=console.error,ow=console.warn;console.error=function(){send('error',Array.prototype.map.call(arguments,String).join(' '));return oe.apply(console,arguments);};console.warn=function(){send('warn',Array.prototype.map.call(arguments,String).join(' '));return ow.apply(console,arguments);};`
    + `var inspOn=false,box=null,lbl=null,curEl=null;`
    + `function cssEsc(s){return String(s||'').replace(/[^a-zA-Z0-9_-]/g,function(c){return '\\\\'+c;});}`
    + `function selFor(el){if(!el||el.nodeType!==1)return '';if(el.id)return '#'+cssEsc(el.id);var parts=[],n=el;while(n&&n.nodeType===1&&n!==document.documentElement&&parts.length<4){var p=n.tagName.toLowerCase();var cls=(typeof n.className==='string'?n.className:'').trim().split(/\\s+/).filter(function(c){return c&&!/^__g0d/.test(c);}).slice(0,2);if(cls.length)p+='.'+cls.map(cssEsc).join('.');else if(n.parentElement){var sibs=Array.prototype.filter.call(n.parentElement.children,function(c){return c.tagName===n.tagName;});if(sibs.length>1)p+=':nth-of-type('+(sibs.indexOf(n)+1)+')';}parts.unshift(p);if(n.id){parts[0]='#'+cssEsc(n.id);break;}n=n.parentElement;}return parts.join(' > ');}`
    + `function ensureOv(){if(!box){box=document.createElement('div');box.id='__g0d_inspect_box';box.style.cssText='position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #b49cff;background:rgba(180,156,255,.16);border-radius:3px;box-sizing:border-box;display:none;transition:all 40ms ease-out;';document.documentElement.appendChild(box);}if(!lbl){lbl=document.createElement('div');lbl.id='__g0d_inspect_lbl';lbl.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;background:#181622;color:#f4f1ff;border:1px solid #b49cff;border-radius:5px;padding:2px 7px;font:600 11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;max-width:300px;overflow:hidden;text-overflow:ellipsis;box-shadow:0 4px 12px rgba(0,0,0,.45);display:none;';document.documentElement.appendChild(lbl);}}`
    + `function hideOv(){if(box)box.style.display='none';if(lbl)lbl.style.display='none';curEl=null;}`
    + `function setInspect(on){inspOn=Boolean(on);document.documentElement.style.cursor=inspOn?'crosshair':'';if(!inspOn)hideOv();else ensureOv();}`
    + `function isOv(t){return t===box||t===lbl;}`
    + `document.addEventListener('mousemove',function(e){if(!inspOn)return;var t=document.elementFromPoint(e.clientX,e.clientY);if(!t||isOv(t)||t===document.documentElement){hideOv();return;}curEl=t;ensureOv();var r=t.getBoundingClientRect();box.style.display='block';box.style.left=r.left+'px';box.style.top=r.top+'px';box.style.width=Math.max(2,r.width)+'px';box.style.height=Math.max(2,r.height)+'px';var tag=t.tagName.toLowerCase();var idPart=t.id?'#'+t.id:'';var clsPart=(typeof t.className==='string'&&t.className.trim())?'.'+t.className.trim().split(/\\s+/).slice(0,2).join('.'):'';lbl.textContent=tag+idPart+clsPart+' · '+Math.round(r.width)+'×'+Math.round(r.height);lbl.style.display='block';var top=r.top>26?r.top-24:Math.min(window.innerHeight-24,r.bottom+6);lbl.style.left=Math.max(4,Math.min(window.innerWidth-220,r.left))+'px';lbl.style.top=Math.max(4,top)+'px';},true);`
    + `document.addEventListener('click',function(e){if(!inspOn)return;e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();var t=curEl||e.target;setInspect(false);if(!t||isOv(t))return;var r=t.getBoundingClientRect();var cs=window.getComputedStyle(t);var openTag=(t.outerHTML||'').replace(/\\s+/g,' ').slice(0,180);var gt=openTag.indexOf('>');if(gt>0&&gt<160)openTag=openTag.slice(0,gt+1);try{window.parent.postMessage({type:'g0d-preview-picked',token:T,element:{selector:selFor(t),tag:t.tagName.toLowerCase(),id:t.id||'',classes:(typeof t.className==='string'?t.className.trim():'').slice(0,120),text:(t.innerText||t.getAttribute('aria-label')||t.getAttribute('placeholder')||'').replace(/\\s+/g,' ').trim().slice(0,100),rect:{x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)},styles:{color:cs.color,background:cs.backgroundColor,fontSize:cs.fontSize,display:cs.display,padding:cs.padding},openTag:openTag}},'*');}catch(_){}},true);`
    + `document.addEventListener('keydown',function(e){if(inspOn&&e.key==='Escape'){e.preventDefault();setInspect(false);try{window.parent.postMessage({type:'g0d-preview-inspect-cancel',token:T},'*');}catch(_){}}},true);`
    + `window.addEventListener('message',function(e){var d=e&&e.data;if(!d||d.token!==T)return;if(d.type==='g0d-preview-inspect-mode')setInspect(d.enabled);});`
    + `})();</script>`;
}

export function injectPreviewBridge(html, token) {
  const bridge = buildConsoleBridge(token);
  const src = String(html || '');
  if (/<head[^>]*>/i.test(src)) return src.replace(/<head[^>]*>/i, m => m + bridge);
  if (/<html[^>]*>/i.test(src)) return src.replace(/<html[^>]*>/i, m => m + '<head>' + bridge + '</head>');
  return '<!doctype html><html><head><meta charset="utf-8">' + bridge + '</head><body>' + src + '</body></html>';
}

function wrapSvgAsHtml(svg, title = 'SVG Preview') {
  const safeTitle = String(title).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title><style>html,body{margin:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#111315;color:#e5e7eb;overflow:auto;padding:12px;box-sizing:border-box}svg{display:block;max-width:100%;max-height:100%;height:auto}svg:not([width]){width:min(94vw,100%);height:auto}</style></head><body>${svg}</body></html>`;
}

export function createPreviewRegistry(runtime) {
  const sessions = new Map();

  function remember(token, record) {
    sessions.set(token, record);
    while (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      sessions.delete(oldest);
    }
  }

  async function createSession({ taskId, entry, html, files, name } = {}) {
    const token = randomBytes(16).toString('hex');
    if (taskId) {
      const task = runtime.getTask(String(taskId));
      const snap = await runtime.snapshotTask(task.id);
      const htmlFiles = snap.files.map(f => f.path).filter(p => /\.(?:html?|svg)$/i.test(p));
      let chosen = typeof entry === 'string' && entry.trim() ? entry.trim().replace(/^\/+/, '') : '';
      if (!chosen) {
        chosen = htmlFiles.find(p => /^index\.html?$/i.test(p))
          || htmlFiles.find(p => /\/index\.html?$/i.test(p))
          || htmlFiles[0]
          || '';
      }
      if (!chosen) throw Object.assign(new Error('No HTML or SVG file found in this workspace to preview.'), { status: 400, code: 'NO_PREVIEW_ENTRY' });
      await scopedPath(task.workspace, chosen);
      remember(token, { kind: 'workspace', taskId: task.id, workspace: task.workspace, entry: chosen, createdAt: Date.now() });
      const encodedPath = chosen.split('/').map(encodeURIComponent).join('/');
      return { token, url: `/preview/${token}/${encodedPath}`, entry: chosen, kind: 'workspace' };
    }
    if (files && typeof files === 'object' && !Array.isArray(files)) {
      const map = new Map();
      let totalBytes = 0;
      for (const [rawKey, rawVal] of Object.entries(files).slice(0, 24)) {
        if (typeof rawVal !== 'string') continue;
        const cleanKey = String(rawKey || '').replace(/^\/+/, '').replace(/\\/g, '/');
        if (!cleanKey || cleanKey.includes('..') || cleanKey.startsWith('.git') || cleanKey.startsWith('.g0dc0d3') || /[\x00-\x1f\x7f]/.test(cleanKey)) continue;
        const size = Buffer.byteLength(rawVal);
        totalBytes += size;
        if (totalBytes > MAX_SNIPPET_BYTES * 2) {
          throw Object.assign(new Error('Preview bundle exceeds 1 MiB limit.'), { status: 413, code: 'PREVIEW_TOO_LARGE' });
        }
        map.set(cleanKey, rawVal);
      }
      if (!map.size) {
        throw Object.assign(new Error('Provide at least one file in the preview bundle.'), { status: 400, code: 'INVALID_PREVIEW' });
      }
      const keys = [...map.keys()];
      const chosen = (typeof entry === 'string' && map.has(entry.replace(/^\/+/, '')))
        ? entry.replace(/^\/+/, '')
        : (keys.find(k => /^index\.html?$/i.test(k)) || keys.find(k => /\.(?:html?|svg)$/i.test(k)) || keys[0]);
      remember(token, { kind: 'bundle', files: map, entry: chosen, createdAt: Date.now() });
      const encodedPath = chosen.split('/').map(encodeURIComponent).join('/');
      return { token, url: `/preview/${token}/${encodedPath}`, entry: chosen, files: keys, kind: 'bundle' };
    }
    if (typeof html !== 'string' || !html.trim()) {
      throw Object.assign(new Error('Provide html content, files bundle, or a taskId to preview.'), { status: 400, code: 'INVALID_PREVIEW' });
    }
    if (Buffer.byteLength(html) > MAX_SNIPPET_BYTES) {
      throw Object.assign(new Error('Preview HTML exceeds 512 KiB limit.'), { status: 413, code: 'PREVIEW_TOO_LARGE' });
    }
    const cleanName = typeof name === 'string' && name.trim() ? name.trim().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) : 'preview.html';
    const isSvg = /\.svg$/i.test(cleanName) || /^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(html);
    const bodyHtml = isSvg ? wrapSvgAsHtml(html, cleanName) : html;
    remember(token, { kind: 'snippet', html: bodyHtml, name: cleanName, createdAt: Date.now() });
    return { token, url: `/preview/${token}/${encodeURIComponent(cleanName)}`, entry: cleanName, kind: 'snippet' };
  }

  async function serve(token, rawRelPath, res) {
    const record = sessions.get(token);
    if (!record) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('Preview session expired or not found.');
      return;
    }
    const commonHeaders = {
      'content-security-policy': PREVIEW_CSP,
      'x-frame-options': 'SAMEORIGIN',
      'cross-origin-resource-policy': 'cross-origin',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    };
    if (record.kind === 'snippet') {
      const injected = injectPreviewBridge(record.html, token);
      res.writeHead(200, { ...commonHeaders, 'content-type': 'text/html; charset=utf-8' });
      res.end(injected);
      return;
    }
    if (record.kind === 'bundle') {
      let relPath;
      try {
        relPath = rawRelPath ? rawRelPath.split('/').map(decodeURIComponent).join('/').replace(/^\/+/, '') : record.entry;
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Malformed preview path.');
        return;
      }
      if (!relPath || relPath.endsWith('/')) relPath = (relPath || '') + record.entry;
      const content = record.files.get(relPath) ?? record.files.get(relPath.replace(/^\.\//, ''));
      if (content === undefined) {
        res.writeHead(404, { ...commonHeaders, 'content-type': 'text/plain; charset=utf-8' });
        res.end('File not found in preview bundle.');
        return;
      }
      const ext = path.extname(relPath).toLowerCase();
      if (ext === '.html' || ext === '.htm') {
        res.writeHead(200, { ...commonHeaders, 'content-type': 'text/html; charset=utf-8' });
        res.end(injectPreviewBridge(content, token));
        return;
      }
      if (ext === '.svg' && relPath === record.entry) {
        res.writeHead(200, { ...commonHeaders, 'content-type': 'text/html; charset=utf-8' });
        res.end(injectPreviewBridge(wrapSvgAsHtml(content, relPath), token));
        return;
      }
      const mime = MIME_TYPES[ext] || 'text/plain; charset=utf-8';
      res.writeHead(200, { ...commonHeaders, 'content-type': mime });
      res.end(content);
      return;
    }
    let relPath;
    try {
      relPath = rawRelPath ? rawRelPath.split('/').map(decodeURIComponent).join('/') : record.entry;
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Malformed preview path.');
      return;
    }
    if (!relPath || relPath.endsWith('/')) relPath = (relPath || '') + 'index.html';
    let target;
    try {
      const resolved = await scopedPath(record.workspace, relPath, { withStat: true });
      target = resolved.target;
      const bytes = await readBoundedFile(target, MAX_PREVIEW_FILE_BYTES, 'PREVIEW_SIZE', { expectedIdentity: resolved.stat });
      const ext = path.extname(relPath).toLowerCase();
      if (ext === '.html' || ext === '.htm') {
        const injected = injectPreviewBridge(bytes.toString('utf8'), token);
        res.writeHead(200, { ...commonHeaders, 'content-type': 'text/html; charset=utf-8' });
        res.end(injected);
        return;
      }
      if (ext === '.svg' && relPath === record.entry) {
        const injected = injectPreviewBridge(wrapSvgAsHtml(bytes.toString('utf8'), relPath), token);
        res.writeHead(200, { ...commonHeaders, 'content-type': 'text/html; charset=utf-8' });
        res.end(injected);
        return;
      }
      const mime = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { ...commonHeaders, 'content-type': mime });
      res.end(bytes);
    } catch (err) {
      const status = err?.code === 'ENOENT' ? 404 : err?.code === 'PATH_DENIED' ? 403 : 400;
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(status === 404 ? 'File not found in workspace preview.' : (err?.message || 'Preview access denied.'));
    }
  }

  return { createSession, serve };
}
