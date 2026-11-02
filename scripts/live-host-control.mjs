// SPDX-License-Identifier: MIT
// Explicit operator-only controller for an installed Linux qualification host.
// Not part of the service API. Input arrives on stdin; credentials never leave this process.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { configuration } from '../src/config.mjs';
import { request, requireThat } from '../src/common.mjs';
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
const input=JSON.parse(Buffer.concat(chunks).toString());
const data=join(homedir(),'.local','share','accord'),config=configuration(data);
requireThat(input.authority===config.authority,'AUTHORITY_MISMATCH','Wrong qualification authority');
const endpoints=JSON.parse(readFileSync(join(data,'endpoints.json'),'utf8'));
let result;
if(input.action==='admin'){
  requireThat((['/v1/board','/v1/tasks','/v1/host','/v1/steer'].includes(input.path)||/^\/v1\/tasks\/[a-f0-9-]+\/cancel$/.test(input.path)),'QUALIFICATION_ROUTE','Unsupported admin route');
  result=await request(endpoints.coordinator,config.readToken('admin'),input.path,input.body);
}else if(input.action==='driver'){
  requireThat(['/control/status','/control/audit'].includes(input.path)||/^\/control\/artifacts\/[a-f0-9-]+$/.test(input.path),'QUALIFICATION_ROUTE','Unsupported driver route');
  result=await request(endpoints.driver,config.readToken('driver-control'),input.path);
}else if(input.action==='stale-write'){
  try{await request(endpoints.driver,input.claimCredential,'/v1/artifacts',{key:'live-stale-write',content:'STALE'});result={code:'UNEXPECTED_SUCCESS'};}
  catch(error){result={code:error.code};}
}else if(input.action==='freeze-driver'||input.action==='resume-driver'){
  const supervisor=Number(execFileSync('systemctl',['--user','show','accord.service','--property=MainPID','--value'],{encoding:'utf8'}).trim());
  requireThat(supervisor>1,'NO_SUPERVISOR','Accord supervisor is not running');
  const candidates=[];
  for(const name of readdirSync('/proc').filter(n=>/^\d+$/.test(n))){
    try{
      const status=readFileSync(`/proc/${name}/status`,'utf8');
      if(Number(/^PPid:\s+(\d+)/m.exec(status)?.[1])!==supervisor)continue;
      const args=readFileSync(`/proc/${name}/cmdline`,'utf8').split('\0');
      if(args[2]==='driver'&&args[3]==='--data'&&args[4]===data)candidates.push(Number(name));
    }catch{}
  }
  requireThat(candidates.length===1,'DRIVER_IDENTITY','Could not identify exactly one owned Accord driver');
  const pid=candidates[0];
  if(input.pid)requireThat(input.pid===pid,'DRIVER_CHANGED','Driver changed during fault injection');
  process.kill(pid,input.action==='freeze-driver'?'SIGSTOP':'SIGCONT');
  result={pid,action:input.action,supervisor};
}else throw Error('Unknown qualification action');
console.log(JSON.stringify(result));
