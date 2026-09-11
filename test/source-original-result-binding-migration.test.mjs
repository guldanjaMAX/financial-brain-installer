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
const DOCUMENT_UID = "localdocs:bound";

function binding(overrides = {}) {
  return {
    contract_version: 1,
    tenant_id: "primary",
    source: "localdocs",
    original_id: originalId("1"),
    locator_kind: "source_relative_path",
    document_revision_id: revisionId("2"),
    original_content_sha256: hex("3"),
    original_byte_count: 123,
    document_content_hash: hex("4"),
    provenance_receipt_digest: hex("5"),
    binding_hash: digest("6"),
    bound_at: 7,
    ...overrides,
  };
}

const INSERT_BINDING = `
  INSERT INTO source_original_result_bindings
    (contract_version,tenant_id,source,original_id,locator_kind,
     document_revision_id,original_content_sha256,original_byte_count,
     document_content_hash,provenance_receipt_digest,binding_hash,bound_at)
  VALUES
    (@contract_version,@tenant_id,@source,@original_id,@locator_kind,
     @document_revision_id,@original_content_sha256,@original_byte_count,
     @document_content_hash,@provenance_receipt_digest,@binding_hash,@bound_at)`;

const INSERT_ACCEPTED_OBSERVATION = `
  INSERT INTO source_original_observations
    (contract_version,tenant_id,source,original_id,locator_kind,run_id,plan_id,
     source_snapshot_id,target_set_hash,target_count,observation_stage,outcome,
     reason_code,text_state,original_content_sha256,original_byte_count,page_count,
     page_count_state,result_document_count,result_document_set_hash,
     resolves_observation_hash,observation_hash,recorded_at)
  VALUES
    (1,'primary','localdocs',@original_id,'source_relative_path','repair_run',@plan_id,
     @source_snapshot_id,@target_set_hash,1,'repair','accepted',
     'accepted_provenance_verified','native_readable',@original_content_sha256,123,NULL,
     'not_applicable',1,@result_document_set_hash,
     @resolves_observation_hash,@observation_hash,8)`;

function acceptedParams(character = "1") {
  return {
    original_id: originalId(character),
    plan_id: hex("d"),
    source_snapshot_id: digest("e"),
    target_set_hash: digest("f"),
    original_content_sha256: hex("1"),
    result_document_set_hash: digest("2"),
    resolves_observation_hash: digest("3"),
    observation_hash: digest(character),
  };
}

test("0043 adds nullable revision state without relabeling legacy documents", () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyThrough(db, 42);
    db.prepare(
      `INSERT INTO documents
         (doc_uid,source,source_id,title,ingested_at,content_hash,meta,
          text_source,text_reliable,provenance_receipt_version,
          provenance_receipt_status,provenance_receipt_reason,provenance_receipt_digest)
       VALUES ('localdocs:legacy','localdocs','legacy','Legacy fixture',1,?,
               '{}','native',1,1,'complete','lineage_and_text_recorded',?)`,
    ).run(hex("a"), hex("b"));

    const migration = FILES.find((name) => name.startsWith("0043_"));
    assert.ok(migration, "the schema-43 migration exists");
    apply(db, migration);

    assert.deepEqual(
      { ...db.prepare(
        `SELECT document_revision_id,source_original_binding_hash
           FROM documents WHERE doc_uid='localdocs:legacy'`,
      ).get() },
      { document_revision_id: null, source_original_binding_hash: null },
      "legacy content remains explicitly unbound",
    );
    assert.equal(db.prepare("SELECT count(*) AS n FROM source_original_result_bindings").get().n, 0,
      "the migration does not manufacture raw-original bindings");

    const acceptedTrigger = db.prepare(
      `SELECT sql FROM sqlite_master
        WHERE type='trigger' AND name='source_original_observation_accepted_disabled'`,
    ).get();
    assert.match(acceptedTrigger?.sql || "", /NEW\.outcome = 'accepted'/,
      "schema 43's accepted-outcome block remains installed");
    assert.throws(
      () => db.prepare(INSERT_ACCEPTED_OBSERVATION).run({
        original_id: originalId("c"),
        plan_id: hex("d"),
        source_snapshot_id: digest("e"),
        target_set_hash: digest("f"),
        original_content_sha256: hex("1"),
        result_document_set_hash: digest("2"),
        resolves_observation_hash: digest("3"),
        observation_hash: digest("4"),
      }),
      /accepted source-original outcomes require a future result-family receipt and retrieval proof/,
      "representing bindings does not enable accepted repair outcomes",
    );
  } finally {
    db.close();
  }
});

