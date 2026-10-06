import assert from "node:assert/strict";

import worker from "../src/index.js";
import { readExactDocumentReport } from "../src/lib/documents-summary.js";

const statements = [];
const env = {
  STORAGE: "d1",
  ADMIN_KEY: "fixture-admin-key",
  VECTORIZE: { describe: async () => ({ vectorCount: 0 }) },
  DB: {
    prepare(sql) {
      statements.push(sql);
      if (/document_summary/i.test(sql) || /FROM\s+documents\b|FROM\s+chunks\b|json_extract/i.test(sql)) {
        throw new Error("HOT_PATH_CORPUS_SCAN");
      }
      const rows = /document_source_inventory/i.test(sql)
        ? [{
          source_type: "synthetic",
          has_documents: 1,
          last_ingest_at: 1_750_000_000_000,
        }]
        : /count\(\*\).*vector_outbox/is.test(sql)
          ? [{ n: 0, oldest: null, upserts: 0, deletes: 0, submitted: 0 }]
          : /FROM\s+install_state\s+WHERE\s+id\s*=\s*1/is.test(sql)
            ? [{
              schema_version: 48,
              outbox_generation: 0,
              mutation_id: null,
              mutation_submitted_at: null,
              projection_status: "verified",
              bootstrap_epoch: 0,
              bootstrap_cursor: null,
              bootstrap_high_water: null,
              expected_vectors: 0,
              pending: 0,
              submitted: 0,
              oldest_queued_at: null,
            }]
            : [];
      const prepared = {
        bind: () => prepared,
        all: async () => ({ results: rows }),
        first: async () => rows[0] ?? null,
        run: async () => ({ success: true, meta: { changes: 0 } }),
      };
      return prepared;
    },
  },
};

const response = await worker.fetch(new Request(
  "https://brain.invalid/api/admin/brain/documents",
  { headers: { "X-Admin-Key": "fixture-admin-key" } },
), env, { waitUntil() {} });
const body = await response.json();

assert.equal(response.status, 200, JSON.stringify(body));
assert.ok(statements.some((sql) => /document_source_inventory/i.test(sql)),
  "the bounded source-inventory decision point was not reached");
assert.ok(statements.every((sql) => !/document_summary/i.test(sql)),
  "the removed asynchronous summary cache was still read");
assert.equal(body.rows?.[0]?.has_documents, true, JSON.stringify(body));
assert.equal(body.rows?.[0]?.documents, null, JSON.stringify(body));
assert.match(body.rows?.[0]?.count_note || "", /not counted on large Brains; run `brain report`/i);
assert.equal(body.vector_readiness?.error, undefined, JSON.stringify(body.vector_readiness));
assert.equal(body.vector_readiness?.ready, true, JSON.stringify(body.vector_readiness));

console.log("lightweight documents summary: 8 assertions passed");

let markerReads = 0;
const changingMarker = (generation) => ({
  schema_version: 48,
  outbox_generation: generation,
  document_high_water: 0,
  chunk_high_water: 0,
  latest_document_ingest: 0,
  corpus_documents: 0,
  corpus_chunks: 0,
  last_ingest_at: 0,
  source_event_high_water: 0,
  source_count: 0,
  vector_projection_status: "verified",
  vector_projection_mutation_id: "",
  vector_projection_submitted_at: 0,
});
const changingEnv = {
  DB: {
    prepare(sql) {
      const prepared = {
        bind: () => prepared,
        first: async () => changingMarker(++markerReads),
        all: async () => ({ results: [] }),
      };
      return prepared;
    },
  },
};
await assert.rejects(
  () => readExactDocumentReport(changingEnv),
  /overlapped a corpus change/i,
);
assert.equal(markerReads, 2, "the report must compare opening and closing markers");
console.log("documents report mutation fence: 2 assertions passed");

let reportMarkerReads = 0;
let chunkPageReads = 0;
let outboxDeletes = 0;
const pendingOutbox = new Set(["chunk-1", "chunk-2"]);
const pendingReportEnv = {
  DB: {
    prepare(sql) {
      const prepared = {
        bind: () => prepared,
        first: async () => {
          if (/FROM install_state/i.test(sql)) {
            reportMarkerReads++;
            return {
              ...changingMarker(7),
              chunk_high_water: 2,
              outbox_pending: pendingOutbox.size > 0 ? 1 : 0,
            };
          }
          return null;
        },
        all: async () => {
          if (/WITH page AS MATERIALIZED[\s\S]*FROM chunks/i.test(sql)) {
            chunkPageReads++;
            if (chunkPageReads === 2) {
              pendingOutbox.delete("chunk-1");
              outboxDeletes++;
            }
            return { results: [
              { page_state: 1, source_type: null, chunks: 1, pending_vectors: 0,
                last_id: chunkPageReads },
              { page_state: 0, source_type: "synthetic", chunks: 1,
                pending_vectors: chunkPageReads === 1 ? 1 : 0, last_id: null },
            ] };
          }
          return { results: [] };
        },
      };
      return prepared;
    },
  },
};
const pendingReport = await readExactDocumentReport(pendingReportEnv, { chunkPageSize: 1 });
assert.equal(reportMarkerReads, 2, "the pending report must bracket its pages");
assert.equal(chunkPageReads, 2, "the pending report must reach a second chunk page");
assert.equal(outboxDeletes, 1, "the fixture must delete an outbox row between chunk pages");
assert.equal(pendingReport.summary.exact, false,
  "a non-empty outbox cannot produce an exact mixed pending-vector snapshot");
assert.equal(pendingReport.summary.pending_vector_counts_exact, false);
console.log("documents report pending-vector accuracy: 5 assertions passed");
