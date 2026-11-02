// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrap,find,resources } from '../src/compact.mjs';

const person=(n,extra={})=>({kind:'participant',state:'working',address:'host/'+n,label:'Agent '+n,activity:'x'.repeat(1000),location:'',capabilities:[],harness:'mcp',presence:'recent',lastSeen:n,...extra});
const hosts=[{authority:'a',status:'observed'},{authority:'b',status:'observed'},{authority:'b',status:'observed'},{authority:'c',status:'unknown'}];

test('a join stays near 1000 characters with a busy directory',()=>{
  const view=bootstrap({address:'host/me',participants:Array.from({length:8},(_,n)=>person(n)),recent:30,hosts,resourceList:[{id:'h/artifact',localId:'artifact',plugin:'artifact',state:'unclaimed',holder:null}],observed:143,inboxPending:4});
  assert.ok(JSON.stringify(view).length<1100,JSON.stringify(view).length);
  assert.equal(view.participants.length,5);assert.equal(view.moreParticipants,25);
  assert.deepEqual(view.hosts,['a','b','c']);assert.deepEqual(view.unknownHosts,['c']);
  assert.equal('resources' in view,false,'an idle legacy slot is noise');assert.equal(view.inboxPending,4);
});

test('defaults and empties cost nothing',()=>{
  const row=bootstrap({address:'h/me',participants:[person(1,{activity:'short'})]}).participants[0];
  assert.deepEqual(Object.keys(row),['address','label','activity']);
});

test('find ranks live peers first, hides offline ones unless searched, and never repeats a row',()=>{
  const list=[person(1,{presence:'offline'}),person(2,{presence:'unknown'}),person(3)];
  const plain=find({participants:list,observations:[{},{}],hosts:[{authority:'a',status:'observed',participants:list}]});
  assert.deepEqual(plain.participants.map(p=>p.label),['Agent 3','Agent 2']);assert.equal(plain.observed,2);
  assert.equal(find({participants:list},'Agent').participants.length,3);
  const many=find({participants:Array.from({length:60},(_,n)=>person(n)),hosts:[]});
  assert.equal(many.participants.length,12);assert.equal(many.moreParticipants,48);
  assert.ok(JSON.stringify(many).length<3600);
  assert.equal(find({participants:Array.from({length:60},(_,n)=>person(n))},'Agent').participants.length,20,'a search can reach further');
});

test('same-named pools on two hosts stay separate, and a supplied summary wins over a truncated list',()=>{
  const slot=(h,i)=>({id:`${h}/gpu-${i}`,localId:'gpu-'+i,pool:'gpu',plugin:'cooperative',state:'unclaimed',holder:null});
  assert.deepEqual(resources([slot('a',0),slot('a',1),slot('b',0)]).pools.map(p=>[p.id,p.capacity]),[['a/gpu',2],['b/gpu',1]]);
  assert.equal(resources([slot('a',0)],[{id:'a/gpu',capacity:16,free:16,queued:0}]).pools[0].capacity,16);
});

test('find keeps linked-host resources and their holders',()=>{
  const r={id:'b/gpu',localId:'gpu',plugin:'managed-http',state:'held',hosts:['s3'],queue:[{}],holder:{label:'Job',address:'b/x',deadline:9,state:'running',claim:'secret-claim'}};
  const view=find({participants:[],hosts:[{authority:'b',status:'observed',resources:[r]}]});
  assert.deepEqual(view.resources,[{id:'b/gpu',state:'held',plugin:'managed-http',hosts:['s3'],queued:1,holder:{label:'Job',address:'b/x',deadline:9}}]);
});

test('pools collapse to one summary with held slots still attributed',()=>{
  const slot=(i,held)=>({id:'h/gpu-'+i,localId:'gpu-'+i,pool:'gpu',plugin:'cooperative',state:held?'held':'unclaimed',holder:held?{label:'A',address:'h/a',state:'running'}:null});
  const view=resources([slot(0,true),slot(1,false),slot(2,false)]);
  assert.deepEqual(view.pools,[{id:'h/gpu',capacity:3,free:2}]);assert.equal(view.resources.length,1);assert.equal(view.resources[0].pool,'gpu');
});

test('the tool list and skill stay small enough for every session to carry',async()=>{
  const {listedTools}=await import('../src/mcp.mjs'),{readFileSync}=await import('node:fs');
  assert.ok(JSON.stringify(listedTools()).length<4000);assert.equal(listedTools().length,12);
  assert.ok(readFileSync(new URL('../skills/accord/SKILL.md',import.meta.url),'utf8').length<1500);
});

test('service and bridge shaping preserve unknown states, limits, and unread notices',()=>{
  const raw={participants:Array.from({length:60},(_,n)=>person(n,{activity:'🦉'.repeat(1000),capabilities:['🦉'.repeat(2000)]})),
    observations:Array.from({length:90},()=>({})),inboxPending:3,hosts:[{authority:'offline',status:'unknown',reason:'HOST_UNAVAILABLE'},
      {authority:'h',status:'observed',resources:[{id:'h/artifact',localId:'artifact',plugin:'artifact',state:'unknown',enforcement:'Driver unreachable'}]}]};
  const once=find(raw),twice=find(once);
  assert(Buffer.byteLength(JSON.stringify(once))<=8192);
  assert.deepEqual(twice,once);
  assert.equal(once.participants.length+once.moreParticipants,60);
  assert.equal(once.observed,90);assert.equal(once.inboxPending,3);
  assert.equal(once.resources[0].state,'unknown');assert.equal(once.resources[0].enforcement,'Driver unreachable');
  assert.equal(once.hosts[0].status,'unknown');assert(!once.hosts.some(h=>h.participants));
});

test('a pool keeps its real capacity through the service and bridge passes',()=>{
  const slot=i=>({id:'h/gpu-'+i,localId:'gpu-'+i,pool:'gpu',plugin:'cooperative',state:'unclaimed',holder:null});
  const once=find({participants:[],hosts:[{authority:'h',status:'observed',resources:Array.from({length:16},(_,i)=>slot(i))}]});
  assert.deepEqual(once.pools,[{id:'h/gpu',capacity:16,free:16}]);assert.deepEqual(find(once),once);
});

test('a join reports the service pool summary rather than its truncated slot preview',()=>{
  const view=bootstrap({address:'h/me',resourceList:[{id:'h/gpu-0',localId:'gpu-0',pool:'gpu',plugin:'cooperative',state:'unclaimed'}],pools:[{id:'h/gpu',capacity:16,free:16}]});
  assert.equal(view.pools[0].capacity,16);
});

test('the find bound also covers pools, and counts what it dropped',()=>{
  const slot=(h,i)=>({id:`${h}/p${i}-0`,localId:`p${i}-0`,pool:'p'+i,plugin:'cooperative',state:'unclaimed'});
  const hosts=Array.from({length:40},(_,h)=>({authority:'host'+h,status:'observed',resources:Array.from({length:20},(_,i)=>slot('host'+h,i))}));
  const view=find({participants:[],hosts});
  assert(Buffer.byteLength(JSON.stringify(view))<=8192);assert.equal(view.pools.length+view.moreResources,800);
});
