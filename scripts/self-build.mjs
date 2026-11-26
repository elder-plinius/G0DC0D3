#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { createApp } from '../src/server.mjs';

const exec = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const git = async (cwd, args) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
const save = async (file, value) => {
  const temporary = file + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temporary, file);
};

export function compareRubrics(before, after, target) {
  const previous = new Set(before.results.filter(result => result.pass).map(result => result.id));
  const current = new Set(after.results.filter(result => result.pass).map(result => result.id));
  const lost = [...previous].filter(id => !current.has(id));
  const gained = [...current].filter(id => !previous.has(id));
  const sameCases = before.results.length === after.results.length &&
    before.results.every(result => after.results.some(next => next.id === result.id));
  return { pass: sameCases && current.has(target) && gained.length > 0 && lost.length === 0, gained, lost, sameCases };
}

async function rubric(cwd) {
  const { stdout } = await exec(process.execPath, ['scripts/desktop-rubric.mjs'], { cwd, timeout: 30000 });
  return JSON.parse(stdout);
}

async function run(options) {
  const source = path.resolve(options.source || process.cwd());
  const directory = path.resolve(options.run);
  const incumbent = path.join(directory, 'incumbent');
  const stateFile = path.join(directory, 'run.json');
  const planFile = path.resolve(options.plan || path.join(source, 'scripts/desktop-improvements.json'));
  const planText = await fs.readFile(planFile, 'utf8');
  const plan = JSON.parse(planText);
  if (!Array.isArray(plan) || !plan.length || plan.some(goal => !goal.id || !goal.objective || !Array.isArray(goal.files) || !goal.files.length))
    throw Error('Provide an improvement plan with id, objective and files for each goal.');
  if (new Set(plan.map(goal => goal.id)).size !== plan.length) throw Error('Goal IDs must be unique.');
  const limit = Number(options.loops || 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error('Choose 1 to 100 loops.');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(directory, 'run.lock');
  try {
    const owner = Number(await fs.readFile(lockPath, 'utf8'));
    try { process.kill(owner, 0); throw Error('This run already has a live owner.'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    await fs.unlink(lockPath);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const lock = await fs.open(lockPath, 'wx', 0o600);
  await lock.writeFile(String(process.pid));
  let app, state;
  const originalFetch = globalThis.fetch;
  try {
    try { state = JSON.parse(await fs.readFile(stateFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!state) {
      if (await git(source, ['status', '--porcelain'])) throw Error('Commit the source checkout before starting a run.');
      await git(source, ['clone', '--quiet', '--no-hardlinks', source, incumbent]);
      const baseline = await rubric(incumbent);
      if (!plan.every(goal => baseline.results.some(result => result.id === goal.id))) throw Error('Every goal needs a rubric case.');
      state = { version: 1, started: new Date().toISOString(), source, base: await git(incumbent, ['rev-parse', 'HEAD']),
        model: options.model || 'claude-opus-5-5', limit, supervised: !!options.supervised,
        planHash: hash(planText), rubricHash: hash(await fs.readFile(path.join(incumbent, 'scripts/desktop-rubric.mjs'))),
        baseline, current: baseline, attempts: [], status: 'running' };
      await save(stateFile, state);
    }
    if (state.planHash !== hash(planText) || state.limit !== limit) throw Error('Resume with the original plan and loop limit.');
    if (options.model && options.model !== state.model) throw Error('Resume with the original model.');
    const dataDir = path.join(directory, 'state');
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    if (options.references) {
      await fs.copyFile(path.resolve(options.references), path.join(dataDir, 'provider-references.json'));
      await fs.chmod(path.join(dataDir, 'provider-references.json'), 0o600);
    }
    globalThis.fetch = async (url, init) => {
      if (url !== 'https://api.venice.ai/api/v1/chat/completions') return originalFetch(url, init);
      const body = JSON.parse(init.body);
      if (body.model !== state.model) throw Error('Unexpected model for this run.');
      const record = { loop: state.attempts.length, model: body.model, started: new Date().toISOString() };
      const started = performance.now();
      try {
        const response = await originalFetch(url, init);
        const result = await response.clone().json().catch(() => null);
        Object.assign(record, { http: response.status, usage: result?.usage, finish: result?.choices?.[0]?.finish_reason });
        return response;
      } catch (error) { record.error = error.message; throw error; }
      finally {
        record.elapsedMs = Math.round(performance.now() - started);
        await fs.appendFile(path.join(directory, 'usage.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 });
      }
    };
    app = await createApp({ dataDir });
    await app.listen(0);
    const endpoint = new URL(app.accessUrl);
    const token = new URLSearchParams(endpoint.hash.slice(1)).get('session');
    const login = await originalFetch(endpoint.origin + '/api/session', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-g0d-request': '1' }, body: JSON.stringify({ token }) });
    if (!login.ok) throw Error('Unable to open the local session.');
    const headers = { cookie: login.headers.get('set-cookie').split(';')[0], 'content-type': 'application/json', 'x-g0d-request': '1' };
    async function api(route, body) {
      const response = await originalFetch(endpoint.origin + route, { method: body === undefined ? 'GET' : 'POST',
        headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(240000) });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || 'Local request failed.');
      return data;
    }
    const catalog = await api('/api/providers/venice-models');
    if (!catalog.models.some(model => model.model === state.model)) throw Error('The selected model is unavailable in the Venice catalog.');
    const previous = state.attempts.at(-1);
    if (previous && !['accepted', 'rejected', 'interrupted'].includes(previous.status)) {
      if (previous.commit) {
        await git(incumbent, ['merge', '--ff-only', previous.commit]);
        previous.status = 'accepted';
        state.current = await rubric(incumbent);
      } else {
        previous.status = 'interrupted';
        previous.reason = 'Run interrupted before promotion. The paid request is not repeated.';
      }
      await save(stateFile, state);
    }
    while (state.attempts.length < state.limit) {
      const candidates = plan.filter(goal => !state.current.results.find(result => result.id === goal.id)?.pass);
      if (!candidates.length) { state.status = 'all-goals-passed'; break; }
      const count = id => state.attempts.filter(attempt => attempt.goal === id).length;
      candidates.sort((a, b) => count(a.id) - count(b.id));
      let guidance = {};
      try { guidance = JSON.parse(await fs.readFile(path.join(directory, 'guidance.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const goal = candidates.find(candidate => candidate.id === guidance.goal) || candidates[0];
      const attempt = { number: state.attempts.length + 1, goal: goal.id, started: new Date().toISOString(), before: state.current, status: 'preparing' };
      state.attempts.push(attempt);
      await save(stateFile, state);
      const log = message => console.log('Loop ' + attempt.number + ' · ' + goal.id + ' · ' + message);
      log('building');
      try {
        const project = await api('/api/worktrees', { repository: incumbent });
        attempt.project = project.id; attempt.root = project.root; attempt.base = project.base;
        const failed = state.current.results.find(result => result.id === goal.id);
        const prior = state.attempts.slice(0, -1).filter(item => item.goal === goal.id).map(item => item.reason).filter(Boolean);
        const objective = [
          goal.objective,
          'Current observed failure: ' + failed.detail,
          'Preserve existing working rendering, limits, accessibility and interfaces. Make a small focused change using existing code. Add no dependencies.',
          'Return exactly one final unified Git diff, beginning with diff --git. Omit drafts and explanation.',
          prior.length ? 'Earlier attempt feedback: ' + prior.join('\n') : '',
          guidance.note ? 'Reviewer direction: ' + String(guidance.note).slice(0, 6000) : '',
        ].filter(Boolean).join('\n\n');
        const request = { objective, files: goal.files, newFiles: [], providerIds: ['venice-catalog:' + state.model], parameters: { max_tokens: 16384 } };
        const prefix = '/api/worktrees/' + project.id;
        const preview = await api(prefix + '/build-preview', request);
        await save(path.join(directory, 'loop-' + attempt.number + '-request.json'), preview);
        attempt.status = 'generating';
        await save(stateFile, state);
        const built = await api(prefix + '/build', { ...request, fingerprint: preview.fingerprint });
        const candidate = built.candidates[0];
        attempt.candidate = candidate.id;
        if (!candidate.patch) throw Error(candidate.error || 'The model returned no usable patch.');
        await fs.writeFile(path.join(directory, 'loop-' + attempt.number + '.patch'), candidate.patch);
        await api(prefix + '/apply', { candidateId: candidate.id });
        if (hash(await fs.readFile(path.join(project.root, 'scripts/desktop-rubric.mjs'))) !== state.rubricHash) throw Error('The rubric changed.');
        const measured = await api(prefix + '/check', { command: 'node scripts/desktop-rubric.mjs', network: false });
        if (measured.exitCode !== 0 || measured.timedOut || measured.cancelled) throw Error('The worktree rubric check did not complete.');
        attempt.after = JSON.parse(measured.stdout);
        attempt.comparison = compareRubrics(state.current, attempt.after, goal.id);
        if (!attempt.comparison.pass) throw Error('Rubric failed: ' + JSON.stringify(attempt.comparison) + '\n' + JSON.stringify(attempt.after.results.filter(result => !result.pass && (result.id === goal.id || attempt.comparison.lost.includes(result.id)))));
        const tests = (await fs.readdir(path.join(project.root, 'test'))).filter(file => file.endsWith('.test.mjs')).map(file => 'test/' + file);
        try {
          const suite = await exec(process.execPath, ['--test', ...tests], { cwd: project.root, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
          await fs.writeFile(path.join(directory, 'loop-' + attempt.number + '-tests.log'), suite.stdout + suite.stderr);
        } catch (error) {
          await fs.writeFile(path.join(directory, 'loop-' + attempt.number + '-tests.log'), (error.stdout || '') + (error.stderr || ''));
          throw Error('Repository tests failed: ' + (error.stdout || error.message).slice(-2000));
        }
        attempt.status = 'awaiting-review';
        await save(stateFile, state);
        log('checks passed; awaiting review');
        if (state.supervised) {
          let decision;
          while (!decision) {
            try {
              const review = JSON.parse(await fs.readFile(path.join(directory, 'review-' + attempt.number + '.json'), 'utf8'));
              if (review.base !== attempt.base || !['accept', 'reject'].includes(review.decision)) throw Error('Review must match the candidate base and contain accept or reject.');
              decision = review;
            } catch (error) { if (error.code !== 'ENOENT') throw error; await pause(1000); }
          }
          attempt.review = decision;
          if (decision.decision === 'reject') throw Error(decision.reason || 'Reviewer rejected the patch.');
        }
        await git(project.root, ['add', '--', ...goal.files]);
        await git(project.root, ['-c', 'user.name=GodCode', '-c', 'user.email=godcode@localhost', 'commit', '-m', 'Improve ' + goal.id]);
        attempt.commit = await git(project.root, ['rev-parse', 'HEAD']);
        attempt.status = 'promoting';
        await save(stateFile, state);
        await git(incumbent, ['merge', '--ff-only', attempt.commit]);
        attempt.status = 'accepted';
        state.current = attempt.after;
        log('accepted · ' + state.current.passed + '/' + state.current.total);
      } catch (error) {
        if (attempt.commit) throw error;
        attempt.status = 'rejected';
        attempt.reason = error.message;
        log('rejected · ' + error.message.slice(0, 180));
      }
      attempt.finished = new Date().toISOString();
      await save(stateFile, state);
    }
    if (state.status === 'running') state.status = 'complete';
    state.finished = new Date().toISOString();
    state.head = await git(incumbent, ['rev-parse', 'HEAD']);
    await save(stateFile, state);
    console.log('Finished · ' + state.attempts.length + ' loops · ' + state.current.passed + '/' + state.current.total);
  } finally {
    if (app) await app.close();
    globalThis.fetch = originalFetch;
    await lock.close();
    await fs.unlink(lockPath);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    source: { type: 'string' }, run: { type: 'string' }, plan: { type: 'string' },
    references: { type: 'string' }, model: { type: 'string' }, loops: { type: 'string' },
    supervised: { type: 'boolean' },
  } });
  if (!values.run) throw Error('Usage: node scripts/self-build.mjs --run <directory> [--references <file>] [--loops 10] [--supervised]');
  await run(values);
}
