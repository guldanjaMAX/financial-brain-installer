import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  ProvenanceTargetCliError,
  applyProvenanceTargetRepair,
  parseProvenanceTargetRepairArgv,
  previewProvenanceTargetRepair,
  renderProvenanceTargetRepairReceipt,
} from "../operations/provenance-target-cli.mjs";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const hash = (value) => createHash("sha256").update(canonical(value)).digest("hex");
const hashId = (value) => `sha256:${hash(value)}`;
const digest = (character) => character.repeat(64);

const MANIFEST_PATH = "/synthetic/private/install/brain.manifest.json";
const ROOT = "/synthetic/private/source";
const SOURCE = "client_docs";
const TARGET = "tax/2025/return.txt";
const ORIGINAL_HASH = digest("a");
const ORIGINAL_ID = `hmac-sha256:${digest("b")}`;
const PRIVATE_CONTENT = "Synthetic uncommon revenue reconciliation sentence for exact deterministic retrieval.";
const PRODUCT_VERSION = "0.4.8";
const RUNTIME_FINGERPRINT = digest("c");

const BOUNDED_SCOPE = Object.freeze({
  kind: "bounded_target_set",
  maximum_targets: 10,
  whole_source_complete: false,
  accepted_outcomes_supported: false,
  repair_verification_supported: false,
  raw_original_result_family_receipt: "available_non_authorizing",
  meaning: "Evidence applies only to the explicitly sealed originals; it is not a whole-source enumeration.",
});

const ACCEPTED_SCOPE = Object.freeze({
  ...BOUNDED_SCOPE,
  kind: "single_target_accepted_resolution",
  maximum_targets: 1,
  accepted_outcomes_supported: true,
  accepted_resolution_mode: "one_exact_current_result_family",
  repair_verification_supported: true,
});

const manifest = Object.freeze({
  brain: Object.freeze({ version: PRODUCT_VERSION, domain: "fixture.invalid" }),
  corpora: Object.freeze({
    local_folder: Object.freeze({ enabled: true, path: ROOT, source: SOURCE }),
  }),
  safety: Object.freeze({
    credential_scanner: Object.freeze({ enabled: true }),
    private_path_prefixes: Object.freeze(["private/"]),
  }),
});

const invocation = (approvalId = undefined) => ({
  manifestPath: MANIFEST_PATH,
  source: SOURCE,
  target: TARGET,
  productVersion: PRODUCT_VERSION,
  candidateRuntimePackageFingerprint: RUNTIME_FINGERPRINT,
  ...(approvalId ? { approvalId } : {}),
});

function stat(type, device, inode, symlink = false) {
  return {
    dev: device,
    ino: inode,
    isFile: () => type === "file",
    isDirectory: () => type === "directory",
    isSymbolicLink: () => symlink,
  };
}

function sourceInventory(storageCount) {
  const asOf = "2026-09-11T00:00:00.000Z";
  return {
    contract_version: 3,
    kind: "source_inventory",
    complete: true,
    truncated: false,
    cursor: null,
    total: 1,
    returned: 1,
    as_of: asOf,
    snapshot: { id: hashId({ at: asOf, storageCount }), as_of: asOf, stable: true, total: 1 },
    sources: [{
      source_id: SOURCE,
      name: SOURCE,
      kind: "upload",
      registered: true,
      storage: { physical_documents: storageCount },
      provenance: { state: "incomplete" },
    }],
    recovery_plan_summary: { candidate_documents: 1 },
    limitations: ["synthetic_fixture"],
  };
}

function assessment() {
  return {
    assessment: {
      schema_version: 1,
      operation: "provenance-source-assessment",
      mode: "read_only",
      read_only: true,
      assessment_complete: true,
      target_count: 1,
      assessed_original_count: 1,
      traversal: { complete: true, gap_count: 0 },
      target_resolution: { complete: true, missing_count: 0, equality_only: true },
      ocr: { enabled: false, attempted: false },
    },
    private_observations: [{
      ordinal: 1,
      position: 0,
      assessment_complete: true,
      locator_kind: "source_relative_path",
      locator: TARGET,
      observation_stage: "discovery",
      outcome: "gap",
      reason_code: "provenance_unassessed",
      text_state: "native_readable",
      text_reliable: true,
      extraction_complete: true,
      original_content_sha256: ORIGINAL_HASH,
      original_byte_count: 91,
      page_count: null,
      page_count_state: "not_applicable",
      multi_record: false,
    }],
  };
}

