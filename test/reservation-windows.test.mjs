// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';
import { Collaboration } from '../src/collaboration.mjs';
import { AccordClient } from '../src/client.mjs';
import { createHttp, listen, readBody } from '../src/common.mjs';
import { harness, eventually, link, stop, delay } from './helpers.mjs';

const minute = 60000;
test('v15 upgrade preserves an existing heartbeat deadline, generation and command history',t=>{
  const dir=mkdtempSync(join(tmpdir(),'accord-window-upgrade-')),file=join(dir,'store.sqlite');
  const old=new Store(file,{now:()=>0});old.takeLeadership();old.provision('a','secret','worker');
  const c=new Collaboration(old,file),actor={id:'a',role:'worker'};
  const r=c.reserve(actor,{key:'old-reserve',resource:'artifact',leaseMs:300000});c.schedule();
  const before=c.reservation(actor,r.id),commands=old.db.prepare('SELECT * FROM commands').all();
  c.close();old.close();
  const v15=new DatabaseSync(file);
  v15.exec('ALTER TABLE reservations DROP COLUMN duration_ms; DELETE FROM migrations WHERE version=16');
  const checksums=v15.prepare('SELECT * FROM migrations').all();v15.close();
  const upgraded=new Store(file,{now:()=>0});
  t.after(()=>{upgraded.close();rmSync(dir,{recursive:true,force:true});});
  assert.deepEqual(upgraded.db.prepare('SELECT * FROM migrations WHERE version<=15').all(),checksums);
  assert.deepEqual(upgraded.db.prepare('SELECT * FROM commands').all(),commands);
  assert.equal(upgraded.claim(before.claimId).deadline,before.deadline);
  assert.equal(upgraded.claim(before.claimId).generation,before.generation);
  assert.equal(upgraded.db.prepare('SELECT duration_ms FROM reservations WHERE id=?').get(r.id).duration_ms,null);
});

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'accord-window-')),file=join(dir,'store.sqlite');
  let now=0;
  const store=new Store(file,{now:()=>now,leaderMs:2*86400000});
  store.takeLeadership();store.provision('a','a-secret','worker');store.provision('b','b-secret','worker');
  const c=new Collaboration(store,file),a={id:'a',role:'worker'},b={id:'b',role:'worker'};
  t.after(()=>{c.close();store.close();rmSync(dir,{recursive:true,force:true});});
  const reserve=(body={})=>{
    const r=c.reserve(a,{key:'reserve',resource:'artifact',durationMs:90*minute,...body});
    c.schedule();return c.reservation(a,r.id);
  };
  return {store,c,a,b,reserve,time:n=>{now=n;}};
}

test('a 90-minute window survives chat silence and slow preparation, then expires without regrant',t=>{
  const {store,c,a,b,reserve,time}=fixture(t),r=reserve();
  assert.equal(r.mode,'window');assert.equal(r.renewalRequired,false);assert.equal(r.deadline,90*minute);
  time(10*minute);store.sweep();assert.equal(store.claim(r.claimId).state,'preparing');
  store.activated(r.claimId);time(89*minute);store.sweep();
  assert.equal(c.reservation(a,r.id).state,'running');
  const q=c.reserve(b,{key:'next',resource:'artifact',durationMs:minute});c.schedule();
  assert.equal(c.reservation(b,q.id).state,'queued');
  time(90*minute);store.sweep();c.schedule();
  assert.equal(store.claim(r.claimId).state,'revoking');assert.equal(c.reservation(b,q.id).state,'queued');
  assert.throws(()=>store.renew(a,r.claimId,{key:'late',durationMs:minute}),{code:'STALE_CLAIM'});
  store.released(r.claimId);c.schedule();
  assert.equal(c.reservation(a,r.id).state,'failed');
  assert.equal(c.reservation(b,q.id).generation,2);
  assert.equal(c.reservation(b,q.id).deadline,91*minute,'queue time does not consume the window');
});

