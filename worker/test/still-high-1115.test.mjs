import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/clean-money-fixture.mjs';
import { queryMoney, validateMoneySql } from '../src/lib/money-query.js';
import { certifyMoneyQuery } from '../src/lib/money-query-certificate.js';
import { moneyOverlapGroups } from '../src/lib/money-query-overlap.js';
import { moneyRiskMateriality } from '../src/lib/money-query-risk.js';
import { finalizeDocumentAnswer } from '../src/lib/document-answer.js';
import { createHash } from 'node:crypto';

const period={period_from:'2026-10-01',period_to:'2026-10-31'};
const now=()=>Date.parse('2026-11-12T19:00:00Z');
const sql=(field,p=period)=>`SELECT COALESCE(SUM(${field}),0) AS cents FROM txn WHERE posted_on BETWEEN '${p.period_from}' AND '${p.period_to}'`;
function book(t,id='') {
  const f=fixture(t);f.env.BRAIN_TIMEZONE='UTC';
  const december=id.startsWith('X1307'),live=december || /^(?:X1323|X1327)/.test(id);
  f.period=december?{period_from:'2025-12-01',period_to:'2025-12-31'}:period;
  f.clock=december?'2025-12-31T18:00:00Z':'2026-11-12T19:00:00Z';
  f.env.BRAIN_TIMEZONE=december?'America/Los_Angeles':'UTC';
  f.account('operating',{mode:live?'live':'manual',mask:december?'1307':'1111'});
  f.coverage('operating',december?'2025-01-01':'2026-01-01',december?'2025-12-31':'2026-11-12');
  if(live) {
    const ref='acct_'+createHash('sha256').update('operating').digest('hex').slice(0,32);
    f.run('UPDATE fin_accounts SET external_ref=?,source_feed=? WHERE account_slug=?',ref,'bank-feed:operating','operating');
    f.run(`INSERT INTO bank_feed_items(item_ref,access_ciphertext,access_iv,environment,status,status_detail,connected_at,last_synced_at)
      VALUES (?,?,?,'production','connected','Synthetic status',?,?)`,'operating',Buffer.from('synthetic bytes').toString('base64'),Buffer.from('synthetic iv').toString('base64'),f.clock,f.clock);
    f.run(`INSERT INTO plaid_account_entity_assignments(item_ref,provider_account_id,account_ref,entity_slug,discovered_at,last_seen_at,assigned_at,updated_at)
      VALUES (?,'synthetic',?,'business',?,?,?,?)`,'operating',ref,f.clock,f.clock,f.clock,f.clock);
    f.run("INSERT INTO bank_feed_health(tenant_id,item_ref,last_successful_sync_at,data_through) VALUES ('primary',?,?,?)",'operating',f.clock,f.clock.slice(0,10));
  }
  return f;
}
const row=(minor,memo,payee,direction='outflow',day='2026-10-08',category=null,account='operating')=>
  ({minor,memo,payee,direction,day,category,account});
