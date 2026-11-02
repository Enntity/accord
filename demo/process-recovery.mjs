// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { harness, launch, message, eventually, stop, delay } from '../test/helpers.mjs';
import { request, hash } from '../src/common.mjs';
import { groupExists } from '../src/plugins/posix-process-group.mjs';
export async function runProcessDemo(){
  const h=await harness(),admin=h.client('admin'),b=h.client('agent-b'),groups=[];
  try {
    const trace=join(h.data,'trace.jsonl'),lines=()=>existsSync(trace)?readFileSync(trace,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
    const manifest={schema:1,id:'compute-slot',asset:'demo:generic-compute',plugin:'posix-process-group',
      command:[process.execPath,fileURLToPath(new URL('../test/fixtures/workload.mjs',import.meta.url)),'recover'],cwd:h.data,
      env:{ACCORD_TEST_TRACE:trace,ACCORD_TEST_ONCE:join(h.data,'attempt')},terminationGraceMs:100};
    await admin.registerResource(manifest);
    const task=await admin.submit({title:'Physical process recovery',input:'resume after old process stops',resource:manifest.id,expectedHash:hash('process result')});
    const a=launch(new URL('./process-agent.mjs',import.meta.url));h.processes.push(a);
    a.send({url:h.url,credential:h.credential('agent-a'),taskId:task.taskId});
    const owned=await message(a,'owned');groups.push(owned.run.pgid);
    await eventually(()=>new Set(lines().filter(l=>l.event==='heartbeat').map(l=>l.pid)).size===2);
    const oldClaim=await h.client('agent-a').inspect(owned.claim),driverPort=Number(new URL(h.driverUrl).port);
    await stop(h.driver,'SIGKILL');await stop(a,'SIGKILL');
    await eventually(async()=> (await admin.board()).claims.find(c=>c.id===owned.claim).state==='revoking');
    assert(groupExists(owned.run.pgid));
    const held=await b.host(),resource=held.resources.find(r=>r.localId===manifest.id);
    assert.equal(resource.holder.claim,owned.claim);assert.equal(resource.driver,'DRIVER_UNAVAILABLE');
    await assert.rejects(b.claim({key:'wait-blocked',taskId:task.taskId}),{code:'TASK_BUSY'});
    const wait=b.waitClaim({key:'recover',taskId:task.taskId,waitMs:8000,leaseMs:5000});
    await h.startDriver(driverPort);
    const next=await wait,active=await h.active(next);
    assert(next.generation>owned.generation);assert.equal(groupExists(owned.run.pgid),false);
    const oldStoppedObservedAt=Date.now();
    assert.equal(active.task.checkpoint,'Resume controlled process after confirmed stop');
    await assert.rejects(request(h.driverUrl,oldClaim.resourceToken,'/v1/processes?resource=compute-slot',{key:'stale'}),{code:'STALE_GRANT'});
    const nextRun=await b.startProcess(next.id,'resume');groups.push(nextRun.pgid);
    await eventually(async()=> (await b.processStatus(next.id)).state==='exited');
    await b.finish(next.id,nextRun.id,'finish');
    const board=await eventually(async()=>{const board=await admin.board();return board.tasks.find(t=>t.id===task.taskId).state==='succeeded'&&board;});
    assert.equal(groupExists(nextRun.pgid),false);
    const audit=(await request(h.driverUrl,h.credential('driver-control'),'/control/audit?resource=compute-slot')).events;
    const oldStop=audit.findIndex(e=>e.kind==='process.stopped'&&e.claim_id===owned.claim);
    const nextGrant=audit.findIndex(e=>e.kind==='grant.active'&&e.claim_id===next.id);
    assert(oldStop>=0&&nextGrant>oldStop);
    let holder=null;for(const e of audit){if(e.kind==='grant.active'){assert.equal(holder,null);holder=e.claim_id;}if(e.kind==='grant.revoked')holder=null;}
    const samples=lines(),oldPids=new Set(samples.filter(l=>l.at<oldStoppedObservedAt).map(l=>l.pid));
    await delay(100);assert.equal(lines().length,samples.length);
    return {status:'passed',at:new Date().toISOString(),platform:process.platform,plugin:manifest.plugin,
      assertions:{agentKilled:true,driverKilled:true,liveDescendantsHeldDuringOutage:true,oldGroupAbsentBeforeNewGrant:true,stopAuditPrecedesNewGrant:true,checkpointRecovered:true,staleLaunchRejected:true,overlappingGrants:0,resultAcceptedAfterStop:true},
      observations:{oldGeneration:owned.generation,newGeneration:next.generation,oldGroup:owned.run.pgid,newGroup:nextRun.pgid,oldStoppedObservedAt,observedWorkloadPids:[...oldPids]},
      coordinatorEvents:board.events,driverAudit:audit,workloadTrace:samples,
      limits:['Cooperative descendants must remain in the managed process group.','Lost anchor with surviving descendants remains held until externally stopped.','No GPU/device isolation or LLooM route restoration exercised.']};
  }finally{for(const pid of groups){try{process.kill(-pid,'SIGKILL');}catch{}}await h.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const report=await runProcessDemo();writeFileSync('evidence/process-recovery.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,assertions:report.assertions},null,2));
}
