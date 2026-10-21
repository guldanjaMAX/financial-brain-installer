// Partner review, packet 7 round 5 (question grammar / long questions / speed
// lens). Every name, amount and description here is synthetic. Each
// R5-QUESTION-<n> repro is expected to FAIL on the reviewed HEAD (e847233);
// each paired control is expected to PASS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { seedKnownPayers } from './ledger-known-payers-fixture.mjs';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';

const now = Date.parse(NOW);
const classify = question => classifyLedgerQuestion(question, { now });
const describe = intent => `kind=${intent.kind} counterparty=${JSON.stringify(intent.counterparty)} words=${JSON.stringify(intent.counterpartyWords)} amount=${intent.amountMinor} window=${intent.from}..${intent.to} exactNamesOnly=${intent.exactNamesOnly} clauseSets=${JSON.stringify(intent.payerClauseSets?.map(set => set.map(clause => clause.label)))}`;
const outcome = body => `route=${body.route || 'ledger'} complete=${body.evidence_gate?.complete} found=${body.ledger?.found} gate=${body.evidence_gate?.reason}: ${body.answer}`;

// Two registered payers; Payer One paid $100 on 2026-09-10 and $25 on 2026-10-05.
function registeredPayerFixture(t, names = ['Payer One', 'Vendor Alpha']) {
  const f = ledgerFixture(t, { knownPayers: false });
  seedKnownPayers(f, names, NOW);
  f.add('sep-in', 'ACH credit Payer One', 'Payer One', { date: '2026-09-10', cents: 10000 });
  f.add('oct-in', 'ACH credit Payer One', 'Payer One', { date: '2026-10-05', cents: 2500 });
  return f;
}

async function assertComplete(t, question, { amounts } = {}) {
  const f = registeredPayerFixture(t);
  const body = await f.ask(question);
  assert.equal(body.evidence_gate?.complete, true, `${question}: ${outcome(body)}`);
  assert.equal(body.ledger?.found, true, question);
  if (amounts) assert.deepEqual(body.citations.map(c => c.amount_minor), amounts, `${question}: citations`);
  return body;
}

// ---------------------------------------------------------------- R5-QUESTION-1
// Residual of Q13 (R3-QUESTION-3-7). The closed channel strip requires a
// clause boundary after the channel word, and that boundary list is built from
// the payer-terminal grammar (months, connectors, date words, arrival verbs).
// The question's own tail grammar is not in it: "yet", "please" and "and when"
// are consumed by the payment grammar itself (ledger-question.js:361-362), but
// after "via <channel>" they stop the strip. The unstripped closed channel then
// sits after a FROM clause, so the other-via refusal rejects the question at
// classification. The same question without the channel answers, and the same
// channel without the tail word answers; only the two together refuse.
// Partner answer 13 (verbatim): "Strip "via <channel>" for a closed list (ACH,
// Zelle, wire, check, Venmo, PayPal). Refuse other "via" phrases."
const channelThenTail = [
  'did the payment from Payer One arrive via Zelle yet?',
  'did the payment from Payer One arrive via ACH yet?',
  'did the payment from Payer One come in via wire yet?',
  'has the payment from Payer One arrived via Zelle yet?',
  'did the payment from Payer One arrive via Zelle please?',
  'did the payment from Payer One land via check please?',
  'did the payment from Payer One arrive via Venmo and when?',
];

test('R5-QUESTION-1 a closed-list channel followed by the question\'s own tail word ("yet", "please", "and when") is refused instead of stripped', async t => {
  for (const question of channelThenTail) {
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', `${question}: refused at classification (${describe(intent)})`);
    assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], `${question}: ${describe(intent)}`);
    await assertComplete(t, question, { amounts: [10000, 2500] });
  }
});

test('R5-QUESTION-1 control: the tail word alone, the channel alone, and the channel before a comma, an arrival verb or a period clause all answer; an unlisted channel before the tail still refuses', async t => {
  for (const question of [
    'did the payment from Payer One arrive yet?',
    'did the payment from Payer One arrive please?',
    'did the payment from Payer One arrive and when?',
    'did the payment from Payer One arrive via Zelle?',
    'did the payment from Payer One arrive via Zelle, yet?',
    'has the payment from Payer One via Zelle arrived yet?',
    'did the payment from Payer One arrive via Zelle in September 2026 yet?',
  ]) {
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', `${question}: ${describe(intent)}`);
    assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], `${question}: ${describe(intent)}`);
    await assertComplete(t, question);
  }
  for (const question of ['did the payment from Payer One arrive via Fixture Rail yet?', 'did the payment from Payer One arrive via ACH transfer yet?']) {
    assert.equal(classify(question).kind, null, `${question} is refused at classification`);
  }
});

