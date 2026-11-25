import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { overviewFixture } from './helpers/money-overview-fixture.mjs';
import { overviewMoney } from '../src/lib/money-overview.js';
import { queryMoney } from '../src/lib/money-query.js';

const day = '2025-12-03';
const options = { now: () => Date.parse('2025-12-04T00:30:00Z') };
const queryArgs = { sql: "SELECT SUM(amount_minor) AS figure FROM txn WHERE posted_on='2025-12-03'", from: day, through: day };
const rawArgs = {
  sql: "SELECT direction,SUM(amount_minor) AS figure FROM fin_transactions WHERE account_slug='checking' AND posted_on='2025-12-03' GROUP BY direction",
  period_from: day, period_to: day,
};
const discovery = /1 discovered feed accounts have no current ledger account; their coverage and dollar impact are unknown/;
const providerConflict = /provider conflict.*dollar impact are unknown/i;
const datedGap = /No bank data after 2025-12-02 for the account ending 1234/;
const unknownFreshness = /bank freshness is unknown for the account ending 1234/i;

test('legacy public account evidence preserves the released High confidence', async t => {
  const f = overviewFixture(t);
  seedAccount(f, 'checking', 'plaid', 'public');
  f.run("UPDATE fin_accounts SET source_feed=NULL WHERE account_slug='checking'");
  f.run("UPDATE fin_entities SET kind='business'");
  f.coverage('checking', '2025-01-01', '2026-11-13');
  f.row('rent', 'checking', '2026-10-12', 80000, 'outflow', { description: 'Office rent paid to property owner' });
  f.row('repairs', 'checking', '2026-10-12', 120000, 'outflow', { description: 'Repairs to business office' });
  f.run("UPDATE fin_transactions SET payee='Supplier',category_basis_state='confirmed'");
  const receipt = '2026-11-13T14:00:00Z';
  f.run('UPDATE bank_feed_items SET last_synced_at=?', receipt);
  const clock = { now: () => Date.parse('2026-11-13T15:00:00Z') };
  const query = await queryMoney(f.env, {
    sql: "SELECT SUM(expense_minor) AS figure FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31'",
    period_from: '2026-10-01', period_to: '2026-10-31', time_zone: 'America/Phoenix',
  }, clock);
  assert.equal(query.rows[0].figure, 200000);
  assert.equal(query.confidence.level, 'High', query.confidence_text);
  assert.equal(query.confidence.percent, 95);
  const overview = await overviewMoney(f.env, clock);
  assert.equal(overview.accounts[0].connected, true);
  assert.equal(overview.accounts[0].last_sync, receipt);
});

test('a saved wrong Item blocks a foreign public account reference', async t => {
  const f = overviewFixture(t);
  const foreignRef = seedAccount(f, 'foreign', 'plaid', 'public');
  seedAccount(f, 'checking', 'plaid', 'public');
  f.run("UPDATE fin_accounts SET external_ref=? WHERE account_slug='checking'", foreignRef);
  f.run("UPDATE bank_feed_items SET last_synced_at='2025-12-04T00:30:00Z' WHERE item_ref='foreign'");
  f.row('rent', 'checking', day, 80000, 'outflow', { description: 'Office rent' });
  const query = await queryMoney(f.env, queryArgs, options);
  assert.equal(query.rows[0].figure, 80000);
  assert.match(query.confidence_text, /Account ending 1234 is not connected/);
  const overview = await overviewMoney(f.env, options);
  const account = overview.accounts.find(row => row.account_slug === 'checking');
  assert.equal(account.connected, false);
  assert.equal(account.last_sync, null);
});

test('a scoped legacy account retains its dated bank freshness warning', async t => {
  const f = overviewFixture(t);
  seedAccount(f, 'checking', 'plaid', 'public');
  f.run("UPDATE fin_accounts SET source_feed=NULL WHERE account_slug='checking'");
  f.run("UPDATE bank_feed_items SET last_synced_at='2025-12-02T22:00:00Z'");
  f.row('debit', 'checking', day, 4309, 'outflow');
  const query = await queryMoney(f.env, {
    ...queryArgs,
    sql: "SELECT SUM(amount_minor) AS figure FROM txn WHERE account_slug='checking' AND posted_on='2025-12-03'",
  }, options);
  assert.equal(query.rows[0].figure, 4309);
  assert.match(query.confidence_text, datedGap);
});

