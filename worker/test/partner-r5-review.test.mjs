import { assertPossibleMatch } from './partner-r7-assertions.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { maskLedgerCandidateField } from '../src/lib/ledger-answer.js';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';
import { acceptanceFixture } from './gaps-acceptance-fixture.mjs';

async function reached(f, question) {
  const start=f.calls.length, writes=f.first('SELECT total_changes() n').n;
  const body=await f.ask(question);
  assert.ok(f.calls.slice(start).some(sql=>/JOIN fin_transactions/.test(sql)), 'actual ledger decision reached');
  assert.ok(f.first('SELECT COUNT(*) n FROM fin_transactions').n>0, 'nonempty ledger');
  assert.equal(f.first('SELECT total_changes() n').n,writes,'read only');
  assert.ok(body.ledger,'real answer renderer');
  return body;
}
function spending(t) {
  const f=ledgerFixture(t,{knownPayers:false});
  f.add('expense','Purchase','Supplier Unit',{direction:'outflow',cents:40000});
  return f;
}
test('F1 green: exact merchant and supported filler report the existing expense; unknown post-period tail refuses',async t=>{
  const f=spending(t);
  for(const q of ['How much did I spend at Supplier Unit in October 2026?',
    'In October 2026, how much did I spend at Supplier Unit thanks?']){
    const b=await reached(f,q);
    if(q.endsWith('thanks?')) assertPossibleMatch(b,40000);
    else {assert.equal(b.ledger.total_minor,40000);assert.equal(b.evidence_gate.complete,true);}
  }
  const q='How much did I spend at Supplier Unit in October 2026 altogether?';
  assert.equal(classifyLedgerQuestion(q,{now:Date.parse(NOW)}).kind,null,'unsupported tail decision reached');
  const before=f.documentCalls;assert.equal((await f.ask(q)).route,'documents');assert.equal(f.documentCalls,before+1);
});
test('F1 repro: moving the unsupported modifier before the period cannot certify zero',async t=>{
  const f=spending(t);assert.equal((await reached(f,'How much did I spend at Supplier Unit in October 2026?')).ledger.total_minor,40000);
  const violations=[];
  for(const tail of ['altogether','total'])for(const q of [
    `In October 2026, how much did I spend at Supplier Unit ${tail}?`,
    `How much did I spend at Supplier Unit ${tail} in October 2026?`,
  ]){
    const b=await reached(f,q);
    if(b.ledger.total_minor===0&&b.evidence_gate.complete===true)violations.push({q,match:classifyLedgerQuestion(q,{now:Date.parse(NOW)}).match,found:b.ledger.found});
  }
  assert.deepEqual(violations,[],'an unconsumed modifier became a merchant and certified false absence');
});

async function documents(t){
  const f=await acceptanceFixture(t,{now:Date.parse('2034-07-15T12:00:00Z'),
    draft:'The schedule record discusses the deposit schedule [1].',
    verdict:{supported:true,complete:true,evidence:[1],conflicts:[],reason:'Synthetic approval.'}});
  await f.ingest([{source_type:'gmail',source_id:'record',title:'Schedule record',content:'The schedule record discusses the deposit schedule.',
    occurred_at:'2034-06-15',date_reliable:true,date_source:'email_header',text_source:'native',text_reliable:true,
    metadata:{evidence_lineage:{version:1,kind:'source_record'}}}]);
  await f.drain();return f;
}
const question='What did the schedule record discuss?';
test('F2 green: healthy retrieval is complete and a vector query failure is incomplete',async t=>{
  const f=await documents(t);const good=await f.request('think',question);
  assert.equal(good.body.degraded??null,null);assert.equal(good.body.evidence_gate.complete,true);assert.ok(good.counts.verifier>0);
  f.control.vectorFails=true;const bad=await f.request('think',question);
  assert.ok(bad.counts.vector>0,'failing vector decision reached');assert.equal(bad.body.degraded,'vector');assert.equal(bad.body.evidence_gate.complete,false);
});
test('F2 repro: embedding failure must demote complete just like failed vector retrieval',async t=>{
  const f=await documents(t);const good=await f.request('think',question);
  assert.equal(good.body.evidence_gate.complete,true);assert.equal(good.body.degraded??null,null);
  let hits=0;const run=f.env.AI.run;
  f.env.AI.run=async (model,input)=>{if(model.includes('bge-')){hits++;throw Error('synthetic embedding failure');}return run(model,input);};
  const bad=await f.request('think',question);
  assert.ok(hits>0,'embedding failure decision reached');assert.ok(bad.counts.keyword>0,'surviving keyword retrieval reached');
  assert.ok(bad.counts.verifier>0,'real gate decision reached');assert.ok(bad.body.results.length>0);
  assert.equal(bad.body.degraded,'no-embedding');assert.equal(bad.body.degraded_reason,'embedding-unavailable');
  assert.equal(bad.body.evidence_gate.supported,true);assert.equal(bad.body.answer,good.body.answer);
  f.env.AI.run=run;const recovered=await f.request('think',question);
  assert.equal(recovered.body.degraded??null,null);assert.equal(recovered.body.evidence_gate.complete,true);
  assert.equal(bad.body.evidence_gate.complete,false,'failed embedding retrieval cannot certify a complete answer');
});

