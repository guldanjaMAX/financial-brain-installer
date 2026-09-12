import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runRestartSafeMigrationStatements, splitStatements } from "../brain.mjs";

const MIGRATIONS = fileURLToPath(new URL("../migrations/d1/", import.meta.url));
const FILES = readdirSync(MIGRATIONS)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();
const MIGRATION_45 = FILES.find((name) => name.startsWith("0045_"));

function apply(db, file) {
  const source = readFileSync(join(MIGRATIONS, file), "utf8");
  for (const statement of splitStatements(source)) db.exec(statement);
}

function applyThrough(db, version) {
  for (const file of FILES.filter((name) => Number(name.slice(0, 4)) <= version)) {
    apply(db, file);
  }
}

function queryFor(db) {
  return async (sql) => {
    if (/^\s*(?:SELECT|PRAGMA)\b/i.test(sql)) {
      return { results: db.prepare(sql).all() };
    }
    db.exec(sql);
    return { results: [] };
  };
}

const hex = (character) => character.repeat(64);
const digest = (character) => `sha256:${hex(character)}`;
const originalId = (character) => `hmac-sha256:${hex(character)}`;
const revisionId = (character) => `rev-v1:${hex(character)}`;
const probeId = (character) => `probe-v1:${hex(character)}`;

const FIXTURE = Object.freeze({
  source: "localdocs",
  original_id: originalId("1"),
  original_content_sha256: hex("2"),
  original_byte_count: 123,
  document_revision_id: revisionId("3"),
  binding_hash: digest("4"),
  document_content_hash: hex("5"),
  provenance_receipt_digest: hex("6"),
  provenance_meta: JSON.stringify({
    evidence_lineage: {
      version: 1,
      kind: "source_record",
      root_ids: ["localdocs:bound"],
    },
    provenance_receipt: {
      version: 1,
      status: "complete",
      reason: "lineage_and_text_recorded",
      root_ids: ["localdocs:bound"],
    },
  }),
  chunk_receipt_hash: digest("7"),
  family_receipt_hash: digest("8"),
  family_document_set_hash: digest("9"),
  family_chunk_set_hash: digest("a"),
  verification_hash: digest("b"),
  vector_readiness_hash: digest("c"),
  prior_observation_hash: digest("d"),
  prior_result_set_hash: digest("e"),
  accepted_observation_hash: digest("f"),
  accepted_result_set_hash: digest("0"),
  resolution_hash: digest("1"),
  activation_hash: digest("2"),
});

function pick(value, names) {
  return Object.fromEntries(names.map((name) => [name, value[name]]));
}

const INSERT_OBSERVATION = `
  INSERT INTO source_original_observations
    (contract_version,tenant_id,source,original_id,locator_kind,run_id,plan_id,
     source_snapshot_id,target_set_hash,target_count,observation_stage,outcome,
     reason_code,text_state,original_content_sha256,original_byte_count,page_count,
     page_count_state,result_document_count,result_document_set_hash,
     resolves_observation_hash,observation_hash,recorded_at)
  VALUES
    (@contract_version,@tenant_id,@source,@original_id,@locator_kind,@run_id,@plan_id,
     @source_snapshot_id,@target_set_hash,@target_count,@observation_stage,@outcome,
     @reason_code,@text_state,@original_content_sha256,@original_byte_count,@page_count,
     @page_count_state,@result_document_count,@result_document_set_hash,
     @resolves_observation_hash,@observation_hash,@recorded_at)`;

const INSERT_ADMISSION = `
  INSERT INTO source_original_accepted_resolution_admissions
    (resolution_hash,contract_version,tenant_id,source,original_id,locator_kind,
     run_id,plan_id,source_snapshot_id,target_set_hash,target_count,text_state,
     original_content_sha256,original_byte_count,page_count,page_count_state,
     result_document_count,result_document_set_hash,resolves_observation_hash,
     accepted_observation_hash,family_receipt_hash,verification_hash,
     activation_hash,recorded_at,activated_at)
  VALUES
    (@resolution_hash,@contract_version,@tenant_id,@source,@original_id,@locator_kind,
     @run_id,@plan_id,@source_snapshot_id,@target_set_hash,@target_count,@text_state,
     @original_content_sha256,@original_byte_count,@page_count,@page_count_state,
     @result_document_count,@result_document_set_hash,@resolves_observation_hash,
     @accepted_observation_hash,@family_receipt_hash,@verification_hash,
     @activation_hash,@recorded_at,@activated_at)`;

const INSERT_BINDING = `
  INSERT INTO source_original_result_bindings
    (contract_version,tenant_id,source,original_id,locator_kind,
     document_revision_id,original_content_sha256,original_byte_count,
     document_content_hash,provenance_receipt_digest,binding_hash,bound_at)
  VALUES
    (1,'primary',@source,@original_id,'source_relative_path',
     @document_revision_id,@original_content_sha256,@original_byte_count,
     @document_content_hash,@provenance_receipt_digest,@binding_hash,7)`;

const INSERT_MEMBER = `
  INSERT INTO source_original_result_family_members
    (family_receipt_hash,document_revision_id,source_original_binding_hash,
     chunk_ix,chunk_receipt_hash)
  VALUES (@family_receipt_hash,@document_revision_id,@binding_hash,0,@chunk_receipt_hash)`;

const INSERT_FAMILY = `
  INSERT INTO source_original_result_family_receipts
    (contract_version,tenant_id,source,original_id,locator_kind,
     original_content_sha256,original_byte_count,document_count,document_set_hash,
     chunk_count,chunk_set_hash,family_receipt_hash,sealed_at)
  VALUES
    (1,'primary',@source,@original_id,'source_relative_path',
     @original_content_sha256,@original_byte_count,1,@family_document_set_hash,
     1,@family_chunk_set_hash,@family_receipt_hash,18)`;

const INSERT_VERIFICATION = `
  INSERT INTO source_original_result_family_verifications
    (contract_version,tenant_id,family_receipt_hash,outbox_generation,
     vector_projection_mutation_id,vector_projection_submitted_at,
     vector_projection_bootstrap_epoch,vector_projection_status,
     expected_vector_count,actual_vector_count,target_outbox_count,global_outbox_count,
     vector_readiness_hash,retrieval_generation,
     retrieval_contract_version,retrieval_probe_id,retrieval_status,
     retrieval_result_hash_a,retrieval_result_hash_b,
     retrieved_document_revision_id_a,retrieved_document_revision_id_b,
     retrieved_chunk_ix_a,retrieved_chunk_ix_b,citation_status,
     citation_set_hash_a,citation_set_hash_b,
     cited_document_revision_id_a,cited_document_revision_id_b,
     verification_hash,verified_at)
  VALUES
    (1,'primary',@family_receipt_hash,@outbox_generation,
     NULL,NULL,@vector_projection_bootstrap_epoch,'verified',
     @expected_vector_count,@expected_vector_count,0,0,
     @vector_readiness_hash,@retrieval_generation,
     1,@retrieval_probe_id,'deterministic',
     @retrieval_result_hash,@retrieval_result_hash,
     @document_revision_id,@document_revision_id,0,0,'same_family',
     @citation_set_hash,@citation_set_hash,
     @document_revision_id,@document_revision_id,@verification_hash,@verified_at)`;

