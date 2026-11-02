// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harness,eventually,stop,delay,link } from './helpers.mjs';
import { request,token } from '../src/common.mjs';
import { groupExists } from '../src/plugins/posix-process-group.mjs';

async function announce(c,label){const b=await c.bootstrap();await c.announce({label,activity:'reviewing demo',capabilities:['review'],location:'/demo'});return b.address;}

test('directory and durable inbox follow Tessera conventions; dedup and read ownership survive restart',async t=>{
  const h=await harness();t.after(()=>h.close());const a=h.client('agent-a'),b=h.client('agent-b');
  const aa=await announce(a,'one'),bb=await announce(b,'two');
  assert.equal((await a.find('review')).participants.length,1);
  const outgoing=await a.send(bb,'hello',{key:'hello'});
  assert.equal((await a.send(bb,'hello',{key:'hello'})).id,outgoing.id);
  await assert.rejects(a.send(bb,'different',{key:'hello'}),{code:'KEY_REUSED'});
  const inbox=await eventually(async()=>{const x=await b.inbox();return x.messages.length&&x;});
  assert.equal(inbox.messages.length,1);assert.equal(inbox.messages[0].from,aa);
  await assert.rejects(a.read(inbox.messages[0].deliveryId));
  const port=Number(new URL(h.url).port);await stop(h.server,'SIGKILL');await delay(h.leaderMs+100);await h.startServer(port);
  assert.deepEqual((await b.inbox()).messages,inbox.messages);
  await b.read(inbox.messages[0].deliveryId);await b.read(inbox.messages[0].deliveryId);
  assert.equal((await b.inbox()).messages.length,0);
  assert.equal((await a.sent(outgoing.id)).state,'delivered');
});

test('linked hosts discover, message both ways, retain outgoing mail offline, and reject sender forgery',async t=>{
  const a=await harness(),b=await harness();t.after(async()=>{await a.close();await b.close();});
  const links=await link(a,b),ca=a.client('agent-a'),cb=b.client('agent-b');
  const aa=await announce(ca,'local reviewer'),bb=await announce(cb,'remote manager');
  assert((await ca.find('remote manager')).participants.some(p=>p.address===bb));
  await assert.rejects(request(b.url,links.y,'/v1/federation',{operation:'deliver',actor:'agent-a',args:{id:'forged',from:bb,to:bb,text:'forged'}}),{code:'FORBIDDEN'});
  await assert.rejects(request(b.url,b.credential('discovery'),'/v1/federation',{operation:'directory',actor:'x',args:{}}),{code:'FORBIDDEN'});
  await ca.send(bb,'request');const incoming=await eventually(async()=>{const m=(await cb.inbox()).messages;return m.length&&m[0];});
  await cb.read(incoming.deliveryId);await cb.send(incoming.from,'reply',{kind:'notification'});
  assert.equal((await eventually(async()=>{const m=(await ca.inbox()).messages;return m.length&&m[0];})).text,'reply');
  const port=Number(new URL(b.url).port);await stop(b.server,'SIGKILL');
  const queued=await ca.send(bb,'while offline');await delay(1100);
  assert.equal((await ca.sent(queued.id)).state,'queued');
  assert.equal((await ca.find()).hosts.find(h=>h.authority===links.bb).status,'unknown');
  // Kill sender too: durable outbox must resume without an agent re-sending.
  const aport=Number(new URL(a.url).port);await stop(a.server,'SIGKILL');await delay(a.leaderMs+100);await a.startServer(aport);await b.startServer(port);
  const recovered=await eventually(async()=>{const m=(await cb.inbox()).messages;return m.find(m=>m.text==='while offline');});
  assert.equal(recovered.from,aa);await delay(1200);assert.equal((await cb.inbox()).messages.length,1);
});

test('thin remote reservations queue FIFO and stop old process before regrant after driver crash',async t=>{
  const a=await harness(),b=await harness(),groups=[];
  t.after(async()=>{for(const pid of groups)try{process.kill(-pid,'SIGKILL');}catch{}await a.close();await b.close();});
  const {bb}=await link(a,b),ca=a.client('agent-a'),cb=b.client('agent-b');await announce(ca,'one');await announce(cb,'two');
  await b.client('admin').registerResource({schema:1,id:'slot',asset:'test:slot',plugin:'posix-process-group',command:[process.execPath,fileURLToPath(new URL('./fixtures/workload.mjs',import.meta.url)),'tree'],cwd:b.data,env:{},terminationGraceMs:80});
  const r=await ca.reserve(`${bb}/slot`,{key:'reserve',leaseMs:3000});
  assert.equal((await ca.reserve(`${bb}/slot`,{key:'reserve',leaseMs:3000})).id,r.id);
  await eventually(async()=>(await ca.reservation(r.id,bb)).state==='running');
  const run=await ca.collaborate('start',{id:r.id,key:'start'},bb);groups.push(run.pgid);assert(groupExists(run.pgid));
  const next=await cb.reserve('slot',{key:'second',leaseMs:10000});
  await delay(200);assert.equal((await cb.reservation(next.id)).state,'queued');
  await assert.rejects(cb.reservation(r.id),{code:'NOT_OWNER'});
  const port=Number(new URL(b.driverUrl).port);await stop(b.driver,'SIGKILL');
  await ca.release(r.id,{host:bb});await delay(250);assert(groupExists(run.pgid));
  assert.equal((await cb.reservation(next.id)).state,'queued');
  await b.startDriver(port);
  await eventually(async()=>(await cb.reservation(next.id)).state==='running');assert.equal(groupExists(run.pgid),false);
  await assert.rejects(ca.collaborate('start',{id:r.id,key:'late'},bb),{code:'STALE_CLAIM'});
  await cb.release(next.id);await eventually(async()=>(await cb.reservation(next.id)).state==='released');
  const audit=(await request(b.driverUrl,b.credential('driver-control'),'/control/audit?resource=slot')).events;
  const stopped=audit.findIndex(e=>e.kind==='process.stopped'),grants=audit.map((e,i)=>e.kind==='grant.active'?i:-1).filter(i=>i>=0);
  assert.equal(grants.length,2);assert(stopped>=0&&stopped<grants[1]);
});