test('EUR postings retain the dated gap for a USD bank account', async t => {
  const f = overviewFixture(t);
  f.account('checking', 'live');
  f.connection('checking');
  f.run("UPDATE bank_feed_items SET last_synced_at='2025-12-02T22:00:00Z'");
  f.row('in', 'checking', day, 1207, 'inflow', { currency: 'EUR' });
  f.row('out', 'checking', day, 4309, 'outflow', { currency: 'EUR' });
  f.row('outside', 'checking', '2025-12-04', 9876, 'inflow', { currency: 'EUR' });
  const sql = "SELECT direction,SUM(amount_minor) AS figure FROM fin_transactions WHERE currency='EUR' AND posted_on='2025-12-03' GROUP BY direction";
  for (const currency of ['EUR', 'USD']) {
    f.run("UPDATE fin_accounts SET currency=? WHERE account_slug='checking'", currency);
    const query = await queryMoney(f.env, { sql }, options);
    assert.deepEqual(Object.fromEntries(query.rows.map(row => [row.direction, row.figure])), { inflow: 1207, outflow: 4309 });
    assert.match(query.confidence_text, datedGap, currency + ' account');
  }
});

test('posting predicates preserve explicit account and date bounds for bank freshness', async t => {
  const f = overviewFixture(t);
  seedAccount(f, 'checking', 'plaid');
  seedAccount(f, 'other', 'simplefin');
  f.run("UPDATE bank_feed_items SET last_synced_at='2025-12-02T22:00:00Z'");
  for (const date of ['2025-12-01', day]) {
    f.row('checking-' + date, 'checking', date, 4309, 'outflow', { currency: 'EUR' });
    f.row('other-' + date, 'other', date, 9876, 'outflow', { currency: 'EUR' });
  }
  f.run("UPDATE fin_transactions SET source_provider='plaid'");
  for (const date of [day, '2025-12-01']) {
    const query = await queryMoney(f.env, {
      sql: `SELECT SUM(amount_minor) AS figure FROM fin_transactions WHERE account_slug='checking'
        AND posted_on='${date}' AND currency='EUR' AND direction='outflow' AND amount_minor>2000
        AND source_provider='plaid'`,
    }, options);
    assert.equal(query.rows[0].figure, 4309);
    assert.equal(query.confidence.period_end, date);
    assert.equal(datedGap.test(query.confidence_text), date === day);
    assert.doesNotMatch(query.confidence_text, /No bank data after .*ending 5678/);
  }
  const sql = `SELECT SUM(amount_minor) AS figure FROM txn WHERE account_slug='checking'
    AND posted_on='${day}' AND currency='EUR' AND direction='outflow'`;
  for (const dates of [{ from: day, through: day }, { period_from: day, period_to: day }]) {
    const clean = await queryMoney(f.env, { sql, ...dates }, options);
    assert.equal(clean.rows[0].figure, 4309);
    assert.match(clean.confidence_text, datedGap);
    assert.doesNotMatch(clean.confidence_text, /No bank data after .*ending 5678/);
  }
});

test('an unmapped discovery remains visible after its Item acquires a conflicting provider', async t => {
  const f = overviewFixture(t);
  f.account('checking', 'live');
  f.connection('checking');
  f.account('other', 'live');
  f.connection('other', 'simplefin');
  f.row('posted', 'checking', day, 1234);
  const unmapped = 'acct_' + 'a'.repeat(32);
  f.run(`INSERT INTO plaid_account_entity_assignments
    (item_ref,provider_account_id,account_ref,discovered_at,last_seen_at,updated_at)
    VALUES ('checking','unmapped',?,?,?,?)`, unmapped, day, day, day);
  async function read() {
    const query = await queryMoney(f.env, queryArgs, options);
    const overview = await overviewMoney(f.env, options);
    assert.equal(query.rows[0].figure, 1234);
    assert.equal(overview.status, 'complete');
    return [query.confidence_text, overview.confidence_text];
  }
  for (const warning of await read()) {
    assert.match(warning, discovery);
    assert.doesNotMatch(warning, providerConflict);
  }
  assert.equal(f.run("UPDATE plaid_account_entity_assignments SET item_ref='other' WHERE account_ref=?", unmapped).changes, 1);
  for (const warning of await read()) {
    assert.match(warning, discovery);
    assert.match(warning, providerConflict);
  }
  f.run('DELETE FROM fin_transactions');
  f.run('DELETE FROM fin_accounts');
  f.run("DELETE FROM plaid_account_entity_assignments WHERE account_ref<>?", unmapped);
  f.run('DELETE FROM simplefin_account_assignments');
  const emptyInventory = await overviewMoney(f.env, options);
  assert.equal(emptyInventory.status, 'complete');
  assert.deepEqual(emptyInventory.accounts, []);
  const emptyQuery = await queryMoney(f.env, queryArgs, options);
  assert.equal(emptyQuery.rows.length, 1);
  for (const warning of [emptyQuery.confidence_text, emptyInventory.confidence_text]) {
    assert.match(warning, discovery);
    assert.match(warning, providerConflict);
  }
});

