import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { attributeInflow, payerRegistry } from '../src/lib/ledger-attribution.js';

// Partner review, packet 7 round 7, money-contract lens (reviewing
// partner/fix-0418-3 at 979477c, after the round-7 rulings). Repros fail;
// controls pass. Synthetic role-word names only. Nothing here edits an
// existing file.
const identity = (f, slug, name, label = null) => f.raw(
  "INSERT INTO fin_entities(entity_slug,legal_name,display_label,kind,relationship,provenance,basis_state,recorded_at) VALUES (?,?,?,'business','owned','owner_stated','confirmed',?)",
  slug, name, label, NOW);
const cents = body => body.citations.map(c => c.amount_minor);
const notComplete = (body, label) => {
  assert.ok(body.ledger, `${label}: ledger answer reached`);
  assert.notEqual(body.evidence_gate.complete, true, `${label}: complete gate: ${body.answer}`);
  assert.equal(body.ledger.total_minor ?? null, null, `${label}: a complete total was certified`);
};
const complete = (body, total, label) => {
  assert.ok(body.ledger, `${label}: ledger answer reached`);
  assert.equal(body.evidence_gate.complete, true, `${label}: ${body.answer}`);
  if (total !== undefined) assert.equal(body.ledger.total_minor, total, `${label}: total`);
};
// The contract's "visible note": the row is cited and the answer carries a
// line about it, whichever listing vocabulary the branch uses.
const listed = (body, amount, label) => {
  assert.ok(cents(body).includes(amount), `${label}: the row is not cited: ${body.answer}`);
  assert.match(body.answer, /Unattributed deposit|Possible match/, `${label}: no visible line for the row`);
};
const hidden = (body, amount, label) => assert.ok(!cents(body).includes(amount), `${label}: the row is cited: ${body.answer}`);

const INCOME = 'How much income came from Payer One in October 2026?';
const PAYMENT = 'Did the payment from Payer One arrive in October 2026?';

// ---------------------------------------------------------------------------
// R7-MONEY-1: payerNameVariant() (ledger-attribution.js:781-791) admits, on
// the inflow side, a bounded field that extends the requested name with
// TRAILING words ("Payer One Holdings"; `longer: true`, R4-MONEY-5) and, since
// ruling 10, any shorter whole-word run of it. A field that extends the
// requested name with LEADING words ("Acme Payer One", "PPD Payer One",
// "FROM: Acme Payer One") matches neither clause, so possibleField()
// (ledger-answer.js:359-367) is false and knownRows (:402-403) makes the row
// a known other: beside an exact row it is hidden and the income total is
// complete, the payment a complete "Found a deposit". Alone, the same row is
// listed as a deposit that "doesn't show who paid". The requested name is a
// whole-word substring of the field exactly as it is of "Payer One Holdings";
// a bank prefix outside the closed channel list (an SEC code such as PPD, or
// any unlisted type word) produces this shape on the entity's own rows.
// Fixed in the round-7 fix pass (one root cause with R7-QUESTION-1 and
// R7-FIDELITY-1): on the inflow side the longer field is read by whole-word
// containment at any position.
test('R7-MONEY-1 a bounded field that extends the requested name with leading words is hidden as a known other behind a complete total', async t => {
  for (const [description, payee] of [['Deposit', 'Acme Payer One'], ['Deposit', 'PPD Payer One'], ['FROM: Acme Payer One', null]]) {
    const label = `${description} / ${payee}`;
    const f = ledgerFixture(t, { knownPayers: false });
    identity(f, 'alpha', 'Payer One');
    f.add('exact', 'Deposit', 'Payer One', { cents: 2500 });
    f.add('lead', description, payee, { cents: 4000 });
    const income = await f.ask(INCOME);
    listed(income, 4000, `inflow, leading-word field beside the exact row (${label})`);
    notComplete(income, `inflow, leading-word field beside the exact row (${label})`);
    const payment = await f.ask(PAYMENT);
    listed(payment, 4000, `payment, leading-word field beside the exact row (${label})`);
    assert.notEqual(payment.evidence_gate.complete, true, `payment, leading-word field beside the exact row (${label}): ${payment.answer}`);
  }
});

