import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness, eventually, link } from './helpers.mjs';
import { createHttp, listen, readBody, request } from '../src/common.mjs';
import { createWorkloads, workloadView, parseComputeApps, parseDockerPs, containerOf } from '../src/workloads.mjs';
import { workloadLines, resources as compactResources, reservation as compactReservation } from '../src/compact.mjs';
import { hash } from '../src/common.mjs';

const GB10='1928970, /usr/local/bin/spark, 90706, GPU-1111\n55, /opt/build/worker, [N/A], GPU-2222\n';
const FULL='a'.repeat(64);
const dockerLine=o=>JSON.stringify(o);

test('workload collector: GB10 output, container folding, unavailable docker',async t=>{
  const files={readFile:async p=>{
    if(p==='/proc/1928970/cgroup')return '0::/system.slice/docker-'+FULL+'.scope\n';
    throw Object.assign(new Error('gone'),{code:'ENOENT'});
  }};
  const run=async(cmd,args)=>{
    if(cmd==='nvidia-smi')return {stdout:GB10};
    if(cmd==='docker')return {stdout:dockerLine({ID:FULL,Names:'sq27-test',Image:'img/sq27:latest',Status:'Up 3 days',Labels:'io.lloom.runtime-spec-sha256=abc,io.enntity.owner=labeeb,com.docker.other=x'})+'\n'};
    throw Error('unexpected '+cmd);
  };
  const w=createWorkloads({platform:'linux',run,files,now:()=>1000});
  const s=await w.collect();
  assert.equal(s.gpu,'available');assert.equal(s.docker,'available');
  assert.equal(s.containers.length,1);
  const c=s.containers[0];
  assert.equal(c.id,FULL.slice(0,12));assert.equal(c.name,'sq27-test');
  assert.equal(c.gpuMemoryMiB,90706);assert.deepEqual(c.gpuProcesses,[1928970]);
  assert.deepEqual(c.labels,{'io.lloom.runtime-spec-sha256':'abc','io.enntity.owner':'labeeb'});
  assert.deepEqual(s.processes,[{pid:55,command:'worker',gpuMemoryMiB:null,container:null}]);
});

test('workload collector: missing docker and nvidia-smi degrade, never fail',async t=>{
  const missing=Object.assign(new Error('spawn'),{code:'ENOENT'});
  const w=createWorkloads({platform:'linux',run:async()=>{throw missing},files:{readFile:async()=>{throw missing}}});
  const s=await w.collect();
  assert.equal(s.gpu,'unavailable');assert.equal(s.docker,'unavailable');
  assert.deepEqual(s.containers,[]);assert.deepEqual(s.processes,[]);
  const mac=await createWorkloads({platform:'darwin',now:()=>1}).collect();
  assert.equal(mac.reason,'platform');assert.equal(mac.gpu,'unavailable');
});

test('workload collector: process without a cgroup match stays host-level',async()=>{
  const s=await createWorkloads({platform:'linux',
    run:async cmd=>cmd==='nvidia-smi'?{stdout:'7, /usr/bin/x, 10, GPU-9\n'}:{stdout:dockerLine({ID:FULL,Names:'c1',Image:'i',Status:'Up',Labels:''})+'\n'},
    files:{readFile:async()=>'0::/user.slice\n'}}).collect();
  assert.equal(s.processes.length,1);assert.equal(s.processes[0].container,null);
  assert.equal(s.containers[0].gpuProcesses.length,0);
});

test('workload-report validation: admin, caps, replacement, TTL',t=>{
  let at=1000;
  const w=createWorkloads({now:()=>at});
  const admin={role:'admin'},worker={role:'worker'};
  assert.throws(()=>w.report(worker,{source:'lloom',items:[]}),{code:'FORBIDDEN'});
  assert.throws(()=>w.report(admin,{source:'BAD SOURCE',items:[]}),{code:'INVALID_INPUT'});
  assert.throws(()=>w.report(admin,{source:'lloom',ttlMs:5,items:[]}),{code:'INVALID_INPUT'});
  assert.throws(()=>w.report(admin,{source:'lloom',items:Array(129).fill({id:'x',state:'running'})}),{code:'INVALID_INPUT'});
  assert.throws(()=>w.report(admin,{source:'lloom',items:[{id:'x',state:'exploded'}]}),{code:'INVALID_INPUT'});
  assert.throws(()=>w.report(admin,{source:'lloom',items:[{id:'x'.repeat(200),state:'running'}]}),{code:'INVALID_INPUT'});
  w.report(admin,{source:'lloom',items:[{id:'r1',state:'running'}]});
  w.report(admin,{source:'lloom',items:[{id:'r2',state:'suspended',since:5,by:'cli'}]});
  assert.deepEqual(w.activeReports()[0].items.map(i=>i.id),['r2'],'a report replaces the same source');
  at+=180001;assert.equal(w.activeReports().length,0,'report expired');
  w.report(admin,{source:'lloom',ttlMs:10000,items:[{id:'r3',state:'running'}]});
  at+=9000;assert.equal(w.activeReports().length,1);
});

