import test from 'node:test';
import assert from 'node:assert/strict';
import { overviewFixture } from './helpers/money-overview-fixture.mjs';
import { queryMoney } from '../src/lib/money-query.js';
import { overviewMoney } from '../src/lib/money-overview.js';
import { MONEY_GUIDE } from '../src/lib/money-query-contract.js';
import { markFeedDuplicates } from '../src/lib/clean-money-duplicates.js';
import { moneyQueryQuality } from '../src/lib/money-query-quality.js';

const NOW=Date.parse('2026-11-12T15:00:00Z');
const PERIOD={period_from:'2026-10-01',period_to:'2026-10-31'};
const dates="posted_on BETWEEN '2026-10-01' AND '2026-10-31'";
const spending=`SELECT SUM(expense_minor) AS minor FROM txn WHERE ${dates}`;
const recipe=name=>MONEY_GUIDE.split('\n').find((line,i,all)=>line.startsWith('SELECT ') && all[i-1].startsWith(name+':')).replaceAll('2026-09','2026-10');
function book(t) {
  const f=overviewFixture(t); f.env.BRAIN_TIMEZONE='UTC';
  f.run("INSERT INTO fin_entities(entity_slug,legal_name,kind,provenance,basis_state,recorded_at) VALUES ('biz','Business role','business','owner_stated','confirmed','2025-01-01T00:00:00Z')");
  f.acct=(slug,{mask='1111',kind='checking',side='business',provider='plaid',mode='live'}={})=>{
    f.account(slug,mode,kind==='loan'?'card':kind);f.run('UPDATE fin_accounts SET account_kind=? WHERE account_slug=?',kind,slug);f.run('UPDATE fin_accounts SET entity_slug=?,mask=? WHERE account_slug=?',side==='business'?'biz':'owner',mask,slug);
    if(mode==='live'){f.connection(slug,provider);f.run('UPDATE bank_feed_items SET last_synced_at=? WHERE item_ref=?','2026-11-12T12:00:00Z',slug);}
    f.coverage(slug,'2026-01-01','2026-11-12');
  };
  f.tx=(id,slug,day,minor,direction='outflow',description='SUPPLIER PURCHASE',extra={})=>{
    f.row(id,slug,day,minor,direction,{description,pending:extra.pending});
    if(extra.provenance==='feed')f.run("UPDATE fin_transactions SET source_feed='synthetic-feed' WHERE txn_uid=?",id);
    for(const [column,value] of Object.entries(extra))if(column!=='pending') f.run(`UPDATE fin_transactions SET ${column}=? WHERE txn_uid=?`,value,id);
  };
  f.ask=(sql=spending,extra=PERIOD)=>queryMoney(f.env,{sql,...extra},{now:()=>NOW});
  return f;
}

for(const gap of [0,1,3])test(`B15 mirrored feeds with ${gap}-day drift correct spending and cash flow, unmatched dollars survive`,async t=>{
  const f=book(t);f.acct('feed-a');f.acct('feed-b',{provider:'simplefin'});
  for(let i=0;i<5;i++)for(const [slug,offset] of [['feed-a',0],['feed-b',gap]])
    f.tx(slug+i,slug,`2026-10-${String(2+i*5+offset).padStart(2,'0')}`,(i+1)*10000);
  f.tx('unmatched','feed-a','2026-10-29',5000);
  const r=await f.ask();assert.equal(r.rows[0].minor,155000);assert.ok(r.confidence.percent<90);
  const cash=await f.ask(recipe('Cash flow'));assert.equal(cash.rows[0].cash_out_minor,155000);
  const copies=await f.ask(recipe('Possible duplicates'));assert.equal(copies.rows[0].possible_duplicate_minor,150000);assert.equal(copies.rows[0].row_count,5);
  assert.match(r.confidence.reasons.join(' '),/duplicate|copies|counted twice/i);
});

