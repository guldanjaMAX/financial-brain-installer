import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture } from './ledger-review-fixture.mjs';

const cardTexts = ['CREDIT CARD PAYMENT CARDPAY', 'CARD PAYMENT outside', 'PAYMENT TO CARD outside', 'CARD AUTOPAY outside', 'CARDPAY outside'];
const loanTexts = ['LOAN PAYMENT lender', 'LOAN PMT lender', 'MORTGAGE PAYMENT lender', 'LOAN REPAYMENT lender', 'LOAN AUTOPAY lender'];
const mixedTexts = ['LOAN PAYMENT lender principal 100.00 interest 23.45', 'LOAN PAYMENT lender 23.45 interest',
  'LOAN PAYMENT lender capital 100.00 interest unknown', 'LOAN PAYMENT FEE lender', 'LOAN PAYMENT INTEREST lender',
  'LOAN PAYMENT lender 100.00 23.45', 'LOAN PAYMENT lender charge unknown'];
const wentOut = 'How much went out this month?';
const questions = ['How much did I spend this month?', wentOut,
  'What were my biggest expenses this month?', 'Show recurring charges'];
function book(t, description, payee = null) {
  const f = ledgerFixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  f.add('purchase', 'Store purchase', 'Store Unit', { cents: 567, direction: 'outflow' });
  for (const [i, date] of ['2026-08-05','2026-09-05','2026-10-05'].entries())
    f.add('payment-'+i, description, payee, { cents: 12345, direction: 'outflow', date });
  return f;
}
async function reached(f, question) {
  const before = f.first('SELECT total_changes() n').n, start = f.calls.length;
  const b = await f.ask(question);
  assert.ok(f.calls.slice(start).some(sql => /JOIN fin_transactions/.test(sql)), 'persisted decision reached');
  assert.equal(f.first('SELECT total_changes() n').n, before, 'no writes');
  assert.ok(b.ledger, 'ledger answer reached');
  return b;
}
for (const [kind, texts] of [['card',cardTexts],['loan',loanTexts]]) for (const text of texts) {
  test(`${kind} candidate excluded and cited on every spending surface: ${text}`, async t => {
    const f=book(t,text,kind==='loan'?'lender':null);
    for (const q of questions) {
      const b=await reached(f,q), l=b.ledger;
      // "went out" measures money out: with no connected card or loan account,
      // the nominated payment left the connected accounts, so it stays in that
      // figure and is disclosed. Spending words keep excluding it (0.4.27).
      if (l.kind==='expense_summary') assert.equal(l.expense_total_minor,q===wentOut?567+12345:567,'purchase green control');
      if (l.kind==='largest') assert.deepEqual((l.lead_rows||l.rows).map(r=>r.amount_minor),[567],'purchase ranking control');
      if (l.kind==='recurring') assert.equal(l.recurring.length,0,'payment does not become recurring spending');
      const candidates=l.possible_payments;
      assert.ok(candidates?.length>0,'nonempty payment decision');
      assert.ok(candidates.every(r=>r.payment_kind===kind&&r.amount_minor===12345));
      for (const r of candidates) {
        assert.ok(b.citations.some(c=>c.n===r.n&&c.amount_minor===r.amount_minor&&c.posted_on===r.posted_on));
        assert.ok(b.answer.includes(q===wentOut?`included above, possibly a ${kind} payment (counterpart not proved): $123.45`
          :`possible ${kind} payment, not counted as spending: $123.45`));
        assert.equal(r.included_in_total,q===wentOut?true:undefined);
        assert.ok(b.answer.includes(text),'bank text quoted without parsing');
      }
    }
  });
}
for (const text of mixedTexts) test(`mixed loan withholds without splitting: ${text}`,async t=>{
  const f=book(t,text,'lender');
  for (const q of questions) {
    const b=await reached(f,q),l=b.ledger;
    assert.equal(l.complete,false);
    assert.equal(l.total_minor,null);
    assert.equal(l.expense_total_minor,null);
    assert.equal(l.reason,'loan_payment_mixed_components');
    assert.match(b.answer,/a loan payment mixes repayment and charges/);
    assert.ok(l.possible_payments?.length>0);
    assert.ok(b.answer.includes(text));
  }
});
test('structured store identity vetoes only card nomination; loan words still nominate repayment',async t=>{
  for (const [text,payee,expected] of [['CREDIT CARD PAYMENT CARDPAY','Store Unit',12912],['merchant purchase','lender',12912]]) {
    const f=book(t,text,payee),b=await reached(f,questions[0]);
    assert.equal(b.ledger.expense_total_minor,expected);
    assert.equal(b.ledger.complete,true);
    assert.equal(b.ledger.possible_payments,undefined);
  }
});

