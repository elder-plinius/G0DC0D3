import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { HttpProvider, catalogMessages } from '../src/providers.mjs';
import { modelParameters, parametersFor } from '../src/conversation-controls.mjs';
import { veniceEndpoint } from '../src/venice-catalog.mjs';

const answer = text => Response.json({ choices: [{ message: { content: text }, finish_reason: 'stop' }] });
async function until(predicate) {
  for (let i=0; i<200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Condition did not become true');
}
async function fixture(t, handler = body => answer('Reply to ' + body.messages.at(-1).content)) {
  const directory = await mkdtemp(path.join(tmpdir(), 'godmode-controls-'));
  const realFetch = globalThis.fetch, requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url !== veniceEndpoint + '/chat/completions') return realFetch(url, init);
    const body = JSON.parse(init.body); requests.push(body);
    return handler(body, init.signal);
  });
  let app;
  async function start() {
    app = await createApp({ dataDir: directory, auth:false,
      providers:new Map([['saved',new HttpProvider({id:'saved',baseUrl:veniceEndpoint,model:'example',credential:'fixture-key',maxOutputTokens:1000,maxOutputTokensCeiling:8192})]]),
      fetchCatalog:async () => Response.json({data:[{id:'example',type:'text',model_spec:{maxCompletionTokens:8192}}]}) });
    const url = await app.listen(0);
    await app.catalog?.list?.();
    const api = async (route, method='GET', body, expected=200) => {
      const res = await fetch(url+route,{method,headers:{'x-g0d-request':'1','content-type':'application/json'},body:body === undefined ? undefined : JSON.stringify(body)});
      const result = await res.json(); assert.equal(res.status,expected,JSON.stringify(result)); return result;
    };
    await api('/api/providers/venice-models');
    return {app,api};
  }
  t.after(async () => { await app?.close(); await rm(directory,{recursive:true,force:true}); });
  const current = await start();
  const script = await current.api('/api/health');
  assert.equal(script.authRequired,false);
  const asset = await fetch(new URL('/conversation-controls.js', current.app.accessUrl));
  assert.equal(asset.status,200,'Conversation controls script is served');
  assert.match(asset.headers.get('content-type'),/javascript/);
  const chat = (await current.api('/api/conversations','POST',{objective:'Name a color.',providerIds:['venice-catalog:example']},201)).task;
  return {...current,chat,requests,start};
}

test('queued turns finish the current reply, support editing/reordering, and execute one at a time', async t => {
  const releases=[];
  const {app,api,chat,requests}=await fixture(t,(body,signal)=>new Promise((resolve,reject)=>{
    releases.push(()=>resolve(answer('Answer '+body.messages.at(-1).content)));
    signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  }));
  const route='/api/tasks/'+chat.id;
  const run=app.runtime.run(chat.id); await until(()=>releases.length===1);
  await api(route+'/message','POST',{message:'First follow-up',messageId:'a',mode:'queue'},202);
  await api(route+'/message','POST',{message:'Second follow-up',messageId:'b',mode:'queue'},202);
  await api(route+'/message','PATCH',{messageId:'b',expectedMessage:'Second follow-up',message:'Edited follow-up',direction:-1});
  assert.equal(requests.length,1);
  releases[0](); await until(()=>releases.length===2);
  assert.deepEqual(requests[1].messages.slice(1).map(m=>m.content),['Name a color.','Answer Name a color.','Edited follow-up']);
  releases[1](); await until(()=>releases.length===3);
  assert.equal(requests[2].messages.at(-1).content,'First follow-up');
  releases[2](); await run;
  const final=(await api(route)).task;
  assert.deepEqual(final.followups.map(m=>m.id),['b','a']);
  assert.deepEqual(final.deferredMessages,[]);
  assert.equal(final.status,'completed');
  assert.equal(app.runtime.getEvents(chat.id).filter(e=>e.type==='model.response'&&!e.data.superseded).length,3);
});

