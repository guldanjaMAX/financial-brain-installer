import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { handleMoneyQuery } from '../src/lib/money-query.js';
import { handleMcp } from '../src/lib/mcp-endpoint.js';

// This is a finder, not an assertion that today's figures are all correct.
// Product errors are observations; an incomplete run or a broken oracle fails
// the test. No product classifier, SQL result, or clean-view helper supplies an
// expected answer. Only the synthetic book's independently declared events do.
const REPORT = new URL('../../.lane-scratch/finder-tools-payouts-refunds-1112.md', import.meta.url);
mkdirSync(new URL('.', REPORT), { recursive: true });
const AT = '2026-11-01T12:00:00Z';
const FROM = '2026-10-01', TO = '2026-10-31';
const migrations = readdirSync(new URL('../../migrations/d1/', import.meta.url))
  .filter(name => name.endsWith('.sql')).sort()
  .map(name => readFileSync(new URL(`../../migrations/d1/${name}`, import.meta.url), 'utf8'));
const bank = { slug: 'bank', kind: 'checking', entity: 'business', currency: 'USD' };
const account = (slug, kind = 'checking', currency = 'USD', entity = 'business') => ({ slug, kind, currency, entity });
function row(uid, event, cents, direction, description, extra = {}) {
  return { uid, event, cents, direction, description, account: 'bank', day: '2026-10-05',
    currency: 'USD', payee: null, category: null, state: 'posted', ...extra };
}
const books = [
  {
    id: 'net-only', label: 'bank-only net payout', accounts: [bank], rows: [
      row('payout-one', 'payout', 97000, 'inflow', 'Stripe payout batch 01', { payee: 'Stripe', processor: 'stripe' }),
      row('payout-two', 'payout', 48500, 'inflow', 'Stripe payout batch 02', { day: '2026-10-19', payee: 'Stripe', processor: 'stripe' }),
    ],
  },
  {
    id: 'gross-plus-fee', label: 'gross settlement and separate fee', accounts: [bank], rows: [
      row('gross-settlement', 'payout', 120000, 'inflow', 'Square payout gross sales', { payee: 'Square', processor: 'square', category: 'GROSS_SALES' }),
      row('processing-fee', 'fee', 3600, 'outflow', 'Square processing fee', { payee: 'Square', category: 'PROCESSOR_FEES' }),
      row('rent', 'expense', 20000, 'outflow', 'Rent', { payee: 'Landlord', category: 'RENT' }),
      row('customer-refund', 'customer_refund', 15000, 'outflow', 'Square customer refund', { payee: 'Square', category: 'CUSTOMER_REFUND' }),
    ],
  },
  {
    id: 'clearing-account', label: 'processor clearing account',
    accounts: [bank, account('processor', 'merchant')], rows: [
      row('gross-sales', 'sale', 100000, 'inflow', 'Customer sales', { account: 'processor', payee: 'Customer', category: 'GROSS_SALES' }),
      row('withheld-fee', 'fee', 3000, 'outflow', 'Stripe processing fees', { account: 'processor', payee: 'Stripe', category: 'PROCESSOR_FEES' }),
      row('settlement-out', 'own_move', 97000, 'outflow', 'Stripe payout to owner bank', { account: 'processor', payee: 'Stripe', category: 'TRANSFER_OUT', group: 'settlement' }),
      row('settlement-in', 'own_move', 97000, 'inflow', 'Stripe payout from owner processor', { payee: 'Stripe', processor: 'stripe', category: 'TRANSFER_IN', group: 'settlement' }),
    ],
  },
  {
    id: 'two-refund-directions', label: 'customer and supplier refund', accounts: [bank], rows: [
      row('payout', 'payout', 77333, 'inflow', 'Stripe payout batch 03', { payee: 'Stripe', processor: 'stripe' }),
      row('supplies', 'expense', 24000, 'outflow', 'Supplies purchase', { payee: 'Supplier', category: 'SUPPLIES' }),
      row('supplier-refund', 'supplier_refund', 6000, 'inflow', 'Partial refund for supplies', { payee: 'Supplier', category: 'SUPPLIES' }),
      row('customer-refund', 'customer_refund', 10500, 'outflow', 'Customer refund', { payee: 'Customer', category: 'CUSTOMER_REFUND' }),
      row('fee-refund', 'fee_refund', 1800, 'inflow', 'Stripe processing fee refund', { payee: 'Stripe', category: 'FEE_REFUND' }),
    ],
  },
  {
    id: 'refund-cancelled', label: 'cancelled customer refund', accounts: [bank], rows: [
      row('payout', 'payout', 88001, 'inflow', 'PayPal payout batch 04', { payee: 'PayPal', processor: 'paypal' }),
      row('refund-sent', 'customer_refund', 12555, 'outflow', 'PayPal customer refund', { payee: 'PayPal', category: 'CUSTOMER_REFUND' }),
      row('refund-returned', 'customer_refund_cancel', 12555, 'inflow', 'PayPal customer refund reversed', { payee: 'PayPal', category: 'REFUND_REVERSAL' }),
    ],
  },
  {
    id: 'chargeback-lost', label: 'lost chargeback', accounts: [bank], rows: [
      row('payout', 'payout', 155555, 'inflow', 'Shopify payout batch 05', { payee: 'Shopify', processor: 'shopify' }),
      row('disputed-principal', 'chargeback', 25000, 'outflow', 'Shopify chargeback principal', { payee: 'Shopify', category: 'CHARGEBACK' }),
      row('dispute-fee', 'fee', 1500, 'outflow', 'Shopify dispute fee', { payee: 'Shopify', category: 'CHARGEBACK_FEE' }),
      row('office', 'expense', 11111, 'outflow', 'Office supplies purchase', { payee: 'Supplier', category: 'SUPPLIES' }),
    ],
  },
  {
    id: 'chargeback-won', label: 'won chargeback', accounts: [bank], rows: [
      row('payout', 'payout', 188888, 'inflow', 'Stripe payout batch 06', { payee: 'Stripe', processor: 'stripe' }),
      row('disputed-principal', 'chargeback', 20000, 'outflow', 'Stripe disputed sale principal', { payee: 'Stripe', category: 'CHARGEBACK' }),
      row('principal-recovered', 'chargeback_recovery', 20000, 'inflow', 'Stripe dispute won', { payee: 'Stripe', category: 'CHARGEBACK_RECOVERY' }),
      row('dispute-fee', 'fee', 1500, 'outflow', 'Stripe dispute fee', { payee: 'Stripe', category: 'CHARGEBACK_FEE' }),
      row('fee-recovered', 'fee_refund', 1500, 'inflow', 'Stripe dispute fee reversal', { payee: 'Stripe', category: 'FEE_REVERSAL' }),
    ],
  },
  {
    id: 'payout-return-retry', label: 'returned and retried payout', accounts: [bank], rows: [
      row('payout-returned', 'cancelled_payout', 64000, 'inflow', 'Square payout batch 07 later returned', { day: '2026-10-01', payee: 'Square', processor: 'square', group: 'returned-attempt' }),
      row('payout-debit', 'payout_return', 64000, 'outflow', 'Square payout reversal batch 07', { day: '2026-10-02', payee: 'Square', category: 'PAYOUT_REVERSAL', group: 'returned-attempt' }),
      row('payout-retry', 'payout', 64000, 'inflow', 'Square payout batch 07 retry', { day: '2026-10-03', payee: 'Square', processor: 'square' }),
    ],
  },
  {
    id: 'adjusted-payout', label: 'refund-adjusted payout and lifecycle',
    accounts: [bank, account('euro-bank', 'checking', 'EUR'), account('personal', 'checking', 'USD', 'household')], rows: [
      row('adjusted-sales', 'payout', 91000, 'inflow', 'Stripe payout sales including refund adjustments', { payee: 'Stripe', processor: 'stripe', category: 'SALES' }),
      row('supplier-refund', 'supplier_refund', 7555, 'inflow', 'Refund for supplies', { payee: 'Supplier', category: 'SUPPLIES' }),
      row('fee', 'fee', 2200, 'outflow', 'Stripe processing fees', { payee: 'Stripe', category: 'PROCESSOR_FEES' }),
      row('pending-payout', 'payout', 88000, 'inflow', 'Stripe payout pending', { payee: 'Stripe', processor: 'stripe', state: 'pending' }),
      row('removed-fee', 'fee', 1100, 'outflow', 'Stripe fee withdrawn', { payee: 'Stripe', state: 'removed' }),
      row('old-payout', 'payout', 70000, 'inflow', 'Stripe payout old version', { payee: 'Stripe', processor: 'stripe', state: 'superseded' }),
      row('euro-payout', 'payout', 12345, 'inflow', 'Stripe payout euro', { account: 'euro-bank', currency: 'EUR', payee: 'Stripe', processor: 'stripe' }),
      row('personal-payout', 'payout', 54000, 'inflow', 'PayPal payout personal', { account: 'personal', payee: 'PayPal', processor: 'paypal' }),
    ],
  },
  {
    id: 'processor-labels', label: 'changing processor label', accounts: [bank], rows: [
      row('stripe-exact', 'payout', 50001, 'inflow', 'Stripe payout batch 08', { payee: 'Stripe', processor: 'stripe' }),
      row('stripe-label', 'payout', 70003, 'inflow', 'ACH sales settlement', { payee: 'Stripe, Inc.', processor: 'stripe', category: 'SALES' }),
      row('square-caps', 'payout', 90002, 'inflow', 'SQUARE PAYOUT BATCH 09', { payee: 'SQUARE', processor: 'square' }),
      row('paypal-memo', 'payout', 30007, 'inflow', 'paypal transfer batch 10', { processor: 'paypal', category: 'SALES' }),
      row('shopify-label', 'payout', 60009, 'inflow', 'ACH sales settlement', { payee: 'SHOPIFY PAYMENTS', processor: 'shopify', category: 'SALES' }),
    ],
  },
];

