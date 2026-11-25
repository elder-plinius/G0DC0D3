import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const load = (name) => readFile(new URL('../public/' + name, import.meta.url), 'utf8');

test('Mac dictation replaces the selection, updates interim text and leaves the result in the draft', async () => {
  const calls = [];
  const window = new EventTarget();
  window.webkit = { messageHandlers: { dictation: { postMessage: (message) => calls.push(message) } } };
  const document = new EventTarget();
  const elements = new Map();
  document.getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, new EventTarget());
    return elements.get(id);
  };
  const input = document.getElementById('composer-input');
  Object.assign(input, {
    value: 'Fix old text please',
    selectionStart: 4,
    selectionEnd: 12,
    isConnected: true,
    focus() {},
    setRangeText(value, start, end) {
      this.value = this.value.slice(0, start) + value + this.value.slice(end);
    },
  });
  const button = {
    dataset: { dictate: 'composer-input' },
    setAttribute(key, value) {
      this[key] = value;
    },
  };
  document.querySelectorAll = () => [button];
  vm.runInNewContext(await load('dictation.js'), {
    window,
    document,
    crypto,
    selectedId: 'task',
    Event,
    toast: (msg) => assert.fail(msg),
  });
  const transcript = (id, text, final) =>
    window.dispatchEvent(Object.assign(new Event('godcode-dictation'), { detail: { id, text, final } }));
  button.onclick();
  const id = calls[0].id;
  assert.equal(calls[0].action, 'start');
  transcript(id, 'this', false);
  transcript(id, 'the settings view', true);
  assert.equal(input.value, 'Fix the settings view please');
  assert.equal(button['aria-pressed'], 'false');
  transcript(id, 'late words', true);
  assert.equal(input.value, 'Fix the settings view please');
  button.onclick();
  input.dispatchEvent(new Event('input'));
  assert.equal(calls.at(-1).action, 'cancel');
  for (const property of ['readOnly', 'disabled']) {
    const count = calls.length;
    input[property] = true;
    button.onclick();
    assert.equal(calls.length, count);
    input[property] = false;
    button.onclick();
    const activeId = calls.at(-1).id;
    assert.equal(calls.at(-1).action, 'start');
    const draft = input.value;
    input[property] = true;
    transcript(activeId, 'discard', false);
    transcript(activeId, 'late', true);
    assert.equal(input.value, draft);
    assert.deepEqual(calls.slice(count).map(c => c.action), ['start', 'cancel']);
    assert.equal(button['aria-pressed'], 'false');
    input[property] = false;
  }
});

test('Markdown previews keep links, inline code and fenced source; CSV keeps quoted delimiters', async () => {
  const context = vm.createContext({ window: {}, document: {}, console });
  vm.runInContext(await load('message-format.js'), context);
  vm.runInContext(await load('file-preview.js'), context);
  const pane = {};
  context.renderDocumentPreview(
    pane,
    'notes.md',
    '# Notes\n\n[Docs](https://example.com) and `code`.\n\n```js\nconst x = 1;\n```',
  );
  assert.match(pane.innerHTML, /<h3>Notes<\/h3>/);
  assert.match(pane.innerHTML, /<a href="https:\/\/example.com"/);
  assert.match(pane.innerHTML, /<code>code<\/code>/);
  assert.match(pane.innerHTML, /<pre><code>const x = 1;/);
  context.renderDocumentPreview(pane, 'rows.csv', 'name,value\r\n"one,two","a""b"\r\n');
  assert.match(pane.innerHTML, /<td>one,two<\/td><td>a&quot;b<\/td>/);
});

test('patch highlighting preserves diff prefixes and displays literal markup', async () => {
  const context = vm.createContext({});
  vm.runInContext(await load('message-format.js'), context);
  const sample = '@@ -1 +1 @@\n-<old>\n+<new> & value\n unchanged\n';
  assert.equal(context.highlightCode(sample, 'diff'), [
    '<span class="patch-hunk">@@ -1 +1 @@</span>',
    '<span class="patch-remove">-&lt;old&gt;</span>',
    '<span class="patch-add">+&lt;new&gt; &amp; value</span>',
    ' unchanged',
    '',
  ].join('\n'));
});

test('HTML preview frames announce their purpose and filename', async () => {
  const context = vm.createContext({ document: { createElement: () => ({}) } });
  vm.runInContext(await load('file-preview.js'), context);
  let frame;
  context.renderDocumentPreview({ replaceChildren(element) { frame = element; } }, 'report.html', '<p>Ready</p>');
  assert.equal(frame.title, 'Preview of report.html');
  assert.equal(frame.sandbox, '');
});

