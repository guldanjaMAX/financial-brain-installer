import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../src/index.js';
import { queryMoney, MONEY_EXAMPLE_SQL } from '../src/lib/money-query.js';
import { accountLinkIdentity } from '../src/lib/fin-account-links.js';
import { readEffectiveAccounts, readEffectiveTransactions } from '../src/lib/ledger-reader.js';
import { pairOwnTransfers, ordinaryMoneyMembership, possibleUnconnectedPayment, loanCardPaymentKind } from '../src/lib/money-analysis.js';
import { TEST_COMMANDS, POST_LAUNCHER_TEST_COMMANDS } from '../../scripts/run-test-chain.mjs';

const at = '2026-10-31T12:00:00Z';
function fixture(t) {
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  const db = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../../migrations/d1/', import.meta.url)).filter(n => n.endsWith('.sql')).sort())
    db.exec(readFileSync(new URL(`../../migrations/d1/${name}`, import.meta.url), 'utf8'));
  t.after(() => db.close());
  const calls = [];
  const statement = (sql, binds = []) => ({
    bind: (...values) => statement(sql, values),
    all: async () => ({ success: true, results: db.prepare(sql).all(...binds) }),
    first: async () => db.prepare(sql).get(...binds) ?? null,
  });
  const env = { STORAGE: 'd1', ADMIN_KEY: randomBytes(24).toString('hex'), DB: {
    prepare(sql) { calls.push(sql); return statement(sql); },
    batch: async statements => Promise.all(statements.map(s => s.all())),
  } };
  const run = (sql, ...binds) => db.prepare(sql).run(...binds);
  for (const [slug, kind] of [['business', 'business'], ['household', 'household']])
    run(`INSERT INTO fin_entities(entity_slug,legal_name,kind,provenance,basis_state,recorded_at)
      VALUES (?,?,?,'owner_stated','confirmed',?)`, slug, slug, kind, at);
  function account(slug, { mode = 'live', entity = 'business', mask = '1111', kind = 'checking', currency = 'USD' } = {}) {
    run(`INSERT INTO fin_accounts(account_slug,entity_slug,label,account_kind,balance_role,mask,currency,
      feed_mode,provenance,basis_state,recorded_at) VALUES (?,?,?,?,?,?,?,?,'owner_stated','confirmed',?)`,
    slug, entity, slug, kind, ['card', 'loan', 'line_of_credit'].includes(kind) ? 'liability' : 'asset', mask, currency, mode, at);
  }
  function row(uid, slug, cents, { day = '2026-10-02', direction = 'inflow', memo = null, payee = null,
    category = null, currency = 'USD', pending = 0 } = {}) {
    run(`INSERT INTO fin_transactions(txn_uid,account_slug,posted_on,amount_minor,direction,currency,
      description,payee,category,category_basis_state,pending,provenance,basis_state,recorded_at)
      VALUES (?,?,?,?,?,?,?,?,?,'confirmed',?,'owner_stated','confirmed',?)`,
    uid, slug, day, cents, direction, currency, memo, payee, category, pending, at);
  }
  function link(manual, live) {
    const get = slug => db.prepare('SELECT * FROM fin_accounts WHERE account_slug=?').get(slug);
    run(`INSERT INTO fin_account_links(tenant_id,manual_account_slug,live_account_slug,identity_json,
      link_plan_hash,linked_at) VALUES ('primary',?,?,?,?,?)`, manual, live,
    JSON.stringify([accountLinkIdentity(get(manual)), accountLinkIdentity(get(live))]), 'a'.repeat(64), at);
  }
  function coverage(slug, from, to) {
    run(`INSERT INTO fin_account_coverage(account_slug,coverage_status,covered_from,covered_to,
      provenance,basis_state,computed_at,recorded_at) VALUES (?,'complete',?,?,'owner_stated','confirmed',?,?)`, slug, from, to, at, at);
  }
  const query = async sql => (await queryMoney(env, { sql })).rows.map(r => ({ ...r }));
  const route = async sql => {
    const before = db.prepare('SELECT total_changes() n').get().n;
    const started = calls.length;
    const response = await worker.fetch(new Request('https://brain.invalid/api/admin/brain/money-query', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': env.ADMIN_KEY }, body: JSON.stringify({ sql }),
    }), env, {});
    assert.equal(response.status, 200);
    assert.ok(calls.length > started, 'route reached database decision');
    assert.equal(db.prepare('SELECT total_changes() n').get().n, before, 'money route never writes');
    return (await response.json()).rows;
  };
  return { db, env, run, calls, account, row, link, coverage, query, route };
}
const total = rows => rows.reduce((n, row) => n + row.amount_minor, 0);

test('CARD-GUESS exact review purchase stays spending with a disclosed payment candidate', async t => {
  const f = fixture(t); f.account('operating', { mask: '1111' });
  f.row('supply', 'operating', 43210, { day: '2026-09-17', direction: 'outflow', memo: 'Card payment to supply vendor' });
  const [candidate] = await f.route("SELECT * FROM txn WHERE txn_uid='supply'");
  assert.equal(candidate.amount_minor, 43210, 'exact review row reached the real route');
  assert.equal(candidate.account, '1111'); assert.equal(candidate.posted_on, '2026-09-17');
  assert.equal(candidate.payee, null); assert.equal(candidate.category, null);
  assert.equal((await f.query('SELECT * FROM transfer_pairs')).length, 0, 'no repayment pair exists');
  f.run("UPDATE fin_transactions SET description='Supply purchase' WHERE txn_uid='supply'");
  const [control] = await f.query("SELECT * FROM txn WHERE txn_uid='supply'");
  assert.equal(control.expense_minor, 43210, 'same purchase with plain memo is the green control');
  assert.equal(candidate.expense_minor, control.expense_minor, 'payment words cannot erase a purchase');
  assert.equal(candidate.money_kind, 'ordinary'); assert.equal(candidate.estimated, 1);
  assert.equal(candidate.uncertain_kind, 'card_payment'); assert.equal(candidate.uncertain_minor, 43210);
  assert.equal(control.uncertain_kind, null); assert.equal(control.uncertain_minor, 0);
  f.run("UPDATE fin_transactions SET description='Card payment to supply vendor' WHERE txn_uid='supply'");
  assert.equal(total(await f.query(MONEY_EXAMPLE_SQL)), 43210, 'public example retains the uncertain purchase');
  const [summary] = await f.query('SELECT currency,direction,uncertain_kind,SUM(expense_minor) spending,SUM(uncertain_minor) uncertain FROM txn GROUP BY currency,direction,uncertain_kind');
  assert.deepEqual(summary, { currency: 'USD', direction: 'outflow', uncertain_kind: 'card_payment', spending: 43210, uncertain: 43210 });
});

test('CARD-GUESS proved repayment pairs and exact owned endpoints remain outside spending', async t => {
  for (const kind of ['card', 'loan', 'line_of_credit']) {
    const f = fixture(t); f.account('operating'); f.account('liability', { kind, mask: '2222' });
    f.row('sent', 'operating', 43210, { day: '2026-09-17', direction: 'outflow', memo: 'TRANSFER TO ACCOUNT 2222' });
    const [standalone] = await f.route('SELECT * FROM txn');
    assert.equal(standalone.expense_minor, 0, 'a unique owned liability endpoint proves standalone repayment');
    assert.equal(standalone.money_kind, kind === 'card' ? 'card_payment' : 'loan_payment');
    assert.equal(standalone.movement_classification, 'card_or_loan_payment');
    assert.equal(standalone.uncertain_kind, null); assert.equal(standalone.uncertain_minor, 0);
    assert.equal((await f.query('SELECT * FROM transfer_pairs')).length, 0);
    f.row('received', 'liability', 43210, { day: '2026-09-18', memo: 'TRANSFER FROM ACCOUNT 1111' });
    const rows = await f.route('SELECT * FROM txn ORDER BY id');
    assert.equal(rows.length, 2, 'both repayment legs reached the decision');
    assert.equal((await f.query('SELECT * FROM transfer_pairs WHERE proved=1')).length, 1, 'proved pair control reached');
    assert.ok(rows.every(r => r.money_kind === (kind === 'card' ? 'card_payment' : 'loan_payment')));
    assert.ok(rows.every(r => r.expense_minor === 0 && r.income_minor === 0 && r.estimated === 0));
    assert.ok(rows.every(r => r.uncertain_kind === null && r.uncertain_minor === 0));
  }
});

test('CARD-GUESS payment text and bank codes cannot prove an owned repayment destination', async t => {
  for (const connected of [false, true]) {
    for (const [memo, category, kind] of [
      ['CREDIT CARD PAYMENT', null, 'card'],
      ['LOAN PAYMENT', null, 'loan'],
      ['MORTGAGE AUTOPAY', null, 'loan'],
      ['ACH DEBIT', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'card'],
      ['ACH DEBIT', 'LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT', 'loan'],
    ]) {
      await t.test(`${connected}/${memo}/${category}`, async t => {
        const f = fixture(t); f.account('operating');
        if (connected) f.account('unmatched-liability', { kind, mask: '2222' });
        f.row('candidate', 'operating', 43210, { direction: 'outflow', memo, category });
        f.row('purchase', 'operating', 4000, { direction: 'outflow', category: 'PURCHASE' });
        const rows = await f.route('SELECT * FROM txn ORDER BY id');
        assert.equal(rows.length, 2, 'candidate and green purchase control both reached');
        assert.equal(rows[1].expense_minor, 4000);
        assert.equal(rows[0].expense_minor, 43210, `${connected}/${memo}/${category}`);
        assert.equal(rows[0].money_kind, 'ordinary'); assert.equal(rows[0].movement_classification, 'unknown');
        assert.equal(rows[0].uncertain_kind, kind + '_payment'); assert.equal(rows[0].uncertain_minor, 43210);
        assert.equal(rows[0].estimated, 1);
        assert.equal(rows[1].uncertain_kind, null); assert.equal(rows[1].uncertain_minor, 0);
      });
    }
  }
});

