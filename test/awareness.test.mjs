// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hash } from '../src/common.mjs';
import { Store } from "../src/store.mjs";
import { SessionAwareness, redact, staleSessionMs } from "../src/session-awareness.mjs";
import { Collaboration } from "../src/collaboration.mjs";
import { Overseer } from "../src/overseer.mjs";
let serial = 0;
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "accord-awareness-")),
    file = join(dir, "coordinator.sqlite");
  let now = 1000000;
  const s = new Store(file, { now: () => now, leaderMs: 30000 });
  s.takeLeadership();
  s.provision("a", "a", "worker");
  s.provision("b", "b", "worker");
  s.provision("admin", "admin", "admin");
  const a = { id: "a", role: "worker" },
    b = { id: "b", role: "worker" },
    admin = { id: "admin", role: "admin" },
    v = new SessionAwareness(s),
    c = new Collaboration(s, file),
    o = new Overseer(s, v, c);
  t.after(() => {
    c.close();
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    s,
    v,
    c,
    o,
    a,
    b,
    admin,
    advance: (ms) => {
      now += ms;
      s.db.prepare("UPDATE leader SET until_ms=?").run(now + 30000);
    },
    now: () => now,
    report: (actor, body = {}) =>
      v.report(actor, {
        key: String(++serial),
        title: "Fixture work",
        state: "working",
        ...body,
      }),
  };
}
test("session progress differs from heartbeat; redacted search and explicit private-state purge", (t) => {
  const f = fixture(t),
    first = f.report(f.a, {
      detail: "reviewing parser",
      events: [
        { key: "one", text: "sk-proj-abcdefghijklmnopqrst uvicorn launch" },
      ],
    });
  f.advance(1000);
  f.v.heartbeat(f.a);
  assert.equal(f.v.row("a").progress_at, first.progressAt);
  assert(f.v.row("a").heartbeat_at > first.heartbeatAt);
  const replay = f.report(f.a, {
    detail: "reviewing parser",
    events: [
      { key: "one", text: "sk-proj-abcdefghijklmnopqrst uvicorn launch" },
    ],
  });
  assert.equal(replay.revision, 1);
  assert.equal(f.v.list({ query: "uvicorn" }).sessions.length, 1);
  assert(!JSON.stringify(f.v.read("a")).includes("abcdefghijklmnopqrst"));
  f.report(f.a, { private: true });
  assert.equal(f.v.list({ query: "uvicorn" }).sessions.length, 0);
  assert.throws(() => f.v.read("a"), { code: "PRIVATE_SESSION" });
  assert.equal(
    f.s.db.prepare("SELECT count(*) n FROM session_activity").get().n,
    0,
  );
  assert.equal(f.v.list().sessions[0].title, "Private session");
});
test("only host adapters can import stable external identities; model output cannot overwrite newer evidence", (t) => {
  const f = fixture(t);
  assert.throws(
    () => f.report(f.a, { source: "tessera", externalId: "cli:one" }),
    { code: "FORBIDDEN" },
  );
  const first = f.report(f.admin, {
    source: "tessera",
    externalId: "cli:one",
    events: [{ key: "event", text: "compiling" }],
  });
  const second = f.report(f.admin, {
    source: "tessera",
    externalId: "cli:one",
    state: "done",
  });
  assert.equal(first.id, second.id);
  assert.equal(
    f.v.summarize(first.id, first.revision, "still compiling").accepted,
    false,
  );
  assert.equal(
    f.v.summarize(first.id, second.revision, "Build finished").accepted,
    true,
  );
  assert.equal(f.v.list({ query: "finished" }).sessions.length, 1);
});
test("overseer pings once per episode/attempt, never releases; progress resolves and waiting suppresses", (t) => {
  const f = fixture(t);
  f.report(f.a);
  f.advance(900001);
  f.o.quiet();
  f.advance(10000);
  f.o.quiet();
  f.o.dispatch();
  f.o.dispatch();
  assert.equal(
    f.s.db.prepare("SELECT count(*) n FROM message_outbox").get().n,
    1,
  );
  assert.equal(f.s.db.prepare("SELECT count(*) n FROM claims").get().n, 0);
  const incident = f.o.incidents().incidents[0];
  assert.equal(incident.attempts, 1);
  f.report(f.a, { state: "waiting", detail: "Waiting for network transfer" });
  f.o.quiet();
  f.o.dispatch();
  assert.equal(f.o.incidents().incidents[0].state, "resolved");
  f.report(f.b, { state: "done" });
  f.advance(900001);
  f.o.quiet();
  f.advance(10000);
  f.o.quiet();
  f.o.dispatch();
  assert.equal(
    f.s.db.prepare("SELECT count(*) n FROM message_outbox").get().n,
    1,
  );
});
test('overseer rechecks progress and expected waits at dispatch, and ignores hidden internal sessions',t=>{
  const f=fixture(t);
  for(const update of [{detail:'New progress'},{state:'blocked'},{expectedAt:f.now()+5000000}]){
    f.report(f.a,{state:'working',detail:'Start '+JSON.stringify(update)});
    f.advance(900001);f.o.quiet();f.advance(10000);f.o.quiet();
    assert.equal(f.o.incidents().incidents.find(i=>i.session_id==='a').state,'open');
    f.report(f.a,update);f.o.dispatch();
    assert.equal(f.s.db.prepare('SELECT count(*) n FROM message_outbox').get().n,0);
    f.o.quiet();
  }
  const internal=f.v.report(f.admin,{key:'native',source:'codex',externalId:'guardian',title:'Internal',state:'working'});
  f.advance(900001);f.o.quiet();f.advance(10000);f.o.quiet();
  f.v.hideInternal('codex','guardian');f.o.dispatch();
  assert(!f.o.incidents().incidents.some(i=>i.session_id===internal.id));
  assert.equal(f.s.db.prepare('SELECT count(*) n FROM message_outbox').get().n,0);
});

