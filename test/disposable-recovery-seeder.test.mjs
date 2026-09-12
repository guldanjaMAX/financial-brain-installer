import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  assertDisposableRecoverySeedReceipt,
  DISPOSABLE_RECOVERY_FIXTURE_SHA256,
  DISPOSABLE_RECOVERY_MARKER,
  DISPOSABLE_RECOVERY_SEED_BATCHES,
  DISPOSABLE_RECOVERY_SEED_BATCH_SIZE,
  DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
  DisposableRecoverySeedError,
  disposableRecoverySeedExecutionApprovalFingerprint,
  disposableRecoveryFixture,
  disposableRecoverySeedPlan,
  seedDisposableRecoveryFixture as seedDisposableRecoveryFixtureCore,
} from "../operations/disposable-recovery-seeder.mjs";
import { createProductFixture } from "../worker/test/product-contract-fixture.mjs";

const EXPECTED_FIXTURE_SHA256 = "7e8325d3014102e3509fd2f5dcc7ac78aded99dffac18c899e1dd2611cfba6c8";
const FIXED_TIME = "2026-09-12T12:00:00.000Z";
const DIRECT_D1_FINGERPRINT = "a".repeat(64);
const SOURCE_VERSION = "10000000-0000-4000-8000-000000000001";
const PAUSED_VERSION = "20000000-0000-4000-8000-000000000002";
const ACTIVE_VERSION = "30000000-0000-4000-8000-000000000003";
const SEED_BINDING_BASE = Object.freeze({
  schema_version: 3,
  candidate_sha: "1".repeat(40),
  candidate_tree_sha: "2".repeat(40),
  field_receipt_sha256: "3".repeat(64),
  deployment_receipt_sha256: "d".repeat(64),
  package_sha256: "4".repeat(64),
  package_file_count: 541,
  execution_inventory_sha256: "5".repeat(64),
  installed_execution_inventory_sha256: "6".repeat(64),
  runner_sha256: "7".repeat(64),
  seeder_sha256: "8".repeat(64),
  content_fingerprint_helper_sha256: "9".repeat(64),
  source_manifest_fingerprint: "a".repeat(64),
  source_resource_fingerprint: "b".repeat(64),
  target_manifest_fingerprint: "1".repeat(64),
  target_resource_fingerprint: "2".repeat(64),
  source_active_version_id: SOURCE_VERSION,
  source_script_etag: "3".repeat(64),
  target_paused_version_id: PAUSED_VERSION,
  target_paused_script_etag: "target-paused-etag-v048",
  target_active_version_id: ACTIVE_VERSION,
  target_active_script_etag: "target-active-etag-v048",
  runtime_contract_fingerprint: "c".repeat(64),
  wrangler_wrapper_sha256: "d".repeat(64),
  wrangler_runtime_inventory_sha256: "e".repeat(64),
  wrangler_entrypoint_sha256: "f".repeat(64),
  node_executable_sha256: "0".repeat(64),
});
const SEED_BINDING = Object.freeze({
  ...SEED_BINDING_BASE,
  execution_approval_fingerprint:
    disposableRecoverySeedExecutionApprovalFingerprint(SEED_BINDING_BASE),
});

function deploymentProof() {
  return {
    deployment_receipt_sha256: SEED_BINDING.deployment_receipt_sha256,
    source_resource_fingerprint: SEED_BINDING.source_resource_fingerprint,
    source_active_version_id: SOURCE_VERSION,
    source_script_etag: SEED_BINDING.source_script_etag,
    source_active_traffic_percent: 100,
    target_resource_fingerprint: SEED_BINDING.target_resource_fingerprint,
    target_paused_version_id: PAUSED_VERSION,
    target_paused_script_etag: SEED_BINDING.target_paused_script_etag,
    target_active_version_id: ACTIVE_VERSION,
    target_active_script_etag: SEED_BINDING.target_active_script_etag,
    target_paused_traffic_percent: 100,
    target_active_not_promoted: true,
    provider_readback: true,
  };
}

