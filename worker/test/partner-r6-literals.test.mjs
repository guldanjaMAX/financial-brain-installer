import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { payerQuestionGrammar } from '../src/lib/ledger-question.js';

import { assertExactSelection, assertPossibleMatch } from './partner-r7-assertions.mjs';

const amounts = ['$400', 'USD 400', '400 dollar', '400 dollars', '$400.00', 'USD 400.00', '400.00 dollars'];
const addIdentity = (f, slug, name, alias = null) => f.raw("INSERT INTO fin_entities(entity_slug,legal_name,display_label,kind,relationship,provenance,basis_state,recorded_at) VALUES (?,?,?,'business','owned','owner_stated','confirmed',?)", slug, name, alias, NOW);
async function ask(f, q) {
  const reads = f.calls.length, changes = f.first('SELECT total_changes() n').n;
  const b = await f.ask(q);
  assert.ok(f.calls.slice(reads).some(sql => /JOIN fin_transactions/.test(sql)), q);
  assert.ok(f.first('SELECT COUNT(*) n FROM fin_transactions').n > 0);
  assert.equal(f.first('SELECT total_changes() n').n, changes);
  assert.ok(b.ledger, q);
  return b;
}
function selection(b, q, amount = 53123) {
  // Categories keep their taxonomy contract; R7 merchant/payer RAW names
  // outrank a shortened reading, whose evidence is only possible.
  if (!q?.includes('spend on')) return assertExactSelection(b, amount);
  assert.equal(b.evidence_gate.complete, false, q);
  assert.equal(b.ledger.found, null);
  assert.equal(b.ledger.total_minor, null);
  assert.equal(b.ledger.total_is_exact, false);
  assert.match(b.answer, /I can't tell whether you mean/);
  assert.doesNotMatch(b.answer, /Found a deposit|No matching deposit|total (?:spend|income)/i);
}
function shuffle(values, seed) {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1); [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
for (const seed of [7, 41, 20261019, 20261020]) test(`literal selectors and competing cleanup readings, seed ${seed}`, async t => {
  let arms = 0;
  for (const word of shuffle([...payerQuestionGrammar.filler, ...amounts], seed)) {
    for (const kind of ['merchant', 'category', 'payer', 'income']) {
      const f = ledgerFixture(t, { knownPayers: false });
      const full = `Unit ${word} Supply`, short = 'Unit Supply';
      const payer = ['payer', 'income'].includes(kind);
      if (payer) { addIdentity(f, 'long', full, 'Literal Alias'); addIdentity(f, 'short', short, 'Plain Alias'); }
      f.add('short', payer ? `FROM: ${short}` : 'Purchase', short, { direction: payer ? 'inflow' : 'outflow', cents: 0 });
      f.add('long', payer ? `FROM: ${full}` : 'Purchase', full, { direction: payer ? 'inflow' : 'outflow', cents: 53123 });
      f.raw("UPDATE fin_transactions SET category=payee,category_basis_state='confirmed'");
      const question = label => kind === 'payer' ? `Did the payment from ${label} arrive in October 2026?`
        : kind === 'income' ? `How much income from ${label} in October 2026?`
        : `How much did I spend ${kind === 'merchant' ? 'at' : 'on'} ${label} in October 2026?`;
      const control = await ask(f, question(payer ? 'Plain Alias' : short));
      assert.equal(control.evidence_gate.complete, true);
      if (kind === 'payer') assert.equal(control.ledger.found, true);
      else assert.equal(control.ledger.total_minor, 0);
      for (const cents of [0, 12731]) {
        f.raw("UPDATE fin_transactions SET amount_minor=? WHERE txn_uid='short'", cents);
        selection(await ask(f, question(full)), question(full)); arms++;
      }
      if (payer) {
        const alias = await ask(f, question('Literal Alias'));
        assert.equal(alias.evidence_gate.complete, true);
        if (kind === 'payer') assert.equal(alias.ledger.found, true);
        else assert.equal(alias.ledger.total_minor, 53123);
        f.raw("DELETE FROM fin_entities WHERE entity_slug='short'");
      }
      f.raw("DELETE FROM fin_transactions WHERE txn_uid='short'");
      const literal = await ask(f, question(full));
      assert.equal(literal.evidence_gate.complete, true);
      if (kind === 'payer') { assert.equal(literal.ledger.found, true); assert.equal(literal.ledger.amount_minor, null); }
      else assert.equal(literal.ledger.total_minor, 53123);
      arms++;
      // Neither interpretation matches: a populated, covered ledger cannot prove zero.
      const missing = await ask(f, question(`Missing ${word} Unit`));
      assert.equal(missing.evidence_gate.complete, false);
      assert.equal(missing.ledger.total_minor, null);
      assert.notEqual(missing.ledger.found, true);
      arms++;
    }
  }
  assert.equal(arms, 224);
});

test('cleanup outside a literal name, aliases and noun possessive external amounts stay exact', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  addIdentity(f, 'payer', 'Payer Unit', 'Registered Alias');
  f.add('payer', 'FROM: Payer Unit', 'Payer Unit', { cents: 40000 });
  f.add('store', 'Purchase', 'Supplier Unit', { direction: 'outflow', cents: 12300 });
  for (const filler of payerQuestionGrammar.filler) {
    const b = await ask(f, `${filler}, how much did I spend at Supplier Unit in October 2026?`);
    assert.equal(b.evidence_gate.complete, true); assert.equal(b.ledger.total_minor, 12300);
    const c = await ask(f, `How much did I spend at ${filler} Supplier Unit in October 2026?`);
    assertPossibleMatch(c, 12300);
  }
  for (const amount of amounts) for (const apostrophe of ["'", '’']) {
    for (const q of [`Did Payer Unit${apostrophe}s ${amount} payment arrive in October 2026?`, `Did the ${amount} payment from Registered Alias arrive in October 2026?`]) {
      const b = await ask(f, q); assert.equal(b.evidence_gate.complete, true);
      assert.equal(b.ledger.found, true); assert.equal(b.ledger.amount_minor, 40000);
    }
  }
});

test('amount/filler prefixes and suffixes, bare filler names and a second external amount preserve RAW', async t => {
  for (const token of [...payerQuestionGrammar.filler, ...amounts]) for (const label of [`${token} Unit`, `Unit ${token}`]) {
    for (const kind of ['merchant', 'category', 'payer']) {
      const f = ledgerFixture(t, { knownPayers: false });
      if (kind === 'payer') { addIdentity(f, 'full', label, 'Full Alias'); addIdentity(f, 'short', 'Unit'); }
      f.add('full', kind === 'payer' ? `FROM: ${label}` : 'Purchase', label, { direction: kind === 'payer' ? 'inflow' : 'outflow', cents: 53123 });
      f.add('short', kind === 'payer' ? 'FROM: Unit' : 'Purchase', 'Unit', { direction: kind === 'payer' ? 'inflow' : 'outflow', cents: 0 });
      f.raw("UPDATE fin_transactions SET category=payee,category_basis_state='confirmed'");
      const q = kind === 'payer' ? `Did the payment from ${label} arrive in October 2026?`
        : `How much did I spend ${kind === 'merchant' ? 'at' : 'on'} ${label} in October 2026?`;
      const b = await ask(f, q); selection(b, q);
    }
  }
  for (const label of payerQuestionGrammar.filler) {
    const f = ledgerFixture(t, { knownPayers: false });
    f.add('full', 'Purchase', label, { direction: 'outflow', cents: 53123 });
    const b = await ask(f, `How much did I spend at ${label} in October 2026?`);
    assert.equal(b.evidence_gate.complete, true); assert.equal(b.ledger.total_minor, 53123);
  }
  for (const amount of amounts) {
    const f = ledgerFixture(t, { knownPayers: false });
    addIdentity(f, 'full', `Payer ${amount} Unit`, 'Full Alias');
    f.add('full', `FROM: Payer ${amount} Unit`, `Payer ${amount} Unit`, { cents: 53123 });
    const b = await ask(f, `Did the $531.23 payment from Payer ${amount} Unit arrive in October 2026?`);
    assert.equal(b.evidence_gate.complete, true); assert.equal(b.ledger.found, true); assert.equal(b.ledger.amount_minor, 53123);
  }
});

test('literal and cleaned comparisons share the answer parsing budget', async t => {
  const { answerWithBudget } = await import('./partner-r2-helpers.mjs');
  const { createInflowAttributor, payerRegistry } = await import('../src/lib/ledger-attribution.js');
  const label = 'Unit Again Supply';
  const row = { direction: 'inflow', payee: label, description: `FROM: ${label}` };
  const registry = payerRegistry([{ entity_slug: 'full', legal_name: label, display_label: 'Full Alias' }]);
  const probe = createInflowAttributor(registry)(row);
  assert.equal(probe.state, 'confirmed');
  const steps = probe.evidence.parser.steps;
  assert.ok(steps > 0, 'nonempty sender parser decision reached');
  const f = ledgerFixture(t, { knownPayers: false, answer: await answerWithBudget(steps * 2 - 1) });
  addIdentity(f, 'full', label, 'Full Alias');
  f.add('full', row.description, label, { cents: 53123 });
  const control = await ask(f, 'Did the payment from Full Alias arrive in October 2026?');
  assert.equal(control.evidence_gate.complete, true); assert.equal(control.ledger.found, true);
  const b = await ask(f, `Did the payment from ${label} arrive in October 2026?`);
  assert.equal(b.evidence_gate.complete, false);
  assert.equal(b.evidence_gate.reason, 'answer_operation_limit');
  assert.equal(b.ledger.found, null);
  assert.ok(b.gaps.some(gap => gap.reason === 'answer_operation_limit'));
});

test('same-identity aliases agree, equal totals do not hide different rows, and a literal zero stays exact', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  addIdentity(f, 'payer', 'Again Payer Unit', 'Payer Unit');
  f.add('payer', 'FROM: Again Payer Unit', 'Again Payer Unit', { cents: 0 });
  const agreed = await ask(f, 'Did the payment from Again Payer Unit arrive in October 2026?');
  assert.equal(agreed.evidence_gate.complete, true); assert.equal(agreed.ledger.found, true);
  f.add('full', 'Purchase', 'Again Supply', { direction: 'outflow', cents: 0 });
  const zero = await ask(f, 'How much did I spend at Again Supply in October 2026?');
  assert.equal(zero.evidence_gate.complete, true); assert.equal(zero.ledger.total_minor, 0); assert.equal(zero.ledger.found, true);
  f.add('short', 'Purchase', 'Supply', { direction: 'outflow', cents: 0 });
  selection(await ask(f, 'How much did I spend at Again Supply in October 2026?'), undefined, 0);
});

