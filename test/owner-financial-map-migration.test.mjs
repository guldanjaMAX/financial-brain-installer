import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { splitStatements } from "../brain.mjs";

const MIGRATIONS = fileURLToPath(new URL("../migrations/d1/", import.meta.url));

function apply(db, file) {
  const source = readFileSync(join(MIGRATIONS, file), "utf8");
  for (const statement of splitStatements(source)) db.exec(statement);
}

test("0041 adds an empty map foundation to a populated schema 40 without backfill", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const files = readdirSync(MIGRATIONS).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
    for (const file of files.filter((name) => Number(name.slice(0, 4)) <= 40)) apply(db, file);
    db.prepare(
      `INSERT INTO install_state
         (id,client_slug,product_version,schema_version,gate_version,installed_at,ring)
       VALUES (1,'fixture','0.4.6',40,0,'2026-09-10T00:00:00Z','test')`,
    ).run();
    db.prepare(
      `INSERT INTO fin_entities
         (tenant_id,entity_slug,legal_name,display_label,kind,status,relationship,
          provenance,basis_state,recorded_at)
       VALUES ('primary','fixture-business','Fixture Business LLC','Fixture Business',
               'business','active','owned','owner_stated','confirmed','2026-09-10T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO fin_accounts
         (tenant_id,account_slug,entity_slug,label,account_kind,balance_role,currency,status,
          provenance,basis_state,recorded_at)
       VALUES ('primary','fixture-checking','fixture-business','Fixture Checking','checking',
               'asset','USD','open','owner_stated','confirmed','2026-09-10T00:00:00Z')`,
    ).run();
    const before = JSON.stringify({
      entity: { ...db.prepare("SELECT * FROM fin_entities").get() },
      account: { ...db.prepare("SELECT * FROM fin_accounts").get() },
    });

    const migration = files.find((name) => name.startsWith("0041_"));
    assert.ok(migration);
    apply(db, migration);

    const after = JSON.stringify({
      entity: { ...db.prepare("SELECT * FROM fin_entities").get() },
      account: { ...db.prepare("SELECT * FROM fin_accounts").get() },
    });
    assert.equal(after, before, "0041 does not rewrite the structured financial inventory");
    assert.equal(db.prepare("SELECT count(*) AS n FROM owner_financial_map_previews").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM owner_financial_map_snapshots").get().n, 0,
      "existing rows are not treated as owner-confirmed map history");
    assert.equal(db.prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name='ux_owner_financial_map_one_pending_preview'",
    ).get().n, 1, "the database enforces one pending preview per tenant");
    assert.deepEqual({ ...db.prepare(
      "SELECT tenant_id,generation FROM owner_financial_map_inventory_state",
    ).get() }, { tenant_id: "primary", generation: 0 });
    assert.match(db.prepare(
      "SELECT signing_salt FROM owner_financial_map_key_state WHERE tenant_id='primary'",
    ).get().signing_salt, /^[a-f0-9]{64}$/, "migration creates one durable local map-signing salt");

    db.prepare("UPDATE fin_accounts SET status='closed' WHERE account_slug='fixture-checking'").run();
    assert.equal(db.prepare(
      "SELECT generation FROM owner_financial_map_inventory_state WHERE tenant_id='primary'",
    ).get().generation, 1);
    db.prepare(
      `INSERT INTO fin_accounts
         (tenant_id,account_slug,entity_slug,label,account_kind,balance_role,currency,status,
          provenance,basis_state,recorded_at)
       VALUES ('primary','fixture-savings','fixture-business','Fixture Savings','savings',
               'asset','USD','open','owner_stated','confirmed','2026-09-10T00:00:00Z')`,
    ).run();
    assert.equal(db.prepare(
      "SELECT generation FROM owner_financial_map_inventory_state WHERE tenant_id='primary'",
    ).get().generation, 2);
    db.prepare("DELETE FROM fin_accounts WHERE account_slug='fixture-savings'").run();
    assert.equal(db.prepare(
      "SELECT generation FROM owner_financial_map_inventory_state WHERE tenant_id='primary'",
    ).get().generation, 3);

    const insertPreview = db.prepare(
      `INSERT INTO owner_financial_map_previews
         (receipt_hash,tenant_id,contract_version,snapshot_json,map_hash,denominator_hash,
          inventory_hash,inventory_generation,expected_head_snapshot_id,expected_head_map_hash,
          expected_sequence_no,population_state,tax_year_start,tax_year_end,entity_count,
          account_count,entity_year_count,filing_unit_count,obligation_count,preview_seal,
          expires_at,state,created_at)
       VALUES (?,?,1,'{}',?,?,?,?,NULL,NULL,1,'unknown',2025,2025,0,0,0,0,0,?,
               1800000000000,'previewed',1700000000000)`,
    );
    insertPreview.run("1".repeat(64), "primary", "2".repeat(64), "3".repeat(64),
      "4".repeat(64), 3, "5".repeat(64));
    assert.throws(
      () => insertPreview.run("6".repeat(64), "primary", "7".repeat(64), "8".repeat(64),
        "9".repeat(64), 3, "a".repeat(64)),
      /UNIQUE constraint failed/,
      "a second pending preview cannot be inserted for the same tenant",
    );
    db.prepare("UPDATE owner_financial_map_previews SET state='invalidated' WHERE receipt_hash=?")
      .run("1".repeat(64));
    insertPreview.run("6".repeat(64), "primary", "7".repeat(64), "8".repeat(64),
      "9".repeat(64), 3, "a".repeat(64));
  } finally {
    db.close();
  }
});

test("0041 leaves a fresh recovery schema ready for the source key while inventory generation is derived", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const files = readdirSync(MIGRATIONS).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
    for (const file of files) apply(db, file);
    assert.equal(db.prepare("SELECT count(*) AS n FROM owner_financial_map_key_state").get().n, 0,
      "schema-first recovery does not create a conflicting signing key");
    assert.deepEqual({ ...db.prepare(
      "SELECT tenant_id,generation FROM owner_financial_map_inventory_state",
    ).get() }, { tenant_id: "primary", generation: 0 });

    const sourceSalt = "a".repeat(64);
    db.prepare(
      "INSERT INTO owner_financial_map_key_state (tenant_id,signing_salt) VALUES ('primary',?)",
    ).run(sourceSalt);
    db.prepare(
      `INSERT INTO fin_entities
         (tenant_id,entity_slug,legal_name,kind,status,relationship,provenance,basis_state,recorded_at)
       VALUES ('primary','restored-business','Restored Business LLC','business','active','owned',
               'owner_stated','confirmed','2026-09-10T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO fin_accounts
         (tenant_id,account_slug,entity_slug,label,account_kind,balance_role,currency,status,
          provenance,basis_state,recorded_at)
       VALUES ('primary','restored-checking','restored-business','Restored Checking','checking',
               'asset','USD','open','owner_stated','confirmed','2026-09-10T00:00:00Z')`,
    ).run();
    assert.equal(db.prepare(
      "SELECT signing_salt FROM owner_financial_map_key_state WHERE tenant_id='primary'",
    ).get().signing_salt, sourceSalt);
    assert.equal(db.prepare(
      "SELECT generation FROM owner_financial_map_inventory_state WHERE tenant_id='primary'",
    ).get().generation, 2, "restored financial rows rebuild the local preview race fence");
  } finally {
    db.close();
  }
});