test('steering supersedes a response while queued next-turn messages remain separate', async t => {
  const releases=[];
  const {app,api,chat,requests}=await fixture(t,(body,signal)=>new Promise((resolve,reject)=>{
    releases.push(()=>resolve(answer('Old direction'))); signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  }));
  const route='/api/tasks/'+chat.id, run=app.runtime.run(chat.id);
  await until(()=>releases.length===1);
  await api(route+'/message','POST',{message:'Use green.',messageId:'steer',mode:'steer'},202);
  await api(route+'/message','POST',{message:'Then explain.',messageId:'later',mode:'queue'},202);
  releases[0](); await until(()=>releases.length===2);
  assert.deepEqual(requests[1].messages.slice(1).map(m=>m.content),['Name a color.','Use green.']);
  releases[1](); await until(()=>releases.length===3);
  assert.equal(requests[2].messages.at(-1).content,'Then explain.'); releases[2](); await run;
  assert.equal(app.runtime.getEvents(chat.id).find(e=>e.type==='model.response').data.superseded,true);
});

test('a queue survives pause and process restart; stale edits and duplicate sends cannot overwrite it', async t => {
  let first=true;
  const f=await fixture(t,(body,signal)=> first ? new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})) : answer('Resumed'));
  const route='/api/tasks/'+f.chat.id, run=f.app.runtime.run(f.chat.id);
  await until(()=>f.requests.length===1);
  await f.api(route+'/message','POST',{message:'Keep this.',messageId:'durable',mode:'queue'},202);
  const duplicate=await f.api(route+'/message','POST',{message:'Keep this.',messageId:'durable',mode:'queue'},202);
  assert.equal(duplicate.duplicate,true);
  assert.throws(()=>f.app.runtime.updateQueuedMessage(f.chat.id,{messageId:'durable',expectedMessage:'Stale',message:'Overwrite'}),{code:'MESSAGE_STALE'});
  f.app.runtime.pause(f.chat.id); await run; await f.app.close(); first=false;
  const {app,api}=await f.start();
  assert.equal((await api(route)).task.deferredMessages[0].message,'Keep this.');
  app.runtime.resume(f.chat.id); await app.runtime.run(f.chat.id);
  assert.equal(app.runtime.getTask(f.chat.id).followups.at(-1).message,'Keep this.');
});

test('editing and rewinding remove later context, keep the audit history and leave files unchanged', async t => {
  const f=await fixture(t); const {app,api,chat,requests}=f, route='/api/tasks/'+chat.id;
  await app.runtime.run(chat.id);
  await app.runtime.submitMessage(chat.id,'Keep this earlier turn.','early'); await app.runtime.run(chat.id);
  await app.runtime.submitMessage(chat.id,'Secret future instruction.','future'); await app.runtime.run(chat.id);
  await writeFile(path.join(chat.workspace,'note.txt'),'Keep this file');
  await api(route+'/rewind','POST',{messageId:'early',message:'Edited earlier turn.',revision:0});
  assert.equal(app.runtime.getTask(chat.id).status,'paused');
  app.runtime.resume(chat.id); await app.runtime.run(chat.id);
  const sent=JSON.stringify(requests.at(-1));
  assert.ok(sent.includes('Edited earlier turn.'));
  assert.ok(!sent.includes('Secret future instruction.'));
  assert.ok(!sent.includes('Keep this earlier turn.'));
  assert.ok(app.runtime.getEvents(chat.id).some(e=>e.data.message==='Secret future instruction.'));
  assert.equal(await readFile(path.join(chat.workspace,'note.txt'),'utf8'),'Keep this file');
  assert.throws(()=>app.runtime.rewindConversation(chat.id,{messageId:'early',message:'Stale edit',revision:0}),{code:'MESSAGE_STALE'});
  await api(route+'/rewind','POST',{messageId:'early',message:'Another edit.',revision:1});
  app.runtime.resume(chat.id); await app.runtime.run(chat.id);
  assert.equal(requests.at(-1).messages.at(-1).content,'Another edit.');
  await api(route+'/rewind','POST',{messageId:'objective',message:'New root prompt.',revision:2});
  app.runtime.resume(chat.id); await app.runtime.run(chat.id);
  assert.deepEqual(requests.at(-1).messages.slice(1).map(m=>m.content),['New root prompt.']);
});

