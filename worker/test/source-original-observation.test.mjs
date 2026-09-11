import assert from "node:assert/strict";
import test from "node:test";

import { createProductFixture } from "./product-contract-fixture.mjs";
import {
  SOURCE_ORIGINAL_OBSERVATION_MAX_TARGETS,
  SOURCE_ORIGINAL_OBSERVATION_PATH,
  SOURCE_ORIGINAL_OBSERVATION_VOCABULARY,
} from "../src/lib/source-original-observation.js";
import {
  normalizeIngestEnvelopeProvenance,
  provenanceAssessmentMarker,
} from "../src/lib/provenance-receipt.js";

const ADMIN = { "X-Admin-Key": "fixture-admin-key" };
const PLAN_ID = "1".repeat(64);
const SNAPSHOT_ID = `sha256:${"2".repeat(64)}`;
const LOCATOR = "statements/fixture-scan.pdf";
const CONTENT_SHA = "3".repeat(64);

const target = (originalId, patch = {}) => ({
  locator_kind: "source_relative_path",
  locator: LOCATOR,
  original_id: originalId,
  observation_stage: "discovery",
  outcome: "gap",
  reason_code: "provenance_unassessed",
  text_state: "native_readable",
  original_content_sha256: CONTENT_SHA,
  original_byte_count: 1234,
  page_count: 2,
  page_count_state: "authoritative",
  resolves_observation_hash: null,
  ...patch,
});

async function body(response) {
  assert.match(response.headers.get("cache-control") || "", /private, no-store/);
  return response.json();
}

test("closed vocabulary matches the local assessment states and authoritative page semantics", () => {
  assert.equal(SOURCE_ORIGINAL_OBSERVATION_MAX_TARGETS, 10);
  assert.deepEqual(SOURCE_ORIGINAL_OBSERVATION_VOCABULARY.text_states, [
    "native_readable", "ocr_reliable", "ocr_partial", "scan_only_ocr_needed",
    "empty", "password_protected", "unsupported", "extraction_failed", "unavailable",
  ]);
  assert.deepEqual(
    SOURCE_ORIGINAL_OBSERVATION_VOCABULARY.page_count_states,
    ["authoritative", "not_applicable", "unavailable"],
  );
  assert(SOURCE_ORIGINAL_OBSERVATION_VOCABULARY.outcome_triples.includes(
    "gap|scan_only_ocr_needed|scan_only_ocr_needed",
  ));
  assert.deepEqual(
    SOURCE_ORIGINAL_OBSERVATION_VOCABULARY.recordable_outcomes,
    ["gap", "adjudicated_exclusion", "failed"],
  );
  assert.equal(SOURCE_ORIGINAL_OBSERVATION_VOCABULARY.accepted_result_binding, "unavailable");
});

