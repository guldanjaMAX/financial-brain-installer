// Regression witnesses reconstructed from the supplied offline comparison.
import test from 'node:test';
import assert from 'node:assert/strict';
import { book, W, day, NOW } from './helpers/balances-high-fixture.mjs';
import { queryMoney } from '../src/lib/money-query.js';
const D = '2026-10-31';
const unavailable = /SimpleFIN minor-unit evidence could not be checked/;
async function ask(b, sql, askedPeriod) {
  try {
    const r = await queryMoney(b.env, { sql, ...askedPeriod, time_zone: 'America/Phoenix' }, { now: () => NOW, timeoutMs: 2000 });
    return { status: 'answered', rows: r.rows, percent: r.confidence.percent,
      warning: unavailable.test(r.confidence_text), reasons: r.confidence.reasons, missing: r.confidence.missing };
  } catch (e) { return { status: e.code || e.message }; }
}
// Exact October reviewer CSV and legacy-writer reconstruction from the supplied test.
function statement(b) {
  const csv = 'Date,Description,Debit,Credit,Balance\n10/31/2026,Payroll,8000,,4000\n10/20/2026,Invoice,,6000,12000\n10/12/2026,Rent,2000,,6000\n10/02/2026,Invoice,,3000,8000\n';
  const imported = b.importFile(csv, { name: 'statement.csv', format: 'csv',
    accountHint: { accountKey: 'operating', accountKind: 'checking', mask: '1111' } });
  assert.equal(imported.receipt?.imported, true);
  b.run('UPDATE fin_statements SET opening_balance_minor=500000,closing_balance_minor=800000');
  b.run("UPDATE fin_balance_snapshots SET current_minor=800000,provider_position_minor=NULL,source_locator='synthetic#balance',basis_state='confirmed',unparsed_reason=NULL");
  b.run("UPDATE fin_account_coverage SET coverage_status='complete',provenance='owner_stated',basis_note='Complete posted activity independently confirmed.'");
  assert.equal(b.db.prepare('SELECT COUNT(*) AS n FROM fin_transactions').get().n, 4);
}
async function receiptWitness(t, { path, fault, currency = 'OMR', debit = 70123, credit = 456, transient = false }) {
  const b = book(t);
  if (path !== 'raw') statement(b);
  if (path !== 'balance') {
    b.account('simplefin-synthetic', { currency });
    b.row('simplefin-synthetic', debit, { currency });
    b.row('simplefin-synthetic', credit, { currency, direction: 'inflow' });
    b.run("UPDATE fin_transactions SET source_provider='simplefin',source_locator='synthetic~simplefin-exact-minor-v1#row' WHERE currency=?", currency);
  }
  const net = `SELECT SUM(CASE direction WHEN 'inflow' THEN amount_minor ELSE -amount_minor END) FROM fin_transactions WHERE currency='${currency}'`;
  const cash = `FROM (${W.cash(D)}) WHERE currency='USD'`;
  const sql = path === 'balance' ? `SELECT cash_minor ${cash}` : path === 'raw' ?
    `SELECT (${net}) AS net_minor` : `SELECT cash_minor,(${net}) AS net_minor ${cash}`;
  const correctAmounts = r => r.status === 'answered' && (path === 'raw' || r.rows[0]?.cash_minor === 400000) &&
    (path === 'balance' || r.rows[0]?.net_minor === credit - debit);
  const control = await ask(b, sql, day(D));
  assert.ok(correctAmounts(control), 'green control proves independently readable corrected arithmetic');
  const original = b.env.DB.prepare;
  const counts = { receiptReads: 0, faults: 0, amountOnlyReads: 0, publicAmountReads: 0,
    arithmeticReceiptReads: 0, arithmeticOnlyReads: 0, finalReceiptReads: 0, finalAmountOnlyReads: 0 };
  b.env.DB.prepare = sql => {
    const s = original(sql);
    if (sql.startsWith('EXPLAIN')) return s;
    const arithmetic = sql.includes('mq_rb AS MATERIALIZED');
    const amount = sql.includes('AS net_minor') || sql.includes('SELECT cash_minor');
    const receipt = arithmetic ? sql.includes("'simplefin_minor_units'") : sql.includes('AS mq_private_minor_units');
    if (!arithmetic && !amount) return s;
    const wrap = s => ({ ...s, bind: (...values) => wrap(s.bind(...values)), all: async () => {
      if (amount) counts.publicAmountReads++;
      counts[arithmetic ? receipt ? 'arithmeticReceiptReads' : 'arithmeticOnlyReads' : receipt ? 'finalReceiptReads' : 'finalAmountOnlyReads']++;
      if (!receipt) { counts.amountOnlyReads++; return s.all(); }
      counts.receiptReads++;
      // Balance faults target the frozen arithmetic read; raw/mixed faults target the final amount read.
      if ((path === 'balance' ? !arithmetic : arithmetic) || transient && counts.faults) return s.all();
      counts.faults++;
      if (fault === 'resource') throw Error('D1_ERROR: synthetic SQL resource limit');
      if (fault === 'malformed') throw Error('D1_ERROR: malformed JSON: SQLITE_ERROR');
      const r = await s.all();
      const payload = ({ 'empty-object': '[{}]', 'not-array': '{}', 'bad-json': 'not-json' })[fault] || '[null]';
      if (arithmetic) r.results.find(row => row.kind === 'simplefin_minor_units').value = payload;
      else r.results[0].mq_private_minor_units = payload;
      return r;
    } });
    return wrap(s);
  };
  const result = await ask(b, sql, day(D));
  assert.ok(counts.publicAmountReads > 0, 'public amount decision point reached');
  assert.ok(counts.faults > 0, 'receipt fault was executed');
  assert.equal(result.status, 'answered', 'readable activity must keep its figure');
  assert.ok(correctAmounts(result), 'activity proof must win over the stale closing cell');
  assert.equal(result.percent, path === 'balance' ? 80 : path === 'mixed' ? 55 : 0,
    'preserve the published confidence for the same account and month');
  assert.ok(result.warning, 'receipt failure must have one plain evidence gap');
  assert.equal(result.reasons.filter(reason => unavailable.test(reason)).length, 1);
  assert.ok(result.reasons.every(reason => !reason.includes('undefined')), 'never format an unusable receipt');
  assert.ok(control.reasons.every(reason => result.reasons.includes(reason)), 'retain existing confidence gaps');
  assert.ok(control.missing.every(item => result.missing.includes(item)), 'retain existing missing evidence');
  assert.ok(result.missing.length > 0, 'name what would complete the receipt check');
  if (path === 'balance') {
    const readFailed = ['malformed', 'resource'].includes(fault);
    assert.equal(counts.arithmeticReceiptReads, 1, 'receipt-bearing snapshot decision reached once');
    assert.equal(counts.arithmeticOnlyReads, readFailed ? 1 : 0,
      'only failed SQL execution needs a receipt-free arithmetic read');
    assert.equal(counts.finalAmountOnlyReads, 1, 'public figure uses the frozen corrected arithmetic once');
  } else {
    assert.equal(counts.finalReceiptReads, 1, 'receipt-bearing amount decision reached once');
    assert.equal(counts.finalAmountOnlyReads, ['malformed', 'resource'].includes(fault) ? 1 : 0,
      'retry only failed execution, never already returned amount rows');
  }
  assert.equal(counts.faults, 1, 'one receipt attempt at the failing boundary');
}

