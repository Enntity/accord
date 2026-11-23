// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MessengerStore } from '../vendor/messenger/store.js';
import { asPublicError } from '../vendor/messenger/errors.js';
import { Store } from '../src/store.mjs';
import { Collaboration } from '../src/collaboration.mjs';
import { Schedules } from '../src/schedules.mjs';
import { MessengerClaims, topicFor } from '../src/messenger-claims.mjs';

// A loopback Messenger with the real store's leases, receipts and reply rules
// behind the HTTP routes the claim uses.
async function messenger(t, dir) {
  const store = new MessengerStore(join(dir, 'messenger.sqlite'), { leaseMs: 60000 });
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = body ? JSON.parse(body) : {};
    try {
      const actor = store.authenticate(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
      let result, m;
      if (req.method === 'GET' && url.pathname === '/v1/me') result = actor;
      else if (req.method === 'GET' && url.pathname === '/v1/inbox') {
        const options = { limit: Number(url.searchParams.get('limit') ?? 20), deliveryId: url.searchParams.get('deliveryId') };
        result = { deliveries: url.searchParams.get('claim') === 'false' ? store.peekInbox(actor, options) : store.claimInbox(actor, options) };
      } else if (req.method === 'POST' && (m = /^\/v1\/deliveries\/([^/]+)\/(read|ack)$/.exec(url.pathname)))
        result = m[2] === 'read' ? store.markRead(actor, m[1], json) : store.acknowledge(actor, m[1], json);
      else if (req.method === 'POST' && (m = /^\/v1\/conversations\/([^/]+)\/messages$/.exec(url.pathname)))
        result = store.sendMessage(actor, { conversationId: m[1], ...json });
      else { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":{"code":"NOT_FOUND","message":"no route"}}'); }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
    } catch (error) {
      const { status, body: problem } = asPublicError(error);
      res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(problem));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); store.close?.(); }));
  const builder = store.createPrincipal({ handle: 'builder', displayName: 'Builder', kind: 'agent' });
  const peer = store.createPrincipal({ handle: 'peer', displayName: 'Peer', kind: 'agent' });
  const other = store.createPrincipal({ handle: 'other', kind: 'agent' });
  const tokenFile = join(dir, 'builder.token');
  writeFileSync(tokenFile, builder.token); chmodSync(tokenFile, 0o600);
  const otherFile = join(dir, 'other.token');
  writeFileSync(otherFile, other.token); chmodSync(otherFile, 0o600);
  const peerActor = store.authenticate(peer.token);
  const conversation = store.createConversation(peerActor, { members: ['builder'] });
  let n = 0;
  return {
    store, requests, tokenFile, otherFile, url: `http://127.0.0.1:${server.address().port}`, conversation,
    send: (body = `hello ${++n}`) => store.sendMessage(peerActor, { conversationId: conversation.id, clientMessageId: `peer-${++n}`, body }),
    history: () => store.listMessages?.(peerActor, conversation.id) ?? null,
    replies: (messageId) => store.db.prepare('SELECT * FROM messages WHERE reply_to=?').all(messageId),
  };
}

