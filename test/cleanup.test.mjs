// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,utimesSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.mjs';
import {Collaboration} from '../src/collaboration.mjs';
import {SessionAwareness} from '../src/session-awareness.mjs';
import {TranscriptObserver,parseTranscript} from '../src/observers.mjs';
import {ResourceManagers} from '../src/resource-managers.mjs';
import {bootstrapView,bootstrapByteLimit} from '../src/bootstrap-view.mjs';
import {hash} from '../src/common.mjs';
import {splitDiscovery} from '../src/discovery-view.mjs';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'accord-cleanup-')),file=join(dir,'db.sqlite');
const s=new Store(file,{leaderMs:30000});s.takeLeadership();s.provision('admin','admin','admin');s.provision('a','a','worker');
const c=new Collaboration(s,file),v=new SessionAwareness(s);t.after(()=>{c.close();s.close();rmSync(dir,{recursive:true,force:true});});return {s,c,v,dir,a:{id:'a',role:'worker'},admin:{id:'admin',role:'admin'}};}

test('bootstrap is bounded even with large Unicode directories, histories and inboxes',()=>{
 const text='🦉'.repeat(4000),participants=Array.from({length:80},(_,i)=>({address:'host/'+i,label:text,activity:text,location:text,capabilities:[text],presence:i<2?'recent':i<14?'offline':'unknown'}));
 const view=bootstrapView({actor:{id:'caller',role:'worker'},local:{authority:'host',resources:Array.from({length:100},(_,i)=>({id:'resource-'+i,state:'held',holder:{actor:'other',generation:2,deadline:123}}))},peers:[],directory:{hosts:[],participants},inbox:{messages:Array.from({length:100},()=>({id:'message',text}))}});
 assert(Buffer.byteLength(JSON.stringify(view))<=bootstrapByteLimit);
 assert.equal(view.preview.participants.recent,2);assert.equal(view.preview.participants.available,80);
 assert(view.directory.participants.every(p=>p.presence==='recent'));
 assert(!('board' in view));assert(view.preview.resources.returned<100);assert(view.preview.messages.returned<100);
 // Input stays complete for the explicit APIs.
 assert.equal(participants.length,80);assert.equal(participants[0].activity,text);
});

test('guardian metadata is excluded, ordinary reviewers stay visible, and injected context cannot restart completed work',()=>{
 const lines=source=>[{type:'session_meta',payload:{id:'session',source}},{type:'response_item',payload:{type:'message',role:'user',content:'The following is the Codex agent history to review'}}].map(JSON.stringify);
 assert.equal(parseTranscript('codex',lines({subagent:{other:'guardian'}})).excluded,true);
 assert(!parseTranscript('codex',lines({subagent:{thread_spawn:{parent_thread_id:'parent'}}})).excluded);
 const finished=[{type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:'Done'}}, {type:'response_item',payload:{type:'message',role:'user',content:'# AGENTS.md instructions for /fixture'}}].map(JSON.stringify);
 assert.equal(parseTranscript('codex',finished).state,'done');
 const claude=[{type:'assistant',message:{content:'Done',stop_reason:'end_turn'}},{type:'user',message:{content:'<environment_context>metadata</environment_context>'}}].map(JSON.stringify);
 assert.equal(parseTranscript('claude',claude).state,'done');
});

test('scanning hides previously imported internal sessions even outside lookback, without deleting transcript or identity',async t=>{
 const f=fixture(t),path=join(f.dir,'guardian.jsonl');
 const old=f.v.report(f.admin,{source:'codex',externalId:'guardian',title:'Earlier internal review',state:'working',events:[{key:'old',text:'Internal review evidence'}]});
 const contents=JSON.stringify({type:'session_meta',payload:{id:'guardian',source:{subagent:{other:'guardian'}}}})+'\n';
 writeFileSync(path,contents);utimesSync(path,new Date(0),new Date(0));
 const scan=new TranscriptObserver({awareness:f.v,roots:[{source:'codex',path:f.dir}]});await scan.scan();
 assert.equal(f.v.list().sessions.length,0);assert.equal(f.c.directory('Earlier internal review').length,0);
 assert.equal(f.v.list({query:'evidence'}).sessions.length,0);
 assert.throws(()=>f.v.read(old.id),e=>e.code==='NOT_FOUND');
 assert.equal(f.v.summarize(old.id,old.revision,'Late model output').accepted,false);
 assert.equal(readFileSync(path,'utf8'),contents);
 assert(f.s.db.prepare('SELECT 1 FROM actors WHERE id=?').get(old.id));
 assert.equal(f.s.db.prepare('SELECT count(*) n FROM session_activity WHERE session_id=?').get(old.id).n,1);
 await scan.scan();assert.equal(f.s.db.prepare("SELECT count(*) n FROM events WHERE kind='session.hidden'").get().n,1);
});

