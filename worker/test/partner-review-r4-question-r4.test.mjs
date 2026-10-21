// Partner review, packet 7 round 4 (question grammar / long questions / speed
// lens). Every name, amount and description here is synthetic. Each
// R4-QUESTION-<n> repro is expected to FAIL on the reviewed HEAD (da7a92a);
// each paired control is expected to PASS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { seedKnownPayers } from './ledger-known-payers-fixture.mjs';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';

const now = Date.parse(NOW);
const classify = question => classifyLedgerQuestion(question, { now });
const describe = intent => `kind=${intent.kind} counterparty=${JSON.stringify(intent.counterparty)} words=${JSON.stringify(intent.counterpartyWords)} amount=${intent.amountMinor} clauseSets=${JSON.stringify(intent.payerClauseSets?.map(set => set.map(clause => clause.label)))}`;

// Two registered payers; Payer One paid $100 on 2026-09-10 and $25 on 2026-10-05.
function registeredPayerFixture(t, names = ['Payer One', 'Vendor Alpha']) {
  const f = ledgerFixture(t, { knownPayers: false });
  seedKnownPayers(f, names, NOW);
  f.add('sep-in', 'ACH credit Payer One', 'Payer One', { date: '2026-09-10', cents: 10000 });
  f.add('oct-in', 'ACH credit Payer One', 'Payer One', { date: '2026-10-05', cents: 2500 });
  return f;
}

async function assertComplete(t, question, { amount } = {}) {
  const f = registeredPayerFixture(t);
  const body = await f.ask(question);
  assert.equal(body.evidence_gate?.complete, true, `${question}: ${body.code || body.route || ''} ${body.answer}`);
  assert.equal(body.ledger?.found, true, question);
  if (amount !== undefined) assert.ok(body.citations.some(c => c.amount_minor === amount), `${question}: no $${amount / 100} citation`);
  return body;
}

// ---------------------------------------------------------------- R4-QUESTION-1
// Residual of Q9 (R3-QUESTION-3-2). The round-4 rewrite strips a run of the
// closed qualifiers only when the run alone fills the slot before "payment",
// and refuses one unlisted word only when "payment from|via" follows it
// directly. Every other shape leaves the qualifier where paymentParties reads
// it as a noun-form payer: a run that mixes a listed and an unlisted word
// ("big monthly", "monthly big", "big invoice", "latest big"), the unlisted
// word before "payment arrive from <name>" or "payment of $25 from <name>",
// and the possessive two-word form. The qualifier then joins the clause set
// ([big monthly, payer one]) or the counterparty words, and the registered
// unique payer is refused with "I can't confirm which payer you mean".
// Partner answer 9 (verbatim): "Strip a closed list of qualifiers before
// "payment": any, latest, last, recent, monthly, invoice, ACH, wire. Refuse any
// other qualifier at classification. A qualifier is never a second payer."
const leakedQualifier = [
  'did the big monthly payment from Payer One arrive?',
  'did the monthly big payment from Payer One arrive?',
  'did the big invoice payment from Payer One arrive?',
  'did the latest big payment from Payer One arrive?',
  'did the big payment arrive from Payer One?',
  'did the big payment of $25 from Payer One arrive?',
  "did Payer One's big monthly payment arrive?",
  // Folded in from R4-FIDELITY-2 (dropped as a duplicate of this finding).
  'did the very latest payment from Payer One arrive?',
];

test('R4-QUESTION-1 a qualifier run that is not exactly the closed list, or an unlisted qualifier not directly before "payment from", becomes a second payer clause', async t => {
  for (const question of leakedQualifier) {
    const f = registeredPayerFixture(t);
    const intent = classify(question);
    const body = await f.ask(question);
    assert.ok(intent.kind === null || (body.route !== 'documents' && body.evidence_gate?.complete === true && body.ledger?.found === true),
      `${question}: ${describe(intent)}; answered complete=${body.evidence_gate?.complete} found=${body.ledger?.found}: ${body.answer}`);
    assert.equal(intent.kind, null, `${question}: an unlisted qualifier refuses at classification (${describe(intent)})`);
  }
});

