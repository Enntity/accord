// SPDX-License-Identifier: MIT
// Explicit live read-only probes; never run by npm test. Temporary services only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { harness,eventually,stop,delay } from '../test/helpers.mjs';
import { install } from '../src/installer.mjs';
import { connectHost } from '../src/connect.mjs';
const argv=process.argv.slice(2),opt=n=>argv[argv.indexOf('--'+n)+1];
const counts=data=>{const db=new DatabaseSync(join(data,'coordinator.sqlite'),{readOnly:true});try{return Object.fromEntries(['events','commands','actors','participants','claims','reservations'].map(t=>[t,db.prepare(`SELECT count(*) n FROM ${t}`).get().n]));}finally{db.close();}};
assert(argv.includes('--confirm-live'),'Explicit live probe consent flag required');
if(argv.includes('--worker')){
  const data=opt('data');assert(/^\/tmp\/accord-telemetry\.[a-zA-Z0-9]+\/data$/.test(data));
  const h=await harness({dir:data}),send=value=>process.stdout.write(JSON.stringify(value)+'\n');
  try{
    send({ready:true,data,authority:(await h.client('admin').host()).authority});
    for await(const line of createInterface({input:process.stdin})){
      const {id,action}=JSON.parse(line);
      try{let result;
        if(action==='counts')result=counts(data);
        else if(action==='telemetry')result=await h.client('admin').telemetry();
        else if(action==='stop'){await stop(h.server);result={stopped:true};}
        else if(action==='restart'){const port=Number(new URL(h.url).port);await stop(h.server);await h.startServer(port);result={restarted:true};}
        else throw Error('Unknown operation');
        send({id,result});
      }catch(e){send({id,error:e.message});}
    }
  }finally{await h.close(false);rmSync(data,{recursive:true,force:true});}
}else{
  const host=opt('host'),remoteRoot=opt('remote-root'),remoteNode=opt('remote-node');
  assert(/^[a-zA-Z0-9.-]+$/.test(host));assert(/^\/tmp\/accord-telemetry\.[a-zA-Z0-9]+$/.test(remoteRoot));assert(/^\/[a-zA-Z0-9/._-]+$/.test(remoteNode));
  const ssh=spawn('ssh',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',host,`${remoteNode} ${remoteRoot}/scripts/qualify-telemetry.mjs --worker --confirm-live --data ${remoteRoot}/data`],{stdio:['pipe','pipe','pipe']});
  let ready,stderr='';const pending=new Map();ssh.stderr.on('data',d=>stderr=(stderr+d).slice(-2000));
  const lines=createInterface({input:ssh.stdout});lines.on('line',line=>{const m=JSON.parse(line);if(m.ready)ready=m;else{const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(m.error)):p.resolve(m.result);}}});
  const remote=action=>new Promise((resolve,reject)=>{const id=randomUUID(),timer=setTimeout(()=>{pending.delete(id);reject(Error('SSH probe timed out'));},10000);pending.set(id,{resolve,reject,timer});ssh.stdin.write(JSON.stringify({id,action})+'\n');});
  const h=await harness(),root=mkdtempSync(join(tmpdir(),'accord-telemetry-local-')),home=join(root,'home');let connected=false;
  const connection={host,home,data:h.data,remoteCli:remoteRoot+'/src/cli.mjs',remoteNode,remoteData:remoteRoot+'/data'};
  try{
    await eventually(()=>{assert.equal(ssh.exitCode,null,stderr);return ready;},15000);
    install({home,data:h.data,clients:[]});await connectHost(connection);connected=true;
    const client=h.client('agent-a'),beforeLocal=counts(h.data),beforeRemote=await remote('counts');
    const responses=await Promise.all(Array.from({length:12},()=>client.telemetry(ready.authority)));
    assert(responses.every(r=>r.authority===ready.authority&&r.sampledAt===responses[0].sampledAt&&!r.stale));
    assert(responses[0].host.gpu?.devices.some(d=>d.vendor==='nvidia'));
    const direct=await remote('telemetry');assert.equal(direct.sampledAt,responses[0].sampledAt);
    const metadata=await client.metadata(ready.authority);assert.equal(metadata.machine.platform,'linux');
    const mac=await client.telemetry();assert(mac.host.gpu?.devices.some(d=>d.vendor==='apple'));assert(Number.isFinite(mac.host.thermal.hottestC));
    const macMetadata=await client.metadata();
    await delay(2200);const second=await client.telemetry(ready.authority);assert(second.sampledAt>direct.sampledAt);assert(Number.isFinite(second.host.cpu.utilization));
    assert.deepEqual(counts(h.data),beforeLocal);assert.deepEqual(await remote('counts'),beforeRemote);
    await remote('restart');const recovered=await client.telemetry(ready.authority);assert.equal(recovered.authority,ready.authority);assert(recovered.sampledAt>second.sampledAt);assert.equal(recovered.host.cpu.utilization,null);
    await remote('stop');await assert.rejects(client.telemetry(ready.authority));
    const report={status:'passed',at:new Date().toISOString(),host,node:process.version,assertions:{directAndForwardedSampleIdentical:true,concurrentReadsShareSample:true,noCoordinationWrites:true,newSampleAfterTTL:true,cpuDeltaAfterWarmup:true,cacheClearedOnRestart:true,unreachableHostRejects:true,installedRemoteServiceUntouched:true},samples:{mac,macMetadata,spark:second,sparkMetadata:metadata},limits:['Only the recorded Apple and NVIDIA hosts were read live; AMD sysfs is fixture-tested.','Read-only probes; no GPU workloads, reservations, model changes or product cutover.']};
    mkdirSync('evidence/telemetry',{recursive:true});writeFileSync('evidence/telemetry/ssh.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:'passed',assertions:report.assertions,proof:'evidence/telemetry/ssh.json'}));
  }finally{
    if(connected)await connectHost({...connection,disconnect:true}).catch(()=>{});
    ssh.stdin.end();await eventually(()=>ssh.exitCode!==null||ssh.signalCode!==null,6000).catch(()=>{});await stop(ssh);await h.close();rmSync(root,{recursive:true,force:true});
  }
}
