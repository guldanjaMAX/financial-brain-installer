import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/clean-money-fixture.mjs';
import { queryMoney } from '../src/lib/money-query.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const PERIOD = { period_from:'2026-10-01', period_to:'2026-10-31', time_zone:'UTC' };
const shapes = ['category only','unresolved payee','unresolved payee with exact descriptions','one exact locator','reciprocal control'];

for (const kind of ['loan','line_of_credit']) for (const shape of shapes)
  test(`loan exclusion confidence ${kind}: ${shape}`, async t => {
    t.mock.method(Date,'now',()=>NOW);
    const f=fixture(t), control=shape==='reciprocal control';
    f.account('operating',{mode:'manual'});
    f.account('borrowing',{mode:'manual',kind,mask:'5555'});
    for (const slug of ['operating','borrowing']) f.coverage(slug,PERIOD.period_from,PERIOD.period_to);
    const exact=control || shape.includes('exact descriptions') || shape==='one exact locator';
    const payee=shape.startsWith('unresolved')?'BORROWING DRAW DESTINATION RESERVE':shape==='category only'?'Lender':null;
    f.row('purchase','operating',280619,{direction:'outflow',payee:'Supplier',memo:'Stock purchase',category:'PURCHASE'});
    f.row('draw-out','borrowing',450000,{day:'2026-10-04',direction:'outflow',payee,
      memo:exact?'TRANSFER TO ACCOUNT 1111':'LOAN_PROCEEDS',category:'LOAN_PROCEEDS'});
    f.row('draw-in','operating',450000,{day:'2026-10-04',payee,
      memo:exact && shape!=='one exact locator'?'TRANSFER FROM ACCOUNT 5555':'LOAN_PROCEEDS',category:'LOAN_PROCEEDS'});
    const read=(sql,extra={})=>queryMoney(f.env,{sql,...PERIOD},{now:()=>NOW,...extra});
    const pairs=await read('SELECT * FROM transfer_pairs');
    assert.equal(pairs.row_count,1,'the borrowing pair decision was reached');
    const pair=pairs.rows[0];
    assert.equal(pair.out_matches,1); assert.equal(pair.in_matches,1);
    assert.equal(pair.unique_match,1); assert.equal(pair.proved,1,'membership is preserved even in capped arms');
    const detail=await read('SELECT txn_uid,money_kind,expense_minor,income_minor,estimated FROM txn ORDER BY id');
    assert.equal(detail.row_count,3,'all postings remain readable');
    assert.equal(detail.rows.find(r=>r.txn_uid==='purchase').expense_minor,280619);
    assert.equal(detail.rows.find(r=>r.txn_uid==='purchase').estimated,0);
    for (const r of detail.rows.filter(r=>r.txn_uid.startsWith('draw-'))) {
      assert.equal(r.money_kind,'loan_proceeds'); assert.equal(r.expense_minor,0);
      assert.equal(r.income_minor,0); assert.equal(r.estimated,0,'only confidence changes');
    }
    const sum=await read("SELECT SUM(expense_minor) AS cents FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31'");
    assert.ok(f.calls.some(sql=>sql.includes('SUM(expense_minor) AS cents')),'aggregate SQL ran');
    assert.equal(sum.rows[0].cents,280619);
    const income=await read("SELECT SUM(income_minor) AS cents FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31'");
    assert.equal(income.rows[0].cents,0,'other measures keep the same figure');
    // Internal overview callers must not be able to bypass the exclusion cap.
    const overview=await read('SELECT SUM(expense_minor) AS cents FROM txn',{
      confidenceScope:{from:PERIOD.period_from,to:PERIOD.period_to,filters:{},currenciesSeparated:true}});
    assert.equal(overview.rows[0].cents,280619);
    assert.equal(overview.confidence.percent,89,'an internal scope cannot certify SQL without literal date bounds');
    assert.match(overview.confidence_text,/query shape not certified/);
    assert.doesNotMatch(overview.confidence_text,/not connected for the needed period/);
    const raw=await read('SELECT SUM(amount_minor) AS cents FROM fin_transactions');
    assert.equal(raw.rows[0].cents,1180619,'raw SQL still reads both recorded borrowing legs');
    assert.doesNotMatch(raw.confidence_text,/excluded.*loan proceeds/i,'raw figures do not claim a clean exclusion');
    t.diagnostic(JSON.stringify({kind,shape,total_minor:sum.rows[0].cents,
      confidence:sum.confidence_text,income_confidence:income.confidence.percent,overview_confidence:overview.confidence.percent}));
    if (control) {
      assert.equal(sum.confidence.percent,95,'unique reciprocal owned-account proof retains High');
      assert.equal(income.confidence.percent,95);
    } else {
      assert.equal(sum.confidence.percent,89,'the cap is deterministic');
      assert.equal(income.confidence.percent,89);
      for (const answer of [sum,income,overview]) {
        assert.ok(answer.confidence.percent<90,'unproved exclusion cannot be High');
        assert.match(answer.confidence_text,/4,500\.00.*excluded.*loan proceeds/i);
        assert.match(answer.confidence.reasons.join(' '),/likely.*unique.*owned.*proof/i);
        assert.match(answer.confidence.missing.join(' '),/counterpart statements.*source.*destination/i);
      }
    }
    assert.equal(sum.confidence.may_only_lower,true);
  });
