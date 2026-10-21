import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';

// Partner review, round 5, money-contract lens (reviewing partner/fix-0418-3
// at e847233, after the round-4 fixes). Repros fail; controls pass.
// Synthetic role-word names only. Nothing here edits an existing file.
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

// ---------------------------------------------------------------------------
// R5-MONEY-1: the round-4 possible-match rule (R4-MONEY-5) treats a bounded
// field registered to exactly one entity as a KNOWN OTHER: inflow
// ledger-answer.js:312 `owners?.size === 1 && !(slug && owners.has(slug))`
// and outflow :256 `if (owners?.size === 1) return false`. That is right when
// the question itself resolves to a different registered entity. When the
// question is NOT registered (`slug` is null: an unregistered spelling such
// as the registered name plus or minus one closed company suffix, or plus a
// trailing word), there is no "other" to compare against: the one entity the
// field is registered to may be the very payer the question names. The
// branch still hides the row and certifies a complete total, a confirmed
// deposit and a complete spend. The same rows with no registry at all are a
// partial subtotal with the variant listed (R4-MONEY-5), so registering a
// payer REMOVES the doubt the branch records for its unregistered spellings.
// The contract calls a shortened name a possible match with a partial
// subtotal and a visible note; the partner: "when in doubt, the answer is never
// complete ... and the useful part stays visible".
test('R5-MONEY-1 an unregistered question beside a registered suffix, prefix, sender or alias variant certifies a complete total on both sides', async t => {
  // Question "Payer One LLC" (unregistered); "Payer One" is registered.
  const f = ledgerFixture(t, { knownPayers: false });
  identity(f, 'alpha', 'Payer One');
  f.add('exact', 'Deposit', 'Payer One LLC', { cents: 2500 });
  f.add('variant', 'Deposit', 'Payer One', { cents: 4000 });
  const income = await f.ask('How much income came from Payer One LLC in October 2026?');
  listed(income, 4000, 'inflow, registered suffix variant');
  notComplete(income, 'inflow, registered suffix variant');
  const payment = await f.ask('Did the payment from Payer One LLC arrive in October 2026?');
  listed(payment, 4000, 'payment, registered suffix variant');
  assert.notEqual(payment.evidence_gate.complete, true, `payment, registered suffix variant: ${payment.answer}`);
  // The variant as a labelled sender with no payee, and as a registered
  // alias of the entity whose legal name is the variant.
  for (const [uid, description, payee] of [['variant', 'FROM: Payer One', null]]) {
    f.raw('UPDATE fin_transactions SET description=?, payee=? WHERE txn_uid=?', description, payee, uid);
    const sender = await f.ask('How much income came from Payer One LLC in October 2026?');
    listed(sender, 4000, 'inflow, registered labelled-sender variant');
    notComplete(sender, 'inflow, registered labelled-sender variant');
  }
  const g = ledgerFixture(t, { knownPayers: false });
  identity(g, 'alpha', 'Payer One', 'P1 Corp');
  g.add('exact', 'Deposit', 'Payer One LLC', { cents: 2500 });
  g.add('alias', 'Deposit', 'P1 Corp', { cents: 4000 });
  const alias = await g.ask('How much income came from Payer One LLC in October 2026?');
  listed(alias, 4000, 'inflow, alias of the variant entity');
  notComplete(alias, 'inflow, alias of the variant entity');
  // Prefix shape: question "Payer One Holdings" (unregistered), "Payer One" registered.
  const p = ledgerFixture(t, { knownPayers: false });
  identity(p, 'alpha', 'Payer One');
  p.add('exact', 'Deposit', 'Payer One Holdings', { cents: 2500 });
  p.add('variant', 'Deposit', 'Payer One', { cents: 4000 });
  const prefix = await p.ask('How much income came from Payer One Holdings in October 2026?');
  listed(prefix, 4000, 'inflow, registered prefix variant');
  notComplete(prefix, 'inflow, registered prefix variant');
  // Mirror: the registered name carries the suffix and the question lacks it.
  const m = ledgerFixture(t, { knownPayers: false });
  identity(m, 'alpha', 'Payer One LLC');
  m.add('exact', 'Deposit', 'Payer One', { cents: 2500 });
  m.add('variant', 'Deposit', 'Payer One LLC', { cents: 4000 });
  const mirror = await m.ask('How much income came from Payer One in October 2026?');
  listed(mirror, 4000, 'inflow, mirror');
  notComplete(mirror, 'inflow, mirror');
  const mirrorPayment = await m.ask('Did the payment from Payer One arrive in October 2026?');
  listed(mirrorPayment, 4000, 'payment, mirror');
  assert.notEqual(mirrorPayment.evidence_gate.complete, true, `payment, mirror: ${mirrorPayment.answer}`);
  // Outflow, both directions of the suffix.
  const h = ledgerFixture(t, { knownPayers: false });
  identity(h, 'alpha', 'Vendor Alpha');
  h.add('exact', 'Purchase', 'Vendor Alpha LLC', { direction: 'outflow', cents: 2500 });
  h.add('variant', 'Purchase', 'Vendor Alpha', { direction: 'outflow', cents: 4000 });
  const outflow = await h.ask('How much did I spend at Vendor Alpha LLC in October 2026?');
  listed(outflow, 4000, 'outflow, registered suffix variant');
  notComplete(outflow, 'outflow, registered suffix variant');
  const k = ledgerFixture(t, { knownPayers: false });
  identity(k, 'alpha', 'Vendor Alpha LLC');
  k.add('exact', 'Purchase', 'Vendor Alpha', { direction: 'outflow', cents: 2500 });
  k.add('variant', 'Purchase', 'Vendor Alpha LLC', { direction: 'outflow', cents: 4000 });
  const outflowMirror = await k.ask('How much did I spend at Vendor Alpha in October 2026?');
  listed(outflowMirror, 4000, 'outflow, mirror');
  notComplete(outflowMirror, 'outflow, mirror');
});

