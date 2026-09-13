import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  VERIFIED_RECOVERY_STAGES,
  assertVerifiedRecoveryManifestBindings,
  bindVerifiedRecoveryFieldProof,
  buildVerifiedRecoveryPlan,
  initializeVerifiedRecovery,
  inspectVerifiedRecoveryManifestBindings,
  inspectVerifiedRecoverySourceManifestBinding,
  loadVerifiedRecoveryPlan,
  loadVerifiedRecoveryState,
  parseVerifiedRecoveryCliArguments,
  runVerifiedRecovery,
  validateVerifiedRecoveryPlan,
  validateVerifiedRecoveryState,
  validateBankRecoveryProof,
  verifiedRecoveryStatus,
  writeVerifiedRecoveryPlan,
  writeVerifiedRecoveryState,
} from "../operations/verified-recovery.mjs";
import {
  BACKUP_RPO_HOURS,
  BACKUP_RTO_HOURS,
  RETENTION_CLASSES,
  buildRestoreEvidence,
  decryptOffProviderBackup,
  encryptOffProviderBackup,
  restoreEvidenceStatus,
} from "../operations/off-provider-backup.mjs";

const sandbox = mkdtempSync(join(tmpdir(), "brain-verified-recovery-"));
const sourcePath = join(sandbox, "source.manifest.json");
const targetPath = join(sandbox, "target.manifest.json");
const planPath = join(sandbox, ".brain-recovery-plan.json");
const statePath = join(sandbox, ".brain-recovery-state.json");
const sentinel = "fixture-private-value-must-never-escape";

const sourceManifest = {
  manifest_version: 1,
  client: { slug: "fixture-brain", display_name: "Synthetic Fixture" },
  brain: {
    version: "0.1.12",
    worker_name: "fixture-source-worker",
    domain: "source.fixture.invalid",
  },
  infrastructure: {
    cloudflare: {
      storage: "d1",
      account_id: "fixture-account-a",
      d1_database_name: "fixture-source-d1",
      d1_database_id: "fixture-source-database-id",
      vectorize_index: "fixture-source-vector",
    },
  },
  retrieval: {
    embed_model: "@cf/baai/bge-base-en-v1.5",
    embed_dimensions: 768,
    chunk_size: 1500,
    chunk_overlap: 300,
    answer_model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  },
  safety: {
    daily_llm_spend_cap_usd: 10,
    credential_scanner: { enabled: true },
    ocr: {
      enabled: false,
      model: "@cf/google/gemma-4-26b-a4b-it",
    },
  },
  _private_fixture: sentinel,
};

const targetManifest = {
  ...structuredClone(sourceManifest),
  brain: {
    ...sourceManifest.brain,
    worker_name: "fixture-recovery-worker",
    domain: "recovery.fixture.invalid",
  },
  infrastructure: {
    cloudflare: {
      ...sourceManifest.infrastructure.cloudflare,
      d1_database_name: "fixture-recovery-d1",
      d1_database_id: "fixture-recovery-database-id",
      vectorize_index: "fixture-recovery-vector",
    },
  },
};

function writeJson(path, value, mode = 0o600) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode });
  if (process.platform !== "win32") chmodSync(path, mode);
}

let variantNumber = 0;
function manifestVariant(base, mutate) {
  const value = structuredClone(base);
  mutate(value);
  const path = join(sandbox, `variant-${++variantNumber}.manifest.json`);
  writeJson(path, value);
  return path;
}

function clock(start = Date.parse("2026-08-25T12:00:00.000Z")) {
  let value = start;
  return () => {
    const result = new Date(value);
    value += 1000;
    return result;
  };
}

const artifactHash = "a".repeat(64);
const schemaHash = "b".repeat(64);
const aggregateHash = "c".repeat(64);
const contentHash = "d".repeat(64);
const fieldContentHash = "1".repeat(64);
const fieldFixtureHash = "7e8325d3014102e3509fd2f5dcc7ac78aded99dffac18c899e1dd2611cfba6c8";
const fieldExpectedDocuments = 6_001;
const fieldExpectedChunks = 6_113;
const fieldProofInput = Object.freeze({
  schema_version: 1,
  kind: "v048_disposable_recovery_seed_bridge",
  candidate_sha: "1".repeat(40),
  package_sha256: "2".repeat(64),
  field_receipt_sha256: "3".repeat(64),
  source_phase_receipt_sha256: "9".repeat(64),
  deployment_receipt_sha256: "8".repeat(64),
  seed_receipt_sha256: "4".repeat(64),
  fixture_sha256: fieldFixtureHash,
  seed_d1_content_fingerprint: fieldContentHash,
  expected_documents: fieldExpectedDocuments,
  expected_chunks: fieldExpectedChunks,
  expected_fts: fieldExpectedChunks,
  seed_replay_unchanged_documents: fieldExpectedDocuments,
  paired_stop_stage: "rebuild_vectorize",
});
const fieldRebuildProof = Object.freeze({
  source_phase_receipt_sha256: fieldProofInput.source_phase_receipt_sha256,
  deployment_receipt_sha256: fieldProofInput.deployment_receipt_sha256,
  seed_receipt_sha256: fieldProofInput.seed_receipt_sha256,
  bootstrap_interruption_checkpoint_sha256: "5".repeat(64),
  bootstrap_resume_authorization_sha256: "6".repeat(64),
  bootstrap_promotion_authorization_sha256: "7".repeat(64),
});
const bankSecurityProof = { protocol: "bank-security-v1", reconciliation_at: "2026-08-25T12:00:00.000Z", rows: [] };
const bankSecurityHash = createHash("sha256").update(JSON.stringify(bankSecurityProof)).digest("hex");
assert.equal(validateBankRecoveryProof(bankSecurityProof), bankSecurityProof);
for (const mutate of [
  (proof) => { proof.protocol = "unknown"; },
  (proof) => { proof.reconciliation_at = "2026-08-25"; },
  (proof) => { proof.row_ids = []; },
  (proof) => { proof.rows = [["a".repeat(64)]]; },
  (proof) => { proof.rows = [["a".repeat(64), "not a fingerprint"]]; },
  (proof) => { proof.rows = [["a".repeat(64), "b".repeat(64)], ["b".repeat(64), "c".repeat(64)]]; },
  (proof) => { proof.rows = Array.from({ length: 1001 }, () => ["a".repeat(64), "b".repeat(64)]); },
]) {
  const bad = structuredClone(bankSecurityProof);
  mutate(bad);
  assert.throws(() => validateBankRecoveryProof(bad));
}

