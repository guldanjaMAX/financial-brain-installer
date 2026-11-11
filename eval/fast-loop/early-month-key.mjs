// Frozen synthetic expectations. No product classifier or arithmetic imports.
import assert from 'node:assert/strict';
import { reviewedFinalOffer, reviewedDateCopy, reviewedPlainCopy } from '../../worker/test/fixtures/plain-copy-expectations.mjs';
import { displayFigures, formatMinor } from './money-oracle.mjs';

const posted = 'Figures use recorded posted rows. Pending activity is not assessed here.';
const fullCoverage = (from, to) => `Coverage: full, all 3 selected accounts cover ${from} through ${to}.`;
function currentLines(c) {
  if (c.currentUnavailable) {
    const coverage = ['3131', '4242', '5353'].map(mask =>
      `****${mask}: covered through 2026-09-30, feed last synced unknown`).join('; ');
    return [`Unavailable. The bank ledger did not answer this question (period outside coverage). ${coverage} Document dates do not measure bank-feed freshness.`];
  }
  const total = c.current ? '$12.34' : '$0.00';
  return [c.unknown
    ? `Recorded outflow subtotal: ${total} this month; account classification is unconfirmed, so expense interpretation is incomplete.`
    : `You spent ${total} this month.`,
  `Period: 2026-10-01 through ${c.period.to}.`,
  ...(c.current ? ['Merchant groups:', 'current store: $12.34 across 1 row [1].',
    'Category groups:', 'Unsorted: $12.34 across 1 row.'] : []),
  ...(c.repaymentOnly ? ['Payments to your own loan/card accounts: $222.22 across 1 payment.'] : []),
  `Evidence: ${c.current ? 1 : 0} of ${c.current ? 1 : 0} expense rows cited.`,
  fullCoverage('2026-10-01', c.period.to)];
}

