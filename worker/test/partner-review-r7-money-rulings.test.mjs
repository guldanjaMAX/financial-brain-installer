// Partner review, packet 7 round 7: the partner's rulings 11 and 12 and the
// repeated Note line, pinned on partner/fix-0418-3. Rulings 9 and 10 are
// pinned where their held tests were (partner-review-r4-fidelity-r5.test.mjs
// R5-FIDELITY-2, partner-review-r4-money-r5.test.mjs R5-MONEY-4). Every
// name, amount and description here is synthetic, role words only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { attributeInflow, boundedPayerFields, createInflowAttributor, payerRegistry } from '../src/lib/ledger-attribution.js';

const identity = (f, slug, name, label = null) => f.raw(
  "INSERT INTO fin_entities(entity_slug,legal_name,display_label,kind,relationship,provenance,basis_state,recorded_at) VALUES (?,?,?,'business','owned','owner_stated','confirmed',?)",
  slug, name, label, NOW);
const cents = body => body.citations.map(c => c.amount_minor);
const notComplete = (body, label) => {
  assert.ok(body.ledger, `${label}: ledger answer reached`);
  assert.notEqual(body.evidence_gate.complete, true, `${label}: complete gate: ${body.answer}`);
  assert.equal(body.ledger.total_minor ?? null, null, `${label}: a complete total was certified`);
};
const twoPayers = () => payerRegistry([{ entity_slug: 'alpha', legal_name: 'Vendor Alpha' }, { entity_slug: 'beta', legal_name: 'Vendor Beta' }]);
const aliasPayers = () => payerRegistry([{ entity_slug: 'alpha', legal_name: 'Vendor Alpha', display_label: 'Alpha Unit' },
  { entity_slug: 'beta', legal_name: 'Vendor Beta' }]);

// ---------------------------------------------------------------- ruling 11
// Partner ruling 11 (verbatim): "Yes to both. An unlabelled registered
// opening name in an incomplete parse makes the row unknown, and a
// channel-prefixed reading is checked against the payee too: disagreement
// means unknown." Round 4 already applied both (R4-MONEY-2 field-start
// readings, R4-MONEY-3 option A shorthand readings); these pin the two cases
// the ruling names, plus their combination, on both payers' answers.
test('ruling 11: an unlabelled registered opening name in an incomplete parse, and a channel-prefixed reading, beside a different payee make the row unknown', async t => {
  const attribute = createInflowAttributor(twoPayers());
  for (const description of ['Vendor Beta; ID: 123', 'ACH CREDIT Vendor Beta', 'ACH CREDIT Vendor Beta; ID: 123', 'Vendor Beta\nID: 123']) {
    const decided = attribute({ description, payee: 'Vendor Alpha' });
    assert.equal(decided.state, 'unknown', `${description}: ${decided.state} ${String(decided.entity_slug)}`);
    const f = ledgerFixture(t, { knownPayers: false });
    identity(f, 'alpha', 'Vendor Alpha'); identity(f, 'beta', 'Vendor Beta');
    f.add('row', description, 'Vendor Alpha', { cents: 1000 });
    const beta = await f.ask('How much income came from Vendor Beta in October 2026?');
    notComplete(beta, `${description}: Vendor Beta income`);
    assert.deepEqual(cents(beta), [1000], `${description}: the row is listed for Vendor Beta`);
    const payment = await f.ask('Did the payment from Vendor Beta arrive in October 2026?');
    assert.equal(payment.ledger.found, null, `${description}: never absence: ${payment.answer}`);
    assert.notEqual(payment.evidence_gate.complete, true);
    assert.deepEqual(cents(payment), [1000]);
    const alpha = await f.ask('How much income came from Vendor Alpha in October 2026?');
    notComplete(alpha, `${description}: Vendor Alpha income`);
    assert.deepEqual(cents(alpha), [1000], `${description}: the row is listed for Vendor Alpha`);
  }
});

test('ruling 11 control: the payee\'s own name, channel-prefixed or before an unreadable tail, agrees', async t => {
  const attribute = createInflowAttributor(twoPayers());
  for (const description of ['Vendor Alpha; ID: 123', 'ACH CREDIT Vendor Alpha', 'ACH CREDIT Vendor Alpha; ID: 123']) {
    const decided = attribute({ description, payee: 'Vendor Alpha' });
    assert.equal(decided.state, 'confirmed', description);
    assert.equal(decided.entity_slug, 'alpha', description);
    const f = ledgerFixture(t, { knownPayers: false });
    identity(f, 'alpha', 'Vendor Alpha'); identity(f, 'beta', 'Vendor Beta');
    f.add('row', description, 'Vendor Alpha', { cents: 1000 });
    const alpha = await f.ask('How much income came from Vendor Alpha in October 2026?');
    assert.equal(alpha.evidence_gate.complete, true, `${description}: ${alpha.answer}`);
    assert.equal(alpha.ledger.total_minor, 1000, description);
  }
});