test('a scoped raw query retains the dated Item gap and discloses the missing assignment', async t => {
  const f = overviewFixture(t);
  f.account('checking', 'live');
  f.connection('checking');
  f.run("UPDATE bank_feed_items SET last_synced_at='2025-12-02T22:00:00Z'");
  f.row('deposit', 'checking', day, 1234);
  f.row('payment', 'checking', day, 4321, 'outflow');
  f.row('outside', 'checking', '2025-12-04', 9876);
  async function read() {
    const query = await queryMoney(f.env, rawArgs, options);
    assert.deepEqual(Object.fromEntries(query.rows.map(row => [row.direction, row.figure])), { inflow: 1234, outflow: 4321 });
    return query.confidence_text;
  }
  const assigned = await read();
  assert.match(assigned, datedGap);
  assert.doesNotMatch(assigned, unknownFreshness);
  assert.equal(f.run("DELETE FROM plaid_account_entity_assignments WHERE item_ref='checking'").changes, 1);
  const unresolved = await read();
  assert.match(unresolved, datedGap);
  assert.match(unresolved, unknownFreshness);
  const clean = await queryMoney(f.env, { ...queryArgs, account_slugs: ['checking'] }, options);
  assert.match(clean.confidence_text, datedGap);
  assert.match(clean.confidence_text, unknownFreshness);
  assert.match(clean.confidence_text, /Account ending 1234 is not connected/);
  assert.match(clean.confidence_text, /Account ending 1234 has no verified successful sync time/);
  f.account('unrelated', 'live');
  f.run("UPDATE fin_accounts SET source_feed='bank-feed:unrelated',mask='5678' WHERE account_slug='unrelated'");
  assert.doesNotMatch(await read(), /ending 5678/);
  f.run("UPDATE fin_accounts SET source_feed='bank-feed:unresolved' WHERE account_slug='checking'");
  const noItem = await read();
  assert.match(noItem, unknownFreshness);
  assert.doesNotMatch(noItem, datedGap);
  assert.equal(f.run('DELETE FROM bank_feed_items').changes, 1);
  assert.match(await read(), unknownFreshness, 'an empty health inventory cannot hide unresolved freshness');
});

const assignmentTable = {
  plaid: 'plaid_account_entity_assignments',
  simplefin: 'simplefin_account_assignments',
};
const checkingObservation = '2025-12-02T21:45:00Z';
const otherObservation = '2025-12-02T20:45:00Z';

function seedAccount(f, slug, provider, reference = 'public') {
  f.account(slug, 'live');
  f.connection(slug, provider);
  const table = assignmentTable[provider];
  const { account_ref: ref } = f.db.prepare(`SELECT account_ref FROM ${table} WHERE item_ref=?`).get(slug);
  f.run(`UPDATE ${table} SET provider_account_id=?,last_seen_at=? WHERE item_ref=?`,
    slug, slug === 'checking' ? checkingObservation : otherObservation, slug);
  f.run('UPDATE fin_accounts SET external_ref=?,mask=? WHERE account_slug=?',
    reference === 'raw' ? slug : ref, slug === 'checking' ? '1234' : '5678', slug);
  return ref;
}