test("idle hardware requires sustained fresh samples with the same holder; unknown telemetry cannot ping", (t) => {
  const f = fixture(t);
  f.report(f.a);
  f.report(f.b);
  const r = f.o.configure(f.admin, {
    key: "r",
    id: "gpu",
    kind: "idle-resource",
    resource: "gpu",
    quietMs: 60000,
  });
  const sample = (actor = "a", extra = {}) =>
    f.o.resource(r, {
      resource: "gpu",
      holder: { actor, state: "running", generation: 1 },
      utilization: 0,
      observedAt: f.now(),
      ...extra,
    });
  sample();
  for (let i = 0; i < 6; i++) {
    f.advance(10000);
    sample();
  }
  f.o.dispatch();
  assert.equal(f.o.incidents().incidents[0].attempts, 1);
  sample("b");
  f.o.dispatch();
  assert.equal(f.o.incidents().incidents[0].state, "resolved");
  f.advance(10000);
  sample("b", { stale: true });
  f.advance(60000);
  sample("b");
  f.o.dispatch();
  assert.equal(
    f.s.db.prepare("SELECT count(*) n FROM message_outbox").get().n,
    1,
  );
});
test("snooze, expected waits, owner checks, questions and jobs remain explicit", (t) => {
  const f = fixture(t);
  f.report(f.a, { expectedAt: f.now() + 2000000 });
  f.advance(900001);
  f.o.quiet();
  f.advance(10000);
  f.o.quiet();
  f.o.dispatch();
  assert.equal(f.o.incidents().incidents.length, 0);
  assert.throws(
    () => f.v.snooze(f.b, { key: "s", id: "a", until: f.now() + 100000 }),
    { code: "FORBIDDEN" },
  );
  const q = f.v.ask(f.a, {
    key: "q",
    question: "Choose a target",
    options: ["one", "two"],
  });
  assert.throws(
    () => f.v.answer(f.b, { key: "answer", id: q.id, answer: "one" }),
    { code: "FORBIDDEN" },
  );
  assert.equal(
    f.v.answer(f.admin, { key: "answer", id: q.id, answer: "one" }).answer,
    "one",
  );
  const job = f.v.job(f.a, { key: "job", title: "Compile" });
  assert.throws(
    () => f.v.job(f.b, { key: "other", id: job.id, state: "done" }),
    { code: "NOT_OWNER" },
  );
  f.advance(900001);
  assert.equal(f.v.jobs().jobs[0].stalled, true);
});
test("redactor covers credentials before persistence and model input", () => {
  assert(
    !redact(
      "Authorization: Bearer abcdefgh123456\npassword=secrets123\n-----BEGIN PRIVATE KEY-----\nsecret",
    ).includes("secrets123"),
  );
});