// ---------------------------------------------------------------- R5-QUESTION-2
// Residual of Q9 (R3-QUESTION-3-2, R4-QUESTION-1). The slot classifier only
// counts a token as a payer word when it starts with a letter
// (ledger-question.js:610), and it tokenizes on [letters/digits]+ runs
// (:640). A digit-led ordinal ("2nd", "3rd", "10th") is therefore 'grammar'
// and a hyphenated word ("e-check", "pre-paid") is two payer words, so neither
// reaches the one-unlisted-word refusal at :713. The unlisted qualifier then
// becomes a second payer clause ([2nd, payer one]), or even the counterparty
// itself ("e-check"), and the registered unique payer is refused at the answer
// with "I can't confirm which payer you mean". The spelled-out forms of the
// same qualifiers ("second", "big", "pending") refuse at classification.
// Partner answer 9 (verbatim): "Strip a closed list of qualifiers before
// "payment": any, latest, last, recent, monthly, invoice, ACH, wire. Refuse any
// other qualifier at classification. A qualifier is never a second payer."
const tokenQualifier = [
  'did the 2nd payment from Payer One arrive?',
  'did the 3rd payment from Payer One arrive?',
  'did the 10th payment from Payer One arrive?',
  'did the 2nd payment of $25 from Payer One arrive?',
  'did the e-check payment from Payer One arrive?',
  'did the pre-paid payment from Payer One arrive?',
  "did Payer One's 2nd payment arrive?",
  "did Payer One's e-check payment arrive?",
];

test('R5-QUESTION-2 a digit-led or hyphenated unlisted qualifier before "payment" becomes a second payer clause instead of refusing at classification', async t => {
  for (const question of tokenQualifier) {
    const f = registeredPayerFixture(t);
    const intent = classify(question);
    const body = await f.ask(question);
    // Nothing is certified today either way; the defect is the class.
    assert.notEqual(body.evidence_gate?.complete, true, `${question}: ${outcome(body)}`);
    assert.equal(intent.kind, null, `${question}: an unlisted qualifier refuses at classification, it is never a second payer (${describe(intent)}; ${outcome(body)})`);
  }
});

test('R5-QUESTION-2 control: the spelled-out unlisted qualifiers refuse at classification, and the closed list is stripped', async t => {
  for (const question of ['did the second payment from Payer One arrive?', 'did the big payment from Payer One arrive?',
    'did the pending payment from Payer One arrive?', "did Payer One's second payment arrive?"]) {
    assert.equal(classify(question).kind, null, `${question} is refused at classification`);
  }
  for (const question of ['did the latest payment from Payer One arrive?', 'did the ACH payment from Payer One arrive?',
    "did Payer One's monthly payment arrive?"]) {
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', `${question}: ${describe(intent)}`);
    assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], `${question}: ${describe(intent)}`);
    await assertComplete(t, question, { amounts: [10000, 2500] });
  }
  const amount = classify('did the latest payment of $25 from Payer One arrive?');
  assert.equal(amount.kind, 'payment');
  assert.equal(amount.amountMinor, 2500);
  await assertComplete(t, 'did the latest payment of $25 from Payer One arrive?', { amounts: [2500] });
});

// ---------------------------------------------------------------- R5-QUESTION-3
// Residual of Q5 (R3-QUESTION-2-2, R4-QUESTION-4). The flip is stripped from
// anywhere, but only the phrase itself: the word that introduces it in a
// sentence ("with exact names only", "using exact names only") stays behind,
// no grammar consumes "with" or "using", and the whole question is refused at
// classification. The registered exact payer, whose rows are exact payee
// matches, is hidden behind a document-route refusal, while the bare phrase in
// the same position answers.
// Partner answer 5 (verbatim): "Support "exact names only" anywhere in the
// question: strip it and set exactNamesOnly=true."
const introducedFlip = [
  'did the payment from Payer One arrive with exact names only?',
  'did the payment from Payer One arrive, with exact names only?',
  'did the payment from Payer One arrive using exact names only?',
  'did the payment from Payer One arrive in September 2026 with exact names only?',
  'did the payment from Payer One arrive (with exact names only)?',
  'with exact names only, did the payment from Payer One arrive?',
];

test('R5-QUESTION-3 "with exact names only" and "using exact names only" are refused instead of stripped with the flag set', async t => {
  for (const question of introducedFlip) {
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', `${question}: refused at classification (${describe(intent)})`);
    assert.equal(intent.exactNamesOnly, true, `${question}: ${describe(intent)}`);
    assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], `${question}: ${describe(intent)}`);
    const body = await assertComplete(t, question);
    if (/September 2026/.test(question)) assert.equal(body.ledger.from, '2026-09-01', question);
  }
});

