import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { handleMoneyQuery } from '../src/lib/money-query.js';

// Run only this file: node --test worker/test/finder-tools-transfers-1112.test.mjs
// This is a finder, so figure mismatches fail their subtests while READY means
// the complete experiment ran. No model, account, credential or network is used.
// The real POST handler performs validation, scan budgeting, clean snapshots,
// shared movement classification and SQL execution. Only D1's transport is local.
const STAMP = '2026-11-12T12:00:00Z';
const REPORT = new URL('../../.lane-scratch/finder-tools-transfers-1112.md', import.meta.url);
mkdirSync(new URL('.', REPORT), { recursive: true });
const FROM = '2026-09-01', TO = '2026-09-30';
const migrations = readdirSync(new URL('../../migrations/d1/', import.meta.url))
  .filter(name => name.endsWith('.sql')).sort()
  .map(name => readFileSync(new URL(`../../migrations/d1/${name}`, import.meta.url), 'utf8'));

const account = (slug, kind, mask, extra = {}) => ({
  slug, kind, mask, label: `Owner ${slug.replaceAll('-', ' ')}`, currency: 'USD',
  entity: 'business', status: 'open', coverage: 'complete', ...extra,
});
const checking = () => account('checking', 'checking', '1111');
const savings = () => account('savings', 'savings', '2222');
const card = () => account('card', 'card', '3333');
const entry = (uid, acct, day, cents, direction, event, extra = {}) => ({
  uid, acct, day, cents, direction, event, currency: 'USD', description: null,
  payee: null, category: null, basis: 'confirmed', categoryBasis: null, ...extra,
});
const receipt = (uid, acct, day, cents, extra = {}) => entry(uid, acct, day, cents, 'inflow', 'income', {
  payee: 'Customer', description: 'CUSTOMER INCOME', category: 'INCOME', categoryBasis: 'confirmed', ...extra,
});
const expense = (uid, acct, day, cents, extra = {}) => entry(uid, acct, day, cents, 'outflow', 'expense', {
  payee: 'Merchant', description: 'PURCHASE', category: 'PURCHASE', categoryBasis: 'confirmed', ...extra,
});
function move(uid, cents, outDay, inDay = outDay, extra = {}) {
  return [
    entry(`${uid}-out`, 'checking', outDay, cents, 'outflow', 'transfer', { description: 'TRANSFER TO X2222', ...extra }),
    entry(`${uid}-in`, 'savings', inDay, cents, 'inflow', 'transfer', { description: 'TRANSFER FROM X1111', ...extra }),
  ];
}
function payment(uid, cents, outDay, inDay = outDay) {
  return [
    entry(`${uid}-out`, 'checking', outDay, cents, 'outflow', 'card_payment', { description: 'PAYMENT TO CARD X3333' }),
    entry(`${uid}-in`, 'card', inDay, cents, 'inflow', 'card_payment', { description: 'PAYMENT THANK YOU' }),
  ];
}

