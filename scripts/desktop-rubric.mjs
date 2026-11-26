import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const context = vm.createContext({
  window: {},
  document: {
    createElement(tagName) {
      return { tagName, setAttribute(name, value) { this[name] = value; } };
    },
  },
});
for (const file of ['message-format.js', 'file-preview.js']) {
  vm.runInContext(await fs.readFile(path.join(process.cwd(), 'public', file), 'utf8'), context, { filename: file });
}
const pane = () => ({ replaceChildren(element) { this.child = element; }, append() {} });
const preview = (name, text) => {
  const target = pane();
  context.renderDocumentPreview(target, name, text);
  return target;
};
const inline = text => context.messageInline(text);
const markdown = text => context.messageMarkdown(text);
const chat = text => context.formatMessageBody(text, true);
const count = (text, pattern) => [...text.matchAll(pattern)].length;
const results = [];
function check(id, run, anchor = false) {
  try { run(); results.push({ id, pass: true, anchor }); }
  catch (error) { results.push({ id, pass: false, anchor, detail: error.message.slice(0, 1400) }); }
}

check('csv-literal-quotes', () => {
  const html = preview('names.csv', 'name,count\nO"Brien,2').innerHTML;
  assert.match(html, /<td>O&quot;Brien<\/td>/);
  assert.match(html, /<td>2<\/td>/);
});
check('csv-bom', () => {
  const html = preview('names.csv', '\ufeffname,count\nAda,1').innerHTML;
  assert.ok(!html.includes('\ufeff'), 'CSV byte-order mark appears in the header');
  assert.match(html, /<th\b[^>]*>name<\/th>/);
});
check('json-bom', () => {
  assert.equal(preview('value.json', '\ufeff{"count":1}').child.textContent, '{\n  "count": 1\n}');
});
check('inline-backticks', () => {
  assert.match(inline('Use ``a ` b`` here'), /<code>a ` b<\/code>/);
  assert.equal(count(inline('Use ``a ` b`` here'), /<code>/g), 1);
});
check('escaped-emphasis', () => {
  const html = inline(String.raw`\*literal\* and \_plain\_`);
  assert.ok(html.includes('*literal*') && html.includes('_plain_'), 'Escaped Markdown punctuation should display literally');
  assert.doesNotMatch(html, /<(?:em|strong)>/);
});
check('strikethrough', () => {
  assert.match(inline('Keep ~~old~~ new'), /<(?:del|s)>old<\/(?:del|s)>/);
  assert.match(inline('`~~literal~~`'), /<code>~~literal~~<\/code>/);
});
check('task-lists', () => {
  const html = markdown('- [x] Done\n- [ ] Pending');
  const inputs = html.match(/<input\b[^>]*>/g) || [];
  assert.equal(inputs.length, 2, 'Task lists should render two checkboxes');
  assert.ok(inputs.every(input => /type=["']checkbox["']/.test(input) && /\bdisabled\b/.test(input)));
  assert.match(inputs[0], /\bchecked\b/);
  assert.doesNotMatch(inputs[1], /\bchecked\b/);
  assert.ok(html.includes('Done') && html.includes('Pending'));
});
check('table-after-paragraph', () => {
  const html = markdown('Summary\n| Name | Value |\n| --- | --- |\n| Ada | 2 |');
  assert.equal(count(html, /<table>/g), 1);
  assert.match(html, /<p>Summary<\/p>/);
  assert.match(html, /<td\b[^>]*>Ada<\/td>/);
});
check('long-code-fences', () => {
  const text = '````md\n```js\nconst x = 1;\n```\n````';
  for (const html of [chat(text), preview('readme.md', text).innerHTML]) {
    assert.equal(count(html, /<pre\b/g), 1, 'A longer fence must contain the shorter fences');
    assert.ok(html.includes('```js') && html.includes('const x = 1;'));
  }
});
check('tilde-code-fences', () => {
  const text = '~~~js\nconst x = 1 < 2;\n~~~';
  for (const html of [chat(text), preview('readme.md', text).innerHTML]) {
    assert.equal(count(html, /<pre\b/g), 1);
    assert.ok(html.includes('1 &lt; 2;'));
    assert.ok(!html.includes('~~~'));
  }
});
check('balanced-link-destinations', () => {
  assert.match(inline('[Guide](https://example.com/a_(b))'), /href="https:\/\/example\.com\/a_\(b\)"/);
});
check('autolinks', () => {
  assert.match(inline('<https://example.com/help>'), /<a\b[^>]*href="https:\/\/example\.com\/help"[^>]*>https:\/\/example\.com\/help<\/a>/);
});

check('literal-html', () => assert.doesNotMatch(inline('<script>alert(1)</script>'), /<script>/), true);
check('code-is-literal', () => assert.match(inline('`**literal**`'), /<code>\*\*literal\*\*<\/code>/), true);
check('quoted-csv', () => {
  const html = preview('data.csv', 'name,value\n"one,two","a""b"\n"line\nbreak",3').innerHTML;
  assert.match(html, /one,two/);
  assert.match(html, /a&quot;b/);
  assert.match(html, /line\nbreak/);
}, true);
check('unfinished-json', () => assert.equal(preview('data.json', '{"unfinished":').child.textContent, '{"unfinished":'), true);
check('escaped-table-pipe', () => assert.match(markdown('| A\\|B | C |\n| --- | --- |\n| x | y |'), /<th\b[^>]*>A\|B<\/th>/), true);
check('ordinary-links', () => assert.match(inline('[Docs](https://example.com)'), /href="https:\/\/example.com"/), true);
console.log(JSON.stringify({ passed: results.filter(r => r.pass).length, total: results.length, results }));