test('B15/A12 distinct source documents in one account remain counted, disclosed below High',async t=>{
  const f=book(t);f.acct('import',{mode:'manual'});
  for(const [id,amount,doc,description] of [['a',150000,'statement-role','BANK DEBIT SUPPLIER'],['b',150000,'export-role','Supplier #12'],['c',250000,'statement-role','BANK DEBIT RENT'],['d',250000,'export-role','Rent role']])
    f.tx(id,'import',amount===150000?'2026-10-07':'2026-10-19',amount,'outflow',description,{source_doc_uid:doc});
  for(const extra of [PERIOD,{}]) {
    const r=await f.ask(spending,extra);assert.equal(r.rows[0].minor,800000);assert.ok(r.confidence.percent<90);
    assert.equal(r.evidence.accounts[0].possible_duplicate_minor,400000);
    assert.match(r.confidence.reasons.join(' '),/4,000\.00.*counted twice|duplicate/i);assert.ok(r.confidence.missing.length);
  }
  assert.equal((await f.ask(recipe('Possible duplicates'))).rows[0].possible_duplicate_minor,400000);
  assert.equal((await f.ask('SELECT possible_duplicate_count FROM coverage')).rows[0].possible_duplicate_count,4);
});

for(const variant of ['same source repeats','different masks','different currency','opposite direction','four day drift','proved transfer'])test(`B15 control: ${variant}`,async t=>{
  const f=book(t);f.acct('a');
  f.acct('b',{mask:variant==='different masks'?'2222':'1111',provider:'simplefin'});
  if(variant==='different currency')f.run("UPDATE fin_accounts SET currency='CAD' WHERE account_slug='b'");
  if(variant==='proved transfer') {
    f.run("UPDATE fin_accounts SET mask='2222' WHERE account_slug='b'");
    f.tx('a1','a','2026-10-07',10000,'outflow','TRANSFER TO 2222',{category:'TRANSFER',category_basis_state:'confirmed',provenance:'feed'});
    f.tx('b1','b','2026-10-07',10000,'inflow','TRANSFER FROM 1111',{category:'TRANSFER',category_basis_state:'confirmed',provenance:'feed'});
    assert.equal((await f.ask()).rows[0].minor,0);return;
  }
  const same=variant==='same source repeats';
  f.tx('a1','a','2026-10-07',450);
  f.tx('b1',same?'a':'b',variant==='four day drift'?'2026-10-11':'2026-10-07',450,variant==='opposite direction'?'inflow':'outflow','SUPPLIER PURCHASE',variant==='different currency'?{currency:'CAD'}:{});
  const r=await f.ask();assert.equal(r.rows[0].minor,variant==='opposite direction'?450:900);
  const detail=await f.ask(`SELECT estimated,estimate_reason FROM txn WHERE ${dates}`);
  assert.ok(detail.rows.every(r=>!String(r.estimate_reason).includes('duplicate')));
  // Candidate 4 keeps same-day equal rows in one account as overlap candidates
  // (fold stage 1 stated limit): the figure stays whole and below High.
  if(same){assert.ok(r.confidence.percent<90);assert.match(r.confidence.reasons.join(' '),/repeat|duplicate|overlap/i);}
});

test('fold: equal postings repeated inside one account keep a flat review cost; a copy in another account record follows dollar share',async t=>{
  const f=book(t);f.acct('a');f.acct('b',{mask:'2222',provider:'simplefin'});
  f.tx('a1','a','2026-10-07',450);f.tx('a2','a','2026-10-07',450);
  const repeat=await f.ask();assert.equal(repeat.rows[0].minor,900);
  assert.equal(repeat.evidence.accounts.find(a=>a.account_slug==='a').same_account_repeat_minor,450);
  assert.equal(repeat.confidence.level,'Medium');assert.equal(repeat.confidence.percent,80);
  f.run("DELETE FROM fin_transactions WHERE txn_uid='a2'");f.tx('b1','b','2026-10-07',450);
  const copy=await f.ask();assert.equal(copy.rows[0].minor,900);
  // 0.4.28 duplicate evidence assigns the flagged copy to the stable preferred-feed row.
  const b=copy.evidence.accounts.find(a=>a.account_slug==='b');assert.equal(b.possible_duplicate_minor,0);assert.equal(b.same_account_repeat_minor,0);
  assert.equal(copy.evidence.accounts.find(a=>a.account_slug==='a').possible_duplicate_minor,450);
  assert.ok(copy.confidence.percent<repeat.confidence.percent,'a half-share possible copy costs more than the flat repeat review');
});

