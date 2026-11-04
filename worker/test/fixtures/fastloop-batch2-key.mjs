// The expected figures and memberships are authored separately from the evidence.
// This key imports no product grammar, classifier, reader or arithmetic helper.
import assert from 'node:assert/strict';
import { reviewedDateCopy, reviewedTitleFields, LIVE_PLAIN, reviewedFinalOffer, reviewedPlainCopy } from './plain-copy-expectations.mjs';
import { displayFigures, formatMinor } from '../../../eval/fast-loop/money-oracle.mjs';

// Independent source identities, dates, account membership and prose obligations.
// This closed renderer contract rejects new factual prose pending review, even
// when it contains no dollar symbol or preserves every existing numeric figure.
const posted = 'Figures use recorded posted rows. Pending activity is not assessed here.';
const transferNote = 'Possible transfers are included in income and spend; no rows were removed as transfers.';
const masks = ['3131', '4242', '5353'];
const accountText = list => list.map(mask => `account ****${mask}`).join(', ');
const coverageText = list => list.map(mask => `account ****${mask}: covered through 2026-11-07`).join('; ');
const accountLine = (list, period = null) => `Accounts: ${accountText(list)}; ${period ? `${period}; ` : ''}${coverageText(list)}.`;
const sourceFacts = {
  1: ['3131', 6000, '2026-10-25', 'Store One'], 2: ['3131', 5000, '2026-10-24', 'Store Two'],
  3: ['3131', 4000, '2026-10-23', 'Store Three'], 4: ['3131', 3000, '2026-10-22', 'Store Four'],
  5: ['3131', 2000, '2026-10-21', 'Store Five'], 6: ['3131', 1000, '2026-10-20', 'Store Six'],
  7: ['3131', 40000, '2026-10-12', 'payment'], 8: ['3131', 40000, '2026-10-12', 'Outside Lender'],
  9: ['3131', 17777, '2026-10-12', 'Payer Unit'], 10: ['3131', 2222, '2026-10-05', 'Payer Boundary'],
  11: ['3131', 3333, '2026-10-19', 'Payer Boundary'], 14: ['3131', 10011, '2026-09-01'],
  15: ['3131', 22222, '2026-09-30'], 16: ['5353', 30033, '2026-09-15'],
  17: ['5353', 12345, '2026-09-16'], 30: ['3131', 17777, '2026-10-13', 'Payer Unit'],
};
function reviewContract(o, wording) {
  const { body: b, id } = o, l = b.ledger;
  const balance = /^D5\/|^D10\//.test(id), recurring = id.startsWith('D8/');
  const ambiguous = id === 'D7/ambiguous', forecast = id === 'D10/forecast';
  assert.deepEqual(b.evidence_gate, { supported: true, complete: !ambiguous && !forecast,
    partial: ambiguous || forecast, reason: forecast ? 'forecast unavailable; current recorded balance observations only'
      : ambiguous ? 'multiple near-date deposits match; no unique payment is confirmed' : 'read from covered ledger rows' });
  assert.deepEqual(b.gaps, []); assert.deepEqual(b.results, []);
  const ids = balance ? [1, 2, 3] : id.startsWith('D6/') ? [1]
    : id.startsWith('D7/') ? ambiguous ? [9, 30] : [9] : recurring ? [1, 2, 3]
      : id === 'D9/single' ? [14, 15] : id === 'D9/control' ? [14, 15, 16, 17]
        : id === 'D9/combined' ? [14, 16, 17, 15] : id === 'Q6/control' ? [1, 2, 3, 4, 5, 6, 11, 9, 8, 7]
          : [10, 7, 8, 9, 11, 6, 5, 4, 3, 2, 1];
  const balances = [['3131', 502345, 'Operating account'], ['5353', 200001, 'Reserve account'], ['4242', 880000, 'Owned loan']];
  const expectedCitations = ids.map((rowId, index) => {
    const [mask, cents, date] = balance ? [...balances[index].slice(0, 2), '2026-10-30']
      : recurring ? ['3131', 1201, ['2026-08-10', '2026-09-10', '2026-10-10'][index]] : sourceFacts[rowId];
    return { n: index + 1, source: 'ledger', source_kind: 'ledger', ref: `ledger:${balance ? 'balance' : 'transaction'}:${rowId}`,
      title: `account ****${mask}: ${formatMinor(String(cents))} on ${date}`, account_mask: mask,
      posted_on: date, amount_minor: cents, currency: 'USD', last_synced_at: null, supplied_by: 'manual',
      ts: date, date_reliable: true, text_source: 'native', text_reliable: true };
  });
  assert.deepEqual(b.citations, wording === 'pinned' ? expectedCitations : reviewedTitleFields(expectedCitations), 'independent complete source binding');
  let expected;
  if (balance) {
    expected = [
      ...(forecast ? ["I can't forecast next month's bank balance. Here is the current recorded snapshot instead."] : []),
      'Your latest synced balances are below.', 'Recorded observations, not live or available cash.',
      'Cash accounts (recorded balances):',
      ...balances.slice(0, 2).map(([mask, cents, label], i) => `${label} (account ****${mask}): ${formatMinor(String(cents))} as of 2026-10-30; feed synced unavailable [${i + 1}].`),
      'Liabilities (separate from cash):',
      'Owned loan (account ****4242): $8,800.00 as of 2026-10-30; feed synced unavailable [3].',
    ];
  } else if (id.startsWith('D6/')) {
    const from = id.endsWith('months') ? '2026-07-31' : id.endsWith('days') ? '2026-08-03' : '2026-10-01';
    const period = id.endsWith('control') ? 'in October 2026' : `from ${from} through 2026-10-31`;
    expected = [`You spent $60.00 at Store One ${period}. [1].`,
      `Coverage: requested ${from} through 2026-10-31; 1 contributing, 3 fully covered, 0 omitted accounts; ${masks.map(mask => `account ****${mask} covered through 2026-11-07`).join('; ')}.`, posted];
    assert.equal(l.complete, true); assert.equal(l.found, true);
  } else if (id.startsWith('D7/')) {
    expected = [...(ambiguous ? ['Ambiguous: multiple deposits match the supplied payment details; no single payment is confirmed.'] : []),
      ...ids.map((rowId, i) => `Found a deposit of $177.77 posted ${sourceFacts[rowId][2]} in account ****3131: Payer Unit [${i + 1}].`),
      ...(!id.endsWith('control') ? ['Lookup window: 2026-10-05 through 2026-10-19, inclusive (plus or minus 7 days around 2026-10-12).', accountLine(masks)] : []), posted];
    if (!id.endsWith('control')) {
      assert.equal(l.complete, !ambiguous); assert.equal(l.ambiguous, ambiguous);
      assert.equal(l.match_count, ids.length); assert.equal(l.anchor_date, '2026-10-12');
    }
  } else if (recurring) {
    expected = ['Recurring charges detected, not confirmed. service unit: monthly, typical $12.01; last charge $12.01 on 2026-10-10 [1] [2] [3].',
      'Estimated monthly total: $12.01 (weekly amounts use 52/12, rounded to cents per merchant).',
      accountLine(masks, '2026-07-04 through 2026-10-31'), transferNote, posted];
    assert.deepEqual(l.recurring, [{ merchant: 'service unit', cadence: 'monthly', typical_minor: 1201, monthly_minor: 1201,
      last_charge: '2026-10-10', last_amount_minor: 1201, occurrence_count: 3, detected: true,
      citations: [1, 2, 3], possible_transfer_citations: [] }]);
    assert.equal(l.found, true);
  } else if (id === 'Q6/control') {
    expected = ['Newest 10 transactions:', ...ids.map((rowId, i) => {
      const [, cents, date, label] = sourceFacts[rowId];
      return `${date}: ${label}, ${formatMinor(String([9, 11].includes(rowId) ? cents : -cents))}, Operating account (account ****3131) [${i + 1}].`;
    }), posted];
  } else {
    const previous = id.startsWith('D9/'), single = id === 'D9/single', combined = previous && id !== 'D9/control';
    const selectedMasks = single ? ['3131'] : masks;
    const period = previous ? '2026-09-01 through 2026-09-30' : '2026-10-01 through 2026-10-31';
    expected = [...(combined ? [
      `Combined recorded inflow: ${single ? '$322.33' : '$746.11'} across ${selectedMasks.length} selected covered accounts, ${period}; not established income.`,
      'Matched transfers between your own accounts: $0.00 across 0 pairs.',
      `Inflow from outside your covered accounts: ${single ? '$322.33' : '$746.11'} (recorded inflow minus matched transfers; unmatched credits may include unproved own-account moves).`,
      'Transfers are counted by the inflow posting date; counterpart outflows may fall up to 3 days before or after it.',
    ] : []),
      ...selectedMasks.map(mask => {
        const credits = previous ? mask === '3131' ? '$322.33' : mask === '5353' ? '$423.78' : '$0.00' : mask === '3131' ? '$233.32' : '$0.00';
        const debits = !previous && mask === '3131' ? '$1,010.00' : '$0.00';
        const refs = expectedCitations.filter(c => c.account_mask === mask).map(c => `[${c.n}]`).join(' ');
        return `account ****${mask}, ${period}: credits ${credits}; debits ${debits} ${refs || '(no posted income or expenses in the covered period)'}.`;
      }), ...(combined ? ['Source and own-account transfer status are not established by a payer label; uncertain credits remain included.'] : []),
      accountLine(selectedMasks, period), ...(!combined ? [transferNote] : []), posted];
    if (combined) {
      assert.equal(l.income_established, false); assert.equal(l.includes_own_transfers, true);
      assert.equal(l.outside_inflow_minor, single ? 32233 : 74611);
      assert.equal(l.matched_transfer_count, 0);
      assert.deepEqual(l.matched_own_transfers, { total_minor: 0, count: 0, window_days: 3, pairs: [] });
      assert.deepEqual(l.transfer_related_credit_citations, []);
    }
  }
  const original = expected.join('\n');
  assert.equal(b.answer, wording === 'pinned' ? original : reviewedFinalOffer(reviewedPlainCopy(original), balance && !forecast ? 'Want help refreshing the bank connection for a newer balance?' : undefined), 'independent exact prose, dates, groups, counts and scope for this source version');
  if (wording !== 'pinned') {
    const chosen = balance && !forecast ? 'Want help refreshing the bank connection for a newer balance?' : 'Want me to show your account balances?';
    assert.ok(b.answer.endsWith(chosen));
    assert.deepEqual(b.answer.match(/Want[^?\n]*\?/g), [chosen]);
  }
}

