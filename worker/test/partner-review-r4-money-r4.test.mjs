import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { createInflowAttributor, payerRegistry, lookupPayer } from '../src/lib/ledger-attribution.js';

// Partner review, round 4, money-contract lens (reviewing partner/fix-0418-3
// at da7a92a, after the partner's 13 answers were applied). Repros fail; controls
// pass. Synthetic role-word names only. Nothing here edits an existing file.
const identity = (f, slug, name, label = null) => f.raw(
  "INSERT INTO fin_entities(entity_slug,legal_name,display_label,kind,relationship,provenance,basis_state,recorded_at) VALUES (?,?,?,'business','owned','owner_stated','confirmed',?)",
  slug, name, label, NOW);
// A registry spelling that contains NUL. The reader's SQL flags it
// (legal_name_has_nul) and node:sqlite returns the whole string.
const damagedIdentity = (f, slug, visible, tail = '') => f.raw(
  "INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at) VALUES (?, ? || char(0) || ?,'business','owned','owner_stated','confirmed',?)",
  slug, visible, tail, NOW);
const twoPayers = () => payerRegistry([{ entity_slug: 'alpha', legal_name: 'Vendor Alpha' }, { entity_slug: 'beta', legal_name: 'Vendor Beta' }]);
const cents = body => body.citations.map(c => c.amount_minor);
const notComplete = (body, label) => {
  assert.ok(body.ledger, `${label}: ledger answer reached`);
  assert.notEqual(body.evidence_gate.complete, true, `${label}: complete gate: ${body.answer}`);
  assert.equal(body.ledger.total_minor ?? null, null, `${label}: a complete total was certified`);
};
// The contract's "visible note": the row is cited and the answer carries a
// line about it, whichever listing vocabulary the branch uses.
const listed = (body, amount, label) => {
  assert.ok(cents(body).includes(amount), `${label}: the row is not cited: ${body.answer}`);
  assert.match(body.answer, /Unattributed deposit|Possible match/, `${label}: no visible line for the row`);
};

// ---------------------------------------------------------------------------
// R4-MONEY-1: payerRegistry() (ledger-attribution.js:47-50) skips a NUL-damaged
// registry spelling and only records a damage flag. chooseLiteralSelector()
// consults that flag solely for unregistered phrases (ledger-answer.js:240
// `payerRegistryHasDamage(identities) && !slug`, :268 `&& !registered`). So a
// damaged spelling whose visible text IS a registered name ("Vendor Alpha" +
// NUL for entity gamma beside "Vendor Alpha" for entity alpha) never competes:
// lookupPayer() returns unique, the question resolves to alpha, and both
// sides certify a complete total and a confirmed deposit. The same registry
// with the damage removed is a collision and refuses. Damage therefore turns
// a non-unique name into a unique one. The contract needs an EXACT, UNIQUE
// name match for completeness, and the branch already treats damage as
// "we cannot prove which phrase conflicts with it" for query-only phrases
// (partner-r7-uniqueness.test.mjs:49).
test('R4-MONEY-1 a NUL-damaged registry spelling equal to a registered name cannot prove that name unique', async t => {
  // Registry level: the whole damaged string and a truncating driver's prefix
  // both normalize to the registered key, so the lookup is not unique.
  const whole = payerRegistry([{ entity_slug: 'alpha', legal_name: 'Vendor Alpha' },
    { entity_slug: 'gamma', legal_name: 'Vendor Alpha\0', legal_name_has_nul: 1 }]);
  assert.notEqual(lookupPayer('Vendor Alpha', whole).state, 'unique', 'whole damaged string collides with the registered key');
  const truncated = payerRegistry([{ entity_slug: 'alpha', legal_name: 'Vendor Alpha' },
    { entity_slug: 'gamma', legal_name: 'Vendor Alpha', legal_name_has_nul: 1 }]);
  assert.notEqual(lookupPayer('Vendor Alpha', truncated).state, 'unique', 'a truncating driver shows the same visible prefix');
  // Inflow, end to end.
  const f = ledgerFixture(t, { knownPayers: false });
  identity(f, 'alpha', 'Vendor Alpha');
  f.add('exact', 'Deposit', 'Vendor Alpha', { cents: 1000 });
  damagedIdentity(f, 'gamma', 'Vendor Alpha');
  const income = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.deepEqual(cents(income), [1000], 'the row is read');
  notComplete(income, 'damaged collision, income');
  const payment = await f.ask('Did the payment from Vendor Alpha arrive in October 2026?');
  assert.notEqual(payment.evidence_gate.complete, true, `damaged collision, payment: ${payment.answer}`);
  assert.equal(payment.ledger.found, null, 'a confirmed deposit needs a unique name');
  // Outflow, end to end.
  const g = ledgerFixture(t, { knownPayers: false });
  identity(g, 'alpha', 'Vendor Alpha');
  g.add('out', 'Purchase', 'Vendor Alpha', { direction: 'outflow', cents: 1000 });
  damagedIdentity(g, 'gamma', 'Vendor Alpha');
  notComplete(await g.ask('How much did I spend at Vendor Alpha in October 2026?'), 'damaged collision, outflow');
});

