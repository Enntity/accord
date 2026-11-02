// SPDX-License-Identifier: MIT
import { AccordClient } from '../src/client.mjs';
process.once('message',async input=>{
  try {
    const client=new AccordClient(input.url,input.credential);
    const claim=await client.claim({key:'process-owner',taskId:input.taskId,leaseMs:1500});
    while((await client.inspect(claim.id)).state!=='running')await new Promise(r=>setTimeout(r,20));
    const run=await client.startProcess(claim.id,'start');
    await client.checkpoint(claim.id,'Resume controlled process after confirmed stop','checkpoint');
    process.send({type:'owned',claim:claim.id,generation:claim.generation,run});
    let sequence=0;setInterval(()=>client.renew(claim.id,1500,`renew-${++sequence}`).catch(()=>{}),300);
  }catch(error){process.send({type:'failed',message:error.message});process.exitCode=1;}
});
