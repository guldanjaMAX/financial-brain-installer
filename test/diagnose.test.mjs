// The post-install diagnostic, tested against a REAL SQLite database with each
// defect deliberately seeded.
//
// This runs the actual SQL rather than a fake, because the whole value of this
// command is in the queries. A mocked DB would happily return whatever the test
// wanted and prove only that the JavaScript around it runs.
//
// Every failure this product has had was silent, and this is the command whose
// job is to end that. So each case below seeds one real defect and asserts it is
// both CAUGHT and explained.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { diagnose, drainOutbox, acquireDrainLease, forget } from "../worker/src/lib/store-d1.js";
import { DIAGNOSE_CHUNK_PAGE_SQL } from "../worker/src/lib/diagnose-scan.js";
import { assignZone } from "../worker/src/lib/auth-store.js";
import { resolveSourceKind } from "../worker/src/lib/source-receipt.js";

import { makeEnv as makeDrainEnv, seed as seedDrain, embed as embedDrain } from "./fixtures/vector-fence-env.mjs";

let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 220))); if (!c) fail++; };

const MIG = fileURLToPath(new URL("../migrations/d1/", import.meta.url));

// A D1-shaped facade over real SQLite, so diagnose() runs unmodified.
function makeEnv({ vectorCount = null, beforeStatement = null } = {}) {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIG).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(MIG, f), "utf-8"));
  }
  db.prepare(
    `INSERT INTO install_state
       (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
     VALUES (1, 'fixture', '0.0.0', 11, 0, '2026-01-01T00:00:00Z', 'test')`
  ).run();
  const queryLog = [];
  const invoke = async (method, sql, params, operation) => {
    const statement = { method, sql, params, number: queryLog.length + 1 };
    queryLog.push(statement);
    await beforeStatement?.({ ...statement, db });
    return operation();
  };
  const prepared = (sql, params = []) => ({
    bind: (...next) => prepared(sql, next),
    first: async () => invoke("first", sql, params, () => db.prepare(sql).get(...params) ?? null),
    all: async () => invoke("all", sql, params, () => ({ results: db.prepare(sql).all(...params) })),
    run: async () => invoke("run", sql, params, () => {
      const result = db.prepare(sql).run(...params);
      return { meta: { changes: Number(result.changes || 0) } };
    }),
    runInBatch: async () => invoke("batch", sql, params, () => {
      if (/^\s*(?:SELECT|WITH|PRAGMA)\b/i.test(sql)) {
        return { results: db.prepare(sql).all(...params), meta: { changes: 0 } };
      }
      const result = db.prepare(sql).run(...params);
      return { meta: { changes: Number(result.changes || 0) } };
    }),
  });
  const env = {
    _db: db,
    _queryLog: queryLog,
    DB: {
      prepare(sql) { return prepared(sql); },
      async batch(statements) {
        db.exec("BEGIN IMMEDIATE");
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.runInBatch());
          db.exec("COMMIT");
          return results;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
  };
  if (vectorCount !== null) env.VECTORIZE = { describe: async () => ({ vectorCount }) };
  return env;
}

const doc = (db, id, opts = {}) =>
  db.prepare(
    `INSERT INTO documents (doc_uid, source, source_id, title, uri, document_date, ingested_at, content_hash)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(id, opts.source ?? "documents", id, opts.title ?? `Doc ${id}`, opts.uri ?? `/${id}.md`,
        opts.date === undefined ? Date.now() : opts.date, Date.now(), opts.hash ?? `h-${id}`);

let _ix = 0;
const chunk = (db, uid, docUid, text = "some text", ix = null) =>
  db.prepare(`INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source) VALUES (?,?,?,?,?)`)
    .run(uid, docUid, ix === null ? _ix++ : ix, text, "documents");

const source = (db, name, zone = null) =>
  db.prepare(`INSERT INTO sources (name, kind, status, created_at, zone) VALUES (?,?,?,?,?)`)
    .run(name, "upload", "ready", new Date().toISOString(), zone);

const find = (r, id) => (r.findings || []).find((f) => f.id === id);

/* ---- OCR coverage is reported, because the reader deserves to know how much
       of the corpus a machine read off a picture ---- */
{
  const env = makeEnv({ vectorCount: 3 });
  source(env._db, "documents");
  for (const i of [1, 2, 3]) { doc(env._db, `d${i}`); chunk(env._db, `d${i}#0`, `d${i}`); }
  env._db.prepare("UPDATE documents SET text_source='ocr', text_reliable=0 WHERE doc_uid='d1'").run();
  env._db.prepare("UPDATE documents SET text_source='ocr_partial', text_reliable=0 WHERE doc_uid='d2'").run();
  const r = await diagnose(env);
  const f = find(r, "ocr_coverage");
  check("OCR-read documents are counted and reported", f?.count === 2, JSON.stringify(f));
  check("and a half-read one is called out separately",
    /pages that could not be read/.test(f?.detail || ""), f?.detail);
  check("it is information, not a defect, so a scanned corpus is not called unhealthy",
    f?.severity === "info" && r.verdict === "healthy", `${f?.severity} / ${r.verdict}`);
}

