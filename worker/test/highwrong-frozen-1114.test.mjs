import { assertUnprovedDocument } from './helpers/doc-high-provenance.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { overviewFixture } from './helpers/money-overview-fixture.mjs';
import { fixture } from './helpers/clean-money-fixture.mjs';
import { createProductFixture } from './product-contract-fixture.mjs';
import { queryMoney } from '../src/lib/money-query.js';
import { overviewMoney } from '../src/lib/money-overview.js';
import { moneyGuideFor } from '../src/lib/money-query-contract.js';
import { finalizeDocumentAnswer } from '../src/lib/document-answer.js';
import { handleMcp } from '../src/lib/mcp-endpoint.js';

const NOW = Date.parse('2026-11-13T06:30:00Z');
const DOC_NOW = Date.parse('2026-11-12T19:00:00Z');
const PERIOD = { period_from:'2026-11-01', period_to:'2026-11-12', time_zone:'America/Phoenix' };
const approve = { supported:true, complete:true, evidence:[1,2,3], reason:'synthetic approval' };
const prose = body => body.answer.split('\n\nCoverage:')[0];
const scales = [
  { id:'Q27', question:'For the shop signed contract (values in thousands), what is the monthly fee?',
    title:'Signed contract values in thousands', clause:'The monthly fee is $250.', scale:'Values in thousands', oracle:'$250,000' },
  { id:'Q28', question:'For the shop signed sales contract (values in millions), what annual sales value does it state?',
    title:'Signed sales contract values in millions', clause:'The annual sales value is $2.5.', scale:'Values in millions', oracle:'$2,500,000' },
  { id:'Q29', question:'What monthly storage fee does the shop signed contract (values in hundreds) state?',
    title:'Signed storage contract values in hundreds', clause:'The monthly storage fee is $75.', scale:'Values in hundreds', oracle:'$7,500' },
];
const draftOf = c => `${c.clause.slice(0,-1)} [1][2][3].`;
const bodyOf = c => c.content ?? `${c.clause}\n${c.scale}`;
const documents = c => [1,2,3].map(n => ({ n, title:c.title, source:`records-${n}`, snippet:bodyOf(c),
  ts:'2026-11-11', date_reliable:true, text_source:'native', text_reliable:true, read_complete:true,
  authority:{tier:'T1',rank:1,eligible:true,authoritative:true},
  lineage:{status:'known',family_tokens:[`independent-${n}`]} }));
const direct = (c, draft = draftOf(c)) => {
  const docs = documents(c);
  return finalizeDocumentAnswer({question:c.question,draft,docs,approvedDocs:docs,checks:[approve],searchComplete:true});
};
function contract(body) {
  assert.ok(body.answer.trim(), 'answer remains nonempty');
  assert.match(body.answer, /Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
  assert.match(body.confidence_text, /Confidence: (High|Medium|Low) \(\d+%\).*Why:.*Missing:/s);
  assert.equal(body.answer_contract.kind, 'document');
  assert.equal(body.confidence.band, body.confidence.percent >= 90 ? 'High' : body.confidence.percent >= 70 ? 'Medium' : 'Low');
}
function diagnostic(t, id, question, path, figure, oracle, confidence) {
  t.diagnostic(JSON.stringify({id,question,path,figure,oracle,confidence}));
}
function book(t) {
  const f = fixture(t);
  f.env.BRAIN_TIMEZONE = PERIOD.time_zone;
  for (const [slug,mask,kind] of [['operating','1113','checking'],['card','2224','card']]) {
    f.account(slug,{mask,kind});
    f.coverage(slug,'2024-01-01','2026-11-12');
  }
  const add = (id,day,cents,direction,memo) => f.row(id,'operating',cents,{day,direction,memo,payee:'Synthetic supplier'});
  add('buy','2026-10-31',40100,'outflow','Supplies');
  add('return','2026-11-02',40100,'inflow','Supplies refund');
  add('next-buy','2026-11-03',10000,'outflow','Supplies');
  const query = sql => queryMoney(f.env,{sql,...PERIOD},{now:()=>NOW});
  const recipe = moneyGuideFor({now:NOW,timeZone:PERIOD.time_zone}).match(/\nProfit:[^\n]*\n([^\n]+)/)?.[1];
  assert.ok(recipe, 'the shipped Profit recipe was reached');
  return {...f,query,sql:recipe.replaceAll('2026-09-01',PERIOD.period_from).replaceAll('2026-09-30',PERIOD.period_to).replace(/;$/,'')};
}

test('A Q36: Profit counts the recognized refund on its posting date', async t => {
  const f = book(t);
  const overview = await overviewMoney(f.env,{now:()=>NOW});
  assert.equal(overview.accounts.length,2,'the money overview reached both synthetic accounts');
  const support = await f.query("SELECT txn_uid,money_kind,income_minor,expense_minor,refund_minor FROM txn ORDER BY posted_on");
  assert.equal(support.rows.length,2,'the real public selection reached the two November postings');
  assert.deepEqual(support.rows.map(r=>[r.money_kind,r.refund_minor]),[['refund',40100],['ordinary',0]]);
  const result = await f.query(f.sql);
  diagnostic(t,'Q36','After that October purchase was refunded, what was the food truck cash profit for November 1 through 12?',
    'brain_money_overview -> brain_money_guide Profit SQL -> queryMoney -> classifiedMoneyCtes',result.rows[0],{cash_profit_minor:30100},result.confidence_text);
  assert.ok(f.calls.some(sql=>sql.includes('cash_profit_minor')),'recipe execution reached SQLite');
  assert.equal(result.rows[0].cash_profit_minor,30100,'recognized recovery contributes to cash profit');
  assert.equal(result.confidence.percent,60);
  assert.equal(result.confidence.level,'Low');
});

test('A controls: gross spending, signed net spending and prior-period purchase stay distinct', async t => {
  const f = book(t);
  const bounds = " WHERE posted_on BETWEEN '2026-11-01' AND '2026-11-12'";
  const gross = await f.query('SELECT SUM(expense_minor) AS cents FROM txn'+bounds);
  const net = await f.query('SELECT SUM(expense_minor + CASE WHEN expense_minor=0 THEN interest_stated_minor ELSE 0 END - refund_minor) AS cents FROM txn'+bounds);
  assert.equal(gross.rows[0].cents,10000);
  assert.equal(net.rows[0].cents,-30100);
  assert.equal(gross.confidence.percent,60); assert.equal(net.confidence.percent,60);
  const october = await queryMoney(f.env,{sql:f.sql.replaceAll('2026-11-01','2026-10-01').replaceAll('2026-11-12','2026-10-31'),
    period_from:'2026-10-01',period_to:'2026-10-31',time_zone:PERIOD.time_zone},{now:()=>NOW});
  assert.equal(october.rows[0].cash_profit_minor,-40100,'refund stays in November');
});

// The real Worker reads complete SQLite records. Only model responses and the
// vector provider are synthetic; an approving verifier cannot set confidence.
async function route(t,c) {
  const stages = [];
  const f = await createProductFixture({env:{BRAIN_TIMEZONE:'UTC',
    ADMIN_KEY:randomBytes(24).toString('hex'),SESSION_SIGNING_KEY:randomBytes(32).toString('hex'),
    AI:{async run(model,input) {
      if(String(model).includes('bge-')) return {data:[[0.1,0.2,0.3]]};
      const verify = JSON.stringify(input.messages).includes('verify a proposed answer');
      stages.push(verify?'verifier':'draft');
      return {response:verify?approve:draftOf(c)};
    }} }});
  try {
    for(const n of [1,2,3]) f.raw(`INSERT INTO sources(name,kind,status,created_at,last_ingest_at,last_complete_sweep_at,expected_refresh_seconds)
      VALUES (?,'upload','ready',?,?,?,86400)`,`records-${n}`,new Date(DOC_NOW).toISOString(),new Date(DOC_NOW).toISOString(),new Date(DOC_NOW).toISOString());
    const headers = {'X-Admin-Key':f.env.ADMIN_KEY};
    const ingested = await f.post('/api/admin/brain/ingest/batch',{docs:[1,2,3].map(n=>({
      source_type:`records-${n}`,source_id:`record-${n}`,title:c.title,content:bodyOf(c),occurred_at:'2026-11-11T19:00:00Z',
      date_source:'fixture:recorded_at',date_reliable:true,text_source:'native',text_reliable:true,
      metadata:{evidence_lineage:{version:1,kind:'source_record'}} }))},headers);
    assert.equal(ingested.status,200);
    f.raw('DELETE FROM vector_outbox');
    const count = f.first('SELECT COUNT(*) AS n FROM chunks').n;
    f.raw("UPDATE install_state SET vector_projection_status='verified',vector_projection_bootstrap_base_count=? WHERE id=1",count);
    f.env.VECTORIZE.describe = async()=>({vectorCount:count,processedUpToMutation:null});
    f.env.VECTORIZE.query = async()=>({matches:f.rows('SELECT chunk_uid AS id FROM chunks ORDER BY document_date DESC')});
    const before = f.seen.sql.length;
    const response = await f.post('/api/rag/think',{q:c.question},headers);
    const body = await response.json();
    assert.equal(response.status,200);
    assert.equal(f.seen.sql.slice(before).filter(sql=>/ORDER BY c.chunk_ix LIMIT 501/.test(sql)).length,3,'all three complete record reads reached');
    assert.deepEqual(stages,['draft','verifier']);
    assert.equal(body.answer_contract.read_count,3);
    const url = new URL('https://fixture.invalid/mcp');
    const remote = await (await handleMcp({},new Request(url,{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,
      method:'tools/call',params:{name:'ask',arguments:{question:c.question}}})}),url,{think:async()=>body})).json();
    assert.equal(!!remote.result.isError,false);
    const remoteText = remote.result.content.map(c=>c.text||'').join('\n');
    assert.ok(remoteText.includes(prose(body)),'remote ask carries the actual Worker answer');
    assert.match(remoteText,new RegExp(`Confidence: ${body.confidence.band} \\(${body.confidence.percent}%\\)`));
    return body;
  } finally { f.close(); }
}

for(const c of scales) test(`B ${c.id}: scale context cannot disappear at High through finalizer, Worker and remote ask`, async t => {
  t.mock.method(Date,'now',()=>DOC_NOW);
  t.mock.method(globalThis,'fetch',()=>assert.fail('network forbidden'));
  const finalized = direct(c);
  const routed = await route(t,c);
  for(const [path,body] of [['finalizeDocumentAnswer',finalized],['/api/rag/think -> remote ask',routed]]) {
    diagnostic(t,c.id,c.question,path,prose(body),c.oracle,body.confidence_text);
  }
  for(const body of [finalized,routed]) {
    contract(body);
    assert.ok(body.confidence.percent<90,'unapplied scale keeps confidence below High');
    assert.match(body.confidence.basis.join(' '),new RegExp(c.scale,'i'),'reason names missing scale context');
    assert.ok(body.confidence.missing.some(s=>/heading|scale|context/i.test(s)));
  }
});

test('B matched controls: unscaled figures lack provenance; existing scale controls retain their results', async t => {
  t.mock.method(Date,'now',()=>DOC_NOW);
  t.mock.method(globalThis,'fetch',()=>assert.fail('network forbidden'));
  const c = scales[0];
  for(const [id,input,percent,rung] of [
    ['plain claim',{...c,title:'Signed contract',scale:''},89,2],
    ['neutral title heading',{...c,title:'Signed contract',scale:'Signed contract'},89,2],
    ['question without scale',{...c,question:'What monthly fee does the signed contract state?'},89,2],
    ['singular scale',{...c,title:'Signed contract values in thousand',scale:'Values in thousand'},89,1],
    ['scale sentence',{...c,title:'Service contract',question:'What capacity does the shop equipment contract state?',
      clause:'The pump capacity is 250 units.',scale:'Values are in thousands.'},89,2],
    ['case-sensitive unit',{...c,title:'Service contract',question:'What capacity does the shop equipment contract state?',
      clause:'The pump capacity is 250 mW.',scale:''},69,3],
  ]) {
    const draft = id==='case-sensitive unit'?'The pump capacity is 250 MW [1][2][3].':draftOf(input);
    const body = direct(input,draft);
    diagnostic(t,id,input.question,'finalizeDocumentAnswer control',prose(body),'unchanged control',body.confidence_text);
    contract(body); assert.equal(body.confidence.percent,percent,id); assert.equal(body.answer_contract.rung,rung,id);
    if (['plain claim','neutral title heading'].includes(id)) assertUnprovedDocument(body,input.clause);
  }
});

test('B structural rule covers unfamiliar scales and unit headings without a scale-word list', t => {
  t.mock.method(Date,'now',()=>DOC_NOW);
  for (const heading of ['Values in dozens','USD cents','Per shipment','Excluding tax']) {
    const c = {...scales[0],title:`Signed contract ${heading}`,scale:heading,
      question:`For the signed contract (${heading}), what is the monthly fee?`};
    const body = direct(c);
    contract(body);
    assert.equal(body.answer_contract.rung,1,'exact draft reached the heading confidence decision');
    assert.equal(body.confidence.percent,89,heading);
    assert.ok(body.confidence.basis.some(reason=>reason.includes(heading)),heading);
  }
  const c = scales[0];
  const carried = direct(c,`${draftOf(c)} ${c.scale} [1][2][3].`);
  contract(carried);
  assert.equal(carried.confidence.percent,89,'carrying the heading alone does not prove governing applicability');
  assertUnprovedDocument(carried,c.clause);assert.ok(prose(carried).includes(c.scale));
});


const OCT = {period_from:'2026-10-01',period_to:'2026-10-31',time_zone:'America/Phoenix'};
const MONEY_NOW = Date.parse('2026-11-13T15:00:00Z');
function octoberBook(t,mode='manual') {
  t.mock.method(Date,'now',()=>MONEY_NOW);
  const f=overviewFixture(t);
  f.env.BRAIN_TIMEZONE=OCT.time_zone;
  f.account('operating',mode);
  f.run("UPDATE fin_entities SET kind='business'");
  f.run("UPDATE fin_accounts SET mask='1111'");
  f.coverage('operating','2025-01-01','2026-11-13');
  if(mode==='live') { f.connection('operating');f.run('UPDATE bank_feed_items SET last_synced_at=?','2026-11-13T14:00:00Z'); }
  const add=(id,cents,direction,memo,category=null,day='2026-10-12',payee='Supplier')=>{
    f.row(id,'operating',day,cents,direction,{description:memo});
    f.run("UPDATE fin_transactions SET payee=?,category=?,category_basis_state='confirmed' WHERE txn_uid=?",payee,category,id);
  };
  const query=sql=>queryMoney(f.env,{sql,...OCT},{now:()=>MONEY_NOW});
  const recipe=moneyGuideFor({now:MONEY_NOW,timeZone:OCT.time_zone}).match(/\nProfit:[^\n]*\n([^\n]+)/)?.[1];
  assert.ok(recipe,'the shipped Profit recipe was reached');
  const sql=recipe.replaceAll('2026-09-01',OCT.period_from).replaceAll('2026-09-30',OCT.period_to);
  return {...f,add,query,sql};
}
for(const [id,rows,expected] of [
  ['X1123 Q19',[[112300,'inflow','STRIPE PAYOUT'],[112300,'outflow','STOCK PURCHASE'],[20000,'inflow','MERCHANT REFUND']],20000],
  ['X1123 Q21',[[112300,'inflow','STRIPE PAYOUT'],[20000,'outflow','CUSTOMER REFUND','REFUND'],[12300,'outflow','STOCK PURCHASE']],80000],
]) test(`${id}: Profit uses recognized signed contributions`,async t=>{
  const f=octoberBook(t);rows.forEach((row,i)=>f.add(`row-${i}`,...row));
  const support=await f.query('SELECT txn_uid,refund_minor,sales_adjust_minor,estimated FROM txn ORDER BY id');
  assert.equal(support.rows.length,3,'all real classified postings were reached');
  assert.ok(support.rows.some(r=>r.refund_minor || r.sales_adjust_minor),'recognized contribution reached the consumer');
  assert.ok(support.rows.every(r=>r.estimated===0),'ordinary receipts and proved returns retain their face-value type');
  const result=await f.query(f.sql);
  diagnostic(t,id,'October business cash profit','guide Profit -> queryMoney',result.rows[0],{cash_profit_minor:expected},result.confidence_text);
  assert.equal(result.rows[0].cash_profit_minor,expected);
  assertCertificateEstimate(result,112300);
});
test('X1123 Q20 control: net cash spending retains the earlier deposit recovery',async t=>{
  const f=octoberBook(t);f.add('buy',112300,'outflow','STOCK PURCHASE');f.add('recovery',100000,'inflow','SECURITY DEPOSIT RETURNED');
  const result=await f.query("SELECT SUM(expense_minor-refund_minor) AS n FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31'");
  diagnostic(t,'X1123 Q20','October net cash spending including deposit recovery','queryMoney',result.rows[0],{n:12300},result.confidence_text);
  assert.equal(result.rows[0].n,12300);
  // The cash control is unchanged; its operating membership now has an
  // explicit deposit-ledger gap instead of inheriting merchant-refund certainty.
  assert.equal(result.confidence.percent,65);assert.match(result.confidence_text,/\$1,000\.00/);
});
for(const direction of ['supplier','customer']) for(const amount of [0,20000,112300])
  test(`Profit control: ${direction} adjustment ${amount} retains signs and no-return baseline`,async t=>{
    const f=octoberBook(t);f.add('sales',112300,'inflow','STRIPE PAYOUT');f.add('stock',12300,'outflow','STOCK PURCHASE');
    if(amount)f.add('adjustment',amount,direction==='supplier'?'inflow':'outflow',direction==='supplier'?'MERCHANT REFUND':'CUSTOMER REFUND','REFUND','2026-10-14');
    const result=await f.query(f.sql);
    assert.equal(result.rows[0].cash_profit_minor,100000+(direction==='supplier'?amount:-amount));
    assertCertificateEstimate(result,112300);
  });

const rejected={id:'X1123 Q28',question:'What is the actual October processor fee? I found a rejected example contract.',
  title:'Rejected example contract',clause:'The fee is $1,123.',scale:''};
const reportedScale={id:'X1123 Q27',question:'What October sales do the shop reports state, in thousands of dollars?',
  title:'Shop report thousands of dollars',clause:'October sales were $1,123.',scale:'Thousands of dollars.',content:'Thousands of dollars. October sales were $1,123.'};
for(const c of [reportedScale,rejected]) test(`${c.id}: question wording never certifies omitted source qualifications at High`,async t=>{
  t.mock.method(Date,'now',()=>DOC_NOW);t.mock.method(globalThis,'fetch',()=>assert.fail('network forbidden'));
  const final=direct(c),routed=await route(t,c);
  for(const [path,body] of [['finalizeDocumentAnswer',final],['Worker -> remote ask',routed]])
    diagnostic(t,c.id,c.question,path,prose(body),'source qualification must accompany figure',body.confidence_text);
  for(const body of [final,routed]) {
    contract(body);assert.ok(body.confidence.percent<90);
    if(c===rejected) {assert.match(prose(body),/Rejected example contract/);assert.equal(body.answer_contract.rung,2);}
  }
});
test('Title controls: title and exact figures retain attribution without proved provenance',t=>{
  t.mock.method(Date,'now',()=>DOC_NOW);
  for(const qualifier of ['Illustrative','Archived','Rejected example']) {
    const c={...rejected,title:`${qualifier} contract`,question:`What is the actual fee? I found the ${qualifier} contract.`};
    const body=direct(c);contract(body);assert.equal(body.answer_contract.read_count,3);
    assert.ok(body.confidence.percent<90);assert.ok(prose(body).includes(c.title));
  }
  const plain=direct({...rejected,title:'Signed contract'});assert.equal(plain.confidence.percent,89);assertUnprovedDocument(plain,rejected.clause);
  const conditional=direct({...rejected,title:'Shop report',clause:'The fee is $1,123 if sales exceed $50,000.'},draftOf(rejected));
  assert.equal(conditional.confidence.percent,69);assert.match(prose(conditional),/if sales exceed/);
});

const entrusted=[
  {id:'X1119 Q04',cents:240000,inMemo:'REFUNDABLE TENANT SECURITY DEPOSIT',outMemo:'SECURITY DEPOSIT RETURNED TO TENANT',category:'TENANT_DEPOSIT_LIABILITY',payee:'Tenant'},
  {id:'X1119 Q05',cents:900000,inMemo:'TENANT RENT HELD FOR PROPERTY OWNER',outMemo:'TRUST RENT REMITTANCE TO PROPERTY OWNER',category:'CLIENT_FUNDS_REMITTANCE',inCategory:'CLIENT_FUNDS',payee:'Property owner'},
];
for(const mode of ['manual','live']) for(const c of entrusted)
  test(`${c.id}/${mode}: third-party liability signals retain cash but cannot certify operating expense`,async t=>{
    const f=octoberBook(t,mode);
    f.add('origin',c.cents,'inflow',c.inMemo,c.inCategory||c.category,'2025-09-03','Tenant');
    f.add('settlement',c.cents,'outflow',c.outMemo,c.category,'2026-10-09',c.payee);
    const rows=await f.query('SELECT txn_uid,money_kind,expense_minor,estimated,estimate_reason FROM txn');
    assert.equal(rows.rows.length,1);assert.equal(rows.rows[0].txn_uid,'settlement','the expense decision was reached');
    const result=await f.query("SELECT COALESCE(SUM(expense_minor),0) AS n FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31'");
    const overview=await overviewMoney(f.env,{now:()=>MONEY_NOW});
    diagnostic(t,c.id,`October expenses excluding third-party settlement (${mode})`,'queryMoney',
      {figure:result.rows[0],membership:rows.rows[0],overview:overview.confidence.percent,overview_reasons:overview.confidence.reasons},'operating expense unproved; cash debit retained',result.confidence_text);
    assert.equal(result.rows[0].n,c.cents,'do not erase an observed cash debit without payable reconciliation');
    assert.ok(result.confidence.percent<90,'unproved expense membership stays below High');
    assert.match(result.confidence_text,/third.party|entrusted|beneficiary|payable/i);
    const gross=await f.query('SELECT SUM(amount_minor) AS n FROM txn');assert.equal(gross.rows[0].n,c.cents);
  });
test('Third-party controls: ordinary rent and merchant identity alone retain certain spending',async t=>{
  const f=octoberBook(t);f.add('rent',240000,'outflow','OFFICE RENT','RENT','2026-10-09','Trust supplier');
  const result=await f.query("SELECT SUM(expense_minor) AS n FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31'");
  assert.equal(result.rows[0].n,240000);assert.equal(result.confidence.percent,95);
});


test('Profit composition: loan memo interest is not added twice and signed estimated sales stay visible',async t=>{
  const f=octoberBook(t);
  f.add('payment',100000,'outflow','LOAN PAYMENT PRINCIPAL 900 INTEREST 100');
  const result=await f.query(f.sql);
  assert.equal(result.rows[0].expense_minor,100000,'memo interest is already inside the full counted debit');
  assert.equal(result.rows[0].cash_profit_minor,-100000);
  assert.equal(result.rows[0].likely_expense_minor,100000);
});
test('Profit composition: separately excluded loan interest, tax recovery and refund reversals use contribution signs',async t=>{
  const f=octoberBook(t);f.add('sales',112300,'inflow','STRIPE PAYOUT');f.add('stock',12300,'outflow','STOCK PURCHASE');
  f.add('refund',20000,'inflow','MERCHANT REFUND');f.add('reversal',5000,'outflow','PROVISIONAL CREDIT REVERSAL');
  f.add('tax',3000,'inflow','IRS TREAS 310 TAX REF');
  f.account('debt','manual','card');f.run("UPDATE fin_accounts SET account_kind='loan',mask='2222' WHERE account_slug='debt'");f.coverage('debt','2025-01-01','2026-11-13');
  f.row('interest','debt','2026-10-14',1000,'inflow',{description:'INTEREST PAYMENT'});
  const interest=await f.query("SELECT money_kind,expense_minor,interest_stated_minor FROM txn WHERE txn_uid='interest'");
  assert.equal(interest.rows[0].money_kind,'loan_interest');assert.equal(interest.rows[0].expense_minor,0);
  assert.equal(interest.rows[0].interest_stated_minor,1000);
  const result=await f.query(f.sql);
  assert.equal(result.rows[0].cash_profit_minor,114000,'refund reversal subtracts; government recovery is not a spending offset');
});
test('Profit likely columns include signed estimated customer returns',async t=>{
  const f=octoberBook(t);f.add('sales',112300,'inflow','STRIPE PAYOUT');f.add('return',20000,'outflow','CUSTOMER REFUND');
  const support=await f.query('SELECT estimated,sales_adjust_minor FROM txn ORDER BY id');
  assert.equal(support.rows[1].sales_adjust_minor,-20000);assert.equal(support.rows[1].estimated,1);
  const result=await f.query(f.sql);assert.equal(result.rows[0].cash_profit_minor,92300);assert.equal(result.rows[0].likely_income_minor,-20000);
});


