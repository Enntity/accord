// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.mjs";
import { hash } from "../src/common.mjs";
import { Collaboration } from "../src/collaboration.mjs";
import { SessionAwareness } from "../src/session-awareness.mjs";
import { participant } from "../src/compact.mjs";
import { harness, link, eventually } from "./helpers.mjs";
import { install } from "../src/installer.mjs";
import { enrollProfile, bindNativeSession } from "../src/bootstrap.mjs";

let serial = 0;
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "accord-agent-"));
  const file = join(dir, "coordinator.sqlite");
  let now = 1_000_000;
  const s = new Store(file, { now: () => now, leaderMs: 30000 });
  s.takeLeadership();
  s.provision("admin", "admin", "admin");
  s.provision("a", "a", "worker");
  s.provision("b", "b", "worker");
  const admin = { id: "admin", role: "admin" }, a = { id: "a", role: "worker" }, b = { id: "b", role: "worker" };
  const v = new SessionAwareness(s);
  const c = new Collaboration(s, file);
  // One hook, close before rm: separate hooks run in registration order, so an
  // rm registered first would fire while SQLite still holds the directory.
  t.after(() => { c.close(); s.close(); rmSync(dir, { recursive: true, force: true }); });
  const enroll = (label = "Fixture agent") =>
    s.openSession({ id: "a" }, { key: `enroll:${++serial}`, label, harness: "codex" }, () => `${serial}-secret`).sessionId;
  return { s, v, c, admin, a, b, enroll, file, addr: (id) => `${s.authority}/${id}` };
}
const withTile = async (tile, fn) => {
  const saved = process.env.TESSERA_TILE_ID;
  process.env.TESSERA_TILE_ID = tile;
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env.TESSERA_TILE_ID; else process.env.TESSERA_TILE_ID = saved;
  }
};
const db = (h) => new DatabaseSync(join(h.data, "coordinator.sqlite"), { readOnly: true });

test("a CLI enrollment inside a tile never takes the tile agent's mailbox binding", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const installed = install({ home: join(h.data, "home"), data: h.data });
  // The tile's own MCP bridge binds the mailbox to its tile identity.
  const mcp = await withTile("tile-1", () =>
    enrollProfile(installed.profile, { label: "MCP agent", harness: "mcp", client: "claude", nativeIdentity: { source: "tessera", id: "tile-1" } }));
  // A CLI session opened inside the same tile links as nested, without binding.
  const cli = await withTile("tile-1", () =>
    enrollProfile(installed.profile, { label: "shell agent", harness: "cli", client: "cli" }));
  const store = db(h);
  const binding = store.prepare("SELECT actor FROM session_bindings WHERE source='tessera' AND external_id='tile-1'").get();
  assert.equal(binding.actor, mcp.session.sessionId);
  assert.equal(store.prepare("SELECT retired_at FROM sessions WHERE id=?").get(mcp.session.sessionId).retired_at, null);
  const link = store.prepare("SELECT tile,role FROM agent_tiles WHERE actor=?").get(cli.session.sessionId);
  assert.equal(link.tile, "tile-1");
  assert.equal(link.role, "nested");
  const mcpLink = store.prepare("SELECT role FROM agent_tiles WHERE actor=?").get(mcp.session.sessionId);
  assert.equal(mcpLink.role, "agent");
  store.close();
});

test("an MCP bridge binds its own client id while still linking its tile as agent", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const installed = install({ home: join(h.data, "home"), data: h.data });
  const mcp = await withTile("tile-9", () =>
    enrollProfile(installed.profile, { label: "MCP agent", harness: "mcp", nativeIdentity: { source: "claude", id: "conv-42" } }));
  const store = db(h);
  assert.equal(
    store.prepare("SELECT external_id FROM session_bindings WHERE source='claude' AND actor=?").get(mcp.session.sessionId).external_id,
    "conv-42");
  assert.equal(store.prepare("SELECT 1 FROM session_bindings WHERE source='tessera' AND actor=?").get(mcp.session.sessionId), undefined);
  assert.equal(store.prepare("SELECT role FROM agent_tiles WHERE actor=?").get(mcp.session.sessionId).role, "agent");
  store.close();
});

test("enrollment records the client name", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const installed = install({ home: join(h.data, "home"), data: h.data });
  const c = await enrollProfile(installed.profile, { label: "x", client: "claude" });
  const store = db(h);
  assert.equal(store.prepare("SELECT client FROM sessions WHERE id=?").get(c.session.sessionId).client, "claude");
  store.close();
});

