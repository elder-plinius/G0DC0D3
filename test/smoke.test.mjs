import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { HttpProvider } from '../src/providers.mjs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server.mjs';

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'godcode-smoke-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function startApp(dataDir, providers = new Map()) {
  const app = await createApp({ dataDir, providers });
  let url;
  try {
    url = await app.listen(0);
  } catch (error) {
    await app.close();
    throw error;
  }
  let cookie;
  async function request(route, body) {
    const headers = cookie ? { cookie } : {};
    if (body === undefined) return fetch(url + route, { headers });
    return fetch(url + route, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', 'x-g0d-request': '1' },
      body: JSON.stringify(body),
    });
  }
  async function signIn() {
    const token = new URLSearchParams(new URL(app.accessUrl).hash.slice(1)).get('session');
    const response = await request('/api/session', { token });
    assert.equal(response.status, 200);
    const session = response.headers.get('set-cookie');
    assert.match(session, /HttpOnly/i);
    cookie = session.split(';')[0];
  }
  async function json(route, body) {
    const response = await request(route, body);
    const value = await response.json();
    assert.ok(response.ok, route + ': ' + (value.error || response.status));
    return value;
  }
  return { app, request, signIn, json, close: () => app.close() };
}

test('launch page and health are public, task reads and writes require a session', async (t) => {
  const directory = await temporaryDirectory(t);
  const client = await startApp(directory);
  try {
    const page = await (await client.request('/')).text();
    assert.match(page, /<title>GODMODƎ<\/title>/);
    for (const [name, wordmark] of [['GodMode', 'GODMODƎ'], ['GodCode', 'GODCODƎ']])
      assert.ok(page.includes('aria-label="' + name + '">' + wordmark + '<'));
    for (const asset of ['lysios-mark-canonical-ink.svg', 'lysios-mark-reverse-white.svg']) {
      const mark = await client.request('/' + asset);
      assert.equal(mark.status, 200);
      assert.match(mark.headers.get('content-type'), /image\/svg\+xml/);
      assert.match(await mark.text(), /LYSIOS pointed mark v2\.0/);
    }
    assert.equal((await client.json('/api/health')).authRequired, true);
    assert.equal((await client.request('/api/state')).status, 401);
    assert.equal((await client.request('/api/tasks', {})).status, 401);
    assert.equal((await client.request('/api/session', { token: 'invalid' })).status, 401);
    await client.signIn();
    assert.deepEqual((await client.json('/api/state')).tasks, []);
  } finally {
    await client.close();
  }
});

// Only model decisions are simulated. All requests, file effects, and receipts are real.
function editingProvider(changes) {
  let called = false;
  return new Map([
    [
      'offline',
      {
        id: 'offline',
        label: 'Offline smoke',
        kind: 'test',
        async turn(context) {
          if (called) return { type: 'message', text: 'Ready for review.', finish: 'done' };
          called = true;
          return {
            type: 'tool',
            calls: changes.map(({ file, content }, i) => ({
              id: 'edit-' + i,
              name: 'repo.write',
              args: {
                path: file,
                content,
                expectedHash: context.files.find((f) => f.path === file)?.sha256 ?? null,
              },
            })),
          };
        },
      },
    ],
  ]);
}

test('project edit, selected-file Apply, restart and Undo through the HTTP app', async (t) => {
  const directory = await temporaryDirectory(t);
  const project = path.join(directory, 'project'),
    data = path.join(directory, 'state');
  await mkdir(project);
  await writeFile(path.join(project, 'one.txt'), 'one\n');
  await writeFile(path.join(project, 'two.txt'), 'two\n');
  const providers = editingProvider([
    { file: 'one.txt', content: 'ONE\n' },
    { file: 'two.txt', content: 'TWO\n' },
  ]);
  let client = await startApp(data, providers);
  try {
    await client.signIn();
    const preview = await client.json('/api/import/preview', { sourcePath: project });
    const { task } = await client.json('/api/tasks', {
      sourcePath: project,
      objective: 'Capitalize the labels.',
      previewHash: preview.snapshotHash,
      providerIds: ['offline'],
      policy: { maxCalls: 3 },
      autoRun: false,
    });
    const route = '/api/tasks/' + task.id;
    await client.json(route + '/run', {});
    await client.app.runtime.runs.get(task.id)?.promise;
    const detail = await client.json(route);
    assert.deepEqual(
      detail.diff.map((file) => file.path),
      ['one.txt', 'two.txt'],
    );
    assert.equal(await readFile(path.join(project, 'one.txt'), 'utf8'), 'one\n');
    const { preview: review } = await client.json(route + '/apply-preview', {});
    const { application } = await client.json(route + '/apply-source', {
      previewId: review.id,
      paths: ['one.txt'],
    });
    assert.equal(application.status, 'applied');
    assert.equal(await readFile(path.join(project, 'one.txt'), 'utf8'), 'ONE\n');
    assert.equal(await readFile(path.join(project, 'two.txt'), 'utf8'), 'two\n');
    await client.close();
    client = await startApp(data, providers);
    await client.signIn();
    const restored = await client.json(route + '/undo-apply', { applicationId: application.id });
    assert.equal(restored.application.status, 'undone');
    assert.equal(await readFile(path.join(project, 'one.txt'), 'utf8'), 'one\n');
  } finally {
    await client.close();
  }
});

