import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';

function ownedBook(t) {
  const f = fixture(t);
  for (const [slug, kind, mask, entityKind] of [['business', 'checking', '4100', 'business'], ['personal', 'card', '4106', 'person']]) {
    f.owner(slug);
    f.raw('UPDATE fin_entities SET kind=?,display_label=? WHERE entity_slug=?', entityKind, entityKind === 'business' ? 'Business Unit' : 'Personal Unit', slug);
    f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at)
      VALUES (?,?,?,?,?,'manual','owner_stated','confirmed',?)`, slug, slug, kind, kind === 'card' ? 'liability' : 'asset', mask, NOW);
    f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES (?,'complete','2026-01-01','2026-10-31',?,'owner_stated','confirmed',?)`, slug, NOW, NOW);
  }
  f.post = (id, account, direction, description, payee, cents = 80000, day = '2026-09-20') => f.raw(`INSERT INTO fin_transactions
    (txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,provenance,basis_state,recorded_at)
    VALUES (?,?,?,?,?,?,?,'owner_stated','confirmed',?)`, id, account, day, cents, direction, description, payee, NOW);
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  f.env.AI.run = () => assert.fail('model forbidden');
  return f;
}

async function recorded(f, question, intents) {
  f.env.ANTHROPIC_API_KEY = f.env.ADMIN_KEY;
  let calls = 0;
  const body = await (await withLedgerAnswer({env:f.env, question, now:Date.parse(NOW), grantScope:{all:true}, scopePrincipalKind:'owner',
    callLLM: async () => { calls++; return {content:[{type:'text',text:JSON.stringify({ambiguous:false,unanswered_part:null,
      intents:intents.map(intent => ({direction:null,count:null,vendor_text:null,account_hint:null,amount_text:null,date_text:null,...intent}))})}]}; },
  }, () => assert.fail('recorded reading must reach ledger'))).json();
  assert.ok(calls > 0, 'recorded wire interpretation reached admission');
  delete f.env.ANTHROPIC_API_KEY;
  return body;
}

test('composite components share the single-period owned-transfer exclusion', async t => {
  const f = ownedBook(t);
  f.raw("UPDATE fin_accounts SET account_kind='checking',balance_role='asset' WHERE account_slug='personal'");
  f.post('move', 'business', 'outflow', 'TRANSFER TO ACCOUNT 4106', 'TRANSFER TO ACCOUNT 4106', 1, '2026-09-07');
  f.post('ordinary', 'business', 'outflow', 'Service purchase', 'Service Unit', 123, '2026-09-06');
  const single = await f.ask('How much did I spend in September?');
  const compare = await recorded(f, 'August vs September spending', [
    {kind:'expense_summary',direction:'outflow',period:{type:'between',from:'2026-08-01',to:'2026-08-31'}},
    {kind:'expense_summary',direction:'outflow',period:{type:'between',from:'2026-09-01',to:'2026-09-30'}},
  ]);
  assert.equal(single.ledger.expense_total_minor, 123, 'ordinary expense control survives the movement decision');
  assert.equal(compare.ledger.kind, 'multi', 'composite decision reached');
  assert.equal(compare.ledger.parts[1].expense_total_minor, single.ledger.expense_total_minor);
  const split = await recorded(f, 'September spending split between business and personal', ['business','personal'].map(account_hint =>
    ({kind:'expense_summary',direction:'outflow',account_hint,period:{type:'between',from:'2026-09-01',to:'2026-09-30'}})));
  assert.equal(split.ledger.kind, 'multi');
  assert.deepEqual(split.ledger.parts.map(p => p.expense_total_minor), [123, 0]);
  const flow = await f.ask('money in and money out in September');
  assert.ok(flow.ledger.lead_accounts.length > 0, 'money-in/out decision reached');
  assert.equal(flow.ledger.lead_accounts.reduce((n, a) => n + a.debits_minor, 0), 124);
  assert.equal(flow.ledger.possible_payments_included_minor, 1);
  assert.match(flow.answer, /included in money out above, possibly a transfer/);
  assert.match(compare.answer, /possible transfer to your own account, not counted as spending: \$0\.01/);
  f.post('receipt', 'personal', 'inflow', 'TRANSFER FROM ACCOUNT 4100', 'TRANSFER FROM ACCOUNT 4100', 1, '2026-09-07');
  const paired = await f.ask('money in and money out in September');
  assert.equal(paired.ledger.candidate_transfer_count, 1, 'reciprocal proof decision reached');
  assert.equal(paired.ledger.lead_accounts.reduce((n, a) => n + a.debits_minor, 0), 123, 'a proved pair is excluded');
});

