import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';
import { requestedSelectorCases } from './ledger-question-cases.mjs';
import { payerRegistry, resolveRequestedPayer } from '../src/lib/ledger-attribution.js';

const payment = name => `Did the payment of $25.00 from ${name} arrive in October 2026?`;
const income = name => `How much income came from ${name} in October 2026?`;
function setup(t) {
  const f = ledgerFixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  const identity = (slug, name, alias = null) => f.raw(`INSERT INTO fin_entities
    (entity_slug,legal_name,display_label,kind,relationship,provenance,basis_state,recorded_at)
    VALUES (?,?,?,'business','counterparty','owner_stated','confirmed',?)`, slug, name, alias, NOW);
  f.add('receipt', 'Confirmed receipt', 'Payer One');
  async function ask(q) {
    f.calls.length = 0;
    const before = f.calls.length, changes = f.first('SELECT total_changes() n').n;
    const body = await f.ask(q);
    assert.ok(f.calls.slice(before).some(sql => /JOIN fin_transactions/.test(sql)), q);
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 1);
    assert.equal(f.first('SELECT total_changes() n').n, changes);
    assert.equal(f.documentCalls, 0, q);
    assert.ok(body.ledger, q);
    return body;
  }
  return { ...f, identity, ask };
}
function uncertain(body) {
  assert.equal(body.ledger.found, null);
  assert.equal(body.evidence_gate.complete, false);
  if (body.ledger.kind === 'merchant') assert.equal(body.ledger.total_minor, null);
  assert.doesNotMatch(body.answer, /No matching|\$0\.00/);
}

test('a complete registered comma name supersedes its contained spelling: both receipt arms and exact-name modes', async t => {
  const f = setup(t);
  f.identity('short', 'Payer One', 'Short Supplier');
  f.identity('whole', 'Payer One, Bank', 'Whole Supplier');
  for (const actual of ['Payer One', 'Payer One, Bank']) {
    f.raw('UPDATE fin_transactions SET payee=?', actual);
    for (const form of [payment, income]) for (const exact of [false, true]) {
      const q = name => form(name).replace('?', exact ? ', exact names only?' : '?');
      const control = await f.ask(q('Whole Supplier'));
      assert.equal(control.ledger.found, actual === 'Payer One, Bank');
      assert.equal(control.evidence_gate.complete, true);
      const body = await f.ask(q('Payer One, Bank'));
      assert.equal(body.ledger.found, actual === 'Payer One, Bank');
      assert.equal(body.evidence_gate.complete, true);
      assert.equal(body.ledger.payer_selector_ambiguous, undefined);
    }
  }
});

test('amount-bearing selectors preserve numeric and generic whole names', async t => {
  const f = setup(t);
  f.identity('short', '1234', 'Short Supplier');
  f.identity('whole', '1234, Bank', 'Whole Supplier');
  for (const actual of ['1234', '1234, Bank']) {
    f.raw('UPDATE fin_transactions SET payee=?', actual);
    assert.equal((await f.ask(payment('Whole Supplier'))).ledger.found, actual === '1234, Bank');
    const body = await f.ask(payment('1234, Bank'));
    assert.equal(body.ledger.found, actual === '1234, Bank');
    assert.equal(body.evidence_gate.complete, true);
  }
});

test('an unregistered alternative whole name cannot fabricate a competing selector', async t => {
  const f = setup(t);
  f.identity('short', 'Payer One');
  f.identity('whole', 'Payer One payment', 'Whole Supplier');
  f.raw('UPDATE fin_transactions SET payee=?', 'Payer One payment');
  const question = 'Did the payment from Payer One payment arrive in October 2026?';
  assert.equal((await f.ask(payment('Whole Supplier'))).ledger.found, true);
  assert.equal((await f.ask(question)).ledger.found, true);
  f.identity('alternative', 'Payment from Payer One');
  const body = await f.ask(question);
  uncertain(body);
  assert.equal(body.ledger.payer_selector_ambiguous, true);
  assert.equal(body.ledger.payer_selector_candidates.length, 2);
});

test('whole names, aliases of one slug, empty snapshots and disjoint selector clauses', async t => {
  const f = setup(t);
  f.identity('whole', 'Payer One, Bank', 'Payer One');
  f.raw('UPDATE fin_transactions SET payee=?', 'Payer One, Bank');
  for (const form of [payment, income]) for (const exact of [false, true]) {
    const q = form('Payer One, Bank').replace('?', exact ? ', exact names only?' : '?');
    const body = await f.ask(q);
    assert.equal(body.ledger.found, true);
    assert.equal(body.evidence_gate.complete, true);
  }
  const combined = 'Did the Payer One payment from Payer One, Bank arrive in October 2026?';
  assert.equal((await f.ask(combined)).ledger.found, true);
  f.raw('UPDATE fin_entities SET display_label=NULL WHERE entity_slug=?', 'whole');
  f.identity('short', 'Payer One', 'Short Supplier');
  uncertain(await f.ask(combined));
  f.raw('UPDATE fin_transactions SET posted_on=?', '2025-01-01');
  for (const form of [payment, income]) {
    const body = await f.ask(form('Payer One, Bank'));
    assert.equal(body.ledger.found, false);
    assert.equal(body.evidence_gate.complete, true);
    assert.equal(body.ledger.inflow_total_minor, 0, 'the unique complete name is absent from the covered empty window');
    if (body.ledger.kind === 'merchant') assert.equal(body.ledger.total_minor, 0);
  }
});

