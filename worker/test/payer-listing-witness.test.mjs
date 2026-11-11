import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { trial } from './payer-listing-rule.mjs';
test('minimal proved own-pair: outside membership removes the false payer amount', async t => {
 const f=ledgerFixture(t); let model=0,network=0;
 t.mock.method(globalThis,'fetch',async()=>{network++;throw Error('NETWORK_FORBIDDEN');});
 f.env.AI={async run(){model++;throw Error('MODEL_FORBIDDEN');}};
 f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,basis_state,recorded_at) VALUES ('reserve','owner','checking','asset','4102','Reserve account','manual','owner_stated','confirmed','2026-10-12')`);
 f.add('own','Transfer from Reserve account','Reserve account',{cents:50011});
 f.raw("UPDATE fin_accounts SET label='Daily account' WHERE account_slug='fixture-account'");
 f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,provenance,basis_state,recorded_at) VALUES ('out','reserve','2026-10-05',50011,'outflow','Transfer to Daily account','Daily account','owner_stated','confirmed','2026-10-12')`);
 f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at) VALUES ('reserve','complete','2024-01-01','2026-10-31','2026-10-12','owner_stated','confirmed','2026-10-12')`);
 const ask=async reader=>(await(await reader({env:f.env,question:'Who paid me this month?',now:Date.parse('2026-10-12T12:00:00Z'),grantScope:{all:true},scopePrincipalKind:'owner',callLLM:async()=>{model++;throw Error('MODEL_FORBIDDEN');}},async gap=>Response.json({gap}))).json());
 const reader=process.env.PAYER_MUTANT==='1'?withLedgerAnswer:trial;
 for(const minor of [50011,1]) {
  f.raw('UPDATE fin_transactions SET amount_minor=?',minor);
  const base=await ask(withLedgerAnswer);
  assert.ok(base.ledger,JSON.stringify(base));
  if(process.env.PAYER_RED==='1') assert.equal(base.ledger.total_minor,0,'own credit cannot be income');
  // Measurement must also accept a later product guard that fixes the base.
  assert.ok([0,minor].includes(base.ledger.total_minor),'isolated own-pair measurement');
  t.diagnostic(`minor=${minor} base=${base.ledger.total_minor}`);
  assert.equal((await ask(reader)).ledger.total_minor,0,'outside-membership trial');
 }
 // A confirmed owned endpoint is still internal when its other posting is
 // absent. The proposed outside-inflow rule deliberately requires both legs.
 f.raw("DELETE FROM fin_transactions WHERE txn_uid='out'");
 const singleBase=await ask(withLedgerAnswer), singleRule=await ask(trial);
 assert.ok([0,1].includes(singleBase.ledger.total_minor));
 assert.equal(singleRule.ledger.total_minor,singleBase.ledger.total_minor);
 t.diagnostic(`single_ended_minor=1 base=${singleBase.ledger.total_minor} rule=${singleRule.ledger.total_minor}`);
 assert.equal(model,0);assert.equal(network,0);
});