test('owned card-payment channel cannot veto reciprocal owned endpoints', async t => {
  const f = ownedBook(t);
  f.post('payment-out', 'business', 'outflow', 'payment to account 4106', 'Card payment');
  f.post('payment-in', 'personal', 'inflow', 'payment from account 4100', 'Card payment');
  f.post('purchase', 'business', 'outflow', 'Service purchase', 'Service Unit', 321);
  f.post('receipt', 'business', 'inflow', 'Outside receipt', 'Payer Unit', 456);
  const incoming = await f.ask('How much money came in last month?');
  assert.equal(incoming.ledger.kind, 'totals');
  assert.equal(incoming.ledger.outside_inflow_minor, 456, 'outside-receipt green control');
  const outgoing = await f.ask('How much money went out last month?');
  assert.equal(outgoing.ledger.expense_total_minor, 321, 'purchase green control');
  const ranking = await f.ask('What were my 5 biggest expenses last month?');
  assert.equal(ranking.ledger.kind, 'largest', 'ranking decision reached');
  assert.deepEqual((ranking.ledger.lead_rows || ranking.ledger.rows).map(r => r.amount_minor), [321]);
  assert.match(outgoing.answer, /card.*(?:payment|repayment)|payment.*card/i);
  assert.equal(f.documentCalls, 0, 'all controls reach the ledger');
});

for (const [category, word] of [['advertising','advertisements'], ['software','softwares'], ['meals','meal'], ['travel','travels'],
  ['office supplies','office supply'], ['subscriptions','subscription'], ['marketing','marketing services'], ['fuel','fuels']]) {
  test(`unresolved category '${word}' withholds instead of certifying zero`, async t => {
    const f = ledgerFixture(t);
    f.add('expense', 'Service purchase', 'Service Unit', { date: '2026-08-15', direction: 'outflow', cents: 123 });
    f.raw("UPDATE fin_transactions SET category=?,category_basis_state='confirmed'", category);
    const exact = await f.ask(`How much did I spend on ${category} in Q3 2026?`);
    assert.equal(exact.ledger.total_minor ?? exact.ledger.expense_total_minor, 123, 'exact-category green control');
    const beforeNear = f.calls.length;
    const near = await f.ask(`How much did I spend on ${word} in Q3 2026?`);
    assert.ok(f.calls.slice(beforeNear).some(sql => /JOIN fin_transactions/.test(sql)), 'selector decision reached with a populated pool');
    assert.ok(near.ledger, 'ledger selector guard reached');
    assert.equal(near.ledger.total_minor, null);
    assert.equal(near.ledger.selector_unresolved, true);
    assert.match(near.answer, /not recognized/i);
    assert.ok(near.answer.includes(category), 'exact category offered');
    assert.doesNotMatch(near.answer, /\$0\.00|no matching transactions/i);
  });
}