const INSERT_RESOLUTION = `
  INSERT INTO source_original_accepted_resolutions
    (contract_version,tenant_id,source,original_id,locator_kind,
     original_content_sha256,original_byte_count,resolves_observation_hash,
     accepted_observation_hash,result_document_count,result_document_set_hash,
     family_receipt_hash,admission_verification_hash,resolution_hash,admitted_at)
  VALUES
    (1,'primary',@source,@original_id,'source_relative_path',
     @original_content_sha256,@original_byte_count,@prior_observation_hash,
     @accepted_observation_hash,1,@accepted_result_set_hash,
     @family_receipt_hash,@verification_hash,@resolution_hash,20)`;

function priorObservation(overrides = {}) {
  return {
    contract_version: 1,
    tenant_id: "primary",
    source: FIXTURE.source,
    original_id: FIXTURE.original_id,
    locator_kind: "source_relative_path",
    run_id: "discovery_run",
    plan_id: hex("3"),
    source_snapshot_id: digest("4"),
    target_set_hash: digest("5"),
    target_count: 1,
    observation_stage: "discovery",
    outcome: "gap",
    reason_code: "provenance_unassessed",
    text_state: "native_readable",
    original_content_sha256: FIXTURE.original_content_sha256,
    original_byte_count: FIXTURE.original_byte_count,
    page_count: null,
    page_count_state: "not_applicable",
    result_document_count: 0,
    result_document_set_hash: FIXTURE.prior_result_set_hash,
    resolves_observation_hash: null,
    observation_hash: FIXTURE.prior_observation_hash,
    recorded_at: 10,
    ...overrides,
  };
}

function acceptedObservation(overrides = {}) {
  return {
    contract_version: 1,
    tenant_id: "primary",
    source: FIXTURE.source,
    original_id: FIXTURE.original_id,
    locator_kind: "source_relative_path",
    run_id: "repair_run",
    plan_id: hex("6"),
    source_snapshot_id: digest("7"),
    target_set_hash: digest("8"),
    target_count: 1,
    observation_stage: "repair",
    outcome: "accepted",
    reason_code: "accepted_provenance_verified",
    text_state: "native_readable",
    original_content_sha256: FIXTURE.original_content_sha256,
    original_byte_count: FIXTURE.original_byte_count,
    page_count: null,
    page_count_state: "not_applicable",
    result_document_count: 1,
    result_document_set_hash: FIXTURE.accepted_result_set_hash,
    resolves_observation_hash: FIXTURE.prior_observation_hash,
    observation_hash: FIXTURE.accepted_observation_hash,
    recorded_at: 20,
    ...overrides,
  };
}

function admission(overrides = {}) {
  const accepted = acceptedObservation();
  return {
    resolution_hash: FIXTURE.resolution_hash,
    contract_version: accepted.contract_version,
    tenant_id: accepted.tenant_id,
    source: accepted.source,
    original_id: accepted.original_id,
    locator_kind: accepted.locator_kind,
    run_id: accepted.run_id,
    plan_id: accepted.plan_id,
    source_snapshot_id: accepted.source_snapshot_id,
    target_set_hash: accepted.target_set_hash,
    target_count: accepted.target_count,
    text_state: accepted.text_state,
    original_content_sha256: accepted.original_content_sha256,
    original_byte_count: accepted.original_byte_count,
    page_count: accepted.page_count,
    page_count_state: accepted.page_count_state,
    result_document_count: accepted.result_document_count,
    result_document_set_hash: accepted.result_document_set_hash,
    resolves_observation_hash: accepted.resolves_observation_hash,
    accepted_observation_hash: accepted.observation_hash,
    family_receipt_hash: FIXTURE.family_receipt_hash,
    verification_hash: FIXTURE.verification_hash,
    activation_hash: FIXTURE.activation_hash,
    recorded_at: accepted.recorded_at,
    activated_at: 20,
    ...overrides,
  };
}

function installState(db) {
  db.prepare(
    `INSERT INTO install_state
       (id,client_slug,product_version,schema_version,gate_version,installed_at,ring,
        outbox_generation,vector_projection_status,vector_projection_bootstrap_epoch)
     VALUES (1,'fixture','test',45,0,'2026-09-11T00:00:00Z','test',0,'verified',0)`,
  ).run();
  db.prepare(
    `INSERT INTO sources (name,kind,status,created_at)
     VALUES ('localdocs','upload','ready','2026-09-11T00:00:00Z')`,
  ).run();
}

function insertCurrentFamily(db) {
  db.prepare(
    `INSERT INTO documents
       (doc_uid,source,source_id,title,ingested_at,content_hash,meta,
        text_source,text_reliable,provenance_receipt_version,
        provenance_receipt_status,provenance_receipt_reason,provenance_receipt_digest,
        document_revision_id,source_original_binding_hash)
     VALUES
       ('localdocs:bound','localdocs','bound','Bound fixture',7,@document_content_hash,@provenance_meta,
        'native',1,1,'complete','lineage_and_text_recorded',@provenance_receipt_digest,
        @document_revision_id,@binding_hash)`,
  ).run(pick(FIXTURE, [
    "document_content_hash", "provenance_meta", "provenance_receipt_digest",
    "document_revision_id", "binding_hash",
  ]));
  db.prepare(INSERT_BINDING).run(pick(FIXTURE, [
    "source", "original_id", "document_revision_id", "original_content_sha256",
    "original_byte_count", "document_content_hash", "provenance_receipt_digest", "binding_hash",
  ]));
  db.prepare(
    `INSERT INTO chunks
       (chunk_uid,doc_uid,chunk_ix,text,source,title,vector_id,
        bound_document_revision_id,result_chunk_receipt_hash)
     VALUES
       ('localdocs:bound#0','localdocs:bound',0,
        '[Bound fixture]' || char(10) || char(10) || 'Synthetic body.',
        'localdocs','Bound fixture','localdocs:bound#0',
        @document_revision_id,@chunk_receipt_hash)`,
  ).run(pick(FIXTURE, ["document_revision_id", "chunk_receipt_hash"]));
}

