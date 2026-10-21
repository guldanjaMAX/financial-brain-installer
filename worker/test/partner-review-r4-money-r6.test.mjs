import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';

// Partner review, round 6, money-contract lens (reviewing partner/fix-0418-3
// at fa93db5, after the round-5 fixes). Repros fail; controls pass.
// Synthetic role-word names only. Nothing here edits an existing file.
// Round-6 fix: assertions marked "Triage decided_expected" align the repros
// to the triage verdicts; none of the reviewer's assertions was removed.
const identity = (f, slug, name, label = null) => f.raw(
  "INSERT INTO fin_entities(entity_slug,legal_name,display_label,kind,relationship,provenance,basis_state,recorded_at) VALUES (?,?,?,'business','owned','owner_stated','confirmed',?)",
  slug, name, label, NOW);
// A registry spelling that contains NUL. The reader's SQL flags it and
// node:sqlite returns the whole string; a truncating driver returns `visible`.
const damagedIdentity = (f, slug, visible, tail = '') => f.raw(
  "INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at) VALUES (?, ? || char(0) || ?,'business','owned','owner_stated','confirmed',?)",
  slug, visible, tail, NOW);
const damagedAlias = (f, slug, name, visible, tail = '') => f.raw(
  "INSERT INTO fin_entities(entity_slug,legal_name,display_label,kind,relationship,provenance,basis_state,recorded_at) VALUES (?, ?, ? || char(0) || ?,'business','owned','owner_stated','confirmed',?)",
  slug, name, visible, tail, NOW);
const damagedLegal = (f, slug, visible, tail, label) => f.raw(
  "INSERT INTO fin_entities(entity_slug,legal_name,display_label,kind,relationship,provenance,basis_state,recorded_at) VALUES (?, ? || char(0) || ?, ?,'business','owned','owner_stated','confirmed',?)",
  slug, visible, tail, label, NOW);
// A bank payee that contains NUL (payee_has_nul is computed by the reader).
const nulPayee = (f, uid, visible, tail = '') => f.raw('UPDATE fin_transactions SET payee = ? || char(0) || ? WHERE txn_uid=?', visible, tail, uid);

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

// A driver-level view of the snapshot (as partner-review-money.test.mjs
// builds it) for the one shape node:sqlite cannot produce: a truncating
// driver that returns only the text before the NUL with the flag set.
const MOCK_NOW = Date.parse('2026-10-15T12:00:00Z');
const mockAccount = () => ({ id: '4321', account_slug: 'chk-1', entity_slug: 'owner-household', mask: '4321', account_kind: 'checking',
  institution: 'Example Bank', label: 'Checking 4321', external_ref: null, source_feed: null, currency: 'USD',
  feed_mode: 'manual', balance_role: 'asset', basis_state: 'confirmed', coverage_status: 'complete',
  covered_from: '2026-01-01', covered_to: '2026-10-15', coverage_basis: 'confirmed', last_synced_at: null,
  coverage_review_required: 0, empty_provider_from: null, link_manual: null, link_live: null, link_identity: null });
let nextId = 1;
const mockTxn = (amount_minor, fields) => ({ id: nextId++, account_slug: 'chk-1', posted_on: '2026-10-05', amount_minor, direction: 'outflow',
  currency: 'USD', description: 'Purchase', payee: null, category: null, category_basis_state: null, basis_state: 'confirmed',
  description_has_nul: 0, payee_has_nul: 0, export_overlap_review: 0, ...fields });
