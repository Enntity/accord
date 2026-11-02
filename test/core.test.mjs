// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactDriver } from '../src/driver.mjs';
import { Store } from '../src/store.mjs';
import { hash } from '../src/common.mjs';

function temporary(t) { const dir=mkdtempSync(join(tmpdir(),'accord-core-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir; }
test('driver fences delayed activation, stale credentials and old authority epochs across restart', t=>{
  const file=join(temporary(t),'driver.sqlite');let driver=new ArtifactDriver(file);t.after(()=>driver.close());
  const base={instance:driver.status().instance,authority:'test-authority',epoch:1,generation:1,claimId:'attempt-a',credentialHash:hash('a')};
  driver.activate(base);const first=driver.write('a',{key:'effect',content:'accepted'});
  assert.equal(driver.write('a',{key:'effect',content:'accepted'}).id,first.id);
  assert.throws(()=>driver.write('a',{key:'effect',content:'changed'}),e=>e.code==='KEY_REUSED');
  assert.throws(()=>driver.activate({...base,generation:2,claimId:'b'}),e=>e.code==='DRIVER_BUSY');
  driver.revoke(base);
  assert.throws(()=>driver.activate(base),e=>e.code==='REVOKED');
  assert.throws(()=>driver.write('a',{key:'late',content:'late'}),e=>e.code==='STALE_GRANT');
  const next={...base,epoch:2,generation:2,claimId:'attempt-b',credentialHash:hash('b')};driver.activate(next);
  assert.throws(()=>driver.revoke({...next,epoch:1}),e=>e.code==='STALE_FENCE');
  driver.close();driver=new ArtifactDriver(file);
  assert.equal(driver.status().generation,2);assert.equal(driver.status().claim_id,null);
  assert.throws(()=>driver.activate(next),e=>e.code==='REVOKED');
  assert.throws(()=>driver.write('b',{key:'late',content:'late'}),e=>e.code==='STALE_GRANT');
  assert.equal(driver.receipt(first.id).sha256,hash('accepted'));
});
test('revoke tombstone arrives before activate; new incarnation of resource database is refused',t=>{
  const driver=new ArtifactDriver(join(temporary(t),'driver.sqlite'));t.after(()=>driver.close());
  const grant={instance:driver.status().instance,authority:'a',epoch:1,generation:5,claimId:'x',credentialHash:hash('x')};
  driver.revoke(grant);
  assert.throws(()=>driver.activate(grant),e=>e.code==='REVOKED');
  assert.throws(()=>driver.activate({...grant,instance:'replaced',generation:6}),e=>e.code==='DRIVER_REPLACED');
  assert.throws(()=>driver.activate({...grant,authority:'other',generation:6}),e=>e.code==='WRONG_AUTHORITY');
});
test('leadership takeover revokes unfinished work and fences the old coordinator',t=>{
  const file=join(temporary(t),'service.sqlite');let now=1000;
  const one=new Store(file,{now:()=>now,leaderMs:1000}),two=new Store(file,{now:()=>now,leaderMs:1000});t.after(()=>{one.close();two.close();});
  one.provision('a','secret','worker');one.takeLeadership();
  assert.throws(()=>two.takeLeadership(),e=>e.code==='LEADER_ACTIVE');
  const actor={id:'a',role:'worker'};
  const {taskId}=one.submit(actor,{key:'task',title:'job',input:'a',expectedHash:hash('A')});
  const {claimId}=one.acquire(actor,{key:'claim',taskId,leaseMs:1000});one.activated(claimId);
  one.checkpoint(actor,claimId,{key:'checkpoint',note:'durable next step'});
  now=2100;two.takeLeadership();
  assert.throws(()=>one.beat(),e=>e.code==='LEADER_LOST');
  assert.equal(two.claim(claimId).state,'revoking');assert.equal(two.task(taskId).checkpoint,'durable next step');
  assert.throws(()=>two.acquire(actor,{key:'new',taskId}),e=>e.code==='TASK_BUSY');
  two.released(claimId);const next=two.acquire(actor,{key:'new',taskId});assert.equal(two.claim(next.claimId).generation,2);
});
test('expiry retains the exclusive hold until a release receipt is processed; commands deduplicate',t=>{
  let now=0;const store=new Store(join(temporary(t),'store.sqlite'),{now:()=>now,leaderMs:10000});t.after(()=>store.close());
  store.provision('a','secret','worker');store.takeLeadership();const actor={id:'a',role:'worker'};
  const body={key:'task',title:'one',input:'a',expectedHash:hash('A')};const task=store.submit(actor,body);
  assert.deepEqual(store.submit(actor,body),task);assert.throws(()=>store.submit(actor,{...body,title:'different'}),e=>e.code==='KEY_REUSED');
  const other=store.submit(actor,{...body,key:'other'});const c=store.acquire(actor,{taskId:task.taskId,key:'take',leaseMs:500});store.activated(c.claimId);
  now=600;store.sweep();
  assert.throws(()=>store.acquire(actor,{taskId:other.taskId,key:'try'}),e=>e.code==='RESOURCE_BUSY');
  assert.equal(store.board().resource.holders.length,1);store.released(c.claimId);
  assert.equal(store.acquire(actor,{taskId:other.taskId,key:'try'}).claimId.length,36);
});
test('changed migration checksum is refused without replacing state',t=>{
  const file=join(temporary(t),'store.sqlite');const store=new Store(file);store.db.prepare("UPDATE migrations SET checksum='bad'").run();store.close();
  assert.throws(()=>new Store(file),e=>e.code==='SCHEMA_MISMATCH');
});
test('renewal cannot revive an expired attempt and retry exhaustion is terminal',t=>{
  let now=0;const store=new Store(join(temporary(t),'store.sqlite'),{now:()=>now,leaderMs:10000});t.after(()=>store.close());
  store.provision('a','secret','worker');store.takeLeadership();const actor={id:'a',role:'worker'};
  const {taskId}=store.submit(actor,{key:'task',title:'bounded',input:'a',expectedHash:hash('A'),maxAttempts:1});
  const {claimId}=store.acquire(actor,{key:'take',taskId,leaseMs:500});store.activated(claimId);
  now=400;assert.equal(store.renew(actor,claimId,{key:'renew',leaseMs:500}).deadline,900);
  now=600;store.sweep();assert.equal(store.claim(claimId).state,'running');
  now=950;assert.throws(()=>store.renew(actor,claimId,{key:'too-late',leaseMs:500}),e=>e.code==='STALE_CLAIM');
  store.sweep();assert.equal(store.claim(claimId).outcome,'failed');store.released(claimId);
  assert.equal(store.task(taskId).state,'failed');assert.equal(store.board().resource.holders.length,0);
});

test('v1 database migrates additively without changing authority, claim generation, or checkpoint', async t=>{
  const {database}=await import('../src/common.mjs');
  const {readFileSync}=await import('node:fs');
  const file=join(temporary(t),'old.sqlite');
  const schema=readFileSync(new URL('./fixtures/coordinator-v1.sql',import.meta.url),'utf8');
  const old=database(file,schema);
  old.prepare("INSERT INTO meta VALUES('authority','original-host')").run();
  old.prepare("INSERT INTO actors VALUES('old-worker',?,'worker')").run(hash('old-secret'));
  old.prepare("INSERT INTO resources VALUES('artifact',7)").run();
  old.prepare("INSERT INTO tasks VALUES('task','old task','a',?,'artifact',NULL,'running','durable checkpoint',NULL,0,3)").run(hash('A'));
  old.prepare("INSERT INTO claims VALUES('claim','task','artifact','old-worker',7,'running',999999,NULL,NULL,NULL,0)").run();old.close();
  const current=new Store(file);t.after(()=>current.close());
  assert.equal(current.authority,'original-host');assert.equal(current.claim('claim').generation,7);
  assert.equal(current.task('task').checkpoint,'durable checkpoint');assert.equal(current.authenticate('old-secret').id,'old-worker');
  assert.equal(current.db.prepare('SELECT count(*) AS n FROM migrations').get().n,13);
  current.takeLeadership();assert.equal(current.claim('claim').state,'revoking');assert.equal(current.board().resource.holders.length,1);
});

test('v9 native bindings migrate into mailbox aliases without changing prior checksums',async t=>{
  const {DatabaseSync}=await import('node:sqlite');const file=join(temporary(t),'v9.sqlite');
  const seed=new Store(file);seed.provision('prior-session','secret','worker');
  seed.db.prepare('INSERT INTO session_bindings VALUES(?,?,?)').run('claude','native','prior-session');
  const checksums=seed.db.prepare('SELECT * FROM migrations WHERE version<=9').all();seed.close();
  const old=new DatabaseSync(file);old.exec('DROP TABLE session_mailbox_aliases; ALTER TABLE session_views DROP COLUMN parent_session; DROP TABLE resource_pools; ALTER TABLE reservations DROP COLUMN pool; ALTER TABLE links DROP COLUMN share_sessions; DELETE FROM migrations WHERE version>=10');old.close();
  const current=new Store(file);t.after(()=>current.close());
  assert.deepEqual(current.db.prepare('SELECT * FROM migrations WHERE version<=9').all(),checksums);
  assert.deepEqual({...current.db.prepare('SELECT * FROM session_mailbox_aliases').get()},{source:'claude',external_id:'native',actor:'prior-session'});
});

test('session closed at a zero clock value is still revoked',t=>{
  const store=new Store(join(temporary(t),'sessions.sqlite'),{now:()=>0,leaderMs:10000});t.after(()=>store.close());store.takeLeadership();
  const result=store.openSession({id:'test'},{key:'open',label:'test',harness:'test'},sessionId=>sessionId);
  const actor=store.authenticate(result.sessionId);store.endSession(actor,result.sessionId,{key:'close'});
  assert.throws(()=>store.authenticate(result.sessionId),e=>e.code==='SESSION_EXPIRED');
  assert.throws(()=>store.submit(actor,{key:'late',title:'late',input:'a',expectedHash:hash('A')}),e=>e.code==='SESSION_EXPIRED');
});

test('published v4 checksums and durable inbox outbox survive the awareness upgrade',async t=>{
 const {database}=await import('../src/common.mjs'),{readFileSync}=await import('node:fs');
 const file=join(temporary(t),'v4.sqlite'),schemas=JSON.parse(readFileSync(new URL('./fixtures/coordinator-v4.json',import.meta.url),'utf8'));
 const old=database(file,schemas);old.prepare("INSERT INTO meta VALUES('authority','v4-host')").run();old.prepare("INSERT INTO actors VALUES('holder',?,'worker')").run(hash('fixture'));
 old.prepare('INSERT INTO participants VALUES(?,?,?,?,?,?)').run('holder','Worker','[]','work','/fixture',0);
 old.prepare('INSERT INTO message_outbox VALUES(?,?,?,?,?,?,?)').run('message','holder','{}','queued',null,0,0);
 const checksums=old.prepare('SELECT * FROM migrations').all();old.close();
 const current=new Store(file);t.after(()=>current.close());assert.equal(current.authority,'v4-host');assert.deepEqual(current.db.prepare('SELECT * FROM migrations WHERE version<=4').all(),checksums);
 assert.equal(current.db.prepare('SELECT state FROM message_outbox').get().state,'queued');assert.equal(current.db.prepare('SELECT label FROM participants').get().label,'Worker');assert.equal(current.authenticate('fixture').id,'holder');
});
