import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { splitStatements } from "../../brain.mjs";
import { sourceInventoryScanPage, sourceFreshnessPage } from "../src/lib/source-inventory-scan.js";
import { handleSourceInventoryApi } from "../src/lib/source-inventory-api.js";
import { collectSourceInventoryPages } from "../../brain.mjs";
import { TEST_COMMANDS, POST_LAUNCHER_TEST_COMMANDS, parseTestCommand } from "../../scripts/run-test-chain.mjs";

test("large inventory regression participates in the default ordered test chain", () => {
  const command = "node --test worker/test/source-inventory-large.test.mjs";
  assert.equal(TEST_COMMANDS.filter(value => value === command).length, 1);
  assert.equal(POST_LAUNCHER_TEST_COMMANDS.filter(value => value === command).length, 1);
  assert.deepEqual(parseTestCommand(command).args, ["--test", "worker/test/source-inventory-large.test.mjs"]);
});

function database() {
  const db = new DatabaseSync(":memory:");
  const directory = new URL("../../migrations/d1/", import.meta.url);
  for (const file of readdirSync(directory).filter(file => file.endsWith(".sql")).sort()) {
    for (const sql of splitStatements(readFileSync(new URL(file, directory), "utf8"))) db.exec(sql);
  }
  db.exec(`INSERT INTO install_state (id,client_slug,product_version,installed_at)
    VALUES (1,'fixture','0.0.0-test','2026-01-01')`);
  return db;
}

function binding(db, inspect = () => {}) {
  return { DB: { prepare(sql) {
    const statement = (binds = []) => ({
      bind: (...values) => statement(values),
      first: async () => { inspect(sql, binds); return db.prepare(sql).get(...binds) ?? null; },
      all: async () => { inspect(sql, binds); return { results: db.prepare(sql).all(...binds) }; },
      run: async () => assert.fail("inventory attempted a write"),
    });
    return statement();
  }, batch: async () => assert.fail("inventory attempted a batch write") },
  STORAGE: "d1", ADMIN_KEY: ["fixture", "inventory", "proof"].join("-"),
  SESSION_SIGNING_KEY: ["fixture", "session", "proof"].join("-") };
}

test("wide metadata shrinks the actual D1 work page before JSON aggregation", async () => {
  const db = database();
  try {
    db.exec(`INSERT INTO sources (name,kind,status,created_at)
      VALUES ('archive','drive','ready','2026-01-01')`);
    const insert = db.prepare(`INSERT INTO documents
      (doc_uid,source,source_id,title,ingested_at,content_hash,meta) VALUES (?,'archive',?,'Synthetic',1,'fixture',?)`);
    const wide = JSON.stringify({ padding: "x".repeat(32 * 1024) });
    for (let i = 0; i < 300; i++) insert.run(`archive:${i}`, String(i), wide);
    let reads = 0;
    const env = binding(db, (sql, binds) => {
      if (!sql.includes("source_events_rollup AS")) return;
      reads++;
      // Deterministic D1 resource boundary, applied to the real SQL range.
      const bytes = db.prepare(`SELECT COALESCE(SUM(length(CAST(meta AS BLOB))),0) AS n
        FROM (SELECT meta FROM documents WHERE rowid>? ORDER BY rowid LIMIT ?)`)
        .get(binds[1], binds[2]).n;
      if (bytes > 8 * 1024 * 1024) throw new Error("D1_ERROR: D1 DB exceeded its CPU time limit and was reset");
    });
    const control = await sourceInventoryScanPage(env, { limit: 100, now: 1790812800000 });
    assert.equal(control.scan.scanned, 100, "green control reached the same real reader");
    const page = await sourceInventoryScanPage(env, { limit: 300, now: 1790812800000 });
    assert.equal(page.scan.scanned, 150);
    assert.equal(page.rows[0].storage.physical_documents, 150);
    assert.equal(reads, 2, "both successful ranges reached D1 JSON aggregation");
    const fresh = await sourceFreshnessPage(env, { now: 1790812800000 });
    assert.equal(fresh.scan.scanned, 0, "daily receipt reads do no document JSON work");
  } finally { db.close(); }
});

test("600001 stored items finish across real Worker pages despite a busy continuation", async () => {
  const db = database();
  try {
    db.exec(`INSERT INTO sources (name,kind,status,created_at)
      VALUES ('archive','drive','ready','2026-01-01'),('unreadable','gmail','error','2026-01-01');
      WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<600001)
      INSERT INTO documents (doc_uid,source,source_id,title,ingested_at,content_hash,meta)
        SELECT 'archive:'||i,'archive',CAST(i AS TEXT),'Synthetic',1,'fixture','{}' FROM n`);
    let aggregates = 0;
    const env = binding(db, sql => { if (sql.includes("source_events_rollup AS")) aggregates++; });
    const bodies = [], waits = [];
    let busy = false;
    const result = await collectSourceInventoryPages(async body => {
      bodies.push(body);
      if (body.cursor && !busy) {
        busy = true;
        return Response.json({ code: "source_inventory_unavailable" }, { status: 503 });
      }
      return handleSourceInventoryApi(env, new Request("https://brain.invalid/api/admin/brain/sources", {
        method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Key": env.ADMIN_KEY },
        body: JSON.stringify(body),
      }));
    }, { bounded: true, now: () => 0, sleep: async ms => waits.push(ms) });
    assert.equal(result.complete, true);
    const archive = result.sources.find(row => row.name === "archive");
    assert.equal(archive.storage.physical_documents, 600001);
    assert.equal(archive.storage.logical_documents, 600001);
    assert.equal(archive.readability.unreadable_documents, 600001, "empty records remain explicit gaps");
    assert.equal(result.sources.find(row => row.name === "unreadable").freshness.state, "broken",
      "a genuine source failure survives a complete inventory");
    assert.equal(aggregates, 121, "all 121 real aggregation decisions reached");
    assert.equal(bodies.length, 122, "only the failed continuation is retried");
    assert.deepEqual(bodies[1], bodies[2]);
    assert.deepEqual(waits, [1000]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM documents").get().n, 600001,
      "readback preserves every stored item");
  } finally { db.close(); }
});
