// Partner review, packet 7 round 3 (question grammar / long questions / speed
// lens). Every name, amount and description here is synthetic. Each
// R3-QUESTION-3-<n> repro is expected to FAIL on the reviewed HEAD (e6f1ca2);
// each paired control is expected to PASS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, fixture, NOW } from './ledger-review-fixture.mjs';
import { seedKnownPayers } from './ledger-known-payers-fixture.mjs';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';
import { search, retrievalFailed } from '../src/lib/store-d1.js';

const now = Date.parse(NOW);
const classify = question => classifyLedgerQuestion(question, { now });
const selectorOf = intent => intent.kind === 'payment' ? intent.counterparty : intent.match;

// Two registered payers; Payer One paid $100 on 2026-09-10 and $25 on 2026-10-05.
function registeredPayerFixture(t, { octoberOnly = false } = {}) {
  const f = ledgerFixture(t, { knownPayers: false });
  seedKnownPayers(f, ['Payer One', 'Vendor Alpha'], NOW);
  if (!octoberOnly) f.add('sep-in', 'ACH credit Payer One', 'Payer One', { date: '2026-09-10', cents: 10000 });
  f.add('oct-in', 'ACH credit Payer One', 'Payer One', { date: '2026-10-05', cents: 2500 });
  return f;
}

// ---------------------------------------------------------------- R3-QUESTION-3-1
// Sibling of R3-QUESTION-2-1. The round-2 fix rejects a payer label that
// contains a CONNECTOR-introduced period clause (labelPeriodClause requires
// "in|during|for|over|..."). A first period written without a connector, or
// after a comma, still passes the label filter: "payer one september 2026
// and" becomes the payer label, the remaining text parses with the second
// period only, and the ledger is read for October alone. The plain grammar
// refuses the same two periods when nothing protects the first one.
const bareTwoPeriod = [
  'how much income from Payer One September 2026 and October 2026?',
  'how much income from Payer One, September 2026 and October 2026?',
  'did the payment from Payer One September 2026 and October 2026 arrive?',
];

test('R3-QUESTION-3-1 a two-period question whose first period has no connector is narrowed to the last period with the first period inside the payer label', async t => {
  for (const question of bareTwoPeriod) {
    const f = registeredPayerFixture(t);
    const intent = classify(question);
    const body = await f.ask(question);
    if (body.route !== 'documents') {
      assert.notEqual(body.ledger?.from, '2026-10-01',
        `${question}: asked about September and October, answered for ${body.ledger?.from}..${body.ledger?.to} with selector ${JSON.stringify(selectorOf(intent))}: ${body.answer}`);
      assert.doesNotMatch(body.answer || '', /between 2026-10-01 and 2026-10-12/, question);
    }
    assert.equal(intent.kind, null, `${question}: routed as ${intent.kind} ${intent.from}..${intent.to} with selector ${JSON.stringify(selectorOf(intent))}`);
  }
});

test('R3-QUESTION-3-1 control: connector-introduced two-period wordings refuse, and one bare month after the name answers September completely', async t => {
  for (const question of [
    'how much income from Payer One in September 2026 and October 2026?',
    'how much income from Payer One in September 2026 and in October 2026?',
    'how much income from Payer One during September 2026 and October 2026?',
    'did the payment from Payer One in September 2026 and October 2026 arrive?',
    'did the payment from Payer One arrive in September 2026 and October 2026?',
  ]) assert.equal(classify(question).kind, null, `${question} is refused`);
  const f = registeredPayerFixture(t);
  const one = await f.ask('how much income from Payer One in September 2026?');
  assert.equal(one.ledger?.kind, 'merchant');
  assert.equal(one.ledger.from, '2026-09-01');
  assert.equal(one.ledger.to, '2026-09-30');
  assert.equal(one.evidence_gate.complete, true);
  assert.equal(one.ledger.total_minor, 10000);
});

// ---------------------------------------------------------------- R3-QUESTION-3-2
// Contract question (needs_contract_decision). A qualifier before "payment"
// ("any", "latest", "monthly", "invoice", "ACH", "wire", "big") is read by
// paymentParties as a noun-form payer and by the noun/FROM bridge as a second
// payer clause. The selector is still "payer one", but the clause set
// [qualifier, payer one] needs full registry coverage, the qualifier matches
// nothing, resolveRequestedPayer returns "unresolved", and the registered
// unique payer is refused with "I can't confirm which payer you mean ...
// Candidate payer readings: <masked Payer One>". Other qualifiers ("second",
// "bank", "client", a bare month) are refused at classification instead, so
// the same registered payer gets three different outcomes for one wording.
const qualifiedPayment = [
  'did any payment from Payer One arrive?',
  'did the latest payment from Payer One arrive?',
  'did the monthly payment from Payer One arrive?',
  'did the invoice payment from Payer One arrive?',
  'did the ACH payment from Payer One arrive?',
  'did the wire payment from Payer One arrive?',
  'did the big payment from Payer One arrive?',
];

