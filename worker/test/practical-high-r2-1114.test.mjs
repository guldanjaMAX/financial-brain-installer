import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/clean-money-fixture.mjs';
import { queryMoney } from '../src/lib/money-query.js';
const period={period_from:'2026-10-01',period_to:'2026-10-31'};
const now=()=>Date.parse('2026-11-14T18:00:00Z');
function book(t){const f=fixture(t);f.env.BRAIN_TIMEZONE='UTC';f.account('operating',{mode:'manual'});f.coverage('operating',period.period_from,period.period_to);return f;}
const sql=field=>`SELECT currency,SUM(${field}) AS cents FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31' AND ${field}>0 AND COALESCE(category,'')<>'LOAN_PROCEEDS' GROUP BY currency`;
async function query(f,field,measure){return queryMoney(f.env,{sql:sql(field),...period,measure},{now});}
test('complete manual posted receipts use the same declared selection through null-safe category filters',async t=>{
 const f=book(t);f.row('receipt','operating',500000,{payee:'Customer',category:'CLIENT_INCOME'});
 const r=await query(f,'income_minor','net_receipts');assert.equal(r.rows[0].cents,500000);assert.ok(r.confidence.percent>=90,r.confidence_text);
 f.row('outside','operating',900000,{day:'2026-09-30',pending:1});f.row('removed','operating',900000,{day:'2026-10-10'});f.run("UPDATE fin_transactions SET removed_at='2026-10-11',removal_reason='removed' WHERE txn_uid='removed'");
 const again=await query(f,'income_minor','net_receipts');assert.equal(again.rows[0].cents,500000);assert.equal(again.confidence.percent,r.confidence.percent);assert.ok(f.calls.length>0);
});
test('a named expense category ignores other categories and keeps uncertain selected rows below High',async t=>{
 const f=book(t);f.row('ad','operating',50000,{direction:'outflow',payee:'Ad vendor',category:'ADVERTISING'});f.row('deposit','operating',600000,{memo:'Refundable bond'});
 const body={sql:sql('expense_minor').replace(' GROUP BY'," AND category='ADVERTISING' GROUP BY"),...period,measure:'posted_spending'};
 const green=await queryMoney(f.env,body,{now});assert.equal(green.rows[0].cents,50000);assert.ok(green.confidence.percent>=90,green.confidence_text);
 f.row('risk','operating',30000,{direction:'outflow',memo:'Refundable bond',category:'ADVERTISING'});const bad=await queryMoney(f.env,body,{now});assert.equal(bad.rows[0].cents,80000);assert.ok(bad.confidence.percent<90,bad.confidence_text);assert.ok(bad.confidence.selection_gaps.some(g=>/principal|proved/.test(g.code)));
});
test('explicit posted cash measures disclose holds without treating them as received or spent money',async t=>{
 const f=book(t);f.row('receipt','operating',500000,{payee:'Customer'});f.row('hold','operating',800000,{pending:1,payee:'Customer'});
 const r=await query(f,'income_minor','net_receipts');assert.equal(r.rows[0].cents,500000);assert.ok(r.confidence.percent>=90,r.confidence_text);assert.ok(JSON.stringify(r.confidence).includes('pending'));assert.doesNotMatch(JSON.stringify(r.confidence.caveats),/external_id|source_provider|source_feed/);
});
test('explicit and SQL-inferred net receipts distinguish settlement cash from gross sales',async t=>{
 const f=book(t);f.row('payout','operating',970000,{memo:'STRIPE PAYOUT'});
 const net=await query(f,'income_minor','net_receipts');assert.equal(net.rows[0].cents,970000);assert.ok(net.confidence.percent>=90,net.confidence_text);
 const inferred=await query(f,'income_minor',undefined);assert.equal(inferred.rows[0].cents,970000);assert.ok(inferred.confidence.percent>=90,inferred.confidence_text);assert.ok(inferred.confidence.caveats.some(c=>c.code==='posted_measure'));
 const bad=await query(f,'income_minor','gross_sales');assert.equal(bad.rows[0].cents,970000);assert.ok(bad.confidence.percent<90,bad.confidence_text);assert.ok(bad.confidence.reasons.some(r=>/settlement|gross/.test(r)));
});
for(const memo of ['Vendor proration credit','Vendor account credit','Same purchase'])test(`materiality cannot certify a contradicted return headline: ${memo}`,async t=>{
 const f=book(t);f.row('ordinary','operating',500000,{payee:'Customer'});const green=await queryMoney(f.env,{sql:`SELECT SUM(income_minor) AS cents FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31'`,...period},{now});assert.equal(green.rows[0].cents,500000);assert.ok(green.confidence.percent>=90);
 f.row('purchase','operating',4900,{day:'2026-10-05',direction:'outflow',payee:'Service vendor',memo:'Same purchase'});f.row('credit','operating',4900,{day:'2026-10-06',payee:'Service vendor',memo});
 const r=await queryMoney(f.env,{sql:`SELECT SUM(income_minor) AS cents FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31'`,...period},{now});assert.equal(r.rows[0].cents,504900);assert.ok(r.confidence.percent<90,r.confidence_text);assert.ok(r.confidence.reasons.length);
 const contextual=await query(f,'income_minor','net_receipts');assert.equal(contextual.rows[0].cents,504900);assert.ok(contextual.confidence.percent<90,contextual.confidence_text);
});
test('unique reciprocal owned endpoints prove a pair even when the chosen pair label is bank category',async t=>{
 const f=book(t);f.account('reserve',{mode:'manual',mask:'2222'});f.coverage('reserve',period.period_from,period.period_to);
 f.row('receipt','operating',500000,{payee:'Customer'});f.row('out','operating',20000,{direction:'outflow',memo:'TRANSFER TO account 2222',category:'TRANSFER_OUT_ACCOUNT_TRANSFER'});f.row('in','reserve',20000,{memo:'TRANSFER FROM account 1111',category:'TRANSFER_IN_ACCOUNT_TRANSFER'});
 const r=await query(f,'income_minor','net_receipts');assert.equal(r.rows[0].cents,500000);assert.ok(r.confidence.percent>=90,r.confidence_text);
 f.run("UPDATE fin_transactions SET description='TRANSFER FROM account 9999' WHERE txn_uid='in'");const bad=await query(f,'income_minor','net_receipts');assert.equal(bad.rows[0].cents,520000);assert.ok(bad.confidence.percent<90,bad.confidence_text);assert.ok(f.calls.some(s=>s.includes('transfer_pairs')));
});
test('fixed monthly charges use complete category coverage and reject an incomplete recurrence rule',async t=>{
 const f=book(t);f.run('DELETE FROM fin_account_coverage');f.coverage('operating','2026-08-01','2026-10-31');
 for(const [month,uid] of [['08','first'],['09','second'],['10','third']])f.row(uid,'operating',7900,{day:`2026-${month}-05`,direction:'outflow',payee:'Software vendor',category:'SOFTWARE'});
 f.row('unrelated','operating',900000,{memo:'Refundable bond'});
 const body={sql:`SELECT payee AS vendor,currency,MIN(amount_minor) AS cents,COUNT(DISTINCT substr(posted_on,1,7)) AS months FROM txn WHERE posted_on BETWEEN '2026-08-01' AND '2026-10-31' AND expense_minor>0 AND category='SOFTWARE' GROUP BY payee,currency HAVING COUNT(DISTINCT substr(posted_on,1,7))=3 AND MIN(amount_minor)=MAX(amount_minor)`,period_from:'2026-08-01',period_to:'2026-10-31',measure:'posted_spending'};
 const green=await queryMoney(f.env,body,{now});assert.equal(green.rows[0].cents,7900);assert.equal(green.rows[0].months,3);assert.ok(green.confidence.percent>=90,green.confidence_text);
 const bad=await queryMoney(f.env,{...body,sql:body.sql.replace('))=3',"))>=2")},{now});assert.equal(bad.rows.length,1,'the unsupported having decision is reached with an actual result');assert.ok(bad.confidence.percent<90,bad.confidence_text);
});
test('explicit measure labels cannot certify scaled uncertainty or a different statistical population',async t=>{
 const f=book(t);f.row('ordinary','operating',500000,{payee:'Customer'});f.row('risk','operating',4900,{memo:'Refundable bond',payee:'Payer'});
 for(const expression of ['SUM(income_minor)*1000000','COUNT(*)','AVG(income_minor)']) {
  const r=await queryMoney(f.env,{sql:`SELECT ${expression} AS cents FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31' AND income_minor>0`,...period,measure:'net_receipts'},{now});
  assert.equal(r.rows.length,1);assert.ok(r.rows[0].cents>0);assert.ok(r.confidence.percent<90,r.confidence_text);
 }
});
test('a complete manual statement stays covered beside an unselected live account',async t=>{
 const f=book(t);f.row('receipt','operating',500000,{payee:'Customer'});f.account('other',{mode:'live',mask:'2222'});
 const body={sql:`SELECT SUM(income_minor) AS cents FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31' AND account_slug='operating'`,...period};
 const green=await queryMoney(f.env,body,{now});assert.equal(green.rows[0].cents,500000);assert.ok(green.confidence.percent>=90,green.confidence_text);
 f.run("UPDATE fin_account_coverage SET covered_to='2026-10-15' WHERE account_slug='operating'");const bad=await queryMoney(f.env,body,{now});assert.equal(bad.rows[0].cents,500000);assert.ok(bad.confidence.percent<90,bad.confidence_text);assert.match(bad.confidence_text,/2026-10-16|2026-10-15/);
});
test('a ranked SQL result declares its top groups and explicit context must agree',async t=>{
 const f=book(t);f.row('first','operating',50000,{direction:'outflow',payee:'Vendor one'});f.row('second','operating',20000,{direction:'outflow',payee:'Vendor two'});
 const body={sql:`SELECT payee AS vendor,currency,SUM(expense_minor) AS cents FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31' AND expense_minor>0 GROUP BY payee,currency ORDER BY cents DESC,vendor LIMIT 1`,...period,measure:'posted_spending'};
 const green=await queryMoney(f.env,{...body,rank_limit:1},{now});assert.equal(green.rows.length,1);assert.equal(green.rows[0].cents,50000);assert.ok(green.confidence.percent>=90,green.confidence_text);
 const inferred=await queryMoney(f.env,body,{now});assert.equal(inferred.rows[0].cents,50000);assert.ok(inferred.confidence.percent>=90,inferred.confidence_text);assert.ok(inferred.confidence.caveats.some(c=>c.code==='requested_top_groups'));
 for(const change of [{rank_limit:2},{rank_limit:1,sql:body.sql.replace('cents DESC','cents ASC')}]){const bad=await queryMoney(f.env,{...body,...change},{now});assert.equal(bad.rows.length,1,'the bounded selection actually returned a group');assert.ok(bad.confidence.percent<90,bad.confidence_text);}
});
test('ordinary uncategorized purchases cannot prove zero spending in a named category',async t=>{
 const f=book(t);f.row('ad','operating',50000,{direction:'outflow',payee:'Ad vendor',category:'ADVERTISING'});
 const body={sql:sql('expense_minor').replace(' GROUP BY'," AND category='ADVERTISING' GROUP BY"),...period,measure:'posted_spending'};
 const green=await queryMoney(f.env,body,{now});assert.equal(green.rows[0].cents,50000);assert.ok(green.confidence.percent>=90);
 f.row('uncategorized','operating',30000,{direction:'outflow',payee:'Supply vendor'});const bad=await queryMoney(f.env,body,{now});assert.equal(bad.rows[0].cents,50000);assert.ok(bad.confidence.percent<90,bad.confidence_text);assert.match(bad.confidence_text,/category population/);
});
test('posted spending does not certify the government-tax population from a generic tax category',async t=>{
 const f=book(t);f.row('rent','operating',150000,{direction:'outflow',payee:'Rent vendor',category:'RENT'});f.row('tax','operating',6000,{direction:'outflow',payee:'Tax authority',category:'TAX'});
 const green=await query(f,'expense_minor','posted_spending');assert.equal(green.rows[0].cents,156000);assert.ok(green.confidence.percent>=90,green.confidence_text);
 const body={sql:sql('expense_minor').replace(' GROUP BY'," AND category='TAX' GROUP BY"),...period,measure:'posted_spending'};
 const bad=await queryMoney(f.env,body,{now});assert.equal(bad.rows[0].cents,6000);assert.ok(bad.confidence.percent<90,bad.confidence_text);assert.match(bad.confidence_text,/tax payment type/);
});
test('a supplier credit with a legal-name alias is a return candidate before materiality',async t=>{
 const f=book(t);f.row('ordinary','operating',500000,{payee:'Customer'});const green=await query(f,'income_minor','net_receipts');assert.equal(green.rows[0].cents,500000);assert.ok(green.confidence.percent>=90);
 f.row('purchase','operating',4900,{day:'2026-10-05',direction:'outflow',payee:'Service vendor',memo:'Monthly plan'});f.row('credit','operating',4900,{day:'2026-10-07',payee:'Service vendor Inc',memo:'SERVICE VENDOR CREDIT'});
 for(const measure of [undefined,'net_receipts']){const bad=await query(f,'income_minor',measure);assert.equal(bad.rows[0].cents,504900);assert.ok(bad.confidence.percent<90,bad.confidence_text);assert.match(bad.confidence_text,/return|refund/);}
});
test('outside-period pending rows do not lower an otherwise complete literal-date question',async t=>{
 const f=book(t);f.row('ordinary','operating',500000,{payee:'Customer'});
 const body={sql:`SELECT SUM(income_minor) AS cents FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31'`,...period};
 const green=await queryMoney(f.env,body,{now});assert.equal(green.rows[0].cents,500000);assert.ok(green.confidence.percent>=90);
 f.row('outside','operating',900000,{day:'2026-09-30',pending:1,payee:'Customer'});
 const after=await queryMoney(f.env,body,{now});assert.equal(after.rows[0].cents,500000);assert.equal(after.confidence.percent,green.confidence.percent,after.confidence_text);assert.ok(f.calls.length>0);
 f.row('inside','operating',20000,{day:'2026-10-10',pending:1,payee:'Customer'});const inside=await queryMoney(f.env,body,{now});assert.equal(inside.rows[0].cents,500000);assert.ok(inside.confidence.percent<90,inside.confidence_text);assert.ok(inside.confidence.selection_gaps.some(g=>g.code==='stale_pending'));
});
test('outside-period duplicate history does not lower a complete live question',async t=>{
 const {overviewFixture}=await import('./helpers/money-overview-fixture.mjs');const f=overviewFixture(t);f.env.BRAIN_TIMEZONE='UTC';
 f.account('operating','live');f.connection('operating');f.coverage('operating','2026-10-01','2026-10-31');
 f.row('receipt','operating','2026-10-10',500000,'inflow',{description:'Customer payment'});f.run("UPDATE fin_transactions SET payee='Customer' WHERE txn_uid='receipt'");f.run("UPDATE bank_feed_items SET last_synced_at='2026-11-14T17:00:00Z'");
 const body={sql:`SELECT SUM(income_minor) AS cents FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31'`,...period};
 const green=await queryMoney(f.env,body,{now});assert.equal(green.rows[0].cents,500000);assert.ok(green.confidence.percent>=90,green.confidence_text);
 for(const uid of ['old-first','old-copy'])f.row(uid,'operating','2026-09-28',50000,'outflow',{description:'Vendor purchase',category:'PURCHASE'});
 const after=await queryMoney(f.env,body,{now});assert.equal(after.rows[0].cents,500000);assert.equal(after.confidence.percent,green.confidence.percent,after.confidence_text);assert.ok(f.calls.some(s=>s.includes('coverage')));
});
test('case variants in a category literal keep the unchanged empty result below High',async t=>{
 const f=book(t);f.row('ad','operating',50000,{direction:'outflow',payee:'Ad vendor',category:'ADVERTISING'});
 const body={sql:sql('expense_minor').replace(' GROUP BY'," AND category='ADVERTISING' GROUP BY"),...period,measure:'posted_spending'};
 const green=await queryMoney(f.env,body,{now});assert.equal(green.rows[0].cents,50000);assert.ok(green.confidence.percent>=90);
 const bad=await queryMoney(f.env,{...body,sql:body.sql.replace("category='ADVERTISING'","category='advertising'")},{now});assert.equal(bad.rows.length,0);assert.ok(f.calls.length>0);assert.ok(bad.confidence.percent<90,bad.confidence_text);assert.match(bad.confidence_text,/category/);
});
test('raw vendor spelling groups cannot certify a split party ranking',async t=>{
 const f=book(t);f.row('one','operating',50000,{direction:'outflow',payee:'Vendor one'});f.row('two','operating',60000,{direction:'outflow',payee:'Vendor two'});
 const body={sql:`SELECT payee AS vendor,currency,SUM(expense_minor) AS cents FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31' AND expense_minor>0 GROUP BY payee,currency ORDER BY cents DESC,vendor LIMIT 1`,...period,measure:'posted_spending',rank_limit:1};
 const green=await queryMoney(f.env,body,{now});assert.equal(green.rows[0].cents,60000);assert.ok(green.confidence.percent>=90);
 f.row('variant','operating',40000,{direction:'outflow',payee:'VENDOR ONE'});const bad=await queryMoney(f.env,body,{now});assert.equal(bad.rows[0].cents,60000);assert.ok(bad.confidence.percent<90,bad.confidence_text);assert.match(bad.confidence_text,/grouping|party/);
});
test('a fixed monthly minimum cannot certify two separate charges per month',async t=>{
 const f=book(t);f.run('DELETE FROM fin_account_coverage');f.coverage('operating','2026-08-01','2026-10-31');
 for(const month of ['08','09','10'])f.row(`one-${month}`,'operating',7900,{day:`2026-${month}-05`,direction:'outflow',payee:'Software vendor',category:'SOFTWARE'});
 const body={sql:`SELECT payee AS vendor,currency,MIN(amount_minor) AS cents,COUNT(DISTINCT substr(posted_on,1,7)) AS months FROM txn WHERE posted_on BETWEEN '2026-08-01' AND '2026-10-31' AND expense_minor>0 AND category='SOFTWARE' GROUP BY payee,currency HAVING COUNT(DISTINCT substr(posted_on,1,7))=3 AND MIN(amount_minor)=MAX(amount_minor)`,period_from:'2026-08-01',period_to:'2026-10-31',measure:'posted_spending'};
 const green=await queryMoney(f.env,body,{now});assert.equal(green.rows[0].cents,7900);assert.ok(green.confidence.percent>=90);
 for(const month of ['08','09','10'])f.row(`two-${month}`,'operating',7900,{day:`2026-${month}-20`,direction:'outflow',payee:'Software vendor',category:'SOFTWARE'});
 const bad=await queryMoney(f.env,body,{now});assert.equal(bad.rows[0].cents,7900);assert.equal(bad.rows[0].months,3);assert.ok(bad.confidence.percent<90,bad.confidence_text);assert.match(bad.confidence_text,/monthly|charges/);
});
test('unproved loan exclusions outside the named account do not lower its ordinary receipts',async t=>{
 const f=book(t);f.row('ordinary','operating',500000,{payee:'Customer'});
 const body={sql:`SELECT SUM(income_minor) AS cents FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31' AND account_slug='operating'`,...period};
 const green=await queryMoney(f.env,body,{now});assert.equal(green.rows[0].cents,500000);assert.ok(green.confidence.percent>=90);
 f.account('other-bank',{mode:'manual',mask:'2222'});f.account('borrowing',{mode:'manual',mask:'5555',kind:'loan'});for(const slug of ['other-bank','borrowing'])f.coverage(slug,period.period_from,period.period_to);
 f.row('draw-out','borrowing',450000,{day:'2026-10-04',direction:'outflow',payee:'Lender',memo:'LOAN_PROCEEDS',category:'LOAN_PROCEEDS'});f.row('draw-in','other-bank',450000,{day:'2026-10-04',payee:'Lender',memo:'LOAN_PROCEEDS',category:'LOAN_PROCEEDS'});
 const after=await queryMoney(f.env,body,{now});assert.equal(after.rows[0].cents,500000);assert.equal(after.confidence.percent,green.confidence.percent,after.confidence_text);
 const risky=await queryMoney(f.env,{...body,sql:body.sql.replace("account_slug='operating'","account_slug='other-bank'")},{now});assert.equal(risky.rows[0].cents,0);assert.ok(risky.confidence.percent<90,risky.confidence_text);assert.match(risky.confidence_text,/loan proceeds/);
});
