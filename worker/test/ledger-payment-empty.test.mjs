import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';

function setup(t) {
  const f = ledgerFixture(t);
  t.mock.method(Date, 'now', () => Date.parse(NOW));
  t.mock.method(globalThis, 'fetch', () => assert.fail('Network forbidden'));
  f.env.RERANK_MODEL = 'claude-haiku-4-5-20251001';
  f.env.ANTHROPIC_API_KEY = randomBytes(24).toString('hex');
  f.put = (id, pool, date, possible = false, direction = 'outflow') => {
    f.add(id, possible ? 'Bank memo mentions Store Unit purchase' : 'Ordinary bank text', possible ? null : 'Store Unit',
      { date, cents: 4093, direction: pool.includes('refund') || pool === 'reverse-credit' ? 'inflow' : direction });
    f.raw('UPDATE fin_transactions SET pending=?,removed_at=?,removal_reason=? WHERE txn_uid=?',
      Number(pool === 'pending'), pool === 'removed' ? NOW : null, pool === 'removed' ? 'provider_removed' : null, id);
  };
  f.injected = 0;
  f.read = async (direction, date, selector = true, { monthly = false, payer = false, unavailable = false } = {}) => {
    assert.ok(f.first('SELECT count(*) n FROM fin_transactions').n > 0, 'nonempty decision pool');
    const start = f.calls.length, changes = f.first('SELECT total_changes() n').n, injected = f.injected;
    let model = 0, fallback = 0;
    const question = payer
      ? `Could you retrieve deposits from Store Unit ${monthly ? 'month by month since July' : 'in July 2026'}?`
      : `Could you retrieve the $40.93 payment ${direction === 'inflow' ? 'from' : 'to'} Store Unit${selector ? ' in account ending 1234' : ''} in ${date.startsWith('2026-07') ? 'July' : 'October'} 2026?`;
    const response = await withLedgerAnswer({ env: f.env, now: NOW, question, grantScope: { all: true }, scopePrincipalKind: 'owner',
      callLLM: async () => {
        model++;
        return { content: [{ type: 'text', text: JSON.stringify({ ambiguous: false, unanswered_part: null, intents: [{
          kind: payer ? 'merchant' : 'payment', direction, vendor_text: 'Store Unit', account_hint: selector ? '1234' : null,
          amount_text: payer ? null : '$40.93', count: null, date_text: null, period: { type: 'none' },
        }] }) }] };
      } }, () => { fallback++; return Response.json({ fallback: true }); });
    const body = await response.json();
    const reads = f.calls.slice(start).filter(sql => /JOIN fin_transactions/.test(sql)).length;
    if (!unavailable) assert.ok(body.ledger, 'real ledger path reached');
    assert.ok(reads > 0, 'transaction SQL reached');
    assert.equal(model, 1, 'interpretation reached'); assert.equal(fallback, 0);
    assert.equal(f.first('SELECT total_changes() n').n - changes, f.injected - injected,
      'only explicitly simulated concurrent fixture writes are permitted');
    return { body, reads };
  };
  return f;
}

function noMatch(body, date) {
  assert.equal(body.ledger.kind, 'payment');
  assert.notEqual(body.ledger.found, true);
  assert.notEqual(body.ledger.named_selector_guard?.rejected, true, 'bounded payment absence is not a selector refusal');
  assert.equal(body.ledger.from, `${date.slice(0, 7)}-01`);
  assert.equal(body.citations.length, 0);
  assert.match(body.answer, /No matching transaction|No deposit of/);
  assert.match(body.answer, /cover|checked the dates and accounts/i, 'absence states its covered scope');
  assert.match(body.answer, /1234/);
  assert.doesNotMatch(body.answer, /could not be read|No charges at|\$0\.00/i);
}

// NZR1-A1: the independent review's 24 failing arms, with the same green
// exact-amount control before replacing the pool. Both July and October matter.
for (const date of ['2026-07-07', '2026-10-05']) for (const direction of ['outflow', 'both'])
  for (const pool of direction === 'outflow'
    ? ['refund', 'possible-refund', 'pending', 'possible-pending', 'removed', 'possible-removed', 'refund+possible-refund', 'reverse-credit']
    : ['pending', 'possible-pending', 'removed', 'possible-removed']) {
    test(`NZR1-A1 review direction=${direction} date=${date} pool=${pool}`, async t => {
      const f = setup(t);
      f.put('control', 'ordinary', date);
      const green = (await f.read(direction, date)).body;
      assert.equal(green.ledger.found, true); assert.equal(green.citations[0].amount_minor, 4093);
      f.raw('DELETE FROM fin_transactions');
      pool.split('+').forEach((kind, i) => f.put(`row-${i}`, kind.replace('possible-', ''), date, kind.startsWith('possible-')));
      const { body, reads } = await f.read(direction, date);
      assert.ok(reads >= 2, 'no-match amount-free re-read actually ran');
      noMatch(body, date);
    });
  }