test('converting a live heartbeat and extending a window keeps the claim and generation; retries never slide the deadline',t=>{
  const {store,c,a,b,reserve,time}=fixture(t),r=reserve({durationMs:undefined,leaseMs:5*minute});
  store.activated(r.claimId);time(4*minute);
  assert.throws(()=>store.renew(b,r.claimId,{key:'foreign',durationMs:90*minute}),{code:'NOT_OWNER'});
  const body={key:'window',durationMs:90*minute},result=store.renew(a,r.claimId,body);
  assert.equal(result.deadline,94*minute);
  time(20*minute);assert.deepEqual(store.renew(a,r.claimId,body),result);
  assert.throws(()=>store.renew(a,r.claimId,{...body,durationMs:minute}),{code:'KEY_REUSED'});
  const current=c.reservation(a,r.id);
  assert.equal(current.claimId,r.claimId);assert.equal(current.generation,r.generation);assert.equal(current.mode,'window');
  assert.equal(current.renewalRequired,false);assert.equal(current.state,'running');
  assert.equal(store.renew(a,r.claimId,{key:'shorter',durationMs:minute}).deadline,result.deadline,'extension cannot shorten a window');
  assert.equal(store.renew(a,r.claimId,{key:'longer',durationMs:90*minute}).deadline,110*minute);
  c.release(a,r.id,{key:'release'});
  assert.throws(()=>store.renew(a,r.claimId,{key:'after-release',durationMs:minute}),{code:'STALE_CLAIM'});
});

test('windows obey input bounds and resource ownership policy, including policy changes while queued',t=>{
  const {store,c,a,reserve}=fixture(t);
  for(const body of [{durationMs:0},{durationMs:2592000001},{durationMs:NaN},{durationMs:minute,leaseMs:minute}])
    assert.throws(()=>c.reserve(a,{key:'bad',resource:'artifact',...body}),{code:'INVALID_INPUT'});
  assert.throws(()=>reserve({durationMs:9*3600000}),{code:'ATTEMPT_LIMIT'});
  const admin={id:'admin',role:'admin'},binding={id:'pair',instance:'pair',plugin:'managed-http',asset:'fixture:pair',enforcement:'test'};
  store.registerResource(admin,{key:'bind'}, {...binding,maxOwnershipMs:2*3600000});
  const r=c.reserve(a,{key:'queued',resource:'pair',durationMs:90*minute});
  store.registerResource(admin,{key:'reduce'}, {...binding,maxOwnershipMs:minute});
  c.schedule();assert.equal(c.reservation(a,r.id).state,'failed');assert.equal(c.reservation(a,r.id).claimId,null);
  const active=reserve({key:'valid'});store.activated(active.claimId);
  assert.throws(()=>store.renew(a,active.claimId,{key:'too-long',durationMs:9*3600000}),{code:'ATTEMPT_LIMIT'});
});

test('session revocation and an ended window still revoke bounded windows',t=>{
  const {store,reserve,time}=fixture(t),r=reserve();store.activated(r.claimId);
  store.revokeSession('a');assert.equal(store.claim(r.claimId).state,'revoking');store.released(r.claimId);
  const next=reserve({key:'second'});store.activated(next.claimId);
  time(2*86400000+1);store.takeLeadership();assert.equal(store.claim(next.claimId).state,'revoking');
});