let serial = 0;
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'accord-messenger-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const m = await messenger(t, dir);
  let now = Date.now();
  const s = new Store(join(dir, 'coordinator.sqlite'), { now: () => now, leaderMs: 30000 });
  s.takeLeadership();
  s.provision('admin', 'admin', 'admin');
  s.provisionCredential('enroller', 'enroller', 'enroll');
  const c = new Collaboration(s, join(dir, 'coordinator.sqlite'));
  const sc = new Schedules(s, c);
  let principals = { builder: { tokenFile: m.tokenFile }, other: { tokenFile: m.otherFile } };
  const claims = new MessengerClaims(s, c, sc, { directory: dir, remindMs: 600000, config: () => ({ url: m.url, principals }) });
  t.after(async () => { await claims.close(); c.close(); s.close(); });
  const enroll = (label) => ({ id: s.openSession({ id: 'enroller' }, { key: `enroll:${++serial}`, label, harness: 'claude' }, () => `${serial}-secret`).sessionId, role: 'worker' });
  return {
    m, s, c, sc, claims, dir, enroll, admin: { id: 'admin', role: 'admin' },
    advance: (ms) => { now += ms; s.db.prepare('UPDATE leader SET until_ms=?').run(now + 30000); },
    setPrincipals: (p) => { principals = p; },
    topics: () => s.db.prepare("SELECT data FROM events WHERE kind='topic.published'").all().map(r => JSON.parse(r.data)),
    fired: () => s.db.prepare('SELECT * FROM message_outbox ORDER BY created_at').all().map(r => JSON.parse(r.envelope)),
    addr: (actor) => `${s.authority}/${actor.id}`,
  };
}

test('a claim proves the token, creates a persistent wake schedule and refuses a second holder', async (t) => {
  const f = await fixture(t);
  const a = f.enroll('Claude A'), b = f.enroll('Claude B');
  const claimed = await f.claims.claim(a, { key: 'k1', principal: 'builder' });
  assert.equal(claimed.holder, f.addr(a));
  assert.equal(claimed.topic, 'messenger:builder');
  const schedule = f.sc.list(a).schedules[0];
  assert.equal(schedule.id, claimed.schedule);
  assert.equal(schedule.persistent, true);
  assert.equal(schedule.delivery, 'native-prompt');
  assert.equal(schedule.trigger, 'topic:messenger:builder');
  assert.deepEqual(await f.claims.claim(a, { key: 'k2', principal: 'builder' }), { ...claimed, lastPollAt: f.claims.view(f.claims.row('builder')).lastPollAt, waiting: f.claims.view(f.claims.row('builder')).waiting }, 'reclaiming is idempotent');
  await assert.rejects(f.claims.claim(b, { key: 'k3', principal: 'builder' }), e => e.code === 'CLAIM_HELD' && e.message.includes(f.addr(a)));
  await assert.rejects(f.claims.claim(b, { key: 'k4', principal: 'missing' }), e => e.code === 'MESSENGER_UNKNOWN');
  assert.equal(f.claims.list().claims.length, 1);
});

test('a token that authenticates as another identity is refused', async (t) => {
  const f = await fixture(t);
  f.setPrincipals({ builder: { tokenFile: f.m.otherFile } });
  await assert.rejects(f.claims.claim(f.enroll('A'), { key: 'k', principal: 'builder' }), e => e.code === 'IDENTITY_MISMATCH');
  assert.equal(f.claims.list().claims.length, 0);
  assert.equal(f.s.db.prepare("SELECT count(*) n FROM schedules WHERE state='active'").get().n, 0);
});

test('waiting mail publishes the topic once without taking leases, and the schedule wakes the holder', async (t) => {
  const f = await fixture(t);
  const a = f.enroll('Claude A');
  await f.claims.claim(a, { key: 'k', principal: 'builder' });
  await f.claims.poll();
  assert.equal(f.topics().length, 0, 'an empty inbox publishes nothing');
  f.m.send('first');
  await f.claims.poll(); await f.claims.poll();
  assert.deepEqual(f.topics(), [{ topic: topicFor('builder'), text: '1 waiting', actor: 'accord-messenger' }]);
  assert(f.m.requests.filter(r => r.startsWith('GET /v1/inbox')).every(r => r.includes('claim=false')), 'the watcher only peeks');
  assert.equal(f.m.store.db.prepare("SELECT state FROM deliveries").get().state, 'pending');
  f.sc.tick();
  const wake = f.fired().at(-1);
  assert.equal(wake.to, f.addr(a));
  assert.equal(wake.delivery, 'native-prompt');
  assert.match(wake.text, /Messenger mail is waiting for builder.*accord_messenger_inbox/);
  assert(!wake.text.includes('first'), 'peer text never enters the wake');
  f.m.send('second');
  await f.claims.poll();
  assert.equal(f.topics().length, 2, 'new mail publishes again');
  f.advance(600000);
  await f.claims.poll();
  assert.equal(f.topics().length, 3, 'unhandled mail is a reminder after remindMs');
  assert.equal(f.claims.view(f.claims.row('builder')).waiting, 2);
});

