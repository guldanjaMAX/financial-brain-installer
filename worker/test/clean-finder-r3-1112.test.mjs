import test from 'node:test';
import assert from 'node:assert/strict';
import { queryMoney } from '../src/lib/money-query.js';
import { reports,r3Fixture,r3Expected,r3Query } from './helpers/clean-finder-r3-cases.mjs';
import { figureAdjudications,likelyExclusions,expectedScore,expectedAnswerScore } from './fixtures/clean-money-r3-oracles.mjs';

const cases=Object.entries(reports).flatMap(([kind,d])=>d.cases.filter(c=>c.verdict==='FAIL').map(c=>({kind,c})));
test('all 99 reported FAIL cases are executable, without deleting any report case',()=>{
 assert.equal(reports.cards.cases.length,70);assert.equal(reports.payouts.cases.length,67);assert.equal(reports.periods.cases.length,65);
 assert.deepEqual(['cards','payouts','periods'].map(k=>cases.filter(c=>c.kind===k).length),[40,31,28]);
});
for(const {kind,c} of cases)test(`R3 ${kind} ${c.id} ${c.question||c.q}`,async t=>{
 const f=r3Fixture(t,kind,c),r=await r3Query(f,kind,c,queryMoney),repeat=await r3Query(f,kind,c,queryMoney);
 assert.deepEqual(repeat.rows,r.rows);assert.deepEqual(repeat.confidence,r.confidence,'the same facts compute the same confidence');
 const postings=(await queryMoney(f.env,{sql:'SELECT * FROM txn'})).rows;
 assert.ok(postings.filter(p=>p.direction==='inflow' && ['card','loan','line_of_credit'].includes(p.account_kind)).every(p=>p.income_minor===0));
 const original=r3Expected(kind,c),policy=figureAdjudications[kind+':'+c.id],likely=likelyExclusions[kind+':'+c.id];
 let actual;
 if(kind==='periods'){
   if(c.id==='P31')actual={october_pending_out_minor:r.rows.reduce((n,row)=>n+row.pending_out_minor,0)};
   else if(c.id==='P53'){const row=r.rows.find(r=>r.account==='1111');actual={'1111':{first_row:row.first_row,last_row:row.last_row,row_count:row.row_count}};}
   else actual=Object.fromEntries(Object.keys(original).map(k=>[k,r.rows[0]?.[k]]));
 }else actual=r.rows.reduce((n,row)=>n+(kind==='cards'?row.n:row.cents),0);
 assert.deepEqual(actual,policy?policy.minor:likely?.minor ?? original,policy?.why||likely?.why);
 assert.ok(typeof actual==='number'?Number.isFinite(actual):Object.values(actual).every(v=>typeof v==='object'||Number.isFinite(v)),'every question has numeric figures, including zero');
 if(policy){
   assert.notDeepEqual(actual,original,'retain the original finder expectation and prove the policy disagreement');
   assert.ok(r.confidence.score<90,'unproved membership is never High');
   for(const uid of policy.rows){const row=postings.find(p=>p.txn_uid===uid);assert.equal(row.estimated,1,uid+' stays flagged');
     const gap=r.confidence.gaps.find(g=>g.code==='estimated_membership');assert.ok(gap.amounts.some(a=>a[row.direction+'_minor']>=row.amount_minor));
     if(row.direction==='outflow')assert.equal(row.expense_minor,row.amount_minor,'unproved outgoing dollars stay in spending');
   }
 }
 if(likely){
   // A likely exclusion is never certified: each row stays estimated, adds no
   // income or spending, and its exact left-out dollars are disclosed.
   if(likely.minor!==undefined)assert.notDeepEqual(actual,original,'prove the disagreement with the finder figure');
   assert.ok(r.confidence.score<90,'a likely exclusion is never High');
   const gap=r.confidence.gaps.find(g=>g.code==='estimated_membership');assert.ok(gap,'estimated membership is disclosed');
   for(const uid of likely.rows){const row=postings.find(p=>p.txn_uid===uid);assert.equal(row.estimated,1,uid+' stays flagged');
     assert.equal(row.income_minor,0,uid+' adds no income');assert.equal(row.expense_minor,0,uid+' adds no spending');
     assert.ok(gap.reasons.some(x=>x.treatment==='left_out' && x.reason===row.estimate_reason && BigInt(x[row.direction+'_minor'])>=BigInt(row.amount_minor)),uid+' left-out dollars are disclosed');}
 }
 if(kind==='cards' && ['C10','C11'].includes(c.id)){
   const reasons=r.confidence.gaps.find(g=>g.code==='estimated_membership').reasons;assert.ok(reasons.some(g=>g.treatment==='counted' && g.note===`may be a card payment: $${c.id==='C10'?'500.00':'600.00'}`));
 }
 if(kind==='cards' && ['C41','C42','C47','C48','C49','C50','C67'].includes(c.id)){
   const g=r.confidence.gaps.find(g=>g.code==='estimated_membership');assert.ok(g.amounts[0].outflow_minor>0);
   assert.match(g.missing,/counterpart statements/i);
 }
 if(kind==='cards' && c.id==='C53'){
   const g=r.confidence.gaps.find(g=>g.code==='loan_interest_unseparated');assert.ok(g.amounts[0].outflow_minor>0);assert.match(g.missing,/lender statement/i);
 }
 if(kind==='cards' && ['C41','C42','C43','C44','C45','C46','C47','C48','C49','C50','C56','C57','C67'].includes(c.id)){
   const debit=postings.find(p=>p.txn_uid==='r1'),g=r.confidence.gaps.find(g=>g.code==='estimated_membership');
   assert.equal(debit.expense_minor,debit.amount_minor);assert.equal(debit.estimated,1);
   assert.ok(g.amounts.some(a=>a.outflow_minor>=debit.amount_minor));assert.match(g.missing,/statements/);
   assert.ok(r.confidence.percent<90);
 }
 if(kind==='payouts' && ['P22','P23','P58'].includes(c.id))assert.ok(r.confidence.gaps.some(g=>g.code===(c.id==='P58'?'reserve_balance_unverified':'gross_sales_unverified')));
 if(kind==='periods'){
   if(['P05','P06','P10','P40','P56','P57'].includes(c.id))assert.ok(r.confidence.caveats.some(g=>g.code==='period_adjusted'));
   if(c.id==='P26'){const g=r.confidence.caveats.find(g=>g.code==='settled_after_period');assert.ok(g.rows.some(p=>p.amount_minor===2500 && p.pending_on==='2026-10-30' && p.posted_on==='2026-11-02'));}
   if(c.id==='P28'){assert.ok(r.confidence.caveats.some(g=>g.code==='pending_likely_posted'));assert.equal(r.confidence.gaps.find(g=>g.code==='pending').amounts.find(a=>a.account==='4444').outflow_minor,2500);}
   if(c.id==='P33')assert.equal(r.confidence.gaps.find(g=>g.code==='pending').unknown_amount_rows,1);
   if(c.exp.gap){const g=r.confidence.gaps.find(g=>g.code===c.exp.gap.code);assert.equal(g.amounts[0].outflow_minor,c.exp.gap.outflow_minor);assert.equal(g.rows[0].account,'1111');}
   if(c.id==='P36')assert.equal(r.confidence.caveats.find(g=>g.code==='unreadable_outside_period').amounts[0].outflow_minor,4500);
   if(c.id==='P39'){assert.equal(r.as_of.local_today,'2026-10-31');assert.equal(r.as_of.time_zone,'America/Los_Angeles');}
   if(c.id==='P45')assert.equal(r.confidence.caveats.find(g=>g.code==='posted_after_period').amounts[0].outflow_minor,7000);
 }
 // 0.4.28 rubric pins follow independent figure and no-wrong-at-High assertions.
 assert.equal(r.confidence.selection_score,expectedScore(kind,c),'exact selected-account/date quality');
 assert.equal(r.confidence.score,expectedAnswerScore(kind,c),'final score also requires the combined evidence contract');
 assert.equal(r.confidence.percent,r.confidence.score);
 assert.equal(r.confidence.label,r.confidence.score>=90?'High':r.confidence.score>=70?'Medium':'Low');
 assert.equal(r.confidence.display,`Confidence: ${r.confidence.label} (${r.confidence.score}%)`);
 if(r.confidence.score<100){assert.ok(r.confidence.gaps.length);assert.ok(r.confidence.gaps.every(g=>g.why && g.missing));}
 t.diagnostic(JSON.stringify({kind,id:c.id,original,actual,score:r.confidence.score,policy:policy?.why||null}));
});