test('R7-MONEY-1 control: the trailing-word field is listed; an unrelated payee is a known other; the leading-word field alone is listed; the exact row alone is complete', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  identity(f, 'alpha', 'Payer One');
  f.add('exact', 'Deposit', 'Payer One', { cents: 2500 });
  f.add('trail', 'Deposit', 'Payer One Holdings', { cents: 4000 });
  const trailing = await f.ask(INCOME);
  listed(trailing, 4000, 'inflow, trailing-word payee');
  notComplete(trailing, 'inflow, trailing-word payee');
  f.raw("UPDATE fin_transactions SET payee='Supply Unit' WHERE txn_uid='trail'");
  const unrelated = await f.ask(INCOME);
  complete(unrelated, 2500, 'inflow, unrelated payee');
  hidden(unrelated, 4000, 'inflow, unrelated payee');
  f.raw("DELETE FROM fin_transactions WHERE txn_uid='trail'");
  complete(await f.ask(INCOME), 2500, 'inflow, exact alone');
  // Alone, the leading-word field is already a deposit that "doesn't show
  // who paid" on both questions.
  const g = ledgerFixture(t, { knownPayers: false });
  identity(g, 'alpha', 'Payer One');
  g.add('lead', 'Deposit', 'Acme Payer One', { cents: 4000 });
  const alone = await g.ask(INCOME);
  listed(alone, 4000, 'inflow, leading-word payee alone');
  notComplete(alone, 'inflow, leading-word payee alone');
  assert.equal(alone.ledger.found, null, `inflow, leading-word payee alone: ${alone.answer}`);
  const alonePayment = await g.ask(PAYMENT);
  listed(alonePayment, 4000, 'payment, leading-word payee alone');
  assert.equal(alonePayment.ledger.found, null, `payment, leading-word payee alone: ${alonePayment.answer}`);
});

// ---------------------------------------------------------------------------
// R7-MONEY-2 (contract question): partner ruling 9 ("for the OTHER payer
// named in full in an unlabelled description ... never certify absence or
// $0") is applied through descriptionNamesPayer() (ledger-attribution.js:
// 723-745), which only scans the REGISTERED spellings of the requested entity
// (namesRequested, ledger-answer.js:374-380 passes `requestedSpellings`, empty
// unless the question resolved to a registered slug). An unregistered payer
// asked for by its exact bounded-payee spelling ("Payer One", which has an
// exact payee row and is therefore a known bounded name) gets no such scan: a
// row beside another payee whose unlabelled description names "Payer One" in
// full is a known other, hidden behind a complete total and a complete "Found
// a deposit". The same rows with "Payer One" registered are listed with the
// ruling-9 reason. Whether "named in full" means a registered spelling only,
// or the question's own exact name as well, is for the partner to decide.
// Logged for 0.4.19 (contract question): kept as a todo so the suite stays
// green; no false absence or $0 results (alone, the row is refused with a
// null total).
test('R7-MONEY-2 an unregistered payer named in full in an unlabelled description beside another payee is hidden behind a complete total', { todo: 'logged for 0.4.19: contract question, does ruling 9 "named in full" cover an unregistered question\'s own exact name' }, async t => {
  for (const description of ['Settlement Payer One invoice 55', 'Payer One remittance']) {
    const f = ledgerFixture(t, { knownPayers: false });
    f.add('exact', 'Deposit', 'Payer One', { cents: 2500 });
    f.add('named', description, 'Supply Unit', { cents: 4000 });
    const income = await f.ask(INCOME);
    listed(income, 4000, `inflow, unregistered question, description names the payer (${description})`);
    notComplete(income, `inflow, unregistered question, description names the payer (${description})`);
    const payment = await f.ask(PAYMENT);
    listed(payment, 4000, `payment, unregistered question, description names the payer (${description})`);
    assert.notEqual(payment.evidence_gate.complete, true, `payment, unregistered question, description names the payer (${description}): ${payment.answer}`);
  }
});

