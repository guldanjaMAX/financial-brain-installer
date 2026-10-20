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
// R3-MONEY-3-2 (decided by partner answer 8): a REGISTERED labelled sender
// beside an UNREGISTERED payee that differs only by a closed trailing company
// suffix ("Vendor Alpha Inc" / "FROM: Vendor Alpha") is EXACT agreement, as
// decided in R4B. attributeRow confirmed it through agreementName while
// boundedPayerFields compared plain normalized names and flagged a conflict;
// boundedPayerFields now uses the same agreementName rule. The repro's original
// expectation (no complete total, no $0 / absence for the other payer) was the
// contract question, and the answer reverses it: Vendor Alpha gets a complete
// exact total, and Vendor Beta gets what the contract then allows, which is
// exactly what it gets beside an identical payee spelling. The R4B unregistered
// suffix pair follows the same rule (partner-r4-boundaries.test.mjs).
const SUFFIX_PAYEE = 'Vendor Alpha Inc';
const REGISTERED_SENDER = 'FROM: Vendor Alpha; REF: 100000';

function suffixRow(t) {
  const f = ledgerFixture(t, { knownPayers: false });
  identity(f, 'alpha', 'Vendor Alpha');
  identity(f, 'beta', 'Vendor Beta');
  f.add('suffix', REGISTERED_SENDER, SUFFIX_PAYEE, { cents: 1000 });
  return f;
}

test('R3-MONEY-3-2 suffix-only agreement with a registered sender is EXACT agreement and a complete income total', async t => {
  const row = { description: REGISTERED_SENDER, payee: SUFFIX_PAYEE };
  const decided = createInflowAttributor(twoPayers())(row);
  assert.equal(decided.state, 'confirmed');
  assert.equal(decided.entity_slug, 'alpha');
  assert.equal(boundedPayerFields(row, decided, twoPayers()).conflict, false, 'the bounded fields agree once the closed suffix is ignored');
  const f = suffixRow(t);
  const income = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.ok(income.ledger, 'ledger answer reached');
  assert.deepEqual(cents(income), [1000], 'the row is read');
  assert.equal(income.evidence_gate.complete, true, `exact agreement after the closed suffix: ${income.answer}`);
  assert.equal(income.ledger.total_minor, 1000);
  assert.equal(income.ledger.total_is_exact, true);
  const found = await f.ask('Did the payment from Vendor Alpha arrive in October 2026?');
  assert.equal(found.ledger.found, true);
  assert.equal(found.evidence_gate.complete, true);
});

test('R3-MONEY-3-2 the other registered payer is certified only as it is beside an identical payee spelling', async t => {
  const f = suffixRow(t);
  const zero = await f.ask('How much income came from Vendor Beta in October 2026?');
  const absent = await f.ask('Did the payment from Vendor Beta arrive in October 2026?');
  // The contract allows a zero and an absence for Vendor Beta here only
  // because the one receipt in scope is an EXACT, confirmed Vendor Alpha row.
  // The suffix spelling must decide exactly as the identical spelling does.
  f.raw('UPDATE fin_transactions SET payee=?', 'Vendor Alpha');
  const zeroIdentical = await f.ask('How much income came from Vendor Beta in October 2026?');
  const absentIdentical = await f.ask('Did the payment from Vendor Beta arrive in October 2026?');
  for (const [suffixed, identical] of [[zero, zeroIdentical], [absent, absentIdentical]]) {
    assert.deepEqual(suffixed.evidence_gate, identical.evidence_gate);
    assert.equal(suffixed.ledger.found, identical.ledger.found);
    assert.equal(suffixed.ledger.total_minor, identical.ledger.total_minor);
    assert.deepEqual(cents(suffixed), cents(identical));
  }
  assert.equal(zero.evidence_gate.complete, true);
  assert.equal(zero.ledger.total_minor, 0);
  assert.equal(absent.ledger.found, false);
});

test('R3-MONEY-3-2 control: exact agreement is complete; the R4B unregistered suffix pair is EXACT too; a wider difference stays unknown', async t => {
  const f = suffixRow(t);
  f.raw('UPDATE fin_transactions SET payee=?', 'Vendor Alpha');
  const exact = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.equal(exact.evidence_gate.complete, true);
  assert.equal(exact.ledger.total_minor, 1000);
  assert.equal(exact.ledger.total_is_exact, true);
  // A payee that differs by more than a closed suffix is no agreement: the
  // row is unknown and neither registered payer gets a complete figure.
  f.raw('UPDATE fin_transactions SET payee=?', 'Vendor Alpha Holdings');
  for (const name of ['Vendor Alpha', 'Vendor Beta']) {
    const wider = await f.ask(`How much income came from ${name} in October 2026?`);
    assert.equal(wider.evidence_gate.complete, false);
    assert.equal(wider.ledger.total_minor, null);
    assert.equal(wider.ledger.unattributed_count, 1);
  }
  // The R4B pair: neither spelling registered, agreement only by suffix. It
  // is the same EXACT agreement, asked by either spelling.
  f.raw('UPDATE fin_transactions SET payee=?, description=?', 'Supplier Unit', 'FROM: Supplier Unit, LLC');
  for (const name of ['Supplier Unit', 'Supplier Unit, LLC']) {
    const found = await f.ask(`Did the payment from ${name} arrive in October 2026?`);
    assert.equal(found.ledger.found, true);
    const income = await f.ask(`How much income came from ${name} in October 2026?`);
    assert.equal(income.evidence_gate.complete, true);
    assert.equal(income.ledger.total_minor, 1000);
    assert.equal(income.ledger.total_is_exact, true);
  }
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
// After partner answer 8 the suffix row is EXACT agreement and no longer a
// bounded-field conflict, so this fixture takes the exact path: the shorthand
// row is listed as an unattributed deposit with its shorthand reason (the
// 3-3 control's behaviour). The literalConflict guard in ledgerAnswer stays.
test('R3-MONEY-3-3 the literal.conflict fallback adds a shorthand row to a total with a complete gate', async t => {
  const f = suffixRow(t);
  f.add('bare', 'Vendor Alpha deposit', null, { cents: 2500 });
  const income = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.ok(income.ledger, 'ledger answer reached');
  assert.deepEqual(cents(income).sort(), [1000, 2500], 'both rows are read');
  assert.equal(income.ledger.unattributed_count, 1, 'the shorthand row is listed beside the exact row');
  assert.match(income.answer, /Unattributed deposit: \$25\.00 [^\n]*uncertain because shorthand cannot rule out another payer/,
    'the shorthand reading is declared');
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