test('workloadView: container annotation, suspended runtime, owner precedence',()=>{
  const samples=new Map([['B',{hostname:'spark-b',authority:'B',workloads:{containers:[
      {id:'aa',name:'unmatched-c',image:'i',status:'Up',labels:{},gpuMemoryMiB:512,gpuProcesses:[1]},
      {id:'bb',name:'sq27-test',image:'i',status:'Up',labels:{},gpuMemoryMiB:2048,gpuProcesses:[2]},
      {id:'cc',name:'declared-c',image:'i',status:'Up',labels:{'io.enntity.owner':'labeeb'},gpuMemoryMiB:null,gpuProcesses:[]},
      {id:'dd',name:'plain-c',image:'i',status:'Up',labels:{},gpuMemoryMiB:null,gpuProcesses:[]}],
    processes:[{pid:9,command:'spark',gpuMemoryMiB:10,container:null}]}}]]);
  const reports=[{authority:'B',items:[
    {id:'parakeet',container:'sq27-test',state:'running',model:'m1',by:'accord:labeeb'},
    {id:'drama-3',state:'suspended',since:1700,by:'cli'},
    {id:'quiet',state:'running'}]}];
  const holder={claim:'claim1',generation:4,label:'labeeb',address:'A/labeeb'};
  const auth='A';
  const v=workloadView({wanted:new Map([['spark-b','B']]),samples,reports,holder,authority:auth,now:1});
  assert.equal(v.hosts[0].status,'observed');
  const byName=Object.fromEntries(v.items.map(i=>[i.name,i]));
  assert.equal(byName['sq27-test'].runtime,'parakeet');assert.equal(byName['sq27-test'].owner,'LLooM runtime parakeet');assert.equal(byName['sq27-test'].ownerSource,'lloom');assert.equal(byName['sq27-test'].by,'accord:labeeb','by stays its own field');
  assert.equal(byName['declared-c'].owner,'labeeb');assert.equal(byName['declared-c'].ownerSource,'declared');
  assert.equal(byName['plain-c'].ownerSource,'unknown');
  assert.equal(byName['spark'].kind,'process');
  assert.equal(byName['drama-3'].kind,'runtime');assert.equal(byName['drama-3'].state,'suspended');
  assert.equal(byName['drama-3'].owner,'LLooM runtime drama-3');assert.equal(byName['drama-3'].ownerSource,'lloom');assert.equal(byName['drama-3'].by,'cli');
  assert.equal(byName['quiet'],undefined,'unmatched running report items are not listed');
});

test('workloadView: stopped report items are not listed; own host wins a duplicate report',()=>{
  const samples=new Map([['B',{hostname:'spark-b',authority:'B',workloads:{containers:[],processes:[]}}],
    ['HEAD',{hostname:'spark-head',authority:'HEAD',workloads:{containers:[],processes:[]}}]]);
  const reports=[
    {authority:'HEAD',items:[{id:'parakeet',node:'spark-b',state:'suspended',since:1,by:'accord:x'},{id:'idle-35',node:'spark-b',state:'stopped'},{id:'parakeet',state:'failed'}]},
    {authority:'B',items:[{id:'parakeet',state:'suspended',since:2,by:'cli'}]}];
  const v=workloadView({wanted:new Map([['spark-b','B'],['spark-head','HEAD']]),samples,reports,holder:null,authority:'A',now:1});
  const byName=Object.fromEntries(v.items.map(i=>[i.name,i]));
  assert.equal(byName['idle-35'],undefined,'on-demand stopped runtimes stay out of the view');
  const onB=v.items.filter(i=>i.host==='spark-b'&&i.name==='parakeet');
  assert.equal(onB.length,1,'one item per host and runtime id');
  assert.equal(onB[0].state,'suspended');
  assert.equal(onB[0].by,'cli',"the host's own report wins over the head's duplicate");
  assert.equal(onB[0].owner,'LLooM runtime parakeet');
});

