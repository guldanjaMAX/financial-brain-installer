import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

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