test('R4-QUESTION-1 control: the closed run alone is stripped in either word order, and one unlisted word directly before "payment from" refuses', async t => {
  for (const question of ['did the ACH monthly payment from Payer One arrive?', 'did the monthly payment arrive from Payer One?', 'did the latest invoice payment from Payer One arrive?']) {
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', question);
    assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], `${question}: ${describe(intent)}`);
    await assertComplete(t, question);
  }
  for (const question of ['did the big payment from Payer One arrive?', "did Payer One's big payment arrive?", 'did the second payment from Payer One arrive?',
    // From the dropped R4-FIDELITY-2 control: a channel word outside the
    // closed qualifier list, before "payment from", is not a qualifier.
    'did the Zelle payment from Payer One arrive?']) {
    assert.equal(classify(question).kind, null, `${question} is refused at classification`);
  }
  // Triage decided, unchanged: dated and amount forms answer, and a noun slot
  // with no FROM/VIA clause and no possessive still names the payer.
  for (const question of ['did the October 2026 payment from Payer One arrive?', 'did the $25 payment from Payer One arrive?',
    "did Payer One's September 2026 payment arrive?"]) {
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', question);
    assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], `${question}: ${describe(intent)}`);
    await assertComplete(t, question);
  }
  const noun = classify('did the Acme payment arrive?');
  assert.equal(noun.kind, 'payment');
  assert.deepEqual(noun.counterpartyWords, ['acme']);
});

// ---------------------------------------------------------------- R4-QUESTION-2
// Residual of Q13 (R3-QUESTION-3-7). The channel strip requires a clause
// boundary after the channel word and "from" is excluded from that boundary
// list, so a closed-list channel written BEFORE the FROM clause is kept. The
// "other via phrase" refusal only inspects the text before the via, so an
// unlisted channel before the FROM clause is not refused either. In both
// cases the via clause runs up to the arrival verb and the whole phrase
// ("zelle from payer one", "fixture rail from payer one") becomes the payer:
// the registered unique payer is refused as unconfirmed, while the same
// question with the channel after the name answers completely.
// Partner answer 13 (verbatim): "Strip "via <channel>" for a closed list (ACH,
// Zelle, wire, check, Venmo, PayPal). Refuse other "via" phrases."
// 'has the payment via wire from Payer One arrived?' moved to the held test
// below: "wire from" is pinned as part of a complete requested name.
const channelBeforeFrom = [
  'did the payment via Zelle from Payer One arrive?',
  'did the deposit via Zelle from Payer One land?',
  'did the payment via Zelle from Payer One arrive in September 2026?',
  // Folded in from R4-FIDELITY-4 (dropped as a duplicate of this finding).
  'did the payment via ACH from Payer One arrive?',
];
const unlistedViaBeforeFrom = [
  'did the payment via Fixture Rail from Payer One arrive?',
  'did the payment via ACH transfer from Payer One arrive?',
];

test('R4-QUESTION-2 a closed-list channel before the FROM clause is kept as payer text, and an unlisted via phrase before the FROM clause is not refused', async t => {
  for (const question of channelBeforeFrom) {
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', `${question}: ${describe(intent)}`);
    assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], `${question}: a listed channel is stripped (${describe(intent)})`);
    // Triage decided: every closed channel before FROM answers completely.
    const body = await assertComplete(t, question);
    if (/September 2026/.test(question)) assert.equal(body.ledger.from, '2026-09-01', question);
  }
});

// The unlisted half of R4-QUESTION-2 (triage decided kind=null) is HELD: the
// committed two-payer generator (ledger-question-mentions.test.mjs, pair
// templates over selectorTemplates' "the payment via <name>") pins
// "did the payment via <a> from <b> arrive?" as a classified two-payer
// question that refuses at the answer ("can't confirm which payer"), never at
// classification. Today these questions classify with a two-clause payer and
// the answer is incomplete with found=null; nothing is certified.
// The "via wire from" case of R4-QUESTION-2 is HELD: "wire from" is a closed
// statement sender phrase in the committed originator vocabulary, and the
// name-retention generators (ledger-question-selector.test.mjs and
// ledger-production-payers.test.mjs, "the payment via wire from <name>")
// pin "wire from <name>" as the complete requested name: with only the
// shorter name registered the answer must stay uncertain, and a bank payee
// "wire from <name>" must be found. Same question, opposite answer.
test('R4-QUESTION-2 (held) "via wire" before the FROM clause is stripped', {
  todo: 'held for a decision: stripping "via wire" before FROM conflicts with the committed name-retention generators in ledger-question-selector.test.mjs and ledger-production-payers.test.mjs, which pin "wire from <name>" as a complete requested name',
}, async t => {
  const question = 'has the payment via wire from Payer One arrived?';
  const intent = classify(question);
  assert.equal(intent.kind, 'payment', `${question}: ${describe(intent)}`);
  assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], `${question}: ${describe(intent)}`);
  await assertComplete(t, question);
});