function insertNonFamilyResult(db) {
  db.prepare(
    `INSERT INTO sources (name,kind,status,created_at)
     VALUES ('otherdocs','drive','ready','2026-09-11T00:00:00Z')`,
  ).run();
  db.prepare(
    `INSERT INTO documents
       (doc_uid,source,source_id,title,uri,ingested_at,content_hash,meta,
        text_source,text_reliable)
     VALUES
       ('otherdocs:lower','otherdocs','lower','Lower ranked result',
        'https://example.invalid/lower',8,'other-document-hash','{}','native',1)`,
  ).run();
  db.prepare(
    `INSERT INTO chunks
       (chunk_uid,doc_uid,chunk_ix,text,source,title,vector_id)
     VALUES
       ('otherdocs:lower#0','otherdocs:lower',0,'Lower ranked result body.',
        'otherdocs','Lower ranked result','otherdocs:lower#0')`,
  ).run();
}

function insertPortableFamily(db) {
  db.prepare(INSERT_MEMBER).run(pick(FIXTURE, [
    "family_receipt_hash", "document_revision_id", "binding_hash", "chunk_receipt_hash",
  ]));
  db.prepare(INSERT_FAMILY).run(pick(FIXTURE, [
    "source", "original_id", "original_content_sha256", "original_byte_count",
    "family_document_set_hash", "family_chunk_set_hash", "family_receipt_hash",
  ]));
}

function insertVerification(db, overrides = {}) {
  const state = db.prepare(
    `SELECT outbox_generation,vector_projection_bootstrap_epoch,
            source_original_retrieval_generation AS retrieval_generation
       FROM install_state WHERE id=1`,
  ).get();
  const params = {
    ...FIXTURE,
    outbox_generation: state.outbox_generation,
    vector_projection_bootstrap_epoch: state.vector_projection_bootstrap_epoch,
    retrieval_generation: state.retrieval_generation,
    expected_vector_count: db.prepare("SELECT count(*) AS n FROM chunks").get().n,
    retrieval_probe_id: probeId("3"),
    retrieval_result_hash: digest("4"),
    citation_set_hash: digest("5"),
    verified_at: 19,
    ...overrides,
  };
  db.prepare(INSERT_VERIFICATION).run(pick(params, [
    "family_receipt_hash", "outbox_generation", "vector_projection_bootstrap_epoch",
    "retrieval_generation", "expected_vector_count",
    "vector_readiness_hash", "retrieval_probe_id", "retrieval_result_hash",
    "document_revision_id", "citation_set_hash", "verification_hash", "verified_at",
  ]));
  return params;
}

function resolutionParams(overrides = {}) {
  return {
    source: FIXTURE.source,
    original_id: FIXTURE.original_id,
    original_content_sha256: FIXTURE.original_content_sha256,
    original_byte_count: FIXTURE.original_byte_count,
    prior_observation_hash: FIXTURE.prior_observation_hash,
    accepted_observation_hash: FIXTURE.accepted_observation_hash,
    accepted_result_set_hash: FIXTURE.accepted_result_set_hash,
    family_receipt_hash: FIXTURE.family_receipt_hash,
    verification_hash: FIXTURE.verification_hash,
    resolution_hash: FIXTURE.resolution_hash,
    ...overrides,
  };
}

function readyFixture({ verification = true, nonFamily = false } = {}) {
  const db = new DatabaseSync(":memory:");
  applyThrough(db, 45);
  installState(db);
  insertCurrentFamily(db);
  if (nonFamily) insertNonFamilyResult(db);
  db.prepare(INSERT_OBSERVATION).run(priorObservation());
  insertPortableFamily(db);
  if (verification) insertVerification(db);
  return db;
}

function counts(db) {
  return {
    admissions: db.prepare("SELECT count(*) AS n FROM source_original_accepted_resolution_admissions").get().n,
    resolutions: db.prepare("SELECT count(*) AS n FROM source_original_accepted_resolutions").get().n,
    activations: db.prepare("SELECT count(*) AS n FROM source_original_accepted_resolution_activations").get().n,
    accepted: db.prepare("SELECT count(*) AS n FROM source_original_observations WHERE outcome='accepted'").get().n,
    current: db.prepare("SELECT count(*) AS n FROM source_original_current_accepted_resolutions").get().n,
  };
}

test("0045 keeps accepted writes blocked across every restartable statement boundary", async () => {
  assert.ok(MIGRATION_45, "the schema-45 migration exists");
  const statements = splitStatements(readFileSync(join(MIGRATIONS, MIGRATION_45), "utf8"));
  for (let cut = 0; cut <= statements.length; cut++) {
    const db = new DatabaseSync(":memory:");
    try {
      applyThrough(db, 44);
      for (const statement of statements.slice(0, cut)) db.exec(statement);
      assert.throws(
        () => db.prepare(INSERT_OBSERVATION).run(acceptedObservation()),
        /accepted source-original outcomes require/,
        `accepted remains blocked after ${cut} of ${statements.length} statements`,
      );
      await runRestartSafeMigrationStatements(statements, queryFor(db));
      await runRestartSafeMigrationStatements(statements, queryFor(db));
      assert.throws(
        () => db.prepare(INSERT_OBSERVATION).run(acceptedObservation()),
        /accepted source-original outcomes require an atomic schema-45 admission/,
      );
      assert.equal(db.prepare("SELECT count(*) AS n FROM source_original_accepted_resolutions").get().n, 0,
        "migration and restart never manufacture accepted history");
    } finally {
      db.close();
    }
  }
});