// Independent economics: a refundable asset recovery is cash, not an
// operating refund. Bank wording alone cannot prove the original ledger basis.
test('X1123 N1 paired Profit: keep Q20 cash, disclose the disputed principal below High',async t=>{
  const f=octoberBook(t);f.add('buy',112300,'outflow','STOCK PURCHASE');
  f.add('recovery',100000,'inflow','SECURITY DEPOSIT RETURNED');
  const membership=await f.query("SELECT * FROM txn WHERE txn_uid='recovery'");
  assert.equal(membership.rows.length,1,'the deposit classification decision was reached');
  const result=await f.query(f.sql);
  diagnostic(t,'X1123 N1 paired Profit','October operating profit','guide Profit -> queryMoney',result.rows[0],
    {operating_profit_minor:-112300,disputed_principal_minor:100000},result.confidence_text);
  assert.equal(result.rows[0].cash_profit_minor,-12300,'retain the provisional cash reading');
  assert.ok(result.confidence.percent<90,'the bank-only reading cannot certify principal as operating recovery');
  assert.match(result.confidence_text,/\$1,000\.00/);
  assert.match(result.confidence_text,/refundable|principal/i);
  assert.match(result.confidence_text,/original.*(?:posting|ledger)|deposit ledger/i);
});

for(const c of [
  {id:'X1127 Q04',old:[200000,'outflow','OFFICE SECURITY DEPOSIT',null,'2026-01-10'],
    rows:[[80000,'outflow','OFFICE SUPPLIES'],[200000,'inflow','SECURITY DEPOSIT RETURNED']],figure:-120000,truth:80000,disputed:200000},
  {id:'X1127 Q05',old:[200000,'inflow','TENANT SECURITY DEPOSIT',null,'2026-01-10'],
    rows:[[200000,'outflow','TENANT SECURITY DEPOSIT RETURNED']],figure:200000,truth:0,disputed:200000},
  {id:'X1143 Q02',rows:[[350000,'outflow','Refundable security deposit for office lease','Refundable security deposit asset','2026-10-08']],figure:350000,truth:0,disputed:350000,gross:true},
  {id:'X1143 Q03',old:[250000,'outflow','REFUNDABLE OFFICE SECURITY DEPOSIT',null,'2025-10-08'],
    rows:[[40000,'outflow','PLUMBING'],[250000,'inflow','Security deposit returned']],figure:-210000,truth:40000,disputed:250000},
  {id:'X1143 Q04',rows:[[240000,'outflow','Security deposit returned to tenant','Tenant deposit liability principal','2026-10-08']],figure:240000,truth:0,disputed:240000,gross:true},
  // Category-only and unfamiliar deposit purposes prevent a single phrase fix.
  {id:'category-only principal',rows:[[71000,'outflow','BANK DEBIT','REFUNDABLE PERFORMANCE DEPOSIT ASSET']],figure:71000,truth:0,disputed:71000,gross:true},
  {id:'refundable equipment placement',rows:[[83000,'outflow','REFUNDABLE EQUIPMENT DEPOSIT']],figure:83000,truth:0,disputed:83000,gross:true},
]) for(const mode of ['manual','live']) test(`${c.id}/${mode}: refundable principal keeps its cash figure with exact operating-membership doubt`,async t=>{
  const f=octoberBook(t,mode);if(c.old)f.add('old',...c.old);c.rows.forEach((r,i)=>f.add(`current-${i}`,...r));
  const support=await f.query('SELECT * FROM txn ORDER BY id');
  assert.equal(support.rows.length,c.rows.length,'all selected classification decisions were reached');
  const expr=c.gross?'expense_minor':'expense_minor + CASE WHEN expense_minor=0 THEN interest_stated_minor ELSE 0 END-refund_minor';
  const result=await f.query(`SELECT SUM(${expr}) AS n FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31'`);
  diagnostic(t,c.id,'October operating spending excluding refundable principal','queryMoney',result.rows[0],
    {operating_spending_minor:c.truth,disputed_principal_minor:c.disputed},result.confidence_text);
  assert.equal(result.rows[0].n,c.figure);
  assert.ok(result.confidence.percent<90);
  const dollars=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(c.disputed/100);
  assert.ok(result.confidence_text.includes(dollars),'the owner sees the exact disputed dollars');
  assert.match(result.confidence_text,/deposit|principal|beneficiary|payable/i);
  const profit=await f.query(f.sql);assert.ok(profit.confidence.percent<90);
});
test('principal controls: a merchant refund and ordinary office rent remain certain',async t=>{
  const f=octoberBook(t);f.add('buy',112300,'outflow','OFFICE RENT');f.add('refund',20000,'inflow','MERCHANT REFUND');
  const result=await f.query(f.sql);
  assert.equal(result.rows[0].cash_profit_minor,-92300);assert.equal(result.confidence.percent,95);
});

function lenderBook(t,{directed=false,memo='LOAN PAYMENT',extra=false}={}){
  const f=octoberBook(t);f.account('debt','manual','card');
  f.run("UPDATE fin_accounts SET account_kind='loan',mask='2222',label='Recorded lender',institution='Recorded lender' WHERE account_slug='debt'");
  f.coverage('debt','2025-01-01','2026-11-13');
  f.add('bank-payment',125000,'outflow',directed?'PAYMENT TO LOAN 2222':memo,null,'2026-10-12','Recorded lender');
  f.row('principal','debt','2026-10-12',90000,'inflow',{description:'PRINCIPAL PAYMENT'});
  f.row('interest','debt','2026-10-12',35000,'inflow',{description:'INTEREST PAYMENT'});
  if(extra)f.row('separate-interest','debt','2026-10-20',7000,'inflow',{description:'INTEREST PAYMENT'});
  return f;
}
for(const memo of ['LOAN PAYMENT','LOAN PAYMENT PRINCIPAL 900 INTEREST 350'])
  test(`B2 interest combined control: ${memo} plus lender components counts one provisional payment`,async t=>{
    const f=lenderBook(t,{memo});
    const support=await f.query('SELECT * FROM txn ORDER BY id');
    assert.equal(support.rows.length,3,'the debit and both lender component decisions were reached');
    assert.equal(support.rows[0].expense_minor,125000);assert.equal(support.rows[2].interest_stated_minor,35000);
    const result=await f.query(f.sql);
    diagnostic(t,'B2-INTEREST-01',memo,'guide Profit -> queryMoney',result.rows[0],
      {provisional_spending_minor:125000,reconciled_interest_minor:35000,possible_overlap_minor:35000},result.confidence_text);
    assert.equal(result.rows[0].cash_profit_minor,-125000);
    assert.ok(result.confidence.percent<90);assert.match(result.confidence_text,/\$350\.00/);
    assert.match(result.confidence_text,/overlap|already.*(?:debit|payment)|same payment/i);
    assert.match(result.confidence_text,/lender statement/i);
  });
test('B2 interest control: a separate payment stays counted beside the combined bank/lender group',async t=>{
  const f=lenderBook(t,{extra:true});const result=await f.query(f.sql);
  diagnostic(t,'B2 separate interest','October profit with separate interest','guide Profit -> queryMoney',result.rows[0],
    {provisional_spending_minor:132000},result.confidence_text);
  assert.equal(result.rows[0].cash_profit_minor,-132000);
});
test('B2 interest control: proved directed payment counts only lender interest',async t=>{
  const f=lenderBook(t,{directed:true});const support=await f.query('SELECT * FROM txn ORDER BY id');
  assert.equal(support.rows.length,3);assert.equal(support.rows[0].expense_minor,0,'directed repayment proof reached');
  const result=await f.query(f.sql);assert.equal(result.rows[0].cash_profit_minor,-35000);
});


test('interest identity control: equal components at a different lender remain separate',async t=>{
  const f=lenderBook(t);f.run("UPDATE fin_accounts SET institution='Other lender',label='Other lender' WHERE account_slug='debt'");
  const rows=await f.query('SELECT * FROM txn ORDER BY id');assert.equal(rows.rows.length,3);
  const result=await f.query(f.sql);assert.equal(result.rows[0].cash_profit_minor,-160000);
  assert.ok(result.confidence.percent<90,'unproved full debit stays provisional; no false identity match');
});
test('interest date control: reconciliation precedes the posting-period filter',async t=>{
  const f=lenderBook(t);f.run("UPDATE fin_transactions SET posted_on='2026-09-30' WHERE txn_uid='bank-payment'");
  f.run("UPDATE fin_transactions SET posted_on='2026-10-02' WHERE account_slug='debt'");
  const support=await f.query('SELECT * FROM txn ORDER BY id');assert.equal(support.rows.length,2,'October lender rows were reached');
  const result=await f.query(f.sql);assert.equal(result.rows[0].cash_profit_minor,0,'September provisional cash is not spent again in October');
  assert.ok(result.confidence.percent<90);assert.match(result.confidence_text,/\$350\.00/);
});


test('principal disclosure control: placed and returned dollars are both named in one period',async t=>{
 const f=octoberBook(t);f.add('placed',350000,'outflow','REFUNDABLE OFFICE DEPOSIT');
 f.add('returned',200000,'inflow','SECURITY DEPOSIT RETURNED');
 const support=await f.query('SELECT * FROM txn ORDER BY id');assert.equal(support.rows.length,2);
 const result=await f.query(f.sql);assert.equal(result.rows[0].cash_profit_minor,-150000);
 assert.ok(result.confidence.percent<90);assert.match(result.confidence_text,/\$3,500\.00/);assert.match(result.confidence_text,/\$2,000\.00/);
 const gap=result.confidence.gaps.find(g=>g.code==='estimated_membership');
 assert.ok(gap,'the rendered movement disclosure decision was reached');
 assert.match(gap.why,/\$3,500\.00/);assert.match(gap.why,/\$2,000\.00/);
});

// Independent lifecycle truth: a fully returned $350 interest payment costs
// zero. Until signed allocation is reconciled, retain the observed figure and
// dispute exactly $350 below High, including when only the return is in scope.
function returnedInterestBook(t,{returned=true,amount=35000,originalDay='2026-10-12',returnDay='2026-10-14',extra=false,ambiguous=false}={}) {
  t.mock.method(Date,'now',()=>MONEY_NOW);
  const f=overviewFixture(t);f.env.BRAIN_TIMEZONE=OCT.time_zone;
  f.run("UPDATE fin_entities SET kind='business'");
  f.account('debt','manual','card');f.run("UPDATE fin_accounts SET account_kind='loan',mask='2222' WHERE account_slug='debt'");
  f.coverage('debt','2025-01-01','2026-11-13');
  f.row('interest','debt',originalDay,35000,'inflow',{description:'INTEREST PAYMENT'});
  if(ambiguous)f.row('other-original','debt',originalDay,35000,'inflow',{description:'INTEREST PAYMENT'});
  if(returned)f.row('return','debt',returnDay,amount,'outflow',{description:'RETURNED PAYMENT'});
  if(extra)f.row('separate-interest','debt','2026-10-20',7000,'inflow',{description:'INTEREST PAYMENT'});
  const recipe=moneyGuideFor({now:MONEY_NOW,timeZone:OCT.time_zone}).match(/\nProfit:[^\n]*\n([^\n]+)/)?.[1];
  assert.ok(recipe,'the shipped Profit decision was reached');
  const sql=recipe.replaceAll('2026-09-01',OCT.period_from).replaceAll('2026-09-30',OCT.period_to);
  return {...f,sql,query:sql=>queryMoney(f.env,{sql,...OCT},{now:()=>MONEY_NOW})};
}
for(const extra of [false,true]) test(`B4 returned interest/${extra?'separate payment':'review trace'}: retain figure with exact contribution dispute below High`,async t=>{
  const f=returnedInterestBook(t,{extra});
  const support=await f.query('SELECT * FROM txn ORDER BY id');
  assert.equal(support.rows.length,extra?3:2,'all lifecycle postings reached real classification');
  assert.deepEqual(support.rows.slice(0,2).map(r=>[r.money_kind,r.interest_expense_minor,r.estimated]),
    [['loan_interest',35000,0],['payment_reversal',0,0]]);
  assert.equal(support.rows[1].paid_basis,'reversal','the unique-original reversal branch was reached');
  const result=await f.query(f.sql);
  diagnostic(t,'B2-INTEREST-01 returned interest','October business cash-basis net profit','guide Profit -> queryMoney',
    result.rows[0],{cash_profit_minor:extra?-7000:0,disputed_interest_minor:35000},result.confidence_text);
  assert.ok(f.calls.some(sql=>sql.includes('cash_profit_minor')),'the real Profit recipe executed in SQLite');
  assert.equal(result.rows[0].cash_profit_minor,extra?-42000:-35000,'retain the provisional figure');
  assert.equal(result.confidence.percent,89);
  assert.match(result.confidence_text,/Confidence: Medium \(89%\)/);
  assert.match(result.confidence_text,/\$350\.00.*interest|interest.*\$350\.00/is);
  assert.match(result.confidence_text,/Missing:.*(?:statement|reconcil).*original.*(?:return|revers)/is);
});
for(const extra of [false,true]) test(`B4 no-return green control/${extra?'separate payment':'single payment'}: actual interest stays High`,async t=>{
  const f=returnedInterestBook(t,{returned:false,extra});
  const support=await f.query('SELECT * FROM txn ORDER BY id');
  assert.equal(support.rows.length,extra?2:1);
  assert.ok(support.rows.every(r=>r.money_kind==='loan_interest' && r.interest_expense_minor>0),'the interest decisions were reached');
  const result=await f.query(f.sql);
  assert.equal(result.rows[0].cash_profit_minor,extra?-42000:-35000);
  assert.equal(result.confidence.percent,95,'the cap cannot lower every arm indiscriminately');
});
test('B4 cross-period return: original outside the selection still disputes the missing signed contribution',async t=>{
  const f=returnedInterestBook(t,{originalDay:'2026-09-29',returnDay:'2026-10-01'});
  const support=await f.query('SELECT * FROM txn');
  assert.equal(support.rows.length,1,'only the return posts in October');
  assert.equal(support.rows[0].paid_basis,'reversal','the September original was matched before filtering');
  const result=await f.query(f.sql);
  diagnostic(t,'B4 cross-period','October profit after September interest returned','guide Profit -> queryMoney',
    result.rows[0],{cash_profit_minor:35000},result.confidence_text);
  assert.equal(result.rows[0].cash_profit_minor,0,'retain the available October figure');
  assert.equal(result.confidence.percent,89);
  assert.match(result.confidence_text,/\$350\.00/);
  assert.match(result.confidence_text,/2026-09-29.*2026-10-01/s);
});
for(const c of [{name:'partial',amount:17500},{name:'ambiguous',ambiguous:true}])
  test(`B4 ${c.name} return control: an unallocated return remains answered below High`,async t=>{
    const f=returnedInterestBook(t,c);const support=await f.query('SELECT * FROM txn ORDER BY id');
    const returned=support.rows.find(r=>r.txn_uid==='return');
    assert.ok(returned,'the return classification decision was reached');
    assert.equal(returned.money_kind,'payment_reversal');
    assert.equal(returned.estimate_reason,'payment_reversal_original_missing','the non-unique allocation decision was reached');
    const result=await f.query(f.sql);
    assert.equal(result.rows[0].cash_profit_minor,c.ambiguous?-70000:-35000);
    assert.ok(result.confidence.percent<90);
    assert.match(result.confidence_text,/Missing:/);
  });
for(const c of [
  {name:'refund',direction:'inflow',field:'refund_minor',signed:35000,figure:35000},
  {name:'sales adjustment',direction:'outflow',field:'sales_adjust_minor',signed:-35000,figure:-35000},
]) test(`B4 structural ${c.name}: a recognized return cannot certify an unnegated signed component`,async t=>{
  const f=returnedInterestBook(t);
  f.run("UPDATE fin_transactions SET description='PAYMENT CUSTOMER REFUND',category='REFUND',category_basis_state='confirmed',direction=? WHERE txn_uid='interest'",c.direction);
  f.run("UPDATE fin_transactions SET direction=? WHERE txn_uid='return'",c.direction==='inflow'?'outflow':'inflow');
  const support=await f.query('SELECT * FROM txn ORDER BY id');
  assert.equal(support.rows.length,2);
  assert.equal(support.rows[0][c.field],c.signed,'the non-interest signed contribution was reached');
  assert.equal(support.rows[1].paid_basis,'reversal','the same unique-original decision was reached');
  assert.equal(support.rows[1][c.field],0,'the return omitted this component');
  const result=await f.query(f.sql);
  diagnostic(t,`B4 ${c.name}`,'October profit after returned component','guide Profit -> queryMoney',
    result.rows[0],{cash_profit_minor:0,disputed_minor:35000},result.confidence_text);
  assert.equal(result.rows[0].cash_profit_minor,c.figure);
  assert.equal(result.confidence.percent,89);
  assert.match(result.confidence_text,/\$350\.00/);
  assert.ok(result.confidence.reasons.some(r=>r.includes('disputed signed contributions') && r.includes(c.name)),
    'the structural component ceiling, rather than an unrelated gap, was reached');
});
test('B4 principal/payment green control: a fully negated returned repayment stays High',async t=>{
  const f=returnedInterestBook(t);f.run("UPDATE fin_transactions SET description='PRINCIPAL PAYMENT' WHERE txn_uid='interest'");
  const support=await f.query('SELECT * FROM txn ORDER BY id');
  assert.equal(support.rows.length,2);
  assert.deepEqual(support.rows.map(r=>[r.money_kind,r.paid_minor,r.credited_minor]),
    [['loan_payment',35000,35000],['payment_reversal',-35000,-35000]],'both principal/payment contributions were negated');
  const result=await f.query(f.sql);
  assert.equal(result.rows[0].cash_profit_minor,0);assert.equal(result.confidence.percent,95);
});

// The finder receipts are independent economic oracles. These cases use the
// real classified SQLite path, with separate controls for each decision.
const C2_SPENDING='expense_minor + CASE WHEN expense_minor=0 THEN interest_stated_minor ELSE 0 END - refund_minor';
const c2Total=expression=>`SELECT COALESCE(SUM(${expression}),0) AS n FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31'`;
function c2Book(t,{live=false,kind='card'}={}) {
  const f=octoberBook(t,live?'live':'manual');
  for(const [slug,mask,accountKind] of [['reserve','2222',kind],['personal','3333','checking']]) {
    f.account(slug,live?'live':'manual',accountKind);f.coverage(slug,'2026-09-01','2026-11-14');
    f.run('UPDATE fin_accounts SET mask=? WHERE account_slug=?',mask,slug);
    if(live) { f.connection(slug);f.run('UPDATE bank_feed_items SET last_synced_at=?','2026-11-13T14:00:00Z'); }
  }
  const post=(id,account,amount,direction,memo,day='2026-10-12')=>f.row(id,account,day,amount,direction,{description:memo});
  return {...f,post};
}
for(const [id,expression,figure,truth] of [
  ['Q19','income_minor',1497500,1200000],['Q20','expense_minor',500000,202500],
]) test(`C2 X1124 ${id}: unsplit transfer fee retains figure with explicit principal/fee doubt at Low`,async t=>{
  const f=c2Book(t,{kind:'savings'});
  f.add('sales',1200000,'inflow','Invoice INV-A consulting payment','INCOME','2026-10-03','Synthetic customer');
  f.add('rent',200000,'outflow','Office rent','RENT','2026-10-05','Synthetic landlord');
  f.post('move-out','operating',300000,'outflow','Transfer to 2222 including $25 fee');
  f.post('move-in','reserve',297500,'inflow','Transfer from 1111 net of $25 fee');
  const support=await f.query('SELECT txn_uid,expense_minor,income_minor,estimated,estimate_reason FROM txn ORDER BY id');
  assert.equal(support.rows.length,4,'both ordinary and movement classification decisions were reached');
  assert.equal(support.rows[2].estimate_reason,'fee_wording_with_payment_or_transfer_counted');
  assert.equal(support.rows[3].income_minor,297500,'the unequal receipt is actually counted');
  const result=await f.query(c2Total(expression));
  diagnostic(t,`X1124 ${id}`,id==='Q19'?'What was income when the reserve move cost $25 deducted before arrival?':
    'What was spending when the reserve move cost $25 deducted before arrival?',
    'queryMoney -> clean classification -> SQLite',result.rows[0],{n:truth},result.confidence_text);
  assert.equal(result.rows[0].n,figure,'no memo-derived fee split is invented');
  assert.ok(result.confidence.percent<=65,'unreconciled principal/fee split is Low');
  assert.ok(result.confidence.gaps.some(g=>g.code==='movement_fee_unsplit'),'the split-specific decision was reached');
  assert.match(result.confidence_text,/principal.*fee|fee.*principal/i);
  assert.match(result.confidence_text,/Missing:.*(?:confirmation|statement).*split/is);
  assert.match(result.confidence_text,/\$3,000\.00/);
});
test('C2 transfer fee green control: separate fee and proved equal principal retain their figure and High',async t=>{
  const f=c2Book(t,{kind:'savings'});f.add('sales',1200000,'inflow','Invoice payment','INCOME');f.add('rent',200000,'outflow','Office rent','RENT');
  f.post('move-out','operating',300000,'outflow','Transfer to 2222');f.post('move-in','reserve',300000,'inflow','Transfer from 1111');
  f.add('fee',2500,'outflow','Bank transfer fee','BANK_FEES');
  const support=await f.query('SELECT money_kind,estimated FROM txn ORDER BY id');
  assert.equal(support.rows.filter(r=>r.money_kind==='own_transfer').length,2,'both equal movement decisions were reached');
  for(const [expression,truth] of [['income_minor',1200000],['expense_minor',202500]]) {
    const result=await f.query(c2Total(expression));assert.equal(result.rows[0].n,truth);assert.equal(result.confidence.percent,95);
  }
});
for(const fee of [0,1500]) test(`C2 X1120 ${fee?'Q21':'Q20'}: a closed card cash advance is borrowed principal, separate fee stays spending`,async t=>{
  const f=c2Book(t,{live:true});f.post('advance','reserve',30000,'outflow','ATM cash advance');
  if(fee)f.post('fee','reserve',fee,'outflow','Cash advance fee');
  const support=await f.query('SELECT txn_uid,money_kind,expense_minor,estimated,estimate_reason FROM txn ORDER BY id');
  assert.equal(support.rows.length,fee?2:1,'advance and fee decisions were reached');
  const result=await f.query(c2Total(C2_SPENDING));
  diagnostic(t,`X1120 ${fee?'Q21':'Q20'}`,fee?'What was the cost of a $300 cash advance with a separate $15 fee?':
    'We withdrew $300 cash on the business card. Is that $300 of spending?',
    'queryMoney -> cleanMoneyMovementReading -> SQLite',result.rows[0],{n:fee},result.confidence_text);
  assert.equal(result.rows[0].n,fee);
  assert.equal(support.rows[0].money_kind,'loan_proceeds');assert.equal(support.rows[0].estimated,1);
  assert.equal(support.rows[0].expense_minor,0);assert.equal(support.rows[0].estimate_reason,'cash_advance_use_unrecorded');
  assert.ok(result.confidence.percent<90,'unknown cash use remains disclosed below High');
  assert.match(result.confidence_text,/\$300\.00/);assert.match(result.confidence_text,/cash.*use|use.*cash/i);
  assert.match(result.confidence_text,/Missing:.*(?:cash ledger|cash receipts)/is);
  if(fee)assert.equal(support.rows[1].expense_minor,fee,'the explicit fee is a real expense');
});
test('C2 cash advance controls: a bank cash debit, merchant label and confirmed expense category retain spending',async t=>{
  const f=c2Book(t,{live:true});
  f.post('bank','operating',30000,'outflow','ATM cash advance');
  f.post('merchant','reserve',1700,'outflow','Cash advance supplies');
  f.post('expense','reserve',2300,'outflow','Cash advance');
  f.run("UPDATE fin_transactions SET category='OFFICE_SUPPLIES',category_basis_state='confirmed' WHERE txn_uid='expense'");
  const support=await f.query('SELECT txn_uid,money_kind,expense_minor FROM txn ORDER BY id');
  assert.equal(support.rows.length,3);assert.ok(support.rows.every(r=>r.expense_minor>0),'all three expense decisions were reached');
  const result=await f.query(c2Total(C2_SPENDING));assert.equal(result.rows[0].n,34000);
});
test('C2 cash advance controls: outside payee, unconfirmed source and unsplit fee cannot exclude principal',async t=>{
  const f=c2Book(t,{live:true});
  for(const id of ['outside','unconfirmed','combined'])f.post(id,'reserve',30000,'outflow',id==='combined'?'Cash advance including $15 fee':'ATM cash advance');
  f.run("UPDATE fin_transactions SET payee='Synthetic merchant' WHERE txn_uid='outside'");
  f.run("UPDATE fin_transactions SET basis_state='proposed' WHERE txn_uid='unconfirmed'");
  const support=await f.query('SELECT txn_uid,money_kind,expense_minor FROM txn ORDER BY id');
  assert.equal(support.rows.length,3,'all contradictory source decisions were reached');
  assert.ok(support.rows.every(r=>r.expense_minor===30000),'none acquires a new principal exclusion');
  const result=await f.query(c2Total(C2_SPENDING));assert.equal(result.rows[0].n,90000);
});
test('C2 X1120 Q27 stated limit: unproved purchase-offer credit is retained below High pending the receipt',async t=>{
  const f=c2Book(t,{live:true});f.post('purchase','reserve',10000,'outflow','Design software');
  f.post('credit','reserve',3000,'inflow','Statement credit software offer','2026-10-15');
  const support=await f.query('SELECT money_kind,refund_minor,estimated,estimate_reason FROM txn ORDER BY id');
  assert.equal(support.rows.length,2);assert.equal(support.rows[1].money_kind,'liability_credit');
  assert.equal(support.rows[1].estimate_reason,'liability_credit_without_repayment_evidence','the unresolved credit decision was reached');
  const result=await f.query(c2Total(C2_SPENDING));
  diagnostic(t,'X1120 Q27','The issuer gave a $30 statement credit for a software purchase. What is net spending?',
    'queryMoney -> liability credit -> SQLite',result.rows[0],{n:7000},result.confidence_text);
  assert.equal(result.rows[0].n,10000);assert.ok(result.confidence.percent<90);assert.match(result.confidence_text,/\$30\.00/);
});
test('C2 purchase rebate green control: explicit merchant refund remains a signed spending offset',async t=>{
  const f=c2Book(t,{live:true});f.post('purchase','reserve',10000,'outflow','Design software');
  f.post('refund','reserve',3000,'inflow','Merchant refund','2026-10-15');
  const support=await f.query('SELECT money_kind,refund_minor FROM txn ORDER BY id');
  assert.equal(support.rows[1].refund_minor,3000,'actual refund classification was reached');
  const result=await f.query(c2Total(C2_SPENDING));assert.equal(result.rows[0].n,7000);assertCertificateEstimate(result,3000);
});
function c2Dates(t) {
  const f=c2Book(t);f.run("UPDATE fin_accounts SET mask='4812' WHERE account_slug='operating'");
  for(const [id,day,cents] of [['sep30','2026-09-30',11000],['oct01','2026-10-01',21000],['oct15','2026-10-15',31000],
    ['oct30','2026-10-30',41000],['oct31','2026-10-31',51000],['nov01','2026-11-01',61000],
    ['dec31','2025-12-31',1100],['jan01','2026-01-01',1200],['feb28','2026-02-28',1300],['mar01','2026-03-01',1400],
    ['leap28','2024-02-28',1500],['leap29','2024-02-29',1600],['leapmar','2024-03-01',1700]])
    f.add(id,cents,'outflow','DESIGN SUPPLIES','OFFICE_SUPPLIES',day,'Synthetic supplier');
  f.add('sale-sep',100000,'inflow','DESIGN INVOICE PAYMENT','SALES','2026-09-30','Synthetic customer');
  f.add('sale-oct',200000,'inflow','DESIGN INVOICE PAYMENT','SALES','2026-10-31','Synthetic customer');
  f.post('reserve-buy','reserve',7000,'outflow','DESIGN SUPPLIES','2026-10-31');
  f.post('card-buy','personal',8000,'outflow','DESIGN SUPPLIES','2026-10-31');
  return {...f,read:bounds=>queryMoney(f.env,{sql:`SELECT COALESCE(SUM(expense_minor),0) AS n FROM txn WHERE ${bounds} AND account_slug='operating'`,
    ...OCT,account_slugs:['operating']},{now:()=>MONEY_NOW})};
}
for(const [name,bounds,expected] of [
  ['UTC inclusive',"posted_on BETWEEN '2026-10-01T07:00:00Z' AND '2026-11-01T06:59:59Z'",144000],
  ['owner offset',"posted_on BETWEEN '2026-10-01T00:00:00-07:00' AND '2026-10-31T23:59:59-07:00'",144000],
  ['UTC half open',"posted_on >= '2026-10-01T07:00:00Z' AND posted_on < '2026-11-01T07:00:00Z'",144000],
  ['date only',"posted_on BETWEEN '2026-10-01' AND '2026-10-31'",144000],
]) test(`C2 X1112 Q19/${name}: equivalent owner-month bounds select the same posting days`,async t=>{
  const f=c2Dates(t);const result=await f.read(bounds);
  assert.ok(f.calls.some(sql=>sql.includes(' AS n FROM txn WHERE ')),'the aggregate actually executed');
  diagnostic(t,`X1112 Q19/${name}`,'Our October in Phoenix runs October 1 at 07:00 UTC through November 1 at 06:59:59 UTC. What did checking spend in that local month?',
    'queryMoney -> moneyQuerySelection -> SQLite',result.rows[0],{n:expected},result.confidence_text);
  assert.equal(result.rows[0].n,expected);
  const after=result.confidence.caveats.find(c=>c.code==='posted_after_period');
  assert.ok(after,'the exclusion disclosure decision was reached');assert.equal(after.amounts[0].outflow_minor,61000);
  assert.equal(after.rows[0].posted_on,'2026-11-01');
  if(name!=='date only')assert.ok(result.confidence.percent<90,'rewritten timestamps remain below High');
});
for(const [zone,from,to,days] of [
  ['Pacific/Kiritimati','2026-09-30T10:00:00Z','2026-10-31T09:59:59Z',['2026-10-01','2026-10-31']],
  ['America/Los_Angeles','2026-11-01T07:00:00Z','2026-12-01T07:59:59Z',['2026-11-01','2026-11-30']],
  ['UTC','2026-10-01T00:00:00Z','2026-10-31T23:59:59Z',['2026-10-01','2026-10-31']],
]) test(`C2 date control/${zone}: request zone wins over environment, including positive offsets and DST`,async t=>{
  const f=c2Book(t);const before=new Date(Date.parse(days[0]+'T00:00:00Z')-86400000).toISOString().slice(0,10);
  const after=new Date(Date.parse(days[1]+'T00:00:00Z')+86400000).toISOString().slice(0,10);
  for(const [id,day,cents] of [['before',before,40000],['first',days[0],10000],['last',days[1],20000],['after',after,50000]])
    f.add(id,cents,'outflow','Supplies',null,day);
  const read=bounds=>queryMoney(f.env,{sql:`SELECT SUM(expense_minor) AS n FROM txn WHERE ${bounds}`,
    period_from:days[0],period_to:days[1],time_zone:zone},{now:()=>MONEY_NOW});
  const control=await read(`posted_on BETWEEN '${days[0]}' AND '${days[1]}'`);
  const result=await read(`posted_on BETWEEN '${from}' AND '${to}'`);
  assert.equal(control.rows[0].n,30000,'date-only green control has both boundary days');
  assert.ok(result.confidence.caveats.some(c=>c.code==='period_adjusted'),'timestamp repair was reached');
  assert.equal(result.rows[0].n,30000);assert.ok(result.confidence.percent<90);
});


