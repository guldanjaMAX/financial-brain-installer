import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/clean-money-fixture.mjs';
import { queryMoney } from '../src/lib/money-query.js';
const period={period_from:'2026-10-01',period_to:'2026-10-31'};
const now=()=>Date.parse('2026-11-01T12:00:00Z');
function book(t){const f=fixture(t);f.env.BRAIN_TIMEZONE='UTC';f.account('operating',{mode:'manual'});f.coverage('operating',period.period_from,period.period_to);return f;}
async function amount(f,field='income_minor'){return queryMoney(f.env,{sql:`SELECT SUM(${field}) AS cents FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31'`,...period},{now});}
test('ordinary customer receipts and merchant purchases need no extra type proof',async t=>{
 const f=book(t);f.row('receipt','operating',400000,{payee:'Customer',memo:'Customer payment'});f.row('purchase','operating',15000,{direction:'outflow',payee:'Supply vendor',memo:'Purchase'});f.row('fee','operating',500,{direction:'outflow',memo:'Bank fee'});
 for(const [field,cents] of [['income_minor',400000],['expense_minor',15500]]){const r=await amount(f,field);assert.equal(r.rows[0].cents,cents);assert.ok(r.confidence.percent>=90, r.confidence_text);}
});
for(const memo of ['Vendor proration credit','Dues credit','Vendor account credit'])test(`a material vendor credit retains its figure with return doubt: ${memo}`,async t=>{
 const f=book(t);f.row('ordinary','operating',500000,{payee:'Customer',memo:'ACH credit invoice payment'});
 const green=await amount(f);assert.equal(green.rows[0].cents,500000);assert.ok(green.confidence.percent>=90,green.confidence_text);
 f.row('credit','operating',50000,{payee:'Service vendor',memo});const bad=await amount(f);
 assert.equal(bad.rows[0].cents,550000);assert.ok(bad.confidence.percent<90,bad.confidence_text);assert.match(bad.confidence_text,/return|membership|type/i);
});
test('an institution counterparty flags possible financing rather than certifying ordinary income',async t=>{
 const f=book(t);f.row('ordinary','operating',500000,{payee:'Customer'});const green=await amount(f);assert.ok(green.confidence.percent>=90);
 f.row('bank-credit','operating',200000,{memo:'ACH credit Regional Bank',payee:'Regional Bank'});const bad=await amount(f);assert.equal(bad.rows[0].cents,700000);assert.ok(bad.confidence.percent<90,bad.confidence_text);assert.match(bad.confidence_text,/financial|type/i);
});
test('personal benefits on a business account qualify entity attribution without removing the receipt',async t=>{
 const f=book(t);f.row('ordinary','operating',500000,{payee:'Customer'});
 const body={sql:`SELECT SUM(income_minor) AS cents FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31' AND side='business'`,...period};
 const green=await queryMoney(f.env,body,{now});assert.equal(green.rows[0].cents,500000);assert.ok(green.confidence.percent>=90);
 f.row('benefit','operating',300000,{memo:'Pension payment',category:'INCOME_RETIREMENT_PENSION'});const bad=await queryMoney(f.env,body,{now});assert.equal(bad.rows[0].cents,800000);assert.ok(bad.confidence.percent<90,bad.confidence_text);assert.match(bad.confidence_text,/allocation|personal/i);
});
test('personal spending by account side discloses owner purchases booked on another side',async t=>{
 const f=book(t);f.account('household',{mode:'manual',entity:'household',mask:'3333'});f.coverage('household',period.period_from,period.period_to);f.row('purchase','household',50000,{direction:'outflow',payee:'Shop'});
 const body={sql:`SELECT side,SUM(expense_minor) AS cents FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31' GROUP BY side`,...period};
 const green=await queryMoney(f.env,body,{now});assert.equal(green.rows.find(r=>r.side==='personal').cents,50000);assert.ok(green.confidence.percent>=90);
 f.row('draw-purchase','operating',25000,{direction:'outflow',payee:'Grocery vendor',category:'Owner Draw'});const bad=await queryMoney(f.env,body,{now});assert.equal(bad.rows.find(r=>r.side==='personal').cents,50000);assert.ok(bad.confidence.percent<90,bad.confidence_text);assert.match(bad.confidence_text,/allocation|personal/i);
});
for(const memo of ['Processor capital advance','Payout reversed','Refundable pet bond','Beneficiary remittance','Agency distribution to owner','Third-party rent remittance','Dishonored deposited check','Owner funding','Wallet top up','Loan principal disbursement'])test(`risky wording retains amount below High: ${memo}`,async t=>{
 const f=book(t);f.row('risk','operating',120000,{memo,payee:'Stripe'});const r=await amount(f);assert.equal(r.rows.length,1);assert.equal(r.rows[0].cents,memo==='Payout reversed'?0:120000);assert.ok(r.confidence.percent<90,r.confidence_text);assert.ok(r.confidence.missing.length);
});
for(const minor of [5000,9999,10000,20000])test(`materiality ${minor} cannot supply a missing party type certificate`,async t=>{
 const f=book(t);f.row('ordinary','operating',1000000,{payee:'Customer',category:'Income'});
 const green=await amount(f);assert.equal(green.rows[0].cents,1000000);assert.ok(green.confidence.percent>=90,green.confidence_text);
 f.row('risk','operating',minor,{memo:'Refundable pet bond',payee:'Payer'});const r=await amount(f);assert.equal(r.rows[0].cents,1000000+minor);assert.ok(r.confidence.percent<90,r.confidence_text);assert.match(r.confidence_text,/bond|principal|type|membership/i);
 assert.match(r.confidence_text,new RegExp((minor/100).toFixed(2).replace('.','\\.')));
});
test('same account imports shifted three days retain dollars with duplicate doubt',async t=>{
 const f=book(t);for(const [uid,day,memo] of [['first','2026-10-10','Settlement'],['copy','2026-10-13','Payout import']])f.row(uid,'operating',45000,{day,memo,payee:'Stripe',category:'Sales'});const r=await amount(f);assert.equal(r.rows[0].cents,90000);assert.ok(r.confidence.percent<90,r.confidence_text);assert.match(r.confidence_text,/duplicat|repeat/i);
});
test('netted payout fees stay below High despite a separate bank fee',async t=>{
 const f=book(t);f.row('payout','operating',97000,{payee:'Etsy',memo:'Etsy payout'});f.row('bank-fee','operating',500,{direction:'outflow',memo:'Bank fee',category:'Bank fees'});const r=await amount(f,'expense_minor');assert.equal(r.rows[0].cents,500);assert.ok(r.confidence.percent<90,r.confidence_text);
});
test('marketplace settlement structure flags missing gross components without a named platform',async t=>{
 const f=book(t);f.row('payout','operating',720000,{payee:'Marketplace operator',memo:'MKTPL PMT settlement'});
 const r=await amount(f);assert.equal(r.rows[0].cents,720000);assert.ok(r.confidence.percent<90,r.confidence_text);assert.match(r.confidence_text,/settlement|withheld/i);
});
test('unrelated account gap does not lower a scoped ordinary receipt',async t=>{
 const f=book(t);f.account('unrelated',{mode:'manual',mask:'2222'});f.row('receipt','operating',400000,{payee:'Customer'});const r=await queryMoney(f.env,{sql:`SELECT SUM(income_minor) AS cents FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31' AND account_slug='operating'`,...period},{now});assert.equal(r.rows[0].cents,400000);assert.ok(r.confidence.percent>=90,r.confidence_text);
});
test('a contradictory processor role cannot override a refundable principal flag in either direction',async t=>{
 const f=book(t);f.row('income','operating',300000,{category:'Income',payee:'Customer'});f.row('bond','operating',200000,{direction:'outflow',memo:'Refundable tenant pet bond',payee:'Vendor',category:'Office supplies'});
 const r=await amount(f,'expense_minor');assert.equal(r.rows[0].cents,200000);assert.ok(r.confidence.percent<90,r.confidence_text);assert.match(r.confidence_text,/bond|principal/i);
});
test('a tiny risky subtotal does not become immaterial by scaling SQL output',async t=>{
 const f=book(t);f.row('risk','operating',5000,{memo:'Refundable pet bond',payee:'Payer'});const r=await queryMoney(f.env,{sql:`SELECT SUM(income_minor)*1000000 AS cents FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31'`,...period},{now});assert.equal(r.rows[0].cents,5000000000);assert.ok(r.confidence.percent<90);
});
test('the old period_end hint cannot hide a feed stopped inside the SQL period',async t=>{
 const {overviewFixture}=await import('./helpers/money-overview-fixture.mjs');const f=overviewFixture(t);
 f.account('operating','live');f.connection('operating');f.coverage('operating','2026-10-01','2026-10-31');f.row('receipt','operating','2026-10-10',400000,'inflow',{description:'Customer payment'});
 f.run("UPDATE fin_transactions SET payee='Customer' WHERE txn_uid='receipt'");
 f.run('UPDATE bank_feed_items SET last_synced_at=?','2026-11-01T12:00:00Z');
 const body={sql:`SELECT SUM(income_minor) AS cents FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31'`,...period,period_end:'2026-10-10'};
 const q=()=>queryMoney(f.env,body,{now:()=>Date.parse('2026-11-02T12:00:00Z')});
 const green=await q();assert.equal(green.rows[0].cents,400000);assert.ok(green.confidence.percent>=90,green.confidence_text);
 const late=await queryMoney(f.env,{...body,period_end:'2026-11-30'},{now:()=>Date.parse('2026-11-02T12:00:00Z')});
 assert.equal(late.rows[0].cents,400000);assert.ok(late.confidence.percent>=90,'a later hint cannot extend the asked period: '+late.confidence_text);
 f.run("UPDATE bank_feed_health SET data_through='2026-10-15'");const bad=await q();assert.equal(bad.rows[0].cents,400000);assert.ok(f.calls.some(s=>s.includes('bank_feed_health')),'health decision reached');assert.ok(bad.confidence.percent<90,bad.confidence_text);assert.match(bad.confidence_text,/2026-10-15/);
});
test('both materiality limits are strict at exactly two percent',async t=>{
 const f=book(t);f.row('ordinary','operating',245000,{payee:'Customer',category:'Income'});f.row('risk','operating',5000,{memo:'Refundable pet bond',payee:'Payer'});const r=await amount(f);assert.equal(r.rows[0].cents,250000);assert.ok(r.confidence.percent<90,r.confidence_text);
});

test('an unknown owner zone qualifies a recent period boundary, with a configured-zone High control',async t=>{
 const f=book(t);f.row('receipt','operating',400000,{payee:'Customer'});const green=await amount(f);assert.equal(green.rows[0].cents,400000);assert.ok(green.confidence.percent>=90);
 delete f.env.BRAIN_TIMEZONE;const bad=await amount(f);assert.equal(bad.rows[0].cents,400000);assert.ok(bad.confidence.percent<90,bad.confidence_text);assert.match(bad.confidence_text,/time zone/);
 const old=await queryMoney(f.env,{sql:`SELECT SUM(income_minor) AS cents FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31'`,...period},{now:()=>Date.parse('2026-11-03T12:00:00Z')});assert.equal(old.rows[0].cents,400000);assert.ok(old.confidence.percent>=90,old.confidence_text);
});