// Additional incoming/outgoing selector controls ensure the unselected path
// cannot hide the missing inventory, and pending/tombstoned rows stay excluded.
for (const direction of ['inflow', 'outflow']) for (const selector of [false, true])
  for (const pool of ['refund', 'pending', 'removed']) test(`NZR1-A1 scope direction=${direction} selector=${selector} pool=${pool}`, async t => {
    const f = setup(t), date = '2026-07-07';
    f.put('control', 'ordinary', date, false, direction);
    assert.equal((await f.read(direction, date, selector)).body.ledger.found, true);
    f.raw('DELETE FROM fin_transactions');
    // An incoming refund is a match only at the requested cents. A different
    // amount keeps this a true empty exact-amount lookup in either direction.
    f.put('row', pool, date, false, direction);
    if (pool === 'refund') f.raw('UPDATE fin_transactions SET amount_minor=751');
    const { body, reads } = await f.read(direction, date, selector);
    assert.ok(reads >= 2, 'amount-free re-read reached');
    noMatch(body, date);
  });

for (const direction of ['inflow', 'outflow', 'both']) test(`NZR1-A1 possible direction=${direction}`, async t => {
  const f = setup(t), date = '2026-07-07';
  f.put('control', 'ordinary', date, false, direction === 'both' ? 'outflow' : direction);
  assert.equal((await f.read(direction, date)).body.ledger.found, true);
  f.raw('DELETE FROM fin_transactions');
  f.put('possible', 'ordinary', date, true, direction === 'both' ? 'outflow' : direction);
  const { body, reads } = await f.read(direction, date);
  assert.ok(reads >= 2, 'uncertain lookup re-read reached');
  assert.equal(body.ledger.found, null); assert.equal(body.ledger.total_minor, null);
  assert.equal(body.ledger.complete, false); assert.equal(body.ledger.match_basis, 'possible');
  assert.equal(body.citations.length, 1); assert.equal(body.citations[0].amount_minor, 4093);
  assert.match(body.answer, /POSSIBLE match:.*\$40\.93.*\[1\]/);
  assert.doesNotMatch(body.answer, /No matching|No charges|No deposit|found no matching/i);
});

test('NZR1-A1 failed re-read cannot establish absence', async t => {
  const f = setup(t), date = '2026-07-07';
  f.put('control', 'ordinary', date);
  assert.equal((await f.read('outflow', date)).body.ledger.found, true);
  f.raw('DELETE FROM fin_transactions'); f.put('row', 'pending', date);
  const batch = f.env.DB.batch.bind(f.env.DB);
  let reads = 0;
  f.env.DB.batch = async statements => {
    if (statements.some(s => /JOIN fin_transactions/.test(s.sql)) && ++reads === 2) throw new Error('synthetic read failure');
    return batch(statements);
  };
  const { body } = await f.read('outflow', date, true, { unavailable: true });
  assert.equal(reads, 2, 'failure injected at second transaction snapshot');
  assert.ok(body.gaps.some(gap => gap.reason === 'ledger_unavailable'));
  assert.doesNotMatch(body.answer, /No matching|No deposit|No charges|found no matching/i);
});

test('NZR1-A1 changed account mapping on re-read fails closed', async t => {
  const f = setup(t), date = '2026-07-07';
  f.put('control', 'ordinary', date);
  assert.equal((await f.read('outflow', date)).body.ledger.found, true);
  f.raw('DELETE FROM fin_transactions'); f.put('row', 'pending', date);
  const batch = f.env.DB.batch.bind(f.env.DB);
  let reads = 0;
  f.env.DB.batch = async statements => {
    const result = await batch(statements);
    if (statements.some(s => /JOIN fin_transactions/.test(s.sql)) && ++reads === 2)
      result[0].results[0].mask = '9999';
    return result;
  };
  const { body } = await f.read('outflow', date, true, { unavailable: true });
  assert.equal(reads, 2, 'mapping drift injected at re-read');
  assert.ok(body.gaps.some(gap => gap.reason === 'ledger_unavailable'));
  assert.doesNotMatch(body.answer, /No matching|No deposit|No charges|found no matching/i);
});

