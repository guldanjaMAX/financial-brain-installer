import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/clean-money-fixture.mjs';
import { queryMoney } from '../src/lib/money-query.js';
import { MONEY_GUIDE, MONEY_CONFIDENCE_INSTRUCTIONS } from '../src/lib/money-query-contract.js';

const period={period_from:'2026-10-01',period_to:'2026-10-31'};
const now=()=>Date.parse('2026-11-14T18:00:00Z');
const where="posted_on BETWEEN '2026-10-01' AND '2026-10-31' AND expense_minor>0";
const headline=`SELECT payee AS vendor,currency,SUM(expense_minor) AS cents,COUNT(*) AS n FROM txn WHERE ${where} GROUP BY payee,currency`;
const detail=`SELECT txn_uid,posted_on,account_slug,currency,payee,amount_minor,expense_minor FROM txn WHERE ${where} ORDER BY posted_on`;
function book(t) {
  const f=fixture(t);f.env.BRAIN_TIMEZONE='UTC';
  f.account('operating',{mode:'manual'});f.coverage('operating',period.period_from,period.period_to);
  f.row('one','operating',50000,{direction:'outflow',payee:'Vendor one',category:'SOFTWARE'});
  f.row('two','operating',60000,{direction:'outflow',payee:'Vendor two',category:'SOFTWARE'});
  return f;
}
const query=(f,sql,extra={})=>queryMoney(f.env,{sql,...period,...extra},{now});
test('every shared guide confidence rule uses the headline certificate and checked support',()=>{
  for(const text of [MONEY_GUIDE,MONEY_CONFIDENCE_INSTRUCTIONS]) {
    assert.match(text,/supports/);assert.match(text,/consistent_with_certificate/);
    assert.doesNotMatch(text,/lowest (?:confidence|score) (?:of|among) the evidence/);
    assert.match(text,/Always answer|always answer/);
  }
});
async function control(f) {
  const r=await query(f,headline);
  assert.equal(r.rows.reduce((n,r)=>n+r.cents,0),110000);
  assert.ok(r.confidence.percent>=90,r.confidence_text);
  assert.ok(r.certificate?.id,'real aggregate path issued a headline certificate');
  return r;
}
function lowered(r,code) {
  assert.ok(r.rows.length,'the detail SQL returned rows before the support decision');
  assert.equal(r.support.consistent_with_certificate,false);
  assert.ok(r.support.checked,'the certificate comparison was reached');
  assert.ok(r.answer_confidence.percent<90);
  assert.ok(r.support.inconsistencies.some(g=>g.code===code),JSON.stringify(r.support));
  assert.ok(r.answer_confidence.reasons.length);assert.ok(r.answer_confidence.missing.length);
}
test('consistent supporting rows retain headline confidence without upgrading the detail query',async t=>{
  const f=book(t),h=await control(f),r=await query(f,detail,{supports:h.certificate});
  assert.equal(r.rows.length,2);assert.ok(r.confidence.percent<90);
  assert.equal(r.certificate,undefined,'a detail shape acquires no aggregate certificate');
  assert.equal(r.support.consistent_with_certificate,true);assert.equal(r.support.checked,true);
  assert.equal(r.answer_confidence.percent,h.confidence.percent);
  assert.equal(r.support.matched_rows,2);assert.equal(r.support.subset,false);
});
test('ORDER BY and LIMIT examples retain only the complete headline certificate',async t=>{
  const f=book(t),h=await control(f),r=await query(f,detail+' LIMIT 1',{supports:h.certificate});
  assert.equal(r.rows.length,1);assert.equal(r.support.consistent_with_certificate,true);
  assert.equal(r.support.subset,true);assert.equal(r.answer_confidence.percent,h.confidence.percent);
});
test('changed contributing rows invalidate the certificate even when the total is unchanged',async t=>{
  const f=book(t),h=await control(f);
  f.run("UPDATE fin_transactions SET amount_minor=amount_minor+100 WHERE txn_uid='one'");
  f.run("UPDATE fin_transactions SET amount_minor=amount_minor-100 WHERE txn_uid='two'");
  lowered(await query(f,detail,{supports:h.certificate}),'certificate_changed');
});
test('a changed total lowers confidence with the original certificate retained',async t=>{
  const f=book(t),h=await control(f);f.row('extra','operating',7000,{direction:'outflow',payee:'Vendor one'});
  lowered(await query(f,detail,{supports:h.certificate}),'certificate_changed');
});
test('counting rows outside the certified dates or accounts lowers confidence',async t=>{
  for(const arm of ['period','account']) {
    const f=book(t);f.account('reserve',{mode:'manual',mask:'2222'});f.coverage('reserve',period.period_from,period.period_to);
    const h=await query(f,headline,arm==='account'?{account_slugs:['operating']}:{});
    assert.ok(h.confidence.percent>=90);assert.ok(h.certificate);
    if(arm==='period')f.row('outside','operating',7000,{day:'2026-09-30',direction:'outflow',payee:'Vendor three'});
    else f.row('outside','reserve',7000,{direction:'outflow',payee:'Vendor three'});
    const r=await query(f,arm==='period'?detail.replaceAll('2026-10-01','2026-09-01'):detail,{supports:h.certificate});
    lowered(r,arm==='period'?'support_period_differs':'certificate_changed');
  }
});
test('different declared periods, account sets and measures cannot borrow a certificate',async t=>{
  const f=book(t),h=await control(f);
  for(const extra of [{period_from:'2026-09-01'},{account_slugs:['operating']},{measure:'gross_sales'}])
    lowered(await query(f,detail,{...extra,supports:h.certificate}),'support_context_differs');
});
test('different filters and duplicate row projections cannot borrow a certificate',async t=>{
  const f=book(t);await control(f);
  f.run("UPDATE fin_transactions SET category='FOOD' WHERE txn_uid='two'");
  const h=await query(f,headline.replace('expense_minor>0',"expense_minor>0 AND category='SOFTWARE'"));
  assert.ok(h.confidence.percent>=90);assert.ok(h.certificate);
  lowered(await query(f,detail,{supports:h.certificate}),'support_rows_outside_scope');
  lowered(await query(f,detail.replace('FROM txn','FROM txn CROSS JOIN (SELECT 1 UNION ALL SELECT 2)'),{supports:h.certificate}),'support_shape_unproved');
});
test('raw pending, removed and superseded rows never inherit a posted headline certificate',async t=>{
  const f=book(t);f.row('pending','operating',9000,{pending:1,payee:'Vendor three',direction:'outflow'});
  f.row('removed','operating',8000,{payee:'Vendor three',direction:'outflow'});
  f.row('superseded','operating',7000,{payee:'Vendor three',direction:'outflow'});
  f.run("UPDATE fin_transactions SET removed_at='2026-10-31T12:00:00Z',removal_reason='source_removed' WHERE txn_uid='removed'");
  f.run("UPDATE fin_transactions SET superseded_by_id=1 WHERE txn_uid='superseded'");
  const h=await control(f);
  for(const filter of ['pending=1','removed_at IS NOT NULL','superseded_by_id IS NOT NULL'])
    lowered(await query(f,'SELECT * FROM fin_transactions WHERE '+filter,{supports:h.certificate}),'support_shape_unproved');
});
test('pre-existing rows from another account and groups outside a top-N headline lower confidence',async t=>{
  const f=book(t);f.account('reserve',{mode:'manual',mask:'2222'});f.coverage('reserve',period.period_from,period.period_to);
  f.row('other','reserve',7000,{direction:'outflow',payee:'Vendor three'});
  const h=await query(f,headline.replace('expense_minor>0',"expense_minor>0 AND account_slug='operating'"));
  assert.ok(h.confidence.percent>=90);assert.ok(h.certificate);
  lowered(await query(f,detail,{supports:h.certificate}),'support_rows_outside_scope');
  const ranked=await query(f,headline+' ORDER BY SUM(expense_minor) DESC LIMIT 1');
  assert.ok(ranked.confidence.percent>=90);assert.equal(ranked.rows[0].cents,60000);
  lowered(await query(f,detail,{supports:ranked.certificate}),'support_rows_outside_scope');
});
test('a verified supporting subset never raises a below-High headline',async t=>{
  const f=book(t);f.run("UPDATE fin_account_coverage SET covered_from='2026-10-02'");
  const h=await query(f,headline);assert.ok(h.rows.length && h.certificate);assert.ok(h.confidence.percent<90);
  const r=await query(f,detail,{supports:h.certificate});assert.equal(r.support.consistent_with_certificate,true);
  assert.equal(r.answer_confidence.percent,h.confidence.percent);assert.ok(r.answer_confidence.percent<90);
});
test('forged, malformed, recursive and uncertified headline references keep readable rows below High',async t=>{
  const f=book(t),h=await control(f);
  for(const supports of [{...h.certificate,id:'0'.repeat(64)},'unrecognised',{},
    {...h.certificate,query:{...h.certificate.query,supports:h.certificate}},
    {...h.certificate,query:{...h.certificate.query,sql:detail}}]) {
    const r=await query(f,detail,{supports});lowered(r,'certificate_unverified');
  }
});
test('unproved arithmetic and attribution cannot acquire a certificate through supports',async t=>{
  const f=book(t),h=await control(f);
  for(const sql of [headline.replace('SUM(expense_minor)','SUM(expense_minor)*2'),detail.replace('expense_minor FROM','expense_minor*2 AS expense_minor FROM')]) {
    const r=await query(f,sql,{supports:h.certificate});lowered(r,'support_shape_unproved');
    assert.equal(r.certificate,undefined);
  }
});
test('a broader predicate cannot retain confidence even for zero-contribution context rows',async t=>{
  const f=book(t);f.row('income','operating',7000,{payee:'Customer',category:'CLIENT_INCOME'});
  const h=await control(f),r=await query(f,detail.replace(' AND expense_minor>0',''),{supports:h.certificate});
  assert.equal(r.rows.length,3);lowered(r,'support_selection_uncertified');
  assert.ok(r.support.inconsistencies.some(g=>g.code==='support_rows_outside_scope'));
});
test('case-preserving output labels and an unaliased posting month retain their exact lineage',async t=>{
  const f=book(t);
  const h=await query(f,headline.replace('payee AS vendor','payee AS "Vendor"').replace('SELECT ','SELECT substr(posted_on,1,7),').replace('GROUP BY ','GROUP BY substr(posted_on,1,7),'));
  assert.ok(h.confidence.percent>=90);assert.ok(h.certificate);
  const r=await query(f,detail.replace('SELECT txn_uid','SELECT txn_uid AS "RowKey"'),{supports:h.certificate});
  assert.equal(r.support.consistent_with_certificate,true);assert.equal(r.answer_confidence.percent,h.confidence.percent);
});

