// Separate fact custodian. Membership is authored here, never learned from product output.
import { sumRows, total } from '../../../eval/fast-loop/money-oracle.mjs';
export const GOLD_VERSION = 'money-batch1-gold-v5';
const facts = {
  1: { cents: '6000' }, 2: { cents: '5000' }, 3: { cents: '4000' },
  4: { cents: '3000' }, 5: { cents: '2000' }, 6: { cents: '1000' },
  7: { cents: '40000', truth: 'whole owned-liability payment; split unknown' },
  8: { cents: '40000', truth: 'outside payment; equal amount is irrelevant to ownership' },
  9: { cents: '17777' }, 10: { cents: '2222' }, 11: { cents: '3333' },
  12: { cents: '900001', truth: 'pending, excluded from posted arithmetic' },
  13: { cents: '700003', truth: 'future posting, excluded' },
  14: { cents: '10011' }, 15: { cents: '22222' }, 16: { cents: '30033' },
  17: { cents: '12345', truth: 'source uncertain; scoped receipt, never proved income' },
  18: { cents: '99117', truth: 'outside previous month' },
};
const ordinary = [1, 2, 3, 4, 5, 6, 8];
const common = { required_for_gate: true, gold_version: GOLD_VERSION, currency: 'USD',
  source: 'independently invented posted records and explicit coverage receipts',
  rounding: 'exact integer cents', forbidden: ['principal split', 'forecast as fact', 'global absence', 'pending zero'] };
const key = (contract, extra = {}) => ({ ...common, contract, answerability: 'full', ...extra });
const expense = extra => key('expense', { included: ordinary, excluded: [7, 12, 13],
  total: sumRows(facts, ordinary), repayment: '40000', repayment_ids: [7], groups: ordinary.map(id => ({ id, cents: facts[id].cents })), ...extra });