/* ---- a clean install reports clean ---- */
{
  const env = makeEnv({ vectorCount: 3 });
  source(env._db, "documents");
  for (const i of [1, 2, 3]) { doc(env._db, `d${i}`); chunk(env._db, `d${i}#0`, `d${i}`); }
  const r = await diagnose(env);
  check("a healthy corpus returns verdict healthy", r.verdict === "healthy", JSON.stringify(r.summary) + " " + JSON.stringify((r.findings||[]).map(f=>f.id)));
  check("and reports the right totals", r.totals.documents === 3 && r.totals.chunks === 3, JSON.stringify(r.totals));
  check("and says the two stores agree", find(r, "store_agreement")?.severity === "ok");
}

/* ---- THE ONE THAT WOULD HAVE CAUGHT THE FIELD STALL ---- */
{
  const env = makeEnv({ vectorCount: 100 });   // Vectorize holds 100
  source(env._db, "documents");
  for (let i = 0; i < 1001; i++) { doc(env._db, `d${i}`); chunk(env._db, `d${i}#0`, `d${i}`); }
  const r = await diagnose(env);               // D1 holds 1001, nothing queued
  const f = find(r, "store_agreement");
  check("1001 chunks against 100 vectors is CAUGHT", f?.severity === "crit", JSON.stringify(f));
  check("and the drift is stated exactly", f?.count === 901, JSON.stringify(f?.count));
  check("and it says the missing ones are invisible to meaning search", /invisible to meaning/i.test(f?.detail || ""), f?.detail);
  check("and it names the command that repairs it", /brain reindex/.test(f?.action || ""), f?.action);
  check("the overall verdict is problems", r.verdict === "problems", r.verdict);
}

/* ---- vectors left behind by deletions ---- */
{
  const env = makeEnv({ vectorCount: 500 });
  source(env._db, "documents");
  for (let i = 0; i < 10; i++) { doc(env._db, `d${i}`); chunk(env._db, `d${i}#0`, `d${i}`); }
  const f = find(await diagnose(env), "store_agreement");
  check("MORE vectors than chunks is also caught", f?.severity === "crit", JSON.stringify(f));
  check("and is described as leftovers competing for slots", /compete for retrieval slots/i.test(f?.detail || ""), f?.detail);
}

/* ---- a verified empty cut is exact, even when the difference is only one ---- */
{
  const env = makeEnv({ vectorCount: 9 });
  source(env._db, "documents");
  for (let i = 0; i < 10; i++) { doc(env._db, `exact-${i}`); chunk(env._db, `exact-${i}#0`, `exact-${i}`); }
  const f = find(await diagnose(env), "store_agreement");
  check("one missing vector cannot hide inside a percentage tolerance",
    f?.severity === "crit" && f.count === 1, JSON.stringify(f));
}

/* ---- a scanned PDF that indexed as nothing ---- */
{
  const env = makeEnv({ vectorCount: 1 });
  source(env._db, "documents");
  doc(env._db, "good"); chunk(env._db, "good#0", "good");
  doc(env._db, "scan", { title: "Bank statement scan.pdf" });   // no chunks
  const r = await diagnose(env);
  const f = find(r, "empty_documents");
  check("a document with no text is caught", f?.severity === "crit" && f.count === 1, JSON.stringify(f));
  check("and it is named, so the client can go look at it", (f?.samples || []).some((s) => /Bank statement/.test(s)), JSON.stringify(f?.samples));
  check("and the explanation is the one that matters", /can never answer from them/i.test(f?.detail || ""), f?.detail);
}