// ---------------------------------------------------------------- ruling 12
// Partner ruling 12 (verbatim): "A registered alias and a suffix variant of
// the same identity agree. Make boundedPayerFields resolve aliases through
// the registry the way attributeRow does; if it can't resolve them, the row
// is unknown. Add a test that reaches the literal.conflict fallback." Before
// round 7, payee "Vendor Alpha" with labelled senders "Alpha Unit" (a
// registered alias) and "Vendor Alpha Inc" (a suffix variant) was confirmed
// by attributeRow() but a conflict for boundedPayerFields(), which compared
// the two senders with each other by name and sent the question to the
// literal.conflict fallback.
test('ruling 12: a registered alias and a suffix variant of the same identity agree in boundedPayerFields, as in attributeRow', () => {
  const registry = aliasPayers();
  for (const [description, payee] of [['FROM: Alpha Unit; FROM: Vendor Alpha Inc', 'Vendor Alpha'],
    ['FROM: Vendor Alpha Inc; FROM: Alpha Unit', 'Vendor Alpha'], ['FROM: Vendor Alpha; FROM: Alpha Unit LLC', 'Alpha Unit']]) {
    const row = { description, payee };
    const decided = attributeInflow(row, registry);
    assert.equal(decided.state, 'confirmed', description);
    assert.equal(decided.entity_slug, 'alpha', description);
    assert.equal(boundedPayerFields(row, decided, registry).conflict, false, `${description}: alias and suffix variant of one identity`);
  }
});

test('ruling 12: a row whose bounded fields cannot be resolved to one identity is never confirmed', () => {
  const registry = aliasPayers();
  const names = ['Vendor Alpha', 'Alpha Unit', 'Vendor Alpha Inc', 'Alpha Unit LLC', 'Vendor Beta', 'Vendor Gamma'];
  const senderSets = [[]];
  for (const a of names) { senderSets.push([a]); for (const b of names) if (a !== b) senderSets.push([a, b]); }
  const violations = [];
  let conflicts = 0, agreements = 0;
  for (const payee of [...names, null]) for (const senders of senderSets) {
    if (!payee && !senders.length) continue;
    const row = { description: senders.length ? senders.map(name => `FROM: ${name}`).join('; ') : 'Deposit', payee };
    const decided = attributeInflow(row, registry);
    const bounded = boundedPayerFields(row, decided, registry);
    if (bounded.conflict) conflicts++; else agreements++;
    if (bounded.conflict && decided.state === 'confirmed') violations.push(row);
  }
  assert.deepEqual(violations, [], 'a bounded conflict beside a confirmed attribution');
  assert.ok(conflicts > 0 && agreements > 0, 'both decisions are exercised');
  // Unresolvable: a sender that is a suffix variant of the alias, not of the
  // payee's name, or an unregistered other name.
  for (const description of ['FROM: Alpha Unit LLC', 'FROM: Alpha Unit; FROM: Vendor Gamma']) {
    const row = { description, payee: 'Vendor Alpha' };
    const decided = attributeInflow(row, registry);
    assert.equal(decided.state, 'unknown', description);
    assert.equal(boundedPayerFields(row, decided, registry).conflict, true, description);
  }
});

test('ruling 12: the alias and suffix-variant row answers exactly like a plain exact row; an unresolvable row stays listed', async t => {
  const answers = [];
  for (const description of ['FROM: Alpha Unit; FROM: Vendor Alpha Inc', 'Deposit']) {
    const f = ledgerFixture(t, { knownPayers: false });
    identity(f, 'alpha', 'Vendor Alpha', 'Alpha Unit');
    f.add('row', description, 'Vendor Alpha', { cents: 2500 });
    f.add('other', 'Deposit', 'Supply Unit', { cents: 4000 });
    const income = await f.ask('How much income came from Vendor Alpha in October 2026?');
    const payment = await f.ask('Did the payment from Vendor Alpha arrive in October 2026?');
    answers.push([income, payment].map(body => ({ complete: body.evidence_gate?.complete, found: body.ledger.found,
      total: body.ledger.total_minor ?? null, cents: cents(body) })));
  }
  assert.deepEqual(answers[0], answers[1], 'the alias and suffix-variant row is the payee\'s own row');
  assert.deepEqual(answers[0], [{ complete: true, found: true, total: 2500, cents: [2500] }, { complete: true, found: true, total: null, cents: [2500] }]);
  // A sender the registry cannot resolve to the payee's identity: unknown,
  // listed with its reason, never a complete total or absence.
  const g = ledgerFixture(t, { knownPayers: false });
  identity(g, 'alpha', 'Vendor Alpha', 'Alpha Unit');
  g.add('row', 'FROM: Alpha Unit LLC', 'Vendor Alpha', { cents: 2500 });
  const income = await g.ask('How much income came from Vendor Alpha in October 2026?');
  notComplete(income, 'unresolvable sender');
  assert.deepEqual(cents(income), [2500]);
  assert.match(income.answer, /\nUnattributed deposit: \$25\.00 posted [^\n]*uncertain because competing payer readings \[1\]\./);
  const payment = await g.ask('Did the payment from Vendor Alpha arrive in October 2026?');
  assert.equal(payment.ledger.found, null, payment.answer);
  assert.notEqual(payment.evidence_gate.complete, true);
});

