// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync,readFileSync,mkdirSync,existsSync,unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { harness,eventually,stop } from './helpers.mjs';
import { install } from '../src/installer.mjs';
import { AccordClient } from '../src/client.mjs';
import { request,hash } from '../src/common.mjs';
import { contextHook } from '../src/context-hook.mjs';
import { mergeContextHooks } from '../src/hook-install.mjs';

async function fixture(t) {
  const h=await harness();t.after(()=>h.close());
  writeFileSync(join(h.data,'endpoints.json'),JSON.stringify({coordinator:h.url}));
  const authority=(await h.client('admin').host()).authority,profile=join(h.data,'connection.json');
  writeFileSync(profile,JSON.stringify({schema:1,authority,endpointFile:join(h.data,'endpoints.json')}));
  const enroll=()=>AccordClient.enroll(h.url,h.credential('bootstrap'),{authority,label:'Attention test'});
  const a=await enroll(),b=h.client('agent-b'),address=(await a.bootstrap()).address;
  const hook=(input,source='claude')=>contextHook({profilePath:profile,source,input:{session_id:'native-one',hook_event_name:'PostToolUse',...input}});
  const bind=()=>hook({tool_name:'mcp__accord__accord_bootstrap',tool_response:{content:[{type:'text',text:JSON.stringify({address})}]}});
  const send=async(text='Please coordinate')=>{await b.send(address,text);return eventually(async()=>{const m=(await a.inbox()).messages.find(m=>m.text===text);return m;});};
  return {h,a,b,address,profile,enroll,hook,bind,send};
}
test('ordinary calls and errors carry only a compact unread count; observation is not acknowledgment',async t=>{
  const f=await fixture(t);
  assert.equal((await f.a.resources()).inboxPending,undefined);
  const m=await f.send();
  for(const result of [await f.a.resources(),await f.a.host(),await f.a.metadata(),await f.a.announce({label:'Test',activity:'Working'})]){
    assert.equal(result.inboxPending,1);assert(!JSON.stringify(result).includes(m.text));
  }
  await assert.rejects(f.a.collaborate('not-a-method'),e=>e.inboxPending===1);
  assert.equal((await f.h.client('admin').resources()).inboxPending,undefined);
  assert.equal((await request(f.h.url,f.h.credential('discovery'),'/v1/host')).inboxPending,undefined);
  assert.equal((await f.a.inbox()).inboxPending,1);
  await f.a.read(m.deliveryId);assert.equal((await f.a.resources()).inboxPending,undefined);
});

test('unsupported self-messages fail before creating a permanently queued delivery',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.a.send(f.address,'self-message'),{code:'SELF_MESSAGE'});
  const board=await f.h.client('admin').board();assert(!board.events.some(e=>e.kind==='message.queued'));
});
test('native hooks deliver at the next unrelated tool boundary, dedupe, and never acknowledge',async t=>{
  const f=await fixture(t);assert.deepEqual(await f.bind(),{});const m=await f.send();
  const shown=await f.hook({tool_name:'Bash'}),text=shown.hookSpecificOutput.additionalContext;
  assert(text.includes(m.text));assert(text.includes(m.deliveryId));assert(text.includes('untrusted data'));
  assert.deepEqual(await f.hook({tool_name:'Bash'}),{});
  assert.equal((await f.a.resources()).inboxPending,1);
  assert.deepEqual(await f.hook({hook_event_name:'Stop',stop_hook_active:true}),{});
  assert((await f.hook({hook_event_name:'SessionStart'})).hookSpecificOutput.additionalContext.includes(m.text));
  await f.a.read(m.deliveryId);assert.deepEqual(await f.hook({hook_event_name:'SessionStart',source:'compact'}),{});
  const next=await f.send('A new message');assert((await f.hook({})).hookSpecificOutput.additionalContext.includes(next.text));
});

