// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {Collaboration} from '../src/collaboration.mjs';
import {SessionAwareness} from '../src/session-awareness.mjs';
import {hash} from '../src/common.mjs';

function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'accord-continuity-')),file=join(dir,'coordinator.sqlite');
  let now=1000000;
  const s=new Store(file,{now:()=>now,leaderMs:30000});s.takeLeadership();
  const c=new Collaboration(s,file),v=new SessionAwareness(s);
  t.after(()=>{c.close();s.close();rmSync(dir,{recursive:true,force:true});});
  return {s,c,v,file,advance(ms){now+=ms;s.db.prepare('UPDATE leader SET until_ms=?').run(now+30000);},
    open(key,extra={}){return s.openSession({id:'fixture'},{key,label:key,harness:'test',authority:s.authority,...extra},id=>id);}};
}

test('ordinary sessions keep identity, messaging and reporting across months without heartbeats',async t=>{
  const f=fixture(t),one=f.open('one'),two=f.open('two');
  assert.equal(one.expiresAt,null);assert.equal(one.persistent,true);
  const a=f.s.authenticate(one.sessionId),b=f.s.authenticate(two.sessionId);
  f.c.announce(a,{key:'announce',label:'Working agent',activity:'Long job'});
  f.c.send(b,{key:'message',to:f.c.address(a),text:'Check in when ready'});
  await f.c.flush();
  const task=f.s.submit(a,{key:'task',title:'work',input:'a',expectedHash:hash('A')});
  const {claimId}=f.s.acquire(a,{key:'claim',taskId:task.taskId,leaseMs:1000});f.s.activated(claimId);
  f.advance(90*86400000);f.s.sweep();
  assert.equal(f.s.authenticate(one.sessionId).id,a.id);
  assert.equal(f.c.directory().find(p=>p.address===f.c.address(a)).presence,'unknown');
  assert.equal(f.c.inbox(a).messages.length,1);
  f.c.announce(a,{key:'return',label:'Working agent',activity:'Finished after long absence'});
  assert.equal(f.v.report(a,{key:'report',title:'Long job',state:'done',detail:'Results ready'}).state,'done');
  assert.equal(f.s.claim(claimId).state,'revoking');
  assert.throws(()=>f.s.owned(a,claimId,true),e=>e.code==='STALE_CLAIM');
  assert.deepEqual(f.s.board().resource.holders,[claimId]);
  f.s.endSession(a,a.id,{key:'close'});
  assert.throws(()=>f.s.authenticate(one.sessionId),e=>e.code==='SESSION_EXPIRED');
});

test('explicitly bounded credentials still expire even with heartbeats',t=>{
  const f=fixture(t),opened=f.open('bounded',{ttlMs:1000}),a=f.s.authenticate(opened.sessionId);
  f.v.heartbeat(a);f.advance(1001);f.s.sweep();
  assert.throws(()=>f.s.authenticate(a.id),e=>e.code==='SESSION_EXPIRED');
});

test('legacy upgrade restores only proven default expiry and never revives grants or closed credentials',t=>{
  const f=fixture(t);
  // Reproduce v6 records and command fingerprints without changing old migrations.
  function legacy(key,{ttlMs,closed=false,expiryEvent=false}={}){
    const opened=f.open(key,ttlMs===undefined?{}:{ttlMs});
    f.s.db.prepare('UPDATE sessions SET persistent=0,expires_at=created_at+?,closed_at=? WHERE id=?')
      .run(ttlMs??28800000,closed||expiryEvent?f.s.now():null,opened.sessionId);
    if(closed)f.s.emit('session.closed',{session:opened.sessionId});
    if(expiryEvent)f.s.emit('session.expired',{session:opened.sessionId});
    return opened.sessionId;
  }
  const expired=legacy('expired',{expiryEvent:true}),active=legacy('active'),closed=legacy('closed',{closed:true}),
    explicit=legacy('explicit-eight-hours',{ttlMs:28800000}),ambiguous=legacy('unproven');
  f.s.db.prepare('UPDATE commands SET payload_hash=? WHERE key=?').run(hash('unrecognized payload'),'unproven');
  // A closed tombstone wins even if a prior expiry event exists.
  f.s.emit('session.expired',{session:closed});
  const a={id:expired,role:'worker'};
  f.s.db.prepare('UPDATE sessions SET closed_at=NULL WHERE id=?').run(expired);
  f.c.announce(a,{key:'announce',label:'Returning agent',activity:'Earlier work'});
  const reservation=f.c.reserve(a,{key:'old-reservation',resource:'artifact',purpose:'old work',leaseMs:1000,waitMs:3600000});
  f.c.schedule();const claim=f.s.db.prepare('SELECT * FROM claims WHERE actor=?').get(expired);
  const queued=f.c.reserve(a,{key:'old-queued',resource:'artifact',purpose:'queued',leaseMs:1000,waitMs:3600000});
  f.s.db.prepare("INSERT INTO manager_requests(id,actor,manager,resource,payload,state,created_at,queued_until) VALUES('external',?,'fixture','gpu','{}','running',?,?)").run(expired,f.s.now(),f.s.now()+86400000);
  f.s.db.prepare('UPDATE sessions SET closed_at=? WHERE id=?').run(f.s.now(),expired);
  f.advance(28800001);
  f.s.db.prepare("DELETE FROM meta WHERE key='session-continuity-v1'").run();
  f.s.releaseLeadership();f.s.takeLeadership();
  assert.equal(f.s.authenticate(expired).id,expired);
  assert.equal(f.s.authenticate(active).session.persistent,1);
  for(const id of [closed,explicit,ambiguous])assert.throws(()=>f.s.authenticate(id),e=>e.code==='SESSION_EXPIRED');
  assert.equal(f.s.claim(claim.id).state,'revoking');
  assert.deepEqual(f.s.board().resource.holders,[claim.id]);
  assert.equal(f.c.reservation(a,queued.id).state,'cancelled');
  assert.equal(f.s.db.prepare("SELECT release_requested FROM manager_requests WHERE id='external'").get().release_requested,1);
  assert.notEqual(f.c.reservation(a,reservation.id).state,'running');
  f.s.released(claim.id);f.c.schedule();
  assert.equal(f.c.reservation(a,reservation.id).state,'cancelled');
  assert.equal(f.s.board().resource.holders.length,0);
  f.c.announce(a,{key:'returned',label:'Returning agent',activity:'Updated using same credential'});
  assert.equal(f.c.directory().find(p=>p.label==='Returning agent').address,f.c.address(a));
  const events=f.s.db.prepare("SELECT count(*) n FROM events WHERE kind='session.continuity_enabled'").get().n;
  f.s.releaseLeadership();f.s.takeLeadership();
  assert.equal(f.s.db.prepare("SELECT count(*) n FROM events WHERE kind='session.continuity_enabled'").get().n,events);
});
