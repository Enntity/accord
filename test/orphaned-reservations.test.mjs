// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.mjs";
import { SessionAwareness } from "../src/session-awareness.mjs";
import { Collaboration } from "../src/collaboration.mjs";
import { AccordClient } from "../src/client.mjs";
import { createHttp, listen, readBody, request } from "../src/common.mjs";
import { harness, eventually, link, stop, delay } from "./helpers.mjs";

let serial = 0;
const minute = 60000, DAY = 86400000, GRACE = 900000;

// An in-process coordinator: a store, awareness and collaboration on an
// injected clock, with a cooperative resource registered through the same
// binding shape the driver host describes.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "accord-orphans-")), file = join(dir, "coordinator.sqlite");
  let now = 200 * DAY;
  const s = new Store(file, { now: () => now, leaderMs: 30 * DAY });
  s.takeLeadership();
  s.provision("admin", "admin", "admin");
  s.provisionCredential("enroller", "enroller", "enroll");
  const admin = { id: "admin", role: "admin" },
    v = new SessionAwareness(s),
    c = new Collaboration(s, file);
  t.after(() => { c.close(); s.close(); rmSync(dir, { recursive: true, force: true }); });
  const enroll = (label = "Fixture agent") =>
    s.openSession({ id: "enroller" }, { key: `enroll:${++serial}`, label, harness: "devin" }, () => `${serial}-secret`).sessionId;
  const register = (id, fields = {}) =>
    s.registerResource(admin, { key: `reg:${id}`, manifest: { schema: 1, id, asset: `fixture:${id}`, plugin: "cooperative", ...fields } },
      { id, instance: "inst", plugin: "cooperative", asset: `fixture:${id}`, enforcement: "cooperative agreement only", ...fields });
  return {
    s, v, c, admin, enroll, register,
    advance: (ms) => { now += ms; },
    now: () => now,
    report: (actor, body = {}) =>
      v.report(actor, { key: String(++serial), title: "Fixture work", state: "working", ...body }),
    events: (kind) => s.db.prepare("SELECT * FROM events WHERE kind=?").all(kind).map((e) => JSON.parse(e.data)),
  };
}

// Reserve, grant and activate a window hold for an enrolled session.
function hold(f, sessionId, resource, durationMs = 90 * minute) {
  const actor = { id: sessionId, role: "worker" },
    r = f.c.reserve(actor, { key: `res:${++serial}`, resource, durationMs });
  f.c.schedule();
  const view = f.c.reservation(actor, r.id);
  f.s.activated(view.claimId);
  return view;
}

// A raw read or write against a live coordinator's database: the only way to
// age rows or inspect internals the API never exposes. Busy-wait instead of
// racing the service's own writes, and always close before the temp dir goes.
async function sqlite(file, fn) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout=15000");
    return await fn(db);
  } finally {
    db.close();
  }
}

test("a tile-closed holder orphans its reservation; the hold releases after grace and the queue advances", (t) => {
  const f = fixture(t), holder = f.enroll(), waiter = f.enroll("Waiter");
  f.report({ id: holder, role: "worker" });
  const r = hold(f, holder, "artifact");
  // An explicit end orphans at once: still held inside the grace window.
  f.v.retire(f.admin, { key: "r:1", session: holder, reason: "tile-closed" });
  const res = f.s.db.prepare("SELECT * FROM reservations WHERE id=?").get(r.id);
  assert.equal(res.orphan_reason, "tile-closed");
  assert.equal(f.s.claim(r.claimId).state, "running");
  assert.equal(f.c.reservation({ id: holder, role: "worker" }, r.id).orphaned.releaseAt, res.orphaned_at + GRACE);
  assert.deepEqual(
    f.events("reservation.orphaned").map((e) => e.claim),
    [r.claimId],
  );
  const q = f.c.reserve({ id: waiter, role: "worker" }, { key: `res:${++serial}`, resource: "artifact", durationMs: minute });
  f.c.schedule();
  assert.equal(f.c.reservation({ id: waiter, role: "worker" }, q.id).state, "queued");
  // Grace elapses: the fence revokes the claim and the queued reservation wins.
  f.advance(GRACE + 1);
  f.s.sweep();
  assert.equal(f.s.claim(r.claimId).state, "revoking");
  f.s.released(r.claimId);
  f.c.schedule();
  assert.equal(f.c.reservation({ id: waiter, role: "worker" }, q.id).generation, 2);
});