function evidenceFor(stage, context, override = {}) {
  const values = {
    export_d1: {
      artifact_sha256: artifactHash,
      artifact_bytes: 4096,
    },
    verify_export: {
      artifact_sha256: artifactHash,
      artifact_bytes: 4096,
      integrity: "ok",
      schema_fingerprint: schemaHash,
      aggregate_fingerprint: aggregateHash,
      content_fingerprint: contentHash,
      document_count: 3,
      chunk_count: 5,
      fts_count: 5,
    },
    prove_target_clean: {
      target_resource_fingerprint: context.targetResourceFingerprint,
      user_table_count: 0,
      vector_count: 0,
      vector_dimensions: 768,
      vector_metric: "cosine",
    },
    restore_d1: {
      artifact_sha256: artifactHash,
      import_completed: true,
    },
    verify_d1: {
      integrity: "ok",
      schema_fingerprint: schemaHash,
      aggregate_fingerprint: aggregateHash,
      content_fingerprint: contentHash,
      non_bank_content_fingerprint: contentHash,
      bank_security_fingerprint: bankSecurityHash,
      bank_security_proof: bankSecurityProof,
      document_count: 3,
      chunk_count: 5,
      fts_count: 5,
    },
    reconcile_security: {
      integrity: "ok",
      schema_fingerprint: schemaHash,
      aggregate_fingerprint: aggregateHash,
      content_fingerprint: contentHash,
      document_count: 3,
      chunk_count: 5,
      fts_count: 5,
      bank_protected: 0,
      bank_reauthorization_required: 0,
      bank_legacy_rewrap_required: 0,
      bank_unsupported_key_versions: 0,
    },
    rebuild_vectorize: {
      chunk_count: 5,
      vector_count: 5,
      pending_outbox: 0,
      failed_vectors: 0,
    },
    verify_health: {
      status: "pass",
      failure_count: 0,
      vector_backlog: 0,
    },
    verify_eval: {
      profile: "release",
      status: "pass",
      critical_failures: 0,
      unauthorized_retrievals: 0,
    },
  };
  return { ...values[stage], ...override };
}

function goodAdapters(calls = [], overrides = {}) {
  return Object.fromEntries(VERIFIED_RECOVERY_STAGES.map(({ id }) => [
    id,
    async (context) => {
      calls.push(id);
      if (overrides[id] instanceof Error) throw overrides[id];
      return evidenceFor(id, context, overrides[id] || {});
    },
  ]));
}

