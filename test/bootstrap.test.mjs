// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { harness, eventually, stop, delay } from './helpers.mjs';
import { initialize } from '../src/config.mjs';
import { install } from '../src/installer.mjs';
import { servicePlan } from '../src/service.mjs';
import { enrollProfile, profileAt, discover } from '../src/bootstrap.mjs';
import { request, hash } from '../src/common.mjs';
import { AccordClient } from '../src/client.mjs';
import { runBootstrapDemo } from '../demo/bootstrap.mjs';

const cli=fileURLToPath(new URL('../src/cli.mjs',import.meta.url));
function temporary(t){const dir=mkdtempSync(join(tmpdir(),'accord-bootstrap-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
function setup(h){return install({home:join(h.data,'home'),data:h.data});}

test('installer dry-run is inert; repeat setup preserves customized skill, config, and identity',t=>{
  const root=temporary(t),data=join(root,'data'),home=join(root,'home');initialize(data);
  mkdirSync(join(home,'.codex'),{recursive:true});writeFileSync(join(home,'.codex','config.toml'),'model = "existing"\n');
  mkdirSync(join(home,'.agents','skills','accord'),{recursive:true});writeFileSync(join(home,'.agents','skills','accord','SKILL.md'),'custom instructions');
  const before=readFileSync(join(data,'config.json'),'utf8');
  install({home,data,dryRun:true});assert(!existsSync(join(home,'.local')));assert.equal(readFileSync(join(data,'config.json'),'utf8'),before);
  const first=install({home,data});assert(existsSync(first.profile));
  assert(readFileSync(join(home,'.codex','config.toml'),'utf8').startsWith('model = "existing"'));
  const backups=readdirSync(join(home,'.agents','skills','accord')).filter(p=>p.includes('backup-'));
  assert.equal(backups.length,1);assert.equal(readFileSync(join(home,'.agents','skills','accord',backups[0]),'utf8'),'custom instructions');
  const second=install({home,data});assert(second.steps.every(p=>p.action==='unchanged'));
  const manifest=JSON.parse(readFileSync(join(home,'.config','accord','install-manifest.json')));
  assert(!JSON.stringify(manifest).includes(readFileSync(join(data,'bootstrap.token'),'utf8')));
});
test('installer refuses conflicting MCP registration before writing other targets',t=>{
  const root=temporary(t),data=join(root,'data'),home=join(root,'home');initialize(data);
  mkdirSync(home);writeFileSync(join(home,'.claude.json'),JSON.stringify({mcpServers:{accord:{command:'custom'}}}));
  assert.throws(()=>install({home,data}),e=>e.code==='INSTALL_CONFLICT');assert(!existsSync(join(home,'.local')));
});
test('service manifests quote paths and keep credentials out of launch arguments',()=>{
  for(const platform of ['darwin','linux']){
    const plan=servicePlan({platform,data:'/tmp/accord data & logs',home:'/tmp/test home'});
    assert(plan.content.includes('--data'));assert(!plan.content.includes('.token'));assert(!plan.content.includes('credential'));
  }
});
test('enrollment creates distinct identities; discovery and enrollment credentials cannot claim',async t=>{
  const h=await harness();t.after(()=>h.close());const installed=setup(h);
  const one=await enrollProfile(installed.profile,{label:'same label'}),two=await enrollProfile(installed.profile,{label:'same label'});
  assert.equal(one.session.persistent,true);assert.equal(one.session.expiresAt,null);
  await assert.rejects(enrollProfile(installed.profile,{label:'invalid bound',ttlMs:0}),e=>e.code==='INVALID_INPUT');
  assert.notEqual((await one.me()).id,(await two.me()).id);
  const host=await discover(profileAt(installed.profile));assert.equal(host.resource.state,'unclaimed');
  for(const name of ['discovery','bootstrap']){
    await assert.rejects(request(h.url,h.credential(name),'/v1/claim',{key:randomUUID()}),e=>e.code==='UNAUTHORIZED');
    await assert.rejects(request(h.url,h.credential(name),'/v1/board'),e=>e.code==='UNAUTHORIZED');
  }
  await assert.rejects(one.pause(true),e=>e.code==='FORBIDDEN');
  const {taskId}=await h.client('admin').submit({title:'owned',input:'a',expectedHash:hash('A')});
  const pending=await one.claim({taskId});
  await assert.rejects(two.inspect(pending.id),e=>e.code==='NOT_OWNER');
  await one.closeSession();await assert.rejects(one.me(),e=>e.code==='SESSION_EXPIRED');
  await two.closeSession();
});
test('session expiry revokes ownership without prematurely freeing an unreachable driver',async t=>{
  const h=await harness();t.after(()=>h.close());const installed=setup(h);
  const c=await enrollProfile(installed.profile,{label:'short lived',ttlMs:1000});
  const task=await h.client('admin').submit({title:'expiry',input:'a',expectedHash:hash('A')});
  const claim=await c.claim({taskId:task.taskId,leaseMs:10000});
  await eventually(async()=>(await c.inspect(claim.id)).state==='running');await stop(h.driver,'SIGKILL');
  await eventually(async()=>(await h.client('admin').board()).claims[0].state==='revoking');
  await assert.rejects(c.me(),e=>e.code==='SESSION_EXPIRED');
  assert.deepEqual((await h.client('admin').board()).resource.holders,[claim.id]);
});
test('fresh agent with only installed profile discovers lease and waits through recovery', {timeout:20000},async()=>{
  const proof=await runBootstrapDemo();assert.equal(proof.status,'passed');assert.equal(proof.assertions.overlappingGrants,0);
});
test('two independent hosts share discovery; partitions and wrong authority stay unknown', {timeout:40000},async t=>{
  const a=await harness(),b=await harness();t.after(async()=>{await a.close();await b.close();});
  const authority=(await b.client('admin').host()).authority;
  const body={key:randomUUID(),authority,url:b.url,credential:b.credential('discovery')};
  await request(a.url,a.credential('admin'),'/v1/peers',body);
  let network=await a.client('admin').network();assert.equal(network.hosts.length,2);assert.equal(network.hosts[1].host.authority,authority);
  const task=await b.client('agent-a').submit({title:'remote hold',input:'a',expectedHash:hash('A')});
  const claim=await b.active(await b.client('agent-a').claim({taskId:task.taskId,leaseMs:10000}));
  network=await a.client('admin').network();assert.equal(network.hosts[1].host.resource.holder.claim,claim.id);
  assert(!JSON.stringify(network).includes(b.credential('discovery')));
  await assert.rejects(request(a.url,a.credential('agent-a'),'/v1/peers',body),e=>e.code==='FORBIDDEN');
  await assert.rejects(request(a.url,a.credential('admin'),'/v1/peers',{...body,key:randomUUID(),authority:'wrong'}),e=>e.code==='PEER_IDENTITY_CHANGED');
  const port=Number(new URL(b.url).port);await stop(b.server,'SIGKILL');
  network=await a.client('admin').network();assert.equal(network.hosts[1].status,'unknown');assert(!network.hosts[1].host);
  await delay(b.leaderMs+100);await b.startServer(port);
  network=await a.client('admin').network();assert.equal(network.hosts[1].status,'observed');
});
test('MCP stdio discovers tools and creates a session without exposing credentials', {timeout:10000},async t=>{
  const h=await harness();t.after(()=>h.close());const installed=setup(h);
  const child=spawn(process.execPath,[cli,'mcp','--profile',installed.profile],{stdio:['pipe','pipe','pipe']});t.after(()=>stop(child));
  let output='',error='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>error+=c);
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}})+'\n');
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'})+'\n');
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'accord_bootstrap',arguments:{}}})+'\n');
  await eventually(()=>output.split('\n').filter(Boolean).length===3);
  const replies=output.trim().split('\n').map(JSON.parse);
  assert(replies[1].result.tools.some(t=>t.name==='accord_reserve'));
  const context=JSON.parse(replies[2].result.content[0].text);assert(context.address);assert(!context.me);assert(!context.host);
  assert(!output.includes(h.credential('bootstrap')));assert(!output.includes('resourceToken'));assert(!output.includes('credential"'));
  child.stdin.end();await eventually(()=>child.exitCode!==null);assert.equal(child.exitCode,0,error);
  assert((await h.client('admin').board()).events.some(e=>e.kind==='session.closed'&&e.data.session===context.address.split('/')[1]));
});
test('run wrapper passes private context files to a fresh process and closes its session', {timeout:10000},async t=>{
  const h=await harness();t.after(()=>h.close());const installed=setup(h);
  const code=`const fs=require('fs');const context=JSON.parse(fs.readFileSync(process.env.ACCORD_CONTEXT_FILE));console.log(JSON.stringify({id:process.env.ACCORD_SESSION_ID,contextId:context.me.id,sessionFile:process.env.ACCORD_SESSION_FILE}));`;
  const child=spawn(process.execPath,[cli,'run','--profile',installed.profile,'--',process.execPath,'-e',code],{stdio:['ignore','pipe','pipe']});t.after(()=>stop(child));
  let output='',error='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>error+=c);
  await eventually(()=>child.exitCode!==null);assert.equal(child.exitCode,0,error);
  const info=JSON.parse(output);assert.equal(info.id,info.contextId);assert(!existsSync(info.sessionFile));
  assert((await h.client('admin').board()).events.some(e=>e.kind==='session.closed'&&e.data.session===info.id));
});
test('wrong pinned authority fails before creating any session',async t=>{
  const h=await harness();t.after(()=>h.close());
  await assert.rejects(AccordClient.enroll(h.url,h.credential('bootstrap'),{label:'wrong',authority:'other'}),e=>e.code==='AUTHORITY_MISMATCH');
  assert(!(await h.client('admin').board()).events.some(e=>e.kind==='session.opened'));
});