// These are book facts, not attempted reconstructions of the product grammar.
// In the clearing book, the two settlement legs are one internal movement.
// In the retry book, the returned first attempt never earns income. Gross bank
// activity still includes every posted leg, including that failed attempt.
function scope(book, { from = FROM, to = TO, currency = 'USD', kind } = {}) {
  const accounts = new Map(book.accounts.map(a => [a.slug, a]));
  return book.rows.filter(r => r.state === 'posted' && r.currency === currency && r.day >= from && r.day <= to &&
    accounts.get(r.account)?.entity === 'business' && (!kind || accounts.get(r.account).kind === kind));
}
function sum(rows, predicate = () => true, signed = false) {
  const result = rows.filter(predicate).reduce((n, r) => n + BigInt(r.cents) * (signed && r.direction === 'outflow' ? -1n : 1n), 0n);
  assert.ok(result <= BigInt(Number.MAX_SAFE_INTEGER) && result >= BigInt(Number.MIN_SAFE_INTEGER));
  return Number(result);
}
const receipts = new Set(['payout', 'sale', 'cancelled_payout']);
const returned = new Set(['supplier_refund', 'customer_refund_cancel', 'chargeback_recovery', 'fee_refund']);
const expenses = new Set(['fee', 'expense']);
// A returned payout reduces income on its posting day, including when the receipt was in an earlier period.
const outsideIncome = book => sum(scope(book), r => receipts.has(r.event)) - sum(scope(book), r => r.event === 'payout_return');
const isPayoutCredit = r => r.direction === 'inflow' && Boolean(r.processor);
const centsOf = (events, direction) => book => sum(scope(book), r => events.has(r.event) && (!direction || r.direction === direction));

