// SPDX-License-Identifier: MIT
// Agents set up through their own files. Each gets the MCP server, startup instructions
// and, where it can't already see ~/.agents/skills, the skill. Hooks stay Claude and Codex
// only: a wake needs an interface these agents don't share.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { requireThat } from './common.mjs';

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const differs=name=>requireThat(false,'INSTALL_CONFLICT',`Existing ${name} Accord MCP registration differs`);

function json(name,keys,entry) {
  return old=>{
    const config=old===null?{}:JSON.parse(old);let node=config;
    for(const key of keys)node=node[key]??={};
    if(node.accord&&!same(node.accord,entry))differs(name);
    node.accord=entry;return JSON.stringify(config,null,2)+'\n';
  };
}
function toml({command,args}) {
  const block=`[mcp_servers.accord]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\nenabled = true\n`;
  return old=>{
    if(old?.includes(block))return old;
    if(old?.includes('[mcp_servers.accord]'))differs('Grok');
    return (old?old.replace(/\n*$/,'\n\n'):'')+block;
  };
}
// JSON strings and arrays are valid YAML, so paths with spaces need no YAML writer.
function yamlMap({command,args}) {
  const entry=indent=>`${indent}accord:\n${indent}${indent}command: ${JSON.stringify(command)}\n${indent}${indent}args: ${JSON.stringify(args)}\n`;
  return old=>{
    const text=old??'',section=text.match(/^mcp_servers:(.*)\n?((?:[ \t]+.*\n?|\n)*)/m);
    if(!section)return (text?text.replace(/\n*$/,'\n\n'):'')+'mcp_servers:\n'+entry('  ');
    requireThat(!section[1].trim(),'INSTALL_CONFLICT','Hermes mcp_servers is not a block mapping');
    const indent=section[2].match(/^([ \t]+)\S/m)?.[1]??'  ';
    if(text.includes(entry(indent)))return text;
    if(new RegExp(`^${indent}accord:`,'m').test(section[2]))differs('Hermes');
    const at=section.index+section[0].length-section[2].length;
    return text.slice(0,at)+(text[at-1]==='\n'?'':'\n')+entry(indent)+text.slice(at);
  };
}
// A home-level patch reaches every profile, so `dsh`, `dsh web` and the desktop app share it.
function dshPatch({command,args}) {
  const entry=`- insert:\n    - id: mcp-accord\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: accord\n        transport: stdio\n        command: ${JSON.stringify(command)}\n        args: ${JSON.stringify(args)}\n        toolCallTimeoutMs: 60000\n`;
  return old=>{
    if(old?.includes(entry))return old;
    if(old?.includes('id: mcp-accord'))differs('DeepSeek Harness');
    return (old?old.replace(/\n*$/,'\n'):'')+entry;
  };
}

const dshHome=(home,env)=>env.DSH_HOME||join(home,'.dsh');
const zcodeRoots=home=>[join(home,'.zcode'),join(home,'.enntity-zcode')];
export const agentClients={
  opencode:{installed:home=>[join(home,'.config','opencode')],setups(home,registration){
    const root=join(home,'.config','opencode');
    return [{path:join(root,'opencode.json'),merge:json('OpenCode',['mcp'],{type:'local',command:[registration.command,...registration.args],enabled:true}),instructions:join(root,'AGENTS.md')}];
  }},
  grok:{installed:home=>[join(home,'.grok')],setups(home,registration){
    const root=join(home,'.grok');
    return [{path:join(root,'config.toml'),merge:toml(registration),instructions:join(root,'rules','accord.md'),skill:join(root,'skills','accord','SKILL.md')}];
  }},
  omp:{installed:home=>[join(home,'.omp')],setups(home,registration){
    const root=join(home,'.omp','agent');
    return [{path:join(root,'mcp.json'),merge:json('OMP',['mcpServers'],{type:'stdio',...registration}),instructions:join(root,'AGENTS.md')}];
  }},
  hermes:{installed:home=>[join(home,'.hermes')],setups(home,registration){
    const root=join(home,'.hermes');
    return [{path:join(root,'config.yaml'),merge:yamlMap(registration),instructions:join(root,'SOUL.md'),skill:join(root,'skills','coordination','accord','SKILL.md')}];
  }},
  zcode:{installed:zcodeRoots,setups(home,registration){
    const roots=zcodeRoots(home).filter(root=>existsSync(root));
    return (roots.length?roots:[zcodeRoots(home)[0]]).map(root=>({path:join(root,'cli','config.json'),instructions:join(root,'AGENTS.md'),
      merge:json('ZCode',['mcp','servers'],{type:'stdio',...registration,enabled:true,timeoutMs:30000})}));
  }},
  dsh:{installed:(home,env)=>[dshHome(home,env)],setups(home,registration,env){
    const root=dshHome(home,env);
    return [{path:join(root,'cordis.patch.yml'),merge:dshPatch(registration),instructions:join(root,'AGENTS.md')}];
  }},
};
export function detectClients(home,env=process.env) {
  return [...existsSync(join(home,'.config','devin'))?['devin']:[],
    ...Object.keys(agentClients).filter(client=>agentClients[client].installed(home,env).some(path=>existsSync(path)))];
}