test('invalid literal boundaries cannot reuse a cleaned merchant selector', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  f.add('short', 'Purchase', 'Supply', { direction: 'outflow', cents: 0 });
  const control = await ask(f, 'How much did I spend at Supply in October 2026?');
  assert.equal(control.evidence_gate.complete, true); assert.equal(control.ledger.total_minor, 0);
  for (const marker of ['\u0000', '\u200b']) {
    const before = f.documentCalls;
    const b = await f.ask(`How much did I spend at Again${marker} Supply in October 2026?`);
    assert.equal(b.route, 'documents'); assert.equal(f.documentCalls, before + 1, 'unsupported literal decision reached');
  }
});

test('amount-bearing payer names retain both readings when default payment windows differ', async t => {
  for (const amount of amounts) {
    const f = ledgerFixture(t, { knownPayers: false });
    const name = `Payer ${amount} Unit`;
    addIdentity(f, 'full', name, 'Full Alias'); addIdentity(f, 'short', 'Payer Unit', 'Short Alias');
    f.add('full', `FROM: ${name}`, name, { cents: 53123, date: '2026-09-01' });
    f.add('short', 'FROM: Payer Unit', 'Payer Unit', { cents: 40000 });
    const q = `Did the payment from ${name} arrive?`;
    const alias = await ask(f, 'Did the payment from Full Alias arrive?');
    assert.equal(alias.ledger.found, true); assert.equal(alias.evidence_gate.complete, true);
    selection(await ask(f, q), q);
    f.raw("DELETE FROM fin_entities WHERE entity_slug='short'");
    f.raw("DELETE FROM fin_transactions WHERE txn_uid='short'");
    const literal = await ask(f, q);
    assert.equal(literal.evidence_gate.complete, true); assert.equal(literal.ledger.found, true);
    assert.equal(literal.ledger.amount_minor, null); assert.equal(literal.ledger.from, '2026-08-14');
    f.raw("DELETE FROM fin_entities WHERE entity_slug='full'");
    f.raw("UPDATE fin_transactions SET payee='Payer Unit',description='FROM: Payer Unit',amount_minor=40000,posted_on='2026-10-05'");
    addIdentity(f, 'short', 'Payer Unit');
    const cleaned = await ask(f, q);
    assertPossibleMatch(cleaned, 40000);
    assert.equal(cleaned.ledger.from, '2026-08-14');
    f.add('old-short', 'FROM: Payer Unit', 'Payer Unit', { cents: 40000, date: '2026-09-01' });
    f.raw("DELETE FROM fin_transactions WHERE txn_uid='full'");
    const outside = await ask(f, q);
    assert.equal(outside.evidence_gate.complete, false); assert.notEqual(outside.ledger.found, true);
    assert.equal(outside.ledger.total_minor, null); assert.equal(outside.citations.length, 0);
  }
});