const reportTile = (f, extra = {}) =>
  f.v.report(f.admin, { key: `tile:${++serial}`, source: "tessera", externalId: "tile-1", title: "Tile name", state: "idle", ...extra });
const tileView = (f, externalId = "tile-1") =>
  f.s.db.prepare("SELECT * FROM session_views WHERE source='tessera' AND external_id=?").get(externalId);

test("the agent title comes from its origin: tile view, own view, then label", (t) => {
  const f = fixture(t);
  const subject = f.enroll("Subject");
  f.c.announce({ id: subject, role: "worker" }, { key: "ann", label: "Sub", activity: "working" });
  // No tile and no own view yet: the announced label is the origin title.
  let record = f.v.agentRecord(subject);
  assert.equal(record.title, "Sub");
  assert.equal(record.titleSource, "origin");
  assert.equal(record.titles, undefined);
  // The agent's own session view title beats the label.
  f.v.report({ id: subject, role: "worker" }, { key: "own", title: "Own report title", state: "working" });
  record = f.v.agentRecord(subject);
  assert.equal(record.title, "Own report title");
  // Linked to a tile, the tile view's title wins.
  reportTile(f, { rename: "supported" });
  f.s.db.prepare("INSERT INTO agent_tiles VALUES(?,?,?,?)").run(subject, "tile-1", "agent", f.s.now());
  record = f.v.agentRecord(subject);
  assert.equal(record.title, "Tile name");
  assert.equal(record.titleSource, "origin");
});

test("a rename request is queued for the subject's tile, not sent as mail", async (t) => {
  const f = fixture(t);
  const subject = f.enroll("Subject");
  reportTile(f, { rename: "supported" });
  f.s.db.prepare("INSERT INTO agent_tiles VALUES(?,?,?,?)").run(subject, "tile-1", "agent", f.s.now());
  const result = f.v.title(f.b, { key: "t1", id: subject, title: "Better name" });
  assert.equal(result.rename, "requested");
  assert.equal(result.tile, "tile-1");
  assert.equal(result.title, "Better name");
  assert.equal(result.session, subject);
  assert.equal(typeof result.id, "string");
  const event = JSON.parse(f.s.db.prepare("SELECT data FROM events WHERE kind='session.rename-requested'").get().data);
  assert.deepEqual({ tile: event.tile, title: event.title }, { tile: "tile-1", title: "Better name" });
  // The request waits in its own queue for the tile's adapter to drain; the
  // tile's ordinary inbox stays empty.
  const row = f.s.db.prepare("SELECT * FROM rename_requests WHERE id=?").get(result.id);
  assert.equal(row.state, "pending");
  assert.equal(row.session, subject);
  assert.equal(row.source, "tessera");
  assert.equal(row.title, "Better name");
  const view = tileView(f);
  const { messages } = f.c.inbox({ id: view.id, role: "worker" });
  assert.equal(messages.length, 0);
  // A replayed request returns the stored response, not a second queue row.
  assert.deepEqual(f.v.title(f.b, { key: "t1", id: subject, title: "Better name" }), result);
  assert.equal(f.s.db.prepare("SELECT count(*) n FROM rename_requests").get().n, 1);
  // accord_send still cannot compose kind rename: the kind is coerced.
  f.c.send(f.b, { key: "s1", to: `${f.s.authority}/${view.id}`, text: "hi", kind: "rename" });
  await f.c.flush();
  assert.equal(f.c.inbox({ id: view.id, role: "worker" }).messages.at(-1).kind, "message");
});

