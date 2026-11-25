import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { HttpProvider } from '../src/providers.mjs';
import { createVeniceCatalog, veniceEndpoint } from '../src/venice-catalog.mjs';
import { displayOutcomes, taskOutcome } from '../src/outcomes.mjs';

const model = (id, spec = {}) => ({id, type:'text', model_spec:{name:id, maxCompletionTokens:8192, ...spec}});
const base = () => new HttpProvider({id:'saved', label:'Saved connection', model:'saved-model', baseUrl:veniceEndpoint, credential:'test-credential'});

test('one Venice connection discovers text models, shares an in-flight refresh and retains the catalog offline', async () => {
  const providers = new Map([['saved',base()]]);
  let calls = 0;
  const catalog = createVeniceCatalog(providers, async (url, options) => {
    assert.equal(url, veniceEndpoint + '/models?type=text');
    assert.equal(options.redirect, 'error');
    if (++calls > 1) throw new Error('offline');
    return Response.json({data:[...Array.from({length:120}, (_,i) => model('m'+i)), model('m0'), model('offline',{offline:true}), model('sealed',{capabilities:{supportsE2EE:true}}), {...model('image'),type:'image'}]});
  });
  const [a,b] = await Promise.all([catalog.list(),catalog.list()]);
  assert.equal(calls,1);
  assert.equal(a.models.length,120);
  assert.deepEqual(a,b);
  const refreshed = await catalog.list(true);
  assert.equal(refreshed.models.length,120);
  assert.match(refreshed.warning,/last catalog/);
  assert.equal(providers.size,1);
  providers.get('saved').close();
  assert.equal((await catalog.list()).connected,false);
  assert.equal(catalog.get(a.models[0].id),undefined);
});

test('a direct chat keeps its thread and dispatches the selected model after restart', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'godmode-catalog-'));
  let app, seen = [];
  t.after(async () => { await app?.close(); await rm(dir,{recursive:true,force:true}); });
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url !== veniceEndpoint + '/chat/completions') return nativeFetch(url,init);
    const body = JSON.parse(init.body);
    assert.equal(init.headers.authorization, 'Bearer test-credential');
    seen.push(body);
    return Response.json({choices:[seen.length === 1 ? {message:{content:'Blue.'},finish_reason:'stop'} : {message:{refusal:'I decline this example.'},finish_reason:'content_filter'}]});
  });
  async function start() {
    app = await createApp({dataDir:dir, auth:false, providers:new Map([['saved',base()]]), fetchCatalog:async () => Response.json({data:[model('first'),model('second')]})});
    const url = await app.listen(0);
    return async (route, method='GET', body) => {
      const res = await fetch(url+route,{method,headers:{'x-g0d-request':'1','content-type':'application/json'},body:body && JSON.stringify(body)});
      const data = await res.json();
      assert.ok(res.ok, data.error);
      return data;
    };
  }
  let api = await start();
  const {models} = await api('/api/providers/venice-models');
  assert.equal((await api('/api/worktrees')).models.length,3);
  const {task} = await api('/api/conversations','POST',{objective:'Name a color.',providerIds:[models[0].id],policy:{mode:'ask'}});
  await app.runtime.run(task.id);
  await app.close();
  api = await start();
  await api('/api/tasks/'+task.id+'/providers','PATCH',{providerIds:[models[1].id]});
  await app.runtime.submitMessage(task.id,'Repeat that color.','message-two');
  await app.runtime.run(task.id);
  const detail = await api('/api/tasks/'+task.id);
  assert.equal(detail.task.status,'completed');
  assert.equal(detail.task.outcome.kind,'declined');
  assert.equal(detail.task.calls,2);
  assert.equal(detail.task.recoveries,0);
  assert.deepEqual(seen.map(body => body.model),['first','second']);
  assert.deepEqual(seen[1].messages.slice(1).map(m=>m.content),['Name a color.','Blue.','Repeat that color.']);
  assert.deepEqual(detail.events.filter(e=>e.type==='model.response').map(e=>e.data.providerId),models.map(m=>m.id));
  assert.equal(detail.events.find(e=>e.type==='providers.updated').data.providerId,models[1].id);
  assert.equal(detail.events.findLast(e=>e.type==='model.response').data.replyOutcome.source,'provider');
  assert.equal(app.runtime.providers.size,1);
  assert.throws(()=>app.runtime.setProviders(task.id,['saved',models[0].id]),/Venice outage backup/);
});

