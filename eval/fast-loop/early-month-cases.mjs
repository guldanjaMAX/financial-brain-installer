import { BASE_CASES, evidence } from '../../test/fixtures/fastloop-money/input.mjs';

// Development inputs only. Each clock is frozen in the owner's calendar.
const make = (id, day, { current = false, question = 'What are my expenses?', ...extra } = {}) => ({
  ...BASE_CASES[0], id: `early/${id}`, base: false, family: 'early-month',
  question, clock: { now_utc: `2026-10-${day}T19:00:00Z`, owner_time_zone: 'America/Phoenix' },
  period: { rule: 'owner calendar month to date', from: '2026-10-01', to: `2026-10-${day}` },
  period_id: 'MTD', current, ...extra,
});
export const cases = [
  make('first-empty', '01', { previous: true }),
  make('first-posted', '01', { current: true, previous: true }),
  make('current-unavailable', '01', { previous: true, currentUnavailable: true,
    clock: { now_utc: '2026-10-01T07:30:00Z', owner_time_zone: 'America/Phoenix' } }),
  make('current-covered-control', '01', { previous: true, coveredTo: '2026-10-01',
    clock: { now_utc: '2026-10-01T07:30:00Z', owner_time_zone: 'America/Phoenix' } }),
  make('previous-explicit-control', '01', { question: 'What were my expenses last month?',
    previous: false, currentUnavailable: true,
    clock: { now_utc: '2026-10-01T07:30:00Z', owner_time_zone: 'America/Phoenix' } }),
  make('second-posted', '02', { current: true, previous: true }),
  make('third-posted', '03', { current: true, previous: true }),
  make('fourth-posted', '04', { current: true, previous: false }),
  make('middle-empty', '15', { previous: true }),
  make('middle-posted', '15', { current: true, previous: false }),
  make('local-boundary-empty', '31', { previous: true,
    clock: { now_utc: '2026-11-01T02:00:00Z', owner_time_zone: 'America/Phoenix' } }),
  make('explicit-month', '01', { question: 'What did I spend this month, and on what?', previous: false }),
  make('explicit-last-month', '01', { question: 'What were my expenses last month?', previous: false }),
  make('explicit-named-month', '01', { question: 'What were my expenses in September 2026?', previous: false }),
  make('gross', '01', { question: 'How much money came in and went out this month?', previous: false }),
  make('merchant', '01', { question: 'How much did I spend at Store One this month?', previous: false }),
  make('bare-spend', '02', { question: 'What did I spend, and on what?', current: true, previous: true }),
  make('previous-partial', '01', { previous: true, coverage: 'partial' }),
  make('previous-unavailable', '01', { previous: true, coverage: 'unavailable' }),
  make('unknown-classification', '02', { previous: true, unknown: true }),
  make('middle-repayment-only', '15', { previous: true, repaymentOnly: true }),
  make('middle-inflow-only', '15', { previous: true, inflowOnly: true }),
];

export function snapshotFor(c) {
  const snapshot = evidence();
  const row = (id, date, cents, payee, extra = {}) => ({ id, uid: `early-${id}`, account: 'cash',
    date, cents: String(cents), direction: 'outflow', payee, description: payee, pending: 0, ...extra });
  snapshot.rows = [
    row(1, '2026-09-01', 12345, 'Store One'),
    row(2, '2026-09-30', 6789, 'Store Two'),
    row(3, '2026-09-20', 40000, 'payment', { description: 'payment to account 4242' }),
    row(4, '2026-09-21', 40000, 'Outside Lender'),
    row(5, '2026-09-15', 5000, null, { description: 'TRANSFER TO account 5353' }),
    row(6, '2026-09-16', 5000, null, { account: 'reserve', direction: 'inflow', description: 'TRANSFER FROM account 3131' }),
    row(7, '2026-09-30', 99999, 'Pending Store', { pending: 1 }),
    row(8, '2026-10-01', 777, 'Pending Store', { pending: 1 }),
    row(9, '2026-11-01', 88888, 'Future Store'),
    row(10, '2026-08-31', 55555, 'Earlier Store'),
    ...(c.current ? [row(11, '2026-10-01', 1234, 'Current Store')] : []),
    ...(c.repaymentOnly ? [row(12, '2026-10-01', 22222, 'payment', { description: 'payment to account 4242' })] : []),
    ...(c.inflowOnly ? [row(13, '2026-10-01', 33333, 'Payer Unit', { direction: 'inflow' })] : []),
  ];
  if (c.coverage === 'partial') snapshot.accounts.find(a => a.slug === 'debt').from = '2026-10-01';
  if (c.coverage === 'unavailable') snapshot.accounts.forEach(a => { a.from = '2026-10-01'; });
  if (c.currentUnavailable || c.coveredTo) snapshot.accounts.forEach(a => { a.to = c.coveredTo || '2026-09-30'; });
  if (c.unknown) Object.assign(snapshot.accounts.find(a => a.slug === 'debt'), { kind: 'other', role: 'neither' });
  return snapshot;
}
