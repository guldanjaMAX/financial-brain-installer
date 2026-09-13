import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DisposableRecoveryFieldSeedError,
  assertDisposableRecoverySeedResumeRecord,
  createDisposableRecoveryLiveTransports,
  runDisposableRecoveryFieldSeed,
} from "../operations/disposable-recovery-field-seed.mjs";
import {
  DISPOSABLE_RECOVERY_FIXTURE_SHA256,
  DISPOSABLE_RECOVERY_SEED_BATCHES,
  DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
  disposableRecoverySeedExecutionApprovalFingerprint,
} from "../operations/disposable-recovery-seeder.mjs";
import {
  PrivateAggregateReceiptError,
  readPrivateAggregateReceipt,
} from "../operations/private-aggregate-receipt.mjs";

const FIXED_TIME = "2026-09-12T12:00:00.000Z";
const RECEIPT_NAME = "v048-disposable-seed-receipt.json";
const RESUME_NAME = "v048-disposable-seed-resume.json";
const SOURCE_VERSION = "10000000-0000-4000-8000-000000000001";
const SOURCE_PHASE_RUN_ID = "20000000-0000-4000-8000-000000000002";
const SOURCE_DEPLOYMENT_ID = "30000000-0000-4000-8000-000000000003";

function bindingFixture() {
  const base = {
    schema_version: 4,
    candidate_sha: "1".repeat(40),
    candidate_tree_sha: "2".repeat(40),
    field_receipt_sha256: "3".repeat(64),
    source_phase_receipt_sha256: "4".repeat(64),
    package_sha256: "4".repeat(64),
    package_file_count: 541,
    execution_inventory_sha256: "5".repeat(64),
    installed_execution_inventory_sha256: "6".repeat(64),
    runner_sha256: "7".repeat(64),
    seeder_sha256: "8".repeat(64),
    content_fingerprint_helper_sha256: "9".repeat(64),
    source_manifest_fingerprint: "a".repeat(64),
    source_resource_fingerprint: "b".repeat(64),
    source_phase_run_id: SOURCE_PHASE_RUN_ID,
    source_a2_approval_fingerprint: "1".repeat(64),
    source_active_version_id: SOURCE_VERSION,
    source_script_etag: "3".repeat(64),
    source_deployment_id: SOURCE_DEPLOYMENT_ID,
    runtime_contract_fingerprint: "c".repeat(64),
    wrangler_wrapper_sha256: "d".repeat(64),
    wrangler_runtime_inventory_sha256: "e".repeat(64),
    wrangler_entrypoint_sha256: "f".repeat(64),
    node_executable_sha256: "0".repeat(64),
  };
  return Object.freeze({
    ...base,
    execution_approval_fingerprint:
      disposableRecoverySeedExecutionApprovalFingerprint(base),
  });
}

function privateDirectory(prefix) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  return directory;
}

