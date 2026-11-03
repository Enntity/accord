// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {harness,eventually,stop,link,delay} from './helpers.mjs';
import {install} from '../src/installer.mjs';
import {AccordClient} from '../src/client.mjs';
import {DatabaseSync} from 'node:sqlite';

async function bridge(t,profile,env={},clientName=env.CODEX_THREAD_ID?'codex-env':'zcode') {
  const child=spawn(process.execPath,[fileURLToPath(new URL('../src/cli.mjs',import.meta.url)),'mcp','--profile',profile],{
    stdio:['pipe','pipe','pipe'],env:{...process.env,ACCORD_SESSION_FILE:'',CODEX_THREAD_ID:'',CLAUDE_SESSION_ID:'',ZCODE_SESSION_ID:'',TESSERA_TILE_ID:'',...env}});
  t.after(()=>stop(child));child.stderr.resume();
  const replies=new Map();let buffer='',sequence=0;
  child.stdout.on('data',data=>{buffer+=data;let n;while((n=buffer.indexOf('\n'))>=0){const r=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);replies.set(r.id,r);}});
  async function rpc(method,params){const id=++sequence;child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');await eventually(()=>replies.has(id));return replies.get(id).result;}
  await rpc('initialize',{protocolVersion:'2025-06-18',clientInfo:{name:clientName,version:'test'}});
  return {child,async call(name,args={},session='native-one'){
    const r=await rpc('tools/call',{name,arguments:args,_meta:clientName==='zcode'?{'com.zcode/request-context':{session_id:session}}:clientName==='codex'?{threadId:session,'x-codex-turn-metadata':'{}'}:{}});
    assert(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text);
  },async close(){child.stdin.end();await eventually(()=>child.exitCode!==null);assert.equal(child.exitCode,0);}};
}

test('enrolled senders can receive replies without bootstrap or directory publication',async t=>{
  const h=await harness();t.after(()=>h.close());const authority=(await h.client('admin').host()).authority;
  const a=await AccordClient.enroll(h.url,h.credential('bootstrap'),{authority,label:'no bootstrap'}),b=h.client('agent-b');
  const target=(await b.bootstrap()).address;
  await a.send(target,'request');const received=await eventually(async()=>(await b.inbox()).messages[0]);
  const reply=await b.send(received.from,'reply');
  assert.equal(reply.state,'delivered');
  await eventually(async()=>(await b.sent(reply.id)).state==='delivered');
  assert.equal((await a.inbox()).messages[0].text,'reply');
  await assert.rejects(b.send(authority+'/missing','bad address'),{code:'RECIPIENT_UNKNOWN'});
});

test('ZCode reconnect and multiplexing preserve separate native mailboxes and acknowledgements',async t=>{
  const h=await harness();t.after(()=>h.close());const {profile}=install({home:join(h.data,'home'),data:h.data});
  let bridge1=await bridge(t,profile,{CODEX_THREAD_ID:'parent-thread-must-not-bind'},'zcode');
  const first=await bridge1.call('accord_bootstrap',{label:'ZCode one',activity:'review'});
  const second=await bridge1.call('accord_bootstrap',{label:'ZCode two',activity:'other'},'native-two');
  assert.notEqual(first.address,second.address);
  await bridge1.close(); // Transport closure must not close the native conversation.
  const reviewer=h.client('agent-b');await reviewer.bootstrap();await reviewer.send(first.address,'findings');
  const resumed=await bridge(t,profile);
  const mail=await eventually(async()=>{const r=await resumed.call('accord_inbox');return r.messages.length&&r;});
  assert.equal(mail.messages[0].text,'findings');
  assert.equal((await resumed.call('accord_inbox',{},'native-two')).messages.length,0);
  assert.equal((await resumed.call('accord_bootstrap')).address,first.address);
  await resumed.call('accord_read',{deliveryId:mail.messages[0].deliveryId});
  await resumed.close();
  const again=await bridge(t,profile);assert.equal((await again.call('accord_inbox')).messages.length,0);
  const db=new DatabaseSync(join(h.data,'coordinator.sqlite'),{readOnly:true});t.after(()=>db.close());
  assert.equal(db.prepare("SELECT count(*) n FROM session_bindings WHERE external_id='parent-thread-must-not-bind'").get().n,0);
  assert.equal(db.prepare("SELECT actor FROM session_bindings WHERE source='zcode' AND external_id='native-one'").get().actor,first.address.split('/')[1]);
});