for (const mixed of [false, true]) test(`NZR1-M3 monthly payer matched receipt mixed=${mixed}`, async t => {
  const f = setup(t), date = '2026-07-07';
  f.add('matched', 'Ordinary deposit', 'Store Unit', { date, cents: 1729, direction: 'inflow' });
  if (mixed) f.add('anonymous', 'Unidentified deposit', null, { date, cents: 2347, direction: 'inflow' });
  const single = (await f.read('inflow', date, false, { payer: true })).body;
  assert.equal(single.ledger.attributed_subtotal_minor, 1729, 'single-period green control');
  assert.equal(single.ledger.total_minor, null); assert.ok(single.citations.some(ref => ref.amount_minor === 1729));
  const body = (await f.read('inflow', date, false, { payer: true, monthly: true })).body;
  assert.equal(body.ledger.months.length, 4, 'monthly composition reached');
  const july = body.ledger.months[0];
  assert.equal(july.attributed_subtotal_minor, 1729);
  assert.equal(july.total_minor, null); assert.equal(july.subtotal_minor, null);
  assert.equal(july.complete, false); assert.equal(body.ledger.complete, false);
  assert.deepEqual(july.amount_citations, [1]);
  assert.equal(body.citations.find(ref => ref.n === 1)?.amount_minor, 1729);
  assert.match(body.answer, /July 2026:.*\$17\.29.*\[1\].*(?:matched subtotal|at least)/i);
  assert.match(body.answer, /full (?:payer )?income.*unconfirmed/i);
  assert.doesNotMatch(body.answer, /\$23\.47|\$40\.76/);
});

test('NZR1-M3 monthly payer citations resolve across multiple months', async t => {
  const f = setup(t), date = '2026-07-07';
  for (const month of ['07', '08']) {
    f.add(`anonymous-${month}`, 'Unidentified deposit', null, { date: `2026-${month}-07`, cents: 2347, direction: 'inflow' });
    f.add(`matched-${month}`, 'Ordinary deposit', 'Store Unit', { date: `2026-${month}-07`, cents: 1729, direction: 'inflow' });
  }
  const single = (await f.read('inflow', date, false, { payer: true })).body;
  assert.equal(single.ledger.attributed_subtotal_minor, 1729, 'single-period green control');
  const body = (await f.read('inflow', date, false, { payer: true, monthly: true })).body;
  assert.equal(body.ledger.months.length, 4);
  assert.equal(body.citations.length, 2);
  assert.equal(new Set(body.citations.map(ref => ref.n)).size, 2);
  for (const month of body.ledger.months.slice(0, 2)) {
    assert.equal(month.attributed_subtotal_minor, 1729); assert.equal(month.total_minor, null);
    assert.equal(month.complete, false); assert.equal(month.amount_citations.length, 1);
    const ref = body.citations.find(ref => ref.n === month.amount_citations[0]);
    assert.equal(ref?.amount_minor, 1729); assert.ok(ref.posted_on.startsWith(month.month));
    assert.ok(body.answer.includes(`[${ref.n}]`));
  }
});

const paymentAbsence = /\bno (?:ordinary |matching |completed )*(?:deposits?|payments?|transactions?)\b|\bfound no matching\b|\$0\.00\b/i;
function exactPayment(body) {
  assert.equal(body.ledger.found, true, 'exact positive control');
  assert.equal(body.citations.length, 1);
  assert.equal(body.citations[0].amount_minor, 4093);
  assert.equal(body.citations[0].account_mask, '1234');
  assert.match(body.answer, /\$40\.93.*\[1\]/);
  assert.doesNotMatch(body.answer, paymentAbsence);
}
function interleave(f, change) {
  const original = f.env.DB.batch.bind(f.env.DB), snapshots = [];
  f.env.DB.batch = async statements => {
    const results = await original(statements);
    const index = statements.findIndex(statement => /JOIN fin_transactions/.test(statement.sql));
    if (index >= 0) {
      snapshots.push(results[index].results);
      if (snapshots.length === 1) {
        const before = f.first('SELECT total_changes() n').n;
        change();
        f.injected += f.first('SELECT total_changes() n').n - before;
      }
    }
    return results;
  };
  return snapshots;
}
function changedAccount(body) {
  assert.equal((body.answer.match(/account changed while answering/gi) || []).length, 1);
  assert.match(body.answer, /ask again/i);
  assert.equal(body.ledger.complete, false);
  assert.notEqual(body.ledger.found, false);
  assert.notEqual(body.ledger.total_minor, 0);
  assert.doesNotMatch(body.answer, paymentAbsence, 'disagreement cannot establish absence');
  assert.notEqual(body.ledger.named_selector_guard?.rejected, true, 'second-read identity survives the outer guard');
}

