import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { harness,eventually,stop,delay } from './helpers.mjs';
import { createHttp,listen,readBody,requireThat,request } from '../src/common.mjs';
import { ManagedDriver } from '../src/managed-driver.mjs';

test('managed provider: actual old process stops and restoration succeeds before a second agent receives ownership, including crash recovery', {timeout:30000},async t=>{
  const h=await harness();t.after(()=>h.close());
  let child=null,blockStop=false,blockRestore=false,starts=0;const log=[];
  const provider=createHttp(async(req,res,url)=>{
    assert.equal(req.headers.authorization,'Bearer provider-test');const b=await readBody(req),action=url.pathname.slice(1);
    if(action==='start'){
      if(!child){child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});starts++;await once(child,'spawn');}
    }
    if(action==='stop'){
      if(blockStop)throw Error('Workload stop unknown');
      if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await once(child,'exit');log.push('stopped');}
      child=null;
    }
    if(action==='restore'&&blockRestore)throw Error('Restore health failed');
    log.push(action+':'+b.generation);return {...b,[action]:true};
  });
  const endpoint=await listen(provider);t.after(async()=>{if(child)await stop(child);await new Promise(r=>provider.close(r));});
  const tokenFile=join(h.data,'provider.token');writeFileSync(tokenFile,'provider-test',{mode:0o600});
  await h.client('admin').registerResource({schema:1,id:'models',asset:'fixture:models',plugin:'managed-http',endpoint,tokenFile});
  const a=h.client('agent-a'),b=h.client('agent-b');const ra=await a.reserve('models',{leaseMs:10000});
  await eventually(async()=>(await a.reservation(ra.id)).state==='running');
  await a.collaborate('start',{id:ra.id,key:'start'});assert.equal(starts,1);
  const rb=await b.reserve('models',{leaseMs:10000});
  blockStop=true;const port=Number(new URL(h.url).port);await stop(h.server,'SIGKILL');await delay(h.leaderMs+50);await h.startServer(port);
  await delay(500);assert.notEqual((await b.reservation(rb.id)).state,'running');assert(child&&child.exitCode===null);
  blockStop=false;blockRestore=true;await eventually(()=>log.includes('stopped'));
  assert.notEqual((await b.reservation(rb.id)).state,'running');
  blockRestore=false;await eventually(async()=>(await b.reservation(rb.id)).state==='running');
  const prepare2=log.findIndex(x=>/^prepare:2$/.test(x));assert(prepare2>log.indexOf('stopped'));assert(prepare2>log.indexOf('restore:1'));
  assert.equal(starts,1);await assert.rejects(a.collaborate('start',{id:ra.id,key:'again'}));
  await b.release(rb.id);await eventually(async()=>(await b.reservation(rb.id)).state==='released');
});

test('managed provider declares its own maximum ownership and can change it without re-registering the asset',async t=>{
  const h=await harness();t.after(()=>h.close());
  const tokenFile=join(h.data,'provider.token');writeFileSync(tokenFile,'provider-test',{mode:0o600});
  const admin=h.client('admin'),manifest={schema:1,id:'pair',asset:'fixture:pair',plugin:'managed-http',endpoint:'http://127.0.0.1:9/pair',tokenFile};
  const limit=async()=>(await admin.resources()).resources.find(r=>r.localId==='pair').maxOwnershipMs;
  const first=await admin.registerResource({...manifest,maxOwnershipMs:43200000});
  assert.equal(first.maxOwnershipMs,43200000);assert.equal(await limit(),43200000);
  const second=await admin.registerResource({...manifest,maxOwnershipMs:43200000,allowIndefinite:true});
  assert.equal(second.instance,first.instance);assert.equal(second.allowIndefinite,true);assert.equal(await limit(),null,'an indefinite resource has no maximum');
  await admin.registerResource(manifest);assert.equal(await limit(),28800000,'a resource that declares nothing keeps the eight-hour default');
  await assert.rejects(admin.registerResource({...manifest,endpoint:'http://127.0.0.1:9/other',maxOwnershipMs:43200000}),{code:'RESOURCE_CONFLICT'});
  await assert.rejects(admin.registerResource({...manifest,maxOwnershipMs:1000}),{code:'INVALID_INPUT'});
  await assert.rejects(admin.registerResource({...manifest,allowIndefinite:'yes'}),{code:'RESOURCE_MANIFEST'});
});