test('review probe: narrower and empty support selections never inherit the spending headline',async t=>{
  const f=book(t);
  f.run("UPDATE fin_transactions SET description='RENT OCT' WHERE txn_uid='one'");
  f.run("UPDATE fin_transactions SET description='LANDLORD' WHERE txn_uid='two'");
  const h=await query(f,`SELECT currency,SUM(expense_minor) AS cents FROM txn WHERE ${where} GROUP BY currency`);
  assert.equal(h.rows[0].cents,110000);assert.equal(h.confidence.percent,95);assert.ok(h.certificate);
  const rent=await query(f,`SELECT SUM(expense_minor) AS cents FROM txn WHERE ${where} AND description LIKE '%RENT%'`);
  assert.equal(rent.rows[0].cents,50000);assert.ok(rent.confidence.percent<90);
  const green=await query(f,detail,{supports:h.certificate});
  assert.equal(green.support.consistent_with_certificate,true);assert.equal(green.answer_confidence.percent,95);
  for(const filter of ["description LIKE '%RENT%'","payee='Vendor three'",'amount_minor>55000',
    "(payee='Vendor one' OR amount_minor=0)","payee='Vendor one'"]) {
    const r=await query(f,detail.replace(' ORDER BY posted_on',' AND '+filter+' ORDER BY posted_on'),{supports:h.certificate});
    assert.equal(r.rows.length,filter.includes('Vendor three')?0:1,'real SQL selection reached');
    assert.equal(r.support.checked,true);assert.equal(r.support.consistent_with_certificate,false);
    assert.ok(r.support.inconsistencies.some(g=>g.code==='support_selection_uncertified'));
    assert.equal(r.answer_confidence.percent,Math.min(h.confidence.percent,r.confidence.percent));
    assert.ok(r.answer_confidence.reasons.length && r.answer_confidence.missing.length);
    t.diagnostic(JSON.stringify({arm:filter.includes('Vendor three')?'empty':filter.includes('LIKE')?'description_like':filter.includes('OR')?'or':filter.includes('>')?'threshold':'party',
      rows:r.rows.length,headline:h.confidence.percent,support:r.confidence.percent,answer:r.answer_confidence.percent}));
  }
});

