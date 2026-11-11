import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { total, displayFigures } from '../../eval/fast-loop/money-oracle.mjs';
const NOW = Date.parse('2026-11-06T12:00:00Z');
function setup(t) {
  const f = ledgerFixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('offline boundary'));
  f.env.ANTHROPIC_API_KEY = ['synthetic', 'value'].join('-');
  f.put = (id, cents, {direction='inflow', date='2026-10-05', payee='Retail unit', description='Credit adjustment', account='fixture-account', category='software', type=null, state='confirmed'}={}) => {
    f.add(id, description, payee, {cents, direction, date});
    f.raw('UPDATE fin_transactions SET account_slug=?,category=?,category_basis_state=?,basis_state=? WHERE txn_uid=?',account,category,'confirmed',state,id);
  };
  f.account = (kind='savings', label='Reserve unit') => {
    f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,basis_state,recorded_at)
      VALUES ('other','owner',?,?,'5678',?,'manual','owner_stated','confirmed','2026-10-01T00:00:00Z')`,kind,['card','loan','line_of_credit'].includes(kind)?'liability':'asset',label);
    f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES ('other','complete','2024-01-01','2026-10-31','2026-10-01T00:00:00Z','owner_stated','confirmed','2026-10-01T00:00:00Z')`);
  };
  f.read = async (ordinary=false, month=10, extra={}) => {
    const before=f.calls.length, changes=f.first('SELECT total_changes() n').n;
    let models=0;
    const response=await withLedgerAnswer({env:f.env,question:extra.question || (ordinary?'Could you retrieve spending last month after refunds?':'Could you retrieve spending in the category software last month after refunds?'),now:NOW,grantScope:{all:true},scopePrincipalKind:'owner',callLLM:async()=>{
      models++;
      return {content:[{type:'text',text:JSON.stringify({ambiguous:false,unanswered_part:null,intents:[{kind:extra.kind || (ordinary?'merchant':'category'),direction:'outflow',count:null,vendor_text:extra.vendor || (extra.kind === 'expense_summary' ? null : (ordinary?'refunds':'software')),account_hint:null,amount_text:null,date_text:null,period:extra.period || {type:'between',from:`2026-${String(month).padStart(2,'0')}-01`,to:`2026-${String(month).padStart(2,'0')}-${month===9?30:31}`}}]})}]};
    }},()=>assert.fail('ledger decision not reached'));
    const body=await response.json();
    assert.equal(models,1);
    assert.ok(f.calls.slice(before).some(sql=>/JOIN fin_transactions/.test(sql)),'real transaction reader reached');
    assert.equal(f.first('SELECT total_changes() n').n,changes,'read only');
    assert.ok(body.ledger,'ledger decision reached');
    return body;
  };
  return f;
}
function checked(body, gross, ids) {
  const l = body.ledger;
  assert.equal(l.total_minor, gross, 'exact gross decision reached');
  assert.equal(l.net_expense_minor, undefined, 'no refund subtraction');
  assert.equal(l.refund_minor, undefined, 'no certified refund amount');
  assert.equal(l.refund_description_minor, undefined, 'no description deduction');
  assert.equal(l.net_refunds_unavailable, true, 'net unavailable decision reached');
  assert.match(body.answer, /cannot confirm spending after refunds/i);
  const candidates = l.possible_refunds || [];
  assert.equal(candidates.length, ids.length, 'exact expected candidate population');
  assert.equal(new Set(candidates.map(c => c.n)).size, candidates.length, 'distinct identity citations');
  for (const id of ids) {
    const c = candidates.find(c => c.bank_text === id);
    assert.ok(c, 'candidate retained: ' + id);
    const ref = body.citations.find(r => r.n === c.n);
    assert.ok(ref, 'candidate reference exists');
    assert.equal(c.amount_minor, ref.amount_minor);
    assert.equal(c.posted_on, ref.posted_on);
    assert.equal(c.account_mask, ref.account_mask);
    assert.equal(c.label, 'possible refund, not subtracted');
    assert.ok(body.answer.includes('"' + id + '" [' + ref.n + ']'), 'bank text and citation rendered together');
  }
}
for (const ordinary of [false, true]) {
  const route = ordinary ? 'ordinary' : 'category';
  for (const description of ['Not a Store refund', 'This credit is not a software refund', 'No software refund was issued',
    'Refund declined by store', 'Refund never issued', 'Refund request rejected', 'Refund pending approval',
    'Not eligible for any software refund', 'Chargeback request denied', 'Dispute adjustment code Z', 'Store refund without receipt'])
  test(`${route}: earlier wording witness ${description}`, async t => {
    const f=setup(t); f.put('charge',113,{direction:'outflow',date:'2026-10-04',payee:'Other unit'});
    checked(await f.read(ordinary),113,[]);
    f.put('credit',37,{description});
    checked(await f.read(ordinary),113,[description]);
  });
  test(`${route}: R0 proved transfer with a matching owned label`, async t => {
    const f=setup(t); f.put('charge',113,{direction:'outflow',date:'2026-10-04'}); f.put('credit',37);
    checked(await f.read(ordinary),113,['Credit adjustment']);
    f.account('savings','Retail unit');
    f.raw("UPDATE fin_transactions SET description='Transfer from savings 5678' WHERE txn_uid='credit'");
    f.put('out',37,{direction:'outflow',account:'other',description:'Transfer to checking 1234',payee:null});
    const proof=await withLedgerAnswer({env:f.env,question:'Show transfers last month',now:NOW,grantScope:{all:true},scopePrincipalKind:'owner'},()=>assert.fail('transfer decision'));
    assert.equal((await proof.json()).ledger.total_minor,37,'proved transfer control');
    checked(await f.read(ordinary),113,[]);
  });
  for (const desc of ['Transfer from savings 9999','Payment from card 9999','Payment from loan 9999','Loan disbursement from loan 9999'])
  test(`${route}: earlier possible movement ${desc}`, async t => {
    const f=setup(t); f.put('charge',211,{direction:'outflow',date:'2026-10-02'}); f.put('refund',37);
    checked(await f.read(ordinary),211,['Credit adjustment']); f.put('move',37,{description:desc});
    checked(await f.read(ordinary),211,['Credit adjustment']);
  });
  test(`${route}: R1 card payment loses unique pairing after three identical credits`, async t => {
    const f=setup(t); f.account('card','Charge account');
    f.put('charge',211,{direction:'outflow',date:'2026-10-02',payee:'Payment',account:'other'});
    f.put('payment-out',37,{direction:'outflow',description:'Payment to card 5678',payee:null});
    f.put('payment-in',37,{account:'other',description:'Payment thank you',payee:'Payment'});
    const paired=await f.read(ordinary); checked(paired,211,[]);
    assert.equal(paired.ledger.own_account_payments.total_minor,37,'payment decision reached');
    for (const [id,description] of [['refund','Credit adjustment'],['refund-two','Credit adjustment two']])
      f.put(id,37,{payee:'Payment',account:'other',description});
    const collision=await f.read(ordinary); checked(collision,211,['Credit adjustment','Credit adjustment two']);
    assert.equal(collision.ledger.own_account_payments.total_minor,37,'payment remains excluded');
  });
  test(`${route}: R1 loan disbursement keeps membership without endpoint`, async t => {
    const f=setup(t); f.account('loan','Lending unit');
    f.put('charge',211,{direction:'outflow',date:'2026-10-02'}); f.put('refund',37);
    checked(await f.read(ordinary),211,['Credit adjustment']);
    f.put('loan-out',83,{direction:'outflow',account:'other',description:'Loan disbursement to checking 1234',payee:null});
    f.put('loan-credit',83,{description:'Loan disbursement from loan 5678',category:ordinary?'LOAN_DISBURSEMENTS':'software'});
    checked(await f.read(ordinary),211,['Credit adjustment']);
    f.raw("UPDATE fin_transactions SET description='Loan disbursement' WHERE txn_uid='loan-credit'");
    checked(await f.read(ordinary),211,['Credit adjustment']);
  });
  test(`${route}: R1 owned-label collision preserves candidate`, async t => {
    const f=setup(t); f.put('charge',113,{direction:'outflow',date:'2026-10-04'}); f.put('credit',37,{description:'Returned purchase'});
    checked(await f.read(ordinary),113,['Returned purchase']);
    f.account('savings','Retail unit'); checked(await f.read(ordinary),113,['Returned purchase']);
  });
  test(`${route}: R0 historical competition and 90/91-day boundary`, async t => {
    const f=setup(t); f.put('charge',113,{direction:'outflow',date:'2026-09-28'}); f.put('prior',100,{date:'2026-09-29'}); f.put('current',13,{description:'Returned purchase refund'});
    checked(await f.read(ordinary),0,['Returned purchase refund']);
    f.raw("UPDATE fin_transactions SET amount_minor=37 WHERE txn_uid='current'");
    for (const state of ['confirmed','proposed']) {
      f.raw("UPDATE fin_transactions SET basis_state=? WHERE txn_uid='prior'",state);
      checked(await f.read(ordinary),0,['Returned purchase refund']);
    }
    for (const date of ['2026-07-07','2026-07-06']) {
      f.raw("UPDATE fin_transactions SET posted_on=? WHERE txn_uid='charge'",date);
      checked(await f.read(ordinary),0,['Returned purchase refund']);
    }
  });
  test(`${route}: partial, full, overfull, negative wording and identical candidate identities`, async t => {
    const f=setup(t); f.put('charge',113,{direction:'outflow',date:'2026-10-04'});
    checked(await f.read(ordinary),113,[]);
    f.put('one',37,{description:'Refund not approved'}); checked(await f.read(ordinary),113,['Refund not approved']);
    f.put('two',76,{description:'Chargeback credit'}); checked(await f.read(ordinary),113,['Refund not approved','Chargeback credit']);
    f.raw("UPDATE fin_transactions SET amount_minor=77 WHERE txn_uid='two'");
    f.put('three',37,{description:'Refund not approved'});
    const b=await f.read(ordinary); checked(b,113,['Refund not approved','Chargeback credit','Refund not approved']);
    assert.equal(b.citations.filter(c=>c.amount_minor===37).length,2,'two identical credits remain separate rows');
  });
  for (const kind of ['card','loan','line_of_credit']) test(`${route}: bare payment on ${kind} excluded despite amount match`, async t => {
    const f=setup(t); f.account(kind,'Liability unit');
    f.put('charge',113,{direction:'outflow',date:'2026-10-04'}); f.put('credit',113);
    checked(await f.read(ordinary),113,['Credit adjustment']);
    f.put('payment',113,{description:'Payment',account:'other'}); checked(await f.read(ordinary),113,['Credit adjustment']);
  });
}
for (const kind of ['expense_summary','merchant']) test(`explicit ${kind} after-refund route discloses candidates`,async t=>{
  const f=setup(t); f.put('charge',113,{direction:'outflow',date:'2026-10-04'}); f.put('credit',37,{description:'Store refund'});
  checked(await f.read(true,10,{kind,question:'Could you retrieve spending last month after refunds?'}),113,['Store refund']);
});
for (const phrase of ['minus refunds','less refunds','after credits','net spending']) test(`overall expense summary retains candidates for ${phrase}`,async t=>{
  const f=setup(t); f.put('charge',113,{direction:'outflow',date:'2026-10-04'}); f.put('credit',37,{description:'Store refund'});
  checked(await f.read(true,10,{kind:'expense_summary',question:'Could you retrieve spending last month after refunds?'}),113,['Store refund']);
  const body=await f.read(true,10,{kind:'expense_summary',question:phrase==='net spending'?'Could you retrieve net spending last month?':`Could you retrieve spending last month ${phrase}?`});
  console.log(JSON.stringify({probe:phrase,gross:body.ledger.total_minor,netUnavailable:body.ledger.net_refunds_unavailable,candidates:body.ledger.possible_refunds?.length ?? 0}));
  checked(body,113,['Store refund']);
});
for (const ordinary of [false,true]) test(`${ordinary?'ordinary':'category'}: refund memo naming its posting account remains a candidate`,async t=>{
  const f=setup(t); f.account('card','Charge account');
  f.put('charge',113,{direction:'outflow',date:'2026-10-04',account:'other'});
  f.put('credit',37,{description:'Refund for returned software purchase',account:'other'});
  checked(await f.read(ordinary),113,['Refund for returned software purchase']);
  f.raw("UPDATE fin_transactions SET description='Refund for returned software purchase on card 5678' WHERE txn_uid='credit'");
  checked(await f.read(ordinary),113,['Refund for returned software purchase on card 5678']);
  f.raw("UPDATE fin_transactions SET description='Refund for returned software purchase on card 5678 account 1234' WHERE txn_uid='credit'");
  checked(await f.read(ordinary),113,[]);
  f.raw("UPDATE fin_transactions SET description='Refund for returned software purchase on card 5678' WHERE txn_uid='credit'");
  checked(await f.read(ordinary),113,['Refund for returned software purchase on card 5678']);
});
for (const ordinary of [false,true]) test(`${ordinary?'ordinary':'merchant'}: monthly rollup retains candidate disclosure`,async t=>{
  const f=setup(t); f.put('charge',113,{direction:'outflow',date:'2026-10-04'}); f.put('credit',37,{description:'Store refund'});
  checked(await f.read(ordinary),113,['Store refund']);
  const body=await f.read(ordinary,10,{kind:ordinary?'expense_summary':'merchant',vendor:ordinary?null:'Retail unit',
    question:ordinary?'Could you retrieve spending by month from September 1 through October 31, 2026 after refunds?':'Could you retrieve Retail unit spending by month from September 1 through October 31, 2026 after refunds?',
    period:{type:'between',from:'2026-09-01',to:'2026-10-31'}});
  assert.ok(body.ledger.months,'monthly route reached');
  assert.equal(body.ledger.months.length,2,'monthly decision reached');
  assert.deepEqual(body.ledger.months.map(m=>m.total_minor),[0,113],'monthly gross remains exact');
  assert.equal(body.ledger.net_refunds_unavailable,true);
  assert.equal(body.ledger.net_expense_minor,undefined);
  assert.match(body.answer,/cannot confirm spending after refunds/i);
  if (!ordinary) assert.ok(body.citations.some(c=>c.amount_minor===37),'inner merchant candidate reached rollup citation list');
  assert.ok(body.answer.includes('possible refund, not subtracted'),'monthly candidate label retained');
  assert.ok(body.answer.includes('"Store refund"'),'monthly bank text retained');
  assert.ok(body.citations.some(c=>c.amount_minor===37),'monthly candidate cited');
});