test('Codex environment identity survives bridge crash and cannot resurrect an explicitly closed session',async t=>{
  const h=await harness();t.after(()=>h.close());const {profile}=install({home:join(h.data,'home'),data:h.data});
  const env={CODEX_THREAD_ID:'codex-thread-one'},a=await bridge(t,profile,env);
  const original=await a.call('accord_bootstrap');await stop(a.child,'SIGKILL');
  const b=await bridge(t,profile,env);assert.equal((await b.call('accord_bootstrap')).address,original.address);
  await b.close();
  const {request}=await import('../src/common.mjs');
  await request(h.url,h.credential('admin'),`/v1/sessions/${original.address.split('/')[1]}/close`,{key:'explicit-close'});
  const c=await bridge(t,profile,env);await assert.rejects(c.call('accord_bootstrap'),/SESSION_EXPIRED/);
});

test('failed remote delivery is visible on ordinary calls and errors, then clears on recovery',async t=>{
  const a=await harness(),b=await harness();t.after(async()=>{await a.close();await b.close();});
  await link(a,b);const sender=a.client('agent-a'),recipient=b.client('agent-b');await sender.bootstrap();
  const address=(await recipient.bootstrap()).address,port=Number(new URL(b.url).port);
  await stop(b.server,'SIGKILL');const message=await sender.send(address,'durable');
  await eventually(async()=>(await sender.sent(message.id)).error);
  const state=await sender.host();assert.equal(state.deliveryProblems.messages[0].id,message.id);
  assert(!JSON.stringify(state.deliveryProblems).includes('durable'));
  await assert.rejects(sender.reservation('missing'),e=>e.deliveryProblems?.messages[0].id===message.id);
  await delay(b.leaderMs+100);await b.startServer(port);
  await eventually(async()=>(await sender.sent(message.id)).state==='delivered');
  assert.equal((await sender.host()).deliveryProblems,undefined);
});


test('Codex desktop native tool metadata retains identity without environment IDs',async t=>{
  const h=await harness();t.after(()=>h.close());const {profile}=install({home:join(h.data,'home'),data:h.data});
  const a=await bridge(t,profile,{},'codex');const original=await a.call('accord_bootstrap');await a.close();
  const reviewer=h.client('agent-b');await reviewer.send(original.address,'desktop reply');
  const b=await bridge(t,profile,{},'codex');assert.equal((await b.call('accord_inbox')).messages[0].text,'desktop reply');
  assert.equal((await b.call('accord_bootstrap')).address,original.address);
});

test('an agent started inside another agent\'s shell never takes that agent\'s mailbox',async t=>{
  const h=await harness();t.after(()=>h.close());const {profile}=install({home:join(h.data,'home'),data:h.data});
  const parent=await bridge(t,profile,{CODEX_THREAD_ID:'parent-codex'},'codex-env');const owner=await parent.call('accord_bootstrap');
  for(const client of ['claude-code','opencode']){
    const child=await bridge(t,profile,{CODEX_THREAD_ID:'parent-codex'},client);
    assert.notEqual((await child.call('accord_bootstrap')).address,owner.address,client);
  }
  const {nativeSessionIdentity}=await import('../src/bootstrap.mjs');
  assert.deepEqual(nativeSessionIdentity({CODEX_THREAD_ID:'p',CLAUDE_SESSION_ID:'c'},'claude-code'),{source:'claude',id:'c'});
  assert.deepEqual(nativeSessionIdentity({CODEX_THREAD_ID:'p',TESSERA_TILE_ID:'tile'},'opencode'),{source:'tessera',id:'tile'});
  assert.equal(nativeSessionIdentity({CODEX_THREAD_ID:'p'},'opencode'),undefined);
});