// Event labels belong ONLY to the independent reference books, never to SQL or
// the product. They express the operation recorded by the synthetic owner.
// Unproved, ambiguous receipts/debits deliberately remain provisional ordinary
// income/spending; matching cents alone must not erase them. Explicit directed
// owned endpoints establish row membership even when a reciprocal leg is absent.
const books = [
  {
    id: 'same-day-savings', about: 'a same-day move between checking and savings',
    accounts: [checking(), savings()], rows: [
      receipt('customer', 'checking', '2026-09-02', 240000),
      ...move('save', 70000, '2026-09-05'),
      expense('supplies', 'checking', '2026-09-06', 18000),
      receipt('interest', 'savings', '2026-09-30', 275, { payee: 'Bank', description: 'INTEREST PAID', category: 'INTEREST_INCOME' }),
    ],
  },
  {
    id: 'card-purchases-and-payment', about: 'a card payment alongside purchases, interest and a fee',
    accounts: [checking(), card()], rows: [
      receipt('customer', 'checking', '2026-09-01', 350000),
      expense('purchase', 'card', '2026-09-03', 45321),
      expense('interest', 'card', '2026-09-04', 1729, { payee: null, description: 'CARD INTEREST', category: 'INTEREST' }),
      expense('fee', 'card', '2026-09-04', 2500, { payee: null, description: 'ANNUAL FEE', category: 'FEE' }),
      ...payment('repay', 60000, '2026-09-08', '2026-09-09'),
      expense('rent', 'checking', '2026-09-10', 80000, { category: 'RENT' }),
    ],
  },
  {
    id: 'month-boundaries', about: 'savings and card movements crossing month ends',
    accounts: [checking(), savings(), card()], rows: [
      ...move('opening', 65000, '2026-08-31', '2026-09-02'),
      receipt('customer', 'checking', '2026-09-05', 190000),
      expense('purchase', 'card', '2026-09-12', 22000),
      ...payment('closing', 38000, '2026-09-30', '2026-10-02'),
      ...move('closing-save', 41000, '2026-09-30', '2026-10-01'),
    ],
  },
  {
    id: 'partial-and-split', about: 'partial and split savings and card postings',
    accounts: [checking(), savings(), card()], rows: [
      receipt('customer', 'checking', '2026-09-01', 400000),
      entry('split-out', 'checking', '2026-09-04', 100000, 'outflow', 'transfer', { description: 'TRANSFER TO X2222' }),
      entry('split-in-one', 'savings', '2026-09-04', 60000, 'inflow', 'transfer', { description: 'TRANSFER FROM X1111' }),
      entry('split-in-two', 'savings', '2026-09-05', 40000, 'inflow', 'transfer', { description: 'TRANSFER FROM X1111' }),
      entry('partial-out', 'checking', '2026-09-11', 75000, 'outflow', 'card_payment', { description: 'PAYMENT TO CARD X3333' }),
      entry('partial-in', 'card', '2026-09-12', 50000, 'inflow', 'card_payment', { description: 'PAYMENT THANK YOU' }),
      expense('purchase', 'card', '2026-09-14', 12345),
    ],
  },
  {
    id: 'repeated-same-day', about: 'repeated same-day equal amounts with directed endpoints',
    accounts: [checking(), savings(), card()], rows: [
      ...move('first', 25000, '2026-09-07'),
      ...move('second', 25000, '2026-09-07'),
      ...payment('card', 25000, '2026-09-07'),
      receipt('same-amount-customer', 'checking', '2026-09-07', 25000),
      expense('same-amount-purchase', 'card', '2026-09-07', 25000),
    ],
  },
  {
    id: 'unmatched-known-endpoints', about: 'unmatched directed savings legs and card acknowledgements',
    accounts: [checking(), savings(), card(), account('empty-savings', 'savings', '4444', { coverage: 'missing' })], rows: [
      receipt('customer', 'checking', '2026-09-01', 270000),
      entry('out-only', 'checking', '2026-09-03', 33000, 'outflow', 'transfer', { description: 'TRANSFER TO X2222' }),
      entry('in-only', 'savings', '2026-09-18', 44000, 'inflow', 'transfer', { description: 'TRANSFER FROM X1111' }),
      entry('card-out-only', 'checking', '2026-09-20', 55000, 'outflow', 'card_payment', { description: 'PAYMENT TO CARD X3333' }),
      entry('card-in-only', 'card', '2026-09-29', 12000, 'inflow', 'card_payment', { description: 'PAYMENT THANK YOU' }),
      expense('purchase', 'checking', '2026-09-21', 6789),
    ],
  },
  {
    id: 'bank-category-pairs', about: 'mutually unique bank-category pairs with no endpoint memo',
    accounts: [checking(), savings()], rows: [
      receipt('customer', 'checking', '2026-09-01', 310000),
      // These two bank-coded legs are one indivisible reference operation.
      entry('bank-out', 'checking', '2026-09-06', 48000, 'outflow', 'transfer', { category: 'INTERNAL_TRANSFER', categoryBasis: 'confirmed', bundle: 'bank-pair' }),
      entry('bank-in', 'savings', '2026-09-08', 48000, 'inflow', 'transfer', { category: 'INTERNAL_TRANSFER', categoryBasis: 'confirmed', bundle: 'bank-pair' }),
      expense('purchase', 'checking', '2026-09-15', 9887),
      // A proposed category and an equal amount do not establish ownership.
      entry('proposed-out', 'checking', '2026-09-23', 17000, 'outflow', 'expense', { category: 'TRANSFER', categoryBasis: 'proposed', uncertain: true }),
      entry('proposed-in', 'savings', '2026-09-23', 17000, 'inflow', 'income', { uncertain: true }),
    ],
  },
  {
    id: 'unproved-collisions', about: 'same-day collisions and unmatched legs without ownership proof',
    accounts: [checking(), savings(), card()], rows: [
      entry('ambiguous-out', 'checking', '2026-09-05', 21000, 'outflow', 'expense', { description: 'TRANSFER', uncertain: true }),
      entry('ambiguous-in-one', 'savings', '2026-09-05', 21000, 'inflow', 'income', { description: 'TRANSFER', uncertain: true }),
      receipt('ambiguous-in-two', 'checking', '2026-09-05', 21000),
      entry('external-out', 'checking', '2026-09-19', 13000, 'outflow', 'expense', { description: 'TRANSFER TO MY EXTERNAL ACCOUNT', uncertain: true }),
      entry('external-in', 'savings', '2026-09-28', 14000, 'inflow', 'income', { description: 'TRANSFER FROM MY EXTERNAL ACCOUNT', uncertain: true }),
      expense('purchase', 'card', '2026-09-26', 7321),
    ],
  },
  {
    id: 'outside-payee-and-expense-veto', about: 'outside payees and explicit expenses beside transfer-looking memos',
    accounts: [checking(), savings(), card()], rows: [
      expense('outside-out', 'checking', '2026-09-06', 23000, { description: 'TRANSFER TO X2222', category: null, categoryBasis: null }),
      receipt('outside-in', 'savings', '2026-09-06', 23000, { description: 'TRANSFER FROM X1111' }),
      expense('fee', 'checking', '2026-09-09', 399, { payee: null, description: 'TRANSFER TO X2222', category: 'TRANSFER_FEE' }),
      expense('card-fee', 'card', '2026-09-10', 599, { payee: null, description: 'CREDIT CARD PAYMENT FEE', category: 'FEE' }),
      ...move('real', 51000, '2026-09-20'),
    ],
  },
  {
    id: 'ambiguous-mask-inventory', about: 'two owned savings accounts sharing a mask',
    accounts: [checking(), savings(), account('reserve', 'savings', '2222'), card()], rows: [
      entry('uncertain-out', 'checking', '2026-09-05', 29000, 'outflow', 'expense', { description: 'TRANSFER TO X2222', uncertain: true }),
      entry('uncertain-in-one', 'savings', '2026-09-05', 29000, 'inflow', 'income', { description: 'TRANSFER', uncertain: true }),
      entry('uncertain-in-two', 'reserve', '2026-09-05', 29000, 'inflow', 'income', { description: 'TRANSFER', uncertain: true }),
      // A complete unique stored label can identify the account despite the mask collision.
      entry('label-out', 'checking', '2026-09-18', 15000, 'outflow', 'transfer', { description: 'TRANSFER TO Owner reserve' }),
      entry('label-in', 'reserve', '2026-09-18', 15000, 'inflow', 'transfer', { description: 'TRANSFER FROM Owner checking' }),
      receipt('customer', 'checking', '2026-09-25', 81000),
      expense('purchase', 'card', '2026-09-26', 8321),
    ],
  },
  {
    id: 'lifecycle-and-delayed-legs', about: 'pending and removed transfer legs plus a four-day posting delay',
    accounts: [checking(), savings(), card(), account('closed-savings', 'savings', '5555', { status: 'closed', closedOn: '2026-08-31', coverage: 'closed' })], rows: [
      ...move('delayed', 34000, '2026-09-04', '2026-09-08'),
      ...move('pending', 12000, '2026-09-11', '2026-09-12', { pending: true }),
      ...move('removed', 14000, '2026-09-14', '2026-09-15', { removed: true }),
      ...move('replaced', 16000, '2026-09-18', '2026-09-19', { superseded: true }),
      entry('ack-pending', 'card', '2026-09-23', 18000, 'inflow', 'card_payment', { description: 'PAYMENT THANK YOU', pending: true }),
      entry('ack-posted', 'card', '2026-09-24', 18000, 'inflow', 'card_payment', { description: 'PAYMENT THANK YOU' }),
      receipt('customer', 'checking', '2026-09-25', 110000),
      expense('purchase', 'checking', '2026-09-26', 9321),
    ],
  },
  {
    id: 'currencies-and-uncategorized-card-fees', about: 'separate currencies, an internal move, and uncategorized card payment fees',
    accounts: [checking(), savings(), card(), account('euro-checking', 'checking', '6666', { currency: 'EUR' }),
      account('euro-savings', 'savings', '7777', { currency: 'EUR' })], rows: [
      ...move('dollar-save', 37000, '2026-09-03'),
      ...payment('dollar-card', 24000, '2026-09-08'),
      receipt('dollar-income', 'checking', '2026-09-15', 123456),
      expense('dollar-purchase', 'card', '2026-09-16', 10203),
      // A fee is a separate posted expense, not the principal/interest split of
      // a repayment. The bank supplied no category; the full description says fee.
      expense('uncategorized-fee', 'checking', '2026-09-20', 495, { payee: null, description: 'CREDIT CARD PAYMENT FEE', category: null, categoryBasis: null }),
      expense('uncategorized-card-fee', 'card', '2026-09-21', 695, { payee: null, description: 'CARD PAYMENT FEE', category: null, categoryBasis: null }),
      receipt('euro-income', 'euro-checking', '2026-09-15', 123456, { currency: 'EUR' }),
      entry('euro-out', 'euro-checking', '2026-09-03', 37000, 'outflow', 'transfer', { currency: 'EUR', description: 'TRANSFER TO X7777' }),
      entry('euro-in', 'euro-savings', '2026-09-03', 37000, 'inflow', 'transfer', { currency: 'EUR', description: 'TRANSFER FROM X6666' }),
      expense('euro-purchase', 'euro-checking', '2026-09-16', 8701, { currency: 'EUR' }),
    ],
  },
];

