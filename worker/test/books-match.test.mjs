import test from 'node:test';
import assert from 'node:assert/strict';
import { matchBooksSnapshots, verifyBooksAbsenceReceipt } from '../src/lib/books-match.js';
import { booksHarness, record } from '../../test/fixtures/books-match.mjs';
import { sealFinancialSnapshot, resolveFinancialCell } from '../src/lib/financial-snapshot-contract.js';

async function run(qbo, bank, options) {
  const h = await booksHarness(qbo, bank, options);
  const result = await matchBooksSnapshots(h.input, h.dependencies);
  assert.equal(h.calls.length, 2, 'both current snapshot decisions were reached');
  assert.ok(result.checked > 0);
  return { ...h, result };
}
const kinds = r => r.groups.map(g => g.classification).sort();
const signature = r => r.groups.map(g => ({ kind: g.classification, difference: g.difference,
  left: g.quickbooks.map(r => r.value.amount_minor).sort(), right: g.bank.map(r => r.value.amount_minor).sort() }))
  .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

test('unique compatible identity yields an exact cited pair without source mutation', async () => {
  const h = await booksHarness([record('q1')], [record('b1')]);
  const before = structuredClone([...h.snapshots]);
  const result = await matchBooksSnapshots(h.input, h.dependencies);
  assert.deepEqual(kinds(result), ['exact_unique']);
  assert.equal(result.groups[0].difference.amount_minor, '0');
  for (const r of [...result.groups[0].quickbooks, ...result.groups[0].bank]) {
    const { cell } = resolveFinancialCell(h.snapshots.get(r.citations[0].snapshot_id), r.citations[0]);
    assert.deepEqual(cell.money, r.value);
  }
  assert.equal(result.mutated_source_records, false);
  assert.deepEqual([...h.snapshots], before);
});

test('all competitors survive connected components and opaque ID permutations', async () => {
  const baseline = await run([record('q1', '100'), record('q2', '200')], [record('b1', '300')]);
  assert.deepEqual(kinds(baseline.result), ['ambiguous_candidates']);
  assert.equal(baseline.result.groups[0].quickbooks.length, 2);
  assert.equal(baseline.result.groups[0].bank.length, 1);
  assert.equal(baseline.result.groups[0].difference, null);
  for (const qbo of [[record('z', '100'), record('a', '200')], [record('a', '200'), record('z', '100')]]) {
    assert.deepEqual(signature((await run(qbo, [record('y', '300')])).result), signature(baseline.result));
  }
});

test('explicit links take precedence, while contradictory links retain all competitors', async () => {
  const good = await run([record('q1', '100', { link: 'b2' }), record('q2', '100', { link: 'b1' })],
    [record('b1'), record('b2')]);
  assert.deepEqual(kinds(good.result), ['exact_unique', 'exact_unique']);
  const bad = await run([record('q1', '100', { link: 'b1' }), record('q2', '100', { link: 'b1' })], [record('b1')]);
  assert.deepEqual(kinds(bad.result), ['ambiguous_candidates']);
  assert.equal(bad.result.groups[0].quickbooks.length, 2);
  const contradiction = await run([record('q1', '100', { link: 'b1' }), record('q2')], [record('b1', '100', { link: 'q2' })]);
  assert.equal(contradiction.result.groups.length, 1);
  assert.equal(contradiction.result.groups[0].quickbooks.length, 2);
  assert.equal(contradiction.result.groups[0].classification, 'ambiguous_candidates');
});

test('amount/date alone cannot certify identity; distinct references preserve recurring purchases', async () => {
  const unknown = await run([record('q1', '100', { reference: null })], [record('b1', '100', { reference: null })]);
  assert.deepEqual(kinds(unknown.result), ['identity_unproved']);
  assert.equal(unknown.result.groups[0].quickbooks.length, 1);
  const recurring = await run([record('q1'), record('q2', '100', { reference: 'ref_02' })],
    [record('b1'), record('b2', '100', { reference: 'ref_02' })]);
  assert.deepEqual(kinds(recurring.result), ['exact_unique', 'exact_unique']);
});

test('opaque reference whitespace is significant on both sides', async () => {
  const result = (await run([record('q1', '100', { reference: ' ref_01' })], [record('b1')])).result;
  assert.deepEqual(kinds(result), ['bank_only', 'qbo_only']);
  assert.equal(result.groups.filter(g => g.absence_receipt !== null).length, 2);
});

test('duplicate replay deduplicates amounts and distinct identities remain review candidates', async () => {
  const replay = (await run([record('q1'), record('q1')], [record('b1')])).result;
  assert.deepEqual(kinds(replay), ['exact_unique']);
  assert.equal(replay.groups[0].quickbooks.length, 1);
  assert.equal(replay.groups[0].quickbooks[0].citations.length, 2);
  const duplicates = (await run([record('q1'), record('q2')], [])).result;
  assert.deepEqual(kinds(duplicates), ['possible_duplicates']);
  assert.equal(duplicates.groups[0].quickbooks.length, 2);
});