test('CARD-GUESS liability credits never become income from income-like bank words', async t => {
  for (const kind of ['card', 'loan', 'line_of_credit']) {
    await t.test(kind, async t => {
      const f = fixture(t); f.account('operating'); f.account('liability', { kind, mask: '2222' });
      for (const [uid, memo] of [['bonus', 'NEW ACCOUNT BONUS'], ['interest', 'INTEREST PAID'], ['cashback', 'CASHBACK'], ['client', 'CUSTOMER INVOICE']])
        f.row(uid, 'liability', 1000, { memo, category: 'OTHER_INCOME' });
      f.row('refund', 'liability', 1703, { memo: 'MERCHANT REFUND', category: 'REFUND' });
      f.row('income-control', 'operating', 7000, { memo: 'NEW ACCOUNT BONUS', category: 'OTHER_INCOME' });
      const rows = await f.route('SELECT * FROM txn ORDER BY id');
      assert.equal(rows.length, 6, 'every liability credit and income/refund control reached');
      assert.equal(rows[5].income_minor, 7000, 'asset-account income green control');
      assert.equal(rows[4].money_kind, 'refund', 'liability refund control');
      assert.ok(rows.slice(0, 5).every(r => r.income_minor === 0), kind);
    });
  }
});

test('CARD-GUESS liability credits stay outside income when ownership confirmation is absent', async t => {
  for (const kind of ['card', 'loan', 'line_of_credit']) {
    for (const state of ['account-proposed', 'entity-proposed', 'counterparty']) {
      await t.test(`${kind}/${state}`, async t => {
        const f = fixture(t); f.account('operating');
        f.account('liability', { kind, mask: '2222', entity: 'household' });
        f.row('liability-credit', 'liability', 1000, { memo: 'NEW ACCOUNT BONUS' });
        f.row('income-control', 'operating', 7000, { memo: 'NEW ACCOUNT BONUS' });
        const control = await f.query('SELECT * FROM txn ORDER BY id');
        assert.equal(control[0].income_minor, 0, 'confirmed liability green control');
        if (state === 'account-proposed') f.run("UPDATE fin_accounts SET basis_state='proposed' WHERE account_slug='liability'");
        if (state === 'entity-proposed') f.run("UPDATE fin_entities SET basis_state='proposed' WHERE entity_slug='household'");
        if (state === 'counterparty') f.run("UPDATE fin_entities SET relationship='counterparty' WHERE entity_slug='household'");
        const rows = await f.route('SELECT * FROM txn ORDER BY id');
        assert.equal(rows.length, 2, 'unconfirmed liability and ordinary income decisions both reached');
        assert.equal(rows[1].income_minor, 7000, 'asset income remains counted');
        assert.equal(rows[0].account_kind, kind);
        assert.equal(rows[0].income_minor, 0, 'loss of ownership proof cannot turn debt credit into income');
        assert.equal(rows[0].estimated, 1);
      });
    }
  }
});

test('CARD-GUESS R1 current reviewed liability stays non-income after ownership confirmation loss', async t => {
  const { accountKindIdentity } = await import('../src/lib/fin-account-kinds.js');
  for (const kind of ['card', 'loan', 'line_of_credit']) {
    for (const state of ['account-proposed', 'entity-proposed', 'counterparty']) {
      await t.test(`${kind}/${state}`, async t => {
        const f = fixture(t); f.account('operating');
        f.account('liability', { kind: 'other', mask: '2222', entity: 'household' });
        f.run("UPDATE fin_accounts SET balance_role='liability' WHERE account_slug='liability'");
        const getAccount = () => f.db.prepare("SELECT * FROM fin_accounts WHERE account_slug='liability'").get();
        const identity = accountKindIdentity(getAccount());
        f.run(`INSERT INTO fin_account_kind_reviews
          (tenant_id,account_id,identity_json,kind,role,reviewer,source,reviewed_at,review_plan_hash)
          VALUES ('primary',?,?,?,'liability','owner','owner_account_kind',?,?)`,
        getAccount().id, identity, kind, at, 'b'.repeat(64));
        f.row('reviewed-credit', 'liability', 1000, { memo: 'NEW ACCOUNT BONUS' });
        f.row('income-control', 'operating', 7000, { memo: 'NEW ACCOUNT BONUS' });
        const control = await f.route('SELECT * FROM txn ORDER BY id');
        assert.equal(control.length, 2, 'confirmed liability and ordinary income controls reached');
        assert.equal(control[0].income_minor, 0, 'current reviewed liability green control');
        assert.equal(control[0].uncertain_kind, kind === 'card' ? 'card_payment' : 'loan_payment');
        assert.equal(control[0].uncertain_minor, 1000);
        assert.equal(control[1].income_minor, 7000, 'ordinary income green control');
        if (state === 'account-proposed') f.run("UPDATE fin_accounts SET basis_state='proposed' WHERE account_slug='liability'");
        if (state === 'entity-proposed') f.run("UPDATE fin_entities SET basis_state='proposed' WHERE entity_slug='household'");
        if (state === 'counterparty') f.run("UPDATE fin_entities SET relationship='counterparty' WHERE entity_slug='household'");
        if (state === 'account-proposed') assert.equal(getAccount().basis_state, 'proposed');
        const entity = f.db.prepare("SELECT * FROM fin_entities WHERE entity_slug='household'").get();
        if (state === 'entity-proposed') assert.equal(entity.basis_state, 'proposed');
        if (state === 'counterparty') assert.equal(entity.relationship, 'counterparty');
        assert.equal(accountKindIdentity(getAccount()), identity, 'ownership changes do not stale the review');
        const review = f.db.prepare('SELECT * FROM fin_account_kind_reviews WHERE account_id=?').get(getAccount().id);
        assert.equal(review.identity_json, identity); assert.equal(review.revoked_at, null);
        assert.equal(review.kind, kind);
        const rows = await f.route('SELECT * FROM txn ORDER BY id');
        assert.equal(rows.length, 2, 'both exact credit decisions reached');
        assert.equal(rows[0].txn_uid, 'reviewed-credit'); assert.equal(rows[0].posted_on, '2026-10-02');
        assert.equal(rows[0].amount_minor, 1000); assert.equal(rows[0].currency, 'USD');
        assert.equal(rows[0].account, '2222'); assert.equal(rows[0].account_kind, 'other');
        assert.equal(rows[0].description, 'NEW ACCOUNT BONUS');
        assert.equal(rows[0].payee, null); assert.equal(rows[0].category, null);
        assert.equal(rows[1].txn_uid, 'income-control'); assert.equal(rows[1].account, '1111');
        assert.equal(rows[1].income_minor, 7000, 'ordinary income remains counted');
        assert.equal(rows[1].estimated, 0); assert.equal(rows[1].uncertain_kind, null); assert.equal(rows[1].uncertain_minor, 0);
        assert.equal((await f.query('SELECT * FROM transfer_pairs')).length, 0, 'exact witness has no outflow or pair');
        assert.equal(rows[0].income_minor, 0, 'current reviewed liability is never income');
        assert.equal(rows[0].expense_minor, 0);
        assert.equal(rows[0].movement_classification, 'unknown'); assert.equal(rows[0].estimated, 1);
        assert.equal(rows[0].money_kind, 'liability_credit', 'a bonus is a debt adjustment, not a repayment');
        assert.equal(rows[0].uncertain_kind, control[0].uncertain_kind); assert.equal(rows[0].uncertain_minor, 1000);
        assert.equal(rows.reduce((n, row) => n + row.income_minor, 0), 7000);

        // Kind evidence survives; ownership authority must not. Exact matching
        // payment legs prove a pair only after ownership is confirmed again.
        f.row('payment', 'operating', 1000, { direction: 'outflow', memo: 'TRANSFER TO ACCOUNT 2222' });
        f.run("UPDATE fin_transactions SET description='TRANSFER FROM ACCOUNT 1111' WHERE txn_uid='reviewed-credit'");
        const unconfirmed = await f.route('SELECT * FROM txn ORDER BY id');
        assert.equal(unconfirmed.length, 3, 'both candidate legs and income control reached');
        assert.equal(unconfirmed[2].txn_uid, 'payment');
        assert.equal((await f.query('SELECT * FROM transfer_pairs')).length, 1, 'matching candidate pair reached');
        assert.equal((await f.query('SELECT * FROM transfer_pairs WHERE proved=1')).length, 0, 'kind review grants no transfer authority');
        assert.equal(unconfirmed[2].expense_minor, 1000);
        f.run("UPDATE fin_accounts SET basis_state='confirmed' WHERE account_slug='liability'");
        f.run("UPDATE fin_entities SET basis_state='confirmed',relationship='owned' WHERE entity_slug='household'");
        const confirmed = await f.route('SELECT * FROM txn ORDER BY id');
        assert.equal((await f.query('SELECT * FROM transfer_pairs WHERE proved=1')).length, 1, 'confirmed ownership green pair control');
        assert.equal(confirmed[2].expense_minor, 0); assert.equal(confirmed[0].income_minor, 0);
        assert.equal(confirmed[1].income_minor, 7000);
      });
    }
  }
});