test("a revive inside grace reclaims the same claim and generation", (t) => {
  const f = fixture(t), holder = f.enroll();
  f.report({ id: holder, role: "worker" });
  const r = hold(f, holder, "artifact");
  f.v.retire(f.admin, { key: "r:1", session: holder, reason: "operator" });
  // An authenticated heartbeat revives the silence-free path and reclaims.
  f.v.heartbeat({ id: holder, role: "worker" });
  assert.equal(f.s.db.prepare("SELECT retired_at FROM sessions WHERE id=?").get(holder).retired_at, null);
  assert.equal(f.s.db.prepare("SELECT orphaned_at FROM reservations WHERE id=?").get(r.id).orphaned_at, null);
  assert.equal(f.s.claim(r.claimId).state, "running");
  assert.equal(f.events("reservation.reclaimed").length, 1);
  f.advance(GRACE + 1); // still inside the 90-minute window itself
  f.s.sweep();
  assert.equal(f.s.claim(r.claimId).state, "running");
});

test("orphanGraceMs zero releases on the next pass; a per-resource grace overrides the default", (t) => {
  const f = fixture(t);
  f.register("fast", { orphanGraceMs: 0 });
  f.register("slow", { orphanGraceMs: 3600000 });
  const a = f.enroll(), b = f.enroll();
  f.report({ id: a, role: "worker" });
  f.report({ id: b, role: "worker" });
  const fast = hold(f, a, "fast"), slow = hold(f, b, "slow");
  f.v.retire(f.admin, { key: "r:1", session: a, reason: "tile-closed" });
  f.v.retire(f.admin, { key: "r:2", session: b, reason: "tile-closed" });
  f.advance(1);
  f.s.sweep();
  assert.equal(f.s.claim(fast.claimId).state, "revoking", "zero grace releases at once");
  assert.equal(f.s.claim(slow.claimId).state, "running", "a longer per-resource grace still holds");
  f.advance(3600000);
  f.s.sweep();
  assert.equal(f.s.claim(slow.claimId).state, "revoking");
});

test("a silent holder is never orphaned, and a coordinator restart keeps the grace deadline", (t) => {
  const f = fixture(t), holder = f.enroll();
  f.report({ id: holder, role: "worker" });
  const r = hold(f, holder, "artifact");
  // Past the joined silence threshold with a running claim: stale, not orphaned.
  f.advance(3 * DAY + 1);
  const pass = f.v.retirePass();
  assert.equal(pass.stale.length, 1);
  assert.equal(f.s.db.prepare("SELECT orphaned_at FROM reservations WHERE id=?").get(r.id).orphaned_at, null);
  assert.equal(f.s.claim(r.claimId).state, "running");
});

test("positive end evidence upgrades a silent retirement and orphans the hold", (t) => {
  const f = fixture(t), holder = f.enroll();
  f.report({ id: holder, role: "worker" });
  const r = hold(f, holder, "artifact");
  // A live holder never reaches 'silent' locally — it goes stale instead, so
  // this state only arises when the hold lived on a linked host. Mark it
  // directly; the upgrade path is what this test exercises.
  f.s.db.prepare("UPDATE sessions SET retired_at=?,retired_reason='silent' WHERE id=?").run(f.now() - 1000, holder);
  // The tile then closes: the retirement upgrades, and the hold orphans.
  f.v.retire(f.admin, { key: `r:${++serial}`, session: holder, reason: "tile-closed" });
  const res = f.s.db.prepare("SELECT * FROM reservations WHERE id=?").get(r.id);
  assert.equal(res.orphan_reason, "tile-closed");
  assert.equal(f.s.db.prepare("SELECT retired_reason FROM sessions WHERE id=?").get(holder).retired_reason, "tile-closed");
  // A replayed or alternate end reason emits and changes nothing new.
  const retired = f.events("session.retired").length, orphaned = f.events("reservation.orphaned").length;
  f.v.retire(f.admin, { key: `r:${++serial}`, session: holder, reason: "operator" });
  f.v.retire(f.admin, { key: `r:${++serial}`, session: holder, reason: "tile-closed" });
  assert.equal(f.events("session.retired").length, retired);
  assert.equal(f.events("reservation.orphaned").length, orphaned);
  assert.equal(f.s.db.prepare("SELECT orphaned_at FROM reservations WHERE id=?").get(r.id).orphaned_at, res.orphaned_at);
  // The same grace still releases it.
  f.advance(GRACE + 1);
  f.s.sweep();
  assert.equal(f.s.claim(r.claimId).state, "revoking");
});

