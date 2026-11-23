// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.mjs";
import { Collaboration } from "../src/collaboration.mjs";
import { SessionAwareness } from "../src/session-awareness.mjs";
import { Schedules } from "../src/schedules.mjs";
import { hash } from "../src/common.mjs";
import { harness, link, eventually, stop } from "./helpers.mjs";

let serial = 0;
function fixture(t, { dir = mkdtempSync(join(tmpdir(), "accord-sched-")) } = {}) {
  const file = join(dir, "coordinator.sqlite");
  let now = 1_000_000;
  const s = new Store(file, { now: () => now, leaderMs: 30000 });
  s.takeLeadership();
  s.provision("admin", "admin", "admin");
  s.provision("a", "a", "worker");
  s.provision("b", "b", "worker");
  s.provisionCredential("enroller", "enroller", "enroll");
  const admin = { id: "admin", role: "admin" }, a = { id: "a", role: "worker" }, b = { id: "b", role: "worker" };
  const v = new SessionAwareness(s);
  const c = new Collaboration(s, file);
  const sc = new Schedules(s, c);
  let closed = false;
  const closeAll = () => { if (closed) return; closed = true; c.close(); s.close(); };
  t.after(() => {
    closeAll();
    if (!dir.includes("restart")) rmSync(dir, { recursive: true, force: true });
  });
  const enroll = (label = "Fixture agent") =>
    s.openSession({ id: "enroller" }, { key: `enroll:${++serial}`, label, harness: "codex" }, () => `${serial}-secret`).sessionId;
  return {
    s, v, c, sc, admin, a, b, enroll, dir, file, closeAll,
    now: () => now,
    advance: (ms) => { now += ms; s.db.prepare("UPDATE leader SET until_ms=?").run(now + 30000); },
    outbox: () => s.db.prepare("SELECT * FROM message_outbox ORDER BY created_at").all().map((r) => ({ ...r, envelope: JSON.parse(r.envelope) })),
  };
}
const addr = (f, id) => `${f.s.authority}/${id}`;

test("create, list and cancel; owner-only view with admin all", (t) => {
  const f = fixture(t);
  const first = f.sc.create(f.a, { key: "k1", text: "check later", inMs: 60000 });
  assert.equal(first.state, "active");
  assert.equal(first.to, addr(f, "a"));
  assert.equal(first.nextAt, f.now() + 60000);
  const second = f.sc.create(f.b, { key: "k2", text: "b's", inMs: 60000 });
  assert.deepEqual(f.sc.list(f.a).schedules.map((s) => s.id), [first.id]);
  assert.equal(f.sc.list(f.admin, { all: true }).schedules.length, 2);
  assert.throws(() => f.sc.list(f.b, { all: true }), (e) => e.code === 'FORBIDDEN');
  assert.throws(() => f.sc.cancel(f.b, { id: first.id }), (e) => e.code === 'NOT_OWNER');
  assert.equal(f.sc.cancel(f.a, { id: first.id }).state, "cancelled");
  assert.equal(f.sc.cancel(f.admin, { id: second.id }).endedReason, "cancelled");
});

test("key idempotency returns the same schedule and rejects a changed payload", (t) => {
  const f = fixture(t);
  const one = f.sc.create(f.a, { key: "same", text: "again", inMs: 60000 });
  const two = f.sc.create(f.a, { key: "same", text: "again", inMs: 60000 });
  assert.equal(one.id, two.id);
  assert.throws(() => f.sc.create(f.a, { key: "same", text: "different", inMs: 60000 }), (e) => e.code === 'KEY_REUSED');
});

test("limits: 50 active per owner, text cap, expiry cap, everyMs floor", (t) => {
  const f = fixture(t);
  assert.throws(() => f.sc.create(f.a, { key: "long", text: "x".repeat(2001), inMs: 60000 }), (e) => e.code === 'INVALID_INPUT');
  assert.throws(() => f.sc.create(f.a, { key: "cap", text: "x", inMs: 60000, expiresInMs: 31 * 86400000 }), (e) => e.code === 'INVALID_INPUT');
  assert.throws(() => f.sc.create(f.a, { key: "fast", text: "x", everyMs: 30000 }), (e) => e.code === 'INVALID_INPUT');
  assert.throws(() => f.sc.create(f.a, { key: "none", text: "x" }), (e) => e.code === 'INVALID_INPUT');
  assert.throws(() => f.sc.create(f.a, { key: "two", text: "x", inMs: 60000, everyMs: 60000 }), (e) => e.code === 'INVALID_INPUT');
  for (let i = 0; i < 50; i++) f.sc.create(f.a, { key: `s${i}`, text: "x", inMs: 60000 });
  assert.throws(() => f.sc.create(f.a, { key: "overflow", text: "x", inMs: 60000 }), (e) => e.code === 'SCHEDULE_LIMIT');
  // Admin is exempt from the per-owner cap.
  f.sc.create(f.admin, { key: "adm", text: "x", inMs: 60000 });
});

