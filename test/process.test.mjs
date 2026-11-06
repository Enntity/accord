// SPDX-License-Identifier: MIT
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { harness, eventually, delay, stop } from './helpers.mjs';
import { request, hash } from '../src/common.mjs';
import { groupExists } from '../src/plugins/posix-process-group.mjs';
const test=process.platform==='win32'?nodeTest.skip:nodeTest;// POSIX process groups only.
const fixture=fileURLToPath(new URL('./fixtures/workload.mjs',import.meta.url));
const key=()=>randomUUID();
async function setup(t,mode='tree'){
  const h=await harness(),groups=[];
  t.after(async()=>{for(const pid of groups){try{process.kill(-pid,'SIGKILL');}catch{}}await h.close();});
  const admin=h.client('admin'),a=h.client('agent-a'),b=h.client('agent-b'),trace=join(h.data,'workload.jsonl');
  const manifest={schema:1,id:'compute-slot',asset:'test:cpu-slot',plugin:'posix-process-group',command:[process.execPath,fixture,mode],cwd:h.data,env:{ACCORD_TEST_TRACE:trace},terminationGraceMs:80};
  const binding=await admin.registerResource(manifest);
  const submitted=await admin.submit({title:'Process recovery',input:'controlled workload',resource:manifest.id,expectedHash:hash('process result')});
  const claim=await a.claim({key:key(),taskId:submitted.taskId,leaseMs:5000});
  const active=await h.active(claim);
  const run=await a.startProcess(active.id,'launch');groups.push(run.pgid);
  const lines=()=>existsSync(trace)?readFileSync(trace,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  await eventually(()=>lines().some(l=>l.event==='started'));
  return {h,admin,a,b,manifest,binding,submitted,active,run,groups,lines};
}
async function cancelAndStopped(s){await s.admin.cancel(s.submitted.taskId);await eventually(async()=>!(await s.admin.board()).claims.some(c=>c.id===s.active.id&&c.state!=='closed'));assert.equal(groupExists(s.run.pgid),false);}

test('registered process completes only after group absence; repeat launch is idempotent',async t=>{
  const s=await setup(t,'once');
  assert.equal((await s.a.startProcess(s.active.id,'launch')).id,s.run.id);
  await assert.rejects(s.a.startProcess(s.active.id,'different'),{code:'ALREADY_STARTED'});
  await eventually(async()=> (await s.a.processStatus(s.active.id)).state==='exited');
  assert(groupExists(s.run.pgid));
  await s.a.finish(s.active.id,s.run.id,key());
  await eventually(async()=> (await s.admin.board()).tasks.find(t=>t.id===s.submitted.taskId).state==='succeeded');
  assert.equal(groupExists(s.run.pgid),false);
  const events=(await request(s.h.driverUrl,s.h.credential('driver-control'),'/control/audit?resource=compute-slot')).events;
  assert(events.findIndex(e=>e.kind==='process.stopped')<events.findIndex(e=>e.kind==='grant.revoked'));
});

test('TERM-resistant parent and descendant are both dead before a new generation',async t=>{
  const s=await setup(t);await eventually(()=>new Set(s.lines().filter(l=>l.event==='heartbeat').map(l=>l.pid)).size===2);
  const next=await s.admin.submit({title:'next',input:'next',resource:s.manifest.id,expectedHash:hash('process result')});
  await s.admin.cancel(s.submitted.taskId);
  const claim=await s.b.waitClaim({key:key(),taskId:next.taskId,waitMs:5000,leaseMs:5000});
  await s.h.active(claim);assert(claim.generation>s.active.generation);assert.equal(groupExists(s.run.pgid),false);
  const count=s.lines().length;await delay(120);assert.equal(s.lines().length,count);
  await assert.rejects(request(s.h.driverUrl,s.active.resourceToken,'/v1/processes?resource=compute-slot',{key:'late'}),{code:'STALE_GRANT'});
  await s.admin.cancel(next.taskId);
});

test('driver SIGKILL leaves workload alive and holds ownership until restart proves stop',async t=>{
  const s=await setup(t);const port=Number(new URL(s.h.driverUrl).port);
  await stop(s.h.driver,'SIGKILL');assert(groupExists(s.run.pgid));
  await s.admin.cancel(s.submitted.taskId);await delay(250);
  assert((await s.admin.board()).resources.find(r=>r.id===s.manifest.id).holders.includes(s.active.id));
  await assert.rejects(s.b.claim({key:key(),taskId:s.submitted.taskId}),{code:'TASK_BUSY'});
  await s.h.startDriver(port);
  await eventually(async()=> (await s.admin.board()).claims.find(c=>c.id===s.active.id).state==='closed');
  assert.equal(groupExists(s.run.pgid),false);
  await assert.rejects(request(s.h.driverUrl,s.active.resourceToken,'/v1/processes?resource=compute-slot',{key:'late'}),{code:'STALE_GRANT'});
});

test('coordinator SIGKILL recovers a running process and preserved resource registration',async t=>{
  const s=await setup(t);const port=Number(new URL(s.h.url).port);await stop(s.h.server,'SIGKILL');
  assert(groupExists(s.run.pgid));await delay(s.h.leaderMs+100);await s.h.startServer(port);
  await eventually(async()=> (await s.admin.board()).claims.find(c=>c.id===s.active.id).state==='closed');
  assert.equal(groupExists(s.run.pgid),false);
  assert((await s.admin.resources()).resources.some(r=>r.id.endsWith('/'+s.manifest.id)));
});

test('workload parent crash does not hide its surviving descendant',async t=>{
  const s=await setup(t,'orphan');await eventually(async()=> (await s.a.processStatus(s.active.id)).state==='exited');
  assert(groupExists(s.run.pgid));await assert.rejects(s.a.finish(s.active.id,s.run.id,key()),{code:'PROCESS_NOT_SUCCEEDED'});
  await cancelAndStopped(s);
});

test('unresponsive supervisor keeps release held; resuming permits safe recovery',async t=>{
  const s=await setup(t);process.kill(s.run.pgid,'SIGSTOP');
  t.after(()=>{try{process.kill(s.run.pgid,'SIGCONT');}catch{}});
  await s.admin.cancel(s.submitted.taskId);await delay(600);
  const held=(await s.admin.board()).claims.find(c=>c.id===s.active.id);assert.equal(held.state,'revoking');assert(groupExists(s.run.pgid));
  process.kill(s.run.pgid,'SIGCONT');await eventually(async()=> (await s.admin.board()).claims.find(c=>c.id===s.active.id).state==='closed');
  assert.equal(groupExists(s.run.pgid),false);
});

test('lost anchor with live descendants fails closed until external stop is observed',async t=>{
  const s=await setup(t);await eventually(()=>new Set(s.lines().filter(l=>l.event==='heartbeat').map(l=>l.pid)).size===2);
  process.kill(s.run.pgid,'SIGKILL');await s.admin.cancel(s.submitted.taskId);await delay(500);
  assert(groupExists(s.run.pgid));assert.equal((await s.admin.board()).claims.find(c=>c.id===s.active.id).state,'revoking');
  // Simulated operator repair of this test-owned group. The driver itself never
  // sends a signal to a potentially reused recovered PID.
  process.kill(-s.run.pgid,'SIGKILL');
  await eventually(async()=> (await s.admin.board()).claims.find(c=>c.id===s.active.id).state==='closed');
});

test('registration is administrator-only, immutable, asset-unique, and independent of artifact slot',async t=>{
  const s=await setup(t);
  const {notice}=await import('../src/bootstrap.mjs');assert.match(notice(await s.a.host()),/compute-slot: held/);
  await assert.rejects(s.a.registerResource({...s.manifest,id:'other'}),{code:'FORBIDDEN'});
  await assert.rejects(s.admin.registerResource({...s.manifest,id:'other'}),{code:'RESOURCE_CONFLICT'});
  await assert.rejects(s.admin.registerResource({...s.manifest,command:[process.execPath,'--version']}),{code:'RESOURCE_CONFLICT'});
  assert.equal((await s.admin.registerResource(s.manifest)).instance,s.binding.instance);
  const task=await s.admin.submit({title:'independent artifact',input:'x',expectedHash:hash('x')});
  await s.admin.submit({title:'blocked process task',input:'x',resource:s.manifest.id,expectedHash:hash('x')});
  const claim=await s.b.claim({key:key()});assert.equal(claim.task_id,task.taskId);await s.h.active(claim);
  assert(groupExists(s.run.pgid));await s.admin.cancel(task.taskId);await cancelAndStopped(s);
});

for(const point of ['before-commit','before-arm'])test(`driver crash ${point} never executes an uncommitted workload`,async t=>{
  const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os');
  const {launch}=await import('./helpers.mjs'),{ProcessDriver}=await import('../src/process-driver.mjs');
  const root=mkdtempSync(join(tmpdir(),'accord-launch-')),trace=join(root,'trace'),pidFile=join(root,'pid'),file=join(root,'process.sqlite');
  const manifest={schema:1,id:'test',asset:'test:launch',plugin:'posix-process-group',command:[process.execPath,fixture,'tree'],cwd:root,env:{ACCORD_TEST_TRACE:trace}};
  const proc=launch(new URL('./fixtures/launch-crash.mjs',import.meta.url));
  t.after(async()=>{await stop(proc);if(existsSync(pidFile)){try{process.kill(-Number(readFileSync(pidFile,'utf8')),'SIGKILL');}catch{}}rmSync(root,{recursive:true,force:true});});
  proc.send({file,manifest,point,pidFile});await eventually(()=>proc.signalCode==='SIGKILL');
  const pid=Number(readFileSync(pidFile,'utf8'));
  await eventually(()=>!groupExists(pid),12000);assert.equal(existsSync(trace),false);
  const driver=new ProcessDriver(file,manifest);t.after(()=>driver.close());
  const result=await driver.revoke({instance:driver.status().instance,authority:'test-authority',epoch:2,generation:1,claimId:'test-claim'});
  assert.equal(result.released,true);assert.equal(driver.status().claim_id,null);
});

test('bad anchor authentication cannot stop an active workload',async t=>{
  const s=await setup(t),{DatabaseSync}=await import('node:sqlite'),http=await import('node:http');
  const db=new DatabaseSync(join(s.h.data,'process-compute-slot.sqlite'));
  const row=db.prepare('SELECT socket FROM runs WHERE id=?').get(s.run.id);db.close();
  const status=await new Promise((resolve,reject)=>{const req=http.request({socketPath:row.socket,path:'/stop',method:'POST',headers:{'Content-Type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(JSON.stringify({token:'wrong',signal:'SIGKILL'}));});
  assert.equal(status,403);assert(groupExists(s.run.pgid));await cancelAndStopped(s);
});

test('CLI discovery and fresh MCP session can run a registered process through completion',async t=>{
  const s=await setup(t,'once');await cancelAndStopped(s);
  const {writeFileSync}=await import('node:fs'),{mcpAdapter}=await import('../src/mcp.mjs');
  const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
  const cli=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../src/cli.mjs',import.meta.url)),'resource','list','--data',s.h.data]);
  assert(JSON.parse(cli.stdout).resources.some(r=>r.id.endsWith('/'+s.manifest.id)));
  const profile=join(s.h.data,'profile.json');writeFileSync(profile,JSON.stringify({schema:1,authority:(await s.admin.host()).authority,url:s.h.url,enrollmentFile:join(s.h.data,'bootstrap.token'),discoveryFile:join(s.h.data,'discovery.token')}),{mode:0o600});
  const adapter=mcpAdapter(profile);t.after(()=>adapter.close());
  const context=await adapter.call('accord_bootstrap');assert(context.address);
  assert((await adapter.call('accord_resources')).resources.some(r=>r.id.endsWith('/'+s.manifest.id)));
  const task=await s.admin.submit({title:'MCP process',input:'test',resource:s.manifest.id,expectedHash:hash('process result')});
  const claim=await adapter.call('accord_claim',{key:'mcp-claim',resource:s.manifest.id,leaseMs:5000});assert.equal(claim.task_id,task.taskId);
  await eventually(async()=> (await adapter.call('accord_claim_status',{claimId:claim.id})).state==='running');
  const run=await adapter.call('accord_process_start',{key:'mcp-start',claimId:claim.id});s.groups.push(run.pgid);
  assert(!JSON.stringify(run).includes('control_token'));
  await eventually(async()=> (await adapter.call('accord_process_status',{claimId:claim.id})).state==='exited');
  await adapter.call('accord_finish',{key:'mcp-finish',claimId:claim.id,receiptId:run.id});
  await eventually(async()=> (await s.admin.board()).tasks.find(t=>t.id===task.taskId).state==='succeeded');assert(!groupExists(run.pgid));
});

test('replaced process database stays fenced and doctor reports degraded despite healthy artifact driver',async t=>{
  const s=await setup(t),{rmSync,writeFileSync}=await import('node:fs');
  const {DatabaseSync}=await import('node:sqlite'),{dirname}=await import('node:path');
  const db=new DatabaseSync(join(s.h.data,'process-compute-slot.sqlite'));
  const run=db.prepare('SELECT socket FROM runs WHERE id=?').get(s.run.id);db.close();
  t.after(()=>rmSync(dirname(run.socket),{recursive:true,force:true}));
  const port=Number(new URL(s.h.driverUrl).port);await stop(s.h.driver,'SIGKILL');
  for(const suffix of ['','-wal','-shm'])rmSync(join(s.h.data,'process-compute-slot.sqlite'+suffix),{force:true});
  await s.h.startDriver(port);await s.admin.cancel(s.submitted.taskId);
  await eventually(async()=> (await s.admin.board()).claims.find(c=>c.id===s.active.id).error==='DRIVER_REPLACED');
  assert(groupExists(s.run.pgid));
  const host=await s.admin.host();assert.equal(host.resource.driver,'reachable');assert.equal(host.resources.find(r=>r.localId===s.manifest.id).driver,'DRIVER_REPLACED');
  const profile=join(s.h.data,'doctor-profile.json');writeFileSync(profile,JSON.stringify({schema:1,authority:host.authority,url:s.h.url,discoveryFile:join(s.h.data,'discovery.token')}),{mode:0o600});
  const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
  const result=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../src/cli.mjs',import.meta.url)),'doctor','--profile',profile]);
  assert.equal(JSON.parse(result.stdout).status,'degraded');
  await assert.rejects(s.b.claim({key:key(),taskId:s.submitted.taskId}),{code:'TASK_BUSY'});
});

test('a process window that its restarted driver cannot resume is fenced, its group stopped, and the resource regranted',async t=>{
  const h=await harness(),groups=[];
  t.after(async()=>{for(const pid of groups){try{process.kill(-pid,'SIGKILL');}catch{}}await h.close();});
  const manifest={schema:1,id:'compute-slot',asset:'test:cpu-slot',plugin:'posix-process-group',command:[process.execPath,fixture,'tree'],cwd:h.data,env:{ACCORD_TEST_TRACE:join(h.data,'workload.jsonl')},terminationGraceMs:80};
  await h.client('admin').registerResource(manifest);
  const a=h.client('agent-a'),b=h.client('agent-b'),r=await a.reserve('compute-slot',{durationMs:3600000});
  await eventually(async()=>(await a.reservation(r.id)).state==='running');
  const run=await a.collaborate('start',{id:r.id,key:'launch'});groups.push(run.pgid);
  await eventually(()=>groupExists(run.pgid));
  const next=await b.reserve('compute-slot',{durationMs:60000});
  const serverPort=Number(new URL(h.url).port),driverPort=Number(new URL(h.driverUrl).port);
  await stop(h.server,'SIGKILL');await stop(h.driver,'SIGKILL');await delay(h.leaderMs+50);
  await h.startDriver(driverPort);await h.startServer(serverPort);
  await eventually(async()=>(await a.reservation(r.id)).state==='failed');
  assert.equal(groupExists(run.pgid),false);
  await eventually(async()=>(await b.reservation(next.id)).state==='running');
});
