import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  PROVENANCE_TARGET_REPAIR_AUTHENTICATED_CHECK_ORDER,
  authorizePrivateProvenanceTargetRepair,
  bindPrivateProvenanceTargetRepairSeal,
  formatPrivateProvenanceAcceptedResolutionRequest,
  formatPrivateProvenanceResultFamilyRequest,
  formatPrivateProvenanceTargetDiscoveryRequest,
  formatPrivateProvenanceTargetSealRequest,
  preparePrivateProvenanceTargetRepair,
  publicProvenanceTargetRepairPlan,
  selectPrivateProvenanceTargetDiscoveryReceipt,
} from "../../operations/provenance-target-repair.mjs";
import { createProductFixture } from "./product-contract-fixture.mjs";
import { hashSourceOriginalResultBinding } from "../src/lib/source-original-binding.js";
import { sourceOriginalChunkReceiptHash } from "../src/lib/source-original-chunk.js";
import { SOURCE_ORIGINAL_OBSERVATION_PATH } from "../src/lib/source-original-observation.js";
import { verifySourceOriginalAcceptedResolution } from "../src/lib/source-original-accepted-resolution.js";
import {
  normalizeIngestEnvelopeProvenance,
  provenanceAssessmentMarker,
} from "../src/lib/provenance-receipt.js";

const ADMIN = { "X-Admin-Key": "fixture-admin-key" };
const SOURCE = "localdocs";
const LOCATOR = "proofs/opaque-source-9381.pdf";
const QUERY = "cobalt canary retrieval phrase 9381";
const TITLE = "Synthetic accepted-resolution evidence";
const CHUNK_TEXT = `[${TITLE}]\n\nThe cobalt canary retrieval phrase 9381 is present.`;
const CHUNK_UID = "accepted-resolution-chunk";
const VECTOR_ID = CHUNK_UID;
const CONTENT_SHA = "3".repeat(64);
const DOCUMENT_HASH = "4".repeat(64);
const REVISION_ID = `rev-v1:${"6".repeat(64)}`;
const PLAN_ID = "1".repeat(64);
const SNAPSHOT_ID = `sha256:${"2".repeat(64)}`;
const ORIGINAL_BYTES = 9876;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (value) => createHash("sha256").update(canonical(value)).digest("hex");

async function body(response) {
  assert.match(response.headers.get("cache-control") || "", /private, no-store/);
  return response.json();
}

function sealRequest(targets = [{ locator_kind: "source_relative_path", locator: LOCATOR }]) {
  return {
    contract_version: 1,
    mode: "seal",
    source: SOURCE,
    plan_id: PLAN_ID,
    source_snapshot_id: SNAPSHOT_ID,
    targets,
  };
}

function acceptedTarget(originalId, resolvesObservationHash, patch = {}) {
  return {
    locator_kind: "source_relative_path",
    locator: LOCATOR,
    original_id: originalId,
    text_state: "native_readable",
    original_content_sha256: CONTENT_SHA,
    original_byte_count: ORIGINAL_BYTES,
    page_count: 1,
    page_count_state: "authoritative",
    resolves_observation_hash: resolvesObservationHash,
    ...patch,
  };
}

function acceptedRequest(state, operation) {
  return {
    contract_version: 1,
    mode: "accepted_resolution",
    operation: operation || "record",
    source: SOURCE,
    run_id: "accepted_resolution_run",
    plan_id: PLAN_ID,
    source_snapshot_id: SNAPSHOT_ID,
    target_set_hash: state.targetSetHash,
    targets: [acceptedTarget(state.originalId, state.gapHash)],
    retrieval_query: QUERY,
  };
}

function resultFamilyRequest(operation) {
  return {
    contract_version: 1,
    mode: "result_family",
    ...(operation ? { operation } : {}),
    source: SOURCE,
    locator_kind: "source_relative_path",
    locator: LOCATOR,
    original_content_sha256: CONTENT_SHA,
    original_byte_count: ORIGINAL_BYTES,
    retrieval_query: QUERY,
  };
}

async function seedPriorGap(fixture) {
  fixture.raw(
    "INSERT INTO sources (name,kind,status,created_at) VALUES (?,?,?,?)",
    SOURCE, "upload", "ready", "2026-09-11T00:00:00Z",
  );
  fixture.raw(
    "INSERT INTO source_original_id_key_state (tenant_id,signing_salt) VALUES ('primary',?)",
    "a".repeat(64),
  );

  const sealResponse = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, sealRequest(), ADMIN);
  const seal = await body(sealResponse);
  assert.equal(sealResponse.status, 200, JSON.stringify(seal));
  const originalId = seal.targets[0].original_id;
  const gapRequest = {
    ...sealRequest(),
    mode: "record",
    run_id: "accepted_resolution_prior_gap",
    target_set_hash: seal.target_set_hash,
    targets: [{
      ...acceptedTarget(originalId, null),
      observation_stage: "discovery",
      outcome: "gap",
      reason_code: "provenance_unassessed",
      predecessor_observation_hash: null,
    }],
  };
  const gapResponse = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, gapRequest, ADMIN);
  const gap = await body(gapResponse);
  assert.equal(gapResponse.status, 200, JSON.stringify(gap));
  assert.equal(gap.observations[0].outcome, "gap");
  assert.equal(gap.observations[0].result_document_count, 0);
  return {
    originalId,
    targetSetHash: seal.target_set_hash,
    gapHash: gap.observations[0].observation_hash,
  };
}

