// Partner review, packet 7 round 6 (question grammar / long questions / speed
// lens). Every name, amount and description here is synthetic. Each
// R6-QUESTION-<n> repro is expected to FAIL on the reviewed HEAD (fa93db5);
// each paired control is expected to PASS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { seedKnownPayers } from './ledger-known-payers-fixture.mjs';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';
import worker from '../src/index.js';

const now = Date.parse(NOW);
const classify = question => classifyLedgerQuestion(question, { now });
const describe = intent => `kind=${intent.kind} counterparty=${JSON.stringify(intent.counterparty)} words=${JSON.stringify(intent.counterpartyWords)} amount=${intent.amountMinor} window=${intent.from}..${intent.to} exactNamesOnly=${intent.exactNamesOnly} forPeriod=${intent.forPeriod}`;
const outcome = body => `route=${body.route || 'ledger'} code=${body.code} complete=${body.evidence_gate?.complete} found=${body.ledger?.found} gate=${body.evidence_gate?.reason} citations=${JSON.stringify((body.citations || []).map(c => c.amount_minor))}: ${body.answer}`;

// Two registered payers. Payer One paid $40 on 2026-08-20, $25 on
// 2026-09-05, $100 on 2026-09-10 and $25 on 2026-10-05, every row with the
// exact bank payer field "Payer One". September, this month (October) and
// the 30-day default window (2026-09-13..2026-10-12) each hold exactly one
// $25 deposit; the 60-day default window holds all four rows.
function registeredPayerFixture(t) {
  const f = ledgerFixture(t, { knownPayers: false });
  seedKnownPayers(f, ['Payer One', 'Vendor Alpha'], NOW);
  f.add('aug-in', 'ACH credit Payer One', 'Payer One', { date: '2026-08-20', cents: 4000 });
  f.add('sep-25', 'ACH credit Payer One', 'Payer One', { date: '2026-09-05', cents: 2500 });
  f.add('sep-in', 'ACH credit Payer One', 'Payer One', { date: '2026-09-10', cents: 10000 });
  f.add('oct-in', 'ACH credit Payer One', 'Payer One', { date: '2026-10-05', cents: 2500 });
  return f;
}

async function ask(t, question) {
  return registeredPayerFixture(t).ask(question);
}

async function assertExactDeposit(t, question, amounts) {
  const body = await ask(t, question);
  assert.equal(body.evidence_gate?.complete, true, `${question}: ${outcome(body)}`);
  assert.equal(body.ledger?.found, true, `${question}: ${outcome(body)}`);
  assert.deepEqual(body.citations.map(c => c.amount_minor), amounts, `${question}: ${outcome(body)}`);
  return body;
}

// ---------------------------------------------------------------- R6-QUESTION-1
// Partner answer 11 (verbatim): "Yes, "of $25", "for $25" and ", $25," after
// the FROM name are amount scope (amountMinor), answered like "payment of $25
// from Payer One"." Partner answer 13 (verbatim): "Strip "via <channel>" for
// a closed list (ACH, Zelle, wire, check, Venmo, PayPal)."
// The closed channel strip (channelPhrase, ledger-question.js:628) takes an
// optional comma BEFORE "via" into its match: `(?:\s*,)?\s+via\s+<channel>`.
// When the comma-delimited amount form precedes the channel, ", $25, via
// Zelle", that comma is the CLOSING comma of the ", $25," form. The strip
// removes it, the amount form no longer matches amountAfterName (:681), and
// the amount stays inside the FROM name: counterparty "payer one, $25",
// amountMinor null, and the default window widens from 30 to 60 days. The
// registered exact payer with an exact $25 row is then answered as a cleanup
// "possible match" (or, in a month window without a $25 row of that reading,
// as an "unmatched" refusal with found=false) instead of the confirmed deposit.
const commaAmountThenChannel = [
  'did the payment from Payer One, $25, via Zelle arrive?',
  'did the payment from Payer One, $25, via ACH arrive?',
  'has the payment from Payer One, $25, via Zelle arrived yet?',
  'did the payment from Payer One, $25, via Zelle arrive in September 2026?',
];