test("0043 keeps accepted observations blocked at every committed statement boundary", () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyThrough(db, 42);
    const migration = FILES.find((name) => name.startsWith("0043_"));
    const statements = splitStatements(readFileSync(join(MIGRATIONS, migration), "utf8"));
    for (let position = 0; position <= statements.length; position++) {
      assert.throws(
        () => db.prepare(INSERT_ACCEPTED_OBSERVATION).run(acceptedParams("a")),
        /accepted source-original outcomes require/,
        `accepted remains blocked after ${position} of ${statements.length} statements`,
      );
      if (position < statements.length) db.exec(statements[position]);
    }
  } finally {
    db.close();
  }
});

test("0043 restart adopts only the exact CHECK-constrained document columns", async () => {
  const migration = FILES.find((name) => name.startsWith("0043_"));
  assert.ok(migration, "the schema-43 migration exists");
  const statements = splitStatements(readFileSync(join(MIGRATIONS, migration), "utf8"));

  for (const committedColumns of [1, 2]) {
    const db = new DatabaseSync(":memory:");
    try {
      applyThrough(db, 42);
      for (const statement of statements.slice(0, committedColumns)) db.exec(statement);
      const observations = [];
      await runRestartSafeMigrationStatements(statements, queryFor(db), {
        afterStatement: (observation) => observations.push(observation),
      });
      assert.deepEqual(
        observations.slice(0, 2).map(({ skipped }) => skipped),
        committedColumns === 1 ? [true, false] : [true, true],
        `restart recognizes exactly ${committedColumns} previously committed column statement(s)`,
      );
      assert.throws(
        () => db.prepare(
          `INSERT INTO documents
             (doc_uid,source,source_id,ingested_at,content_hash,document_revision_id)
           VALUES ('localdocs:restart-uppercase','localdocs','restart-uppercase',1,?,?)`,
        ).run(hex("7"), revisionId("A")),
        /CHECK constraint failed/,
        "an adopted exact revision column retains its canonical digest constraint",
      );
      assert.throws(
        () => db.prepare(
          `INSERT INTO documents
             (doc_uid,source,source_id,ingested_at,content_hash,source_original_binding_hash)
           VALUES ('localdocs:restart-pointer','localdocs','restart-pointer',1,?,?)`,
        ).run(hex("7"), digest("8")),
        /CHECK constraint failed/,
        "an adopted or resumed binding column retains its revision relationship constraint",
      );
    } finally {
      db.close();
    }
  }
});

test("0043 restart refuses same-shape columns with weaker CHECK contracts", async () => {
  const migration = FILES.find((name) => name.startsWith("0043_"));
  assert.ok(migration, "the schema-43 migration exists");
  const statements = splitStatements(readFileSync(join(MIGRATIONS, migration), "utf8"));
  const cases = [
    {
      column: "document_revision_id",
      prepare(db) {
        db.exec("ALTER TABLE documents ADD COLUMN document_revision_id TEXT");
      },
    },
    {
      column: "source_original_binding_hash",
      prepare(db) {
        db.exec(statements[0]);
        db.exec(`ALTER TABLE documents ADD COLUMN source_original_binding_hash TEXT
          CHECK (source_original_binding_hash IS NULL OR length(source_original_binding_hash) = 71)`);
      },
    },
  ];

  for (const scenario of cases) {
    const db = new DatabaseSync(":memory:");
    try {
      applyThrough(db, 42);
      scenario.prepare(db);
      await assert.rejects(
        runRestartSafeMigrationStatements(statements, queryFor(db)),
        new RegExp(`documents\\.${scenario.column} already exists with an incompatible schema`),
        `${scenario.column} cannot be adopted from type/null/default metadata alone`,
      );
      assert.equal(
        db.prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='source_original_result_bindings'",
        ).get().n,
        0,
        "the migration stops before creating later schema objects",
      );
    } finally {
      db.close();
    }
  }
});

