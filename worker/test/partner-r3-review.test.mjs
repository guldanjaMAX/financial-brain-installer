import test from 'node:test';
import assert from 'node:assert/strict';
import { entityFactAnswer } from '../src/lib/entity-fact-answer.js';
import { address, card, plainAddress } from './partner-r2-helpers.mjs';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
globalThis.fetch = () => { throw new Error('network forbidden'); };
const question = name => `Did the payment from ${name} arrive in October 2026?`;
async function reached(f, name) {
  const before = f.calls.length, writes = f.first('SELECT total_changes() n').n;
  const result = await f.ask(question(name));
  assert.ok(f.calls.slice(before).some(sql => /JOIN fin_transactions/.test(sql)), 'transaction decision reached');
  assert.ok(f.first('SELECT COUNT(*) n FROM fin_transactions').n > 0, 'nonempty receipts');
  assert.equal(f.first('SELECT total_changes() n').n, writes, 'read only');
  assert.ok(result.ledger, 'actual answer renderer reached');
  return result;
}

test('F1 green: supported inspection forms refuse; ordinary scalar and contact facts answer', () => {
  assert.equal(address(plainAddress)?.method, 'dated_owner_address');
  for (const operative of [false, true]) {
    for (const field of ['company','role']) {
      assert.ok(card(field, 'Synthetic Services', entityFactAnswer, operative)?.fact_span);
      for (const tail of ['123456', '123.456', '123/456', '１２３４５６', '١٢٣٤٥٦', '①②③④⑤⑥', 'ＡＣＣＴ 1234'])
        assert.equal(card(field, `Synthetic Services ${tail}`, entityFactAnswer, operative), null);
    }
    for (const [field, value] of [['phone','202-555-0123'],['email','contact@example.invalid']])
      assert.ok(card(field,value,entityFactAnswer,operative)?.fact_span);
  }
});

test('F1 repro: accepted separators and nondecimal numeric glyphs cannot disclose an identifier', () => {
  assert.equal(address(plainAddress)?.method, 'dated_owner_address', 'dated fact decision reached');
  const leaks = [];
  for (const tail of ["123'456", '123,456', '123(456)', '123#456', '❶❷❸❹❺❻']) {
    const result = address(`${plainAddress}, ${tail}`);
    if (result?.answer.includes(tail)) leaks.push({path:'dated address',tail});
  }
  for (const operative of [false,true]) for (const field of ['company','role']) {
    assert.ok(card(field,'Synthetic Services',entityFactAnswer,operative)?.fact_span, 'same scalar envelope is eligible');
    assert.equal(card(field,'Synthetic Services 123456',entityFactAnswer,operative),null,'existing digit refusal reached');
    for (const tail of ["123'456", '123,456', '123(456)', '123&456', '❶❷❸❹❺❻']) {
      const result=card(field,`Synthetic Services ${tail}`,entityFactAnswer,operative);
      if(result?.answer.includes(tail)) leaks.push({path:operative?'operative':'card',field,tail});
    }
  }
  assert.deepEqual(leaks, [], 'numeric identifier variants survived the canonical inspection');
});

