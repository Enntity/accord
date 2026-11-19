// SPDX-License-Identifier: MIT
// Session retirement shared by the store, awareness and collaboration paths.
// Retirement is durable bookkeeping only: rows stay readable by id, and only
// fresh authenticated activity clears it.
export const lifecycleDefaults = { observedRetireMs: 86400000, joinedRetireMs: 259200000, notify: [] };

export function parseLifecycle(raw) {
  const c = raw ?? {};
  const ms = (value, fallback) =>
    value === undefined ? fallback : Math.min(Math.max(Number(value) || fallback, 60000), 30 * 86400000);
  return {
    observedRetireMs: ms(c.observedRetireMs, lifecycleDefaults.observedRetireMs),
    joinedRetireMs: ms(c.joinedRetireMs, lifecycleDefaults.joinedRetireMs),
    notify: Array.isArray(c.notify) ? c.notify.filter((a) => typeof a === "string" && a.length <= 220).slice(0, 16) : [],
    // Sources the transcript scanner refreshes from file activity; the server
    // fills this from awareness.json roots, so it is absent in tests unless set.
    scannedSources: Array.isArray(c.scannedSources) ? c.scannedSources.filter((s) => typeof s === "string").slice(0, 16) : [],
  };
}

// Resolving an incident merges into its recorded evidence: the observations
// and attempts already there explain why it was opened.
export function resolveSubjectIncidents(db, now, id) {
  db.prepare("UPDATE overseer_incidents SET state='resolved',updated_at=?,evidence=json_set(COALESCE(NULLIF(evidence,''),'{}'),'$.resolution','subject-retired') WHERE session_id=? AND state!='resolved'")
    .run(now, id);
}

// Caller supplies the transaction; every branch is a no-op when the row is
// already retired, so a replayed retirement emits once.
export function applyRetirement(db, emit, now, id, { reason, successor } = {}) {
  let changed = 0;
  changed += db
    .prepare("UPDATE sessions SET retired_at=?,retired_reason=?,successor=COALESCE(?,successor) WHERE id=? AND retired_at IS NULL")
    .run(now, reason, successor ?? null, id).changes;
  changed += db
    .prepare("UPDATE session_views SET retired_at=?,retired_reason=?,successor=COALESCE(?,successor) WHERE id=? AND retired_at IS NULL")
    .run(now, reason, successor ?? null, id).changes;
  if (!changed) return false;
  resolveSubjectIncidents(db, now, id);
  emit("session.retired", { session: id, reason, ...(successor ? { successor } : {}) });
  return true;
}

export function lifecycleFor(row, now, { observedMs = lifecycleDefaults.observedRetireMs, joinedMs = lifecycleDefaults.joinedRetireMs, scanned = [] } = {}) {
  if (row.retired_at !== null && row.retired_at !== undefined) return "retired";
  if (["exited", "cancelled"].includes(row.state)) return "exited";
  const last = Math.max(row.heartbeat_at ?? 0, row.progress_at ?? 0, row.observed_at ?? 0);
  if (now - last <= 120000) return "live";
  // Enrolled sessions and adapter-reported observations get the joined
  // threshold; only transcript-scanned observations use the shorter one.
  const threshold = row.source !== "agent" && scanned.includes(row.source) ? observedMs : joinedMs;
  if (now - last < threshold) return "idle";
  return "stale";
}
