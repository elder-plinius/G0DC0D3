import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HttpProvider } from '../src/providers.mjs';
import { loadProviderReferences } from '../src/provider-references.mjs';

const patch = 'diff --git a/name.txt b/name.txt\n--- a/name.txt\n+++ b/name.txt\n@@ -1 +1 @@\n-old\n+new\n';

test('patch proposals accept a single fenced diff with surrounding explanation', async t => {
  const provider = new HttpProvider({ id: 'test', model: 'test', baseUrl: 'https://model.example.invalid/v1' });
  let content;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message: { content } }] }));
  const propose = () => provider.proposePatch({ objective: 'Rename', files: [], signal: new AbortController().signal });

  for (const response of [patch, '  \n' + patch, ...['diff', 'patch', ''].map(language =>
    'Here is the change.\n\n```' + language + '\n' + patch + '```\n\nThis preserves the interface.')]) {
    content = response;
    assert.equal(await propose(), patch);
  }
  content = ('Explanation\n```diff\n' + patch + '```\n').replaceAll('\n', '\r\n');
  assert.equal((await propose()).replaceAll('\r\n', '\n'), patch);

  // Ambiguous or unfinished replies stay invalid for the worktree's Git-diff check.
  for (const response of [
    '```diff\n' + patch + '```\n```diff\n' + patch + '```',
    'Explanation\n```diff\n' + patch,
    'Explanation\n```javascript\n' + patch + '```',
    'I could not produce a patch.',
  ]) {
    content = response;
    assert.ok(!(await propose()).startsWith('diff --git '));
  }
});

test('models selected through a saved credential reference get three minutes for a patch', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'godcode-patch-timeout-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const credential = path.join(dataDir, 'provider.env');
  await writeFile(credential, 'VENICE_API_KEY=synthetic-test-key\n', { mode: 0o600 });
  await writeFile(path.join(dataDir, 'provider-references.json'), JSON.stringify({
    version: 1, profiles: [{ id: 'saved', provider: 'venice', model: 'saved-model',
      credential: { file: credential, keyName: 'VENICE_API_KEY' } }],
  }), { mode: 0o600 });
  const providers = new Map();
  assert.deepEqual(await loadProviderReferences({ dataDir, providers }), { configured: 1, failed: 0 });
  let deadline;
  t.mock.method(AbortSignal, 'timeout', ms => { deadline = ms; return new AbortController().signal; });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message: { content: patch } }] }));
  const selected = providers.get('saved').catalogChoice({ id: 'venice-catalog:stronger', model: 'stronger', label: 'Stronger', limit: 16384 });
  assert.equal(await selected.proposePatch({ objective: 'Rename', files: [], signal: new AbortController().signal }), patch);
  assert.equal(deadline, 180000);
});