// Batch D keeps the original finder questions and independent economic truth.
// A below-High cash figure remains available while unproved membership is named.
const dWindow = " WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31'";
const dNet = 'expense_minor + CASE WHEN expense_minor=0 THEN interest_stated_minor ELSE 0 END - refund_minor';
const dDecember = {period_from:'2025-12-01',period_to:'2025-12-31',time_zone:'America/Phoenix'};
function dBook(t,mode,period=OCT) {
  const f=octoberBook(t,mode),month=period.period_from.slice(0,7);
  return {...f,period,bounds:` WHERE posted_on BETWEEN '${period.period_from}' AND '${period.period_to}'`,
    add:(id,cents,direction,memo,category=null,day=month+'-12',payee='Supplier')=>
      f.add(id,cents,direction,memo,category,day.replace('2026-10',month),payee),
    query:sql=>queryMoney(f.env,{sql,...period},{now:()=>MONEY_NOW}),
    sql:f.sql.replaceAll(OCT.period_from,period.period_from).replaceAll(OCT.period_to,period.period_to)};
}
async function dRead(t,f,c,expression) {
  const overview=await overviewMoney(f.env,{now:()=>MONEY_NOW});
  assert.ok(overview.accounts.length,'overview reached the recorded account inventory');
  const support=await f.query('SELECT * FROM txn ORDER BY id');
  assert.ok(support.rows.length,'the real classification decision was reached');
  const result=await f.query(`SELECT COALESCE(SUM(${expression}),0) AS n FROM txn${f.bounds||dWindow}`);
  assert.equal(result.rows.length,1,'the answer remains nonempty');
  assert.equal(result.truncated,false);
  diagnostic(t,c.id,c.question,'overview -> guide expression -> queryMoney -> SQLite',result.rows[0],{n:c.truth},result.confidence_text);
  assert.match(result.confidence_text,/Confidence: (High|Medium|Low) \(\d+%\).*Reasons:.*Missing:/s);
  return {support:support.rows,result};
}
const dEntrusted=[
  {id:'X1127 Q06',question:'How much did our management business spend on its own October repairs, excluding payments made as agent?',
    rows:[[120000,'outflow','REPAIR PAID AS AGENT FROM PROPERTY OWNER TRUST FUNDS']],figure:120000,truth:0,disputed:120000},
  {id:'X1135 Q04',question:'How much did the management business spend in October?',
    rows:[[240000,'outflow','Security deposit refund to resident','', '2026-10-12','Resident']],figure:240000,truth:0,disputed:240000},
  {id:'X1135 Q05',question:'How much did the management business spend in October?',
    rows:[[210000,'outflow','Remittance of client rental proceeds',null,'2026-10-12','Landlord']],figure:210000,truth:0,disputed:210000},
  {id:'X1151 Q03',question:'How much operating expense did the property manager incur in December?',
    rows:[[17000,'outflow','Office supplies',null,'2025-12-02'],[240000,'outflow','Refundable security deposit released to departing tenant',null,'2025-12-05']],figure:257000,truth:17000,disputed:240000},
  {id:'X1151 Q04',question:'What were net operating expenses after receiving back the office security deposit?',
    rows:[[50000,'outflow','Office supplies',null,'2025-12-02'],[240000,'inflow','Security deposit returned office lease',null,'2025-12-05']],figure:-190000,truth:50000,disputed:240000},
  {id:'X1151 Q05',question:'How much expense did the property manager incur after remitting collected rent?',
    rows:[[30000,'outflow','Office supplies',null,'2025-12-02'],[720000,'outflow','Tenant rent proceeds remitted to outside property owner',null,'2025-12-05']],figure:750000,truth:30000,disputed:720000},
];
for(const mode of ['manual','live']) for(const c of dEntrusted) test(`D ${c.id}/${mode}: beneficiary cash stays available below High`,async t=>{
  const f=dBook(t,mode,c.id.startsWith('X1151')?dDecember:OCT);c.rows.forEach((r,i)=>f.add(`row-${i}`,...r));
  const {support,result}=await dRead(t,f,c,c.id==='X1151 Q04'?dNet:'expense_minor');
  assert.equal(support.length,c.rows.length,'each nonempty posting reached classification');
  assert.equal(result.rows[0].n,c.figure,'retain the observed provisional cash figure');
  assert.ok(result.confidence.percent<90,'beneficial ownership is unproved');
  const amount=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(c.disputed/100);
  assert.ok(result.confidence_text.includes(amount),'exact affected dollars are disclosed');
  assert.match(result.confidence_text,/Missing:.*(?:deposit|beneficiary|payable|statement)/is);
});
test('D entrusted green controls: ordinary rent and repairs remain counted at High',async t=>{
  const f=octoberBook(t,'live');f.add('rent',80000,'outflow','Office rent paid to property owner');
  f.add('repair',120000,'outflow','Repairs to business office');
  const {support,result}=await dRead(t,f,{id:'D agency control',question:'What were our own October operating costs?',truth:200000},'expense_minor');
  assert.equal(support.length,2);assert.ok(support.every(r=>r.estimated===0));
  assert.equal(result.rows[0].n,200000);assert.equal(result.confidence.percent,95);
});

function dLoan(t,{bank=false,extra=false,period=OCT,day=period.period_from.slice(0,7)+'-12'}={}) {
  const f=dBook(t,'live',period);f.account('debt','live','card');
  f.run("UPDATE fin_accounts SET account_kind='loan',mask='2222',label='Recorded lender',institution='Recorded lender' WHERE account_slug='debt'");
  f.coverage('debt','2025-01-01','2026-11-13');f.connection('debt');
  f.run('UPDATE bank_feed_items SET last_synced_at=?','2026-11-13T14:00:00Z');
  f.row('principal','debt',day,90000,'inflow',{description:'Principal payment'});
  f.row('interest','debt',day,10000,'inflow',{description:'Interest payment'});
  if(bank)f.add('bank-payment',100000,'outflow','PAYMENT TO LOAN 2222',null,'2026-10-12','Recorded lender');
  if(extra)f.row('later-interest','debt','2026-10-22',7000,'inflow',{description:'Interest payment'});
  return f;
}
for(const [id,question,expression,truth] of [
  ['Q19','How much principal and interest reached the lender together?','paid_minor',100000],
  ['Q20','How much principal reached the lender, ignoring interest?','paid_minor-interest_stated_minor',90000],
]) test(`D X1129 ${id}: lender-only split receipts support total and principal`,async t=>{
  const f=dLoan(t,{period:dDecember,day:'2025-12-10'});const {support,result}=await dRead(t,f,{id:`X1129 ${id}`,question,truth},expression);
  assert.deepEqual(support.map(r=>r.money_kind),['loan_payment','loan_interest'],'both component decisions reached');
  assert.equal(result.rows[0].n,truth);assert.equal(result.confidence.percent,95);
  const credited=await f.query(`SELECT SUM(credited_minor) AS n FROM txn${f.bounds}`);
  assert.equal(credited.rows[0].n,100000,'lender-side credited total includes both components once');
});
for(const bank of [false,true]) for(const extra of [false,true]) test(`D split repayment control bank=${bank} extra=${extra}`,async t=>{
  const f=dLoan(t,{bank,extra});const support=await f.query('SELECT * FROM txn ORDER BY id');
  assert.equal(support.rows.length,2+Number(bank)+Number(extra));
  const result=await f.query(`SELECT SUM(paid_minor) AS paid,SUM(paid_minor-interest_stated_minor) AS principal,SUM(credited_minor) AS credited FROM txn${dWindow}`);
  diagnostic(t,'D lender composition control','October repayments and principal','queryMoney',result.rows[0],{paid:extra?107000:100000,principal:90000,credited:extra?107000:100000},result.confidence_text);
  assert.equal(result.rows[0].paid,extra?107000:100000);assert.equal(result.rows[0].principal,90000);
  assert.equal(result.rows[0].credited,extra?107000:100000);assert.equal(result.confidence.percent,95);
  if(bank)assert.equal(support.rows.find(r=>r.txn_uid==='bank-payment').estimated,0,'the exact owned-lender component group proves the paying debit');
});
test('D split repayment control: posting-period filter preserves a cross-month paying leg once',async t=>{
  const f=dLoan(t,{bank:true,day:'2026-11-01'});
  const support=await f.query('SELECT * FROM txn ORDER BY id');assert.equal(support.rows.length,1);
  assert.equal(support.rows[0].txn_uid,'bank-payment','October paying-date decision reached');
  const result=await f.query(`SELECT SUM(paid_minor) AS n FROM txn${dWindow}`);
  assert.equal(result.rows[0].n,100000);assert.equal(result.confidence.percent,40,'the paying leg lacks a kind certificate and the November split is outside the period');
  assertCertificateEstimate(result,100000);
  assert.equal(support.rows[0].estimated,1,'the counted paying leg reached the missing-certificate decision');
  assert.ok(result.confidence.gaps.some(g=>g.code==='names_another_account'),'the counterpart certificate is missing');
  assert.ok(result.confidence.gaps.some(g=>g.code==='loan_interest_unseparated'),'missing in-period component decision reached');
});

for(const category of [null,'INCOME']) for(const topic of ['chargeback','refund','reversal','dispute','ordinary'])
 test(`D X1136 Q34/${topic}/${category||'no category'}: topic words cannot certify lost sales`,async t=>{
  const f=octoberBook(t,'live'),conflict=['chargeback','refund','reversal'].includes(topic);
  f.add('invoice',100000,'inflow',`Invoice for ${topic} insurance artwork`,category,'2026-10-12','Studio customer');
  const {support,result}=await dRead(t,f,{id:`X1136 Q34 ${topic} ${category||'uncategorized'}`,
    question:`Our customer bought ${topic} insurance design work; is their $1,000 receipt income?`,truth:100000},'income_minor+sales_adjust_minor');
  assert.equal(support.length,1);assert.equal(result.rows[0].n,conflict?0:100000);
  if(conflict) {assert.ok(result.confidence.percent<90);assert.match(result.confidence_text,/\$1,000\.00/);
    assert.match(result.confidence_text,/Missing:.*(?:invoice|transaction type|refund|credit)/is);}
  else if(category) assert.equal(result.confidence.percent,95,'owner-confirmed ordinary receipts keep their High control');
  else assert.equal(result.confidence.percent,95,'ordinary customer receipts count at face value');
 });
for(const memo of ['REWARDS CREDIT NOT A REFUND','REWARD CREDIT NOT A PURCHASE REFUND','REWARD CREDIT WITHOUT REFUND'])
 test(`D X1141 Q18/${memo}: contradictory type wording removes High`,async t=>{
  const f=octoberBook(t,'live');f.account('card','live','card');f.coverage('card','2025-01-01','2026-11-13');f.connection('card');
  f.run('UPDATE bank_feed_items SET last_synced_at=?','2026-11-13T14:00:00Z');
  f.row('purchase','card','2026-10-04',96400,'outflow',{description:'STUDIO SUPPLIES PURCHASE'});
  f.row('reward','card','2026-10-09',2700,'inflow',{description:memo});
  const {support,result}=await dRead(t,f,{id:'X1141 Q18 '+memo,question:'Does the reward credit on my card reduce October supply spending?',truth:96400},dNet);
  assert.equal(support.length,2);assert.equal(result.rows[0].n,93700,'retain cash reading pending credit-type reconciliation');
  assert.ok(result.confidence.percent<90);assert.match(result.confidence_text,/\$27\.00/);
  assert.match(result.confidence_text,/Missing:.*(?:issuer|credit|statement)/is);
 });
for(const memo of ['Office supplies refund','Dispute reversal won','Chargeback reversal','Dispute won'])
 test(`D X1140 Q36/${memo}: buyer credit offsets purchase spending, with no sales`,async t=>{
  const f=octoberBook(t,'live');f.account('card','live','card');f.coverage('card','2025-01-01','2026-11-13');f.connection('card');
  f.run('UPDATE bank_feed_items SET last_synced_at=?','2026-11-13T14:00:00Z');
  f.row('purchase','card','2026-10-05',45000,'outflow',{description:'Office supplies'});
  f.row('credit','card','2026-10-20',15000,'inflow',{description:memo});
  const {support,result}=await dRead(t,f,{id:'X1140 Q36 '+memo,question:'How much did a chargeback win reduce our card expenses?',truth:30000},dNet);
  assert.equal(support.length,2);assert.equal(support[1].money_kind,'refund','credit recognition decision reached');
  const sales=await f.query(`SELECT SUM(income_minor+sales_adjust_minor) AS n FROM txn${dWindow}`);
  diagnostic(t,'X1140 net sales '+memo,'What were consulting sales?','queryMoney',sales.rows[0],{n:0},sales.confidence_text);
  assert.equal(result.rows[0].n,30000);assert.equal(sales.rows[0].n,0);assertCertificateEstimate(result,15000);
 });
test('D seller recovery green control: processor recovery still adjusts net sales',async t=>{
 const f=octoberBook(t,'live');f.add('sales',100000,'inflow','STRIPE PAYOUT');
 f.add('return',15000,'outflow','STRIPE CHARGEBACK','CHARGEBACKS','2026-10-10','Stripe');
 f.add('won',15000,'inflow','STRIPE DISPUTE WON','CHARGEBACK REVERSAL','2026-10-20','Stripe');
 const support=await f.query('SELECT * FROM txn ORDER BY id');assert.equal(support.rows.length,3);
 assert.equal(support.rows[2].sales_adjust_minor,15000,'seller-recovery decision reached');
 const result=await f.query(f.sql);assert.equal(result.rows[0].cash_profit_minor,100000);assertCertificateEstimate(result,100000);
});
for(const [id,rows,truth] of [
 ['X1131 Q16',[[200000,'inflow','STRIPE PAYOUT'],[15000,'outflow','STRIPE CHARGEBACK','CHARGEBACKS','2026-10-12','Stripe']],185000],
 ['X1131 Q18',[[200000,'inflow','STRIPE PAYOUT'],[20000,'outflow','Packing supplies'],[5000,'inflow','POS RETURN']],185000],
 ['X1137 Q40',[[100000,'inflow','SQUARE PAYOUT','PAYOUT','2026-10-10','Square'],[12000,'outflow','SQUARE REFUND','REFUND','2025-12-11','Square'],[60000,'outflow','Food supply purchase',null,'2025-12-11']],28000],
]) test(`D ${id}: current Profit includes the signed contribution`,async t=>{
 const f=dBook(t,'live',id==='X1137 Q40'?dDecember:OCT);rows.forEach((r,i)=>f.add(`row-${i}`,...r));
 const support=await f.query('SELECT * FROM txn ORDER BY id');assert.equal(support.rows.length,rows.length);
 assert.ok(support.rows.some(r=>r.refund_minor||r.sales_adjust_minor),'nonzero signed consumer decision reached');
 const result=await f.query(f.sql);diagnostic(t,id,'What was cash-basis profit after the recorded adjustments?',
  'overview -> shipped Profit recipe -> queryMoney',result.rows[0],{cash_profit_minor:truth},result.confidence_text);
 assert.equal(result.rows[0].cash_profit_minor,truth);if(id==='X1137 Q40'){assert.equal(result.confidence.percent,89);assert.match(result.confidence_text,/processor.*net settlements/is);} else assertCertificateEstimate(result,200000);
});
test('D X1131 Q17: current Profit counts reconciled lender interest once',async t=>{
 const f=lenderBook(t,{directed:true});f.add('income',200000,'inflow','STRIPE PAYOUT');
 const support=await f.query('SELECT * FROM txn ORDER BY id');assert.equal(support.rows.length,4);
 assert.equal(support.rows[2].interest_expense_minor,35000,'separate lender interest decision reached');
 const result=await f.query(f.sql);diagnostic(t,'X1131 Q17','What was October cash-basis profit after separately recorded interest?',
  'shipped Profit -> queryMoney',result.rows[0],{cash_profit_minor:165000},result.confidence_text);
 assert.equal(result.rows[0].cash_profit_minor,165000);assertCertificateEstimate(result,200000);
});

// D2 varies the description without supplying independent type evidence.
// The retained cash reading is allowed; certification from words alone is not.
for(const memo of ['Invoice 204 chargeback insurance artwork','Receipt 204 refund policy artwork','Project 204 reversal insurance artwork'])
 test(`D2 X1136-N1: ${memo}`,async t=>{
  const f=octoberBook(t,'live');f.add('receipt',100000,'inflow',memo,null,'2026-10-12','Studio customer');
  const {support,result}=await dRead(t,f,{id:'D2 X1136-N1 '+memo,question:'What were October net sales?',truth:100000},'income_minor+sales_adjust_minor');
  assert.equal(support.length,1);assert.equal(support[0].money_kind,'refund','the wording-based refund decision was reached');
  assert.equal(result.rows[0].n,0,'retain the provisional figure instead of refusing');
  assert.ok(result.confidence.percent<90,'an invoice subject cannot certify a refund');
  assert.equal(support[0].estimated,1);
  assert.match(result.confidence_text,/\$1,000\.00/);
  assert.match(result.confidence_text,/wording/i);assert.match(result.confidence_text,/Missing:.*(?:invoice|payment|transaction.type)/is);
 });
for(const memo of ['REWARDS CREDIT NOT A MERCHANDISE RETURN','REWARD CREDIT WITHOUT RETURN CREDIT','REWARDS CREDIT NEVER A RETURNED PURCHASE'])
 test(`D2 X1141-N1: ${memo}`,async t=>{
  const f=octoberBook(t,'live');f.account('card','live','card');f.coverage('card','2025-01-01','2026-11-13');f.connection('card');
  f.run("UPDATE fin_accounts SET mask='2222' WHERE account_slug='card'");
  f.run('UPDATE bank_feed_items SET last_synced_at=?','2026-11-13T14:00:00Z');
  f.row('purchase','card','2026-10-04',96400,'outflow',{description:'STUDIO SUPPLIES PURCHASE'});
  f.row('credit','card','2026-10-09',2700,'inflow',{description:memo});
  const {support,result}=await dRead(t,f,{id:'D2 X1141-N1 '+memo,question:'What was October purchase spending?',truth:96400},dNet);
  assert.equal(support.length,2);assert.equal(support[1].refund_minor,2700,'the disputed spending offset was reached');
  assert.equal(result.rows[0].n,93700);assert.ok(result.confidence.percent<90);
  assert.equal(support[1].estimated,1);assert.match(result.confidence_text,/\$27\.00/);
  assert.match(result.confidence_text,/wording/i);assert.match(result.confidence_text,/Missing:.*(?:issuer|credit|statement)/is);
 });