function preparedEnvelope() {
  return {
    envelope: {
      source_type: SOURCE,
      source_id: TARGET,
      title: "Synthetic return",
      content: PRIVATE_CONTENT,
      occurred_at: null,
      date_source: "none",
      date_reliable: false,
      text_source: "native",
      text_reliable: true,
      metadata: { category: SOURCE },
      source_original_receipt: {
        version: 1,
        locator_kind: "source_relative_path",
        original_content_sha256: ORIGINAL_HASH,
        original_byte_count: 91,
      },
    },
  };
}

function emptyObservationInventory() {
  return {
    contract_version: 1,
    mode: "inventory",
    source: SOURCE,
    snapshot_id: hashId({ observations: [] }),
    returned: 0,
    total: 0,
    page_complete: true,
    next_after_sequence: null,
    observations: [],
    scope: BOUNDED_SCOPE,
  };
}

function acceptedObservationInventory() {
  const gapHash = hashId({ gap: "observation" });
  const acceptedHash = hashId({ accepted: "observation" });
  const priorPlanId = digest("1");
  const priorSourceSnapshotId = hashId({ prior: "source-snapshot" });
  const priorTargetSetHash = hashId({
    contract_version: 1,
    source: SOURCE,
    plan_id: priorPlanId,
    source_snapshot_id: priorSourceSnapshotId,
    targets: [{ locator_kind: "source_relative_path", original_id: ORIGINAL_ID }],
  });
  const observations = [{
    sequence: 1,
    source: SOURCE,
    original_id: ORIGINAL_ID,
    observation_hash: gapHash,
    outcome: "gap",
    reason_code: "provenance_unassessed",
    original_content_sha256: ORIGINAL_HASH,
    authority_chain_version: 1,
    predecessor_observation_hash: null,
  }, {
    sequence: 2,
    source: SOURCE,
    original_id: ORIGINAL_ID,
    locator_kind: "source_relative_path",
    run_id: "ptra_prior_repair",
    plan_id: priorPlanId,
    source_snapshot_id: priorSourceSnapshotId,
    target_set_hash: priorTargetSetHash,
    target_count: 1,
    observation_stage: "repair",
    outcome: "accepted",
    reason_code: "accepted_provenance_verified",
    text_state: "native_readable",
    original_content_sha256: ORIGINAL_HASH,
    original_byte_count: 91,
    page_count: null,
    page_count_state: "not_applicable",
    result_document_count: 1,
    result_document_set_hash: hashId({ family: "accepted" }),
    resolves_observation_hash: gapHash,
    observation_hash: acceptedHash,
    recorded_at: 1001,
    authority_chain_version: 1,
    predecessor_observation_hash: gapHash,
  }];
  return {
    contract_version: 1,
    mode: "inventory",
    source: SOURCE,
    snapshot_id: hashId({ observations }),
    returned: observations.length,
    total: observations.length,
    page_complete: true,
    next_after_sequence: null,
    observations,
    scope: BOUNDED_SCOPE,
  };
}

function sealReceipt(request) {
  const targetSetHash = hashId({
    contract_version: 1,
    source: request.source,
    plan_id: request.plan_id,
    source_snapshot_id: request.source_snapshot_id,
    targets: [{ locator_kind: "source_relative_path", original_id: ORIGINAL_ID }],
  });
  return {
    contract_version: 1,
    mode: "seal",
    source: request.source,
    plan_id: request.plan_id,
    source_snapshot_id: request.source_snapshot_id,
    target_set_hash: targetSetHash,
    target_count: 1,
    targets: [{ position: 0, original_id: ORIGINAL_ID }],
    scope: BOUNDED_SCOPE,
  };
}