test('monthly and comparison components keep possible-payment citations and mixed refusal',async t=>{
  for (const [text,mixed] of [['CARDPAY outside',false],['LOAN PAYMENT lender principal 100 interest 23.45',true]]) {
    const f=book(t,text);
    f.env.ANTHROPIC_API_KEY=f.env.ADMIN_KEY;
    const { withLedgerAnswer }=await import('../src/lib/ledger-answer.js');
    let calls=0;
    const invoke=async(monthly)=>{
      const period=monthly?{type:'between',from:'2026-08-01',to:'2026-10-12'}:{type:'this_month'};
      const intents=Array.from({length:monthly?1:2},()=>({kind:'expense_summary',direction:'outflow',count:null,vendor_text:null,account_hint:null,amount_text:null,date_text:null,period}));
      return (await withLedgerAnswer({env:f.env,question:monthly?'Could you retrieve spending by month from August 1 through October 12?':'Could you retrieve spending this month and spending this month?',now:Date.parse('2026-10-12T12:00:00Z'),grantScope:{all:true},scopePrincipalKind:'owner',callLLM:async()=>{calls++;return {content:[{type:'text',text:JSON.stringify({ambiguous:false,unanswered_part:null,intents})}]};}},()=>assert.fail('no document fallback'))).json();
    };
    const b=await invoke(true);
    assert.ok(calls>0,'injected interpretation admitted');
    assert.equal(b.ledger.kind,'expense_summary');
    assert.equal(b.ledger.months.length,3,'month decisions reached');
    for (const m of b.ledger.months) {
      assert.equal(m.possible_payments.length,1);
      assert.ok(b.citations.some(c=>c.n===m.possible_payments[0].n&&c.posted_on===m.possible_payments[0].posted_on));
      assert.ok(!m.amount_citations.includes(m.possible_payments[0].n),'candidate is not an amount operand');
      if(mixed){assert.equal(m.available,false);assert.equal(m.total_minor,null);assert.equal(m.reason,'loan_payment_mixed_components');}
      else assert.equal(m.total_minor,m.month==='2026-10'?567:0,'ordinary store control');
    }
    assert.equal(b.answer.split('not counted as spending:').length-1,3,'each candidate has its own line');
    if(mixed)assert.match(b.answer,/a loan payment mixes repayment and charges/);
  }
});

test('an unrelated connected liability cannot turn an outside repayment into spending',async t=>{
  for(const kind of ['card','loan']){
    const f=book(t,kind==='card'?'CARDPAY outside':'LOAN PAYMENT outside',''+(kind==='card'?'Card payment':'lender'));
    f.raw("INSERT INTO fin_accounts(account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at) VALUES ('other-liability','owner',?,'liability','4444','manual','owner_stated','confirmed','2026-10-12')",kind);
    f.raw("INSERT INTO fin_account_coverage(account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at) VALUES ('other-liability','complete','2024-01-01','2026-10-31','2026-10-12','owner_stated','confirmed','2026-10-12')");
    const b=await reached(f,questions[0]);
    assert.equal(b.ledger.expense_total_minor,567,'purchase control remains spending');
    assert.equal(b.ledger.possible_payments.length,1,'outside repayment remains a candidate');
  }
});

test('dates and account references cannot prove multiple loan amounts',async t=>{
 const f=ledgerFixture(t);
 f.add('purchase','Store purchase','Store Unit',{cents:567,direction:'outflow'});
 const control=await f.ask('How much did I spend this month?');assert.equal(control.ledger.expense_total_minor,567);
 f.add('repayment','LOAN PAYMENT lender account 4444 date 10/06 reference 5678','lender',{cents:12345,direction:'outflow'});
 const b=await f.ask('How much did I spend this month?');
 assert.ok(f.calls.some(sql=>/JOIN fin_transactions/.test(sql)));
 assert.equal(b.ledger.possible_payments.length,1);
 assert.equal(b.ledger.expense_total_minor,567,'bank identifiers are not multiple monetary amounts');
 assert.equal(b.ledger.possible_payments[0].mixed_components,false);
});