test('FROM-name possessives remain literal beside amount words and filler', async t => {
  for (const apostrophe of ["'", '’']) for (const token of [...amounts, ...payerQuestionGrammar.filler]) {
    for (const [full, short] of [[`Payer${apostrophe}s ${token} Unit`, `Payer${apostrophe}s Unit`], [`${token} Payer${apostrophe}s`, `Payer${apostrophe}s`]]) {
      const f = ledgerFixture(t, { knownPayers: false });
      addIdentity(f, 'full', full, 'Full Alias'); addIdentity(f, 'short', short);
      f.add('full', `FROM: ${full}`, full, { cents: 53123 });
      f.add('short', `FROM: ${short}`, short, { cents: 0 });
      const alias = await ask(f, 'Did the payment from Full Alias arrive in October 2026?');
      assert.equal(alias.evidence_gate.complete, true); assert.equal(alias.ledger.found, true);
      const q = `Did the payment from ${full} arrive in October 2026?`;
      selection(await ask(f, q), q);
      f.raw("DELETE FROM fin_entities WHERE entity_slug='short'");
      f.raw("DELETE FROM fin_transactions WHERE txn_uid='short'");
      const literal = await ask(f, q);
      assert.equal(literal.evidence_gate.complete, true); assert.equal(literal.ledger.found, true);
      assert.equal(literal.ledger.amount_minor, null);
    }
  }
});