for(const category of ['DISPUTE REVERSAL','CHARGEBACK RECOVERY',null])
 test(`D2 X1140-N1: checking recovery ${category||'uncategorized'} needs a seller role`,async t=>{
  const f=octoberBook(t,'live');f.add('purchase',45000,'outflow','Debit card supplies purchase','OFFICE SUPPLIES','2026-10-05');
  f.add('credit',15000,'inflow','Dispute reversal won',category,'2026-10-20');
  const {support,result}=await dRead(t,f,{id:'D2 X1140-N1 '+category,question:'What was October net purchase spending?',truth:30000},dNet);
  assert.equal(support.length,2);assert.equal(support[1].sales_adjust_minor,15000,'ambiguous seller-recovery decision was reached');
  assert.equal(result.rows[0].n,45000);
  const sales=await f.query(`SELECT SUM(income_minor+sales_adjust_minor) AS n FROM txn${dWindow}`);
  diagnostic(t,'D2 X1140 sales '+category,'What were October net sales?','queryMoney',sales.rows[0],{n:0},sales.confidence_text);
  assert.ok(result.confidence.percent<90);assert.equal(support[1].estimated,1);
  assert.equal(sales.rows[0].n,15000);assert.ok(sales.confidence.percent<90);
  assert.match(sales.confidence_text,/\$150\.00/);assert.match(sales.confidence_text,/role|buyer|seller/i);
  assert.match(sales.confidence_text,/Missing:.*(?:original|dispute|processor)/is);
 });
for(const [memo,category,direction,expression,figure,ordinary=false,percent=null] of [
 ['Merchant refund',null,'inflow','refund_minor',2700],
 ['Client refund','OTHER','outflow','sales_adjust_minor',-2700],
 ['Provisional credit reversal',null,'outflow','refund_minor',-2700],
 ['Customer sales received',null,'inflow','income_minor',2700,true,95],
 ['STRIPE PAYOUT',null,'inflow','income_minor',2700,true,89],
]) test(`D2 structural rule: ${memo} retains its dollars and evidence-derived confidence`,async t=>{
 const f=octoberBook(t,'live');f.add('row',2700,direction,memo,category,'2026-10-12',null);
 const {support,result}=await dRead(t,f,{id:'D2 wording '+memo,question:'What is the selected October contribution?',truth:figure},expression);
 assert.equal(support.length,1);assert.equal(result.rows[0].n,figure,'contribution reached the actual SQLite answer');
 assert.equal(support[0].estimated,Number(!ordinary));
 if(ordinary){assert.equal(result.confidence.percent,percent);if(percent<90){assert.match(result.confidence_text,/\$27\.00/);assert.match(result.confidence_text,/processor/i);}}
 else {assert.ok(result.confidence.percent<90);assert.match(result.confidence_text,/\$27\.00/);assert.match(result.confidence_text,/wording/i);}
});
test('D2 structured High control: provider refund field certifies a purchase credit',async t=>{
 const f=octoberBook(t,'live');f.add('purchase',96400,'outflow','Office supplies','OFFICE SUPPLIES','2026-10-04');
 f.add('credit',2700,'inflow','Merchant refund','REFUND','2026-10-09');
 f.run("UPDATE fin_transactions SET provenance='feed',source_feed='synthetic-feed' WHERE txn_uid='credit'");
 const {support,result}=await dRead(t,f,{id:'D2 provider High',question:'What was October net spending?',truth:93700},dNet);
 assert.equal(support[1].refund_minor,2700);assert.equal(support[1].estimated,0);
 assert.equal(result.rows[0].n,93700);assert.equal(result.confidence.percent,95);
});
test('D2 structured High control: uniquely matched original repayment remains High',async t=>{
 const f=returnedInterestBook(t);f.run("UPDATE fin_transactions SET description='PRINCIPAL PAYMENT' WHERE txn_uid='interest'");
 const {support,result}=await dRead(t,f,{id:'D2 matched High',question:'What was October net repayment?',truth:0},'paid_minor');
 assert.equal(support.length,2);assert.equal(support[1].paid_basis,'reversal','unique-original reconciliation was reached');
 assert.equal(support[1].paid_minor,-35000);assert.equal(result.rows[0].n,0);assert.equal(result.confidence.percent,95);
});
test('D2 structured High control: proved merchant account permits seller recovery',async t=>{
 const f=octoberBook(t,'live');f.run("UPDATE fin_accounts SET account_kind='merchant' WHERE account_slug='operating'");
 f.add('recovery',15000,'inflow','Dispute reversal won','DISPUTE REVERSAL');
 const {support,result}=await dRead(t,f,{id:'D2 seller High',question:'What was October recovered sales?',truth:15000},'sales_adjust_minor');
 assert.equal(support[0].sales_adjust_minor,15000);assert.equal(support[0].estimated,0);
 assert.equal(result.rows[0].n,15000);assert.equal(result.confidence.percent,95);
});
for(const mode of ['manual','live']) for(const id of ['X1136 Q34','X1141 Q18','X1140 Q36'])
 test(`D2 original finder replay ${id}/${mode}: correct or below High`,async t=>{
  const f=octoberBook(t,mode);
  if(id==='X1136 Q34') f.add('receipt',100000,'inflow','Invoice for chargeback insurance artwork',null,'2026-10-12','Studio customer');
  else {
   f.account('card',mode,'card');f.coverage('card','2025-01-01','2026-11-13');
   f.run("UPDATE fin_accounts SET mask='2222' WHERE account_slug='card'");
   if(mode==='live'){f.connection('card');f.run('UPDATE bank_feed_items SET last_synced_at=?','2026-11-13T14:00:00Z');}
   f.row('purchase','card','2026-10-04',id==='X1141 Q18'?96400:45000,'outflow',{description:'Office supplies'});
   f.row('credit','card','2026-10-09',id==='X1141 Q18'?2700:15000,'inflow',
    {description:id==='X1141 Q18'?'REWARDS CREDIT NOT A REFUND':'Dispute reversal won'});
  }
  const truth=id==='X1136 Q34'?100000:id==='X1141 Q18'?96400:30000;
  const {support,result}=await dRead(t,f,{id:'D2 original '+id+'/'+mode,question:'What was the October figure?',truth},id==='X1136 Q34'?'income_minor+sales_adjust_minor':dNet);
  assert.equal(support.length,id==='X1136 Q34'?1:2);
  assert.equal(result.rows[0].n,id==='X1136 Q34'?0:id==='X1141 Q18'?93700:30000);
  assert.ok(result.rows[0].n===truth||result.confidence.percent<90);
  assert.ok(result.confidence.percent<90,'word-only credit types remain estimated even when their cash figure is correct');
  assert.match(result.confidence_text,id==='X1136 Q34'?/\$1,000\.00/:id==='X1141 Q18'?/\$27\.00/:/\$150\.00/);
 });
test('D2 selection control: excluding likely rows cannot certify the remaining sales subtotal',async t=>{
 const f=octoberBook(t,'live');f.add('receipt',100000,'inflow','Invoice 204 chargeback insurance artwork',null,'2026-10-12','Studio customer');
 f.add('sale',50000,'inflow','Design payment','INCOME','2026-10-15','Studio customer');
 const support=await f.query('SELECT * FROM txn ORDER BY id');assert.equal(support.rows.length,2);
 assert.equal(support.rows[0].money_kind,'refund','the omitted receipt decision was reached');
 const result=await f.query(`SELECT SUM(income_minor) AS n FROM txn${dWindow} AND money_kind='ordinary'`);
 diagnostic(t,'D2 filtered sales','What were October net sales?','queryMoney',result.rows[0],{n:150000},result.confidence_text);
 assert.equal(result.rows[0].n,50000);assert.ok(result.confidence.percent<90);
 assert.match(result.confidence_text,/\$1,000\.00/);assert.match(result.confidence_text,/wording/i);
});


// Practical High preflight: ordinary first customer receipts need no extra
// type certificate. Preserve the exact inputs and the independent category arm.
for(const mode of ['manual','live']) for(const confirmed of [false,true])
 test(`CERT PREFLIGHT C1/${mode}/${confirmed?'owner-confirmed control':'required kept-High input'}`,async t=>{
  const f=octoberBook(t,mode);
  f.run("UPDATE fin_accounts SET label='Operating checking',institution='Synthetic bank'");
  f.add('sale',500000,'inflow','CLIENT INVOICE 1001',confirmed?'INCOME':null,'2026-10-12','Client');
  f.add('rent',120000,'outflow','OFFICE RENT',null,'2026-10-12','Landlord');
  f.run('UPDATE fin_transactions SET category_basis_state=NULL WHERE category IS NULL');
  const stored=f.db.prepare('SELECT category,category_basis_state FROM fin_transactions WHERE txn_uid=?').get('sale');
  assert.equal(stored.category,confirmed?'INCOME':null,'category evidence matches the intended arm');
  assert.equal(stored.category_basis_state,confirmed?'confirmed':null);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM fin_transactions WHERE posted_on<'2026-10-12'").get().n,0,
    'the first receipt has no prior customer history');
  assert.equal(f.db.prepare("SELECT account_kind FROM fin_accounts WHERE account_slug='operating'").get().account_kind,'checking',
    'the input is not a recorded merchant account');
  const support=await f.query('SELECT txn_uid,money_kind,estimated,estimate_reason,income_minor,expense_minor FROM txn ORDER BY id');
  assert.equal(support.rows.length,2,'both classification decisions were reached');
  assert.equal(support.rows[0].income_minor,500000,'the receipt remains counted as income');
  assert.equal(support.rows[1].expense_minor,120000,'the rent remains counted as spending');
  const result=await f.query(f.sql);
  assert.ok(f.calls.some(sql=>sql.includes('cash_profit_minor')),'the shipped Profit recipe reached SQLite');
  assert.equal(result.rows[0].cash_profit_minor,380000,'the control keeps its exact profit figure');
  t.diagnostic(JSON.stringify({id:'C1',mode,confirmed,figure:result.rows[0].cash_profit_minor,
    percent:result.confidence.percent,receipt:support.rows[0],confidence_text:result.confidence_text}));
  assert.equal(support.rows[0].estimated,0,'ordinary income type counts at face value in both arms');
  assert.equal(result.confidence.percent,95,'extra type proof is unnecessary for this ordinary receipt');
  assert.match(result.confidence_text,/expected.account inventory/i);
 });


