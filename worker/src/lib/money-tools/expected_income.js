import { DEFAULT_TENANT } from '../fin-d1.js';
import { readEffectiveAccounts, readEffectiveTransactions, readUncertainScopeAccounts, effectivePeriodCovered } from '../ledger-reader.js';
import { normalizeMerchantText, merchantMatchBasis, pairOwnTransfers, ordinaryMoneyMembership, loanCardPaymentKind } from '../money-analysis.js';
import { day, dollars, add, total, occurrences, invoicePeriod, invoiceMonthCovered, recurringDeposits } from './_expected-income-helpers.js';
import { moneyCoverage, moneyCoverageLine } from './_coverage-helpers.js';
export { proposeExpectations } from './_expected-income-helpers.js';

export const spec = {
  name: 'expected_income',
  description: 'Actual deposits, owner-confirmed expectations and likely repeating deposits, with source evidence. Call money_overview first. USD only. Expectations are never cash.',
  input_schema: { type: 'object', additionalProperties: false, required: ['from', 'to'],
    properties: { from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' } } },
};

export async function run(env, args = {}) {
  const { from, to } = args;
  const result = { ok: true, tool: spec.name, id: crypto.randomUUID(), range: { from, to, words: '' },
    figures: { already_in_minor: 0, likely_remaining_minor: 0, likely_total_minor: 0 }, rows: [], left_out: [],
    expectations: [], recurring_income: [], paying_without_contract: [],
    coverage: { accounts: [], missing: [], partial_through: null }, say: [] };
  if (!day(from) || !day(to) || from > to || Number(to.slice(0, 4)) - Number(from.slice(0, 4)) > 10) {
    result.coverage.missing.push('Use an exact date range of at most ten years for this calculation.');
    result.figures = { already_in_minor: null, likely_remaining_minor: null, likely_total_minor: null };
    result.say.push('I couldn’t verify this date range. Actual deposits and contract expectations remain separate; money_overview can show the available dates.');
    result.say.push(moneyCoverageLine(result.coverage));
    return result;
  }
  const words = d => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
  result.range.words = `${words(from)}–${words(to)}`;
  const historyStart = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  historyStart.setUTCMonth(historyStart.getUTCMonth() - 3);
  const historyFrom = historyStart.toISOString().slice(0, 10);
  let accounts = [], transactions = [], historicalTransactions = [], pending = [], expectations = [];
  let accountsUnavailable = false, expectationsUnavailable = false;
  const readAccounts = new Set();
  try {
    accounts = await readEffectiveAccounts(env);
    for (const a of await readUncertainScopeAccounts(env)) result.coverage.missing.push(`Account ending ${a.mask || 'unknown'} needs owner membership review.`);
    const eligible = [];
    for (const a of accounts) {
      if (a.ambiguous || a.linkRequired || a.currency !== 'USD' || a.basis_state !== 'confirmed') {
        result.coverage.missing.push(`Account ending ${a.mask || 'unknown'} needs feed or currency review.`); continue;
      }
      eligible.push(a);
    }
    const readView = async (pendingOnly, readFrom = from, readTo = to, history = false) => {
      if (!eligible.length) return [];
      try {
        // Prefer the reader's atomic cross-account snapshot. Apart from avoiding
        // needless D1 calls, this keeps transfer counterparts in the same cut.
        const rows = await readEffectiveTransactions(env, accounts, { from: readFrom, to: readTo, pendingOnly,
          effectiveAccountSlugs: eligible.map(a => a.account_slug) });
        if (!pendingOnly && !history) for (const a of eligible) readAccounts.add(a.account_slug);
        return rows;
      } catch {
        // A guarded account must not stop useful figures from the other accounts.
        result.coverage.missing.push(`${history ? 'Repeating deposit history' : pendingOnly ? 'Pending payments' : 'Deposits'} needed separate account reads; activity may have changed between reads.`);
      }
      const found = [];
      for (const a of eligible) {
        if (found.length >= 5000) { result.coverage.missing.push('More payments remain beyond the 5,000-row view.'); break; }
        try {
          const rows = await readEffectiveTransactions(env, accounts, { from: readFrom, to: readTo, pendingOnly, effectiveAccountSlugs: [a.account_slug] });
          const room = 5000 - found.length;
          found.push(...rows.slice(0, room));
          if (!pendingOnly && !history) readAccounts.add(a.account_slug);
          if (rows.length > room) result.coverage.missing.push(`Account ending ${a.mask || 'unknown'} has more payments beyond this partial view.`);
        } catch { result.coverage.missing.push(`Account ending ${a.mask || 'unknown'} could not be read completely.`); }
      }
      return found;
    };
    transactions = await readView(false);
    pending = await readView(true);
    // Optional pattern history has its own row budget. Its overflow must never
    // erase independently readable cash in the owner's requested dates.
    const historyTo = new Date(Date.parse(from) - 86400000).toISOString().slice(0, 10);
    historicalTransactions = (await readView(false, historyFrom, historyTo, true))
      .filter(row => day(row.posted_on) && row.posted_on < from);
  } catch (error) {
    accountsUnavailable = true;
    accounts = []; transactions = []; pending = [];
    // Reader bounds are partial coverage, not failed database calls.
    result.ok = /^ledger .*limit$/.test(error.message || '');
    result.coverage.missing.push('Account history could not be read completely; document expectations remain available.');
    result.say.push('I couldn’t verify deposits from this read. Try money_rows for a shorter range; the contract forecast is kept separate.');
  }
  try {
    const read = await env.DB.prepare(`SELECT * FROM fin_expectations WHERE tenant_id=? AND start_on<=?
      AND (end_on IS NULL OR end_on>=?) ORDER BY start_on,id LIMIT 1001`)
      .bind(env.BANK_FEED_TENANT || DEFAULT_TENANT, to, from).all();
    if (!Array.isArray(read?.results)) throw new Error('expectations read unavailable');
    expectations = read.results;
  } catch {
    result.ok = false;
    expectationsUnavailable = true;
    result.coverage.missing.push('The contract database read did not finish; actual deposits remain available.');
    result.say.push('I couldn’t verify the contract forecast. Try expected_income again after checking the Brain connection.');
  }
  const contractsPartial = expectations.length > 1000;
  if (contractsPartial) {
    expectations = expectations.slice(0, 1000);
    result.coverage.missing.push('More than 1,000 contracts overlap these dates; likely income is partial.');
  }
  const accountMap = new Map(accounts.map(a => [a.account_slug, a]));
  const posted = [...historicalTransactions, ...transactions];
  const membership = ordinaryMoneyMembership(posted, pairOwnTransfers(posted, accountMap).pairs, accountMap, {});
  const excluded = new Map();
  const history = [];
  const omit = (row, bucket) => {
    if (!excluded.has(bucket)) excluded.set(bucket, []);
    excluded.get(bucket).push(row);
  };
  for (const row of [...posted, ...pending]) {
    const a = accountMap.get(row.effective_account_slug);
    let bucket = 'income';
    if (pending.includes(row)) bucket = 'pending';
    else if (membership.excluded.has(row.id) || membership.possible.has(row.id)) bucket = 'own_transfer';
    else if (loanCardPaymentKind(row, accountMap)) bucket = `${loanCardPaymentKind(row, accountMap)}_payment`;
    else if (/\b(refund|reversal|chargeback|reimbursement)\b/i.test(`${row.category || ''} ${row.description || ''}`)) bucket = 'refund';
    else if (row.direction === 'inflow' && /\bpayout\b/i.test(`${row.category || ''} ${row.description || ''}`)) bucket = 'payout';
    else if (row.currency !== 'USD' || row.basis_state !== 'confirmed' || !day(row.posted_on) || row.export_overlap_review || !Number.isSafeInteger(row.amount_minor)) bucket = 'unverified';
    else if (row.direction !== 'inflow') bucket = 'expense';
    // A liability credit changes debt, not cash. Keep unexplained credits
    // visible without treating them as a client's received bank deposit.
    else if (a.balance_role !== 'asset') bucket = 'unverified';
    const shaped = { ...row, account_mask: a.mask, side: a.entity_kind === 'business' ? 'business' : 'personal', bucket };
    if (day(row.posted_on) && row.posted_on < from) {
      if (bucket === 'income') history.push(shaped);
      continue;
    }
    if (bucket === 'income') result.rows.push(shaped); else omit(shaped, bucket);
  }
  try {
    // Inventory is not evidence of a read. Empty successful reads count; skipped,
    // failed, pending-only and historical reads cannot certify current cash.
    const coveredAccounts = accounts.filter(a => readAccounts.has(a.account_slug));
    for (const a of coveredAccounts) {
      if (!effectivePeriodCovered(a, from, to)) result.coverage.missing.push(`Account ending ${a.mask || 'unknown'} has incomplete history for these dates.`);
    }
    result.coverage = moneyCoverage(coveredAccounts, transactions, { from, to, missing: result.coverage.missing });
    if (!accounts.length) result.coverage.missing.push('No connected owned accounts were available.');
    result.left_out = [...excluded].map(([bucket, rows]) => {
      const known = rows.filter(r => Number.isSafeInteger(r.amount_minor) && r.currency === 'USD');
      return { bucket, count: rows.length, unknown_count: rows.length - known.length,
        total_minor: known.length === rows.length ? total(known) : null, known_total_minor: total(known), rows };
    });
    const available = new Map(result.rows.map(r => [r.id, r.amount_minor]));
    const confirmedIdentities = new Set(expectations.filter(e => e.confirmed_by_owner).map(e => normalizeMerchantText(e.client)));
    const possibleName = (row, e) => merchantMatchBasis(row, e.client) === 'possible' ||
      merchantMatchBasis({ payee: e.client, direction: 'inflow' }, row.payee) === 'possible';
    // Shared bank-name words nominate a possible match, never authority to mark
    // a bill paid. Still deduct possible overlap from the lower likely total.
    const possibleNames = result.rows.filter(r => r.payee && !confirmedIdentities.has(normalizeMerchantText(r.payee)) &&
      expectations.some(e => e.confirmed_by_owner && possibleName(r, e)));
    let remaining = 0;
    const ambiguousExact = new Set();
    const obligations = expectations.flatMap(e => occurrences(e, from, to).map(due_on => ({ ...e, due_on })));
    obligations.sort((a, b) => a.due_on.localeCompare(b.due_on) || a.id.localeCompare(b.id));
    // Count once: the ten-year view can contain many weekly obligations.
    // Settlement checks must not rescan that entire inventory per deposit.
    const obligationCounts = new Map(), periodCounts = new Map(), monthCoverage = new Map();
    for (const e of obligations) {
      const identity = normalizeMerchantText(e.client);
      const month = e.due_on.slice(0, 7);
      const key = JSON.stringify([identity, month]);
      if (!monthCoverage.has(month)) monthCoverage.set(month, invoiceMonthCovered(month, from, to));
      obligationCounts.set(identity, (obligationCounts.get(identity) || 0) + 1);
      periodCounts.set(key, (periodCounts.get(key) || 0) + 1);
    }
    for (const e of obligations) {
      const identity = normalizeMerchantText(e.client);
      const matches = result.rows.filter(r => r.payee && normalizeMerchantText(r.payee) === identity);
      // Excluded inflows and refunds can conflict with a candidate payment.
      // Classification must consider them before allocating any ordinary cash.
      const uncertainDeposit = [...excluded].some(([bucket, rows]) => rows.some(r =>
        (bucket === 'unverified' || bucket === 'refund' || r.direction === 'inflow') &&
        (!r.payee || normalizeMerchantText(r.payee) === identity || possibleName(r, e))));
      let paid = 0;
      const deposits = [];
      if (e.confirmed_by_owner) for (const row of matches) {
        if (uncertainDeposit) { ambiguousExact.add(row); continue; }
        const period = invoicePeriod(row);
        if (period === false) { ambiguousExact.add(row); continue; }
        if (period && (period !== e.due_on.slice(0, 7) || !monthCoverage.get(period))) { ambiguousExact.add(row); continue; }
        if (!period && e.start_on < from) { ambiguousExact.add(row); continue; }
        // A deposit must identify one obligation as well as one payer. Month-only
        // evidence cannot choose among weekly dues or competing contracts.
        const competing = (period ? periodCounts.get(JSON.stringify([identity, period])) : obligationCounts.get(identity)) !== 1;
        if (competing) { ambiguousExact.add(row); continue; }
        // Multiple or oversized deposits cannot certify one obligation. Their
        // possible overlap remains in the forecast range instead.
        if (matches.length !== 1 || row.amount_minor > e.amount_minor) { ambiguousExact.add(row); continue; }
        const used = Math.min(available.get(row.id), e.amount_minor - paid);
        if (used > 0) { paid = add(paid, used); available.set(row.id, available.get(row.id) - used); deposits.push({ id: row.id, amount_minor: used }); }
      }
      const uncertain = result.coverage.missing.length || uncertainDeposit || matches.some(r => ambiguousExact.has(r)) ||
        possibleNames.some(r => possibleName(r, e)) || result.rows.some(r => !r.payee);
      const status = !e.confirmed_by_owner || uncertain ? "can't tell" :
        paid === e.amount_minor ? 'paid' : matches.length ? "can't tell" : 'not yet';
      const reason = !e.confirmed_by_owner ? 'The owner has not confirmed this expectation.' :
        uncertain ? 'The deposit evidence is mixed, unclear, for another period, or the account history is incomplete.' :
        status === 'paid' ? 'One exact matching deposit covers this expectation in the period.' :
        status === 'not yet' ? 'No matching deposit appears in the connected accounts for this period.' :
        'Only partial or multiple deposit evidence is available.';
      const likely = e.confirmed_by_owner ? e.amount_minor - paid : 0;
      remaining = add(remaining, likely);
      result.expectations.push({ ...e, status, reason, paid_minor: paid, remaining_minor: e.amount_minor - paid, deposits,
        matching_basis: 'Exact payer and invoice period where provided; continuing obligations without a stated period remain uncertain.' });
      result.say.push(`${e.confirmed_by_owner ? `${dollars(likely)} owner-confirmed expected` : `Unconfirmed proposal for ${dollars(e.amount_minor)}`} from ${e.client}, due ${e.due_on}, from ${e.source_title} dated ${e.source_date}; ${status}: ${reason}`);
    }
    result.recurring_income = recurringDeposits(history, result.rows, expectations, from, to, normalizeMerchantText, possibleName);
    for (const r of result.recurring_income) {
      remaining = add(remaining, r.remaining_minor);
      result.say.push(`${dollars(r.remaining_minor)} likely from ${r.payee}, ${r.pattern}; due around ${r.due_on}.`);
      if (r.possible_contract_overlap) result.say.push(`${r.payee} has a possible name overlap with a contract; this repeating deposit is shown separately because the payer identities are not confirmed to be the same.`);
    }
    const identities = new Set(expectations.map(e => normalizeMerchantText(e.client)));
    result.paying_without_contract = contractsPartial || expectationsUnavailable ? [] : result.rows.filter(r => r.payee && !possibleNames.includes(r) && !identities.has(normalizeMerchantText(r.payee)));
    if (result.paying_without_contract.length) result.coverage.missing.push('Some paying clients have no matching contract expectation; future payments beyond the shown repeating patterns are unknown.');
    if (!expectationsUnavailable && !expectations.some(e => e.confirmed_by_owner)) result.coverage.missing.push('No owner-confirmed contract expectations are on file for these dates; additional future payments are unknown.');
    result.possible_contract_matches = possibleNames;
    const cash = total(result.rows);
    // A deposit without a payer may already settle a contract. Deduct this
    // possible overlap from the forecast rather than count the same money twice.
    const unattributed = total(result.rows.filter(r => !r.payee));
    const uncertainNames = [...possibleNames, ...ambiguousExact];
    const possibleNamed = total(uncertainNames);
    const capacities = new Map(result.expectations.filter(e => e.confirmed_by_owner).map(e => [e, e.remaining_minor]));
    let namedOverlap = 0;
    // A possible name match can cover only that client's unfilled expectations.
    // It must not erase an unrelated client's forecast or reuse one deposit.
    result.possible_contract_matches = uncertainNames.map(row => {
      // Exact-payer ambiguity may coexist with a separately matched contract.
      // Only cash not already allocated can reduce another obligation's range.
      let credit = available.get(row.id);
      const possible_allocations = [];
      for (const [e, capacity] of capacities) {
        if (!credit || !capacity || !(possibleName(row, e) || ambiguousExact.has(row) && normalizeMerchantText(row.payee) === normalizeMerchantText(e.client)) ||
            invoicePeriod(row) && invoicePeriod(row) !== e.due_on.slice(0, 7)) continue;
        const used = Math.min(credit, capacity);
        credit -= used; capacities.set(e, capacity - used); namedOverlap = add(namedOverlap, used);
        possible_allocations.push({ expectation_id: e.id, due_on: e.due_on, amount_minor: used });
      }
      return { ...row, possible_allocations };
    });
    const overlap = add(namedOverlap, Math.min(unattributed, remaining - namedOverlap));
    const upper = add(cash, remaining);
    remaining -= overlap;
    result.figures = { already_in_minor: cash, likely_remaining_minor: remaining, likely_total_minor: add(cash, remaining),
      unattributed_deposits_minor: unattributed, possibly_matched_deposits_minor: possibleNamed, possible_named_overlap_minor: namedOverlap,
      possible_overlap_minor: overlap, likely_upper_minor: upper };
    if (overlap) {
      result.coverage.missing.push('Some deposits have no clear contract match, so their settlement is uncertain.');
      result.say.push(`${dollars(overlap)} of deposits have no clear contract match and may already cover these contracts; that amount was deducted from likely remaining income. The likely total could be ${dollars(upper)} if those deposits came from other payers.`);
    }
    if (accountsUnavailable) {
      result.figures.already_in_minor = null; result.figures.likely_total_minor = null; result.figures.likely_upper_minor = null;
      if (!expectationsUnavailable) result.say.unshift(`Likely ${dollars(remaining)} expected for ${result.range.words} from owner-confirmed contracts, before any deposits I couldn’t verify.`);
    } else if (expectationsUnavailable) result.say.unshift(`At least ${dollars(cash)} already in for ${result.range.words}; the contract forecast couldn’t be verified.`);
    else result.say.unshift(`Likely ${result.coverage.missing.length ? 'at least ' : ''}${dollars(add(cash, remaining))} for ${result.range.words} if everything comes in: ${dollars(cash)} already in, ${dollars(remaining)} still expected from owner-confirmed expectations and the repeating deposits listed below.`);
    if (expectationsUnavailable) {
      result.figures.likely_remaining_minor = null; result.figures.likely_total_minor = null; result.figures.likely_upper_minor = null;
    }
    if (obligations.length) result.say.push('Invoice periods distinguish earlier payments from current obligations. Payer identity without a period cannot prove settlement of a continuing expectation. Unconfirmed proposals are left out of likely income.');
    for (const b of result.left_out) result.say.push(`Left out: ${b.bucket.replaceAll('_', ' ')}, ${b.count} payments, ${b.total_minor === null ? `${dollars(b.known_total_minor)} with known amounts; other amounts could not be verified` : dollars(b.total_minor)}.`);
    for (const r of result.paying_without_contract) result.say.push(`${r.payee} paid ${dollars(r.amount_minor)}; no matching contract expectation for these dates is on file.`);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    result.figures = { already_in_minor: null, likely_remaining_minor: null, likely_total_minor: null };
    result.coverage.missing.push('The total exceeded exact integer arithmetic; individual rows remain available.');
    result.say.push('I couldn’t verify this total. The individual deposits and document expectations are still available; use a shorter date range to total them exactly.');
  }
  result.say.push(moneyCoverageLine(result.coverage) + ' Expected money is likely, never cash already received.');
  return result;
}
