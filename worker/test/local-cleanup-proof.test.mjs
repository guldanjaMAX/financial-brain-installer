import assert from "node:assert/strict";
import test from "node:test";

import { localCleanupProof } from "../src/lib/local-cleanup-proof.js";

function fakeDb(rowsBySourceId) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...values) {
          calls.push({ sql, values });
          return {
            async all() {
              return { results: rowsBySourceId[values[1]] || [] };
            },
          };
        },
      };
    },
  };
}

test("cleanup proof requires exact current provenance and vector readback", async () => {
  const DB = fakeDb({
    "ready.txt": [
      { doc_uid: "drop:ready.txt", source_id: "ready.txt", meta: "{}", document_revision_id: "rev-1", original_id: "hmac-sha256:" + "a".repeat(64), external_count: 1, chunk_uid: "c1", chunk_ix: 0, vector_id: "v1", bound_document_revision_id: "rev-1", result_chunk_receipt_hash: "receipt-1" },
      { doc_uid: "drop:ready.txt", source_id: "ready.txt", meta: "{}", document_revision_id: "rev-1", original_id: "hmac-sha256:" + "a".repeat(64), external_count: 1, chunk_uid: "c2", chunk_ix: 1, vector_id: "v2", bound_document_revision_id: "rev-1", result_chunk_receipt_hash: "receipt-2" },
    ],
    "large.txt": [
      { doc_uid: "drop:large.txt#part1of2", source_id: "large.txt#part1of2", meta: JSON.stringify({ part_of: "large.txt", part: 1, part_count: 2 }), document_revision_id: "rev-2", original_id: "hmac-sha256:" + "b".repeat(64), external_count: 0, chunk_uid: "c3", chunk_ix: 0, vector_id: "v3", bound_document_revision_id: "rev-2", result_chunk_receipt_hash: "receipt-3" },
      { doc_uid: "drop:large.txt#part2of2", source_id: "large.txt#part2of2", meta: JSON.stringify({ part_of: "large.txt", part: 2, part_count: 2 }), document_revision_id: "rev-3", original_id: "hmac-sha256:" + "b".repeat(64), external_count: 0, chunk_uid: "c4", chunk_ix: 0, vector_id: "v4", bound_document_revision_id: "rev-3", result_chunk_receipt_hash: "receipt-4" },
    ],
    "incomplete.txt": [
      { doc_uid: "drop:incomplete.txt#part1of2", source_id: "incomplete.txt#part1of2", meta: JSON.stringify({ part_of: "incomplete.txt", part: 1, part_count: 2 }), document_revision_id: "rev-4", original_id: "hmac-sha256:" + "c".repeat(64), external_count: 0, chunk_uid: "c5", chunk_ix: 0, vector_id: "v5", bound_document_revision_id: "rev-4", result_chunk_receipt_hash: "receipt-5" },
    ],
    "pending.txt": [],
  });
  const result = await localCleanupProof({ DB, VECTORIZE: {
    getByIds: async (ids) => ids.map((id) => ({ id })),
  } }, {
    source: "drop",
    candidates: [
      { source_id: "ready.txt", original_content_sha256: "1".repeat(64), original_byte_count: 12 },
      { source_id: "large.txt", original_content_sha256: "2".repeat(64), original_byte_count: 24 },
      { source_id: "incomplete.txt", original_content_sha256: "3".repeat(64), original_byte_count: 30 },
      { source_id: "pending.txt", original_content_sha256: "2".repeat(64), original_byte_count: 34 },
    ],
  });
  assert.equal(result.confirmations[0].accepted_resolution_current, true);
  assert.equal(result.confirmations[0].matching_current_source, "another_current_source");
  assert.match(result.confirmations[0].proof, /^[a-f0-9]{64}$/);
  assert.equal(result.confirmations[1].accepted_resolution_current, true, "a complete split family is eligible");
  assert.equal(result.confirmations[2].accepted_resolution_current, false, "a partial split family fails closed");
  assert.equal(result.confirmations[3].accepted_resolution_current, false);
  assert.equal(result.decision_points, 4, "every candidate reached the authoritative query");
  assert.equal(DB.calls.every((call) => /source_original_result_bindings/.test(call.sql)), true);
  assert.equal(DB.calls.every((call) => /vector_outbox/.test(call.sql)), true);
  assert.equal(DB.calls.every((call) => !/\b(?:document|chunk)\.text\b/is.test(call.sql)), true);
});

test("cleanup proof rejects malformed and oversized candidate sets before D1", async () => {
  const DB = fakeDb({});
  await assert.rejects(() => localCleanupProof({ DB }, {
    source: "drop",
    candidates: [{ source_id: "x", original_content_sha256: "bad", original_byte_count: 1 }],
  }), /sha256/);
  assert.equal(DB.calls.length, 0);
  await assert.rejects(() => localCleanupProof({ DB }, {
    source: "drop",
    candidates: Array.from({ length: 501 }, (_, index) => ({
      source_id: `f-${index}`,
      original_content_sha256: "a".repeat(64),
      original_byte_count: 1,
    })),
  }), /500/);
});