test("an at schedule fires once from accord-scheduler with scheduledBy and a deterministic id", (t) => {
  const f = fixture(t);
  const sched = f.sc.create(f.a, { key: "at", text: "ping yourself", inMs: 60000, wake: true });
  f.advance(61000);
  assert.equal(f.sc.tick(), true);
  const row = f.s.db.prepare("SELECT * FROM schedules WHERE id=?").get(sched.id);
  assert.equal(row.state, "done");
  assert.equal(row.fired_count, 1);
  const [mail] = f.outbox();
  assert.equal(mail.envelope.id, hash(`${sched.id}:1`));
  assert.equal(mail.envelope.from, `${f.s.authority}/accord-scheduler`);
  assert.equal(mail.envelope.scheduledBy, addr(f, "a"));
  assert.equal(mail.envelope.scheduleId, sched.id);
  assert.equal(mail.envelope.delivery, "native-prompt");
  assert.match(mail.envelope.text, /^Scheduled by a \(sched-/);
  assert.match(mail.envelope.text, /: ping yourself$/);
  // The second tick changes nothing; a retry could not double-send anyway
  // (INSERT OR IGNORE on the deterministic id).
  f.advance(60000);
  f.sc.tick();
  assert.equal(f.outbox().length, 1);
  // Delivered, the inbox data carries scheduledBy for adapter wake policy.
  f.c.announce(f.a, { key: 'ann', label: 'a', activity: 'testing' });
  f.c.deliver(mail.envelope);
  const inbox = f.c.inbox({ id: "a", role: "worker" });
  assert.equal(inbox.messages[0].scheduledBy, addr(f, "a"));
});

test("an interval schedule repeats and stops at maxFires", (t) => {
  const f = fixture(t);
  const sched = f.sc.create(f.a, { key: "every", text: "tick", everyMs: 60000, maxFires: 2 });
  assert.equal(sched.trigger, "every 1m");
  for (let i = 0; i < 2; i++) {
    f.advance(61000);
    f.sc.tick();
  }
  const row = f.s.db.prepare("SELECT * FROM schedules WHERE id=?").get(sched.id);
  assert.equal(row.state, "done");
  assert.equal(row.fired_count, 2);
  f.advance(61000);
  f.sc.tick();
  assert.equal(f.outbox().length, 2);
});

test("expiry ends an active schedule before it can fire", (t) => {
  const f = fixture(t);
  const sched = f.sc.create(f.a, { key: "exp", text: "x", inMs: 30000, expiresInMs: 60000 });
  f.advance(61000);
  f.sc.tick();
  const row = f.s.db.prepare("SELECT * FROM schedules WHERE id=?").get(sched.id);
  assert.equal(row.state, "expired");
  assert.equal(row.ended_reason, "expired");
  assert.equal(f.outbox().length, 0);
});

test("a restart during downtime fires once and reports lateness", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "accord-sched-restart-"));
  const f = fixture(t, { dir });
  const sched = f.sc.create(f.a, { key: "down", text: "missed", at: f.now() + 60000 });
  f.s.releaseLeadership();
  f.closeAll();
  // Reopen on the same database five minutes later.
  let now = f.now() + 300000;
  const s2 = new Store(f.file, { now: () => now, leaderMs: 30000 });
  s2.takeLeadership();
  const c2 = new Collaboration(s2, f.file);
  const sc2 = new Schedules(s2, c2);
  t.after(() => { c2.close(); s2.close(); rmSync(dir, { recursive: true, force: true }); });
  sc2.tick();
  const row = s2.db.prepare("SELECT * FROM schedules WHERE id=?").get(sched.id);
  assert.equal(row.state, "done");
  const mail = s2.db.prepare("SELECT envelope FROM message_outbox").all().map((r) => JSON.parse(r.envelope));
  assert.equal(mail.length, 1);
  assert.match(mail[0].text, /\(late by 4m\)/);
});

