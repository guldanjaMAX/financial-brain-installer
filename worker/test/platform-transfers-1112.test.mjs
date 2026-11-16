import test from 'node:test';
import assert from 'node:assert/strict';
import { book, scalar } from './helpers/platform-transfer-book.mjs';
import { safeCases } from './fixtures/platform-transfer-safe-cases.mjs';
import { platformIdentity, payoutAnnotation, platformTransaction } from '../src/lib/money-platform.js';
import controls from './fixtures/platform-transfer-safe-controls.json' with {type:'json'};

for(const c of safeCases)test('safe design '+c.id,async()=>{
  const b=book({...c,coverage:['2026-01-01','2026-10-31']});
  try {
    const r=await b.ask(`SELECT COALESCE(SUM(${c.measure}),0) n FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31'`);
    assert.equal(r.ok,true,JSON.stringify(r));
    assert.equal(scalar(r),c.expected,c.id);
    assert.ok(Number.isInteger(r.percent),c.id+' has computed confidence');
    if(r.percent<100) {
      assert.ok(r.reasons.length>0,c.id+' explains the score');
      assert.ok(r.missing.length>0,c.id+' names the missing evidence');
    }
    const rows=await b.dump();
    assert.ok(Array.isArray(rows),c.id+' decisions remain readable');
    if(c.control)assert.deepEqual(rows.map(row=>Object.fromEntries(Object.keys(controls[c.id][0]).map(k=>[k,row[k]]))),controls[c.id],c.id+' keeps baseline membership and proof');
    for(const row of rows) {
      assert.ok(Number.isInteger(row.estimated));
      if(row.processor)assert.equal(row.payer_group,'processor:'+row.processor);
      if(row.money_kind==='processor_reserve') {
        assert.equal(row.income_minor,0);assert.equal(row.expense_minor,0);assert.equal(row.estimated,1);
      }
      if(row.money_kind==='refund' && row.direction==='outflow') {
        assert.equal(row.expense_minor,0);assert.equal(row.sales_adjust_minor,-row.amount_minor);
      }
      if(row.estimate_reason?.startsWith('own_transfer_'))assert.equal(row.estimated,1);
    }
    if(c.id==='A6') {
      assert.equal(rows[0].processor,null);assert.equal(rows[0].estimate_reason,'unidentified_deposit_counted');
    }
    if(c.belowHigh) {
      assert.ok(r.percent<90,c.id+' text or unmatched evidence cannot be High');
      assert.ok(r.reasons.length>0,c.id+' explains uncertainty');
    }
  } finally {b.close();}
});

test('one normalized identity covers audit descriptors and does not invent platforms',()=>{
  for(const [description,payee,expected] of [
    ['STRIPE PAYOUT.',null,'stripe'],['Stripe - Payout ST-ABC123',null,'stripe'],['SQUARE  PAYOUT',null,'square'],
    ['ACH CREDIT','Stripe-Inc','stripe'],['ACH CREDIT','S.tripe Inc','stripe'],['ACH CREDIT STRIPE PAYOUT',null,'stripe'],
    ['ORIG CO NAME:STRIPE ORIG ID:1800000000 DESC DATE:251014 CO ENTRY DESCR:TRANSFER SEC:CCD',null,'stripe'],
    ['SQUARE INC SQ251014 T3K9',null,'square'],['ETSY INC PAYOUT 1182',null,'etsy'],
    ['DOORDASH INC DES:REST PAYOUT','DoorDash','doordash'],['PAYPAL RESERVE RELEASE',null,'paypal'],
    ['Customer buys stripe fabric',null,null],['Payout','Unknown platform',null]])
    assert.equal(platformIdentity({description,payee}),expected,description);
});
test('payout annotation grammar keeps real refund and conflicting evidence',()=>{
  const accounts=new Map([['chk',{account_kind:'checking'}],['card',{account_kind:'card'}]]);
  const base={direction:'inflow',effective_account_slug:'chk',payee:'Stripe'};
  assert.equal(payoutAnnotation({...base,description:'PAYOUT NET OF REFUNDS'},accounts)?.description,'payout');
  for(const row of [{description:'STRIPE REFUND'},{description:'STRIPE PAYOUT REVERSAL'},
    {description:'STRIPE PAYOUT LESS REFUNDS',payee:'PayPal'},{description:'STRIPE PAYOUT LESS REFUNDS',category:'REFUND'},
    {description:'STRIPE PAYOUT LESS REFUNDS',effective_account_slug:'card'}])
    assert.equal(payoutAnnotation({...base,...row},accounts),null);
});
test('provider detailed type wins over primary and text never proves a debit type',()=>{
  const accounts=new Map([['chk',{account_kind:'checking'}]]);
  const base={direction:'outflow',effective_account_slug:'chk',description:'STRIPE REFUND',provenance:'feed'};
  assert.equal(platformTransaction(base,accounts).confirmed,false);
  assert.equal(platformTransaction({...base,category_primary:'TRANSFER_OUT',category_detailed:'REFUND'},accounts).confirmed,true);
  for(const description of ['Stripe dispute fee','STRIPE CHARGEBACK PROTECTION','PAYPAL REFUND SERVICES INC'])
    assert.equal(platformTransaction({...base,description},accounts),null);
  assert.equal(platformTransaction({...base,payee:'PayPal'},accounts),null);
});
