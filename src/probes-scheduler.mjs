import assert from 'node:assert/strict';

function referenceGraph(tasks) {
  const byId=new Map(tasks.map(task=>[task.id,{...task,deps:task.deps||[]}]));
  const ids=[...byId.keys()].sort(),order=[],done=new Set();
  while(true) {
    const id=ids.find(id=>!done.has(id)&&byId.get(id).deps.every(dep=>done.has(dep)));
    if(id===undefined)break;
    done.add(id);order.push(id);
  }
  const reach=new Map();
  for(const id of ids) {
    const reached=new Set(),stack=[...byId.get(id).deps];
    while(stack.length) {const next=stack.pop();if(reached.has(next))continue;reached.add(next);stack.push(...byId.get(next).deps);}
    reach.set(id,reached);
  }
  const cycles=[],assigned=new Set();
  for(const id of ids) {
    if(assigned.has(id)||!reach.get(id).has(id))continue;
    const group=ids.filter(other=>reach.get(id).has(other)&&reach.get(other).has(id));
    group.forEach(member=>assigned.add(member));cycles.push(group);
  }
  return {order,cycles,blocked:ids.filter(id=>!done.has(id)&&!assigned.has(id))};
}

// Deliberately uses integer clock ticks and recomputed resource usage; candidate
// repairs use next-event jumps and resource counters.
function referenceSchedule(input,{concurrency=2,resources={}}={}) {
  const tasks=input.map(task=>({...task,deps:task.deps||[],priority:task.priority||0,resources:task.resources||{}}));
  const started=new Set(),done=new Set(),entries=[];
  let active=[];
  for(let clock=0;clock<=10000;clock++) {
    active.filter(entry=>entry.end===clock).forEach(entry=>done.add(entry.id));
    active=active.filter(entry=>entry.end>clock);
    while(active.length<concurrency) {
      const ready=tasks.filter(task=>!started.has(task.id)&&task.deps.every(id=>done.has(id)))
        .sort((a,b)=>(b.priority-a.priority)||(a.id<b.id?-1:a.id>b.id?1:0));
      const choice=ready.find(task=>Object.entries(task.resources).every(([name,amount])=>{
        const used=active.reduce((sum,entry)=>sum+(tasks.find(task=>task.id===entry.id).resources[name]||0),0);
        return used+amount<=resources[name];
      }));
      if(!choice)break;
      let worker=0;while(active.some(entry=>entry.worker===worker))worker++;
      const entry={id:choice.id,start:clock,end:clock+choice.duration,worker};
      entries.push(entry);active.push(entry);started.add(choice.id);
    }
    if(done.size===tasks.length)return {entries,makespan:clock};
  }
  throw new Error('Reference schedule exceeded bounded fixture horizon');
}

function verifySchedule(tasks,options,result) {
  const byId=new Map(tasks.map(task=>[task.id,task]));
  assert.equal(result.entries.length,tasks.length,'Every task should appear once');
  assert.equal(new Set(result.entries.map(entry=>entry.id)).size,tasks.length,'Duplicate task');
  for(const entry of result.entries) {
    const task=byId.get(entry.id);assert.ok(task,'Unknown task in schedule');
    assert.equal(entry.end-entry.start,task.duration);
    assert.ok(Number.isInteger(entry.start)&&entry.start>=0);
    assert.ok(Number.isInteger(entry.worker)&&entry.worker>=0&&entry.worker<options.concurrency);
    for(const id of task.deps||[])assert.ok(result.entries.find(other=>other.id===id).end<=entry.start,'Started before dependency finished');
  }
  for(let time=0;time<result.makespan;time++) {
    const active=result.entries.filter(entry=>entry.start<=time&&entry.end>time);
    assert.ok(active.length<=options.concurrency);
    assert.equal(new Set(active.map(entry=>entry.worker)).size,active.length,'Worker overlap');
    for(const [resource,capacity]of Object.entries(options.resources)) {
      const demand=active.reduce((sum,entry)=>sum+((byId.get(entry.id).resources||{})[resource]||0),0);
      assert.ok(demand<=capacity,'Resource capacity exceeded');
    }
  }
  assert.equal(result.makespan,result.entries.length?Math.max(...result.entries.map(entry=>entry.end)):0);
}

function generator(seed) {
  let value=seed>>>0;
  return maximum=>{value^=value<<13;value^=value>>>17;value^=value<<5;return(value>>>0)%maximum;};
}

