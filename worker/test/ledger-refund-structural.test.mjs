import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { total, displayFigures } from '../../eval/fast-loop/money-oracle.mjs';
import { readdirSync } from 'node:fs';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const QUERY = 'Could you retrieve spending in the category software last month after refunds?';
const TEXTS = ['Not a Store refund', 'This credit is not a software refund', 'No software refund was issued',
  'Store refund without receipt', 'Store deposit', 'Credit adjustment', 'Refund', 'Ordinary receipt'];

function setup(t) {
  const f = ledgerFixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('offline only'));
  f.env.ANTHROPIC_API_KEY = 'synthetic-test-value';
  f.put = (id, { cents, direction = 'inflow', date = '2026-10-05', payee = null,
    description = 'Store credit', state = 'confirmed' }) => {
    f.raw('DELETE FROM fin_transactions WHERE txn_uid=?', id);
    f.add(id, description, payee, { cents, direction, date });
    f.raw("UPDATE fin_transactions SET category='software',category_basis_state=? WHERE txn_uid=?", state, id);
  };
  f.read = async (question = QUERY, { kind = 'category', vendor = 'software', vendors = null, accountHint = null, periods = [{ type: 'last_month' }], now = NOW } = {}) => {
    const before = f.calls.length, changes = f.first('SELECT total_changes() n').n;
    let model = 0;
    const response = await withLedgerAnswer({ env: f.env, question, now, grantScope: { all: true },
      scopePrincipalKind: 'owner', callLLM: async () => {
        model++;
        return { content: [{ type: 'text', text: JSON.stringify({ ambiguous: false, unanswered_part: null,
          intents: periods.map((period, index) => ({ kind, direction: 'outflow', count: null, vendor_text: vendors?.[index] || vendor,
            account_hint: accountHint, amount_text: null, date_text: null, period })) }) }] };
      } }, () => assert.fail('ledger decision must be reached'));
    const body = await response.json();
    assert.equal(model, 1);
    assert.ok(f.calls.slice(before).some(sql => /JOIN fin_transactions/.test(sql)), 'real transaction reader reached');
    assert.equal(f.first('SELECT total_changes() n').n, changes, 'read-only answer');
    assert.ok(body.ledger, 'category decision reached');
    // Model readings deliberately retain a clarification even when the
    // returned ledger amount is proved. Check that contract independently.
    assert.equal(body.intent_outcome, 'clarify');
    assert.equal(body.evidence_gate.complete, false);
    assert.equal(body.evidence_gate.partial, true);
    return body;
  };
  return f;
}

