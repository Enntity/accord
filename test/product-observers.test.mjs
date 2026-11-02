// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import {
  ProductObservers,
  shrugObservation,
} from "../src/product-observers.mjs";
test("Shrug adapter distinguishes healthy residency, failure and missing evidence", () => {
  const base = {
    release_id: "fixture-release",
    model_id: "fixture-model",
    engine_healthy: true,
    ranks: [
      {
        rank: 0,
        host: "node",
        container: "owned",
        container_status: "running",
      },
    ],
  };
  assert.equal(shrugObservation(base).state, "idle");
  assert.equal(
    shrugObservation({ ...base, engine_healthy: false }).state,
    "blocked",
  );
  assert.equal(
    shrugObservation({ ...base, ranks: [{ container_status: "unreachable" }] })
      .state,
    "unknown",
  );
  assert.equal(shrugObservation({ ...base, ranks: [] }).state, "unknown");
});
test("product plugin only invokes fixed status command; changes publish, failure stays unknown, private skips probing", async () => {
  let now = 100000,
    fail = false,
    privateSource = false,
    calls = 0;
  const reports = [];
  const awareness = {
    db: {
      prepare: () => ({ get: () => ({ private: Number(privateSource) }) }),
    },
    report: (_a, r) => reports.push(r),
  };
  const observer = new ProductObservers({
    awareness,
    configs: [{ id: "serving", type: "shrug", command: "/fixture/shrug" }],
    now: () => now,
    run: async (command, args, options) => {
      calls++;
      assert.equal(command, "/fixture/shrug");
      assert.deepEqual(args, ["--json", "status"]);
      assert.equal(options.shell, false);
      if (fail) throw Error("secret stderr");
      return {
        stdout: JSON.stringify({
          release_id: "fixture",
          ranks: [{ container_status: "running" }],
          engine_healthy: true,
        }),
      };
    },
  });
  await observer.scan();
  now += 30000;
  await observer.scan();
  assert.equal(reports.length, 1);
  fail = true;
  now += 30000;
  await observer.scan();
  assert.equal(reports[1].state, "unknown");
  assert(!JSON.stringify(reports).includes("secret stderr"));
  privateSource = true;
  now += 30000;
  await observer.scan();
  assert.equal(calls, 3);
});
