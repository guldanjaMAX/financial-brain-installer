// Adapted from both hotfix review rounds. Each refusal reaches the real reader
// and is paired with a positive receipt, bank-total or empty-window control.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { reachedAnswer, originatorFormats } from './ledger-production-fixture.mjs';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';

const payment = 'Did the payment from Payer One arrive in October 2026?';
const income = 'How much income came from Payer One in October 2026?';
const grouped = 'How much income came by merchant in October 2026?';
const labelNote = 'Labels come from your bank and may not identify who paid.';
function uncertain(body, count = 1) {
  assert.equal(body.ledger.found, null);
  assert.equal(body.ledger.total_minor, null);
  assert.equal(body.ledger.complete, false);
  assert.equal(body.evidence_gate.complete, false);
  assert.match(body.answer, /can't confirm/i);
  assert.doesNotMatch(body.answer, /No matching deposit|\$0\.00|No matching transactions/);
  assert.equal(body.ledger.inflow_count, count);
  assert.equal(body.ledger.inflows.length, Math.min(10, count));
  for (const row of body.ledger.inflows) {
    assert.deepEqual(Object.keys(row).sort(), ['account_mask', 'amount_minor', 'n', 'posted_on']);
    assert.equal(row.account_mask, '1234');
    assert.ok(body.citations.some(c => c.n === row.n && c.amount_minor === row.amount_minor));
  }
}
async function positive(f) {
  f.raw("UPDATE fin_transactions SET payee='Payer One'");
  const paid = await reachedAnswer(f, payment);
  assert.equal(paid.ledger.found, true);
  assert.equal(paid.evidence_gate.complete, true);
  assert.match(paid.answer, /Found a deposit/);
  const received = await reachedAnswer(f, income);
  assert.equal(received.ledger.found, true);
  assert.equal(received.ledger.attributed_subtotal_minor ?? received.ledger.total_minor, 2500);
}

for (const [id, description, payee] of [
  ['F01-service', 'ZELLE PAYMENT', 'Zelle'],
  ['F01-generic', 'ACH CREDIT', 'ACH Credit'],
  ['F01-unknown', 'Transfer from UNKNOWN', null],
  ['F01-processor', 'Deposit processed by ACH', null],
  ['F01-memo', 'Deposit for invoice from Payer Two', null],
  ['N01-ach', 'ACH CREDIT DEPOSIT', 'ACH Credit Deposit'],
  ['N01-service', 'ZELLE TRANSFER', 'Zelle Transfer'],
  ['N01-marker', 'WIRE FROM NOT PROVIDED', null],
  ['N01-account', 'TRANSFER FROM EXTERNAL ACCOUNT', null],
  ['N01-processor', 'Deposit credited by ACH Network', null],
]) test(`${id}: every unmatched payer stays uncertain`, async t => {
  const f = ledgerFixture(t);
  f.add('receipt', description, payee);
  const bodies = [await reachedAnswer(f, payment), await reachedAnswer(f, income)];
  const groups = await reachedAnswer(f, grouped);
  await positive(f);
  for (const body of bodies) uncertain(body);
  assert.equal(groups.ledger.total_minor, 2500);
  assert.equal(groups.ledger.complete, false);
  assert.equal(groups.evidence_gate.complete, false);
  assert.ok(groups.answer.includes(labelNote));
});

for (const identifier of ['AB12CD34EF56', '482.617.039.258.001', '482617039258001', 'Q7X9P2', 'AB12/CD34/EF56']) {
  test(`F03/N02: receipt lists omit all bank text for ${identifier}`, async t => {
    const f = ledgerFixture(t);
    f.add('receipt', `Deposit TRACE:${identifier}`, `Payer One REF:${identifier}`);
    const body = await reachedAnswer(f, income);
    const absent = await reachedAnswer(f, 'Did the payment from Absent Payer arrive in October 2026?');
    f.raw('UPDATE fin_transactions SET payee=?', `Payer One REF: ${identifier}`);
    const spaced = await reachedAnswer(f, income);
    await positive(f);
    for (const result of [body, absent, spaced]) {
      uncertain(result);
      assert.ok(!JSON.stringify(result).includes(identifier));
      assert.doesNotMatch(JSON.stringify(result), /TRACE|REF:|Deposit TRACE/);
    }
  });
}

for (const description of ['Payment processed from Payer One', 'Processed transfer from Payer One']) {
  test(`N03: sealed positive parsing survives ${description}`, async t => {
    const f = ledgerFixture(t);
    f.add('receipt', description, null);
    const paid = await reachedAnswer(f, payment);
    const received = await reachedAnswer(f, income);
    f.raw('UPDATE fin_transactions SET description=?', description.replace(/\bprocessed\s+/i, ''));
    assert.equal((await reachedAnswer(f, payment)).ledger.found, true);
    assert.equal((await reachedAnswer(f, income)).ledger.attributed_subtotal_minor, 2500);
    assert.equal(paid.ledger.found, true);
    assert.equal(received.ledger.found, true);
    assert.equal(received.ledger.attributed_subtotal_minor, 2500);
    assert.equal(received.ledger.total_minor, null);
  });
}

test('N04/F02: grouping retains labels and totals with usable follow-ups', async t => {
  const f = ledgerFixture(t);
  f.add('receipt', 'Settlement', 'Supplier42');
  const body = await reachedAnswer(f, grouped);
  const printed = body.ledger.groups[0].merchant;
  const follow = await reachedAnswer(f, `How much income came from ${printed} in October 2026?`);
  f.raw("UPDATE fin_transactions SET payee='Supplier Unit'");
  const control = await reachedAnswer(f, grouped);
  assert.equal(control.ledger.groups[0].merchant, 'supplier unit');
  assert.equal(printed, 'supplier42');
  assert.match(body.answer, /supplier42: \$25\.00/);
  assert.equal(body.ledger.total_minor, 2500);
  assert.equal(body.ledger.groups[0].total_minor, 2500);
  assert.equal(body.ledger.groups[0].complete, false);
  assert.equal(body.ledger.complete, false);
  assert.equal(body.evidence_gate.complete, false);
  assert.equal(body.answer.split(labelNote).length - 1, 1);
  assert.equal(follow.ledger.found, true);
  assert.equal(follow.ledger.attributed_subtotal_minor, 2500);
  assert.equal(follow.ledger.total_minor, null);
  f.add('unknown', 'Deposit', null, { cents: 1729 });
  const mixed = await reachedAnswer(f, grouped);
  assert.equal(mixed.ledger.total_minor, 4229);
  assert.deepEqual(mixed.ledger.groups.map(g => [g.merchant, g.total_minor]), [['supplier unit', 2500], ['deposit', 1729]]);
  assert.ok(mixed.ledger.groups.every(g => g.complete === false));
});

test('F04: withdrawal exclusion survives uncertainty and including withdrawals', async t => {
  const f = ledgerFixture(t);
  f.add('withdrawal', 'Settlement', 'Payer One', { cents: 41383 });
  f.raw("UPDATE fin_transactions SET category='TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS',category_basis_state='confirmed'");
  const control = await reachedAnswer(f, income);
  f.add('unknown', 'Deposit', null, { cents: 1000 });
  const body = await reachedAnswer(f, income);
  for (const result of [control, body]) {
    assert.equal(result.ledger.default_exclusions.withdrawal_minor, 41383);
    assert.equal(result.ledger.lead_attributed_subtotal_minor, 0);
    assert.equal(result.ledger.lead_total_minor, null);
    assert.equal(result.ledger.total_minor, null);
    assert.equal(result.ledger.complete, false);
    assert.match(result.answer, /withdrawals left out/);
    assert.ok(result.ledger.flip.includes('including withdrawals'));
    assert.doesNotMatch(result.answer, /\$0\.00/);
  }
  const included = await reachedAnswer(f, `${income.slice(0, -1)} including withdrawals?`);
  assert.equal(included.ledger.default_exclusions.withdrawal_minor, 0);
  assert.equal(included.ledger.lead_attributed_subtotal_minor, 41383);
  assert.equal(included.evidence_gate.complete, false);
});

test('F05: metadata tail cannot turn a positive payment into zero income', async t => {
  const f = ledgerFixture(t);
  f.add('receipt', 'WIRE FROM Payer One BENEFICIARY Operating Company', null);
  assert.equal((await reachedAnswer(f, payment)).ledger.found, true);
  const body = await reachedAnswer(f, income);
  f.raw("UPDATE fin_transactions SET description='WIRE FROM Payer One REF 48261703'");
  assert.equal((await reachedAnswer(f, income)).ledger.attributed_subtotal_minor, 2500);
  uncertain(body);
});

test('only a proven window without any inflows permits absence, even with an amount', async t => {
  const f = ledgerFixture(t);
  f.add('outside', 'Deposit', null, { date: '2026-09-30' });
  f.add('outflow', 'Settlement', 'Payer One', { direction: 'outflow' });
  for (const q of [payment, income]) {
    const empty = await reachedAnswer(f, q);
    assert.equal(empty.ledger.found, false);
    assert.equal(empty.evidence_gate.complete, true);
    assert.match(empty.answer, /no deposits at all in this period/i);
  }
  f.add('other', 'Settlement', 'Payer Two', { cents: 3900 });
  for (const q of [payment, income, 'Did the payment of $25 from Payer One arrive in October 2026?']) uncertain(await reachedAnswer(f, q));
  f.raw("UPDATE fin_account_coverage SET coverage_status='partial'");
  const before = f.calls.length;
  const unproven = await f.ask(payment);
  assert.ok(f.calls.length > before, 'coverage decision reached');
  assert.equal(unproven.ledger, undefined);
  assert.equal(unproven.gaps[0].reason, 'period_outside_coverage');
});

test('inflow list caps at ten and keeps the account and date scope, not the amount filter', async t => {
  const f = ledgerFixture(t);
  for (let i = 0; i < 12; i++) f.add(`row-${i}`, 'Secret bank narration', 'Payer Two', { cents: 3900 + i });
  f.add('outside', 'Deposit', null, { date: '2026-09-30' });
  f.add('outflow', 'Deposit', null, { direction: 'outflow' });
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,source_feed,basis_state,recorded_at)
    VALUES ('other-account','owner','checking','asset','9876','live','feed','bank-feed:fixture-feed','confirmed',?)`, NOW);
  f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at)
    VALUES ('other-account','complete','2024-01-01','2026-10-12',?,'feed','bank-feed:fixture-feed','confirmed',?)`, NOW, NOW);
  f.add('other-account-receipt', 'Outside selected account', 'Payer One');
  f.raw("UPDATE fin_transactions SET account_slug='other-account' WHERE txn_uid='other-account-receipt'");
  assert.equal((await reachedAnswer(f, payment)).ledger.found, true, 'other account positive control');
  const body = await reachedAnswer(f, 'Did the payment of $25 from Payer One arrive in October 2026 in account 1234?');
  assert.equal((await reachedAnswer(f, 'Did the payment of $39 from Payer Two arrive in October 2026?')).ledger.found, true);
  uncertain(body, 12);
  assert.doesNotMatch(JSON.stringify(body), /Secret bank narration|Payer Two|2026-09-30|9876|Outside selected account/);
});

test('unsupported named recent deposits preserve document routing', async t => {
  const f = ledgerFixture(t);
  f.add('receipt', 'Settlement', 'Payer One');
  assert.equal((await reachedAnswer(f, 'Show recent deposits')).ledger.kind, 'deposits');
  const question = 'Show recent deposits from Payer One';
  assert.equal(classifyLedgerQuestion(question, { now: Date.parse(NOW) }).kind, null);
  const count = f.calls.length, documents = f.documentCalls;
  const body = await f.ask(question);
  assert.equal(body.route, 'documents');
  assert.equal(f.documentCalls, documents + 1);
  assert.equal(f.calls.length, count);
});

test('all 30 review formats discriminate structured presence and unmatched payer uncertainty', async t => {
  let observed = 0;
  for (const description of originatorFormats) {
    const f = ledgerFixture(t);
    f.add('receipt', description, null);
    for (const q of [payment, income]) {
      const body = await reachedAnswer(f, q);
      assert.notEqual(body.ledger.found, false);
      assert.notEqual(body.ledger.total_minor, 0);
      if (q === income) assert.equal(body.evidence_gate.complete, false);
      observed++;
    }
    await positive(f);
  }
  assert.equal(observed, 60);
});