test('R5-MONEY-1 control: with no registry the same rows are listed and incomplete; a registered question keeps its established answers; the exact row alone is complete', async t => {
  // No registry: both sides already record the doubt (R4-MONEY-5).
  const f = ledgerFixture(t, { knownPayers: false });
  f.add('exact', 'Deposit', 'Payer One LLC', { cents: 2500 });
  f.add('variant', 'Deposit', 'Payer One', { cents: 4000 });
  const income = await f.ask('How much income came from Payer One LLC in October 2026?');
  listed(income, 4000, 'inflow, no registry');
  notComplete(income, 'inflow, no registry');
  const g = ledgerFixture(t, { knownPayers: false });
  g.add('exact', 'Purchase', 'Vendor Alpha LLC', { direction: 'outflow', cents: 2500 });
  g.add('variant', 'Purchase', 'Vendor Alpha', { direction: 'outflow', cents: 4000 });
  const outflow = await g.ask('How much did I spend at Vendor Alpha LLC in October 2026?');
  listed(outflow, 4000, 'outflow, no registry');
  notComplete(outflow, 'outflow, no registry');
  // Registered question, unregistered variant: listed (R4-MONEY-5).
  const r = ledgerFixture(t, { knownPayers: false });
  identity(r, 'alpha', 'Payer One');
  r.add('exact', 'Deposit', 'Payer One', { cents: 2500 });
  r.add('variant', 'Deposit', 'Payer One LLC', { cents: 4000 });
  const reverse = await r.ask('How much income came from Payer One in October 2026?');
  listed(reverse, 4000, 'inflow, registered question, unregistered variant');
  notComplete(reverse, 'inflow, registered question, unregistered variant');
  // Registered question, variant registered to a SECOND entity: a known
  // other. Distinct registrations do not merge through a suffix.
  const d = ledgerFixture(t, { knownPayers: false });
  identity(d, 'alpha', 'Payer One');
  identity(d, 'beta', 'Payer One LLC');
  d.add('exact', 'Deposit', 'Payer One', { cents: 2500 });
  d.add('other', 'Deposit', 'Payer One LLC', { cents: 4000 });
  const distinct = await d.ask('How much income came from Payer One in October 2026?');
  complete(distinct, 2500, 'inflow, variant registered to another entity');
  hidden(distinct, 4000, 'inflow, variant registered to another entity');
  // The variant alone, unregistered question: the inflow side lists it.
  const a = ledgerFixture(t, { knownPayers: false });
  identity(a, 'alpha', 'Payer One');
  a.add('variant', 'Deposit', 'Payer One', { cents: 4000 });
  const alone = await a.ask('How much income came from Payer One LLC in October 2026?');
  listed(alone, 4000, 'inflow, registered variant alone');
  notComplete(alone, 'inflow, registered variant alone');
  // The exact unregistered payee alone is complete on both sides.
  const e = ledgerFixture(t, { knownPayers: false });
  identity(e, 'alpha', 'Payer One');
  e.add('exact', 'Deposit', 'Payer One LLC', { cents: 2500 });
  complete(await e.ask('How much income came from Payer One LLC in October 2026?'), 2500, 'inflow, exact alone');
  const o = ledgerFixture(t, { knownPayers: false });
  identity(o, 'alpha', 'Vendor Alpha');
  o.add('exact', 'Purchase', 'Vendor Alpha LLC', { direction: 'outflow', cents: 2500 });
  complete(await o.ask('How much did I spend at Vendor Alpha LLC in October 2026?'), 2500, 'outflow, exact alone');
});