function inventory({ complete = false } = {}) {
  if (!complete) {
    return { version: "0.4.8", backend: "d1", vector_drain_mode: "active", rows: [] };
  }
  return {
    version: "0.4.8",
    backend: "d1",
    vector_drain_mode: "active",
    vector_backlog: { pending: 0, upserts: 0, deletes: 0, submitted: 0 },
    vector_readiness: {
      ready: true,
      expected_vectors: 6_001,
      actual_vectors: 6_001,
      pending: 0,
      submitted: 0,
    },
    rows: [{
      source_type: "recovery_field_v048",
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

function batchReceipt(documents, status) {
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

function completeTransports(events) {
  let inventoryReads = 0;
  let ingestCalls = 0;
  return {
    readInventory: async () => {
      events.push(`inventory-${++inventoryReads}`);
      return inventory({ complete: inventoryReads > 1 });
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
      const binding = bindingFixture();
      return {
        source_phase_receipt_sha256: binding.source_phase_receipt_sha256,
        source_phase_run_id: binding.source_phase_run_id,
        source_a2_approval_fingerprint: binding.source_a2_approval_fingerprint,
        source_resource_fingerprint: binding.source_resource_fingerprint,
        source_active_version_id: SOURCE_VERSION,
        source_script_etag: binding.source_script_etag,
        source_deployment_id: binding.source_deployment_id,
        source_active_traffic_percent: 100,
      };
    },
    ingestBatch: async (documents) => {
      const status = ingestCalls < DISPOSABLE_RECOVERY_SEED_BATCHES
        ? "created"
        : "unchanged";
      ingestCalls += 1;
      events.push(`ingest-${ingestCalls}-${status}`);
      return batchReceipt(documents, status);
    },
    settleProjection: async () => events.push("settle"),
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
    readContentFingerprint: async () => {
      events.push("direct-d1");
      return {
        content_fingerprint: "a".repeat(64),
        document_count: 6_001,
        chunk_count: 6_001,
        fts_count: 6_001,
        pending_outbox: 0,
        failed_vectors: 0,
      };
    },
  };
}

const posixTest = process.platform === "win32" ? test.skip : test;

posixTest("live Wrangler reads execute only pinned per-call wrapper and runtime copies", async () => {
  const directory = privateDirectory("brain-v048-seed-runtime-");
  const wrapperPath = join(directory, "wrangler-source");
  const wrapper = Buffer.from("#!/bin/sh\nexit 1\n", "utf8");
  writeFileSync(wrapperPath, wrapper, { mode: 0o700 });
  chmodSync(wrapperPath, 0o700);
  const wrapperSha256 = createHash("sha256").update(wrapper).digest("hex");
  const calls = [];
  try {
    const transports = createDisposableRecoveryLiveTransports({
      source: {
        accountId: "fixture-account",
        workerName: "fixture-worker",
        databaseName: "fixture-d1",
        vectorizeIndex: "fixture-vector",
        domain: "fixture-worker.fixture.workers.dev",
      },
      sourceManifestPath: join(directory, "unused-manifest.json"),
      receiptDirectory: directory,
      wranglerWrapperPath: wrapperPath,
      wranglerWrapperSha256: wrapperSha256,
      wranglerRuntime: Object.freeze({ fixture: true }),
      beforeBoundary: async () => true,
      materializeWranglerRuntime: (_expected, destination) => {
        mkdirSync(destination, { mode: 0o700 });
        const entrypointPath = join(destination, "wrangler.js");
        const resolutionGuardPath = join(destination, "guard.cjs");
        writeFileSync(entrypointPath, "fixture-entrypoint", { mode: 0o600 });
        writeFileSync(resolutionGuardPath, "fixture-guard", { mode: 0o600 });
        return Object.freeze({ root: destination, entrypointPath, resolutionGuardPath });
      },
      assertMaterializedWranglerRuntime: (materialized) => {
        assert.equal(readFileSync(materialized.entrypointPath, "utf8"), "fixture-entrypoint");
        assert.equal(readFileSync(materialized.resolutionGuardPath, "utf8"), "fixture-guard");
        return true;
      },
      runWrangler: ({ command, args, options }) => {
        calls.push({ command, args: [...args], options });
        assert.notEqual(command, wrapperPath);
        assert.equal(command, join(options.cwd, "wrangler-pinned"));
        assert.equal(options.env.BRAIN_RECOVERY_NODE, process.execPath);
        assert.equal(options.env.BRAIN_RECOVERY_WRANGLER_ENTRYPOINT.startsWith(options.cwd), true);
        assert.equal(
          options.env.BRAIN_RECOVERY_WRANGLER_RESOLUTION_GUARD.startsWith(options.cwd),
          true,
        );
        return args[0] === "--version"
          ? { status: 0, stdout: "4.131.1\n", stderr: "" }
          : {
              status: 0,
              stdout: JSON.stringify([{ success: true, results: [{
                document_count: 0,
                chunk_count: 0,
                fts_count: 0,
                pending_outbox: 0,
                failed_vectors: 0,
              }] }]),
              stderr: "",
            };
      },
    });
    assert.deepEqual(await transports.readOpeningDirectD1(), {
      document_count: 0,
      chunk_count: 0,
      fts_count: 0,
      pending_outbox: 0,
      failed_vectors: 0,
    });
    assert.equal(calls.length, 2);
    assert.equal(calls.every((call) => !existsSync(call.options.cwd)), true);
  } finally {
    wrapper.fill(0);
    rmSync(directory, { recursive: true, force: true });
  }
});

posixTest("a per-call wrapper swap is refused after the child returns", async () => {
  const directory = privateDirectory("brain-v048-seed-runtime-swap-");
  const wrapperPath = join(directory, "wrangler-source");
  const wrapper = Buffer.from("#!/bin/sh\nexit 1\n", "utf8");
  writeFileSync(wrapperPath, wrapper, { mode: 0o700 });
  chmodSync(wrapperPath, 0o700);
  try {
    const transports = createDisposableRecoveryLiveTransports({
      source: {
        accountId: "fixture-account",
        workerName: "fixture-worker",
        databaseName: "fixture-d1",
        vectorizeIndex: "fixture-vector",
        domain: "fixture-worker.fixture.workers.dev",
      },
      sourceManifestPath: join(directory, "unused-manifest.json"),
      receiptDirectory: directory,
      wranglerWrapperPath: wrapperPath,
      wranglerWrapperSha256: createHash("sha256").update(wrapper).digest("hex"),
      wranglerRuntime: Object.freeze({ fixture: true }),
      beforeBoundary: async () => true,
      materializeWranglerRuntime: (_expected, destination) => {
        mkdirSync(destination, { mode: 0o700 });
        const entrypointPath = join(destination, "wrangler.js");
        const resolutionGuardPath = join(destination, "guard.cjs");
        writeFileSync(entrypointPath, "fixture-entrypoint", { mode: 0o600 });
        writeFileSync(resolutionGuardPath, "fixture-guard", { mode: 0o600 });
        return Object.freeze({ root: destination, entrypointPath, resolutionGuardPath });
      },
      assertMaterializedWranglerRuntime: () => true,
      runWrangler: ({ command }) => {
        writeFileSync(command, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
        return { status: 0, stdout: "4.131.1\n", stderr: "" };
      },
    });
    await assert.rejects(
      () => transports.readOpeningDirectD1(),
      (error) => error instanceof DisposableRecoveryFieldSeedError &&
        error.code === "DISPOSABLE_RECOVERY_SEED_WRANGLER_WRAPPER_CHANGED",
    );
  } finally {
    wrapper.fill(0);
    rmSync(directory, { recursive: true, force: true });
  }
});

posixTest("the field runner reserves first, seals exactly 6,001, and removes only the pending guard", async () => {
  const directory = privateDirectory("brain-v048-field-seed-success-");
  const receiptPath = join(directory, RECEIPT_NAME);
  const resumePath = join(directory, RESUME_NAME);
  const pendingPath = join(directory, "v048-disposable-seed-receipt.pending.json");
  const events = [];
  try {
    const result = await runDisposableRecoveryFieldSeed({
      binding: bindingFixture(),
      receiptPath,
      expectedReceiptDirectory: directory,
      revalidate: async () => events.push("revalidate"),
      createTransports: async (beforeBoundary) => {
        events.push("create-transports");
        assert.equal(existsSync(receiptPath), true);
        assert.equal(existsSync(pendingPath), true);
        const marker = JSON.parse(readFileSync(receiptPath, "utf8"));
        assert.equal(marker.status, "execution_in_progress");
        assert.equal(marker.fixture_sha256, DISPOSABLE_RECOVERY_FIXTURE_SHA256);
        assert.equal(marker.expected_documents, DISPOSABLE_RECOVERY_SEED_DOCUMENTS);
        assert.equal(marker.expected_batches, 121);
        assert.equal(marker.binding, undefined);
        assert.equal(marker.identity.source_phase_receipt_sha256, bindingFixture().source_phase_receipt_sha256);
        await beforeBoundary();
        return completeTransports(events);
      },
      now: () => FIXED_TIME,
    });
    assert.equal(result.receipt.d1.documents, 6_001);
    assert.equal(result.receipt.d1.chunks, 6_001);
    assert.equal(result.receipt.projection.vectorize_vectors, 6_001);
    assert.equal(result.receipt.completed_at, FIXED_TIME);
    assert.equal(existsSync(receiptPath), true);
    assert.equal(existsSync(pendingPath), false);
    assert.equal(existsSync(resumePath), true);
    assert.equal(events.indexOf("create-transports") > events.indexOf("revalidate"), true);
    assert.equal(events.indexOf("opening-direct-d1") < events.indexOf("inventory-1"), true);
    assert.equal(events.indexOf("opening-direct-d1") < events.indexOf("deployment"), true);
    assert.equal(events.indexOf("deployment") < events.indexOf("inventory-1"), true);
    assert.equal(events.indexOf("inventory-1") < events.indexOf("ingest-1-created"), true);
    assert.equal(events.indexOf("vectorize") < events.indexOf("retrieval"), true);
    assert.equal(events.indexOf("retrieval") < events.indexOf("direct-d1"), true);
    assert.equal(events.filter((event) => event.includes("-created")).length, 121);
    assert.equal(events.filter((event) => event.includes("-unchanged")).length, 121);
    assert.equal(readPrivateAggregateReceipt(receiptPath).sha256, result.receiptSha256);
    const resume = readPrivateAggregateReceipt(resumePath).value;
    assert.equal(assertDisposableRecoverySeedResumeRecord(resume, bindingFixture()).status, "complete");
    assert.equal(resume.verified_completed_batch_prefix, 121);
    assert.equal(resume.verified_completed_document_prefix, 6_001);
    assert.equal(resume.verified_replay_batch_prefix, 121);
    assert.equal(resume.verified_replay_document_prefix, 6_001);
    assert.equal(resume.final_seed_receipt_sha256, result.receiptSha256);
    assert.doesNotMatch(
      JSON.stringify(resume),
      /source_id|doc_uid|title|content|path|credential|admin_key|raw_error|10000000-0000-4000-8000-000000000001|30000000-0000-4000-8000-000000000003/iu,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

posixTest("an ambiguous batch persists an exact private stop record and blocks blind retry", async () => {
  const directory = privateDirectory("brain-v048-field-seed-ambiguous-");
  const receiptPath = join(directory, RECEIPT_NAME);
  const resumePath = join(directory, RESUME_NAME);
  const pendingPath = join(directory, "v048-disposable-seed-receipt.pending.json");
  let providerBoundaryReached = false;
  const privateSentinel = "PRIVATE_AMBIGUOUS_PROVIDER_SENTINEL";
  try {
    await assert.rejects(
      () => runDisposableRecoveryFieldSeed({
        binding: bindingFixture(),
        receiptPath,
        expectedReceiptDirectory: directory,
        createTransports: async () => {
          providerBoundaryReached = true;
          return {
            ...completeTransports([]),
            ingestBatch: async () => { throw new Error(privateSentinel); },
          };
        },
      }),
      (error) => error?.code === "ingest_transport_failed" &&
        error?.may_have_written === true &&
        error?.resume_record?.status === "write_confirmation_ambiguous",
    );
    assert.equal(providerBoundaryReached, true);
    assert.equal(existsSync(receiptPath), true);
    assert.equal(existsSync(pendingPath), true);
    assert.equal(existsSync(resumePath), true);
    const resume = readPrivateAggregateReceipt(resumePath).value;
    assertDisposableRecoverySeedResumeRecord(resume, bindingFixture());
    assert.equal(resume.status, "write_confirmation_ambiguous");
    assert.equal(resume.pending_seed_action, "ingest_fixture_batch");
    assert.equal(resume.verified_completed_batch_prefix, 0);
    assert.equal(resume.verified_completed_document_prefix, 0);
    assert.deepEqual(resume.ambiguous_write_boundary, {
      action: "ingest_fixture_batch",
      batch_number: 1,
      document_prefix_start: 0,
      document_count: 50,
    });
    assert.equal(resume.next_actor, "technician");
    assert.match(resume.safe_next_step, /^do_not_retry_pending_batch/u);
    assert.equal(JSON.stringify(resume).includes(privateSentinel), false);
    assert.throws(
      () => readPrivateAggregateReceipt(receiptPath),
      (error) => error instanceof PrivateAggregateReceiptError &&
        error.code === "PRIVATE_AGGREGATE_RECEIPT_READ_REFUSED",
    );
    let retriedTransports = 0;
    await assert.rejects(
      () => runDisposableRecoveryFieldSeed({
        binding: bindingFixture(),
        receiptPath,
        expectedReceiptDirectory: directory,
        createTransports: async () => {
          retriedTransports += 1;
          return completeTransports([]);
        },
      }),
      (error) => error?.code ===
          "DISPOSABLE_RECOVERY_SEED_AMBIGUOUS_WRITE_REVIEW_REQUIRED" &&
        error?.resume_record?.ambiguous_write_boundary?.batch_number === 1,
    );
    assert.equal(retriedTransports, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

posixTest("a safe interruption resumes after the exact confirmed document prefix", async () => {
  const directory = privateDirectory("brain-v048-field-seed-resume-");
  const receiptPath = join(directory, RECEIPT_NAME);
  const resumePath = join(directory, RESUME_NAME);
  let firstBatchCalls = 0;
  try {
    await assert.rejects(
      () => runDisposableRecoveryFieldSeed({
        binding: bindingFixture(),
        receiptPath,
        expectedReceiptDirectory: directory,
        createTransports: async () => {
          let inventoryReads = 0;
          return {
            ...completeTransports([]),
            readInventory: async () => {
              inventoryReads += 1;
              if (inventoryReads === 1) return inventory();
              throw new Error("PRIVATE_POST_PREFIX_READ_SENTINEL");
            },
            ingestBatch: async (documents) => {
              firstBatchCalls += 1;
              return batchReceipt(documents, "created");
            },
          };
        },
      }),
      (error) => error?.code === "inventory_transport_failed" &&
        error?.resume_record?.status === "execution_in_progress" &&
        error?.resume_record?.verified_completed_document_prefix === 6_001 &&
        error?.resume_record?.ambiguous_write_boundary === null,
    );
    assert.equal(firstBatchCalls, DISPOSABLE_RECOVERY_SEED_BATCHES);
    const interrupted = readPrivateAggregateReceipt(resumePath).value;
    assert.equal(interrupted.pending_seed_action, "verify_seeded_inventory");
    assert.equal(interrupted.verified_completed_batch_prefix, 121);
    assert.equal(interrupted.verified_replay_batch_prefix, 0);

    let resumedBatchCalls = 0;
    const result = await runDisposableRecoveryFieldSeed({
      binding: bindingFixture(),
      receiptPath,
      expectedReceiptDirectory: directory,
      createTransports: async () => ({
        ...completeTransports([]),
        readOpeningDirectD1: async () => ({
          document_count: 6_001,
          chunk_count: 6_001,
          fts_count: 6_001,
          pending_outbox: 6_001,
          failed_vectors: 0,
        }),
        readInventory: async () => inventory({ complete: true }),
        ingestBatch: async (documents) => {
          resumedBatchCalls += 1;
          return batchReceipt(documents, "unchanged");
        },
      }),
      now: () => FIXED_TIME,
    });
    assert.equal(resumedBatchCalls, DISPOSABLE_RECOVERY_SEED_BATCHES);
    assert.equal(result.receipt.ingest.created_documents, 6_001);
    assert.equal(result.receipt.verification_replay.unchanged_documents, 6_001);
    const completed = readPrivateAggregateReceipt(resumePath).value;
    assert.equal(completed.status, "complete");
    assert.equal(completed.final_seed_receipt_sha256, result.receiptSha256);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

posixTest("an invalid binding is refused before receipt reservation or transport creation", async () => {
  const directory = privateDirectory("brain-v048-field-seed-preflight-");
  const receiptPath = join(directory, RECEIPT_NAME);
  let transports = 0;
  try {
    await assert.rejects(
      () => runDisposableRecoveryFieldSeed({
        binding: { ...bindingFixture(), candidate_sha: "not-a-commit" },
        receiptPath,
        expectedReceiptDirectory: directory,
        createTransports: async () => { transports += 1; return completeTransports([]); },
      }),
      (error) => error?.code === "seed_binding_invalid",
    );
    assert.equal(transports, 0);
    assert.equal(existsSync(receiptPath), false);
    assert.equal(existsSync(join(directory, "v048-disposable-seed-receipt.pending.json")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native Windows refuses the runner before receipt or provider work", {
  skip: process.platform !== "win32",
}, async () => {
  await assert.rejects(
    () => runDisposableRecoveryFieldSeed({
      binding: bindingFixture(),
      receiptPath: "C:\\private\\v048-disposable-seed-receipt.json",
      expectedReceiptDirectory: "C:\\private",
      createTransports: async () => assert.fail("must not create transports"),
    }),
    (error) => error instanceof DisposableRecoveryFieldSeedError &&
      error.code === "DISPOSABLE_RECOVERY_SEED_POSIX_REQUIRED",
  );
});