test('R4-MONEY-1 control: an undamaged collision refuses on both sides, and an unrelated damaged spelling leaves the exact answer complete', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  identity(f, 'alpha', 'Vendor Alpha');
  f.add('exact', 'Deposit', 'Vendor Alpha', { cents: 1000 });
  // Damage on a spelling that cannot be this name leaves the unique
  // registered name usable (as ledger-authority-fields.test.mjs already pins).
  damagedIdentity(f, 'gamma', 'Other Supplier');
  const unrelated = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.equal(unrelated.evidence_gate.complete, true);
  assert.equal(unrelated.ledger.total_minor, 1000);
  assert.equal((await f.ask('Did the payment from Vendor Alpha arrive in October 2026?')).ledger.found, true);
  // The same collision without damage is refused: that is the decision the
  // damaged spelling must not be allowed to escape.
  f.raw("UPDATE fin_entities SET legal_name='Vendor Alpha' WHERE entity_slug='gamma'");
  const collision = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.equal(collision.evidence_gate.complete, false);
  assert.equal(collision.ledger.total_minor, null);
  const payment = await f.ask('Did the payment from Vendor Alpha arrive in October 2026?');
  assert.equal(payment.evidence_gate.complete, false);
  assert.equal(payment.ledger.found, null);
  const g = ledgerFixture(t, { knownPayers: false });
  identity(g, 'alpha', 'Vendor Alpha');
  identity(g, 'gamma', 'Vendor Alpha');
  g.add('out', 'Purchase', 'Vendor Alpha', { direction: 'outflow', cents: 1000 });
  const outflow = await g.ask('How much did I spend at Vendor Alpha in October 2026?');
  assert.equal(outflow.evidence_gate.complete, false);
  assert.equal(outflow.ledger.total_minor, null);
});

// ---------------------------------------------------------------------------
// R4-MONEY-2: partner answer 4 made every reading the parser rates confirmed
// (a unique registered whole name, labelled or not) join the payee agreement
// check: "Vendor Beta; REF: 100000" beside payee "Vendor Alpha" is unknown.
// The round 1 'incomplete' exemption (ledger-attribution.js:495-497) still
// lets the payee stand whenever no field start carries a SENDER LABEL. A bare
// registered opening name followed by a field the closed grammar cannot
// consume ("Vendor Beta; ID: 123", or a line break) yields no complete parse,
// so confirmed_readings is empty, senderLabelPresent() is false, and the row
// is confirmed to the payee. The payer named verbatim at the opening of the
// description then gets a certified $0 and a certified absence, exactly the
// R3-MONEY-2-1 shape with the sender label removed. The same opening with a
// grammar tail blocks (answer 4), so the unread tail decides the money.
const BARE_UNKNOWN_TAIL = 'Vendor Beta; ID: 123';
const BARE_LINE_BREAK_TAIL = 'Vendor Beta\nID: 123';
const BARE_GRAMMAR_TAIL = 'Vendor Beta; REF: 100000';

test('R4-MONEY-2 a registered opening name with an unparseable tail is confirmed to a different payee', async t => {
  const violations = [];
  for (const description of [BARE_UNKNOWN_TAIL, BARE_LINE_BREAK_TAIL]) {
    const decided = createInflowAttributor(twoPayers())({ description, payee: 'Vendor Alpha' });
    assert.equal(decided.evidence.parser.refusal, 'incomplete', 'the incomplete refusal was reached');
    if (decided.state !== 'unknown') violations.push({ description, state: decided.state, entity_slug: decided.entity_slug });
  }
  assert.deepEqual(violations, [], 'an unread tail cannot corroborate the payee over a registered opening name');
  const f = ledgerFixture(t, { knownPayers: false });
  identity(f, 'alpha', 'Vendor Alpha'); identity(f, 'beta', 'Vendor Beta');
  f.add('row', BARE_UNKNOWN_TAIL, 'Vendor Alpha', { cents: 1000 });
  const zero = await f.ask('How much income came from Vendor Beta in October 2026?');
  assert.ok(zero.ledger);
  assert.ok(!(zero.evidence_gate.complete === true && zero.ledger.total_minor === 0),
    `certified $0 for the payer named at the opening of the description: ${zero.answer}`);
  // Triage decided: incomplete, no total, the $10 row listed with a visible line.
  notComplete(zero, 'Vendor Beta income beside the unread tail');
  listed(zero, 1000, 'Vendor Beta income beside the unread tail');
  const absent = await f.ask('Did the payment from Vendor Beta arrive in October 2026?');
  assert.notEqual(absent.ledger.found, false, `certified absence: ${absent.answer}`);
  assert.notEqual(absent.evidence_gate.complete, true);
  const alpha = await f.ask('How much income came from Vendor Alpha in October 2026?');
  notComplete(alpha, 'payee certified over the unread tail');
  assert.deepEqual(cents(alpha), [1000], 'the $10 row stays listed');
});