for (const path of ['balance', 'mixed', 'raw']) {
  for (const fault of ['malformed', 'null', 'resource']) {
    test(`receipt fallback: ${path} ${fault}`, t => receiptWitness(t,
      { path, fault, transient: path === 'mixed' }));
  }
}
test('receipt fallback: raw TND resource', t => receiptWitness(t,
  { path: 'raw', fault: 'resource', currency: 'TND', debit: 78931, credit: 127 }));

for (const path of ['balance', 'mixed', 'raw']) {
  for (const fault of ['empty-object', 'not-array', 'bad-json']) {
    test(`unusable receipt fallback: ${path} ${fault}`, t => receiptWitness(t,
      { path, fault, transient: path === 'mixed' }));
  }
}

for (const path of ['raw', 'mixed']) test(`receipt retry retains the real ${path} input guard after concurrent growth`, async t => {
  const b = book(t);
  if (path === 'mixed') statement(b);
  b.account('simplefin-synthetic', { currency: 'OMR' });
  b.row('simplefin-synthetic', 70123, { currency: 'OMR' });
  const net = "SELECT SUM(amount_minor) FROM fin_transactions WHERE currency='OMR'";
  const sql = path === 'raw' ? `SELECT (${net}) AS net_minor` :
    `SELECT cash_minor,(${net}) AS net_minor FROM (${W.cash(D)}) WHERE currency='USD'`;
  const control = await ask(b, sql, day(D));
  assert.equal(control.status, 'answered');
  assert.equal(control.rows[0].net_minor, 70123, 'green bounded input is readable');
  const original = b.env.DB.prepare;
  const calls = [];
  let inserted = 0;
  b.env.DB.prepare = sql => {
    const s = original(sql);
    if (sql.startsWith('EXPLAIN') || !sql.includes('AS net_minor')) return s;
    const wrap = s => ({ ...s, bind: (...values) => wrap(s.bind(...values)), all: async () => {
      calls.push(sql);
      if (!inserted++) b.row('simplefin-synthetic', 456, { currency: 'OMR', direction: 'inflow' });
      // Execute SQLite's actual JSON guard failure, including on the retry.
      return s.all();
    } });
    return wrap(s);
  };
  const result = await ask(b, sql, day(D));
  assert.equal(result.status, 'MONEY_QUERY_UNAVAILABLE');
  assert.equal(calls.length, 2, 'guard decision reached once with and once without receipt');
  assert.ok(calls[0].includes('AS mq_private_minor_units'));
  assert.ok(!calls[1].includes('AS mq_private_minor_units'));
  assert.ok(calls.every(sql => sql.includes('mq_budget AS MATERIALIZED') && sql.includes("json_extract('!', '$')")),
    'the identical input growth guard stays on both amount reads');
});

