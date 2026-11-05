// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { harness, eventually, stop, delay } from "./helpers.mjs";
import { request, token } from "../src/common.mjs";
import { AccordClient, withReservation } from "../src/client.mjs";

test("native inbox binding survives reconnect; only host adapter can bind or acknowledge", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const admin = h.client("admin"),
    sender = h.client("agent-a"),
    authority = (await admin.host()).authority;
  const enroll = () =>
    AccordClient.enroll(h.url, h.credential("bootstrap"), {
      authority,
      label: "same label",
    });
  const first = await enroll(),
    next = await enroll();
  const native = await admin.collaborate("session-report", {
    key: "import",
    source: "codex",
    externalId: "native-id",
    title: "Observed session",
    state: "working",
  });
  const bind = {
    source: "codex",
    externalId: "native-id",
    actor: first.session.sessionId,
    key: "bind-one",
  };
  await assert.rejects(first.collaborate("session-bind", bind), {
    code: "FORBIDDEN",
  });
  await admin.collaborate("session-bind", bind);
  await sender.bootstrap();
  await sender.send(native.address, "Durable native check-in");
  const delivery = await eventually(
    async () => (await first.inbox()).messages[0],
  );
  assert.equal((await next.inbox()).messages.length, 0);
  await admin.collaborate("session-bind", {
    ...bind,
    actor: next.session.sessionId,
    key: "bind-two",
  });
  await assert.rejects(first.read(delivery.deliveryId));
  assert.equal(
    (await next.inbox()).messages[0].deliveryId,
    delivery.deliveryId,
  );
  await next.collaborate("session-snooze", {
    key: "snooze",
    id: native.id,
    until: Date.now() + 60000,
  });
  const port = Number(new URL(h.url).port);
  await stop(h.server, "SIGKILL");
  await delay(h.leaderMs + 100);
  await h.startServer(port);
  assert.equal(
    (await next.inbox()).messages[0].deliveryId,
    delivery.deliveryId,
  );
  await next.read(delivery.deliveryId);
  assert.equal((await next.inbox()).messages.length, 0);
  await admin.collaborate("source-privacy", {
    key: "private",
    source: "codex",
    private: true,
  });
  await sender.send(native.address, "private delivery");
  await delay(1100);
  assert.equal((await next.inbox()).messages.length, 0);
});

test("linked hosts search and read redacted sessions, jobs and questions without impersonating owners", async (t) => {
  const a = await harness(),
    b = await harness();
  t.after(async () => {
    await a.close();
    await b.close();
  });
  const aa = (await a.client("admin").host()).authority,
    bb = (await b.client("admin").host()).authority,
    x = token(),
    y = token();
  await request(a.url, a.credential("admin"), "/v1/links", {
    key: randomUUID(),
    authority: bb,
    url: b.url,
    inbound: x,
    outbound: y,
  });
  await request(b.url, b.credential("admin"), "/v1/links", {
    key: randomUUID(),
    authority: aa,
    url: a.url,
    inbound: y,
    outbound: x,
  });
  await request(b.url, b.credential("admin"), "/v1/links/share", {
    key: randomUUID(),
    authority: aa,
    share: true,
  });
  await request(a.url, a.credential("admin"), "/v1/links/share", {
    key: randomUUID(),
    authority: bb,
    share: true,
  });
  const ca = a.client("agent-a"),
    cb = b.client("agent-b");
  await cb.announce({ label: "Remote parser", activity: "Parser review" });
  await cb.collaborate("session-report", {
    key: "report",
    title: "Remote parser",
    state: "waiting",
    events: [
      { key: "e", text: "Investigating tokenizer password=fixturesecret" },
    ],
  });
  const found = await ca.collaborate("sessions", { query: "tokenizer" });
  assert.equal(found.sessions.length, 1);
  const read = await ca.collaborate(
    "session-read",
    { id: found.sessions[0].id },
    bb,
  );
  assert(!JSON.stringify(read).includes("fixturesecret"));
  assert.equal(read.session.state, "waiting");
  await cb.collaborate("job", { key: "job", title: "Parser verification" });
  assert.equal((await ca.collaborate("jobs", {}, bb)).jobs.length, 1);
  await assert.rejects(
    ca.collaborate(
      "session-snooze",
      { key: "bad", id: read.session.id, until: Date.now() + 60000 },
      bb,
    ),
    { code: "FORBIDDEN" },
  );
  const q = await cb.collaborate("ask", {
    key: "question",
    question: "Select parser",
    options: ["A", "B"],
  });
  await assert.rejects(ca.collaborate("question", { id: q.id }, bb), {
    code: "FORBIDDEN",
  });
  await b
    .client("admin")
    .collaborate("answer", { key: "answer", id: q.id, answer: "B" });
  assert.equal((await cb.collaborate("question", { id: q.id })).answer, "B");
});