test('concurrent hook presentation cannot swallow the bootstrap identity binding',async t=>{
  const f=await fixture(t);
  const results=await Promise.all([f.bind(),f.hook({tool_name:'Bash'}),f.hook({tool_name:'Read'})]);
  assert.equal(results.length,3);
  const m=await f.send();assert((await f.hook({tool_name:'Bash'})).hookSpecificOutput.additionalContext.includes(m.text));
});
test('full inbox output suppresses duplicate hook text; content is bounded and paged',async t=>{
  const f=await fixture(t);await f.bind();
  await f.send('already visible');
  assert.deepEqual(await f.hook({tool_name:'mcp__accord__accord_inbox',tool_response:JSON.stringify(await f.a.inbox())}),{});
  for(let i=0;i<4;i++)await f.send(String(i)+':'+ 'x'.repeat(1200));
  const shown=(await f.hook({})).hookSpecificOutput.additionalContext;
  const batch=JSON.parse(shown.slice(shown.indexOf('\n')+1));
  assert.equal(batch.length,3);assert(batch.every(m=>m.text.length===700&&m.truncated));assert(shown.length<3200);
  const remaining=(await f.hook({})).hookSpecificOutput.additionalContext;assert(remaining.includes('3:'));assert(!remaining.includes('0:'));
  assert.equal((await f.a.resources()).inboxPending,5);
});
test('native identity binding isolates conversations, requires operator authority and ignores unrelated tool IDs',async t=>{
  const f=await fixture(t);await f.bind();await f.send('private conversation');
  assert.deepEqual(await f.hook({session_id:'native-two'}),{});
  assert.deepEqual(await f.hook({session_id:'native-two',tool_name:'Bash',tool_response:{address:f.address}}),{});
  assert.deepEqual(await f.hook({},'codex'),{});
  assert.deepEqual(await f.hook({agent_id:'child'}),{});
  assert.deepEqual(await f.hook({agent_id:'child',tool_name:'mcp__accord__accord_bootstrap',tool_response:{address:f.address}}),{});
  await assert.rejects(f.a.collaborate('context-inbox',{source:'claude',externalId:'native-one'}),{code:'FORBIDDEN'});
  assert((await f.hook({})).hookSpecificOutput.additionalContext.includes('private conversation'));
});

