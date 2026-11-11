import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';

const codes = ['LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'LOAN_PAYMENTS'];
function setup(t) {
  const f = ledgerFixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  t.mock.method(Date, 'now', () => Date.parse(NOW));
  f.env.RERANK_MODEL = 'claude-haiku-4-5-20251001';
  f.env.ANTHROPIC_API_KEY = randomBytes(24).toString('hex');
  f.put = (id, cents, payee, { date = '2026-10-08', direction = 'outflow', category = 'GENERAL_SERVICES', description = 'Ordinary charge' } = {}) => {
    f.add(id, description, payee, { date, cents, direction });
    f.raw('UPDATE fin_transactions SET category=?,category_basis_state=? WHERE txn_uid=?', category, category ? 'confirmed' : null, id);
  };
  f.read = async ({ selector = 'Software', kind = 'merchant', direction = 'outflow', literal = false, question } = {}) => {
    let models = 0;
    const start = f.calls.length, changes = f.first('SELECT total_changes() n').n;
    const response = await withLedgerAnswer({ env: f.env, now: NOW, grantScope: { all: true }, scopePrincipalKind: 'owner',
      question: question || (literal ? `How much did I spend at ${selector} this month?` :
        `Could you retrieve ${kind === 'recurring' ? 'recurring charges' : direction === 'inflow' ? 'deposits' : 'spending'} at ${selector} this month?`),
      callLLM: async () => { models++; return { content: [{ type: 'text', text: JSON.stringify({ ambiguous: false, unanswered_part: null,
        intents: [{ kind, direction, count: null, vendor_text: selector, account_hint: null, amount_text: null, date_text: null, period: { type: 'none' } }],
      }) }] }; },
    }, () => assert.fail('document fallback'));
    const b = await response.json();
    assert.equal(models, literal ? 0 : 1, 'intended interpretation reached');
    assert.ok(f.calls.slice(start).some(sql => /JOIN fin_transactions/.test(sql)), 'transaction decision reached');
    assert.ok(f.first('SELECT COUNT(*) n FROM fin_transactions').n > 0, 'nonempty decision pool');
    assert.equal(f.first('SELECT total_changes() n').n, changes, 'read-only');
    assert.ok(b.ledger, 'ledger result reached');
    return b;
  };
  return f;
}
function isolated(f, b, selector, { possible = false } = {}) {
  const selected = new Set(f.rows('SELECT id,payee,description FROM fin_transactions').filter(row =>
    row.payee?.toLowerCase() === selector.toLowerCase() ||
    row.payee?.toLowerCase().startsWith(selector.toLowerCase() + ' ') ||
    possible && !row.payee && row.description.toLowerCase().includes(selector.toLowerCase())).map(row => `ledger:transaction:${row.id}`));
  for (const ref of b.citations) assert.ok(selected.has(ref.ref), `foreign figure citation ${ref.ref}`);
  assert.doesNotMatch(b.answer, /\$163\.47/, 'foreign amount never printed');
}
for (const literal of [false, true]) for (const date of ['2026-09-30', '2026-07-08'])
  for (const category of ['SOFTWARE', 'GENERAL_SERVICES']) test(`T1 outside-window ${date} ${category} literal=${literal}`, async t => {
    const f = setup(t);
    f.put('other', 16347, 'Other Unit', { category }); f.put('selected', 3187, 'Software');
    assert.equal((await f.read({ literal })).ledger.total_minor, 3187, 'in-window green control');
    f.raw("UPDATE fin_transactions SET posted_on=? WHERE txn_uid='selected'", date);
    const b = await f.read({ literal });
    isolated(f, b, 'Software');
    if (!literal) {
      assert.equal(b.ledger.named_selector_guard.rejected, true, 'final guard decision reached');
      assert.match(b.answer, /No charges at Software from .* to .* on /);
      assert.match(b.answer, /rows for Software exist outside this window:/);
      assert.match(b.answer, date === '2026-09-30' ? /September 30/ : /July 8/, 'outside posting date retained');
    } else {
      assert.equal(b.ledger.total_minor, null, 'direct no-match reading keeps the amount withheld');
      assert.equal(b.ledger.named_selector_guard, undefined, 'already-safe refusal needs no replacement');
    }
  });
for (const category of codes) test(`T2 monthly refunds and payments ${category}`, async t => {
  const f = setup(t);
  for (const date of ['2026-08-08', '2026-09-08', '2026-10-08']) {
    f.put(`other-${date}`, 16347, 'Other Unit', { date, category: 'SOFTWARE' });
    f.put(`payment-${date}`, 3187, 'Software', { date, category });
    f.put(`refund-${date}`, 943, 'Software', { date, direction: 'inflow', category: 'REFUND', description: 'Purchase refund' });
    f.put(`credit-${date}`, 227, 'Software', { date, direction: 'inflow', category: 'REIMBURSEMENT', description: 'Adjustment' });
  }
  const green = await f.read();
  assert.equal(green.ledger.refunds_received_minor, 943, 'single-period refund control');
  assert.equal(green.ledger.inflows_received_minor, 1170, 'nonrefund credit remains distinct');
  const b = await f.read({ question: 'Could you retrieve Software charges month by month since August?' });
  assert.equal(b.ledger.months.length, 3, 'monthly decision reached'); isolated(f, b, 'Software');
  for (const month of b.ledger.months) {
    assert.equal(month.refunds_received_minor, 943);
    assert.equal(month.inflows_received_minor, 1170);
    assert.equal(month.payment_exclusions.total_minor, 3187);
    const line = b.answer.split('\n').find(line => line.startsWith(month.label + ':'));
    assert.match(line, /refunds received: \$9\.43/i);
    assert.match(line, /\$31\.87/);
    for (const row of month.refund_rows) {
      const ref = b.citations.find(ref => ref.n === row.n);
      assert.equal(ref.amount_minor, row.amount_minor); assert.equal(ref.posted_on, row.posted_on);
      assert.ok(month.citations.includes(row.n));
    }
  }
});

test('T1 generic category-topic wording preserves a known outside-window payee', async t => {
  const f = setup(t);
  f.put('other', 16347, 'Other Unit', { category: 'SOFTWARE' });
  f.put('selected', 3187, 'Software');
  const options = { question: 'Could you retrieve Software spending this month?' };
  assert.equal((await f.read(options)).ledger.total_minor, 3187, 'exact payee wins category vocabulary');
  f.raw("UPDATE fin_transactions SET posted_on='2026-07-08' WHERE txn_uid='selected'");
  const b = await f.read(options);
  isolated(f, b, 'Software');
  assert.equal(b.ledger.named_selector_guard.rejected, true);
  assert.match(b.answer, /No charges at Software from .*July 8/s);
});

test('named ranking payment appendix retains only the selected identity', async t => {
  const f = setup(t);
  f.put('selected', 3187, 'Store Unit', { category: codes[0] });
  const options = { selector: 'Store Unit', kind: 'largest', question: 'Could you retrieve the largest charge at Store Unit this month?' };
  assert.equal((await f.read(options)).ledger.payment_exclusions.total_minor, 3187, 'selected payment control');
  f.put('other', 16347, 'Other Unit', { category: codes[0] });
  const b = await f.read(options);
  isolated(f, b, 'Store Unit');
  assert.equal(b.ledger.payment_exclusions.total_minor, 3187);
  assert.equal(b.ledger.payment_exclusions.count, 1);
});

test('named ranking conditional account figures use the same selected identity', async t => {
  const f = setup(t);
  f.put('selected', 3187, 'Store Unit');
  const options = { selector: 'Store Unit', kind: 'largest', question: 'Could you retrieve the largest charge at Store Unit this month?' };
  assert.equal((await f.read(options)).ledger.if_own_transfers.accounts[0].debits_minor, 3187, 'selected-only control');
  f.put('other', 16347, 'Other Unit');
  const b = await f.read(options);
  isolated(f, b, 'Store Unit');
  assert.equal(b.ledger.if_own_transfers.accounts[0].debits_minor, 3187, 'conditional figure cannot widen to other payees');
});

// Deterministic Cartesian generation: 5 selectors x 5 windows x 3 directions/
// readers x 2 category states x 4 payment mixes = 600 distinct scenarios.
const selectors = ['Software', 'Supplies', 'Store Unit', 'Payment Unit', 'Vendor Family'];
const windows = [
  ['this month', '2026-10-08'], ['in September 2026', '2026-09-08'],
  ['in August 2026', '2026-08-08'], ['in July 2026', '2026-07-08'], ['in June 2026', '2026-06-08'],
];
let caseNumber = 0;
for (const selector of selectors) for (const [period, date] of windows)
  for (const mode of ['outflow', 'inflow', 'recurring']) for (const category of ['SOFTWARE', null])
    for (const mix of ['ordinary', 'card', 'loan', 'refund']) {
      const index = ++caseNumber;
      test(`guard property ${index}/600 ${selector} ${period} ${mode} ${category || 'uncategorized'} ${mix}`, async t => {
        const f = setup(t);
        const direction = mode === 'inflow' ? 'inflow' : 'outflow';
        // Exercise named incoming rankings, which attribute each listed figure.
        // Payer-income review has a separate anonymous-deposit context contract.
        const kind = mode === 'recurring' ? 'recurring' : mode === 'inflow' ? 'largest' : 'merchant';
        const month = Number(date.slice(5, 7));
        const recurringDates = [month - 2, month - 1, month].map(value => `2026-${String(value).padStart(2, '0')}-08`);
        const dates = mode === 'recurring' ? recurringDates : [date];
        for (const day of dates) {
          f.put(`other-${day}`, 16347, 'Other Unit', { date: day, direction, category });
          f.put(`selected-${day}`, 3187, selector, { date: day, direction, category: 'GENERAL_SERVICES' });
        }
        const recurringPeriod = `between ${recurringDates[0].slice(0, 7)}-01 and ${date.slice(0, 7)}-${month === 10 ? '12' : '28'}`;
        const question = `Could you retrieve ${mode === 'recurring' ? 'recurring charges' : mode === 'inflow' ? 'largest deposits' : 'spending'} at ${selector} ${mode === 'recurring' ? recurringPeriod : period}?`;
        const options = { selector, kind, direction, question };
        const green = await f.read(options); isolated(f, green, selector);
        assert.ok(green.citations.length, 'selected-figure green control');
        const outside = (index + Math.floor(index / 4)) % 2;
        if (outside) f.raw("UPDATE fin_transactions SET posted_on='2025-01-08' WHERE txn_uid LIKE 'selected-%'");
        if (mix !== 'ordinary') f.raw("UPDATE fin_transactions SET category=?,direction=?,description=? WHERE txn_uid LIKE 'selected-%'",
          mix === 'card' ? codes[0] : mix === 'loan' ? codes[1] : 'REFUND', mix === 'refund' ? 'inflow' : direction,
          mix === 'refund' ? 'Purchase refund' : 'Payment');
        const b = await f.read(options); isolated(f, b, selector);
        if (outside) assert.equal(b.citations.length, 0, 'empty named window cannot cite the other payee');
        // Check structured alternatives as well as the visible citation pool.
        for (const account of b.ledger.if_own_transfers?.accounts || []) {
          assert.ok([0, 3187, 9561].includes(account.credits_minor), 'named conditional credits');
          assert.ok([0, 3187, 9561].includes(account.debits_minor), 'named conditional debits');
        }
      });
    }
assert.equal(caseNumber, 600);
