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
const MIGRATION_44 = FILES.find((name) => name.startsWith("0044_"));

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
  VALUES
    (@family_receipt_hash,@document_revision_id,@source_original_binding_hash,
     @chunk_ix,@chunk_receipt_hash)`;

const INSERT_RECEIPT = `
  INSERT INTO source_original_result_family_receipts
    (contract_version,tenant_id,source,original_id,locator_kind,
     original_content_sha256,original_byte_count,document_count,document_set_hash,
     chunk_count,chunk_set_hash,family_receipt_hash,sealed_at)
  VALUES
    (1,'primary',@source,@original_id,'source_relative_path',
     @original_content_sha256,@original_byte_count,@document_count,@document_set_hash,
     @chunk_count,@chunk_set_hash,@family_receipt_hash,8)`;

const INSERT_VERIFICATION = `
  INSERT INTO source_original_result_family_verifications
    (contract_version,tenant_id,family_receipt_hash,outbox_generation,
     vector_projection_mutation_id,vector_projection_submitted_at,
     vector_projection_bootstrap_epoch,vector_projection_status,
     expected_vector_count,actual_vector_count,target_outbox_count,global_outbox_count,
     vector_readiness_hash,retrieval_contract_version,retrieval_probe_id,retrieval_status,
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
     @vector_readiness_hash,1,@retrieval_probe_id,'deterministic',
     @retrieval_result_hash,@retrieval_result_hash,
     @document_revision_id,@document_revision_id,
     @chunk_ix,@chunk_ix,'same_family',
     @citation_set_hash,@citation_set_hash,
     @document_revision_id,@document_revision_id,
     @verification_hash,9)`;

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
     @resolves_observation_hash,@observation_hash,10)`;

function installState(db) {
  db.prepare(
    `INSERT INTO install_state
       (id,client_slug,product_version,schema_version,gate_version,installed_at,ring,
        outbox_generation,vector_projection_status,vector_projection_bootstrap_epoch)
     VALUES (1,'fixture','test',44,0,'2026-09-11T00:00:00Z','test',0,'verified',0)`,
  ).run();
  db.prepare(
    `INSERT INTO sources (name,kind,status,created_at)
     VALUES ('localdocs','upload','ready','2026-09-11T00:00:00Z')`,
  ).run();
}

function insertBoundResult(db, {
  suffix = "bound",
  revisionCharacter = "2",
  bindingCharacter = "6",
  contentCharacter = "4",
  provenanceCharacter = "5",
  chunkCharacter = "7",
  title = "Bound fixture",
  text = `[${title}]\n\nSynthetic body.`,
  original_id = originalId("1"),
  original_content_sha256 = hex("3"),
  original_byte_count = 123,
} = {}) {
  const row = {
    doc_uid: `localdocs:${suffix}`,
    source: "localdocs",
    source_id: suffix,
    title,
    document_revision_id: revisionId(revisionCharacter),
    source_original_binding_hash: digest(bindingCharacter),
    document_content_hash: hex(contentCharacter),
    provenance_receipt_digest: hex(provenanceCharacter),
    chunk_uid: `localdocs:${suffix}#0`,
    chunk_ix: 0,
    chunk_receipt_hash: digest(chunkCharacter),
    original_id,
    original_content_sha256,
    original_byte_count,
  };
  db.prepare(
    `INSERT INTO documents
       (doc_uid,source,source_id,title,ingested_at,content_hash,meta,
        text_source,text_reliable,provenance_receipt_version,
        provenance_receipt_status,provenance_receipt_reason,provenance_receipt_digest,
        document_revision_id,source_original_binding_hash)
     VALUES
       (@doc_uid,@source,@source_id,@title,7,@document_content_hash,'{}',
        'native',1,1,'complete','lineage_and_text_recorded',@provenance_receipt_digest,
        @document_revision_id,@source_original_binding_hash)`,
  ).run({
    doc_uid: row.doc_uid,
    source: row.source,
    source_id: row.source_id,
    title: row.title,
    document_content_hash: row.document_content_hash,
    provenance_receipt_digest: row.provenance_receipt_digest,
    document_revision_id: row.document_revision_id,
    source_original_binding_hash: row.source_original_binding_hash,
  });
  db.prepare(INSERT_BINDING).run({
    source: row.source,
    original_id: row.original_id,
    document_revision_id: row.document_revision_id,
    original_content_sha256: row.original_content_sha256,
    original_byte_count: row.original_byte_count,
    document_content_hash: row.document_content_hash,
    provenance_receipt_digest: row.provenance_receipt_digest,
    binding_hash: row.source_original_binding_hash,
  });
  db.prepare(
    `INSERT INTO chunks
       (chunk_uid,doc_uid,chunk_ix,text,source,title,vector_id,
        bound_document_revision_id,result_chunk_receipt_hash)
     VALUES
       (@chunk_uid,@doc_uid,@chunk_ix,@text,@source,@title,@chunk_uid,
        @document_revision_id,@chunk_receipt_hash)`,
  ).run({
    chunk_uid: row.chunk_uid,
    doc_uid: row.doc_uid,
    chunk_ix: row.chunk_ix,
    text,
    source: row.source,
    title: row.title,
    document_revision_id: row.document_revision_id,
    chunk_receipt_hash: row.chunk_receipt_hash,
  });
  return row;
}

