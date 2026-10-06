/**
 * Document readers on a Brain that has not applied migration 0048 yet.
 *
 * A Worker upgrade can serve before `brain migrate` finishes, so every reader
 * that applies the custom API current-version rule must also work on a schema
 * without the custom API tables. That schema has no custom API documents, and
 * the cheap sqlite_master check is cached per isolate so the hot retrieval path
 * does not pay for it on every question.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { splitStatements } from "../brain.mjs";
import {
  customApiPointerTablesPresent,
  readWithCustomApiVisibility,
} from "../worker/src/lib/custom-api-visibility.js";
import { readExactDocumentReport } from "../worker/src/lib/documents-summary.js";
import {
  searchKeyword,
  sourceInventory,
  unchunkedTaxDocumentCandidates,
} from "../worker/src/lib/store-d1.js";

const MIGRATIONS = fileURLToPath(new URL("../migrations/d1/", import.meta.url));
const POINTER_TABLE_SQL = /custom_api_current_jobs|custom_api_document_versions/;
const PROBE_SQL = /FROM sqlite_master/;

function migratedDb(throughMigration) {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) <= throughMigration)
    .sort()) {
    for (const statement of splitStatements(readFileSync(join(MIGRATIONS, file), "utf8"))) db.exec(statement);
  }
  db.prepare(
    `INSERT INTO install_state (id,client_slug,product_version,installed_at)
     VALUES (1,'fixture','0.0.0-test','2026-01-01T00:00:00.000Z')`,
  ).run();
  return db;
}

function applyMigration(db, version) {
  const file = readdirSync(MIGRATIONS).find((name) => name.startsWith(`${String(version).padStart(4, "0")}_`));
  for (const statement of splitStatements(readFileSync(join(MIGRATIONS, file), "utf8"))) db.exec(statement);
}

function d1(db) {
  const prepared = [];
  const statement = (sql, params = []) => ({
    bind: (...next) => statement(sql, next),
    all: async () => ({ results: db.prepare(sql).all(...params) }),
    first: async () => db.prepare(sql).get(...params) ?? null,
    run: async () => db.prepare(sql).run(...params),
  });
  return {
    prepared,
    DB: {
      prepare(sql) {
        prepared.push(sql);
        // Like D1, an unknown table fails when the statement is prepared.
        db.prepare(sql);
        return statement(sql);
      },
    },
  };
}

function addDocument(db, { uid, source, meta = {}, chunks = [], title = uid }) {
  db.prepare(
    `INSERT INTO documents (doc_uid,source,source_id,title,content_hash,ingested_at,meta,text_source,text_reliable)
     VALUES (?1,?2,?3,?4,?5,?6,?7,'native',1)`,
  ).run(uid, source, uid.slice(source.length + 1), title, `${uid}-hash`, Date.parse("2026-09-01T00:00:00.000Z"),
    JSON.stringify(meta));
  chunks.forEach((text, index) => {
    db.prepare(
      "INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source) VALUES (?1,?2,?3,?4,?5)",
    ).run(`${uid}#${index}`, uid, index, text, source);
  });
}

test("a pre-0048 Brain reads documents without the custom API tables and probes once", async () => {
  const db = migratedDb(47);
  assert.equal(db.prepare(
    "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'custom_api_%'",
  ).get().n, 0, "the fixture must be a schema without any 0048 table");
  addDocument(db, { uid: "drive:orchard", source: "drive", chunks: ["orchard lease renewal"] });
  addDocument(db, {
    uid: "drive:return", source: "drive", title: "Example Orchard LLC 2023 Form 1065",
    meta: { taxpayer_name: "Example Orchard LLC", tax_year: 2023 },
  });
  // No real pre-0048 Brain can hold one; if one appears it stays hidden
  // rather than bypassing a current-version rule that cannot be evaluated.
  addDocument(db, {
    uid: "store-feed:sales:job:x", source: "store-feed", chunks: ["orchard staged row"],
    meta: { connector: "custom_api", custom_api_source_id: "sales" },
  });
  const env = d1(db);

  const keyword = await searchKeyword(env, "orchard", { limit: 10 });
  assert.deepEqual(keyword.map((row) => row.doc_uid), ["drive:orchard"]);

  const unchunked = await unchunkedTaxDocumentCandidates(env, { limit: 20, scope: { all: true } });
  assert.equal(unchunked.complete, true);
  assert.deepEqual(unchunked.results.map((row) => row.doc_uid), ["drive:return"]);

  const report = await readExactDocumentReport(env);
  assert.equal(report.summary.complete, true);
  const drive = report.rows.find((row) => row.source_type === "drive");
  assert.equal(drive.stored_documents, 2);
  assert.equal(drive.chunks, 1);
  assert.equal(report.rows.find((row) => row.source_type === "store-feed")?.stored_documents ?? 0, 0);

  const inventory = await sourceInventory(env, { limit: 10 });
  assert.equal(inventory.total, inventory.rows.length);
  assert.ok(inventory.total >= 1, JSON.stringify(inventory.total));

  assert.equal(env.prepared.some((sql) => POINTER_TABLE_SQL.test(sql)), false,
    "a reader after the cached probe must not reference a table the schema lacks");
  assert.equal(env.prepared.filter((sql) => PROBE_SQL.test(sql)).length, 1,
    "the table-existence check is cached for this isolate");
});

test("an older Brain gains 0048 mid-upgrade and the absent answer is rechecked", async () => {
  const db = migratedDb(47);
  const env = d1(db);
  let clock = 1_000_000;
  const now = () => clock;
  assert.equal(await customApiPointerTablesPresent(env, { now }), false);
  applyMigration(db, 48);
  assert.equal(await customApiPointerTablesPresent(env, { now }), false,
    "within the recheck window the cached absent answer stands and stays fail closed");
  clock += 60_000;
  assert.equal(await customApiPointerTablesPresent(env, { now }), true);
  clock += 10 * 60_000;
  const probes = env.prepared.filter((sql) => PROBE_SQL.test(sql)).length;
  assert.equal(await customApiPointerTablesPresent(env, { now }), true);
  assert.equal(env.prepared.filter((sql) => PROBE_SQL.test(sql)).length, probes,
    "a present answer is permanent for this isolate");
});

test("an unanswerable probe still downgrades a missing pointer table instead of failing", async () => {
  const db = migratedDb(47);
  const inner = d1(db);
  const env = {
    DB: {
      prepare(sql) {
        if (PROBE_SQL.test(sql)) throw new Error("synthetic probe outage");
        return inner.DB.prepare(sql);
      },
    },
  };
  const seen = [];
  const value = await readWithCustomApiVisibility(env, async (pointerTables) => {
    seen.push(pointerTables);
    return env.DB.prepare(
      `SELECT count(*) AS n FROM documents d WHERE 1=1${pointerTables
        ? " AND EXISTS (SELECT 1 FROM custom_api_current_jobs)" : ""}`,
    ).first();
  });
  assert.deepEqual(seen, [true, false]);
  assert.equal(value.n, 0);
  await assert.rejects(
    readWithCustomApiVisibility(env, () => { throw new Error("D1 transport timeout"); }),
    /D1 transport timeout/,
    "a non-schema failure is never swallowed by the compatibility path",
  );
});

test("the exact document report counts only the current custom API version", async () => {
  const db = migratedDb(48);
  const jobHash = "a".repeat(64);
  const insertJob = db.prepare(
    `INSERT INTO custom_api_jobs
       (job_id,source,fetched_at,status,next_slice,total_slices,job_hash,response_hashes_json,stats_json,created_at,verified_at)
     VALUES (?1,'store-feed','2026-09-24T00:00:00.000Z',?2,0,0,?3,'{}','{}','2026-09-24T00:00:00.000Z',?4)`,
  );
  insertJob.run("job-current", "verified", jobHash, "2026-09-24T00:00:00.000Z");
  insertJob.run("job-staged", "staged", jobHash, null);
  db.prepare(
    "INSERT INTO custom_api_current_jobs (source,job_id,promoted_at) VALUES ('store-feed','job-current','2026-09-24T00:00:00.000Z')",
  ).run();
  db.prepare(
    `INSERT INTO custom_api_document_versions (source,job_id,logical_source_id,document_source_id)
     VALUES ('store-feed','job-current','sales','sales:job:current')`,
  ).run();
  for (const job of ["current", "staged"]) {
    addDocument(db, {
      uid: `store-feed:sales:job:${job}`, source: "store-feed", chunks: [`${job} sales row`],
      meta: { connector: "custom_api", custom_api_source_id: "sales", custom_api_job_id: `job-${job}` },
    });
  }
  addDocument(db, { uid: "drive:orchard", source: "drive", chunks: ["orchard"] });
  const env = d1(db);
  const report = await readExactDocumentReport(env);
  const feed = report.rows.find((row) => row.source_type === "store-feed");
  assert.equal(feed.stored_documents, 1, "a staged version is not a current document");
  assert.equal(feed.logical_documents, 1);
  assert.equal(feed.chunks, 1);
  assert.equal(report.rows.find((row) => row.source_type === "drive").stored_documents, 1);
  assert.ok(env.prepared.some((sql) => /FROM documents d[\s\S]*custom_api_current_jobs/.test(sql)),
    "the document page applies the shared current-version rule");
  assert.ok(env.prepared.some((sql) => /FROM chunks[\s\S]*custom_api_current_jobs/.test(sql)),
    "the chunk page applies the shared current-version rule");
});