// Triage-recommended sibling: the same opening with a space-separated tail.
// The grammar reads the whole opening as one unregistered name (a complete
// parse), so no refusal is involved, yet the registered "Vendor Beta" still
// opens the line beside payee "Vendor Alpha".
const BARE_SPACE_TAIL = 'Vendor Beta REF 100000';
test('R4-MONEY-2 sibling: a registered opening name with a space-separated tail is confirmed to a different payee', async t => {
  const decided = createInflowAttributor(twoPayers())({ description: BARE_SPACE_TAIL, payee: 'Vendor Alpha' });
  assert.equal(decided.state, 'unknown', `the payee cannot stand over a registered opening name: ${decided.state} ${String(decided.entity_slug)}`);
  const f = ledgerFixture(t, { knownPayers: false });
  identity(f, 'alpha', 'Vendor Alpha'); identity(f, 'beta', 'Vendor Beta');
  f.add('row', BARE_SPACE_TAIL, 'Vendor Alpha', { cents: 1000 });
  const zero = await f.ask('How much income came from Vendor Beta in October 2026?');
  notComplete(zero, 'Vendor Beta income, space tail');
  listed(zero, 1000, 'Vendor Beta income, space tail');
  const absent = await f.ask('Did the payment from Vendor Beta arrive in October 2026?');
  assert.notEqual(absent.ledger.found, false, `certified absence: ${absent.answer}`);
  assert.notEqual(absent.evidence_gate.complete, true);
  const alpha = await f.ask('How much income came from Vendor Alpha in October 2026?');
  notComplete(alpha, 'Vendor Alpha income, space tail');
  assert.deepEqual(cents(alpha), [1000]);
});

test('R4-MONEY-2 control: a grammar tail blocks (answer 4); the payee\'s own name, an unregistered opening or no name at all lets the payee stand', async t => {
  const attribute = createInflowAttributor(twoPayers());
  const grammar = attribute({ description: BARE_GRAMMAR_TAIL, payee: 'Vendor Alpha' });
  assert.equal(grammar.state, 'unknown');
  assert.deepEqual(grammar.evidence.confirmed_readings.map(r => r.identity), ['Vendor Beta']);
  // The payee's own registered name at the opening cannot disagree with it.
  const own = attribute({ description: 'Vendor Alpha; ID: 123', payee: 'Vendor Alpha' });
  assert.equal(own.state, 'confirmed'); assert.equal(own.entity_slug, 'alpha');
  // An unregistered opening is not a confirmed-grade reading with any tail.
  for (const description of ['Vendor Gamma; ID: 123', 'Vendor Gamma; REF: 100000', 'ID: 123; NOTE: something']) {
    const decided = attribute({ description, payee: 'Vendor Alpha' });
    assert.equal(decided.state, 'confirmed', description); assert.equal(decided.entity_slug, 'alpha');
  }
  const f = ledgerFixture(t, { knownPayers: false });
  identity(f, 'alpha', 'Vendor Alpha'); identity(f, 'beta', 'Vendor Beta');
  f.add('row', BARE_GRAMMAR_TAIL, 'Vendor Alpha', { cents: 1000 });
  for (const name of ['Vendor Beta', 'Vendor Alpha']) notComplete(await f.ask(`How much income came from ${name} in October 2026?`), name);
  assert.equal((await f.ask('Did the payment from Vendor Beta arrive in October 2026?')).ledger.found, null);
  f.raw("UPDATE fin_transactions SET description='Vendor Alpha; ID: 123'");
  const own2 = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.equal(own2.evidence_gate.complete, true); assert.equal(own2.ledger.total_minor, 1000);
  // Triage decided: a longer opening run equal to the payee is never made
  // unknown by its shorter registered prefix (both names registered).
  const nested = payerRegistry([{ entity_slug: 'alpha', legal_name: 'Vendor Alpha' },
    { entity_slug: 'holdings', legal_name: 'Vendor Alpha Holdings' }]);
  const longer = createInflowAttributor(nested)({ description: 'Vendor Alpha Holdings ID 1', payee: 'Vendor Alpha Holdings' });
  assert.equal(longer.state, 'confirmed'); assert.equal(longer.entity_slug, 'holdings');
  const g = ledgerFixture(t, { knownPayers: false });
  identity(g, 'alpha', 'Vendor Alpha'); identity(g, 'holdings', 'Vendor Alpha Holdings');
  g.add('row', 'Vendor Alpha Holdings ID 1', 'Vendor Alpha Holdings', { cents: 1000 });
  const holdings = await g.ask('How much income came from Vendor Alpha Holdings in October 2026?');
  assert.equal(holdings.evidence_gate.complete, true, holdings.answer); assert.equal(holdings.ledger.total_minor, 1000);
});

