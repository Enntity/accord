// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,writeFileSync,mkdirSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from '../src/common.mjs';
import { initialize } from '../src/config.mjs';
import { install } from '../src/installer.mjs';

test('embedded Messenger files match the pinned upstream source',()=>{
  const pinned=JSON.parse(readFileSync(new URL('../vendor/messenger/upstream.json',import.meta.url)));
  for(const [file,digest] of Object.entries(pinned.sha256))assert.equal(hash(readFileSync(new URL('../vendor/messenger/'+file,import.meta.url),'utf8')),digest,file);
});

test('installer adds startup guidance without replacing user instructions, honors override, and remains idempotent',t=>{
  const root=mkdtempSync(join(tmpdir(),'accord-install-thin-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const home=join(root,'home'),data=join(root,'data');initialize(data);
  mkdirSync(join(home,'.codex'),{recursive:true});mkdirSync(join(home,'.claude'),{recursive:true});
  const paths=[join(home,'.codex','AGENTS.override.md'),join(home,'.claude','CLAUDE.md')];
  for(const p of paths)writeFileSync(p,'Keep my existing instructions.\n');
  install({home,data});
  for(const p of paths){const s=readFileSync(p,'utf8');assert(s.startsWith('Keep my existing instructions.'));assert(s.includes('accord_bootstrap'));assert.equal(s.split('<!-- accord:start -->').length,2);}
  assert(install({home,data}).steps.every(s=>s.action==='unchanged'));
});

test('Devin registration uses its CLI with an isolated home and retains existing configuration',{skip:process.platform==='win32'},t=>{
  const root=mkdtempSync(join(tmpdir(),'accord-devin-install-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const home=join(root,'home'),data=join(root,'data');initialize(data);
  const bin=join(home,'.local','bin');mkdirSync(bin,{recursive:true});
  const devin=join(bin,'devin');
  writeFileSync(devin,'#!/bin/sh\nif [ "$2" = get ]; then test -f "$HOME/registered"; exit $?; fi\nprintf "%s\\n" "$*" > "$HOME/registered"\n',{mode:0o755});
  const result=install({home,data,clients:['devin']});
  assert(result.steps.some(s=>s.client==='devin'&&s.action==='registered'));
  const args=readFileSync(join(home,'registered'),'utf8');assert(args.startsWith('mcp add --scope user accord -- '));
  assert(install({home,data,clients:['devin']}).steps.some(s=>s.client==='devin'&&s.action==='unchanged'));
  assert.equal(readFileSync(join(home,'registered'),'utf8'),args);
});
