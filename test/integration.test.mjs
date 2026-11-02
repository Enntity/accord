// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, eventually, stop, delay } from './helpers.mjs';
import { hash, request } from '../src/common.mjs';
import { runRecoveryDemo } from '../demo/recovery.mjs';
import http from 'node:http';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { listen } from '../src/common.mjs';

test('100 concurrent HTTP claims have one winner; effects/results are authenticated and idempotent', {timeout:20000},async t=>{
  const h=await harness();t.after(()=>h.close());const a=h.client('agent-a'),b=h.client('agent-b');
  const {taskId}=await a.submit({title:'race',input:'a',expectedHash:hash('A')});
  const results=await Promise.allSettled(Array.from({length:100},(_,i)=>a.claim({taskId,key:`race-${i}`,leaseMs:10000})));
  const winners=results.filter(r=>r.status==='fulfilled');assert.equal(winners.length,1);
  assert(results.filter(r=>r.status==='rejected').every(r=>r.reason.code==='TASK_BUSY'));
  const claim=await h.active(winners[0].value);
  const winnerIndex=results.findIndex(r=>r.status==='fulfilled');
  const retry=await a.claim({taskId,key:`race-${winnerIndex}`,leaseMs:10000});assert.equal(retry.id,claim.id);
  await assert.rejects(b.inspect(claim.id),e=>e.code==='NOT_OWNER');
  await assert.rejects(b.checkpoint(claim.id,'forged'),e=>e.code==='NOT_OWNER');
  await assert.rejects(b.pause(true),e=>e.code==='FORBIDDEN');
  await assert.rejects(request(h.url,'wrong','/v1/board'),e=>e.code==='UNAUTHORIZED');
  const cross=await fetch(h.url+'/v1/board',{headers:{Authorization:`Bearer ${h.credential('admin')}`,Origin:'https://untrusted.example'}});assert.equal(cross.status,403);
  const wrong=await a.write(claim,'WRONG');await assert.rejects(a.finish(claim.id,wrong.id),e=>e.code==='RESULT_REJECTED');
  const receipt=await a.write(claim,'A','write-once');assert.equal((await a.write(claim,'A','write-once')).id,receipt.id);
  await assert.rejects(a.write(claim,'B','write-once'),e=>e.code==='KEY_REUSED');
  const accepted=await a.finish(claim.id,receipt.id,'finish-once');
  await eventually(async()=>(await a.board()).tasks[0].state==='succeeded');
  assert.deepEqual(await a.finish(claim.id,receipt.id,'finish-once'),accepted);
  await assert.rejects(a.write(claim,'late','late'),e=>e.code==='STALE_GRANT');
  const board=await a.board();assert.equal(board.resource.holders.length,0);
  const serialized=JSON.stringify(board);assert(!serialized.includes(claim.resourceToken));assert(!serialized.includes(h.credential('agent-a')));
});
test('SIGKILL coordinator with active grant reconciles before reassigning', {timeout:15000},async t=>{
  const h=await harness({leaderMs:1000});t.after(()=>h.close());let a=h.client('agent-a');
  const {taskId}=await a.submit({title:'restart',input:'x',expectedHash:hash('X')});
  const old=await h.active(await a.claim({taskId,leaseMs:10000}));await a.checkpoint(old.id,'resume from this');
  const port=Number(new URL(h.url).port);await stop(h.server,'SIGKILL');await delay(1100);await h.startServer(port);a=h.client('agent-a');
  await eventually(async()=>(await a.board()).tasks[0].state==='queued');
  const next=await h.active(await h.client('agent-b').claim({taskId,leaseMs:5000}));assert(next.generation>old.generation);assert.equal(next.task.checkpoint,'resume from this');
  await assert.rejects(request(h.driverUrl,old.resourceToken,'/v1/artifacts',{key:'late',content:'X'}),e=>e.code==='STALE_GRANT');
  const events=(await a.board()).events;assert(events.some(e=>e.kind==='claim.recovering'));
  assert(events.findIndex(e=>e.kind==='claim.released')<events.findLastIndex(e=>e.kind==='claim.active'));
});
test('pause stops new admissions without pretending the current holder stopped', {timeout:10000},async t=>{
  const h=await harness();t.after(()=>h.close());const a=h.client('agent-a'),admin=h.client('admin');
  const {taskId}=await a.submit({title:'pause',input:'x',expectedHash:hash('X')});
  await admin.pause(true);await assert.rejects(a.claim({taskId}),e=>e.code==='PAUSED');
  await admin.pause(false);const claim=await h.active(await a.claim({taskId,leaseMs:3000}));
  await admin.pause(true);assert.equal((await a.board()).resource.holders[0],claim.id);
  const receipt=await a.write(claim,'X');await a.finish(claim.id,receipt.id);await eventually(async()=>(await a.board()).tasks[0].state==='succeeded');
});
test('two-agent fault demo preserves checkpoints, blocks unknown ownership, and completes dependent work', {timeout:20000},async()=>{
  const report=await runRecoveryDemo();assert.equal(report.status,'passed');assert.equal(report.assertions.overlappingDriverGrants,0);
});

