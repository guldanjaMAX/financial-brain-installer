import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';

test('unconfirmed other-category row must not admit a card payment into the software subtotal', async t => {
  const f = ledgerFixture(t);
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at)
    VALUES ('card','owner','card','liability','9876','manual','owner_stated','confirmed',?)`, NOW);
  f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
    VALUES ('card','complete','2024-01-01','2026-10-31',?,'owner_stated','confirmed',?)`, NOW, NOW);
  for (const [uid, description, label, state, amount] of [
    ['purchase', 'Store purchase', 'software', 'confirmed', 100],
    ['payment', 'Transfer to card 9876', 'software', 'confirmed', 200],
    ['candidate', 'Store purchase', 'supplies', 'proposed', 3],
  ]) {
    f.add(uid, description, null, { cents: amount, direction: 'outflow' });
    f.raw('UPDATE fin_transactions SET category=?,category_basis_state=? WHERE txn_uid=?', label, state, uid);
  }
  f.env.ANTHROPIC_API_KEY = 'synthetic-test-value';
  const response = await withLedgerAnswer({ env: f.env, now: Date.parse(NOW), grantScope: { all: true }, scopePrincipalKind: 'owner',
    question: 'Could you retrieve spending in the category software for October 2026?',
    callLLM: async () => ({ content: [{ type: 'text', text: JSON.stringify({ ambiguous: false, unanswered_part: null, intents: [{
      kind: 'category', direction: 'outflow', vendor_text: 'software', count: null, account_hint: null, amount_text: null, date_text: null,
      period: { type: 'between', from: '2026-10-01', to: '2026-10-31' },
    }] }) }] }) }, () => assert.fail('no document fallback'));
  const body = await response.json();
  assert.equal(body.ledger.own_account_payments.total_minor, 200);
  assert.equal(body.ledger.own_account_payments.count, 1);
  assert.match(body.answer, /Payments to loans and cards.*\$2\.00/);
  console.log('MINIMAL_PAYMENT_WITNESS ' + JSON.stringify({ ledger: body.ledger, answer: body.answer }));
  assert.equal(body.ledger.confirmed_category_subtotal_minor ?? body.ledger.total_minor, 100,
    '100-cent expense plus 200-cent card payment must remain a 100-cent spending subtotal');
});

