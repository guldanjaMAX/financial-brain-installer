/** Shared expected shape for a refusal-only Gmail ready receipt. */

export function gmailRefusalReadyReceipt({
  runId,
  startedAt,
  completedAt,
  lane = "incremental",
  filesSeen = 2,
  refused = 2,
  skipped = refused,
} = {}) {
  return {
    source: "gmail",
    kind: "gmail",
    status: "ready",
    run_id: runId,
    lane,
    started_at: startedAt,
    completed_at: completedAt,
    complete_sweep: false,
    walk_complete: true,
    files_seen: filesSeen,
    docs_added: 0,
    docs_updated: 0,
    docs_unchanged: 0,
    docs_refused: refused,
    docs_failed: 0,
    detail: `gmail ${lane} sync completed; skipped=${skipped}; policy_skipped=0; ` +
      `coverage_gaps=0; source_resolved=0; adjudicated_skips=0; withheld_for_secrets=${refused}`,
  };
}
