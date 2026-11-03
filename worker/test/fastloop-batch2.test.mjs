import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { replay } from '../../eval/fast-loop/money-replay.mjs';
import { cases, snapshotFor, restoringMutants } from './fixtures/fastloop-batch2-cases.mjs';
import { contract } from './fixtures/fastloop-batch2-key.mjs';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { fixture } from './ledger-review-fixture.mjs';

let run;
test.before(() => { run = replay({ cases, snapshotFor }); });
for (const c of cases) test(`${c.id} proves amount, scope and limitation through real SQLite`, () => {
  contract(run.observations.find(o => o.id === c.id));
});

const one = (id, question, change = () => {}, sourceOverrides = {}) => {
  const base = cases.find(c => c.id === id);
  assert.ok(base, 'declared positive peer');
  const c = { ...base, question: question || base.question };
  const result = replay({ cases: [c], sourceOverrides, snapshotFor: input => {
    const snapshot = snapshotFor(input); change(snapshot); return snapshot;
  } }).observations[0];
  assert.equal(result.execution_status, 'complete');
  assert.equal(result.trace.parsed_intents.length, 1);
  assert.equal(result.trace.product_writes, 0);
  return result;
};

test('D5 admitted alias families share the dated balance contract', () => {
  for (const question of ['How much do I have right now?', 'How much money do I have in my bank?',
    'How much cash do I have now?', 'How much money is in my bank right now?', 'Show me my cash', 'What is my cash?']) {
    contract(one('D5/bank', question));
  }
});
test('D6 admitted period and exact-vendor forms share the same bounded arithmetic', () => {
  for (const question of ['How much did I spend at Store One in the past 3 months?',
    'How much did I pay to Store One in the last 3 months?', 'Show spending at Store One in the last 3 months?']) {
    contract(one('D6/months', question));
  }
});
test('D8 admitted monthly wording retains detector evidence and limitations', () => {
  contract(one('D8/monthly', 'What am I paying for every month?'));
});

for (const [id, question] of [
  ['D5/bank', 'How much do I have in the bank next month?'],
  ['D5/have', 'How much do I have in the named bank?'],
  ['D5/cash', 'How much cash do I have after tax?'],
  ['D6/months', 'How much did I spend at Store One in the last 0 months?'],
  ['D6/months', 'How much did I spend at Store One in the last 121 months?'],
  ['D6/months', 'How much did I spend at Store One in the last 3 months and September?'],
  ['D6/months', 'How much did I spend in the past 2 months?'],
  ['D6/days', 'How much did I spend at Store One in the past 0 days?'],
  ['D6/days', 'How much did I spend at Store One in the past 3661 days?'],
  ['D7/amount', 'Did a payment of $177.77 come in around October 12 and October 20, 2026?'],
  ['D7/amount', 'Did a payment of $177.77 come in around February 30, 2026?'],
  ['D7/amount', 'Did a payment of around $177.77 arrive on October 12, 2026?'],
  ['D7/payer', 'Did the payment from Payer Unit come in around last month?'],
  ['D8/monthly', 'What do I pay for every month excluding tax?'],
  ['D10/forecast', 'What will my bank balance be next month after tax?'],
]) test(`bounded refusal: ${question}`, () => {
  contract(run.observations.find(o => o.id === id));
  const o = one(id, question);
  assert.equal(o.body.ledger, undefined);
  assert.equal(o.trace.fallback_calls, 1, 'refusal decision reached');
  assert.equal(o.trace.dependencies.includes('transactions'), false);
});

for (const id of ['D6/months', 'D7/amount', 'D8/monthly', 'D9/combined']) test(`${id} incomplete coverage refuses with a reached green peer`, () => {
  contract(run.observations.find(o => o.id === id));
  const o = one(id, null, s => { s.accounts.forEach(a => { a.coverage = 'partial'; }); });
  assert.equal(o.body.ledger, undefined);
  assert.equal(o.body.gaps[0].reason, 'period_outside_coverage');
  assert.ok(o.trace.sql.some(s => s.kind === 'inventory' && s.row_count === 3));
  assert.equal(o.trace.dependencies.includes('transactions'), false);
});