// ---------------------------------------------------------------------------
// R5-MONEY-2: when a registered question has no exact row but a shorthand
// (assumed) row of the same entity, chooseLiteralSelector() takes the
// possible path (ledger-answer.js:350-351 `!a.result.possible.length` fails,
// then :369-371). possibleSelectorAnswer() lists only `selection.possible`
// (:383-389), so a deposit whose attribution is unknown is neither cited nor
// mentioned, while the exact path lists it as "Unattributed deposit" (:579).
// The answer is incomplete either way, but the candidate deposit the branch
// elsewhere discloses ("I found N deposits that don't show who paid")
// disappears from view. the partner: "the useful part stays visible".
test('R5-MONEY-2 the possible-match answer hides an unattributed deposit beside the shorthand row', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  identity(f, 'alpha', 'Payer One');
  f.add('shorthand', 'Payer One payment', null, { cents: 2000 });
  f.add('unknown', 'Deposit ref 1', null, { cents: 5000 });
  const income = await f.ask('How much income came from Payer One in October 2026?');
  notComplete(income, 'possible path, income');
  listed(income, 2000, 'possible path, income: the shorthand row');
  listed(income, 5000, 'possible path, income: the unattributed deposit');
  const payment = await f.ask('Did the payment from Payer One arrive in October 2026?');
  assert.notEqual(payment.evidence_gate.complete, true, `possible path, payment: ${payment.answer}`);
  listed(payment, 5000, 'possible path, payment: the unattributed deposit');
  // Triage decided (R5-MONEY-2): $20 is a possible match, $50 an unattributed
  // deposit, unattributed_count 1, found null, on both questions.
  for (const [label, body] of [['income', income], ['payment', payment]]) {
    assert.deepEqual(cents(body), [2000, 5000], label);
    assert.equal(body.ledger.unattributed_count, 1, label);
    assert.equal(body.ledger.found, null, label);
    assert.match(body.answer, /Possible match: \$20\.00/, label);
    assert.match(body.answer, /Unattributed deposit: \$50\.00/, label);
    assert.ok(body.gaps.some(gap => gap.reason === 'sender_attribution_unknown'), label);
  }
});