// Partner answer 9 (verbatim): "Strip a closed list of qualifiers before
// "payment": any, latest, last, recent, monthly, invoice, ACH, wire. Refuse any
// other qualifier at classification. A qualifier is never a second payer."
test('R3-QUESTION-3-2 a qualifier before "payment" is read as a second payer clause and a registered unique FROM payer is refused as unconfirmed', async t => {
  for (const question of [...qualifiedPayment, 'did the last payment from Payer One arrive?']) {
    const f = registeredPayerFixture(t);
    const intent = classify(question);
    const body = await f.ask(question);
    assert.ok(intent.kind === null || (body.route !== 'documents' && body.evidence_gate?.complete === true && body.ledger?.found === true),
      `${question}: classified as ${intent.kind} selector ${JSON.stringify(intent.counterparty)} words ${JSON.stringify(intent.counterpartyWords)}, answered complete=${body.evidence_gate?.complete} found=${body.ledger?.found}: ${body.answer}`);
    if (/\b(?:big)\b/.test(question)) assert.equal(intent.kind, null, `${question}: an unlisted qualifier refuses at classification`);
    else {
      assert.equal(intent.kind, 'payment', `${question}: a listed qualifier is stripped`);
      assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], `${question}: the qualifier is never a second payer`);
    }
  }
});

test('R3-QUESTION-3-2 control: the plain, dated and amount-qualified forms answer completely; ordinal and generic qualifiers refuse at classification', async t => {
  for (const question of [
    'did the payment from Payer One arrive?',
    'did the October 2026 payment from Payer One arrive?',
    'did the $25 payment from Payer One arrive?',
  ]) {
    const f = registeredPayerFixture(t);
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', question);
    assert.equal(intent.counterparty, 'payer one', question);
    assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], question);
    const body = await f.ask(question);
    assert.equal(body.evidence_gate?.complete, true, `${question}: ${body.answer}`);
    assert.equal(body.ledger?.found, true, question);
  }
  for (const question of [
    'did the second payment from Payer One arrive?',
    'did the bank payment from Payer One arrive?',
    'did the client payment from Payer One arrive?',
  ]) assert.equal(classify(question).kind, null, `${question} is refused at classification`);
});

// ---------------------------------------------------------------- R3-QUESTION-3-3
// Sibling of R3-QUESTION-2-3. possessiveDate admits only absolute dates and
// periods (ISO, slash, month [day] [year], quarter) between the noun
// possessive and "payment". A relative period in that slot ("recent", "last
// month", "this month", "last 30 days", "so far this year") is still consumed
// as the question's window, but the 's stays inside the payer label, the
// counterparty becomes "payer one's", and the registered payer is refused.
// The same relative period after "arrive" answers completely.
const relativeNoun = [
  // Partner answer 9 lists "recent" among the qualifiers stripped before
  // "payment" (round 4, R4-FIDELITY-1): the window is the default 60 days.
  ["did Payer One's recent payment arrive?", '2026-08-14', '2026-10-12'],
  ["did Payer One's last month payment arrive?", '2026-09-01', '2026-09-30'],
  ["did Payer One's this month payment arrive?", '2026-10-01', '2026-10-12'],
  ["did Payer One's last 30 days payment arrive?", '2026-09-13', '2026-10-12'],
  ["did Payer One's so far this year payment arrive?", '2026-01-01', '2026-10-12'],
];

test("R3-QUESTION-3-3 a relative period between the noun possessive and \"payment\" keeps 's inside the payer name", async t => {
  for (const [question, from, to] of relativeNoun) {
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', question);
    assert.equal(intent.from, from, question);
    assert.equal(intent.to, to, question);
    assert.equal(intent.counterparty, 'payer one', `${question}: counterparty ${JSON.stringify(intent.counterparty)} words ${JSON.stringify(intent.counterpartyWords)}`);
  }
  const f = registeredPayerFixture(t);
  const body = await f.ask(relativeNoun[0][0]);
  assert.equal(body.evidence_gate?.complete, true, `registered payer, exact payee row inside the 14-day window: ${body.answer}`);
  assert.equal(body.ledger?.found, true);
});

