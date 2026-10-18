import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { productionFixture, productionCases, measureProduction, reachedAnswer } from './ledger-production-fixture.mjs';
import { attributeInflow, payerRegistry, payerQuestionRegistry, ledgerStatementVocabulary } from '../src/lib/ledger-attribution.js';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';

const payment = name => `Did the payment of $25.00 from ${name} arrive in October 2026?`;
const income = name => `How much income came from ${name} in October 2026?`;
function fixture(t) {
  const f = ledgerFixture(t, { knownPayers: false });
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  f.add('receipt', 'FROM: Supplier One', null);
  assert.equal(f.first("SELECT COUNT(*) n FROM fin_entities WHERE relationship!='owned'").n, 0);
  return f;
}
function refused(body) {
  assert.equal(body.ledger.found, null);
  assert.equal(body.evidence_gate.complete, false);
  assert.equal(body.ledger.total_minor ?? null, null);
  assert.equal(body.ledger.attributed_subtotal_minor ?? null, null);
  assert.ok(!body.payer_evidence?.length && !body.assumptions?.length);
  assert.equal(body.ledger.inflow_total_minor, 2500);
  assert.equal(body.ledger.unattributed_count, 1);
  assert.equal(body.ledger.unattributed_candidates[0].amount_minor, 2500);
  assert.ok(body.citations.some(c => c.amount_minor === 2500));
}

test('query-only sender authority rejects reference prose and damaged explicit fields', async t => {
  const f = fixture(t);
  let decisions = 0;
  for (const [description, phrase] of [
    ['FROM Supplier One ref 123', 'Supplier One ref 123'],
    ['FROM: Supplier One, TRACE: ABC', 'Supplier One TRACE ABC'],
    ['FROM: Supplier One, FROM:', 'Supplier One FROM'],
    ['FROM: Supplier Payment Services', 'Supplier Payment Services'],
  ]) for (const form of [payment, income]) for (const exact of [false, true]) {
    const question = form(phrase).replace('?', exact ? ', exact names only?' : '?');
    f.raw('UPDATE fin_transactions SET payee=?,description=?', phrase, description);
    const control = await reachedAnswer(f, question);
    assert.equal(control.ledger.found, true);
    assert.equal(control.payer_evidence[0].type, 'bank_payee');
    f.raw('UPDATE fin_transactions SET payee=NULL');
    const attribution = attributeInflow({ description }, payerQuestionRegistry(
      classifyLedgerQuestion(question, { now: Date.parse(NOW) }), payerRegistry([])));
    assert.ok(attribution.evidence.parser.steps > 0, 'statement decision reached');
    refused(await reachedAnswer(f, question)); decisions++;
  }
  assert.equal(decisions, 16);
});


test('every grammar token refuses query-only descriptions with valid, invalid and empty values', async t => {
  const f = fixture(t), failures = [];
  const counts = { tokens: ledgerStatementVocabulary.length, rows: 0, refusals: 0, controls: 0 };
  assert.ok(counts.tokens >= 38, 'the generator must reach the complete nonempty grammar vocabulary');
  for (const token of ledgerStatementVocabulary) for (const value of ['123', 'ABC', '']) {
    const phrase = `Supplier Unit ${token} ${value}`.trim();
    for (const description of [`FROM: ${phrase}`, `FROM Supplier Unit ${token} ${value}`.trim(),
      `FROM: Supplier Unit, ${token}: ${value}`.trim(), `${phrase} payment`, `ACH ${phrase}`]) {
      for (const form of [payment, income]) for (const exact of [false, true]) {
        const question = form(phrase).replace('?', exact ? ', exact names only?' : '?');
        f.raw('UPDATE fin_transactions SET payee=?,description=?', phrase, description);
        const bank = await reachedAnswer(f, question);
        assert.equal(bank.ledger.found, true);
        assert.equal(bank.payer_evidence[0].type, 'bank_payee'); counts.controls++;
        f.raw('UPDATE fin_transactions SET payee=NULL');
        const a = attributeInflow({ description }, payerQuestionRegistry(
          classifyLedgerQuestion(question, { now: Date.parse(NOW) }), payerRegistry([])));
        assert.ok(a.evidence.parser.steps > 0, 'each description reaches the parser');
        const body = await reachedAnswer(f, question);
        try { refused(body); counts.refusals++; }
        catch { failures.push({ token, value, description, kind: body.ledger.kind, exact }); }
      }
      counts.rows++;
    }
  }
  assert.equal(counts.rows, counts.tokens * 15);
  assert.equal(counts.controls, counts.tokens * 60);
  t.diagnostic(JSON.stringify({ vocabulary_generator: counts, wrong: failures.length }));
  assert.deepEqual(failures, []);
  assert.equal(counts.refusals, counts.controls);
});