test("0045 atomically admits one exact resolution and rejects direct replay for Worker reconciliation", () => {
  const db = readyFixture();
  try {
    assert.throws(
      () => db.prepare(INSERT_ADMISSION).run(admission({ target_count: 2 })),
      /target_count = 1/,
      "one admission can accept exactly one target",
    );
    assert.deepEqual(counts(db), {
      admissions: 0,
      resolutions: 0,
      activations: 0,
      accepted: 0,
      current: 0,
    });
    assert.throws(
      () => db.prepare(INSERT_ADMISSION).run(admission({ recorded_at: 18 })),
      /verification is stale/,
      "initial accepted history cannot predate the verification it seals",
    );

    db.prepare(INSERT_ADMISSION).run(admission());
    assert.deepEqual(counts(db), {
      admissions: 0,
      resolutions: 1,
      activations: 1,
      accepted: 1,
      current: 1,
    });
    const portable = { ...db.prepare(
      `SELECT source,original_id,original_content_sha256,original_byte_count,
              resolves_observation_hash,accepted_observation_hash,
              result_document_count,result_document_set_hash,family_receipt_hash,
              admission_verification_hash,resolution_hash,admitted_at
         FROM source_original_accepted_resolutions`,
    ).get() };
    assert.deepEqual(portable, {
      source: FIXTURE.source,
      original_id: FIXTURE.original_id,
      original_content_sha256: FIXTURE.original_content_sha256,
      original_byte_count: FIXTURE.original_byte_count,
      resolves_observation_hash: FIXTURE.prior_observation_hash,
      accepted_observation_hash: FIXTURE.accepted_observation_hash,
      result_document_count: 1,
      result_document_set_hash: FIXTURE.accepted_result_set_hash,
      family_receipt_hash: FIXTURE.family_receipt_hash,
      admission_verification_hash: FIXTURE.verification_hash,
      resolution_hash: FIXTURE.resolution_hash,
      admitted_at: 20,
    }, "portable history keeps the observation result-set domain distinct from the family hash domain");

    assert.throws(
      () => db.prepare(INSERT_ADMISSION).run(admission()),
      /exact replay already committed/,
      "a serialized exact loser aborts so the Worker can report replay instead of record",
    );
    assert.deepEqual(counts(db), {
      admissions: 0,
      resolutions: 1,
      activations: 1,
      accepted: 1,
      current: 1,
    }, "a rejected direct replay leaves the same complete durable cut");

    assert.throws(
      () => db.prepare(INSERT_ADMISSION).run(admission({ activated_at: 21 })),
      /activation conflicts with immutable history/,
      "an activation replay must preserve its exact activated-at evidence",
    );

    assert.throws(
      () => db.prepare(INSERT_ADMISSION).run(admission({
        accepted_observation_hash: digest("a"),
      })),
      /conflicts with immutable history/,
      "a changed replay cannot reuse the prior resolution",
    );
    assert.throws(
      () => db.prepare(INSERT_OBSERVATION).run(acceptedObservation({
        run_id: "direct_accept",
        observation_hash: digest("9"),
      })),
      /accepted source-original outcomes require an atomic schema-45 admission/,
      "direct SQL cannot insert an accepted observation",
    );
    assert.throws(
      () => db.prepare(INSERT_RESOLUTION).run(resolutionParams()),
      /requires an atomic admission|cannot be replaced/,
      "direct SQL cannot insert portable accepted history",
    );
    assert.throws(
      () => db.prepare(
        "UPDATE source_original_accepted_resolutions SET admitted_at=99 WHERE resolution_hash=?",
      ).run(FIXTURE.resolution_hash),
      /accepted resolutions are append-only/,
    );
    assert.throws(
      () => db.prepare(
        "DELETE FROM source_original_accepted_resolution_activations WHERE resolution_hash=?",
      ).run(FIXTURE.resolution_hash),
      /activations are append-only/,
    );
    assert.throws(
      () => db.prepare(
        "DELETE FROM source_original_accepted_resolutions WHERE resolution_hash=?",
      ).run(FIXTURE.resolution_hash),
      /accepted resolutions are append-only/,
    );
    assert.throws(
      () => db.prepare(
        "UPDATE source_original_accepted_resolution_activations SET activated_at=99 WHERE resolution_hash=?",
      ).run(FIXTURE.resolution_hash),
      /activations are append-only/,
    );
    assert.throws(
      () => db.prepare(INSERT_RESOLUTION.replace("INSERT INTO", "INSERT OR REPLACE INTO"))
        .run(resolutionParams()),
      (error) => {
        assert.match(error.message, /cannot be replaced|requires an atomic admission/);
        return true;
      },
      "SQLite REPLACE cannot rewrite portable resolution history",
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM source_original_accepted_resolutions").get().n,
      1,
      "the rejected REPLACE leaves the original portable row intact",
    );
  } finally {
    db.close();
  }
});

test("0045 never revives a sealed chunk receipt over different bytes", () => {
  const db = readyFixture();
  try {
    db.prepare(INSERT_ADMISSION).run(admission());
    assert.equal(counts(db).current, 1);

    const temporaryReceipt = digest("6");
    db.prepare(
      "UPDATE chunks SET result_chunk_receipt_hash=? WHERE chunk_uid='localdocs:bound#0'",
    ).run(temporaryReceipt);
    assert.equal(counts(db).current, 0, "moving away from sealed bytes makes the old proof stale");

    assert.throws(
      () => db.prepare(
        `UPDATE chunks
            SET text='[Bound fixture]' || char(10) || char(10) || 'Different body.',
                result_chunk_receipt_hash=?
          WHERE chunk_uid='localdocs:bound#0'`,
      ).run(FIXTURE.chunk_receipt_hash),
      /sealed source-original chunk receipt cannot be revived/,
      "an UPDATE cannot put changed bytes back under the sealed digest",
    );
    assert.deepEqual(
      { ...db.prepare(
        "SELECT text,result_chunk_receipt_hash FROM chunks WHERE chunk_uid='localdocs:bound#0'",
      ).get() },
      {
        text: "[Bound fixture]\n\nSynthetic body.",
        result_chunk_receipt_hash: temporaryReceipt,
      },
      "the rejected statement leaves both bytes and the stale receipt cut unchanged",
    );

    assert.throws(
      () => db.prepare(
        `INSERT OR REPLACE INTO chunks
           (chunk_uid,doc_uid,chunk_ix,text,source,title,vector_id,
            bound_document_revision_id,result_chunk_receipt_hash)
         VALUES
           ('localdocs:bound#0','localdocs:bound',0,
            '[Bound fixture]' || char(10) || char(10) || 'Different body.',
            'localdocs','Bound fixture','localdocs:bound#0',?1,?2)`,
      ).run(FIXTURE.document_revision_id, FIXTURE.chunk_receipt_hash),
      /sealed source-original chunk receipt cannot be reinserted/,
      "SQLite REPLACE cannot bypass sealed-receipt anti-revival",
    );
    assert.equal(counts(db).current, 0);
  } finally {
    db.close();
  }
});