function directD1Proof({ chunks = 6_001 } = {}) {
  return {
    content_fingerprint: DIRECT_D1_FINGERPRINT,
    document_count: 6_001,
    chunk_count: chunks,
    fts_count: chunks,
    pending_outbox: 0,
    failed_vectors: 0,
  };
}

function seedDisposableRecoveryFixture(options) {
  return seedDisposableRecoveryFixtureCore({
    binding: SEED_BINDING,
    readOpeningDirectD1: async () => ({
      document_count: 0,
      chunk_count: 0,
      fts_count: 0,
      pending_outbox: 0,
      failed_vectors: 0,
    }),
    verifyDeployment: async () => deploymentProof(),
    settleProjection: async () => {},
    readContentFingerprint: async () => directD1Proof(),
    readIndependentProjection: async () => ({
      vectorize_vectors: 6_001,
      vector_dimensions: 768,
      vector_metric: "cosine",
      quarantined_vectors: 0,
      independent_control_plane: true,
    }),
    runRetrievalChecks: async () => ({
      supported_case_cited: true,
      unsupported_case_refused: true,
    }),
    ...options,
  });
}

function fakeBatchReceipt(documents, status = "created") {
  return {
    created: status === "created" ? documents.length : 0,
    updated: 0,
    unchanged: status === "unchanged" ? documents.length : 0,
    refused: 0,
    failed: 0,
    total: documents.length,
    results: documents.map((document) => ({
      source_type: document.source_type,
      source_id: document.source_id,
      doc_uid: `${document.source_type}:${document.source_id}`,
      status,
      chunks: status === "created" ? 1 : 0,
    })),
  };
}

function emptyInventory() {
  return { version: "0.4.8", backend: "d1", vector_drain_mode: "active", rows: [] };
}

function completeInventory(fixture = disposableRecoveryFixture()) {
  return {
    version: "0.4.8",
    backend: "d1",
    vector_drain_mode: "active",
    vector_backlog: {
      pending: 0,
      upserts: 0,
      deletes: 0,
      submitted: 0,
      oldest_queued_at: null,
    },
    vector_readiness: {
      ready: true,
      expected_vectors: 6_001,
      actual_vectors: 6_001,
      pending: 0,
      submitted: 0,
    },
    rows: [{
      source_type: fixture[0].source_type,
      documents: 6_001,
      logical_documents: 6_001,
      stored_documents: 6_001,
      document_counts_exact: true,
      chunks: 6_001,
      chunk_counts_exact: true,
      total: 6_001,
      embedded: 6_001,
    }],
  };
}

test("fixture is fixed, fictional, complete-provenance, and safely batched", () => {
  const fixture = disposableRecoveryFixture();
  assert.equal(fixture.length, DISPOSABLE_RECOVERY_SEED_DOCUMENTS);
  assert.equal(DISPOSABLE_RECOVERY_SEED_BATCHES, 121);
  assert.equal(DISPOSABLE_RECOVERY_SEED_BATCH_SIZE, 50);
  assert.equal(DISPOSABLE_RECOVERY_FIXTURE_SHA256, EXPECTED_FIXTURE_SHA256);
  assert.equal(new Set(fixture.map((document) => document.source_id)).size, fixture.length);
  assert.equal(fixture.filter((document) => document.content.includes(DISPOSABLE_RECOVERY_MARKER)).length, 1);
  assert.ok(fixture.every((document) =>
    Object.isFrozen(document) && document.content.length < 256 &&
    document.text_source === "native" && document.text_reliable === true &&
    document.metadata.provenance_receipt.status === "complete"));
  assert.doesNotMatch(JSON.stringify(fixture), /@|https?:|[A-Za-z]:\\|\/Users\/|account number|taxpayer|password|token/iu);
});

