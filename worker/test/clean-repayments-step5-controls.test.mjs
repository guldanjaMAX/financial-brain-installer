import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/clean-money-fixture.mjs';
import { queryMoney, MONEY_GUIDE } from '../src/lib/money-query.js';
const W="posted_on BETWEEN '2026-10-01' AND '2026-10-31'", P={period_from:'2026-10-01',period_to:'2026-10-31'};
function setup(t){const f=fixture(t);for(const [slug,kind,mask] of [['bank','checking','1111'],['card','card','4444'],['other-card','card','5555']]){f.account(slug,{mode:'manual',kind,mask});f.coverage(slug,'2026-10-01','2026-10-31');}return f;}
const ask=(f,expr='SUM(paid_minor)',filter='')=>queryMoney(f.env,{...P,sql:`SELECT COALESCE(${expr},0) n FROM txn WHERE ${W} ${filter}`});

for(const declared of [true,false])test(`B6: named destination, liability credits and all-card control (${declared?'declared period':'SQL dates'})`,async t=>{
 const f=setup(t);
 for(const [uid,slug,cents,day,direction,memo] of [
  ['sent','bank',50000,'10','outflow','PAYMENT TO CARD 4444'],['received','card',50000,'11','inflow','PAYMENT THANK YOU'],
  ['other-sent','bank',80000,'15','outflow','PAYMENT TO CARD 5555'],['other-received','other-card',80000,'16','inflow','PAYMENT THANK YOU'],
 ])f.row(uid,slug,cents,{day:'2026-10-'+day,direction,memo});
 const read=(expr,filter='',extra={})=>queryMoney(f.env,{...(declared?P:{}),...extra,sql:`SELECT COALESCE(SUM(${expr}),0) n FROM txn WHERE ${W} ${filter}`});
 for(const [filter,extra] of [["AND paid_to_account='4444'",{}],["AND paid_to_account_slug='card'",{account_slugs:['bank','card']}]] ){
  const r=await read('paid_minor',filter,extra);assert.equal(r.rows[0].n,50000);
  // Candidate 4 fix step 1: a destination filter is outside the proved
  // literal-date AND-only grammar, so period arguments cannot prove it (89).
  // The figure is exact; only the confidence ceiling differs from step 5.
  assert.equal(r.confidence.percent,declared?89:85);
  assert.ok(r.confidence.reasons.length && r.confidence.missing.length);
 }
 const credited=await read('credited_minor','',{account_slugs:['card']});assert.equal(credited.rows[0].n,50000);assert.equal(credited.confidence.percent,89,'0.4.28: SQL dates alone do not certify party attribution');
 assert.equal((await read('paid_minor',"AND paid_to_account_slug='other-card'")).rows[0].n,80000);
 const all=await read('paid_minor');assert.equal(all.rows[0].n,130000);assert.equal(all.confidence.percent,89,'0.4.28: SQL dates alone do not certify party attribution');
 const legacy=await read('paid_minor',"AND account='4444'");assert.equal(legacy.rows[0].n,0);assert.ok(legacy.confidence.percent<90);
 const gap=legacy.confidence.gaps.find(g=>g.code==='repayment_paid_outside_scope');assert.equal(gap.amounts[0].inflow_minor,50000);assert.match(gap.why,/1111/);assert.match(gap.why,/4444/);
 assert.match(MONEY_GUIDE,/one-card question requires this destination filter/);assert.match(MONEY_GUIDE,/for credits on the liability account alone, use credited_minor/);
});
for(const gap of [4,5,6,7])test('settlement lag '+gap+' days counts once and names the uncertain dollars',async t=>{
 const f=setup(t);f.row('sent','bank',64000,{day:'2026-10-10',direction:'outflow',memo:'PAYMENT TO CARD 4444'});f.row('credited','card',64000,{day:'2026-10-'+(10+gap),memo:'PAYMENT THANK YOU'});
 const r=await ask(f);assert.equal(r.rows[0].n,64000);assert.ok(r.confidence.percent<90);const g=r.confidence.gaps.find(g=>g.code==='repayment_unproved');assert.equal(g.amounts[0].inflow_minor,64000);assert.equal(g.amounts[0].outflow_minor,64000);assert.match(g.why,/640\.00/);assert.match(g.why,/higher/);
});
test('risk A: a card-only selection retains the credit measure and explains a zero paying measure',async t=>{
 const f=setup(t);f.row('sent','bank',64000,{day:'2026-10-10',direction:'outflow',memo:'PAYMENT TO CARD 4444'});f.row('credited','card',64000,{day:'2026-10-15',memo:'PAYMENT THANK YOU'});
 for(const filter of ["AND account='4444'","AND account_slug='card'"]){const r=await ask(f,'SUM(paid_minor)',filter),c=await ask(f,'SUM(credited_minor)',filter);assert.equal(r.rows[0].n,0);assert.equal(c.rows[0].n,64000);assert.ok(r.confidence.percent<90);assert.ok(r.confidence.gaps.some(g=>g.code==='repayment_paid_outside_scope'));}
});
test('risk B: indistinguishable separate payments have a lower likely total with the full alternative disclosed',async t=>{
 const f=setup(t);f.row('sent','bank',64000,{day:'2026-10-10',direction:'outflow',memo:'PAYMENT TO CARD 4444'});f.row('separate-credit','card',64000,{day:'2026-10-15',memo:'PAYMENT THANK YOU'});
 const r=await ask(f);assert.equal(r.rows[0].n,64000);assert.ok(r.confidence.percent<90);assert.match(r.confidence.reasons.join(' '),/higher by \$640\.00/);assert.ok(r.confidence.missing.some(s=>/linking them/.test(s)));
});
test('risk C: liability funding is distinct from cash repayment',async t=>{
 const f=setup(t);f.row('debt','other-card',220000,{direction:'outflow',memo:'PAYMENT TO CARD 4444'});f.row('cash','bank',35000,{day:'2026-10-15',direction:'outflow',memo:'PAYMENT TO CARD 4444'});f.row('credit','card',35000,{day:'2026-10-16',memo:'PAYMENT THANK YOU'});
 assert.equal((await ask(f)).rows[0].n,35000);assert.equal((await ask(f,'SUM(debt_moved_minor)')).rows[0].n,220000);assert.equal((await ask(f,'SUM(expense_minor)')).rows[0].n,0);
});
test('a memo split on a liability cannot manufacture a cash repayment',async t=>{
 const f=setup(t);f.row('debt','other-card',125000,{direction:'outflow',memo:'LOAN PAYMENT PRINCIPAL 900.00 INTEREST 350.00'});
 assert.equal((await ask(f)).rows[0].n,0);
});
test('a generic debit is never consumed by a same-amount card credit',async t=>{
 const f=setup(t);f.row('sent','bank',64000,{day:'2026-10-10',direction:'outflow',memo:'CREDIT CARD AUTOPAY'});f.row('credit','card',64000,{day:'2026-10-15',memo:'PAYMENT THANK YOU'});
 assert.equal((await ask(f)).rows[0].n,64000);const r=await ask(f,'SUM(expense_minor)');assert.equal(r.rows[0].n,64000);assert.ok(r.confidence.percent<90);
 const g=r.confidence.gaps.find(g=>g.code==='estimated_membership');assert.ok(g.reasons.some(g=>g.note==='may be a card payment: $640.00'));
});
test('cross-currency credits do not deduplicate a located debit',async t=>{
 const f=setup(t);f.row('sent','bank',64000,{day:'2026-10-10',direction:'outflow',memo:'PAYMENT TO CARD 4444'});f.row('credit','card',64000,{day:'2026-10-15',memo:'PAYMENT THANK YOU',currency:'EUR'});
 const r=await queryMoney(f.env,{...P,sql:`SELECT currency,SUM(paid_minor) n FROM txn WHERE ${W} GROUP BY currency ORDER BY currency`});assert.deepEqual(r.rows.map(r=>[r.currency,r.n]),[['EUR',64000],['USD',64000]]);
});
test('long gaps retain both figures and disclose possible duplicate dollars',async t=>{
 const f=setup(t);f.row('sent','bank',64000,{day:'2026-10-10',direction:'outflow',memo:'PAYMENT TO CARD 4444'});f.row('credit','card',64000,{day:'2026-10-19',memo:'PAYMENT THANK YOU'});
 const r=await ask(f);assert.equal(r.rows[0].n,128000);assert.ok(r.confidence.percent<90);assert.match(r.confidence.reasons.join(' '),/lower by \$640\.00/);
});
// Candidate 4 fold of step 5 (audit A21c, B12): a generic bank payment debit
// whose equal card credit posts outside the three-day pair window was counted
// as plain spending at High. It stays counted (founder rule) but is flagged as
// a possible card payment with exact dollars and confidence below High.
for(const lag of [4,7,10])test('a generic payment debit with a lagged equal card credit is counted and flagged ('+lag+' days)',async t=>{
 const f=setup(t);
 f.row('epay','bank',300000,{day:'2026-10-15',direction:'outflow',memo:'ACH DEBIT WEB PMT 0098221'});
 f.row('thanks','card',300000,{day:'2026-10-'+(15+lag),memo:'PAYMENT THANK YOU'});
 f.row('supplies','card',280000,{day:'2026-10-12',direction:'outflow',memo:'OFFICE SUPPLIES'});
 const r=await ask(f,'SUM(expense_minor)');assert.equal(r.rows[0].n,580000,'unproved payment dollars stay in spending');
 assert.ok(r.confidence.percent<90,'a possible double count is never High');
 const g=r.confidence.gaps.find(g=>g.code==='estimated_membership');
 assert.ok(g.reasons.some(x=>x.treatment==='counted' && x.outflow_minor===300000 && x.note==='may be a card payment: $3,000.00'));
 const row=(await f.query("SELECT * FROM txn WHERE txn_uid='epay'"))[0];
 assert.equal(row.estimated,1);assert.equal(row.expense_minor,300000);assert.equal(row.uncertain_kind,'card_payment');assert.equal(row.uncertain_minor,300000);
 assert.equal((await ask(f)).rows[0].n,300000,'the card credit still counts the payment once');
});
test('controls: a lagged card credit does not flag a debit without payment wording, beyond ten days, or in another currency',async t=>{
 const f=setup(t);
 f.row('vendor','bank',300000,{day:'2026-10-05',direction:'outflow',memo:'OFFICE DEPOT 1234'});f.row('thanks','card',300000,{day:'2026-10-09',memo:'PAYMENT THANK YOU'});
 f.row('late','bank',120000,{day:'2026-10-02',direction:'outflow',memo:'ACH DEBIT WEB PMT 7712'});f.row('late-credit','card',120000,{day:'2026-10-13',memo:'PAYMENT THANK YOU'});
 f.row('eur','bank',90000,{day:'2026-10-20',direction:'outflow',memo:'ACH DEBIT WEB PMT 5531'});f.row('eur-credit','card',90000,{day:'2026-10-25',memo:'PAYMENT THANK YOU',currency:'EUR'});
 for(const uid of ['vendor','late','eur']){const row=(await f.query(`SELECT * FROM txn WHERE txn_uid='${uid}'`))[0];/* 0.4.28 party proof marks these expenses likely, without nominating a payment. */ assert.equal(row.estimated,uid==='vendor'?0:1,uid);assert.equal(row.money_kind,'ordinary',uid);assert.equal(row.expense_minor,row.amount_minor,uid);}
});