test("recovery preserves the identity domain and an unresolved observation exactly", async (t) => {
  const sourceFixture = await createProductFixture();
  const restoredFixture = await createProductFixture();
  t.after(() => {
    sourceFixture.close();
    restoredFixture.close();
  });

  for (const fixture of [sourceFixture, restoredFixture]) {
    fixture.raw(
      `INSERT INTO sources (name,kind,status,created_at)
       VALUES ('localdocs','upload','ready','2026-09-11T00:00:00.000Z')`,
    );
  }
  sourceFixture.raw(
    `INSERT INTO source_original_id_key_state (tenant_id,signing_salt)
     VALUES ('primary',?)`,
    "d".repeat(64),
  );

  const recoveredLocator = "recovery/missing-original.pdf";
  const sealRequest = {
    contract_version: 1,
    mode: "seal",
    source: "localdocs",
    plan_id: PLAN_ID,
    source_snapshot_id: SNAPSHOT_ID,
    targets: [{ locator_kind: "source_relative_path", locator: recoveredLocator }],
  };
  const sourceSealResponse = await sourceFixture.post(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    sealRequest,
    ADMIN,
  );
  const sourceSeal = await body(sourceSealResponse);
  assert.equal(sourceSealResponse.status, 200, JSON.stringify(sourceSeal));

  const recordRequest = {
    ...sealRequest,
    mode: "record",
    run_id: "synthetic_recovery_run",
    target_set_hash: sourceSeal.target_set_hash,
    targets: [target(sourceSeal.targets[0].original_id, {
      locator: recoveredLocator,
      text_state: "unavailable",
      reason_code: "current_document_missing",
      original_content_sha256: null,
      original_byte_count: null,
      page_count: null,
      page_count_state: "unavailable",
    })],
  };
  const recordResponse = await sourceFixture.post(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    recordRequest,
    ADMIN,
  );
  const recorded = await body(recordResponse);
  assert.equal(recordResponse.status, 200, JSON.stringify(recorded));
  assert.equal(recorded.observations[0].outcome, "gap");

  // Simulate the recovery adapter restoring its two-table durable unit into a
  // fresh schema. The exact immutable key must arrive before the ledger row.
  const keyRow = sourceFixture.first(
    "SELECT tenant_id,signing_salt FROM source_original_id_key_state WHERE tenant_id='primary'",
  );
  restoredFixture.raw(
    "INSERT INTO source_original_id_key_state (tenant_id,signing_salt) VALUES (?,?)",
    keyRow.tenant_id,
    keyRow.signing_salt,
  );
  const ledgerRow = sourceFixture.first(
    "SELECT * FROM source_original_observations WHERE run_id='synthetic_recovery_run'",
  );
  const ledgerColumns = Object.keys(ledgerRow);
  restoredFixture.raw(
    `INSERT INTO source_original_observations (${ledgerColumns.join(",")})
     VALUES (${ledgerColumns.map(() => "?").join(",")})`,
    ...ledgerColumns.map((column) => ledgerRow[column]),
  );

  const restoredSealResponse = await restoredFixture.post(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    sealRequest,
    ADMIN,
  );
  const restoredSeal = await body(restoredSealResponse);
  assert.equal(restoredSealResponse.status, 200, JSON.stringify(restoredSeal));
  assert.equal(restoredSeal.targets[0].original_id, sourceSeal.targets[0].original_id);
  assert.equal(restoredSeal.target_set_hash, sourceSeal.target_set_hash);
  assert.equal(JSON.stringify(restoredSeal).includes(recoveredLocator), false);

  const verifyResponse = await restoredFixture.post(
    SOURCE_ORIGINAL_OBSERVATION_PATH,
    { ...recordRequest, mode: "verify" },
    ADMIN,
  );
  const verified = await body(verifyResponse);
  assert.equal(verifyResponse.status, 200, JSON.stringify(verified));
  assert.equal(verified.targets[0].status, "observed_gap");
  assert.equal(verified.bounded_target_set_observation_verified, true);
  assert.equal(verified.bounded_target_set_repair_verified, false);
  assert.deepEqual(
    { ...restoredFixture.first("SELECT * FROM source_original_observations WHERE sequence=?", ledgerRow.sequence) },
    { ...ledgerRow },
  );
});

