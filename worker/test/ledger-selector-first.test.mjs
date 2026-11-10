import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';

const cardCode = 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT';
const dates = ['2026-08-05', '2026-09-05', '2026-10-05'];
function setup(t) {
  const f = ledgerFixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  t.mock.method(Date, 'now', () => Date.parse(NOW));
  f.put = (id, cents, { date = dates[2], payee = 'Payment Unit', description = 'Ordinary charge', category = 'GENERAL_SERVICES' } = {}) => {
    f.add(id, description, payee, { date, cents, direction: 'outflow' });
    f.raw('UPDATE fin_transactions SET category=?,category_basis_state=? WHERE txn_uid=?', category, category ? 'confirmed' : null, id);
  };
  f.series = (id, cents, options) => dates.forEach(date => f.put(`${id}-${date}`, cents, { ...options, date }));
  f.askReached = async (question, kind, selector, answerPath = withLedgerAnswer, { requireLedger = true } = {}) => {
    const start = f.calls.length, changes = f.first('SELECT total_changes() n').n;
    f.env.RERANK_MODEL = 'claude-haiku-4-5-20251001';
    f.env.ANTHROPIC_API_KEY = randomBytes(24).toString('hex');
    let interpretations = 0;
    const response = await answerPath({ env: f.env, question, now: NOW, grantScope: { all: true }, scopePrincipalKind: 'owner',
      callLLM: async () => {
        interpretations++;
        return { content: [{ type: 'text', text: JSON.stringify({ ambiguous: false, unanswered_part: null,
          intents: [{ kind, direction: 'outflow', count: null, vendor_text: selector, account_hint: null,
            amount_text: null, date_text: null, period: { type: 'none' } }] }) }] };
      },
    }, () => assert.fail('unexpected document fallback'));
    const b = await response.json();
    assert.equal(interpretations, 1, 'validated interpretation reached');
    assert.ok(f.calls.slice(start).some(sql => /JOIN fin_transactions/.test(sql)), 'real transaction decision reached');
    assert.ok(f.first('SELECT count(*) n FROM fin_transactions').n > 0, 'nonempty decision pool');
    assert.equal(f.first('SELECT total_changes() n').n, changes, 'reader remains read-only');
    if (requireLedger) assert.ok(b.ledger, 'ledger decision reached');
    return b;
  };
  return f;
}
function paymentEvidence(b, amount, count) {
  const p = b.ledger.payment_exclusions;
  assert.equal(p?.total_minor, amount, 'selected payment membership reached');
  assert.equal(p.count, count);
  for (const row of p.rows) {
    const refs = b.citations.filter(c => c.n === row.n);
    assert.equal(refs.length, 1, 'exactly one payment citation');
    assert.equal(refs[0].amount_minor, row.amount_minor);
    assert.equal(refs[0].posted_on, row.posted_on);
    assert.ok(b.answer.includes(`[${row.n}]`));
    const item = b.answer.split('\n').find(line => /^payment to /i.test(line) && line.includes(`[${row.n}]`));
    const amount = (row.amount_minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const date = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' }).format(new Date(`${row.posted_on}T00:00:00Z`));
    assert.ok(item?.includes(`$${amount} on ${date}`), 'each payment keeps its exact amount and date on a cited item');
    assert.ok(item.includes(refs[0].account_mask), 'each item names the posting account');
  }
}
function noSubstitution(b) {
  assert.doesNotMatch(b.answer, /other unit|\$123\.45/i, 'another payee cannot supply the named figure');
  assert.ok(!(b.ledger.recurring || []).some(row => row.merchant === 'other unit'));
}
function namedRefusal(b) {
  noSubstitution(b);
  assert.equal(b.ledger.selector_applied, false);
  assert.equal(b.ledger.monthly_total_minor, null, 'unresolved identity has no named amount');
  assert.equal(b.ledger.total_minor, null);
  assert.deepEqual(b.ledger.recurring, []);
  assert.equal(b.ledger.complete, false);
  assert.match(b.answer, /precise payee|exact payee|precise selector/i);
  assert.doesNotMatch(b.answer, /Estimated monthly total:/);
}
for (const selector of ['Software', 'Supplies', 'Materials']) test(`B1 merchant identity precedes payment partition: ${selector}`, async t => {
  const f = setup(t);
  f.put('other', 12345, { payee: 'Other Unit', category: selector.toUpperCase() });
  f.put('selected', 2789, { payee: selector });
  const q = `Could you retrieve spending at ${selector} this month?`;
  const green = await f.askReached(q, 'merchant', selector);
  assert.equal(green.ledger.total_minor, 2789);
  f.raw("UPDATE fin_transactions SET category=? WHERE txn_uid='selected'", cardCode);
  const b = await f.askReached(q, 'merchant', selector);
  paymentEvidence(b, 2789, 1); noSubstitution(b);
  assert.equal(b.ledger.total_minor, 0);
  assert.equal(b.ledger.selector_applied, true);
  assert.match(b.answer, /payment to a card: \$27\.89/i);
  assert.match(b.answer, /Oct(?:ober)? 5(?:,? 2026)?/);
});
for (const shape of ['description-only', 'structured-family', 'absent']) test(`B2 unresolved named recurring identity refuses figures: ${shape}`, async t => {
  const f = setup(t);
  f.series('other', 12345, { payee: 'Other Unit' });
  f.series('selected', 2789, { category: cardCode, description: 'Payment Unit' });
  const q = 'Could you retrieve recurring charges at Payment Unit?';
  const green = await f.askReached(q, 'recurring', 'Payment Unit');
  paymentEvidence(green, 8367, 3);
  assert.equal(green.ledger.selector_applied, true);
  assert.equal(green.ledger.monthly_total_minor, 0); noSubstitution(green);
  f.raw("UPDATE fin_transactions SET payee=?,description=? WHERE txn_uid LIKE 'selected-%'",
    shape === 'description-only' ? null : shape === 'structured-family' ? 'Payment Unit Card' : 'Unrelated Unit',
    shape === 'absent' ? 'Unrelated payment' : 'Payment Unit');
  const b = await f.askReached(q, 'recurring', 'Payment Unit');
  namedRefusal(b);
  if (shape !== 'absent') {
    paymentEvidence(b, 8367, 3);
    assert.ok(b.ledger.payment_exclusions.rows.every(row => row.match_basis === 'possible'));
    assert.match(b.answer, /possible.*payee attribution remains unconfirmed/i);
  } else assert.equal(b.ledger.payment_exclusions, undefined);
});
for (const category of [cardCode, 'LOAN_PAYMENTS']) test(`N2 exact recurring payments retain identity and dates: ${category}`, async t => {
  const f = setup(t);
  f.series('other', 12345, { payee: 'Other Unit' }); f.series('selected', 2789);
  const q = 'Could you retrieve recurring charges at Payment Unit?';
  assert.equal((await f.askReached(q, 'recurring', 'Payment Unit')).ledger.monthly_total_minor, 2789);
  f.raw("UPDATE fin_transactions SET category=? WHERE txn_uid LIKE 'selected-%'", category);
  const b = await f.askReached(q, 'recurring', 'Payment Unit');
  paymentEvidence(b, 8367, 3); noSubstitution(b);
  assert.equal(b.ledger.selector_applied, true);
  assert.equal(b.ledger.monthly_total_minor, 0);
  assert.deepEqual(b.ledger.recurring, []);
  assert.equal(b.answer.split('\n').filter(line => /^payment to a (?:card|loan): \$27\.89/i.test(line)).length, 3, 'all three named payments are itemized instead of only a total');
  for (const month of ['Aug', 'Sep', 'Oct']) assert.match(b.answer, new RegExp(`${month}(?:ust|tember|ober)? 5(?:,? 2026)?`));
});
test('mixed named recurring charges partition only the resolved payee', async t => {
  const f = setup(t); f.series('other', 12345, { payee: 'Other Unit' }); f.series('selected', 789);
  const q = 'Could you retrieve recurring charges at Payment Unit?';
  assert.equal((await f.askReached(q, 'recurring', 'Payment Unit')).ledger.monthly_total_minor, 789);
  f.series('payment', 2789, { category: cardCode });
  const b = await f.askReached(q, 'recurring', 'Payment Unit');
  assert.equal(b.ledger.monthly_total_minor, 789); noSubstitution(b); paymentEvidence(b, 8367, 3);
});
for (const mixed of [false, true]) test(`D1 monthly payment amount retains possible attribution: mixed=${mixed}`, async t => {
  const f = setup(t); f.series('ordinary', 12345, { payee: 'Service Unit' });
  f.series('possible', 2789, { payee: null, description: 'Service Unit payment', category: cardCode });
  if (mixed) f.series('exact-payment', 321, { payee: 'Service Unit', category: cardCode });
  const single = await f.askReached('Could you retrieve spending at Service Unit this month?', 'merchant', 'Service Unit');
  assert.equal(single.ledger.total_minor, 12345);
  paymentEvidence(single, mixed ? 3110 : 2789, mixed ? 2 : 1);
  assert.match(single.answer, /possible vendor-description matches.*payee attribution remains unconfirmed/);
  const b = await f.askReached('Could you retrieve Service Unit charges month by month since August?', 'merchant', 'Service Unit');
  assert.deepEqual(b.ledger.months.map(m => m.total_minor), [12345, 12345, 12345]);
  for (const month of b.ledger.months) {
    assert.equal(month.payment_exclusions.total_minor, mixed ? 3110 : 2789);
    assert.equal(month.payment_exclusions.rows.filter(row => row.match_basis === 'possible').length, 1);
    const line = b.answer.split('\n').find(line => line.startsWith(month.label + ':'));
    assert.match(line, /possible vendor-description matches.*payee attribution remains unconfirmed/);
    assert.match(line, /\$27\.89 in possible/);
  }
});

async function mutatedAnswer(changes, monthlyChanges = []) {
  const url = new URL('../src/lib/ledger-answer.js', import.meta.url);
  const absolute = (source, base) => source.replace(/from (["'])(\.\/[^"'\n]+)\1/g,
    (_, quote, path) => `from ${JSON.stringify(new URL(path, base).href)}`);
  const data = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const replace = (source, pairs) => pairs.reduce((text, [from, to]) => {
    assert.equal(text.split(from).length - 1, 1, 'exactly one mutation site');
    return text.replace(from, to);
  }, source);
  let source = replace(readFileSync(url, 'utf8'), changes);
  if (monthlyChanges.length) {
    const monthlyUrl = new URL('./ledger-monthly.js', url);
    const monthly = data(absolute(replace(readFileSync(monthlyUrl, 'utf8'), monthlyChanges), monthlyUrl));
    source = source.replace('"./ledger-monthly.js"', JSON.stringify(monthly));
  }
  return (await import(data(absolute(source, url)))).withLedgerAnswer;
}
for (const [id, changes] of [
  ['partition before selector', [['const identityRows = windowRows;', 'const identityRows = windowRows.filter(row => !loanCardPaymentKind(row, bySlug));']]],
  ['fallback to another payee', [
    ['if (intent.recurringSelector && !recurringSelectorResolved) {', 'if (false) {'],
    ["const rows = intent.kind === 'recurring' && namedSelection", "const rows = intent.kind === 'recurring' && namedSelection?.resolved"],
  ]],
  ['selector_applied=false with a figure', [
    ['recurring: [], monthly_total_minor: null, total_minor: null,', 'recurring: [], monthly_total_minor: sumMinor(detectRecurring(allRows, intent.to), group => group.monthly_minor), total_minor: 0,'],
  ]],
]) test(`selector-first mutation killed: ${id}`, async t => {
  const mutant = await mutatedAnswer(changes);
  const f = setup(t), merchant = id === 'partition before selector';
  const selector = merchant ? 'Software' : 'Payment Unit';
  const q = merchant ? 'Could you retrieve spending at Software this month?' : 'Could you retrieve recurring charges at Payment Unit?';
  const kind = merchant ? 'merchant' : 'recurring';
  f.series('other', 12345, { payee: 'Other Unit', category: 'SOFTWARE' });
  f.series('selected', 2789, { payee: selector, description: selector });
  const value = b => merchant ? b.ledger.total_minor : b.ledger.monthly_total_minor;
  for (const answer of [withLedgerAnswer, mutant]) {
    const green = await f.askReached(q, kind, selector, answer);
    assert.equal(value(green), 2789, 'intact and mutant both pass the reached ordinary control');
  }
  f.raw("UPDATE fin_transactions SET category=?,payee=? WHERE txn_uid LIKE 'selected-%'", cardCode, merchant ? selector : null);
  const oracle = merchant ? b => {
    paymentEvidence(b, 2789, 1); noSubstitution(b);
    assert.equal(b.ledger.selector_applied, true);
    assert.equal(b.ledger.total_minor, 0);
  } : namedRefusal;
  oracle(await f.askReached(q, kind, selector));
  const changed = await f.askReached(q, kind, selector, mutant);
  if (['fallback to another payee', 'selector_applied=false with a figure'].includes(id)) {
    // The final post-condition now contains this earlier route mutation.
    // Removing both defenses must still make the unchanged refusal oracle red.
    assert.equal(changed.ledger.named_selector_guard?.rejected, true, 'final guard decision reached');
    oracle(changed);
    const unguarded = await mutatedAnswer([...changes, [
      'async function guardNamedSelector(env, intent, result) {',
      'async function guardNamedSelector(env, intent, result) { return result;',
    ]]);
    const leaked = await f.askReached(q, kind, selector, unguarded);
    assert.throws(() => oracle(leaked), assert.AssertionError, 'removing both defenses exposes the original mutant');
    return;
  }
  assert.throws(() => oracle(changed), assert.AssertionError, 'same reader oracle kills the reached mutant');
});
test('selector-first mutation killed: monthly possible qualifier dropped', async t => {
  const mutant = await mutatedAnswer([], [[
    "const possiblePayments = payments?.rows.filter(row => row.match_basis === 'possible') || [];",
    'const possiblePayments = [];',
  ]]);
  const f = setup(t); f.series('ordinary', 12345, { payee: 'Service Unit' });
  const q = 'Could you retrieve Service Unit charges month by month since August?';
  for (const answer of [withLedgerAnswer, mutant]) {
    const green = await f.askReached(q, 'merchant', 'Service Unit', answer);
    assert.deepEqual(green.ledger.months.map(m => m.total_minor), [12345, 12345, 12345]);
  }
  f.series('possible', 2789, { payee: null, description: 'Service Unit payment', category: cardCode });
  const oracle = b => {
    for (const month of b.ledger.months) {
      assert.equal(month.payment_exclusions.total_minor, 2789, 'payment composition reached');
      assert.equal(month.payment_exclusions.rows[0].match_basis, 'possible');
      assert.match(b.answer.split('\n').find(line => line.startsWith(month.label + ':')),
        /\$27\.89 in possible vendor-description matches.*payee attribution remains unconfirmed/);
    }
  };
  oracle(await f.askReached(q, 'merchant', 'Service Unit'));
  const changed = await f.askReached(q, 'merchant', 'Service Unit', mutant);
  assert.throws(() => oracle(changed), assert.AssertionError, 'same oracle kills the reached composition mutant');
});

for (const shape of ['description-only', 'ambiguous-prefix']) test(`unresolved merchant payment identity cannot substitute a payee: ${shape}`, async t => {
  const f = setup(t), selector = shape === 'ambiguous-prefix' ? 'Unit' : 'Payment Unit';
  f.put('other', 12345, { payee: 'Other Counterparty' });
  f.put('selected', 2789, { payee: selector, description: selector });
  const q = `Could you retrieve spending at ${selector} this month?`;
  assert.equal((await f.askReached(q, 'merchant', selector)).ledger.total_minor, 2789);
  f.raw("UPDATE fin_transactions SET category=?,payee=? WHERE txn_uid='selected'", cardCode,
    shape === 'description-only' ? null : 'Unit Branch');
  const b = await f.askReached(q, 'merchant', selector);
  noSubstitution(b);
  assert.ok(!Number.isSafeInteger(b.ledger.total_minor), 'uncertain identity has no named amount');
  assert.equal(b.ledger.complete, false);
  paymentEvidence(b, 2789, 1);
  assert.equal(b.ledger.payment_exclusions.rows[0].match_basis, 'possible');
});
test('payment-only accepted vendor family retains identity ahead of category fallback', async t => {
  const f = setup(t); f.put('other', 12345, { payee: 'Other Unit', category: 'SOFTWARE' });
  f.put('selected', 2789, { payee: 'Software Cloud' });
  const q = 'Could you retrieve spending at Software this month?';
  const green = await f.askReached(q, 'merchant', 'Software');
  assert.equal(green.ledger.total_minor, null, 'S6 keeps family identity unconfirmed');
  assert.equal(green.ledger.name_match_subtotal_minor, 2789);
  f.raw("UPDATE fin_transactions SET category=? WHERE txn_uid='selected'", cardCode);
  const b = await f.askReached(q, 'merchant', 'Software');
  noSubstitution(b); paymentEvidence(b, 2789, 1);
  assert.equal(b.ledger.match_basis, 'family');
  assert.equal(b.ledger.selector_applied, true);
  assert.match(b.answer, /payment to a card: \$27\.89/i);
});
test('named largest payment-only selection leads with the selected payment and dates', async t => {
  const f = setup(t); f.put('other', 12345, { payee: 'Other Unit' }); f.put('selected', 2789);
  const q = 'Could you retrieve the largest charge at Payment Unit this month?';
  const green = await f.askReached(q, 'largest', 'Payment Unit');
  assert.deepEqual(green.ledger.lead_rows.map(row => row.amount_minor), [2789]);
  f.raw("UPDATE fin_transactions SET category=? WHERE txn_uid='selected'", cardCode);
  const b = await f.askReached(q, 'largest', 'Payment Unit');
  assert.deepEqual(b.ledger.lead_rows, []);
  assert.equal(b.ledger.selector_applied, true);
  assert.match(b.answer, /payment to a card: \$27\.89 on October 5/i);
  paymentEvidence(b, 2789, 1);
});
test('named payment dates exclude unrelated postings from ranking context', async t => {
  const f = setup(t); f.put('selected', 2789);
  const q = 'Could you retrieve the largest charge at Payment Unit this month?';
  const green = await f.askReached(q, 'largest', 'Payment Unit');
  assert.deepEqual(green.ledger.lead_rows.map(row => row.amount_minor), [2789]);
  f.raw("UPDATE fin_transactions SET category=? WHERE txn_uid='selected'", cardCode);
  const selectedOnly = await f.askReached(q, 'largest', 'Payment Unit');
  const header = b => b.answer.split('\n').find(line => /^payment to a card:/.test(line));
  assert.match(header(selectedOnly), /\$27\.89 on October 5/);
  f.put('other-payment', 2789, { payee: 'Other Unit', category: cardCode, date: '2026-10-06' });
  const b = await f.askReached(q, 'largest', 'Payment Unit');
  // Final named-selector contract: even the appendix belongs to this payee.
  assert.equal(b.ledger.payment_exclusions.count, 1, 'named ranking discloses only its selected posting');
  assert.equal(b.ledger.payment_exclusions.total_minor, 2789);
  assert.ok(b.citations.every(ref => ref.posted_on === '2026-10-05'));
  assert.match(header(b), /\$27\.89 on October 5/);
  assert.doesNotMatch(header(b), /October 6/, 'only the selected posting may supply named payment dates');
});
test('known literal conjunction identity survives payment-only partition', async t => {
  const f = setup(t);
  f.put('other', 12345, { payee: 'A and B' }); f.put('selected', 2789, { payee: 'A & B' });
  const q = 'Could you retrieve spending at A & B this month?';
  const green = await f.askReached(q, 'merchant', 'A & B');
  assert.equal(green.ledger.total_minor, 2789);
  f.raw("UPDATE fin_transactions SET category=? WHERE txn_uid='selected'", cardCode);
  const b = await f.askReached(q, 'merchant', 'A & B');
  assert.equal(b.ledger.selector_applied, true);
  assert.equal(b.ledger.total_minor, 0);
  assert.match(b.answer, /payment to a card: \$27\.89/i);
  assert.doesNotMatch(b.answer, /\$123\.45|a and b/i);
  paymentEvidence(b, 2789, 1);
});
test('exact recurring identity excludes a similar payee from every account figure', async t => {
  const f = setup(t); f.series('selected', 789);
  const q = 'Could you retrieve recurring charges at Payment Unit?';
  const green = await f.askReached(q, 'recurring', 'Payment Unit');
  assert.equal(green.ledger.monthly_total_minor, 789);
  assert.equal(green.ledger.if_own_transfers.accounts[0].debits_minor, 2367);
  f.series('similar', 12345, { payee: 'Payment Unit Card' });
  const b = await f.askReached(q, 'recurring', 'Payment Unit');
  assert.equal(b.ledger.monthly_total_minor, 789);
  assert.equal(b.ledger.if_own_transfers.accounts[0].debits_minor, 2367, 'named account figures keep the resolved identity too');
  assert.deepEqual(b.ledger.recurring.map(row => row.merchant), ['payment unit']);
  assert.doesNotMatch(b.answer, /\$123\.45/);
});

function refundOnlyEvidence(b, selector) {
  noSubstitution(b);
  assert.equal(b.ledger.kind, 'merchant');
  assert.equal(b.ledger.total_minor, 0);
  assert.equal(b.ledger.selector_applied, true);
  assert.equal(b.ledger.refunds_received_minor, 2789);
  assert.match(b.answer, new RegExp(`no spending at ${selector}; refunds received: \\$27\\.89`, 'i'));
  assert.equal(b.citations.length, 1);
  assert.equal(b.citations[0].amount_minor, 2789);
  assert.equal(b.citations[0].posted_on, dates[2]);
  assert.ok(b.answer.includes(`[${b.citations[0].n}]`));
}
for (const selector of ['Software', 'Supplies', 'Materials', 'Store Unit']) test(`S1 refund-only identity precedes direction selection: ${selector}`, async t => {
  const f = setup(t), q = `Could you retrieve spending at ${selector} this month?`;
  f.put('other', 12345, { payee: 'Other Unit', category: selector.toUpperCase() });
  f.put('selected', 2789, { payee: selector });
  assert.equal((await f.askReached(q, 'merchant', selector)).ledger.total_minor, 2789, 'ordinary control reached');
  f.raw("UPDATE fin_transactions SET direction='inflow',description='Purchase refund',category='REFUND' WHERE txn_uid='selected'");
  const b = await f.askReached(q, 'merchant', selector);
  f.raw("UPDATE fin_transactions SET category='GENERAL_SERVICES' WHERE txn_uid='other'");
  refundOnlyEvidence(await f.askReached(q, 'merchant', selector), selector);
  refundOnlyEvidence(b, selector);
});
for (const category of [cardCode, 'LOAN_PAYMENTS']) test(`S1 receiving-only payment retains merchant identity: ${category}`, async t => {
  const f = setup(t), q = 'Could you retrieve spending at Software this month?';
  f.put('other', 12345, { payee: 'Other Unit', category: 'SOFTWARE' });
  f.put('selected', 2789, { payee: 'Software', category });
  const green = await f.askReached(q, 'merchant', 'Software');
  assert.equal(green.ledger.total_minor, 0); paymentEvidence(green, 2789, 1);
  f.raw("UPDATE fin_transactions SET direction='inflow' WHERE txn_uid='selected'");
  const b = await f.askReached(q, 'merchant', 'Software');
  noSubstitution(b); paymentEvidence(b, 2789, 1);
  assert.equal(b.ledger.total_minor, 0);
  assert.equal(b.ledger.selector_applied, true);
  assert.equal(b.ledger.payment_exclusions.rows[0].direction, 'inflow');
  assert.match(b.answer, /payment to a (?:card|loan): \$27\.89 on October 5/i);
  assert.doesNotMatch(b.answer, /refunds received/i);
});
function descriptionMixedEvidence(b) {
  assert.ok(b.ledger, 'description selection retains a ledger decision');
  noSubstitution(b); paymentEvidence(b, 2789, 1);
  assert.equal(b.ledger.total_minor, null, 'description subtotal is never a named merchant total');
  assert.equal(b.ledger.possible_subtotal_minor, 789);
  assert.equal(b.ledger.complete, false);
  assert.equal(b.ledger.match_basis, 'possible');
  assert.equal(b.ledger.payment_exclusions.rows[0].match_basis, 'possible');
  assert.match(b.answer, /description.*\$7\.89/i);
  assert.match(b.answer, /payee attribution remains unconfirmed/i);
  assert.doesNotMatch(b.answer, /different.*(?:and|&).*spellings/i);
  const ordinary = b.citations.filter(c => c.amount_minor === 789);
  assert.equal(ordinary.length, 1, 'ordinary description subtotal is cited');
  assert.ok(b.answer.includes(`[${ordinary[0].n}]`));
}
for (const category of [cardCode, 'LOAN_PAYMENTS']) test(`S2 description-only mixed selection keeps ordinary subtotal and excluded payment: ${category}`, async t => {
  const f = setup(t), q = 'Could you retrieve spending at Payment Unit this month?';
  f.put('other', 12345, { payee: 'Other Counterparty' });
  f.put('purchase', 789, { description: 'Payment Unit' });
  f.put('payment', 2789, { description: 'Payment Unit', category });
  const green = await f.askReached(q, 'merchant', 'Payment Unit');
  assert.equal(green.ledger.total_minor, 789); paymentEvidence(green, 2789, 1);
  f.raw("UPDATE fin_transactions SET payee=NULL WHERE txn_uid IN ('purchase','payment')");
  const b = await f.askReached(q, 'merchant', 'Payment Unit');
  f.raw("UPDATE fin_transactions SET description='Payment Unit purchase' WHERE txn_uid='purchase'");
  descriptionMixedEvidence(await f.askReached(q, 'merchant', 'Payment Unit'));
  descriptionMixedEvidence(b);
});

for (const finding of ['S1', 'S2']) test(`selector-first R1 mutant killed: ${finding}`, async t => {
  const changes = finding === 'S1' ? [[
    '...selectVendorFamily(identityRows, intent.match, { allowProductFamily: !intent.protectedPayee })',
    '...selectVendorFamily(identityRows.filter(row => row.direction === intent.direction), intent.match, { allowProductFamily: !intent.protectedPayee })',
  ]] : [[
    'return merchant !== wantedMerchant && conjunction(merchant) === conjunction(wantedMerchant);',
    'return conjunction(merchant) === conjunction(wantedMerchant);',
  ]];
  const mutant = await mutatedAnswer(changes), f = setup(t);
  const selector = finding === 'S1' ? 'Software' : 'Payment Unit';
  const q = `Could you retrieve spending at ${selector} this month?`;
  f.put('other', 12345, { payee: 'Other Counterparty', category: 'SOFTWARE' });
  f.put('selected', finding === 'S1' ? 2789 : 789, { payee: selector, description: selector });
  if (finding === 'S2') f.put('payment', 2789, { description: selector, category: cardCode });
  for (const answer of [withLedgerAnswer, mutant]) {
    const green = await f.askReached(q, 'merchant', selector, answer);
    assert.equal(green.ledger.total_minor, finding === 'S1' ? 2789 : 789, 'intact and mutant pass the nonempty ordinary control');
  }
  if (finding === 'S1') f.raw("UPDATE fin_transactions SET direction='inflow',description='Purchase refund',category='REFUND' WHERE txn_uid='selected'");
  else f.raw("UPDATE fin_transactions SET payee=NULL WHERE txn_uid IN ('selected','payment')");
  const oracle = finding === 'S1' ? b => refundOnlyEvidence(b, selector) : descriptionMixedEvidence;
  oracle(await f.askReached(q, 'merchant', selector));
  const changed = await f.askReached(q, 'merchant', selector, mutant, { requireLedger: false });
  assert.throws(() => oracle(changed), assert.AssertionError, 'same oracle kills the mutant after transaction SQL is reached');
});

test('a nonrefund incoming merchant row establishes identity without inventing a refund', async t => {
  const f = setup(t), q = 'Could you retrieve spending at Software this month?';
  f.put('other', 12345, { payee: 'Other Unit', category: 'SOFTWARE' });
  f.put('selected', 2789, { payee: 'Software' });
  assert.equal((await f.askReached(q, 'merchant', 'Software')).ledger.total_minor, 2789);
  f.raw("UPDATE fin_transactions SET direction='inflow',description='Incoming credit' WHERE txn_uid='selected'");
  const b = await f.askReached(q, 'merchant', 'Software');
  noSubstitution(b);
  assert.equal(b.ledger.total_minor, 0);
  assert.equal(b.ledger.inflows_received_minor, 2789);
  assert.equal(b.ledger.refunds_received_minor, 0);
  assert.match(b.answer, /no spending at Software; money received: \$27\.89/i);
  assert.doesNotMatch(b.answer, /refunds received/i);
  assert.equal(b.citations[0].amount_minor, 2789);
});
