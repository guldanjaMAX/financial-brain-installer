import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/clean-money-fixture.mjs';
import { moneyGuideFor } from '../src/lib/money-query-contract.js';
import { queryMoney } from '../src/lib/money-query.js';
const october="posted_on BETWEEN '2026-10-01' AND '2026-10-31'";
for(const [sentinel,predicate] of [['9999-12-31',">='2026-10-01'"],['0000-01-01',"<='2026-10-31'"]])test('MAJOR-1 sentinel '+sentinel+' preserves the requested postings and confidence',async t=>{
 const f=fixture(t);f.account('bank');f.coverage('bank','2026-10-01','2026-10-31');f.row('sale','bank',10000,{category:'INCOME'});
 const field=sentinel.startsWith('9999')?'closed_on':'opened_on';
 const r=await queryMoney(f.env,{sql:`SELECT SUM(t.income_minor) n FROM txn t JOIN coverage c ON c.account_slug=t.account_slug WHERE t.posted_on BETWEEN '2026-10-01' AND '2026-10-31' AND COALESCE(c.${field},'${sentinel}')${predicate}`,from:'2026-10-01',to:'2026-10-31'});
 assert.equal(r.rows[0].n,10000);assert.equal(r.confidence.selection_score,100);
 assert.equal(r.confidence.score,40,'a join cannot prove the connection scope');
 assert.ok(r.confidence.reasons.length && r.confidence.missing.length,'a join cannot certify connections or sync evidence');
 assert.ok(!r.confidence.gaps.some(g=>g.code==='no_posted_history' || g.to>'2026-10-31'));
});
for(const memo of ['ONLINE PAYMENT TO CREDIT CARD 3333 INCL LATE FEE','TRANSFER TO SAVINGS 2222 NO FEE'])test('MAJOR-2 mixed movement fee wording remains counted: '+memo,async t=>{
 const f=fixture(t);f.account('bank');f.account('card',{kind:'card',mask:'3333'});f.account('saving',{kind:'savings',mask:'2222'});
 for(const slug of ['bank','card','saving'])f.coverage(slug,'2026-10-01','2026-10-31');
 f.row('pay','bank',200000,{direction:'outflow',memo});f.row('ack','card',200000,{day:'2026-10-03',memo:'PAYMENT THANK YOU'});
 const row=(await f.query("SELECT * FROM txn WHERE txn_uid='pay'"))[0];assert.equal(row.estimated,1);assert.match(row.estimate_reason,/_counted$/);assert.equal(row.expense_minor,200000);
 const r=await queryMoney(f.env,{sql:`SELECT SUM(expense_minor) n FROM txn WHERE ${october}`});assert.equal(r.rows[0].n,200000);assert.ok(r.confidence.score<90);
 const g=r.confidence.gaps.find(g=>g.code==='estimated_membership');assert.ok(g.reasons.some(r=>r.treatment==='counted' && r.outflow_minor===200000));
});
test('MAJOR-2 standalone fee transaction types remain certain spending',async t=>{
 const f=fixture(t);f.account('bank');for(const memo of ['MONTHLY SERVICE CHARGE','CHARGEBACK FEE','LATE PAYMENT FEE','OVERDRAFT FEE','BALANCE TRANSFER FEE'])f.row(memo,'bank',1500,{direction:'outflow',memo});
 for(const row of await f.query('SELECT * FROM txn')){assert.equal(row.expense_minor,1500);assert.equal(row.estimated,0);}
});
test('MINOR-1 unconfirmed disclosures use selected dates, accounts and exact amounts',async t=>{
 const f=fixture(t);f.account('bank');f.coverage('bank','2026-10-01','2026-10-31');f.row('sale','bank',10000,{category:'INCOME'});
 f.row('old','bank',7000,{day:'2025-03-02',category:'INCOME'});f.run("UPDATE fin_transactions SET basis_state='proposed' WHERE txn_uid='old'");
 const request={sql:`SELECT SUM(income_minor) n FROM txn WHERE ${october}`};
 const clean=await queryMoney(f.env,request);assert.equal(clean.rows[0].n,10000);assert.equal(clean.confidence.selection_score,100);
 assert.equal(clean.confidence.score,60,'live accounts without connection/sync evidence stay Low');
 f.row('current','bank',3000,{day:'2026-10-05',category:'INCOME'});f.run("UPDATE fin_transactions SET basis_state='proposed' WHERE txn_uid='current'");
 const g=(await queryMoney(f.env,request)).confidence.gaps.find(g=>g.code==='unconfirmed');assert.equal(g.amounts[0].inflow_minor,3000);assert.equal(g.accounts[0].account,'1111');assert.equal(g.from,'2026-10-05');
});
test('MINOR-2 memo interest and returned counted payments disclose counted treatment',async t=>{
 const f=fixture(t);f.account('bank');f.coverage('bank','2026-10-01','2026-10-31');
 f.row('split','bank',125000,{direction:'outflow',memo:'LOAN PAYMENT PRINCIPAL 939.85 INTEREST 310.15'});
 f.row('unproved','bank',10000,{direction:'outflow',memo:'CARD PAYMENT'});
 f.row('returned','bank',10000,{day:'2026-10-03',memo:'RETURNED PAYMENT'});
 // Memo interest is already inside the full counted debit. The returned
 // unproved card payment offsets its original debit, never the loan debit.
 const r=await queryMoney(f.env,{sql:`SELECT SUM(expense_minor+CASE WHEN expense_minor=0 THEN interest_stated_minor ELSE 0 END-refund_minor) n FROM txn WHERE ${october}`});
 assert.equal(r.rows[0].n,125000);const reasons=r.confidence.gaps.find(g=>g.code==='estimated_membership').reasons;
 const split=(await f.query("SELECT * FROM txn WHERE txn_uid='split'"))[0];
 assert.equal(split.expense_minor,125000);assert.equal(split.interest_stated_minor,31015);assert.equal(split.estimated,1);
 for(const reason of ['memo_split_needs_statement_counted','returned_payment_refund_counted'])assert.equal(reasons.find(g=>g.reason===reason).treatment,'counted');
 assert.ok(r.confidence.score<90);
 const rows=await f.query('SELECT * FROM txn ORDER BY id');
 assert.equal(rows.find(r=>r.txn_uid==='returned').refund_minor,10000);assert.equal(rows.find(r=>r.txn_uid==='unproved').expense_minor,10000);
});
test('MINOR-3 partial omission dollars exclude the six-day evidence margin',async t=>{
 const f=fixture(t);f.account('bank');f.coverage('bank','2026-10-01','2026-10-31');
 f.row('kept','bank',100,{direction:'outflow'});f.row('margin','bank',500,{day:'2026-09-27',direction:'outflow'});f.row('omitted','bank',200,{direction:'outflow'});
 const r=await queryMoney(f.env,{sql:`SELECT SUM(expense_minor) n FROM txn WHERE ${october}`,from:'2026-10-01',to:'2026-10-31'},{maxScanRows:1,maxSnapshotRows:1});
 assert.equal(r.rows[0].n,100);assert.equal(r.confidence.score,0);const g=r.confidence.gaps.find(g=>g.code==='input_incomplete');assert.equal(g.missing_rows,1);assert.equal(g.amounts[0].outflow_minor,200);assert.ok(g.from>='2026-10-01');
});
test('MINOR-5 direction filters scope membership evidence without hiding account coverage',async t=>{
 const f=fixture(t);f.account('bank');f.coverage('bank','2026-10-01','2026-10-31');f.row('guess','bank',100000,{memo:'DEPOSIT'});f.row('purchase','bank',7000,{direction:'outflow'});
 const r=await queryMoney(f.env,{sql:`SELECT SUM(expense_minor) n FROM txn WHERE direction='outflow' AND ${october}`});assert.equal(r.rows[0].n,7000);assert.equal(r.confidence.selection_score,65);assert.equal(r.confidence.score,15);
 f.run("UPDATE fin_account_coverage SET coverage_status='partial'");
 const incomplete=await queryMoney(f.env,{sql:`SELECT SUM(expense_minor) n FROM txn WHERE direction='outflow' AND ${october}`});
 assert.equal(incomplete.rows[0].n,7000);assert.ok(incomplete.confidence.selection_score<r.confidence.selection_score);
 assert.ok(incomplete.confidence.selection_gaps.some(g=>g.code==='incomplete_coverage'),'the changed coverage decision was reached');
});
test('MINOR-6 non-clean SQL validates supplied windows before returning a figure',async t=>{
 const f=fixture(t);f.account('bank');await assert.rejects(queryMoney(f.env,{sql:'SELECT * FROM fin_accounts',from:'2026-02-30',to:'2026-03-01'}),e=>e.code==='MONEY_QUERY_WINDOW');
});
test('loan receipt components reconcile only one lender and count the paying leg once',async t=>{
 const f=fixture(t);f.account('bank');f.account('loan',{kind:'loan',mask:'3333'});f.run("UPDATE fin_accounts SET label='Lender Bank',institution='Lender Bank' WHERE account_slug='loan'");
 for(const slug of ['bank','loan'])f.coverage(slug,'2026-10-01','2026-10-31');
 f.row('payment','bank',125000,{direction:'outflow',memo:'PAYMENT TO LOAN 3333',payee:'Lender Bank'});f.row('principal','loan',90000,{memo:'PRINCIPAL PAYMENT'});f.row('interest','loan',35000,{memo:'INTEREST PAYMENT'});
 const r=await queryMoney(f.env,{sql:`SELECT SUM(paid_minor) paid,SUM(expense_minor+interest_stated_minor) expense FROM txn WHERE ${october}`});
 assert.equal(r.rows[0].paid,125000);assert.equal(r.rows[0].expense,35000);assert.equal(r.confidence.selection_score,100);assert.equal(r.confidence.score,60);
 // The same figures without an owned endpoint do not authorize exclusion.
 f.run("UPDATE fin_transactions SET description='LOAN PAYMENT' WHERE txn_uid='payment'");
 const unproved=(await f.query("SELECT * FROM txn WHERE txn_uid='payment'"))[0];
 assert.equal(unproved.expense_minor,125000);assert.equal(unproved.estimated,1);
});
test('a lender payee without a directed endpoint retains the full debit and discloses possible overlap',async t=>{
 const f=fixture(t);f.account('bank');f.account('loan',{kind:'loan',mask:'3333'});f.run("UPDATE fin_accounts SET institution='Lender Bank' WHERE account_slug='loan'");
 for(const slug of ['bank','loan'])f.coverage(slug,'2026-10-01','2026-10-31');
 f.row('payment','bank',125000,{direction:'outflow',memo:'LOAN PAYMENT',payee:'Lender Bank'});
 f.row('principal','loan',90000,{memo:'PRINCIPAL PAYMENT'});f.row('interest','loan',35000,{memo:'INTEREST PAYMENT'});
 const rows=await f.query('SELECT * FROM txn ORDER BY id'),debit=rows.find(r=>r.txn_uid==='payment');
 assert.equal(debit.expense_minor,125000);assert.equal(debit.paid_minor,0);assert.equal(debit.estimated,1);
 assert.equal(rows.find(r=>r.txn_uid==='principal').paid_minor,90000);assert.equal(rows.find(r=>r.txn_uid==='interest').interest_stated_minor,35000);
 const result=await queryMoney(f.env,{sql:`SELECT SUM(expense_minor) n FROM txn WHERE ${october}`});assert.equal(result.rows[0].n,125000);assert.ok(result.confidence.percent<90);
 const gap=result.confidence.gaps.find(g=>g.code==='estimated_membership');assert.equal(gap.amounts[0].outflow_minor,125000);assert.match(gap.missing,/statements/);
 // The old expense-only control cannot catch an additive lender component.
 const recipe=moneyGuideFor({now:Date.parse('2026-11-13T15:00:00Z'),timeZone:'America/Phoenix'}).match(/\nProfit:[^\n]*\n([^\n]+)/)?.[1];
 assert.ok(recipe,'the shipped Profit consumer was reached');
 const sql=recipe.replaceAll('2026-09-01','2026-10-01').replaceAll('2026-09-30','2026-10-31');
 const combined=await queryMoney(f.env,{sql});assert.equal(combined.rows[0].cash_profit_minor,-125000);
 assert.match(combined.confidence_text,/\$350\.00/);assert.match(combined.confidence_text,/overlap/);
 f.row('separate-interest','loan',7000,{day:'2026-10-20',memo:'INTEREST PAYMENT'});
 const separate=await queryMoney(f.env,{sql});assert.equal(separate.rows[0].cash_profit_minor,-132000);

});
test('posting margins clamp safely at the SQLite calendar ceiling',async t=>{
 const f=fixture(t);f.account('bank');f.coverage('bank','9999-12-31','9999-12-31');f.row('sale','bank',12300,{day:'9999-12-31',category:'INCOME'});
 const r=await queryMoney(f.env,{sql:"SELECT SUM(income_minor) n FROM txn WHERE posted_on BETWEEN '9999-12-31' AND '9999-12-31'",from:'9999-12-31',to:'9999-12-31'});assert.equal(r.rows[0].n,12300);assert.equal(r.confidence.selection_score,100);assert.equal(r.confidence.score,20,'future history and missing connections cannot earn High');
});

