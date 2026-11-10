// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialize } from '../src/config.mjs';
import { coordinator } from '../src/server.mjs';
import { Store } from '../src/store.mjs';
import { Collaboration } from '../src/collaboration.mjs';
import { MessengerStore } from '../vendor/messenger/store.js';
import { withReservation } from '../src/client.mjs';
import { createHttp, listen, readBody } from '../src/common.mjs';
import { harness, eventually, delay } from './helpers.mjs';

test('slow mailbox initialization does not consume the coordinator leadership lease',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'accord-startup-')),db=join(dir,'coordinator.sqlite');
  initialize(dir,{fixtures:true});
  let time=1000,migrations=0,service;
  const takeLeadership=Store.prototype.takeLeadership,transaction=MessengerStore.prototype.transaction;
  t.mock.method(Store.prototype,'takeLeadership',function(){this.now=()=>time;return takeLeadership.call(this);});
  t.mock.method(MessengerStore.prototype,'transaction',function(fn){
    // Simulate synchronous mailbox migrations outlasting the normal five-second lease.
    time+=6000;migrations++;return transaction.call(this,fn);
  });
  t.after(async()=>{if(service)await service.close();rmSync(dir,{recursive:true,force:true});});
  service=coordinator({db,claimSecret:'fixture',driverUrl:'http://127.0.0.1:1',driverToken:'fixture',driverInstance:'fixture'});
  assert(migrations>0);service.store.assertLeader();
  assert.equal(service.store.db.prepare('SELECT until_ms FROM leader').get().until_ms,time+5000);
  assert.equal(service.store.db.prepare("SELECT count(*) n FROM events WHERE kind='coordinator.started'").get().n,1);
  // A later stall can renew only while the same coordinator still owns the row.
  time+=5001;service.store.beat();service.store.assertLeader();
});

test('a rejected second coordinator closes its databases and preserves the active leader',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'accord-contender-')),db=join(dir,'coordinator.sqlite');
  initialize(dir,{fixtures:true});
  const options={db,claimSecret:'fixture',driverUrl:'http://127.0.0.1:1',driverToken:'fixture',driverInstance:'fixture'};
  const service=coordinator(options);
  t.after(async()=>{await service.close();rmSync(dir,{recursive:true,force:true});});
  const closeStore=t.mock.method(Store.prototype,'close'),closeMailbox=t.mock.method(MessengerStore.prototype,'close');
  assert.throws(()=>coordinator(options),{code:'LEADER_ACTIVE'});
  assert.equal(closeStore.mock.callCount(),1);assert.equal(closeMailbox.mock.callCount(),1);
  service.store.assertLeader();
  assert.equal(service.store.db.prepare("SELECT count(*) n FROM events WHERE kind='coordinator.started'").get().n,1);
});

test('failed overseer initialization closes both databases and relinquishes leadership',t=>{
  const dir=mkdtempSync(join(tmpdir(),'accord-startup-failed-')),db=join(dir,'coordinator.sqlite');
  initialize(dir,{fixtures:true});t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const failure=Error('fixture initialization failure');
  const mutation=t.mock.method(Store.prototype,'mutate',()=>{throw failure;});
  const closeStore=t.mock.method(Store.prototype,'close'),closeMailbox=t.mock.method(MessengerStore.prototype,'close');
  assert.throws(()=>coordinator({db,claimSecret:'fixture',driverUrl:'http://127.0.0.1:1',driverToken:'fixture',driverInstance:'fixture'}),error=>error===failure);
  assert.equal(closeStore.mock.callCount(),1);assert.equal(closeMailbox.mock.callCount(),1);
  mutation.mock.restore();
  const recovered=new Store(db);
  try {
    assert.equal(recovered.db.prepare('SELECT until_ms FROM leader').get().until_ms,0);
    recovered.takeLeadership();recovered.assertLeader();
  } finally {recovered.releaseLeadership();recovered.close();}
});

