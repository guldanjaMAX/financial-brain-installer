import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { splitStatements } from "../brain.mjs";

const MIGRATIONS = fileURLToPath(new URL("../migrations/d1/", import.meta.url));
const FILES = readdirSync(MIGRATIONS)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();

function apply(db, file) {
  const source = readFileSync(join(MIGRATIONS, file), "utf8");
  for (const statement of splitStatements(source)) db.exec(statement);
}

function applyThrough(db, version) {
  for (const file of FILES.filter((name) => Number(name.slice(0, 4)) <= version)) {
    apply(db, file);
  }
}

const digest = (character) => `sha256:${character.repeat(64)}`;
const originalId = (character) => `hmac-sha256:${character.repeat(64)}`;

function observation(overrides = {}) {
  return {
    contract_version: 1,
    tenant_id: "primary",
    source: "localdocs",
    original_id: originalId("1"),
    locator_kind: "source_relative_path",
    run_id: "discovery_run",
    plan_id: "2".repeat(64),
    source_snapshot_id: digest("3"),
    target_set_hash: digest("4"),
    target_count: 2,
    observation_stage: "discovery",
    outcome: "gap",
    reason_code: "provenance_unassessed",
    text_state: "native_readable",
    original_content_sha256: "5".repeat(64),
    original_byte_count: 123,
    page_count: null,
    page_count_state: "not_applicable",
    result_document_count: 0,
    result_document_set_hash: digest("6"),
    resolves_observation_hash: null,
    observation_hash: digest("7"),
    recorded_at: 1,
    ...overrides,
  };
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

test("0042 adds an empty original-observation ledger to populated schema 41 without backfill", () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyThrough(db, 41);
    db.prepare(
      `INSERT INTO install_state
         (id,client_slug,product_version,schema_version,gate_version,installed_at,ring)
       VALUES (1,'fixture','0.4.6',41,0,'2026-09-11T00:00:00Z','test')`,
    ).run();
    db.prepare(
      `INSERT INTO sources (name,kind,status,created_at)
       VALUES ('localdocs','upload','ready','2026-09-11T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO documents
         (doc_uid,source,source_id,title,ingested_at,content_hash,meta,text_source,text_reliable)
       VALUES ('localdocs:legacy','localdocs','legacy','Legacy fixture',1,'legacy-hash',
               '{}','native',1)`,
    ).run();
    db.prepare(
      `INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source,title)
       VALUES ('localdocs:legacy#0','localdocs:legacy',0,'legacy body','localdocs','Legacy fixture')`,
    ).run();
    const before = {
      document: { ...db.prepare("SELECT * FROM documents WHERE doc_uid='localdocs:legacy'").get() },
      chunk: { ...db.prepare("SELECT * FROM chunks WHERE chunk_uid='localdocs:legacy#0'").get() },
    };

    const migration = FILES.find((name) => name.startsWith("0042_"));
    assert.ok(migration, "the schema-42 migration exists");
    apply(db, migration);

    assert.deepEqual(
      {
        document: { ...db.prepare("SELECT * FROM documents WHERE doc_uid='localdocs:legacy'").get() },
        chunk: { ...db.prepare("SELECT * FROM chunks WHERE chunk_uid='localdocs:legacy#0'").get() },
      },
      before,
      "0042 does not rewrite legacy corpus rows",
    );
    assert.equal(db.prepare("SELECT count(*) AS n FROM source_original_observations").get().n, 0,
      "legacy documents are not relabeled as directly observed originals");
    const key = db.prepare(
      "SELECT signing_salt FROM source_original_id_key_state WHERE tenant_id='primary'",
    ).get();
    assert.match(key?.signing_salt || "", /^[a-f0-9]{64}$/,
      "an existing install receives one independent durable identity salt");
  } finally {
    db.close();
  }
});