test('R5-MONEY-2 control: beside an exact row the same deposits are both listed; the shorthand row alone is a possible match; the unknown row alone is unattributed', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  identity(f, 'alpha', 'Payer One');
  f.add('exact', 'Deposit', 'Payer One', { cents: 1000 });
  f.add('shorthand', 'Payer One payment', null, { cents: 2000 });
  f.add('unknown', 'Deposit ref 1', null, { cents: 5000 });
  const income = await f.ask('How much income came from Payer One in October 2026?');
  notComplete(income, 'exact path, income');
  assert.deepEqual(cents(income).sort(), [1000, 2000, 5000]);
  assert.equal(income.ledger.unattributed_count, 2);
  const g = ledgerFixture(t, { knownPayers: false });
  identity(g, 'alpha', 'Payer One');
  g.add('shorthand', 'Payer One payment', null, { cents: 2000 });
  const shorthand = await g.ask('How much income came from Payer One in October 2026?');
  notComplete(shorthand, 'shorthand alone');
  listed(shorthand, 2000, 'shorthand alone');
  const h = ledgerFixture(t, { knownPayers: false });
  identity(h, 'alpha', 'Payer One');
  h.add('unknown', 'Deposit ref 1', null, { cents: 5000 });
  const unknown = await h.ask('How much income came from Payer One in October 2026?');
  notComplete(unknown, 'unknown alone');
  listed(unknown, 5000, 'unknown alone');
  assert.equal(unknown.ledger.unattributed_count, 1);
});

// ---------------------------------------------------------------------------
// R5-MONEY-3: on the outflow side a payee that differs from the question by
// one closed suffix (or is a whole-word prefix of it) is consulted only
// beside an exact row (ledger-answer.js:270-271 `matched.length > 0 &&
// possiblePayee(row)`). Alone, matched and possible are empty and the answer
// is the "No matching transactions were found" refusal with found=false and
// no citation (:374, :479). The inflow side with the same shape lists the row
// as an unattributed candidate. The sides disagree, and the contract calls a
// shortened name a possible match with a partial subtotal and a visible note.
test('R5-MONEY-3 outflow: a lone variant payee is hidden behind the nonmatch refusal while the inflow side lists it', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  f.add('variant', 'Purchase', 'Vendor Alpha LLC', { direction: 'outflow', cents: 4000 });
  const suffix = await f.ask('How much did I spend at Vendor Alpha in October 2026?');
  notComplete(suffix, 'outflow, lone suffix variant');
  listed(suffix, 4000, 'outflow, lone suffix variant');
  assert.notEqual(suffix.ledger.found, false, 'a possible match is not a nonmatch');
  // Triage decided (R5-MONEY-3): found null, a partial subtotal, one citation.
  assert.equal(suffix.ledger.found, null);
  assert.deepEqual(cents(suffix), [4000]);
  assert.match(suffix.answer, /Partial subtotal before exclusions: \$40\.00/);
  const g = ledgerFixture(t, { knownPayers: false });
  g.add('variant', 'Purchase', 'Vendor Alpha', { direction: 'outflow', cents: 4000 });
  const prefix = await g.ask('How much did I spend at Vendor Alpha Holdings in October 2026?');
  notComplete(prefix, 'outflow, lone prefix variant');
  listed(prefix, 4000, 'outflow, lone prefix variant');
});

test('R5-MONEY-3 control: the inflow side lists the lone variant; a name with no variant row keeps the nonmatch refusal; the variant beside an exact row is a possible match', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  f.add('variant', 'Deposit', 'Payer One LLC', { cents: 4000 });
  const inflow = await f.ask('How much income came from Payer One in October 2026?');
  notComplete(inflow, 'inflow, lone suffix variant');
  listed(inflow, 4000, 'inflow, lone suffix variant');
  const g = ledgerFixture(t, { knownPayers: false });
  g.add('other', 'Purchase', 'Supply Unit', { direction: 'outflow', cents: 4000 });
  const nonmatch = await g.ask('How much did I spend at Vendor Alpha in October 2026?');
  notComplete(nonmatch, 'outflow, structural nonmatch');
  assert.equal(nonmatch.ledger.found, false);
  assert.deepEqual(cents(nonmatch), []);
  const h = ledgerFixture(t, { knownPayers: false });
  h.add('exact', 'Purchase', 'Vendor Alpha', { direction: 'outflow', cents: 1000 });
  h.add('variant', 'Purchase', 'Vendor Alpha LLC', { direction: 'outflow', cents: 4000 });
  const beside = await h.ask('How much did I spend at Vendor Alpha in October 2026?');
  notComplete(beside, 'outflow, variant beside an exact row');
  listed(beside, 4000, 'outflow, variant beside an exact row');
  assert.equal(beside.ledger.possible_count, 1);
});