// Closed-world certificates: figures are fixed independently of confidence.
// These books have an owner-confirmed base receipt so an unrelated unsupported
// posting cannot hide a wrong-at-High regression behind first-receipt doubt.
const certEvidence = await import('../src/lib/clean-money-evidence.js');
const certMoney = await import('../src/lib/clean-money.js');
const certQuality = await import('../src/lib/money-query-quality.js');
function certBook(t, mode='manual') {
 const f=octoberBook(t,mode);
 f.run("UPDATE fin_accounts SET label='Operating checking',institution='Synthetic bank'");
 const add=(id,cents,direction,memo,o={})=>{
  f.row(id,o.slug||'operating',o.day||'2026-10-12',cents,direction,{description:memo,currency:o.currency||'USD'});
  f.run('UPDATE fin_transactions SET payee=?,category=?,category_basis_state=?,provenance=? WHERE txn_uid=?',
   o.payee??null,o.category??null,o.category?(o.basis??'confirmed'):null,o.provenance||'owner_stated',id);
 };
 const addAccount=(slug,kind,mask,o={})=>{
  f.account(slug,mode,['loan','line_of_credit'].includes(kind)?'card':kind);
  f.run('UPDATE fin_accounts SET account_kind=?,mask=?,label=?,institution=?,balance_role=? WHERE account_slug=?',
   kind,mask,o.label||slug,o.institution??null,['card','loan','line_of_credit'].includes(kind)?'liability':'asset',slug);
  f.coverage(slug,'2025-01-01','2026-11-13');
  if(mode==='live'){f.connection(slug);f.run('UPDATE bank_feed_items SET last_synced_at=?','2026-11-13T14:00:00Z');}
 };
 const query=(sql,period=OCT,extra={})=>queryMoney(f.env,{sql,...period,...extra},{now:()=>MONEY_NOW});
 const profit=(period=OCT)=>query(f.sql.replaceAll(OCT.period_from,period.period_from).replaceAll(OCT.period_to,period.period_to),period);
 const snapshot=async()=>{
  // Reproduce the real bounded SQLite snapshot, including private evidence.
  const read=await query('SELECT * FROM txn ORDER BY id');
  assert.ok(read.rows.length,'real membership decision point reached');
  const sql=f.calls.findLast(s=>s.includes('AS snapshot_kind')&&s.includes("'rows'"));
  assert.ok(sql,'snapshot statement reached');
  // queryMoney binds its snapshot bounds. Capture returned records instead in
  // the adapter below; no private evidence is added to public SQL columns.
  return read;
 };
 return {...f,add,addAccount,query,profit,snapshot};
}
const certReds=[
 ['tax',400000,'IRS USATAXPYMT 1040ES ESTIMATED TAX',{payee:'IRS'},'tax_payment_type_unproved'],
 ['owner category',300000,'CHECK 1043',{payee:'Owner',category:"Owner's Draw"},'category_names_nonoperating_account'],
 ['mixed owner category',60000,'DEBIT CARD PURCHASE HOME FURNITURE',{payee:'Furniture store',category:"Owner's Pay & Personal Expenses"},'category_names_nonoperating_account'],
 ['loan category',125000,'CHECK 1045',{payee:'Private lender',category:'Loan Payable'},'category_names_nonoperating_account'],
 ['related party',300000,'WIRE OUT',{payee:'Synthetic owner LLC'},'counterparty_is_owned_entity'],
 ['issuer',200000,'Payment to Chase card ending 4444',{payee:'Chase'},'financial_counterparty_type_unproved'],
 ['unrecorded destination',200000,'To Savings ...2222',{},'rail_only_counterparty_unrecorded'],
];
for(const mode of ['manual','live']) for(const [id,cents,memo,o,reason] of certReds)
 test(`CERT RED ${id}/${mode}: same figure, named estimated dollars`,async t=>{
  const f=certBook(t,mode);f.add('sale',500000,'inflow','INVOICE 1',{payee:'Customer',category:'Income'});
  f.add('disputed',cents,'outflow',memo,o);
  const support=await f.query('SELECT * FROM txn ORDER BY id');assert.equal(support.rows.length,2);
  assert.equal(support.rows[1].expense_minor,cents,'the disputed decision was reached and remains counted');
  const r=await f.profit();assert.equal(r.rows[0].cash_profit_minor,500000-cents);
  t.diagnostic(JSON.stringify({cert:id,mode,figure:r.rows[0].cash_profit_minor,percent:r.confidence.percent,text:r.confidence_text}));
  assert.ok(r.confidence.percent<90,`wrong-at-High percent ${r.confidence.percent}`);
  assert.match(r.confidence_text,new RegExp(new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.ok(r.confidence.gaps.some(g=>g.code===reason),reason);
  assert.match(r.confidence_text,/confirm these rows/i);
 });
for(const mode of ['manual','live']) test(`CERT RED bound interest/${mode}`,async t=>{
 const f=certBook(t,mode);f.add('sale',500000,'inflow','INVOICE 1',{payee:'Customer',category:'Income'});
 f.addAccount('debt','loan','2222',{label:'Recorded lender',institution:'Recorded lender'});
 f.add('pay',125000,'outflow','PAYMENT TO LOAN 2222');
 f.add('ack',125000,'inflow','PAYMENT RECEIVED',{slug:'debt'});
 f.add('interest',312,'inflow','INTEREST EARNED',{payee:'Synthetic bank',day:'2026-10-15'});
 const support=await f.query('SELECT * FROM txn ORDER BY id');assert.equal(support.rows[1].money_kind,'loan_payment');
 const r=await f.profit();assert.equal(r.rows[0].cash_profit_minor,500312);
 t.diagnostic(JSON.stringify({cert:'bound-interest',mode,figure:r.rows[0].cash_profit_minor,percent:r.confidence.percent,text:r.confidence_text}));
 assert.ok(r.confidence.percent<90,`wrong-at-High percent ${r.confidence.percent}`);
 assert.ok(r.confidence.gaps.some(g=>g.code==='loan_interest_unseparated'));
 assert.match(r.confidence_text,/\$1,250\.00/);
});
for(const mode of ['manual','live']) test(`CERT RED excluded refund original/${mode}`,async t=>{
 const f=certBook(t,mode);f.add('sale',500000,'inflow','INVOICE 1',{payee:'Customer',category:'Income'});
 f.add('draw',200000,'outflow','Owner draw',{payee:'Owner',category:'Owner Draw',day:'2026-10-03'});
 f.add('rent',200000,'outflow','OFFICE RENT',{payee:'Landlord',day:'2026-10-04'});
 f.add('returned',200000,'inflow','ACH RETURN',{category:'Refunds',day:'2026-10-08'});
 const support=await f.query('SELECT * FROM txn ORDER BY id');assert.equal(support.rows[1].money_kind,'owner_money');
 assert.equal(support.rows[3].refund_minor,200000);
 const r=await f.profit();assert.equal(r.rows[0].cash_profit_minor,500000);
 t.diagnostic(JSON.stringify({cert:'excluded-original',mode,figure:r.rows[0].cash_profit_minor,percent:r.confidence.percent,text:r.confidence_text}));
 assert.ok(r.confidence.percent<90,`wrong-at-High percent ${r.confidence.percent}`);
 assert.match(r.confidence_text,/\$2,000\.00/);assert.match(r.confidence_text,/original/i);
});

for(const mode of ['manual','live']) test(`CERT RED green owner-coded control/${mode}`,async t=>{
 const f=certBook(t,mode);f.add('sale',500000,'inflow','INVOICE 1',{payee:'Customer',category:'Income'});
 f.add('rent',120000,'outflow','OFFICE RENT',{payee:'Landlord',category:'Rent'});
 const rows=await f.query('SELECT * FROM txn ORDER BY id');assert.equal(rows.rows.length,2);
 const r=await f.profit();assert.equal(r.rows[0].cash_profit_minor,380000);assert.equal(r.confidence.percent,95);
});

const certHuntCases=[];
{
 const register=(id,question,truth,build,opts={})=>certHuntCases.push({id:"p01/"+id,question,truth,build,opts});
const sale = b => b.add('sale', 500000, 'inflow', 'CLIENT INVOICE 1001', { payee: 'Client' });
const loan = (b, opts = {}) => b.addAccount('debt', 'loan', '2222', { label: 'Recorded lender', institution: 'Recorded lender', ...opts });

// ---- P1: proved loan payment with no interest split. Lender statement (synthetic truth): $900 principal + $350 interest.
const directedPayment = b => {
  sale(b); loan(b);
  b.add('pay', 125000, 'outflow', 'PAYMENT TO LOAN 2222', { payee: null });
  b.add('ack', 125000, 'inflow', 'PAYMENT RECEIVED', { payee: null, slug: 'debt' });
};
register('P1a-control', 'What was October cash-basis profit? (directed loan payment, interest not separated)', 500000 - 35000, directedPayment);
register('P1b', 'What was October cash-basis profit? (directed loan payment + unrelated checking interest earned)', 500000 + 312 - 35000, b => {
  directedPayment(b);
  b.add('int-earned', 312, 'inflow', 'INTEREST EARNED', { payee: 'Synthetic bank', day: '2026-10-15' });
});
register('P1c', 'What was October cash-basis profit? (directed loan payment + bank interest paid credit 3 days later)', 500000 + 45 - 35000, b => {
  directedPayment(b);
  b.add('int-paid', 45, 'inflow', 'INTEREST PAYMENT', { payee: null, day: '2026-10-14' });
});
register('P1d', 'What was October cash-basis profit? (directed loan payment; lender ack says principal and interest)', 500000 - 35000, b => {
  sale(b); loan(b);
  b.add('pay', 125000, 'outflow', 'PAYMENT TO LOAN 2222', { payee: null });
  b.add('ack', 125000, 'inflow', 'PAYMENT RECEIVED PRINCIPAL AND INTEREST', { payee: null, slug: 'debt' });
});
register('P1e', 'What was October cash-basis profit? (loan rate-change interest notice row on loan account)', 500000 - 35000, b => {
  directedPayment(b);
  b.add('notice', 0, 'inflow', 'INTEREST RATE CHANGE', { payee: null, slug: 'debt', day: '2026-10-13' });
});

// ---- P3: federal income tax estimate paid from business checking; Profit is defined "before tax".
register('P3a', 'What was October profit before tax? (1040-ES estimated income tax paid from business checking)', 500000 - 120000, b => {
  sale(b);
  b.add('rent', 120000, 'outflow', 'OFFICE RENT', { payee: 'Landlord' });
  b.add('irs', 400000, 'outflow', 'IRS USATAXPYMT 1040ES ESTIMATED TAX', { payee: 'IRS', day: '2026-10-15' });
});
register('P3b', 'What was October profit before tax? (state income tax payment, payee franchise tax board)', 500000 - 120000, b => {
  sale(b);
  b.add('rent', 120000, 'outflow', 'OFFICE RENT', { payee: 'Landlord' });
  b.add('ftb', 150000, 'outflow', 'FRANCHISE TAX BOARD PAYMENT', { payee: 'Franchise Tax Board', day: '2026-10-15' });
});
// Paired: the same IRS identity pays out and refunds. No single truth makes both treatments right.
register('P3c', 'What was October profit before tax? (IRS payment counted, IRS refund excluded; truth=income tax both)', 500000 - 120000, b => {
  sale(b);
  b.add('rent', 120000, 'outflow', 'OFFICE RENT', { payee: 'Landlord' });
  b.add('irs', 400000, 'outflow', 'IRS USATAXPYMT', { payee: 'IRS', day: '2026-10-15' });
  b.add('irsref', 100000, 'inflow', 'IRS TREAS 310 TAX REF', { payee: 'IRS', day: '2026-10-20' });
});

// ---- P4: owner draws recorded with the common spelled categories.
for (const [suffix, category] of [['control', 'Owner Draw'], ['a', "Owner's Draw"], ['b', 'Member Distribution'], ['c', 'Partner Distributions'], ['d', "Owner's Equity"], ['e', 'Distributions']]) {
  register('P4' + suffix, `What was October business profit? (owner draw, confirmed category "${category}")`, 500000, b => {
    sale(b);
    b.add('draw', 300000, 'outflow', 'CHECK 1043', { payee: 'Owner', category });
  });
}

// ---- P14: owner contributions recorded with spelled categories (inflows).
for (const [suffix, category] of [['control', 'Owner Contribution'], ['a', "Owner's Contribution"], ['b', "Owner's Investment"], ['c', 'Member Contributions'], ['d', 'Capital Investment']]) {
  register('P14' + suffix, `What was October business profit? (capital put in, confirmed category "${category}")`, 500000, b => {
    sale(b);
    b.add('capital', 1000000, 'inflow', 'INCOMING WIRE', { payee: 'Holding company', category });
  });
}

// ---- P5: mortgage escrow surplus refund after an excluded (proved) loan payment.
register('P5', 'What was October profit? (escrow surplus refund from the lender; loan payments proved and excluded)', 500000 - 35000, b => {
  sale(b); loan(b);
  b.add('pay', 125000, 'outflow', 'PAYMENT TO LOAN 2222', { payee: null, day: '2026-10-02' });
  b.add('pri', 90000, 'inflow', 'PRINCIPAL PAYMENT', { payee: null, slug: 'debt', day: '2026-10-02' });
  b.add('int', 35000, 'inflow', 'INTEREST PAYMENT', { payee: null, slug: 'debt', day: '2026-10-02' });
  b.add('escrow', 64000, 'inflow', 'ESCROW REFUND', { payee: 'Recorded lender', day: '2026-10-20' });
});

// ---- P6: supplier price adjustment / rebate credited on the business card (purchase was counted on the card).
register('P6', 'What was October profit? (card purchase $500 then supplier price-adjustment credit $50 on the card)', 500000 - 45000, b => {
  sale(b); b.addAccount('card', 'card', '3333', { label: 'Business card', institution: 'Card issuer' });
  b.add('buy', 50000, 'outflow', 'SUPPLIER ORDER 77', { payee: 'Supplier', slug: 'card' });
  b.add('adj', 5000, 'inflow', 'SUPPLIER PRICE ADJUSTMENT', { payee: 'Supplier', slug: 'card', day: '2026-10-18' });
});

// ---- P30: ACH return of an excluded payment: the bounced loan payment comes back to checking.
register('P30a', 'What was October profit? (loan payment proved, then returned to checking as ACH RETURN)', 500000, b => {
  sale(b); loan(b);
  b.add('pay', 125000, 'outflow', 'PAYMENT TO LOAN 2222', { payee: null });
  b.add('pri', 90000, 'inflow', 'PRINCIPAL PAYMENT', { payee: null, slug: 'debt' });
  b.add('int', 35000, 'inflow', 'INTEREST PAYMENT', { payee: null, slug: 'debt' });
  b.add('pri-r', 90000, 'outflow', 'RETURNED PAYMENT', { payee: null, slug: 'debt', day: '2026-10-14' });
  b.add('int-r', 35000, 'outflow', 'RETURNED PAYMENT', { payee: null, slug: 'debt', day: '2026-10-14' });
  b.add('back', 125000, 'inflow', 'ACH RETURN', { payee: null, day: '2026-10-14' });
});
register('P30b', 'What was October profit? (owner draw to owned personal savings, then ACH RETURN back)', 500000, b => {
  sale(b); b.addAccount('psav', 'savings', '4444', { label: 'Owner personal savings' });
  b.run("UPDATE fin_entities SET kind='business'");
  b.add('xfer', 200000, 'outflow', 'TRANSFER TO SAVINGS 4444', { payee: null });
  b.add('xin', 200000, 'inflow', 'TRANSFER FROM CHECKING 1111', { payee: null, slug: 'psav' });
  b.add('back', 200000, 'inflow', 'ACH RETURN', { payee: null, day: '2026-10-14' });
});
register('P30c', 'What was October profit? (ACH RETURN of a supplier payment that was counted) control', 500000, b => {
  sale(b);
  b.add('pay', 80000, 'outflow', 'ACH DEBIT SUPPLIER CO', { payee: 'Supplier' });
  b.add('back', 80000, 'inflow', 'ACH RETURN', { payee: null, day: '2026-10-14' });
});

// ---- Controls where High is correct
register('C1', 'October profit, plain books', 500000 - 120000, b => { sale(b); b.add('rent', 120000, 'outflow', 'OFFICE RENT', { payee: 'Landlord' }); });
register('C2', 'October profit with lender principal+interest receipts reconciling a directed payment', 500000 - 35000, b => {
  sale(b); loan(b);
  b.add('pay', 125000, 'outflow', 'PAYMENT TO LOAN 2222', { payee: null });
  b.add('pri', 90000, 'inflow', 'PRINCIPAL PAYMENT', { payee: null, slug: 'debt' });
  b.add('int', 35000, 'inflow', 'INTEREST PAYMENT', { payee: null, slug: 'debt' });
});
register('C3', 'October profit after a confirmed customer refund', 500000 - 20000, b => {
  sale(b); b.add('cref', 20000, 'outflow', 'CUSTOMER REFUND', { payee: 'Client', category: 'Refunds' });
});


}
{
 const register=(id,question,truth,build,opts={})=>certHuntCases.push({id:"p02/"+id,question,truth,build,opts});
const sale = b => b.add('sale', 500000, 'inflow', 'CLIENT INVOICE 1001', { payee: 'Client' });
const loan = b => b.addAccount('debt', 'loan', '2222', { label: 'Recorded lender', institution: 'Recorded lender' });

// P1f: biweekly payments. The first is split by lender receipts; the second (truth $340 interest) is not, and the
// first payment's interest posting (5 days earlier) silences the unseparated-interest gap for the second.
register('P1f', 'What was October cash-basis profit? (two biweekly loan payments, only the first split by the lender)', 500000 - 35000 - 34000, b => {
  sale(b); loan(b);
  b.add('pay1', 125000, 'outflow', 'PAYMENT TO LOAN 2222', { payee: null, day: '2026-10-05' });
  b.add('pri1', 90000, 'inflow', 'PRINCIPAL PAYMENT', { payee: null, slug: 'debt', day: '2026-10-05' });
  b.add('int1', 35000, 'inflow', 'INTEREST PAYMENT', { payee: null, slug: 'debt', day: '2026-10-05' });
  b.add('pay2', 125000, 'outflow', 'PAYMENT TO LOAN 2222', { payee: null, day: '2026-10-10' });
  b.add('ack2', 125000, 'inflow', 'PAYMENT RECEIVED', { payee: null, slug: 'debt', day: '2026-10-10' });
});
// P1g: a client payment memo mentioning late-payment interest silences the gap on the same checking account.
register('P1g', 'What was October cash-basis profit? (directed loan payment; a client paid an invoice with late interest)', 500000 + 1500 - 35000, b => {
  sale(b); loan(b);
  b.add('pay', 125000, 'outflow', 'PAYMENT TO LOAN 2222', { payee: null });
  b.add('ack', 125000, 'inflow', 'PAYMENT RECEIVED', { payee: null, slug: 'debt' });
  b.add('late', 1500, 'inflow', 'INVOICE 1001 LATE INTEREST', { payee: 'Client', day: '2026-10-16' });
});
// P1h: overdraft interest charge on checking silences the gap.
register('P1h', 'What was October cash-basis profit? (directed loan payment; $12 overdraft interest on checking)', 500000 - 1200 - 35000, b => {
  sale(b); loan(b);
  b.add('pay', 125000, 'outflow', 'PAYMENT TO LOAN 2222', { payee: null });
  b.add('ack', 125000, 'inflow', 'PAYMENT RECEIVED', { payee: null, slug: 'debt' });
  b.add('od', 1200, 'outflow', 'OVERDRAFT INTEREST CHARGE', { payee: 'Synthetic bank', day: '2026-10-13' });
});

// P4f: QuickBooks-style sole-proprietor equity category for draws and owner personal spending.
register('P4f', "October business profit (owner personal purchase, confirmed category \"Owner's Pay & Personal Expenses\")", 500000, b => {
  sale(b);
  b.add('pers', 60000, 'outflow', 'DEBIT CARD PURCHASE HOME FURNITURE', { payee: 'Furniture store', category: "Owner's Pay & Personal Expenses" });
});
register('P4g', 'October business profit (owner draw to owned personal checking on the personal side) control', 500000, b => {
  sale(b);
  b.run("INSERT INTO fin_entities(entity_slug,legal_name,kind,provenance,basis_state,recorded_at) VALUES ('home','Synthetic household','household','owner_stated','confirmed','2025-12-31T18:00:00Z')");
  b.addAccount('pchk', 'checking', '5555', { label: 'Personal checking' });
  b.run("UPDATE fin_accounts SET entity_slug='home' WHERE account_slug='pchk'");
  b.add('xfer', 300000, 'outflow', 'TRANSFER TO CHECKING 5555', { payee: null });
  b.add('xin', 300000, 'inflow', 'TRANSFER FROM CHECKING 1111', { payee: null, slug: 'pchk' });
});

// P15: loan proceeds recorded by the owner to a liability category.
for (const [suffix, category] of [['control', 'Loan Proceeds'], ['a', 'Loan Payable'], ['b', 'Notes Payable'], ['c', 'SBA Loan']]) {
  register('P15' + suffix, `October business profit (bank loan funded, confirmed category "${category}")`, 500000, b => {
    sale(b);
    b.add('fund', 2500000, 'inflow', 'INCOMING WIRE', { payee: 'Community bank', category });
  });
}
// P16: loan principal paid to an unconnected lender, owner-confirmed liability category.
for (const [suffix, category, truth] of [['control', 'Interest Expense', 500000 - 125000], ['a', 'Loan Payable', 500000], ['b', 'Notes Payable', 500000]]) {
  register('P16' + suffix, `October business profit (principal-only payment to the bank, confirmed category "${category}")`, truth, b => {
    sale(b);
    b.add('prin', 125000, 'outflow', 'ACH DEBIT COMMUNITY BANK', { payee: 'Community bank', category });
  });
}

// P30d: owner draw (recognized category) returned by the owner's bank as ACH RETURN.
register('P30d', 'October business profit (owner draw returned as ACH RETURN)', 500000, b => {
  sale(b);
  b.add('draw', 300000, 'outflow', 'ACH TRANSFER OWNER EXTERNAL', { payee: 'Owner', category: 'Owner Draw' });
  b.add('back', 300000, 'inflow', 'ACH RETURN', { payee: null, day: '2026-10-14' });
});
register('P30e', 'October business profit (owner draw returned as RETURNED ACH DEBIT) wording control', 500000, b => {
  sale(b);
  b.add('draw', 300000, 'outflow', 'ACH TRANSFER OWNER EXTERNAL', { payee: 'Owner', category: 'Owner Draw' });
  b.add('back', 300000, 'inflow', 'RETURNED ACH DEBIT', { payee: null, day: '2026-10-14' });
});
// P30f: proved card payment bounced; card issuer reverses its credit, bank returns the debit as ACH RETURN.
register('P30f', 'October business profit (card payment bounced: issuer reversal + ACH RETURN)', 500000 - 80000, b => {
  sale(b); b.addAccount('card', 'card', '3333', { label: 'Business card', institution: 'Card issuer' });
  b.add('buy', 80000, 'outflow', 'SUPPLIER ORDER 88', { payee: 'Supplier', slug: 'card', day: '2026-10-03' });
  b.add('pay', 80000, 'outflow', 'PAYMENT TO CARD 3333', { payee: null, day: '2026-10-12' });
  b.add('ack', 80000, 'inflow', 'PAYMENT THANK YOU', { payee: null, slug: 'card', day: '2026-10-12' });
  b.add('rev', 80000, 'outflow', 'PAYMENT RETURNED', { payee: null, slug: 'card', day: '2026-10-15' });
  b.add('back', 80000, 'inflow', 'ACH RETURN', { payee: null, day: '2026-10-15' });
});

// P5b: escrow surplus refund with a fully reconciled directed payment (lender payee makes the payment identity known).
register('P5b', 'October profit (escrow surplus refund; directed loan payment reconciled to lender principal+interest)', 500000 - 35000, b => {
  sale(b); loan(b);
  b.add('pay', 125000, 'outflow', 'PAYMENT TO LOAN 2222', { payee: 'Recorded lender', day: '2026-10-02' });
  b.add('pri', 90000, 'inflow', 'PRINCIPAL PAYMENT', { payee: null, slug: 'debt', day: '2026-10-02' });
  b.add('int', 35000, 'inflow', 'INTEREST PAYMENT', { payee: null, slug: 'debt', day: '2026-10-02' });
  b.add('escrow', 64000, 'inflow', 'ESCROW REFUND', { payee: 'Recorded lender', day: '2026-10-20' });
});
register('P5c', 'October profit (escrow surplus refund, no loan accounts connected)', 500000, b => {
  sale(b);
  b.add('escrow', 64000, 'inflow', 'MORTGAGE ESCROW REFUND', { payee: 'Mortgage servicer', day: '2026-10-20' });
});

// P17: interest dates. Bank debit Oct 31 (directed), lender splits on Nov 2. Cash interest was paid Oct 31.
const nov = { period_from: '2026-11-01', period_to: '2026-11-12', time_zone: 'America/Phoenix' };
const crossBook = b => {
  loan(b);
  b.add('nsale', 200000, 'inflow', 'CLIENT INVOICE 1010', { payee: 'Client', day: '2026-11-05' });
  b.add('pay', 125000, 'outflow', 'PAYMENT TO LOAN 2222', { payee: 'Recorded lender', day: '2026-10-31' });
  b.add('pri', 90000, 'inflow', 'PRINCIPAL PAYMENT', { payee: null, slug: 'debt', day: '2026-11-02' });
  b.add('int', 35000, 'inflow', 'INTEREST PAYMENT', { payee: null, slug: 'debt', day: '2026-11-02' });
};
register('P17a', 'November 1-12 cash-basis profit (interest paid by bank debit Oct 31; lender posted Nov 2)', 200000, crossBook, { period: nov });
register('P17b', 'October cash-basis profit (same book)', -35000, crossBook);

// P18: deposit-like refunds outside the fixed deposit vocabulary (adjacent known class; checked for completeness).
register('P18a', 'October profit (refundable utility deposit refunded)', 500000, b => {
  sale(b);
  b.add('util', 30000, 'inflow', 'UTILITY DEPOSIT REFUND', { payee: 'Power company', day: '2026-10-20' });
});

// Controls
register('C4', 'October profit (overdraft fee refunded) control', 500000, b => {
  sale(b);
  b.add('fee', 3500, 'outflow', 'OVERDRAFT FEE', { payee: 'Synthetic bank', day: '2026-10-05' });
  b.add('feeref', 3500, 'inflow', 'OVERDRAFT FEE REFUND', { payee: 'Synthetic bank', day: '2026-10-06' });
});
register('C5', 'October profit (late fee on loan waived) control', 500000, b => {
  sale(b); loan(b);
  b.add('late', 5000, 'outflow', 'LATE FEE', { payee: null, slug: 'debt', day: '2026-10-05' });
  b.add('waive', 5000, 'inflow', 'LATE FEE WAIVED', { payee: null, slug: 'debt', day: '2026-10-08' });
});
register('C6', 'October profit (line-of-credit interest charge, draws and repayment proved) control', 500000 - 12000, b => {
  sale(b); b.addAccount('loc', 'line_of_credit', '6666', { label: 'Credit line', institution: 'Credit line' });
  b.add('ichg', 12000, 'outflow', 'INTEREST CHARGE', { payee: null, slug: 'loc', day: '2026-10-25' });
});
register('C7', 'October profit (merchant refund on card for counted purchase) control', 500000 - 30000, b => {
  sale(b); b.addAccount('card', 'card', '3333', { label: 'Business card', institution: 'Card issuer' });
  b.add('buy', 50000, 'outflow', 'SUPPLIER ORDER 77', { payee: 'Supplier', slug: 'card' });
  b.add('ref', 20000, 'inflow', 'SUPPLIER REFUND', { payee: 'Supplier', slug: 'card', day: '2026-10-18' });
});


}
{
 const register=(id,question,truth,build,opts={})=>certHuntCases.push({id:"p03/"+id,question,truth,build,opts});
const sale = b => b.add('sale', 500000, 'inflow', 'CLIENT INVOICE 1001', { payee: 'Client' });
const loan = b => b.addAccount('debt', 'loan', '2222', { label: 'Recorded lender', institution: 'Recorded lender' });
const card = b => b.addAccount('card', 'card', '3333', { label: 'Business card', institution: 'Card issuer' });

// P1f (corrected): first biweekly payment reconciled by lender receipts; the second is not split (truth $340 interest),
// and the first payment's interest posting 5 days earlier silences the unseparated-interest gap for the second.
register('P1f', 'October cash-basis profit (two biweekly loan payments, only the first split by the lender)', 500000 - 35000 - 34000, b => {
  sale(b); loan(b);
  b.add('pay1', 125000, 'outflow', 'PAYMENT TO LOAN 2222', { payee: 'Recorded lender', day: '2026-10-05' });
  b.add('pri1', 90000, 'inflow', 'PRINCIPAL PAYMENT', { payee: null, slug: 'debt', day: '2026-10-05' });
  b.add('int1', 35000, 'inflow', 'INTEREST PAYMENT', { payee: null, slug: 'debt', day: '2026-10-05' });
  b.add('pay2', 125000, 'outflow', 'PAYMENT TO LOAN 2222', { payee: null, day: '2026-10-10' });
  b.add('ack2', 125000, 'inflow', 'PAYMENT RECEIVED', { payee: null, slug: 'debt', day: '2026-10-10' });
});

// P26: personal purchase on the business card recorded as an owner draw, then refunded by the merchant.
register('P26', 'October business profit (owner-draw card purchase later refunded by the merchant)', 500000, b => {
  sale(b); card(b);
  b.add('pbuy', 40000, 'outflow', 'HOME GOODS STORE', { payee: 'Home goods store', slug: 'card', category: 'Owner Draw', day: '2026-10-04' });
  b.add('pref', 40000, 'inflow', 'HOME GOODS STORE REFUND', { payee: 'Home goods store', slug: 'card', day: '2026-10-09' });
});
// P42: lender refunds an overpaid principal payment.
register('P42a', 'October business profit (lender refunds an overpayment on a proved loan payoff)', 500000, b => {
  sale(b); loan(b);
  b.add('pay', 130000, 'outflow', 'PAYMENT TO LOAN 2222', { payee: null, day: '2026-10-05' });
  b.add('ack', 130000, 'inflow', 'PRINCIPAL PAYMENT', { payee: null, slug: 'debt', day: '2026-10-05' });
  b.add('over', 5000, 'inflow', 'LOAN OVERPAYMENT REFUND', { payee: 'Recorded lender', day: '2026-10-20' });
});
register('P42b', 'October business profit (card issuer refunds an overpaid card balance)', 500000 - 80000, b => {
  sale(b); card(b);
  b.add('buy', 80000, 'outflow', 'SUPPLIER ORDER 88', { payee: 'Supplier', slug: 'card', day: '2026-10-03' });
  b.add('pay', 100000, 'outflow', 'PAYMENT TO CARD 3333', { payee: null, day: '2026-10-08' });
  b.add('ack', 100000, 'inflow', 'PAYMENT THANK YOU', { payee: null, slug: 'card', day: '2026-10-08' });
  b.add('over', 20000, 'inflow', 'CARD OVERPAYMENT REFUND', { payee: 'Card issuer', day: '2026-10-22' });
});
register('P42c', 'October business profit (card issuer credit balance refund) control', 500000 - 80000, b => {
  sale(b); card(b);
  b.add('buy', 80000, 'outflow', 'SUPPLIER ORDER 88', { payee: 'Supplier', slug: 'card', day: '2026-10-03' });
  b.add('pay', 100000, 'outflow', 'PAYMENT TO CARD 3333', { payee: null, day: '2026-10-08' });
  b.add('ack', 100000, 'inflow', 'PAYMENT THANK YOU', { payee: null, slug: 'card', day: '2026-10-08' });
  b.add('over', 20000, 'inflow', 'CREDIT BALANCE REFUND', { payee: 'Card issuer', day: '2026-10-22' });
});

// P35: line of credit posts the interest accrual AND the lender splits the payment into principal+interest receipts.
register('P35', 'October profit (credit-line interest $120: accrual charge plus split payment receipts)', 500000 - 12000, b => {
  sale(b); b.addAccount('loc', 'line_of_credit', '6666', { label: 'Credit line', institution: 'Credit line' });
  b.add('ichg', 12000, 'outflow', 'INTEREST CHARGE', { payee: null, slug: 'loc', day: '2026-10-01' });
  b.add('pay', 112000, 'outflow', 'PAYMENT TO LOAN 6666', { payee: 'Credit line', day: '2026-10-10' });
  b.add('pri', 100000, 'inflow', 'PRINCIPAL PAYMENT', { payee: null, slug: 'loc', day: '2026-10-10' });
  b.add('int', 12000, 'inflow', 'INTEREST PAYMENT', { payee: null, slug: 'loc', day: '2026-10-10' });
});

// P43: interest waived on a loan whose interest was never counted (non-cash credit on the liability).
register('P43', 'October profit (lender waives $200 interest; no interest charge recorded)', 500000, b => {
  sale(b); loan(b);
  b.add('waive', 20000, 'inflow', 'INTEREST WAIVED', { payee: null, slug: 'debt', day: '2026-10-15' });
});

// Date controls (cash basis on posting dates).
register('D1', 'November 1-12 profit (October card purchase refunded Nov 3) control', 20000, b => {
  card(b);
  b.add('buy', 20000, 'outflow', 'SUPPLIER ORDER 90', { payee: 'Supplier', slug: 'card', day: '2026-10-30' });
  b.add('ref', 20000, 'inflow', 'SUPPLIER REFUND', { payee: 'Supplier', slug: 'card', day: '2026-11-03' });
}, { period: { period_from: '2026-11-01', period_to: '2026-11-12', time_zone: 'America/Phoenix' } });
register('D2', 'October profit (confirmed chargeback debit) control', 500000 - 15000, b => {
  sale(b);
  b.add('cb', 15000, 'outflow', 'CHARGEBACK CASE 4411', { payee: 'Client', category: 'Chargebacks' });
});
register('D3', 'October profit (interest earned on savings) control', 500000 + 820, b => {
  sale(b);
  b.add('ie', 820, 'inflow', 'INTEREST EARNED', { payee: 'Synthetic bank' });
});


}
{
 const register=(id,question,truth,build,opts={})=>certHuntCases.push({id:"p05/"+id,question,truth,build,opts});
const sale = b => b.add('sale', 500000, 'inflow', 'CLIENT INVOICE 1001', { payee: 'Client' });
const card = b => b.addAccount('card', 'card', '3333', { label: 'Business card', institution: 'Card issuer' });

register('W1', 'October profit (issuer charges off part of the card balance; non-cash)', 500000 - 50000, b => {
  sale(b); card(b);
  b.add('buy', 50000, 'outflow', 'SUPPLIER ORDER 91', { payee: 'Supplier', slug: 'card', day: '2026-10-03' });
  b.add('co', 30000, 'inflow', 'BALANCE CHARGE OFF', { payee: null, slug: 'card', day: '2026-10-25' });
});
register('R1', 'October profit (manufacturer rebate check deposited; purchases were from a reseller)', 500000 - 90000 + 9000, b => {
  sale(b);
  b.add('buy', 90000, 'outflow', 'RESELLER ORDER 12', { payee: 'Reseller', day: '2026-10-03' });
  b.add('reb', 9000, 'inflow', 'MANUFACTURER REBATE', { payee: 'Manufacturer', day: '2026-10-21' });
});
register('CB1', 'October profit (debit-card supplier purchase disputed and won on checking)', 500000 - 60000 + 60000, b => {
  sale(b);
  b.add('buy', 60000, 'outflow', 'DEBIT CARD SUPPLIER ORDER', { payee: 'Supplier', day: '2026-10-03' });
  b.add('won', 60000, 'inflow', 'DISPUTE WON', { payee: 'Synthetic bank', day: '2026-10-21' });
});
register('F1', 'October profit (processor net payout; fee charged separately on checking)', 500000 + 97000 - 3000, b => {
  sale(b);
  b.add('payout', 97000, 'inflow', 'STRIPE PAYOUT', { payee: 'Stripe', category: 'Income', day: '2026-10-05' });
  b.add('fee', 3000, 'outflow', 'STRIPE MONTHLY FEE', { payee: 'Stripe', day: '2026-10-06' });
});

}

for(const c of certHuntCases) for(const mode of ['manual','live']) test(`CERT HUNT ${c.id}/${mode}`,async t=>{
 const f=certBook(t,mode);await c.build(f);
 const period=c.opts.period||OCT;const rows=await f.query('SELECT * FROM txn ORDER BY id',period);
 assert.ok(rows.rows.length,'all-history classification decision was reached');
 const r=c.opts.sql?await f.query(c.opts.sql,period):await f.profit(period);
 const figure=r.rows[0]?.[c.opts.sql?'n':c.opts.col||'cash_profit_minor'];
 assert.ok(Number.isSafeInteger(figure),'a numeric answer is always returned');
 assert.equal(figure,certPinnedProfitFigures[c.id+'/'+mode],'primary figure unchanged from pinned source');
 t.diagnostic(JSON.stringify({hunt:c.id,mode,figure,truth:c.truth,percent:r.confidence.percent,text:r.confidence_text}));
 assert.ok(figure===c.truth||r.confidence.percent<90,'every wrong replay is below High');
 if(r.confidence.percent<90)assert.match(r.confidence_text,/Reasons:.*Missing:/s);
});

// Private snapshot properties exercise the real certifier, never SQL-derived
// evidence columns. Every negative arm has a separately proved green control.
function certRow(overrides={}) {
 return {id:1,tenant_id:'tenant',account_slug:'checking',account_identity:'checking',account:'1111',
  posted_on:'2026-10-12',amount_minor:10000,currency:'USD',direction:'outflow',account_kind:'checking',account_basis:'confirmed',
  description:'ACH DEBIT',payee:'Outside supplier',category:null,category_basis_state:null,...overrides};
}
function certDecision(row,overrides={}) {return {id:row.id,money_kind:'ordinary',estimated:0,estimate_reason:null,refund_minor:0,interest_expense_minor:0,...overrides};}
function certifyRows(rows,decisions=rows.map(r=>certDecision(r)),accounts=[],pairs=[],entities=[]) {
 assert.equal(typeof certEvidence.certifyMoneyKinds,'function','certifier entry point exists');
 certEvidence.certifyMoneyKinds(rows,decisions,accounts,pairs,entities);
 for(const d of decisions){const r=rows.find(r=>r.id===d.id);if(!r.amount_minor)continue;
  const proved=certEvidence.MONEY_KIND_PROOFS.includes(d.kind_proof);
  assert.equal(Number(proved)+Number(d.estimated===1),1,'nonzero posting is proved xor estimated');
  if(!proved){assert.ok(d.estimate_reason);assert.ok(certEvidence.MONEY_KIND_DOUBTS.includes(d.kind_unproved));}
 }
 return decisions;
}
test('CERT PROPERTY default cannot certify an excluded unknown kind',()=>{
 const r=certRow(),d=certDecision(r,{money_kind:'unlisted_kind'});
 const [out]=certifyRows([r],[d]);assert.equal(out.estimated,1);assert.equal(out.kind_unproved,'kind_not_proved');
 const [green]=certifyRows([r]);assert.equal(green.kind_proof,'party');
});
test('CERT PROPERTY earlier uncertainty and reason are monotone',()=>{
 const r=certRow({category:'Rent',category_basis_state:'confirmed'});
 const d=certDecision(r,{estimated:1,estimate_reason:'earlier_reason',uncertain_kind:'loan_payment'});
 certifyRows([r],[d]);assert.equal(d.estimated,1);assert.equal(d.estimate_reason,'earlier_reason');assert.equal(d.uncertain_kind,'loan_payment');
 const [green]=certifyRows([r]);assert.equal(green.kind_proof,'code');
});
test('CERT PROPERTY doubts precede category certificates and entity suffixes cannot escape',()=>{
 const r=certRow({payee:'Holding group',category:'Rent',category_basis_state:'confirmed'});
 const [green]=certifyRows([r]);assert.equal(green.kind_proof,'code');
 const [bad]=certifyRows([r],undefined,[],[],[{tenant_id:'tenant',legal_name:'Holding group LLC'}]);
 assert.equal(bad.kind_unproved,'counterparty_is_owned_entity');
 const [prefix]=certifyRows([{...r,payee:'Holding group operating 2244'}],undefined,[],[],[{tenant_id:'tenant',legal_name:'Holding group LLC'}]);
 assert.equal(prefix.kind_unproved,'counterparty_is_owned_entity');
});
test('CERT PROPERTY 240 generated rail rows and unmatched refunds cannot certify from wording',()=>{
 const vocab=['issuer','owner','refund','loan','merchant','vendor','principal','savings'];
 const rails=['payment','pmt','pymt','epay','autopay','bill pay','ach','wire','transfer','xfer','withdrawal','deposit','check','draft','debit','credit','zelle','venmo','paypal','sweep','payoff'];
 for(let i=0;i<240;i++){
  const r=certRow({id:i+1,payee:null,description:`${vocab[i%vocab.length]} ${rails[i%rails.length]} ${vocab[(i*3+2)%vocab.length]}`});
  const [d]=certifyRows([r]);assert.equal(d.estimated,1,`rail arm ${i} reached`);
  const credit={...r,direction:'inflow'};const [returned]=certifyRows([credit],[certDecision(credit,{money_kind:'refund',refund_minor:credit.amount_minor})]);
  assert.equal(returned.estimated,1,'unmatched refund decision reached');
 }
 const [green]=certifyRows([certRow({description:'OFFICE SUPPLIER',payee:null})]);assert.equal(green.kind_proof,'party');
});
test('CERT PROPERTY ordinary first receipts and feed categories count at face value',()=>{
 for(const o of [{},{category:'Income',provenance:'feed',category_basis_state:'proposed'}]){
  const r=certRow({direction:'inflow',payee:'New customer',description:'INVOICE 2',...o});
  const [d]=certifyRows([r]);assert.equal(d.estimated,0);assert.equal(d.kind_proof,'face_value');
 }
 const [green]=certifyRows([certRow({direction:'inflow',category:'Income',category_basis_state:'confirmed'})]);assert.equal(green.kind_proof,'code');
});
test('CERT PROPERTY original consumption budget and excluded-original veto',()=>{
 const buy=certRow({id:1,posted_on:'2026-10-01',amount_minor:10000});
 const a=certRow({id:2,posted_on:'2026-10-05',direction:'inflow',amount_minor:7000,description:'REFUND'}),b={...a,id:3,posted_on:'2026-10-06'};
 const ds=[certDecision(buy),certDecision(a,{money_kind:'refund',refund_minor:7000}),certDecision(b,{money_kind:'refund',refund_minor:7000})];
 certifyRows([buy,a,b],ds);assert.equal(ds[1].kind_proof,'original');assert.equal(ds[2].kind_unproved,'refund_original_not_counted');
 const draw=certRow({id:4,posted_on:'2026-10-02',amount_minor:7000,category:'Owner Draw',category_basis_state:'confirmed'});
 const more=[certDecision(buy),certDecision(draw,{money_kind:'owner_money'}),certDecision(a,{money_kind:'refund',refund_minor:7000})];
 certifyRows([buy,draw,a],more);assert.equal(more[2].kind_unproved,'refund_original_not_counted');
});
test('CERT PROPERTY card account alone cannot prove a promotional balance is spending',()=>{
 const r=certRow({account_kind:'card',description:'PROMOTIONAL BALANCE 0 APR',payee:null});
 const [d]=certifyRows([r]);assert.equal(d.estimated,1);
 const [green]=certifyRows([{...r,payee:'Office supplier',description:'Office purchase'}]);assert.equal(green.kind_proof,'account');
});
test('CERT PROPERTY removing evidence never raises a scoped score',()=>{
 const r=certRow(),base=certifyRows([r]);assert.equal(base[0].kind_proof,'party');
 for(const [row,pairs,entities] of [[{...r,payee:null},[],[]],[r,[{out_id:1,in_id:2,proved:0}],[]],
  [{...r,payee:'Holding group'},[],[{tenant_id:'tenant',legal_name:'Holding group LLC'}]]]){
  const [d]=certifyRows([row],undefined,[],pairs,entities);assert.equal(d.estimated,1);
 }
});
test('CERT PROPERTY interest-word coincidence is not a payment split',()=>{
 const debit=certRow({id:1,payee:null,description:'PAYMENT TO LOAN 2222'}),other=certRow({id:2,direction:'inflow',amount_minor:312,description:'INTEREST EARNED'});
 const cover={tenant_id:'tenant',account_slug:'checking',account_identity:'checking',account:'1111',coverage_status:'complete',coverage_basis_state:'confirmed',covered_from:'2026-10-01',covered_to:'2026-10-31',last_sync:'2026-11-13'};
 const snap={rows:[debit,other],accounts:[],pairs:[],coverage:[cover],pending:[]};
 const decisions=[certDecision(debit,{money_kind:'loan_payment'}),certDecision(other)];
 const opts={selection:{from:'2026-10-01',to:'2026-10-31'}};
 const bad=certQuality.moneyQueryQuality(snap,decisions,opts);assert.ok(bad.gaps.some(g=>g.code==='loan_interest_unseparated'));
 decisions[0].interest_bound=1;
 const green=certQuality.moneyQueryQuality(snap,decisions,opts);assert.ok(!green.gaps.some(g=>g.code==='loan_interest_unseparated'),'bound debit control reaches suppression');
});

{
 const {DatabaseSync}=await import('node:sqlite');
 const {readFileSync,readdirSync}=await import('node:fs');
 const WT=new URL('../../',import.meta.url).pathname.replace(/\/$/,'');
const NOW = Date.parse('2026-11-14T18:00:00Z');
const TZ = 'America/Phoenix';
const PERIOD = { period_from: '2026-10-01', period_to: '2026-10-31', time_zone: TZ };
const at = '2026-10-31T12:00:00Z';



function book({ businessName = 'business', householdName = 'household' } = {}) {
  const db = new DatabaseSync(':memory:');
  const dir = `${WT}/migrations/d1/`;
  for (const name of readdirSync(dir).filter(n => n.endsWith('.sql')).sort())
    db.exec(readFileSync(dir + name, 'utf8'));
  const calls = [];
  const statement = (sql, binds = []) => ({
    bind: (...values) => statement(sql, values),
    all: async () => ({ success: true, results: db.prepare(sql).all(...binds) }),
    first: async () => db.prepare(sql).get(...binds) ?? null,
  });
  const env = { STORAGE: 'd1', BRAIN_TIMEZONE: TZ, DB: {
    prepare(sql) { calls.push(sql); return statement(sql); },
    batch: async statements => Promise.all(statements.map(s => s.all())),
  } };
  const run = (sql, ...binds) => db.prepare(sql).run(...binds);
  for (const [slug, kind, legal] of [['business', 'business', businessName], ['household', 'household', householdName]])
    run(`INSERT INTO fin_entities(entity_slug,legal_name,kind,provenance,basis_state,recorded_at)
      VALUES (?,?,?,'owner_stated','confirmed',?)`, slug, legal, kind, at);
  function account(slug, { mode = 'manual', entity = 'business', mask = '1111', kind = 'checking', currency = 'USD',
    label = slug, institution = null } = {}) {
    run(`INSERT INTO fin_accounts(account_slug,entity_slug,label,institution,account_kind,balance_role,mask,currency,
      feed_mode,provenance,basis_state,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,'owner_stated','confirmed',?)`,
    slug, entity, label, institution, kind, ['card', 'loan', 'line_of_credit'].includes(kind) ? 'liability' : 'asset', mask, currency, mode, at);
  }
  let n = 0;
  function row(slug, cents, { day = '2026-10-10', direction = 'outflow', memo = null, payee = null,
    category = null, categoryBasis = 'confirmed', currency = 'USD', pending = 0, uid, provenance = 'owner_stated' } = {}) {
    run(`INSERT INTO fin_transactions(txn_uid,account_slug,posted_on,amount_minor,direction,currency,
      description,payee,category,category_basis_state,pending,provenance,source_feed,basis_state,recorded_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'confirmed',?)`,
    uid ?? `r${++n}`, slug, day, cents, direction, currency, memo, payee, category, category ? categoryBasis : 'confirmed', pending,
    provenance, provenance === 'feed' ? 'bank-feed:' + slug : null, at);
  }
  function coverage(slug, from = '2026-01-01', to = '2026-11-13') {
    run(`INSERT INTO fin_account_coverage(account_slug,coverage_status,covered_from,covered_to,
      provenance,basis_state,computed_at,recorded_at) VALUES (?,'complete',?,?,'owner_stated','confirmed',?,?)`, slug, from, to, at, at);
  }
  // Synthetic connected-feed evidence (mirrors the worker test helper): a
  // ciphertext-shaped placeholder, a Plaid assignment and a fresh successful sync.
  function connection(slug, entity = 'business', syncedAt = '2026-11-14T17:00:00Z') {
    const ref = 'acct_' + Buffer.from(slug).toString('hex').padEnd(32, '0').slice(0, 32);
    run('UPDATE fin_accounts SET external_ref=?,feed_mode=? WHERE account_slug=?', ref, 'live', slug);
    run(`INSERT INTO bank_feed_items(item_ref,access_ciphertext,access_iv,environment,status,status_detail,connected_at,removed_at,last_synced_at)
      VALUES (?,?,?,'production','connected','Synthetic status',?,NULL,?)`, slug, Buffer.from('synthetic storage bytes').toString('base64'),
    Buffer.from('synthetic iv').toString('base64'), at, syncedAt);
    run(`INSERT INTO plaid_account_entity_assignments(item_ref,provider_account_id,account_ref,entity_slug,discovered_at,last_seen_at,assigned_at,updated_at)
      VALUES (?,'synthetic',?,?,?,?,?,?)`, slug, ref, entity, at, syncedAt, at, at);
    run(`INSERT INTO bank_feed_health(tenant_id,item_ref,last_successful_sync_at,data_through) VALUES ('primary',?,?,?)`,
      slug, syncedAt, syncedAt.slice(0, 10));
  }
  const q = (sql, period = PERIOD, extra = {}) => queryMoney(env, { sql, ...period, ...extra }, { now: () => NOW });
  return { db, env, run, calls, account, row, coverage, connection, q };
}

const guide = moneyGuideFor({ now: NOW, timeZone: TZ });
const recipe = name => {
  const m = guide.match(new RegExp(`\\n${name}:[^\\n]*\\n([^\\n]+)`));
  if (!m) throw new Error('guide recipe missing: ' + name);
  return m[1].replaceAll('2026-09-01', PERIOD.period_from).replaceAll('2026-09-30', PERIOD.period_to).replace(/;$/, '');
};
const RECIPES = {
  Income: recipe('Income'), Spending: recipe('Spending'), Profit: recipe('Profit'),
  CashFlow: recipe('Cash flow'), OwnTransfers: recipe('Own transfers'),
};
const B = ` WHERE posted_on BETWEEN '${PERIOD.period_from}' AND '${PERIOD.period_to}'`;
const SIMPLE = {
  I: `SELECT SUM(income_minor) AS n FROM txn${B}`,
  E: `SELECT SUM(expense_minor + interest_expense_minor - refund_minor) AS n FROM txn${B}`,
  Egross: `SELECT SUM(expense_minor) AS n FROM txn${B}`,
  P: `SELECT SUM(paid_minor) AS n FROM txn${B}`,
};
const supportSql = `SELECT txn_uid,account,currency,posted_on,direction,amount_minor,description,payee,money_kind,estimated,estimate_reason,possible_transfer,transfer_basis,income_minor,expense_minor,refund_minor,paid_minor FROM txn ORDER BY posted_on,id`;


const BIZ = { businessName: 'Synthetic Shop LLC', householdName: 'Owner Person' };
const base = (f, slug = 'chk') => {
  f.row(slug, 500000, { direction: 'inflow', memo: 'Customer payment', payee: 'Synthetic customer', day: '2026-10-05' });
  f.row(slug, 30000, { memo: 'Office supplies', payee: 'Synthetic supplier', day: '2026-10-06' });
};
const acct = (f, live, slug, opts) => { f.account(slug, opts); f.coverage(slug); if (live) f.connection(slug, opts.entity || 'business'); };
const spendRow = r => r.rows.reduce((n, x) => n + (x.spending_minor || 0), 0);

const CASES = [];
const add = (id, kind, question, build, measures, note) => CASES.push({ id, kind, question, build, measures, note });

// T01 control: proved reciprocal own transfer.
add('T01', 'control', 'How much did the business earn and spend in October (a $1,000 move checking 1111 -> savings 2222 happened)?',
  (f, live) => { acct(f, live, 'chk', { mask: '1111' }); acct(f, live, 'sav', { mask: '2222', kind: 'savings' }); base(f);
    f.row('chk', 100000, { memo: 'Online transfer to savings 2222', day: '2026-10-12' });
    f.row('sav', 100000, { direction: 'inflow', memo: 'Online transfer from checking 1111', day: '2026-10-12' }); },
  [['I', SIMPLE.I, 500000], ['E', SIMPLE.E, 30000], ['Profit', RECIPES.Profit, 470000, r => r.rows[0]?.cash_profit_minor]]);

// T02 transfer with the bank fee folded into the outgoing leg.
add('T02', 'fee', 'What did the business spend in October? ($1,015 left checking for a $1,000 savings deposit; $15 is the fee)',
  (f, live) => { acct(f, live, 'chk', { mask: '1111' }); acct(f, live, 'sav', { mask: '2222', kind: 'savings' }); base(f);
    f.row('chk', 101500, { memo: 'Online transfer to savings 2222', day: '2026-10-12' });
    f.row('sav', 100000, { direction: 'inflow', memo: 'Online transfer from checking 1111', day: '2026-10-12' }); },
  [['E', SIMPLE.E, 31500], ['I', SIMPLE.I, 500000]]);

// T03 control: separate fee row next to a proved transfer.
add('T03', 'control', 'What did the business spend in October? (proved $1,000 transfer plus a separate $15 transfer fee)',
  (f, live) => { acct(f, live, 'chk', { mask: '1111' }); acct(f, live, 'sav', { mask: '2222', kind: 'savings' }); base(f);
    f.row('chk', 100000, { memo: 'Online transfer to savings 2222', day: '2026-10-12' });
    f.row('sav', 100000, { direction: 'inflow', memo: 'Online transfer from checking 1111', day: '2026-10-12' });
    f.row('chk', 1500, { memo: 'Transfer fee', day: '2026-10-12' }); },
  [['E', SIMPLE.E, 31500]]);

// T04 control: recognized transfer straddling the month end.
add('T04', 'control', 'What did the business spend in October? (transfer left checking Oct 31, reached savings Nov 2)',
  (f, live) => { acct(f, live, 'chk', { mask: '1111' }); acct(f, live, 'sav', { mask: '2222', kind: 'savings' }); base(f);
    f.row('chk', 300000, { memo: 'Online transfer to savings 2222', day: '2026-10-31' });
    f.row('sav', 300000, { direction: 'inflow', memo: 'Online transfer from checking 1111', day: '2026-11-02' }); },
  [['E', SIMPLE.E, 30000]]);

// T05 month-end transfer whose bank wording has no transfer verb; both accounts connected.
add('T05', 'cross-period', 'What did the business spend in October? (checking -> savings move posted Oct 31 / Nov 2 with "Withdrawal to savings" / "Deposit from checking" wording)',
  (f, live) => { acct(f, live, 'chk', { mask: '1111' }); acct(f, live, 'sav', { mask: '2222', kind: 'savings' }); base(f);
    f.row('chk', 300000, { memo: 'Withdrawal to savings ...2222', day: '2026-10-31' });
    f.row('sav', 300000, { direction: 'inflow', memo: 'Deposit from checking ...1111', day: '2026-11-02' }); },
  [['E', SIMPLE.E, 30000], ['Profit', RECIPES.Profit, 470000, r => r.rows[0]?.cash_profit_minor]]);

// T06 same wording inside one month (matched control for T05's penalty).
add('T06', 'same-period', 'What did the business spend in October? (same move, both legs Oct 15)',
  (f, live) => { acct(f, live, 'chk', { mask: '1111' }); acct(f, live, 'sav', { mask: '2222', kind: 'savings' }); base(f);
    f.row('chk', 300000, { memo: 'Withdrawal to savings ...2222', day: '2026-10-15' });
    f.row('sav', 300000, { direction: 'inflow', memo: 'Deposit from checking ...1111', day: '2026-10-15' }); },
  [['E', SIMPLE.E, 30000]]);

// T07 same-period move, but the owner asks about checking 1111 only (account_slugs scope).
add('T07', 'scope', 'What did checking 1111 spend in October? (its $3,000 debit landed in connected savings 2222 the same day)',
  (f, live) => { acct(f, live, 'chk', { mask: '1111' }); acct(f, live, 'sav', { mask: '2222', kind: 'savings' }); base(f);
    f.row('chk', 300000, { memo: 'Withdrawal to savings ...2222', day: '2026-10-15' });
    f.row('sav', 300000, { direction: 'inflow', memo: 'Deposit from checking ...1111', day: '2026-10-15' }); },
  [['E chk only (account_slugs)', SIMPLE.E, 30000, null, { account_slugs: ['chk'] }],
   ['E chk only (SQL filter)', SIMPLE.E.replace(' WHERE ', " WHERE account='1111' AND "), 30000]]);

// T08 cross-currency: USD balance converted into EUR balance (both connected).
add('T08', 'fx', 'October spending and income by currency (USD 1,000.00 converted into EUR 920.00 inside the owner\'s multi-currency account)',
  (f, live) => { acct(f, live, 'usd', { mask: '3333', label: 'USD balance', institution: 'Wise' });
    acct(f, live, 'eur', { mask: '4444', currency: 'EUR', label: 'EUR balance', institution: 'Wise' }); base(f, 'usd');
    f.row('usd', 100000, { memo: 'Converted USD to EUR', payee: 'Wise', day: '2026-10-14' });
    f.row('eur', 92000, { direction: 'inflow', memo: 'Converted from USD', payee: 'Wise', day: '2026-10-14', currency: 'EUR' }); },
  [['Spending recipe USD', RECIPES.Spending, 30000, r => r.rows.find(x => x.currency === 'USD')?.spending_minor],
   ['Income recipe EUR', RECIPES.Income, null, r => r.rows.find(x => x.currency === 'EUR')?.income_minor ?? 0],
   ['Profit recipe (rows)', RECIPES.Profit, 'USD 470000 / EUR 0', r => r.rows.map(x => x.currency + ' ' + x.cash_profit_minor).join(' / ')]]);

// T09 partial legs: one $5,000 debit arrives as two $2,500 credits.
add('T09', 'partial-legs', 'October spending and income ($5,000 to savings arrived as two $2,500 credits)',
  (f, live) => { acct(f, live, 'chk', { mask: '1111' }); acct(f, live, 'sav', { mask: '2222', kind: 'savings' }); base(f);
    f.row('chk', 500000, { memo: 'Online transfer to savings 2222', day: '2026-10-12' });
    f.row('sav', 250000, { direction: 'inflow', memo: 'Online transfer from checking 1111', day: '2026-10-12' });
    f.row('sav', 250000, { direction: 'inflow', memo: 'Online transfer from checking 1111', day: '2026-10-13' }); },
  [['E', SIMPLE.E, 30000], ['I', SIMPLE.I, 500000]]);

// T10 card connected; checking pays it Oct 31 with an issuer descriptor; card credit posts Nov 2.
add('T10', 'card-payment', 'What did the business spend in October? (card 4444 purchases $2,000 in October, paid from checking Oct 31 "CAPITAL ONE ONLINE PYMT", card credit Nov 2)',
  (f, live) => { acct(f, live, 'chk', { mask: '1111' }); acct(f, live, 'card', { mask: '4444', kind: 'card', institution: 'Capital One' }); base(f);
    f.row('card', 120000, { memo: 'Synthetic hardware store', payee: 'Synthetic hardware store', day: '2026-10-08' });
    f.row('card', 80000, { memo: 'Synthetic software', payee: 'Synthetic software', day: '2026-10-20' });
    f.row('chk', 200000, { memo: 'CAPITAL ONE ONLINE PYMT', day: '2026-10-31' });
    f.row('card', 200000, { direction: 'inflow', memo: 'PAYMENT THANK YOU', day: '2026-11-02' }); },
  [['E', SIMPLE.E, 230000], ['Spending recipe', RECIPES.Spending, 230000, spendRow]]);

// T11 matched control for T10: same month, so the equal credit is visible.
add('T11', 'card-payment', 'Same as T10 but the card credit posts Oct 31 too',
  (f, live) => { acct(f, live, 'chk', { mask: '1111' }); acct(f, live, 'card', { mask: '4444', kind: 'card', institution: 'Capital One' }); base(f);
    f.row('card', 120000, { memo: 'Synthetic hardware store', payee: 'Synthetic hardware store', day: '2026-10-08' });
    f.row('card', 80000, { memo: 'Synthetic software', payee: 'Synthetic software', day: '2026-10-20' });
    f.row('chk', 200000, { memo: 'CAPITAL ONE ONLINE PYMT', day: '2026-10-29' });
    f.row('card', 200000, { direction: 'inflow', memo: 'PAYMENT THANK YOU', day: '2026-10-31' }); },
  [['E', SIMPLE.E, 230000]]);

// T12 control: card payment with a locator and the issuer's acknowledgement.
add('T12', 'control', 'What did the business spend in October? (card purchases $2,000; "Online payment to card 4444" + card "Payment thank you")',
  (f, live) => { acct(f, live, 'chk', { mask: '1111' }); acct(f, live, 'card', { mask: '4444', kind: 'card', institution: 'Chase' }); base(f);
    f.row('card', 200000, { memo: 'Synthetic hardware store', payee: 'Synthetic hardware store', day: '2026-10-08' });
    f.row('chk', 200000, { memo: 'Online payment to card 4444', day: '2026-10-20' });
    f.row('card', 200000, { direction: 'inflow', memo: 'Payment thank you', day: '2026-10-21' }); },
  [['E', SIMPLE.E, 230000], ['P', SIMPLE.P, 200000]]);

// T13 card connected, explicit "card ending 4444" memo, issuer as payee, month-end crossing.
add('T13', 'card-payment', 'What did the business spend in October? (card 4444 purchases $2,000; checking memo "Payment to Chase card ending 4444" payee Chase on Oct 30; card credit Nov 2)',
  (f, live) => { acct(f, live, 'chk', { mask: '1111' }); acct(f, live, 'card', { mask: '4444', kind: 'card', institution: 'Chase' }); base(f);
    f.row('card', 200000, { memo: 'Synthetic hardware store', payee: 'Synthetic hardware store', day: '2026-10-08' });
    f.row('chk', 200000, { memo: 'Payment to Chase card ending 4444', payee: 'Chase', day: '2026-10-30' });
    f.row('card', 200000, { direction: 'inflow', memo: 'Payment thank you', day: '2026-11-02' }); },
  [['E', SIMPLE.E, 230000], ['P', SIMPLE.P, 200000]]);

// T14 card NOT connected; explicit card memo with issuer payee.
add('T14', 'card-payment', 'What did the business spend in October? ("Payment to Chase card ending 4444", payee Chase; card not connected)',
  (f, live) => { acct(f, live, 'chk', { mask: '1111' }); base(f);
    f.row('chk', 200000, { memo: 'Payment to Chase card ending 4444', payee: 'Chase', day: '2026-10-20' }); },
  [['E', SIMPLE.E, 30000]], 'Right answer: $300 of recorded operating spending; the $2,000 is a card payment whose purchases are unrecorded.');

// T15 generic bank-coded legs that coincide by amount but are two outside payments.
// Connected: Plaid-shaped rows (provenance feed, detailed category, proposed basis).
// Manual: the same categories as proposed import hints.
add('T15', 'coincidence', 'October income and spending ($800 "Online Transfer" debit paid a contractor; an unrelated $800 "Online Transfer" credit from a customer hit savings the next day; the bank coded both as account transfers)',
  (f, live) => { acct(f, live, 'chk', { mask: '1111' }); acct(f, live, 'sav', { mask: '2222', kind: 'savings' }); base(f);
    const p = live ? { provenance: 'feed', categoryBasis: 'proposed' } : { categoryBasis: 'proposed' };
    f.row('chk', 80000, { memo: 'Online Transfer', category: 'TRANSFER_OUT_ACCOUNT_TRANSFER', day: '2026-10-16', ...p });
    f.row('sav', 80000, { direction: 'inflow', memo: 'Online Transfer', category: 'TRANSFER_IN_ACCOUNT_TRANSFER', day: '2026-10-17', ...p }); },
  [['I', SIMPLE.I, 580000], ['E', SIMPLE.E, 110000]], 'Evidence is bank transfer categories plus an amount/date coincidence.');

// T15c matched control: the same coded legs really are one own transfer.
add('T15c', 'control', 'Same coded legs as T15, but truly one own transfer checking -> savings',
  (f, live) => { acct(f, live, 'chk', { mask: '1111' }); acct(f, live, 'sav', { mask: '2222', kind: 'savings' }); base(f);
    const p = live ? { provenance: 'feed', categoryBasis: 'proposed' } : { categoryBasis: 'proposed' };
    f.row('chk', 80000, { memo: 'Online Transfer', category: 'TRANSFER_OUT_ACCOUNT_TRANSFER', day: '2026-10-16', ...p });
    f.row('sav', 80000, { direction: 'inflow', memo: 'Online Transfer', category: 'TRANSFER_IN_ACCOUNT_TRANSFER', day: '2026-10-17', ...p }); },
  [['I', SIMPLE.I, 500000], ['E', SIMPLE.E, 30000]]);

// T16 three-way control: checking -> savings -> card, all with locators.
add('T16', 'control', 'October spending (checking -> savings $2,000, savings pays card 4444 $2,000; card purchases $2,000)',
  (f, live) => { acct(f, live, 'chk', { mask: '1111' }); acct(f, live, 'sav', { mask: '2222', kind: 'savings' });
    acct(f, live, 'card', { mask: '4444', kind: 'card' }); base(f);
    f.row('card', 200000, { memo: 'Synthetic hardware store', payee: 'Synthetic hardware store', day: '2026-10-08' });
    f.row('chk', 200000, { memo: 'Online transfer to savings 2222', day: '2026-10-18' });
    f.row('sav', 200000, { direction: 'inflow', memo: 'Online transfer from checking 1111', day: '2026-10-18' });
    f.row('sav', 200000, { memo: 'Online payment to card 4444', day: '2026-10-19' });
    f.row('card', 200000, { direction: 'inflow', memo: 'Payment thank you', day: '2026-10-20' }); },
  [['E', SIMPLE.E, 230000]]);

// T17 three-way with an unrecognized middle hop crossing the month end.
add('T17', 'three-way', 'October spending (checking -> savings proved; savings pays card 4444 Oct 31 as "APPLECARD GSBANK PAYMENT"; card credit Nov 2; card purchases $2,000)',
  (f, live) => { acct(f, live, 'chk', { mask: '1111' }); acct(f, live, 'sav', { mask: '2222', kind: 'savings' });
    acct(f, live, 'card', { mask: '4444', kind: 'card' }); base(f);
    f.row('card', 200000, { memo: 'Synthetic hardware store', payee: 'Synthetic hardware store', day: '2026-10-08' });
    f.row('chk', 200000, { memo: 'Online transfer to savings 2222', day: '2026-10-28' });
    f.row('sav', 200000, { direction: 'inflow', memo: 'Online transfer from checking 1111', day: '2026-10-28' });
    f.row('sav', 200000, { memo: 'APPLECARD GSBANK PAYMENT', day: '2026-10-31' });
    f.row('card', 200000, { direction: 'inflow', memo: 'Payment thank you', day: '2026-11-02' }); },
  [['E', SIMPLE.E, 230000]]);

// T18 same-last-four collision: business savings 2222 and personal savings 2222.
add('T18', 'collision', 'Business October spending ($1,000 from business checking to the owner\'s personal savings 2222; business savings is also 2222)',
  (f, live) => { acct(f, live, 'chk', { mask: '1111' }); acct(f, live, 'bsav', { mask: '2222', kind: 'savings' });
    acct(f, live, 'psav', { mask: '2222', kind: 'savings', entity: 'household' }); base(f);
    f.row('chk', 100000, { memo: 'Online transfer to savings 2222', day: '2026-10-12' });
    f.row('psav', 100000, { direction: 'inflow', memo: 'Online transfer from checking 1111', day: '2026-10-12' }); },
  [['Spending recipe business', RECIPES.Spending, 30000, r => r.rows.find(x => x.side === 'business')?.spending_minor]]);

// T19 same-last-four collision with a card: owner card 4444 and personal checking 4444.
add('T19', 'collision', 'Business October spending (card 4444 purchases $2,000, paid "Online payment to card 4444"; a personal checking also ends 4444)',
  (f, live) => { acct(f, live, 'chk', { mask: '1111' }); acct(f, live, 'card', { mask: '4444', kind: 'card' });
    acct(f, live, 'pchk', { mask: '4444', entity: 'household' }); base(f);
    f.row('card', 200000, { memo: 'Synthetic hardware store', payee: 'Synthetic hardware store', day: '2026-10-08' });
    f.row('chk', 200000, { memo: 'Online payment to card 4444', day: '2026-10-20' });
    f.row('card', 200000, { direction: 'inflow', memo: 'Payment thank you', day: '2026-10-21' }); },
  [['Spending recipe business', RECIPES.Spending, 230000, r => r.rows.find(x => x.side === 'business')?.spending_minor]]);

// T20 wire to the business's own account at another bank (payee = recorded legal name).
add('T20', 'own-name', 'What did the business spend in October? ($5,000 "Wire out" to payee Synthetic Shop LLC, the business\'s own recorded legal name)',
  (f, live) => { acct(f, live, 'chk', { mask: '1111' }); base(f);
    f.row('chk', 500000, { memo: 'Wire out', payee: 'Synthetic Shop LLC', day: '2026-10-22' }); },
  [['E', SIMPLE.E, 30000], ['Profit', RECIPES.Profit, 470000, r => r.rows[0]?.cash_profit_minor]]);

// T21 money in from the business's own account elsewhere (payee = legal name).
add('T21', 'own-name', 'How much did the business earn in October? ($4,000 "ACH credit" from payee Synthetic Shop LLC, its own legal name)',
  (f, live) => { acct(f, live, 'chk', { mask: '1111' }); base(f);
    f.row('chk', 400000, { direction: 'inflow', memo: 'ACH credit', payee: 'Synthetic Shop LLC', day: '2026-10-22' }); },
  [['I', SIMPLE.I, 500000], ['Profit', RECIPES.Profit, 470000, r => r.rows[0]?.cash_profit_minor]]);

// T22 owner contribution by Zelle from the owner (payee = household legal name).
add('T22', 'own-name', 'How much did the business earn in October? ($2,500 "Zelle from Owner Person"; the household entity is recorded as Owner Person)',
  (f, live) => { acct(f, live, 'chk', { mask: '1111' }); base(f);
    f.row('chk', 250000, { direction: 'inflow', memo: 'Zelle from Owner Person', payee: 'Owner Person', day: '2026-10-22' }); },
  [['I', SIMPLE.I, 500000]]);

// T23 own-destination wording without a transfer verb; destination savings not connected.
add('T23', 'wording', 'What did the business spend in October? ($2,000 "To Savings ...2222"; savings not connected)',
  (f, live) => { acct(f, live, 'chk', { mask: '1111' }); base(f);
    f.row('chk', 200000, { memo: 'To Savings ...2222', day: '2026-10-22' }); },
  [['E', SIMPLE.E, 30000], ['Profit', RECIPES.Profit, 470000, r => r.rows[0]?.cash_profit_minor]]);

// T24 card issuer payment descriptor without card words; card not connected.
add('T24', 'card-payment', 'What did the business spend in October? ($2,000 "AMERICAN EXPRESS ACH PMT"; card not connected)',
  (f, live) => { acct(f, live, 'chk', { mask: '1111' }); base(f);
    f.row('chk', 200000, { memo: 'AMERICAN EXPRESS ACH PMT', day: '2026-10-22' }); },
  [['E', SIMPLE.E, 30000]], 'Right answer: $300 recorded operating spending; $2,000 is a likely card payment (purchases unrecorded).');

// T25 FX conversion out of the only connected (USD) account.
add('T25', 'fx', 'What did the business spend in October? (USD 1,000 "Converted USD to EUR", payee Wise; EUR balance not connected)',
  (f, live) => { acct(f, live, 'chk', { mask: '1111' }); base(f);
    f.row('chk', 100000, { memo: 'Converted USD to EUR', payee: 'Wise', day: '2026-10-22' }); },
  [['E', SIMPLE.E, 30000]]);

// T26 inflow from an unconnected own savings at another bank, payee = that bank.
add('T26', 'looks-like-income', 'How much did the business earn in October? ($3,000 "Deposit from Ally Bank", payee Ally Bank; the owner\'s unconnected savings)',
  (f, live) => { acct(f, live, 'chk', { mask: '1111' }); base(f);
    f.row('chk', 300000, { direction: 'inflow', memo: 'Deposit from Ally Bank', payee: 'Ally Bank', day: '2026-10-22' }); },
  [['I', SIMPLE.I, 500000]], 'Weakest structured evidence: only an institution payee.');

// T27 control: an ordinary vendor payment with no movement evidence stays High.
add('T27', 'control', 'What did the business spend in October? ($2,000 "Synthetic landlord rent", payee Synthetic landlord)',
  (f, live) => { acct(f, live, 'chk', { mask: '1111' }); base(f);
    f.row('chk', 200000, { memo: 'Synthetic landlord rent', payee: 'Synthetic landlord', day: '2026-10-22' }); },
  [['E', SIMPLE.E, 230000]]);


// T28 lag beyond the 3-day pair window, unrecognized wording, one-account question.
add('T28', 'lag', 'What did checking 1111 spend in October? ($3,000 "Withdrawal to savings ...2222" Fri Oct 9; savings shows "Deposit from checking ...1111" Wed Oct 14)',
  (f, live) => { acct(f, live, 'chk', { mask: '1111' }); acct(f, live, 'sav', { mask: '2222', kind: 'savings' }); base(f);
    f.row('chk', 300000, { memo: 'Withdrawal to savings ...2222', day: '2026-10-09' });
    f.row('sav', 300000, { direction: 'inflow', memo: 'Deposit from checking ...1111', day: '2026-10-14' }); },
  [['E chk only (account_slugs)', SIMPLE.E, 30000, null, { account_slugs: ['chk'] }], ['E all accounts', SIMPLE.E, 30000]]);

// T29 same-bank move, bank name as payee on both legs, posted 4 days apart (weekend).
add('T29', 'lag', 'October income and spending ($3,000 checking -> savings at the same bank, payee "First Synthetic Bank" on both legs, Fri Oct 16 -> Tue Oct 20)',
  (f, live) => { acct(f, live, 'chk', { mask: '1111', institution: 'First Synthetic Bank' }); acct(f, live, 'sav', { mask: '2222', kind: 'savings', institution: 'First Synthetic Bank' }); base(f);
    f.row('chk', 300000, { memo: 'Withdrawal to savings ...2222', payee: 'First Synthetic Bank', day: '2026-10-16' });
    f.row('sav', 300000, { direction: 'inflow', memo: 'Deposit from checking ...1111', payee: 'First Synthetic Bank', day: '2026-10-20' }); },
  [['I', SIMPLE.I, 500000], ['E', SIMPLE.E, 30000], ['Profit', RECIPES.Profit, 470000, r => r.rows[0]?.cash_profit_minor]]);

// T30 matched control for T29: the same legs two days apart.
add('T30', 'lag', 'Same as T29 but Oct 16 -> Oct 18',
  (f, live) => { acct(f, live, 'chk', { mask: '1111', institution: 'First Synthetic Bank' }); acct(f, live, 'sav', { mask: '2222', kind: 'savings', institution: 'First Synthetic Bank' }); base(f);
    f.row('chk', 300000, { memo: 'Withdrawal to savings ...2222', payee: 'First Synthetic Bank', day: '2026-10-16' });
    f.row('sav', 300000, { direction: 'inflow', memo: 'Deposit from checking ...1111', payee: 'First Synthetic Bank', day: '2026-10-18' }); },
  [['I', SIMPLE.I, 500000], ['E', SIMPLE.E, 30000]]);

// T31 recognized wording, 5-day lag: protected by the locator rule (control).
add('T31', 'control', 'October spending ("Online transfer to savings 2222" Oct 9, "Online transfer from checking 1111" Oct 14)',
  (f, live) => { acct(f, live, 'chk', { mask: '1111' }); acct(f, live, 'sav', { mask: '2222', kind: 'savings' }); base(f);
    f.row('chk', 300000, { memo: 'Online transfer to savings 2222', day: '2026-10-09' });
    f.row('sav', 300000, { direction: 'inflow', memo: 'Online transfer from checking 1111', day: '2026-10-14' }); },
  [['E', SIMPLE.E, 30000]]);

// T32 connected card, issuer descriptor, card credit posts 5 days after the bank debit.
add('T32', 'card-payment', 'What did the business spend in October? (card 4444 purchases $2,000; checking "CAPITAL ONE ONLINE PYMT" Fri Oct 9; card "PAYMENT THANK YOU" Wed Oct 14)',
  (f, live) => { acct(f, live, 'chk', { mask: '1111' }); acct(f, live, 'card', { mask: '4444', kind: 'card', institution: 'Capital One' }); base(f);
    f.row('card', 200000, { memo: 'Synthetic hardware store', payee: 'Synthetic hardware store', day: '2026-10-03' });
    f.row('chk', 200000, { memo: 'CAPITAL ONE ONLINE PYMT', day: '2026-10-09' });
    f.row('card', 200000, { direction: 'inflow', memo: 'PAYMENT THANK YOU', day: '2026-10-14' }); },
  [['E', SIMPLE.E, 230000], ['P', SIMPLE.P, 200000]]);

// T33 like T29, but only the receiving leg carries the bank's name as payee.
add('T33', 'lag', 'October income and spending ($3,000 checking -> savings; debit "Withdrawal to savings ...2222" Fri Oct 16; credit "Deposit from checking ...1111" payee "First Synthetic Bank" Tue Oct 20)',
  (f, live) => { acct(f, live, 'chk', { mask: '1111', institution: 'First Synthetic Bank' }); acct(f, live, 'sav', { mask: '2222', kind: 'savings', institution: 'Second Synthetic Bank' }); base(f);
    f.row('chk', 300000, { memo: 'Withdrawal to savings ...2222', day: '2026-10-16' });
    f.row('sav', 300000, { direction: 'inflow', memo: 'Deposit from checking ...1111', payee: 'First Synthetic Bank', day: '2026-10-20' }); },
  [['I', SIMPLE.I, 500000], ['E', SIMPLE.E, 30000], ['Profit', RECIPES.Profit, 470000, r => r.rows[0]?.cash_profit_minor]]);

// T34 matched control for T33: the same legs on one day.
add('T34', 'lag', 'Same as T33 but both legs Oct 16',
  (f, live) => { acct(f, live, 'chk', { mask: '1111', institution: 'First Synthetic Bank' }); acct(f, live, 'sav', { mask: '2222', kind: 'savings', institution: 'Second Synthetic Bank' }); base(f);
    f.row('chk', 300000, { memo: 'Withdrawal to savings ...2222', day: '2026-10-16' });
    f.row('sav', 300000, { direction: 'inflow', memo: 'Deposit from checking ...1111', payee: 'First Synthetic Bank', day: '2026-10-16' }); },
  [['I', SIMPLE.I, 500000], ['E', SIMPLE.E, 30000]]);

 const beforeFigures={"T01/manual/I":500000,"T01/manual/E":30000,"T01/manual/Profit":470000,"T01/connected/I":500000,"T01/connected/E":30000,"T01/connected/Profit":470000,"T02/manual/E":30000,"T02/manual/I":500000,"T02/connected/E":30000,"T02/connected/I":500000,"T03/manual/E":31500,"T03/connected/E":31500,"T04/manual/E":30000,"T04/connected/E":30000,"T05/manual/E":330000,"T05/manual/Profit":170000,"T05/connected/E":330000,"T05/connected/Profit":170000,"T06/manual/E":330000,"T06/connected/E":330000,"T07/manual/E chk only (account_slugs)":330000,"T07/manual/E chk only (SQL filter)":330000,"T07/connected/E chk only (account_slugs)":330000,"T07/connected/E chk only (SQL filter)":330000,"T08/manual/Spending recipe USD":130000,"T08/manual/Income recipe EUR":92000,"T08/manual/Profit recipe (rows)":"EUR 92000 / USD 370000","T08/connected/Spending recipe USD":130000,"T08/connected/Income recipe EUR":92000,"T08/connected/Profit recipe (rows)":"EUR 92000 / USD 370000","T09/manual/E":30000,"T09/manual/I":500000,"T09/connected/E":30000,"T09/connected/I":500000,"T10/manual/E":430000,"T10/manual/Spending recipe":430000,"T10/connected/E":430000,"T10/connected/Spending recipe":430000,"T11/manual/E":430000,"T11/connected/E":430000,"T12/manual/E":230000,"T12/manual/P":200000,"T12/connected/E":230000,"T12/connected/P":200000,"T13/manual/E":430000,"T13/manual/P":0,"T13/connected/E":430000,"T13/connected/P":0,"T14/manual/E":230000,"T14/connected/E":230000,"T15/manual/I":580000,"T15/manual/E":110000,"T15/connected/I":500000,"T15/connected/E":30000,"T15c/manual/I":580000,"T15c/manual/E":110000,"T15c/connected/I":500000,"T15c/connected/E":30000,"T16/manual/E":230000,"T16/connected/E":230000,"T17/manual/E":430000,"T17/connected/E":430000,"T18/manual/Spending recipe business":130000,"T18/connected/Spending recipe business":130000,"T19/manual/Spending recipe business":430000,"T19/connected/Spending recipe business":430000,"T20/manual/E":530000,"T20/manual/Profit":-30000,"T20/connected/E":530000,"T20/connected/Profit":-30000,"T21/manual/I":900000,"T21/manual/Profit":870000,"T21/connected/I":900000,"T21/connected/Profit":870000,"T22/manual/I":750000,"T22/connected/I":750000,"T23/manual/E":230000,"T23/manual/Profit":270000,"T23/connected/E":230000,"T23/connected/Profit":270000,"T24/manual/E":230000,"T24/connected/E":230000,"T25/manual/E":130000,"T25/connected/E":130000,"T26/manual/I":800000,"T26/connected/I":800000,"T27/manual/E":230000,"T27/connected/E":230000,"T28/manual/E chk only (account_slugs)":330000,"T28/manual/E all accounts":330000,"T28/connected/E chk only (account_slugs)":330000,"T28/connected/E all accounts":330000,"T29/manual/I":800000,"T29/manual/E":330000,"T29/manual/Profit":470000,"T29/connected/I":800000,"T29/connected/E":330000,"T29/connected/Profit":470000,"T30/manual/I":800000,"T30/manual/E":330000,"T30/connected/I":800000,"T30/connected/E":330000,"T31/manual/E":30000,"T31/connected/E":30000,"T32/manual/E":430000,"T32/manual/P":200000,"T32/connected/E":430000,"T32/connected/P":200000,"T33/manual/I":800000,"T33/manual/E":330000,"T33/manual/Profit":470000,"T33/connected/I":800000,"T33/connected/E":330000,"T33/connected/Profit":470000,"T34/manual/I":800000,"T34/manual/E":330000,"T34/connected/I":800000,"T34/connected/E":330000};

 for(const c of CASES) for(const live of [false,true]) test(`CERT TRANSFER ${c.id}/${live?'live':'manual'}`,async t=>{
  t.mock.method(globalThis,'fetch',()=>assert.fail('endpoint contact forbidden'));
  const f=book(BIZ);t.after(()=>f.db.close());c.build(f,live);
  const decisions=await f.q('SELECT * FROM txn ORDER BY id');assert.ok(decisions.rows.length,'real decisions reached');
  for(const [label,sql,right,pick,extra] of c.measures){
   const result=await f.q(sql,undefined,extra);const r={...result,percent:result.confidence.percent};
   const figure=pick?pick(r):r.rows[0]?.n??null;
   assert.deepEqual(figure,beforeFigures[c.id+'/'+(live?'connected':'manual')+'/'+label],'primary figure unchanged from pinned source');
   t.diagnostic(JSON.stringify({transfer:c.id,mode:live?'live':'manual',measure:label,figure,truth:right,percent:r.percent,text:r.confidence_text}));
   assert.ok(figure===right||right===null&&figure===0||r.percent<90,'wrong replay remains below High');
  }
 });
 for(const id of ['T01','T04','T12','T16','T27']) for(const live of [false,true]) test(`CERT TRANSFER structured control ${id}/${live?'live':'manual'}`,async t=>{
  const c=CASES.find(c=>c.id===id);const f=book(BIZ);t.after(()=>f.db.close());c.build(f,live);
  f.run("UPDATE fin_transactions SET category='Income',category_basis_state='confirmed' WHERE description='Customer payment'");
  for(const [label,sql,right,pick,extra] of c.measures){
   const result=await f.q(sql,undefined,extra);const r={...result,percent:result.confidence.percent};const figure=pick?pick(r):r.rows[0]?.n??null;
   assert.deepEqual(figure,right,'independently certified control keeps the exact figure');
   t.diagnostic(JSON.stringify({structuredTransfer:id,mode:live?'live':'manual',measure:label,figure,percent:r.percent,text:r.confidence_text}));
   assert.equal(r.percent,95);
  }
 });
}

const certGreenRows=[
 ['owner code','outflow','OWNER DRAW',{payee:'Owner',category:'Owner Draw'},0],
 ['loan code','inflow','LOAN PROCEEDS',{payee:'Lender',category:'Loan Proceeds'},0],
 ['payroll tax code','outflow','IRS USATAXPYMT 941',{payee:'IRS',category:'Payroll Taxes'},-10000],
 ['maintenance form','outflow','MONTHLY MAINTENANCE FEE',{},-10000],
 ['wire fee form','outflow','WIRE TRANSFER FEE',{},-10000],
 ['conversion fee form','outflow','FOREIGN CURRENCY CONVERSION FEE',{},-10000],
 ['card replacement form','outflow','DEBIT CARD REPLACEMENT FEE',{},-10000],
 ['interest form','inflow','INTEREST PAYMENT',{},10000],
 ['dividend form','inflow','DIVIDEND',{},10000],
 ['CSV merchant residual','outflow','ACH DEBIT OFFICE SUPPLIER',{},-10000],
 ['tax preparer merchant','outflow','TAX PREPARER INVOICE',{payee:'Local Tax Accounting'},-10000],
 ['food bank merchant','outflow','FOOD BANK DONATION',{payee:'Community Food Bank'},-10000],
 ['card printer merchant','outflow','CARD PRINT SHOP',{payee:'The Card Print Shop'},-10000],
 ['surname vendor','outflow','CHASE PLUMBING LLC',{payee:'Chase Plumbing LLC'},-10000],
 ['charitable category','outflow','DONATION',{payee:'Charity',category:'Charitable Contributions'},-10000],
 ['personal care category','outflow','SALON SUPPLIES',{payee:'Salon Supplier',category:'Personal Care'},-10000],
 ['retirement category','outflow','PLAN MATCH',{payee:'Plan Admin Co',category:'401k Employer Contributions'},-10000],
 ['partner marketing category','outflow','CO OP AD',{payee:'Reseller Co',category:'Partner Marketing'},-10000],
];
for(const mode of ['manual','live']) for(const [id,direction,description,opts,delta] of certGreenRows)
 test(`CERT GREEN ${id}/${mode}`,async t=>{
  const f=certBook(t,mode);f.add('sale',500000,'inflow','INVOICE 1',{payee:'Customer',category:'Income'});
  f.add('control',10000,direction,description,opts);const support=await f.query('SELECT * FROM txn ORDER BY id');assert.equal(support.rows.length,2);
  const r=await f.profit();assert.equal(r.rows[0].cash_profit_minor,500000+delta);
  t.diagnostic(JSON.stringify({green:id,mode,figure:r.rows[0].cash_profit_minor,percent:r.confidence.percent,text:r.confidence_text}));
  if(id==='dividend form'){assert.ok(r.confidence.percent<90,'an earlier estimate cannot be raised by the certifier');
   assert.match(r.confidence_text,/\$100\.00/);assert.match(r.confidence_text,/confirm these rows/i);}
  else if(id==='loan code') {
   assert.equal(support.rows[1].money_kind,'loan_proceeds','the excluded nonzero loan receipt was reached');
   assert.equal(support.rows[1].income_minor,0,'preserve the coded exclusion');
   assert.equal(r.confidence.percent,89,'a code alone does not prove both owned endpoints');
   assert.match(r.confidence_text,/\$100\.00 inflow.*excluded from income as likely loan proceeds/);
   assert.match(r.confidence_text,/Missing:.*(?:source and destination|both.*statements)/is);
  }
  else assert.equal(r.confidence.percent,95);
 });
for(const mode of ['manual','live']) test(`CERT GREEN counted refund budget/${mode}`,async t=>{
 const f=certBook(t,mode);f.add('sale',500000,'inflow','INVOICE 1',{payee:'Customer',category:'Income'});
 f.add('buy',50000,'outflow','SUPPLIER ORDER 77',{payee:'Supplier',day:'2026-10-03'});
 f.add('returned',20000,'inflow','SUPPLIER REFUND',{payee:'Supplier',category:'Refund',day:'2026-10-18'});
 const r=await f.profit();assert.equal(r.rows[0].cash_profit_minor,470000);assert.equal(r.confidence.percent,95);
});
for(const mode of ['manual','live']) test(`CERT GREEN prior confirmed customer history/${mode}`,async t=>{
 const f=certBook(t,mode);f.add('prior',50000,'inflow','INVOICE 1',{payee:'Customer',category:'Income',day:'2026-09-03'});
 f.add('current',500000,'inflow','INVOICE 2',{payee:'Customer'});
 const r=await f.profit();assert.equal(r.rows[0].cash_profit_minor,500000);assert.equal(r.confidence.percent,95);
});
for(const surface of ['query','overview','MCP query','MCP overview'])test(`CERT SURFACE ${surface}: names dollars and confirm rows`,async t=>{
 const f=certBook(t,'live');f.add('sale',500000,'inflow','INVOICE 1',{payee:'Customer',category:'Income'});
 f.add('disputed',60000,'outflow','CHECK 1043',{payee:'Owner',category:"Owner's Draw"});
 let result;
 if(surface==='query') result=await f.profit();
 else if(surface==='overview')result=await overviewMoney(f.env,{now:()=>MONEY_NOW});
 else {
  const url=new URL('https://fixture.invalid/mcp');
  const rpc=await handleMcp(f.env,new Request(url,{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',
   params:{name:surface==='MCP query'?'brain_money_query':'brain_money_overview',arguments:surface==='MCP query'?{sql:f.sql,...OCT}:{}}})}),url,{grant:{profile:'owner-assistant'}});
  const body=await rpc.json();assert.ok(!body.result.isError,'surface returned an answer');result=JSON.parse(body.result.content[0].text);
 }
 assert.ok(result.confidence.percent<90);assert.match(result.confidence_text,/\$600\.00/);assert.match(result.confidence_text,/confirm these rows/i);
 assert.match(result.confidence_text,/owner category confirmation/i);
 assert.ok(surface.includes('overview')?result.accounts.length:result.rows.length,'the actual surface decision was reached');
});

