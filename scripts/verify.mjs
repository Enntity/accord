// SPDX-License-Identifier: MIT
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runRecoveryDemo } from '../demo/recovery.mjs';
import { runProcessDemo } from '../demo/process-recovery.mjs';
import { runBootstrapDemo } from '../demo/bootstrap.mjs';

mkdirSync('evidence', {recursive:true});
writeFileSync('evidence/qualification.json',JSON.stringify({status:'running',at:new Date().toISOString()})+'\n');
function snapshot(){
  const sources={};
  function record(dir){for(const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    if(entry.name.startsWith('.'))continue;const path=join(dir,entry.name);if(entry.isDirectory())record(path);else sources[path]=createHash('sha256').update(readFileSync(path)).digest('hex');
  }}
  for(const dir of ['src','scripts','demo','test','skills','vendor','native'])record(dir);
  sources['package.json']=createHash('sha256').update(readFileSync('package.json')).digest('hex');return sources;
}
const sourcesBefore=snapshot();
process.on('exit',code=>{if(code!==0)writeFileSync('evidence/qualification.json',JSON.stringify({status:'failed',at:new Date().toISOString(),exitCode:code})+'\n');});
const results=[];
for(const [name,args] of [
  ['syntax',['scripts/check.mjs']],
  ['tests',['--test','--test-concurrency=1',...readdirSync('test').filter(f=>!f.startsWith('.')&&f.endsWith('.test.mjs')).sort().map(f=>join('test',f))]]
]) {
  const started=Date.now();const run=spawnSync(process.execPath,args,{encoding:'utf8',timeout:180000,maxBuffer:2*1024*1024});
  const log=(run.stdout||'')+(run.stderr||'');writeFileSync(`evidence/${name}.log`,log);
  process.stdout.write(log);results.push({name,args,exitCode:run.status,durationMs:Date.now()-started});
  if(run.status!==0)throw Error(`${name} failed; see evidence/${name}.log`);
}
const demo=await runRecoveryDemo();writeFileSync('evidence/recovery.json',JSON.stringify(demo,null,2)+'\n');
const bootstrap=await runBootstrapDemo();writeFileSync('evidence/bootstrap.json',JSON.stringify(bootstrap,null,2)+'\n');
const processDemo=await runProcessDemo();writeFileSync('evidence/process-recovery.json',JSON.stringify(processDemo,null,2)+'\n');
const sources=snapshot();
if(JSON.stringify(sources)!==JSON.stringify(sourcesBefore))throw Error('Source changed during qualification; rerun before publishing a receipt');
const receipt={status:'passed',at:new Date().toISOString(),runtime:{node:process.version,platform:process.platform,arch:process.arch},checks:results,demoAssertions:demo.assertions,bootstrapAssertions:bootstrap.assertions,processAssertions:processDemo.assertions,sources,
  limits:['Deterministic protocol workers, not real LLM harness adapters.','Artifact API and cooperative POSIX process-group ownership; no arbitrary process or GPU exclusivity.','Only the recorded local platform was executed.','This command runs local fixtures; installed services, SSH transport and real model harness tests have separate qualification records.','A lost process anchor with surviving descendants remains held until externally stopped.']};
writeFileSync('evidence/qualification.json',JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({status:'passed',qualification:'evidence/qualification.json',recovery:'evidence/recovery.json'},null,2));