test('D5 unknown types and inconsistent roles never become cash', () => {
  contract(run.observations.find(o => o.id === 'D5/bank'));
  const o = one('D5/bank', null, s => {
    s.accounts[1].role = 'neither'; s.accounts[2].kind = 'other';
  });
  assert.ok(o.trace.dependencies.includes('balances'));
  assert.deepEqual(o.body.ledger.accounts.map(a => a.balance_group), ['cash', 'other', 'other']);
  assert.match(o.body.answer, /Other or unknown account types \(excluded from cash\)/);
  assert.equal(o.body.ledger.accounts[2].current_minor, 880000);
});

test('D6 rolling month clamp, exact boundaries and day arithmetic exclude outside rows', () => {
  const q = 'How much did I spend at Store One in the last 1 months?';
  const o = one('D6/months', q, s => {
    s.rows.push(...[['2026-09-29', 3100], ['2026-09-30', 701], ['2026-10-31', 1103], ['2026-11-01', 9000]]
      .map(([date, cents], i) => ({ ...s.rows[0], id: 40 + i, uid: `boundary-${i}`, date, cents: String(cents) })));
  });
  assert.equal(o.body.ledger.from, '2026-09-30');
  assert.equal(o.body.ledger.total_minor, 7804);
  assert.deepEqual(o.body.citations.map(c => c.ref), [42, 1, 41].map(id => `ledger:transaction:${id}`));
  assert.ok(o.trace.rows_read.some(r => r.id === 40), 'padding row reached but not counted');
  const leap = classifyLedgerQuestion(q, { now: '2024-03-31T19:00:00Z', timeZone: 'America/Phoenix' });
  assert.equal(leap.from, '2024-02-29');
  assert.equal(leap.to, '2024-03-31');
  for (const [id, dates, total] of [
    ['D6/months', ['2026-07-30', '2026-07-31'], 6701],
    ['D6/days', ['2026-08-02', '2026-08-03'], 6701],
  ]) {
    const bounded = one(id, null, s => { s.rows.push(...dates.map((date, i) => ({
      ...s.rows[0], id: 50 + i, uid: `rolling-${i}`, date, cents: i ? '701' : '99001',
    }))); });
    assert.ok(bounded.trace.rows_read.some(r => r.id === 50), 'outside boundary reaches the padded read');
    assert.equal(bounded.body.ledger.total_minor, total);
    assert.ok(bounded.body.citations.some(c => c.ref === 'ledger:transaction:51'));
    assert.ok(bounded.body.citations.every(c => c.ref !== 'ledger:transaction:50'));
  }
  contract(run.observations.find(o => o.id === 'D6/days'));
});

test('D6 exact-vendor absence, possible matches and partial coverage stay scoped', () => {
  contract(run.observations.find(o => o.id === 'D6/months'));
  const absent = one('D6/months', 'How much did I spend at Absent Store in the last 3 months?');
  assert.ok(absent.trace.rows_read.length > 0);
  assert.equal(absent.body.ledger.match_basis, 'none');
  assert.equal(absent.body.ledger.total_minor, null);
  assert.match(absent.body.answer, /^I checked July 31 to October 31, but no payee exactly matched "Absent Store", so no store total is confirmed\. Closest payee names: Store Three; Store Five; Store Four\.$/m);
  assert.doesNotMatch(absent.body.answer, /never used|\$0\.00/i);
  const possible = one('D6/months', null, s => { s.rows[0].payee = null; s.rows[0].description = 'Card purchase at Store One'; });
  assert.ok(possible.trace.rows_read.some(r => r.id === 1));
  assert.equal(possible.body.ledger.match_basis, 'possible');
  assert.equal(Object.hasOwn(possible.body.ledger, 'total_minor'), false);
  assert.equal(possible.body.ledger.possible_match_count, 1);
  assert.deepEqual(possible.body.citations, []);
  assert.doesNotMatch(possible.body.answer, /\$/);
  const partial = one('D6/months', null, s => { s.accounts[1].coverage = 'partial'; });
  assert.equal(partial.body.ledger.partial_subtotal_minor, 6000);
  assert.equal(partial.body.ledger.total_minor, null);
  assert.match(partial.body.answer, /^Here is a partial subtotal for "Store One": the charges I can use total /m);
  assert.deepEqual([partial.body.ledger.coverage.covered_account_count, partial.body.ledger.coverage.omitted_account_count], [2, 1]);
  assert.equal(partial.body.evidence_gate.complete, false);
});