test("a restart mid-grace preserves orphaned_at and releases at the original time", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "accord-orphan-restart-")), file = join(dir, "coordinator.sqlite");
  let now = 1000000;
  const first = new Store(file, { now: () => now, leaderMs: 30 * DAY });
  first.takeLeadership();
  first.provision("admin", "admin", "admin");
  first.provisionCredential("enroller", "enroller", "enroll");
  const admin = { id: "admin", role: "admin" }, v = new SessionAwareness(first), c = new Collaboration(first, file);
  const sessionId = first.openSession({ id: "enroller" }, { key: "enroll:1", label: "A", harness: "devin" }, () => "s").sessionId;
  const r = (() => {
    const actor = { id: sessionId, role: "worker" }, res = c.reserve(actor, { key: "res:1", resource: "artifact", durationMs: 90 * minute });
    c.schedule();
    const view = c.reservation(actor, res.id);
    first.activated(view.claimId);
    return view;
  })();
  v.retire(admin, { key: "r:1", session: sessionId, reason: "tile-closed" });
  const orphanedAt = first.db.prepare("SELECT orphaned_at FROM reservations WHERE id=?").get(r.id).orphaned_at;
  first.releaseLeadership();
  first.close();
  c.close();
  // The restart resumes the window claim and the same grace deadline.
  now += GRACE / 2;
  const second = new Store(file, { now: () => now, leaderMs: 30 * DAY });
  // Close before the rm: Windows cannot delete a directory SQLite still holds.
  t.after(() => { second.close(); rmSync(dir, { recursive: true, force: true }); });
  second.takeLeadership();
  assert.equal(second.db.prepare("SELECT orphaned_at FROM reservations WHERE id=?").get(r.id).orphaned_at, orphanedAt);
  assert.equal(second.claim(r.claimId).state, "preparing"); // a bounded window resumes
  second.sweep();
  assert.equal(second.claim(r.claimId).state, "preparing", "still inside the original grace");
  now = orphanedAt + GRACE + 1;
  second.sweep();
  assert.equal(second.claim(r.claimId).state, "revoking");
});

test("a managed-resource orphan fences after grace; only a confirmed provider releases the hold", (t) => {
  const f = fixture(t), holder = f.enroll();
  f.report({ id: holder, role: "worker" });
  f.s.registerResource(f.admin, { key: "reg:gpu" },
    { id: "gpu", instance: "inst", plugin: "managed-http", asset: "fixture:gpu", enforcement: "provider-confirmed" });
  const r = hold(f, holder, "gpu");
  f.v.retire(f.admin, { key: "r:1", session: holder, reason: "process-exited" });
  f.advance(GRACE + 1);
  f.s.sweep();
  // The fence asks the provider; until it confirms the resource stays held.
  assert.equal(f.s.claim(r.claimId).state, "revoking");
  const waiter = f.enroll("Waiter");
  const q = f.c.reserve({ id: waiter, role: "worker" }, { key: `res:${++serial}`, resource: "gpu", durationMs: minute });
  f.c.schedule();
  assert.equal(f.c.reservation({ id: waiter, role: "worker" }, q.id).state, "queued");
  // A provider that never confirms keeps the hold: released() is what confirms.
  f.s.sweep();
  assert.equal(f.s.claim(r.claimId).state, "revoking");
  f.s.released(r.claimId);
  f.c.schedule();
  assert.equal(f.c.reservation({ id: waiter, role: "worker" }, q.id).generation, 2);
});

test("an ended orphan tells the retired holder's successor through endedClaim", (t) => {
  const f = fixture(t), old = f.enroll("Old"), next = f.enroll("New");
  f.report({ id: old, role: "worker" });
  f.report({ id: next, role: "worker" });
  f.v.bind(f.admin, { key: "b:1", source: "tessera", externalId: "tile-1", actor: old });
  const r = hold(f, old, "artifact");
  // Rebinding supersedes the old holder and names the successor.
  f.v.bind(f.admin, { key: "b:2", source: "tessera", externalId: "tile-1", actor: next });
  assert.equal(f.s.db.prepare("SELECT successor FROM sessions WHERE id=?").get(old).successor, next);
  assert.equal(f.s.db.prepare("SELECT orphan_reason FROM reservations WHERE id=?").get(r.id).orphan_reason, "superseded");
  // The successor does not inherit the claim; when it ends it hears the end.
  assert.equal(f.s.claim(r.claimId).actor, old);
  f.s.fence(f.s.claim(r.claimId), "holder retired");
  const claim = f.s.claim(r.claimId);
  f.c.endedClaim({ id: "admin", role: "admin" }, claim);
  const outbox = f.s.db.prepare("SELECT * FROM message_outbox ORDER BY created_at").all();
  assert.equal(outbox.length, 1);
  assert.match(outbox[0].envelope, new RegExp(next));
});

