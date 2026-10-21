// Partner review, packet 7 round 4 (answer-fidelity lens on the partner
// answers applied in 4e4829d, 346162f and da7a92a). Every name, amount and
// description here is synthetic, role words only. Each R4-FIDELITY-<k> repro
// is expected to FAIL on the reviewed HEAD (da7a92a); each paired control is
// expected to PASS. A repro marked "contract question" pins what the answer
// says literally; the partner decides whether the literal reading is meant.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { seedKnownPayers } from './ledger-known-payers-fixture.mjs';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';

const now = Date.parse(NOW);
const classify = question => classifyLedgerQuestion(question, { now });

// Two registered payers. Payer One paid $100 on 2026-09-10 (32 days before
// NOW) and, unless septemberOnly, $25 on 2026-10-05.
function registeredPayerFixture(t, { septemberOnly = false } = {}) {
  const f = ledgerFixture(t, { knownPayers: false });
  seedKnownPayers(f, ['Payer One', 'Vendor Alpha'], NOW);
  f.add('sep-in', 'ACH credit Payer One', 'Payer One', { date: '2026-09-10', cents: 10000 });
  if (!septemberOnly) f.add('oct-in', 'ACH credit Payer One', 'Payer One', { date: '2026-10-05', cents: 2500 });
  return f;
}

// ------------------------------------------------------------- R4-FIDELITY-1
// Partner answer 9 (verbatim): "Strip a closed list of qualifiers before
// "payment": any, latest, last, recent, monthly, invoice, ACH, wire." The
// rewrite (ledger-question.js qualifierRun) filters "recent" back in, so it
// is not stripped: the period grammar keeps it as the 14-day window. Every
// other listed qualifier is stripped to the amountless 60-day default. For a
// registered payer whose last deposit posted 32 days back, "recent" certifies
// absence (complete=true, found=false) where "latest" finds the deposit.
test('R4-FIDELITY-1 repro: "recent" before "payment" is kept as a 14-day window instead of being stripped, so a deposit 32 days back is certified absent', async t => {
  const latest = classify('did the latest payment from Payer One arrive?');
  const recent = classify('did the recent payment from Payer One arrive?');
  assert.equal(recent.kind, 'payment');
  assert.deepEqual(recent.counterpartyWords, ['payer', 'one']);
  assert.equal(recent.from, latest.from,
    `a stripped qualifier leaves the default window: recent ${recent.from}..${recent.to}, latest ${latest.from}..${latest.to}`);
  const f = registeredPayerFixture(t, { septemberOnly: true });
  const body = await f.ask('did the recent payment from Payer One arrive?');
  assert.ok(!(body.evidence_gate?.complete === true && body.ledger?.found === false),
    `certified absence for ${body.ledger?.from}..${body.ledger?.to} although Payer One paid on 2026-09-10: ${body.answer}`);
  assert.equal(body.ledger?.found, true);
  // Triage decided: the possessive form is stripped the same way.
  const possessive = classify("did Payer One's recent payment arrive?");
  assert.equal(possessive.kind, 'payment');
  assert.deepEqual(possessive.counterpartyWords, ['payer', 'one']);
  assert.equal(possessive.from, latest.from);
  assert.equal(possessive.to, latest.to);
  const g = registeredPayerFixture(t, { septemberOnly: true });
  const owned = await g.ask("did Payer One's recent payment arrive?");
  assert.equal(owned.evidence_gate?.complete, true, owned.answer);
  assert.equal(owned.ledger?.found, true);
});

test('R4-FIDELITY-1 control: the other listed qualifiers are stripped to the default window and find the September deposit', async t => {
  for (const question of ['did the latest payment from Payer One arrive?', 'did the last payment from Payer One arrive?',
    'did any payment from Payer One arrive?', 'did the monthly invoice payment from Payer One arrive?']) {
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', question);
    assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], question);
    assert.equal(intent.from, '2026-08-14', question);
    const f = registeredPayerFixture(t, { septemberOnly: true });
    const body = await f.ask(question);
    assert.equal(body.ledger?.found, true, `${question}: ${body.answer}`);
    assert.equal(body.evidence_gate?.complete, true, question);
  }
  // Triage decided: "recent" outside the slot before "payment" keeps its
  // 14-day reading.
  const deposits = classify('What were my recent deposits?');
  assert.equal(deposits.kind, 'deposits');
  assert.equal(deposits.from, '2026-09-29');
});

