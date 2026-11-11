import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, ask} from './business-scope-complement-fixture.mjs';
import {withLedgerAnswer} from './business-scope-selector-loader.mjs';
import {readFileSync} from 'node:fs';
for (const direction of ['outflow', 'inflow']) test('pure business scope preserves ordinary alternate and recorded '+direction, async t => {
  const f=fixture(t);
  if (direction === 'inflow') f.raw("UPDATE fin_transactions SET direction='inflow'");
  f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,provenance,basis_state,recorded_at)
    VALUES ('movement','operating','2026-09-20',900,?,?, 'owner_stated','confirmed','2026-10-01')`, direction,
    direction === 'outflow' ? 'TRANSFER TO ACCOUNT 8102' : 'TRANSFER FROM ACCOUNT 8102');
  const reader = direction === 'outflow' ? withLedgerAnswer : (options, next) => withLedgerAnswer({...options, callLLM: async () => {
    const reply = await options.callLLM(); const wire = JSON.parse(reply.content[0].text); wire.intents[0].direction = 'inflow';
    return {content:[{type:'text',text:JSON.stringify(wire)}]};
  }}, next);
  const r=await ask(reader,f, direction === 'outflow' ? 'business spending last month' : 'business income last month', direction === 'outflow' ? 'expense_summary' : 'totals','business');
  assert.ok(r.reached.inventory && r.reached.facts, 'scoped money decision reached');
  assert.equal(direction === 'outflow' ? r.body.ledger.total_minor : r.body.ledger.combined_inflow_minor, direction === 'outflow' ? 300 : 1200, 'gross inflow retains owned movements');
  if (direction === 'inflow') {
    assert.equal(r.body.ledger.lead_accounts.reduce((sum, row) => sum + row.credits_minor, 0), 1200, 'unpaired possible movement stays inside money in');
    assert.equal(r.body.ledger.outside_inflow_minor, 1200, 'unpaired credit cannot be subtracted');
    assert.match(r.body.answer, /Possible own transfer/);
  }
});
for (const direction of ['outflow', 'inflow']) test('pure business scope shares cited payment exclusions: '+direction, async t => {
  const f=fixture(t);
  if (direction === 'inflow') f.raw("UPDATE fin_transactions SET direction='inflow'");
  f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,category,category_basis_state,provenance,basis_state,recorded_at)
    VALUES ('card-payment','operating','2026-09-20',900,?,'Card payment','Card Unit','LOAN_PAYMENTS_CREDIT_CARD_PAYMENT','confirmed','owner_stated','confirmed','2026-10-01')`, direction);
  const reader = direction === 'outflow' ? withLedgerAnswer : (options, next) => withLedgerAnswer({...options, callLLM: async () => {
    const reply=await options.callLLM(), wire=JSON.parse(reply.content[0].text); wire.intents[0].direction='inflow';
    return {content:[{type:'text',text:JSON.stringify(wire)}]};
  }},next);
  const r=await ask(reader,f,direction === 'outflow'?'business spending last month':'business income last month',direction === 'outflow'?'expense_summary':'totals','business');
  assert.ok(r.reached.inventory && r.reached.facts, 'scoped payment decision reached');
  assert.equal(direction === 'outflow'?r.body.ledger.total_minor:r.body.ledger.combined_inflow_minor, direction === 'outflow' ? 300 : 1200);
  if (direction === 'inflow') assert.equal(r.body.ledger.lead_accounts.reduce((sum, row) => sum + row.credits_minor, 0), 300);
  assert.equal(r.body.ledger.payment_exclusions?.total_minor,900);
  const row=r.body.ledger.payment_exclusions.rows[0];
  assert.equal(r.body.citations.find(c=>c.n===row.n).account_mask,'8101');
  assert.match(r.body.answer,/payment to a card: \$9\.00/);
  assert.equal(r.body.ledger.operation_scope.excluded_accounts.length,1,'S9a unknown membership remains visible');
  const url=new URL('../src/lib/ledger-answer.js',import.meta.url);
  const source=readFileSync(url,'utf8'), site=[
    'roleLedgerAnswer: (env, intent, accounts, inventory) => ledgerAnswer(env,',
    '      { ...intent, loanPaymentSubject: loanPaymentSubject(options.question, intent), refundBoundary: options.refundBoundary }, accounts, inventory)',
  ].join('\n');
  assert.equal(source.split(site).length-1,1,'shared monetary reader injection is reached once');
  const changedSource=source.replace(site,'roleLedgerAnswer: undefined').replace(/from (["'])(\.\/[^"']+)\1/g,
    (_,q,p)=>`from ${q}${new URL(p,url).href}${q}`);
  const mutant=(await import(`data:text/javascript;base64,${Buffer.from(changedSource).toString('base64')}`)).withLedgerAnswer;
  const changedReader=direction==='outflow'?mutant:(options,next)=>mutant({...options,callLLM:async()=>{
    const reply=await options.callLLM(),wire=JSON.parse(reply.content[0].text);wire.intents[0].direction='inflow';
    return {content:[{type:'text',text:JSON.stringify(wire)}]};
  }},next);
  const changed=await ask(changedReader,f,direction==='outflow'?'business spending last month':'business income last month',direction==='outflow'?'expense_summary':'totals','business');
  assert.ok(changed.reached.inventory && changed.reached.facts, 'restored reader reaches scoped facts');
  assert.throws(()=>{
    assert.equal(direction==='outflow'?changed.body.ledger.total_minor:changed.body.ledger.combined_inflow_minor, direction === 'outflow' ? 300 : 1200);
    if (direction === 'inflow') assert.equal(changed.body.ledger.lead_accounts?.reduce((sum, row) => sum + row.credits_minor, 0), 300);
    assert.equal(changed.body.ledger.payment_exclusions?.total_minor,900);
  },assert.AssertionError,'restoring the older monetary reader makes the same oracle red');
});
