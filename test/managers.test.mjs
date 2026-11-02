// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.mjs";
import { ResourceManagers } from "../src/resource-managers.mjs";
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "accord-managers-"));
  let now = 100000;
  const store = new Store(join(dir, "state.sqlite"), {
    now: () => now,
    leaderMs: 30000,
  });
  store.takeLeadership();
  store.provision("a", "a", "worker");
  store.provision("b", "b", "worker");
  const tokenFile = join(dir, "manager.secret");
  writeFileSync(tokenFile, "fixture");
  let current = null,
    takes = 0,
    ambiguous = false,
    offline = false,
    supported = true;
  const fetchImpl = async (url, options) => {
    if (offline) throw Error("offline");
    const path = new URL(url).pathname,
      body = options.body && JSON.parse(options.body);
    let value;
    if (path === "/gateway/schedule")
      value = {
        capabilities: supported
          ? ["reservation-request-id-v1", "reservation-renew-until-v1"]
          : [],
        resources: [
          {
            id: "pair",
            capacity: 1,
            holders:
              current && !["released"].includes(current.state)
                ? [current.id]
                : [],
          },
        ],
        reservations: current ? [current] : [],
      };
    else if (path === "/gateway/schedule/reservations") {
      takes++;
      current ??= {
        id: "r-fixture",
        owner: body.owner,
        resource: "pair",
        state: "active",
        expiresAt: now + body.ttlMs,
      };
      if (ambiguous) {
        ambiguous = false;
        throw Error("response lost");
      }
      value = current;
    } else if (path.endsWith("/release")) {
      current.state = "released";
      value = current;
    } else if (path.endsWith("/renew")) {
      current.expiresAt = body.expiresAt;
      value = current;
    } else value = current;
    return new Response(JSON.stringify(value), { status: 200 });
  };
  const configs = {
      fleet: { type: "lloom", url: "http://127.0.0.1:1", tokenFile },
    },
    manager = new ResourceManagers(store, dir, { configs, fetchImpl });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    store,
    manager,
    configs,
    fetchImpl,
    a: { id: "a", role: "worker" },
    b: { id: "b", role: "worker" },
    advance: () => {
      now += 2001;
      store.db.prepare("UPDATE leader SET until_ms=?").run(now + 30000);
    },
    ambiguous: () => {
      ambiguous = true;
    },
    offline: (value) => {
      offline = value;
    },
    supported: (value) => {
      supported = value;
    },
    current: () => current,
    takes: () => takes,
  };
}
test("manager adapter requires durable request support and never creates a competing local grant", async (t) => {
  const f = fixture(t);
  f.supported(false);
  const r = f.manager.reserve(f.a, { key: "reserve", resource: "fleet:pair" });
  await f.manager.reconcile();
  assert.equal(f.manager.status(f.a, r.id).state, "unknown");
  assert.equal(f.takes(), 0);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM claims").get().n, 0);
  f.supported(true);
  f.advance();
  await f.manager.reconcile();
  assert.equal(f.manager.status(f.a, r.id).state, "running");
  assert.throws(() => f.manager.status(f.b, r.id), { code: "NOT_OWNER" });
});
test("ambiguous take and cancellation recover the same remote request before confirming release", async (t) => {
  const f = fixture(t);
  f.ambiguous();
  const r = f.manager.reserve(f.a, { key: "r", resource: "fleet:pair" });
  await f.manager.reconcile();
  assert.equal(f.manager.status(f.a, r.id).state, "unknown");
  assert.equal(f.current().state, "active");
  f.manager.release(f.a, { key: "release", id: r.id });
  f.offline(true);
  f.advance();
  await f.manager.reconcile();
  assert.equal(f.manager.status(f.a, r.id).state, "unknown");
  assert.equal(f.current().state, "active");
  f.offline(false);
  f.advance();
  await f.manager.reconcile();
  assert.equal(f.manager.status(f.a, r.id).state, "released");
  assert.equal(f.current().id, "r-fixture");
  assert.equal(f.current().state, "released");
  const restarted = new ResourceManagers(f.store, "unused", {
    configs: f.configs,
    fetchImpl: f.fetchImpl,
  });
  await restarted.reconcile();
  assert.equal(f.takes(), 2);
});
test("same-key reserve stays terminal, renewal retry cannot extend past its original deadline", async (t) => {
  const f = fixture(t),
    body = { key: "r", resource: "fleet:pair" },
    r = f.manager.reserve(f.a, body);
  await f.manager.reconcile();
  await f.manager.renew(f.a, { key: "renew", id: r.id, leaseMs: 60000 });
  const deadline = f.current().expiresAt;
  f.advance();
  await f.manager.renew(f.a, { key: "renew", id: r.id, leaseMs: 60000 });
  assert.equal(f.current().expiresAt, deadline);
  f.manager.release(f.a, { key: "release", id: r.id });
  f.advance();
  await f.manager.reconcile();
  assert.equal(f.manager.reserve(f.a, body).id, r.id);
  assert.equal(f.manager.status(f.a, r.id).state, "released");
  assert.equal(f.takes(), 1);
});

test("confirmed terminal manager reservations do not turn unknown as the snapshot ages", async (t) => {
  const f = fixture(t),
    r = f.manager.reserve(f.a, { key: "r", resource: "fleet:pair" });
  await f.manager.reconcile();
  f.manager.release(f.a, { key: "release", id: r.id });
  f.advance();
  await f.manager.reconcile();
  for (let i = 0; i < 10; i++) f.advance();
  assert.equal(f.manager.status(f.a, r.id).state, "released");
});

test('native settings import is read-only and preserves an existing reservation authority',async t=>{
  const f=fixture(t),admin={id:'admin',role:'admin'};
  assert.throws(()=>f.manager.configure(f.a,{name:'imported',url:'http://127.0.0.1:1',key:'fixture'}),{code:'FORBIDDEN'});
  f.manager.configure(admin,{name:'imported',url:'http://127.0.0.1:1',key:'fixture'});
  assert.equal(f.manager.configs.imported.readOnly,true);
  assert.throws(()=>f.manager.reserve(f.a,{key:'readonly',resource:'imported:pair',purpose:'must refuse'}),{code:'MANAGER_READ_ONLY'});
  assert.equal(f.takes(),0);
  const view=await f.manager.schedules();
  assert.equal(view.managers.find(m=>m.name==='imported').state,'observed');
  assert(!JSON.stringify(view).includes('manager-imported.key'));
  f.manager.configure(admin,{name:'fleet',url:'http://127.0.0.1:1',key:'fixture'});
  assert.equal(f.manager.configs.fleet.readOnly,false,'UI settings must not disable an already configured authority');
  await f.manager.reserve(f.a,{key:'existing',resource:'fleet:pair',purpose:'Existing controller'});
  assert.throws(()=>f.manager.configure(admin,{name:'fleet',url:'http://127.0.0.1:2',key:'fixture'}),{code:'MANAGER_ACTIVE'});
});