test('lost activation and revoke replies leave a durable hold until acknowledgment can be retried', {timeout:15000},async t=>{
  const h=await harness();t.after(()=>h.close());await stop(h.server);
  let dropActivation=true,dropRevoke=true;
  const proxy=http.createServer(async(req,res)=>{
    try {
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const upstream=await fetch(h.driverUrl+req.url,{method:req.method,headers:{authorization:req.headers.authorization,'content-type':'application/json'},body:req.method==='POST'?Buffer.concat(chunks):undefined});
      const body=await upstream.text();
      if ((req.url==='/control/activate'&&dropActivation)||(req.url==='/control/revoke'&&dropRevoke)) {res.destroy();return;}
      res.writeHead(upstream.status,{'content-type':'application/json'});res.end(body);
    }catch{res.destroy();}
  });
  t.after(()=>new Promise(r=>{proxy.closeAllConnections();proxy.close(r);}));
  const proxyUrl=await listen(proxy);await h.startServer(0,proxyUrl);
  const a=h.client('agent-a');const {taskId}=await a.submit({title:'lost reply',input:'x',expectedHash:hash('X')});
  const claim=await a.claim({taskId,leaseMs:700});
  await eventually(async()=>(await request(h.driverUrl,h.credential('driver-control'),'/control/status')).claim_id===claim.id);
  assert.equal((await a.inspect(claim.id)).state,'preparing');
  await eventually(async()=>(await a.inspect(claim.id)).state==='revoking');
  await eventually(async()=>(await request(h.driverUrl,h.credential('driver-control'),'/control/status')).claim_id===null);
  assert.equal((await a.board()).resource.holders[0],claim.id);
  await assert.rejects(h.client('agent-b').claim({taskId}),e=>e.code==='TASK_BUSY');
  // Crash with a completed remote revoke whose acknowledgment has not been committed locally.
  await stop(h.server,'SIGKILL');await delay(h.leaderMs+100);
  dropActivation=false;dropRevoke=false;await h.startServer(0,proxyUrl);
  await eventually(async()=>(await h.client('agent-a').board()).tasks[0].state==='queued');
  const next=await h.active(await h.client('agent-b').claim({taskId,leaseMs:2000}));assert(next.generation>claim.generation);
});

test('a replaced driver database cannot be mistaken for a free resource', {timeout:10000},async t=>{
  const h=await harness();t.after(()=>h.close());const a=h.client('agent-a');
  const {taskId}=await a.submit({title:'identity',input:'x',expectedHash:hash('X')});
  const claim=await h.active(await a.claim({taskId,leaseMs:700}));
  const port=Number(new URL(h.driverUrl).port);await stop(h.driver);
  for(const suffix of ['','-wal','-shm'])rmSync(join(h.data,'driver.sqlite'+suffix),{force:true});
  await h.startDriver(port);
  await eventually(async()=>(await a.inspect(claim.id)).error==='DRIVER_REPLACED');
  assert.equal((await a.board()).resource.holders[0],claim.id);
  await assert.rejects(h.client('agent-b').claim({taskId}),e=>e.code==='TASK_BUSY');
});
test('cancel stays pending while driver is unreachable and stale writes fail after confirmation', {timeout:10000},async t=>{
  const h=await harness();t.after(()=>h.close());const a=h.client('agent-a'),admin=h.client('admin');
  const {taskId}=await a.submit({title:'cancel',input:'x',expectedHash:hash('X')});
  const claim=await h.active(await a.claim({taskId,leaseMs:5000}));await a.renew(claim.id,6000);
  await assert.rejects(a.cancel(taskId),e=>e.code==='FORBIDDEN');
  const port=Number(new URL(h.driverUrl).port);await stop(h.driver,'SIGKILL');
  assert.equal((await admin.cancel(taskId)).state,'cancelling');
  const board=await a.board();assert.equal(board.tasks[0].state,'cancelling');assert.equal(board.resource.holders[0],claim.id);
  await h.startDriver(port);await eventually(async()=>(await a.board()).tasks[0].state==='cancelled');
  await assert.rejects(a.write(claim,'X'),e=>e.code==='STALE_GRANT');
});