function fixture(book) {
  const db = new DatabaseSync(':memory:');
  try {
    for (const sql of migrations) db.exec(sql);
    const run = (sql, ...args) => db.prepare(sql).run(...args);
    for (const [entity, kind] of [['business', 'business'], ['household', 'household']])
      run(`INSERT INTO fin_entities(entity_slug,legal_name,kind,provenance,basis_state,recorded_at)
        VALUES (?,?,?,'owner_stated','confirmed',?)`, entity, 'Owner ' + entity, kind, AT);
    for (const a of book.accounts) {
      run(`INSERT INTO fin_accounts(account_slug,entity_slug,label,account_kind,balance_role,currency,
        feed_mode,provenance,basis_state,recorded_at) VALUES (?,?,?,?,'asset',?,'manual','owner_stated','confirmed',?)`,
      a.slug, a.entity, 'Owner ' + a.slug, a.kind, a.currency, AT);
      run(`INSERT INTO fin_account_coverage(account_slug,coverage_status,covered_from,covered_to,
        provenance,basis_state,computed_at,recorded_at) VALUES (?,'complete',?,?,'owner_stated','confirmed',?,?)`, a.slug, FROM, TO, AT, AT);
    }
    for (const r of book.rows)
      run(`INSERT INTO fin_transactions(txn_uid,account_slug,posted_on,amount_minor,direction,currency,
        description,payee,category,category_basis_state,pending,removed_at,removal_reason,superseded_by_id,
        provenance,basis_state,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,'confirmed',?,?,?,?, 'owner_stated','confirmed',?)`,
      r.uid, r.account, r.day, r.cents, r.direction, r.currency, r.description, r.payee, r.category,
      Number(r.state === 'pending'), r.state === 'removed' ? AT : null, r.state === 'removed' ? 'withdrawn' : null,
      r.state === 'superseded' ? 1 : null, AT);
    let reads = 0;
    const statement = (sql, binds = []) => ({
      bind: (...args) => statement(sql, args),
      all: async () => { reads++; return { success: true, results: db.prepare(sql).all(...binds) }; },
    });
    // Only D1's transport is adapted. Validation, scan guards, clean snapshots,
    // membership, parameter binding and final execution are product code.
    return { db, env: { DB: { prepare: sql => statement(sql) } }, get reads() { return reads; } };
  } catch (error) { db.close(); throw error; }
}

async function execute(f, sql, both = true) {
  const changes = f.db.prepare('SELECT total_changes() AS n').get().n;
  const before = f.reads;
  const request = new Request('https://brain.invalid/api/admin/brain/money-query', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql, max_rows: 200 }),
  });
  // This is the real POST handler used by index.js, below its authentication
  // boundary. No authentication ceremony or credential is needed in this finder.
  const response = await handleMoneyQuery(f.env, request);
  const result = await response.json();
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n, changes, 'route must remain read-only');
  assert.ok(f.reads > before, 'real route reached SQLite');
  if (!response.ok) return { failed: true, status: response.status, code: result.code };
  assert.equal(result.truncated, false, 'small synthetic answers must not truncate');
  assert.equal(result.row_count, 1, 'every owner query returns one scalar figure with coverage');
  assert.equal(result.rows.length, 1);
  if (both) {
    const url = new URL('https://brain.invalid/mcp');
    const rpc = await handleMcp(f.env, new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'brain_money_query', arguments: { sql } } }),
    }), url, { grant: { profile: 'owner-assistant' } });
    const envelope = await rpc.json();
    if (!rpc.ok || envelope.error || envelope.result?.isError)
      return { failed: true, status: rpc.status, code: 'MCP_TOOL_REFUSAL', result: envelope };
    const tool = JSON.parse(envelope.result.content[0].text);
    assert.deepEqual(tool.rows, result.rows, 'actual brain_money_query dispatch agrees with POST handler');
    assert.equal(tool.truncated, false);
    assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n, changes, 'MCP tool must remain read-only');
  }
  return { failed: false, row: result.rows[0] };
}

