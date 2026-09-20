/**
 * Owner-safe source coverage, derived from durable source and sync evidence.
 *
 * Freshness, historical completeness, and semantic projection answer different
 * questions. Keeping them separate prevents a recent successful tick from
 * making years of missing history look complete, or a vector backlog from
 * making already stored documents look absent.
 */

export const STARTER_CONTEXT_STATES = Object.freeze(["preparing", "ready", "degraded"]);
export const LIVE_UPDATE_STATES = Object.freeze(["catching_up", "current", "stale", "unavailable"]);
export const HISTORY_STATES = Object.freeze([
  "not_started", "running", "complete", "needs_attention", "unknown",
]);
export const MEANING_SEARCH_STATES = Object.freeze(["projecting", "ready", "degraded", "unknown"]);

const OWNER_MACHINE_KINDS = new Set([
  "drive", "gmail", "calendar", "imap", "imessage", "whatsapp",
  "dropbox", "microsoft", "slack", "notion", "hubspot", "quickbooks",
]);
const finiteCount = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
};

const timestamp = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const millis = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
};

function starterState(source) {
  const documents = finiteCount(source.documents) || 0;
  if (documents > 0) {
    return ["broken", "review"].includes(source.state) ? "degraded" : "ready";
  }
  if (source.last_complete_sweep_at) {
    return "ready";
  }
  if (["broken", "review"].includes(source.state)) return "degraded";
  return "preparing";
}

function liveState(source) {
  source ||= {};
  if (source.state === "indexing") return "catching_up";
  if (["broken", "review", "stale"].includes(source.state)) return "stale";
  if (source.state === "ok" && source.expected_every_days !== null) return "current";
  return "unavailable";
}

function latestRunNeedsAttention(latestRun) {
  if (!latestRun) return false;
  const outcome = String(latestRun.outcome || "").toLowerCase();
  if (["failed", "refused", "partial"].includes(outcome)) return true;
  if (latestRun.error || latestRun.refusal_reason) return true;
  const runClosed = latestRun.finished_at !== null && latestRun.finished_at !== undefined;
  if (!runClosed) return false;
  if (!(latestRun.walk_complete === true || Number(latestRun.walk_complete) === 1)) return true;
  return (finiteCount(latestRun.docs_refused) || 0) > 0 ||
    (finiteCount(latestRun.docs_failed) || 0) > 0;
}

function historyState(source, latestRun) {
  const latestOutcome = String(latestRun?.outcome || "").toLowerCase();
  if (source.state === "indexing" || latestOutcome === "in_progress" ||
      (latestRun && latestRun.finished_at === null)) return "running";
  // The prior complete-through timestamp remains useful evidence, but a newer
  // incomplete run must not borrow it to look complete today.
  if (latestRunNeedsAttention(latestRun)) return "needs_attention";
  if (source.last_complete_sweep_at) return "complete";
  if (["broken", "review"].includes(source.state)) return "needs_attention";
  if ((finiteCount(source.documents) || 0) === 0) return "not_started";
  return "unknown";
}

/**
 * Build the four-dimensional coverage view from evidence already stored in D1.
 * Date ranges remain null until a connector records bounded window evidence.
 */
export function sourceCoverageFromEvidence(source, {
  latestRun = null,
  projectionPending = null,
} = {}) {
  const documents = finiteCount(source?.documents) || 0;
  const runClosed = latestRun?.finished_at !== null && latestRun?.finished_at !== undefined;
  // Older receipts coerce omitted counters to zero. A completed walk proves
  // the original accepted counters were measured. metrics_version separately
  // proves that refused and failed were supplied rather than schema defaults.
  const runMeasured = runClosed &&
    (latestRun?.walk_complete === true || Number(latestRun?.walk_complete) === 1);
  const outcomeCountsMeasured = runMeasured && Number(latestRun?.metrics_version || 0) >= 1;
  const refused = outcomeCountsMeasured ? finiteCount(latestRun?.docs_refused) : null;
  const failed = outcomeCountsMeasured ? finiteCount(latestRun?.docs_failed) : null;
  // A connector's claimed range is confirmation only when that exact receipt
  // measured every outcome and lost none. Otherwise a refusal inside the range
  // could be misdescribed as material that is missing only outside it.
  const rangeConfirmed = refused === 0 && failed === 0 &&
    !latestRun?.error && !latestRun?.refusal_reason;
  const added = runMeasured ? finiteCount(latestRun?.docs_added) : null;
  const updated = runMeasured ? finiteCount(latestRun?.docs_updated) : null;
  const unchanged = runMeasured ? finiteCount(latestRun?.docs_unchanged) : null;
  const accepted = [added, updated, unchanged].every((value) => value !== null)
    ? added + updated + unchanged
    : null;
  const pending = finiteCount(projectionPending);
  const starter = starterState({ ...source, documents });
  const kind = String(source?.kind || "").toLowerCase();

  return Object.freeze({
    starter_context: Object.freeze({ state: starter }),
    live_updates: Object.freeze({ state: liveState(source) }),
    history: Object.freeze({ state: historyState(source, latestRun) }),
    meaning_search: Object.freeze({
      state: pending === null ? "unknown" : pending > 0 ? "projecting" : "ready",
    }),
    confirmed_range: Object.freeze({
      from: rangeConfirmed ? timestamp(latestRun?.confirmed_from) : null,
      through: rangeConfirmed ? timestamp(latestRun?.confirmed_through) : null,
    }),
    target_range: Object.freeze({
      from: timestamp(latestRun?.target_from),
      through: timestamp(latestRun?.target_through),
    }),
    current_window: null,
    counts: Object.freeze({
      seen: runMeasured ? finiteCount(latestRun?.files_seen) : null,
      accepted,
      refused,
      failed,
    }),
    last_progress_at: timestamp(source?.indexing_started_at) || timestamp(source?.last_ingest_at),
    projection_pending: pending,
    waiting_on_owner_machine: OWNER_MACHINE_KINDS.has(kind) &&
      ["manual", "unscheduled", "stale", "broken", "review"].includes(String(source?.state || "")),
  });
}

/** Fill only unknown semantic state from the exact whole-brain vector read. */
export function settleMeaningSearch(coverage, vectors) {
  if (!coverage || coverage.meaning_search?.state !== "unknown") return coverage;
  const state = !vectors
    ? "degraded"
    : vectors.ready
      ? "ready"
      : "projecting";
  return {
    ...coverage,
    meaning_search: { state },
  };
}

/**
 * Absence is provisional until the source and requested range are confirmed.
 * The caller supplies a reviewed human label, never a source slug.
 */
export function provisionalCoverageNotice(label, coverage) {
  if (!coverage || coverage.history?.state === "complete") return null;
  const safeLabel = String(label || "This source").replace(/\s+/g, " ").trim() || "This source";
  const from = timestamp(coverage.confirmed_range?.from);
  const through = timestamp(coverage.confirmed_range?.through);
  if (from && through) {
    return `${safeLabel} is confirmed from ${from.slice(0, 10)} through ${through.slice(0, 10)}. Material outside that range may still be loading.`;
  }
  if (from) {
    return `${safeLabel} is confirmed from ${from.slice(0, 10)} onward. Older material may still be loading.`;
  }
  return `${safeLabel} history is not yet proven complete. A missing result may still be outside the confirmed coverage.`;
}