function git(directory, ...args) {
  return execFileSync(
    '/usr/bin/git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'user.name=smoke',
      '-c',
      'user.email=smoke@localhost',
      ...args,
    ],
    { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trimEnd();
}

test('two models propose independent patches on the complete Git revision, then one is applied', async (t) => {
  const directory = await temporaryDirectory(t);
  const project = path.join(directory, 'project'),
    data = path.join(directory, 'state');
  await mkdir(project);
  git(project, 'init', '-b', 'main');
  await writeFile(path.join(project, 'large.txt'), 'a'.repeat(2 * 1024 * 1024 + 1));
  await writeFile(path.join(project, 'main.js'), 'export const value = 1;\n');
  git(project, 'add', '.');
  git(project, 'commit', '-m', 'base');
  await writeFile(path.join(project, 'main.js'), 'uncommitted source edit\n');
  const requests = new Map();
  let release;
  const bothArrived = new Promise((resolve) => {
    release = resolve;
  });
  const modelServer = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    requests.set(payload.model, payload);
    if (requests.size === 2) release();
    await bothArrived;
    const patch =
      'diff --git a/main.js b/main.js\n--- a/main.js\n+++ b/main.js\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = ' +
      (payload.model === 'a' ? 2 : 3) +
      ';\n';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: patch } }] }));
  });
  await new Promise((resolve, reject) =>
    modelServer.once('error', reject).listen(0, '127.0.0.1', resolve),
  );
  t.after(() => {
    release();
    return new Promise((resolve) => modelServer.close(resolve));
  });
  const providers = new Map(
    ['a', 'b'].map((id) => [
      id,
      new HttpProvider({
        id,
        model: id,
        baseUrl: 'http://127.0.0.1:' + modelServer.address().port,
        timeoutMs: 2500,
      }),
    ]),
  );
  let client = await startApp(data, providers);
  try {
    await client.signIn();
    const tree = await client.json('/api/worktrees', { repository: project });
    const route = '/api/worktrees/' + tree.id;
    const inspect = await client.json(route);
    assert.deepEqual(inspect.files, ['large.txt', 'main.js']);
    assert.equal(git(tree.root, 'branch', '--show-current'), tree.branch);
    assert.equal(git(project, 'rev-parse', 'HEAD'), tree.base);
    assert.equal((await client.json(route + '/file?path=main.js')).text, 'export const value = 1;\n');
    const input = {
      objective: 'Update the constant.',
      providerIds: ['a', 'b'],
      files: ['main.js'],
      parameters: { temperature: 0, top_p: 0.9, max_tokens: 512 },
    };
    const preview = await client.json(route + '/build-preview', input);
    assert.equal(requests.size, 0);
    await writeFile(path.join(tree.root, 'main.js'), '// File changed since preview.\n');
    assert.equal((await client.request(route + '/build', { ...input, fingerprint: preview.fingerprint })).status, 409);
    assert.equal(requests.size, 0);
    await writeFile(path.join(tree.root, 'main.js'), 'export const value = 1;\n');
    const built = await client.json(route + '/build', { ...input, fingerprint: preview.fingerprint });
    for (const r of preview.requests) assert.deepEqual(r.body, requests.get(r.id));
    assert.equal(built.candidates.length, 2);
    assert.ok(
      built.candidates.every((c) => c.patch),
      JSON.stringify(built.candidates),
    );
    assert.equal(requests.get('a').temperature, 0);
    assert.equal(requests.get('b').top_p, 0.9);
    assert.equal(requests.get('a').max_tokens, 512);
    assert.deepEqual(requests.get('a').messages, requests.get('b').messages);
    await client.close();
    client = await startApp(data);
    await client.signIn();
    assert.equal((await client.json(route)).candidates.length, 2);
    const pick = { candidateId: built.candidates[1].id };
    await writeFile(path.join(tree.root, 'main.js'), 'edited during review\n');
    assert.equal((await client.request(route + '/apply', pick)).status, 409);
    await writeFile(path.join(tree.root, 'main.js'), 'export const value = 1;\n');
    await client.json(route + '/apply', pick);
    await client.json(route + '/apply', pick);
    assert.equal(
      (await client.request(route + '/apply', { candidateId: built.candidates[0].id })).status,
      409,
    );
    assert.equal(await readFile(path.join(tree.root, 'main.js'), 'utf8'), 'export const value = 3;\n');
    assert.equal(await readFile(path.join(project, 'main.js'), 'utf8'), 'uncommitted source edit\n');
    assert.equal(git(project, 'branch', '--show-current'), 'main');
    assert.equal(git(tree.root, 'diff', '--name-only'), 'main.js');
    assert.equal((await client.request(route + '/remove', {})).ok, false);
    git(tree.root, 'add', 'main.js');
    git(tree.root, 'commit', '-m', 'Reviewed change');
    assert.equal((await client.json(route + '/remove', {})).branch, tree.branch);
    assert.equal((await client.json('/api/worktrees')).projects.length, 0);
    assert.equal(git(project, 'show', tree.branch + ':main.js'), 'export const value = 3;');
  } finally {
    await client.close();
  }
});