function question(book, key, text, expression, oracle, { from = FROM, to = TO, currency = 'USD', kind, rule } = {}) {
  const accountClause = kind ? ` AND account_kind='${kind}'` : '';
  const sql = `WITH selected AS (SELECT * FROM txn WHERE side='business' AND currency='${currency}'
  AND posted_on BETWEEN '${from}' AND '${to}'${accountClause})
SELECT ${expression} AS value,
  ${zeroSum("CASE WHEN estimated=1 THEN 1 ELSE 0 END")} AS estimated_rows,
  ${zeroSum("CASE WHEN estimated=1 AND direction='inflow' THEN amount_minor ELSE 0 END")} AS estimated_in_minor,
  ${zeroSum("CASE WHEN estimated=1 AND direction='outflow' THEN amount_minor ELSE 0 END")} AS estimated_out_minor,
  (SELECT count(*) FROM coverage WHERE side='business' AND currency='${currency}') AS accounts,
  (SELECT count(*) FROM coverage WHERE side='business' AND currency='${currency}'
    AND coverage_status='complete' AND covered_from<='${from}' AND covered_to>='${to}') AS covered_accounts
FROM selected`;
  const expected = b => ({ value: oracle(b),
    accounts: b.accounts.filter(a => a.entity === 'business' && a.currency === currency).length,
    covered_accounts: b.accounts.filter(a => a.entity === 'business' && a.currency === currency && from >= FROM && to <= TO).length });
  return { id: `${book.id}/${key}`, question: `In my ${book.label} book, ${text}`, sql, expected, rule };
}
const zeroSum = expr => `COALESCE(SUM(${expr}),0)`;
// Estimates are product disclosures, not expected economic facts. Compare the
// requested figure and independently known coverage, retaining the estimate
// columns verbatim alongside every observation and minimized SQL result.
const comparable = actual => ({ value: actual.value, accounts: actual.accounts, covered_accounts: actual.covered_accounts });
const matches = (actual, expected) => isDeepStrictEqual(comparable(actual), expected);
const refundRule = 'outgoing-refund';
function commonQuestions(b) {
  const q = (key, text, expr, oracle, options) => question(b, key, text, expr, oracle, options);
  return [
    q('bank-in', 'how much cash came into my bank in October?', zeroSum("CASE WHEN direction='inflow' THEN amount_minor ELSE 0 END"),
      x => sum(scope(x, { kind: 'checking' }), r => r.direction === 'inflow'), { kind: 'checking' }),
    q('bank-out', 'how much cash left my bank in October, including refunds and disputes?', zeroSum("CASE WHEN direction='outflow' THEN amount_minor ELSE 0 END"),
      x => sum(scope(x, { kind: 'checking' }), r => r.direction === 'outflow'), { kind: 'checking' }),
    q('bank-net', 'what was the change from money in minus money out at my bank in October?', zeroSum("CASE WHEN direction='inflow' THEN amount_minor ELSE -amount_minor END"),
      x => sum(scope(x, { kind: 'checking' }), () => true, true), { kind: 'checking' }),
    q('income', 'how much outside income was recorded in October, excluding refunds, dispute recoveries, cancelled payouts and moves between my accounts?',
      zeroSum('income_minor'), outsideIncome, { rule: 'income' }),
    q('spending', 'how much were October running expenses and fees, keeping customer refunds, disputed principal and payout returns separate?',
      zeroSum('expense_minor'), centsOf(expenses), { rule: 'expense' }),
    q('payout-credits', 'how much in processor payout credits hit my bank in October, before any later payout returns?',
      zeroSum("CASE WHEN processor IS NOT NULL AND direction='inflow' THEN amount_minor ELSE 0 END"),
      x => sum(scope(x, { kind: 'checking' }), isPayoutCredit), { kind: 'checking', rule: 'payout' }),
    q('returned-credits', 'how much came back in October as refunds or reversals, including recovered disputes, separate from sales income?',
      zeroSum("CASE WHEN money_kind='refund' AND direction='inflow' THEN amount_minor ELSE 0 END"),
      centsOf(returned, 'inflow'), { rule: 'returned-credit' }),
    q('customer-refunds', 'how much did I send back as customer refunds in October, before cancellations?',
      zeroSum("CASE WHEN money_kind='refund' AND direction='outflow' AND category='CUSTOMER_REFUND' THEN amount_minor ELSE 0 END"),
      centsOf(new Set(['customer_refund']), 'outflow'), { rule: refundRule }),
    q('posted-rows', 'how many posted business transactions are in my October USD records?', 'COUNT(*)', x => scope(x).length),
    q('coverage', 'how many of my USD business accounts have complete October records?',
      `(SELECT count(*) FROM coverage WHERE side='business' AND currency='USD' AND coverage_status='complete'
        AND covered_from<='${FROM}' AND covered_to>='${TO}')+0*COUNT(*)`,
      x => x.accounts.filter(a => a.entity === 'business' && a.currency === 'USD').length),
  ];
}
function extraQuestions(b) {
  const q = (key, text, expr, oracle, options) => question(b, key, text, expr, oracle, options);
  const fees = zeroSum("CASE WHEN direction='outflow' AND category='PROCESSOR_FEES' THEN amount_minor ELSE 0 END");
  switch (b.id) {
    case 'net-only': return [
      q('gross-unknown', 'can these net deposits establish my gross sales before withheld fees?',
        "CASE WHEN SUM(CASE WHEN category='GROSS_SALES' THEN 1 ELSE 0 END)>0 THEN SUM(CASE WHEN category='GROSS_SALES' THEN amount_minor ELSE 0 END) ELSE NULL END",
        x => { const gross = scope(x).filter(r => r.category === 'GROSS_SALES'); return gross.length ? sum(gross) : null; }),
      q('withheld-fees-unknown', 'can these net deposits establish the fees withheld by the processor?',
        "CASE WHEN SUM(CASE WHEN category='PROCESSOR_FEES' THEN 1 ELSE 0 END)>0 THEN SUM(CASE WHEN category='PROCESSOR_FEES' THEN amount_minor ELSE 0 END) ELSE NULL END",
        x => { const feeRows = scope(x).filter(r => r.event === 'fee'); return feeRows.length ? sum(feeRows) : null; }),
    ];
    case 'gross-plus-fee': return [
      q('gross-sales', 'what gross sales are explicitly recorded before separate fees and customer refunds?',
        zeroSum("CASE WHEN category='GROSS_SALES' AND direction='inflow' THEN amount_minor ELSE 0 END"),
        x => sum(scope(x), r => r.event === 'payout')),
      q('net-after-fees', 'how much of the gross settlement remained after separately charged processing fees, before refunds?',
        `${zeroSum("CASE WHEN money_kind='payout' THEN amount_minor ELSE 0 END")}-${fees}`,
        x => sum(scope(x), r => r.event === 'payout') - sum(scope(x), r => r.event === 'fee'), { rule: 'payout' }),
    ];
    case 'clearing-account': return [
      q('clearing-gross', 'what gross customer sales are recorded in the processor account?',
        zeroSum("CASE WHEN account_slug='processor' AND category='GROSS_SALES' THEN amount_minor ELSE 0 END"),
        centsOf(new Set(['sale']))),
      q('outside-in-after-fee', 'what outside receipts less processing fees remain across my bank and processor accounts, without counting settlement twice?',
        `${zeroSum('income_minor')}-${fees}`, x => sum(scope(x), r => receipts.has(r.event)) - sum(scope(x), r => r.event === 'fee'), { rule: 'income' }),
    ];
    case 'two-refund-directions': return [
      q('net-supplies', 'what did supplies cost after the supplier refund?',
        zeroSum("CASE WHEN category='SUPPLIES' THEN expense_minor-CASE WHEN money_kind='refund' THEN amount_minor ELSE 0 END ELSE 0 END"),
        x => sum(scope(x), r => r.event === 'expense') - sum(scope(x), r => r.event === 'supplier_refund'), { rule: 'expense' }),
      q('refund-both-ways', 'what is the signed refund cash movement, money returned to me less customer refunds I sent?',
        zeroSum("CASE WHEN money_kind='refund' THEN CASE WHEN direction='inflow' THEN amount_minor ELSE -amount_minor END ELSE 0 END"),
        x => sum(scope(x), r => returned.has(r.event)) - sum(scope(x), r => r.event === 'customer_refund'), { rule: refundRule }),
    ];
    case 'refund-cancelled': return [
      q('net-refunds', 'what was the net cash effect of the customer refund and its cancellation?',
        zeroSum("CASE WHEN money_kind='refund' THEN CASE WHEN direction='inflow' THEN amount_minor ELSE -amount_minor END ELSE 0 END"),
        x => sum(scope(x), r => ['customer_refund', 'customer_refund_cancel'].includes(r.event), true), { rule: refundRule }),
      q('paypal-payout-only', 'how much did PayPal pay out from sales, excluding the cancelled-refund credit?',
        zeroSum("CASE WHEN payer_group='processor:paypal' AND money_kind='payout' THEN amount_minor ELSE 0 END"),
        x => sum(scope(x), r => r.event === 'payout' && r.processor === 'paypal'), { rule: 'payout' }),
    ];
    case 'chargeback-lost': return [
      q('principal', 'how much sale principal was taken for the lost chargeback, excluding the dispute fee?',
        zeroSum("CASE WHEN category='CHARGEBACK' AND direction='outflow' THEN amount_minor ELSE 0 END"), centsOf(new Set(['chargeback']))),
      q('dispute-fee', 'what fee did the lost chargeback cost, separate from sale principal?',
        zeroSum("CASE WHEN category='CHARGEBACK_FEE' AND direction='outflow' THEN expense_minor ELSE 0 END"), centsOf(new Set(['fee']))),
    ];
    case 'chargeback-won': return [
      q('recovered-principal', 'how much disputed principal was recovered when the dispute was won?',
        zeroSum("CASE WHEN category='CHARGEBACK_RECOVERY' AND direction='inflow' THEN amount_minor ELSE 0 END"), centsOf(new Set(['chargeback_recovery']))),
      q('net-dispute', 'what was the net cash effect of the disputed principal, its recovery, the fee and the fee reversal?',
        zeroSum("CASE WHEN category IN ('CHARGEBACK','CHARGEBACK_RECOVERY','CHARGEBACK_FEE','FEE_REVERSAL') THEN CASE WHEN direction='inflow' THEN amount_minor ELSE -amount_minor END ELSE 0 END"),
        x => sum(scope(x), r => ['chargeback', 'chargeback_recovery', 'fee', 'fee_refund'].includes(r.event), true)),
    ];
    case 'payout-return-retry': return [
      q('after-return', 'how much payout cash remained after the failed payout was returned and retried?',
        zeroSum("CASE WHEN direction='inflow' THEN amount_minor ELSE -amount_minor END"), x => sum(scope(x), () => true, true)),
      q('return-day-income', 'what was the income contribution on the day the failed payout was returned?',
        zeroSum('income_minor'), x => sum(scope(x, { from: '2026-10-02', to: '2026-10-02' }), r => receipts.has(r.event)) - sum(scope(x, { from: '2026-10-02', to: '2026-10-02' }), r => r.event === 'payout_return'),
        { from: '2026-10-02', to: '2026-10-02', rule: 'income' }),
    ];
    case 'adjusted-payout': return [
      q('euro-payout', 'how many euro cents of processor payouts arrived, keeping euros separate from dollars?',
        zeroSum("CASE WHEN money_kind='payout' THEN amount_minor ELSE 0 END"),
        x => sum(scope(x, { currency: 'EUR' }), isPayoutCredit), { currency: 'EUR', rule: 'payout' }),
      q('exclude-stale-payouts', 'how much posted Stripe payout money is left after excluding pending and withdrawn versions?',
        zeroSum("CASE WHEN processor='stripe' AND money_kind='payout' THEN amount_minor ELSE 0 END"),
        x => sum(scope(x), isPayoutCredit), { rule: 'payout' }),
    ];
    case 'processor-labels': return [
      q('stripe-group', 'how much did Stripe pay out across its different bank labels?',
        zeroSum("CASE WHEN payer_group='processor:stripe' THEN amount_minor ELSE 0 END"),
        x => sum(scope(x), r => r.processor === 'stripe'), { rule: 'payout' }),
      q('shopify-group', 'how much did Shopify pay out under the payments label?',
        zeroSum("CASE WHEN payer_group='processor:shopify' THEN amount_minor ELSE 0 END"),
        x => sum(scope(x), r => r.processor === 'shopify'), { rule: 'payout' }),
    ];
    default: assert.fail('Every book needs its own owner questions');
  }
}