test("reservation triggers fire on claim.active and claim.released, honoring states and resource lookup", (t) => {
  const f = fixture(t);
  f.s.db.prepare("INSERT INTO resources(id) VALUES('gpu0')").run();
  f.s.db.prepare("INSERT INTO tasks VALUES('t1','t','i','h','gpu0',NULL,'running',NULL,NULL,?,1,'task')").run(f.now());
  f.s.db.prepare("INSERT INTO claims VALUES('c1','t1','gpu0','a',1,'running',?,NULL,NULL,NULL,?)").run(f.now() + 60000, f.now());
  const both = f.sc.create(f.a, { key: "r1", text: "reservation changed", on: { event: "reservation", resource: "gpu0" } });
  const onlyActive = f.sc.create(f.a, { key: "r2", text: "activated", on: { event: "reservation", resource: "gpu0", states: ["active"] } });
  assert.throws(() => f.sc.create(f.a, { key: "r3", text: "x", on: { event: "reservation", resource: "ghost" } }), (e) => e.code === 'NOT_FOUND');
  f.s.emit("claim.active", { claim: "c1" }); // resource resolved through claims
  f.sc.tick();
  assert.equal(f.outbox().length, 2);
  assert.match(f.outbox()[0].envelope.text + f.outbox()[1].envelope.text, /claim\.active c1/);
  f.advance(61000);
  f.s.emit("claim.released", { claim: "c1", resource: "gpu0", outcome: "succeeded" });
  f.sc.tick();
  const mails = f.outbox();
  assert.equal(mails.length, 3); // only the both-states schedule fired
  assert.match(mails[2].envelope.text, /claim\.released c1/);
  assert.equal(f.s.db.prepare("SELECT pending_events FROM schedules WHERE id=?").get(both.id).pending_events, 0);
  assert.equal(f.s.db.prepare("SELECT fired_count FROM schedules WHERE id=?").get(onlyActive.id).fired_count, 1);
});

test("job triggers fire on state change only, not on progress updates", (t) => {
  const f = fixture(t);
  const job = f.v.job(f.a, { key: "j1", title: "build", state: "working" });
  const sched = f.sc.create(f.a, { key: "j2", text: "job moved", on: { event: "job", job: job.id, states: ["done", "failed"] } });
  f.v.job(f.a, { key: "j3", id: job.id, progress: { done: 3 } }); // progress only: no event
  f.v.job(f.a, { key: "j4", id: job.id, state: "working", note: "still" }); // same state: no event
  f.sc.tick();
  assert.equal(f.outbox().length, 0);
  f.v.job(f.a, { key: "j5", id: job.id, state: "done" });
  f.sc.tick();
  assert.equal(f.outbox().length, 1);
  assert.match(f.outbox()[0].envelope.text, /job .*: working -> done/);
  assert.equal(f.s.db.prepare("SELECT state FROM schedules WHERE id=?").get(sched.id).state, "active");
});

test("an idle trigger fires once and re-arms after new activity", (t) => {
  const f = fixture(t);
  const session = f.enroll("Idle worker");
  const sched = f.sc.create(f.a, { key: "i1", text: "session went quiet", on: { event: "idle", session, idleMs: 60000 } });
  f.advance(61000);
  f.sc.tick();
  assert.equal(f.outbox().length, 1);
  assert.match(f.outbox()[0].envelope.text, /idle since/);
  assert.equal(f.s.db.prepare("SELECT armed FROM schedules WHERE id=?").get(sched.id).armed, 0);
  f.advance(120000);
  f.sc.tick();
  assert.equal(f.outbox().length, 1); // still disarmed
  // New activity (a session report) re-arms it.
  f.v.report({ id: session, role: "worker" }, { key: "act", title: "work", state: "working" });
  f.advance(61000);
  f.sc.tick();
  assert.equal(f.outbox().length, 2);
});

