import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { harness, eventually, stop, delay } from './helpers.mjs';
import { createHttp, listen, readBody, hash, request } from '../src/common.mjs';
import { ManagedDriver } from '../src/managed-driver.mjs';
import { WorkloadGuard } from '../src/workload-guard.mjs';

test('registered external container stops before restoration/regrant after coordinator AND driver crash', {timeout:40000,skip:process.platform==='win32'}, async t=>{
  const h=await harness();t.after(()=>h.close());
  const container='a'.repeat(64),socket=join(h.data,'docker.sock');let child,labels={},started=false,blockStop=true,engine='fixture-engine',restored=false;const log=[];
  const docker=http.createServer(async(req,res)=>{
    req.resume();res.setHeader('content-type','application/json');
    const answer=(code,value={})=>{res.statusCode=code;res.end(JSON.stringify(value));};
    if(req.url==='/info')return answer(200,{ID:engine});
    if(req.url.endsWith('/json'))return answer(200,{Id:container,Config:{Labels:labels},HostConfig:{RestartPolicy:{Name:'no'}},State:{Running:!!child&&child.exitCode===null&&child.signalCode===null,StartedAt:started?'2026-01-01T00:00:00Z':'0001-01-01T00:00:00Z'}});
    if(req.url.endsWith('/start')){child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});await once(child,'spawn');started=true;log.push('started');res.statusCode=204;return res.end();}
    if(req.url.endsWith('/update'))return answer(200);
    if(req.url.includes('/stop')){if(blockStop)return answer(503);await stop(child);log.push('old-process-absent');res.statusCode=204;return res.end();}
    answer(404);
  });await new Promise(r=>docker.listen(socket,r));
  t.after(async()=>{await stop(child);await new Promise(r=>docker.close(r));});
  const provider=createHttp(async(req,res,url)=>{const b=await readBody(req),action=url.pathname.slice(1);if(action==='restore'){assert(child?.exitCode!==null||child?.signalCode!==null);restored=true;log.push('restored');}return {...b,[action]:true};});
  const endpoint=await listen(provider);t.after(()=>new Promise(r=>provider.close(r)));
  const tokenFile=join(h.data,'provider.token');writeFileSync(tokenFile,'provider');
  writeFileSync(join(h.data,'workload-policy.json'),JSON.stringify({schema:1,hosts:{local:{transport:'local',socket}},resources:{models:{hosts:['local'],plugins:['docker-container']}}}));
  await h.client('admin').registerResource({schema:1,id:'models',asset:'fixture:models',plugin:'managed-http',endpoint,tokenFile});
  const a=h.client('agent-a'),b=h.client('agent-b');const ra=await a.reserve('models',{leaseMs:20000});await eventually(async()=>(await a.reservation(ra.id)).state==='running');
  const grant=await a.reservation(ra.id),host=await a.host();labels={'accord.authority':host.authority,'accord.claim':grant.claimId,'accord.generation':String(grant.generation)};
  const targets=[{plugin:'docker-container',host:'local',id:container}];
  await assert.rejects(b.collaborate('workload-register',{id:ra.id,key:'wrong-owner',targets}));
  const registered=await a.collaborate('workload-register',{id:ra.id,key:'registration',targets});
  assert.equal((await a.collaborate('workload-register',{id:ra.id,key:'registration',targets})).workloads[0].id,registered.workloads[0].id);
  const workload=registered.workloads[0].id;
  await a.collaborate('workload-launch',{id:ra.id,key:'launch',workload});assert(child?.pid);assert.equal(log.filter(x=>x==='started').length,1);
  await a.collaborate('workload-launch',{id:ra.id,key:'launch',workload});assert.equal(log.filter(x=>x==='started').length,1);
  const rb=await b.reserve('models',{leaseMs:20000});
  const port=Number(new URL(h.url).port),driverPort=Number(new URL(h.driverUrl).port);
  await stop(h.server,'SIGKILL');await stop(h.driver,'SIGKILL');await delay(h.leaderMs+50);await h.startDriver(driverPort);await h.startServer(port);
  await delay(500);assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);assert.notEqual((await b.reservation(rb.id)).state,'running');assert.equal(restored,false);
  await assert.rejects(a.collaborate('workload-launch',{id:ra.id,key:'stale',workload}));
  engine='replacement-engine';blockStop=false;await delay(400);assert.notEqual((await b.reservation(rb.id)).state,'running');assert.equal(child.exitCode,null);
  engine='fixture-engine';await eventually(async()=>(await b.reservation(rb.id)).state==='running');
  assert(child.exitCode!==null||child.signalCode!==null);assert.equal(restored,true);assert(log.indexOf('old-process-absent')<log.indexOf('restored'));
  await b.release(rb.id);await eventually(async()=>(await b.reservation(rb.id)).state==='released');
});