test('open GodMode in GodCode, review a server edit and check the edited worktree', async (t) => {
  const directory = await temporaryDirectory(t);
  const source = path.join(directory, 'checkout');
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  git(directory, 'clone', '--no-hardlinks', `file://${packageRoot}`, source);
  const marker = '// Reviewed worktree smoke edit.';
  const provider = {
    id: 'review',
    label: 'Offline self-host check',
    protocol: 'openai-chat',
    async proposePatch({ files }) {
      const server = files.find((file) => file.path === 'src/server.mjs');
      assert.ok(server);
      const first = server.content.split('\n')[0];
      return [
        'diff --git a/src/server.mjs b/src/server.mjs',
        '--- a/src/server.mjs',
        '+++ b/src/server.mjs',
        '@@ -1 +1,2 @@',
        '+' + marker,
        ' ' + first,
        '',
      ].join('\n');
    },
  };
  const client = await startApp(path.join(directory, 'state'), new Map([[provider.id, provider]]));
  try {
    await client.signIn();
    const tree = await client.json('/api/worktrees', { repository: source });
    const route = '/api/worktrees/' + tree.id;
    const detail = await client.json(route);
    for (const name of ['src/runtime.mjs', 'src/server.mjs']) {
      assert.ok(detail.files.includes(name));
      assert.equal(
        (await client.json(route + '/file?path=' + name)).text,
        await readFile(path.join(source, name), 'utf8'),
      );
    }
    const reviewed = await client.json(route + '/build', {
      objective: 'Mark the local smoke edit.',
      providerIds: [provider.id],
      files: ['src/server.mjs'],
    });
    assert.ok(reviewed.candidates[0].patch, reviewed.candidates[0].error);
    await client.json(route + '/apply', { candidateId: reviewed.candidates[0].id });
    assert.ok((await readFile(path.join(tree.root, 'src/server.mjs'), 'utf8')).startsWith(marker));
    assert.equal(git(tree.root, 'diff', '--name-only'), 'src/server.mjs');
    execFileSync(process.execPath, ['--check', 'src/server.mjs'], { cwd: tree.root });
    if (process.platform === 'darwin' || process.platform === 'linux') {
      const checked = await client.json(route + '/check', { command: 'node --check src/server.mjs' });
      assert.equal(checked.exitCode, 0, checked.stderr);
    }
    assert.equal(git(source, 'status', '--porcelain'), '');
    assert.equal(git(tree.root, 'rev-parse', 'HEAD'), git(source, 'rev-parse', 'HEAD'));
  } finally {
    await client.close();
  }
});