function mockEnv(transactions) {
  const resultsFor = (sql, binds) => {
    if (sql.includes('FROM fin_accounts a')) return [mockAccount()];
    if (sql.includes('FROM fin_entities') && sql.includes('legal_name')) return [];
    if (sql.includes('json_each(?1)')) {
      const mapping = JSON.parse(binds[0]);
      const [from, to] = [binds[2], binds[3]];
      return transactions.flatMap(t => {
        const m = mapping.find(x => x.slug === t.account_slug);
        if (!m || t.posted_on < from || t.posted_on > to) return [];
        return [{ ...t, source_account_slug: t.account_slug, effective_account_slug: m.effective, last_synced_at: m.last_synced_at }];
      });
    }
    throw new Error(`unexpected sql ${sql.slice(0, 80)}`);
  };
  const statement = sql => ({ sql, binds: [], bind(...binds) { return { ...this, binds }; },
    async all() { return { results: resultsFor(this.sql, this.binds) }; } });
  return { DB: { prepare: statement, batch: async list => list.map(s => ({ results: resultsFor(s.sql, s.binds) })) } };
}
async function askMock(question, transactions) {
  const response = await withLedgerAnswer({ env: mockEnv(transactions), question, grantScope: { all: true },
    scopePrincipalKind: 'owner', now: MOCK_NOW }, async () => new Response(JSON.stringify({ mode: 'documents', answer: 'docs', gaps: [] })));
  return response.json();
}

const SPEND = 'How much did I spend at Vendor Alpha in October 2026?';
const INCOME = 'How much income came from Payer One in October 2026?';
const PAYMENT = 'Did the payment from Payer One arrive in October 2026?';

// ---------------------------------------------------------------------------
// R6-MONEY-1: on the outflow side a NUL-damaged bank payee is excluded from
// the exact rows (ledger-answer.js:266) and refused by possiblePayee before
// any name comparison (:256), so the only way the row stays visible is
// matchesMerchant() at :279 comparing the damaged payee's text with the
// question by EQUALITY (ledger-analysis.js:17-18). Every other damaged shape
// (the NUL inside a word, a trailing word after the NUL, another name) is
// neither matched nor possible: the row is hidden and the total is complete.
// The inflow side treats every NUL-flagged payee as unknown
// (ledger-attribution.js:519-520) and lists it as "damaged bank field"
// (ledger-answer.js:90). A truncating driver returns only the text before
// the NUL, so the visible payee can be the question's own name. the partner: "when
// in doubt, the answer is never complete ... and the useful part stays
// visible"; the sides disagree on the same damaged field.
test('R6-MONEY-1 outflow hides a NUL-damaged bank payee behind a complete total', async t => {
  const shapes = [['Vendor Alp', 'ha'], ['Vendor Alpha', ' Holdings'], ['Vendor Beta', '']];
  const violations = [];
  for (const [visible, tail] of shapes) {
    const f = ledgerFixture(t, { knownPayers: false });
    f.add('exact', 'Purchase', 'Vendor Alpha', { direction: 'outflow', cents: 2500 });
    f.add('damaged', 'Purchase', 'x', { direction: 'outflow', cents: 4000 });
    nulPayee(f, 'damaged', visible, tail);
    assert.ok(f.first("SELECT instr(payee,char(0)) n FROM fin_transactions WHERE txn_uid='damaged'").n > 0, 'the payee carries NUL');
    const body = await f.ask(SPEND);
    assert.ok(body.ledger, 'ledger answer reached');
    if (body.evidence_gate.complete === true || !cents(body).includes(4000))
      violations.push({ shape: `${visible}<NUL>${tail}`, complete: body.evidence_gate.complete, total_minor: body.ledger.total_minor, cents: cents(body) });
    // Triage decided_expected: the exact row is the exact-name partial
    // subtotal, the damaged row a possible match with the visible reason.
    else if ((body.ledger.total_minor ?? null) !== null || body.ledger.total_is_exact !== false || !cents(body).includes(2500) ||
        body.ledger.confirmed_subtotal_minor !== 2500 || !/damaged bank field/.test(body.answer))
      violations.push({ shape: `${visible}<NUL>${tail}`, total_is_exact: body.ledger.total_is_exact, confirmed_subtotal_minor: body.ledger.confirmed_subtotal_minor, answer: body.answer });
  }
  assert.deepEqual(violations, [], 'a damaged bounded payee beside an exact row must be listed and block completeness');
  // The same damage with no exact row beside it: a nonmatch refusal that
  // cites nothing, where the inflow side lists the row.
  const alone = ledgerFixture(t, { knownPayers: false });
  alone.add('damaged', 'Purchase', 'x', { direction: 'outflow', cents: 4000 });
  nulPayee(alone, 'damaged', 'Vendor Alp', 'ha');
  const lone = await alone.ask(SPEND);
  listed(lone, 4000, 'outflow, damaged payee alone');
  notComplete(lone, 'outflow, damaged payee alone');
  assert.equal(lone.ledger.found, null, `outflow, damaged payee alone: never absence: ${lone.answer}`);
  assert.doesNotMatch(lone.answer, /No matching transactions were found/, 'outflow, damaged payee alone');
  assert.match(lone.answer, /damaged bank field/, 'outflow, damaged payee alone: the damage reason is visible');
  // Truncating driver: the text before the NUL is a word short of the name.
  const truncated = await askMock(SPEND, [mockTxn(2500, { payee: 'Vendor Alpha' }), mockTxn(4000, { payee: 'Vendor', payee_has_nul: 1 })]);
  listed(truncated, 4000, 'outflow, truncated damaged payee a word short of the question');
  notComplete(truncated, 'outflow, truncated damaged payee a word short of the question');
  assert.ok(cents(truncated).includes(2500), `outflow, truncated damaged payee: the exact row stays cited: ${truncated.answer}`);
  assert.match(truncated.answer, /damaged bank field/, 'outflow, truncated damaged payee: the damage reason is visible');
});

