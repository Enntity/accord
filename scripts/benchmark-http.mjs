// SPDX-License-Identifier: MIT
// Isolated local processes and cooperative fixtures; never connects to installed hosts.
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
const root=resolve(process.argv[2]??'.'),load=p=>import(pathToFileURL(join(root,p)));
const {harness,eventually}=await load('test/helpers.mjs'),{MemoryPanorama}=await load('src/memory-panorama.mjs'),{Store}=await load('src/store.mjs');
const h=await harness(),result={node:process.version,source:root,http:{},memory:[]};
const stats=times=>{times.sort((a,b)=>a-b);return {runs:times.length,p50Ms:times[Math.floor(times.length*.5)],p95Ms:times[Math.floor(times.length*.95)]};};
const measure=async(fn,n=21)=>{for(let i=0;i<3;i++)await fn();const times=[];for(let i=0;i<n;i++){const start=performance.now();await fn();times.push(performance.now()-start);}return stats(times);};
try{const admin=h.client('admin'),c=h.client('agent-a');await c.announce({label:'Benchmark agent',activity:'local fixtures'});
 for(let i=0;i<8;i++)await admin.registerResource({schema:1,id:'slot-'+i,plugin:'cooperative',asset:'fixture:slot-'+i});
 result.http.host=await measure(()=>c.host());result.http.bootstrap=await measure(()=>c.bootstrap());
 result.http.hostBurst16=await measure(()=>Promise.all(Array.from({length:16},()=>c.host())),11);
 result.http.reservationWorkflow=await measure(async()=>{const r=await c.reserve('slot-0');await eventually(async()=>(await c.reservation(r.id)).state==='running');await c.extend(r.id);await c.release(r.id);await eventually(async()=>(await c.reservation(r.id)).state==='released');});
}finally{await h.close();}
const dir=mkdtempSync(join(tmpdir(),'accord-memory-benchmark-')),data=join(dir,'memories');mkdirSync(data);
try{const s=new Store(join(dir,'store.sqlite'),{leaderMs:1e9});s.takeLeadership();const p=new MemoryPanorama(s,{enabled:true,sources:['zcode'],roots:{zcode:data},pollMs:30000});
 try{let written=0;for(const count of [1,128]){for(;written<count;written++)writeFileSync(join(data,'entry-'+written+'.md'),'---\nname: entry-'+written+'\ndescription: Synthetic benchmark memory\n---\n'+'x'.repeat(512*1024));
  const times=[],delays=[];for(let i=0;i<7;i++){const start=performance.now(),timer=new Promise(r=>setTimeout(()=>r(performance.now()-start),0));await p.scan();times.push(performance.now()-start);delays.push(await timer);}
  result.memory.push({files:count,bytesPerFile:512*1024,scan:stats(times),timerDelay:stats(delays)});
 }}finally{p.close();s.close();}
}finally{rmSync(dir,{recursive:true,force:true});}
console.log(JSON.stringify(result,null,2));
