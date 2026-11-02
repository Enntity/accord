// SPDX-License-Identifier: MIT
// Opt-in macOS-to-Linux installed-service qualification. Never run by npm test.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hash } from '../src/common.mjs';
import { enrollProfile, profileAt, discover } from '../src/bootstrap.mjs';
const execute=promisify(execFile),args=process.argv.slice(2);
const option=n=>args[args.indexOf(`--${n}`)+1];
assert(args.includes('--confirm-live')&&process.platform==='darwin','Explicit live opt-in on macOS required');
for(const n of ['host','profile','remote-control','remote-node','tunnel-label'])assert(args.includes(`--${n}`),`Missing ${n}`);
const host=option('host'),profile=profileAt(option('profile')),label=option('tunnel-label');
const control=option('remote-control'),node=option('remote-node');
assert(/^[a-zA-Z0-9_.-]+$/.test(host)&&/^org\.enntity\.accord\.ssh-[a-zA-Z0-9_-]+$/.test(label));
assert(/^\/[a-zA-Z0-9_./-]+$/.test(control+node));
const domain=`gui/${process.getuid()}`,plist=join(homedir(),'Library/LaunchAgents',`${label}.plist`);
const ssh=command=>execute('ssh',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',host,command],{timeout:15000});
async function operator(input){
  // execFile's callback form has no stdin option; use its child handle without shell interpolation.
  let child;const result=new Promise((resolve,reject)=>{child=execFile('ssh',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',host,`${node} ${control}`],{timeout:15000},(e,stdout)=>e?reject(e):resolve(JSON.parse(stdout)));});
  child.stdin.end(JSON.stringify({...input,authority:profile.authority}));return result;
}
const board=()=>operator({action:'admin',path:'/v1/board'});
async function until(fn){const deadline=Date.now()+30000;while(Date.now()<deadline){try{const result=await fn();if(result)return result;}catch{}await new Promise(r=>setTimeout(r,250));}throw Error('Service recovery timed out');}
const client=await enrollProfile(join(homedir(),'.config/accord/connection.json'),{label:'service qualification',harness:'test-controller'});
let tunnelStopped=false;
try{
  const before=await discover(profile),original=await board();
  assert.equal(before.resource.state,'unclaimed');
  assert(original.tasks.every(t=>['succeeded','cancelled','failed'].includes(t.state)),'Unfinished remote work');
  const completed=original.tasks.filter(t=>t.state==='succeeded');assert(completed.length,'No accepted result to check');
  const findPeer=network=>network.hosts.find(h=>h.authority===profile.authority);
  assert.equal(findPeer(await client.network()).status,'observed');
  await execute('launchctl',['bootout',`${domain}/${label}`]);tunnelStopped=true;
  const missing=await until(async()=>{const peer=findPeer(await client.network());return peer?.status==='unknown'&&peer;});
  await execute('launchctl',['bootstrap',domain,plist]);tunnelStopped=false;
  const restored=await until(async()=>{const peer=findPeer(await client.network());return peer?.status==='observed'&&peer;});
  assert.equal(restored.host.authority,before.authority);
  await ssh('systemctl --user restart accord.service');
  const after=await until(async()=>{const h=await discover(profile);return h.epoch>before.epoch&&h.resource.state==='unclaimed'&&h;});
  const persisted=await board();
  for(const task of completed){
    const next=persisted.tasks.find(t=>t.id===task.id);assert.equal(next.state,'succeeded');assert.equal(next.result,task.result);
    const receipt=JSON.parse(task.result),artifact=await operator({action:'driver',path:`/control/artifacts/${receipt.id}`});
    assert.equal(hash(artifact.content),receipt.sha256);
  }
  assert.deepEqual(persisted.resource.holders,[]);
  const service=(await ssh('systemctl --user show accord.service --property=ActiveState,SubState,MainPID,NRestarts')).stdout;
  const report={status:'passed',at:new Date().toISOString(),sshHost:host,authority:profile.authority,
    tunnel:{label,whileDisconnected:missing.status,reason:missing.reason,afterReconnect:restored.status,pinnedAuthorityPreserved:true},
    restart:{kind:'graceful systemd user service restart',previousEpoch:before.epoch,epoch:after.epoch,acceptedResultsPreserved:completed.length,artifactReceiptsPreserved:true,holders:[]},service};
  writeFileSync('evidence/live/ssh-services.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{
  if(tunnelStopped)await execute('launchctl',['bootstrap',domain,plist]);
  await client.closeSession();
}
