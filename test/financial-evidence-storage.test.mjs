import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createFinancialEvidenceStore } from '../worker/src/lib/financial-evidence-store.js';
import { financialHash, sealFinancialSnapshot } from '../worker/src/lib/financial-snapshot-contract.js';
import { financialFixtures, financialCitation, financialReportFixture, FINANCIAL_FIXTURE_RAW } from './fixtures/financial-contract.mjs';
import { RECOVERY_DURABLE_TABLES, recoveryExportTables } from '../operations/cloudflare-recovery-adapter.mjs';
import { splitStatements, runRestartSafeMigrationStatements } from '../brain.mjs';

const migration = new URL('../migrations/d1/0053_financial_evidence.sql', import.meta.url);
function harness() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(migration, 'utf8'));
  const calls = [];
  const state = { denied: false, missing: false, map: 'map_01', failAt: -1, dropAt: -1, reads: 0, afterCommit: false, sourceHashes: new Map() };
  const db = {
    prepare(sql) {
      return { bind(...values) {
        const statement = sqlite.prepare(sql);
        return { sql, values, first: async () => { state.reads++; return statement.get(...values) || null; },
          run: async () => { calls.push('write'); statement.run(...values); return { success: true }; } };
      } };
    },
    async batch(statements) {
      calls.push('batch'); sqlite.exec('BEGIN');
      try {
        for (const [index, statement] of statements.entries()) {
          if (index === state.failAt) throw new Error('injected_write_failure');
          if (index === state.dropAt) continue;
          sqlite.prepare(statement.sql).run(...statement.values);
        }
        sqlite.exec('COMMIT');
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      if (state.afterCommit) { state.afterCommit = false; throw new Error('injected_lost_response'); }
      return statements.map(() => ({ success: true }));
    },
  };
  const store = createFinancialEvidenceStore({ db,
    authorize: async scope => { calls.push(`authorize:${scope.action}`); return !state.denied && scope.tenant === 'fixture_tenant'; },
    readSource: async reference => { calls.push('source'); return state.missing ? null : {
      ...reference, raw_payload_hash: state.sourceHashes.get(reference.source_id) || await financialHash(FINANCIAL_FIXTURE_RAW), available: true }; },
    readMapHead: async () => { calls.push('map'); return state.map; },
  });
  return { sqlite, store, state, calls };
}
const publish = (store, snapshot) => store.publishSnapshot({ snapshot, rawBytes: new TextEncoder().encode(FINANCIAL_FIXTURE_RAW), implementationSha: 'a'.repeat(40) });

test('0053 migration is replayable at every committed statement boundary and immutable', async () => {
  const sql = readFileSync(migration, 'utf8');
  const statements = splitStatements(sql);
  assert.ok(statements.length >= 10);
  const signature = db => db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const complete = new DatabaseSync(':memory:');
  await runRestartSafeMigrationStatements(statements, async statement => { complete.exec(statement); return { results: [] }; });
  for (let boundary = 0; boundary < statements.length; boundary++) {
    const db = new DatabaseSync(':memory:');
    statements.slice(0, boundary + 1).forEach(statement => db.exec(statement));
    const query = async statement => { db.exec(statement); return { results: [] }; };
    await runRestartSafeMigrationStatements(statements, query);
    await runRestartSafeMigrationStatements(statements, query);
    assert.deepEqual(signature(db), signature(complete)); db.close();
  }
  complete.close();
});

