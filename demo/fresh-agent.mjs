// SPDX-License-Identifier: MIT
// A new process receives only an installed connection profile, never a task or old claim.
import { enrollProfile, profileAt, discover } from '../src/bootstrap.mjs';
const report = value => process.send?.(value);
let client;
try {
  const profile=process.argv[2];
  const discovery=await discover(profileAt(profile));
  report({type:'discovered',host:discovery});
  client=await enrollProfile(profile,{label:'fresh incoming agent',harness:'protocol-fixture'});
  const context=await client.bootstrap();
  report({type:'bootstrapped',sessionId:context.me.id,authority:context.host.authority});
  let lastState;
  let claim=await client.waitClaim({waitMs:20000,leaseMs:10000,onWait:async code=>{
    const host=await client.host(),state=host.resource.holder?.state??host.resource.state;
    if(state!==lastState){report({type:'waiting',reason:code,host});lastState=state;}
  }});
  while(claim.state==='preparing'){
    await new Promise(resolve=>setTimeout(resolve,25));claim=await client.inspect(claim.id);
  }
  if(claim.state!=='running')throw Error('Claim did not become active');
  report({type:'acquired',claimId:claim.id,generation:claim.generation,checkpoint:claim.task.checkpoint,sessionId:context.me.id});
  const receipt=await client.writeViaHost(claim,claim.task.input.toUpperCase(),`output:${claim.id}`);
  await client.finish(claim.id,receipt.id,`finish:${claim.id}`);
  const deadline=Date.now()+5000;
  while((await client.board()).tasks.find(t=>t.id===claim.task_id)?.state!=='succeeded'){
    if(Date.now()>deadline)throw Error('Release not confirmed');await new Promise(resolve=>setTimeout(resolve,30));
  }
  report({type:'finished',claimId:claim.id,receipt});
} catch(error){report({type:'failed',message:error.message,code:error.code});process.exitCode=1;}
finally{if(client)try{await client.closeSession();}catch{}process.disconnect?.();}