for(const memo of ['ISSUER CARD ONLINE PMT INCL LATE FEE','ONLINE PAYMENT TO CREDIT CARD 3333 INCL LATE FEE','TRANSFER TO SAVINGS 2222 NO FEE'])test('mixed fee wording vetoes category pair proof: '+memo,async t=>{
 const f=fixture(t);f.account('bank');f.account('card',{kind:'card',mask:'3333'});f.account('saving',{kind:'savings',mask:'2222'});
 const target=memo.startsWith('TRANSFER')?'saving':'card';
 f.row('payment','bank',200000,{direction:'outflow',memo,category:'TRANSFER_OUT'});
 f.row('receipt',target,200000,{memo:target==='saving'?'TRANSFER FROM CHECKING 1111':'PAYMENT THANK YOU',category:'TRANSFER_IN'});
 const row=(await f.query("SELECT * FROM txn WHERE txn_uid='payment'"))[0];assert.equal(row.expense_minor,200000);assert.equal(row.estimated,1);
 assert.ok((await f.query('SELECT proved FROM transfer_pairs')).every(p=>p.proved===0));
});
for(const mode of ['live','manual'])for(const edge of ['opened','closed'])test('only confirmed '+edge+' dates can shorten required coverage ('+mode+')',async t=>{
 const f=fixture(t);f.account('bank',{mode});f.coverage('bank','2026-10-01','2026-10-31');f.row('sale','bank',10000,{category:'INCOME'});
 f.account('saving',{kind:'savings',mask:'2222',mode});f.coverage('saving',edge==='opened'?'2026-10-10':'2026-10-01',edge==='closed'?'2026-10-15':'2026-10-31');
 f.run(`UPDATE fin_accounts SET ${edge==='opened'?"opened_on='2026-10-10'":"closed_on='2026-10-15',status='closed'"} WHERE account_slug='saving'`);
 const request={sql:`SELECT SUM(income_minor) n FROM txn WHERE ${october}`};
 const confirmed=await queryMoney(f.env,request);assert.equal(confirmed.rows[0].n,10000);assert.equal(confirmed.confidence.selection_score,100);// Literal SQL dates prove the October period without period arguments (fix step 1).
 assert.equal(confirmed.confidence.score,mode==='manual'?95:60);
 f.run("UPDATE fin_accounts SET basis_state='proposed' WHERE account_slug='saving'");
 const proposed=await queryMoney(f.env,request);assert.equal(proposed.rows[0].n,10000);assert.equal(proposed.confidence.selection_score,60);assert.equal(proposed.confidence.score,60);
});
for(const kind of ['card','loan','line_of_credit'])test(kind+' credits never become income through processor or category rules',async t=>{
 const f=fixture(t);f.account('liability',{kind,mask:'3333'});
 for(const [i,memo,category] of [[0,'STRIPE PAYOUT',null],[1,'CAPITAL DEPOSIT','INCOME'],[2,'OWNER CONTRIBUTION','OWNER_CONTRIBUTION'],[3,'INTEREST PAYMENT',null]])f.row('credit-'+i,'liability',10000,{memo,payee:'Stripe',category});
 assert.ok((await f.query('SELECT income_minor FROM txn')).every(r=>r.income_minor===0));
});
test('confirmed borrowing and owner-money codes outrank processor payout and capital wording',async t=>{
 const f=fixture(t);f.account('bank');
 for(const [i,memo,category,kind] of [[0,'STRIPE PAYOUT','LOAN_PROCEEDS','loan_proceeds'],[1,'SQ CAPITAL DEPOSIT','LOAN_PROCEEDS','loan_proceeds'],[2,'STRIPE PAYOUT','OWNER_CONTRIBUTION','owner_money']]){
   f.row('credit-'+i,'bank',10000,{memo,payee:i===1?'Square Inc':'Stripe',category});
   const row=(await f.query(`SELECT * FROM txn WHERE txn_uid='credit-${i}'`))[0];assert.equal(row.income_minor,0);assert.equal(row.money_kind,kind);assert.equal(row.estimated,0);
 }
});
