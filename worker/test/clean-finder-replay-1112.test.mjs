import test from 'node:test';
import assert from 'node:assert/strict';
import { queryMoney } from '../src/lib/money-query.js';
import { finders,finderFixture,finderSql,expectedMinor,figure } from './helpers/clean-finder-cases.mjs';
import { founderAdjudications,likelyExclusions } from './fixtures/clean-money-founder-adjudications.mjs';

// Keep the independent bookkeeper figures intact. A separate reviewed rule
// file may explain founder-policy disagreements; it cannot erase a case.
for(const [kind,d] of Object.entries(finders))for(const c of d.cases)test(`${kind} ${c.id} ${c.theme||c.title}`,async t=>{
  const f=finderFixture(t,kind,c),sql=finderSql(kind,c,{canonical:true});
  const r=await queryMoney(f.env,{sql});
  const repeat=await queryMoney(f.env,{sql});assert.deepEqual(repeat.rows,r.rows);assert.deepEqual(repeat.confidence,r.confidence,'the same data sets the same score');
  const actual=figure(kind,c,r),expected=expectedMinor(kind,c);
  assert.ok(r.rows.length>0,'every finder question returns a numeric figure, including zero');
  assert.ok(r.rows.every(row=>typeof row.n==='number' && Number.isFinite(row.n)));
  const adjudication=founderAdjudications[`${kind}:${c.id}`];
  t.diagnostic(JSON.stringify({kind,id:c.id,actual,expected,confidence:r.confidence,adjudication:adjudication?.why||null}));
  assert.equal(typeof r.confidence.score,'number');assert.match(r.confidence.display,/^Confidence: (High|Medium|Low) \(\d+%\)$/);
  assert.ok(Number.isInteger(r.confidence.score) && r.confidence.score>=0 && r.confidence.score<=100);
  assert.equal(r.confidence.label,r.confidence.score>=90?'High':r.confidence.score>=70?'Medium':'Low');
  if(r.confidence.score<100){assert.ok(r.confidence.gaps.length);assert.ok(r.confidence.gaps.every(g=>g.why && g.missing));}
  const postings=(await queryMoney(f.env,{sql:'SELECT * FROM txn'})).rows;
  assert.ok(postings.filter(p=>p.direction==='inflow' && ['card','loan','line_of_credit'].includes(p.account_kind)).every(p=>p.income_minor===0),'liability credits never earn income');
  if(adjudication){
    assert.deepEqual(actual,adjudication.minor,adjudication.why);
    assert.notDeepEqual(actual,expected,'prove the disagreement with the original finder figure');
    assert.ok(r.confidence.score<90,'unproved membership cannot be High');
    if(adjudication.duplicate){const g=r.confidence.gaps.find(g=>g.code==='possible_duplicate');assert.ok(g?.amounts?.length);assert.ok(g.accounts.length>=2);}
    else for(const uid of adjudication.rows){const p=postings.find(p=>p.txn_uid===uid);assert.equal(p.estimated,1,uid+' remains flagged');
      assert.ok(r.confidence.gaps.some(g=>g.amounts?.length),'exact uncertain dollars are disclosed');}
  }else assert.deepEqual(actual,expected);
  const likely=likelyExclusions[`${kind}:${c.id}`];
  if(likely){
    assert.ok(r.confidence.score<90,'a likely exclusion is never High');
    const gap=r.confidence.gaps.find(g=>g.code==='estimated_membership');assert.ok(gap,'estimated membership is disclosed');
    for(const uid of likely.rows){const p=postings.find(p=>p.txn_uid===uid);assert.equal(p.estimated,1,uid+' remains flagged');
      assert.equal(p.income_minor,0,uid+' adds no income');assert.equal(p.expense_minor,0,uid+' adds no spending');
      assert.ok(gap.reasons.some(x=>x.treatment==='left_out' && x.reason===p.estimate_reason && BigInt(x[p.direction+'_minor'])>=BigInt(p.amount_minor)),uid+' left-out dollars are disclosed');}
  }
});
