// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { harness,eventually } from './helpers.mjs';
import { request } from '../src/common.mjs';

test('an administrator removes an idle resource by name, and registering it again keeps fencing safe',async t=>{
  const h=await harness();t.after(()=>h.close());
  const admin=h.client('admin'),a=h.client('agent-a'),manifest={schema:1,id:'gpu',asset:'host:box:gpu',plugin:'cooperative'};
  await admin.registerResource(manifest,'register-gpu');
  await admin.registerResource({schema:1,id:'other',asset:'host:box:other',plugin:'cooperative'});
  const ids=async()=>(await admin.resources()).resources.map(r=>r.localId);
  const driverIds=async()=>(await request(h.driverUrl,h.credential('driver-control').trim(),'/control/resources')).resources.map(r=>r.id);
  const r=await a.reserve('gpu',{durationMs:600000});
  const held=await eventually(async()=>{const s=await a.reservation(r.id);return s.state==='running'&&s;});
  await assert.rejects(a.removeResource('gpu'),{code:'FORBIDDEN'});
  await assert.rejects(admin.removeResource('gpu'),{code:'RESOURCE_BUSY'},'a held resource stays');
  await assert.rejects(admin.removeResource('artifact'),{code:'INVALID_INPUT'});
  assert((await ids()).includes('gpu'));
  await a.release(r.id);await eventually(async()=>(await a.reservation(r.id)).state==='released');
  assert.deepEqual(await admin.removeResource('gpu'),{id:'gpu',removed:true});
  assert(!(await ids()).includes('gpu'));assert(!(await driverIds()).includes('gpu'));
  assert(!existsSync(join(h.data,'process-gpu.sqlite')),'its driver files go too');
  assert((await ids()).includes('other'));assert((await driverIds()).includes('other'));
  assert.deepEqual(await admin.removeResource('gpu'),{id:'gpu',removed:false},'removing it again changes nothing');
  await assert.rejects(a.reserve('gpu',{durationMs:60000}),{code:'RESOURCE_UNKNOWN'});
  await admin.registerResource(manifest,'register-gpu');
  const again=await a.reserve('gpu',{durationMs:60000});
  const next=await eventually(async()=>{const s=await a.reservation(again.id);return s.state==='running'&&s;});
  assert(next.generation>held.generation,'fencing continues above every generation the old resource issued');
  await a.release(again.id);
});
