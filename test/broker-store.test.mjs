import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { Broker, sha256 } from '../src/broker.mjs';
import { gitInit, gitAutoCommit, gitDiff, gitLog, gitCommit, hasGit } from '../src/git.mjs';

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g0dc0d3-broker-test-'));
  try { return await fn(dir); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test('Store enforces single-owner lock and recovers stale dead-PID lock', async () => {
  await withTempDir(async dir => {
    const store1 = new Store(dir);
    try {
      assert.throws(() => new Store(dir), err => err.code === 'STORE_LOCKED');
    } finally { store1.close(); }

    // Write a stale lock for a guaranteed-dead PID (99999999)
    await fs.writeFile(path.join(dir, 'owner.lock'), JSON.stringify({ pid: 99999999, token: 'stale-token', createdAt: new Date().toISOString() }), { mode: 0o600 });
    const store2 = new Store(dir);
    try {
      const lock = JSON.parse(await fs.readFile(path.join(dir, 'owner.lock'), 'utf8'));
      assert.equal(lock.pid, process.pid);
      assert.notEqual(lock.token, 'stale-token');
    } finally { store2.close(); }
  });
});

test('Broker supports repo.patch, repo.search, paginated repo.read, and UTF-8 validation', async () => {
  await withTempDir(async dir => {
    const ws = path.join(dir, 'ws');
    await fs.mkdir(ws, { recursive: true });
    await fs.writeFile(path.join(ws, 'app.js'), 'const alpha = 1;\nconst beta = 2;\n');
    await fs.writeFile(path.join(ws, 'bin.dat'), Buffer.from([0x00, 0xff, 0xfe]));
    const store = new Store(path.join(dir, 'state'));
    try {
      const task = store.createTask({
        id: 'task-1', title: 'Broker ops', objective: 'Test tools', constraints: [],
        workspace: await fs.realpath(ws), status: 'running', providers: ['p'], providerId: 'p', providerIndex: 0,
        epoch: 1, step: 0, calls: 0, recoveries: 0, policy: {}, strategy: 'continue',
        version: 1, eventSeq: 0, execution: { enabled: false, network: false, timeoutMs: 30000 }, checks: []
      });
      const broker = new Broker({ store });

      const read1 = await broker.execute(task.id, { id: 'r1', name: 'repo.read', args: { path: 'app.js', offset: 0, limit: 10 } }, { epoch: 1 });
      assert.equal(read1.ok, true);
      assert.equal(read1.content, 'const alph');
      assert.equal(read1.truncated, true);
      assert.equal(read1.nextOffset, 10);

      const readBin = await broker.execute(task.id, { id: 'rbin', name: 'repo.read', args: { path: 'bin.dat' } }, { epoch: 1 });
      assert.equal(readBin.ok, false);
      assert.equal(readBin.error.code, 'READ_LIMIT');

      const search = await broker.execute(task.id, { id: 's1', name: 'repo.search', args: { query: 'beta' } }, { epoch: 1 });
      assert.equal(search.ok, true);
      assert.equal(search.matches.length, 1);
      assert.equal(search.matches[0].line, 2);

      const patch = await broker.execute(task.id, {
        id: 'p1', name: 'repo.patch',
        args: { path: 'app.js', oldText: 'const beta = 2;', newText: 'const beta = 42;', expectedHash: read1.sha256 }
      }, { epoch: 1 });
      assert.equal(patch.ok, true);
      assert.equal(await fs.readFile(path.join(ws, 'app.js'), 'utf8'), 'const alpha = 1;\nconst beta = 42;\n');

      // Ambiguous patch fails cleanly
      await fs.writeFile(path.join(ws, 'dup.js'), 'foo\nfoo\n');
      const dupHash = sha256('foo\nfoo\n');
      const ambig = await broker.execute(task.id, {
        id: 'p2', name: 'repo.patch',
        args: { path: 'dup.js', oldText: 'foo', newText: 'bar', expectedHash: dupHash }
      }, { epoch: 1 });
      assert.equal(ambig.ok, false);
      assert.equal(ambig.error.code, 'PATCH_AMBIGUOUS');
    } finally { store.close(); }
  });
});

test('git helpers never escape a non-git workspace into an ancestor git repository', async () => {
  await withTempDir(async dir => {
    const parentRepo = path.join(dir, 'parent');
    const nestedWorkspace = path.join(parentRepo, 'nested-ws');
    await fs.mkdir(nestedWorkspace, { recursive: true });
    await fs.writeFile(path.join(parentRepo, 'root.txt'), 'root\n');
    await gitInit(parentRepo);
    const initialParentLog = await gitLog(parentRepo);

    // Modify file inside nestedWorkspace which has NO .git of its own
    await fs.writeFile(path.join(nestedWorkspace, 'child.txt'), 'child\n');
    assert.equal(await hasGit(nestedWorkspace), false);
    assert.equal(await gitAutoCommit(nestedWorkspace, 'should not commit to parent'), false);
    assert.equal(await gitDiff(nestedWorkspace), '');
    assert.equal(await gitLog(nestedWorkspace), '');
    const commitRes = await gitCommit(nestedWorkspace, { message: 'nope' });
    assert.equal(commitRes.committed, false);

    // Parent repo commit log must remain untouched
    assert.equal(await gitLog(parentRepo), initialParentLog);

    // Now initialize git directly in nestedWorkspace and verify normal operation
    await gitInit(nestedWorkspace);
    assert.equal(await hasGit(nestedWorkspace), true);
    await fs.writeFile(path.join(nestedWorkspace, 'child.txt'), 'child-v2\n');
    assert.ok((await gitDiff(nestedWorkspace)).includes('child-v2'));
    assert.equal(await gitAutoCommit(nestedWorkspace, 'turn 1'), true);
    assert.ok((await gitLog(nestedWorkspace)).includes('turn 1'));
    assert.equal(await gitLog(parentRepo), initialParentLog);
  });
});