// Line locations are resolved against the reviewed source at run time so report
// citations remain exact without importing product decisions into the oracle.
function sourceLine(file, needle) {
  const lines = readFileSync(new URL('../../' + file, import.meta.url), 'utf8').split('\n');
  const index = lines.findIndex(line => line.includes(needle));
  assert.ok(index >= 0, `Missing rule location: ${file}`);
  return `${file}:${index + 1}`;
}
const rules = {
  // 0.4.28 shares refund and fallback classification in money-analysis.js.
  refund: sourceLine('worker/src/lib/money-analysis.js', "if (row.direction === 'inflow' && /\\b(?:refunds?"),
  fallback: sourceLine('worker/src/lib/money-analysis.js', "const money_kind = paymentKind ?"),
  processor: sourceLine('worker/src/lib/clean-money.js', "SELECT t.*,CASE WHEN t.direction='inflow' AND t.movement_kind IN"),
  // Fix steps 6-7 moved processor identity into money-platform.js; moneyProcessor is now an alias of it.
  exactProcessor: sourceLine('worker/src/lib/money-platform.js', "export function platformIdentity(row)"),
  income: sourceLine('worker/src/lib/clean-money.js', "COALESCE(income_adjust_minor,0)+CASE WHEN direction='inflow'"),
  expense: sourceLine('worker/src/lib/clean-money.js', "CASE WHEN direction='outflow' AND movement_kind='ordinary' THEN amount_minor"),
  outside: sourceLine('worker/src/lib/clean-money.js', "AND ${supportedPayee('o', 'i')}"),
};
function cause(q, b) {
  if (q.rule === 'outgoing-refund') return `${rules.refund} tags refunds only on inflows; ${rules.fallback} leaves outgoing customer refunds ordinary; the requested refund bucket omits them.`;
  if (b.id === 'clearing-account') return `${rules.outside} requires a narrow transfer payee shape, which excludes the processor name; ${rules.fallback} keeps settlement ordinary, and ${rules.income} / ${rules.expense} count the internal settlement as income/spending.`;
  if (b.id === 'adjusted-payout') return `${rules.refund} treats the word refund in a net sales payout memo as a refund; ${rules.processor} requires ordinary membership, so the payout tag is lost and ${rules.income} drops its income.`;
  if (q.rule === 'payout' && b.id === 'processor-labels') return `${rules.exactProcessor} matches exact processor payees or a payout/transfer memo prefix; the payments/company labels with an ACH settlement memo receive no processor or payer_group tag.`;
  if (q.rule === 'expense') return `${rules.refund} has no outgoing refund, chargeback-principal or payout-return decision; ${rules.fallback} leaves those rows ordinary and ${rules.expense} counts the principal as running expense.`;
  if (q.rule === 'returned-credit') return `${rules.refund} recognizes refund/refunded/reversal words but not a dispute-won recovery; ${rules.fallback} leaves it ordinary, omitting recovered principal from returned money.`;
  if (q.rule === 'payout') return `${rules.processor} tags any ordinary inflow with the exact processor payee as a payout, including recovered dispute principal; ${rules.refund} does not recognize dispute-won credits.`;
  return `${rules.refund} does not neutralize a returned payout or recognize dispute-won recoveries; ${rules.fallback} retains ordinary membership and ${rules.income} counts those credits as new income.`;
}

