// Entirely synthetic. Expected cents and event roles belong to the fixture,
// independently of the adapter, importer, classifier and answer renderer.
export const NOW = '2026-11-04T23:59:59.000Z';
export const epoch = day => Date.parse(`${day}T12:00:00Z`) / 1000;
export const decimal = cents => `${cents < 0 ? '-' : ''}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;
export function businessFeed() {
  const accounts = [
    { id: 'operating', name: 'Business Checking', conn_id: 'deposit-bank', currency: 'USD', balance: '28412.37', 'available-balance': '28101.12', 'balance-date': epoch('2026-11-04'), transactions: [] },
    { id: 'reserve', name: 'Business Savings', conn_id: 'deposit-bank', currency: 'USD', balance: '19005.20', 'balance-date': epoch('2026-11-04'), transactions: [] },
    { id: 'card', name: 'Business Credit Card', conn_id: 'credit-bank', currency: 'USD', balance: '-4521.09', 'balance-date': epoch('2026-11-04'), transactions: [] },
    { id: 'loan', name: 'Business Loan', conn_id: 'credit-bank', currency: 'USD', balance: '-32000.00', 'balance-date': epoch('2026-10-10'), transactions: [] },
  ];
  const events = [];
  function add(account, id, day, cents, role, description, payee) {
    const transaction = { id, posted: epoch(day), amount: decimal(cents), description,
      ...(payee ? { payee } : {}), transacted_at: epoch(day) - 3600, extra: { fixture_role: role } };
    accounts[account].transactions.push(transaction);
    events.push({ account: accounts[account].id, id, day, cents, role, description });
  }
  for (let dayIndex = 0; dayIndex < 90; dayIndex++) {
    const day = new Date(Date.parse('2026-08-07T00:00:00Z') + dayIndex * 86400000).toISOString().slice(0, 10);
    for (let row = 0; row < 16; row++) {
      const account = row % 5 === 0 ? 2 : 0;
      const incoming = account === 0 && row % 4 === 0;
      const cents = (incoming ? 1 : -1) * (1000 + dayIndex * 31 + row * 137);
      add(account, `regular-${dayIndex}-${row}`, day, cents, incoming ? 'receipt' : 'expense',
        row === 7 ? `POS / SUPPLIES | Δ\t${'packing material / '.repeat(40)}end` : incoming ? 'Customer settlement' : 'Operating purchase',
        row % 3 ? undefined : incoming ? 'Customer Group' : 'Supply Store');
    }
  }
  for (let n = 0; n < 48; n++) add(0, `extra-${n}`, `2026-10-${String(1 + n % 28).padStart(2, '0')}`, -(20000 + n * 101), 'expense', 'Equipment and supplies');
  add(0, 'transfer-out', '2026-10-15', -150000, 'transfer', 'Transfer to Business Savings');
  add(1, 'transfer-in', '2026-10-15', 150000, 'transfer', 'Transfer from Business Checking');
  add(0, 'card-payment-out', '2026-10-20', -85000, 'card_payment', 'Payment to Business Credit Card');
  add(2, 'card-payment-in', '2026-10-20', 85000, 'card_payment', 'PAYMENT THANK YOU');
  add(0, 'loan-payment-out', '2026-10-22', -50000, 'loan_payment', 'Payment to Business Loan');
  add(3, 'loan-payment-in', '2026-10-22', 50000, 'loan_payment', 'Payment from Business Checking');
  add(2, 'reversed-charge', '2026-10-12', -7999, 'expense', 'Supply Store charge', 'Supply Store');
  add(2, 'charge-reversal', '2026-10-13', 7999, 'refund', 'Supply Store reversal', 'Supply Store');
  add(0, 'refund', '2026-10-18', 12050, 'refund', 'Supply Store refund', 'Supply Store');
  add(0, 'target-payment', '2026-10-23', 123456, 'receipt', 'Customer invoice payment', 'Customer Group');
  add(0, 'posted-replacement', '2026-11-03', -4321, 'expense', 'Posted purchase', 'Supply Store');
  add(0, 'last-second', '2026-11-04', -10203, 'expense', 'Closing second purchase');
  accounts[0].transactions.at(-1).posted = Date.parse('2026-11-04T23:59:59Z') / 1000;
  const response = { connections: [
    { conn_id: 'deposit-bank', name: 'Deposit Institution', org_id: 'org-deposit' },
    { conn_id: 'credit-bank', name: 'Credit Institution', org_id: 'org-credit' },
  ], accounts, errlist: [] };
  const pending = structuredClone(response);
  pending.accounts[0].transactions = pending.accounts[0].transactions.filter(row => row.id !== 'posted-replacement');
  pending.accounts[0].transactions.push({ id: 'temporary-authorization', posted: 0, transacted_at: epoch('2026-11-02'), amount: '-43.21', description: 'Pending purchase', pending: true });
  const reauth = structuredClone(response);
  reauth.errlist = [{ code: 'con.auth', conn_id: 'credit-bank', msg: 'Reconnect the credit institution to resume updates.' }];
  const month = events.filter(row => row.day >= '2026-10-01' && row.day <= '2026-10-31');
  return { response, pending, reauth, events, oracle: {
    count: events.length,
    // Ledger debt balances are positive amounts owed; event deltas stay signed.
    balances: [2841237, 1900520, 452109, 3200000],
    credits: month.filter(row => row.cents > 0).reduce((sum, row) => sum + row.cents, 0),
    // Receipt/refund events are ordinary money in; owned movement legs stay in gross history.
    ordinaryCredits: month.filter(row => row.cents > 0 && ['receipt', 'refund'].includes(row.role))
      .reduce((sum, row) => sum + row.cents, 0),
    debits: -month.filter(row => row.cents < 0).reduce((sum, row) => sum + row.cents, 0),
    expenses: month.filter(row => row.cents < 0 && row.role === 'expense').sort((a, b) => a.cents - b.cents).slice(0, 5),
    payment: 123456,
  } };
}