test('one cent and large exact money are not rounded; date windows are timing only', async () => {
  const cents = (await run([record('q1', '900719925474099312301')], [record('b1', '900719925474099312300')])).result;
  assert.deepEqual(kinds(cents), ['amount_mismatch']);
  assert.equal(cents.groups[0].difference.amount_minor, '1');
  for (const date of ['2025-01-12', '2025-01-18']) {
    assert.deepEqual(kinds((await run([record('q1')], [record('b1', '100', { date })])).result), ['timing_candidate']);
  }
  assert.deepEqual(kinds((await run([record('q1')], [record('b1', '100', { date: '2025-01-19' })])).result), ['bank_only', 'qbo_only']);
});

test('missing records carry replayable opposite-side search proof with boundary coverage', async () => {
  const h = await run([record('q1', '100', { date: '2025-01-31' })], [record('b1', '900', { reference: 'different' })]);
  assert.equal(h.result.groups.length, 2);
  const receipt = h.result.groups.find(g => g.classification === 'qbo_only').absence_receipt;
  assert.equal(receipt.match_count, 0);
  assert.equal(receipt.searched_record_count, 1);
  assert.equal(receipt.search_start, '2024-12-29');
  assert.equal(receipt.search_end, '2025-02-03');
  assert.equal((await verifyBooksAbsenceReceipt(receipt, h.dependencies)).ok, true);
  const bad = structuredClone(receipt); bad.searched_record_count = 0;
  await assert.rejects(verifyBooksAbsenceReceipt(bad, h.dependencies), { code: 'absence_receipt_mismatch' });
  assert.ok(h.calls.length >= 6, 'both snapshots were re-resolved for each verification');
  const boundary = (await run([record('q1', '100', { date: '2025-01-31' })], [record('b1', '100', { date: '2025-02-03' })])).result;
  assert.deepEqual(kinds(boundary), ['timing_candidate']);
});

test('partial or unsearched boundary blocks absence, with a reached nonempty search', async () => {
  for (const options of [{ bank: { partial: true } }, { bank: { boundary: false } }, { quickbooks: { partial: true } }]) {
    const { result } = await run([record('q1')], [record('b1', '900', { reference: 'different' })], options);
    assert.equal(result.groups.length, 2);
    assert.ok(result.groups.every(g => g.absence_receipt === null));
    assert.ok(result.groups.every(g => g.evidence_state === 'incomplete'));
  }
});

test('pending, removed and superseded rows are visible exclusions and cannot settle a pair', async () => {
  for (const state of ['pending', 'removed', 'superseded']) {
    const { result } = await run([record('q1')], [record('b1', '100', { state })]);
    assert.equal(result.excluded.length, 1);
    assert.equal(result.excluded[0].reason, state);
    assert.deepEqual(kinds(result), ['qbo_only']);
    assert.equal(result.groups[0].absence_receipt, null);
  }
});

test('current identity version conflicts refuse instead of choosing input order', async () => {
  const h = await booksHarness([record('q1'), record('q1', '100', { version: '2' })], [record('b1')]);
  await assert.rejects(matchBooksSnapshots(h.input, h.dependencies), { code: 'books_identity_conflict' });
  assert.ok(h.calls.length >= 1);
});

test('transfers allocate both legs once and never net a missing leg into zero', async () => {
  const legs = side => [record(`${side}1`, '500', { transfer: 'transfer_01', link: `${side === 'q' ? 'b' : 'q'}1` }),
    record(`${side}2`, '500', { transfer: 'transfer_01', account: 'account_02', direction: 'inflow', link: `${side === 'q' ? 'b' : 'q'}2` })];
  const good = (await run(legs('q'), legs('b'))).result;
  assert.deepEqual(kinds(good), ['transfer_allocation']);
  assert.equal(good.groups[0].allocations.length, 2);
  assert.equal(good.groups[0].quickbooks.length, 2);
  assert.equal(good.groups[0].bank.length, 2);
  const missing = (await run(legs('q'), legs('b').slice(0, 1))).result;
  assert.deepEqual(kinds(missing), ['transfer_incomplete']);
  assert.equal(missing.groups[0].allocations.length, 0);
  assert.equal(missing.groups[0].difference, null);
});

test('source identity, company, map, scope, currency and hashes fail closed after source resolution', async () => {
  for (const change of [s => { s.scope.entity_ref = 'other'; }, s => { s.scope.owner_map_head = 'other'; },
    s => { s.source_kind = 'tax_report'; }, s => { s.rows[0].cells[0].money.precision = 'provider_rounded'; }]) {
    const h = await booksHarness([record('q1')], [record('b1')]);
    const snapshot = structuredClone(h.snapshots.get('snapshot_bank')); change(snapshot);
    const sealed = await sealFinancialSnapshot(snapshot);
    h.snapshots.set(sealed.snapshot_id, sealed); h.input.bank.content_hash = sealed.content_hash;
    await assert.rejects(matchBooksSnapshots(h.input, h.dependencies));
    assert.equal(h.calls.length, 2);
  }
  const h = await booksHarness([record('q1')], [record('b1')]);
  h.snapshots.get('snapshot_bank').rows[0].label = 'changed';
  await assert.rejects(matchBooksSnapshots(h.input, h.dependencies), { code: 'snapshot_hash' });
  assert.equal(h.calls.length, 2);
});