export function reviewEarlyMonth(o, c, { wording = 'current' } = {}) {
  assert.ok(['current', 'pinned'].includes(wording));
  assert.equal(o.execution_status, 'complete', 'harness execution must finish');
  assert.equal(o.trace.parsed_intents.length, 1);
  assert.equal(o.trace.product_writes, 0);
  assert.equal(o.trace.model_calls, 0);
  const b = wording === 'pinned' ? o.body : legacyDisclosureView(o.body, c), l = b.ledger;
  // The newly admitted bare spend form previously had no deterministic answer.
  if (!l && c.id === 'early/bare-spend') {
    assert.equal(o.trace.fallback_calls, 1, 'baseline unsupported wording decision reached');
    assert.equal(b.gaps[0].reason, 'ledger_wording_unsupported');
    assert.equal(b.answer, null);
    assert.deepEqual(b.citations, []);
    return { wrong_figures: 0, unsupported_claims: 0, missing_previous: 1 };
  }
  assert.ok(o.trace.dependencies.includes('inventory'));
  // The parent refuses before transaction SQL. Admit that honest refusal for
  // comparison while counting the independently answerable month it lost.
  if (!l && c.currentUnavailable) {
    assert.ok(o.trace.sql.some(s => s.kind === 'inventory' && s.row_count === 3));
    assert.equal(b.code, 'period_outside_coverage');
    assert.equal(b.answer, null);
    assert.deepEqual(b.citations, []);
    assert.deepEqual(b.gaps.map(g => [g.reason, g.from, g.to]), [['period_outside_coverage', '2026-10-01', '2026-10-01']]);
    assert.equal(b.evidence_gate.complete, false);
    return { wrong_figures: 0, unsupported_claims: 0, missing_previous: 1 };
  }
  assert.ok(o.trace.dependencies.includes('transactions'));
  assert.equal(l.kind, 'expense_summary');
  if (c.unknown) {
    // An unreviewed destination cannot certify either an expense or a zero.
    // Full date coverage remains independent of that classification refusal.
    assert.equal(l.total_minor, null);
    assert.equal(l.expense_total_minor, null);
    assert.equal(l.retained_outflow_minor, 0);
    assert.equal(l.classification_complete, false);
    assert.equal(l.classification_uncertain, true);
    assert.equal(l.complete, false);
    assert.equal(l.row_count, 0);
    assert.equal(l.coverage.complete, true);
    assert.equal(l.coverage.covered_account_count, 3);
    assert.equal(l.coverage.omitted_account_count, 0);
    assert.deepEqual(l.own_account_payments, { total_minor: 0, count: 0, card_minor: 0, loan_minor: 0 });
    const previous = l.previous_month;
    assert.ok(previous, 'the previous-period classification decision remains visible');
    assert.deepEqual([previous.from, previous.to], ['2026-09-01', '2026-09-30']);
    assert.equal(previous.reason, 'ledger_account_kind_review_required');
    assert.equal(previous.complete, false);
    for (const field of ['total_minor', 'expense_total_minor', 'own_account_payments'])
      assert.equal(previous[field], undefined);
    assert.deepEqual(b.gaps.map(gap => [gap.reason, gap.from, gap.to]),
      [['ledger_account_kind_review_required', '2026-09-01', '2026-09-30']]);
    const expected = wording === 'pinned' ? [
      `Month to date (2026-10-01 through ${c.period.to}): Recorded outgoing subtotal: $0.00. ` +
        'Expense classification is uncertain; this subtotal may include payments between your own accounts. ' +
        'Account classification is unconfirmed; expense interpretation is incomplete. ' +
        fullCoverage('2026-10-01', c.period.to),
      '', 'Previous complete calendar month (2026-09-01 through 2026-09-30):',
      'Unavailable. An owned account has an unclassified type, so a directed payment cannot yet be classified as an ordinary expense or an owned-liability payment. Review that account with the owner before requesting an expense total or ranking. No expense total or zero is certified.',
      posted,
    ].join('\n')
    : [
      `Month to date (October 1 to ${Number(c.period.to.slice(-2))}): Money out I could check: $0.00 this month. ` +
        "Here is the money out I could check, with spending still unconfirmed. The account types for your account ending 4242 have not been confirmed, so some payments may be between your own accounts. " +
        `Bank history: all 3 accounts include October 1 to ${Number(c.period.to.slice(-2))}.`,
      'Want me to show your account balances?', '', 'Previous complete calendar month (September):',
      "Unavailable. Before I count this as spending, I need to know which accounts are cards or loans. It's a one-time question. Want to do it now?",
      reviewedPlainCopy(posted),
      'Owned loan: not counted in cash or spending totals; account kind not confirmed (unconfirmed account type).',
    ].join('\n');
    assert.deepEqual(displayFigures(b.answer).map(figure => figure.cents), ['0']);
    assert.equal(b.answer, wording === 'pinned' ? expected : reviewedFinalOffer(expected, 'Want to do it now?'));
    assert.deepEqual(b.citations, []);
    assert.equal(b.evidence_gate.complete, false);
    return { wrong_figures: 0, unsupported_claims: 0, missing_previous: 0 };
  }
  if (c.currentUnavailable) {
    assert.equal(l.reason, 'period_outside_coverage');
    assert.equal(l.complete, false);
    for (const field of ['total_minor', 'expense_total_minor', 'row_count', 'own_account_payments']) assert.equal(l[field], undefined);
    assert.deepEqual(b.gaps.map(g => [g.reason, g.from, g.to]), [['period_outside_coverage', '2026-10-01', '2026-10-01']]);
    assert.equal(b.evidence_gate.partial, true);
    assert.equal(b.evidence_gate.reason, 'month to date is outside ledger coverage');
    assert.ok(l.previous_month, 'current coverage gap cannot suppress the previous month');
  } else {
    assert.equal(l.total_minor, c.current ? 1234 : 0);
    assert.equal(l.expense_total_minor, c.current ? 1234 : 0);
    assert.equal(l.own_account_payments.total_minor, c.repaymentOnly ? 22222 : 0);
  }
  const previous = l.previous_month, lines = currentLines(c);
  let expected = [...lines, posted].join('\n');
  const expectedIds = c.current ? [11] : [];
  if (previous) {
    assert.deepEqual([previous.from, previous.to], ['2026-09-01', '2026-09-30']);
    const compact = [
      `Month to date (2026-10-01 through ${c.period.to}): ${lines[0]}`,
      ...(c.current ? ['[1]'] : []),
      ...(c.repaymentOnly ? ['Payments to your own loan/card accounts: $222.22 across 1 payment.'] : []),
      ...(!c.currentUnavailable ? [`Evidence: ${c.current ? 1 : 0} of ${c.current ? 1 : 0} expense rows cited.`,
        fullCoverage('2026-10-01', c.period.to)] : []),
    ].join(' ');
    const heading = 'Previous complete calendar month (2026-09-01 through 2026-09-30):';
    if (c.coverage === 'unavailable') {
      assert.equal(previous.reason, 'period_outside_coverage');
      assert.equal(previous.total_minor, undefined);
      assert.equal(previous.complete, false);
      assert.equal(b.gaps[0].reason, 'period_outside_coverage');
      const coverage = ['3131', '4242', '5353'].map(mask =>
        `****${mask}: covered through 2026-11-07, feed last synced unknown`).join('; ');
      expected = `${compact}\n\n${heading}\nUnavailable. The bank ledger did not answer this question (period outside coverage). ${coverage} Document dates do not measure bank-feed freshness.\n${posted}`;
    } else {
      const total = c.unknown ? 99134 : 59134, count = c.unknown ? 4 : 3;
      assert.equal(previous.total_minor, total);
      assert.equal(previous.expense_total_minor, total);
      assert.equal(previous.excluded_own_transfer_minor, 5000);
      assert.deepEqual(previous.own_account_payments, { total_minor: c.unknown ? 0 : 40000,
        count: c.unknown ? 0 : 1, card_minor: 0, loan_minor: c.unknown ? 0 : 40000 });
      assert.equal(previous.complete, !c.unknown && !c.coverage);
      assert.equal(previous.classification_uncertain, Boolean(c.unknown));
      assert.equal(previous.row_count, count);
      assert.equal(previous.coverage.covered_account_count, c.coverage === 'partial' ? 2 : 3);
      const groups = [['outside lender', 40000, 4], ...(c.unknown ? [['payment', 40000, 3]] : []),
        ['store one', 12345, 1], ['store two', 6789, 2]];
      const offset = c.current ? 1 : 0;
      assert.deepEqual(previous.groups.map(g => [g.merchant, g.total_minor, g.count, g.citations]),
        groups.map(([merchant, cents], i) => [merchant, cents, 1, [offset + i + 1]]));
      assert.deepEqual(previous.category_groups, [{ category: 'Unsorted', total_minor: total,
        count, citations: groups.map((_, i) => offset + i + 1) }]);
      expectedIds.push(...groups.map(g => g[2]));
      const priorLines = [c.unknown
        ? 'Recorded outflow subtotal: $991.34 last month; account classification is unconfirmed, so expense interpretation is incomplete.'
        : c.coverage === 'partial' ? 'Covered-account expense subtotal: $591.34 last month (partial coverage).'
          : 'You spent $591.34 last month.',
      'Period: 2026-09-01 through 2026-09-30.', 'Merchant groups:',
      ...groups.map(([merchant, cents], i) => `${merchant}: ${formatMinor(String(cents))} across 1 row [${offset + i + 1}].`),
      'Category groups:', `Unsorted: ${c.unknown ? '$991.34' : '$591.34'} across ${count} rows.`,
      `Unconfirmed categories: ${count} rows totaling ${c.unknown ? '$991.34' : '$591.34'}; left out of confirmed category totals.`,
      ...(!c.unknown ? ['Payments to your own loan/card accounts: $400.00 across 1 payment.'] : []),
      `Evidence: ${count} of ${count} expense rows cited.`,
      c.coverage === 'partial'
        ? 'Coverage: partial, 2 of 3 selected accounts cover 2026-09-01 through 2026-09-30; excluded account ****4242.'
        : fullCoverage('2026-09-01', '2026-09-30')];
      expected = [compact, '', heading, ...priorLines, posted].join('\n');
    }
  }
  const cents = displayFigures(expected).map(f => f.cents);
  assert.deepEqual(displayFigures(b.answer).map(f => f.cents), cents, 'every displayed figure has a frozen value');
  assert.equal(b.answer, wording === 'pinned' ? expected : reviewedEarlyPlain(expected, c), 'all factual prose and period labels match this exact reviewed source version');
  assert.deepEqual(b.citations.map(citation => citation.ref), expectedIds.map(id => `ledger:transaction:${id}`));
  for (const [index, citation] of b.citations.entries()) {
    const facts = { 11: [1234, '2026-10-01'], 4: [40000, '2026-09-21'], 3: [40000, '2026-09-20'],
      1: [12345, '2026-09-01'], 2: [6789, '2026-09-30'] }[expectedIds[index]];
    assert.equal(citation.n, index + 1);
    assert.deepEqual([citation.amount_minor, citation.posted_on, citation.account_mask], [...facts, '3131']);
  }
  assert.equal(b.evidence_gate.complete, !c.currentUnavailable && !c.unknown && !(previous && c.coverage));
  return { wrong_figures: 0, unsupported_claims: 0, missing_previous: previous ? 0 : 1 };
}

