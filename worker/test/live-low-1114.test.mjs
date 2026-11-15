import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/clean-money-fixture.mjs';
import { queryMoney } from '../src/lib/money-query.js';

const period={period_from:'2026-10-01',period_to:'2026-10-31'};
const now=()=>Date.parse('2026-11-14T18:00:00Z');
function book(t){
 const f=fixture(t);f.env.BRAIN_TIMEZONE='UTC';f.account('operating',{mode:'manual'});
 f.coverage('operating',period.period_from,period.period_to);
 f.row('receipt','operating',500000,{payee:'Customer',category:'CLIENT_INCOME'});
 f.row('payout','operating',97000,{memo:'STRIPE PAYOUT'});
 f.row('tax','operating',6000,{direction:'outflow',payee:'Tax authority',category:'TAX'});
 f.row('hold','operating',900000,{pending:1,payee:'Customer'});
 return f;
}
const sql=`SELECT currency,SUM(income_minor) AS cents,COUNT(*) AS n,GROUP_CONCAT(txn_uid) AS uids FROM txn WHERE posted_on >= '2026-10-01' AND posted_on <= '2026-10-31' AND income_minor>0 GROUP BY currency`;
const query=(f,body={})=>queryMoney(f.env,{sql,...period,...body},{now});
function high(r,cents=597000){assert.equal(r.rows[0].cents,cents);assert.ok(r.confidence.percent>=90,r.confidence_text);assert.ok(r.confidence.reasons.length);assert.ok(r.confidence.missing.length);}

test('recorded receipt SQL infers its posted measure with counts and identifiers, without special context',async t=>{
 const f=book(t);const r=await query(f);high(r);assert.equal(r.rows[0].n,2);
 assert.ok(r.confidence.caveats.some(c=>c.code==='posted_measure'));
 assert.ok(r.confidence.caveats.some(c=>c.code==='pending_excluded_posted_measure'));
 assert.ok(f.calls.some(s=>s.includes('fin_account_coverage')));
});
test('explicit posted context and equivalent literal date bounds share one confidence',async t=>{
 const f=book(t),r=await query(f,{measure:'net_receipts'});high(r);
 const between=await query(f,{sql:sql.replace("posted_on >= '2026-10-01' AND posted_on <= '2026-10-31'","posted_on BETWEEN '2026-10-01' AND '2026-10-31'"),measure:'net_receipts'});
 high(between);assert.equal(r.confidence.percent,between.confidence.percent);
});
test('confirmed income reaches High with history read; a bounded read retains party uncertainty',async t=>{
 const f=book(t);high(await query(f));
 const bounded=await query(f,{from:period.period_from,through:period.period_to});assert.equal(bounded.rows[0].cents,597000);
 assert.ok(bounded.confidence.percent<90,bounded.confidence_text);assert.match(bounded.confidence_text,/earlier history was not read/);
 f.row('purchase','operating',4900,{direction:'outflow',day:'2026-10-03',payee:'Service vendor'});
 f.row('credit','operating',4900,{day:'2026-10-04',payee:'Service vendor Inc',memo:'Vendor account credit',category:'CLIENT_INCOME'});
 const bad=await query(f,{from:period.period_from,through:period.period_to});assert.equal(bad.rows[0].cents,601900);
 assert.ok(bad.confidence.percent<90,bad.confidence_text);assert.match(bad.confidence_text,/return|refund|membership/);
});
test('SQL descending aggregate rank supplies its own top N, with contrary ordering and alias controls',async t=>{
 const f=fixture(t);f.env.BRAIN_TIMEZONE='UTC';f.account('operating',{mode:'manual'});f.coverage('operating',period.period_from,period.period_to);
 f.row('one','operating',50000,{direction:'outflow',payee:'Vendor one'});f.row('two','operating',60000,{direction:'outflow',payee:'Vendor two'});
 const ranked=`SELECT payee AS vendor,currency,SUM(expense_minor) AS cents,COUNT(*) AS n,MIN(posted_on) AS first_on,MAX(posted_on) AS last_on FROM txn WHERE posted_on >= '2026-10-01' AND posted_on <= '2026-10-31' AND expense_minor>0 GROUP BY payee,currency ORDER BY SUM(expense_minor) DESC LIMIT 1`;
 const green=await query(f,{sql:ranked});high(green,60000);assert.ok(green.confidence.caveats.some(c=>c.code==='requested_top_groups'&&/top 1/.test(c.why)));
 for(const body of [{sql:ranked.replace('DESC','ASC')},{sql:ranked,rank_limit:2}]){
  const bad=await query(f,body);assert.equal(bad.rows.length,1);assert.ok(bad.confidence.percent<90,bad.confidence_text);
 }
 f.row('alias','operating',40000,{direction:'outflow',payee:'VENDOR ONE'});
 const bad=await query(f,{sql:ranked});assert.equal(bad.rows[0].cents,60000);assert.ok(bad.confidence.percent<90,bad.confidence_text);assert.match(bad.confidence_text,/party|grouping/);
});
test('automatic context cannot certify gross sales, scaled output, opaque filters or mismatched dates',async t=>{
 const f=book(t);high(await query(f));
 for(const body of [
  {measure:'gross_sales'},
  {sql:sql.replace('SUM(income_minor)','SUM(income_minor)*1000000')},
  {sql:sql.replace('SUM(income_minor) AS cents','SUM(income_minor) AS gross_sales')},
  {sql:sql.replace('SUM(income_minor) AS cents','SUM(income_minor) AS total_processor_fees')},
  {sql:sql.replace('income_minor>0',"(income_minor>0 OR direction='outflow')")},
  {sql:sql.replace("<= '2026-10-31'","<= '2026-10-15'")},
  {sql:sql.replace("<= '2026-10-31'",">= '2026-10-02'")},
 ]){
  const bad=await query(f,body);assert.ok(bad.rows.length,'the SQL executed and reached confidence');assert.ok(bad.confidence.percent<90,bad.confidence_text);assert.ok(bad.confidence.missing.length);
 }
});
test('a raw lifecycle diagnostic retains Low independently of a proved headline',async t=>{
 const f=book(t);high(await query(f));
 const bad=await query(f,{sql:`SELECT * FROM fin_transactions WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31' AND pending=1`});
 assert.equal(bad.rows.length,1);assert.equal(bad.rows[0].amount_minor,900000);assert.ok(bad.confidence.percent<90,bad.confidence_text);
});
