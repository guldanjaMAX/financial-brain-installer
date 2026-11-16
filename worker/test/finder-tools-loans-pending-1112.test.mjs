import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { handleMcp } from '../src/lib/mcp-endpoint.js';
import { handleMoneyQuery } from '../src/lib/money-query.js';

// This is a finder, not a golden set for current product behavior. A wrong
// figure is recorded as data; only a broken/incomplete finder fails TAP.
// No product classifier, clean-view SQL, or product date helper is an oracle.
const REPORT = pathToFileURL(join(mkdtempSync(join(tmpdir(), 'finder-tools-loans-pending-')), 'REPORT.md'));
const STAMP = '2026-01-01T00:00:00Z';
const migrations = readdirSync(new URL('../../migrations/d1/', import.meta.url))
  .filter(name => name.endsWith('.sql')).sort()
  .map(name => readFileSync(new URL(`../../migrations/d1/${name}`, import.meta.url), 'utf8'));

const cash = (slug, label, extra = {}) => ({ slug, label, kind: 'checking', currency: 'USD', ...extra });
const debt = (slug, mask, kind = 'loan') => ({ slug, label: `Owner ${kind.replaceAll('_', ' ')}`,
  mask, kind, currency: 'USD' });
// purpose is an independent statement of the synthetic economic event. It is
// deliberately never inserted into D1 or inferred by examining product output.
const row = (uid, account, day, cents, direction, purpose, extra = {}) => ({
  uid, account, day, cents, direction, purpose, currency: 'USD', state: 'posted',
  payee: purpose === 'income' ? 'a customer' : purpose === 'expense' ? 'a supplier' : 'a lender',
  description: { income: 'Customer sales', expense: 'Operating purchase', interest: 'Loan interest',
    fee: 'Loan fee', loan_proceeds: 'Loan proceeds', loan_payment: 'Loan payment' }[purpose],
  category: { income: 'INCOME', expense: 'PURCHASE', interest: 'INTEREST', fee: 'FEES',
    loan_proceeds: 'LOAN_DISBURSEMENT', loan_payment: 'LOAN_PAYMENTS' }[purpose],
  ...extra,
});

