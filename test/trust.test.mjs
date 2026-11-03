// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync,statSync,writeFileSync,existsSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { harness,link } from './helpers.mjs';
import { request,token } from '../src/common.mjs';
import { profileAt } from '../src/bootstrap.mjs';
import { redact } from '../src/session-awareness.mjs';
import { Store } from '../src/store.mjs';
import { ResourceManagers } from '../src/resource-managers.mjs';

const posix=process.platform!=='win32',posixTest=posix?test:test.skip;
const hookScript=fileURLToPath(new URL('../src/hook.sh',import.meta.url));
const contextHook=fileURLToPath(new URL('../src/context-hook.mjs',import.meta.url));
const waitHook=fileURLToPath(new URL('../src/wait-hook.mjs',import.meta.url));

// Anything listening on a TCP port another local user could hold while Accord is down.
async function squatter(t){
  const hits=[],server=createServer((q,r)=>{hits.push(q.headers.authorization??'');r.setHeader('content-type','application/json');r.end(JSON.stringify({protocol:'accord/1',wake:true,presented:true,messages:[{text:'forged'}]}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  return {hits,url:`http://127.0.0.1:${server.address().port}`};
}
// The squatter shares this process, so a hook must not block the event loop.
const hook=(command,args,input)=>new Promise(resolve=>{
  const p=spawn(command,args,{stdio:['pipe','ignore','ignore']}),timer=setTimeout(()=>p.kill(),4000);
  p.stdin.on('error',()=>{});p.stdin.end(input);p.once('exit',()=>{clearTimeout(timer);resolve();});
});
async function started(t){const h=await harness();t.after(()=>h.close());return h;}
function linkedPair(t){return (async()=>{const a=await started(t),b=await started(t);return {a,b,...await link(a,b)};})();}

posixTest('local clients reach the service over a socket only its owner can use',async t=>{
  const h=await started(t),socket=join(h.data,'accord.sock');
  assert.equal(statSync(socket).mode&0o777,0o600);assert.equal(statSync(h.data).mode&0o777,0o700);
  const url=`unix:${socket}`,me=await request(url,h.credential('admin'),'/v1/me');assert.equal(me.role,'admin');
  await assert.rejects(request(url,'wrong','/v1/me'),e=>e.status===401);
  const endpoints=JSON.parse(readFileSync(join(h.data,'endpoints.json')));assert.equal(endpoints.local,url);
  writeFileSync(join(h.data,'connection.json'),JSON.stringify({schema:1,authority:'x',endpointFile:join(h.data,'endpoints.json')}));
  assert.equal(profileAt(join(h.data,'connection.json')).url,url);
});

posixTest('no hook sends a credential to whatever holds the TCP port',async t=>{
  const h=await started(t),squat=await squatter(t),endpoints=join(h.data,'endpoints.json');
  const current=JSON.parse(readFileSync(endpoints));writeFileSync(endpoints,JSON.stringify({...current,coordinator:squat.url}));
  const authority=(await h.client('admin').host()).authority,profile=join(h.data,'connection.json');
  writeFileSync(profile,JSON.stringify({schema:1,authority,endpointFile:endpoints}));
  const stop=JSON.stringify({session_id:'native-one',hook_event_name:'Stop'}),prompt=JSON.stringify({session_id:'native-one',hook_event_name:'UserPromptSubmit'});
  await hook(process.execPath,[contextHook,'--accord-context-hook','--source','claude','--profile',profile],prompt);
  await hook(process.execPath,[waitHook,'hold','--accord-context-hook','--source','codex','--profile',profile,'--data',h.data],stop);
  await hook('/bin/sh',[hookScript,'hold','--accord-context-hook','--source','codex','--profile',profile,'--data',h.data,'--node',process.execPath],stop);
  assert.deepEqual(squat.hits,[]);
});

test('a linked host reads session activity only after this host shares it',async t=>{
  const {a,b,aa,bb}=await linkedPair(t),ca=a.client('agent-a'),cb=b.client('agent-b');
  await cb.announce({label:'Parser',activity:'private work'});
  await cb.collaborate('session-report',{key:randomUUID(),title:'Parser',state:'working',detail:'private work'});
  const seen=async()=>(await ca.collaborate('sessions',{query:'Parser'})).sessions.length;
  assert.equal(await seen(),0);
  await assert.rejects(ca.collaborate('sessions',{},bb),{code:'NOT_SHARED'});
  await assert.rejects(ca.collaborate('jobs',{},bb),{code:'NOT_SHARED'});
  await request(b.url,b.credential('admin'),'/v1/links/share',{key:randomUUID(),authority:aa,share:true});
  assert.ok(await seen()>0);
  assert.ok((await ca.collaborate('sessions',{},bb)).sessions.length>0);
  await assert.rejects(request(b.url,b.credential('agent-b'),'/v1/links/share',{key:randomUUID(),authority:aa,share:true}),{code:'FORBIDDEN'});
  await request(b.url,b.credential('admin'),'/v1/links/share',{key:randomUUID(),authority:aa,share:false});
  assert.equal(await seen(),0);
});

test('an upgraded host keeps sharing with the links it already had',t=>{
  const dir=mkdtempSync(join(tmpdir(),'accord-share-')),file=join(dir,'c.sqlite');t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const seed=new Store(file);seed.close();
  const old=new DatabaseSync(file);
  old.exec("ALTER TABLE links DROP COLUMN share_sessions;DROP TABLE memory_entries;DELETE FROM migrations WHERE version>=13;INSERT INTO links VALUES('peer','http://127.0.0.1:1','o','i');");old.close();
  const current=new Store(file);
  assert.equal(current.db.prepare('SELECT share_sessions s FROM links').get().s,1);
  current.db.exec("INSERT INTO links(authority,url,outbound,inbound_hash) VALUES('new','http://127.0.0.1:2','o2','i2')");
  assert.equal(current.db.prepare("SELECT share_sessions s FROM links WHERE authority='new'").get().s,0);
  current.close();
});

test('a credential goes only to a tunnel that proves it holds the link',async t=>{
  const {a,bb}=await linkedPair(t),squat=await squatter(t);
  const descriptor=createServer((q,r)=>{squat.hits.push(q.headers.authorization??'');r.setHeader('content-type','application/json');r.end(JSON.stringify({protocol:'accord/1',authority:bb}));});
  await new Promise(r=>descriptor.listen(0,'127.0.0.1',r));t.after(()=>descriptor.close());
  const c=a.client('admin'),port=descriptor.address().port;
  await assert.doesNotReject(c.collaborate('resources',{},bb));
  const store=new DatabaseSync(join(a.data,'coordinator.sqlite'));
  store.prepare('UPDATE links SET url=? WHERE authority=?').run(`http://127.0.0.1:${port}`,bb);store.close();
  await assert.rejects(c.collaborate('resources',{},bb),{code:'PEER_IDENTITY_CHANGED'});
  assert.ok(squat.hits.length>0);assert.ok(squat.hits.every(h=>!h.includes('accord_')),'no link credential reached it');
});

test('find reports only what a linked host may speak for',async t=>{
  const a=await started(t),authority=(await a.client('admin').host()).authority,forged=randomUUID(),self=randomUUID(),inbound=token(),outbound=token();
  const {createHmac,createHash}=await import('node:crypto');
  const peer=createServer(async(q,r)=>{
    r.setHeader('content-type','application/json');
    const url=new URL(q.url,'http://x');
    if(url.pathname==='/.well-known/accord'){
      return r.end(JSON.stringify({protocol:'accord/1',authority:self,proof:createHmac('sha256',createHash('sha256').update(inbound).digest('hex')).update(`accord-link-v1\0${self}\0${url.searchParams.get('nonce')}`).digest('hex')}));
    }
    r.end(JSON.stringify({authority:self,value:{authority:forged,status:'unknown',
      participants:[{address:`${self}/one`,label:'mine'},{address:`${forged}/two`,label:'forged'}],
      resources:[{id:`${self}/repo`},{id:`${authority}/artifact`,state:'unclaimed'}]}}));
  });
  await new Promise(r=>peer.listen(0,'127.0.0.1',r));t.after(()=>peer.close());
  await request(a.url,a.credential('admin'),'/v1/links',{key:randomUUID(),authority:self,url:`http://127.0.0.1:${peer.address().port}`,inbound:outbound,outbound:inbound});
  const result=await a.client('admin').collaborate('find',{detail:true});
  const host=result.hosts.find(h=>h.authority===self);assert.ok(host,'the real peer stays listed');assert.equal(host.status,'observed');
  assert.equal(result.hosts.some(h=>h.authority===forged),false);
  assert.deepEqual(host.participants.map(p=>p.label),['mine']);assert.deepEqual(host.resources.map(r=>r.id),[`${self}/repo`]);
});

test('a manager bearer never crosses the network in cleartext',()=>{
  assert.throws(()=>new ResourceManagers({db:null},'/tmp',{configs:{fleet:{type:'lloom',url:'http://models.example:8080',readOnly:true}}}),{code:'MANAGER_CONFIG'});
});

test('redaction covers common secret shapes in structured and plain text',()=>{
  for(const [sample,secret] of [
    ['{"password":"hunter2hunter"}','hunter2hunter'],['{"api_key": "abcdef123456"}','abcdef123456'],['"token": "abcdef123456"','abcdef123456'],
    ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG','wJalrXUtnFEMI'],['DATABASE_URL=postgres://user:hunter2hunter@db.example/app','hunter2hunter'],
    ['MONGO_URI=mongodb+srv://me:hunter2hunter@cluster.example','hunter2hunter'],['stripe sk_live_abcdefghijklmnop1234','sk_live_abcdefghijklmnop1234'],
    ['Cookie: session=abcdef123456; other=zyxwvu','abcdef123456'],['Authorization: Basic dXNlcjpodW50ZXIy','dXNlcjpodW50ZXIy'],
    ['curl -u admin:hunter2hunter https://x.example','hunter2hunter'],['npm_abcdefghijklmnopqrstuvwxyz0123456789','npm_abcdefghijklmnopqrstuvwxyz'],
    ['glpat-abcdefghijklmnopqrst','glpat-abcdefghijklmnopqrst'],['ya29.abcdefghijklmnopqrstuvwxyz','ya29.abcdefghijklmnopqrstuvwxyz'],
    ['the password is hunter2hunter','hunter2hunter'],['MY_CLIENT_SECRET_V2=abcdef123456','abcdef123456'],
  ])assert.equal(redact(sample).includes(secret),false,sample);
  assert.equal(redact('the token bucket refills every second'),'the token bucket refills every second');
  assert.equal(redact('https://example.com:8080/path'),'https://example.com:8080/path');
});

test('no prebuilt binary ships in the repository',()=>{
  assert.equal(existsSync(new URL('../native/bin',import.meta.url)),false);
});
