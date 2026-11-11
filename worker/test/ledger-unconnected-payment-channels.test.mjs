import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture } from './ledger-review-fixture.mjs';
const channels={card:['credit card payment','card payment','payment to card','payment to credit card','card autopay','cardpay'],loan:['loan payment','loan pmt','loan repayment','loan autopay','mortgage payment','mortgage pmt','mortgage repayment','mortgage autopay','repayment of loan','repayment to loan','repayment of a loan','repayment to a loan','payment to loan','payment to mortgage','autopay to loan','autopay to mortgage','repayment to mortgage','payment to a loan','payment to a mortgage','autopay to a loan','autopay to a mortgage','repayment to a mortgage']};
test('closed channel fields preserve known fees and exclude principal across the complete grammar',async t=>{
 t.mock.method(globalThis,'fetch',()=>assert.fail('network forbidden'));
 let cases=0,fees=0,holds=0,principal=0;
 for(const kind of ['card','loan']){
  const f=ledgerFixture(t);f.env.AI.run=()=>assert.fail('model forbidden');
  f.raw("INSERT INTO fin_accounts(account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at) VALUES ('known','owner',?,'liability','4444','manual','owner_stated','confirmed','2026-10-12')",kind);
  f.raw("INSERT INTO fin_account_coverage(account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at) VALUES ('known','complete','2024-01-01','2026-10-31','2026-10-12','owner_stated','confirmed','2026-10-12')");
  f.add('payment','Service fee','Store Unit',{cents:12345,direction:'outflow'});
  const ask=async()=>{const start=f.calls.length,before=f.first('SELECT total_changes() n').n,b=await f.ask('How much did I spend this month?');assert.ok(f.calls.slice(start).some(s=>/JOIN fin_transactions/.test(s)),'persisted decision reached');assert.equal(f.first('SELECT total_changes() n').n,before);assert.ok(b.ledger);return b;};
  for(const prefix of ['','online ','automatic ','mobile ','internet '])for(const base of channels[kind]){
   const channel=prefix+base,description=channel+' to account 4444';
   for(const payee of [null,channel,description,kind+' payment']){
    f.raw("UPDATE fin_transactions SET description='Service fee',payee='Store Unit',category='BANK_FEES',category_basis_state='confirmed'");
    assert.equal((await ask()).ledger.expense_total_minor,12345,'ordinary confirmed-fee control');
    f.raw('UPDATE fin_transactions SET description=?,payee=?',description,payee);
    const fee=await ask(),b2=kind==='card'&&['payment to card','payment to credit card'].includes(base)&&payee==='card payment';
    assert.equal(fee.ledger.expense_total_minor,b2?null:12345,JSON.stringify({kind,channel,payee,stage:'fee'}));
    if(b2){assert.equal(fee.ledger.reason,'owned_movement_unconfirmed');holds++;}else fees++;
    f.raw('UPDATE fin_transactions SET category=NULL');
    const paid=await ask();assert.ok(paid.ledger.expense_total_minor===0||paid.ledger.expense_total_minor===null,JSON.stringify({kind,channel,payee,stage:'principal',amount:paid.ledger.expense_total_minor}));
    assert.ok(paid.ledger.possible_payments?.length||paid.ledger.payment_exclusions?.count||paid.ledger.possible_own_movement_count,'payment decision is nonempty');
    principal++;cases++;
   }
  }
 }
 assert.equal(cases,560);assert.ok(fees>0&&holds>0&&principal>0,'distinct populated outcomes');
 console.log(JSON.stringify({closed_channel_cases:cases,confirmed_fee_controls:fees,accepted_b2_holds:holds,principal_controls:principal,wrong_figures:0}));
});