test('R7-MONEY-2 control: the registered question lists the same row (with the ruling-9 reason beside a registered payee); a labelled description names its sender; the exact row alone is complete', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  identity(f, 'alpha', 'Payer One');
  f.add('exact', 'Deposit', 'Payer One', { cents: 2500 });
  f.add('named', 'Settlement Payer One invoice 55', 'Supply Unit', { cents: 4000 });
  const registered = await f.ask(INCOME);
  listed(registered, 4000, 'inflow, registered question');
  notComplete(registered, 'inflow, registered question');
  // Beside a registered payee the row is confirmed to that payee and listed
  // with the ruling-9 reason.
  identity(f, 'beta', 'Vendor Beta');
  f.raw("UPDATE fin_transactions SET payee='Vendor Beta' WHERE txn_uid='named'");
  const mentioned = await f.ask(INCOME);
  listed(mentioned, 4000, 'inflow, registered question, registered payee');
  notComplete(mentioned, 'inflow, registered question, registered payee');
  assert.match(mentioned.answer, /uncertain because the statement description also names the requested payer/, mentioned.answer);
  // A labelled description names its sender (the committed triage pins keep
  // this shape): the row is the other payer's on both questions.
  const g = ledgerFixture(t, { knownPayers: false });
  g.add('exact', 'Deposit', 'Payer One', { cents: 2500 });
  g.add('labelled', 'Zelle from Supply Unit for Payer One invoice', 'Supply Unit', { cents: 4000 });
  const labelled = await g.ask(INCOME);
  complete(labelled, 2500, 'inflow, unregistered question, labelled description');
  hidden(labelled, 4000, 'inflow, unregistered question, labelled description');
  const h = ledgerFixture(t, { knownPayers: false });
  h.add('exact', 'Deposit', 'Payer One', { cents: 2500 });
  complete(await h.ask(INCOME), 2500, 'inflow, unregistered question, exact alone');
});

// ---------------------------------------------------------------------------
// R7-MONEY-3: a payee-less row whose unlabelled opening name is the requested
// REGISTERED payer and whose labelled sender names someone else ("Payer One;
// FROM: Vendor Gamma") is rated 'unknown' by attributeInflow(): the parse is
// complete, confirmed_readings holds "Payer One", the labelled sender holds
// "Vendor Gamma", and no parse resolves every reading. boundedPayerFields()
// (ledger-attribution.js:833-851) compares confirmed_readings with the
// labelled senders only `payee.length ? ... : []`, so with no payee the
// disagreement is dropped: fields = ["Vendor Gamma"], conflict false. On the
// exact path knownRows (ledger-answer.js:402-403) then makes the row a known
// other (its one bounded field does not share the requested name), and it is
// hidden behind a complete income total and a complete "Found a deposit".
// Alone, or beside any payee, the same row is listed. With the sender itself
// registered ("Payer One; FROM: Vendor Beta") the parser's own candidates are
// "Payer One; Vendor Beta", and the row is still hidden from Payer One's
// answers while Vendor Beta's answers list it as unattributed: the row is
// treated as the sender's for one payer and as nobody's for the other.
// Ruling 11 made an unlabelled registered opening name that disagrees with
// the payee unknown; R4-MONEY-4 made a shorthand of the requested name beside
// a foreign payee visible. This is the same disagreement beside a labelled
// sender instead of a payee.
// Fixed in the round-7 fix pass: on the answer side, an unknown row whose own
// parse rates the requested payer a confirmed reading is a possible match,
// never a known other. The repro pins the contract outcome (the row listed,
// no complete total, no complete deposit), not where the doubt is recorded.
const DISAGREEING = ['Payer One; FROM: Vendor Gamma', 'Payer One FROM: Vendor Gamma', 'Payer One; BY Vendor Gamma',
  'Payer One; ORIG CO NAME: Vendor Gamma', 'Payer One; FROM: Vendor Beta', 'Alpha Unit; FROM: Vendor Gamma'];
const registryOf = () => payerRegistry([{ entity_slug: 'alpha', legal_name: 'Payer One', display_label: 'Alpha Unit' },
  { entity_slug: 'beta', legal_name: 'Vendor Beta' }]);