async function unit(t) {
  const dir=mkdtempSync(join(tmpdir(),'accord-external-unit-'));const tokenFile=join(dir,'token');writeFileSync(tokenFile,'test');
  const provider=createHttp(async(req,res,url)=>{const b=await readBody(req);return {...b,[url.pathname.slice(1)]:true};});const endpoint=await listen(provider);
  let mode='ok';const calls=[];const observed={identity:{engine:'one',id:'a'.repeat(64)},exists:true,running:false,restart:'no',started:false,labels:{}};
  const transport=async(c,action,target)=>{calls.push(action+':'+target.plugin);if(mode==='unavailable')throw Error('unavailable');if(target.plugin==='systemd-user-unit')return {...observed,identity:{machine:'one',unit:target.id,invocation:'one',definition:'stable'},running:action!=='stop',killMode:'control-group'};if(action==='start'){observed.started=true;observed.running=true;if(mode==='lost-reply')throw Error('reply lost');}if(action==='stop')observed.running=false;return structuredClone(observed);};
  const manifest={schema:1,id:'resource',asset:'fixture',plugin:'managed-http',endpoint,tokenFile};let guard;
  const open=()=>new WorkloadGuard(new ManagedDriver(join(dir,'driver'),manifest),join(dir,'external'),'unused',{transport,policy:()=>({transport:'fixture'})});guard=open();
  const s=guard.status(),grant={instance:s.instance,authority:'authority',epoch:1,generation:1,claimId:'claim',credentialHash:hash('secret')};await guard.activate(grant);
  observed.labels={'accord.authority':grant.authority,'accord.claim':grant.claimId,'accord.generation':'1'};
  t.after(async()=>{guard.close();await new Promise(r=>provider.close(r));rmSync(dir,{recursive:true,force:true});});
  return {get guard(){return guard;},grant,calls,observed,setMode:m=>{mode=m;},restart:()=>{guard.close();guard=open();},target:{host:'local',plugin:'docker-container',id:'a'.repeat(64)}};
}
test('unauthorized registration cannot poison recovery; conflicting retries and stale grants fail',async t=>{
  const f=await unit(t);f.observed.labels={};await assert.rejects(f.guard.registerExternal('secret',{key:'bad',targets:[f.target]}),{code:'WORKLOAD_NOT_OWNED'});assert.equal(f.guard.rows('claim').length,0);
  f.observed.labels={'accord.authority':'authority','accord.claim':'claim','accord.generation':'1'};
  await f.guard.registerExternal('secret',{key:'ok',targets:[f.target]});
  await assert.rejects(f.guard.registerExternal('secret',{key:'ok',targets:[{...f.target,id:'b'.repeat(64)}]}),{code:'KEY_CONFLICT'});
  await f.guard.revoke(f.grant);await assert.rejects(f.guard.registerExternal('secret',{key:'late',targets:[f.target]}),{code:'STALE_GRANT'});
});
test('interrupted operator adoption remains held across restart until exact inspection is reconciled',async t=>{
  const f=await unit(t);f.setMode('unavailable');await assert.rejects(f.guard.adoptExternal({...f.grant,key:'adopt',targets:[f.target]}));f.restart();
  await assert.rejects(f.guard.revoke(f.grant),{code:'WORKLOAD_UNKNOWN'});f.setMode('ok');
  await f.guard.adoptExternal({...f.grant,key:'adopt',targets:[f.target]});await f.guard.revoke(f.grant);
  assert.equal(f.guard.fence('claim').phase,'idle');
});
test('lost launch reply never restarts an exited workload; stop still precedes release',async t=>{
  const f=await unit(t),r=await f.guard.registerExternal('secret',{key:'register',targets:[f.target]});f.setMode('lost-reply');
  await assert.rejects(f.guard.launchExternal('secret',{key:'launch',workload:r.workloads[0].id}));f.observed.running=false;f.setMode('ok');
  await f.guard.launchExternal('secret',{key:'launch',workload:r.workloads[0].id});assert.equal(f.calls.filter(x=>x.startsWith('start:')).length,1);
  await f.guard.revoke(f.grant);assert.equal(f.guard.fence('claim').phase,'idle');
});
test('an unresolved launch intent blocks release if it could still execute',async t=>{
  const f=await unit(t),r=await f.guard.registerExternal('secret',{key:'register',targets:[f.target]});f.setMode('unavailable');
  await assert.rejects(f.guard.launchExternal('secret',{key:'launch',workload:r.workloads[0].id}));f.setMode('ok');
  await assert.rejects(f.guard.revoke(f.grant),{code:'START_UNKNOWN'});assert.equal(f.guard.fence('claim').phase,'revoking');
});