// Independent review population: no product membership or money helpers.
// Split purchases are represented by independently recorded allocation legs;
// the ledger schema has no parent/split-allocation field.
test('fresh category population, seed 20261106: integer cents and separate refusal counts', async t => {
  const f = ledgerFixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('offline only'));
  let state = 20261106;
  const cents = () => { state = (Math.imul(state, 1103515245) + 12345) >>> 0; return 1 + state % 99999; };
  for (const [kind, mask] of [['card', '9876'], ['loan', '8765']]) {
    f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at)
      VALUES (?,'owner',?,'liability',?,'manual','owner_stated','confirmed',?)`, kind, kind, mask, NOW);
    f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES (?,'complete','2024-01-01','2026-10-31',?,'owner_stated','confirmed',?)`, kind, NOW, NOW);
  }
  const wrong = [], refusals = [];
  let observations = 0;
  for (let i = 0; i < 280; i++) {
    const shape = i % 7;
    f.raw('DELETE FROM fin_transactions');
    const records = [];
    function add(label, extra = {}) {
      const r = { label, amount: cents(), date: '2026-10-05', direction: 'outflow',
        state: 'confirmed', description: 'Store purchase', payee: 'Store One', expense: true, ...extra };
      const uid = `row-${records.length}`;
      f.add(uid, r.description, r.payee, { cents: r.amount, date: r.date, direction: r.direction });
      f.raw('UPDATE fin_transactions SET category=?,category_basis_state=? WHERE txn_uid=?', r.label, r.state, uid);
      records.push(r);
      return uid;
    }
    add('software'); add('supplies');
    if (shape === 0) {
      const uid = add('software');
      f.raw("UPDATE fin_transactions SET category='repairs' WHERE txn_uid=?", uid);
      records.at(-1).label = 'repairs';
    }
    if (shape === 1) {
      const uid = add('software', { state: 'proposed' });
      // Confirmation in November is current evidence about an October row.
      f.raw("UPDATE fin_transactions SET category_basis_state='confirmed', recorded_at='2026-11-02T12:00:00Z' WHERE txn_uid=?", uid);
      records.at(-1).state = 'confirmed';
    }
    if (shape === 2) { add('software', { description: 'Split purchase allocation one' }); add('supplies', { description: 'Split purchase allocation two' }); }
    if (shape === 3) {
      add('software', { direction: 'inflow', description: 'Store refund', date: '2026-09-30', expense: false });
      add('software', { direction: 'inflow', description: 'Store refund', expense: false });
    }
    if (shape === 4) for (const mask of ['9876', '8765']) add('software', { description: `Transfer to ${mask === '9876' ? 'card' : 'loan'} ${mask}`, payee: null, expense: false });
    if (shape === 5) add('repairs', { payee: 'software', description: 'Software store purchase' });
    if (i % 4 === 0) add(shape === 4 ? 'supplies' : 'software', { state: 'proposed' });
    const labels = shape === 6 ? ['software', 'supplies'] : ['software'];
    const unknown = records.filter(r => r.date.startsWith('2026-10') && r.direction === 'outflow' && r.state !== 'confirmed');
    const expected = label => records.filter(r => r.date.startsWith('2026-10') && r.direction === 'outflow' && r.expense && r.state === 'confirmed' && r.label === label)
      .reduce((sum, r) => sum + BigInt(r.amount), 0n);
    for (const model of [false, true]) {
      observations++;
      const question = model ? `Could you retrieve spending in the category ${labels.join(' and in the category ')} for October 2026${shape === 3 ? ' after refunds' : ''}?`
        : labels.map(label => `How much did I spend on ${label === 'software' ? 'software' : label} in October 2026?`).join(' And ');
      f.env.ANTHROPIC_API_KEY = model ? 'synthetic-test-value' : undefined;
      const response = await withLedgerAnswer({ env: f.env, question, now: Date.parse('2026-11-06T12:00:00Z'),
        grantScope: { all: true }, scopePrincipalKind: 'owner', callLLM: async () => ({ content: [{ type: 'text', text: JSON.stringify({ ambiguous: false, unanswered_part: null,
          intents: labels.map(label => ({ kind: 'category', direction: 'outflow', count: null, vendor_text: label, account_hint: null, amount_text: null, date_text: null,
            period: { type: 'between', from: '2026-10-01', to: '2026-10-31' } })) }) }] }) }, () => Response.json({ answer: 'unavailable' }));
      const body = await response.json();
      const parts = body.ledger?.parts || [body.ledger];
      for (const [j, label] of labels.entries()) {
        const l = parts[j], id = { i, shape, model, label };
        if (!l) { refusals.push({ ...id, reason: 'no ledger part' }); continue; }
        if (shape === 4) {
          const payments = records.filter(r => !r.expense && r.direction === 'outflow');
          assert.equal(BigInt(l.own_account_payments?.total_minor ?? -1), payments.reduce((n, r) => n + BigInt(r.amount), 0n));
          assert.equal(l.own_account_payments.count, payments.length);
          assert.match(body.answer, /Payments to (?:your own loan\/card accounts|loans and cards)/);
        }
        const amount = l.confirmed_category_subtotal_minor ?? (!l.selector_unresolved ? l.total_minor : null);
        if (amount == null) refusals.push({ ...id, reason: 'no confirmed amount' });
        else if (BigInt(amount) !== expected(label)) wrong.push({ ...id, amount, expected: String(expected(label)), answer: body.answer });
        if (unknown.length && (l.unconfirmed_category_count !== unknown.length || BigInt(l.unsorted_minor ?? -1) !== unknown.reduce((n, r) => n + BigInt(r.amount), 0n) || !/left out/.test(body.answer)))
          wrong.push({ ...id, reason: 'missing or wrong exclusion disclosure', ledger: l });
        if (model && shape === 3 && !unknown.length) {
          if (l.net_expense_minor != null || !l.net_refunds_unavailable) wrong.push({ ...id, reason: 'unproved cross-month net', ledger: l });
          const credits = records.filter(r => r.direction === 'inflow' && r.date.startsWith('2026-10'));
          if (l.possible_refunds?.length !== credits.length) wrong.push({ ...id, reason: 'possible refund missing', ledger: l });
        }
      }
    }
  }
  console.log('INDEPENDENT_REVIEW ' + JSON.stringify({ seed: 20261106, cases: 280, observations, wrong_figures: wrong.length, over_refusals: refusals.length, signatures: wrong.map(({i, shape, model, label, amount, expected, reason}) => ({i, shape, model, label, amount, expected, reason})), witnesses: wrong.slice(0, 4), refusal_witnesses: refusals.slice(0, 4) }));
  assert.equal(wrong.length, 0, 'new category totals and disclosures must agree with integer oracle');
  // The paired deterministic two-category questions already refuse on the base;
  // keep them counted while this payment fix must introduce no extra refusals.
  assert.ok(refusals.length <= 80, 'over-refusals must not exceed the reviewed base count of 80');
});
