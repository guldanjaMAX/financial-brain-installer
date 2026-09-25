import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runRestartSafeMigrationStatements, splitStatements } from "../brain.mjs";
import { storeFor } from "../worker/src/lib/store.js";
import {
  forgetFamilies,
  listSourceFamilies,
  sourceFamilyCounts,
  vectorReadiness,
} from "../worker/src/lib/store-d1.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationDir = join(here, "..", "migrations", "d1");
const db = new DatabaseSync(":memory:");
for (const file of readdirSync(migrationDir).filter((name) => name.endsWith(".sql")).sort()) {
  for (const sql of splitStatements(readFileSync(join(migrationDir, file), "utf8"))) db.exec(sql);
}
db.prepare(
  `INSERT INTO install_state
     (id,client_slug,product_version,schema_version,gate_version,installed_at,ring)
   VALUES (1,'scale-fixture','0.0.0',47,0,'2026-01-01T00:00:00Z','test')`,
).run();

// Large enough that a table scan is a meaningful regression while remaining a
// fast offline gate. The production estimate scales this shape from 20,000
// documents / 68,000 chunks to about 500,000 / 1,700,000.
const DOCUMENTS = 20_000;
const CHUNKS_PER_FIVE_DOCUMENTS = 17;
const insertDocument = db.prepare(
  `INSERT INTO documents
     (doc_uid,source,source_id,title,ingested_at,content_hash,meta,
      provenance_receipt_version,provenance_receipt_status,
      provenance_receipt_reason,provenance_receipt_digest)
   VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
);
const insertChunk = db.prepare(
  `INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source,title)
   VALUES (?,?,?,?,?,?)`,
);
db.exec("BEGIN");
for (let i = 0; i < DOCUMENTS; i++) {
  const source = i < DOCUMENTS / 2 ? "alpha" : "beta";
  const sourceId = `item-${i}`;
  const docUid = `${source}:${sourceId}`;
  const group = Math.floor(i / 5);
  let meta = "{}";
  if (i % 20 < 5) meta = JSON.stringify({ part_of: `bundle-${group}`, folder: `/fixture/${group}` });
  if (i === DOCUMENTS - 1) meta = JSON.stringify({ family_of: "alpha:declared-1" });
  insertDocument.run(
    docUid, source, sourceId, `Fixture ${i}`, i + 1, `hash-${i}`, meta,
    1, "complete", "lineage_and_text_recorded", String(i).padStart(64, "a").slice(-64),
  );
  const chunkCount = Math.floor(CHUNKS_PER_FIVE_DOCUMENTS / 5) +
    (i % 5 < CHUNKS_PER_FIVE_DOCUMENTS % 5 ? 1 : 0);
  for (let chunk = 0; chunk < chunkCount; chunk++) {
    insertChunk.run(
      `${docUid}#${chunk}`, docUid, chunk, "synthetic text", source, `Fixture ${i}`,
    );
  }
}
db.exec("COMMIT");

const OUTBOX_ROWS = DOCUMENTS;
const insertOutbox = db.prepare(
  "INSERT INTO vector_outbox (chunk_uid,vector_id,op,queued_at) VALUES (?,?,?,?)"
);
db.exec("BEGIN");
for (let i = 0; i < OUTBOX_ROWS; i++) {
  const source = i < DOCUMENTS / 2 ? "alpha" : "beta";
  const chunkUid = `${source}:item-${i}#0`;
  insertOutbox.run(chunkUid, chunkUid, "upsert", i + 1);
}
db.exec("COMMIT");