test("a topic publish fires matching schedules and is rate limited", (t) => {
  const f = fixture(t);
  f.sc.create(f.a, { key: "t1", text: "ci finished", on: { event: "topic", topic: "ci:Enntity/accord#27" } });
  f.sc.create(f.b, { key: "t2", text: "other topic", on: { event: "topic", topic: "other" } });
  f.sc.publish(f.b, { key: "p1", topic: "ci:Enntity/accord#27", text: "green" });
  f.sc.tick();
  assert.equal(f.outbox().length, 1);
  assert.match(f.outbox()[0].envelope.text, /topic ci:Enntity\/accord#27: green/);
  for (let i = 0; i < 59; i++) f.sc.publish(f.b, { key: `p${i + 2}`, topic: "other" });
  assert.throws(() => f.sc.publish(f.b, { key: "p-last", topic: "other" }), (e) => e.code === 'RATE_LIMIT');
});

test("several events inside 60 seconds coalesce into one message", (t) => {
  const f = fixture(t);
  f.s.db.prepare("INSERT INTO resources(id) VALUES('gpu0')").run();
  f.s.db.prepare("INSERT INTO tasks VALUES('t1','t','i','h','gpu0',NULL,'running',NULL,NULL,?,1,'task')").run(f.now());
  f.s.db.prepare("INSERT INTO claims VALUES('c1','t1','gpu0','a',1,'running',?,NULL,NULL,NULL,?)").run(f.now() + 60000, f.now());
  f.sc.create(f.a, { key: "coal", text: "reservation changed", on: { event: "reservation", resource: "gpu0" } });
  f.s.emit("claim.active", { claim: "c1" });
  f.s.emit("claim.renewed", { claim: "c1" }); // not a mapped kind; ignored
  f.s.emit("claim.released", { claim: "c1" });
  f.sc.tick();
  assert.equal(f.outbox().length, 1);
  assert.match(f.outbox()[0].envelope.text, /\(2 events: claim\.active c1; claim\.released c1\)/);
});

test("an event logged while the server is down still fires after restart", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "accord-sched-restart-"));
  const f = fixture(t, { dir });
  f.s.db.prepare("INSERT INTO resources(id) VALUES('gpu0')").run();
  const sched = f.sc.create(f.a, { key: "durable", text: "while you were away", on: { event: "reservation", resource: "gpu0" } });
  f.s.releaseLeadership();
  f.closeAll();
  // The event lands while no coordinator is running.
  const raw = new DatabaseSync(f.file);
  raw.prepare("INSERT INTO events(at,kind,data) VALUES(?,?,?)").run(f.now(), "claim.active", JSON.stringify({ claim: "c1", resource: "gpu0" }));
  raw.close();
  let now = f.now() + 5000;
  const s2 = new Store(f.file, { now: () => now, leaderMs: 30000 });
  s2.takeLeadership();
  const c2 = new Collaboration(s2, f.file);
  const sc2 = new Schedules(s2, c2);
  t.after(() => { c2.close(); s2.close(); rmSync(dir, { recursive: true, force: true }); });
  sc2.tick();
  assert.match(JSON.parse(s2.db.prepare("SELECT envelope FROM message_outbox").get().envelope).text, /claim\.active c1/);
  // The cursor is durable: another tick does not refire.
  sc2.tick();
  assert.equal(s2.db.prepare("SELECT count(*) n FROM message_outbox").get().n, 1);
  assert.equal(s2.db.prepare("SELECT fired_count FROM schedules WHERE id=?").get(sched.id).fired_count, 1);
});

test("a retired target at fire time ends the schedule as target-retired", (t) => {
  const f = fixture(t);
  const session = f.enroll("Doomed");
  const sched = f.sc.create(f.a, { key: "doom", text: "hello", inMs: 60000, to: addr(f, session) });
  f.s.endSession({ id: session, role: "worker" }, session, { key: "close" });
  f.advance(61000);
  f.sc.tick();
  const row = f.s.db.prepare("SELECT * FROM schedules WHERE id=?").get(sched.id);
  assert.equal(row.state, "ended");
  assert.equal(row.ended_reason, "target-retired");
  assert.equal(f.outbox().length, 0);
});

test("a retired or closed owner loses its active schedules", (t) => {
  const f = fixture(t);
  const owner = f.enroll("Leaving");
  const sched = f.sc.create({ id: owner, role: "worker" }, { key: "own", text: "later", inMs: 60000 });
  f.s.endSession({ id: owner, role: "worker" }, owner, { key: "bye" });
  f.sc.tick();
  const row = f.s.db.prepare("SELECT * FROM schedules WHERE id=?").get(sched.id);
  assert.equal(row.state, "cancelled");
  assert.equal(row.ended_reason, "owner-retired");
});

test("the hourly firing limit defers to the next minute instead of dropping", (t) => {
  const f = fixture(t);
  const sched = f.sc.create(f.a, { key: "burst", text: "rate", inMs: 60000 });
  for (let i = 0; i < 60; i++) f.s.emit("schedule.fired", { schedule: "other", owner: "a", count: i + 1 });
  f.advance(61000);
  f.sc.tick();
  let row = f.s.db.prepare("SELECT * FROM schedules WHERE id=?").get(sched.id);
  assert.equal(row.state, "active");
  assert.equal(row.deferred, 1);
  assert.equal(row.next_at, Math.ceil(f.now() / 60000) * 60000);
  f.advance(3600000);
  f.sc.tick();
  row = f.s.db.prepare("SELECT * FROM schedules WHERE id=?").get(sched.id);
  assert.equal(row.fired_count, 1);
  assert.match(f.outbox()[0].envelope.text, /\(rate-limited; deferred\)/);
});