test('certified group equality is allowed only for a group the headline returned',async t=>{
  const f=book(t),h=await control(f);
  const r=await query(f,detail.replace(' ORDER BY posted_on'," AND payee='Vendor one' ORDER BY posted_on"),{supports:h.certificate});
  assert.equal(r.rows.length,1);assert.equal(r.support.consistent_with_certificate,true);
  assert.equal(r.answer_confidence.percent,h.confidence.percent);
  const empty=await query(f,detail.replace(' ORDER BY posted_on'," AND payee='Vendor three' ORDER BY posted_on"),{supports:h.certificate});
  assert.equal(empty.rows.length,0);assert.equal(empty.support.checked,true);
  assert.equal(empty.support.consistent_with_certificate,false);
  assert.ok(empty.support.inconsistencies.some(g=>g.code==='support_selection_uncertified'));
});

test('unchecked supporting evidence explicitly caps the answer at its own score in every guide',()=>{
  for(const text of [MONEY_GUIDE,MONEY_CONFIDENCE_INSTRUCTIONS])
    assert.match(text,/Unchecked supporting rows or totals used in the answer cap its confidence at their own score/);
});

test('optional replay timeout preserves rows and never sets the ordinary query cooldown',async t=>{
  const f=book(t),h=await control(f);
  t.mock.timers.enable({apis:['setTimeout']});
  let cooldownUntil=0,replayReached=0,cooldownWrites=0,reads=0;
  const cooldown={get:async()=>cooldownUntil,set:async value=>{cooldownWrites++;cooldownUntil=value;}};
  const execute=async(sql,{binds,signal})=>{
    reads++;
    if(sql.startsWith('EXPLAIN ') && sql.includes('\n'+headline+'\n')) {
      replayReached++;assert.ok(reads>1,'the detail read completed before replay');
      t.mock.timers.tick(10001);
      signal.throwIfAborted();
    }
    return {success:true,results:f.db.prepare(sql).all(...binds)};
  };
  const r=await queryMoney(f.env,{sql:detail,...period,supports:h.certificate},{now,execute,cooldown,supportTimeoutMs:25});
  assert.equal(replayReached,1);assert.equal(r.rows.length,2);
  t.diagnostic(JSON.stringify({replayReached,cooldownWrites,cooldownUntil}));
  assert.equal(cooldownWrites,0);assert.equal(cooldownUntil,0);
  assert.equal(r.support.checked,true);assert.equal(r.support.consistent_with_certificate,false);
  assert.ok(r.support.inconsistencies.some(g=>g.code==='support_replay_timeout'));
  assert.ok(r.answer_confidence.percent<90);assert.ok(r.answer_confidence.reasons.length && r.answer_confidence.missing.length);
  const next=await queryMoney(f.env,{sql:headline,...period},{now,cooldown});
  assert.equal(next.rows.reduce((n,r)=>n+r.cents,0),110000);assert.equal(next.confidence.percent,95);
});

