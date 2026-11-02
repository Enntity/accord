// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname,join } from 'node:path';
import { harness } from './helpers.mjs';
import { install } from '../src/installer.mjs';
import { detectClients } from '../src/client-install.mjs';

const put=(path,text)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text);};
const all=['opencode','grok','omp','hermes','zcode','dsh'];
async function homes(t){
  const h=await harness(),home=mkdtempSync(join(tmpdir(),'accord-clients-'));
  t.after(async()=>{await h.close();rmSync(home,{recursive:true,force:true});});
  return {h,home,run:options=>install({home,data:h.data,...options}),read:(...p)=>readFileSync(join(home,...p),'utf8')};
}
function present(home){
  put(join(home,'.config/opencode/opencode.json'),'{"model":"keep"}\n');
  put(join(home,'.grok/config.toml'),'model = "keep"\n');
  put(join(home,'.omp/agent/config.yml'),'theme: keep\n');
  put(join(home,'.hermes/config.yaml'),'model: keep\n');
  put(join(home,'.hermes/SOUL.md'),'Keep this persona.\n');
  put(join(home,'.enntity-zcode/cli/config.json'),'{"mcp":{"servers":{"mine":{"type":"stdio","command":"keep"}}},"theme":"keep"}\n');
  put(join(home,'.dsh/profiles/web/cordis.patch.yml'),'- id: keep\n');
}

test('only agents present on this machine are selected',async t=>{
  const home=mkdtempSync(join(tmpdir(),'accord-detect-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  assert.deepEqual(detectClients(home,{}),[]);
  present(home);put(join(home,'.config/devin/x'),'');
  assert.deepEqual(detectClients(home,{}).sort(),['devin',...all].sort());
  const other=join(home,'elsewhere');mkdirSync(other);
  assert.equal(detectClients(mkdtempSync(join(tmpdir(),'accord-empty-')),{DSH_HOME:other}).includes('dsh'),true);
});

test('every agent gets Accord in its own config and keeps everything else',async t=>{
  const {home,run,read}=await homes(t);present(home);
  const preview=run({clients:all,dryRun:true});
  assert.ok(preview.steps.some(s=>s.path?.endsWith('opencode.json')));assert.equal(read('.config/opencode/opencode.json'),'{"model":"keep"}\n');
  const result=run({clients:all});
  assert.equal(result.steps.some(s=>s.action==='skipped'),false,JSON.stringify(result.steps));
  const open=JSON.parse(read('.config/opencode/opencode.json'));
  assert.equal(open.model,'keep');assert.equal(open.mcp.accord.type,'local');assert.deepEqual(open.mcp.accord.command.slice(-3),['mcp','--profile',join(home,'.config/accord/connection.json')]);
  assert.match(read('.grok/config.toml'),/^model = "keep"\n[\s\S]*\[mcp_servers\.accord\]\ncommand = /);
  const omp=JSON.parse(read('.omp/agent/mcp.json'));assert.equal(omp.mcpServers.accord.type,'stdio');
  assert.match(read('.hermes/config.yaml'),/^model: keep\n\nmcp_servers:\n  accord:\n    command: "/);
  const zcode=JSON.parse(read('.enntity-zcode/cli/config.json'));
  assert.equal(zcode.theme,'keep');assert.equal(zcode.mcp.servers.mine.command,'keep');assert.equal(zcode.mcp.servers.accord.type,'stdio');
  assert.match(read('.dsh/cordis.patch.yml'),/- insert:\n    - id: mcp-accord\n      name: '@deepseek-ai\/dsh-mcp-client'\n      config:\n        serverName: accord\n        transport: stdio\n/);
  for(const path of ['.config/opencode/AGENTS.md','.grok/rules/accord.md','.omp/agent/AGENTS.md','.hermes/SOUL.md','.enntity-zcode/AGENTS.md','.dsh/AGENTS.md'])assert.match(read(path),/accord_bootstrap/,path);
  assert.match(read('.hermes/SOUL.md'),/^Keep this persona\.\n/);
  for(const path of ['.grok/skills/accord/SKILL.md','.hermes/skills/coordination/accord/SKILL.md','.agents/skills/accord/SKILL.md'])assert.ok(existsSync(join(home,path)),path);
  assert.ok(run({clients:all}).steps.every(s=>s.action==='unchanged'),'a repeat changes nothing');
});

test('YAML agents keep their existing servers and indentation',async t=>{
  const {home,run,read}=await homes(t);
  put(join(home,'.hermes/config.yaml'),'mcp_servers:\n    mine:\n        command: keep\nmodel: keep\n');
  put(join(home,'.dsh/cordis.patch.yml'),'# mine\n- id: keep\n');
  run({clients:['hermes','dsh']});
  assert.match(read('.hermes/config.yaml'),/^mcp_servers:\n    accord:\n        command: "[^\n]+\n        args: \[[^\n]+\n    mine:\n        command: keep\nmodel: keep\n$/);
  assert.match(read('.dsh/cordis.patch.yml'),/^# mine\n- id: keep\n- insert:/);
});

test('one agent with a config Accord cannot edit never stops the others',async t=>{
  const {home,run,read}=await homes(t);present(home);
  put(join(home,'.config/opencode/opencode.json'),'{ // comments are valid here\n}\n');
  put(join(home,'.hermes/config.yaml'),'mcp_servers: {mine: {command: keep}}\n');
  const steps=run({clients:all}).steps,skipped=steps.filter(s=>s.action==='skipped').map(s=>s.client).sort();
  assert.deepEqual(skipped,['hermes','opencode']);
  assert.ok(steps.filter(s=>s.action==='skipped').every(s=>s.reason));
  assert.equal(read('.hermes/config.yaml'),'mcp_servers: {mine: {command: keep}}\n');
  assert.match(read('.grok/config.toml'),/mcp_servers\.accord/);
});

test('a changed registration in another agent is left for its owner',async t=>{
  const {home,run,read}=await homes(t);
  put(join(home,'.omp/agent/mcp.json'),'{"mcpServers":{"accord":{"command":"custom"}}}\n');
  const steps=run({clients:['omp']}).steps;
  assert.ok(steps.some(s=>s.client==='omp'&&s.action==='skipped'));
  assert.match(read('.omp/agent/mcp.json'),/custom/);
});
