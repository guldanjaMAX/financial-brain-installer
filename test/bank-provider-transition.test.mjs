import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import * as bankProvider from "../operations/bank-provider-command.mjs";
import { forgetFamilies } from "../worker/src/lib/store-d1.js";

import {
  splitStatements,
} from "../brain.mjs";
import {
  BANK_PROVIDER_ESTABLISH_TRANSITION_SQL,
  BANK_PROVIDER_STATE_SQL,
  BankProviderCommandError,
  completeBankProviderDeployment,
  normalizeBankProviderState,
  prepareBankProviderDeployment,
} from "../operations/bank-provider-command.mjs";

const MIGRATIONS = new URL("../migrations/d1/", import.meta.url);
const TRANSITION_REF = "c".repeat(64);
const STARTED_AT = "2026-10-29T13:00:00.000Z";

function migratedDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const name of readdirSync(MIGRATIONS)
    .filter((candidate) => /^\d{4}_.+\.sql$/u.test(candidate)).sort()) {
    const source = readFileSync(new URL(name, MIGRATIONS), "utf8");
    for (const statement of splitStatements(source)) database.exec(statement);
  }
  return database;
}

function ledgerTables(database) {
  return database.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'fin_%' ORDER BY name",
  ).all().map(({ name }) => String(name)).filter((name) =>
    database.prepare(`PRAGMA table_info(${name})`).all().some(({ name: column }) => column === "source_feed"));
}

function observedState(overrides = {}) {
  return {
    bank_connections: 0,
    simplefin_connections: 0,
    non_simplefin_connections: 0,
    bank_ledger_rows: 0,
    simplefin_ledger_rows: 0,
    non_simplefin_ledger_rows: 0,
    deployed_provider: "plaid",
    transition_target: "simplefin",
    transition_ref: TRANSITION_REF,
    ...overrides,
  };
}

test("deploy requires the fence, rechecks zero, verifies runtime, and clears exactly once", async () => {
  let inspections = 0;
  await assert.rejects(() => prepareBankProviderDeployment({
    targetProvider: "simplefin",
    liveProvider: "plaid",
    async inspectBankState() {
      inspections += 1;
      return observedState({ bank_connections: 1, non_simplefin_connections: 1 });
    },
  }), (error) => error instanceof BankProviderCommandError && error.code === "BANK_PROVIDER_STATE_PRESENT");
  assert.equal(inspections, 1, "deploy reached the post-fence zero-state decision");

  await assert.rejects(() => prepareBankProviderDeployment({
    targetProvider: "simplefin",
    liveProvider: "plaid",
    async inspectBankState() {
      inspections += 1;
      return observedState({ transition_target: null, transition_ref: null });
    },
  }), (error) => error instanceof BankProviderCommandError && error.code === "BANK_PROVIDER_TRANSITION_REQUIRED");
  assert.equal(inspections, 2, "the unfenced runtime decision was reached");

  const transition = await prepareBankProviderDeployment({
    targetProvider: "simplefin",
    liveProvider: "plaid",
    async inspectBankState() {
      inspections += 1;
      return observedState();
    },
  });
  assert.equal(transition.transition_ref, TRANSITION_REF);
  assert.equal(inspections, 3);

  let clears = 0;
  await assert.rejects(() => completeBankProviderDeployment({
    targetProvider: "simplefin",
    liveProvider: "plaid",
    transition,
    async completeTransition() { clears += 1; },
  }), (error) => error instanceof BankProviderCommandError && error.code === "BANK_PROVIDER_RUNTIME_UNVERIFIED");
  assert.equal(clears, 0, "an unverified runtime cannot clear the fence");

  const completed = await completeBankProviderDeployment({
    targetProvider: "simplefin",
    liveProvider: "simplefin",
    transition,
    async completeTransition(reference) {
      clears += 1;
      assert.equal(reference, TRANSITION_REF);
      return { deployed_provider: "simplefin", transition_target: null, transition_ref: null };
    },
  });
  assert.deepEqual(completed, { deployed_provider: "simplefin" });
  assert.equal(clears, 1, "the verified SimpleFIN runtime cleared the fence exactly once");
});

