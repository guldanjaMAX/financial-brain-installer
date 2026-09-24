/** Privacy-safe aggregation for the read-only after-load quality command. */

import { refusalReasonCategory } from "./refusal-reasons.mjs";

const countIn = (object, key, amount = 1) => {
  object[key] = (object[key] || 0) + amount;
};

const count = (value) => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;

export function buildLoadQualityReport({ inventory, diagnosis, checkpointSkips = {} } = {}) {
  const sources = (inventory?.sources || []).map((source) => {
    const run = source?.receipt?.latest_run || null;
    const added = count(run?.docs_added);
    const updated = count(run?.docs_updated);
    const unchanged = count(run?.docs_unchanged);
    const accepted = [added, updated, unchanged].every((value) => value !== null)
      ? added + updated + unchanged
      : null;
    return {
      source: String(source?.name || source?.source_id || "unknown"),
      outcome: run?.outcome || "unavailable",
      files_seen: count(run?.files_seen),
      accepted,
      added,
      updated,
      unchanged,
      refused: run?.metrics_version === 1 ? count(run.docs_refused) : null,
      failed: run?.metrics_version === 1 ? count(run.docs_failed) : null,
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

  const findings = Array.isArray(diagnosis?.findings) ? diagnosis.findings : [];
  const duplicateFinding = findings.find((finding) => finding?.id === "duplicate_documents") || null;
  const chunkOutliers = findings.find((finding) => finding?.id === "chunk_outliers") || null;
  return {
    contract_version: 1,
    kind: "after_load_quality_report",
    as_of: inventory?.as_of || null,
    complete: inventory?.complete === true && diagnosis?.complete === true,
    sources,
    refusal_reasons: refusalReasons,
    refusal_reason_basis: "current local source checkpoints; reasons are not yet bound to one durable remote run",
    too_large: tooLarge,
    duplicates: {
      observable: diagnosis?.complete === true,
      extra_documents: duplicateFinding ? count(duplicateFinding.count) : 0,
      detail: duplicateFinding?.detail || null,
    },
    chunk_outliers: chunkOutliers
      ? {
          observable: chunkOutliers.observable !== false,
          count: count(chunkOutliers.count),
          detail: chunkOutliers.detail || null,
        }
      : { observable: diagnosis?.complete === true, count: 0, detail: null },
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
    ? `  ${report.duplicates.extra_documents || 0} duplicate document(s) beyond one copy`
    : "  Duplicate document count is not observable from this diagnostic receipt");
  lines.push(`  ${report.too_large} too large in current local checkpoints`);
  lines.push(report.chunk_outliers.observable
    ? `  Oversized document outliers: ${report.chunk_outliers.count || 0}`
    : "  Oversized document outliers are not observable at this corpus size");
  const reasons = Object.entries(report.refusal_reasons)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  lines.push("  Refusal reasons from current local checkpoints:");
  if (!reasons.length) lines.push("    none recorded locally");
  for (const [reason, total] of reasons) lines.push(`    ${total}: ${reason}`);
  if (!report.complete) lines.push("  This report is incomplete; no missing measurement was treated as zero.");
  return lines.join("\n");
}