test("a non-leader cannot fire; a lease handover does not double-send", (t) => {
  let s2, c2;
  t.after(() => { c2?.close(); s2?.close(); });
  const f = fixture(t);
  const sched = f.sc.create(f.a, { key: "lead", text: "once", inMs: 60000 });
  s2 = new Store(f.file, { now: () => f.now(), leaderMs: 30000 });
  c2 = new Collaboration(s2, f.file);
  const sc2 = new Schedules(s2, c2);
  f.advance(61000);
  assert.throws(() => sc2.tick(), (e) => e.code === 'LEADER_LOST');
  f.sc.tick();
  assert.equal(f.outbox().length, 1);
  assert.equal(f.s.db.prepare("SELECT fired_count FROM schedules WHERE id=?").get(sched.id).fired_count, 1);
});

test("a linked host schedules a reservation trigger against its own resource", async (t) => {
  const a = await harness(), b = await harness();
  t.after(async () => { await Promise.all([a.close(false), b.close(false)]); });
  const { bb } = await link(a, b);
  const ac = a.client("agent-a"), bc = b.client("admin");
  // A schedule created through the link lives on B, owned by A's deterministic
  // remote proxy, and its target defaults to that proxy's local address.
  const sched = await ac.collaborate("schedule", { key: "remote-1", text: "watch it", on: { event: "topic", topic: "fleet" } }, bb);
  assert.equal(sched.state, "active");
  assert.match(sched.owner, /^remote-/);
  const listed = await ac.collaborate("schedules", {}, bb);
  assert.deepEqual(listed.schedules.map((s) => s.id), [sched.id]);
  // topic-publish stays local: publish on B, the schedule fires there.
  await bc.collaborate("topic-publish", { key: "tp1", topic: "fleet", text: "go" });
  const db = new DatabaseSync(join(b.data, "coordinator.sqlite"), { readOnly: true });
  t.after(() => db.close());
  await eventually(async () => db.prepare("SELECT fired_count FROM schedules WHERE id=?").get(sched.id)?.fired_count === 1);
});

test("an upgrade starts the event cursor at the current log end, so old events never fire", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "accord-sched-upg-"));
  const file = join(dir, "coordinator.sqlite");
  const seed = new Store(file);
  seed.provision("admin", "admin", "admin");
  seed.provision("a", "a", "worker");
  seed.db.prepare("INSERT INTO events(at,kind,data) VALUES(1,'topic.published',?)").run(JSON.stringify({ topic: "fleet", text: "old", actor: "x" }));
  seed.close();
  // Rewind to before migration 21; reopening re-runs it against the seeded log.
  const old = new DatabaseSync(file);
  const preSeq = old.prepare("SELECT max(seq) n FROM events").get().n;
  old.exec("ALTER TABLE sessions DROP COLUMN client; DROP TABLE agent_tiles; DROP TABLE titles; DROP TABLE schedules; DROP TABLE schedule_cursor; DROP INDEX events_kind_at; ALTER TABLE session_views DROP COLUMN rename; ALTER TABLE session_views DROP COLUMN rename_reason; DROP TABLE rename_requests; DELETE FROM migrations WHERE version>=21");
  old.close();
  const s = new Store(file, { now: () => 1_000_000, leaderMs: 30000 });
  s.takeLeadership();
  const cursor = s.db.prepare("SELECT event_seq FROM schedule_cursor WHERE id=1").get().event_seq;
  assert.equal(cursor, preSeq);
  const c = new Collaboration(s, file);
  t.after(() => { c.close(); s.close(); rmSync(dir, { recursive: true, force: true }); });
  const sc = new Schedules(s, c);
  const sched = sc.create({ id: "a", role: "worker" }, { key: "u1", text: "ping", on: { event: "topic", topic: "fleet" } });
  sc.tick();
  assert.equal(s.db.prepare("SELECT fired_count FROM schedules WHERE id=?").get(sched.id).fired_count, 0);
  sc.publish({ id: "a", role: "worker" }, { key: "u2", topic: "fleet" });
  sc.tick();
  assert.equal(s.db.prepare("SELECT fired_count FROM schedules WHERE id=?").get(sched.id).fired_count, 1);
});