const certBookWithoutSnapshotProperty=certBook;
certBook=function(t,...args) {
 const f=certBookWithoutSnapshotProperty(t,...args);let frozen;
 const prepare=f.env.DB.prepare.bind(f.env.DB);
 const wrap=(statement,sql)=>({...statement,
  bind:(...values)=>wrap(statement.bind(...values),sql),
  all:async()=>{
   const result=await statement.all();
   if(result.results?.some(r=>r.snapshot_kind==='rows')){
    frozen={rows:[],accounts:[],entities:[],pairs:[],coverage:[],counts:[],pending:[],missing:[],excluded:[],quality:[],conflicts:[],unreadable:[],settled:[]};
    for(const r of result.results){(frozen[r.snapshot_kind]??=[]).push({...JSON.parse(r.value),...(r.value2?JSON.parse(r.value2):{})});}
   }
   return result;
  },
 });
 f.env.DB.prepare=sql=>wrap(prepare(sql),sql);
 t.after(()=>{
  if(!frozen || typeof certEvidence.certifyMoneyKinds!=='function')return;
  const decisions=certMoney.moneyMembershipDecisions(frozen);let count=0;
  for(const d of decisions){if(!frozen.rows.find(r=>r.id===d.id)?.amount_minor)continue;count++;
   assert.equal(Number(certEvidence.MONEY_KIND_PROOFS.includes(d.kind_proof))+Number(d.estimated===1),1,'real-snapshot totality');
   if(d.estimated){assert.ok(d.estimate_reason);assert.ok(certEvidence.MONEY_KIND_DOUBTS.includes(d.kind_unproved));}
  }
  assert.ok(count,'real-snapshot totality reached nonzero decisions');
 });
 return f;
};

