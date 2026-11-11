import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture } from '../worker/test/ledger-review-fixture.mjs';
import { answerText as apiText } from '../worker/src/lib/answer-render.js';
import { answerText as appText } from '../frontend/src/lib/answer-render.js';

const dates = ['2026-08-07', '2026-09-07', '2026-10-07'];
const dollars = cents => '$' + (cents / 100).toFixed(2);
function setup(t, savings = false) {
  const f = ledgerFixture(t);
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,source_feed,basis_state,recorded_at)
    SELECT 'destination',entity_slug,'loan','liability','5678',feed_mode,provenance,source_feed,basis_state,recorded_at FROM fin_accounts`);
  f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at) SELECT 'destination',coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at FROM fin_account_coverage`);
  if (savings) {
    f.raw("INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,source_feed,basis_state,recorded_at) SELECT 'savings',entity_slug,'savings','asset','9012',feed_mode,provenance,source_feed,basis_state,recorded_at FROM fin_accounts WHERE account_slug='fixture-account'");
    f.raw("INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at) SELECT 'savings',coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at FROM fin_account_coverage WHERE account_slug='fixture-account'");
  }
  return f;
}
function series(f, prefix, description, payee, cents, category = null, counterpart = false) {
  for (const date of dates) {
    f.add(prefix + date, description, payee, {date, cents, direction: 'outflow'});
    if (category) f.raw('UPDATE fin_transactions SET category=? WHERE txn_uid=?', category, prefix + date);
    if (counterpart) f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,provenance,source_feed,basis_state,recorded_at)
      VALUES (?,'destination',?,?,'inflow','Transfer from checking 1234','feed','bank-feed:fixture-feed','confirmed','2026-10-12T12:00:00Z')`, prefix + 'in' + date, date, cents);
  }
}
function check(body, expected, {aside = true} = {}) {
  const l = body.ledger;
  assert.ok(l, JSON.stringify(body));
  assert.equal(l.confirmed_subtotal_minor + l.set_aside_recurring.reduce((n, g) => n + g.amount_minor, 0), expected);
  if (aside) {
    assert.equal(l.total_minor, null);
    assert.equal(l.monthly_total_minor, null);
    assert.equal(l.lead_monthly_total_minor, null);
    assert.equal(l.if_own_transfers.monthly_total_minor, null);
    assert.equal(l.complete, false);
    assert.ok(l.set_aside_recurring.length);
    for (const g of l.set_aside_recurring) {
      assert.deepEqual(g.dates, dates);
      assert.equal(g.cadence, 'monthly');
      assert.ok(g.payee);
    }
  } else assert.equal(l.total_minor, expected);
  const stale = {...body, answer: 'No recurring charges detected. Estimated monthly total: $0.00.'};
  for (const text of [body.answer, apiText(body), appText(body), apiText(stale), appText(stale)]) {
    if (aside) {
      assert.doesNotMatch(text, /(?:estimated monthly (?:total|money out)|no recurring charges|none found|\$0\.00)/i);
      assert.match(text, /These may be payments to your own accounts, so they are not counted\./);
      for (const g of l.set_aside_recurring) {
        assert.ok(text.includes(g.payee));
        assert.ok(text.includes(dollars(g.amount_minor)), text);
      }
    } else if (text !== stale.answer) {
      const printed = text.match(/Estimated monthly total: \$([\d,]+\.\d{2})/);
      if (printed) assert.equal(Math.round(Number(printed[1].replaceAll(',', '')) * 100), expected);
    }
  }
}

// Exact inputs named in B1-B3; the review did not carry its remaining wordings.
const controls = [
  ['loan insurance premium', 'Service Unit', 6197],
  ['Monthly online course subscription', 'Loan Advice Unit', 3217],
  ['Invoice ID 1234', 'Service Unit', 4299],
  ['Reference ID 5678', 'Service Unit', 4299], ['Ref ID 5678', 'Service Unit', 4299],
  ['Invoice identifier 1234', 'Service Unit', 4299], ['Invoice reference ID 1234', 'Service Unit', 4299],
  ...['loan', 'mortgage', 'savings', 'checking', 'liability'].flatMap(noun =>
    ['insurance premium', 'advisory fee', 'education service', 'protection plan', 'monitoring fee', 'support service', 'analysis fee', 'training service'].map((service, i) =>
      [noun + ' ' + service, 'Service Unit', noun === 'mortgage' && i === 0 ? 5675 : noun === 'savings' && i === 1 ? 6443 : 2001 + i])),
  ...['Card Protection Unit', 'Loan Advice Unit', 'Mortgage Education Unit', 'Savings Advice Unit', 'Checking Advice Unit', 'Liability Advice Unit', 'Loan Training Unit', 'Savings Training Unit', 'Mortgage Protection Unit'].map(payee =>
    ['loan monitoring subscription payment', payee, 3217]),
];
for (const [description, payee, cents] of controls) test(description + '/' + payee, async t => {
  const f = setup(t, description.startsWith('savings ')); series(f, 'charge', description, payee, cents);
  const body = await f.ask('What do I pay for every month?');
  check(body, cents, {aside: body.ledger.recurring.length === 0});
});

test('mixed confirmed and set-aside lists retain amounts and exclude proved movements', async t => {
  const f = setup(t);
  series(f, 'charge', 'loan insurance premium', 'Service Unit', 6197);
  series(f, 'confirmed', 'Cloud service', 'Cloud Unit', 1201);
  series(f, 'owned', 'Transfer to loan 5678', null, 4703, null, true);
  series(f, 'provider', 'Scheduled movement', 'Provider Unit', 1883, 'TRANSFER_OUT');
  series(f, 'payment', 'Scheduled allocation', 'Payment Unit', 2857, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT');
  const body = await f.ask('What do I pay for every month?');
  check(body, 7398);
  assert.equal((body.answer.match(/Confirmed recurring charges estimated monthly subtotal:/g) || []).length, 1);
  assert.equal((body.answer.match(/Service Unit:/g) || []).length, 1);
  const qualification = 'This covers all your accounts because the requested account was not identified.';
  const qualified = {...body, answer: body.answer + '\n' + qualification};
  for (const text of [apiText(qualified), appText(qualified)]) assert.ok(text.includes(qualification));
});

test('one unresolved posting keeps the entire detected series visible', async t => {
  const f = setup(t);
  series(f, 'charge', 'Cloud service', 'Cloud Unit', 1999);
  f.raw("UPDATE fin_transactions SET description='Invoice ID 1234' WHERE posted_on='2026-09-07'");
  check(await f.ask('What do I pay for every month?'), 1999);
});

test('an uncertain series cannot erase a confirmed series with the same payee', async t => {
  const f = setup(t);
  series(f, 'confirmed', 'Independent service', 'Service Unit', 1201);
  series(f, 'uncertain', 'loan insurance premium', 'Service Unit', 6197);
  check(await f.ask('What do I pay for every month?'), 7398);
});

test('80 owned-target controls retain R2 membership and exact set-aside amounts', async t => {
  const f = setup(t, true); let count = 0;
  for (const target of ['our loan', 'the loan', 'mortgage', 'liability account', 'checking', 'savings', 'account 1234', '5678']) {
    for (const action of ['Payment for', 'Scheduled allocation toward', 'Reserve for', 'Autopay for', 'Periodic allocation for', 'Routing toward', 'Standing order for', 'Monthly remittance for', 'Settlement for', 'Contribution toward']) {
      f.raw('DELETE FROM fin_transactions');
      const cents = 47 + count++ * 137;
      series(f, 'target', action + ' ' + target, 'Service Unit', cents);
      const body = await f.ask('What do I pay for every month?');
      assert.equal(body.ledger.recurring.length, 0);
      check(body, cents);
    }
  }
  t.diagnostic('owned_controls=80 wrong_figures=0');
});

test('640 generated ledgers: conservation and proved-owned exclusion, seed 0x5a17427', async t => {
  const f = setup(t, true); let seed = 0x5a17427, setAside = 0;
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const nouns = ['loan', 'mortgage', 'checking', 'savings', 'liability'];
  const services = ['review fee', 'support plan', 'education premium', 'advisory service'];
  for (let i = 0; i < 640; i++) {
    f.raw('DELETE FROM fin_transactions');
    const a = 1 + next() % 8000, b = 1 + next() % 8000;
    const noun = nouns[next() % nouns.length], service = services[next() % services.length];
    series(f, 'external', 'Independent service', i % 5 ? 'Cloud Unit' : 'Service Unit', a);
    const aside = i % 4 !== 0;
    if (aside) series(f, 'uncertain', noun + ' ' + service, 'Service Unit', b);
    series(f, 'owned', 'Transfer to loan 5678', null, 1 + next() % 8000, null, true);
    series(f, 'provider', 'Scheduled movement', 'Provider Unit', 1 + next() % 8000, 'TRANSFER_OUT');
    const body = await f.ask('What do I pay for every month?');
    check(body, a + (aside ? b : 0), {aside});
    assert.ok(body.ledger.recurring.every(g => !/provider|transfer/i.test(g.merchant)));
    assert.ok(body.ledger.set_aside_recurring.every(g => g.payee === 'Service Unit'));
    setAside += body.ledger.set_aside_recurring.length;
  }
  t.diagnostic(`cases=640 wrong_figures=0 set_aside=${setAside}`);
});


for (const question of ['What do I pay for every month?', 'Show recurring charges and the paying account']) {
  test('possible own series outside connected account kinds stays uncertified: ' + question, async t => {
    t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
    const f = setup(t);
    series(f, 'ordinary', 'Cloud service', 'Cloud Unit', 1201);
    const green = await f.ask(question);
    assert.equal(green.ledger.recurring.length, 1, 'ordinary cadence decision reached');
    assert.equal(green.ledger.total_minor, 1201);
    assert.equal(green.evidence_gate.complete, true);

    // Brokerage is deliberately absent from the connected account kinds. The
    // shared possible-payment decision must still mark the retained series.
    series(f, 'possible', 'Transfer to brokerage', null, 6760);
    const changes = f.first('SELECT total_changes() n').n, before = f.calls.length;
    const body = await f.ask(question);
    assert.ok(f.calls.slice(before).some(sql => /JOIN fin_transactions/.test(sql)), 'transaction decision reached');
    assert.equal(f.first('SELECT total_changes() n').n, changes, 'reading writes nothing');
    check(body, 7961);
    assert.equal(body.evidence_gate.complete, false);
    assert.equal(body.ledger.confirmed_subtotal_minor, 1201);
    assert.equal(body.ledger.recurring.length, 1);
    assert.equal(body.ledger.set_aside_recurring.length, 1);
    assert.equal(body.ledger.set_aside_recurring[0].amount_minor, 6760);
    assert.equal(body.ledger.possible_owned_movements.length, 3, 'possible-payment decision reached');
    for (const posting of body.ledger.possible_owned_movements) {
      assert.equal(posting.amount_minor, 6760);
      assert.ok(body.citations.some(c => c.n === posting.n && c.amount_minor === 6760));
    }
    assert.equal(f.documentCalls, 0);
  });
}