if (process.env.REFUND_BOUNDARY_FAULT) test('boundary fault witness refuses an incomplete disclosure after the real monthly decision', async t => {
  const f = setup(t);
  f.put('charge', 113, { direction: 'outflow', date: '2026-10-04' });
  f.put('credit', 37, { description: 'Store refund' });
  const body = await f.read(true, 10, { kind: 'expense_summary', vendor: null,
    question: 'Could you retrieve spending by month from September 1 through October 31, 2026 after refunds?',
    period: { type: 'between', from: '2026-09-01', to: '2026-10-31' } });
  assert.deepEqual(body.ledger.months.map(m => m.total_minor), [0, 113], 'nonempty monthly decision reached');
  assert.equal(f.first("SELECT count(*) n FROM fin_transactions WHERE txn_uid='credit' AND amount_minor=37").n, 1, 'nonempty nominated input reached');
  assert.equal(body.ledger.candidate_disclosure_unavailable, true, 'boundary failure must withhold disclosure');
  assert.match(body.answer, /candidate disclosure unavailable/i);
  assert.match(body.answer, /cannot confirm spending after refunds/i);
  assert.equal(body.evidence_gate.complete, false);
  assert.equal(body.evidence_gate.partial, true);
  assert.equal(body.ledger.net_expense_minor, undefined);
});