test('R3-QUESTION-3-3 control: the same relative periods after "arrive", the FROM word order, and an absolute date in the possessive slot answer', async t => {
  for (const [question, from, to] of [
    ["did Payer One's payment arrive last month?", '2026-09-01', '2026-09-30'],
    ["did Payer One's payment arrive this month?", '2026-10-01', '2026-10-12'],
    ["did Payer One's payment arrive in the last 30 days?", '2026-09-13', '2026-10-12'],
    // Answer 9 strips "recent" before "payment" (R4-FIDELITY-1): default window.
    ['did the recent payment from Payer One arrive?', '2026-08-14', '2026-10-12'],
    ["did Payer One's October 5 payment arrive?", '2026-09-28', '2026-10-12'],
  ]) {
    const f = registeredPayerFixture(t);
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', question);
    assert.equal(intent.counterparty, 'payer one', question);
    assert.equal(intent.from, from, question);
    assert.equal(intent.to, to, question);
    const body = await f.ask(question);
    assert.equal(body.evidence_gate?.complete, true, `${question}: ${body.answer}`);
    assert.equal(body.ledger?.found, true, question);
  }
});

// ---------------------------------------------------------------- R3-QUESTION-3-4
// Contract question (needs_contract_decision). questionPeriod treats "for
// <period>" exactly like "in <period>": the clause between the FROM name and
// "arrive" becomes the ARRIVAL window. In ordinary use "the payment from
// Payer One for September 2026" names the invoice period, and that payment
// often posts the following month. With the September payment posted
// 2026-10-05 the answer certifies a complete absence for September. The
// possessive form of the same wording ("Payer One's payment for September
// 2026") is refused instead, so the two forms disagree.
const invoicePeriod = [
  'did the payment from Payer One for September 2026 arrive?',
  'did the payment from Payer One for Q3 2026 arrive?',
  'did the payment from Payer One for last month arrive?',
];

// Partner answer 10 (verbatim): "Refuse "for <period>" in the payment grammar,
// with a short note asking whether they mean "received in <period>". Never
// certify absence on it."
test('R3-QUESTION-3-4 "for <period>" between the payer name and "arrive" is read as the arrival window and certifies a complete absence', async t => {
  for (const [question, received] of [
    [invoicePeriod[0], 'received in september 2026'],
    [invoicePeriod[1], 'received in q3 2026'],
    [invoicePeriod[2], 'received last month'],
  ]) {
    const f = registeredPayerFixture(t, { octoberOnly: true });
    const body = await f.ask(question);
    assert.ok(!(body.evidence_gate?.complete === true && body.ledger?.found === false),
      `${question}: certified absence for ${body.ledger?.from}..${body.ledger?.to} although the payment posted 2026-10-05: ${body.answer}`);
    assert.equal(body.code, 'payment_period_ambiguous', question);
    assert.equal(body.evidence_gate?.complete, false, question);
    assert.equal(body.ledger, undefined, `${question}: no presence or absence is read`);
    assert.ok(body.gaps?.some(gap => gap.detail.includes(`Did you mean "${received}"?`)), `${question}: ${JSON.stringify(body.gaps)}`);
  }
});

test('R3-QUESTION-3-4 control: an explicit "arrive in <period>" window certifies absence or presence for that window', async t => {
  const f = registeredPayerFixture(t, { octoberOnly: true });
  const absent = await f.ask('did the payment from Payer One arrive in September 2026?');
  assert.equal(absent.ledger?.kind, 'payment');
  assert.equal(absent.ledger.from, '2026-09-01');
  assert.equal(absent.ledger.to, '2026-09-30');
  assert.equal(absent.evidence_gate.complete, true);
  assert.equal(absent.ledger.found, false);
  const present = await f.ask('did the payment from Payer One arrive in October 2026?');
  assert.equal(present.evidence_gate.complete, true);
  assert.equal(present.ledger.found, true);
  assert.ok(present.citations.some(c => c.posted_on === '2026-10-05' && c.amount_minor === 2500));
});

// ---------------------------------------------------------------- R3-QUESTION-3-5
// Contract question (needs_contract_decision). An amount placed after the
// FROM name with a preposition or commas ("from Payer One of $25", "for $25",
// ", $25,") is swallowed into the payer label: the RAW reading has no amount
// and the 60-day window, the CLEANED reading keeps a dangling connector or
// comma ("payer one of", "payer one,") so it is not a usable alternative
// either, and the answer is "No matching transactions were found for
// [redacted] ****of25" with found=false. The same amount before the name or
// after "payment of" answers completely, and a bare "$25" after the name is
// at least a possible match.
const amountAfterName = [
  'did the payment from Payer One of $25 arrive?',
  'did the payment from Payer One for $25 arrive?',
  'did the payment from Payer One, $25, arrive?',
];

