import assert from 'node:assert/strict';
const MAX=Number.MAX_SAFE_INTEGER;
const clone=value=>JSON.parse(JSON.stringify(value));
const row=(location,sku,quantity)=>({location,sku,quantity});
const receive=(location,sku,quantity)=>({type:'receive',location,sku,quantity});
const ship=(location,sku,quantity)=>({type:'ship',location,sku,quantity});
const transfer=(from,to,sku,quantity)=>({type:'transfer',from,to,sku,quantity});
const tx=(id,...operations)=>({id,operations});
const lexical=(a,b)=>a<b?-1:a>b?1:0;
const tuple=(a,b)=>lexical(a.location,b.location)||lexical(a.sku,b.sku);

// Independent oracle: per-position BigInt map and transactional candidate copy.
// It never imports the known repair or candidate modules.
function reference(opening=[],deliveries=[]) {
  let quantities=new Map(opening.filter(item=>item.quantity>0).map(item=>[JSON.stringify([item.location,item.sku]),BigInt(item.quantity)]));
  const journal=[],seen=new Map();
  for(const transaction of deliveries) {
    if(seen.has(transaction.id)) {
      if(seen.get(transaction.id)!==JSON.stringify(transaction))throw new Error('duplicate conflict');
      continue;
    }
    const next=new Map(quantities);
    const delta=(location,sku,amount)=>{
      const key=JSON.stringify([location,sku]),value=(next.get(key)||0n)+amount;
      if(value<0n||value>BigInt(MAX))throw new Error('stock boundary');
      if(value===0n)next.delete(key);else next.set(key,value);
    };
    for(const operation of transaction.operations) {
      if(operation.type==='receive')delta(operation.location,operation.sku,BigInt(operation.quantity));
      else if(operation.type==='ship')delta(operation.location,operation.sku,-BigInt(operation.quantity));
      else {delta(operation.from,operation.sku,-BigInt(operation.quantity));delta(operation.to,operation.sku,BigInt(operation.quantity));}
    }
    if(next.size>1000||journal.length>=500)throw new Error('ledger boundary');
    quantities=next;seen.set(transaction.id,JSON.stringify(transaction));journal.push(clone(transaction));
  }
  const rows=[...quantities].map(([key,amount])=>{const[location,sku]=JSON.parse(key);return row(location,sku,Number(amount));}).sort(tuple);
  return {version:2,opening:opening.filter(item=>item.quantity>0).map(item=>({...item})).sort(tuple),balances:rows,transactions:journal,revision:journal.length};
}
function random(seed) {let value=seed>>>0;return size=>{value=(Math.imul(value,1664525)+1013904223)>>>0;return value%size;};}