test("stable private identities, append-only lineage, and direct verification fail closed", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());

  fixture.raw(
    `INSERT INTO sources (name,kind,status,created_at)
     VALUES ('localdocs','upload','ready','2026-09-11T00:00:00.000Z')`,
  );
  fixture.raw(
    `INSERT INTO documents
       (doc_uid,source,source_id,title,ingested_at,content_hash,meta,text_source,text_reliable)
     VALUES (?,?,?,?,?,?,?, 'native',1)`,
    `localdocs:${LOCATOR}`, "localdocs", LOCATOR, "Synthetic statement", 1,
    "fixture-document-content", "{}",
  );
  fixture.raw(
    `INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source,title)
     VALUES (?,?,?,?,?,?)`,
    "fixture-chunk", `localdocs:${LOCATOR}`, 0, "Synthetic readable text", "localdocs", "Synthetic statement",
  );

  const sealRequest = {
    contract_version: 1,
    mode: "seal",
    source: "localdocs",
    plan_id: PLAN_ID,
    source_snapshot_id: SNAPSHOT_ID,
    targets: [{ locator_kind: "source_relative_path", locator: LOCATOR }],
  };

  const unauthorized = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, sealRequest);
  assert.equal(unauthorized.status, 401);
  assert.equal((await body(unauthorized)).code, "admin_required");

  // Schema-first recovery and the product fixture intentionally have no key.
  // The Worker must not fall back to a session or admin credential.
  let response = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, sealRequest, ADMIN);
  assert.equal(response.status, 503);
  assert.equal((await body(response)).code, "source_original_id_key_unavailable");

  fixture.raw(
    `INSERT INTO source_original_id_key_state (tenant_id,signing_salt)
     VALUES ('primary',?)`,
    "a".repeat(64),
  );
  const changesBeforeSeal = fixture.first("SELECT total_changes() AS n").n;
  response = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, sealRequest, ADMIN);
  assert.equal(response.status, 200);
  const sealed = await body(response);
  assert.match(sealed.targets[0].original_id, /^hmac-sha256:[a-f0-9]{64}$/);
  assert.equal(sealed.scope.whole_source_complete, false);
  assert.equal(JSON.stringify(sealed).includes(LOCATOR), false);
  assert.equal(fixture.first("SELECT total_changes() AS n").n, changesBeforeSeal);

  fixture.env.SESSION_SIGNING_KEY = "rotated-session-key-that-must-not-change-original-ids";
  response = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, sealRequest, ADMIN);
  assert.equal(response.status, 200);
  const resealed = await body(response);
  assert.equal(resealed.targets[0].original_id, sealed.targets[0].original_id);
  assert.equal(resealed.target_set_hash, sealed.target_set_hash);

  const tooMany = {
    ...sealRequest,
    targets: Array.from({ length: 11 }, (_, index) => ({
      locator_kind: "source_relative_path",
      locator: `bounded/${index}.pdf`,
    })),
  };
  response = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, tooMany, ADMIN);
  assert.equal(response.status, 400);
  assert.equal((await body(response)).code, "source_original_invalid_target_count");

  const discoveryRequest = {
    ...sealRequest,
    mode: "record",
    run_id: "discovery_run",
    target_set_hash: sealed.target_set_hash,
    targets: [target(sealed.targets[0].original_id)],
  };
  response = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, discoveryRequest, ADMIN);
  const discovery = await body(response);
  assert.equal(response.status, 200, JSON.stringify(discovery));
  const gapHash = discovery.observations[0].observation_hash;
  assert.equal(discovery.observations[0].outcome, "gap");
  assert.equal(discovery.scope.whole_source_complete, false);
  assert.equal(JSON.stringify(discovery).includes(LOCATOR), false);
  assert.equal(fixture.first("SELECT COUNT(*) AS n FROM source_original_observations").n, 1);

  const alternateLocator = "statements/another.pdf";
  const alternateSealResponse = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, {
    ...sealRequest,
    targets: [{ locator_kind: "source_relative_path", locator: alternateLocator }],
  }, ADMIN);
  const alternateSeal = await body(alternateSealResponse);
  assert.equal(alternateSealResponse.status, 200);
  response = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, {
    ...discoveryRequest,
    target_set_hash: alternateSeal.target_set_hash,
    targets: [target(alternateSeal.targets[0].original_id, {
      locator: alternateLocator,
      text_state: "unavailable",
      reason_code: "current_document_missing",
      original_content_sha256: null,
      original_byte_count: null,
      page_count: null,
      page_count_state: "unavailable",
    })],
  }, ADMIN);
  assert.equal(response.status, 409);
  assert.equal((await body(response)).code, "source_original_run_binding_conflict");
  assert.equal(fixture.first("SELECT COUNT(*) AS n FROM source_original_observations").n, 1);
  assert.equal(
    Object.keys(fixture.first("SELECT * FROM source_original_observations")).some((name) => /locator(?!_kind)/.test(name)),
    false,
  );

  // Exact retry is idempotent; a changed replay cannot overwrite the row.
  response = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, discoveryRequest, ADMIN);
  assert.equal(response.status, 200);
  assert.equal(fixture.first("SELECT COUNT(*) AS n FROM source_original_observations").n, 1);
  response = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, {
    ...discoveryRequest,
    targets: [target(sealed.targets[0].original_id, {
      outcome: "adjudicated_exclusion",
      reason_code: "empty_original",
      text_state: "empty",
      original_byte_count: 0,
      page_count: null,
      page_count_state: "not_applicable",
    })],
  }, ADMIN);
  assert.equal(response.status, 409);
  assert.equal((await body(response)).code, "source_original_observation_conflict");

  const verifyDiscovery = { ...discoveryRequest, mode: "verify" };
  const changesBeforeVerify = fixture.first("SELECT total_changes() AS n").n;
  response = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, verifyDiscovery, ADMIN);
  const verifiedGap = await body(response);
  assert.equal(response.status, 200, JSON.stringify(verifiedGap));
  assert.equal(verifiedGap.targets[0].status, "observed_gap");
  assert.equal(verifiedGap.bounded_target_set_observation_verified, true);
  assert.equal(verifiedGap.bounded_target_set_repair_verified, false);
  assert.equal(fixture.first("SELECT total_changes() AS n").n, changesBeforeVerify);

  response = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, {
    ...verifyDiscovery,
    targets: [{ ...verifyDiscovery.targets[0], page_count: 3 }],
  }, ADMIN);
  const mismatchedReceipt = await body(response);
  assert.equal(response.status, 409);
  assert.equal(mismatchedReceipt.targets[0].status, "submitted_observation_mismatch");
  assert.equal(mismatchedReceipt.bounded_target_set_repair_verified, false);

  const envelope = normalizeIngestEnvelopeProvenance({
    source_type: "localdocs",
    source_id: LOCATOR,
    content: "Synthetic readable text",
    text_source: "native",
    text_reliable: true,
    metadata: {
      evidence_lineage: {
        version: 1,
        kind: "source_record",
        root_ids: [`localdocs:${LOCATOR}`],
      },
    },
  });
  const marker = await provenanceAssessmentMarker(envelope);
  fixture.raw(
    `UPDATE documents SET meta=?,provenance_receipt_version=?,provenance_receipt_status=?,
       provenance_receipt_reason=?,provenance_receipt_digest=? WHERE doc_uid=?`,
    JSON.stringify(envelope.metadata), marker.provenance_receipt_version,
    marker.provenance_receipt_status, marker.provenance_receipt_reason,
    marker.provenance_receipt_digest, `localdocs:${LOCATOR}`,
  );

  // A complete current row is locator-bound, not bound to these exact original
  // bytes, so it cannot disprove a provenance_unassessed observation.
  response = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, {
    ...discoveryRequest,
    run_id: "no_op_gap_run",
  }, ADMIN);
  const repeatedGap = await body(response);
  assert.equal(response.status, 200, JSON.stringify(repeatedGap));
  assert.equal(repeatedGap.observations[0].outcome, "gap");

  const acceptedTarget = target(sealed.targets[0].original_id, {
    observation_stage: "repair",
    outcome: "accepted",
    reason_code: "accepted_provenance_verified",
    resolves_observation_hash: gapHash,
  });
  const repairRequest = {
    ...sealRequest,
    mode: "record",
    run_id: "repair_run",
    target_set_hash: sealed.target_set_hash,
    targets: [acceptedTarget],
  };
  response = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, repairRequest, ADMIN);
  assert.equal(response.status, 409);
  assert.equal((await body(response)).code, "source_original_result_binding_unavailable");
  assert.equal(fixture.first("SELECT COUNT(*) AS n FROM source_original_observations").n, 2);

  // Even a different current byte claim at the same locator cannot borrow the
  // stale good document. Schema 42 has no raw-byte-to-document binding.
  response = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, {
    ...repairRequest,
    run_id: "changed_bytes_run",
    targets: [{ ...acceptedTarget, original_content_sha256: "4".repeat(64) }],
  }, ADMIN);
  assert.equal(response.status, 409);
  assert.equal((await body(response)).code, "source_original_result_binding_unavailable");

  assert.throws(() => fixture.raw(
    `INSERT INTO source_original_observations
       (contract_version,tenant_id,source,original_id,locator_kind,run_id,plan_id,
        source_snapshot_id,target_set_hash,target_count,observation_stage,outcome,reason_code,
        text_state,original_content_sha256,original_byte_count,page_count,page_count_state,
        result_document_count,result_document_set_hash,resolves_observation_hash,observation_hash,recorded_at)
     SELECT contract_version,tenant_id,source,original_id,locator_kind,'direct_accepted',plan_id,
        source_snapshot_id,target_set_hash,target_count,'repair','accepted','accepted_provenance_verified',
        'native_readable',original_content_sha256,original_byte_count,page_count,page_count_state,
        result_document_count,result_document_set_hash,observation_hash,?,recorded_at
       FROM source_original_observations WHERE sequence=1`,
    `sha256:${"9".repeat(64)}`,
  ), /future raw-original binding/);

  response = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, {
    ...verifyDiscovery,
    targets: [{ ...verifyDiscovery.targets[0], original_content_sha256: "4".repeat(64) }],
  }, ADMIN);
  assert.equal(response.status, 409);
  const changedSource = await body(response);
  assert.equal(changedSource.bounded_target_set_repair_verified, false);
  assert.equal(changedSource.targets[0].status, "source_changed");

  fixture.raw("DELETE FROM chunks WHERE doc_uid=?", `localdocs:${LOCATOR}`);
  fixture.raw("DELETE FROM documents WHERE doc_uid=?", `localdocs:${LOCATOR}`);
  response = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, verifyDiscovery, ADMIN);
  assert.equal(response.status, 409);
  const deleted = await body(response);
  assert.equal(deleted.bounded_target_set_repair_verified, false);
  assert.equal(deleted.targets[0].status, "current_result_changed");

  assert.throws(() => fixture.raw(
    "UPDATE source_original_observations SET outcome='failed' WHERE sequence=1",
  ), /append-only/);
  assert.throws(() => fixture.raw(
    "DELETE FROM source_original_observations WHERE sequence=1",
  ), /append-only/);
  assert.throws(() => fixture.raw(
    "UPDATE source_original_id_key_state SET signing_salt=? WHERE tenant_id='primary'",
    "b".repeat(64),
  ), /immutable/);

  const changesBeforeInventory = fixture.first("SELECT total_changes() AS n").n;
  response = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, {
    contract_version: 1,
    mode: "inventory",
    source: "localdocs",
    limit: 1,
  }, ADMIN);
  assert.equal(response.status, 200);
  const inventory = await body(response);
  assert.equal(inventory.total, 2);
  assert.equal(inventory.page_complete, false);
  assert.equal(inventory.scope.whole_source_complete, false);
  assert.equal(JSON.stringify(inventory).includes(LOCATOR), false);
  assert.equal(fixture.first("SELECT total_changes() AS n").n, changesBeforeInventory);

  const laterLocator = "missing/later.pdf";
  const laterSealResponse = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, {
    ...sealRequest,
    targets: [{ locator_kind: "source_relative_path", locator: laterLocator }],
  }, ADMIN);
  const laterSeal = await body(laterSealResponse);
  assert.equal(laterSealResponse.status, 200);
  response = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, {
    ...discoveryRequest,
    run_id: "later_gap_run",
    target_set_hash: laterSeal.target_set_hash,
    targets: [target(laterSeal.targets[0].original_id, {
      locator: laterLocator,
      text_state: "unavailable",
      reason_code: "current_document_missing",
      original_content_sha256: null,
      original_byte_count: null,
      page_count: null,
      page_count_state: "unavailable",
    })],
  }, ADMIN);
  assert.equal(response.status, 200);
  await body(response);
  response = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, {
    contract_version: 1,
    mode: "inventory",
    source: "localdocs",
    after_sequence: inventory.observations.at(-1).sequence,
    limit: 1,
    snapshot_id: inventory.snapshot_id,
  }, ADMIN);
  assert.equal(response.status, 409);
  assert.equal((await body(response)).code, "source_original_inventory_changed");

  // Defense in depth: even if a damaged import were to bypass the D1 run
  // cardinality trigger, verification must inspect the complete stored run.
  fixture.raw("DROP TRIGGER source_original_observation_run_cardinality_insert");
  fixture.raw(
    `INSERT INTO source_original_observations
       (contract_version,tenant_id,source,original_id,locator_kind,run_id,plan_id,
        source_snapshot_id,target_set_hash,target_count,observation_stage,outcome,reason_code,
        text_state,original_content_sha256,original_byte_count,page_count,page_count_state,
        result_document_count,result_document_set_hash,resolves_observation_hash,observation_hash,recorded_at)
     SELECT contract_version,tenant_id,source,?,locator_kind,run_id,plan_id,
        source_snapshot_id,target_set_hash,target_count,observation_stage,outcome,reason_code,
        text_state,original_content_sha256,original_byte_count,page_count,page_count_state,
        result_document_count,result_document_set_hash,resolves_observation_hash,?,recorded_at
       FROM source_original_observations WHERE run_id='discovery_run'`,
    `hmac-sha256:${"b".repeat(64)}`,
    `sha256:${"c".repeat(64)}`,
  );
  response = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, verifyDiscovery, ADMIN);
  const overfullRun = await body(response);
  assert.equal(response.status, 409);
  assert.equal(overfullRun.targets[0].status, "run_binding_conflict");
  assert.equal(overfullRun.bounded_target_set_observation_verified, false);
});