test("private source stays absent from directory/search on subsequent imports", (t) => {
  const f = fixture(t);
  const body = {
    source: "codex",
    externalId: "native",
    title: "Secret project",
    location: "/private/project",
    events: [
      { key: "duplicate", text: "secret work" },
      { key: "duplicate", text: "secret work" },
    ],
  };
  const first = f.report(f.admin, body);
  assert.equal(f.v.read(first.id).events.length, 1);
  f.v.privacy(f.admin, { key: "privacy", source: "codex", private: true });
  f.report(f.admin, body);
  assert.equal(f.v.list({ query: "secret" }).sessions.length, 0);
  const directory = f.c.directory("");
  assert(!JSON.stringify(directory).includes("Secret project"));
  assert(!JSON.stringify(directory).includes("/private/project"));
  assert.equal(
    f.v.summarize(first.id, first.revision, "secret").accepted,
    false,
  );
});
test("overseer recovers crash after queueing without payload drift or duplicate delivery", (t) => {
  const f = fixture(t);
  f.report(f.a);
  f.advance(900001);
  f.o.quiet();
  f.advance(10000);
  f.o.quiet();
  f.o.dispatch();
  f.s.db.prepare("UPDATE overseer_incidents SET attempts=0,last_sent=0").run();
  f.advance(60000);
  f.o.quiet();
  const restarted = new Overseer(f.s, f.v, f.c);
  restarted.dispatch();
  assert.equal(
    f.s.db.prepare("SELECT count(*) n FROM message_outbox").get().n,
    1,
  );
  assert.equal(restarted.incidents().incidents[0].attempts, 1);
});

test("resource monitor routes a remote holder to its authenticated home address", (t) => {
  const f = fixture(t);
  f.report(f.a);
  f.s.db
    .prepare("INSERT INTO links(authority,url,outbound,inbound_hash) VALUES(?,?,?,?)")
    .run("remote-host", "http://127.0.0.1:1", "fixture", "hash");
  f.s.db
    .prepare("INSERT INTO remote_routes VALUES(?,?,?)")
    .run("a", "remote-host", "native-agent");
  const rule = f.o.configure(f.admin, {
    key: "remote-rule",
    id: "remote-idle",
    kind: "idle-resource",
    resource: "slot",
    quietMs: 60000,
  });
  for (let i = 0; i < 7; i++) {
    f.o.resource(rule, {
      resource: "slot",
      holder: { actor: "a", state: "running", generation: 1 },
      utilization: 0,
      observedAt: f.now(),
    });
    f.advance(10000);
  }
  f.o.dispatch();
  const envelope = JSON.parse(
    f.s.db.prepare("SELECT envelope FROM message_outbox").get().envelope,
  );
  assert.equal(envelope.to, "remote-host/native-agent");
  f.advance(900001);
  f.o.quiet();
  assert.equal(
    f.s.db
      .prepare(
        "SELECT count(*) n FROM overseer_incidents WHERE rule_id='quiet-work'",
      )
      .get().n,
    0,
  );
});

test("external evidence ages from the sample, not from the previous check-in", (t) => {
  const f = fixture(t);
  f.report(f.a);
  f.o.configure(f.admin, {
    key: "external",
    id: "external",
    kind: "external",
    source: "fixture",
    quietMs: 60000,
    cooldownMs: 60000,
    maxAgeMs: 300000,
  });
  for (let i = 0; i < 7; i++) {
    f.o.signal(f.admin, {
      rule: "external",
      source: "fixture",
      subject: "fixture-job",
      session: "a",
      stuck: true,
      reason: "No progress",
      observedAt: f.now() - 240000,
    });
    f.advance(10000);
  }
  f.o.dispatch();
  assert.equal(f.o.incidents().incidents[0].attempts, 1);
  f.advance(60001);
  f.o.dispatch();
  assert.equal(f.o.incidents().incidents[0].attempts, 1);
  f.report(f.a, { private: true });
  assert.deepEqual(f.o.incidents().incidents[0].evidence, {});
});

test('shared summary needs retain Tessera semantics and disappear when their evidence changes or becomes private',t=>{
  const f=fixture(t),view=f.report(f.a);
  f.v.summarize(view.id,view.revision,'Waiting for a target',{blocked:true,needs:'Choose A or B'});
  assert.deepEqual(f.v.read(view.id).session.summaryDetails,{blocked:true,needs:'Choose A or B'});
  const next=f.v.report(f.a,{key:'new-progress',title:'Chosen',state:'working',detail:'Running A'});
  assert.deepEqual(f.v.read(next.id).session.summaryDetails,{blocked:false,needs:null});
  f.v.report(f.a,{key:'private-next',private:true,state:'working'});
  assert.deepEqual(f.v.list().sessions.find(s=>s.id===view.id).summaryDetails,{});
});

test('announcements preserve completion and wait state; explicit work resumes', t => {
  const f=fixture(t);
  for(const state of ['done','waiting','blocked','exited']) {
    f.report(f.a,{state});
    const value=f.v.announce(f.a,{key:'announce-'+state,label:'Worker',activity:'Directory refresh'});
    assert.equal(value.state,state);
  }
  assert.equal(f.v.announce(f.a,{key:'resume',label:'Worker',activity:'New task',state:'working'}).state,'working');
});