test('R6-MONEY-1 control: the inflow side lists every NUL-damaged payee as a damaged bank field; an undamaged foreign payee is a known other; the exact row alone is complete', async t => {
  for (const [visible, tail] of [['Payer On', 'e'], ['Payer One', ' Holdings'], ['Vendor Beta', '']]) {
    const f = ledgerFixture(t, { knownPayers: false });
    identity(f, 'alpha', 'Payer One');
    f.add('exact', 'Deposit', 'Payer One', { cents: 2500 });
    f.add('damaged', 'Deposit', 'x', { cents: 4000 });
    nulPayee(f, 'damaged', visible, tail);
    const income = await f.ask(INCOME);
    listed(income, 4000, `inflow, ${visible}<NUL>${tail}`);
    notComplete(income, `inflow, ${visible}<NUL>${tail}`);
    assert.match(income.answer, /damaged bank field/, `inflow, ${visible}<NUL>${tail}: the damage reason is visible`);
  }
  // Outflow: a whole-string damaged payee equal to the question is already a
  // possible match (matchesMerchant equality), and an undamaged other payee
  // is a known other beside the exact row.
  const g = ledgerFixture(t, { knownPayers: false });
  g.add('exact', 'Purchase', 'Vendor Alpha', { direction: 'outflow', cents: 2500 });
  g.add('damaged', 'Purchase', 'x', { direction: 'outflow', cents: 4000 });
  nulPayee(g, 'damaged', 'Vendor Alpha', '');
  const whole = await g.ask(SPEND);
  listed(whole, 4000, 'outflow, whole damaged string equal to the question');
  notComplete(whole, 'outflow, whole damaged string equal to the question');
  const h = ledgerFixture(t, { knownPayers: false });
  h.add('exact', 'Purchase', 'Vendor Alpha', { direction: 'outflow', cents: 2500 });
  h.add('other', 'Purchase', 'Vendor Beta', { direction: 'outflow', cents: 4000 });
  const other = await h.ask(SPEND);
  complete(other, 2500, 'outflow, undamaged foreign payee');
  hidden(other, 4000, 'outflow, undamaged foreign payee');
  const k = ledgerFixture(t, { knownPayers: false });
  k.add('exact', 'Purchase', 'Vendor Alpha', { direction: 'outflow', cents: 2500 });
  complete(await k.ask(SPEND), 2500, 'outflow, exact row alone');
  // Triage decided_expected: a zero-amount damaged row cannot change the spend
  // total, so it stays out (as partner-r6-literals pins for a $0 variant).
  const z = ledgerFixture(t, { knownPayers: false });
  z.add('exact', 'Purchase', 'Vendor Alpha', { direction: 'outflow', cents: 2500 });
  z.add('damaged', 'Purchase', 'x', { direction: 'outflow', cents: 0 });
  nulPayee(z, 'damaged', 'Vendor Alp', 'ha');
  complete(await z.ask(SPEND), 2500, 'outflow, zero-amount damaged payee beside the exact row');
  const undamaged = await askMock(SPEND, [mockTxn(2500, { payee: 'Vendor Alpha' }), mockTxn(4000, { payee: 'Vendor Alpha' })]);
  complete(undamaged, 6500, 'driver view, two undamaged exact rows');
  // Truncating driver whose visible text IS the question's name: the one
  // damaged shape the equality comparison already keeps visible.
  const truncated = await askMock(SPEND, [mockTxn(2500, { payee: 'Vendor Alpha' }), mockTxn(4000, { payee: 'Vendor Alpha', payee_has_nul: 1 })]);
  listed(truncated, 4000, 'driver view, truncated damaged payee equal to the question');
  notComplete(truncated, 'driver view, truncated damaged payee equal to the question');
});