// R4-FIDELITY-2 (repro and control) was dropped at triage as a duplicate of
// R4-QUESTION-1; its question ('did the very latest payment from Payer One
// arrive?') and its 'Zelle payment from' control case moved there.

// ------------------------------------------------------------- R4-FIDELITY-3
// Partner answer 9 again. The strip runs only when the qualifier run directly
// precedes "payment" (after the article, or after a payer's 's). A listed
// qualifier before the noun payer ("the latest Payer One payment") is not
// stripped; paymentParties reads "latest payer one" as the payer, the
// registry covers nothing, and the registered unique payer is refused with
// "I can't confirm which payer you mean".
test('R4-FIDELITY-3 repro: a listed qualifier before the noun payer is swallowed into the payer label and the registered unique payer is refused', async t => {
  for (const question of ['did the latest Payer One payment arrive?',
    'has the latest Payer One payment arrived in September 2026?']) {
    const intent = classify(question);
    const f = registeredPayerFixture(t);
    const body = await f.ask(question);
    assert.equal(intent.kind, 'payment', question);
    assert.deepEqual(intent.counterpartyWords, ['payer', 'one'],
      `${question}: selector ${JSON.stringify(intent.counterparty)}; answered complete=${body.evidence_gate?.complete} found=${body.ledger?.found}: ${body.answer}`);
    assert.equal(body.evidence_gate?.complete, true, `${question}: ${body.answer}`);
    assert.equal(body.ledger?.found, true, question);
  }
});

// The 'ACH' case of R4-FIDELITY-3 is HELD. "ach", "wire" and "invoice" are on
// answer 9's list and are also closed statement vocabulary, and the committed
// name-retention generators (ledger-question-selector.test.mjs, cases
// "<word> Payer One" from ledger-question-cases.mjs, e.g. 'did the ach Payer
// One payment arrive in October 2026?' with only "Payer One" registered) pin
// that such a complete requested noun payer is retained and never resolves to
// the shorter registered name. Same question, same registry, opposite answer.
test('R4-FIDELITY-3 (held) a listed statement-vocabulary qualifier before the noun payer is stripped', {
  todo: 'held for a decision: stripping "ACH" before a noun payer conflicts with the committed name-retention generator in ledger-question-selector.test.mjs ("did the ach Payer One payment arrive" must keep "ach payer one" and not resolve to the shorter "Payer One")',
}, async t => {
  const question = 'did the ACH Payer One payment arrive?';
  const intent = classify(question);
  const f = registeredPayerFixture(t);
  const body = await f.ask(question);
  assert.equal(intent.kind, 'payment', question);
  assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], `${question}: selector ${JSON.stringify(intent.counterparty)}`);
  assert.equal(body.evidence_gate?.complete, true, `${question}: ${body.answer}`);
  assert.equal(body.ledger?.found, true, question);
});

test('R4-FIDELITY-3 control: the same noun question without the qualifier, the possessive form and the FROM form answer completely', async t => {
  for (const question of ['did the Payer One payment arrive?', "has Payer One's latest payment arrived?",
    'did the latest payment from Payer One arrive?', 'did the latest payment from Payer One arrive in September 2026?']) {
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', question);
    assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], question);
    const f = registeredPayerFixture(t);
    const body = await f.ask(question);
    assert.equal(body.evidence_gate?.complete, true, `${question}: ${body.answer}`);
    assert.equal(body.ledger?.found, true, question);
  }
  // A registered name that begins with a listed word answers exactly: the
  // strip never runs before a noun payer on HEAD, so "Wire Works" is the whole
  // exact name. When "Works" is registered too, HEAD still answers for Wire
  // Works (nothing was stripped); after the repro's fix the stripped and
  // unstripped slots are both exact for different entities and the question
  // is ambiguous. In both worlds the deposit is never certified absent.
  const wireWorks = ledgerFixture(t, { knownPayers: false });
  seedKnownPayers(wireWorks, ['Wire Works', 'Vendor Alpha'], NOW);
  wireWorks.add('oct-in', 'ACH credit Wire Works', 'Wire Works', { date: '2026-10-05', cents: 2500 });
  const own = await wireWorks.ask('did the Wire Works payment arrive?');
  assert.equal(own.evidence_gate?.complete, true, own.answer);
  assert.equal(own.ledger?.found, true);
  const both = ledgerFixture(t, { knownPayers: false });
  seedKnownPayers(both, ['Wire Works', 'Works'], NOW);
  both.add('oct-in', 'ACH credit Wire Works', 'Wire Works', { date: '2026-10-05', cents: 2500 });
  both.add('oct-in-2', 'ACH credit Works', 'Works', { date: '2026-10-06', cents: 1000 });
  const shared = await both.ask('did the Wire Works payment arrive?');
  assert.notEqual(shared.ledger?.found, false, shared.answer);
  assert.ok(!(shared.evidence_gate?.complete === true && shared.ledger?.found !== true), shared.answer);
});