test('the holder reads, replies once in-thread and acknowledges; others are refused', async (t) => {
  const f = await fixture(t);
  const a = f.enroll('Claude A'), b = f.enroll('Claude B');
  await f.claims.claim(a, { key: 'k', principal: 'builder' });
  const sent = f.m.send('Can you check the build?');
  await assert.rejects(f.claims.inbox(b), e => e.code === 'NOT_HOLDER');
  const { messages, note } = await f.claims.inbox(a);
  assert.match(note, /untrusted/);
  assert.equal(messages.length, 1);
  const [mail] = messages;
  assert.equal(mail.messageId, sent.id);
  assert.equal(mail.body, 'Can you check the build?');
  assert.deepEqual(mail.from, { handle: 'peer', displayName: 'Peer', kind: 'agent' });
  assert.equal(mail.leaseToken, undefined, 'Accord keeps the lease token');
  assert.equal(f.m.store.db.prepare('SELECT state FROM deliveries WHERE id=?').get(mail.deliveryId).state, 'read');
  await assert.rejects(f.claims.reply(b, { deliveryId: mail.deliveryId, body: 'no' }), e => e.code === 'NOT_HOLDER');
  const reply = await f.claims.reply(a, { deliveryId: mail.deliveryId, body: 'On it.' });
  assert.equal(reply.acknowledged, true);
  const replies = f.m.replies(sent.id);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].body, 'On it.');
  assert.equal(f.m.store.db.prepare('SELECT state FROM deliveries WHERE id=?').get(mail.deliveryId).state, 'acknowledged');
  await assert.rejects(f.claims.reply(a, { deliveryId: mail.deliveryId, body: 'again' }), e => e.code === 'NOT_FOUND');
  assert.equal(f.m.replies(sent.id).length, 1);
});

test('a retried reply cannot answer twice, and ack-only settles without sending', async (t) => {
  const f = await fixture(t);
  const a = f.enroll('Claude A');
  await f.claims.claim(a, { key: 'k', principal: 'builder' });
  const first = f.m.send('one'), second = f.m.send('two');
  const { messages } = await f.claims.inbox(a);
  // A lost response: Messenger stored the reply but Accord never saw it, so the
  // lease row survives and the agent retries.
  const lease = f.s.db.prepare('SELECT * FROM messenger_leases WHERE message_id=?').get(first.id);
  await f.claims.reply(a, { deliveryId: messages[0].deliveryId, body: 'yes' });
  f.s.db.prepare('INSERT INTO messenger_leases VALUES(?,?,?,?,?,?,?)').run(lease.delivery_id, lease.principal, lease.message_id, lease.conversation_id, lease.lease_token, lease.lease_expires_at, lease.created_at);
  const retried = await f.claims.reply(a, { deliveryId: messages[0].deliveryId, body: 'yes' });
  assert.equal(retried.acknowledged, true);
  assert.equal(f.m.replies(first.id).length, 1);
  const ackOnly = await f.claims.reply(a, { deliveryId: messages[1].deliveryId });
  assert.equal(ackOnly.replied, false);
  assert.equal(f.m.replies(second.id).length, 0);
  assert.equal(f.m.store.db.prepare("SELECT count(*) n FROM deliveries WHERE state='acknowledged'").get().n, 2);
});