test('R6-QUESTION-1 a comma-delimited amount followed by a closed-list channel (", $25, via Zelle") keeps the amount inside the FROM name and widens the window', async t => {
  for (const question of commaAmountThenChannel) {
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', `${question}: ${describe(intent)}`);
    assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], `${question}: ${describe(intent)}`);
    assert.equal(intent.amountMinor, 2500, `${question}: ${describe(intent)}`);
    // Triage decided_expected: the 30-day amount default, or the named month.
    const september = /September 2026/.test(question);
    assert.equal(intent.from, september ? '2026-09-01' : '2026-09-13', `${question}: ${describe(intent)}`);
    assert.equal(intent.to, september ? '2026-09-30' : '2026-10-12', `${question}: ${describe(intent)}`);
    await assertExactDeposit(t, question, [2500]);
  }
});

test('R6-QUESTION-1 control: the same amount form before the arrival verb, after the channel, or alone, and the channel without the amount all answer the exact deposit', async t => {
  for (const question of [
    'did the payment from Payer One, $25, arrive via Zelle?',
    'did the payment from Payer One via Zelle, $25, arrive?',
    'did the payment from Payer One, $25, arrive?',
    'did the payment from Payer One via Zelle, $25, arrive in September 2026?',
    'did the payment from Payer One of $25, via Zelle, arrive?',
  ]) {
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', `${question}: ${describe(intent)}`);
    assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], `${question}: ${describe(intent)}`);
    assert.equal(intent.amountMinor, 2500, `${question}: ${describe(intent)}`);
    await assertExactDeposit(t, question, [2500]);
  }
  const channelOnly = await ask(t, 'did the payment from Payer One via Zelle arrive?');
  assert.equal(channelOnly.evidence_gate?.complete, true, outcome(channelOnly));
  assert.deepEqual(channelOnly.citations.map(c => c.amount_minor), [4000, 2500, 10000, 2500], outcome(channelOnly));
});

// ---------------------------------------------------------------- R6-QUESTION-2
// Partner answer 11 again. amountAfterName (ledger-question.js:681-682)
// accepts "of $25" after the FROM name only when the amount is followed by
// punctuation, the end, an arrival verb or one of in/on/into/to/during/over/
// before/after/between/yet/and. The relative period words the window grammar
// reads ("last month", "this month") are not in that lookahead, so "did the
// payment from Payer One of $25 last month arrive?" is not rewritten. The
// literal-name enumeration (:831-835) then admits "payer one of $25 last
// month" as the FROM name (its cleaned reading refuses), the amount and the
// period both vanish into the name, the window widens from the named month to
// the 60-day default, and the answer is the "unmatched" refusal "No matching
// transactions were found for ..." with found=false, hiding the registered
// payer's $25 deposit in that month. The same question with the amount before
// the name, or with the period after the arrival verb, finds it.
const amountThenRelativePeriod = [
  'did the payment from Payer One of $25 last month arrive?',
  'did the payment from Payer One for $25 last month arrive?',
  'did the payment from Payer One of $25 this month arrive?',
];

test('R6-QUESTION-2 "of $25" after the FROM name followed by a relative period ("last month", "this month") folds amount and period into the name and hides the exact deposit', async t => {
  for (const question of amountThenRelativePeriod) {
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', `${question}: ${describe(intent)}`);
    assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], `${question}: ${describe(intent)}`);
    assert.equal(intent.amountMinor, 2500, `${question}: ${describe(intent)}`);
    assert.equal(intent.from, /last month/.test(question) ? '2026-09-01' : '2026-10-01', `${question}: ${describe(intent)}`);
    // Triage decided_expected: the named relative month is the whole window.
    assert.equal(intent.to, /last month/.test(question) ? '2026-09-30' : '2026-10-12', `${question}: ${describe(intent)}`);
    const body = await assertExactDeposit(t, question, [2500]);
    assert.doesNotMatch(String(body.answer), /No matching transactions were found/, `${question}: ${outcome(body)}`);
  }
});

