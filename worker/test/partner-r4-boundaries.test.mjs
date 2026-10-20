import { assertPossibleMatch } from './partner-r7-assertions.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { attributeInflow, payerRegistry, payerQuestionRegistry } from '../src/lib/ledger-attribution.js';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';

const entities = [
  { entity_slug: 'one', legal_name: 'Payer One LLC', display_label: 'Payer One' },
  { entity_slug: 'two', legal_name: 'Payer Two LLC' },
];
function world(t) {
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  const f = ledgerFixture(t, { knownPayers: false });
  for (const e of entities) f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,display_label,kind,relationship,provenance,basis_state,recorded_at)
    VALUES (?,?,?,'business','owned','owner_stated','confirmed',?)`, e.entity_slug, e.legal_name, e.display_label || null, NOW);
  return f;
}
async function reached(f, question) {
  const start = f.calls.length, writes = f.first('SELECT total_changes() n').n;
  const body = await f.ask(question);
  assert.ok(f.calls.slice(start).some(sql => /JOIN fin_transactions/.test(sql)), 'nonempty ledger decision reached');
  assert.ok(f.first('SELECT COUNT(*) n FROM fin_transactions').n > 0);
  assert.equal(f.first('SELECT total_changes() n').n, writes);
  assert.ok(body.ledger);
  return body;
}

test('R4 payee agreement includes unregistered labelled senders and preserves both candidates', async t => {
  const f = world(t);
  f.add('receipt', 'FROM: Payer One LLC', 'Payer One LLC');
  const registry = payerRegistry(entities);
  for (const sender of ['Payer Two LLC', 'Outside Sender']) {
    const row = { payee: 'Payer One LLC', description: `FROM: ${sender}; SEC: CCD` };
    const result = attributeInflow(row, registry);
    assert.equal(result.state, 'unknown');
    assert.equal(result.evidence.parser.complete, true);
    assert.equal(result.evidence.ambiguous, true);
    assert.deepEqual(new Set(result.evidence.candidates), new Set([row.payee, sender]));
    f.raw('UPDATE fin_transactions SET description=?', row.description);
    for (const name of ['Payer One LLC', 'Payer Two LLC']) for (const q of [
      `Did the payment from ${name} arrive in October 2026?`,
      `How much income came from ${name} in October 2026?`,
    ]) {
      const body = await reached(f, q);
      assert.equal(body.ledger.found, null);
      assert.equal(body.evidence_gate.complete, false);
      assert.doesNotMatch(body.answer, /\$0\.00|No matching|Found a deposit/);
    }
  }
  f.raw('UPDATE fin_transactions SET description=?', 'FROM: Payer One');
  assert.equal((await reached(f, 'Did the payment from Payer One LLC arrive in October 2026?')).ledger.found, true);
  assert.equal(attributeInflow({ payee: 'Payer One LLC', description: 'FROM: Payer One' }, registry).state, 'confirmed');
});

test('R4B agreement normalizes both fields and ignores only a closed trailing company suffix', async t => {
  const f = world(t);
  f.add('receipt', 'FROM: Supplier Unit', 'Supplier Unit');
  for (const [payee, sender] of [
    ['Supplier Unit', 'Supplier Unit'], ['Ｓｕｐｐｌｉｅｒ Unit', 'supplier unit'],
    ['Supplier Unit', 'Supplier Unit, LLC'], ['Supplier Unit、LLC', 'Supplier Unit'],
    ['Supplier Unit Ltd.', 'Supplier Unit, N.A.'], ['Supplier & Unit', 'Supplier & Unit Ltd.'],
  ]) {
    f.raw('UPDATE fin_transactions SET payee=?,description=?', payee, `FROM: ${sender}`);
    for (const name of [payee, sender]) {
      const q = `Did the payment from ${name} arrive in October 2026?`;
      const registry = payerQuestionRegistry(classifyLedgerQuestion(q, { now: Date.parse(NOW) }), payerRegistry(entities));
      const a = attributeInflow({ payee, description: `FROM: ${sender}` }, registry);
      assert.equal(a.evidence.parser.complete, true, 'both complete fields reached agreement');
      assert.equal(a.state, 'observed', JSON.stringify({ payee, sender, q, a }));
      assert.equal((await reached(f, q)).ledger.found, true, JSON.stringify({ payee, sender, q }));
      const income = await reached(f, `How much income came from ${name} in October 2026?`);
      const exactAgreement = payee.normalize('NFKC').toLowerCase() === sender.toLowerCase();
      assert.equal(income.ledger.total_minor, exactAgreement ? 2500 : null);
      if (!exactAgreement) assert.equal(income.ledger.attributed_subtotal_minor, 2500);
      assert.equal(income.evidence_gate.complete, exactAgreement);
    }
  }
  for (const [payee, sender] of [
    ['Payer One LLC', 'Payer One'], ['Payer Two LLC', 'Payer Two'],
    ['Payer Two', 'Payer Two LLC'], ['Payer Two LLC', 'Payer Two, Inc.'],
    ['Payer Two LLC', 'Payer Two (Ltd.)'],
  ]) {
    const a = attributeInflow({ payee, description: `FROM: ${sender}` }, payerRegistry(entities));
    assert.equal(a.evidence.parser.complete, true);
    assert.equal(a.state, 'confirmed');
    assert.equal(a.entity_slug, payee.includes('One') ? 'one' : 'two');
  }
  // Agreement with the exact structured field does not relax the separate
  // query-only description vocabulary rule (which includes "co").
  for (const suffix of ['LLC', 'LLP', 'LP', 'Inc.', 'Ltd.', 'Corp.', 'Corporation', 'Co.', 'Company', 'PLC', 'PC', 'PA', 'N.A.', 'S.A.']) {
    const q = 'Did the payment from Supplier Unit arrive in October 2026?';
    const registry = payerQuestionRegistry(classifyLedgerQuestion(q, { now: Date.parse(NOW) }), payerRegistry(entities));
    const row = { payee: 'Supplier Unit', description: `FROM: Supplier Unit, ${suffix}` };
    const parsed = attributeInflow({ description: row.description }, registry);
    assert.ok(parsed.evidence.labelled_senders.length > 0, 'complete company sender reached agreement');
    assert.equal(attributeInflow(row, registry).state, 'observed');
    f.raw('UPDATE fin_transactions SET payee=?,description=?', row.payee, row.description);
    assert.equal((await reached(f, q)).ledger.found, true);
  }
});

test('R4B disagreement retains both candidates even when another identity differs only by a company suffix', () => {
  const registry = payerRegistry([...entities, { entity_slug: 'three', legal_name: 'Payer Two Inc.' }]);
  for (const [payee, sender] of [
    ['Payer Two LLC', 'Payer Two Inc.'], ['Payer Two LLC', 'Outside Sender, LLC'],
    ['Outside Sender', 'Payer Two LLC'], ['Supplier Unit', 'Supplier Unit Services'],
    ['Supplier and Unit', 'Supplier & Unit'],
  ]) {
    const a = attributeInflow({ payee, description: `FROM: ${sender}` }, registry);
    assert.equal(a.evidence.parser.complete, true, 'complete sender decision reached');
    assert.equal(a.state, 'unknown');
    assert.deepEqual(new Set(a.evidence.candidates), new Set([payee, sender]));
    assert.equal(a.evidence.query_phrases, undefined);
  }
  const control = attributeInflow({ payee: 'Payer Two LLC', description: 'FROM: Payer Two LLC' }, registry);
  assert.equal(control.state, 'confirmed');
  const competing = attributeInflow({ payee: 'Payer Two', description: 'FROM: Payer Two LLC; FROM: Payer Two Inc.' }, registry);
  assert.equal(competing.evidence.parser.complete, true);
  assert.equal(competing.state, 'unknown', 'an unregistered payee cannot join two registered identities');
  assert.deepEqual(new Set(competing.evidence.candidates), new Set(['Payer Two', 'Payer Two LLC', 'Payer Two Inc.']));
});

test('R4 spend selectors end at the period and unsupported tails never certify zero', async t => {
  const f = world(t);
  f.add('expense', 'Office purchase', 'Vendor One', { direction: 'outflow', cents: 30000, date: '2026-09-15' });
  f.raw("UPDATE fin_transactions SET category='Office',category_basis_state='confirmed'");
  for (const selector of ['at Vendor One', 'on Office']) {
    const prefix = `How much did I spend ${selector}`;
    assert.equal((await reached(f, `${prefix} in September 2026?`)).ledger.total_minor, 30000);
    for (const tail of [' please', ', thanks', ' of 2026', ' unexplained', ' unexpectedly', ' unexplained please', ' right now', ' again']) {
      const q = `${prefix} in September 2026${tail}?`;
      const parsed = classifyLedgerQuestion(q, { now: Date.parse(NOW) });
      const body = await f.ask(q);
      if (parsed.kind) {
        assert.equal(body.ledger.total_minor, 30000, q);
        assert.equal(body.evidence_gate.complete, true);
      } else assert.equal(body.route, 'documents', 'unsupported grammar decision reached');
    }
    assert.equal((await reached(f, `${prefix} in September of 2026?`)).ledger.total_minor, 30000);
  }
});

test('R4 amount and possessive noun readings keep their payer coverage', async t => {
  const f = world(t); f.add('receipt', 'ACH CREDIT', 'Payer One LLC', { cents: 40000 });
  for (const amount of ['$400', '400 dollar', '400 dollars', 'USD 400']) {
    const body = await reached(f, `Did the ${amount} payment from Payer One LLC arrive on 2026-10-05?`);
    assert.equal(body.ledger.found, true);
  }
  for (const apostrophe of ["'", '’']) {
    const body = await reached(f, `Did Payer One LLC${apostrophe}s payment arrive in October 2026?`);
    assert.equal(body.ledger.found, true);
  }
});

test('R4 period words inside complete payer and merchant spans are names', async t => {
  const f = world(t);
  f.raw('UPDATE fin_entities SET legal_name=? WHERE entity_slug=?', 'Last Mile Partners LLC', 'one');
  f.add('receipt', 'ACH CREDIT', 'Last Mile Partners LLC');
  for (const q of ['Did the payment from Last Mile Partners LLC arrive in October 2026?',
    'How much income came from Last Mile Partners LLC in October 2026?'])
    assert.equal((await reached(f, q)).ledger.found, true);
  f.raw("UPDATE fin_transactions SET direction='outflow'");
  assert.equal((await reached(f, 'How much did I spend at Last Mile Partners LLC in October 2026?')).ledger.total_minor, 2500);
});

test('R4 named months inside complete merchant spans do not add a second period', async t => {
  const f = world(t);
  f.add('expense', 'Purchase', 'April Services LLC', { direction: 'outflow' });
  const q = 'How much did I spend at April Services LLC in October 2026?';
  assert.equal((await reached(f, q)).ledger.total_minor, 2500);
  assertPossibleMatch(await reached(f, 'In October 2026, how much did I spend at April Services LLC again?'), 2500);
  const ambiguous = classifyLedgerQuestion(`${q.slice(0, -1)} in September 2026?`, { now: Date.parse(NOW) });
  assert.equal(ambiguous.kind, null, 'two external period clauses still refuse');
});

test('R4 possessive cleanup is confined to noun form and preserves a FROM payer spelling', async t => {
  const f = world(t);
  f.raw('UPDATE fin_entities SET legal_name=? WHERE entity_slug=?', "Supplier's Payment", 'one');
  f.add('receipt', 'ACH CREDIT', "Supplier's Payment");
  assert.equal((await reached(f, "Did the payment from Supplier's Payment arrive in October 2026?")).ledger.found, true);
  assert.equal((await reached(f, "Did Supplier's Payment's payment arrive in October 2026?")).ledger.found, true);
});

test('R4 raw control text cannot impersonate the internal period boundary and hide a tail', async t => {
  const f = world(t);
  f.add('expense', 'Purchase', 'Vendor One', { direction: 'outflow' });
  assert.equal((await reached(f, 'How much did I spend at Vendor One in October 2026?')).ledger.total_minor, 2500);
  const question = 'How much did I spend at Absent Vendor \u0001 in October 2026 unexplained?';
  assert.equal(classifyLedgerQuestion(question, { now: Date.parse(NOW) }).kind, null);
  assert.equal((await f.ask(question)).route, 'documents', 'unsupported grammar decision reached');
});

test('R4 aggregation and trailing relative periods retain their existing routing', () => {
  for (const selector of ['by merchant', 'by category', 'at Vendor One', 'on Office']) {
    const control = classifyLedgerQuestion(`How much did I spend ${selector} in September 2026?`, { now: Date.parse(NOW) });
    assert.ok(control.kind, 'canonical grammar control reached');
    const result = classifyLedgerQuestion(`How much did I spend ${selector} last month?`, { now: Date.parse(NOW) });
    assert.equal(result.kind, control.kind);
    assert.equal(result.from, control.from);
    assert.equal(result.to, control.to);
    assert.equal(result.match, control.match);
  }
});
