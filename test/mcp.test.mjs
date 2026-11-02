// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {harness,eventually,stop} from './helpers.mjs';
import {install} from '../src/installer.mjs';
import {DatabaseSync} from 'node:sqlite';

async function bridge(t,bootstrapArgs={}) {
  const h=await harness();t.after(()=>h.close());
  const installed=install({home:join(h.data,'home'),data:h.data});
  const child=spawn(process.execPath,[fileURLToPath(new URL('../src/cli.mjs',import.meta.url)),'mcp','--profile',installed.profile],{stdio:['pipe','pipe','pipe'],env:{...process.env,ACCORD_SESSION_FILE:'',CODEX_THREAD_ID:'',CLAUDE_SESSION_ID:'',TESSERA_TILE_ID:''}});
  t.after(()=>stop(child));
  const replies=new Map();let buffer='',diagnostics='';
  child.stderr.on('data',data=>{diagnostics+=data;});
  child.stdout.on('data',data=>{buffer+=data;let newline;while((newline=buffer.indexOf('\n'))>=0){const row=JSON.parse(buffer.slice(0,newline));buffer=buffer.slice(newline+1);replies.set(row.id,{...row,at:performance.now()});}});
  const send=(id,method,params)=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  const call=(id,name,args={})=>send(id,'tools/call',{name,arguments:args});
  send(1,'initialize',{protocolVersion:'2025-06-18'});call(2,'accord_bootstrap',bootstrapArgs);
  await eventually(()=>replies.has(2));assert(!replies.get(2).result.isError);
  return {h,child,replies,send,call,diagnostics:()=>diagnostics};
}

test('an MCP inbox wait keeps its advertised limit',async t=>{
  const b=await bridge(t);b.call(3,'accord_inbox',{waitMs:20001});await eventually(()=>b.replies.has(3));
  assert.equal(JSON.parse(b.replies.get(3).result.content[0].text).error.code,'INVALID_INPUT');
});

test('accord_more lists and reaches extra tools but never the legacy ones',async t=>{
  const b=await bridge(t);b.call(3,'accord_more');await eventually(()=>b.replies.has(3));
  const names=JSON.parse(b.replies.get(3).result.content[0].text).tools.map(t=>t.name);
  assert(names.includes('accord_job'));assert(!names.includes('accord_claim'));assert(!names.includes('accord_reserve'));
  b.call(4,'accord_more',{tool:'accord_claim',args:{key:'x'}});await eventually(()=>b.replies.has(4));
  assert.equal(JSON.parse(b.replies.get(4).result.content[0].text).error.code,'UNKNOWN_TOOL');
  b.call(5,'accord_more',{tool:'accord_jobs'});await eventually(()=>b.replies.has(5));assert(!b.replies.get(5).result.isError);
});

test('bootstrap publishes discoverable activity in one call and safely retries the same key',{timeout:10000},async t=>{
  const args={key:'startup',label:'Fresh collaborator',activity:'Investigating startup',location:'/test/project',capabilities:['review']};
  const b=await bridge(t,args);
  const joined=JSON.parse(b.replies.get(2).result.content[0].text);
  assert(Buffer.byteLength(b.replies.get(2).result.content[0].text)<16*1024);
  assert(!('board' in joined));assert(Buffer.byteLength(b.replies.get(2).result.content[0].text)<2000);
  assert.equal(joined.announced,true);
  assert(!joined.participants.some(p=>p.address===joined.address));
  const participant=(await b.h.client('admin').find(args.activity)).participants.find(p=>p.address===joined.address);
  assert(participant);
  assert.equal(participant.activity,args.activity);
  assert.equal(participant.location,args.location);
  assert.deepEqual(participant.capabilities,args.capabilities);
  assert.equal((await b.h.client('admin').find(args.activity)).participants[0].address,participant.address);
  b.call(3,'accord_bootstrap',args);
  await eventually(()=>b.replies.has(3));assert(!b.replies.get(3).result.isError);
  const events=(await b.h.client('admin').board()).events;
  assert.equal(events.filter(e=>e.kind==='session.opened').length,1);
  assert.equal(events.filter(e=>e.kind==='participant.updated').length,1);
  b.call(4,'accord_bootstrap');
  await eventually(()=>b.replies.has(4));
  assert.equal(JSON.parse(b.replies.get(4).result.content[0].text).announced,undefined);
  assert.equal((await b.h.client('admin').find(args.activity)).participants[0].address,participant.address);
});

test('partial bootstrap announcements fail before enrolling a session',async()=>{
  const {mcpAdapter}=await import('../src/mcp.mjs');
  const adapter=mcpAdapter('/nonexistent-profile');
  for(const args of [{label:'Missing activity'},{activity:'Missing label'},{capabilities:['review']},{label:' ',activity:'Work'}]){
    await assert.rejects(adapter.call('accord_bootstrap',args),error=>error.code==='INVALID_INPUT');
  }
  await adapter.close();
});

test('MCP calls expose pending mail without fetching bodies, including failed operations',async t=>{
  const b=await bridge(t),joined=JSON.parse(b.replies.get(2).result.content[0].text);
  await b.h.client('agent-b').send(joined.address,'Check before dependent work');
  await eventually(async()=>{b.call(3,'accord_host');await eventually(()=>b.replies.has(3));const r=JSON.parse(b.replies.get(3).result.content[0].text);b.replies.delete(3);return r.inboxPending===1;});
  b.call(4,'accord_announce',{label:'Still working',activity:'Check mail'});await eventually(()=>b.replies.has(4));
  const shown=JSON.parse(b.replies.get(4).result.content[0].text);assert.equal(shown.inboxPending,1);assert(!JSON.stringify(shown).includes('Check before dependent work'));
  b.call(5,'accord_reservation',{id:'does-not-exist'});await eventually(()=>b.replies.has(5));
  assert(b.replies.get(5).result.isError);assert.equal(JSON.parse(b.replies.get(5).result.content[0].text).inboxPending,1);
});

