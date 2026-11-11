// Independently authored development expectations. No product matching or sums.
import assert from 'node:assert/strict';
import { displayFigures, formatMinor } from './money-oracle.mjs';
import { absenceLintText, reviewedFinalOffer, reviewedPlainCopy, MONEY_JARGON } from '../../worker/test/fixtures/plain-copy-expectations.mjs';

const posted = 'Figures use recorded posted rows. Pending activity is not assessed here.';
const productGroups = [[1, 'Vendorwave Cloud', 1201], [2, 'VENDORWAVE *WORKSPACE', 2302], [3, 'Vendorwave / Media', 3497]];
const coverageLine = (count = 1, partial = false) =>
  `Coverage: requested 2026-10-01 through 2026-10-31; ${count} contributing, ${partial ? 2 : 3} fully covered, ${partial ? '1 omitted account' : '0 omitted accounts'}; ` +
  (partial ? ['3131', '4242'] : ['3131', '4242', '5353']).map(mask => `account ****${mask} covered through 2026-11-07`).join('; ') + '.';
const ambiguity = 'Ambiguous vendor family; candidates seen: Cloud Cafe; Cloud Parts. Only exact payees can establish a subtotal.';
const refs = count => Array.from({ length: count }, (_, i) => `[${i + 1}]`).join(' ');
const shortSpecs = {
  short: { total: 4000, groups: [[1, 'Cloud Cafe', 1700], [2, 'Cloud Parts', 2300]], vendor: 'Cloud' },
  'short-exact': { total: 4501, groups: [[1, 'Cloud Cafe', 1700], [2, 'Cloud Parts', 2300], [4, 'Cloud', 501]], exact: 1, vendor: 'Cloud' },
};
const specs = {
  products: { total: 7000, groups: productGroups },
  'exact-family': { total: 7501, groups: [...productGroups, [4, 'Vendorwave', 501]], exact: 1 },
  alias: { total: 1201, groups: [[1, 'GOOG *CLOUD', 1201]], vendor: 'Google' },
  mixed: { total: 1201, groups: [productGroups[0]], possible: 9900 },
  refund: { total: 1201, groups: [productGroups[0]] },
  owned: { total: 1201, groups: [productGroups[0]], excluded: 5000 },
  partial: { total: 7000, groups: productGroups, partial: true },
  many: { total: 836, groups: [
    [1, 'Vendorwave Product 1', 101], [2, 'Vendorwave Product 2', 102], [3, 'Vendorwave Product 3', 103],
    [4, 'Vendorwave Product 4', 104], [5, 'Vendorwave Product 5', 105], [6, 'Vendorwave Product 6', 106],
    [7, 'Vendorwave Product 7', 107], [8, 'Vendorwave Product 8', 108],
  ] },
  spelling: { total: 3503, groups: [[1, 'Vendorwave Cloud', 1201], [2, 'VENDORWAVE CLOUD', 2302]] },
};