test('generated posting filters retain released bank warnings', async t => {
  const baseline = JSON.parse(readFileSync(new URL('./fixtures/money-posting-freshness-0434.json', import.meta.url), 'utf8'));
  const seed = 742931;
  assert.equal(baseline.rows.length, 64);
  for (let index = 0; index < 64; index++) {
    const flags = (seed + index * 29) & 63;
    const currency = flags & 1 ? 'EUR' : 'USD';
    const direction = flags & 2 ? " AND direction='inflow'" : '';
    const amount = flags & 4 ? ' AND amount_minor>2000' : '';
    const account = flags & 8 ? " AND account_slug='checking'" : '';
    const posted = flags & 16 ? day : '2025-12-01';
    const provider = flags & 32 ? 'plaid' : 'simplefin';
    const providerFilter = flags & 32 ? " AND source_provider='plaid'" : '';
    await t.test(`${index}: ${provider} ${currency} ${posted}${account}${direction}${amount}`, async sub => {
      const f = overviewFixture(sub);
      seedAccount(f, 'checking', provider);
      for (const date of ['2025-12-01', day]) {
        f.row('in-' + date, 'checking', date, 1207, 'inflow', { currency });
        f.row('out-' + date, 'checking', date, 4309, 'outflow', { currency });
      }
      f.row('other-currency', 'checking', posted, 8765, 'outflow', { currency: currency === 'EUR' ? 'USD' : 'EUR' });
      f.run('UPDATE fin_transactions SET source_provider=?', provider);
      if (providerFilter) {
        f.row('other-provider', 'checking', posted, 9988, 'outflow', { currency });
        f.run("UPDATE fin_transactions SET source_provider='simplefin' WHERE txn_uid='other-provider'");
      }
      const sql = `SELECT direction,SUM(amount_minor) AS figure FROM fin_transactions
        WHERE currency='${currency}' AND posted_on='${posted}'${account}${direction}${amount}${providerFilter}
        GROUP BY direction`;
      const expected = {
        ...(!amount ? { inflow: 1207 } : {}),
        ...(!direction ? { outflow: 4309 } : {}),
      };
      const clock = posted === day ? options : { now: () => Date.parse('2025-12-03T01:00:00Z') };
      async function read() {
        const before = f.calls.length;
        const query = await queryMoney(f.env, { sql, period_end: posted }, clock);
        assert.deepEqual(Object.fromEntries(query.rows.map(row => [row.direction, row.figure])), expected);
        assert.ok(f.calls.slice(before).some(statement => statement.includes('SUM(amount_minor) AS figure')));
        return query.confidence.reasons;
      }
      f.run('UPDATE fin_accounts SET currency=?', currency);
      f.run("UPDATE bank_feed_items SET last_synced_at='2025-12-02T22:00:00Z'");
      const matching = await read();
      assert.equal(matching.some(reason => datedGap.test(reason)), posted === day);
      f.run("UPDATE fin_accounts SET currency='USD'");
      for (const state of ['assigned', 'unassigned']) {
        if (state === 'unassigned') {
          assert.equal(f.run(`DELETE FROM ${assignmentTable[provider]} WHERE item_ref='checking'`).changes, 1);
        }
        const reasons = await read();
        // The account-specific warning carries the same gap as the release's
        // generic warning when this fixture has exactly one connected bank.
        const released = baseline.rows[index][state].map(number => baseline.warnings[number]
          .replace('No bank data after 2025-12-02 for a connected bank.', 'No bank data after 2025-12-02 for the account ending 1234.'));
        assert.deepEqual(released.filter(warning => !reasons.includes(warning)), [], 'dropped released warnings');
        assert.equal(reasons.some(reason => datedGap.test(reason)), posted === day, 'dated gap follows the requested period');
        assert.equal(reasons.some(reason => unknownFreshness.test(reason)), state === 'unassigned');
      }
    });
  }
});

function* disclosureCases() {
  for (const provider of Object.keys(assignmentTable)) {
    for (const mismatch of [false, true]) {
      yield { name: `discovery ${provider} mismatch=${mismatch}`, change(f, other) {
        const table = assignmentTable[provider];
        const item = provider === 'plaid' ? 'checking' : other;
        f.run(`UPDATE ${table} SET entity_slug=NULL,assigned_at=NULL WHERE item_ref=?`, item);
        f.run("UPDATE fin_accounts SET external_ref='unmapped' WHERE account_slug=?", item);
        if (mismatch) f.run(`UPDATE ${table} SET item_ref=? WHERE item_ref=?`, provider === 'plaid' ? other : 'checking', item);
      }};
    }
    for (const reference of ['public', 'raw']) {
      if (provider === 'simplefin' && reference === 'raw') continue;
      for (const state of ['connected', 'permission_revoked']) {
        yield { name: `collision ${provider} ${reference} ${state}`, reference, state, otherProvider: provider, change(f, other, ref) {
          f.run(`UPDATE ${assignmentTable.plaid} SET provider_account_id=? WHERE item_ref='checking'`, reference === 'raw' ? other : ref);
          f.run("UPDATE fin_accounts SET external_ref=? WHERE account_slug='checking'", reference === 'raw' ? other : ref);
          f.run('UPDATE bank_feed_items SET status=? WHERE item_ref=\'checking\'', state);
        }};
      }
    }
  }
  for (const state of ['assigned', 'missing assignment', 'missing Item']) {
    yield { name: state, raw: true, change(f) {
      if (state !== 'assigned') f.run("DELETE FROM plaid_account_entity_assignments WHERE item_ref='checking'");
      if (state === 'missing Item') f.run("UPDATE fin_accounts SET source_feed='bank-feed:unresolved' WHERE account_slug='checking'");
    }};
  }
  for (const [name, receipt] of [
    ['before', '2025-12-31T00:29:59.999Z'],
    ['exact', '2025-12-31T00:30:00Z'],
    ['future UTC', '2025-12-31T00:30:00.001Z'],
    ['future offset', '2025-12-30T16:30:00.001-08:00'],
    ['impossible November', '2025-11-31T23:30:00Z'],
    ['impossible leap day', '1900-02-29T23:30:00Z'],
    ['valid leap day', '2000-02-29T23:30:00Z'],
    ['missing receipt', null],
  ]) yield { name, receipt };
}

