import { assertPossibleMatch } from './partner-r7-assertions.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as attribution from '../src/lib/ledger-attribution.js';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { lineSeparators } from './ledger-attribution-cases.mjs';

const identities = [
  { entity_slug: 'one', legal_name: 'Payer One', display_label: 'Supplier Alias' },
  { entity_slug: 'two', legal_name: 'Payer Two' },
];

test('line separators are field boundaries, including one boundary for CRLF', () => {
  const registry = attribution.payerRegistry(identities);
  for (const separator of lineSeparators) {
    for (const sender of ['Payer One', 'Supplier Alias', 'Payer Two', 'Unregistered Supplier']) {
      const result = attribution.attributeInflow({ description: `FROM: Payer One${separator}FROM: ${sender}` }, registry);
      assert.equal(result.evidence.parser.complete, true, 'complete syntax reaches the identity decision');
      assert.equal(result.evidence.parser.fields, 2);
      assert.equal(result.state, ['Payer One', 'Supplier Alias'].includes(sender) ? 'confirmed' : 'unknown');
    }
    const metadata = attribution.attributeInflow({ description: `FROM: Payer One${separator}TRACE: 123` }, registry);
    assert.equal(metadata.state, 'confirmed');
    assert.equal(metadata.evidence.parser.fields, 2);
    // Canonicalization must not erase a boundary inside an identity or swallow
    // a second boundary as whitespace. These amounts remain unattributed.
    for (const description of [`FROM: Payer${separator}One`, `FROM: Payer One${separator}${separator}TRACE: 123`]) {
      const result = attribution.attributeInflow({ description }, registry);
      assert.ok(result.evidence.parser.steps > 0);
      assert.equal(result.state, 'unknown');
    }
  }
});

test('one answer caches normalized complete parses and keeps raw alphabet and length guards', () => {
  assert.equal(typeof attribution.createInflowAttributor, 'function');
  const registry = attribution.payerRegistry(identities);
  let lookups = 0;
  const get = registry.get.bind(registry);
  registry.get = key => { lookups++; return get(key); };
  const decide = attribution.createInflowAttributor(registry);
  const first = decide({ description: 'FROM: Payer One;TRACE: 123' });
  assert.equal(first.state, 'confirmed');
  assert.ok(lookups > 0, 'the first complete parse resolves sender readings');
  const initial = lookups;
  for (let i = 0; i < 100; i++) for (const separator of [';', ...lineSeparators]) {
    const hit = decide({ description: ` FROM: Payer One${separator}TRACE: 123 ` });
    assert.strictEqual(hit, first, 'equivalent normalized descriptions share the complete decision');
  }
  assert.equal(lookups, initial, 'cache hits perform no sender lookups');
  assert.strictEqual(decide({ description: 'FROM: Payer 𝑂ne;TRACE: 123' }), first, 'NFKC equivalent description shares the parse');
  for (const row of [
    { description: 'FROM: Payer One;TRACE: 123', description_has_nul: 1 },
    { description: 'FROM: Payer One;TRACE: 123\u200b' },
    { description: 'FROM: Payer One;TRACE: 123' + ' '.repeat(512) },
  ]) {
    const result = decide(row);
    assert.equal(result.state, 'unknown');
    assert.ok(result.evidence.parser.steps > 0);
    assert.match(result.evidence.parser.refusal, /alphabet|length-limit/);
  }
  assert.strictEqual(decide({ description: 'FROM: Payer One;TRACE: 123' }), first, 'refusals cannot poison a valid cache entry');
  const conflict = decide({ description: 'FROM: Payer One;FROM: Payer Two' });
  assert.equal(conflict.state, 'unknown');
  assert.equal(conflict.evidence.parser.complete, true);
  assert.equal(conflict.evidence.ambiguous, true);
  const afterConflict = lookups;
  assert.strictEqual(decide({ description: 'FROM: Payer One\nFROM: Payer Two' }), conflict);
  assert.equal(lookups, afterConflict, 'unknown complete results are cached too');
  const structured = decide({ description: 'FROM: Payer One;TRACE: 123', payee: 'Payer Two' });
  // A cached sender cannot be discarded when the structured payee disagrees.
  assert.equal(structured.state, 'unknown');
  assert.equal(structured.entity_slug, null);
  assert.deepEqual(new Set(structured.evidence.candidates), new Set(['Payer One', 'Payer Two']));
  assert.equal(structured.evidence.parser.complete, true);
  assert.equal(structured.evidence.source, 'payee');
  const agreeing = decide({ description: 'FROM: Payer One;TRACE: 123', payee: 'Supplier Alias' });
  assert.equal(agreeing.state, 'confirmed', 'the same cached sender agrees with its registered alias');
  assert.equal(agreeing.entity_slug, 'one');
  assert.equal(agreeing.evidence.parser.complete, true);
  assert.strictEqual(decide({ description: 'FROM: Payer One;TRACE: 123' }), first);
  const assumed = decide({ description: 'Payer One payment' });
  assert.equal(assumed.state, 'assumed');
  assert.strictEqual(decide({ description: 'Payer One payment' }), assumed);
  const other = attribution.createInflowAttributor(attribution.payerRegistry([
    ...identities, { entity_slug: 'other', legal_name: 'Payer One' },
  ]))({ description: 'FROM: Payer One;TRACE: 123' });
  assert.equal(other.state, 'unknown');
  assert.equal(other.evidence.ambiguous, true, 'a different registry cannot reuse the first answer');
  const nextAnswer = attribution.createInflowAttributor(registry)({ description: 'FROM: Payer One;TRACE: 123' });
  assert.equal(nextAnswer.state, 'confirmed');
  assert.notStrictEqual(nextAnswer, first, 'no result survives into another answer, even with the same registry');
  assert.ok(lookups > afterConflict);
});

test('real answers refresh the identity snapshot and preserve each repeated receipt and shorthand note', async t => {
  const f = ledgerFixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
    VALUES ('one','Payer One','business','owned','owner_stated','confirmed',?)`, NOW);
  for (let i = 0; i < 5; i++) f.add(`receipt-${i}`, 'Payer One payment', null);
  const question = 'How much income came from Payer One in October 2026?';
  async function ask(q = question) {
    const start = f.calls.length, before = f.first('SELECT total_changes() n').n;
    const body = await f.ask(q);
    assert.ok(f.calls.slice(start).some(sql => /JOIN fin_transactions/.test(sql)));
    assert.ok(f.calls.slice(start).some(sql => /SELECT entity_slug,legal_name,display_label/.test(sql)));
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 5);
    assert.equal(f.first('SELECT total_changes() n').n, before);
    assert.equal(f.documentCalls, 0);
    assert.equal(body.ledger.inflow_total_minor, 12500);
    return body;
  }
  const green = await ask();
  assertPossibleMatch(green, 12500);
  assert.equal(green.assumptions[0].count, 5);
  assert.equal(green.assumptions[0].citations.length, 5);
  assert.ok(green.answer.includes(green.notes[0]));
  const exact = await ask(question.replace('?', ', exact names only?'));
  assert.equal(exact.ledger.total_minor, null);
  assert.equal(exact.ledger.unattributed_count, 5);
  f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
    VALUES ('two','Payer One payment','business','owned','owner_stated','confirmed',?)`, NOW);
  const conflict = await ask();
  assert.equal(conflict.ledger.total_minor, null);
  assert.equal(conflict.ledger.unattributed_count, 5);
  assert.equal(conflict.evidence_gate.complete, false);
  f.raw("UPDATE fin_entities SET legal_name='Other Supplier' WHERE entity_slug='two'");
  assertPossibleMatch(await ask(), 12500);
});
