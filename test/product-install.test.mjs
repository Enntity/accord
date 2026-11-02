import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,rmSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureAccord } from '../src/product-install.mjs';
test('two products install once, share a pinned authority and preserve hookup; dry run writes nothing',async t=>{
 const home=mkdtempSync(join(tmpdir(),'accord-products-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
 const data=join(home,'data'),options={home,data,start:false,clients:[]};
 assert.equal((await ensureAccord({...options,dryRun:true})).reused,false);assert(!existsSync(data));
 const results=await Promise.all([ensureAccord(options),ensureAccord(options)]);
 assert.equal(results.filter(r=>r.installed).length,1);assert.equal(results.filter(r=>r.reused).length,1);
 const profile=join(home,'.config/accord/connection.json'),before=readFileSync(profile,'utf8');
 await ensureAccord({...options,data:join(home,'another')});assert.equal(readFileSync(profile,'utf8'),before);assert(!existsSync(join(home,'another')));
 await assert.rejects(ensureAccord({...options,start:true}));assert.equal(readFileSync(profile,'utf8'),before);
});
