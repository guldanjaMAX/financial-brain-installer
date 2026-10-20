import '../../test/fixtures/cli-side-effect-tripwire.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';

const evidence={};
async function reached(f,q){
 const n=f.calls.length,w=f.first('SELECT total_changes() n').n;
 const b=await f.ask(q);
 assert.ok(f.calls.slice(n).some(s=>/JOIN fin_transactions/.test(s)),'real transaction decision reached');
 assert.ok(f.first('SELECT COUNT(*) n FROM fin_transactions').n>0,'nonempty ledger');
 assert.equal(f.first('SELECT total_changes() n').n,w,'answer is read only');
 assert.ok(b.ledger,'real ledger renderer');return b;
}
function spend(t){
 const f=ledgerFixture(t,{knownPayers:false});
 f.add('short','Purchase','Supply',{direction:'outflow',cents:12300});
 f.add('long','Purchase','Again Supply',{direction:'outflow',cents:40000});
 f.raw("UPDATE fin_transactions SET category=CASE txn_uid WHEN 'short' THEN 'Office' ELSE 'Again Office' END,category_basis_state='confirmed'");
 return f;
}
test('R5-F1 green: exact plain merchant/category and external filler keep exact totals',async t=>{
 const f=spend(t);
 for(const s of ['at Supply','on Office'])for(const q of [`How much did I spend ${s} in October 2026?`,`Please how much did I spend ${s} in October 2026?`]){
  const b=await reached(f,q);// Category selectors intentionally match contained category text.
  assert.equal(b.ledger.total_minor,s.startsWith('on ')?52300:12300);assert.equal(b.evidence_gate.complete,true);
 }
});
test('R5-F1 repro: filler inside a literal merchant/category name must not select another row',async t=>{
 const f=spend(t),bad=[];
 const fillers=['Again','Please','Thanks','Exactly','Right Now','For Me','If You Can'];
 for(const baseAmount of [12300,0])for(const filler of fillers){
  f.raw("UPDATE fin_transactions SET amount_minor=? WHERE txn_uid='short'",baseAmount);
  const green=await reached(f,'How much did I spend at Supply in October 2026?');
  assert.equal(green.ledger.total_minor,baseAmount);assert.equal(green.evidence_gate.complete,true);
  f.raw("UPDATE fin_transactions SET payee=?,category=? WHERE txn_uid='long'",`${filler} Supply`,`${filler} Office`);
  for(const s of [`at ${filler} Supply`,`on ${filler} Office`])for(const q of [`How much did I spend ${s} in October 2026?`,`In October 2026, how much did I spend ${s}?`]){
   const b=await reached(f,q),i=classifyLedgerQuestion(q,{now:Date.parse(NOW)});
   if(b.evidence_gate.complete && b.ledger.total_minor!==40000)bad.push({q,selector:i.match,expected:40000,actual:b.ledger.total_minor,complete:b.evidence_gate.complete});
  }
 }
 evidence.f1=bad;
 assert.deepEqual(bad,[],'a literal name was erased and another merchant/category total was certified');
});
function payers(t){
 const f=ledgerFixture(t,{knownPayers:false});
 for(const [id,label,alias] of [['short','Payer Unit','Base Payer'],['long','Payer 400 Dollars Unit','Numbered Payer']])
  f.raw("INSERT INTO fin_entities(entity_slug,legal_name,display_label,kind,relationship,provenance,basis_state,recorded_at) VALUES (?,?,?,'business','owned','owner_stated','confirmed',?)",id,label,alias,NOW);
 f.add('receipt','FROM: Payer Unit','Payer Unit',{cents:40000});return f;
}
test('R5-F2 green: explicit external amount and registered alias preserve distinct payer identities',async t=>{
 const f=payers(t);
 for(const paid of ['Payer Unit','Payer 400 Dollars Unit']){
  f.raw('UPDATE fin_transactions SET payee=?,description=?',paid,`FROM: ${paid}`);
  for(const [requested,label] of [['Base Payer','Payer Unit'],['Numbered Payer','Payer 400 Dollars Unit']]){
   const b=await reached(f,`Did the $400 payment from ${requested} arrive in October 2026?`);
   assert.equal(b.ledger.found,paid===label);assert.equal(b.evidence_gate.complete,true);
  }
 }
});
test('R5-F2 repro: amount-like text inside an explicit FROM name must not resolve to another identity',async t=>{
 const f=payers(t),bad=[];
 for(const amount of ['$400','USD 400','400 dollar','400 dollars','$400.00','USD 400.00','400.00 dollars']){
  const long=`Payer ${amount} Unit`;
  f.raw("UPDATE fin_entities SET legal_name=? WHERE entity_slug='long'",long);
  for(const paid of ['Payer Unit',long]){
   f.raw('UPDATE fin_transactions SET payee=?,description=?',paid,`FROM: ${paid}`);
   const expected=paid===long;
   const control=await reached(f,'Did the $400 payment from Numbered Payer arrive in October 2026?');
   assert.equal(control.ledger.found,expected);assert.equal(control.evidence_gate.complete,true);
   const q=`Did the payment from ${long} arrive in October 2026?`,b=await reached(f,q);
   if(b.evidence_gate.complete && b.ledger.found!==expected)bad.push({q,paid,expected,found:b.ledger.found,complete:b.evidence_gate.complete,answer:b.answer});
  }
 }
 evidence.f2=bad;
 assert.deepEqual(bad,[],'global amount removal changed the independently registered FROM identity');
});
