import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { createInflowAttributor, payerRegistry } from '../src/lib/ledger-attribution.js';

// Partner review, round 3, money-contract lens. Repros fail on 2f5e9ad5;
// controls pass. Synthetic role-word names only.
const identity = (f, slug, name) => f.raw(
  "INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at) VALUES (?,?,'business','owned','owner_stated','confirmed',?)",
  slug, name, NOW);
const cents = body => body.citations.map(c => c.amount_minor);
// 797 code points: the labelled sender is syntactically valid, but the whole
// description exceeds the 512-code-point parser cap, so the parse is refused.
const OVER_CAP = 'FROM: Vendor Beta; ' + Array.from({ length: 60 }, (_, i) => `REF: ${100000 + i}`).join('; ');
const OUT_OF_ALPHABET = 'FROM: Vendor Beta * REF 100000';
const IN_CAP = 'FROM: Vendor Beta; REF: 100000';

function twoRegisteredPayers(t, description) {
  const f = ledgerFixture(t, { knownPayers: false });
  identity(f, 'alpha', 'Vendor Alpha');
  identity(f, 'beta', 'Vendor Beta');
  f.add('conflict', description, 'Vendor Alpha', { cents: 1000 });
  return f;
}

// ---------------------------------------------------------------------------
// R3-MONEY-1-1..3: a payee row whose description names a DIFFERENT registered
// sender is unknown (R2-A3) only when the parser reads that sender. When the
// parse is refused for a parser-own reason (length-limit, alphabet,
// operation-limit) attributeRow() sees no labelled sender and decides the
// payee as confirmed. The payee entity then gets a complete total and the
// labelled payer a certified $0 / "No matching deposit".
test('R3-MONEY-1-1 over-cap description hides a disagreeing labelled sender; the payee gets a complete total', async t => {
  const f = twoRegisteredPayers(t, OVER_CAP);
  const income = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.ok(income.ledger, 'ledger answer reached');
  assert.notEqual(income.evidence_gate.complete, true, `complete payee total over an unread disagreeing sender: ${income.answer}`);
  assert.equal(income.ledger.total_minor, null);
});

test('R3-MONEY-1-2 over-cap description: the hidden labelled payer gets a certified $0 and absence', async t => {
  const f = twoRegisteredPayers(t, OVER_CAP);
  const zero = await f.ask('How much income came from Vendor Beta in October 2026?');
  assert.ok(zero.ledger);
  assert.ok(!(zero.evidence_gate.complete === true && zero.ledger.total_minor === 0),
    `certified $0 for a payer named in the row's description: ${zero.answer}`);
  const absent = await f.ask('Did the payment from Vendor Beta arrive in October 2026?');
  assert.notEqual(absent.ledger.found, false, `certified absence: ${absent.answer}`);
  assert.notEqual(absent.evidence_gate.complete, true);
});

test('R3-MONEY-1-3 out-of-alphabet description (a star) hides the same disagreeing sender', async t => {
  const f = twoRegisteredPayers(t, OUT_OF_ALPHABET);
  const zero = await f.ask('How much income came from Vendor Beta in October 2026?');
  assert.ok(zero.ledger);
  assert.ok(!(zero.evidence_gate.complete === true && zero.ledger.total_minor === 0),
    `certified $0 for a payer named in the row's description: ${zero.answer}`);
  const income = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.notEqual(income.evidence_gate.complete, true, `complete payee total: ${income.answer}`);
});

test('R3-MONEY-1-4 attributeRow confirms the payee on length, alphabet and operation-limit refusals', () => {
  const registry = payerRegistry([{ entity_slug: 'alpha', legal_name: 'Vendor Alpha' }, { entity_slug: 'beta', legal_name: 'Vendor Beta' }]);
  const violations = [];
  for (const [refusal, description, options] of [
    ['length-limit', OVER_CAP, {}],
    ['alphabet', OUT_OF_ALPHABET, {}],
    ['operation-limit', 'FROM: Vendor Beta ' + Array(200).fill('A').join(' '), { stepLimit: 1024 }],
  ]) {
    const decided = createInflowAttributor(registry, options)({ description, payee: 'Vendor Alpha' });
    assert.equal(decided.evidence.parser.refusal, refusal, 'the intended refusal was reached');
    if (decided.state !== 'unknown') violations.push({ refusal, state: decided.state, entity_slug: decided.entity_slug });
  }
  assert.deepEqual(violations, []);
});