// ---------------------------------------------------------------------------
// R4-MONEY-3 (raised as a contract question, decided at triage): the parser rates a channel-prefixed or
// suffixed shorthand of a registered name ("ACH Vendor Beta", "Vendor Beta
// payment") 'assumed'. Beside a payee, only labelled senders and CONFIRMED
// readings are compared (ledger-attribution.js:461-462, :509), so an assumed
// reading that names a DIFFERENT registered payer is dropped and the payee is
// confirmed. Vendor Beta, named by the description's shorthand, then gets a
// certified $0 and a certified absence, and the row is hidden from its
// answer (ledger-answer.js:272-273 marks any non-conflicting bounded payee
// as "known"). Alone, the same description is an assumed Vendor Beta reading
// and a possible match. Answer 4 covers readings "the parser rates
// confirmed"; the contract's "shorthand is a possible match with a visible
// note" line and "never zero and never absence when in doubt" point the
// other way. The repro asserts only what every reading of the contract
// shares for Vendor Beta's question: no certified zero, no certified
// absence, the row visible, the answer incomplete. Whether the row also
// stops being confirmed for Vendor Alpha is the open question for the partner.
// Triage decided option A (the principle settles it, not a question for
// the partner): beside a bounded payee, a shorthand reading that resolves to a
// different registered entity joins the agreement check and the row is
// unknown, so neither name gets a complete figure. R4-FIDELITY-5 was dropped
// as a duplicate; its three spellings are folded in here.
test('R4-MONEY-3 shorthand naming another registered payer beside a payee certifies that payer\'s zero and absence', async t => {
  const attribute = createInflowAttributor(twoPayers());
  for (const description of ['ACH Vendor Beta', 'Vendor Beta payment', 'ACH credit Vendor Beta', 'Vendor Beta deposit', 'wire Vendor Beta payment']) {
    if (description !== 'wire Vendor Beta payment') {
      // Alone, the description is a shorthand (assumed) reading of Vendor Beta.
      const alone = attribute({ description, payee: null });
      assert.equal(alone.state, 'assumed', `${description}: alone the description is a shorthand reading of Vendor Beta`);
      assert.equal(alone.entity_slug, 'beta');
    }
    assert.equal(attribute({ description, payee: 'Vendor Alpha' }).state, 'unknown', `${description}: option A makes the row unknown`);
    const f = ledgerFixture(t, { knownPayers: false });
    identity(f, 'alpha', 'Vendor Alpha'); identity(f, 'beta', 'Vendor Beta');
    f.add('row', description, 'Vendor Alpha', { cents: 1000 });
    const zero = await f.ask('How much income came from Vendor Beta in October 2026?');
    assert.ok(zero.ledger);
    assert.ok(!(zero.evidence_gate.complete === true && zero.ledger.total_minor === 0),
      `${description}: certified $0 for the payer the description's shorthand names: ${zero.answer}`);
    listed(zero, 1000, `${description}: income`);
    notComplete(zero, `${description}: income`);
    const absent = await f.ask('Did the payment from Vendor Beta arrive in October 2026?');
    assert.notEqual(absent.ledger.found, false, `${description}: certified absence: ${absent.answer}`);
    assert.notEqual(absent.evidence_gate.complete, true);
    assert.equal(absent.ledger.found, null, `${description}: payment found`);
    assert.deepEqual(cents(absent), [1000], `${description}: the row is cited on the payment answer`);
    // Option A: the payee no longer stands for Vendor Alpha either.
    const alpha = await f.ask('How much income came from Vendor Alpha in October 2026?');
    notComplete(alpha, `${description}: Vendor Alpha income`);
    assert.deepEqual(cents(alpha), [1000], `${description}: the row is cited on Vendor Alpha's answer`);
  }
});

