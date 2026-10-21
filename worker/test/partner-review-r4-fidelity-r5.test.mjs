// Partner review, packet 7 round 5 (answer-fidelity lens on partner/fix-0418-3
// at e847233: the partner's 13 answers as applied in 4e4829d, 346162f and
// da7a92a, plus the round-4 fixes). Every name, amount and description here
// is synthetic, role words only. Each R5-FIDELITY-<k> repro is expected to
// FAIL on the reviewed HEAD; each paired control is expected to PASS. A repro
// marked "contract question" pins what the contract and the partner's
// principle say literally; the partner decides whether that reading is meant.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { seedKnownPayers } from './ledger-known-payers-fixture.mjs';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';
import { attributeInflow, payerRegistry } from '../src/lib/ledger-attribution.js';

const now = Date.parse(NOW);
const classify = question => classifyLedgerQuestion(question, { now });

// Two registered payers. Payer One paid $100 on 2026-09-10 (32 days before
// NOW) and $25 on 2026-10-05.
function registeredPayerFixture(t, names = ['Payer One', 'Vendor Alpha']) {
  const f = ledgerFixture(t, { knownPayers: false });
  seedKnownPayers(f, names, NOW);
  f.add('sep-in', 'ACH credit Payer One', 'Payer One', { date: '2026-09-10', cents: 10000 });
  f.add('oct-in', 'ACH credit Payer One', 'Payer One', { date: '2026-10-05', cents: 2500 });
  return f;
}

// ------------------------------------------------------------- R5-FIDELITY-1
// Partner answer 9 (verbatim): "Strip a closed list of qualifiers before
// "payment": any, latest, last, recent, monthly, invoice, ACH, wire. Refuse
// any other qualifier at classification. A qualifier is never a second
// payer." The round-4 rewrite (ledger-question.js paymentSlot, applied at the
// slot before the question's own "payment") strips a closed qualifier that
// LEADS a noun payer ("the latest Payer One payment", with the unstripped
// reading kept as a competing alternative) and any closed qualifier beside a
// FROM/VIA payer or after a payer's 's. A closed qualifier that FOLLOWS the
// noun payer, directly before "payment" ("the Payer One monthly payment",
// "the Payer One ACH payment"), is the one position the answer names, and
// there it is not stripped: paymentParties reads "payer one monthly" as the
// payer, the registry mention covers only part of that clause, and the
// registered unique payer is refused as unresolved (found null) although
// both of its deposits are in the window. The same question with the
// qualifier in any other position, or without it, answers completely.
// Triage (round 5) decided: any, latest, last, recent and monthly in this
// trailing position are stripped, the unstripped reading stays a competing
// alternative. ACH, wire and invoice there are NOT changed: the "ACH" case
// joins the held R4-FIDELITY-3 ACH case (todo below), because the committed
// name-retention generator (ledger-question-selector.test.mjs, words from
// ledger-attribution-cases.mjs originatorWords) pins "did the Payer One ach
// payment arrive" as the complete requested name "payer one ach".
test('R5-FIDELITY-1 repro: a listed qualifier after the noun payer, directly before "payment", is kept as payer text and the registered unique payer is refused', async t => {
  for (const [question, amounts, from] of [['did the Payer One monthly payment arrive?', [10000, 2500]],
    ['has the Payer One latest payment arrived?', [10000, 2500]],
    ['did the Payer One monthly payment arrive in September 2026?', [10000], '2026-09-01']]) {
    const intent = classify(question);
    const f = registeredPayerFixture(t);
    const body = await f.ask(question);
    assert.equal(intent.kind, 'payment', question);
    assert.deepEqual(intent.counterpartyWords, ['payer', 'one'],
      `${question}: selector ${JSON.stringify(intent.counterparty)}; answered complete=${body.evidence_gate?.complete} found=${body.ledger?.found}: ${body.answer}`);
    assert.equal(body.evidence_gate?.complete, true, `${question}: ${body.answer}`);
    assert.equal(body.ledger?.found, true, question);
    assert.deepEqual(body.citations.map(c => c.amount_minor), amounts, question);
    if (from) assert.equal(body.ledger.from, from, question);
  }
  // Two exact readings of different entities (the stripped and the
  // unstripped slot) still refuse as ambiguous; nothing is certified.
  const both = ledgerFixture(t, { knownPayers: false });
  seedKnownPayers(both, ['Payer One', 'Payer One Monthly'], NOW);
  both.add('oct-in', 'ACH credit Payer One', 'Payer One', { date: '2026-10-05', cents: 2500 });
  const ambiguous = await both.ask('did the Payer One Monthly payment arrive?');
  assert.notEqual(ambiguous.evidence_gate?.complete, true, ambiguous.answer);
  assert.notEqual(ambiguous.ledger?.found, false, ambiguous.answer);
  assert.equal(ambiguous.ledger?.selector_ambiguous, true, ambiguous.answer);
});