// Partner answer 11 (verbatim): "Yes, "of $25", "for $25" and ", $25," after
// the FROM name are amount scope (amountMinor), answered like "payment of $25
// from Payer One"."
test('R3-QUESTION-3-5 an amount after the FROM name with a preposition is swallowed into the payer label and the registered payer reports no match', async t => {
  for (const question of amountAfterName) {
    const f = registeredPayerFixture(t);
    const intent = classify(question);
    const body = await f.ask(question);
    assert.ok(intent.kind === null || (intent.amountMinor === 2500 && body.ledger?.found !== false),
      `${question}: selector ${JSON.stringify(intent.counterparty)} amount ${intent.amountMinor} window ${intent.from}..${intent.to}; answered found=${body.ledger?.found} complete=${body.evidence_gate?.complete}: ${body.answer}`);
    assert.equal(intent.kind, 'payment', question);
    assert.equal(intent.counterparty, 'payer one', question);
    assert.equal(intent.amountMinor, 2500, question);
    assert.equal(intent.from, '2026-09-13', question);
    assert.equal(body.evidence_gate?.complete, true, `${question}: ${body.answer}`);
    assert.equal(body.ledger?.found, true, question);
    assert.ok(body.citations.some(c => c.amount_minor === 2500), question);
  }
});

test('R3-QUESTION-3-5 control: the amount before the name or after "payment of" answers; a bare amount after the name is a possible match', async t => {
  for (const question of ['did the payment of $25 from Payer One arrive?', 'did the $25 payment from Payer One arrive?']) {
    const f = registeredPayerFixture(t);
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', question);
    assert.equal(intent.counterparty, 'payer one', question);
    assert.equal(intent.amountMinor, 2500, question);
    assert.equal(intent.from, '2026-09-13', question);
    const body = await f.ask(question);
    assert.equal(body.evidence_gate?.complete, true, `${question}: ${body.answer}`);
    assert.equal(body.ledger?.found, true, question);
    assert.ok(body.citations.some(c => c.amount_minor === 2500), question);
  }
  const f = registeredPayerFixture(t);
  const possible = await f.ask('did the payment from Payer One $25 arrive?');
  assert.equal(possible.evidence_gate?.complete, false);
  assert.equal(possible.evidence_gate?.reason, 'name_similarity');
  assert.equal(possible.ledger?.found, null);
  assert.match(possible.answer, /Possible match: \$25\.00 posted 2026-10-05/);
});

// ---------------------------------------------------------------- R3-QUESTION-3-6
// Contract question, decided. R2-QF4 area, inverse case. retrievalFailed()
// whitelists only the two scoped-vector reasons as non-failure degradation.
// search() reports degraded="vector" with reason
// "entity-vector-authority-unindexed" for every entity-scoped query whose
// lanes all SUCCEEDED, and retrievalFailed treats that restriction as a failed
// retrieval, so index.js turns every complete entity-scoped answer into
// "retrieval incomplete". Partner answer 12 (verbatim): "That one is
// deliberate for now: without entity authority in the vector index,
// entity-scoped answers stay incomplete. Leave it, and list it as a separate
// item to index that metadata." This test now pins that deliberate behaviour;
// indexing entity metadata in Vectorize is tracked as a separate item.
function entityScopedSearch(f, { filters, supplementalFilters = [], keywordFails = false }) {
  const env = { ...f.env, VECTORIZE: { async query() { return { matches: [] }; } } };
  if (keywordFails) {
    const prepare = env.DB.prepare;
    env.DB = { ...env.DB, prepare: sql => /chunks_fts MATCH/.test(sql)
      ? { bind: () => ({ all: async () => { throw new Error('synthetic: keyword lane failed'); }, first: async () => { throw new Error('synthetic: keyword lane failed'); } }) }
      : prepare(sql) };
  }
  return search(env, { query: 'deposits from Fixture Payer', embedding: [0.1, 0.2], limit: 10,
    filters, supplementalFilters, projectionReadiness: { ready: true } });
}

test('R3-QUESTION-3-6 decided (partner answer 12): an entity-scoped search stays incomplete while entity authority is unindexed in Vectorize', async t => {
  const f = fixture(t, { knownPayers: false });
  const result = await entityScopedSearch(f, { filters: { entity_slug: 'owner' } });
  assert.equal(result.degraded, 'vector');
  assert.equal(result.degraded_reason, 'entity-vector-authority-unindexed', 'every lane succeeded; only the entity restriction applies');
  assert.equal(retrievalFailed(result.degraded, result.degraded_reason), true,
    `entity-scoped answers stay incomplete until entity metadata is indexed in Vectorize (${result.degraded}/${result.degraded_reason})`);
});

