import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/clean-money-fixture.mjs';
import { queryMoney, MONEY_GUIDE } from '../src/lib/money-query.js';

const period={period_from:'2026-10-01',period_to:'2026-10-31'};
const where="posted_on BETWEEN '2026-10-01' AND '2026-10-31'";
const out=(slug,n,day,memo,extra={})=>[slug,n,{direction:'outflow',day:'2026-10-'+day,memo,...extra}];
const credit=(slug,n,day,memo='PAYMENT THANK YOU',extra={})=>[slug,n,{day:'2026-10-'+day,memo,...extra}];
const payment=(n=50000,day='10',card='card',mask='4444')=>out('chk',n,day,'Payment to card '+mask);
const pair=[payment(),credit('card',50000,'11')];
const two=[...pair,payment(30000,'12','card2','5555'),credit('card2',30000,'13')];
const loanPair=[out('chk',125000,'15','Loan payment to 7777'),credit('loan',125000,'16','PAYMENT RECEIVED')];
const moved=[out('loc',200000,'06','TRANSFER TO 4444'),credit('card',200000,'07','TRANSFER FROM 8888')];
const balance=(codes=true)=>[out('card2',200000,'06','BALANCE TRANSFER',{category:codes?'TRANSFER_OUT_ACCOUNT_TRANSFER':null}),credit('card',200000,'07','BALANCE TRANSFER CREDIT',{category:codes?'TRANSFER_IN_ACCOUNT_TRANSFER':null}),out('card2',6000,'06','BALANCE TRANSFER FEE',{category:'BANK_FEES_OTHER_BANK_FEES'})];
const cases=[
 ['B6-1',pair,{card:50000}],['B6-2',two,{card:50000}],['B6-3',two,{card2:30000}],
 ['B6-4',two,{credited:50000}],['B6-5',[payment(34000,'03','card2','5555')],{card2:34000}],
 ['B6-6',[credit('card',50000,'11')],{paid:50000,card:50000,credited:50000}],
 ['B6-7',loanPair,{loan:125000}],
 ['B6-8',[['chk',50000,{direction:'outflow',day:'2026-09-30',memo:'Payment to card 4444'}],credit('card',50000,'01')],{paid:0,credited:50000},true],
 ['B6-9',[payment()],{paid:0,spend:50000},true,{collision:true}],
 ['B6-10',[out('chk',45000,'10','AUTOPAY CARD ISSUER',{payee:'card issuer',category:'CREDIT_CARD_PAYMENT'})],{paid:0,spend:45000},true],
 ['B6-11',[credit('card',50000,'10'),out('card',50000,'13','RETURNED PAYMENT')],{paid:0,card:0,credited:0},true],
 ['B6-12',[payment(20000,'05','card2','5555'),credit('card',70000,'09')],{paid:90000,card:70000,card2:20000}],
 ['B6-13',two,{kind:80000},true],
 ['B6-14',[...two,out('card',12345,'20','MERCHANT PURCHASE',{category:'PURCHASE'}),credit('chk',150000,'21','CLIENT INCOME',{category:'INCOME'})],{spend:12345,income:150000},true],
 ['B6-15',pair,{scopedPaid:0,gap:'repayment_paid_outside_scope'}],
 ['B12-1',[payment(50000,'09'),credit('card',50000,'14')],{paid:50000,likely:true}],
 ['B12-2',[payment(),payment(50000,'12'),credit('card',50000,'11'),credit('card',50000,'13')],{paid:100000,likely:true}],
 ['B12-3',[out('chk',125000,'09','Loan payment to 7777'),credit('loan',125000,'14','PAYMENT RECEIVED')],{paid:125000,likely:true}],
 ['B12-4',[payment(),credit('card',50000,'08')],{paid:50000},true],
 ['B12-5',[payment(50000,'05'),payment(50000,'12'),payment(50000,'19'),credit('card',50000,'06'),credit('card',50000,'20')],{paid:150000},true],
 ['B12-6',[payment(50000,'09'),credit('card',50000,'14'),credit('card',50000,'15')],{paid:100000,likely:true}],
 ['B12-7',[payment(50000,'09'),credit('card',49500,'14')],{paid:99500},true],
 ['B12-8',[payment(50000,'09'),credit('card',50000,'15')],{paid:50000,likely:true}],
 ['B12-9',[payment(50000,'09','card2','5555'),credit('card',50000,'14')],{paid:100000},true],
 ['B12-10',[out('chk',125000,'15','LOAN PAYMENT PRINCIPAL 939.85 INTEREST 310.15'),credit('loan',125000,'16','PAYMENT')],{paid:125000,spend:125000,likely:true}],
 ['B12-11',[credit('card',50000,'02'),out('chk',125000,'02','LOAN PAYMENT PRINCIPAL 939.85 INTEREST 310.15'),out('chk',125000,'02','LOAN PAYMENT PRINCIPAL 939.84 INTEREST 310.15')],{paid:175000},true],
 ['B12-12',[out('chk',50000,'10','CREDIT CARD AUTOPAY'),credit('card',50000,'11')],{paid:50000,spend:50000},true],
 ['B13-1',moved,{paid:0,moved:200000}],
 ['B13-2',[out('card2',200000,'06','PAYMENT TO CARD 4444')],{paid:0,moved:200000,spend:0}],
 ['B13-3',[out('loan2',1800000,'10','TRANSFER TO 7777'),credit('loan',1800000,'10','TRANSFER FROM 9999')],{paid:0,moved:1800000}],
 ['B13-4',balance(),{paid:0,spend:6000,moved:200000},true],
 ['B13-5',balance(false),{paid:0,spend:206000},true],
 ['B13-6',[out('loan2',1800000,'10','DISBURSEMENT TO PAYOFF'),credit('loan',1800000,'10','PAYOFF')],{paid:1800000,spend:1800000,likely:true}],
 ['B13-7',pair,{paid:50000,moved:0},true],
 ['B13-8',[out('chk',200000,'18','TRANSFER TO 8888'),credit('loc',200000,'18','TRANSFER FROM 1111'),out('chk',9000,'20','SOFTWARE SUBSCRIPTION',{category:'GENERAL_SERVICES_OTHER'})],{paid:200000,spend:9000},true],
 ['B13-9',[out('loc',230011,'01','TRANSFER TO account 1111',{category:'LINE_OF_CREDIT_ADVANCE'}),credit('chk',230011,'02','TRANSFER FROM account 8888',{category:'LINE_OF_CREDIT_ADVANCE'})],{paid:0,income:0,moved:0},true],
 ['B13-10',[out('loc',200000,'06','TRANSFER TO 4444',{category:'LINE_OF_CREDIT_ADVANCE'}),credit('card',200000,'07','TRANSFER FROM 8888')],{paid:0,moved:200000},true],
 ['B13-11',loanPair.map(r=>r[0]==='chk'?['sav',...r.slice(1)]:r),{paid:125000},true],
 ['B13-12',[out('loc',200000,'06','PAYMENT TO CARD 4444'),credit('card',200000,'07')],{paid:0,moved:200000,likely:true}],
 ['B13-13',[...moved,...pair],{paid:50000,moved:200000,credited:50000}],
 // 0.4.28 cash advances are likely loan proceeds: left out of spending and disclosed below High.
 ['B13-14',[out('card',100000,'06','CASH ADVANCE'),credit('chk',100000,'07','DEPOSIT')],{paid:0,spend:0,income:100000},true],
];

