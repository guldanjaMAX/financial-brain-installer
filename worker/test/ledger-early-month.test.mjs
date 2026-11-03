import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { replay } from '../../eval/fast-loop/money-replay.mjs';
import { cases, snapshotFor } from '../../eval/fast-loop/early-month-cases.mjs';
import { reviewedDateCopy } from './fixtures/plain-copy-expectations.mjs';
import { reviewEarlyMonth } from '../../eval/fast-loop/early-month-key.mjs';
import { fixture } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';

const previousContract = (o, c) => {
  assert.equal(o.execution_status, 'complete');
  assert.equal(o.trace.parsed_intents.length, 1, 'real classifier reached');
  assert.ok(o.trace.dependencies.includes('inventory'), 'real inventory reached');
  assert.ok(o.trace.dependencies.includes('transactions'), 'real transaction reader reached');
  assert.ok(o.trace.rows_read.length > 0, 'nonempty posted evidence reached the reader');
  assert.equal(o.trace.product_writes, 0);
  assert.equal(o.trace.fallback_calls, 0);
  assert.equal(o.trace.model_calls, 0);
  const b = o.body, l = b.ledger;
  assert.equal(l.kind, 'expense_summary');
  assert.deepEqual([l.from, l.to], ['2026-10-01', c.period.to]);
  assert.equal(l.expense_total_minor, c.unknown ? null : c.current ? 1234 : 0);
  assert.equal(l.row_count, c.current ? 1 : 0);
  assert.equal(l.time_zone, c.clock.owner_time_zone);
  assert.ok(b.answer.startsWith(reviewedDateCopy(`Month to date (2026-10-01 through ${c.period.to}):`)));
  assert.match(b.answer, /\n\nPrevious complete calendar month \(September\):\n/);
  const previous = l.previous_month;
  assert.ok(previous, 'previous complete month was composed');
  assert.deepEqual([previous.from, previous.to], ['2026-09-01', '2026-09-30']);
  assert.equal(previous.kind, 'expense_summary');
  assert.equal(previous.time_zone, c.clock.owner_time_zone);
  if (c.unknown) {
    assert.equal(l.retained_outflow_minor, 0);
    assert.equal(l.classification_complete, false);
    assert.equal(l.coverage.complete, true);
    assert.equal(previous.reason, 'ledger_account_kind_review_required');
    assert.equal(previous.expense_total_minor, undefined);
    assert.equal(previous.complete, false);
    assert.equal(b.evidence_gate.complete, false);
    assert.match(b.answer, /Before I count this as spending, I need to know which accounts are cards or loans/);
    assert.match(b.answer, /Bank history: all 3 accounts include October 1 to 2\./);
    assert.equal(reviewEarlyMonth(o, c).missing_previous, 0);
    return;
  }
  assert.equal(previous.expense_total_minor, c.unknown ? 99134 : 59134);
  assert.equal(previous.excluded_own_transfer_minor, 5000);
  assert.equal(previous.own_account_payments.total_minor, c.unknown ? 0 : 40000);
  assert.equal(previous.coverage.covered_account_count, c.coverage === 'partial' ? 2 : 3);
  assert.equal(previous.coverage.omitted_account_count, c.coverage === 'partial' ? 1 : 0);
  assert.equal(previous.complete, !c.unknown && !c.coverage);
  assert.equal(b.evidence_gate.complete, !c.unknown && !c.coverage);
  assert.match(b.answer, /Bank history:.*September/);
  assert.match(b.answer.split('\n')[0], /Bank history:.*October/);
  assert.match(b.answer, /This reading covers completed transactions only; pending activity is not included\.\nWant me to show your account balances\?$/);
  assert.doesNotMatch(b.answer, /\$999\.99|\$7\.77|\$888\.88|\$555\.55|no pending/i);
  const refs = [...b.answer.matchAll(/\[(\d+)\]/g)].map(m => Number(m[1]));
  assert.ok(refs.length > 0, 'citation decisions reached');
  assert.ok(refs.every(n => b.citations.some(citation => citation.n === n)), 'all printed citations resolve');
  assert.deepEqual(b.citations.map(citation => citation.n), b.citations.map((_, i) => i + 1));
  assert.deepEqual(b.citations.map(citation => citation.ref), [
    ...(c.current ? ['ledger:transaction:11'] : []),
    ...(c.unknown ? ['ledger:transaction:4', 'ledger:transaction:3'] : ['ledger:transaction:4']),
    'ledger:transaction:1', 'ledger:transaction:2',
  ]);
};