test('R3-MONEY-1-1 control: the same sender inside the cap is unknown, so neither payer gets a complete figure', async t => {
  const registry = payerRegistry([{ entity_slug: 'alpha', legal_name: 'Vendor Alpha' }, { entity_slug: 'beta', legal_name: 'Vendor Beta' }]);
  const decided = createInflowAttributor(registry)({ description: IN_CAP, payee: 'Vendor Alpha' });
  assert.equal(decided.state, 'unknown');
  assert.equal(decided.evidence.parser.refusal, null);
  const f = twoRegisteredPayers(t, IN_CAP);
  const beta = await f.ask('How much income came from Vendor Beta in October 2026?');
  assert.equal(beta.evidence_gate.complete, false);
  assert.equal(beta.ledger.total_minor, null);
  const alpha = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.equal(alpha.evidence_gate.complete, false);
  assert.equal(alpha.ledger.total_minor, null);
  const absent = await f.ask('Did the payment from Vendor Beta arrive in October 2026?');
  assert.equal(absent.ledger.found, null);
  // An agreeing in-cap sender still confirms the exact registered payee.
  f.raw("UPDATE fin_transactions SET description='FROM: Vendor Alpha; REF: 100000'");
  const agreed = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.equal(agreed.evidence_gate.complete, true);
  assert.equal(agreed.ledger.total_minor, 1000);
});

// ---------------------------------------------------------------------------
// R3-MONEY-1-5 (contract decision): for an OUTFLOW merchant question, one
// exact bounded payee row turns every same-name description-only row into a
// silently omitted row of a COMPLETE total. Without the exact row the same
// rows are "possible matches" with a partial subtotal; on the inflow side the
// same rows are listed as unattributed and the answer stays incomplete.
test('R3-MONEY-1-5 outflow: one exact payee row makes same-name description-only rows vanish from a complete total', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  f.add('exact', 'Purchase', 'Vendor Alpha', { direction: 'outflow', cents: 1000 });
  f.add('bare', 'Vendor Alpha', null, { direction: 'outflow', cents: 2000 });
  f.add('contained', 'CARD PURCHASE Vendor Alpha 1234', null, { direction: 'outflow', cents: 3000 });
  const body = await f.ask('How much did I spend at Vendor Alpha in October 2026?');
  assert.ok(body.ledger);
  const omitted = !cents(body).includes(2000) || !cents(body).includes(3000);
  assert.ok(!(body.evidence_gate.complete === true && omitted),
    `complete total ${body.ledger.total_minor} omits same-name rows without a note: ${body.answer}`);
});

test('R3-MONEY-1-5 control: without the exact row the same rows are possible matches; the inflow analog lists them as unattributed', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  f.add('bare', 'Vendor Alpha', null, { direction: 'outflow', cents: 2000 });
  f.add('contained', 'CARD PURCHASE Vendor Alpha 1234', null, { direction: 'outflow', cents: 3000 });
  const possible = await f.ask('How much did I spend at Vendor Alpha in October 2026?');
  assert.equal(possible.evidence_gate.complete, false);
  assert.equal(possible.ledger.subtotal_is_partial, true);
  assert.equal(possible.ledger.total_minor, null);
  assert.deepEqual(cents(possible).sort(), [2000, 3000]);
  assert.match(possible.answer, /matched by name similarity/);
  f.raw('DELETE FROM fin_transactions');
  f.add('exact', 'Deposit', 'Vendor Alpha', { cents: 1000 });
  f.add('bare', 'Vendor Alpha', null, { cents: 2000 });
  f.add('contained', 'CARD DEPOSIT Vendor Alpha 1234', null, { cents: 3000 });
  const income = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.equal(income.evidence_gate.complete, false);
  assert.equal(income.ledger.total_minor, null);
  assert.equal(income.ledger.unattributed_count, 2);
  assert.deepEqual(cents(income).sort(), [1000, 2000, 3000]);
});