// Closed-world release contract: matching can nominate a credit, never deduct it.
function withheld(body, gross) {
  assert.equal(String(body.ledger.total_minor), String(gross), 'covered gross control reached');
  assert.equal(body.ledger.net_expense_minor, undefined, 'no subtraction in this release');
  assert.equal(body.ledger.refund_minor, undefined, 'no inferred refund amount');
  assert.equal(body.ledger.net_refunds_unavailable, true, 'refund decision reached');
  assert.equal(body.ledger.amount_basis, 'gross_before_refunds');
  assert.match(body.answer, /cannot confirm spending after refunds/i);
  assert.ok(displayFigures(body.answer).some(fig => fig.cents === String(gross)), 'oracle gross rendered');
}
function listed(body, descriptions) {
  const candidates = body.ledger.possible_refunds || [];
  assert.equal(candidates.length, descriptions.length, 'every candidate listed once');
  assert.equal(new Set(candidates.map(c => c.n)).size, candidates.length, 'distinct candidate citations');
  for (const description of descriptions) {
    const item = candidates.find(c => c.bank_text === description);
    assert.ok(item, 'candidate not listed: ' + description);
    const ref = body.citations.find(c => c.n === item.n);
    assert.ok(ref && body.answer.includes('[' + item.n + ']'), 'candidate cited');
    assert.equal(item.amount_minor, ref.amount_minor);
    assert.equal(item.posted_on, ref.posted_on);
    assert.equal(item.account_mask, ref.account_mask);
    assert.equal(item.label, 'possible refund, not subtracted');
    assert.ok(body.answer.includes('"' + description + '"'), 'bank text quoted');
    assert.ok(body.answer.includes(ref.title.split(' on ').at(-1)), 'candidate date printed');
    assert.ok(body.answer.includes(item.account_mask), 'candidate account printed');
    assert.ok(displayFigures(body.answer).some(fig => fig.cents === String(item.amount_minor)), 'candidate amount printed');
  }
}
const ordinaryQuery = 'Could you retrieve spending last month after refunds?';
const ordinaryOptions = { kind: 'merchant', vendor: 'refunds' };
function addOwnedAccount(f, kind = 'savings', label = 'Store One') {
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,basis_state,recorded_at)
    VALUES ('other-account','owner',?,?, '5678',?,'manual','owner_stated','confirmed','2026-10-12T12:00:00Z')`,
    kind, ['card', 'loan'].includes(kind) ? 'liability' : 'asset', label);
  f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
    VALUES ('other-account','complete','2024-01-01','2026-10-31','2026-10-12T12:00:00Z','owner_stated','confirmed','2026-10-12T12:00:00Z')`);
}
for (const ordinary of [false, true]) {
  const route = ordinary ? 'ordinary' : 'category';
  const read = f => ordinary ? f.read(ordinaryQuery, ordinaryOptions) : f.read();
  for (const description of [...TEXTS, 'Refund declined by store', 'Refund never issued', 'Refund request rejected',
    'Refund pending approval', 'Not eligible for any software refund', 'Chargeback request denied', 'Dispute adjustment code Z', 'Returned purchase'])
  test(route + ': R0/S7 wording and payee evidence only discloses: ' + description, async t => {
    const f = setup(t);
    f.put('charge', { cents: 113, direction: 'outflow', date: '2026-10-04', payee: 'Store One' });
    f.put('credit', { cents: 37, payee: 'Store One', description });
    const gross = await f.read(QUERY.replace(' after refunds', ''));
    assert.equal(gross.ledger.total_minor, 113, 'green exact gross control');
    assert.equal(gross.ledger.complete, true);
    const body = await read(f); withheld(body, 113); listed(body, [description]);
  });
  test(route + ': R1 B1 same-amount card payment collision never lists payment as refund', async t => {
    const f = setup(t); addOwnedAccount(f, 'card', 'Charge account');
    f.put('charge', { cents: 211, direction: 'outflow', date: '2026-10-02', payee: 'Payment' });
    f.raw("UPDATE fin_transactions SET account_slug='other-account' WHERE txn_uid='charge'");
    f.put('refund', { cents: 37, payee: 'Payment', description: 'Credit adjustment' });
    f.raw("UPDATE fin_transactions SET account_slug='other-account' WHERE txn_uid='refund'");
    const green = await read(f); withheld(green, 211); listed(green, ['Credit adjustment']);
    f.put('payment-out', { cents: 37, direction: 'outflow', description: 'Payment to card 5678' });
    f.put('payment-in', { cents: 37, payee: 'Payment', description: 'Payment thank you' });
    f.raw("UPDATE fin_transactions SET account_slug='other-account' WHERE txn_uid='payment-in'");
    const collision = await read(f); withheld(collision, 211);
    listed(collision, ['Credit adjustment']);
    assert.doesNotMatch(collision.answer, /possible refund, not subtracted[^\n]*Payment thank you/);
    assert.equal(collision.ledger.own_account_payments.total_minor, 37, 'payment rule reached');
    f.raw("DELETE FROM fin_transactions WHERE txn_uid='refund'");
    const paired = await read(f); withheld(paired, 211); listed(paired, []);
    assert.equal(paired.ledger.own_account_payments.total_minor, 37, 'unique payment green control');
  });
  test(route + ': R0 proved own transfer stays in transfer rules', async t => {
    const f = setup(t); addOwnedAccount(f);
    f.put('charge', { cents: 113, direction: 'outflow', date: '2026-10-04', payee: 'Store One' });
    f.put('credit', { cents: 37, payee: 'Store One', description: 'Credit adjustment' });
    const green = await read(f); withheld(green, 113); listed(green, ['Credit adjustment']);
    f.raw("UPDATE fin_transactions SET description='Transfer from savings 5678' WHERE txn_uid='credit'");
    f.put('transfer-out', { cents: 37, direction: 'outflow', description: 'Transfer to checking 1234' });
    f.raw("UPDATE fin_transactions SET account_slug='other-account' WHERE txn_uid='transfer-out'");
    const proof = await withLedgerAnswer({ env: f.env, question: 'Show transfers last month', now: NOW,
      grantScope: { all: true }, scopePrincipalKind: 'owner' }, () => assert.fail('transfer decision reached'));
    assert.equal((await proof.json()).ledger.total_minor, 37, 'transfer positively proved');
    const body = await read(f); withheld(body, 113); listed(body, []);
  });
  for (const description of ['Loan disbursement', 'Loan disbursement from loan 5678', 'Loan advance from loan 9999',
    'Transfer from savings 9999', 'Payment from card 9999', 'Payment from loan 9999', 'Account adjustment savings 5678'])
  test(route + ': R1 B2 possible movement never listed as refund: ' + description, async t => {
    const f = setup(t); addOwnedAccount(f, 'loan', 'Lending unit');
    f.put('charge', { cents: 211, direction: 'outflow', date: '2026-10-02', payee: 'Store One' });
    f.put('refund', { cents: 37, payee: 'Store One', description: 'Store refund' });
    const green = await read(f); withheld(green, 211); listed(green, ['Store refund']);
    f.put('loan-out', { cents: 83, direction: 'outflow', description: 'Loan disbursement to checking 1234' });
    f.raw("UPDATE fin_transactions SET account_slug='other-account' WHERE txn_uid='loan-out'");
    f.put('movement', { cents: 83, payee: 'Store One', description });
    const body = await read(f); withheld(body, 211); listed(body, ['Store refund']);
  });
  test(route + ': R1 B3 unrelated owned label cannot hide a possible refund', async t => {
    const f = setup(t);
    f.put('charge', { cents: 113, direction: 'outflow', date: '2026-10-04', payee: 'Store One' });
    f.put('credit', { cents: 37, payee: 'Store One', description: 'Returned purchase' });
    const green = await read(f); withheld(green, 113); listed(green, ['Returned purchase']);
    addOwnedAccount(f);
    const body = await read(f); withheld(body, 113); listed(body, ['Returned purchase']);
  });
  test(route + ': R0 M1 historical uncertainty and shared capacity never authorize net', async t => {
    const f = setup(t);
    f.put('charge', { cents: 113, direction: 'outflow', date: '2026-09-28', payee: 'Store One' });
    f.put('old-credit', { cents: 100, date: '2026-09-29', payee: 'Store One' });
    for (const cents of [13, 37]) for (const state of ['confirmed', 'proposed']) {
      f.raw("UPDATE fin_transactions SET basis_state=? WHERE txn_uid='old-credit'", state);
      f.put('credit', { cents, payee: 'Store One', description: 'Credit adjustment' });
      const body = await read(f); withheld(body, 0); listed(body, ['Credit adjustment']);
    }
  });
  test(route + ': R0 partial, multiple, over-capacity and same-day credits all remain candidates', async t => {
    const f = setup(t);
    f.put('charge', { cents: 113, direction: 'outflow', date: '2026-10-04', payee: 'Store One' });
    f.put('credit', { cents: 37, payee: 'Store One', description: 'Credit adjustment' });
    for (const cents of [76, 77]) {
      f.put('credit-two', { cents, payee: 'Store One', description: 'Store refund' });
      const body = await read(f); withheld(body, 113); listed(body, ['Credit adjustment', 'Store refund']);
    }
  });
}
test('640 generated refund ledgers: never subtracted, every candidate cited, independent gross oracle', async t => {
  const f = setup(t);
  let state = 20261107, candidates = 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  for (let i = 0; i < 640; i++) {
    f.raw('DELETE FROM fin_transactions');
    const shape = i % 16, charge = 100 + next() % 100000, partial = 1 + next() % (charge - 1);
    const description = TEXTS[(i >>> 4) % TEXTS.length];
    let credits = [partial], chargeDate = '2026-10-04', payee = 'Store One';
    if (shape === 1) payee = 'Other Store';
    if (shape === 2) chargeDate = '2026-07-07';
    if (shape === 3) chargeDate = '2026-07-06';
    if (shape === 4) chargeDate = '2026-10-06';
    if (shape === 5) credits = [charge];
    if (shape === 6) credits = [charge + 1];
    if (shape === 7) credits = [partial, charge - partial];
    if (shape === 8) credits = [partial, charge - partial + 1];
    if ([9, 10, 11].includes(shape)) payee = null; // adapters supply no provider refund type
    if (shape === 12) payee = ' STORE ONE ';
    if (shape === 13) chargeDate = '2026-10-05';
    if (shape === 14) chargeDate = '2026-09-30';
    if (shape === 15) chargeDate = '2026-09-28';
    f.put('charge', { cents: charge, direction: 'outflow', date: chargeDate, payee: 'Store One' });
    if (shape === 15) {
      f.put('old-credit', { cents: charge - partial + 1, date: '2026-09-29', payee: 'Store One', description });
      f.raw("UPDATE fin_transactions SET category='travel' WHERE txn_uid='old-credit'");
    }
    const descriptions = credits.map((cents, j) => description + ' item ' + j);
    for (const [j, cents] of credits.entries()) f.put('credit-' + j, { cents, payee, description: descriptions[j] });
    const body = await f.read(), gross = total([chargeDate.startsWith('2026-10') ? String(charge) : '0']);
    withheld(body, gross); listed(body, descriptions); candidates += credits.length;
  }
  assert.equal(candidates, 720, 'nonempty candidate population reached');
  console.log(JSON.stringify({ refund_property: 640, subtractions: 0, candidates_listed: candidates, candidates, wrong_figures: 0 }));
});
test('ordinary zero-candidate reading withholds a net while gross-only reading remains exact', async t => {
  const f = setup(t);
  f.put('charge', { cents: 113, direction: 'outflow', date: '2026-10-04', payee: 'Store One' });
  const green = await f.read(QUERY.replace(' after refunds', ''));
  assert.equal(green.ledger.total_minor, 113);
  assert.equal(green.ledger.complete, true);
  const body = await f.read(ordinaryQuery, ordinaryOptions); withheld(body, 113); listed(body, []);
});
for (const basis of ['text', 'payee', 'amount']) test('ordinary candidate nominated by ' + basis + ' is listed once', async t => {
  const f = setup(t);
  f.put('charge', { cents: 113, direction: 'outflow', date: '2026-10-04', payee: 'Store One' });
  f.put('credit', { cents: basis === 'amount' ? 113 : 37, payee: basis === 'payee' ? ' STORE ONE ' : 'Other Store',
    description: basis === 'text' ? 'Refund declined' : 'Credit adjustment' });
  const body = await f.read(ordinaryQuery, ordinaryOptions); withheld(body, 113);
  listed(body, [basis === 'text' ? 'Refund declined' : 'Credit adjustment']);
});
test('R0 later-month credit is disclosed only in its own period', async t => {
  const f = setup(t);
  f.put('charge', { cents: 113, direction: 'outflow', date: '2026-10-30', payee: 'Store One' });
  f.put('credit', { cents: 37, date: '2026-11-02', payee: 'Store One', description: 'Refund' });
  const october = await f.read(); withheld(october, 113); listed(october, []);
  f.raw("UPDATE fin_account_coverage SET covered_to='2026-11-30'");
  const november = await f.read(QUERY, { now: Date.parse('2026-12-06T12:00:00Z') });
  withheld(november, 0); listed(november, ['Refund']);
});
test('multi-operand refund candidates retain rebased citations and withhold differences', async t => {
  const f = setup(t);
  for (const [id, cents, direction, payee] of [['charge', 100, 'outflow', 'Store One'], ['credit', 25, 'inflow', 'Store One'],
    ['other-charge', 113, 'outflow', 'Store Two'], ['other-credit', 37, 'inflow', 'Store Two']])
    f.put(id, { cents, direction, payee, description: id + ' refund record' });
  f.raw("UPDATE fin_transactions SET category='supplies' WHERE txn_uid IN ('other-charge','other-credit')");
  const body = await f.read('Could you retrieve spending in the category software and in the category supplies for October 2026 after refunds?',
    { vendors: ['software', 'supplies'], periods: Array(2).fill({ type: 'between', from: '2026-10-01', to: '2026-10-31' }) });
  assert.equal(body.ledger.parts.length, 2, 'both nonempty operands reached');
  assert.deepEqual(body.ledger.parts.map(p => p.total_minor), [100, 113]);
  assert.ok(body.ledger.parts.every(p => p.net_expense_minor == null));
  const second = body.ledger.parts[1];
  assert.equal(second.net_refunds_unavailable, true);
  assert.equal(second.possible_refunds.length, 1);
  const ref = body.citations.find(c => c.n === second.possible_refunds[0].n);
  assert.equal(ref.amount_minor, 37, 'rebased citation stays in its operand');
  assert.ok(body.answer.includes('[' + ref.n + ']'));
});
test('named merchant net request lists its candidate with exact gross and citation', async t => {
  const f = setup(t);
  f.put('charge', { cents: 113, direction: 'outflow', date: '2026-10-04', payee: 'Store One' });
  f.put('credit', { cents: 37, payee: 'Store One', description: 'Store refund' });
  const body = await f.read('Could you retrieve Store One spending last month after refunds?', { kind: 'merchant', vendor: 'Store One' });
  withheld(body, 113); listed(body, ['Store refund']);
});
for (const kind of ['card', 'loan']) test('bare payment acknowledgement on ' + kind + ' is not a refund candidate', async t => {
  const f = setup(t); addOwnedAccount(f, kind, 'Charge account');
  f.put('charge', { cents: 113, direction: 'outflow', date: '2026-10-04', payee: 'Store One' });
  f.put('candidate', { cents: 37, payee: 'Store One', description: 'Store refund' });
  const green = await f.read(); withheld(green, 113); listed(green, ['Store refund']);
  f.put('payment', { cents: 37, payee: 'Store One', description: 'Payment' });
  f.raw("UPDATE fin_transactions SET account_slug='other-account' WHERE txn_uid='payment'");
  const body = await f.read(); withheld(body, 113); listed(body, ['Store refund']);
});
test('unconfirmed expense membership cannot hide a possible category refund', async t => {
  const f = setup(t);
  f.put('charge', { cents: 113, direction: 'outflow', date: '2026-10-04', payee: 'Store One' });
  f.put('credit', { cents: 37, payee: 'Store One', description: 'Store refund' });
  const green = await f.read(); withheld(green, 113); listed(green, ['Store refund']);
  f.put('unknown-expense', { cents: 3, direction: 'outflow', state: 'proposed' });
  const body = await f.read();
  assert.equal(body.ledger.confirmed_category_subtotal_minor, 113, 'confirmed subtotal decision reached');
  assert.equal(body.ledger.net_expense_minor, undefined);
  assert.equal(body.ledger.net_refunds_unavailable, true);
  listed(body, ['Store refund']);
});
test('release schema remains 61 without a provider-type migration', t => {
  const f = setup(t);
  assert.equal(f.first('SELECT schema_version FROM install_state').schema_version, 61);
  const files = readdirSync(new URL('../../migrations/d1/', import.meta.url)).filter(f => f.endsWith('.sql'));
  assert.equal(Math.max(...files.map(f => Number(f.slice(0, 4)))), 61);
  assert.ok(!f.rows('PRAGMA table_info(fin_transactions)').some(column => column.name === 'source_transaction_type'));
});
test('description-only merchant refusal retains the closed-world refund candidate disclosure', async t => {
  const f = setup(t);
  f.put('charge', { cents: 113, direction: 'outflow', date: '2026-10-04', payee: null, description: 'Store One purchase' });
  const options = { kind: 'merchant', vendor: 'Store One' };
  const question = 'Could you retrieve charges at Store One last month';
  const green = await f.read(question + '?', options);
  assert.equal(green.ledger.match_basis, 'possible', 'description-only decision reached');
  assert.equal(green.ledger.possible_match_count, 1, 'nonempty possible charge control');
  f.put('credit', { cents: 37, date: '2026-10-05', payee: 'Store One', description: 'Store refund' });
  const body = await f.read(question + ' after refunds?', options);
  assert.equal(body.ledger.match_basis, 'possible');
  assert.equal(body.ledger.total_minor == null, true, 'description cannot certify a store total');
  assert.equal(body.ledger.net_expense_minor, undefined, 'no subtraction authority');
  assert.equal(body.ledger.net_refunds_unavailable, true);
  assert.ok(Array.isArray(body.ledger.possible_refunds), 'candidate list survives early merchant return');
  assert.deepEqual(body.ledger.possible_refunds.map(row => row.amount_minor), [37], 'candidate survives early merchant return');
  assert.equal(body.ledger.possible_refunds[0].label, 'possible refund, not subtracted');
  assert.match(body.answer, /possible refund, not subtracted/);
  const n = body.ledger.possible_refunds[0].n;
  assert.equal(body.citations.find(ref => ref.n === n).amount_minor, 37, 'candidate citation reached');
});
