import { assertExactSelection } from './partner-r7-assertions.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { workerBody,remoteBody,localBodies,freezeClock } from './partner-r6-surface-helper.mjs';
const results=[];
const addPayer=(f,slug,label)=>f.raw("INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at) VALUES (?,?,'business','owned','owner_stated','confirmed',?)",slug,label,NOW);
test('nonmatches stay incomplete across Worker, local MCP and remote MCP; exact controls survive',async t=>{
 freezeClock(t);const f=ledgerFixture(t,{knownPayers:false});
 f.add('expense','Purchase','Supplier Unit',{direction:'outflow',cents:40000});
 f.raw("UPDATE fin_transactions SET category='Office',category_basis_state='confirmed'");
 f.add('income','FROM: Payer Unit','Payer Unit',{cents:40000});
 const qs=[
  'How much did I spend at Missing Supplier in October 2026?',
  'How much did I spend on Missing Category in October 2026?',
  'How much income in category Missing Category in October 2026?',
  'How much income from Missing Payer in October 2026?',
  'Did the payment from Missing Payer arrive in October 2026?',
  'How much income from Payer Unit in October 2026?',
  'How much did I spend at Supplier Unit in October 2026?',
  'How much did I spend on Office in October 2026?',
 ];
 const entries=[];
 for(const [i,q] of qs.entries()){
  const body=await workerBody(f,q);entries.push({q,body});
  if(i<5){assert.equal(body.evidence_gate.complete,false);assert.notEqual(body.ledger.total_minor,0);}
  else {assert.equal(body.evidence_gate.complete,true);assert.equal(body.ledger.total_minor,40000);}
  const remote=await remoteBody(q,body);assert.doesNotMatch(remote,/total (?:spend|income)[^\n]*\$0\.00/i);
  results.push({case:i,surface:'Worker+remote',found:body.ledger.found,total:body.ledger.total_minor,complete:body.evidence_gate.complete});
 }
 const local=localBodies(t,entries);
 for(const [i,b] of local.entries()){
  assert.equal(b.note,i<5?'Preserve the ledger answer and its uncertainty and coverage gaps. A selector nonmatch does not establish a complete zero.':"Preserve the ledger answer's exact amounts, account masks, dates, and coverage bounds.");
  results.push({case:i,surface:'local',note:b.note,complete:b.evidence_gate.complete});
 }
 
});
test('R5-F1 surfaces repro: literal merchant is erased and complete zero survives both MCP adapters',async t=>{
 freezeClock(t);const f=ledgerFixture(t,{knownPayers:false});
 f.add('short','Purchase','Supply',{direction:'outflow',cents:0});f.add('long','Purchase','Again Supply',{direction:'outflow',cents:40000});
 const controlQ='How much did I spend at Supply in October 2026?',q='How much did I spend at Again Supply in October 2026?';
 const control=await workerBody(f,controlQ),body=await workerBody(f,q);
 assert.equal(control.ledger.total_minor,0);assert.equal(control.ledger.found,true);assert.equal(control.evidence_gate.complete,true);
 const remote=await remoteBody(q,body),local=localBodies(t,[{q:controlQ,body:control},{q,body}])[1];
 results.push({finding:'R5-F1',body,remote,localNote:local.note});
 
 // R7 selects the complete exact name; the shortened reading has no exact authority.
 assertExactSelection(body,40000);
 assert.match(local.note,/exact amounts/);assert.ok(remote.includes(body.answer));
});
test('R5-F2 surfaces repro: amount in FROM name produces certified absence through Worker and both MCP adapters',async t=>{
 freezeClock(t);const f=ledgerFixture(t,{knownPayers:false});addPayer(f,'short','Payer Unit');addPayer(f,'long','Payer 400 Dollars Unit');
 f.raw("UPDATE fin_entities SET display_label='Numbered Payer' WHERE entity_slug='long'");
 f.add('receipt','FROM: Payer 400 Dollars Unit','Payer 400 Dollars Unit',{cents:40000});
 const q='Did the payment from Payer 400 Dollars Unit arrive in October 2026?',controlQ='Did the $400 payment from Numbered Payer arrive in October 2026?';
 const control=await workerBody(f,controlQ),body=await workerBody(f,q);assert.equal(control.ledger.found,true);assert.equal(control.evidence_gate.complete,true);
 const remote=await remoteBody(q,body),local=localBodies(t,[{q:controlQ,body:control},{q,body}])[1];
 results.push({finding:'R5-F2',body,remote,localNote:local.note});
 
 // R7 selects the complete exact name; the shortened reading has no exact authority.
 assertExactSelection(body,40000);
 assert.match(local.note,/exact amounts/);assert.ok(remote.includes(body.answer));
});
