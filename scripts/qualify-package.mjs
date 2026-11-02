// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { spawnSync,fork } from 'node:child_process';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { join,resolve,dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
const archive=resolve(process.argv[2]),root=mkdtempSync(join(tmpdir(),'accord-package-')),prefix=join(root,'prefix'),home=join(root,'home'),data=join(root,'data');
let server,a,b;
async function until(fn){const end=Date.now()+10000;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,50));}throw Error('Package proof timed out');}
try{
  const install=spawnSync('npm',['install','--offline','--ignore-scripts','--no-audit','--no-fund','--cache',join(root,'cache'),'--prefix',prefix,archive],{encoding:'utf8',timeout:30000});assert.equal(install.status,0,install.stderr);
  const pkg=join(prefix,'node_modules/@enntity/accord'),cli=join(pkg,'src/cli.mjs');
  const bootstrap=spawnSync(process.execPath,[cli,'install','--no-start','--home',home,'--data',data],{cwd:root,encoding:'utf8',timeout:10000});assert.equal(bootstrap.status,0,bootstrap.stderr);
  for(const p of ['.codex/AGENTS.md','.claude/CLAUDE.md'])assert(readFileSync(join(home,p),'utf8').includes('accord_bootstrap'));
  server=fork(cli,['up','--data',data,'--port','0','--driver-port','0'],{cwd:root,stdio:['ignore','ignore','pipe','ipc']});server.stderr.resume();
  await new Promise((r,j)=>{const timeout=setTimeout(()=>j(Error('Package service did not start')),10000);server.on('message',m=>{if(m.type==='ready'){clearTimeout(timeout);r();}});server.once('exit',code=>{clearTimeout(timeout);j(Error('Package service exited '+code));});});
  const {enrollProfile}=await import(pathToFileURL(join(pkg,'src/bootstrap.mjs'))),{AccordClient}=await import(pathToFileURL(join(pkg,'src/client.mjs')));
  const profile=join(home,'.config/accord/connection.json');a=await enrollProfile(profile,{label:'package reviewer'});b=await enrollProfile(profile,{label:'package author'});
  const aa=await a.bootstrap(),bb=await b.bootstrap();assert.notEqual(aa.address,bb.address);
  await a.announce({label:'package reviewer',activity:'reviewing package',capabilities:['review']});assert((await b.find('review')).participants.some(p=>p.address===aa.address));
  const sent=await a.send(bb.address,'package hello',{key:'package-message'}),message=await until(async()=>{const x=await b.inbox();return x.messages.find(m=>m.id===sent.id);});await b.read(message.deliveryId);
  const endpoints=JSON.parse(readFileSync(join(data,'endpoints.json'))),admin=new AccordClient(endpoints.coordinator,readFileSync(join(data,'admin.token'),'utf8'));
  await admin.registerResource({schema:1,id:'repository',asset:'repo:package-proof',plugin:'cooperative'});
  const r=await a.reserve('repository');await until(async()=>(await a.reservation(r.id)).state==='running');await a.release(r.id);await until(async()=>(await a.reservation(r.id)).state==='released');
  const telemetry=await a.telemetry(),machine=await a.metadata();assert(telemetry.host?.memory.totalBytes>0);assert(machine.machine?.cpu.logicalCpus>0);
  const report={status:'passed',at:new Date().toISOString(),archive:archive.split('/').at(-1),sha256:createHash('sha256').update(readFileSync(archive)).digest('hex'),bytes:readFileSync(archive).length,node:process.version,assertions:{telemetryFromInstalledPackage:true,metadataFromInstalledPackage:true,offlineNpmInstall:true,independentPackageDirectory:true,startupInstructionsInstalled:true,twoFreshSessions:true,discovery:true,messageDeliveredAndRead:true,reservationReleased:true,noRuntimeDependencies:true}};
  const output=process.argv[3]??'evidence/thin/package.json';mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{
  if(a)await a.closeSession().catch(()=>{});if(b)await b.closeSession().catch(()=>{});
  if(server&&server.exitCode===null){server.kill('SIGTERM');await new Promise(r=>{server.once('exit',r);setTimeout(()=>{server.kill('SIGKILL');r();},5000).unref();});}
  rmSync(root,{recursive:true,force:true});
}