let run;
test.before(() => { run = replay({ cases, snapshotFor }); });
for (const c of cases.filter(c => c.previous && !c.currentUnavailable && c.coverage !== 'unavailable')) {
  test(`${c.id} adds the previous calendar month through the reviewed expense path`, () => {
    const o = run.observations.find(o => o.id === c.id);
    previousContract(o, c);
    assert.equal(reviewEarlyMonth(o, c).missing_previous, 0);
  });
}

for (const c of cases.filter(c => !c.previous)) test(`${c.id} preserves the selected period`, () => {
  const o = run.observations.find(o => o.id === c.id);
  assert.equal(o.execution_status, 'complete');
  assert.ok(o.trace.dependencies.includes('transactions'), 'selected-period decision reached SQL');
  assert.ok(o.body.ledger, 'green selected-period answer');
  assert.equal(o.body.ledger.previous_month, undefined);
  assert.doesNotMatch(o.body.answer, /Previous complete calendar month/);
  const historical = /explicit-(?:last|named)-month|previous-explicit-control/.test(c.id);
  assert.deepEqual([o.body.ledger.from, o.body.ledger.to], historical
    ? ['2026-09-01', '2026-09-30'] : ['2026-10-01', c.period.to]);
  if (o.body.ledger.kind === 'expense_summary') assert.equal(o.body.ledger.total_minor, historical ? 59134 : c.current ? 1234 : 0);
});

test('current coverage refusal retains the fully covered previous month and both green controls', () => {
  const c = cases.find(c => c.id === 'early/current-unavailable');
  const o = run.observations.find(o => o.id === c.id);
  assert.equal(o.execution_status, 'complete');
  assert.equal(o.trace.parsed_intents[0].defaultedPeriod, true);
  assert.ok(o.trace.sql.some(s => s.kind === 'inventory' && s.row_count === 3), 'coverage decision reached all three accounts');
  assert.equal(o.body.ledger?.reason || o.body.code, 'period_outside_coverage');
  const explicit = run.observations.find(o => o.id === 'early/previous-explicit-control');
  assert.ok(explicit.trace.dependencies.includes('transactions'));
  assert.equal(explicit.body.ledger.total_minor, 59134, 'the same coverage answers the explicit previous month');
  const covered = cases.find(c => c.id === 'early/current-covered-control');
  previousContract(run.observations.find(o => o.id === covered.id), covered);
  assert.ok(o.body.ledger?.previous_month, 'a current-month coverage gap must not discard the fully covered previous month');
  assert.equal(reviewEarlyMonth(o, c).missing_previous, 0);
  assert.equal(o.body.ledger.reason, 'period_outside_coverage', 'current coverage refusal remains visible');
  assert.equal(o.body.ledger.total_minor, undefined);
  assert.equal(o.body.ledger.expense_total_minor, undefined);
  assert.equal(o.body.ledger.row_count, undefined, 'unread current rows are not an empty result');
  assert.equal(o.body.ledger.complete, false);
  assert.equal(o.body.ledger.previous_month.total_minor, 59134);
  assert.equal(o.body.ledger.previous_month.complete, true);
  assert.equal(o.body.evidence_gate.complete, false);
  assert.equal(o.body.evidence_gate.partial, true);
  assert.deepEqual(o.body.citations.map(c => c.n), [1, 2, 3]);
  assert.match(o.body.answer.split('\n')[0], /^Month to date .*Unavailable\..*I can help check the bank records for October 1, but some bank days are missing, so a complete answer is unconfirmed\./);
  assert.doesNotMatch(o.body.answer.split('\n')[0], /\$|Evidence:|Bank history:/);
  assert.match(o.body.answer, /Your account ending 3131 has records from July through September, last update unavailable/);
  assert.deepEqual(o.body.gaps.map(g => [g.reason, g.from, g.to]), [['period_outside_coverage', '2026-10-01', '2026-10-01']]);
  assert.equal(o.trace.fallback_calls, 0);
  assert.equal(o.trace.model_calls, 0);
  assert.equal(o.trace.product_writes, 0);
});