test("a rebound successor inherits the retired owner's schedules instead of cancelling", (t) => {
  const f = fixture(t);
  const watcher = f.enroll("Watcher");
  const sched = f.sc.create(f.a, { key: "inh", to: `${f.s.authority}/${watcher}`, text: "keep watching", everyMs: 60000 });
  const self = f.sc.create(f.a, { key: "inh-self", text: "check in", everyMs: 60000 });
  // A superseding session records a successor the way enrolment rebound does.
  f.s.db.prepare("UPDATE sessions SET retired_at=?,retired_reason='superseded',successor='a2' WHERE id='a'").run(f.now());
  f.s.emit("session.retired", { session: "a", reason: "superseded", successor: "a2" });
  f.sc.tick();
  const row = f.s.db.prepare("SELECT owner,target,state,ended_reason FROM schedules WHERE id=?").get(sched.id);
  assert.equal(row.owner, "a2");
  assert.equal(row.target, `${f.s.authority}/${watcher}`); // explicit target unchanged
  assert.equal(row.state, "active");
  assert.equal(row.ended_reason, null);
  // A self-targeted schedule follows the rebound owner.
  const selfRow = f.s.db.prepare("SELECT owner,target FROM schedules WHERE id=?").get(self.id);
  assert.equal(selfRow.owner, "a2");
  assert.equal(selfRow.target, `${f.s.authority}/a2`);
  // It still fires to the original target; the self-target fires to the successor.
  f.advance(60000);
  f.sc.tick();
  assert.equal(f.s.db.prepare("SELECT fired_count FROM schedules WHERE id=?").get(sched.id).fired_count, 1);
  assert.equal(f.s.db.prepare("SELECT fired_count FROM schedules WHERE id=?").get(self.id).fired_count, 1);
  const mails = f.s.db.prepare("SELECT envelope FROM message_outbox").all().map((r) => JSON.parse(r.envelope));
  assert.ok(mails.some((m) => m.to === `${f.s.authority}/${watcher}`));
  const selfMail = mails.find((m) => m.to === `${f.s.authority}/a2`);
  assert.ok(selfMail);
  assert.equal(selfMail.scheduledBy, `${f.s.authority}/a2`);
});

test("a schedule on B delivers to a linked host A from B/accord-scheduler with scheduledBy intact", async (t) => {
  const a = await harness(), b = await harness();
  t.after(async () => { await Promise.all([a.close(false), b.close(false)]); });
  const { aa, bb } = await link(a, b);
  const ac = a.client("agent-a"), bc = b.client("agent-b");
  await ac.announce({ label: "A agent", activity: "work" });
  const sched = await bc.collaborate("schedule", { key: "cross-1", to: `${aa}/agent-a`, text: "from B", at: Date.now() });
  assert.equal(sched.state, "active");
  let inbox;
  await eventually(async () => {
    inbox = await ac.collaborate("inbox", {});
    return inbox.messages?.length > 0;
  });
  const mail = inbox.messages[0];
  assert.equal(mail.from, `${bb}/accord-scheduler`);
  assert.equal(mail.scheduledBy, `${bb}/agent-b`);
  assert.equal(mail.scheduleId, sched.id);
});

test("persistent schedules never expire, reject expiresInMs and still count toward the cap", (t) => {
  const f = fixture(t);
  const sched = f.sc.create(f.a, { key: "perm", text: "forever", everyMs: 60000, persistent: true });
  assert.equal(sched.persistent, true);
  assert.equal(sched.expiresAt, undefined);
  assert.throws(() => f.sc.create(f.a, { key: "perm2", text: "x", inMs: 60000, persistent: true, expiresInMs: 60000 }), (e) => e.code === 'INVALID_INPUT');
  // Far past the old 30-day ceiling it still fires.
  f.advance(40 * 86400000);
  f.sc.tick();
  assert.equal(f.s.db.prepare("SELECT state FROM schedules WHERE id=?").get(sched.id).state, "active");
  assert.equal(f.outbox().length >= 1, true);
  // Still capped: fill the remaining 49 slots, the 51st is refused.
  for (let i = 0; i < 49; i++) f.sc.create(f.a, { key: `pc${i}`, text: "x", inMs: 60000, persistent: true });
  assert.throws(() => f.sc.create(f.a, { key: "pc-over", text: "x", inMs: 60000 }), (e) => e.code === 'SCHEDULE_LIMIT');
});

test("a retired target with a live successor is retargeted and still gets the fire", (t) => {
  const f = fixture(t);
  const old = f.enroll("Old agent"), next = f.enroll("New agent");
  const sched = f.sc.create(f.a, { key: "ret-t", text: "follow me", inMs: 60000, to: addr(f, old) });
  f.s.db.prepare("UPDATE sessions SET retired_at=?,retired_reason='superseded',successor=? WHERE id=?").run(f.now(), next, old);
  f.advance(61000);
  f.sc.tick();
  const row = f.s.db.prepare("SELECT * FROM schedules WHERE id=?").get(sched.id);
  assert.equal(row.state, "done"); // a one-shot fires its retargeted successor once
  assert.equal(row.target, addr(f, next));
  assert.equal(row.fired_count, 1);
  assert.equal(f.outbox()[0].envelope.to, addr(f, next));
});