test('D7 near-date checks both inclusive boundaries, amount, explicit payer and ambiguity', () => {
  contract(run.observations.find(o => o.id === 'D7/payer'));
  const q = 'Did a payment of $177.77 from Payer Unit come in around October 12, 2026?';
  for (const [date, payee, cents, found] of [
    ['2026-10-05', 'Payer Unit', '17777', true], ['2026-10-19', 'Payer Unit', '17777', true],
    ['2026-10-04', 'Payer Unit', '17777', false], ['2026-10-20', 'Payer Unit', '17777', false],
    ['2026-10-12', 'Other Payer', '17777', null], ['2026-10-12', 'Payer Unit', '17778', null],
  ]) {
    const o = one('D7/payer', q, s => { s.rows = [{ ...s.rows[8], date, payee, cents }]; });
    assert.ok(o.trace.dependencies.includes('transactions'));
    assert.equal(o.body.ledger.found, found, `${date}/${payee}/${cents}`);
    assert.match(o.body.answer, /October 5 to 19/);
    if (found !== true) assert.doesNotMatch(o.body.answer, /Found a deposit/);
  }
  contract(run.observations.find(o => o.id === 'D7/ambiguous'));
});

for (const [label, change] of [
  ['two occurrences', s => { s.rows.pop(); }],
  ['stale', s => { s.rows.forEach((r, i) => { r.date = ['2026-07-01', '2026-08-01', '2026-09-01'][i]; }); }],
  ['bad cadence', s => { s.rows[1].date = '2026-09-25'; }],
  ['amount drift', s => { s.rows[2].cents = '1500'; }],
]) test(`D8 detector retains ${label} refusal`, () => {
  contract(run.observations.find(o => o.id === 'D8/monthly'));
  const o = one('D8/monthly', null, change);
  assert.ok(o.trace.rows_read.length >= 2, 'detector received relevant posted charges');
  assert.equal(o.body.ledger.found, false);
  assert.equal(o.body.ledger.monthly_total_minor, 0);
  assert.deepEqual(o.body.ledger.recurring, []);
});

test('D9 unproved transfer stays in the scoped total and is flagged', () => {
  contract(run.observations.find(o => o.id === 'D9/combined'));
  const o = one('D9/combined', null, s => { s.rows[16].description = 'Transfer from investment account'; });
  assert.ok(o.trace.rows_read.some(r => r.id === 17));
  assert.equal(o.body.ledger.combined_inflow_minor, 74611);
  assert.equal(o.body.ledger.income_established, false);
  assert.equal(o.body.ledger.transfer_related_credit_citations.length, 1);
  assert.match(o.body.answer, /Transfer-related credits \(included; ownership not assumed\)/);
});