const books = [
  {
    id: 'external-funding', zone: 'UTC', at: '2026-06-30T12:00:00Z', today: '2026-06-30',
    accounts: [cash('checking', 'Owner funding checking', { mask: '1111' })],
    rows: [
      row('sale', 'checking', '2026-06-01', 120001, 'inflow', 'income'),
      row('advance', 'checking', '2026-06-02', 900007, 'inflow', 'loan_proceeds'),
      row('repayment', 'checking', '2026-06-03', 45003, 'outflow', 'loan_payment'),
      row('interest', 'checking', '2026-06-04', 2501, 'outflow', 'interest'),
      row('fee', 'checking', '2026-06-05', 701, 'outflow', 'fee'),
      row('purchase', 'checking', '2026-06-06', 30001, 'outflow', 'expense'),
      row('pending-advance', 'checking', '2026-06-29', 200003, 'inflow', 'loan_proceeds', { state: 'pending' }),
      row('pending-payment', 'checking', '2026-06-29', 46003, 'outflow', 'loan_payment', { state: 'pending' }),
      row('pending-sale', 'checking', '2026-06-30', 6001, 'inflow', 'income', { state: 'pending' }),
      row('prior-sale', 'checking', '2026-05-31', 11003, 'inflow', 'income'),
      row('next-advance', 'checking', '2026-07-01', 111007, 'inflow', 'loan_proceeds'),
      row('removed-advance', 'checking', '2026-06-08', 200007, 'inflow', 'loan_proceeds', { state: 'removed' }),
      row('old-payment', 'checking', '2026-06-09', 10003, 'outflow', 'loan_payment', { state: 'superseded' }),
      row('new-payment', 'checking', '2026-06-10', 10007, 'outflow', 'loan_payment'),
    ],
  },
  {
    id: 'connected-term-edges', zone: 'UTC', at: '2026-07-31T12:00:00Z', today: '2026-07-31',
    accounts: [cash('checking', 'Owner term checking', { mask: '1111' }), debt('loan', '2222')],
    rows: [
      row('advance-out', 'loan', '2026-06-30', 500009, 'outflow', 'loan_proceeds',
        { payee: null, description: 'TRANSFER TO account 1111' }),
      row('advance-in', 'checking', '2026-07-01', 500009, 'inflow', 'loan_proceeds',
        { payee: null, description: 'TRANSFER FROM account 2222' }),
      row('payment-out', 'checking', '2026-07-31', 15007, 'outflow', 'loan_payment',
        { payee: null, description: 'TRANSFER TO account 2222' }),
      row('payment-in', 'loan', '2026-08-01', 15007, 'inflow', 'loan_payment',
        { payee: null, description: 'TRANSFER FROM account 1111' }),
      row('first-sale', 'checking', '2026-07-01', 99003, 'inflow', 'income'),
      row('last-sale', 'checking', '2026-07-31', 15003, 'inflow', 'income'),
      row('purchase', 'checking', '2026-07-15', 7003, 'outflow', 'expense'),
      row('interest', 'checking', '2026-07-31', 1003, 'outflow', 'interest'),
      row('fee', 'checking', '2026-07-31', 103, 'outflow', 'fee'),
      row('pending-payment', 'checking', '2026-07-31', 16007, 'outflow', 'loan_payment', { state: 'pending' }),
      row('pending-credit', 'loan', '2026-07-31', 16007, 'inflow', 'loan_payment', { state: 'pending' }),
      row('prior-sale', 'checking', '2026-06-30', 12003, 'inflow', 'income'),
    ],
  },
  {
    id: 'connected-credit-line', zone: 'America/Phoenix', at: '2026-06-30T18:00:00Z', today: '2026-06-30',
    accounts: [cash('checking', 'Owner credit line checking', { mask: '3333' }), debt('credit-line', '4444', 'line_of_credit')],
    rows: [
      row('draw-out', 'credit-line', '2026-05-31', 230011, 'outflow', 'loan_proceeds',
        { category: 'LINE_OF_CREDIT_ADVANCE', payee: null, description: 'TRANSFER TO account 3333' }),
      row('draw-in', 'checking', '2026-06-01', 230011, 'inflow', 'loan_proceeds',
        { category: 'LINE_OF_CREDIT_ADVANCE', payee: null, description: 'TRANSFER FROM account 4444' }),
      row('repayment-out', 'checking', '2026-06-30', 31013, 'outflow', 'loan_payment',
        { payee: null, description: 'TRANSFER TO account 4444' }),
      row('repayment-in', 'credit-line', '2026-07-01', 31013, 'inflow', 'loan_payment',
        { payee: null, description: 'TRANSFER FROM account 3333' }),
      row('income', 'checking', '2026-06-30', 17017, 'inflow', 'income'),
      row('interest', 'checking', '2026-06-30', 511, 'outflow', 'interest'),
      row('fee', 'checking', '2026-06-12', 113, 'outflow', 'fee'),
      row('purchase', 'checking', '2026-06-14', 2101, 'outflow', 'expense'),
      row('pending-draw', 'checking', '2026-06-30', 250019, 'inflow', 'loan_proceeds', { state: 'pending' }),
      row('prior-income', 'checking', '2026-05-31', 19001, 'inflow', 'income'),
    ],
  },
  {
    id: 'repayment-components-leap-day', zone: 'UTC', at: '2024-02-29T18:00:00Z', today: '2024-02-29',
    accounts: [cash('checking', 'Owner repayment checking')],
    rows: [
      row('funding', 'checking', '2024-02-01', 321019, 'inflow', 'loan_proceeds'),
      row('coded-payment', 'checking', '2024-02-28', 9001, 'outflow', 'loan_payment'),
      row('text-payment', 'checking', '2024-02-29', 8003, 'outflow', 'loan_payment', { category: null }),
      row('interest', 'checking', '2024-02-29', 701, 'outflow', 'interest', { category: 'LOAN_PAYMENT_INTEREST' }),
      row('fee', 'checking', '2024-02-29', 203, 'outflow', 'fee', { category: 'LOAN_PAYMENT_FEES' }),
      row('lender-purchase', 'checking', '2024-02-29', 1709, 'outflow', 'expense',
        { payee: 'a lender', description: 'Loan payment software purchase' }),
      row('bonus', 'checking', '2024-02-29', 1201, 'inflow', 'income',
        { payee: 'a lender', description: 'Bank bonus income' }),
      row('sale', 'checking', '2024-02-28', 19001, 'inflow', 'income'),
      row('pending-payment', 'checking', '2024-02-29', 44009, 'outflow', 'loan_payment', { state: 'pending' }),
      row('prior-sale', 'checking', '2024-01-31', 31001, 'inflow', 'income'),
      row('next-sale', 'checking', '2024-03-01', 37003, 'inflow', 'income'),
    ],
  },
  {
    id: 'west-of-utc-month-edge', zone: 'America/Phoenix', at: '2026-07-01T05:30:00Z', today: '2026-06-30',
    accounts: [cash('checking', 'Owner western checking')],
    rows: [
      row('first-sale', 'checking', '2026-06-01', 1009, 'inflow', 'income'),
      row('last-sale', 'checking', '2026-06-30', 2003, 'inflow', 'income'),
      row('last-advance', 'checking', '2026-06-30', 87011, 'inflow', 'loan_proceeds'),
      row('last-payment', 'checking', '2026-06-30', 13001, 'outflow', 'loan_payment'),
      row('interest', 'checking', '2026-06-30', 307, 'outflow', 'interest'),
      row('purchase', 'checking', '2026-06-30', 809, 'outflow', 'expense'),
      row('pending-advance', 'checking', '2026-06-30', 97013, 'inflow', 'loan_proceeds', { state: 'pending' }),
      row('pending-payment', 'checking', '2026-06-30', 14009, 'outflow', 'loan_payment', { state: 'pending' }),
      row('prior-sale', 'checking', '2026-05-31', 4001, 'inflow', 'income'),
      row('prior-advance', 'checking', '2026-05-31', 6007, 'inflow', 'loan_proceeds'),
      row('utc-month-advance', 'checking', '2026-07-01', 99017, 'inflow', 'loan_proceeds'),
      row('utc-month-purchase', 'checking', '2026-07-01', 7013, 'outflow', 'expense'),
    ],
  },
  {
    id: 'east-of-utc-month-edge', zone: 'Pacific/Kiritimati', at: '2026-06-30T12:30:00Z', today: '2026-07-01',
    accounts: [cash('checking', 'Owner eastern checking')],
    rows: [
      row('prior-sale', 'checking', '2026-06-30', 7001, 'inflow', 'income'),
      row('prior-advance', 'checking', '2026-06-30', 110017, 'inflow', 'loan_proceeds'),
      row('prior-payment', 'checking', '2026-06-30', 3109, 'outflow', 'loan_payment'),
      row('sale', 'checking', '2026-07-01', 13003, 'inflow', 'income'),
      row('advance', 'checking', '2026-07-01', 210019, 'inflow', 'loan_proceeds'),
      row('payment', 'checking', '2026-07-01', 4109, 'outflow', 'loan_payment'),
      row('interest', 'checking', '2026-07-01', 109, 'outflow', 'interest'),
      row('fee', 'checking', '2026-07-01', 31, 'outflow', 'fee'),
      row('purchase', 'checking', '2026-07-01', 1009, 'outflow', 'expense'),
      row('pending-sale', 'checking', '2026-07-01', 17011, 'inflow', 'income', { state: 'pending' }),
      row('pending-advance', 'checking', '2026-07-01', 310019, 'inflow', 'loan_proceeds', { state: 'pending' }),
      row('tomorrow-sale', 'checking', '2026-07-02', 19001, 'inflow', 'income'),
    ],
  },
  {
    id: 'pending-settlement-replacement', zone: 'America/New_York', at: '2026-09-30T20:00:00Z', today: '2026-09-30',
    accounts: [cash('checking', 'Owner settlement checking'), debt('settlement-loan','5555')],
    rows: [
      row('pending-funding', 'checking', '2026-09-30', 100003, 'inflow', 'loan_proceeds', { state: 'pending' }),
      row('settled-funding', 'checking', '2026-10-01', 99991, 'inflow', 'loan_proceeds', { replaces: 'pending-funding' }),
      row('pending-payment', 'checking', '2026-09-28', 10007, 'outflow', 'loan_payment', { state: 'pending' }),
      row('settled-payment', 'checking', '2026-09-29', 9877, 'outflow', 'loan_payment', { replaces: 'pending-payment', payee:null, description:'TRANSFER TO ACCOUNT 5555' }),
      row('removed-payment', 'checking', '2026-09-30', 89003, 'outflow', 'loan_payment', { state: 'removed' }),
      row('superseded-advance', 'checking', '2026-09-30', 77003, 'inflow', 'loan_proceeds', { state: 'superseded' }),
      row('sale', 'checking', '2026-09-30', 33001, 'inflow', 'income'),
      row('interest', 'checking', '2026-09-30', 443, 'outflow', 'interest'),
      row('fee', 'checking', '2026-09-29', 127, 'outflow', 'fee'),
      row('purchase', 'checking', '2026-09-28', 1237, 'outflow', 'expense'),
      row('prior-sale', 'checking', '2026-08-31', 5519, 'inflow', 'income'),
    ],
  },
  {
    id: 'local-new-year', zone: 'Asia/Tokyo', at: '2026-12-31T15:30:00Z', today: '2027-01-01',
    accounts: [cash('checking', 'Owner year edge checking')],
    rows: [
      row('prior-sale', 'checking', '2026-12-31', 70001, 'inflow', 'income'),
      row('prior-advance', 'checking', '2026-12-31', 90001, 'inflow', 'loan_proceeds'),
      row('sale', 'checking', '2027-01-01', 31001, 'inflow', 'income'),
      row('advance', 'checking', '2027-01-01', 170003, 'inflow', 'loan_proceeds'),
      row('payment', 'checking', '2027-01-01', 19009, 'outflow', 'loan_payment'),
      row('interest', 'checking', '2027-01-01', 211, 'outflow', 'interest'),
      row('purchase', 'checking', '2027-01-01', 4001, 'outflow', 'expense'),
      row('pending-advance', 'checking', '2027-01-01', 190027, 'inflow', 'loan_proceeds', { state: 'pending' }),
      row('pending-payment', 'checking', '2027-01-01', 23003, 'outflow', 'loan_payment', { state: 'pending' }),
      row('tomorrow-sale', 'checking', '2027-01-02', 43003, 'inflow', 'income'),
    ],
  },
  {
    id: 'spring-clock-change', zone: 'America/New_York', at: '2024-03-10T07:30:00Z', today: '2024-03-10',
    accounts: [cash('checking', 'Owner spring checking')],
    rows: [
      row('leap-sale', 'checking', '2024-02-29', 21001, 'inflow', 'income'),
      row('leap-advance', 'checking', '2024-02-29', 41011, 'inflow', 'loan_proceeds'),
      row('yesterday-sale', 'checking', '2024-03-09', 12007, 'inflow', 'income'),
      row('today-sale', 'checking', '2024-03-10', 13001, 'inflow', 'income'),
      row('today-advance', 'checking', '2024-03-10', 230021, 'inflow', 'loan_proceeds'),
      row('today-payment', 'checking', '2024-03-10', 17011, 'outflow', 'loan_payment'),
      row('today-interest', 'checking', '2024-03-10', 503, 'outflow', 'interest'),
      row('today-fee', 'checking', '2024-03-10', 107, 'outflow', 'fee'),
      row('today-purchase', 'checking', '2024-03-10', 2707, 'outflow', 'expense'),
      row('pending-payment', 'checking', '2024-03-10', 18013, 'outflow', 'loan_payment', { state: 'pending' }),
      row('pending-advance', 'checking', '2024-03-10', 270031, 'inflow', 'loan_proceeds', { state: 'pending' }),
      row('tomorrow-advance', 'checking', '2024-03-11', 310033, 'inflow', 'loan_proceeds'),
    ],
  },
  {
    id: 'currency-and-empty-coverage', zone: 'Europe/London', at: '2026-10-31T23:30:00Z', today: '2026-10-31',
    accounts: [cash('checking', 'Owner currency checking'),
      cash('empty', 'Owner empty checking', { coverage: 'missing' }),
      cash('euro', 'Owner euro savings', { kind: 'savings', currency: 'EUR' })],
    rows: [
      row('sale', 'checking', '2026-10-01', 47003, 'inflow', 'income'),
      row('advance', 'checking', '2026-10-31', 410039, 'inflow', 'loan_proceeds'),
      row('payment', 'checking', '2026-10-31', 33013, 'outflow', 'loan_payment'),
      row('interest', 'checking', '2026-10-31', 907, 'outflow', 'interest'),
      row('fee', 'checking', '2026-10-31', 109, 'outflow', 'fee'),
      row('purchase', 'checking', '2026-10-15', 5701, 'outflow', 'expense'),
      row('pending-advance', 'checking', '2026-10-31', 430043, 'inflow', 'loan_proceeds', { state: 'pending' }),
      row('pending-payment', 'checking', '2026-10-31', 37009, 'outflow', 'loan_payment', { state: 'pending' }),
      row('prior-sale', 'checking', '2026-09-30', 59009, 'inflow', 'income'),
      row('euro-sale', 'euro', '2026-10-31', 99001, 'inflow', 'income', { currency: 'EUR' }),
      row('euro-advance', 'euro', '2026-10-31', 510047, 'inflow', 'loan_proceeds', { currency: 'EUR' }),
      row('euro-payment', 'euro', '2026-10-31', 39019, 'outflow', 'loan_payment', { currency: 'EUR' }),
    ],
  },
];

