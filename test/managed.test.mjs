import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { harness,eventually,stop,delay } from './helpers.mjs';
import { createHttp,listen,readBody } from '../src/common.mjs';

test('managed provider: actual old process stops and restoration succeeds before a second agent receives ownership, including crash recovery', {timeout:30000},async t=>{
  const h=await harness();t.after(()=>h.close());
  let child=null,blockStop=false,blockRestore=false,starts=0;const log=[];
  const provider=createHttp(async(req,res,url)=>{
    assert.equal(req.headers.authorization,'Bearer provider-test');const b=await readBody(req),action=url.pathname.slice(1);
    if(action==='start'){
      if(!child){child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});starts++;await once(child,'spawn');}
    }
    if(action==='stop'){
      if(blockStop)throw Error('Workload stop unknown');
      if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await once(child,'exit');log.push('stopped');}
      child=null;
    }
    if(action==='restore'&&blockRestore)throw Error('Restore health failed');
    log.push(action+':'+b.generation);return {...b,[action]:true};
  });
  const endpoint=await listen(provider);t.after(async()=>{if(child)await stop(child);await new Promise(r=>provider.close(r));});
  const tokenFile=join(h.data,'provider.token');writeFileSync(tokenFile,'provider-test',{mode:0o600});
  await h.client('admin').registerResource({schema:1,id:'models',asset:'fixture:models',plugin:'managed-http',endpoint,tokenFile});
  const a=h.client('agent-a'),b=h.client('agent-b');const ra=await a.reserve('models',{leaseMs:10000});
  await eventually(async()=>(await a.reservation(ra.id)).state==='running');
  await a.collaborate('start',{id:ra.id,key:'start'});assert.equal(starts,1);
  const rb=await b.reserve('models',{leaseMs:10000});
  blockStop=true;const port=Number(new URL(h.url).port);await stop(h.server,'SIGKILL');await delay(h.leaderMs+50);await h.startServer(port);
  await delay(500);assert.notEqual((await b.reservation(rb.id)).state,'running');assert(child&&child.exitCode===null);
  blockStop=false;blockRestore=true;await eventually(()=>log.includes('stopped'));
  assert.notEqual((await b.reservation(rb.id)).state,'running');
  blockRestore=false;await eventually(async()=>(await b.reservation(rb.id)).state==='running');
  const prepare2=log.findIndex(x=>/^prepare:2$/.test(x));assert(prepare2>log.indexOf('stopped'));assert(prepare2>log.indexOf('restore:1'));
  assert.equal(starts,1);await assert.rejects(a.collaborate('start',{id:ra.id,key:'again'}));
  await b.release(rb.id);await eventually(async()=>(await b.reservation(rb.id)).state==='released');
});