test('R4-QUESTION-2 (held) an unlisted via phrase before the FROM clause refuses at classification', {
  todo: 'held for a decision: refusing "via <unlisted> from <payer>" at classification conflicts with the committed two-payer generator in ledger-question-mentions.test.mjs, which pins "the payment via <a> from <b>" as a classified two-payer question',
}, () => {
  for (const question of unlistedViaBeforeFrom) {
    const intent = classify(question);
    assert.equal(intent.kind, null, `${question}: an unlisted via phrase refuses (${describe(intent)})`);
  }
});

// Triage asked to change this control's 'did the payment via Payer One
// arrive?' line to kind=null (R4-FIDELITY-6). That change is HELD: the
// committed selector generators (ledger-question-cases.mjs selectorTemplates
// "the payment via <name>", used by ledger-question-mentions,
// ledger-question-selector and ledger-production-payers) and ledger-review F2
// pin "via <name>" alone as a payer clause, so the line stays as reviewed.
test('R4-QUESTION-2 control: the same channels after the name are stripped, an unlisted channel after the name refuses, and "via <payer>" alone names the payer', async t => {
  for (const question of ['did the payment from Payer One via Zelle arrive?', 'did the payment from Payer One via wire arrive?', 'did the payment via Payer One arrive?']) {
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', question);
    assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], question);
    await assertComplete(t, question);
  }
  for (const question of ['did the payment from Payer One via Fixture Rail arrive?', 'did the payment from Payer One arrive via ACH transfer?']) {
    assert.equal(classify(question).kind, null, `${question}: an unlisted via phrase after the payer refuses`);
  }
  // From the dropped R4-FIDELITY-4 control: the channel after the FROM name,
  // after a possessive, and with a period still answers; a channel alone is
  // not a payer.
  for (const question of ['did the payment from Payer One via ACH arrive?', "did Payer One's payment via wire arrive?",
    'did the payment from Payer One via Zelle arrive in September 2026?']) {
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', question);
    assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], question);
    await assertComplete(t, question);
  }
  assert.equal(classify('did the payment via ACH arrive?').kind, null, 'a channel alone is not a payer');
});

// ---------------------------------------------------------------- R4-QUESTION-3
// Residual of Q13 with Q11. "of" is excluded from the clause boundary after a
// channel, so "via Zelle of $25" is never stripped. With a FROM payer before
// it the whole question is then refused by the "other via phrase" rule and
// routed to documents; without one the channel plus amount becomes the payer
// label "zelle of $25" (no amount scope, 60-day window) and the answer reports
// a nonmatch with found=false. The same words with the amount before the
// channel answer completely. Partner answers 13 and 11 together: strip the
// closed channel, then "of $25" after the name is amount scope.
test('R4-QUESTION-3 a closed-list channel followed by amount scope is not stripped: refused with a FROM payer, a payer label "zelle of $25" without one', async t => {
  // The ACH form is folded in from R4-FIDELITY-4 (dropped as a duplicate).
  for (const named of ['did the payment from Payer One via Zelle of $25 arrive?', 'did the payment from Payer One via ACH of $25 arrive?']) {
    const namedIntent = classify(named);
    assert.equal(namedIntent.kind, 'payment', `${named}: ${describe(namedIntent)}`);
    assert.equal(namedIntent.counterparty, 'payer one', named);
    assert.equal(namedIntent.amountMinor, 2500, named);
    await assertComplete(t, named, { amount: 2500 });
  }
  const amountOnly = 'did the payment via Zelle of $25 arrive?';
  const f = registeredPayerFixture(t);
  const intent = classify(amountOnly);
  const body = await f.ask(amountOnly);
  assert.notEqual(body.ledger?.found, false, `${amountOnly}: ${describe(intent)}; reported a nonmatch: ${body.answer}`);
  assert.equal(intent.kind, 'payment', amountOnly);
  assert.deepEqual(intent.counterpartyWords, [], `${amountOnly}: the channel is stripped and only the amount remains (${describe(intent)})`);
  assert.equal(intent.amountMinor, 2500, amountOnly);
  // Triage decided: the amount window, the same as "payment of $25 via Zelle".
  assert.equal(intent.from, '2026-09-13', amountOnly);
  assert.equal(intent.from, classify('did the payment of $25 via Zelle arrive?').from, amountOnly);
  assert.equal(body.evidence_gate?.complete, true, `${amountOnly}: ${body.answer}`);
  assert.equal(body.ledger?.found, true, amountOnly);
});