test('a chat hands its visible plan to GodCode and keeps its reviewed change across restart', async t => {
  const folder = await temporaryDirectory(t), state = path.join(folder, 'state'), repo = path.join(folder, 'labels');
  await mkdir(repo);
  git(repo, 'init', '-b', 'main');
  await writeFile(path.join(repo, 'label.txt'), 'Ready\n');
  git(repo, 'add', 'label.txt');
  git(repo, 'commit', '-m', 'Initial label');
  const sent = [];
  const models = () => new Map(['first', 'second'].map(id => [id, {
    id, kind: 'test', protocol: 'openai-chat', label: id,
    async turn() { return { type: 'message', text: 'Use the label Open studio.', finish: 'done' }; },
    async proposePatch({ conversation, files, objective }) {
      sent.push({ conversation, files, objective });
      return 'diff --git a/label.txt b/label.txt\n--- a/label.txt\n+++ b/label.txt\n@@ -1 +1 @@\n-Ready\n+Open studio\n';
    },
  }]));
  let client = await startApp(state, models());
  try {
    await client.signIn();
    const makeChat = async objective => (await client.json('/api/conversations', { objective, providerIds: ['first'] })).task;
    const chat = await makeChat('Choose a replacement for our Ready label.'), other = await makeChat('Unrelated private discussion.');
    const chatRoute = '/api/tasks/' + chat.id, attach = '/api/conversations/' + chat.id;
    await client.json(chatRoute + '/run', {});
    await client.app.runtime.runs.get(chat.id)?.promise;
    await client.json(attach + '/build-intent', { message: 'Let’s build this!', messageId: 'intent-one' });
    await client.json(attach + '/build-intent', { message: 'Let’s build this!', messageId: 'intent-one' });
    const [project, retry] = await Promise.all([client.json(attach + '/repository', { repository: repo }), client.json(attach + '/repository', { repository: repo })]);
    assert.equal(project.id, retry.id);
    const tree = '/api/worktrees/' + project.id;
    assert.equal((await client.json('/api/worktrees')).projects.length, 1);
    assert.equal((await client.json('/api/tasks/' + other.id)).task.codeWorkspace, undefined);
    const request = {
      objective: 'Use the label we agreed on.', files: ['label.txt'], providerIds: ['first', 'second'],
    };
    const preview = await client.json(tree + '/build-preview', request);
    assert.equal(sent.length, 0);
    const build = await client.json(tree + '/build', { ...request, fingerprint: preview.fingerprint });
    for (const r of preview.requests) assert.deepEqual(JSON.parse(r.body.messages[1].content), sent[0]);
    assert.equal(build.candidates.filter(c => c.patch).length, 2);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0], sent[1]);
    assert.deepEqual(sent[0].conversation.map(x => x.text), [chat.objective, 'Use the label Open studio.', 'Let’s build this!']);
    assert.deepEqual(sent[0].files, [{ path: 'label.txt', content: 'Ready\n' }]);
    await client.json(tree + '/apply', { candidateId: build.candidates[1].id });
    if (process.platform === 'darwin' || process.platform === 'linux') assert.equal((await client.json(tree + '/check', { command: 'grep -qx "Open studio" label.txt' })).exitCode, 0);
    await client.close();
    client = await startApp(state, models());
    await client.signIn();
    const reopened = await client.json(chatRoute), reviewed = await client.json(tree);
    assert.equal(reopened.task.id, chat.id);
    assert.equal(reopened.task.codeWorkspace.id, project.id);
    assert.equal(reviewed.review.applied, build.candidates[1].id);
    assert.equal(reopened.events.filter(e => e.type === 'code.intent').length, 1);
    assert.ok(reopened.events.some(e => e.type === 'code.applied' && e.data.provider === 'second'));
    if (process.platform === 'darwin' || process.platform === 'linux') assert.equal(reviewed.lastCheck.exitCode, 0);
    assert.equal(await readFile(path.join(repo, 'label.txt'), 'utf8'), 'Ready\n');
    assert.equal(await readFile(path.join(project.root, 'label.txt'), 'utf8'), 'Open studio\n');
    await client.json(chatRoute + '/message', { message: 'Thanks, keep this plan here.', messageId: 'after-build' });
    await client.app.runtime.runs.get(chat.id)?.promise;
    assert.equal((await client.json(chatRoute)).task.followups.at(-1).message, 'Thanks, keep this plan here.');
    assert.equal((await client.json('/api/state')).tasks.length, 2);
  } finally { await client.close(); }
});

