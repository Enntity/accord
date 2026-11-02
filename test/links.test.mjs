// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { superviseLinks } from '../src/connect.mjs';

function links(t,hosts){
  const home=mkdtempSync(join(tmpdir(),'accord-links-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const root=join(home,'.config','accord','links');mkdirSync(root,{recursive:true});
  for(const host of hosts)writeFileSync(join(root,host+'.json'),JSON.stringify({host}));
  return {home,root};
}

test('supervision restores every saved link and skips nothing on success',async t=>{
  const {home}=links(t,['spark-a','spark-b']),calls=[];let clock=0;
  const supervisor=superviseLinks({home,data:'/data',connect:async o=>calls.push(o.host),now:()=>clock,start:false});
  await supervisor.tick();assert.deepEqual(calls.sort(),['spark-a','spark-b']);
  clock+=30000;await supervisor.tick();assert.equal(calls.length,4);
  supervisor.stop();
});

test('a failing host backs off without delaying a healthy one',async t=>{
  const {home}=links(t,['down','up']),calls=[];let clock=0;
  const connect=async o=>{calls.push(o.host);if(o.host==='down')throw Error('unreachable');};
  const supervisor=superviseLinks({home,data:'/data',connect,now:()=>clock,start:false});
  await supervisor.tick();assert.deepEqual(calls.sort(),['down','up']);
  calls.length=0;clock+=30000;await supervisor.tick();assert.deepEqual(calls,['up']);
  calls.length=0;clock+=30000;await supervisor.tick();assert.deepEqual(calls.sort(),['down','up']);
  assert.equal(supervisor.status().down.failures,2);
  supervisor.stop();
});

test('backoff is capped and a recovered host returns to the normal interval',async t=>{
  const {home}=links(t,['flaky']);let clock=0,healthy=false;
  const connect=async()=>{if(!healthy)throw Error('unreachable');};
  const supervisor=superviseLinks({home,data:'/data',connect,now:()=>clock,start:false});
  for(let i=0;i<12;i++){await supervisor.tick();clock+=300000;}
  assert.ok(supervisor.status().flaky.next-clock<=300000,'waits at most five minutes');
  healthy=true;await supervisor.tick();assert.equal(supervisor.status().flaky.failures,0);
  supervisor.stop();
});

test('a removed link stops being reconnected, and a missing directory is harmless',async t=>{
  const {home,root}=links(t,['gone']),calls=[];let clock=0;
  const supervisor=superviseLinks({home,data:'/data',connect:async o=>calls.push(o.host),now:()=>clock,start:false});
  await supervisor.tick();rmSync(join(root,'gone.json'));clock+=30000;await supervisor.tick();assert.equal(calls.length,1);
  rmSync(root,{recursive:true});await supervisor.tick();assert.equal(calls.length,1);
  supervisor.stop();
});

test('overlapping ticks never run a second connect for the same pass',async t=>{
  const {home}=links(t,['slow']);let active=0,peak=0,release;
  const connect=()=>new Promise(r=>{peak=Math.max(peak,++active);release=()=>{active--;r();};});
  const supervisor=superviseLinks({home,data:'/data',connect,now:()=>0,start:false});
  const first=supervisor.tick();await supervisor.tick();release();await first;
  assert.equal(peak,1);supervisor.stop();
});