// R4-FIDELITY-4 (repro and control) was dropped at triage as a duplicate of
// R4-QUESTION-2 and R4-QUESTION-3; its questions and its control cases moved
// into those tests.

// R4-FIDELITY-5 (repro and control) was dropped at triage as a duplicate of
// R4-MONEY-3 (decided there as option A); its spellings ('ACH credit Vendor
// Beta', 'Vendor Beta deposit', 'wire Vendor Beta payment') and its control
// cases (bare 'Vendor Beta', 'FROM: Vendor Beta', same-payer 'ACH credit
// Vendor Alpha') moved into the R4-MONEY-3 tests.

// ------------------------------------------------------------- R4-FIDELITY-6
// Partner answer 13 (verbatim): "Refuse other "via" phrases." The rewrite
// refused an unlisted "via" phrase only after a named payer; a "via" that was
// the only selector still named the payer ("did the payment via Payer One
// arrive?" answered for Payer One). The round-3 control pinned that form as a
// payer before the answer. Triage decided this as a bug, overriding the
// earlier contract-question todo: the literal answer and the principle both
// refuse ("via X" can name a channel or an intermediary). The fix is HELD:
// the committed selector generators (ledger-question-cases.mjs
// selectorTemplates, 45 "<aux> the payment via <name> <verb>" templates used
// by ledger-question-mentions, ledger-question-selector and
// ledger-production-payers), ledger-review.test.mjs F2 ('Did the payment via
// Fixture Bank arrive?' found=true) and the R3-QUESTION-3-7 control all pin
// "via <name>" alone as a payer clause; changing them is broader than the
// two control lines triage listed.
test('R4-FIDELITY-6 repro: "via <payer>" as the only selector still names the payer although answer 13 refuses every "via" phrase outside the closed channel list', {
  todo: 'held for a decision: refusing "via <name>" alone conflicts with committed tests that pin it as a payer clause (selectorTemplates generators in ledger-question-mentions/selector/production-payers, ledger-review F2, R3-QUESTION-3-7 control)',
}, () => {
  for (const question of ['did the payment via Payer One arrive?', 'did the payment via Fixture Rail arrive?', 'did the payment via Wire Works arrive?']) {
    const intent = classify(question);
    assert.equal(intent.kind, null, `${question}: named ${JSON.stringify(intent.counterparty)} as the payer`);
  }
});

test('R4-FIDELITY-6 control: an unlisted "via" phrase after a named payer refuses, a channel alone refuses, and the FROM form answers', async t => {
  for (const question of ['did the payment from Payer One via Fixture Rail arrive?', 'did the Payer One payment via Fixture Rail arrive?',
    'did the payment via ACH arrive?']) assert.equal(classify(question).kind, null, question);
  const f = registeredPayerFixture(t);
  const body = await f.ask('did the payment from Payer One arrive?');
  assert.equal(body.evidence_gate?.complete, true, body.answer);
  assert.equal(body.ledger?.found, true);
  // Triage decided: closed-list channels are still stripped.
  const zelle = await f.ask('did the payment from Payer One via Zelle arrive?');
  assert.equal(zelle.evidence_gate?.complete, true, zelle.answer);
  assert.equal(zelle.ledger?.found, true);
});

