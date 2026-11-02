// SPDX-License-Identifier: MIT
// Called only by the explicit live qualifier. Prompts describe work, not MCP tool names.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const cli=fileURLToPath(new URL('../src/cli.mjs',import.meta.url));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function launch(kind,prompt,{root,profile,sessionFile}){
  const args=kind==='codex'?['--no-daemon','exec','--ephemeral','--json','--skip-git-repo-check','-s','read-only','-C',root,
    '-c',`mcp_servers.accord.args=${JSON.stringify([cli,'mcp','--profile',profile])}`,prompt]:
    ['-p','--output-format','stream-json','--verbose','--no-session-persistence','--tools','','--allowedTools','mcp__accord__*','--permission-mode','dontAsk',
    '--strict-mcp-config','--mcp-config',JSON.stringify({mcpServers:{accord:{command:process.execPath,args:[cli,'mcp','--profile',profile]}}}),'--',prompt];
  const env={...process.env};delete env.ACCORD_SESSION_FILE;if(sessionFile)env.ACCORD_SESSION_FILE=sessionFile;
  const proc=spawn(kind,args,{cwd:root,detached:true,stdio:['ignore','pipe','pipe'],env});
  const h={kind,proc,lines:[],stderr:'',buffer:''};
  proc.stdout.on('data',data=>{h.buffer+=data;let n;while((n=h.buffer.indexOf('\n'))>=0){const line=h.buffer.slice(0,n);h.buffer=h.buffer.slice(n+1);try{h.lines.push(JSON.parse(line));}catch{}}});
  proc.stderr.on('data',d=>h.stderr=(h.stderr+d).slice(-2000));proc.on('error',e=>h.stderr=e.message);return h;
}
function calls(h){
  if(h.kind==='codex')return h.lines.filter(x=>x.type==='item.completed'&&x.item?.type==='mcp_tool_call').map(x=>({tool:x.item.tool,error:x.item.error??null}));
  const uses=new Map(),result=[];
  for(const line of h.lines)for(const item of line.message?.content??[]){if(item.type==='tool_use')uses.set(item.id,item.name);if(item.type==='tool_result'&&uses.has(item.tool_use_id))result.push({tool:uses.get(item.tool_use_id).replace(/^mcp__accord__/,''),error:item.is_error??false});}
  return result;
}
export async function runModelLoop({root,profile,remoteSession,observer,authority}){
  const tag=Date.now(),receiver=`receiver-${tag}`,sender=`sender-${tag}`;
  const b=launch('claude',`Your name for this collaboration exercise is ${receiver}. Make yourself discoverable with activity "collaboration smoke test". Wait for a message from ${sender}, then reply to its sender with exactly "ACK ${tag}" and mark the incoming message read. Wait for a second message "DONE ${tag}", mark it read, and finish. Keep checking for up to three minutes; another agent is starting now. This is an isolated CPU-only test. Do not contact anyone else.`,{root,profile,sessionFile:remoteSession});
  const a=launch('codex',`Your name for this collaboration exercise is ${sender}. Make yourself discoverable. Find ${receiver} on the linked host (retry if they are still starting), send exactly "HELLO ${tag}", and wait for "ACK ${tag}". Mark the reply read. Discover the linked host's qualify-slot resource, reserve it, wait until running, start its registered CPU workload, then release it and confirm release completed. Finally send "DONE ${tag}" to ${receiver} and check that it was delivered before finishing. This is an isolated coordination test. Do not contact anyone else or touch other resources.`,{root,profile});
  const all=[a,b],until=Date.now()+240000;
  try{
    while(all.some(h=>h.proc.exitCode===null&&h.proc.signalCode===null)){
      if(Date.now()>until)throw Error('Model collaboration timed out');await delay(250);
    }
    const evidence=all.map(h=>({harness:h.kind,exitCode:h.proc.exitCode,calls:calls(h),stderr:h.stderr}));
    writeFileSync('evidence/thin/models.json',JSON.stringify({status:'checking',evidence},null,2)+'\n');
    for(const h of all){assert(calls(h).every(c=>!c.error),`${h.kind} reported a tool error`);assert.equal(h.proc.exitCode,0,`${h.kind}: ${h.stderr}`);assert(calls(h).some(c=>c.tool==='accord_bootstrap'),`${h.kind} did not bootstrap`);assert(calls(h).some(c=>c.tool==='accord_announce'),`${h.kind} did not announce`);assert(calls(h).some(c=>c.tool==='accord_send'),`${h.kind} did not send`);}
    for(const name of ['accord_find','accord_reserve','accord_workload','accord_release'])assert(calls(a).some(c=>c.tool===name),`Codex did not call ${name}`);
    const found=await observer.find(sender);assert(found.participants.some(p=>p.label===sender));
    const report={status:'passed',at:new Date().toISOString(),authority,tag,evidence,assertions:{installedStartupGuidance:true,noToolNamesInPrompts:true,bothBootstrapped:true,bothAnnounced:true,bidirectionalMessages:true,managedReservationUsedAndReleased:true},limits:['Two model CLI processes run on the Mac; Claude connects through SSH to the Linux authority.','No claim that closed GUI sessions can be awakened.']};
    writeFileSync('evidence/thin/models.json',JSON.stringify(report,null,2)+'\n');return report;
  }finally{for(const h of all)if(h.proc.exitCode===null&&h.proc.signalCode===null)try{process.kill(-h.proc.pid,'SIGKILL');}catch{}}
}
