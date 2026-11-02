// SPDX-License-Identifier: MIT
// Optional cross-product qualification. Uses the real LLooM scheduler with fixture
// drain/restore actions. Never loads a user config or contacts a running gateway.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { Store } from "../src/store.mjs";
import { ResourceManagers } from "../src/resource-managers.mjs";
const root = process.argv[2];
if (!root) throw Error("Usage: node scripts/qualify-lloom.mjs /path/to/lloom");
const modulePath = resolve(root, "src/schedule.mjs"),
  { createSchedule } = await import(pathToFileURL(modulePath));
const dir = mkdtempSync(join(tmpdir(), "accord-lloom-qualification-"));
let now = Date.now(),
  loseReply = true,
  failRestore = true;
const events = [],
  actions = {
    async suspend() {
      events.push("drain");
    },
    async resume() {
      if (failRestore) {
        events.push("restore-failed");
        throw Error("fixture restore failure");
      }
      events.push("restore-confirmed");
    },
  };
const schedule = createSchedule({
  getConfig: () => ({
    reservations: {
      resources: { slot: { suspend: [{ model: "fixture", node: "fixture" }] } },
    },
  }),
  statePath: join(dir, "schedule.json"),
  actions,
  now: () => now,
  logger: { error() {}, warn() {} },
});
const store = new Store(join(dir, "accord.sqlite"), {
  now: () => now,
  leaderMs: 30000,
});
store.takeLeadership();
store.provision("one", "fixture-one", "worker");
store.provision("two", "fixture-two", "worker");
const tokenFile = join(dir, "manager.token");
writeFileSync(tokenFile, "fixture");
const configs = {
  fleet: { type: "lloom", url: "http://127.0.0.1:1", tokenFile },
};
const fetchImpl = async (url, options) => {
  const path = new URL(url).pathname,
    body = options.body ? JSON.parse(options.body) : {},
    parts = path.split("/");
  let value;
  try {
    if (path === "/gateway/schedule") value = schedule.board();
    else if (path === "/gateway/schedule/reservations") {
      value = await schedule.take(body);
      if (loseReply) {
        loseReply = false;
        throw Error("lost response");
      }
    } else if (parts.at(-1) === "release")
      value = await schedule.release(parts.at(-2), body);
    else if (parts.at(-1) === "renew")
      value = await schedule.renew(parts.at(-2), body);
    else value = schedule.reservation(parts.at(-1));
    return new Response(JSON.stringify(value));
  } catch (error) {
    if (error.message === "lost response") throw error;
    return new Response("{}", { status: 503 });
  }
};
let manager = new ResourceManagers(store, dir, { configs, fetchImpl });
const a = { id: "one" },
  b = { id: "two" };
const tick = async () => {
  now += 2001;
  store.db.prepare("UPDATE leader SET until_ms=?").run(now + 30000);
  await manager.reconcile();
  await new Promise((r) => setTimeout(r, 15));
};
try {
  const first = manager.reserve(a, { key: "one", resource: "fleet:slot" });
  await tick();
  assert.equal(manager.status(a, first.id).state, "unknown");
  assert.equal(schedule.board().reservations.length, 1);
  manager = new ResourceManagers(store, dir, { configs, fetchImpl });
  await tick();
  assert.equal(manager.status(a, first.id).state, "running");
  await manager.renew(a, { key: "renew", id: first.id, leaseMs: 300000 });
  const deadline = manager.status(a, first.id).deadline;
  now += 2000;
  await manager.renew(a, { key: "renew", id: first.id, leaseMs: 300000 });
  assert.equal(manager.status(a, first.id).deadline, deadline);
  const second = manager.reserve(b, { key: "two", resource: "fleet:slot" });
  await tick();
  assert.equal(manager.status(b, second.id).state, "queued");
  manager.release(a, { key: "release", id: first.id });
  await tick();
  assert.notEqual(manager.status(a, first.id).state, "released");
  assert.equal(manager.status(b, second.id).state, "queued");
  assert.equal(events.filter((e) => e === "drain").length, 1);
  failRestore = false;
  for (
    let i = 0;
    i < 10 && manager.status(b, second.id).state !== "running";
    i++
  )
    await tick();
  assert.equal(manager.status(a, first.id).state, "released");
  assert.equal(manager.status(b, second.id).state, "running");
  assert(events.indexOf("restore-confirmed") < events.lastIndexOf("drain"));
  manager.release(b, { key: "release-two", id: second.id });
  await tick();
  assert.equal(manager.status(b, second.id).state, "released");
  assert.equal(store.db.prepare("SELECT count(*) n FROM claims").get().n, 0);
  const report = {
    status: "passed",
    at: new Date().toISOString(),
    lloomScheduleSha256: createHash("sha256")
      .update(readFileSync(modulePath))
      .digest("hex"),
    events,
    assertions: [
      "lost take reply recovers same reservation",
      "restart does not reacquire",
      "renewal retry preserves absolute deadline",
      "failed restoration retains ownership and blocks next grant",
      "confirmed restoration precedes next drain",
      "no competing Accord local claim",
    ],
    limits: [
      "Real scheduler and bridge; fixture model actions, no live gateway or GPUs.",
    ],
  };
  writeFileSync(
    "evidence/lloom-bridge.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await schedule.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