// The reference reads only author-written book fields. It has no product imports,
// SQL, regex movement grammar, amount pairing, or product-derived expectations.
function visible(row) { return !row.pending && !row.removed && !row.superseded; }
function selected(book, spec) {
  return book.rows.filter(row => visible(row) && row.currency === spec.currency &&
    row.day >= spec.from && row.day <= spec.to && (!spec.acct || row.acct === spec.acct));
}
function expectedFigure(book, spec) {
  const rows = selected(book, spec);
  const sum = predicate => rows.reduce((total, row) => total + (predicate(row) ? row.cents : 0), 0);
  switch (spec.metric) {
    case 'income': return sum(row => row.event === 'income' && row.direction === 'inflow');
    case 'expense': return sum(row => row.event === 'expense' && row.direction === 'outflow');
    case 'surplus': return sum(row => row.event === 'income' && row.direction === 'inflow') - sum(row => row.event === 'expense' && row.direction === 'outflow');
    case 'gross-in': return sum(row => row.direction === 'inflow');
    case 'gross-out': return sum(row => row.direction === 'outflow');
    case 'cash-net': return sum(row => row.direction === 'inflow') - sum(row => row.direction === 'outflow');
    case 'transfer-out': return sum(row => row.event === 'transfer' && row.direction === 'outflow');
    case 'transfer-in': return sum(row => row.event === 'transfer' && row.direction === 'inflow');
    case 'payment-out': return sum(row => row.event === 'card_payment' && row.direction === 'outflow');
    case 'payment-in': return sum(row => row.event === 'card_payment' && row.direction === 'inflow');
    case 'covered-rows': return book.rows.filter(row => visible(row) && row.currency === spec.currency && (!spec.acct || row.acct === spec.acct)).length;
    default: throw new Error(`Unknown reference metric: ${spec.metric}`);
  }
}
function expectedCoverage(book, spec) {
  const accounts = book.accounts.filter(a => a.currency === spec.currency && (!spec.acct || a.slug === spec.acct));
  const slugs = new Set(accounts.map(a => a.slug));
  const rows = book.rows.filter(row => slugs.has(row.acct) && visible(row));
  return {
    accounts_covered: accounts.length,
    retained_rows: rows.length,
    incomplete_accounts: accounts.filter(a => a.coverage !== 'complete').length,
    unconfirmed_rows: rows.filter(row => row.basis !== 'confirmed').length,
  };
}
function expected(book, spec) {
  return { value_minor: expectedFigure(book, spec), ...expectedCoverage(book, spec) };
}