function member(row, familyReceiptHash) {
  return {
    family_receipt_hash: familyReceiptHash,
    document_revision_id: row.document_revision_id,
    source_original_binding_hash: row.source_original_binding_hash,
    chunk_ix: row.chunk_ix,
    chunk_receipt_hash: row.chunk_receipt_hash,
  };
}

function receipt(row, familyReceiptHash, overrides = {}) {
  return {
    source: row.source,
    original_id: row.original_id,
    original_content_sha256: row.original_content_sha256,
    original_byte_count: row.original_byte_count,
    document_count: 1,
    document_set_hash: digest("a"),
    chunk_count: 1,
    chunk_set_hash: digest("b"),
    family_receipt_hash: familyReceiptHash,
    ...overrides,
  };
}

function verification(db, row, familyReceiptHash, verificationHash = digest("d")) {
  const state = db.prepare(
    `SELECT outbox_generation,vector_projection_bootstrap_epoch
       FROM install_state WHERE id=1`,
  ).get();
  return {
    family_receipt_hash: familyReceiptHash,
    outbox_generation: state.outbox_generation,
    vector_projection_bootstrap_epoch: state.vector_projection_bootstrap_epoch,
    expected_vector_count: db.prepare("SELECT count(*) AS n FROM chunks").get().n,
    vector_readiness_hash: digest("e"),
    retrieval_probe_id: probeId("a"),
    retrieval_result_hash: digest("c"),
    document_revision_id: row.document_revision_id,
    chunk_ix: row.chunk_ix,
    citation_set_hash: digest("f"),
    verification_hash: verificationHash,
  };
}

function sealedFixture() {
  const db = new DatabaseSync(":memory:");
  applyThrough(db, 44);
  installState(db);
  const row = insertBoundResult(db);
  const familyReceiptHash = digest("8");
  db.prepare(INSERT_MEMBER).run(member(row, familyReceiptHash));
  db.prepare(INSERT_RECEIPT).run(receipt(row, familyReceiptHash));
  const verified = verification(db, row, familyReceiptHash);
  db.prepare(INSERT_VERIFICATION).run(verified);
  return { db, row, familyReceiptHash, verified };
}