test("document-family evidence is always bound to the selected source", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  fixture.raw("INSERT INTO source_original_id_key_state VALUES ('primary',?)", "a".repeat(64));
  fixture.raw(
    "INSERT INTO sources (name,kind,status,created_at) VALUES ('localdocs','upload','ready','2026-09-11T00:00:00Z')",
  );
  fixture.raw(
    `INSERT INTO documents
       (doc_uid,source,source_id,title,ingested_at,content_hash,meta,text_source,text_reliable)
     VALUES ('localdocs:collision.pdf','another-source','collision.pdf','Foreign collision',1,'foreign','{}','native',1)`,
  );
  const sealResponse = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, {
    contract_version: 1,
    mode: "seal",
    source: "localdocs",
    plan_id: PLAN_ID,
    source_snapshot_id: SNAPSHOT_ID,
    targets: [{ locator_kind: "source_relative_path", locator: "collision.pdf" }],
  }, ADMIN);
  const seal = await body(sealResponse);
  assert.equal(sealResponse.status, 200);
  const recordResponse = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, {
    contract_version: 1,
    mode: "record",
    source: "localdocs",
    run_id: "source_collision_run",
    plan_id: PLAN_ID,
    source_snapshot_id: SNAPSHOT_ID,
    target_set_hash: seal.target_set_hash,
    targets: [target(seal.targets[0].original_id, {
      locator: "collision.pdf",
      text_state: "unavailable",
      reason_code: "current_document_missing",
      original_content_sha256: null,
      original_byte_count: null,
      page_count: null,
      page_count_state: "unavailable",
    })],
  }, ADMIN);
  const record = await body(recordResponse);
  assert.equal(recordResponse.status, 200, JSON.stringify(record));
  assert.equal(record.observations[0].result_document_count, 0);

  // A marker can be internally valid for another original in the same source.
  // Matching only the target-shaped doc_uid must not let that marker suppress
  // a durable provenance_unassessed observation for this exact target.
  const targetLocator = "target-root.pdf";
  const otherLocator = "different-root.pdf";
  const envelope = normalizeIngestEnvelopeProvenance({
    source_type: "localdocs",
    source_id: otherLocator,
    content: "Synthetic readable content rooted in another original.",
    text_source: "native",
    text_reliable: true,
    metadata: {
      evidence_lineage: {
        version: 1,
        kind: "source_record",
        root_ids: [`localdocs:${otherLocator}`],
      },
    },
  });
  const marker = await provenanceAssessmentMarker(envelope);
  fixture.raw(
    `INSERT INTO documents
       (doc_uid,source,source_id,title,ingested_at,content_hash,meta,text_source,text_reliable,
        provenance_receipt_version,provenance_receipt_status,provenance_receipt_reason,
        provenance_receipt_digest)
     VALUES (?,?,?,?,1,'other-root-content',?,'native',1,?,?,?,?)`,
    `localdocs:${targetLocator}`, "localdocs", otherLocator, "Other root",
    JSON.stringify(envelope.metadata), marker.provenance_receipt_version,
    marker.provenance_receipt_status, marker.provenance_receipt_reason,
    marker.provenance_receipt_digest,
  );
  fixture.raw(
    `INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source,title)
     VALUES (?,?,?,?,?,?)`,
    "other-root-chunk", `localdocs:${targetLocator}`, 0,
    "Synthetic readable content rooted in another original.", "localdocs", "Other root",
  );
  const targetSealResponse = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, {
    contract_version: 1,
    mode: "seal",
    source: "localdocs",
    plan_id: PLAN_ID,
    source_snapshot_id: SNAPSHOT_ID,
    targets: [{ locator_kind: "source_relative_path", locator: targetLocator }],
  }, ADMIN);
  const targetSeal = await body(targetSealResponse);
  assert.equal(targetSealResponse.status, 200);
  const wrongRootGapResponse = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, {
    contract_version: 1,
    mode: "record",
    source: "localdocs",
    run_id: "wrong_root_gap_run",
    plan_id: PLAN_ID,
    source_snapshot_id: SNAPSHOT_ID,
    target_set_hash: targetSeal.target_set_hash,
    targets: [target(targetSeal.targets[0].original_id, { locator: targetLocator })],
  }, ADMIN);
  const wrongRootGap = await body(wrongRootGapResponse);
  assert.equal(wrongRootGapResponse.status, 200, JSON.stringify(wrongRootGap));
  assert.equal(wrongRootGap.observations[0].outcome, "gap");
});

