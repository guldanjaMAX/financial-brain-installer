import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, NOW } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { isOwnedMovementChannel } from '../src/lib/ledger-analysis.js';

// Independent enumeration of the existing recognizer's closed channel grammar.
const channels = ['', 'automatic ', 'internet ', 'mobile ', 'online '].flatMap(prefix =>
  ['payment', 'credit card payment', 'card payment', 'loan payment', 'transfer'].map(noun => prefix + noun));
const cases = [text => text, text => text.toUpperCase(), text => text.replace(/\b\w/g, c => c.toUpperCase()),
  text => [...text].map((c, i) => i % 2 ? c.toUpperCase() : c).join('')];
const period = month => ({ type: 'between', from: `2026-${month}-01`, to: `2026-${month}-${month === '08' ? '31' : '30'}` });
async function recorded(f, question, intents) {
  let calls = 0;
  f.env.ANTHROPIC_API_KEY = f.env.ADMIN_KEY;
  try {
    const body = await (await withLedgerAnswer({ env: f.env, question, now: Date.parse(NOW), grantScope: { all: true },
      scopePrincipalKind: 'owner', callLLM: async () => {
        calls++;
        return { content: [{ type: 'text', text: JSON.stringify({ ambiguous: false, unanswered_part: null,
          intents: intents.map(intent => ({ direction: null, count: null, vendor_text: null, account_hint: null,
            amount_text: null, date_text: null, ...intent })) }) }] };
      } }, () => assert.fail('ledger decision required'))).json();
    assert.equal(calls, 1, 'recorded interpretation reached');
    assert.ok(body.ledger);
    return body;
  } finally { delete f.env.ANTHROPIC_API_KEY; }
}
function book(t, label) {
  const f = fixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  for (const [slug, kind, mask, role] of [['business', 'checking', '4100', 'business'],
    ['personal', 'checking', '4104', 'person'], ['card', 'card', '4106', 'business']]) {
    f.owner(slug); f.raw('UPDATE fin_entities SET kind=? WHERE entity_slug=?', role, slug);
    f.raw(`INSERT INTO fin_accounts(account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at)
      VALUES(?,?,?,?,?,'manual','owner_stated','confirmed',?)`, slug, slug, kind, kind === 'card' ? 'liability' : 'asset', mask, NOW);
    f.raw(`INSERT INTO fin_account_coverage(account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES(?,'complete','2026-01-01','2026-10-31',?,'owner_stated','confirmed',?)`, slug, NOW, NOW);
  }
  f.post = (id, slug, date, direction, cents, description, payee = description) => f.raw(`INSERT INTO fin_transactions
    (txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,provenance,basis_state,recorded_at)
    VALUES(?,?,?,?,?,?,?,'owner_stated','confirmed',?)`, id, slug, date, cents, direction, description, payee, NOW);
  if (label !== null) {
    f.post('payment-out', 'business', '2026-09-20', 'outflow', 80000, 'payment to account 4106', label);
    f.post('payment-in', 'card', '2026-09-20', 'inflow', 80000, 'payment from account 4100', label);
  }
  f.post('ordinary', 'business', '2026-08-05', 'outflow', 137, 'Service purchase', 'Service Unit');
  return f;
}
const surfaces = [
  ['single', f => f.ask('How much money went out last month?'), b => b.ledger],
  ['comparison', f => recorded(f, 'August vs September spending', ['08', '09'].map(month =>
    ({ kind: 'expense_summary', direction: 'outflow', period: period(month) }))), b => b.ledger.parts[1]],
  ['split', f => recorded(f, 'September spending split between business and personal', ['business', 'personal'].map(account_hint =>
    ({ kind: 'expense_summary', direction: 'outflow', account_hint, period: period('09') }))), b => b.ledger.parts[0]],
  ['monthly', f => recorded(f, 'Could you retrieve spending month by month since August?',
    [{ kind: 'expense_summary', direction: 'outflow', period: { type: 'since', date: '2026-08-01' } }]), b => b.ledger.months[1]],
  ['inout', f => f.ask('money in and money out last month'), b => b.ledger],
  ['business', f => recorded(f, 'How much did my business spend in September?',
    [{ kind: 'expense_summary', direction: 'outflow', account_hint: 'business', period: period('09') }]), b => b.ledger],
];
function withheld(part, body, surface) {
  assert.equal(part.reason, 'owned_movement_unconfirmed', 'specific ownership decision reached');
  assert.ok(part.complete === false || part.available === false);
  for (const field of ['total_minor', 'expense_total_minor', 'combined_inflow_minor', 'outside_inflow_minor', 'net_minor'])
    assert.equal(part[field] ?? null, null, field + ' withheld');
  assert.equal(part.lead_accounts, undefined, 'no certified ordinary account totals');
  if (surface === 'single' || surface === 'inflow')
    assert.ok(body.citations.some(c => c.amount_minor === 80000), 'movement evidence retained');
  assert.match(body.answer, /possible own.account movement|ownership.*unconfirmed/i);
}
for (const channel of channels) for (const [caseIndex, transform] of cases.entries()) for (const side of ['business', 'card']) {
  const label = transform(channel);
  test(`channel ownership ${channel} case=${caseIndex} side=${side}: six surfaces and inflow`, async t => {
    const f = book(t, label), greens = [];
    for (const [name, read, select] of surfaces) {
      const before = f.calls.length, body = await read(f), part = select(body);
      assert.ok(f.calls.slice(before).some(sql => /JOIN fin_transactions/.test(sql)), name + ': green reader reached');
      assert.equal(name === 'monthly' ? part.total_minor : name === 'inout'
        ? part.lead_accounts.reduce((n, a) => n + a.debits_minor, 0) : part.expense_total_minor, 0, name + ': proved payment excluded');
      if (name === 'single') assert.equal(part.own_account_payments.count, 1, 'nonempty recognized movement');
      if (name === 'comparison') assert.equal(body.ledger.parts[0].expense_total_minor, 137);
      if (name === 'monthly') assert.equal(body.ledger.months[0].total_minor, 137);
      greens.push(name);
    }
    assert.equal(greens.length, 6);
    const inflow = await f.ask('How much money came in last month?');
    assert.equal(inflow.ledger.outside_inflow_minor, 0); assert.equal(inflow.ledger.matched_own_transfers.count, 1);
    f.raw("UPDATE fin_entities SET basis_state='proposed' WHERE entity_slug=?", side);
    for (const [name, read, select] of surfaces) {
      const before = f.calls.length, body = await read(f);
      assert.ok(f.calls.slice(before).some(sql => /JOIN fin_transactions/.test(sql)), name + ': unresolved reader reached');
      withheld(select(body), body, name);
      if (name === 'single') assert.ok(body.ledger.possible_own_movement_count > 0, 'nonempty possible movement');
      if (name === 'comparison' && side === 'card') assert.equal(body.ledger.parts[0].expense_total_minor, 137);
      if (name === 'monthly' && side === 'card') assert.equal(body.ledger.months[0].total_minor, 137);
    }
    const uncertainInflow = await f.ask('How much money came in last month?');
    withheld(uncertainInflow.ledger, uncertainInflow, 'inflow');
  });
}
for (const channel of channels) for (const [caseIndex, transform] of cases.entries()) test(`bare channel ${channel} case=${caseIndex}`, async t => {
  const f = book(t, null);
  f.post('sep', 'business', '2026-09-05', 'outflow', 137, 'Service purchase', 'Service Unit');
  assert.equal((await f.ask('How much money went out last month?')).ledger.expense_total_minor, 137, 'ordinary green control');
  const label = transform(channel);
  f.post('bare', 'business', '2026-09-20', 'outflow', 80000, label, label);
  const before = f.calls.length, body = await f.ask('How much money went out last month?');
  assert.ok(f.calls.slice(before).some(sql => /JOIN fin_transactions/.test(sql)));
  // Bare unqualified payment/transfer labels retain the advisory policy. Only
  // explicitly typed liability channels had the untyped-repayment guard.
  if (/\b(?:card|loan) payment$/.test(channel)) {
    assert.equal(body.ledger.possible_payment_count, 1, 'bare-channel decision reached');
    assert.equal(body.ledger.reason, 'payment_membership_unconfirmed');
    assert.equal(body.ledger.expense_total_minor, null); assert.equal(body.ledger.complete, false);
  } else {
    assert.equal(body.ledger.expense_total_minor, 80137, 'unqualified advisory channel is retained');
    assert.equal(body.ledger.reason, undefined);
  }
});