test('snapshot retry, exact readback, immutable history and stale generation refusal', async () => {
  const h = harness();
  try {
    const { snapshot } = await financialFixtures();
    assert.equal((await publish(h.store, snapshot)).snapshot_id, snapshot.snapshot_id);
    await publish(h.store, snapshot);
    assert.equal(h.sqlite.prepare('SELECT count(*) n FROM financial_snapshots').get().n, 1);
    assert.ok(h.state.reads > 0);
    for (const sql of ["UPDATE financial_snapshots SET payload_json='{}'", 'DELETE FROM financial_snapshots']) {
      assert.throws(() => h.sqlite.exec(sql), /immutable/);
    }
    const next = await sealFinancialSnapshot({ ...snapshot, snapshot_id: 'snapshot_02', generation: 2,
      supersedes: { snapshot_id: snapshot.snapshot_id, content_hash: snapshot.content_hash } });
    await publish(h.store, next);
    assert.equal((await h.store.readSnapshot({ tenant: snapshot.scope.tenant, snapshot_id: snapshot.snapshot_id, current: false })).content_hash, snapshot.content_hash);
    await assert.rejects(h.store.readSnapshot({ tenant: snapshot.scope.tenant, snapshot_id: snapshot.snapshot_id }), { code: 'snapshot_stale' });
    assert.ok(h.calls.includes('authorize:read'));
    assert.equal((await h.store.readCitation({ tenant: snapshot.scope.tenant, citation: financialCitation(next) })).cell.money.amount_minor, '370000');
    await assert.rejects(publish(h.store, snapshot), { code: 'snapshot_stale' });
  } finally { h.sqlite.close(); }
});

test('interrupted publication preserves prior pointer and retry converges after lost response', async () => {
  const h = harness();
  try {
    const { snapshot } = await financialFixtures();
    await publish(h.store, snapshot);
    const next = await sealFinancialSnapshot({ ...snapshot, snapshot_id: 'snapshot_02', generation: 2,
      supersedes: { snapshot_id: snapshot.snapshot_id, content_hash: snapshot.content_hash } });
    h.state.failAt = 1;
    const before = h.calls.filter(value => value === 'batch').length;
    await assert.rejects(publish(h.store, next));
    assert.equal(h.calls.filter(value => value === 'batch').length, before + 1);
    assert.equal(h.sqlite.prepare('SELECT snapshot_id FROM financial_snapshot_heads').get().snapshot_id, snapshot.snapshot_id);
    assert.equal(h.sqlite.prepare('SELECT count(*) n FROM financial_snapshots').get().n, 1);
    h.state.failAt = -1; h.state.afterCommit = true;
    await assert.rejects(publish(h.store, next));
    await publish(h.store, next);
    assert.equal(h.sqlite.prepare('SELECT count(*) n FROM financial_snapshots').get().n, 2);
    assert.equal(h.sqlite.prepare('SELECT snapshot_id FROM financial_snapshot_heads').get().snapshot_id, next.snapshot_id);
  } finally { h.sqlite.close(); }
});

test('source denial, missing custody, tenant isolation and map drift gate every read', async () => {
  const h = harness();
  try {
    const { snapshot } = await financialFixtures();
    await publish(h.store, snapshot);
    const input = { tenant: snapshot.scope.tenant, citation: financialCitation(snapshot) };
    assert.ok((await h.store.readCitation(input)).cell.money);
    h.state.denied = true;
    const count = h.calls.length;
    await assert.rejects(h.store.readCitation(input), { code: 'access_denied' });
    assert.ok(h.calls.slice(count).includes('authorize:read'));
    h.state.denied = false; h.state.missing = true;
    await assert.rejects(h.store.readCitation(input), { code: 'source_unavailable' });
    assert.equal(h.calls.at(-1), 'source');
    h.state.missing = false; h.state.map = 'map_02';
    await assert.rejects(h.store.readCitation(input), { code: 'map_stale' });
    assert.equal(h.calls.at(-1), 'map');
    h.state.map = 'map_01';
    await assert.rejects(h.store.readCitation({ ...input, tenant: 'other_tenant' }), { code: 'source_unavailable' });
    assert.ok(h.state.reads > 0);
    assert.ok((await h.store.readCitation(input)).cell.money);
  } finally { h.sqlite.close(); }
});

