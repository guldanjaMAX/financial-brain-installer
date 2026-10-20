import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { attributeInflow, payerRegistry, ledgerAttributionLimits } from '../src/lib/ledger-attribution.js';
import { answerWithBudget } from './partner-r2-helpers.mjs';
globalThis.fetch = () => { throw new Error('network forbidden'); };

test('F3 production-budget padding refusal contradicts an otherwise exact payer total', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
    VALUES ('one','Payer One','business','owned','owner_stated','confirmed',?)`, NOW);
  f.add('selected', 'FROM: Payer One', null);
  const q = 'How much income came from Payer One in October 2026?';
  const green = await f.ask(q);
  assert.equal(green.ledger.total_minor, 2500, 'selected receipt is usable before padding');
  assert.equal(green.evidence_gate.complete, true);
  const fields = ['ORIG CO NAME: Payer One', 'ORIG ID: 1234567890', 'DESC DATE: 261005', 'CO ENTRY DESCR: PAYMENT',
    'SEC: CCD', 'TRACE NUMBER: 021000021234567', 'EFFECTIVE DATE: 2026-10-05', 'REFERENCE: 1234',
    'MEMO: october-services', 'INDIVIDUAL ID: ABC123',
    `BENEFICIARY: ${Array(17).fill('Recipient').join(' ')}`, 'SETTLEMENT DATE: 10/05/2026'];
  const description = fields.join(' ');
  assert.ok([...description].length <= 512);
  const one = attributeInflow({ description }, payerRegistry([{ entity_slug: 'one', legal_name: 'Payer One' }]));
  assert.equal(one.state, 'confirmed');
  const rows = Math.ceil(ledgerAttributionLimits.answerSteps / one.evidence.parser.steps) + 300;
  assert.ok(rows < 4999, 'fixture fits the real snapshot cap');
  for (let i = 0; i < rows; i++) f.add(`padding-${i}`, description.replace('REFERENCE: 1234', `REFERENCE: ${i}`), null, { date: '2026-10-14' });
  const before = f.calls.length;
  const body = await f.ask(q);
  assert.ok(f.calls.slice(before).some(sql => /JOIN fin_transactions/.test(sql)), 'real snapshot reached');
  assert.equal(body.ledger.inflow_total_minor, 2500, 'padding is outside the requested period');
  assert.ok(body.gaps.some(gap => gap.reason === 'answer_operation_limit'), 'default production budget exhausted');
  t.diagnostic(JSON.stringify({ rows, stepLimit: ledgerAttributionLimits.answerSteps, rowSteps: one.evidence.parser.steps,
    total_minor: body.ledger.total_minor, total_is_exact: body.ledger.total_is_exact,
    complete: body.evidence_gate.complete, answer: body.answer }));
  assert.equal(body.ledger.total_minor, null, 'an asserted no-complete-total gap cannot accompany a complete total');
  assert.equal(body.ledger.total_is_exact, false);
  assert.equal(body.ledger.subtotal_is_partial, true);
  assert.equal(body.ledger.attributed_subtotal_minor, 2500);
  assert.match(body.answer, /subtotal[^\n]*partial/i);
  assert.doesNotMatch(body.answer, /Total income[^\n]*\$25\.00/i);
});

for (const [kind, question] of [
  ['totals', 'How much money came in and went out in October 2026?'],
  ['merchant', 'How much income by merchant in October 2026?'],
  ['merchant', 'How much did I spend at Fixture Store in October 2026?'],
  ['category', 'How much income by category in October 2026?'],
  ['category', 'How much did I spend on software in October 2026?'],
  ['largest', 'What were my largest deposits in October 2026?'],
  ['deposits', 'Show my deposits in October 2026?'],
  ['transfers', 'How much did I transfer between my own accounts in October 2026?'],
  ['recurring', 'What recurring subscriptions am I paying for, and how much per month?'],
]) test(`F3 padding exhaustion withholds complete figures for ${question}`, async t => {
  const f = ledgerFixture(t, { knownPayers: false, answer: await answerWithBudget(500) });
  f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
    VALUES ('one','Payer One','business','owned','owner_stated','confirmed',?)`, NOW);
  f.add('selected', 'FROM: Payer One', null);
  f.add('expense', 'Fixture Store', 'Fixture Store', { direction: 'outflow' });
  f.raw("UPDATE fin_transactions SET category='software', category_basis_state='confirmed' WHERE txn_uid='expense'");
  const green = await f.ask(question);
  assert.equal(green.ledger?.kind, kind, 'green answer reaches requested branch');
  assert.equal(green.evidence_gate.complete, true);
  for (let i = 0; i < 8; i++) f.add(`padding-${i}`, `FROM: Payer One; REF: ${i}`, null, { date: '2026-10-14' });
  const before = f.calls.length, writes = f.first('SELECT total_changes() n').n;
  const body = await f.ask(question);
  assert.ok(f.calls.slice(before).some(sql => /JOIN fin_transactions/.test(sql)), 'real snapshot reached');
  assert.equal(f.first('SELECT total_changes() n').n, writes, 'answer remains read only');
  assert.ok(body.gaps.some(gap => gap.reason === 'answer_operation_limit'), 'padding exhausts real shared budget');
  assert.equal(body.ledger.kind, kind);
  assert.equal(body.ledger.inflow_total_minor, 2500, 'read amounts are retained separately from complete claims');
  assert.equal(body.ledger.total_minor, null);
  assert.equal(body.ledger.total_is_exact, false);
  assert.equal(body.ledger.subtotal_is_partial, true);
  assert.equal(body.evidence_gate.complete, false);
  assert.match(body.answer, /partial subtotal/i);
  assert.doesNotMatch(body.answer, /\b(?:total|credits|debits|money in|money out)[^\n]*\$25\.00/i);
  if (kind !== 'recurring') assert.ok(body.citations.length, 'retained read amounts have citations');
});