function payerWorld(t){
  const f=ledgerFixture(t,{knownPayers:false});
  for(const [slug,label] of [['one','Payer One'],['two','Payer One S']])f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
    VALUES (?,?,'business','owned','owner_stated','confirmed',?)`,slug,label,NOW);
  f.add('receipt','FROM: Payer One S','Payer One S',{cents:40000});return f;
}
test('F3 green: ordinary possessive and explicit amount FROM target the intended registered payer',async t=>{
  const f=payerWorld(t);
  for(const q of ["Did Payer One's payment arrive in October 2026?",'Did the $400 payment from Payer One arrive in October 2026?']){
    const b=await reached(f,q);assert.equal(b.ledger.found,false);assert.equal(b.evidence_gate.complete,true);
  }
  assert.equal((await reached(f,'Did the payment from Payer One S arrive in October 2026?')).ledger.found,true,'other payer receipt exists');
  f.raw("UPDATE fin_transactions SET payee='Payer One',description='FROM: Payer One'");
  assert.equal((await reached(f,"Did Payer One's payment arrive in October 2026?")).ledger.found,true,'intended payer positive control');
});
test('F3 repro: amount between possessive and payment cannot change payer identity',async t=>{
  const f=payerWorld(t);assert.equal((await reached(f,"Did Payer One's payment arrive in October 2026?")).ledger.found,false);
  const violations=[];
  for(const intendedPayerPaid of [false,true]) {
    const label=intendedPayerPaid?'Payer One':'Payer One S';
    f.raw('UPDATE fin_transactions SET payee=?,description=?',label,`FROM: ${label}`);
    assert.equal((await reached(f,"Did Payer One's payment arrive in October 2026?")).ledger.found,intendedPayerPaid,'plain possessive retains intended identity');
    for(const apostrophe of ["'",'’'])for(const amount of ['$400','400 dollar','400 dollars','USD 400']){
      const q=`Did Payer One${apostrophe}s ${amount} payment arrive in October 2026?`;
      const b=await reached(f,q);if(b.ledger.found===!intendedPayerPaid)violations.push({q,intendedPayerPaid,found:b.ledger.found,complete:b.evidence_gate.complete});
    }
  }
  assert.deepEqual(violations,[],'possessive S resolved to the different registered payer');
});

const placements = [
  (w, s) => `${w} How much did I spend ${s} in October 2026?`,
  (w, s) => `How much did I spend ${s.replace(' ', ` ${w} `)} in October 2026?`,
  (w, s) => `How much did I spend ${s} ${w} in October 2026?`,
  (w, s) => `How much did I spend ${s} in ${w} October 2026?`,
  (w, s) => `How much did I spend ${s} in October 2026 ${w}?`,
  (w, s) => `${w} In October 2026, how much did I spend ${s}?`,
  (w, s) => `In ${w} October 2026, how much did I spend ${s}?`,
  (w, s) => `In October 2026, ${w} how much did I spend ${s}?`,
  (w, s) => `In October 2026, how much did I spend ${s.replace(' ', ` ${w} `)}?`,
  (w, s) => `In October 2026, how much did I spend ${s} ${w}?`,
];
const fillers = ['please', 'thanks', 'for me', 'if you can', 'right now', 'exactly', 'again'];
function random(seed) {
  let state = seed >>> 0;
  return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
}
for (const seed of [7, 41, 1701, 20261019]) test(`F1 seeded selector grammar ${seed}: filler, modifiers and unknown tokens at every clause position`, async t => {
  const rng = random(seed), f = spending(t);
  f.raw("UPDATE fin_transactions SET category='Office',category_basis_state='confirmed'");
  const tokens = [...fillers.map(word => ({ word, filler: true })),
    ...['altogether', 'total', 'approximately'].map(word => ({ word, filler: false })),
    ...Array.from({ length: 3 }, () => ({ word: `unknown${rng().toString(36)}`, filler: false }))];
  // Seeded ordering exercises every class/position without relying on wall time.
  for (let i = tokens.length - 1; i > 0; i--) { const j = rng() % (i + 1); [tokens[i], tokens[j]] = [tokens[j], tokens[i]]; }
  let reachedRows = 0, refused = 0, exact = 0, possible = 0;
  for (const selector of ['at Supplier Unit', 'on Office']) {
    const control = await reached(f, `How much did I spend ${selector} in October 2026?`);
    assert.equal(control.ledger.total_minor, 40000); assert.equal(control.evidence_gate.complete, true);
    for (const token of tokens) for (const [position, place] of placements.entries()) {
      const q = place(token.word, selector), intent = classifyLedgerQuestion(q, { now: Date.parse(NOW) });
      const documentsBefore = f.documentCalls;
      if (!intent.kind) {
        assert.equal((await f.ask(q)).route, 'documents'); assert.equal(f.documentCalls, documentsBefore + 1);
        assert.equal(token.filler, false, `recognized filler must be consumed: ${q}`); refused++; continue;
      }
      const body = await reached(f, q); reachedRows++;
      assert.ok(!(body.ledger.total_minor === 0 && body.evidence_gate.complete), q);
      if (token.filler && selector.startsWith('at ') && [1,2,8,9].includes(position)) {
        assertPossibleMatch(body, 40000); possible++;
      } else if (token.filler) {
        assert.equal(body.ledger.total_minor, 40000, q); assert.equal(body.evidence_gate.complete, true, q); exact++;
      } else if (body.ledger.found === false) assertUnmatched(body, intent.match);
    }
  }
  assert.equal(possible, fillers.length * 4);
  assert.equal(exact, fillers.length * (placements.length * 2 - 4));
  assert.ok(reachedRows > exact && refused > 0, 'both unmatched-row decisions and refused grammar reached');
});
function assertUnmatched(body, selector) {
  assert.equal(body.evidence_gate.complete, false); assert.equal(body.ledger.total_minor, null);
  assert.equal(body.ledger.lead_total_minor, null); assert.equal(body.ledger.if_own_transfers.total_minor, null);
  assert.equal(body.ledger.total_is_exact, false); assert.equal(body.ledger.found, false);
  assert.match(body.answer, /no matching transactions.*covered accounts/i);
  assert.ok(body.answer.toLowerCase().includes(maskLedgerCandidateField(selector).toLowerCase()), 'selector echoed through the shared privacy masker');
  assert.ok(body.gaps.some(g => /merchant may appear under a different name on statements/i.test(g.detail)));
}
test('F1 unmatched selectors with populated and empty covered windows never certify zero; matching zero rows remain exact', async t => {
  const f = spending(t);
  f.raw("UPDATE fin_transactions SET category='Office',category_basis_state='confirmed'");
  for (const selector of ['at Missing Supplier', 'on Missing Category']) {
    const q = `How much did I spend ${selector} in October 2026?`;
    assertUnmatched(await reached(f, q), selector.slice(3));
    const emptyQ = q.replace('October', 'September');
    assertUnmatched(await reached(f, emptyQ), selector.slice(3));
  }
  f.raw('UPDATE fin_transactions SET amount_minor=0');
  for (const selector of ['at Supplier Unit', 'on Office']) {
    const b = await reached(f, `How much did I spend ${selector} in October 2026?`);
    assert.equal(b.ledger.found, true); assert.equal(b.ledger.total_minor, 0); assert.equal(b.evidence_gate.complete, true);
  }
});
test('F3 both amount/possessive identities are selected exactly and FROM possessives remain name text', async t => {
  const f = payerWorld(t);
  for (const paid of ['Payer One', 'Payer One S']) {
    f.raw('UPDATE fin_transactions SET payee=?,description=?', paid, `FROM: ${paid}`);
    for (const requested of ['Payer One', 'Payer One S']) for (const apostrophe of ["'", '’']) for (const amount of ['$400', '400 dollar', '400 dollars', 'USD 400']) {
      const q = `Did ${requested}${apostrophe}s ${amount} payment arrive in October 2026?`;
      const b = await reached(f, q);
      assert.equal(b.ledger.found, requested === paid, q); assert.equal(b.evidence_gate.complete, true, q);
      const from = await reached(f, `Did the ${amount} payment from ${requested} arrive in October 2026?`);
      assert.equal(from.ledger.found, requested === paid); assert.equal(from.evidence_gate.complete, true);
    }
  }
  f.raw("UPDATE fin_entities SET legal_name=? WHERE entity_slug='two'", "Payer One's Workshop");
  f.raw('UPDATE fin_transactions SET payee=?,description=?', "Payer One's Workshop", "FROM: Payer One's Workshop");
  for (const apostrophe of ["'", '’']) for (const amount of ['$400', '400 dollar', '400 dollars', 'USD 400']) {
    const b = await reached(f, `Did the ${amount} payment from Payer One${apostrophe}s Workshop arrive in October 2026?`);
    assert.equal(b.ledger.found, true); assert.equal(b.evidence_gate.complete, true);
    assert.equal((await reached(f, `Did Payer One${apostrophe}s ${amount} payment arrive in October 2026?`)).ledger.found, false);
  }
});