test("0044 adopts legacy chunks as explicitly unreceipted and leaves accepted disabled", () => {
  assert.ok(MIGRATION_44, "the schema-44 migration exists");
  const db = new DatabaseSync(":memory:");
  try {
    applyThrough(db, 43);
    db.prepare(
      `INSERT INTO documents (doc_uid,source,source_id,title,ingested_at,content_hash,meta)
       VALUES ('localdocs:legacy','localdocs','legacy','Legacy title',1,?,'{}')`,
    ).run(hex("a"));
    db.prepare(
      `INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source,title)
       VALUES ('localdocs:legacy#0','localdocs:legacy',0,'Legacy body','localdocs','Legacy title')`,
    ).run();
    const adopted = {
      doc_uid: "localdocs:adopted-bound",
      source: "localdocs",
      source_id: "adopted-bound",
      title: "Adopted bound",
      document_revision_id: revisionId("2"),
      source_original_binding_hash: digest("6"),
      document_content_hash: hex("4"),
      provenance_receipt_digest: hex("5"),
      chunk_ix: 0,
      chunk_receipt_hash: digest("7"),
      original_id: originalId("1"),
      original_content_sha256: hex("3"),
      original_byte_count: 123,
    };
    db.prepare(
      `INSERT INTO documents
         (doc_uid,source,source_id,title,ingested_at,content_hash,meta,
          provenance_receipt_digest,document_revision_id,source_original_binding_hash)
       VALUES
         (@doc_uid,@source,@source_id,@title,7,@document_content_hash,'{}',
          @provenance_receipt_digest,@document_revision_id,@source_original_binding_hash)`,
    ).run({
      doc_uid: adopted.doc_uid,
      source: adopted.source,
      source_id: adopted.source_id,
      title: adopted.title,
      document_content_hash: adopted.document_content_hash,
      provenance_receipt_digest: adopted.provenance_receipt_digest,
      document_revision_id: adopted.document_revision_id,
      source_original_binding_hash: adopted.source_original_binding_hash,
    });
    db.prepare(INSERT_BINDING).run({
      source: adopted.source,
      original_id: adopted.original_id,
      document_revision_id: adopted.document_revision_id,
      original_content_sha256: adopted.original_content_sha256,
      original_byte_count: adopted.original_byte_count,
      document_content_hash: adopted.document_content_hash,
      provenance_receipt_digest: adopted.provenance_receipt_digest,
      binding_hash: adopted.source_original_binding_hash,
    });
    db.prepare(
      `INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source,title)
       VALUES ('localdocs:adopted-bound#0',@doc_uid,0,
               '[Adopted bound]' || char(10) || char(10) || 'Legacy bound body.',
               @source,@title)`,
    ).run({ doc_uid: adopted.doc_uid, source: adopted.source, title: adopted.title });
    const acceptedBefore = db.prepare(
      `SELECT sql FROM sqlite_master
        WHERE type='trigger' AND name='source_original_observation_accepted_disabled'`,
    ).get().sql;

    apply(db, MIGRATION_44);

    assert.deepEqual(
      { ...db.prepare(
        `SELECT bound_document_revision_id,result_chunk_receipt_hash
           FROM chunks WHERE chunk_uid='localdocs:legacy#0'`,
      ).get() },
      { bound_document_revision_id: null, result_chunk_receipt_hash: null },
      "migration 44 never manufactures a chunk receipt for legacy content",
    );
    assert.deepEqual(
      { ...db.prepare(
        `SELECT bound_document_revision_id,result_chunk_receipt_hash
           FROM chunks WHERE chunk_uid='localdocs:adopted-bound#0'`,
      ).get() },
      { bound_document_revision_id: null, result_chunk_receipt_hash: null },
      "a pre-44 bound chunk is also adopted as explicitly unreceipted",
    );
    const adoptedFamilyHash = digest("8");
    db.prepare(INSERT_MEMBER).run(member(adopted, adoptedFamilyHash));
    assert.throws(
      () => db.prepare(INSERT_RECEIPT).run(receipt(adopted, adoptedFamilyHash)),
      /member is not an exact current bound chunk/,
      "NULL adopted receipt fields cannot satisfy a staged non-NULL member",
    );
    assert.equal(db.prepare(
      `SELECT sql FROM sqlite_master
        WHERE type='trigger' AND name='source_original_observation_accepted_disabled'`,
    ).get().sql, acceptedBefore, "the accepted guard is byte-for-byte untouched");
    assert.throws(
      () => db.prepare(INSERT_ACCEPTED_OBSERVATION).run({
        original_id: originalId("9"),
        plan_id: hex("a"),
        source_snapshot_id: digest("b"),
        target_set_hash: digest("c"),
        original_content_sha256: hex("d"),
        result_document_set_hash: digest("e"),
        resolves_observation_hash: digest("f"),
        observation_hash: digest("9"),
      }),
      /accepted source-original outcomes require a future result-family receipt and retrieval proof/,
    );

    for (const table of [
      "source_original_result_family_members",
      "source_original_result_family_receipts",
      "source_original_result_family_verifications",
    ]) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(({ name }) => name);
      for (const forbidden of ["locator", "doc_uid", "chunk_uid", "title", "text", "query", "answer", "uri", "source_id"]) {
        assert.equal(columns.includes(forbidden), false, `${table} cannot persist raw ${forbidden}`);
      }
    }
    assert.equal(
      db.prepare("PRAGMA table_info(source_original_result_family_receipts)").all()
        .some(({ name }) => name === "locator_kind"),
      true,
      "the portable seal retains only the closed locator kind",
    );
  } finally {
    db.close();
  }
});