test("session-title refuses when no tile, unsupported, older Tessera, or empty", (t) => {
  const f = fixture(t);
  const subject = f.enroll("Subject");
  // No tile: the agent source has no supported rename through Accord.
  assert.throws(() => f.v.title(f.b, { key: "t1", id: subject, title: "Name" }),
    { code: "RENAME_UNSUPPORTED", message: "This source can't be renamed: agent sessions have no supported rename through Accord." });
  // The tile reports rename unsupported; Tessera's reason is the message.
  reportTile(f, { rename: "unsupported", renameReason: "This source can't be renamed: zcode keeps its own title." });
  f.s.db.prepare("INSERT INTO agent_tiles VALUES(?,?,?,?)").run(subject, "tile-1", "agent", f.s.now());
  assert.throws(() => f.v.title(f.b, { key: "t2", id: subject, title: "Name" }),
    { code: "RENAME_UNSUPPORTED", message: "This source can't be renamed: zcode keeps its own title." });
  // An older Tessera reports no rename field at all.
  f.s.db.prepare("UPDATE session_views SET rename=NULL,rename_reason=NULL WHERE source='tessera'").run();
  assert.throws(() => f.v.title(f.b, { key: "t3", id: subject, title: "Name" }),
    { code: "RENAME_UNSUPPORTED", message: "Tessera on this host can't rename sources yet." });
  // A name can't be removed at the source.
  f.s.db.prepare("UPDATE session_views SET rename='supported' WHERE source='tessera'").run();
  assert.throws(() => f.v.title(f.b, { key: "t4", id: subject, title: "  " }),
    { code: "INVALID_INPUT", message: "A name can't be removed at the source; give a new name." });
  assert.throws(() => f.v.title(f.b, { key: "t5", id: subject, title: "x".repeat(121) }), { code: "INVALID_INPUT" });
  assert.throws(() => f.v.title(f.b, { key: "t6", id: "nobody", title: "x" }), { code: "NOT_FOUND" });
});

test("session-report stores rename support and reason on the tile view", (t) => {
  const f = fixture(t);
  reportTile(f, { rename: "unsupported", renameReason: "zcode keeps its own title." });
  assert.deepEqual(
    tileView(f).rename && tileView(f).rename_reason ? [tileView(f).rename, tileView(f).rename_reason] : null,
    ["unsupported", "zcode keeps its own title."]);
  // A report without rename leaves the stored fields alone.
  reportTile(f);
  assert.equal(tileView(f).rename, "unsupported");
  assert.throws(() => reportTile(f, { rename: "maybe" }), { code: "INVALID_INPUT" });
  assert.throws(() => reportTile(f, { rename: "unsupported", renameReason: "x".repeat(201) }), { code: "INVALID_INPUT" });
});

test("the agent record carries task, previous addresses and the mailbox binding", (t) => {
  const f = fixture(t);
  const s0 = f.enroll("Old"), s1 = f.enroll("Middle"), s2 = f.enroll("Current");
  f.s.db.prepare("UPDATE sessions SET successor=? WHERE id=?").run(s1, s0);
  f.s.db.prepare("UPDATE sessions SET successor=? WHERE id=?").run(s2, s1);
  f.c.announce({ id: s2, role: "worker" }, { key: "ann", label: "Current", activity: "fallback task" });
  f.s.db.prepare("INSERT INTO agent_jobs VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("j1", s2, "Deploy phase 2", "working", "note", "{}", "{}", 1, f.s.now(), 0);
  f.s.db.prepare("INSERT INTO session_bindings VALUES('tessera','tile-7',?)").run(s2);
  const record = f.v.agentRecord(s2);
  assert.equal(record.task, "Deploy phase 2");
  assert.deepEqual(record.previous, [f.addr(s1), f.addr(s0)]);
  assert.deepEqual(record.native, { source: "tessera", id: "tile-7" });
  assert.deepEqual(record.tile, { id: "tile-7", role: "agent", current: true }); // a live tessera binding is the tile's agent
  assert.equal(record.host.authority, f.s.authority);
});

test("compact participant shows title, client, tile and task", (t) => {
  const row = participant({
    address: "h/s1", label: "Fixture agent", activity: "idle", state: "working", presence: "recent",
    agent: { title: "Night shift", client: "claude", tile: { id: "tile-1234567890", role: "nested" }, task: "Reviewing the migration plan" },
  });
  assert.equal(row.title, "Night shift");
  assert.equal(row.client, "claude");
  assert.equal(row.tile, "tile-123·nested");
  assert.equal(row.task, "Reviewing the migration plan");
  // A title matching the label is not repeated.
  assert.equal(participant({ address: "h/s2", label: "Same", agent: { title: "Same" } }).title, undefined);
});

test("an upgrade still copies given titles into titles rows, now unread", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "accord-agent-upg-"));
  const file = join(dir, "coordinator.sqlite");
  const seed = new Store(file);
  seed.db.prepare("INSERT INTO actors VALUES('v1',?,'worker')").run("x");
  seed.db.prepare(`INSERT INTO session_views(id,owner,source,title,state,location,detail,private,observed_at,heartbeat_at,progress_at,revision,fingerprint,summary,summary_kind,summary_revision,expected_at,snoozed_until,given_title,titled_by,titled_at)
    VALUES('v1','a','agent','observed','working','','',0,1,1,1,1,'f','', 'extractive',1,NULL,0,'Old peer name','admin',7)`).run();
  seed.close();
  const old = new DatabaseSync(file);
  old.exec("ALTER TABLE sessions DROP COLUMN client; DROP TABLE agent_tiles; DROP TABLE titles; ALTER TABLE session_views DROP COLUMN rename; ALTER TABLE session_views DROP COLUMN rename_reason; DROP TABLE rename_requests; DELETE FROM migrations WHERE version>=22");
  old.close();
  const s = new Store(file);
  t.after(() => { s.close(); rmSync(dir, { recursive: true, force: true }); });
  // The historical migration is unchanged: old names survive as data.
  const layer = { ...s.db.prepare("SELECT layer,title,by,at FROM titles WHERE subject='v1'").get() };
  assert.deepEqual(layer, { layer: "peer", title: "Old peer name", by: "admin", at: 7 });
  // Nothing surfaces them: the agent title is the origin's own.
  const aw = new SessionAwareness(s);
  const pub = aw.public(s.db.prepare("SELECT * FROM session_views WHERE id='v1'").get());
  assert.equal(pub.givenTitle, undefined);
  assert.equal(pub.titledBy, undefined);
  assert.equal(pub.agent.title, "observed");
  assert.equal(pub.agent.titleSource, "origin");
});