// ---------------------------------------------------------------------------
// R6-MONEY-2: payerRegistry() keeps a NUL-damaged registered spelling only in
// its private damagedSpellings index (ledger-attribution.js:60-70); the
// lookup Map and spellingsOf() (ledger-answer.js:210-211) never see it, and
// payerKeyDamaged() (ledger-attribution.js:20-26) is consulted only when the
// field is a registered alias of the question's slug (outflow :259) or not at
// all (inflow possibleField :325-332). So a bank payee equal to the visible
// text of the REQUESTED entity's own damaged alias or legal name resolves to
// nobody, is no variant of the question, and becomes a known other
// (knownRows :340-341; outflow possible :279-280): hidden, with a complete
// total and a confirmed deposit. Undamaged, the same alias row counts as an
// exact match. A NUL in one registry spelling therefore silently removes the
// entity's own rows from its certified total on both sides. R4-MONEY-1
// decided that damage can never make a name look unique; it cannot make a
// row look like someone else's either.
test('R6-MONEY-2 a bank payee equal to the requested entity\'s own NUL-damaged registered spelling is hidden as a known other on both sides', async t => {
  // Damaged alias ("P1 Corp" + NUL) of the entity the question names.
  const f = ledgerFixture(t, { knownPayers: false });
  damagedAlias(f, 'alpha', 'Payer One', 'P1 Corp');
  f.add('exact', 'Deposit', 'Payer One', { cents: 2500 });
  f.add('alias', 'Deposit', 'P1 Corp', { cents: 4000 });
  const income = await f.ask(INCOME);
  listed(income, 4000, 'inflow, damaged alias payee beside the exact row');
  notComplete(income, 'inflow, damaged alias payee beside the exact row');
  const payment = await f.ask(PAYMENT);
  listed(payment, 4000, 'payment, damaged alias payee beside the exact row');
  assert.notEqual(payment.evidence_gate.complete, true, `payment, damaged alias payee beside the exact row: ${payment.answer}`);
  // Triage decided_expected: presence from the exact row, the alias row listed.
  assert.equal(payment.ledger.found, true, `payment, damaged alias payee beside the exact row: ${payment.answer}`);
  assert.deepEqual(cents(payment), [2500, 4000], 'payment, damaged alias payee beside the exact row');
  assert.equal(income.ledger.confirmed_subtotal_minor, 2500, 'inflow, damaged alias payee beside the exact row: the exact row is the partial subtotal');
  const g = ledgerFixture(t, { knownPayers: false });
  damagedAlias(g, 'alpha', 'Vendor Alpha', 'VA Corp');
  g.add('exact', 'Purchase', 'Vendor Alpha', { direction: 'outflow', cents: 2500 });
  g.add('alias', 'Purchase', 'VA Corp', { direction: 'outflow', cents: 4000 });
  const outflow = await g.ask(SPEND);
  listed(outflow, 4000, 'outflow, damaged alias payee beside the exact row');
  notComplete(outflow, 'outflow, damaged alias payee beside the exact row');
  // Damaged LEGAL name, question by the valid alias.
  const h = ledgerFixture(t, { knownPayers: false });
  damagedLegal(h, 'alpha', 'Payer One', '', 'P1 Corp');
  h.add('exact', 'Deposit', 'P1 Corp', { cents: 2500 });
  h.add('legal', 'Deposit', 'Payer One', { cents: 4000 });
  const byAlias = await h.ask('How much income came from P1 Corp in October 2026?');
  listed(byAlias, 4000, 'inflow, damaged legal-name payee, asked by alias');
  notComplete(byAlias, 'inflow, damaged legal-name payee, asked by alias');
  const k = ledgerFixture(t, { knownPayers: false });
  damagedLegal(k, 'alpha', 'Vendor Alpha', '', 'VA Corp');
  k.add('exact', 'Purchase', 'VA Corp', { direction: 'outflow', cents: 2500 });
  k.add('legal', 'Purchase', 'Vendor Alpha', { direction: 'outflow', cents: 4000 });
  const outByAlias = await k.ask('How much did I spend at VA Corp in October 2026?');
  listed(outByAlias, 4000, 'outflow, damaged legal-name payee, asked by alias');
  notComplete(outByAlias, 'outflow, damaged legal-name payee, asked by alias');
  // A truncating driver's prefix: the payee equals the text before the NUL.
  const p = ledgerFixture(t, { knownPayers: false });
  damagedAlias(p, 'alpha', 'Payer One', 'P1 Corp', ' Holdings');
  p.add('exact', 'Deposit', 'Payer One', { cents: 2500 });
  p.add('alias', 'Deposit', 'P1 Corp', { cents: 4000 });
  const prefix = await p.ask(INCOME);
  listed(prefix, 4000, 'inflow, payee equal to the damaged alias prefix');
  notComplete(prefix, 'inflow, payee equal to the damaged alias prefix');
  // Outflow, the damaged-alias row alone: a nonmatch refusal citing nothing.
  const q = ledgerFixture(t, { knownPayers: false });
  damagedAlias(q, 'alpha', 'Vendor Alpha', 'VA Corp');
  q.add('alias', 'Purchase', 'VA Corp', { direction: 'outflow', cents: 4000 });
  const lone = await q.ask(SPEND);
  listed(lone, 4000, 'outflow, damaged alias payee alone');
  notComplete(lone, 'outflow, damaged alias payee alone');
  assert.equal(lone.ledger.found, null, `outflow, damaged alias payee alone: never absence: ${lone.answer}`);
  assert.doesNotMatch(lone.answer, /No matching transactions were found/, 'outflow, damaged alias payee alone');
  assert.equal(outflow.ledger.confirmed_subtotal_minor, 2500, 'outflow, damaged alias payee beside the exact row: the exact row is the partial subtotal');
});

