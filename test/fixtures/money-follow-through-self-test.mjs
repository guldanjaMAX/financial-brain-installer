import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from '../../worker/test/ledger-review-fixture.mjs';
import { queryMoney } from '../../worker/src/lib/money-query.js';
import { withLedgerAnswer } from '../../worker/src/lib/ledger-answer.js';
import { fixtureMoneyMeasures } from './money-measure-oracle.mjs';
import { sameLedgerFigure } from './remote-money-follow-through.mjs';

for (const kind of ['expense_summary','merchant','largest','category']) test(`clean ${kind} fault is caught beside its populated control`, async t => {
  t.mock.method(globalThis,'fetch',()=>assert.fail('network forbidden'));
  const f=ledgerFixture(t);
  f.add('purchase','Purchase Unit','Store Unit',{cents:12000,direction:'outflow'});
  f.raw("UPDATE fin_transactions SET category='materials',category_basis_state='confirmed'");
  f.add('irrelevant','Purchase Unit','Other Unit',{cents:55000,direction:'outflow'});
  f.raw("UPDATE fin_transactions SET category='travel',category_basis_state='confirmed' WHERE txn_uid='irrelevant'");
  const request={question:kind==='largest'?'Largest expense at Store Unit in October 2026?':'Store Unit spending in October 2026?',
    intents:[{kind,match:kind==='category'?'materials':'Store Unit',direction:'outflow',limit:1,from:'2026-10-01',to:'2026-10-12'}]};
  if(kind==='expense_summary') { request.question='Spending in October 2026?'; delete request.intents[0].match; }
  assert.deepEqual(fixtureMoneyMeasures(f,request)[0].expected, kind==='largest'?[{total:12000}]:[{gross_minor:kind==='expense_summary'?67000:12000}], 'authored figure independently pins the selected operand set');
  await sameLedgerFigure(f,request);
  const prepare=f.env.DB.prepare;
  let hits=0;
  f.env.DB.prepare=sql=>{
    const original="CASE WHEN direction='outflow' AND movement_kind='ordinary' THEN amount_minor ELSE 0 END AS expense_minor";
    if(sql.includes(original)){hits++;sql=sql.replaceAll(original,'0 AS expense_minor');}
    return prepare(sql);
  };
  assert.equal((await queryMoney(f.env,{sql:'SELECT SUM(expense_minor) total FROM txn'})).rows[0].total,0);
  assert.ok(hits>0,'clean expense decision was actually mutated');
  await assert.rejects(()=>sameLedgerFigure(f,request),assert.AssertionError);
});

test('net refund contributions are checked independently',async t=>{
  t.mock.method(globalThis,'fetch',()=>assert.fail('network forbidden'));
  const f=ledgerFixture(t);
  f.add('purchase','Purchase Unit','Store Unit',{cents:12000,direction:'outflow'});
  f.add('refund','Refund posted','Store Unit',{cents:2000,direction:'inflow'});
  const request={question:'Store Unit spending after refunds in October 2026?',intents:[{kind:'merchant',match:'Store Unit',from:'2026-10-01',to:'2026-10-12'}]};
  assert.deepEqual(fixtureMoneyMeasures(f,request)[0].expected,[{gross_minor:12000,refund_minor:2000,total:10000}]);
  await sameLedgerFigure(f,request);
  const prepare=f.env.DB.prepare;let hits=0;
  f.env.DB.prepare=sql=>{if(sql.includes('SUM(refund_minor)')){hits++;sql=sql.replaceAll('SUM(refund_minor)','SUM(0)').replaceAll('expense_minor-refund_minor','expense_minor');}return prepare(sql);};
  await assert.rejects(()=>sameLedgerFigure(f,request),assert.AssertionError);
  assert.ok(hits>0,'refund contribution fault reached the semantic query');
});

test('legitimate card rule difference pins the tools figure, note and confidence cap',async t=>{
  t.mock.method(globalThis,'fetch',()=>assert.fail('network forbidden'));
  const f=ledgerFixture(t);
  f.add('purchase','Purchase Unit','Store Unit',{cents:10000,direction:'outflow'});
  f.add('card','Card payment','Card payment',{cents:2500,direction:'outflow'});
  const response=await withLedgerAnswer({env:f.env,question:'How much did I spend in October 2026?',now:Date.parse(NOW),grantScope:{all:true},scopePrincipalKind:'owner'},()=>assert.fail('document fallback forbidden'));
  const human=await response.json();assert.equal(human.ledger.total_minor,10000);
  const measure={sql:'SELECT COALESCE(SUM(expense_minor),0) gross_minor FROM txn WHERE posted_on BETWEEN \'2026-10-01\' AND \'2026-10-12\'',expected:[{gross_minor:12500}],cardRuleDifference:{humanMinor:10000,cap:89}};
  await sameLedgerFigure(f,{question:'How much did I spend in October 2026?',measures:[measure]});
  await assert.rejects(()=>sameLedgerFigure(f,{measures:[{...measure,expected:[{gross_minor:10000}]}]}),assert.AssertionError);
  await assert.rejects(()=>sameLedgerFigure(f,{measures:[{...measure,cardRuleDifference:{humanMinor:10000,cap:0}}]}),assert.AssertionError);
});