test('R4-MONEY-3 control: shorthand of the payee\'s own name agrees; a labelled sender of another payer blocks; the shorthand alone is a possible match', async t => {
  const attribute = createInflowAttributor(twoPayers());
  for (const description of ['ACH Vendor Alpha', 'Vendor Alpha payment', 'ACH credit Vendor Alpha']) {
    const decided = attribute({ description, payee: 'Vendor Alpha' });
    assert.equal(decided.state, 'confirmed'); assert.equal(decided.entity_slug, 'alpha');
  }
  assert.equal(attribute({ description: 'FROM: Vendor Beta', payee: 'Vendor Alpha' }).state, 'unknown');
  // From the dropped R4-FIDELITY-5 control: a bare confirmed reading of the
  // other payer makes the row unknown too (answer 4), and neither name is
  // complete or certified absent.
  assert.equal(attribute({ description: 'Vendor Beta', payee: 'Vendor Alpha' }).state, 'unknown');
  for (const description of ['Vendor Beta', 'FROM: Vendor Beta']) {
    const h = ledgerFixture(t, { knownPayers: false });
    identity(h, 'alpha', 'Vendor Alpha'); identity(h, 'beta', 'Vendor Beta');
    h.add('row', description, 'Vendor Alpha', { cents: 1000 });
    for (const name of ['Vendor Alpha', 'Vendor Beta']) {
      notComplete(await h.ask(`How much income came from ${name} in October 2026?`), `${description} / ${name}`);
      assert.notEqual((await h.ask(`Did the payment from ${name} arrive in October 2026?`)).ledger?.found, false, `${description} / ${name}`);
    }
  }
  const s = ledgerFixture(t, { knownPayers: false });
  identity(s, 'alpha', 'Vendor Alpha'); identity(s, 'beta', 'Vendor Beta');
  s.add('row', 'ACH credit Vendor Alpha', 'Vendor Alpha', { cents: 1000 });
  const same = await s.ask('How much income came from Vendor Alpha in October 2026?');
  assert.equal(same.evidence_gate.complete, true, same.answer);
  assert.equal(same.ledger.total_minor, 1000);
  const f = ledgerFixture(t, { knownPayers: false });
  identity(f, 'alpha', 'Vendor Alpha'); identity(f, 'beta', 'Vendor Beta');
  f.add('exact', 'Deposit', 'Vendor Alpha', { cents: 1000 });
  f.add('short', 'Vendor Alpha payment', 'Vendor Alpha', { cents: 2500 });
  const agree = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.equal(agree.evidence_gate.complete, true);
  assert.equal(agree.ledger.total_minor, 3500);
  f.raw("UPDATE fin_transactions SET description='ACH Vendor Beta', payee=NULL WHERE txn_uid='short'");
  const beta = await f.ask('How much income came from Vendor Beta in October 2026?');
  assert.equal(beta.evidence_gate.complete, false);
  assert.equal(beta.ledger.total_minor, null);
  assert.equal(beta.ledger.subtotal_is_partial, true);
  assert.deepEqual(cents(beta), [2500]);
});

// ---------------------------------------------------------------------------
// R4-MONEY-4: on the exact path, chooseLiteralSelector() marks every row whose
// bounded fields do not conflict and do not equal the question as "known"
// (ledger-answer.js:272-273), and ledgerAnswer() lists only rows outside that
// set as unattributed (:471). A row whose description is the requested name's
// own shorthand ("Vendor Alpha payment") beside an unregistered foreign payee
// ("Vendor Gamma") has attribution 'unknown' (the payee resolves to nobody),
// yet it is neither counted nor listed: the answer is a complete "Total
// income for Vendor Alpha" over the exact row alone. Without the exact row
// the branch lists the very same row as a deposit that "doesn't show who
// paid". The same shorthand with no payee, and the bare name beside the same
// foreign payee, are listed and block completeness. The contract calls a
// shorthand match a possible match with a visible note; here it is hidden
// behind the payee and the total is complete.
test('R4-MONEY-4 shorthand of the requested name beside an unregistered foreign payee is hidden from a complete total', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  identity(f, 'alpha', 'Vendor Alpha');
  f.add('exact', 'Deposit', 'Vendor Alpha', { cents: 1000 });
  f.add('short', 'Vendor Alpha payment', 'Vendor Gamma', { cents: 2500 });
  const income = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.ok(income.ledger, 'ledger answer reached');
  listed(income, 2500, 'registered name, shorthand beside a foreign payee');
  notComplete(income, 'registered name, shorthand beside a foreign payee');
  assert.deepEqual(cents(income).sort(), [1000, 2500], 'the exact row and the shorthand row are both cited');
  // Triage decided: listed as an unattributed deposit with the shorthand reason.
  assert.match(income.answer, /Unattributed deposit: \$25\.00 [^\n]*uncertain because shorthand cannot rule out another payer/);
  const arrived = await f.ask('Did the payment from Vendor Alpha arrive in October 2026?');
  assert.notEqual(arrived.evidence_gate.complete, true, `payment answer complete while the shorthand row is hidden: ${arrived.answer}`);
  // Unregistered requested name, same shape.
  const g = ledgerFixture(t, { knownPayers: false });
  g.add('exact', 'Deposit', 'Supplier Unit', { cents: 1000 });
  g.add('short', 'Supplier Unit payment', 'Vendor Gamma', { cents: 2500 });
  const unregistered = await g.ask('How much income came from Supplier Unit in October 2026?');
  listed(unregistered, 2500, 'unregistered name, shorthand beside a foreign payee');
  notComplete(unregistered, 'unregistered name, shorthand beside a foreign payee');
  assert.deepEqual(cents(unregistered).sort(), [1000, 2500]);
  assert.match(unregistered.answer, /Unattributed deposit: \$25\.00 [^\n]*uncertain because shorthand cannot rule out another payer/);
});