/* ---- documents nothing owns, which forget cannot remove ---- */
{
  const env = makeEnv({ vectorCount: 1 });
  doc(env._db, "orph", { source: "mystery" }); chunk(env._db, "orph#0", "orph");
  const f = find(await diagnose(env), "unregistered_source");
  check("documents under an unregistered source are caught", f?.severity === "warn", JSON.stringify(f));
  check("and it says forget cannot remove them", /forget` cannot remove/i.test(f?.detail || ""), f?.detail);
}

/* ---- a source that promises coverage it does not have ---- */
{
  const env = makeEnv({ vectorCount: 0 });
  source(env._db, "gmail");
  const f = find(await diagnose(env), "empty_source");
  check("a registered source holding nothing is caught", f?.severity === "warn", JSON.stringify(f));
}

/* ---- once zoning starts, a partially assigned source registry is visible ---- */
{
  const env = makeEnv({ vectorCount: 1 });
  source(env._db, "documents", "books");
  source(env._db, "archive");
  doc(env._db, "d1"); chunk(env._db, "d1#0", "d1");
  const f = find(await diagnose(env), "zone_assignment");
  check("a partially zoned source registry is caught", f?.severity === "warn" && f.count === 1, JSON.stringify(f));
  check("the zone assignment finding stays aggregate-only",
    f && !("samples" in f) && !/\"documents\"|\"archive\"/.test(JSON.stringify(f)), JSON.stringify(f));
  check("and it names the commands that complete the assignment",
    /brain sources/.test(f?.action || "") && /brain zone/.test(f?.action || ""), f?.action);
}

/* ---- legacy row projections cannot silently look ready for row-local auth ---- */
{
  const env = makeEnv({ vectorCount: 1 });
  source(env._db, "documents", "books");
  doc(env._db, "d1"); chunk(env._db, "d1#0", "d1");
  env._db.prepare("UPDATE documents SET zone = NULL WHERE doc_uid = 'd1'").run();
  env._db.prepare("UPDATE chunks SET zone = NULL WHERE chunk_uid = 'd1#0'").run();
  const r = await diagnose(env);
  const f = find(r, "zone_projection");
  check("document and chunk zone projection drift is counted", f?.severity === "warn" && f.count === 2, JSON.stringify(f));
  check("the finding states that current source authorization remains intact",
    /does not widen/.test(f?.detail || "") && /source-authoritative/.test(f?.action || ""), JSON.stringify(f));
  check("projection drift makes the overall diagnosis usable with gaps",
    r.verdict === "usable_with_gaps", r.verdict);
}

/* ---- a chunk cannot silently claim a different source than its document ---- */
{
  const env = makeEnv({ vectorCount: 1 });
  source(env._db, "documents", "books");
  source(env._db, "medical", "medical");
  doc(env._db, "d1"); chunk(env._db, "d1#0", "d1");
  env._db.prepare("UPDATE chunks SET source = 'medical' WHERE chunk_uid = 'd1#0'").run();
  const f = find(await diagnose(env), "chunk_document_source_mismatch");
  check("chunk and document source drift is caught",
    f?.severity === "warn" && f.count === 1, JSON.stringify(f));
  check("the mismatch finding states that document-source authorization still holds",
    /does not widen access/.test(f?.detail || "") && /Reingest/.test(f?.action || ""), JSON.stringify(f));
}

/* ---- chunks whose document is gone ---- */
{
  // The schema has a real foreign key here, so this state cannot be reached
  // through the normal path. That is worth knowing and worth asserting. The
  // check stays because a future writer that bypasses the constraint, or a
  // restore that lands the two tables out of step, would produce exactly this.
  const guard = makeEnv({ vectorCount: 1 });
  source(guard._db, "documents");
  let blocked = null;
  try { chunk(guard._db, "ghost#0", "no-such-doc"); } catch (e) { blocked = e.message; }
  check("the schema PREVENTS an orphan chunk in the first place", /FOREIGN KEY/i.test(blocked || ""), blocked);

  const env = makeEnv({ vectorCount: 1 });
  env._db.exec("PRAGMA foreign_keys = OFF");
  source(env._db, "documents");
  chunk(env._db, "ghost#0", "no-such-doc");
  const f = find(await diagnose(env), "orphan_chunks");
  check("and if one ever does appear, it is caught", f?.severity === "crit" && f.count === 1, JSON.stringify(f));
}

/* ---- the same folder loaded twice ---- */
{
  const env = makeEnv({ vectorCount: 3 });
  source(env._db, "documents"); source(env._db, "documents-again");
  doc(env._db, "a", { hash: "same" }); chunk(env._db, "a#0", "a");
  doc(env._db, "b", { hash: "same", source: "documents-again" }); chunk(env._db, "b#0", "b");
  doc(env._db, "c", { hash: "other" }); chunk(env._db, "c#0", "c");
  const f = find(await diagnose(env), "duplicate_documents");
  check("the same content stored twice is caught", f?.count === 1, JSON.stringify(f));
}

/* ---- duplicate document totals must never be capped by the sample limit ---- */
{
  const env = makeEnv({ vectorCount: 30 });
  source(env._db, "documents");
  for (let group = 0; group < 15; group++) {
    for (let copy = 0; copy < 2; copy++) {
      const id = `g${group}-copy${copy}`;
      doc(env._db, id, { hash: `shared-${group}` });
      chunk(env._db, `${id}#0`, id);
    }
  }
  const f = find(await diagnose(env, { sampleLimit: 3 }), "duplicate_documents");
  check("duplicate document count covers every group even with a small sample limit",
    f?.count === 15 && /15 exact-content group/.test(f?.detail || ""), JSON.stringify(f));
}

/* ---- the spreadsheet that eats the corpus ---- */
{
  const env = makeEnv({ vectorCount: 60 });
  source(env._db, "documents");
  doc(env._db, "sheet", { title: "Transactions 2026.xlsx" });
  for (let i = 0; i < 50; i++) chunk(env._db, `sheet#${i}`, "sheet", "row text", i);
  for (let i = 0; i < 10; i++) { doc(env._db, `d${i}`); chunk(env._db, `d${i}#0`, `d${i}`); }
  const f = find(await diagnose(env), "chunk_outliers");
  check("one document dominating the corpus is caught", f?.severity === "warn" && f.count === 50, JSON.stringify(f));
  check("and the offender is named", (f?.samples || []).some((s) => /Transactions 2026/.test(s)), JSON.stringify(f?.samples));
}