test("age-out removes an unused cooperative resource but never a held, queued, managed or exempt one", (t) => {
  const f = fixture(t);
  f.register("old", { ageOutMs: DAY });
  f.register("fresh", { ageOutMs: DAY });
  f.register("held", { ageOutMs: DAY });
  f.register("never", { ageOutMs: 0 });
  f.s.registerResource(f.admin, { key: "reg:managed" },
    { id: "managed", instance: "inst", plugin: "managed-http", asset: "fixture:managed", enforcement: "provider-confirmed" });
  // 'old' was registered a week ago in binding terms; 'fresh' just now.
  f.s.db.prepare("UPDATE resource_bindings SET registered_at=? WHERE id='old'").run(1);
  f.s.db.prepare("UPDATE resource_bindings SET registered_at=? WHERE id='never'").run(1);
  const holder = f.enroll();
  f.report({ id: holder, role: "worker" });
  hold(f, holder, "held");
  f.s.ageOutCooperative();
  assert.equal(f.s.binding("old"), undefined);
  assert.equal(f.s.binding("never") !== undefined, true, "ageOutMs zero means never");
  assert.equal(f.s.binding("held") !== undefined, true, "a held resource is never removed");
  assert.equal(f.s.binding("managed") !== undefined, true, "managed resources never age out");
  assert.equal(f.s.binding("fresh") !== undefined, true, "registration time floors age-out");
  assert.equal(f.events("resource.aged_out").length, 1);
  // Recent queue activity resets the clock.
  f.c.reserve({ id: holder, role: "worker" }, { key: `res:${++serial}`, resource: "fresh", durationMs: minute });
  f.s.db.prepare("UPDATE resource_bindings SET registered_at=? WHERE id='fresh'").run(1);
  f.s.ageOutCooperative();
  assert.equal(f.s.binding("fresh") !== undefined, true, "a queued reservation keeps the resource");
});

test("a revoked generation never reactivates through orphan release and regrant", (t) => {
  const f = fixture(t), holder = f.enroll(), waiter = f.enroll("Waiter");
  f.report({ id: holder, role: "worker" });
  const r = hold(f, holder, "artifact"), claim = f.s.claim(r.claimId);
  f.v.retire(f.admin, { key: "r:1", session: holder, reason: "tile-closed" });
  f.advance(GRACE + 1);
  f.s.sweep();
  f.s.released(r.claimId);
  const q = f.c.reserve({ id: waiter, role: "worker" }, { key: `res:${++serial}`, resource: "artifact", durationMs: minute });
  f.c.schedule();
  const next = f.c.reservation({ id: waiter, role: "worker" }, q.id);
  assert.equal(next.generation, claim.generation + 1);
  // The old generation stays closed; nothing reopens it.
  assert.equal(f.s.claim(r.claimId).state, "closed");
  f.s.sweep();
  assert.equal(f.s.claim(r.claimId).state, "closed");
});

// Server-level coverage: the reconcile tick collects the notices and warnings.

test("a superseded holder's orphan notices reach the successor and notify once each", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const admin = h.client("admin"), authority = (await admin.host()).authority;
  writeFileSync(join(h.data, "awareness.json"),
    JSON.stringify({ lifecycle: { notify: [`${authority}/agent-a`] } }));
  const old = await AccordClient.enroll(h.url, h.credential("bootstrap"), { authority, label: "Old" }),
    next = await AccordClient.enroll(h.url, h.credential("bootstrap"), { authority, label: "New" });
  await old.announce({ label: "Old", activity: "holding" });
  await next.announce({ label: "New", activity: "idle" });
  const watcher = h.client("agent-a");
  await watcher.announce({ label: "Watcher", activity: "idle" });
  const oldId = old.session.sessionId, nextId = next.session.sessionId;
  await admin.collaborate("session-bind", { key: "b:1", source: "tessera", externalId: "tile-9", actor: oldId });
  const r = await old.reserve("artifact", { durationMs: 90 * minute });
  await eventually(async () => (await old.reservation(r.id)).state === "preparing" || (await old.reservation(r.id)).state === "running");
  // The tile's conversation rebinds: the old actor is superseded and orphaned.
  await admin.collaborate("session-bind", { key: "b:2", source: "tessera", externalId: "tile-9", actor: nextId });
  const view = await old.reservation(r.id);
  assert.equal(view.orphaned.reason, "superseded");
  const successorSeen = await eventually(async () =>
    (await next.inbox()).messages.find((m) => m.text.includes(`reservation ${r.id}`) && m.text.includes("orphaned")));
  const watcherSeen = await eventually(async () =>
    (await watcher.inbox()).messages.find((m) => m.text.includes(`reservation ${r.id}`) && m.text.includes("orphaned")), 20000); // the config file reloads on a ten-second tick
  assert.ok(successorSeen && watcherSeen);
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal((await next.inbox()).messages.filter((m) => m.text.includes(`reservation ${r.id}`)).length, 1, "one notice per episode");
  assert.equal((await watcher.inbox()).messages.filter((m) => m.text.includes(`reservation ${r.id}`)).length, 1);
});