test('B15 duplicate marking is deterministic and stable when called twice',()=>{
  const rows=[];for(let i=0;i<5;i++)for(const slug of ['a','b'])rows.push({id:rows.length+1,tenant_id:'primary',account_slug:slug,account_identity:slug,account:'1111',currency:'USD',entity:'biz',identity_basis:'separate_account',feed_kind:'plaid',posted_on:`2026-10-${String(i+1).padStart(2,'0')}`,amount_minor:i+1,direction:'outflow'});
  const ds=rows.map(r=>({id:r.id,money_kind:'ordinary',estimated:0}));markFeedDuplicates(rows,ds);const once=structuredClone(ds);markFeedDuplicates(rows,ds);assert.deepEqual(ds,once);assert.equal(ds.filter(d=>d.money_kind==='likely_duplicate').length,5);
});

test('B15 duplicate cost scales with dollar share',()=>{
  const fixture=amount=>({rows:[{id:1,tenant_id:'primary',account_slug:'a',account_identity:'a',account:'1111',currency:'USD',posted_on:'2026-10-05',direction:'outflow',amount_minor:100,basis_state:'confirmed'},{id:2,tenant_id:'primary',account_slug:'b',account_identity:'b',account:'1111',currency:'USD',posted_on:'2026-10-05',direction:'outflow',amount_minor:100,basis_state:'confirmed'}, {id:3,tenant_id:'primary',account_slug:'a',currency:'USD',posted_on:'2026-10-06',direction:'outflow',amount_minor:amount,basis_state:'confirmed'}],coverage:[],accounts:[],pending:[],pairs:[]});
  const cost=amount=>moneyQueryQuality(fixture(amount),[]).gaps.find(g=>g.code==='possible_duplicate').amounts;
  assert.equal(cost(10000)[0].outflow_minor,200);
  const penalty=amount=>100-moneyQueryQuality(fixture(amount),[]).score;
  assert.ok(penalty(100)>penalty(10000));
});

for(const empty of [false,true])test(`B11 requested Plaid history cannot certify before delivery (${empty?'empty':'ordinary first row'})`,async t=>{
  const f=book(t);f.acct('a');f.run("UPDATE fin_account_coverage SET covered_from='2024-11-12',basis_note='Plaid completed the requested history window.'");
  f.run("INSERT INTO bank_feed_backfill(item_ref,requested_days,state,queued_at,finished_at,provider_history_state) VALUES ('a',730,'complete','2026-11-12T08:00:00Z','2026-11-12T08:30:00Z','HISTORICAL_UPDATE_COMPLETE')");
  if(!empty)f.tx('first','a','2026-08-03',30000);
  const sql="SELECT COALESCE(SUM(expense_minor),0) AS minor FROM txn WHERE posted_on BETWEEN '2026-06-01' AND '2026-06-30'";
  for(const extra of [{period_from:'2026-06-01',period_to:'2026-06-30'},{}]){const r=await f.ask(sql,extra);assert.equal(r.rows[0].minor,0);assert.ok(r.confidence.percent<90);assert.match(r.confidence.reasons.join(' '),/history|unverified/i);assert.ok(r.confidence.missing.length);}
  const overview=await overviewMoney(f.env,{now:()=>NOW});assert.ok(overview.accounts[0].gaps.length);assert.equal(overview.accounts[0].account_start,null);
});

test('B11 interior hole in a busy account lowers confidence and names exact dates; quiet months stay covered',async t=>{
  const f=book(t);f.acct('a');
  for(let d=1;d<=30;d++)if(d<10 || d>20)f.tx('d'+d,'a',`2026-10-${String(d).padStart(2,'0')}`,100000,'inflow','CUSTOMER PAYMENT',{payee:'Customer role'});
  const r=await f.ask(`SELECT SUM(income_minor) AS minor FROM txn WHERE ${dates}`);assert.equal(r.rows[0].minor,1900000);assert.ok(r.confidence.percent<90);assert.match(r.confidence.reasons.join(' '),/possible feed hole.*2026-10-10 through 2026-10-20/i);
  const overview=await overviewMoney(f.env,{now:()=>NOW});assert.ok(overview.accounts[0].gaps.some(g=>g.reason==='possible_feed_hole' && g.from==='2026-10-10' && g.to==='2026-10-20'));
  const quiet=await f.ask("SELECT COALESCE(SUM(expense_minor),0) AS minor FROM txn WHERE posted_on BETWEEN '2026-09-01' AND '2026-09-30'",{period_from:'2026-09-01',period_to:'2026-09-30'});assert.equal(quiet.rows[0].minor,0);assert.equal(quiet.confidence.level,'High');
});