test('workloadView: reservation prefix derives from the resource authority, not the caller',()=>{
  // A remote resource on B: its holder claim belongs to B's authority, so the
  // binding prefix is hash(B/claim/generation), never the caller's.
  const holder={claim:'rc',generation:7,label:'holder',address:'A/h'};
  const prefixB=`accord-${hash('B/rc/7').slice(0,20)}-`;
  const prefixA=`accord-${hash('A/rc/7').slice(0,20)}-`;
  const samples=new Map([['B',{hostname:'spark-b',authority:'B',workloads:{containers:[
      {id:'m',name:prefixB+'job',image:'i',status:'Up',labels:{},gpuProcesses:[]},
      {id:'n',name:prefixA+'wrong',image:'i',status:'Up',labels:{},gpuProcesses:[]}],processes:[]}}]]);
  const v=workloadView({wanted:new Map([['spark-b','B']]),samples,reports:[],holder,authority:'B',now:1});
  const byName=Object.fromEntries(v.items.map(i=>[i.name,i]));
  assert.equal(byName[prefixB+'job'].owner,'holder');assert.equal(byName[prefixB+'job'].ownerSource,'reservation');
  assert.equal(byName[prefixA+'wrong'].ownerSource,'unknown','a caller-authority prefix does not bind');
});

test('workloadView: reservation prefix beats a matching report; unknown host',()=>{
  const holder={claim:'c9',generation:3,label:'holder-label',address:'A/agent'};
  const prefix=`accord-${hash('A/c9/3').slice(0,20)}-`;
  const samples=new Map([['B',{hostname:'spark-b',authority:'B',workloads:{containers:[
      {id:'z',name:prefix+'job',image:'i',status:'Up',labels:{'io.enntity.owner':'claimed'},gpuMemoryMiB:1,gpuProcesses:[]},
      {id:'y',name:'other',image:'i',status:'Up',labels:{'io.enntity.job':'jobname'},gpuProcesses:[]}],
    processes:[]}}]]);
  const reports=[{authority:'B',items:[{id:'rt',container:prefix+'job',state:'running',by:'cli'}]}];
  const v=workloadView({wanted:new Map([['spark-b','B'],['ghost',null]]),samples,reports,holder,authority:'A',now:1});
  const byName=Object.fromEntries(v.items.map(i=>[i.name,i]));
  assert.equal(byName[prefix+'job'].owner,'holder-label');assert.equal(byName[prefix+'job'].ownerSource,'reservation');
  assert.equal(byName['other'].owner,'jobname');assert.equal(byName['other'].ownerSource,'declared');
  assert.deepEqual(v.hosts.find(h=>h.name==='ghost'),{name:'ghost',status:'unavailable',reason:'host not linked'});
});

test('compact workloads: one line per item, capped at eight',()=>{
  const items=[
    {host:'h',kind:'container',name:'sq27-test',gpuMemoryMiB:90726,ownerSource:'unknown'},
    {host:'h',kind:'runtime',name:'parakeet-nemo',state:'suspended',since:Date.UTC(2026,10,18,20,33),by:'cli',ownerSource:'lloom',owner:'cli'}];
  const lines=workloadLines({items});
  assert.equal(lines[0],'sq27-test · container · 88.6 GiB GPU · owner unknown');
  assert.equal(lines[1],'parakeet-nemo · runtime · suspended since 2026-11-18 20:33Z by cli','runtime lines never repeat the owner');
  const many=workloadLines({items:Array(10).fill(items[0])});
  assert.equal(many.length,9);assert.equal(many[8],'+2 more');
  const r=compactResources([{id:'A/x',localId:'x',state:'held',holder:{label:'l'},hosts:['h'],workloads:{items}}]);
  assert.deepEqual(r.resources[0].workloads,lines);
  assert.equal(compactReservation({id:'r1',workloads:{items}}).workloads[0],lines[0]);
});

async function managedProvider(t){
  const provider=createHttp(async(req,res,url)=>{
    const b=await readBody(req),action=url.pathname.slice(1);
    if(action==='availability')return {available:true};
    return {...b,[action]:true};
  });
  const endpoint=await listen(provider);t.after(()=>new Promise(r=>provider.close(r)));
  return endpoint;
}

