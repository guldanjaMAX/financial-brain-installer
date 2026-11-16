import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/clean-money-fixture.mjs';
import { queryMoney, validateMoneySql } from '../src/lib/money-query.js';
import { certifyMoneyQuery } from '../src/lib/money-query-certificate.js';

const period={period_from:'2026-10-01',period_to:'2026-10-31'};
const now=()=>Date.parse('2026-11-14T18:00:00Z');
const where="posted_on BETWEEN '2026-10-01' AND '2026-10-31' AND expense_minor>0";
const total=`SELECT currency,SUM(expense_minor) AS cents FROM txn WHERE ${where} GROUP BY currency`;
function book(t) {
  const f=fixture(t);f.env.BRAIN_TIMEZONE='UTC';
  f.account('operating',{mode:'manual'});f.coverage('operating','2026-09-01',period.period_to);
  for(const [id,cents,payee] of [['first',50000,'Vendor one'],['second',60000,'Vendor two']])
    f.row(id,'operating',cents,{direction:'outflow',payee,category:'SOFTWARE'});
  return f;
}
async function query(f,sql,extra={}) {
  const before=f.calls.length;
  const r=await queryMoney(f.env,{sql,...period,...extra},{now});
  assert.ok(f.calls.length>before && r.rows.length,'the real SQL path returned a nonempty result');
  return r;
}
function uncertified(r) {
  assert.ok(r.confidence.percent<90,r.confidence_text);
  assert.match(r.confidence.reasons.join(' '),/query shape not certified/);
  assert.ok(r.confidence.missing.length);
  for(const key of ['score','percent'])assert.equal(r.confidence[key],r.confidence.percent);
  for(const key of ['level','band','label'])assert.notEqual(r.confidence[key],'High');
  assert.equal(r.confidence.display,`Confidence: ${r.confidence.level} (${r.confidence.percent}%)`);
}

for(const extra of [{},{measure:'posted_spending'}]) {
test(`RLL3-01: scalar extrema never certify attribution, context=${Boolean(extra.measure)}`,async t=>{
  const f=book(t);
  for(const expression of ['MIN(payee,payee)','MAX(payee,payee)','MIN(MAX(payee,payee),payee)']) {
    const r=await query(f,`SELECT ${expression} AS vendor,currency,SUM(expense_minor) AS cents,COUNT(*) AS n FROM txn WHERE ${where} GROUP BY currency`,extra);
    assert.equal(r.rows.length,1);assert.equal(r.rows[0].cents,110000);assert.equal(r.rows[0].n,2);
    assert.ok(['Vendor one','Vendor two'].includes(r.rows[0].vendor),'SQLite actually attributed the combined amount to one input vendor');
    uncertified(r);
  }
  const grouped=await query(f,`SELECT payee AS vendor,currency,SUM(expense_minor) AS cents,MIN(posted_on) AS first_on,MAX(posted_on) AS last_on FROM txn WHERE ${where} GROUP BY payee,currency ORDER BY vendor`,extra);
  assert.deepEqual(grouped.rows.map(r=>[r.vendor,r.cents]),[['Vendor one',50000],['Vendor two',60000]]);
  assert.ok(grouped.confidence.percent>=90,grouped.confidence_text);
});
test(`RLL3-01: scalar extrema never certify arithmetic, context=${Boolean(extra.measure)}`,async t=>{
  const f=book(t);
  for(const expression of ['MAX(expense_minor,0)','MIN(expense_minor,expense_minor)','MAX(MIN(expense_minor,expense_minor),0)']) {
    const r=await query(f,total.replace('SUM(expense_minor)',`SUM(expense_minor)+${expression}`),extra);
    assert.ok([160000,170000].includes(r.rows[0].cents),'the scalar actually duplicated one purchase');
    uncertified(r);
  }
  const green=await query(f,total,extra);assert.equal(green.rows[0].cents,110000);assert.ok(green.confidence.percent>=90,green.confidence_text);
});
}