test('a reserved counterpart cannot be represented as an opposite-side absence', async () => {
  const { result } = await run([record('q1', '100', { link: 'b1' }), record('q2', '200')], [record('b1')]);
  assert.ok(result.groups.some(g => g.classification === 'exact_unique'), 'explicit pair was reached');
  const unmatched = result.groups.find(g => g.classification === 'qbo_only');
  assert.equal(unmatched.quickbooks.length, 1);
  assert.equal(unmatched.absence_receipt, null);
  assert.equal(unmatched.evidence_state, 'incomplete');
});

test('a linked split cannot swallow an additional identical unlinked record', async () => {
  const { result } = await run([record('q1', '100', { link: 'b1' }), record('q2')], [record('b1')]);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].quickbooks.length, 2);
  assert.equal(result.groups[0].classification, 'ambiguous_candidates');
});

test('boundary-only records stay visible without becoming period missing claims', async () => {
  const { result } = await run([record('q1')], [record('b1'), record('margin', '999', { date: '2025-02-03', reference: 'margin' })]);
  assert.deepEqual(kinds(result), ['exact_unique']);
  assert.equal(result.boundary_only.length, 1);
  assert.equal(result.boundary_only[0].record.value.amount_minor, '999');
});

test('current snapshot change or a revoked resolver invalidates an old absence receipt', async () => {
  const h = await run([record('q1')], []);
  const receipt = h.result.groups[0].absence_receipt;
  assert.ok(receipt);
  let calls = 0;
  await assert.rejects(verifyBooksAbsenceReceipt(receipt, { resolveSnapshot: async () => {
    calls++; throw Object.assign(new Error('access_denied'), { code: 'access_denied' });
  } }), { code: 'access_denied' });
  assert.equal(calls, 1);
  const replacement = structuredClone(h.snapshots.get('snapshot_bank'));
  replacement.observed_at = '2025-02-06T12:00:00.000Z';
  h.snapshots.set('snapshot_bank', await sealFinancialSnapshot(replacement));
  await assert.rejects(verifyBooksAbsenceReceipt(receipt, h.dependencies), { code: 'books_snapshot_binding' });
  assert.ok(h.calls.length >= 4);
});

test('coverage through a future boundary cannot prove absence at an earlier observation', async () => {
  for (const observed of ['2025-02-01T12:00:00.000Z', '2025-02-03T12:00:00.000Z']) {
    const h = await booksHarness([record('q1')], []);
    for (const [id, original] of h.snapshots) {
      const s = structuredClone(original);
      s.requested_at = s.observed_at = s.provider_generated_at = observed;
      const sealed = await sealFinancialSnapshot(s); h.snapshots.set(id, sealed);
      h.input[id === 'snapshot_bank' ? 'bank' : 'quickbooks'].content_hash = sealed.content_hash;
    }
    const result = await matchBooksSnapshots(h.input, h.dependencies);
    assert.equal(h.calls.length, 2);
    assert.equal(result.groups[0].quickbooks.length, 1);
    assert.equal(result.groups[0].absence_receipt, null);
    assert.equal(result.status, 'incomplete');
  }
});

test('same-currency JPY and KWD preserve their minor-unit exponents', async () => {
  for (const [currency, exponent] of [['JPY', 0], ['KWD', 3]]) {
    const h = await booksHarness([record('q1', '101')], [record('b1', '100')], { quickbooks: { currency }, bank: { currency } });
    h.input.scope.presentation_currency = currency; h.input.scope.transaction_currencies = [currency];
    for (const p of h.input.scope.report_parameters) if (p.name === 'presentation_currency') p.requested = p.echoed = currency;
    const result = await matchBooksSnapshots(h.input, h.dependencies);
    assert.equal(h.calls.length, 2);
    assert.equal(result.groups[0].difference.amount_minor, '1');
    assert.equal(result.groups[0].difference.exponent, exponent);
  }
});

test('all six input permutations and opaque ID renamings preserve the financial decisions', async () => {
  const permutations = rows => rows.flatMap((row, index) => rows.length === 1 ? [[row]] :
    permutations(rows.filter((_, i) => i !== index)).map(tail => [row, ...tail]));
  let expected;
  for (const order of permutations([0, 1, 2])) {
    for (const ids of [['q1', 'q2', 'q3'], ['z', ' a', 'm']]) {
      const qbo = order.map(i => record(ids[i], String((i + 1) * 100)));
      const { result } = await run(qbo, [record('b1', '600')]);
      assert.equal(result.groups.length, 1);
      assert.equal(result.groups[0].quickbooks.length, 3);
      assert.equal(result.groups[0].candidate_edges.length, 3);
      expected ??= signature(result);
      assert.deepEqual(signature(result), expected);
    }
  }
});