const expressions = {
  income: 'COALESCE(SUM(income_minor),0)', expense: 'COALESCE(SUM(expense_minor),0)',
  surplus: 'COALESCE(SUM(income_minor),0)-COALESCE(SUM(expense_minor),0)',
  'gross-in': "COALESCE(SUM(CASE WHEN direction='inflow' THEN amount_minor ELSE 0 END),0)",
  'gross-out': "COALESCE(SUM(CASE WHEN direction='outflow' THEN amount_minor ELSE 0 END),0)",
  'cash-net': "COALESCE(SUM(CASE WHEN direction='inflow' THEN amount_minor ELSE -amount_minor END),0)",
  'transfer-out': "COALESCE(SUM(CASE WHEN money_kind='own_transfer' AND direction='outflow' THEN amount_minor ELSE 0 END),0)",
  'transfer-in': "COALESCE(SUM(CASE WHEN money_kind='own_transfer' AND direction='inflow' THEN amount_minor ELSE 0 END),0)",
  'payment-out': "COALESCE(SUM(CASE WHEN money_kind='card_payment' AND direction='outflow' THEN amount_minor ELSE 0 END),0)",
  'payment-in': "COALESCE(SUM(CASE WHEN money_kind='card_payment' AND direction='inflow' THEN amount_minor ELSE 0 END),0)",
  'covered-rows': 'COALESCE(SUM(row_count),0)',
};
const literal = value => `'${value.replaceAll("'", "''")}'`;
function sqlFor(spec) {
  const scope = `currency=${literal(spec.currency)}` + (spec.acct ? ` AND account_slug=${literal(spec.acct)}` : '');
  const coverageSql = `SELECT COUNT(*) AS accounts_covered, COALESCE(SUM(row_count),0) AS retained_rows,
    COALESCE(SUM(CASE WHEN coverage_status='complete' THEN 0 ELSE 1 END),0) AS incomplete_accounts,
    COALESCE(SUM(unconfirmed_rows),0) AS unconfirmed_rows FROM coverage WHERE ${scope}`;
  const valueSql = spec.metric === 'covered-rows'
    ? `SELECT ${expressions[spec.metric]} AS value_minor FROM coverage WHERE ${scope}`
    : `SELECT ${expressions[spec.metric]} AS value_minor FROM txn
      WHERE ${scope} AND posted_on BETWEEN ${literal(spec.from)} AND ${literal(spec.to)}`;
  return `WITH answer AS (${valueSql}), limits AS (${coverageSql})
SELECT answer.value_minor, limits.* FROM answer CROSS JOIN limits`;
}
function questionsFor(book) {
  const scope = `For the book with ${book.about}, `;
  const questions = [];
  const add = (metric, question, extra = {}) => {
    const spec = { metric, question: scope + question, currency: 'USD', from: FROM, to: TO, ...extra };
    questions.push({ ...spec, sql: sqlFor(spec) });
  };
  add('income', 'how much new dollar income did I receive in September, leaving my own moves and card payments separate and including unresolved receipts provisionally?');
  add('expense', 'how much did I spend in September in dollars, leaving my own moves and card payments separate and including unresolved debits provisionally?');
  add('surplus', 'what was September dollar income minus ordinary spending, with unresolved entries included provisionally?');
  add('gross-in', 'how many dollars came into all my accounts during September, including my own moves and card payments?');
  add('gross-out', 'how many dollars left all my accounts during September, including my own moves and card payments?');
  add('cash-net', 'what were all September dollar credits minus all debits, including moves and card entries?');
  add('transfer-out', 'how many dollars went out as identified moves between my own deposit accounts during September, counting each outgoing leg once?');
  add('transfer-in', 'how many dollars came in as identified moves from my own deposit accounts during September, counting each incoming leg once?');
  add('payment-out', 'how many dollars went out toward my own card payments in September?');
  add('payment-in', 'how many dollars were recorded as payments received on my own cards in September?');
  add('covered-rows', 'how many posted dollar entries are available over all recorded dates, and how many accounts have incomplete coverage?');
  if (book.id === 'month-boundaries') {
    add('expense', 'how much ordinary dollar spending was recorded in August?', { from: '2026-08-01', to: '2026-08-31' });
    add('income', 'how much new dollar income was recorded in October?', { from: '2026-10-01', to: '2026-10-31' });
    add('payment-in', 'how many dollars of card payments landed in October?', { from: '2026-10-01', to: '2026-10-31' });
    add('transfer-out', 'how many dollars did checking send to my savings on September 30?', { from: TO, to: TO, acct: 'checking' });
  }
  if (book.id === 'partial-and-split') {
    add('transfer-in', 'how many dollars reached savings on September 4, before the second part arrived?', { from: '2026-09-04', to: '2026-09-04', acct: 'savings' });
    add('transfer-in', 'how many dollars reached savings on September 5 as the second part?', { from: '2026-09-05', to: '2026-09-05', acct: 'savings' });
    add('payment-in', 'how many dollars of the partial card payment have actually posted to the card?', { acct: 'card' });
  }
  if (book.id === 'unmatched-known-endpoints') {
    add('gross-out', 'how many dollars left checking even though some receiving legs are missing?', { acct: 'checking' });
    add('covered-rows', 'how many rows do you have for my empty savings account, and is its coverage complete?', { acct: 'empty-savings' });
  }
  if (book.id === 'currencies-and-uncategorized-card-fees') {
    add('income', 'how much new euro income arrived in September?', { currency: 'EUR' });
    add('expense', 'how much ordinary euro spending was recorded in September?', { currency: 'EUR' });
    add('transfer-out', 'how many euros moved out between my own deposit accounts in September?', { currency: 'EUR' });
    add('expense', 'how much ordinary dollar spending left checking on September 20, including the separate card payment fee?', { acct: 'checking', from: '2026-09-20', to: '2026-09-20' });
    add('expense', 'how much ordinary dollar spending hit my card on September 21, including the separate payment fee?', { acct: 'card', from: '2026-09-21', to: '2026-09-21' });
  }
  return questions;
}

