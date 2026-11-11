import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';

function setup(t) {
  const f = ledgerFixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  f.put = (id, cents, { direction = 'outflow', date = '2026-10-05', payee = 'Service Unit', description = 'Service charge', category = 'GENERAL_SERVICES', account = 'fixture-account', pending = false } = {}) => {
    f.add(id, description, payee, { cents, direction, date });
    f.raw('UPDATE fin_transactions SET category=?,category_basis_state=?,account_slug=?,pending=? WHERE txn_uid=?', category, category ? 'confirmed' : null, account, Number(pending), id);
  };
  f.account = (slug, mask, kind = 'checking') => {
    f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at)
      VALUES (?,'owner',?,?,?,'manual','owner_stated','confirmed',?)`, slug, kind, kind === 'loan' ? 'liability' : 'asset', mask, NOW);
    f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES (?,'complete','2024-01-01','2026-10-31',?,'owner_stated','confirmed',?)`, slug, NOW, NOW);
  };
  f.read = async (question, path = withLedgerAnswer, intent = null) => {
    if (intent) { f.env.RERANK_MODEL = 'claude-haiku-4-5-20251001'; f.env.ANTHROPIC_API_KEY = randomBytes(24).toString('hex'); }
    let models = 0;
    const start = f.calls.length, changes = f.first('SELECT total_changes() n').n;
    const response = await path({ env: f.env, question, now: NOW, grantScope: { all: true }, scopePrincipalKind: 'owner', callLLM: async () => { models++; assert.ok(intent); return { content: [{ type: 'text', text: JSON.stringify({ ambiguous: false, unanswered_part: null, intents: [{ direction: null, count: null, vendor_text: null, account_hint: null, amount_text: null, date_text: null, period: { type: 'none' }, ...intent }] }) }] }; } }, () => assert.fail('document fallback'));
    assert.equal(models, intent ? 1 : 0, 'intended interpretation reached');
    const b = await response.json();
    assert.ok(b.ledger, 'real ledger path reached');
    assert.ok(f.calls.slice(start).some(sql => /JOIN fin_transactions/.test(sql)), 'transaction decision reached');
    assert.ok(f.first('SELECT count(*) n FROM fin_transactions').n > 0, 'nonempty decision pool');
    assert.equal(f.first('SELECT total_changes() n').n, changes, 'read-only answer');
    return b;
  };
  return f;
}
const summary = 'What did I spend this month, and on what?';
const largest = 'What were my ten largest expenses in October 2026?';
const payment = 'Did the payment of $236.13 from Payer Unit arrive this month in account 1234?';
const dollars = cents => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
function assertPayments(b) {
  const p = b.ledger.payment_exclusions;
  assert.equal(p?.count, 2);
  assert.equal(p.total_minor, 72818);
  for (const [amount, label] of [[70318, 'payment to your own loan (ending 2222)'], [2500, 'payment to a card']]) {
    const posting = p.rows.find(row => row.amount_minor === amount);
    const line = b.answer.split('\n').find(line => line.toLowerCase().includes(label));
    assert.ok(line, label);
    assert.ok(line.includes(dollars(amount)));
    assert.match(line, /October 5(?:, 2026)?.*1234/);
    assert.ok(line.includes(`[${posting.n}]`));
    const ref = b.citations.find(ref => ref.n === posting.n);
    assert.equal(ref.amount_minor, amount); assert.equal(ref.account_mask, '1234');
    assert.equal(ref.posted_on, '2026-10-05');
  }
  assert.equal(new Set(b.citations.map(ref => ref.n)).size, b.citations.length);
}
// Neither an owned destination label nor a bank payment code proves the
// counterpart. Money out retains both unpaired debits and cites the uncertainty.
function assertMoneyOutTotals(b) {
  assert.equal(b.ledger.payment_exclusions, undefined);
  assert.equal(b.ledger.possible_payments.length, 2);
  const loan = b.ledger.possible_payments.find(row => row.amount_minor === 70318);
  assert.ok(loan);
  assert.equal(loan.included_in_total, true);
  assert.equal(loan.bank_text, 'TRANSFER TO LOAN ACCOUNT 2222');
  const loanLine = b.answer.split('\n').find(line => line.includes(`[${loan.n}]`) && line.startsWith('included in money out above, possibly'));
  assert.ok(loanLine && loanLine.includes(dollars(70318)) && loanLine.includes('counterpart not proved'));
  const card = b.ledger.possible_payments.find(row => row.amount_minor === 2500);
  assert.deepEqual([card.amount_minor, card.payment_kind, card.included_in_total], [2500, 'card', true]);
  assert.ok(b.answer.includes(`included in money out above, possibly a card payment (bank payment code) (counterpart not proved): ${dollars(2500)} on October 5`));
  for (const row of [loan, card]) {
    const ref = b.citations.find(ref => ref.n === row.n);
    assert.deepEqual([ref.amount_minor, ref.account_mask, ref.posted_on], [row.amount_minor, '1234', '2026-10-05']);
  }
  assert.equal(b.ledger.possible_payments_included_minor, 70318 + 2500);
  assert.equal(b.ledger.lead_accounts.find(account => account.account_mask === '1234').debits_minor, 164331 + 2500 + 70318);
  assert.equal(new Set(b.citations.map(ref => ref.n)).size, b.citations.length);
}
function addPayments(f) {
  f.account('loan-unit', '2222', 'loan');
  f.put('loan-payment', 70318, { category: 'LOAN_PAYMENTS', payee: null, description: 'TRANSFER TO LOAN ACCOUNT 2222' });
  f.put('card-payment', 2500, { category: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', payee: 'Card Unit', description: 'Card payment' });
}
test('live shape 1: largest expenses itemize excluded own-loan and card payments with evidence', async t => {
  const f = setup(t); f.put('ordinary', 164331);
  assert.equal((await f.read(largest)).ledger.lead_rows[0].amount_minor, 164331, 'ordinary green control');
  addPayments(f); const b = await f.read(largest);
  assert.equal(b.ledger.lead_rows[0].amount_minor, 164331);
  assertPayments(b);
});
function assertGroups(b) {
  const groups = b.ledger.groups;
  assert.equal(b.ledger.total_minor, 17100);
  assert.ok(b.ledger.other_groups);
  assert.equal(groups.reduce((sum, g) => sum + g.total_minor, 0) + b.ledger.other_groups.total_minor, 17100);
  assert.equal(b.ledger.other_groups.count, 8);
  assert.match(b.answer, /Other \(8 payees\): \$36\.00/);
  assert.match(b.answer, /Accounts (?:used|covered):[^\n]*1234[^\n]*3456[^\n]*4567/i);
  assert.match(b.answer, /Pending[^\n]*\$352\.50[^\n]*excluded/i);
  const pending = b.ledger.pending_excluded;
  assert.equal(pending.total_minor, 35250);
  assert.equal(pending.count, 1);
  for (const n of pending.citations) assert.equal(b.citations.find(ref => ref.n === n).amount_minor, 35250);
}
function addGroups(f) {
  f.account('second-unit', '3456'); f.account('third-unit', '4567');
  for (let i = 1; i <= 18; i++) f.put(`ordinary-${i}`, i * 100, { payee: `Service Unit ${i}`, account: ['fixture-account', 'second-unit', 'third-unit'][(i - 1) % 3] });
  f.put('pending', 35250, { pending: true });
}
test('live shape 2: grouped spending reconciles all payees, identifies accounts and quantifies pending', async t => {
  const f = setup(t); f.put('control', 100);
  assert.equal((await f.read(summary)).ledger.total_minor, 100, 'ordinary green control');
  f.raw("DELETE FROM fin_transactions WHERE txn_uid='control'"); addGroups(f);
  assertGroups(await f.read(summary));
});
function assertPossible(b) {
  assert.equal(b.ledger.found, null);
  assert.equal(b.ledger.total_minor, null);
  assert.equal(b.ledger.match_basis, 'possible');
  assert.equal(b.ledger.complete, false);
  assert.equal(b.citations.length, 1);
  assert.equal(b.citations[0].amount_minor, 23613);
  assert.equal(b.citations[0].account_mask, '1234');
  assert.match(b.answer, /POSSIBLE match.*\$236\.13.*October 5(?:, 2026)?.*1234.*"Processor Unit settlement".*\[1\]/i);
  assert.match(b.answer, /the bank text does not name Payer Unit; this may be that payment/i);
  assert.doesNotMatch(b.answer, /Found a deposit|No charges|No deposit|\$999\.99/i);
}
function addCandidates(f) {
  f.put('exact', 23613, { direction: 'inflow', payee: 'Processor Unit', description: 'Processor Unit settlement' });
  f.put('different', 99999, { direction: 'inflow', payee: 'Other Unit' });
}
test('live shape 3: named exact-amount receipt is a possible match with verbatim bank text', async t => {
  const f = setup(t); f.put('control', 23613, { direction: 'inflow', payee: 'Payer Unit' });
  assert.equal((await f.read(payment)).ledger.found, true, 'named payer green control');
  f.raw("DELETE FROM fin_transactions WHERE txn_uid='control'"); addCandidates(f);
  assertPossible(await f.read(payment));
});
test('no exact-amount candidate cannot answer with a different payee or claim payer absence', async t => {
  const f = setup(t); addCandidates(f); assertPossible(await f.read(payment));
  f.raw("UPDATE fin_transactions SET amount_minor=23612 WHERE txn_uid='exact'");
  const b = await f.read(payment);
  assert.match(b.answer, /no deposit of \$236\.13 on .*1234 from October 1(?:, 2026)? to October 12(?:, 2026)?/i);
  assert.equal(b.ledger.found, null); assert.equal(b.ledger.total_minor, null);
  assert.equal(b.citations.length, 0);
  assert.doesNotMatch(b.answer, /\$236\.12|\$999\.99|No charges|no payment from/i);
});

for (const question of [summary, 'How much did I spend by category in October 2026?', 'How much did I spend by merchant in October 2026?',
  'How much money came in and went out in October 2026?', 'How much money came in during October 2026?',
  'What were my ten largest deposits in October 2026?', 'What recurring subscriptions am I paying for, and how much per month?']) {
  test(`payment itemization surface: ${question}`, async t => {
    const f = setup(t); f.put('ordinary', 164331);
    if (question.includes('recurring')) for (const date of ['2026-08-05', '2026-09-05']) f.put(`ordinary-${date}`, 164331, { date });
    const green = await f.read(question); assert.equal(green.ledger.payment_exclusions, undefined, 'ordinary control');
    addPayments(f);
    const b = await f.read(question);
    if (question.includes('came in and went out')) assertMoneyOutTotals(b); else assertPayments(b);
  });
}
test('more than five excluded payments itemize the largest five and cite every remainder posting', async t => {
  const f = setup(t); f.put('ordinary', 164331);
  assert.equal((await f.read(largest)).ledger.lead_rows[0].amount_minor, 164331);
  for (let i = 1; i <= 8; i++) f.put(`card-${i}`, i * 100, { category: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' });
  const b = await f.read(largest), p = b.ledger.payment_exclusions;
  assert.equal(p.count, 8); assert.equal(p.total_minor, 3600);
  const items = b.answer.split('\n').filter(line => line.startsWith('payment to a card:'));
  assert.equal(items.length, 5);
  assert.deepEqual(items.map(line => Number(line.match(/\$(\d+)\.00/)[1])), [8, 7, 6, 5, 4]);
  const rest = b.answer.split('\n').find(line => line.startsWith('and 3 more:'));
  assert.match(rest, /\$6\.00/);
  for (const row of p.rows.filter(row => row.amount_minor <= 300)) assert.ok(rest.includes(`[${row.n}]`));
});
test('monthly disclosures preserve item dates, accounts and rebased citations', async t => {
  const f = setup(t); f.put('ordinary', 164331); addPayments(f);
  f.put('previous-card', 7300, { date: '2026-09-05', category: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' });
  const b = await f.read('Could you retrieve expenses month by month since September?', withLedgerAnswer, { kind: 'expense_summary' });
  assert.equal(b.ledger.months.length, 2, 'monthly reader reached');
  assert.equal(new Set(b.citations.map(ref => ref.n)).size, b.citations.length);
  for (const month of b.ledger.months) for (const row of month.payment_exclusions.rows) {
    const ref = b.citations.find(ref => ref.n === row.n);
    assert.equal(ref.amount_minor, row.amount_minor); assert.equal(ref.posted_on, row.posted_on);
    const line = b.answer.split('\n').find(line => line.startsWith('payment to ') && line.includes(`[${row.n}]`));
    assert.ok(line?.includes('1234')); assert.ok(line?.includes(dollars(row.amount_minor)));
  }
});
test('exact candidates respect account, window, cents, pending and direction boundaries', async t => {
  const f = setup(t); addCandidates(f); assertPossible(await f.read(payment));
  f.account('other-unit', '9876');
  for (const [id, opts] of [['other-account', { account: 'other-unit' }], ['outside', { date: '2026-09-30' }],
    ['pending-exact', { pending: true }], ['wrong-direction', { direction: 'outflow' }], ['one-cent-off', { cents: 23612 }]])
    f.put(id, opts.cents || 23613, { direction: 'inflow', payee: 'Processor Unit', ...opts });
  assertPossible(await f.read(payment));
  f.raw("UPDATE fin_transactions SET amount_minor=23612 WHERE txn_uid='exact'");
  const b = await f.read(payment);
  assert.equal(b.citations.length, 0); assert.equal(b.ledger.amount_candidates.length, 0);
  assert.match(b.answer, /No deposit of \$236\.13/);
});
test('multiple exact candidates remain individually possible and never form a payer total', async t => {
  const f = setup(t); addCandidates(f); assertPossible(await f.read(payment));
  f.put('second-exact', 23613, { direction: 'inflow', date: '2026-10-06', payee: 'Processor Unit', description: 'Second processor text' });
  const b = await f.read(payment);
  assert.equal(b.ledger.amount_candidates.length, 2); assert.equal(b.citations.length, 2);
  assert.equal(b.ledger.total_minor, null); assert.equal(b.ledger.found, null);
  assert.equal((b.answer.match(/POSSIBLE match:/g) || []).length, 2);
  assert.doesNotMatch(b.answer, /\$472\.26|Found a deposit|No charges/);
});

// Execute source mutants through the same real SQLite reader and final guard.
// Each mutant must keep its nonempty green control before the defect is added.
import { readFileSync } from 'node:fs';
async function mutant(replacements, monthlyReplacements = []) {
  const url = new URL('../src/lib/ledger-answer.js', import.meta.url);
  let source = readFileSync(url, 'utf8');
  for (const [from, to] of replacements) {
    assert.equal(source.split(from).length - 1, 1, 'one exact mutation decision point');
    source = source.replace(from, to);
  }
  if (monthlyReplacements.length) {
    const monthlyUrl = new URL('../src/lib/ledger-monthly.js', import.meta.url);
    let monthly = readFileSync(monthlyUrl, 'utf8');
    for (const [from, to] of monthlyReplacements) {
      assert.equal(monthly.split(from).length - 1, 1, 'one exact monthly mutation decision point');
      monthly = monthly.replace(from, to);
    }
    monthly = monthly.replace(/from ['"](\.\/[^'"\n]+)['"]/g, (_, path) => `from ${JSON.stringify(new URL(path, monthlyUrl).href)}`);
    source = source.replace('"./ledger-monthly.js"', JSON.stringify(`data:text/javascript;base64,${Buffer.from(monthly).toString('base64')}`));
  }
  source = source.replace(/from ['"](\.\/[^'"\n]+)['"]/g, (_, path) => `from ${JSON.stringify(new URL(path, url).href)}`);
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).withLedgerAnswer;
}
for (const [label, edits, kind] of [
  ['payments only as a total', [['paymentExclusionLines(result.ledger.payment_exclusions, intent.presentation, { omitTotal: namedPaymentOnly })', '`Payments to loans and cards: ${money(totalMinor)}`']], 'payments'],
  ['groups not summing', [['sumMinor(orderedGroups.slice(displayedGroups.length), group => group.total_minor)', '0']], 'groups'],
  ['amount match confirmed as payer', [["kind: 'payment', found: null, total_minor: null, complete: false,", "kind: 'payment', found: true, total_minor: null, complete: false,"]], 'possible'],
  ['no amount match returns another payee', [
    // The bounded read already includes all amounts; corrupt the local exact-cents boundary.
    ["const candidates = rows.filter(row => row.amount_minor === intent.amountMinor &&", "const candidates = rows.filter(row => true &&"],
  ], 'absent'],
]) test(`disclosure mutant killed: ${label}`, async t => {
  const path = await mutant(edits), f = setup(t);
  if (kind === 'payments') {
    f.put('ordinary', 164331);
    assert.equal((await f.read(largest, path)).ledger.lead_rows[0].amount_minor, 164331, 'mutant green control');
    addPayments(f); assertPayments(await f.read(largest));
    const changed = await f.read(largest, path);
    assert.throws(() => assertPayments(changed), assert.AssertionError);
  } else if (kind === 'groups') {
    f.put('control', 100); assert.equal((await f.read(summary, path)).ledger.total_minor, 100, 'mutant green control');
    f.raw("DELETE FROM fin_transactions WHERE txn_uid='control'"); addGroups(f);
    assertGroups(await f.read(summary)); const changed = await f.read(summary, path);
    assert.throws(() => assertGroups(changed), assert.AssertionError);
  } else {
    f.put('control', 23613, { direction: 'inflow', payee: 'Payer Unit' });
    assert.equal((await f.read(payment, path)).ledger.found, true, 'mutant green control');
    f.raw("DELETE FROM fin_transactions WHERE txn_uid='control'"); addCandidates(f);
    if (kind === 'possible') {
      assertPossible(await f.read(payment)); const changed = await f.read(payment, path);
      assert.equal(changed.ledger.named_selector_guard.rejected, true, 'confirmation mutant reaches guard');
      assert.throws(() => assertPossible(changed), assert.AssertionError);
    } else {
      f.raw("UPDATE fin_transactions SET amount_minor=23612 WHERE txn_uid='exact'");
      const green = await f.read(payment), changed = await f.read(payment, path);
      assert.match(green.answer, /No deposit of \$236\.13/);
      assert.equal(green.citations.length, 0);
      assert.equal(changed.ledger.named_selector_guard.rejected, true, 'foreign candidate reaches guard');
      assert.throws(() => assert.match(changed.answer, /No deposit of \$236\.13/), assert.AssertionError);
    }
  }
});

test('live named-payment wording uses the structured soft interpretation and retains possible attribution', async t => {
  const f = setup(t), question = 'Did the $236.13 Payer Unit payment hit account ending 1234 this month?';
  const intent = { kind: 'payment', direction: 'inflow', vendor_text: 'Payer Unit', account_hint: '1234', amount_text: '$236.13' };
  f.put('control', 23613, { direction: 'inflow', payee: 'Payer Unit' });
  assert.equal((await f.read(question, withLedgerAnswer, intent)).ledger.found, true, 'same wording named payer control');
  f.raw("DELETE FROM fin_transactions WHERE txn_uid='control'"); addCandidates(f);
  assertPossible(await f.read(question, withLedgerAnswer, intent));
});
test('category truncation preserves the exact remainder and pending stays within the named period', async t => {
  const f = setup(t); addGroups(f); assertGroups(await f.read(summary));
  for (let i = 1; i <= 18; i++) f.raw('UPDATE fin_transactions SET category=? WHERE txn_uid=?', `CATEGORY_${i}`, `ordinary-${i}`);
  f.put('future-pending', 99001, { pending: true, date: '2026-10-13' });
  const b = await f.read(summary);
  assertGroups(b);
  assert.equal(b.ledger.category_groups.reduce((sum, g) => sum + g.total_minor, 0) + b.ledger.other_categories.total_minor, 17100);
  assert.match(b.answer, /Other \(8 categories\): \$36\.00/);
  assert.doesNotMatch(b.answer, /\$990\.01/);
});
test('a bank payment code alone cannot claim ownership of a connected loan', async t => {
  const f = setup(t); f.put('ordinary', 164331); addPayments(f);
  assertPayments(await f.read(largest));
  f.raw("UPDATE fin_transactions SET payee='Outside Lender' WHERE txn_uid='loan-payment'");
  const b = await f.read(largest), row = b.ledger.payment_exclusions.rows.find(row => row.amount_minor === 70318);
  assert.equal(b.ledger.payment_exclusions.total_minor, 72818, 'bank-coded exclusion remains reached');
  assert.equal(row.own_loan_mask, undefined);
  assert.match(b.answer, /payment to a loan: \$703\.18/);
  assert.doesNotMatch(b.answer, /payment to your own loan/i);
});

test('category remainder citations resolve even when all categories share one payee', async t => {
  const f = setup(t); addGroups(f);
  for (let i = 1; i <= 18; i++) f.raw('UPDATE fin_transactions SET category=? WHERE txn_uid=?', `CATEGORY_${i}`, `ordinary-${i}`);
  assertGroups(await f.read(summary));
  f.raw("UPDATE fin_transactions SET payee='Service Unit' WHERE pending=0");
  const b = await f.read(summary), remainder = b.ledger.other_categories;
  assert.equal(b.ledger.groups.length, 1, 'one-payee category decision reached');
  assert.equal(remainder.count, 8);
  assert.equal(remainder.total_minor, 3600);
  assert.ok(remainder.citations.every(n => Number.isInteger(n) && b.citations.some(ref => ref.n === n)));
  assert.doesNotMatch(b.answer, /\[undefined\]|\[null\]/);
});

// M1: every member must support the displayed amount, even below truncation.
function assertFigureRefs(b, line, total, count) {
  const numbers = [...line.matchAll(/\[(\d+)\]/g)].map(match => Number(match[1]));
  assert.equal(new Set(numbers).size, count, 'all contributing postings cited exactly once');
  const refs = numbers.map(n => { const ref = b.citations.find(ref => ref.n === n); assert.ok(ref, 'reference resolves'); return ref; });
  assert.equal(refs.reduce((sum, ref) => sum + ref.amount_minor, 0), total, 'references support whole figure');
  return refs;
}
function assertCitedPartitions(b, count, members = 1) {
  const total = 137 * count * (count + 1) / 2 * members;
  assert.equal(b.ledger.total_minor, total);
  for (const [key, remainderKey, label] of [['groups', 'other_groups', 'merchant'], ['category_groups', 'other_categories', 'category']]) {
    assert.equal(b.ledger[key].length, Math.min(count, 10), 'displayed partition reached');
    assert.equal(b.ledger[key].reduce((sum, group) => sum + group.total_minor, 0) + (b.ledger[remainderKey]?.total_minor || 0), total);
    for (const group of b.ledger[key]) {
      const line = b.answer.split('\n').find(line => line.startsWith(`${group[label]}:`));
      assert.ok(line); assert.ok(line.includes(dollars(group.total_minor)));
      const refs = assertFigureRefs(b, line, group.total_minor, members);
      assert.ok(refs.every(ref => ref.account_mask === '1234' && ref.posted_on === '2026-10-05'));
    }
    if (count > 10) {
      const group = b.ledger[remainderKey];
      const line = b.answer.split('\n').find(line => line.startsWith(`Other (${count - 10} ${key === 'groups' ? 'payees' : 'categories'}):`));
      assert.ok(line.includes(dollars(group.total_minor)));
      assertFigureRefs(b, line, group.total_minor, (count - 10) * members);
    }
  }
}
for (const count of [6, 10, 18]) test(`M1 group-citations-${count}: both displayed partitions cite every posting`, async t => {
  const f = setup(t); f.put('green', 137, { payee: 'Merchant Unit 1', category: 'CATEGORY_1' });
  const green = await f.read(summary);
  assert.equal(green.ledger.total_minor, 137);
  assertFigureRefs(green, green.answer.split("\n").find(line => line.startsWith("merchant unit 1:")), 137, 1);
  f.raw("DELETE FROM fin_transactions WHERE txn_uid='green'");
  for (let i = 1; i <= count; i++) for (let member = 0; member < 2; member++)
    f.put(`group-${i}-${member}`, i * 137, { payee: `Merchant Unit ${i}`, category: `CATEGORY_${i}` });
  assertCitedPartitions(await f.read(summary), count, 2);
});
const possibleStoreIntent = { kind: 'merchant', direction: 'outflow', vendor_text: 'Store Unit' };
const possibleStoreMonthly = 'Could you retrieve charges at Store Unit month by month since September?';
function addPossibleStore(f) {
  for (const date of ['2026-09-05', '2026-10-05']) {
    f.put(`ordinary-${date}`, 943, { date, payee: null, description: 'Store Unit purchase' });
    f.put(`payment-${date}`, 3187, { date, payee: null, description: 'Store Unit payment', category: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' });
  }
}
function assertPossibleMonth(b) {
  assert.equal(b.ledger.months?.length, 2, 'monthly decision survives selector guard');
  assert.equal(b.ledger.complete, false); assert.ok(b.ledger.total_minor == null);
  assert.doesNotMatch(b.answer, /No charges|You spent|Spending at Store Unit:|Store Unit: \$/i);
  assert.match(b.answer, /no store total is confirmed/i);
  assert.equal(new Set(b.citations.map(ref => ref.n)).size, b.citations.length);
  for (const month of b.ledger.months) {
    assert.equal(month.match_basis, 'possible'); assert.equal(month.complete, false);
    assert.equal(month.total_minor, null); assert.equal(month.possible_subtotal_minor, 943);
    assert.equal(month.payment_exclusions.total_minor, 3187);
    const payment = month.payment_exclusions.rows[0]; assert.equal(payment.match_basis, 'possible');
    const line = b.answer.split('\n').find(line => line.startsWith('payment to ') && line.includes(`[${payment.n}]`));
    assert.ok(line?.includes('$31.87')); assert.match(line, /1234.*unconfirmed/);
    const [ref] = assertFigureRefs(b, line, 3187, 1);
    assert.equal(ref.posted_on, `${month.month}-05`); assert.equal(ref.account_mask, '1234');
    const ordinary = b.citations.filter(ref => month.possible_citations.includes(ref.n));
    assert.equal(ordinary.length, 1); assert.equal(ordinary[0].amount_minor, 943);
    assert.equal(ordinary[0].posted_on, `${month.month}-05`);
  }
}
test('M2 possible-payment-single: possible ordinary subtotal and payment remain qualified', async t => {
  const f = setup(t); f.put('green', 943, { payee: 'Store Unit' });
  assert.equal((await f.read('Could you retrieve spending at Store Unit this month?', withLedgerAnswer, possibleStoreIntent)).ledger.total_minor, 943);
  f.raw("DELETE FROM fin_transactions WHERE txn_uid='green'"); addPossibleStore(f);
  const b = await f.read('Could you retrieve spending at Store Unit this month?', withLedgerAnswer, possibleStoreIntent);
  assert.equal(b.ledger.possible_subtotal_minor, 943); assert.equal(b.ledger.total_minor, null);
  assert.equal(b.ledger.payment_exclusions.total_minor, 3187);
  assert.match(b.answer, /payment to a card: \$31\.87.*1234.*unconfirmed/);
  assert.doesNotMatch(b.answer, /No charges|You spent/i);
});
test('M2 possible-payment-monthly: qualified membership, dates and rebased payments survive', async t => {
  const f = setup(t); addPossibleStore(f);
  const green = await f.read('Could you retrieve spending at Store Unit this month?', withLedgerAnswer, possibleStoreIntent);
  assert.equal(green.ledger.possible_subtotal_minor, 943, 'single-period green control');
  assertPossibleMonth(await f.read(possibleStoreMonthly, withLedgerAnswer, possibleStoreIntent));
});

for (const [label, edits, monthlyEdits, kind] of [
  ['citation dropped for group 6+', [['const evidenceRows = [...ordinary].sort(rowOrder);', 'const evidenceRows = [...ordinary].sort(rowOrder).slice(0, 5);']], [], 'groups'],
  ['category refs ignored', [['${group.category}: ${money(group.total_minor)} across ${group.count} ${group.count === 1 ? "row" : "rows"} ${refs}.', '${group.category}: ${money(group.total_minor)} across ${group.count} ${group.count === 1 ? "row" : "rows"}.']], [], 'groups'],
  ['monthly metadata dropped', [], [['      ...attribution,', '      // mutation: attribution omitted']], 'months'],
  ['no charges with uncertain rows', [], [["merchant_possible_matches: 'Possible payee mentions only; no store total is confirmed.'", "merchant_possible_matches: 'No charges at the requested store.'"]], 'months'],
]) test(`R1 mutant killed: ${label}`, async t => {
  const path = await mutant(edits, monthlyEdits), f = setup(t);
  f.put('green', 137, { payee: 'Merchant Unit 1', category: 'CATEGORY_1' });
  const green = await f.read(summary, path);
  assertFigureRefs(green, green.answer.split('\n').find(line => line.startsWith('merchant unit 1:')), 137, 1);
  f.raw("DELETE FROM fin_transactions WHERE txn_uid='green'");
  if (kind === 'groups') {
    for (let i = 1; i <= 6; i++) f.put(`group-${i}`, i * 137, { payee: `Merchant Unit ${i}`, category: `CATEGORY_${i}` });
    assertCitedPartitions(await f.read(summary), 6);
    const changed = await f.read(summary, path);
    assert.equal(changed.ledger.group_count, 6, 'six-group decision reached under mutation');
    assert.throws(() => assertCitedPartitions(changed, 6), assert.AssertionError);
  } else {
    addPossibleStore(f);
    assertPossibleMonth(await f.read(possibleStoreMonthly, withLedgerAnswer, possibleStoreIntent));
    const changed = await f.read(possibleStoreMonthly, path, possibleStoreIntent);
    assert.equal(changed.ledger.named_selector_guard?.rejected || changed.ledger.months?.length === 2, true, 'monthly mutation reached guard or rendered months');
    assert.throws(() => assertPossibleMonth(changed), assert.AssertionError);
  }
});

test('M2 uncertain payment-only months retain admissible payments without a zero spending claim', async t => {
  const f = setup(t); addPossibleStore(f);
  assertPossibleMonth(await f.read(possibleStoreMonthly, withLedgerAnswer, possibleStoreIntent));
  f.raw("DELETE FROM fin_transactions WHERE txn_uid LIKE 'ordinary-%'");
  const b = await f.read(possibleStoreMonthly, withLedgerAnswer, possibleStoreIntent);
  assert.equal(b.ledger.months.length, 2);
  assert.equal(b.citations.length, 2);
  for (const month of b.ledger.months) {
    assert.equal(month.total_minor, null); assert.equal(month.complete, false);
    const payment = month.payment_exclusions.rows[0];
    const line = b.answer.split('\n').find(line => line.startsWith('payment to ') && line.includes(`[${payment.n}]`));
    const [ref] = assertFigureRefs(b, line, 3187, 1);
    assert.equal(ref.posted_on, `${month.month}-05`); assert.equal(ref.account_mask, '1234');
  }
  assert.doesNotMatch(b.answer, /No charges|You spent|\$0\.00/i);
});

test('M2 an exact month cannot confirm another month containing only possible attributions', async t => {
  const f = setup(t); addPossibleStore(f);
  assertPossibleMonth(await f.read(possibleStoreMonthly, withLedgerAnswer, possibleStoreIntent));
  f.raw("UPDATE fin_transactions SET payee='Store Unit' WHERE posted_on='2026-09-05'");
  const b = await f.read(possibleStoreMonthly, withLedgerAnswer, possibleStoreIntent);
  assert.equal(b.ledger.months.length, 2);
  assert.equal(b.ledger.months[0].total_minor, 943);
  assert.equal(b.ledger.months[0].complete, true);
  assert.equal(b.ledger.months[1].total_minor, null);
  assert.equal(b.ledger.months[1].complete, false);
  assert.equal(b.ledger.months[1].match_basis, 'possible');
  assert.equal(b.ledger.months[1].payment_exclusions.total_minor, 3187);
  assert.doesNotMatch(b.answer, /No charges|You spent/i);
});

// R1-B1: a different month's exact identity cannot certify uncertain absence.
const sparseMonths = ['2026-07-07', '2026-08-08', '2026-09-09', '2026-10-10'];
const sparseQuestion = 'Could you retrieve charges at Store Unit month by month since July?';
const storeQuestion = 'Could you retrieve spending at Store Unit this month?';
function postingIds(f) {
  return new Map(f.rows('SELECT id, txn_uid FROM fin_transactions').map(row => [`ledger:transaction:${row.id}`, row.txn_uid]));
}
function assertPostingMembers(b, text, expected, f) {
  const refs = assertFigureRefs(b, text, expected.reduce((sum, row) => sum + row.cents, 0), expected.length);
  const ids = postingIds(f);
  assert.deepEqual(refs.map(ref => ids.get(ref.ref)).sort(), expected.map(row => row.uid).sort(), 'all and only amount members');
}
function addSparsePayments(f, position) {
  for (let i = 0; i < 4; i++) f.put(`sparse-${i}`, i === position ? 4001 + 97 * i : 2213 + 31 * i, {
    date: sparseMonths[i], payee: i === position ? null : 'Store Unit',
    description: i === position ? 'Store Unit payment' : 'Store Unit purchase',
    category: i === position ? i % 2 ? 'LOAN_PAYMENTS' : 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' : 'GENERAL_SERVICES',
  });
}
function assertSparsePayment(b, position, f) {
  assert.equal(b.ledger.months.length, 4, 'monthly decision reached');
  const month = b.ledger.months[position];
  assert.equal(month.payment_exclusions.rows[0].match_basis, 'possible', 'excluded possible payment reached');
  assert.equal(month.total_minor, null); assert.equal(month.subtotal_minor, null); assert.equal(month.complete, false);
  assert.equal(month.match_basis, 'possible');
  const row = month.payment_exclusions.rows[0];
  const line = b.answer.split('\n').find(line => line.startsWith('payment to ') && line.includes(`[${row.n}]`));
  assertPostingMembers(b, line, [{ uid: `sparse-${position}`, cents: 4001 + 97 * position }], f);
  assert.doesNotMatch(b.answer, /No charges|\$0\.00/i);
}
for (const position of [0, 1, 2, 3]) test(`R1-B1 only-possible-month-${position} retains uncertainty and itemized payment`, async t => {
  const f = setup(t); f.put('green', 2213, { payee: 'Store Unit' });
  assert.equal((await f.read(storeQuestion, withLedgerAnswer, possibleStoreIntent)).ledger.total_minor, 2213);
  f.raw('DELETE FROM fin_transactions'); addSparsePayments(f, position);
  assertSparsePayment(await f.read(sparseQuestion, withLedgerAnswer, possibleStoreIntent), position, f);
});
test('R1-B1 empty-months-green preserves covered zero without candidates', async t => {
  const f = setup(t); f.put('exact', 1913, { date: sparseMonths[0], payee: 'Store Unit' });
  const b = await f.read(sparseQuestion, withLedgerAnswer, possibleStoreIntent);
  assert.equal(b.ledger.months.length, 4); assert.equal(b.ledger.months[0].total_minor, 1913);
  for (const i of [1, 2]) {
    assert.equal(b.ledger.months[i].total_minor, 0); assert.equal(b.ledger.months[i].complete, true);
    assert.equal(b.ledger.months[i].payment_exclusions, undefined);
  }
});
function assertMixedRefs(b, f) {
  assert.equal(b.ledger.match_basis, 'exact_and_possible');
  assert.equal(b.ledger.total_minor, null); assert.equal(b.ledger.possible_subtotal_minor, 2381);
  const line = b.answer.split('\n').find(line => line.includes('$23.81'));
  assert.ok(line, 'qualified subtotal displayed');
  const [confirmed, possible] = line.split('; another ');
  assertPostingMembers(b, confirmed, [{ uid: 'exact', cents: 1729 }], f);
  assertPostingMembers(b, possible, [{ uid: 'possible', cents: 2381 }], f);
  assert.doesNotMatch(b.answer, /You spent|No charges|\$41\.10/i);
}
function addMixedRefs(f) {
  f.put('possible', 2381, { payee: null, description: 'Store Unit purchase' });
  f.put('possible-pay', 4093, { payee: null, description: 'Store Unit payment', category: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' });
}
test('R1-M1 mixed-ref-attack cites confirmed and possible subtotals separately', async t => {
  const f = setup(t); f.put('exact', 1729, { payee: 'Store Unit' });
  const green = await f.read(storeQuestion, withLedgerAnswer, possibleStoreIntent);
  assertPostingMembers(green, green.answer.split('\n').find(line => line.startsWith('You spent')), [{ uid: 'exact', cents: 1729 }], f);
  addMixedRefs(f); assertMixedRefs(await f.read(storeQuestion, withLedgerAnswer, possibleStoreIntent), f);
});
function assertMonthlyMembers(b, f) {
  assert.equal(b.ledger.months.at(-1).total_minor, 1907);
  const ordinary = b.answer.split('\n').find(line => line.startsWith('October 2026:')).split('. ')[0];
  assertPostingMembers(b, ordinary, [{ uid: 'ordinary', cents: 1907 }], f);
}
test('R1-M2 monthly-member-payment isolates spending from excluded payment and refund', async t => {
  const f = setup(t); f.put('ordinary', 1907, { payee: 'Store Unit' });
  assertMonthlyMembers(await f.read(sparseQuestion, withLedgerAnswer, possibleStoreIntent), f);
  f.put('payment', 4093, { payee: 'Store Unit', category: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' });
  f.put('refund', 733, { payee: 'Store Unit', direction: 'inflow', description: 'Refund of purchase', category: 'REFUND' });
  const b = await f.read(sparseQuestion, withLedgerAnswer, possibleStoreIntent);
  assert.equal(b.ledger.months.at(-1).payment_exclusions.total_minor, 4093, 'payment partition reached');
  assertMonthlyMembers(b, f);
});

// R1-M2: rebasing must preserve each measure, including empty spending receipts.
test('R1-M2 monthly refund and other receipt figures cite separate rebased members', async t => {
  const f = setup(t); f.put('ordinary', 1907, { payee: 'Store Unit' });
  assertMonthlyMembers(await f.read(sparseQuestion, withLedgerAnswer, possibleStoreIntent), f);
  for (const [i, date] of sparseMonths.slice(0, 2).entries()) {
    f.put(`refund-${i}`, 733 + i, { date, payee: 'Store Unit', direction: 'inflow', description: 'Refund of purchase', category: 'REFUND' });
    f.put(`receipt-${i}`, 1103 + i, { date, payee: 'Store Unit', direction: 'inflow', description: 'Other money received' });
    f.put(`receipt-payment-${i}`, 4093 + i, { date, payee: 'Store Unit', category: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' });
  }
  const b = await f.read(sparseQuestion, withLedgerAnswer, possibleStoreIntent);
  for (const i of [0, 1]) {
    const month = b.ledger.months[i];
    assert.equal(month.total_minor, 0, 'exact receipt-only zero decision reached');
    const line = b.answer.split('\n').find(line => line.startsWith(`${month.label}:`));
    const [ordinary, rest] = line.split(' Refunds received: '), [refund, tail] = rest.split(' Other money received: ');
    const other = tail.split(' Payments to loans and cards')[0];
    assert.doesNotMatch(ordinary, /\[\d+\]/, 'zero spending has no contributing postings');
    assertPostingMembers(b, refund, [{ uid: `refund-${i}`, cents: 733 + i }], f);
    assertPostingMembers(b, other, [{ uid: `receipt-${i}`, cents: 1103 + i }], f);
    assert.deepEqual(month.refund_citations, [...refund.matchAll(/\[(\d+)\]/g)].map(m => +m[1]));
    assert.deepEqual(month.other_receipt_citations, [...other.matchAll(/\[(\d+)\]/g)].map(m => +m[1]));
  }
});
function assertTwoMonthMembers(b, f) {
  assert.equal(b.ledger.months.length, 4);
  for (const [i, count] of [[0, 1], [1, 7]]) {
    const month = b.ledger.months[i], line = b.answer.split('\n').find(line => line.startsWith(`${month.label}:`)).split('. ')[0];
    const expected = Array.from({ length: count }, (_, member) => ({ uid: `member-${i}-${member}`, cents: 1201 + 31 * member }));
    assert.equal(month.total_minor, expected.reduce((sum, row) => sum + row.cents, 0));
    assertPostingMembers(b, line, expected, f);
  }
}
function addTwoMonthMembers(f) {
  for (const [i, count] of [[0, 1], [1, 7]]) {
    for (let member = 0; member < count; member++) f.put(`member-${i}-${member}`, 1201 + 31 * member, { date: sparseMonths[i], payee: 'Store Unit' });
    f.put(`member-payment-${i}`, 4093 + i, { date: sparseMonths[i], payee: 'Store Unit', category: 'LOAN_PAYMENTS' });
  }
}
test('R1-M2 monthly spending lists rebase every member beyond the compact citation limit', async t => {
  const f = setup(t); f.put('ordinary', 1907, { payee: 'Store Unit' });
  assertMonthlyMembers(await f.read(sparseQuestion, withLedgerAnswer, possibleStoreIntent), f);
  f.raw('DELETE FROM fin_transactions'); addTwoMonthMembers(f);
  assertTwoMonthMembers(await f.read(sparseQuestion, withLedgerAnswer, possibleStoreIntent), f);
});
test('R1-M2 monthly money in and out cite only their own directional members', async t => {
  const f = setup(t); f.put('ordinary', 1907, { payee: 'Store Unit' });
  assertMonthlyMembers(await f.read(sparseQuestion, withLedgerAnswer, possibleStoreIntent), f);
  f.raw('DELETE FROM fin_transactions');
  for (const [i, date] of sparseMonths.slice(0, 2).entries()) {
    f.put(`in-${i}`, 733 + i, { date, direction: 'inflow' });
    f.put(`out-${i}`, 1907 + i, { date });
    f.put(`payment-${i}`, 4093 + i, { date, category: 'LOAN_PAYMENTS' });
  }
  const b = await f.read('Could you retrieve money in and out by month since July?', withLedgerAnswer, { kind: 'totals', direction: 'both' });
  for (const i of [0, 1]) {
    const month = b.ledger.months[i], line = b.answer.split('\n').find(line => line.startsWith(`${month.label}:`));
    const [incoming, outgoing] = line.split('; money out ');
    assertPostingMembers(b, incoming, [{ uid: `in-${i}`, cents: 733 + i }], f);
    // Money out (S9F): a coded loan payment with no connected loan account
    // left the connected accounts, so it is a money-out member and disclosed.
    assertPostingMembers(b, outgoing.split('. ')[0], [{ uid: `out-${i}`, cents: 1907 + i }, { uid: `payment-${i}`, cents: 4093 + i }], f);
    assert.equal(month.payment_exclusions, undefined, 'no own-account payment to partition');
    assert.deepEqual(month.possible_payments.map(row => [row.amount_minor, row.included_in_total]), [[4093 + i, true]]);
  }
});

for (const [label, edits, monthlyEdits, kind] of [
  ['possible-only month treated as empty', [], [[
    "ledger?.match_basis === 'none' && !possibleAttribution && !ledger.possible_match_count &&",
    'ledger?.row_count === 0 &&',
  ]], 'sparse'],
  ['possible subtotal references omitted', [[
    '${ledger.possible_citations.map(n => `[${n}]`).join(" ")} only mentions',
    'only mentions',
  ]], [], 'mixed'],
  ['whole month pool supports ordinary amount', [], [[
    '${money(month.complete ? month.total_minor : month.subtotal_minor)}${refsFor(month.amount_citations)}',
    '${money(month.complete ? month.total_minor : month.subtotal_minor)}${refsFor(month.citations)}',
  ]], 'members'],
  ['amount posting list not rebased', [], [[
    'const rebase = numbers => (numbers || []).map(n => citationOffset + n);',
    'const rebase = numbers => (numbers || []).map(n => n);',
  ]], 'rebase'],
]) test(`R2 mutant killed: ${label}`, async t => {
  const changedReader = await mutant(edits, monthlyEdits), f = setup(t);
  f.put('green', 137, { payee: 'Merchant Unit 1', category: 'CATEGORY_1' });
  const green = await f.read(summary, changedReader);
  assertFigureRefs(green, green.answer.split('\n').find(line => line.startsWith('merchant unit 1:')), 137, 1);
  f.raw('DELETE FROM fin_transactions');
  if (kind === 'sparse') {
    addSparsePayments(f, 0);
    assertSparsePayment(await f.read(sparseQuestion, withLedgerAnswer, possibleStoreIntent), 0, f);
    const changed = await f.read(sparseQuestion, changedReader, possibleStoreIntent);
    assert.equal(changed.ledger.months[0].payment_exclusions.rows[0].match_basis, 'possible', 'uncertain payment decision reached under mutation');
    assertSparsePayment(changed, 0, f);
    // The answer-boundary post-condition now catches this earlier branch fault.
    // Disable that overlapping defense only in the mutant, preserving the
    // original failure oracle and proving both layers were actually reached.
    const unprotectedReader = await mutant([...edits, [
      'answer = enforceNamedZeroPostcondition(answer);',
      '// Mutation: overlapping answer-boundary defense removed.',
    ]], monthlyEdits);
    const unprotected = await f.read(sparseQuestion, unprotectedReader, possibleStoreIntent);
    assert.equal(unprotected.ledger.months[0].payment_exclusions.rows[0].match_basis, 'possible', 'uncertain payment decision reached without either defense');
    assert.throws(() => assertSparsePayment(unprotected, 0, f), assert.AssertionError);
  } else if (kind === 'mixed') {
    f.put('exact', 1729, { payee: 'Store Unit' }); addMixedRefs(f);
    assertMixedRefs(await f.read(storeQuestion, withLedgerAnswer, possibleStoreIntent), f);
    const changed = await f.read(storeQuestion, changedReader, possibleStoreIntent);
    assert.equal(changed.ledger.possible_subtotal_minor, 2381, 'possible subtotal decision reached under mutation');
    assert.throws(() => assertMixedRefs(changed, f), assert.AssertionError);
  } else {
    addTwoMonthMembers(f);
    assertTwoMonthMembers(await f.read(sparseQuestion, withLedgerAnswer, possibleStoreIntent), f);
    const changed = await f.read(sparseQuestion, changedReader, possibleStoreIntent);
    assert.equal(changed.ledger.months[1].payment_exclusions.total_minor, 4094, 'second-month payment partition reached under mutation');
    assert.throws(() => assertTwoMonthMembers(changed, f), assert.AssertionError);
  }
});

test('R1-M1 mixed subtotals retain all confirmed and possible members beyond five rows', async t => {
  const f = setup(t); f.put('exact', 1729, { payee: 'Store Unit' });
  const green = await f.read(storeQuestion, withLedgerAnswer, possibleStoreIntent);
  assertPostingMembers(green, green.answer.split('\n').find(line => line.startsWith('You spent')), [{ uid: 'exact', cents: 1729 }], f);
  f.raw('DELETE FROM fin_transactions');
  const confirmed = [], possible = [];
  for (let i = 0; i < 7; i++) {
    f.put(`confirmed-${i}`, 101, { payee: 'Store Unit' }); confirmed.push({ uid: `confirmed-${i}`, cents: 101 });
  }
  for (const cents of [203, 307]) {
    f.put(`possible-${cents}`, cents, { payee: null, description: 'Store Unit purchase' }); possible.push({ uid: `possible-${cents}`, cents });
  }
  const b = await f.read(storeQuestion, withLedgerAnswer, possibleStoreIntent);
  assert.equal(b.ledger.match_basis, 'exact_and_possible'); assert.equal(b.ledger.total_minor, null);
  assert.equal(b.ledger.exact_subtotal_minor, 707); assert.equal(b.ledger.possible_subtotal_minor, 510);
  const line = b.answer.split('\n').find(line => line.includes('$5.10'));
  const [exactFigure, possibleFigure] = line.split('; another ');
  assertPostingMembers(b, exactFigure, confirmed, f); assertPostingMembers(b, possibleFigure, possible, f);
});
