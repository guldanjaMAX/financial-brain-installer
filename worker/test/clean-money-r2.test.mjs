import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/clean-money-fixture.mjs';
import { queryMoney, MONEY_GUIDE } from '../src/lib/money-query.js';

const october = "posted_on BETWEEN '2026-10-01' AND '2026-10-31'";
const guideSql = MONEY_GUIDE.match(/SELECT currency, direction,[\s\S]*?GROUP BY currency, direction;/)[0];
const sale = f => { f.account('bank'); f.row('sale','bank',10000,{category:'INCOME'}); f.coverage('bank','2026-10-01','2026-10-31'); };

test('N1 SQL dates survive a conflicting requested window, including opaque CASE SQL', async t => {
  const f=fixture(t); f.account('bank');f.coverage('bank','2026-01-01','2026-12-31');
  f.row('september','bank',10000,{day:'2026-09-10',category:'INCOME'});
  f.row('october','bank',20000,{day:'2026-10-10',category:'INCOME'});
  for(const expr of ['SUM(income_minor)','SUM(CASE WHEN direction=\'inflow\' THEN income_minor ELSE 0 END)']){
    const r=await queryMoney(f.env,{sql:`SELECT ${expr} n FROM txn WHERE posted_on BETWEEN '2026-09-01' AND '2026-09-30'`,from:'2026-10-01',to:'2026-10-31'});
    assert.equal(r.rows[0].n,10000);assert.equal(r.window.from,'2026-09-01');assert.equal(r.window.to,'2026-10-31');
    assert.ok(r.confidence.caveats.some(c=>c.code==='request_window_differs'));
  }
});
test('N2 linked slug selection discloses the exact dollars kept under its identity',async t=>{
  const f=fixture(t);f.account('bank',{mode:'manual'});f.account('bank-live');f.link('bank','bank-live');
  f.coverage('bank','2026-10-01','2026-10-31');
  f.row('import','bank',10000,{category:'INCOME'});
  f.row('live-first','bank-live',100,{day:'2026-10-01',category:'INCOME'});
  f.row('live-last','bank-live',10000,{day:'2026-10-31',category:'INCOME'});
  const r=await queryMoney(f.env,{sql:`SELECT SUM(income_minor) n FROM txn WHERE account_slug='bank' AND ${october}`});
  assert.ok(r.confidence.score<=75);
  const gap=r.confidence.gaps.find(g=>g.code==='linked_record_rows');assert.equal(gap.amounts[0].inflow_minor,10100);
  for(const filter of ["account='1111'",`account_identity='["primary","account","bank-live"]'`]){
    const all=await queryMoney(f.env,{sql:`SELECT SUM(income_minor) n FROM txn WHERE ${filter} AND ${october}`});
    assert.equal(all.rows[0].n,10100);assert.ok(!all.confidence.gaps.some(g=>g.code==='linked_record_rows'));
  }
});
test('N3 canonical answer contract scores only its WHERE dates and names missing dates',async t=>{
  const f=fixture(t);sale(f);f.row('old-guess','bank',500000,{day:'2025-01-02',memo:'DEPOSIT'});
  const r=await queryMoney(f.env,{sql:guideSql});assert.equal(r.rows[0].income_minor,10000);
  assert.equal(r.confidence.selection_score,100);assert.ok(r.confidence.score<90,'unproved connections and sync cannot earn High');assert.equal(r.confidence.basis,'selected_account_dates');
  f.run("UPDATE fin_account_coverage SET covered_from='2026-01-01',covered_to='2026-06-30'");
  const missing=await queryMoney(f.env,{sql:guideSql});assert.ok(missing.confidence.score<90);
  const g=missing.confidence.gaps.find(g=>g.code==='incomplete_coverage');assert.equal(g.from,'2026-10-01');assert.equal(g.to,'2026-10-31');
});
test('N3 request-only window excludes margin estimates from both totals and confidence',async t=>{
  const f=fixture(t);sale(f);f.row('margin','bank',500000,{day:'2026-09-28',memo:'DEPOSIT'});
  const r=await queryMoney(f.env,{sql:'SELECT SUM(income_minor) n FROM txn',from:'2026-10-01',to:'2026-10-31'});
  assert.equal(r.rows[0].n,10000);assert.equal(r.confidence.selection_score,100);assert.ok(r.confidence.score<90,'unproved connections and sync cannot earn High');assert.equal(r.confidence.basis,'requested_window');
});
test('N3 OR and NOT predicates cannot claim literal selection coverage',async t=>{
  const f=fixture(t);sale(f);
  for(const sql of [`SELECT CASE WHEN income_minor>0 THEN 1 END FROM txn WHERE ${october} OR 1=1`,
    `SELECT SUM(income_minor) FROM txn WHERE NOT ${october}`]){
    const r=await queryMoney(f.env,{sql});assert.equal(r.confidence.basis,'whole_available_snapshot');assert.ok(r.confidence.score<100);
  }
});
test('N1 opaque CASE dates cannot borrow confidence from a different request window',async t=>{
  const f=fixture(t);sale(f);f.row('september','bank',12300,{day:'2026-09-15',category:'INCOME'});
  const r=await queryMoney(f.env,{sql:"SELECT SUM(CASE WHEN posted_on BETWEEN '2026-09-01' AND '2026-09-30' THEN income_minor ELSE 0 END) n FROM txn",from:'2026-10-01',to:'2026-10-31'});
  assert.equal(r.rows[0].n,12300);assert.ok(r.confidence.score<100);assert.ok(r.confidence.caveats.some(c=>c.code==='request_window_differs'));
  const g=r.confidence.gaps.find(g=>g.code==='incomplete_coverage');assert.equal(g.from,'2026-09-01');
});
test('N4 charge-card payments and generic CHARGE are counted with a flag, actual fees stay certain',async t=>{
  const f=fixture(t);f.account('bank');f.account('card',{kind:'card',mask:'3333'});f.account('saving',{kind:'savings',mask:'2222'});
  f.row('pay','bank',200000,{direction:'outflow',memo:'ONLINE PAYMENT TO CHARGE CARD 3333'});
  f.row('ack','card',200000,{day:'2026-10-03',memo:'PAYMENT THANK YOU'});
  f.row('autopay','bank',400000,{direction:'outflow',memo:'AUTOPAY CHARGE CARD PMT'});
  f.row('transfer','bank',50000,{direction:'outflow',memo:'TRANSFER TO ACCOUNT 2222 CHARGE'});
  f.row('receipt','saving',50000,{memo:'TRANSFER FROM ACCOUNT 1111'});
  for(const memo of ['MONTHLY SERVICE CHARGE','CHARGEBACK FEE'])f.row(memo,'bank',1500,{direction:'outflow',memo});
  const rows=await f.query('SELECT * FROM txn');
  for(const uid of ['pay','autopay','transfer']){const r=rows.find(r=>r.txn_uid===uid);assert.equal(r.estimated,1);assert.match(r.estimate_reason,/_counted$/);assert.equal(r.expense_minor,r.amount_minor);}
  for(const uid of ['MONTHLY SERVICE CHARGE','CHARGEBACK FEE']){const r=rows.find(r=>r.txn_uid===uid);assert.equal(r.expense_minor,1500);assert.equal(r.estimated,0);}
});
test('N5 native bind ceiling returns a disclosed partial answer with omitted dollars and dates',async t=>{
  const f=fixture(t);f.account('bank');f.coverage('bank','2026-10-01','2026-10-31');
  f.db.exec('BEGIN');for(let i=0;i<5000;i++)f.row('large-'+i,'bank',100,{direction:'outflow',memo:'PURCHASE '+ 'a'.repeat(400)});f.db.exec('COMMIT');
  let peak=0;
  const r=await queryMoney(f.env,{sql:`SELECT SUM(expense_minor) n FROM txn WHERE ${october}`},{maxBinds:3,execute:async(sql,{binds})=>{
    peak=Math.max(peak,binds.length);assert.ok(binds.length<=3,'D1 bind count');return {success:true,results:f.db.prepare(sql).all(...binds)};
  }});
  assert.ok(peak<=3);assert.equal(r.complete,false);assert.ok(r.rows[0].n>0 && r.rows[0].n<500000);
  const g=r.confidence.gaps.find(g=>g.code==='input_incomplete');assert.equal(g.amounts[0].outflow_minor,500000-r.rows[0].n);assert.equal(g.from,'2026-10-02');assert.ok(g.missing_rows>0);
});
test('m-a partial snapshot names exact omitted directional amounts and dates',async t=>{
  const f=fixture(t);f.account('bank');for(let i=0;i<4;i++)f.row('purchase-'+i,'bank',100,{direction:'outflow',category:'PURCHASE'});
  const r=await queryMoney(f.env,{sql:'SELECT SUM(expense_minor) n FROM txn'},{maxScanRows:2,maxSnapshotRows:3});
  assert.equal(r.rows[0].n,300);const g=r.confidence.gaps.find(g=>g.code==='input_incomplete');
  assert.equal(g.missing_rows,1);assert.equal(g.amounts[0].outflow_minor,100);assert.equal(g.from,'2026-10-02');assert.equal(g.to,'2026-10-02');
});
test('m-b invalid calendar windows have a precise safe error',async t=>{
  const f=fixture(t);sale(f);
  for(const dates of [{from:'2026-10-01'},{from:'2026-02-30',to:'2026-03-01'},{from:null,to:null},{from:'2026-11-01',to:'2026-10-01'}])
    await assert.rejects(queryMoney(f.env,{sql:'SELECT 1 FROM txn',...dates}),e=>dates.to===undefined ? e.code==='MONEY_QUERY_INVALID' && e.reason==='window_incomplete' && /Pass both from and through/.test(e.message) : e.code==='MONEY_QUERY_WINDOW' && /from and to must both be YYYY-MM-DD/.test(e.message));
});
test('m-d accounts with no lifecycle overlap do not invent a missing period',async t=>{
  const f=fixture(t);sale(f);f.account('new',{mask:'2222'});f.coverage('new','2026-11-01','2026-11-30');
  f.run("UPDATE fin_accounts SET opened_on='2026-11-01' WHERE account_slug='new'");
  const r=await queryMoney(f.env,{sql:`SELECT SUM(income_minor) n FROM txn WHERE ${october}`});assert.equal(r.confidence.selection_score,100);assert.ok(r.confidence.score<90,'unproved connections and sync cannot earn High');
});
test('m-e currency scale cannot conceal a completely uncertain other currency',async t=>{
  const f=fixture(t);sale(f);f.account('eur',{mask:'2222',currency:'EUR'});f.coverage('eur','2026-10-01','2026-10-31');
  f.row('euro-guess','eur',100,{currency:'EUR',memo:'DEPOSIT'});
  const r=await queryMoney(f.env,{sql:`SELECT currency,SUM(income_minor) n FROM txn WHERE ${october} GROUP BY currency`});
  assert.equal(r.confidence.selection_score,65);assert.equal(r.confidence.score,15);assert.equal(r.confidence.label,'Low');const g=r.confidence.gaps.find(g=>g.code==='estimated_membership');assert.equal(g.amounts[0].currency,'EUR');
});
test('m-f pending holds just before a requested period disclose their separate dollars',async t=>{
  const f=fixture(t);sale(f);f.row('hold','bank',50000,{day:'2026-09-30',pending:1});
  const r=await queryMoney(f.env,{sql:`SELECT SUM(income_minor) n FROM txn WHERE ${october}`},{now:()=>Date.parse('2026-10-03T12:00:00Z')});
  assert.equal(r.rows[0].n,10000);assert.equal(r.confidence.caveats.find(g=>g.code==='pending_outside_period').amounts[0].inflow_minor,50000);
  assert.equal(r.confidence.caveats.find(g=>g.code==='pending_outside_period').affects_confidence,false);
  assert.ok(!r.confidence.selection_gaps.some(g=>g.code==='pending'));
});
test('signed contributions reconcile payments, reversals and memo-stated components',async t=>{
  const f=fixture(t);f.account('bank');f.account('card',{kind:'card',mask:'3333'});
  f.row('paid','bank',50000,{direction:'outflow',memo:'Payment to card 3333'});
  f.row('received','card',50000,{day:'2026-10-03',memo:'PAYMENT THANK YOU'});
  f.row('split','bank',125000,{direction:'outflow',memo:'LOAN PAYMENT PRINCIPAL 939.85 INTEREST 310.15'});
  f.row('bad-split','bank',125000,{direction:'outflow',memo:'LOAN PAYMENT PRINCIPAL 939.84 INTEREST 310.15'});
  const rows=await f.query('SELECT * FROM txn ORDER BY id');
  assert.equal(rows.reduce((n,r)=>n+r.paid_minor,0),175000);
  assert.equal(rows.find(r=>r.txn_uid==='split').interest_stated_minor,31015);
  const split=rows.find(r=>r.txn_uid==='split');assert.equal(split.expense_minor,125000);assert.equal(split.money_kind,'ordinary');assert.equal(split.estimated,1);assert.equal(split.estimate_reason,'memo_split_needs_statement_counted');
  const spending=await f.query('SELECT SUM(expense_minor + CASE WHEN expense_minor=0 THEN interest_stated_minor ELSE 0 END) n FROM txn');assert.equal(spending[0].n,250000,'memo interest is already inside the counted full debit');
  assert.equal(rows.find(r=>r.txn_uid==='bad-split').interest_stated_minor,0);
  assert.equal(rows.find(r=>r.txn_uid==='bad-split').expense_minor,125000);
});
test('a liability ACH reversal cannot reverse deposit-account income',async t=>{
  const f=fixture(t);f.account('card',{kind:'card'});f.row('reversal','card',50000,{direction:'outflow',memo:'ACH REVERSAL CUSTOMER CO'});
  const row=(await f.query('SELECT * FROM txn'))[0];assert.equal(row.income_minor,0);assert.equal(row.expense_minor,50000);
});
test('a coded payout reversal with a generic memo reduces sales exactly once',async t=>{
  const f=fixture(t);f.account('bank');f.row('payout','bank',150000,{memo:'STRIPE PAYOUT',payee:'Stripe'});
  f.row('reversal','bank',22000,{direction:'outflow',memo:'ACH DEBIT',category:'PAYOUT_REVERSAL'});
  const r=await f.query('SELECT SUM(income_minor) income,SUM(income_minor+sales_adjust_minor) sales FROM txn');
  assert.equal(r[0].income,128000);assert.equal(r[0].sales,128000);
});
