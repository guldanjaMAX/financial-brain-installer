import test from 'node:test';
import assert from 'node:assert/strict';
import { reports,r3Fixture } from './helpers/clean-finder-r3-cases.mjs';
import { queryMoney } from '../src/lib/money-query.js';

// Preserve the historical finder JSON and strictly assert the reviewed founder
// figures also used by the canonical replay. Amount/date coincidence or a
// lender name never proves an exclusion.
const cases=[['C41',155000],['C44',160000],['C46',156000],['C47',300000],['C48',75000],['C49',100000],['C50',100000],['C56',125000],['C67',60000]];
for(const [id,expected] of cases)test(`founder ${id}: unproved repayment dollars remain spending and disclosed`,async t=>{
 const c=reports.cards.cases.find(c=>c.id===id),f=r3Fixture(t,'cards',c);
 const r=await queryMoney(f.env,f.request),rows=(await queryMoney(f.env,{sql:'SELECT * FROM txn'})).rows;
 assert.equal(r.rows[0].n,expected);assert.notEqual(r.rows[0].n,c.expected.figure_minor,'retain the independent finder disagreement');
 const debit=rows.find(r=>r.txn_uid==='r1');assert.equal(debit.expense_minor,debit.amount_minor);assert.equal(debit.estimated,1);
 assert.ok(r.confidence.percent<90);const g=r.confidence.gaps.find(g=>g.code==='estimated_membership');assert.ok(g);assert.ok(g.amounts.some(a=>a.outflow_minor>=debit.amount_minor));assert.ok(g.why && g.missing);
});

test('C55: the guide recipe does not add memo interest twice to a counted debit',async t=>{
 const c=reports.cards.cases.find(c=>c.id==='C55'),f=r3Fixture(t,'cards',c),r=await queryMoney(f.env,f.request);
 assert.equal(r.rows[0].n,135000);assert.equal(r.rows[0].n,c.expected.figure_minor);assert.ok(r.confidence.percent<90);
});

test('C65: a feed payment code without a destination stays spending with exact card-payment dollars',async t=>{
 const c=reports.cards.cases.find(c=>c.id==='C65'),f=r3Fixture(t,'cards',c),r=await queryMoney(f.env,f.request);
 assert.equal(r.rows[0].n,61000);assert.notEqual(r.rows[0].n,c.expected.figure_minor);assert.ok(r.confidence.percent<90);
 const g=r.confidence.gaps.find(g=>g.code==='estimated_membership');assert.ok(g.reasons.some(g=>g.note==='may be a card payment: $520.00'));
});