/* ---- text that is silently truncated before embedding ---- */
{
  const env = makeEnv({ vectorCount: 3 });
  source(env._db, "documents");
  for (const i of [1, 2, 3]) { doc(env._db, `d${i}`); chunk(env._db, `d${i}#0`, `d${i}`, "x".repeat(3000)); }
  const f = find(await diagnose(env), "oversized_chunks");
  check("chunks past the embedding ceiling are caught", f?.count === 3, JSON.stringify(f));
  check("and the consequence is stated, not just the count", /never searchable by meaning/i.test(f?.detail || ""), f?.detail);
}

/* ---- duplicate chunk measurement is exact only inside its safe budget ---- */
{
  const env = makeEnv({ vectorCount: 24 });
  source(env._db, "documents");
  for (let i = 0; i < 24; i++) {
    doc(env._db, `d${i}`);
    chunk(env._db, `d${i}#0`, `d${i}`, `repeated-${i % 12}`);
  }
  const measured = find(await diagnose(env), "duplicate_chunks");
  check("duplicate chunk groups are measured inside the safe scan budget",
    measured?.count === 12 && measured?.observable !== false, JSON.stringify(measured));

  const bounded = find(await diagnose(env, { duplicateChunkScanLimit: 10 }), "duplicate_chunks");
  check("large-corpus duplicate chunk checks report not observable instead of a failed warning",
    bounded?.severity === "info" && bounded?.observable === false && bounded?.area === "efficiency",
    JSON.stringify(bounded));
}

/* ---- undated documents: warn only when it distorts recency ---- */
{
  const env = makeEnv({ vectorCount: 2 });
  source(env._db, "documents");
  doc(env._db, "d1", { date: null }); chunk(env._db, "d1#0", "d1");
  doc(env._db, "d2"); chunk(env._db, "d2#0", "d2");
  check("half the corpus undated is a warning", find(await diagnose(env), "undated")?.severity === "warn");

  const env2 = makeEnv({ vectorCount: 10 });
  source(env2._db, "documents");
  doc(env2._db, "u", { date: null }); chunk(env2._db, "u#0", "u");
  for (let i = 0; i < 9; i++) { doc(env2._db, `k${i}`); chunk(env2._db, `k${i}#0`, `k${i}`); }
  check("one in ten undated is only information, not a warning",
    find(await diagnose(env2), "undated")?.severity === "info");
}

/* ---- a stalled queue, which is the failure that started all of this ---- */
{
  const env = makeEnv({ vectorCount: 1 });
  source(env._db, "documents");
  doc(env._db, "d1"); chunk(env._db, "d1#0", "d1");
  doc(env._db, "d2"); chunk(env._db, "d2#0", "d2");
  env._db.prepare("INSERT INTO vector_outbox (chunk_uid, op, queued_at, attempts) VALUES (?,?,?,?)")
    .run("d2#0", "upsert", Date.now() - 90 * 60000, 0);
  const r = await diagnose(env);
  const f = find(r, "backlog");
  check("a backlog older than 30 minutes is CRITICAL, not informational", f?.severity === "crit", JSON.stringify(f));
  check("and it names brain drain", /brain drain/.test(f?.action || ""), f?.action);
  check("an old queue requests attention without inventing drain history",
    /cannot prove the scheduled drain has stopped/.test(f?.detail || "") && !/NOT running|no recorded drain pass/.test(f?.detail || ""), f?.detail);
}

/* A real completed request clears its lease but retains its accepted mutation.
   That cannot be reported as proof that no drain pass has occurred. */
{
  const { env, db } = makeDrainEnv();
  seedDrain(db, 2);
  const receipt = await drainOutbox(env, { embed: embedDrain });
  const released = db.prepare("SELECT vector_drain_lease_owner AS owner, vector_drain_lease_expires_at AS expiry FROM install_state").get();
  const f = find(await diagnose(env), "backlog");
  check("a real drain releases its lease after durable provider submission",
    receipt.submitted === 2 && released.owner === null && released.expiry === null);
  check("a released lease does not erase evidence of the recent vector submission",
    f?.severity === "warn" && /last vector submission 0 min ago/.test(f?.detail || "") &&
      !/NOT running|no recorded drain pass/.test(f?.detail || ""), JSON.stringify(f));
  db.close();
}