function fixture(book, rows = book.rows) {
  const db = new DatabaseSync(':memory:');
  const calls = [];
  try {
    for (const sql of migrations) db.exec(sql);
    const insert = (table, values) => {
      const columns = Object.keys(values);
      db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
        .run(...columns.map(key => values[key]));
    };
    const basis = { provenance: 'owner_stated', basis_state: 'confirmed', recorded_at: STAMP };
    insert('fin_entities', { entity_slug: 'business', legal_name: 'Owner business', kind: 'business', ...basis });
    for (const a of book.accounts) {
      insert('fin_accounts', { account_slug: a.slug, entity_slug: 'business', label: a.label,
        account_kind: a.kind, balance_role: ['loan', 'line_of_credit'].includes(a.kind) ? 'liability' : 'asset',
        mask: a.mask ?? null, currency: a.currency, feed_mode: 'manual', ...basis });
      insert('fin_account_coverage', { account_slug: a.slug, coverage_status: a.coverage ?? 'complete',
        covered_from: a.coverage === 'missing' ? null : `${Number(book.today.slice(0, 4)) - 1}-01-01`,
        covered_to: a.coverage === 'missing' ? null : book.today,
        basis_note: 'Synthetic owner statement comparison', computed_at: book.at, ...basis });
    }
    for (const r of rows) {
      insert('fin_transactions', { txn_uid: r.uid, account_slug: r.account, posted_on: r.day,
        amount_minor: r.cents, direction: r.direction, currency: r.currency, payee: r.payee,
        description: r.description, category: r.category,
        category_basis_state: r.category === null ? null : 'confirmed', pending: Number(r.state === 'pending'),
        pending_transaction_id: r.replaces ?? null,
        removed_at: r.state === 'removed' ? STAMP : null,
        removal_reason: r.state === 'removed' ? 'Synthetic withdrawn row' : null,
        superseded_by_id: r.state === 'superseded' ? 999999 : null, ...basis });
    }
    // Only D1's transport is adapted. Every submitted query still passes through
    // the real MCP handler, SQL guard, historical snapshot, classifier and CTEs.
    const env = { STORAGE: 'd1', DB: { prepare(sql) {
      calls.push(sql);
      const statement = db.prepare(sql);
      const bound = args => ({
        async all() { return { success: true, results: statement.all(...args) }; },
        async first() { return statement.get(...args) ?? null; },
      });
      return { ...bound([]), bind(...args) { return bound(args); } };
    } } };
    return { env, calls, close: () => db.close() };
  } catch (error) { db.close(); throw error; }
}

