import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { accountKindIdentity } from '../src/lib/fin-account-kinds.js';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { readFileSync } from 'node:fs';

function paymentFixture(t, kind = 'loan') {
  const f = ledgerFixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,basis_state,recorded_at)
    VALUES ('liability-unit','owner','other','liability','2222','Liability Unit','manual','owner_stated','confirmed',?)`, NOW);
  const account = f.first("SELECT * FROM fin_accounts WHERE account_slug='liability-unit'");
  f.raw(`INSERT INTO fin_account_kind_reviews (tenant_id,account_id,identity_json,kind,role,reviewer,source,reviewed_at,review_plan_hash)
    VALUES (?,?,?,?,'liability','owner','owner_account_kind',?,?)`, account.tenant_id, account.id,
  accountKindIdentity(account), kind, NOW, 'a'.repeat(64));
  f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
    VALUES ('liability-unit','complete','2024-01-01','2026-10-31',?,'owner_stated','confirmed',?)`, NOW, NOW);
  f.put = (id, cents, { date = '2026-10-05', category = 'GENERAL_SERVICES', description = 'Service Unit', payee = 'Service Unit', direction = 'outflow' } = {}) => {
    f.add(id, description, payee, { cents, date, direction });
    f.raw('UPDATE fin_transactions SET category=?,category_basis_state=? WHERE txn_uid=?', category, category ? 'confirmed' : null, id);
  };
  f.reached = async (question, answerPath = withLedgerAnswer) => {
    const before = f.calls.length;
    const changes = f.first('SELECT total_changes() n').n;
    const response = await answerPath({ env: f.env, question, now: NOW,
      grantScope: { all: true }, scopePrincipalKind: 'owner' }, () => assert.fail('unexpected document fallback'));
    const body = await response.json();
    assert.ok(f.calls.slice(before).some(sql => /JOIN fin_transactions/.test(sql)), 'real nonempty ledger decision reached');
    assert.ok(f.first('SELECT count(*) n FROM fin_transactions').n > 0);
    assert.ok(body.ledger, 'ledger answer reached');
    assert.equal(f.documentCalls, 0, 'fallback cannot hide a refusal');
    assert.equal(f.first('SELECT total_changes() n').n, changes, 'answer is read-only');
    return body;
  };
  return f;
}