test('R6-QUESTION-2 control: the amount before the name, the period after the arrival verb, and a named month after the amount all find the exact deposit', async t => {
  for (const [question, from] of [
    ['did the payment of $25 from Payer One arrive last month?', '2026-09-01'],
    ['did the payment from Payer One of $25 arrive last month?', '2026-09-01'],
    ['did the payment of $25 from Payer One arrive this month?', '2026-10-01'],
    ['did the payment from Payer One of $25 in September 2026 arrive?', '2026-09-01'],
    ['did the payment from Payer One of $25 arrive in the last 30 days?', '2026-09-13'],
  ]) {
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', `${question}: ${describe(intent)}`);
    assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], `${question}: ${describe(intent)}`);
    assert.equal(intent.amountMinor, 2500, `${question}: ${describe(intent)}`);
    assert.equal(intent.from, from, `${question}: ${describe(intent)}`);
    await assertExactDeposit(t, question, [2500]);
  }
});

// ---------------------------------------------------------------- R6-QUESTION-3
// Contract (verbatim): "Anything matched by cleanup, a shortened name, a
// substring or shorthand is a "possible match" with a partial subtotal and a
// visible note." the partner's principle (verbatim): "when in doubt, the answer is
// never complete, never zero and never absence, and the useful part stays
// visible."
// An amount phrase after the FROM name that is not one of answer 11's three
// closed forms ("of about $25", "around $25", "of roughly $25", "totaling
// $25", "worth $25", "of $25 approx") is admitted as the literal FROM name by
// the literal-name enumeration (ledger-question.js:831-835). Its cleaned
// reading ("payer one of about") refuses, so chooseLiteralSelector has no
// alternate rows, `possible` is empty, and :402 returns the "unmatched"
// refusal: "No matching transactions were found for [redacted] ... in the
// covered accounts", found=false, no citations. The registered payer "Payer
// One" is a whole-word prefix of that label, the same relation that makes
// "Payer One Holdings" list every Payer One deposit as a candidate (control),
// yet here the deposits are hidden behind an absence-shaped refusal.
const unlistedAmountPhrase = [
  'did the payment from Payer One of about $25 arrive?',
  'did the payment from Payer One around $25 arrive?',
  'did the payment from Payer One of roughly $25 arrive?',
  'did the payment from Payer One totaling $25 arrive?',
  'did the payment from Payer One worth $25 arrive?',
  'did the payment from Payer One of $25 approx arrive?',
];

test('R6-QUESTION-3 an unlisted amount phrase after the FROM name becomes an absence-shaped "No matching transactions" refusal that hides the registered prefix payer\'s deposits', async t => {
  for (const question of unlistedAmountPhrase) {
    const body = await ask(t, question);
    assert.notEqual(body.evidence_gate?.complete, true, `${question}: ${outcome(body)}`);
    assert.notEqual(body.ledger?.found, false, `${question}: absence-shaped (${outcome(body)})`);
    assert.doesNotMatch(String(body.answer), /No matching transactions were found/, `${question}: ${outcome(body)}`);
    assert.ok(body.citations.length >= 1, `${question}: the Payer One deposits are hidden (${outcome(body)})`);
    // Triage decided_expected: neither presence nor absence, no total, every
    // in-window Payer One deposit cited (60-day window), with a visible
    // name-similarity or candidate note.
    assert.equal(body.ledger?.found ?? null, null, `${question}: ${outcome(body)}`);
    assert.equal(body.ledger?.total_minor ?? null, null, `${question}: ${outcome(body)}`);
    assert.deepEqual(body.citations.map(c => c.amount_minor).sort((a, b) => a - b), [2500, 2500, 4000, 10000], `${question}: ${outcome(body)}`);
    assert.match(String(body.answer), /name similarity|Candidate payer readings|Possible match|Unattributed deposit/, `${question}: ${outcome(body)}`);
  }
});

