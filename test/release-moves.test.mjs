// SPDX-License-Identifier: MIT
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync,mkdirSync,mkdtempSync,readdirSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch,message } from './helpers.mjs';
import { hash } from '../src/common.mjs';
import { initialize } from '../src/config.mjs';
import { install } from '../src/installer.mjs';
import { installService,servicePlan } from '../src/service.mjs';

const test=process.platform==='win32'?nodeTest.skip:nodeTest;// POSIX supervisors and service files.
const cliUrl=new URL('../src/cli.mjs',import.meta.url),src=dirname(fileURLToPath(cliUrl));
const put=(path,text)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text);};
function scratch(t){
  const root=mkdtempSync(join(tmpdir(),'accord-move-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const home=join(root,'home'),data=join(root,'data');initialize(data);return {root,home,data};
}
const freePort=()=>new Promise((resolve,reject)=>{const s=createServer().once('error',reject).listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(()=>resolve(port));});});
const bindable=port=>new Promise(resolve=>{const s=createServer().once('error',()=>resolve(false)).listen(port,'127.0.0.1',()=>s.close(()=>resolve(true)));});
const exited=proc=>proc.exitCode!==null||proc.signalCode!==null?Promise.resolve():new Promise(resolve=>proc.once('exit',resolve));
async function supervisor(t){
  const {home,data}=scratch(t);
  // A probed free port can be taken again before the service binds it; try fresh ones.
  for(let attempt=1;;attempt++){
    const port=await freePort(),driverPort=await freePort();
    const up=launch(cliUrl,['up','--home',home,'--data',data,'--port',String(port),'--driver-port',String(driverPort)]);
    t.after(()=>{if(up.exitCode===null)up.kill('SIGKILL');});
    try{await message(up,'ready',20000);return {up,ports:[port,driverPort]};}
    catch(error){if(attempt===3||!/EADDRINUSE/.test(error.message))throw error;await exited(up);}
  }
}

test('a requested stop exits cleanly after both services have let go of their ports',async t=>{
  const {up,ports}=await supervisor(t);
  up.kill('SIGTERM');await exited(up);
  assert.equal(up.exitCode,0,up.diagnostic);
  for(const port of ports)assert.equal(await bindable(port),true,`port ${port} still held when the supervisor exited`);
});

test('a service that dies on its own stops the other first and reports a failure',async t=>{
  const {up,ports}=await supervisor(t);
  const children=spawnSync('pgrep',['-P',String(up.pid)],{encoding:'utf8'}).stdout.trim().split('\n').map(Number);
  const serve=children.find(pid=>spawnSync('ps',['-o','command=','-p',String(pid)],{encoding:'utf8'}).stdout.includes(' serve '));
  assert.ok(serve,'serve child found');
  process.kill(serve,'SIGKILL');await exited(up);
  assert.equal(up.exitCode,1);
  for(const port of ports)assert.equal(await bindable(port),true,`port ${port} still held when the supervisor exited`);
});

test('a service that ignores a stop is killed so the supervisor still exits',{timeout:60000},async t=>{
  const {up,ports}=await supervisor(t);
  const children=spawnSync('pgrep',['-P',String(up.pid)],{encoding:'utf8'}).stdout.trim().split('\n').map(Number);
  const serve=children.find(pid=>spawnSync('ps',['-o','command=','-p',String(pid)],{encoding:'utf8'}).stdout.includes(' serve '));
  t.after(()=>{try{process.kill(serve,'SIGKILL');}catch{}});
  process.kill(serve,'SIGSTOP');// A stopped process cannot act on SIGTERM.
  const started=Date.now();up.kill('SIGTERM');await exited(up);
  assert.ok(Date.now()-started<20000,'supervisor exited');
  for(const port of ports)assert.equal(await bindable(port),true,`port ${port} still held when the supervisor exited`);
});