test("0043 constrains private binding receipts and keeps the ledger append-only", () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyThrough(db, 43);

    db.prepare(
      `INSERT INTO documents (doc_uid,source,source_id,ingested_at,content_hash)
       VALUES ('localdocs:unbound','localdocs','unbound',1,?)`,
    ).run(hex("7"));
    assert.deepEqual(
      { ...db.prepare(
        `SELECT document_revision_id,source_original_binding_hash
           FROM documents WHERE doc_uid='localdocs:unbound'`,
      ).get() },
      { document_revision_id: null, source_original_binding_hash: null },
      "direct legacy and recovery fixtures may remain explicitly unbound",
    );

    assert.throws(
      () => db.prepare(
        `INSERT INTO documents
           (doc_uid,source,source_id,ingested_at,content_hash,source_original_binding_hash)
         VALUES ('localdocs:pointer-without-revision','localdocs','bad-pointer',1,?,?)`,
      ).run(hex("7"), digest("8")),
      /CHECK constraint failed/,
      "a binding pointer cannot exist without a document revision",
    );
    assert.throws(
      () => db.prepare(
        `INSERT INTO documents
           (doc_uid,source,source_id,ingested_at,content_hash,document_revision_id)
         VALUES ('localdocs:uppercase-revision','localdocs','uppercase-revision',1,?,?)`,
      ).run(hex("7"), revisionId("A")),
      /CHECK constraint failed/,
      "revision IDs are canonical lowercase digests",
    );

    const row = binding();
    db.prepare(
      `INSERT INTO documents
         (doc_uid,source,source_id,ingested_at,content_hash,
          provenance_receipt_digest,document_revision_id,source_original_binding_hash)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(DOCUMENT_UID, row.source, "bound", 7, row.document_content_hash,
      row.provenance_receipt_digest, row.document_revision_id, row.binding_hash);
    const insert = db.prepare(INSERT_BINDING);
    insert.run(row);

    assert.throws(
      () => db.prepare(
        `INSERT INTO documents
           (doc_uid,source,source_id,ingested_at,content_hash,
            provenance_receipt_digest,document_revision_id,source_original_binding_hash)
         VALUES ('localdocs:revision-alias','localdocs','revision-alias',7,?,?,?,?)`,
      ).run(row.document_content_hash, row.provenance_receipt_digest,
        row.document_revision_id, row.binding_hash),
      /UNIQUE constraint failed/,
      "one random revision id cannot identify two current documents",
    );

    assert.deepEqual(
      { ...db.prepare(
        `SELECT contract_version,tenant_id,source,original_id,locator_kind,
                document_revision_id,original_content_sha256,original_byte_count,
                document_content_hash,provenance_receipt_digest,binding_hash,bound_at
           FROM source_original_result_bindings WHERE sequence=1`,
      ).get() },
      row,
      "the durable receipt retains every raw-result binding field exactly",
    );

    const columns = db.prepare("PRAGMA table_info(source_original_result_bindings)").all()
      .map(({ name }) => name);
    for (const forbidden of ["doc_uid", "locator", "path", "uri", "title", "provider_id", "source_id"]) {
      assert.equal(columns.includes(forbidden), false, `the binding ledger cannot store raw ${forbidden}`);
    }
    assert.equal(columns.includes("locator_kind"), true,
      "the ledger records only the closed locator domain, never the locator value");

    assert.throws(
      () => insert.run(binding({
        document_revision_id: revisionId("7"),
        binding_hash: digest("7"),
        original_byte_count: 1.5,
      })),
      /CHECK constraint failed/,
      "a recovery insert cannot put a fractional byte count in immutable history",
    );
    assert.throws(
      () => insert.run(binding({
        document_revision_id: revisionId("8"),
        binding_hash: digest("8"),
        bound_at: 7.5,
      })),
      /CHECK constraint failed/,
      "a recovery insert cannot put a fractional timestamp in immutable history",
    );

    assert.throws(
      () => insert.run(binding({ binding_hash: digest("8") })),
      /source original result binding cannot be replaced/,
      "one document revision cannot be rebound to different bytes",
    );
    assert.throws(
      () => db.prepare(
        `UPDATE source_original_result_bindings SET bound_at=99 WHERE sequence=1`,
      ).run(),
      /source original result bindings are append-only/,
    );
    assert.throws(
      () => db.prepare("DELETE FROM source_original_result_bindings WHERE sequence=1").run(),
      /source original result bindings are append-only/,
    );
    const replace = db.prepare(INSERT_BINDING.replace(
      "INSERT INTO source_original_result_bindings",
      "INSERT OR REPLACE INTO source_original_result_bindings",
    ));
    assert.throws(
      () => replace.run(binding({ original_byte_count: 999 })),
      /source original result binding cannot be replaced/,
      "SQLite REPLACE cannot rewrite immutable binding history",
    );

    db.prepare("DELETE FROM documents WHERE doc_uid=?").run(DOCUMENT_UID);
    assert.equal(db.prepare("SELECT count(*) AS n FROM source_original_result_bindings").get().n, 1,
      "binding history survives an approved later document deletion");
    assert.equal(
      JSON.stringify({ ...db.prepare(
        "SELECT * FROM source_original_result_bindings WHERE sequence=1",
      ).get() }).includes(DOCUMENT_UID),
      false,
      "surviving history cannot retain the path-bearing document identity",
    );
  } finally {
    db.close();
  }
});

test("0043 recovery can restore current documents before immutable binding history", () => {
  const source = new DatabaseSync(":memory:");
  const restored = new DatabaseSync(":memory:");
  try {
    applyThrough(source, 43);
    applyThrough(restored, 43);
    const restoredDocUid = "localdocs:restored";
    const row = binding({
      document_revision_id: revisionId("8"),
      binding_hash: digest("9"),
    });
    source.prepare(
      `INSERT INTO documents
         (doc_uid,source,source_id,ingested_at,content_hash,
          provenance_receipt_digest,document_revision_id,source_original_binding_hash)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(restoredDocUid, row.source, "restored", row.bound_at, row.document_content_hash,
      row.provenance_receipt_digest, row.document_revision_id, row.binding_hash);
    source.prepare(INSERT_BINDING).run(row);

    const sourceDocument = { ...source.prepare(
      `SELECT doc_uid,source,source_id,ingested_at,content_hash,
              provenance_receipt_digest,document_revision_id,source_original_binding_hash
         FROM documents WHERE doc_uid=?`,
    ).get(restoredDocUid) };
    const sourceBinding = { ...source.prepare(
      "SELECT * FROM source_original_result_bindings WHERE binding_hash=?",
    ).get(row.binding_hash) };

    restored.prepare(
      `INSERT INTO documents
         (doc_uid,source,source_id,ingested_at,content_hash,
          provenance_receipt_digest,document_revision_id,source_original_binding_hash)
       VALUES (@doc_uid,@source,@source_id,@ingested_at,@content_hash,
               @provenance_receipt_digest,@document_revision_id,@source_original_binding_hash)`,
    ).run(sourceDocument);
    const bindingColumns = Object.keys(sourceBinding);
    restored.prepare(
      `INSERT INTO source_original_result_bindings
         (${bindingColumns.join(",")}) VALUES (${bindingColumns.map((name) => `@${name}`).join(",")})`,
    ).run(sourceBinding);

    assert.deepEqual(
      { ...restored.prepare(
        "SELECT * FROM source_original_result_bindings WHERE binding_hash=?",
      ).get(row.binding_hash) },
      sourceBinding,
      "documents-first recovery preserves the complete binding receipt and sequence",
    );
  } finally {
    source.close();
    restored.close();
  }
});