test('starting a Venice chat never enrolls other connected accounts as fallbacks', async () => {
  const ui = vm.runInNewContext((await load('recovery.js')) + '\nRecoveryUI');
  const accounts = [{id:'openrouter-coder'}, {id:'venice-glm'}, {id:'codex-cli'}];
  const route = (preferred, venice = 'venice-glm') => Array.from(ui.initialChatRoute(accounts, preferred, venice));
  assert.deepEqual(route(null), ['venice-glm']);
  assert.deepEqual(route('venice-glm'), ['venice-glm']);
  assert.deepEqual(route('openrouter-coder'), ['openrouter-coder']);
  assert.deepEqual(route('venice-catalog:example'), ['venice-catalog:example']);
  assert.deepEqual(route('venice-catalog:example', null), []);
  assert.deepEqual(route('disconnected-account'), []);
});

test('Ultra-Plinian shows the selected route and respects the runtime timeout range', async () => {
  const ui = vm.runInNewContext((await load('recovery.js')) + '\nRecoveryUI');
  const single = ['venice-glm'], main = 'venice-catalog:main', other = 'venice-catalog:other';
  assert.match(ui.presentation(null,0,single).detail,/one model selected/i);
  const stopped = ui.presentation({providerId:single[0],providers:single,policy:{mode:'adaptive'},status:'blocked',
    blocker:{code:'NO_ELIGIBLE_FALLBACK'},outcome:{kind:'declined',detail:'Only one model was selected.'}});
  assert.equal(stopped.state,'Stopped');
  assert.match(stopped.detail,/Only one/);
  assert.equal(ui.presentation({providerId:main,providers:[main],status:'queued',policy:{mode:'adaptive'}}).locked,true);
  const two = {providerId:main,providers:[main,other],status:'queued',policy:{mode:'ask',requestTimeoutMs:600000}};
  assert.equal(ui.presentation(two).enabled,false);
  assert.equal(ui.presentation(two).policy.requestTimeoutMs,600000);
  assert.equal(ui.presentation({...two,policy:{mode:'adaptive',requestTimeoutMs:900000}}).enabled,true);
  assert.deepEqual(Array.from(ui.initialChatRoute([],main,'venice-glm',{primary:main,id:other})),[main,other]);
  assert.deepEqual(Array.from(ui.initialChatRoute([],main,'venice-glm',{primary:other,id:main})),[main]);
});

test('prompt shortcuts expand only an exact leading tag, preserve arguments and respect the composer limit', async () => {
  const editor = vm.createContext({$:()=>({addEventListener(){}})});
  vm.runInContext(await load('prompt-commands.js'),editor);
  vm.runInContext("promptLibrary=[{tag:'!GRADE',prompt:'Score clarity.'},{tag:'!SOCRATIC+',prompt:'Ask one question.'}]",editor);
  const expand=vm.runInContext('expandPromptCommand',editor);
  assert.equal(expand('!GRADE Paper one\nPaper two',100),'!GRADE\n\nScore clarity.\n\nPaper one\nPaper two');
  assert.equal(expand('!SOCRATIC+',100),'!SOCRATIC+\n\nAsk one question.');
  for(const literal of ['Mention !GRADE here.','!GRADEX','!GRADE!','!unknown'])assert.equal(expand(literal,100),literal);
  assert.throws(()=>expand('!GRADE Details',8),/limit/);
});

test('chat tables distinguish escaped pipes from separators and optional borders', async () => {
  const render = vm.runInNewContext((await load('message-format.js')) + '\nmessageMarkdown');
  const header = String.raw`| A\|B | C |`;
  const cells = (row, tag) => Array.from(row.matchAll(new RegExp('<' + tag + '\\b[^>]*>(.*?)</' + tag + '>', 'g')), m => m[1]);
  for (const [line, expected] of [
    [String.raw`one | tail\|`, ['one', 'tail|']],
    [String.raw`| x || z |`, ['x', '', 'z']],
    [String.raw`a\\|b`, [String.raw`a\\`, 'b']],
    [String.raw`a\\\|b | c`, [String.raw`a\\|b`, 'c']],
  ]) {
    const html = render([header, '| --- | --- |', line].join('\n'));
    assert.deepEqual(cells(html, 'th'), ['A|B', 'C']);
    assert.deepEqual(cells(html, 'td'), expected);
  }
});

test('CSV and TSV previews preserve quoted empty records at EOF and mark column headers', async () => {
  const context = vm.createContext({});
  vm.runInContext(await load('message-format.js'), context);
  vm.runInContext(await load('file-preview.js'), context);
  for (const format of ['csv', 'tsv']) {
    const preview = source => {
      const pane = {};
      context.renderDocumentPreview(pane, 'table.' + format, source);
      return pane.innerHTML;
    };
    assert.equal(preview('Title\r\n""'), preview('Title\r\n""\r\n'));
    assert.match(preview('Title\r\n""'), /<td><\/td>/);
    assert.match(preview('""'), /<th scope="col"><\/th>/);
    assert.doesNotMatch(preview(''), /<tr>/);
  }
});

