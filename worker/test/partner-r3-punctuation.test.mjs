import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';
import * as attribution from '../src/lib/ledger-attribution.js';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { mutatedModule } from './partner-r2-helpers.mjs';

globalThis.fetch = () => { throw new Error('network forbidden'); };
const marks = ['…', '․', '‥', '＇', '．', '﹒'];
const payment = name => `Did the payment from ${name} arrive in October 2026?`;
const income = name => `How much income came from ${name} in October 2026?`;
const widePrefix = name => `Ｄｉｄ the payment from ${name} arrive in October 2026?`;
const noun = name => `Did the ${name} payment arrive in October 2026?`;

async function reached(f, question) {
  const before = f.calls.length, writes = f.first('SELECT total_changes() n').n;
  const result = await f.ask(question);
  assert.ok(f.calls.slice(before).some(sql => /JOIN fin_transactions/.test(sql)), `transaction decision reached: ${question}`);
  assert.ok(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 'nonempty receipts');
  assert.equal(f.first('SELECT total_changes() n').n, writes, 'read only');
  assert.ok(result.ledger, 'ledger answer rendered');
  return result;
}

test('raw question punctuation survives prefix normalization and trailing payer boundaries', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  f.add('receipt', 'ACH CREDIT', 'Supplier Services');
  let refusals = 0;
  for (const source of ['payee', 'description']) {
    f.raw('UPDATE fin_transactions SET payee=?, description=?', source === 'payee' ? 'Supplier Services' : null,
      source === 'description' ? 'FROM: Supplier Services' : 'ACH CREDIT');
    for (const form of [payment, income, widePrefix, noun]) {
      assert.equal((await reached(f, form('Supplier Services'))).ledger.found, true, 'same ordinary payer answers');
      for (const mark of marks) for (const name of [`Supplier${mark} Services`,
        ...(mark === '＇' ? [] : [`Supplier Services${mark}`])]) {
        const result = await reached(f, form(name));
        assert.equal(result.ledger.found, null);
        assert.equal(result.evidence_gate.complete, false);
        refusals++;
      }
    }
  }
  assert.equal(refusals, 88);
  t.diagnostic(JSON.stringify({ refusals }));
});

test('a dangling apostrophe still refuses at the earlier question grammar decision', () => {
  for (const form of [payment, income, widePrefix, noun]) {
    assert.ok(classifyLedgerQuestion(form('Supplier Services'), { now: Date.parse(NOW) }).kind);
    for (const mark of ["'", '＇']) {
      const intent = classifyLedgerQuestion(form(`Supplier Services${mark}`), { now: Date.parse(NOW) });
      assert.equal(intent.broad, true, 'money grammar decision reached');
      assert.equal(intent.kind, null, 'dangling label has no supported reading');
    }
  }
});

test('registered identities retain independent authority for the same question spellings', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
    VALUES ('supplier','Supplier Services','business','owned','owner_stated','confirmed',?)`, NOW);
  f.add('receipt', 'ACH CREDIT', 'Supplier Services');
  for (const source of ['payee', 'description']) for (const mark of marks) {
    const name = `Supplier${mark} Services`;
    f.raw('UPDATE fin_entities SET legal_name=? WHERE entity_slug=?', name, 'supplier');
    f.raw('UPDATE fin_transactions SET payee=?, description=?', source === 'payee' ? 'Supplier Services' : null,
      source === 'description' ? 'FROM: Supplier Services' : 'ACH CREDIT');
    for (const form of [payment, income, widePrefix, noun])
      assert.equal((await reached(f, form(name))).ledger.found, true);
  }
});

test('raw punctuation offsets remain bound after composed letters, glyph expansion and whitespace collapse', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  f.add('receipt', 'ACH CREDIT', 'Supplier Services');
  for (const [raw, bank] of [['Cafe\u0301', 'Café'], ['Oﬃce', 'Office'], ['𐐀', '𐐀']]) {
    f.raw('UPDATE fin_transactions SET payee=?', `${bank} Services`);
    const form = name => `  Ｄｉｄ\u00a0 the  payment from ${name} arrive in October 2026?  `;
    assert.equal((await reached(f, form(`${raw} Services`))).ledger.found, true);
    for (const mark of marks) {
      const question = form(`${raw}${mark}  Services`);
      const intent = classifyLedgerQuestion(question, { now: Date.parse(NOW) });
      assert.ok(intent.payerReadings.some(reading => reading.complete));
      assert.equal(intent.payerQuestion.unsupportedPunctuation, true);
      assert.equal((await reached(f, question)).ledger.found, null);
    }
  }
});

test('raw-punctuation guard mutation restores query-only authority without touching bank rules', async () => {
  const mutant = await mutatedModule('ledger-attribution.js',
    'if (intent.payerQuestion?.unsupportedPunctuation) return registry;', 'if (false) return registry;');
  for (const api of [attribution, mutant]) for (const mark of marks) {
    const intent = classifyLedgerQuestion(payment(`Supplier${mark} Services`), { now: Date.parse(NOW) });
    assert.equal(intent.kind, 'payment');
    assert.ok(intent.payerReadings.some(reading => reading.complete), 'complete payer clause reached');
    const registry = api.payerQuestionRegistry(intent, api.payerRegistry([]));
    const result = api.attributeInflow({ payee: 'Supplier Services' }, registry);
    assert.equal(result.evidence.source, 'payee');
    assert.equal(result.state, api === mutant ? 'observed' : 'unknown');
    const plain = classifyLedgerQuestion(payment('Supplier Services'), { now: Date.parse(NOW) });
    const control = api.payerQuestionRegistry(plain, api.payerRegistry([]));
    assert.equal(api.attributeInflow({ payee: 'Supplier Services' }, control).state, 'observed');
  }
});