// The R0 population is crossed with every admitted phrase and both single and
// monthly output. Independent nomination uses only the synthetic input facts;
// the integer money oracle never imports the product arithmetic.
test('R0 640-case population crossed with five refund phrases and period composition', async t => {
  const f = setup(t), phrases = ['after refunds', 'minus refunds', 'less refunds', 'after credits', 'net spending'];
  const texts = ['Not a Store refund', 'This credit is not a software refund', 'No software refund was issued',
    'Store refund without receipt', 'Store deposit', 'Credit adjustment', 'Refund', 'Ordinary receipt'];
  let state = 20261107, rendered = 0, nominated = 0, readings = 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const norm = text => String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
  for (let i = 0; i < 640; i++) {
    f.raw('DELETE FROM fin_transactions');
    const shape = i % 16, charge = 100 + next() % 100000, partial = 1 + next() % (charge - 1);
    const description = texts[(i >>> 4) % texts.length];
    let credits = [partial], chargeDate = '2026-10-04', payee = 'Retail unit';
    if (shape === 1) payee = 'Other unit';
    if (shape === 2) chargeDate = '2026-07-07';
    if (shape === 3) chargeDate = '2026-07-06';
    if (shape === 4) chargeDate = '2026-10-06';
    if (shape === 5) credits = [charge];
    if (shape === 6) credits = [charge + 1];
    if (shape === 7) credits = [partial, charge - partial];
    if (shape === 8) credits = [partial, charge - partial + 1];
    if ([9, 10, 11].includes(shape)) payee = null;
    if (shape === 12) payee = ' RETAIL UNIT ';
    if (shape === 13) chargeDate = '2026-10-05';
    if (shape === 14) chargeDate = '2026-09-30';
    if (shape === 15) chargeDate = '2026-09-28';
    f.put('charge', charge, { direction: 'outflow', date: chargeDate });
    const input = credits.map((cents, j) => ({ cents, date: '2026-10-05', payee, description: description + ' item ' + j }));
    if (shape === 15) input.push({ cents: charge - partial + 1, date: '2026-09-29', payee: 'Retail unit', description });
    input.forEach((credit, j) => f.put('credit-' + j, credit.cents, credit));
    for (const phrase of phrases) for (const monthly of [false, true]) {
      const period = monthly ? { type: 'between', from: '2026-09-01', to: '2026-10-31' }
        : { type: 'between', from: '2026-10-01', to: '2026-10-31' };
      const when = monthly ? 'by month from September 1 through October 31, 2026' : 'last month';
      const question = phrase === 'net spending' ? `Could you retrieve net spending ${when}?`
        : `Could you retrieve spending ${when} ${phrase}?`;
      const body = await f.read(true, 10, { kind: 'expense_summary', vendor: null, question, period });
      const records = monthly ? body.ledger.months : [body.ledger];
      assert.equal(records.length, monthly ? 2 : 1, 'requested period decisions reached');
      assert.equal(body.ledger.candidate_disclosure_unavailable, undefined, 'disclosure must succeed on healthy composition');
      assert.equal(body.ledger.net_expense_minor, undefined, 'subtractions stay zero');
      assert.equal(body.ledger.net_refunds_unavailable, true);
      for (const record of records) {
        const from = record.from, to = record.to;
        const gross = total([chargeDate >= from && chargeDate <= to ? String(charge) : '0']);
        assert.equal(String(record.total_minor), gross, 'independent oracle gross');
        assert.equal(record.net_expense_minor, undefined);
        assert.ok(displayFigures(body.answer).some(figure => figure.cents === gross), 'oracle figure rendered');
        const expected = input.filter(credit => credit.date >= from && credit.date <= to &&
          (/refund|chargeback|dispute|reversal|reimburse|returned purchase/i.test(credit.description) ||
            Math.abs(Date.parse(credit.date) - Date.parse(chargeDate)) <= 90 * 86400000 &&
            (norm(credit.payee) === 'retail unit' || credit.cents === charge)));
        const candidates = record.possible_refunds;
        assert.equal(candidates.length, expected.length, 'nominated population preserved');
        nominated += expected.length;
        assert.equal(new Set(candidates.map(c => c.n)).size, candidates.length);
        const periodLines = monthly ? body.answer.split(record.label + ':')[1].split(/\n(?:September|October) 2026:/)[0] : body.answer;
        for (const credit of expected) {
          const candidate = candidates.find(c => c.bank_text === credit.description && c.posted_on === credit.date);
          assert.ok(candidate, 'candidate belongs to its own period');
          assert.equal(candidate.amount_minor, credit.cents);
          assert.equal(candidate.account_mask, '1234');
          assert.equal(candidate.label, 'possible refund, not subtracted');
          const ref = body.citations.find(c => c.n === candidate.n);
          assert.equal(ref.amount_minor, credit.cents);
          assert.equal(ref.posted_on, credit.date);
          const suffix = '"' + credit.description + '" [' + candidate.n + ']';
          assert.equal(periodLines.split(suffix).length - 1, 1, 'candidate rendered exactly once in its period');
          rendered++;
        }
      }
      assert.equal(body.answer.split('possible refund, not subtracted:').length - 1,
        records.reduce((sum, record) => sum + record.possible_refunds.length, 0));
      readings++;
    }
  }
  assert.equal(readings, 6400, 'all phrase and period arms reached');
  assert.ok(nominated > 0 && rendered === nominated);
  console.log(JSON.stringify({ refund_boundary_property: 640, readings, candidates_rendered: rendered,
    candidates: nominated, subtractions: 0, wrong_figures: 0 }));
});
