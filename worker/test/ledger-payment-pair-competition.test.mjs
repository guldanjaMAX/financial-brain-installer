import test from 'node:test';
import assert from 'node:assert/strict';
import {makeLedger} from './fixtures/owner-route-book.mjs';
import {withLedgerAnswer} from '../src/lib/ledger-answer.js';
globalThis.fetch=()=>assert.fail('network forbidden');
async function read(t,arm){
 const {f}=makeLedger(427,t);
 f.raw("UPDATE fin_account_coverage SET coverage_status='complete',covered_from='2026-07-01'");
 f.raw("DELETE FROM fin_transactions WHERE txn_uid NOT IN ('card-pay','card-receipt')");
 if(arm==='single')f.raw("DELETE FROM fin_transactions WHERE txn_uid='card-receipt'");
 if(arm==='extra-in'||arm==='extra-out'){
  const incoming=arm==='extra-in';
  f.raw("INSERT INTO fin_transactions(txn_uid,account_slug,posted_on,amount_minor,direction,description,provenance,basis_state,recorded_at) VALUES ('extra',?,'2026-10-23',23000,?,?,'owner_stated','confirmed','2026-11-03')",incoming?'card':'personal',incoming?'inflow':'outflow',incoming?'payment from account 2222':'payment to account 4444');
 }
 const before=f.calls.length;
 const body=await(await withLedgerAnswer({env:f.env,question:'How much came in last month?',now:'2026-11-03T19:00:00Z',scopePrincipalKind:'owner',grantScope:{all:true}},()=>Response.json({fallback:true}))).json();
 assert.ok(f.calls.slice(before).some(sql=>sql.includes('FROM fin_transactions')),'persisted postings read');
 assert.equal(f.rows('SELECT * FROM fin_transactions').length,arm==='pair'?2:arm==='single'?1:3);
 assert.ok(body.ledger.payment_exclusions.rows.length>0,'payment disclosure decision reached');
 return body;
}
test('green: unique bilateral pair is one payment and a single posting remains one',async t=>{
 for(const arm of ['pair','single']){
  const b=await read(t,arm);assert.equal(b.ledger.payment_exclusions.count,1);assert.equal(b.ledger.payment_exclusions.total_minor,23000);
 }
});
for(const arm of ['extra-out','extra-in'])test(`ambiguous ${arm} must not discount an unproved bilateral pair`,async t=>{
 const b=await read(t,arm);assert.equal(b.ledger.matched_own_transfers.count,0,'existing mutual-uniqueness guard rejected the pair');
 // Three postings are observed. A posting may leave the disclosure only when
 // a unique bilateral pair is proved; otherwise retain the three-posting
 // amount or withhold the economic count instead of silently asserting one.
 assert.equal(b.ledger.payment_exclusions.count,3,'no unique economic pair authorizes removing an incoming posting');
 assert.equal(b.ledger.payment_exclusions.total_minor,69000);
 assert.match(b.answer,/across 3 postings/);
 assert.match(b.answer,/pairing is uncertain/);
 assert.match(b.answer,/economic payment count and total are unconfirmed/);
});