async function seedBoundAcceptedFamily(fixture, originalId) {
  const envelope = normalizeIngestEnvelopeProvenance({
    source_type: SOURCE,
    source_id: LOCATOR,
    content: CHUNK_TEXT,
    text_source: "native",
    text_reliable: true,
    metadata: {
      evidence_lineage: {
        version: 1,
        kind: "source_record",
        root_ids: [`${SOURCE}:${LOCATOR}`],
      },
    },
  });
  const marker = await provenanceAssessmentMarker(envelope);
  const bindingReceipt = {
    contract_version: 1,
    tenant_id: "primary",
    source: SOURCE,
    original_id: originalId,
    locator_kind: "source_relative_path",
    document_revision_id: REVISION_ID,
    original_content_sha256: CONTENT_SHA,
    original_byte_count: ORIGINAL_BYTES,
    document_content_hash: DOCUMENT_HASH,
    provenance_receipt_digest: marker.provenance_receipt_digest,
  };
  const bindingHash = await hashSourceOriginalResultBinding(bindingReceipt);
  fixture.raw(
    `INSERT INTO source_original_result_bindings
       (contract_version,tenant_id,source,original_id,locator_kind,document_revision_id,
        original_content_sha256,original_byte_count,document_content_hash,
        provenance_receipt_digest,binding_hash,bound_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    bindingReceipt.contract_version,
    bindingReceipt.tenant_id,
    bindingReceipt.source,
    bindingReceipt.original_id,
    bindingReceipt.locator_kind,
    bindingReceipt.document_revision_id,
    bindingReceipt.original_content_sha256,
    bindingReceipt.original_byte_count,
    bindingReceipt.document_content_hash,
    bindingReceipt.provenance_receipt_digest,
    bindingHash,
    2,
  );
  fixture.raw(
    `INSERT INTO documents
       (doc_uid,source,source_id,title,ingested_at,content_hash,meta,text_source,text_reliable,
        provenance_receipt_version,provenance_receipt_status,provenance_receipt_reason,
        provenance_receipt_digest,document_revision_id,source_original_binding_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    `${SOURCE}:${LOCATOR}`,
    SOURCE,
    LOCATOR,
    TITLE,
    2,
    DOCUMENT_HASH,
    JSON.stringify(envelope.metadata),
    "native",
    1,
    marker.provenance_receipt_version,
    marker.provenance_receipt_status,
    marker.provenance_receipt_reason,
    marker.provenance_receipt_digest,
    REVISION_ID,
    bindingHash,
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
    CHUNK_UID,
    `${SOURCE}:${LOCATOR}`,
    0,
    CHUNK_TEXT,
    SOURCE,
    TITLE,
    VECTOR_ID,
    REVISION_ID,
    chunkReceiptHash,
  );
  fixture.env.VECTORIZE.describe = async () => ({ vectorCount: 1, processedUpToMutation: null });
  fixture.env.VECTORIZE.query = async (_embedding, options) => {
    fixture.seen.vectorQueries.push(options);
    return { matches: [{ id: VECTOR_ID, score: 0.99 }] };
  };
}

function seedNonFamilyResult(fixture) {
  fixture.raw(
    "INSERT INTO sources (name,kind,status,created_at) VALUES (?,?,?,?)",
    "otherdocs", "drive", "ready", "2026-09-11T00:00:00Z",
  );
  fixture.raw(
    `INSERT INTO documents
       (doc_uid,source,source_id,title,uri,ingested_at,content_hash,meta,text_source,text_reliable)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    "otherdocs:lower", "otherdocs", "lower", "Lower ranked result",
    "https://example.invalid/lower", 3, "other-document-hash", "{}", "native", 1,
  );
  fixture.raw(
    `INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source,title,vector_id)
     VALUES (?,?,?,?,?,?,?)`,
    "otherdocs:lower#0", "otherdocs:lower", 0, "Lower ranked result body.",
    "otherdocs", "Lower ranked result", "otherdocs:lower#0",
  );
}

async function readyState(fixture, { recordFamily = true } = {}) {
  const state = await seedPriorGap(fixture);
  await seedBoundAcceptedFamily(fixture, state.originalId);
  if (recordFamily) {
    const familyResponse = await fixture.post(
      SOURCE_ORIGINAL_OBSERVATION_PATH,
      resultFamilyRequest(),
      ADMIN,
    );
    const family = await body(familyResponse);
    assert.equal(familyResponse.status, 200, JSON.stringify(family));
    assert.equal(family.accepted_outcome_authorized, false);
    assert.equal(family.recorded, true);
    state.familyReceiptHash = family.family_receipt_hash;
    state.verificationHash = family.verification_hash;
  }
  return state;
}

function acceptedCounts(fixture) {
  return {
    admissions: Number(fixture.first(
      "SELECT COUNT(*) AS n FROM source_original_accepted_resolution_admissions",
    ).n),
    resolutions: Number(fixture.first(
      "SELECT COUNT(*) AS n FROM source_original_accepted_resolutions",
    ).n),
    activations: Number(fixture.first(
      "SELECT COUNT(*) AS n FROM source_original_accepted_resolution_activations",
    ).n),
    current: Number(fixture.first(
      "SELECT COUNT(*) AS n FROM source_original_current_accepted_resolutions",
    ).n),
    observations: Number(fixture.first(
      "SELECT COUNT(*) AS n FROM source_original_observations",
    ).n),
  };
}

test("accepted_resolution is admin-only, one-target-only, and unavailable through normal record", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  const state = await seedPriorGap(fixture);
  const request = acceptedRequest(state);

  const unauthorized = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, request);
  assert.equal(unauthorized.status, 401);
  assert.equal((await body(unauthorized)).code, "admin_required");

  const { operation: _omittedOperation, ...implicitMutationRequest } = request;
  const implicitMutationResponse = await fixture.post(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    implicitMutationRequest,
    ADMIN,
  );
  const implicitMutation = await body(implicitMutationResponse);
  assert.equal(implicitMutationResponse.status, 400, JSON.stringify(implicitMutation));
  assert.equal(implicitMutation.code, "source_original_accepted_resolution_invalid_request");

  for (const targets of [[], [request.targets[0], request.targets[0]]]) {
    const invalidResponse = await fixture.post(
      SOURCE_ORIGINAL_OBSERVATION_PATH,
      { ...request, targets },
      ADMIN,
    );
    const invalid = await body(invalidResponse);
    assert.equal(invalidResponse.status, 400, JSON.stringify(invalid));
    assert.equal(invalid.code, "source_original_accepted_resolution_target_count");
  }

  const normalRecordResponse = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, {
    ...sealRequest(),
    mode: "record",
    run_id: request.run_id,
    target_set_hash: state.targetSetHash,
    targets: [{
      ...request.targets[0],
      observation_stage: "repair",
      outcome: "accepted",
      reason_code: "accepted_provenance_verified",
      predecessor_observation_hash: state.gapHash,
    }],
  }, ADMIN);
  const normalRecord = await body(normalRecordResponse);
  assert.equal(normalRecordResponse.status, 409, JSON.stringify(normalRecord));
  assert.equal(normalRecord.code, "source_original_acceptance_chain_unavailable");
  assert.deepEqual(acceptedCounts(fixture), {
    admissions: 0,
    resolutions: 0,
    activations: 0,
    current: 0,
    observations: 1,
  });
});

test("accepted_resolution atomically records, exactly replays, verifies, and retains no private payload", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  const state = await readyState(fixture);
  const request = acceptedRequest(state);

  const firstResponse = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, request, ADMIN);
  const first = await body(firstResponse);
  assert.equal(firstResponse.status, 200, JSON.stringify(first));
  assert.equal(first.mode, "accepted_resolution");
  assert.equal(first.operation, "record");
  assert.equal(first.original_id, state.originalId);
  assert.equal(first.resolves_observation_hash, state.gapHash);
  assert.equal(first.family_receipt_hash, state.familyReceiptHash);
  assert.equal(first.verification_hash, state.verificationHash);
  assert.equal(first.accepted_outcome_authorized, true);
  assert.equal(first.bounded_target_set_repair_verified, true);
  assert.equal(first.scope.whole_source_complete, false);
  assert.equal(first.scope.accepted_outcomes_supported, true);
  assert.equal(first.scope.repair_verification_supported, true);
  assert.equal(first.scope.accepted_resolution_mode, "one_exact_current_result_family");
  assert.equal(first.status, "accepted_resolution_current");
  assert.equal(first.recorded, true);
  assert.equal(first.replayed, false);
  assert.match(first.resolution_hash, /^sha256:[a-f0-9]{64}$/);
  assert.match(first.activation_hash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(acceptedCounts(fixture), {
    admissions: 0,
    resolutions: 1,
    activations: 1,
    current: 1,
    observations: 2,
  });

  const durable = JSON.stringify({
    admissions: fixture.rows("SELECT * FROM source_original_accepted_resolution_admissions"),
    resolutions: fixture.rows("SELECT * FROM source_original_accepted_resolutions"),
    activations: fixture.rows("SELECT * FROM source_original_accepted_resolution_activations"),
  });
  const responseText = JSON.stringify(first);
  for (const privateValue of [LOCATOR, QUERY, TITLE, CHUNK_TEXT, CHUNK_UID]) {
    assert.equal(durable.includes(privateValue), false);
    assert.equal(responseText.includes(privateValue), false);
  }

  const replayResponse = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, request, ADMIN);
  const replay = await body(replayResponse);
  assert.equal(replayResponse.status, 200, JSON.stringify(replay));
  assert.equal(replay.resolution_hash, first.resolution_hash);
  assert.equal(replay.activation_hash, first.activation_hash);
  assert.equal(replay.resolves_observation_hash, state.gapHash);
  assert.equal(replay.recorded, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(acceptedCounts(fixture), {
    admissions: 0,
    resolutions: 1,
    activations: 1,
    current: 1,
    observations: 2,
  });

  const verifyResponse = await fixture.post(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    acceptedRequest(state, "verify"),
    ADMIN,
  );
  const verified = await body(verifyResponse);
  assert.equal(verifyResponse.status, 200, JSON.stringify(verified));
  assert.equal(verified.operation, "verify");
  assert.equal(verified.resolves_observation_hash, state.gapHash);
  assert.equal(verified.status, "accepted_resolution_current");
  assert.equal(verified.accepted_outcome_authorized, true);
  assert.equal(verified.bounded_target_set_repair_verified, true);
  assert.deepEqual(acceptedCounts(fixture), {
    admissions: 0,
    resolutions: 1,
    activations: 1,
    current: 1,
    observations: 2,
  });
});

test("a same-timestamp admission loser is reported as replayed, not newly recorded", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  const state = await readyState(fixture);
  const actualBatch = fixture.env.DB.batch.bind(fixture.env.DB);
  let injectedWinner = false;
  fixture.env.DB.batch = async (statements) => {
    const admission = statements.find((statement) =>
      /INSERT INTO source_original_accepted_resolution_admissions/.test(statement.sql)
    );
    if (admission && !injectedWinner) {
      injectedWinner = true;
      fixture.raw(admission.sql, ...(admission.params || []));
    }
    return actualBatch(statements);
  };

  const response = await fixture.post(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    acceptedRequest(state),
    ADMIN,
  );
  const result = await body(response);
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(injectedWinner, true);
  assert.equal(result.recorded, false);
  assert.equal(result.replayed, true);
  assert.equal(result.reactivated, false);
  assert.equal(result.resolves_observation_hash, state.gapHash);
  assert.match(result.resolution_hash, /^sha256:[a-f0-9]{64}$/);
  assert.match(result.activation_hash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(acceptedCounts(fixture), {
    admissions: 0,
    resolutions: 1,
    activations: 1,
    current: 1,
    observations: 2,
  });
});

test("a stale requested activation is not made current by a newer exact activation", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  const state = await readyState(fixture);
  const acceptedResponse = await fixture.post(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    acceptedRequest(state),
    ADMIN,
  );
  const accepted = await body(acceptedResponse);
  assert.equal(acceptedResponse.status, 200, JSON.stringify(accepted));

  const staleProof = {
    familyReceipt: fixture.first(
      "SELECT * FROM source_original_result_family_receipts WHERE family_receipt_hash=?",
      accepted.family_receipt_hash,
    ),
    members: fixture.rows(
      `SELECT * FROM source_original_result_family_members
        WHERE family_receipt_hash=? ORDER BY document_revision_id,chunk_ix`,
      accepted.family_receipt_hash,
    ),
    verification: fixture.first(
      "SELECT * FROM source_original_result_family_verifications WHERE verification_hash=?",
      accepted.verification_hash,
    ),
  };
  const observation = fixture.first(
    "SELECT * FROM source_original_observations WHERE observation_hash=?",
    accepted.accepted_observation_hash,
  );

  fixture.raw("UPDATE install_state SET outbox_generation=outbox_generation+1 WHERE id=1");
  const reactivatedResponse = await fixture.post(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    acceptedRequest(state),
    ADMIN,
  );
  const reactivated = await body(reactivatedResponse);
  assert.equal(reactivatedResponse.status, 200, JSON.stringify(reactivated));
  assert.equal(reactivated.resolves_observation_hash, state.gapHash);
  assert.notEqual(reactivated.verification_hash, accepted.verification_hash);
  assert.equal(fixture.first(
    "SELECT COUNT(*) AS n FROM source_original_accepted_resolution_activations",
  ).n, 2);
  assert.equal(fixture.first(
    `SELECT COUNT(*) AS n
       FROM source_original_current_result_family_verifications
      WHERE verification_hash=?`,
    accepted.verification_hash,
  ).n, 0, "the first deployment receipt is stale");
  assert.equal(fixture.first(
    `SELECT COUNT(*) AS n
       FROM source_original_current_result_family_verifications
      WHERE verification_hash=?`,
    reactivated.verification_hash,
  ).n, 1, "the replacement deployment receipt is current");

  const countsBefore = acceptedCounts(fixture);
  await assert.rejects(
    verifySourceOriginalAcceptedResolution(fixture.env, {
      observation,
      proof: staleProof,
    }),
    (error) => {
      assert.equal(error.code, "source_original_accepted_resolution_reverification_required");
      return true;
    },
  );
  assert.deepEqual(
    acceptedCounts(fixture),
    countsBefore,
    "checking the stale activation remains write-free",
  );
});

test("a shape-valid but noncanonical activation hash cannot authorize current acceptance", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  const state = await readyState(fixture);
  const acceptedResponse = await fixture.post(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    acceptedRequest(state),
    ADMIN,
  );
  const accepted = await body(acceptedResponse);
  assert.equal(acceptedResponse.status, 200, JSON.stringify(accepted));

  fixture.raw("DROP TRIGGER source_original_accepted_resolution_activation_no_update");
  fixture.raw(
    "UPDATE source_original_accepted_resolution_activations SET activation_hash=? WHERE resolution_hash=?",
    `sha256:${"e".repeat(64)}`,
    accepted.resolution_hash,
  );

  const verifyResponse = await fixture.post(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    acceptedRequest(state, "verify"),
    ADMIN,
  );
  const verified = await body(verifyResponse);
  assert.equal(verifyResponse.status, 503, JSON.stringify(verified));
  assert.equal(verified.code, "source_original_accepted_resolution_corrupt");
  assert.equal(acceptedCounts(fixture).current, 1,
    "relational currentness alone cannot make a noncanonical activation hash authoritative");
});

test("accepted_resolution verify fails for stale family, outbox, and deployment proof", async (t) => {
  await t.test("family member deleted", async (t) => {
    const fixture = await createProductFixture();
    t.after(() => fixture.close());
    const state = await readyState(fixture);
    const acceptedResponse = await fixture.post(
      SOURCE_ORIGINAL_OBSERVATION_PATH,
      acceptedRequest(state),
      ADMIN,
    );
    assert.equal(acceptedResponse.status, 200, JSON.stringify(await body(acceptedResponse)));

    fixture.raw("DELETE FROM chunks WHERE chunk_uid=?", CHUNK_UID);
    const verifyResponse = await fixture.post(
      SOURCE_ORIGINAL_OBSERVATION_PATH,
      acceptedRequest(state, "verify"),
      ADMIN,
    );
    const verify = await body(verifyResponse);
    assert.equal(verifyResponse.status, 409, JSON.stringify(verify));
    assert.equal(verify.code, "source_original_outcome_unobserved");
    assert.equal(acceptedCounts(fixture).current, 0);
  });

  await t.test("outbox is nonempty", async (t) => {
    const fixture = await createProductFixture();
    t.after(() => fixture.close());
    const state = await readyState(fixture);
    const acceptedResponse = await fixture.post(
      SOURCE_ORIGINAL_OBSERVATION_PATH,
      acceptedRequest(state),
      ADMIN,
    );
    assert.equal(acceptedResponse.status, 200, JSON.stringify(await body(acceptedResponse)));

    fixture.raw(
      "INSERT INTO vector_outbox (chunk_uid,vector_id,op,queued_at) VALUES (?,?, 'upsert',?)",
      CHUNK_UID,
      VECTOR_ID,
      10,
    );
    const verifyResponse = await fixture.post(
      SOURCE_ORIGINAL_OBSERVATION_PATH,
      acceptedRequest(state, "verify"),
      ADMIN,
    );
    const verify = await body(verifyResponse);
    assert.equal(verifyResponse.status, 409, JSON.stringify(verify));
    assert.equal(verify.code, "source_original_result_family_retrieval_unready");
    assert.equal(acceptedCounts(fixture).current, 0);
  });

  await t.test("deployment receipt changed", async (t) => {
    const fixture = await createProductFixture();
    t.after(() => fixture.close());
    const state = await readyState(fixture);
    const acceptedResponse = await fixture.post(
      SOURCE_ORIGINAL_OBSERVATION_PATH,
      acceptedRequest(state),
      ADMIN,
    );
    assert.equal(acceptedResponse.status, 200, JSON.stringify(await body(acceptedResponse)));

    fixture.raw("UPDATE install_state SET outbox_generation=outbox_generation+1 WHERE id=1");
    const verifyResponse = await fixture.post(
      SOURCE_ORIGINAL_OBSERVATION_PATH,
      acceptedRequest(state, "verify"),
      ADMIN,
    );
    const verify = await body(verifyResponse);
    assert.equal(verifyResponse.status, 409, JSON.stringify(verify));
    assert.equal(verify.code, "source_original_accepted_resolution_reverification_required");
    assert.equal(fixture.first(
      "SELECT COUNT(*) AS n FROM source_original_result_family_verifications",
    ).n, 1);
    assert.equal(acceptedCounts(fixture).current, 0);
  });
});

test("a failed multi-statement admission batch leaves no partial acceptance or verification", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  const state = await readyState(fixture);

  fixture.raw("DROP TRIGGER source_original_result_family_verification_no_delete");
  fixture.raw("DELETE FROM source_original_result_family_verifications");
  fixture.control.failOn = /^\s*INSERT INTO source_original_accepted_resolution_admissions/;

  const response = await fixture.post(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    acceptedRequest(state),
    ADMIN,
  );
  const failed = await body(response);
  assert.equal(response.status, 503, JSON.stringify(failed));
  assert.equal(failed.code, "source_original_accepted_resolution_record_unavailable");
  assert.equal(fixture.first(
    "SELECT COUNT(*) AS n FROM source_original_result_family_verifications",
  ).n, 0, "verification inserted earlier in the D1 batch must roll back");
  assert.deepEqual(acceptedCounts(fixture), {
    admissions: 0,
    resolutions: 0,
    activations: 0,
    current: 0,
    observations: 1,
  });
});

test("document provenance cannot change between the final snapshot and admission", async (t) => {
  await t.test("the sealed-document guard rejects the concurrent low-level mutation", async (t) => {
    const fixture = await createProductFixture();
    t.after(() => fixture.close());
    const state = await readyState(fixture);
    const actualBatch = fixture.env.DB.batch.bind(fixture.env.DB);
    let mutationAttempted = false;
    let mutationRejected = false;
    fixture.env.DB.batch = async (statements) => {
      if (!mutationAttempted && statements.some((statement) =>
        /INSERT INTO source_original_accepted_resolution_admissions/.test(statement.sql))) {
        mutationAttempted = true;
        try {
          fixture.raw(
            `UPDATE documents
                SET provenance_receipt_status='partial',
                    provenance_receipt_reason='text_provenance_unavailable'
              WHERE doc_uid=?`,
            `${SOURCE}:${LOCATOR}`,
          );
        } catch (error) {
          mutationRejected = /sealed source-original document evidence cannot be revised or revived/
            .test(String(error?.message || error));
        }
      }
      return actualBatch(statements);
    };

    const response = await fixture.post(
      SOURCE_ORIGINAL_OBSERVATION_PATH,
      acceptedRequest(state),
      ADMIN,
    );
    const accepted = await body(response);
    assert.equal(response.status, 200, JSON.stringify(accepted));
    assert.equal(mutationAttempted, true);
    assert.equal(mutationRejected, true);
    assert.equal(fixture.first(
      "SELECT provenance_receipt_status FROM documents WHERE doc_uid=?",
      `${SOURCE}:${LOCATOR}`,
    ).provenance_receipt_status, "complete");
    assert.equal(acceptedCounts(fixture).current, 1);
  });

  await t.test("the admission trigger fails closed even if the write guard is absent", async (t) => {
    const fixture = await createProductFixture();
    t.after(() => fixture.close());
    const state = await readyState(fixture);
    fixture.raw("DROP TRIGGER documents_source_original_sealed_evidence_no_revival_update");
    const actualBatch = fixture.env.DB.batch.bind(fixture.env.DB);
    let mutationApplied = false;
    fixture.env.DB.batch = async (statements) => {
      if (!mutationApplied && statements.some((statement) =>
        /INSERT INTO source_original_accepted_resolution_admissions/.test(statement.sql))) {
        fixture.raw(
          `UPDATE documents
              SET provenance_receipt_status='partial',
                  provenance_receipt_reason='text_provenance_unavailable'
            WHERE doc_uid=?`,
          `${SOURCE}:${LOCATOR}`,
        );
        mutationApplied = true;
      }
      return actualBatch(statements);
    };

    const response = await fixture.post(
      SOURCE_ORIGINAL_OBSERVATION_PATH,
      acceptedRequest(state),
      ADMIN,
    );
    const failed = await body(response);
    assert.equal(response.status, 503, JSON.stringify(failed));
    assert.equal(failed.code, "source_original_accepted_resolution_record_unavailable");
    assert.equal(mutationApplied, true);
    assert.deepEqual(acceptedCounts(fixture), {
      admissions: 0,
      resolutions: 0,
      activations: 0,
      current: 0,
      observations: 1,
    });
  });
});

test("retrieval-visible document and chunk projections cannot race accepted admission", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  const state = await readyState(fixture);
  const actualBatch = fixture.env.DB.batch.bind(fixture.env.DB);
  let documentMutationRejected = false;
  let chunkMutationRejected = false;
  fixture.env.DB.batch = async (statements) => {
    if (statements.some((statement) =>
      /INSERT INTO source_original_accepted_resolution_admissions/.test(statement.sql))) {
      try {
        fixture.raw(
          "UPDATE documents SET uri='https://example.invalid/changed' WHERE doc_uid=?",
          `${SOURCE}:${LOCATOR}`,
        );
      } catch (error) {
        documentMutationRejected = /sealed source-original document evidence cannot be revised or revived/
          .test(String(error?.message || error));
      }
      try {
        fixture.raw(
          "UPDATE chunks SET client='changed-client' WHERE chunk_uid=?",
          CHUNK_UID,
        );
      } catch (error) {
        chunkMutationRejected = /sealed source-original chunk receipt cannot be revived/
          .test(String(error?.message || error));
      }
    }
    return actualBatch(statements);
  };

  const response = await fixture.post(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    acceptedRequest(state),
    ADMIN,
  );
  const accepted = await body(response);
  assert.equal(response.status, 200, JSON.stringify(accepted));
  assert.equal(documentMutationRejected, true);
  assert.equal(chunkMutationRejected, true);
  assert.equal(fixture.first(
    "SELECT uri FROM documents WHERE doc_uid=?",
    `${SOURCE}:${LOCATOR}`,
  ).uri, null);
  assert.equal(fixture.first(
    "SELECT client FROM chunks WHERE chunk_uid=?",
    CHUNK_UID,
  ).client, null);
  assert.equal(acceptedCounts(fixture).current, 1);
});

test("a lower-ranked non-family mutation demotes accepted authority until fresh proof", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  const state = await seedPriorGap(fixture);
  await seedBoundAcceptedFamily(fixture, state.originalId);
  seedNonFamilyResult(fixture);
  fixture.env.VECTORIZE.describe = async () => ({ vectorCount: 2, processedUpToMutation: null });

  const familyResponse = await fixture.post(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    resultFamilyRequest(),
    ADMIN,
  );
  const family = await body(familyResponse);
  assert.equal(familyResponse.status, 200, JSON.stringify(family));
  state.familyReceiptHash = family.family_receipt_hash;
  state.verificationHash = family.verification_hash;

  const acceptedResponse = await fixture.post(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    acceptedRequest(state),
    ADMIN,
  );
  const accepted = await body(acceptedResponse);
  assert.equal(acceptedResponse.status, 200, JSON.stringify(accepted));
  assert.equal(acceptedCounts(fixture).current, 1);
  const before = fixture.first(
    `SELECT source_original_retrieval_generation AS generation,
            outbox_generation,
            (SELECT count(*) FROM chunks) AS chunk_count
       FROM install_state WHERE id=1`,
  );

  fixture.raw(
    "UPDATE documents SET uri=? WHERE doc_uid='otherdocs:lower'",
    "https://example.invalid/lower-changed",
  );
  const after = fixture.first(
    `SELECT source_original_retrieval_generation AS generation,
            outbox_generation,
            (SELECT count(*) FROM chunks) AS chunk_count
       FROM install_state WHERE id=1`,
  );
  assert.equal(after.generation, before.generation + 1);
  assert.equal(after.outbox_generation, before.outbox_generation);
  assert.equal(after.chunk_count, before.chunk_count);
  assert.equal(acceptedCounts(fixture).current, 0);

  const verifyResponse = await fixture.post(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    acceptedRequest(state, "verify"),
    ADMIN,
  );
  const verify = await body(verifyResponse);
  assert.equal(verifyResponse.status, 409, JSON.stringify(verify));
  assert.equal(verify.code, "source_original_accepted_resolution_reverification_required");
  assert.equal(fixture.first(
    "SELECT COUNT(*) AS n FROM source_original_result_family_verifications",
  ).n, 1, "verification remains write-free until record explicitly creates a fresh local cut");
});

test("portable accepted history requires a fresh local record after verification and activation loss", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  const state = await readyState(fixture);
  const initialResponse = await fixture.post(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    acceptedRequest(state),
    ADMIN,
  );
  const initial = await body(initialResponse);
  assert.equal(initialResponse.status, 200, JSON.stringify(initial));
  assert.equal(initial.resolves_observation_hash, state.gapHash);

  // A recovery artifact preserves the portable observation, family receipt,
  // and resolution, but deliberately excludes these deployment-local rows.
  fixture.raw("DROP TRIGGER source_original_accepted_resolution_activation_no_delete");
  fixture.raw("DROP TRIGGER source_original_result_family_verification_no_delete");
  fixture.raw("DELETE FROM source_original_accepted_resolution_activations");
  fixture.raw("DELETE FROM source_original_result_family_verifications");
  assert.deepEqual(acceptedCounts(fixture), {
    admissions: 0,
    resolutions: 1,
    activations: 0,
    current: 0,
    observations: 2,
  });

  const verifyResponse = await fixture.post(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    acceptedRequest(state, "verify"),
    ADMIN,
  );
  const verify = await body(verifyResponse);
  assert.equal(verifyResponse.status, 409, JSON.stringify(verify));
  assert.equal(verify.code, "source_original_accepted_resolution_reverification_required");
  assert.equal(fixture.first(
    "SELECT COUNT(*) AS n FROM source_original_result_family_verifications",
  ).n, 0, "verify cannot recreate deployment-local authority");

  const reactivateResponse = await fixture.post(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    acceptedRequest(state),
    ADMIN,
  );
  const reactivated = await body(reactivateResponse);
  assert.equal(reactivateResponse.status, 200, JSON.stringify(reactivated));
  assert.equal(reactivated.status, "accepted_resolution_current");
  assert.equal(reactivated.resolves_observation_hash, state.gapHash);
  assert.equal(reactivated.reactivated, true);
  assert.equal(reactivated.resolution_hash, initial.resolution_hash);
  assert.equal(fixture.first(
    "SELECT COUNT(*) AS n FROM source_original_result_family_verifications",
  ).n, 1);
  assert.deepEqual(acceptedCounts(fixture), {
    admissions: 0,
    resolutions: 1,
    activations: 1,
    current: 1,
    observations: 2,
  });

  const finalVerifyResponse = await fixture.post(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    acceptedRequest(state, "verify"),
    ADMIN,
  );
  const finalVerify = await body(finalVerifyResponse);
  assert.equal(finalVerifyResponse.status, 200, JSON.stringify(finalVerify));
  assert.equal(finalVerify.status, "accepted_resolution_current");
  assert.equal(finalVerify.resolves_observation_hash, state.gapHash);
});

test("one-target repair contract rehearses schema-44 admission and recovery end to end", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  fixture.raw(
    "INSERT INTO sources (name,kind,status,created_at) VALUES (?,?,?,?)",
    SOURCE, "upload", "ready", "2026-09-11T00:00:00Z",
  );
  fixture.raw(
    "INSERT INTO source_original_id_key_state (tenant_id,signing_salt) VALUES ('primary',?)",
    "a".repeat(64),
  );

  const draft = preparePrivateProvenanceTargetRepair({
    productVersion: "0.4.8",
    candidateRuntimePackageFingerprint: "6".repeat(64),
    manifestFingerprint: "7".repeat(64),
    sourceConfigFingerprint: "8".repeat(64),
    rootIdentity: {
      path: "/synthetic/private/source",
      realpath: "/synthetic/private/source",
      device: 41,
      inode: 73,
    },
    source: { id: SOURCE, kind: "upload", registered: true },
    sourceSnapshotId: SNAPSHOT_ID,
    locator: LOCATOR,
    original: {
      original_content_sha256: CONTENT_SHA,
      original_byte_count: ORIGINAL_BYTES,
      text_state: "native_readable",
      text_reliable: true,
      extraction_complete: true,
      page_count: 1,
      page_count_state: "authoritative",
      multi_record: false,
    },
    priorGap: null,
    priorAccepted: null,
    discoveryRequired: true,
    history: {
      checked: true,
      conflict: false,
      accepted_resolution_exists: false,
      unresolved_gap_count: 0,
    },
    retrievalQuery: QUERY,
    ocr: { enabled: false, attempted: false },
  });
  const sealResponse = await fixture.post(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    formatPrivateProvenanceTargetSealRequest(draft),
    ADMIN,
  );
  const seal = await body(sealResponse);
  assert.equal(sealResponse.status, 200, JSON.stringify(seal));
  assert.equal(seal.scope.whole_source_complete, false);

  const designPlan = bindPrivateProvenanceTargetRepairSeal(draft, seal);
  const privatePlan = authorizePrivateProvenanceTargetRepair(designPlan, {
    authority: "owner_admin_authenticated_orchestrator",
    check_order: [...PROVENANCE_TARGET_REPAIR_AUTHENTICATED_CHECK_ORDER],
    source_lease: {
      source: SOURCE,
      acquired: true,
      held: true,
      before_private_access: true,
      before_network_access: true,
      before_state_access: true,
      lease_fingerprint: "9".repeat(64),
    },
    authenticated_inventory: {
      authenticated: true,
      complete: true,
      truncated: false,
      source_snapshot_id: SNAPSHOT_ID,
      source: { id: SOURCE, kind: "upload", registered: true },
      target_original_id: seal.targets[0].original_id,
      target_set_hash: seal.target_set_hash,
      history_complete: true,
      history_conflict: false,
      accepted_resolution_exists: false,
      unresolved_gap_count: 0,
      prior_observation_hash: null,
      accepted_observation_hash: null,
    },
    local_readback: {
      candidate_runtime_package_fingerprint: draft.input.candidateRuntimePackageFingerprint,
      manifest_fingerprint: draft.input.manifestFingerprint,
      source_config_fingerprint: draft.input.sourceConfigFingerprint,
      root_identity_fingerprint: sha256(draft.input.rootIdentity),
      original_content_sha256: CONTENT_SHA,
      original_byte_count: ORIGINAL_BYTES,
      text_state: "native_readable",
      page_count: 1,
      page_count_state: "authoritative",
      ocr_enabled: false,
    },
  });
  const publicPlan = publicProvenanceTargetRepairPlan(privatePlan);
  assert.deepEqual(publicPlan.ocr, { enabled: false, attempted: false });
  assert.equal(publicPlan.target_count, 1);
  assert.equal(publicPlan.boundaries.whole_source_complete, false);
  const approvalId = publicPlan.approval_id;

  const discoveryResponse = await fixture.post(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    formatPrivateProvenanceTargetDiscoveryRequest(privatePlan, { approvalId }),
    ADMIN,
  );
  const discovery = await body(discoveryResponse);
  assert.equal(discoveryResponse.status, 200, JSON.stringify(discovery));
  assert.equal(discovery.scope.whole_source_complete, false);
  const discoveryReceipt = selectPrivateProvenanceTargetDiscoveryReceipt(
    privatePlan,
    discovery,
  );

  // This fixture insertion represents the approved exact-original reingest.
  // It remains one native-readable target and never enables or attempts OCR.
  await seedBoundAcceptedFamily(fixture, privatePlan.seal.targets[0].original_id);
  const prematureRequest = {
    contract_version: 1,
    mode: "accepted_resolution",
    operation: "record",
    source: SOURCE,
    run_id: privatePlan.run_ids.accepted_resolution,
    plan_id: privatePlan.plan_id,
    source_snapshot_id: draft.input.sourceSnapshotId,
    target_set_hash: privatePlan.seal.target_set_hash,
    targets: [{
      locator_kind: "source_relative_path",
      locator: LOCATOR,
      original_id: privatePlan.seal.targets[0].original_id,
      text_state: "native_readable",
      original_content_sha256: CONTENT_SHA,
      original_byte_count: ORIGINAL_BYTES,
      page_count: 1,
      page_count_state: "authoritative",
      resolves_observation_hash: discoveryReceipt.observation_hash,
    }],
    retrieval_query: QUERY,
  };
  const prematureResponse = await fixture.post(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    prematureRequest,
    ADMIN,
  );
  const premature = await body(prematureResponse);
  assert.equal(prematureResponse.status, 409, JSON.stringify(premature));
  assert.equal(premature.code, "source_original_result_family_receipt_missing");
  assert.deepEqual(acceptedCounts(fixture), {
    admissions: 0,
    resolutions: 0,
    activations: 0,
    current: 0,
    observations: 1,
  });

  const familyRecordResponse = await fixture.post(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    formatPrivateProvenanceResultFamilyRequest(privatePlan, {
      operation: "record",
      approvalId,
    }),
    ADMIN,
  );
  const familyRecord = await body(familyRecordResponse);
  assert.equal(familyRecordResponse.status, 200, JSON.stringify(familyRecord));
  assert.equal(familyRecord.operation, "record");
  assert.equal(familyRecord.recorded, true);
  assert.equal(familyRecord.accepted_outcome_authorized, false);
  assert.equal(familyRecord.document_count, 1);
  assert.equal(familyRecord.chunk_count, 1);

  const familyVerifyResponse = await fixture.post(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    formatPrivateProvenanceResultFamilyRequest(privatePlan, {
      operation: "verify",
      approvalId,
    }),
    ADMIN,
  );
  const familyVerify = await body(familyVerifyResponse);
  assert.equal(familyVerifyResponse.status, 200, JSON.stringify(familyVerify));
  assert.equal(familyVerify.operation, "verify");
  assert.equal(familyVerify.family_receipt_hash, familyRecord.family_receipt_hash);
  assert.equal(familyVerify.verification_hash, familyRecord.verification_hash);
  assert.equal(familyVerify.accepted_outcome_authorized, false);

  const acceptedOptions = {
    operation: "record",
    approvalId,
    discoveryReceipt: discovery,
    resultFamilyRecordReceipt: familyRecord,
    resultFamilyVerifyReceipt: familyVerify,
  };

  const acceptedResponse = await fixture.post(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    formatPrivateProvenanceAcceptedResolutionRequest(privatePlan, acceptedOptions),
    ADMIN,
  );
  const accepted = await body(acceptedResponse);
  assert.equal(acceptedResponse.status, 200, JSON.stringify(accepted));
  assert.equal(accepted.status, "accepted_resolution_current");
  assert.equal(accepted.resolves_observation_hash, discoveryReceipt.observation_hash);
  assert.equal(accepted.accepted_outcome_authorized, true);
  assert.equal(accepted.scope.whole_source_complete, false);

  const replayResponse = await fixture.post(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    formatPrivateProvenanceAcceptedResolutionRequest(privatePlan, acceptedOptions),
    ADMIN,
  );
  const replayed = await body(replayResponse);
  assert.equal(replayResponse.status, 200, JSON.stringify(replayed));
  assert.equal(replayed.recorded, false);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.resolution_hash, accepted.resolution_hash);
  assert.equal(replayed.activation_hash, accepted.activation_hash);
  assert.equal(replayed.resolves_observation_hash, discoveryReceipt.observation_hash);

  const verifyOptions = {
    operation: "verify",
    approvalId,
    discoveryReceipt: discovery,
    resultFamilyRecordReceipt: familyRecord,
    resultFamilyVerifyReceipt: familyVerify,
  };
  const verifyResponse = await fixture.post(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    formatPrivateProvenanceAcceptedResolutionRequest(privatePlan, verifyOptions),
    ADMIN,
  );
  const verified = await body(verifyResponse);
  assert.equal(verifyResponse.status, 200, JSON.stringify(verified));
  assert.equal(verified.status, "accepted_resolution_current");
  assert.equal(verified.resolves_observation_hash, discoveryReceipt.observation_hash);
  assert.equal(verified.scope.whole_source_complete, false);

  // Recovery preserves portable observations, family receipt, and resolution,
  // while deployment-local verification and activation must be rebuilt.
  fixture.raw("DROP TRIGGER source_original_accepted_resolution_activation_no_delete");
  fixture.raw("DROP TRIGGER source_original_result_family_verification_no_delete");
  fixture.raw("DELETE FROM source_original_accepted_resolution_activations");
  fixture.raw("DELETE FROM source_original_result_family_verifications");
  assert.deepEqual(acceptedCounts(fixture), {
    admissions: 0,
    resolutions: 1,
    activations: 0,
    current: 0,
    observations: 2,
  });

  const staleVerifyResponse = await fixture.post(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    formatPrivateProvenanceAcceptedResolutionRequest(privatePlan, verifyOptions),
    ADMIN,
  );
  const staleVerify = await body(staleVerifyResponse);
  assert.equal(staleVerifyResponse.status, 409, JSON.stringify(staleVerify));
  assert.equal(
    staleVerify.code,
    "source_original_accepted_resolution_reverification_required",
  );
  assert.equal(fixture.first(
    "SELECT COUNT(*) AS n FROM source_original_result_family_verifications",
  ).n, 0, "verify cannot recreate deployment-local proof");

  const reactivateResponse = await fixture.post(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    formatPrivateProvenanceAcceptedResolutionRequest(privatePlan, acceptedOptions),
    ADMIN,
  );
  const reactivated = await body(reactivateResponse);
  assert.equal(reactivateResponse.status, 200, JSON.stringify(reactivated));
  assert.equal(reactivated.status, "accepted_resolution_current");
  assert.equal(reactivated.resolves_observation_hash, discoveryReceipt.observation_hash);
  assert.equal(reactivated.reactivated, true);
  assert.equal(reactivated.resolution_hash, accepted.resolution_hash);
  assert.equal(reactivated.scope.whole_source_complete, false);

  const finalVerifyResponse = await fixture.post(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    formatPrivateProvenanceAcceptedResolutionRequest(privatePlan, verifyOptions),
    ADMIN,
  );
  const finalVerify = await body(finalVerifyResponse);
  assert.equal(finalVerifyResponse.status, 200, JSON.stringify(finalVerify));
  assert.equal(finalVerify.status, "accepted_resolution_current");
  assert.equal(finalVerify.resolves_observation_hash, discoveryReceipt.observation_hash);
  assert.equal(finalVerify.scope.whole_source_complete, false);
});