export const moneyCases=[
  ['X1295-Q11','STILL-HIGH','expense_minor',160000,[row(80000,'Plumbing repair','Vendor A'),row(80000,'Plumbing repair','Vendor A','outflow','2026-10-12')]],
  ['X1295-Q20','STILL-HIGH','expense_minor',129500,[row(129500,'Maintenance reserve funding','Property Owner A')]],
  ['X1295-Q22','STILL-HIGH','income_minor',200000,[row(15000,'Management fee','Property Owner A','inflow','2026-10-08','Service income'),row(185000,'October rent','Tenant A','inflow','2026-10-08','Rental income')]],
  ['X1307-Q18','STILL-HIGH','expense_minor',130700,[row(130700,'Outside Counterparty','Outside Counterparty','outflow','2026-10-15')]],
  ['X1307-Q19','STILL-HIGH','expense_minor',130700,[row(130700,'Purchased treasury bills','Outside Brokerage','outflow','2026-10-15','investments')]],
  ['X1323-Q03','STILL-HIGH','expense_minor',264600,[row(132300,'Packaging purchase','Outside supplier','outflow','2026-10-10'),row(132300,'Packaging purchase','Outside supplier','outflow','2026-10-14',null,'mirror')]],
  ['X1323-Q21','STILL-HIGH','income_minor',132300,[row(10000,'Invoice paid','Outside customer','inflow','2026-09-10','sales'),row(132300,'Outside customer remittance','Outside customer','inflow','2026-10-10')]],
  ['X1327-Q03','STILL-HIGH','expense_minor',270000,[row(270000,'Tenant money paid back','tenant','outflow','2026-10-14')]],
  ['X1327-Q06','STILL-HIGH','income_minor',132700,[row(132700,'November rent','tenant','inflow','2026-10-14','rental income')]],
  ['X1327-Q07','STILL-HIGH','income_minor',132700,[row(132700,'Last month rent held','tenant','inflow','2026-10-14','rental income')]],
  ['X1315-Q16','UNSURE','expense_minor',500000,[row(500000,'PURCHASE ORDER 1315','Outside securities','outflow','2026-10-05')]],
  ['X1315-Q18','UNSURE','expense_minor',500000,[row(500000,'MONTHLY ALLOCATION','Outside holdings','outflow','2026-10-05')]],
  ['X1315-Q19','UNSURE','expense_minor',50000,[row(50000,'ORDER ADJUSTMENT','Outside customer','outflow','2026-10-05')]],
  ['X1319-Q07','UNSURE','expense_minor',171900,[row(171900,'Last month rent return unit 4','tenant')]],
  ['F1','COMPOSED','income_minor',1010000,[row(1000000,'Customer payment','Customer','inflow','2026-10-02'),row(5000,'Customer payment','Customer','inflow','2026-10-10'),row(5000,'Customer payment','Customer','inflow','2026-10-13')]],
];
async function query(f,statement,extra={}) {
  const before=f.calls.length,r=await queryMoney(f.env,{sql:statement,...f.period,...extra},{now:()=>Date.parse(f.clock)});
  assert.ok(f.calls.length>before && r.rows.length,'nonempty SQLite money result was reached');
  assert.match(r.confidence_text,/Confidence: (High|Medium|Low) \(\d+%\).*Reasons:.*Missing:/s);
  return r;
}
const checked=(f,statement)=>validateMoneySql(statement,async s=>f.db.prepare(s).all());
for(const [id,classification,field,expected,inputs] of moneyCases)test(`${id} ${classification}: retains the provisional dollars below High`,async t=>{
  const f=book(t,id);
  if(id==='F1'){f.clock='2026-11-01T12:00:00Z';f.run('DELETE FROM fin_account_coverage');f.coverage('operating',period.period_from,period.period_to);}
  if(inputs.some(r=>r.account==='mirror')){f.account('mirror',{mode:'manual'});f.coverage('mirror','2026-01-01','2026-11-12');}
  for(const [i,r] of inputs.entries())f.row(`posting-${i}`,r.account,r.minor,{...r,day:id.startsWith('X1307')?r.day.replace('2026-10','2025-12'):r.day});
  if(id==='X1295-Q11')f.run("UPDATE fin_transactions SET source_doc_uid='statement-' || id");
  if(id==='X1307-Q19')f.run("UPDATE fin_transactions SET provenance='feed',source_feed='synthetic-feed'");
  const statement=sql(field,f.period),parsed=await checked(f,statement),certificate=certifyMoneyQuery(parsed);
  assert.equal(certificate.certified,true,'the closed-world SQL decision is reached and accepts this simple SUM');
  const r=await query(f,statement);
  assert.equal(r.rows[0].cents,expected,'qualification cannot erase or change the observed provisional amount');
  t.diagnostic(JSON.stringify({id,classification,figure:r.rows[0].cents,percent:r.confidence.percent}));
  if(id==='F1') {
    const read=f.db.prepare('SELECT t.*,a.mask AS account,a.account_slug AS account_identity FROM fin_transactions t JOIN fin_accounts a USING(account_slug)').all();
    assert.equal(read.length,3);assert.equal(moneyOverlapGroups(read).length,1,'the duplicate decision actually nominates the extra posting');
    assert.equal(moneyRiskMateriality({tokens:parsed.tokens,result:r.rows,rows:read}),true,'the materiality exception is reached');
    assert.match(r.confidence_text,/50\.00.*counted twice/s,'the possible extra fifty dollars are named');
  }
  assert.ok(r.confidence.percent<90,r.confidence_text);
  assert.ok(r.confidence.missing.length);
  assert.match(r.confidence_text,/\d+[,.]\d{2}/,'affected dollars are named');
  const impact=id==='F1'?5000:id==='X1295-Q22'?185000:id==='X1295-Q11'?80000:id==='X1323-Q03'?132300:inputs.at(-1).minor;
  assert.ok(r.confidence_text.includes((impact/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})),
    'the actual risky or repeated dollars, rather than an unrelated amount, are named');
  if(classification==='UNSURE') {
    const signed=await query(f,sql('expense_minor + interest_expense_minor - refund_minor',f.period));
    assert.equal(signed.rows[0].cents,expected);assert.ok(signed.confidence.percent<90);
    assert.match(signed.confidence_text,/query shape not certified/);
  }
});
test('ordinary receipts, purchases, bank fees and reconciled unique imports still reach High',async t=>{
  const f=book(t);f.row('receipt','operating',1005000,{payee:'Customer',memo:'Customer payment'});
  f.row('purchase','operating',81234,{payee:'Supply vendor',memo:'Packaging purchase',direction:'outflow'});
  f.row('fee','operating',500,{memo:'Bank fee',direction:'outflow'});
  for(const [field,cents] of [['income_minor',1005000],['expense_minor',81734]]){
    const r=await query(f,sql(field));assert.equal(r.rows[0].cents,cents);assert.ok(r.confidence.percent>=90,r.confidence_text);
  }
});
for(const memo of ['Processing item','Reference ABC','Scheduled item'])test(`an opaque party posting cannot prove operating purpose: ${memo}`,async t=>{
  const f=book(t);f.row('opaque','operating',45321,{direction:'outflow',memo,payee:'Outside Counterparty'});
  const r=await query(f,sql('expense_minor'));assert.equal(r.rows[0].cents,45321);
  assert.ok(r.confidence.percent<90,r.confidence_text);assert.match(r.confidence_text,/453.21/);
});
for(const minor of [5000,10000])test(`F1 paired ordinary control and strict dollar boundary ${minor}`,async t=>{
  const f=book(t);f.row('receipt','operating',1000000,{day:'2026-10-02',memo:'Customer payment',payee:'Customer'});
  f.row('small','operating',minor,{day:'2026-10-10',memo:'Customer payment',payee:'Customer'});
  const green=await query(f,sql('income_minor'));assert.equal(green.rows[0].cents,1000000+minor);assert.ok(green.confidence.percent>=90,green.confidence_text);
  f.row('copy','operating',minor,{day:'2026-10-13',memo:'Customer payment',payee:'Customer'});
  const bad=await query(f,sql('income_minor'));assert.equal(bad.rows[0].cents,1000000+2*minor);
  const source=f.db.prepare('SELECT t.*,a.mask AS account,a.account_slug AS account_identity FROM fin_transactions t JOIN fin_accounts a USING(account_slug)').all();
  assert.equal(moneyOverlapGroups(source).length,1,'the added repeated posting reached duplicate nomination');
  assert.equal(moneyRiskMateriality({tokens:(await checked(f,sql('income_minor'))).tokens,result:bad.rows,rows:source}),minor<10000);
  assert.ok(bad.confidence.percent<90,bad.confidence_text);
});