function discoveryReceipt(request) {
  const target = request.targets[0];
  const base = {
    source: request.source,
    original_id: target.original_id,
    locator_kind: target.locator_kind,
    run_id: request.run_id,
    plan_id: request.plan_id,
    source_snapshot_id: request.source_snapshot_id,
    target_set_hash: request.target_set_hash,
    target_count: 1,
    observation_stage: "discovery",
    outcome: "gap",
    reason_code: "provenance_unassessed",
    text_state: target.text_state,
    original_content_sha256: target.original_content_sha256,
    original_byte_count: target.original_byte_count,
    page_count: target.page_count,
    page_count_state: target.page_count_state,
    result_document_count: 1,
    result_document_set_hash: hashId({ family: "before" }),
    resolves_observation_hash: null,
  };
  const observation = {
    sequence: 1,
    ...base,
    observation_hash: hashId({ contract_version: 1, tenant_id: "primary", ...base }),
    recorded_at: 1000,
    authority_chain_version: 1,
    predecessor_observation_hash: request.targets[0].predecessor_observation_hash,
  };
  return {
    contract_version: 1,
    mode: "record",
    source: request.source,
    run_id: request.run_id,
    target_set_hash: request.target_set_hash,
    target_count: 1,
    observations: [observation],
    bounded_target_set_recorded: true,
    repair_receipts_recorded: false,
    scope: BOUNDED_SCOPE,
  };
}

function familyReceipt(request, operation, { mismatch = false } = {}) {
  return {
    contract_version: 1,
    mode: "result_family",
    operation,
    source: request.source,
    original_id: ORIGINAL_ID,
    family_receipt_hash: mismatch ? hashId({ family: "different" }) : hashId({ family: "current" }),
    verification_hash: hashId({ verification: "current" }),
    document_count: 1,
    chunk_count: 2,
    vector_readiness_hash: hashId({ vectors: "ready" }),
    retrieval_probe_id: `probe-v1:${digest("d")}`,
    retrieval_status: "deterministic",
    citation_status: "same_family",
    recorded: operation === "record",
    replayed: operation === "verify",
    accepted_outcome_authorized: false,
  };
}

function acceptedReceipt(request, operation, family, {
  acceptedHash = hashId({ accepted: "observation" }),
  reactivated = false,
} = {}) {
  const reactivatedRecord = operation === "record" && reactivated;
  return {
    contract_version: 1,
    mode: "accepted_resolution",
    operation,
    source: request.source,
    run_id: request.run_id,
    original_id: ORIGINAL_ID,
    target_set_hash: request.target_set_hash,
    target_count: 1,
    accepted_observation_hash: acceptedHash,
    resolution_hash: hashId({ accepted: "resolution" }),
    activation_hash: hashId({ accepted: "activation" }),
    family_receipt_hash: family.family_receipt_hash,
    verification_hash: family.verification_hash,
    document_count: family.document_count,
    chunk_count: family.chunk_count,
    vector_readiness_hash: family.vector_readiness_hash,
    retrieval_probe_id: family.retrieval_probe_id,
    retrieval_status: "deterministic",
    citation_status: "same_family",
    status: "accepted_resolution_current",
    recorded: operation === "record" && !reactivatedRecord,
    replayed: operation === "verify",
    reactivated: reactivatedRecord,
    accepted_outcome_authorized: true,
    bounded_target_set_repair_verified: true,
    scope: ACCEPTED_SCOPE,
  };
}