test("the window expiry warning fires once at the lead and re-arms on extension", async (t) => {
  const h = await harness({ leaderMs: 30000 });
  t.after(() => h.close());
  const admin = h.client("admin"), authority = (await admin.host()).authority;
  const a = await AccordClient.enroll(h.url, h.credential("bootstrap"), { authority, label: "Holder" });
  await a.announce({ label: "Holder", activity: "working" });
  const r = await a.reserve("artifact", { durationMs: 90 * minute });
  await eventually(async () => (await a.reservation(r.id)).state === "running");
  // Bring the deadline inside the warning lead: 90-minute window warns 9 minutes out.
  const file = join(h.data, "coordinator.sqlite"),
    claimId = (await a.reservation(r.id)).claimId,
    near = Date.now() + 8 * minute;
  await sqlite(file, (db) => db.prepare("UPDATE claims SET deadline=? WHERE id=?").run(near, claimId));
  const seen = await eventually(async () =>
    (await a.inbox()).messages.find((m) => m.text.includes(`reservation ${r.id}`) && m.text.includes("Extend with accord_extend")));
  assert.ok(seen);
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal((await a.inbox()).messages.filter((m) => m.text.includes("Extend with accord_extend")).length, 1);
  // Extending changes the deadline and re-arms the warning for the new one.
  await a.extend(r.id, { durationMs: 5 * 3600000 });
  const extended = await a.reservation(r.id);
  await sqlite(file, (db) => db.prepare("UPDATE claims SET deadline=? WHERE id=?").run(Date.now() + 8 * minute, claimId));
  await eventually(async () =>
    (await a.inbox()).messages.filter((m) => m.text.includes("Extend with accord_extend")).length === 2);
});

// Cross-host lifecycle: a retirement on the holder's own host reaches the host
// whose resources that holder's remote actor keeps.

async function twoHosts(t) {
  const a = await harness(), b = await harness();
  t.after(async () => { await a.close(); await b.close(); });
  const { aa, bb, x, y } = await link(a, b);
  return { a, b, aa, bb, x, y };
}

// Enroll a session on A and have it hold a running window on B; the remote
// actor the forward creates on B is what the lifecycle notice then maps.
async function remoteHold(a, bb, { label = "Remote holder", resource = "artifact", durationMs = 90 * minute } = {}) {
  const authority = (await a.client("admin").host()).authority,
    client = await AccordClient.enroll(a.url, a.credential("bootstrap"), { authority, label });
  const r = await client.reserve(resource, { host: bb, durationMs });
  await eventually(async () => (await client.reservation(r.id, bb)).state === "running" && true);
  return { client, sessionId: client.session.sessionId, r };
}

test("a superseded remote holder orphans on the linked host; grace releases, the queue advances and successor plus notify hear", async (t) => {
  const { a, b, aa, bb } = await twoHosts(t),
    adminA = a.client("admin"), adminB = b.client("admin");
  const watcher = await AccordClient.enroll(a.url, a.credential("bootstrap"), { authority: aa, label: "Watcher" });
  writeFileSync(join(b.data, "awareness.json"),
    JSON.stringify({ lifecycle: { notify: [`${aa}/${watcher.session.sessionId}`] } }));
  await adminB.registerResource({ schema: 1, id: "coop", asset: "host:b:coop", plugin: "cooperative", orphanGraceMs: 3000 });
  const old = await AccordClient.enroll(a.url, a.credential("bootstrap"), { authority: aa, label: "Old" }),
    next = await AccordClient.enroll(a.url, a.credential("bootstrap"), { authority: aa, label: "New" }),
    tile = `tile-${++serial}`;
  await adminA.collaborate("session-bind", { key: `b:${serial}:1`, source: "tessera", externalId: tile, actor: old.session.sessionId });
  const r = await old.reserve("coop", { host: bb, durationMs: 90 * minute });
  await eventually(async () => (await old.reservation(r.id, bb)).state === "running" && true);
  const waiter = await AccordClient.enroll(a.url, a.credential("bootstrap"), { authority: aa, label: "Waiter" }),
    q = await waiter.reserve("coop", { host: bb, durationMs: minute });
  assert.equal((await waiter.reservation(q.id, bb)).state, "queued");
  // The tile rebinds on A: the old session retires as superseded and B orphans.
  await adminA.collaborate("session-bind", { key: `b:${serial}:2`, source: "tessera", externalId: tile, actor: next.session.sessionId });
  const view = await eventually(async () => { const v = await old.reservation(r.id, bb); return v.orphaned && v; });
  assert.equal(view.orphaned.reason, "superseded");
  const successorSeen = await eventually(async () =>
    (await next.inbox()).messages.find((m) => m.text.includes(`reservation ${r.id}`) && m.text.includes("orphaned")));
  const watcherSeen = await eventually(async () =>
    (await watcher.inbox()).messages.find((m) => m.text.includes(`reservation ${r.id}`) && m.text.includes("orphaned")), 20000);
  assert.ok(successorSeen && watcherSeen);
  // After the grace the hold ends, the successor hears again, and the queue advances.
  await eventually(async () => (await waiter.reservation(q.id, bb)).state === "running" && true, 15000);
  const end = await eventually(async () =>
    (await next.inbox()).messages.find((m) => m.text.includes(`reservation ${r.id}`) && m.text.includes("ended")));
  assert.ok(end);
  assert.equal((await next.inbox()).messages.filter((m) => m.text.includes("is orphaned")).length, 1, "one orphan notice per episode");
});