test('restoring the current-success prerequisite fails the coverage-gap contract', () => {
  const c = cases.find(c => c.id === 'early/current-unavailable');
  const green = run.observations.find(o => o.id === c.id);
  assert.equal(reviewEarlyMonth(green, c).missing_previous, 0);
  const source = readFileSync(new URL('../src/lib/ledger-answer.js', import.meta.url), 'utf8');
  const site = 'earlyDefaultDay && reason === "period_outside_coverage"';
  assert.equal(source.split(site).length - 1, 1, 'one coverage recovery decision');
  const broken = replay({ cases: [c], snapshotFor,
    sourceOverrides: { 'ledger-answer.js': source.replace(site, 'false && reason === "period_outside_coverage"') } }).observations[0];
  assert.equal(broken.execution_status, 'complete');
  assert.ok(broken.trace.sql.some(s => s.kind === 'inventory' && s.row_count === 3), 'mutant reaches current coverage admission');
  assert.equal(broken.body.code, 'period_outside_coverage');
  assert.equal(broken.body.ledger, undefined);
  assert.equal(reviewEarlyMonth(broken, c).missing_previous, 1, 'restored defect loses useful prior evidence');
  assert.throws(() => assert.equal(reviewEarlyMonth(broken, c).missing_previous, 0), { name: 'AssertionError' });
  const covered = cases.find(c => c.id === 'early/current-covered-control');
  previousContract(replay({ cases: [covered], snapshotFor,
    sourceOverrides: { 'ledger-answer.js': source.replace(site, 'false && reason === "period_outside_coverage"') } }).observations[0], covered);
});

for (const [label, change] of [
  ['explicit current month', c => ({ ...c, question: 'What are my expenses this month?' })],
  ['fourth day without current coverage', c => ({ ...c,
    clock: { ...c.clock, now_utc: '2026-10-04T07:30:00Z' }, period: { ...c.period, to: '2026-10-04' } })],
]) test(`${label} keeps its reached single-period coverage refusal`, () => {
  const c = change(cases.find(c => c.id === 'early/current-unavailable'));
  const o = replay({ cases: [c], snapshotFor }).observations[0];
  assert.equal(o.execution_status, 'complete');
  assert.ok(o.trace.sql.some(s => s.kind === 'inventory' && s.row_count === 3));
  assert.equal(o.body.code, 'period_outside_coverage');
  assert.equal(o.body.answer, null);
  assert.equal(o.body.ledger, undefined);
  assert.equal(o.trace.fallback_calls, 0);
  assert.equal(o.trace.product_writes, 0);
  assert.equal(run.observations.find(o => o.id === 'early/previous-explicit-control').body.ledger.total_minor, 59134);
});