test('R7-MONEY-3 a payee-less row whose opening name is the requested payer and whose labelled sender is someone else is hidden as a known other behind a complete total', async t => {
  const registry = registryOf();
  for (const description of DISAGREEING) {
    const row = { description, payee: null };
    const decided = attributeInflow(row, registry);
    assert.equal(decided.state, 'unknown', `${description}: the attribution is unknown`);
    assert.ok(decided.evidence.confirmed_readings.some(reading => reading.payer.slug === 'alpha'),
      `${description}: the parser rates the opening name a confirmed reading of the requested payer`);
    const f = ledgerFixture(t, { knownPayers: false });
    identity(f, 'alpha', 'Payer One', 'Alpha Unit'); identity(f, 'beta', 'Vendor Beta');
    f.add('exact', 'Deposit', 'Payer One', { cents: 2500 });
    f.add('row', description, null, { cents: 4000 });
    const income = await f.ask(INCOME);
    listed(income, 4000, `inflow, disagreeing payee-less row beside the exact row (${description})`);
    notComplete(income, `inflow, disagreeing payee-less row beside the exact row (${description})`);
    const payment = await f.ask(PAYMENT);
    listed(payment, 4000, `payment, disagreeing payee-less row beside the exact row (${description})`);
    assert.notEqual(payment.evidence_gate.complete, true, `payment, disagreeing payee-less row beside the exact row (${description}): ${payment.answer}`);
  }
});

test('R7-MONEY-3 control: alone, or beside a payee, the same row is listed; the registered sender\'s own answer lists it; agreeing fields stay exact; an agreeing other row is a known other', async t => {
  for (const description of DISAGREEING) {
    const f = ledgerFixture(t, { knownPayers: false });
    identity(f, 'alpha', 'Payer One', 'Alpha Unit'); identity(f, 'beta', 'Vendor Beta');
    f.add('row', description, null, { cents: 4000 });
    const alone = await f.ask(INCOME);
    listed(alone, 4000, `inflow, disagreeing payee-less row alone (${description})`);
    notComplete(alone, `inflow, disagreeing payee-less row alone (${description})`);
    assert.equal(alone.ledger.found, null, `inflow, disagreeing payee-less row alone (${description}): ${alone.answer}`);
    // Beside a payee (either name) the disagreement is kept and the row is listed.
    for (const payee of ['Payer One', 'Vendor Gamma']) {
      f.raw('UPDATE fin_transactions SET payee=? WHERE txn_uid=?', payee, 'row');
      f.add('exact', 'Deposit', 'Payer One', { cents: 2500 });
      const beside = await f.ask(INCOME);
      listed(beside, 4000, `inflow, disagreeing row with payee ${payee} (${description})`);
      notComplete(beside, `inflow, disagreeing row with payee ${payee} (${description})`);
      f.raw("DELETE FROM fin_transactions WHERE txn_uid='exact'");
    }
  }
  // The registered sender's own answer never takes the row as its own.
  const g = ledgerFixture(t, { knownPayers: false });
  identity(g, 'alpha', 'Payer One'); identity(g, 'beta', 'Vendor Beta');
  g.add('exact', 'Deposit', 'Vendor Beta', { cents: 2500 });
  g.add('row', 'Payer One; FROM: Vendor Beta', null, { cents: 4000 });
  const beta = await g.ask('How much income came from Vendor Beta in October 2026?');
  listed(beta, 4000, 'inflow, the registered sender\'s answer');
  notComplete(beta, 'inflow, the registered sender\'s answer');
  // Agreeing fields are the payer's own row; an agreeing other row is a known other.
  const h = ledgerFixture(t, { knownPayers: false });
  identity(h, 'alpha', 'Payer One');
  h.add('exact', 'Deposit', 'Payer One', { cents: 2500 });
  h.add('agree', 'Payer One; FROM: Payer One', null, { cents: 4000 });
  const agreeing = await h.ask(INCOME);
  complete(agreeing, 6500, 'inflow, agreeing payee-less row');
  assert.deepEqual(cents(agreeing).sort(), [2500, 4000]);
  h.raw("UPDATE fin_transactions SET description='Vendor Gamma; FROM: Vendor Gamma' WHERE txn_uid='agree'");
  const other = await h.ask(INCOME);
  complete(other, 2500, 'inflow, agreeing other payee-less row');
  hidden(other, 4000, 'inflow, agreeing other payee-less row');
  // The requested name as the labelled sender beside another opening name is listed.
  h.raw("UPDATE fin_transactions SET description='Vendor Gamma; FROM: Payer One' WHERE txn_uid='agree'");
  const reversed = await h.ask(INCOME);
  listed(reversed, 4000, 'inflow, requested name in the labelled sender');
  notComplete(reversed, 'inflow, requested name in the labelled sender');
});