test("the transition fence is atomic, covers every provider-write sibling, and has a green control", () => {
  const database = migratedDatabase();
  try {
    const before = database.prepare(
      "SELECT deployed_provider,transition_target,transition_ref FROM bank_provider_runtime_state WHERE id=1",
    ).get();
    assert.equal(before.transition_target, null);
    assert.throws(() => database.prepare(
      `UPDATE bank_provider_runtime_state
          SET transition_target='simplefin',transition_ref=?1,transition_started_at=?2
        WHERE id=1`,
    ).run("g".repeat(64), STARTED_AT), /CHECK constraint failed/iu,
    "every transition-reference character is constrained to lowercase hex");
    const reached = database.prepare(BANK_PROVIDER_ESTABLISH_TRANSITION_SQL).get(TRANSITION_REF, STARTED_AT);
    assert.equal(reached.transition_ref, TRANSITION_REF, "the zero-state transition decision was reached");

    assert.throws(() => database.prepare(
      `INSERT INTO bank_feed_items
       (tenant_id,item_ref,access_ciphertext,access_iv,environment,status,connected_at)
       VALUES ('primary','plaid-fixture',?1,?2,'production','connected',?3)`,
    ).run("A".repeat(16), "B".repeat(12), STARTED_AT), /bank provider transition fenced/iu);

    const expectedTables = ledgerTables(database);
    const triggerTables = database.prepare(
      `SELECT tbl_name FROM sqlite_master
        WHERE type='trigger' AND name LIKE 'bank_provider_fence_fin_%_insert'
        ORDER BY tbl_name`,
    ).all().map(({ tbl_name: name }) => String(name));
    assert.deepEqual(triggerTables, expectedTables, "every provider-derived ledger family is fenced by one rule");
    const updateTriggerTables = database.prepare(
      `SELECT tbl_name FROM sqlite_master
        WHERE type='trigger' AND name LIKE 'bank_provider_fence_fin_%_update'
        ORDER BY tbl_name`,
    ).all().map(({ tbl_name: name }) => String(name));
    assert.deepEqual(updateTriggerTables, expectedTables,
      "every provider-derived ledger family fences updates as well as inserts");
    assert.ok(expectedTables.length > 0, "the migration-derived ledger family inventory is nonempty");

    database.prepare(
      `UPDATE bank_provider_runtime_state
          SET deployed_provider='simplefin',transition_target=NULL,transition_ref=NULL,transition_started_at=NULL
        WHERE id=1`,
    ).run();
    const green = database.prepare(
      `INSERT INTO bank_feed_items
       (tenant_id,item_ref,institution_ref,institution_label,access_ciphertext,access_iv,
        environment,status,connected_at)
       VALUES ('primary','simplefin-fixture','simplefin','SimpleFIN Bridge',?1,?2,
               'production','connected',?3)`,
    ).run("C".repeat(16), "D".repeat(12), STARTED_AT);
    assert.equal(green.changes, 1, "the cleared-fence SimpleFIN control remains writable");

    database.prepare(
      `INSERT INTO simplefin_connections
       (tenant_id,item_ref,backfill_start,backfill_next,backfill_end,next_pull_at,updated_at)
       VALUES ('primary','simplefin-fixture','2026-01-01','2026-01-01','2026-01-02',?1,?1)`,
    ).run(STARTED_AT);
    database.prepare(
      `INSERT INTO bank_feed_items
       (tenant_id,item_ref,access_ciphertext,access_iv,environment,status,connected_at)
       VALUES ('primary','plaid-fixture',?1,?2,'production','connected',?3)`,
    ).run("E".repeat(16), "F".repeat(12), STARTED_AT);
    for (const [slug, sourceFeed] of [
      ["simplefin-entity", "bank-feed:simplefin-fixture"],
      ["plaid-entity", "bank-feed:plaid-fixture"],
    ]) {
      database.prepare(
        `INSERT INTO fin_entities
         (tenant_id,entity_slug,legal_name,kind,provenance,source_feed,basis_state,recorded_at)
         VALUES ('primary',?1,?1,'business','feed',?2,'confirmed',?3)`,
      ).run(slug, sourceFeed, STARTED_AT);
    }
    database.prepare(
      `UPDATE bank_provider_runtime_state
          SET deployed_provider='plaid',transition_target='simplefin',transition_ref=?1,
              transition_started_at=?2
        WHERE id=1`,
    ).run(TRANSITION_REF, STARTED_AT);
    assert.throws(() => database.prepare(
      "UPDATE fin_entities SET legal_name='Changed' WHERE entity_slug='plaid-entity'",
    ).run(), /bank provider transition fenced/iu,
    "an existing bank-derived row cannot be changed through a non-source column while fenced");
    database.prepare(
      `UPDATE bank_provider_runtime_state
          SET deployed_provider='simplefin',transition_target=NULL,transition_ref=NULL,
              transition_started_at=NULL
        WHERE id=1`,
    ).run();
    assert.deepEqual(normalizeBankProviderState({
      results: [database.prepare(BANK_PROVIDER_STATE_SQL).get()],
    }), {
      bank_connections: 2,
      simplefin_connections: 1,
      non_simplefin_connections: 1,
      bank_ledger_rows: 2,
      simplefin_ledger_rows: 1,
      non_simplefin_ledger_rows: 1,
      deployed_provider: "simplefin",
      transition_target: null,
      transition_ref: null,
    }, "provider provenance is observed from D1 custody, not the local manifest");
  } finally {
    database.close();
  }
});