async function minimize(book, q) {
  let rows = [...book.rows];
  const candidateBook = candidate => ({ ...book, rows: candidate,
    accounts: book.accounts.filter(a => candidate.some(r => r.account === a.slug)) });
  const evaluate = async candidate => {
    const b = candidateBook(candidate), f = fixture(b);
    try {
      const actual = await execute(f, q.sql, false), expected = q.expected(b);
      return { actual, expected, wrong: !actual.failed && !matches(actual.row, expected) };
    } finally { f.db.close(); }
  };
  // Preserve the evidence that establishes a two-leg settlement or a cancelled
  // payout. Deleting its counterpart would produce a different economic book,
  // rather than a smaller witness of the same error. All other rows are single
  // deletion units. Restart after deletion to prove unit-wise 1-minimality.
  const unit = r => r.group ?? r.uid;
  for (let i = 0; i < rows.length;) {
    const candidate = rows.filter(r => unit(r) !== unit(rows[i]));
    if ((await evaluate(candidate)).wrong) { rows = candidate; i = 0; }
    else i++;
  }
  const result = await evaluate(rows);
  assert.equal(result.wrong, true, 'minimized witness must still differ');
  assert.ok(rows.length > 0, 'an empty book mismatch is a harness defect');
  return { book: candidateBook(rows), ...result };
}
function compactRow(r) {
  return { uid: r.uid, account: r.account, date: r.day, cents: r.cents, currency: r.currency,
    direction: r.direction, payee: r.payee, description: r.description, category: r.category,
    state: r.state, book_event: r.event, ...(r.group ? { book_group: r.group } : {}) };
}
function renderReport(results, witnesses, ready, why = '') {
  const counts = Object.fromEntries(['right', 'wrong', 'failed'].map(key => [key, results.filter(r => r.outcome === key).length]));
  const lines = [ready ? 'READY' : 'NOT READY',
    `questions=${results.length} right=${counts.right} wrong=${counts.wrong} failed=${counts.failed}`, '',
    'Ten synthetic owner books; 12 plain owner questions per book. Money figures are integer cents; null means the available rows cannot establish the figure. Each SQL statement also returns account and complete-coverage counts and uncertain-row/directional totals.',
    'Every question uses the real handleMoneyQuery POST handler and the real MCP brain_money_query dispatch over node:sqlite with the shipped D1 migrations. Only the D1 transport and already-authorized MCP principal are local adapters. No network, credentials, model calls, live installs or product edits. This measures the written assistant SQL and clean-view semantics, not model SQL-generation quality or authentication.',
    'Expected answers come only from JavaScript arithmetic on independently declared book events. The events and known processor identities are oracle facts, not extra product columns. Bank cash includes all posted legs. Outside income excludes internal settlements, cancelled first attempts and returned money; expenses exclude refunded sales principal and payout returns. Refund/recovery credits stay separate from new income. Bank-only net deposits cannot establish gross sales or hidden fees.',
    'The test file contains every book, question, SQL and oracle. Wrong figures are finder data, so they do not fail the harness. READY means the finder completed, not that the product answered every question correctly.',
    'Witnesses below are deletion-tested to be 1-minimal while preserving paired settlement/return evidence (book_group); unrelated accounts are removed. Listed accounts are confirmed owned accounts with complete 2026-10-01 through 2026-10-31 coverage. Retained rows are confirmed; book_event/book_group are independent oracle notation. Expected objects contain value (cents, or count), accounts, covered_accounts. Actual SQL results also retain estimated_rows and estimated_in_minor/estimated_out_minor: unknown defaults are estimates, not certified figures.', ''];
  for (const [i, w] of witnesses.entries()) {
    lines.push(`${i + 1}. ${w.q.id}`, `Question: ${w.q.question}`,
      `Accounts: ${JSON.stringify(w.book.accounts)}`, `Rows: ${JSON.stringify(w.book.rows.map(compactRow))}`,
      `Expected: ${JSON.stringify(w.expected)}`, `Actual SQL result: ${JSON.stringify(w.actual.row ?? w.actual)}`,
      'SQL:', '```sql', w.q.sql, '```', `Clean-view rule: ${cause(w.q, w.book)}`, '');
  }
  if (!ready) lines.push(`Run limitation: ${why}`, '');
  lines.push(`LANE PRO-TOOLS-FINDER-PAYOUTS-REFUNDS-1112: ${ready ? 'READY' : 'NOT READY ' + why}`);
  return lines.join('\n') + '\n';
}