let rpcId = 0;
async function tool(f, sql) {
  const id = ++rpcId;
  const url = new URL('https://brain.invalid/mcp');
  const response = await handleMcp(f.env, new Request(url, { method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: 'brain_money_query', arguments: { sql, max_rows: 200 } } }),
  }), url, { grant: { profile: 'owner-assistant' } });
  const envelope = await response.json();
  if (response.status !== 200 || envelope.error || envelope.result?.isError) {
    return { ok: false, result: { status: response.status, error: envelope.error ?? envelope.result } };
  }
  try {
    const result = JSON.parse(envelope.result.content[0].text);
    if (result.truncated || result.row_count !== 1 || !Number.isSafeInteger(result.rows?.[0]?.value))
      return { ok: false, result };
    return { ok: true, result };
  } catch { return { ok: false, result: envelope }; }
}

// SQL uses explicit owner-local date literals. A separately declared local day
// below is the reference, so a UTC/local-month mistake cannot bless itself.
function sqlWindow(book, period) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: book.zone,
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(book.at))
    .filter(p => ['year', 'month', 'day'].includes(p.type)).map(p => [p.type, p.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const year = Number(parts.year), month = Number(parts.month);
  if (period === 'today') return [today, today];
  if (period === 'year') return [`${parts.year}-01-01`, today];
  if (period === 'previous') {
    const first = new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 10);
    const last = new Date(Date.UTC(year, month - 1, 0)).toISOString().slice(0, 10);
    return [first, last];
  }
  return [`${parts.year}-${parts.month}-01`, today];
}
const quoted = value => `'${value.replaceAll("'", "''")}'`;
function selectedAccounts(book, currency) {
  return book.accounts.filter(a => ['checking', 'savings'].includes(a.kind) && a.currency === currency);
}
const incomePurposes = new Set(['income']);
const spendingPurposes = new Set(['expense', 'interest', 'fee']);