test('both uncovered periods retain separate scoped gaps without invented totals', () => {
  const c = cases.find(c => c.id === 'early/current-unavailable');
  const o = replay({ cases: [c], snapshotFor: c => {
    const s = snapshotFor(c);
    s.accounts.forEach(a => { a.from = '2026-09-15'; });
    return s;
  } }).observations[0];
  assert.equal(o.execution_status, 'complete');
  assert.ok(o.trace.sql.some(s => s.kind === 'inventory' && s.row_count === 3));
  assert.equal(o.body.ledger.reason, 'period_outside_coverage');
  assert.equal(o.body.ledger.previous_month.reason, 'period_outside_coverage', 'previous period reached its own coverage decision');
  assert.equal(o.body.ledger.total_minor, undefined);
  assert.equal(o.body.ledger.previous_month.total_minor, undefined);
  assert.equal(o.body.evidence_gate.complete, false);
  assert.deepEqual(o.body.citations, []);
  assert.doesNotMatch(o.body.answer, /\$/);
  assert.deepEqual(o.body.gaps.map(g => [g.reason, g.from, g.to]), [
    ['period_outside_coverage', '2026-10-01', '2026-10-01'],
    ['period_outside_coverage', '2026-09-01', '2026-09-30'],
  ]);
  assert.equal(o.trace.fallback_calls, 0);
  assert.equal(o.trace.product_writes, 0);
  assert.equal(reviewEarlyMonth(run.observations.find(o => o.id === c.id), c).missing_previous, 0);
});

for (const [label, corrupt] of [
  ['invented current zero', b => { b.ledger.total_minor = 0; }],
  ['complete aggregate', b => { b.evidence_gate.complete = true; }],
  ['missing current gap', b => { b.gaps = []; }],
  ['previous citation offset', b => { b.citations[0].n = 2; }],
]) test(`independent coverage key rejects ${label}`, () => {
  const c = cases.find(c => c.id === 'early/current-unavailable');
  const green = run.observations.find(o => o.id === c.id);
  assert.equal(reviewEarlyMonth(green, c).missing_previous, 0);
  const broken = structuredClone(green);
  corrupt(broken.body);
  assert.notDeepEqual(broken.body, green.body, 'corruption reaches a real two-period answer');
  assert.throws(() => reviewEarlyMonth(broken, c), { name: 'AssertionError' });
});

test('unavailable previous coverage stays visible without a substitute zero', () => {
  const o = run.observations.find(o => o.id === 'early/previous-unavailable');
  assert.equal(o.execution_status, 'complete');
  assert.ok(o.trace.dependencies.includes('inventory'));
  assert.ok(o.trace.dependencies.includes('transactions'), 'current month was actually read');
  assert.equal(o.body.ledger.total_minor, 0);
  assert.equal(o.body.ledger.previous_month.reason, 'period_outside_coverage', 'previous coverage decision reached');
  assert.equal(o.body.ledger.previous_month.total_minor, undefined);
  assert.equal(o.body.evidence_gate.complete, false);
  assert.match(o.body.answer, /Previous complete calendar month \(September\):\nUnavailable/);
  assert.equal(o.body.gaps[0].reason, 'period_outside_coverage');
  assert.deepEqual([o.body.gaps[0].from, o.body.gaps[0].to], ['2026-09-01', '2026-09-30']);
  assert.equal(o.trace.fallback_calls, 0);
  const c = cases.find(c => c.id === 'early/first-empty');
  previousContract(run.observations.find(o => o.id === c.id), c);
});

test('restoring the prior single-period answer fails every added-period contract', () => {
  const source = readFileSync(new URL('../src/lib/ledger-answer.js', import.meta.url), 'utf8');
  const site = 'if (intent.defaultedPeriod &&';
  assert.equal(source.split(site).length - 1, 1, 'one restoring decision site');
  const selected = cases.filter(c => c.previous && !c.currentUnavailable && c.coverage !== 'unavailable');
  const broken = replay({ cases: selected, snapshotFor,
    sourceOverrides: { 'ledger-answer.js': source.replace(site, 'if (false &&') } });
  for (const c of selected) {
    previousContract(run.observations.find(o => o.id === c.id), c);
    const o = broken.observations.find(o => o.id === c.id);
    assert.equal(o.execution_status, 'complete');
    assert.ok(o.trace.dependencies.includes('transactions'), 'mutant reached the real expense decision');
    assert.ok(o.body.ledger, 'mutant retains the month-to-date green control');
    assert.equal(o.body.ledger.previous_month, undefined);
    assert.throws(() => previousContract(o, c), { name: 'AssertionError' }, c.id);
  }
});