test('historical journals do not stop new work; replay keys persist and active queues stay bounded',t=>{
 const f=fixture(t),db=f.s.db;
 const managers=new ResourceManagers(f.s,f.dir,{configs:{fleet:{type:'lloom',url:'http://localhost:8080',tokenFile:'/not-read'}}});
 const replayBody={key:'durable-retry',title:'first',input:'a',expectedHash:hash('A')};
 const first=f.s.submit(f.a,replayBody);f.s.cancel(f.admin,first.taskId,{key:'cancel-first'});
 const seq=n=>`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<${n})`;
 db.exec('BEGIN');
 db.exec(`${seq(100001)} INSERT INTO commands SELECT 'a','past-'||x,'retained','{}' FROM n`);
 db.exec(`${seq(10000)} INSERT INTO actors SELECT 'ended-'||x,'old-hash-'||x,'worker' FROM n`);
 db.exec(`${seq(10000)} INSERT INTO sessions(id,label,harness,created_at,expires_at,closed_at,persistent) SELECT 'ended-'||x,'old','test',0,1,1,0 FROM n`);
 db.exec(`${seq(5000)} INSERT INTO tasks(id,title,input,expected_hash,resource,state,created_at,max_attempts,kind) SELECT 'past-task-'||x,'done','a','hash','artifact','cancelled',0,1,'reservation' FROM n`);
 db.exec(`${seq(5000)} INSERT INTO reservations SELECT 'past-reservation-'||x,'a','past-task-'||x,1000,1000,NULL FROM n`);
 db.exec(`${seq(5000)} INSERT INTO manager_requests(id,actor,manager,resource,payload,state,created_at,queued_until) SELECT 'past-manager-'||x,'a','fleet','pair','{}','released',0,1000 FROM n`);
 db.exec(`${seq(100000)} INSERT INTO message_outbox(id,actor,envelope,state,created_at) SELECT 'past-message-'||x,'a','{}','delivered',0 FROM n`);
 db.exec('COMMIT');
 assert.deepEqual(f.s.submit(f.a,replayBody),first);
 assert.throws(()=>f.s.submit(f.a,{...replayBody,input:'changed'}),e=>e.code==='KEY_REUSED');
 assert(f.s.openSession({id:'fixture'},{key:'new-session',label:'new',harness:'test'},id=>id).sessionId);
 assert(f.s.submit(f.a,{...replayBody,key:'new-task'}).taskId);
 assert(f.c.reserve(f.a,{key:'new-reservation',resource:'artifact'}).id);
 assert(managers.reserve(f.a,{key:'new-manager',resource:'fleet:pair'}).id);
 assert(f.c.send(f.a,{key:'new-send',to:f.s.authority+'/recipient',text:'Hello'}).id);
 // Completed history was retained; reaching the active limit still backpressures.
 assert.equal(db.prepare("SELECT count(*) n FROM commands WHERE key LIKE 'past-%'").get().n,100001);
 db.exec("UPDATE tasks SET state='queued' WHERE id LIKE 'past-task-%'; UPDATE manager_requests SET state='unknown' WHERE id LIKE 'past-manager-%'; UPDATE message_outbox SET state='queued' WHERE id LIKE 'past-message-%'");
 assert.throws(()=>f.s.submit(f.a,{...replayBody,key:'over-task-limit'}),e=>e.code==='CAPACITY_LIMIT');
 assert.throws(()=>f.c.reserve(f.a,{key:'over-reservation-limit',resource:'artifact'}),e=>e.code==='CAPACITY_LIMIT');
 assert.throws(()=>managers.reserve(f.a,{key:'over-manager-limit',resource:'fleet:pair'}),e=>e.code==='CAPACITY_LIMIT');
 assert.throws(()=>f.c.send(f.a,{key:'over-message-limit',to:f.s.authority+'/recipient',text:'Hello'}),e=>e.code==='CAPACITY_LIMIT');
 assert.deepEqual(f.s.submit(f.a,replayBody),first);
});