test("0045 freezes sealed document evidence while allowing a genuinely new revision", () => {
  const db = readyFixture();
  try {
    const originalMeta = db.prepare(
      "SELECT meta FROM documents WHERE doc_uid='localdocs:bound'",
    ).get().meta;
    assert.throws(
      () => db.prepare(
        `UPDATE documents
            SET provenance_receipt_status='partial',
                provenance_receipt_reason='text_provenance_unavailable'
          WHERE doc_uid='localdocs:bound'`,
      ).run(),
      /sealed source-original document evidence cannot be revised or revived/,
      "a low-level marker downgrade cannot race a later admission",
    );
    assert.throws(
      () => db.prepare(
        `INSERT OR REPLACE INTO documents
           (doc_uid,source,source_id,title,ingested_at,content_hash,meta,
            text_source,text_reliable,provenance_receipt_version,
            provenance_receipt_status,provenance_receipt_reason,provenance_receipt_digest,
            document_revision_id,source_original_binding_hash)
         SELECT doc_uid,source,source_id,title,ingested_at,content_hash,
                json_set(meta,'$.provenance_receipt.root_ids',json_array('localdocs:other')),
                text_source,text_reliable,provenance_receipt_version,
                provenance_receipt_status,provenance_receipt_reason,provenance_receipt_digest,
                document_revision_id,source_original_binding_hash
           FROM documents WHERE doc_uid='localdocs:bound'`,
      ).run(),
      /sealed source-original document evidence cannot be reinserted/,
      "INSERT OR REPLACE cannot retain sealed hashes over different provenance metadata",
    );
    assert.equal(
      db.prepare("SELECT meta FROM documents WHERE doc_uid='localdocs:bound'").get().meta,
      originalMeta,
    );

    const next = {
      ...FIXTURE,
      document_revision_id: revisionId("9"),
      binding_hash: digest("9"),
      document_content_hash: hex("a"),
      provenance_receipt_digest: hex("b"),
    };
    db.prepare(INSERT_BINDING).run(pick(next, [
      "source", "original_id", "document_revision_id", "original_content_sha256",
      "original_byte_count", "document_content_hash", "provenance_receipt_digest", "binding_hash",
    ]));
    db.prepare(
      `UPDATE documents
          SET ingested_at=8,
              uri='https://example.invalid/new-revision',
              client='new-client',
              content_hash=@document_content_hash,
              meta=json_set(meta,'$.revision_note','new revision'),
              provenance_receipt_digest=@provenance_receipt_digest,
              document_revision_id=@document_revision_id,
              source_original_binding_hash=@binding_hash
        WHERE doc_uid='localdocs:bound'`,
    ).run(pick(next, [
      "document_content_hash", "provenance_receipt_digest", "document_revision_id", "binding_hash",
    ]));
    assert.equal(counts(db).current, 0, "a new revision makes the old family historical");

    const nextChunkReceipt = digest("c");
    db.prepare(
      `UPDATE chunks
          SET document_date=1700000000000,
              client='new-client',category='new-category',
              top_folder='new-folder',platform='new-platform',
              vector_id='localdocs:new-revision#0',
              bound_document_revision_id=?,result_chunk_receipt_hash=?
        WHERE chunk_uid='localdocs:bound#0'`,
    ).run(next.document_revision_id, nextChunkReceipt);
    assert.deepEqual(
      { ...db.prepare(
        `SELECT client,category,top_folder,platform,vector_id,
                bound_document_revision_id,result_chunk_receipt_hash
           FROM chunks WHERE chunk_uid='localdocs:bound#0'`,
      ).get() },
      {
        client: "new-client",
        category: "new-category",
        top_folder: "new-folder",
        platform: "new-platform",
        vector_id: "localdocs:new-revision#0",
        bound_document_revision_id: next.document_revision_id,
        result_chunk_receipt_hash: nextChunkReceipt,
      },
      "a legitimate new revision can carry a fresh receipt and retrieval projection",
    );

    assert.throws(
      () => db.prepare(
        `UPDATE documents
            SET ingested_at=7,
                content_hash=@document_content_hash,
                meta=@provenance_meta,
                provenance_receipt_digest=@provenance_receipt_digest,
                document_revision_id=@document_revision_id,
                source_original_binding_hash=@binding_hash
          WHERE doc_uid='localdocs:bound'`,
      ).run(pick(FIXTURE, [
        "document_content_hash", "provenance_meta", "provenance_receipt_digest",
        "document_revision_id", "binding_hash",
      ])),
      /sealed source-original document evidence cannot be revised or revived/,
      "a later UPDATE cannot roll the document back into an old sealed revision",
    );
    assert.equal(
      db.prepare("SELECT document_revision_id FROM documents WHERE doc_uid='localdocs:bound'")
        .get().document_revision_id,
      next.document_revision_id,
    );
  } finally {
    db.close();
  }
});

test("0045 freezes every sealed retrieval projection and rechecks the registered source kind", () => {
  const db = readyFixture();
  try {
    db.prepare(INSERT_ADMISSION).run(admission());
    assert.equal(counts(db).current, 1);

    const documentProjectionMutations = [
      ["uri", "https://example.invalid/changed"],
      ["document_date", 1700000000000],
      ["date_source", "provided"],
      ["date_reliable", 1],
      ["client", "changed-client"],
      ["category", "changed-category"],
      ["top_folder", "changed-folder"],
      ["platform", "changed-platform"],
      ["entity_slug", "changed-entity"],
    ];
    for (const [column, value] of documentProjectionMutations) {
      assert.throws(
        () => db.prepare(
          `UPDATE documents SET ${column}=? WHERE doc_uid='localdocs:bound'`,
        ).run(value),
        /sealed source-original document evidence cannot be revised or revived/,
        `${column} cannot change under a sealed document revision`,
      );
    }
    assert.throws(
      () => db.prepare(
        `INSERT OR REPLACE INTO documents
           (doc_uid,source,source_id,title,uri,document_date,date_source,date_reliable,
            client,category,top_folder,platform,ingested_at,content_hash,meta,
            text_source,text_reliable,entity_slug,provenance_receipt_version,
            provenance_receipt_status,provenance_receipt_reason,provenance_receipt_digest,
            document_revision_id,source_original_binding_hash,deleted_at)
         SELECT doc_uid,source,source_id,title,'https://example.invalid/replaced',
                document_date,date_source,date_reliable,client,category,top_folder,platform,
                ingested_at,content_hash,meta,text_source,text_reliable,entity_slug,
                provenance_receipt_version,provenance_receipt_status,
                provenance_receipt_reason,provenance_receipt_digest,
                document_revision_id,source_original_binding_hash,deleted_at
           FROM documents WHERE doc_uid='localdocs:bound'`,
      ).run(),
      /sealed source-original document evidence cannot be reinserted/,
      "INSERT OR REPLACE cannot change a document projection under sealed evidence",
    );

    const chunkProjectionMutations = [
      ["id", 101],
      ["chunk_uid", "localdocs:changed#0"],
      ["doc_uid", "localdocs:changed"],
      ["document_date", 1700000000000],
      ["client", "changed-client"],
      ["category", "changed-category"],
      ["top_folder", "changed-folder"],
      ["platform", "changed-platform"],
      ["vector_id", "changed-vector-id"],
    ];
    for (const [column, value] of chunkProjectionMutations) {
      assert.throws(
        () => db.prepare(
          `UPDATE chunks SET ${column}=? WHERE chunk_uid='localdocs:bound#0'`,
        ).run(value),
        /sealed source-original chunk receipt cannot be revived|exact current document revision/,
        `${column} cannot change while retaining a sealed chunk receipt`,
      );
    }
    assert.throws(
      () => db.prepare(
        `INSERT OR REPLACE INTO chunks
           (id,chunk_uid,doc_uid,chunk_ix,text,source,title,document_date,
            client,category,top_folder,platform,vector_id,
            bound_document_revision_id,result_chunk_receipt_hash)
         SELECT id,chunk_uid,doc_uid,chunk_ix,text,source,title,document_date,
                'replaced-client',category,top_folder,platform,vector_id,
                bound_document_revision_id,result_chunk_receipt_hash
           FROM chunks WHERE chunk_uid='localdocs:bound#0'`,
      ).run(),
      /sealed source-original chunk receipt cannot be reinserted/,
      "INSERT OR REPLACE cannot change a denormalized projection under a sealed receipt",
    );
    assert.equal(counts(db).current, 1, "rejected mutations leave current authority intact");

    db.prepare("UPDATE sources SET kind='drive' WHERE name='localdocs'").run();
    assert.equal(counts(db).current, 0,
      "a source that is no longer a registered direct upload loses current authority");
    db.prepare("UPDATE sources SET kind='upload' WHERE name='localdocs'").run();
    assert.equal(counts(db).current, 0,
      "restoring visible source state cannot revive an older full-result verification");
  } finally {
    db.close();
  }
});