test('selector limits and forbidden controls refuse after a positive routing control', () => {
  const green = classifyLedgerQuestion(payment('Payer One'), { now: NOW });
  assert.equal(green.kind, 'payment');
  assert.ok(green.payerReadings.length);
  for (const text of ['Payer One\0Bank', 'Payer One\u200bBank', 'Payer One' + ' Bank'.repeat(130)]) {
    const result = classifyLedgerQuestion(payment(text), { now: NOW });
    assert.equal(result.broad, true, 'money routing decision reached');
    assert.equal(result.kind, null);
  }
});

test('a selector outside the protected alphabet cannot fall back to comma truncation', async t => {
  const f = ledgerFixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,display_label,kind,relationship,provenance,basis_state,recorded_at)
    VALUES ('whole','& Payer One, Bank','Whole Supplier','business','counterparty','owner_stated','confirmed',?)`, NOW);
  f.add('receipt', 'Confirmed receipt', '& Payer One, Bank');
  assert.equal((await f.ask(payment('Whole Supplier'))).ledger.found, true);
  const before = f.documentCalls, reads = f.calls.length;
  const body = await f.ask(payment('& Payer One, Bank'));
  assert.equal(f.documentCalls, before + 1, 'unsupported-selector routing decision reached');
  assert.equal(f.calls.length, reads, 'no truncated selector can read the ledger');
  assert.equal(body.ledger, undefined);
});

test('unknown and partly covered selectors refuse; a confirmed registered payer remains useful', async t => {
  const f = setup(t);
  f.identity('short', 'Payer One');
  assert.equal((await f.ask(payment('Payer One'))).ledger.found, true);
  for (const form of [payment, income]) {
    const absent = await f.ask(form('Unregistered Supplier'));
    uncertain(absent);
    assert.equal(absent.ledger.payer_selector_ambiguous, true);
    uncertain(await f.ask(form('Payer One Reference')));
    uncertain(await f.ask(form('Payer One,' + ' Bank'.repeat(20))));
  }
});

test('generator retains complete requested names before interpreting grammar words', () => {
  let cases = 0;
  for (const arm of requestedSelectorCases()) {
    const intent = classifyLedgerQuestion(arm.question, { now: NOW });
    assert.ok(intent.kind, JSON.stringify(arm));
    assert.ok(intent.payerReadings?.some(reading => reading.label === arm.whole.toLowerCase()), JSON.stringify(arm));
    const entries = [
      ...(arm.registration === 'longer' ? [] : [{ entity_slug: 'short', legal_name: 'Payer One' }]),
      ...(arm.registration === 'shorter' ? [] : [{ entity_slug: 'whole', legal_name: arm.whole }]),
    ];
    const resolved = resolveRequestedPayer(intent, payerRegistry(entries));
    if (resolved.state === 'unique') assert.equal(resolved.slug, 'whole', JSON.stringify(arm));
    if (arm.registration === 'longer') assert.equal(resolved.state, 'unique', JSON.stringify(arm));
    assert.notEqual(resolved.state, 'missing', JSON.stringify(arm));
    cases++;
  }
  assert.ok(cases > 50000);
});

test('generated requested selectors resolve by distinct slugs, with both real receipt arms', async t => {
  const f = setup(t);
  const counts = { cases: 0, unique: 0, ambiguous: 0, unresolved: 0, missing: 0, answers: 0 };
  f.identity('short', 'Payer One', 'Short Supplier');
  f.identity('whole', 'Initial Supplier', 'Whole Supplier');
  const control = await f.ask(payment('Short Supplier'));
  assert.equal(control.ledger.found, true);
  for (const arm of requestedSelectorCases()) {
    const entries = [
      ...(arm.registration === 'longer' ? [] : [{ entity_slug: 'short', legal_name: 'Payer One' }]),
      ...(arm.registration === 'shorter' ? [] : [{ entity_slug: 'whole', legal_name: arm.whole }]),
    ];
    const intent = classifyLedgerQuestion(arm.question, { now: NOW });
    const resolved = resolveRequestedPayer(intent, payerRegistry(entries));
    counts[resolved.state]++; counts.cases++;
    if (resolved.state === 'unique') assert.equal(resolved.slug, 'whole', JSON.stringify(arm));
    if (arm.registration === 'longer') assert.equal(resolved.state, 'unique', JSON.stringify(arm));
    // Registry and row mutations are synthetic fixture setup, outside ask's
    // no-write boundary. Each query must read the nonempty current snapshot.
    f.raw('UPDATE fin_entities SET legal_name=? WHERE entity_slug=?', arm.registration === 'longer' ? 'Unused Short' : 'Payer One', 'short');
    f.raw('UPDATE fin_entities SET legal_name=? WHERE entity_slug=?', arm.registration === 'shorter' ? 'Unused Whole' : arm.whole, 'whole');
    for (const actual of ['Payer One', arm.whole]) for (const exact of [false, true]) {
      f.raw('UPDATE fin_transactions SET payee=?', actual);
      const body = await f.ask(arm.question.replace('?', exact ? ', exact names only?' : '?'));
      if (resolved.state !== 'unique') uncertain(body);
      if (resolved.state === 'unique') {
        if (actual === arm.whole) assert.equal(body.ledger.found, true, JSON.stringify(arm));
        else assert.notEqual(body.ledger.found, true, JSON.stringify(arm));
      }
      counts.answers++;
    }
  }
  assert.ok(counts.unique > 0 && counts.unresolved > 0);
  assert.equal(counts.ambiguous, 0, 'contained shorter spellings yield to the complete registered name');
  assert.equal(counts.missing, 0, 'known fragments cannot certify absence for an unregistered longer selector');
  t.diagnostic(JSON.stringify(counts));
});
