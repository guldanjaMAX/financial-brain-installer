import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { prepare, walk } from "../ingest/run.mjs";
import { RECOVERY_EXPORT_TABLES } from "../operations/cloudflare-recovery-adapter.mjs";
import { collectPrivateLocalProvenanceAssessment } from
  "../operations/provenance-source-assessment.mjs";
import {
  ProvenanceTargetCliError,
  applyProvenanceTargetRepair,
  previewProvenanceTargetRepair,
} from "../operations/provenance-target-cli.mjs";
import {
  formatPrivateProvenanceAcceptedResolutionRequest,
  formatPrivateProvenanceResultFamilyRequest,
  formatPrivateProvenanceTargetDiscoveryRequest,
  validatePrivateProvenanceAcceptedResolutionResponse,
  validatePrivateProvenanceResultFamilyResponse,
} from "../operations/provenance-target-repair.mjs";
import { SOURCE_INVENTORY_PATH } from "../worker/src/lib/source-inventory-api.js";
import { SOURCE_ORIGINAL_OBSERVATION_PATH } from
  "../worker/src/lib/source-original-observation.js";
import { WORKER_VERSION } from "../worker/src/lib/version.js";
import { createProductFixture } from "../worker/test/product-contract-fixture.mjs";

const ADMIN_HEADERS = Object.freeze({ "X-Admin-Key": "fixture-admin-key" });
const SOURCE = "localdocs";
const LOCATOR = "records/synthetic-ledger-note.txt";
const CONTENT = [
  "Synthetic ledger evidence for the owner-controlled integration test.",
  "Quasar ledger reference 7319 proves the exact document is retrievable.",
].join("\n\n");
const RUNTIME_FINGERPRINT = createHash("sha256")
  .update("synthetic-candidate-runtime-package")
  .digest("hex");

const digest = (value) => createHash("sha256").update(String(value)).digest("hex");

async function responseJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    assert.fail(`Worker returned non-JSON: ${text.slice(0, 240)}`);
  }
}

/**
 * Small in-memory Vectorize provider double around the real Worker drain,
 * result-family, retrieval, D1 store, and migration code.
 */
function attachVectorIndex(fixture) {
  const vectors = new Map();
  let mutationSequence = 0;
  let processedMutation = null;

  fixture.env.VECTORIZE = {
    async query() {
      return {
        matches: [...vectors.keys()].sort().map((id, index) => ({
          id,
          score: 0.99 - (index * 0.01),
        })),
      };
    },
    async upsert(rows) {
      mutationSequence += 1;
      const mutationId = `synthetic-mutation-${mutationSequence}`;
      for (const row of rows) {
        vectors.set(row.id, {
          ...row,
          metadata: { ...(row.metadata || {}) },
        });
      }
      processedMutation = mutationId;
      return { mutationId };
    },
    async deleteByIds(ids) {
      mutationSequence += 1;
      const mutationId = `synthetic-mutation-${mutationSequence}`;
      for (const id of ids) vectors.delete(id);
      processedMutation = mutationId;
      return { mutationId };
    },
    async getByIds(ids) {
      return ids.map((id) => vectors.get(id)).filter(Boolean);
    },
    async describe() {
      return {
        vectorCount: vectors.size,
        processedUpToMutation: processedMutation,
      };
    },
  };

  return {
    vectors,
    seedCurrentChunks() {
      const generation = String(fixture.first(
        "SELECT outbox_generation AS value FROM install_state WHERE id=1",
      ).value);
      for (const row of fixture.rows(
        "SELECT chunk_uid,COALESCE(vector_id,chunk_uid) AS vector_id FROM chunks ORDER BY chunk_uid",
      )) {
        vectors.set(row.vector_id, {
          id: row.vector_id,
          values: [0.1, 0.2, 0.3],
          metadata: { outbox_generation: generation },
        });
      }
    },
  };
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

/** Copy only rows that the reviewed recovery allowlist carries. */
function copyPortableTable(source, target, table) {
  assert.equal(
    RECOVERY_EXPORT_TABLES.includes(table),
    true,
    `${table} must be part of the reviewed portable recovery contract`,
  );
  const ordered = [
    "source_original_observations",
    "source_original_result_family_receipts",
    "source_original_accepted_resolutions",
  ].includes(table);
  const rows = source.rows(
    `SELECT * FROM ${quoteIdentifier(table)}${ordered ? " ORDER BY sequence" : ""}`,
  );
  for (const row of rows) {
    const fields = Object.keys(row);
    target.raw(
      `INSERT INTO ${quoteIdentifier(table)} (${fields.map(quoteIdentifier).join(",")}) ` +
        `VALUES (${fields.map(() => "?").join(",")})`,
      ...fields.map((field) => row[field]),
    );
  }
  return rows.length;
}

function currentAcceptedCount(fixture) {
  return Number(fixture.first(
    "SELECT COUNT(*) AS n FROM source_original_current_accepted_resolutions",
  ).n);
}

function localInstall(t, label) {
  const base = mkdtempSync(join(tmpdir(), `brain-target-e2e-${label}-`));
  const root = join(base, "source");
  const manifestPath = join(base, "brain.manifest.json");
  const filePath = join(root, LOCATOR);
  const manifest = {
    brain: { version: WORKER_VERSION, domain: "fixture.invalid" },
    corpora: {
      local_folder: { enabled: true, path: root, source: SOURCE },
    },
    safety: {
      credential_scanner: { enabled: true },
      private_path_prefixes: [],
    },
  };
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, CONTENT, "utf8");
  writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return {
    base,
    root,
    filePath,
    manifestPath,
    invocation: (approvalId = undefined) => ({
      manifestPath,
      source: SOURCE,
      target: LOCATOR,
      productVersion: WORKER_VERSION,
      candidateRuntimePackageFingerprint: RUNTIME_FINGERPRINT,
      ...(approvalId ? { approvalId } : {}),
    }),
  };
}

/**
 * Inject real local preparation and real in-process Worker HTTP boundaries.
 * The only fakes are the source lease coordinator, durable credential handle,
 * and external Vectorize provider. Every private boundary fails unless a lease
 * was already acquired and remains held.
 */