function reviewedEarlyPlain(original, c) {
  const suggestion = 'Want me to show your account balances?';
  let text = reviewedPlainCopy(original, { dates: false }).replaceAll('Recorded outflow subtotal:', 'Money out I could check:').replaceAll('; account classification is unconfirmed, so expense interpretation is incomplete.', '.');
  const unknown = `Here is the money out I could check, with spending still unconfirmed. The account types for account ****4242 have not been confirmed, so some payments may be between your own accounts.\n${suggestion}`;
  if (c.unknown) {
    text = text.replace(' Evidence:', ` ${unknown.split('\nWant ')[0]} Evidence:`);
    text = text.replace('\n\nPrevious complete calendar month', `\n${suggestion}\n\nPrevious complete calendar month`);
    text = text.replace('Period: 2026-09-01 through 2026-09-30.\n', `Period: 2026-09-01 through 2026-09-30.\n${unknown}\n`);
  }
  if (c.coverage === 'partial') {
    text = text.replace('Covered-account expense subtotal: $591.34 last month (partial coverage).',
      'Partial view using 2 of 3 accounts for September. Covered accounts: Operating account (your account ending 3131); Reserve account (your account ending 5353). ' +
      'Omitted accounts: Owned loan (your account ending 4242); their bank history does not include every requested date. This is not a total for all requested accounts.\n' +
      'Spending I could check: $591.34 last month (some accounts missing dates).');
    text = text.replace('Period: 2026-09-01 through 2026-09-30.\n', `Period: 2026-09-01 through 2026-09-30.\nHere is a partial view using 2 of 3 accounts for 2026-09-01 through 2026-09-30; account ****4242 is missing some dates.\n${suggestion}\n`);
    text = text.replace('Coverage: partial, 2 of 3 selected accounts include ', 'Bank history: 2 of 3 selected accounts include ');
  }
  for (const [start, end, from, to] of [
    ['2026-07-01', '2026-09-30', '2026-10-01', c.period.to],
    ['2026-10-01', '2026-11-07', '2026-09-01', '2026-09-30'],
  ]) {
    const oldHistory = ['3131', '4242', '5353'].map(mask => `****${mask}: covered through ${end}, feed last synced unknown`).join('; ');
    const history = `Your account ending 3131 has records from ${start} through ${end}, last update unavailable; 2 more accounts.`;
    text = text.replace(`The bank ledger did not answer this question (period outside coverage). ${oldHistory} Document dates do not measure bank-feed freshness.`,
      `I can help check the bank records for ${from} through ${to}, but some bank days are missing, so a complete answer is unconfirmed.\n${history}\n${suggestion}`);
  }
  return reviewedFinalOffer(reviewedDateCopy(text));
}