function expected(book, q, rows = book.rows) {
  const accounts = selectedAccounts(book, q.currency);
  if (q.metric === 'coverage') return accounts.filter(a => a.coverage !== 'missing').length;
  const [year, month, day] = book.today.split('-').map(Number);
  const currentMonth = year * 12 + month;
  const scope = new Set(accounts.map(a => a.slug));
  let value = 0;
  for (const r of rows) {
    if (r.state !== 'posted' || !scope.has(r.account) || r.currency !== q.currency) continue;
    const [ry, rm, rd] = r.day.split('-').map(Number);
    const rowMonth = ry * 12 + rm;
    const throughToday = rowMonth < currentMonth || rowMonth === currentMonth && rd <= day;
    const within = q.period === 'today' ? ry === year && rm === month && rd === day
      : q.period === 'previous' ? rowMonth === currentMonth - 1
      : q.period === 'year' ? ry === year && throughToday
      : rowMonth === currentMonth && throughToday;
    if (!within) continue;
    const inflow = r.direction === 'inflow', spending = spendingPurposes.has(r.purpose);
    if (q.metric === 'in' && inflow || q.metric === 'out' && !inflow) value += r.cents;
    if (q.metric === 'cash_net') value += inflow ? r.cents : -r.cents;
    if (q.metric === 'income' && inflow && incomePurposes.has(r.purpose)) value += r.cents;
    if (q.metric === 'expense' && !inflow && spending) value += r.cents;
    if (q.metric === 'operating_net') {
      if (inflow && incomePurposes.has(r.purpose)) value += r.cents;
      if (!inflow && spending) value -= r.cents;
    }
    if (q.metric === 'proceeds' && inflow && r.purpose === 'loan_proceeds') value += r.cents;
    if (q.metric === 'payments' && !inflow && r.purpose === 'loan_payment') value += r.cents;
    if (q.metric === 'interest_fees' && !inflow && ['interest', 'fee'].includes(r.purpose)) value += r.cents;
    if (q.metric === 'payment_count' && !inflow && r.purpose === 'loan_payment') value++;
  }
  return value;
}