test("a host without session-link-tile never fails enrollment; a failed bind still reports", async (t) => {
  const { createServer } = await import("node:http");
  const dir = mkdtempSync(join(tmpdir(), "accord-agent-old-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "admin.token"), "admintoken", { mode: 0o600 });
  const endpointFile = join(dir, "endpoints.json");
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const operation = JSON.parse(body || "{}").operation;
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: operation === "session-link-tile" ? "UNKNOWN_OPERATION" : "FORBIDDEN", message: "Rejected" } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  writeFileSync(endpointFile, JSON.stringify({ coordinator: `http://127.0.0.1:${server.address().port}` }));
  const profile = { endpointFile, url: `http://127.0.0.1:${server.address().port}` };
  // The tile link is best-effort: an older host's rejection is ignored.
  await withTile("tile-old", () =>
    bindNativeSession(profile, { session: { sessionId: "s1" } }, undefined, { role: "agent" }));
  // A mailbox bind is not best-effort: its failure still reaches the caller.
  await assert.rejects(
    withTile("tile-old", () =>
      bindNativeSession(profile, { session: { sessionId: "s2" } }, { source: "claude", id: "conv-1" }, { role: "agent" })),
    (error) => error.code === "FORBIDDEN");
});

test("a local find never forwards to a linked host", async (t) => {
  const a = await harness(), b = await harness();
  const { bb } = await link(a, b);
  await b.close(false);
  t.after(() => a.close());
  const ac = a.client("agent-a");
  await ac.announce({ label: "A", activity: "work" });
  const local = await ac.find("", { local: true });
  const authority = (await ac.host()).authority;
  assert.deepEqual(local.hosts.map((h) => h.authority), [authority]);
  assert.equal(local.hosts[0].status, "observed");
  const full = await ac.find("");
  assert.equal(full.hosts.length, 2);
  assert.equal(full.hosts.find((h) => h.authority === bb).status, "unknown");
});

test("a native bridge that enrolled before client names re-enrolls with the same key", (t) => {
  const { s } = fixture(t);
  const body = { key: "mcp-native:same", label: "MCP agent", harness: "mcp", authority: s.authority };
  const first = s.openSession({ id: "a" }, body, () => "native-secret");
  const again = s.openSession({ id: "a" }, { ...body, client: "devin" }, () => "native-secret");
  assert.equal(again.sessionId, first.sessionId);
  assert.equal(s.db.prepare("SELECT client FROM sessions WHERE id=?").get(first.sessionId).client, "devin");
  assert.throws(() => s.openSession({ id: "a" }, { ...body, label: "Other" }, () => "native-secret"), { code: "KEY_REUSED" });
});

test("an enrollment recorded by 0.8.0 with its client name still replays", (t) => {
  const { s } = fixture(t);
  const body = { key: "mcp-native:recorded-080", label: "MCP agent", harness: "mcp", authority: s.authority };
  const first = s.openSession({ id: "a" }, body, () => "native-secret");
  // 0.8.0 fingerprinted the client name; rewrite the stored hash the way it recorded it.
  s.db.prepare("UPDATE commands SET payload_hash=? WHERE key=?").run(hash(JSON.stringify({ operation: "session.open", body: { ...body, client: "claude" } })), body.key);
  assert.equal(s.openSession({ id: "a" }, { ...body, client: "claude" }, () => "native-secret").sessionId, first.sessionId);
  assert.throws(() => s.openSession({ id: "a" }, body, () => "native-secret"), { code: "KEY_REUSED" });
});

test("tileAgent follows the binding's successor and falls back to the latest live agent link", (t) => {
  const f = fixture(t);
  reportTile(f);
  const s1 = f.enroll("First"), s2 = f.enroll("Second"), s3 = f.enroll("Third");
  // A live binding wins outright.
  f.s.db.prepare("INSERT INTO session_bindings VALUES('tessera','tile-1',?)").run(s1);
  assert.equal(f.v.tileAgent("tile-1"), s1);
  // A retired binding follows its successor chain to the live actor.
  f.s.db.prepare("UPDATE sessions SET retired_at=?,retired_reason='superseded',successor=? WHERE id=?").run(f.s.now(), s2, s1);
  assert.equal(f.v.tileAgent("tile-1"), s2);
  // The chain dying without a live actor falls back to agent_tiles, newest link first.
  f.s.db.prepare("UPDATE sessions SET retired_at=?,retired_reason='closed' WHERE id=?").run(f.s.now(), s2);
  const later = f.enroll("Late");
  f.s.db.prepare("INSERT INTO agent_tiles VALUES(?,?,?,?)").run(s3, "tile-1", "agent", f.s.now());
  f.s.db.prepare("INSERT INTO agent_tiles VALUES(?,?,?,?)").run(later, "tile-1", "agent", f.s.now() + 1);
  assert.equal(f.v.tileAgent("tile-1"), later);
  // Nested links never qualify; with no live agent there is no tile agent.
  f.s.db.prepare("UPDATE agent_tiles SET role='nested' WHERE actor=?").run(later);
  f.s.db.prepare("UPDATE sessions SET retired_at=? WHERE id=?").run(f.s.now(), s3);
  assert.equal(f.v.tileAgent("tile-1"), null);
  // agentRecord flags the actor the rule picks as tile.current.
  f.s.db.prepare("UPDATE agent_tiles SET role='agent' WHERE actor=?").run(later);
  assert.equal(f.v.agentRecord(later).tile.current, true);
  const other = f.enroll("Other");
  f.s.db.prepare("INSERT INTO agent_tiles VALUES(?,?,?,?)").run(other, "tile-1", "agent", f.s.now() - 1);
  assert.equal(f.v.agentRecord(other).tile.current, undefined);
});

test("bridge-inbox serves a tile's live agent mail plus the observation inbox, deduplicated", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const installed = install({ home: join(h.data, "home"), data: h.data });
  const first = await enrollProfile(installed.profile, { label: "first agent", harness: "mcp", client: "claude" });
  const second = await enrollProfile(installed.profile, { label: "second agent", harness: "mcp", client: "claude" });
  const admin = h.client("admin"), other = h.client("agent-a");
  const authority = (await other.host()).authority;
  const s1 = first.session.sessionId, s2 = second.session.sessionId;
  await admin.collaborate("session-report", { key: "tile", source: "tessera", externalId: "tile-b", title: "Tile", state: "idle" });
  await admin.collaborate("session-bind", { key: "b1", source: "tessera", externalId: "tile-b", actor: s1 });
  await admin.collaborate("session-link-tile", { key: "l1", actor: s1, tile: "tile-b", role: "agent" });
  await other.send(`${authority}/${s1}`, "mail for the tile agent", { key: "m1" });
  await eventually(async () => (await admin.collaborate("bridge-inbox", { source: "tessera" })).deliveries.length === 1);
  const inbox = await admin.collaborate("bridge-inbox", { source: "tessera" });
  assert.equal(inbox.deliveries.length, 1);
  assert.equal(inbox.deliveries[0].text, "mail for the tile agent");
  assert.equal(inbox.deliveries[0].externalId, "tile-b");
  // The observation's own inbox is merged without duplicates.
  const view = await admin.collaborate("sessions", { query: "tile" });
  const tileViewId = view.sessions.find((s) => s.source === "tessera").id;
  await other.send(`${authority}/${tileViewId}`, "mail for the tile itself", { key: "m2" });
  await eventually(async () => (await admin.collaborate("bridge-inbox", { source: "tessera" })).deliveries.length === 2);
  // Rebind the tile to a new live actor: the old one retires as its successor,
  // and mail addressed to it surfaces through the tile agent rule.
  await admin.collaborate("session-link-tile", { key: "l2", actor: s2, tile: "tile-b", role: "agent" });
  await admin.collaborate("session-bind", { key: "b2", source: "tessera", externalId: "tile-b", actor: s2 });
  await other.send(`${authority}/${s2}`, "mail for the successor", { key: "m3" });
  await eventually(async () => (await admin.collaborate("bridge-inbox", { source: "tessera" })).deliveries.length === 3);
});