const TABLES = [
  "fin_entities", "fin_accounts", "fin_account_coverage", "fin_documents",
  "fin_statements", "fin_transactions", "fin_balance_snapshots", "fin_obligations",
  "fin_deadlines", "fin_exceptions", "fin_open_items", "fin_reconciliation_claims",
];
const REFERENCE = "c".repeat(64);
const AT = "2026-10-29T13:00:00.000Z";

// The pinned pre-fix statements are retained only here as an independent oracle.
const OLD_LEDGER_CTE = `WITH bank_ledger AS (
  ${TABLES.map((table) =>
    `SELECT source_feed FROM ${table} WHERE source_feed LIKE 'bank-feed:%'`).join("\n  UNION ALL\n  ")}
)`;

const OLD_STATE_SQL = `${OLD_LEDGER_CTE}
SELECT
  (SELECT COUNT(*) FROM bank_feed_items WHERE removed_at IS NULL) AS bank_connections,
  (SELECT COUNT(*) FROM bank_feed_items i
    WHERE i.removed_at IS NULL AND EXISTS (
      SELECT 1 FROM simplefin_connections s
       WHERE s.tenant_id=i.tenant_id AND s.item_ref=i.item_ref
    )) AS simplefin_connections,
  (SELECT COUNT(*) FROM bank_feed_items i
    WHERE i.removed_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM simplefin_connections s
       WHERE s.tenant_id=i.tenant_id AND s.item_ref=i.item_ref
    )) AS non_simplefin_connections,
  (SELECT COUNT(*) FROM bank_ledger) AS bank_ledger_rows,
  (SELECT COUNT(*) FROM bank_ledger l WHERE EXISTS (
    SELECT 1 FROM simplefin_connections s
     WHERE l.source_feed='bank-feed:'||s.item_ref
  )) AS simplefin_ledger_rows,
  (SELECT COUNT(*) FROM bank_ledger l WHERE NOT EXISTS (
    SELECT 1 FROM simplefin_connections s
     WHERE l.source_feed='bank-feed:'||s.item_ref
  )) AS non_simplefin_ledger_rows,
  (SELECT deployed_provider FROM bank_provider_runtime_state WHERE id=1) AS deployed_provider,
  (SELECT transition_target FROM bank_provider_runtime_state WHERE id=1) AS transition_target,
  (SELECT transition_ref FROM bank_provider_runtime_state WHERE id=1) AS transition_ref`;