test('R6-MONEY-2 control: the undamaged alias counts as exact on both sides; the inflow side already lists the damaged-alias row when it stands alone; another entity\'s damaged alias stays a known other', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  identity(f, 'alpha', 'Payer One', 'P1 Corp');
  f.add('exact', 'Deposit', 'Payer One', { cents: 2500 });
  f.add('alias', 'Deposit', 'P1 Corp', { cents: 4000 });
  const income = await f.ask(INCOME);
  complete(income, 6500, 'inflow, undamaged alias');
  assert.deepEqual(cents(income).sort(), [2500, 4000]);
  const g = ledgerFixture(t, { knownPayers: false });
  identity(g, 'alpha', 'Vendor Alpha', 'VA Corp');
  g.add('exact', 'Purchase', 'Vendor Alpha', { direction: 'outflow', cents: 2500 });
  g.add('alias', 'Purchase', 'VA Corp', { direction: 'outflow', cents: 4000 });
  const outflow = await g.ask(SPEND);
  complete(outflow, 6500, 'outflow, undamaged alias');
  assert.deepEqual(cents(outflow).sort(), [2500, 4000]);
  // Alone, the inflow side lists the damaged-alias row (its lookup resolves
  // to nobody, so it is an unattributed deposit); only beside an exact row
  // does the known-other rule hide it.
  const h = ledgerFixture(t, { knownPayers: false });
  damagedAlias(h, 'alpha', 'Payer One', 'P1 Corp');
  h.add('alias', 'Deposit', 'P1 Corp', { cents: 4000 });
  const lone = await h.ask(INCOME);
  listed(lone, 4000, 'inflow, damaged alias payee alone');
  notComplete(lone, 'inflow, damaged alias payee alone');
  // A damaged spelling of ANOTHER entity names that entity: a known other,
  // exactly as the same payee with no registry at all.
  const k = ledgerFixture(t, { knownPayers: false });
  identity(k, 'alpha', 'Payer One');
  damagedAlias(k, 'beta', 'Vendor Beta', 'VB Corp');
  k.add('exact', 'Deposit', 'Payer One', { cents: 2500 });
  k.add('other', 'Deposit', 'VB Corp', { cents: 4000 });
  const other = await k.ask(INCOME);
  complete(other, 2500, 'inflow, another entity\'s damaged alias');
  hidden(other, 4000, 'inflow, another entity\'s damaged alias');
});