test('SQLITE_FULL stops acknowledgments, reports its cause once, and restart fences the old grant',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'accord-full-')),db=join(dir,'coordinator.sqlite');
  initialize(dir,{fixtures:true});
  const service=coordinator({db,claimSecret:'fixture',driverUrl:'http://127.0.0.1:1',driverToken:'fixture',driverInstance:'fixture'});
  const c=new Collaboration(service.store,db),actor={id:'agent-a',role:'worker'};
  const r=c.reserve(actor,{key:'reserve',resource:'artifact',leaseMs:30000});c.schedule();
  const before=c.reservation(actor,r.id);c.close();
  let calls=0;
  // SQLite's real page limit produces SQLITE_FULL without filling the host filesystem.
  const pages=service.store.db.prepare('PRAGMA page_count').get().page_count;
  service.store.db.exec(`PRAGMA max_page_count=${pages}`);
  service.store.beat=()=>{calls++;service.store.db.exec("INSERT INTO events(at,kind,data) VALUES(0,'full',zeroblob(1048576))");};
  const error=await service.failed;
  assert.equal(error.errcode,13);assert.match(error.message,/full/i);
  await delay(600);assert.equal(calls,1,'fatal state must not retry writes in place');
  await service.close();
  const recovered=new Store(db);
  t.after(()=>{recovered.close();rmSync(dir,{recursive:true,force:true});});
  recovered.takeLeadership();
  const claim=recovered.claim(before.claimId);
  assert.equal(claim.state,'revoking');assert.equal(claim.generation,before.generation);
  assert.throws(()=>recovered.renew(actor,claim.id,{key:'revive',leaseMs:30000}),{code:'STALE_CLAIM'});
});

test('supervised heartbeat renews through slow preparation and releases the same generation',async t=>{
  const h=await harness({leaderMs:5000});let prepares=0;
  const provider=createHttp(async(req,res,url)=>{
    const body=await readBody(req),action=url.pathname.slice(1);
    if(action==='availability')return {available:true};
    if(action==='prepare'){prepares++;await delay(1800);}
    return {...body,[action]:true};
  });
  t.after(async()=>{await h.close();provider.closeAllConnections();await new Promise(r=>provider.close(r));});
  const endpoint=await listen(provider),tokenFile=join(h.data,'provider.token');writeFileSync(tokenFile,'fixture');
  await h.client('admin').registerResource({schema:1,id:'slow',asset:'fixture:slow',plugin:'managed-http',endpoint,tokenFile});
  let ran=false;
  await withReservation(h.client('agent-a'),'slow',async({reservationId,signal})=>{
    ran=true;assert.equal((await h.client('agent-a').reservation(reservationId)).state,'running');
    await delay(1200);signal.throwIfAborted();
  },{leaseMs:1000,waitMs:10000});
  assert.equal(ran,true);assert.equal(prepares,1);
  const claims=(await h.client('admin').board()).claims;
  assert.equal(claims.length,1);assert.equal(claims[0].outcome,'released');
});

test('serve exits nonzero after a leadership takeover so the installed supervisor can restart it', {skip:process.platform==='win32'},async t=>{
  const h=await harness({leaderMs:1000});t.after(()=>h.close());
  const old=h.server,client=h.client('agent-a'),r=await client.reserve('artifact',{leaseMs:30000});
  const running=await eventually(async()=>{const s=await client.reservation(r.id);return s.state==='running'&&s;});
  t.after(()=>old.kill('SIGCONT'));
  old.kill('SIGSTOP');await delay(1400);
  const replacement=new Store(join(h.data,'coordinator.sqlite'));
  try { replacement.takeLeadership();replacement.releaseLeadership(); } finally { replacement.close(); }
  old.kill('SIGCONT');
  await eventually(()=>old.exitCode!==null);
  assert.equal(old.exitCode,1);assert.match(old.diagnostic,/coordinator.failed/);assert.match(old.diagnostic,/LEADER_LOST/);
  await h.startServer();
  await eventually(async()=>{const s=await h.client('agent-a').reservation(r.id);return s.state==='failed';});
  const claims=(await h.client('admin').board()).claims;
  assert.equal(claims.find(c=>c.id===running.claimId).state,'closed');
});

test('serve resumes after a stall without losing a live grant or its generation', {skip:process.platform==='win32'},async t=>{
  const h=await harness({leaderMs:1000});t.after(()=>h.close());
  const old=h.server,client=h.client('agent-a'),r=await client.reserve('artifact',{leaseMs:30000});
  const running=await eventually(async()=>{const s=await client.reservation(r.id);return s.state==='running'&&s;});
  t.after(()=>old.kill('SIGCONT'));
  old.kill('SIGSTOP');await delay(1400);old.kill('SIGCONT');
  const resumed=await eventually(async()=>{const s=await client.reservation(r.id);return s.state==='running'&&s;});
  assert.equal(old.exitCode,null);assert.equal(resumed.claimId,running.claimId);assert.equal(resumed.generation,running.generation);
  const db=new Store(join(h.data,'coordinator.sqlite'));
  try { assert(db.db.prepare("SELECT count(*) n FROM events WHERE kind='coordinator.lease_recovered'").get().n>=1); }
  finally { db.close(); }
});