for(const category of ['LOAN_PAYMENTS','LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'])test(`a bank payment code cannot split unconnected loan components: ${category}`,async t=>{
 const f=ledgerFixture(t);f.add('purchase','Store purchase','Store Unit',{cents:567,direction:'outflow'});
 assert.equal((await f.ask('How much did I spend this month?')).ledger.expense_total_minor,567);
 f.add('loan','LOAN PAYMENT lender principal 100.00 interest 23.45','lender',{cents:12345,direction:'outflow'});
 f.raw("UPDATE fin_transactions SET category=?,category_basis_state='confirmed' WHERE txn_uid='loan'",category);
 const b=await f.ask('How much did I spend this month?');assert.ok(f.calls.some(sql=>/JOIN fin_transactions/.test(sql)));
 assert.equal(b.ledger.complete,false);assert.equal(b.ledger.expense_total_minor,null);
 assert.equal(b.ledger.reason,'loan_payment_mixed_components');assert.equal(b.ledger.possible_payments.length,1);
 assert.match(b.answer,/a loan payment mixes repayment and charges/);
});

for(const kind of ['card','loan'])for(const channel of kind==='card'?['CARD PAYMENT','CARDPAY']:['LOAN PAYMENT','LOAN PMT','MORTGAGE PMT','REPAYMENT OF LOAN'])test(`connected ${channel} identity cannot be lost through the expense-category veto`,async t=>{
 const f=ledgerFixture(t);
 f.raw("INSERT INTO fin_accounts(account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at) VALUES ('known','owner',?,'liability','4444','manual','owner_stated','confirmed','2026-10-12')",kind);
 f.raw("INSERT INTO fin_account_coverage(account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at) VALUES ('known','complete','2024-01-01','2026-10-31','2026-10-12','owner_stated','confirmed','2026-10-12')");
 f.add('fee','Service fee','Store Unit',{cents:12345,direction:'outflow'});
 f.raw("UPDATE fin_transactions SET category='BANK_FEES',category_basis_state='confirmed'");
 assert.equal((await f.ask('How much did I spend this month?')).ledger.expense_total_minor,12345,'confirmed fee green control');
 f.raw("UPDATE fin_transactions SET description=?,payee=?",`${channel} TO ACCOUNT 4444`,`${kind} payment`);
 const b=await f.ask('How much did I spend this month?');assert.ok(f.calls.some(sql=>/JOIN fin_transactions/.test(sql)));
 assert.equal(b.ledger.expense_total_minor,12345,'a connected endpoint is outside the unconnected guard');
 assert.equal(b.ledger.possible_payments,undefined);
 // Clearing the expense category must not promote an unrecognized new
 // channel spelling into ordinary principal after the identity-only check.
 f.raw("UPDATE fin_transactions SET category=NULL");
 const principal=await f.ask('How much did I spend this month?');
 assert.equal(principal.ledger.expense_total_minor,0);
 assert.ok(principal.ledger.payment_exclusions?.count===1 || principal.ledger.possible_payments?.length===1);
 f.raw("UPDATE fin_transactions SET category='BANK_FEES',category_basis_state='confirmed'");
 if(kind==='card'){
  f.raw("UPDATE fin_transactions SET description='payment to account 4444'");
  const held=await f.ask('How much did I spend this month?');
  assert.equal(held.ledger.reason,'owned_movement_unconfirmed','accepted B2 guard remains');
  assert.equal(held.ledger.expense_total_minor,null);
 }
});

test('two explicit compact currency amounts require a mixed-loan hold',async t=>{
 const f=ledgerFixture(t);f.add('store','Store purchase','Store Unit',{cents:567,direction:'outflow'});
 assert.equal((await f.ask('How much did I spend this month?')).ledger.expense_total_minor,567);
 f.add('loan','LOAN PAYMENT lender USD100.00 USD23.45','lender',{cents:12345,direction:'outflow'});
 const b=await f.ask('How much did I spend this month?');assert.ok(f.calls.some(sql=>/JOIN fin_transactions/.test(sql)));
 assert.equal(b.ledger.complete,false);assert.equal(b.ledger.expense_total_minor,null);
 assert.equal(b.ledger.reason,'loan_payment_mixed_components');assert.equal(b.ledger.possible_payments.length,1);
});

for(const description of ['CARDPAYÉ store','CARD PAYMENTÉ store','LOAN PAYMENTÉ store'])test(`closed payment words retain a Unicode suffix: ${description}`,async t=>{
 const f=ledgerFixture(t);f.add('store','Store purchase','Store Unit',{cents:567,direction:'outflow'});
 f.add('candidate','merchant purchase',null,{cents:12345,direction:'outflow'});
 assert.equal((await f.ask('How much did I spend this month?')).ledger.expense_total_minor,12912);
 f.raw("UPDATE fin_transactions SET description=? WHERE txn_uid='candidate'",description);
 const b=await f.ask('How much did I spend this month?');assert.ok(f.calls.some(sql=>/JOIN fin_transactions/.test(sql)));
 assert.equal(b.ledger.expense_total_minor,12912,'whole normalized token is required');
 assert.equal(b.ledger.possible_payments,undefined);
 f.raw("UPDATE fin_transactions SET description=? WHERE txn_uid='candidate'",description.replace('É',''));
 const positive=await f.ask('How much did I spend this month?');
 assert.equal(positive.ledger.expense_total_minor,567,'paired positive payment control');
 assert.equal(positive.ledger.possible_payments.length,1);
});

