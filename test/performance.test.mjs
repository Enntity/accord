// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Collaboration } from '../src/collaboration.mjs';
import { bound,board as compactBoard,resourcePage,find } from '../src/compact.mjs';
import { singleFlight } from '../src/async-work.mjs';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'accord-perf-test-')),s=new Store(join(dir,'store.sqlite'));
 const c=new Collaboration(s,join(dir,'store.sqlite'));s.provision('a','a','worker');s.provision('b','b','worker');s.takeLeadership();for(const id of ['a','b'])c.announce({id},{key:'announce',label:id,activity:'fixture'});
 t.after(()=>{c.close();s.close();rmSync(dir,{recursive:true,force:true});});return {s,c};}
test('incremental JSON budgeting matches full serialization with Unicode and count-width changes',()=>{
 for(let n=1;n<120;n+=7){const value={fixed:'metadata',rows:Array.from({length:n},(_,i)=>({id:i,text:'🦉"\\\n'.repeat(i%17)}))};
  for(const max of [100,512,1024,8192]){const expected=structuredClone(value);while(Buffer.byteLength(JSON.stringify(expected))>max&&expected.rows.length){expected.rows.pop();expected.omitted=(expected.omitted??0)+1;}
   assert.deepEqual(bound(structuredClone(value),max,[['rows','omitted']]),expected);}}
});
test('inbox pages preserve complete Unicode bodies and survive acknowledgements between pages',t=>{
 const {s,c}=fixture(t),recipient=s.authority+'/b',expected=[];
 for(let i=0;i<31;i++){const id='message-'+i;expected.push(id);c.deliver({id,from:s.authority+'/a',to:recipient,text:'界'.repeat(4000),kind:'message'});}
 s.db.prepare('SELECT 1').get();const seen=[];let cursor;
 do {const page=c.inboxPage({id:'b'},{limit:7,...(cursor?{cursor}:{})});assert(Buffer.byteLength(JSON.stringify(page))<=24*1024);
  assert(page.messages.length);for(const m of page.messages){assert.equal(m.text,'界'.repeat(4000));seen.push(m.id);c.read({id:'b'},{deliveryId:m.deliveryId});}
  cursor=page.cursor;
 }while(cursor);
 assert.deepEqual(seen.sort(),expected.sort());assert.equal(c.pendingCount({id:'b'}),0);
 assert.throws(()=>c.inboxPage({id:'b'},{cursor:'invalid'}),{code:'NOT_OWNER'});
 assert.throws(()=>c.inboxPage({id:'b'},{limit:0}),{code:'INVALID_INPUT'});
});
test('inbox paging never acknowledges and does not expose another recipient',t=>{
 const {s,c}=fixture(t);c.deliver({id:'one',from:s.authority+'/a',to:s.authority+'/b',text:'whole message',kind:'notification'});
 const first=c.inboxPage({id:'b'});assert.deepEqual(c.inboxPage({id:'b'}),first);assert.equal(c.pendingCount({id:'b'}),1);assert.equal(c.inboxPage({id:'a'}).messages.length,0);
 assert.throws(()=>c.inboxPage({id:'a'},{cursor:first.messages[0].deliveryId}),{code:'NOT_OWNER'});
});
test('board history pages retain every task and current view excludes completed history',t=>{
 const {s}=fixture(t),actor={id:'a'};const ids=[];
 for(let i=0;i<31;i++){ids.push(s.submit(actor,{key:'task'+i,title:'task '+i,input:'preserved input',expectedHash:'0'.repeat(64)}).taskId);}
 s.db.prepare("UPDATE tasks SET state='succeeded' WHERE id!=?").run(ids[0]);
 assert.deepEqual(s.board(0,{active:true}).tasks.map(t=>t.id),[ids[0]]);
 const seen=[];let before;do{const page=s.board(0,{limit:7,...(before?{before}:{})});seen.push(...page.tasks.map(t=>t.id));assert(page.tasks.every(t=>t.input==='preserved input'));before=page.nextBefore;}while(before);
 assert.deepEqual(seen.sort(),ids.sort());const full=s.board();assert.equal(full.tasks.length,31);assert.equal(compactBoard(full).tasks[0].input,undefined);
});
test('pending work and queue queries use working-set indexes after an additive upgrade',t=>{
 const {s}=fixture(t),checksums=s.db.prepare('SELECT * FROM migrations WHERE version<=16').all();
 assert.equal(checksums.length,16);assert.equal(s.db.prepare('SELECT count(*) n FROM migrations').get().n,22);
 assert.match(s.db.prepare("EXPLAIN QUERY PLAN SELECT * FROM claims WHERE state IN ('preparing','releasing','revoking') ORDER BY created_at").all().map(r=>r.detail).join(' '),/claims_pending/);
 assert.match(s.db.prepare("EXPLAIN QUERY PLAN SELECT * FROM tasks WHERE state='queued' ORDER BY created_at,rowid").all().map(r=>r.detail).join(' '),/tasks_queued/);
});
test('shared observations coalesce only concurrent reads and recover after failure',async()=>{
 let calls=0,release;const read=singleFlight(async()=>{calls++;await new Promise(r=>{release=r;});return calls;});
 const a=read(),b=read();await Promise.resolve();assert.equal(calls,1);release();assert.equal(await a,await b);
 const c=read();await Promise.resolve();release();assert.equal(await c,2);
 let tries=0;const failing=singleFlight(()=>{if(++tries===1)throw Error('offline');return 3;});await assert.rejects(failing());assert.equal(await failing(),3);
});
test('slow driver work does not block a later independent reservation',async t=>{
 const {coordinator}=await import('../src/server.mjs'),{listen}=await import('../src/common.mjs'),{AccordClient}=await import('../src/client.mjs');
 const dir=mkdtempSync(join(tmpdir(),'accord-concurrent-test-'));let releaseSlow,started;
 const ready=new Promise(r=>{started=r;});
 const host=coordinator({db:join(dir,'store.sqlite'),claimSecret:'fixture',driverToken:'fixture',driverInstance:'fixture',driverUrl:'http://127.0.0.1:1',
  driverRequest:async(url,token,path,body)=>{if(body.claimId&&path.startsWith('/control/activate')&&path.includes('slow')){started();await new Promise(r=>{releaseSlow=r;});}return {...body,active:true,released:true};}});
 const url=await listen(host.server);t.after(async()=>{releaseSlow?.();await host.close();rmSync(dir,{recursive:true,force:true});});
 host.store.provision('a','fixture','worker');host.store.provision('admin','admin','admin');
 for(const id of ['slow','fast'])host.store.registerResource({id:'admin',role:'admin'},{key:id},{id,instance:'fixture',plugin:'cooperative',asset:'fixture:'+id,enforcement:'fixture'});
 const client=new AccordClient(url,'fixture');await client.reserve('slow',{key:'slow',durationMs:60000});await ready;
 const fast=await client.reserve('fast',{key:'fast',durationMs:60000});
 const {eventually}=await import('./helpers.mjs');await eventually(async()=>(await client.reservation(fast.id)).state==='running');
 assert(releaseSlow,'the slow operation is still waiting on its independent driver');
 releaseSlow();releaseSlow=null;
});