test("an incomplete structural family can never create or verify an accepted repair", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  fixture.raw("INSERT INTO source_original_id_key_state VALUES ('primary',?)", "a".repeat(64));
  fixture.raw(
    "INSERT INTO sources (name,kind,status,created_at) VALUES ('localdocs','upload','ready','2026-09-11T00:00:00Z')",
  );
  const locator = "split/incomplete.pdf";
  fixture.raw(
    `INSERT INTO documents
       (doc_uid,source,source_id,title,ingested_at,content_hash,meta,text_source,text_reliable)
     VALUES (?,?,?,?,1,'partial-family','{}','native',1)`,
    `localdocs:${locator}#part1of2`, "localdocs", `${locator}#part1of2`, "Only part one",
  );
  fixture.raw(
    `INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source,title)
     VALUES (?,?,?,?,?,?)`,
    "partial-family-chunk", `localdocs:${locator}#part1of2`, 0,
    "Only the first half is present", "localdocs", "Only part one",
  );
  const sealResponse = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, {
    contract_version: 1,
    mode: "seal",
    source: "localdocs",
    plan_id: PLAN_ID,
    source_snapshot_id: SNAPSHOT_ID,
    targets: [{ locator_kind: "source_relative_path", locator }],
  }, ADMIN);
  const seal = await body(sealResponse);
  assert.equal(sealResponse.status, 200);
  const accepted = target(seal.targets[0].original_id, {
    locator,
    observation_stage: "repair",
    outcome: "accepted",
    reason_code: "accepted_provenance_verified",
    resolves_observation_hash: `sha256:${"8".repeat(64)}`,
  });
  const request = {
    contract_version: 1,
    mode: "record",
    source: "localdocs",
    run_id: "partial_family_repair",
    plan_id: PLAN_ID,
    source_snapshot_id: SNAPSHOT_ID,
    target_set_hash: seal.target_set_hash,
    targets: [accepted],
  };
  const recordResponse = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, request, ADMIN);
  assert.equal(recordResponse.status, 409);
  assert.equal((await body(recordResponse)).code, "source_original_result_binding_unavailable");
  assert.equal(fixture.first("SELECT COUNT(*) AS n FROM source_original_observations").n, 0);

  const verifyResponse = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, {
    ...request,
    mode: "verify",
  }, ADMIN);
  const verify = await body(verifyResponse);
  assert.equal(verifyResponse.status, 409);
  assert.equal(verify.targets[0].status, "missing_observation");
  assert.equal(verify.bounded_target_set_repair_verified, false);
});