test('R4-QUESTION-3 control: the amount before the channel answers with amount scope, with or without a FROM payer', async t => {
  for (const [question, words] of [['did the payment from Payer One of $25 via Zelle arrive?', ['payer', 'one']], ['did the payment of $25 via Zelle arrive?', []],
    // From the dropped R4-FIDELITY-4 control.
    ['did the payment from Payer One via ACH for $25 arrive?', ['payer', 'one']]]) {
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', question);
    assert.deepEqual(intent.counterpartyWords, words, question);
    assert.equal(intent.amountMinor, 2500, question);
    await assertComplete(t, question, { amount: 2500 });
  }
});

// ---------------------------------------------------------------- R4-QUESTION-4
// Residual of Q5 (R3-QUESTION-2-2). The flip is recognised only after
// whitespace or a comma and only before whitespace, a comma, or a trailing
// ":"/";". Written in parentheses it is not recognised at all and the words
// stay in the grammar; after a dash or a semicolon it is recognised and the
// flag is set, but the dash or semicolon stays behind and the grammar refuses
// the remainder. All three route the registered payer to documents.
// Partner answer 5 (verbatim): "Support "exact names only" anywhere in the
// question: strip it and set exactNamesOnly=true."
const punctuatedFlip = [
  'did the payment from Payer One arrive (exact names only)?',
  'did the payment from Payer One arrive - exact names only?',
  'did the payment from Payer One arrive; exact names only?',
];

test('R4-QUESTION-4 "exact names only" in parentheses, after a dash or after a semicolon is refused instead of stripped', async t => {
  for (const question of punctuatedFlip) {
    const f = registeredPayerFixture(t);
    const intent = classify(question);
    const body = await f.ask(question);
    assert.equal(intent.kind, 'payment', `${question}: ${describe(intent)} exactNamesOnly=${intent.exactNamesOnly}; route=${body.route}`);
    assert.equal(intent.exactNamesOnly, true, question);
    assert.equal(intent.counterparty, 'payer one', question);
    assert.equal(body.evidence_gate?.complete, true, `${question}: ${body.answer}`);
    assert.equal(body.ledger?.found, true, question);
  }
});

test('R4-QUESTION-4 control: the flip after a comma, after a full stop, or with a leading colon is stripped and sets the flag', async t => {
  for (const question of ['did the payment from Payer One arrive, exact names only?', 'did the payment from Payer One arrive. Exact names only.', 'Exact names only: did the payment from Payer One arrive?']) {
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', question);
    assert.equal(intent.exactNamesOnly, true, question);
    assert.equal(intent.counterparty, 'payer one', question);
    await assertComplete(t, question);
  }
});

// ---------------------------------------------------------------- R4-QUESTION-5
// Contract question (needs_contract_decision). The closed qualifier list is
// applied only before the word "payment"; the same grammar reads "deposit" as
// a synonym everywhere else. "did the ACH deposit from Payer One land?" is
// refused at classification and routed to documents while "did the ACH payment
// from Payer One land?" answers completely. Partner answer 9 names "payment"
// only; it does not say whether the list applies before "deposit".
const qualifiedDeposit = [
  'did the ACH deposit from Payer One land?',
  'did the monthly deposit from Payer One land?',
  'did the invoice deposit from Payer One land?',
];