test('the transcript attaches a recorded decline to the response from that turn only', () => {
  const message = text => ({type:'model.response',data:{response:{type:'message',text,finish:'done'}}});
  const incident = {code:'CONTENT_RESTRICTION', kind:'refusal'};
  const events = [message('First answer'),{type:'model.request'},message('Second answer'),{type:'recovery.started',data:{incident}},
    {type:'model.request'},message('Third answer'),{type:'providers.updated'},{type:'task.status',data:{blocker:incident}}];
  const displayed = displayOutcomes(events);
  assert.equal(displayed[0].data.replyOutcome,null);
  assert.equal(displayed[2].data.replyOutcome.source,'recorded_incident');
  assert.equal(displayed[5].data.replyOutcome,null);
  assert.equal(events[2].data.replyOutcome,undefined);
  const stopped = taskOutcome({status:'blocked',blocker:{code:'RECOVERY_LIMIT',message:'Recovery attempt limit reached.',lastIncident:incident}});
  assert.equal(stopped.kind,'declined');
  assert.match(stopped.detail,/limit reached/);
});

test('an ordinary service outage records a fallback switch before the second model replies', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'godmode-switch-'));
  const providers = new Map([
    ['first', {id:'first',kind:'test',turn:async()=>({type:'error',code:'PROVIDER_ERROR',message:'HTTP 503',retryable:true})}],
    ['second', {id:'second',kind:'test',turn:async()=>({type:'message',text:'Violet.',finish:'done'})}],
  ]);
  const app = await createApp({dataDir:dir,auth:false,providers});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const root = await app.listen(0);
  const res = await fetch(root+'/api/conversations',{method:'POST',headers:{'x-g0d-request':'1','content-type':'application/json'},
    body:JSON.stringify({objective:'Name a flower color.',providerIds:['first','second'],policy:{mode:'switch_model',maxAttempts:2,maxCalls:4}})});
  const {task} = await res.json();
  assert.ok(task);
  await app.runtime.run(task.id);
  const detail = await (await fetch(root+'/api/tasks/'+task.id)).json();
  assert.equal(detail.task.status,'completed');
  const index = detail.events.findIndex(e => e.type==='model.switched' && e.data.from==='first' && e.data.to==='second');
  assert.ok(index>=0);
  assert.ok(detail.events.slice(index+1).some(e=>e.type==='model.response' && e.data.providerId==='second' && e.data.response.text==='Violet.'));
});

test('a provider payment failure names the failing connection in the chat', () => {
  const outcome = taskOutcome({status:'blocked',providerId:'openrouter-coder',blocker:{code:'http_402'}});
  assert.equal(outcome.kind,'billing');
  assert.match(outcome.detail,/openrouter-coder.*HTTP 402/);
});

async function catalogSession(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'godmode-venice-backup-'));
  const app = await createApp({dataDir:dir, auth:false, providers:new Map([['saved',base()]]),
    fetchCatalog:async () => Response.json({data:[model('main'),model('backup')]})});
  t.after(async () => { await app.close(); await rm(dir,{recursive:true,force:true}); });
  const nativeFetch = globalThis.fetch, root = await app.listen(0);
  const ids = (await (await nativeFetch(root+'/api/providers/venice-models')).json()).models.map(m=>m.id);
  const dispatched = [];
  let replies = [], active = 0;
  t.mock.method(globalThis,'fetch',async (url, init) => {
    if (url !== veniceEndpoint + '/chat/completions') return nativeFetch(url,init);
    assert.equal(++active,1);
    try {
      dispatched.push(JSON.parse(init.body).model);
      assert.ok(replies.length,'unexpected model dispatch');
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return typeof reply === 'function' ? await reply(init.signal) : reply;
    } finally { active--; }
  });
  const unavailable = (status,headers={}) => Response.json({error:{message:'Unavailable'}},{status,headers});
  const answer = () => Response.json({choices:[{message:{content:'Violet.'},finish_reason:'stop'}]});
  const decline = () => Response.json({choices:[{message:{refusal:'I decline this example.'},finish_reason:'content_filter'}]});
  function prepare(scenario) {
    replies = scenario;
    dispatched.length = 0;
  }
  async function createTask(policy={}, providers=ids) {
    const create = await nativeFetch(root+'/api/conversations',{method:'POST',headers:{'content-type':'application/json','x-g0d-request':'1'},
      body:JSON.stringify({objective:'Name a flower color.',providerIds:providers,policy:{mode:'adaptive',maxCalls:4,maxAttempts:2,...policy}})});
    assert.equal(create.status,201);
    const {task} = await create.json();
    return task.id;
  }
  const detail = async id => (await nativeFetch(root+'/api/tasks/'+id)).json();
  async function run(scenario, expected, policy={}, providers=ids) {
    prepare(scenario);
    const id = await createTask(policy, providers);
    await app.runtime.run(id);
    assert.deepEqual(dispatched,expected);
    return detail(id);
  }
  return {app, ids, dispatched, root, nativeFetch, unavailable, answer, decline, createTask, prepare, run, detail};
}