test('generated SQL shapes: only explicit allow-list productions can reach High',async t=>{
  const f=book(t),cases=[];
  const accepted=[
    ['SUM(expense_minor) AS cents',''],
    ['COALESCE(SUM(expense_minor),0) AS cents',''],
    ['SUM(expense_minor) AS cents,COUNT(*) AS n',''],
    ['SUM(expense_minor) AS cents,MIN(posted_on) AS first_on,MAX(posted_on) AS last_on',''],
    ['SUM(expense_minor) AS cents,GROUP_CONCAT(DISTINCT txn_uid) AS ids',''],
    ['SUM(expense_minor) AS cents,SUM(estimated) AS uncertain_rows',''],
  ];
  const rejected=[
    'AVG(expense_minor) AS cents','TOTAL(expense_minor) AS cents',
    'SUM(expense_minor)+MAX(expense_minor,0) AS cents',
    'SUM(expense_minor)+MIN(expense_minor,expense_minor) AS cents',
    'SUM(CASE WHEN expense_minor>0 THEN expense_minor ELSE 0 END) AS cents',
    'SUM(expense_minor)+0 AS cents','SUM(expense_minor)*2 AS cents',
    'ROUND(SUM(expense_minor),0) AS cents','ABS(SUM(expense_minor)) AS cents',
    'COALESCE(AVG(expense_minor),0) AS cents','CAST(SUM(expense_minor) AS INTEGER) AS cents',
    'SUM(expense_minor) AS cents,MIN(payee,payee) AS vendor',
    'SUM(expense_minor) AS cents,MAX(payee,payee) AS vendor',
    'SUM(expense_minor) AS cents,MIN(payee) AS vendor',
    'SUM(expense_minor) AS cents,MIN(posted_on) AS vendor',
    'SUM(expense_minor) AS cents,GROUP_CONCAT(txn_uid) AS payer',
    'SUM(expense_minor) AS cents,GROUP_CONCAT(payee) AS vendor',
    'SUM(expense_minor) AS cents,LENGTH(payee) AS vendor',
    'SUM(expense_minor) AS cents,123456 AS other_minor',
    'SUM(expense_minor) AS cents,payee AS vendor',
    'SUM(expense_minor) AS cents,MAX(expense_minor) AS other_minor',
    'SUM(expense_minor) AS cents,ROW_NUMBER() OVER () AS row_number',
    'SUM(expense_minor) AS cents,(SELECT 123) AS other_minor',
  ];
  for(const prefix of ['SELECT currency,','SELECT "currency",'])for(const tail of ['', ' ORDER BY currency']) {
    for(const [projection] of accepted)cases.push({allowed:true,sql:`${prefix}${projection} FROM txn WHERE ${where} GROUP BY currency${tail}`});
    for(const projection of rejected)cases.push({allowed:false,sql:`${prefix}${projection} FROM txn WHERE ${where} GROUP BY currency${tail}`});
  }
  for(const sql of [
    `${total} UNION ALL ${total}`,
    `SELECT * FROM (${total})`,
    `WITH sums AS (${total}) SELECT * FROM sums`,
    `SELECT currency,SUM(expense_minor) AS cents FROM txn WHERE ${where} GROUP BY currency HAVING SUM(expense_minor)>0`,
    `SELECT currency,SUM(expense_minor) AS cents FROM txn WHERE ${where} GROUP BY currency ORDER BY RANDOM()`,
    `SELECT currency,SUM(expense_minor) AS cents FROM txn WHERE ${where} GROUP BY currency,payee`,
    `SELECT currency,SUM(expense_minor) AS cents FROM txn WHERE ${where} GROUP BY currency ORDER BY cents LIMIT 1`,
    `SELECT currency,SUM(expense_minor) AS cents FROM txn WHERE ${where} GROUP BY currency ORDER BY cents DESC LIMIT 1 OFFSET 0`,
  ])cases.push({allowed:false,sql});
  let highs=0,lows=0;
  for(const c of cases) {
    const r=await query(f,c.sql);
    if(c.allowed) {assert.equal(r.rows[0].cents,110000);assert.ok(r.confidence.percent>=90,`${c.sql}\n${r.confidence_text}`);highs++;}
    else {uncertified(r);lows++;}
  }
  assert.ok(highs>0 && lows>0,'uniform decisions mean the generated harness failed');
  t.diagnostic(`${cases.length} independently labelled shapes: ${highs} High controls, ${lows} below High`);
});