function question(book, metric, period = 'month', currency = 'USD') {
  const accounts = selectedAccounts(book, currency);
  const accountNames = accounts.map(a => a.label).join(' and ');
  const when = { month: 'this month so far', today: 'today', previous: 'last month', year: 'this year so far' }[period];
  const text = {
    in: `How much money actually came into ${accountNames} ${when}, including borrowing?`,
    out: `How much money actually left ${accountNames} ${when}, including loan payments?`,
    cash_net: `What was the net posted cash movement in ${accountNames} ${when}, including loans?`,
    income: `How much income did ${accountNames} receive ${when}, keeping borrowed money separate?`,
    expense: `How much did I spend from ${accountNames} ${when}, keeping loan repayments separate?`,
    operating_net: `What was income less spending in ${accountNames} ${when}, keeping borrowing and repayments separate?`,
    proceeds: `How much loan money actually landed in ${accountNames} ${when}, excluding anything still pending?`,
    payments: `How much did I actually pay toward loans from ${accountNames} ${when}, excluding pending payments?`,
    interest_fees: `How much separately recorded interest and fees left ${accountNames} ${when}?`,
    payment_count: `How many loan payments actually posted to ${accountNames} ${when}?`,
    coverage: `How many accounts in ${accountNames} have confirmed history covering ${when}?`,
  }[metric];
  const [from, to] = sqlWindow(book, period);
  const accountSql = accounts.map(a => quoted(a.slug)).join(',');
  const scope = `side='business' AND currency=${quoted(currency)} AND account_slug IN (${accountSql})`;
  const complete = `coverage_status='complete' AND covered_from<=${quoted(from)} AND covered_to>=${quoted(to)}`;
  const expression = {
    in: "SUM(CASE WHEN direction='inflow' THEN amount_minor ELSE 0 END)",
    out: "SUM(CASE WHEN direction='outflow' THEN amount_minor ELSE 0 END)",
    cash_net: "SUM(CASE WHEN direction='inflow' THEN amount_minor ELSE -amount_minor END)",
    income: 'SUM(income_minor)', expense: 'SUM(expense_minor)',
    operating_net: 'SUM(income_minor-expense_minor)',
    proceeds: `SUM(CASE WHEN direction='inflow' AND
      (upper(replace(COALESCE(category,''),' ','_')) IN ('LOAN_DISBURSEMENT','LINE_OF_CREDIT_ADVANCE')
        OR lower(COALESCE(description,'')) LIKE 'loan proceeds%'
        OR lower(COALESCE(description,'')) LIKE 'line of credit advance%') THEN amount_minor ELSE 0 END)`,
    payments: "SUM(CASE WHEN direction='outflow' AND money_kind='loan_payment' THEN amount_minor ELSE 0 END)",
    payment_count: "SUM(CASE WHEN direction='outflow' AND money_kind='loan_payment' THEN 1 ELSE 0 END)",
    interest_fees: `SUM(CASE WHEN direction='outflow' AND
      upper(COALESCE(category,'')) IN ('INTEREST','FEES','LOAN_PAYMENT_INTEREST','LOAN_PAYMENT_FEES')
      THEN amount_minor ELSE 0 END)`,
  }[metric];
  const sql = metric === 'coverage'
    ? `SELECT COUNT(*) AS value FROM coverage WHERE ${scope} AND ${complete}`
    : `SELECT COALESCE(${expression},0) AS value,
      COALESCE(SUM(estimated),0) AS uncertain_rows,
      COALESCE(SUM(CASE WHEN estimated=1 AND direction='inflow' THEN amount_minor ELSE 0 END),0) AS uncertain_in_minor,
      COALESCE(SUM(CASE WHEN estimated=1 AND direction='outflow' THEN amount_minor ELSE 0 END),0) AS uncertain_out_minor,
      (SELECT COUNT(*) FROM coverage WHERE ${scope}) AS accounts_in_scope,
      (SELECT COUNT(*) FROM coverage WHERE ${scope} AND ${complete}) AS complete_accounts
    FROM txn WHERE ${scope} AND posted_on BETWEEN ${quoted(from)} AND ${quoted(to)}`;
  return { id: `${book.id}/${currency}/${metric}/${period}`, book, metric, period, currency,
    text: `${text} My local date is ${book.today} (${book.zone}); use ${currency}.`, sql };
}

const questions = books.flatMap(book => [
  ...['in', 'out', 'cash_net', 'income', 'expense', 'operating_net', 'proceeds', 'payments', 'interest_fees', 'payment_count']
    .map(metric => question(book, metric)),
  question(book, 'in', 'today'), question(book, 'out', 'today'),
  question(book, 'income', 'previous'), question(book, 'income', 'year'), question(book, 'coverage'),
]);
questions.push(...['in', 'income', 'proceeds', 'payments'].map(metric => question(books.at(-1), metric, 'month', 'EUR')));