try {
  writeJson(sourcePath, sourceManifest);
  writeJson(targetPath, targetManifest);

  const createdAt = new Date("2026-08-25T11:00:00.000Z");
  const plan = buildVerifiedRecoveryPlan(sourcePath, targetPath, { now: createdAt });
  assert.equal(plan.created_at, createdAt.toISOString());
  assert.match(plan.plan_fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(plan.stages, VERIFIED_RECOVERY_STAGES);
  assert.equal(plan.artifact.format, "financial_brain_recovery_ciphertext_v1");
  assert.equal(plan.artifact.relative_name, ".brain-recovery-export.sql.fbrenc");
  assert.equal(plan.artifact.owner_only, true);
  assert.equal(plan.isolation.required_initial_user_tables, 0);
  assert.equal(plan.isolation.required_initial_vectors, 0);
  assert.equal(plan.gates.vectorize_rebuilt_from, "d1");
  assert.equal(plan.gates.eval_profile, "release");
  assert.equal(
    assertVerifiedRecoveryManifestBindings(plan, sourcePath, targetPath),
    true,
  );
  const exactManifestBindings = inspectVerifiedRecoveryManifestBindings(
    plan,
    sourcePath,
    targetPath,
  );
  const exactSourceManifestBinding = inspectVerifiedRecoverySourceManifestBinding(
    plan,
    sourcePath,
  );
  assert.equal(exactSourceManifestBinding.planFingerprint, plan.plan_fingerprint);
  assert.equal(
    exactSourceManifestBinding.sourceManifestFingerprint,
    plan.source_manifest_fingerprint,
  );
  assert.deepEqual(exactSourceManifestBinding.source, exactManifestBindings.source);
  for (const binding of [exactManifestBindings.source, exactManifestBindings.target]) {
    assert.equal(binding.clientSlug, "fixture-brain");
    assert.equal(binding.productVersion, "0.1.12");
    assert.equal(binding.embeddingModel, "@cf/baai/bge-base-en-v1.5");
    assert.equal(binding.embeddingDimensions, 768);
    assert.equal(binding.chunkSize, "1500");
    assert.equal(binding.chunkOverlap, "300");
    assert.equal(binding.dailyLlmCapUsd, "10");
    assert.equal(binding.answerModel, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    assert.equal(binding.credentialScanner, "on");
    assert.equal(binding.ocrEnabled, "0");
    assert.equal(binding.ocrModel, "@cf/google/gemma-4-26b-a4b-it");
  }

  const planText = JSON.stringify(plan);
  for (const forbidden of [
    sentinel,
    sourceManifest.infrastructure.cloudflare.account_id,
    sourceManifest.infrastructure.cloudflare.d1_database_id,
    sourceManifest.infrastructure.cloudflare.vectorize_index,
    sourceManifest.brain.domain,
    targetManifest.infrastructure.cloudflare.d1_database_id,
    targetManifest.brain.domain,
    sourcePath,
    targetPath,
  ]) assert.equal(planText.includes(forbidden), false, `plan omitted ${forbidden}`);

  const rebuilt = buildVerifiedRecoveryPlan(sourcePath, targetPath, { now: createdAt });
  assert.equal(rebuilt.plan_fingerprint, plan.plan_fingerprint);
  assert.throws(
    () => validateVerifiedRecoveryPlan({ ...plan, created_at: "2026-08-25T11:00:01.000Z" }),
    /fingerprint is invalid/,
  );

  const bindingTarget = manifestVariant(targetManifest, (value) => {
    value.infrastructure.cloudflare.d1_database_name = "fixture-binding-d1";
    value.infrastructure.cloudflare.d1_database_id = "fixture-binding-database-id";
    value.infrastructure.cloudflare.vectorize_index = "fixture-binding-vector";
    value.brain.worker_name = "fixture-binding-worker";
    value.brain.domain = "binding.fixture.invalid";
  });
  const bindingPlan = buildVerifiedRecoveryPlan(sourcePath, bindingTarget, { now: createdAt });
  writeJson(bindingTarget, {
    ...JSON.parse(readFileSync(bindingTarget, "utf8")),
    _post_review_change: true,
  });
  assert.throws(
    () => assertVerifiedRecoveryManifestBindings(bindingPlan, sourcePath, bindingTarget),
    /binding changed after plan review/,
  );

  const sameDatabase = manifestVariant(targetManifest, (value) => {
    value.infrastructure.cloudflare.d1_database_name = sourceManifest.infrastructure.cloudflare.d1_database_name;
    value.infrastructure.cloudflare.d1_database_id = sourceManifest.infrastructure.cloudflare.d1_database_id;
  });
  assert.throws(() => buildVerifiedRecoveryPlan(sourcePath, sameDatabase), /D1 database must be distinct/);

  const sameVector = manifestVariant(targetManifest, (value) => {
    value.infrastructure.cloudflare.vectorize_index = sourceManifest.infrastructure.cloudflare.vectorize_index;
  });
  assert.throws(() => buildVerifiedRecoveryPlan(sourcePath, sameVector), /Vectorize index must be distinct/);

  const sameWorker = manifestVariant(targetManifest, (value) => {
    value.brain.worker_name = sourceManifest.brain.worker_name;
  });
  assert.throws(() => buildVerifiedRecoveryPlan(sourcePath, sameWorker), /Worker must be distinct/);

  const sameDomain = manifestVariant(targetManifest, (value) => {
    value.brain.domain = sourceManifest.brain.domain;
  });
  assert.throws(() => buildVerifiedRecoveryPlan(sourcePath, sameDomain), /domain must be distinct/);

  const differentRuntime = manifestVariant(targetManifest, (value) => {
    value.brain.version = "0.1.13";
  });
  assert.throws(() => buildVerifiedRecoveryPlan(sourcePath, differentRuntime), /exact runtime contract/);

  for (const mutate of [
    (value) => { value.retrieval.chunk_size = 1499; },
    (value) => { value.retrieval.chunk_overlap = 299; },
    (value) => { value.safety.daily_llm_spend_cap_usd = 9.5; },
    (value) => { value.retrieval.answer_model = "@cf/meta/fixture-answer-model"; },
    (value) => { value.safety.credential_scanner.enabled = false; },
    (value) => { value.safety.ocr.enabled = true; },
    (value) => { value.safety.ocr.model = "@cf/google/fixture-ocr-model"; },
  ]) {
    const mismatchedRuntime = manifestVariant(targetManifest, mutate);
    assert.throws(
      () => buildVerifiedRecoveryPlan(sourcePath, mismatchedRuntime),
      /exact runtime contract/,
    );
  }

  const wrongBackend = manifestVariant(targetManifest, (value) => {
    value.infrastructure.cloudflare.storage = "supabase";
  });
  assert.throws(() => buildVerifiedRecoveryPlan(sourcePath, wrongBackend), /must use Cloudflare D1/);

  const initialized = initializeVerifiedRecovery(
    sourcePath,
    targetPath,
    planPath,
    statePath,
    { now: createdAt },
  );
  if (process.platform !== "win32") {
    assert.equal(statSync(planPath).mode & 0o777, 0o600);
    assert.equal(statSync(statePath).mode & 0o777, 0o600);
  }
  assert.deepEqual(loadVerifiedRecoveryPlan(planPath), initialized.plan);
  assert.deepEqual(loadVerifiedRecoveryState(statePath, initialized.plan), initialized.state);
  assert.deepEqual(
    parseVerifiedRecoveryCliArguments(["status", planPath, statePath]),
    { command: "status", planPath, statePath },
  );
  assert.throws(
    () => parseVerifiedRecoveryCliArguments(["status", planPath, statePath, "--extra"]),
    /arguments are invalid/,
  );

  const initialState = initialized.state;
  let unvalidatedAdapterCalls = 0;
  const unvalidatedAdapters = goodAdapters([]);
  unvalidatedAdapters.export_d1 = async () => {
    unvalidatedAdapterCalls++;
    return evidenceFor("export_d1", { targetResourceFingerprint: plan.target_resource_fingerprint });
  };
  await assert.rejects(
    runVerifiedRecovery(initialized.plan, initialState, unvalidatedAdapters),
    /needs manifest revalidation/,
  );
  assert.equal(unvalidatedAdapterCalls, 0);

  const checkpointCalls = [];
  const checkpointHooks = [];
  let checkpointedState = initialState;
  const stopAfterRestore = async (stage) => {
    checkpointHooks.push(stage);
    if (stage === "restore_d1") {
      assert.equal(checkpointedState.completed.at(-1)?.id, "restore_d1");
      assert.equal(checkpointedState.current_stage, "verify_d1");
      assert.equal(checkpointedState.stage_status, "pending");
      throw new Error("intentional fixture checkpoint");
    }
  };
  await assert.rejects(
    runVerifiedRecovery(
      initialized.plan,
      initialState,
      goodAdapters(checkpointCalls),
      {
        clock: clock(Date.parse("2026-08-25T11:30:00.000Z")),
        revalidateManifests: async () => true,
        persistState: async (state) => { checkpointedState = state; },
        afterStageCheckpoint: stopAfterRestore,
      },
    ),
    /intentional fixture checkpoint/,
  );
  assert.deepEqual(checkpointCalls, [
    "export_d1", "verify_export", "prove_target_clean", "restore_d1",
  ]);
  assert.deepEqual(checkpointHooks, checkpointCalls);
  assert.equal(checkpointedState.status, "running");
  assert.equal(checkpointedState.current_stage, "verify_d1");
  assert.equal(checkpointedState.stage_status, "pending");
  assert.equal(checkpointedState.failure, null);
  assert.deepEqual(
    checkpointedState.completed.map((entry) => entry.id),
    checkpointCalls,
  );

  const checkpointResumeCalls = [];
  const checkpointResumed = await runVerifiedRecovery(
    initialized.plan,
    checkpointedState,
    goodAdapters(checkpointResumeCalls),
    {
      clock: clock(Date.parse("2026-08-25T11:45:00.000Z")),
      revalidateManifests: async () => true,
      persistState: async (state) => { checkpointedState = state; },
      // Keeping the identical hook proves an already-checkpointed stage cannot
      // trigger again or repeat its external effect.
      afterStageCheckpoint: stopAfterRestore,
    },
  );
  assert.equal(checkpointResumed.ok, true);
  assert.deepEqual(checkpointResumeCalls, [
    "verify_d1", "reconcile_security", "rebuild_vectorize", "verify_health", "verify_eval",
  ]);
  assert.equal(checkpointedState.status, "complete");

  await assert.rejects(
    runVerifiedRecovery(
      initialized.plan,
      initialState,
      goodAdapters([]),
      { revalidateManifests: async () => true, afterStageCheckpoint: "restore_d1" },
    ),
    /after-stage checkpoint hook must be a function/,
  );
  await assert.rejects(
    runVerifiedRecovery(
      initialized.plan,
      initialState,
      goodAdapters([]),
      { revalidateManifests: async () => true, afterStageCheckpoint: async () => {} },
    ),
    /after-stage checkpoint hook requires durable state persistence/,
  );

  const calls = [];
  let lastPersisted = initialState;
  const completed = await runVerifiedRecovery(
    initialized.plan,
    initialState,
    goodAdapters(calls),
    {
      clock: clock(),
      revalidateManifests: async () =>
        assertVerifiedRecoveryManifestBindings(initialized.plan, sourcePath, targetPath),
      persistState: async (state) => {
        lastPersisted = state;
        writeVerifiedRecoveryState(statePath, state, initialized.plan);
      },
    },
  );
  assert.equal(completed.ok, true);
  assert.equal(completed.state.status, "complete");
  assert.equal(completed.state.completed.length, VERIFIED_RECOVERY_STAGES.length);
  assert.deepEqual(calls, VERIFIED_RECOVERY_STAGES.map(({ id }) => id));
  assert.equal(lastPersisted.status, "complete");
  assert.equal(loadVerifiedRecoveryState(statePath, initialized.plan).status, "complete");
  for (const mutate of [
    (evidence) => { delete evidence.bank_security_proof; },
    (evidence) => { evidence.bank_security_fingerprint = "a".repeat(64); },
    (evidence) => { evidence.bank_security_proof.reconciliation_at = "2026-08-26T12:00:00.000Z"; },
    (evidence) => { evidence.non_bank_content_fingerprint = "invalid"; },
    (evidence) => { evidence.content_fingerprint = "e".repeat(64); },
  ]) {
    const invalid = structuredClone(completed.state);
    mutate(invalid.completed.find((entry) => entry.id === "verify_d1").evidence);
    assert.throws(() => validateVerifiedRecoveryState(invalid, initialized.plan));
  }
  assert.equal(readdirSync(sandbox).some((name) => name.includes(".tmp")), false);

  let completedCalls = 0;
  const idempotent = await runVerifiedRecovery(initialized.plan, completed.state, new Proxy({}, {
    get() { completedCalls++; return async () => ({}); },
  }));
  assert.equal(idempotent.ok, true);
  assert.equal(completedCalls, 0);

  const failedCalls = [];
  const rawError = new Error(`provider failed with ${sentinel}`);
  const failed = await runVerifiedRecovery(
    initialized.plan,
    initialState,
    goodAdapters(failedCalls, { restore_d1: rawError }),
    {
      clock: clock(Date.parse("2026-08-25T13:00:00.000Z")),
      revalidateManifests: async () => true,
    },
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.errorCode, "RECOVERY_RESTORE_D1_FAILED");
  assert.equal(failed.state.status, "failed");
  assert.equal(failed.state.current_stage, "restore_d1");
  assert.deepEqual(failedCalls, ["export_d1", "verify_export", "prove_target_clean", "restore_d1"]);
  assert.equal(JSON.stringify(failed).includes(sentinel), false);

  const resumedCalls = [];
  const resumed = await runVerifiedRecovery(
    initialized.plan,
    failed.state,
    goodAdapters(resumedCalls),
    {
      clock: clock(Date.parse("2026-08-25T14:00:00.000Z")),
      revalidateManifests: async () => true,
    },
  );
  assert.equal(resumed.ok, true);
  assert.deepEqual(resumedCalls, [
    "restore_d1", "verify_d1", "reconcile_security", "rebuild_vectorize", "verify_health", "verify_eval",
  ]);

  // ROOT 4 REGRESSION. An adapter failure carrying an operator-facing detail
  // sentence (the shape CloudflareRecoveryAdapterError produces since the
  // detail was added) used to make markStageFailed's failure record REJECT
  // its own exact-key validation, so runVerifiedRecovery threw instead of
  // returning, the operator saw only a generic preflight code with neither
  // the real cause nor the detail, and nothing was persisted -- leaving the
  // durable state file claiming an in-flight recovery that had already
  // stopped. It must instead return normally, name the real cause and
  // detail, and land the failed status durably.
  {
    const detailedError = Object.assign(
      new Error("RECOVERY_TARGET_UPGRADE_REQUIRED"),
      {
        code: "RECOVERY_TARGET_UPGRADE_REQUIRED",
        detail: "this brain's schema is at 35 and this recovery runner requires 36. " +
          "Run `brain update <manifest>` on it first, then recover. " +
          "The runner never upgrades a brain implicitly.",
      },
    );
    const detailedCalls = [];
    let threw = null;
    let detailedResult = null;
    try {
      detailedResult = await runVerifiedRecovery(
        initialized.plan,
        initialState,
        goodAdapters(detailedCalls, { export_d1: detailedError }),
        {
          clock: clock(Date.parse("2026-08-25T15:00:00.000Z")),
          revalidateManifests: async () => true,
        },
      );
    } catch (error) {
      threw = error;
    }
    assert.equal(threw, null, `runVerifiedRecovery must return, not throw, on a detailed adapter failure: ${threw?.message}`);
    assert.equal(detailedResult.ok, false);
    assert.equal(detailedResult.errorCode, "RECOVERY_EXPORT_D1_FAILED");
    assert.equal(detailedResult.cause, "RECOVERY_TARGET_UPGRADE_REQUIRED");
    assert.match(detailedResult.detail, /run `brain update <manifest>` on it first, then recover/i);
    assert.equal(detailedResult.state.status, "failed");
    assert.equal(detailedResult.state.stage_status, "failed");
    assert.equal(detailedResult.state.current_stage, "export_d1");
    assert.equal(detailedResult.state.failure.cause, "RECOVERY_TARGET_UPGRADE_REQUIRED");
    assert.match(detailedResult.state.failure.detail, /run `brain update <manifest>` on it first, then recover/i);
    // The state must validate on its own terms too: a second consumer reading
    // the persisted file back must not choke on it either.
    const revalidated = validateVerifiedRecoveryState(detailedResult.state, initialized.plan);
    assert.equal(revalidated.status, "failed");
    console.log("PASS  a detailed adapter failure returns normally, carries cause and detail, and validates");
  }
  // The same failure with NO detail (an ordinary Error, or an adapter error
  // whose code/detail are absent) must still validate: cause/detail are
  // always present as null, never omitted.
  {
    const bareError = new Error("boring failure");
    const bareResult = await runVerifiedRecovery(
      initialized.plan,
      initialState,
      goodAdapters([], { export_d1: bareError }),
      {
        clock: clock(Date.parse("2026-08-25T15:30:00.000Z")),
        revalidateManifests: async () => true,
      },
    );
    assert.equal(bareResult.ok, false);
    assert.equal(bareResult.cause, null);
    assert.equal(bareResult.detail, null);
    assert.equal(bareResult.state.failure.cause, null);
    assert.equal(bareResult.state.failure.detail, null);
    console.log("PASS  an ordinary failure with no adapter code/detail still validates, both fields null");
  }

  let restoreCalls = 0;
  const dirtyTargetAdapters = goodAdapters([], {
    prove_target_clean: { user_table_count: 1 },
  });
  dirtyTargetAdapters.restore_d1 = async () => {
    restoreCalls++;
    return evidenceFor("restore_d1", { targetResourceFingerprint: plan.target_resource_fingerprint });
  };
  const dirtyTarget = await runVerifiedRecovery(
    initialized.plan,
    initialState,
    dirtyTargetAdapters,
    {
      clock: clock(Date.parse("2026-08-25T15:00:00.000Z")),
      revalidateManifests: async () => true,
    },
  );
  assert.equal(dirtyTarget.ok, false);
  assert.equal(dirtyTarget.errorCode, "RECOVERY_PROVE_TARGET_CLEAN_FAILED");
  assert.equal(restoreCalls, 0);

  const vectorMismatch = await runVerifiedRecovery(
    initialized.plan,
    initialState,
    goodAdapters([], { rebuild_vectorize: { vector_count: 4 } }),
    {
      clock: clock(Date.parse("2026-08-25T16:00:00.000Z")),
      revalidateManifests: async () => true,
    },
  );
  assert.equal(vectorMismatch.ok, false);
  assert.equal(vectorMismatch.errorCode, "RECOVERY_REBUILD_VECTORIZE_FAILED");
  assert.equal(vectorMismatch.state.completed.some((entry) => entry.id === "verify_health"), false);

  // The v0.4.8 disposable field campaign is an explicit state opt-in. Its
  // 6,001-document seed receipt must match the already-verified D1 export
  // before the first Vectorize rebuild attempt, while ordinary journals keep
  // their original shape and evidence contract.
  assert.equal(Object.hasOwn(initialState, "field_proof"), false);
  const ordinaryInitialBytes = JSON.stringify(initialState);
  assert.throws(
    () => bindVerifiedRecoveryFieldProof(
      initialState,
      initialized.plan,
      fieldProofInput,
      { now: new Date("2026-08-25T16:30:00.000Z") },
    ),
    /does not match the verified D1 export/,
  );

  const fieldEvidenceOverrides = {
    verify_export: {
      content_fingerprint: fieldContentHash,
      document_count: fieldExpectedDocuments,
      chunk_count: fieldExpectedChunks,
      fts_count: fieldExpectedChunks,
    },
    verify_d1: {
      content_fingerprint: fieldContentHash,
      non_bank_content_fingerprint: fieldContentHash,
      document_count: fieldExpectedDocuments,
      chunk_count: fieldExpectedChunks,
      fts_count: fieldExpectedChunks,
    },
    reconcile_security: {
      content_fingerprint: fieldContentHash,
      document_count: fieldExpectedDocuments,
      chunk_count: fieldExpectedChunks,
      fts_count: fieldExpectedChunks,
    },
  };
  let fieldReadyState = initialState;
  await assert.rejects(
    runVerifiedRecovery(
      initialized.plan,
      initialState,
      goodAdapters([], fieldEvidenceOverrides),
      {
        clock: clock(Date.parse("2026-08-25T17:00:00.000Z")),
        revalidateManifests: async () => true,
        persistState: async (state) => { fieldReadyState = state; },
        afterStageCheckpoint: async (stage) => {
          if (stage === "reconcile_security") throw new Error("fixture field checkpoint");
        },
      },
    ),
    /fixture field checkpoint/,
  );
  assert.equal(fieldReadyState.current_stage, "rebuild_vectorize");
  assert.equal(fieldReadyState.stage_status, "pending");
  assert.equal(fieldReadyState.attempt, 0);
  assert.equal(fieldReadyState.completed.at(-1).id, "reconcile_security");

  const boundAt = "2026-08-25T18:00:00.000Z";
  const fieldBound = bindVerifiedRecoveryFieldProof(
    fieldReadyState,
    initialized.plan,
    fieldProofInput,
    { now: new Date(boundAt) },
  );
  assert.deepEqual(fieldBound.field_proof, { ...fieldProofInput, bound_at: boundAt });
  assert.equal(fieldBound.updated_at, boundAt);
  assert.equal(JSON.stringify(initialState), ordinaryInitialBytes);
  assert.equal(Object.hasOwn(initialState, "field_proof"), false);
  assert.deepEqual(validateVerifiedRecoveryState(fieldBound, initialized.plan), fieldBound);

  const fieldStatePath = join(sandbox, ".brain-recovery-field-state.json");
  writeVerifiedRecoveryState(fieldStatePath, fieldBound, initialized.plan);
  assert.deepEqual(loadVerifiedRecoveryState(fieldStatePath, initialized.plan), fieldBound);

  // Rebinding is only idempotent for the same canonical proof. Omitting the
  // generated timestamp reuses the durable original rather than changing it.
  assert.deepEqual(
    bindVerifiedRecoveryFieldProof(
      fieldBound,
      initialized.plan,
      fieldProofInput,
      { now: new Date("2026-08-25T19:00:00.000Z") },
    ),
    fieldBound,
  );
  assert.deepEqual(
    bindVerifiedRecoveryFieldProof(
      fieldBound,
      initialized.plan,
      fieldBound.field_proof,
      { now: new Date("2026-08-25T19:00:00.000Z") },
    ),
    fieldBound,
  );
  assert.throws(
    () => bindVerifiedRecoveryFieldProof(fieldBound, initialized.plan, {
      ...fieldProofInput,
      candidate_sha: "8".repeat(40),
    }),
    /already bound to different evidence/,
  );
  assert.throws(
    () => bindVerifiedRecoveryFieldProof(fieldBound, initialized.plan, {
      ...fieldBound.field_proof,
      bound_at: "2026-08-25T18:00:01.000Z",
    }),
    /already bound to different evidence/,
  );

  const attemptedUnboundState = validateVerifiedRecoveryState({
    ...structuredClone(fieldReadyState),
    status: "running",
    stage_status: "running",
    attempt: 1,
    updated_at: "2026-08-25T18:30:00.000Z",
  }, initialized.plan);
  assert.throws(
    () => bindVerifiedRecoveryFieldProof(attemptedUnboundState, initialized.plan, fieldProofInput),
    /cannot be bound after rebuild begins/,
  );

  for (const mutate of [
    (proof) => { delete proof.package_sha256; },
    (proof) => { delete proof.source_phase_receipt_sha256; },
    (proof) => { delete proof.deployment_receipt_sha256; },
    (proof) => { proof.unreviewed = true; },
    (proof) => { proof.kind = "v048_disposable_bootstrap_interruption"; },
    (proof) => { proof.candidate_sha = "a".repeat(64); },
    (proof) => { proof.fixture_sha256 = "9".repeat(64); },
    (proof) => { proof.expected_documents = 3_201; },
    (proof) => { proof.expected_chunks = 6_000; proof.expected_fts = 6_000; },
    (proof) => { proof.expected_fts++; },
    (proof) => { proof.seed_replay_unchanged_documents = 3_201; },
    (proof) => { proof.bound_at = "2026-08-25"; },
    (proof) => { proof.seed_d1_content_fingerprint = "not-a-hash"; },
  ]) {
    const invalid = structuredClone(fieldBound);
    mutate(invalid.field_proof);
    assert.throws(() => validateVerifiedRecoveryState(invalid, initialized.plan));
  }
  for (const mutate of [
    (state) => { state.completed[1].evidence.document_count++; },
    (state) => { state.completed[1].evidence.chunk_count++; },
    (state) => { state.completed[1].evidence.fts_count++; },
    (state) => { state.completed[1].evidence.content_fingerprint = "9".repeat(64); },
  ]) {
    const invalid = structuredClone(fieldBound);
    mutate(invalid);
    assert.throws(() => validateVerifiedRecoveryState(invalid, initialized.plan));
  }

  const missingFieldRebuildProof = await runVerifiedRecovery(
    initialized.plan,
    fieldBound,
    goodAdapters([], {
      rebuild_vectorize: {
        chunk_count: fieldExpectedChunks,
        vector_count: fieldExpectedChunks,
      },
    }),
    {
      clock: clock(Date.parse("2026-08-25T20:00:00.000Z")),
      revalidateManifests: async () => true,
    },
  );
  assert.equal(missingFieldRebuildProof.ok, false);
  assert.equal(missingFieldRebuildProof.errorCode, "RECOVERY_REBUILD_VECTORIZE_FAILED");

  const partialFieldRebuildProof = await runVerifiedRecovery(
    initialized.plan,
    fieldBound,
    goodAdapters([], {
      rebuild_vectorize: {
        chunk_count: fieldExpectedChunks,
        vector_count: fieldExpectedChunks,
        seed_receipt_sha256: fieldProofInput.seed_receipt_sha256,
      },
    }),
    {
      clock: clock(Date.parse("2026-08-25T20:30:00.000Z")),
      revalidateManifests: async () => true,
    },
  );
  assert.equal(partialFieldRebuildProof.ok, false);
  assert.equal(partialFieldRebuildProof.errorCode, "RECOVERY_REBUILD_VECTORIZE_FAILED");

  const mismatchedFieldRebuildProof = await runVerifiedRecovery(
    initialized.plan,
    fieldBound,
    goodAdapters([], {
      rebuild_vectorize: {
        chunk_count: fieldExpectedChunks,
        vector_count: fieldExpectedChunks,
        ...fieldRebuildProof,
        seed_receipt_sha256: "8".repeat(64),
      },
    }),
    {
      clock: clock(Date.parse("2026-08-25T21:00:00.000Z")),
      revalidateManifests: async () => true,
    },
  );
  assert.equal(mismatchedFieldRebuildProof.ok, false);
  assert.equal(mismatchedFieldRebuildProof.errorCode, "RECOVERY_REBUILD_VECTORIZE_FAILED");

  const fieldCompleted = await runVerifiedRecovery(
    initialized.plan,
    fieldBound,
    goodAdapters([], {
      rebuild_vectorize: {
        chunk_count: fieldExpectedChunks,
        vector_count: fieldExpectedChunks,
        ...fieldRebuildProof,
      },
    }),
    {
      clock: clock(Date.parse("2026-08-25T21:30:00.000Z")),
      revalidateManifests: async () => true,
    },
  );
  assert.equal(fieldCompleted.ok, true);
  assert.equal(fieldCompleted.state.status, "complete");
  assert.deepEqual(
    fieldCompleted.state.completed.find((entry) => entry.id === "rebuild_vectorize").evidence,
    {
      chunk_count: fieldExpectedChunks,
      vector_count: fieldExpectedChunks,
      pending_outbox: 0,
      failed_vectors: 0,
      ...fieldRebuildProof,
    },
  );
  assert.deepEqual(
    bindVerifiedRecoveryFieldProof(
      fieldCompleted.state,
      initialized.plan,
      fieldProofInput,
    ),
    fieldCompleted.state,
  );

  for (const mutate of [
    (state) => { delete state.completed[6].evidence.bootstrap_resume_authorization_sha256; },
    (state) => { state.completed[6].evidence.source_phase_receipt_sha256 = "8".repeat(64); },
    (state) => { state.completed[6].evidence.deployment_receipt_sha256 = "invalid"; },
    (state) => { state.completed[6].evidence.bootstrap_promotion_authorization_sha256 = "invalid"; },
    (state) => { state.completed[6].evidence.seed_receipt_sha256 = "8".repeat(64); },
    (state) => { delete state.field_proof; },
  ]) {
    const invalid = structuredClone(fieldCompleted.state);
    mutate(invalid);
    assert.throws(() => validateVerifiedRecoveryState(invalid, initialized.plan));
  }

  const ordinaryWithFieldEvidence = structuredClone(completed.state);
  Object.assign(
    ordinaryWithFieldEvidence.completed.find((entry) => entry.id === "rebuild_vectorize").evidence,
    fieldRebuildProof,
  );
  assert.throws(
    () => validateVerifiedRecoveryState(ordinaryWithFieldEvidence, initialized.plan),
    /rebuild_vectorize evidence is invalid/,
  );

  const unboundFieldCompleted = await runVerifiedRecovery(
    initialized.plan,
    fieldReadyState,
    goodAdapters([], {
      rebuild_vectorize: {
        chunk_count: fieldExpectedChunks,
        vector_count: fieldExpectedChunks,
      },
    }),
    {
      clock: clock(Date.parse("2026-08-25T22:00:00.000Z")),
      revalidateManifests: async () => true,
    },
  );
  assert.equal(unboundFieldCompleted.ok, true);
  assert.throws(
    () => bindVerifiedRecoveryFieldProof(
      unboundFieldCompleted.state,
      initialized.plan,
      fieldProofInput,
    ),
    /cannot be bound after rebuild begins/,
  );

  assert.throws(
    () => validateVerifiedRecoveryState({
      ...structuredClone(initialState),
      current_stage: "restore_d1",
    }, initialized.plan),
    /current stage is inconsistent/,
  );

  const secondTarget = manifestVariant(targetManifest, (value) => {
    value.infrastructure.cloudflare.d1_database_name = "fixture-second-recovery-d1";
    value.infrastructure.cloudflare.d1_database_id = "fixture-second-recovery-id";
    value.infrastructure.cloudflare.vectorize_index = "fixture-second-recovery-vector";
    value.brain.worker_name = "fixture-second-recovery-worker";
    value.brain.domain = "second-recovery.fixture.invalid";
  });
  const driftedPlan = buildVerifiedRecoveryPlan(sourcePath, secondTarget, { now: createdAt });
  assert.throws(
    () => validateVerifiedRecoveryState(initialState, driftedPlan),
    /plan binding is invalid/,
  );

  const status = verifiedRecoveryStatus(initialized.plan, failed.state);
  assert.deepEqual(status, {
    plan_fingerprint: initialized.plan.plan_fingerprint,
    status: "failed",
    current_stage: "restore_d1",
    stage_status: "failed",
    attempt: 1,
    completed_stages: 3,
    total_stages: 9,
    failure_code: "RECOVERY_RESTORE_D1_FAILED",
  });
  const statusText = JSON.stringify(status);
  for (const forbidden of [sentinel, sourcePath, targetPath, sourceManifest.brain.domain]) {
    assert.equal(statusText.includes(forbidden), false);
  }

  const cli = spawnSync(
    process.execPath,
    [join(process.cwd(), "operations", "verified-recovery.mjs"), "status", planPath, statePath],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout.includes("\"status\": \"complete\""), true);
  for (const forbidden of [sentinel, sourcePath, targetPath, sourceManifest.brain.domain]) {
    assert.equal(`${cli.stdout}${cli.stderr}`.includes(forbidden), false);
  }

  assert.throws(() => writeVerifiedRecoveryPlan(planPath, initialized.plan), /already exists/);

  if (process.platform !== "win32") {
    const openDirectory = join(sandbox, "open-control-directory");
    mkdirSync(openDirectory, { mode: 0o755 });
    chmodSync(openDirectory, 0o755);
    assert.throws(
      () => writeVerifiedRecoveryPlan(join(openDirectory, "plan.json"), initialized.plan),
      /control directory is not owner-only/,
    );

    const unsafeState = join(sandbox, "unsafe-state.json");
    writeJson(unsafeState, initialState, 0o644);
    assert.throws(
      () => loadVerifiedRecoveryState(unsafeState, initialized.plan),
      /owner-only mode 0600/,
    );

    const linkTarget = join(sandbox, "link-target.json");
    writeJson(linkTarget, initialState);
    const symbolicState = join(sandbox, "symbolic-state.json");
    symlinkSync(linkTarget, symbolicState);
    assert.throws(
      () => loadVerifiedRecoveryState(symbolicState, initialized.plan),
      /bounded regular file/,
    );
    const hardState = join(sandbox, "hard-state.json");
    linkSync(linkTarget, hardState);
    assert.throws(
      () => loadVerifiedRecoveryState(hardState, initialized.plan),
      /bounded regular file/,
    );
  }

  const occupiedState = join(sandbox, "occupied-state.json");
  const partialPlan = join(sandbox, "partial-plan.json");
  writeFileSync(occupiedState, "preserve me\n", { mode: 0o600 });
  assert.throws(
    () => initializeVerifiedRecovery(
      sourcePath,
      targetPath,
      partialPlan,
      occupiedState,
      { now: createdAt },
    ),
    /already exists/,
  );
  assert.equal(existsSync(partialPlan), false);
  assert.equal(readFileSync(occupiedState, "utf8"), "preserve me\n");

  const backupPlaintext = Buffer.from(`synthetic durable SQL ${sentinel}`);
  const backupKey = Buffer.alloc(32, 7);
  const artifactCreated = new Date("2026-08-30T00:00:00Z");
  const encryptedArtifact = encryptOffProviderBackup(backupPlaintext, {
    key: backupKey,
    createdAt: artifactCreated,
    retentionClass: "daily",
    randomBytesImpl: () => Buffer.alloc(12, 3),
  });
  assert.equal(encryptedArtifact.includes(backupPlaintext), false, "encrypted artifact contains no plaintext corpus bytes");
  assert.equal(encryptedArtifact.includes(backupKey), false, "encrypted artifact never contains its out-of-band key");
  const decrypted = decryptOffProviderBackup(encryptedArtifact, { key: backupKey });
  assert.deepEqual(decrypted.plaintext, backupPlaintext);
  assert.equal(decrypted.metadata.retention_class, "daily");
  assert.deepEqual(RETENTION_CLASSES.daily, { cadence_hours: 24, copies: 14 });
  const tampered = Buffer.from(encryptedArtifact);
  tampered[tampered.length - 8] ^= 1;
  assert.throws(
    () => decryptOffProviderBackup(tampered, { key: backupKey }),
    /authentication failed|valid encrypted envelope/,
  );

  const restoreEvidence = buildRestoreEvidence({
    artifactMetadata: decrypted.metadata,
    startedAt: "2026-08-30T01:00:00Z",
    completedAt: "2026-08-30T03:00:00Z",
    sourceCounts: { documents: 12, chunks: 34 },
    restoredCounts: { documents: 12, chunks: 34 },
    restoredSha256: decrypted.metadata.plaintext_sha256,
    schemaVersion: 22,
    evaluationPassed: true,
  });
  assert.equal(restoreEvidence.status, "passed");
  assert.equal(restoreEvidence.objectives.rpo_hours, BACKUP_RPO_HOURS);
  assert.equal(restoreEvidence.objectives.rto_hours, BACKUP_RTO_HOURS);
  const evidenceText = JSON.stringify(restoreEvidence);
  for (const forbidden of [sentinel, sourcePath, targetPath, backupPlaintext.toString("utf8")]) {
    assert.equal(evidenceText.includes(forbidden), false);
  }
  assert.equal(restoreEvidenceStatus(restoreEvidence, { now: "2026-11-28T03:00:00Z" }).current, true);
  assert.deepEqual(
    restoreEvidenceStatus(restoreEvidence, { now: "2026-11-30T03:00:00Z" }),
    {
      current: false,
      due: true,
      reason: "restore_drill_due",
      age_days: 92,
      next_due_at: "2026-11-28T03:00:00.000Z",
    },
  );

  console.log("PASS  verified recovery plus encrypted off-provider artifacts, RPO/RTO, and recurring evidence are gated");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