test('the complete statement is consumed; malformed proof inputs default to uncertified',async t=>{
  const f=book(t),checked=await validateMoneySql(total,async sql=>f.db.prepare(sql).all());
  assert.equal(certifyMoneyQuery(checked).certified,true,'a compiled allow-listed control reaches the proof');
  for(const input of [null,{}, {tokens:null},{tokens:[]},
    {tokens:checked.tokens.slice(0,-1)},
    {tokens:[...checked.tokens,{v:'unrecognised',kind:'word'}]},
    {tokens:checked.tokens.map(t=>t.v==='sum'?{...t,v:'unrecognised'}:t)},
    {tokens:checked.tokens.map(t=>t.v==='sum'?{...t,kind:'string'}:t)}]) {
    assert.equal(certifyMoneyQuery(input).certified,false,'missing, unparsed or trailing tokens supply no proof');
  }
});

test('counts and minor-unit sums require the same resolved, fully read party population',async t=>{
  const f=book(t);
  for(const projection of ['COUNT(*) AS n','COUNT(DISTINCT payee) AS n','SUM(amount_minor) AS n']) {
    const sql=`SELECT ${projection} FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31' AND direction='outflow'`;
    const expected=projection.startsWith('SUM')?110000:2;
    const green=await query(f,sql);assert.equal(green.rows[0].n,expected);assert.ok(green.confidence.percent>=90,green.confidence_text);
    const unread=await query(f,sql,{from:period.period_from,through:period.period_to});assert.equal(unread.rows[0].n,expected);
    assert.ok(unread.confidence.percent<90,unread.confidence_text);assert.match(unread.confidence_text,/earlier history was not read/);
  }
});

test('qualified and quoted columns, group aliases and operating subtotals retain High controls',async t=>{
  const f=book(t);
  for(const sql of [
    total.replaceAll('expense_minor','"expense_minor"'),
    `SELECT t.payee AS vendor,t.currency,SUM(t.expense_minor) AS cents FROM txn t WHERE t.posted_on BETWEEN '2026-10-01' AND '2026-10-31' AND t.expense_minor>0 GROUP BY vendor,t.currency ORDER BY vendor`,
    `SELECT SUM(income_minor)-SUM(expense_minor) AS net_minor FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31'`,
  ]) {
    const r=await query(f,sql);assert.ok(r.confidence.percent>=90,r.confidence_text);
    assert.equal(r.rows.reduce((n,row)=>n+(row.cents??-row.net_minor),0),110000);
  }
});

test('output aliases cannot change the contributing field whose history needs proof',async t=>{
  const f=book(t);
  const sql="SELECT SUM(amount_minor) AS paid_minor FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31' AND direction='outflow'";
  const green=await query(f,sql);assert.equal(green.rows[0].paid_minor,110000);assert.ok(green.confidence.percent>=90,green.confidence_text);
  const unread=await query(f,sql,{from:period.period_from,through:period.period_to});
  assert.equal(unread.rows[0].paid_minor,110000);assert.ok(unread.confidence.percent<90,unread.confidence_text);
  assert.match(unread.confidence_text,/earlier history was not read/);
  for(const [expression,key,expected] of [['SUM(expense_minor) AS income_minor','income_minor',110000],['SUM(income_minor) AS expense_minor','expense_minor',0]]) {
    const bad=await query(f,`SELECT ${expression} FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31'`);
    assert.equal(bad.rows[0][key],expected,'the actual mislabelled result is retained');uncertified(bad);
  }
});