for(const [name,rows,expected,control,opts={}] of cases)test(`${name}${control?' control':''}: one repayment event`,async t=>{
 const f=fixture(t);
 for(const [slug,kind,mask] of [['chk','checking','1111'],['sav','savings','2222'],['card','card','4444'],['card2','card',opts.collision?'4444':'5555'],['loan','loan','7777'],['loan2','loan','9999'],['loc','line_of_credit','8888']]){
  f.account(slug,{kind,mask,mode:'manual'});f.coverage(slug,'2026-09-01','2026-10-31');
 }
 rows.forEach(([slug,n,options],i)=>f.row('row-'+i,slug,n,options));
 const expressions={paid:'paid_minor',spend:'expense_minor',income:'income_minor',moved:'debt_moved_minor',
  card:"CASE WHEN paid_to_account_slug='card' THEN paid_minor ELSE 0 END",card2:"CASE WHEN paid_to_account_slug='card2' THEN paid_minor ELSE 0 END",loan:"CASE WHEN paid_to_account_slug='loan' THEN paid_minor ELSE 0 END",kind:"CASE WHEN money_kind='card_payment' AND direction='outflow' THEN amount_minor ELSE 0 END"};
 const result=await queryMoney(f.env,{...period,sql:`SELECT ${Object.entries(expressions).map(([k,v])=>`COALESCE(SUM(${v}),0) AS ${k}`).join(',')} FROM txn WHERE ${where}`});
 for(const [k,n] of Object.entries(expected))if(k in expressions)assert.equal(result.rows[0][k],n,k);
 if(expected.likely){assert.ok(result.confidence.percent<90);const g=result.confidence.gaps.find(g=>g.code==='repayment_unproved');assert.ok(g);assert.ok(g.amounts.some(a=>a.inflow_minor>0||a.outflow_minor>0));assert.ok(g.why && g.missing);}
 if(expected.credited!==undefined || expected.scopedPaid!==undefined){
  const r=await queryMoney(f.env,{...period,account_slugs:['card'],sql:`SELECT COALESCE(SUM(credited_minor),0) credited,COALESCE(SUM(paid_minor),0) paid FROM txn WHERE ${where}`});
  if(expected.credited!==undefined)assert.equal(r.rows[0].credited,expected.credited);
  if(expected.scopedPaid!==undefined){assert.equal(r.rows[0].paid,expected.scopedPaid);assert.ok(r.confidence.percent<90);const g=r.confidence.gaps.find(g=>g.code===expected.gap);assert.match(g.why,/500\.00/);assert.match(g.why,/1111/);assert.match(g.why,/4444/);}
 }
 if(name==='B13-14') {
  assert.ok(result.confidence.percent<90);
  const r=await queryMoney(f.env,{sql:"SELECT expense_minor,estimated,estimate_reason FROM txn WHERE txn_uid='row-0'"});
  assert.equal(r.rows[0].expense_minor,0);assert.equal(r.rows[0].estimated,1);
  assert.match(result.confidence.reasons.join(' '),/1,000\.00/);
 }
 if(name==='B6-10' || name==='B6-9' || name==='B12-12'){
  const r=await queryMoney(f.env,{...period,sql:`SELECT SUM(expense_minor) n FROM txn WHERE ${where}`});assert.ok(r.confidence.percent<90);
  const g=r.confidence.gaps.find(g=>g.code==='estimated_membership');assert.ok(g);assert.ok(g.amounts.some(a=>a.outflow_minor>0));
 }
});

test('repayment guide specifies destinations, separate credit dates and uncertainty',()=>{
 for(const name of ['paid_to_account_slug','paid_to_account','credited_minor','debt_moved_minor','likely_'])assert.ok(MONEY_GUIDE.includes(name));
 assert.equal(cases.length,41);
});