test("bridge-unread reports which deliveries are still unread", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const admin = h.client("admin"), a = h.client("agent-a"), b = h.client("agent-b");
  const bb = (await b.bootstrap()).address;
  await a.send(bb, "one", { key: "u1" });
  const delivery = await eventually(async () => (await b.inbox()).messages[0]);
  let unread = await admin.collaborate("bridge-unread", { ids: [delivery.deliveryId, "nope", "also-nope"] });
  assert.deepEqual(unread.unread, [delivery.deliveryId]);
  await b.read(delivery.deliveryId);
  unread = await admin.collaborate("bridge-unread", { ids: [delivery.deliveryId] });
  assert.deepEqual(unread.unread, []);
  await assert.rejects(b.collaborate("bridge-unread", { ids: [] }), (e) => e.code === "FORBIDDEN");
});

test("TESSERA_TILE_AGENT mismatches enroll as nested without the tessera binding", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const installed = install({ home: join(h.data, "home"), data: h.data });
  const withFlavor = async (flavor, fn) => {
    const savedTile = process.env.TESSERA_TILE_ID, savedFlavor = process.env.TESSERA_TILE_AGENT;
    process.env.TESSERA_TILE_ID = "tile-flav"; process.env.TESSERA_TILE_AGENT = flavor;
    try { return await fn(); } finally {
      if (savedTile === undefined) delete process.env.TESSERA_TILE_ID; else process.env.TESSERA_TILE_ID = savedTile;
      if (savedFlavor === undefined) delete process.env.TESSERA_TILE_AGENT; else process.env.TESSERA_TILE_AGENT = savedFlavor;
    }
  };
  const store = db(h);
  // A codex client in a devin tile: nested, and never the tessera binding.
  const mismatch = await withFlavor("devin", () =>
    enrollProfile(installed.profile, { label: "scratch codex", harness: "mcp", client: "codex-mcp-client", nativeIdentity: { source: "tessera", id: "tile-flav" } }));
  assert.equal(store.prepare("SELECT role FROM agent_tiles WHERE actor=?").get(mismatch.session.sessionId).role, "nested");
  assert.equal(store.prepare("SELECT 1 FROM session_bindings WHERE source='tessera' AND actor=?").get(mismatch.session.sessionId), undefined);
  // An rmcp (Devin) client in a devin tile: the tile's agent, tessera binding kept.
  const match = await withFlavor("devin", () =>
    enrollProfile(installed.profile, { label: "devin bridge", harness: "mcp", client: "rmcp", nativeIdentity: { source: "tessera", id: "tile-flav" } }));
  assert.equal(store.prepare("SELECT role FROM agent_tiles WHERE actor=?").get(match.session.sessionId).role, "agent");
  assert.equal(store.prepare("SELECT actor FROM session_bindings WHERE source='tessera' AND external_id='tile-flav'").get().actor, match.session.sessionId);
  // Unset flavor keeps today's behavior: the next codex client is agent and binds.
  const unset = await withTile("tile-unset", () =>
    enrollProfile(installed.profile, { label: "old tile", harness: "mcp", client: "codex", nativeIdentity: { source: "tessera", id: "tile-unset" } }));
  assert.equal(store.prepare("SELECT role FROM agent_tiles WHERE actor=?").get(unset.session.sessionId).role, "agent");
  assert.equal(store.prepare("SELECT actor FROM session_bindings WHERE source='tessera' AND external_id='tile-unset'").get().actor, unset.session.sessionId);
  // A shell tile accepts no agent family: even a devin client nests.
  const shell = await withFlavor("shell", () =>
    enrollProfile(installed.profile, { label: "in shell", harness: "mcp", client: "rmcp", nativeIdentity: { source: "tessera", id: "tile-flav" } }));
  assert.equal(store.prepare("SELECT role FROM agent_tiles WHERE actor=?").get(shell.session.sessionId).role, "nested");
  store.close();
});