for(const proof of ['opened_on','opening deposit','simplefin certified'])test(`B11 control: ${proof}`,async t=>{
  const f=book(t);f.acct('a',{provider:proof==='simplefin certified'?'simplefin':'plaid'});
  f.run("UPDATE fin_account_coverage SET basis_note='Plaid completed the requested history window.'");
  f.tx('first','a','2026-08-03',100,'inflow',proof==='opening deposit'?'OPENING DEPOSIT':'CUSTOMER PAYMENT',{category:'OWNER_CONTRIBUTION',category_basis_state:'confirmed'});
  if(proof==='opened_on')f.run("UPDATE fin_accounts SET opened_on='2026-08-01'");
  if(proof==='simplefin certified')f.run("UPDATE fin_account_coverage SET basis_note='Owner reviewed complete statement history.'");
  if(proof==='opening deposit')f.run("INSERT INTO bank_feed_backfill(item_ref,requested_days,state,queued_at,finished_at,provider_history_state) VALUES ('a',730,'complete','2026-11-12T08:00:00Z','2026-11-12T08:30:00Z','HISTORICAL_UPDATE_COMPLETE')");
  const r=await f.ask("SELECT COALESCE(SUM(expense_minor),0) AS minor FROM txn WHERE posted_on BETWEEN '2026-06-01' AND '2026-06-30'",{period_from:'2026-06-01',period_to:'2026-06-30'});assert.equal(r.rows[0].minor,0);
  if(proof==='simplefin certified'){assert.equal(r.confidence.level,'High');return;}
  // Candidate 4 review fix (audit b:B03): June lies wholly before the proved
  // account start, so no recorded account covers it and $0 is not proved.
  // 0.4.28 history proof no longer treats an opening-deposit memo as an opening date.
  assert.equal(r.confidence.level,'Low');assert.match(r.confidence.reasons.join(' '),proof==='opening deposit'?/bank history only starts 2026-08-03.*2026-06-01 through 2026-06-30/:/No recorded account was open between 2026-06-01 and 2026-06-30/);
  // The start proof still clips pre-opening days without a gap.
  const aug=await f.ask("SELECT COALESCE(SUM(expense_minor),0) AS minor FROM txn WHERE posted_on BETWEEN '2026-07-15' AND '2026-08-31'",{period_from:'2026-07-15',period_to:'2026-08-31'});assert.equal(aug.rows[0].minor,0);assert.equal(aug.confidence.level,proof==='opening deposit'?'Low':'High',aug.confidence.reasons.join(' | '));
  if(proof==='opening deposit') {assert.equal(aug.confidence.percent,65);assert.match(aug.confidence.reasons.join(' '),/2026-07-15 through 2026-08-02/);}
});

test('B17 exact provider twins disappear from all pending evidence; unproved matches remain visible',async t=>{
  const f=book(t);f.acct('a');f.tx('hold','a','2026-10-30',8000,'outflow','HOLD',{pending:true,source_provider:'plaid',external_id:'hold-role'});
  f.tx('post','a','2026-11-07',8000,'outflow','PURCHASE',{source_provider:'plaid',pending_transaction_id:'hold-role'});
  // A coverage-only read is outside candidate 4's proved txn grammar (Low 40);
  // the twin's effect on confidence is checked on the proved spending total.
  const r=await f.ask('SELECT pending_rows,pending_out_minor FROM coverage');assert.equal(r.rows[0].pending_rows,0);assert.equal(r.evidence.accounts[0].pending.rows,0);assert.doesNotMatch(r.confidence.reasons.join(' '),/pending/i);
  const totals=await f.ask();assert.equal(totals.evidence.accounts[0].pending.rows,0);assert.equal(totals.confidence.level,'High');
  f.run("UPDATE fin_transactions SET source_provider='simplefin' WHERE txn_uid='post'");
  const unknown=await f.ask('SELECT pending_rows,pending_out_minor FROM coverage');assert.equal(unknown.rows[0].pending_rows,1);assert.equal(unknown.evidence.accounts[0].pending.rows,1);assert.ok(unknown.confidence.percent<90);
});