const plans = [];
function prepared(sql, params = []) {
  return {
    sql,
    params,
    bind(...next) { return prepared(sql, next); },
    async all() {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
      const results = db.prepare(sql).all(...params);
      plans.push({ sql, plan, rowCount: results.length });
      return { results };
    },
    async first() {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
      plans.push({ sql, plan });
      return db.prepare(sql).get(...params) ?? null;
    },
    async run() {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
      plans.push({ sql, plan });
      return db.prepare(sql).run(...params);
    },
  };
}
const env = {
  STORAGE: "d1",
  DB: {
    prepare: (sql) => prepared(sql),
    batch: async (statements) => {
      const results = [];
      db.exec("BEGIN");
      try {
        for (const statement of statements) results.push(await statement.run());
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return results;
    },
  },
  VECTORIZE: { describe: async () => ({ vectorCount: 68_000 }) },
};

async function assertSchemaReadFailureStops(label, operation, failureMessage =
  "D1_ERROR: D1 DB exceeded its CPU time limit and was reset.") {
  const failure = new Error(failureMessage);
  const calls = [];
  let mutations = 0;
  const failingEnv = {
    STORAGE: "d1",
    DB: {
      prepare(sql) {
        calls.push(String(sql));
        if (/^SELECT schema_version FROM install_state WHERE id=1$/.test(String(sql))) {
          return { async first() { throw failure; } };
        }
        throw new Error(`unexpected query after failed schema read: ${String(sql).slice(0, 80)}`);
      },
      async batch() {
        mutations++;
        throw new Error("unexpected mutation after failed schema read");
      },
    },
  };
  await assert.rejects(() => operation(failingEnv), (error) => error === failure,
    `${label} must preserve the schema read failure`);
  assert.equal(calls.length, 1, `${label} must stop after the schema decision point`);
  assert.match(calls[0], /^SELECT schema_version FROM install_state WHERE id=1$/);
  assert.equal(mutations, 0, `${label} must not mutate after an ambiguous schema read`);
}

await assertSchemaReadFailureStops("documents aggregate", (failingEnv) =>
  storeFor(failingEnv).stats(failingEnv));
await assertSchemaReadFailureStops("family inventory", (failingEnv) =>
  listSourceFamilies(failingEnv, { source: "alpha", limit: 10 }));
await assertSchemaReadFailureStops("family forget", (failingEnv) =>
  forgetFamilies(failingEnv, {
    families: [{ base_doc_uid: "alpha:fixture", keep_doc_uids: [] }],
    dryRun: false,
  }));
await assertSchemaReadFailureStops("unexpected missing table", (failingEnv) =>
  storeFor(failingEnv).stats(failingEnv),
  "D1_ERROR: no such table: another_table: SQLITE_ERROR");

async function assertSchemaReceiptFailureStops(label, row, operation) {
  const calls = [];
  let mutations = 0;
  const malformedEnv = {
    STORAGE: "d1",
    DB: {
      prepare(sql) {
        calls.push(String(sql));
        if (/^SELECT schema_version FROM install_state WHERE id=1$/.test(String(sql))) {
          return { async first() { return row; } };
        }
        throw new Error(`unexpected query after malformed schema read: ${String(sql).slice(0, 80)}`);
      },
      async batch() {
        mutations++;
        throw new Error("unexpected mutation after malformed schema read");
      },
    },
  };
  await assert.rejects(() => operation(malformedEnv), /schema version receipt is malformed/i,
    `${label} must reject the malformed schema receipt`);
  assert.equal(calls.length, 1, `${label} must stop after the schema decision point`);
  assert.equal(mutations, 0, `${label} must not mutate after a malformed schema receipt`);
}

const schemaGuardedOperations = [
  ["documents aggregate", (malformedEnv) => storeFor(malformedEnv).stats(malformedEnv)],
  ["family inventory", (malformedEnv) =>
    listSourceFamilies(malformedEnv, { source: "alpha", limit: 10 })],
  ["family forget", (malformedEnv) => forgetFamilies(malformedEnv, {
    families: [{ base_doc_uid: "alpha:fixture", keep_doc_uids: [] }],
    dryRun: false,
  })],
];
for (const [receiptName, row] of [
  ["missing row", null],
  ["missing field", {}],
  ["null field", { schema_version: null }],
  ["text field", { schema_version: "46" }],
  ["fractional field", { schema_version: 46.5 }],
  ["negative field", { schema_version: -1 }],
]) {
  for (const [operationName, operation] of schemaGuardedOperations) {
    await assertSchemaReceiptFailureStops(`${operationName}: ${receiptName}`, row, operation);
  }
}

const bootstrapCalls = [];
const bootstrapEnv = {
  STORAGE: "d1",
  DB: {
    prepare(sql) {
      bootstrapCalls.push(String(sql));
      if (/^SELECT schema_version FROM install_state WHERE id=1$/.test(String(sql))) {
        return {
          async first() {
            throw new Error("D1_ERROR: no such table: install_state: SQLITE_ERROR");
          },
        };
      }
      return { async all() { return { results: [] }; } };
    },
  },
};
assert.deepEqual(await storeFor(bootstrapEnv).stats(bootstrapEnv), { rows: [] },
  "the exact pre-schema bootstrap condition keeps the legacy read shape");
assert.equal(bootstrapCalls.length, 2,
  "only the exact missing install_state result may continue after schema detection");

const fullScanDetails = () => plans.flatMap(({ plan }) => plan)
  .map((row) => String(row.detail || ""))
  .filter((detail) => /\bSCAN (?:documents|d|chunks|c|vector_outbox|document_family_members|document_family_catalog|vector_outbox_sources|schema47_(?:chunk|outbox)_backfill_rows)\b/i.test(detail));
const planDetails = () => plans.flatMap(({ plan }) => plan).map((row) => String(row.detail || ""));

const stats = await storeFor(env).stats(env);
assert.equal(stats.rows.length, 2, "the documents aggregate reached its decision point");
assert.equal(stats.rows.reduce((sum, row) => sum + row.stored_documents, 0), DOCUMENTS);
assert.equal(stats.rows.reduce((sum, row) => sum + row.chunks, 0), 68_000);
assert.deepEqual(fullScanDetails(), [],
  `documents health aggregate scanned corpus rows: ${fullScanDetails().join(" | ")}`);

plans.length = 0;
const readiness = await vectorReadiness(env);
assert.equal(readiness.expected_vectors, 68_000,
  "think and health reached the exact vector-readiness decision point");
assert.equal(readiness.pending, OUTBOX_ROWS,
  "think and health read the exact transactional queue total");
assert.deepEqual(fullScanDetails(), [],
  `think/health vector readiness scanned corpus rows: ${fullScanDetails().join(" | ")}`);

plans.length = 0;
const familyPage = await listSourceFamilies(env, { source: "alpha", limit: 100 });
assert.equal(familyPage.families.length, 100, "family inventory reached its bounded page decision");
assert.ok(planDetails().some((detail) =>
  /idx_document_family_catalog_source/i.test(detail)),
"family inventory must use its named one-row-per-family source index");
assert.deepEqual(fullScanDetails(), [],
  `family inventory scanned corpus rows: ${fullScanDetails().join(" | ")}`);

plans.length = 0;
const familyCounts = await sourceFamilyCounts(env, { source: "alpha" });
assert.ok(familyCounts.stored_documents > 0 && familyCounts.logical_documents > 0,
  "family counting reached its aggregate decision");
assert.deepEqual(fullScanDetails(), [],
  `family counts scanned corpus rows: ${fullScanDetails().join(" | ")}`);

plans.length = 0;
const forgotten = await forgetFamilies(env, {
  families: [{ base_doc_uid: "alpha:declared-1", keep_doc_uids: [] }],
  dryRun: true,
});
assert.equal(forgotten.documents, 1, "forget reached and populated its bounded deletion plan");
assert.ok(planDetails().some((detail) =>
  /idx_document_family_members_global_family/i.test(detail)),
"family forget must use its named family/member keyset index");
assert.deepEqual(fullScanDetails(), [],
  `family forget scanned corpus rows: ${fullScanDetails().join(" | ")}`);

const beforeMutation = db.prepare(
  "SELECT documents,logical_documents,chunks FROM corpus_stats WHERE source='alpha'"
).get();
const removedChunks = db.prepare("SELECT count(*) AS n FROM chunks WHERE doc_uid='alpha:item-5'").get().n;
db.prepare("DELETE FROM documents WHERE doc_uid='alpha:item-5'").run();
const afterDelete = db.prepare(
  "SELECT documents,logical_documents,chunks FROM corpus_stats WHERE source='alpha'"
).get();
assert.equal(afterDelete.documents, beforeMutation.documents - 1);
assert.equal(afterDelete.logical_documents, beforeMutation.logical_documents - 1);
assert.equal(afterDelete.chunks, beforeMutation.chunks - removedChunks,
  "physical document deletion transactionally removes its live chunk count");
assert.equal(db.prepare("SELECT chunks FROM corpus_runtime_totals WHERE id=1").get().chunks,
  68_000 - removedChunks, "physical chunk totals follow cascading deletion");

const betaBefore = db.prepare(
  "SELECT documents,logical_documents,chunks FROM corpus_stats WHERE source='beta'"
).get();
const softDeletedChunks = db.prepare("SELECT count(*) AS n FROM chunks WHERE doc_uid='beta:item-10000'").get().n;
db.prepare("UPDATE documents SET deleted_at=1 WHERE doc_uid='beta:item-10000'").run();
const betaDeleted = db.prepare(
  "SELECT documents,logical_documents,chunks FROM corpus_stats WHERE source='beta'"
).get();
assert.equal(betaDeleted.documents, betaBefore.documents - 1);
assert.equal(betaDeleted.chunks, betaBefore.chunks - softDeletedChunks,
  "soft deletion transactionally removes only the public live chunk count");
assert.equal(db.prepare("SELECT chunks FROM corpus_runtime_totals WHERE id=1").get().chunks,
  68_000 - removedChunks, "soft deletion keeps the physical projection total exact");
db.prepare("UPDATE documents SET deleted_at=NULL WHERE doc_uid='beta:item-10000'").run();
assert.deepEqual(db.prepare(
  "SELECT documents,logical_documents,chunks FROM corpus_stats WHERE source='beta'"
).get(), betaBefore, "restoring a document transactionally restores its live counters");

plans.length = 0;
const deletedFamily = await forgetFamilies(env, {
  families: [{ base_doc_uid: "alpha:declared-1", keep_doc_uids: [] }],
  dryRun: false,
});
assert.equal(deletedFamily.documents, 1,
  "confirmed family forget reached and executed its bounded deletion plan");
assert.deepEqual(fullScanDetails(), [],
  `confirmed family forget scanned corpus rows: ${fullScanDetails().join(" | ")}`);
assert.deepEqual(plans.filter(({ sql }) =>
  /INSERT INTO corpus_stats[\s\S]*FROM documents[\s\S]*LEFT JOIN chunks/i.test(sql)
), [], "confirmed family forget must not re-aggregate every surviving row in the source");
const queueTotals = db.prepare(
  "SELECT pending,upserts,deletes,submitted FROM vector_outbox_runtime_totals WHERE id=1"
).get();
const queueActual = db.prepare(
  `SELECT count(*) AS pending,
          sum(CASE WHEN op='upsert' THEN 1 ELSE 0 END) AS upserts,
          sum(CASE WHEN op='delete' THEN 1 ELSE 0 END) AS deletes,
          sum(CASE WHEN submitted_mutation_id IS NOT NULL THEN 1 ELSE 0 END) AS submitted
     FROM vector_outbox`
).get();
assert.deepEqual(queueTotals, queueActual,
  "outbox insert, update, and delete triggers keep the constant-time totals exact");
assert.deepEqual(
  db.prepare("SELECT source,pending FROM vector_outbox_source_counts ORDER BY source").all(),
  db.prepare("SELECT source,count(*) AS pending FROM vector_outbox_sources GROUP BY source ORDER BY source").all(),
  "per-source outbox counters remain exact after an upsert becomes a delete",
);

db.prepare(
  `INSERT INTO documents (doc_uid,source,source_id,title,ingested_at,content_hash,meta)
   VALUES ('gamma:one','gamma','one','One',1,'gamma-hash','{}')`,
).run();
db.prepare(
  `INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source,title)
   VALUES ('gamma:one#0','gamma:one',0,'synthetic text','gamma','One')`,
).run();
db.prepare(
  `INSERT INTO vector_outbox (chunk_uid,vector_id,op,queued_at)
   VALUES ('gamma:one#0','gamma:one#0','upsert',1)`,
).run();
const forgottenSingle = await forgetFamilies(env, {
  families: [{ base_doc_uid: "gamma:one", keep_doc_uids: [] }],
  dryRun: false,
});
assert.equal(forgottenSingle.documents, 1,
  "one-chunk forget reached the confirmed mutation decision point");
const gammaStats = (await storeFor(env).stats(env)).rows.find((row) => row.source_type === "gamma");
assert.equal(gammaStats?.chunks, 0);
assert.equal(gammaStats?.embedded, 0,
  "pending projection excludes a delete after its chunk leaves current membership");
assert.ok(gammaStats.embedded >= 0, "owner-facing embedded counts are never negative");

db.prepare(
  `INSERT INTO vector_outbox (chunk_uid,vector_id,op,queued_at)
   VALUES ('orphan:item#0','orphan:item#0','delete',2)`,
).run();
db.prepare(
  `INSERT INTO documents (doc_uid,source,source_id,title,ingested_at,content_hash,meta)
   VALUES ('orphan:item','orphan','item','Item',2,'orphan-hash','{}')`,
).run();
db.prepare(
  `INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source,title)
   VALUES ('orphan:item#0','orphan:item',0,'synthetic text','orphan','Item')`,
).run();
db.prepare("DELETE FROM vector_outbox_sources WHERE chunk_uid='orphan:item#0'").run();
db.prepare("UPDATE vector_outbox_source_counts SET pending=0 WHERE source='orphan'").run();
db.prepare(
  `INSERT INTO vector_outbox (chunk_uid,vector_id,op,queued_at)
   VALUES ('orphan:item#0','orphan:item#0','upsert',3)
   ON CONFLICT(chunk_uid) DO UPDATE SET
     vector_id=excluded.vector_id,op=excluded.op,queued_at=excluded.queued_at`,
).run();
assert.deepEqual(
  db.prepare(
    `SELECT source,count(*) AS pending
       FROM vector_outbox JOIN chunks USING (chunk_uid)
      GROUP BY source ORDER BY source`,
  ).all(),
  db.prepare(
    "SELECT source,pending FROM vector_outbox_source_counts WHERE pending > 0 ORDER BY source",
  ).all(),
  "legacy orphan conflict-upserts heal to the schema-46 current-chunk join contract",
);

const LARGE_FAMILY_MEMBERS = 2_505;
db.exec("BEGIN");
for (let i = 0; i < LARGE_FAMILY_MEMBERS; i++) {
  insertDocument.run(
    `omega:member-${String(i).padStart(5, "0")}`,
    "omega",
    `member-${i}`,
    `Member ${i}`,
    i + 1,
    `omega-hash-${i}`,
    JSON.stringify({ family_of: "omega:large-family" }),
    1,
    "complete",
    "lineage_and_text_recorded",
    String(i).padStart(64, "b").slice(-64),
  );
}
db.exec("COMMIT");

plans.length = 0;
const largeFamilyInventory = await listSourceFamilies(env, { source: "omega", limit: 10 });
assert.deepEqual(largeFamilyInventory.families, ["omega:large-family"],
  "one large family consumes exactly one maintained inventory row");
assert.ok(plans.filter(({ sql }) => /FROM document_family_catalog/.test(sql))
  .every(({ rowCount }) => rowCount <= 11),
"family inventory returns at most its one-row-per-family lookahead bound");

plans.length = 0;
const largeFamilyPreview = await forgetFamilies(env, {
  families: [{ base_doc_uid: "omega:large-family", keep_doc_uids: [] }],
  dryRun: true,
});
assert.equal(largeFamilyPreview.documents, LARGE_FAMILY_MEMBERS,
  "large-family forget completes the full preview before any mutation");
const memberPages = plans.filter(({ sql }) => /FROM document_family_members/.test(sql) &&
  /ORDER BY family_uid ASC,doc_uid ASC/.test(sql));
assert.ok(memberPages.length >= 3 && memberPages.every(({ rowCount }) => rowCount <= 1001),
  "every large-family member query stays inside the hard page plus lookahead bound");
assert.ok(memberPages.every(({ plan }) => plan.some((row) =>
  /idx_document_family_members_global_family/i.test(String(row.detail || "")))),
"every large-family member page uses the named keyset index");

let truncatedPages = 0;
let truncatedMutations = 0;
const truncatedEnv = {
  STORAGE: "d1",
  DB: {
    prepare(sql) {
      if (/^SELECT schema_version FROM install_state WHERE id=1$/.test(String(sql))) {
        return { async first() { return { schema_version: 47 }; } };
      }
      if (/FROM document_family_members/.test(String(sql))) {
        return {
          bind() { return this; },
          async all() {
            const offset = truncatedPages++ * 1000;
            return {
              results: Array.from({ length: 1001 }, (_, index) => ({
                family_uid: "bounded:large-family",
                doc_uid: `bounded:member-${String(offset + index).padStart(7, "0")}`,
                family_of: "bounded:large-family",
              })),
            };
          },
        };
      }
      throw new Error(`unexpected truncation query: ${String(sql).slice(0, 80)}`);
    },
    async batch() { truncatedMutations++; },
  },
};
await assert.rejects(() => forgetFamilies(truncatedEnv, {
  families: [{ base_doc_uid: "bounded:large-family", keep_doc_uids: [] }],
  dryRun: false,
}), (error) => error?.code === "family_forget_inventory_truncated",
"an over-budget family returns the typed truncation refusal");
assert.equal(truncatedPages, 100,
  "the truncation refusal is reached only after the fixed page budget decision point");
assert.equal(truncatedMutations, 0,
  "an incomplete family preview cannot reach a deletion batch");

db.exec("DROP INDEX idx_document_family_members_global_family");
const unindexedFamilyPlan = db.prepare(
  `EXPLAIN QUERY PLAN
   SELECT family_uid,doc_uid FROM document_family_members
    WHERE family_uid IN ('omega:large-family')
      AND (family_uid > '' OR (family_uid = '' AND doc_uid > ''))
    ORDER BY family_uid,doc_uid LIMIT 1001`,
).all();
const unindexedDetails = unindexedFamilyPlan.map((row) => String(row.detail || ""));
assert.ok(unindexedDetails.some((detail) =>
  /\bSCAN document_family_members\b/i.test(detail)),
`negative control must detect an unindexed family projection scan: ${unindexedDetails.join(" | ")}`);
db.exec(
  "CREATE INDEX idx_document_family_members_global_family ON document_family_members (family_uid,doc_uid)",
);

// Exercise the field-upgrade shape itself: populate schema 46 first, interrupt
// migration 47 after a committed keyset page, then resume from its durable
// cursor. Applying 47 to an empty database and loading afterward cannot prove
// this path.
const upgrade = new DatabaseSync(":memory:");
for (const file of readdirSync(migrationDir)
  .filter((name) => name.endsWith(".sql") && Number.parseInt(name, 10) <= 46)
  .sort()) {
  for (const sql of splitStatements(readFileSync(join(migrationDir, file), "utf8"))) upgrade.exec(sql);
}
upgrade.prepare(
  `INSERT INTO install_state
     (id,client_slug,product_version,schema_version,gate_version,installed_at,ring)
   VALUES (1,'upgrade-fixture','0.0.0',46,0,'2026-01-01T00:00:00Z','test')`,
).run();
const UPGRADE_DOCUMENTS = 5_005;
const upgradeDocument = upgrade.prepare(
  `INSERT INTO documents (doc_uid,source,source_id,title,ingested_at,content_hash,meta)
   VALUES (?,?,?,?,?,?,?)`,
);
const upgradeChunk = upgrade.prepare(
  `INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source,title)
   VALUES (?,?,?,?,?,?)`,
);
const upgradeOutbox = upgrade.prepare(
  "INSERT INTO vector_outbox (chunk_uid,vector_id,op,queued_at) VALUES (?,?,?,?)",
);
upgrade.exec("BEGIN");
for (let i = 0; i < UPGRADE_DOCUMENTS; i++) {
  const source = i % 2 ? "left" : "right";
  const uid = `${source}:upgrade-${String(i).padStart(5, "0")}`;
  const family = `${source}:family-${Math.floor(i / 5)}`;
  upgradeDocument.run(uid, source, `upgrade-${i}`, `Upgrade ${i}`, i + 1, `hash-${i}`,
    JSON.stringify({ family_of: family }));
  for (let chunk = 0; chunk < 3; chunk++) {
    upgradeChunk.run(`${uid}#${chunk}`, uid, chunk, "synthetic text", source, `Upgrade ${i}`);
  }
  upgradeOutbox.run(`${uid}#0`, `${uid}#0`, "upsert", i + 1);
}
upgrade.exec("COMMIT");

const migration47Statements = splitStatements(
  readFileSync(join(migrationDir, "0047_bounded_corpus_hot_paths.sql"), "utf8"),
);
const upgradePlans = [];
const upgradeQuery = async (sql) => {
  const text = String(sql).trim();
  if (/^(?:SELECT|PRAGMA)\b/i.test(text)) {
    return { results: upgrade.prepare(sql).all() };
  }
  if (/^WITH\s+schema47_bounded_page\b/i.test(text)) {
    upgradePlans.push({
      sql: text,
      plan: upgrade.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(),
    });
  }
  const result = upgrade.prepare(sql).run();
  return { results: [], meta: { changes: Number(result.changes || 0) } };
};

let interrupted = false;
try {
  await runRestartSafeMigrationStatements(migration47Statements, upgradeQuery, {
    afterStatement({ statement, page, changes }) {
      if (/^WITH\s+schema47_bounded_page\b/i.test(statement) &&
          /live_document_family_projection/.test(statement) && page === 0 && changes === 1000) {
        throw new Error("synthetic schema-47 page-boundary interruption");
      }
    },
  });
} catch (error) {
  interrupted = /page-boundary interruption/.test(error.message);
}
assert.equal(interrupted, true, "schema-47 upgrade reached and interrupted a committed document page");
assert.equal(upgrade.prepare("SELECT count(*) AS n FROM document_family_members").get().n, 1000,
  "the interrupted page committed exactly its hard row bound");
assert.throws(() => upgrade.prepare(
  "INSERT INTO schema_migrations (version,name,applied_at,checksum) VALUES (47,'premature',0,'x')",
).run(), /bounded backfill is incomplete/i,
"schema 47 cannot activate before all bounded phases reconcile");

await runRestartSafeMigrationStatements(migration47Statements, upgradeQuery);
upgrade.prepare(
  "INSERT INTO schema_migrations (version,name,applied_at,checksum) VALUES (47,'bounded',0,'x')",
).run();
assert.deepEqual(
  upgrade.prepare(
    "SELECT phase,complete FROM schema47_backfill_progress ORDER BY phase",
  ).all().map((row) => ({ phase: row.phase, complete: row.complete })),
  [
    { phase: "chunks", complete: 1 },
    { phase: "documents", complete: 1 },
    { phase: "outbox", complete: 1 },
  ],
  "every bounded phase has a durable exact completion receipt",
);
assert.equal(upgrade.prepare("SELECT count(*) AS n FROM document_family_members").get().n,
  UPGRADE_DOCUMENTS, "resume projects every schema-46 live document exactly once");
assert.equal(upgrade.prepare("SELECT chunks FROM corpus_runtime_totals WHERE id=1").get().chunks,
  UPGRADE_DOCUMENTS * 3, "chunk-page resume reconciles the complete physical total");
assert.equal(upgrade.prepare("SELECT pending FROM vector_outbox_runtime_totals WHERE id=1").get().pending,
  UPGRADE_DOCUMENTS, "outbox-page resume reconciles the complete queue total");
assert.ok(upgradePlans.length > 20 && upgradePlans.every(({ sql, plan }) =>
  /LIMIT 1000/.test(sql) && !plan.some((row) =>
    /\bSCAN (?:documents|d|chunks|c|vector_outbox|o)\b/i.test(String(row.detail || "")))),
"every populated-upgrade page has a fixed limit and an indexed base-table plan");
upgrade.close();

console.log(
  `d1 hot-path scale: ${DOCUMENTS} documents / 68000 chunks; ` +
  "EXPLAIN QUERY PLAN found zero full corpus-table scans",
);
