import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { customApiD1Persistence } from "../worker/src/lib/custom-api.js";

const sql = readFileSync(new URL("../migrations/d1/0047_custom_api_source.sql", import.meta.url), "utf8");

function d1(database) {
  const prepare = (statement) => {
    let parameters = [];
    return {
      statement,
      get parameters() { return parameters; },
      bind(...values) { parameters = values; return this; },
      async first() { return database.prepare(statement).get(...parameters) ?? null; },
      async all() { return { results: database.prepare(statement).all(...parameters) }; },
      async run() { return database.prepare(statement).run(...parameters); },
    };
  };
  return {
    prepare,
    async batch(statements) {
      return statements.map((entry) => /^\s*SELECT\b/i.test(entry.statement)
        ? { results: database.prepare(entry.statement).all(...entry.parameters) }
        : database.prepare(entry.statement).run(...entry.parameters));
    },
  };
}

test("0047 stores exact current rows, append-only correction hashes, fetch receipts, and the cron lease", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(sql);
  const hashA = "a".repeat(64);
  const hashB = "b".repeat(64);
  db.prepare(
    `INSERT INTO custom_api_rows
       (source,endpoint,row_key,row_hash,row_json,revision,first_seen_at,updated_at)
     VALUES (?,?,?,?,?,1,?,?)`
  ).run("store-dashboard", "sales", "store=one|period=2026-08-01", hashA,
    JSON.stringify({ store: "Store A", period: "2026-08-01", net_sales: 10 }),
    "2026-09-24T15:30:00.000Z", "2026-09-24T15:30:00.000Z");
  db.prepare(
    `UPDATE custom_api_rows SET row_hash=?,row_json=?,revision=2,updated_at=?
      WHERE source=? AND endpoint=? AND row_key=?`
  ).run(hashB, JSON.stringify({ store: "Store A", period: "2026-08-01", net_sales: 12 }),
    "2026-09-25T15:30:00.000Z", "store-dashboard", "sales", "store=one|period=2026-08-01");
  db.prepare(
    `INSERT INTO custom_api_row_revisions
       (source,endpoint,row_key,revision,prior_hash,new_hash,revised_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run("store-dashboard", "sales", "store=one|period=2026-08-01", 2, hashA, hashB, "2026-09-25T15:30:00.000Z");
  db.prepare(
    `INSERT INTO custom_api_fetches
       (run_id,source,endpoint,fetched_at,response_hash,rows_seen,rows_created,rows_updated,rows_unchanged)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run("run-one", "store-dashboard", "sales", "2026-09-25T15:30:00.000Z", hashB, 1, 0, 1, 0);
  db.prepare(
    "INSERT INTO custom_api_schedule_state (source,last_success_at,lease_token,lease_expires_at) VALUES (?,?,?,?)"
  ).run("store-dashboard", "2026-09-25T15:30:00.000Z", "lease-one", 1_800_000_000_000);

  assert.deepEqual({ ...db.prepare("SELECT revision,row_hash,json_extract(row_json,'$.net_sales') AS net_sales FROM custom_api_rows").get() }, {
    revision: 2, row_hash: hashB, net_sales: 12,
  });
  assert.deepEqual({ ...db.prepare("SELECT prior_hash,new_hash FROM custom_api_row_revisions").get() }, {
    prior_hash: hashA, new_hash: hashB,
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM custom_api_fetches").get().n, 1);
  assert.equal(db.prepare("SELECT lease_token FROM custom_api_schedule_state").get().lease_token, "lease-one");
  assert.throws(() => db.prepare(
    "INSERT INTO custom_api_rows (source,endpoint,row_key,row_hash,row_json,revision,first_seen_at,updated_at) VALUES (?,?,?,?,?,1,?,?)"
  ).run("store-dashboard", "sales", "bad", "not-a-hash", "{}", "x", "x"));
});

test("the D1 writer reads back created and corrected rows plus each fetch receipt", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec("PRAGMA foreign_keys=ON");
  database.exec(sql);
  const persistence = customApiD1Persistence({ STORAGE: "d1", DB: d1(database) });
  const hashA = "a".repeat(64);
  const hashB = "b".repeat(64);
  const base = {
    source: "store-dashboard",
    endpoint: "sales",
    documentChanges: [],
    fetchedAt: "2026-09-24T15:30:00.000Z",
  };
  await persistence.persist({
    ...base,
    responseHash: hashA,
    rowChanges: [{
      action: "created", row_key: "store=one|period=2026-08-01", row_hash: hashA,
      row: { store: "Store A", period: "2026-08-01", net_sales: 10 }, prior_revision: 0,
    }],
  });
  await persistence.persist({
    ...base,
    fetchedAt: "2026-09-25T15:30:00.000Z",
    responseHash: hashB,
    rowChanges: [{
      action: "updated", row_key: "store=one|period=2026-08-01", row_hash: hashB,
      row: { store: "Store A", period: "2026-08-01", net_sales: 12 },
      prior_hash: hashA, prior_revision: 1,
    }],
  });

  assert.deepEqual({ ...database.prepare("SELECT revision,row_hash FROM custom_api_rows").get() }, {
    revision: 2, row_hash: hashB,
  });
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM custom_api_row_revisions").get().n, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM custom_api_fetches").get().n, 2);
  assert.equal(await persistence.loadResponseHash({ source: "store-dashboard", endpoint: "sales" }), hashB);
});