// ---------------------------------------------------------------------------
// R6-MONEY-3: with any NUL-damaged spelling in the registry, an outflow
// question naming an UNREGISTERED merchant is a conflict
// (ledger-answer.js:282 `payerRegistryHasDamage(identities) && !slug`). Every
// merchant question carries selectorReadings (ledger-question.js:898 returns
// them even when the raw and cleaned labels are equal), so the conflict is
// rendered as the selector-ambiguous refusal (:364-365, :526): "I can't tell
// whether you mean Vendor Alpha or Vendor Alpha", citing nothing. The exact
// payee rows and the possible matches disappear. The inflow side with the
// same data keeps every row visible as an unattributed deposit, and a
// registered outflow question beside the same damage keeps its partial
// subtotal. The gate is incomplete either way; the useful part is not visible.
test('R6-MONEY-3 outflow hides the exact and possible rows of an unregistered merchant behind a same-label refusal whenever any registry spelling is damaged', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  damagedIdentity(f, 'gamma', 'Other Supplier');
  f.add('exact', 'Purchase', 'Vendor Alpha', { direction: 'outflow', cents: 2500 });
  f.add('variant', 'Purchase', 'Vendor Alpha LLC', { direction: 'outflow', cents: 4000 });
  const body = await f.ask(SPEND);
  notComplete(body, 'outflow, unrelated damaged spelling');
  assert.ok(cents(body).includes(2500), `the exact payee row is not cited: ${body.answer}`);
  assert.ok(cents(body).includes(4000), `the suffix-variant row is not cited: ${body.answer}`);
  const candidates = body.ledger.selector_candidates || [];
  assert.ok(!(candidates.length === 2 && candidates[0] === candidates[1]), `the refusal names one label twice: ${body.answer}`);
  // Triage decided_expected: uniqueness is unproven, so neither presence nor
  // absence; the exact row is the exact-name partial subtotal, the LLC row a
  // possible match, and a visible note says a registered spelling is damaged.
  assert.equal(body.ledger.found, null, `outflow, unrelated damaged spelling: ${body.answer}`);
  assert.equal(body.ledger.attributed_subtotal_minor, 2500, `the exact row is the exact-name partial subtotal: ${body.answer}`);
  assert.match(body.answer, /Exact match: \$25\.00/, body.answer);
  assert.match(body.answer, /Possible match: \$40\.00/, body.answer);
  assert.match(body.answer, /registered spelling is damaged/, body.answer);
  assert.doesNotMatch(body.answer, /I can't tell whether you mean/, body.answer);
  // The R4-MONEY-1 outflow shape (a damaged spelling equal to the question's
  // name): incomplete, as pinned there, but the exact row must stay visible.
  const g = ledgerFixture(t, { knownPayers: false });
  identity(g, 'alpha', 'Vendor Alpha');
  g.add('exact', 'Purchase', 'Vendor Alpha', { direction: 'outflow', cents: 1000 });
  damagedIdentity(g, 'gamma', 'Vendor Alpha');
  const collision = await g.ask(SPEND);
  notComplete(collision, 'outflow, damaged collision');
  assert.ok(cents(collision).includes(1000), `the exact payee row is not cited: ${collision.answer}`);
  assert.equal(collision.ledger.found, null, `outflow, damaged collision: ${collision.answer}`);
  // Triage decided_expected: the undamaged outflow collision lists its exact
  // row as a candidate too, as the inflow side does, never the same label twice.
  const h = ledgerFixture(t, { knownPayers: false });
  identity(h, 'alpha', 'Vendor Alpha');
  identity(h, 'gamma', 'Vendor Alpha');
  h.add('exact', 'Purchase', 'Vendor Alpha', { direction: 'outflow', cents: 1000 });
  const shared = await h.ask(SPEND);
  notComplete(shared, 'outflow, undamaged collision');
  assert.equal(shared.ledger.found, null, `outflow, undamaged collision: ${shared.answer}`);
  assert.ok(cents(shared).includes(1000), `outflow, undamaged collision: the exact payee row is not cited: ${shared.answer}`);
  const sharedCandidates = shared.ledger.selector_candidates || [];
  assert.equal(new Set(sharedCandidates).size, sharedCandidates.length, `outflow, undamaged collision: a label is named twice: ${shared.answer}`);
});