test('R5-FIDELITY-1 (held) a statement-vocabulary qualifier after the noun payer is stripped', {
  todo: 'held for a decision: stripping "ACH" after a noun payer conflicts with the committed name-retention generator in ledger-question-selector.test.mjs ("did the Payer One ach payment arrive" must keep "payer one ach" and not resolve to the shorter "Payer One"), the same conflict as the held R4-FIDELITY-3 ACH case',
}, async t => {
  const question = 'did the Payer One ACH payment arrive?';
  const intent = classify(question);
  const f = registeredPayerFixture(t);
  const body = await f.ask(question);
  assert.equal(intent.kind, 'payment', question);
  assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], `${question}: selector ${JSON.stringify(intent.counterparty)}`);
  assert.equal(body.evidence_gate?.complete, true, `${question}: ${body.answer}`);
  assert.equal(body.ledger?.found, true, question);
});

test('R5-FIDELITY-1 control: the same qualifier before the noun payer, beside a FROM payer or after a possessive is stripped and the plain noun form answers; an unlisted trailing word is never certified absent; a registered name ending in a listed word is its own exact name', async t => {
  for (const question of ['did the Payer One payment arrive?', 'did the latest Payer One payment arrive?',
    'did the monthly payment from Payer One arrive?', 'did the ACH payment from Payer One arrive?',
    "did Payer One's monthly payment arrive?", 'did the Payer One payment arrive in September 2026?']) {
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', question);
    assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], question);
    const f = registeredPayerFixture(t);
    const body = await f.ask(question);
    assert.equal(body.evidence_gate?.complete, true, `${question}: ${body.answer}`);
    assert.equal(body.ledger?.found, true, question);
  }
  // An unlisted word in that position is not a closed qualifier. Whatever
  // reading it gets, the registered payer's deposits are never certified
  // absent and no complete answer is given without them.
  const f = registeredPayerFixture(t);
  const unlisted = await f.ask('did the Payer One big payment arrive?');
  assert.notEqual(unlisted.ledger?.found, false, unlisted.answer);
  assert.ok(!(unlisted.evidence_gate?.complete === true && unlisted.ledger?.found !== true), unlisted.answer);
  // A registered name that ENDS with a listed word is the whole exact name
  // (the round-4 "Wire Works" rule, mirrored): after the repro's fix the
  // unstripped reading must stay a competing alternative, so this answer
  // keeps being complete.
  const invoice = ledgerFixture(t, { knownPayers: false });
  seedKnownPayers(invoice, ['Payer Invoice', 'Vendor Alpha'], NOW);
  invoice.add('oct-in', 'ACH credit Payer Invoice', 'Payer Invoice', { date: '2026-10-05', cents: 2500 });
  const own = await invoice.ask('did the Payer Invoice payment arrive?');
  assert.equal(own.evidence_gate?.complete, true, own.answer);
  assert.equal(own.ledger?.found, true);
});

