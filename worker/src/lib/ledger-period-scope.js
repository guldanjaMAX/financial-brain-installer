import { effectivePeriodCovered } from './ledger-reader.js';
import { moneyAccount } from './money-format.js';
import { ledgerDay, shiftLedgerDay } from './ledger-question.js';

// A current-through date cannot supply a missing start. Keep the original
// denominator beside the certified subset; unknown accounts are never empty.
export function periodAccountScope(accounts, { from, to }) {
  const covered = [], omitted = [];
  for (const account of accounts) {
    (effectivePeriodCovered(account, from, to) ? covered : omitted).push(account);
  }
  const publicAccount = account => ({
    account_mask: /^\d{1,4}$/.test(account.mask || '') ? account.mask : null,
    account_kind: account.account_kind,
    account_label: moneyAccount(account, { label: true }),
  });
  // Availability depends on certified accounts, never on transaction count.
  // An empty read over a nonempty covered subset is evidence for zero.
  return { requested: accounts, covered, omitted, available: covered.length > 0, coverage: {
    status: omitted.length ? 'partial' : 'full', complete: omitted.length === 0,
    candidate_account_count: accounts.length, covered_account_count: covered.length,
    omitted_account_count: omitted.length,
    included_accounts: covered.map(publicAccount),
    excluded_accounts: omitted.map(account => ({ ...publicAccount(account), reason: 'period_outside_coverage' })),
  } };
}

export function partialPeriodScopeLine(scope, intent) {
  return `Partial view using ${scope.covered.length} of ${scope.requested.length} accounts for ${intent.presentation.period(intent.from, intent.to)}. ` +
    `Covered accounts: ${scope.covered.map(account => moneyAccount(account, { label: true })).join('; ')}. ` +
    `Omitted accounts: ${scope.omitted.map(account => moneyAccount(account, { label: true })).join('; ')}; their bank history does not include every requested date. ` +
    'This is not a total for all requested accounts.';
}

// Review candidates retain their possible identity classification while the
// exact-payee lookup keeps its bounded, figure-free absence explanation.
export const isBoundedVendorAbsence = ledger => ledger?.match_basis === 'none' ||
  ledger?.possible_identity_count > 0 && ledger.row_count === 0;

export function labelPartialPeriodAnswer(result, scope, intent) {
  if (!result.ledger || !scope.omitted.length) return result;
  const ledger = result.ledger;
  ledger.complete = false;
  ledger.partial_reason = 'ledger_partial_coverage';
  ledger.complete_total_minor = null;
  ledger.coverage = { ...ledger.coverage, ...scope.coverage };
  if (ledger.if_own_transfers) ledger.if_own_transfers.complete = false;
  // Existing whole-selection aggregate keys cannot become subset figures.
  // Per-account rows retain their cents; the new keys name their limited scope.
  for (const [whole, subtotal] of [
    ['combined_inflow_minor', 'covered_inflow_subtotal_minor'],
    ['outside_inflow_minor', 'covered_outside_inflow_subtotal_minor'],
    ['net_minor', 'covered_net_minor'],
    ['monthly_total_minor', 'covered_monthly_estimate_minor'],
    ['lead_monthly_total_minor', 'covered_lead_monthly_estimate_minor'],
  ]) if (Object.hasOwn(ledger, whole)) { ledger[subtotal] = ledger[whole]; ledger[whole] = null; }
  // Bounded absence still needs visible disclosure of the omitted denominator.
  // Keep it figure-free, without the aggregate-total and repair padding.
  result.answer = isBoundedVendorAbsence(ledger)
    ? `${result.answer}\nOmitted accounts: ${scope.omitted.map(account => moneyAccount(account, { label: true })).join('; ')}; their bank history does not include every requested date.`
    : `${partialPeriodScopeLine(scope, intent)}\n${result.answer}`;
  if (intent.kind === 'largest') result.answer += '\nOmitted accounts may contain larger charges; this ranking is limited to the covered accounts.';
  if (intent.kind === 'recurring') result.answer += '\nThese repeated completed charges describe only the covered accounts; they do not establish all subscriptions or future obligations.';
  return result;
}

// Partition only at stored coverage boundaries, then ask the authoritative
// reader about each interval. MIN/MAX bounds alone would hide holes or twins.
export function labelObservedSpendingAnswer(result, scope, intent, money, topic) {
  const ledger = result.ledger;
  if (!ledger) return result;
  const missing = [], covered = [];
  const validDay = day => /^\d{4}-\d{2}-\d{2}$/.test(day || '') &&
    Number.isFinite(Date.parse(day)) && ledgerDay(day) === day;
  for (const account of scope.requested) {
    const after = shiftLedgerDay(intent.to, 1);
    const boundaries = [...new Set([intent.from, after, account.empty_provider_from,
      ...account.members.flatMap(member => [member.covered_from,
        validDay(member.covered_to) ? shiftLedgerDay(member.covered_to, 1) : null])]
      .filter(day => validDay(day) && day >= intent.from && day <= after))].sort();
    for (let i = 0; i < boundaries.length - 1; i++) {
      const from = boundaries[i], to = shiftLedgerDay(boundaries[i + 1], -1);
      const periods = effectivePeriodCovered(account, from, to) ? covered : missing;
      const previous = periods.at(-1);
      if (previous?.account === account && shiftLedgerDay(previous.to, 1) === from) previous.to = to;
      else periods.push({ account, from, to });
    }
  }
  const span = p => `${intent.presentation.date(p.from)} through ${intent.presentation.date(p.to)}`;
  const required = missing.map(p => `Original statements for ${moneyAccount(p.account)} covering ${span(p)}.`);
  // The shipped merchant renderer already moves its incomplete amount out of
  // total_minor. Preserve that exact subtotal without combining possible payees.
  const subtotal = ledger.total_minor ?? ledger.partial_subtotal_minor ?? ledger.confirmed_category_subtotal_minor;
  Object.assign(ledger, { observed_subtotal_minor: subtotal ?? null, total_minor: null, lead_total_minor: null,
    complete_total_minor: null, complete: false, partial_reason: 'ledger_partial_coverage', amount_basis: 'observed_lower_bound',
    coverage: { complete: false, status: 'partial',
      missing_periods: missing.map(p => ({ account_mask: /^\d{1,4}$/.test(p.account.mask || '') ? p.account.mask : null, from: p.from, to: p.to })),
      required_statements: required } });
  if (ledger.if_own_transfers) ledger.if_own_transfers.complete = false;
  const detail = `Missing dates: ${missing.map(p => `${moneyAccount(p.account)}, ${span(p)}`).join('; ')}. ` +
    'The additional dollar amount is unknown; a full-period total or zero is not established. ' + required.join(' ');
  const heading = Number.isSafeInteger(subtotal)
    ? `${money(subtotal)} observed subtotal (incomplete lower bound) for ${topic}, ${intent.presentation.period(intent.from, intent.to)}.`
    : `Observed spending for ${topic}, ${intent.presentation.period(intent.from, intent.to)}, remains incomplete; the readable spending details follow.`;
  result.answer = `${heading}\nRecorded coverage: ${covered.map(p => `${moneyAccount(p.account)}, ${span(p)}`).join('; ') || 'no dates certified complete'}.\n${detail}\n` +
    result.answer.replace(/Total money out/g, 'Observed money out');
  result.gaps = [...(result.gaps || []), { type: 'ledger_partial_coverage', reason: 'period_outside_coverage', detail }];
  return result;
}
