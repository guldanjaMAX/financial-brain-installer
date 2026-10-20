import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { createInflowAttributor, payerRegistry } from '../src/lib/ledger-attribution.js';

// Partner review, round 3, money-contract lens, round 2 (reviewing
// partner/fix-0418-3 at a299c22). Repros fail; controls pass. Synthetic
// role-word names only.
const identity = (f, slug, name) => f.raw(
  "INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at) VALUES (?,?,'business','owned','owner_stated','confirmed',?)",
  slug, name, NOW);
const twoPayers = () => payerRegistry([{ entity_slug: 'alpha', legal_name: 'Vendor Alpha' }, { entity_slug: 'beta', legal_name: 'Vendor Beta' }]);

function conflictRow(t, description) {
  const f = ledgerFixture(t, { knownPayers: false });
  identity(f, 'alpha', 'Vendor Alpha');
  identity(f, 'beta', 'Vendor Beta');
  f.add('conflict', description, 'Vendor Alpha', { cents: 1000 });
  return f;
}

// ---------------------------------------------------------------------------
// R3-MONEY-2-1: the round 1 fix (a299c22) exempts the 'incomplete' refusal
// on the stated ground that the parser "read the whole text and found no
// sender field". That is not what 'incomplete' means: it means no COMPLETE
// parse survived. A labelled sender followed by an unparseable tail (an
// unknown label such as "ID:", a line break, any non-grammar field) yields
// zero parses, so labelled_senders is [] and attributeRow() decides the payee
// alone. The payee entity gets a complete total; the sender named on the
// statement line gets a certified $0 and a certified absence.
const UNKNOWN_TAIL = 'FROM: Vendor Beta; ID: 123';
const LINE_BREAK_TAIL = 'FROM: Vendor Beta\nID: 123';
const KNOWN_TAIL = 'FROM: Vendor Beta; REF: 100000';

test('R3-MONEY-2-1 attributeRow confirms the payee over a labelled sender the incomplete parse dropped', () => {
  const violations = [];
  for (const description of [UNKNOWN_TAIL, LINE_BREAK_TAIL]) {
    const decided = createInflowAttributor(twoPayers())({ description, payee: 'Vendor Alpha' });
    assert.equal(decided.evidence.parser.refusal, 'incomplete', 'the incomplete refusal was reached');
    if (decided.state !== 'unknown') violations.push({ description, state: decided.state, entity_slug: decided.entity_slug,
      labelled_senders: decided.evidence.labelled_senders });
  }
  assert.deepEqual(violations, []);
});

test('R3-MONEY-2-1 incomplete parse: the payee entity gets a complete total over the disagreeing labelled sender', async t => {
  const f = conflictRow(t, UNKNOWN_TAIL);
  const income = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.ok(income.ledger, 'ledger answer reached');
  assert.notEqual(income.evidence_gate.complete, true, `complete payee total over a labelled sender naming another payer: ${income.answer}`);
  assert.equal(income.ledger.total_minor, null);
});

test('R3-MONEY-2-1 incomplete parse: the labelled sender gets a certified $0 and a certified absence', async t => {
  const f = conflictRow(t, UNKNOWN_TAIL);
  const zero = await f.ask('How much income came from Vendor Beta in October 2026?');
  assert.ok(zero.ledger);
  assert.ok(!(zero.evidence_gate.complete === true && zero.ledger.total_minor === 0),
    `certified $0 for the payer named by the statement's FROM field: ${zero.answer}`);
  const absent = await f.ask('Did the payment from Vendor Beta arrive in October 2026?');
  assert.notEqual(absent.ledger.found, false, `certified absence: ${absent.answer}`);
  assert.notEqual(absent.evidence_gate.complete, true);
});

