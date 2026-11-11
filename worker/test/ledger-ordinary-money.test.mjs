import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ordinaryMoneyMembership } from '../src/lib/ledger-analysis.js';
const account = (slug, mask, kind = 'checking') => ({ account_slug: slug, account_kind: kind, members: [{ mask, account_kind: kind }] });
const accounts = new Map([['a', account('a','1111')], ['b', account('b','2222')], ['loan', account('loan','3333','loan')]]);
const row = (description, direction = 'outflow', slug = 'a') => ({ id: 1, effective_account_slug: slug, amount_minor: 1, currency: 'USD', description, direction });
test('ordinary membership retains unpaired endpoints as possible movements in both directions', () => {
  const control = ordinaryMoneyMembership([row('Outside purchase')], [], accounts);
  assert.equal(control.ordinary.length, 1); assert.equal(control.possible.size, 0);
  for (const [description, direction] of [['TRANSFER TO ACCOUNT 2222','outflow'],['TRANSFER FROM ACCOUNT 2222','inflow'],['TRANSFER FROM ACCOUNT 1111 TO ACCOUNT 2222','outflow'],['TRANSFER FROM ACCOUNT 2222 TO ACCOUNT 1111','inflow']])
    {
      const membership=ordinaryMoneyMembership([row(description,direction)],[],accounts);
      assert.equal(membership.ordinary.length,1); assert.equal(membership.possible.size,1); assert.equal(membership.excluded.size,0);
    }
});
test('ordinary membership retains ambiguous, contradictory and external attribution', () => {
  for (const r of [row('TRANSFER TO ACCOUNT 9999'), row('TRANSFER TO CARD 2222'), {...row('TRANSFER TO ACCOUNT 2222'),payee:'Outside merchant'}, row('refund from account 2222'), row('TRANSFER FROM ACCOUNT 2222 TO ACCOUNT 3333')])
    assert.equal(ordinaryMoneyMembership([r],[],accounts).ordinary.length,1);
  const ambiguous = new Map([...accounts, ['c',account('c','2222')]]);
  assert.equal(ordinaryMoneyMembership([row('TRANSFER TO ACCOUNT 2222')],[],ambiguous).ordinary.length,1);
});
test('unpaired owned loan acknowledgement remains a possible recorded movement', () => {
  const membership=ordinaryMoneyMembership([row('TRANSFER FROM ACCOUNT 1111','inflow','loan')],[],accounts);
  assert.equal(membership.ordinary.length,1);
  assert.equal(membership.possible.size,1, 'endpoint nomination decision reached');
  assert.equal(membership.excluded.size,0);
});
import { replay } from '../../eval/fast-loop/money-replay.mjs';
import { scoreObservation } from '../../eval/fast-loop/money-score.mjs';
import { CONTROLS } from '../../test/fixtures/fastloop-money/input.mjs';
import { goldFor } from '../../test/fixtures/fastloop-money/gold.mjs';
test('money-out totals key retains an unpaired endpoint with its cited uncertainty', () => {
  const input = { ...CONTROLS.find(c => c.id === 'M05/gross'), question: 'How much money came in and went out this month?' };
  const gold = { ...goldFor('M05/gross'), ordinary_totals: true, ordinary_excluded: [], ordinary_debits: '101000' };
  const observation = replay({ cases: [input] }).observations[0];
  assert.ok(observation.trace.rows_read.some(row=>row.id===7), 'unpaired posting decision reached');
  assert.equal(scoreObservation(observation, input, gold).verdict, 'correct');
  for (const corrupt of [
    o => o.body.ledger.lead_accounts[0].debits_minor++,
    o => o.body.answer = o.body.answer.replace('$1,010.00', '$1,010.01'),
    o => o.body.answer = o.body.answer.split('\n').slice(1).join('\n'),
    o => o.body.ledger.accounts[0].debits_minor++,
  ]) {
    const changed = structuredClone(observation); corrupt(changed);
    assert.notDeepEqual(changed, observation, 'corruption reached the real observation');
    assert.equal(scoreObservation(changed, input, gold).verdict, 'wrong figure');
  }
});
test('owned endpoint resolution does not rescan the inventory for each candidate', () => {
  let scans = 0;
  class Inventory extends Map { values() { scans++; return super.values(); } }
  const inventory = new Inventory(Array.from({ length: 200 }, (_, i) => [String(i), account(String(i), String(1000 + i))]));
  const selected = { ...row('TRANSFER TO ACCOUNT 1199'), effective_account_slug: '0' };
  const membership=ordinaryMoneyMembership([selected], [], inventory);
  assert.equal(membership.ordinary.length, 1); assert.equal(membership.possible.size, 1);
  assert.ok(scans <= 2, 'one directed endpoint must not perform one full scan per candidate account');
});
test('an opaque posting account cannot prove a named movement without its counterpart', () => {
  const inventory = new Map([...accounts, ['opaque', account('opaque','4444','other')]]);
  const membership=ordinaryMoneyMembership([row('TRANSFER FROM ACCOUNT 1111','inflow','opaque')],[],inventory);
  assert.equal(membership.ordinary.length,1);
  assert.equal(membership.possible.size,1, 'endpoint nomination decision reached');
  assert.equal(membership.excluded.size,0);
});
test('money-in-minus-out uses ordinary membership and retains an explicit gross alternate', () => {
  const input = { ...CONTROLS.find(c => c.id === 'M05/gross'), question: 'What was my net income this month?' };
  const ordinary = replay({ cases: [input] }).observations[0];
  assert.equal(ordinary.body.ledger.net_minor, -77668, '23332 money in minus 101000 money out, including the unpaired endpoint');
  const gross = replay({ cases: [{ ...input, question: 'What was my net income this month including transfers?' }] }).observations[0];
  assert.equal(gross.body.ledger.net_minor, -77668, 'an unpaired payment remains inside money out and net');
  assert.equal(gross.body.ledger.possible_payments_included_minor, 40000, 'the unpaired payment is disclosed as included');
  assert.ok(gross.body.ledger.possible_payments[0].included_in_total);
  assert.match(gross.body.answer, /included in money out above, possibly/);
  assert.equal(gross.body.ledger.gross_activity?.net_minor, -77668,
    'S8 explicit gross activity remains available without restoring a payment as spending');
  assert.equal(gross.body.ledger.gross_activity.debits_minor, 101000);
  assert.match(gross.body.answer, /Gross posted activity.*not spending or income/);
  const source = readFileSync(new URL('../src/lib/ledger-answer.js', import.meta.url), 'utf8');
  const site = "if (intent.kind === 'totals' && intent.measure && intent.ownTransfers === 'include') {";
  assert.equal(source.split(site).length - 1, 1);
  const restored = replay({ cases: [{ ...input, question: 'What was my net income this month including transfers?' }],
    sourceOverrides: { 'ledger-answer.js': source.replace(site, 'if (false) {') } }).observations[0];
  assert.throws(() => assert.equal(restored.body.ledger.gross_activity?.net_minor, -77668), assert.AssertionError,
    'removing the S8 gross alternate turns the independent raw-cents assertion red');
});
test('an unpaired named loan advance stays possible until its other feed leg is proved', () => {
  const membership=ordinaryMoneyMembership([row('LOAN ADVANCE FROM ACCOUNT 3333','inflow')],[],accounts);
  assert.equal(membership.ordinary.length,1);
  assert.equal(membership.possible.size,1, 'endpoint nomination decision reached');
  assert.equal(membership.excluded.size,0);
});
test('conditional and primary money-out totals both retain an unpaired endpoint', () => {
  const input = { ...CONTROLS.find(c => c.id === 'M05/gross'), question: 'How much money came in and went out this month?' };
  const body = replay({ cases: [input] }).observations[0].body;
  assert.equal(body.ledger.lead_accounts.reduce((n,a) => n + a.debits_minor,0),101000);
  assert.equal(body.ledger.if_own_transfers.accounts.reduce((n,a) => n + a.debits_minor,0),101000);
});
