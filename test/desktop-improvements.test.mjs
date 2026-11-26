import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

test('retained self-build improvements preserve their desktop behaviors', () => {
  const measured = JSON.parse(execFileSync(process.execPath, ['scripts/desktop-rubric.mjs'], { cwd: root, encoding: 'utf8' }));
  const retained = [
    'csv-literal-quotes', 'csv-bom', 'json-bom', 'inline-backticks',
    'strikethrough', 'task-lists', 'table-after-paragraph',
    'literal-html', 'code-is-literal', 'quoted-csv', 'unfinished-json',
    'escaped-table-pipe', 'ordinary-links',
  ];
  for (const id of retained) {
    const result = measured.results.find(item => item.id === id);
    assert.equal(result?.pass, true, id + ': ' + (result?.detail || 'missing result'));
  }
});

test('unmatched inline-code delimiters complete within the rendering budget', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(new URL('../public/message-format.js', import.meta.url), 'utf8'), context);
  for (const text of [
    '`' + 'x'.repeat(50000),
    Array.from({ length: 100 }, (_, index) => '`'.repeat(index + 1) + ' x ').join(''),
  ]) {
    context.input = text;
    vm.runInContext('messageInline(input)', context, { timeout: 2000 });
  }
});