const OLD_ESTABLISH_SQL = `${OLD_LEDGER_CTE}
UPDATE bank_provider_runtime_state
   SET transition_target='simplefin',transition_ref=?1,transition_started_at=?2,updated_at=?2
 WHERE id=1 AND deployed_provider<>'simplefin' AND transition_target IS NULL
   AND NOT EXISTS (SELECT 1 FROM bank_feed_items WHERE removed_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM bank_ledger)
RETURNING deployed_provider,transition_target,transition_ref`;

const OLD_COMPLETE_SQL = `${OLD_LEDGER_CTE}
UPDATE bank_provider_runtime_state
   SET deployed_provider='simplefin',transition_target=NULL,transition_ref=NULL,
       transition_started_at=NULL,updated_at=?2
 WHERE id=1 AND transition_target='simplefin' AND transition_ref=?1
   AND NOT EXISTS (SELECT 1 FROM bank_feed_items WHERE removed_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM bank_ledger)
RETURNING deployed_provider,transition_target,transition_ref`;

// Each parenthesis starts a separate SQL scope. Ignore comments and quoted
// values so a data string cannot hide an operator or invent another term.
function compoundTerms(sql) {
  const tokens = sql.match(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[();]|\b(?:UNION|INTERSECT|EXCEPT)\b/giu) || [];
  const scopes = [1];
  let maximum = 1;
  for (const token of tokens) {
    if (token === "(") scopes.push(1);
    else if (token === ")") scopes.pop();
    else if (token === ";") scopes[scopes.length - 1] = 1;
    else if (/^(?:UNION|INTERSECT|EXCEPT)$/iu.test(token)) {
      maximum = Math.max(maximum, ++scopes[scopes.length - 1]);
    }
  }
  return maximum;
}

function assertD1CompoundLimit(sql) {
  assert.ok(compoundTerms(sql) <= 5, "D1 permits at most five compound SELECT terms");
}

function database() {
  const db = new DatabaseSync(":memory:");
  for (const table of TABLES) {
    db.exec(`CREATE TABLE ${table} (source_feed TEXT, removed_at TEXT, superseded_by_id INTEGER)`);
  }
  db.exec(`CREATE TABLE bank_feed_items (tenant_id TEXT, item_ref TEXT, removed_at TEXT);
    CREATE TABLE simplefin_connections (tenant_id TEXT, item_ref TEXT);
    CREATE TABLE bank_provider_runtime_state (
      id INTEGER PRIMARY KEY, deployed_provider TEXT, transition_target TEXT,
      transition_ref TEXT, transition_started_at TEXT, updated_at TEXT
    );
    INSERT INTO bank_provider_runtime_state VALUES (1,'plaid',NULL,NULL,NULL,NULL)`);
  return db;
}

function insertLedger(db, table, feed, removed = null, superseded = null) {
  db.prepare(`INSERT INTO ${table} VALUES (?,?,?)`).run(feed, removed, superseded);
}

function custody(db) {
  db.exec(`INSERT INTO simplefin_connections VALUES
    ('primary','simplefin-fixture'),('secondary','simplefin-fixture')`);
}