test("real Worker and SQLite D1 prove 6,001 actual chunks and an exact unchanged replay", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  const visible = new Map();
  let mutationSequence = 0;
  let processedUpToMutation = null;
  const accept = (apply) => {
    const mutationId = `seed-fixture-mutation-${++mutationSequence}`;
    apply();
    processedUpToMutation = mutationId;
    return { mutationId };
  };
  fixture.env.VECTORIZE = {
    upsert: async (vectors) => accept(() => {
      for (const vector of vectors) visible.set(vector.id, structuredClone(vector));
    }),
    deleteByIds: async (ids) => accept(() => {
      for (const id of ids) visible.delete(id);
    }),
    getByIds: async (ids) => ids.map((id) => visible.get(id)).filter(Boolean),
    describe: async () => ({ vectorCount: visible.size, processedUpToMutation }),
    query: async () => ({ matches: [] }),
  };
  const headers = { "X-Admin-Key": fixture.env.ADMIN_KEY };
  const ingestBatch = async (documents) => {
    const response = await fixture.post("/api/admin/brain/ingest/batch", { docs: documents }, headers);
    assert.equal(response.status, 200);
    return response.json();
  };
  const readInventory = async () => {
    const response = await fixture.worker.fetch(new Request(
      "https://brain.invalid/api/admin/brain/documents",
      { headers },
    ), fixture.env, {});
    assert.equal(response.status, 200);
    return response.json();
  };

  const receipt = await seedDisposableRecoveryFixture({
    ingestBatch,
    readInventory,
    readOpeningDirectD1: async () => ({
      document_count: fixture.sqlite.prepare("SELECT COUNT(*) AS n FROM documents").get().n,
      chunk_count: fixture.sqlite.prepare("SELECT COUNT(*) AS n FROM chunks").get().n,
      fts_count: fixture.sqlite.prepare("SELECT COUNT(*) AS n FROM chunks_fts").get().n,
      pending_outbox: fixture.sqlite.prepare("SELECT COUNT(*) AS n FROM vector_outbox").get().n,
      failed_vectors: fixture.sqlite.prepare(
        "SELECT COUNT(*) AS n FROM vector_outbox WHERE attempts > 0 AND last_error IS NOT NULL",
      ).get().n,
    }),
    settleProjection: async () => {
      for (let round = 0; round < 256; round++) {
        const response = await fixture.post("/api/admin/brain/drain", {}, headers);
        assert.ok([200, 409].includes(response.status));
        const body = await response.json();
        if (response.status === 200 && body.vector_ready === true) return;
      }
      assert.fail("the local vector projection did not settle");
    },
    readContentFingerprint: async () => {
      const documents = fixture.sqlite.prepare(
        "SELECT doc_uid, content_hash FROM documents ORDER BY doc_uid",
      ).all();
      const chunks = fixture.sqlite.prepare(
        "SELECT chunk_uid, doc_uid, text FROM chunks ORDER BY chunk_uid",
      ).all();
      const direct = directD1Proof({ chunks: chunks.length });
      return {
        ...direct,
        content_fingerprint: createHash("sha256")
          .update(JSON.stringify({ documents, chunks }))
          .digest("hex"),
        document_count: documents.length,
        fts_count: fixture.sqlite.prepare("SELECT COUNT(*) AS n FROM chunks_fts").get().n,
        pending_outbox: fixture.sqlite.prepare("SELECT COUNT(*) AS n FROM vector_outbox").get().n,
      };
    },
    readIndependentProjection: async () => ({
      vectorize_vectors: visible.size,
      vector_dimensions: 768,
      vector_metric: "cosine",
      quarantined_vectors: 0,
      independent_control_plane: true,
    }),
    runRetrievalChecks: async () => ({
      supported_case_cited: true,
      unsupported_case_refused: true,
    }),
    now: () => FIXED_TIME,
  });
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.completed_at, FIXED_TIME);
  assert.equal(receipt.ingest.created_documents, 6_001);
  assert.equal(receipt.verification_replay.unchanged_documents, 6_001);
  assert.equal(receipt.d1.documents, 6_001);
  assert.equal(receipt.d1.chunks, 6_001);
  assert.equal(receipt.d1.fts, 6_001);
  assert.match(receipt.d1.content_fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(assertDisposableRecoverySeedReceipt(receipt), true);
  assert.deepEqual({ ...fixture.sqlite.prepare(
    "SELECT COUNT(*) AS documents FROM documents WHERE source = ?",
  ).get(disposableRecoveryFixture()[0].source_type) }, { documents: 6_001 });
  assert.deepEqual({ ...fixture.sqlite.prepare(
    "SELECT COUNT(*) AS chunks FROM chunks WHERE source = ?",
  ).get(disposableRecoveryFixture()[0].source_type) }, { chunks: 6_001 });

  let unexpectedWrite = false;
  await assert.rejects(seedDisposableRecoveryFixture({
    ingestBatch: async () => { unexpectedWrite = true; return null; },
    readInventory,
    now: () => FIXED_TIME,
  }), (error) => error.code === "inventory_not_disposable");
  assert.equal(unexpectedWrite, false);
});