test('D9 repeated masks cannot mix account citation membership', () => {
  contract(run.observations.find(o => o.id === 'D9/combined'));
  const o = one('D9/combined', null, s => { s.accounts[1].mask = '3131'; });
  assert.ok(o.trace.rows_read.some(r => r.effective_account_slug === 'reserve'));
  assert.equal(o.body.ledger.combined_inflow_minor, 74611);
  const accountLines = o.body.answer.split('\n').filter(line => line.startsWith('your account ending 3131,'));
  assert.equal(accountLines.length, 2);
  const ids = line => [...line.matchAll(/\[(\d+)\]/g)].map(m =>
    o.body.citations.find(c => c.n === Number(m[1])).ref).sort();
  assert.deepEqual(ids(accountLines[0]), ['ledger:transaction:14', 'ledger:transaction:15']);
  assert.deepEqual(ids(accountLines[1]), ['ledger:transaction:16', 'ledger:transaction:17']);
});

for (const id of ['D5/bank', 'D6/months', 'D7/amount', 'D8/monthly', 'D9/combined', 'D10/forecast']) test(`${id} limited principal cannot acquire owner ledger scope`, () => {
  contract(run.observations.find(o => o.id === id));
  const c = { ...cases.find(c => c.id === id), principal: { kind: 'grant', all: true } };
  const o = replay({ cases: [c], snapshotFor }).observations[0];
  assert.equal(o.execution_status, 'complete');
  assert.equal(o.trace.parsed_intents.length, 1);
  assert.equal(o.body.ledger, undefined);
  assert.equal(o.body.gaps[0].reason, 'retrieval_scope_restricted');
  assert.equal(o.trace.fallback_calls, id === 'D10/forecast' ? 0 : 1);
  assert.equal(o.trace.sql.length, 0);
});

for (const [label, id, file, before, after] of restoringMutants) test(`${label} restoring mutant fails the same independent contract`, () => {
  const source = readFileSync(new URL(`../src/lib/${file}`, import.meta.url), 'utf8');
  assert.equal(source.split(before).length - 1, 1, 'exactly one restoring site');
  contract(run.observations.find(o => o.id === id));
  const o = one(id, null, () => {}, { [file]: source.replace(before, after) });
  assert.throws(() => contract(o), { name: 'AssertionError' });
  assert.ok(o.trace.parsed_intents.length && o.trace.fixture_accounts > 0, 'mutant decision reached');
});

for (const id of ['D5/bank', 'D6/months', 'D7/amount', 'D8/monthly', 'D9/combined', 'D10/forecast']) test(`${id} oracle rejects one displayed cent of corruption`, () => {
  const green = run.observations.find(o => o.id === id); contract(green);
  const broken = structuredClone(green);
  broken.body.answer = broken.body.answer.replace(/\$([\d,]+)\.(\d{2})/, (_, whole, fraction) =>
    `$${whole}.${String(Number(fraction) + 1).padStart(2, '0')}`);
  assert.notEqual(broken.body.answer, green.body.answer, 'display mutation decision reached');
  assert.throws(() => contract(broken), { name: 'AssertionError' });
});

test('D10 unavailable snapshot retains the forecast limitation without document fallback', async t => {
  contract(run.observations.find(o => o.id === 'D10/forecast'));
  const f = fixture(t); f.owner();
  let fallbacks = 0;
  const b = await (await withLedgerAnswer({ env: f.env, question: 'What will my bank balance be next month?',
    now: '2026-10-31T19:00:00Z', grantScope: { all: true }, scopePrincipalKind: 'owner' }, () => {
    fallbacks++; return Response.json({ answer: null });
  })).json();
  assert.ok(f.calls.some(sql => /FROM fin_accounts/.test(sql)), 'snapshot availability decision reached');
  assert.equal(fallbacks, 0);
  assert.equal(b.ledger, undefined);
  assert.equal(b.gaps[0].reason, 'no_accounts');
  assert.match(b.answer, /^I can help review your records, but future balances and payments are unknown\./);
  assert.doesNotMatch(b.answer, /\$/);
});

