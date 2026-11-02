// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCollectors,parseNvidia,runProbe } from '../src/telemetry-collectors.mjs';
import { createTelemetry,tesseraVitals,lloomMachineInput } from '../src/telemetry.mjs';
import { initialize,configuration } from '../src/config.mjs';
import { driverHost } from '../src/driver-host.mjs';
import { coordinator } from '../src/server.mjs';
import { listen,request,token } from '../src/common.mjs';
import { AccordClient } from '../src/client.mjs';
import { toolCatalog,mcpAdapter } from '../src/mcp.mjs';
import { delay,eventually } from './helpers.mjs';

const sample={cpu:{utilization:50,logicalCpus:8,loadAverage:[1,2,3]},memory:{pressureUtilization:25,totalBytes:2**34},gpu:{utilization:80,temperatureC:60,powerDrawW:40,devices:[{name:'Fixture GPU'}]},thermal:{hottestC:65},collectors:[{id:'fixture',status:'available'}]};
test('single-flight caches are lazy, independent, memory-only, and retain explicitly stale last-good data',async()=>{
  let time=100,calls=0,metadataCalls=0,fail=false;
  const collectors={snapshot:async()=>{calls++;await delay(10);if(fail)throw Error('private diagnostic');return sample;},metadata:async()=>{metadataCalls++;return {devices:[],collectors:[]};}};
  const service=createTelemetry({authority:'host',collectors,now:()=>time,clock:()=>time,liveTtlMs:100,metadataTtlMs:1000});
  assert.equal(calls,0);
  const responses=await Promise.all(Array.from({length:20},()=>service.telemetry()));
  assert.equal(calls,1);assert(responses.every(r=>r.sampledAt===100&&r.status==='available'));
  time=150;assert.equal((await service.telemetry()).ageMs,50);assert.equal(calls,1);
  await service.metadata();await service.metadata();assert.equal(metadataCalls,1);
  time=201;fail=true;const failed=await service.telemetry();assert.equal(failed.status,'stale');assert.equal(failed.reason,'collector-failed');assert.deepEqual(failed.host,sample);
  await service.telemetry();assert.equal(calls,2);assert.equal(metadataCalls,1);
  time=302;fail=false;assert.equal((await service.telemetry()).status,'available');assert.equal(calls,3);
});
test('hung collectors have bounded responses and never multiply probes; late completion can recover',async()=>{
  let finish,calls=0;
  const service=createTelemetry({timeoutMs:20,collectors:{snapshot:()=>{calls++;return new Promise(r=>finish=r);},metadata:async()=>({})}});
  const first=await service.telemetry();assert.equal(first.status,'unavailable');assert.equal(first.host,null);assert.equal(first.reason,'collector-timeout');
  await Promise.all([service.telemetry(),service.telemetry()]);assert.equal(calls,1);
  finish(sample);await delay(1);assert.equal((await service.telemetry()).status,'available');
});
test('NVIDIA parser preserves missing fields, multiple devices and quoted names',()=>{
  const devices=parseNvidia('0, "GPU, One", 80, 1024, 16384, 64, 120.5, P0, 1200, 9000\n1, Two, [N/A], N/A, N/A, N/A, N/A, N/A, N/A, N/A\nbad,row');
  assert.equal(devices.length,2);assert.equal(devices[0].name,'GPU, One');assert.equal(devices[1].utilization,null);assert.equal(devices[1].temperatureC,null);
  assert.equal(parseNvidia('0, GPU, Infinity, -1, 100, 999, 1, P0, 2000, 3000')[0].utilization,null);
});
const missing=()=>{throw Object.assign(Error('absent'),{code:'ENOENT'});};
function fixture({platform='linux',fileMap={},dirMap={},run=async()=>missing()}={}){
  let ticks=100;
  const system={cpus:()=>[{model:'Fixture CPU',times:{user:ticks,idle:ticks*3}}],totalmem:()=>8192000,freemem:()=>1024000,loadavg:()=>[1,2,3],uptime:()=>100,hostname:()=> 'fixture',release:()=> 'fixture-os'};
  const files={readFile:async p=>p in fileMap?fileMap[p]:missing(),readdir:async p=>dirMap[p]??[],statfs:async()=>({bsize:4096,blocks:100,bavail:50,bfree:60})};
  return {collectors:createCollectors({platform,arch:'arm64',system,files,run,nativeHelper:'/fixture/helper'}),tick:()=>{ticks+=100;}};
}
test('Linux fixtures cover CPU warmup, MemAvailable, NVIDIA clocks, board thermal, and counters',async()=>{
  const f=fixture({fileMap:{'/proc/meminfo':'MemTotal: 8000 kB\nMemAvailable: 6000 kB\n','/sys/class/thermal/thermal_zone0/temp':'42000','/sys/class/thermal/thermal_zone0/type':'board','/sys/class/net/eth0/statistics/rx_bytes':'1024','/sys/class/net/eth0/statistics/tx_bytes':'2048','/sys/class/net/eth0/speed':'10000','/sys/class/net/eth0/operstate':'up'},dirMap:{'/sys/class/thermal':['thermal_zone0'],'/sys/class/net':['eth0']},run:async(_c,args)=>({stdout:args[0].includes('uuid')?'0, GPU-fixture, NVIDIA GB10, N/A, 12.1, 580.1, 0000:01:00.0':'0, NVIDIA GB10, 70, N/A, N/A, 52, 45, P0, 1500, 4000'})});
  const a=await f.collectors.snapshot();assert.equal(a.cpu.utilization,null);f.tick();const b=await f.collectors.snapshot();assert.equal(b.cpu.utilization,25);
  assert.equal(b.memory.availableBytes,6144000);assert.equal(b.memory.pressureUtilization,25);assert.equal(b.gpu.devices[0].smClockMhz,1500);assert.equal(b.gpu.memoryTotalMb,null);
  assert.equal(b.thermal.hottestC,42);assert.equal(b.network.interfaces[0].rxBytes,1024);
  const m=await f.collectors.metadata();assert.equal(m.memory.model,'unified');assert.equal(m.devices[0].computeCapability,'12.1');assert.equal(m.devices[0].memoryTotalMb,null);
});
test('Mac fixtures reuse page-based memory and native GPU/thermal values without inventing GPU memory',async()=>{
  const f=fixture({platform:'darwin',run:async cmd=>({stdout:cmd==='/fixture/helper'?JSON.stringify({schema:1,gpuUtilization:42,hottestDieC:48}):'page size of 4096\nPages free: 100\nPages inactive: 200\nPages speculative: 300\nPages purgeable: 400'})});
  const s=await f.collectors.snapshot();assert.equal(s.gpu.utilization,42);assert.equal(s.thermal.hottestC,48);assert.equal(s.gpu.memoryTotalMb,null);assert.equal(s.memory.availableBytes,4096000);
  assert.equal((await f.collectors.metadata()).devices.length,2);
  const unavailable=await fixture({platform:'darwin'}).collectors.snapshot();assert.equal(unavailable.gpu,null);assert.equal(unavailable.thermal.hottestC,null);assert.equal(unavailable.memory.source,'os-freemem');
});
test('AMD DRM fixtures keep VRAM and GTT distinct and convert sensor units',async()=>{
  const base='/sys/class/drm/card0/device',f=fixture({dirMap:{'/sys/class/drm':['card0','card0-DP-1'],[base+'/hwmon']:['hwmon0']},fileMap:{[base+'/vendor']:'0x1002',[base+'/device']:'0x150e',[base+'/gpu_busy_percent']:'37',[base+'/mem_info_vram_used']:'1048576',[base+'/mem_info_vram_total']:'2097152',[base+'/mem_info_gtt_used']:'3145728',[base+'/mem_info_gtt_total']:'4194304',[base+'/hwmon/hwmon0/temp1_input']:'55000',[base+'/hwmon/hwmon0/power1_average']:'25000000'}});
  const s=await f.collectors.snapshot(),g=s.gpu.devices[0];assert.equal(g.utilization,37);assert.equal(g.memoryUsedMb,1);assert.equal(g.sharedMemoryUsedMb,3);assert.equal(g.temperatureC,55);assert.equal(g.powerDrawW,25);
});
test('Tessera conversion uses its field names, fractions, GiB and hides stale samples',()=>{
  const s={host:sample,stale:false},v=tesseraVitals(s);assert.equal(v.cpu,.5);assert.equal(v.memory,.25);assert.equal(v.memoryTotalGB,16);assert.equal(v.temperature,60);assert.equal(v.hottestSensor,65);assert.equal(v.gpuPowerW,40);assert.equal(v.load,1);
  assert.equal(tesseraVitals({...s,stale:true}),null);
});
test('external probes kill a hung child within their deadline',async()=>{
  const start=Date.now();await assert.rejects(runProbe(process.execPath,['-e','setInterval(()=>{},1000)']));assert(Date.now()-start<3000);
});
async function hostFixture(t,name){
  const data=mkdtempSync(join(tmpdir(),'accord-telemetry-'));initialize(data,{fixtures:true});const config=configuration(data);let calls=0;
  const driver=driverHost(data,config.readToken('driver-control')),driverUrl=await listen(driver.server,0);
  const service=coordinator({db:join(data,'coordinator.sqlite'),claimSecret:config.readToken('claim-secret'),driverUrl,driverToken:config.readToken('driver-control'),driverInstance:config.driverInstance,hostName:name,
    telemetryCollectors:{snapshot:async()=>{calls++;await delay(20);return {...sample,fixture:name};},metadata:async()=>({fixture:name,collectors:[]})}});
  const url=await listen(service.server,0);let closed=false;
  const close=async()=>{if(!closed){closed=true;await service.close();}};t.after(async()=>{await close();driver.server.closeAllConnections();await new Promise(r=>driver.server.close(r));driver.close();rmSync(data,{recursive:true,force:true});});
  const counts=()=>Object.fromEntries(['events','commands','actors','participants','claims','reservations'].map(table=>[table,service.store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n]));
  return {data,service,url,config,counts,calls:()=>calls,close,client:new AccordClient(url,config.readToken('agent-a'))};
}
test('authenticated direct and forwarded telemetry coalesce without state writes; offline and changed identities fail closed',async t=>{
  const a=await hostFixture(t,'a'),b=await hostFixture(t,'b'),x=token(),y=token();
  for(const [local,remote,inbound,outbound] of [[a,b,x,y],[b,a,y,x]])await request(local.url,local.config.readToken('admin'),'/v1/links',{key:randomUUID(),authority:remote.config.authority,url:remote.url,inbound,outbound});
  const reservation=await b.client.reserve('artifact',{leaseMs:30000});
  await eventually(async()=>(await b.client.reservation(reservation.id)).state==='running');
  const claimBefore=b.service.store.db.prepare('SELECT * FROM claims').all();
  const beforeA=a.counts(),beforeB=b.counts();
  const responses=await Promise.all(Array.from({length:12},()=>a.client.telemetry(b.config.authority)));
  assert(responses.every(r=>r.authority===b.config.authority&&r.host.fixture==='b'));assert.equal(b.calls(),1);assert.equal(a.calls(),0);
  assert.equal((await a.client.metadata(b.config.authority)).machine.fixture,'b');
  assert.equal((await request(b.url,b.config.readToken('discovery'),'/v1/host/telemetry')).host.fixture,'b');
  await assert.rejects(request(b.url,'wrong','/v1/host/telemetry'),{code:'FORBIDDEN'});
  await assert.rejects(request(b.url,b.config.readToken('discovery'),'/v1/federation',{operation:'telemetry'}),{code:'FORBIDDEN'});
  assert.deepEqual(a.counts(),beforeA);assert.deepEqual(b.counts(),beforeB);assert.deepEqual(b.service.store.db.prepare('SELECT * FROM claims').all(),claimBefore);
  a.service.store.db.prepare('UPDATE links SET authority=? WHERE authority=?').run('wrong-host',b.config.authority);
  await assert.rejects(a.client.telemetry('wrong-host'),{code:'PEER_IDENTITY_CHANGED'});
  a.service.store.db.prepare('UPDATE links SET authority=? WHERE authority=?').run(b.config.authority,'wrong-host');
  await b.close();await assert.rejects(a.client.telemetry(b.config.authority));assert.equal(a.calls(),0);
});