test("public plan and receipt contain only aggregate fixture evidence", async () => {
  let inventories = 0;
  let batches = 0;
  const receipt = await seedDisposableRecoveryFixture({
    ingestBatch: async (documents) => fakeBatchReceipt(
      documents,
      batches++ < DISPOSABLE_RECOVERY_SEED_BATCHES ? "created" : "unchanged",
    ),
    readInventory: async () => (++inventories === 1 ? emptyInventory() : completeInventory()),
    now: () => FIXED_TIME,
  });
  const publicJson = JSON.stringify({ plan: disposableRecoverySeedPlan(), receipt });
  const privateDocument = disposableRecoveryFixture()[0];
  assert.doesNotMatch(publicJson, new RegExp(privateDocument.source_type, "u"));
  assert.doesNotMatch(publicJson, new RegExp(privateDocument.source_id, "u"));
  assert.doesNotMatch(publicJson, new RegExp(DISPOSABLE_RECOVERY_MARKER, "u"));
  assert.doesNotMatch(publicJson, /"(?:title|content|doc_uid|query|url|path|credential|token|admin_key)"\s*:/iu);
  assert.equal(receipt.proof_boundary.vectorize_proven, true);
  assert.equal(receipt.proof_boundary.retrieval_proven, true);
  assert.equal(receipt.proof_boundary.recovery_proven, false);
  assert.equal(receipt.verification_replay.exact_identity_and_content_replay, true);
});

test("projection settling and direct D1 proof occur only after the exact replay", async () => {
  let inventories = 0;
  let batches = 0;
  const events = [];
  const receipt = await seedDisposableRecoveryFixtureCore({
    binding: SEED_BINDING,
    ingestBatch: async (documents) => {
      batches++;
      events.push(`batch:${batches}`);
      return fakeBatchReceipt(
        documents,
        batches <= DISPOSABLE_RECOVERY_SEED_BATCHES ? "created" : "unchanged",
      );
    },
    readInventory: async () => {
      inventories++;
      events.push(`inventory:${inventories}`);
      return inventories === 1 ? emptyInventory() : completeInventory();
    },
    readOpeningDirectD1: async () => {
      events.push("opening-direct-d1");
      return {
        document_count: 0,
        chunk_count: 0,
        fts_count: 0,
        pending_outbox: 0,
        failed_vectors: 0,
      };
    },
    verifyDeployment: async () => {
      events.push("deployment");
      return deploymentProof();
    },
    settleProjection: async () => events.push("settle"),
    readContentFingerprint: async () => {
      events.push("direct-d1");
      return directD1Proof();
    },
    readIndependentProjection: async () => {
      events.push("vectorize");
      return {
        vectorize_vectors: 6_001,
        vector_dimensions: 768,
        vector_metric: "cosine",
        quarantined_vectors: 0,
        independent_control_plane: true,
      };
    },
    runRetrievalChecks: async () => {
      events.push("retrieval");
      return { supported_case_cited: true, unsupported_case_refused: true };
    },
    now: () => FIXED_TIME,
  });
  assert.equal(batches, 242);
  assert.equal(events.indexOf("opening-direct-d1") < events.indexOf("inventory:1"), true);
  assert.equal(events.indexOf("opening-direct-d1") < events.indexOf("deployment"), true);
  assert.equal(events.indexOf("deployment") < events.indexOf("inventory:1"), true);
  assert.equal(events.indexOf("inventory:1") < events.indexOf("batch:1"), true);
  assert.deepEqual(events.slice(-6), [
    "settle", "inventory:3", "vectorize", "retrieval", "direct-d1", "inventory:4",
  ]);
  assert.equal(receipt.d1.content_fingerprint, DIRECT_D1_FINGERPRINT);
});

