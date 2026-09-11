import assert from "node:assert/strict";
import test from "node:test";

import { createProductFixture } from "./product-contract-fixture.mjs";
import {
  SOURCE_ORIGINAL_OBSERVATION_PATH,
  sourceOriginalResultBindingReadiness,
} from "../src/lib/source-original-observation.js";
import { hashSourceOriginalResultBinding } from "../src/lib/source-original-binding.js";
import { sourceOriginalChunkReceiptHash } from "../src/lib/source-original-chunk.js";
import {
  handleSourceOriginalResultFamily,
  SourceOriginalResultFamilyError,
} from "../src/lib/source-original-result-family.js";

const ADMIN = { "X-Admin-Key": "fixture-admin-key" };
const SOURCE = "localdocs";
const LOCATOR = "proofs/synthetic-statement.pdf";
const CONTENT_SHA = "3".repeat(64);
const DOCUMENT_HASH = "4".repeat(64);
const PROVENANCE_DIGEST = "5".repeat(64);
const REVISION_ID = `rev-v1:${"6".repeat(64)}`;
const TITLE = "Synthetic proof statement";
const CHUNK_TEXT = `[${TITLE}]\n\nQuasar ledger reference 7319 proves deterministic retrieval.`;
const CHUNK_UID = "family-proof-chunk";
const VECTOR_ID = CHUNK_UID;
const QUERY = "quasar ledger 7319";

async function json(response) {
  assert.match(response.headers.get("cache-control") || "", /private, no-store/);
  return response.json();
}

function request(operation) {
  return {
    contract_version: 1,
    mode: "result_family",
    ...(operation ? { operation } : {}),
    source: SOURCE,
    locator_kind: "source_relative_path",
    locator: LOCATOR,
    original_content_sha256: CONTENT_SHA,
    original_byte_count: 9876,
    retrieval_query: QUERY,
  };
}

