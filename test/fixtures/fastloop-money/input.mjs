// Independently invented evidence. No expected answers enter the replay process.
export const CLOCK = Object.freeze({ now_utc: '2026-10-31T19:00:00Z', owner_time_zone: 'America/Phoenix' });
export const PERIODS = Object.freeze({
  NOW: { rule: 'latest observed, never live', from: null, to: '2026-10-31' },
  MTD: { rule: 'owner month start through today, inclusive', from: '2026-10-01', to: '2026-10-31' },
  NONE: { rule: 'visible owner month default', from: '2026-10-01', to: '2026-10-31' },
  PREV: { rule: 'previous complete owner month', from: '2026-09-01', to: '2026-09-30' },
  RECENT: { rule: 'posted at/before today; date then integer row id descending', from: '2026-07-01', to: '2026-10-31' },
  AROUND: { rule: 'anchor minus/plus seven calendar days, inclusive', from: '2026-10-05', to: '2026-10-19' },
  DAY: { rule: 'named owner day', from: '2026-10-12', to: '2026-10-12' },
  FUTURE: { rule: 'withhold forecast; current observations are separate', from: '2026-11-01', to: '2026-11-30' },
  THREE: { rule: 'trailing calendar months with month-end clamping', from: '2026-07-31', to: '2026-10-31' },
});

const row = (id, date, cents, direction, payee, description = payee, account = 'cash', extra = {}) =>
  ({ id, uid: `synthetic-${id}`, account, date, cents: String(cents), direction, payee, description, pending: 0, ...extra });
export function evidence(profile = 'typed', accountReviews = []) {
  const accounts = [
    { slug: 'cash', mask: '3131', kind: 'checking', role: 'asset', label: 'Operating account', balance: '502345' },
    { slug: 'reserve', mask: '5353', kind: 'savings', role: 'asset', label: 'Reserve account', balance: '200001' },
    { slug: 'debt', mask: '4242', kind: 'loan', role: 'liability', label: 'Owned loan', balance: '880000' },
  ].map(a => ({ ...a, currency: 'USD', observed: '2026-10-30', coverage: 'complete',
    from: '2026-07-01', to: '2026-11-07' }));
  const rows = [
    row(1, '2026-10-25', 6000, 'outflow', 'Store One'),
    row(2, '2026-10-24', 5000, 'outflow', 'Store Two'),
    row(3, '2026-10-23', 4000, 'outflow', 'Store Three'),
    row(4, '2026-10-22', 3000, 'outflow', 'Store Four'),
    row(5, '2026-10-21', 2000, 'outflow', 'Store Five'),
    row(6, '2026-10-20', 1000, 'outflow', 'Store Six'),
    row(7, '2026-10-12', 40000, 'outflow', 'payment', 'payment to account 4242'),
    row(8, '2026-10-12', 40000, 'outflow', 'Outside Lender', 'payment to outside lender'),
    row(9, '2026-10-12', 17777, 'inflow', 'Payer Unit'),
    row(10, '2026-10-05', 2222, 'inflow', 'Payer Boundary'),
    row(11, '2026-10-19', 3333, 'inflow', 'Payer Boundary'),
    row(12, '2026-10-31', 900001, 'outflow', 'Pending Store', 'pending charge', 'cash', { pending: 1 }),
    row(13, '2026-11-01', 700003, 'outflow', 'Future Store'),
    row(14, '2026-09-01', 10011, 'inflow', 'Payer Start'),
    row(15, '2026-09-30', 22222, 'inflow', 'Payer End'),
    row(16, '2026-09-15', 30033, 'inflow', 'Payer Reserve', 'receipt', 'reserve'),
    row(17, '2026-09-16', 12345, 'inflow', 'Investment Label', 'unclassified credit', 'reserve'),
    row(18, '2026-08-31', 99117, 'inflow', 'Payer Outside Period'),
  ];
  if (profile === 'other') Object.assign(accounts[2], { kind: 'other', role: 'neither' });
  if (profile === 'memo') rows[6].description = 'payment to acct no. xxxx4242';
  if (profile === 'partial' || profile === 'empty-partial') accounts.forEach(a => { a.coverage = 'partial'; });
  const selectedRows = profile.startsWith('empty') ? [] : rows.filter(r =>
    !(profile === 'no-repayment' && r.id === 7) && !(profile === 'no-pending' && r.pending) &&
    !(profile === 'outside-only' && r.id !== 8));
  return { schema: 1, scope: 'synthetic-owned-inventory', accounts, rows: selectedRows,
    reset_import: profile === 'reset' ? { account: 'debt', kind: 'other', role: 'neither' } : null,
    ...(accountReviews.length ? { account_reviews: accountReviews } : {}) };
}