test('queued cancellations, session end, coordinator restart, and lease expiry do not resurrect a reservation',async t=>{
  const h=await harness();t.after(()=>h.close());const a=h.client('agent-a'),b=h.client('agent-b');
  const r=await a.reserve('artifact',{leaseMs:5000}),q=await b.reserve('artifact');
  await eventually(async()=>(await a.reservation(r.id)).state==='running');
  await b.release(q.id);assert.equal((await b.reservation(q.id)).state,'cancelled');
  const port=Number(new URL(h.url).port);await stop(h.server,'SIGKILL');await delay(h.leaderMs+100);await h.startServer(port);
  await eventually(async()=>(await a.reservation(r.id)).state==='failed');
  const fresh=await b.reserve('artifact',{leaseMs:600});await eventually(async()=>(await b.reservation(fresh.id)).state==='running');
  await eventually(async()=>(await b.reservation(fresh.id)).state==='failed');
  assert.equal((await b.reservation(q.id)).state,'cancelled');
});

test('generic cooperative resources require only a name and asset; enforcement stays explicit',async t=>{
  const h=await harness();t.after(()=>h.close());const a=h.client('agent-a');
  await h.client('admin').registerResource({schema:1,id:'repo',asset:'repo:example',plugin:'cooperative'});
  assert((await a.resources()).resources.find(r=>r.localId==='repo').enforcement.includes('no external process'));
  const r=await a.reserve('repo',{purpose:'editing'});await eventually(async()=>(await a.reservation(r.id)).state==='running');
  await assert.rejects(a.collaborate('start',{id:r.id,key:'no-process'}),{code:'WRONG_DRIVER'});
  await a.release(r.id);await eventually(async()=>(await a.reservation(r.id)).state==='released');
});

test('legacy claim API cannot jump an earlier reservation even when the resource is free',async t=>{
  const { Store }=await import('../src/store.mjs'),{ Collaboration }=await import('../src/collaboration.mjs');
  const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os');
  const dir=mkdtempSync(join(tmpdir(),'accord-fifo-')),file=join(dir,'coordinator.sqlite'),store=new Store(file);store.takeLeadership();
  const c=new Collaboration(store,file);t.after(()=>{c.close();store.close();rmSync(dir,{recursive:true,force:true});});
  store.provision('a','a-token','worker');store.provision('b','b-token','worker');
  const a={id:'a',role:'worker'},b={id:'b',role:'worker'};
  c.reserve(a,{key:'first',resource:'artifact'});const second=c.reserve(b,{key:'second',resource:'artifact'});
  const task=store.db.prepare('SELECT task_id FROM reservations WHERE id=?').get(second.id);
  await assert.rejects(async()=>store.acquire(b,{key:'bypass',taskId:task.task_id}),{code:'RESOURCE_BUSY'});
  c.schedule();assert.equal(store.pending()[0].actor,'a');
});

test('jobs follow remote reservations and keep the authenticated holder boundary',async t=>{
 const a=await harness(),b=await harness();t.after(async()=>{await a.close();await b.close();});
 const {aa,bb}=await link(a,b),ca=a.client('agent-a'),cb=b.client('agent-b');
 await request(b.url,b.credential('admin'),'/v1/links/share',{key:randomUUID(),authority:aa,share:true});
 const r=await ca.reserve('artifact',{host:bb,leaseMs:10000});
 const j=await ca.collaborate('job',{key:'remote-job',title:'Remote work',reservationId:r.id,state:'working'},bb);
 assert((await ca.collaborate('jobs',{},bb)).jobs.some(x=>x.id===j.id));
 await assert.rejects(cb.collaborate('job',{key:'forged-attach',title:'Forged',reservationId:r.id}),{code:'NOT_OWNER'});
 await assert.rejects(cb.collaborate('job',{key:'forged-update',id:j.id,state:'done'}),{code:'NOT_OWNER'});
 await ca.collaborate('job',{key:'remote-done',id:j.id,state:'done'},bb);
 assert((await ca.collaborate('jobs',{},bb)).jobs.some(x=>x.id===j.id&&x.state==='done'));
 await ca.release(r.id,{host:bb});
});
