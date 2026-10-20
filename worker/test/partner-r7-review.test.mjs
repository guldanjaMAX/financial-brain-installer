import '../../test/fixtures/cli-side-effect-tripwire.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { classifyLedgerQuestion, payerQuestionGrammar } from '../src/lib/ledger-question.js';
import { matchesMerchant } from '../src/lib/ledger-analysis.js';
import { assertExactSelection, assertPossibleMatch } from './partner-r7-assertions.mjs';
const evidence={};
const save=()=>{};
const identity=(f,slug,name,alias=null)=>f.raw("INSERT INTO fin_entities(entity_slug,legal_name,display_label,kind,relationship,provenance,basis_state,recorded_at) VALUES (?,?,?,'business','owned','owner_stated','confirmed',?)",slug,name,alias,NOW);
async function reached(f,q){
 const n=f.calls.length,w=f.first('SELECT total_changes() n').n,d=f.documentCalls,b=await f.ask(q);
 assert.ok(f.calls.slice(n).some(s=>/JOIN fin_transactions/.test(s)),'transaction snapshot decision reached');
 assert.ok(f.first('SELECT COUNT(*) n FROM fin_transactions').n>0,'populated decision');
 assert.equal(f.first('SELECT total_changes() n').n,w,'read-only answer');assert.equal(f.documentCalls,d);assert.ok(b.ledger);return b;
}
const summary=b=>({found:b.ledger.found,total:b.ledger.total_minor,subtotal:b.ledger.attributed_subtotal_minor,complete:b.evidence_gate.complete,reason:b.evidence_gate.reason,answer:b.answer});
function spend(t){const f=ledgerFixture(t,{knownPayers:false});f.add('short','Purchase','Supply',{direction:'outflow',cents:12300});f.add('long','Purchase','Again Supply',{direction:'outflow',cents:40000});return f;}
test('R6-F1 green: exact RAW spans select only equal fields and plain merchant answers remain exact',async t=>{
 const f=spend(t),control=await reached(f,'How much did I spend at Supply in October 2026?');
 assert.equal(control.evidence_gate.complete,true);assert.equal(control.ledger.total_minor,12300);
 const b=await reached(f,'How much did I spend at Again Supply in October 2026?');
 assertExactSelection(b,40000);
});
test('R6-F1 repro: rejected RAW candidate must never return a complete shortened-selector total',async t=>{
 const f=spend(t),bad=[];let controls=0;
 for(const [full,short] of [['Again May','May'],['Again Today','Today'],['Again From','From'],['Again 2026-10-01','2026-10-01'],['(Again Supply)','(Supply)'],['Again Supply/','Supply/']])for(const cents of [12300,0]){
  f.raw("UPDATE fin_transactions SET payee=?,category=?,category_basis_state='confirmed',amount_minor=? WHERE txn_uid='short'",short,short,cents);
  f.raw("UPDATE fin_transactions SET payee=?,category=?,category_basis_state='confirmed' WHERE txn_uid='long'",full,full);
  const green=await reached(f,`How much did I spend at ${short} in October 2026?`);assert.equal(green.evidence_gate.complete,true);assert.equal(green.ledger.total_minor,cents);controls++;
  for(const mode of ['at','on']){
   const q=`How much did I spend ${mode} ${full} in October 2026?`,b=await reached(f,q),intent=classifyLedgerQuestion(q,{now:Date.parse(NOW)});
   assert.ok(intent.selectorReadings,'RAW selector survives the boundary');
   if(b.evidence_gate.complete && b.ledger.total_minor!==40000)bad.push({q,short_cents:cents,parsed:intent.match,...summary(b)});
  }
 }
 evidence.f1={arms:24,controls,bad};save();assert.deepEqual(bad,[],'unsupported RAW span fell back to a different complete selector');
});
function payers(t,full='Again Payer Unit'){
 const f=ledgerFixture(t,{knownPayers:false});f.add('short','FROM: Payer Unit','Payer Unit',{cents:12300});f.add('full',`FROM: ${full}`,full,{cents:40000});return f;
}
test('R6-F2 green: unregistered full fields retain their exact receipt and a plain registered alias identifies its own receipt',async t=>{
 const f=payers(t),q='Did the payment from Again Payer Unit arrive in October 2026?';
 const both=await reached(f,q);assertExactSelection(both,40000);
 identity(f,'short','Payer Unit','Plain Alias');
 const b=await reached(f,'Did the payment from Plain Alias arrive in October 2026?');
 assert.equal(b.ledger.found,true);assert.match(b.answer,/^Found a deposit of \$123\.00 /);assert.doesNotMatch(b.answer,/^Found a deposit of \$400\.00 /m);
});
test('R6-F2 repro: a shorter registered identity must not erase a competing literal bank field',async t=>{
 const bad=[];let controls=0;
 for(const filler of payerQuestionGrammar.filler){
  const full=`${filler} Payer Unit`,f=payers(t,full);
  const q=`Did the payment from ${full} arrive in October 2026?`;
  const green=await reached(f,q);assertExactSelection(green,40000);controls++;
  identity(f,'short','Payer Unit','Plain Alias');
  const row=f.first("SELECT payee FROM fin_transactions WHERE txn_uid='full'");assert.equal(row.payee,full,'literal covered bank field remains present');
  for(const question of [q,`How much income from ${full} in October 2026?`]){
   const b=await reached(f,question),intent=classifyLedgerQuestion(question,{now:Date.parse(NOW)});assert.equal(intent.selectorReadings.labels[0],full.toLowerCase());
   if(b.ledger.found===true && b.citations.some(c=>c.amount_minor!==40000))bad.push({q:question,literal_cents:40000,selected_cents:12300,...summary(b)});
  }
 }
 evidence.f2={arms:14,controls,bad};save();assert.deepEqual(bad,[],'registered substring changed RAW collision into presence for the shorter payer');
});
test('R6-F3 green: exact longer merchant answers; structured other merchant and absent selector refuse',async t=>{
 const f=ledgerFixture(t,{knownPayers:false});f.add('other','CARD PURCHASE AT Other Again Supply Outlet',null,{direction:'outflow',cents:40000});
 const b=await reached(f,'How much did I spend at Other Again Supply Outlet in October 2026?');assertPossibleMatch(b,40000);
 f.raw("UPDATE fin_transactions SET payee='Other Again Supply Outlet'");
 assertExactSelection(await reached(f,'How much did I spend at Other Again Supply Outlet in October 2026?'),40000);
 for(const name of ['Again Supply','Missing Store']){
  const refused=await reached(f,`How much did I spend at ${name} in October 2026?`);assert.equal(refused.evidence_gate.complete,false);assert.equal(refused.ledger.total_minor,null);
 }
});
test('R6-F3 repro: equal substring row sets cannot establish the requested literal merchant',async t=>{
 const bad=[];let controls=0;
 for(const cents of [40000,0]){
  const f=ledgerFixture(t,{knownPayers:false});f.add('other','CARD PURCHASE AT Other Again Supply Outlet','Other Again Supply Outlet',{direction:'outflow',cents});
  const q='How much did I spend at Again Supply in October 2026?',green=await reached(f,q);assert.equal(green.evidence_gate.complete,false);assert.equal(green.ledger.total_minor,null);controls++;
  f.raw('UPDATE fin_transactions SET payee=NULL');const row=f.first('SELECT * FROM fin_transactions'),intent=classifyLedgerQuestion(q,{now:Date.parse(NOW)});
  assert.deepEqual(intent.selectorReadings.labels,['again supply','supply']);
  assert.equal(matchesMerchant(row,intent.selectorReadings.raw.match),true,'RAW substring decision reached');
  assert.equal(matchesMerchant(row,intent.selectorReadings.cleaned.match),true,'CLEANED substring decision reached');
  const b=await reached(f,q);if(b.evidence_gate.complete)bad.push({q,other_cents:cents,raw_and_cleaned_same_row:true,...summary(b)});
 }
 evidence.f3={arms:2,controls,bad};save();assert.deepEqual(bad,[],'both readings agreed only on a substring inside another merchant');
});