const make = (id, question, period, profile = 'typed', base = true) => ({
  schema: 1, id, base, family: id.split('/')[0], category: 'money', privacy: 'synthetic', split: 'development',
  bank_version: 'money-day1-v1', clock: CLOCK, period: PERIODS[period], period_id: period,
  question, profile, principal: { kind: 'owner', all: true }, required_for_gate: true,
});
export const BASE_CASES = [
  make('M01', 'How much money is in my bank right now?', 'NOW'),
  make('M04', 'How much money came in last month?', 'PREV'),
  make('M05', 'How much have I spent this month?', 'MTD'),
  make('M06', 'What are my expenses?', 'NONE', 'other'),
  make('M08', 'What were my five biggest expenses this month?', 'MTD'),
  make('M09', 'Show my last ten transactions.', 'RECENT'),
  make('M10', 'Did the payment from Payer Unit come in around October 12, 2026?', 'AROUND'),
  make('M11', 'Did I spend anything at Absent Store last month?', 'PREV'),
  make('M12', 'What will my bank balance be next month?', 'FUTURE'),
  make('M16', 'Was this loan payment an expense?', 'DAY'),
  make('M17', 'How much did I pay to Outside Lender this month?', 'MTD'),
  make('M20', 'Is anything missing from my bank records for last month?', 'PREV', 'partial'),
];
export const CONTROLS = [
  make('M01/supported', 'What are my account balances?', 'NOW'),
  make('M04/single', 'How much money came in last month for account 3131?', 'PREV'),
  make('M05/supported', 'What is my spending this month?', 'MTD', 'no-pending'),
  make('M06/typed', 'What are my expenses?', 'NONE'),
  make('M08/no-repayment', 'What were my five biggest expenses this month?', 'MTD', 'no-repayment'),
  make('M09/posted', 'Show my last ten transactions.', 'RECENT', 'no-pending'),
  make('M10/on', 'Did the payment from Payer Unit arrive on October 12, 2026?', 'AROUND'),
  make('M11/exact', 'How much did I spend at Absent Store last month?', 'PREV'),
  make('M12/current', 'What are my account balances?', 'NOW'),
  make('M16/separate', 'What are my expenses?', 'NONE'),
  make('M17/outside-only', 'How much did I pay to Outside Lender this month?', 'MTD', 'outside-only'),
  make('M20/incomplete', 'What were my expenses last month?', 'PREV', 'empty-partial'),
  make('M20/covered-empty', 'What were my expenses last month?', 'PREV', 'empty'),
  make('M06/memo', 'What are my expenses?', 'NONE', 'memo'),
  make('M06/reset', 'What are my expenses?', 'NONE', 'reset'),
  make('M05/shorthand', 'Spend this month', 'MTD'),
  make('M05/gross', 'How much money came in and went out this month?', 'MTD'),
].map(c => ({ ...c, base: false }));

export function validateInputs(cases) {
  if (!Array.isArray(cases) || !cases.length || new Set(cases.map(c => c.id)).size !== cases.length) throw Error('INVALID_CASE_SET');
  for (const c of cases) {
    if (c.account_reviews !== undefined && (!Array.isArray(c.account_reviews) || c.account_reviews.length > 200 ||
      c.account_reviews.some(r => !r || typeof r.account !== 'string' ||
        !['checking','savings','card','loan','line_of_credit','other'].includes(r.kind)))) throw Error('INVALID_ACCOUNT_REVIEWS');
    if (c.schema !== 1 || c.privacy !== 'synthetic' || c.split !== 'development' || !c.question ||
      !c.period?.rule || !c.clock?.now_utc || !c.clock?.owner_time_zone || !c.principal?.all ||
      !c.required_for_gate || !c.bank_version || !['typed', 'other', 'memo', 'reset', 'partial', 'empty-partial',
        'empty', 'no-pending', 'no-repayment', 'outside-only'].includes(c.profile)) throw Error('INVALID_CASE');
    new Intl.DateTimeFormat('en-US', { timeZone: c.clock.owner_time_zone }).format(new Date(c.clock.now_utc));
    if (c.period.from && c.period.from > c.period.to) throw Error('INVALID_PERIOD');
  }
  return cases;
}