test('R3-QUESTION-3-6 control: healthy unscoped search is not failed retrieval; scoped-vector reasons are not; a failed hint keyword lane and a failed base lane are', async t => {
  const f = fixture(t, { knownPayers: false });
  const healthy = await entityScopedSearch(f, { filters: {} });
  assert.equal(healthy.degraded, null);
  assert.equal(retrievalFailed(healthy.degraded, healthy.degraded_reason), false);
  assert.equal(retrievalFailed('scoped-vector', 'document-scope-keyword-only'), false);
  assert.equal(retrievalFailed('scoped-vector', 'zone-scope-keyword-only'), false);
  assert.equal(retrievalFailed('fts', 'keyword-query-failed'), true);
  assert.equal(retrievalFailed('vector', 'vector-query-failed'), true);
  assert.equal(retrievalFailed('no-embedding', 'embedding-unavailable'), true);
  const hinted = await entityScopedSearch(f, { filters: {}, supplementalFilters: [{ category: 'meeting' }], keywordFails: true });
  assert.equal(hinted.degraded, 'fts', 'a failed hint keyword lane marks the search degraded');
  assert.equal(retrievalFailed(hinted.degraded, hinted.degraded_reason), true);
});

// ---------------------------------------------------------------- R3-QUESTION-3-7
// Contract question (needs_contract_decision). "via" is a payer-selector
// start, so a channel phrase after the payer ("via ACH", "via Zelle") is read
// as the payer label. With the noun form the channel word REPLACES the payer:
// "did the Payer One payment via ACH arrive?" classifies with counterparty
// "ach". With the FROM form it is appended: "payer one via ach". Both refuse a
// registered unique payer with "I can't confirm which payer you mean", while
// the same question without the channel phrase answers completely.
const channelPhrase = [
  ['did the Payer One payment via ACH arrive?', 'ach'],
  ['did the Payer One payment via Zelle arrive?', 'zelle'],
  ['did the payment from Payer One via ACH arrive?', 'payer one via ach'],
];

// Partner answer 13 (verbatim): "Strip "via <channel>" for a closed list (ACH,
// Zelle, wire, check, Venmo, PayPal). Refuse other "via" phrases."
test('R3-QUESTION-3-7 a "via <channel>" phrase after the payer becomes the payer selector', async t => {
  for (const [question, observed] of channelPhrase) {
    const intent = classify(question);
    assert.ok(intent.kind === null || intent.counterparty === 'payer one',
      `${question}: counterparty ${JSON.stringify(intent.counterparty)} (expected "payer one" or a refusal; observed on HEAD: ${JSON.stringify(observed)})`);
    assert.equal(intent.kind, 'payment', `${question}: a listed channel is stripped`);
    assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], question);
  }
  const f = registeredPayerFixture(t);
  const body = await f.ask(channelPhrase[0][0]);
  assert.ok(body.route === 'documents' || body.evidence_gate?.complete === true,
    `${channelPhrase[0][0]}: registered unique payer refused: ${body.answer}`);
  assert.equal(body.evidence_gate?.complete, true, body.answer);
  assert.equal(body.ledger?.found, true);
  for (const question of ['did the payment from Payer One via Venmo arrive?', 'did the Payer One payment via PayPal arrive?',
    'did the payment from Payer One via check arrive?', 'did the payment from Payer One via wire arrive?']) {
    assert.equal(classify(question).counterparty, 'payer one', question);
  }
  for (const question of ['did the payment from Payer One via Fixture Rail arrive?', 'did the Payer One payment via Vendor Alpha arrive?',
    'did the payment from Payer One arrive via Fixture Rail?']) {
    assert.equal(classify(question).kind, null, `${question}: an unlisted via phrase after the payer refuses`);
  }
});

test('R3-QUESTION-3-7 control: the same noun and FROM questions without a channel phrase, and "via <payer>", name "payer one" and answer', async t => {
  for (const question of ['did the Payer One payment arrive?', 'did the payment from Payer One arrive?', 'did the payment via Payer One arrive?']) {
    const f = registeredPayerFixture(t);
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', question);
    assert.equal(intent.counterparty, 'payer one', question);
    const body = await f.ask(question);
    assert.equal(body.evidence_gate?.complete, true, `${question}: ${body.answer}`);
    assert.equal(body.ledger?.found, true, question);
  }
});