test("a remote managed hold stays held while its provider never confirms", async (t) => {
  const { a, b, bb } = await twoHosts(t);
  // The provider confirms prepare but never answers stop or restore, so the
  // orphaned claim must stay in revoking rather than appearing released.
  const provider = createHttp(async (req, res, url) => {
    const body = await readBody(req), action = url.pathname.slice(1);
    if (action === "availability") return { available: true };
    if (action === "stop" || action === "restore") throw Error("provider silent");
    return { ...body, [action]: true };
  });
  const endpoint = await listen(provider);
  t.after(() => new Promise((resolve) => provider.close(resolve)));
  const tokenFile = join(b.data, "provider.token");
  writeFileSync(tokenFile, "provider-test", { mode: 0o600 });
  await b.client("admin").registerResource({ schema: 1, id: "mgd", asset: "fixture:mgd", plugin: "managed-http", endpoint, tokenFile, orphanGraceMs: 2500 });
  const { client, r } = await remoteHold(a, bb, { resource: "mgd" });
  await a.client("admin").collaborate("lifecycle-retire", { key: `r:${++serial}`, session: client.session.sessionId, reason: "process-exited" });
  const view = await eventually(async () => { const v = await client.reservation(r.id, bb); return v.orphaned && v; });
  assert.equal(view.orphaned.reason, "process-exited");
  await eventually(async () => (await client.reservation(r.id, bb)).state === "revoking" && true, 15000);
  await delay(1500);
  const later = await client.reservation(r.id, bb);
  assert.equal(later.state, "revoking", "an unconfirmed release never appears released");
});

test("a silent remote holder is never orphaned and its stale notice reaches the notify list once", async (t) => {
  const { a, b, aa, bb } = await twoHosts(t), adminB = b.client("admin");
  const watcher = await AccordClient.enroll(a.url, a.credential("bootstrap"), { authority: aa, label: "Watcher" });
  writeFileSync(join(b.data, "awareness.json"),
    JSON.stringify({ lifecycle: { notify: [`${aa}/${watcher.session.sessionId}`] } }));
  await adminB.registerResource({ schema: 1, id: "coop", asset: "host:b:coop", plugin: "cooperative", orphanGraceMs: 2500 });
  const { client, sessionId, r } = await remoteHold(a, bb, { resource: "coop" });
  // Age the holder past the joined threshold on A; the pass retires it silently.
  await sqlite(join(a.data, "coordinator.sqlite"), (db) => {
    const old = Date.now() - 73 * 3600000;
    db.prepare("UPDATE sessions SET created_at=? WHERE id=?").run(old, sessionId);
    db.prepare("UPDATE session_views SET heartbeat_at=?,progress_at=?,observed_at=? WHERE id=?").run(old, old, old, sessionId);
    db.prepare("UPDATE participants SET updated_at=? WHERE actor=?").run(old, sessionId);
  });
  // The operator sweep ignores the upgrade floor; the periodic pass would need 72 h.
  await a.client("admin").collaborate("lifecycle-sweep", { key: `sw:${serial}` });
  // B marks the remote route retired but never orphans, even past the grace.
  await eventually(async () => (await watcher.inbox()).messages.find((m) => m.text.includes(sessionId) && m.text.includes("still holds")), 30000);
  await delay(4000);
  const view = await client.reservation(r.id, bb);
  assert.equal(view.orphaned, undefined);
  assert.equal(view.state, "running");
  assert.equal((await watcher.inbox()).messages.filter((m) => m.text.includes(sessionId)).length, 1);
});