test('transcript rescans do not turn completed, old or unknown work into recent collaborators',t=>{
 const f=fixture(t),now=f.s.now();
 for(const [externalId,state,sourceProgressAt,expected] of [['complete','done',now,'offline'],['old','working',now-3600000,'unknown'],['unknown','unknown',now,'unknown'],['active','working',now,'recent']]){
   f.v.report(f.admin,{key:externalId,source:'codex',externalId,title:externalId,state,sourceProgressAt});
   assert.equal(f.c.directory(externalId).find(p=>p.label===externalId).presence,expected);
 }
 // Explicit live-agent presence remains independent of transcript progress.
 f.c.announce(f.a,{key:'alive',label:'Connected agent',activity:'Available'});
 assert.equal(f.c.directory('Connected agent')[0].presence,'recent');
});

test('discovery separates native mirrors from peers without guessing identity from matching titles',async t=>{
 const f=fixture(t),label='Hetzner CVE audit';
 f.s.provision('b','b','worker');
 for(const actor of [f.a,{id:'b',role:'worker'}])f.c.announce(actor,{key:'announce',label,activity:'Auditing hosts',location:'/same'});
 const observed=['claude','tessera'].map(source=>f.v.report(f.admin,{key:source,source,externalId:'same-native-chat',title:label,state:'working',sourceProgressAt:f.s.now()}));
 let found=await f.c.find(label,false,f.c.address(f.a));
 assert.deepEqual(found.participants.map(p=>p.address),[f.s.authority+'/b']);
 assert.equal(found.observations.length,2);
 assert(found.observations.every(p=>p.kind==='observation'));
 assert(found.hosts[0].participants.every(p=>p.kind!=='observation'));
 // The native history is still available; observation separation never deletes it.
 assert(observed.every(o=>f.v.list({query:label}).sessions.some(s=>s.id===o.id)));
 f.s.db.prepare('INSERT INTO session_bindings VALUES(?,?,?)').run('claude','same-native-chat','a');
 found=await f.c.find(label,false,f.c.address(f.a));
 assert.deepEqual(found.observations.map(p=>p.source),['tessera']);
 assert.equal((await f.c.find(label,false)).participants.length,2);
 assert.deepEqual((await f.c.find(label,false)).observations.map(p=>p.source),['tessera']);
 assert.equal(f.c.directory(label).find(p=>p.source==='claude').participantAddress,f.c.address(f.a));
});

test('older host observation IDs and proxies cannot masquerade as collaborators',()=>{
 const rows=[{address:'peer/observed-legacy',label:'same'}, {address:'peer/real',label:'same'}, {address:'peer/remote-proxy'}, {address:'local/me'}];
 const found=splitDiscovery(rows,'local/me');
 assert.deepEqual(found.participants.map(p=>p.address),['peer/real']);
 assert.equal(found.observations[0].kind,'observation');
 assert.equal(splitDiscovery(rows).participants.length,2);
 const bound=[{address:'host/native',kind:'observation',participantAddress:'host/real'}, {address:'host/ui',kind:'observation',participantAddress:'host/real'}];
 assert.equal(splitDiscovery(bound).observations.length,1);
 assert.equal(splitDiscovery([...bound,{address:'host/real'}]).observations.length,0);
});

test('bootstrap omits self, mirrors and completed work from recent collaborators',()=>{
 const participants=[{address:'host/me'}, {address:'host/other'}, {address:'host/done',state:'done'}, {address:'host/observed-native',kind:'observation'}].map(p=>({...p,presence:'recent'}));
 const view=bootstrapView({actor:{id:'me'},local:{authority:'host'},peers:[],directory:{hosts:[],participants},inbox:{messages:[]}});
 assert.deepEqual(view.directory.participants.map(p=>p.address),['host/other']);
 assert.equal(view.preview.observations.available,1);
 assert.equal(view.preview.participants.recent,1);
 assert.match(view.next,/not additional collaborators/);
});