// A bad diagnostic must not invalidate successfully returned ledger arithmetic.
async function returnedSnapshotWitness(t, payload, failSecondRead) {
  const b = book(t);
  statement(b);
  const sql = `SELECT cash_minor FROM (${W.cash(D)}) WHERE currency='USD'`;
  const control = await ask(b, sql, day(D));
  assert.equal(control.status, 'answered');
  assert.equal(control.rows[0].cash_minor, 400000, 'green control proves opening plus four signed rows');
  assert.equal(control.percent, 80, 'published confidence control');
  const original = b.env.DB.prepare;
  const counts = { snapshots: 0, receiptFaults: 0, returnedTransactions: 0, secondReadFailures: 0 };
  b.env.DB.prepare = sql => {
    const s = original(sql);
    if (sql.startsWith('EXPLAIN') || !sql.includes('mq_rb AS MATERIALIZED')) return s;
    const wrap = s => ({ ...s, bind: (...values) => wrap(s.bind(...values)), all: async () => {
      counts.snapshots++;
      if (failSecondRead && counts.snapshots > 1) {
        counts.secondReadFailures++;
        throw Error('D1_ERROR: synthetic SQL resource limit on second arithmetic read');
      }
      const r = await s.all();
      counts.returnedTransactions += r.results.filter(row => row.kind === 'transactions').length;
      const receipt = r.results.find(row => row.kind === 'simplefin_minor_units');
      if (receipt) { counts.receiptFaults++; receipt.value = payload; }
      return r;
    } });
    return wrap(s);
  };
  const result = await ask(b, sql, day(D));
  assert.equal(counts.receiptFaults, 1, 'successful snapshot receipt validation decision reached');
  assert.ok(counts.returnedTransactions >= 4, 'all four actual ledger records were returned before validation');
  assert.equal(result.status, 'answered');
  if (failSecondRead) {
    assert.equal(result.rows[0].cash_minor, 400000, 'already returned activity must survive a failing second read');
  }
  assert.equal(counts.snapshots, 1, 'unusable receipt must not trigger another ledger snapshot');
  assert.equal(counts.returnedTransactions, 4, 'ledger rows returned exactly once');
  assert.equal(counts.secondReadFailures, 0, 'second-read fault is armed but never needed');
  assert.equal(result.rows[0].cash_minor, 400000, 'activity disproves the stored 800000 closing cell');
  assert.equal(result.percent, control.percent, 'keep published confidence with the exact same arithmetic');
  assert.ok(result.warning, 'missing receipt stays visible');
  assert.ok(control.reasons.every(reason => result.reasons.includes(reason)));
  assert.ok(control.missing.every(item => result.missing.includes(item)));
  assert.ok(result.missing.length > 0, 'explain what would complete the receipt check');
}
for (const [fault, payload] of Object.entries({ null: '[null]', 'bad-json': 'not-json', 'not-array': '{}', 'empty-object': '[{}]' })) {
  test(`returned snapshot survives unusable ${fault} receipt with second-read resource fault`, t =>
    returnedSnapshotWitness(t, payload, true));
  test(`returned snapshot reads ledger once with unusable ${fault} receipt`, t =>
    returnedSnapshotWitness(t, payload, false));
}