// Triage: contract question, kept as a todo until the partner answers.
test('R4-QUESTION-5 a closed-list qualifier before "deposit" is refused while the same qualifier before "payment" answers', {
  todo: 'contract question for the partner: is the answer-9 closed qualifier list also stripped before "deposit", or does a qualifier before "deposit" keep refusing?',
}, async t => {
  for (const question of qualifiedDeposit) {
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', `${question}: ${describe(intent)}`);
    assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], question);
    await assertComplete(t, question);
  }
});

test('R4-QUESTION-5 control: the same qualifiers before "payment" and the plain deposit form answer; an unlisted qualifier before "deposit" refuses', async t => {
  for (const question of ['did the ACH payment from Payer One land?', 'did the monthly payment from Payer One land?', 'did the deposit from Payer One land?']) {
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', question);
    assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], question);
    await assertComplete(t, question);
  }
  assert.equal(classify('did the big deposit from Payer One land?').kind, null, 'an unlisted qualifier before "deposit" refuses');
});

// ---------------------------------------------------------------- R4-QUESTION-6
// Raised as a contract question; triage decided it as a bug: answer 10 already
// refuses "for <period>" with its note, and both of the reviewer's options
// refuse. The follow-up that partner answer 10's note invites ("for September
// 2026 ... received in October 2026") contains two period clauses, so
// questionPeriod refused it before forPeriod was ever read: no
// payment_period_ambiguous code, no note, and the question was routed to
// documents.
test('R4-QUESTION-6 "for <period>" together with "in <period>" is refused silently, without the partner-answer-10 note', async t => {
  const question = 'did the payment from Payer One for September 2026 arrive in October 2026?';
  const f = registeredPayerFixture(t);
  const body = await f.ask(question);
  assert.notEqual(body.route, 'documents', `${question}: routed to documents without a note`);
  assert.equal(body.code, 'payment_period_ambiguous', question);
  assert.equal(body.evidence_gate?.complete, false, question);
  assert.equal(body.ledger, undefined, 'no presence or absence is read');
  assert.ok(body.gaps?.some(gap => (gap.detail || '').includes('Did you mean "received in september 2026"?')), `${question}: ${JSON.stringify(body.gaps)}`);
});

test('R4-QUESTION-6 control: "for <period>" alone refuses with the note, and "arrive in <period>" alone answers', async t => {
  const f = registeredPayerFixture(t);
  const ambiguous = await f.ask('did the payment from Payer One for September 2026 arrive?');
  assert.equal(ambiguous.code, 'payment_period_ambiguous');
  assert.equal(ambiguous.evidence_gate?.complete, false);
  assert.equal(ambiguous.ledger, undefined);
  assert.ok(ambiguous.gaps?.some(gap => gap.detail.includes('Did you mean "received in september 2026"?')), JSON.stringify(ambiguous.gaps));
  const present = await f.ask('did the payment from Payer One arrive in October 2026?');
  assert.equal(present.evidence_gate?.complete, true);
  assert.equal(present.ledger?.found, true);
  assert.equal(present.ledger.from, '2026-10-01');
});

// ---------------------------------------------------------------- R4-QUESTION-7
// Residual of Q9: the qualifier rewrite is applied to the whole question, not
// to the noun slot only. Its "'s " lead matches inside a FROM name, so a
// registered name that itself contains "'s <closed qualifier> Payment" is
// edited ("Owner's Monthly Payment Services" becomes "owner's payment
// services"), the exact mention no longer covers the clause, and the exact
// registered payer with an exact payee row is refused as unconfirmed. The
// contract: an EXACT, unique name match answers completely.
test('R4-QUESTION-7 a closed-list qualifier inside a registered FROM name is stripped and the exact payer is refused', async t => {
  const name = "Owner's Monthly Payment Services";
  const question = `did the payment from ${name} arrive?`;
  const f = ledgerFixture(t, { knownPayers: false });
  seedKnownPayers(f, [name, 'Vendor Alpha'], NOW);
  f.add('oct-in', `ACH credit ${name}`, name, { date: '2026-10-05', cents: 2500 });
  const intent = classify(question);
  const body = await f.ask(question);
  assert.equal(intent.counterparty, name.toLowerCase(), `${question}: ${describe(intent)}`);
  assert.deepEqual(intent.counterpartyWords, ['owner', 's', 'monthly', 'payment', 'services'], question);
  assert.equal(body.evidence_gate?.complete, true, `${question}: ${body.answer}`);
  assert.equal(body.ledger?.found, true, question);
});

