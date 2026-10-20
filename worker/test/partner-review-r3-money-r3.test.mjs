import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { createInflowAttributor, payerRegistry, boundedPayerFields } from '../src/lib/ledger-attribution.js';

// Partner review, round 3, money-contract lens, round 3 (reviewing
// partner/fix-0418-3 at e6f1ca2). Repros fail; controls pass. Synthetic
// role-word names only.
const identity = (f, slug, name) => f.raw(
  "INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at) VALUES (?,?,'business','owned','owner_stated','confirmed',?)",
  slug, name, NOW);
const twoPayers = () => payerRegistry([{ entity_slug: 'alpha', legal_name: 'Vendor Alpha' }, { entity_slug: 'beta', legal_name: 'Vendor Beta' }]);
const cents = body => body.citations.map(c => c.amount_minor);

// ---------------------------------------------------------------------------
// R3-MONEY-3-1: the round 1 fix exempts a refused description from
// sender_unread when it "is exactly the payee" (descriptionIsPayee). The
// comparison reads row.description, but the reader also supplies
// description_has_nul for drivers that truncate TEXT at NUL (the reason the
// flag exists, per the comment above the parseStatement call). A description
// stored as "Vendor Alpha<NUL>FROM: Vendor Beta" arrives from such a driver
// as "Vendor Alpha" with the flag set: the parser refuses it ('alphabet'),
// the exemption sees text equal to the payee, and the payee is confirmed over
// the unread tail. The same row read whole is unknown (sender_unread).
test('R3-MONEY-3-1 a NUL-flagged description truncated to the payee spelling is confirmed over its unread tail', () => {
  const row = { description: 'Vendor Alpha', description_has_nul: 1, payee: 'Vendor Alpha' };
  const decided = createInflowAttributor(twoPayers())(row);
  assert.equal(decided.evidence.parser.refusal, 'alphabet', 'the NUL flag reached the alphabet refusal');
  assert.equal(decided.state, 'unknown', `damaged description certified the payee: ${JSON.stringify(decided)}`);
  assert.equal(decided.evidence.sender_unread, true);
  assert.equal(boundedPayerFields(row, decided, twoPayers()).conflict, true, 'an unread tail is competing evidence');
});