test('unknown selector with no matching rows never certifies an empty category', async t => {
  const f = ledgerFixture(t);
  f.add('expense', 'Service purchase', 'Service Unit', { date:'2026-08-15', direction:'outflow', cents:123 });
  f.raw("UPDATE fin_transactions SET category='repairs',category_basis_state='confirmed'");
  const control = await f.ask('How much did I spend on repairs in Q3 2026?');
  assert.equal(control.ledger.total_minor, 123);
  const beforeUnknown = f.calls.length;
  const body = await f.ask('How much did I spend on zento in Q3 2026?');
  assert.ok(f.calls.slice(beforeUnknown).some(sql => /JOIN fin_transactions/.test(sql)), 'unknown selector reached its transaction decision');
  assert.ok(body.ledger, 'unknown selector decision reached');
  assert.equal(body.ledger.total_minor, null);
  assert.equal(body.ledger.selector_unresolved, true);
  assert.match(body.answer, /not recognized.*zento|zento.*not recognized/i);
  assert.match(body.answer, /repairs/);
  assert.doesNotMatch(body.answer, /\$0\.00|no matching transactions/i);
});

for (const side of ['business', 'personal']) for (const coded of [false, true]) test(`card movement with ${side} ownership unconfirmed withholds certified figures coded=${coded}`, async t => {
  const f = ownedBook(t);
  f.post('out', 'business', 'outflow', 'payment to account 4106', 'Card payment');
  f.post('in', 'personal', 'inflow', 'payment from account 4100', 'Card payment');
  if (coded) f.raw("UPDATE fin_transactions SET category='LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',category_basis_state='confirmed'");
  const known = await f.ask('How much money went out last month?');
  assert.equal(known.ledger.expense_total_minor, 0, 'confirmed ownership control reaches exclusions');
  assert.equal(known.ledger.own_account_payments.count, 1, 'nonempty owned-payment exclusion control');
  f.raw("UPDATE fin_entities SET basis_state='proposed' WHERE entity_slug=?", side);
  const body = await f.ask(side === 'business' ? 'How much money came in last month?' : 'How much money went out last month?');
  assert.ok(body.ledger, 'possible owned-movement decision reached');
  assert.equal(body.ledger.possible_own_movement_count, 1, 'nonempty unresolved movement decision');
  assert.equal(body.ledger.complete, false);
  assert.equal(body.ledger.total_minor, null);
  assert.equal(body.ledger.combined_inflow_minor ?? null, null);
  assert.equal(body.ledger.expense_total_minor ?? null, null);
  assert.match(body.answer, /possible.*own.*movement|possible.*own.*payment/i);
});

test('exact category selection keeps another known category with a shared word separate', async t => {
  const f = ledgerFixture(t);
  for (const [id, category, cents] of [['plain', 'supplies', 123], ['qualified', 'office supplies', 456]]) {
    f.add(id, 'Service purchase', 'Service Unit', { date:'2026-08-15', direction:'outflow', cents });
    f.raw("UPDATE fin_transactions SET category=?,category_basis_state='confirmed' WHERE txn_uid=?", category, id);
  }
  const plain = await f.ask('How much did I spend on supplies in Q3 2026?');
  const qualified = await f.ask('How much did I spend on office supplies in Q3 2026?');
  assert.equal(plain.ledger.total_minor, 123);
  assert.equal(qualified.ledger.total_minor, 456, 'independent exact-category green control');
  assert.ok(f.calls.some(sql => /JOIN fin_transactions/.test(sql)), 'shared-word decision reached');
});

for (const kind of ['CARD', 'LOAN']) test(`untyped ${kind} payment must withhold a broad component`, async t => {
  const f=ledgerFixture(t);
  f.add('ordinary','Service purchase','Service Unit',{date:'2026-09-10',cents:123,direction:'outflow'});
  assert.equal((await f.ask('How much did I spend in September?')).ledger.expense_total_minor,123,'ordinary green control');
  f.add('channel',kind+' PAYMENT',kind+' PAYMENT',{date:'2026-09-12',cents:80000,direction:'outflow'});
  const b=await f.ask('How much did I spend in September?');
  assert.ok(f.calls.some(sql=>/JOIN fin_transactions/.test(sql)),'nonempty membership decision reached');
  assert.equal(b.ledger.expense_total_minor,null);
  assert.equal(b.ledger.possible_payment_count,1,'nonempty untyped payment decision');
  assert.equal(b.ledger.complete,false);
  assert.match(b.answer,/withheld.*payment|payment.*withheld/i);
});