test('R6-QUESTION-3 control: a plain suffix after the registered name lists every deposit as a candidate, and the closed "of $25" form answers the exact deposit', async t => {
  const suffix = await ask(t, 'did the payment from Payer One Holdings arrive?');
  assert.notEqual(suffix.evidence_gate?.complete, true, outcome(suffix));
  assert.notEqual(suffix.ledger?.found, false, outcome(suffix));
  assert.doesNotMatch(String(suffix.answer), /No matching transactions were found/, outcome(suffix));
  assert.deepEqual(suffix.citations.map(c => c.amount_minor).sort((a, b) => a - b), [2500, 2500, 4000, 10000], outcome(suffix));
  await assertExactDeposit(t, 'did the payment from Payer One of $25 arrive?', [2500]);
});

// ---------------------------------------------------------------- R6-QUESTION-4
// Contract (verbatim): "Failed retrieval of any kind leaves the answer
// incomplete." withLedgerAnswer catches every thrown ledger read
// (ledger-answer.js:973-974) as the gap "ledger_unavailable" and hands it to
// the document path. handleDocumentThink only prepends that gap
// (index.js:1038-1042); the completeness demotion added for failed retrieval
// keys on `retrievalFailed(degraded, degradedReason)` alone (index.js:1661),
// which never sees the ledger failure. A payment question whose bank ledger
// read threw is therefore answered from documents with evidence_gate
// complete=true, while the same documents with the ledger deliberately
// absent (no accounts, not a failure) are the control.
const record = { chunk_uid: 'drive:fixture#0', doc_uid: 'drive:fixture', source: 'drive', source_id: 'fixture', title: 'Synthetic record',
  text: 'Payer One wrote on 2026-10-05 that the payment was sent.', document_date: Date.parse('2026-10-05T00:00:00.000Z'),
  date_source: 'fixture:date', date_reliable: 1, text_source: 'native', text_reliable: 1 };
function thinkEnv({ ledgerThrows }) {
  const seen = [];
  const env = { STORAGE: 'd1', ADMIN_KEY: 'k', DB: { prepare(sql) { return {
    bind() { return this; },
    all: async () => {
      if (/a\.account_slug/.test(sql)) { seen.push('accounts'); if (ledgerThrows) throw new Error('synthetic: ledger unavailable'); return { results: [] }; }
      if (/FROM sources s/.test(sql)) return { results: [] };
      if (/chunks_fts MATCH/.test(sql)) { seen.push('keyword'); return { results: [record] }; }
      return { results: [] };
    },
    first: async () => {
      if (/proportional-projection-backlog/.test(sql)) return { n: 0 };
      if (/vector_projection_mutation_id AS mutation_id/.test(sql)) return { schema_version: 12, mutation_id: null, mutation_submitted_at: null,
        projection_status: 'verified', bootstrap_epoch: 0, bootstrap_cursor: null, bootstrap_high_water: null, expected_vectors: 1, live_vectors: 1, pending: 0, submitted: 0, oldest_queued_at: null };
      if (/FROM vector_outbox/.test(sql) && /submitted_mutation_id/.test(sql)) return { n: 0, oldest: null, upserts: 0, deletes: 0, submitted: 0 };
      return /count\(\*\)/i.test(sql) ? { n: 0, stored_documents: 0, logical_documents: 0 } : null;
    },
    run: async () => ({}),
  }; }, batch: async () => { throw new Error('synthetic: batch unavailable'); } },
  VECTORIZE: { query: async () => ({ matches: [{ id: record.chunk_uid }] }), upsert: async () => {}, describe: async () => ({ vectorCount: 1, processedUpToMutation: null }) },
  AI: { run: async (model, input) => {
    if (model.includes('bge-')) return { data: [[0.1, 0.2, 0.3]] };
    const system = String(input?.messages?.[0]?.content || '');
    if (/verify a proposed answer/.test(system)) return { response: { supported: true, complete: true, evidence: [1], reason: 'direct support' }, usage: {} };
    return { response: 'The record says the payment was sent on 2026-10-05 [1].', usage: { prompt_tokens: 1, completion_tokens: 1 } };
  } } };
  env.seen = seen;
  return env;
}
async function think(env, q) {
  const res = await worker.fetch(new Request('https://brain.invalid/api/rag/think', { method: 'POST',
    headers: { 'X-Admin-Key': 'k', 'Content-Type': 'application/json' }, body: JSON.stringify({ q, limit: 8 }) }),
  env, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(res.status, 200);
  return res.json();
}

test('R6-QUESTION-4 a thrown bank ledger read is attached as "ledger_unavailable" but the document answer to the payment question is still certified complete', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  const env = thinkEnv({ ledgerThrows: true });
  const body = await think(env, 'did the payment from Payer One arrive?');
  assert.deepEqual(env.seen, ['accounts', 'keyword'], 'the ledger read was attempted before the document search');
  assert.equal(body.gaps?.[0]?.reason, 'ledger_unavailable', JSON.stringify(body.gaps));
  assert.equal(body.degraded, undefined, `document retrieval itself was healthy: ${body.degraded}/${body.degraded_reason}`);
  assert.equal(body.evidence_gate?.supported, true, JSON.stringify(body.evidence_gate));
  assert.equal(body.evidence_gate?.complete, false, `failed ledger retrieval certified complete: ${JSON.stringify(body.evidence_gate)}`);
  // Triage decided_expected: partial, with a reason naming the ledger failure.
  assert.equal(body.evidence_gate?.partial, true, JSON.stringify(body.evidence_gate));
  assert.match(String(body.evidence_gate?.reason), /ledger/, JSON.stringify(body.evidence_gate));
});