test('R4-MONEY-4 control: the same shorthand with no payee, or the bare name beside the foreign payee, is listed and blocks completeness; the shorthand row alone is listed; the exact row alone is complete', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  identity(f, 'alpha', 'Vendor Alpha');
  f.add('exact', 'Deposit', 'Vendor Alpha', { cents: 1000 });
  f.add('short', 'Vendor Alpha payment', null, { cents: 2500 });
  const noPayee = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.equal(noPayee.evidence_gate.complete, false);
  assert.equal(noPayee.ledger.total_minor, null);
  assert.equal(noPayee.ledger.unattributed_count, 1);
  assert.deepEqual(cents(noPayee).sort(), [1000, 2500]);
  assert.match(noPayee.answer, /uncertain because shorthand cannot rule out another payer/);
  f.raw("UPDATE fin_transactions SET description='Vendor Alpha', payee='Vendor Gamma' WHERE txn_uid='short'");
  const bare = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.equal(bare.evidence_gate.complete, false);
  assert.equal(bare.ledger.total_minor, null);
  assert.equal(bare.ledger.unattributed_count, 1);
  // Without the exact row the shorthand-beside-foreign-payee row is listed:
  // the branch itself cannot say who paid it.
  f.raw("UPDATE fin_transactions SET description='Vendor Alpha payment' WHERE txn_uid='short'");
  f.raw("DELETE FROM fin_transactions WHERE txn_uid='exact'");
  const shorthandAlone = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.equal(shorthandAlone.evidence_gate.complete, false);
  assert.equal(shorthandAlone.ledger.unattributed_count, 1);
  assert.deepEqual(cents(shorthandAlone), [2500]);
  f.raw("DELETE FROM fin_transactions WHERE txn_uid='short'");
  f.add('exact', 'Deposit', 'Vendor Alpha', { cents: 1000 });
  const alone = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.equal(alone.evidence_gate.complete, true);
  assert.equal(alone.ledger.total_minor, 1000);
});