export function contract(o, { wording = 'current' } = {}) {
  assert.ok(['current', 'pinned'].includes(wording));
  assert.equal(o.execution_status, 'complete');
  assert.equal(o.trace.parsed_intents.length, 1, 'actual classifier reached');
  assert.ok(o.trace.fixture_accounts > 0);
  assert.equal(o.trace.product_writes, 0);
  const b = o.body, l = b.ledger;
  assert.ok(l, 'ledger must answer');
  reviewContract(o, wording);
  assert.ok(o.trace.dependencies.includes('inventory'));
  assert.ok(o.trace.dependencies.includes(l.kind === 'balance' ? 'balances' : 'transactions'));
  let displayed;
  if (/^D5\/|^D10\//.test(o.id)) {
    assert.equal(l.kind, 'balance');
    assert.deepEqual(l.accounts.map(a => [a.account_mask, a.current_minor, a.as_of]),
      [['3131', 502345, '2026-10-30'], ['5353', 200001, '2026-10-30'], ['4242', 880000, '2026-10-30']]);
    assert.deepEqual(l.accounts.map(a => a.balance_group), ['cash', 'cash', 'liability']);
    assert.match(b.answer, /Cash accounts/);
    assert.match(b.answer, /Liabilities \(separate from cash\)/);
    assert.ok(b.answer.includes(wording === 'pinned' ? 'Recorded observations, not live or available cash.' : LIVE_PLAIN.split('\n')[0]));
    displayed = ['502345', '200001', '880000'];
    if (o.id === 'D10/forecast') {
      assert.equal(l.forecast_supported, false);
      assert.equal(b.evidence_gate.complete, false);
      assert.equal(b.answer.split('\n')[0], wording === 'pinned' ? "I can't forecast next month's bank balance. Here is the current recorded snapshot instead." : 'I can show your recorded balances, but future balances and payments are unknown.');
      assert.doesNotMatch(b.answer, /(?:will be|projected balance|expected balance).*\$/i);
    }
  } else if (o.id.startsWith('D6/')) {
    assert.equal(l.kind, 'merchant');
    assert.equal(l.total_minor, 6000);
    assert.equal(l.match_basis, 'exact');
    const from = o.id.endsWith('months') ? '2026-07-31' : o.id.endsWith('days') ? '2026-08-03' : '2026-10-01';
    assert.equal(l.from, from); assert.equal(l.to, '2026-10-31');
    assert.ok(b.answer.includes(wording === 'pinned' ? `Coverage: requested ${from} through 2026-10-31` : reviewedDateCopy(`Bank history: requested ${from} through 2026-10-31`)));
    assert.equal(l.coverage.covered_account_count, 3);
    assert.deepEqual(b.citations.map(c => c.ref), ['ledger:transaction:1']);
    displayed = ['6000'];
  } else if (o.id.startsWith('D7/')) {
    assert.equal(l.kind, 'payment');
    assert.equal(l.from, '2026-10-05'); assert.equal(l.to, '2026-10-19');
    assert.equal(l.found, o.id.endsWith('ambiguous') ? null : true);
    assert.deepEqual(b.citations.map(c => c.ref), o.id.endsWith('ambiguous')
      ? ['ledger:transaction:9', 'ledger:transaction:30'] : ['ledger:transaction:9']);
    if (!o.id.endsWith('control')) {
      assert.match(b.answer, /plus or minus 7 days/);
      assert.ok(b.answer.includes(wording === 'pinned' ? '2026-10-05 through 2026-10-19' : 'October 5 to 19'));
    }
    if (o.id.endsWith('ambiguous')) { assert.equal(l.ambiguous, true); assert.equal(b.answer.split('\n')[0], wording === 'pinned' ? 'Ambiguous: multiple deposits match the supplied payment details; no single payment is confirmed.' : 'I found 2 matching deposits in October 5 to 19, so no single payment is confirmed.'); }
    displayed = o.id.endsWith('ambiguous') ? ['17777', '17777'] : ['17777'];
  } else if (o.id.startsWith('D8/')) {
    assert.equal(l.kind, 'recurring');
    assert.equal(l.from, '2026-07-04'); assert.equal(l.to, '2026-10-31');
    assert.equal(l.monthly_total_minor, 1201);
    assert.deepEqual(l.recurring.map(g => [g.merchant, g.cadence, g.occurrence_count]), [['service unit', 'monthly', 3]]);
    assert.match(b.answer, /detected, not confirmed/);
    assert.doesNotMatch(b.answer, /confirmed active subscriptions/i);
    assert.deepEqual(b.citations.map(c => c.ref), [1, 2, 3].map(id => `ledger:transaction:${id}`));
    displayed = ['1201', '1201', '1201'];
  } else if (o.id.startsWith('D9/')) {
    assert.equal(l.kind, 'totals');
    assert.equal(l.from, '2026-09-01'); assert.equal(l.to, '2026-09-30');
    const single = o.id.endsWith('single');
    assert.deepEqual(l.accounts.map(a => [a.account_mask, a.credits_minor]), single
      ? [['3131', 32233]] : [['3131', 32233], ['4242', 0], ['5353', 42378]]);
    if (!o.id.endsWith('control')) {
      assert.equal(l.combined_inflow_minor, single ? 32233 : 74611);
      assert.match(b.answer, /Combined recorded inflow/);
      assert.match(b.answer, /not established income/);
      assert.ok(b.answer.includes(wording === 'pinned' ? 'Source and own-account transfer status are not established by a payer label; uncertain credits remain included.' : 'Income is still unconfirmed; a deposit can be a transfer or another kind of credit, and the bank label alone does not prove its source.'));
      assert.match(b.answer, /covered through/);
      displayed = single ? ['32233', '0', '32233', '32233', '0']
        : ['74611', '0', '74611', '32233', '0', '0', '0', '42378', '0'];
    } else displayed = ['32233', '0', '0', '0', '42378', '0'];
  } else if (o.id === 'Q6/control') {
    assert.equal(l.kind, 'transactions');
    assert.deepEqual(b.citations.map(c => c.ref), [1, 2, 3, 4, 5, 6, 11, 9, 8, 7].map(id => `ledger:transaction:${id}`));
    assert.equal(l.complete, true);
    displayed = ['-6000', '-5000', '-4000', '-3000', '-2000', '-1000', '3333', '17777', '-40000', '-40000'];
  } else {
    assert.equal(o.id, 'gross/control');
    assert.deepEqual(l.accounts.map(a => [a.account_mask, a.credits_minor, a.debits_minor]),
      [['3131', 23332, 101000], ['4242', 0, 0], ['5353', 0, 0]]);
    displayed = ['23332', '101000', '0', '0', '0', '0'];
  }
  assert.deepEqual(displayFigures(b.answer).map(a => a.cents), displayed, 'every displayed amount');
  for (const ref of [...b.answer.matchAll(/\[(\d+)\]/g)]) assert.ok(b.citations.some(c => c.n === Number(ref[1])));
  assert.ok(b.citations.length > 0);
  assert.doesNotMatch(b.answer, /\bprincipal\b|\bno pending\b/i);
}
