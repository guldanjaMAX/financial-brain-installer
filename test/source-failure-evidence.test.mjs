import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalGoogleProviderReason,
  normalizeSourceFailureEvidence,
  parseStoredSourceFailureEvidence,
} from "../worker/src/lib/source-receipt.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  assert.ok(condition, `${name}${detail ? `: ${detail}` : ""}`);
  console.log(`PASS  ${name}`);
};

const safe = {
  version: 1,
  operation_class: "gmail_message_read",
  http_status: 400,
  provider_reason: "failed_precondition",
  checkpoint_readback: "verified",
  checkpoint_done: 55,
  checkpoint_skipped: 3,
  cursor_preservation: "absent_preserved",
};

{
  check("Google reason aliases collapse to a closed canonical value",
    canonicalGoogleProviderReason("FAILED_PRECONDITION") === "failed_precondition" &&
      canonicalGoogleProviderReason("failedPrecondition") === "failed_precondition");
  check("an unrecognized provider value collapses to unknown instead of retaining its text",
    canonicalGoogleProviderReason("SYNTHETIC_PRIVATE_PROVIDER_MESSAGE /mail/id") === "unknown");
  check("a missing provider reason remains explicitly unknown rather than invented",
    canonicalGoogleProviderReason(null) === null);
}

{
  const normalized = normalizeSourceFailureEvidence(safe, { status: "error", kind: "gmail" });
  check("normalization reconstructs and freezes the exact versioned evidence shape",
    Object.isFrozen(normalized) && JSON.stringify(normalized) === JSON.stringify(safe),
    JSON.stringify(normalized));

  check("a measured Gmail document-operation failure cannot claim zero failed documents",
    (() => {
      try {
        normalizeSourceFailureEvidence(safe, {
          status: "error", kind: "gmail", metricsVersion: 1, measuredDocsFailed: 0,
        });
        return false;
      } catch (error) {
        return /requires docs_failed of at least 1/.test(error.message);
      }
    })());

  const corrupt = JSON.stringify({ ...safe, raw_error: "SYNTHETIC_PRIVATE_PROVIDER_MESSAGE" });
  check("stored evidence is revalidated before freshness can expose it",
    parseStoredSourceFailureEvidence(corrupt, { status: "error", kind: "gmail" }) === null);
}

{
  // Apply 0040 directly to a schema-38-shaped table. Migration 0039 is owned
  // by the integration candidate, so this branch deliberately does not invent
  // a placeholder merely to make a contiguous local migration walk.
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE sync_runs (
    run_id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    error TEXT
  )`);
  db.exec(readFileSync(join(ROOT, "migrations", "d1", "0040_source_failure_evidence.sql"), "utf8"));
  const columns = db.prepare("PRAGMA table_info(sync_runs)").all();
  check("migration 0040 adds one nullable failure-evidence column",
    columns.filter((column) => column.name === "failure_evidence").length === 1 &&
      columns.find((column) => column.name === "failure_evidence")?.notnull === 0,
    JSON.stringify(columns));

  db.prepare("INSERT INTO sync_runs (run_id,source,error,failure_evidence) VALUES (?,?,?,?)")
    .run("synthetic-run", "gmail", "INGEST_FAILED", JSON.stringify(safe));
  const row = db.prepare("SELECT failure_evidence FROM sync_runs WHERE run_id=?").get("synthetic-run");
  const readback = parseStoredSourceFailureEvidence(row.failure_evidence, { status: "error", kind: "gmail" });
  check("migration 0040 round-trips only revalidated closed evidence",
    JSON.stringify(readback) === JSON.stringify(safe), JSON.stringify(readback));
  db.close();
}

console.log(`\nsource failure evidence: all ${ran} checks passed`);