function fixtureDependencies(options = {}) {
  const state = {
    events: [],
    mutations: [],
    storageCount: 1,
    owned: true,
    queryValues: [],
    privateProbeCount: 0,
    family: null,
    runtimeCheckCount: 0,
    runtimeChanged: false,
    observationInventory: null,
    reactivateAccepted: false,
    ...options.state,
  };
  const mutate = async (name, payload, action) => {
    state.events.push(name);
    state.mutations.push(name);
    await payload.assertOwned();
    const response = action();
    if (state.loseDuring === name) state.owned = false;
    return response;
  };
  const dependencies = {
    acquireSourceLease: async () => {
      state.events.push("lease.acquire");
      return {
        fingerprint: digest("e"),
        assertOwned: async () => {
          if (!state.owned) throw new Error("synthetic source lease lost");
        },
        release: async () => state.events.push("lease.release"),
      };
    },
    lstat: async (path) => {
      state.events.push(`lstat:${path === MANIFEST_PATH ? "manifest" : "root"}`);
      if (path === MANIFEST_PATH) return stat("file", 1, 11, state.manifestSymlink === true);
      if (path === ROOT) return stat(
        "directory",
        state.rootDevice ?? 2,
        state.rootInode ?? 22,
        state.rootSymlink === true,
      );
      throw new Error("unexpected synthetic path");
    },
    realpath: async (path) => path,
    readFile: async () => JSON.stringify(manifest),
    verifyCandidateRuntime: async (request) => {
      state.runtimeCheckCount += 1;
      return {
        verified: state.runtimeChanged !== true,
        product_version: request.productVersion,
        package_fingerprint: state.runtimeChanged
          ? digest("f")
          : request.candidateRuntimePackageFingerprint,
      };
    },
    resolveDurableAdminAccess: async () => ({ kind: "durable_admin", request: async () => {} }),
    readWorkerHealth: async () => ({
      ok: true,
      active: true,
      accepting_documents: true,
      product_version: PRODUCT_VERSION,
      schema_version: 46,
    }),
    readVectorReadiness: async () => ({
      ready: true,
      pending: 0,
      submitted: 0,
      projection_status: "verified",
      expected_vectors: 9,
      actual_vectors: 9,
    }),
    readSourceInventory: async () => sourceInventory(state.storageCount),
    assessLocalSource: async (request) => {
      assert.deepEqual(request.relativeLocators, [TARGET]);
      assert.equal(request.sourceKind, "upload");
      return assessment();
    },
    prepareOriginal: async (request) => {
      assert.equal(request.locator, TARGET);
      assert.equal(request.ocr, null);
      assert.equal(request.allowStructuralSplit, true);
      if (state.changeRuntimeAfterPrepare === true) state.runtimeChanged = true;
      return preparedEnvelope();
    },
    sealTargets: async ({ request }) => sealReceipt(request),
    readObservationInventory: async () =>
      state.observationInventory ?? emptyObservationInventory(),
    recordDiscovery: async (payload) => mutate("discovery.record", payload,
      () => discoveryReceipt(payload.request)),
    ingestPrepared: async (payload) => mutate("ingest.exact", payload, () => ({
      created: 0,
      updated: 1,
      unchanged: 0,
      refused: 0,
      failed: 0,
      results: payload.envelopes.map((envelope) => ({
        source_type: envelope.source_type,
        source_id: envelope.source_id,
        status: "updated",
      })),
    })),
    reconcileFamily: async (payload) => mutate("family.reconcile", payload, () => ({
      complete: true,
      scope: payload.family.scope,
      source: payload.family.source,
      base_doc_uid: payload.family.base_doc_uid,
      keep_doc_uids: [...payload.family.keep_doc_uids],
      removed_count: 0,
    })),
    drainVectorOutbox: async (payload) => mutate("vectors.drain", payload, () => ({
      complete: true,
      readiness: {
        ready: true,
        pending: 0,
        submitted: 0,
        projection_status: "verified",
        expected_vectors: 9,
        actual_vectors: 9,
      },
    })),
    recordResultFamily: async (payload) => mutate("result_family.record", payload, () => {
      state.queryValues.push(payload.request.retrieval_query);
      state.privateProbeCount += 2;
      state.family = familyReceipt(payload.request, "record");
      return state.family;
    }),
    verifyResultFamily: async (payload) => mutate("result_family.verify", payload, () => {
      state.queryValues.push(payload.request.retrieval_query);
      state.privateProbeCount += 2;
      return familyReceipt(payload.request, "verify", { mismatch: state.familyMismatch === true });
    }),
    recordAcceptedResolution: async (payload) => mutate("accepted.record", payload, () => {
      state.queryValues.push(payload.request.retrieval_query);
      state.privateProbeCount += 2;
      return acceptedReceipt(payload.request, "record", state.family, {
        acceptedHash: state.observationInventory?.observations?.find((row) =>
          row.outcome === "accepted")?.observation_hash,
        reactivated: state.reactivateAccepted,
      });
    }),
    verifyAcceptedResolution: async (payload) => mutate("accepted.verify", payload, () => {
      state.queryValues.push(payload.request.retrieval_query);
      state.privateProbeCount += 2;
      return acceptedReceipt(payload.request, "verify", state.family, {
        acceptedHash: state.observationInventory?.observations?.find((row) =>
          row.outcome === "accepted")?.observation_hash,
      });
    }),
  };
  return { state, dependencies };
}