test('channel grammar accepts exactly the normalized closed set and rejects sibling words', () => {
  assert.equal(channels.length, 25); assert.equal(new Set(channels).size, 25);
  let accepted = 0, rejected = 0;
  for (const channel of channels) for (const transform of cases) {
    assert.equal(isOwnedMovementChannel(transform(channel)), true, channel); accepted++;
    assert.equal(isOwnedMovementChannel(transform(channel), { liabilityOnly: true }), /\b(?:card|loan) payment$/.test(channel));
    assert.equal(isOwnedMovementChannel(transform(channel), { cardOnly: true }), /\bcard payment$/.test(channel));
    for (const near of ['scheduled ' + channel, channel + ' received', channel + 's',
      'online ' + 'mobile ' + channel, channel.replace('payment', 'repayment').replace('transfer', 'transfers')]) {
      assert.equal(isOwnedMovementChannel(transform(near)), false, near); rejected++;
    }
  }
  for (const text of ['', null, undefined, 'mortgage payment', 'autopay', 'credit payment',
    'internet', 'pay', 'card', 'mobile payment from account 4100', 'online transfer to account 4106'])
    assert.equal(isOwnedMovementChannel(text), false);
  assert.equal(accepted, 100); assert.equal(rejected, 500);
});
for (const label of ['Scheduled card payment', 'Online card payments', 'Online mobile card payment',
  'Online mortgage payment', 'Automatic repayment', 'Card payment received', 'Service Unit'])
  test(`unrecognized channel remains ordinary: ${label}`, async t => {
    const f = book(t, label);
    const known = await f.ask('How much money went out last month?');
    assert.equal(known.ledger.expense_total_minor, 80000, 'outside-channel green control reaches ordinary expense');
    f.raw("UPDATE fin_entities SET basis_state='proposed' WHERE entity_slug='card'");
    const before = f.calls.length, body = await f.ask('How much money went out last month?');
    assert.ok(f.calls.slice(before).some(sql => /JOIN fin_transactions/.test(sql)));
    assert.equal(body.ledger.expense_total_minor, 80000);
    assert.equal(body.ledger.reason, undefined, 'shared channel guard cannot accept extra words');
  });


