// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.mjs";
import { Collaboration } from "../src/collaboration.mjs";
import { SessionAwareness } from "../src/session-awareness.mjs";
import { participant } from "../src/compact.mjs";
import { harness, link } from "./helpers.mjs";
import { install } from "../src/installer.mjs";
import { enrollProfile, bindNativeSession } from "../src/bootstrap.mjs";

let serial = 0;
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "accord-agent-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
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
  t.after(() => { c.close(); s.close(); });
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

test("title layers attribute operator, overseer and peer, and clearing removes one layer", (t) => {
  const f = fixture(t);
  const subject = f.enroll("Subject");
  f.v.title(f.admin, { key: "t1", id: subject, title: "Ops name" });
  f.v.designate(f.admin, { key: "d1", address: f.addr("a") });
  f.v.title(f.a, { key: "t2", id: subject, title: "Overseer name" });
  f.v.title(f.b, { key: "t3", id: subject, title: "Peer name" });
  const layers = Object.fromEntries(
    f.s.db.prepare("SELECT layer,title FROM titles WHERE subject=?").all(subject).map((r) => [r.layer, r.title]));
  assert.deepEqual(layers, { operator: "Ops name", overseer: "Overseer name", peer: "Peer name" });
  // Operator wins, even though the overseer and peers named it too.
  let effective = f.v.agentRecord(subject);
  assert.equal(effective.title, "Ops name");
  assert.equal(effective.titleSource, "operator");
  // Clearing removes only the caller's layer.
  f.v.title(f.admin, { key: "t4", id: subject, title: "" });
  effective = f.v.agentRecord(subject);
  assert.equal(effective.title, "Overseer name");
  assert.equal(effective.titleSource, "overseer");
  f.v.title(f.a, { key: "t5", id: subject, title: "" });
  // With operator and overseer cleared, a default label falls through to peer.
  effective = f.v.agentRecord(subject);
  assert.equal(effective.title, "Peer name");
  assert.equal(effective.titleSource, "peer");
  const emitted = f.s.db.prepare("SELECT data FROM events WHERE kind='session.titled' ORDER BY seq DESC LIMIT 1").get();
  assert.equal(JSON.parse(emitted.data).layer, "overseer");
});

test("a non-default label outranks peer but loses to overseer and operator", (t) => {
  const f = fixture(t);
  const subject = f.enroll("Sub");
  f.c.announce({ id: subject, role: "worker" }, { key: "ann", label: "Sub", activity: "working" });
  f.v.title(f.b, { key: "t1", id: subject, title: "Peer name" });
  let record = f.v.agentRecord(subject);
  assert.equal(record.title, "Sub");
  assert.equal(record.titleSource, "agent");
  assert.equal(record.titles.agent.title, "Sub");
  f.v.designate(f.admin, { key: "d1", address: f.addr("a") });
  f.v.title(f.a, { key: "t2", id: subject, title: "Overseer name" });
  record = f.v.agentRecord(subject);
  assert.equal(record.title, "Overseer name");
  assert.equal(record.titleSource, "overseer");
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
  assert.deepEqual(record.tile, { id: "tile-7", role: "agent" }); // back-compat: a tessera binding reads as an agent link
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

test("an upgrade copies given titles into the peer layer and keeps givenTitle", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "accord-agent-upg-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "coordinator.sqlite");
  const seed = new Store(file);
  seed.db.prepare("INSERT INTO actors VALUES('v1',?,'worker')").run("x");
  seed.db.prepare(`INSERT INTO session_views(id,owner,source,title,state,location,detail,private,observed_at,heartbeat_at,progress_at,revision,fingerprint,summary,summary_kind,summary_revision,expected_at,snoozed_until,given_title,titled_by,titled_at)
    VALUES('v1','a','agent','observed','working','','',0,1,1,1,1,'f','', 'extractive',1,NULL,0,'Old peer name','admin',7)`).run();
  seed.close();
  const old = new DatabaseSync(file);
  old.exec("ALTER TABLE sessions DROP COLUMN client; DROP TABLE agent_tiles; DROP TABLE titles; DELETE FROM migrations WHERE version>=22");
  old.close();
  const s = new Store(file);
  t.after(() => s.close());
  const layer = { ...s.db.prepare("SELECT layer,title,by,at FROM titles WHERE subject='v1'").get() };
  assert.deepEqual(layer, { layer: "peer", title: "Old peer name", by: "admin", at: 7 });
  const aw = new SessionAwareness(s);
  const pub = aw.public(s.db.prepare("SELECT * FROM session_views WHERE id='v1'").get());
  assert.equal(pub.givenTitle, "Old peer name");
  assert.equal(pub.titledBy, `${s.authority}/admin`);
  assert.equal(pub.titledAt, 7);
  assert.equal(pub.agent.title, "Old peer name");
  assert.equal(pub.agent.titleSource, "peer");
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