// ---------------------------------------------------------------------------
// R5-MONEY-4 (contract decision): payerNameVariant() (ledger-attribution.js:
// 729-738) admits a field that is a whole-word PREFIX of the requested name
// ("Acme" for "Acme Payer One") as a possible match, but a whole-word
// TRAILING run ("Payer One" for "Acme Payer One") is a known other: beside
// an exact row it is hidden and the total is complete, on both sides. The
// contract's "shortened name" and "substring" do not say which whole-word
// substrings count. The asymmetry (a one-word leading fragment is a possible
// match, the two-word tail is not) is what this pins. Triage (round 5)
// decided the tail (and an inner run) is a possible match on both sides, but
// that decision is HELD: whole-word containment in payerNameVariant fails
// committed partner tests that pin a shorter trailing-run payee beside the
// exact one as a complete exact answer (partner-r7-review.test.mjs R6-F1
// green "Supply" beside "Again Supply", R6-F2 green and repro "Payer Unit"
// beside "Again Payer Unit" / "<filler> Payer Unit", and partner-r7-exact
// R7 seeded exact selection invariants 7 and 41, "May" beside "please May").
test('R5-MONEY-4 a whole-word trailing substring payee is a known other beside an exact row while a leading-word payee is a possible match', {
  todo: 'held for a decision: treating a trailing or inner whole-word run as a possible match conflicts with committed partner tests partner-r7-review.test.mjs R6-F1 green and R6-F2 green/repro, and partner-r7-exact.test.mjs R7 seeded exact selection invariants 7 and 41, which pin "Supply" beside "Again Supply" (and "Payer Unit" beside "Again Payer Unit", "May" beside "please May") as a complete exact answer',
}, async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  identity(f, 'alpha', 'Acme Payer One');
  f.add('exact', 'Deposit', 'Acme Payer One', { cents: 2500 });
  f.add('tail', 'Deposit', 'Payer One', { cents: 4000 });
  const income = await f.ask('How much income came from Acme Payer One in October 2026?');
  listed(income, 4000, 'inflow, trailing substring payee');
  notComplete(income, 'inflow, trailing substring payee');
  const g = ledgerFixture(t, { knownPayers: false });
  g.add('exact', 'Purchase', 'Acme Vendor Alpha', { direction: 'outflow', cents: 2500 });
  g.add('tail', 'Purchase', 'Vendor Alpha', { direction: 'outflow', cents: 4000 });
  const outflow = await g.ask('How much did I spend at Acme Vendor Alpha in October 2026?');
  listed(outflow, 4000, 'outflow, trailing substring payee');
  notComplete(outflow, 'outflow, trailing substring payee');
  // Triage decided (R5-MONEY-4, overriding the contract flag: the contract
  // names "a shortened name, a substring" as a possible match): $25 is the
  // partial subtotal and $40 the one possible match on the outflow side.
  assert.equal(outflow.ledger.possible_count, 1);
  assert.equal(outflow.ledger.confirmed_subtotal_minor, 2500);
});

