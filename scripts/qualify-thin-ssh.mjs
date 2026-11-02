// SPDX-License-Identifier: MIT
// Two real machines, isolated state. Model harness qualification is a separate opt-in stage.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { harness,eventually,stop,delay } from '../test/helpers.mjs';
import { install } from '../src/installer.mjs';
import { enrollProfile } from '../src/bootstrap.mjs';
import { runModelLoop } from './model-loop.mjs';
import { hash } from '../src/common.mjs';
import { connectHost } from '../src/connect.mjs';
const argv=process.argv.slice(2),opt=n=>argv[argv.indexOf('--'+n)+1];
assert(argv.includes('--confirm-live'));
const remoteRoot=opt('remote-root'),host=opt('host'),remoteNode=opt('remote-node');
assert(/^\/tmp\/accord-thin\.[a-zA-Z0-9]+$/.test(remoteRoot));assert(/^[a-zA-Z0-9.-]+$/.test(host));assert(/^\/[a-zA-Z0-9/._-]+$/.test(remoteNode));
const ssh=spawn('ssh',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',host,`${remoteNode} ${remoteRoot}/scripts/thin-host-control.mjs ${remoteRoot}/data-${randomUUID()}`],{stdio:['pipe','pipe','pipe']});
let buffer='',stderr='',ready;const pending=new Map();
ssh.stdout.on('data',chunk=>{buffer+=chunk;let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);const m=JSON.parse(line);if(m.ready)ready=m;else if(pending.has(m.id)){const {resolve,reject,timer}=pending.get(m.id);clearTimeout(timer);pending.delete(m.id);m.error?reject(Error(m.error)):resolve(m.result);}}});
ssh.stderr.on('data',d=>stderr=(stderr+d).slice(-2000));
const remote=(action,args={})=>new Promise((resolve,reject)=>{const id=randomUUID(),timer=setTimeout(()=>{pending.delete(id);reject(Error('Remote operation timed out'));},20000);pending.set(id,{resolve,reject,timer});ssh.stdin.write(JSON.stringify({id,action,...args})+'\n');});
const root=mkdtempSync(join(tmpdir(),'accord-thin-local-')),home=join(root,'home'),h=await harness();
const observations=[];const record=(event,details={})=>{observations.push({event,at:new Date().toISOString(),...details});console.log(JSON.stringify(observations.at(-1)));};
let connected=false,ca,cb,run;
try{
  await eventually(()=>{if(ssh.exitCode!==null)throw Error(stderr);return ready;},15000);
  const installed=install({home,data:h.data,clients:[]});
  const connection=await connectHost({host,home,data:h.data,remoteCli:remoteRoot+'/src/cli.mjs',remoteNode,remoteData:ready.data});connected=true;
  record('ssh-connected',connection);
  ca=await enrollProfile(installed.profile,{label:'fresh Mac agent',harness:'generic-cli'});
  cb=await enrollProfile(installed.profile,{label:'incoming CLI agent',harness:'generic-cli'});
  await ca.bootstrap();await cb.bootstrap();
  await ca.announce({label:'fresh Mac agent',activity:'SSH recovery qualification',capabilities:['review']});
  const found=await ca.find();assert(found.hosts.some(x=>x.authority===ready.authority&&x.status==='observed'));record('linked-host-discovered');
  // Enroll a remote actor using that host's installed CLI, preserving credentials on the remote host.
  const execRemote=async args=>{
    const command=[remoteNode,remoteRoot+'/src/cli.mjs',...args].map(s=>"'"+s.replaceAll("'","'\\''")+"'").join(' ');
    const p=spawn('ssh',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',host,command],{stdio:['ignore','pipe','pipe']});let out='';p.stdout.on('data',d=>out+=d);p.stderr.resume();
    const status=await new Promise(r=>p.once('exit',r));assert.equal(status,0);return JSON.parse(out);
  };
  const opts=['--home',join(ready.data,'home')];
  const opened=await execRemote(['session','open','--label','fresh Linux agent',...opts]);
  await execRemote(['announce','--label','fresh Linux agent','--activity','resource manager qualification','--capabilities','manage',...opts]);
  assert((await ca.find('fresh Linux')).participants.some(p=>p.address===opened.address));
  const m=await ca.send(opened.address,'request over SSH',{key:'ssh-message'});
  const incoming=await eventually(async()=>{const x=await execRemote(['inbox',...opts]);return x.messages.find(x=>x.id===m.id);});
  await execRemote(['send','--to',incoming.from,'--text','reply over SSH',...opts]);
  await execRemote(['read','--id',incoming.deliveryId,...opts]);
  await eventually(async()=>(await ca.inbox()).messages.some(m=>m.text==='reply over SSH'));record('bidirectional-cli-messaging');
  if(argv.includes('--models')){
    const remoteSession=join(root,'remote-session.json');
    const copy=spawn('scp',['-q','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',host+':'+join(ready.data,'home/.config/accord/shell-session.json'),remoteSession],{stdio:'inherit'});
    assert.equal(await new Promise(r=>copy.once('exit',r)),0);
    const session=JSON.parse(readFileSync(remoteSession));
    const link=JSON.parse(readFileSync(join(home,'.config/accord/links',hash(host).slice(0,16)+'.json')));
    session.url=`http://127.0.0.1:${link.localPort}`;writeFileSync(remoteSession,JSON.stringify(session),{mode:0o600});
    mkdirSync('evidence/thin',{recursive:true});
    const models=await runModelLoop({root,profile:installed.profile,remoteSession,observer:ca,authority:ready.authority});
    const proof=spawn('ssh',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',host,`${remoteNode} ${remoteRoot}/scripts/inspect-thin-model-proof.mjs ${remoteRoot} ${ready.authority} ${models.tag}`],{stdio:['ignore','pipe','inherit']});
    let proofText='';proof.stdout.on('data',d=>proofText+=d);assert.equal(await new Promise(r=>proof.once('exit',r)),0);
    const verified=JSON.parse(proofText);assert.equal(verified.status,'passed');
    writeFileSync('evidence/thin/model-state.json',JSON.stringify(verified,null,2)+'\n');
    record('real-model-loop',{status:models.status,persistedStateVerified:true});
  }
  const r=await ca.reserve(`${ready.authority}/qualify-slot`,{leaseMs:3000,key:'old-owner'});
  await eventually(async()=>(await ca.reservation(r.id,ready.authority)).state==='running');
  run=await ca.collaborate('start',{id:r.id,key:'start'},ready.authority);assert((await remote('group',{pgid:run.pgid})).exists);
  const next=await cb.reserve(`${ready.authority}/qualify-slot`,{leaseMs:10000,key:'next-owner'});
  await remote('kill-driver');await delay(3400);
  assert.equal((await cb.reservation(next.id,ready.authority)).state,'queued');assert((await remote('group',{pgid:run.pgid})).exists);
  record('expired-owner-held-with-live-workload',{reservation:r.id,pgid:run.pgid});
  await remote('start-driver');await eventually(async()=>(await cb.reservation(next.id,ready.authority)).state==='running');
  assert.equal((await remote('group',{pgid:run.pgid})).exists,false);
  await assert.rejects(ca.collaborate('start',{id:r.id,key:'late'},ready.authority),{code:'STALE_CLAIM'});
  await cb.release(next.id,{host:ready.authority});await eventually(async()=>(await cb.reservation(next.id,ready.authority)).state==='released');
  record('stopped-before-new-grant');
  await remote('restart-server');assert((await ca.find()).hosts.some(h=>h.authority===ready.authority&&h.status==='observed'));
  const audit=await remote('audit');let owner=null;for(const e of audit.events){if(e.kind==='grant.active'){assert.equal(owner,null);owner=e.claim_id;}if(e.kind==='grant.revoked')owner=null;}assert.equal(owner,null);
  await execRemote(['session','close',...opts]);
  const report={status:'passed',at:new Date().toISOString(),host,observations,assertions:{freshInstalledCLI:true,bidirectionalDiscovery:true,bidirectionalMessages:true,expiredOwnerHeld:true,oldGroupAbsentBeforeNextGrant:true,staleStartRejected:true,overlappingGrants:0,restartDiscovery:true},driverAudit:audit.events,limits:['Deterministic CLI agents on real Mac and Linux hosts; model-driven agents are qualified separately.','CPU-only POSIX group workload. No GPU or LLooM authority changes.']};
  mkdirSync('evidence/thin',{recursive:true});writeFileSync('evidence/thin/ssh.json',JSON.stringify(report,null,2)+'\n');record('proof-saved',{path:'evidence/thin/ssh.json'});
}finally{
  if(ca)await ca.closeSession().catch(()=>{});if(cb)await cb.closeSession().catch(()=>{});
  if(connected)await connectHost({host,home,data:h.data,remoteCli:remoteRoot+'/src/cli.mjs',remoteNode,remoteData:ready.data,disconnect:true}).catch(()=>{});
  ssh.stdin.end();await eventually(()=>ssh.exitCode!==null||ssh.signalCode!==null,6000).catch(()=>{});await stop(ssh);await h.close();rmSync(root,{recursive:true,force:true});
}
