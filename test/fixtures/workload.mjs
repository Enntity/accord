// SPDX-License-Identifier: MIT
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
let mode=process.argv[2];const trace=process.env.ACCORD_TEST_TRACE;
const log=event=>{if(trace)appendFileSync(trace,JSON.stringify({event,pid:process.pid,at:Date.now()})+'\n');};
log('started');
if(mode==='recover'){try{writeFileSync(process.env.ACCORD_TEST_ONCE,'started',{flag:'wx'});mode='tree';}catch(e){if(e.code!=='EEXIST')throw e;mode='once';}}
if(mode==='once'){process.stdout.write('process result');process.exit(0);}
process.on('SIGTERM',()=>log('term-ignored'));
if(mode==='tree'||mode==='orphan'){
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'child'],{stdio:'ignore',env:process.env});
  child.unref();
  if(mode==='orphan')setTimeout(()=>process.exit(23),100);
}
setInterval(()=>log('heartbeat'),30);