const fixtures = [
  { label: "empty", seed() {}, counts: [0, 0, 0, 0, 0, 0] },
  { label: "mixed provider history in every ledger table", seed(db) {
    custody(db);
    db.exec(`INSERT INTO bank_feed_items VALUES
      ('primary','simplefin-fixture',NULL),('primary','other-fixture',NULL),
      ('secondary','other-fixture','removed'),('third','simplefin-fixture',NULL)`);
    for (const table of TABLES) {
      insertLedger(db, table, "bank-feed:simplefin-fixture");
      insertLedger(db, table, "bank-feed:other-fixture");
      insertLedger(db, table, "manual:fixture");
      insertLedger(db, table, null);
    }
  }, counts: [3, 1, 2, 24, 12, 12] },
  { label: "non-bank rows", seed(db) {
    for (const table of TABLES) insertLedger(db, table, "manual:fixture");
  }, counts: [0, 0, 0, 0, 0, 0] },
  { label: "removed items with no ledger history", seed(db) {
    custody(db);
    db.exec(`INSERT INTO bank_feed_items VALUES
      ('primary','simplefin-fixture','removed'),('primary','other-fixture','removed')`);
  }, counts: [0, 0, 0, 0, 0, 0] },
  { label: "removed and superseded ledger history still blocks", seed(db) {
    custody(db);
    db.exec(`INSERT INTO bank_feed_items VALUES ('primary','simplefin-fixture','removed')`);
    insertLedger(db, TABLES[0], "bank-feed:simplefin-fixture", "removed", 7);
    insertLedger(db, TABLES[6], "bank-feed:other-fixture", "removed", 8);
  }, counts: [0, 0, 0, 2, 1, 1] },
  { label: "LIKE casing and exact custody matching", seed(db) {
    custody(db);
    insertLedger(db, TABLES[11], "BANK-FEED:simplefin-fixture");
    insertLedger(db, TABLES[11], "bank-feed:simplefin-fixture");
    insertLedger(db, TABLES[3], "bank-feed:");
  }, counts: [0, 0, 0, 3, 1, 2] },
];

for (const fixture of fixtures) {
  test(`state SQL matches the old oracle: ${fixture.label}`, () => {
    const db = database();
    try {
      fixture.seed(db);
      const old = db.prepare(OLD_STATE_SQL).get();
      const current = db.prepare(bankProvider.BANK_PROVIDER_STATE_SQL).get();
      assert.deepEqual(current, old);
      assert.deepEqual(Object.values(current).slice(0, 6), fixture.counts,
        "the observed aggregates prove the fixture decision was reached");
    } finally { db.close(); }
  });
}

for (const [kind, oldSql, currentSql] of [
  ["establish", OLD_ESTABLISH_SQL, bankProvider.BANK_PROVIDER_ESTABLISH_TRANSITION_SQL],
  ["complete", OLD_COMPLETE_SQL, bankProvider.BANK_PROVIDER_COMPLETE_TRANSITION_SQL],
]) {
  for (const fixture of fixtures) {
    test(`${kind} SQL has identical rows and durable effects: ${fixture.label}`, () => {
      const snapshots = [];
      for (const sql of [oldSql, currentSql]) {
        const db = database();
        try {
          fixture.seed(db);
          if (kind === "complete") {
            db.prepare(`UPDATE bank_provider_runtime_state
              SET transition_target='simplefin',transition_ref=?1,transition_started_at=?2`)
              .run(REFERENCE, AT);
          }
          const before = db.prepare("SELECT * FROM bank_provider_runtime_state").all();
          const rows = db.prepare(sql).all(REFERENCE, AT);
          const changes = db.prepare("SELECT changes() AS count").get().count;
          const after = db.prepare("SELECT * FROM bank_provider_runtime_state").all();
          const blocked = fixture.counts[0] > 0 || fixture.counts[3] > 0;
          assert.equal(before.length, 1, "the runtime row exists at the guarded update decision");
          assert.equal(rows.length, blocked ? 0 : 1);
          assert.equal(changes, blocked ? 0 : 1);
          if (blocked) assert.deepEqual(after, before);
          else {
            assert.equal(after[0].updated_at, AT, "the empty-state green control updated the row");
            assert.equal(after[0].transition_target, kind === "complete" ? null : "simplefin");
          }
          snapshots.push({ rows, changes, after });
        } finally { db.close(); }
      }
      assert.deepEqual(snapshots[0], snapshots[1]);
    });
  }
  for (const table of TABLES) {
    test(`${kind} refuses a bank row in ${table} with an empty-state green control`, () => {
      const db = database();
      try {
        if (kind === "complete") {
          db.prepare(`UPDATE bank_provider_runtime_state
            SET transition_target='simplefin',transition_ref=?1`).run(REFERENCE);
        }
        insertLedger(db, table, "bank-feed:fixture");
        assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 1);
        assert.deepEqual(db.prepare(currentSql).all(REFERENCE, AT), []);
        db.exec(`DELETE FROM ${table}`);
        assert.equal(db.prepare(currentSql).all(REFERENCE, AT).length, 1);
      } finally { db.close(); }
    });
  }
}

