import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { accountKindIdentity } from '../src/lib/fin-account-kinds.js';
import { answerText as workerAnswerText } from '../src/lib/answer-render.js';
import { answerText as appAnswerText } from '../../frontend/src/lib/answer-render.js';

test.beforeEach(t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  t.mock.method(Date, 'now', () => Date.parse(NOW));
});
const summary = 'What did I spend this month, and on what?';
const income = 'How much money came in during October 2026?';
const total = body => body.ledger.total_minor;
const out = body => body.ledger.accounts.find(a => a.account_mask === '1234').debits_minor;
const readers = [
  ['summary', summary, total],
  ['category', 'How much did I spend by category in October 2026?', total],
  ['merchant', 'How much did I spend by merchant in October 2026?', total],
  ['totals', 'How much money came in and went out in October 2026?', out],
  ['largest', 'What were my ten largest expenses in October 2026?', b => b.ledger.lead_rows.reduce((s, r) => s + r.amount_minor, 0)],
  ['recurring', 'What recurring subscriptions am I paying for, and how much per month?', b => b.ledger.monthly_total_minor],
];
test('recurring exclusions retain the existing owner payment summary', async t => {
  const f = fixture(t);
  for (const date of ['2026-08-05', '2026-09-05', '2026-10-05']) {
    f.put('service-' + date, 1000, { date });
    f.put('payment-' + date, 2500, { date, payee: 'Card Unit',
      category: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' });
  }
  const body = await f.askReached('recurring-summary', readers[5][1]);
  assert.equal(body.ledger.monthly_total_minor, 1000);
  assert.equal(body.ledger.payment_exclusions.total_minor, 7500);
  assert.deepEqual(body.ledger.own_account_payments,
    { total_minor: 7500, count: 3, card_minor: 7500, loan_minor: 0 });
  const mutant = await reviewMutant('ledger-answer.js',
    "if (['recurring', 'category'].includes(result.ledger.kind) || intent.categorySelector) {",
    'if (false) {');
  const changed = await f.askReached('recurring-summary-mutant', readers[5][1], undefined, mutant);
  assert.throws(() => assert.deepEqual(changed.ledger.own_account_payments,
    { total_minor: 7500, count: 3, card_minor: 7500, loan_minor: 0 }), assert.AssertionError);
});
test('a paired liability receipt cannot override the outgoing bank expense category', async t => {
  const f = fixture(t);
  f.put('fee', 2500, { category: 'BANK_FEES', payee: null,
    description: 'Transfer to account 2222' });
  f.put('receiving', 2500, { account: 'liability-unit', direction: 'inflow',
    category: null, payee: null, description: 'Transfer from account 1234' });
  const body = await f.askReached('paired-expense-category', summary);
  assert.equal(body.ledger.total_minor, 2500);
  assert.equal(body.ledger.own_account_payments.count, 0);
  const mutant = await reviewMutant('ledger-analysis.js',
    'if (hasExplicitExpenseCategory(pair.out)) return null;', '/* paired fee veto removed */');
  const changed = await f.askReached('paired-expense-category-mutant', summary, undefined, mutant);
  assert.throws(() => assert.equal(changed.ledger.total_minor, 2500), assert.AssertionError);
});
test('set-aside recurring lists keep itemized payment evidence on both renderers', async t => {
  const f = fixture(t);
  for (const date of ['2026-08-05', '2026-09-05', '2026-10-05']) {
    f.put('service-' + date, 1000, { date });
    f.put('uncertain-' + date, 3000, { date, payee: 'Review Unit', category: null,
      description: 'Possible payment to account 2222' });
    f.put('payment-' + date, 2500, { date, payee: 'Card Unit',
      category: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' });
  }
  const body = await f.askReached('recurring-renderer', readers[5][1]);
  assert.equal(body.ledger.set_aside_recurring.length, 1);
  assert.equal(body.ledger.monthly_total_minor, null);
  assert.equal(body.ledger.confirmed_subtotal_minor, 1000);
  for (const render of [workerAnswerText, appAnswerText]) {
    const text = render(body);
    assert.match(text, /Payments to loans and cards.*\$75\.00/);
    for (const row of body.ledger.payment_exclusions.rows) {
      assert.ok(text.includes(`[${row.n}]`));
      assert.match(text, /payment to a card: \$25\.00/);
    }
  }
});
function fixture(t, kind = 'card', reviewed = true, answerNow = NOW) {
  const f = ledgerFixture(t);
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,basis_state,recorded_at)
    VALUES ('liability-unit','owner','other','liability','2222','Lender Unit','manual','owner_stated','confirmed',?)`, NOW);
  if (reviewed) {
    const account = f.first("SELECT * FROM fin_accounts WHERE account_slug='liability-unit'");
    f.raw(`INSERT INTO fin_account_kind_reviews (tenant_id,account_id,identity_json,kind,role,reviewer,source,reviewed_at,review_plan_hash)
      VALUES (?,?,?,?,'liability','owner','owner_account_kind',?,?)`, account.tenant_id, account.id,
      accountKindIdentity(account), kind, NOW, 'a'.repeat(64));
  }
  f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
    VALUES ('liability-unit','complete','2024-01-01','2026-10-31',?,'owner_stated','confirmed',?)`, NOW, NOW);
  f.put = (id, cents, { date = '2026-10-05', payee = 'Service Unit', description = 'Service expense', category = 'GENERAL_SERVICES', direction = 'outflow', account = 'fixture-account' } = {}) => {
    f.add(id, description, payee, { cents, date, direction });
    f.raw('UPDATE fin_transactions SET category=?,category_basis_state=?,account_slug=? WHERE txn_uid=?', category, category ? 'confirmed' : null, account, id);
  };
  f.askReached = async (label, question, intent, answerPath = withLedgerAnswer) => {
    const start = f.calls.length;
    const writes = f.first('SELECT total_changes() n').n;
    let models = 0;
    if (intent) {
      f.env.RERANK_MODEL = 'claude-haiku-4-5-20251001';
      f.env.ANTHROPIC_API_KEY = randomBytes(24).toString('hex');
    }
    const response = await answerPath({ env: f.env, question, now: answerNow,
      grantScope: { all: true }, scopePrincipalKind: 'owner',
      callLLM: async () => {
        models++;
        assert.ok(intent, 'only injected structured replies may be used');
        return { content: [{ type: 'text', text: JSON.stringify({ ambiguous: false, unanswered_part: null,
          intents: [{ direction: null, count: null, vendor_text: null, account_hint: null, amount_text: null,
            date_text: null, period: { type: 'none' }, ...intent }] }) }] };
      },
    }, gap => Response.json({ route: 'documents', gap }));
    const body = await response.json();
    assert.ok(f.calls.slice(start).some(sql => /JOIN fin_transactions/.test(sql)), 'transaction decision reached');
    assert.ok(f.first('SELECT count(*) n FROM fin_transactions').n > 0, 'nonempty fixture');
    assert.equal(f.first('SELECT total_changes() n').n, writes, 'reader stays read-only');
    if (intent) assert.equal(models, 1, 'injected intent decision reached');
    return body;
  };
  return f;
}
function ordinary(f, extra = {}) {
  for (const date of ['2026-08-05', '2026-09-05', '2026-10-05']) f.put(`ordinary-${date}`, 10000, { date, ...extra });
}
function payments(f, extra = {}) {
  for (const date of ['2026-08-05', '2026-09-05', '2026-10-05']) f.put(`payment-${date}`, 2500,
    { date, category: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', description: 'Card payment', payee: 'Payment Unit', ...extra });
}
// Money out (S9F): a bank-coded card payment whose destination is unproven,
// beside a connected reviewed card, could settle purchases already counted on
// that card. The money in/out totals withhold money out instead of guessing.
function moneyOutWithheld(b, ledger = b.ledger) {
  assert.equal(ledger.reason, 'money_out_destination_unconfirmed');
  assert.ok(ledger.possible_payments.every(row => row.destination_unconfirmed && !row.included_in_total &&
    row.connected_counterpart_masks.includes('2222')));
  assert.match(b.answer, /not counted, money out withheld: possibly a card payment \(bank payment code\) to a connected account \(your account ending 2222\)/);
}
function disclosed(b) {
  assert.match(b.answer, /payments to loans and cards|payments to your own loan\/card/i);
  const proof = b.ledger.payment_exclusions || b.ledger.own_account_payments;
  assert.ok(proof?.count > 0, 'nonempty exclusion evidence');
}

// FIX-0427-LOAN-CARD-SELECTOR-FIRST-R2: reviewed exact labels prove
// repayment, but explicit bank expense categories veto account identity.
for (const kind of ['loan', 'card'])
  for (const identity of ['label', 'directed-label', 'mask', 'directed-mask'])
    for (const category of [null, 'BANK_FEES', 'GENERAL_MERCHANDISE', 'GENERAL_SERVICES'])
      test(`R2 reviewed ${kind} ${identity} respects bank expense category: ${category}`, async t => {
        const f = fixture(t, kind); ordinary(f);
        if (identity.includes('label')) {
          f.raw("UPDATE fin_accounts SET mask=NULL WHERE account_slug='liability-unit'");
          const account = f.first("SELECT * FROM fin_accounts WHERE account_slug='liability-unit'");
          f.raw('UPDATE fin_account_kind_reviews SET identity_json=? WHERE account_id=?', accountKindIdentity(account), account.id);
        }
        const green = await f.askReached('reviewed-expense-green', summary);
        assert.equal(total(green), 10000);
        assert.equal(green.ledger.own_account_payments.count, 0);
        const locator = identity.includes('label') ? 'Lender Unit' : 'account 2222';
        f.put('reviewed-row', 2500, { category,
          payee: identity.startsWith('directed') ? null : locator,
          description: identity.startsWith('directed') ? `Payment to ${locator}` : 'Account activity' });
        const body = await f.askReached('reviewed-category-decision', summary);
        assert.equal(total(body), category ? 12500 : 10000);
        assert.equal(body.ledger.own_account_payments.count, category ? 0 : 1);
        assert.equal(body.ledger.own_account_payments.total_minor, category ? 0 : 2500);
        if (!category) disclosed(body);
      });

test('R2 unknown source role refuses while an observed asset role stays explicitly uncertain', async t => {
  const f = fixture(t, 'loan'); ordinary(f);
  f.put('repayment', 2500, { category: null, payee: null, description: 'Payment to Lender Unit' });
  const green = await f.askReached('source-reviewed-green', summary);
  assert.equal(total(green), 10000); disclosed(green);
  f.raw("UPDATE fin_accounts SET account_kind='other',balance_role='asset' WHERE account_slug='fixture-account'");
  const uncertain = await f.askReached('source-observed-asset', summary);
  assert.equal(uncertain.ledger.complete, false);
  assert.equal(uncertain.ledger.expense_total_minor, null);
  assert.equal(uncertain.ledger.retained_outflow_minor, 10000);
  assert.equal(uncertain.ledger.own_account_payments.total_minor, 2500);
  f.raw("UPDATE fin_accounts SET balance_role='neither' WHERE account_slug='fixture-account'");
  const refused = await f.askReached('source-role-unknown', summary);
  assert.equal(refused.answer, null);
  assert.equal(refused.gaps[0].reason, 'ledger_account_kind_review_required');
});
for (const [name, question, read] of readers) test(`bank-coded payment excluded and disclosed: ${name}`, async t => {
  const f = fixture(t); ordinary(f);
  assert.equal(read(await f.askReached(`${name}-green`, question)), 10000);
  payments(f);
  const b = await f.askReached(`${name}-bank-payment`, question);
  if (name === 'totals') return moneyOutWithheld(b);
  assert.equal(read(b), 10000);
  disclosed(b);
});
for (const [name, question, read] of readers) test(`owned loan payment without category excluded and disclosed: ${name}`, async t => {
  const f = fixture(t, 'loan'); ordinary(f);
  assert.equal(read(await f.askReached(`owned-${name}-green`, question)), 10000);
  payments(f, { category: null, payee: null, description: 'AUTOPAY TO ACCOUNT 2222' });
  const b = await f.askReached(`owned-${name}`, question);
  // A unary account reference excludes spending, but money out keeps the
  // posting until a reciprocal connected counterpart proves the movement.
  assert.equal(read(b), name === 'totals' ? 12500 : 10000);
  if (name === 'totals') {
    assert.equal(b.ledger.possible_payments[0].amount_minor, 2500);
    assert.equal(b.ledger.possible_payments[0].included_in_total, true);
    assert.match(b.answer, /included in money out above, possibly/);
  } else disclosed(b);
});
for (const [name, question, read] of [
  ['inflow', income, b => b.ledger.combined_inflow_minor],
  ['income category', 'How much income by category in October 2026?', total],
  ['income merchant', 'How much income by merchant in October 2026?', total],
  ['deposits', 'What were my ten largest deposits in October 2026?', b => b.ledger.lead_rows.reduce((s, r) => s + r.amount_minor, 0)],
]) test(`receiving card repayment excluded from ${name}`, async t => {
  const f = fixture(t); f.put('receipt', 10000, { direction: 'inflow' });
  assert.equal(read(await f.askReached(`${name}-receiving-green`, question)), 10000);
  f.put('receiving-payment', 2500, { account: 'liability-unit', direction: 'inflow', category: null,
    payee: null, description: 'TRANSFER FROM ACCOUNT 1234' });
  const b = await f.askReached(`${name}-receiving`, question);
  assert.equal(read(b), name === 'inflow' ? 12500 : 10000);
  if (name === 'inflow') assert.equal(b.ledger.lead_accounts.reduce((sum, row) => sum + row.credits_minor, 0), 10000);
  disclosed(b);
});
test('card-like exact reviewed counterparty, no category', async t => {
  const f = fixture(t); ordinary(f);
  assert.equal(total(await f.askReached('exact-card-green', summary)), 10000);
  payments(f, { category: null, payee: 'card ending 2222', description: 'Automatic payment' });
  const b = await f.askReached('exact-card', summary);
  assert.equal(total(b), 10000); disclosed(b);
});
test('unconnected card-like label alone does not invent payment evidence', async t => {
  const f = fixture(t); ordinary(f);
  assert.equal(total(await f.askReached('unconnected-label-green', summary)), 10000);
  f.put('ambiguous-card', 2500, { category: null, payee: 'External Card Unit', description: 'Payment' });
  const b = await f.askReached('unconnected-label', summary);
  assert.equal(total(b), 12500);
  assert.equal(b.ledger.own_account_payments.count, 0);
});
test('refund from a card is retained as an inflow, not repayment', async t => {
  const f = fixture(t); f.put('receipt', 10000, { direction: 'inflow' });
  assert.equal((await f.askReached('refund-green', income)).ledger.combined_inflow_minor, 10000);
  f.put('refund', 2500, { direction: 'inflow', category: null, payee: 'Lender Unit', description: 'Card refund' });
  const b = await f.askReached('refund', income);
  assert.equal(b.ledger.combined_inflow_minor, 12500);
  assert.equal(b.ledger.payment_exclusions, undefined);
});
test('loan disbursement retains its proceeds policy, not repayment classification', async t => {
  const f = fixture(t, 'loan'); f.put('receipt', 10000, { direction: 'inflow' });
  assert.equal((await f.askReached('disbursement-green', income)).ledger.combined_inflow_minor, 10000);
  f.put('advance-out', 2500, { account: 'liability-unit', payee: null, category: null, description: 'Loan disbursement to account 1234' });
  f.put('advance-in', 2500, { direction: 'inflow', payee: null, category: null, description: 'Loan disbursement from account 2222' });
  const b = await f.askReached('disbursement', income);
  assert.equal(b.ledger.combined_inflow_minor, 12500, 'recorded gross inflow retains loan proceeds');
  assert.equal(b.ledger.lead_accounts.reduce((sum, row) => sum + row.credits_minor, 0), 10000, 'ordinary money in excludes loan proceeds');
  assert.equal(b.ledger.payment_exclusions, undefined);
  assert.equal(b.ledger.income_established, false);
  assert.equal(b.ledger.candidate_transfer_count, 1, 'the paired movement was reached');
});
test('transfer to unconfirmed account does not create a proved repayment', async t => {
  const f = fixture(t, 'card', false); ordinary(f);
  const green = await f.askReached('unconfirmed-green', readers[3][1]);
  assert.equal(out(green), 10000);
  f.put('unknown-transfer', 2500, { category: null, payee: null, description: 'TRANSFER TO ACCOUNT 2222' });
  const b = await f.askReached('unconfirmed', summary);
  assert.equal(b.code, 'ledger_account_kind_review_required');
  assert.equal(b.evidence_gate.supported, false);
  assert.equal(b.ledger, undefined);
});
for (const payee of ['Card Craft Unit', 'Loan Equipment Unit', 'External Lender Unit']) test(`genuine merchant retained: ${payee}`, async t => {
  const f = fixture(t); ordinary(f);
  assert.equal(total(await f.askReached(`${payee}-green`, summary)), 10000);
  f.put('purchase', 2500, { payee, description: 'Purchased office supplies' });
  const b = await f.askReached(payee, summary);
  assert.equal(total(b), 12500);
  assert.equal(b.ledger.own_account_payments.count, 0);
});
test('R1 largest conditional expense total excludes bank-coded repayment', async t => {
  const f = fixture(t); ordinary(f);
  const q = readers[4][1];
  assert.equal((await f.askReached('ranking-conditional-green', q)).ledger.if_own_transfers.total_minor, 10000);
  payments(f);
  const b = await f.askReached('ranking-conditional', q);
  assert.equal(b.ledger.lead_rows.length, 1);
  assert.equal(b.ledger.own_account_payments.total_minor, 2500, 'payment was identified');
  assert.equal(b.ledger.if_own_transfers.total_minor, 10000, 'no expense total includes repayments');
  assert.equal(b.ledger.if_own_transfers.accounts.find(a => a.account_mask === '1234').debits_minor, 10000);
  assert.deepEqual(b.ledger.rows.map(r => r.amount_minor), [10000], 'alternate list excludes repayments too');
  assert.equal((b.answer.match(/Payments to loans and cards \(excluded/g) || []).length, 1, 'one payment appendix');
});
for (const kind of ['expense_summary', 'totals', 'merchant']) test(`R2 monthly wrapper discloses excluded payments: ${kind}`, async t => {
  const f = fixture(t); ordinary(f);
  const text = kind === 'totals' ? 'money in and out' : kind === 'merchant' ? 'Service Unit charges' : 'expenses';
  const q = `Could you retrieve ${text} month by month since August?`;
  const intent = { kind, ...(kind === 'totals' ? { direction: 'both' } : kind === 'merchant' ? { direction: 'outflow', vendor_text: 'Service Unit' } : {}) };
  const read = b => b.ledger.months.map(m => kind === 'totals' ? m.outflow_minor : m.total_minor);
  assert.deepEqual(read(await f.askReached(`monthly-${kind}-green`, q, intent)), [10000, 10000, 10000]);
  payments(f, { payee: 'Service Unit' });
  const b = await f.askReached(`monthly-${kind}`, q, intent);
  if (kind === 'totals') {
    for (const month of b.ledger.months) {
      assert.equal(month.available, false);
      moneyOutWithheld(b, month);
    }
    return;
  }
  assert.deepEqual(read(b), [10000, 10000, 10000]);
  assert.match(b.answer, /payments to loans and cards|payments to your own loan\/card/i);
  for (const month of b.ledger.months) {
    const payment = month.payment_exclusions;
    assert.equal(payment.total_minor, 2500);
    assert.equal(payment.count, 1);
    assert.equal(payment.card_minor, 2500);
    assert.equal(payment.loan_minor, 0);
    assert.equal(payment.rows.length, 1);
    const row = payment.rows[0];
    assert.equal(row.payment_kind, 'card');
    assert.equal(row.posted_on.slice(0, 7), month.month);
    const ref = b.citations.find(c => c.n === row.n);
    assert.ok(ref, 'child payment citation is remapped to global citations');
    assert.equal(ref.amount_minor, 2500);
    assert.equal(ref.posted_on, row.posted_on);
    assert.ok(month.citations.includes(row.n));
    assert.match(b.answer.split('\n').find(line => line.startsWith(month.label + ':')), /Payments to loans and cards.*\$25\.00/);
  }
  assert.equal(new Set(b.citations.map(c => c.n)).size, b.citations.length);
});
for (const [name, q, read] of readers) test(`R3 service fee to lender label remains expense: ${name}`, async t => {
  const f = fixture(t); ordinary(f);
  assert.equal(read(await f.askReached(`fee-${name}-green`, q)), 10000);
  payments(f, { category: 'BANK_FEES', payee: 'Lender Unit', description: 'Monthly account service fee' });
  const b = await f.askReached(`fee-${name}`, q);
  assert.equal(read(b), 12500, 'genuine bank fee is not principal repayment');
});
test('R4 vendor family exclusion remains disclosed for a family payee', async t => {
  const f = fixture(t); ordinary(f, { payee: 'Service Unit Shop' });
  const q = 'How much did I spend at Service Unit in October 2026?';
  const green = await f.askReached('vendor-family-green', q);
  assert.equal(green.ledger.total_minor, null, 'S6 does not certify similar names');
  assert.equal(green.ledger.name_match_subtotal_minor, 10000);
  payments(f, { payee: 'Service Unit Card' });
  const b = await f.askReached('vendor-family', q);
  assert.equal(total(b), null);
  assert.equal(b.ledger.name_match_subtotal_minor, 10000);
  disclosed(b);
});

// Execute each reviewed regression in the real reader. Each mutation has an
// ordinary-row control and an intact peer, so uniform failures cannot pass.
async function reviewMutant(file, from, to) {
  const answerUrl = new URL('../src/lib/ledger-answer.js', import.meta.url);
  const absolute = (source, url) => source.replace(/from (["'])(\.\/[^"'\n]+)\1/g,
    (_, quote, path) => `from ${JSON.stringify(new URL(path, url).href)}`);
  const data = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const url = new URL(file, answerUrl);
  let changed = readFileSync(url, 'utf8');
  assert.equal(changed.split(from).length - 1, 1, 'one reached mutation site');
  changed = changed.replace(from, to);
  // S8 also removes lead exclusions from conditional totals. Remove that
  // independent defense in this throwaway R1 attack to reach the leak.
  if (from.startsWith('const activity =')) changed = changed.replace(
    'const withoutCandidates = list => withoutLead(list).filter',
    'const withoutCandidates = list => list.filter');
  let answer = file === 'ledger-answer.js' ? changed : readFileSync(answerUrl, 'utf8')
    .replace(JSON.stringify(`./${file}`), JSON.stringify(data(absolute(changed, url))));
  return (await import(data(absolute(answer, answerUrl)))).withLedgerAnswer;
}

for (const [id, file, from, to] of [
  ['R1', 'ledger-answer.js', 'const activity = intent.kind === "largest" && intent.direction === "outflow"\n    ? rows.filter(row => !loanCardPaymentKind(row, bySlug)) : rows;', 'const activity = rows;'],
  ['R2', 'ledger-monthly.js', 'const paymentExclusions = childPayments ?', 'const paymentExclusions = false && childPayments ?'],
  ['R3', 'ledger-analysis.js', 'if (hasExplicitExpenseCategory(row)) return null;', '/* mutant: expense category veto removed */'],
  ['R4', 'ledger-answer.js', 'familyPaymentIds ? familyPaymentIds.has(row.id)', 'familyPaymentIds ? matchesMerchant(row, intent.match)'],
]) test(`review mutation killed: ${id}`, async t => {
  const mutant = await reviewMutant(file, from, to);
  const f = fixture(t); ordinary(f, id === 'R4' ? { payee: 'Service Unit Shop' } : {});
  const q = id === 'R1' ? readers[4][1] : id === 'R2' ? 'Could you retrieve expenses month by month since August?'
    : id === 'R4' ? 'How much did I spend at Service Unit in October 2026?' : summary;
  const intent = id === 'R2' ? { kind: 'expense_summary' } : undefined;
  const figure = b => id === 'R1' ? b.ledger.if_own_transfers.total_minor
    : id === 'R2' ? b.ledger.months[0].total_minor : id === 'R4' ? b.ledger.name_match_subtotal_minor : total(b);
  assert.equal(figure(await f.askReached(`${id}-intact-green`, q, intent)), 10000);
  assert.equal(figure(await f.askReached(`${id}-mutant-green`, q, intent, mutant)), 10000);
  payments(f, id === 'R3' ? { category: 'BANK_FEES', payee: 'Lender Unit', description: 'Monthly account service fee' }
    : id === 'R4' ? { payee: 'Service Unit Card' } : {});
  const oracle = b => {
    assert.equal(figure(b), id === 'R3' ? 12500 : 10000);
    if (id === 'R2') for (const month of b.ledger.months) {
      assert.equal(month.payment_exclusions?.total_minor, 2500);
      assert.match(b.answer, /Payments to loans and cards/);
    }
    if (id === 'R4') disclosed(b);
  };
  oracle(await f.askReached(`${id}-intact`, q, intent));
  const changed = await f.askReached(`${id}-mutant`, q, intent, mutant);
  assert.throws(() => oracle(changed), assert.AssertionError, 'same oracle kills the executed mutant');
});

for (const payee of ['Service Unit', 'Service Unit Card']) test(`R4 exact and family payees disclose the same payment: ${payee}`, async t => {
  const f = fixture(t); ordinary(f);
  const q = 'How much did I spend at Service Unit in October 2026?';
  assert.equal(total(await f.askReached('vendor-green', q)), 10000);
  payments(f, { payee });
  const b = await f.askReached('vendor-payment', q);
  assert.equal(total(b), 10000);
  assert.equal(b.ledger.payment_exclusions.total_minor, 2500);
  assert.equal(b.ledger.payment_exclusions.count, 1);
  disclosed(b);
});

// R2 permits reviewed exact labels. Preserve these expense assertions by
// providing the explicit non-payment bank categories that prove their premise.
for (const [description, category] of [['Monthly account service fee', 'BANK_FEES'],
  ['Payment to Lender Unit', 'BANK_FEES'], ['Purchased office supplies', 'GENERAL_MERCHANDISE']])
  test(`R3 explicit expense category vetoes a reviewed label: ${description}`, async t => {
    const f = fixture(t); ordinary(f);
    assert.equal(total(await f.askReached('label-green', summary)), 10000);
    payments(f, { category, payee: 'Lender Unit', description });
    assert.equal(total(await f.askReached('label-expense', summary)), 12500);
  });

test('R2 payment-only vendor month keeps its exclusion and citation after a covered zero', async t => {
  const f = fixture(t);
  f.put('ordinary-september', 10000, { date: '2026-09-05' });
  const q = 'Could you retrieve Service Unit charges month by month since August?';
  const intent = { kind: 'merchant', direction: 'outflow', vendor_text: 'Service Unit' };
  const green = await f.askReached('payment-only-green', q, intent);
  assert.deepEqual(green.ledger.months.map(m => m.total_minor), [0, 10000, null]);
  f.put('payment-august', 2500, { date: '2026-08-05', category: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' });
  const body = await f.askReached('payment-only', q, intent);
  assert.deepEqual(body.ledger.months.map(m => m.total_minor), [0, 10000, null]);
  const month = body.ledger.months[0];
  assert.equal(month.payment_exclusions?.total_minor, 2500, 'payment-only month still discloses excluded cents');
  assert.equal(body.citations.find(c => c.n === month.payment_exclusions.rows[0].n).amount_minor, 2500);
  assert.match(body.answer, /August 2026:.*Payments to loans and cards/);
});


for (const direction of ['inflow', 'outflow']) test(`R1 conditional account totals exclude a payment outside the ranked selector: ${direction}`, async t => {
  const f = fixture(t); ordinary(f);
  const q = 'Could you retrieve the two largest charges at Service Unit this month?';
  const intent = { kind: 'largest', direction: 'outflow', vendor_text: 'Service Unit', count: 2 };
  const green = await f.askReached('conditional-green', q, intent);
  assert.equal(green.ledger.if_own_transfers.accounts[0].credits_minor, 0);
  assert.equal(green.ledger.if_own_transfers.accounts[0].debits_minor, 10000);
  f.put('payment', 2500, { direction, payee: 'Payment Unit', category: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' });
  const body = await f.askReached('conditional-payment', q, intent);
  assert.equal(body.ledger.if_own_transfers.accounts[0].credits_minor, 0, 'conditional credits exclude repayments');
  assert.equal(body.ledger.if_own_transfers.accounts[0].debits_minor, 10000, 'conditional debits exclude repayments outside the selector');
  assert.deepEqual(body.ledger.rows.map(row => row.amount_minor), [10000]);
  // The final named-selector rule scopes the appendix as well as the ranking.
  // Account conditionals still exclude payments throughout their wider pool.
  assert.equal(body.ledger.payment_exclusions, undefined);
  assert.equal(body.ledger.own_account_payments, undefined);
  assert.doesNotMatch(body.answer, /\$25\.00/);
});

test('R2 early-month comparison preserves the current payment disclosure', async t => {
  const f = fixture(t, 'card', true, '2026-10-02T12:00:00.000Z');
  f.put('ordinary-current', 10000, { date: '2026-10-01' });
  f.put('ordinary-previous', 10000, { date: '2026-09-01' });
  const q = 'What are my expenses?';
  const green = await f.askReached('comparison-green', q);
  assert.equal(total(green), 10000);
  assert.equal(green.ledger.previous_month.total_minor, 10000, 'defaulted early-month composition reached');
  f.put('payment-current', 2500, { date: '2026-10-01', category: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' });
  const body = await f.askReached('comparison-payment', q);
  assert.equal(body.ledger.own_account_payments.total_minor, 2500, 'current-month payment was identified');
  assert.equal(total(body), 10000);
  assert.equal(body.ledger.previous_month.total_minor, 10000);
  assert.match(body.answer.split('Previous complete calendar month')[0], /Payments to loans and cards.*\$25\.00/);
});

// N1-N4: retained independent review cases, with nonempty controls.
for (const evidence of ['bank', 'mask']) test(`new recurring selector retains scope after its entire series is excluded: ${evidence}`, async t => {
  const f = fixture(t); ordinary(f, { payee: 'Other Unit' });
  const payee = evidence === 'bank' ? 'Service Unit' : 'Lender Unit';
  for (const date of ['2026-08-05','2026-09-05','2026-10-05'])
    f.put(`selected-${date}`,2500,{date,payee,category:null,description:evidence === 'bank' ? 'Monthly service' : 'AUTOPAY TO ACCOUNT 2222'});
  if (evidence === 'mask') f.raw("UPDATE fin_accounts SET mask='3333' WHERE account_slug='liability-unit'");
  const q = `Could you retrieve recurring charges at ${payee}?`;
  const intent = { kind:'recurring',direction:'outflow',vendor_text:payee };
  const green = await f.askReached(`recurring-${evidence}-green`,q,intent);
  assert.deepEqual(green.ledger.recurring.map(r=>r.merchant),[payee.toLowerCase()]);
  assert.equal(green.ledger.monthly_total_minor,2500);
  if (evidence === 'bank') f.raw("UPDATE fin_transactions SET category='LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' WHERE txn_uid LIKE 'selected-%'");
  else f.raw("UPDATE fin_accounts SET mask='2222' WHERE account_slug='liability-unit'");
  const b = await f.askReached(`recurring-${evidence}`,q,intent);
  assert.equal(b.ledger.payment_exclusions.total_minor,7500,'selected payments were partitioned');
  assert.ok(!b.ledger.recurring.some(r=>r.merchant==='other unit'),'payment exclusion must not widen the named selector');
  assert.ok(b.ledger.monthly_total_minor===0 || b.ledger.monthly_total_minor===null);
  assert.equal(b.ledger.selector_applied, true, 'known payee stays selected after partition');
  assert.match(b.answer, /that is a payment to your card, listed separately/i);
  assert.match(b.answer, /typical \$25\.00; estimated monthly payment \$25\.00/);
  assert.equal(b.ledger.payment_exclusions.count, 3);
});

for (const outKind of ['bank','owned']) test(`new ranking discloses independent receiving payment as well as outgoing payment: ${outKind}`,async t=>{
  const f=fixture(t); ordinary(f);
  const q=readers[4][1];
  assert.equal((await f.askReached(`ranking-mixed-${outKind}-green`,q)).ledger.if_own_transfers.total_minor,10000);
  f.put('out-payment',2500,{category:outKind==='bank'?'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT':null,
    payee:outKind==='bank'?'Payment Unit':null,description:outKind==='bank'?'Card payment':'PAYMENT TO ACCOUNT 2222'});
  f.put('independent-receiving',4000,{account:'liability-unit',direction:'inflow',category:outKind==='bank'?'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT':null,payee:null,description:outKind==='bank'?'Card payment credit':'PAYMENT THANK YOU'});
  const b=await f.askReached(`ranking-mixed-${outKind}`,q);
  assert.equal(b.ledger.if_own_transfers.total_minor,10000);
  assert.equal(b.ledger.payment_exclusions.total_minor,6500,'both payment decisions reached');
  assert.equal(b.ledger.payment_exclusions.count,2);
  assert.ok(b.answer.includes('$40.00') || b.answer.includes('$65.00'),'independent receiving exclusion must be visible, not just structured');
  assert.match(b.answer, /Payments to loans and cards.*\$65\.00 across 2 payments/);
  assert.equal(b.disclosedPaymentIds, undefined, 'internal posting membership is not a public response field');
});

test('new refund-description selector discloses bank-coded excluded postings',async t=>{
  const f=fixture(t);
  f.put('refund',10000,{direction:'inflow',description:'Refund adjustment',payee:'Receipt Unit'});
  const q='Could you retrieve money in from refunds this month?';
  const intent={kind:'merchant',direction:'inflow',vendor_text:'refunds'};
  const green=await f.askReached('keyword-green',q,intent);
  assert.equal(green.ledger.total_minor,10000);
  assert.equal(green.ledger.description_keyword,'refund');
  f.put('payment',2500,{direction:'inflow',description:'Refund adjustment',payee:'Payment Unit',category:'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'});
  const b=await f.askReached('keyword-payment',q,intent);
  assert.equal(b.ledger.total_minor,10000,'coded repayment removed at real keyword selector');
  disclosed(b);
});

test('new possible vendor payment remains disclosed alongside the exact subtotal',async t=>{
  const f=fixture(t); ordinary(f);
  const q='How much did I spend at Service Unit in October 2026?';
  assert.equal(total(await f.askReached('possible-vendor-green',q)),10000);
  f.put('payment',2500,{payee:null,description:'Service Unit payment',category:'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'});
  const b=await f.askReached('possible-vendor-payment',q);
  assert.equal(total(b),10000);
  disclosed(b);
  assert.equal(b.ledger.payment_exclusions.rows[0].match_basis, 'possible');
  assert.match(b.answer, /possible vendor-description matches.*payee attribution remains unconfirmed/);
});

for (const kind of ['expense_summary','totals','merchant']) test(`new monthly partial coverage remains partial and retains cited payments: ${kind}`,async t=>{
  const f=fixture(t); ordinary(f);
  const text=kind==='totals'?'money in and out':kind==='merchant'?'Service Unit charges':'expenses';
  const q=`Could you retrieve ${text} month by month since August?`;
  const intent={kind,...(kind==='totals'?{direction:'both'}:kind==='merchant'?{direction:'outflow',vendor_text:'Service Unit'}:{})};
  const green=await f.askReached(`monthly-partial-${kind}-green`,q,intent);
  assert.equal(green.ledger.complete,true);
  f.raw("UPDATE fin_account_coverage SET covered_from='2026-09-01' WHERE account_slug='liability-unit'");
  payments(f,{payee:'Service Unit'});
  const b=await f.askReached(`monthly-partial-${kind}`,q,intent);
  assert.equal(b.ledger.complete,false);
  assert.equal(b.evidence_gate.complete,false);
  assert.equal(b.ledger.months[0].complete,false);
  if (kind==='totals') { for (const month of b.ledger.months) { assert.equal(month.available,false); moneyOutWithheld(b,month); } return; }
  for (const month of b.ledger.months){
    assert.equal(month.payment_exclusions.total_minor,2500);
    const field=kind==='totals'?(month.complete?'outflow_minor':'outflow_subtotal_minor'):(month.complete?'total_minor':'subtotal_minor');
    assert.equal(month[field],10000);
    for(const row of month.payment_exclusions.rows){
      const refs=b.citations.filter(c=>c.n===row.n);
      assert.equal(refs.length,1); assert.equal(refs[0].amount_minor,2500);
      assert.equal(refs[0].posted_on,row.posted_on);
    }
    assert.ok(b.answer.split('\n').find(line=>line.startsWith(`${month.label}:`)).includes('Payments to loans and cards'));
  }
});

for(const selector of ['Service Unit','Service Unit Shop']) test(`new monthly family selector carries complete cited payment membership: ${selector}`,async t=>{
  const f=fixture(t); ordinary(f,{payee:'Service Unit Shop'});
  const q=`Could you retrieve ${selector} charges month by month since August?`;
  const intent={kind:'merchant',direction:'outflow',vendor_text:selector};
  const green=await f.askReached(`monthly-family-${selector}-green`,q,intent);
  assert.deepEqual(green.ledger.months.map(m=>m.total_minor), selector==='Service Unit'?[null,null,null]:[10000,10000,10000]);
  if(selector==='Service Unit') assert.ok(green.ledger.months.every(m=>m.total_minor===null));
  payments(f,{payee:selector+' Card'});
  const b=await f.askReached(`monthly-family-${selector}`,q,intent);
  assert.deepEqual(b.ledger.months.map(m=>m.total_minor), selector==='Service Unit'?[null,null,null]:[10000,10000,10000]);
  if(selector==='Service Unit') assert.ok(b.ledger.months.every(m=>m.total_minor===null));
  assert.equal(new Set(b.citations.map(c=>c.n)).size,b.citations.length);
  for(const m of b.ledger.months){
    assert.equal(m.payment_exclusions.total_minor,2500);
    assert.equal(b.citations.find(c=>c.n===m.payment_exclusions.rows[0].n).posted_on,m.payment_exclusions.rows[0].posted_on);
  }
});

for(const [label,payee,description] of [
  ['star-mask','card ending ****2222','Automatic payment'],
  ['unicode-mask','card ending ２２２２','Automatic payment'],
  ['decorated-mask',null,'AUTOPAY TO ACCOUNT XXXX2222'],
  ['bilateral',null,'TRANSFER FROM ACCOUNT 1234 TO ACCOUNT 2222'],
]) test(`new exact repayment identity variant: ${label}`,async t=>{
  const f=fixture(t); ordinary(f);
  assert.equal(total(await f.askReached(`identity-${label}-green`,summary)),10000);
  f.put('payment',2500,{category:null,payee,description});
  const b=await f.askReached(`identity-${label}`,summary);
  assert.equal(total(b),10000); disclosed(b);
});

for(const [label,payee,description] of [
  ['label','Lender Unit','Monthly account service fee'],
  ['embedded-mask','Fee Unit','Monthly fee for card ending 2222'],
  ['external-payee','Outside Unit','PAYMENT TO ACCOUNT 2222'],
  ['wrong-kind','loan ending 2222','Monthly service fee'],
  ['trailing-memo',null,'PAYMENT TO ACCOUNT 2222 SERVICE FEE'],
]) test(`new genuine expense control survives account-like evidence: ${label}`,async t=>{
  const f=fixture(t); ordinary(f);
  assert.equal(total(await f.askReached(`expense-${label}-green`,summary)),10000);
  f.put('fee',2500,{category:'BANK_FEES',payee,description});
  const b=await f.askReached(`expense-${label}`,summary);
  assert.equal(total(b),12500); assert.equal(b.ledger.own_account_payments.count,0);
});

for(const option of ['including transfers','excluding transfers']) test(`new liability payment flags never restore a ranking amount: ${option}`,async t=>{
  const f=fixture(t); ordinary(f);
  const q=`What were my ten largest expenses in October 2026 ${option}?`;
  assert.equal((await f.askReached(`ranking-flag-${option}-green`,q)).ledger.if_own_transfers.total_minor,10000);
  payments(f);
  const b=await f.askReached(`ranking-flag-${option}`,q);
  assert.equal(b.ledger.lead_rows.reduce((n,r)=>n+r.amount_minor,0),10000);
  assert.equal(b.ledger.rows.reduce((n,r)=>n+r.amount_minor,0),10000);
  assert.equal(b.ledger.if_own_transfers.total_minor,10000); disclosed(b);
});

for(const category of ['LOAN_PAYMENTS_CREDIT_CARD_PAYMENT','LOAN_PAYMENTS']) test(`new net-refund operand excludes bank-coded receiving payment: ${category}`,async t=>{
  const f=fixture(t); ordinary(f);
  f.put('ordinary-refund',1000,{direction:'inflow',payee:'Receipt Unit',description:'Merchant refund'});
  const q="Could you retrieve this month's spending after refunds?";
  const intent={kind:'expense_summary',direction:'outflow'};
  const green=await f.askReached(`net-refund-${category}-green`,q,intent);
  assert.equal(green.ledger.total_minor,10000);
  assert.equal(green.ledger.net_expense_minor,undefined, 'closed-world release never subtracts');
  assert.deepEqual(green.ledger.possible_refunds.map(row => row.amount_minor), [1000], 'candidate green control reached');
  f.put('receiving-payment',2500,{direction:'inflow',account:'liability-unit',category,payee:null,description:'Card payment refund adjustment'});
  const b=await f.askReached(`net-refund-${category}`,q,intent);
  assert.equal(b.ledger.total_minor,10000);
  assert.equal(b.ledger.net_expense_minor,undefined,'no refund subtraction authority');
  assert.deepEqual(b.ledger.possible_refunds.map(row => row.amount_minor), [1000], 'receiving repayment cannot enter refund candidates');
  disclosed(b);
  assert.equal(b.ledger.payment_exclusions.total_minor, 2500);
  assert.equal(b.ledger.payment_exclusions.count, 1);
});

for(const date of ['2026-09-29','2026-11-02']) test(`new padded payment cannot alter October scope: ${date}`,async t=>{
  const f=fixture(t); ordinary(f);
  const q='What were my ten largest expenses in October 2026?';
  assert.equal((await f.askReached(`padding-${date}-green`,q)).ledger.if_own_transfers.total_minor,10000);
  f.put('padded-payment',2500,{date,category:'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'});
  const b=await f.askReached(`padding-${date}`,q);
  assert.equal(b.ledger.if_own_transfers.total_minor,10000);
  assert.equal(b.ledger.payment_exclusions,undefined);
  assert.equal(b.ledger.own_account_payments?.count||0,0);
  f.raw("UPDATE fin_transactions SET posted_on='2026-10-05' WHERE txn_uid='padded-payment'");
  const shifted=await f.askReached(`padding-${date}-in-window`,q);
  assert.equal(shifted.ledger.own_account_payments.total_minor,2500,'same row reaches exclusion when moved inside scope');
  assert.equal(shifted.ledger.if_own_transfers.total_minor,10000);
});

for (const [id, from, to] of [
  ['N1', 'const credits = refundCreditMembership(history, pairs, accounts);', "const credits = history.filter(row => row.direction === 'inflow');"],
  ['N2', "const recurringSelectorResolved = intent.kind === 'recurring' && Boolean(namedSelection?.resolved);",
    "const recurringSelectorResolved = intent.kind === 'recurring' && Boolean(namedSelection?.resolved) && namedSelection.matched.some(row => !loanCardPaymentKind(row, bySlug));"],
  ['N3', 'else result.answer += paymentDisclosure;',
    'else if (!result.ledger.own_account_payments?.count) result.answer += paymentDisclosure;'],
  ['N4', 'descriptionKeyword ? row.direction === intent.direction && matchesDescriptionKeyword(row, descriptionKeyword) : !intent.match ||',
    'false && descriptionKeyword ? matchesDescriptionKeyword(row, descriptionKeyword) : !intent.match ||'],
]) test(`review mutation killed: ${id}`, async t => {
  const mutant = await reviewMutant('ledger-answer.js', from, to);
  const f = fixture(t);
  if (id === 'N4') f.put('receipt', 10000, { direction: 'inflow', payee: 'Receipt Unit', description: 'Merchant refund' });
  else ordinary(f, id === 'N2' ? { payee: 'Other Unit' } : {});
  if (id === 'N1') f.put('refund', 1000, { direction: 'inflow', payee: 'Receipt Unit', description: 'Merchant refund' });
  // The selected series initially has no payment evidence. Another payee's
  // larger series makes selector widening observable after classification.
  if (id === 'N2') for (const date of ['2026-08-05', '2026-09-05', '2026-10-05'])
    f.put(`selected-${date}`, 2500, { date });
  const q = id === 'N1' ? "Could you retrieve this month's spending after refunds?"
    : id === 'N2' ? 'Could you retrieve recurring charges at Service Unit?'
      : id === 'N3' ? readers[4][1] : 'Could you retrieve money in from refunds this month?';
  const intent = id === 'N1' ? { kind: 'expense_summary', direction: 'outflow' }
    : id === 'N2' ? { kind: 'recurring', direction: 'outflow', vendor_text: 'Service Unit' }
      : id === 'N4' ? { kind: 'merchant', direction: 'inflow', vendor_text: 'refunds' } : undefined;
  const figure = b => id === 'N1' ? b.ledger.possible_refunds.length
    : id === 'N2' ? b.ledger.monthly_total_minor : id === 'N3' ? b.ledger.if_own_transfers.total_minor : total(b);
  for (const answer of [withLedgerAnswer, mutant]) {
    const green = await f.askReached(`${id}-green`, q, intent, answer);
    assert.equal(figure(green), id === 'N1' ? 1 : id === 'N2' ? 2500 : 10000);
    if (id === 'N2') assert.deepEqual(green.ledger.recurring.map(row => row.merchant), ['service unit']);
  }
  if (id === 'N2') f.raw("UPDATE fin_transactions SET category='LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' WHERE txn_uid LIKE 'selected-%'");
  else {
    f.put('receiving-payment', id === 'N3' ? 4000 : 2500, { direction: 'inflow', account: 'liability-unit',
      category: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', payee: null, description: 'Card payment refund adjustment' });
    if (id === 'N3') f.put('out-payment', 2500, { category: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', payee: 'Payment Unit' });
  }
  const oracle = b => {
    assert.equal(figure(b), id === 'N1' ? 1 : id === 'N2' ? 0 : 10000);
    if (id === 'N1') {
      assert.equal(b.ledger.total_minor, 10000);
      assert.equal(b.ledger.net_expense_minor, undefined);
      assert.deepEqual(b.ledger.possible_refunds.map(row => row.amount_minor), [1000]);
    }
    if (id === 'N2') {
      assert.equal(b.ledger.selector_applied, true);
      assert.deepEqual(b.ledger.recurring, []);
      assert.match(b.answer, /that is a payment to your card, listed separately/);
    }
    if (id === 'N3') assert.match(b.answer, /Payments to loans and cards.*\$65\.00 across 2 payments/);
    disclosed(b);
    assert.equal(b.ledger.payment_exclusions.total_minor, id === 'N2' ? 7500 : id === 'N3' ? 6500 : 2500);
  };
  oracle(await f.askReached(`${id}-intact`, q, intent));
  const changed = await f.askReached(`${id}-mutant`, q, intent, mutant);
  assert.throws(() => oracle(changed), assert.AssertionError, 'the same reached oracle rejects the executed mutant');
});

for (const keyword of ['refunds', 'reimbursements']) test(`N4 keyword membership excludes unrelated and opposite-direction payment disclosures: ${keyword}`, async t => {
  const f = fixture(t);
  const q = `Could you retrieve money in from ${keyword} this month?`;
  const intent = { kind: 'merchant', direction: 'inflow', vendor_text: keyword };
  f.put('receipt', 10000, { direction: 'inflow', payee: 'Receipt Unit', description: keyword });
  assert.equal(total(await f.askReached('keyword-green', q, intent)), 10000);
  for (const [id, description, direction] of [
    ['unrelated', 'Other adjustment', 'inflow'],
    ['substring', keyword + 'able adjustment', 'inflow'],
    ['opposite', keyword, 'outflow'],
  ]) f.put(id, 4000, { direction, description, category: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', payee: 'Payment Unit' });
  const unrelated = await f.askReached('keyword-unrelated', q, intent);
  assert.equal(total(unrelated), 10000);
  assert.equal(unrelated.ledger.payment_exclusions, undefined);
  f.put('selected-payment', 2500, { direction: 'inflow', description: keyword.toUpperCase(),
    category: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', payee: 'Payment Unit' });
  const selected = await f.askReached('keyword-selected', q, intent);
  assert.equal(total(selected), 10000);
  assert.equal(selected.ledger.payment_exclusions.total_minor, 2500);
  assert.equal(selected.ledger.payment_exclusions.count, 1);
  disclosed(selected);
});
