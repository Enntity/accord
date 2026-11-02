// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness,eventually,stop } from './helpers.mjs';
import { AccordClient } from '../src/client.mjs';

async function fixture(t,capacity=2) {
  const h=await harness();t.after(()=>h.close());
  const admin=h.client('admin'),authority=(await admin.host()).authority;
  await admin.registerResource({schema:1,id:'gpus',asset:'gpu:fleet',plugin:'cooperative',capacity});
  const agent=async label=>{const c=await AccordClient.enroll(h.url,h.credential('bootstrap'),{authority,label});await c.announce({label,activity:'working'});return c;};
  const state=(c,id)=>c.reservation(id).then(r=>r.state);
  const running=(c,id)=>eventually(async()=>(await state(c,id))==='running');
  return {h,admin,agent,state,running};
}

test('a pool grants up to its capacity at once on distinct slots, then queues in order',async t=>{
  const f=await fixture(t),[a,b,c,d]=await Promise.all(['a','b','c','d'].map(f.agent));
  const ra=await a.reserve('gpus',{key:'a'}),rb=await b.reserve('gpus',{key:'b'});
  await f.running(a,ra.id);await f.running(b,rb.id);
  const sa=(await a.reservation(ra.id)).resource,sb=(await b.reservation(rb.id)).resource;
  assert.notEqual(sa,sb);assert.deepEqual([sa,sb].sort(),['gpus-0','gpus-1']);
  const rc=await c.reserve('gpus',{key:'c'}),rd=await d.reserve('gpus',{key:'d'});
  assert.equal((await c.reservation(rc.id)).resource,'gpus','a waiter holds the pool, not a slot');
  await a.release(ra.id,{key:'ra'});
  await f.running(c,rc.id);assert.equal(await f.state(d,rd.id),'queued','first in, first served');
  assert.equal((await c.reservation(rc.id)).resource,sa,'the freed slot is reused');
  await b.release(rb.id,{key:'rb'});await f.running(d,rd.id);
});

test('a slot lost with its session returns to the pool for the next waiter',async t=>{
  const f=await fixture(t,2),[a,b,c]=await Promise.all(['a','b','c'].map(f.agent));
  const ra=await a.reserve('gpus',{key:'a'});await f.running(a,ra.id);
  const rb=await b.reserve('gpus',{key:'b'});await f.running(b,rb.id);
  const rc=await c.reserve('gpus',{key:'c'});
  await a.closeSession();await f.running(c,rc.id);
});

test('a direct slot reservation and a pool waiter never share a slot',async t=>{
  const f=await fixture(t,2),[a,b,c]=await Promise.all(['a','b','c'].map(f.agent));
  const ra=await a.reserve('gpus-0',{key:'a'});await f.running(a,ra.id);
  const rb=await b.reserve('gpus',{key:'b'});await f.running(b,rb.id);
  assert.equal((await b.reservation(rb.id)).resource,'gpus-1');
  const rc=await c.reserve('gpus',{key:'c'});
  assert.equal(await f.state(c,rc.id),'queued');
});

test('the catalog summarises a pool once instead of listing a queue per slot',async t=>{
  const f=await fixture(t,3),[a,b]=await Promise.all(['a','b'].map(f.agent));
  const ra=await a.reserve('gpus',{key:'a'});await f.running(a,ra.id);
  assert.deepEqual((await f.admin.resources()).pools.map(({id,...p})=>[id.split('/')[1],p]),[['gpus',{capacity:3,free:2,queued:0}]]);
  await b.reserve('gpus-0',{key:'b'}).catch(()=>{});
  const catalog=await f.admin.resources();
  assert.equal(catalog.pools[0].free,2);assert.equal(catalog.resources.filter(r=>r.pool==='gpus').length,3);
});

test('a queued pool reservation survives a coordinator restart',async t=>{
  const f=await fixture(t,2),[a,b,c]=await Promise.all(['a','b','c'].map(f.agent));
  const ra=await a.reserve('gpus',{key:'a'});await f.running(a,ra.id);
  const rb=await b.reserve('gpus',{key:'b'});await f.running(b,rb.id);
  const rc=await c.reserve('gpus',{key:'c'});
  const port=Number(new URL(f.h.url).port);await stop(f.h.server);await f.h.startServer(port);
  await eventually(async()=>(await f.state(c,rc.id))==='running',12000);
});

test('registration rejects bad capacities, name collisions and is idempotent',async t=>{
  const f=await fixture(t);
  for(const capacity of [0,1,33,1.5,'2'])await assert.rejects(f.admin.registerResource({schema:1,id:'bad',asset:'bad:one',plugin:'cooperative',capacity}),{code:'INVALID_INPUT'});
  await assert.rejects(f.admin.registerResource({schema:1,id:'artifact',asset:'bad:two',plugin:'cooperative',capacity:2}),e=>['RESOURCE_MANIFEST','RESOURCE_CONFLICT'].includes(e.code));
  await f.admin.registerResource({schema:1,id:'single',asset:'one:one',plugin:'cooperative'});
  await assert.rejects(f.admin.registerResource({schema:1,id:'single',asset:'one:two',plugin:'cooperative',capacity:2}),{code:'RESOURCE_CONFLICT'});
  const manifest={schema:1,id:'gpus',asset:'gpu:fleet',plugin:'cooperative',capacity:2};
  await f.admin.registerResource(manifest);await f.admin.registerResource(manifest);
  assert.equal((await f.admin.resources()).pools[0].capacity,2);
  await f.admin.registerResource({...manifest,capacity:3});
  assert.equal((await f.admin.resources()).pools[0].capacity,3,'a pool can grow');
  await assert.rejects(f.admin.registerResource({...manifest,capacity:2}),{code:'RESOURCE_CONFLICT'});
});

test('a managed provider cannot be pooled, because a release would stop every holder',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.admin.registerResource({schema:1,id:'models',asset:'lloom:models',plugin:'managed-http',url:'http://127.0.0.1:9',tokenFile:'/tmp/none',capacity:2}),{code:'INVALID_INPUT'});
  assert.equal((await f.admin.resources()).resources.some(r=>r.localId?.startsWith('models')),false);
});

test('a slot name collision is refused before anything is registered',async t=>{
  const f=await fixture(t);
  await f.admin.registerResource({schema:1,id:'jobs-1',asset:'jobs:taken',plugin:'cooperative'});
  await assert.rejects(f.admin.registerResource({schema:1,id:'jobs',asset:'jobs:pool',plugin:'cooperative',capacity:3}),{code:'RESOURCE_CONFLICT'});
  assert.equal((await f.admin.resources()).resources.some(r=>r.localId==='jobs-0'),false,'no partial pool');
  assert.equal((await f.admin.resources()).pools.length,1);
});

test('a managed process manifest expands into pool slots too',async t=>{
  const f=await fixture(t),a=await f.agent('a');
  await f.admin.registerResource({schema:1,id:'build',asset:'host-local:build',plugin:'posix-process-group',command:['/usr/bin/printf','ok'],cwd:'/tmp',terminationGraceMs:200,capacity:2});
  const r=await a.reserve('build',{key:'p'});await f.running(a,r.id);
  assert.equal((await a.reservation(r.id)).resource,'build-0');
  await a.release(r.id,{key:'pr'});await eventually(async()=>['released','succeeded'].includes(await f.state(a,r.id)));
});

test('an unknown pool or resource is refused at reservation',async t=>{
  const f=await fixture(t),a=await f.agent('a');
  await assert.rejects(a.reserve('nothing',{key:'x'}),{code:'RESOURCE_UNKNOWN'});
});