test('R3-MONEY-2-1 control: the same sender with a grammar tail is read, so the row is unknown and neither payer is certified', async t => {
  const decided = createInflowAttributor(twoPayers())({ description: KNOWN_TAIL, payee: 'Vendor Alpha' });
  assert.equal(decided.state, 'unknown');
  assert.equal(decided.evidence.parser.refusal, null);
  assert.deepEqual(decided.evidence.labelled_senders.map(s => s.identity), ['Vendor Beta']);
  const f = conflictRow(t, KNOWN_TAIL);
  const beta = await f.ask('How much income came from Vendor Beta in October 2026?');
  assert.equal(beta.evidence_gate.complete, false);
  assert.equal(beta.ledger.total_minor, null);
  const alpha = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.equal(alpha.evidence_gate.complete, false);
  assert.equal(alpha.ledger.total_minor, null);
  const absent = await f.ask('Did the payment from Vendor Beta arrive in October 2026?');
  assert.equal(absent.ledger.found, null);
});

test('R3-MONEY-2-1 control: an incomplete parse with NO sender field still lets the exact payee stand', async t => {
  // "NOTE: something" carries no sender label; the payee is the only
  // bounded payer field, so the exact registered payee is a complete total.
  const decided = createInflowAttributor(twoPayers())({ description: 'ID: 123; NOTE: something', payee: 'Vendor Alpha' });
  assert.equal(decided.state, 'confirmed');
  assert.equal(decided.entity_slug, 'alpha');
  const f = conflictRow(t, 'ID: 123; NOTE: something');
  const alpha = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.equal(alpha.evidence_gate.complete, true);
  assert.equal(alpha.ledger.total_minor, 1000);
});

// ---------------------------------------------------------------------------
// R3-MONEY-2-2 (contract decision): the parser grades an unlabelled whole
// opening name followed by a grammar field ("Vendor Beta; REF: 100000") as a
// CONFIRMED reading of Vendor Beta when the row has no payee. The same text
// beside a payee is discarded without a trace: only labelled senders enter
// the payee agreement check. The payee entity gets a complete total and the
// entity the parser itself confirmed from the description gets a certified
// $0 and absence. The stated contract limits agreement to "a labelled
// sender", so this is a contract question, not a defect against it.
const BARE_SENDER = 'Vendor Beta; REF: 100000';

test('R3-MONEY-2-2 the parser confirms the bare opening name alone, then ignores it beside a payee', () => {
  const alone = createInflowAttributor(twoPayers())({ description: BARE_SENDER, payee: null });
  assert.equal(alone.state, 'confirmed', 'without a payee the description is a confirmed Vendor Beta reading');
  assert.equal(alone.entity_slug, 'beta');
  const beside = createInflowAttributor(twoPayers())({ description: BARE_SENDER, payee: 'Vendor Alpha' });
  assert.notEqual(beside.state, 'confirmed', `a confirmed-grade description reading of beta was silently overruled: ${JSON.stringify(beside)}`);
});

test('R3-MONEY-2-2 bare opening name: the payer the parser confirmed from the description gets a certified $0 and absence', async t => {
  const f = conflictRow(t, BARE_SENDER);
  const zero = await f.ask('How much income came from Vendor Beta in October 2026?');
  assert.ok(zero.ledger);
  assert.ok(!(zero.evidence_gate.complete === true && zero.ledger.total_minor === 0),
    `certified $0 for a payer the parser confirms from this row's description: ${zero.answer}`);
  const absent = await f.ask('Did the payment from Vendor Beta arrive in October 2026?');
  assert.notEqual(absent.ledger.found, false, `certified absence: ${absent.answer}`);
});

test('R3-MONEY-2-2 control: the same name under a FROM label is a labelled sender, so the row is unknown', async t => {
  const beside = createInflowAttributor(twoPayers())({ description: `FROM: ${BARE_SENDER}`, payee: 'Vendor Alpha' });
  assert.equal(beside.state, 'unknown');
  const f = conflictRow(t, `FROM: ${BARE_SENDER}`);
  const beta = await f.ask('How much income came from Vendor Beta in October 2026?');
  assert.equal(beta.evidence_gate.complete, false);
  assert.equal(beta.ledger.total_minor, null);
  // And without any payee the bare name is answered as Vendor Beta's income.
  f.raw("UPDATE fin_transactions SET payee=NULL, description=?", BARE_SENDER);
  const alone = await f.ask('How much income came from Vendor Beta in October 2026?');
  assert.equal(alone.evidence_gate.complete, true);
  assert.equal(alone.ledger.total_minor, 1000);
});