// The literal.conflict fallback in chooseLiteralSelector (a payer question
// with no alternative selector readings, and a row whose bank payee field is
// the question's literal name while its bounded fields conflict) keeps the
// legacy attribution path: the shorthand row is attributed with its
// assumption note there, while the exact path lists the same shorthand row
// as an unattributed deposit. The conflicted row is unknown on that path too
// (ruling 12), so the answer is never complete and keeps every row visible.
test('ruling 12: the literal.conflict fallback is reached, the conflicted row is unknown and listed, and nothing is complete', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  identity(f, 'alpha', 'Vendor Alpha', 'Alpha Unit');
  f.add('exact', 'Deposit', 'Vendor Alpha', { cents: 1000 });
  f.add('conflict', 'FROM: Vendor Gamma', 'Vendor Alpha', { cents: 2500 });
  f.add('shorthand', 'Vendor Alpha deposit', null, { cents: 700 });
  for (const question of ['How much income came from Vendor Alpha in October 2026?', 'Did the payment from Vendor Alpha arrive in October 2026?']) {
    const body = await f.ask(question);
    // The fallback's signature: the shorthand row rides the legacy path as
    // an attributed (assumed) deposit with its assumption note.
    assert.match(body.answer, /^Found a deposit of \$7\.00 posted /m, `${question}: ${body.answer}`);
    assert.equal(body.assumptions?.length, 1, question);
    assert.match(body.answer, /\nNote: Read the description as /, question);
    // The conflicted row is unknown: listed with its reason, never counted.
    assert.match(body.answer, /\nUnattributed deposit: \$25\.00 posted [^\n]*uncertain because competing payer readings \[3\]\./, question);
    assert.equal(body.ledger.unattributed_count, 1, question);
    assert.deepEqual(cents(body), [1000, 700, 2500], question);
    assert.equal(body.evidence_gate.complete, false, question);
    assert.equal(body.ledger.found, true, question);
    assert.equal(body.ledger.total_minor ?? null, null, question);
    assert.match(body.answer, /\nFound 1 exact matches; 1 deposits I couldn't attribute\./, question);
  }
  // Control: without the conflicted row the exact path answers, and the same
  // shorthand row is an unattributed deposit there instead.
  f.raw("DELETE FROM fin_transactions WHERE txn_uid='conflict'");
  const exact = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.match(exact.answer, /\nUnattributed deposit: \$7\.00 posted [^\n]*uncertain because shorthand cannot rule out another payer \[2\]\./, exact.answer);
  assert.doesNotMatch(exact.answer, /^Found a deposit of \$7\.00 /m);
  assert.equal(exact.assumptions, undefined);
  notComplete(exact, 'exact path control');
});

// ------------------------------------------------------- repeated Note line
// withLedgerAnswer appended "\nNote: ..." from answer.notes after
// possibleSelectorAnswer had already put the same Note line in the answer
// text, so every possible-match answer printed its Note twice.
const noteLines = body => body.answer.split('\n').filter(line => line.startsWith('Note: '));
test('the repeated Note line: a possible-match answer prints its Note line once', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  identity(f, 'alpha', 'Payer One');
  f.add('shorthand', 'Payer One payment', null, { cents: 2000 });
  const income = await f.ask('How much income came from Payer One in October 2026?');
  assert.match(income.answer, /\nPossible match: \$20\.00 posted /);
  assert.equal(noteLines(income).length, 1, income.answer);
  assert.match(noteLines(income)[0], /^Note: Read the description as [^\n]*; matched by name similarity/);
  assert.deepEqual(income.notes?.length, 2, 'the notes stay in the response');
  const g = ledgerFixture(t, { knownPayers: false });
  g.add('long', 'Purchase', 'Again Supply', { direction: 'outflow', cents: 40000 });
  g.add('short', 'Purchase', 'Supply', { direction: 'outflow', cents: 12300 });
  const spend = await g.ask('How much did I spend at Again Supply in October 2026?');
  assert.match(spend.answer, /\nPossible match: \$123\.00 posted /);
  assert.equal(noteLines(spend).length, 1, spend.answer);
});

test('the repeated Note line control: an exact-path assumption note is still printed once', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  identity(f, 'alpha', 'Vendor Alpha', 'Alpha Unit');
  f.add('exact', 'Deposit', 'Vendor Alpha', { cents: 1000 });
  f.add('conflict', 'FROM: Vendor Gamma', 'Vendor Alpha', { cents: 2500 });
  f.add('shorthand', 'Vendor Alpha deposit', null, { cents: 700 });
  const body = await f.ask('How much income came from Vendor Alpha in October 2026?');
  assert.equal(noteLines(body).length, 1, body.answer);
  assert.match(noteLines(body)[0], /^Note: Read the description as /);
});