test("0044 restart resumes every statement cut and adopts only exact chunk columns", async () => {
  assert.ok(MIGRATION_44, "the schema-44 migration exists");
  const statements = splitStatements(readFileSync(join(MIGRATIONS, MIGRATION_44), "utf8"));
  for (const cut of [0, 1, 2, 7, 14, statements.length]) {
    const db = new DatabaseSync(":memory:");
    try {
      applyThrough(db, 43);
      for (const statement of statements.slice(0, cut)) db.exec(statement);
      const observations = [];
      await runRestartSafeMigrationStatements(statements, queryFor(db), {
        afterStatement: (observation) => observations.push(observation),
      });
      assert.deepEqual(
        observations.slice(0, 2).map(({ skipped }) => skipped),
        [cut >= 1, cut >= 2],
        `restart recognizes the exact columns after ${cut} committed statements`,
      );
      await runRestartSafeMigrationStatements(statements, queryFor(db));
      assert.equal(
        db.prepare(
          `SELECT count(*) AS n FROM sqlite_master
            WHERE type='table' AND name LIKE 'source_original_result_family_%'`,
        ).get().n,
        4,
      );
    } finally {
      db.close();
    }
  }

  const cases = [
    {
      column: "bound_document_revision_id",
      prepare(db) {
        db.exec("ALTER TABLE chunks ADD COLUMN bound_document_revision_id TEXT");
      },
    },
    {
      column: "result_chunk_receipt_hash",
      prepare(db) {
        db.exec(statements[0]);
        db.exec(`ALTER TABLE chunks ADD COLUMN result_chunk_receipt_hash TEXT
          CHECK (result_chunk_receipt_hash IS NULL OR length(result_chunk_receipt_hash)=71)`);
      },
    },
  ];
  for (const scenario of cases) {
    const db = new DatabaseSync(":memory:");
    try {
      applyThrough(db, 43);
      scenario.prepare(db);
      await assert.rejects(
        runRestartSafeMigrationStatements(statements, queryFor(db)),
        new RegExp(`chunks\\.${scenario.column} already exists with an incompatible schema`),
      );
      assert.equal(
        db.prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='source_original_result_family_members'",
        ).get().n,
        0,
        "incompatible adoption stops before later schema objects",
      );
    } finally {
      db.close();
    }
  }
});