test('an internal noun-name possessive is distinct from the external payment possessive', async t => {
  for (const amount of amounts) for (const apostrophe of ["'", '’']) {
    const f = ledgerFixture(t, { knownPayers: false });
    const full = `Payer${apostrophe}s ${amount} Unit`, short = `Payer${apostrophe}s Unit`;
    addIdentity(f, 'full', full, 'Full Alias'); addIdentity(f, 'short', short);
    f.add('full', `FROM: ${full}`, full, { cents: 53123 });
    f.add('short', `FROM: ${short}`, short, { cents: 0 });
    const alias = await ask(f, 'Did Full Alias\'s payment arrive in October 2026?');
    assert.equal(alias.evidence_gate.complete, true); assert.equal(alias.ledger.found, true);
    const q = `Did ${full}${apostrophe}s payment arrive in October 2026?`;
    selection(await ask(f, q), q);
    f.raw("DELETE FROM fin_entities WHERE entity_slug='short'");
    f.raw("DELETE FROM fin_transactions WHERE txn_uid='short'");
    const literal = await ask(f, q);
    assert.equal(literal.evidence_gate.complete, true); assert.equal(literal.ledger.found, true);
    assert.equal(literal.ledger.amount_minor, null);
    const external = await ask(f, `Did ${full}${apostrophe}s $531.23 payment arrive in October 2026?`);
    assert.equal(external.evidence_gate.complete, true); assert.equal(external.ledger.found, true);
    assert.equal(external.ledger.amount_minor, 53123);
  }
});