for (const path of ['raw', 'balance', 'mixed']) test(`persistent ${path} read failure finishes within two seconds`, async t => {
  const b = book(t);
  if (path !== 'raw') statement(b);
  b.account('bounded', { currency: 'OMR' });
  b.row('bounded', 70123, { currency: 'OMR' });
  const net = "SELECT SUM(amount_minor) FROM fin_transactions WHERE currency='OMR'";
  const sql = path === 'raw' ? `SELECT (${net}) AS net_minor` :
    `SELECT cash_minor${path === 'mixed' ? `,(${net}) AS net_minor` : ''} FROM (${W.cash(D)}) WHERE currency='USD'`;
  const control = await ask(b, sql, day(D));
  assert.equal(control.status, 'answered', 'green public-query control reached');
  assert.equal(control.rows[0][path === 'raw' ? 'net_minor' : 'cash_minor'], path === 'raw' ? 70123 : 400000);
  const original = b.env.DB.prepare, calls = [];
  b.env.DB.prepare = text => {
    const s = original(text);
    if (text.startsWith('EXPLAIN')) return s;
    const arithmetic = text.includes('mq_rb AS MATERIALIZED');
    const amount = text.includes('AS net_minor') || text.includes('SELECT cash_minor');
    if (!(path === 'balance' ? arithmetic : amount && !arithmetic)) return s;
    const wrap = s => ({ ...s, bind: (...values) => wrap(s.bind(...values)), all: async () => {
      calls.push(text);
      throw Error('D1_ERROR: persistent synthetic read failure');
    } });
    return wrap(s);
  };
  const start = performance.now(), result = await ask(b, sql, day(D));
  assert.ok(performance.now() - start < 2000, 'persistent failures never wait for the query deadline');
  assert.equal(calls.length, 2, 'failure decision reached exactly once and retried at most once');
  if (path === 'balance') {
    assert.equal(result.status, 'answered');
    assert.equal(result.rows[0].cash_minor, 800000, 'same readable stored fallback as the prior implementation when arithmetic cannot be read');
    assert.ok(result.percent < 90, 'unproved stored fallback cannot receive High');
  } else assert.equal(result.status, 'MONEY_QUERY_UNAVAILABLE', 'same terminal read error as the prior implementation');
});

for (const path of ['raw', 'mixed']) test(`returned ${path} amounts survive unusable receipt without a second read`, async t => {
  const b = book(t);
  if (path === 'mixed') statement(b);
  b.account('bounded', { currency: 'OMR' });
  b.row('bounded', 70123, { currency: 'OMR' });
  const net = "SELECT SUM(amount_minor) FROM fin_transactions WHERE currency='OMR'";
  const sql = path === 'raw' ? `SELECT (${net}) AS net_minor` :
    `SELECT cash_minor,(${net}) AS net_minor FROM (${W.cash(D)}) WHERE currency='USD'`;
  const control = await ask(b, sql, day(D));
  assert.equal(control.status, 'answered', 'green public amount read reached');
  assert.equal(control.rows[0].net_minor, 70123);
  const original = b.env.DB.prepare;
  let reads = 0, returned = 0, receiptFaults = 0;
  b.env.DB.prepare = text => {
    const s = original(text);
    if (text.startsWith('EXPLAIN') || !text.includes('AS net_minor') || text.includes('mq_rb AS MATERIALIZED')) return s;
    const wrap = s => ({ ...s, bind: (...values) => wrap(s.bind(...values)), all: async () => {
      reads++;
      if (reads > 1) throw Error('D1_ERROR: persistent synthetic second-read failure');
      const r = await s.all();
      returned += r.results.length;
      if (Object.hasOwn(r.results[0], 'mq_private_minor_units')) {
        receiptFaults++;
        r.results[0].mq_private_minor_units = '[null]';
      }
      return r;
    } });
    return wrap(s);
  };
  const start = performance.now(), result = await ask(b, sql, day(D));
  assert.equal(returned, 1, 'one successful amount row returned before the receipt fault');
  assert.equal(receiptFaults, 1, 'receipt decision reached with unusable evidence');
  assert.equal(result.status, 'answered', 'already returned figures survive an armed persistent read failure');
  assert.deepEqual(result.rows, control.rows);
  assert.equal(reads, 1, 'no retry when amount rows are already in hand');
  assert.ok(performance.now() - start < 2000);
  assert.ok(result.warning);
  assert.ok(result.percent <= control.percent && result.percent < 90);
});