const certPinnedProfitFigures={"p01/P1a-control/manual":500000,"p01/P1a-control/live":500000,"p01/P1b/manual":500312,"p01/P1b/live":500312,"p01/P1c/manual":500045,"p01/P1c/live":500045,"p01/P1d/manual":500000,"p01/P1d/live":500000,"p01/P1e/manual":500000,"p01/P1e/live":500000,"p01/P3a/manual":-20000,"p01/P3a/live":-20000,"p01/P3b/manual":230000,"p01/P3b/live":230000,"p01/P3c/manual":-20000,"p01/P3c/live":-20000,"p01/P4control/manual":500000,"p01/P4control/live":500000,"p01/P4a/manual":200000,"p01/P4a/live":200000,"p01/P4b/manual":200000,"p01/P4b/live":200000,"p01/P4c/manual":200000,"p01/P4c/live":200000,"p01/P4d/manual":200000,"p01/P4d/live":200000,"p01/P4e/manual":200000,"p01/P4e/live":200000,"p01/P14control/manual":500000,"p01/P14control/live":500000,"p01/P14a/manual":1500000,"p01/P14a/live":1500000,"p01/P14b/manual":1500000,"p01/P14b/live":1500000,"p01/P14c/manual":1500000,"p01/P14c/live":1500000,"p01/P14d/manual":1500000,"p01/P14d/live":1500000,"p01/P5/manual":529000,"p01/P5/live":529000,"p01/P6/manual":450000,"p01/P6/live":450000,"p01/P30a/manual":590000,"p01/P30a/live":590000,"p01/P30b/manual":700000,"p01/P30b/live":700000,"p01/P30c/manual":500000,"p01/P30c/live":500000,"p01/C1/manual":380000,"p01/C1/live":380000,"p01/C2/manual":465000,"p01/C2/live":465000,"p01/C3/manual":480000,"p01/C3/live":480000,"p02/P1f/manual":465000,"p02/P1f/live":465000,"p02/P1g/manual":501500,"p02/P1g/live":501500,"p02/P1h/manual":498800,"p02/P1h/live":498800,"p02/P4f/manual":440000,"p02/P4f/live":440000,"p02/P4g/manual":500000,"p02/P4g/live":500000,"p02/P15control/manual":500000,"p02/P15control/live":500000,"p02/P15a/manual":3000000,"p02/P15a/live":3000000,"p02/P15b/manual":3000000,"p02/P15b/live":3000000,"p02/P15c/manual":3000000,"p02/P15c/live":3000000,"p02/P16control/manual":375000,"p02/P16control/live":375000,"p02/P16a/manual":375000,"p02/P16a/live":375000,"p02/P16b/manual":375000,"p02/P16b/live":375000,"p02/P30d/manual":800000,"p02/P30d/live":800000,"p02/P30e/manual":800000,"p02/P30e/live":800000,"p02/P30f/manual":500000,"p02/P30f/live":500000,"p02/P5b/manual":529000,"p02/P5b/live":529000,"p02/P5c/manual":564000,"p02/P5c/live":564000,"p02/P17a/manual":165000,"p02/P17a/live":165000,"p02/P17b/manual":0,"p02/P17b/live":0,"p02/P18a/manual":530000,"p02/P18a/live":530000,"p02/C4/manual":500000,"p02/C4/live":500000,"p02/C5/manual":500000,"p02/C5/live":500000,"p02/C6/manual":488000,"p02/C6/live":488000,"p02/C7/manual":470000,"p02/C7/live":470000,"p03/P1f/manual":465000,"p03/P1f/live":465000,"p03/P26/manual":540000,"p03/P26/live":540000,"p03/P42a/manual":505000,"p03/P42a/live":505000,"p03/P42b/manual":440000,"p03/P42b/live":440000,"p03/P42c/manual":420000,"p03/P42c/live":420000,"p03/P35/manual":376000,"p03/P35/live":376000,"p03/P43/manual":520000,"p03/P43/live":520000,"p03/D1/manual":20000,"p03/D1/live":20000,"p03/D2/manual":485000,"p03/D2/live":485000,"p03/D3/manual":500820,"p03/D3/live":500820,"p05/W1/manual":450000,"p05/W1/live":450000,"p05/R1/manual":419000,"p05/R1/live":419000,"p05/CB1/manual":500000,"p05/CB1/live":500000,"p05/F1/manual":594000,"p05/F1/live":594000};