function orchestratorHarness(fixture, install) {
  const state = {
    events: [],
    requests: [],
    stages: [],
    captures: {},
    activeLease: null,
    leaseSequence: 0,
  };
  const leaseFingerprint = digest(`stable-source-lease\0${install.manifestPath}\0${SOURCE}`);

  const event = (name) => state.events.push(name);
  const requireLease = (name) => {
    assert.equal(state.activeLease?.held, true, `${name} ran before source lease acquisition`);
    event(name);
  };
  const requestJson = async ({
    method = "POST",
    path,
    body,
    adminAccess,
    label,
    expectedStatus = 200,
  }) => {
    requireLease(`network.${method.toLowerCase()}:${path}`);
    const headers = {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(adminAccess?.headers || {}),
    };
    state.requests.push({ method, path, body });
    const pending = [];
    const response = await fixture.worker.fetch(
      new Request(`https://brain.invalid${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      fixture.env,
      {
        waitUntil(promise) { pending.push(Promise.resolve(promise)); },
        passThroughOnException() {},
      },
    );
    await Promise.all(pending);
    const value = await responseJson(response);
    state.lastResponse = { label, status: response.status, value };
    if (expectedStatus !== null) {
      assert.equal(response.status, expectedStatus, `${label}: ${JSON.stringify(value)}`);
    }
    return { response, value };
  };

  const dependencies = {
    acquireSourceLease: async ({ manifestPath, source }) => {
      assert.equal(manifestPath, install.manifestPath);
      assert.equal(source, SOURCE);
      assert.equal(state.activeLease, null, "the synthetic source lease cannot overlap itself");
      state.leaseSequence += 1;
      const lease = { id: state.leaseSequence, held: true };
      state.activeLease = lease;
      event("lease.acquire");
      return {
        fingerprint: leaseFingerprint,
        assertOwned: async () => {
          assert.equal(state.activeLease, lease, "a stale lease cannot assert ownership");
          assert.equal(lease.held, true, "a released lease cannot assert ownership");
          event("lease.assert");
        },
        release: async () => {
          assert.equal(state.activeLease, lease, "only the active source lease can release");
          event("lease.release");
          lease.held = false;
          state.activeLease = null;
        },
      };
    },
    verifyCandidateRuntime: async ({
      productVersion,
      candidateRuntimePackageFingerprint,
    }) => {
      requireLease("private.candidate-runtime");
      return {
        verified: true,
        product_version: productVersion,
        package_fingerprint: candidateRuntimePackageFingerprint,
      };
    },
    lstat: async (path) => {
      requireLease("private.file-lstat");
      return lstatSync(path, { bigint: true });
    },
    realpath: async (path) => {
      requireLease("private.file-realpath");
      return realpathSync(path);
    },
    readFile: async (path) => {
      requireLease("private.file-read");
      return readFileSync(path);
    },
    resolveDurableAdminAccess: async () => {
      requireLease("private.admin-capability");
      return Object.freeze({ kind: "fixture-durable-admin", headers: ADMIN_HEADERS });
    },
    readWorkerHealth: async ({ adminAccess }) => {
      const { value } = await requestJson({
        method: "GET",
        path: "/health",
        adminAccess,
        label: "Worker health",
      });
      return {
        ...value,
        active: value.status === "ok" && value.vector_drain_mode === "active",
        product_version: value.version,
      };
    },
    readVectorReadiness: async ({ adminAccess }) => {
      const { value } = await requestJson({
        method: "GET",
        path: "/api/admin/brain/documents",
        adminAccess,
        label: "vector readiness",
      });
      return value.vector_readiness;
    },
    readSourceInventory: async ({ adminAccess }) => {
      const { value } = await requestJson({
        path: SOURCE_INVENTORY_PATH,
        body: { limit: 250 },
        adminAccess,
        label: "complete source inventory",
      });
      return value;
    },
    assessLocalSource: async (input) => {
      requireLease("private.local-assessment");
      return collectPrivateLocalProvenanceAssessment(input);
    },
    prepareOriginal: async ({ root, locator, sourceName, ocr, allowStructuralSplit }) => {
      requireLease("private.original-prepare");
      assert.equal(ocr, null);
      assert.equal(allowStructuralSplit, true);
      const walked = walk(root);
      assert.equal(walked.complete, true);
      const selected = walked.files.filter((file) =>
        file.rel.replaceAll("\\", "/") === locator);
      assert.equal(selected.length, 1, "exact equality walk must resolve one target");
      return prepare(selected[0], { sourceName });
    },
    sealTargets: async ({ request, adminAccess }) => {
      const { value } = await requestJson({
        path: SOURCE_ORIGINAL_OBSERVATION_PATH,
        body: request,
        adminAccess,
        label: "target seal",
      });
      return value;
    },
    readObservationInventory: async ({ source, adminAccess }) => {
      const { value } = await requestJson({
        path: SOURCE_ORIGINAL_OBSERVATION_PATH,
        body: { contract_version: 1, mode: "inventory", source },
        adminAccess,
        label: "complete target history",
      });
      return value;
    },
    recordDiscovery: async ({ request, adminAccess, assertOwned }) => {
      state.stages.push("discovery.record");
      await assertOwned();
      const { value } = await requestJson({
        path: SOURCE_ORIGINAL_OBSERVATION_PATH,
        body: request,
        adminAccess,
        label: "discovery record",
      });
      state.captures.discoveryRequest = request;
      state.captures.discoveryResponse = value;
      return value;
    },
    ingestPrepared: async ({ envelopes, adminAccess, assertOwned }) => {
      state.stages.push("ingest.exact");
      await assertOwned();
      const { value } = await requestJson({
        path: "/api/admin/brain/ingest/batch",
        body: { docs: envelopes },
        adminAccess,
        label: "exact batch ingest",
      });
      state.captures.ingestResponse = value;
      return value;
    },
    reconcileFamily: async ({ family, adminAccess, assertOwned }) => {
      state.stages.push("family.reconcile");
      await assertOwned();
      const { value } = await requestJson({
        path: "/api/admin/brain/forget",
        body: {
          families: [{
            base_doc_uid: family.base_doc_uid,
            keep_doc_uids: [...family.keep_doc_uids],
          }],
          confirm: true,
        },
        adminAccess,
        label: "exact structural-family reconciliation",
      });
      assert.equal(value.dry_run, false);
      state.captures.reconcileResponse = value;
      return {
        complete: true,
        scope: family.scope,
        source: family.source,
        base_doc_uid: family.base_doc_uid,
        keep_doc_uids: [...family.keep_doc_uids],
        removed_count: Number(value.documents),
      };
    },
    drainVectorOutbox: async ({ scope, adminAccess, assertOwned }) => {
      state.stages.push("vectors.drain");
      assert.equal(scope, "global");
      await assertOwned();
      const { value: drain } = await requestJson({
        path: "/api/admin/brain/drain",
        body: {},
        adminAccess,
        label: "global vector drain",
      });
      const { value: documents } = await requestJson({
        method: "GET",
        path: "/api/admin/brain/documents",
        adminAccess,
        label: "post-drain vector readiness",
      });
      state.captures.drainResponse = drain;
      return { complete: drain.remaining === 0, readiness: documents.vector_readiness };
    },
    recordResultFamily: async ({ request, adminAccess, assertOwned }) => {
      state.stages.push("result-family.record");
      await assertOwned();
      const { value } = await requestJson({
        path: SOURCE_ORIGINAL_OBSERVATION_PATH,
        body: request,
        adminAccess,
        label: "schema-44 result-family record",
      });
      state.captures.familyRecordRequest = request;
      state.captures.familyRecordResponse = value;
      return value;
    },
    verifyResultFamily: async ({ request, adminAccess, assertOwned }) => {
      state.stages.push("result-family.verify");
      await assertOwned();
      const { value } = await requestJson({
        path: SOURCE_ORIGINAL_OBSERVATION_PATH,
        body: request,
        adminAccess,
        label: "schema-44 result-family verify",
      });
      state.captures.familyVerifyRequest = request;
      state.captures.familyVerifyResponse = value;
      return value;
    },
    recordAcceptedResolution: async ({ request, adminAccess, assertOwned }) => {
      state.stages.push("accepted-resolution.record");
      await assertOwned();
      const { value } = await requestJson({
        path: SOURCE_ORIGINAL_OBSERVATION_PATH,
        body: request,
        adminAccess,
        label: "schema-45 accepted-resolution record",
      });
      state.captures.acceptedRecordRequest = request;
      state.captures.acceptedRecordResponse = value;
      return value;
    },
    verifyAcceptedResolution: async ({ request, adminAccess, assertOwned }) => {
      state.stages.push("accepted-resolution.verify");
      await assertOwned();
      const { value } = await requestJson({
        path: SOURCE_ORIGINAL_OBSERVATION_PATH,
        body: request,
        adminAccess,
        label: "schema-45 accepted-resolution verify",
      });
      state.captures.acceptedVerifyRequest = request;
      state.captures.acceptedVerifyResponse = value;
      return value;
    },
  };

  const withLease = async (callback) => {
    const lease = await dependencies.acquireSourceLease({
      manifestPath: install.manifestPath,
      source: SOURCE,
    });
    try {
      await lease.assertOwned();
      return await callback({
        assertOwned: lease.assertOwned,
        adminAccess: { kind: "fixture-durable-admin", headers: ADMIN_HEADERS },
      });
    } finally {
      await lease.release();
    }
  };

  return {
    state,
    dependencies,
    withLease,
    requestJson,
    async adminPost(path, body, label, expectedStatus = 200) {
      return withLease(({ adminAccess }) => requestJson({
        path,
        body,
        adminAccess,
        label,
        expectedStatus,
      }));
    },
  };
}

function assertEveryPrivateBoundaryWasLeased(events) {
  let held = false;
  let asserted = false;
  let windows = 0;
  for (const name of events) {
    if (name === "lease.acquire") {
      assert.equal(held, false, "lease windows must not overlap");
      held = true;
      asserted = false;
      windows += 1;
      continue;
    }
    if (name === "lease.assert") {
      assert.equal(held, true, "ownership cannot be asserted before acquisition");
      asserted = true;
      continue;
    }
    if (name === "lease.release") {
      assert.equal(held, true, "only a held lease can be released");
      held = false;
      asserted = false;
      continue;
    }
    if (name.startsWith("private.") || name.startsWith("network.")) {
      assert.equal(held, true, `${name} escaped the source lease`);
      assert.equal(asserted, true, `${name} ran before ownership was asserted`);
    }
  }
  assert.equal(held, false, "the final source lease must be released");
  assert.ok(windows >= 1);
}

function assertNoSourceWideControlMutation(requests) {
  const forbiddenPaths = new Set([
    "/api/admin/brain/source-receipt",
    "/api/admin/brain/source-expectation",
  ]);
  assert.equal(requests.some(({ path }) => forbiddenPaths.has(path)), false);
  for (const request of requests) {
    assert.equal(Object.hasOwn(request.body || {}, "cursor"), false,
      "complete single-page inventories must not write or reuse a cursor");
    if (request.path === "/api/admin/brain/forget") {
      assert.equal(Object.hasOwn(request.body || {}, "source"), false,
        "repair must not invoke whole-source removal");
      assert.equal(Object.hasOwn(request.body || {}, "doc_uids"), false,
        "repair must reconcile through one exact family boundary");
      assert.equal(request.body.families.length, 1);
      assert.equal(request.body.families[0].base_doc_uid, `${SOURCE}:${LOCATOR}`);
    }
  }
}

async function registerSyntheticSource(fixture, harness) {
  fixture.raw(
    "INSERT INTO source_original_id_key_state (tenant_id,signing_salt) VALUES ('primary',?)",
    "a".repeat(64),
  );
  const { value } = await harness.adminPost(
    "/api/admin/brain/source-register",
    { source: SOURCE, kind: "upload" },
    "source registration",
  );
  assert.equal(value.registered, true);
}

test("lease-first target repair crosses native prepare, Worker schema 44/45, replay, stale proof, and recovery", async (t) => {
  const sourceBrain = await createProductFixture();
  const recoveredBrain = await createProductFixture();
  const install = localInstall(t, "full");
  const sourceVectors = attachVectorIndex(sourceBrain);
  const sourceHarness = orchestratorHarness(sourceBrain, install);
  t.after(() => {
    sourceBrain.close();
    recoveredBrain.close();
  });

  assert.match(sourceBrain.migrationFiles.at(-1), /^0046_/);
  assert.match(recoveredBrain.migrationFiles.at(-1), /^0046_/);
  assert.equal(RECOVERY_EXPORT_TABLES.includes("source_original_result_family_receipts"), true);
  assert.equal(RECOVERY_EXPORT_TABLES.includes("source_original_accepted_resolutions"), true);
  assert.equal(RECOVERY_EXPORT_TABLES.includes("source_original_result_family_verifications"), false);
  assert.equal(RECOVERY_EXPORT_TABLES.includes("source_original_accepted_resolution_activations"), false);
  assert.equal(RECOVERY_EXPORT_TABLES.includes("source_original_accepted_resolution_admissions"), false);

  await registerSyntheticSource(sourceBrain, sourceHarness);

  const previewStart = sourceHarness.state.events.length;
  const preview = await previewProvenanceTargetRepair(
    install.invocation(),
    sourceHarness.dependencies,
  );
  const previewEvents = sourceHarness.state.events.slice(previewStart);
  assert.equal(previewEvents[0], "lease.acquire");
  assert.equal(previewEvents.at(-1), "lease.release");
  assert.equal(preview.publicPlan.can_apply, true);
  assert.equal(preview.publicPlan.approval_ready, true);
  assert.equal(preview.publicPlan.read_only, true);
  assert.equal(preview.publicPlan.target_count, 1);
  assert.equal(preview.publicPlan.boundaries.whole_source_complete, false);
  assert.deepEqual(sourceHarness.state.stages, [], "preview must not invoke executor writes");
  const serializedPreview = JSON.stringify(preview);
  for (const privateValue of [
    install.root,
    install.manifestPath,
    install.filePath,
    LOCATOR,
    CONTENT,
    digest(CONTENT),
    preview.privateContext.privatePlan.seal.original_id,
  ]) {
    assert.equal(serializedPreview.includes(privateValue), false, "public preview leaked private target data");
  }

  let applyReceipt;
  try {
    applyReceipt = await applyProvenanceTargetRepair(
      install.invocation(preview.publicPlan.approval_id),
      sourceHarness.dependencies,
    );
  } catch (error) {
    assert.fail(JSON.stringify({
      stage: error?.stage,
      privateCause: error?.privateCause?.message,
      lastResponse: sourceHarness.state.lastResponse,
    }));
  }
  assert.deepEqual(sourceHarness.state.stages, [
    "discovery.record",
    "ingest.exact",
    "family.reconcile",
    "vectors.drain",
    "result-family.record",
    "result-family.verify",
    "accepted-resolution.record",
    "accepted-resolution.verify",
  ]);
  assert.equal(applyReceipt.complete, true);
  assert.equal(applyReceipt.status, "accepted_resolution_current");
  assert.equal(applyReceipt.boundaries.whole_source_complete, false);
  assert.equal(applyReceipt.reconciliation.removed_count, 0);
  assertEveryPrivateBoundaryWasLeased(sourceHarness.state.events);
  assertNoSourceWideControlMutation(sourceHarness.state.requests);

  const storedBinding = sourceBrain.first(
    `SELECT b.original_content_sha256,b.original_byte_count,d.document_revision_id,
            d.source_original_binding_hash,d.text_source,d.text_reliable
       FROM source_original_result_bindings b
       JOIN documents d ON d.document_revision_id=b.document_revision_id`,
  );
  assert.equal(sourceBrain.first("SELECT COUNT(*) AS n FROM source_original_result_bindings").n, 1);
  assert.equal(storedBinding.original_content_sha256, digest(CONTENT));
  assert.equal(Number(storedBinding.original_byte_count), Buffer.byteLength(CONTENT));
  assert.match(storedBinding.document_revision_id, /^rev-v1:[a-f0-9]{64}$/);
  assert.match(storedBinding.source_original_binding_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(storedBinding.text_source, "native");
  assert.equal(Number(storedBinding.text_reliable), 1);
  assert.equal(sourceBrain.first("SELECT COUNT(*) AS n FROM vector_outbox").n, 0);
  assert.equal(sourceVectors.vectors.size, 1);

  const plan = preview.privateContext.privatePlan;
  const captured = sourceHarness.state.captures;
  assert.equal(captured.familyRecordResponse.recorded, true);
  assert.equal(captured.familyVerifyResponse.replayed, true);
  assert.equal(captured.acceptedRecordResponse.accepted_outcome_authorized, true);
  assert.equal(captured.acceptedVerifyResponse.status, "accepted_resolution_current");
  assert.equal(currentAcceptedCount(sourceBrain), 1);
  const initialFamilyRecordResponse = captured.familyRecordResponse;
  const initialAcceptedRecordResponse = captured.acceptedRecordResponse;

  const acceptedHistory = (await sourceHarness.adminPost(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    { contract_version: 1, mode: "inventory", source: SOURCE },
    "complete accepted-observation history readback",
  )).value;
  assert.equal(acceptedHistory.page_complete, true);
  assert.equal(acceptedHistory.next_after_sequence, null);
  assert.equal(acceptedHistory.total, 2);
  const discoveryObservation = captured.discoveryResponse.observations[0];
  const acceptedObservation = acceptedHistory.observations.find((row) =>
    row.outcome === "accepted");
  assert.ok(acceptedObservation, "complete history must contain the accepted repair observation");
  assert.equal(acceptedObservation.original_id, discoveryObservation.original_id);
  assert.equal(acceptedObservation.original_content_sha256, digest(CONTENT));
  assert.equal(acceptedObservation.resolves_observation_hash, discoveryObservation.observation_hash);
  assert.equal(
    acceptedObservation.observation_hash,
    captured.acceptedRecordResponse.accepted_observation_hash,
  );
  assert.notEqual(acceptedObservation.observation_hash, discoveryObservation.observation_hash,
    "the accepted observation is new evidence that resolves, rather than replaces, the gap");

  const validatedFamily = validatePrivateProvenanceResultFamilyResponse(
    plan,
    captured.familyVerifyResponse,
    {
      operation: "verify",
      approvalId: preview.publicPlan.approval_id,
      recordReceipt: captured.familyRecordResponse,
    },
  );
  validatePrivateProvenanceAcceptedResolutionResponse(
    plan,
    captured.acceptedVerifyResponse,
    {
      operation: "verify",
      approvalId: preview.publicPlan.approval_id,
      discoveryReceipt: captured.discoveryResponse,
      resultFamilyRecordReceipt: captured.familyRecordResponse,
      resultFamilyVerifyReceipt: validatedFamily,
      recordReceipt: captured.acceptedRecordResponse,
    },
  );
  assert.throws(() => validatePrivateProvenanceResultFamilyResponse(
    plan,
    { ...captured.familyVerifyResponse, family_receipt_hash: `sha256:${"0".repeat(64)}` },
    {
      operation: "verify",
      approvalId: preview.publicPlan.approval_id,
      recordReceipt: captured.familyRecordResponse,
    },
  ), /changed from the exact record readback/);

  const { response: mismatchResponse, value: mismatch } = await sourceHarness.adminPost(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    { ...captured.familyVerifyRequest, original_content_sha256: "0".repeat(64) },
    "mismatched raw-original proof refusal",
    null,
  );
  assert.equal(mismatchResponse.status, 409, JSON.stringify(mismatch));
  assert.equal(mismatch.code, "source_original_result_family_binding_mismatch");

  const replayFamilyRecord = (await sourceHarness.adminPost(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    captured.familyRecordRequest,
    "result-family record replay",
  )).value;
  const replayFamilyVerify = (await sourceHarness.adminPost(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    captured.familyVerifyRequest,
    "result-family verify replay",
  )).value;
  const replayAcceptedRecord = (await sourceHarness.adminPost(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    captured.acceptedRecordRequest,
    "accepted-resolution record replay",
  )).value;
  const replayAcceptedVerify = (await sourceHarness.adminPost(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    captured.acceptedVerifyRequest,
    "accepted-resolution verify replay",
  )).value;
  assert.equal(replayFamilyRecord.replayed, true);
  assert.equal(replayFamilyVerify.replayed, true);
  assert.equal(replayAcceptedRecord.replayed, true);
  assert.equal(replayAcceptedVerify.replayed, true);
  assert.equal(currentAcceptedCount(sourceBrain), 1);

  await sourceHarness.adminPost(
    "/api/admin/brain/source-register",
    { source: "otherdocs", kind: "upload" },
    "retrieval-generation mutation",
  );
  assert.equal(currentAcceptedCount(sourceBrain), 0);
  const { response: staleResponse, value: stale } = await sourceHarness.adminPost(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    captured.acceptedVerifyRequest,
    "stale accepted-resolution refusal",
    null,
  );
  assert.equal(staleResponse.status, 409, JSON.stringify(stale));
  assert.equal(stale.code, "source_original_accepted_resolution_reverification_required");

  const refreshStageStart = sourceHarness.state.stages.length;
  const refreshPreview = await previewProvenanceTargetRepair(
    install.invocation(),
    sourceHarness.dependencies,
  );
  assert.equal(refreshPreview.publicPlan.workflow, "accepted_resolution_reverification");
  assert.equal(refreshPreview.publicPlan.evidence.accepted_resolution_exists, true);
  assert.equal(refreshPreview.publicPlan.boundaries.may_process_preexisting_vector_backlog, false);
  const refreshReceipt = await applyProvenanceTargetRepair(
    install.invocation(refreshPreview.publicPlan.approval_id),
    sourceHarness.dependencies,
  );
  assert.deepEqual(sourceHarness.state.stages.slice(refreshStageStart), [
    "result-family.record",
    "result-family.verify",
    "accepted-resolution.record",
    "accepted-resolution.verify",
  ]);
  assert.equal(refreshReceipt.workflow, "accepted_resolution_reverification");
  assert.equal(refreshReceipt.ingest.performed, false);
  assert.equal(refreshReceipt.reconciliation.performed, false);
  assert.equal(refreshReceipt.accepted_resolution.reactivated, true);
  const refreshedFamilyRecord = captured.familyRecordResponse;
  const refreshedFamilyVerify = captured.familyVerifyResponse;
  const refreshedAccepted = captured.acceptedRecordResponse;
  const refreshedAcceptedVerifyRequest = captured.acceptedVerifyRequest;
  assert.notEqual(
    refreshedFamilyRecord.verification_hash,
    initialFamilyRecordResponse.verification_hash,
  );
  assert.equal(refreshedAccepted.reactivated, true);
  assert.equal(refreshedAccepted.resolution_hash, initialAcceptedRecordResponse.resolution_hash);
  assert.equal(captured.acceptedVerifyResponse.status, "accepted_resolution_current");
  assert.equal(currentAcceptedCount(sourceBrain), 1);
  assertEveryPrivateBoundaryWasLeased(sourceHarness.state.events);
  assertNoSourceWideControlMutation(sourceHarness.state.requests);

  recoveredBrain.raw(
    `INSERT INTO source_original_result_family_recovery_state (id,mode)
     VALUES (1,'verified_recovery_import')`,
  );
  const portableTables = [
    "source_original_id_key_state",
    "sources",
    "source_original_result_bindings",
    "documents",
    "chunks",
    "source_original_observations",
    "source_original_result_family_members",
    "source_original_result_family_receipts",
    "source_original_accepted_resolutions",
  ];
  const copied = Object.fromEntries(portableTables.map((table) => [
    table,
    copyPortableTable(sourceBrain, recoveredBrain, table),
  ]));
  assert.equal(copied.source_original_result_family_receipts, 1);
  assert.equal(copied.source_original_accepted_resolutions, 1);
  recoveredBrain.raw(
    `DELETE FROM source_original_result_family_recovery_state
      WHERE id=1 AND mode='verified_recovery_import'`,
  );
  assert.equal(recoveredBrain.first(
    "SELECT COUNT(*) AS n FROM source_original_result_family_recovery_state",
  ).n, 0);
  assert.equal(recoveredBrain.first(
    "SELECT COUNT(*) AS n FROM source_original_result_family_verifications",
  ).n, 0);
  assert.equal(recoveredBrain.first(
    "SELECT COUNT(*) AS n FROM source_original_accepted_resolution_activations",
  ).n, 0);
  assert.equal(recoveredBrain.first(
    "SELECT COUNT(*) AS n FROM source_original_accepted_resolution_admissions",
  ).n, 0);
  assert.equal(currentAcceptedCount(recoveredBrain), 0);

  const recoveredVectors = attachVectorIndex(recoveredBrain);
  recoveredVectors.seedCurrentChunks();
  assert.equal(recoveredVectors.vectors.size, 1);
  const recoveredHarness = orchestratorHarness(recoveredBrain, install);

  const { response: recoveredVerifyResponse, value: recoveredVerify } =
    await recoveredHarness.adminPost(
      SOURCE_ORIGINAL_OBSERVATION_PATH,
      refreshedAcceptedVerifyRequest,
      "post-recovery accepted-resolution refusal",
      null,
    );
  assert.equal(recoveredVerifyResponse.status, 409, JSON.stringify(recoveredVerify));
  assert.equal(
    recoveredVerify.code,
    "source_original_accepted_resolution_reverification_required",
  );

  const missingLocalFamilyRequest = formatPrivateProvenanceResultFamilyRequest(plan, {
    operation: "verify",
    approvalId: preview.publicPlan.approval_id,
  });
  const { response: missingLocalFamilyResponse, value: missingLocalFamily } =
    await recoveredHarness.adminPost(
      SOURCE_ORIGINAL_OBSERVATION_PATH,
      missingLocalFamilyRequest,
      "post-recovery deployment-local result-family refusal",
      null,
    );
  assert.equal(missingLocalFamilyResponse.status, 409, JSON.stringify(missingLocalFamily));
  assert.equal(missingLocalFamily.code, "source_original_result_family_receipt_missing");

  const recoveredPreview = await previewProvenanceTargetRepair(
    install.invocation(),
    recoveredHarness.dependencies,
  );
  assert.equal(recoveredPreview.publicPlan.workflow, "accepted_resolution_reverification");
  assert.equal(recoveredPreview.publicPlan.evidence.accepted_resolution_exists, true);
  const recoveredReceipt = await applyProvenanceTargetRepair(
    install.invocation(recoveredPreview.publicPlan.approval_id),
    recoveredHarness.dependencies,
  );
  assert.deepEqual(recoveredHarness.state.stages, [
    "result-family.record",
    "result-family.verify",
    "accepted-resolution.record",
    "accepted-resolution.verify",
  ]);
  assert.equal(recoveredReceipt.workflow, "accepted_resolution_reverification");
  assert.equal(recoveredReceipt.ingest.performed, false);
  assert.equal(recoveredReceipt.reconciliation.performed, false);
  assert.equal(recoveredReceipt.accepted_resolution.reactivated, true);
  const recoveredFamilyRecord = recoveredHarness.state.captures.familyRecordResponse;
  const recoveredFamilyVerify = recoveredHarness.state.captures.familyVerifyResponse;
  assert.equal(recoveredFamilyRecord.family_receipt_hash, refreshedFamilyRecord.family_receipt_hash);
  assert.notEqual(recoveredFamilyRecord.verification_hash, refreshedFamilyRecord.verification_hash);
  const recoveredAccepted = recoveredHarness.state.captures.acceptedRecordResponse;
  const finalVerify = recoveredHarness.state.captures.acceptedVerifyResponse;
  assert.equal(recoveredAccepted.reactivated, true);
  assert.equal(recoveredAccepted.resolution_hash, refreshedAccepted.resolution_hash);
  assert.equal(recoveredAccepted.verification_hash, recoveredFamilyRecord.verification_hash);
  assert.equal(finalVerify.status, "accepted_resolution_current");
  assert.equal(finalVerify.resolution_hash, recoveredAccepted.resolution_hash);
  assert.equal(currentAcceptedCount(recoveredBrain), 1);
  assertEveryPrivateBoundaryWasLeased(recoveredHarness.state.events);
  assertNoSourceWideControlMutation(recoveredHarness.state.requests);
});

test("lost accepted-resolution response is safely recovered through a fresh CLI approval", async (t) => {
  const brain = await createProductFixture();
  const install = localInstall(t, "lost-response");
  attachVectorIndex(brain);
  const harness = orchestratorHarness(brain, install);
  t.after(() => brain.close());
  await registerSyntheticSource(brain, harness);

  const preview = await previewProvenanceTargetRepair(
    install.invocation(),
    harness.dependencies,
  );
  let loseOnce = true;
  const lossyDependencies = {
    ...harness.dependencies,
    recordAcceptedResolution: async (payload) => {
      const response = await harness.dependencies.recordAcceptedResolution(payload);
      if (loseOnce) {
        loseOnce = false;
        throw new Error("synthetic accepted-resolution response lost after commit");
      }
      return response;
    },
  };
  await assert.rejects(
    applyProvenanceTargetRepair(
      install.invocation(preview.publicPlan.approval_id),
      lossyDependencies,
    ),
    (error) => error instanceof ProvenanceTargetCliError &&
      error.stage === "accepted_resolution_record" && error.receipt.complete === false,
  );
  assert.equal(currentAcceptedCount(brain), 1,
    "the committed accepted resolution survives the lost response");
  assert.equal(brain.first(
    "SELECT COUNT(*) AS n FROM source_original_observations",
  ).n, 2);

  const retryStageStart = harness.state.stages.length;
  const retryPreview = await previewProvenanceTargetRepair(
    install.invocation(),
    harness.dependencies,
  );
  assert.equal(retryPreview.publicPlan.workflow, "accepted_resolution_reverification");
  assert.equal(retryPreview.publicPlan.evidence.accepted_resolution_exists, true);
  const retried = await applyProvenanceTargetRepair(
    install.invocation(retryPreview.publicPlan.approval_id),
    harness.dependencies,
  );
  assert.deepEqual(harness.state.stages.slice(retryStageStart), [
    "result-family.record",
    "result-family.verify",
    "accepted-resolution.record",
    "accepted-resolution.verify",
  ]);
  assert.equal(retried.complete, true);
  assert.equal(retried.workflow, "accepted_resolution_reverification");
  assert.equal(retried.ingest.performed, false);
  assert.equal(retried.reconciliation.performed, false);
  assert.equal(retried.accepted_resolution.current, true);
  assert.equal(brain.first(
    "SELECT COUNT(*) AS n FROM source_original_observations",
  ).n, 2, "retry must not duplicate discovery or accepted history");
  assert.equal(currentAcceptedCount(brain), 1);
  assertEveryPrivateBoundaryWasLeased(harness.state.events);
  assertNoSourceWideControlMutation(harness.state.requests);
});

test("authenticated complete-history recheck refuses a stale approval without duplicating a gap", async (t) => {
  const brain = await createProductFixture();
  const install = localInstall(t, "history");
  attachVectorIndex(brain);
  const harness = orchestratorHarness(brain, install);
  t.after(() => brain.close());
  await registerSyntheticSource(brain, harness);

  const firstPreview = await previewProvenanceTargetRepair(
    install.invocation(),
    harness.dependencies,
  );
  const externalGapRequest = formatPrivateProvenanceTargetDiscoveryRequest(
    firstPreview.privateContext.privatePlan,
    { approvalId: firstPreview.publicPlan.approval_id },
  );
  const externalGap = (await harness.adminPost(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    externalGapRequest,
    "concurrent same-target discovery gap",
  )).value;
  assert.equal(externalGap.observations.length, 1);
  assert.equal(brain.first(
    "SELECT COUNT(*) AS n FROM source_original_observations WHERE outcome='gap'",
  ).n, 1);

  await assert.rejects(
    applyProvenanceTargetRepair(
      install.invocation(firstPreview.publicPlan.approval_id),
      harness.dependencies,
    ),
    (error) => error instanceof ProvenanceTargetCliError &&
      error.stage === "approval_recheck" && error.receipt.complete === false,
  );
  assert.deepEqual(harness.state.stages, [],
    "authenticated history recheck must stop before every executor mutation");
  assert.equal(brain.first(
    "SELECT COUNT(*) AS n FROM source_original_observations WHERE outcome='gap'",
  ).n, 1, "the stale approval must not create a duplicate gap");

  const currentPreview = await previewProvenanceTargetRepair(
    install.invocation(),
    harness.dependencies,
  );
  assert.notEqual(currentPreview.publicPlan.approval_id, firstPreview.publicPlan.approval_id);
  assert.equal(currentPreview.privateContext.privatePlan.input.discoveryRequired, false);
  assert.equal(currentPreview.privateContext.privatePlan.input.history.unresolved_gap_count, 1);
  const repaired = await applyProvenanceTargetRepair(
    install.invocation(currentPreview.publicPlan.approval_id),
    harness.dependencies,
  );
  assert.equal(repaired.complete, true);
  assert.equal(harness.state.stages.includes("discovery.record"), false,
    "the authenticated existing gap must be reused rather than duplicated");
  assert.deepEqual(harness.state.stages, [
    "ingest.exact",
    "family.reconcile",
    "vectors.drain",
    "result-family.record",
    "result-family.verify",
    "accepted-resolution.record",
    "accepted-resolution.verify",
  ]);
  assert.equal(brain.first(
    "SELECT COUNT(*) AS n FROM source_original_observations WHERE outcome='gap'",
  ).n, 1);
  assert.equal(currentAcceptedCount(brain), 1);
  assertEveryPrivateBoundaryWasLeased(harness.state.events);
  assertNoSourceWideControlMutation(harness.state.requests);
});

test("two machines approved over the same empty head cannot create concurrent immutable chains", async (t) => {
  const brain = await createProductFixture();
  const installA = localInstall(t, "machine-a");
  const installB = localInstall(t, "machine-b");
  attachVectorIndex(brain);
  const harnessA = orchestratorHarness(brain, installA);
  const harnessB = orchestratorHarness(brain, installB);
  t.after(() => brain.close());
  await registerSyntheticSource(brain, harnessA);

  const previewA = await previewProvenanceTargetRepair(
    installA.invocation(),
    harnessA.dependencies,
  );
  const previewB = await previewProvenanceTargetRepair(
    installB.invocation(),
    harnessB.dependencies,
  );
  assert.notEqual(previewA.publicPlan.approval_id, previewB.publicPlan.approval_id);
  assert.equal(previewA.privateContext.privatePlan.input.discoveryRequired, true);
  assert.equal(previewB.privateContext.privatePlan.input.discoveryRequired, true);

  let winnerReceipt = null;
  const racingDependencies = {
    ...harnessB.dependencies,
    recordDiscovery: async (payload) => {
      harnessB.state.stages.push("discovery.record");
      winnerReceipt = await applyProvenanceTargetRepair(
        installA.invocation(previewA.publicPlan.approval_id),
        harnessA.dependencies,
      );
      await payload.assertOwned();
      const { response, value } = await harnessB.requestJson({
        path: SOURCE_ORIGINAL_OBSERVATION_PATH,
        body: payload.request,
        adminAccess: payload.adminAccess,
        label: "serialized losing discovery",
        expectedStatus: null,
      });
      if (!response.ok) {
        const error = new Error(`discovery was refused (${value?.code || "request_refused"})`);
        error.code = value?.code;
        throw error;
      }
      return value;
    },
  };
  let losingError = null;
  await assert.rejects(
    applyProvenanceTargetRepair(
      installB.invocation(previewB.publicPlan.approval_id),
      racingDependencies,
    ),
    (error) => {
      losingError = error;
      return error instanceof ProvenanceTargetCliError &&
        error.stage === "discovery_record" &&
        error.privateCause?.code === "source_original_observation_history_advanced" &&
        error.receipt.complete === false;
    },
  );
  assert.equal(winnerReceipt?.complete, true);
  assert.deepEqual(harnessB.state.stages, ["discovery.record"],
    "the losing machine stops before ingest, reconciliation, drain, or proof writes");
  assert.deepEqual({
    gaps: brain.first(
      "SELECT COUNT(*) AS n FROM source_original_observations WHERE outcome='gap'",
    ).n,
    accepted: brain.first(
      "SELECT COUNT(*) AS n FROM source_original_observations WHERE outcome='accepted'",
    ).n,
    resolutions: brain.first(
      "SELECT COUNT(*) AS n FROM source_original_accepted_resolutions",
    ).n,
    current: currentAcceptedCount(brain),
  }, { gaps: 1, accepted: 1, resolutions: 1, current: 1 });
  const publicFailure = JSON.stringify(losingError);
  for (const privateValue of [LOCATOR, CONTENT, installA.root, installB.root]) {
    assert.equal(publicFailure.includes(privateValue), false);
  }

  const retryStageStart = harnessB.state.stages.length;
  const retryPreview = await previewProvenanceTargetRepair(
    installB.invocation(),
    harnessB.dependencies,
  );
  assert.equal(retryPreview.publicPlan.workflow, "accepted_resolution_reverification");
  const retried = await applyProvenanceTargetRepair(
    installB.invocation(retryPreview.publicPlan.approval_id),
    harnessB.dependencies,
  );
  assert.equal(retried.complete, true);
  assert.equal(retried.ingest.performed, false);
  assert.equal(retried.reconciliation.performed, false);
  assert.deepEqual(harnessB.state.stages.slice(retryStageStart), [
    "result-family.record",
    "result-family.verify",
    "accepted-resolution.record",
    "accepted-resolution.verify",
  ]);
  assert.deepEqual({
    gaps: brain.first(
      "SELECT COUNT(*) AS n FROM source_original_observations WHERE outcome='gap'",
    ).n,
    accepted: brain.first(
      "SELECT COUNT(*) AS n FROM source_original_observations WHERE outcome='accepted'",
    ).n,
    resolutions: brain.first(
      "SELECT COUNT(*) AS n FROM source_original_accepted_resolutions",
    ).n,
    current: currentAcceptedCount(brain),
  }, { gaps: 1, accepted: 1, resolutions: 1, current: 1 });
});

test("a newer adjudicated exclusion demotes acceptance across CLI replay and recovery", async (t) => {
  const brain = await createProductFixture();
  const recoveredBrain = await createProductFixture();
  const install = localInstall(t, "exclusion");
  attachVectorIndex(brain);
  const harness = orchestratorHarness(brain, install);
  t.after(() => {
    brain.close();
    recoveredBrain.close();
  });
  await registerSyntheticSource(brain, harness);
  const preview = await previewProvenanceTargetRepair(
    install.invocation(),
    harness.dependencies,
  );
  const acceptedReceipt = await applyProvenanceTargetRepair(
    install.invocation(preview.publicPlan.approval_id),
    harness.dependencies,
  );
  assert.equal(acceptedReceipt.complete, true);
  const captured = harness.state.captures;
  const acceptedHash = captured.acceptedRecordResponse.accepted_observation_hash;

  const exclusionPlanId = "9".repeat(64);
  const exclusionSnapshotId = `sha256:${"8".repeat(64)}`;
  const exclusionSeal = (await harness.adminPost(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    {
      contract_version: 1,
      mode: "seal",
      source: SOURCE,
      plan_id: exclusionPlanId,
      source_snapshot_id: exclusionSnapshotId,
      targets: [{ locator_kind: "source_relative_path", locator: LOCATOR }],
    },
    "exclusion target seal",
  )).value;
  const exclusionRequest = {
    contract_version: 1,
    mode: "record",
    source: SOURCE,
    run_id: "owner_adjudicated_exclusion",
    plan_id: exclusionPlanId,
    source_snapshot_id: exclusionSnapshotId,
    target_set_hash: exclusionSeal.target_set_hash,
    targets: [{
      locator_kind: "source_relative_path",
      locator: LOCATOR,
      original_id: exclusionSeal.targets[0].original_id,
      observation_stage: "repair",
      outcome: "adjudicated_exclusion",
      reason_code: "source_policy_excluded",
      text_state: "unsupported",
      original_content_sha256: digest(CONTENT),
      original_byte_count: Buffer.byteLength(CONTENT),
      page_count: null,
      page_count_state: "not_applicable",
      resolves_observation_hash: null,
      predecessor_observation_hash: acceptedHash,
    }],
  };
  const exclusion = (await harness.adminPost(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    exclusionRequest,
    "newer owner exclusion",
  )).value;
  assert.equal(exclusion.observations[0].outcome, "adjudicated_exclusion");
  assert.equal(exclusion.observations[0].predecessor_observation_hash, acceptedHash);
  assert.equal(currentAcceptedCount(brain), 0);

  const countsBeforeReplay = {
    observations: brain.first("SELECT COUNT(*) AS n FROM source_original_observations").n,
    resolutions: brain.first("SELECT COUNT(*) AS n FROM source_original_accepted_resolutions").n,
    activations: brain.first(
      "SELECT COUNT(*) AS n FROM source_original_accepted_resolution_activations",
    ).n,
  };
  for (const [label, request] of [
    ["record", captured.acceptedRecordRequest],
    ["verify", captured.acceptedVerifyRequest],
  ]) {
    const { response, value } = await harness.adminPost(
      SOURCE_ORIGINAL_OBSERVATION_PATH,
      request,
      `superseded accepted-resolution ${label}`,
      null,
    );
    assert.equal(response.status, 409, JSON.stringify(value));
    assert.equal(value.code, "source_original_accepted_resolution_history_advanced");
    assert.equal(JSON.stringify(value).includes(LOCATOR), false);
    assert.equal(JSON.stringify(value).includes(CONTENT), false);
  }
  assert.deepEqual({
    observations: brain.first("SELECT COUNT(*) AS n FROM source_original_observations").n,
    resolutions: brain.first("SELECT COUNT(*) AS n FROM source_original_accepted_resolutions").n,
    activations: brain.first(
      "SELECT COUNT(*) AS n FROM source_original_accepted_resolution_activations",
    ).n,
  }, countsBeforeReplay, "superseded replay must create no observation, verification, or activation");

  const stagesBeforePreview = harness.state.stages.length;
  await assert.rejects(
    previewProvenanceTargetRepair(install.invocation(), harness.dependencies),
    (error) => /history|accepted target/.test(String(error?.message || "")) &&
      !String(error?.message || "").includes(LOCATOR) &&
      !String(error?.message || "").includes(CONTENT),
  );
  assert.equal(harness.state.stages.length, stagesBeforePreview,
    "the public CLI refuses superseded history before any executor mutation");

  recoveredBrain.raw(
    `INSERT INTO source_original_result_family_recovery_state (id,mode)
     VALUES (1,'verified_recovery_import')`,
  );
  for (const table of [
    "source_original_id_key_state",
    "sources",
    "source_original_result_bindings",
    "documents",
    "chunks",
    "source_original_observations",
    "source_original_result_family_members",
    "source_original_result_family_receipts",
    "source_original_accepted_resolutions",
  ]) copyPortableTable(brain, recoveredBrain, table);
  recoveredBrain.raw(
    `DELETE FROM source_original_result_family_recovery_state
      WHERE id=1 AND mode='verified_recovery_import'`,
  );
  assert.equal(currentAcceptedCount(recoveredBrain), 0);
  assert.equal(recoveredBrain.first(
    "SELECT COUNT(*) AS n FROM source_original_observations",
  ).n, 3);

  const recoveredVectors = attachVectorIndex(recoveredBrain);
  recoveredVectors.seedCurrentChunks();
  const recoveredHarness = orchestratorHarness(recoveredBrain, install);
  const { response: recoveredResponse, value: recoveredValue } =
    await recoveredHarness.adminPost(
      SOURCE_ORIGINAL_OBSERVATION_PATH,
      captured.acceptedRecordRequest,
      "recovered superseded accepted-resolution refusal",
      null,
    );
  assert.equal(recoveredResponse.status, 409, JSON.stringify(recoveredValue));
  assert.equal(
    recoveredValue.code,
    "source_original_accepted_resolution_history_advanced",
  );
  assert.equal(currentAcceptedCount(recoveredBrain), 0);
});