/* The target lane accepts one positional manifest and rejects ambiguity. */
assert.deepEqual(parseProvenanceTargetRepairArgv([
  MANIFEST_PATH,
  "--source", SOURCE,
  "--target", TARGET,
]), {
  manifest: MANIFEST_PATH,
  source: SOURCE,
  target: TARGET,
  apply: false,
  approve: null,
  json: false,
});
for (const argv of [
  [MANIFEST_PATH, "extra", "--source", SOURCE, "--target", TARGET],
  [MANIFEST_PATH, "--source", SOURCE, "--source", SOURCE, "--target", TARGET],
  [MANIFEST_PATH, `--source=${SOURCE}`, "--target", TARGET],
  [MANIFEST_PATH, "--source", SOURCE, "--target", TARGET, "--approve", digest("1")],
  [MANIFEST_PATH, "--source", SOURCE, "--target", TARGET, "--apply"],
  [MANIFEST_PATH, "--source", SOURCE, "--target", TARGET, "--apply", "--approve", digest("1"), "--json"],
]) {
  assert.throws(() => parseProvenanceTargetRepairArgv(argv));
}

/* Preview takes the source lease first and never invokes a mutating callback. */
const previewFixture = fixtureDependencies();
const preview = await previewProvenanceTargetRepair(invocation(), previewFixture.dependencies);
assert.equal(previewFixture.state.events[0], "lease.acquire");
assert.equal(previewFixture.state.events.at(-1), "lease.release");
assert.equal(previewFixture.state.runtimeCheckCount, 2,
  "runtime bytes must be rebound after the lazy ingest stack is loaded");
assert.deepEqual(previewFixture.state.mutations, []);
assert.equal(preview.publicPlan.read_only, true);
assert.equal(preview.publicPlan.target_count, 1);
assert.equal(preview.publicPlan.boundaries.whole_source_complete, false);
assert.equal(preview.publicPlan.private_retrieval.exact_probe_count, 8,
  "owner approval must disclose the eight private retrieval probes");
assert.equal(preview.publicPlan.private_retrieval.creates_embeddings, true);
assert.equal(
  preview.publicPlan.private_retrieval.creates_ordinary_aggregate_usage_records,
  true,
);
assert.ok(preview.privateContext, "private ephemeral context remains available to the caller");
assert.equal(Object.keys(preview).includes("privateContext"), false,
  "private context is deliberately non-enumerable");

/* A package change during lazy preparation refuses before approval or mutation. */
const changedRuntimeFixture = fixtureDependencies({
  state: { changeRuntimeAfterPrepare: true },
});
await assert.rejects(
  previewProvenanceTargetRepair(invocation(), changedRuntimeFixture.dependencies),
  /candidate runtime does not match/,
);
assert.equal(changedRuntimeFixture.state.runtimeCheckCount, 2);
assert.deepEqual(changedRuntimeFixture.state.mutations, []);
assert.equal(changedRuntimeFixture.state.events[0], "lease.acquire");
assert.equal(changedRuntimeFixture.state.events.at(-1), "lease.release");

const previewJson = JSON.stringify(preview);
for (const privateValue of [
  ROOT,
  MANIFEST_PATH,
  TARGET,
  PRIVATE_CONTENT,
  ORIGINAL_HASH,
  ORIGINAL_ID,
  RUNTIME_FINGERPRINT,
  preview.privateContext.privatePlan.plan_id,
  preview.privateContext.privatePlan.seal.target_set_hash,
]) {
  assert.equal(previewJson.includes(privateValue), false, `preview JSON leaked ${privateValue}`);
}

