import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCases, evaluate, evaluatePerturbation } from './evaluator.mjs';
import { hash } from './reports.mjs';
import { recordedControl } from './response-fixtures.mjs';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/golden-company.json',import.meta.url)));
const control=()=>recordedControl(buildCases(fixture));
test('synthetic G12: ten useful exact answers and two reached correct refusals',()=>{
 const c=control();const r=evaluate(c);assert.equal(r.ready,true);assert.equal(r.supported_correct,10);assert.equal(r.correct_refusal,2);assert.equal(r.wrong_money,0);assert.equal(r.citations_checked,17);
});
test('FOR-01: library evaluator refuses every unsupported expected scope before any comparisons',()=>{
 const green=evaluate(control());assert.equal(green.ready,true);assert.equal(green.claims_checked,17);assert.equal(green.citations_checked,17);
 const wrong=control();wrong.responses[0].annotation.claims[0].minor='1';
 const red=evaluate(wrong);assert.equal(red.ready,false);assert.ok(red.wrong_money>0&&red.claims_checked>0);
 const locations=control().cases.flatMap((c,i)=>[[i,null],...c.claims.map((_,j)=>[i,j])]);
 // Every case (including expected refusals) and every claim must be inspected.
 for(const basis of ['cash','CashFlow','unknown','',null,undefined,'Cash',' accrual ',false,0,{}]){
  for(const [caseIndex,claimIndex] of locations){
   const input=control(),c=input.cases[caseIndex],target=claimIndex===null?c:c.claims[claimIndex];
   let basisReads=0,responseReads=0;
   target.scope={...target.scope};
   Object.defineProperty(target.scope,'basis',{get(){basisReads++;return basis;},enumerable:true});
   const responses=input.responses;
   Object.defineProperty(input,'responses',{get(){responseReads++;return responses;},enumerable:true});
   const result=evaluate(input);
   assert.ok(basisReads>0,'expected scope decision reached');
   assert.equal(result.ready,false);assert.equal(result.release_ready,false);
   assert.equal(result.code,'ORACLE_BASIS_UNSUPPORTED');assert.equal(result.reason,'unsupported_basis');assert.equal(result.stage,'evaluator');
   assert.equal(result.claims_checked,0);assert.equal(result.citations_checked,0);assert.equal(responseReads,0,'all scopes validated before response access');
  }
 }
 // The review reproduction supplies matching cash expectations and captures.
 const cases=buildCases(fixture);
 for(const c of cases){c.scope.basis='cash';for(const claim of c.claims)claim.scope.basis='cash';}
 const matched=recordedControl(cases);assert.equal(matched.cases.find(c=>c.base_id==='G05').claims[0].minor,'370000');
 const refused=evaluate(matched);assert.equal(refused.code,'ORACLE_BASIS_UNSUPPORTED');assert.equal(refused.claims_checked,0);
});
test('case builder refuses unsupported period or option basis instead of labeling it accrual',()=>{
 const good=buildCases(fixture);assert.equal(good.length,12);assert.equal(evaluate(recordedControl(good)).ready,true);
 assert.deepEqual(buildCases(fixture,{period:{...fixture.period,basis:'accrual'}}),good);
 assert.deepEqual(buildCases(fixture,{basis:'accrual'}),good);
 for(const basis of ['cash','unknown','',null,undefined]){
  for(const location of ['period','options']){
   let reads=0;
   const options=location==='period'?{basis:'accrual',period:{start:fixture.period.start,end:fixture.period.end}}:{period:{...fixture.period}};
   // Preserve the getter to prove that the requested decision was reached.
   Object.defineProperty(location==='period'?options.period:options,'basis',{get(){reads++;return basis;}});
   assert.throws(()=>buildCases(fixture,options),{code:'ORACLE_BASIS_UNSUPPORTED',reason:'unsupported_basis',stage:'basis'});
   assert.ok(reads>0,'basis request inspected before generating claims');
  }
 }
});
test('five required mutants fail independently after their comparison stages, with green base',()=>{
 const base=control();assert.equal(evaluate(base).ready,true);
 const arms=[['wrong-total',c=>c.responses[0].annotation.claims[0].minor='120001','wrong_money'],['wrong-sign',c=>c.responses[7].annotation.claims[0].minor='-30000','wrong_money'],['missing-item',c=>c.responses[0].annotation.claims.pop(),'missing_claim'],['stale-asof',c=>c.responses[2].annotation.claims[0].scope.end='2025-01-30','wrong_scope'],['uncited-number',c=>c.responses[2].annotation.claims[0].citations=[],'wrong_citation']];
 for(const [id,mutate,reason] of arms){const c=control();mutate(c);const r=evaluate(c);assert.equal(r.ready,false,id);assert.ok(r[reason]>0,id);assert.ok(r.claims_checked>0,id);}
});
test('wrong currency, basis, company, period, citation hash/path and stale source all hard fail',()=>{
 for(const change of [c=>c.responses[2].annotation.claims[0].scope.currency='EUR',c=>c.responses[2].annotation.claims[0].scope.basis='cash',c=>c.responses[2].annotation.claims[0].scope.entity='other',c=>c.responses[2].annotation.claims[0].scope.start='2024-01-01',c=>c.evidence[0].content_hash='0'.repeat(64),c=>c.evidence[0].current=false,c=>c.responses[0].annotation.claims[0].citations[0].row_path='/missing']){
 const c=control();change(c);assert.equal(evaluate(c).ready,false);
 }
});
test('all-refuse, all-pass, empty, duplicate, unknown cases and non-reached refusal gates cannot pass',()=>{
 assert.equal(evaluate(control()).ready,true);
 for(const change of [c=>c.responses=[],c=>c.responses.push(c.responses[0]),c=>c.responses[0].case_id='unknown',c=>c.responses.forEach(r=>r.annotation.status='refused'),c=>c.responses.forEach(r=>r.annotation.status='answered'),c=>c.responses[10].trace.candidates=0,c=>c.responses[11].trace.gates=[]]){
 const c=control();change(c);assert.equal(evaluate(c).ready,false);
 }
});
test('unbound prose money, percentages, words and modified response bytes cannot hide behind correct annotations',()=>{
 for(const extra of [' Also $1.00.', ' The margin is 5%.', ' Profit is five dollars.']){
 const c=control();c.responses[2].response.answer+=extra;assert.equal(evaluate(c).ready,false);
 }
});
test('metamorphic four phrasings times three repeats use identical scope and recomputed expectations',()=>{
 const cases=buildCases(fixture,{repeats:3,paraphrases:4});assert.equal(cases.length,144);
 assert.equal(evaluate(recordedControl(cases)).ready,true);
});
test('perturbation requires exact causal delta or reached refusal, stale unchanged answer fails',()=>{
 const base=control();const changed=control();
 assert.equal(evaluatePerturbation({before:'167500',after:'167377',delta:'-123',reached:true}).passed,true);
 assert.equal(evaluatePerturbation({before:'167500',after:'167500',delta:'-123',reached:true}).passed,false);
 assert.equal(evaluatePerturbation({before:'167500',refused:true,reached:false,delta:'-123'}).passed,false);
 assert.equal(evaluate(base).ready,true);assert.equal(evaluate(changed).ready,true);
});
test('all unit scales and period variants remain exact with controls',()=>{
 for(const unit of ['major','minor','thousand'])assert.equal(evaluate(recordedControl(buildCases(fixture,{unit}))).ready,true);
 for(const period of [{start:'2025-01-01',end:'2025-12-31'},{start:'2025-02-01',end:'2025-02-28'}])assert.equal(evaluate(recordedControl(buildCases(fixture,{period}))).ready,true);
});
test('rehashing an uncited extra amount still fails numeric coverage, independent of annotation hash',()=>{
 const c=control();const item=c.responses[2];item.response.answer+=' Extra $0.01.';
 const digest=hash(JSON.stringify(item.response));item.annotation.response_sha256=digest;item.trace.response_sha256=digest;
 const result=evaluate(c);assert.equal(result.ready,false);assert.equal(result.wrong_money,1);assert.equal(result.harness_error,0);
});
test('malformed claim amounts become scored failures rather than crashing the evaluator',()=>{
 const c=control();c.responses[0].annotation.claims[0].minor='unknown';const r=evaluate(c);assert.equal(r.ready,false);assert.equal(r.wrong_money,1);
});
test('malformed response records and claim objects emit harness errors, never a vacuous pass',()=>{
 assert.equal(evaluate(control()).ready,true);
 for(const change of [c=>c.responses[0]=null,c=>c.responses[0].annotation.claims=[null],c=>c.evidence[0]=null]){
 const c=control();change(c);assert.equal(evaluate(c).ready,false);assert.ok(evaluate(c).harness_error>0);
 }
});