test('direct Venice chats recover on outages and GodMode refusals, while mode=ask stops on declines', async t => {
  const {app, ids, dispatched, root, nativeFetch, unavailable, answer, decline, prepare, run} = await catalogSession(t);
  const switched = await run([unavailable(503),answer()],['main','backup']);
  assert.equal(switched.task.status,'completed');
  assert.equal(switched.task.recoveries,1);
  const change = switched.events.find(e=>e.type==='model.switched');
  assert.deepEqual(change.data,{from:ids[0],to:ids[1],reason:'VENICE_SERVICE_OUTAGE'});
  prepare([answer()]);
  await app.runtime.addMessage(switched.task.id,'Name a second flower color.','color-two');
  await app.runtime.run(switched.task.id);
  assert.deepEqual(dispatched,['main']);
  // GodMode ON (mode='adaptive'): refusal on main switches cleanly to backup and succeeds!
  const recoveredDecline = await run([decline(), answer()], ['main', 'backup']);
  assert.equal(recoveredDecline.task.status, 'completed');
  assert.equal(recoveredDecline.task.providerId, ids[1]);
  assert.equal(recoveredDecline.events.find(e => e.type === 'model.switched')?.data?.reason, 'CONTENT_RESTRICTION');
  // Sticky on refusal: follow-up stays on working backup instead of bouncing back to declined main
  prepare([answer()]);
  await app.runtime.addMessage(recoveredDecline.task.id, 'Name another flower.', 'flower-two');
  await app.runtime.run(recoveredDecline.task.id);
  assert.deepEqual(dispatched, ['backup']);
  // GodMode OFF (mode='ask'): refusal stops immediately with zero retries and reports declined outcome
  assert.equal((await run([decline()],['main'],{mode:'ask'})).task.outcome.kind,'declined');
  const indirect = "That request isn’t something I can help with. I can explain the format.";
  const prose = content => Response.json({choices:[{message:{content},finish_reason:'stop'}]});
  const displayed = await run([prose(indirect)],['main'],{mode:'ask'});
  assert.equal(displayed.task.outcome.kind,'declined');
  assert.equal(displayed.events.find(e=>e.type==='model.response').data.replyOutcome.kind,'declined');
  assert.equal(app.runtime.getTask(displayed.task.id).replyOutcome,null);
  const state = await (await nativeFetch(root+'/api/state')).json();
  assert.equal(state.tasks.find(t=>t.id===displayed.task.id).outcome.kind,'declined');
  assert.equal((await run([prose('The example says “' + indirect + '”')],['main'])).task.outcome.kind,'answered');
  assert.equal((await run([unavailable(402)],['main'])).task.outcome.kind,'billing');
  await run([unavailable(502)],['main'],{mode:'ask'});
  await run([unavailable(504)],['main'],{maxCalls:1});
  await run([unavailable(503)],['main'],{},ids.slice(0,1));
  const stopped = await run([unavailable(502),unavailable(504)],['main','backup']);
  assert.equal(stopped.task.status,'waiting_input');
  assert.equal(stopped.events.filter(e=>e.type==='model.switched').length,1);
});