test('R6-QUESTION-4 control: the same documents with no bank accounts (a deliberate absence, not a failure) keep the verifier\'s complete verdict, and a healthy ledger answers the question itself', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  const env = thinkEnv({ ledgerThrows: false });
  const body = await think(env, 'did the payment from Payer One arrive?');
  assert.deepEqual(env.seen, ['accounts', 'keyword']);
  assert.equal(body.gaps?.[0]?.reason, 'no_accounts', JSON.stringify(body.gaps));
  assert.equal(body.evidence_gate?.complete, true, JSON.stringify(body.evidence_gate));
  const ledger = await ask(t, 'did the payment from Payer One arrive?');
  assert.equal(ledger.evidence_gate?.complete, true, outcome(ledger));
  assert.equal(ledger.ledger?.found, true, outcome(ledger));
});

// ---------------------------------------------------------------- R6-QUESTION-5
// Partner answer 9 (verbatim): "Strip a closed list of qualifiers before
// "payment": any, latest, last, recent, monthly, invoice, ACH, wire."
// Round 5 strips a closed qualifier that leads a noun payer slot ("the latest
// Payer One payment", R4-FIDELITY-3) and keeps the unstripped reading beside
// it. The possessive branch of the same rewrite (ledger-question.js:737-738)
// starts the slot AFTER the possessive, so "the latest Payer One's payment"
// never reaches paymentSlot: the qualifier stays in the name, counterparty
// "latest payer one", and the registered unique payer is refused as "I can't
// confirm which payer you mean" while the possessive with the qualifier
// after it ("Payer One's latest payment") and the bare noun form answer.
test('R6-QUESTION-5 a closed qualifier before a possessive noun payer ("the latest Payer One\'s payment") stays in the payer name and refuses the registered payer', async t => {
  for (const question of [
    "did the latest Payer One's payment arrive?",
    "did the last Payer One's payment arrive?",
    "has the monthly Payer One's payment arrived?",
  ]) {
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', `${question}: ${describe(intent)}`);
    assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], `${question}: ${describe(intent)}`);
    await assertExactDeposit(t, question, [4000, 2500, 10000, 2500]);
  }
});