test('resource pages retain all holders, pool capacities, unknown states and notices',()=>{
 const resources=Array.from({length:64},(_,i)=>({id:'host/r'+String(i).padStart(2,'0'),plugin:'managed-http',state:i%2?'held':'unknown',enforcement:'provider-confirmed',hosts:['fixture'],holder:i%2?{address:'host/a',deadline:123}:null}));
 const result={resources,pools:[{id:'host/pool',capacity:32,free:7,queued:3}],inboxPending:2},seen=[];let cursor;
 do{const page=resourcePage(result,{cursor,limit:7});assert(Buffer.byteLength(JSON.stringify(page))<=8192);assert.equal(page.inboxPending,2);seen.push(...page.resources,...(page.pools??[]));cursor=page.cursor;}while(cursor);
 assert.equal(seen.length,65);assert.equal(new Set(seen.map(r=>r.id)).size,65);assert.equal(seen.find(r=>r.id==='host/pool').capacity,32);assert.equal(seen.find(r=>r.id==='host/r01').holder.deadline,123);
});
test('find includes the empty participant array in its byte budget',()=>{
 for(let n=30;n<80;n++){const view=find({participants:[],resources:Array.from({length:n},(_,i)=>({id:'host/'+i,state:'unknown',enforcement:'x'.repeat(n)}))});assert(Buffer.byteLength(JSON.stringify(view))<=8192);}
});
test('lightweight window checks avoid catalogs and transport errors never authorize fallback',async()=>{
 const {AccordClient}=await import('../src/client.mjs');const client=new AccordClient('http://127.0.0.1:1','fixture'),calls=[];
 client.collaborate=async operation=>{calls.push(operation);return operation==='capabilities'?{capabilities:['reservation-windows-v1']}:{id:'fixture'};};
 await client.reserve('fixture');await client.extend('fixture');assert.deepEqual(calls,['capabilities','reserve','capabilities','renew']);
 client.collaborate=async operation=>{calls.push(operation);throw Object.assign(Error('offline'),{code:'UNAVAILABLE'});};
 const prior=calls.length;await assert.rejects(client.reserve('fixture'),{code:'UNAVAILABLE'});assert.deepEqual(calls.slice(prior),['capabilities']);
});
test('session activity can page backwards without losing the full event bodies',async t=>{
 const {SessionAwareness}=await import('../src/session-awareness.mjs'),{s}=fixture(t),awareness=new SessionAwareness(s),actor={id:'a',role:'worker'};
 awareness.report(actor,{key:'report',title:'Fixture',state:'working',events:Array.from({length:30},(_,i)=>({key:'event-'+i,text:'complete event '+i}))});
 const newest=awareness.read('a',{limit:7}),older=awareness.read('a',{limit:7,before:newest.previous});
 assert.equal(newest.events.length,7);assert.equal(older.events.length,7);assert(older.events.at(-1).seq<newest.events[0].seq);assert.match(newest.events.at(-1).body,/complete event 29/);
});


test('resource paging distinguishes a pool and resource with the same displayed ID',()=>{
 const catalog={resources:[{id:'host/shared',plugin:'cooperative',state:'unknown'}],pools:[{id:'host/shared',capacity:2,free:1}]};
 const first=resourcePage(catalog,{limit:1}),second=resourcePage(catalog,{limit:1,cursor:first.cursor});
 assert.equal((first.resources.length+(first.pools?.length??0)),1);
 assert.equal((second.resources.length+(second.pools?.length??0)),1);
 assert.equal([first,second].flatMap(p=>p.resources).length,1);assert.equal([first,second].flatMap(p=>p.pools??[]).length,1);
 assert.equal(second.cursor,undefined);
});
test('an oversized board event retains its position for an explicit detail read',()=>{
 const view=compactBoard({tasks:[],claims:[],sessions:[],resources:[],events:[{seq:101,data:'z'.repeat(30000)}],cursor:101,hasMore:false});
 assert.equal(view.events.length,0);assert.equal(view.cursor,100);assert.equal(view.hasMore,true);assert.equal(view.moreEvents,1);
});
