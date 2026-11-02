// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const module = { exports: {} };
runInNewContext(
  readFileSync(new URL("../src/ui.js", import.meta.url), "utf8"),
  { module },
);
const ui = module.exports;

test("web ownership never presents an unavailable host or unfinished recovery as free", () => {
  const free = {
    id: "host/gpu",
    state: "unclaimed",
    driver: "reachable",
    holder: null,
  };
  assert.equal(ui.resourceState(free), "unclaimed");
  assert.equal(ui.resourceState(free, false), "unknown");
  assert.equal(
    ui.resourceState({ ...free, driver: "DRIVER_UNAVAILABLE" }),
    "unknown",
  );
  assert.equal(ui.resourceState({ ...free, state: "unknown" }), "unknown");
  assert.equal(
    ui.resourceState({ ...free, holder: { state: "revoking" } }),
    "recovering",
  );
  assert.equal(
    ui.resourceState({ ...free, holder: { state: "releasing" } }),
    "releasing",
  );
  assert.equal(
    ui.resourceState({ ...free, holders: [{ state: "running" }] }),
    "held",
  );
});

test("lost linked host keeps its last known assets visible as unknown and recovers from a new observation", () => {
  const local = {
      id: "local/artifact",
      state: "unclaimed",
      driver: "reachable",
    },
    remote = {
      id: "remote/artifact",
      state: "held",
      driver: "reachable",
      holder: { actor: "worker" },
    };
  const stale = ui.mergeResources(
    [local],
    [{ authority: "remote", status: "unknown" }],
    [local, remote],
    "local",
  );
  assert.equal(stale.length, 2);
  assert.equal(ui.resourceState(stale[1]), "unknown");
  assert.equal(stale[1].holder.actor, "worker");
  const unavailable = ui.mergeResources(
    [local],
    [],
    [local, remote],
    "local",
    false,
  );
  assert.equal(ui.resourceState(unavailable[1]), "unknown");
  const recovered = ui.mergeResources(
    [local],
    [
      {
        authority: "remote",
        status: "observed",
        resources: [{ ...remote, state: "unclaimed", holder: null }],
      },
    ],
    stale,
    "local",
  );
  assert.equal(ui.resourceState(recovered[1]), "unclaimed");
  assert.equal(recovered.filter((r) => r.id === "local/artifact").length, 1);
});

test("session attention excludes private work and filters preserve pinned ordering", () => {
  const sessions = [
    {
      address: "a",
      state: "working",
      source: "codex",
      title: "Driver",
      progressAt: 20,
    },
    {
      address: "b",
      state: "waiting",
      source: "claude",
      title: "Review",
      progressAt: 10,
    },
    {
      address: "c",
      state: "failed",
      source: "codex",
      private: true,
      progressAt: 30,
    },
    {
      address: "d",
      state: "done",
      source: "codex",
      title: "Finished",
      progressAt: 40,
    },
  ];
  assert.equal(ui.needsAttention(sessions[2]), false);
  assert.equal(
    ui
      .visibleSessions(sessions, { filter: "attention" })
      .map((s) => s.address)
      .join(","),
    "b",
  );
  assert.equal(
    ui
      .visibleSessions(sessions, { source: "codex", query: "driver" })
      .map((s) => s.address)
      .join(","),
    "a",
  );
  assert.equal(
    ui.visibleSessions(sessions, { pins: new Set(["b"]) })[0].address,
    "b",
  );
  assert.equal(
    ui
      .visibleSessions(sessions, { filter: "done" })
      .map((s) => s.address)
      .join(","),
    "d,c",
  );
});

test("message ISO timestamps and session numeric timestamps use the same clock", () => {
  const now = Date.parse("2026-10-31T16:00:00Z");
  assert.equal(ui.relative("2026-10-31T15:58:00Z", now), "2m ago");
  assert.equal(ui.relative(now - 120000, now), "2m ago");
  assert.equal(ui.relative(String(now - 120000), now), "2m ago");
  for (const value of [null, undefined, "", "invalid"])
    assert.equal(ui.relative(value, now), "Not observed");
});

test("question options handle durable JSON and reject malformed values", () => {
  assert.equal(ui.questionOptions({ options: '["A","B"]' }).join(","), "A,B");
  assert.equal(ui.questionOptions({ options: "invalid" }).length, 0);
  assert.equal(
    ui.questionOptions({ options: ["A", { text: "bad" }, null] }).join(","),
    "A",
  );
});
