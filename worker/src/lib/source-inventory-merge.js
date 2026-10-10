import { sourceCoverageFromEvidence } from "./source-coverage.js";

const RECOVERY_REASON_CODES = Object.freeze([
  "no_stored_chunks",
  "blank_only_chunks",
  "ocr_partial_review",
  "provenance_receipt_unassessed",
  "extraction_method_missing",
  "text_reliability_missing",
  "source_record_id_missing",
  "derivation_lineage_missing",
  "lineage_contract_unrecognized",
]);

export function recoveryPlanSummary(sources) {
  const reasonCounts = Object.fromEntries(RECOVERY_REASON_CODES.map((code) => [code, 0]));
  const sourceGroups = [];
  const blockingSignals = new Set();
  let candidates = 0;
  for (const source of sources) {
    const plan = source?.recovery_plan;
    if (!plan || !Number.isSafeInteger(plan.candidate_documents) || plan.candidate_documents < 0) {
      throw new Error("source inventory returned an invalid recovery summary");
    }
    candidates += plan.candidate_documents;
    for (const code of RECOVERY_REASON_CODES) {
      const count = Number(plan.reason_counts?.[code]);
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error("source inventory returned an invalid recovery reason count");
      }
      reasonCounts[code] += count;
    }
    for (const signal of plan.blocking_signals || []) blockingSignals.add(String(signal));
    if (plan.candidate_documents > 0) {
      sourceGroups.push({
        source_id: source.source_id,
        source_kind: source.kind,
        zone: source.zone,
        candidate_documents: plan.candidate_documents,
        reason_counts: plan.reason_counts,
        blocking_signals: plan.blocking_signals,
        priority: plan.priority,
        priority_basis: plan.priority_basis,
      });
    }
  }
  const boundedSourceGroups = sourceGroups.slice(0, 250);
  return {
    status: candidates ? "review_needed" : "no_candidates",
    read_only: true,
    candidate_documents: candidates,
    candidate_source_groups: sourceGroups.length,
    source_groups_returned: boundedSourceGroups.length,
    source_groups_truncated: boundedSourceGroups.length < sourceGroups.length,
    source_groups_cursor: boundedSourceGroups.length < sourceGroups.length
      ? boundedSourceGroups[boundedSourceGroups.length - 1]?.source_id || null
      : null,
    source_group_details: "complete_in_sources_pages",
    candidate_pages_at_max_size: Math.ceil(candidates / 250),
    maximum_page_size: 250,
    priority: sourceGroups.some((group) => group.priority === "high")
      ? "high"
      : candidates
        ? "review"
        : "none",
    blocking_signals: [
      "records_without_readable_text",
      "partial_ocr_receipts",
      "incomplete_provenance_receipts",
    ].filter((signal) => blockingSignals.has(signal)),
    reason_counts: reasonCounts,
    source_groups: boundedSourceGroups,
  };
}


const coverage = (total, count) => !total || !count ? "unavailable" : total === count ? "complete" : "partial";
const union = (a, b) => [...new Set([...a, ...b])];
function sumCounts(target, next) {
  for (const [key, value] of Object.entries(next)) {
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(target[key] + value)) {
        throw new Error("invalid inventory count");
      }
      target[key] += value;
    } else if (value && typeof value === "object" && !Array.isArray(value)) sumCounts(target[key], value);
  }
}
function mergeReceipt(a, b) {
  if (!a || !b) return;
  for (const field of ["first_stored_ingest_at", "last_stored_ingest_at"]) {
    const values = [a[field], b[field]].filter(Boolean).sort();
    a[field] = (field.startsWith("first") ? values[0] : values.at(-1)) || null;
  }
  if (b.first_ingest_observed_at && (!a.first_ingest_observed_at || b.first_ingest_observed_at < a.first_ingest_observed_at)) {
    a.first_ingest_observed_at = b.first_ingest_observed_at;
    a.first_ingest_evidence = [...b.first_ingest_evidence];
  } else if (a.first_ingest_observed_at === b.first_ingest_observed_at) {
    a.first_ingest_evidence = union(a.first_ingest_evidence, b.first_ingest_evidence).sort();
  }
}

