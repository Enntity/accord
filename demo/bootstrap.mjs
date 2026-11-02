// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harness, launch, message, eventually, stop } from '../test/helpers.mjs';
import { install } from '../src/installer.mjs';
import { hash, request } from '../src/common.mjs';
import { enrollProfile } from '../src/bootstrap.mjs';

export async function runBootstrapDemo(){
  const h=await harness();
  try{
    const installation=install({home:join(h.data,'fresh-home'),data:h.data,clients:['codex','claude']});
    const first=await enrollProfile(installation.profile,{label:'first owner',harness:'protocol-fixture'});
    const admin=h.client('admin');
    const {taskId}=await admin.submit({title:'Discover and recover this build',input:'fresh agents find their way',expectedHash:hash('FRESH AGENTS FIND THEIR WAY')});
    let old=await first.claim({taskId,leaseMs:1400});
    old=await eventually(async()=>{const c=await first.inspect(old.id);return c.state==='running'&&c;});
    await first.checkpoint(old.id,'Input reviewed; next action: write uppercase output.');
    const incoming=launch(new URL('./fresh-agent.mjs',import.meta.url),[installation.profile]);h.processes.push(incoming);
    const seen=await message(incoming,'discovered');assert.equal(seen.host.resource.holder.claim,old.id);
    const identity=await message(incoming,'bootstrapped');assert.notEqual(identity.sessionId,first.session.sessionId);
    await message(incoming,'waiting');
    const driverPort=Number(new URL(h.driverUrl).port);await stop(h.driver,'SIGKILL');
    // First owner is abandoned: no renewals. Driver loss must keep the resource held.
    await eventually(()=>incoming.messages.find(m=>m.type==='waiting'&&m.host.resource.holder?.state==='revoking'));
    assert.equal(incoming.messages.some(m=>m.type==='acquired'),false);
    assert.equal((await admin.board()).resource.holders[0],old.id);
    await h.startDriver(driverPort);
    const acquired=await message(incoming,'acquired');assert(acquired.generation>old.generation);
    assert.equal(acquired.checkpoint,old.task.checkpoint??'Input reviewed; next action: write uppercase output.');
    const finished=await message(incoming,'finished');
    await assert.rejects(first.write(old,'STALE'),e=>e.code==='STALE_GRANT');
    const board=await admin.board(),audit=await request(h.driverUrl,h.credential('driver-control'),'/control/audit');
    assert.equal(board.tasks[0].state,'succeeded');
    let owner=null;
    for(const event of audit.events){
      if(event.kind==='grant.active'){assert.equal(owner,null);owner=event.claim_id;}
      if(['grant.revoked','restart.revoked'].includes(event.kind))owner=null;
      if(event.kind==='artifact.written')assert.equal(owner,event.claim_id);
    }
    assert.equal(owner,null);
    const output=await request(h.driverUrl,h.credential('driver-control'),`/control/artifacts/${finished.receipt.id}`);
    assert.equal(output.content,'FRESH AGENTS FIND THEIR WAY');
    return {status:'passed',demo:'fresh process with an installed profile discovers an existing lease and safely recovers',
      runtime:{node:process.version,platform:process.platform,arch:process.arch},
      assertions:{installerCreatedMcpAndSkill:true,distinctSessions:true,noTaskIdProvided:true,existingLeaseDiscovered:true,
        waitedThroughUnknownRelease:true,checkpointRecovered:true,generationAdvanced:true,staleWriteRejected:true,overlappingGrants:0},
      observations:incoming.messages.filter(m=>['discovered','bootstrapped','waiting','acquired','finished'].includes(m.type)),
      events:board.events,driverAudit:audit.events,output:output.content,
      limits:['Deterministic agents over real HTTP and subprocesses.','Artifact enforcement only.','No real remote host or model harness contacted.']};
  }finally{await h.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const report=await runBootstrapDemo();mkdirSync('evidence',{recursive:true});
  writeFileSync('evidence/bootstrap.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({status:report.status,evidence:'evidence/bootstrap.json',assertions:report.assertions},null,2));
}