test('a coordinator restart resumes an unexpired window under the same claim, and still fences heartbeats and tasks',t=>{
  const {store,c,a,reserve,time}=fixture(t),admin={id:'admin',role:'admin'};
  const bind=id=>store.registerResource(admin,{key:`bind:${id}`},{id,instance:id,plugin:'cooperative',asset:`fixture:${id}`,enforcement:'test'});
  bind('beat');bind('job');
  const window=reserve();store.activated(window.claimId);
  const beat=c.reserve(a,{key:'beat',resource:'beat',leaseMs:5*minute});c.schedule();
  const beatClaim=c.reservation(a,beat.id).claimId;store.activated(beatClaim);
  const {taskId}=store.submit(admin,{key:'job',title:'job',input:'x',resource:'job',expectedHash:'0'.repeat(64)});
  const job=store.acquire(a,{key:'take-job',taskId,leaseMs:30000});store.activated(job.claimId);
  // An OOM kill or supervisor restart: the lease lapses and a new epoch takes over.
  time(10*minute);store.releaseLeadership();store.takeLeadership();
  const resumed=store.claim(window.claimId);
  assert.equal(resumed.state,'preparing','the driver must reconfirm before access resumes');
  assert.equal(resumed.generation,window.generation);assert.equal(resumed.deadline,window.deadline);
  assert.equal(c.reservation(a,window.id).state,'preparing');
  assert.throws(()=>store.owned(a,window.claimId,true),{code:'STALE_CLAIM'});
  store.activated(window.claimId);
  assert.equal(c.reservation(a,window.id).state,'running');
  assert.equal(store.renew(a,window.claimId,{key:'extend',durationMs:120*minute}).deadline,130*minute);
  assert.equal(store.claim(beatClaim).state,'revoking');assert.equal(store.claim(job.claimId).state,'revoking');
  // A driver that cannot resume the generation sends it back through revocation.
  store.releaseLeadership();store.takeLeadership();store.refused(window.claimId,'REVOKED');
  assert.equal(store.claim(window.claimId).state,'revoking');store.released(window.claimId);
  assert.equal(c.reservation(a,window.id).state,'failed');
});

test('new clients refuse window requests on old hosts before mutating, while explicit heartbeat clients remain compatible',async()=>{
  const c=new AccordClient('http://127.0.0.1:1','fixture'),calls=[];
  c.collaborate=async(op,args,host)=>{calls.push({op,args,host});return op==='resources'?{resources:[]}:{id:'r'};};
  await assert.rejects(c.reserve('remote/pair'),{code:'WINDOW_UNSUPPORTED'});
  await assert.rejects(c.extend('r',{host:'remote',durationMs:90*minute}),{code:'WINDOW_UNSUPPORTED'});
  assert(calls.every(x=>x.op==='resources'&&x.host==='remote'));
  await c.reserve('remote/pair',{leaseMs:minute});assert.equal(calls.at(-1).op,'reserve');
  await c.extend('r',{leaseMs:minute});assert.equal(calls.at(-1).op,'renew');
  const count=calls.length;
  await assert.rejects(c.reserve('pair',{durationMs:minute,leaseMs:minute}),{code:'INVALID_INPUT'});
  assert.equal(calls.length,count);
});

test('linked managed serving uses one prepare for reserve, start and extension, and gates the next grant on restoration',async t=>{
  const local=await harness(),remote=await harness();t.after(async()=>{await local.close();await remote.close();});
  const {bb}=await link(local,remote),log=[];let blockRestore=true;
  const provider=createHttp(async(req,res,url)=>{
    const body=await readBody(req),action=url.pathname.slice(1);
    if(action==='availability')return {available:true};
    if(action==='restore'&&blockRestore)throw Error('restoration not confirmed');
    log.push(`${action}:${body.generation}`);return {...body,[action]:true};
  });
  const endpoint=await listen(provider);t.after(()=>new Promise(r=>provider.close(r)));
  const tokenFile=join(remote.data,'window-provider.token');writeFileSync(tokenFile,'fixture',{mode:0o600});
  await remote.client('admin').registerResource({schema:1,id:'pair',asset:'fixture:pair',plugin:'managed-http',endpoint,tokenFile});
  const a=local.client('agent-a'),b=remote.client('agent-b');
  const r=await a.reserve(`${bb}/pair`);
  const first=await eventually(async()=>{const s=await a.reservation(r.id,bb);return s.state==='running'&&s;});
  assert.equal(first.mode,'window');assert(first.deadline>Date.now()+59*minute);
  await a.collaborate('start',{id:r.id,key:'start'},bb);
  await a.extend(r.id,{host:bb,durationMs:90*minute,key:'extend'});
  const extended=await a.reservation(r.id,bb);
  assert.equal(extended.generation,first.generation);assert.equal(extended.claimId,first.claimId);
  assert(extended.deadline>first.deadline);assert.deepEqual(log,['prepare:1','start:1']);
  const q=await b.reserve('pair',{durationMs:1000});await a.release(r.id,{host:bb});
  await eventually(()=>log.includes('stop:1'));
  assert.equal((await b.reservation(q.id)).state,'queued');
  blockRestore=false;await eventually(async()=>(await b.reservation(q.id)).state==='running');
  assert(log.indexOf('restore:1')<log.indexOf('prepare:2'));
  await eventually(async()=>(await b.reservation(q.id)).state==='failed');
  assert(log.includes('stop:2'));assert(log.includes('restore:2'));
});