test("record mode honors the upgrade pause while read-only seal remains available", async (t) => {
  const fixture = await createProductFixture({ env: { VECTOR_DRAIN_MODE: "paused-for-upgrade" } });
  t.after(() => fixture.close());
  fixture.raw("INSERT INTO source_original_id_key_state VALUES ('primary',?)", "a".repeat(64));
  fixture.raw(
    "INSERT INTO sources (name,kind,status,created_at) VALUES ('localdocs','upload','ready','2026-09-11T00:00:00Z')",
  );
  const seal = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, {
    contract_version: 1,
    mode: "seal",
    source: "localdocs",
    plan_id: PLAN_ID,
    source_snapshot_id: SNAPSHOT_ID,
    targets: [{ locator_kind: "source_relative_path", locator: LOCATOR }],
  }, ADMIN);
  assert.equal(seal.status, 200);
  const sealed = await body(seal);
  const record = await fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, {
    contract_version: 1,
    mode: "record",
    source: "localdocs",
    run_id: "paused_run",
    plan_id: PLAN_ID,
    source_snapshot_id: SNAPSHOT_ID,
    target_set_hash: sealed.target_set_hash,
    targets: [target(sealed.targets[0].original_id, {
      outcome: "failed",
      reason_code: "original_unavailable",
      text_state: "unavailable",
      original_content_sha256: null,
      original_byte_count: null,
      page_count: null,
      page_count_state: "unavailable",
    })],
  }, ADMIN);
  assert.equal(record.status, 503);
  assert.equal((await body(record)).code, "corpus_writes_paused");
  assert.equal(fixture.first("SELECT COUNT(*) AS n FROM source_original_observations").n, 0);
});