test('Codex uses supported context events and leaves unsupported events silent',async t=>{
  const f=await fixture(t);await f.hook({tool_name:'mcp__accord__accord_bootstrap',tool_response:{address:f.address}},'codex');
  const m=await f.send();
  assert.deepEqual(await f.hook({hook_event_name:'Stop'},'codex'),{});
  assert.deepEqual(await f.hook({hook_event_name:'PostCompact'},'codex'),{});
  assert((await f.hook({hook_event_name:'SessionStart',source:'compact'},'codex')).hookSpecificOutput.additionalContext.includes(m.text));
  const hooks=mergeContextHooks({},{full:'node --accord-context-hook x'},{source:'codex'}).hooks;
  assert.deepEqual(Object.keys(hooks),['SessionStart','UserPromptSubmit','PostToolUse']);
  const held=mergeContextHooks({},{full:'node --accord-context-hook x',hold:'sh hold --accord-context-hook x'},{source:'codex'}).hooks;
  assert.deepEqual(held.Stop,[{hooks:[{type:'command',command:'sh hold --accord-context-hook x',timeout:600}]}]);
  const claude=mergeContextHooks(held,{full:'n --accord-context-hook x',fast:'f --accord-context-hook x',wake:'w --accord-context-hook x'},{source:'claude'}).hooks;
  assert.deepEqual(claude.Stop.map(g=>g.hooks[0]),[{type:'command',command:'f --accord-context-hook x',timeout:2},{type:'command',command:'w --accord-context-hook x',asyncRewake:true,timeout:86400}],'reinstalling replaces every Accord handler');
  assert.deepEqual(claude.PostToolUse.map(g=>g.matcher),[undefined,'mcp__accord__.*'],'Accord tools keep the identity-binding path');
});
test('verified reconnect retains unread mail without reviving closed credentials or resource ownership',async t=>{
  const f=await fixture(t);await f.bind();const old=await f.send('survive closure');
  const reservation=await f.a.reserve('artifact',{leaseMs:10000});
  await eventually(async()=>(await f.a.reservation(reservation.id)).state==='running');
  await f.a.closeSession();await assert.rejects(f.a.me(),{code:'SESSION_EXPIRED'});
  const next=await f.enroll(),address=(await next.bootstrap()).address;
  assert.equal((await next.inbox()).messages.length,0);
  const shown=await f.hook({tool_name:'mcp__accord__accord_announce',tool_response:{address}});
  assert(shown.hookSpecificOutput.additionalContext.includes(old.text));
  assert.equal((await next.resources()).inboxPending,1);
  await assert.rejects(next.reservation(reservation.id),{code:'NOT_OWNER'});
  await next.read(old.deliveryId);assert.equal((await next.inbox()).messages.length,0);
  await assert.rejects(f.a.me(),{code:'SESSION_EXPIRED'});
});
test('installer preserves disabled hooks, unrelated handlers and trust settings; repeat and dry run are inert',async t=>{
  const f=await fixture(t),home=join(f.h.data,'home');
  mkdirSync(join(home,'.claude'),{recursive:true});mkdirSync(join(home,'.codex'),{recursive:true});
  const original={disableAllHooks:true,permissions:{deny:['Bash(rm *)']},hooks:{PostToolUse:[{matcher:'Bash',hooks:[{type:'command',command:'existing-hook'}]}]}};
  writeFileSync(join(home,'.claude','settings.json'),JSON.stringify(original));
  writeFileSync(join(home,'.codex','hooks.json'),JSON.stringify(original));
  const trust='[hooks.state]\nexisting = "trusted"\n';writeFileSync(join(home,'.codex','config.toml'),trust);
  install({home,data:f.h.data,dryRun:true});assert(!existsSync(join(home,'.local')));
  install({home,data:f.h.data});
  for(const path of [join(home,'.claude','settings.json'),join(home,'.codex','hooks.json')]){
    const result=JSON.parse(readFileSync(path));assert.equal(result.disableAllHooks,true);assert.deepEqual(result.permissions,original.permissions);
    assert.deepEqual(result.hooks.PostToolUse[0],original.hooks.PostToolUse[0]);assert.equal(result.hooks.PostToolUse.length,3);
  }
  const stop=JSON.parse(readFileSync(join(home,'.claude','settings.json'))).hooks.Stop.flatMap(g=>g.hooks).find(h=>h.asyncRewake);
  assert.match(stop.command,process.platform==='win32'?/wait-hook\.mjs'? wake /:/hook\.sh'? wake /);
  assert.match(JSON.parse(readFileSync(join(home,'.codex','hooks.json'))).hooks.Stop.flatMap(g=>g.hooks).at(-1).command,/ hold /);
  assert(readFileSync(join(home,'.codex','config.toml'),'utf8').startsWith(trust));
  assert(install({home,data:f.h.data}).steps.every(s=>s.action==='unchanged'));
  assert.throws(()=>mergeContextHooks({hooks:{PostToolUse:'invalid'}},{full:'node --accord-context-hook x'}),{code:'INSTALL_CONFLICT'});
});
test('hook executable fails open and quiet on malformed input or unavailable daemon',async t=>{
  const f=await fixture(t),path=fileURLToPath(new URL('../src/context-hook.mjs',import.meta.url));
  async function run(input){
    const p=spawn(process.execPath,[path,'--accord-context-hook','--source','claude','--profile',f.profile],{stdio:['pipe','pipe','pipe']});
    let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.stdin.end(input);
    const code=await new Promise(r=>p.once('exit',r));assert.equal(code,0);assert.equal(err,'');return JSON.parse(out);
  }
  assert.deepEqual(await run('invalid'),{});await stop(f.h.server);
  const start=Date.now();assert.deepEqual(await run(JSON.stringify({hook_event_name:'PostToolUse',session_id:'native-one'})),{});assert(Date.now()-start<2000);
});

test('CLI JSON preserves the fallback for inherited sessions',async t=>{
  const f=await fixture(t);await f.send();const session=join(f.h.data,'session.json');
  writeFileSync(session,JSON.stringify({schema:1,url:f.h.url,...f.a.session}),{mode:0o600});
  const cli=fileURLToPath(new URL('../src/cli.mjs',import.meta.url));
  async function run(args){
    const p=spawn(process.execPath,[cli,...args],{env:{...process.env,ACCORD_SESSION_FILE:session},stdio:['ignore','pipe','pipe']});
    let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);const code=await new Promise(r=>p.once('exit',r));
    return {code,result:JSON.parse(code?err.trim().split('\n').at(-1):out)};
  }
  assert.equal((await run(['announce','--label','CLI','--activity','Checking'])).result.inboxPending,1);
  const error=await run(['reservation','--id','missing']);assert.equal(error.code,1);assert.equal(error.result.inboxPending,1);
});