test('R6-MONEY-3 control: the inflow side keeps the rows visible beside the same damage; a registered outflow question keeps its partial subtotal; an undamaged registry gives the possible-match answer', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  damagedIdentity(f, 'gamma', 'Other Supplier');
  f.add('exact', 'Deposit', 'Payer One', { cents: 2500 });
  f.add('variant', 'Deposit', 'Payer One LLC', { cents: 4000 });
  const income = await f.ask(INCOME);
  notComplete(income, 'inflow, unrelated damaged spelling');
  assert.deepEqual(cents(income).sort(), [2500, 4000]);
  const g = ledgerFixture(t, { knownPayers: false });
  identity(g, 'alpha', 'Vendor Alpha');
  damagedIdentity(g, 'gamma', 'Other Supplier');
  g.add('exact', 'Purchase', 'Vendor Alpha', { direction: 'outflow', cents: 2500 });
  g.add('variant', 'Purchase', 'Vendor Alpha LLC', { direction: 'outflow', cents: 4000 });
  const registered = await g.ask(SPEND);
  notComplete(registered, 'outflow, registered question, unrelated damaged spelling');
  assert.deepEqual(cents(registered).sort(), [2500, 4000]);
  assert.equal(registered.ledger.confirmed_subtotal_minor, 2500);
  assert.equal(registered.ledger.possible_count, 1);
  const h = ledgerFixture(t, { knownPayers: false });
  identity(h, 'gamma', 'Other Supplier');
  h.add('exact', 'Purchase', 'Vendor Alpha', { direction: 'outflow', cents: 2500 });
  h.add('variant', 'Purchase', 'Vendor Alpha LLC', { direction: 'outflow', cents: 4000 });
  const undamaged = await h.ask(SPEND);
  notComplete(undamaged, 'outflow, undamaged registry');
  assert.deepEqual(cents(undamaged).sort(), [2500, 4000]);
  assert.equal(undamaged.ledger.possible_count, 1);
});