const proof=(amount,scale)=>`The monthly fee is USD ${amount}. Status: signed and current. Amendments checked through: 2026-11-12. Subject: shop contract. Measure: fee. Rate basis: monthly. Scale: ${scale}. Currency: USD. Covered dates: 2026-01-01 through 2026-12-31.`;
function document(content,question='What monthly fee does the shop contract state for October 2026?',asOf='2026-11-12',extra={}) {
  const docs=[1,2,3].map(n=>({n,title:'contract',source:`records-${n}`,snippet:content,ts:'2026-11-11',date_reliable:true,
    text_source:'native',text_reliable:true,read_complete:true,authority:{tier:'T1',rank:1,eligible:true,authoritative:true},
    lineage:{status:'known',family_tokens:[`independent-${n}`]},...extra}));
  const draft=content.replace(/\.(?= |$)/g,' [1][2][3].');
  return finalizeDocumentAnswer({question,draft,docs,approvedDocs:docs,checks:[{supported:true,complete:true,evidence:[1,2,3]}],searchComplete:true,asOf});
}
const documentCases=[
  ['X1307-Q24',proof('1,307','thousands'),'What is the monthly fee under the shop contract for March 2026?','2026-11-12'],
  ['X1315-Q24',proof('250','thousands')],['X1315-Q27',proof('250','millions')],
  ['X1323-Q27','The sole authorized processor is processor A. The sole authorized processor is processor B.','Which single processor is authorized by the signed contract?'],
  ['X1322-Q02','The roof repair contract renews tomorrow.','What is the latest renewal date in the roof repair contract?','2026-11-14'],
];
for(const [id,content,question,asOf] of documentCases)test(`${id} STILL-HIGH: approving copies cannot certify unbound meaning`,t=>{
  const r=document(content,question,asOf);
  t.diagnostic(JSON.stringify({id,classification:'STILL-HIGH',figure:content.split('.')[0],percent:r.confidence.percent}));
  assert.ok(r.answer.length);assert.match(r.answer,/Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
  assert.ok(r.answer.includes(content.split('.')[0]),'source assertion survives in the answer');
  assert.ok(r.confidence.percent<90,r.confidence_text);
  assert.ok(r.answer_contract.provenance.checked_records>0,'the cited-record proof decision was reached');
  assert.match(r.confidence_text,/Why:.*Missing:/s);
});
test('complete unit-scale source and a consistent ordinary qualitative claim remain High',()=>{
  for(const content of [proof('250','units'),'The sole authorized processor is processor A.']){
    const r=document(content);assert.equal(r.confidence.percent,90,r.confidence_text);
  }
});
test('transport title wrappers cannot hide exclusive contradictions',()=>{
  const content='The sole authorized processor is processor A. The sole authorized processor is processor B.';
  const r=document(content,'Which single processor is authorized by the signed contract?','2026-11-12',{snippet:`[contract]\n\n${content}`});
  assert.ok(r.answer.includes('processor A') && r.answer.includes('processor B'));
  assert.ok(r.confidence.percent<90,r.confidence_text);
  assert.ok(r.answer_contract.provenance.checked_records>0,'the wrapped source reached the consistency decision');
});

// Report reconstructions use role-only labels. Signed finder expressions are
// intentionally preserved; a second plain SUM tests risks hidden by that cap.
const signedExpense='expense_minor + interest_expense_minor - refund_minor';
const signedIncome='income_minor + sales_adjust_minor';
const cappedCases=[
  ['X1295-Q02','expense_minor',[row(129500,'Bond repayment','Tenant A','outflow','2026-10-08','Bonds payable')]],
  ['X1295-Q05','expense_minor',[row(129500,'Beneficiary settlement','Property Owner A','outflow','2026-10-08','Landlord payable')]],
  ['X1295-Q06','expense_minor',[row(129500,'Rent remitted','Property Owner A','outflow','2026-10-08','Landlord payable')]],
  ['X1295-Q07','income_minor',[row(190000,'Tenant bond received','Tenant A','inflow','2026-10-08','Rental income')]],
  ['X1295-Q08','income_minor',[row(190000,'Rent collected for landlord','Tenant A','inflow','2026-10-08','Rental income')]],
  ['X1295-Q14','expense_minor',[row(129500,'Mortgage principal','Lender A')]],
  ['X1299-Q02',signedExpense,[row(129900,'Supply purchase','Supply vendor','outflow','2026-10-02'),row(129900,'Supply purchase','Supply vendor','outflow','2026-10-04')]],
  ['X1299-Q18',signedExpense,[row(129900,'Refundable reusable tote bond','Supply vendor')]],
  ['X1299-Q20',signedExpense,[row(129900,'Treasury bill purchase','Outside Securities','outflow','2026-10-02','investments')]],
  ['X1307-Q03',signedIncome,[row(130700,'Stripe payout','Stripe','inflow','2026-10-15'),row(130700,'Payout returned unpaid','Stripe','outflow','2026-10-16')]],
  ['X1307-Q20','expense_minor',[row(130700,'Performance bond','Outside Clearing','outflow','2026-10-15','refundable performance bond')]],
  ['X1307-Q21','income_minor',[row(130700,'Stripe','Stripe','inflow','2026-10-15')]],
  ['X1307-Q22',signedExpense,[row(130700,'Supply purchase','Supply vendor','outflow','2026-10-10'),row(30700,'Purchase refund','Supply vendor','inflow','2026-10-16'),row(30700,'Purchase refund','Supply vendor','inflow','2026-10-18')]],
  ['X1311-Q02',signedExpense,[row(240000,'ACH TENANCY BOND RETURN','tenant role')]],
  ['X1311-Q03',signedExpense,[row(720000,'NET RENT DISTRIBUTION','lessor role','outflow','2026-10-12','landlord payable')]],
  ['X1311-Q04',signedExpense,[row(180000,'REFUNDABLE MOBILIZATION ADVANCE','Repair vendor','outflow','2026-10-12','contractor advances receivable')]],
  ['X1311-Q06',signedExpense,[row(310000,'OPTION CONSIDERATION REFUNDABLE','Title counterparty','outflow','2026-10-12','refundable option receivable')]],
  ['X1311-Q09',signedIncome,[row(960000,'MONTHLY RENT','tenant role','inflow','2026-10-12','rental income')]],
  ['X1311-Q11',signedExpense,[row(55000,'REPAIR INVOICE','Repair vendor','outflow','2026-10-12'),row(55000,'REPAIR INVOICE','Repair vendor','outflow','2026-10-14')]],
  ['X1315-Q02','expense_minor',[row(131500,'Supply purchase','Supply vendor','outflow','2026-10-05'),row(131500,'Supply purchase','Supply vendor','outflow','2026-10-08')]],
  ['X1315-Q03',signedIncome,[row(450000,'Stripe payout','Stripe','inflow','2026-10-05'),row(450000,'RETURNED STRIPE PAYOUT','Stripe','outflow','2026-10-07')]],
  ['X1315-Q17','expense_minor',[row(500000,'AGREEMENT 1315','Outside capital','outflow','2026-10-05')]],
  ['X1319-Q02','expense_minor',[row(141900,'Bond return unit 4','tenant')]],
  ['X1319-Q05','expense_minor',[row(741900,'Beneficiary distribution unit 4','property beneficiary')]],
  ['X1319-Q09','expense_minor',[row(191900,'Plumbing invoice 1319','repair vendor'),row(191900,'Imported plumbing invoice 1319','repair vendor','outflow','2026-10-10')]],
  ['X1319-Q26','expense_minor',[row(341900,'Payout','tenant security deposit')]],
  ['X1319-Q27','expense_minor',[row(351900,'Payout','custodial funds')]],
  ['X1319-Q28','expense_minor',[row(361900,'Payout','property owner remittance')]],
  ['X1323-Q19','profit',[row(132300,'Loan to customer','Outside Buyer','outflow','2026-10-10','loan receivable')]],
  ['X1323-Q20','profit',[row(132300,'BUY SHARES','Outside Brokerage','outflow','2026-10-10','investment purchase')]],
  ['X1323-Q22','profit',[row(132300,'Deposit fully refundable','Packaging vendor')]],
  ['X1327-Q01','expense_minor',[row(132700,'Bond repayment','tenant')]],
  ['X1327-Q02','expense_minor',[row(713200,'October remittance','property beneficiary')]],
  ['X1327-Q09','expense_minor',[row(513200,'Scheduled instalment','Outside Finance')]],
  ['X1327-Q11','expense_minor',[row(132700,'Repair invoice','repair vendor','outflow','2026-10-12'),row(132700,'Imported repair invoice','repair vendor','outflow','2026-10-13')]],
  ['X1327-Q12','expense_minor',[row(132700,'Repair invoice','repair vendor','outflow','2026-10-12'),row(132700,'Imported repair invoice','repair vendor','outflow','2026-10-15')]],
  ['X1327-Q19','expense_minor',[row(613200,'Allocation','property beneficiary')]],
  ['X1327-Q20','expense_minor',[row(313200,'Quarterly instalment','Tax authority')]],
  ['X1297-Q36',signedIncome,[row(100000,'Customer payment','Customer','inflow'),row(30000,'Supply purchase','Supply vendor'),row(9000,'Refundable catering deposit refund','Catering customer','outflow','2026-10-15','CUSTOMER_REFUND')]],
  ['X1304-C38',signedExpense,[row(120000,'Supply purchase','Supply vendor'),row(240000,'TRANSFER TO CHECKING 3333',null,'outflow','2026-10-12'),row(240000,'TRANSFER FROM CHECKING 1111',null,'inflow','2026-10-12',null,'personal')]],
  ['X1328-Q23',signedExpense,[row(16829,'CAPITALIZED INTEREST CHARGE',null,'outflow','2026-10-08',null,'borrowing')]],
  ['X1328-Q32',signedExpense,[row(310040,'LOAN PRINCIPAL ADVANCED TO SUPPLIER','Supply vendor','outflow','2026-10-08','LOAN_RECEIVABLE')]],
];
for(const [id,expression,inputs] of cappedCases)test(`${id} CAPPED: retains a successful figure below High`,async t=>{
  const f=book(t,id);
  if(inputs.some(r=>r.account==='personal')){f.account('personal',{mode:'manual',mask:'3333',entity:'household'});f.coverage('personal','2026-01-01','2026-11-12');}
  if(inputs.some(r=>r.account==='borrowing')){f.account('borrowing',{mode:'manual',mask:'4242',kind:'loan'});f.coverage('borrowing','2026-01-01','2026-11-12');}
  for(const [i,r] of inputs.entries())f.row(`posting-${i}`,r.account,r.minor,{...r,day:id.startsWith('X1307')?r.day.replace('2026-10','2025-12'):r.day});
  const statement=expression==='profit'?sql('income_minor + sales_adjust_minor',f.period).replace('COALESCE(SUM(income_minor + sales_adjust_minor),0)','SUM(income_minor+sales_adjust_minor)-SUM(expense_minor+interest_expense_minor-refund_minor)'):sql(expression,f.period);
  const r=await query(f,statement);
  assert.ok(f.db.prepare('SELECT COUNT(*) AS n FROM fin_transactions').get().n>0,'nonempty source postings were actually loaded');
  assert.ok(Number.isSafeInteger(r.rows[0].cents),'a readable figure survives, including an observed zero');
  t.diagnostic(JSON.stringify({id,classification:'CAPPED',figure:r.rows[0].cents,percent:r.confidence.percent}));
  assert.ok(r.confidence.percent<90,r.confidence_text);assert.ok(r.confidence.missing.length);
});
for(const [id,content,extra] of [
  ['X1295-Q26','Pets are permitted.',{top_folder:'Unit B'}],
  ['X1311-Q23','Pets are permitted.',{top_folder:'Other unit'}],
  ['X1311-Q24','The tenant bond is refundable.',{top_folder:'Other unit'}],
])test(`${id} CAPPED: unresolved document scope retains the source assertion`,t=>{
  const r=document(content,'What does the current lease permit?','2026-11-12',extra);
  assert.ok(r.answer.includes(content.replace(/\.$/,'')));assert.ok(r.answer_contract.provenance.checked_records>0);
  t.diagnostic(JSON.stringify({id,classification:'CAPPED',figure:content,percent:r.confidence.percent}));
  assert.ok(r.confidence.percent<90,r.confidence_text);assert.match(r.confidence_text,/Why:.*Missing:/s);
});
test('X1315-Q28 CAPPED: an uncited older amendment retains its conflict',t=>{
  const content='Resale is permitted.';
  const docs=[1,2,3,4].map(n=>({n,title:n===4?'Signed contract amendment':'contract',source:`records-${n}`,
    snippet:n===4?'Resale is prohibited.':content,ts:n===4?'2026-01-01':'2026-11-11',date_reliable:true,text_reliable:true,
    read_complete:true,text_source:'native',authority:{tier:'T1',rank:1,eligible:true,authoritative:true},lineage:{status:'known',family_tokens:[`family-${n}`]}}));
  const r=finalizeDocumentAnswer({question:'Is resale permitted by the current contract?',draft:'Resale is permitted [1][2][3].',docs,
    approvedDocs:docs.slice(0,3),checks:[{supported:true,complete:true,evidence:[1,2,3]}],searchComplete:true,asOf:'2026-11-12'});
  assert.ok(r.answer.includes('Resale is permitted'));assert.ok(r.answer_contract.provenance.checked_records>0);
  t.diagnostic(JSON.stringify({id:'X1315-Q28',classification:'CAPPED',figure:content,percent:r.confidence.percent}));
  assert.ok(r.confidence.percent<90,r.confidence_text);
});
test('a supported adjustment SUM cannot certify returned security principal',async t=>{
  const f=book(t);f.row('receipt','operating',100000,{payee:'Customer',memo:'Customer payment'});
  f.row('principal-return','operating',9000,{direction:'outflow',memo:'Refundable catering deposit refund',payee:'Catering customer',category:'CUSTOMER_REFUND'});
  const r=await query(f,sql('sales_adjust_minor'));assert.equal(r.rows[0].cents,-9000);
  assert.ok(r.confidence.percent<90,r.confidence_text);assert.match(r.confidence_text,/90.00/);
});
test('a supported expense SUM cannot certify capitalized loan interest as cash',async t=>{
  const f=book(t);f.account('borrowing',{mode:'manual',mask:'4242',kind:'loan'});f.coverage('borrowing','2026-01-01','2026-11-12');
  f.row('accrual','borrowing',16829,{direction:'outflow',memo:'CAPITALIZED INTEREST CHARGE'});
  const r=await query(f,sql('expense_minor'));assert.equal(r.rows[0].cents,16829);
  assert.ok(r.confidence.percent<90,r.confidence_text);assert.match(r.confidence_text,/168.29/);
});

for(const measure of [undefined,'net_receipts'])test(`posted settlement purpose admits cash without certifying processor principal: ${measure??'inferred'}`,async t=>{
  const f=book(t);f.row('payout','operating',97000,{memo:'STRIPE PAYOUT'});
  const statement=sql('income_minor')+' AND income_minor>0';
  const green=await query(f,statement,{measure});assert.equal(green.rows[0].cents,97000);
  assert.ok(green.confidence.percent>=90,green.confidence_text);
  for(const memo of ['STRIPE','STRIPE PAYOUT CAPITAL ADVANCE','STRIPE PAYOUT HELD FOR OWNER','STRIPE PAYOUT MONTHLY ALLOCATION']) {
    f.run('UPDATE fin_transactions SET description=? WHERE txn_uid=?',memo,'payout');
    const bad=await query(f,statement,{measure});assert.equal(bad.rows[0].cents,97000);
    assert.ok(bad.confidence.percent<90,bad.confidence_text);assert.ok(bad.confidence.missing.length);
    assert.match(bad.confidence_text,/970.00/,'each reached source-risk decision names the retained dollars');
  }
});
test('posted rent and tax spending retain High while tax attribution and entrusted principal stay unproved',async t=>{
  const f=book(t);f.row('rent','operating',150000,{direction:'outflow',payee:'Rent vendor',category:'RENT'});
  f.row('tax','operating',6000,{direction:'outflow',payee:'Tax authority',category:'TAX'});
  const statement=sql('expense_minor')+' AND expense_minor>0';
  const green=await query(f,statement,{measure:'posted_spending'});assert.equal(green.rows[0].cents,156000);
  assert.ok(green.confidence.percent>=90,green.confidence_text);
  const attributed=await query(f,statement+" AND category='TAX'",{measure:'posted_spending'});
  assert.equal(attributed.rows[0].cents,6000);assert.ok(attributed.confidence.percent<90,attributed.confidence_text);
  assert.match(attributed.confidence_text,/tax payment type/,'the selected tax-population decision is reached');
  f.run("UPDATE fin_transactions SET description='Refundable tenant bond' WHERE txn_uid='tax'");
  const principal=await query(f,statement,{measure:'posted_spending'});assert.equal(principal.rows[0].cents,156000);
  assert.ok(principal.confidence.percent<90,principal.confidence_text);assert.match(principal.confidence_text,/60.00/);
  assert.match(principal.confidence_text,/principal|bond/,'posted tax relief cannot mask a different source risk');
});
test('payment for work proves ordinary purpose without promoting an opaque customer posting',async t=>{
  const f=book(t);f.row('receipt','operating',214511,{memo:'Payment for work',payee:'Customer',category:'CLIENT_INCOME'});
  f.run("UPDATE fin_transactions SET category_basis_state='proposed'");
  const green=await query(f,sql('income_minor'));assert.equal(green.rows[0].cents,214511);
  assert.ok(green.confidence.percent>=90,green.confidence_text);
  f.run("UPDATE fin_transactions SET description='Reference ABC',category=NULL,category_basis_state=NULL");
  const opaque=await query(f,sql('income_minor'));assert.equal(opaque.rows[0].cents,214511);
  assert.ok(opaque.confidence.percent<90,opaque.confidence_text);
  assert.match(opaque.confidence_text,/operating purpose/,'the changed purpose reaches the final certificate');
});
test('own office rent is an ordinary expense while tenant rent held for another owner stays provisional',async t=>{
  const f=book(t);f.row('rent','operating',80000,{memo:'Office rent paid to property owner',payee:'Supply vendor',direction:'outflow'});
  const green=await query(f,sql('expense_minor'));assert.equal(green.rows[0].cents,80000);
  assert.ok(green.confidence.percent>=90,green.confidence_text);
  f.run("UPDATE fin_transactions SET description='Tenant rent held for property owner'");
  const principal=await query(f,sql('expense_minor'));assert.equal(principal.rows[0].cents,80000);
  assert.ok(principal.confidence.percent<90,principal.confidence_text);
  assert.match(principal.confidence_text,/800.00/,'the changed ownership decision names the retained dollars');
});
test('closed lender payment receipts prove received cash while capitalized debt charges remain unproved',async t=>{
  const f=book(t);f.account('borrowing',{mode:'manual',mask:'4242',kind:'loan'});f.coverage('borrowing','2026-01-01','2026-11-12');
  f.row('principal','borrowing',90000,{memo:'PRINCIPAL PAYMENT'});
  f.row('interest','borrowing',10000,{memo:'INTEREST PAYMENT'});
  const green=await query(f,sql('paid_minor'));assert.equal(green.rows[0].cents,100000);
  assert.ok(green.confidence.percent>=90,green.confidence_text);
  f.run("UPDATE fin_transactions SET direction='outflow',description='CAPITALIZED INTEREST CHARGE' WHERE txn_uid='interest'");
  const accrual=await query(f,sql('expense_minor'));assert.equal(accrual.rows[0].cents,10000);
  assert.ok(accrual.confidence.percent<90,accrual.confidence_text);assert.match(accrual.confidence_text,/100.00/);
  assert.match(accrual.confidence_text,/cash settlement/,'a lender receipt cannot certify a separate debt charge');
});

// Boundary matrix uses real SQLite reads and the final confidence boundary.
// A period/account filter must never remove a potential partner before matching.
const boundaryDay=(day,offset)=>new Date(Date.parse(day+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
const monthEnd=(year,month)=>new Date(Date.UTC(year,month,0)).toISOString().slice(0,10);
function boundaryBook(t,from,to,accounts='same') {
  const f=fixture(t);f.env.BRAIN_TIMEZONE='UTC';
  f.account('operating',{mode:'manual',mask:'1111'});
  if(accounts!=='same')f.account('mirror',{mode:'manual',mask:accounts==='same-mask'?'1111':'2222'});
  for(const slug of accounts==='same'?['operating']:['operating','mirror'])f.coverage(slug,boundaryDay(from,-40),boundaryDay(to,40));
  f.period={period_from:from,period_to:to};f.clock=boundaryDay(to,41)+'T12:00:00Z';return f;
}
function boundarySources(f) {
  return f.db.prepare(`SELECT t.*,a.mask AS account,a.account_slug AS account_identity
    FROM fin_transactions t JOIN fin_accounts a USING(account_slug) ORDER BY t.posted_on,t.id`).all();
}
async function boundaryQuery(f,field,extra={}) {
  const statement=sql(field,f.period),parsed=await checked(f,statement);
  assert.equal(certifyMoneyQuery(parsed).certified,true,'the actual SQL shape certificate accepts the boundary aggregate');
  return query(f,statement,extra);
}
const boundaryMonths=[...Array.from({length:12},(_,i)=>monthEnd(2026,i+1)),'2024-02-29','2025-12-31'];
for(const end of boundaryMonths)for(const accounts of ['same','same-mask','different-mask'])for(const arm of ['both','before','after'])
  test(`R3 repeat ${end} ${accounts} ${arm}: outside-period partners retain dollars below High`,async t=>{
    const left=boundaryDay(end,-1),right=boundaryDay(end,3);
    assert.equal(Date.parse(right)-Date.parse(left),4*86400000);
    const from=arm==='after'?boundaryDay(end,1):end.slice(0,8)+'01';
    const to=arm==='before'?end:monthEnd(Number(right.slice(0,4)),Number(right.slice(5,7)));
    const f=boundaryBook(t,from,to,accounts),inside=arm==='before'?left:right,partner=arm==='before'?right:left;
    f.row('original','operating',80000,{day:inside,direction:'outflow',memo:'Plumbing repair',payee:'Repair vendor'});
    f.run("UPDATE fin_transactions SET source_doc_uid='statement-original'");
    const green=await boundaryQuery(f,'expense_minor');
    assert.equal(green.rows[0].cents,80000);assert.ok(green.confidence.percent>=90,green.confidence_text);
    f.row('copy',accounts==='same'?'operating':'mirror',80000,{day:partner,direction:'outflow',memo:'Plumbing repair',payee:'Repair vendor'});
    f.run("UPDATE fin_transactions SET source_doc_uid='statement-copy' WHERE txn_uid='copy'");
    const source=boundarySources(f);assert.equal(source.length,2,'both source observations were actually stored');
    const bad=await boundaryQuery(f,'expense_minor');
    assert.equal(bad.rows[0].cents,arm==='both'?160000:80000,'the period selection and provisional dollars stay unchanged');
    t.diagnostic(JSON.stringify({boundary:end,accounts,arm,figure:bad.rows[0].cents,percent:bad.confidence.percent}));
    assert.ok(bad.confidence.percent<90,bad.confidence_text);
    assert.ok(moneyOverlapGroups(source).some(g=>g.length===2),'the full-evidence duplicate decision actually nominates both rows');
    assert.match(bad.confidence_text,/800\.00.*(?:counted twice|repeat)/s,'the possible repeated dollars are named');
    assert.ok(bad.confidence.missing.length,'the statement proof needed to distinguish the observations is named');
  });
for(const [left,right] of [['2026-09-29','2026-10-03'],['2026-12-30','2027-01-03']])for(const arm of ['before','after'])for(const field of ['income_minor','expense_minor'])
  test(`R3 selected ${field} ${left} ${arm}: explicit measure and account scope retain outside partner`,async t=>{
    const end=monthEnd(Number(left.slice(0,4)),Number(left.slice(5,7))),from=arm==='before'?left.slice(0,8)+'01':right.slice(0,8)+'01';
    const to=arm==='before'?end:monthEnd(Number(right.slice(0,4)),Number(right.slice(5,7)));
    const f=boundaryBook(t,from,to,'different-mask'),income=field==='income_minor';
    const options={direction:income?'inflow':'outflow',memo:income?'Customer payment':'Plumbing repair',payee:income?'Customer':'Repair vendor'};
    f.row('original','operating',80000,{...options,day:arm==='before'?left:right});
    const extra={account_slugs:['operating'],measure:income?'net_receipts':'posted_spending'};
    const green=await boundaryQuery(f,field,extra);assert.equal(green.rows[0].cents,80000);assert.ok(green.confidence.percent>=90,green.confidence_text);
    f.row('copy','mirror',80000,{...options,day:arm==='before'?right:left});
    const bad=await boundaryQuery(f,field,extra);assert.equal(boundarySources(f).length,2);assert.equal(bad.rows[0].cents,80000);
    assert.ok(bad.confidence.percent<90,bad.confidence_text);assert.match(bad.confidence_text,/800\.00.*(?:counted twice|repeat)/s);
    assert.ok(moneyOverlapGroups(boundarySources(f)).length,'the excluded account partner reaches the duplicate decision');
  });
for(const accounts of ['same','same-mask','different-mask'])for(const field of ['income_minor','expense_minor'])
  test(`R3 same-day repeat ${accounts} ${field}: evidence was read and the figure survives`,async t=>{
    const f=boundaryBook(t,'2026-10-01','2026-10-31',accounts),options={day:'2026-10-15',direction:field==='income_minor'?'inflow':'outflow',memo:field==='income_minor'?'Customer payment':'Plumbing repair',payee:'Outside vendor'};
    f.row('original','operating',80000,options);const green=await boundaryQuery(f,field);assert.equal(green.rows[0].cents,80000);assert.ok(green.confidence.percent>=90,green.confidence_text);
    f.row('copy',accounts==='same'?'operating':'mirror',80000,options);const bad=await boundaryQuery(f,field);
    assert.equal(boundarySources(f).length,2);assert.equal(bad.rows[0].cents,160000);assert.ok(moneyOverlapGroups(boundarySources(f)).length);
    assert.ok(bad.confidence.percent<90,bad.confidence_text);assert.match(bad.confidence_text,/800\.00.*(?:counted twice|repeat)/s);
  });
for(const arm of ['before','after'])test(`R3 source identity ${arm}: distant outside-period repeat cannot be hidden`,async t=>{
  const f=boundaryBook(t,'2026-10-01','2026-10-31');
  f.row('original','operating',80000,{day:'2026-10-15',direction:'outflow',memo:'Plumbing repair',payee:'Repair vendor'});
  f.run("UPDATE fin_transactions SET external_id='provider-posting' WHERE txn_uid='original'");
  const green=await boundaryQuery(f,'expense_minor');assert.equal(green.rows[0].cents,80000);assert.ok(green.confidence.percent>=90,green.confidence_text);
  f.row('copy','operating',80001,{day:arm==='before'?'2026-07-01':'2027-01-10',direction:'outflow',memo:'Plumbing repair',payee:'Repair vendor'});
  f.run("UPDATE fin_transactions SET external_id='provider-posting' WHERE txn_uid='copy'");
  const bad=await boundaryQuery(f,'expense_minor');assert.equal(bad.rows[0].cents,80000);assert.equal(boundarySources(f).length,2);
  assert.ok(moneyOverlapGroups(boundarySources(f)).length,'the provider identity decision was reached');
  assert.ok(bad.confidence.percent<90,bad.confidence_text);assert.match(bad.confidence_text,/800\.00.*(?:counted twice|repeat)/s);
});
for(const [left,right] of [['2026-09-29','2026-10-03'],['2026-12-30','2027-01-03']])for(const arm of ['before','after'])
  test(`R3 reversal ${left} ${arm}: matching uses both sides of the period`,async t=>{
    const inside=arm==='before'?left:right,from=inside.slice(0,8)+'01',to=monthEnd(Number(inside.slice(0,4)),Number(inside.slice(5,7)));
    const f=boundaryBook(t,from,to);
    f.row('selected','operating',80000,{day:inside,direction:'inflow',memo:'Customer payment',payee:'Customer'});
    const green=await boundaryQuery(f,'income_minor');assert.equal(green.rows[0].cents,80000);assert.ok(green.confidence.percent>=90,green.confidence_text);
    if(arm==='after')f.run("UPDATE fin_transactions SET direction='outflow',description='ACH credit reversal' WHERE txn_uid='selected'");
    f.row('partner','operating',80000,{day:arm==='before'?right:left,direction:arm==='before'?'outflow':'inflow',memo:arm==='before'?'ACH credit reversal':'Customer payment',payee:'Customer'});
    assert.equal(boundarySources(f).length,2,'the original and return are real recorded observations');
    const bad=await boundaryQuery(f,'income_minor');assert.equal(bad.rows[0].cents,arm==='before'?80000:-80000);
    assert.ok(bad.confidence.percent<90,bad.confidence_text);assert.match(bad.confidence_text,/800\.00/);
    assert.ok(bad.confidence.reasons.some(reason=>reason.includes(left)&&reason.includes(right)&&/reversal.*period|period.*reversal/i.test(reason)),
      'the final boundary decision names both dates and the cross-period reversal');
  });
for(const dates of [['2026-08-05','2026-09-05','2026-10-05'],['2026-11-05','2026-12-05','2027-01-05'],['2024-01-31','2024-02-29','2024-03-31']])for(const memo of [null,'Software subscription'])
  test(`R3 supported monthly recurrence ${dates.join(' ')} ${memo??'category only'}: recorded cadence retains High`,async t=>{
    const from=dates[0].slice(0,8)+'01',last=dates.at(-1),to=monthEnd(Number(last.slice(0,4)),Number(last.slice(5,7)));
    const f=boundaryBook(t,from,to);
    for(const [i,day] of dates.entries())f.row(`subscription-${i}`,'operating',7900,{day,direction:'outflow',memo,payee:'Software vendor',category:'SOFTWARE'});
    const source=boundarySources(f);assert.equal(source.length,3);
    const r=await boundaryQuery(f,'expense_minor');assert.equal(r.rows[0].cents,23700);assert.ok(r.confidence.percent>=90,r.confidence_text);
    assert.equal(moneyOverlapGroups(source).length,0,'complete monthly cadence is distinguished from short posting drift');
  });
test('R3 disconnected outside repeats and different amounts retain the ordinary High control',async t=>{
  const f=boundaryBook(t,'2026-10-01','2026-10-31');
  f.row('selected','operating',80000,{day:'2026-10-03',direction:'outflow',memo:'Plumbing repair',payee:'Repair vendor'});
  const green=await boundaryQuery(f,'expense_minor');assert.equal(green.rows[0].cents,80000);assert.ok(green.confidence.percent>=90,green.confidence_text);
  for(const uid of ['old-first','old-copy'])f.row(uid,'operating',5000,{day:'2026-09-29',direction:'outflow',memo:'Office supplies',payee:'Supply vendor'});
  const source=boundarySources(f);assert.equal(source.length,3);assert.ok(moneyOverlapGroups(source).length,'the old duplicate decision actually executes');
  const r=await boundaryQuery(f,'expense_minor');assert.equal(r.rows[0].cents,80000);assert.equal(r.confidence.percent,green.confidence.percent);
});