test("0044 seals every current revision and its exact title-prefixed chunk set", () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyThrough(db, 44);
    installState(db);
    db.exec("SAVEPOINT invalid_title_prefix");
    assert.throws(
      () => insertBoundResult(db, { text: "Synthetic body without its title prefix." }),
      /CHECK constraint failed/,
      "a title-bearing chunk receipt cannot omit the exact stored prefix",
    );
    db.exec("ROLLBACK TO invalid_title_prefix");
    db.exec("RELEASE invalid_title_prefix");
    const first = insertBoundResult(db);
    const second = insertBoundResult(db, {
      suffix: "bound-part-2",
      revisionCharacter: "a",
      bindingCharacter: "b",
      contentCharacter: "c",
      provenanceCharacter: "d",
      chunkCharacter: "e",
      title: "Bound fixture part 2",
    });

    const incompleteHash = digest("8");
    db.prepare(INSERT_MEMBER).run(member(first, incompleteHash));
    assert.throws(
      () => db.prepare(INSERT_RECEIPT).run(receipt(first, incompleteHash)),
      /seal omits a current revision or chunk/,
      "one member cannot seal only part of the current exact-original result family",
    );
    db.prepare(
      "DELETE FROM source_original_result_family_members WHERE family_receipt_hash=?",
    ).run(incompleteHash);

    const completeHash = digest("9");
    db.prepare(INSERT_MEMBER).run(member(first, completeHash));
    db.prepare(INSERT_MEMBER).run(member(second, completeHash));
    db.prepare(INSERT_RECEIPT).run(receipt(first, completeHash, {
      document_count: 2,
      chunk_count: 2,
      document_set_hash: digest("c"),
      chunk_set_hash: digest("d"),
    }));
    assert.equal(
      db.prepare(
        "SELECT count(*) AS n FROM source_original_result_family_members WHERE family_receipt_hash=?",
      ).get(completeHash).n,
      2,
      "the sealed member set contains each current revision's exact chunk",
    );
  } finally {
    db.close();
  }
});

test("0044 keeps portable and deployment-local seals append-only under REPLACE", () => {
  const { db, row, familyReceiptHash, verified } = sealedFixture();
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM source_original_result_family_receipts").get().n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM source_original_result_family_verifications").get().n, 1);

    assert.throws(
      () => db.prepare("UPDATE chunks SET source='other' WHERE chunk_uid=?")
        .run(row.chunk_uid),
      /changed source-original chunk requires a new chunk receipt/,
      "a low-level source relabel cannot retain the sealed chunk receipt",
    );

    assert.throws(
      () => db.prepare(
        `INSERT OR REPLACE INTO chunks
           (chunk_uid,doc_uid,chunk_ix,text,source,title,vector_id,
            bound_document_revision_id,result_chunk_receipt_hash)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(
        row.chunk_uid, row.doc_uid, row.chunk_ix,
        `[${row.title}]\n\nSynthetic body.`, "other", row.title,
        row.chunk_uid, row.document_revision_id, row.chunk_receipt_hash,
      ),
      /changed source-original chunk cannot reuse a chunk receipt/,
      "INSERT OR REPLACE cannot relabel a sealed chunk while retaining its receipt",
    );

    assert.throws(
      () => db.prepare(
        `INSERT OR REPLACE INTO chunks
           (chunk_uid,doc_uid,chunk_ix,text,source,title,vector_id,
            bound_document_revision_id,result_chunk_receipt_hash)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(
        row.chunk_uid, row.doc_uid, row.chunk_ix,
        `[${row.title}]\n\nChanged body with a replayed digest.`, row.source, row.title,
        row.chunk_uid, row.document_revision_id, row.chunk_receipt_hash,
      ),
      /changed source-original chunk cannot reuse a chunk receipt/,
      "INSERT OR REPLACE cannot replay a sealed digest over changed bytes",
    );

    assert.throws(
      () => db.prepare(
        "UPDATE source_original_result_family_members SET chunk_receipt_hash=? WHERE family_receipt_hash=?",
      ).run(digest("a"), familyReceiptHash),
      /source original result family members are immutable/,
    );
    assert.throws(
      () => db.prepare(
        "DELETE FROM source_original_result_family_members WHERE family_receipt_hash=?",
      ).run(familyReceiptHash),
      /sealed source original result family members are immutable/,
    );
    assert.throws(
      () => db.prepare(INSERT_MEMBER.replace("INSERT INTO", "INSERT OR REPLACE INTO"))
        .run(member(row, familyReceiptHash)),
      /(cannot be replaced|sealed source original result family members are immutable)/,
    );
    assert.throws(
      () => db.prepare(INSERT_MEMBER).run(member({
        ...row,
        document_revision_id: revisionId("a"),
        source_original_binding_hash: digest("a"),
        chunk_ix: 1,
        chunk_receipt_hash: digest("a"),
      }, familyReceiptHash)),
      /sealed source original result family members are immutable/,
    );

    assert.throws(
      () => db.prepare(
        "UPDATE source_original_result_family_receipts SET sealed_at=99 WHERE family_receipt_hash=?",
      ).run(familyReceiptHash),
      /source original result family receipts are append-only/,
    );
    assert.throws(
      () => db.prepare("DELETE FROM source_original_result_family_receipts WHERE family_receipt_hash=?")
        .run(familyReceiptHash),
      /source original result family receipts are append-only/,
    );
    assert.throws(
      () => db.prepare(INSERT_RECEIPT.replace("INSERT INTO", "INSERT OR REPLACE INTO"))
        .run(receipt(row, familyReceiptHash)),
      /source original result family receipt cannot be replaced/,
    );

    assert.throws(
      () => db.prepare(
        "UPDATE source_original_result_family_verifications SET verified_at=99 WHERE verification_hash=?",
      ).run(verified.verification_hash),
      /source original result family verifications are append-only/,
    );
    assert.throws(
      () => db.prepare("DELETE FROM source_original_result_family_verifications WHERE verification_hash=?")
        .run(verified.verification_hash),
      /source original result family verifications are append-only/,
    );
    assert.throws(
      () => db.prepare(INSERT_VERIFICATION.replace("INSERT INTO", "INSERT OR REPLACE INTO"))
        .run(verified),
      /source original result family verification cannot be replaced/,
    );
  } finally {
    db.close();
  }
});

