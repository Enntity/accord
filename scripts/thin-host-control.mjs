// SPDX-License-Identifier: MIT
// Opt-in fixture host for SSH qualification; never touches the installed service.
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harness, stop, delay } from '../test/helpers.mjs';
import { install } from '../src/installer.mjs';
import { groupExists } from '../src/plugins/posix-process-group.mjs';
import { request } from '../src/common.mjs';
const data=process.argv[2];
if(!data?.startsWith('/tmp/accord-thin.'))throw Error('Use an explicit temporary qualification directory');
const h=await harness({dir:data}),serverPort=Number(new URL(h.url).port),driverPort=Number(new URL(h.driverUrl).port),groups=[];
const installed=install({home:join(data,'home'),data,clients:[]});
await h.client('admin').registerResource({schema:1,id:'qualify-slot',asset:'qualification:cpu-only',plugin:'posix-process-group',command:[process.execPath,fileURLToPath(new URL('../test/fixtures/workload.mjs',import.meta.url)),'tree'],cwd:data,env:{},terminationGraceMs:80});
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
send({ready:true,data,url:h.url,authority:(await h.client('admin').host()).authority,profile:installed.profile});
try{
  for await(const line of createInterface({input:process.stdin})){
    const {id,action,...body}=JSON.parse(line);
    try{
      let result;
      if(action==='kill-driver'){await stop(h.driver,'SIGKILL');result={stopped:true};}
      else if(action==='start-driver'){await h.startDriver(driverPort);result={started:true};}
      else if(action==='restart-server'){await stop(h.server,'SIGKILL');await delay(h.leaderMs+100);await h.startServer(serverPort);result={started:true};}
      else if(action==='group'){if(!groups.includes(body.pgid))groups.push(body.pgid);result={exists:groupExists(body.pgid)};}
      else if(action==='board')result=await h.client('admin').board();
      else if(action==='audit')result=await request(h.driverUrl,h.credential('driver-control'),'/control/audit?resource=qualify-slot');
      else throw Error('Unknown fixture operation');
      send({id,result});
    }catch(e){send({id,error:e.message});}
  }
}finally{for(const pgid of groups)try{process.kill(-pgid,'SIGKILL');}catch{}await h.close(false);}