test('support proof reports membership only, without claiming sum or count reconciliation',async t=>{
  const f=book(t),h=await control(f),r=await query(f,detail+' LIMIT 1',{supports:h.certificate});
  assert.equal(r.rows.length,1);assert.equal(r.support.consistent_with_certificate,true);
  assert.equal(r.support.matched_rows,1);assert.equal(r.support.proof_basis,'population_membership_only');
  assert.equal(r.support.reconciled_rows,undefined);assert.equal(r.support.subset,true);
});

test('source qualifiers and posting-month group equality preserve exact selection lineage',async t=>{
  const f=book(t);
  const h=await query(f,headline.replace('SELECT ','SELECT substr(posted_on,1,7) AS month,').replace('GROUP BY ','GROUP BY substr(posted_on,1,7),'));
  assert.equal(h.confidence.percent,95);assert.ok(h.certificate);
  const sql=detail.replace('FROM txn','FROM txn AS t').replace('WHERE posted_on','WHERE t.posted_on')
    .replace('AND expense_minor','AND t.expense_minor')
    .replace(' ORDER BY posted_on'," AND t.payee='Vendor one' AND substr(t.posted_on,1,7)='2026-10' ORDER BY posted_on LIMIT 1");
  const r=await query(f,sql,{supports:h.certificate});
  assert.equal(r.rows.length,1);assert.equal(r.support.consistent_with_certificate,true);
  assert.equal(r.answer_confidence.percent,h.confidence.percent);
});