test('a window on a managed resource survives a crash of the whole host without stopping or restoring the provider',{timeout:30000},async t=>{
  const h=await harness();t.after(()=>h.close());const log=[];
  const provider=createHttp(async(req,res,url)=>{
    const b=await readBody(req),action=url.pathname.slice(1);
    if(action==='availability')return {available:true};
    log.push(action+':'+b.generation);return {...b,[action]:true};
  });
  const endpoint=await listen(provider);t.after(()=>new Promise(r=>provider.close(r)));
  const tokenFile=join(h.data,'provider.token');writeFileSync(tokenFile,'provider-test',{mode:0o600});
  await h.client('admin').registerResource({schema:1,id:'pair',asset:'fixture:pair',plugin:'managed-http',endpoint,tokenFile});
  const a=h.client('agent-a'),b=h.client('agent-b'),r=await a.reserve('pair',{durationMs:3600000});
  const before=await eventually(async()=>{const s=await a.reservation(r.id);return s.state==='running'&&s;});
  await a.collaborate('start',{id:r.id,key:'start'});
  const next=await b.reserve('pair',{durationMs:60000});
  // The kernel OOM killer takes the service; the supervisor restarts coordinator and driver together.
  const serverPort=Number(new URL(h.url).port),driverPort=Number(new URL(h.driverUrl).port);
  await stop(h.server,'SIGKILL');await stop(h.driver,'SIGKILL');await delay(h.leaderMs+50);
  await h.startDriver(driverPort);await h.startServer(serverPort);
  const after=await eventually(async()=>{const s=await a.reservation(r.id);return s.state==='running'&&s;});
  assert.equal(after.claimId,before.claimId);assert.equal(after.generation,before.generation);assert.equal(after.deadline,before.deadline);
  assert.equal((await b.reservation(next.id)).state,'queued');
  assert.deepEqual(log,['prepare:1','start:1','prepare:1'],'the provider reconfirms the same generation and is never stopped or restored');
  assert.equal((await a.collaborate('start',{id:r.id,key:'start'})).start,true,'the holder keeps using the same grant');
  await a.release(r.id);await eventually(async()=>(await b.reservation(next.id)).state==='running');
  assert(log.indexOf('restore:1')<log.indexOf('prepare:2'));
});

test('a restarted managed driver resumes only a grant its provider had confirmed',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'accord-managed-resume-')),file=join(dir,'driver.sqlite'),tokenFile=join(dir,'provider.token');
  t.after(()=>rmSync(dir,{recursive:true,force:true}));writeFileSync(tokenFile,'fixture');
  const manifest={schema:1,id:'pair',asset:'fixture:pair',plugin:'managed-http',endpoint:'http://127.0.0.1:9',tokenFile},credentialHash='a'.repeat(64);
  const crash=phase=>{const d=new ManagedDriver(file,manifest);
    d.db.prepare("UPDATE state SET authority='host',epoch=1,generation=1,claim_id='claim',token_hash=?,phase=?").run(credentialHash,phase);d.close();
    return new ManagedDriver(file,manifest);};
  const resume=d=>d.activate({instance:d.status().instance,authority:'host',epoch:2,generation:1,claimId:'claim',credentialHash});
  const interrupted=crash('preparing');assert.equal(interrupted.status().phase,'interrupted');
  await assert.rejects(resume(interrupted),{code:'REVOKED'});interrupted.close();
  const confirmed=crash('active');assert.equal(confirmed.status().phase,'recovering');
  await assert.rejects(resume(confirmed),e=>e.code!=='REVOKED','a confirmed grant goes back to its provider');
  assert.equal(confirmed.status().phase,'preparing');assert.equal(confirmed.status().epoch,2);confirmed.close();
});

test('a resource its provider withdraws leaves once idle, and registering it again never reuses a generation',{timeout:30000},async t=>{
  const h=await harness();t.after(()=>h.close());let offered=true;
  const provider=createHttp(async(req,res,url)=>{
    const b=await readBody(req),action=url.pathname.slice(1);
    if(action==='availability'){requireThat(offered,'resource_unknown','Not offered',404);return {available:true};}
    return {...b,[action]:true};
  });
  const endpoint=await listen(provider);t.after(()=>new Promise(r=>provider.close(r)));
  const tokenFile=join(h.data,'provider.token');writeFileSync(tokenFile,'provider-test',{mode:0o600});
  const admin=h.client('admin'),a=h.client('agent-a'),manifest={schema:1,id:'old',asset:'fixture:old',plugin:'managed-http',endpoint,tokenFile};
  await admin.registerResource(manifest,'register-old');
  // A provider that cannot be reached says nothing about what it offers.
  await admin.registerResource({...manifest,id:'offline',asset:'fixture:offline',endpoint:'http://127.0.0.1:9/offline'});
  const ids=async()=>(await admin.resources()).resources.map(r=>r.localId);
  const driverIds=async()=>(await request(h.driverUrl,h.credential('driver-control').trim(),'/control/resources')).resources.map(r=>r.id);
  const restart=async()=>{const port=Number(new URL(h.url).port);await stop(h.server);await h.startServer(port);};
  const r=await a.reserve('old',{durationMs:600000});
  const held=await eventually(async()=>{const s=await a.reservation(r.id);return s.state==='running'&&s;});
  // Wait past the first pass; a slow runner may still be settling, so retry the read.
  offered=false;await restart();await delay(1500);
  assert((await eventually(ids)).includes('old'),'a held resource stays');
  await eventually(async()=>(await a.reservation(r.id)).state==='running');
  await a.release(r.id);await eventually(async()=>(await a.reservation(r.id)).state==='released');
  await restart();
  await eventually(async()=>!(await ids()).includes('old'));
  await eventually(async()=>!(await driverIds()).includes('old'));
  assert(!existsSync(join(h.data,'process-old.sqlite')),'its driver files go too');
  assert((await ids()).includes('offline'));assert((await driverIds()).includes('offline'));
  await assert.rejects(a.reserve('old',{durationMs:60000}),{code:'RESOURCE_UNKNOWN'});
  offered=true;await admin.registerResource(manifest,'register-old');
  assert((await ids()).includes('old'),'the same registration command works again');
  const again=await a.reserve('old',{durationMs:60000});
  const next=await eventually(async()=>{const s=await a.reservation(again.id);return s.state==='running'&&s;});
  assert(next.generation>held.generation,'fencing continues above every generation the old resource issued');
  await a.release(again.id);
});