const balances = key('balance', { balances: [
  { mask: '3131', cents: '502345', kind: 'checking', role: 'asset' },
  { mask: '5353', cents: '200001', kind: 'savings', role: 'asset' },
  { mask: '4242', cents: '880000', kind: 'loan', role: 'liability' },
], observed: '2026-10-30' });
const receipts = { '3131': sumRows(facts, [14, 15]), '5353': sumRows(facts, [16, 17]), '4242': '0' };
export const GOLD = {
  M01: { ...balances, require_roles: true },
  M04: key('receipts', { receipts, combined: total(Object.values(receipts)), require_combined: true }),
  M05: expense({ require_posted_disclosure: true }),
  M06: expense({ classification_uncertain: true, answerability: 'clarify' }),
  M08: key('ranking', { ids: [8, 1, 2, 3, 4], cents: [8, 1, 2, 3, 4].map(id => facts[id].cents), excluded: [7, 12, 13],
    repayment: '40000', repayment_ids: [7], excluded_from_account_totals: [7],
    gross_ids: [8, 1, 2, 3, 4], gross_cents: [8, 1, 2, 3, 4].map(id => facts[id].cents) }),
  M09: key('transactions', { ids: [1, 2, 3, 4, 5, 6, 11, 9, 8, 7],
    cents: ['-6000', '-5000', '-4000', '-3000', '-2000', '-1000', '3333', '17777', '-40000', '-40000'],
    dates: ['2026-10-25', '2026-10-24', '2026-10-23', '2026-10-22', '2026-10-21', '2026-10-20',
      '2026-10-19', '2026-10-12', '2026-10-12', '2026-10-12'] }),
  M10: key('payment', { ids: [9], cents: ['17777'], from: '2026-10-05', to: '2026-10-19' }),
  M11: key('absence', { ids: [], scope: 'exact structured payee in September only' }),
  M12: { ...balances, contract: 'forecast', answerability: 'partial', require_withholding: true },
  M16: key('repayment', { repayment: '40000', repayment_ids: [7], total: sumRows(facts, ordinary), included: ordinary }),
  M17: key('vendor', { total: '40000', ids: [8], excluded_from_account_totals: [7] }),
  M20: key('coverage', { answerability: 'partial', complete: false,
    accounts: ['3131', '5353', '4242'], from: '2026-09-01', to: '2026-09-30' }),
  'M01/supported': balances,
  'M04/single': key('receipts', { receipts: { '3131': receipts['3131'] }, combined: receipts['3131'] }),
  'M05/supported': expense(),
  'M06/typed': expense(),
  'M08/no-repayment': key('ranking', { ids: [8, 1, 2, 3, 4], cents: [8, 1, 2, 3, 4].map(id => facts[id].cents) }),
  'M09/posted': null,
  'M10/on': null,
  'M11/exact': null,
  'M12/current': balances,
  'M16/separate': expense(),
  'M17/outside-only': key('vendor', { total: '40000', ids: [8] }),
  'M20/incomplete': key('refuse-coverage', { answerability: 'refuse', require_withholding: true }),
  'M20/covered-empty': expense({ included: [], excluded: [], total: '0', repayment: '0', repayment_ids: [], groups: [] }),
  'M06/memo': expense(),
  'M06/reset': expense({ classification_uncertain: true, answerability: 'clarify' }),
  'M05/shorthand': expense(),
  // An unpaired endpoint is possible ownership, not proof. Money out retains
  // this posting and must cite its uncertainty; spending still excludes it.
  'M05/gross': key('gross', { debits: '101000', credits: '23332', possible_payment_ids: [7],
    ordinary_totals: true, ordinary_display: false, ordinary_excluded: [], ordinary_debits: '101000' }),
};
for (const [child, base] of [['M09/posted', 'M09'], ['M10/on', 'M10'], ['M11/exact', 'M11']]) GOLD[child] = GOLD[base];
export function goldFor(id) {
  const result = GOLD[id];
  if (!result?.gold_version || !result.contract) throw Error('UNBOUND_GOLD');
  const obligations = {
    expense: ['expense-total', 'whole-repayment', 'expense-row-count', 'expense-evidence-membership', 'visible-expense-period'],
    repayment: ['expense-total', 'whole-repayment', 'expense-row-count', 'expense-evidence-membership', 'visible-expense-period'],
    ranking: ['eligible-ranking-before-limit', 'ranked-cents', 'period', 'displayed-ranking',
      ...(result.repayment ? ['whole-repayment', 'displayed-whole-repayment'] : [])],
    transactions: ['transaction-order', 'transaction-dates', 'posted-list-complete', 'transaction-heading-count', 'period'],
    balance: (result.balances || []).flatMap(b => [`balance:${b.mask}`, `balance-date:${b.mask}`]),
    forecast: ['withhold-future', ...(result.balances || []).flatMap(b => [`balance:${b.mask}`, `balance-date:${b.mask}`])],
    receipts: [...Object.keys(result.receipts || {}).map(mask => `receipts:${mask}`), 'period'],
    payment: ['exact-payment-row', 'arrival-window', 'positive-arrival'],
    absence: ['scoped-exact-absence', 'no-global-absence', 'period'],
    vendor: ['outside-payment-retained', 'outside-payment-row', 'vendor-exact', 'period'],
    gross: ['gross-outflow', 'gross-inflow', 'period'],
    coverage: ['coverage-cannot-be-complete', 'coverage-does-not-certify-zero', 'coverage-gap-disclosed'],
    'refuse-coverage': ['coverage-refusal-reached'],
  }[result.contract];
  if (!obligations?.length) throw Error('UNBOUND_OBLIGATIONS');
  if (result.require_posted_disclosure) obligations.push('posted-record-limitation');
  if (result.classification_uncertain) obligations.push('unknown-classification-is-not-complete');
  if (result.require_roles) obligations.push('cash-and-liability-roles');
  if (result.require_combined) obligations.push('combined-scoped-receipts');
  if (result.payment_exclusion_ids) obligations.push('payment-exclusions', 'payment-exclusions-disclosed');
  if (result.possible_payment_ids) obligations.push('possible-payment-membership', 'possible-payment-included-total', ...result.possible_payment_ids.map(id => `possible-payment-disclosed:${id}`));
  return structuredClone({ ...result, required_obligations: obligations, fact_weight: 1 });
}
