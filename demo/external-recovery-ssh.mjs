// SPDX-License-Identifier: MIT
// Explicit opt-in, CPU-only proof on two SSH hosts. Never touches installed leases.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { harness, eventually, stop, delay } from '../test/helpers.mjs';
import { createHttp, listen, readBody, hash, request } from '../src/common.mjs';
const exec=promisify(execFile),argv=process.argv.slice(2),option=k=>argv[argv.indexOf(k)+1];
assert(argv.includes('--hosts')&&argv.includes('--image'),'Use --hosts SSH_A,SSH_B --image ALREADY_CACHED_IMAGE --output FILE');
const hosts=option('--hosts').split(',');assert.equal(hosts.length,2);assert(hosts.every(h=>/^[a-zA-Z0-9][a-zA-Z0-9_.@-]+$/.test(h)));
const image=option('--image'),output=resolve(argv.includes('--output')?option('--output'):'/tmp/accord-external-proof.json');
const nonce=randomUUID(),remote='/tmp/accord-external-'+nonce,node=argv.includes('--node')?option('--node'):'/usr/bin/node';
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const ssh=async(host,args)=> (await exec('/usr/bin/ssh',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=5',host,args.map(quote).join(' ')],{timeout:30000,maxBuffer:1048576})).stdout.trim();
// Files are supplied as base64 argv; no shell interpolation of file contents.
const put=async(host,file,text)=>ssh(host,['python3','-c','import pathlib,sys,base64; p=pathlib.Path(sys.argv[1]);p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(base64.b64decode(sys.argv[2]))',file,Buffer.from(text).toString('base64')]);
let h,provider,unit,unitPath;const containers=[];let unitHostReady=false;
const trace=[];
try {
  // Inspect cached images first: never download an image or alter model residency.
  for(const host of hosts){await ssh(host,['docker','image','inspect',image,'--format','{{.Id}}']);await ssh(host,[node,'--version']);
    for(const file of ['workload-host.mjs','common.mjs'])await put(host,remote+'/'+file,readFileSync(new URL('../src/'+file,import.meta.url),'utf8'));
  }
  h=await harness();
  provider=createHttp(async(req,res,url)=>{const body=await readBody(req),action=url.pathname.slice(1);
    if(action==='restore'){
      for(let i=0;i<containers.length;i++)assert.equal(await ssh(hosts[i],['docker','inspect','--format','{{.State.Running}}',containers[i]]),'false');
      if(unit)assert.equal(await ssh(hosts[0],['systemctl','--user','show',unit,'--property=ActiveState','--value']),'inactive');
      trace.push({kind:'restored',generation:body.generation,at:Date.now()});
    }
    return {...body,[action]:true};
  });const endpoint=await listen(provider),tokenFile=join(h.data,'provider.token');writeFileSync(tokenFile,'fixture-only');
  await h.client('admin').registerResource({schema:1,id:'external-proof',asset:'cpu-fixture:'+nonce,plugin:'managed-http',endpoint,tokenFile});
  writeFileSync(join(h.data,'workload-policy.json'),JSON.stringify({schema:1,hosts:Object.fromEntries(hosts.map((host,i)=>['host'+i,{transport:'ssh',host,node,helper:remote+'/workload-host.mjs'}])),resources:{'external-proof':{hosts:['host0','host1'],plugins:['docker-container','systemd-user-unit']}}}));
  const a=h.client('agent-a'),b=h.client('agent-b'),ra=await a.reserve('external-proof',{leaseMs:120000});await eventually(async()=>(await a.reservation(ra.id)).state==='running');const grant=await a.reservation(ra.id);
  for(let i=0;i<hosts.length;i++)containers.push(await ssh(hosts[i],['docker','create','--name','accord-proof-'+nonce,'--runtime','runc','--network','none','--cpus','0.1','--memory','64m','--pids-limit','32','--cap-drop','ALL','--security-opt','no-new-privileges','--env','NVIDIA_VISIBLE_DEVICES=void','--label','accord.authority='+grant.authority,'--label','accord.claim='+grant.claimId,'--label','accord.generation='+grant.generation,'--entrypoint','/bin/sh',image,'-c','while :; do sleep 1; done']));
  assert(containers.every(c=>/^[a-f0-9]{64}$/.test(c)));
  unit='accord-'+hash(grant.authority+'/'+grant.claimId+'/'+grant.generation).slice(0,20)+'-supervisor.service';
  const home=await ssh(hosts[0],['python3','-c','import pathlib;print(pathlib.Path.home())']);unitPath=home+'/.config/systemd/user/'+unit;
  await put(hosts[0],remote+'/supervisor.py','import subprocess,time\nwhile True:\n subprocess.run(["/usr/bin/docker","start","'+containers[0]+'"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\n time.sleep(.2)\n');
  await put(hosts[0],unitPath,'[Unit]\nDescription=Disposable Accord recovery proof\n[Service]\nType=simple\nExecStart=/usr/bin/python3 '+remote+'/supervisor.py\nKillMode=control-group\nRestart=no\nTimeoutStopSec=5\n');
  await ssh(hosts[0],['systemctl','--user','daemon-reload']);unitHostReady=true;
  const targets=containers.map((id,i)=>({host:'host'+i,plugin:'docker-container',id}));targets.push({host:'host0',plugin:'systemd-user-unit',id:unit});
  const registrations=await a.collaborate('workload-register',{id:ra.id,key:'register',targets});
  for(const w of registrations.workloads)await a.collaborate('workload-launch',{id:ra.id,key:'launch-'+w.id,workload:w.id});
  for(let i=0;i<containers.length;i++)assert.equal(await ssh(hosts[i],['docker','inspect','--format','{{.State.Running}}',containers[i]]),'true');
  assert.equal(await ssh(hosts[0],['systemctl','--user','show',unit,'--property=ActiveState','--value']),'active');
  const rb=await b.reserve('external-proof',{leaseMs:120000});assert.notEqual((await b.reservation(rb.id)).state,'running');
  // Only this proof's helper disappears. Production SSH and Accord stay online.
  await ssh(hosts[1],['mv',remote+'/workload-host.mjs',remote+'/workload-host.offline']);
  const port=Number(new URL(h.url).port),driverPort=Number(new URL(h.driverUrl).port);
  await stop(h.server,'SIGKILL');await stop(h.driver,'SIGKILL');await delay(h.leaderMs+50);await h.startDriver(driverPort);await h.startServer(port);
  await eventually(async()=>await ssh(hosts[0],['systemctl','--user','show',unit,'--property=ActiveState','--value'])==='inactive',15000);
  assert.equal(await ssh(hosts[1],['docker','inspect','--format','{{.State.Running}}',containers[1]]),'true');
  assert.notEqual((await b.reservation(rb.id)).state,'running');assert.equal(trace.length,0);
  trace.push({kind:'unreachable-host-blocked-regrant',at:Date.now()});
  await ssh(hosts[1],['mv',remote+'/workload-host.offline',remote+'/workload-host.mjs']);
  await eventually(async()=>(await b.reservation(rb.id)).state==='running',30000);
  for(let i=0;i<containers.length;i++)assert.equal(await ssh(hosts[i],['docker','inspect','--format','{{.State.Running}}',containers[i]]),'false');
  await assert.rejects(a.collaborate('workload-launch',{id:ra.id,key:'stale',workload:registrations.workloads[0].id}));
  const events=(await request(h.driverUrl,h.credential('driver-control'),'/control/workloads/audit?resource=external-proof')).events;
  const audit=(await request(h.driverUrl,h.credential('driver-control'),'/control/audit?resource=external-proof')).events;
  const next=audit.find(e=>e.kind==='grant.active'&&e.generation===2);assert(next);
  const stopped=events.filter(e=>e.claim===grant.claimId&&e.kind==='workload.stopped');assert.equal(new Set(stopped.map(e=>e.binding)).size,3);assert(stopped.every(e=>e.at<=next.at));
  assert(trace.some(e=>e.kind==='restored'&&e.generation===1&&e.at<=next.at));
  await b.release(rb.id);await eventually(async()=>(await b.reservation(rb.id)).state==='released',15000);
  const evidence={status:'passed',at:new Date().toISOString(),kind:'two-agent two-SSH-host external workload recovery',cpuOnly:true,registeredContainers:2,registeredSupervisors:1,assertions:['Both real Docker containers running before failure','Coordinator and driver killed with SIGKILL','Unreachable workload host kept next agent queued','Supervisor stopped before container cleanup','Both immutable container identities stopped before restore and next grant','Stale owner launch rejected','No installed reservation or model route modified'],sourceHashes:Object.fromEntries(['workload-host.mjs','workload-guard.mjs','workload-transport.mjs'].map(f=>[f,hash(readFileSync(new URL('../src/'+f,import.meta.url),'utf8'))])),trace,externalAudit:events,driverAudit:audit};
  mkdirSync(resolve(output,'..'),{recursive:true});writeFileSync(output,JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({status:evidence.status,output,assertions:evidence.assertions}));
} finally {
  // Only exact, freshly created fixture identities may be stopped or removed.
  if(unitHostReady)await ssh(hosts[0],['systemctl','--user','stop',unit]).catch(()=>{});
  for(let i=0;i<containers.length;i++)await ssh(hosts[i],['docker','rm','--force',containers[i]]).catch(()=>{});
  if(unitPath){await ssh(hosts[0],['rm','-f',unitPath]).catch(()=>{});await ssh(hosts[0],['systemctl','--user','daemon-reload']).catch(()=>{});}
  for(const host of hosts)await ssh(host,['rm','-rf',remote]).catch(()=>{});
  if(h)await h.close();if(provider)await new Promise(r=>provider.close(r));
}