for (const persistent of [true, false]) test(`account-review compatibility shares one retry with ${persistent ? 'persistent' : 'optional receipt'} failure`, async t => {
  const b = book(t);
  b.account('bounded', { currency: 'OMR' });
  b.row('bounded', 70123, { currency: 'OMR' });
  const sql = "SELECT (SELECT SUM(amount_minor) FROM fin_transactions WHERE currency='OMR') AS net_minor,(SELECT COUNT(*) FROM fin_accounts) AS accounts";
  const control = await ask(b, sql, day(D));
  assert.equal(control.status, 'answered', 'green account and amount decisions reached');
  assert.equal(control.rows[0].net_minor, 70123);
  assert.equal(control.rows[0].accounts, 1);
  const original = b.env.DB.prepare, calls = [];
  b.env.DB.prepare = text => {
    const s = original(text);
    if (text.startsWith('EXPLAIN') || !text.includes('AS net_minor')) return s;
    const wrap = s => ({ ...s, bind: (...values) => wrap(s.bind(...values)), all: async () => {
      calls.push(text);
      if (calls.length === 1) throw Error('no such table: main.fin_account_kind_reviews');
      if (persistent || text.includes('AS mq_private_minor_units')) throw Error('D1_ERROR: persistent synthetic read failure');
      return s.all();
    } });
    return wrap(s);
  };
  const start = performance.now(), result = await ask(b, sql, day(D));
  if (persistent) assert.equal(result.status, 'MONEY_QUERY_UNAVAILABLE');
  else {
    assert.equal(result.status, 'answered', 'combined optional failures must keep the readable amount');
    assert.deepEqual(result.rows, control.rows);
    assert.ok(result.warning, 'skipped optional evidence remains disclosed');
    assert.ok(result.percent <= control.percent && result.percent < 90);
  }
  assert.equal(calls.length, 2, 'both real failure decisions reached without a third attempt');
  assert.ok(calls[0].includes('fin_account_kind_reviews'));
  assert.ok(!calls[1].includes('fin_account_kind_reviews'), 'compatibility retry actually removed the missing review dependency');
  assert.ok(performance.now() - start < 2000);
});

// RF-03: the receipt can fail before SQLite reports an older optional schema.
test('receipt-first resource failure preserves genuinely missing review-table compatibility', async t => {
  const b = book(t);
  b.account('synthetic', { currency: 'OMR' });
  b.row('synthetic', 70123, { currency: 'OMR' });
  b.row('synthetic', 456, { currency: 'OMR', direction: 'inflow' });
  b.run("UPDATE fin_transactions SET source_provider='simplefin',source_locator='synthetic~simplefin-exact-minor-v1#row'");
  const sql = "SELECT SUM(CASE t.direction WHEN 'inflow' THEN t.amount_minor ELSE -t.amount_minor END) AS net_minor FROM fin_transactions t JOIN fin_accounts a ON a.account_slug=t.account_slug AND a.currency=t.currency";
  const control = await ask(b, sql, day(D));
  assert.equal(control.status, 'answered');
  assert.equal(control.rows[0].net_minor, -69667);
  assert.equal(control.percent, 0, 'published raw-net confidence control');
  b.run('DROP TABLE fin_account_kind_reviews');
  const missingOnly = await ask(b, sql, day(D));
  assert.equal(missingOnly.status, 'answered', 'green older-schema control reaches the real compatibility path');
  assert.equal(missingOnly.rows[0].net_minor, -69667);
  const original = b.env.DB.prepare;
  let attempts = 0, receiptFaults = 0, missingFailures = 0;
  b.env.DB.prepare = text => {
    const s = original(text);
    if (text.startsWith('EXPLAIN') || !text.includes('AS net_minor')) return s;
    const wrap = s => ({ ...s, bind: (...values) => wrap(s.bind(...values)), all: async () => {
      attempts++;
      if (text.includes('AS mq_private_minor_units') && !receiptFaults++)
        throw Error('D1_ERROR: synthetic SQL resource limit');
      try { return await s.all(); }
      catch (e) { if (/no such table: (?:main\.)?fin_account_kind_reviews/.test(e.message)) missingFailures++; throw e; }
    } });
    return wrap(s);
  };
  const result = await ask(b, sql, day(D));
  assert.equal(receiptFaults, 1, 'receipt failure decision was reached');
  assert.equal(attempts, 2, 'one guarded amount retry, with no third execution');
  t.diagnostic(JSON.stringify({ attempts, receiptFaults, missingFailures, result }));
  assert.equal(result.status, 'answered');
  assert.equal(result.rows[0].net_minor, -69667);
  assert.equal(result.percent, missingOnly.percent);
  assert.ok(result.warning);
  assert.ok(result.reasons.some(reason => /account-kind review store was unavailable/.test(reason)));
  assert.ok(missingOnly.reasons.every(reason => result.reasons.includes(reason)));
  assert.ok(missingOnly.missing.every(item => result.missing.includes(item)));
  assert.equal(missingFailures, 0, 'availability is resolved before spending the only amount retry');
});