test("0045 full-result generation invalidates non-family retrieval changes without count drift", async (t) => {
  const cases = [
    {
      name: "a lower-ranked document projection changes",
      mutate(db) {
        db.prepare(
          "UPDATE documents SET uri='https://example.invalid/lower-changed' WHERE doc_uid='otherdocs:lower'",
        ).run();
      },
    },
    {
      name: "a lower-ranked chunk projection changes",
      mutate(db) {
        db.prepare(
          "UPDATE chunks SET client='changed-client' WHERE chunk_uid='otherdocs:lower#0'",
        ).run();
      },
    },
    {
      name: "a non-target registered source changes retrieval authority",
      mutate(db) {
        db.prepare("UPDATE sources SET kind='upload' WHERE name='otherdocs'").run();
      },
    },
    {
      name: "the memory visibility ledger changes",
      mutate(db) {
        db.prepare(
          `INSERT INTO memory_supersessions
             (predecessor_doc_uid,successor_doc_uid,predecessor_content_hash,
              successor_content_hash,channel,created_at)
           VALUES ('otherdocs:lower','otherdocs:successor','other-document-hash',
                   'successor-document-hash','local_mcp',30)`,
        ).run();
      },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const db = readyFixture({ nonFamily: true });
      try {
        db.prepare(INSERT_ADMISSION).run(admission());
        assert.equal(counts(db).current, 1);
        const before = db.prepare(
          `SELECT source_original_retrieval_generation AS generation,
                  outbox_generation,
                  (SELECT count(*) FROM chunks) AS chunk_count
             FROM install_state WHERE id=1`,
        ).get();
        scenario.mutate(db);
        const after = db.prepare(
          `SELECT source_original_retrieval_generation AS generation,
                  outbox_generation,
                  (SELECT count(*) FROM chunks) AS chunk_count
             FROM install_state WHERE id=1`,
        ).get();
        assert.equal(after.generation, before.generation + 1);
        assert.equal(after.outbox_generation, before.outbox_generation);
        assert.equal(after.chunk_count, before.chunk_count);
        assert.equal(counts(db).current, 0,
          "a non-family response change demotes current authority without deleting history");
        assert.equal(counts(db).accepted, 1);
      } finally {
        db.close();
      }
    });
  }

  await t.test("an exact no-op update does not churn the generation", () => {
    const db = readyFixture({ nonFamily: true });
    try {
      db.prepare(INSERT_ADMISSION).run(admission());
      const before = db.prepare(
        "SELECT source_original_retrieval_generation AS generation FROM install_state WHERE id=1",
      ).get().generation;
      db.prepare("UPDATE documents SET uri=uri WHERE doc_uid='otherdocs:lower'").run();
      assert.equal(db.prepare(
        "SELECT source_original_retrieval_generation AS generation FROM install_state WHERE id=1",
      ).get().generation, before);
      assert.equal(counts(db).current, 1);
    } finally {
      db.close();
    }
  });
});

test("0045 retrieval generation is monotonic and required at verification seal", async (t) => {
  await t.test("a stale generation cannot be inserted into local verification", () => {
    const db = readyFixture({ verification: false, nonFamily: true });
    try {
      const current = db.prepare(
        "SELECT source_original_retrieval_generation AS generation FROM install_state WHERE id=1",
      ).get().generation;
      assert.throws(
        () => insertVerification(db, { retrieval_generation: current - 1 }),
        /retrieval corpus changed before verification seal/,
      );
      assert.equal(db.prepare(
        "SELECT count(*) AS n FROM source_original_result_family_verifications",
      ).get().n, 0);
    } finally {
      db.close();
    }
  });

  await t.test("direct counter rollback and singleton replacement cannot revive history", () => {
    const db = readyFixture({ nonFamily: true });
    try {
      db.prepare(INSERT_ADMISSION).run(admission());
      const originalGeneration = db.prepare(
        "SELECT source_original_retrieval_generation AS generation FROM install_state WHERE id=1",
      ).get().generation;
      db.prepare(
        "UPDATE documents SET uri='https://example.invalid/stale' WHERE doc_uid='otherdocs:lower'",
      ).run();
      assert.equal(counts(db).current, 0);
      assert.throws(
        () => db.prepare(
          "UPDATE install_state SET source_original_retrieval_generation=? WHERE id=1",
        ).run(originalGeneration),
        /retrieval generation must advance monotonically/,
      );
      assert.throws(
        () => db.prepare(
          `INSERT OR REPLACE INTO install_state
             (id,client_slug,product_version,schema_version,gate_version,installed_at,ring,
              source_original_retrieval_generation)
           SELECT id,client_slug,product_version,schema_version,gate_version,installed_at,ring,?
             FROM install_state WHERE id=1`,
        ).run(originalGeneration),
        /retrieval generation must advance on singleton replacement/,
      );
      assert.throws(
        () => db.prepare("DELETE FROM install_state WHERE id=1").run(),
        /retrieval generation singleton cannot be deleted/,
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM install_state WHERE id=1").get().count,
        1,
      );
      assert.equal(counts(db).current, 0);
    } finally {
      db.close();
    }
  });
});

test("0045 lets deletion demote a sealed revision but forbids undeleting its old authority", () => {
  const db = readyFixture();
  try {
    db.prepare(INSERT_ADMISSION).run(admission());
    assert.equal(counts(db).current, 1);

    db.prepare(
      "UPDATE documents SET deleted_at=30,removal_reason='approved source deletion' WHERE doc_uid='localdocs:bound'",
    ).run();
    assert.equal(counts(db).current, 0,
      "soft deletion makes the portable acceptance historical without deleting it");
    assert.equal(counts(db).accepted, 1);

    assert.throws(
      () => db.prepare(
        "UPDATE documents SET deleted_at=NULL,removal_reason=NULL WHERE doc_uid='localdocs:bound'",
      ).run(),
      /sealed source-original document evidence cannot be revised or revived/,
      "the old sealed revision cannot regain authority through undelete",
    );
    assert.equal(
      db.prepare("SELECT deleted_at FROM documents WHERE doc_uid='localdocs:bound'").get().deleted_at,
      30,
    );
  } finally {
    db.close();
  }
});

