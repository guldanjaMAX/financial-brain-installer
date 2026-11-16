import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/clean-money-fixture.mjs';
import { queryMoney } from '../src/lib/money-query.js';
import { overviewMoney } from '../src/lib/money-overview.js';

const period={period_from:'2026-10-01',period_to:'2026-10-31'};
const now=()=>Date.parse('2026-11-14T18:00:00Z');
function book(t) {
  const f=fixture(t);f.env.BRAIN_TIMEZONE='UTC';
  f.account('operating',{mode:'manual'});f.coverage('operating','2026-09-01',period.period_to);
  return f;
}
const query=(f,sql,extra={})=>queryMoney(f.env,{sql,...period,...extra},{now});
const ranked=group=>`SELECT payee AS vendor,currency,SUM(expense_minor) AS cents,COUNT(*) AS n FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31' AND expense_minor>0 GROUP BY ${group} ORDER BY cents DESC LIMIT 1`;
const income="SELECT currency,SUM(income_minor) AS cents FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31' AND income_minor>0 GROUP BY currency";
function below(r,amount) {
  assert.ok(r.rows.length,'the real query returned a figure');
  assert.ok(r.confidence.percent<90,r.confidence_text);
  assert.ok(r.confidence.reasons.some(s=>s.includes(amount)),r.confidence_text);
  assert.ok(r.confidence.missing.length);
}

for(const context of [{},{measure:'posted_spending',rank_limit:1}])test(`RLL2-01: a bare vendor cannot inherit a combined total, context=${Boolean(context.measure)}`,async t=>{
  const f=book(t);
  for(const [uid,cents,payee] of [['first',50000,'Vendor one'],['second',60000,'Vendor two']])
    f.row(uid,'operating',cents,{direction:'outflow',payee,category:'SOFTWARE'});
  const bad=await query(f,ranked('currency'),context);
  assert.equal(bad.rows.length,1);assert.equal(bad.rows[0].cents,110000);assert.equal(bad.rows[0].n,2);
  assert.ok(['Vendor one','Vendor two'].includes(bad.rows[0].vendor));
  assert.ok(f.calls.some(s=>s.includes('GROUP BY currency ORDER BY cents DESC LIMIT 1')),'ungrouped attribution decision reached');
  below(bad,'500.00');assert.match(bad.confidence_text,/group|attribut/);
  const green=await query(f,ranked('payee,currency'),context);
  assert.deepEqual({...green.rows[0]},{vendor:'Vendor two',currency:'USD',cents:60000,n:1});
  assert.ok(green.confidence.percent>=90,green.confidence_text);
});

test('RLL-01: the certificate requires every payer history, including a stale income code',async t=>{
  const f=book(t);
  f.row('purchase','operating',50000,{day:'2026-09-10',direction:'outflow',payee:'Service vendor',category:'SOFTWARE'});
  f.row('receipt','operating',100000,{payee:'Customer',category:'CLIENT_INCOME'});
  f.row('credit','operating',50000,{day:'2026-10-10',payee:'Service vendor',memo:'ACH CREDIT',category:'CLIENT_INCOME'});
  const bounded=await query(f,income,{from:period.period_from,through:period.period_to});
  assert.equal(bounded.rows[0].cents,150000);assert.ok(f.calls.some(s=>s.includes("'2026-09-25'")));
  below(bounded,'500.00');
  const all=await query(f,income);assert.equal(all.rows[0].cents,150000);below(all,'500.00');
  f.run("DELETE FROM fin_transactions WHERE txn_uid IN ('purchase','credit')");
  const green=await query(f,income);assert.equal(green.rows[0].cents,100000);assert.ok(green.confidence.percent>=90,green.confidence_text);
});

test('every contributing expense party needs its history, identity and consistent attribution',async t=>{
  const f=book(t);f.row('purchase','operating',60000,{direction:'outflow',payee:'Vendor one',category:'SOFTWARE'});
  const sql=ranked('payee,currency');
  const green=await query(f,sql);assert.equal(green.rows[0].cents,60000);assert.ok(green.confidence.percent>=90,green.confidence_text);
  const unread=await query(f,sql,{from:period.period_from,through:period.period_to});
  assert.equal(unread.rows[0].cents,60000);below(unread,'600.00');assert.match(unread.confidence_text,/history/);
  f.run("UPDATE fin_transactions SET payee=NULL,description='ACH DEBIT' WHERE txn_uid='purchase'");
  const unknown=await query(f,sql);assert.equal(unknown.rows[0].cents,60000);below(unknown,'600.00');assert.match(unknown.confidence_text,/party|identit/);
});

test('group aliases cannot shadow source dimensions or turn a constant into a vendor',async t=>{
  const f=book(t);
  for(const [uid,cents,payee] of [['first',50000,'Vendor one'],['second',60000,'Vendor two']])
    f.row(uid,'operating',cents,{direction:'outflow',payee,category:'SOFTWARE'});
  const shadow=ranked('category,currency').replace('payee AS vendor','payee AS category');
  const bad=await query(f,shadow);assert.equal(bad.rows[0].cents,110000);below(bad,'500.00');
  const constant=ranked("'Vendor one',currency").replace('payee AS vendor',"'Vendor one' AS vendor");
  const labelled=await query(f,constant);assert.equal(labelled.rows[0].cents,110000);below(labelled,'500.00');
  for(const group of ['vendor,currency','payee,currency']) {
    const green=await query(f,ranked(group).replace('payee AS vendor','PAYEE AS vendor'));
    assert.equal(green.rows[0].cents,60000);assert.ok(green.confidence.percent>=90,green.confidence_text);
  }
});