test('B17 shared six-day lead window, stale holds and unknown collection are explicit',async t=>{
  const f=book(t);f.acct('a');f.tx('posted','a','2026-10-03',10000);f.tx('lead','a','2026-10-30',8000,'outflow','HOLD',{pending:true});
  f.tx('old','a','2026-03-03',4000,'outflow','OLD HOLD',{pending:true});
  const p={period_from:'2026-11-01',period_to:'2026-11-12'};
  const current=await f.ask('SELECT pending_rows,pending_out_minor FROM coverage',p);assert.equal(current.rows[0].pending_rows,1);/* 0.4.28 evidence is scoped to the requested period; the coverage view retains the lead-window count. */ assert.equal(current.evidence.accounts[0].pending.rows,0);assert.equal(current.evidence.accounts[0].pending.outflow_minor,0);
  const all=await f.ask('SELECT pending_rows,pending_stale_rows,pending_stale_out_minor FROM coverage',{});assert.equal(all.rows[0].pending_rows,1);assert.equal(all.rows[0].pending_stale_rows,1);assert.equal(all.rows[0].pending_stale_out_minor,4000);assert.match(all.confidence.reasons.join(' '),/stale/i);
  const overview=await overviewMoney(f.env,{now:()=>NOW});assert.equal(overview.accounts[0].pending_rows,1);
});

test('B17 SimpleFIN zero pending means not collected and unknown below High',async t=>{
  const f=book(t);f.acct('a',{provider:'simplefin'});f.tx('posted','a','2026-10-03',10000,'outflow','SUPPLIER PURCHASE',{source_provider:'plaid'});
  const r=await f.ask('SELECT pending_rows,pending_out_minor,pending_collection FROM coverage');assert.equal(r.rows[0].pending_rows,null);assert.equal(r.rows[0].pending_out_minor,null);assert.equal(r.rows[0].pending_collection,'not_collected');assert.equal(r.evidence.accounts[0].pending.outflow_minor,null);assert.equal(r.evidence.accounts[0].pending.amount_known,false);assert.ok(r.confidence.percent<90);assert.match(r.confidence.reasons.join(' '),/pending not collected.*amount unknown/i);assert.ok(r.confidence.missing.length);
  // 0.4.28 party proof lowers this payee-less spending control independently of pending collection.
  assert.equal((await f.ask()).confidence.percent,89,'unresolved party is below High');
});

test('B18 per-side bank cash flow retains cross-side transfers and excludes liability postings',async t=>{
  const f=book(t);f.acct('a');f.acct('personal',{mask:'2222',side:'personal'});f.acct('card',{mask:'3333',kind:'card'});f.acct('loan',{mask:'4444',kind:'loan'});
  f.tx('sale','a','2026-10-01',500000,'inflow','CUSTOMER PAYMENT',{payee:'Customer role'});f.tx('rent','a','2026-10-05',100000);
  f.tx('draw','a','2026-10-10',200000,'outflow','TRANSFER TO 2222',{category:'TRANSFER',category_basis_state:'confirmed',provenance:'feed'});f.tx('receive','personal','2026-10-10',200000,'inflow','TRANSFER FROM 1111',{category:'TRANSFER',category_basis_state:'confirmed',provenance:'feed'});
  f.tx('card-purchase','card','2026-10-15',80000);f.tx('loan-post','loan','2026-10-16',90000);
  const r=await f.ask(recipe('Cash flow'));const biz=r.rows.find(r=>r.side==='business'),home=r.rows.find(r=>r.side==='personal');assert.equal(biz.cash_in_minor,500000);assert.equal(biz.cash_out_minor,300000);assert.equal(home.cash_in_minor,200000);assert.equal(biz.net_cash_minor+home.net_cash_minor,400000);
  const rows=await f.ask(`SELECT cross_side_minor,expense_minor,income_minor FROM txn WHERE ${dates} AND money_kind='own_transfer'`);assert.equal(rows.rows.length,2);assert.ok(rows.rows.every(r=>r.cross_side_minor===200000 && r.expense_minor===0 && r.income_minor===0));
});