for(const kind of ['card','loan'])for(const named of [false,true])test(`an unresolved ${kind} payment cannot erase a confirmed expense named=${named}`,async t=>{
 const f=ledgerFixture(t);
 if(named){
  f.raw("INSERT INTO fin_accounts(account_slug,entity_slug,label,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at) VALUES ('known','owner',?,?,'liability','4444','manual','owner_stated','confirmed','2026-10-12')",'Connected '+kind,kind);
  f.raw("INSERT INTO fin_account_coverage(account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at) VALUES ('known','complete','2024-01-01','2026-10-31','2026-10-12','owner_stated','confirmed','2026-10-12')");
 }
 f.add('fee','Service fee','Store Unit',{cents:12345,direction:'outflow'});
 f.raw("UPDATE fin_transactions SET category='BANK_FEES',category_basis_state='confirmed'");
 assert.equal((await f.ask('How much did I spend this month?')).ledger.expense_total_minor,12345,'confirmed fee green control');
 f.raw('UPDATE fin_transactions SET description=?,payee=?',(kind==='card'?'CARDPAY':'LOAN PMT')+(named?' to Connected '+kind:' outside'),kind+' payment');
 const b=await f.ask('How much did I spend this month?');assert.ok(f.calls.some(sql=>/JOIN fin_transactions/.test(sql)));
 assert.equal(b.ledger.complete,false);assert.equal(b.ledger.expense_total_minor,null);
 assert.equal(b.ledger.reason,'payment_expense_category_conflict');assert.equal(b.ledger.possible_payments.length,1);
 assert.match(b.answer,/conflicts with a confirmed category/);
});

test('gross inflow account lines retain every raw debit while spending excludes possible repayments', async t => {
  const f=ledgerFixture(t);
  t.mock.method(globalThis,'fetch',()=>assert.fail('network forbidden'));
  f.add('deposit','Customer deposit','Payer Unit',{cents:1000});
  f.add('purchase','Store purchase','Store Unit',{cents:567,direction:'outflow'});
  const control=await reached(f,'How much money came in this month?');
  assert.equal(control.ledger.combined_inflow_minor,1000,'deposit control');
  assert.equal(control.ledger.accounts[0].debits_minor,567,'purchase debit control');
  f.add('repayment','LOAN PAYMENT outside','lender',{cents:12345,direction:'outflow'});
  const gross=await reached(f,'How much money came in this month?');
  assert.equal(gross.ledger.combined_inflow_minor,1000);
  assert.equal(gross.ledger.accounts[0].debits_minor,12912,'raw activity retains repayment debit');
  assert.ok(gross.citations.some(c=>c.amount_minor===12345),'raw debit evidence retained');
  const spend=await reached(f,'How much did I spend this month?');
  assert.equal(spend.ledger.expense_total_minor,567);
  assert.equal(spend.ledger.possible_payments.length,1,'spending exclusion decision reached');
});

test('existing directed loan repayment verbs also nominate an unconnected payment', async t => {
  for (const text of ['PAYMENT TO LOAN outside','PAYMENT TO MORTGAGE outside','AUTOPAY TO LOAN outside','REPAYMENT TO MORTGAGE outside']) {
    const f=book(t,text,'lender');
    for (const q of questions) {
      const b=await reached(f,q),l=b.ledger;
      // "went out" measures money out: no loan account is connected, so the
      // nominated payment left the connected accounts and stays in that figure.
      if(l.kind==='expense_summary') assert.equal(l.expense_total_minor,q===wentOut?567+12345:567,'ordinary purchase stays spending');
      if(l.kind==='largest') assert.deepEqual((l.lead_rows||l.rows).map(r=>r.amount_minor),[567]);
      if(l.kind==='recurring') assert.equal(l.recurring.length,0);
      assert.ok(l.possible_payments.length>0,'directed loan decision reached');
      assert.ok(l.possible_payments.every(r=>r.included_in_total===(q===wentOut?true:undefined)));
      assert.ok(l.possible_payments.every(r=>r.payment_kind==='loan'&&r.amount_minor===12345));
      assert.ok(b.answer.includes(text));
    }
  }
});