test('R3-MONEY-3-1 control: the same row read whole, and an unflagged exact description, decide as intended', async t => {
  const registry = twoPayers();
  // Whole string available: the hidden sender is seen, so the row is unknown.
  const whole = createInflowAttributor(registry)({ description: 'Vendor Alpha\0FROM: Vendor Beta', description_has_nul: 1, payee: 'Vendor Alpha' });
  assert.equal(whole.state, 'unknown');
  assert.equal(whole.evidence.sender_unread, true);
  // A flagged description that is not the payee spelling is unknown too.
  const other = createInflowAttributor(registry)({ description: 'Deposit', description_has_nul: 1, payee: 'Vendor Alpha' });
  assert.equal(other.state, 'unknown');
  assert.equal(other.evidence.sender_unread, true);
  // Without the flag an exact-payee description still confirms the payee.
  const clean = createInflowAttributor(registry)({ description: 'Vendor Alpha', payee: 'Vendor Alpha' });
  assert.equal(clean.state, 'confirmed');
  assert.equal(clean.entity_slug, 'alpha');
  // End to end with this fixture's driver (node:sqlite keeps the whole TEXT):
  // the row is a damaged bank field and neither payer gets a complete figure.
  const f = ledgerFixture(t, { knownPayers: false });
  identity(f, 'alpha', 'Vendor Alpha'); identity(f, 'beta', 'Vendor Beta');
  f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,provenance,source_feed,basis_state,recorded_at)
    VALUES ('nul','fixture-account','2026-10-05',1000,'inflow','Vendor Alpha' || char(0) || 'FROM: Vendor Beta','Vendor Alpha','feed','bank-feed:fixture-feed','confirmed',?)`, NOW);
  const alpha = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.equal(alpha.evidence_gate.complete, false);
  assert.equal(alpha.ledger.total_minor, null);
  assert.match(alpha.answer, /damaged bank field/);
  const beta = await f.ask('How much income came from Vendor Beta in October 2026?');
  assert.equal(beta.evidence_gate.complete, false);
  assert.equal(beta.ledger.total_minor, null);
});

// ---------------------------------------------------------------------------
// R3-MONEY-3-2: a REGISTERED labelled sender beside an UNREGISTERED payee that
// differs only by a company suffix ("Vendor Alpha Inc" / "FROM: Vendor Alpha")
// is confirmed by attributeRow's suffix agreement (agreementName), while
// boundedPayerFields flags the same row as a bounded-field conflict
// (keys.size > 1 && !aliases). chooseLiteralSelector then takes the
// literal.conflict fallback ({ intent, attributions }) and the complete
// renderer certifies the total: evidence_gate.complete=true, total_is_exact=
// true, and $0 / absence for every other registered payer. R4B
// (partner-r4-boundaries.test.mjs) pins the precedent for suffix-only
// agreement between unregistered fields: the deposit is found, but the income
// total stays incomplete (total_minor null, attributed_subtotal set).
const SUFFIX_PAYEE = 'Vendor Alpha Inc';
const REGISTERED_SENDER = 'FROM: Vendor Alpha; REF: 100000';

function suffixRow(t) {
  const f = ledgerFixture(t, { knownPayers: false });
  identity(f, 'alpha', 'Vendor Alpha');
  identity(f, 'beta', 'Vendor Beta');
  f.add('suffix', REGISTERED_SENDER, SUFFIX_PAYEE, { cents: 1000 });
  return f;
}

test('R3-MONEY-3-2 suffix-only agreement with a registered sender certifies a complete income total', async t => {
  const row = { description: REGISTERED_SENDER, payee: SUFFIX_PAYEE };
  const decided = createInflowAttributor(twoPayers())(row);
  assert.equal(boundedPayerFields(row, decided, twoPayers()).conflict, true, 'the bounded fields are flagged as a conflict');
  const f = suffixRow(t);
  const income = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.ok(income.ledger, 'ledger answer reached');
  assert.deepEqual(cents(income), [1000], 'the row is read');
  assert.notEqual(income.evidence_gate.complete, true, `complete total over a suffix-only payee agreement: ${income.answer}`);
  assert.equal(income.ledger.total_minor, null);
  assert.notEqual(income.ledger.total_is_exact, true);
});

test('R3-MONEY-3-2 suffix-only agreement certifies $0 and absence for the other registered payer', async t => {
  const f = suffixRow(t);
  const zero = await f.ask('How much income came from Vendor Beta in October 2026?');
  assert.ok(zero.ledger);
  assert.ok(!(zero.evidence_gate.complete === true && zero.ledger.total_minor === 0),
    `certified $0 while the only deposit rests on suffix-only agreement: ${zero.answer}`);
  const absent = await f.ask('Did the payment from Vendor Beta arrive in October 2026?');
  assert.notEqual(absent.ledger.found, false, `certified absence: ${absent.answer}`);
});

test('R3-MONEY-3-2 control: exact agreement is complete; the R4B unregistered suffix pair is found but not complete', async t => {
  const f = suffixRow(t);
  f.raw('UPDATE fin_transactions SET payee=?', 'Vendor Alpha');
  const exact = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.equal(exact.evidence_gate.complete, true);
  assert.equal(exact.ledger.total_minor, 1000);
  assert.equal(exact.ledger.total_is_exact, true);
  // The precedent: neither spelling registered, agreement only by suffix.
  f.raw('UPDATE fin_transactions SET payee=?, description=?', 'Supplier Unit', 'FROM: Supplier Unit, LLC');
  const found = await f.ask('Did the payment from Supplier Unit arrive in October 2026?');
  assert.equal(found.ledger.found, true);
  const partial = await f.ask('How much income came from Supplier Unit in October 2026?');
  assert.equal(partial.evidence_gate.complete, false);
  assert.equal(partial.ledger.total_minor, null);
  assert.equal(partial.ledger.attributed_subtotal_minor, 1000);
  // A suffix payee with no sender at all is an unattributed candidate.
  f.raw('UPDATE fin_transactions SET payee=?, description=?', SUFFIX_PAYEE, 'Deposit');
  const alone = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.equal(alone.evidence_gate.complete, false);
  assert.equal(alone.ledger.unattributed_count, 1);
});

// ---------------------------------------------------------------------------
// R3-MONEY-3-3: the literal.conflict fallback in chooseLiteralSelector
// (ledger-answer.js, `return ... : { intent, attributions }`) discards the
// exact/possible split and re-enters the legacy complete renderer. Once a
// row is both "conflict" (boundedPayerFields) and 'confirmed' (attributeRow;
// the suffix row above), a shorthand row ("Vendor Alpha deposit", state
// 'assumed') rides along: it is added to "Total income", total_minor is set
// and evidence_gate.complete is true. The exact path lists the same shorthand
// row as unattributed and leaves the answer incomplete; a shorthand-only
// answer has total_minor null (ledger-identity-gate.test.mjs).
test('R3-MONEY-3-3 the literal.conflict fallback adds a shorthand row to a total with a complete gate', async t => {
  const f = suffixRow(t);
  f.add('bare', 'Vendor Alpha deposit', null, { cents: 2500 });
  const income = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.ok(income.ledger, 'ledger answer reached');
  assert.deepEqual(cents(income).sort(), [1000, 2500], 'both rows are read');
  assert.ok(income.assumptions?.some(a => a.type === 'payer_shorthand'), 'the shorthand reading is declared');
  assert.notEqual(income.evidence_gate.complete, true, `complete gate over a shorthand row: ${income.answer}`);
  assert.equal(income.ledger.total_minor, null);
  assert.doesNotMatch(income.answer, /^Total income for [^\n]*\$35\.00\./);
});

test('R3-MONEY-3-3 control: beside an exact payee row the same shorthand row is unattributed; alone it is a partial subtotal', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  identity(f, 'alpha', 'Vendor Alpha');
  identity(f, 'beta', 'Vendor Beta');
  f.add('exact', 'Deposit', 'Vendor Alpha', { cents: 1000 });
  f.add('bare', 'Vendor Alpha deposit', null, { cents: 2500 });
  const income = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.equal(income.evidence_gate.complete, false);
  assert.equal(income.ledger.total_minor, null);
  assert.equal(income.ledger.unattributed_count, 1);
  assert.match(income.answer, /Found 1 exact matches; 1 deposits I couldn't attribute/);
  f.raw("DELETE FROM fin_transactions WHERE txn_uid='exact'");
  const alone = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.equal(alone.evidence_gate.complete, false);
  assert.equal(alone.ledger.total_minor, null);
  assert.equal(alone.ledger.subtotal_is_partial, true);
});