// ---------------------------------------------------------------------------
// R4-MONEY-5: a bounded payee or labelled sender that differs from the
// question by one closed company suffix ("Vendor Alpha Inc" for "Vendor
// Alpha"), by a trailing word ("Vendor Alpha Holdings"), or by being its
// prefix ("Vendor Alpha" for "Vendor Alpha Holdings") is an unattributed
// candidate when it is the only row (complete=false, listed), and payee-vs-
// sender agreement treats the suffix difference as EXACT (answer 8,
// agreementName). Yet beside an exact row the same field is "known"
// (ledger-answer.js:272-273: a non-conflicting bounded field that does not
// equal the key), so the row is neither counted nor listed and the total is
// complete. The outflow side does the same: matched is payee equality or a
// unique alias (:234-238) and possible is matchesMerchant(), which compares
// a payee by equality too, so "Supply Unit Inc" is hidden behind "Supply
// Unit". Alone it is "No matching transactions" (incomplete). Adding an
// exact row therefore REMOVES the doubt the branch records for the variant
// row on its own. The contract calls a shortened name or a substring a
// possible match with a partial subtotal and a visible note.
test('R4-MONEY-5 a payee or sender differing from the question by a suffix, a trailing word or a prefix is hidden beside an exact row on both sides', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  identity(f, 'alpha', 'Vendor Alpha');
  f.add('exact', 'Deposit', 'Vendor Alpha', { cents: 1000 });
  f.add('variant', 'Deposit', 'Vendor Alpha Inc', { cents: 2500 });
  const registered = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.ok(registered.ledger, 'ledger answer reached');
  listed(registered, 2500, 'inflow, registered question, suffix payee');
  notComplete(registered, 'inflow, registered question, suffix payee');
  // Triage decided: both rows cited.
  assert.deepEqual(cents(registered).sort(), [1000, 2500], 'inflow, registered question, suffix payee: both rows cited');
  const arrived = await f.ask('Did the payment from Vendor Alpha arrive in October 2026?');
  assert.notEqual(arrived.evidence_gate.complete, true, `payment answer complete while the suffix payee row is hidden: ${arrived.answer}`);
  // The same for a punctuated suffix, for a suffix payee with its own sender,
  // for a payee that contains the name as whole words, and for a labelled
  // sender with the suffix and no payee at all.
  for (const [payee, description] of [['Vendor Alpha, Inc.', 'Deposit'], ['Vendor Alpha Inc', 'FROM: Vendor Alpha Inc; REF: 100000'],
    ['Vendor Alpha Holdings', 'Deposit'], [null, 'FROM: Vendor Alpha Inc']]) {
    f.raw("UPDATE fin_transactions SET payee=?, description=? WHERE txn_uid='variant'", payee, description);
    const variant = await f.ask('How much income came from Vendor Alpha in October 2026?');
    listed(variant, 2500, `inflow, ${payee} / ${description}`);
    notComplete(variant, `inflow, ${payee} / ${description}`);
    assert.deepEqual(cents(variant).sort(), [1000, 2500], `inflow, ${payee} / ${description}: both rows cited`);
    const variantArrived = await f.ask('Did the payment from Vendor Alpha arrive in October 2026?');
    assert.notEqual(variantArrived.evidence_gate.complete, true, `payment, ${payee} / ${description}: ${variantArrived.answer}`);
  }
  // The reverse shape: the question is the longer registered name and the
  // bounded payee is its prefix.
  const r = ledgerFixture(t, { knownPayers: false });
  identity(r, 'holdings', 'Vendor Alpha Holdings');
  r.add('exact', 'Deposit', 'Vendor Alpha Holdings', { cents: 1000 });
  r.add('variant', 'Deposit', 'Vendor Alpha', { cents: 2500 });
  const prefix = await r.ask('How much income came from Vendor Alpha Holdings in October 2026?');
  listed(prefix, 2500, 'inflow, prefix payee');
  notComplete(prefix, 'inflow, prefix payee');
  assert.deepEqual(cents(prefix).sort(), [1000, 2500], 'inflow, prefix payee: both rows cited');
  // Unregistered requested name, same shape.
  const g = ledgerFixture(t, { knownPayers: false });
  g.add('exact', 'Deposit', 'Supplier Unit', { cents: 1000 });
  g.add('variant', 'Deposit', 'Supplier Unit LLC', { cents: 2500 });
  const unregistered = await g.ask('How much income came from Supplier Unit in October 2026?');
  listed(unregistered, 2500, 'inflow, unregistered question');
  notComplete(unregistered, 'inflow, unregistered question');
  assert.deepEqual(cents(unregistered).sort(), [1000, 2500], 'inflow, unregistered question: both rows cited');
  // Outflow: answer 1 (a) fixes the shape, the exact row as a partial
  // subtotal and the variant row listed as a possible match.
  const h = ledgerFixture(t, { knownPayers: false });
  h.add('exact', 'Purchase', 'Supply Unit', { direction: 'outflow', cents: 1000 });
  h.add('variant', 'Purchase', 'Supply Unit Inc', { direction: 'outflow', cents: 2500 });
  const outflow = await h.ask('How much did I spend at Supply Unit in October 2026?');
  listed(outflow, 2500, 'outflow, suffix payee');
  notComplete(outflow, 'outflow, suffix payee');
  assert.equal(outflow.ledger.confirmed_subtotal_minor, 1000);
  assert.equal(outflow.ledger.possible_count, 1);
  assert.match(outflow.answer, /Possible match: \$25\.00/, 'outflow, suffix payee: the $25 row is a possible match');
  const k = ledgerFixture(t, { knownPayers: false });
  k.add('exact', 'Purchase', 'Supply Unit Holdings', { direction: 'outflow', cents: 1000 });
  k.add('variant', 'Purchase', 'Supply Unit', { direction: 'outflow', cents: 2500 });
  const outflowPrefix = await k.ask('How much did I spend at Supply Unit Holdings in October 2026?');
  listed(outflowPrefix, 2500, 'outflow, prefix payee');
  notComplete(outflowPrefix, 'outflow, prefix payee');
  // Triage decided: the same answer-1(a) shape as the suffix case.
  assert.equal(outflowPrefix.ledger.confirmed_subtotal_minor, 1000);
  assert.equal(outflowPrefix.ledger.possible_count, 1);
  assert.match(outflowPrefix.answer, /Possible match: \$25\.00/, 'outflow, prefix payee: the $25 row is a possible match');
});