test('bounded undated spend aliases share the default expense contract', () => {
  const base = cases.find(c => c.id === 'early/second-posted');
  for (const question of ['How much did I spend?', 'What is my spending?', 'How much have we spent?', 'Spend']) {
    const c = { ...base, question };
    previousContract(replay({ cases: [c], snapshotFor }).observations[0], c);
  }
  const gross = replay({ cases: [{ ...base, question: 'What went out?' }], snapshotFor }).observations[0];
  assert.equal(gross.execution_status, 'complete');
  assert.equal(gross.trace.parsed_intents.length, 1, 'undated gross decision reached');
  assert.equal(gross.trace.fallback_calls, 1);
  assert.equal(gross.body.ledger, undefined);
});

test('restoring a UTC calendar fails the local month-boundary contract', () => {
  const c = cases.find(c => c.id === 'early/local-boundary-empty');
  previousContract(run.observations.find(o => o.id === c.id), c);
  const source = readFileSync(new URL('../src/lib/ledger-question.js', import.meta.url), 'utf8');
  const site = 'const today = ownerTime?.day || ledgerDay(now);';
  assert.equal(source.split(site).length - 1, 1);
  const broken = replay({ cases: [c], snapshotFor,
    sourceOverrides: { 'ledger-question.js': source.replace(site, 'const today = ledgerDay(now);') } }).observations[0];
  assert.equal(broken.execution_status, 'complete');
  assert.ok(broken.trace.dependencies.includes('transactions'));
  assert.throws(() => previousContract(broken, c), { name: 'AssertionError' });
});

test('restoring an explicit-period default fails the selected-period control', () => {
  const c = cases.find(c => c.id === 'early/explicit-month');
  const green = run.observations.find(o => o.id === c.id);
  assert.equal(green.body.ledger.previous_month, undefined);
  const source = readFileSync(new URL('../src/lib/ledger-question.js', import.meta.url), 'utf8');
  const site = '...(defaultedWindow ? { defaultedPeriod: true } : {}),';
  assert.equal(source.split(site).length - 1, 1);
  const broken = replay({ cases: [c], snapshotFor,
    sourceOverrides: { 'ledger-question.js': source.replace(site, 'defaultedPeriod: true,') } }).observations[0];
  assert.equal(broken.execution_status, 'complete');
  assert.ok(broken.trace.dependencies.includes('transactions'));
  assert.ok(broken.body.ledger.previous_month, 'mutant reached the extra-period decision');
  assert.notDeepEqual(broken.body, green.body);
});

for (const [label, id, site, replacement] of [
  ['early-day trigger', 'early/second-posted', 'Number(intent.to.slice(8, 10)) <= 3', 'false'],
  ['third-day inclusion', 'early/third-posted', 'Number(intent.to.slice(8, 10)) <= 3', 'Number(intent.to.slice(8, 10)) <= 2'],
  ['empty-period trigger', 'early/middle-empty', 'answer.ledger.row_count === 0', 'false'],
  ['citation offset', 'early/second-posted', 'citationOffset: current.citations.length', 'citationOffset: 0'],
  ['aggregate evidence guard', 'early/previous-partial', ' || answer.ledger.previous_month?.complete === false', ''],
]) test(`restoring ${label} fails its nonempty green peer`, () => {
  const c = cases.find(c => c.id === id), source = readFileSync(new URL('../src/lib/ledger-answer.js', import.meta.url), 'utf8');
  assert.equal(source.split(site).length - 1, 1);
  const green = run.observations.find(o => o.id === id);
  previousContract(green, c);
  const broken = replay({ cases: [c], snapshotFor,
    sourceOverrides: { 'ledger-answer.js': source.replace(site, replacement) } }).observations[0];
  assert.equal(broken.execution_status, 'complete');
  assert.ok(broken.trace.dependencies.includes('transactions'));
  assert.throws(() => previousContract(broken, c), { name: 'AssertionError' });
});