test('direct Venice chats preserve rate-limit deadlines across resume, follow-ups and model selection', async t => {
  const {app, ids, dispatched, unavailable, answer, prepare, run} = await catalogSession(t);
  const limited = await run([unavailable(429,{'retry-after':'90'})],['main']);
  assert.equal(limited.task.outcome.kind,'rate_limit');
  const rateResponse = limited.events.find(e=>e.type==='model.response').data;
  assert.equal(rateResponse.response.httpStatus,429);
  assert.equal(rateResponse.response.retryAfterMs,90000);
  assert.ok(Number.isInteger(rateResponse.durationMs) && rateResponse.durationMs >= 0);
  assert.ok(limited.task.blocker.retryAt > Date.now());
  app.runtime.resume(limited.task.id);
  await app.runtime.run(limited.task.id);
  assert.deepEqual(dispatched,['main']);
  assert.equal(app.runtime.getTask(limited.task.id).calls,1);
  assert.equal(app.runtime.getTask(limited.task.id).blocker.retryAt, limited.task.blocker.retryAt);
  const wait = await run([unavailable(503,{'retry-after':'90'})],['main']);
  assert.equal(wait.task.outcome.kind,'provider_wait');
  const invalidWait = await run([unavailable(503,{'retry-after':'soon'})],['main']);
  assert.equal(invalidWait.task.outcome.kind,'provider_wait');
  assert.equal(invalidWait.task.blocker.retryAt,undefined);
  const deadline = limited.task.blocker.retryAt;
  app.runtime.setProviders(limited.task.id, [ids[1],ids[0]]);
  await app.runtime.addMessage(limited.task.id,'Name another flower color.','another-color');
  await app.runtime.run(limited.task.id);
  assert.equal(app.runtime.getTask(limited.task.id).blocker.retryAt,deadline);
  assert.equal(app.runtime.getTask(limited.task.id).calls,1);
  t.mock.method(Date,'now',()=>deadline + 1);
  const {runtime} = app;
  runtime.resume(limited.task.id);
  // Assign a fresh reply for the first dispatch after Venice's deadline.
  prepare([answer()]);
  await runtime.run(limited.task.id);
  assert.deepEqual(dispatched,['backup']);
  assert.equal(runtime.getTask(limited.task.id).status,'completed');
});

