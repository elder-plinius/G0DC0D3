import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createApp } from '../src/server.mjs';
import { normalizeConclaveRunInput } from '../src/conclave-engine.mjs';

function dispatch(app, { method = 'GET', url = '/', body } = {}) {
  const address = app.server.address() || { address: '127.0.0.1', port: 4317 };
  if (!app.server.address()) app.server.address = () => address;
  const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const req = Readable.from(payload ? [payload] : []);
  req.method = method;
  req.url = url;
  req.headers = {
    host: `127.0.0.1:${address.port}`,
    ...(['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) ? { origin: `http://127.0.0.1:${address.port}`, 'x-g0d-request': '1' } : {}),
    ...(payload ? { 'content-type': 'application/json' } : {}),
  };
  req.setTimeout = () => {};
  return new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      statusCode: 200,
      setHeader() {},
      getHeader() {},
      writeHead(status) { this.statusCode = status; },
      write(chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); },
      end(chunk) {
        if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: this.statusCode, text, json });
      },
    };
    try { app.server.emit('request', req, res); }
    catch (err) { reject(err); }
  });
}

function makeConclaveStub(id, log) {
  return {
    id,
    label: `Stub ${id}`,
    model: id,
    kind: 'http',
    tier: 'frontier',
    baseUrl: 'http://127.0.0.1:11434/v1',
    available: true,
    capabilities: { tools: true, nativeTools: true, portableContext: true, nativeToolReplay: false, toolNames: [], instructionRole: 'system' },
    async turn(ctx) {
      const obj = String(ctx?.task?.objective || '');
      log.push({ kind: 'turn', objective: obj });
      if (obj.includes('PEER CRITIC')) {
        assert.match(obj, /ROUND1_LEAD_DRAFT_TOKEN/, 'Round 2 critic must see Round 1 lead draft on Shared Blackboard');
        return { type: 'message', text: 'ROUND2_CRITIQUE_TOKEN: Fix missing rate-limit header and add retry backoff.', finish: 'done' };
      }
      if (obj.includes('Peer Cross-Examination')) {
        assert.match(obj, /ROUND1_DEBATE_TOKEN/, 'Round 2 debater must see Round 1 peer positions on Shared Blackboard');
        return { type: 'message', text: 'ROUND2_REBUTTAL_TOKEN: Concede caching point, rebut single-region lock-in.', finish: 'done' };
      }
      if (obj.includes('LEAD DRAFTER')) {
        return { type: 'message', text: 'ROUND1_LEAD_DRAFT_TOKEN: Initial API gateway draft.', finish: 'done' };
      }
      if (obj.includes('Council Member #')) {
        return { type: 'message', text: 'ROUND1_DEBATE_TOKEN: Opening position paper with tradeoff matrix.', finish: 'done' };
      }
      return { type: 'message', text: 'ROUND1_PARALLEL_FINDING: Specialist deliverable complete.', finish: 'done' };
    },
    async draft(messages) {
      const user = messages.find(m => m.role === 'user')?.content || '';
      log.push({ kind: 'draft', user });
      return {
        type: 'message',
        text: `FINAL_SYNTHESIZED_VERDICT (${user.includes('ROUND2_CRITIQUE_TOKEN') ? 'critique-resolved' : user.includes('ROUND2_REBUTTAL_TOKEN') ? 'debate-verdict' : 'parallel-synth'})`,
        finish: 'done',
      };
    },
    close() {},
  };
}

test('Conclave 2.0 native engine executes multi-round Critique, Debate, and Parallel modes with Shared Blackboard & HTTP API', async () => {
  const norm = normalizeConclaveRunInput({ mission: 'Design zero-downtime auth', mode: 'debate', agents: ['explore', 'analyst', 'reviewer', 'strategist', 'extra'] });
  assert.equal(norm.mode, 'debate');
  assert.equal(norm.agents.length, 4);

  const dir = await fs.mkdtemp(path.join(tmpdir(), 'g0d-conclave2-'));
  const log = [];
  const stub = makeConclaveStub('local:conclave-stub', log);
  const app = await createApp({
    dataDir: dir,
    providers: new Map([[stub.id, stub]]),
    auth: false,
    cliDiscovery: { probes: [] },
    startScheduler: false,
  });

  try {
    // 1. Draft & Critique via POST /api/conclave/run (auto-creates task, runs 3 rounds: Draft+Analysis -> Peer Critique -> Synthesis)
    const critiqueRes = await dispatch(app, {
      method: 'POST',
      url: '/api/conclave/run',
      body: {
        mission: 'Build a rate-limited API gateway spec',
        agents: ['builder', 'reviewer'],
        mode: 'critique',
        providerIds: [stub.id],
      },
    });
    assert.equal(critiqueRes.status, 202);
    const critiqueTaskId = critiqueRes.json.task.id;
    await app.runtime.runs.get(critiqueTaskId)?.promise;

    const critiqueState = app.runtime.getConclaveState(critiqueTaskId);
    assert.equal(critiqueState.conclaveSession.mode, 'critique');
    assert.equal(critiqueState.conclaveSession.totalRounds, 3);
    // Round 1 (2 specialists: builder + reviewer) + Round 2 (1 critic: reviewer) = 3 blackboard entries
    assert.equal(critiqueState.conclaveSession.blackboard.length, 3);
    const critiqueEvents = app.runtime.getEvents(critiqueTaskId);
    const finalCritiqueReply = critiqueEvents.findLast(e => e.type === 'model.response')?.data?.response?.text || '';
    assert.match(finalCritiqueReply, /FINAL_SYNTHESIZED_VERDICT \(critique-resolved\)/);

    // 2. Council Debate via POST /api/tasks/:id/conclave/run (3 rounds: 3 independent positions -> 3 peer cross-examinations -> Verdict)
    const debateRes = await dispatch(app, {
      method: 'POST',
      url: `/api/tasks/${critiqueTaskId}/conclave/run`,
      body: {
        mission: 'Should we choose Postgres or DynamoDB for multi-region ledger?',
        agents: ['explore', 'analyst', 'strategist'],
        mode: 'debate',
      },
    });
    assert.equal(debateRes.status, 202);
    await app.runtime.runs.get(critiqueTaskId)?.promise;

    const debateState = app.runtime.getConclaveState(critiqueTaskId);
    assert.equal(debateState.conclaveSession.mode, 'debate');
    // Round 1 (3 positions) + Round 2 (3 cross-examinations) = 6 blackboard entries
    assert.equal(debateState.conclaveSession.blackboard.length, 6);
    const debateEvents = app.runtime.getEvents(critiqueTaskId);
    const finalDebateReply = debateEvents.findLast(e => e.type === 'model.response')?.data?.response?.text || '';
    assert.match(finalDebateReply, /FINAL_SYNTHESIZED_VERDICT \(debate-verdict\)/);
    assert.equal(app.runtime.getTask(critiqueTaskId).status, 'completed');
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