async function seedBoundFamily(fixture) {
  fixture.raw(
    "INSERT INTO sources (name,kind,status,created_at) VALUES (?,?,?,?)",
    SOURCE, "upload", "ready", "2026-09-11T00:00:00Z",
  );
  fixture.raw(
    "INSERT INTO source_original_id_key_state (tenant_id,signing_salt) VALUES ('primary',?)",
    "a".repeat(64),
  );
  const sealResponse = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, {
    contract_version: 1,
    mode: "seal",
    source: SOURCE,
    plan_id: "1".repeat(64),
    source_snapshot_id: `sha256:${"2".repeat(64)}`,
    targets: [{ locator_kind: "source_relative_path", locator: LOCATOR }],
  }, ADMIN);
  const seal = await json(sealResponse);
  assert.equal(sealResponse.status, 200, JSON.stringify(seal));
  const originalId = seal.targets[0].original_id;
  const bindingReceipt = {
    contract_version: 1,
    tenant_id: "primary",
    source: SOURCE,
    original_id: originalId,
    locator_kind: "source_relative_path",
    document_revision_id: REVISION_ID,
    original_content_sha256: CONTENT_SHA,
    original_byte_count: 9876,
    document_content_hash: DOCUMENT_HASH,
    provenance_receipt_digest: PROVENANCE_DIGEST,
  };
  const bindingHash = await hashSourceOriginalResultBinding(bindingReceipt);
  fixture.raw(
    `INSERT INTO source_original_result_bindings
       (contract_version,tenant_id,source,original_id,locator_kind,document_revision_id,
        original_content_sha256,original_byte_count,document_content_hash,
        provenance_receipt_digest,binding_hash,bound_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ...Object.values(bindingReceipt), bindingHash, 1,
  );
  fixture.raw(
    `INSERT INTO documents
       (doc_uid,source,source_id,title,ingested_at,content_hash,meta,text_source,text_reliable,
        provenance_receipt_digest,document_revision_id,source_original_binding_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    `${SOURCE}:${LOCATOR}`, SOURCE, LOCATOR, TITLE, 1, DOCUMENT_HASH, "{}", "native", 1,
    PROVENANCE_DIGEST, REVISION_ID, bindingHash,
  );
  const chunkReceiptHash = await sourceOriginalChunkReceiptHash({
    document_revision_id: REVISION_ID,
    chunk_ix: 0,
    title: TITLE,
    text: CHUNK_TEXT,
  });
  fixture.raw(
    `INSERT INTO chunks
       (chunk_uid,doc_uid,chunk_ix,text,source,title,vector_id,
        bound_document_revision_id,result_chunk_receipt_hash)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    CHUNK_UID, `${SOURCE}:${LOCATOR}`, 0, CHUNK_TEXT, SOURCE, TITLE, VECTOR_ID,
    REVISION_ID, chunkReceiptHash,
  );
  fixture.env.VECTORIZE.describe = async () => ({ vectorCount: 1, processedUpToMutation: null });
  fixture.env.VECTORIZE.query = async (_embedding, options) => {
    fixture.seen.vectorQueries.push(options);
    return { matches: [{ id: VECTOR_ID, score: 0.99 }] };
  };
  return { originalId, bindingHash, chunkReceiptHash };
}

async function seedUnexpectedBoundRevision(fixture, originalId) {
  const revisionId = `rev-v1:${"e".repeat(64)}`;
  const documentHash = "c".repeat(64);
  const provenanceDigest = "d".repeat(64);
  const title = "Unexpected exact-original revision";
  const text = `[${title}]\n\nA second unstructured current revision.`;
  const bindingReceipt = {
    contract_version: 1,
    tenant_id: "primary",
    source: SOURCE,
    original_id: originalId,
    locator_kind: "source_relative_path",
    document_revision_id: revisionId,
    original_content_sha256: CONTENT_SHA,
    original_byte_count: 9876,
    document_content_hash: documentHash,
    provenance_receipt_digest: provenanceDigest,
  };
  const bindingHash = await hashSourceOriginalResultBinding(bindingReceipt);
  fixture.raw(
    `INSERT INTO source_original_result_bindings
       (contract_version,tenant_id,source,original_id,locator_kind,document_revision_id,
        original_content_sha256,original_byte_count,document_content_hash,
        provenance_receipt_digest,binding_hash,bound_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ...Object.values(bindingReceipt), bindingHash, 2,
  );
  fixture.raw(
    `INSERT INTO documents
       (doc_uid,source,source_id,title,ingested_at,content_hash,meta,text_source,text_reliable,
        provenance_receipt_digest,document_revision_id,source_original_binding_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    `${SOURCE}:unexpected`, SOURCE, "unexpected", title, 2, documentHash, "{}", "native", 1,
    provenanceDigest, revisionId, bindingHash,
  );
  const chunkReceiptHash = await sourceOriginalChunkReceiptHash({
    document_revision_id: revisionId,
    chunk_ix: 0,
    title,
    text,
  });
  fixture.raw(
    `INSERT INTO chunks
       (chunk_uid,doc_uid,chunk_ix,text,source,title,vector_id,
        bound_document_revision_id,result_chunk_receipt_hash)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    "family-proof-unexpected-chunk", `${SOURCE}:unexpected`, 0, text, SOURCE, title,
    "family-proof-unexpected-chunk", revisionId, chunkReceiptHash,
  );
}

function publicPair(patch = {}) {
  const result = {
    chunk_uid: CHUNK_UID,
    doc_uid: `${SOURCE}:${LOCATOR}`,
    source_id: LOCATOR,
    ref_key: LOCATOR,
    drive_file_id: null,
    source: SOURCE,
    source_kind: "upload",
    title: TITLE,
    snippet: CHUNK_TEXT,
    uri: null,
    entity_slug: null,
    client: null,
    category: null,
    top_folder: null,
    platform: null,
    ts: null,
    occurred_at: null,
    date_reliable: false,
    date_source: null,
    text_source: "native",
    text_reliable: true,
    authority: null,
    lineage: { kind: "unclassified", status: "unknown", derived: false, reason: "fixture" },
    score: 1,
    ...patch,
  };
  return {
    result,
    citation: {
      n: 1,
      title: TITLE,
      source: SOURCE,
      source_kind: "upload",
      ref: LOCATOR,
      ts: null,
      date_reliable: false,
      date_source: null,
      text_source: "native",
      text_reliable: true,
      authority: null,
      lineage: result.lineage,
    },
  };
}

test("full-admin result_family records one exact private proof and replays idempotently", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  await seedBoundFamily(fixture);

  const unauthorized = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, request());
  assert.equal(unauthorized.status, 401);
  assert.equal((await json(unauthorized)).code, "admin_required");

  const firstResponse = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, request(), ADMIN);
  const first = await json(firstResponse);
  assert.equal(firstResponse.status, 200, JSON.stringify(first));
  assert.equal(first.mode, "result_family");
  assert.equal(first.operation, "record");
  assert.equal(first.document_count, 1);
  assert.equal(first.chunk_count, 1);
  assert.equal(first.retrieval_status, "deterministic");
  assert.equal(first.citation_status, "same_family");
  assert.equal(first.recorded, true);
  assert.equal(first.replayed, false);
  assert.equal(first.accepted_outcome_authorized, false);
  assert.equal(JSON.stringify(first).includes(LOCATOR), false);
  assert.equal(JSON.stringify(first).includes(QUERY), false);
  assert.match(first.family_receipt_hash, /^sha256:[a-f0-9]{64}$/);
  assert.match(first.verification_hash, /^sha256:[a-f0-9]{64}$/);
  assert.match(first.retrieval_probe_id, /^probe-v1:[a-f0-9]{64}$/);
  assert.equal(fixture.first("SELECT COUNT(*) AS n FROM source_original_result_family_members").n, 1);
  assert.equal(fixture.first("SELECT COUNT(*) AS n FROM source_original_result_family_receipts").n, 1);
  assert.equal(fixture.first("SELECT COUNT(*) AS n FROM source_original_result_family_verifications").n, 1);
  const durableProof = JSON.stringify({
    members: fixture.rows("SELECT * FROM source_original_result_family_members"),
    receipts: fixture.rows("SELECT * FROM source_original_result_family_receipts"),
    verifications: fixture.rows("SELECT * FROM source_original_result_family_verifications"),
  });
  for (const privateValue of [LOCATOR, QUERY, TITLE, CHUNK_TEXT, CHUNK_UID]) {
    assert.equal(durableProof.includes(privateValue), false);
  }
  const proofWrites = fixture.seen.sql.filter((sql) =>
    /^\s*INSERT INTO source_original_result_family_(?:members|receipts|verifications)/.test(sql)
  );
  assert.equal(proofWrites.length, 3, "the atomic proof stays within a three-statement D1 batch");
  assert.match(proofWrites[0], /FROM json_each\(\?2\)/);

  const replayResponse = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, request(), ADMIN);
  const replay = await json(replayResponse);
  assert.equal(replayResponse.status, 200, JSON.stringify(replay));
  assert.equal(replay.family_receipt_hash, first.family_receipt_hash);
  assert.equal(replay.verification_hash, first.verification_hash);
  assert.equal(replay.recorded, false);
  assert.equal(replay.replayed, true);
  assert.equal(fixture.first("SELECT COUNT(*) AS n FROM source_original_result_family_receipts").n, 1);
  assert.equal(fixture.first("SELECT COUNT(*) AS n FROM source_original_result_family_verifications").n, 1);

  const verifyResponse = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, request("verify"), ADMIN);
  const verified = await json(verifyResponse);
  assert.equal(verifyResponse.status, 200, JSON.stringify(verified));
  assert.equal(verified.operation, "verify");
  assert.equal(verified.recorded, false);
  assert.equal(verified.replayed, true);
  assert.equal(fixture.seen.vectorQueries.length, 6);
});