test('direct Venice chats keep truncated replies and distinguish timeout from interruption', async t => {
  const {app, dispatched, prepare, createTask, run, detail} = await catalogSession(t);
  const truncated = content => Response.json({choices:[{message:{content},finish_reason:'length'}]});
  const partial = await run([truncated('Lavender and')],['main'],{autoContinue:false});
  assert.equal(partial.task.status,'waiting_input');
  assert.equal(partial.task.outcome.kind,'partial');
  const partialReceipt = partial.events.find(e=>e.type==='model.response').data;
  assert.equal(partialReceipt.response.text,'Lavender and');
  assert.equal(partialReceipt.response.httpStatus,200);
  assert.equal(partialReceipt.replyOutcome.kind,'partial');
  assert.match(partial.task.outcome.detail,/follow-up/);
  prepare([Response.json({choices:[{message:{content:'violet.'},finish_reason:'stop'}]})]);
  await app.runtime.addMessage(partial.task.id,'Continue the answer.','finish-color');
  await app.runtime.run(partial.task.id);
  const continued = await detail(partial.task.id);
  assert.deepEqual(dispatched,['main']);
  assert.equal(continued.task.outcome.kind,'answered');
  assert.deepEqual(continued.events.filter(e=>e.type==='model.response').map(e=>e.data.response.text),['Lavender and','violet.']);
  const empty = await run([truncated('')],['main'],{maxCalls:1});
  assert.equal(empty.task.outcome.kind,'partial');
  assert.match(empty.task.outcome.detail,/before returning visible text.*call budget/);
  const pending = signal => new Promise((resolve,reject) => signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  const timedOut = await run([pending],['main'],{maxCalls:1,requestTimeoutMs:30});
  assert.equal(timedOut.task.calls,1);
  assert.equal(timedOut.events.find(e=>e.type==='model.response').data.response.code,'PROVIDER_TIMEOUT');
  assert.equal(timedOut.events.some(e=>e.type==='provider.retry'),false);

  for (const action of ['pause','cancel']) {
    const id = await createTask();
    const started = Promise.withResolvers();
    prepare([signal => { started.resolve(); return pending(signal); }]);
    const draining = app.runtime.run(id);
    await started.promise;
    app.runtime[action](id);
    await draining;
    const result = await detail(id);
    const interruptions = result.events.filter(e=>e.type==='model.interrupted');
    assert.deepEqual(dispatched,['main']);
    assert.equal(result.events.some(e=>e.type==='model.response' || e.type==='model.switched'),false);
    assert.equal(interruptions.length,1);
    assert.equal(interruptions[0].data.reason,action === 'pause' ? 'paused' : 'cancelled');
    assert.equal(interruptions[0].data.call,1);
    assert.ok(interruptions[0].data.durationMs >= 0);
  }
});

test('Venice catalog auto-recovers from VENICE_OUTPUT_LIMIT by raising max_tokens and falling back if still exhausted', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'godmode-venice-limit-'));
  const app = await createApp({dataDir:dir, auth:false, providers:new Map([['saved',base()]]),
    fetchCatalog:async () => Response.json({data:[model('thinking-model',{maxCompletionTokens:16384}),model('backup-uncensored',{maxCompletionTokens:16384})]})});
  t.after(async () => { await app.close(); await rm(dir,{recursive:true,force:true}); });
  const nativeFetch = globalThis.fetch, root = await app.listen(0);
  const ids = (await (await nativeFetch(root+'/api/providers/venice-models')).json()).models.map(m=>m.id);
  const seen = [];
  let mode = 'boost';
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url !== veniceEndpoint + '/chat/completions') return nativeFetch(url, init);
    const body = JSON.parse(init.body);
    seen.push({ model: body.model, max_tokens: body.max_tokens });
    if (mode === 'boost' && seen.length === 1) {
      return Response.json({ choices: [{ message: { content: '', reasoning_content: 'Long internal chain of thought...' }, finish_reason: 'length' }] });
    }
    if (mode === 'boost') {
      return Response.json({ choices: [{ message: { content: 'Visible answer after token boost.', reasoning_content: 'Brief thought.' }, finish_reason: 'stop' }] });
    }
    // mode === 'fallback': first model keeps exhausting output limit even after boost -> switch to backup
    if (body.model === 'thinking-model') {
      return Response.json({ choices: [{ message: { content: '', reasoning_content: 'Still thinking...' }, finish_reason: 'length' }] });
    }
    return Response.json({ choices: [{ message: { content: 'Backup uncensored answer.' }, finish_reason: 'stop' }] });
  });
  const createRes = await nativeFetch(root+'/api/conversations', { method:'POST', headers:{'content-type':'application/json','x-g0d-request':'1'},
    body: JSON.stringify({ objective:'Explain thoroughly.', providerIds: ids, policy:{ mode:'adaptive', maxCalls:5, maxAttempts:4 } }) });
  const { task: task1 } = await createRes.json();
  await app.runtime.run(task1.id);
  const d1 = await (await nativeFetch(root+'/api/tasks/'+task1.id)).json();
  assert.equal(d1.task.status, 'completed');
  assert.equal(seen.length, 2);
  assert.equal(seen[0].max_tokens, 5000);
  assert.equal(seen[1].max_tokens, 16384);
  const finalResp1 = d1.events.findLast(e => e.type === 'model.response').data.response;
  assert.equal(finalResp1.text, 'Visible answer after token boost.');
  assert.equal(finalResp1.thinking, 'Brief thought.');

  mode = 'fallback';
  seen.length = 0;
  const createRes2 = await nativeFetch(root+'/api/conversations', { method:'POST', headers:{'content-type':'application/json','x-g0d-request':'1'},
    body: JSON.stringify({ objective:'Explain thoroughly again.', providerIds: ids, policy:{ mode:'adaptive', maxCalls:5, maxAttempts:4 } }) });
  const { task: task2 } = await createRes2.json();
  await app.runtime.run(task2.id);
  const d2 = await (await nativeFetch(root+'/api/tasks/'+task2.id)).json();
  assert.equal(d2.task.status, 'completed');
  assert.deepEqual(seen.map(s => s.model), ['thinking-model', 'thinking-model', 'backup-uncensored']);
  assert.equal(d2.events.findLast(e => e.type === 'model.response').data.response.text, 'Backup uncensored answer.');
});
