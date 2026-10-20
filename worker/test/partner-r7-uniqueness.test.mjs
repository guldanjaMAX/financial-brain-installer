import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';

test('two exact merchant readings at a period boundary cannot certify either row set', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  f.add('plain', 'Purchase', 'Supplier', { direction: 'outflow', cents: 12300, date: '2026-09-05' });
  const q = 'How much did I spend at Supplier in last month?';
  assert.equal((await f.ask(q)).ledger.total_minor, 12300);
  f.add('scope-word', 'Purchase', 'Supplier in', { direction: 'outflow', cents: 40000, date: '2026-09-05' });
  const reads = f.calls.length, changes = f.first('SELECT total_changes() n').n;
  const body = await f.ask(q);
  assert.ok(f.calls.slice(reads).some(sql => /JOIN fin_transactions/.test(sql)));
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 2);
  assert.equal(f.first('SELECT total_changes() n').n, changes);
  assert.equal(body.ledger.found, null);
  assert.equal(body.evidence_gate.complete, false);
  assert.equal(body.ledger.total_minor, null);
  assert.equal(body.ledger.selector_ambiguous, true);
});

test('colliding registered merchant aliases retain a populated ambiguity decision', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  f.add('receipt', 'Purchase', 'Supplier Unit', { direction: 'outflow', cents: 12300 });
  const q = 'How much did I spend at Supplier Unit in October 2026?';
  assert.equal((await f.ask(q)).ledger.total_minor, 12300);
  for (const slug of ['first', 'second']) f.raw("INSERT INTO fin_entities(entity_slug,legal_name,display_label,kind,relationship,provenance,basis_state,recorded_at) VALUES (?,?,?,'business','owned','owner_stated','confirmed',?)", slug, `Merchant ${slug}`, 'Supplier Unit', NOW);
  const reads = f.calls.length;
  const body = await f.ask(q);
  assert.ok(f.calls.slice(reads).some(sql => /JOIN fin_transactions/.test(sql)));
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 1);
  assert.equal(body.ledger.found, null);
  assert.equal(body.evidence_gate.complete, false);
  assert.equal(body.ledger.total_minor, null);
});

test('an exact registered merchant alias selects its confirmed bounded field', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  f.add('receipt', 'Purchase', 'Supplier Unit', { direction: 'outflow', cents: 12300 });
  assert.equal((await f.ask('How much did I spend at Supplier Unit in October 2026?')).ledger.total_minor, 12300);
  f.raw("INSERT INTO fin_entities(entity_slug,legal_name,display_label,kind,relationship,provenance,basis_state,recorded_at) VALUES ('merchant','Supplier Unit','Registered Alias','business','owned','owner_stated','confirmed',?)", NOW);
  const reads = f.calls.length, body = await f.ask('How much did I spend at Registered Alias in October 2026?');
  assert.ok(f.calls.slice(reads).some(sql => /JOIN fin_transactions/.test(sql)));
  assert.equal(body.ledger.total_minor, 12300);
  assert.equal(body.ledger.total_is_exact, true);
  assert.equal(body.evidence_gate.complete, true);
});

test('a damaged registry cannot grant new literal-only authority', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  f.add('receipt', 'Opaque bank memo', 'Supplier Unit', { cents: 12300 });
  const q = 'Did the payment from Supplier Unit arrive in October 2026?';
  assert.equal((await f.ask(q)).ledger.found, true);
  f.raw("INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at) VALUES ('damaged',?,'business','owned','owner_stated','confirmed',?)", 'Hidden\0Supplier', NOW);
  const reads = f.calls.length, body = await f.ask(q);
  assert.ok(f.calls.slice(reads).some(sql => /JOIN fin_transactions/.test(sql)));
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 1);
  assert.equal(body.ledger.found, null);
  assert.equal(body.evidence_gate.complete, false);
});

test('an equal structured field retains the established company-suffix agreement check', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  f.add('receipt', 'FROM: Supplier Unit', 'Supplier Unit', { cents: 12300 });
  const q = 'Did the payment from Supplier Unit arrive in October 2026?';
  assert.equal((await f.ask(q)).ledger.found, true);
  f.raw("UPDATE fin_transactions SET description='FROM: Supplier Unit, LLC'");
  const reads = f.calls.length, body = await f.ask(q);
  assert.ok(f.calls.slice(reads).some(sql => /JOIN fin_transactions/.test(sql)));
  assert.equal(body.ledger.found, true);
  assert.equal(body.evidence_gate.complete, true);
  assert.deepEqual(body.citations.map(c => c.amount_minor), [12300]);
});

test('grouped numbers inside exact payer names retain their original selector keys', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  f.add('grouped', 'Opaque memo', 'Unit 4,000 dollar Supply', { cents: 12300 });
  f.add('ungrouped', 'Opaque memo', 'Unit 4000 dollar Supply', { cents: 7890 });
  for (const [name, amount] of [['Unit 4,000 dollar Supply', 12300], ['Unit 4000 dollar Supply', 7890]]) {
    const reads = f.calls.length, writes = f.first('SELECT total_changes() n').n;
    const body = await f.ask(`Did the payment from ${name} arrive in October 2026?`);
    assert.ok(f.calls.slice(reads).some(sql => /JOIN fin_transactions/.test(sql)));
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 2);
    assert.equal(f.first('SELECT total_changes() n').n, writes);
    assert.equal(body.ledger.found, true);
    assert.equal(body.evidence_gate.complete, true);
    assert.deepEqual(body.citations.map(c => c.amount_minor), [amount]);
  }
});