// ------------------------------------------------------------- R5-FIDELITY-2
// Contract question (needs_contract_decision). Partner answer 4 (verbatim):
// "The payee agreement check covers every reading the parser rates confirmed,
// labelled or not. Disagreement makes the row unknown." Round 4 (R4-MONEY-2)
// extended that to the longest registered whole-word run at a FIELD START.
// An unlabelled description that begins with the payee's own name and then
// carries the complete registered name of another entity ("Vendor Alpha
// Vendor Beta" beside payee "Vendor Alpha") produces no reading for Vendor
// Beta: the only complete parse is the whole unregistered name, and the
// field-start scan stops at the payee's own name. The row is confirmed to
// Vendor Alpha, so it is "known" and hidden from Vendor Beta's answers, which
// are certified absent (found false) and zero (total_minor 0, complete). The
// same two names in the other order ("Vendor Beta Vendor Alpha") make the
// row unknown, so the outcome depends on word order alone. The contract
// grades a substring match as a possible match with a visible note, and the
// partner's principle says a doubtful answer is never absence or zero.
// Whether a registered name inside a payee-prefixed unlabelled description
// is such doubt (versus "Vendor Alpha Holdings ID 1", decided in round 4 as
// the payee's own name extended) was for the partner to decide.
// Partner ruling 9 (round 7, verbatim): "The payee field still decides who
// paid. But for the OTHER payer named in full in an unlabelled description
// (Beta), never certify absence or $0: answer it as a possible match, not
// complete. Alpha's attribution is unchanged. Bare names only; "for <name>
// invoice" prose counts too." The row stays confirmed to Vendor Alpha (the
// repro's "not confirmed" expectation is rewritten to that), and Vendor
// Beta's answers list it as a possible match.
const twoPayers = () => payerRegistry([{ entity_slug: 'alpha', legal_name: 'Vendor Alpha' }, { entity_slug: 'beta', legal_name: 'Vendor Beta' }]);

test('R5-FIDELITY-2 (ruling 9) beside the payee, an unlabelled description naming another registered payer in full keeps the row the payee\'s, and that payer gets a possible match, never absence or $0', async t => {
  // Ruling 9: "The payee field still decides who paid ... Alpha's
  // attribution is unchanged" (was: the row must not be confirmed).
  const decided = attributeInflow({ description: 'Vendor Alpha Vendor Beta', payee: 'Vendor Alpha' }, twoPayers());
  assert.equal(decided.state, 'confirmed', `the payee decides who paid: candidates ${JSON.stringify(decided.evidence.candidates)}`);
  assert.equal(decided.entity_slug, 'alpha');
  // "Bare names only; 'for <name> invoice' prose counts too."
  for (const description of ['Vendor Alpha Vendor Beta', 'Vendor Alpha for Vendor Beta invoice', 'Vendor Alpha remittance for Vendor Beta']) {
    const f = ledgerFixture(t, { knownPayers: false });
    seedKnownPayers(f, ['Vendor Alpha', 'Vendor Beta'], NOW);
    f.add('row', description, 'Vendor Alpha', { cents: 2500 });
    const absent = await f.ask('did the payment from Vendor Beta arrive in October 2026?');
    assert.notEqual(absent.ledger?.found, false, `${description}: certified absence: ${absent.answer}`);
    const zero = await f.ask('how much income came from Vendor Beta in October 2026?');
    assert.ok(!(zero.evidence_gate?.complete === true && zero.ledger?.total_minor === 0), `${description}: certified $0: ${zero.answer}`);
    assert.deepEqual(zero.citations.map(c => c.amount_minor), [2500], `${description}: the row stays visible as a possible match for Vendor Beta`);
    // "answer it as a possible match, not complete"
    for (const body of [absent, zero]) {
      assert.equal(body.evidence_gate?.complete, false, `${description}: ${body.answer}`);
      assert.equal(body.ledger?.found, null, description);
      assert.equal(body.ledger?.total_minor ?? null, null, description);
      assert.deepEqual(body.citations.map(c => c.amount_minor), [2500], description);
      assert.match(body.answer, /\nPossible match: \$25\.00 posted [^\n]*\[1\]\./, description);
    }
    // Alpha's attribution is unchanged: its answer stays complete.
    const alpha = await f.ask('how much income came from Vendor Alpha in October 2026?');
    assert.equal(alpha.evidence_gate?.complete, true, `${description}: ${alpha.answer}`);
    assert.equal(alpha.ledger?.total_minor, 2500, description);
    // Beside an exact Vendor Beta receipt the row is listed with its reason
    // and the exact receipt is a partial figure, never a complete total.
    f.add('beta', 'Deposit', 'Vendor Beta', { cents: 1000 });
    const beside = await f.ask('how much income came from Vendor Beta in October 2026?');
    assert.equal(beside.evidence_gate?.complete, false, `${description}: ${beside.answer}`);
    assert.equal(beside.ledger?.found, true, description);
    assert.equal(beside.ledger?.total_minor, null, description);
    assert.deepEqual(beside.citations.map(c => c.amount_minor), [1000, 2500], description);
    assert.match(beside.answer, /\nUnattributed deposit: \$25\.00 posted [^\n]*uncertain because the statement description also names the requested payer \[2\]\./, description);
  }
});