test('supervisors stop before containers regardless of registration order',async t=>{
  const f=await unit(t);
  await f.guard.adoptExternal({...f.grant,key:'adopt',targets:[f.target,{host:'local',plugin:'systemd-user-unit',id:'fixture.service'}]});
  await f.guard.revoke(f.grant);
  assert.deepEqual(f.calls.filter(c=>c.startsWith('stop:')),['stop:systemd-user-unit','stop:docker-container']);
});

test('changed host identity on a stop reply cannot authorize restoration or another owner',async t=>{
  const f=await unit(t);await f.guard.registerExternal('secret',{key:'register',targets:[f.target]});
  f.observed.identity.engine='replacement';
  await assert.rejects(f.guard.revoke(f.grant),{code:'WORKLOAD_REPLACED'});
  await assert.rejects(f.guard.activate({...f.grant,claimId:'next',generation:2}),{code:'RECOVERING'});
  assert.equal(f.guard.driver.status().claim_id,'claim');
  f.observed.identity.engine='one';await f.guard.revoke(f.grant);
  await f.guard.activate({...f.grant,claimId:'next',generation:2});
});

test('a lost release reply is replayed without re-stopping already released attachments',async t=>{
  const f=await unit(t);await f.guard.registerExternal('secret',{key:'register',targets:[f.target]});
  await f.guard.revoke(f.grant);f.setMode('unavailable');
  await f.guard.revoke(f.grant);assert.equal(f.calls.filter(x=>x.startsWith('stop:')).length,1);
  assert.equal(f.guard.driver.status().claim_id,null);
});

test('a previously started object is not a fresh worker registration',async t=>{
  const f=await unit(t);f.observed.started=true;
  await assert.rejects(f.guard.registerExternal('secret',{key:'used',targets:[f.target]}),{code:'WORKLOAD_NOT_OWNED'});
  assert.equal(f.guard.rows('claim').length,0);
});

test('workload connectors reject unsafe SSH arguments and relative credential paths',async()=>{
  const {validateWorkloadConnector}=await import('../src/workload-transport.mjs');
  const valid={transport:'ssh',host:'worker',node:'/usr/bin/node',helper:'/opt/accord/src/workload-host.mjs',identityFile:'/private/key',knownHostsFile:'/private/known_hosts'};
  assert.deepEqual(validateWorkloadConnector(valid),valid);
  for(const invalid of [{host:'-oProxyCommand=oops'},{helper:'relative'},{identityFile:'relative'},{knownHostsFile:[]},{socket:33}])assert.throws(()=>validateWorkloadConnector({...valid,...invalid}),{code:'WORKLOAD_POLICY'});
});

test('loss of the external journal cannot silently forget workloads on restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'accord-journal-loss-'));
  const manifest={schema:1,id:'resource',asset:'fixture',plugin:'managed-http',endpoint:'http://127.0.0.1:1',tokenFile:join(dir,'token')};
  const original=new WorkloadGuard(new ManagedDriver(join(dir,'driver'),manifest),join(dir,'external'),'unused');
  original.close();rmSync(join(dir,'external'));
  const recovered=new ManagedDriver(join(dir,'driver'),manifest);
  try{assert.throws(()=>new WorkloadGuard(recovered,join(dir,'external'),'unused'),{code:'WORKLOAD_JOURNAL_REPLACED'});}finally{recovered.close();rmSync(dir,{recursive:true,force:true});}
});

test('a version-2 managed driver upgrades with its identity and held generation preserved',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'accord-workload-upgrade-'));
  const manifest={schema:1,id:'resource',asset:'fixture',plugin:'managed-http',endpoint:'http://127.0.0.1:1',tokenFile:join(dir,'token')};
  let driver=new ManagedDriver(join(dir,'driver'),manifest);const identity=driver.status().instance;
  // Reproduce the previously shipped schema, retaining its actual checksums.
  driver.db.exec("DROP TABLE external_workload_journal; DELETE FROM migrations WHERE version=3; UPDATE state SET authority='old-authority',epoch=4,generation=7,claim_id='old-claim',phase='active',token_hash='old-token'");driver.close();
  driver=new ManagedDriver(join(dir,'driver'),manifest);
  const guard=new WorkloadGuard(driver,join(dir,'external'),'unused');
  try{assert.equal(guard.status().instance,identity);assert.equal(guard.status().claim_id,'old-claim');assert.equal(guard.status().generation,7);assert.equal(guard.status().phase,'recovering');assert.equal(driver.db.prepare('SELECT token_hash FROM state').get().token_hash,null);assert.equal(driver.db.prepare('SELECT max(version) AS version FROM migrations').get().version,3);}finally{guard.close();rmSync(dir,{recursive:true,force:true});}
});