/** Accumulate private page counts. Family HMACs never appear in final output. */
export function createInventoryAccumulator() {
  const sources = new Map();
  const families = new Map();
  return {
    add(page) {
      if (!Array.isArray(page.sources) || !Array.isArray(page.families) || page.sources.length > 10000 ||
          page.families.length > 5000) throw new Error("invalid inventory page");
      const pageNames = new Set();
      const pageFamilies = new Map();
      for (const row of page.sources) {
        if (pageNames.has(row?.source_id)) throw new Error("duplicate inventory source");
        pageNames.add(row?.source_id);
        pageFamilies.set(row?.source_id, new Set());
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(row?.source_id)) throw new Error("invalid inventory source");
        const prior = sources.get(row.source_id);
        if (!prior) {
          sources.set(row.source_id, structuredClone(row));
          families.set(row.source_id, new Set());
        } else {
          for (const field of ["storage", "readability", "provenance", "recovery_plan"]) sumCounts(prior[field], row[field]);
          prior.provenance.missing_subfields = union(prior.provenance.missing_subfields, row.provenance.missing_subfields);
          prior.recovery_plan.blocking_signals = union(prior.recovery_plan.blocking_signals, row.recovery_plan.blocking_signals);
          mergeReceipt(prior.receipt, row.receipt);
        }
      }
      if (sources.size > 10000) throw new Error("inventory source bound exceeded");
      for (const pair of page.families) {
        if (!Array.isArray(pair) || pair.length !== 2 || !families.has(pair[0]) ||
            !/^hmac-sha256:[a-f0-9]{64}$/.test(pair[1])) throw new Error("invalid inventory family");
        if (!pageFamilies.has(pair[0]) || pageFamilies.get(pair[0]).has(pair[1])) throw new Error("invalid inventory family");
        pageFamilies.get(pair[0]).add(pair[1]);
        families.get(pair[0]).add(pair[1]);
      }
      for (const row of page.sources) {
        if (!Number.isSafeInteger(row.storage.physical_documents) || row.storage.physical_documents < 0 ||
            row.storage.logical_documents !== pageFamilies.get(row.source_id).size ||
            row.storage.logical_documents > row.storage.physical_documents) throw new Error("invalid inventory family count");
      }
    },
    finish() {
      return [...sources.values()].sort((a, b) => a.source_id < b.source_id ? -1 : 1).map((row) => {
        const physical = row.storage.physical_documents;
        const logical = families.get(row.source_id).size;
        row.storage.logical_documents = logical;
        row.readability.status = coverage(physical, row.readability.readable_documents);
        const p = row.provenance;
        p.missing_subfields = ["validated_provenance_receipt", "source_record_id", "extraction_method",
          "text_reliability", "derivation_lineage", "recognized_lineage_contract"].filter((field) => p.missing_subfields.includes(field));
        const evidence = Math.max(p.source_identity.recorded_documents, p.extraction.method_recorded_documents,
          p.extraction.reliability_recorded_documents, p.lineage.recorded_documents);
        p.status = !physical || !evidence ? "unavailable" : physical === p.complete_documents ? "complete" : "partial";
        p.source_identity.status = coverage(physical, p.source_identity.recorded_documents);
        p.extraction.status = coverage(physical, Math.min(p.extraction.method_recorded_documents, p.extraction.reliability_recorded_documents));
        p.lineage.status = coverage(physical, p.lineage.recorded_documents);
        const recovery = row.recovery_plan;
        recovery.blocking_signals = ["records_without_readable_text", "partial_ocr_receipts", "incomplete_provenance_receipts"]
          .filter((signal) => recovery.blocking_signals.includes(signal));
        recovery.status = recovery.candidate_documents ? "review_needed" : "no_candidates";
        recovery.priority = row.readability.unreadable_documents ? "high" : recovery.candidate_documents ? "review" : "none";
        recovery.priority_basis = row.readability.unreadable_documents ? "stored records without nonblank searchable text"
          : recovery.candidate_documents ? "stored OCR or provenance receipts require review" : "no stored recovery condition was found";
        if (row.receipt) row.receipt.logical_matches_reported = row.receipt.reported_logical_documents === logical;
        // Only these coverage dimensions depend on the accumulated document
        // count; preserve the original receipt's range/refusal proof verbatim.
        const nextCoverage = sourceCoverageFromEvidence({ ...row.freshness, kind: row.kind,
          documents: logical }, { latestRun: row.receipt?.latest_run });
        row.freshness.coverage = { ...row.freshness.coverage,
          starter_context: nextCoverage.starter_context, history: nextCoverage.history };
        return row;
      });
    },
  };
}