for (const channel of channels.filter(label => !/\bcard payment$/.test(label)))
  test(`channel text alone cannot establish uncertain ownership: ${channel}`, async t => {
    const f = book(t, channel);
    const green = await f.ask('How much money went out last month?');
    assert.equal(green.ledger.expense_total_minor, 0); assert.equal(green.ledger.own_account_payments.count, 1);
    f.raw("UPDATE fin_transactions SET description='payment to account 9999' WHERE txn_uid='payment-out'");
    f.raw("UPDATE fin_entities SET basis_state='proposed' WHERE entity_slug='personal'");
    assert.equal(f.first("SELECT COUNT(*) n FROM fin_entities WHERE basis_state='proposed'").n, 1, 'nonempty unrelated uncertainty control');
    const before = f.calls.length, body = await f.ask('How much money went out last month?');
    assert.ok(f.calls.slice(before).some(sql => /JOIN fin_transactions/.test(sql)), 'outside endpoint decision reached');
    assert.ok(f.calls.slice(before).some(sql => sql.includes("e.basis_state<>'confirmed'")), 'uncertain inventory decision reached');
    assert.equal(body.ledger.expense_total_minor, null, 'an unproved endpoint with an equal connected credit withholds money out');
    assert.equal(body.ledger.reason, 'money_out_destination_unconfirmed');
    const candidate = body.ledger.possible_payments.find(row => row.amount_minor === 80000);
    assert.ok(candidate && candidate.connected_counterpart_masks.includes('4106'), 'the equal counterpart decision was reached');
    assert.equal(candidate.included_in_total, undefined);
    assert.equal(body.ledger.complete, false);
  });