// ---------------------------------------------------------------------------
// R5-MONEY-5: outflow description containment compares the description to the
// QUESTION TEXT only (ledger-answer.js:270 `matchesMerchant(row, label)`, via
// ledger-analysis.js:17-19). A description that contains a registered alias
// of the requested entity instead ("VA Corp coffee" when "VA Corp" is the
// display label of Vendor Alpha) is therefore neither exact nor possible:
// beside an exact row it is hidden and the spend total is complete, while
// the same description spelled with the question's own name is a possible
// match (answer 1). Round 4 already made a registered alias of the requested
// entity count on the outflow side for a bounded payee (R4-MONEY-6); the
// description side does not know the entity's other spellings.
test('R5-MONEY-5 outflow: a description containing a registered alias of the requested entity is hidden behind a complete total', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  identity(f, 'alpha', 'Vendor Alpha', 'VA Corp');
  f.add('exact', 'Purchase', 'Vendor Alpha', { direction: 'outflow', cents: 2500 });
  f.add('alias', 'VA Corp coffee', null, { direction: 'outflow', cents: 4000 });
  const byName = await f.ask('How much did I spend at Vendor Alpha in October 2026?');
  listed(byName, 4000, 'outflow, alias containment, asked by legal name');
  notComplete(byName, 'outflow, alias containment, asked by legal name');
  const byAlias = await f.ask('How much did I spend at VA Corp in October 2026?');
  listed(byAlias, 4000, 'outflow, alias containment, asked by alias');
  notComplete(byAlias, 'outflow, alias containment, asked by alias');
  // Triage decided (R5-MONEY-5): the exact row is the partial exact-name
  // subtotal and the alias-containment row the one possible match, whichever
  // spelling the question used; the same for a description containing the
  // legal name when the question uses the alias.
  for (const [label, body] of [['by name', byName], ['by alias', byAlias]]) {
    assert.deepEqual(cents(body), [2500, 4000], label);
    assert.equal(body.ledger.confirmed_subtotal_minor, 2500, label);
    assert.equal(body.ledger.possible_count, 1, label);
    assert.match(body.answer, /Possible match: \$40\.00/, label);
  }
  const g = ledgerFixture(t, { knownPayers: false });
  identity(g, 'alpha', 'Vendor Alpha', 'Unique Label');
  g.add('exact', 'Purchase', 'Vendor Alpha', { direction: 'outflow', cents: 2500 });
  g.add('desc', 'Vendor Alpha coffee', null, { direction: 'outflow', cents: 4000 });
  const legal = await g.ask('How much did I spend at Unique Label in October 2026?');
  listed(legal, 4000, 'outflow, legal-name containment, asked by alias');
  notComplete(legal, 'outflow, legal-name containment, asked by alias');
  assert.equal(legal.ledger.possible_count, 1);
});

test('R5-MONEY-5 control: containment of the question\'s own spelling is a possible match; an alias payee is exact; an unrelated description is a known other', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  identity(f, 'alpha', 'Vendor Alpha', 'VA Corp');
  f.add('exact', 'Purchase', 'Vendor Alpha', { direction: 'outflow', cents: 2500 });
  f.add('desc', 'Vendor Alpha coffee', null, { direction: 'outflow', cents: 4000 });
  const containment = await f.ask('How much did I spend at Vendor Alpha in October 2026?');
  listed(containment, 4000, 'outflow, own-name containment');
  notComplete(containment, 'outflow, own-name containment');
  assert.equal(containment.ledger.possible_count, 1);
  f.raw("UPDATE fin_transactions SET description='Purchase', payee='VA Corp' WHERE txn_uid='desc'");
  const aliasPayee = await f.ask('How much did I spend at Vendor Alpha in October 2026?');
  complete(aliasPayee, 6500, 'outflow, alias payee is exact');
  f.raw("UPDATE fin_transactions SET description='Supply Unit coffee', payee=NULL WHERE txn_uid='desc'");
  const unrelated = await f.ask('How much did I spend at Vendor Alpha in October 2026?');
  complete(unrelated, 2500, 'outflow, unrelated description');
  hidden(unrelated, 4000, 'outflow, unrelated description');
});

test('R5-MONEY-4 control: the leading-word payee is listed beside the exact row; an unrelated payee is a known other; the exact row alone is complete', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  identity(f, 'alpha', 'Acme Payer One');
  f.add('exact', 'Deposit', 'Acme Payer One', { cents: 2500 });
  f.add('lead', 'Deposit', 'Acme', { cents: 4000 });
  const lead = await f.ask('How much income came from Acme Payer One in October 2026?');
  listed(lead, 4000, 'inflow, leading-word payee');
  notComplete(lead, 'inflow, leading-word payee');
  f.raw("UPDATE fin_transactions SET payee='Supply Unit' WHERE txn_uid='lead'");
  const unrelated = await f.ask('How much income came from Acme Payer One in October 2026?');
  complete(unrelated, 2500, 'inflow, unrelated payee');
  hidden(unrelated, 4000, 'inflow, unrelated payee');
  f.raw("DELETE FROM fin_transactions WHERE txn_uid='lead'");
  complete(await f.ask('How much income came from Acme Payer One in October 2026?'), 2500, 'inflow, exact alone');
});