test("a retired target without a successor ends as target-retired, not failed, and is pruned after 72h", (t) => {
  const f = fixture(t);
  const session = f.enroll("Doomed");
  const sched = f.sc.create(f.a, { key: "ret-none", text: "hello", inMs: 60000, to: addr(f, session) });
  f.s.endSession({ id: session, role: "worker" }, session, { key: "close" });
  f.advance(61000);
  f.sc.tick();
  const row = f.s.db.prepare("SELECT * FROM schedules WHERE id=?").get(sched.id);
  assert.equal(row.state, "ended");
  assert.equal(row.ended_reason, "target-retired");
  assert.equal(row.expires_at, f.now() + 72 * 3600000);
  assert.equal(f.outbox().length, 0);
  const kinds = f.s.db.prepare("SELECT kind FROM events WHERE kind LIKE 'schedule.%'").all().map((r) => r.kind);
  assert.ok(kinds.includes("schedule.ended"));
  assert.ok(!kinds.includes("schedule.failed"));
  // The row lingers for inspection, then the tick deletes it.
  f.advance(71 * 3600000);
  f.sc.tick();
  assert.ok(f.s.db.prepare("SELECT 1 FROM schedules WHERE id=?").get(sched.id));
  f.advance(3600001);
  f.sc.tick();
  assert.equal(f.s.db.prepare("SELECT 1 FROM schedules WHERE id=?").get(sched.id), undefined);
});

test("interval wakes coalesce while the previous fire is unread, then resume after a read", (t) => {
  const f = fixture(t);
  const target = f.enroll("Busy");
  f.c.announce({ id: target, role: "worker" }, { key: "ann", label: "busy", activity: "working" });
  const sched = f.sc.create(f.a, { key: "coal-i", text: "wake", everyMs: 60000, to: addr(f, target) });
  f.advance(61000);
  f.sc.tick();
  assert.equal(f.outbox().length, 1);
  f.c.deliver(f.outbox()[0].envelope);
  // The target never reads: the next fire is skipped and the cadence advances.
  f.advance(61000);
  f.sc.tick();
  assert.equal(f.outbox().length, 1);
  assert.equal(f.s.db.prepare("SELECT fired_count FROM schedules WHERE id=?").get(sched.id).fired_count, 1);
  const delivery = f.c.inbox({ id: target, role: "worker" }).messages[0];
  f.c.read({ id: target, role: "worker" }, { deliveryId: delivery.deliveryId });
  // Read now: the following due tick sends.
  f.advance(61000);
  f.sc.tick();
  assert.equal(f.outbox().length, 2);
  assert.equal(f.s.db.prepare("SELECT fired_count FROM schedules WHERE id=?").get(sched.id).fired_count, 2);
});

test("pause and resume across trigger kinds; paused rows ignore events", (t) => {
  const f = fixture(t);
  const once = f.sc.create(f.a, { key: "p-at", text: "later", inMs: 60000 });
  const interval = f.sc.create(f.a, { key: "p-every", text: "beat", everyMs: 60000 });
  f.s.db.prepare("INSERT INTO resources(id) VALUES('gpu0')").run();
  const evt = f.sc.create(f.a, { key: "p-ev", text: "event", on: { event: "reservation", resource: "gpu0" } });
  for (const s of [once, interval, evt]) assert.equal(f.sc.pause(f.a, { id: s.id, paused: true }).state, "paused");
  // A due one-shot does not fire while paused; events accumulate nothing.
  f.advance(61000);
  f.s.emit("claim.active", { claim: "cx", resource: "gpu0" });
  f.sc.tick();
  assert.equal(f.outbox().length, 0);
  assert.equal(f.s.db.prepare("SELECT pending_events FROM schedules WHERE id=?").get(evt.id).pending_events, 0);
  // Resume: interval re-arms one period out, a passed one-shot is due now,
  // the event trigger waits for a fresh event.
  assert.equal(f.sc.pause(f.a, { id: interval.id, paused: false }).nextAt, f.now() + 60000);
  assert.equal(f.sc.pause(f.a, { id: once.id, paused: false }).state, "active");
  assert.equal(f.s.db.prepare("SELECT next_at FROM schedules WHERE id=?").get(once.id).next_at, f.now());
  assert.equal(f.sc.pause(f.a, { id: evt.id, paused: false }).nextAt, undefined);
  f.sc.tick();
  assert.equal(f.outbox().length, 1); // only the one-shot fired
  f.advance(60000);
  f.sc.tick();
  assert.equal(f.outbox().length, 2); // the interval fired
  f.s.emit("claim.released", { claim: "cx", resource: "gpu0" });
  f.sc.tick();
  assert.equal(f.outbox().length, 3);
});