// Rewrites what install wrote as if it had run from another folder and Node, keeping the
// manifest true to those files, as an earlier install there would have left it.
function movedFrom(home,files){
  for(const file of files){const path=join(home,file);
    put(path,readFileSync(path,'utf8').replaceAll(process.execPath,'/old/node').replaceAll(src,'/old/accord/src'));}
  const manifestPath=join(home,'.config','accord','install-manifest.json'),manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  for(const path of Object.keys(manifest))if(existsSync(path))manifest[path]=hash(readFileSync(path,'utf8'));
  writeFileSync(manifestPath,JSON.stringify(manifest));
}
const agents=['opencode','grok','omp','hermes','zcode','dsh'];
const registrations=['.claude.json','.codex/config.toml','.claude/settings.json','.codex/hooks.json','.local/bin/accord','.config/accord/login-notice.sh',
  '.config/opencode/opencode.json','.grok/config.toml','.omp/agent/mcp.json','.hermes/config.yaml','.enntity-zcode/cli/config.json','.dsh/cordis.patch.yml'];

test('an install from another folder or Node upgrades every earlier Accord registration in place',t=>{
  const {home,data}=scratch(t);
  put(join(home,'.hermes/config.yaml'),'model: keep\n');put(join(home,'.enntity-zcode/cli/config.json'),'{"theme":"keep"}\n');
  const clients=['codex','claude',...agents];
  install({home,data,clients});movedFrom(home,registrations);
  const steps=install({home,data,clients}).steps;
  assert.equal(steps.some(s=>s.action==='skipped'),false,JSON.stringify(steps.filter(s=>s.action==='skipped')));
  for(const file of registrations){const text=readFileSync(join(home,file),'utf8');
    assert.equal(text.includes('/old/'),false,`${file} still names the earlier install`);
    assert.ok(text.includes(src)||text.includes(JSON.stringify(src).slice(1,-1)),`${file} names this install`);}
  assert.match(readFileSync(join(home,'.hermes/config.yaml'),'utf8'),/^model: keep\n/);
  assert.equal(JSON.parse(readFileSync(join(home,'.enntity-zcode/cli/config.json'),'utf8')).theme,'keep');
  assert.ok(install({home,data,clients}).steps.every(s=>s.action==='unchanged'),'a repeat changes nothing');
});

test('a registration that is not an earlier Accord install stays its owner',t=>{
  const {home,data}=scratch(t);
  const foreign={command:'/old/node',args:['/old/accord/src/cli.mjs','mcp','--profile','/someone/else.json']};
  put(join(home,'.claude.json'),JSON.stringify({mcpServers:{accord:foreign}}));
  assert.throws(()=>install({home,data,clients:['claude']}),{code:'INSTALL_CONFLICT'});
  put(join(home,'.grok/config.toml'),`[mcp_servers.accord]\ncommand = "/old/node"\nargs = ${JSON.stringify(foreign.args)}\nenabled = true\n`);
  const steps=install({home,data,clients:['grok']}).steps;
  assert.ok(steps.some(s=>s.client==='grok'&&s.action==='skipped'));
});

test('a service file from an earlier install is replaced with a backup; any other file is refused',t=>{
  const {root,home,data}=scratch(t);
  const plan=servicePlan({data,home}),earlier=servicePlan({data,home,node:'/old/node',cli:'/old/accord/src/cli.mjs'});
  assert.notEqual(earlier.content,plan.content);
  put(plan.path,earlier.content);
  const result=installService({data,home});
  assert.equal(result.replaced,true);assert.equal(readFileSync(plan.path,'utf8'),plan.content);
  assert.ok(readdirSync(dirname(plan.path)).some(f=>f.includes('.backup-')),'earlier service file kept');
  assert.equal(installService({data,home}).replaced,undefined,'a repeat replaces nothing');
  put(plan.path,earlier.content.replace('<integer>10</integer>','<integer>30</integer>').replace('RestartSec=10','RestartSec=30'));
  assert.throws(()=>installService({data,home}),{code:'SERVICE_CONFLICT'});
  put(plan.path,servicePlan({data:join(root,'other'),home,node:'/old/node',cli:'/old/accord/src/cli.mjs'}).content);
  assert.throws(()=>installService({data,home}),{code:'SERVICE_CONFLICT'});
});