/* Apply performs the exact reviewed order and validates all four proof calls. */
const applyFixture = fixtureDependencies();
const applied = await applyProvenanceTargetRepair(
  invocation(preview.publicPlan.approval_id),
  applyFixture.dependencies,
);
assert.deepEqual(applyFixture.state.mutations, [
  "discovery.record",
  "ingest.exact",
  "family.reconcile",
  "vectors.drain",
  "result_family.record",
  "result_family.verify",
  "accepted.record",
  "accepted.verify",
]);
assert.equal(applyFixture.state.privateProbeCount, 8);
assert.equal(new Set(applyFixture.state.queryValues).size, 1,
  "every proof stage receives the same deterministic private query");
assert.equal(applied.complete, true);
assert.equal(applied.status, "accepted_resolution_current");
assert.equal(applied.boundaries.whole_source_complete, false);
assert.match(renderProvenanceTargetRepairReceipt(applied), /does not claim the whole source/i);

const appliedJson = JSON.stringify(applied);
for (const privateValue of [
  ROOT, MANIFEST_PATH, TARGET, PRIVATE_CONTENT, ORIGINAL_HASH, ORIGINAL_ID,
  applyFixture.state.queryValues[0], preview.publicPlan.approval_id,
]) {
  assert.equal(appliedJson.includes(privateValue), false, `apply receipt leaked ${privateValue}`);
}

/* Existing accepted history uses a fresh approval and only the four proof calls. */
const acceptedInventory = acceptedObservationInventory();
const reverifyFixture = fixtureDependencies({
  state: {
    observationInventory: acceptedInventory,
    reactivateAccepted: true,
  },
});
const reverifyPreview = await previewProvenanceTargetRepair(
  invocation(),
  reverifyFixture.dependencies,
);
assert.equal(reverifyPreview.publicPlan.workflow, "accepted_resolution_reverification");
assert.equal(reverifyPreview.publicPlan.evidence.accepted_resolution_exists, true);
assert.equal(reverifyPreview.publicPlan.boundaries.may_process_preexisting_vector_backlog, false);
assert.deepEqual(reverifyFixture.state.mutations, []);
const reverified = await applyProvenanceTargetRepair(
  invocation(reverifyPreview.publicPlan.approval_id),
  reverifyFixture.dependencies,
);
assert.deepEqual(reverifyFixture.state.mutations, [
  "result_family.record",
  "result_family.verify",
  "accepted.record",
  "accepted.verify",
]);
assert.equal(reverifyFixture.state.privateProbeCount, 8);
assert.equal(reverified.complete, true);
assert.equal(reverified.workflow, "accepted_resolution_reverification");
assert.equal(reverified.ingest.performed, false);
assert.equal(reverified.reconciliation.performed, false);
assert.equal(reverified.accepted_resolution.reactivated, true);
assert.match(renderProvenanceTargetRepairReceipt(reverified), /without reingest/i);
const reverifiedJson = JSON.stringify(reverified);
for (const privateValue of [
  TARGET,
  PRIVATE_CONTENT,
  ORIGINAL_HASH,
  ORIGINAL_ID,
  acceptedInventory.observations[1].run_id,
  acceptedInventory.observations[1].plan_id,
  acceptedInventory.observations[1].target_set_hash,
  acceptedInventory.observations[1].observation_hash,
  reverifyPreview.publicPlan.approval_id,
]) {
  assert.equal(reverifiedJson.includes(privateValue), false,
    `re-verification receipt leaked ${privateValue}`);
}

/* A changed semantic source inventory makes the prior approval stale before writes. */
const staleFixture = fixtureDependencies();
const stalePreview = await previewProvenanceTargetRepair(invocation(), staleFixture.dependencies);
staleFixture.state.storageCount = 2;
await assert.rejects(
  applyProvenanceTargetRepair(
    invocation(stalePreview.publicPlan.approval_id),
    staleFixture.dependencies,
  ),
  (error) => error instanceof ProvenanceTargetCliError &&
    error.stage === "approval_recheck" && error.receipt.complete === false,
);
assert.deepEqual(staleFixture.state.mutations, []);