test("result_family replay rejects a low-level chunk source relabel", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  await seedBoundFamily(fixture);

  const firstResponse = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, request(), ADMIN);
  assert.equal(firstResponse.status, 200, JSON.stringify(await json(firstResponse)));

  fixture.raw("UPDATE documents SET title='Relabeled document' WHERE doc_uid=?", `${SOURCE}:${LOCATOR}`);
  const titleReplayResponse = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, request(), ADMIN);
  const titleReplay = await json(titleReplayResponse);
  assert.equal(titleReplayResponse.status, 409, JSON.stringify(titleReplay));
  assert.equal(titleReplay.code, "source_original_result_family_chunk_mismatch");
  fixture.raw("UPDATE documents SET title=? WHERE doc_uid=?", TITLE, `${SOURCE}:${LOCATOR}`);

  fixture.raw("DROP TRIGGER chunks_source_original_receipt_no_stale_update");
  fixture.raw("UPDATE chunks SET source='other' WHERE chunk_uid=?", CHUNK_UID);
  const replayResponse = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, request(), ADMIN);
  const replay = await json(replayResponse);
  assert.equal(replayResponse.status, 409, JSON.stringify(replay));
  assert.equal(replay.code, "source_original_result_family_chunk_mismatch");
  assert.equal(fixture.first("SELECT COUNT(*) AS n FROM source_original_result_family_receipts").n, 1);
  assert.equal(fixture.first("SELECT COUNT(*) AS n FROM source_original_result_family_verifications").n, 1);
});

