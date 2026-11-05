import { RECOVERY_DURABLE_TABLES, RECOVERY_EXPORT_TABLES, RECOVERY_AGGREGATE_SQL } from "../operations/cloudflare-recovery-adapter.mjs";
import { splitStatements } from "../brain.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { backfillSourceFamilyIndex } from "../worker/src/lib/source-family-index.js";
import { listSourceFamilies, forgetFamilies } from "../worker/src/lib/store-d1.js";

const migration = readFileSync(new URL("../migrations/d1/0059_document_family_index.sql", import.meta.url), "utf8");
function fixture({ upgrade = false, path = ":memory:" } = {}) {
  const db = new DatabaseSync(path);
  for (const name of readdirSync(new URL("../migrations/d1/", import.meta.url)).filter(n => n.endsWith(".sql")).sort()) {
    if (!upgrade || !name.startsWith("0059_")) db.exec(readFileSync(new URL(`../migrations/d1/${name}`, import.meta.url), "utf8"));
  }
  db.exec("INSERT INTO install_state(id,client_slug,product_version,schema_version,installed_at) VALUES(1,'fixture','0.0.0',58,'2026-01-01T00:00:00Z')");
  const reads = [];
  const prepare = (sql, params = []) => ({
    sql, params,
    bind: (...values) => prepare(sql, values),
    all: async () => {
      reads.push({ sql, params });
      return { results: db.prepare(sql).all(...params) };
    },
    first: async () => db.prepare(sql).get(...params) ?? null,
    run: async () => ({ results: db.prepare(sql).all(...params), success: true }),
  });
  const batches = [];
  const env = { STORAGE: "d1", DB: { prepare, batch: async statements => {
    batches.push(statements);
    db.exec("BEGIN");
    try {
      const results = statements.map(({ sql, params }) => ({ results: db.prepare(sql).all(...params), success: true }));
      db.exec("COMMIT"); return results;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } } };
  const put = (uid, meta = "{}", title = "Synthetic document", deleted = null) => {
    const colon = uid.indexOf(":");
    db.prepare(`INSERT INTO documents(doc_uid,source,source_id,title,ingested_at,content_hash,meta,deleted_at)
      VALUES(?,?,?,?,1,'fixture',?,?)`).run(uid, uid.slice(0, colon), uid.slice(colon + 1), title, meta, deleted);
  };
  const plan = ({ sql, params }) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(r => r.detail).join("\n");
  return { db, env, put, reads, plan, batches };
}

test("inventory seeks the family index after a nonempty page control", async () => {
  const f = fixture();
  for (let i = 0; i < 100; i++) f.put(`drive:${String(i).padStart(4, "0")}`);
  await backfillSourceFamilyIndex(f.env);
  const result = await listSourceFamilies(f.env, { source: "drive", cursor: "drive:0050", limit: 2 });
  assert.deepEqual(result.families, ["drive:0051", "drive:0052"]);
  const read = f.reads.findLast(r => /SELECT family_doc_uid/.test(r.sql));
  assert.ok(read, "the real inventory decision executed");
  assert.doesNotMatch(f.plan(read), /SCAN documents|USE TEMP B-TREE/);
  assert.match(f.plan(read), /SEARCH.*family/);
  f.db.close();
});

test("declared forget seeks membership after finding a real target", async () => {
  const f = fixture();
  f.put("message:one", JSON.stringify({ family_of: "upload:export" }));
  await backfillSourceFamilyIndex(f.env);
  const result = await forgetFamilies(f.env, { families: [{ base_doc_uid: "upload:export", family_kind: "declared" }] });
  assert.deepEqual(result.targets, ["message:one"]);
  const read = f.reads.findLast(r => /AS family_of/.test(r.sql));
  assert.ok(read, "the real declared-membership decision executed");
  assert.doesNotMatch(f.plan(read), /SCAN documents/);
  assert.match(f.plan(read), /SEARCH.*declared/);
  f.db.close();
});

async function finish(f) {
  for (let i = 0; i < 1000; i++) {
    if ((await backfillSourceFamilyIndex(f.env)).complete) return;
  }
  assert.fail("bounded synthetic walk did not finish");
}

async function pages(f, options) {
  const output = [];
  const seen = new Set();
  let cursor = "";
  do {
    const page = await listSourceFamilies(f.env, { ...options, cursor });
    for (const uid of page.families) {
      assert.ok(!seen.has(uid), "no family repeats across cursor boundaries");
      seen.add(uid);
    }
    output.push(JSON.stringify(page));
    assert.ok(!page.next_cursor || page.next_cursor > cursor, "cursor makes progress");
    cursor = page.next_cursor;
  } while (cursor);
  return output;
}

const sources = ["drive", "gmail", "upload", "message", "calendar", "imap", "zoom",
  "imessage", "whatsapp", "microsoft", "quickbooks", "quickbooks_desktop", "custom_api",
  "fixture", "odd:namespace", "fixture_", "fixture%", "fixture;", "é"];
function corpus(f, count = 60) {
  for (const source of sources) for (let i = 0; i < count; i++) {
    const id = String(i).padStart(4, "0");
    const base = `${source}:${id}`;
    if (i % 6 === 0) {
      for (let part = 1; part <= 3; part++) f.put(`${base}#part${part}of3`,
        JSON.stringify({ part_of: i % 12 ? base : id, part, part_count: 3, folder: "Reviewed/Folder" }),
        `Synthetic ${id} (part ${part} of 3)`);
    } else if (i % 6 === 1) f.put(base, JSON.stringify({ family_of: `upload:export-${id}` }));
    else if (i % 6 === 2) f.put(base, "{broken");
    else if (i % 6 === 3) f.put(base, JSON.stringify({ family_of: "", part_of: 12 }));
    else if (i % 6 === 4) f.put(base, JSON.stringify({ family_of: false, part_of: ` ${id} ` }));
    else f.put(base, "null", " ", i % 2 ? 1 : null);
  }
  f.put("drive:control", '{"family_of":"drive:control","part_of":"ignored"}');
  f.put("drive:empty", '{"family_of":""}');
  f.put("drive:space", '{"family_of":" drive:space "}');
  f.put("drive:numeric", '{"family_of":12,"part_of":""}');
  f.put("drive:array", "[]");
  f.put("drive:null", null);
}

test("all inventory pages and labels are byte-identical during and after backfill", async () => {
  const f = fixture({ upgrade: true });
  corpus(f);
  const cases = [null, ...sources, "missing"].flatMap(source => [false, true].flatMap(includeLabels =>
    [1, 7, 500].map(limit => ({ source, includeLabels, limit }))));
  cases.push({ source: "drive", includeLabels: true, limit: 1,
    uids: ["drive:0000", "drive:0002", "drive:control"] });
  const before = [];
  for (const options of cases) before.push(await pages(f, options));
  f.db.exec(migration);
  const marker = JSON.stringify(f.db.prepare("SELECT * FROM ingest_removal_generation").get());
  const first = await backfillSourceFamilyIndex(f.env);
  assert.equal(first.advanced, 500);
  assert.equal(first.complete, false);
  assert.deepEqual(await pages(f, { source: "drive", includeLabels: true, limit: 7 }),
    before[cases.findIndex(o => o.source === "drive" && o.includeLabels && o.limit === 7)]);
  await finish(f);
  f.reads.length = 0;
  for (let i = 0; i < cases.length; i++) assert.deepEqual(await pages(f, cases[i]), before[i]);
  assert.ok(f.reads.some(r => /FROM document_family_index/.test(r.sql)), "indexed page arm executed");
  assert.equal(JSON.stringify(f.db.prepare("SELECT * FROM ingest_removal_generation").get()), marker,
    "projection preparation preserves approval generations");
  for (const options of [{ source: "drive", cursor: "drive:0006", limit: 3 },
    { source: null, cursor: "message:", limit: 3 },
    { source: "drive", cursor: "drive:0006", limit: 3, includeLabels: true },
    { source: "drive", limit: 3, uids: ["drive:0000", "drive:control"] }]) {
    f.reads.length = 0;
    const result = await listSourceFamilies(f.env, options);
    assert.ok(result.families.length > 0, "query-plan control finds families");
    const read = f.reads.findLast(r => /SELECT family_doc_uid/.test(r.sql));
    assert.doesNotMatch(f.plan(read), /SCAN documents|USE TEMP B-TREE/);
    assert.match(f.plan(read), /SEARCH.*idx_document_family_live/);
    assert.ok(read.params.length <= 100);
  }
  f.db.close();
});

test("forget receipts and committed deletes match the legacy resolver", async () => {
  const results = [];
  for (const indexed of [false, true]) {
    const f = fixture();
    corpus(f, 12);
    f.put("gmail:base");
    f.put("gmail:base#part1of2", '{"part_of":"base","part":1,"part_count":2}');
    f.put("gmail:base#part2of2", '{"part_of":"base","part":2,"part_count":2}');
    f.put("gmail:base#part3of2", '{"part_of":"base"}');
    f.put("gmail:base#part-neighbor", "{}");
    f.put("gmail:base#paru", "{}");
    f.put("message:tombstone", '{"family_of":"upload:export-0001"}', "Synthetic", 1);
    if (indexed) await finish(f);
    const families = [
      { base_doc_uid: "gmail:base", family_kind: "structural", keep_doc_uids: ["gmail:base#part1of2"] },
      { base_doc_uid: "upload:export-0001", family_kind: "declared", keep_doc_uids: ["message:0001"] },
      { base_doc_uid: "drive:0000", family_kind: "hybrid", keep_doc_uids: ["drive:0000#part2of3"] },
      ...Array.from({ length: 26 }, (_, i) => ({ base_doc_uid: `fixture:absent-${i}` })),
    ];
    const preview = await forgetFamilies(f.env, { families });
    assert.ok(preview.targets.length > 20, "nonempty multi-source scope reached deletion decision");
    assert.ok(preview.excluded_documents >= 2, "ambiguous structural neighbors were examined");
    let candidates = 0;
    const prepare = f.env.DB.prepare;
    f.env.DB.prepare = sql => { if (/AS family_of/.test(sql)) candidates++; return prepare(sql); };
    await assert.rejects(() => forgetFamilies(f.env, { families: [{
      base_doc_uid: "upload:export-0001", family_kind: "declared", keep_doc_uids: ["gmail:base"],
    }], dryRun: false }), /must belong/);
    assert.equal(candidates, 1, "invalid keep list reached membership validation");
    const applied = await forgetFamilies(f.env, { families, dryRun: false });
    assert.equal(applied.documents, preview.documents);
    results.push(JSON.stringify({ preview, applied,
      remaining: f.db.prepare("SELECT doc_uid FROM documents ORDER BY doc_uid").all() }));
    if (indexed) {
      const lookups = f.reads.filter(r => /AS family_of/.test(r.sql));
      assert.ok(lookups.length >= 3);
      for (const read of lookups) assert.doesNotMatch(f.plan(read), /SCAN documents|SCAN document_family_index/);
    }
    f.db.close();
  }
  assert.equal(results[1], results[0]);
});

test("backfill survives rollback, restart, overlapping calls and intervening writes", async () => {
  const f = fixture({ upgrade: true });
  for (let i = 0; i < 1100; i++) f.put(`drive:${String(i).padStart(4, "0")}`);
  f.db.exec(migration);
  const batch = f.env.DB.batch;
  let reached = 0;
  f.env.DB.batch = statements => {
    reached++;
    return batch([...statements, f.env.DB.prepare("INSERT INTO missing_fixture_table VALUES(1)")]);
  };
  await assert.rejects(() => backfillSourceFamilyIndex(f.env), /missing_fixture_table/);
  assert.equal(reached, 1, "failure was injected after a real nonempty page");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM document_family_index").get().n, 0);
  assert.equal(f.db.prepare("SELECT cursor FROM document_family_index_state").get().cursor, null);
  f.env.DB.batch = batch;
  assert.equal((await backfillSourceFamilyIndex(f.env)).advanced, 500);
  const state = JSON.stringify(f.db.prepare("SELECT * FROM document_family_index_state").get());
  f.db.exec(migration);
  assert.equal(JSON.stringify(f.db.prepare("SELECT * FROM document_family_index_state").get()), state);
  // New rows behind the cursor must be maintained by triggers, not lost.
  f.put("drive:0000-new", '{"family_of":"upload:new"}');
  f.db.exec("UPDATE documents SET meta='{\"family_of\":\"upload:moved\"}' WHERE doc_uid='drive:0001'");
  f.db.exec("UPDATE documents SET deleted_at=1 WHERE doc_uid='drive:0002'");
  f.db.exec("DELETE FROM documents WHERE doc_uid='drive:0501'");
  let mutated = false;
  f.env.DB.batch = statements => {
    if (!mutated) {
      mutated = true;
      f.db.exec("DELETE FROM documents WHERE doc_uid='drive:0502'");
      f.db.exec("UPDATE documents SET meta='{\"family_of\":\"upload:changed\"}' WHERE doc_uid='drive:0503'");
    }
    return batch(statements);
  };
  const overlap = await Promise.all([backfillSourceFamilyIndex(f.env), backfillSourceFamilyIndex(f.env)]);
  assert.ok(mutated);
  assert.equal(overlap.filter(r => r.contended).length, 1);
  f.env.DB.batch = batch;
  await finish(f);
  const count = f.db.prepare("SELECT count(*) AS n FROM documents").get().n;
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM document_family_index").get().n, count);
  f.db.exec("UPDATE documents SET doc_uid='drive:renamed',source='upload',meta='{\"part_of\":\"new\"}',deleted_at=NULL WHERE doc_uid='drive:0002'");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM document_family_index WHERE doc_uid='drive:0002'").get().n, 0);
  assert.equal(f.db.prepare("SELECT family_doc_uid FROM document_family_index WHERE doc_uid='drive:renamed'").get().family_doc_uid, "upload:new");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM document_family_index WHERE doc_uid IN ('drive:0501','drive:0502')").get().n, 0);
  f.db.exec("UPDATE document_family_index_state SET complete=0");
  const legacy = await pages(f, { includeLabels: true, limit: 97 });
  f.db.exec("UPDATE document_family_index_state SET complete=1");
  assert.deepEqual(await pages(f, { includeLabels: true, limit: 97 }), legacy);
  const batches = f.batches.length;
  assert.deepEqual(await backfillSourceFamilyIndex(f.env), { complete: true, advanced: 0 });
  assert.equal(f.batches.length, batches);
  f.db.close();
});

test("paused preparation and non-schema read failures preserve their boundaries", async () => {
  const f = fixture();
  f.put("drive:control");
  f.env.VECTOR_DRAIN_MODE = "paused-for-upgrade";
  const reads = f.reads.length;
  assert.deepEqual(await backfillSourceFamilyIndex(f.env), { paused: true, advanced: 0 });
  assert.equal(f.reads.length, reads);
  delete f.env.VECTOR_DRAIN_MODE;
  assert.equal((await backfillSourceFamilyIndex(f.env)).advanced, 1, "active control reaches preparation");
  let calls = 0;
  const prepare = f.env.DB.prepare;
  f.env.DB.prepare = sql => {
    if (/SELECT cursor, complete/.test(sql)) {
      calls++;
      throw new Error("D1 DB exceeded its CPU time limit and was reset");
    }
    return prepare(sql);
  };
  await assert.rejects(() => listSourceFamilies(f.env), /CPU time limit/);
  assert.equal(calls, 1, "capacity failure reaches the state read and cannot trigger fallback");
  f.db.close();
});

// Opt-in local workload only. The ordinary chain keeps this file short.
if (process.env.D1_FAMILY_SCALE === "1") test("250k-document migration and page workload", async () => {
  const f = fixture({ upgrade: true, path: process.env.D1_FAMILY_SCALE_DB });
  const insert = f.db.prepare(`INSERT INTO documents(doc_uid,source,source_id,title,ingested_at,content_hash,meta)
    VALUES(?,'drive',?,'Synthetic document',1,'fixture',?)`);
  f.db.exec("BEGIN");
  for (let i = 0; i < 250000; i++) {
    const id = String(i).padStart(6, "0");
    insert.run(`drive:${id}`, id, JSON.stringify({ part_of: String(Math.floor(i / 2) * 2).padStart(6, "0") }));
  }
  f.db.exec("COMMIT");
  const options = { source: "drive", cursor: "drive:200000", limit: 500 };
  const beforeStart = performance.now();
  const before = await listSourceFamilies(f.env, options);
  const beforeMs = performance.now() - beforeStart;
  const oldRead = f.reads.findLast(r => /SELECT family_doc_uid/.test(r.sql));
  const ddlStart = performance.now();
  f.db.exec(migration);
  const ddlMs = performance.now() - ddlStart;
  const fillStart = performance.now();
  const slices = [];
  let advanced = 0;
  for (;;) {
    const start = performance.now();
    const receipt = await backfillSourceFamilyIndex(f.env);
    slices.push(performance.now() - start);
    advanced += receipt.advanced;
    if (receipt.complete) break;
  }
  const fillMs = performance.now() - fillStart;
  assert.equal(advanced, 250000);
  const afterStart = performance.now();
  const after = await listSourceFamilies(f.env, options);
  const afterMs = performance.now() - afterStart;
  assert.equal(JSON.stringify(after), JSON.stringify(before));
  const newRead = f.reads.findLast(r => /SELECT family_doc_uid/.test(r.sql));
  const report = { documents: advanced, familiesOnPage: after.families.length,
    beforeMs, ddlMs, fillMs, slices: slices.length, maxSliceMs: Math.max(...slices), afterMs,
    beforePlan: f.plan(oldRead), afterPlan: f.plan(newRead), oldRead, newRead };
  writeFileSync(new URL("../.lane-d1inv/benchmark.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ...report, oldRead: undefined, newRead: undefined }));
  f.db.close();
});

test("empty, exact-batch and Unicode boundaries finish without losing membership", async () => {
  for (const size of [0, 500, 1000]) {
    const f = fixture({ upgrade: true });
    for (let i = 0; i < size; i++) f.put(`drive:${String(i).padStart(4, "0")}`);
    f.db.exec(migration);
    let advanced = 0;
    let calls = 0;
    for (;;) {
      const receipt = await backfillSourceFamilyIndex(f.env);
      advanced += receipt.advanced; calls++;
      if (receipt.complete) break;
      assert.ok(calls <= 3);
    }
    assert.equal(advanced, size);
    assert.equal(calls, size / 500 + 1);
    assert.deepEqual(await backfillSourceFamilyIndex(f.env), { complete: true, advanced: 0 });
    f.db.close();
  }
  const f = fixture({ upgrade: true });
  for (const suffix of ["\uE000", "😀", "é"]) f.put(`drive:${suffix}`);
  f.db.exec(migration);
  await finish(f);
  assert.equal(f.db.prepare("SELECT cursor FROM document_family_index_state").get().cursor, "drive:😀");
  // REPLACE deletes must remove the old projection even with recursive
  // triggers disabled, including a source/source_id uniqueness collision.
  f.db.exec("PRAGMA recursive_triggers=OFF");
  f.db.prepare(`INSERT OR REPLACE INTO documents(doc_uid,source,source_id,title,ingested_at,content_hash,meta)
    VALUES('drive:replacement','drive',?,'Synthetic',1,'fixture','{}')`).run("é");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM document_family_index WHERE doc_uid=?").get("drive:é").n, 0);
  assert.ok((await listSourceFamilies(f.env, { source: "drive" })).families.includes("drive:replacement"));
  f.db.close();
});

test("each interrupted migration prefix resumes with complete inventory", async () => {
  const statements = splitStatements(migration);
  assert.ok(statements.length >= 8);
  for (let cut = 0; cut <= statements.length; cut++) {
    const f = fixture({ upgrade: true });
    f.put("drive:before", '{"part_of":"base"}');
    for (const sql of statements.slice(0, cut)) f.db.exec(sql);
    f.put("message:during", '{"family_of":"upload:export"}');
    const expected = await pages(f, { includeLabels: true, limit: 1 });
    f.db.exec(migration);
    await finish(f);
    assert.deepEqual(await pages(f, { includeLabels: true, limit: 1 }), expected);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM document_family_index").get().n, 2);
    f.db.close();
  }
});

test("recovery rebuilds derived membership and old schema aggregates remain readable", async () => {
  const f = fixture({ upgrade: true });
  assert.ok(f.db.prepare(RECOVERY_AGGREGATE_SQL).get());
  for (const table of ["document_family_index", "document_family_index_state"]) {
    assert.ok(RECOVERY_DURABLE_TABLES.includes(table));
    assert.ok(!RECOVERY_EXPORT_TABLES.includes(table));
  }
  f.put("drive:restored", '{"part_of":"restored"}');
  f.db.exec(migration);
  await finish(f);
  const aggregate = f.db.prepare(RECOVERY_AGGREGATE_SQL).get();
  assert.equal(aggregate.document_family_index, "0");
  assert.equal(aggregate.document_family_index_state, "0");
  assert.deepEqual((await listSourceFamilies(f.env, { source: "drive" })).families, ["drive:restored"]);
  f.db.close();
});