test('R5-QUESTION-3 control: the bare flip at the end, after a comma, in brackets, with a leading colon or mid-sentence is stripped and sets the flag', async t => {
  for (const question of [
    'did the payment from Payer One arrive exact names only?',
    'did the payment from Payer One arrive, exact names only?',
    'did the payment from Payer One (exact names only) arrive?',
    'exact names only: did the payment from Payer One arrive?',
    'did the payment from Payer One arrive, exact names only, in September 2026?',
  ]) {
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', `${question}: ${describe(intent)}`);
    assert.equal(intent.exactNamesOnly, true, `${question}: ${describe(intent)}`);
    assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], `${question}: ${describe(intent)}`);
    await assertComplete(t, question);
  }
});

// ---------------------------------------------------------------- R5-QUESTION-4
// The partner-answer rewrites (5, 9, 11, 13) run on the raw question text
// (ledger-question.js:666-670), while every grammar parse beneath them reads
// the NFKC-normalized, lower-cased text (:251, :380). A compatibility spelling
// of one grammar word ("ｖｉａ", "ｐａｙｍｅｎｔ", "ｆｒｏｍ", "ｅｘａｃｔ") is
// therefore invisible to the rewrite and visible to the grammar: the closed
// channel becomes a VIA payer clause, the closed qualifier becomes a second
// payer clause, the amount after the FROM name stays inside the name ("payer
// one of $25", no amount scope, the 60-day window, and a nonmatch on that
// artifact label with found=false while the exact $25 row exists), and the
// mid-sentence flip is refused. The ASCII spelling of each answers completely.
// Nothing is certified in the wrong direction; the class differs by spelling.
const compatibility = [
  { question: 'did the payment from Payer One arrive ｖｉａ Zelle?', ascii: 'did the payment from Payer One arrive via Zelle?', amounts: [10000, 2500] },
  { question: 'did the latest ｐａｙｍｅｎｔ from Payer One arrive?', ascii: 'did the latest payment from Payer One arrive?', amounts: [10000, 2500] },
  { question: 'did the payment ｆｒｏｍ Payer One of $25 arrive?', ascii: 'did the payment from Payer One of $25 arrive?', amounts: [2500], amount: 2500 },
  { question: 'did the payment from Payer One arrive, ｅｘａｃｔ names only, in September 2026?', ascii: 'did the payment from Payer One arrive, exact names only, in September 2026?', amounts: [10000], exact: true, from: '2026-09-01' },
];

test('R5-QUESTION-4 a compatibility spelling of "via", "payment", "from" or "exact" bypasses the answer-13/9/11/5 rewrites while the grammar still reads it', async t => {
  for (const { question, ascii, amounts, amount, exact, from } of compatibility) {
    const intent = classify(question), reference = classify(ascii);
    assert.equal(intent.kind, 'payment', `${question}: refused at classification (${describe(intent)})`);
    assert.deepEqual(intent.counterpartyWords, reference.counterpartyWords, `${question}: ${describe(intent)} vs ASCII ${describe(reference)}`);
    assert.equal(intent.counterparty, reference.counterparty, `${question}: ${describe(intent)}`);
    if (amount) assert.equal(intent.amountMinor, amount, `${question}: ${describe(intent)}`);
    if (exact) assert.equal(intent.exactNamesOnly, true, `${question}: ${describe(intent)}`);
    const body = await assertComplete(t, question, { amounts });
    if (from) assert.equal(body.ledger.from, from, question);
  }
});

// ---------------------------------------------------------------- R5-QUESTION-5
// Contract question (needs_contract_decision). Answer 9 refuses "any other
// qualifier at classification" and says "a qualifier is never a second
// payer", but it does not say how a two-word unlisted phrase before "payment"
// is told apart from a two-word noun payer. The round-4 slot rule keeps "two or
// more other words and no closed qualifier" as the established noun payer
// clause (ledger-question.js:689-701, :715-721), which the committed two-payer
// generator pins for "the <payer a> payment from <payer b>". So "direct
// deposit" and "bill pay" become a second payer clause beside Payer One and
// the registered unique payer is refused at the answer ("I can't confirm which
// payer you mean"), while "wire transfer" (closed word + other word) and "big"
// (one word) refuse at classification. Nothing is certified either way; the
// open question is which rule applies to a multi-word unlisted qualifier.
const phraseQualifier = [
  'did the direct deposit payment from Payer One arrive?',
  'did the bill pay payment from Payer One arrive?',
];