// RF-04: a later projection fault cannot revoke a completed arithmetic proof.
for (const persistent of [false, true]) test(`invalid snapshot receipt then ${persistent ? 'persistent materialization' : 'transient projection'} fault retains the corrected closing`, async t => {
  const b = book(t);
  statement(b);
  const sql = `SELECT cash_minor FROM (${W.cash(D)}) WHERE currency='USD'`;
  const control = await ask(b, sql, day(D));
  assert.equal(control.status, 'answered');
  assert.equal(control.rows[0].cash_minor, 400000);
  assert.equal(control.percent, 80);
  const original = b.env.DB.prepare;
  let snapshots = 0, invalidReceipts = 0, transactions = 0, finalReads = 0, projectionFailures = 0;
  const finalSql = [];
  b.env.DB.prepare = text => {
    const s = original(text);
    if (text.startsWith('EXPLAIN')) return s;
    const snapshot = text.includes('mq_rb AS MATERIALIZED');
    if (!snapshot && !text.includes('SELECT cash_minor')) return s;
    const wrap = s => ({ ...s, bind: (...values) => wrap(s.bind(...values)), all: async () => {
      if (snapshot) {
        snapshots++;
        const r = await s.all();
        transactions += r.results.filter(row => row.kind === 'transactions').length;
        const receipt = r.results.find(row => row.kind === 'simplefin_minor_units');
        assert.ok(receipt, 'snapshot receipt corruption decision reached');
        invalidReceipts++;
        receipt.value = '[null]';
        return r;
      }
      finalReads++; finalSql.push(text);
      if (text.includes('mq_balance_observations') && (persistent ? text.includes('mq_balance_observations AS MATERIALIZED') : !projectionFailures)) {
        projectionFailures++;
        throw Error('D1_ERROR: synthetic SQL resource limit');
      }
      return s.all();
    } });
    return wrap(s);
  };
  const result = await ask(b, sql, day(D));
  assert.equal(snapshots, 1, 'one completed ledger snapshot');
  assert.equal(invalidReceipts, 1, 'invalid diagnostic was reached');
  assert.equal(transactions, 4, 'four actual arithmetic records already proved the correction');
  assert.ok(projectionFailures > 0, 'corrected final projection failure was reached');
  assert.equal(finalReads, 2, 'one bounded final retry');
  t.diagnostic(JSON.stringify({ snapshots, invalidReceipts, transactions, finalReads, projectionFailures, result }));
  assert.equal(result.status, 'answered');
  assert.equal(result.rows[0].cash_minor, 400000, 'completed correction survives later optional failure');
  assert.equal(projectionFailures, 1, 'simplification avoids another materialization failure');
  assert.equal(result.percent, control.percent);
  assert.ok(result.warning);
  assert.ok(control.reasons.every(reason => result.reasons.includes(reason)));
  assert.ok(control.missing.every(item => result.missing.includes(item)));
  assert.ok(finalSql.every(text => text.includes('mq_balance_observations')), 'neither final read can substitute the stale stored cell');
  if (persistent) assert.ok(finalSql[1].includes('mq_balance_observations AS NOT MATERIALIZED'),
    'resource fallback simplifies only the projection of the same frozen records');
});
