// SPDX-License-Identifier: MIT
// Read-only check of the opt-in fixture, never a production data directory.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const [root,authority,tag]=process.argv.slice(2);
assert(/^\/tmp\/accord-thin\.[a-zA-Z0-9]+$/.test(root));assert(/^\d+$/.test(tag));
const data=readdirSync(root).filter(n=>n.startsWith('data-')).map(n=>join(root,n)).find(d=>JSON.parse(readFileSync(join(d,'config.json'))).authority===authority);assert(data);
const mailbox=new DatabaseSync(join(data,'messages.sqlite'),{readOnly:true}),coordinator=new DatabaseSync(join(data,'coordinator.sqlite'),{readOnly:true}),driver=new DatabaseSync(join(data,'process-qualify-slot.sqlite'),{readOnly:true});
try{
  const hello=mailbox.prepare('SELECT * FROM messages WHERE body=?').all('HELLO '+tag),done=mailbox.prepare('SELECT * FROM messages WHERE body=?').all('DONE '+tag),ack=coordinator.prepare("SELECT state FROM message_outbox WHERE json_extract(envelope,'$.text')=?").all('ACK '+tag);
  assert.equal(hello.length,1);assert.equal(done.length,1);assert.equal(ack.length,1);assert.equal(ack[0].state,'delivered');
  for(const m of [...hello,...done])assert.equal(mailbox.prepare('SELECT state FROM deliveries WHERE message_id=?').get(m.id).state,'acknowledged');
  const from=JSON.parse(hello[0].data_json).from,remoteActor='remote-'+createHash('sha256').update(from).digest('hex');
  const claims=coordinator.prepare('SELECT * FROM claims WHERE actor=?').all(remoteActor);assert.equal(claims.length,1);assert.equal(claims[0].state,'closed');assert.equal(claims[0].outcome,'released');
  const run=driver.prepare('SELECT * FROM runs WHERE claim_id=?').get(claims[0].id);assert(run);assert.equal(run.phase,'stopped');assert(run.stopped_at);
  const report={status:'passed',authority,tag,assertions:{helloStoredOnce:true,ackStoredOnce:true,doneStoredOnce:true,receiverMarkedBothMessagesRead:true,modelReservationReleased:true,modelWorkloadConfirmedStopped:true},claim:claims[0].id,run:run.id,stoppedAt:run.stopped_at};
  console.log(JSON.stringify(report,null,2));
}finally{mailbox.close();coordinator.close();driver.close();}