// Partner ruling 8 (round 7, verbatim): "(b): keep it as a second payer
// clause, refused at the answer. No registry check." The repro's option (a)
// expectation (kind null) is rewritten to option (b): the phrase stays the
// noun payer clause beside Payer One, and the answer refuses with "I can't
// confirm which payer you mean", lists the deposits and certifies nothing.
test('R5-QUESTION-5 (ruling 8 (b)) a two-word unlisted phrase before "payment from <payer>" stays a second payer clause refused at the answer, deposits listed', async t => {
  for (const question of phraseQualifier) {
    const f = registeredPayerFixture(t);
    const intent = classify(question);
    const phrase = question.match(/^did the (.+) payment from/)[1];
    assert.equal(intent.kind, 'payment', `${question}: ${describe(intent)}`);
    assert.deepEqual(intent.payerClauseSets?.map(set => set.map(clause => clause.label)), [[phrase, 'payer one']], `${question}: ${describe(intent)}`);
    const body = await f.ask(question);
    assert.equal(body.evidence_gate?.complete, false, `${question}: ${outcome(body)}`);
    assert.equal(body.ledger?.found, null, `${question}: ${outcome(body)}`);
    assert.equal(body.ledger?.payer_selector_ambiguous, true, `${question}: ${outcome(body)}`);
    assert.match(body.answer, /can't confirm which payer you mean/, question);
    assert.doesNotMatch(body.answer, /No matching|\$0\.00/, question);
    // "deposits listed": both of Payer One's deposits stay visible.
    assert.deepEqual(body.citations.map(c => c.amount_minor), [10000, 2500], `${question}: ${outcome(body)}`);
    // "No registry check": the classification does not depend on whether the
    // phrase is a registered name, and the answer still refuses.
    const registered = registeredPayerFixture(t, ['Payer One', 'Vendor Alpha', phrase.replace(/\b\w/g, c => c.toUpperCase())]);
    assert.deepEqual(classify(question).payerClauseSets?.map(set => set.map(clause => clause.label)), [[phrase, 'payer one']], question);
    const twoPayers = await registered.ask(question);
    assert.equal(twoPayers.evidence_gate?.complete, false, `${question}: ${outcome(twoPayers)}`);
    assert.equal(twoPayers.ledger?.found, null, `${question}: ${outcome(twoPayers)}`);
    assert.match(twoPayers.answer, /can't confirm which payer you mean/, question);
  }
});

test('R5-QUESTION-5 control: a closed qualifier beside another word and a one-word unlisted qualifier refuse at classification; two registered names stay a two-payer question refused at the answer', async t => {
  for (const question of ['did the wire transfer payment from Payer One arrive?', 'did the big payment from Payer One arrive?']) {
    assert.equal(classify(question).kind, null, `${question} is refused at classification`);
  }
  const question = 'did the Vendor Alpha payment from Payer One arrive?';
  const intent = classify(question);
  assert.equal(intent.kind, 'payment', `${question}: ${describe(intent)}`);
  assert.deepEqual(intent.payerClauseSets?.map(set => set.map(clause => clause.label)), [['vendor alpha', 'payer one']], `${question}: ${describe(intent)}`);
  const f = registeredPayerFixture(t);
  const body = await f.ask(question);
  assert.equal(body.evidence_gate?.complete, false, `${question}: ${outcome(body)}`);
  assert.equal(body.ledger?.found, null, `${question}: ${outcome(body)}`);
  assert.match(body.answer, /can't confirm which payer you mean/, question);
});

test('R5-QUESTION-4 control: the ASCII spellings answer, and compatibility spellings of words the base grammar reads itself are already normalized', async t => {
  for (const { ascii, amounts, amount, exact, from } of compatibility) {
    const intent = classify(ascii);
    assert.equal(intent.kind, 'payment', `${ascii}: ${describe(intent)}`);
    assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], `${ascii}: ${describe(intent)}`);
    if (amount) assert.equal(intent.amountMinor, amount, ascii);
    if (exact) assert.equal(intent.exactNamesOnly, true, ascii);
    const body = await assertComplete(t, ascii, { amounts });
    if (from) assert.equal(body.ledger.from, from, ascii);
  }
  // The base grammar normalizes: a trailing compatibility flip and a
  // compatibility auxiliary or arrival verb classify like their ASCII forms.
  for (const question of ['did the payment from Payer One arrive, ｅｘａｃｔ names only?', 'ｄｉｄ the payment from Payer One ａｒｒｉｖｅ?']) {
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', `${question}: ${describe(intent)}`);
    assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], `${question}: ${describe(intent)}`);
    await assertComplete(t, question, { amounts: [10000, 2500] });
  }
});