test("result_family replay detects an extra exact-original current revision", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  const { originalId } = await seedBoundFamily(fixture);

  const firstResponse = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, request(), ADMIN);
  assert.equal(firstResponse.status, 200, JSON.stringify(await json(firstResponse)));
  await seedUnexpectedBoundRevision(fixture, originalId);

  const replayResponse = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, request(), ADMIN);
  const replay = await json(replayResponse);
  assert.equal(replayResponse.status, 409, JSON.stringify(replay));
  assert.equal(replay.code, "source_original_result_family_incomplete");
  assert.equal(fixture.first("SELECT COUNT(*) AS n FROM source_original_result_family_receipts").n, 1);
  assert.equal(fixture.first("SELECT COUNT(*) AS n FROM source_original_result_family_verifications").n, 1);
});

test("two production probes must be identical and retrieval failures write nothing", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  await seedBoundFamily(fixture);
  let calls = 0;
  const retrieve = async () => {
    calls += 1;
    return {
      degraded: false,
      retrieval_scope: "owner",
      access: { principal: "owner" },
      ignored_filters: [],
      results: calls === 1
        ? [publicPair()]
        : [publicPair(), { ...publicPair({ score: 0.5 }), citation: { ...publicPair().citation, n: 2 } }],
    };
  };
  const readiness = {
    ready: true,
    expected_vectors: 1,
    actual_vectors: 1,
    pending: 0,
    submitted: 0,
    outbox_generation: 0,
    mutation_id: null,
    mutation_submitted_at: null,
    projection_status: "verified",
    bootstrap_epoch: 0,
  };
  await assert.rejects(
    handleSourceOriginalResultFamily(fixture.env, request(), {
      retrieve,
      readBindingReadiness: sourceOriginalResultBindingReadiness,
      readVectorReadiness: async () => readiness,
    }),
    (error) => error instanceof SourceOriginalResultFamilyError &&
      error.code === "source_original_result_family_retrieval_nondeterministic",
  );
  assert.equal(calls, 2);
  assert.equal(fixture.first("SELECT COUNT(*) AS n FROM source_original_result_family_members").n, 0);
  assert.equal(fixture.first("SELECT COUNT(*) AS n FROM source_original_result_family_receipts").n, 0);
  assert.equal(fixture.first("SELECT COUNT(*) AS n FROM source_original_result_family_verifications").n, 0);
});

test("result_family fails closed for a degraded production retrieval", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  await seedBoundFamily(fixture);
  const readiness = {
    ready: true,
    expected_vectors: 1,
    actual_vectors: 1,
    pending: 0,
    submitted: 0,
    outbox_generation: 0,
    mutation_id: null,
    mutation_submitted_at: null,
    projection_status: "verified",
    bootstrap_epoch: 0,
  };
  await assert.rejects(
    handleSourceOriginalResultFamily(fixture.env, request(), {
      retrieve: async () => ({
        degraded: true,
        retrieval_scope: "owner",
        access: { principal: "owner" },
        ignored_filters: [],
        results: [publicPair()],
      }),
      readBindingReadiness: sourceOriginalResultBindingReadiness,
      readVectorReadiness: async () => readiness,
    }),
    (error) => error instanceof SourceOriginalResultFamilyError &&
      error.code === "source_original_result_family_retrieval_unready",
  );
  assert.equal(fixture.first("SELECT COUNT(*) AS n FROM source_original_result_family_receipts").n, 0);
});