test("a silent-then-closed remote holder orphans on the linked host and releases after grace", async (t) => {
  const { a, b, bb, y: aToB } = await twoHosts(t);
  await b.client("admin").registerResource({ schema: 1, id: "coop", asset: "host:b:coop", plugin: "cooperative", orphanGraceMs: 2500 });
  const { client, sessionId, r } = await remoteHold(a, bb, { resource: "coop" });
  // Silence retires the session on A; B marks the route stale, never orphans.
  await sqlite(join(a.data, "coordinator.sqlite"), (db) => {
    const old = Date.now() - 73 * 3600000;
    db.prepare("UPDATE sessions SET created_at=? WHERE id=?").run(old, sessionId);
    db.prepare("UPDATE session_views SET heartbeat_at=?,progress_at=?,observed_at=? WHERE id=?").run(old, old, old, sessionId);
    db.prepare("UPDATE participants SET updated_at=? WHERE actor=?").run(old, sessionId);
  });
  await a.client("admin").collaborate("lifecycle-sweep", { key: `sw:${serial}` });
  await eventually(async () => sqlite(join(b.data, "coordinator.sqlite"), (db) => {
    const row = db.prepare("SELECT retired_reason FROM remote_routes WHERE session_id=?").get(sessionId);
    return row && row.retired_reason === "silent" && row;
  }));
  await delay(4000);
  assert.equal((await client.reservation(r.id, bb)).orphaned, undefined);
  assert.equal((await client.reservation(r.id, bb)).state, "running");
  // The tile then closes on A: the upgrade orphans the hold on B.
  await a.client("admin").collaborate("lifecycle-retire", { key: `r:${++serial}`, session: sessionId, reason: "tile-closed" });
  const view = await eventually(async () => { const v = await client.reservation(r.id, bb); return v.orphaned && v; });
  assert.equal(view.orphaned.reason, "tile-closed");
  assert.equal(view.orphaned.releaseAt, view.orphaned.since + 2500, "grace counts from B's receipt");
  // A replayed tile-closed notice after the upgrade stays a no-op.
  const again = await request(b.url, aToB, "/v1/federation", { operation: "lifecycle", args: { session: sessionId, event: "retired", reason: "tile-closed", at: Date.now() }, actor: "accord-lifecycle" });
  assert.equal(again.value.applied, false);
  assert.equal((await client.reservation(r.id, bb)).orphaned.since, view.orphaned.since);
  // Grace elapses on B and the hold ends.
  await eventually(async () => sqlite(join(b.data, "coordinator.sqlite"), (db) => {
    const c = db.prepare("SELECT state FROM claims WHERE task_id=(SELECT task_id FROM reservations WHERE id=?)").get(r.id);
    return c && c.state === "closed" && c;
  }), 15000);
});

test("closing a remote holder's session fences the hold at once, without grace", async (t) => {
  const { a, b, bb } = await twoHosts(t);
  await b.client("admin").registerResource({ schema: 1, id: "coop", asset: "host:b:coop", plugin: "cooperative", orphanGraceMs: 600000 });
  const { client, r } = await remoteHold(a, bb, { resource: "coop" });
  await client.closeSession();
  const closed = await eventually(async () => sqlite(join(b.data, "coordinator.sqlite"), (db) => {
    const c = db.prepare("SELECT c.state,c.outcome FROM claims c JOIN reservations r ON r.task_id=c.task_id WHERE r.id=?").get(r.id);
    return c && c.state === "closed" && c;
  }));
  assert.ok(closed, "closed holder's claim fenced at once, no grace");
  assert.equal(await sqlite(join(b.data, "coordinator.sqlite"), (db) =>
    db.prepare("SELECT orphaned_at FROM reservations WHERE id=?").get(r.id).orphaned_at), null, "a closed holder never orphans");
});

test("a revival within grace reclaims the remote hold with the same claim and generation", async (t) => {
  const { a, b, aa, bb } = await twoHosts(t), adminA = a.client("admin");
  await b.client("admin").registerResource({ schema: 1, id: "coop", asset: "host:b:coop", plugin: "cooperative", orphanGraceMs: 30000 });
  const old = await AccordClient.enroll(a.url, a.credential("bootstrap"), { authority: aa, label: "Old" }),
    next = await AccordClient.enroll(a.url, a.credential("bootstrap"), { authority: aa, label: "New" }),
    tile = `tile-${++serial}`;
  await adminA.collaborate("session-bind", { key: `b:${serial}:1`, source: "tessera", externalId: tile, actor: old.session.sessionId });
  const r = await old.reserve("coop", { host: bb, durationMs: 90 * minute });
  await eventually(async () => (await old.reservation(r.id, bb)).state === "running" && true);
  const before = await old.reservation(r.id, bb);
  await adminA.collaborate("session-bind", { key: `b:${serial}:2`, source: "tessera", externalId: tile, actor: next.session.sessionId });
  await eventually(async () => { const v = await old.reservation(r.id, bb); return v.orphaned && true; });
  // Authenticated activity revives the session on A; B reclaims within grace.
  await old.announce({ label: "Old", activity: "back" });
  const view = await eventually(async () => { const v = await old.reservation(r.id, bb); return !v.orphaned && v.state === "running" && v; });
  assert.equal(view.claimId, before.claimId);
  assert.equal(view.generation, before.generation);
});

