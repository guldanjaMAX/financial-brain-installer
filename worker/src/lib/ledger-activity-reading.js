import { readEffectiveTransactions } from './ledger-reader.js';
import { detectRecurring, loanCardPaymentKind, pairOwnTransfers, ordinaryMoneyMembership, sumMinor, selectVendorFamily, matchesCategory, normalizeLedgerText } from './ledger-analysis.js';
import { shiftLedgerDay } from './ledger-question.js';

const dollars = n => `$${(n / 100).toFixed(2)}`;

// These readings share the already resolved account denominator. Future feed
// coverage is never evidence of future cash; only historical patterns project.
export async function activityReading(env, intent, accounts, inventory, today) {
  const projection = intent.from > today;
  const pending = intent.pendingActivity;
  const from = projection ? shiftLedgerDay(today, -119) : intent.from || accounts.map(a => a.covered_from).filter(Boolean).sort()[0];
  const to = projection ? today : intent.to;
  let rows = [], readIncomplete = false;
  try {
    rows = await readEffectiveTransactions(env, inventory, { from, to, pendingOnly: Boolean(pending),
      effectiveAccountSlugs: accounts.map(a => a.account_slug) });
  } catch { readIncomplete = true; }
  // Deposit and payment intents carry payers separately from merchant matches.
  // Apply every selection before both arithmetic and evidence construction.
  const payer = intent.descriptionKeyword || intent.counterpartyText;
  if (payer) {
    const wanted = normalizeLedgerText(payer);
    rows = rows.filter(row => wanted && [row.payee, row.description].some(value =>
      ` ${normalizeLedgerText(value)} `.includes(` ${wanted} `)));
  }
  if (pending && intent.direction && intent.direction !== 'both') rows = rows.filter(row => row.direction === intent.direction);
  if (intent.match) rows = intent.kind === 'category' || intent.matchType === 'category'
    ? rows.filter(row => matchesCategory(row, intent.match)) : selectVendorFamily(rows, intent.match).matched;
  const coverage = { complete: false, accounts: accounts.map(a => ({ account_mask: a.mask,
    covered_from: a.covered_from, covered_to: a.covered_to, last_sync_at: a.last_synced_at })) };
  const period = intent.presentation.period(intent.from || from, intent.to);
  let selected = rows, patterns = [], total, label, leftOut = [], projectedIn = 0, projectedOut = 0;
  const bySlug = new Map(inventory.map(a => [a.account_slug, a]));
  if (projection) {
    const membership = ordinaryMoneyMembership(rows, pairOwnTransfers(rows, bySlug).pairs, bySlug);
    const payments = membership.ordinary.filter(r => loanCardPaymentKind(r, bySlug));
    leftOut = ['loan', 'card'].map(kind => ({ bucket: `${kind}_payment`,
      count: payments.filter(r => loanCardPaymentKind(r, bySlug) === kind).length,
      total_minor: sumMinor(payments.filter(r => loanCardPaymentKind(r, bySlug) === kind)) }));
    const eligible = membership.ordinary.filter(r => (intent.direction === 'both' || r.direction === intent.direction) && !membership.possible.has(r.id) && !loanCardPaymentKind(r, bySlug));
    // Cadence detection operates on positive amounts. Mirroring inflows here
    // reuses its interval/amount checks without changing the evidence rows.
    patterns = accounts.flatMap(a => ['inflow', 'outflow'].flatMap(direction => detectRecurring(eligible.filter(r =>
      r.effective_account_slug === a.account_slug && r.direction === direction)
      .map(r => ({ ...r, original_direction: r.direction, direction: 'outflow' })), today)
      .map(pattern => ({ ...pattern, direction }))));
    const days = (Date.parse(intent.to) - Date.parse(intent.from)) / 86400000 + 1;
    const project = direction => sumMinor(patterns.filter(p => p.direction === direction), p => Math.round(p.monthly_minor * days / 30.4375));
    projectedIn = project('inflow'); projectedOut = project('outflow');
    total = intent.direction === 'both' ? projectedIn - projectedOut : intent.direction === 'inflow' ? projectedIn : projectedOut;
    selected = patterns.flatMap(p => p.rows);
    const figure = intent.direction === 'both' ? `${dollars(projectedIn)} money in and ${dollars(projectedOut)} ordinary spending` : dollars(total);
    label = `Projection: about ${figure} for ${period}, based on repeating ${intent.direction === 'both' ? 'deposits and charges' : intent.direction === 'inflow' ? 'deposits' : 'charges'} in ${intent.presentation.period(from, to)}. ` +
      (patterns.length ? 'Likely only; timing and amounts can change.' : 'No repeating pattern was found in this history; this is a pattern-only estimate, not a prediction of no activity.');
  } else if (pending) {
    total = sumMinor(rows);
    label = `${readIncomplete ? 'At least ' : ''}${dollars(total)} pending across ${rows.length} items on your ${accounts.length} connected accounts; excluded from completed cash and spending.`;
  } else {
    selected = rows.filter(r => r.direction === 'outflow' && loanCardPaymentKind(r, bySlug) === 'loan');
    total = sumMinor(selected);
    label = `At least ${dollars(total)} in identifiable loan payments for ${period}. Principal and interest are not separated; unclassified payments may be missing.`;
  }
  const ledger = { kind: intent.kind, from: intent.from || from, to: intent.to, total_minor: total,
    ...(intent.kind === 'totals' ? { combined_inflow_minor: projectedIn, projected_outflow_minor: projectedOut } : {}), complete: false,
    projection, estimate: projection || readIncomplete, basis: { from, to, patterns }, coverage, left_out: leftOut,
    accounts: coverage.accounts, rows: selected.map(r => ({ id: r.id, posted_on: r.posted_on,
      amount_minor: r.amount_minor, direction: r.original_direction || r.direction })) };
  const history = accounts.map(a => `account ending ${a.mask || 'unknown'}: ${a.covered_from || 'start unavailable'} through ${a.covered_to || 'end unavailable'}, last sync ${a.last_synced_at || 'unavailable'}`).join('; ');
  return { mode: 'think', answer: `${label}${intent.openProjection ? ' For this open-ended request, I estimated through the end of the first projected month.' : ''}` + leftOut.filter(b => b.count).map(b => `\nHistorical ${b.bucket === 'loan_payment' ? 'loan' : 'card'} payments: ${dollars(b.total_minor)} across ${b.count} rows, kept out of this projection.`).join('') +
      `\nBank history: ${accounts.length} connected accounts; ${history}.` +
      (readIncomplete ? '\nThis is a partial estimate: transaction history could not be read completely. Try a shorter date range to fill the gap.' : ''),
    ledger, citations: [], results: [], gaps: readIncomplete ? [{ type: 'history_incomplete' }] : [], evidence_gate: { supported: true, complete: false } };
}