export async function runInventoryProbes({call,test,eq}) {
  const invoke=(file,name,args)=>call(file,name,args,{immutable:true});
  const create=(opening=[])=>invoke('src/ledger.mjs','createLedger',[opening]);
  const apply=(state,event)=>invoke('src/ledger.mjs','applyTransaction',[state,event]);
  const validate=state=>invoke('src/ledger.mjs','validateLedger',[state]);
  const replay=(opening,events)=>invoke('src/replay.mjs','replayLedger',[opening,events]);
  const rewind=(state,revision)=>invoke('src/replay.mjs','rewindLedger',[state,revision]);
  const serialize=state=>invoke('src/checkpoint.mjs','serializeLedger',[state]);
  const restore=text=>invoke('src/checkpoint.mjs','restoreLedger',[text]);
  const query=(state,options={})=>invoke('src/query.mjs','queryBalances',[state,options]);
  const totals=state=>invoke('src/query.mjs','totalsBySku',[state]);
  const normalized=rows=>invoke('src/validation.mjs','normalizeBalances',[rows]);
  const normTx=event=>invoke('src/validation.mjs','normalizeTransaction',[event]);
  const rejects=async fn=>{let caught=false;try{await fn();}catch{caught=true;}assert.equal(caught,true,'Expected rejection');};

  await test('Inventory empty state and barrel exports',async()=>{
    eq(await create(),reference());
    eq(await invoke('src/index.mjs','createLedger',[]),reference());
    eq(await invoke('src/index.mjs','queryBalances',[reference()]),{items:[],nextCursor:null});
    eq(await invoke('src/index.mjs','totalsBySku',[reference()]),[]);
    eq(await invoke('src/index.mjs','replayLedger',[[],[]]),reference());
    eq(await invoke('src/index.mjs','restoreLedger',[await serialize(reference())]),reference());
    eq(await invoke('src/index.mjs','normalizeBalances',[[row('A','S',1)]]),[row('A','S',1)]);
    eq(await invoke('src/index.mjs','normalizeTransaction',[tx('barrel',receive('A','S',1))]),tx('barrel',receive('A','S',1)));
    eq(await invoke('src/index.mjs','applyTransaction',[reference(),tx('barrel',receive('A','S',1))]),reference([],[tx('barrel',receive('A','S',1))]));
    eq(await invoke('src/index.mjs','validateLedger',[reference()]),reference());
    eq(await invoke('src/index.mjs','rewindLedger',[reference(),0]),reference());
    assert.equal(await invoke('src/index.mjs','serializeLedger',[reference()]),JSON.stringify(reference()));
  });
  await test('Balance normalization drops zeros and sorts location then SKU by code unit',async()=>{
    eq(await normalized([row('a','a',2),row('A','z',4),row('a','A',3),row('a','zero',0)]),[row('A','z',4),row('a','A',3),row('a','a',2)]);
  });
  await test('Composite position keys cannot collide through separator concatenation',async()=>{
    const opening=[row('A:B','C',2),row('A','B:C',3)];
    eq(await normalized(opening),[row('A','B:C',3),row('A:B','C',2)]);
    const event=tx('split',ship('A:B','C',1),receive('A','B:C',4));
    eq(await apply(await create(opening),event),reference(opening,[event]));
  });
  await test('Transaction normalization canonicalizes field insertion order and preserves operation order',async()=>{
    eq(await normTx({operations:[{quantity:2,sku:'S',location:'A',type:'receive'},{sku:'S',quantity:1,to:'B',from:'A',type:'transfer'}],id:'x'}),tx('x',receive('A','S',2),transfer('A','B','S',1)));
  });
  await test('Receive and multi-operation transfer produce complete canonical state',async()=>{
    const opening=[row('A','S',8)],events=[tx('one',receive('B','T',2),transfer('A','B','S',3)),tx('two',ship('B','S',1))];
    eq(await replay(opening,events),reference(opening,events));
  });
  await test('Shipping exact stock removes zero balance without losing history',async()=>{
    const opening=[row('A','S',3)],event=tx('empty',ship('A','S',3));
    eq(await apply(await create(opening),event),reference(opening,[event]));
  });
  await test('Operations are sequential: receive before ship can fund it',async()=>{
    const event=tx('fund',receive('A','S',2),ship('A','S',1));
    eq(await apply(await create(),event),reference([],[event]));
  });
  await test('Operations cannot borrow from a later receive',async()=>{
    await rejects(()=>apply(reference(),tx('borrow',ship('A','S',1),receive('A','S',2))));
  });
  await test('Late insufficient stock rejects entire multi-operation transaction',async()=>{
    const state=reference([row('A','S',3)]);
    await rejects(()=>apply(state,tx('bad',receive('B','T',5),ship('A','S',4))));
    eq(await apply(state,tx('good',ship('A','S',1))),reference(state.opening,[tx('good',ship('A','S',1))]));
  });
  await test('Transfer target overflow cannot debit the source',async()=>{
    const state=reference([row('A','S',2),row('B','S',MAX)]);
    await rejects(()=>apply(state,tx('overflow',transfer('A','B','S',1))));
    eq(await apply(state,tx('source',ship('A','S',2))),reference(state.opening,[tx('source',ship('A','S',2))]));
  });
  await test('Receive exact safe-integer boundary and reject overflow',async()=>{
    const state=await apply(reference(),tx('max',receive('A','S',MAX)));
    eq(state,reference([],[tx('max',receive('A','S',MAX))]));
    await rejects(()=>apply(state,tx('more',receive('A','S',1))));
  });
  await test('Transaction duplicate identical payload is a no-op despite property insertion order',async()=>{
    const event=tx('same',receive('A','S',2)),state=reference([],[event]);
    eq(await apply(state,{operations:[{quantity:2,location:'A',type:'receive',sku:'S'}],id:'same'}),state);
  });
  await test('Duplicate IDs reject changed quantity or changed operation order',async()=>{
    const event=tx('same',receive('A','S',2),receive('B','S',1)),state=reference([],[event]);
    await rejects(()=>apply(state,tx('same',receive('A','S',3),receive('B','S',1))));
    await rejects(()=>apply(state,tx('same',receive('B','S',1),receive('A','S',2))));
  });
  await test('Transaction IDs remain case-sensitive',async()=>{
    const events=[tx('a',receive('A','S',2)),tx('A',receive('A','S',3))];
    eq(await replay([],events),reference([],events));
  });
  await test('Replay tolerates identical redeliveries without inflating revision',async()=>{
    const a=tx('a',receive('A','S',6)),b=tx('b',transfer('A','B','S',2));
    eq(await replay([],[a,a,b,a,b]),reference([],[a,b]));
  });
  await test('Replay rejects conflicting duplicate delivery',async()=>{
    await rejects(()=>replay([],[tx('a',receive('A','S',1)),tx('a',receive('A','S',2))]));
  });
  await test('Rewind zero middle and current revisions reconstruct balances',async()=>{
    const opening=[row('A','S',9)],events=[tx('a',ship('A','S',1)),tx('b',transfer('A','B','S',3)),tx('c',receive('B','T',7))],state=reference(opening,events);
    for(const revision of [0,1,2,3])eq(await rewind(state,revision),reference(opening,events.slice(0,revision)));
    for(const revision of [-1,4,1.5,'1',null])await rejects(()=>rewind(state,revision));
  });
  await test('Every state-consuming public API rejects fabricated balances',async()=>{
    const bad=reference();bad.balances=[row('A','forged',5)];
    for(const check of [()=>validate(bad),()=>apply(bad,tx('x',receive('A','S',1))),()=>rewind(bad,0),()=>serialize(bad),()=>query(bad),()=>totals(bad)])await rejects(check);
  });
  await test('State validation rejects wrong revision wrong version extra fields and duplicate journal IDs',async()=>{
    const good=reference([],[tx('a',receive('A','S',1))]);
    for(const bad of [{...good,revision:0},{...good,version:1},{...good,extra:true},{...good,transactions:[...good.transactions,...good.transactions],revision:2}])await rejects(()=>validate(bad));
  });
  await test('State and checkpoint validation compare balance identities as well as quantities',async()=>{
    const good=reference([row('A','S',7)]);
    for(const balances of [[row('B','S',7)],[row('A','differentSku',7)]]) {
      const bad={...good,balances};
      for(const check of [()=>validate(bad),()=>apply(bad,tx('x',receive('A','S',1))),()=>rewind(bad,0),()=>serialize(bad),()=>restore(JSON.stringify(bad)),()=>query(bad),()=>totals(bad)])await rejects(check);
    }
  });
  await test('State validation normalizes semantically equivalent row order',async()=>{
    const state=reference([row('A','S',2),row('B','T',3)]);
    const altered={...state,opening:[...state.opening].reverse(),balances:[...state.balances].reverse()};
    eq(await validate(altered),state);
    assert.equal(await serialize(altered),JSON.stringify(state));
  });
  await test('Checkpoint v2 round trip is deterministic compact canonical JSON',async()=>{
    const state=reference([row('A','S',4)],[tx('move',transfer('A','B','S',2))]);
    const serialized=await serialize(state);
    assert.equal(serialized,JSON.stringify(state));
    eq(await restore(serialized),state);
    assert.equal(await serialize(await restore(serialized)),serialized);
  });
  await test('Checkpoint v2 rejects forged balances and revision',async()=>{
    const state=reference([],[tx('a',receive('A','S',3))]);
    await rejects(()=>restore(JSON.stringify({...state,balances:[row('A','S',300)]})));
    await rejects(()=>restore(JSON.stringify({...state,revision:0})));
  });
  await test('Legacy signed delta migration preserves atomic event ordering',async()=>{
    const legacy={version:1,opening:[row('A','S',5)],events:[{id:'a',changes:[{location:'A',sku:'S',delta:-2},{location:'B',sku:'S',delta:2}]},{id:'b',changes:[{location:'B',sku:'S',delta:-1}]}]};
    eq(await restore(JSON.stringify(legacy)),reference(legacy.opening,[tx('a',ship('A','S',2),receive('B','S',2)),tx('b',ship('B','S',1))]));
  });
  await test('Legacy duplicate delivery is idempotent and conflicts reject',async()=>{
    const event={id:'a',changes:[{location:'A',sku:'S',delta:2}]};
    eq(await restore(JSON.stringify({version:1,opening:[],events:[event,event]})),reference([],[tx('a',receive('A','S',2))]));
    await rejects(()=>restore(JSON.stringify({version:1,opening:[],events:[event,{id:'a',changes:[{location:'A',sku:'S',delta:3}]}]})));
  });
  await test('Legacy zero fractional unsafe and malformed deltas reject',async()=>{
    for(const delta of [0,1.2,'2',MAX+1,-MAX-1,null])await rejects(()=>restore(JSON.stringify({version:1,opening:[],events:[{id:'a',changes:[{location:'A',sku:'S',delta}]}]})));
    await rejects(()=>restore(JSON.stringify({version:1,opening:[],events:[{id:'a',changes:[{location:'A',sku:'S',delta:1,quantity:1}]}]})));
  });
  await test('Legacy insufficiency cannot be hidden by later positive delta',async()=>{
    await rejects(()=>restore(JSON.stringify({version:1,opening:[],events:[{id:'a',changes:[{location:'A',sku:'S',delta:-1},{location:'A',sku:'S',delta:2}]}]})));
  });
  await test('Checkpoint rejects malformed JSON unsupported versions and wrong schemas',async()=>{
    for(const text of ['', 'no-json', 'null','[]','{"version":3}',JSON.stringify({version:1,opening:[],events:[],extra:1}),JSON.stringify({version:1,opening:[],events:[{id:'a',changes:[]}]}),JSON.stringify({version:1,opening:[],events:'bad'})])await rejects(()=>restore(text));
    for(const value of [null,0,{},[]])await rejects(()=>restore(value));
  });
  const queryRows=[row('A','A',2),row('A','a',5),row('B','A',4),row('B','a',1),row('a','A',7)];
  await test('Filtered queries use minimum quantity and tuple order before pagination',async()=>{
    const state=reference(queryRows);
    eq(await query(state,{sku:'A',minQuantity:3,limit:1}),{items:[row('B','A',4)],nextCursor:{location:'B',sku:'A'}});
    eq(await query(state,{location:'A',minQuantity:3}),{items:[row('A','a',5)],nextCursor:null});
  });
  await test('Cursor is exclusive and only reports remaining matching rows',async()=>{
    const state=reference(queryRows);
    eq(await query(state,{limit:2}),{items:queryRows.slice(0,2),nextCursor:{location:'A',sku:'a'}});
    eq(await query(state,{limit:2,after:{location:'A',sku:'a'}}),{items:queryRows.slice(2,4),nextCursor:{location:'B',sku:'a'}});
    eq(await query(state,{limit:2,after:{location:'B',sku:'a'}}),{items:queryRows.slice(4),nextCursor:null});
  });
  await test('Cursor need not match an existing position',async()=>{
    eq(await query(reference(queryRows),{after:{location:'A',sku:'b'},limit:100}),{items:queryRows.slice(2),nextCursor:null});
    eq(await query(reference(queryRows),{after:{location:'z',sku:'z'}}),{items:[],nextCursor:null});
  });
  await test('Zero page and zero minimum quantity have explicit behavior',async()=>{
    eq(await query(reference(queryRows),{limit:0}),{items:[],nextCursor:null});
    eq(await query(reference(queryRows),{minQuantity:0,limit:100}),{items:queryRows,nextCursor:null});
  });
  await test('Default page length is50 and final cursor is null',async()=>{
    const rows=Array.from({length:51},(_,i)=>row('L'+String(i).padStart(2,'0'),'S',1));
    const first=await query(reference(rows));eq(first,{items:rows.slice(0,50),nextCursor:{location:'L49',sku:'S'}});
    eq(await query(reference(rows),{after:first.nextCursor}),{items:[rows[50]],nextCursor:null});
  });
  await test('Queries reject invalid limits quantities fields filters and cursors',async()=>{
    for(const options of [{limit:-1},{limit:101},{limit:1.5},{limit:'1'},{limit:null},{minQuantity:-1},{minQuantity:1.5},{minQuantity:'1'},{location:''},{sku:' bad'},{after:{}},{after:{location:'A',sku:'S',extra:1}},{extra:true},null,[]])await rejects(()=>query(reference(),options));
  });
  await test('Hostile identifier keys retain ordinary stock and aggregate semantics',async()=>{
    const opening=[row('__proto__','constructor',2),row('constructor','__proto__',3),row('toString','toString',4)];
    const event=tx('__proto__',transfer('__proto__','toString','constructor',1));
    const state=await apply(await create(opening),event);
    eq(state,reference(opening,[event]));
    eq(await totals(state),[{sku:'__proto__',quantity:'3'},{sku:'constructor',quantity:'2'},{sku:'toString',quantity:'4'}]);
  });
  await test('SKU totals stay exact beyond safe integer and use code-unit order',async()=>{
    const state=reference([row('A','S',MAX),row('B','S',MAX),row('A','a',1),row('A','Z',2)]);
    eq(await totals(state),[{sku:'S',quantity:(BigInt(MAX)*2n).toString()},{sku:'Z',quantity:'2'},{sku:'a',quantity:'1'}]);
  });
  await test('SKU aggregate retains an odd low unit beyond floating-point resolution',async()=>{
    const state=reference([row('A','S',MAX),row('B','S',MAX),row('C','S',1)]);
    eq(await totals(state),[{sku:'S',quantity:'18014398509481983'}]);
  });
  await test('Balance quantity validation rejects coercion and unsafe values',async()=>{
    for(const quantity of [-1,1.5,'1',null,MAX+1])await rejects(()=>normalized([row('A','S',quantity)]));
    eq(await normalized([row('A','S',MAX)]),[row('A','S',MAX)]);
  });
  await test('Identifier validation includes exact64-character boundary and rejects trimming',async()=>{
    const good='A'+'x'.repeat(63);
    eq(await normalized([row(good,'_',1)]),[row(good,'_',1)]);
    for(const invalid of ['', ' A','A ','1start','A/B','A'.repeat(65),0,null]) {
      await rejects(()=>normalized([row(invalid,'S',1)]));
      await rejects(()=>normTx(tx(invalid,receive('A','S',1))));
    }
  });
  await test('Duplicate balance positions including zero rows cannot be aggregated',async()=>{
    for(const rows of [[row('A','S',1),row('A','S',2)],[row('A','S',0),row('A','S',1)]])await rejects(()=>normalized(rows));
    for(const rows of [null,{},[{}],[{location:'A',sku:'S',quantity:1,extra:2}]])await rejects(()=>normalized(rows));
  });
  await test('Transaction schema operation count and positive quantity validation',async()=>{
    for(const event of [null,{},tx('a'),{id:'a',operations:'bad'},{...tx('a',receive('A','S',1)),extra:1},tx('a',{type:'adjust',location:'A',sku:'S',quantity:1}),tx('a',{...receive('A','S',1),extra:1}),tx('a',transfer('A','A','S',1))])await rejects(()=>normTx(event));
    for(const quantity of [0,-1,1.5,'1',null,MAX+1])await rejects(()=>normTx(tx('a',receive('A','S',quantity))));
    await rejects(()=>normTx({id:'a',operations:Array.from({length:51},()=>receive('A','S',1))}));
    eq((await normTx({id:'a',operations:Array.from({length:50},()=>receive('A','S',1))})).operations.length,50);
  });
  await test('Journal boundary accepts500 commits and duplicate but rejects501st new ID',async()=>{
    const events=Array.from({length:500},(_,i)=>tx('e'+i,receive('A','S',1)));
    const state=await replay([],events);eq(state,reference([],events));
    eq(await apply(state,events[0]),state);
    await rejects(()=>apply(state,tx('e500',receive('A','S',1))));
  });
  await test('Replay delivery boundary accepts1000 identical events and rejects1001',async()=>{
    const event=tx('a',receive('A','S',1));
    eq(await replay([],Array.from({length:1000},()=>event)),reference([],[event]));
    await rejects(()=>replay([],Array.from({length:1001},()=>event)));
  });
  await test('Position boundary accepts1000 stock rows and rejects1001 including transaction growth',async()=>{
    const opening=Array.from({length:1000},(_,i)=>row('L'+String(i).padStart(4,'0'),'S',1));
    eq((await create(opening)).balances.length,1000);
    await rejects(()=>create([...opening,row('extra','S',1)]));
    await rejects(()=>apply(reference(opening),tx('extra',receive('extra','S',1))));
    const event=tx('replace',ship('L0000','S',1),receive('extra','S',1));
    eq(await apply(reference(opening),event),reference(opening,[event]));
  });

  for(let seed=1;seed<=24;seed++)await test('Seeded atomic replay/rewind/query sequence '+seed,async()=>{
    const rng=random(seed),locations=['A','B','__proto__'],skus=['S','constructor'];
    const opening=locations.flatMap(location=>skus.map(sku=>row(location,sku,5+rng(8))));
    let actual=await create(opening),events=[];
    for(let step=0;step<24;step++) {
      let event;
      if(step%7===6&&events.length)event=clone(events[rng(events.length)]);
      else if(step%11===10&&events.length) {event=clone(events[0]);event.operations[0].quantity++;}
      else {
        const location=locations[rng(locations.length)],sku=skus[rng(skus.length)],quantity=1+rng(13),kind=rng(3);
        event=tx('seed'+seed+'e'+step,kind===0?receive(location,sku,quantity):kind===1?ship(location,sku,quantity):transfer(location,locations[(locations.indexOf(location)+1)%locations.length],sku,quantity));
        if(step%5===4)event.operations.push(ship(locations[rng(locations.length)],skus[rng(skus.length)],1+rng(20)));
      }
      let expected,accepted=true;try{expected=reference(opening,[...events,event]);}catch{accepted=false;}
      if(!accepted)await rejects(()=>apply(actual,event));
      else {actual=await apply(actual,event);eq(actual,expected);events.push(event);}
    }
    const expected=reference(opening,events);
    eq(await replay(opening,events),expected);
    const revision=Math.floor(expected.revision/2);
    eq(await rewind(actual,revision),reference(opening,expected.transactions.slice(0,revision)));
    eq(await restore(await serialize(actual)),expected);
    const pageItems=[];let after=null;
    for(let page=0;page<20;page++) {
      const result=await query(actual,{limit:2,after});pageItems.push(...result.items);
      if(result.nextCursor===null)break;after=result.nextCursor;
      assert.ok(page<19,'Pagination did not terminate');
    }
    eq(pageItems,expected.balances);
  });
}