function fixture(book) {
  const db = new DatabaseSync(':memory:');
  try {
    for (const sql of migrations) db.exec(sql);
    const run = (sql, ...args) => db.prepare(sql).run(...args);
    run(`INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
      VALUES ('business','Owner business','business','owned','owner_stated','confirmed',?)`, STAMP);
    for (const a of book.accounts) {
      run(`INSERT INTO fin_accounts(account_slug,entity_slug,label,account_kind,balance_role,mask,currency,
        feed_mode,status,closed_on,provenance,basis_state,recorded_at)
        VALUES (?,?,?,?,?,?,?,'manual',?,?,'owner_stated','confirmed',?)`,
      a.slug, a.entity, a.label, a.kind, a.kind === 'card' ? 'liability' : 'asset', a.mask, a.currency, a.status, a.closedOn ?? null, STAMP);
      run(`INSERT INTO fin_account_coverage(account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
        VALUES (?,?,?,?,?,'owner_stated','confirmed',?)`, a.slug, a.coverage,
      a.coverage === 'complete' ? '2026-08-01' : null, a.coverage === 'complete' ? '2026-10-31' : null, STAMP, STAMP);
    }
    for (const row of book.rows) {
      run(`INSERT INTO fin_transactions(txn_uid,account_slug,posted_on,amount_minor,direction,currency,
        description,payee,category,category_basis_state,pending,removed_at,removal_reason,superseded_by_id,
        provenance,basis_state,recorded_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'owner_stated',?,?)`,
      row.uid, row.acct, row.day, row.cents, row.direction, row.currency, row.description, row.payee,
      row.category, row.categoryBasis, Number(row.pending ?? false), row.removed ? STAMP : null,
      row.removed ? 'removed' : null, row.superseded ? 999999 : null, row.basis, STAMP);
    }
    const prepare = (sql, binds = []) => ({
      async all() { return { success: true, results: db.prepare(sql).all(...binds) }; },
      async first() { return db.prepare(sql).get(...binds) ?? null; },
      bind(...args) { return prepare(sql, args); },
    });
    return { db, env: { DB: { prepare } } };
  } catch (error) { db.close(); throw error; }
}
async function ask(env, spec) {
  try {
    const response = await handleMoneyQuery(env, new Request('https://brain.invalid/api/admin/brain/money-query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql: spec.sql, max_rows: 200 }),
    }));
    const body = await response.json();
    if (response.status !== 200 || body.truncated || body.row_count !== 1 || !body.rows?.[0]) {
      return { status: 'failed', actual: { http: response.status, code: body.code ?? null, rows: body.rows ?? null, truncated: body.truncated ?? null } };
    }
    const actual = { ...body.rows[0] };
    if (!Object.values(actual).every(Number.isSafeInteger)) return { status: 'failed', actual };
    return { actual };
  } catch (error) { return { status: 'failed', actual: { code: error.code ?? error.name } }; }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function evaluate(book, spec, env) {
  const want = expected(book, spec), result = await ask(env, spec);
  return { book: book.id, spec, expected: want, ...result, status: result.status ?? (same(want, result.actual) ? 'right' : 'wrong') };
}

