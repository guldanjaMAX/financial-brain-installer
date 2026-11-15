import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { ledgerFixture } from './ledger-review-fixture.mjs';

const spending = 'How much did I spend this month?';
const out = 'How much money went out this month?';
function book(t, kind = 'savings') {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-12T12:00:00Z'));
  const f = ledgerFixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  f.raw(`INSERT INTO fin_accounts(account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,basis_state,recorded_at)
    VALUES ('reserve','owner',?,?,'2222','Reserve account','manual','owner_stated','confirmed','2026-10-12')`, kind,
    ['card','loan'].includes(kind) ? 'liability' : kind === 'other' ? 'neither' : 'asset');
  f.raw(`INSERT INTO fin_account_coverage(account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
    VALUES ('reserve','complete','2024-01-01','2026-10-31','2026-10-12','owner_stated','confirmed','2026-10-12')`);
  f.add('ordinary','Store purchase','Store Unit',{cents:10000,direction:'outflow'});
  return f;
}
async function reached(f, question) {
  const before = f.calls.length, changes = f.first('SELECT total_changes() n').n;
  const response = await worker.fetch(new Request('https://fixture.invalid/api/rag/think', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': f.env.ADMIN_KEY }, body: JSON.stringify({ q: question }),
  }), f.env, { waitUntil() {} });
  const b = await response.json();
  assert.ok(f.calls.slice(before).some(sql => /fin_accounts|JOIN fin_transactions/.test(sql)), 'real scope or amount decision reached');
  assert.equal(f.first('SELECT total_changes() n').n, changes, 'reading never writes');
  assert.equal(f.documentCalls, 0, 'money remains a bank reading');
  return b;
}
function answered(b, figure) {
  assert.match(b.answer, figure);
  assert.doesNotMatch(b.answer, /withheld|cannot|can't/i);
  assert.match(b.confidence_text, /Confidence: Low \(0%\).*Why:.*Missing:/s);
  for (const part of ['Coverage:', 'Missing or counted twice:', 'Estimates:', 'How to check:']) assert.ok(b.answer.includes(part), part);
  assert.equal(b.ledger.complete, false);
}
for (const [id, description, payee, kind, question, category] of [
  ['HOLD-02','Card payment','Card payment','card','How much money came in this month?'],
  ['HOLD-03','payment to account 9999','Card payment','card',spending],
  ['HOLD-04','WIRE TRANSFER TO SAVINGS SUPPLY',null,'savings',spending],
  ['HOLD-05','WIRE TO OWNER ESCROW XXXX2222',null,'savings',out],
  ['HOLD-07','Card payment',null,'card',spending,'SERVICES'],
  ['HOLD-08','LOAN PAYMENT INCLUDING FEE 2.00',null,'loan',spending],
  ['HOLD-09','ACH DEBIT 401K REMITTANCE FEE 2.00',null,'savings',spending],
]) test(`${id}: observed figure with explicit uncertain component beside a green control`, async t => {
  const f = book(t, kind);
  const control = await reached(f, spending);
  assert.equal(control.ledger.expense_total_minor, 10000, 'populated ordinary control');
  f.add('candidate',description,payee,{cents:2500,direction:id === 'HOLD-02' ? 'inflow' : 'outflow'});
  if (category) f.raw("UPDATE fin_transactions SET category=?,category_basis_state='confirmed' WHERE txn_uid='candidate'", category);
  if (id === 'HOLD-05') {
    f.add('counterpart','Incoming credit',null,{cents:2500});
    f.raw("UPDATE fin_transactions SET account_slug='reserve' WHERE txn_uid='counterpart'");
  }
  const b = await reached(f, question);
  answered(b, id === 'HOLD-02' ? /\$25\.00/ : /\$125\.00/);
  assert.ok(b.citations.some(c => c.amount_minor === 2500), 'uncertain amount evidence reached');
  if (id === 'HOLD-05') assert.match(b.answer, /ending 2222.*up to \$25\.00 may be counted twice/s);
  if (['HOLD-08','HOLD-09'].includes(id)) assert.match(b.answer, /components (?:have )?not (?:been )?split/);
});
test('HOLD-01: unresolved loan scope answers identifiable candidates without substituting ordinary purchases', async t => {
  const f = book(t);
  assert.equal((await reached(f, spending)).ledger.expense_total_minor, 10000);
  const b = await reached(f, 'What did my loan account spend this month?');
  answered(b, /\$0\.00.*identifiable loan.payment/s);
  assert.match(b.answer, /unresolved|unconfirmed/);
  assert.doesNotMatch(b.answer, /\$100\.00/);
});
for (const question of [spending, 'What were my largest expenses this month?']) test(`HOLD-10 / C7: account-kind review keeps visible bounded amounts: ${question}`, async t => {
  const f = book(t, 'card');
  assert.equal((await reached(f, spending)).ledger.expense_total_minor, 10000);
  f.add('candidate','TRANSFER TO ACCOUNT 2222',null,{cents:2500,direction:'outflow'});
  f.raw("UPDATE fin_accounts SET account_kind='other',balance_role='neither' WHERE account_slug='reserve'");
  const b = await reached(f, question);
  answered(b, /\$100\.00/);
  assert.match(b.answer, /\$25\.00/);
  assert.match(b.answer, /ending 2222/);
  if (question === spending) {
    assert.match(b.answer, /at least \$100\.00; \$25\.00 more may be a card payment \(unconfirmed\)/i);
    assert.equal(b.ledger.expense_total_minor, null);
    assert.equal(b.ledger.retained_outflow_minor, 12500);
  } else assert.ok(b.ledger.rows.length > 0, 'ranked candidates are populated');
});

test('qualified totals retain the inclusion flag on observed own-account inflows', async t => {
  const f = book(t);
  f.add('income','Transfer from my unconnected own account',null,{cents:7000});
  const q = 'How much came in and went out this month?';
  const control = await reached(f,q);
  assert.equal(control.ledger.possible_owned_credits[0].included_in_total,true);
  f.add('uncertain','payment to account 9999','Card payment',{cents:2500,direction:'outflow'});
  const b = await reached(f,q);
  answered(b,/\$70\.00/);
  assert.equal(b.ledger.reason,'owned_movement_unconfirmed','qualified ownership decision reached');
  assert.equal(b.ledger.lead_accounts.reduce((n,a)=>n+a.credits_minor,0),7000);
  assert.equal(b.ledger.possible_owned_credits[0].amount_minor,7000);
  assert.equal(b.ledger.possible_owned_credits[0].included_in_total,true);
  const impact = b.answer.split('Missing or counted twice:')[1].split('\n')[0];
  assert.equal((impact.match(/\$25\.00/g)||[]).length,1,'one posting appears once in the uncertainty footer');
});

test('a disclosure-only receiving leg never claims inclusion in spending',async t=>{
 t.mock.method(Date,'now',()=>Date.parse('2026-10-12T12:00:00Z'));
 t.mock.method(globalThis,'fetch',()=>assert.fail('network forbidden'));
 const f=ledgerFixture(t);f.owner('private');f.raw("UPDATE fin_entities SET kind='person' WHERE entity_slug='private'");
 f.raw("INSERT INTO fin_accounts(account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at) VALUES ('card','private','card','liability','2222','manual','owner_stated','confirmed','2026-10-12')");
 f.raw("INSERT INTO fin_account_coverage(account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at) VALUES ('card','complete','2024-01-01','2026-10-31','2026-10-12','owner_stated','confirmed','2026-10-12')");
 f.add('out','payment to account 2222','Card payment',{cents:80000,direction:'outflow'});
 f.add('in','payment from account 1234','Card payment',{cents:80000});f.raw("UPDATE fin_transactions SET account_slug='card' WHERE txn_uid='in'");
 const ask=async()=> (await worker.fetch(new Request('https://fixture.invalid/api/rag/think',{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Key':f.env.ADMIN_KEY},body:JSON.stringify({q:'How much did I spend this month?'})}),f.env,{waitUntil(){}})).json();
 const control=await ask();assert.equal(control.ledger.expense_total_minor,0);assert.equal(control.ledger.own_account_payments.count,1);
 f.raw("UPDATE fin_entities SET basis_state='proposed' WHERE entity_slug='owner'");
 const b=await ask();answered(b,/\$0\.00/);assert.equal(b.ledger.reason,'owned_movement_unconfirmed');assert.equal(b.ledger.expense_total_minor,0);
 assert.equal(b.ledger.uncertain_components[0].amount_minor,80000);
 const impact=b.answer.split('Missing or counted twice:')[1].split('\n')[0];
 assert.doesNotMatch(impact,/\$800\.00 included/,'the receiving leg is not in the zero spending figure');
});
