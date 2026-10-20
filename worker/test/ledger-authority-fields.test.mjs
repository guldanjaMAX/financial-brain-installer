import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { attributeInflow, createInflowAttributor, payerRegistry } from '../src/lib/ledger-attribution.js';
import { channelPrefixes } from './ledger-attribution-cases.mjs';

const questions = name => [
  `Did the payment from ${name} arrive in October 2026?`,
  `How much income came from ${name} in October 2026?`,
];
const amountOnly = 'Did the payment of $25.00 arrive in October 2026?';
function setup(t) {
  const f = ledgerFixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  for (const [slug, label] of [['one', 'Payer One'], ['two', 'Payer Two']])
    f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,display_label,kind,relationship,provenance,basis_state,recorded_at)
      VALUES (?,?,?,'business','owned','owner_stated','confirmed',?)`, slug, label, `${label} Alias`, NOW);
  f.add('receipt', 'FROM: Payer Two', 'Payer Two');
  return f;
}
async function ask(f, question) {
  f.calls.length = 0;
  const before = f.first('SELECT total_changes() n').n;
  const body = await f.ask(question);
  assert.ok(f.calls.some(sql => /JOIN fin_transactions/.test(sql)), 'real transaction snapshot reached');
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 1, 'nonempty fixture');
  assert.equal(f.first('SELECT total_changes() n').n, before);
  assert.equal(f.documentCalls, 0);
  assert.equal(body.ledger.inflow_total_minor, 2500);
  return body;
}
async function positive(f, name = 'Payer Two') {
  for (const q of questions(name)) {
    const body = await ask(f, q);
    assert.equal(body.ledger.found, true);
    assert.equal(body.evidence_gate.complete, true);
  }
}
async function unknown(f) {
  for (const name of ['Payer One', 'Payer Two']) for (const q of questions(name)) {
    const body = await ask(f, q);
    assert.equal(body.ledger.found, null, 'neither presence nor absence');
    assert.equal(body.evidence_gate.complete, false);
    if (body.ledger.kind === 'merchant') assert.equal(body.ledger.total_minor, null, 'no payer zero');
  }
  assert.equal((await ask(f, amountOnly)).ledger.found, true, 'amount survives refusal');
}

for (const column of ['description', 'payee', 'legal_name', 'display_label']) {
  test(`snapshot NUL guard: ${column}, with valid other spelling retained`, async t => {
    const f = setup(t);
    await positive(f);
    const identity = ['legal_name', 'display_label'].includes(column);
    const table = identity ? 'fin_entities' : 'fin_transactions';
    const where = identity ? " WHERE entity_slug='two'" : '';
    const other = column === 'legal_name' ? 'display_label' : 'legal_name';
    if (identity) f.raw(`UPDATE fin_entities SET ${other}='Valid Supplier',${column}='Payer Two'${where}`);
    if (column === 'description') f.raw('UPDATE fin_transactions SET payee=NULL');
    const clean = column === 'description' ? 'FROM: Payer Two' : 'Payer Two';
    await positive(f);
    // Both a zero-length truncated field and a plausible nonempty prefix must
    // refuse. The complete raw spelling cannot enter the registry either.
    for (const value of [clean + '\0' + 'Unregistered Supplier', '\0' + clean]) {
      f.raw(`UPDATE ${table} SET ${column}=?${where}`, value);
      assert.ok(f.first(`SELECT instr(${column},char(0)) n FROM ${table}${where}`).n > 0);
      await unknown(f);
      if (identity) {
        assert.ok(f.calls.length);
        f.raw("UPDATE fin_transactions SET payee='Valid Supplier',description='FROM: Valid Supplier'");
        await positive(f, 'Valid Supplier');
        assert.ok(f.calls.some(sql => /legal_name_has_nul/.test(sql) && /display_label_has_nul/.test(sql)), 'both identity guards read in the snapshot');
        f.raw("UPDATE fin_transactions SET payee='Payer Two',description='FROM: Payer Two'");
      }
    }
    f.raw(`UPDATE ${table} SET ${column}=?${where}`, clean);
    await positive(f);
  });
}

test('raw and SQL-flagged NUL spellings cannot enter lookup or reuse a cached decision', () => {
  const registry = payerRegistry([{ entity_slug: 'two', legal_name: 'Payer Two' }]);
  const attribute = createInflowAttributor(registry);
  assert.equal(attribute({ description: 'FROM: Payer Two' }).state, 'confirmed');
  for (const row of [
    { payee: 'Payer Two', payee_has_nul: 1 },
    { payee: '', payee_has_nul: 1 },
    { payee: 'Payer Two\0' },
  ]) {
    const result = attribute({ description: 'FROM: Payer Two', ...row });
    assert.equal(result.evidence.source, 'payee', 'payee refusal precedes description fallback/cache');
    assert.equal(result.state, 'unknown');
  }
  for (const column of ['legal_name', 'display_label']) for (const flagged of [false, true]) {
    const other = column === 'legal_name' ? 'display_label' : 'legal_name';
    const entries = [{ entity_slug: 'two', [column]: flagged ? 'Payer Two' : 'Payer Two\0',
      [column + '_has_nul']: flagged ? 1 : 0, [other]: 'Valid Supplier' }];
    const index = payerRegistry(entries);
    assert.equal(index.size, 1, 'valid spelling still indexed');
    assert.equal(attributeInflow({ payee: 'Valid Supplier' }, index).state, 'confirmed');
    assert.equal(attributeInflow({ payee: 'Payer Two' }, index).state, 'unknown');
  }
});

test('channel prefixes need a sender label for confirmation and preserve same-entity whole readings', () => {
  for (const prefix of channelPrefixes) {
    const identities = [{ entity_slug: 'two', legal_name: 'Payer Two' }];
    const parse = labels => attributeInflow({ description: `${prefix} Payer Two` }, payerRegistry(labels));
    const assumed = parse(identities);
    assert.ok(assumed.evidence.parser.steps > 0);
    assert.equal(assumed.state, 'assumed');
    assert.equal(assumed.reading.prefix, prefix.toLowerCase());
    for (const sender of ['FROM', 'BY', 'FROM:', 'ORIG CO NAME:', 'SENDER:'])
      assert.equal(attributeInflow({ description: `${prefix} ${sender} Payer Two` }, payerRegistry(identities)).state, 'confirmed');
    assert.equal(parse([{ ...identities[0], display_label: `${prefix} Payer Two` }]).state, 'confirmed');
    assert.equal(parse([...identities, { entity_slug: 'other', legal_name: `${prefix} Payer Two` }]).state, 'unknown');
  }
});

test('company commas retain conflicting field alternatives and reject unregistered prose', () => {
  const registry = payerRegistry([{ entity_slug: 'one', legal_name: 'Supplier Services, LLC' },
    { entity_slug: 'two', legal_name: 'Payer Two' }]);
  const parse = description => {
    const result = attributeInflow({ description }, registry);
    assert.ok(result.evidence.parser.steps > 0);
    return result;
  };
  assert.equal(parse('FROM: Supplier Services, LLC; REF: 123').state, 'confirmed');
  for (const tail of [', FROM: Payer Two', '; REF: 123, BY Payer Two', ', Unregistered Supplier'])
    assert.equal(parse('FROM: Supplier Services, LLC' + tail).state, 'unknown');
  for (const slug of ['one', 'two']) {
    const entries = [{ entity_slug: 'one', legal_name: 'Payer One' },
      { entity_slug: slug, legal_name: 'Payer One, FROM: Payer One' }];
    const result = attributeInflow({ description: 'FROM: Payer One, FROM: Payer One' }, payerRegistry(entries));
    assert.ok(result.evidence.candidates.length >= 2, 'whole and boundary readings both survive');
    assert.equal(result.state, slug === 'one' ? 'confirmed' : 'unknown');
  }
});

test('comma support cannot strip an unregistered comma to authorize a name', () => {
  const registry = payerRegistry([{ entity_slug: 'one', legal_name: 'Supplier Services LLC' }]);
  assert.equal(attributeInflow({ description: 'FROM: Supplier Services LLC' }, registry).state, 'confirmed');
  for (const description of ['FROM: Supplier Services LLC,', 'FROM: Supplier, Services LLC']) {
    const result = attributeInflow({ description }, registry);
    assert.ok(result.evidence.parser.steps > 0);
    assert.equal(result.state, 'unknown');
  }
  const named = payerRegistry([{ entity_slug: 'one', legal_name: 'Supplier Services, LLC' }]);
  assert.equal(attributeInflow({ description: 'FROM: supplier SERVICES, llc' }, named).state, 'confirmed');
  const wrong = attributeInflow({ description: 'FROM: Supplier, Services LLC' }, named);
  assert.ok(wrong.evidence.parser.steps > 0);
  assert.equal(wrong.state, 'unknown', 'comma positions must match a registered spelling');
});

test('prefix shorthand never certifies a payer zero or an amount-mismatch absence', async t => {
  const f = setup(t);
  await positive(f);
  for (const prefix of channelPrefixes) {
    f.raw('UPDATE fin_transactions SET payee=NULL,description=?,amount_minor=2500', `${prefix} Payer Two`);
    for (const name of ['Payer One', 'Payer Two']) {
      const body = await ask(f, `Did the payment of $26.00 from ${name} arrive in October 2026?`);
      assert.equal(body.ledger.found, null);
      assert.equal(body.ledger.unattributed_count, 1);
      assert.equal(body.evidence_gate.complete, false);
    }
    f.raw('UPDATE fin_transactions SET amount_minor=0');
    for (const name of ['Payer One', 'Payer Two']) for (const q of questions(name)) {
      f.calls.length = 0;
      const body = await f.ask(q);
      assert.ok(f.calls.some(sql => /JOIN fin_transactions/.test(sql)));
      assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 1);
      assert.equal(body.ledger.inflow_total_minor, 0);
      assert.equal(body.ledger.found, null);
      assert.equal(body.evidence_gate.complete, false);
      if (body.ledger.kind === 'merchant') assert.equal(body.ledger.total_minor, null);
    }
    const grouped = await f.ask('Show income by merchant in October 2026?');
    assert.equal(grouped.ledger.groups.length, 1);
    assert.equal(grouped.ledger.groups[0].merchant, 'Unattributed');
    assert.equal(grouped.ledger.groups[0].attribution_state, 'unknown');
    assert.equal(grouped.ledger.groups[0].total_minor, 0, 'unattributed money is retained without a payer zero claim');
    assert.equal(grouped.assumptions, undefined);
    assert.equal(grouped.ledger.groups[0].total_is_exact, false);
    assert.equal(grouped.ledger.inflow_total_minor, 0);
  }
});

test('prefix and suffix notes retain their order and separate repeated receipt counts', async t => {
  const f = setup(t);
  await positive(f);
  f.raw("UPDATE fin_transactions SET payee=NULL,description='PAYMENT Payer Two'");
  f.add('prefix-repeat', 'PAYMENT Payer Two', null);
  f.add('suffix', 'Payer Two payment', null);
  const body = await f.ask('Show income by merchant in October 2026?');
  assert.equal(body.ledger.inflow_total_minor, 7500);
  assert.equal(body.ledger.groups[0].attribution_state, 'assumed');
  assert.equal(body.ledger.groups[0].total_is_exact, false);
  assert.equal(body.citations.length, 3);
  assert.deepEqual(body.assumptions.map(a => [a.prefix, a.suffix, a.count, a.amount_minor]),
    [['payment', undefined, 2, 5000], [undefined, 'payment', 1, 2500]]);
  for (const [i, a] of body.assumptions.entries()) {
    assert.equal(a.citations.length, a.count);
    assert.ok(a.citations.every(n => body.citations.some(c => c.n === n)));
    assert.ok(body.notes[i].includes(i === 0 ? `payment + ${a.identity}` : `${a.identity} + payment`));
    assert.ok(body.answer.includes(body.notes[i]));
  }
  const exact = await f.ask('Show income by merchant in October 2026, exact names only?');
  assert.equal(exact.ledger.inflow_total_minor, 7500);
  assert.equal(exact.ledger.groups[0].attribution_state, 'unknown');
  assert.equal(exact.assumptions, undefined);
});