test('JSON previews have a keyboard-accessible region named for the file', async () => {
  const context = vm.createContext({
    document: { createElement: () => ({setAttribute(name, value) { this[name] = value; }}) },
    window: {},
  });
  vm.runInContext(await load('file-preview.js'), context);
  const pane = {replaceChildren(el) { this.preview = el; }};
  for (const [name, content, expected] of [
    ['sample.json', '{"n":1}', '{\n  "n": 1\n}'],
    ['unfinished.JSON', '{', '{'],
  ]) {
    context.renderDocumentPreview(pane, name, content);
    assert.equal(pane.preview.role, 'region');
    assert.equal(pane.preview['aria-label'], 'JSON preview of ' + name);
    assert.equal(pane.preview.tabIndex, 0);
    assert.equal(pane.preview.textContent, expected);
  }
  context.renderDocumentPreview(pane, 'sample.js', 'const n = 1;');
  assert.equal(pane.preview['aria-label'], undefined);
  assert.equal(pane.preview.textContent, 'const n = 1;');
});

test('Venice defaults pick an available same-account backup and preserve explicit choices and Off', async () => {
  const ui = vm.runInNewContext((await load('recovery.js')) + '\nRecoveryUI');
  const main = 'venice-catalog:deepseek-v4-1-flash-1017';
  const glm = 'venice-catalog:z-ai-glm-5-3-flash';
  const qwen = 'venice-catalog:qwen-3-7-plus';
  const models = [main, glm, qwen].map(id => ({id, model:id.slice('venice-catalog:'.length)}));
  const accounts = [{id:'venice-glm'},{id:'openrouter-coder'}];
  const route = backup => Array.from(ui.initialChatRoute(accounts,main,'venice-glm',backup,models));
  assert.deepEqual(route(null),[main,glm]);
  assert.equal(ui.presentation(null,0,route(null)).enabled,true);
  assert.deepEqual(route({primary:main,id:qwen}),[main,qwen]);
  assert.deepEqual(route({primary:main,id:null}),[main]);
  assert.deepEqual(route({primary:main,id:'venice-catalog:removed'}),[main,glm]);
  assert.equal(ui.recommendedBackup(models,glm),qwen);
  assert.equal(ui.recommendedBackup([{id:main}],main),null);
  assert.equal(ui.recommendedBackup([{id:'openrouter-coder'}],main),null);
  assert.equal(ui.recommendedBackup([{id:glm,available:false}],main),null);
  assert.equal(ui.presentation({providers:route(null),providerId:main,policy:{mode:'ask'},status:'completed'}).enabled,false);
  assert.match(ui.presentation({providers:[main],providerId:main,policy:{mode:'adaptive'},status:'completed'}).detail,/set up.*backup/i);
  assert.deepEqual(Array.from(ui.initialChatRoute(accounts,main,null,null,models)),[]);
});

test('G0DM0D3 default prefers Venice Uncensored when connected and falls back cleanly otherwise', async () => {
  const ui = vm.runInNewContext((await load('recovery.js')) + '\nRecoveryUI');
  const liveWithVenice = [
    { id: 'anthropic', model: 'claude-opus-4-6', label: 'Anthropic · Claude Opus 4.6', available: true },
    { id: 'venice', model: 'venice-uncensored-1-2', label: 'Venice · venice-uncensored-1-2', available: true }
  ];
  assert.equal(ui.findVeniceUncensored(liveWithVenice, 'venice', []), 'venice');
  const liveNoUncensored = [
    { id: 'anthropic', model: 'claude-opus-4-6', label: 'Anthropic · Claude Opus 4.6', available: true },
    { id: 'venice-glm', model: 'z-ai-glm-5-3-flash', label: 'Venice · GLM', available: true }
  ];
  const catalog = [
    { id: 'venice-catalog:z-ai-glm-5-3-flash', model: 'z-ai-glm-5-3-flash', available: true },
    { id: 'venice-catalog:venice-uncensored-1-2', model: 'venice-uncensored-1-2', available: true }
  ];
  assert.equal(ui.findVeniceUncensored(liveNoUncensored, 'venice-glm', catalog), 'venice-catalog:venice-uncensored-1-2');
  assert.equal(ui.findVeniceUncensored(liveNoUncensored, null, catalog), null);
  assert.equal(ui.recommendedBackup(catalog, 'venice-catalog:z-ai-glm-5-3-flash'), 'venice-catalog:venice-uncensored-1-2');
});