/* A family mismatch stops before schema-45 admission and names only the stage. */
const mismatchFixture = fixtureDependencies({ state: { familyMismatch: true } });
const mismatchPreview = await previewProvenanceTargetRepair(invocation(), mismatchFixture.dependencies);
let mismatchError = null;
try {
  await applyProvenanceTargetRepair(
    invocation(mismatchPreview.publicPlan.approval_id),
    mismatchFixture.dependencies,
  );
} catch (error) {
  mismatchError = error;
}
assert.ok(mismatchError instanceof ProvenanceTargetCliError);
assert.equal(mismatchError.stage, "result_family_verify_readback");
assert.equal(mismatchError.receipt.complete, false);
assert.equal(mismatchFixture.state.mutations.includes("accepted.record"), false);
assert.equal(JSON.stringify(mismatchError).includes(TARGET), false);

/* Losing ownership during a mutation yields an honest partial receipt. */
const lostFixture = fixtureDependencies({ state: { loseDuring: "ingest.exact" } });
const lostPreview = await previewProvenanceTargetRepair(invocation(), lostFixture.dependencies);
let lostError = null;
try {
  await applyProvenanceTargetRepair(
    invocation(lostPreview.publicPlan.approval_id),
    lostFixture.dependencies,
  );
} catch (error) {
  lostError = error;
}
assert.ok(lostError instanceof ProvenanceTargetCliError);
assert.equal(lostError.stage, "exact_original_ingest");
assert.equal(lostError.receipt.complete, false);
assert.deepEqual(lostError.receipt.completed_stages, ["discovery_recorded"]);
assert.equal(lostFixture.state.mutations.includes("family.reconcile"), false);

/* Root symlinks fail under the lease before admin or Worker access. */
const symlinkFixture = fixtureDependencies({ state: { rootSymlink: true } });
await assert.rejects(
  previewProvenanceTargetRepair(invocation(), symlinkFixture.dependencies),
  /direct directory/,
);
assert.deepEqual(symlinkFixture.state.mutations, []);
assert.equal(symlinkFixture.state.events[0], "lease.acquire");
assert.equal(symlinkFixture.state.events.at(-1), "lease.release");

/* NTFS device and file IDs remain exact when they exceed JavaScript's safe number range. */
const wideIdentityFixture = fixtureDependencies({
  state: {
    rootDevice: 9_007_199_254_740_993n,
    rootInode: 18_446_744_073_709_551_615n,
  },
});
const wideIdentityPreview = await previewProvenanceTargetRepair(
  invocation(),
  wideIdentityFixture.dependencies,
);
assert.deepEqual(wideIdentityPreview.privateContext.privatePlan.input.rootIdentity, {
  path: ROOT,
  realpath: ROOT,
  device: "9007199254740993",
  inode: "18446744073709551615",
});
assert.deepEqual(wideIdentityFixture.state.mutations, []);
const wideIdentityReceipt = await applyProvenanceTargetRepair(
  invocation(wideIdentityPreview.publicPlan.approval_id),
  wideIdentityFixture.dependencies,
);
assert.equal(wideIdentityReceipt.complete, true);

/* A neighboring wide NTFS file ID invalidates the exact prior approval. */
const changedWideIdentityFixture = fixtureDependencies({
  state: {
    rootDevice: 9_007_199_254_740_993n,
    rootInode: 18_446_744_073_709_551_615n,
  },
});
const changedWideIdentityPreview = await previewProvenanceTargetRepair(
  invocation(),
  changedWideIdentityFixture.dependencies,
);
changedWideIdentityFixture.state.rootInode = 18_446_744_073_709_551_614n;
await assert.rejects(
  applyProvenanceTargetRepair(
    invocation(changedWideIdentityPreview.publicPlan.approval_id),
    changedWideIdentityFixture.dependencies,
  ),
  (error) => error instanceof ProvenanceTargetCliError &&
    error.stage === "approval_recheck" && error.receipt.complete === false,
);
assert.deepEqual(changedWideIdentityFixture.state.mutations, []);

/* Invalid signed or wider-than-NTFS identities fail before any mutation. */
for (const rootInode of [-1n, 18_446_744_073_709_551_616n]) {
  const invalidIdentityFixture = fixtureDependencies({ state: { rootInode } });
  await assert.rejects(
    previewProvenanceTargetRepair(invocation(), invalidIdentityFixture.dependencies),
    /directory inode is unavailable/,
  );
  assert.deepEqual(invalidIdentityFixture.state.mutations, []);
}

console.log("provenance target CLI orchestration tests passed");
