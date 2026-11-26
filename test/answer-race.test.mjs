import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createApp} from '../src/server.mjs';
import {catalogMessages, HttpProvider} from '../src/providers.mjs';
import {veniceEndpoint} from '../src/venice-catalog.mjs';

const models=['swift','careful','editor'], id=m=>'venice-catalog:'+m;
const config={models:models.slice(0,2).map(id),judge:id('editor')};
const response=(text,finish='stop')=>Response.json({choices:[{message:{content:text},finish_reason:finish}]});
async function harness(t) {
  const dir=await mkdtemp(path.join(tmpdir(),'godmode-answer-race-'));
  const providers=new Map([['venice',new HttpProvider({id:'venice',model:'swift',baseUrl:veniceEndpoint,credential:'test-key'})]]);
  const app=await createApp({dataDir:dir,auth:false,providers,fetchCatalog:async()=>Response.json({data:models.map(model=>({id:model,type:'text',model_spec:{name:model,maxCompletionTokens:4000}}))})});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const root=await app.listen(0), native=globalThis.fetch;
  const api=async(route,method='GET',body)=>{
    const res=await native(root+route,{method,headers:{'content-type':'application/json','x-g0d-request':'1'},body:body && JSON.stringify(body)});
    return {status:res.status,...await res.json()};
  };
  async function create(maxCalls=6,race=config) {
    return api('/api/conversations','POST',{objective:'Suggest a short label for a saved draft.',providerIds:[id('swift')],answerRace:race,policy:{maxCalls}});
  }
  function intercept(handler) {
    t.mock.method(globalThis,'fetch',(url,init)=>url===veniceEndpoint+'/chat/completions' ? handler(JSON.parse(init.body),init.signal) : native(url,init));
  }
  return {app,api,create,intercept};
}
test('the blind judge publishes one answer after concurrent writers, keeping the thread and the full call count',async t=>{
  const {app,api,create,intercept}=await harness(t);
  const {task}=await create();
  app.runtime.updateGeneration(task.id,{temperature:0.42,max_tokens:3000});
  const replies=['Saved.','Draft saved.'];
  const dispatch=[],started=Promise.withResolvers(); let active=0,peak=0,round=1;
  intercept(async body=>{
    dispatch.push(body.model);
    assert.equal(body.tools,undefined);
    if(body.model!=='editor'){
      assert.equal(body.temperature,0.42);
      assert.equal(body.max_tokens,2000,'writer settings retain the race output bound');
      if(round===2) assert.deepEqual(body.messages.slice(1).map(m=>m.content),[task.objective,replies[1],'Try once more.']);
      active++;peak=Math.max(active,peak);
      if(active===2)started.resolve();
      await started.promise;
      active--;
      return response(replies[models.indexOf(body.model)]);
    }
    const doc=JSON.parse(body.messages[1].content);
    assert.equal(body.temperature,undefined,'the judge keeps separate generation settings');
    assert.deepEqual(Object.keys(doc.drafts[0]).sort(),['id','text']);
    const grades=doc.drafts.map(d=>({id:d.id,fidelity:5,clarity:5,completeness:d.text===replies[1]?5:2,reason:'Identifies the saved item.'}));
    return response(JSON.stringify({winner:grades.find(g=>g.completeness===5).id,grades}));
  });
  await app.runtime.run(task.id);
  let detail=await api('/api/tasks/'+task.id);
  assert.equal(peak,2);
  assert.deepEqual(dispatch,['swift','careful','editor']);
  assert.equal(detail.task.status,'completed');assert.equal(detail.task.calls,3);
  const answers=detail.events.filter(e=>e.type==='model.response');
  assert.equal(answers.length,1);assert.equal(answers[0].data.response.text,replies[1]);
  assert.equal(answers[0].data.scorecard.winnerId,id('careful'));assert.equal(answers[0].data.scorecard.grades.length,2);
  round=2;await app.runtime.addMessage(task.id,'Try once more.','again');await app.runtime.run(task.id);
  detail=await api('/api/tasks/'+task.id);assert.equal(detail.task.calls,6);assert.equal(detail.task.status,'completed');
  assert.equal((await api('/api/tasks/'+task.id+'/answer-race','PATCH',{answerRace:null})).task.answerRace,null);
});
test('a race respects budgets, interrupted turns, provider waits and a missing verdict',async t=>{
  const {app,api,create,intercept}=await harness(t);
  assert.equal((await create(6,{...config,models:[id('swift'),id('swift')]})).status,400);
  let scenario='budget',dispatch=[];
  const started=Promise.withResolvers(), bothStarted=Promise.withResolvers(), release=Promise.withResolvers();
  intercept(async(body,signal)=>{
    dispatch.push(body.model);
    if(scenario==='cancel'){
      if(dispatch.length===2) bothStarted.resolve();
      await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
    }
    if(scenario==='supersede' && dispatch.length<=2){started.resolve();await release.promise;}
    if(body.model==='editor' && scenario==='tie') return response(JSON.stringify({winner:'B',grades:[
      {id:'A',fidelity:5,completeness:4,clarity:4,reason:'Closer to the requested facts.'},
      {id:'B',fidelity:4,completeness:4,clarity:5,reason:'Clearer wording.'}
    ]}));
    if(body.model==='editor')return response('No scorecard.');
    if(scenario==='billing' && body.model==='careful')return Response.json({}, {status:402});
    if(scenario==='decline' && body.model==='swift')return response('', 'content_filter');
    if(scenario==='rate' && body.model==='swift')return Response.json({}, {status:429,headers:{'retry-after':'90'}});
    return response('Your draft is saved.');
  });
  for (const item of [['budget',2,'paused_budget',0],['decline',3,'completed',2],['rate',6,'completed',2],['judge',3,'waiting_input',3],['tie',3,'waiting_input',3],['billing',3,'completed',2]]) {
    scenario=item[0];dispatch=[];const {task}=await create(item[1]);await app.runtime.run(task.id);
    const detail=await api('/api/tasks/'+task.id);
    assert.equal(detail.task.status,item[2]);assert.equal(dispatch.length,item[3]);assert.equal(detail.task.calls,item[3]);
    assert.equal(detail.events.some(e=>e.type==='model.response'),['decline','rate','billing'].includes(scenario));
    if(scenario==='rate'){await app.runtime.addMessage(task.id,'Try again.','rate-followup');await app.runtime.run(task.id);assert.equal(dispatch.length,2);assert.ok(app.runtime.getTask(task.id).blocker.retryAt>Date.now());}
    if(scenario==='decline')assert.equal(detail.events.find(e=>e.type==='model.response').data.scorecard.status,'single_completion');
    if(scenario==='tie')assert.equal(detail.task.blocker.code,'RACE_UNGRADED');
    if(scenario==='billing')assert.equal(detail.events.find(e=>e.type==='model.response').data.scorecard.judgeId,null);
  }
  scenario='supersede';dispatch=[];const queued=(await create(5)).task;
  const running=app.runtime.run(queued.id);await started.promise;
  await app.runtime.submitMessage(queued.id,'Make it shorter.','shorten');release.resolve();await running;
  assert.deepEqual(dispatch,['swift','careful','swift','careful','editor']);
  scenario='cancel';dispatch=[];const pending=(await create()).task;
  const draining=app.runtime.run(pending.id);await bothStarted.promise;app.runtime.cancel(pending.id);await draining;
  const cancelled=await api('/api/tasks/'+pending.id);assert.equal(cancelled.task.status,'cancelled');
  assert.equal(cancelled.events.filter(e=>e.type==='race.result' && e.data.status==='interrupted').length,2);
  assert.equal(dispatch.length,2);
});