const payerQuestion = 'Did a payment of $177.77 from Payer Unit come in around October 12, 2026?';
function payerProbe(payees, sourceOverrides = {}) {
  return one('D7/payer', payerQuestion, s => {
    s.rows = payees.map((payee, i) => ({ ...s.rows[8], id: 90 + i, uid: `payer-${i}`, payee }));
  }, sourceOverrides);
}
function paymentIdentity(o, count) {
  assert.ok(o.trace.rows_read.length > 0, 'payer decision received posted rows');
  assert.equal(o.body.ledger.found, count ? true : null);
  assert.equal(o.body.evidence_gate.complete, Boolean(count));
  if (count) assert.equal(o.body.ledger.match_count, count);
  else assert.equal(o.body.ledger.attribution_incomplete, true);
}
for (const payee of ['Payer Unit East', 'Unit Payer']) test(`RB2-01 exact payer rejects ${payee}`, () => {
  paymentIdentity(payerProbe(['Payer Unit']), 1);
  paymentIdentity(payerProbe([payee]), 0);
  paymentIdentity(payerProbe(['Payer Unit', payee]), 1);
});

function balanceFixture(t, dates, timeZone = 'America/Phoenix') {
  const f = fixture(t); f.owner(); f.env.BRAIN_TIMEZONE = timeZone;
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at)
    VALUES ('cash','owner','checking','asset','3131','manual','owner_stated','confirmed','2026-10-01')`);
  for (const [i, date] of dates.entries()) f.raw(`INSERT INTO fin_balance_snapshots
    (account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at)
    VALUES ('cash',?,?,'owner_stated','confirmed','2026-10-31')`, date, 502345 + i);
  return f;
}
async function forecastProbe(f, answer = withLedgerAnswer, now = '2026-10-31T19:00:00Z') {
  let fallback = 0;
  const b = await (await answer({ env: f.env, question: 'What will my bank balance be next month?', now,
    grantScope: { all: true }, scopePrincipalKind: 'owner' }, () => { fallback++; return Response.json({ answer: null }); })).json();
  assert.equal(fallback, 0, 'forecast remains terminal');
  return b;
}
function unavailableSnapshot(b, f) {
  assert.ok(f.calls.some(sql => /fin_balance_snapshots/.test(sql)), 'balance SQL reached');
  assert.equal(b.ledger, undefined);
  assert.equal(b.evidence_gate.supported, false);
  assert.equal(b.gaps[0].reason, 'balance_unavailable');
  assert.doesNotMatch(b.answer, /\$/);
}
for (const date of ['2026-11-30', '2026-10-99', '2026-02-30', '2026-13-01']) test(`RB2-02 rejects ineligible observation ${date}`, async t => {
  const green = balanceFixture(t, ['2026-10-30']);
  assert.equal((await forecastProbe(green)).ledger.accounts[0].as_of, '2026-10-30');
  const f = balanceFixture(t, [date]);
  unavailableSnapshot(await forecastProbe(f), f);
});
test('RB2-02 selects eligible prior observation before ranking', async t => {
  const f = balanceFixture(t, ['2026-10-30', '2026-11-30', '2026-13-01']);
  const b = await forecastProbe(f);
  assert.ok(f.calls.some(sql => /fin_balance_snapshots/.test(sql)));
  assert.deepEqual([b.ledger.accounts[0].as_of, b.ledger.accounts[0].current_minor], ['2026-10-30', 502345]);
});
test('RB2-02 owner calendar rejects tomorrow and missing zone', async t => {
  const green = balanceFixture(t, ['2026-10-30']);
  assert.equal((await forecastProbe(green)).ledger.accounts[0].as_of, '2026-10-30');
  const f = balanceFixture(t, ['2026-11-01']);
  unavailableSnapshot(await forecastProbe(f, withLedgerAnswer, '2026-11-01T01:00:00Z'), f);
  for (const zone of [null, 'Invalid/Zone']) {
    const missing = balanceFixture(t, ['2026-10-30'], zone);
    const b = await forecastProbe(missing);
    assert.equal(b.gaps[0].reason, 'owner_timezone_unavailable');
    assert.equal(b.ledger, undefined);
    assert.equal(missing.calls.length, 0, 'owner-calendar decision precedes SQL');
    assert.doesNotMatch(b.answer, /\$/);
  }
});

function duplicateMaskProbe(typed, duplicate, sourceOverrides = {}) {
  return one('gross/control', 'What are my expenses?', s => {
    s.rows[6].description = `payment to ${typed ? 'loan ' : 'account '}4242`;
    if (duplicate) s.accounts[1].mask = '4242';
  }, sourceOverrides);
}
function uncertainRepayment(o) {
  assert.ok(o.trace.rows_read.some(r => r.id === 7), 'repayment decision reached');
  assert.equal(o.body.ledger.own_account_payments.total_minor, 0);
  assert.equal(o.body.ledger.expense_total_minor, 101000);
}
test('RB2-05 stated kind cannot resolve duplicate masks', () => {
  assert.equal(duplicateMaskProbe(true, false).body.ledger.own_account_payments.total_minor, 40000);
  uncertainRepayment(duplicateMaskProbe(false, true));
  uncertainRepayment(duplicateMaskProbe(true, true));
});
function unknownExpense(sourceOverrides = {}) {
  return one('gross/control', 'What are my expenses?', s => {
    s.accounts[2].kind = 'other'; s.accounts[2].role = 'neither';
    s.rows[6].description = 'unclassified outgoing payment';
  }, sourceOverrides);
}
function incompleteExpense(o) {
  assert.ok(o.trace.rows_read.some(r => r.id === 7), 'unknown-classification decision reached');
  assert.equal(o.body.ledger.complete, false);
  assert.equal(o.body.evidence_gate.complete, false);
  assert.equal(o.body.ledger.classification_uncertain, true);
  assert.match(o.body.answer, /account types.*have not been confirmed/i);
}
test('RB2-06 unknown account classification cannot certify complete expenses', () => {
  const green = duplicateMaskProbe(true, false);
  assert.equal(green.body.ledger.complete, true);
  assert.equal(green.body.ledger.expense_total_minor, 61000);
  incompleteExpense(unknownExpense());
});

const keyCorruptions = [
  ['sources', 'D5/bank', b => { for (const c of b.citations) {
    c.ref = 'ledger:balance:999'; c.amount_minor = 1; c.title = '$0.01';
  } }],
  ['prose date', 'D10/forecast', b => { b.answer = b.answer.replaceAll('October 30', 'November 30'); }],
  ['income certification', 'D9/combined', b => { b.ledger.income_established = true; }],
  ['forecast words', 'D10/forecast', b => { b.answer += '\nNext month you will have 9000 dollars.'; }],
  ['subscription certainty', 'D8/monthly', b => { b.answer += '\nEvery charge is a confirmed active subscription.'; }],
];
for (const [label, id, corrupt] of keyCorruptions) test(`RB2-03 key rejects ${label}`, () => {
  const green = run.observations.find(o => o.id === id); contract(green);
  const broken = structuredClone(green); corrupt(broken.body);
  assert.notDeepEqual(broken.body, green.body, 'corruption reached the real observation');
  assert.throws(() => contract(broken), { name: 'AssertionError' });
});

const restoreSource = (file, before, after, additional = []) => {
  let source = readFileSync(new URL(`../src/lib/${file}`, import.meta.url), 'utf8');
  for (const [from, to] of additional) {
    assert.equal(source.split(from).length - 1, 1, 'one overlapping restoring product site');
    source = source.replace(from, to);
  }
  assert.equal(source.split(before).length - 1, 1, 'one restoring site');
  return { [file]: source.replace(before, after) };
};
test('RB2-01 restoring payer token containment fails the same identity contract', () => {
  paymentIdentity(payerProbe(['Payer Unit']), 1);
  paymentIdentity(payerProbe(['Payer Unit East']), 0);
  const overrides = restoreSource('ledger-analysis.js', 'return sender === wanted.join(" ");',
    'return wanted.every(word => new Set(sender.split(" ")).has(word));');
  assert.throws(() => paymentIdentity(payerProbe(['Payer Unit East'], overrides), 0), { name: 'AssertionError' });
});
test('RB2-05 restoring kind-first filtering fails the same duplicate-mask contract', () => {
  assert.equal(duplicateMaskProbe(true, false).body.ledger.own_account_payments.total_minor, 40000);
  uncertainRepayment(duplicateMaskProbe(true, true));
  const overrides = restoreSource('ledger-analysis.js',
    '.filter(account => (account.members || []).some(member =>',
    '.filter(account => (!statedKind || statedKind === account.account_kind) && (account.members || []).some(member =>');
  assert.throws(() => uncertainRepayment(duplicateMaskProbe(true, true, overrides)), { name: 'AssertionError' });
});
test('RB2-06 restoring coverage-only completeness fails the same expense contract', () => {
  assert.equal(duplicateMaskProbe(true, false).body.ledger.complete, true);
  incompleteExpense(unknownExpense());
  const overrides = restoreSource('ledger-answer.js', 'const complete = coverageComplete && !classificationUncertain;',
    'const complete = coverageComplete;', [['if (!classificationComplete) {', 'if (false) {']]);
  assert.throws(() => incompleteExpense(unknownExpense(overrides)), { name: 'AssertionError' });
});
const moduleUrl = (code, base) => `data:text/javascript;base64,${Buffer.from(code.replace(/from (['"])(\.{1,2}\/[^'"]+)\1/g,
  (_, quote, path) => `from ${JSON.stringify(new URL(path, base).href)}`)).toString('base64')}`;
test('RB2-02 restoring unbounded observations fails the same unavailable-snapshot contract', async t => {
  const eligible = balanceFixture(t, ['2026-10-30']);
  assert.equal((await forecastProbe(eligible)).ledger.accounts[0].as_of, '2026-10-30');
  const green = balanceFixture(t, ['2026-11-30']); unavailableSnapshot(await forecastProbe(green), green);
  const before = "AND date(b.as_of_date,'+0 days')=b.as_of_date AND b.as_of_date<=?";
  const source = restoreSource('ledger-reader.js', before, 'AND (b.as_of_date<=? OR 1=1)')['ledger-reader.js'];
  const reader = moduleUrl(source, new URL('../src/lib/ledger-reader.js', import.meta.url));
  const answerUrl = new URL('../src/lib/ledger-answer.js', import.meta.url);
  const answerSource = readFileSync(answerUrl, 'utf8').replace('from "./ledger-reader.js"', `from "${reader}"`);
  const answer = (await import(moduleUrl(answerSource, answerUrl))).withLedgerAnswer;
  const f = balanceFixture(t, ['2026-11-30']);
  const b = await forecastProbe(f, answer);
  assert.throws(() => unavailableSnapshot(b, f), { name: 'AssertionError' });
});
test('RB2-03 restoring the prior key admits every rejected factual corruption', async () => {
  const url = new URL('./fixtures/fastloop-batch2-key.mjs', import.meta.url), source = readFileSync(url, 'utf8');
  assert.equal(source.split('reviewContract(o, wording);').length - 1, 1);
  const restored = (await import(moduleUrl(source.replace('reviewContract(o, wording);', ''), url))).contract;
  for (const [, id, corrupt] of keyCorruptions) {
    const green = run.observations.find(o => o.id === id); contract(green); restored(green);
    const broken = structuredClone(green); corrupt(broken.body);
    assert.notDeepEqual(broken.body, green.body);
    assert.throws(() => contract(broken), { name: 'AssertionError' });
    assert.doesNotThrow(() => restored(broken));
  }
});