test('R6-QUESTION-5 control: the qualifier after the possessive, the qualifier before the bare noun payer, and the plain possessive all answer completely', async t => {
  for (const question of [
    "did Payer One's latest payment arrive?",
    'did the latest Payer One payment arrive?',
    "did Payer One's payment arrive?",
  ]) {
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', `${question}: ${describe(intent)}`);
    assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], `${question}: ${describe(intent)}`);
    await assertExactDeposit(t, question, [4000, 2500, 10000, 2500]);
  }
});

// ---------------------------------------------------------------- R6-QUESTION-6
// Filed as a contract question; triage decided it under answer 10 as a bug:
// the silent route is ruled out, and for a bare month the note asks for the
// year instead of guessing one. Partner answer 10 (verbatim):
// "Refuse "for <period>" in the payment grammar, with a short note asking
// whether they mean "received in <period>". Never certify absence on it."
// A bare month is a period the window grammar reads, but the payment grammar
// refuses a bare month before the answer-10 note is reached
// (ledger-question.js:342 returns before :339's forPeriod is consumed), so
// "did the payment from Payer One for September arrive?" is routed to
// documents silently (kind=null, no code, no note), while "for September
// 2026" gets the payment_period_ambiguous note. The note's own suggestion
// ("received in September") would itself be refused silently, so the
// contract has to say whether the note fires here, asks for a year, or the
// silent document route stands.
test('R6-QUESTION-6 "for <bare month>" after a payment is routed to documents silently instead of the answer-10 note', async t => {
  for (const question of [
    'did the payment from Payer One for September arrive?',
    'did the payment from Payer One arrive for September?',
  ]) {
    const intent = classify(question);
    const body = await ask(t, question);
    assert.equal(body.code, 'payment_period_ambiguous', `${question}: ${describe(intent)}; ${outcome(body)}`);
    assert.equal(body.gaps?.[0]?.code, 'payment_period_ambiguous', `${question}: ${outcome(body)}`);
    // Triage decided_expected: a refusal with answer 10's note; no total, no
    // presence or absence; for a bare month the note asks for the year and
    // never guesses one.
    assert.equal(body.evidence_gate?.supported, false, `${question}: ${outcome(body)}`);
    assert.equal(body.evidence_gate?.complete, false, `${question}: ${outcome(body)}`);
    assert.equal(body.answer, null, `${question}: ${outcome(body)}`);
    assert.equal(body.ledger, undefined, `${question}: ${outcome(body)}`);
    const detail = String(body.gaps?.[0]?.detail);
    assert.match(detail, /"for september" can name the period a payment covers, not when it arrived/, detail);
    assert.match(detail, /Did you mean "received in september <year>"\?/, detail);
    assert.match(detail, /Nothing is confirmed present or absent\./, detail);
    assert.doesNotMatch(detail, /\b\d{4}\b/, `${question}: the note guesses a year: ${detail}`);
  }
  // The bare arrival month without "for" keeps its existing route.
  assert.equal(classify('did the payment from Payer One arrive in September?').kind, null);
});

test('R6-QUESTION-6 control: "for <month year>", "for <quarter>" and "for last month" refuse with the answer-10 note and never certify absence', async t => {
  for (const [question, suggestion] of [
    ['did the payment from Payer One for September 2026 arrive?', 'received in september 2026'],
    ['did the payment from Payer One for Q3 2026 arrive?', 'received in q3 2026'],
    ['did the payment from Payer One for last month arrive?', 'received last month'],
  ]) {
    const body = await ask(t, question);
    assert.equal(body.code, 'payment_period_ambiguous', `${question}: ${outcome(body)}`);
    assert.equal(body.evidence_gate?.complete, false, `${question}: ${outcome(body)}`);
    assert.match(String(body.gaps?.[0]?.detail), new RegExp(`Did you mean "${suggestion}"`), `${question}: ${JSON.stringify(body.gaps)}`);
  }
});