test('the claim follows a successor, ends with a holder that has none, and release ends the schedule', async (t) => {
  const f = await fixture(t);
  const a = f.enroll('Claude A'), a2 = f.enroll('Claude A resumed'), b = f.enroll('Claude B');
  await f.claims.claim(a, { key: 'k', principal: 'builder' });
  f.s.db.prepare("UPDATE sessions SET retired_at=?,retired_reason='superseded',successor=? WHERE id=?").run(Date.now(), a2.id, a.id);
  f.s.emit('session.retired', { session: a.id, reason: 'superseded', successor: a2.id });
  f.sc.tick();
  assert.equal(f.claims.list().claims[0].holder, f.addr(a2));
  assert.equal(f.sc.list(a2).schedules.filter(s => s.state === 'active').length, 1, 'the successor inherits the wake schedule');
  f.m.send('for the successor');
  assert.equal((await f.claims.inbox(a2)).messages.length, 1);

  f.s.db.prepare("UPDATE sessions SET retired_at=?,retired_reason='tile-closed' WHERE id=?").run(Date.now(), a2.id);
  f.s.emit('session.retired', { session: a2.id, reason: 'tile-closed' });
  f.sc.tick();
  assert.equal(f.claims.list().claims.length, 0, 'no successor ends the claim');
  assert.equal(f.s.db.prepare('SELECT count(*) n FROM messenger_leases').get().n, 0);
  const again = await f.claims.claim(b, { key: 'k', principal: 'builder' });
  assert.equal(again.holder, f.addr(b));
  assert.deepEqual(await f.claims.claim(b, { key: 'r', principal: 'builder', release: true }), { released: true, principal: 'builder' });
  assert.equal(f.sc.list(b).schedules[0].state, 'cancelled');
  assert.equal(f.claims.list().claims.length, 0);
  await assert.rejects(f.claims.claim(b, { key: 'k', principal: 'builder' }), e => e.code === 'KEY_REUSED', 'an ended claim key is not reused');
});

test('mail from before the claim stays in Messenger unless the claim asks for the backlog', async (t) => {
  const f = await fixture(t);
  const a = f.enroll('Claude A'), b = f.enroll('Claude B');
  const old = f.m.send('from last week');
  f.m.store.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', old.id);
  await f.claims.claim(a, { key: 'k', principal: 'builder' });
  await f.claims.poll();
  assert.equal(f.topics().length, 0, 'the backlog does not wake the holder');
  const fresh = f.m.send('new today');
  await f.claims.poll();
  assert.equal(f.topics().length, 1);
  const { messages } = await f.claims.inbox(a);
  assert.deepEqual(messages.map(m => m.messageId), [fresh.id], 'only post-claim mail');
  assert.equal(f.m.store.db.prepare('SELECT state FROM deliveries WHERE message_id=?').get(old.id).state, 'pending', 'the backlog is untouched');
  await f.claims.claim(a, { key: 'r', principal: 'builder', release: true });
  const withBacklog = await f.claims.claim(b, { key: 'k2', principal: 'builder', backlog: true });
  assert.equal(withBacklog.backlog, true);
  assert.deepEqual((await f.claims.inbox(b)).messages.map(m => m.messageId), [old.id]);
});

test('tokens never reach events, claims, schedules or tool results', async (t) => {
  const f = await fixture(t);
  const a = f.enroll('Claude A');
  const token = readFileSync(f.m.tokenFile, 'utf8').trim();
  await f.claims.claim(a, { key: 'k', principal: 'builder' });
  f.m.send('hi');
  await f.claims.poll();
  const { messages } = await f.claims.inbox(a);
  const results = JSON.stringify([f.claims.list(), messages, await f.claims.reply(a, { deliveryId: messages[0].deliveryId, body: 'ok' })]);
  const stored = JSON.stringify([
    f.s.db.prepare('SELECT * FROM events').all(), f.s.db.prepare('SELECT * FROM schedules').all(),
    f.s.db.prepare('SELECT * FROM messenger_claims').all(), f.s.db.prepare('SELECT * FROM message_outbox').all(),
  ]);
  assert(!results.includes(token) && !stored.includes(token));
});