// Reduce witnesses by deleting unrelated rows and replaying the SAME SQL through
// the real handler. Bank-only two-leg operations remain evidence-complete.
// Replays are diagnostic minimization, never added to the question counts.
async function minimize(book, failure) {
  let rows = [...book.rows];
  for (const key of new Set(rows.map(row => row.bundle ?? row.uid))) {
    const trial = rows.filter(row => (row.bundle ?? row.uid) !== key);
    const reduced = { ...book, rows: trial }, f = fixture(reduced);
    try {
      const result = await evaluate(reduced, failure.spec, f.env);
      if (result.status === failure.status && (result.status !== 'wrong' || result.actual.value_minor !== result.expected.value_minor)) rows = trial;
    } finally { f.db.close(); }
  }
  const reduced = { ...book, rows }, f = fixture(reduced);
  try {
    const result = await evaluate(reduced, failure.spec, f.env);
    const response = await handleMoneyQuery(f.env, new Request('https://brain.invalid/api/admin/brain/money-query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        sql: 'SELECT txn_uid,money_kind,movement_classification,estimated,income_minor,expense_minor FROM txn ORDER BY id',
      }),
    }));
    return { ...result, rows, accounts: book.accounts, tags: (await response.json()).rows ?? [] };
  } finally { f.db.close(); }
}
const sourceLine = (name, needle) => {
  const lines = readFileSync(new URL(`../src/lib/${name}`, import.meta.url), 'utf8').split('\n');
  const index = lines.findIndex(line => line.includes(needle));
  assert.ok(index >= 0, `Report source anchor exists: ${name}`);
  return `worker/src/lib/${name}:${index + 1}`;
};
function cause(witness) {
  if (witness.status === 'failed') return 'The real route refused or failed; no figure was certified.';
  const fees = witness.rows.some(row => row.event === 'expense' && /PAYMENT FEE$/.test(row.description ?? '') && !row.category);
  if (fees) {
    return `${sourceLine('clean-money.js', "CASE WHEN direction='outflow' AND movement_kind='ordinary'")} counts spending only for ordinary movements; ` +
      `${sourceLine('clean-money.js', 'const {classification,money_kind} = moneyMovementReading')} supplies the shared tag. ` +
      `${sourceLine('ledger-analysis.js', 'if (channel && !hasExplicitExpenseCategory(row)')} treats the description's payment prefix as a provisional repayment, ` +
      `while ${sourceLine('ledger-analysis.js', 'const hasExplicitExpenseCategory = row =>')} checks expense words only in category. ` +
      'The separate uncategorized fee becomes card_payment (estimated=1), suppressing its spending and/or inflating the payment total.';
  }
  return `${sourceLine('clean-money.js', 'const {classification,money_kind} = moneyMovementReading')} supplies membership; ` +
    `${sourceLine('clean-money.js', "CASE WHEN direction='inflow' AND movement_kind='ordinary'")} and ` +
    `${sourceLine('clean-money.js', "CASE WHEN direction='outflow' AND movement_kind='ordinary'")} count only ordinary inflows/outflows. ` +
    `The actual row tags below show which reference operation was counted in a different bucket.`;
}
function report(counts, witnesses, complete, error = null) {
  const lines = [complete ? 'READY' : 'NOT READY',
    `questions=${counts.questions} right=${counts.right} wrong=${counts.wrong} failed=${counts.failed}`, '',
    'Synthetic offline finder: 12 owner books; integer minor units (USD cents unless the question says EUR).',
    'Each question runs its written SQL through the real handleMoneyQuery POST handler on migrated node:sqlite.',
    'Expected figures come only from reference event labels and book rows; product classifiers and SQL never compute expectations.',
    'Every answer also compares independent account, retained-row, incomplete-coverage and unconfirmed-row counts.',
    'Unproved movements stay provisionally counted; endpoint-identified movements and payments stay separate. Findings fail their subtests; READY means the finder completed.',
    'Credential/authentication and model SQL generation are outside this experiment. No external service is called.', ''];
  if (error) lines.push(`Harness error: ${error.name}`, '');
  for (const [i, witness] of witnesses.entries()) {
    lines.push(`${i + 1}. ${witness.book}: ${witness.spec.question}`, '',
      `Accounts: ${JSON.stringify(witness.accounts.map(a => ({ account: a.slug, kind: a.kind, mask: a.mask, currency: a.currency, owned: true, coverage: a.coverage })))}`, '',
      'Rows (event is reference-only; all other displayed row fields are loaded into the fixture):', '```json',
      JSON.stringify(witness.rows.map(row => ({ uid: row.uid, account: row.acct, date: row.day, cents: row.cents,
        direction: row.direction, currency: row.currency, description: row.description, payee: row.payee,
        category: row.category, category_basis_state: row.categoryBasis, event: row.event,
        ...(row.pending ? { pending: true } : {}), ...(row.removed ? { removed: true } : {}),
        ...(row.superseded ? { superseded: true } : {}) })), null, 2), '```',
      'SQL:', '```sql', witness.spec.sql, '```',
      `Expected: ${JSON.stringify(witness.expected)}`, `Actual SQL result: ${JSON.stringify(witness.actual)}`,
      `Actual clean rows: ${JSON.stringify(witness.tags)}`, `Clean-view rule: ${cause(witness)}`, '');
  }
  if (!witnesses.length && complete) lines.push('No failing inputs.', '');
  lines.push(complete ? 'LANE PRO-TOOLS-FINDER-TRANSFERS-1112: READY' : 'LANE PRO-TOOLS-FINDER-TRANSFERS-1112: NOT READY finder did not complete');
  writeFileSync(REPORT, lines.join('\n') + '\n');
}