export function reviewVendorFamily(o, { baseline = false } = {}) {
  assert.equal(o.execution_status, 'complete');
  assert.equal(o.route, 'ledger:merchant');
  assert.ok(o.trace.dependencies.includes('transactions'), 'nonempty snapshot decision reached');
  assert.ok(o.trace.rows_read.length > 0, 'refusal must inspect synthetic receipts');
  assert.equal(o.trace.product_writes, 0);
  assert.equal(o.trace.model_calls, 0);
  const b = o.body, l = b.ledger, key = o.id.split('/')[1], spec = specs[key] || (!baseline ? shortSpecs[key] : undefined);
  assert.equal(l.kind, 'merchant');
  assert.deepEqual([l.from, l.to], ['2026-10-01', '2026-10-31']);
  if (spec?.partial && !baseline) {
    assert.equal(b.gaps.length, 1);
    assert.deepEqual([b.gaps[0].type, b.gaps[0].reason, b.gaps[0].from, b.gaps[0].to],
      ['ledger_partial_coverage', 'ledger_partial_coverage', '2026-10-01', '2026-10-31']);
    assert.deepEqual([l.coverage.candidate_account_count, l.coverage.covered_account_count, l.coverage.omitted_account_count], [3, 2, 1]);
    assert.deepEqual(l.coverage.excluded_accounts.map(a => a.account_mask), ['5353']);
    assert.equal(l.complete_total_minor, null);
  } else assert.deepEqual(b.gaps, []);
  if (!baseline && ['alias', 'embedded', 'alias-boundary'].includes(key)) {
    // Character overlap now remains visible for review, with bank-row cites.
    // Only the explicitly reviewed GOOG row contributes to the Google total.
    const candidates = key === 'embedded'
      ? [[1, 'Supervendorwave Cloud', 9900], [2, 'Vendorwaveworks', 8800]]
      : key === 'alias'
        ? [[2, 'Goog Kitchen', 9900], [3, 'Googlet *Cloud', 8800]]
        : [[1, 'Goog Kitchen', 9900], [2, 'Googlet *Cloud', 8800]];
    const certified = key === 'alias';
    assert.equal(l.match_basis, certified ? 'family' : 'possible');
    assert.equal(l.total_minor, certified ? 1201 : null);
    assert.equal(l.complete, certified);
    assert.equal(b.evidence_gate.complete, certified);
    assert.equal(l.possible_identity_count, candidates.length);
    assert.equal(b.citations.length, candidates.length + (certified ? 1 : 0));
    if (certified) {
      assert.deepEqual(l.included_payees, ['GOOG *CLOUD']);
      assert.deepEqual(l.groups.map(g => [g.merchant, g.total_minor]), [['GOOG *CLOUD', 1201]]);
      assert.deepEqual(displayFigures(b.answer).map(f => f.cents), ['1201', '1201']);
      assert.equal(b.citations[0].ref, 'ledger:transaction:1');
      assert.equal(b.citations[0].amount_minor, 1201);
      assert.equal(l.if_own_transfers.total_minor, 1201);
    } else {
      assert.deepEqual(displayFigures(b.answer), []);
      assert.match(b.answer, /no store total is confirmed/i);
    }
    assert.match(b.answer, /possible.*not included/i);
    assert.deepEqual(l.possible_identity_members.map(m => m.ref).sort(),
      candidates.map(([id]) => `ledger:transaction:${id}`).sort());
    for (const [id, payee, amount] of candidates) {
      const member = l.possible_identity_members.find(m => m.ref === `ledger:transaction:${id}`);
      assert.equal(member.payee, payee);
      assert.ok(b.answer.includes(`"${payee}"`));
      assert.equal(member.citations.length, 1);
      const citation = b.citations[member.citations[0] - 1];
      assert.equal(citation.ref, member.ref);
      assert.equal(citation.amount_minor, amount);
      assert.ok(b.answer.includes(`[${citation.n}]`));
    }
    assert.ok(!b.receipt && !l.receipt);
    return { missing_family: 0, wrong_figures: 0, unsupported_claims: 0 };
  }
  if (baseline && spec) {
    assert.equal(l.total_minor, key === 'alias' ? null : key === 'exact-family' ? null : undefined);
    assert.equal(l.complete, false);
    assert.equal(b.evidence_gate.complete, false);
    if (key === 'exact-family') {
      assert.equal(l.exact_subtotal_minor, 501);
      assert.equal(l.possible_subtotal_minor, 7000);
      assert.deepEqual(b.citations.map(c => c.ref), ['ledger:transaction:4']);
    } else {
      assert.equal(b.citations.length, 0);
      assert.deepEqual(displayFigures(b.answer), []);
    }
    return { missing_family: 1, wrong_figures: 0, unsupported_claims: 0 };
  }
  if (spec && !baseline) {
    const exact = spec.exact ? 501 : spec.possible ? null : 0;
    assert.equal(l.match_basis, 'name_match');
    assert.equal(l.complete, false); assert.equal(b.evidence_gate.complete, false);
    assert.equal(l.total_minor, null);
    assert.equal(l.exact_subtotal_minor, exact);
    assert.equal(l.name_match_subtotal_minor, spec.total - exact);
    assert.equal(l.if_own_transfers.total_minor, null);
    assert.equal(l.if_own_transfers.complete, false);
    assert.equal(l.exact_match_count, spec.exact || 0);
    assert.equal(l.family_match_count, spec.groups.length - (spec.exact || 0));
    assert.equal(l.excluded_own_movement_minor, spec.excluded || 0);
    assert.deepEqual(l.groups.map(g => [g.merchant, g.total_minor, g.count]), spec.groups.map(([, name, cents]) => [name, cents, 1]));
    assert.deepEqual(b.citations.map(c => [c.ref, c.amount_minor]), spec.groups.map(([id, , cents]) => ['ledger:transaction:' + id, cents]));
    assert.match(b.answer, /matched by name, not confirmed/i);
    assert.match(b.answer, /same company\?/i);
    assert.doesNotMatch(b.answer, /confirmed subscription|You spent/);
    assert.ok(!b.receipt && !l.receipt);
    for (const [, name, cents] of spec.groups) {
      assert.ok(b.answer.includes(name)); assert.ok(b.answer.includes(formatMinor(String(cents))));
    }
    const expectedFigures = [...(exact === null ? [] : [exact]), spec.total - (exact || 0), ...spec.groups.map(g => g[2])].map(String);
    assert.deepEqual(displayFigures(b.answer).map(f => f.cents), expectedFigures);
    return { missing_family: 0, wrong_figures: 0, unsupported_claims: 0 };
  }
  let expected;
  if (spec) {
    const complete = !spec.possible && !spec.partial;
    assert.equal(l.match_basis, spec.possible ? 'family_and_possible' : 'family');
    assert.equal(l.total_minor, complete ? spec.total : null);
    assert.equal(l.complete, !spec.possible && !spec.partial);
    assert.equal(l.found, true);
    assert.equal(l.row_count, spec.groups.length);
    assert.equal(l.family_match_count, spec.groups.length - (spec.exact || 0));
    assert.equal(l.exact_match_count, spec.exact || 0);
    assert.equal(l.omitted_row_count, 0);
    assert.deepEqual(l.included_payees, spec.groups.map(g => g[1]));
    assert.deepEqual(l.groups.map(g => [g.merchant, g.total_minor, g.count, g.citations]),
      spec.groups.map(([, name, cents], i) => [name, cents, 1, [i + 1]]));
    assert.deepEqual(b.citations.map(c => [c.ref, c.amount_minor, c.posted_on, c.account_mask]),
      [...spec.groups.map(([id, , cents]) => [`ledger:transaction:${id}`, cents, '2026-10-05', '3131']),
        ...(spec.possible ? [['ledger:transaction:2', 9900, '2026-10-05', '3131']] : [])]);
    assert.equal(l.excluded_own_movement_minor, spec.excluded || 0);
    assert.equal(l.excluded_own_movement_count, spec.excluded ? 1 : 0);
    const vendor = spec.vendor || 'Vendorwave', amount = formatMinor(String(spec.total));
    const first = spec.possible
      ? `Partial: Structured-payee family subtotal for ${vendor} in October 2026 is ${amount}. Possible bank-text subtotal is $99.00. These subtotals are separate; this is not a complete vendor total.`
      : spec.partial ? `Partial: family-match subtotal for ${vendor} in October 2026 is ${amount}. This is not a complete total.`
        : `You spent ${amount} at ${vendor} in October 2026.`;
    if (spec.possible) {
      assert.equal(l.family_subtotal_minor, spec.total);
      assert.equal(l.possible_subtotal_minor, spec.possible);
      assert.equal(l.possible_match_count, 1);
    }
    if (spec.partial) assert.equal(l.partial_subtotal_minor, spec.total);
    expected = [first + ` ${refs(spec.groups.length)}.`,
      ...spec.groups.map(([, name, cents], i) => `${name}: ${formatMinor(String(cents))} across 1 row [${i + 1}].`),
      `Included payees: ${spec.groups.map(g => g[1]).join('; ')}.`,
      ...(spec.exact ? ['also includes: Vendorwave Cloud; VENDORWAVE *WORKSPACE; Vendorwave / Media.'] : []),
      coverageLine(1, spec.partial), posted].join('\n');
    assert.equal(b.evidence_gate.complete, complete);
  } else if (key === 'exact') {
    assert.equal(l.total_minor, 501);
    assert.equal(l.match_basis, 'exact');
    expected = ['You spent $5.01 at Vendorwave in October 2026. [1].', coverageLine(), posted].join('\n');
  } else if (key === 'short-exact') {
    assert.equal(l.total_minor, null);
    assert.equal(l.exact_subtotal_minor, 501);
    assert.equal(l.possible_subtotal_minor, 4000);
    assert.equal(l.match_basis, 'exact_and_possible');
    if (!baseline) {
      assert.deepEqual(b.citations.map(c => [c.ref, c.amount_minor]),
        [['ledger:transaction:4', 501], ['ledger:transaction:1', 1700], ['ledger:transaction:2', 2300]]);
      assert.deepEqual(l.possible_citations, [2, 3]);
    }
    expected = ['Partial: Exact structured-payee subtotal for Cloud in October 2026 is $5.01. Possible bank-text subtotal is $40.00. These subtotals are separate; this is not a complete vendor total. [1].',
      coverageLine(), ...(!baseline ? [ambiguity] : []), posted].join('\n');
  } else if (key === 'short' || key === 'bank-only') {
    assert.equal(l.match_basis, 'possible');
    assert.equal(l.total_minor, undefined);
    assert.equal(b.citations.length, 0);
    const count = key === 'short' ? 2 : 1;
    expected = [`Partial: ${count} bank-text row${count === 1 ? '' : 's'} may be related, but no structured payee exactly matches. No vendor-spend figure is available.`,
      coverageLine(), ...(!baseline && key === 'short' ? [ambiguity] : []), posted].join('\n');
  } else {
    assert.ok(['embedded', 'alias-boundary'].includes(key));
    assert.equal(l.match_basis, 'none');
    assert.equal(l.total_minor, null);
    assert.equal(b.citations.length, 0);
    const vendor = key === 'embedded' ? 'Vendorwave' : 'Google';
    const names = key === 'embedded' ? ['Vendorwaveworks', 'Supervendorwave Cloud'] : ['Googlet *Cloud', 'Goog Kitchen'];
    assert.deepEqual(l.closest_payees, baseline ? names : []);
    expected = [`Partial: No transactions were found for ${vendor} as exact vendor spend in the covered window, 2026-10-01 through 2026-10-31. Closest payee names in this window: ${names.join('; ')}.`, coverageLine(0), posted].join('\n');
  }
  if (!baseline && key.startsWith('short')) {
    assert.equal(l.family_ambiguous, true);
    assert.deepEqual(l.family_candidates, ['Cloud Cafe', 'Cloud Parts']);
  }
  if (!baseline) {
    const history = reviewedPlainCopy(coverageLine(spec?.groups.length ? 1 : key === 'embedded' || key === 'alias-boundary' ? 0 : 1, spec?.partial));
    const suggestion = 'Want me to show your account balances?';
    let refusal;
    if (spec?.possible || key === 'short-exact') {
      const vendor = spec ? 'Vendorwave' : 'Cloud';
      refusal = `Here is a partial view for "${vendor}": the bank names ${spec ? 'these payees' : 'it'} on charges totaling ${spec ? '$12.01' : '$5.01'} ${spec ? refs(spec.groups.length) : '[1]'}; another ${spec ? '$99.00 [2]' : '$40.00 [2] [3]'} only mentions it in the transaction text. These amounts stay separate, with no complete store total confirmed.\n${suggestion}`;
    } else if (spec?.partial) {
      refusal = `Partial view using 2 of 3 accounts for October. Covered accounts: Operating account (your account ending 3131); Owned loan (your account ending 4242). Omitted accounts: Reserve account (your account ending 5353); their bank history does not include every requested date. This is not a total for all requested accounts.\nHere is a partial subtotal for "Vendorwave": the charges I can use total $70.00 in October; 1 account is missing some dates: your account ending 5353 ${refs(spec.groups.length)}.\n${suggestion}`;
    } else if (key === 'short' || key === 'bank-only') {
      const count = key === 'short' ? 2 : 1, vendor = key === 'short' ? 'Cloud' : 'Vendorwave';
      refusal = `I found ${count} transaction${count === 1 ? ' mentioning' : 's mentioning'} "${vendor}", but the bank did not name it as the payee, so no store total is confirmed.\n${suggestion}`;
    } else if (key === 'embedded' || key === 'alias-boundary') {
      const vendor = key === 'embedded' ? 'Vendorwave' : 'Google';
      const names = key === 'embedded' ? 'Vendorwaveworks; Supervendorwave Cloud' : 'Googlet *Cloud; Goog Kitchen';
      const next = key === 'embedded' ? 'Vendorwaveworks' : 'Goog Kitchen';
      refusal = `I checked October, but no payee exactly matched "${vendor}", so no store total is confirmed. Closest payee names: ${names}.\n${next ? `Want me to check spending at ${next} in October?` : suggestion}`;
    }
    if (refusal) {
      const groups = spec ? [
        ...spec.groups.map(([, name, cents], i) => `${name}: ${formatMinor(String(cents))} across 1 row [${i + 1}].`),
        `Included payees: ${spec.groups.map(g => g[1]).join('; ')}.`,
      ] : [];
      expected = [refusal, ...groups, history, ...(key.startsWith('short') ? [ambiguity] : []), reviewedPlainCopy(posted)].join('\n');
    } else expected = reviewedPlainCopy(expected);
    const chosen = key === 'embedded' ? 'Want me to check spending at Vendorwaveworks in October?'
      : key === 'alias-boundary' ? 'Want me to check spending at Goog Kitchen in October?' : suggestion;
    expected = reviewedFinalOffer(expected, chosen);
    if (key === 'embedded' || key === 'alias-boundary') expected = `No charges found for ${key === 'embedded' ? 'Vendorwave' : 'Google'} from 2026-10-01 to 2026-10-31 on your account ending 3131, your account ending 4242, your account ending 5353.`;
    assert.doesNotMatch(absenceLintText(b.answer), MONEY_JARGON, 'every family line passes the shared plain-refusal lint');
  }
  assert.deepEqual(displayFigures(b.answer).map(f => f.cents), displayFigures(expected).map(f => f.cents), 'every displayed cent value is independently specified');
  assert.equal(b.answer, expected, 'every factual line is reviewed');
  return { missing_family: 0, wrong_figures: 0, unsupported_claims: 0 };
}