/* ---- behind is not stalled: the distinction a bulk backfill exposed ----
   The drain ran on its trigger the whole time while this check told the
   operator it was not running. A live lease proves current ownership only;
   the newest queued row shows whether a producer is still feeding the queue. */
{
  const seedBacklog = async (env, { newestMinutesAgo }) => {
    source(env._db, "documents");
    doc(env._db, "d1"); chunk(env._db, "d1#0", "d1");
    doc(env._db, "d2"); chunk(env._db, "d2#0", "d2");
    env._db.prepare("INSERT INTO vector_outbox (chunk_uid, op, queued_at, attempts) VALUES (?,?,?,?)")
      .run("d1#0", "upsert", Date.now() - 90 * 60000, 0);
    env._db.prepare("INSERT INTO vector_outbox (chunk_uid, op, queued_at, attempts) VALUES (?,?,?,?)")
      .run("d2#0", "upsert", Date.now() - newestMinutesAgo * 60000, 0);
    env._db.prepare("UPDATE install_state SET schema_version=12 WHERE id=1").run();
    await acquireDrainLease(env, { ownerToken: "fixture-diagnose-owner" });
  };

  const loading = makeEnv({ vectorCount: 1 });
  await seedBacklog(loading, { newestMinutesAgo: 1 });
  const whileLoading = find(await diagnose(loading), "backlog");
  check("a live drain and incoming documents are reported as evidence, without claiming convergence",
    whileLoading?.severity === "warn" && /active drain request/.test(whileLoading?.detail || "") && /still arriving/.test(whileLoading?.detail || ""),
    JSON.stringify(whileLoading));
  check("and it never claims the drain is not running",
    !/NOT running/.test(whileLoading?.detail || ""), whileLoading?.detail);
  check("and it says to let the load finish first",
    /Let the active work finish/.test(whileLoading?.action || ""), whileLoading?.action);

  const catchingUp = makeEnv({ vectorCount: 1 });
  await seedBacklog(catchingUp, { newestMinutesAgo: 45 });
  const afterLoad = find(await diagnose(catchingUp), "backlog");
  check("an active lease is reported without claiming completed progress",
    afterLoad?.severity === "warn" && /active drain request/.test(afterLoad?.detail || ""),
    JSON.stringify(afterLoad));
  check("a lease without a mutation cannot invent a past submission time",
    /no vector submission timestamp is available/.test(afterLoad?.detail || ""), afterLoad?.detail);
}

/* Real visibility backoff is pending work, not an operator quarantine. */
{
  const { env, db } = makeDrainEnv();
  source(db, "drive");
  seedDrain(db, 40);
  db.prepare("UPDATE vector_outbox SET queued_at=?").run(Date.now());
  const submitted = await drainOutbox(env, {
    embed: embedDrain, embedBatch: async (texts) => texts.map(() => [0.1]), batchSize: 40,
  });
  env._advanceWatermarkWithoutApplying();
  const retried = await drainOutbox(env, { embed: embedDrain });
  const state = db.prepare("SELECT count(*) n FROM vector_outbox_retry_state WHERE attempts=1 AND failure_code='visibility_mismatch' AND quarantined_at IS NULL").get();
  const report = await diagnose(env);
  const f = find(report, "vector_retries");
  check("forty actual visibility mismatches retain scheduled retry state",
    submitted.submitted === 40 && retried.failed === 40 && state.n === 40,
    JSON.stringify({ submitted, retried, state }));
  check("a first visibility retry is not called quarantined or set aside",
    !find(report, "quarantined"), JSON.stringify(find(report, "quarantined")));
  check("normal visibility backoff reports its delayed count without rebuild advice",
    f?.count === 40 && f.severity === "info" && /40.*retry delay/.test(f.detail) &&
      !/reindex|set aside|quarantin/i.test(JSON.stringify(f)), JSON.stringify(f));
  db.close();
}

/* ---- only the current generation's durable quarantine is authoritative ---- */
{
  const env = makeEnv({ vectorCount: 1 });
  source(env._db, "documents");
  doc(env._db, "d1"); chunk(env._db, "d1#0", "d1");
  env._db.prepare("INSERT INTO vector_outbox (chunk_uid, op, queued_at, attempts, last_error) VALUES (?,?,?,?,?)")
    .run("d1#0", "upsert", Date.now(), 3, "id too long; max is 64 bytes, got 67 bytes");
  const row = env._db.prepare("SELECT generation FROM vector_outbox WHERE chunk_uid='d1#0'").get();
  const insertRetry = env._db.prepare(`INSERT INTO vector_outbox_retry_state
    (chunk_uid,generation,attempts,next_attempt_at,last_attempt_at,quarantined_at,failure_code,last_error)
    VALUES ('d1#0',?,3,?,?,?,'embedding_failure','id too long; max is 64 bytes, got 67 bytes')`);
  const stamp = Date.now();
  insertRetry.run(row.generation - 1, stamp, stamp, stamp);
  const stale = await diagnose(env);
  check("a previous generation's quarantine cannot label the current row quarantined",
    !find(stale, "quarantined"), JSON.stringify(find(stale, "quarantined")));
  check("legacy attempts without current retry state do not invent a retry schedule",
    /0.*retry delay/.test(find(stale, "vector_retries")?.detail || ""));
  insertRetry.run(row.generation, stamp, stamp, 0);
  const f = find(await diagnose(env), "quarantined");
  check("quarantined chunks are caught", f?.severity === "crit" && f.count === 1, JSON.stringify(f));
  check("and the real error is shown verbatim", (f?.samples || []).some((s) => /64 bytes/.test(s)), JSON.stringify(f?.samples));
  check("quarantine repair uses its explicit preview and confirmation, not a whole index rebuild",
    /vector-retry/.test(f?.action || "") && /preview|confirm/.test(f?.action || "") && !/reindex/.test(f?.action || ""), f?.action);
  check("a quarantined row is excluded from ordinary retry totals", !find(await diagnose(env), "vector_retries"));
}

