// SPDX-License-Identifier: MIT
// Deterministic protocol fixture, not an LLM harness. Runs as its own OS process.
import { AccordClient } from '../src/client.mjs';

process.once('message', async ({ url, credential, mode, taskId, leaseMs = 1600 }) => {
  const client = new AccordClient(url, credential);
  const delay = ms => new Promise(r => setTimeout(r, ms));
  try {
    let claim;
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      try { claim = await client.claim({ taskId, leaseMs }); break; }
      catch (e) { if (!['RESOURCE_BUSY','TASK_BUSY','NO_WORK','DEPENDENCY','PAUSED'].includes(e.code)) throw e; await delay(60); }
    }
    if (!claim) throw Error('No claim before deadline');
    while (claim.state === 'preparing') { await delay(30); claim = await client.inspect(claim.id); }
    if (claim.state !== 'running') throw Error(`Claim failed to activate: ${claim.state}`);
    process.send({ type: 'claimed', claim }); // private IPC; harness never writes credentials to evidence
    await client.checkpoint(claim.id, 'Read the input; next action is uppercase conversion.');
    if (mode === 'hold') {
      process.send({ type: 'checkpointed', claimId: claim.id });
      // Keep the process alive so the demonstration can kill it mid-task.
      setInterval(() => {}, 1000); return;
    }
    const receipt = await client.write(claim, claim.task.input.toUpperCase(), 'final-output');
    await client.finish(claim.id, receipt.id, `final-result:${claim.id}`);
    process.send({ type: 'finished', claimId: claim.id, generation: claim.generation, receipt, checkpoint: claim.task.checkpoint });
    process.disconnect();
  } catch (error) {
    process.send({ type: 'failed', code: error.code, message: error.message }); process.exitCode = 1; process.disconnect();
  }
});
