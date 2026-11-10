import { BASE_CASES, CLOCK, PERIODS, evidence } from '../../../test/fixtures/fastloop-money/input.mjs';

const make = (id, question, period = 'NOW') => ({ ...BASE_CASES[0], id, base: false,
  family: id.split('/')[0], question,
  period: id === 'D6/days' ? { rule: '90 owner calendar days, inclusive', from: '2026-08-03', to: '2026-10-31' }
    : id.startsWith('D8/') ? { rule: '120 owner calendar days for the existing detector', from: '2026-07-04', to: '2026-10-31' }
      : PERIODS[period], period_id: period, clock: CLOCK });
export const cases = [
  make('D5/bank', 'How much do I have in the bank right now?'),
  make('D5/have', 'How much do I have?'),
  make('D5/cash', 'How much cash do I have right now?'),
  make('D5/control', 'What are my account balances?'),
  make('D6/months', 'How much did I spend at Store One in the last 3 months?', 'THREE'),
  make('D6/days', 'How much did I spend at Store One in the past 90 days?', 'THREE'),
  make('D6/control', 'How much did I spend at Store One in October 2026?', 'MTD'),
  make('D7/amount', 'Did a payment of $177.77 come in around October 12, 2026?', 'AROUND'),
  make('D7/payer', 'Did the payment from Payer Unit come in around October 12, 2026?', 'AROUND'),
  make('D7/ambiguous', 'Did a payment of $177.77 from Payer Unit come in around October 12, 2026?', 'AROUND'),
  make('D7/control', 'Did the payment from Payer Unit arrive on October 12, 2026?', 'AROUND'),
  make('D8/monthly', 'What do I pay for every month?', 'MTD'),
  make('D8/control', 'Show my recurring charges.', 'MTD'),
  make('D9/combined', 'How much came in last month?', 'PREV'),
  make('D9/single', 'How much came in last month for account 3131?', 'PREV'),
  make('D9/control', 'How much money came in and went out last month?', 'PREV'),
  make('D10/forecast', 'What will my bank balance be next month?'),
  make('D10/control', 'What are my account balances?'),
  make('Q6/control', 'Show my last ten transactions.', 'RECENT'),
  make('gross/control', 'How much money came in and went out this month including transfers?', 'MTD'),
];
export function snapshotFor(c) {
  const snapshot = evidence(c.profile);
  if (c.id.startsWith('D8/')) {
    snapshot.rows = ['2026-08-10', '2026-09-10', '2026-10-10'].map((date, i) => ({
      id: i + 1, uid: `recurring-${i}`, account: 'cash', date, cents: '1201',
      direction: 'outflow', payee: 'Service Unit', description: 'Service Unit', pending: 0,
    }));
  }
  if (c.id === 'D7/ambiguous') snapshot.rows.push({ ...snapshot.rows[8], id: 30, uid: 'second-receipt', date: '2026-10-13' });
  return snapshot;
}

export const restoringMutants = [
  ['D5', 'D5/bank', 'ledger-question.js', 'if (balanceAlias || forecastSnapshot)', 'if (forecastSnapshot)'],
  ['D6', 'D6/months', 'ledger-question.js', '{ allowVendorWindow: true }', '{ allowVendorWindow: false }'],
  ['D7', 'D7/payer', 'ledger-question.js', 'if (around.length) claim("date", around[0]);', 'if (false) claim("date", around[0]);'],
  ['D8', 'D8/monthly', 'ledger-question.js', 'what do i pay for every month|', ''],
  ['D9', 'D9/combined', 'ledger-answer.js', 'if (intent.kind === "totals" && intent.inflowOnly)', 'if (false)'],
  ['D10', 'D10/forecast', 'ledger-question.js', 'if (balanceAlias || forecastSnapshot)', 'if (balanceAlias)'],
];