test('the compound monthly overview is below High and still checks every party',async t=>{
  const {overviewFixture}=await import('./helpers/money-overview-fixture.mjs');
  const f=overviewFixture(t);f.env.BRAIN_TIMEZONE='UTC';
  f.account('operating','live');f.connection('operating');f.coverage('operating','2025-01-01','2026-11-14');
  f.run("UPDATE fin_accounts SET opened_on='2025-01-01'");
  f.row('purchase','operating','2026-10-02',60000,'outflow',{description:'Purchase'});
  f.run("UPDATE fin_transactions SET payee='Vendor one',category='SOFTWARE',category_basis_state='confirmed'");
  f.run('UPDATE bank_feed_items SET last_synced_at=?','2026-11-14T18:00:00Z');
  const green=await overviewMoney(f.env,{now});
  assert.ok(green.months.some(m=>JSON.stringify(m).includes('60000')),'the actual monthly amount was read');
  assert.equal(green.confidence.percent,89);
  assert.match(green.confidence.reasons.join(' '),/query shape not certified/);
  const certified=await queryMoney(f.env,{sql:"SELECT substr(posted_on,1,7) AS month,currency,SUM(expense_minor) AS cents FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31' GROUP BY month,currency",...period},{now});
  assert.equal(certified.rows[0].cents,60000);assert.ok(certified.confidence.percent>=90,certified.confidence_text);
  f.run("UPDATE fin_transactions SET payee=NULL,description='ACH DEBIT' WHERE txn_uid='purchase'");
  const bad=await overviewMoney(f.env,{now});
  assert.deepEqual(bad.months,green.months,'identity proof changes confidence, never monthly arithmetic');
  assert.ok(bad.confidence.percent<90,JSON.stringify(bad.confidence));
  assert.match(bad.confidence.reasons.join(' '),/600\.00.*identity is unresolved/);
});

test('a bare amount outside an aggregate cannot inherit the type certificate',async t=>{
  const f=book(t);
  for(const [uid,cents,payee] of [['first',50000,'Vendor one'],['second',60000,'Vendor two']])
    f.row(uid,'operating',cents,{direction:'outflow',payee,category:'SOFTWARE'});
  const sql="SELECT currency,SUM(expense_minor) AS cents FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31' AND expense_minor>0 GROUP BY currency";
  const bad=await query(f,sql.replace('SUM(expense_minor)','SUM(expense_minor)+expense_minor'));
  assert.equal(bad.rows.length,1);assert.ok([160000,170000].includes(bad.rows[0].cents),'SQLite included an actual bare amount');
  below(bad,'500.00');
  const green=await query(f,sql);assert.equal(green.rows[0].cents,110000);assert.ok(green.confidence.percent>=90,green.confidence_text);
});

for(const payee of ['Deposit interest','Payment service vendor','Wire supply vendor'])test(`a rail word inside a resolved party name does not erase its identity: ${payee}`,async t=>{
  const f=book(t);f.row('receipt','operating',317,{payee,category:payee==='Deposit interest'?'INTEREST_INCOME':'CLIENT_INCOME'});
  const green=await query(f,income);assert.equal(green.rows[0].cents,317);assert.ok(green.confidence.percent>=90,green.confidence_text);
  f.run("UPDATE fin_transactions SET payee='Deposit' WHERE txn_uid='receipt'");
  const bad=await query(f,income);assert.equal(bad.rows[0].cents,317);below(bad,'3.17');
  assert.match(bad.confidence_text,/identity is unresolved/);
});

test('seeded random mixes: High requires all contributing parties grouped, resolved, read and not contrary',async t=>{
  const f=book(t);let seed=0x11_14_03;
  const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
  const states=['proved','ungrouped','unread','unresolved','contrary'];
  const seen=new Set();let highs=0,lows=0;
  for(const field of ['income_minor','expense_minor'])for(let arm=0;arm<35;arm++) {
    f.run('DELETE FROM fin_transactions');
    const mix=arm<5?[states[arm]]:Array.from({length:1+random(4)},()=>states[random(states.length)]);
    mix.forEach(s=>seen.add(s));
    const spending=field==='expense_minor';
    for(const [i,state] of mix.entries()) {
      const payee=state==='unresolved'?null:`Party ${['alpha','beta','gamma','delta'][i]}`;
      f.row(`posting-${i}`,'operating',(i+1)*11100,{direction:spending?'outflow':'inflow',payee,
        memo:state==='contrary'?'Refundable tenant pet bond':spending?'ACH DEBIT':'ACH CREDIT',category:spending?'SOFTWARE':'CLIENT_INCOME'});
    }
    const grouping=mix.includes('ungrouped')?'currency':'payee,currency';
    const sql=`SELECT payee AS party,currency,SUM(${field}) AS cents FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31' AND ${field}>0 GROUP BY ${grouping}`;
    const start=f.calls.length;
    const r=await query(f,sql,mix.includes('unread')?{from:period.period_from,through:period.period_to}:{});
    assert.ok(f.calls.length>start && r.rows.length,'each negative arm reached SQL and contribution assessment');
    const expected=mix.reduce((n,_,i)=>n+(i+1)*11100,0);
    assert.equal(r.rows.reduce((n,row)=>n+row.cents,0),expected,'provisional amounts are retained');
    const proved=mix.every(s=>s==='proved');
    assert.equal(r.confidence.percent>=90,proved,JSON.stringify({field,mix,confidence:r.confidence_text}));
    if(proved)highs++;else {lows++;assert.ok(r.confidence.reasons.length && r.confidence.missing.length);}
  }
  assert.equal(seen.size,5);assert.ok(highs>0 && lows>0,'uniform outcomes fail the harness');
  t.diagnostic(`70 mixes: ${highs} High controls, ${lows} below-High, all five states reached`);
});