test("0042 leaves schema-first recovery ready for the source key", () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyThrough(db, 42);
    assert.equal(db.prepare("SELECT count(*) AS n FROM install_state").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM source_original_id_key_state").get().n, 0,
      "schema creation does not manufacture a key before durable source rows are imported");

    const sourceSalt = "a".repeat(64);
    db.prepare(
      "INSERT INTO source_original_id_key_state (tenant_id,signing_salt) VALUES ('primary',?)",
    ).run(sourceSalt);
    assert.equal(db.prepare(
      "SELECT signing_salt FROM source_original_id_key_state WHERE tenant_id='primary'",
    ).get().signing_salt, sourceSalt);
    assert.throws(
      () => db.prepare(
        "UPDATE source_original_id_key_state SET signing_salt=? WHERE tenant_id='primary'",
      ).run("b".repeat(64)),
      /source original identity key state is immutable/,
    );
    assert.throws(
      () => db.prepare("DELETE FROM source_original_id_key_state WHERE tenant_id='primary'").run(),
      /source original identity key state is required/,
    );
    assert.throws(
      () => db.prepare(
        "INSERT OR REPLACE INTO source_original_id_key_state (tenant_id,signing_salt) VALUES ('primary',?)",
      ).run("b".repeat(64)),
      /source original identity key state cannot be replaced/,
      "SQLite REPLACE cannot rotate the durable original identity key",
    );
    assert.deepEqual(
      { ...db.prepare("SELECT tenant_id,signing_salt FROM source_original_id_key_state").get() },
      { tenant_id: "primary", signing_salt: sourceSalt },
    );
  } finally {
    db.close();
  }
});

test("0042 enforces accepted-outcome, run-binding, and append-only boundaries in SQLite", () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyThrough(db, 42);
    const insert = db.prepare(INSERT_OBSERVATION);
    const first = observation();
    insert.run(first);

    assert.throws(
      () => insert.run(observation({
        original_id: originalId("8"),
        source_snapshot_id: digest("9"),
        observation_hash: digest("a"),
        recorded_at: 2,
      })),
      /source original observation run binding is immutable/,
      "a run cannot drift to a different source snapshot",
    );

    insert.run(observation({
      original_id: originalId("8"),
      observation_hash: digest("9"),
      recorded_at: 2,
    }));
    assert.equal(db.prepare("SELECT count(*) AS n FROM source_original_observations").get().n, 2,
      "one run may append the members of its bound target set");

    assert.throws(
      () => insert.run(observation({
        original_id: originalId("a"),
        observation_hash: digest("b"),
        recorded_at: 3,
      })),
      /source original observation run exceeds its sealed target count/,
      "direct SQL cannot append more distinct originals than the run declared",
    );

    assert.throws(
      () => insert.run(observation({
        original_id: originalId("f"),
        run_id: "repair_run",
        target_count: 1,
        observation_stage: "repair",
        outcome: "accepted",
        reason_code: "accepted_provenance_verified",
        result_document_count: 1,
        resolves_observation_hash: first.observation_hash,
        observation_hash: digest("a"),
        recorded_at: 5,
      })),
      /accepted source-original outcomes require a future raw-original binding/,
      "direct SQL cannot manufacture an accepted repair receipt",
    );

    assert.throws(
      () => db.prepare(
        "UPDATE source_original_observations SET recorded_at=99 WHERE sequence=1",
      ).run(),
      /source original observations are append-only/,
    );
    assert.throws(
      () => db.prepare("DELETE FROM source_original_observations WHERE sequence=1").run(),
      /source original observations are append-only/,
    );
    const replace = db.prepare(INSERT_OBSERVATION.replace(
      "INSERT INTO source_original_observations",
      "INSERT OR REPLACE INTO source_original_observations",
    ));
    assert.throws(
      () => replace.run(observation({ recorded_at: 99 })),
      /source original observation cannot be replaced/,
      "SQLite REPLACE cannot recreate an existing run/original receipt",
    );
    const replaceSequence = db.prepare(INSERT_OBSERVATION
      .replace(
        "INSERT INTO source_original_observations\n    (contract_version",
        "INSERT OR REPLACE INTO source_original_observations\n    (sequence,contract_version",
      )
      .replace("VALUES\n    (@contract_version", "VALUES\n    (@sequence,@contract_version"));
    assert.throws(
      () => replaceSequence.run(observation({
        sequence: 1,
        run_id: "unrelated_run",
        original_id: originalId("e"),
        target_count: 1,
        observation_hash: digest("e"),
        recorded_at: 100,
      })),
      /source original observation cannot be replaced/,
      "SQLite REPLACE cannot reuse another receipt's explicit sequence",
    );
    assert.deepEqual(
      { ...db.prepare(
        "SELECT sequence,run_id,original_id,recorded_at FROM source_original_observations WHERE sequence=1",
      ).get() },
      { sequence: 1, run_id: first.run_id, original_id: first.original_id, recorded_at: first.recorded_at },
    );
    assert.equal(db.prepare("SELECT count(*) AS n FROM source_original_observations").get().n, 2,
      "rejected writes leave the immutable observation history intact");
  } finally {
    db.close();
  }
});