test('unconnected card payment is excluded from the monthly spending summary', async t => {
  const f = paymentFixture(t);
  f.put('ordinary', 164331);
  const green = await f.reached('What did I spend this month, and on what?');
  assert.equal(green.ledger.total_minor, 164331);
  f.put('card-payment', 2500, { category: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', payee: 'Card Payment Unit' });
  const body = await f.reached('What did I spend this month, and on what?');
  assert.equal(body.ledger.total_minor, 164331);
  assert.match(body.answer, /payments to loans and cards|payments to your own loan\/card accounts/i);
  assert.equal((body.ledger.payment_exclusions || body.ledger.own_account_payments).total_minor, 2500);
});

const readers = [
  ['summary', 'What did I spend this month, and on what?', b => b.ledger.total_minor],
  ['category', 'How much did I spend by category in October 2026?', b => b.ledger.total_minor],
  ['income category', 'How much income by category in October 2026?', b => b.ledger.total_minor],
  ['merchant', 'How much did I spend by merchant in October 2026?', b => b.ledger.total_minor],
  ['income merchant', 'How much income by merchant in October 2026?', b => b.ledger.total_minor],
  ['largest', 'What were my ten largest expenses in October 2026?', b => b.ledger.lead_rows.reduce((sum, row) => sum + row.amount_minor, 0)],
  ['deposits', 'What were my ten largest deposits in October 2026?', b => b.ledger.lead_rows.reduce((sum, row) => sum + row.amount_minor, 0)],
  ['recurring', 'What recurring subscriptions am I paying for, and how much per month?', b => b.ledger.monthly_total_minor],
  ['inout', 'How much money came in and went out in October 2026?', b => b.ledger.accounts[0].debits_minor],
  ['inflow', 'How much money came in during October 2026?', b => b.ledger.combined_inflow_minor],
];

function assertReading(body, name, amount, credit, paymentTotal, paymentCount, incomingPayment = 0) {
  const reader = readers.find(([label]) => label === name);
  const expected = name === 'inflow' ? credit + incomingPayment : /income|deposits/.test(name) ? credit : amount;
  if (name === 'inflow') assert.equal(body.ledger.lead_accounts.reduce((sum, row) => sum + row.credits_minor, 0), credit,
    'ordinary alternate excludes receiving payments while gross retains them');
  assert.equal(reader[2](body), expected, `${name}: gross inflow and ordinary measures retain their separate membership`);
  if (name === 'largest') {
    assert.equal(body.ledger.if_own_transfers.total_minor, amount, 'R1 conditional ranking excludes payments');
    assert.deepEqual(body.ledger.rows.map(row => row.amount_minor), [amount], 'R1 alternate list excludes payments');
    assert.equal(body.ledger.if_own_transfers.accounts[0].debits_minor, amount, 'R1 conditional debits exclude payments');
    assert.equal(body.ledger.if_own_transfers.accounts[0].credits_minor, credit, 'R1 conditional credits exclude receiving payments');
  }
  if (!paymentCount) {
    assert.equal(body.ledger.payment_exclusions, undefined, 'opposite-direction rows do not contribute to this reader');
    assert.equal(body.ledger.own_account_payments?.count || 0, 0);
    return;
  }
  const evidence = body.ledger.payment_exclusions || body.ledger.own_account_payments;
  assert.equal(evidence?.total_minor, paymentTotal, `${name}: every excluded cent is disclosed`);
  assert.equal(evidence.count, paymentCount, `${name}: every excluded posting is disclosed`);
  if (body.ledger.payment_exclusions) {
    assert.equal(evidence.rows.length, paymentCount);
    assert.equal(new Set(evidence.rows.map(row => row.n)).size, paymentCount);
  } else assert.ok(['summary', 'largest'].includes(name), 'only established expense summaries use the original disclosure');
  assert.match(body.answer, /payments to loans and cards|payments to your own loan\/card accounts/i);
  if (name === 'recurring') assert.deepEqual(body.ledger.recurring.map(row => row.merchant), ['service unit']);
  if (/category|merchant|summary/.test(name)) {
    for (const group of [...(body.ledger.groups || []), ...(body.ledger.category_groups || [])])
      assert.equal(group.total_minor, expected, `${name}: group contains only ordinary rows`);
  }
}

// Money out (S9F): the money in/out totals keep a bank-coded payment in money
// out when no connected account could receive it, and withhold money out when
// one could (a liability of the payment's kind, or an unconfirmed kind). This
// oracle reads only the generated parameters, never a product classifier.
function moneyOutDisposition(category, liabilityKind) {
  const card = /credit_card/i.test(category);
  const receivers = card ? ['card', 'other'] : ['loan', 'line_of_credit', 'other'];
  return receivers.includes(liabilityKind) ? 'withheld' : 'included';
}
function assertMoneyOutReading(body, amount, payment, disposition) {
  if (disposition === 'withheld') {
    assert.equal(body.ledger.reason, 'money_out_destination_unconfirmed', 'inout: withheld, never double counted');
    assert.equal(body.ledger.accounts.every(account => account.debits_minor === undefined), true);
    assert.match(body.answer, /not counted, money out withheld: possibly a (?:card|loan) payment \(bank payment code\) to a connected account/);
    return;
  }
  assert.equal(body.ledger.accounts[0].debits_minor, amount + payment, 'inout: the payment left the connected accounts');
  const included = body.ledger.possible_payments.filter(row => row.included_in_total);
  assert.deepEqual(included.map(row => row.amount_minor), [payment]);
  assert.ok(body.citations.some(ref => ref.n === included[0].n && ref.amount_minor === payment));
  assert.match(body.answer, /included in money out above, possibly a (?:card|loan) payment \(bank payment code\) \(counterpart not proved\)/);
}

test('640 generated reader cases exclude and disclose bank-coded and owned-liability payments', async t => {
  let seed = 0x427c0de;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  let cases = 0;
  for (let i = 0; i < 64; i++) {
    const f = paymentFixture(t, ['loan', 'card', 'line_of_credit', 'other'][Math.floor(i / 4) % 4]);
    f.raw("UPDATE fin_accounts SET account_kind=?,balance_role=? WHERE account_slug='fixture-account'",
      ['checking', 'savings', 'card'][i % 3], i % 3 === 2 ? 'liability' : 'asset');
    const amount = 100 + next() % 90000, credit = 100 + next() % 90000;
    const payment = 1 + next() % 95000;
    const owned = i % 4 === 0;
    const direction = i % 3 === 0 && !owned ? 'inflow' : 'outflow';
    const categories = ['LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'loan_payments_personal_loan_payment', 'CREDIT_CARD_PAYMENT'];
    for (const date of ['2026-08-05', '2026-09-05', '2026-10-05']) {
      f.put(`service-${date}`, amount, { date });
      f.put(`receipt-${date}`, credit, { date, direction: 'inflow', payee: 'Receipt Unit' });
    }
    // An unchanged, nonempty green ledger reaches every reader before the
    // payment is added. The exclusion assertions cannot pass on an empty plan.
    for (const [name, question, read] of readers) {
      const green = await f.reached(question);
      assert.equal(read(green), /income|deposits|inflow/.test(name) ? credit : amount, `${name}: nonpayment control`);
    }
    for (const date of ['2026-08-05', '2026-09-05', '2026-10-05']) {
      const id = `payment-${date}`;
      f.put(id, payment, { date, direction, category: owned ? null : categories[i % categories.length],
        description: owned ? ['TRANSFER TO ACCOUNT 2222', 'AUTOPAY TO ACCOUNT 2222', 'TRANSFER FROM ACCOUNT 1234 TO ACCOUNT 2222', 'Repayment'][Math.floor(i / 4) % 4] : 'Payment Unit',
        payee: owned ? Math.floor(i / 4) % 4 === 3 ? 'account 2222' : null : 'Payment Unit' });
      if (!owned) f.raw('UPDATE fin_transactions SET category_basis_state=? WHERE txn_uid=?', [null, 'proposed', 'confirmed'][i % 3], id);
    }
    const liabilityKind = ['loan', 'card', 'line_of_credit', 'other'][Math.floor(i / 4) % 4];
    for (const [name, question] of readers) {
      const body = await f.reached(question);
      const count = name === 'summary' && direction === 'inflow'
        ? 0 : name === 'recurring' ? 3 : 1;
      if (name === 'inout' && owned) {
        // These authored endpoint descriptions have no reciprocal leg. A known account
        // identity cannot prove that this particular posting reached it.
        assert.equal(body.ledger.accounts[0].debits_minor, amount + payment);
        assert.deepEqual(body.ledger.possible_payments.map(row => [row.amount_minor, row.included_in_total]), [[payment, true]]);
        assert.match(body.answer, /included in money out above, possibly/);
      } else if (name === 'inout' && !owned && direction === 'outflow')
        assertMoneyOutReading(body, amount, payment, moneyOutDisposition(categories[i % categories.length], liabilityKind));
      else assertReading(body, name, amount, credit, payment * count, count, direction === 'inflow' ? payment : 0);
      cases++;
    }
  }
  assert.equal(cases, 640);
});

async function mutatedAnswer(from, to, analysisMutation) {
  const answerUrl = new URL('../src/lib/ledger-answer.js', import.meta.url);
  let source = readFileSync(answerUrl, 'utf8');
  if (from) {
    assert.equal(source.split(from).length - 1, 1, 'exactly one mutation decision point');
    source = source.replace(from, to);
  }
  if (analysisMutation) {
    const url = new URL('../src/lib/ledger-analysis.js', import.meta.url);
    let analysis = readFileSync(url, 'utf8');
    assert.equal(analysis.split(analysisMutation[0]).length - 1, 1);
    analysis = analysis.replace(...analysisMutation);
    analysis = analysis.replace(/from (["'])(\.\/[^"'\n]+)\1/g, (_, quote, path) => `from ${JSON.stringify(new URL(path, url).href)}`);
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(analysis).toString('base64')}`;
    source = source.replace('"./ledger-analysis.js"', JSON.stringify(moduleUrl));
  }
  source = source.replace(/from "(\.\/[^"\n]+)"/g, (_, path) => `from ${JSON.stringify(new URL(path, answerUrl).href)}`);
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).withLedgerAnswer;
}

for (const [name, readerName, from, to, analysisMutation] of [
  ['predicate dropped from recurring', 'recurring', 'const excludePayments = paymentReader && intent.kind !== "expense_summary" && !(intent.kind === "largest" && intent.direction === "outflow");', 'const excludePayments = paymentReader && !["largest", "expense_summary", "recurring"].includes(intent.kind);'],
  ['predicate dropped from category grouping', 'category', 'const excludePayments = paymentReader && intent.kind !== "expense_summary" && !(intent.kind === "largest" && intent.direction === "outflow");', 'const excludePayments = paymentReader && !["largest", "expense_summary", "category"].includes(intent.kind);'],
  ['unconnected card counted', 'summary', null, null, ['if (bankKind) return bankKind;', 'if (false && bankKind) return bankKind;']],
  ['exclusion not disclosed', 'recurring', 'result.answer += paymentDisclosure;', 'result.answer += "";'],
]) test(`mutation killed: ${name}`, async t => {
  // S7 and S8 independently enforce these memberships. The injected attack
  // removes both defenses, while all production protections remain active.
  const extra = name === 'predicate dropped from recurring'
    ? ['|LOAN_PAYMENTS(?:_|$)', '']
    : name === 'predicate dropped from category grouping'
      ? ['if (bankKind) return bankKind;', 'if (false && bankKind) return bankKind;'] : analysisMutation;
  const mutant = await mutatedAnswer(from, to, extra), f = paymentFixture(t);
  for (const date of ['2026-08-05', '2026-09-05', '2026-10-05']) f.put(`service-${date}`, 12345, { date });
  const [, question, read] = readers.find(([label]) => label === readerName);
  assert.equal(read(await f.reached(question, mutant)), 12345, 'mutant keeps the nonpayment green control');
  for (const date of ['2026-08-05', '2026-09-05', '2026-10-05']) f.put(`payment-${date}`, 2500,
    { date, category: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', payee: 'Payment Unit' });
  const count = readerName === 'recurring' ? 3 : 1;
  assertReading(await f.reached(question), readerName, 12345, 0, count * 2500, count);
  const changed = await f.reached(question, mutant);
  assert.throws(() => assertReading(changed, readerName, 12345, 0, count * 2500, count), assert.AssertionError,
    'the same real-reader oracle rejects the executed mutant');
});

test('reviewed own-loan payment cannot seed or inflate a recurring total', async t => {
  const f = paymentFixture(t);
  for (const date of ['2026-08-05', '2026-09-05', '2026-10-05']) f.put(`service-${date}`, 816369, { date });
  const question = 'What recurring subscriptions am I paying for, and how much per month?';
  assert.equal((await f.reached(question)).ledger.monthly_total_minor, 816369);
  for (const date of ['2026-08-05', '2026-09-05', '2026-10-05']) f.put(`payment-${date}`, 70318,
    { date, category: 'LOAN_PAYMENTS', description: 'TRANSFER TO LOAN ACCOUNT 2222', payee: null });
  const body = await f.reached(question);
  assert.equal(body.ledger.monthly_total_minor, 816369);
  assert.equal(body.ledger.payment_exclusions.total_minor, 210954);
  assert.match(body.answer, /payments to loans and cards/i);
});

test('receiving liability legs cannot become income under unary or bilateral references', async t => {
  for (const kind of ['loan', 'card', 'line_of_credit', 'other']) for (const bilateral of [false, true]) {
    await t.test(`${kind}, bilateral=${bilateral}`, async t => {
      const f = paymentFixture(t, kind);
      f.put('ordinary-receipt', 12345, { direction: 'inflow' });
      const question = 'How much money came in during October 2026?';
      assert.equal((await f.reached(question)).ledger.combined_inflow_minor, 12345);
      f.put('receiving-payment', 2500, { direction: 'inflow', category: null, payee: null,
        description: bilateral ? 'TRANSFER FROM ACCOUNT 1234 TO ACCOUNT 2222' : 'TRANSFER FROM ACCOUNT 1234' });
      f.raw("UPDATE fin_transactions SET account_slug='liability-unit' WHERE txn_uid='receiving-payment'");
      const body = await f.reached(question);
      assert.equal(body.ledger.combined_inflow_minor, 14845, 'recorded gross inflow retains receiving repayment');
      assert.equal(body.ledger.lead_accounts.reduce((sum, row) => sum + row.credits_minor, 0), 12345, 'ordinary income excludes receiving repayment');
      assert.equal(body.ledger.payment_exclusions.total_minor, 2500, 'receiving exclusion decision reached');
      assert.match(body.answer, /Payments to loans and cards/);
    });
  }
});

test('bank payment evidence takes precedence over a paired asset-transfer interpretation', async t => {
  const f = paymentFixture(t);
  f.raw("UPDATE fin_accounts SET balance_role='asset' WHERE account_slug='liability-unit'");
  f.raw("UPDATE fin_account_kind_reviews SET kind='savings',role='asset'");
  f.put('ordinary', 12345);
  const question = 'What were my ten largest expenses in October 2026 including transfers?';
  assert.equal((await f.reached(question)).ledger.lead_rows.reduce((sum, row) => sum + row.amount_minor, 0), 12345);
  f.put('payment-out', 2500, { category: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', payee: null, description: 'TRANSFER TO ACCOUNT 2222' });
  f.put('counterpart', 2500, { direction: 'inflow', category: null, payee: null, description: 'TRANSFER FROM ACCOUNT 1234' });
  f.raw("UPDATE fin_transactions SET account_slug='liability-unit' WHERE txn_uid='counterpart'");
  const body = await f.reached(question);
  assert.ok(body.ledger.candidate_transfer_count > 0, 'competing transfer interpretation reached a nonempty pair');
  assert.equal(body.ledger.lead_rows.reduce((sum, row) => sum + row.amount_minor, 0), 12345);
  assert.equal(body.ledger.own_account_payments.total_minor, 2500);
  assert.match(body.answer, /Payments to loans and cards/);
});