test('transfer finder compares every owner question with an independent book answer', async t => {
  const counts = { questions: 0, right: 0, wrong: 0, failed: 0 }, failures = [];
  let complete = false, harnessError = null;
  try {
    assert.ok(books.length >= 8);
    assert.ok(books.reduce((n, book) => n + questionsFor(book).length, 0) >= 60);
    assert.equal(new Set(books.flatMap(questionsFor).map(spec => spec.question)).size, books.flatMap(questionsFor).length);
    for (const book of books) {
      const f = fixture(book);
      try {
        for (const spec of questionsFor(book)) {
          const result = await evaluate(book, spec, f.env);
          counts.questions++; counts[result.status]++;
          if (result.status !== 'right') failures.push(result);
          await t.test(`${book.id}: ${spec.question}`, () => {
            assert.equal(result.status, 'right', JSON.stringify({ question: spec.question, sql: spec.sql,
              expected: result.expected, actual: result.actual, outcome: result.status }));
          });
        }
      } finally { f.db.close(); }
    }
    complete = true;
  } catch (error) { harnessError = error; }
  const witnesses = [];
  try {
    // One witness per book/metric prevents the same aggregate from filling the
    // report. Give narrow, single-account questions first choice for reduction.
    const chosen = new Set();
    for (const failure of failures.sort((a, b) => Number(Boolean(b.spec.acct)) - Number(Boolean(a.spec.acct)))) {
      const key = `${failure.book}/${failure.spec.metric}`;
      if (chosen.has(key) || witnesses.length === 10) continue;
      chosen.add(key);
      witnesses.push(await minimize(books.find(book => book.id === failure.book), failure));
    }
  } catch (error) { complete = false; harnessError ??= error; }
  report(counts, witnesses, complete, harnessError);
  t.diagnostic(`books=${books.length} questions=${counts.questions} right=${counts.right} wrong=${counts.wrong} failed=${counts.failed}`);
  assert.equal(counts.questions, counts.right + counts.wrong + counts.failed);
  if (harnessError) throw harnessError;
  assert.ok(complete, 'The finder and report completed');
});