test("the D1 term guard rejects all three old statements and accepts the five-term boundary", () => {
  for (const old of [OLD_STATE_SQL, OLD_ESTABLISH_SQL, OLD_COMPLETE_SQL]) {
    assert.equal(compoundTerms(old), 12, "the guard reached the old ledger CTE");
    assert.throws(() => assertD1CompoundLimit(old), /at most five/u);
  }
  for (const operator of ["UNION ALL", "UNION", "INTERSECT", "EXCEPT"]) {
    const five = Array.from({ length: 5 }, () => "SELECT 1").join(` ${operator} `);
    assert.equal(compoundTerms(five), 5);
    assertD1CompoundLimit(five);
    assert.throws(() => assertD1CompoundLimit(`${five} ${operator} SELECT 1`), /at most five/u);
  }
  assert.equal(compoundTerms("SELECT 'UNION', (SELECT 1 UNION SELECT 2), (SELECT 3 UNION SELECT 4); -- UNION\nSELECT 1"), 2);
});

test("every exported bank-provider SQL statement fits the D1 limits without compound operators", (t) => {
  const statements = Object.entries(bankProvider).filter(([name, sql]) =>
    name.endsWith("_SQL") && typeof sql === "string");
  assert.equal(statements.length, 3, "the exported SQL inventory was reached");
  for (const [name, sql] of statements) {
    assertD1CompoundLimit(sql);
    assert.equal(compoundTerms(sql), 1);
    assert.doesNotMatch(sql, /\b(?:UNION|INTERSECT|EXCEPT)\b/iu);
    const bytes = Buffer.byteLength(sql);
    const parameters = Math.max(0, ...[...sql.matchAll(/\?(\d+)/gu)].map((match) => Number(match[1])));
    assert.ok(bytes < 100_000);
    assert.ok(parameters < 100);
    t.diagnostic(`${name}: ${bytes} bytes, ${parameters} parameters`);
  }
});

function packageSources() {
  const root = new URL("../", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  const sources = [];
  function visit(path) {
    const url = new URL(path, root);
    if (path.endsWith("/")) {
      for (const entry of readdirSync(url, { withFileTypes: true })) {
        visit(`${path}${entry.name}${entry.isDirectory() ? "/" : ""}`);
      }
    } else if (/\.(?:m?js|sql)$/u.test(path)) {
      sources.push([path, readFileSync(url, "utf8")]);
    }
  }
  for (const path of manifest.files) visit(path);
  return sources;
}

test("package source compound-operator joins have a bounded execution probe", async () => {
  const builders = packageSources().filter(([, source]) =>
    /\.join\(\s*["'`][^"'`]*\b(?:UNION|INTERSECT|EXCEPT)\b/iu.test(source)).map(([path]) => path);
  assert.deepEqual(builders, ["worker/src/lib/store-d1.js"],
    "a new compound join requires a real-path maximum-size probe");
  const queries = [];
  const env = { DB: { prepare(sql) {
    queries.push(sql);
    assertD1CompoundLimit(sql);
    return { bind() { return this; }, async all() { return { results: [] }; } };
  } } };
  const receipt = await forgetFamilies(env, { families: Array.from({ length: 25 }, (_, index) => ({
    base_doc_uid: `fixture:item-${index}`, family_kind: "hybrid",
  })) });
  assert.equal(queries.length, 1, "the full group reached the compound SQL builder");
  assert.equal(compoundTerms(queries[0]), 2, "both structural and declared arms were built");
  assert.equal(receipt.dry_run, true);
});
