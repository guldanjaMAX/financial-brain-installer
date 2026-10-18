import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { originatorWords, originatorFormats, boundaryReadingCases } from './ledger-attribution-cases.mjs';
import { LEDGER_ANSWER_KINDS, classifyLedgerQuestion } from '../src/lib/ledger-question.js';
import { attributeInflow, payerRegistry } from '../src/lib/ledger-attribution.js';
import { senderFor, merchantFor } from '../src/lib/ledger-analysis.js';

const paths = [
  ['payment', 'payment', 'Did the payment from QUERY arrive in October 2026?', true],
  ['named-income', 'merchant', 'How much income came from QUERY in October 2026?', true],
  ['income-by-merchant', 'merchant', 'Show income by merchant in October 2026?'],
  ['deposits', 'deposits', 'Show my deposits in October 2026?'],
  ['largest', 'largest', 'Show my largest deposits in October 2026?'],
  ['totals', 'totals', 'How much money came in and went out in October 2026?'],
  ['category', 'category', 'Show income by category in October 2026?'],
  ['recurring', 'recurring', 'Show my recurring charges in October 2026?'],
  ['transfers', 'transfers', 'Show my transfers in October 2026?'],
];
const noInflow = { balance: 'balance snapshots have no payer' };
const amountOnly = 'Did the payment of $25.00 arrive in October 2026?';
const identifier = 'AB48CD26EF17GH03';
const amount = 2500;
function identity(f, label, slug, alias = null) {
  f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,display_label,kind,relationship,provenance,basis_state,recorded_at)
    VALUES (?,?,?,'business','counterparty','owner_stated','confirmed',?)`, slug, label, alias, NOW);
}
function setup(t, kind) {
  const f = ledgerFixture(t);
  t.mock.method(globalThis, 'fetch', () => { assert.fail('network forbidden'); });
  f.add('receipt', 'FROM: Payer One', null);
  f.raw("UPDATE fin_transactions SET category='income',category_basis_state='confirmed'");
  // Totals and category figures do not name payers themselves, but their
  // transfer diagnostics do. Force that real secondary rendering path.
  if (['totals', 'category', 'transfers', 'recurring'].includes(kind)) {
    f.raw(`INSERT INTO fin_accounts(account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at)
      VALUES ('reserve','owner','savings','asset','5678','manual','owner_stated','confirmed',?)`, NOW);
    f.raw(`INSERT INTO fin_account_coverage(account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES ('reserve','complete','2024-01-01','2026-10-12',?,'owner_stated','confirmed',?)`, NOW, NOW);
    f.add('outgoing', 'Transfer to account 1234', null, { direction: 'outflow' });
    f.raw("UPDATE fin_transactions SET account_slug='reserve' WHERE txn_uid='outgoing'");
  }
  return f;
}
async function ask(f, q, kind) {
  f.calls.length = 0;
  const changes = f.first('SELECT total_changes() n').n;
  const body = await f.ask(q);
  assert.ok(f.calls.some(sql => /JOIN fin_transactions/.test(sql)), 'this arm reached the transaction decision');
  assert.ok(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 'the decision has rows');
  assert.equal(f.documentCalls, 0, 'no fallback can hide a refusal');
  assert.equal(body.ledger?.kind, kind, 'the requested answer path ran');
  assert.equal(f.first('SELECT total_changes() n').n, changes, 'attribution writes no facts');
  return body;
}
function validate(body, { named, kind, state, same, exact, stats }) {
  const ledger = body.ledger;
  const positive = state === 'confirmed' ? same : state === 'assumed' && same && !exact;
  const uncertain = state === 'unknown' || (state === 'assumed' && !positive);
  assert.equal(ledger.inflow_total_minor, amount, 'the scoped inflow survives every attribution decision and flip');
  if (named) {
    assert.equal(ledger.found, positive ? true : uncertain ? null : false);
    assert.equal(body.evidence_gate.complete, !uncertain);
    if (kind === 'merchant') assert.equal(ledger.total_minor, uncertain ? null : positive ? amount : 0);
    if (!positive && state !== 'confirmed') assert.doesNotMatch(body.answer, /no matching|\$0\.00/i);
  } else {
    if (['merchant', 'category'].includes(kind)) assert.equal(ledger.total_minor, amount);
    if (['deposits', 'largest'].includes(kind)) assert.equal(ledger.rows.reduce((sum, r) => sum + r.amount_minor, 0), amount);
    if (kind === 'totals') assert.equal(ledger.accounts.reduce((sum, a) => sum + a.credits_minor, 0), amount);
    if (['totals', 'category', 'transfers', 'recurring'].includes(kind)) assert.equal(ledger.transfers.length, 1, 'secondary inflow rendering reached');
    const displayState = state === 'assumed' && exact ? 'unknown' : state;
    const displayed = kind === 'merchant' ? ledger.groups : ['deposits', 'largest'].includes(kind) ? ledger.rows : ledger.transfers.map(p => p.incoming);
    assert.ok(displayed.length, 'payer rendering has a nonempty result');
    assert.ok(displayed.every(row => row.attribution_state === displayState));
    if (displayState === 'unknown') assert.match(body.answer, /Unattributed/);
  }
  const depends = state === 'assumed' && !exact && (!named || positive);
  if (depends) {
    assert.ok(body.assumptions?.length, 'every assumed figure or grouping needs an assumption');
    assert.ok(ledger.flip.includes('exact names only'));
    assert.match(body.answer, /Note:.*exact names only/);
    for (const note of body.notes) assert.ok(body.answer.includes(note));
    for (const assumption of body.assumptions) assert.ok(assumption.citations.every(n => body.citations.some(c => c.n === n)));
    stats.notes++;
  } else assert.equal(body.assumptions, undefined);
  const serialized = JSON.stringify(body);
  for (const token of [identifier, '4826170392', '48261703', '482617039258', '482617039258001', '261005', 'A-123', 'AB/12', 'A.1.2.3'])
    assert.ok(!serialized.includes(token), 'no complete identifier in any response field');
  stats.answers++;
  stats[state]++;
}

test('every exported answer kind has an attribution path or a proved no-inflow reason', () => {
  const source = readFileSync(new URL('../src/lib/ledger-question.js', import.meta.url), 'utf8');
  const literalKinds = [...source.matchAll(/kind:\s*["']([a-z]+)["']/g)].map(m => m[1]);
  literalKinds.push('merchant');
  // Dynamic merchant/category grammar is explicitly included. A new literal
  // parser branch cannot evade coverage by omitting itself from the inventory.
  assert.deepEqual([...new Set(literalKinds)].sort(), [...LEDGER_ANSWER_KINDS].sort());
  assert.deepEqual([...new Set([...paths.map(p => p[1]), ...Object.keys(noInflow)])].sort(), [...LEDGER_ANSWER_KINDS].sort());
  for (const [, kind, q] of paths) assert.equal(classifyLedgerQuestion(q.replace('QUERY', 'Payer One'), { now: NOW }).kind, kind);
  for (const q of ['Show my top payers in October 2026?', 'List my payers in October 2026?'])
    assert.equal(classifyLedgerQuestion(q, { now: NOW }).kind, null, 'unsupported grammar is recorded, not silently invented');
});

test('legacy sender helpers require the single decision and never parse inflow text', () => {
  const row = { direction: 'inflow', description: 'Payer One payment' };
  const attribution = attributeInflow(row, payerRegistry([{ entity_slug: 'payer', legal_name: 'Payer One' }]));
  assert.equal(attribution.state, 'assumed');
  assert.equal(senderFor(row), ''); assert.equal(merchantFor(row), '');
  assert.equal(senderFor(row, attribution), 'payer one');
  assert.equal(merchantFor(row, attribution), 'payer one');
});

for (const [path, kind, question, named = false] of paths) test(`every-path generated matrix: ${path}`, async t => {
  const f = setup(t, kind), stats = { path, kind, cases: 0, answers: 0, confirmed: 0, assumed: 0, unknown: 0, notes: 0, boundary_families: {} };
  identity(f, 'Unrelated Supplier', 'unrelated');
  const shorter = 'Synthetic Supplier';
  const longerLabels = originatorWords.flatMap(word => [
    `${shorter} ${word} Services LLC`, `${word} ${shorter} LLC`, `${shorter} Services ${word} ${identifier} LLC`,
  ]);
  async function exercise(description, state, alias, { payee = null } = {}) {
    f.raw("UPDATE fin_transactions SET description=?,payee=? WHERE txn_uid='receipt'", description, payee);
    const control = await ask(f, amountOnly, 'payment');
    assert.equal(control.ledger.found, true, 'same receipt is a green amount-only control');
    const selectors = named ? [alias, alias === 'Short Supplier' ? 'Long Supplier' : 'Short Supplier', 'Unrelated Supplier'] : [alias];
    for (const selector of selectors) for (const exact of [false, true]) {
      const q = question.replace('QUERY', selector).replace('?', exact ? ', exact names only?' : '?');
      const body = await ask(f, q, kind);
      validate(body, { named, kind, state, same: selector === alias, exact, stats });
    }
    stats.cases++;
  }
  for (const [formatIndex, format] of originatorFormats.entries()) for (const longer of longerLabels) {
    for (const registration of ['shorter', 'both', 'longer']) {
      f.raw("DELETE FROM fin_entities WHERE entity_slug IN ('shorter','longer')");
      if (registration !== 'longer') identity(f, shorter, 'shorter', 'Short Supplier');
      if (registration !== 'shorter') identity(f, longer, 'longer', 'Long Supplier');
      for (const field of [shorter, longer]) {
        const registered = field === shorter ? registration !== 'longer' : registration !== 'shorter';
        const shorthand = formatIndex >= 1 && formatIndex <= 3;
        const unsupported = format.includes('\n');
        const state = !registered || unsupported ? 'unknown' : shorthand ? 'assumed' : 'confirmed';
        await exercise(format.replace(/Payer One|Supplier Alias/, field), state, field === shorter ? 'Short Supplier' : 'Long Supplier');
      }
    }
  }
  // Every kind also crosses the full shorthand vocabulary, same-entity alias
  // readings, and conflicting fields behind metadata using every delimiter.
  f.raw("DELETE FROM fin_entities WHERE entity_slug IN ('shorter','longer')");
  identity(f, 'Payer One', 'shorter', 'Short Supplier');
  identity(f, 'Payer Two', 'longer', 'Long Supplier');
  for (const type of ['deposit', 'payment', 'receipt', 'payroll', 'settlement']) for (const channel of ['', 'ach ', 'eft ', 'wire ', 'zelle '])
    await exercise(`Payer One ${channel}${type}`, 'assumed', 'Short Supplier');
  f.raw("UPDATE fin_entities SET display_label='Payer One payment' WHERE entity_slug='shorter'");
  await exercise('Payer One payment', 'confirmed', 'Payer One');
  for (const prefix of ['From', 'By', 'Wire From']) {
    f.raw("UPDATE fin_entities SET display_label=? WHERE entity_slug='shorter'", `${prefix} Payer One`);
    await exercise(`${prefix} Payer One`, 'confirmed', 'Payer One');
    f.raw("UPDATE fin_entities SET display_label=NULL WHERE entity_slug='shorter'");
    f.raw("UPDATE fin_entities SET display_label=? WHERE entity_slug='longer'", `${prefix} Payer One`);
    await exercise(`${prefix} Payer One`, 'unknown', 'Payer One');
    f.raw("UPDATE fin_entities SET display_label='Long Supplier' WHERE entity_slug='longer'");
  }
  f.raw("UPDATE fin_entities SET display_label='Payer One payment' WHERE entity_slug='shorter'");
  for (const delimiter of [',', ';', '|', '\n']) for (const clause of ['FROM', 'BY', 'FROM:', 'SENDER:']) {
    await exercise(`WIRE FROM: Payer One; REF: 48261703${delimiter} ${clause} Payer Two`, 'unknown', 'Payer One');
    await exercise(`WIRE FROM: Payer One; REF: 48261703${delimiter} ${clause} Payer One payment`, delimiter === '\n' ? 'unknown' : 'confirmed', 'Payer One');
  }
  for (const token of ['A-123', 'AB/12', 'A.1.2.3']) await exercise(token, 'confirmed', 'Payer One', { payee: 'Payer One' });
  for (const arm of boundaryReadingCases()) {
    f.raw("DELETE FROM fin_entities WHERE entity_slug IN ('shorter','longer')");
    for (const entry of arm.identities) identity(f, entry.legal_name, entry.entity_slug, entry.display_label);
    await exercise(arm.description, arm.state, arm.selector || 'Short Supplier');
    stats.boundary_families[arm.family] = (stats.boundary_families[arm.family] || 0) + 1;
  }
  assert.ok(stats.confirmed > 0 && stats.assumed > 0 && stats.unknown > 0, 'uniform arms invalidate the matrix');
  t.diagnostic(JSON.stringify({ attribution_path: stats }));
});

test('mixed groups conserve money, merge same-entity aliases and never certify a conditional payer zero from assumptions', async t => {
  const f = setup(t, 'merchant');
  identity(f, 'Payer One', 'payer-one', 'Supplier Alias');
  identity(f, 'Payer Two', 'payer-two');
  f.add('alias', 'FROM: Supplier Alias', null, { cents: 3500 });
  f.add('assumed', 'Payer Two payment', null, { cents: 4500 });
  const q = 'Show income by merchant in October 2026?';
  const body = await ask(f, q, 'merchant');
  assert.deepEqual(body.ledger.groups.map(g => [g.total_minor, g.attribution_state, g.total_is_exact]),
    [[6000, 'confirmed', false], [4500, 'assumed', false]]);
  assert.equal(body.assumptions[0].amount_minor, 4500);
  const exact = await ask(f, q.replace('?', ', exact names only?'), 'merchant');
  assert.equal(exact.ledger.total_minor, 10500);
  assert.equal(exact.ledger.inflow_total_minor, body.ledger.inflow_total_minor);
  assert.deepEqual(exact.ledger.groups.map(g => [g.total_minor, g.attribution_state]), [[6000, 'confirmed'], [4500, 'unknown']]);
  assert.equal(exact.ledger.groups[1].merchant, 'Unattributed');
  const partial = await ask(f, 'How much income came from Payer One in October 2026?', 'merchant');
  assert.equal(partial.ledger.total_minor, null);
  assert.equal(partial.ledger.confirmed_subtotal_minor, 6000);
  assert.equal(partial.ledger.unattributed_count, 1);
  f.raw("UPDATE fin_transactions SET payee='Payer Two' WHERE txn_uid='assumed'");
  const confirmed = await ask(f, q, 'merchant');
  assert.ok(confirmed.ledger.groups.every(g => g.total_is_exact));
  assert.equal((await ask(f, 'How much income came from Payer One in October 2026?', 'merchant')).ledger.total_minor, 6000);

  const paired = setup(t, 'totals');
  identity(paired, 'Payer One', 'payer-one'); identity(paired, 'Payer Two', 'payer-two');
  const green = await ask(paired, q, 'merchant');
  assert.equal(green.ledger.transfers.length, 1);
  assert.equal(green.ledger.groups[0].if_own_transfers_total_minor, 0, 'confirmed scope permits conditional zero');
  paired.add('assumed', 'Payer Two payment', null, { cents: 4500 });
  const uncertain = await ask(paired, q, 'merchant');
  assert.equal(uncertain.ledger.transfers.length, 1, 'conditional exclusion decision reached');
  assert.equal(uncertain.ledger.groups[0].if_own_transfers_total_minor, null, 'another assumed payer cannot certify zero for this group');
  assert.equal(uncertain.evidence_gate.complete, false);
  assert.equal(uncertain.ledger.total_minor, 7000);
  assert.equal(uncertain.assumptions[0].amount_minor, 4500);
});

test('every payer-rendering path lists conflicting entity candidates', async t => {
  for (const [, kind, question, named = false] of paths) {
    const f = setup(t, kind); identity(f, 'Payer One', 'payer-one'); identity(f, 'Payer Two', 'payer-two');
    const green = await ask(f, question.replace('QUERY', 'Payer One'), kind);
    assert.ok(green.citations.length, 'confirmed control has a receipt');
    f.raw("UPDATE fin_transactions SET description='WIRE FROM: Payer One; REF: A-123, BY Payer Two' WHERE txn_uid='receipt'");
    const body = await ask(f, question.replace('QUERY', 'Payer One'), kind);
    const candidates = named ? body.ledger.payer_candidates : kind === 'merchant' ? body.ledger.groups[0].payer_candidates
      : ['deposits', 'largest'].includes(kind) ? body.ledger.rows[0].payer_candidates : body.ledger.transfers[0].incoming.payer_candidates;
    assert.deepEqual(candidates, ['[redacted] ****rOne', '[redacted] ****rTwo']);
    for (const candidate of candidates) assert.ok(body.answer.includes(candidate));
  }
});