test("lease helper waits for confirmed release and cleans up callback failures", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const client = h.client("agent-a");
  let id;
  await assert.rejects(
    withReservation(client, "artifact", async ({ reservationId }) => {
      id = reservationId;
      throw Error("work failed");
    }),
    /work failed/,
  );
  assert.equal((await client.reservation(id)).state, "released");
});
test("lease helper retains acquisition key through lost replies and reports unconfirmed release", async () => {
  let calls = 0,
    key,
    started = false;
  const client = {
    reserve: async (_r, args) => {
      key ??= args.key;
      assert.equal(key, args.key);
      if (calls++ === 0) throw Error("lost reply");
      return { id: "one" };
    },
    reservation: async () => ({ state: "running" }),
    collaborate: async (operation) => { assert.equal(operation, "renew"); return {}; },
    release: async () => ({ state: "releasing" }),
  };
  await assert.rejects(
    withReservation(
      client,
      "slot",
      async () => {
        started = true;
      },
      { releaseWaitMs: 1 },
    ),
    /release is unconfirmed/,
  );
  assert(started);
  assert.equal(calls, 2);
});

test('native UI delivery follows the bound agent identity instead of a second mailbox',async t=>{
  const h=await harness();t.after(()=>h.close());const admin=h.client('admin'),sender=h.client('agent-a');
  const authority=(await admin.host()).authority;
  const agent=await AccordClient.enroll(h.url,h.credential('bootstrap'),{authority,label:'Native CLI'});
  await agent.announce({label:'Native CLI',activity:'Working'});await sender.bootstrap();
  const native=await admin.collaborate('session-report',{key:'native',source:'tessera',externalId:'terminal',title:'Native terminal',state:'working'});
  await admin.collaborate('session-bind',{key:'bind',source:'tessera',externalId:'terminal',actor:agent.session.sessionId});
  await sender.send(`${authority}/${agent.session.sessionId}`,'Please check progress',{delivery:'native-prompt'});
  const incoming=await eventually(async()=> (await admin.collaborate('bridge-inbox',{source:'tessera'})).deliveries[0]);
  assert.equal(incoming.externalId,'terminal');assert.equal(incoming.delivery,'native-prompt');
  assert.equal((await agent.inbox()).messages[0].deliveryId,incoming.deliveryId);
  assert.equal((await admin.collaborate('bridge-inbox',{source:'tessera'})).deliveries[0].deliveryId,incoming.deliveryId,'display does not acknowledge');
  await agent.read(incoming.deliveryId);
  assert.equal((await agent.inbox()).messages.length,0);
});

test('operator notifications are durable and legacy session bridges are absent',async t=>{
  const h=await harness();t.after(()=>h.close());const admin=h.client('admin'),agent=h.client('agent-a');
  await agent.bootstrap();await agent.collaborate('notify',{key:'note',text:'Review complete'});
  const note=await eventually(async()=> (await admin.inbox()).messages[0]);
  assert.equal(note.text,'Review complete');assert.equal(note.delivery,'inbox');
  const port=Number(new URL(h.url).port);await stop(h.server,'SIGKILL');await delay(h.leaderMs+100);await h.startServer(port);
  assert.equal((await admin.inbox()).messages[0].deliveryId,note.deliveryId);
  for(const operation of ['bridge-send','bridge-ask','bridge-notify','bridge-messages','bridge-read','bridge-import'])
    await assert.rejects(admin.collaborate(operation,{}));
});
