// Schema 63 bank-feed health survives a supervised recovery.
//
// The recovery adapter compares the exact table inventory and exports tables in
// the order recoveryExportTables() returns them. Without bank_feed_health in
// that inventory a schema-63 Brain could not be recovered at all, and a restore
// that dropped the rows would report every connection as never synced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import {
  recoveryExportTables, RECOVERY_DURABLE_TABLES, V048_RECOVERY_DURABLE_TABLES,
} from '../operations/cloudflare-recovery-adapter.mjs';

const DIR = new URL('../migrations/d1/', import.meta.url);
const FILES = readdirSync(DIR).filter(name => /^\d+_.*\.sql$/.test(name)).sort();
const MIGRATIONS = FILES.map(name => ({ version: Number(name.slice(0, 4)), name: name.replace(/\.sql$/, '') }));
const SYNC = '2026-11-10T14:00:00.000Z';
const SEEDED = ['sources', 'bank_feed_items', 'bank_feed_health'];

function migrated(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  for (const name of FILES) db.exec(readFileSync(new URL(name, DIR), 'utf8'));
  // Source writes require the install singleton, on both sides of a restore.
  db.prepare(`INSERT INTO install_state(id,client_slug,product_version,schema_version,installed_at)
    VALUES (1,'synthetic','0.0.0',?,'2026-10-01T00:00:00.000Z')`).run(MIGRATIONS.at(-1).version);
  return db;
}

function source(t) {
  const db = migrated(t);
  db.prepare(`INSERT INTO bank_feed_items(item_ref,access_ciphertext,access_iv,environment,status,connected_at)
    VALUES ('synthetic-item',?,?,'production','connected','2026-10-01T00:00:00.000Z')`)
    .run(Buffer.from('synthetic storage bytes').toString('base64'), Buffer.from('synthetic iv').toString('base64'));
  db.prepare(`INSERT INTO bank_feed_health(tenant_id,item_ref,last_attempt_at,last_successful_sync_at,data_through)
    VALUES ('primary','synthetic-item',?,?,?)`).run(SYNC, SYNC, SYNC.slice(0, 10));
  // 0063's trigger derives the bank source's clock from health on this insert.
  db.prepare(`INSERT INTO sources(name,kind,status,created_at,last_ingest_at)
    VALUES ('bank_activity','bank_activity','ready','2026-10-01T00:00:00.000Z',NULL)`).run();
  return db;
}

// Copy rows table by table, in the given order, as the import of a
// data-only export does.
function restore(t, from, order) {
  const target = migrated(t);
  for (const table of order) {
    for (const row of from.prepare(`SELECT * FROM "${table}"`).all()) {
      const columns = Object.keys(row);
      target.prepare(`INSERT INTO "${table}" (${columns.map(c => `"${c}"`).join(',')})
        VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(c => row[c]));
    }
  }
  return target;
}

const healthRows = db => db.prepare('SELECT * FROM bank_feed_health ORDER BY tenant_id,item_ref').all()
  .map(row => ({ ...row }));
const bankSource = db => ({ ...db.prepare(
  "SELECT last_ingest_at,expected_refresh_seconds FROM sources WHERE name='bank_activity'").get() });

test('schema 63 inventory carries bank_feed_health without widening older inventories', () => {
  assert.equal(MIGRATIONS.at(-1).version, 69);
  assert.equal(RECOVERY_DURABLE_TABLES.includes('bank_feed_health'), true);
  assert.equal(recoveryExportTables(MIGRATIONS).includes('bank_feed_health'), true);
  assert.equal(recoveryExportTables(MIGRATIONS.slice(0, 62)).includes('bank_feed_health'), false);
  assert.equal(V048_RECOVERY_DURABLE_TABLES.includes('bank_feed_health'), false);
});

test('a restored schema-63 Brain keeps its health rows and the bank source clock', t => {
  const from = source(t);
  assert.deepEqual(bankSource(from), { last_ingest_at: SYNC, expected_refresh_seconds: 86400 },
    'the source trigger reached its decision before the restore');
  const order = recoveryExportTables(MIGRATIONS).filter(table => SEEDED.includes(table));
  assert.deepEqual(order, SEEDED, 'sources restore before the bank items and their health');
  const target = restore(t, from, order);
  assert.deepEqual(healthRows(target), healthRows(from));
  assert.deepEqual(bankSource(target), bankSource(from));
});

test('controls: dropping health, or restoring items before sources, loses the sync clock', t => {
  const from = source(t);
  const withoutHealth = restore(t, from, ['sources', 'bank_feed_items']);
  assert.deepEqual(healthRows(withoutHealth), [], 'an export without the table carries no health');
  // The trigger fires only when bank items already exist, so the wrong order
  // nulls the restored clock until a later complete pull.
  const itemsFirst = restore(t, from, ['bank_feed_items', 'sources', 'bank_feed_health']);
  assert.deepEqual(healthRows(itemsFirst), healthRows(from));
  assert.equal(bankSource(itemsFirst).last_ingest_at, null);
});


test('schema 64 recovery retains provider retry timing independently of webhook due time', t => {
  const from=source(t);
  const floor='2026-11-10T14:10:08.200Z';
  from.prepare(`INSERT INTO plaid_reconciliation
    (tenant_id,item_ref,reason,state,due_at,provider_retry_not_before,attempts,updated_at)
    VALUES ('primary','synthetic-item','webhook','pending',?,?,1,?)`).run(SYNC,floor,SYNC);
  const order=recoveryExportTables(MIGRATIONS).filter(table=>[...SEEDED,'plaid_reconciliation'].includes(table));
  assert.ok(order.includes('plaid_reconciliation'),'real export inventory reached');
  const target=restore(t,from,order);
  const restored=target.prepare('SELECT due_at,provider_retry_not_before FROM plaid_reconciliation').get();
  assert.equal(restored.due_at,SYNC,'notification debt remains due');
  assert.equal(restored.provider_retry_not_before,floor,'independent provider floor survives exact column restore');
  const withoutFloor=migrated(t);
  withoutFloor.prepare(`INSERT INTO plaid_reconciliation
    (tenant_id,item_ref,reason,state,due_at,attempts,updated_at)
    VALUES ('primary','synthetic-item','webhook','pending',?,1,?)`).run(SYNC,SYNC);
  assert.equal(withoutFloor.prepare('SELECT COUNT(*) n FROM plaid_reconciliation').get().n,1,'negative control restores the queue row');
  assert.equal(withoutFloor.prepare('SELECT provider_retry_not_before FROM plaid_reconciliation').get().provider_retry_not_before,null,
    'omitting the new column loses the floor even though the queue row exists');
});