async function compare(f, q, rows = q.book.rows) {
  const wanted = expected(q.book, q, rows);
  assert.ok(Number.isSafeInteger(wanted), 'reference figure must be exact integer cents or a count');
  const response = await tool(f, q.sql);
  return { q, expected: wanted, actual: response.result,
    status: !response.ok ? 'failed' : response.result.rows[0].value === wanted ? 'right' : 'wrong' };
}

// Greedy deletion, followed by an exhaustive one-row-deletion check, yields a
// 1-minimal counterexample. These diagnostic reruns are not extra questions.
async function minimize(result) {
  let rows = [...result.q.book.rows];
  let changed = true;
  const evaluate = async trial => {
    const f = fixture(result.q.book, trial);
    try { return await compare(f, result.q, trial); } finally { f.close(); }
  };
  while (changed) {
    changed = false;
    for (let i = 0; i < rows.length; i++) {
      const trial = rows.filter((_, index) => index !== i);
      if ((await evaluate(trial)).status === result.status) { rows = trial; changed = true; break; }
    }
  }
  for (let i = 0; i < rows.length; i++)
    assert.notEqual((await evaluate(rows.filter((_, index) => index !== i))).status, result.status);
  return { ...await evaluate(rows), rows };
}

function causes(result) {
  // Locate the exact current rules instead of letting source-line drift make
  // the generated report cite a different statement after a product change.
  const cite = (file, needle) => {
    const lines = readFileSync(new URL(`../src/lib/${file}`, import.meta.url), 'utf8').split('\n');
    const index = lines.findIndex(line => line.includes(needle));
    assert.ok(index >= 0, `missing causal source anchor in ${file}`);
    return `worker/src/lib/${file}:${index + 1}`;
  };
  const cleanIncome = cite('clean-money.js', "CASE WHEN direction='inflow' AND movement_kind='ordinary' AND account_kind NOT IN ('card','loan','line_of_credit') THEN amount_minor");
  // 0.4.28 routes shared classification through its reviewed loan-draw reading.
  const shared = cite('clean-money.js', 'const {classification,money_kind,estimated,estimate_reason,uncertain_kind} = loanDrawReading');
  const fallback = cite('money-analysis.js', "const money_kind = paymentKind ? paymentKind + '_payment'");
  const unknown = cite('money-analysis.js', "return 'unknown';");
  return `Clean-view rule: ${cleanIncome} counts every ordinary inflow in income_minor. ` +
    `${shared} consumes the shared classifier; ${unknown} / ${fallback} retain unproved outgoing ` +
    `payment candidates in spending and flag their full amounts. The independent book purpose is not D1 evidence. ` +
    'An exact owned destination or proved pair is required before excluding a repayment.';
}

async function report(results, ready, why = '') {
  const counts = Object.fromEntries(['right', 'wrong', 'failed'].map(status => [status, results.filter(r => r.status === status).length]));
  const lines = [ready ? 'READY' : 'NOT READY',
    `questions=${results.length} right=${counts.right} wrong=${counts.wrong} failed=${counts.failed}`, '',
    `${books.length} synthetic owner books; ${questions.length} planned questions. ` +
    'Each SQL statement goes through real MCP brain_money_query -> queryMoney -> clean-money on node:sqlite with all D1 migrations. ' +
    'The matching private HTTP money-query handler is also checked. No network or credentials are used.', '',
    'Reference answers sum original synthetic rows by independently declared economic purpose, active posting state, currency, account and owner-local period. ' +
    'All amounts are integer minor units. Pending, removed and superseded rows are excluded from posted answers. ' +
    'Loan payments are whole payments; only separately recorded interest and fees are spending. ' +
    'Full raw synthetic inputs, questions and SQL are in worker/test/finder-tools-loans-pending-1112.test.mjs.', '',
    'A successful finder run is READY even when figures disagree. TAP checks the finder; the counts above describe product answers. ' +
    'Questions concern posted activity: the test does not pretend txn can expose pending-only amounts. ' +
    'Explicit local dates cover west/east UTC month edges, leap day, daylight saving time and a local new year. ' +
    'Coverage remains attached to money results, including an empty missing account; uncertain figures remain labeled estimates.', '',
  ];
  // Prefer distinct books/figures to repeating the same income discrepancy in
  // a monthly, annual and net question. At most ten examples, each minimized.
  const failing = results.filter(r => r.status !== 'right');
  const chosen = [], seen = new Set();
  for (const r of [...failing.filter(r => r.q.metric === 'income' && r.q.period === 'month'), ...failing]) {
    const key = `${r.q.book.id}/${r.q.currency}`;
    if (!seen.has(key) && chosen.length < 10) { chosen.push(r); seen.add(key); }
  }
  for (const [index, original] of chosen.entries()) {
    const result = await minimize(original);
    lines.push(`${index + 1}. ${result.status}: ${result.q.id}`, `Question: ${result.q.text}`,
      `Clock: ${result.q.book.at}; owner zone: ${result.q.book.zone}; independently declared local day: ${result.q.book.today}.`,
      `Accounts: ${JSON.stringify(result.q.book.accounts)}`,
      `Rows (1-minimal; purpose is reference-only): ${JSON.stringify(result.rows)}`,
      `Expected: ${result.expected}`, `SQL: ${result.q.sql}`,
      `Actual SQL result: ${JSON.stringify(result.actual)}`,
      result.status === 'wrong' ? causes(result) : 'Route error/refusal: see the actual tool result above.', '');
  }
  if (!failing.length) lines.push('No failing inputs.', '');
  if (why) lines.push(`Finder limitation: ${why}`, '');
  lines.push(`LANE PRO-TOOLS-FINDER-LOANS-PENDING-1112: ${ready ? 'READY' : `NOT READY ${why}`}`);
  writeFileSync(REPORT, `${lines.join('\n')}\n`);
  return counts;
}

