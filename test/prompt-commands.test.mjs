import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createApp} from '../src/server.mjs';
import {HttpProvider} from '../src/providers.mjs';
import {veniceEndpoint} from '../src/venice-catalog.mjs';

test('saved prompt commands preserve edits across restarts and reject stale versions', async t => {
  const dir=await mkdtemp(path.join(tmpdir(),'godmode-commands-'));
  let app=await createApp({dataDir:dir,auth:false,providers:new Map()}), root=await app.listen(0);
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  async function request(method,body) {
    const res=await fetch(root+'/api/prompt-commands',{method,headers:{'content-type':'application/json','x-g0d-request':'1'},body:body && JSON.stringify(body)});
    return {status:res.status,...await res.json()};
  }
  const list=await request('GET');
  assert.ok(list.commands.some(c=>c.tag==='!SOCRATIC'));
  const create={tag:'!RUBRIC',version:null,prompt:'Grade clarity and give one example.'};
  const first=(await request('PUT',create)).commands.find(c=>c.tag===create.tag);
  assert.equal((await request('PUT',create)).status,409);
  assert.equal((await request('PUT',{tag:'<img>',version:null,prompt:'Example'})).status,400);
  const second=(await request('PUT',{...first,originalTag:first.tag,tag:'!REVIEW',prompt:'Grade clarity out of five.'})).commands.find(c=>c.tag==='!REVIEW');
  assert.equal((await request('DELETE',first)).status,409);
  await app.close();
  app=await createApp({dataDir:dir,auth:false,providers:new Map()});root=await app.listen(0);
  assert.deepEqual((await request('GET')).commands.find(c=>c.tag==='!REVIEW'),second);
  assert.equal((await request('DELETE',second)).commands.some(c=>c.tag==='!REVIEW'),false);
});

test('Venice revisions contain only the selected definition and edit request and stay unsaved', async t => {
  const dir=await mkdtemp(path.join(tmpdir(),'godmode-command-revision-'));
  const provider=new HttpProvider({id:'venice',model:'editor',baseUrl:veniceEndpoint,credential:'test-key'});
  const app=await createApp({dataDir:dir,auth:false,providers:new Map([['venice',provider]])});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const root=await app.listen(0), original=globalThis.fetch;
  const initial=await (await original(root+'/api/prompt-commands')).json();
  const prompt=initial.commands.find(c=>c.tag==='!GRADE').prompt;
  let requests=0;
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    if(url!==veniceEndpoint+'/chat/completions')return original(url,init);
    requests++;
    const body=JSON.parse(init.body);
    assert.equal(body.model,'editor');assert.equal(body.messages.length,2);
    assert.equal(body.tools,undefined);assert.ok(body.messages[1].content.includes(prompt));
    assert.match(body.messages[1].content,/Include two scores/);
    return Response.json({choices:[{finish_reason:'stop',message:{content:'Give two scores with evidence.'}}]});
  });
  const reply=await original(root+'/api/prompt-commands/revise',{method:'POST',headers:{'content-type':'application/json','x-g0d-request':'1'},body:JSON.stringify({prompt,instruction:'Include two scores.'})});
  assert.equal(reply.status,200);assert.equal((await reply.json()).prompt,'Give two scores with evidence.');
  assert.deepEqual(await (await original(root+'/api/prompt-commands')).json(),initial);assert.equal(requests,1);
});