test('local TCP forwarding supports discovery and enrollment on a different port',async t=>{
  const h=await harness();t.after(()=>h.close());
  const sockets=new Set();
  const forward=net.createServer(downstream=>{
    const upstream=net.connect(Number(new URL(h.url).port),'127.0.0.1');
    sockets.add(downstream);sockets.add(upstream);
    downstream.on('error',()=>upstream.destroy());upstream.on('error',()=>downstream.destroy());
    downstream.on('close',()=>{sockets.delete(downstream);upstream.destroy();});
    upstream.on('close',()=>{sockets.delete(upstream);downstream.destroy();});
    downstream.pipe(upstream).pipe(downstream);
  });
  t.after(()=>new Promise(r=>{for(const socket of sockets)socket.destroy();forward.close(r);}));
  await new Promise(r=>forward.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${forward.address().port}`,authority=(await h.client('admin').host()).authority;
  const client=await AccordClient.enroll(url,h.credential('bootstrap'),{authority,label:'forwarded agent'});
  assert.equal((await client.host()).authority,authority);
  const task=await client.submit({title:'forwarded',input:'a',expectedHash:hash('A')});
  let claim=await client.claim({taskId:task.taskId});
  claim=await eventually(async()=>{const c=await client.inspect(claim.id);return c.state==='running'&&c;});
  const receipt=await client.writeViaHost(claim,'A');await client.finish(claim.id,receipt.id);
  await eventually(async()=>(await client.board()).tasks[0].state==='succeeded');await client.closeSession();
  const cross=await fetch(url+'/v1/host',{headers:{Authorization:`Bearer ${h.credential('discovery')}`,Origin:h.url}});
  assert.equal(cross.status,403);
});

test('install --help never initializes a host or changes the selected home',async t=>{
  const root=temporary(t),home=join(root,'untouched');
  const child=spawn(process.execPath,[cli,'install','--home',home,'--help'],{stdio:['ignore','pipe','pipe']});t.after(()=>stop(child));
  child.stdout.resume();child.stderr.resume();await eventually(()=>child.exitCode!==null);
  assert.equal(child.exitCode,0);assert(!existsSync(home));
});
test('session enrollment retries preserve identity and cannot resurrect a closed session',async t=>{
  const h=await harness();t.after(()=>h.close());const authority=(await h.client('admin').host()).authority;
  const options={authority,label:'retry session',key:'stable-enrollment'};
  const a=await AccordClient.enroll(h.url,h.credential('bootstrap'),options);
  const b=await AccordClient.enroll(h.url,h.credential('bootstrap'),options);
  assert.equal(a.session.sessionId,b.session.sessionId);assert.equal(a.credential,b.credential);
  await a.closeSession();
  await assert.rejects(AccordClient.enroll(h.url,h.credential('bootstrap'),options),e=>e.code==='SESSION_EXPIRED');
  await assert.rejects(AccordClient.enroll(h.url,h.credential('bootstrap'),{...options,label:'changed'}),e=>e.code==='KEY_REUSED');
});
test('unavailable login notice reports unknown and exits nonzero without leaking profile credentials',async t=>{
  const h=await harness();t.after(()=>h.close());const installed=setup(h);await stop(h.server);
  const child=spawn(process.execPath,[cli,'host','--profile',installed.profile,'--notice'],{stdio:['ignore','pipe','pipe']});t.after(()=>stop(child));
  let output='';child.stdout.on('data',c=>output+=c);child.stderr.resume();
  await eventually(()=>child.exitCode!==null);assert.equal(child.exitCode,1);assert.match(output,/UNKNOWN/);
  assert(!output.includes(h.credential('discovery')));
});

test('installer forwards wrapper session identity into Codex MCP and upgrades its exact previous registration',t=>{
  const root=temporary(t),data=join(root,'data'),home=join(root,'home');initialize(data);
  install({home,data});const path=join(home,'.codex','config.toml');
  const current=readFileSync(path,'utf8');assert.match(current,/env_vars = .*ACCORD_SESSION_FILE/);
  const legacy=current.replace(/^env_vars = .*\n/m,'')+'\n[extra_user_setting]\nkeep = true\n';
  writeFileSync(path,legacy);install({home,data});
  const upgraded=readFileSync(path,'utf8');assert.match(upgraded,/env_vars = .*ACCORD_SESSION_FILE/);
  assert(upgraded.endsWith('[extra_user_setting]\nkeep = true\n'));
  assert.equal(upgraded.split('[mcp_servers.accord]').length,2);
});

test('HTTP bootstrap stays small, keeps old collaborators searchable, and leaves full messages unread',{timeout:10000},async t=>{
  const h=await harness();t.after(()=>h.close());const installed=setup(h);
  const c=await enrollProfile(installed.profile,{label:'Compact join'}),first=await c.bootstrap();
  const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(join(h.data,'coordinator.sqlite'));
  try{
    db.exec('BEGIN');
    for(let i=0;i<80;i++){
      db.prepare("INSERT INTO actors VALUES(?,?,'worker')").run('old-'+i,'old-hash-'+i);
      db.prepare('INSERT INTO participants VALUES(?,?,?,?,?,?)').run('old-'+i,'Older collaborator '+i,'[]','x'.repeat(1000),'/old',0);
    }
    db.exec('COMMIT');
  }finally{db.close();}
  for(let i=0;i<5;i++)await h.client('admin').send(first.address,'x'.repeat(4000),{key:'preview-'+i});
  await eventually(async()=>(await c.inbox()).messages.length===5);
  const compact=await c.bootstrap();
  assert(Buffer.byteLength(JSON.stringify(compact))<=12*1024);
  assert(!compact.board);assert(compact.directory.participants.every(p=>p.presence==='recent'));
  assert(compact.inbox.messages.length<=3);
  assert(compact.inbox.messages.every(m=>m.preview&&m.text.length<=400));
  const complete=await c.inbox();assert.equal(complete.messages.length,5);assert(complete.messages.every(m=>m.text.length===4000));
  assert.equal((await c.find('Older collaborator 79')).participants.length,1);
  const found=await c.find('Older collaborator');
  assert.equal(found.participants.length,20);assert.equal(found.moreParticipants,60);
  assert(Buffer.byteLength(JSON.stringify(found))<8192);
  assert(found.hosts.every(h=>!h.participants&&!h.resources));
  const full=await c.find('Older collaborator',{detail:true});
  assert.equal(full.participants.length,80);assert.equal(full.participants[0].activity.length,1000);
});