test('model controls persist through restart and reach the actual HTTP payload without altering the system prompt', async t => {
  const f=await fixture(t); const route='/api/tasks/'+f.chat.id;
  const generation={temperature:.4,top_p:.8,max_tokens:512,seed:42,frequency_penalty:.1,presence_penalty:.2,top_k:40,min_p:.05};
  await f.api(route+'/generation','PATCH',generation);
  await f.app.runtime.run(f.chat.id);
  for(const [key,value] of Object.entries(generation))assert.equal(f.requests.at(-1)[key],value);
  const system=f.requests.at(-1).messages[0];
  await f.app.close(); const {app,api}=await f.start();
  assert.deepEqual((await api(route)).task.generation,generation);
  await api(route+'/generation','PATCH',{});
  await app.runtime.submitMessage(f.chat.id,'Again.','again');await app.runtime.run(f.chat.id);
  assert.deepEqual(f.requests.at(-1).messages[0],system);
  assert.equal(f.requests.at(-1).temperature,undefined);
  assert.equal(f.requests.at(-1).max_tokens,1000);
});

test('invalid or unsupported hyperparameters are rejected before a provider call', () => {
  for(const bad of [{temperature:3},{seed:1.5},{top_p:NaN},{unknown:1},{max_tokens:0},{top_k:-1},{min_p:1.1}])assert.throws(()=>modelParameters(bad));
  assert.deepEqual(parametersFor({protocol:'anthropic'},{temperature:.5,top_p:.9,max_tokens:2048}),{temperature:.5,top_p:.9,max_tokens:2048});
  assert.throws(()=>parametersFor({protocol:'anthropic'},{temperature:1.5}),{code:'INVALID_PARAMETERS'});
  assert.throws(()=>parametersFor({protocol:'anthropic'},{seed:42}),{code:'UNSUPPORTED_PARAMETERS'});
  assert.deepEqual(parametersFor({protocol:'openai-responses'},{temperature:.7,top_p:.95,max_tokens:4096}),{temperature:.7,top_p:.95,max_tokens:4096});
  assert.throws(()=>parametersFor({protocol:'openai-responses'},{frequency_penalty:.5}),{code:'UNSUPPORTED_PARAMETERS'});
  assert.throws(()=>parametersFor({kind:'codex'},{temperature:.5}),{code:'UNSUPPORTED_PARAMETERS'});
  assert.throws(()=>parametersFor({protocol:'openai-chat',maxOutputTokensCeiling:100},{max_tokens:200}),{code:'INVALID_PARAMETERS'});
  assert.throws(()=>parametersFor({protocol:'openai-chat',baseUrl:'https://example.com'},{top_k:40}),{code:'UNSUPPORTED_PARAMETERS'});
});

test('an agent finishing for owner review advances its queued turn without accepting the code', async t => {
  const {app,chat}=await fixture(t);
  let release, calls=0;
  app.runtime.providers.set('agent',{id:'agent',kind:'http',available:true,async turn(){
    if (++calls === 1) await new Promise(resolve=>{release=resolve;});
    return {type:'message',text:'Ready for owner review.',finish:'done'};
  }});
  app.runtime.cancel(chat.id);
  const task=await app.runtime.createTask({workspace:chat.workspace,objective:'Review a small change.',providers:['agent'],acceptance:{mode:'owner'},policy:{mode:'ask'}});
  const run=app.runtime.run(task.id);await until(()=>Boolean(release));
  await app.runtime.submitMessage(task.id,'Also explain the change.','after-review','queue');
  release();await run;
  assert.equal(calls,2);
  const final=app.runtime.getTask(task.id);
  assert.equal(final.status,'waiting_input');
  assert.equal(final.completionKind,null);
  assert.equal(final.followups.at(-1).message,'Also explain the change.');
  assert.deepEqual(final.deferredMessages,[]);
});

test('chat context uses ledger order when a reply, follow-up, and rewind share a timestamp',()=>{
  const time='2026-11-24T05:00:00.000Z';
  const task={objective:'Start',persona:'focused',followups:[{id:'a',message:'Edited follow-up',createdAt:time}]};
  const history=[{type:'model.response',time,seq:2,data:{response:{type:'message',text:'First reply'}}},
    {type:'conversation.rewound',time,seq:9,data:{messageId:'a'}}];
  assert.deepEqual(catalogMessages({task,history}).slice(1).map(m=>m.content),['Start','First reply','Edited follow-up']);
  history.push({type:'model.response',time,seq:12,data:{response:{type:'message',text:'New reply'}}});
  assert.deepEqual(catalogMessages({task,history}).slice(1).map(m=>m.content),['Start','First reply','Edited follow-up','New reply']);
});