test('a refused payment component still discloses its possible refund', async t => {
  const f=ledgerFixture(t);
  f.add('ordinary','Service purchase','Service Unit',{date:'2026-09-10',cents:123,direction:'outflow'});
  f.add('credit','Service refund','Service Unit',{date:'2026-09-12',cents:50,direction:'inflow'});
  const read=()=>recorded(f,'Could you retrieve spending last month after refunds?', [{kind:'expense_summary',direction:'outflow',period:{type:'between',from:'2026-09-01',to:'2026-09-30'}}]);
  const green=await read();
  assert.equal(green.ledger.expense_total_minor,123);
  assert.equal(green.ledger.possible_refunds.length,1,'refund nomination green control');
  f.add('channel','CARD PAYMENT','CARD PAYMENT',{date:'2026-09-12',cents:80000,direction:'outflow'});
  const body=await read();
  assert.equal(body.ledger.reason,'payment_membership_unconfirmed','refusal decision reached');
  assert.equal(body.ledger.total_minor,null);
  assert.equal(body.ledger.possible_refunds?.length,1);
  assert.equal(body.ledger.possible_refunds[0].amount_minor,50);
  assert.equal(body.ledger.candidate_disclosure_unavailable,undefined);
  assert.match(body.answer,/possible refund, not subtracted: \$0\.50/);
});

test('monthly payment refusal preserves its specific reason and refund citations',async t=>{
 const f=ledgerFixture(t);
 f.add('aug','Service purchase','Service Unit',{date:'2026-08-10',cents:123,direction:'outflow'});
 f.add('sep','Service purchase','Service Unit',{date:'2026-09-10',cents:456,direction:'outflow'});
 f.add('credit','Service refund','Service Unit',{date:'2026-09-12',cents:50,direction:'inflow'});
 f.env.ANTHROPIC_API_KEY=f.env.ADMIN_KEY;
 let calls=0;
 const read=async()=> (await withLedgerAnswer({env:f.env,question:'Could you retrieve spending month by month since August after refunds?',now:Date.parse(NOW),grantScope:{all:true},scopePrincipalKind:'owner',callLLM:async()=>{calls++;return {content:[{type:'text',text:JSON.stringify({ambiguous:false,unanswered_part:null,intents:[{kind:'expense_summary',direction:'outflow',count:null,vendor_text:null,account_hint:null,amount_text:null,date_text:null,period:{type:'since',date:'2026-08-01'}}]})}]};}},()=>assert.fail('real monthly ledger required'))).json();
 const green=await read();assert.ok(calls>0);assert.deepEqual(green.ledger.months.map(m=>m.total_minor),[123,456,0]);
 assert.equal(green.ledger.months[1].possible_refunds.length,1,'monthly refund green control');
 f.add('channel','CARD PAYMENT','CARD PAYMENT',{date:'2026-09-12',cents:80000,direction:'outflow'});
 const b=await read();assert.equal(b.ledger.months[0].total_minor,123,'unaffected month remains exact');
 const month=b.ledger.months[1];assert.equal(month.available,false,'monthly refusal reached');assert.equal(month.total_minor,null);
 assert.equal(month.reason,'payment_membership_unconfirmed');
 assert.match(b.answer,/payment.*classification|payment.*code/i);
 assert.equal(month.possible_refunds.length,1);
 assert.ok(b.citations.some(c=>c.n===month.possible_refunds[0].n&&c.amount_minor===50));
 assert.equal(b.ledger.candidate_disclosure_unavailable,undefined);
});
