import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  DISPOSABLE_RECOVERY_FIXTURE_SHA256,
  DISPOSABLE_RECOVERY_MARKER,
  DISPOSABLE_RECOVERY_SEED_BATCHES,
  DISPOSABLE_RECOVERY_SEED_BATCH_SIZE,
  DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
  DisposableRecoverySeedError,
  disposableRecoveryFixture,
  disposableRecoverySeedPlan,
  seedDisposableRecoveryFixture,
} from "../operations/disposable-recovery-seeder.mjs";
import { createProductFixture } from "../worker/test/product-contract-fixture.mjs";

const EXPECTED_FIXTURE_SHA256 = "7e8325d3014102e3509fd2f5dcc7ac78aded99dffac18c899e1dd2611cfba6c8";
const FIXED_TIME = "2026-09-12T12:00:00.000Z";

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
    rows: [{
      source_type: fixture[0].source_type,
      documents: 6_001,
      logical_documents: 6_001,
      stored_documents: 6_001,
      document_counts_exact: true,
      chunks: 6_001,
      chunk_counts_exact: true,
      total: 6_001,
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
    now: () => FIXED_TIME,
  });
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.completed_at, FIXED_TIME);
  assert.equal(receipt.ingest.created_documents, 6_001);
  assert.equal(receipt.verification_replay.unchanged_documents, 6_001);
  assert.equal(receipt.d1.documents, 6_001);
  assert.equal(receipt.d1.chunks, 6_001);
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
  assert.equal(receipt.proof_boundary.vectorize_proven, false);
  assert.equal(receipt.proof_boundary.retrieval_proven, false);
  assert.equal(receipt.proof_boundary.recovery_proven, false);
  assert.equal(receipt.verification_replay.exact_identity_and_content_replay, true);
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
  assert.equal(plan.fixture_documents, 6_001);
  assert.equal(plan.fixture_sha256, EXPECTED_FIXTURE_SHA256);

  const refused = spawnSync(process.execPath, [
    "operations/disposable-recovery-seeder.mjs", "--run",
  ], { cwd: new URL("../", import.meta.url), encoding: "utf8" });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /^Usage:/u);
});