test('registered vocabulary names and ordinary labelled query names retain independent controls', async t => {
  const f = fixture(t);
  for (const token of ledgerStatementVocabulary) {
    const name = `Supplier Unit ${token} Services`;
    f.raw("INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at) VALUES ('registered',?,'business','counterparty','owner_stated','confirmed',?)", name, NOW);
    f.raw('UPDATE fin_transactions SET description=?', `FROM: ${name}`);
    for (const form of [payment, income]) {
      const body = await reachedAnswer(f, form(name));
      assert.equal(body.ledger.found, true);
      assert.equal(body.ledger.inflow_total_minor, 2500);
      assert.ok(body.citations.some(c => c.amount_minor === 2500));
      if (body.ledger.kind === 'merchant') assert.equal(body.ledger.total_minor, 2500);
    }
    f.raw("DELETE FROM fin_entities WHERE entity_slug='registered'");
    f.raw("UPDATE fin_transactions SET description='FROM: Supplier Unit; TRACE: 123'");
    for (const form of [payment, income]) assert.equal((await reachedAnswer(f, form('Supplier Unit'))).ledger.found, true);
  }
});


test('damaged fields and repeated sender fields refuse while complete ordinary fields remain usable', async t => {
  const f = fixture(t);
  for (const tail of ['TRACE: ABC', 'TRACE:', 'FROM:', 'SEC: XYZ', 'EFFECTIVE DATE: 2026-02-30',
    'CO ENTRY DESCR: notpaid', 'REF: unknown value', 'FROM: Supplier One']) {
    for (const delimiter of [', ', '; ', ' ']) for (const form of [payment, income]) {
      f.raw('UPDATE fin_transactions SET description=?', `FROM: Supplier One${delimiter}${tail}`);
      refused(await reachedAnswer(f, form('Supplier One')));
      f.raw("UPDATE fin_transactions SET description='WIRE FROM: Supplier One; CO ENTRY DESCR: payment; TRACE: 123'");
      assert.equal((await reachedAnswer(f, form('Supplier One'))).ledger.found, true);
    }
  }
  for (const name of ['Supplier Paymentology', 'Fromage Supplier', 'Supplier Referenceable']) {
    f.raw('UPDATE fin_transactions SET description=?', `FROM: ${name}`);
    assert.equal((await reachedAnswer(f, payment(name))).ledger.found, true, 'only complete vocabulary tokens are reserved');
  }
  for (const name of ['Supplier PAYMENT Services', 'Supplier Ｐａｙｍｅｎｔ Services', 'Supplier (From) Services']) {
    f.raw('UPDATE fin_transactions SET description=?', `FROM: ${name}`);
    refused(await reachedAnswer(f, payment(name)));
  }
});


test('unregistered production shorthand restores four answers with notes and exact-name flips', async t => {
  const f = productionFixture(t), stats = await measureProduction(f);
  assert.deepEqual([stats.answered, stats.refused, stats.wrong], [40, 0, 0]);
  const shorthandCases = productionCases.filter(c => !c.raw.merchant_name && [1, 3].includes(c.format));
  assert.equal(shorthandCases.length, 4);
  let noted = 0;
  for (const c of productionCases) {
    const body = await reachedAnswer(f, c.question);
    assert.equal(body.ledger.found, true);
    if (!shorthandCases.includes(c)) { assert.ok(!body.assumptions?.length); continue; }
    assert.equal(body.assumptions.length, 1);
    assert.equal(body.assumptions[0].query_only, true);
    assert.equal(body.assumptions[0].amount_minor, c.cents);
    assert.ok(body.assumptions[0].citations.every(n => body.citations.some(ref => ref.n === n && ref.amount_minor === c.cents)));
    assert.ok(body.notes.every(note => body.answer.includes(note)));
    assert.match(body.answer, /Note:.*exact names only/);
    assert.ok(body.ledger.flip.includes('exact names only'));
    assert.ok(!body.payer_evidence?.length);
    if (c.kind === 'merchant') {
      assert.equal(body.ledger.total_minor, null);
      assert.equal(body.ledger.attributed_subtotal_minor, c.cents);
    }
    noted++;
    const exact = await reachedAnswer(f, c.question.replace('?', ', exact names only?'));
    assert.equal(exact.ledger.found, null);
    assert.equal(exact.evidence_gate.complete, false);
    assert.equal(exact.ledger.attributed_subtotal_minor ?? null, null);
    assert.equal(exact.ledger.unattributed_count, 40);
    assert.equal(exact.ledger.unattributed_candidates.length, 10);
    assert.equal(exact.ledger.unattributed_omitted_count, 30);
    assert.ok(!exact.assumptions?.length);
    const isolated = fixture(t);
    isolated.raw('UPDATE fin_transactions SET amount_minor=?,description=?', c.cents, c.raw.name);
    const single = await reachedAnswer(isolated, c.question);
    assert.equal(single.ledger.found, true);
    assert.equal(single.assumptions[0].amount_minor, c.cents);
    assert.ok(single.citations.some(ref => ref.amount_minor === c.cents));
  }
  assert.equal(noted, 4);
  t.diagnostic(JSON.stringify({ production: stats, noted,
    shorthand_formats: shorthandCases.map(c => ({ format: c.format, cents: c.cents, kind: c.kind })) }));
});
