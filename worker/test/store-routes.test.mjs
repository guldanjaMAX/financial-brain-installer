import test from 'node:test';
import assert from 'node:assert/strict';
import { bookFor, oracle, runBook, questions } from './store-owner-shapes.measure.mjs';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';
import { fixture } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { answerText as apiText } from '../src/lib/answer-render.js';
import { answerText as appText } from '../../frontend/src/lib/answer-render.js';

for (const target of [8,9,10]) test(`Q${target} reaches existing reader without a model`, async () => {
 const book = bookFor(427), expected = oracle(book);
 const results = await runBook(book, false);
 assert.equal(results[0].body.ledger.kind, 'balance'); // green control
 for (const r of results.filter(r => r.q === target)) {
  assert.equal(r.modelCalls, 0);
  if (r.q === 8) {
   assert.deepEqual(r.body.ledger?.recurring.map(g => g.typical_minor).sort((a,b)=>a-b), expected.recurring);
   assert.deepEqual(r.body.ledger.recurring.map(g => g.account_mask).sort(), ['4100','4106','4107']);
   assert.match(r.body.answer, /detected.*not confirmed/i);
   for (const g of r.body.ledger.recurring) { assert.equal(g.cadence,'monthly'); assert.equal(g.last_charge,'2026-09-10'); assert.equal(g.citations.length,3); }
  } else if (r.q === 9) {
   assert.equal(r.body.ledger?.kind,'transfers');
   assert.ok(r.body.ledger.transfers.some(p => p.outgoing.account_mask === '4100' && p.incoming.account_mask === '4104' && p.amount_minor === 50000));
   // The integrated guard recognizes the two reciprocal card-payment pairs.
   assert.deepEqual(r.body.ledger.unmatched_transfers,[]);
   assert.equal(r.body.ledger.transfers.length,3);
   assert.equal(r.body.ledger.total_minor,expected.transfers);
  } else {
   assert.match(r.body.answer || '', /No payout schedule or expected-amount source is connected/);
   assert.match(r.body.answer, /recent deposits/);
   assert.ok(r.body.citations.some(c => c.posted_on === '2026-09-16' && c.amount_minor === 123456));
   assert.doesNotMatch(r.body.answer, /is late|not late|overdue/i);
  }
 }
});

test('clean packet variants and extra bank wording use the same real routes', async () => {
 const prompts = questions.map(row => [...row]);
 prompts[7]=['What do I pay for every month, by account?','Show recurring charges and the paying account','What charges hit every month, with the paying account?'];
 prompts[8]=['How much did I transfer between my own accounts last month?','Show own account transfers last month','What moved between my own accounts last month?'];
 prompts[9]=['Which financing payouts have not landed in the bank yet?','Which financing payouts have not arrived?','What financing payouts are still pending?'];
 for (const r of (await runBook(bookFor(427),false,prompts)).filter(r=>r.q>=8)) {
  assert.equal(r.modelCalls,0);
  if(r.q===8) assert.equal(r.body.ledger?.recurring.length,3);
  if(r.q===9) assert.equal(r.body.ledger?.transfers.length,3);
  if(r.q===10) assert.match(r.body.answer,/No payout schedule or expected-amount source is connected/);
 }
});

test('closed syntax never absorbs identity literals or extra qualifiers', () => {
 for (const q of ['Show recurring charges and the paying account at Example Bank',
  'What moved between my own accounts last month excluding savings',
  'Which financing payouts from Example Payer have not landed yet']) {
  const intent=classifyLedgerQuestion(q,{now:'2026-10-12T12:00:00Z'});
  assert.notEqual(intent.payingAccount,true); assert.notEqual(intent.financingBoundary,true);
  assert.notEqual(intent.kind,'transfers');
 }
});

test('Q10 names the boundary when no bank account or deposit evidence is available', async t => {
 const f=fixture(t); f.owner();
 const response=await withLedgerAnswer({env:f.env,question:questions[9][0],now:'2026-10-12T12:00:00Z',
  grantScope:{all:true},scopePrincipalKind:'owner'},async()=>{throw Error('DOCUMENT_MODEL_FORBIDDEN');});
 assert.match((await response.json()).answer,/No payout schedule or expected-amount source is connected/);
 const book=bookFor(427); book.accounts=[]; book.rows=[];
 for(const r of (await runBook(book,false)).filter(r=>r.q===10)) {
  assert.match(r.body.answer,/No payout schedule or expected-amount source is connected/);
  assert.deepEqual(r.body.citations,[]);
  assert.doesNotMatch(r.body.answer,/no payouts|not late|is late/i);
 }
});

test('Q9 preserves unmatched candidates and cites both sides of paired movements', async () => {
 const book=bookFor(427);
 book.rows.push({id:1000,account:0,date:'2026-09-24',cents:-7654,payee:'Transfer',description:'Transfer to account 4104'});
 for(const r of (await runBook(book,false)).filter(r=>r.q===9)) {
  assert.ok(r.body.ledger.unmatched_transfers.some(row=>row.amount_minor===7654));
  assert.match(r.body.answer,/Possible transfer, unmatched \(not counted\)/);
  for(const pair of r.body.ledger.transfers) {
   assert.equal(pair.outgoing.posted_on,'2026-09-20');
   assert.equal(pair.incoming.amount_minor,pair.outgoing.amount_minor);
   assert.ok(r.body.citations.some(c=>c.n===pair.outgoing.n));
   assert.ok(r.body.citations.some(c=>c.n===pair.incoming.n));
  }
 }
});

test('Q8 retains paying-account and cadence evidence beside proved payment exclusions', async () => {
 const book=bookFor(427);
 for(const [i,month] of ['07','08'].entries()) book.rows.push({id:2000+i,account:0,
  date:`2026-${month}-20`,cents:-80000,payee:'Card payment',description:'payment to account 4106'});
 for(const r of (await runBook(book,false)).filter(r=>r.q===8)) {
  assert.equal(r.body.ledger.monthly_total_minor,5797);
  assert.equal(r.body.ledger.payment_exclusions.card_minor,263000);
  assert.deepEqual(r.body.ledger.recurring[0].cadence_dates,['2026-07-10','2026-08-10','2026-09-10']);
  for(const text of [r.body.answer,apiText(r.body),appText(r.body)]) {
   assert.match(text,/orbit service:.*paying account.*4100/);
   assert.match(text,/cadence evidence.*July 10.*August 10.*September 10/);
   assert.match(text,/Payments to loans and cards \(excluded from spending and income\)/);
  }
 }
});

test('Q8 uses reciprocal directed evidence to exclude proved asset movements', async () => {
 const book=bookFor(427);
 book.rows=book.rows.filter(row=>!row.move || row.cents===50000 || row.cents===-50000);
 for(const r of (await runBook(book,false)).filter(r=>r.q===8)) {
  assert.notEqual(r.body.ledger.complete,false);
  assert.deepEqual(r.body.ledger.possible_owned_movements,[]);
  assert.deepEqual(r.body.ledger.recurring.map(g=>g.typical_minor).sort((a,b)=>a-b),[1499,2099,2199]);
 }
});

test('Q10 shows recorded payer labels even when the bank memo is generic', async () => {
 const book=bookFor(427);
 book.rows.find(row=>row.cents===123456).description='Bank deposit';
 for(const r of (await runBook(book,false)).filter(r=>r.q===10)) {
  assert.match(r.body.answer,/bank payer label: Payer Unit/);
  assert.ok(r.body.citations.some(c=>c.amount_minor===123456 && c.posted_on==='2026-09-16'));
 }
});
