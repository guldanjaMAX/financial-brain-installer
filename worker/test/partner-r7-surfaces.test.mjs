import test from 'node:test';
import assert from 'node:assert/strict';

import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { workerBody,remoteBody,localBodies,freezeClock } from './partner-r6-surface-helper.mjs';
import { assertExactSelection, assertPossibleMatch } from './partner-r7-assertions.mjs';
const evidence=[];
for(const id of ['R6-F1','R6-F2','R6-F3'])test(`${id} Worker and both MCP surfaces preserve exactness and possible-match authority`,async t=>{
 freezeClock(t);const f=ledgerFixture(t,{knownPayers:false});let q,controlQ;
 if(id==='R6-F1'){
  f.add('short','Purchase','May',{direction:'outflow',cents:0});f.add('full','Purchase','Again May',{direction:'outflow',cents:40000});
  controlQ='How much did I spend at May in October 2026?';q='How much did I spend at Again May in October 2026?';
 }else if(id==='R6-F2'){
  f.raw("INSERT INTO fin_entities(entity_slug,legal_name,display_label,kind,relationship,provenance,basis_state,recorded_at) VALUES ('short','Payer Unit','Plain Alias','business','owned','owner_stated','confirmed',?)",NOW);
  f.add('short','FROM: Payer Unit','Payer Unit',{cents:12300});f.add('full','FROM: Again Payer Unit','Again Payer Unit',{cents:40000});
  controlQ='Did the payment from Plain Alias arrive in October 2026?';q='Did the payment from Again Payer Unit arrive in October 2026?';
 }else{
  f.add('other','CARD PURCHASE AT Other Again Supply Outlet',null,{direction:'outflow',cents:40000});
  controlQ='How much did I spend at Other Again Supply Outlet in October 2026?';q='How much did I spend at Again Supply in October 2026?';
 }
 if(id==='R6-F3')f.raw("UPDATE fin_transactions SET payee='Other Again Supply Outlet'");
 const control=await workerBody(f,controlQ);
 if(id==='R6-F3')f.raw('UPDATE fin_transactions SET payee=NULL');
 const body=await workerBody(f,q);
 if(id==='R6-F2'){assert.equal(control.ledger.found,true);assert.match(control.answer,/^Found a deposit of \$123\.00 /);}
 else {assert.equal(control.evidence_gate.complete,true);assert.equal(control.ledger.total_minor,id==='R6-F1'?0:40000);}
 const remote=await remoteBody(q,body),local=localBodies(t,[{q:controlQ,body:control},{q,body}])[1];
 evidence.push({id,q,body,local_note:local.note,remote});t.diagnostic(JSON.stringify({id,complete:body.evidence_gate.complete,found:body.ledger.found}));
 if(id==='R6-F1')assertExactSelection(body,40000);
 else if(id==='R6-F2'){
  // Partner ruling 10 (round 7, R5-MONEY-4): "Payer Unit" is a trailing
  // whole-word run of "Again Payer Unit", a possible match that blocks
  // completeness: the exact receipt stays found and first, the shorter
  // payee's receipt is listed, and nothing is complete on any surface.
  assert.equal(body.evidence_gate.complete,false);assert.equal(body.ledger.found,true);
  assert.deepEqual(body.citations.map(c=>c.amount_minor),[40000,12300]);assert.equal(body.ledger.unattributed_count,1);
  assert.match(body.answer,/^Found a deposit of \$400\.00 /m);assert.doesNotMatch(body.answer,/^Found a deposit of \$123\.00 /m);
  assert.match(body.answer,/\nUnattributed deposit: \$123\.00 posted [^\n]*\[2\]\./);
  assert.match(local.note,/uncertainty/);
  assert.doesNotMatch(local.note,/Preserve the ledger answer's exact amounts/);
 }else {
  assertPossibleMatch(body,40000);
  assert.match(local.note,/uncertainty/);
  assert.doesNotMatch(local.note,/Preserve the ledger answer's exact amounts/);
 }
});