test('R4-MONEY-5 control: the variant row alone is an unattributed candidate or an unmatched name, an agreeing sender counts (answer 8), and the exact row alone is complete', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  identity(f, 'alpha', 'Vendor Alpha');
  f.add('variant', 'Deposit', 'Vendor Alpha Inc', { cents: 2500 });
  const alone = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.equal(alone.evidence_gate.complete, false);
  assert.equal(alone.ledger.total_minor, null);
  assert.equal(alone.ledger.unattributed_count, 1);
  assert.deepEqual(cents(alone), [2500]);
  f.raw("UPDATE fin_transactions SET payee=NULL, description='FROM: Vendor Alpha Inc' WHERE txn_uid='variant'");
  const senderAlone = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.equal(senderAlone.evidence_gate.complete, false);
  assert.equal(senderAlone.ledger.unattributed_count, 1);
  assert.deepEqual(cents(senderAlone), [2500]);
  // Answer 8 unchanged: a suffix payee whose labelled sender equals the
  // question exactly is EXACT agreement, so it counts beside an exact row.
  f.add('exact', 'Deposit', 'Vendor Alpha', { cents: 1000 });
  f.raw("UPDATE fin_transactions SET payee='Vendor Alpha Inc', description='FROM: Vendor Alpha' WHERE txn_uid='variant'");
  const agreed = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.equal(agreed.evidence_gate.complete, true, agreed.answer);
  assert.equal(agreed.ledger.total_minor, 3500);
  f.raw("DELETE FROM fin_transactions WHERE txn_uid='variant'");
  const exact = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.equal(exact.evidence_gate.complete, true);
  assert.equal(exact.ledger.total_minor, 1000);
  const r = ledgerFixture(t, { knownPayers: false });
  identity(r, 'holdings', 'Vendor Alpha Holdings');
  r.add('variant', 'Deposit', 'Vendor Alpha', { cents: 2500 });
  const prefixAlone = await r.ask('How much income came from Vendor Alpha Holdings in October 2026?');
  assert.equal(prefixAlone.evidence_gate.complete, false);
  assert.equal(prefixAlone.ledger.unattributed_count, 1);
  const g = ledgerFixture(t, { knownPayers: false });
  g.add('variant', 'Purchase', 'Supply Unit Inc', { direction: 'outflow', cents: 2500 });
  const outflowAlone = await g.ask('How much did I spend at Supply Unit in October 2026?');
  assert.equal(outflowAlone.evidence_gate.complete, false);
  assert.equal(outflowAlone.ledger.total_minor, null);
  assert.notEqual(outflowAlone.ledger.found, true);
  g.raw("UPDATE fin_transactions SET payee='Supply Unit', amount_minor=1000");
  const outflowExact = await g.ask('How much did I spend at Supply Unit in October 2026?');
  assert.equal(outflowExact.evidence_gate.complete, true);
  assert.equal(outflowExact.ledger.total_minor, 1000);
});

// ---------------------------------------------------------------------------
// R4-MONEY-6: outflow matched rows are payee equality or a payee that is a
// UNIQUE alias of the question's slug (ledger-answer.js:237 `aliases?.size
// === 1`). A payee that is a registered alias of the requested entity AND of
// another ("Shared Label" for both merchant and other) is neither matched nor
// possible (matchesMerchant compares the payee to the question text), so it
// is hidden and the total is complete. The inflow side with the same data
// lists the row (its lookup is ambiguous, so attribution is unknown) and
// leaves the answer incomplete. The sides disagree, and the outflow total
// is complete while a bounded payee registered to the requested entity is
// unaccounted for.
test('R4-MONEY-6 outflow hides a payee that is a shared alias of the requested entity beside an exact row', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  identity(f, 'merchant', 'Registered Alias', 'Shared Label');
  identity(f, 'other', 'Other Merchant', 'Shared Label');
  f.add('exact', 'Purchase', 'Registered Alias', { direction: 'outflow', cents: 1000 });
  f.add('shared', 'Purchase', 'Shared Label', { direction: 'outflow', cents: 2500 });
  const outflow = await f.ask('How much did I spend at Registered Alias in October 2026?');
  assert.ok(outflow.ledger, 'ledger answer reached');
  listed(outflow, 2500, 'outflow, shared alias beside an exact row');
  notComplete(outflow, 'outflow, shared alias beside an exact row');
  // Answer 1 (a) shape: the exact row is a partial subtotal.
  assert.equal(outflow.ledger.confirmed_subtotal_minor, 1000);
  assert.equal(outflow.ledger.possible_count, 1);
  // Triage decided: both rows cited, the $25 row as a possible match.
  assert.deepEqual(cents(outflow).sort(), [1000, 2500]);
  assert.match(outflow.answer, /Possible match: \$25\.00/);
});

test('R4-MONEY-6 control: the inflow side lists the shared-alias row; a unique alias counts on the outflow side', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  identity(f, 'merchant', 'Registered Alias', 'Shared Label');
  identity(f, 'other', 'Other Merchant', 'Shared Label');
  f.add('exact', 'Deposit', 'Registered Alias', { cents: 1000 });
  f.add('shared', 'Deposit', 'Shared Label', { cents: 2500 });
  const inflow = await f.ask('How much income came from Registered Alias in October 2026?');
  assert.equal(inflow.evidence_gate.complete, false);
  assert.equal(inflow.ledger.total_minor, null);
  assert.equal(inflow.ledger.unattributed_count, 1);
  assert.deepEqual(cents(inflow).sort(), [1000, 2500]);
  const g = ledgerFixture(t, { knownPayers: false });
  identity(g, 'merchant', 'Registered Alias', 'Unique Label');
  g.add('exact', 'Purchase', 'Registered Alias', { direction: 'outflow', cents: 1000 });
  g.add('alias', 'Purchase', 'Unique Label', { direction: 'outflow', cents: 2500 });
  const unique = await g.ask('How much did I spend at Registered Alias in October 2026?');
  assert.equal(unique.evidence_gate.complete, true);
  assert.equal(unique.ledger.total_minor, 3500);
  assert.deepEqual(cents(unique).sort(), [1000, 2500]);
});