/* ---- one bounded keyset pass covers the final page and sparse integer ids ---- */
{
  const env = makeEnv({ vectorCount: 5 });
  source(env._db, "documents");
  for (let i = 1; i <= 8; i++) {
    doc(env._db, `paged-${i}`);
    chunk(env._db, `paged-${i}#0`, `paged-${i}`, i === 8 ? "   " : `text-${i}`);
  }
  env._db.prepare("DELETE FROM chunks WHERE id IN (2, 4, 5)").run();

  const report = await diagnose(env, { chunkPageSize: 2 });
  const pageQueries = env._queryLog.filter((entry) => /WITH chunk_page AS MATERIALIZED/.test(entry.sql));
  check("a defect in the final keyset page is still counted",
    find(report, "blank_chunks")?.count === 1, JSON.stringify(report));
  check("sparse chunk ids reach the fixed high-water without inventing rows",
    report.complete === true && report.totals.chunks === 5 && report.scan.pages === 3 &&
      report.scan.coveredThroughId === report.scan.highWaterId && report.scan.highWaterId === 8,
    JSON.stringify(report.scan));
  check("every chunk page is range-bounded and never uses OFFSET",
    pageQueries.length === 3 && pageQueries.every((entry) =>
      /id > \?1 AND id <= \?2/.test(entry.sql) && /LIMIT \?3/.test(entry.sql) &&
      !/OFFSET/i.test(entry.sql) && entry.params[2] === 2), JSON.stringify(pageQueries));
  check("the returned statement count matches every D1 statement actually issued",
    report.scan.statements === env._queryLog.length, `${report.scan.statements}/${env._queryLog.length}`);

  const plan = env._db.prepare(`EXPLAIN QUERY PLAN ${DIAGNOSE_CHUNK_PAGE_SQL}`).all(0, 8, 2, 1800);
  check("SQLite plans the chunk page from the integer primary key range",
    plan.some((row) => /SEARCH chunks USING INTEGER PRIMARY KEY \(rowid>[?]? AND rowid<[?]?\)/i.test(row.detail)),
    JSON.stringify(plan));
}

/* ---- a failed page stays incomplete and discards every dependent partial count ---- */
{
  let page = 0;
  const env = makeEnv({
    vectorCount: 6,
    beforeStatement: ({ sql }) => {
      if (/WITH chunk_page AS MATERIALIZED/.test(sql) && ++page === 2) {
        throw new Error("synthetic page timeout");
      }
    },
  });
  source(env._db, "documents");
  for (let i = 1; i <= 6; i++) {
    doc(env._db, `failure-${i}`);
    chunk(env._db, `failure-${i}#0`, `failure-${i}`, i === 1 ? "" : `text-${i}`);
  }
  const report = await diagnose(env, { chunkPageSize: 2 });
  check("a page failure returns an explicitly incomplete scan",
    report.complete === false && report.scan.complete === false &&
      report.scan.reason === "page_query_failed" && report.scan.pages === 1,
    JSON.stringify(report.scan));
  check("partial chunk totals and findings are never promoted to exact results",
    report.totals.chunks === null && !find(report, "blank_chunks") &&
      report.skippedChecks.includes("blank_chunks") && report.skippedChecks.includes("store_agreement"),
    JSON.stringify({ totals: report.totals, skipped: report.skippedChecks, findings: report.findings }));
}

/* ---- statement and page budgets stop before an unbracketed partial result ---- */
{
  const seed = (env) => {
    source(env._db, "documents");
    for (let i = 1; i <= 6; i++) {
      doc(env._db, `budget-${i}`);
      chunk(env._db, `budget-${i}#0`, `budget-${i}`);
    }
  };
  const statementEnv = makeEnv({ vectorCount: 6 });
  seed(statementEnv);
  const statementReport = await diagnose(statementEnv, { chunkPageSize: 2, statementBudget: 4 });
  check("statement exhaustion preserves one closing marker and returns incomplete",
    statementReport.complete === false && statementReport.scan.reason === "statement_budget_exhausted" &&
      statementReport.scan.statements === 4 && statementEnv._queryLog.length === 4,
    JSON.stringify(statementReport.scan));

  const pageEnv = makeEnv({ vectorCount: 6 });
  seed(pageEnv);
  const pageReport = await diagnose(pageEnv, { chunkPageSize: 2, chunkPageBudget: 1 });
  check("the explicit page budget cannot turn prefix coverage into a clean diagnosis",
    pageReport.complete === false && pageReport.scan.reason === "page_budget_exhausted" &&
      pageReport.scan.coveredThroughId < pageReport.scan.highWaterId && pageReport.totals.chunks === null,
    JSON.stringify(pageReport.scan));
}

