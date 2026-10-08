import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCampaign,bankFixtures,scoreCampaign } from './campaign.mjs';
import { recordedControl } from './response-fixtures.mjs';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/golden-company.json',import.meta.url)));
test('campaign includes 144 base calls, 30 distinct perturbations and 30 adversarial prompts',()=>{
 const campaign=buildCampaign(fixture);
 assert.equal(campaign.base.length,144);assert.equal(campaign.perturbations.length,30);assert.equal(new Set(campaign.adversarial.map(c=>c.question)).size,30);
 assert.equal(campaign.units.length,24);assert.equal(campaign.periods.length,24);
 for(let i=0;i<30;i++)assert.equal(BigInt(campaign.perturbations[i].cases.find(c=>c.base_id==='G06').claims[0].minor),167500n-BigInt(i+1));
});
test('campaign coverage explicitly excludes unreviewed cash basis and native cash flow',()=>{
 const campaign=buildCampaign(fixture),cases=campaign.phases.flatMap(p=>p.cases),claims=cases.flatMap(c=>c.claims);
 assert.equal(cases.length,583);assert.equal(claims.length,785);
 assert.ok(claims.some(c=>c.metric==='profit'&&c.scope.basis==='accrual'),'supported accrual control');
 assert.deepEqual(campaign.coverage.supported_bases,['accrual']);
 assert.equal(campaign.coverage.truth_values,23);assert.equal(campaign.coverage.phases,34);
 assert.equal(campaign.coverage.cases,cases.length);assert.equal(campaign.coverage.claims,claims.length);
 assert.deepEqual(campaign.coverage.bank_cash_change,{truth_scope:'checking_and_savings',answer_claims:0});
 assert.deepEqual(campaign.coverage.unsupported.map(c=>[c.capability,c.reason]),[
  ['cash_basis','native_report_review_required'],['native_statement_of_cash_flows','native_report_review_required'],
 ]);
 assert.ok(campaign.coverage.unsupported.every(c=>c.detail.length>0));
 assert.equal(claims.filter(c=>c.scope.basis!=='accrual'||c.metric==='cash_change').length,0);
 const captures=Object.fromEntries(campaign.phases.map(p=>[p.id,recordedControl(p.cases)]));
 const score=scoreCampaign(campaign,captures);assert.equal(score.ready,true);assert.equal(score.release_ready,false);
 assert.deepEqual(score.coverage,campaign.coverage);
 delete captures['expense-30'];const partial=scoreCampaign(campaign,captures);
 assert.equal(partial.ready,false);assert.equal(partial.phases_checked,33);assert.deepEqual(partial.coverage,campaign.coverage);
});
test('complete campaign accepts independently recorded controls; omitting one perturbation fails',()=>{
 const campaign=buildCampaign(fixture);const captures=Object.fromEntries(campaign.phases.map(p=>[p.id,recordedControl(p.cases)]));
 const good=scoreCampaign(campaign,captures);assert.equal(good.ready,true);assert.equal(good.phases_checked,34);
 delete captures['expense-30'];const bad=scoreCampaign(campaign,captures);assert.equal(bad.ready,false);assert.equal(bad.missing_phases,1);
});
test('bank fixtures preserve provider signs and transfer net zero without implying live feed completeness',()=>{
 const rows=bankFixtures(fixture);const transfer=rows.filter(r=>r.seed_id==='S15');assert.equal(transfer.length,2);
 assert.equal(transfer.reduce((sum,r)=>sum+BigInt(r.movement_minor),0n),0n);
 const expense=rows.find(r=>r.seed_id==='S12');assert.equal(expense.plaid_decimal,'150.00');assert.equal(expense.simplefin_decimal,'-150.00');
 const card=rows.find(r=>r.seed_id==='S13');assert.equal(card.account_role,'liability');assert.equal(card.plaid_decimal,'500.00');
 assert.ok(rows.every(r=>r.synthetic_only&&r.coverage==='fixture_complete'));
});
