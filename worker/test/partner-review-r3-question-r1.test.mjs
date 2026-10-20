// Partner review, packet 7 round 1 (question grammar / long questions / speed
// lens). Every name, amount and description here is synthetic. Each
// R3-QUESTION-1-<n> repro is expected to FAIL on the reviewed HEAD (2f5e9ad5);
// each paired control is expected to PASS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture } from './ledger-review-fixture.mjs';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';

const now = Date.parse('2026-10-11T12:00:00.000Z');
const words = (count, word) => Array.from({ length: count }, () => word).join(' ');
const timed = question => {
  const started = performance.now();
  const intent = classifyLedgerQuestion(question, { now });
  return { intent, ms: performance.now() - started };
};

// ---------------------------------------------------------------- R3-QUESTION-1-1
// The payer-span enumeration in classifyLedgerQuestion calls
// classifyPayerQuestion once per candidate span, and classifyPayerQuestion
// enumerates every FROM/VIA span again with a full grammar parse each. Inside
// the documented caps (<= 512 chars, <= 12 selector starts) one question costs
// tens of seconds of synchronous CPU before any ledger read, on every think
// request, including scope-restricted callers.
test('R3-QUESTION-1-1 a payment question inside the 512-char and 12-start caps classifies within 2 seconds', () => {
  const question = `Did the payment from ${Array.from({ length: 11 }, () => `from ${words(18, 'a')}`).join(' ')} arrive please?`;
  assert.ok(question.length <= 512, `fixture stays inside the length cap: ${question.length}`);
  const { intent, ms } = timed(question);
  assert.equal(intent.kind, null, 'the long question is refused, not answered');
  assert.ok(ms < 2000, `classifyLedgerQuestion took ${Math.round(ms)} ms for a ${question.length}-char question`);
});

test('R3-QUESTION-1-1 control: a single-FROM 80-word payment question classifies quickly', () => {
  const question = `Did the payment from ${words(80, 'ab')} arrive please?`;
  assert.ok(question.length <= 512);
  const { intent, ms } = timed(question);
  assert.equal(intent.kind, 'payment');
  assert.ok(ms < 1500, `classifyLedgerQuestion took ${Math.round(ms)} ms`);
});

// ---------------------------------------------------------------- R3-QUESTION-1-2
// Contract question (needs_contract_decision). A description-containment row
// is a "possible match" with a visible note when it is the only row. Once one
// exact payee row exists, the same containment row disappears from the answer
// without any note, and the total is reported complete and exact.
const spendQuestion = 'How much did I spend at Vendor Alpha in October 2026?';
const mentionsPossible = body => /possible match|name similarity/i.test(body.answer || '') ||
  (body.notes || []).length > 0 || (body.assumptions || []).length > 0 ||
  (body.gaps || []).some(gap => /possible|similarity/i.test(`${gap.type} ${gap.reason}`));

test('R3-QUESTION-1-2 an exact outflow total silently omits a description-containment row that is a possible match on its own', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  f.add('contained', 'Vendor Alpha store 12', null, { date: '2026-10-06', cents: 2000, direction: 'outflow' });
  const alone = await f.ask(spendQuestion);
  assert.equal(alone.ledger?.kind, 'merchant', 'ledger routing reached');
  assert.equal(alone.evidence_gate.complete, false, 'the containment row alone is a possible match');
  assert.ok(mentionsPossible(alone), `possible match is visible when alone: ${alone.answer}`);
  f.add('exact', 'Card purchase', 'Vendor Alpha', { date: '2026-10-05', cents: 1000, direction: 'outflow' });
  const both = await f.ask(spendQuestion);
  assert.equal(both.ledger?.kind, 'merchant', 'ledger routing reached');
  assert.ok(both.evidence_gate.complete !== true || mentionsPossible(both),
    `complete total ${both.ledger.total_minor} (exact=${both.ledger.total_is_exact}) with the $20.00 containment row omitted and unmentioned: ${both.answer}`);
});

test('R3-QUESTION-1-2 control: with only the exact payee row the complete total carries no possible-match note', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  f.add('exact', 'Card purchase', 'Vendor Alpha', { date: '2026-10-05', cents: 1000, direction: 'outflow' });
  const body = await f.ask(spendQuestion);
  assert.equal(body.ledger?.kind, 'merchant');
  assert.equal(body.evidence_gate.complete, true);
  assert.equal(body.ledger.total_minor, 1000);
  assert.equal(body.ledger.total_is_exact, true);
  assert.equal(mentionsPossible(body), false);
});
