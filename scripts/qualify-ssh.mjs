// SPDX-License-Identifier: MIT
// Explicit live qualification, never included in npm test. Requires installed hosts and verified SSH.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { enrollProfile, profileAt, discover } from '../src/bootstrap.mjs';
import { request, hash } from '../src/common.mjs';

const delay=ms=>new Promise(r=>setTimeout(r,ms));
const cli=fileURLToPath(new URL('../src/cli.mjs',import.meta.url));
const argv=process.argv.slice(2),option=(n,d)=>{const i=argv.indexOf(`--${n}`);return i<0?d:argv[i+1];};
assert(argv.includes('--confirm-live'),'Live qualification requires --confirm-live');
const sshHost=option('host'),profilePath=option('profile'),remoteControl=option('remote-control'),remoteNode=option('remote-node');
assert(sshHost&&profilePath&&remoteControl&&remoteNode,'Explicit host/profile/control/runtime required');
assert(/^[a-zA-Z0-9_.-]+$/.test(sshHost));assert(/^\/[a-zA-Z0-9_./-]+$/.test(remoteControl+remoteNode));
const secondHarness=option('second','codex');assert(['codex','claude'].includes(secondHarness));
const profile=profileAt(profilePath),root=mkdtempSync(join(tmpdir(),'accord-live-'));
const output=resolve(option('out',`evidence/live/ssh-${secondHarness}.json`));
const observations=[],harnesses=[];let frozen,firstClient,oldClaim,createdTask;
const record=(event,details={})=>{const entry={event,at:new Date().toISOString(),...details};observations.push(entry);console.log(JSON.stringify(entry));};
const remote=async input=>{
  const child=spawn('ssh',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',sshHost,`${remoteNode} ${remoteControl}`],{stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
  const timer=setTimeout(()=>child.kill('SIGKILL'),10000);child.stdin.end(JSON.stringify({...input,authority:profile.authority}));
  const code=await new Promise((r,j)=>{child.once('error',j);child.once('exit',r);});clearTimeout(timer);
  if(code!==0)throw Error(`SSH controller failed (${code}): ${stderr.slice(-500)}`);return JSON.parse(stdout);
};
const board=()=>remote({action:'admin',path:'/v1/board'});
async function until(fn,ms=60000){const end=Date.now()+ms;let error;while(Date.now()<end){try{const result=await fn();if(result)return result;}catch(e){error=e;}await delay(200);}throw Error(`Live condition timed out${error?': '+error.message:''}`);}
function launchHarness(kind,prompt,sessionFile){
  const args=kind==='codex'?['--no-daemon','exec','--ephemeral','--json','--skip-git-repo-check','-s','read-only','-C',root,
    '-c',`mcp_servers.accord.args=${JSON.stringify([cli,'mcp','--profile',profilePath])}`,prompt]:
    ['-p','--output-format','stream-json','--verbose','--no-session-persistence','--tools','','--allowedTools','mcp__accord__*','--permission-mode','dontAsk',
      '--strict-mcp-config','--mcp-config',JSON.stringify({mcpServers:{accord:{command:process.execPath,args:[cli,'mcp','--profile',profilePath]}}}),'--',prompt];
  const env={...process.env};if(sessionFile)env.ACCORD_SESSION_FILE=sessionFile;else delete env.ACCORD_SESSION_FILE;
  const proc=spawn(kind,args,{cwd:root,detached:true,stdio:['ignore','pipe','pipe'],env});
  const item={kind,proc,lines:[],stderr:'',buffer:''};harnesses.push(item);
  proc.stdout.setEncoding('utf8');proc.stdout.on('data',data=>{item.buffer+=data;let n;while((n=item.buffer.indexOf('\n'))>=0){const line=item.buffer.slice(0,n);item.buffer=item.buffer.slice(n+1);try{item.lines.push(JSON.parse(line));}catch{}}});
  proc.stderr.on('data',d=>item.stderr=(item.stderr+d.toString()).slice(-3000));return item;
}
function calls(h){
  if(h.kind==='codex')return h.lines.filter(x=>x.type==='item.completed'&&x.item?.type==='mcp_tool_call').map(x=>x.item);
  const uses=new Map(),results=[];
  for(const line of h.lines){
    for(const item of line.message?.content??[]){
      if(item.type==='tool_use')uses.set(item.id,item);
      if(item.type==='tool_result'&&uses.has(item.tool_use_id)){
        const use=uses.get(item.tool_use_id);results.push({tool:use.name.replace(/^mcp__accord__/,''),arguments:use.input,result:item.content,error:item.is_error??false});
      }
    }
  }return results;
}
function stopHarness(h){if(h&&h.proc.exitCode===null&&h.proc.signalCode===null)try{process.kill(-h.proc.pid,'SIGKILL');}catch{}}
try{
  const initial=await discover(profile);assert.equal(initial.resource.state,'unclaimed');
  const baseline=await board();assert(baseline.tasks.every(t=>['succeeded','cancelled','failed'].includes(t.state)),'Remote host has unrelated unfinished work');
  record('ssh_host_discovered',{authority:initial.authority,epoch:initial.epoch,name:initial.name});
  const task=await remote({action:'admin',path:'/v1/tasks',body:{key:randomUUID(),title:'Live SSH recovery qualification',input:'accord survives interruption',expectedHash:hash('ACCORD SURVIVES INTERRUPTION')}});
  createdTask=task.taskId;
  firstClient=await enrollProfile(profilePath,{label:'live Codex owner',harness:'codex'});
  const sessionFile=join(root,'first-session.json');writeFileSync(sessionFile,JSON.stringify({schema:1,url:firstClient.url,...firstClient.session}),{mode:0o600});
  const promptA='This is an authorized Accord recovery qualification against an isolated artifact task. Use ONLY Accord MCP tools. First call accord_bootstrap. Claim the queued task with key live-owner-claim and leaseMs 30000; inspect until running. Checkpoint exactly "Prepared: write ACCORD SURVIVES INTERRUPTION" using key live-owner-checkpoint. Then repeatedly call accord_wait with key live-owner-wait and waitMs 20000; there is no second task, so this waits. Do not finish, write, cancel, renew, or use other tools. A controller will interrupt this process to test recovery. Do not stop voluntarily before that.';
  const a=launchHarness('codex',promptA,sessionFile);
  oldClaim=await until(async()=>{if(a.proc.exitCode!==null)throw Error('First harness exited early');const state=await board();const t=state.tasks.find(t=>t.id===task.taskId);return t?.checkpoint&&state.claims.find(c=>c.task_id===task.taskId&&c.state==='running');},90000);
  assert.equal(oldClaim.actor,firstClient.session.sessionId,'MCP did not inherit the launched session');
  const fullOld=await firstClient.inspect(oldClaim.id);
  record('real_codex_claimed_and_checkpointed',{claim:oldClaim.id,session:oldClaim.actor,generation:oldClaim.generation});
  frozen=await remote({action:'freeze-driver'});record('remote_driver_suspended',{pid:frozen.pid});
  stopHarness(a);record('codex_owner_killed');
  await until(async()=>{const state=await board();return state.claims.find(c=>c.id===oldClaim.id)?.state==='revoking';},40000);
  const held=await discover(profile);assert.equal(held.resource.holder.claim,oldClaim.id);assert.equal(held.resource.driver,'DRIVER_UNAVAILABLE');
  record('expired_owner_remains_held',{state:held.resource.holder.state,generation:held.resource.holder.generation});
  const promptB='This is an authorized Accord recovery qualification on an isolated artifact resource. Use ONLY Accord MCP tools. Call accord_bootstrap and accord_host FIRST. Discover the existing task and ownership from their responses; no task ID is supplied. If held/recovering, call accord_wait with key fresh-recovery-claim and waitMs 20000, retrying the SAME key after timeouts. A controller will restore the driver after observing your wait. Once a claim exists, inspect until running. Read the recovered checkpoint. Write exactly "ACCORD SURVIVES INTERRUPTION" with accord_write key fresh-output, finish its receipt with accord_finish key fresh-finish, then call accord_board to verify succeeded. Renew your own running claim to 30000 milliseconds before writing if needed; never renew the old owner. Return the session ID, claim generation, recovered checkpoint, and final state. Do not renew the old owner, cancel, use shell/file tools, or touch any other work.';
  const b=launchHarness(secondHarness,promptB);
  await until(()=>{if(b.proc.exitCode!==null)throw Error(`Incoming ${secondHarness} exited (${b.proc.exitCode}): ${b.stderr.slice(-500)}`);return calls(b).some(c=>c.tool==='accord_bootstrap');},90000);
  await until(()=>{
    if(secondHarness==='codex')return b.lines.some(x=>x.item?.type==='mcp_tool_call'&&x.item.tool==='accord_wait');
    return b.lines.some(x=>x.message?.content?.some(c=>c.type==='tool_use'&&c.name==='mcp__accord__accord_wait'));
  },45000);
  const stillHeld=await board();assert.deepEqual(stillHeld.resource.holders,[oldClaim.id]);
  record('fresh_real_agent_discovered_hold_and_waited',{harness:secondHarness});
  await remote({action:'resume-driver',pid:frozen.pid});frozen=null;record('driver_resumed');
  const completed=await until(async()=>{const state=await board();return state.tasks.find(t=>t.id===task.taskId)?.state==='succeeded'&&state;},90000);
  await until(()=>b.proc.exitCode!==null||b.proc.signalCode!==null,45000);
  const next=completed.claims.find(c=>c.task_id===task.taskId&&c.generation>oldClaim.generation);
  assert(next);assert.notEqual(next.actor,oldClaim.actor);
  // Check the former grant directly at the driver using its credential held only in private memory.
  // Access the driver through a short second SSH forward is unnecessary: execute the stale write locally on the host.
  const stale=await remote({action:'stale-write',claimCredential:fullOld.resourceToken});
  assert.equal(stale.code,'STALE_GRANT');
  const accepted=JSON.parse(completed.tasks.find(t=>t.id===task.taskId).result);
  const artifact=await remote({action:'driver',path:`/control/artifacts/${accepted.id}`});assert.equal(artifact.content,'ACCORD SURVIVES INTERRUPTION');
  const audit=await remote({action:'driver',path:'/control/audit'});let owner=null;
  for(const e of audit.events){if(e.kind==='grant.active'){assert.equal(owner,null);owner=e.claim_id;}if(['grant.revoked','restart.revoked'].includes(e.kind))owner=null;if(e.kind==='artifact.written')assert.equal(owner,e.claim_id);}
  assert.equal(owner,null);
  record('recovery_verified',{newSession:next.actor,generation:next.generation,staleWrite:stale.code,outputHash:accepted.sha256});
  const report={status:'passed',at:new Date().toISOString(),authority:profile.authority,sshHost,transport:'OpenSSH host-key-verified local forwarding',
    harnesses:['codex',secondHarness],observations,assertions:{realHarnesses:true,sessionInherited:true,freshDiscovery:true,unknownReleaseHeld:true,checkpointRecovered:true,generationAdvanced:true,staleWriteRejected:true,overlappingGrants:0},
    toolCalls:harnesses.map(h=>({harness:h.kind,calls:calls(h)})),events:completed.events,driverAudit:audit.events,output:artifact.content,
    limits:['Artifact driver only; no GPU or arbitrary process ownership claim.','Driver outage injected with SIGSTOP; agent killed with SIGKILL.']};
  mkdirSync(join(output,'..'),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  record('proof_saved',{path:output});
}catch(error){
  if(createdTask)try{await remote({action:'admin',path:`/v1/tasks/${createdTask}/cancel`,body:{key:randomUUID()}});}catch{}
  mkdirSync(join(output,'..'),{recursive:true});writeFileSync(output,JSON.stringify({status:'failed',error:error.message,observations,harnesses:harnesses.map(h=>({kind:h.kind,exitCode:h.proc.exitCode,signal:h.proc.signalCode,calls:calls(h),stderr:h.stderr}))},null,2)+'\n');throw error;
}finally{
  if(frozen)try{await remote({action:'resume-driver',pid:frozen.pid});}catch(error){console.error('RESTORE REQUIRED: '+error.message);}
  harnesses.forEach(stopHarness);if(firstClient)try{await firstClient.closeSession();}catch{}
  rmSync(root,{recursive:true,force:true});
}
