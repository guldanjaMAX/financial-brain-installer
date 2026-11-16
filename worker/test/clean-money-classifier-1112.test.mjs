import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture } from './helpers/clean-money-fixture.mjs';
import { queryMoney,MONEY_GUIDE } from '../src/lib/money-query.js';
import { debtPaymentWordingKind,incomeContraryEvidence,moneyMovementReading } from '../src/lib/money-analysis.js';
import { statedLoanSplit } from '../src/lib/clean-money-contributions.js';
import { cases,populate,detailSql,row } from './fixtures/classifier-1112/cases.mjs';
const pins=JSON.parse(readFileSync(new URL('./fixtures/classifier-1112/controls.json',import.meta.url),'utf8'));
const scope="posted_on BETWEEN '2026-10-01' AND '2026-10-31'";
const cents=n=>Math.round(n*100);
const measures={income:'income_minor',expense:'expense_minor',paid:'paid_minor',interest:'interest_stated_minor',refund:'refund_minor',sales:'income_minor+sales_adjust_minor',net:'expense_minor+CASE WHEN expense_minor=0 THEN interest_stated_minor ELSE 0 END-refund_minor',likely:'CASE WHEN estimated=1 AND income_minor>0 THEN income_minor ELSE 0 END',uncertain:'uncertain_minor'};
for(const c of cases)test(`${c.family} ${c.id}${c.control?' preserves the baseline control':''}`,async t=>{
 const f=fixture(t);populate(f,c);
 const r=await queryMoney(f.env,{sql:`SELECT * FROM txn WHERE ${scope} ORDER BY id`,period_from:'2026-10-01',period_to:'2026-10-31'});
 const details=await f.query(detailSql);
 const totals=(await f.query(`SELECT ${Object.entries(measures).map(([key,expr])=>`COALESCE(SUM(${expr}),0) AS ${key}`).join(',')} FROM txn WHERE ${scope}`))[0];
 // Preserve every pinned amount and contribution. These two principal controls
 // deliberately replace certainty with exact typed membership doubt.
 if(c.control)assert.deepEqual(details,pins[c.family+':'+c.id].map(r=>({...r,...c.expect.membership})));
 for(const [key,value] of Object.entries(c.expect)){
  if(key in measures){assert.equal(totals[key],cents(value),key);}
  if(key==='reason' && !c.control){const target=details.at(-1);assert.equal(target.estimate_reason,value);assert.equal(target.estimated,Number(Boolean(value)));}
  if(key==='lastReason')assert.equal(details.at(-1).estimate_reason,value);
  if(key==='lastEstimated')assert.equal(details.at(-1).estimated,value);
 }
 if(!c.control && (c.expect.reason || c.expect.lastReason || c.family==='reversal' || c.expect.interest)){
  assert.ok(r.confidence.percent<90,JSON.stringify(r.confidence));assert.notEqual(r.confidence.level,'High');assert.ok(r.confidence.reasons.length);assert.ok(r.confidence.missing.length);
 }
 if(c.expect.guideIncome!==undefined){
  const sql=MONEY_GUIDE.split('\n').find(line=>line.startsWith('SELECT tenant_id,side,currency,SUM(income_minor) AS income_minor')).replaceAll('2026-09-01','2026-10-01').replaceAll('2026-09-30','2026-10-31');
  const result=await f.query(sql);assert.equal(result[0].income_minor,cents(c.expect.guideIncome));assert.equal(result[0].reversed_income_minor,cents(c.expect.reversed));if(c.id==='G1')assert.equal(result[0].likely_income_minor,80000);
 }
 if(c.id==='T13' && c.family==='income')assert.equal(r.confidence.level,'Low');
 if(c.id==='B12' && c.family==='reversal'){
  const windowed=await queryMoney(f.env,{sql:'SELECT SUM(income_minor) n FROM txn',from:'2026-10-01',to:'2026-10-31'});assert.equal(windowed.rows[0].n,330000);
 }
});
test('new debt and split grammar rejects misleading roles and malformed amounts',()=>{
 for(const memo of ['mortgage escrow payment','mortgage interest payment','debit card purchase payment','loanstar supply payment','merchant services credit card payment processing'])assert.equal(debtPaymentWordingKind(memo),null,memo);
 for(const memo of ['LOAN PMT P 939.85 I 310.15','LOAN PAYMENT PRINCIPAL 700.00 INTEREST 300.00 ESCROW 250.00','LOAN PAYMENT PRINCIPAL -939.85 INTEREST 310.15','LOAN PAYMENT PRINCIPAL 939,85 INTEREST 310,15','LOAN PAYMENT PRINCIPAL 939.850 INTEREST 310.15','LOAN PAYMENT PRINCIPAL (939.85) INTEREST 310.15'])assert.equal(statedLoanSplit(memo),null,memo);
 assert.deepEqual(statedLoanSplit('MORTGAGE PAYMENT - PRINCIPAL $1,000.00 INTEREST $250.00'),{principal:'1000.00',interest:'250.00'});
});
test('provider borrowing categories outrank payer identity; proposed codes only nominate',async t=>{
 const f=fixture(t);f.account('bank');f.row('loan','bank',500000,{memo:'ACH CREDIT',payee:'Funder',category:'TRANSFER_IN_CASH_ADVANCES_AND_LOANS'});
 f.run("UPDATE fin_transactions SET provenance='feed',source_feed='synthetic-feed',category_basis_state='proposed' WHERE txn_uid='loan'");
 const r=(await f.query('SELECT * FROM txn'))[0];assert.equal(r.income_minor,0);assert.equal(r.money_kind,'loan_proceeds');
 for(const field of ['category_primary','category_detailed'])assert.equal(incomeContraryEvidence({direction:'inflow',[field]:'LOAN_DISBURSEMENTS'},{}),'possible_loan_proceeds_counted');
});
test('reversals consume an original once and require account, currency, direction and a return type',async t=>{
 const f=fixture(t);f.account('bank');f.account('other',{mask:'2222'});
 f.row('customer','bank',80000,{memo:'CUSTOMER REVENUE',day:'2026-10-02'});
 f.row('vendor','bank',80000,{memo:'VENDOR PURCHASE',direction:'outflow',day:'2026-10-03'});
 f.row('wrong-account','other',80000,{memo:'RETURNED CHECK',direction:'outflow',day:'2026-10-04'});
 f.row('returned','bank',80000,{memo:'RETURNED CHECK',direction:'outflow',day:'2026-10-05'});
 f.row('repeat','bank',80000,{memo:'RETURNED CHECK',direction:'outflow',day:'2026-10-06'});
 const rs=await f.query('SELECT * FROM txn ORDER BY id');assert.equal(rs[1].expense_minor,80000);assert.equal(rs[2].expense_minor,80000);assert.equal(rs[3].income_minor,-80000);assert.equal(rs[4].expense_minor,80000);
});
test('income and debt additions do not change the legacy movement reader',()=>{
 const accounts=new Map([['bank',{account_kind:'checking'}]]);
 const r={direction:'inflow',description:'SBA LOAN FUNDING',payee:'Lender',effective_account_slug:'bank'};
 assert.deepEqual(moneyMovementReading(r,accounts),{classification:'unknown',money_kind:'ordinary',estimated:true,paymentKind:null,uncertain_kind:null,estimate_reason:'unresolved_membership'});
});
test('guide includes signed income and concrete disclosure of likely debt and income',()=>{
 for(const text of ['reversed_income_minor','possibly_not_income_minor','possible_vendor_credit_counted','possible_loan_payment_wording_counted','SUM(uncertain_minor)','paid_minor-interest_stated_minor'])assert.ok(MONEY_GUIDE.includes(text),text);
 assert.match(MONEY_GUIDE,/Answer-contract queries: SELECT currency, direction, SUM\(income_minor\)/);
});
test('equal vendor credit is contrary evidence without requiring a net vendor balance',async t=>{
 const f=fixture(t);f.account('bank');f.row('buy','bank',12000,{direction:'outflow',payee:'Vendor',memo:'SUPPLY ORDER',day:'2026-10-05'});f.row('credit','bank',12000,{payee:'Vendor',memo:'SUPPLY ORDER',day:'2026-10-09'});f.row('sale','bank',100000,{payee:'Customer',memo:'ACH DEPOSIT',day:'2026-10-15'});
 const rows=await f.query('SELECT * FROM txn ORDER BY id');assert.equal(rows[1].income_minor,12000);assert.equal(rows[1].estimate_reason,'possible_vendor_credit_counted');assert.equal(rows[1].estimated,1);
});
test('issuer descriptor on a returned item nets the original payment, never income',async t=>{
 const f=fixture(t);f.account('bank');f.account('card',{kind:'card',mask:'3333'});
 f.row('out','bank',200000,{direction:'outflow',memo:'ISSUER CREDIT CRD AUTOPAY',day:'2026-10-15'});
 f.row('paid','card',200000,{memo:'PAYMENT THANK YOU',day:'2026-10-16'});
 f.row('bounce','card',200000,{direction:'outflow',memo:'RETURNED PAYMENT',day:'2026-10-19'});
 f.row('back','bank',200000,{memo:'RETURNED ITEM ISSUER CREDIT CRD AUTOPAY',day:'2026-10-19'});
 const r=await f.query('SELECT SUM(income_minor) income,SUM(expense_minor-refund_minor) net,SUM(paid_minor) paid FROM txn');assert.deepEqual(r[0],{income:0,net:0,paid:0});
});
test('different return types cannot consume one customer payment twice',async t=>{
 const f=fixture(t);f.account('bank');f.row('sale','bank',80000,{memo:'CUSTOMER PAYMENT',day:'2026-10-02'});f.row('first','bank',80000,{direction:'outflow',memo:'RETURNED CHECK',day:'2026-10-03'});f.row('second','bank',80000,{direction:'outflow',memo:'RETURNED PAYMENT',day:'2026-10-04'});
 const r=await f.query('SELECT SUM(income_minor) income FROM txn');assert.equal(r[0].income,0);
});
test('feed payment categories nominate debt even with no payment memo',async t=>{
 const f=fixture(t);f.account('bank');f.row('loan','bank',100000,{direction:'outflow',memo:'ACH DEBIT',category:'LOAN_PAYMENTS_MORTGAGE_PAYMENT'});f.run("UPDATE fin_transactions SET provenance='feed',source_feed='synthetic-feed',category_basis_state='proposed'");
 const r=(await f.query('SELECT * FROM txn'))[0];assert.equal(r.expense_minor,100000);assert.equal(r.estimated,1);assert.equal(r.uncertain_kind,'loan_payment');assert.equal(r.uncertain_minor,100000);
});
for(const memo of ['PAYMENT NSF','UNPAID PAYMENT','INSUFFICIENT FUNDS PAYMENT','RETURNED ACH PAYMENT DUE TO INSUFFICIENT FUNDS'])test('closed failure wording: '+memo,async t=>{
 const f=fixture(t);f.account('card',{kind:'card',mask:'3333'});f.coverage('card','2026-10-01','2026-10-31');f.row('original','card',50000,{memo:'PAYMENT THANK YOU',day:'2026-10-02'});f.row('failed','card',50000,{direction:'outflow',memo,day:'2026-10-05'});
 const r=await queryMoney(f.env,{sql:`SELECT SUM(expense_minor) expense,SUM(paid_minor) paid FROM txn WHERE ${scope}`,period_from:'2026-10-01',period_to:'2026-10-31'});assert.equal(r.rows[0].expense,0);assert.equal(r.rows[0].paid,0);assert.ok(r.confidence.percent<90);
});
test('owner contribution abbreviation cannot certify income from the payer name',async t=>{
 const f=fixture(t);f.account('bank');f.row('owner','bank',500000,{payee:'Owner Person',memo:'ACH CREDIT OWNER CONTRIB'});const r=(await f.query('SELECT * FROM txn'))[0];assert.equal(r.income_minor,500000);assert.equal(r.estimated,1);assert.equal(r.estimate_reason,'possible_owner_money_counted');
});
test('reversal before a directed card payment names no purchase refund',async t=>{
 const f=fixture(t);f.account('bank');f.account('card',{kind:'card',mask:'3333'});
 f.row('out','bank',50000,{direction:'outflow',memo:'PAYMENT TO CARD 3333',day:'2026-10-05'});f.row('paid','card',50000,{memo:'PAYMENT THANK YOU',day:'2026-10-05'});f.row('back','bank',50000,{memo:'REVERSAL PAYMENT TO CARD 3333',day:'2026-10-08'});f.row('bounce','card',50000,{direction:'outflow',memo:'PAYMENT REVERSAL',day:'2026-10-08'});
 const r=await f.query('SELECT SUM(refund_minor) refunds,SUM(paid_minor) paid,SUM(income_minor) income FROM txn');assert.deepEqual(r[0],{refunds:0,paid:0,income:0});
});
test('a proved own transfer and its return produce neither spending nor refunds',async t=>{
 const f=fixture(t);f.account('bank');f.account('saving',{kind:'savings',mask:'2222'});
 f.row('out','bank',100000,{direction:'outflow',memo:'TRANSFER TO ACCOUNT 2222',day:'2026-10-05'});f.row('in','saving',100000,{memo:'TRANSFER FROM ACCOUNT 1111',day:'2026-10-05'});f.row('return-out','saving',100000,{direction:'outflow',memo:'TRANSFER REVERSAL',day:'2026-10-06'});f.row('return-in','bank',100000,{memo:'TRANSFER REVERSAL',day:'2026-10-06'});
 const r=await f.query('SELECT SUM(income_minor) income,SUM(expense_minor) expense,SUM(refund_minor) refunds FROM txn');assert.deepEqual(r[0],{income:0,expense:0,refunds:0});
});
test('partial snapshot records without a posting date or amount still classify instead of crashing',async()=>{
 const {moneyMembershipDecisions,classifiedMoneyCtes}=await import('../src/lib/clean-money.js');
 const rows=[{id:1,tenant_id:'primary',direction:'outflow',description:'RETURNED CHECK',payee:'Vendor'},{id:2,tenant_id:'primary',direction:'inflow',description:'ACH CREDIT',payee:'Vendor'},{id:3,tenant_id:'primary',description:'x'}];
 const decisions=moneyMembershipDecisions({rows,accounts:[],pairs:[],coverage:[]});
 assert.deepEqual(decisions.map(d=>d.id),[1,2,3]);
 const binds=[];assert.equal(typeof classifiedMoneyCtes({rows,accounts:[],pairs:[],coverage:[]},binds),'string');assert.ok(binds.length);
});