test('review a finished candidate while another runs, then create and check two named files', async t => {
  const directory = await temporaryDirectory(t);
  const source = path.join(directory, 'source');
  await mkdir(source);
  git(source, 'init', '-b', 'main');
  git(source, 'commit', '--allow-empty', '-m', 'Initial commit');
  const files = {
    'src/label.mjs': 'export const label = name => "Preview of " + name;',
    'test/label.test.mjs': 'import assert from "node:assert/strict";\nimport { label } from "../src/label.mjs";\nassert.equal(label("map.html"), "Preview of map.html");',
  };
  const newFiles = Object.keys(files);
  const patch = Object.entries(files).map(([name, content]) => {
    const lines = content.split('\n');
    return ['diff --git a/' + name + ' b/' + name, 'new file mode 100644', '--- /dev/null', '+++ b/' + name,
      '@@ -0,0 +1,' + lines.length + ' @@', ...lines.map(line => '+' + line), ''].join('\n');
  }).join('');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const providers = new Map(['slow', 'fast'].map(id => [id, {
    id, protocol: 'openai-chat', async proposePatch(input) {
      assert.deepEqual(input.newFiles, newFiles);
      if (id === 'slow') {
        await Promise.race([gate, new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }))]);
        input.signal.throwIfAborted();
        throw new Error('Model unavailable.');
      }
      return patch;
    },
  }]));
  const client = await startApp(path.join(directory, 'state'), providers);
  try {
    await client.signIn();
    const tree = await client.json('/api/worktrees', { repository: source });
    const route = '/api/worktrees/' + tree.id;
    const input = { objective: 'Create a preview label helper and its test.', newFiles, providerIds: ['slow', 'fast'] };
    const preview = await client.json(route + '/build-preview', input);
    assert.deepEqual(JSON.parse(preview.requests[0].body.messages[1].content).newFiles, newFiles);
    const finished = client.json(route + '/build', { ...input, fingerprint: preview.fingerprint });
    try {
      let progress;
      for (let i = 0; i < 150; i++) {
        progress = await client.json(route + '/progress');
        if (progress.candidates.some(c => c.patch)) break;
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      assert.equal(progress.building, true);
      assert.equal(progress.candidates[1].patch, patch);
      assert.equal(progress.candidates[0].patch, undefined);
      assert.deepEqual(await client.json(route + '/progress?after=' + encodeURIComponent(progress.revision)), { revision: progress.revision, building: true });
      assert.equal((await client.request(route + '/stop-waiting', { buildId: 'earlier-build' })).status, 409);
      assert.deepEqual(await client.json(route + '/stop-waiting', { buildId: progress.review.buildId }), { stopping: true });
    } finally { release(); }
    const built = await finished;
    assert.match(built.candidates[0].error, /Stopped waiting/);
    assert.deepEqual(built.candidates[1].paths, newFiles);
    const pick = { candidateId: built.candidates[1].id };
    await mkdir(path.join(tree.root, 'test'));
    const testFile = path.join(tree.root, newFiles[1]);
    await writeFile(testFile, 'An existing user file.');
    assert.equal((await client.request(route + '/apply', pick)).status, 409);
    assert.equal(await readFile(testFile, 'utf8'), 'An existing user file.');
    await assert.rejects(readFile(path.join(tree.root, newFiles[0])), { code: 'ENOENT' });
    await rm(testFile);
    await client.json(route + '/apply', pick);
    assert.deepEqual((await client.json(route)).files.sort(), newFiles);
    assert.equal((await client.json(route + '/file?path=src/label.mjs')).text.trim(), files[newFiles[0]]);
    if (process.platform === 'darwin' || process.platform === 'linux') {
      const result = await client.json(route + '/check', { command: 'node --test test/label.test.mjs' });
      assert.equal(result.exitCode, 0, result.stderr);
    }
    assert.equal(git(source, 'status', '--porcelain'), '');
  } finally { release(); await client.close(); }
});