test('string literal case is preserved on both sides of population comparison',async t=>{
  const f=book(t);
  f.run("UPDATE fin_transactions SET category='software' WHERE txn_uid='two'");
  const h=await query(f,headline.replace('expense_minor>0',"expense_minor>0 AND category='SOFTWARE'"));
  assert.ok(h.certificate);assert.equal(h.rows.length,1);assert.equal(h.rows[0].cents,50000);
  const green=await query(f,detail.replace('expense_minor>0',"expense_minor>0 AND category='SOFTWARE'"),{supports:h.certificate});
  assert.equal(green.support.consistent_with_certificate,true);
  const r=await query(f,detail.replace('expense_minor>0',"expense_minor>0 AND category='software'"),{supports:h.certificate});
  assert.equal(r.rows.length,1);assert.equal(r.rows[0].expense_minor,60000);
  lowered(r,'support_selection_uncertified');
});

test('the optional proof deadline also bounds membership reads after replay returns',async t=>{
  const f=book(t),h=await control(f);
  t.mock.timers.enable({apis:['setTimeout']});
  let proofReads=0,cooldownWrites=0;
  const cooldown={get:async()=>0,set:async()=>{cooldownWrites++;}};
  const execute=async(sql,{binds,signal})=>{
    if(/SELECT \* FROM txn WHERE id IN \(/.test(sql)) {
      proofReads++;t.mock.timers.tick(10001);signal.throwIfAborted();
    }
    return {success:true,results:f.db.prepare(sql).all(...binds)};
  };
  const r=await queryMoney(f.env,{sql:detail,...period,supports:h.certificate},{now,execute,cooldown,supportTimeoutMs:25});
  assert.equal(proofReads,1);assert.equal(r.rows.length,2);assert.equal(r.support.checked,true);
  assert.ok(r.support.inconsistencies.some(g=>g.code==='support_replay_timeout'));
  assert.equal(cooldownWrites,0);assert.ok(r.answer_confidence.percent<90);
  const next=await queryMoney(f.env,{sql:headline,...period},{now,cooldown});
  assert.equal(next.confidence.percent,95);assert.equal(next.rows.length,2);
});

test('completed detail work does not consume the optional proof budget',async t=>{
  const f=book(t),h=await control(f);
  t.mock.timers.enable({apis:['setTimeout']});
  let parentStarted=false,replayReached=0,cooldownWrites=0;
  const execute=async(sql,{binds,signal})=>{
    if(!parentStarted){parentStarted=true;t.mock.timers.tick(9990);}
    if(!replayReached && sql.startsWith('EXPLAIN ') && sql.includes('\n'+headline+'\n')) {
      replayReached++;t.mock.timers.tick(20);signal.throwIfAborted();
    }
    return {success:true,results:f.db.prepare(sql).all(...binds)};
  };
  const cooldown={get:async()=>0,set:async()=>{cooldownWrites++;}};
  const r=await queryMoney(f.env,{sql:detail,...period,supports:h.certificate},{now,execute,cooldown,supportTimeoutMs:25});
  assert.equal(replayReached,1);assert.equal(r.rows.length,2);assert.equal(cooldownWrites,0);
  assert.equal(r.support.consistent_with_certificate,true);assert.equal(r.answer_confidence.percent,95);
});