// NZR2-B1: each attack has an exact positive control, two actual SQLite
// snapshots and an explicit witness that the second read observed the arrival.
for (const direction of ['inflow', 'outflow', 'both']) for (const selector of [false, true])
  for (const arrival of ['exact', 'possible']) test(`NZR2-B1 direction=${direction} selector=${selector} arrival=${arrival}`, async t => {
    const f = setup(t), date = '2026-07-07', rowDirection = direction === 'both' ? 'outflow' : direction;
    f.put('control', 'ordinary', date, false, rowDirection);
    exactPayment((await f.read(direction, date, selector)).body);
    f.raw('DELETE FROM fin_transactions');
    f.add('near', 'Ordinary bank text', 'Store Unit', { date, cents: 4092, direction: rowDirection });
    const snapshots = interleave(f, () => f.put('arrived', 'ordinary', date, arrival === 'possible', rowDirection));
    const { body, reads } = await f.read(direction, date, selector);
    assert.equal(reads, 2); assert.equal(snapshots.length, 2);
    assert.ok(!snapshots[0].some(row => row.amount_minor === 4093));
    assert.ok(snapshots[1].some(row => row.amount_minor === 4093), 'arrival reached the deciding snapshot');
    changedAccount(body);
    assert.equal(body.citations.length, 1);
    assert.equal(body.citations[0].amount_minor, 4093, 'second-read exact cents only');
    assert.equal(body.citations[0].account_mask, '1234');
    const observed = snapshots[1].find(row => row.amount_minor === 4093);
    assert.equal(body.citations[0].ref, `ledger:transaction:${observed.id}`, 'citation resolves to the new row');
    if (arrival === 'exact') exactPayment(body);
    else {
      assert.equal(body.ledger.found, null); assert.equal(body.ledger.total_minor, null);
      assert.equal(body.ledger.match_basis, 'possible'); assert.equal(body.ledger.attribution_incomplete, true);
      assert.match(body.answer, /POSSIBLE match:.*\$40\.93.*\[1\]/);
    }
  });

for (const direction of ['inflow', 'outflow', 'both']) for (const selector of [false, true])
  for (const change of ['disappeared', 'identity', 'irrelevant']) test(`second-read direction=${direction} selector=${selector} change=${change}`, async t => {
    const f = setup(t), date = '2026-07-07', rowDirection = direction === 'both' ? 'outflow' : direction;
    f.put('control', 'ordinary', date, false, rowDirection);
    exactPayment((await f.read(direction, date, selector)).body);
    f.raw('DELETE FROM fin_transactions');
    f.put('candidate', 'ordinary', date, true, rowDirection);
    if (change === 'irrelevant') f.raw('UPDATE fin_transactions SET amount_minor=4092');
    const snapshots = interleave(f, () => {
      if (change === 'disappeared') f.raw('UPDATE fin_transactions SET amount_minor=4092');
      if (change === 'identity') f.raw("UPDATE fin_transactions SET payee='Store Unit'");
      if (change === 'irrelevant') f.raw('UPDATE fin_transactions SET amount_minor=4094');
    });
    const { body, reads } = await f.read(direction, date, selector);
    assert.equal(reads, 2); assert.equal(snapshots.length, 2);
    assert.notDeepEqual(snapshots[0], snapshots[1], 'fixture change reached both snapshots');
    if (change === 'irrelevant') {
      noMatch(body, date);
      assert.doesNotMatch(body.answer, /account changed while answering/i, 'unrelated amounts do not change candidates');
    } else {
      changedAccount(body);
      assert.equal(body.ledger.attribution_incomplete, false, 'stale possible evidence is replaced');
      if (change === 'identity') exactPayment(body);
      else {
        assert.equal(body.ledger.found, null); assert.equal(body.ledger.total_minor, null);
        assert.equal(body.citations.length, 0, 'departed candidates cannot retain receipts');
      }
    }
  });
