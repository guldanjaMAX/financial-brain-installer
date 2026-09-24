/** Privacy-safe aggregation for the read-only after-load quality command. */

import { refusalReasonCategory } from "./refusal-reasons.mjs";
import { sourceCoverageFromEvidence } from "../worker/src/lib/source-coverage.js";

const countIn = (object, key, amount = 1) => {
  object[key] = (object[key] || 0) + amount;
};

const count = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
};

export function buildLoadQualityReport({ inventory, quality, checkpointSkips = {} } = {}) {
  const sources = (inventory?.sources || []).map((source) => {
    const run = source?.receipt?.latest_run || null;
    const runOutcome = String(run?.outcome || "").toLowerCase();
    const runClosed = run?.finished_at !== null && run?.finished_at !== undefined &&
      run?.finished_at !== "" && !["in_progress", "indexing"].includes(runOutcome);
    const measured = sourceCoverageFromEvidence({
      kind: source?.kind,
      state: source?.freshness?.state,
      documents: source?.storage?.logical_documents,
      last_complete_sweep_at: source?.receipt?.last_complete_sweep_at,
    }, { latestRun: runClosed ? run : null }).counts;
    const added = measured.accepted === null ? null : count(run?.docs_added);
    const updated = measured.accepted === null ? null : count(run?.docs_updated);
    const unchanged = measured.accepted === null ? null : count(run?.docs_unchanged);
    return {
      source: String(source?.name || source?.source_id || "unknown"),
      outcome: run?.outcome || "unavailable",
      files_seen: measured.seen,
      accepted: measured.accepted,
      added,
      updated,
      unchanged,
      refused: measured.refused,
      failed: measured.failed,
    };
  });

  const refusalReasons = {};
  let tooLarge = 0;
  for (const skips of Object.values(checkpointSkips || {})) {
    for (const reason of Object.values(skips || {})) {
      const category = refusalReasonCategory(reason);
      countIn(refusalReasons, category);
      if (category === "too large") tooLarge++;
    }
  }

  const duplicateAggregate = quality?.duplicates || {};
  const outlierAggregate = quality?.chunk_outliers || {};
  const sourcesMeasured = sources.every((source) =>
    [source.files_seen, source.accepted, source.refused, source.failed]
      .every((value) => value !== null));
  return {
    contract_version: 1,
    kind: "after_load_quality_report",
    as_of: inventory?.as_of || null,
    complete: inventory?.complete === true && quality?.complete === true && sourcesMeasured,
    sources,
    refusal_reasons: refusalReasons,
    refusal_reason_basis: "current local source checkpoints; reasons are not yet bound to one durable remote run",
    too_large: tooLarge,
    duplicates: {
      observable: quality?.complete === true && duplicateAggregate.observable === true,
      groups: count(duplicateAggregate.groups),
      extra_documents: count(duplicateAggregate.extra_documents),
    },
    chunk_outliers: {
      observable: quality?.complete === true && outlierAggregate.observable === true,
      largest_document_chunks: count(outlierAggregate.largest_document_chunks),
      total_chunks: count(outlierAggregate.total_chunks),
    },
  };
}

export function renderLoadQualityReport(report) {
  const lines = ["  AFTER-LOAD QUALITY REPORT"];
  for (const source of report.sources) {
    const accepted = source.accepted === null ? "accepted unknown" : `${source.accepted} accepted`;
    const refused = source.refused === null ? "refused unknown" : `${source.refused} refused`;
    const failed = source.failed === null ? "failed unknown" : `${source.failed} failed`;
    lines.push(`  ${source.source}: ${accepted}, ${refused}, ${failed}; outcome ${source.outcome}`);
  }
  lines.push(report.duplicates.observable
    ? `  ${report.duplicates.extra_documents ?? 0} duplicate document(s) beyond one copy`
    : "  Duplicate document count is not observable from this aggregate receipt");
  lines.push(`  ${report.too_large} too large in current local checkpoints`);
  lines.push(report.chunk_outliers.observable
    ? `  Largest document: ${report.chunk_outliers.largest_document_chunks ?? 0} chunk(s) of ${report.chunk_outliers.total_chunks ?? 0} total`
    : "  Largest-document chunk count is not observable from this aggregate receipt");
  const reasons = Object.entries(report.refusal_reasons)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  lines.push("  Refusal reasons from current local checkpoints:");
  if (!reasons.length) lines.push("    none recorded locally");
  for (const [reason, total] of reasons) lines.push(`    ${total}: ${reason}`);
  if (!report.complete) lines.push("  This report is incomplete; no missing measurement was treated as zero.");
  return lines.join("\n");
}