test('a session silent past the observer lookback leaves the board, and its next heartbeat returns it idle', t => {
  const f=fixture(t);
  f.o.configure(f.admin,{key:'quiet-rule',id:'quiet',kind:'quiet-session',quietMs:60000});
  f.report(f.a,{state:'working'});f.report(f.b,{state:'done'});
  f.advance(staleSessionMs-1000);f.v.expireStale();
  assert.equal(f.v.row('a').state,'working','still inside the lookback');
  f.advance(2000);f.v.expireStale();
  assert.equal(f.v.row('a').state,'exited');assert.equal(f.v.row('b').state,'done');
  f.o.quiet();
  assert.equal(f.s.db.prepare("SELECT count(*) n FROM overseer_incidents WHERE state='open'").get().n,0);
  const exited=f.v.row('a').revision;
  f.v.heartbeat(f.a);assert.equal(f.v.row('a').state,'idle');assert.equal(f.v.row('a').revision,exited+1);
  f.v.heartbeat(f.a);assert.equal(f.v.row('a').revision,exited+1,'later heartbeats are not news');
  f.report(f.b,{state:'exited'});f.v.heartbeat(f.b);assert.equal(f.v.row('b').state,'exited','a live session that said exited stays exited');
});

test('native binding resolves existing duplicate incidents and preserves stable incident timestamps',t=>{
  const f=fixture(t);f.report(f.a);f.advance(900001);f.o.quiet();f.advance(10000);f.o.quiet();
  const opened=f.o.incidents().incidents[0];assert.equal(opened.state,'open');
  f.advance(10000);f.o.quiet();assert.equal(f.o.incidents().incidents[0].updated_at,opened.updated_at);
  f.s.db.prepare('INSERT INTO session_bindings VALUES(?,?,?)').run('codex','native-a','a');
  f.report(f.admin,{source:'codex',externalId:'native-a',state:'done'});
  assert.deepEqual(f.v.public(f.v.row('a')).nativeSession,{source:'codex',externalId:'native-a'});
  f.o.dispatch();assert.equal(f.s.db.prepare('SELECT count(*) n FROM message_outbox').get().n,0);
  f.o.quiet();assert.equal(f.o.incidents().incidents[0].state,'resolved');
});

test('remote labels are authenticated-origin display metadata, never progress or privilege',t=>{
  const f=fixture(t),peer={authority:'host-b'};
  const remote=f.c.remoteActor(peer,'worker',{label:'Training'});assert.equal(remote.role,'worker');
  f.report(remote,{state:'done'});f.advance(1000);
  f.c.remoteActor(peer,'worker',{label:'Training renamed'});
  assert.equal(f.v.row(remote.id).state,'done');
  assert.equal(f.s.db.prepare('SELECT label FROM participants WHERE actor=?').get(remote.id).label,'Training renamed');
  assert.equal(f.c.directory().some(p=>p.address.endsWith('/'+remote.id)),false);
  assert.throws(()=>f.c.remoteActor(peer,'worker',{label:'x'.repeat(121)}),{code:'INVALID_INPUT'});
});

test('foreign resource observations resolve only an exact local origin identity',t=>{
  const f=fixture(t);f.c.announce(f.a,{key:'name',label:'Training',activity:'Running'});
  const holder={actor:'remote-'+hash(f.s.authority+'/a'),state:'running',generation:2};
  assert.equal(f.c.localHolder(holder).originActor,'a');
  assert.equal(f.c.localHolder(holder).address,f.s.authority+'/a');
  assert.equal(f.c.localHolder(holder).label,'Training');
  assert.equal(f.c.localHolder({...holder,actor:'remote-'+hash('another-host/a')}).originActor,undefined);
  const r=f.o.configure(f.admin,{key:'hardware',id:'foreign-gpu',kind:'idle-resource',resource:'foreign/gpu',quietMs:60000});
  f.report(f.a);
  for(let i=0;i<7;i++){const h=f.c.localHolder(holder);f.o.resource(r,{resource:r.resource,holder:{...h,actor:h.originActor},utilization:0,observedAt:f.now()});f.advance(10000);}
  f.o.dispatch();assert.equal(f.o.incidents().incidents[0].session_id,'a');
  assert.equal(f.o.incidents().incidents[0].attempts,1);
});

test('parent relationships are observer-owned and disappear with private content',t=>{
 const f=fixture(t),parentSession={source:'codex',externalId:'root'};
 assert.throws(()=>f.report(f.a,{parentSession}),/Only host observers/);
 const row=f.report(f.admin,{source:'codex',externalId:'child',parentSession});
 assert.deepEqual(f.v.public(f.v.row(row.id)).parentSession,parentSession);
 f.report(f.admin,{source:'codex',externalId:'child',private:true});
 assert.equal(f.v.public(f.v.row(row.id)).parentSession,undefined);
});
