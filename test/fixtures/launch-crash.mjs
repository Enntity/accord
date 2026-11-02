// SPDX-License-Identifier: MIT
// Fault injection stays in the test process, outside the shipped driver.
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
import { ProcessDriver } from '../../src/process-driver.mjs';
import { hash } from '../../src/common.mjs';
process.once('message',({file,manifest,point,pidFile})=>{
  const driver=new ProcessDriver(file,manifest),state=driver.status();
  driver.activate({instance:state.instance,authority:'test-authority',epoch:1,generation:1,claimId:'test-claim',credentialHash:hash('test-credential')});
  const original=cp.spawn;
  cp.spawn=(...args)=>{
    const child=original(...args);
    if(args[1]?.some(a=>String(a).endsWith('process-anchor.mjs'))){
      writeFileSync(pidFile,String(child.pid));
      if(point==='before-commit')process.kill(process.pid,'SIGKILL');
      child.send=()=>process.kill(process.pid,'SIGKILL');
    }
    return child;
  };
  syncBuiltinESMExports();driver.start('test-credential',{key:'first'});
});