test('a Venice follow-up receives scoped worktree facts in conversation order', () => {
  const branch = 'godcode/test';
  const time = i => new Date(1000 * i).toISOString();
  const task = { objective: 'Name the preview.', followups: [{message:'What happened?', appliedAt:time(6)}] };
  const history = [
    {time:time(1), type:'code.intent', data:{message:'Let’s build this.'}},
    {time:time(2), type:'code.applied', data:{branch, provider:'Writer', files:['label.js']}},
    {time:time(3), type:'code.checked', data:{branch, exitCode:1, command:'private invocation', stdout:'private output'}},
    {time:time(4), type:'code.checked', data:{branch, exitCode:null, timedOut:true, cancelled:false}},
    {time:time(5), type:'code.removed', data:{branch}},
  ];
  const turns = catalogMessages({task, history}).slice(1);
  assert.deepEqual(turns.map(turn => turn.role), ['user','user','assistant','assistant','assistant','assistant','user']);
  const records = turns.slice(2, 6).map(t => JSON.parse(t.content.slice('GodCode worktree record '.length)));
  assert.deepEqual(records, [
    {event:'patch applied', provider:'Writer', files:['label.js'], branch},
    {event:'worktree check', exitCode:1, timedOut:false, cancelled:false, branch},
    {event:'worktree check', exitCode:null, timedOut:true, cancelled:false, branch},
    {event:'worktree removed', branch},
  ]);
  assert.equal(turns.at(-1).content, 'What happened?');
});

 test('a writer output limit preserves the complete answer and drains a queued follow-up', async t=>{
  const {app,api,create,intercept}=await harness(t);
  const {task}=await create(6);
  const started=Promise.withResolvers(),release=Promise.withResolvers();
  let calls=0;
  intercept(async body=>{
    calls++;
    if(calls<=2){started.resolve();await release.promise;}
    assert.notEqual(body.model,'editor','a single completion is never presented as judged');
    return body.model==='careful' ? response('', 'length') : response('Complete answer.');
  });
  const running=app.runtime.run(task.id);await started.promise;
  await app.runtime.submitMessage(task.id,'Reply again.','queued-regression','queue');
  release.resolve();await running;
  const detail=await api('/api/tasks/'+task.id);
  assert.equal(detail.task.status,'completed');
  assert.equal(detail.task.calls,4);
  assert.equal(detail.task.deferredMessages.length,0);
  const answers=detail.events.filter(e=>e.type==='model.response');
  assert.equal(answers.length,2);
  assert.ok(answers.every(e=>e.data.response.text==='Complete answer.' && e.data.scorecard.status==='single_completion'));
  assert.ok(answers[0].data.scorecard.outcomes.some(outcome=>outcome.status==='VENICE_OUTPUT_LIMIT'));
});