test('R5-FIDELITY-2 (ruling 9) scope control: only a complete registered name counts, the payee\'s own name never counts, and a description with a sender label names its sender', async t => {
  for (const [description, payee] of [
    // Not named in full: a shortened name of the other payer.
    ['Vendor Alpha Beta', 'Vendor Alpha'],
    // A labelled description names its sender; the committed
    // triage-0417-money C17/C18/PM02/PM03 shape keeps its answers.
    ['Zelle from Vendor Alpha for Vendor Beta invoice', 'Vendor Alpha'],
    // No other payer at all.
    ['Vendor Alpha deposit', 'Vendor Alpha']]) {
    const f = ledgerFixture(t, { knownPayers: false });
    seedKnownPayers(f, ['Vendor Alpha', 'Vendor Beta'], NOW);
    f.add('row', description, payee, { cents: 2500 });
    const absent = await f.ask('did the payment from Vendor Beta arrive in October 2026?');
    assert.equal(absent.ledger?.found, false, `${description}: ${absent.answer}`);
    const alpha = await f.ask('how much income came from Vendor Alpha in October 2026?');
    assert.equal(alpha.evidence_gate?.complete, true, `${description}: ${alpha.answer}`);
    assert.equal(alpha.ledger?.total_minor, 2500, description);
  }
  // A registered name inside the payee's own longer name is the payee's name.
  const f = ledgerFixture(t, { knownPayers: false });
  seedKnownPayers(f, ['Vendor Alpha Group', 'Vendor Alpha'], NOW);
  f.add('row', 'Vendor Alpha Group', 'Vendor Alpha Group', { cents: 2500 });
  const own = await f.ask('did the payment from Vendor Alpha arrive in October 2026?');
  assert.equal(own.ledger?.found, false, own.answer);
  assert.equal((await f.ask('how much income came from Vendor Alpha Group in October 2026?')).ledger?.total_minor, 2500);
});

test('R5-FIDELITY-2 control: the other order, a labelled sender, a field-start name and a delimited name beside the payee are unknown; the payee name extended by its own words, or alone, stays confirmed', async t => {
  const registry = twoPayers();
  for (const description of ['Vendor Beta Vendor Alpha', 'FROM: Vendor Beta', 'Vendor Beta REF 100000', 'Vendor Beta; Vendor Alpha']) {
    const decided = attributeInflow({ description, payee: 'Vendor Alpha' }, registry);
    assert.equal(decided.state, 'unknown', `${description}: ${decided.state} ${String(decided.entity_slug)}`);
  }
  // Round 4 (R4-MONEY-2) decided: a longer run equal to the payee is never
  // overridden by its shorter registered prefix, and the bare payee agrees.
  assert.equal(attributeInflow({ description: 'Vendor Alpha Holdings ID 1', payee: 'Vendor Alpha' }, registry).state, 'confirmed');
  assert.equal(attributeInflow({ description: 'Vendor Alpha', payee: 'Vendor Alpha' }, registry).state, 'confirmed');
  const f = ledgerFixture(t, { knownPayers: false });
  seedKnownPayers(f, ['Vendor Alpha', 'Vendor Beta'], NOW);
  f.add('row', 'Vendor Beta Vendor Alpha', 'Vendor Alpha', { cents: 2500 });
  const beta = await f.ask('did the payment from Vendor Beta arrive in October 2026?');
  assert.equal(beta.ledger?.found, null, beta.answer);
  assert.equal(beta.evidence_gate?.complete, false);
  assert.equal(beta.ledger?.unattributed_count, 1);
  const alpha = await f.ask('how much income came from Vendor Alpha in October 2026?');
  assert.equal(alpha.evidence_gate?.complete, false, alpha.answer);
  assert.equal(alpha.ledger?.total_minor, null);
  assert.deepEqual(alpha.citations.map(c => c.amount_minor), [2500], 'the row stays visible');
});