test('finding values must equal their citations and revoked dependencies block readback', async () => {
  const h = harness();
  try {
    const { snapshot, finding } = await financialFixtures();
    await publish(h.store, snapshot);
    await h.store.publishFinding(finding);
    const bad = structuredClone(finding);
    bad.finding_id = 'finding_bad';
    bad.left.value.decimal = '3700.01'; bad.left.value.amount_minor = '370001';
    bad.difference.decimal = '0.01'; bad.difference.amount_minor = '1';
    bad.status = 'finding'; bad.outcome = 'candidate'; bad.severity = 'major';
    const start = h.calls.length;
    await assert.rejects(h.store.publishFinding(bad), { code: 'finding_value_mismatch' });
    assert.ok(h.calls.slice(start).includes('authorize:read'));
    assert.equal(h.sqlite.prepare('SELECT count(*) n FROM financial_findings').get().n, 1);
    h.state.denied = true;
    await assert.rejects(h.store.readFinding({ tenant: finding.scope.tenant, finding_id: finding.finding_id }), { code: 'access_denied' });
    assert.equal(h.calls.at(-1), 'authorize:read');
    h.state.denied = false;
    assert.equal((await h.store.readFinding({ tenant: finding.scope.tenant, finding_id: finding.finding_id })).status, 'clear');
  } finally { h.sqlite.close(); }
});

test('head cannot be rolled back through SQL replacement', async () => {
  const h = harness();
  try {
    const { snapshot } = await financialFixtures();
    await publish(h.store, snapshot);
    const first = h.sqlite.prepare('SELECT * FROM financial_snapshot_heads').get();
    const next = await sealFinancialSnapshot({ ...snapshot, snapshot_id: 'snapshot_02', generation: 2,
      supersedes: { snapshot_id: snapshot.snapshot_id, content_hash: snapshot.content_hash } });
    await publish(h.store, next);
    assert.throws(() => h.sqlite.prepare('INSERT OR REPLACE INTO financial_snapshot_heads (tenant_id,scope_hash,snapshot_id,content_hash,generation) VALUES (?,?,?,?,?)')
      .run(first.tenant_id, first.scope_hash, first.snapshot_id, first.content_hash, first.generation), /head conflict/);
    assert.equal(h.sqlite.prepare('SELECT generation FROM financial_snapshot_heads').get().generation, 2);
  } finally { h.sqlite.close(); }
});

test('financial history participates in recovery and restores before its current pointer', async () => {
  const tables = ['financial_snapshots', 'financial_findings', 'financial_run_events', 'financial_snapshot_heads'];
  for (const table of tables) assert.ok(RECOVERY_DURABLE_TABLES.includes(table), table);
  const migrations = Array.from({ length: 53 }, (_, index) => ({ version: index + 1 }));
  for (const table of tables) {
    assert.ok(recoveryExportTables(migrations).includes(table), table);
  }
  for (const version of [50, 51, 52]) {
    const exported = recoveryExportTables(migrations.slice(0, version));
    assert.ok(exported.includes('documents'), `schema ${version} reached the export inventory`);
    for (const table of tables) {
      assert.equal(exported.includes(table), false, `schema ${version} excludes ${table}`);
    }
  }
  const h = harness(), restored = new DatabaseSync(':memory:');
  try {
    const { snapshot } = await financialFixtures();
    await publish(h.store, snapshot);
    await publish(h.store, await sealFinancialSnapshot({ ...snapshot, snapshot_id: 'snapshot_02', generation: 2,
      supersedes: { snapshot_id: snapshot.snapshot_id, content_hash: snapshot.content_hash } }));
    restored.exec(readFileSync(migration, 'utf8'));
    for (const table of tables) {
      const rows = h.sqlite.prepare(`SELECT * FROM ${table}`).all().reverse();
      for (const row of rows) restored.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
      assert.equal(restored.prepare(`SELECT count(*) n FROM ${table}`).get().n, rows.length);
    }
    assert.equal(restored.prepare('SELECT generation FROM financial_snapshot_heads').get().generation, 2);
  } finally { h.sqlite.close(); restored.close(); }
});