test('linked hosts: resources gain workload observations through link files and descriptor names', {timeout:30000},async t=>{
  const linksDir=mkdtempSync(join(tmpdir(),'accord-links-'));t.after(()=>rmSync(linksDir,{recursive:true,force:true}));
  const a=await harness({serverExtra:['--name','mac-test'],serverEnv:{ACCORD_LINKS_DIR:linksDir}});
  const b=await harness({serverExtra:['--name','spark-test-b']});
  t.after(()=>a.close());t.after(()=>b.close());
  const links=await link(a,b);
  // B answers telemetry as 'spark-test-b'; the link file maps the SSH alias 'spark-b'.
  writeFileSync(join(linksDir,'spark-b.json'),JSON.stringify({host:'spark-b',authority:links.bb}));
  // LLooM reports its runtimes to B's coordinator.
  await b.client('admin').collaborate('workload-report',{source:'lloom',ttlMs:180000,items:[
    {id:'parakeet-nemo',kind:'runtime',node:'spark-b',container:'parakeet-ctr',state:'running',model:'parakeet',by:'cli'},
    {id:'drama-3',kind:'runtime',node:'spark-b',state:'suspended',since:1700000000000,by:'cli',operationId:'op-7'},
    {id:'headjob',kind:'runtime',state:'suspended',since:1690000000000},
    {id:'idle-lane',kind:'runtime',state:'stopped',since:1690000000000}]});
  const tele=await b.client('admin').telemetry();
  assert.deepEqual(tele.workloads.reports.map(r=>r.items.length),[4]);
  const endpointA=await managedProvider(t),endpointB=await managedProvider(t);
  const tokenA=join(a.data,'provider.token'),tokenB=join(b.data,'provider.token');
  writeFileSync(tokenA,'x',{mode:0o600});writeFileSync(tokenB,'x',{mode:0o600});
  await a.client('admin').registerResource({schema:1,id:'gpu-a',asset:'fixture:gpu-a',plugin:'managed-http',endpoint:endpointA,tokenFile:tokenA,hosts:['spark-b']});
  await b.client('admin').registerResource({schema:1,id:'gpu-b',asset:'fixture:gpu-b',plugin:'managed-http',endpoint:endpointB,tokenFile:tokenB,hosts:['spark-test-b']});
  // Link-file resolution: A's resource names 'spark-b', mapped by the link file.
  const view=await eventually(async()=>{const r=(await a.client('admin').collaborate('resources',{})).resources.find(x=>x.localId==='gpu-a');return r?.workloads?.hosts?.[0]?.status==='observed'?r:null;});
  const wl=view.workloads;
  assert.equal(wl.hosts[0].name,'spark-b');assert.equal(wl.hosts[0].authority,links.bb);
  assert.equal(wl.note,'Observed on the host; not ownership');
  const names=Object.fromEntries(wl.items.map(i=>[i.name,i]));
  assert.equal(names['drama-3'].kind,'runtime');assert.equal(names['drama-3'].state,'suspended');assert.equal(names['drama-3'].by,'cli');
  assert.equal(names['headjob'].kind,'runtime','a node-less item belongs to its reporting host');
  assert.equal(names['headjob'].owner,'LLooM runtime headjob');
  assert.equal(names['idle-lane'],undefined,'stopped runtimes are not listed');
  // The forwarded view of B's own resource is enriched on A's side.
  const remote=(await a.client('admin').collaborate('resources',{},links.bb)).resources.find(x=>x.localId==='gpu-b');
  assert.equal(remote.workloads.hosts[0].name,'spark-test-b');
  assert.equal(remote.workloads.hosts[0].status,'observed','descriptor-name resolution: B hostname is spark-test-b');
  // The federation handler itself does not enrich — no recursion.
  const raw=await request(b.url,links.y,'/v1/federation',{operation:'resources',actor:'agent-a',args:{}});
  assert.equal(raw.value.resources.find(x=>x.localId==='gpu-b').workloads,undefined);
  // A worker credential cannot post reports; the admin result carries workloads.
  await assert.rejects(b.client('agent-a').collaborate('workload-report',{source:'lloom',items:[]}),{code:'FORBIDDEN'});
  // Mutations never pay the observation cost: reserve answers carry no
  // workloads field because enrichment never runs, so no telemetry is fetched.
  const held=await a.client('admin').collaborate('reserve',{resource:'gpu-a',key:'workload-gate',purpose:'check',durationMs:60000});
  assert.equal(held.workloads,undefined);
  await a.client('admin').collaborate('release',{id:held.id,key:'workload-gate-release'}).catch(()=>{});
});