test('R4-QUESTION-7 control: registered FROM names with "Payment" but no closed qualifier after the possessive answer exactly', async t => {
  for (const name of ["Owner's Lawn Payment Services", 'Owner Monthly Payment Services']) {
    const question = `did the payment from ${name} arrive?`;
    const f = ledgerFixture(t, { knownPayers: false });
    seedKnownPayers(f, [name, 'Vendor Alpha'], NOW);
    f.add('oct-in', `ACH credit ${name}`, name, { date: '2026-10-05', cents: 2500 });
    const intent = classify(question);
    assert.equal(intent.counterparty, name.toLowerCase(), `${question}: ${describe(intent)}`);
    const body = await f.ask(question);
    assert.equal(body.evidence_gate?.complete, true, `${question}: ${body.answer}`);
    assert.equal(body.ledger?.found, true, question);
  }
});

// ---------------------------------------------------------------- R4-QUESTION-8
// Residual of Q9 (R3-QUESTION-3-2), short versus long wording. The qualifier
// strip's lead is anchored to "did|has|have" plus an optional article (or a
// payer's 's), so the same closed-list qualifier in the same subject slot
// after "was", "is", "were" or with no auxiliary at all is never stripped.
// The plain question in each of those forms answers the registered unique
// payer completely; adding one listed qualifier refuses it at classification
// and routes it to documents. Safe (never a second payer, never complete),
// but the exact payer's answer is hidden on wording alone. Partner answer 9
// (verbatim): "Strip a closed list of qualifiers before "payment": any,
// latest, last, recent, monthly, invoice, ACH, wire." No auxiliary is named.
// Triage: 'were the monthly payment from Payer One received?' is not a
// supported form even without the qualifier (kind null on HEAD), so it moved
// out of this list to its own refusal assertion below. R4-FIDELITY-8 was
// dropped as a duplicate; its three "was" questions are folded in here.
const otherAuxiliaryQualifier = [
  'was the monthly payment from Payer One received?',
  'was the ACH payment from Payer One received?',
  'is the monthly payment from Payer One received?',
  'monthly payment from Payer One arrived?',
  'was the latest payment from Payer One received?',
  'was the last payment from Payer One received?',
  'was any payment from Payer One received?',
];

test('R4-QUESTION-8 a closed-list qualifier after "was", "is", "were" or with no auxiliary is refused instead of stripped', async t => {
  for (const question of otherAuxiliaryQualifier) {
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', `${question}: ${describe(intent)}`);
    assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], `${question}: ${describe(intent)}`);
    await assertComplete(t, question);
  }
  // The "were" form refuses with or without the qualifier: stripping cannot
  // make an unsupported lead answer.
  assert.equal(classify('were the payment from Payer One received?').kind, null);
  assert.equal(classify('were the monthly payment from Payer One received?').kind, null);
});

test('R4-QUESTION-8 control: the same questions without the qualifier answer, the "did"/"has" forms strip it, and an unlisted qualifier refuses in every form', async t => {
  for (const question of ['was the payment from Payer One received?', 'is the payment from Payer One received?', 'payment from Payer One arrived?',
    'has the monthly payment from Payer One arrived?', 'did my monthly payment from Payer One arrive?']) {
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', `${question}: ${describe(intent)}`);
    assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], `${question}: ${describe(intent)}`);
    await assertComplete(t, question);
  }
  for (const question of ['was the big payment from Payer One received?', 'is the big payment from Payer One received?', 'big payment from Payer One arrived?']) {
    assert.equal(classify(question).kind, null, `${question}: an unlisted qualifier refuses at classification`);
  }
});