test('exact readback includes the publication journal, not only snapshot and head', async () => {
  const h = harness();
  try {
    const { snapshot } = await financialFixtures();
    h.state.dropAt = 2;
    await assert.rejects(publish(h.store, snapshot), { code: 'readback_mismatch' });
    assert.ok(h.calls.includes('batch'));
    assert.equal(h.sqlite.prepare("SELECT count(*) n FROM financial_run_events WHERE event_kind='published'").get().n, 0);
    await assert.rejects(h.store.readCitation({ tenant: snapshot.scope.tenant, citation: financialCitation(snapshot) }), { code: 'readback_mismatch' });
    h.state.dropAt = -1;
    await publish(h.store, snapshot);
    assert.ok((await h.store.readCitation({ tenant: snapshot.scope.tenant, citation: financialCitation(snapshot) })).cell.money);
  } finally { h.sqlite.close(); }
  const control = harness();
  try {
    await publish(control.store, (await financialFixtures()).snapshot);
    assert.equal(control.sqlite.prepare("SELECT count(*) n FROM financial_run_events WHERE event_kind='published'").get().n, 1);
  } finally { control.sqlite.close(); }
});

test('absent-side evidence resolves a genuinely empty report instead of caller optimism', async () => {
  const h = harness();
  try {
    const { snapshot, finding } = await financialFixtures();
    await publish(h.store, snapshot);
    const empty = await financialReportFixture({ count: 0 });
    empty.snapshot.source_id = 'source_02'; empty.snapshot.snapshot_id = 'snapshot_empty';
    empty.snapshot.source_document_ref = 'document_02'; empty.snapshot.lineage.root_ids = ['document_02'];
    empty.snapshot = await sealFinancialSnapshot(empty.snapshot);
    h.state.sourceHashes.set('source_02', empty.snapshot.raw_payload_hash);
    await h.store.publishSnapshot({ snapshot: empty.snapshot, rawBytes: new TextEncoder().encode(empty.raw), implementationSha: 'a'.repeat(40) });
    finding.status = 'finding'; finding.outcome = 'candidate'; finding.severity = 'major'; finding.difference = null;
    finding.right = { state: 'absent', value: null, citations: [], reason: 'empty_report', search_receipt: {
      citation: financialCitation(empty.snapshot), scope: empty.snapshot.scope, coverage: empty.snapshot.coverage,
      match_count: 0, predicate_hash: '9'.repeat(64) } };
    await h.store.publishFinding(finding);
    const bad = structuredClone(finding); bad.finding_id = 'finding_bad_absence';
    bad.right.search_receipt.citation = financialCitation(snapshot);
    bad.right.search_receipt.coverage = snapshot.coverage;
    const before = h.calls.length;
    await assert.rejects(h.store.publishFinding(bad), { code: 'absence_unproved' });
    assert.ok(h.calls.slice(before).includes('authorize:read'));
    assert.equal(h.sqlite.prepare('SELECT count(*) n FROM financial_findings').get().n, 1);
  } finally { h.sqlite.close(); }
});

test('page receipts hash the exact staged byte slices before publication', async () => {
  const h = harness();
  try {
    const { snapshot } = await financialFixtures();
    const bad = structuredClone(snapshot); bad.coverage.pages[0].payload_hash = 'f'.repeat(64);
    const sealed = await sealFinancialSnapshot(bad);
    await assert.rejects(publish(h.store, sealed), { code: 'raw_hash' });
    assert.ok(h.calls.includes('authorize:write'));
    assert.equal(h.sqlite.prepare('SELECT count(*) n FROM financial_snapshots').get().n, 0);
    await publish(h.store, snapshot);
    assert.equal(h.sqlite.prepare('SELECT count(*) n FROM financial_snapshots').get().n, 1);
  } finally { h.sqlite.close(); }
});