function warningRetained(warning, reasons, row, accounts) {
  if (reasons.includes(warning)) return true;
  if (row.name.startsWith('impossible ') && warning.startsWith('Account ending 1234 has a stale feed:')) {
    return reasons.some(reason => reason.startsWith('Account ending 1234 has no verified successful sync time'));
  }
  if (row.name === 'missing Item' && warning === 'No bank data after 2025-12-02 for a connected bank.') {
    return reasons.some(reason => unknownFreshness.test(reason));
  }
  if (!row.state) return false;
  const account = accounts.find(item => item.account_slug === 'checking');
  const other = accounts.find(item => item.account_slug !== 'checking');
  // The release mistook a foreign public reference for the account's
  // identity. Require affirmative same-Item evidence for resolved warnings.
  if (account?.last_observed_at !== checkingObservation || other?.last_observed_at !== otherObservation) return false;
  if (discovery.test(warning)) return accounts.length === 2;
  if (warning === 'Account ending 1234: pending not collected by this feed; posted totals exclude pending; amount unknown.') {
    return account.pending_collection === 'recorded';
  }
  return row.reference === 'raw' && row.state === 'connected' && account.connected &&
    account.last_sync === '2025-12-02T22:00:00Z' &&
    (/^Account ending 1234 (?:is not connected|has no verified successful sync time)/.test(warning) ||
      warning === 'An exact completed feed sync time is unavailable; assignment observations are not sync receipts.' ||
      warning === 'Account ending 1234: connection is not verified by the overview inventory.');
}

test('generated disclosures preserve the released warning evidence in both tools', async t => {
  // The fixture records the confidence reasons from these inputs on released 0.4.34.
  const baseline = JSON.parse(readFileSync(new URL('./fixtures/money-account-disclosures-0434.json', import.meta.url), 'utf8'));
  const cases = [...disclosureCases()];
  assert.deepEqual(Object.keys(baseline.rows), cases.map(row => row.name));
  const seed = 683271;
  for (const [index, row] of cases.entries()) {
    await t.test(row.name, async sub => {
      const f = overviewFixture(sub);
      const other = 'other-' + (seed + index);
      seedAccount(f, 'checking', 'plaid', row.reference);
      const ref = row.raw ? null : seedAccount(f, other, row.otherProvider || 'simplefin');
      const receiptCase = Object.hasOwn(row, 'receipt');
      const posted = receiptCase ? '2025-12-30' : day;
      f.coverage('checking', posted, posted);
      if (!row.raw) f.coverage(other, posted, posted);
      f.row('in', 'checking', posted, 1234);
      f.row('out', 'checking', posted, 4321, 'outflow');
      f.row('outside', 'checking', '2025-12-04', 9876);
      f.run("UPDATE bank_feed_items SET last_synced_at=? WHERE item_ref='checking'",
        receiptCase ? row.receipt : '2025-12-02T22:00:00Z');
      f.run('UPDATE bank_feed_items SET last_synced_at=? WHERE item_ref=?', '2025-12-02T21:00:00Z', other);
      row.change?.(f, other, ref);
      const args = receiptCase ? {
        sql: "SELECT SUM(amount_minor) AS figure FROM txn WHERE account_slug='checking' AND posted_on='2025-12-30'",
        from: posted, through: posted,
      } : queryArgs;
      const clock = receiptCase ? { now: () => Date.parse('2025-12-31T00:30:00Z') } : options;
      const query = await queryMoney(f.env, row.raw ? rawArgs : args, clock);
      const overview = await overviewMoney(f.env, clock);
      assert.equal(overview.status, 'complete');
      if (row.raw) assert.deepEqual(Object.fromEntries(query.rows.map(item => [item.direction, item.figure])), { inflow: 1234, outflow: 4321 });
      else assert.equal(query.rows[0].figure, 5555);
      const warnings = { query: query.confidence.reasons, overview: overview.confidence.reasons };
      for (const tool of ['query', 'overview']) {
        const missing = baseline.rows[row.name][tool].map(number => baseline.warnings[number])
          .filter(warning => !warningRetained(warning, warnings[tool], row, overview.accounts));
        assert.deepEqual(missing, [], tool + ' dropped released warnings');
      }
    });
  }
});