export async function runSchedulerProbes({call,test,eq}) {
  const invoke=(file,name,args)=>call(file,name,args,{immutable:true});
  const graph=tasks=>invoke('src/graph.mjs','analyzeGraph',[tasks]);
  const schedule=(tasks,options={})=>invoke('src/scheduler.mjs','schedule',[tasks,options]);
  const initial=tasks=>invoke('src/state.mjs','initialState',[tasks]);
  const reduce=(state,event)=>invoke('src/state.mjs','reduceState',[state,event]);
  const rejects=async fn=>{let caught=false;try{await fn();}catch{caught=true;}assert.equal(caught,true,'Expected invalid input or transition to throw');};

  await test('Scheduler empty/default behavior',async()=>{
    eq(await graph([]),{order:[],cycles:[],blocked:[]});
    eq(await schedule([]),{entries:[],makespan:0});
    eq(await initial([]),{tasks:[]});
  });
  await test('Canonical task normalization and copy',async()=>{
    eq(await invoke('src/validate.mjs','normalizeTasks',[[{id:'b',duration:2},{id:'a',duration:1,deps:['b'],priority:-2,resources:{cpu:1}}]]),[
      {id:'b',deps:[],duration:2,priority:0,resources:{}},
      {id:'a',deps:['b'],duration:1,priority:-2,resources:{cpu:1}}
    ]);
  });
  await test('Graph chooses lexical ready tasks rather than sorting all IDs',async()=>{
    const tasks=[{id:'a',duration:1,deps:['z']},{id:'z',duration:1},{id:'b',duration:1},{id:'c',duration:1,deps:['b']}];
    eq(await graph(tasks),{order:['b','c','z','a'],cycles:[],blocked:[]});
  });
  await test('Mixed-case lexical order uses UTF-16 code units rather than locale collation',async()=>{
    const tasks=[{id:'a',duration:1},{id:'Z',duration:1},{id:'A',duration:1},{id:'z',duration:1}];
    eq(await graph(tasks),{order:['A','Z','a','z'],cycles:[],blocked:[]});
    eq(await schedule(tasks,{concurrency:2}),{entries:[{id:'A',start:0,end:1,worker:0},{id:'Z',start:0,end:1,worker:1},{id:'a',start:1,end:2,worker:0},{id:'z',start:1,end:2,worker:1}],makespan:2});
    eq((await initial(tasks)).tasks.map(task=>task.id),['A','Z','a','z']);
  });
  await test('Cycle SCCs distinguish cyclic members, blocked descendants, and acyclic predecessors',async()=>{
    const tasks=[
      {id:'a',duration:1,deps:['b','x']},{id:'b',duration:1,deps:['a']},
      {id:'c',duration:1,deps:['b']},{id:'s',duration:1,deps:['s']},
      {id:'free',duration:1},{id:'x',duration:1}
    ];
    eq(await graph(tasks),{order:['free','x'],cycles:[['a','b'],['s']],blocked:['c']});
    await rejects(()=>schedule(tasks));
  });
  await test('Several disconnected and overlapping cycle components',async()=>{
    const tasks=[
      {id:'a',duration:1,deps:['b']},{id:'b',duration:1,deps:['c']},{id:'c',duration:1,deps:['a','b']},
      {id:'d',duration:1,deps:['e']},{id:'e',duration:1,deps:['d']},
      {id:'tail',duration:1,deps:['c','e']},{id:'alone',duration:1}
    ];
    eq(await graph(tasks),referenceGraph(tasks));
  });
  await test('Priority, fitting alternatives, and smallest worker',async()=>{
    const tasks=[
      {id:'A',duration:5,priority:3,resources:{gpu:2}},
      {id:'B',duration:1,priority:2,resources:{gpu:1}},
      {id:'C',duration:1,priority:1}
    ];
    eq(await schedule(tasks,{concurrency:2,resources:{gpu:2}}),{entries:[
      {id:'A',start:0,end:5,worker:0},{id:'C',start:0,end:1,worker:1},{id:'B',start:5,end:6,worker:0}
    ],makespan:6});
  });
  await test('Same-time completions release all dependencies before new starts',async()=>{
    const tasks=[{id:'b',duration:2},{id:'a',duration:2},{id:'c',duration:3,deps:['a','b']},{id:'d',duration:1,deps:['a']}];
    const options={concurrency:2,resources:{}};
    eq(await schedule(tasks,options),referenceSchedule(tasks,options));
  });
  await test('Resource names do not inherit object prototype capacities',async()=>{
    await rejects(()=>schedule([{id:'constructor',duration:1,resources:{constructor:1}}],{resources:{}}));
    eq(await schedule([{id:'constructor',duration:1,resources:{constructor:1}}],{concurrency:1,resources:{constructor:1}}),{entries:[{id:'constructor',start:0,end:1,worker:0}],makespan:1});
  });
  await test('Large valid durations advance by completion events without overflow',async()=>{
    eq(await schedule([{id:'a',duration:1000000},{id:'b',duration:1000000,deps:['a']}],{concurrency:32,resources:{cpu:1000000}}),{entries:[{id:'a',start:0,end:1000000,worker:0},{id:'b',start:1000000,end:2000000,worker:0}],makespan:2000000});
  });
  await test('Task validation rejects malformed inputs',async()=>{
    const invalid=[
      null,{},[null],[{duration:1}],[{id:'',duration:1}],[{id:'a b',duration:1}],
      [{id:'a',duration:1},{id:'a',duration:2}],
      [{id:'a',duration:0}],[{id:'a',duration:-1}],[{id:'a',duration:1.5}],[{id:'a',duration:1000001}],
      [{id:'a',duration:'1'}],[{id:'a',duration:1,priority:1.1}],[{id:'a',duration:1,priority:1000001}],
      [{id:'a',duration:1,deps:'x'}],[{id:'a',duration:1,deps:['missing']}],
      [{id:'a',duration:1,deps:['a','a']}],[{id:'a',duration:1,resources:[]}],
      [{id:'a',duration:1,resources:{cpu:0}}],[{id:'a',duration:1,resources:{cpu:1.5}}],
      Array.from({length:101},(_,i)=>({id:'t'+i,duration:1}))
    ];
    for(const input of invalid)await rejects(()=>invoke('src/validate.mjs','normalizeTasks',[input]));
  });
  await test('Scheduler validates concurrency, capacities, and feasibility',async()=>{
    const tasks=[{id:'a',duration:1,resources:{cpu:2}}];
    for(const concurrency of [0,33,1.5,'2',null])await rejects(()=>schedule([],{concurrency}));
    for(const resources of [null,[],{cpu:0},{cpu:1.5},{cpu:1000001},{'bad name':1}])await rejects(()=>schedule([],{resources}));
    await rejects(()=>schedule(tasks,{resources:{}}));await rejects(()=>schedule(tasks,{resources:{cpu:1}}));
  });
  await test('Exactly 100 tasks is valid and schedules as a complete dependency chain',async()=>{
    const tasks=Array.from({length:100},(_,index)=>({id:'t'+String(index).padStart(3,'0'),duration:1,deps:index?['t'+String(index-1).padStart(3,'0')]:[]}));
    assert.equal((await invoke('src/validate.mjs','normalizeTasks',[tasks])).length,100);
    const result=await schedule([...tasks].reverse(),{concurrency:32});
    assert.equal(result.entries.length,100);assert.equal(result.makespan,100);
    eq(result.entries.map(entry=>entry.id),tasks.map(task=>task.id));
    assert.ok(result.entries.every((entry,index)=>entry.start===index&&entry.end===index+1&&entry.worker===0));
  });

  for(let seed=1;seed<=50;seed++) {
    await test('Seeded DAG '+seed+': graph order, schedule, resources, workers, and conservation',async()=>{
      const random=generator(seed*7919),size=2+random(11);
      const options={concurrency:1+random(4),resources:{cpu:2+random(3),io:1+random(3)}};
      const tasks=Array.from({length:size},(_,index)=>{
        const deps=[];for(let previous=0;previous<index;previous++)if(random(4)===0)deps.push('t'+String(previous).padStart(2,'0'));
        const resources={},cpu=random(options.resources.cpu+1),io=random(options.resources.io+1);
        if(cpu)resources.cpu=cpu;if(io)resources.io=io;
        return{id:'t'+String(index).padStart(2,'0'),deps,duration:1+random(9),priority:random(5)-2,resources};
      });
      for(let index=tasks.length-1;index>0;index--){const swap=random(index+1);[tasks[index],tasks[swap]]=[tasks[swap],tasks[index]];}
      eq(await graph(tasks),referenceGraph(tasks));
      const result=await schedule(tasks,options);
      eq(result,referenceSchedule(tasks,options));verifySchedule(tasks,options,result);
    });
  }
  await test('Reducer canonical initial state and dependency gating',async()=>{
    const tasks=[{id:'b',duration:1,deps:['a']},{id:'a',duration:1}];
    const state=await initial(tasks);
    eq(state,{tasks:[{id:'a',deps:[],status:'pending',attempts:0,error:null},{id:'b',deps:['a'],status:'pending',attempts:0,error:null}]});
    await rejects(()=>reduce(state,{type:'start',id:'b'}));
    let current=await reduce(state,{type:'start',id:'a'});
    assert.equal(current.tasks[0].attempts,1);
    current=await reduce(current,{type:'succeed',id:'a'});
    current=await reduce(current,{type:'start',id:'b'});
    current=await reduce(current,{type:'succeed',id:'b'});
    assert.ok(current.tasks.every(task=>task.status==='succeeded'));
    await rejects(()=>reduce(current,{type:'start',id:'a'}));
  });
  await test('Reducer fail/retry increments attempts once per start and clears error',async()=>{
    let state=await initial([{id:'a',duration:1}]);
    state=await reduce(state,{type:'start',id:'a'});
    state=await reduce(state,{type:'fail',id:'a',error:'boom'});
    eq(state.tasks[0],{id:'a',deps:[],status:'failed',attempts:1,error:'boom'});
    state=await reduce(state,{type:'retry',id:'a'});
    eq(state.tasks[0],{id:'a',deps:[],status:'pending',attempts:1,error:null});
    state=await reduce(state,{type:'start',id:'a'});
    assert.equal(state.tasks[0].attempts,2);
  });
  await test('Reducer cancellation and invalid transitions remain explicit',async()=>{
    const state=await initial([{id:'a',duration:1},{id:'b',deps:['a'],duration:1}]);
    for(const event of [{type:'wat',id:'a'},{type:'start',id:'missing'},{type:'succeed',id:'a'},{type:'fail',id:'a',error:'x'},{type:'retry',id:'a'}])await rejects(()=>reduce(state,event));
    const running=await reduce(state,{type:'start',id:'a'});
    for(const error of ['',null,7])await rejects(()=>reduce(running,{type:'fail',id:'a',error}));
    await rejects(()=>reduce(running,{type:'start',id:'a'}));
    const cancelled=await reduce(running,{type:'cancel',id:'a'});
    assert.equal(cancelled.tasks[0].status,'cancelled');
    for(const type of ['start','succeed','fail','retry','cancel'])await rejects(()=>reduce(cancelled,{type,id:'a',error:'x'}));
    await rejects(()=>reduce(cancelled,{type:'start',id:'b'}));
  });
  await test('Complete reducer transition matrix rejects every unspecified state/event pair',async()=>{
    const pending=await initial([{id:'a',duration:1}]);
    const running=await reduce(pending,{type:'start',id:'a'});
    const states={pending,running,succeeded:await reduce(running,{type:'succeed',id:'a'}),failed:await reduce(running,{type:'fail',id:'a',error:'boom'}),cancelled:await reduce(pending,{type:'cancel',id:'a'})};
    const legal={pending:{start:'running',cancel:'cancelled'},running:{succeed:'succeeded',fail:'failed',cancel:'cancelled'},failed:{retry:'pending'},succeeded:{},cancelled:{}};
    for(const [status,state]of Object.entries(states))for(const type of ['start','succeed','fail','retry','cancel']) {
      const event={type,id:'a',error:'boom'};
      if(Object.hasOwn(legal[status],type))assert.equal((await reduce(state,event)).tasks[0].status,legal[status][type]);
      else await rejects(()=>reduce(state,event));
    }
  });
  await test('Reducer executes a deterministic 20-task dependency sequence immutably',async()=>{
    const tasks=Array.from({length:20},(_,index)=>({id:'t'+String(index).padStart(2,'0'),deps:index?['t'+String(index-1).padStart(2,'0')]:[],duration:1}));
    let state=await initial([...tasks].reverse());
    for(const task of tasks){state=await reduce(state,{type:'start',id:task.id});state=await reduce(state,{type:'succeed',id:task.id});}
    assert.ok(state.tasks.every(task=>task.status==='succeeded'&&task.attempts===1&&task.error===null));
  });
}