test('loan, pending and owner-local date finder through real brain_money_query', async t => {
  const results = [];
  let completedBooks = 0;
  let ready = false;
  let why = 'finder did not finish';
  t.mock.method(globalThis, 'fetch', () => { throw new Error('This finder is offline'); });
  try {
    assert.ok(books.length >= 8);
    assert.ok(questions.length >= 60);
    assert.equal(new Set(questions.map(q => q.id)).size, questions.length);
    assert.equal(new Set(questions.map(q => q.text)).size, questions.length);
    // Hand arithmetic controls the independent oracle before any product read.
    assert.equal(expected(books[0], question(books[0], 'income')), 120001);
    assert.equal(expected(books[0], question(books[0], 'in')), 1020008);
    assert.equal(expected(books[0], question(books[0], 'payments')), 55010);
    assert.equal(expected(books[3], question(books[3], 'interest_fees')), 904);
    assert.equal(expected(books[6], question(books[6], 'payments')), 9877);
    assert.equal(expected(books[7], question(books[7], 'income', 'year')), 31001);
    for (const book of books) {
      await t.test(book.id, async t => {
        assert.equal(sqlWindow(book, 'today')[0], book.today, 'independent calendar premise');
        assert.ok(book.rows.some(r => r.state === 'pending'));
        assert.ok(book.rows.some(r => r.state === 'posted' && r.purpose === 'loan_payment'));
        const f = fixture(book);
        try {
          for (const q of questions.filter(q => q.book === book)) {
            const result = await compare(f, q);
            results.push(result);
            const c=result.actual?.confidence;
            assert.ok(c && Number.isInteger(c.percent) && c.percent>=0 && c.percent<=100,'every finder answer is scored');
            if(c.percent<100) assert.ok(c.reasons.length && c.missing.length,'every sub-100 answer explains why and what is missing');
            if(result.status==='wrong') assert.ok(c.percent<90,'an incorrect High-confidence figure is a ship blocker');
            if (result.status !== 'right') t.diagnostic(`${result.status}: ${q.id}; expected=${result.expected}; ` +
              `actual=${JSON.stringify(result.actual)}`);
          }
          const gross = questions.find(q => q.book === book && q.metric === 'in' && q.period === 'month');
          const http = await handleMoneyQuery(f.env, new Request('https://brain.invalid/api/admin/brain/money-query', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql: gross.sql }),
          }));
          assert.equal(http.status, 200, 'same real SQL handler is reachable through private HTTP');
          const httpResult = await http.json();
          assert.deepEqual(httpResult.rows, results.find(r => r.q.id === gross.id).actual.rows);
          assert.ok(f.calls.some(sql => sql.includes('mq_membership') && sql.includes('snapshot_kind')),
            'real clean historical snapshot executed');
          assert.ok(f.calls.some(sql => sql.startsWith('SELECT * FROM (') && sql.includes('mq_result')),
            'real guarded owner SQL executed');
        } finally { f.close(); }
        const own = results.filter(r => r.q.book === book);
        t.diagnostic(`questions=${own.length} right=${own.filter(r => r.status === 'right').length} ` +
          `wrong=${own.filter(r => r.status === 'wrong').length} failed=${own.filter(r => r.status === 'failed').length}`);
        completedBooks++;
      });
    }
    assert.equal(completedBooks, books.length, 'every book completed its finder checks');
    assert.equal(results.length, questions.length, 'every planned question was compared');
    assert.ok(results.some(r => r.q.book.id === 'connected-term-edges' && r.q.metric === 'income' && r.status === 'right'),
      'connected borrowing is a positive control for external borrowing');
    assert.ok(results.some(r => r.q.book.id === 'pending-settlement-replacement' && r.q.metric === 'payments' && r.status === 'right'),
      'settled replacement counts once at its changed amount');
    ready = !t.signal.aborted;
    why = ready ? '' : 'finder aborted';
  } catch (error) {
    why = 'finder setup or execution assertion failed';
    throw error;
  } finally {
    const counts = await report(results, ready, why);
    t.diagnostic(`questions=${results.length} right=${counts.right} wrong=${counts.wrong} failed=${counts.failed}`);
  }
});