for(const surface of ['HTTP query','HTTP overview'])test(`CERT SURFACE ${surface}: names dollars and confirm rows`,async t=>{
 const f=certBook(t,'live');f.add('sale',500000,'inflow','INVOICE 1',{payee:'Customer',category:'Income'});
 f.add('disputed',60000,'outflow','CHECK 1043',{payee:'Owner',category:"Owner's Draw"});
 const handler=surface==='HTTP query'?(await import('../src/lib/money-query.js')).handleMoneyQuery
  :(await import('../src/lib/money-overview.js')).handleMoneyOverview;
 const response=await handler(f.env,new Request('https://fixture.invalid/money',{method:'POST',body:JSON.stringify(surface==='HTTP query'?{sql:f.sql,...OCT}:{})}));
 assert.equal(response.status,200);const result=await response.json();
 assert.ok(surface==='HTTP query'?result.rows.length:result.accounts.length,'HTTP surface reached the real classification result');
 assert.ok(result.confidence.percent<90);assert.match(result.confidence_text,/\$600\.00/);assert.match(result.confidence_text,/confirm these rows/i);
 assert.match(result.confidence_text,/owner category confirmation/i);
});

for(const mode of ['manual','live'])test(`CERT HUNT P26b no refund wording/${mode}`,async t=>{
 const f=certBook(t,mode);f.add('sale',500000,'inflow','CLIENT INVOICE 1001',{payee:'Client',category:'Income'});
 f.addAccount('card','card','3333',{label:'Business card',institution:'Card issuer'});
 f.add('pbuy',40000,'outflow','HOME GOODS STORE',{payee:'Home goods store',slug:'card',category:'Owner Draw',day:'2026-10-04'});
 f.add('pref',40000,'inflow','HOME GOODS STORE',{payee:'Home goods store',slug:'card',category:'Refunds',day:'2026-10-09'});
 const support=await f.query('SELECT * FROM txn ORDER BY id');assert.equal(support.rows[1].money_kind,'owner_money');assert.equal(support.rows[2].refund_minor,40000);
 const r=await f.profit();assert.equal(r.rows[0].cash_profit_minor,540000);assert.ok(r.confidence.percent<90);
 assert.match(r.confidence_text,/\$400\.00/);assert.match(r.confidence_text,/original/i);assert.match(r.confidence_text,/confirm these rows/i);
});

for(const mode of ['manual','live'])for(const memo of ['REFUND OF OVERPAYMENT INV 1042','ZELLE REFUND','REFUND JOB 22 DEPOSIT','CUSTOMER DISPUTE DEBIT','RETURNED GOODS CREDIT TO BUYER','STORE CREDIT REFUND','CHECK 1043 REFUND'])
 test(`CERT REFUND TAIL customer return ${memo}/${mode}`,async t=>{
  const f=certBook(t,mode);f.add('sale',100000,'inflow','INVOICE 1042 PAYMENT',{payee:'Customer',category:'INCOME',day:'2026-10-03'});
  f.add('back',20000,'outflow',memo,{payee:'Customer',day:'2026-10-09'});
  const support=await f.query('SELECT * FROM txn ORDER BY id');assert.equal(support.rows[1].money_kind,'ordinary');assert.equal(support.rows[1].expense_minor,20000);
  const r=await f.query('SELECT SUM(income_minor+sales_adjust_minor) AS n FROM txn'+dWindow);
  assert.equal(r.rows[0].n,100000,'retain the disputed figure');assert.ok(r.confidence.percent<90,`wrong-at-High percent ${r.confidence.percent}`);
  assert.match(r.confidence_text,/\$200\.00/);assert.match(r.confidence_text,/confirm these rows/i);
 });
for(const mode of ['manual','live'])test(`CERT REFUND TAIL buyer dispute category/${mode}`,async t=>{
 const f=certBook(t,mode);f.add('buy',50000,'outflow','PRINTER WAREHOUSE',{payee:'Printer Warehouse',day:'2026-10-02'});
 f.add('prov',50000,'inflow','CLAIM 4471 PROVISIONAL',{category:'DISPUTE CREDIT',day:'2026-10-06'});
 f.add('final',50000,'outflow','CLAIM 4471 FINAL',{category:'DISPUTE',day:'2026-10-27'});
 const support=await f.query('SELECT * FROM txn ORDER BY id');assert.equal(support.rows[2].sales_adjust_minor,-50000,'buyer debit is misread as a seller return');
 const r=await f.query('SELECT SUM(expense_minor+interest_expense_minor-refund_minor) AS n FROM txn'+dWindow);
 assert.equal(r.rows[0].n,0);assert.ok(r.confidence.percent<90,`wrong-at-High percent ${r.confidence.percent}`);assert.match(r.confidence_text,/\$500\.00/);
});
for(const mode of ['manual','live'])test(`CERT REFUND TAIL processor hold release/${mode}`,async t=>{
 const f=certBook(t,mode);f.add('payout',100000,'inflow','PAYPAL TRANSFER',{payee:'PayPal',category:'INCOME',day:'2026-10-03'});
 f.add('hold',15000,'outflow','PAYPAL DISPUTE HOLD',{payee:'PayPal',category:'DISPUTE',day:'2026-10-08'});
 f.add('release',15000,'inflow','PAYPAL DISPUTE HOLD RELEASED',{payee:'PayPal',day:'2026-10-20'});
 const support=await f.query('SELECT * FROM txn ORDER BY id');assert.equal(support.rows[2].income_minor,15000);
 const r=await f.query('SELECT SUM(income_minor) AS n FROM txn'+dWindow);
 assert.equal(r.rows[0].n,115000);assert.ok(r.confidence.percent<90,`wrong-at-High percent ${r.confidence.percent}`);assert.match(r.confidence_text,/\$150\.00/);
});
for(const mode of ['manual','live'])test(`CERT REFUND TAIL green confirmed service expense/${mode}`,async t=>{
 const f=certBook(t,mode);f.add('service',20000,'outflow','REFUND POLICY PRINTING',{payee:'Printer',category:'Professional Services'});
 const r=await f.query('SELECT SUM(expense_minor) AS n FROM txn'+dWindow);assert.equal(r.rows[0].n,20000);assert.equal(r.confidence.percent,mode==='manual'?65:55);
 assert.match(r.confidence_text,/\$200\.00/);assert.match(r.confidence_text,/return|refund/i);
 f.run("UPDATE fin_transactions SET description='POLICY PRINTING' WHERE txn_uid='service'");
 const green=await f.query('SELECT SUM(expense_minor) AS n FROM txn'+dWindow);
 assert.equal(green.rows[0].n,20000);assert.equal(green.confidence.percent,95,'ordinary service remains a High control');
});

function assertCertificateEstimate(result,cents) {
 assert.ok(result.confidence.percent<90,'the row has no money-type certificate');
 const dollars=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100);
 assert.ok(result.confidence_text.includes(dollars),'estimated dollars are named');
 assert.match(result.confidence_text,/confirm these rows/i);
 assert.match(result.confidence_text,/Missing:.*(?:category|statement|original|payee|record)/is);
}

for(const mode of ['manual','live'])test(`CERT GREEN recorded seller gift-card sales/${mode}`,async t=>{
 const f=certBook(t,mode);f.add('payout',100000,'inflow','SQUARE PAYOUT GIFT CARD SALES',{payee:'Square'});
 const support=await f.query('SELECT * FROM txn ORDER BY id');assert.equal(support.rows[0].income_minor,100000);
 const r=await f.query('SELECT SUM(income_minor) AS n FROM txn'+dWindow);assert.equal(r.rows[0].n,100000);assert.equal(r.confidence.percent,89);assert.match(r.confidence_text,/processor.*net settlements/is);
});

for(const mode of ['manual','live'])test(`CERT GREEN wallet merchant residual/${mode}`,async t=>{
 const f=certBook(t,mode);f.add('purchase',12000,'outflow','PAYPAL *OFFICEVENDOR');
 const support=await f.query('SELECT * FROM txn');assert.equal(support.rows[0].expense_minor,12000);
 const r=await f.query('SELECT SUM(expense_minor) AS n FROM txn'+dWindow);assert.equal(r.rows[0].n,12000);assert.equal(r.confidence.percent,95);
});

test('CERT PROPERTY account locator uses the shared resolver and excludes debit-card suffixes',()=>{
 const accounts=[{tenant_id:'tenant',account_slug:'checking',account_identity:'checking',mask:'1111',account_kind:'checking'},
  {tenant_id:'tenant',account_slug:'card',account_identity:'card',mask:'9876',account_kind:'card'}];
 const debit=certRow({payee:'Supplier',description:'PAYMENT TO CARD ENDING 9876'});
 const [bad]=certifyRows([debit],undefined,accounts);assert.equal(bad.kind_unproved,'names_another_account');
 const [green]=certifyRows([{...debit,description:'PURCHASE AUTHORIZED STAPLES CARD 9876'}],undefined,accounts);assert.equal(green.kind_proof,'party');
});

for(const mode of ['manual','live'])test(`CERT INTEREST independent credit category/${mode}`,async t=>{
 const f=certBook(t,mode);f.add('sale',500000,'inflow','INVOICE 1',{payee:'Customer',category:'Income'});
 f.addAccount('debt','loan','2222',{label:'Recorded lender',institution:'Recorded lender'});
 f.add('pay',125000,'outflow','PAYMENT TO LOAN 2222');f.add('ack',125000,'inflow','PAYMENT RECEIVED',{slug:'debt'});
 f.add('credit',312,'inflow','INTEREST EARNED',{payee:'Synthetic bank',category:'INCOME',day:'2026-10-15'});
 const support=await f.query('SELECT * FROM txn ORDER BY id');assert.equal(support.rows[1].money_kind,'loan_payment');assert.equal(support.rows[3].income_minor,312);
 const r=await f.profit();assert.equal(r.rows[0].cash_profit_minor,500312);
 t.diagnostic(JSON.stringify({interestVariant:mode,figure:r.rows[0].cash_profit_minor,percent:r.confidence.percent,text:r.confidence_text}));
 assert.ok(r.confidence.percent<90,`wrong-at-High percent ${r.confidence.percent}`);
 assert.ok(r.confidence.gaps.some(g=>g.code==='loan_interest_unseparated'));assert.match(r.confidence_text,/\$1,250\.00/);
});

for(const mode of ['manual','live'])for(const confirmed of [false,true])test(`CERT BANK REFUND code exception/${mode}/${confirmed}`,async t=>{
 const f=certBook(t,mode);f.run("UPDATE fin_accounts SET institution='Chase' WHERE account_slug='operating'");
 f.add('fee',10000,'outflow','MONTHLY SERVICE FEE',{payee:'Chase',category:'Bank Fees',day:'2026-10-03'});
 f.add('credit',10000,'inflow','FEE REFUND',{payee:'Chase',category:'Fee Refunds',basis:confirmed?'confirmed':'proposed',day:'2026-10-09'});
 if(!confirmed)f.run("UPDATE fin_transactions SET source_feed='synthetic-feed',provenance='feed' WHERE txn_uid='credit'");
 const support=await f.query('SELECT * FROM txn ORDER BY id');assert.equal(support.rows[0].expense_minor,10000);assert.equal(support.rows[1].refund_minor,10000);
 const r=await f.query('SELECT SUM(expense_minor+interest_expense_minor-refund_minor) AS n FROM txn'+dWindow);assert.equal(r.rows[0].n,0);
 t.diagnostic(JSON.stringify({bankRefund:mode,confirmed,figure:r.rows[0].n,percent:r.confidence.percent,text:r.confidence_text}));
 if(confirmed)assert.equal(r.confidence.percent,95,'owner-confirmed refund type still requires and has a counted original');
 else{assert.ok(r.confidence.percent<90,'feed category cannot remove the financial-party doubt');assert.match(r.confidence_text,/\$100\.00/);}
});

for(const kind of ['other','merchant','point_of_sale','card','loan','line_of_credit'])test(`CERT ELIGIBILITY no fallback party certificate/${kind}`,()=>{
 const r=certRow({account_kind:kind,account_basis:['card','loan','line_of_credit'].includes(kind)?'proposed':'confirmed'});
 const [d]=certifyRows([r]);assert.equal(d.estimated,1,'an outside party cannot supply an unlisted account-kind certificate');assert.equal(d.kind_unproved,'kind_not_proved');
});
for(const kind of ['checking','savings','card','loan','line_of_credit'])test(`CERT ELIGIBILITY confirmed account control/${kind}`,()=>{
 const r=certRow({account_kind:kind,account_basis:'confirmed'});const [d]=certifyRows([r]);assert.equal(d.kind_proof,['checking','savings'].includes(kind)?'party':'account');
});

// A separate returned-payment fee is an institution charge, not principal.
for(const mode of ['manual','live']) test(`CERT FEE returned payment full form/${mode}`,async t=>{
 const f=certBook(t,mode);f.addAccount('debt','loan','3333');
 f.add('fee',3500,'outflow','RETURNED PAYMENT FEE',{slug:'debt'});
 const support=await f.query("SELECT money_kind,expense_minor,estimated FROM txn WHERE txn_uid='fee'");
 assert.equal(support.rows.length,1,'the separate fee decision was reached');
 assert.equal(support.rows[0].money_kind,'ordinary');assert.equal(support.rows[0].expense_minor,3500);
 const result=await f.query("SELECT SUM(expense_minor) AS n FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31'");
 t.diagnostic(JSON.stringify({feeForm:mode,confidence:result.confidence_text}));
 assert.equal(result.rows[0].n,3500);assert.equal(support.rows[0].estimated,0,'the whole fee form is certified');
 assert.equal(result.confidence.percent,89,'the earlier payment-return quality ceiling is retained');
});

for(const mode of ['manual','live']) test(`CERT EXAMPLE new kind doubt preserves example economic rows/${mode}`,async t=>{
 const f=certBook(t,mode);f.addAccount('debt','loan','3333');
 f.add('sale',100000,'inflow','Invoice 1042',{payee:'Customer',category:'Income'});
 f.add('buy',10000,'outflow','Office supplies',{payee:'Supplier'});
 f.add('lender',50000,'inflow','ACH CREDIT',{slug:'debt',category:'LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT'});
 f.add('memo',100000,'outflow','LOAN PAYMENT PRINCIPAL 900 INTEREST 100');
 const support=await f.query("SELECT * FROM txn ORDER BY id");
 assert.equal(support.rows.length,4,'all classification decisions were reached');
 assert.equal(support.rows[2].money_kind,'loan_payment');assert.equal(support.rows[2].estimated,1);
 assert.equal(support.rows[3].estimated,1,'earlier estimated spending is a green control');
 const {CLEAN_MONEY_EXAMPLE_SQL}=await import('../src/lib/clean-money.js');
 const result=await f.query(CLEAN_MONEY_EXAMPLE_SQL);
 t.diagnostic(JSON.stringify({example:mode,rows:result.rows.length,amount:result.rows.reduce((n,r)=>n+r.amount_minor,0),confidence:result.confidence_text}));
 assert.equal(result.rows.length,3);assert.equal(result.rows.reduce((n,r)=>n+r.amount_minor,0),210000);
 assert.ok(result.rows.some(r=>r.estimated===1&&r.expense_minor===100000&&r.estimate_reason===support.rows[3].estimate_reason),'the earlier counted estimate and its reason are retained');
 assert.ok(result.confidence.percent<90);assert.match(result.confidence_text,/\$500\.00/);assert.match(result.confidence_text,/Confirm these rows/);
});

// A confirmed processor fee is a typed expense even on the merchant account.
for(const mode of ['manual','live']) for(const confirmed of [false,true])
 test(`CERT PROCESSOR fee code/${mode}/${confirmed?'confirmed':'feed only'}`,async t=>{
 const f=certBook(t,mode);f.addAccount('proc','merchant','5555',{label:'Processor',institution:'Stripe'});
 f.add('sale',500000,'inflow','Invoice 1042',{payee:'Customer',category:'Income'});
 f.add('fee',300,'outflow','Stripe processing fees',{slug:'proc',category:'PROCESSOR_FEES'});
 if(!confirmed)f.run("UPDATE fin_transactions SET provenance='feed',source_feed='synthetic-feed',category_basis_state='proposed' WHERE txn_uid='fee'");
 const support=await f.query("SELECT * FROM txn WHERE txn_uid='fee'");
 assert.equal(support.rows.length,1,'the processor expense decision was reached');
 assert.equal(support.rows[0].money_kind,'ordinary');assert.equal(support.rows[0].expense_minor,300);
 const result=await f.query("SELECT SUM(expense_minor) AS n FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31'");
 assert.equal(result.rows[0].n,300);
 t.diagnostic(JSON.stringify({processorFee:mode,confirmed,figure:result.rows[0].n,percent:result.confidence.percent,text:result.confidence_text}));
 if(confirmed){assert.equal(support.rows[0].estimated,0);assert.equal(result.confidence.percent,95);}
 else {assert.equal(support.rows[0].estimated,1);assert.ok(result.confidence.percent<90);assert.match(result.confidence_text,/\$3\.00/);assert.match(result.confidence_text,/Confirm these rows/);}
});