test("0045 admission and currentness require live complete provenance and exact text state", async (t) => {
  await t.test("an invalid marker present when the family was sealed cannot authorize admission", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyThrough(db, 45);
      installState(db);
      insertCurrentFamily(db);
      db.prepare(INSERT_OBSERVATION).run(priorObservation());
      db.prepare(
        `UPDATE documents
            SET provenance_receipt_status='partial',
                provenance_receipt_reason='text_provenance_unavailable'
          WHERE doc_uid='localdocs:bound'`,
      ).run();
      insertPortableFamily(db);
      insertVerification(db);
      assert.equal(db.prepare(
        "SELECT count(*) AS n FROM source_original_current_result_family_verifications",
      ).get().n, 0);
      assert.throws(
        () => db.prepare(INSERT_ADMISSION).run(admission()),
        /verification is stale/,
      );
      assert.deepEqual(counts(db), {
        admissions: 0,
        resolutions: 0,
        activations: 0,
        accepted: 0,
        current: 0,
      });
    } finally {
      db.close();
    }
  });

  await t.test("the accepted text state must match every sealed document", () => {
    const db = readyFixture();
    try {
      assert.throws(
        () => db.prepare(INSERT_ADMISSION).run(admission({ text_state: "ocr_reliable" })),
        /verification is stale/,
      );
      assert.deepEqual(counts(db), {
        admissions: 0,
        resolutions: 0,
        activations: 0,
        accepted: 0,
        current: 0,
      });
    } finally {
      db.close();
    }
  });

  await t.test("current authority dynamically disappears if marker evidence is corrupt", () => {
    const db = readyFixture();
    try {
      db.prepare(INSERT_ADMISSION).run(admission());
      assert.equal(counts(db).current, 1);
      db.exec("DROP TRIGGER documents_source_original_sealed_evidence_no_revival_update");
      db.prepare(
        `UPDATE documents
            SET provenance_receipt_status='partial',
                provenance_receipt_reason='text_provenance_unavailable'
          WHERE doc_uid='localdocs:bound'`,
      ).run();
      assert.equal(counts(db).current, 0,
        "the view independently rechecks marker completeness on every read");
      assert.equal(counts(db).accepted, 1, "portable history remains present but non-authorizing");
    } finally {
      db.close();
    }
  });
});

test("0045 rolls back portable and local children when the accepted observation conflicts", () => {
  const db = readyFixture();
  try {
    db.prepare(INSERT_OBSERVATION).run(priorObservation({
      original_id: originalId("9"),
      run_id: "repair_run",
      plan_id: hex("9"),
      source_snapshot_id: digest("a"),
      target_set_hash: digest("b"),
      target_count: 2,
      original_content_sha256: hex("c"),
      original_byte_count: 5,
      result_document_set_hash: digest("e"),
      observation_hash: digest("6"),
    }));
    assert.throws(
      () => db.prepare(INSERT_ADMISSION).run(admission()),
      (error) => {
        assert.match(error.message, /run exceeds its sealed target count/);
        return true;
      },
      "the last child catches the pre-existing run cardinality",
    );
    assert.deepEqual(counts(db), {
      admissions: 0,
      resolutions: 0,
      activations: 0,
      accepted: 0,
      current: 0,
    }, "the AFTER-trigger statement rolls every child back atomically");
  } finally {
    db.close();
  }
});

test("0045 rejects stale deployment, outbox, and result-family cuts", async (t) => {
  await t.test("install-state generation drift", () => {
    const db = readyFixture();
    try {
      db.prepare("UPDATE install_state SET outbox_generation=outbox_generation+1 WHERE id=1").run();
      assert.throws(
        () => db.prepare(INSERT_ADMISSION).run(admission()),
        /verification is stale/,
      );
      assert.deepEqual(counts(db), { admissions: 0, resolutions: 0, activations: 0, accepted: 0, current: 0 });
    } finally {
      db.close();
    }
  });

  await t.test("a pending global outbox row", () => {
    const db = readyFixture();
    try {
      db.prepare(
        `INSERT INTO vector_outbox (chunk_uid,op,queued_at,vector_id)
         VALUES ('other:pending#0','upsert',21,'other:pending#0')`,
      ).run();
      assert.throws(
        () => db.prepare(INSERT_ADMISSION).run(admission()),
        /verification is stale/,
      );
      assert.deepEqual(counts(db), { admissions: 0, resolutions: 0, activations: 0, accepted: 0, current: 0 });
    } finally {
      db.close();
    }
  });

  await t.test("a later exact-family chunk", () => {
    const db = readyFixture();
    try {
      db.prepare(
        `INSERT INTO chunks
           (chunk_uid,doc_uid,chunk_ix,text,source,title,vector_id,
            bound_document_revision_id,result_chunk_receipt_hash)
         VALUES ('localdocs:bound#1','localdocs:bound',1,
                 '[Bound fixture]' || char(10) || char(10) || 'Later body.',
                 'localdocs','Bound fixture','localdocs:bound#1',?,?)`,
      ).run(FIXTURE.document_revision_id, digest("6"));
      assert.throws(
        () => db.prepare(INSERT_ADMISSION).run(admission()),
        /verification is stale/,
      );
      assert.deepEqual(counts(db), { admissions: 0, resolutions: 0, activations: 0, accepted: 0, current: 0 });
    } finally {
      db.close();
    }
  });
});

