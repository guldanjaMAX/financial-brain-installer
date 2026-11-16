import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { run as expectedIncome } from '../src/lib/money-tools/expected_income.js';
import { TEST_COMMANDS, POST_LAUNCHER_TEST_COMMANDS } from '../../scripts/run-test-chain.mjs';

const SEED = 0x1111cafe;
const range = { from: '2026-10-01', to: '2026-10-31' };
const profiles = ['full', 'partial', 'guarded', 'empty', 'pending'];
function generate(index) {
  let state = (SEED + index) >>> 0;
  const random = n => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n; };
  const profile = profiles[Math.floor(index / 2) % profiles.length];
  return { index, path: index % 2 ? 'forecast' : 'actual', profile: index % 2 === 0 && profile === 'guarded' ? 'full' : profile,
    second: true, rows: Array.from({ length: 2 + random(5) }, (_, i) => ({ uid: `row-${i}`,
      account: i % 2 ? 'second' : 'fixture-account', date: `2026-10-${String(1 + random(12)).padStart(2, '0')}`,
      cents: 1 + random(99999), direction: i % 3 === 2 ? 'outflow' : 'inflow', pending: i % 2 })) };
}

function populate(f, c) {
  f.raw('DELETE FROM fin_transactions');
  f.raw('DELETE FROM fin_expectations');
  f.raw("DELETE FROM fin_account_coverage WHERE account_slug='second'");
  f.raw("DELETE FROM fin_accounts WHERE account_slug='second'");
  if (c.second) {
    f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,source_feed,basis_state,recorded_at,currency)
      VALUES ('second','owner','checking','asset','5678','Tester reserve','live','feed','bank-feed:fixture-feed','confirmed',?,?)`, NOW, c.profile === 'guarded' ? 'EUR' : 'USD');
    f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at)
      VALUES ('second','complete',?,'2026-10-31',?,'feed','bank-feed:fixture-feed','confirmed',?)`,
    c.profile === 'partial' ? '2026-10-10' : '2024-01-01', NOW, NOW);
  }
  for (const row of c.rows) if (row.account !== 'second' || c.second) {
    f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,pending,provenance,source_feed,basis_state,recorded_at,currency)
      VALUES (?,?,?,?,?,'Synthetic receipt','Payer Unit',?,'feed','bank-feed:fixture-feed','confirmed',?,?)`,
    row.uid, row.account, c.profile === 'empty' ? '2026-09-01' : row.date, row.cents, row.direction,
    c.profile === 'pending' ? row.pending : 0, NOW, row.account === 'second' && c.profile === 'guarded' ? 'EUR' : 'USD');
  }
  f.raw(`INSERT INTO fin_expectations (id,client,amount_minor,cadence,start_on,source_document_id,source_title,source_date,confirmed_by_owner)
    VALUES ('expectation','Client Unit',12001,'monthly','2026-10-01','synthetic-contract','Tester service contract','2026-09-01',1)`);
}

// Oracle uses only generated inputs, not reader, membership, coverage or money helpers.
function oracle(c) {
  const masks = ['1234', ...(c.second && c.profile !== 'guarded' && (c.path === 'forecast' || c.profile !== 'partial') ? ['5678'] : [])];
  const rows = c.rows.filter(r => masks.includes(r.account === 'second' ? '5678' : '1234') &&
    c.profile !== 'empty' && !(c.profile === 'pending' && r.pending));
  return { masks, rows, cash: rows.filter(r => r.direction === 'inflow').reduce((sum, r) => sum + BigInt(r.cents), 0n).toString(),
    missing: c.second && ['partial', 'guarded'].includes(c.profile) ? ['5678'] : [] };
}

async function execute(f, c) {
  populate(f, c);
  f.calls.length = 0;
  const before = f.first('SELECT total_changes() n').n;
  const batch = f.env.DB.batch, readAccounts = new Set();
  f.env.DB.batch = async statements => {
    const result = await batch(statements);
    for (const statement of statements) if (/JOIN fin_transactions/.test(statement.sql)) {
      for (const mapping of JSON.parse(statement.params[0])) readAccounts.add(mapping.effective === 'second' ? '5678' : '1234');
    }
    return result;
  };
  let body;
  try { body = c.path === 'forecast' ? await expectedIncome(f.env, range) : await f.ask('How much money came in during October 2026?'); }
  finally { f.env.DB.batch = batch; }
  assert.ok(f.calls.some(sql => /FROM fin_accounts a/.test(sql)), 'real D1 account inventory reached');
  if (c.path === 'forecast' || body.ledger) assert.ok(f.calls.some(sql => /JOIN fin_transactions/.test(sql)), 'real SQLite transaction path reached');
  assert.equal(f.first('SELECT total_changes() n').n, before, 'answer is read only');
  if (c.path === 'forecast') assert.deepEqual([...readAccounts].sort(), oracle(c).masks, 'forecast denominator equals accounts actually queried in SQLite');
  else for (const mask of oracle(c).masks) assert.ok(readAccounts.has(mask), 'every claimed account was queried; transfer counterpart reads may be wider');
  return body;
}

function assess(c, b) {
  const expected = oracle(c), issues = [];
  const issue = (type, want, actual) => issues.push({ type, expected: want, actual: actual ?? null });
  const text = c.path === 'forecast' ? b.say.join('\n') : b.answer || '';
  const line = text.split('\n').find(s => /^(?:Coverage|Accounts(?: covered| used)?):/i.test(s));
  if (!line) issue('missing_coverage_line', 'coverage line on a money answer', text);
  if (c.path === 'forecast') {
    if (!b.ok || !b.say.length) issue('refusal', 'useful partial answer', text);
    if (String(b.figures.already_in_minor) !== expected.cash) issue('wrong_figure', expected.cash, b.figures.already_in_minor);
    const likely = (BigInt(expected.cash) + 12001n).toString();
    if (String(b.figures.likely_total_minor) !== likely) issue('wrong_figure', likely, b.figures.likely_total_minor);
    const displayed = text.match(/\$([\d,]+)\.(\d{2})/);
    const displayCents = displayed ? (BigInt(displayed[1].replaceAll(',', '')) * 100n + BigInt(displayed[2])).toString() : null;
    if (displayCents !== likely) issue('wrong_figure', likely, displayCents);
    const accounts = b.coverage.accounts.map(a => a.account_mask).sort();
    if (JSON.stringify(accounts) !== JSON.stringify(expected.masks)) issue('unread_account_claimed', expected.masks, accounts);
    const count = line?.match(/Coverage: (\d+) connected accounts/);
    if (!count || Number(count[1]) !== expected.masks.length) issue('coverage_count', expected.masks.length, count ? Number(count[1]) : null);
    for (const mask of expected.masks) {
      const dates = expected.rows.filter(r => (r.account === 'second' ? '5678' : '1234') === mask).map(r => r.date).sort();
      const actual = b.coverage.accounts.find(a => a.account_mask === mask);
      const want = [dates[0] || null, dates.at(-1) || null, dates.length];
      if (JSON.stringify(want) !== JSON.stringify([actual?.first_on, actual?.last_on, actual?.rows]))
        issue('row_date_coverage', { mask, dates: want }, actual);
    }
    if (b.coverage.partial_through !== '2026-10-12') issue('sync_date', '2026-10-12', b.coverage.partial_through);
    if (line && !line.includes('through 2026-10-12')) issue('coverage_dates', 'through 2026-10-12', line);
    for (const missing of b.coverage.missing) if (!text.includes(missing)) issue('silent_missing_source', missing, text);
    if (!text.includes('Tester service contract dated 2026-09-01') || !/likely/i.test(text))
      issue('estimate_without_basis', 'likely with source title and date', text);
  } else {
    if (!b.ledger) issue('refusal', 'useful partial answer', text);
    else {
      const cash = b.ledger.covered_inflow_subtotal_minor ?? b.ledger.combined_inflow_minor;
      if (String(cash) !== expected.cash) issue('wrong_figure', expected.cash, cash);
      const displayed = text.match(/Combined recorded inflow: \$([\d,]+)\.(\d{2})/);
      const displayCents = displayed ? (BigInt(displayed[1].replaceAll(',', '')) * 100n + BigInt(displayed[2])).toString() : null;
      if (displayCents !== expected.cash) issue('wrong_figure', expected.cash, displayCents);
      if (b.ledger.from !== range.from || b.ledger.to !== '2026-10-12') issue('answer_dates', [range.from, '2026-10-12'], [b.ledger.from, b.ledger.to]);
      if (line) {
        const used = line.split(/;|\. /)[0];
        const masks = [...used.matchAll(/ending (\d{4})/g)].map(m => m[1]).sort();
        if (JSON.stringify(masks) !== JSON.stringify(expected.masks)) issue('coverage_accounts', expected.masks, masks);
        if (!/October 1 to 12/.test(line)) issue('coverage_dates', 'October 1 to 12', line);
      }
    }
  }
  for (const mask of expected.missing) if (!text.includes(mask)) issue('missing_source_not_named', mask, text);
  return issues;
}

// A fixed point of single-row/account removal is 1-minimal, not claimed globally minimal.
// Minimize every occurrence, preserving its class; other defects may remain visible.
async function minimize(f, input, type) {
  let c = structuredClone(input);
  const reproduces = async candidate => assess(candidate, await execute(f, candidate)).some(i => i.type === type);
  const keepsMoney = candidate => input.profile === 'empty' || oracle(candidate).rows.some(r => r.direction === 'inflow');
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < c.rows.length; i++) {
      const candidate = { ...c, rows: c.rows.filter((_, j) => i !== j) };
      if (keepsMoney(candidate) && await reproduces(candidate)) { c = candidate; changed = true; break; }
    }
    if (c.second) {
      const candidate = { ...c, second: false, rows: c.rows.filter(r => r.account !== 'second') };
      if (keepsMoney(candidate) && await reproduces(candidate)) { c = candidate; changed = true; }
    }
  }
  const unit = { ...c, rows: c.rows.map(r => ({ ...r, cents: 1 })) };
  if (await reproduces(unit)) c = unit;
  const firstDay = { ...c, rows: c.rows.map(r => ({ ...r, date: '2026-10-01' })) };
  if (await reproduces(firstDay)) c = firstDay;
  const failure = assess(c, await execute(f, c)).find(i => i.type === type);
  assert.ok(failure, 'minimized failure reproduces');
  return { input: c, ...failure };
}

test('320 generated ledgers: coverage equals the actual readable accounts and row dates', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  const f = ledgerFixture(t), groups = new Map();
  let wrong = 0, refusals = 0, occurrences = 0, affected = 0;
  for (let index = 0; index < 320; index++) {
    const c = generate(index), issues = assess(c, await execute(f, c));
    affected += Number(issues.length > 0);
    wrong += Number(issues.some(i => i.type === 'wrong_figure'));
    refusals += Number(issues.some(i => i.type === 'refusal'));
    for (const issue of issues) {
      occurrences++;
      const witness = await minimize(f, c, issue.type);
      // The structured denominator and spoken count share one cause, rather
      // than presenting the same skipped account as two independent bugs.
      const root = ['unread_account_claimed', 'coverage_count'].includes(issue.type) ? 'unread_account_denominator' : issue.type;
      const key = `${c.path}:${root}`;
      const group = groups.get(key) || { key, occurrences: 0, observations: {} };
      group.occurrences++;
      const observation = group.observations[issue.type] || { count: 0, witness };
      observation.count++; group.observations[issue.type] = observation; groups.set(key, group);
    }
  }
  console.log('COVERAGE_FINDER_RECEIPT ' + JSON.stringify({ seed: SEED, cases: 320, wrong_figures: wrong,
    refusals, passed_cases: 320 - affected, affected_cases: affected, classes: groups.size,
    minimized_occurrences: occurrences, failures: [...groups.values()] }));
  assert.equal(groups.size, 0, 'coverage defects (all classes and minimized inputs printed above)');
});

test('independent oracle kills eight answer mutations', () => {
  const c = { ...generate(1), second: false, rows: [{ uid: 'unit', account: 'fixture-account', date: '2026-10-05', cents: 17, direction: 'inflow', pending: 0 }] };
  const control = { ok: true, figures: { already_in_minor: 17, likely_total_minor: 12018 }, coverage: { accounts: [{ account_mask: '1234', first_on: '2026-10-05', last_on: '2026-10-05', rows: 1 }], missing: [], partial_through: '2026-10-12' },
    say: ['Likely $120.18 from Tester service contract dated 2026-09-01.', 'Coverage: 1 connected accounts, through 2026-10-12.'] };
  assert.deepEqual(assess(c, control), []);
  const mutants = [
    ['missing_coverage_line', b => b.say.pop()],
    ['coverage_count', b => b.say[1] = b.say[1].replace('1 connected', '2 connected')],
    ['unread_account_claimed', b => b.coverage.accounts[0].account_mask = '5678'],
    ['row_date_coverage', b => b.coverage.accounts[0].first_on = '2026-10-06'],
    ['sync_date', b => b.coverage.partial_through = '2026-10-31'],
    ['silent_missing_source', b => b.coverage.missing.push('Missing tester card 9012')],
    ['estimate_without_basis', b => b.say.shift()],
    ['wrong_figure', b => b.figures.already_in_minor++],
  ];
  for (const [type, mutate] of mutants) {
    const b = structuredClone(control); mutate(b);
    assert.ok(assess(c, b).some(i => i.type === type), `mutant killed: ${type}`);
    assert.throws(() => assert.deepEqual(assess(c, b), []), { name: 'AssertionError' }, `mutant turns the property assertion red: ${type}`);
  }
  assert.deepEqual(assess(c, control), [], 'unmodified control remains green');
});

test('coverage finder is registered in the offline test chain', () => {
  for (const chain of [TEST_COMMANDS, POST_LAUNCHER_TEST_COMMANDS])
    assert.ok(chain.includes('node --test worker/test/money-coverage-property-generated.test.mjs'));
});
