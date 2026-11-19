// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.mjs";
import { SessionAwareness } from "../src/session-awareness.mjs";
import { Collaboration } from "../src/collaboration.mjs";
import { Overseer } from "../src/overseer.mjs";

let serial = 0;
const DAY = 86400000;
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "accord-lifecycle-")),
    file = join(dir, "coordinator.sqlite");
  let now = 1000000;
  const s = new Store(file, { now: () => now, leaderMs: 30000 });
  s.takeLeadership();
  s.provision("admin", "admin", "admin");
  s.provision("a", "a", "worker");
  s.provision("b", "b", "worker");
  s.provisionCredential("enroller", "enroller", "enroll");
  const admin = { id: "admin", role: "admin" },
    a = { id: "a", role: "worker" },
    b = { id: "b", role: "worker" },
    v = new SessionAwareness(s),
    c = new Collaboration(s, file),
    o = new Overseer(s, v, c);
  // Stand in for the awareness.json roots the runtime would report.
  v.lifecycleConfig = () => ({ scannedSources: ["claude", "codex"] });
  t.after(() => {
    c.close();
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const enroll = (label = "Fixture agent") =>
    s.openSession({ id: "enroller" }, { key: `enroll:${++serial}`, label, harness: "codex" }, () => `${serial}-secret`)
      .sessionId;
  return {
    s, v, c, o, admin, a, b, enroll,
    advance: (ms) => {
      now += ms;
      s.db.prepare("UPDATE leader SET until_ms=?").run(now + 30000);
    },
    now: () => now,
    report: (actor, body = {}) =>
      v.report(actor, { key: String(++serial), title: "Fixture work", state: "working", ...body }),
    observed: (source, externalId, body = {}) =>
      v.report(admin, { key: `obs:${++serial}`, source, externalId, title: "Native work", state: "working", ...body }),
    events: (kind) => s.db.prepare("SELECT * FROM events WHERE kind=?").all(kind).map((e) => JSON.parse(e.data)),
  };
}

test("a silent observation retires; an enrolled session retires after its longer threshold; both stay readable", (t) => {
  const f = fixture(t),
    obs = f.observed("claude", "conv-1"),
    sessionId = f.enroll();
  f.report({ id: sessionId, role: "worker" });
  f.advance(DAY + 1);
  let pass = f.v.retirePass();
  assert.equal(pass.retired, 1);
  assert.equal(f.v.row(obs.id).retired_at !== null, true);
  assert.equal(f.v.public(f.v.row(obs.id)).lifecycle, "retired");
  assert.equal(f.v.row(sessionId).retired_at, null); // 24 h < 72 h joined threshold
  f.advance(2 * DAY + 1);
  pass = f.v.retirePass();
  assert.equal(pass.retired, 1);
  assert.equal(f.s.db.prepare("SELECT retired_reason FROM sessions WHERE id=?").get(sessionId).retired_reason, "silent");
  assert.equal(f.v.public(f.v.row(sessionId)).lifecycle, "retired");
  // Retired rows stay readable by id; lists and find hide them by default.
  assert.equal(f.v.read(obs.id).session.id, obs.id);
  assert.equal(f.v.list().sessions.length, 0);
  assert.equal(f.v.list({ includeRetired: true }).sessions.length, 2);
  const ids = new Set([obs.id, sessionId]),
    visible = () => f.c.directory("").filter((p) => ids.has(p.address.split("/")[1]));
  assert.equal(visible().length, 0);
  assert.equal(f.c.directory("", { includeRetired: true }).filter((p) => ids.has(p.address.split("/")[1])).length, 2);
});

test("the upgrade backlog is floored by lifecycle_since for the automatic pass but not the sweep", (t) => {
  const f = fixture(t),
    sessionId = f.enroll();
  f.report({ id: sessionId, role: "worker" });
  f.advance(4 * DAY);
  // Backdate the activity as if it predated the upgrade; lifecycle_since is now.
  f.s.db.prepare("UPDATE session_views SET progress_at=?,heartbeat_at=?,observed_at=?").run(1, 1, 1);
  f.s.db.prepare("UPDATE participants SET updated_at=?").run(1);
  f.s.db.prepare("UPDATE sessions SET created_at=?").run(1);
  f.s.db.prepare("UPDATE meta SET value=? WHERE key='lifecycle_since'").run(String(f.now()));
  const pass = f.v.retirePass();
  assert.equal(pass.retired, 0);
  assert.equal(f.s.db.prepare("SELECT retired_at FROM sessions WHERE id=?").get(sessionId).retired_at, null);
  const sweep = f.v.sweep(f.admin, {});
  assert.equal(sweep.sessions.count, 1);
  assert.equal(f.s.db.prepare("SELECT retired_reason FROM sessions WHERE id=?").get(sessionId).retired_reason, "silent");
});

test("sweep dry-run reports counts and samples but writes nothing", (t) => {
  const f = fixture(t),
    obs = f.observed("claude", "sub-1"),
    sessionId = f.enroll();
  f.advance(3 * DAY);
  const before = f.s.db.prepare("SELECT * FROM session_views").all(),
    run = f.v.sweep(f.admin, { dryRun: true });
  assert.equal(run.dryRun, true);
  assert.equal(run.observations.count, 1);
  assert.equal(run.observations.bySource.claude, 1);
  assert.equal(run.observations.sample[0].id, obs.id);
  assert.equal(run.sessions.count, 1);
  assert.equal(run.sessions.byHarness.codex, 1);
  assert.equal(run.sessions.sample[0].id, sessionId);
  assert.deepEqual(f.s.db.prepare("SELECT * FROM session_views").all(), before);
  assert.equal(f.events("session.retired").length, 0);
  assert.equal(f.events("lifecycle.swept").length, 0);
  const real = f.v.sweep(f.admin, {});
  assert.equal(real.dryRun, false);
  assert.equal(real.sessions.count + real.observations.count, 2);
  assert.equal(f.events("lifecycle.swept").length, 1);
});

test("a silent holder of a running claim goes stale once per episode; a queued reservation retires and cancels", (t) => {
  const f = fixture(t),
    holderId = f.enroll("Holder"),
    queuedId = f.enroll("Queued");
  f.report({ id: holderId, role: "worker" });
  f.report({ id: queuedId, role: "worker" });
  const { taskId } = f.s.submit({ id: holderId }, { key: "task:1", title: "Work", input: "in", expectedHash: "0".repeat(64), resource: "artifact" }),
    { claimId } = f.s.acquire({ id: holderId, role: "worker" }, { key: "claim:1", taskId });
  f.s.db.prepare("UPDATE claims SET state='running' WHERE id=?").run(claimId);
  const { id: reservationId } = f.c.reserve({ id: queuedId }, { key: "res:1", resource: "artifact", purpose: "Later" });
  f.advance(3 * DAY);
  let pass = f.v.retirePass();
  assert.equal(pass.retired, 1); // only the queued session
  assert.equal(pass.stale.length, 1);
  assert.equal(pass.stale[0].session, holderId);
  assert.equal(pass.stale[0].claim, claimId);
  assert.equal(f.s.db.prepare("SELECT retired_at FROM sessions WHERE id=?").get(holderId).retired_at, null);
  assert.equal(f.v.public(f.v.row(holderId)).lifecycle, "stale");
  assert.equal(f.events("session.stale_holder").length, 1);
  // A second pass in the same episode emits and returns nothing new.
  pass = f.v.retirePass();
  assert.equal(pass.stale.length, 0);
  assert.equal(f.events("session.stale_holder").length, 1);
  // The retired session's queued reservation is cancelled the way schedule() does it.
  f.c.schedule();
  const task = f.s.db.prepare("SELECT t.state FROM tasks t JOIN reservations r ON r.task_id=t.id WHERE r.id=?").get(reservationId);
  assert.equal(task.state, "cancelled");
});

test("lifecycle.retire by source/externalId retires the observation and every bound actor; non-admin is refused", (t) => {
  const f = fixture(t),
    obs = f.observed("tessera", "tile-9"),
    boundId = f.enroll("Tile agent");
  f.report({ id: boundId, role: "worker" });
  f.v.bind(f.admin, { key: "bind:1", source: "tessera", externalId: "tile-9", actor: boundId });
  assert.throws(() => f.v.retire(f.a, { key: "r:1", source: "tessera", externalId: "tile-9", reason: "tile-closed" }), { code: "FORBIDDEN" });
  assert.throws(() => f.v.retire(f.admin, { key: "r:2", source: "tessera", externalId: "tile-9", reason: "gone" }), { code: "INVALID_INPUT" });
  const result = f.v.retire(f.admin, { key: "r:3", source: "tessera", externalId: "tile-9", reason: "tile-closed" });
  assert.deepEqual(result.retired.sort(), [boundId, obs.id].sort());
  assert.equal(f.s.db.prepare("SELECT retired_reason FROM sessions WHERE id=?").get(boundId).retired_reason, "tile-closed");
  assert.equal(f.events("session.retired").length, 2);
});

test("an owner-reported exit retires the observation and its bound actor; a non-owner cannot", (t) => {
  const f = fixture(t),
    obs = f.observed("tessera", "tile-exit"),
    boundId = f.enroll("Tile agent");
  f.v.bind(f.admin, { key: "bind:1", source: "tessera", externalId: "tile-exit", actor: boundId });
  // The Tessera close path: the observation's owner reports exited.
  f.observed("tessera", "tile-exit", { state: "exited", title: "Closed native session" });
  assert.equal(f.v.row(obs.id).retired_reason, "tile-closed");
  assert.equal(f.s.db.prepare("SELECT retired_reason FROM sessions WHERE id=?").get(boundId).retired_reason, "tile-closed");
  // A worker cannot report on another adapter's observation at all.
  const other = f.observed("codex", "conv-1");
  assert.throws(
    () => f.v.report(f.a, { key: "steal", source: "codex", externalId: "conv-1", title: "x", state: "exited" }),
    (e) => e.code === "FORBIDDEN",
  );
  assert.equal(f.v.row(other.id).retired_at, null);
});

test("retirement resolves the open quiet-work incident and the subject gets no new check-in", (t) => {
  const f = fixture(t),
    obs = f.observed("claude", "quiet-1");
  f.advance(20 * 60000);
  f.o.quiet();
  f.o.quiet(); // a second sample with the same fingerprint opens the incident
  const incident = f.s.db.prepare("SELECT * FROM overseer_incidents WHERE state='open'").get();
  assert.equal(incident.session_id, obs.id);
  f.o.dispatch();
  assert.equal(f.s.db.prepare("SELECT count(*) n FROM message_outbox").get().n, 1); // the first check-in queued
  const original = JSON.parse(incident.evidence);
  f.v.retire(f.admin, { key: "r:1", session: obs.id, reason: "operator" });
  const resolved = f.s.db.prepare("SELECT * FROM overseer_incidents WHERE id=?").get(incident.id);
  assert.equal(resolved.state, "resolved");
  const evidence = JSON.parse(resolved.evidence);
  assert.equal(evidence.resolution, "subject-retired");
  // The merge preserves the recorded observations, not just the resolution.
  for (const key of Object.keys(original))
    assert.deepEqual(evidence[key], original[key]);
  f.advance(30 * 60000);
  f.o.quiet();
  f.o.dispatch();
  assert.equal(f.s.db.prepare("SELECT count(*) n FROM message_outbox").get().n, 1); // nothing new
});

test("a dead transcript rescan does not reassert working; fresh transcript activity revives", (t) => {
  const f = fixture(t),
    obs = f.observed("claude", "dead-sub", { events: [{ key: "e1", text: "working" }] });
  f.advance(DAY + 1);
  f.v.retirePass();
  assert.equal(f.v.row(obs.id).retired_reason, "silent");
  // The rescan reports the same tail: nothing changes, nothing revives.
  const same = f.v.report(f.admin, { key: "rescan:1", source: "claude", externalId: "dead-sub", title: "Native work", state: "working", events: [{ key: "e1", text: "working" }] });
  assert.equal(same.lifecycle, "retired");
  assert.equal(f.v.row(obs.id).state, "working"); // state unchanged, never reasserted
  assert.equal(f.v.row(obs.id).retired_at !== null, true);
  assert.equal(f.events("session.revived").length, 0);
  // Activity newer than the retirement revives the observation.
  f.advance(1000);
  const revived = f.v.report(f.admin, { key: "rescan:2", source: "claude", externalId: "dead-sub", title: "Native work", state: "working", events: [{ key: "e2", text: "new output" }] });
  assert.equal(revived.lifecycle, "live");
  assert.equal(f.v.row(obs.id).retired_at, null);
  assert.equal(f.events("session.revived").length, 1);
});

test("rebind sets the successor; sends to the retired address fail with RECIPIENT_RETIRED; the new actor reads old mail", async (t) => {
  const f = fixture(t),
    oldId = f.enroll("Old agent"),
    newId = f.enroll("New agent");
  f.report({ id: oldId, role: "worker" });
  f.report({ id: newId, role: "worker" });
  f.observed("tessera", "tile-5");
  f.v.bind(f.admin, { key: "bind:1", source: "tessera", externalId: "tile-5", actor: oldId });
  const { id: messageId } = f.c.send(f.b, { key: "m:1", to: `${f.s.authority}/${oldId}`, text: "old mail" });
  await f.c.flush();
  assert.equal(f.c.sent(f.b, messageId).state, "delivered");
  const rebound = f.v.bind(f.admin, { key: "bind:2", source: "tessera", externalId: "tile-5", actor: newId });
  assert.equal(rebound.superseded, oldId);
  const old = f.s.db.prepare("SELECT retired_reason,successor FROM sessions WHERE id=?").get(oldId);
  assert.equal(old.retired_reason, "superseded");
  assert.equal(old.successor, newId);
  assert.equal(f.v.public(f.v.row(oldId)).successor, `${f.s.authority}/${newId}`);
  // Unread mail addressed to the retired actor is visible to its successor.
  assert.equal((await f.c.inbox({ id: newId })).messages.some((m) => m.text === "old mail"), true);
  assert.throws(
    () => f.c.send(f.b, { key: "m:2", to: `${f.s.authority}/${oldId}`, text: "too late" }),
    (e) => e.code === "RECIPIENT_RETIRED" && e.successor === `${f.s.authority}/${newId}`,
  );
});

test("an authenticated heartbeat revives a silence-retired session; a closed one stays retired; no claim reactivates", (t) => {
  const f = fixture(t),
    sessionId = f.enroll("Sleeper");
  f.report({ id: sessionId, role: "worker" });
  const { taskId } = f.s.submit({ id: sessionId }, { key: "task:1", title: "Work", input: "in", expectedHash: "0".repeat(64), resource: "artifact" }),
    { claimId } = f.s.acquire({ id: sessionId, role: "worker" }, { key: "claim:1", taskId });
  f.s.db.prepare("UPDATE claims SET state='closed',outcome='released' WHERE id=?").run(claimId);
  f.advance(3 * DAY);
  f.v.retirePass();
  assert.equal(f.s.db.prepare("SELECT retired_reason FROM sessions WHERE id=?").get(sessionId).retired_reason, "silent");
  f.v.heartbeat({ id: sessionId });
  assert.equal(f.s.db.prepare("SELECT retired_at FROM sessions WHERE id=?").get(sessionId).retired_at, null);
  assert.equal(f.v.public(f.v.row(sessionId)).lifecycle, "live");
  assert.equal(f.events("session.revived").length, 1);
  // The released claim stays released: revival touches only retirement fields.
  assert.equal(f.s.db.prepare("SELECT state FROM claims WHERE id=?").get(claimId).state, "closed");
  // Explicit close is permanent: retirement reason 'closed' and no revival.
  f.s.endSession(f.admin, sessionId, { key: "close:1" });
  assert.equal(f.s.db.prepare("SELECT retired_reason FROM sessions WHERE id=?").get(sessionId).retired_reason, "closed");
  f.v.heartbeat({ id: sessionId });
  assert.equal(f.s.db.prepare("SELECT retired_reason FROM sessions WHERE id=?").get(sessionId).retired_reason, "closed");
  assert.equal(f.events("session.revived").length, 1);
});

test("a send to a retired address on a linked host fails permanently instead of retrying", async (t) => {
  const { harness, link, eventually } = await import("./helpers.mjs"),
    { AccordClient } = await import("../src/client.mjs");
  const a = await harness(), b = await harness();
  t.after(async () => { await a.close(); await b.close(); });
  const { bb } = await link(a, b);
  // Non-admin callers are refused on the wire too.
  await assert.rejects(
    a.client("agent-a").collaborate("lifecycle-retire", { key: "r:0", session: "anything", reason: "operator" }),
    (e) => e.code === "FORBIDDEN",
  );
  const remote = await AccordClient.enroll(b.url, b.credential("bootstrap"), { authority: bb, label: "Remote sleeper" });
  await remote.announce({ label: "Remote sleeper", activity: "napping" });
  const address = `${bb}/${remote.session.sessionId}`;
  await b.client("admin").collaborate("lifecycle-retire", { key: "r:1", session: remote.session.sessionId, reason: "operator" });
  const { id: messageId } = await a.client("agent-a").send(address, "too late", { key: "m:remote" });
  await eventually(async () => {
    const sent = await a.client("agent-a").sent(messageId);
    return sent.state === "failed" && sent;
  });
  const sent = await a.client("agent-a").sent(messageId);
  assert.equal(sent.state, "failed");
  assert.equal(sent.error, "RECIPIENT_RETIRED");
});

test("an adapter-reported observation uses the joined threshold, not the scanned one", (t) => {
  const f = fixture(t),
    obs = f.observed("tessera", "tile-slow");
  f.advance(DAY + 6 * 3600000); // 30 h: past the scanned threshold, under joined
  let pass = f.v.retirePass();
  assert.equal(pass.retired, 0);
  assert.equal(f.v.row(obs.id).retired_at, null);
  f.advance(43 * 3600000); // 73 h: past the joined threshold
  pass = f.v.retirePass();
  assert.equal(pass.retired, 1);
  assert.equal(f.v.row(obs.id).retired_reason, "silent");
});

test("an unchanged owner report refreshes the heartbeat and revives an adapter observation", (t) => {
  const f = fixture(t),
    obs = f.observed("tessera", "tile-live");
  f.advance(3 * DAY + 1);
  f.v.retirePass();
  assert.equal(f.v.row(obs.id).retired_reason, "silent");
  const revision = f.v.row(obs.id).revision;
  // Tessera re-reports the live tile unchanged: heartbeat refresh and revival,
  // with no revision bump since nothing changed.
  const again = f.v.report(f.admin, { key: "keep:1", source: "tessera", externalId: "tile-live", title: "Native work", state: "working" });
  assert.equal(again.lifecycle, "live");
  const row = f.v.row(obs.id);
  assert.equal(row.retired_at, null);
  assert.equal(row.revision, revision);
  assert.equal(row.heartbeat_at, f.now());
  assert.equal(f.events("session.revived").length, 1);
});

test("an exited report on an already-retired observation still retires its bound actor", (t) => {
  const f = fixture(t),
    obs = f.observed("tessera", "tile-gone"),
    boundId = f.enroll("Bound agent");
  f.v.bind(f.admin, { key: "bind:1", source: "tessera", externalId: "tile-gone", actor: boundId });
  f.report({ id: boundId, role: "worker" }); // the bound actor is still live
  f.v.retire(f.admin, { key: "r:1", session: obs.id, reason: "operator" });
  assert.equal(f.v.row(boundId).retired_at, null);
  // The tile is then closed and reported after the observation already retired.
  f.observed("tessera", "tile-gone", { state: "exited", title: "Closed native session" });
  assert.equal(f.v.row(obs.id).retired_reason, "operator"); // still retired, reason kept
  assert.equal(f.v.row(boundId).retired_reason, "tile-closed");
});