test("the overseer lists all, pauses and cancels other owners' schedules; a stranger cannot", (t) => {
  const f = fixture(t);
  const overseer = f.enroll("Overseer");
  f.s.db.prepare("INSERT OR REPLACE INTO meta VALUES('overseer_address',?)").run(addr(f, overseer));
  const sched = f.sc.create(f.b, { key: "ov", text: "watched", everyMs: 60000 });
  const o = { id: overseer, role: "worker" };
  assert.equal(f.sc.list(o, { all: true }).schedules.length, 1);
  assert.equal(f.sc.pause(o, { id: sched.id, paused: true }).state, "paused");
  assert.throws(() => f.sc.list(f.a, { all: true }), (e) => e.code === 'FORBIDDEN');
  assert.throws(() => f.sc.pause(f.a, { id: sched.id, paused: true }), (e) => e.code === 'NOT_OWNER');
  assert.throws(() => f.sc.cancel(f.a, { id: sched.id }), (e) => e.code === 'NOT_OWNER');
  assert.equal(f.sc.cancel(o, { id: sched.id }).state, "cancelled");
});

test("ended rows keep 72h of history in every end state, then the tick prunes them", (t) => {
  const f = fixture(t);
  const retention = f.now() + 72 * 3600000;
  const cancelled = f.sc.create(f.a, { key: "e-c", text: "x", inMs: 60000 });
  f.sc.cancel(f.a, { id: cancelled.id });
  const done = f.sc.create(f.a, { key: "e-d", text: "x", inMs: 60000 });
  const ghost = f.enroll("Ghost");
  const failing = f.sc.create(f.b, { key: "e-f", text: "x", inMs: 60000, to: addr(f, ghost) });
  f.s.db.prepare("DELETE FROM sessions WHERE id=?").run(ghost); // unknown at fire time
  const doomed = f.enroll("Doomed2");
  const targetRetired = f.sc.create(f.a, { key: "e-t", text: "x", inMs: 60000, to: addr(f, doomed) });
  const ownerDoomed = f.enroll("Leaving2");
  const ownerRetired = f.sc.create({ id: ownerDoomed, role: "worker" }, { key: "e-o", text: "x", inMs: 60000 });
  f.s.endSession({ id: doomed, role: "worker" }, doomed, { key: "close" });
  f.s.endSession({ id: ownerDoomed, role: "worker" }, ownerDoomed, { key: "bye" });
  const expiring = f.sc.create(f.a, { key: "e-x", text: "x", inMs: 30000, expiresInMs: 60000 });
  f.advance(61000);
  f.sc.tick();
  const states = {};
  for (const [name, id] of Object.entries({ cancelled: cancelled.id, done: done.id, failed: failing.id, ended: targetRetired.id, "owner-retired": ownerRetired.id, expired: expiring.id })) {
    const row = f.s.db.prepare("SELECT state,expires_at FROM schedules WHERE id=?").get(id);
    states[name] = row.state;
    // cancelled ends before the 61 s advance; the rest end inside the tick.
    assert.equal(row.expires_at, name === "cancelled" ? retention : retention + 61000, name);
  }
  assert.deepEqual(states, { cancelled: "cancelled", done: "done", failed: "failed", ended: "ended", "owner-retired": "cancelled", expired: "expired" });
  f.advance(72 * 3600000 + 1);
  f.sc.tick();
  assert.equal(f.s.db.prepare("SELECT count(*) n FROM schedules").get().n, 0);
});

test("a paused non-persistent schedule still expires on schedule", (t) => {
  const f = fixture(t);
  const sched = f.sc.create(f.a, { key: "px", text: "x", inMs: 60000, expiresInMs: 120000 });
  f.sc.pause(f.a, { id: sched.id, paused: true });
  f.advance(130000);
  f.sc.tick();
  assert.equal(f.s.db.prepare("SELECT state FROM schedules WHERE id=?").get(sched.id).state, "expired");
});

test("a send to a retired address with a live successor lands there with redirectedTo", async (t) => {
  const f = fixture(t);
  const old = f.enroll("Old"), next = f.enroll("Next");
  f.c.announce({ id: next, role: "worker" }, { key: "ann", label: "next", activity: "work" });
  f.s.db.prepare("UPDATE sessions SET retired_at=?,retired_reason='superseded',successor=? WHERE id=?").run(f.now(), next, old);
  const sent = f.c.send(f.a, { key: "r1", to: addr(f, old), text: "still there?" });
  assert.equal(sent.redirectedTo, addr(f, next));
  await f.c.flush();
  const inbox = f.c.inbox({ id: next, role: "worker" });
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.messages[0].text, "still there?");
});

test("a send to a retired address without a successor still fails RECIPIENT_RETIRED", (t) => {
  const f = fixture(t);
  const gone = f.enroll("Gone");
  f.s.endSession({ id: gone, role: "worker" }, gone, { key: "close" });
  assert.throws(() => f.c.send(f.a, { key: "r2", to: addr(f, gone), text: "hi" }), (e) => e.code === 'RECIPIENT_RETIRED');
});