test("a stale 3,201 contract or substituted direct D1 proof is refused", async () => {
  let inventories = 0;
  let batches = 0;
  const receipt = await seedDisposableRecoveryFixture({
    ingestBatch: async (documents) => fakeBatchReceipt(
      documents,
      batches++ < DISPOSABLE_RECOVERY_SEED_BATCHES ? "created" : "unchanged",
    ),
    readInventory: async () => (++inventories === 1 ? emptyInventory() : completeInventory()),
    readOpeningDirectD1: async () => ({
      document_count: 0,
      chunk_count: 0,
      fts_count: 0,
      pending_outbox: 0,
      failed_vectors: 0,
    }),
    verifyDeployment: async () => deploymentProof(),
    now: () => FIXED_TIME,
  });
  const stale = structuredClone(receipt);
  stale.fixture.documents = 3_201;
  assert.throws(
    () => assertDisposableRecoverySeedReceipt(stale),
    (error) => error.code === "seed_receipt_invalid",
  );

  inventories = 0;
  batches = 0;
  await assert.rejects(seedDisposableRecoveryFixtureCore({
    binding: SEED_BINDING,
    ingestBatch: async (documents) => fakeBatchReceipt(
      documents,
      batches++ < DISPOSABLE_RECOVERY_SEED_BATCHES ? "created" : "unchanged",
    ),
    readInventory: async () => (++inventories === 1 ? emptyInventory() : completeInventory()),
    readOpeningDirectD1: async () => ({
      document_count: 0,
      chunk_count: 0,
      fts_count: 0,
      pending_outbox: 0,
      failed_vectors: 0,
    }),
    verifyDeployment: async () => deploymentProof(),
    settleProjection: async () => {},
    readContentFingerprint: async () => directD1Proof({ chunks: 3_201 }),
    readIndependentProjection: async () => ({
      vectorize_vectors: 6_001,
      vector_dimensions: 768,
      vector_metric: "cosine",
      quarantined_vectors: 0,
      independent_control_plane: true,
    }),
    runRetrievalChecks: async () => ({
      supported_case_cited: true,
      unsupported_case_refused: true,
    }),
  }), (error) => error.code === "direct_d1_fingerprint_invalid");
});