test('an existing MCP bridge can update a legacy expired session after host upgrade without reconnecting',{timeout:40000},async t=>{
  const b=await bridge(t),context=JSON.parse(b.replies.get(2).result.content[0].text),actor=context.address.split('/')[1];
  const port=Number(new URL(b.h.url).port);await stop(b.h.server);
  const db=new DatabaseSync(join(b.h.data,'coordinator.sqlite'));
  try{
    db.prepare("DELETE FROM meta WHERE key='session-continuity-v1'").run();
    db.prepare('UPDATE sessions SET persistent=0,expires_at=?,closed_at=? WHERE id=?').run(Date.now()-1000,Date.now()-1000,actor);
    db.prepare('INSERT INTO events(at,kind,data) VALUES(?,?,?)').run(Date.now()-1000,'session.expired',JSON.stringify({session:actor}));
  }finally{db.close();}
  await new Promise(resolve=>setTimeout(resolve,b.h.leaderMs+50));await b.h.startServer(port);
  b.call(3,'accord_announce',{key:'after-upgrade',label:'Still here',activity:'Updated without reenrolling'});
  await eventually(()=>b.replies.has(3));assert(!b.replies.get(3).result.isError);
  assert.equal(JSON.parse(b.replies.get(3).result.content[0].text).address,context.address);
  b.call(4,'accord_bootstrap');await eventually(()=>b.replies.has(4));assert(!b.replies.get(4).result.isError);
  assert.equal(JSON.parse(b.replies.get(4).result.content[0].text).address.split('/')[1],actor);
  assert.equal((await b.h.client('admin').board()).events.filter(e=>e.kind==='session.opened').length,1);
});

test('a long inbox wait does not hold announcements, discovery, or protocol ping behind it',{timeout:10000},async t=>{
  const b=await bridge(t);
  const started=performance.now();
  b.call(3,'accord_inbox',{waitMs:2000});
  b.call(4,'accord_announce',{key:'latency-check',label:'Responsive agent',activity:'Checking independent requests'});
  b.call(5,'accord_find',{query:'Responsive agent'});
  b.send(6,'ping');
  await eventually(()=>b.replies.has(4)&&b.replies.has(5)&&b.replies.has(6));
  assert(!b.replies.get(4).result.isError);
  assert(!b.replies.has(3),'the announcement and ping were blocked by the inbox wait');
  await eventually(()=>b.replies.has(3));
  assert(b.replies.get(4).at<b.replies.get(3).at);
  await eventually(()=>b.diagnostics().includes('"event":"finished"'));
  const records=b.diagnostics().split('\n').filter(line=>line.startsWith('{')).map(JSON.parse);
  assert(records.some(r=>r.tool==='accord_announce'&&r.event==='finished'&&r.outcome==='ok'));
  assert(!b.diagnostics().includes('Checking independent requests'));
  assert(!b.diagnostics().includes(b.h.credential('bootstrap')));
  t.diagnostic(JSON.stringify({announceMs:Math.round(b.replies.get(4).at-started),inboxWaitMs:Math.round(b.replies.get(3).at-started)}));
});

test('MCP saturation rejects an unstarted call promptly and keeps ping responsive',{timeout:10000},async t=>{
  const b=await bridge(t);
  for(let id=10;id<42;id++)b.call(id,'accord_inbox',{waitMs:2000});
  b.call(42,'accord_announce',{key:'must-not-run',label:'Should not appear',activity:'Rejected at capacity'});
  b.send(43,'ping');
  await eventually(()=>b.replies.has(42)&&b.replies.has(43));
  assert(b.replies.get(42).result.isError);
  assert.equal(JSON.parse(b.replies.get(42).result.content[0].text).error.code,'MCP_BUSY');
  assert(!b.replies.has(10),'capacity response waited behind long polling');
  assert.equal((await b.h.client('admin').find('Should not appear')).participants.length,0);
  await eventually(()=>b.replies.has(41));
  b.call(44,'accord_announce',{key:'after-capacity',label:'Recovered capacity',activity:'Responsive again'});
  await eventually(()=>b.replies.has(44));assert(!b.replies.get(44).result.isError);
});

test('the same MCP adapter can retry enrollment after a temporary host outage',{timeout:40000},async t=>{
  const h=await harness();t.after(()=>h.close());
  const {mcpAdapter}=await import('../src/mcp.mjs');
  const installed=install({home:join(h.data,'retry-home'),data:h.data});
  // Inherited native identity is not needed for this isolated bridge test.
  const names=['ACCORD_SESSION_FILE','CODEX_THREAD_ID','CLAUDE_SESSION_ID','TESSERA_TILE_ID'];
  const previous=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  for(const name of names)delete process.env[name];
  t.after(()=>{for(const name of names)if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];});
  const adapter=mcpAdapter(installed.profile);
  t.after(()=>adapter.close());
  const port=Number(new URL(h.url).port);await stop(h.server);
  await assert.rejects(adapter.call('accord_host'));
  await new Promise(resolve=>setTimeout(resolve,h.leaderMs+50));await h.startServer(port);
  assert.equal((await adapter.call('accord_host')).authority,(await h.client('admin').host()).authority);
  assert.equal((await h.client('admin').board()).events.filter(e=>e.kind==='session.opened').length,1);
});
