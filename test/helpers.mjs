// SPDX-License-Identifier: MIT
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialize } from '../src/config.mjs';
import { AccordClient } from '../src/client.mjs';
import { request,token } from '../src/common.mjs';

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function eventually(fn, timeout = 8000) {
  const until = Date.now() + timeout; let last;
  while (Date.now() < until) {
    try { const value = await fn(); if (value) return value; } catch (e) { last = e; }
    await delay(35);
  }
  throw Error(`Condition timed out${last ? ': '+last.message : ''}`);
}
export function launch(file, args = []) {
  const proc = fork(fileURLToPath(file), args, { stdio: ['ignore','ignore','pipe','ipc'] });
  proc.messages = []; proc.diagnostic = '';
  proc.on('message', message => proc.messages.push(message));
  proc.stderr.on('data', data => { proc.diagnostic = (proc.diagnostic + data.toString()).slice(-4000); });
  return proc;
}
export async function message(proc, type, timeout = 10000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = proc.messages.find(m => m.type === type);
    if (value) return value;
    const failure = proc.messages.find(m => m.type === 'failed');
    if (failure || proc.exitCode !== null || proc.signalCode !== null) throw Error(failure?.message || `Process exited: ${proc.diagnostic}`);
    await delay(25);
  }
  throw Error(`No ${type} message before deadline`);
}
export async function stop(proc, signal = 'SIGTERM') {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => proc.kill('SIGKILL'), 3000);
    proc.once('exit', () => { clearTimeout(timer); resolve(); }); proc.kill(signal);
  });
}
export async function harness({ leaderMs = 1500, dir = null } = {}) {
  const data = dir || mkdtempSync(join(tmpdir(), 'accord-test-'));
  initialize(data,{fixtures:true});
  const processes = [], credential = name => readFileSync(join(data, `${name}.token`), 'utf8');
  const h = { data, credential, processes, leaderMs };
  h.startDriver = async (port = 0) => {
    const proc = launch(new URL('../src/cli.mjs', import.meta.url), ['driver','--data',data,'--port',String(port)]);
    processes.push(proc); const ready = await message(proc, 'ready'); h.driver = proc; h.driverUrl = ready.url; h.driverInstance = ready.instance; return proc;
  };
  h.startServer = async (port = 0, driverUrl = h.driverUrl) => {
    // Windows ends a process without its shutdown handler, so the old lease has to lapse.
    if (h.server && process.platform === 'win32') await delay(leaderMs + 250);
    const proc = launch(new URL('../src/cli.mjs', import.meta.url), ['serve','--data',data,'--port',String(port),'--driver-url',driverUrl,'--leader-ms',String(leaderMs)]);
    processes.push(proc); const ready = await message(proc, 'ready'); h.server = proc; h.url = ready.url; return proc;
  };
  h.agent = (name, input) => {
    const proc = launch(new URL('../demo/agent.mjs', import.meta.url)); processes.push(proc);
    proc.send({ url:h.url,credential:credential(name),...input }); return proc;
  };
  h.client = name => new AccordClient(h.url, credential(name));
  h.active = async claim => eventually(async () => { const value=await h.client(claim.actor).inspect(claim.id); return value.state === 'running' && value; });
  h.close = async (remove = true) => { await Promise.all(processes.map(p => stop(p))); if (remove && !dir) rmSync(data, { recursive: true, force: true }); };
  try { await h.startDriver(); await h.startServer(); return h; } catch(e) { await h.close(); throw e; }
}
export async function link(a,b){
  const aa=(await a.client('admin').host()).authority,bb=(await b.client('admin').host()).authority,x=token(),y=token();
  await request(a.url,a.credential('admin'),'/v1/links',{key:randomUUID(),authority:bb,url:b.url,inbound:x,outbound:y});
  await request(b.url,b.credential('admin'),'/v1/links',{key:randomUUID(),authority:aa,url:a.url,inbound:y,outbound:x});
  return {aa,bb,x,y};
}
