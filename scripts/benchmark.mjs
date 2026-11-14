// SPDX-License-Identifier: MIT
// Deterministic local fixtures only. Run the same harness against any checkout:
// node scripts/benchmark.mjs /path/to/checkout > evidence/benchmark.json
import {createHash} from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { mkdtempSync, rmSync, statSync,writeFileSync,mkdirSync,readdirSync,readFileSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { execFileSync } from 'node:child_process';
const root=resolve(process.argv[2]??'.');
const moduleAt=path=>import(pathToFileURL(join(root,path)));
const {find}=await moduleAt('src/compact.mjs'),{Store}=await moduleAt('src/store.mjs'),{Collaboration}=await moduleAt('src/collaboration.mjs');
const {listedTools}=await moduleAt('src/mcp.mjs');
const bytes=value=>Buffer.byteLength(JSON.stringify(value));
function measure(fn,runs=31){for(let i=0;i<3;i++)fn();const times=[],cpu=process.cpuUsage();let value;
  for(let i=0;i<runs;i++){const t=performance.now();value=fn();times.push(performance.now()-t);}times.sort((a,b)=>a-b);
  const used=process.cpuUsage(cpu);return {runs,p50Ms:times[Math.floor(runs*.5)],p95Ms:times[Math.floor(runs*.95)],cpuMs:(used.user+used.system)/1000,bytes:bytes(value)};}
const sourceHash=createHash('sha256');
function hashTree(path){for(const item of readdirSync(join(root,path),{withFileTypes:true}).filter(i=>!i.name.startsWith('.')).sort((a,b)=>a.name.localeCompare(b.name))){const file=join(path,item.name);if(item.isDirectory())hashTree(file);else sourceHash.update(file+'\0').update(readFileSync(join(root,file)));}}hashTree('src');
const result={sourceDigest:sourceHash.digest('hex'),revision:execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),node:process.version,platform:process.platform,arch:process.arch,cpu:cpus()[0].model,tools:{count:listedTools().length,bytes:bytes(listedTools())},compaction:[],history:[]};
for(const count of [1,8,32]){const input={participants:[],hosts:Array.from({length:count},(_,h)=>({authority:`host-${h}`,status:'observed',resources:Array.from({length:64},(_,i)=>({id:`host-${h}/resource-${i}`,plugin:'cooperative',state:'unclaimed',enforcement:'cooperative agreement only; no external process or device control'}))}))};
 result.compaction.push({hosts:count,resources:count*64,inputBytes:bytes(input),...measure(()=>find(input))});}
const dir=mkdtempSync(join(tmpdir(),'accord-benchmark-')),s=new Store(join(dir,'store.sqlite'),{leaderMs:1e9});let c;
try {s.provision('a','fixture','worker');s.takeLeadership();c=new Collaboration(s,join(dir,'store.sqlite'));
 const task=s.db.prepare("INSERT INTO tasks(id,title,input,expected_hash,resource,state,created_at,max_attempts) VALUES(?,'fixture','','','artifact','succeeded',0,1)"),claim=s.db.prepare("INSERT INTO claims(id,task_id,resource,actor,generation,state,deadline,created_at) VALUES(?,?,'artifact','a',1,'closed',0,0)");let inserted=0;
 for(const count of [0,10000,100000]){const start=performance.now();s.db.exec('BEGIN');for(;inserted<count;inserted++){task.run('t'+inserted);claim.run('c'+inserted,'t'+inserted);}s.db.exec('COMMIT');
 result.history.push({closedClaims:count,insertMs:performance.now()-start,pending:measure(()=>s.pending()),schedule:measure(()=>{c.schedule();return null;}),board:measure(()=>s.board(),7),currentBoard:measure(()=>s.board(0,{active:true}),7),pagedBoard:measure(()=>s.board(0,{limit:20}),7),databaseBytes:statSync(join(dir,'store.sqlite')).size+statSync(join(dir,'store.sqlite-wal')).size});}
 result.queryPlans={};for(const [name,query] of Object.entries({pending:"SELECT * FROM claims WHERE state IN ('preparing','releasing','revoking') ORDER BY created_at",expired:"SELECT * FROM claims WHERE state IN ('preparing','running') AND deadline<=0",sessions:'SELECT id FROM sessions WHERE closed_at IS NULL AND expires_at<=0',waiting:"SELECT r.*,t.resource FROM reservations r JOIN tasks t ON t.id=r.task_id WHERE t.state='queued' ORDER BY t.created_at,t.rowid"}))result.queryPlans[name]=s.db.prepare('EXPLAIN QUERY PLAN '+query).all().map(r=>r.detail);
 // Keep token fixtures separate from measurements; all content is synthetic.
 const actor={id:'a'};s.provision('b','fixture-b','worker');c.announce(actor,{key:'announce',label:'Fixture sender',activity:'benchmark'});c.announce({id:'b'},{key:'announce',label:'Fixture recipient',activity:'benchmark'});
 const content='Review the reservation recovery tests. The provider confirmed the stop, but restoration remains pending. Keep the resource held until the driver confirms release. Check the recorded generation and report the test result. ';
 for(let i=0;i<100;i++)c.deliver({id:'fixture-message-'+i,from:s.authority+'/a',to:s.authority+'/b',text:(`Message ${i}: `+content.repeat(20)).slice(0,4000),kind:'message'});
 const full=c.inbox({id:'b'}),pages=[];let cursor;
 if(c.inboxPage)do{const page=c.inboxPage({id:'b'},{limit:20,...(cursor?{cursor}:{})});pages.push({request:{name:'accord_inbox',arguments:cursor?{cursor}:{}},response:page});cursor=page.cursor;}while(cursor);
 else pages.push({request:{name:'accord_inbox',arguments:{}},response:full});
 result.inbox={messages:100,legacyBytes:bytes(full),firstPageBytes:bytes(pages[0].response),pages:pages.length,totalWorkflowBytes:bytes(pages)};
 if(process.argv[3]){mkdirSync(resolve(process.argv[3]),{recursive:true});writeFileSync(join(resolve(process.argv[3]),'token-fixtures.json'),JSON.stringify({tools:listedTools(),pages}));}
 result.peakRssBytes=process.resourceUsage().maxRSS*1024;
}finally{c?.close();s.close();rmSync(dir,{recursive:true,force:true});}
console.log(JSON.stringify(result,null,2));