test("0044 verification seal rejects stale family or deployment readiness", () => {
  const { db, row, familyReceiptHash } = sealedFixture();
  try {
    db.prepare(
      `INSERT INTO chunks
         (chunk_uid,doc_uid,chunk_ix,text,source,title,vector_id,
          bound_document_revision_id,result_chunk_receipt_hash)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      "localdocs:bound#1", row.doc_uid, 1, `[${row.title}]\n\nSecond body.`, row.source,
      row.title, "localdocs:bound#1", row.document_revision_id, digest("a"),
    );
    assert.throws(
      () => db.prepare(INSERT_VERIFICATION).run(
        verification(db, row, familyReceiptHash, digest("a")),
      ),
      /source original result family changed before verification seal/,
      "a later current chunk invalidates the older portable family seal",
    );
  } finally {
    db.close();
  }

  const second = sealedFixture();
  try {
    second.db.prepare(
      `INSERT INTO vector_outbox (chunk_uid,op,queued_at,vector_id)
       VALUES ('unrelated:pending','upsert',11,'unrelated:pending')`,
    ).run();
    assert.throws(
      () => second.db.prepare(INSERT_VERIFICATION).run(
        verification(second.db, second.row, second.familyReceiptHash, digest("a")),
      ),
      /CHECK constraint failed|global vector readiness changed before verification seal/,
      "a nonempty global outbox cannot be represented as a verified deployment seal",
    );
  } finally {
    second.db.close();
  }


  const nullPair = sealedFixture();
  try {
    const verificationValidationTrigger = nullPair.db.prepare(
      `SELECT sql FROM sqlite_master
        WHERE type='trigger' AND name='source_original_result_family_verification_validate_insert'`,
    ).get().sql;
    nullPair.db.exec("DROP TRIGGER source_original_result_family_verification_validate_insert");
    assert.throws(
      () => nullPair.db.prepare(
        INSERT_VERIFICATION.replace(
          "NULL,NULL,@vector_projection_bootstrap_epoch",
          "NULL,12,@vector_projection_bootstrap_epoch",
        ),
      ).run(verification(
        nullPair.db,
        nullPair.row,
        nullPair.familyReceiptHash,
        digest("9"),
      )),
      /CHECK constraint failed/,
      "a submission timestamp cannot exist without its mutation id",
    );
    nullPair.db.exec(verificationValidationTrigger);
  } finally {
    nullPair.db.close();
  }
});

test("0044 recovery replays schema-43 bound chunks without weakening supplied receipts", () => {
  const recovered = new DatabaseSync(":memory:");
  const normal = new DatabaseSync(":memory:");
  const document = {
    doc_uid: "localdocs:recovered-bound",
    source: "localdocs",
    source_id: "recovered-bound",
    title: "Recovered bound",
    document_content_hash: hex("4"),
    provenance_receipt_digest: hex("5"),
    document_revision_id: revisionId("2"),
    source_original_binding_hash: digest("6"),
  };
  const insertDocument = (db) => db.prepare(
    `INSERT INTO documents
       (doc_uid,source,source_id,title,ingested_at,content_hash,meta,
        provenance_receipt_digest,document_revision_id,source_original_binding_hash)
     VALUES
       (@doc_uid,@source,@source_id,@title,7,@document_content_hash,'{}',
        @provenance_receipt_digest,@document_revision_id,@source_original_binding_hash)`,
  ).run(document);
  const insertLegacyChunk = (db, overrides = {}) => db.prepare(
    `INSERT INTO chunks
       (chunk_uid,doc_uid,chunk_ix,text,source,title,vector_id,
        bound_document_revision_id,result_chunk_receipt_hash)
     VALUES
       ('localdocs:recovered-bound#0',@doc_uid,0,
        '[Recovered bound]' || char(10) || char(10) || 'Legacy recovered body.',
        @source,@title,'localdocs:recovered-bound#0',
        @bound_document_revision_id,@result_chunk_receipt_hash)`,
  ).run({
    doc_uid: document.doc_uid,
    source: document.source,
    title: document.title,
    bound_document_revision_id: null,
    result_chunk_receipt_hash: null,
    ...overrides,
  });

  try {
    applyThrough(recovered, 44);
    recovered.prepare(
      `INSERT INTO source_original_result_family_recovery_state (id,mode)
       VALUES (1,'verified_recovery_import')`,
    ).run();
    insertDocument(recovered);
    insertLegacyChunk(recovered);
    assert.deepEqual(
      { ...recovered.prepare(
        `SELECT bound_document_revision_id,result_chunk_receipt_hash
           FROM chunks WHERE chunk_uid='localdocs:recovered-bound#0'`,
      ).get() },
      { bound_document_revision_id: null, result_chunk_receipt_hash: null },
      "a verified empty-target restore preserves the exact pre-44 NULL/NULL chunk state",
    );
    assert.throws(
      () => insertLegacyChunk(recovered, {
        bound_document_revision_id: revisionId("9"),
        result_chunk_receipt_hash: digest("9"),
      }),
      /bound source-original chunks require the exact current document revision and chunk receipt/,
      "recovery mode never permits a supplied receipt for a different revision",
    );

    applyThrough(normal, 44);
    insertDocument(normal);
    assert.throws(
      () => insertLegacyChunk(normal),
      /bound source-original chunks require the exact current document revision and chunk receipt/,
      "normal writes cannot create an unreceipted chunk under a bound document",
    );
  } finally {
    recovered.close();
    normal.close();
  }
});

test("0044 restores historical portable seals only inside an empty recovery fence", () => {
  const source = sealedFixture();
  const target = new DatabaseSync(":memory:");
  try {
    source.db.prepare("UPDATE documents SET deleted_at=10 WHERE doc_uid=?")
      .run(source.row.doc_uid);
    assert.equal(
      source.db.prepare(
        "SELECT count(*) AS n FROM source_original_result_family_receipts WHERE family_receipt_hash=?",
      ).get(source.familyReceiptHash).n,
      1,
      "a later deletion leaves the portable seal as immutable history",
    );

    applyThrough(target, 44);
    target.prepare(
      `INSERT INTO source_original_result_family_recovery_state (id,mode)
       VALUES (1,'verified_recovery_import')`,
    ).run();
    target.prepare(
      `INSERT INTO documents
         (doc_uid,source,source_id,title,ingested_at,content_hash,meta,deleted_at,
          text_source,text_reliable,provenance_receipt_version,
          provenance_receipt_status,provenance_receipt_reason,provenance_receipt_digest,
          document_revision_id,source_original_binding_hash)
       VALUES
         (@doc_uid,@source,@source_id,@title,7,@document_content_hash,'{}',10,
          'native',1,1,'complete','lineage_and_text_recorded',@provenance_receipt_digest,
          @document_revision_id,@source_original_binding_hash)`,
    ).run({
      doc_uid: source.row.doc_uid,
      source: source.row.source,
      source_id: source.row.source_id,
      title: source.row.title,
      document_content_hash: source.row.document_content_hash,
      provenance_receipt_digest: source.row.provenance_receipt_digest,
      document_revision_id: source.row.document_revision_id,
      source_original_binding_hash: source.row.source_original_binding_hash,
    });
    target.prepare(
      `INSERT INTO chunks
         (chunk_uid,doc_uid,chunk_ix,text,source,title,vector_id,
          bound_document_revision_id,result_chunk_receipt_hash)
       VALUES
         (@chunk_uid,@doc_uid,@chunk_ix,
          '[' || @title || ']' || char(10) || char(10) || 'Synthetic body.',
          @source,@title,@chunk_uid,@document_revision_id,@chunk_receipt_hash)`,
    ).run({
      chunk_uid: source.row.chunk_uid,
      doc_uid: source.row.doc_uid,
      chunk_ix: source.row.chunk_ix,
      title: source.row.title,
      source: source.row.source,
      document_revision_id: source.row.document_revision_id,
      chunk_receipt_hash: source.row.chunk_receipt_hash,
    });
    target.prepare(INSERT_BINDING).run({
      source: source.row.source,
      original_id: source.row.original_id,
      document_revision_id: source.row.document_revision_id,
      original_content_sha256: source.row.original_content_sha256,
      original_byte_count: source.row.original_byte_count,
      document_content_hash: source.row.document_content_hash,
      provenance_receipt_digest: source.row.provenance_receipt_digest,
      binding_hash: source.row.source_original_binding_hash,
    });
    const orphanFamilyHash = digest("0");
    target.prepare(INSERT_MEMBER).run(member({
      ...source.row,
      source_original_binding_hash: digest("f"),
    }, orphanFamilyHash));
    assert.throws(
      () => target.prepare(INSERT_RECEIPT).run(receipt(source.row, orphanFamilyHash)),
      /member is not bound to the sealed original/,
      "recovery mode never bypasses the immutable binding ledger",
    );
    target.prepare(
      "DELETE FROM source_original_result_family_members WHERE family_receipt_hash=?",
    ).run(orphanFamilyHash);
    target.prepare(INSERT_MEMBER).run(member(source.row, source.familyReceiptHash));
    target.prepare(INSERT_RECEIPT).run(receipt(source.row, source.familyReceiptHash));
    target.prepare(
      `DELETE FROM source_original_result_family_recovery_state
        WHERE id=1 AND mode='verified_recovery_import'`,
    ).run();
    assert.deepEqual({
      receipts: target.prepare(
        "SELECT count(*) AS n FROM source_original_result_family_receipts",
      ).get().n,
      deleted_receipted_chunks: target.prepare(
        `SELECT count(*) AS n
           FROM chunks c JOIN documents d ON d.doc_uid=c.doc_uid
          WHERE d.deleted_at IS NOT NULL
            AND c.bound_document_revision_id IS NOT NULL
            AND c.result_chunk_receipt_hash IS NOT NULL`,
      ).get().n,
      active_imports: target.prepare(
        "SELECT count(*) AS n FROM source_original_result_family_recovery_state",
      ).get().n,
    }, { receipts: 1, deleted_receipted_chunks: 1, active_imports: 0 });

    assert.throws(
      () => target.prepare(
        `INSERT INTO source_original_result_family_recovery_state (id,mode)
         VALUES (1,'verified_recovery_import')`,
      ).run(),
      /recovery marker requires an empty recovery target/,
      "a populated database cannot reopen the historical import bypass",
    );
  } finally {
    source.db.close();
    target.close();
  }
});
