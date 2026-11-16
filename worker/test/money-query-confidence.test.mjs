import test from 'node:test';
import assert from 'node:assert/strict';

const confidence = async input => (await import('../src/lib/money-query-confidence.js')).moneyConfidence(input);
function base() {
  return {
    coverage: [{ account: '1111', currency: 'USD', row_count: 31, history_first_row: '2026-01-01', history_last_row: '2026-10-31',
      unreadable_rows: 0, unconfirmed_rows: 0, possible_duplicate_count: 0 }],
    rows: Array.from({ length: 31 }, (_, i) => ({ account: '1111', currency: 'USD',
      posted_on: `2026-10-${String(i + 1).padStart(2, '0')}`, amount_minor: 1000, classification: 'income' })),
    pairsTotal: 0, pairsProved: 0, window: { from: '2026-10-01', through: '2026-10-31' }, today: '2026-11-12', truncated: false, raw: false,
  };
}

test('R2 B2 confidence baseline is deterministic and labels the tool ceiling', async () => {
  const input = base(), original = structuredClone(input);
  assert.deepEqual(await confidence(input), { percent: 100, word: 'High', line: 'Confidence: High (100%)', reasons: [], missing: [] });
  assert.deepEqual(await confidence(input), await confidence(input));
  assert.deepEqual(input, original, 'scoring does not mutate its evidence');
});

test('R2 B2 stale and estimated evidence lowers 100 to 90 to 84 to 64', async () => {
  const input = base(); input.coverage[0].history_last_row = '2026-10-20';
  const stale = await confidence(input);
  assert.equal(stale.percent, 90); assert.equal(stale.word, 'High');
  assert.deepEqual(stale.reasons.map(r => [r.code, r.points]), [['stale_account', 10]]);
  assert.match(stale.reasons[0].text, /1111.*2026-10-20.*2026-10-31/);
  assert.ok(stale.missing.some(text => /1111.*2026-10-31/.test(text)));
  input.rows = [{ account: '1111', posted_on: '2026-10-20', amount_minor: 25000, classification: 'unknown', currency: 'USD' },
    { account: '1111', posted_on: '2026-10-20', amount_minor: 75000, classification: 'income', currency: 'USD' }];
  const estimated = await confidence(input);
  assert.equal(estimated.percent, 84); assert.equal(estimated.word, 'Medium');
  assert.deepEqual(estimated.reasons.map(r => [r.code, r.points]), [['stale_account', 10], ['estimated_rows', 6]]);
  assert.match(estimated.reasons[1].text, /1111.*2026-10-20.*\$250\.00/);
  input.truncated = true;
  const truncated = await confidence(input);
  assert.equal(truncated.percent, 64); assert.equal(truncated.line, 'Confidence: Low (64%)');
  assert.ok(truncated.missing.length >= 3, 'each deduction explains what evidence would resolve it');
});

test('R2 B2 confidence applies each evidence deduction and its caps', async t => {
  for (const [name, mutate, percent, code, points] of [
    ['no accounts', v => { v.coverage = []; }, 10, 'no_accounts', 90],
    ['no rows', v => { v.coverage[0].row_count = 0; v.rows = []; }, 60, 'no_rows', 40],
    ['late start', v => { v.coverage[0].history_first_row = '2026-10-05'; }, 90, 'starts_late', 10],
    ['unreadable', v => { v.coverage[0].unreadable_rows = 2; }, 95, 'unreadable_rows', 5],
    ['unconfirmed', v => { v.coverage[0].unconfirmed_rows = 3; }, 95, 'unconfirmed_rows', 5],
    ['unknown', v => { v.rows[0].classification = 'unknown'; }, 99, 'estimated_rows', 1],
    ['all unknown', v => { v.rows.forEach(r => { r.classification = 'unknown'; }); }, 75, 'estimated_rows', 25],
    ['duplicate', v => { v.coverage[0].possible_duplicate_count = 2; }, 95, 'possible_duplicates', 5],
    ['unproved pair', v => { v.pairsTotal = 3; v.pairsProved = 2; }, 95, 'possible_transfers', 5],
    ['truncated', v => { v.truncated = true; }, 80, 'truncated', 20],
    ['raw', v => { v.raw = true; }, 60, 'raw_rows', 40],
    ['raw without coverage', v => { v.raw = true; v.coverage = []; v.rows = []; }, 60, 'raw_rows', 40],
  ]) await t.test(name, async () => {
    const input = base(); mutate(input);
    const output = await confidence(input);
    assert.equal(output.percent, percent);
    assert.ok(output.reasons.some(r => r.code === code && r.points === points));
    assert.ok(output.reasons.every(r => r.text.length > 0));
    assert.ok(output.missing.length > 0);
  });
  const input = base();
  input.coverage = Array.from({ length: 4 }, (_, i) => ({ ...input.coverage[0], account: String(i + 1).repeat(4),
    history_first_row: '2026-10-05', history_last_row: '2026-10-10', unreadable_rows: 1, unconfirmed_rows: 1, possible_duplicate_count: 1 }));
  input.rows.forEach(r => { r.classification = 'unknown'; });
  input.pairsTotal = 1; input.truncated = true;
  const output = await confidence(input);
  assert.equal(output.percent, 10);
  assert.deepEqual(output.reasons.map(r => r.code), ['stale_account', 'stale_account', 'stale_account', 'stale_account',
    'starts_late', 'starts_late', 'starts_late', 'starts_late', 'unreadable_rows', 'unconfirmed_rows', 'estimated_rows', 'possible_duplicates', 'possible_transfers', 'truncated']);
  assert.equal(output.reasons.filter(r => r.code === 'stale_account').reduce((n, r) => n + r.points, 0), 30);
  assert.equal(output.reasons.filter(r => r.code === 'starts_late').reduce((n, r) => n + r.points, 0), 20);
});

test('R2 B2 reference date uses the requested past period or today for future periods', async () => {
  const input = base();
  input.window.through = '2026-12-31'; input.today = '2026-11-01';
  assert.equal((await confidence(input)).percent, 100);
  input.window = null; input.today = '2026-11-07';
  assert.equal((await confidence(input)).percent, 100, 'seven days is within the freshness allowance');
  input.today = '2026-11-08';
  assert.equal((await confidence(input)).percent, 90);
});

test('R2 B2 raw confidence cannot masquerade as clean evidence or claim absent accounts', async () => {
  const input = base(); input.raw = true; input.coverage = []; input.rows = [];
  const output = await confidence(input);
  assert.equal(output.percent, 60); assert.equal(output.word, 'Low');
  assert.deepEqual(output.reasons.map(r => r.code), ['raw_rows']);
  assert.match(output.reasons[0].text, /own transfers.*card payments.*duplicate feeds/);
  assert.ok(output.missing.some(text => /coverage/.test(text)));
});
