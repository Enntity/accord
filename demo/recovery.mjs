// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harness, message, stop, eventually } from '../test/helpers.mjs';
import { hash, request } from '../src/common.mjs';

export async function runRecoveryDemo() {
  const h = await harness();
  const observations = [];
  const record = (event, details = {}) => observations.push({ event, at: new Date().toISOString(), ...details });
  try {
    const admin = h.client('admin'), b = h.client('agent-b');
    const { taskId } = await admin.submit({ title:'Recover a shared artifact build',input:'agents can cooperate',expectedHash:hash('AGENTS CAN COOPERATE') });
    const dependent = await admin.submit({ title:'Dependent acceptance artifact',input:'verified output',expectedHash:hash('VERIFIED OUTPUT'),dependency:taskId });
    await assert.rejects(b.claim({taskId:dependent.taskId}), e => e.code === 'DEPENDENCY');
    const first = h.agent('agent-a', {mode:'hold',taskId,leaseMs:1400});
    const { claim: old } = await message(first, 'claimed');
    await message(first, 'checkpointed');
    record('agent_a_owns_resource', { claim:old.id,generation:old.generation });
    const driverPort = Number(new URL(h.driverUrl).port);
    await stop(h.driver, 'SIGKILL');
    await stop(first, 'SIGKILL');
    record('agent_a_and_driver_killed');
    await eventually(async () => (await admin.board()).claims.find(c=>c.id===old.id)?.state === 'revoking');
    await assert.rejects(b.claim({taskId}), e => e.code === 'TASK_BUSY');
    const held = (await admin.board()).resource.holders;
    assert.deepEqual(held,[old.id]);
    record('reassignment_refused_while_release_unknown');
    const second = h.agent('agent-b', {mode:'complete',taskId,leaseMs:3000});
    await h.startDriver(driverPort);
    const completed = await message(second, 'finished');
    assert(completed.generation > old.generation);
    assert.match(completed.checkpoint,/next action/);
    await eventually(async () => (await admin.board()).tasks.find(t=>t.id===taskId)?.state==='succeeded');
    record('agent_b_recovered_checkpoint_and_completed', {claim:completed.claimId,generation:completed.generation,sha256:completed.receipt.sha256});
    await assert.rejects(request(h.driverUrl,old.resourceToken,'/v1/artifacts',{key:'late-zombie-write',content:'WRONG'}), e => e.code==='STALE_GRANT');
    await assert.rejects(h.client('agent-a').finish(old.id,completed.receipt.id), e => e.code==='STALE_CLAIM');
    record('old_writer_and_late_completion_rejected');
    const next = h.agent('agent-b', {mode:'complete',taskId:dependent.taskId,leaseMs:3000});
    await message(next,'finished');
    const final = await eventually(async () => { const board = await admin.board(); return board.tasks.every(t=>t.state==='succeeded') && board; });
    const audit = await request(h.driverUrl,h.credential('driver-control'),'/control/audit');
    let owner = null, writes = 0;
    for (const event of audit.events) {
      if (event.kind==='grant.active') { assert.equal(owner,null); owner=event.claim_id; }
      if (event.kind==='grant.revoked' || event.kind==='restart.revoked') owner=null;
      if (event.kind==='artifact.written') { assert.equal(owner,event.claim_id); writes++; }
    }
    assert.equal(writes,2); assert.equal(owner,null);
    const output = await request(h.driverUrl,h.credential('driver-control'),`/control/artifacts/${completed.receipt.id}`);
    assert.equal(output.content,'AGENTS CAN COOPERATE');
    record('dependent_work_completed_and_all_grants_released');
    return { status:'passed',demo:'two actor identities in separate deterministic worker processes',scope:'loopback HTTP and driver-owned SQLite artifact writes; no LLM or GPU claim',
      runtime:{node:process.version,platform:process.platform,arch:process.arch},observations,
      assertions:{unknownReleaseBlocked:true,checkpointRecovered:true,generationAdvanced:true,staleWriteRejected:true,lateCompletionRejected:true,dependencyGated:true,overlappingDriverGrants:0,artifactWrites:writes},
      tasks:final.tasks.map(t=>({id:t.id,title:t.title,state:t.state})),events:final.events,driverAudit:audit.events,output:output.content };
  } finally { await h.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = resolve(process.argv[2] || 'evidence'); mkdirSync(directory,{recursive:true});
  try {
    const report = await runRecoveryDemo();
    const file=join(directory,`recovery-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
    writeFileSync(file,JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({status:report.status,evidence:file,assertions:report.assertions},null,2));
  } catch(error) { console.error(error);process.exitCode=1; }
}