test("0045 preserves accepted history through recovery but requires a fresh local activation", () => {
  const target = new DatabaseSync(":memory:");
  try {
    applyThrough(target, 45);
    installState(target);
    const generationBeforeImport = target.prepare(
      "SELECT source_original_retrieval_generation AS generation FROM install_state WHERE id=1",
    ).get().generation;
    target.prepare(
      `INSERT INTO source_original_result_family_recovery_state (id,mode)
       VALUES (1,'verified_recovery_import')`,
    ).run();
    insertCurrentFamily(target);
    target.prepare(INSERT_OBSERVATION).run(priorObservation());
    target.prepare(INSERT_OBSERVATION).run(acceptedObservation());
    insertPortableFamily(target);
    target.prepare(INSERT_RESOLUTION).run(resolutionParams());
    assert.throws(
      () => insertVerification(target),
      /verification is unavailable during recovery/,
      "deployment-local verification cannot enter the recovery artifact",
    );
    target.prepare(
      `DELETE FROM source_original_result_family_recovery_state
        WHERE id=1 AND mode='verified_recovery_import'`,
    ).run();
    assert.equal(target.prepare(
      "SELECT source_original_retrieval_generation AS generation FROM install_state WHERE id=1",
    ).get().generation, generationBeforeImport,
    "authenticated recovery rows do not inherit or churn deployment-local retrieval generation");

    assert.deepEqual(counts(target), {
      admissions: 0,
      resolutions: 1,
      activations: 0,
      accepted: 1,
      current: 0,
    }, "portable acceptance is historical until this deployment proves it again");

    const targetVerificationHash = digest("6");
    insertVerification(target, {
      verification_hash: targetVerificationHash,
      vector_readiness_hash: digest("7"),
      retrieval_probe_id: probeId("8"),
      retrieval_result_hash: digest("9"),
      citation_set_hash: digest("a"),
      verified_at: 30,
    });
    assert.throws(
      () => target.prepare(
        `INSERT INTO source_original_accepted_resolution_activations
           (contract_version,tenant_id,resolution_hash,verification_hash,activation_hash,activated_at)
         VALUES (1,'primary',?,?,?,?)`,
      ).run(FIXTURE.resolution_hash, targetVerificationHash, digest("b"), 31),
      /requires a current exact admission and verification/,
      "direct SQL cannot reactivate portable history",
    );
    target.prepare(INSERT_ADMISSION).run(admission({
      verification_hash: targetVerificationHash,
      activation_hash: digest("b"),
      activated_at: 31,
    }));
    const restored = counts(target);
    assert.deepEqual(restored, {
      admissions: 0,
      resolutions: 1,
      activations: 1,
      accepted: 1,
      current: 1,
    }, "fresh target verification creates only deployment-local activation");
    assert.equal(
      target.prepare(
        "SELECT admission_verification_hash FROM source_original_accepted_resolutions",
      ).get().admission_verification_hash,
      FIXTURE.verification_hash,
      "reactivation never rewrites the original deployment's historical verification digest",
    );

    target.prepare(
      `INSERT INTO vector_outbox (chunk_uid,op,queued_at,vector_id)
       VALUES ('post-activation:pending','upsert',32,'post-activation:pending')`,
    ).run();
    assert.equal(
      target.prepare("SELECT count(*) AS n FROM source_original_current_accepted_resolutions").get().n,
      0,
      "a later writer dynamically removes current authority without deleting history",
    );
    assert.equal(target.prepare("SELECT count(*) AS n FROM source_original_accepted_resolutions").get().n, 1);
  } finally {
    target.close();
  }
});

test("0045 recovery close refuses incomplete or deployment-local accepted state", async (t) => {
  await t.test("an accepted observation without its portable resolution", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyThrough(db, 45);
      db.prepare(
        `INSERT INTO source_original_result_family_recovery_state (id,mode)
         VALUES (1,'verified_recovery_import')`,
      ).run();
      db.prepare(INSERT_OBSERVATION).run(acceptedObservation());
      assert.throws(
        () => db.prepare("DELETE FROM source_original_result_family_recovery_state WHERE id=1").run(),
        /accepted observations require exact portable resolutions/,
      );
      assert.equal(db.prepare("SELECT count(*) AS n FROM source_original_result_family_recovery_state").get().n, 1,
        "a failed close leaves the recovery fence active");
    } finally {
      db.close();
    }
  });

  await t.test("a schema-45-only row prevents opening the empty-target marker", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyThrough(db, 45);
      db.exec("DROP TRIGGER source_original_accepted_resolution_activation_validate_insert");
      db.prepare(
        `INSERT INTO source_original_accepted_resolution_activations
           (contract_version,tenant_id,resolution_hash,verification_hash,activation_hash,activated_at)
         VALUES (1,'primary',?,?,?,1)`,
      ).run(FIXTURE.resolution_hash, FIXTURE.verification_hash, FIXTURE.activation_hash);
      assert.throws(
        () => db.prepare(
          `INSERT INTO source_original_result_family_recovery_state (id,mode)
           VALUES (1,'verified_recovery_import')`,
        ).run(),
        /accepted resolution recovery marker requires an empty target/,
        "the schema-45 guard still fires when every schema-44 data table is empty",
      );
    } finally {
      db.close();
    }
  });

  for (const portableState of ["source_original_id_key_state", "source_original_observations"]) {
    await t.test(`${portableState} prevents reopening the recovery marker`, () => {
      const db = new DatabaseSync(":memory:");
      try {
        applyThrough(db, 45);
        if (portableState === "source_original_id_key_state") {
          db.prepare(
            `INSERT INTO source_original_id_key_state (tenant_id,signing_salt)
             VALUES ('primary',?)`,
          ).run(hex("a"));
        } else {
          db.prepare(
            `INSERT INTO source_original_result_family_recovery_state (id,mode)
             VALUES (1,'verified_recovery_import')`,
          ).run();
          db.prepare(INSERT_OBSERVATION).run(priorObservation());
          db.prepare(
            "DELETE FROM source_original_result_family_recovery_state WHERE id=1",
          ).run();
        }
        assert.throws(
          () => db.prepare(
            `INSERT INTO source_original_result_family_recovery_state (id,mode)
             VALUES (1,'verified_recovery_import')`,
          ).run(),
          /accepted resolution recovery marker requires an empty target/,
        );
      } finally {
        db.close();
      }
    });
  }

  await t.test("two accepted observations cannot share one portable resolution", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyThrough(db, 45);
      installState(db);
      db.prepare(
        `INSERT INTO source_original_result_family_recovery_state (id,mode)
         VALUES (1,'verified_recovery_import')`,
      ).run();
      insertCurrentFamily(db);
      db.prepare(INSERT_OBSERVATION).run(priorObservation());
      db.prepare(INSERT_OBSERVATION).run(acceptedObservation());
      db.prepare(INSERT_OBSERVATION).run(acceptedObservation({ run_id: "repair_duplicate" }));
      insertPortableFamily(db);
      db.prepare(INSERT_RESOLUTION).run(resolutionParams());

      assert.throws(
        () => db.prepare("DELETE FROM source_original_result_family_recovery_state WHERE id=1").run(),
        /accepted resolutions require exact portable history/,
        "recovery close requires one accepted observation per portable resolution",
      );
      assert.equal(db.prepare(
        "SELECT count(*) AS n FROM source_original_result_family_recovery_state",
      ).get().n, 1, "a failed close leaves the recovery fence active");
    } finally {
      db.close();
    }
  });

  await t.test("a deployment-local verification keeps the recovery marker open", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyThrough(db, 45);
      installState(db);
      db.prepare(
        `INSERT INTO source_original_result_family_recovery_state (id,mode)
         VALUES (1,'verified_recovery_import')`,
      ).run();
      insertCurrentFamily(db);
      db.prepare(INSERT_OBSERVATION).run(priorObservation());
      db.prepare(INSERT_OBSERVATION).run(acceptedObservation());
      insertPortableFamily(db);
      db.prepare(INSERT_RESOLUTION).run(resolutionParams());
      db.exec("DROP TRIGGER source_original_result_family_verification_recovery_block");
      insertVerification(db);
      assert.throws(
        () => db.prepare("DELETE FROM source_original_result_family_recovery_state WHERE id=1").run(),
        /recovery contains deployment-local state/,
      );
      assert.equal(db.prepare(
        "SELECT count(*) AS n FROM source_original_result_family_recovery_state",
      ).get().n, 1);
    } finally {
      db.close();
    }
  });
});