test("malformed receipts, weak inventory, and transport failures fail closed without leaks", async () => {
  let reads = 0;
  await assert.rejects(seedDisposableRecoveryFixture({
    ingestBatch: async (documents) => ({ ...fakeBatchReceipt(documents), updated: 1, created: documents.length - 1 }),
    readInventory: async () => (++reads === 1 ? emptyInventory() : completeInventory()),
  }), (error) => error instanceof DisposableRecoverySeedError && error.code === "ingest_receipt_rejected");

  await assert.rejects(seedDisposableRecoveryFixture({
    ingestBatch: async () => { throw new Error("PRIVATE_TRANSPORT_SENTINEL"); },
    readInventory: async () => emptyInventory(),
  }), (error) => error.code === "ingest_transport_failed" &&
    error.may_have_written === true && error.safe_to_retry === false &&
    error.confirmed_documents === 0 && error.ambiguous_documents === 50 &&
    !error.message.includes("PRIVATE_TRANSPORT_SENTINEL"));

  reads = 0;
  let batches = 0;
  await assert.rejects(seedDisposableRecoveryFixture({
    ingestBatch: async (documents) => fakeBatchReceipt(
      documents,
      batches++ < DISPOSABLE_RECOVERY_SEED_BATCHES ? "created" : "unchanged",
    ),
    readInventory: async () => {
      if (++reads === 1) return emptyInventory();
      const body = completeInventory();
      body.rows[0].chunks = 3_200;
      body.rows[0].total = 3_200;
      return body;
    },
  }), (error) => error.code === "d1_count_proof_failed");
});

test("a nonempty destination is rejected before any write", async () => {
  let writes = 0;
  await assert.rejects(seedDisposableRecoveryFixture({
    ingestBatch: async () => { writes++; },
    readInventory: async () => completeInventory(),
  }), (error) => error.code === "inventory_not_disposable" &&
    error.may_have_written === false && error.safe_to_retry === false);
  assert.equal(writes, 0);

  await assert.rejects(seedDisposableRecoveryFixture({
    ingestBatch: async () => { writes++; },
    readInventory: async () => emptyInventory(),
    readOpeningDirectD1: async () => ({
      document_count: 1,
      chunk_count: 1,
      fts_count: 1,
      pending_outbox: 0,
      failed_vectors: 0,
    }),
  }), (error) => error.code === "opening_direct_d1_not_empty" &&
    error.may_have_written === false && error.safe_to_retry === false);
  assert.equal(writes, 0);
});

test("result counters and clock failures cannot create a false or leaky receipt", async () => {
  await assert.rejects(seedDisposableRecoveryFixture({
    ingestBatch: async (documents) => {
      const body = fakeBatchReceipt(documents, "unchanged");
      body.created = documents.length;
      body.unchanged = 0;
      return body;
    },
    readInventory: async () => emptyInventory(),
  }), (error) => error.code === "ingest_result_unbound");

  let reads = 0;
  let batches = 0;
  await assert.rejects(seedDisposableRecoveryFixture({
    ingestBatch: async (documents) => fakeBatchReceipt(
      documents,
      batches++ < DISPOSABLE_RECOVERY_SEED_BATCHES ? "created" : "unchanged",
    ),
    readInventory: async () => (++reads === 1 ? emptyInventory() : completeInventory()),
    now: () => { throw new Error("PRIVATE_CLOCK_SENTINEL"); },
  }), (error) => error.code === "clock_invalid" && error.may_have_written === true &&
    error.safe_to_retry === false && error.confirmed_documents === 6_001 &&
    !error.message.includes("PRIVATE_CLOCK_SENTINEL"));
});

test("CLI exposes a no-write aggregate plan and refuses execution-shaped arguments", () => {
  const planned = spawnSync(process.execPath, [
    "operations/disposable-recovery-seeder.mjs", "--plan",
  ], { cwd: new URL("../", import.meta.url), encoding: "utf8" });
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout);
  assert.equal(plan.writes, false);
  assert.equal(plan.schema_version, 2);
  assert.equal(plan.fixture_documents, 6_001);
  assert.equal(plan.fixture_sha256, EXPECTED_FIXTURE_SHA256);

  const refused = spawnSync(process.execPath, [
    "operations/disposable-recovery-seeder.mjs", "--run",
  ], { cwd: new URL("../", import.meta.url), encoding: "utf8" });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /^Usage:/u);
});