test('MCP exposes telemetry and metadata through the enrolled session',async t=>{
  const h=await hostFixture(t,'mcp'),profile=join(h.data,'profile.json');
  writeFileSync(profile,JSON.stringify({schema:1,authority:h.config.authority,url:h.url,enrollmentFile:join(h.data,'bootstrap.token'),discoveryFile:join(h.data,'discovery.token')}));
  const old=process.env.ACCORD_SESSION_FILE;delete process.env.ACCORD_SESSION_FILE;
  const adapter=mcpAdapter(profile);
  try{
    assert(toolCatalog.some(t=>t.name==='accord_telemetry'));
    await adapter.call('accord_bootstrap',{});
    assert.equal((await adapter.call('accord_telemetry',{})).host.fixture,'mcp');
    assert.equal((await adapter.call('accord_machine',{})).machine.fixture,'mcp');
  }finally{await adapter.close();if(old)process.env.ACCORD_SESSION_FILE=old;}
});

test('LLooM machine input preserves hardware units and canonical device IDs without inventing VRAM',()=>{
  const machine={platform:'linux',arch:'arm64',cpu:{model:'Fixture',logicalCpus:20},memory:{totalBytes:2**37},devices:[{id:'nvidia:0',vendor:'nvidia',memoryTotalMb:null},{id:'nvidia:1',vendor:'nvidia',memoryTotalMb:16384}]};
  const value=lloomMachineInput({machine,stale:false});assert.equal(value.totalMemoryGb,128);assert.equal(value.devices[0].id,'cuda:0');assert.equal(value.devices[0].memoryGb,undefined);assert.equal(value.devices[1].memoryGb,16);assert.equal(lloomMachineInput({machine,stale:true}),null);
});
