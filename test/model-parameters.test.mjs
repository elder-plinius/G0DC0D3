import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HttpProvider } from '../src/providers.mjs';
import { createVeniceCatalog, veniceEndpoint } from '../src/venice-catalog.mjs';
import { parameterLimits, parametersFor, intersectParameterLimits } from '../src/conversation-controls.mjs';
import { createApp } from '../src/server.mjs';

const provider=()=>new HttpProvider({id:'saved',label:'Saved Venice',baseUrl:veniceEndpoint,model:'alpha',credential:'test-only',maxOutputTokens:4096,maxOutputTokensCeiling:64000});
const records=[{id:'alpha',type:'text',model_spec:{name:'Alpha',maxCompletionTokens:8192,constraints:{temperature:{min:.1,max:1.5,default:.7},top_p:{default:.9}}}},
  {id:'beta',type:'text',model_spec:{name:'Beta',maxCompletionTokens:2048,constraints:{temperature:{min:.2,max:1,default:.8}}}}];

test('catalog limits and defaults propagate to configured and catalog models without rounding exact values',async()=>{
  const saved=provider(),catalog=createVeniceCatalog(new Map([['saved',saved]]),async()=>Response.json({data:records}));
  await catalog.list();
  for(const selected of [saved,catalog.get('venice-catalog:alpha')]) {
    const {fields}=parameterLimits(selected);
    assert.equal(fields.max_tokens.max,8192);assert.equal(fields.max_tokens.maxSource,'model');
    assert.equal(fields.temperature.min,.1);assert.equal(fields.temperature.max,1.5);assert.equal(fields.temperature.default,.7);
    assert.equal(fields.temperature.defaultSource,'model');assert.equal(fields.top_p.maxSource,'api');
    assert.equal(fields.seed.maxSource,'app');
    assert.equal(parametersFor(selected,{temperature:.123456789012345}).temperature,.123456789012345);
    assert.throws(()=>parametersFor(selected,{temperature:.05}),{code:'INVALID_PARAMETERS'});
    assert.throws(()=>parametersFor(selected,{max_tokens:9000}),{code:'INVALID_PARAMETERS'});
  }
});

test('missing or stale model metadata stays explicit, and shared ranges use the tightest selected limits',async()=>{
  let offline=false;
  const catalog=createVeniceCatalog(new Map([['saved',provider()]]),async()=>{if(offline)throw Error('Offline');return Response.json({data:[...records,{id:'unknown',type:'text',model_spec:{name:'Unknown',constraints:{temperature:{min:'bad',max:-2,default:99}}}}]});});
  const initial=await catalog.list();
  const shared=intersectParameterLimits(['alpha','beta'].map(id=>parameterLimits(catalog.get('venice-catalog:'+id))));
  assert.equal(shared.temperature.min,.2);assert.equal(shared.temperature.max,1);assert.equal(shared.temperature.default,undefined);
  assert.equal(shared.max_tokens.max,2048);
  const fallback=parameterLimits(catalog.get('venice-catalog:unknown')).fields;
  assert.equal(fallback.temperature.max,2);assert.equal(fallback.temperature.maxSource,'api');assert.equal(fallback.temperature.default,undefined);
  assert.equal(fallback.max_tokens.maxSource,'connection');
  offline=true;const stale=await catalog.list(true);
  assert.equal(stale.stale,true);assert.equal(stale.fetchedAt,initial.fetchedAt);
  assert.equal(parameterLimits(catalog.get('venice-catalog:alpha')).fields.max_tokens.max,8192);
});

test('the application API reports shared ranges and refreshes changed catalog constraints',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'godmode-parameter-limits-'));
  let lower=false,calls=0;
  const app=await createApp({dataDir:directory,auth:false,providers:new Map([['saved',provider()]]),fetchCatalog:async()=>{
    calls++;const data=structuredClone(records);if(lower)data[1].model_spec.maxCompletionTokens=1024;return Response.json({data});
  }});
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const root=await app.listen(0),endpoint=root+'/api/providers/parameters?ids=saved,venice-catalog:beta';
  const first=await (await fetch(endpoint)).json();assert.equal(first.fields.max_tokens.max,2048);assert.equal(first.fields.temperature.min,.2);assert.equal(calls,1);
  await fetch(endpoint);assert.equal(calls,1,'fresh metadata uses the cache');
  lower=true;const updated=await(await fetch(endpoint+'&refresh=1')).json();assert.equal(updated.fields.max_tokens.max,1024);assert.equal(calls,2);
  assert.equal((await fetch(root+'/api/providers/parameters?ids=unknown')).status,400);
});

test('GLM seed zero is rejected locally using the verified fallback, without changing other models',()=>{
  const glm=new HttpProvider({id:'glm',model:'z-ai-glm-5-3-flash',baseUrl:veniceEndpoint,credential:'test-only'});
  assert.equal(parameterLimits(glm).fields.seed.min,1);
  assert.equal(parameterLimits(glm).fields.seed.minSource,'verified');
  assert.throws(()=>parametersFor(glm,{seed:0}),{code:'INVALID_PARAMETERS'});
  assert.deepEqual(parametersFor(glm,{seed:1}),{seed:1});
  assert.deepEqual(parametersFor(provider(),{seed:0}),{seed:0});
  glm.modelMetadata={constraints:{seed:{min:0}}};
  assert.equal(parameterLimits(glm).fields.seed.minSource,'model');
  assert.deepEqual(parametersFor(glm,{seed:0}),{seed:0});
});