/* ---- a concurrent corpus mutation invalidates the otherwise complete pages ---- */
{
  let markers = 0;
  const env = makeEnv({
    vectorCount: 4,
    beforeStatement: ({ sql, db }) => {
      if (/SELECT i\.schema_version AS schema_version/.test(sql) && ++markers === 2) {
        db.prepare("UPDATE install_state SET outbox_generation = outbox_generation + 1 WHERE id = 1").run();
      }
    },
  });
  source(env._db, "documents");
  for (let i = 1; i <= 4; i++) {
    doc(env._db, `mutation-${i}`);
    chunk(env._db, `mutation-${i}#0`, `mutation-${i}`, i === 4 ? "" : `text-${i}`);
  }
  const report = await diagnose(env, { chunkPageSize: 2 });
  check("a changed corpus marker makes the whole diagnosis incomplete",
    report.complete === false && report.scan.reason === "corpus_changed_during_diagnosis" &&
      report.scan.mutationStart.outboxGeneration !== report.scan.mutationEnd.outboxGeneration,
    JSON.stringify(report.scan));
  check("findings derived from the moving chunk snapshot are removed",
    report.totals.chunks === null && !find(report, "blank_chunks") &&
      report.skippedChecks.includes("blank_chunks"), JSON.stringify(report));
}

/* ---- the supported bounded zone repair has its own durable mutation receipt ---- */
{
  let markers = 0;
  let env;
  env = makeEnv({
    vectorCount: 4,
    beforeStatement: async ({ sql }) => {
      if (/SELECT i\.schema_version AS schema_version/.test(sql) && ++markers === 2) {
        await assignZone(env, { source: "documents", zone: "books" });
      }
    },
  });
  source(env._db, "documents", "books");
  for (let i = 1; i <= 4; i++) {
    doc(env._db, `zone-mutation-${i}`);
    chunk(env._db, `zone-mutation-${i}#0`, `zone-mutation-${i}`);
  }
  env._db.prepare("UPDATE documents SET zone = NULL WHERE source = 'documents'").run();
  env._db.prepare("UPDATE chunks SET zone = NULL WHERE source = 'documents'").run();

  const report = await diagnose(env, { chunkPageSize: 2 });
  check("a concurrent supported zone projection repair invalidates the diagnosis",
    report.complete === false && report.scan.reason === "corpus_changed_during_diagnosis" &&
      report.scan.changedMarkers.includes("sources") &&
      report.scan.mutationStart.sourceEventHighWater < report.scan.mutationEnd.sourceEventHighWater,
    JSON.stringify(report.scan));
  check("a zone count observed before the concurrent repair is not published as current",
    report.totals.chunks === null && !find(report, "zone_projection") &&
      report.skippedChecks.includes("zone_projection"), JSON.stringify(report));
  check("the zone mutation marker exposes no provider mutation identity",
    !Object.hasOwn(report.scan.mutationStart, "vectorProjectionMutationId") &&
      !Object.hasOwn(report.scan.mutationEnd, "vectorProjectionMutationId"),
    JSON.stringify(report.scan));
}

/* ---- source registration is bracketed even before its first ingest receipt ---- */
{
  let markers = 0;
  let env;
  env = makeEnv({
    vectorCount: 2,
    beforeStatement: async ({ sql }) => {
      if (/SELECT i\.schema_version AS schema_version/.test(sql) && ++markers === 2) {
        await resolveSourceKind(env, {
          source: "new-source", requestedKind: "upload", defaultKind: "upload",
        });
      }
    },
  });
  source(env._db, "documents");
  for (let i = 1; i <= 2; i++) {
    doc(env._db, `source-mutation-${i}`);
    chunk(env._db, `source-mutation-${i}#0`, `source-mutation-${i}`);
  }
  const report = await diagnose(env, { chunkPageSize: 1 });
  check("a concurrent supported source registration invalidates the diagnosis",
    report.complete === false && report.scan.changedMarkers.includes("sources") &&
      report.scan.mutationStart.sourceCount + 1 === report.scan.mutationEnd.sourceCount,
    JSON.stringify(report.scan));
  check("a source total from before that registration is not presented as current",
    report.totals.sources === null, JSON.stringify(report.totals));
}