// Validate additive receipts against the frozen early-month facts, then rebase
// the older exact-copy oracle. This keeps its cents, scope and prose checks
// intact while making the new payment and pending figures independently fail.
export function legacyDisclosureView(body, c) {
  const b = structuredClone(body), removed = new Set();
  if (b.answer == null) return b;
  const rawLines = b.answer?.split('\n') || [];
  let lines = [...rawLines];
  for (const ledger of [b.ledger, b.ledger?.previous_month].filter(Boolean)) {
    for (const group of ledger.category_groups || []) {
      const line = lines.find(line => line.startsWith(`${group.category}:`) && /\[\d+\]/.test(line) &&
        JSON.stringify([...line.matchAll(/\[(\d+)\]/g)].map(match => Number(match[1]))) === JSON.stringify(group.citations));
      if (!line) continue;
      const numbers = [...line.matchAll(/\[(\d+)\]/g)].map(match => Number(match[1]));
      const refs = numbers.map(n => b.citations.find(ref => ref.n === n));
      const expectedIds = ledger.from === '2026-09-01' ? [1, 2, 4] : c.current ? [11] : [];
      assert.deepEqual(numbers, group.citations);
      assert.ok(refs.every(Boolean), 'every category reference resolves before rebasing');
      assert.deepEqual(refs.map(ref => Number(ref.ref.split(':').at(-1))).sort((a, b) => a - b), expectedIds);
      assert.equal(refs.reduce((sum, ref) => sum + ref.amount_minor, 0), ledger.from === '2026-09-01' ? 59134 : 1234);
      assert.equal(refs.length, group.count);
      lines = lines.map(text => text === line ? text.replace(/(?: \[\d+\])+\.$/, '.') : text);
    }
    const payments = ledger.payment_exclusions;
    if (!payments) continue;
    const id = ledger.from === '2026-09-01' ? 3 : 12;
    const amount = id === 3 ? 40000 : 22222, day = id === 3 ? 'September 20' : 'October 1';
    assert.equal(payments.count, 1);
    assert.equal(payments.total_minor, amount);
    assert.equal(payments.rows.length, 1);
    const row = payments.rows[0], ref = b.citations.find(ref => ref.n === row.n);
    assert.equal(ref.ref, `ledger:transaction:${id}`);
    assert.equal(ref.amount_minor, amount);
    assert.equal(row.account_mask, '3131');
    assert.equal(row.own_loan_mask, '4242');
    const item = `payment to your own loan (ending 4242): ${formatMinor(String(amount))} on ${day} in your account ending 3131 [${row.n}].`;
    assert.equal(rawLines.filter(line => line === item).length, 1);
    lines = lines.filter(line => line !== item);
    const header = `Payments to loans and cards (excluded from spending and income): ${formatMinor(String(amount))} across 1 payment [${row.n}].`;
    assert.ok(b.answer.includes(header));
    lines = lines.map(line => line.replace(header, `Payments to your own loan/card accounts: ${formatMinor(String(amount))} across 1 payment.`));
    removed.add(row.n);
    delete ledger.payment_exclusions;
  }
  const pending = b.ledger?.pending_excluded;
  if (pending) {
    const id = b.ledger.from === '2026-09-01' ? 7 : 8, amount = id === 7 ? 99999 : 777;
    assert.equal(pending.count, 1); assert.equal(pending.total_minor, amount); assert.equal(pending.citations.length, 1);
    const n = pending.citations[0], ref = b.citations.find(ref => ref.n === n);
    assert.equal(ref.ref, `ledger:transaction:${id}`); assert.equal(ref.amount_minor, amount);
    const line = `Pending activity: ${formatMinor(String(amount))} across 1 row, excluded from completed spending [${n}].`;
    assert.equal(rawLines.filter(text => text === line).length, 1);
    lines = lines.filter(text => text !== line); removed.add(n);
    delete b.ledger.pending_excluded;
  }
  if (lines.some(line => line.startsWith('Accounts covered:'))) {
    const line = lines.find(line => line.startsWith('Accounts covered:'));
    const masks = c.currentUnavailable && !c.coveredTo ? [] : ['3131', '4242', '5353'];
    assert.deepEqual([...line.matchAll(/ending (\d{4})/g)].map(match => match[1]).sort(), masks);
    lines = lines.filter(text => text !== line);
  }
  b.citations = b.citations.filter(ref => !removed.has(ref.n));
  const numbering = new Map(b.citations.map((ref, i) => [ref.n, i + 1]));
  const rebase = (value, key = '') => Array.isArray(value) ? value.map(entry => key === 'citations' && Number.isInteger(entry) ? numbering.get(entry) : rebase(entry))
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, key === 'n' ? numbering.get(entry) : rebase(entry, key)])) : value;
  b.ledger = rebase(b.ledger); b.citations = b.citations.map(ref => ({ ...ref, n: numbering.get(ref.n) }));
  b.answer = lines.map(line => line.replace(/\[(\d+)\]/g, (_, n) => removed.has(Number(n)) ? '' : `[${numbering.get(Number(n))}]`)
    .replace(/ {2,}/g, ' ').trimEnd()).join('\n');
  return b;
}