test("a notice delayed by an unreachable host delivers on return, and grace counts from its receipt", async (t) => {
  const a = await harness(), b = await harness();
  t.after(async () => { await a.close(); await b.close(); });
  // Move B to a fixed port before linking so the link stays valid after a restart.
  const probe = createHttp((req, res) => res.end("{}")),
    probePort = Number(new URL(await listen(probe)).port);
  await new Promise((resolve) => probe.close(resolve));
  await stop(b.server); await b.startServer(probePort);
  const { bb: bb2 } = await link(a, b);
  await b.client("admin").registerResource({ schema: 1, id: "coop", asset: "host:b:coop", plugin: "cooperative", orphanGraceMs: 2000 });
  const { client, sessionId, r } = await remoteHold(a, bb2, { resource: "coop" });
  await stop(b.server);
  const retiredAt = Date.now();
  await a.client("admin").collaborate("lifecycle-retire", { key: `r:${++serial}`, session: sessionId, reason: "tile-closed" });
  await delay(3000); // longer than the grace, had it counted from A's retirement
  await b.startServer(probePort);
  const view = await eventually(async () => { const v = await client.reservation(r.id, bb2); return v.orphaned && v; }, 20000);
  assert.ok(view.orphaned.since >= retiredAt + 2500, "grace counts from when B learns, not A's retirement");
  assert.equal(view.orphaned.releaseAt, view.orphaned.since + 2000);
  await eventually(async () => sqlite(join(b.data, "coordinator.sqlite"), (db) => {
    const c = db.prepare("SELECT state FROM claims WHERE task_id=(SELECT task_id FROM reservations WHERE id=?)").get(r.id);
    return c && c.state === "closed" && c;
  }));
});

test("a link cannot retire another host's session, and a replayed notice is a no-op", async (t) => {
  const { a, b, aa, bb, y: aToB } = await twoHosts(t),
    c = await harness();
  t.after(() => c.close());
  const { x } = await link(b, c); // c's outbound credential for calls to b
  await b.client("admin").registerResource({ schema: 1, id: "coop", asset: "host:b:coop", plugin: "cooperative", orphanGraceMs: 30000 });
  const { client, sessionId, r } = await remoteHold(a, bb, { resource: "coop" });
  // C's link speaks only for C's sessions; A's session id maps to no route.
  const spoof = await request(b.url, x, "/v1/federation", { operation: "lifecycle", args: { session: sessionId, event: "retired", reason: "tile-closed" }, actor: "intruder" });
  assert.equal(spoof.value.applied, false);
  assert.equal((await client.reservation(r.id, bb)).state, "running");
  // A genuine notice applies once; replaying it changes and emits nothing new.
  await a.client("admin").collaborate("lifecycle-retire", { key: `r:${++serial}`, session: sessionId, reason: "tile-closed" });
  const view = await eventually(async () => { const v = await client.reservation(r.id, bb); return v.orphaned && v; });
  const again = await request(b.url, aToB, "/v1/federation", { operation: "lifecycle", args: { session: sessionId, event: "retired", reason: "tile-closed", at: Date.now() }, actor: "accord-lifecycle" });
  assert.equal(again.value.applied, false);
  const same = await client.reservation(r.id, bb);
  assert.equal(same.orphaned.since, view.orphaned.since);
});

test("a remote holder gets the pre-expiry warning at the window lead", async (t) => {
  const { a, b, bb } = await twoHosts(t);
  await b.client("admin").registerResource({ schema: 1, id: "coop", asset: "host:b:coop", plugin: "cooperative" });
  // A one-minute window warns at its one-minute floor, which is right away.
  const { client, r } = await remoteHold(a, bb, { resource: "coop", durationMs: minute });
  const seen = await eventually(async () =>
    (await client.inbox()).messages.find((m) => m.text.includes(`reservation ${r.id}`) && m.text.includes("Extend with accord_extend")), 15000);
  assert.ok(seen);
});

test("a queued request from a retired remote actor is cancelled on the resource host", async (t) => {
  const { a, b, aa, bb } = await twoHosts(t);
  await b.client("admin").registerResource({ schema: 1, id: "coop", asset: "host:b:coop", plugin: "cooperative" });
  await remoteHold(a, bb, { resource: "coop", label: "First" });
  const waiter = await AccordClient.enroll(a.url, a.credential("bootstrap"), { authority: aa, label: "Waiter" }),
    q = await waiter.reserve("coop", { host: bb, durationMs: minute });
  assert.equal((await waiter.reservation(q.id, bb)).state, "queued");
  await a.client("admin").collaborate("lifecycle-retire", { key: `r:${++serial}`, session: waiter.session.sessionId, reason: "tile-closed" });
  await eventually(async () => (await waiter.reservation(q.id, bb)).state === "cancelled" && true);
});