/* ---- a supported document removal cannot leave a clean blended count ---- */
{
  let markers = 0;
  let env;
  env = makeEnv({
    vectorCount: 4,
    beforeStatement: async ({ sql }) => {
      if (/SELECT i\.schema_version AS schema_version/.test(sql) && ++markers === 2) {
        await forget(env, { docUids: ["document-mutation-2"], dryRun: false });
      }
    },
  });
  source(env._db, "documents");
  for (let i = 1; i <= 4; i++) {
    doc(env._db, `document-mutation-${i}`);
    chunk(env._db, `document-mutation-${i}#0`, `document-mutation-${i}`);
  }
  const report = await diagnose(env, { chunkPageSize: 2 });
  check("a concurrent supported document removal invalidates the diagnosis",
    report.complete === false && report.scan.changedMarkers.includes("corpus") &&
      report.scan.mutationStart.outboxGeneration < report.scan.mutationEnd.outboxGeneration,
    JSON.stringify(report.scan));
  check("the pre-removal chunk total and store parity are withheld",
    report.totals.documents === null && report.totals.chunks === null &&
      !find(report, "store_agreement") &&
      report.skippedChecks.includes("store_agreement"), JSON.stringify(report));
}

/* ---- a missing closing marker withholds every unbracketed count ---- */
{
  let markers = 0;
  const env = makeEnv({
    vectorCount: 2,
    beforeStatement: ({ sql }) => {
      if (/SELECT i\.schema_version AS schema_version/.test(sql) && ++markers === 2) {
        throw new Error("synthetic closing marker timeout");
      }
    },
  });
  source(env._db, "documents");
  for (let i = 1; i <= 2; i++) {
    doc(env._db, `closing-${i}`);
    chunk(env._db, `closing-${i}#0`, `closing-${i}`);
  }
  const report = await diagnose(env, { chunkPageSize: 1 });
  check("an unavailable closing marker cannot leave a page-derived count behind",
    report.complete === false && report.scan.reason === "closing_marker_unavailable" &&
      report.totals.documents === null && report.totals.chunks === null &&
      report.totals.sources === null,
    JSON.stringify({ scan: report.scan, totals: report.totals }));
  check("findings that depended on the unbracketed chunk pages are removed",
    !find(report, "store_agreement") && report.skippedChecks.includes("store_agreement"),
    JSON.stringify(report));
}

/* ---- store parity waits for an exact, settled vector cut ---- */
{
  const env = makeEnv({ vectorCount: 2 });
  source(env._db, "documents");
  for (let i = 1; i <= 2; i++) {
    doc(env._db, `unsettled-${i}`);
    chunk(env._db, `unsettled-${i}#0`, `unsettled-${i}`);
  }
  env._db.prepare(
    "INSERT INTO vector_outbox (chunk_uid, op, queued_at, attempts) VALUES (?, 'upsert', ?, 0)",
  ).run("unsettled-2#0", Date.now());
  const report = await diagnose(env, { chunkPageSize: 1 });
  const parity = find(report, "store_agreement");
  check("an unsettled provider projection is not mislabeled as missing or orphan vectors",
    parity?.severity === "warn" && parity.observable === false &&
      /cannot be compared/.test(parity.title) && !/disagree/.test(parity.title),
    JSON.stringify(parity));
}

/* ---- expensive optional groupings say not observable at scale ---- */
{
  const env = makeEnv({ vectorCount: 6 });
  source(env._db, "documents");
  for (let i = 1; i <= 6; i++) {
    doc(env._db, `optional-${i}`);
    chunk(env._db, `optional-${i}#0`, `optional-${i}`, `shared-${i % 2}`);
  }
  const report = await diagnose(env, { duplicateChunkScanLimit: 3, chunkPageSize: 2 });
  check("large-corpus duplicate and outlier checks are explicit non-observations",
    report.complete === true && find(report, "duplicate_chunks")?.observable === false &&
      find(report, "chunk_outliers")?.observable === false,
    JSON.stringify(report.findings));
  check("skipped optional measurements do not claim measured defects",
    !find(report, "duplicate_chunks")?.count && !find(report, "chunk_outliers")?.count,
    JSON.stringify(report.findings));
}

/* ---- it must degrade rather than explode ---- */
{
  const env = makeEnv();               // no VECTORIZE binding at all
  source(env._db, "documents");
  doc(env._db, "d1"); chunk(env._db, "d1#0", "d1");
  let threw = null, r = null;
  try { r = await diagnose(env); } catch (e) { threw = e.message; }
  check("no Vectorize binding does not throw", threw === null, `threw: ${threw}`);
  check("and it says the comparison could not be made rather than passing it or going healthy",
    find(r, "store_agreement")?.severity === "warn" &&
      find(r, "store_agreement")?.observable === false && r.complete === false &&
      r.verdict !== "healthy" && r.skippedChecks.includes("store_agreement"),
    JSON.stringify({ finding: find(r, "store_agreement"), complete: r.complete, verdict: r.verdict }));
}

console.log(`\ndiagnose: ${ran - fail}/${ran} passed`);
if (fail) process.exit(1);