for (const [label, corrupt] of [
  ['displayed cents', b => { b.answer = b.answer.replace('$591.34', '$591.35'); }],
  ['structured cents', b => { b.ledger.previous_month.total_minor++; }],
  ['repayment', b => { b.ledger.previous_month.own_account_payments.loan_minor++; }],
  ['extra claim', b => { b.answer += '\nAll account activity is complete.'; }],
  ['citation date', b => { b.citations[0].posted_on = '2026-10-01'; }],
  ['coverage scope', b => { b.answer = b.answer.replace('all 3 accounts', 'all 4 accounts'); }],
]) test(`independent development key rejects ${label} corruption`, () => {
  const c = cases.find(c => c.id === 'early/first-empty'), green = run.observations.find(o => o.id === c.id);
  assert.equal(reviewEarlyMonth(green, c).missing_previous, 0);
  const broken = structuredClone(green);
  corrupt(broken.body);
  assert.notDeepEqual(broken.body, green.body, 'corruption reached a real result');
  assert.throws(() => reviewEarlyMonth(broken, c), { name: 'AssertionError' });
});

function calendarFixture(t, { now, from, to, previousDay }) {
  const f = fixture(t); f.owner(); f.env.BRAIN_TIMEZONE = 'America/Phoenix';
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at)
    VALUES ('calendar','owner','checking','asset','3131','manual','owner_stated','confirmed',?)`, now);
  f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
    VALUES ('calendar','complete',?,?,?,'owner_stated','confirmed',?)`, from, to, now, now);
  f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,provenance,basis_state,recorded_at)
    VALUES ('calendar-row','calendar',?,7654,'outflow','Store Unit','Store Unit','owner_stated','confirmed',?)`, previousDay, now);
  f.askAtClock = async () => {
    const writes = f.first('SELECT total_changes() n').n;
    const body = await (await withLedgerAnswer({ env: f.env, question: 'What are my expenses?', now,
      grantScope: { all: true }, scopePrincipalKind: 'owner' }, () => assert.fail('document fallback forbidden'))).json();
    assert.equal(f.first('SELECT total_changes() n').n, writes);
    assert.ok(f.calls.some(sql => /JOIN fin_transactions/.test(sql)), 'calendar decision reached real transaction SQL');
    return body;
  };
  return f;
}

for (const arm of [
  { label: 'year turn', now: '2027-01-01T08:00:00Z', from: '2026-12-01', to: '2027-01-01', previousDay: '2026-12-31', end: '2026-12-31' },
  { label: 'leap month', now: '2024-03-01T08:00:00Z', from: '2024-02-01', to: '2024-03-01', previousDay: '2024-02-29', end: '2024-02-29' },
  { label: 'UTC month before local month', now: '2024-03-01T02:00:00Z', from: '2024-01-01', to: '2024-02-29', previousDay: '2024-01-31', end: '2024-01-31' },
]) test(`owner calendar handles ${arm.label}`, async t => {
  const f = calendarFixture(t, arm), body = await f.askAtClock();
  assert.equal(body.ledger.total_minor, 0);
  assert.equal(body.ledger.to, arm.to);
  assert.deepEqual([body.ledger.previous_month.from, body.ledger.previous_month.to], [arm.from, arm.end]);
  assert.equal(body.ledger.previous_month.total_minor, 7654);
  assert.match(body.answer, /\$76\.54/);
});

test('previous-month read failure preserves the current result and a scoped gap', async t => {
  const arm = { now: '2026-10-01T19:00:00Z', from: '2026-09-01', to: '2026-10-01', previousDay: '2026-09-30' };
  const f = calendarFixture(t, arm), batch = f.env.DB.batch;
  let batches = 0;
  f.env.DB.batch = async statements => {
    batches++;
    if (batches === 2) throw new Error('synthetic previous read failure');
    return batch(statements);
  };
  const body = await f.askAtClock();
  assert.equal(batches, 2, 'the second period reached its read decision');
  assert.equal(body.ledger.total_minor, 0);
  assert.equal(body.ledger.previous_month.reason, 'ledger_unavailable');
  assert.equal(body.ledger.previous_month.total_minor, undefined);
  assert.equal(body.gaps[0].from, '2026-09-01');
  assert.equal(body.evidence_gate.complete, false);
  const green = await calendarFixture(t, arm).askAtClock();
  assert.equal(green.ledger.previous_month.total_minor, 7654);
});


function uncertaintyCase({ unknown = true, explicit = false } = {}) {
  const c = { ...cases.find(c => c.id === 'early/second-posted'), unknown,
    question: explicit ? 'What were my expenses this month?' : 'What are my expenses?' };
  const snapshot = snapshotFor(c);
  snapshot.accounts.forEach(a => { a.from = '2026-10-01'; });
  snapshot.rows = snapshot.rows.filter(r => r.id === 11);
  return { ...c, snapshot };
}
function uncertaintyContract(o) {
  assert.equal(o.execution_status, 'complete');
  assert.ok(o.trace.rows_read.some(r => r.amount_minor === 1234), 'posted decision reached');
  assert.equal(o.body.ledger.classification_complete, false);
  assert.equal(o.body.ledger.expense_total_minor, null);
  assert.equal(o.body.ledger.retained_outflow_minor, 1234);
  assert.equal(o.body.ledger.previous_month.reason, 'period_outside_coverage');
  assert.equal(o.body.evidence_gate.complete, false);
  assert.match(o.body.answer, /Here is the money out I could check, with spending still unconfirmed\./);
  assert.match(o.body.answer, /The account types for your account ending 4242 have not been confirmed, so some payments may be between your own accounts\./);
}
test('early default with unreviewed inventory keeps both warnings when the previous month is unavailable', () => {
  const c = uncertaintyCase();
  uncertaintyContract(replay({ cases: [c] }).observations[0]);
  const explicit = replay({ cases: [uncertaintyCase({ explicit: true })] }).observations[0];
  assert.ok(explicit.trace.rows_read.length > 0);
  assert.equal(explicit.body.ledger.previous_month, undefined);
  assert.match(explicit.body.answer, /Here is the money out I could check, with spending still unconfirmed/);
  const typed = replay({ cases: [uncertaintyCase({ unknown: false })] }).observations[0];
  assert.ok(typed.trace.rows_read.length > 0);
  assert.equal(typed.body.ledger.expense_total_minor, 1234);
  assert.match(typed.body.answer, /Bank history: all/);
});
test('restoring the compact warning loss fails the same reached uncertainty contract', () => {
  const source = readFileSync(new URL('../src/lib/ledger-answer.js', import.meta.url), 'utf8');
  const site = "|Here is the money out";
  assert.equal(source.split(site).length - 1, 1);
  const c = uncertaintyCase();
  uncertaintyContract(replay({ cases: [c] }).observations[0]);
  const bad = replay({ cases: [c], sourceOverrides: { 'ledger-answer.js': source.replace(site, '') } }).observations[0];
  assert.equal(bad.execution_status, 'complete');
  assert.ok(bad.trace.rows_read.some(r => r.amount_minor === 1234), 'mutant reaches the posted decision');
  assert.equal(bad.body.ledger.retained_outflow_minor, 1234);
  assert.throws(() => uncertaintyContract(bad), { name: 'AssertionError' });
});