for(const confirmed of [false,true])test(`S1 guide income and payer totals net payout reversals (${confirmed?'confirmed':'likely'})`,async t=>{
  const f=book(t);f.acct('a');f.tx('payout','a','2026-10-05',500000,'inflow','STRIPE PAYOUT',{payee:'Stripe'});
  f.tx('reversal','a','2026-10-12',120000,'outflow','STRIPE PAYOUT REVERSAL',confirmed?{category:'PAYOUT_REVERSAL',category_basis_state:'confirmed'}:{});
  const income=await f.ask(recipe('Income'));assert.equal(income.rows[0].income_minor,380000);assert.equal(income.rows[0].reversal_minor,-120000);
  const payers=await f.ask(recipe('Payers'));assert.equal(payers.rows[0].payer_group,'processor:stripe');assert.equal(payers.rows[0].income_minor,380000);
  // Candidate 4 caps GROUP BY recipes outside its proved txn grammar; the
  // confirmed/likely distinction is checked on the proved income total.
  const total=await f.ask(`SELECT SUM(income_minor) AS n FROM txn WHERE ${dates}`);assert.equal(total.rows[0].n,380000);
  // 0.4.28 party certificates cap processor income even with a confirmed reversal.
  if(confirmed)assert.equal(total.confidence.level,'Low');else {assert.ok(total.confidence.percent<90);assert.ok(income.confidence.percent<90);}
});

test('S1 returned deposit follows the unique original payer; no guessed group for ambiguous originals',async t=>{
  const f=book(t);f.acct('a');f.tx('deposit','a','2026-10-05',30000,'inflow','CUSTOMER PAYMENT',{payee:'Customer role'});f.tx('return','a','2026-10-09',30000,'outflow','DEPOSITED ITEM RETURNED');
  const r=await f.ask(recipe('Payers'));assert.equal(r.rows[0].payer_group,'customer role');assert.equal(r.rows[0].income_minor,0);
  f.tx('ambiguous','a','2026-10-06',30000,'inflow','CUSTOMER PAYMENT',{payee:'Second role'});
  const other=await f.ask(recipe('Payers'));assert.ok(other.rows.some(r=>r.payer_group==='unattributed deposit reversal' && r.income_minor===-30000));
});

for(const description of ['IRS TREAS 310 TAX REF','STATE ROLE TAX REFUND','AMAZON MKTPL REFUND','SALES TAX REFUND SUPPLIER'])test(`S5 tax/merchant refund control: ${description}`,async t=>{
  const f=book(t);f.acct('a');f.tx('purchase','a','2026-10-05',100000);f.tx('refund','a','2026-10-08',14500,'inflow',description);
  const r=await f.ask(`SELECT SUM(expense_minor-refund_minor) AS minor FROM txn WHERE ${dates}`);assert.equal(r.rows[0].minor,/^(IRS|STATE)/.test(description)?100000:85500);
});

for(const confirmed of [false,true])test(`S5 business draws excluded from spending but retained in cash (${confirmed?'confirmed':'memo only'})`,async t=>{
  const f=book(t);f.acct('a');f.tx('purchase','a','2026-10-05',100000);f.tx('draw','a','2026-10-15',250000,'outflow',confirmed?'CHECK 1042':'OWNER DRAW',confirmed?{category:'Owner Draw',category_basis_state:'confirmed'}:{});
  const r=await f.ask();assert.equal(r.rows[0].minor,100000);assert.equal((await f.ask(recipe('Cash flow'))).rows[0].cash_out_minor,350000);
  // 0.4.28 party certificates leave the payee-less purchase below High.
  if(confirmed)assert.equal(r.confidence.level,'Medium');else assert.ok(r.confidence.percent<90);
});
