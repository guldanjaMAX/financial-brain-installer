// Authored before the candidate patch. Every amount is integer cents.
// Expected membership is fixture metadata, independent of product matching.
export const NOW = '2026-10-12T12:00:00.000Z';
const question = 'Could you retrieve Vendor Unit spending this month net of refunds?';
export const purchase = { id: 'purchase', cents: 12000, direction: 'outflow', date: '2026-10-05', payee: 'Vendor Unit', description: 'Posted purchase', oracle: 'purchase' };
export const refund = { id: 'refund', cents: 2000, direction: 'inflow', date: '2026-10-06', payee: 'Vendor Unit', description: 'Refund posted', oracle: 'refund' };
export const reply = (overrides = {}) => ({ kind: 'merchant', direction: 'outflow', vendor_text: 'Vendor Unit', period: { type: 'this_month' }, ...overrides });
export const cases = [
  { id: 'partial_refund', question, rows: [purchase, refund], expectedGross: 12000, expectedNet: 10000 },
  { id: 'full_refund', question, rows: [purchase, { ...refund, cents: 12000 }], expectedGross: 12000, expectedNet: 0 },
  { id: 'excess_refund', question, rows: [purchase, { ...refund, cents: 15000 }], expectedGross: 12000, expectedNet: -3000 },
  { id: 'two_purchases', question, rows: [purchase, { ...purchase, id: 'purchase_two' }, refund], expectedGross: 24000, expectedNet: 22000 },
  { id: 'duplicate_identity', question, rows: [purchase, refund], duplicate: true, expectedGross: 12000, expectedNet: 10000 },
  { id: 'outside_period', question, rows: [purchase, { ...refund, date: '2026-09-30', oracle: 'outside' }], expectedGross: 12000, expectedNet: 12000 },
  { id: 'future_refund', question, rows: [purchase, { ...refund, date: '2026-10-13', oracle: 'outside' }], expectedGross: 12000, expectedNet: 12000 },
  { id: 'other_vendor_refund', question, rows: [purchase, { ...refund, payee: 'Other Unit', oracle: 'outside' }], expectedGross: 12000, expectedNet: 12000 },
  { id: 'same_family_refund', question, rows: [purchase, { ...refund, payee: 'Vendor Unit Market', oracle: 'outside' }], expectedGross: 12000, expectedNet: 12000 },
  { id: 'refund_word_outflow', question, citationOrder: ['refund', 'purchase'], rows: [purchase, { ...refund, direction: 'outflow', oracle: 'purchase' }], expectedGross: 14000, expectedNet: 14000 },
  { id: 'ordinary_inflow', question, rows: [purchase, { ...refund, description: 'Payment posted', oracle: 'outside' }], expectedGross: 12000, expectedNet: 12000 },
  { id: 'gross_control', question: 'Could you retrieve gross Vendor Unit spending this month?', rows: [purchase, refund], grossRequest: true, expectedGross: 12000, expectedNet: 10000 },
  { id: 'no_refund_control', question: 'Could you retrieve Vendor Unit spending this month?', rows: [purchase], grossRequest: true, expectedGross: 12000, expectedNet: 12000 },
  { id: 'net_no_refund', question, rows: [purchase], expectedGross: 12000, expectedNet: 12000 },
  { id: 'after_refunds', question: 'Could you retrieve Vendor Unit spending this month after refunds?', rows: [purchase, refund], expectedGross: 12000, expectedNet: 10000 },
  { id: 'refunds_netted', question: 'Could you retrieve Vendor Unit spending this month once refunds are netted out?', rows: [purchase, refund], expectedGross: 12000, expectedNet: 10000 },
  { id: 'totals_alias', question, rows: [purchase, refund], intents: [reply({ kind: 'totals' })], expectedGross: 12000, expectedNet: 10000 },
  { id: 'expense_alias', question, rows: [purchase, refund], intents: [reply({ kind: 'expense_summary' })], expectedGross: 12000, expectedNet: 10000 },
  { id: 'missing_account_kind', question, rows: [purchase, refund], missingAccountKind: true, expectedGross: 12000, expectedNet: 10000 },
  { id: 'mixed_currency', question, rows: [purchase, refund], mixedCurrency: true, terminal: 'currency' },
  { id: 'mixed_row_currency', question, rows: [purchase, refund], mixedRowCurrency: true, terminal: 'currency' },
  { id: 'missing_model_kind', question, rows: [purchase, refund], malformed: 'missing_kind', terminal: 'router' },
  { id: 'unknown_model_field', question, rows: [purchase, refund], malformed: 'extra_field', terminal: 'router' },
  { id: 'wrong_model_direction', question, rows: [purchase, refund], malformed: 'invalid_direction', terminal: 'router' },
  { id: 'nonliteral_vendor', question, rows: [purchase, refund], malformed: 'nonliteral', terminal: 'router' },
  { id: 'inflow_reading', question: 'Could you retrieve Vendor Unit money in this month net of refunds?', rows: [purchase, refund], intents: [reply({ direction: 'inflow' })], inflow: true },
  { id: 'two_periods', question: 'Could you compare Vendor Unit spending this month versus last month net of refunds?',
    rows: [purchase, refund, { ...purchase, id: 'prior_purchase', cents: 9000, date: '2026-09-05', oracle: 'prior_purchase' },
      { ...refund, id: 'prior_refund', cents: 1000, date: '2026-09-06', oracle: 'prior_refund' }],
    intents: [reply(), reply({ period: { type: 'last_month' } })], twoPeriods: true },
  { id: 'own_transfer_excluded', question: 'Could you retrieve Vendor Unit spending in checking this month net of refunds?', intents: [reply({ account_hint: 'checking' })], rows: [purchase, refund], ownTransfer: true, expectedGross: 12000, expectedNet: 10000 },
];
export function recount(c) {
  const sum = kind => c.rows.filter(r => r.oracle === kind).reduce((n, r) => n + BigInt(r.cents), 0n);
  return { gross: Number(sum('purchase')), refunds: Number(sum('refund')), net: Number(sum('purchase') - sum('refund')),
    priorGross: Number(sum('prior_purchase')), priorNet: Number(sum('prior_purchase') - sum('prior_refund')) };
}