test('processor payouts, refunds and chargebacks finder: ten owner books through real money tools', async t => {
  const results = [], witnesses = [];
  // Even accidental fallback code cannot contact a provider.
  t.mock.method(globalThis, 'fetch', () => assert.fail('Network is forbidden in this finder'));
  try {
    assert.equal(books.length, 10);
    assert.equal(new Set(books.map(b => b.id)).size, books.length);
    const questions = books.flatMap(book => [...commonQuestions(book), ...extraQuestions(book)].map(q => ({ book, q })));
    assert.equal(questions.length, 120);
    assert.equal(new Set(questions.map(({ q }) => q.id)).size, questions.length);
    assert.equal(new Set(questions.map(({ q }) => q.question)).size, questions.length);
    // Hand-calculated anchors check event arithmetic without consulting SQL.
    assert.equal(sum(scope(books[0])), 145500);
    assert.equal(centsOf(receipts)(books[2]), 100000);
    assert.equal(centsOf(expenses)(books[2]), 3000);
    assert.equal(sum(scope(books[4]), r => returned.has(r.event)) - sum(scope(books[4]), r => r.event === 'customer_refund'), 0);
    assert.equal(sum(scope(books[6]), () => true, true), 188888);
    assert.equal(outsideIncome(books[7]), 64000);
    assert.equal(sum(scope(books[8], { currency: 'EUR' })), 12345);
    for (const book of books) {
      const f = fixture(book);
      const before = f.db.prepare('SELECT total_changes() AS n').get().n;
      try {
        for (const { q } of questions.filter(item => item.book === book)) {
          const expected = q.expected(book), actual = await execute(f, q.sql);
          const outcome = actual.failed ? 'failed' : matches(actual.row, expected) ? 'right' : 'wrong';
          results.push({ book, q, expected, actual, outcome });
          t.diagnostic(`${q.id} ${outcome} expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual.row ?? actual)}`);
        }
        assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n, before);
      } finally { f.db.close(); }
    }
    assert.equal(results.length, 120, 'every owner question was attempted');
    // Prefer distinct economic failure modes to ten phrasings of one mistake.
    const preferred = [
      'gross-plus-fee/customer-refunds', 'clearing-account/income', 'clearing-account/spending',
      'chargeback-lost/spending', 'chargeback-won/income', 'chargeback-won/payout-credits',
      'chargeback-won/returned-credits', 'payout-return-retry/income',
      'adjusted-payout/payout-credits', 'processor-labels/stripe-group',
    ];
    const failures = results.filter(r => r.outcome !== 'right');
    const ordered = [...preferred.map(id => failures.find(r => r.q.id === id)).filter(Boolean), ...failures];
    const chosen = new Set();
    for (const r of ordered) {
      if (chosen.has(r.q.id)) continue;
      chosen.add(r.q.id);
      if (r.outcome === 'wrong') witnesses.push({ ...await minimize(r.book, r.q), q: r.q });
      else witnesses.push({ ...r, actual: r.actual, book: r.book });
      if (witnesses.length === 10) break;
    }
    const report = renderReport(results, witnesses, true);
    writeFileSync(REPORT, report);
    t.diagnostic(report.split('\n')[1]);
    assert.equal(results.filter(r => r.outcome === 'right' || r.outcome === 'wrong' || r.outcome === 'failed').length, 120);
  } catch (error) {
    writeFileSync(REPORT, renderReport(results, witnesses, false, 'finder execution or independent-oracle verification incomplete'));
    throw error;
  }
});
