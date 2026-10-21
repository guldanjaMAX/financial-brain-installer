// Partner review, packet 7 round 6 (answer-fidelity lens on partner/fix-0418-3
// at fa93db5: the partner's 13 answers as applied in 4e4829d, 346162f and
// da7a92a, plus the round-4 and round-5 fixes). Every name, amount and
// description here is synthetic, role words only. Each R6-FIDELITY-<k> repro
// is expected to FAIL on the reviewed HEAD; each paired control is expected to
// PASS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { seedKnownPayers } from './ledger-known-payers-fixture.mjs';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';

const now = Date.parse(NOW);
const classify = question => classifyLedgerQuestion(question, { now });

// Two registered payers. Payer One paid $100 on 2026-09-10 (32 days before
// NOW) and $25 on 2026-10-05; both sit inside the amountless 60-day window.
function registeredPayerFixture(t) {
  const f = ledgerFixture(t, { knownPayers: false });
  seedKnownPayers(f, ['Payer One', 'Vendor Alpha'], NOW);
  f.add('sep-in', 'ACH credit Payer One', 'Payer One', { date: '2026-09-10', cents: 10000 });
  f.add('oct-in', 'ACH credit Payer One', 'Payer One', { date: '2026-10-05', cents: 2500 });
  return f;
}

// ------------------------------------------------------------- R6-FIDELITY-1
// Partner answer 9 (verbatim): "Strip a closed list of qualifiers before
// "payment": any, latest, last, recent, monthly, invoice, ACH, wire. Refuse
// any other qualifier at classification. A qualifier is never a second
// payer." The answer-9 rewrite (ledger-question.js rewriteLedgerQuestion,
// the slot before the question's own "payment") finds the slot after an
// optional auxiliary and article anchored at the START of the question. A
// question that opens with "please", the one leading filler the payment
// grammar itself consumes (classifyQuestionGrammar strips "please" with the
// other grammar words), has no auxiliary at the start, so the slot becomes
// "please, did the": one payer-shaped word beside a FROM payer, and the
// rewrite refuses the question as an unlisted qualifier. No qualifier is in
// the question. On 6465ce1 (before the answer-9 rewrite) every one of these
// questions classified as kind=payment for "payer one" and answered the
// registered payer's two deposits completely; on HEAD they are kind=null and
// routed to documents with no ledger gap, so the deposits are hidden. The
// same question with "please" at the end, or without it, still answers.
// Answer 9 asks for no more than the closed-list strip and the unlisted
// qualifier refusal; refusing a question with no qualifier is more.
const leadingPlease = [
  'Please, did the payment from Payer One arrive?',
  'Please did the payment from Payer One arrive?',
  'Please, has the payment from Payer One arrived?',
  'Please, did the payment from Payer One arrive in October 2026?',
];

test('R6-FIDELITY-1 repro: a leading "please" before the auxiliary is read as an unlisted qualifier beside the FROM payer and the registered unique payer is refused at classification', async t => {
  for (const question of leadingPlease) {
    const intent = classify(question);
    const f = registeredPayerFixture(t);
    const body = await f.ask(question);
    assert.equal(intent.kind, 'payment',
      `${question}: classified as ${intent.kind}; answered route=${body.route} complete=${body.evidence_gate?.complete} found=${body.ledger?.found}: ${body.answer}`);
    assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], question);
    assert.equal(body.evidence_gate?.complete, true, `${question}: ${body.answer}`);
    assert.equal(body.ledger?.found, true, question);
    assert.deepEqual(body.citations.map(c => c.amount_minor), /October 2026/.test(question) ? [2500] : [10000, 2500], question);
  }
});

test('R6-FIDELITY-1 control: the same questions with "please" at the end or without it answer completely, a listed qualifier beside a trailing "please" is stripped, and a leading word that is not grammar still refuses', async t => {
  for (const question of ['did the payment from Payer One arrive, please?', 'did the payment from Payer One arrive?',
    'has the payment from Payer One arrived, please?', 'did the payment from Payer One arrive in October 2026, please?',
    'did the latest payment from Payer One arrive, please?', 'In October 2026, did the latest payment from Payer One arrive?']) {
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', question);
    assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], question);
    const f = registeredPayerFixture(t);
    const body = await f.ask(question);
    assert.equal(body.evidence_gate?.complete, true, `${question}: ${body.answer}`);
    assert.equal(body.ledger?.found, true, question);
    assert.deepEqual(body.citations.map(c => c.amount_minor), /October 2026/.test(question) ? [2500] : [10000, 2500], question);
  }
  // A leading word the payment grammar does not consume is not a supported
  // form, with or without the comma; the fix must not admit every leading
  // word. An unlisted qualifier beside the FROM payer still refuses at
  // classification whether or not "please" leads the question (answer 9).
  for (const question of ['So, did the payment from Payer One arrive?', 'Hey did the payment from Payer One arrive?',
    'Please, did the big payment from Payer One arrive?', 'did the big payment from Payer One arrive?']) {
    assert.equal(classify(question).kind, null, question);
  }
});