test('preparing reservation renewal preserves identity and cannot revive expiry or evade limits',t=>{
  const {store,c,a,b,reserve,time}=fixture(t),r=reserve({durationMs:undefined,leaseMs:1000});
  time(700);
  assert.throws(()=>store.renew(b,r.claimId,{key:'foreign-prepare',leaseMs:1000}),{code:'NOT_OWNER'});
  assert.equal(store.renew(a,r.claimId,{key:'prepare',leaseMs:1000}).deadline,1700);
  assert.equal(c.reservation(a,r.id).generation,r.generation);
  assert.equal(c.reservation(a,r.id).state,'preparing');
  assert.throws(()=>store.owned(a,r.claimId,true),{code:'STALE_CLAIM'},'renewal must not authorize workload launch');
  assert.throws(()=>store.renew(a,r.claimId,{key:'limit-prepare',durationMs:9*3600000}),{code:'ATTEMPT_LIMIT'});
  time(1700);
  assert.throws(()=>store.renew(a,r.claimId,{key:'expired-prepare',leaseMs:1000}),{code:'STALE_CLAIM'});
});

test('a cooperative window survives a crash of the whole host under the same claim',{timeout:30000},async t=>{
  const h=await harness();t.after(()=>h.close());
  await h.client('admin').registerResource({schema:1,id:'canary',asset:'fixture:canary',plugin:'cooperative'});
  const a=h.client('agent-a'),r=await a.reserve('canary',{durationMs:3600000});
  const before=await eventually(async()=>{const s=await a.reservation(r.id);return s.state==='running'&&s;});
  const serverPort=Number(new URL(h.url).port),driverPort=Number(new URL(h.driverUrl).port);
  await stop(h.server,'SIGKILL');await stop(h.driver,'SIGKILL');await delay(h.leaderMs+50);
  await h.startDriver(driverPort);await h.startServer(serverPort);
  const after=await eventually(async()=>{const s=await a.reservation(r.id);return s.state==='running'&&s;});
  assert.equal(after.claimId,before.claimId);assert.equal(after.generation,before.generation);assert.equal(after.deadline,before.deadline);
  await a.release(r.id);await eventually(async()=>(await a.reservation(r.id)).state==='released');
});

test('a holder that did not release is told when its window ends, and a released holder is not',{timeout:30000},async t=>{
  const h=await harness();t.after(()=>h.close());
  await h.client('admin').registerResource({schema:1,id:'canary',asset:'fixture:canary',plugin:'cooperative'});
  const a=h.client('agent-a');await a.announce({label:'holder',activity:'testing'});
  const kept=await a.reserve('canary',{durationMs:1500});
  const notice=await eventually(async()=>(await a.inbox()).messages.find(m=>m.text.includes(kept.id)));
  assert.match(notice.text,/ended as failed: its deadline passed/);
  const released=await a.reserve('canary',{durationMs:60000});
  await eventually(async()=>(await a.reservation(released.id)).state==='running');
  await a.release(released.id);await eventually(async()=>(await a.reservation(released.id)).state==='released');
  await delay(1500);assert(!(await a.inbox()).messages.some(m=>m.text.includes(released.id)));
});