// ------------------------------------------------------------- R4-FIDELITY-7
// Partner answer 11 (verbatim): ""of $25", "for $25" and ", $25," after the
// FROM name are amount scope (amountMinor)". The rewrite declines when the
// question already has "payment of <amount>", and the span parser then
// protects "payer one for $30" as the payer label, hiding the second amount
// from the one-amount rule. The question names two conflicting amounts and
// should refuse; instead it searches for the label and reports "No matching
// transactions were found" for it (found=false).
test('R4-FIDELITY-7 repro: a second, conflicting amount after the FROM name is swallowed into the payer label instead of refusing', async t => {
  const question = 'did the payment of $25 from Payer One for $30 arrive?';
  const intent = classify(question);
  const f = registeredPayerFixture(t);
  const body = await f.ask(question);
  assert.equal(intent.kind, null, `two amounts: classified as ${intent.kind} selector ${JSON.stringify(intent.counterparty)} ` +
    `amount ${intent.amountMinor}; answered complete=${body.evidence_gate?.complete} found=${body.ledger?.found}: ${body.answer}`);
});

test('R4-FIDELITY-7 control: one amount before or after the FROM name is amount scope and the $25 deposit answers completely', async t => {
  for (const question of ['did the payment of $25 from Payer One arrive?', 'did the payment from Payer One of $25 arrive?',
    'did the payment from Payer One for $25 arrive?', 'did the payment from Payer One, $25, arrive?']) {
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', question);
    assert.equal(intent.amountMinor, 2500, question);
    assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], question);
    const f = registeredPayerFixture(t);
    const body = await f.ask(question);
    assert.equal(body.evidence_gate?.complete, true, `${question}: ${body.answer}`);
    assert.equal(body.ledger?.found, true, question);
  }
  assert.equal(classify('did the payment of $25 from Payer One arrive, and the $30 one?').kind, null, 'two amounts outside the name refuse');
});

// R4-FIDELITY-8 (repro and control) was dropped at triage as a duplicate of
// R4-QUESTION-8; its three "was the latest/last/any payment from Payer One
// received?" questions moved into that test.

// ------------------------------------------------------------- R4-FIDELITY-9
// Partner answer 10 (verbatim): "Refuse "for <period>" in the payment grammar,
// with a short note asking whether they mean "received in <period>". Never
// certify absence on it." The note is produced only when questionPeriod reads
// the period (month, quarter, year or a relative phrase). A "for <date>"
// ("for 2026-09-10", "for September 10") takes the date branch, where "for"
// is left in the residual and the grammar refuses silently (kind null): no
// note, and the deposit posted on that date is not shown. Contract question:
// is a single date a "<period>" for answer 10 (the note would read
// "received on <date>")? Either way the silent refusal hides the useful part.
// Triage: contract question, kept as a todo until the partner answers.
test('R4-FIDELITY-9 repro (contract question): "for <date>" is refused silently, without the answer-10 note, although the dated deposit exists', {
  todo: 'contract question for the partner: does a single date count as a <period> for answer 10, so "for 2026-09-10" gets the payment_period_ambiguous refusal with a "received on 2026-09-10" note, or does it stay a silent refusal?',
}, async t => {
  for (const [question, received] of [['did the payment from Payer One for 2026-09-10 arrive?', 'received on 2026-09-10'],
    ['did the payment from Payer One for September 10 arrive?', 'received on september 10']]) {
    const f = registeredPayerFixture(t);
    const body = await f.ask(question);
    assert.equal(body.code, 'payment_period_ambiguous',
      `${question}: classified as ${classify(question).kind}; answered code=${body.code} route=${body.route} complete=${body.evidence_gate?.complete}: ${body.answer}`);
    assert.equal(body.evidence_gate?.complete, false, question);
    assert.ok(body.gaps?.some(gap => gap.detail.includes(`Did you mean "${received}"?`)), `${question}: ${JSON.stringify(body.gaps)}`);
  }
});

test('R4-FIDELITY-9 control: "for <period>" refuses with the note, and "on <date>" answers the dated deposit completely', async t => {
  const f = registeredPayerFixture(t);
  const period = await f.ask('did the payment from Payer One for September 2026 arrive?');
  assert.equal(period.code, 'payment_period_ambiguous', period.answer);
  assert.equal(period.evidence_gate?.complete, false);
  assert.ok(period.gaps?.some(gap => gap.detail.includes('Did you mean "received in september 2026"?')), JSON.stringify(period.gaps));
  const dated = await f.ask('did the payment from Payer One on 2026-09-10 arrive?');
  assert.equal(dated.evidence_gate?.complete, true, dated.answer);
  assert.equal(dated.ledger?.found, true);
  assert.equal(dated.ledger?.from, '2026-09-03');
  assert.equal(dated.ledger?.to, '2026-09-17');
});