function subjectCard(subject, operative=false, ownerQuestion=false) {
  const value='Synthetic Services';
  return entityFactAnswer({question:ownerQuestion?'What is my company?':`What is ${subject}'s company?`,owner:subject,now:Date.parse('2034-10-20'),
    results:[{client:subject,title:'Contact record',snippet:operative
      ? `Subject: ${subject}\n## company\nOperative value: ${value}` : `Name: ${subject}\nCompany: ${value}`}],
    docs:[{n:1,ref:'fixture-card',client:subject,title:'Contact record',source_kind:'curated',date_source:'record:updated',
      date_reliable:true,ts:'2034-10-16',text_source:'native',text_reliable:true,lineage:{status:'known',kind:'source_record'},
      authority:operative ? {owner_confirmed:true,operative_section:{name:'company',value}} : {}}]});
}
test('F2 green: ordinary subject renders with an independently accepted scalar', () => {
  for(const operative of [false,true]) for(const ownerQuestion of [false,true]) {
    const result=subjectCard('Record Owner',operative,ownerQuestion);
    assert.ok(result?.fact_span);
    assert.match(result.answer,/Record Owner's company as Synthetic Services/);
  }
});
test('F2 repro: an identifier in the subject cannot bypass the scalar guard into answer text', () => {
  const leaks=[];
  for(const operative of [false,true]) for(const ownerQuestion of [false,true]) {
    assert.ok(subjectCard('Record Owner',operative,ownerQuestion)?.fact_span, 'same subject-bearing fact path reached');
    for(const subject of ['Account 123456789','Record Owner 123456789']) {
      const result=subjectCard(subject,operative,ownerQuestion);
      if(result?.answer.includes('123456789')) {
        assert.ok(result.fact_span,'the disclosure comes from the real fact renderer');
        leaks.push({operative,ownerQuestion,subject});
      }
    }
  }
  assert.deepEqual(leaks,[],'answer template emitted the entire financial identifier');
});

test('F3 green: allowed punctuation remains useful and forbidden bank Po refuses', async t => {
  const f=ledgerFixture(t,{knownPayers:false}); f.add('receipt','ACH CREDIT','Supplier Services');
  for(const mark of ['.',"'",'&','-','/','#']) for(const source of ['payee','description']) {
    const name=`Supplier${mark} Services`;
    f.raw('UPDATE fin_transactions SET payee=?,description=?',source==='payee'?name:null,source==='description'?`FROM: ${name}`:'ACH CREDIT');
    assert.equal((await reached(f,name)).ledger.found,true,`${source} ${mark}`);
  }
  for(const mark of ['…','․','‥','＇','．','﹒',':']) {
    f.raw('UPDATE fin_transactions SET payee=?,description=?',`Supplier${mark} Services`,'ACH CREDIT');
    assert.equal((await reached(f,'Supplier Services')).ledger.found,null, 'raw bank punctuation guard reached');
  }
});
test('F3 repro: question normalization must not erase residual Po before query-only authority', async t => {
  const f=ledgerFixture(t,{knownPayers:false}); f.add('receipt','ACH CREDIT','Supplier Services');
  assert.equal(f.first("SELECT COUNT(*) n FROM fin_entities WHERE entity_slug!='owner'").n,0,'owned entity only; no registered payer');
  assert.equal((await reached(f,'Supplier Services')).ledger.found,true,'ordinary exact payer control');
  const leaks=[];
  for(const source of ['payee','description']) {
    f.raw('UPDATE fin_transactions SET payee=?,description=?',source==='payee'?'Supplier Services':null,source==='description'?'FROM: Supplier Services':'ACH CREDIT');
    for(const mark of ['…','․','‥','＇','．','﹒']) {
      const result=await reached(f,`Supplier${mark} Services`);
      if(result.ledger.found===true) leaks.push({source,codepoint:mark.codePointAt(0).toString(16)});
    }
  }
  assert.deepEqual(leaks,[],'normalization supplied query-only presence after erasing forbidden punctuation');
});

test('all thirteen comma mappings refuse inversion and preserve suffix-comma authority in real answers', async t => {
  const f=ledgerFixture(t,{knownPayers:false});f.add('receipt','ACH CREDIT','Supplier Services');
  assert.equal((await reached(f,'Supplier Services')).ledger.found,true,'control reaches presence');
  let arms=0;
  const commas=['\u060c','\u3001','\uff0c','\uff64','\ufe50','\ufe51','\u2e41','\u1802','\u1808','\ua4fe','\ua60d','\u07f8','\u055d'];
  for(const comma of commas) for(const source of ['payee','description']) for(const [asked,bank,expected] of [
    ['Supplier Services',`Supplier${comma} Services`,null],
    [`Supplier${comma} Services`,'Supplier Services',null],
    [`Supplier${comma} Services`,`Supplier${comma} Services`,null],
    ['Supplier, LLC',`Supplier${comma} LLC`,true],
    [`Supplier${comma} LLC`,'Supplier, LLC',true],
    [`Supplier${comma} LLC`,`Supplier${comma} LLC`,true],
  ]) {
    f.raw('UPDATE fin_transactions SET payee=?,description=?',source==='payee'?bank:null,source==='description'?`FROM: ${bank}`:'ACH CREDIT');
    assert.equal((await reached(f,asked)).ledger.found,expected);arms++;
  }
  assert.equal(arms,156);t.diagnostic(JSON.stringify({commaArms:arms}));
});

test('unexhausted registered payer still reports an exact total', async t => {
  const f=ledgerFixture(t,{knownPayers:false});
  f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
    VALUES ('one','Payer One','business','owned','owner_stated','confirmed',?)`,NOW);
  f.add('receipt','FROM: Payer One',null);
  const before=f.calls.length;
  const result=await f.ask('How much income came from Payer One in October 2026?');
  assert.ok(f.calls.slice(before).some(sql=>/JOIN fin_transactions/.test(sql)));
  assert.equal(result.ledger.total_minor,2500);
  assert.equal(result.ledger.total_is_exact,true);
  assert.equal(result.evidence_gate.complete,true);
  assert.match(result.answer,/Total income[^\n]*\$25\.00/);
});