test('R2 bank repayment codes identify liability credits but unproved debits stay spending', async t => {
  for (const [category, kind, expected] of [
    ['LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT', 'loan', 'loan'],
    ['LOAN_PAYMENTS_MORTGAGE_PAYMENT', 'loan', 'loan'],
    ['LOAN_PAYMENTS_OTHER_PAYMENT', 'line_of_credit', 'loan'],
    ['LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'card', 'card'],
    ['CREDIT_CARD_PAYMENTS_AUTOPAY', 'card', 'card'],
  ]) {
    const f = fixture(t); f.account('bank'); f.account('liability', { kind, mask: '2222' });
    f.row('client', 'bank', 100000, { payee: 'Client unit' });
    f.row('credit', 'liability', 50000, { memo: 'ACH CREDIT', category });
    // Different amounts avoid accidentally proving a pair.
    f.row('debit', 'bank', 40000, { direction: 'outflow', memo: 'ACH DEBIT', category });
    const accounts = await readEffectiveAccounts(f.env);
    const map = new Map(accounts.map(a => [a.account_slug, a]));
    const raw = await readEffectiveTransactions(f.env, accounts, { from: '2026-10-01', to: '2026-10-31' });
    for (const row of raw.filter(r => r.category === category))
      assert.equal(loanCardPaymentKind(row, map), row.direction === 'inflow' ? expected : null);
    const rows = await f.route('SELECT * FROM txn ORDER BY id');
    assert.equal(rows.reduce((n, r) => n + r.income_minor, 0), 100000, category);
    assert.equal(rows.reduce((n, r) => n + r.expense_minor, 0), 40000, category);
    assert.deepEqual(rows.slice(1).map(r => r.money_kind), [expected + '_payment', 'ordinary']);
    assert.equal(rows[2].uncertain_kind, expected + '_payment'); assert.equal(rows[2].uncertain_minor, 40000);
    assert.ok(rows.every(r => r.transfer_basis === null));
    assert.equal(total(await f.query(MONEY_EXAMPLE_SQL)), 140000, 'public example retains unproved outgoing repayments');
    for (const expense of ['INTEREST', 'FEES']) {
      f.row(expense, 'bank', 500, { direction: 'outflow', memo: 'LOAN PAYMENT', category: expense });
      assert.equal((await f.query(`SELECT expense_minor FROM txn WHERE txn_uid='${expense}'`))[0].expense_minor, 500);
    }
  }
});

test('R1 matching last four never suppress unrelated accounts without approval', async t => {
  for (const kind of ['card', 'checking']) {
    const f = fixture(t);
    f.account('bank'); f.account('card', { kind });
    for (const slug of ['bank', 'card']) f.coverage(slug, '2026-10-01', '2026-10-31');
    f.row('bank-purchase', 'bank', 10000, { direction: 'outflow' });
    f.row('card-purchase', 'card', 20000, { direction: 'outflow' });
    const accounts = await readEffectiveAccounts(f.env);
    const oracle = await readEffectiveTransactions(f.env, accounts, { from: '2026-10-01', to: '2026-10-31' });
    const rows = await f.route('SELECT * FROM txn');
    assert.equal(rows.reduce((n, r) => n + r.expense_minor, 0), 30000);
    assert.equal(total(rows), total(oracle));
    assert.equal((await f.query('SELECT sum(duplicate_rows_removed) n FROM coverage'))[0].n, 0);
  }
});

test('R2 standalone liability repayment credits are payments, never earned income', async t => {
  for (const [kind, memo, category, expected] of [
    ['card', 'CREDIT CARD PAYMENT', 'CREDIT_CARD_PAYMENT', 'card_payment'],
    ['loan', 'LOAN PAYMENT', 'LOAN_PAYMENT', 'loan_payment'],
    ['line_of_credit', 'LOAN REPAYMENT', 'LOAN_PAYMENTS', 'loan_payment'],
    ['card', 'PAYMENT THANK YOU', null, 'card_payment'],
  ]) {
    const f = fixture(t); f.account('bank'); f.account('liability', { kind, mask: '2222' });
    f.row('repayment', 'liability', 50000, { memo, category });
    f.row('client', 'bank', 100000, { payee: 'Client unit' });
    const rows = await f.route('SELECT * FROM txn ORDER BY id');
    assert.equal(rows[0].money_kind, expected);
    assert.equal(rows.reduce((n, r) => n + r.income_minor, 0), 100000);
    assert.equal(rows[0].transfer_basis, null, 'no invented ownership proof');
    assert.equal((await f.query('SELECT * FROM transfer_pairs WHERE proved=1')).length, 0);
    f.row('refund-control', 'liability', 1000, { memo: 'MERCHANT REFUND', category: 'REFUND' });
    f.row('income-control', 'bank', 2000, { memo, category, payee: 'Client unit' });
    assert.equal((await f.query("SELECT money_kind FROM txn WHERE txn_uid='refund-control'"))[0].money_kind, 'refund');
    assert.equal((await f.query("SELECT income_minor FROM txn WHERE txn_uid='income-control'"))[0].income_minor, category ? 0 : 2000);
  }
});

test('W-2 approved generic kind link cannot double an import and live feed: 825, not 1150', async t => {
  const f = fixture(t);
  f.account('archive', { mode: 'manual' }); f.account('connected', { kind: 'other' });
  f.link('archive', 'connected');
  f.row('earlier', 'archive', 50000, { day: '2026-09-01' });
  f.row('copy', 'archive', 32500); f.row('posted', 'connected', 32500);
  assert.equal(f.db.prepare('SELECT sum(amount_minor) n FROM fin_transactions').get().n, 115000);
  assert.equal(total(await f.route('SELECT * FROM txn')), 82500);
  const coverage = await f.query('SELECT * FROM coverage');
  assert.equal(coverage.reduce((n, r) => n + r.duplicate_rows_removed, 0), 1);
  assert.ok(f.calls.some(sql => sql.includes('mq_')), 'real view expansion reached');
});

test('W-2 approved identity links override different masks and stale links never suppress', async t => {
  const f = fixture(t);
  f.account('archive', { mode: 'manual', mask: '3333' }); f.account('connected');
  f.row('earlier', 'archive', 50000, { day: '2026-09-01' });
  f.row('copy', 'archive', 32500); f.row('posted', 'connected', 32500);
  assert.equal(total(await f.query('SELECT * FROM txn')), 115000, 'unlinked green control counts both');
  f.link('archive', 'connected');
  assert.equal(total(await f.route('SELECT * FROM txn')), 82500);
  f.run("UPDATE fin_accounts SET external_ref='replacement' WHERE account_slug='connected'");
  assert.equal(total(await f.query('SELECT * FROM txn')), 115000, 'identity drift invalidates approval');
});

test('W-5 reader and real route agree on linked coverage intervals and lifecycle: 825', async t => {
  const f = fixture(t);
  f.account('archive', { mode: 'manual', mask: '3333' }); f.account('connected');
  f.link('archive', 'connected');
  f.coverage('archive', '2026-09-01', '2026-10-31'); f.coverage('connected', '2026-10-01', '2026-10-31');
  f.row('earlier', 'archive', 50000, { day: '2026-09-01' });
  f.row('copy', 'archive', 32500); f.row('posted', 'connected', 32500);
  f.row('pending', 'connected', 99999, { pending: 1 });
  f.row('removed', 'connected', 99999); f.row('replaced', 'connected', 99999);
  f.run("UPDATE fin_transactions SET removed_at=?,removal_reason='removed' WHERE txn_uid='removed'", at);
  f.run("UPDATE fin_transactions SET superseded_by_id=1 WHERE txn_uid='replaced'");
  const accounts = await readEffectiveAccounts(f.env);
  assert.equal(accounts.length, 1, 'reader approved link decision reached');
  const oracle = await readEffectiveTransactions(f.env, accounts, { from: '2026-09-01', to: '2026-10-31' });
  assert.equal(total(oracle), 82500);
  const actual = await f.route('SELECT * FROM txn');
  assert.equal(total(actual), total(oracle));
  assert.deepEqual(actual.map(r => r.id).sort(), oracle.map(r => r.id).sort());
});

test('W-2 duplicates across unrelated accounts are disclosed and counted; currencies and owners stay separate', async t => {
  const f = fixture(t);
  f.account('first'); f.account('second', { mask: '2222' });
  f.account('personal', { entity: 'household' }); f.account('euro', { currency: 'EUR' });
  for (const slug of ['first', 'second', 'personal', 'euro']) f.row(slug, slug, 32500, { currency: slug === 'euro' ? 'EUR' : 'USD' });
  const rows = await f.query('SELECT * FROM txn');
  assert.equal(rows.length, 4, 'cross-account check cannot erase separate accounts');
  const coverage = await f.query('SELECT * FROM coverage');
  assert.ok(coverage.find(r => r.account_slug === 'first').possible_duplicate_count > 0, 'duplicate decision reached');
  assert.equal(new Set(rows.map(r => r.account_identity)).size, 4);
});

test('W-2 live precedence keeps imports after a stopped feed and honors certified interval boundaries', async t => {
  const f = fixture(t);
  f.account('archive', { mode: 'manual' }); f.account('connected');
  f.link('archive', 'connected');
  f.row('before', 'archive', 100, { day: '2026-09-01' });
  f.row('overlap', 'archive', 200); f.row('live', 'connected', 200);
  f.row('after', 'archive', 300, { day: '2026-10-25' });
  assert.equal(total(await f.query('SELECT * FROM txn')), 600);
  f.coverage('connected', '2026-10-01', '2026-10-31');
  assert.equal(total(await f.query('SELECT * FROM txn')), 300, 'certified coverage selects live even on a no-activity day');
});

test('W-1 bilateral bank memos exclude 20000: 14655, not 34655; reader agrees', async t => {
  const f = fixture(t);
  f.account('outgoing'); f.account('incoming', { mask: '2222' });
  const memo = 'TRANSFER FROM X1111 TO X2222';
  f.row('sent', 'outgoing', 2000000, { day: '2026-09-30', direction: 'outflow', memo });
  f.row('received', 'incoming', 2000000, { day: '2026-10-01', memo });
  f.row('revenue', 'incoming', 1465500, { payee: 'Client unit' });
  assert.equal(total(await f.query("SELECT * FROM txn WHERE direction='inflow'")), 3465500, 'gross control reaches candidates');
  const accounts = await readEffectiveAccounts(f.env);
  const rows = await readEffectiveTransactions(f.env, accounts, { from: '2026-09-01', to: '2026-10-31' });
  const map = new Map(accounts.map(a => [a.account_slug, a]));
  const pairs = pairOwnTransfers(rows, map);
  const oracle = ordinaryMoneyMembership(rows, pairs.pairs, map).ordinary;
  assert.equal(pairs.pairs.length, 1, 'product analysis reached transfer decision');
  assert.equal(total(oracle.filter(r => r.direction === 'inflow')), 1465500);
  const actual = await f.route("SELECT * FROM txn WHERE direction='inflow' AND money_kind<>'own_transfer'");
  assert.equal(total(actual), total(oracle.filter(r => r.direction === 'inflow')));
  assert.equal(total(await f.query(MONEY_EXAMPLE_SQL)), 1465500);
});

test('W-1 equal rent and receipt stay possible transfers, counted: 3000 on each side', async t => {
  const f = fixture(t);
  f.account('outgoing'); f.account('incoming', { mask: '2222' });
  f.row('rent', 'outgoing', 300000, { direction: 'outflow', payee: 'Property vendor', category: 'RENT' });
  f.row('revenue', 'incoming', 300000, { payee: 'Client unit' });
  const rows = await f.route('SELECT * FROM txn');
  assert.equal(rows.length, 2); assert.ok(rows.every(r => r.possible_transfer === 1), 'amount/date candidate decision reached');
  assert.ok(rows.every(r => r.money_kind === 'ordinary'));
  assert.equal(rows.reduce((n, r) => n + r.income_minor, 0), 300000);
  assert.equal(rows.reduce((n, r) => n + r.expense_minor, 0), 300000);
  f.run("UPDATE fin_transactions SET payee=NULL,category=NULL,description='TRANSFER FROM X1111 TO X2222'");
  assert.ok((await f.query('SELECT * FROM txn')).every(r => r.money_kind === 'own_transfer'), 'evidence green control');
});

test('W-1 blank opposite memo never proves a category pair; a unique counterpart memo can', async t => {
  for (const evidence of ['category', 'memo']) {
    const f = fixture(t);
    f.account('outgoing'); f.account('incoming', { mask: '2222' });
    f.row('sent', 'outgoing', 10000, { direction: 'outflow', ...(evidence === 'memo' ? { memo: 'TRANSFER TO ACCOUNT 2222' } : { category: 'TRANSFER_OUT' }) });
    f.row('received', 'incoming', 10000);
    assert.equal((await f.query("SELECT * FROM transfer_pairs WHERE proved=1")).length, evidence === 'memo' ? 1 : 0);
    const first = await f.query('SELECT * FROM txn');
    assert.ok(first.every(r => r.money_kind === (evidence === 'memo' ? 'own_transfer' : 'ordinary')));
    if (evidence === 'category') {
      assert.equal(first.find(r=>r.direction==='outflow').expense_minor,10000); assert.equal(first.find(r=>r.direction==='inflow').income_minor,10000);
      assert.ok(first.every(r=>r.estimated===1),'M5: a blank memo cannot prove an exclusion');
    }
    f.row('competing', 'incoming', 10000);
    const rows = await f.query('SELECT * FROM txn');
    assert.equal(rows.length, 3);
    // A duplicate candidate invalidates pair proof, not a unique directed endpoint.
    assert.equal(rows.filter(r => r.money_kind === 'own_transfer').length, evidence === 'memo' ? 1 : 0);
    assert.ok(rows.every(r => r.possible_transfer === 1), 'nonunique candidates reached');
  }
});

test('W-1 memo digit boundaries, ambiguous masks and outside attribution cannot erase income', async t => {
  for (const variation of ['wrong-digits', 'outside-payee', 'ambiguous-mask', 'unowned']) {
    const f = fixture(t);
    f.account('outgoing'); f.account('incoming', { mask: '2222' });
    f.row('sent', 'outgoing', 10000, { direction: 'outflow', memo: 'TRANSFER FROM X1111 TO X2222' });
    f.row('received', 'incoming', 10000, { memo: 'TRANSFER FROM X1111 TO X2222' });
    assert.ok((await f.query('SELECT * FROM txn')).every(r => r.money_kind === 'own_transfer'), 'evidence control');
    if (variation === 'wrong-digits') f.run("UPDATE fin_transactions SET description='TRANSFER FROM X11111 TO X22222'");
    if (variation === 'outside-payee') f.run("UPDATE fin_transactions SET payee='Client unit' WHERE direction='inflow'");
    if (variation === 'ambiguous-mask') f.account('same-mask', { mask: '2222', entity: 'household' });
    if (variation === 'unowned') f.run("UPDATE fin_entities SET relationship='counterparty'");
    const rows = await f.query('SELECT * FROM txn');
    assert.equal(rows.length, 2);
    const expectedOwn = variation === 'outside-payee' ? 1 : 0;
    assert.equal(rows.filter(r => r.money_kind === 'own_transfer').length, expectedOwn, variation);
    if (variation === 'outside-payee') assert.equal(rows.find(r => r.direction === 'inflow').income_minor, 10000);
    assert.ok(rows.every(r => r.possible_transfer === 1), 'refused pair still reaches candidate decision');
  }
});

test('W-3 unproved card and loan payment text leaves all 768 in spending with uncertainty', async t => {
  const f = fixture(t); f.account('bank');
  f.row('purchase', 'bank', 4000, { direction: 'outflow', payee: 'Supply vendor' });
  f.row('card', 'bank', 32800, { direction: 'outflow', memo: 'CREDIT CARD PAYMENT' });
  f.row('loan', 'bank', 40000, { direction: 'outflow', memo: 'LOAN PAYMENT' });
  f.row('refund', 'bank', 1000, { memo: 'SUPPLY VENDOR REFUND' });
  assert.equal(total(await f.query("SELECT * FROM txn WHERE direction='outflow'")), 76800);
  const rows = await f.route('SELECT * FROM txn ORDER BY id');
  assert.deepEqual(rows.map(r => r.money_kind), ['ordinary', 'ordinary', 'ordinary', 'refund']);
  assert.equal(rows.reduce((n, r) => n + r.expense_minor, 0), 76800);
  assert.deepEqual(rows.map(r => r.uncertain_kind), [null, 'card_payment', 'loan_payment', null]);
  assert.equal(rows.reduce((n, r) => n + r.uncertain_minor, 0), 72800);
  assert.equal(rows.reduce((n, r) => n + r.income_minor, 0), 0);
  f.row('interest', 'bank', 500, { direction: 'outflow', memo: 'LOAN PAYMENT', category: 'INTEREST' });
  assert.equal((await f.query("SELECT expense_minor FROM txn WHERE txn_uid='interest'"))[0].expense_minor, 500, 'explicit interest stays spending');
});

test('W-3 distinct processor memos share a payer group without inventing clients or gross sales', async t => {
  const f = fixture(t); f.account('bank');
  f.row('one', 'bank', 12000, { day: '2026-09-02', memo: 'STRIPE TRANSFER PAYOUT 0101' });
  f.row('two', 'bank', 14000, { memo: 'STRIPE TRANSFER PAYOUT 0202' });
  f.row('ordinary', 'bank', 7000, { payee: 'Client unit' });
  const rows = await f.route("SELECT money_kind,processor,payer_group,count(*) n,sum(income_minor) cents FROM txn GROUP BY money_kind,processor,payer_group ORDER BY money_kind");
  const payout = rows.find(r => r.money_kind === 'payout');
  assert.ok(payout, 'processor tag decision reached');
  assert.equal(payout.n, 2, 'repeat-income grouping reached');
  assert.equal(payout.cents, 26000);
  assert.equal(payout.payer_group, 'processor:stripe');
  assert.equal(rows.find(r => r.money_kind === 'ordinary').n, 1);
});

test('transfer evidence cannot override explicit expenses, refunds or contradictory endpoints', async t => {
  for (const conflict of ['expense', 'refund', 'endpoints']) {
    const f = fixture(t); f.account('outgoing'); f.account('incoming', { mask: '2222' });
    f.row('sent', 'outgoing', 10000, { direction: 'outflow', memo: 'TRANSFER FROM X1111 TO X2222' });
    f.row('received', 'incoming', 10000, { memo: 'TRANSFER FROM X1111 TO X2222', category: 'TRANSFER_IN' });
    assert.equal((await f.query('SELECT * FROM transfer_pairs WHERE proved=1')).length, 1, 'proved green control');
    if (conflict === 'expense') f.run("UPDATE fin_transactions SET category='RENT' WHERE direction='outflow'");
    if (conflict === 'refund') f.run("UPDATE fin_transactions SET description='MERCHANT REFUND' WHERE direction='inflow'");
    if (conflict === 'endpoints') f.run("UPDATE fin_transactions SET description='TRANSFER FROM X2222 TO X1111' WHERE direction='outflow'");
    const candidates = await f.query('SELECT * FROM transfer_pairs');
    assert.equal(candidates.length, 1, 'conflicting evidence still reaches candidate decision');
    assert.equal(candidates[0].proved, 0, conflict);
  }
});

test('client receipts described as loan payments stay income, and unproved payment codes and fees stay spending', async t => {
  const f = fixture(t); f.account('bank');
  f.row('income', 'bank', 15000, { memo: 'LOAN PAYMENT', payee: 'Client unit' });
  f.row('fee', 'bank', 500, { memo: 'LOAN PAYMENT INTEREST', direction: 'outflow', category: 'INTEREST' });
  f.row('payment', 'bank', 20000, { memo: 'CREDIT CARD PAYMENT', direction: 'outflow', category: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' });
  const rows = await f.route('SELECT * FROM txn ORDER BY id');
  assert.equal(rows[0].money_kind, 'ordinary'); assert.equal(rows[0].income_minor, 15000);
  assert.equal(rows[1].expense_minor, 500);
  assert.equal(rows[2].money_kind, 'ordinary', 'a payment code without an owned destination stays spending');
  assert.equal(rows[2].expense_minor, 20000);
  assert.equal(rows[2].uncertain_kind, 'card_payment'); assert.equal(rows[2].uncertain_minor, 20000);
});

test('caller CTE shadows are harmless and trusted internal views stay private', async t => {
  const f = fixture(t); f.account('bank'); f.row('posted', 'bank', 100);
  assert.equal(total(await f.query('WITH selected AS (SELECT * FROM txn) SELECT * FROM selected')), 100);
  assert.equal((await f.query('WITH transfer_pairs AS (SELECT 1 AS n) SELECT * FROM transfer_pairs'))[0].n, 1);
  assert.equal(total(await f.query('WITH owner_rows AS (SELECT 1) SELECT * FROM txn')), 100);
  await assert.rejects(queryMoney(f.env, { sql: 'WITH mq_rows AS (SELECT 1) SELECT * FROM txn' }), e => e.reason === 'reserved_name');
  const calls = f.calls.length;
  await assert.rejects(queryMoney(f.env, { sql: 'SELECT * FROM mq_rows' }), e => e.code === 'MONEY_QUERY_INVALID');
  assert.ok(f.calls.slice(calls).every(sql => sql.startsWith('EXPLAIN ') || sql.includes('FROM sqlite_schema')),
    'internal names cannot reach answer execution');
  assert.equal((await f.query('SELECT * FROM transfer_pairs')).length, 0, 'authorized view control');
});

test('ownerless masks, tenant boundaries and unapproved overlapping providers retain separate sources', async t => {
  const f = fixture(t);
  f.account('older'); f.account('newer', { kind: 'other' });
  f.account('no-mask-one', { mask: null }); f.account('no-mask-two', { mask: null });
  f.account('short-one', { mask: '11' }); f.account('short-two', { mask: '11' });
  f.account('other-tenant'); f.run("UPDATE fin_accounts SET tenant_id='secondary' WHERE account_slug='other-tenant'");
  f.row('old-start', 'older', 100, { day: '2026-09-01' });
  f.row('old-copy', 'older', 200); f.row('new-start', 'newer', 200);
  for (const slug of ['no-mask-one', 'no-mask-two', 'short-one', 'short-two', 'other-tenant']) f.row(slug, slug, 300);
  f.run("UPDATE fin_transactions SET tenant_id='secondary' WHERE account_slug='other-tenant'");
  const rows = await f.route('SELECT * FROM txn ORDER BY id');
  assert.equal(rows.length, 8); assert.equal(total(rows), 2000);
  assert.ok(rows.some(r => r.txn_uid === 'old-start')); assert.ok(rows.some(r => r.txn_uid === 'new-start'));
  assert.ok(rows.some(r => r.txn_uid === 'old-copy'));
  assert.equal((await f.query("SELECT * FROM coverage WHERE account_slug='older'"))[0].duplicate_rows_removed, 0);
});

test('proved liability pairs tag both legs and leave interest on the ordinary spending line', async t => {
  for (const kind of ['card', 'loan']) {
    const f = fixture(t); f.account('bank'); f.account('liability', { mask: '2222', kind });
    f.row('sent', 'bank', 20000, { direction: 'outflow', memo: 'TRANSFER TO ACCOUNT 2222' });
    f.row('received', 'liability', 20000, { memo: 'PAYMENT THANK YOU' });
    f.row('interest', 'bank', 400, { direction: 'outflow', category: 'INTEREST' });
    const rows = await f.route('SELECT * FROM txn ORDER BY id');
    assert.deepEqual(rows.map(r => r.money_kind), [kind + '_payment', kind + '_payment', 'ordinary']);
    assert.equal(rows.reduce((n, r) => n + r.expense_minor, 0), 400);
    assert.equal(rows.reduce((n, r) => n + r.income_minor, 0), 0);
    assert.equal((await f.query('SELECT * FROM transfer_pairs WHERE proved=1')).length, 1, 'repayment pair decision reached');
  }
});

test('lane suite is registered once in the full and post-launcher command lists', () => {
  const command = 'node --test worker/test/clean-money.test.mjs';
  assert.equal(TEST_COMMANDS.filter(c => c === command).length, 1);
  assert.equal(POST_LAUNCHER_TEST_COMMANDS.filter(c => c === command).length, 1);
});

test('advisory payment channels disclose lender suffixes without excluding spending and protect structured vendors', async t => {
  const f = fixture(t); f.account('bank');
  const cases = [
    ['card', 'CREDIT CARD PAYMENT CARDPAY', null, 'card'],
    ['loan', 'LOAN PAYMENT lender', 'lender', 'loan'],
    ['autopay', 'MORTGAGE AUTOPAY lender', 'lender', 'loan'],
    ['vendor', 'CREDIT CARD PAYMENT CARDPAY', 'Store unit', null],
  ];
  for (const [uid, memo, payee] of cases) f.row(uid, 'bank', 10000, { direction: 'outflow', memo, payee });
  const accounts = await readEffectiveAccounts(f.env), map = new Map(accounts.map(a => [a.account_slug, a]));
  const raw = await readEffectiveTransactions(f.env, accounts, { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(raw.length, 4, 'oracle reaches each channel and vendor decision');
  for (const [uid, , , expected] of cases) {
    const oracle = possibleUnconnectedPayment(raw.find(r => f.db.prepare('SELECT txn_uid FROM fin_transactions WHERE id=?').get(r.id).txn_uid === uid), map);
    assert.equal(oracle?.kind ?? null, expected);
    const [row] = await f.query(`SELECT * FROM txn WHERE txn_uid='${uid}'`);
    assert.equal(row.money_kind, 'ordinary'); assert.equal(row.expense_minor, 10000);
    assert.equal(row.uncertain_kind, expected ? expected + '_payment' : null);
    assert.equal(row.uncertain_minor, expected ? 10000 : 0);
  }
});

test('R3 repayment membership covers provider codes, payees and every liability credit', async t => {
  for (const [kind, category] of [
    ['card', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'],
    ['card', 'CREDIT_CARD_PAYMENTS_AUTOPAY'],
    ['loan', 'LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT'],
    ['loan', 'LOAN_PAYMENTS_MORTGAGE_PAYMENT'],
    ['line_of_credit', 'LOAN_PAYMENTS_OTHER_PAYMENT'],
  ]) {
    for (const payee of [null, 'CREDIT CARD PAYMENT', 'Lender unit']) {
      for (const direction of ['inflow', 'outflow']) {
        const f = fixture(t); f.account('bank'); f.account('liability', { kind, mask: '2222' });
        const expected = kind === 'card' ? 'card_payment' : 'loan_payment';
        f.row('payment', 'bank', 40000, { direction, memo: direction === 'outflow' ? 'ACH DEBIT' : 'ACH CREDIT', category, payee });
        f.row('supply', 'bank', 4000, { direction: 'outflow', payee: 'Supply vendor' });
        f.row('client', 'bank', 100000, { payee: 'Client unit' });
        f.row('liability-credit', 'liability', 50000, { memo: 'ACH CREDIT', payee });
        f.row('liability-outside-words', 'liability', 5000, { memo: 'CUSTOMER INVOICE', category: 'SALES', payee: 'Client unit' });
        f.row('liability-interest-credit', 'liability', 500, { memo: 'INTEREST ADJUSTMENT', category: 'INTEREST' });
        f.row('liability-refund', 'liability', 1000, { memo: 'MERCHANT REFUND', category: 'REFUND' });
        const rows = await f.route('SELECT * FROM txn');
        const payment = rows.find(r => r.txn_uid === 'payment');
        assert.equal(payment.money_kind, direction === 'inflow' ? expected : 'ordinary', [kind, payee, direction].join('/'));
        if (direction === 'outflow') {
          assert.equal(payment.uncertain_kind, expected); assert.equal(payment.uncertain_minor, 40000);
        }
        for (const uid of ['liability-credit', 'liability-outside-words', 'liability-interest-credit'])
          assert.equal(rows.find(r => r.txn_uid === uid).money_kind, expected);
        assert.equal(rows.find(r => r.txn_uid === 'liability-refund').money_kind, 'refund');
        assert.equal(rows.reduce((n, r) => n + r.expense_minor, 0), direction === 'inflow' ? 4000 : 44000);
        assert.equal(rows.reduce((n, r) => n + r.income_minor, 0), 100000);
        const accounts = await readEffectiveAccounts(f.env), map = new Map(accounts.map(a => [a.account_slug, a]));
        const raw = await readEffectiveTransactions(f.env, accounts, { from: '2026-10-01', to: '2026-10-31' });
        assert.equal(loanCardPaymentKind(raw.find(r => r.category === category), map), direction === 'inflow' ? kind === 'card' ? 'card' : 'loan' : null);
      }
    }
  }
});

test('R3 lender-payee debit without an owned destination stays spending with the supply purchase', async t => {
  const f = fixture(t); f.account('bank');
  f.row('repayment', 'bank', 40000, { direction: 'outflow', memo: 'ACH DEBIT', payee: 'Lender unit', category: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' });
  f.row('supply', 'bank', 4000, { direction: 'outflow', payee: 'Supply vendor' });
  assert.equal((await f.query('SELECT SUM(expense_minor) n FROM txn'))[0].n, 44000);
  assert.equal((await f.query('SELECT SUM(uncertain_minor) n FROM txn'))[0].n, 40000);
});

test('R3 checking repayment memos accept an owned lender and retain outside client income', async t => {
  for (const kind of ['card', 'loan', 'line_of_credit']) {
    const f = fixture(t); f.account('bank'); f.account('lender', { kind, mask: '2222' });
    const memo = kind === 'card' ? 'CREDIT CARD PAYMENT' : 'LOAN PAYMENT';
    f.row('returned', 'bank', 50000, { memo, payee: 'lender' });
    f.row('client', 'bank', 100000, { memo, payee: 'Client unit' });
    const rows = await f.query('SELECT * FROM txn');
    assert.equal(rows[0].money_kind,'ordinary');assert.equal(rows[0].income_minor,50000);
    assert.equal(rows[0].estimated,1);assert.equal(rows[0].estimate_reason,'payment_wording_on_deposit_credit_counted');
    assert.equal(rows[1].income_minor, 100000);
  }
});

test('STRUCT replaces R3 identity-only exclusion: uncoded lender credits stay estimated income', async t => {
  for (const kind of ['card', 'loan', 'line_of_credit']) {
    const f = fixture(t); f.account('bank'); f.account('lender', { kind, mask: '2222' });
    f.row('returned', 'bank', 50000, { memo: 'ACH CREDIT', payee: 'lender' });
    f.row('client', 'bank', 100000, { memo: 'ACH CREDIT', payee: 'Client unit' });
    const rows = await f.query('SELECT * FROM txn');
    assert.equal(rows[0].money_kind, 'ordinary');
    assert.equal(rows[0].estimated, 1);
    assert.equal(rows[0].income_minor, 50000);
    assert.equal(rows[1].income_minor, 100000);
  }
});

test('STRUCT exact R3-A bank bonus stays income', async t => {
  const f = fixture(t); f.account('bank'); f.account('card', {kind:'card',mask:'2222'});
  f.run("UPDATE fin_accounts SET institution='Example Bank' WHERE account_slug='card'");
  f.row('bonus','bank',30000,{memo:'NEW ACCOUNT BONUS',payee:'Example Bank',category:'OTHER_INCOME'});
  assert.equal((await f.query('SELECT SUM(income_minor) n FROM txn'))[0].n,30000);
});

test('STRUCT exact R2 directed standalone repayment leaves 4000 spending', async t => {
  const f = fixture(t); f.account('bank'); f.account('card',{kind:'card',mask:'2222'});
  f.row('repayment','bank',40000,{direction:'outflow',memo:'TRANSFER TO ACCOUNT 2222'});
  f.row('supply','bank',4000,{direction:'outflow',payee:'Supply vendor'});
  assert.equal((await f.query('SELECT SUM(expense_minor) n FROM txn'))[0].n,4000);
});

test('STRUCT account kind x direction x evidence matrix has identical SQL and product totals', async t => {
  const {classifyMoneyMovement,moneyMovementReading} = await import('../src/lib/money-analysis.js');
  let checked = 0;
  for (const kind of ['checking','savings','card','loan','line_of_credit']) {
    for (const direction of ['inflow','outflow']) {
      for (const evidence of ['pair','link','endpoint','category','lender_repayment','lender_only','none']) {
        const f = fixture(t); f.account('bank'); f.account('target',{kind,mask:'2222'});
        if (evidence === 'link') { f.account('archive',{mode:'manual',kind,mask:'3333'}); f.link('archive','target'); f.coverage('archive','2026-10-01','2026-10-31'); f.coverage('target','2026-10-01','2026-10-31'); }
        const slug = direction === 'outflow' ? 'bank' : 'target';
        const liability = ['card','loan','line_of_credit'].includes(kind);
        const memo = ['pair','link','endpoint'].includes(evidence)
          ? direction === 'outflow' ? `TRANSFER TO ACCOUNT ${evidence === 'link' ? '3333' : '2222'}` : 'TRANSFER FROM ACCOUNT 1111'
          : direction === 'outflow' ? 'ACH DEBIT' : 'ACH CREDIT';
        const category = ['category','lender_repayment'].includes(evidence) ? kind === 'card' ? 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' : 'LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT' : null;
        f.row('tested',slug,40000,{direction,memo,category,payee:evidence.startsWith('lender') ? 'target' : null});
        if (evidence === 'pair') f.row('counterpart',direction === 'outflow' ? 'target' : 'bank',40000,{
          direction:direction === 'outflow' ? 'inflow' : 'outflow',memo:direction === 'outflow' ? 'TRANSFER FROM ACCOUNT 1111' : 'TRANSFER TO ACCOUNT 2222'});
        const rows = await f.query('SELECT * FROM txn ORDER BY id');
        const tested = rows.find(r=>r.txn_uid==='tested');
        const closed = ['pair','link','endpoint'].includes(evidence) ? liability ? 'card_or_loan_payment' : 'own_transfer'
          : category && direction === 'inflow' ? 'card_or_loan_payment' : 'unknown';
        // A code without an owned endpoint cannot exclude an outgoing payment.
        const expectedKind = closed === 'own_transfer' ? 'own_transfer' : closed === 'card_or_loan_payment' ? (kind === 'card' ? 'card' : 'loan')+'_payment'
          : direction === 'inflow' && liability ? (kind === 'card' ? 'card' : 'loan')+'_payment' : 'ordinary';
        assert.equal(tested.money_kind,expectedKind,[kind,direction,evidence].join('/'));
        const accounts = await readEffectiveAccounts(f.env), map = new Map(accounts.map(a=>[a.account_slug,a]));
        const raw = await readEffectiveTransactions(f.env,accounts,{from:'2026-10-01',to:'2026-10-31'});
        const pairs = pairOwnTransfers(raw,map,{directedEvidence:true}).pairs;
        let income=0,spending=0;
        for (const row of raw) {
          const reading = moneyMovementReading(row,map,pairs,{clean:true});
          const sqlRow = rows.find(r=>r.id===row.id);
          assert.equal(classifyMoneyMovement(row,map,pairs),closed,'legacy classification stays unchanged');
          assert.equal(sqlRow.movement_classification,reading.classification);
          assert.equal(sqlRow.money_kind,reading.money_kind);
          // Only a complete matching pair proves these risky movement arms.
          // The base reader's estimate flag predates the private type check.
          assert.equal(sqlRow.estimated,Number(evidence!=='pair'),[kind,direction,evidence,row.txn_uid].join('/'));
          assert.equal(sqlRow.uncertain_kind,reading.uncertain_kind);
          if(reading.money_kind==='ordinary') { if(row.direction==='inflow') income+=row.amount_minor;else spending+=row.amount_minor; }
        }
        assert.equal(rows.reduce((n,r)=>n+r.income_minor,0),income);
        assert.equal(rows.reduce((n,r)=>n+r.expense_minor,0),spending);
        const cleanClosed=closed!=='unknown' ? closed : category ? 'unknown' : direction==='outflow' ? 'spending' :
          !liability && evidence==='lender_only' ? 'income' : 'unknown';
        assert.equal(tested.movement_classification,cleanClosed);
        checked++;
      }
    }
  }
  assert.equal(checked,70);
});

test('STRUCT bank earnings, client income, supply purchase and refund controls keep all rows', async t => {
  const f=fixture(t);f.account('bank');f.account('lender',{kind:'card',mask:'2222'});
  for(const [uid,memo,category] of [['bonus','NEW ACCOUNT BONUS','OTHER_INCOME'],['interest','INTEREST PAID','INTEREST_INCOME'],['cashback','CASHBACK','OTHER_INCOME']])
    f.row(uid,'bank',30000,{memo,category,payee:'lender'});
  f.row('client','bank',100000,{memo:'CLIENT INVOICE',payee:'Client unit',category:'SALES'});
  f.row('supply','bank',4000,{direction:'outflow',payee:'Supply vendor',category:'PURCHASE'});
  f.row('refund','bank',1000,{memo:'SUPPLY REFUND',category:'REFUND'});
  const rows=await f.query('SELECT * FROM txn');
  assert.equal(rows.length,6);
  assert.equal(rows.reduce((n,r)=>n+r.income_minor,0),190000);
  assert.equal(rows.reduce((n,r)=>n+r.expense_minor,0),4000);
  assert.equal(rows.find(r=>r.txn_uid==='refund').money_kind,'refund');
});

test('STRUCT amounts and membership stay on one snapshot during a concurrent sync', async t => {
  const f=fixture(t);f.account('bank');f.account('card',{kind:'card',mask:'2222'});
  f.row('tested','bank',40000,{direction:'outflow',memo:'TRANSFER TO ACCOUNT 2222'});
  const prepare=f.env.DB.prepare.bind(f.env.DB);let changed=false;
  f.env.DB.prepare=sql=>{
    const statement=prepare(sql);
    if(sql.includes(' AS snapshot_kind')) {
      const all=statement.all;
      statement.all=async()=>{const result=await all();f.run("UPDATE fin_transactions SET amount_minor=99999,description='SUPPLIES',category='PURCHASE'");changed=true;return result;};
    }
    return statement;
  };
  const rows=await f.query('SELECT * FROM txn');
  assert.equal(changed,true);
  assert.equal(rows[0].amount_minor,40000);
  assert.equal(rows[0].money_kind,'card_payment');
  assert.equal(rows[0].expense_minor,0);
});

test('STRUCT directed repayment text cannot erase explicit interest, fee or purchase spending', async t => {
  const f=fixture(t);f.account('bank');f.account('card',{kind:'card',mask:'2222'});
  for(const category of ['INTEREST','FEES','PURCHASE','LOAN_PAYMENTS_INTEREST'])
    f.row(category,'bank',500,{direction:'outflow',memo:'TRANSFER TO ACCOUNT 2222',category});
  const rows=await f.query('SELECT * FROM txn');
  assert.equal(rows.reduce((n,r)=>n+r.expense_minor,0),2000);
  assert.ok(rows.every(r=>r.movement_classification==='spending'));
});

test('STRUCT three structural mutants are killed and restored in disposable copies', async () => {
  const fs=await import('node:fs'),path=await import('node:path'),os=await import('node:os');
  const {fileURLToPath}=await import('node:url'),{spawnSync}=await import('node:child_process');
  const root=fileURLToPath(new URL('../../',import.meta.url));
  const folder=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'brain-struct-mutants-')));
  const inputs=['worker/src','worker/test/clean-money.test.mjs','migrations/d1','package.json','scripts/run-test-chain.mjs'];
  const env=Object.fromEntries(['PATH','SystemRoot','TEMP','TMP','TMPDIR'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  try {
    for(const name of inputs){fs.mkdirSync(path.dirname(path.join(folder,name)),{recursive:true});fs.cpSync(path.join(root,name),path.join(folder,name),{recursive:true});}
    const run=pattern=>spawnSync(process.execPath,['--test','--test-reporter=tap','--test-name-pattern',pattern,'worker/test/clean-money.test.mjs'],{cwd:folder,env,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});
    const green=run('STRUCT exact|STRUCT bank earnings');
    assert.equal(green.status,0,green.stdout+green.stderr);
    const mutations=[
      {name:'lender identity without repayment evidence',file:'money-analysis.js',pattern:'STRUCT exact R3-A',edits:[['function repaymentKind(row, accounts) {',`function repaymentKind(row, accounts) {
  const lender=[...accounts.values()].find(a=>['card','loan','line_of_credit'].includes(a.account_kind) && row.payee && [a.label,a.institution].some(v=>normalizeLedgerText(v)===normalizeLedgerText(row.payee)));
  if(lender) return lender.account_kind==='card'?'card':'loan';`]]},
      {name:'directed endpoint removed',file:'money-analysis.js',pattern:'STRUCT exact R2',edits:[
        ['const account = accounts.has(row.effective_account_slug) ? loanCardPaymentAccount(row, accounts) : null;','const account = null;'],
        ['const endpoint = possibleOwnedMovement(row, accounts);','const endpoint = null;']]},
      {name:'independent SQL membership defaults',file:'clean-money.js',pattern:'STRUCT exact R2',edits:[
        ['const {classification,money_kind,estimated,estimate_reason,uncertain_kind} = loanDrawReading(row,reading,accounts,pairs);',"const classification=row.direction==='inflow'?'income':'spending',money_kind='ordinary',estimated=0,estimate_reason=null,uncertain_kind=null;"]]},
    ];
    for(const mutation of mutations){
      const file=path.join(folder,'worker/src/lib',mutation.file),source=fs.readFileSync(file,'utf8');
      let changed=source;
      for(const [from,to] of mutation.edits){assert.equal(changed.split(from).length-1,1,mutation.name+': exact decision');changed=changed.replace(from,to);}
      try {
        fs.writeFileSync(file,changed);
        const red=run(mutation.pattern);
        assert.equal(red.error,undefined,mutation.name);
        assert.equal(red.status,1,mutation.name+'\n'+red.stdout+red.stderr);
        assert.match(red.stdout,/AssertionError/,mutation.name);
      } finally {fs.writeFileSync(file,source);}
      assert.equal(fs.readFileSync(file,'utf8'),source,mutation.name+': restored');
    }
    console.log('mutants_killed=3/3 restored=3/3');
  } finally {
    // mkdtemp created this exact absolute system-temp directory; never remove
    // the parent or a computed repository path.
    const relative=path.relative(fs.realpathSync.native(os.tmpdir()),folder);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(folder).startsWith('brain-struct-mutants-'));
    fs.rmSync(folder,{recursive:true,force:true});
  }
});

test('STRUCT frozen snapshot uses bounded SQL with bound values for a larger input', async t => {
  const f=fixture(t);f.account('bank');
  const memo='SYNTHETIC SUPPLY NOTE '+ 's'.repeat(1000);
  for(let i=0;i<300;i++) f.row('supply-'+i,'bank',100,{direction:'outflow',memo,category:'PURCHASE'});
  const before=f.calls.length;
  assert.equal((await f.query('SELECT SUM(expense_minor) n FROM txn'))[0].n,30000);
  const final=f.calls.slice(before).find(sql=>sql.startsWith('SELECT * FROM (\n'));
  assert.ok(final.length<100000,'clean view SQL stays below the native statement size limit');
  assert.ok(!final.includes(memo),'transaction content travels as bound values');
});

test('STRUCT linked account review uses the live primary in both readers', async t => {
  const f=fixture(t);f.account('bank');f.account('archive',{mode:'manual',kind:'card',mask:'3333'});
  f.account('target',{kind:'card',mask:'2222'});f.link('archive','target');
  for(const slug of ['archive','target']) f.coverage(slug,'2026-10-01','2026-10-31');
  const {accountKindIdentity}=await import('../src/lib/fin-account-kinds.js');
  const account=f.db.prepare("SELECT * FROM fin_accounts WHERE account_slug='target'").get();
  f.run(`INSERT INTO fin_account_kind_reviews(tenant_id,account_id,identity_json,kind,role,reviewer,source,reviewed_at,review_plan_hash)
    VALUES ('primary',?,?,'loan','liability','owner','owner_account_kind',?,?)`,account.id,accountKindIdentity(account),at,'b'.repeat(64));
  f.row('payment','bank',40000,{direction:'outflow',memo:'TRANSFER TO ACCOUNT 2222'});
  const accounts=await readEffectiveAccounts(f.env),map=new Map(accounts.map(a=>[a.account_slug,a]));
  const rows=await readEffectiveTransactions(f.env,accounts,{from:'2026-10-01',to:'2026-10-31'});
  assert.equal(loanCardPaymentKind(rows[0],map),'loan');
  assert.equal((await f.query('SELECT * FROM txn'))[0].money_kind,'loan_payment');
});

test('STRUCT founder rule keeps every liability credit out of income, including bank earnings labels', async t => {
  for(const kind of ['checking','savings','card','loan','line_of_credit']) {
    const f=fixture(t);f.account('bank',{kind});f.account('lender',{kind:'card',mask:'2222'});
    for(const [uid,memo] of [['bonus','NEW ACCOUNT BONUS'],['cashback','CASHBACK'],['interest','INTEREST PAID']])
      f.row(uid,'bank',1000,{memo,payee:'lender',category:'OTHER_INCOME'});
    const rows=await f.route('SELECT * FROM txn');
    assert.equal(rows.length,3,'the real money endpoint read all three earnings-labelled credits');
    const liability=['card','loan','line_of_credit'].includes(kind);
    assert.equal(rows.reduce((n,r)=>n+r.income_minor,0),liability?0:3000,kind);
    assert.ok(rows.every(r=>r.movement_classification===(liability?'unknown':'income')),kind);
    assert.ok(rows.every(r=>r.money_kind===(liability?(r.description==='INTEREST PAID'?(kind==='card'?'card':'loan')+'_payment':'liability_credit'):'ordinary')),kind);
    assert.ok(rows.every(r=>r.estimated===Number(liability)),kind);
  }
});

test('STRUCT bank earnings are income only on deposit accounts; liability credits never are', async t => {
  for(const kind of ['checking','savings','card','loan','line_of_credit']) {
    const f=fixture(t);f.account('bank',{kind});f.account('lender',{kind:'card',mask:'2222'});
    for(const [uid,memo] of [['bonus','NEW ACCOUNT BONUS'],['cashback','CASHBACK'],['interest','INTEREST PAID']])
      f.row(uid,'bank',1000,{memo,payee:'lender',category:'OTHER_INCOME'});
    const rows=await f.query('SELECT * FROM txn');
    // The founder's liability rule also applies when bank wording says income.
    assert.equal(rows.reduce((n,r)=>n+r.income_minor,0),['checking','savings'].includes(kind)?3000:0,kind);
    assert.ok(rows.every(r=>r.movement_classification===(['card','loan','line_of_credit'].includes(kind)?'unknown':'income')));
  }
});

test('QUALITY unproved payments and loan wording stay counted; separate payment fees remain expenses', async t => {
  const f=fixture(t);f.account('bank');f.account('card',{kind:'card',mask:'2222'});
  f.row('store','bank',4500,{direction:'outflow',memo:'Card payment to Store unit'});
  f.row('copied-store','bank',5500,{direction:'outflow',memo:'Card payment to Store unit',payee:'Card payment to Store unit'});
  f.row('fee','bank',495,{direction:'outflow',memo:'CREDIT CARD PAYMENT FEE'});
  f.row('card-fee','card',695,{direction:'outflow',memo:'CARD PAYMENT FEE'});
  f.row('possible-advance','bank',90000,{memo:'Loan proceeds',category:'LOAN_DISBURSEMENT'});
  f.run("UPDATE fin_transactions SET category_basis_state='proposed' WHERE txn_uid='possible-advance'");
  const rows=await f.route('SELECT * FROM txn ORDER BY id');
  assert.equal(rows.reduce((n,r)=>n+r.expense_minor,0),11190);
  assert.equal(rows.reduce((n,r)=>n+r.income_minor,0),90000);
  assert.ok(rows.slice(0,2).every(r=>r.money_kind==='ordinary' && r.estimated===1));
  assert.equal(rows.at(-1).estimate_reason,'possible_loan_proceeds_counted');
  assert.ok(rows.slice(2,4).every(r=>r.movement_classification==='spending'));
});

test('QUALITY return wording, rewards and customer refunds stay separate from repayments and income', async t => {
  const f=fixture(t);f.account('bank');f.account('card',{kind:'card',mask:'2222'});
  for(const [uid,memo,payee] of [['returned','MERCHANDISE RETURN',null],['reversed','PURCHASE REVERSED',null],
    ['payee-credit','MERCHANT CREDIT','merchant refund'],['dispute','DISPUTE WON',null]])
    f.row(uid,'card',1000,{memo,payee});
  f.row('reward','card',1200,{memo:'CARD REWARD CREDIT'});
  f.row('refund-sent','bank',500,{direction:'outflow',memo:'Customer refund',category:'CUSTOMER_REFUND'});
  f.row('chargeback-fee','bank',200,{direction:'outflow',memo:'Chargeback fee',category:'CHARGEBACK_FEE'});
  const rows=await f.route('SELECT * FROM txn ORDER BY id');
  assert.ok(rows.slice(0,4).every(r=>r.money_kind==='refund'));
  assert.equal(rows[4].money_kind,'liability_credit');
  assert.equal(rows[5].money_kind,'refund');
  assert.equal(rows.reduce((n,r)=>n+r.income_minor,0),0);
  assert.equal(rows.reduce((n,r)=>n+r.expense_minor,0),200);
});

test('QUALITY coded borrowing and processor sweeps are distinct from earned receipts', async t => {
  const f=fixture(t);f.account('bank');f.account('loan',{kind:'loan',mask:'2222'});
  f.account('processor',{kind:'merchant',mask:'3333'});
  f.row('advance','bank',90000,{memo:'ACH CREDIT',category:'LOAN_DISBURSEMENT'});
  f.row('draw-out','loan',70000,{direction:'outflow',memo:'TRANSFER TO ACCOUNT 1111'});
  f.row('draw-in','bank',70000,{memo:'TRANSFER FROM ACCOUNT 2222'});
  f.row('sales','processor',10000,{memo:'CUSTOMER SALES',category:'GROSS_SALES'});
  f.row('fee','processor',300,{direction:'outflow',memo:'Stripe processing fees',category:'PROCESSOR_FEES'});
  f.row('sweep-out','processor',9700,{direction:'outflow',memo:'Stripe payout to owner bank',payee:'Stripe',category:'TRANSFER_OUT'});
  f.row('sweep-in','bank',9700,{memo:'Stripe payout from owner processor',payee:'Stripe',category:'TRANSFER_IN'});
  const rows=await f.route('SELECT * FROM txn ORDER BY id');
  assert.ok(rows.slice(0,3).every(r=>r.money_kind==='loan_proceeds'));
  assert.ok(rows.slice(-2).every(r=>r.money_kind==='own_transfer'));
  assert.equal(rows.at(-1).processor,'stripe');
  assert.equal(rows.at(-1).transfer_basis,'processor_sweep');
  assert.equal(rows.reduce((n,r)=>n+r.income_minor,0),10000);
  assert.equal(rows.reduce((n,r)=>n+r.expense_minor,0),300);
});

test('QUALITY pending totals suppress only a provider-linked posted twin in the same account', async t => {
  // The route uses the wall clock; keep both holds current (fix step 8 reports
  // holds older than fourteen days separately as stale).
  const recent=new Date(Date.now()-2*86400000).toISOString().slice(0,10);
  const f=fixture(t);f.account('bank');f.account('other',{mask:'2222'});
  f.row('pending','bank',4550,{direction:'outflow',pending:1,day:recent});
  f.row('unknown-amount','bank',100,{pending:1,day:recent});
  f.run("UPDATE fin_transactions SET external_id='pending-one',source_provider='plaid' WHERE txn_uid='pending'");
  f.run("UPDATE fin_transactions SET amount_minor=NULL,direction=NULL,basis_state='unparsed',unparsed_reason='Amount unavailable' WHERE txn_uid='unknown-amount'");
  let coverage=(await f.route("SELECT * FROM coverage WHERE account_slug='bank'"))[0];
  assert.equal(coverage.pending_rows,2);assert.equal(coverage.pending_out_minor,4550);
  assert.equal(coverage.pending_in_minor,0);assert.equal(coverage.pending_oldest_on,recent);
  f.row('posted-other','other',4550,{direction:'outflow'});
  f.run("UPDATE fin_transactions SET pending_transaction_id='pending-one',source_provider='plaid' WHERE txn_uid='posted-other'");
  assert.equal((await f.query("SELECT pending_rows FROM coverage WHERE account_slug='bank'"))[0].pending_rows,2);
  f.row('posted','bank',4550,{direction:'outflow'});
  f.run("UPDATE fin_transactions SET pending_transaction_id='pending-one',source_provider='plaid' WHERE txn_uid='posted'");
  coverage=(await f.route("SELECT * FROM coverage WHERE account_slug='bank'"))[0];
  assert.equal(coverage.pending_rows,1);assert.equal(coverage.pending_out_minor,0);
  assert.equal((await f.query("SELECT SUM(expense_minor) n FROM txn WHERE account_slug='bank'"))[0].n,4550);
});

test('STRUCT explicit bank earnings are income on assets and never income on liabilities', async t => {
  for(const kind of ['checking','savings','card','loan','line_of_credit']) {
    const f=fixture(t);f.account('bank',{kind});f.account('lender',{kind:'card',mask:'2222'});
    for(const [uid,memo] of [['bonus','NEW ACCOUNT BONUS'],['cashback','CASHBACK'],['interest','INTEREST PAID']])
      f.row(uid,'bank',1000,{memo,payee:'lender',category:'OTHER_INCOME'});
    const rows=await f.query('SELECT * FROM txn');
    const liability = ['card','loan','line_of_credit'].includes(kind);
    assert.equal(rows.reduce((n,r)=>n+r.income_minor,0),liability ? 0 : 3000,kind);
    assert.ok(rows.every(r=>r.movement_classification===(liability ? 'unknown' : 'income')));
  }
});

test('R2 B1 frozen amounts retain REAL arithmetic through the owner route', async t => {
  const f = fixture(t); f.account('bank');
  for (const cents of [10000, 5000, 2500]) f.row(`whole-${cents}`, 'bank', cents);
  await t.test('whole dollars keep their SQL decimal type', async () => {
    const rows = await f.route('SELECT typeof(amount) AS type FROM txn');
    assert.deepEqual(rows.map(r => r.type), ['real', 'real', 'real']);
  });
  await t.test('average does not use integer division', async () => {
    const rows = await f.route('SELECT sum(amount)/count(*) AS average FROM txn');
    assert.ok(Math.abs(rows[0].average - 175 / 3) < 1e-9, String(rows[0].average));
  });
  await t.test('share does not round down to zero', async () => {
    const rows = await f.route('SELECT sum(CASE WHEN amount_minor=2500 THEN amount END)/sum(amount) AS share FROM txn');
    assert.ok(Math.abs(rows[0].share - 25 / 175) < 1e-9, String(rows[0].share));
  });
  await t.test('fractional dollars keep exact cents', async () => {
    f.row('fractional', 'bank', 12345);
    assert.equal((await f.route('SELECT amount FROM txn WHERE amount_minor=12345'))[0].amount, 123.45);
  });
});

test('R1 B2 all trusted SQL function calls fit the 32 argument D1 limit', async () => {
  const {CLEAN_MONEY_SNAPSHOT_SQL,cleanMoneyCtes,classifiedMoneyCtes}=await import('../src/lib/clean-money.js');
  const binds=[];
  for(const sql of [CLEAN_MONEY_SNAPSHOT_SQL,cleanMoneyCtes(),classifiedMoneyCtes({rows:[],accounts:[],pairs:[],coverage:[]},binds)]) {
    const tokens=sql.match(/--[^\n]*|'(?:''|[^'])*'|[a-z_][a-z_0-9]*|[(),]|[^\s]/gi);
    const stack=[];
    for(let i=0;i<tokens.length;i++) {
      if(tokens[i].startsWith('--'))continue;
      if(tokens[i]==='(')stack.push({name:tokens[i-1],commas:0,empty:tokens[i+1]===')'});
      else if(tokens[i]===',') {if(stack.length)stack.at(-1).commas++;}
      else if(tokens[i]===')') {
        const call=stack.pop();
        if(call && /^[a-z_][a-z_0-9]*$/i.test(call.name) && !/^(?:as|materialized|in|over|exists)$/i.test(call.name))
          assert.ok(call.empty || call.commas+1<=32,`${call.name}: ${call.commas+1} arguments`);
      }
    }
    assert.equal(stack.length,0);
  }
});

test('R1 B3 frozen JSON groups end at records and obey UTF-8 value limits', async () => {
  const {classifiedMoneyCtes}=await import('../src/lib/clean-money.js');
  const binds=[];
  const rows=Array.from({length:4},(_,id)=>({id,tenant_id:'primary',description:'😀'.repeat(180000)}));
  const sql=classifiedMoneyCtes({rows,accounts:[],pairs:[],coverage:[]},binds);
  assert.doesNotMatch(sql,/\?\d+\s*\|\|\s*\?\d+/);
  const restored=binds.flatMap(value=>{
    assert.ok(new TextEncoder().encode(value).length<=1500000);
    return JSON.parse(value);
  });
  assert.deepEqual(restored.filter(r=>r.description).map(r=>[r.id,r.description]),rows.map(r=>[r.id,r.description]));
  assert.throws(()=>classifiedMoneyCtes({rows:[{id:1,description:'😀'.repeat(400000)}],accounts:[],pairs:[],coverage:[]},[]),/snapshot record/i);
});
