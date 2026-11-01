import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BASE_CASES, CONTROLS, PERIODS, validateInputs } from './fixtures/fastloop-money/input.mjs';
import { GOLD, goldFor } from './fixtures/fastloop-money/gold.mjs';
import { replay, ROOT, sha, waitForQuiet } from '../eval/fast-loop/money-replay.mjs';
import { scoreRun, scoreObservation, SCORING_IDENTITY } from '../eval/fast-loop/money-score.mjs';
import { compareRuns } from '../eval/fast-loop/money-compare.mjs';
import { total, formatMinor } from '../eval/fast-loop/money-oracle.mjs';

const inputs = [...BASE_CASES, ...CONTROLS];
let run, report;
const input = id => inputs.find(c => c.id === id);
const observation = id => run.observations.find(o => o.id === id);
const score = id => report.scores.find(s => s.id === id);
const seal = value => ({ ...value, scoring_identity: SCORING_IDENTITY, observation_digest: sha(value.observations) });
const changed = (id, mutation) => {
  const copy = structuredClone(run), target = copy.observations.find(o => o.id === id);
  const before = JSON.stringify(target); mutation(target);
  assert.notEqual(JSON.stringify(target), before, 'mutant must change the real observation');
  return seal(copy);
};
async function scorerMutant(from, to) {
  const scoreUrl = new URL('../eval/fast-loop/money-score.mjs', import.meta.url);
  const moduleUrl = (code, base) => `data:text/javascript;base64,${Buffer.from(code
    .replaceAll('import.meta.url', JSON.stringify(base.href))
    .replace(/from '(.+?)'/g, (_, path) => `from '${path.startsWith('.') ? new URL(path, base).href : path}'`)).toString('base64')}`;
  const source = readFileSync(scoreUrl, 'utf8');
  assert.equal(source.split(from).length - 1, 1, 'one restoring scorer site');
  const restoredUrl = moduleUrl(source.replace(from, to), scoreUrl);
  const compareUrl = new URL('../eval/fast-loop/money-compare.mjs', import.meta.url);
  const comparison = readFileSync(compareUrl, 'utf8').replace("from './money-score.mjs'", `from '${restoredUrl}'`);
  return { scorer: (await import(restoredUrl)).scoreRun,
    compare: (await import(moduleUrl(comparison, compareUrl))).compareRuns };
}
test.before(() => { run = seal(replay()); report = scoreRun(run, inputs); });

test('bank accounts for twelve base cases and every declared child with independent bound keys', () => {
  assert.deepEqual(BASE_CASES.map(c => c.id), ['M01', 'M04', 'M05', 'M06', 'M08', 'M09', 'M10', 'M11', 'M12', 'M16', 'M17', 'M20']);
  assert.equal(CONTROLS.length, 17);
  assert.deepEqual(Object.keys(GOLD).sort(), inputs.map(c => c.id).sort());
  assert.equal(validateInputs(inputs).length, 29);
  assert.throws(() => validateInputs([{ ...BASE_CASES[0], clock: null }]), /INVALID_CASE/);
  assert.equal(PERIODS.THREE.from, '2026-07-31');
  for (const c of inputs) assert.ok(goldFor(c.id).source && goldFor(c.id).rounding);
});
test('independent integer oracle keeps ordinary expense, gross movement and whole repayment distinct', () => {
  assert.equal(goldFor('M06/typed').total, '61000');
  assert.equal(goldFor('M05/gross').debits, '101000');
  assert.equal(goldFor('M06/typed').repayment, '40000');
  assert.equal(total(['9007199254740993', '1']), '9007199254740994');
  assert.equal(formatMinor('-10001'), '-$100.01');
  assert.throws(() => total(['1.1']), /INVALID_MINOR/);
  for (const file of ['money-oracle.mjs', '../../test/fixtures/fastloop-money/gold.mjs']) {
    const source = readFileSync(new URL(`../eval/fast-loop/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from .*worker|ledger-analysis|ledger-question|sumMinor/);
  }
});
test('all cases execute with real decisions, no provider calls and no replay writes', () => {
  assert.equal(report.planned, 29); assert.equal(report.attempted, 29); assert.equal(report.complete, 29);
  assert.equal(report.invalid, 0); assert.equal(report.adjudicated, 29);
  assert.equal(run.provider_calls, 0); assert.equal(run.production_writes, 0);
  assert.ok(Object.keys(run.source_files).some(f => f.endsWith('ledger-reader.js')));
  for (const o of run.observations) {
    assert.ok(o.trace.parsed_intents.length > 0); assert.equal(o.trace.product_writes, 0);
    assert.deepEqual(o.trace.host_guards, { transport_tripwire: true, scoped_read: true,
      external_read: false, subprocess: false, filesystem_write: false });
    if (o.trace.fallback_calls) {
      assert.equal(o.route, 'documents_unexecuted'); assert.equal(o.body.document_path_tested, false);
      assert.notEqual(score(o.id).verdict, 'correct');
    }
  }
});
for (const id of CONTROLS.slice(0, 12).map(c => c.id)) {
  test(`green peer ${id} reaches its independent decision`, () => {
    const o = observation(id);
    assert.ok(o.trace.dependencies.includes('inventory'));
    assert.equal(score(id).verdict, id === 'M20/incomplete' ? 'honest refusal' : 'correct');
    assert.ok(score(id).required_facts_met > 0);
  });
}
test('ranking uses ordinary eligibility before the limit on nonempty outgoing inputs', () => {
  const o = observation('M08');
  assert.ok(o.trace.rows_read.filter(r => r.direction === 'outflow').length >= 8);
  assert.equal(o.trace.parsed_intents[0].kind, 'largest');
  assert.deepEqual(o.body.ledger.lead_rows.map(r => Number(r.ref.split(':').at(-1))), [8, 1, 2, 3, 4]);
  assert.equal(score('M08').verdict, 'correct');
  assert.equal(o.body.ledger.own_account_payments.total_minor, 40000);
  assert.equal(observation('M06/typed').body.ledger.own_account_payments.loan_minor, 40000);
  assert.equal(score('M08/no-repayment').verdict, 'correct');
});
const requiredOutputContract = (candidate, id, scorer = scoreRun, compare = compareRuns) => {
  assert.ok(observation(id).trace.rows_read.length > 0, 'real ranking read reached');
  assert.equal(score(id).verdict, 'correct', 'intact green peer');
  const after = scorer(candidate, inputs).scores.find(s => s.id === id);
  assert.notEqual(after.verdict, 'correct');
  assert.ok(after.required_facts_met < after.required_facts_total, 'required output was lost');
  assert.equal(compare(run, candidate, inputs).regression_gate, false);
};
for (const [label, remove] of [
  ['repayment object', o => { delete o.body.ledger.own_account_payments; }],
  ['repayment display', o => { o.body.answer = o.body.answer.split('\n').filter(line =>
    !line.startsWith('Payments to your own loan/card accounts:') && !line.startsWith('Note: payments')).join('\n'); }],
  ['whole displayed answer', o => { o.body.answer = ''; }],
  ['ordinary ranking row', o => { o.body.answer = o.body.answer.replace(/^\$60\.00 on .+\n/m, ''); }],
  ['structured period', o => { delete o.body.ledger.from; delete o.body.ledger.to; }],
]) test(`RM2 required ranking output cannot lose its ${label}`, () => {
  requiredOutputContract(changed('M08', remove), 'M08');
});
test('RM2 required output loss also blocks comparison on an already-red ranking', () => {
  const prior = changed('M08', o => { o.body.ledger.rows[0].amount_minor++; });
  const candidate = structuredClone(prior);
  candidate.observations.find(o => o.id === 'M08').body.answer = '';
  assert.equal(scoreRun(prior, inputs).scores.find(s => s.id === 'M08').verdict, 'wrong figure');
  const comparison = compareRuns(prior, seal(candidate), inputs);
  assert.equal(comparison.regression_gate, false);
  assert.ok(comparison.failures.includes('LOST_FACT:M08:displayed-ranking'));
});
test('RM2 restoring output-only traversal makes the removal contract fail again', async () => {
  const candidate = changed('M08', o => { o.body.answer = ''; delete o.body.ledger.own_account_payments; });
  requiredOutputContract(candidate, 'M08');
  const { scorer, compare } = await scorerMutant("if (gold.contract === 'ranking') {\n    // Presence", "if (false) {\n    // Presence");
  assert.equal(scorer(candidate, inputs).scores.find(s => s.id === 'M08').verdict, 'correct');
  assert.equal(compare(run, candidate, inputs).regression_gate, true);
  assert.throws(() => requiredOutputContract(candidate, 'M08', scorer, compare), { name: 'AssertionError' });
});
const countContract = (candidate, id, scorer = scoreRun, compare = compareRuns) => {
  const trace = observation(id).trace;
  assert.ok(trace.rows_read.length > 0 || trace.sql.some(s => s.kind === 'balances' && s.row_count > 0),
    'nonempty transaction or balance read reached');
  assert.equal(score(id).verdict, 'correct', 'intact green peer');
  const after = scorer(candidate, inputs).scores.find(s => s.id === id);
  assert.notEqual(after.verdict, 'correct');
  assert.ok(after.safety_failures.length > 0, 'unsupported factual claim identified');
  assert.equal(compare(run, candidate, inputs).regression_gate, false);
};
for (const [label, id, corrupt] of [
  ['repayment display count', 'M08', o => { o.body.answer = o.body.answer.replace('across 1 payment.', 'across 999 payments.'); }],
  ['structured repayment count', 'M08', o => { o.body.ledger.own_account_payments.count = 999; }],
  ['both repayment counts', 'M08', o => { o.body.ledger.own_account_payments.count = 999;
    o.body.answer = o.body.answer.replace('across 1 payment.', 'across 999 payments.'); }],
  ['covered account display count', 'M06/typed', o => { o.body.answer = o.body.answer.replace('all 3 selected accounts', 'all 999 selected accounts'); }],
  ['structured covered account count', 'M06/typed', o => { o.body.ledger.coverage.covered_account_count = 999; }],
  ['structured candidate account count', 'M06/typed', o => { o.body.ledger.coverage.candidate_account_count = 999; }],
  ['structured omitted account count', 'M06/typed', o => { o.body.ledger.coverage.omitted_account_count = 999; }],
  ['evidence display count', 'M06/typed', o => { o.body.answer = o.body.answer.replace('Evidence: 5 of 7', 'Evidence: 999 of 7'); }],
  ['structured cited count', 'M06/typed', o => { o.body.ledger.cited_row_count = 999; }],
  ['structured omitted row count', 'M06/typed', o => { o.body.ledger.omitted_row_count = 999; }],
  ['merchant display count', 'M06/typed', o => { o.body.answer = o.body.answer.replace('across 1 row', 'across 999 rows'); }],
  ['structured merchant count', 'M06/typed', o => { o.body.ledger.groups[0].count = 999; }],
  ['structured category count', 'M06/typed', o => { o.body.ledger.category_groups[0].count = 999; }],
  ['structured group count', 'M06/typed', o => { o.body.ledger.group_count = 999; }],
  ['structured transaction count', 'M05/gross', o => { o.body.ledger.accounts[0].transaction_count = 999; }],
  ['structured transfer pair count', 'M08', o => { o.body.ledger.default_exclusions.own_transfer_pairs = 999; }],
  ['coverage display date', 'M06/typed', o => { o.body.answer = o.body.answer.replace('accounts cover 2026-10-01', 'accounts cover 2026-09-01'); }],
  ['structured coverage date', 'M06/typed', o => { o.body.ledger.accounts[0].covered_to = '2027-01-01'; }],
  ['coverage display scope', 'M08', o => { o.body.answer = o.body.answer.replace('Accounts: account ****3131', 'Accounts: account ****9999'); }],
  ['balance feed date', 'M01/supported', o => { o.body.answer = o.body.answer.replace('feed synced unavailable', 'feed synced 2026-10-31'); }],
  ['zero-amount displayed account scope', 'M05/gross', o => { o.body.answer = o.body.answer.replace('account ****5353, 2026', 'account ****9999, 2026'); }],
]) test(`RM3 independent membership rejects invented ${label}`, () => {
  countContract(changed(id, corrupt), id);
});
test('RM3 restoring syntax-only validation makes count contracts fail again', async () => {
  const { scorer, compare } = await scorerMutant('if (ledger) {\n    // Counts', 'if (false) {\n    // Counts');
  for (const [id, corrupt] of [
    ['M08', o => { o.body.ledger.own_account_payments.count = 999;
      o.body.answer = o.body.answer.replace('across 1 payment.', 'across 999 payments.'); }],
    ['M06/typed', o => { o.body.answer = o.body.answer.replace('all 3 selected accounts', 'all 999 selected accounts'); }],
  ]) {
    const candidate = changed(id, corrupt);
    countContract(candidate, id);
    assert.equal(scorer(candidate, inputs).scores.find(s => s.id === id).verdict, 'correct');
    assert.equal(compare(run, candidate, inputs).regression_gate, true);
    assert.throws(() => countContract(candidate, id, scorer, compare), { name: 'AssertionError' });
  }
});
test('RM4 uncertain expense output remains partial with the original gold obligations unmet', () => {
  for (const id of ['M06', 'M06/reset']) {
    const o = observation(id), actual = score(id);
    assert.ok(o.trace.rows_read.some(r => r.id === 7), 'uncertain payment read reached');
    assert.equal(o.body.ledger.complete, false);
    assert.equal(o.body.ledger.expense_total_minor, null);
    assert.equal(o.body.ledger.retained_outflow_minor, 101000);
    assert.equal(actual.verdict, 'partly');
    for (const fact of ['expense-total', 'whole-repayment', 'expense-row-count', 'expense-evidence-membership'])
      assert.equal(actual.checks.find(c => c.id === fact).ok, false, fact);
    assert.equal(goldFor(id).total, '61000');
    assert.equal(goldFor(id).repayment, '40000');
    assert.ok(actual.required_facts_met < actual.required_facts_total);
  }
  assert.equal(score('M06/typed').verdict, 'correct');
});
test('RM4 restoring expense certification fails the independent oracle and comparison', () => {
  const file = 'ledger-answer.js', source = readFileSync(new URL(`../worker/src/lib/${file}`, import.meta.url), 'utf8');
  const from = 'if (!classificationComplete) {';
  assert.equal(source.split(from).length - 1, 1, 'one restoring classification site');
  const restored = source.replace(from, 'if (false) {');
  const cases = [input('M06'), input('M06/reset')];
  const control = seal(replay({ cases }));
  const mutant = seal(replay({ cases, sourceOverrides: { [file]: restored } }));
  assert.equal(mutant.source_files[join('worker', 'src', 'lib', file)], sha(restored));
  assert.ok(mutant.observations.every(o => o.trace.rows_read.some(r => r.id === 7)));
  assert.ok(scoreRun(control, cases).scores.every(s => s.verdict === 'partly'));
  assert.ok(scoreRun(mutant, cases).scores.every(s => s.verdict === 'wrong figure'));
  assert.equal(compareRuns(control, mutant, cases).regression_gate, false);
});
test('RM4 partial output cannot hide invented retained amounts or counts', () => {
  for (const corrupt of [o => { o.body.ledger.retained_outflow_minor++; },
    o => { o.body.answer = o.body.answer.replace('$1,010.00', '$1,010.01'); },
    o => { o.body.ledger.cited_row_count = 999; }]) {
    const candidate = changed('M06', corrupt);
    assert.ok(observation('M06').trace.rows_read.length > 0);
    const after = scoreRun(candidate, inputs).scores.find(s => s.id === 'M06');
    assert.ok(after.safety_failures.length > 0);
    assert.equal(compareRuns(run, candidate, inputs).regression_gate, false);
  }
});
test('unknown classification and import reset stay held while typed memo and shorthand pass', () => {
  for (const id of ['M06', 'M06/reset']) {
    const o = observation(id);
    assert.ok(o.trace.rows_read.some(r => r.id === 7));
    assert.ok(o.trace.rows_read.some(r => r.id === 8));
    assert.equal(score(id).verdict, 'partly');
  }
  for (const id of ['M06/memo', 'M05/shorthand']) {
    const o = observation(id);
    assert.ok(o.trace.rows_read.some(r => r.id === 7));
    assert.equal(o.trace.parsed_intents[0].kind, 'expense_summary');
    assert.equal(o.route, 'ledger:expense_summary');
    assert.equal(o.body.ledger.expense_total_minor, 61000);
    assert.equal(score(id).verdict, 'correct');
  }
  assert.equal(observation('M06').body.ledger.expense_total_minor, null);
  assert.equal(observation('M06').body.ledger.retained_outflow_minor, 101000);
  const reset = observation('M06/reset').trace.import;
  assert.ok(reset.statements >= 2); assert.equal(reset.before.account_kind, 'loan');
  assert.equal(reset.after.account_kind, 'other'); assert.equal(reset.after.balance_role, 'neither');
  assert.equal(score('M06/typed').verdict, 'correct'); assert.equal(score('M05/gross').verdict, 'correct');
});
test('original probe passes the uncertain-headline repair and retains the provider storage failure', () => {
  const env = { PATH: '/usr/bin:/bin', HOME: resolve(ROOT, 'lane-evidence/home-fastloop'), BRAIN_NO_WRANGLER_LOGIN: '1' };
  for (const name of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) if (process.platform === 'win32' && process.env[name]) env[name] = process.env[name];
  waitForQuiet(env);
  const child = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/fastloop-money-red.mjs'],
    { cwd: ROOT, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 1); assert.match(child.stdout, /# pass 9\b/); assert.match(child.stdout, /# fail 1\b/);
  assert.match(child.stdout, /^ok \d+ - RED unclassified debt/m);
  assert.match(child.stdout, /not ok \d+ - RED provider replay/);
  assert.match(child.stdout, /# skipped 0\b/); assert.match(child.stdout, /# todo 0\b/);
});
test('equivalent explicit expense questions expose the parsed kind and actual selected route', () => {
  for (const id of ['M05', 'M05/supported', 'M05/shorthand', 'M06/typed']) {
    const o = observation(id);
    assert.equal(o.trace.parsed_intents[0].kind, 'expense_summary');
    assert.equal(o.route, 'ledger:expense_summary');
    assert.ok(o.trace.rows_read.length > 0);
    assert.equal(o.body.ledger.expense_total_minor, 61000);
  }
  assert.equal(observation('M05/gross').trace.parsed_intents[0].kind, 'totals');
  assert.equal(observation('M05/gross').route, 'ledger:totals');
  assert.equal(observation('M05/gross').body.ledger.accounts.reduce((sum, a) => sum + a.debits_minor, 0), 101000);
});
for (const [fix, id, file, from, to] of [
  ['F1', 'M06/memo', 'ledger-analysis.js', '(?:number |no )?', ''],
  ['F2', 'M08', 'ledger-answer.js', 'if (intent.kind === "largest" && intent.direction === "outflow") {', 'if (false) {'],
  ['F3', 'M05/shorthand', 'ledger-question.js', '|spend)(?: and on what)?$/;', ')(?: and on what)?$/;'],
  ['F4', 'M05', 'ledger-answer.js', 'if (answer.ledger.kind !== "balance") answer.answer +=', 'if (false) answer.answer +='],
]) test(`${fix} restoring product mutant fails the independent fast-loop oracle and comparison`, () => {
  const c = input(id), source = readFileSync(new URL(`../worker/src/lib/${file}`, import.meta.url), 'utf8');
  assert.equal(source.split(from).length - 1, 1, 'exactly one restoring site');
  const changedSource = source.replace(from, to);
  assert.notEqual(changedSource, source);
  const control = seal(replay({ cases: [c] }));
  const mutant = seal(replay({ cases: [c], sourceOverrides: { [file]: changedSource } }));
  assert.equal(mutant.source_files[join('worker', 'src', 'lib', file)], sha(changedSource), 'the restored module actually executed');
  assert.ok(mutant.observations[0].trace.rows_read.length > 0);
  assert.equal(mutant.observations[0].execution_status, 'complete');
  assert.equal(scoreRun(control, [c]).scores[0].verdict, 'correct');
  assert.notEqual(scoreRun(mutant, [c]).scores[0].verdict, 'correct');
  assert.equal(compareRuns(control, mutant, [c]).regression_gate, false);
});
test('baseline override rejects modules outside the reviewed product set', () => {
  assert.throws(() => replay({ cases: [input('M06/typed')], sourceOverrides: { '../outside.js': 'export {}' } }), /INVALID_SOURCE_OVERRIDE/);
  assert.equal(score('M06/typed').verdict, 'correct');
});
test('one-cent displayed error fails while the structured total remains right', () => {
  assert.equal(score('M06/typed').verdict, 'correct');
  const mutant = changed('M06/typed', o => { o.body.answer = o.body.answer.replace('$610.00', '$610.01'); });
  const verdict = scoreRun(mutant, inputs).scores.find(s => s.id === 'M06/typed');
  assert.equal(verdict.verdict, 'wrong figure'); assert.ok(verdict.figure_checks > 0);
  assert.equal(mutant.observations.find(o => o.id === 'M06/typed').body.ledger.total_minor, 61000);
  assert.equal(compareRuns(run, mutant, inputs).regression_gate, false);
});
test('new wrong values on an already-red case also fail comparison', () => {
  const mutant = changed('M06', o => { o.body.ledger.total_minor++; });
  const comparison = compareRuns(run, mutant, inputs);
  assert.equal(comparison.regression_gate, false);
  assert.ok(comparison.failures.some(f => f.startsWith('NEW_WRONG_FIGURE_CLAIM:M06:')));
});
test('dropping equal-size outside payment cannot pass the ownership oracle', () => {
  const mutant = changed('M06/typed', o => { o.body.ledger.total_minor = 21000; o.body.ledger.expense_total_minor = 21000; });
  const verdict = scoreRun(mutant, inputs).scores.find(s => s.id === 'M06/typed');
  assert.equal(verdict.verdict, 'wrong figure');
  assert.ok(observation('M06/typed').trace.rows_read.some(r => r.id === 8));
  assert.equal(score('M17/outside-only').verdict, 'correct');
});
test('same cents and date cannot swap the outside payment for an owned repayment', () => {
  const mutant = changed('M17', o => { o.body.citations[0].ref = 'ledger:transaction:7'; });
  const verdict = scoreRun(mutant, inputs).scores.find(s => s.id === 'M17');
  assert.equal(verdict.verdict, 'wrong figure'); assert.ok(verdict.source_checks > 0);
  assert.ok(verdict.safety_failures.includes('ownership:outside-payment-row'));
  assert.ok(observation('M17').trace.rows_read.some(r => r.id === 7));
  assert.equal(score('M17').verdict, 'correct');
});
test('pending rows and padded future rows have separate visible exclusion witnesses', () => {
  const o = observation('M06/typed');
  assert.ok(o.trace.sql.some(s => s.kind === 'transactions' && s.sql.includes('t.pending=0')));
  assert.ok(o.trace.exclusions.some(r => r.id === 12 && r.reason === 'pending SQL filter'));
  assert.ok(o.trace.rows_read.some(r => r.id === 13));
  assert.ok(o.trace.answer_window_exclusions.some(r => r.id === 13));
  assert.equal(o.body.ledger.total_minor, 61000);
});
test('missing source is distinct from a wrong amount and blocks comparison', () => {
  const mutant = changed('M17', o => { o.body.citations = []; });
  const verdict = scoreRun(mutant, inputs).scores.find(s => s.id === 'M17');
  assert.equal(verdict.verdict, 'missing source');
  assert.ok(verdict.checks.some(c => c.failure === 'missing_source'));
  assert.equal(score('M17').verdict, 'correct');
  assert.equal(compareRuns(run, mutant, inputs).regression_gate, false);
});
test('blanket refusal loses an answerable decision and earns no correct verdict', () => {
  const mutant = changed('M17', o => { o.body = { answer: null, citations: [], gaps: [] }; });
  const verdict = scoreRun(mutant, inputs).scores.find(s => s.id === 'M17');
  assert.equal(verdict.verdict, 'over-refusal');
  assert.equal(verdict.utility, 0);
  assert.ok(observation('M17').trace.rows_read.length > 0);
  assert.equal(compareRuns(run, mutant, inputs).regression_gate, false);
  assert.equal(score('M20/incomplete').verdict, 'honest refusal');
});
test('false nonnumeric claims block comparison even when every amount stays right', () => {
  const mutant = changed('M17', o => { o.body.answer += '\nThe loan is fully paid off.'; });
  const verdict = scoreRun(mutant, inputs).scores.find(s => s.id === 'M17');
  assert.ok(verdict.safety_failures.some(f => f.includes('unsupported_claim')));
  assert.ok(verdict.figure_checks > 0); assert.equal(compareRuns(run, mutant, inputs).regression_gate, false);
  const inline = changed('M17', o => { o.body.answer = o.body.answer.replace('\n', ' The debt is settled.\n'); });
  assert.equal(compareRuns(run, inline, inputs).regression_gate, false);
});
test('transport enforcement stops before a real socket can open', () => {
  assert.throws(() => replay({ cases: [input('M06/typed')], fault: 'transport' }), /REPLAY_CHILD_FAILED:86:.*TEST_SIDE_EFFECT_BLOCKED:fetch/);
  assert.equal(score('M06/typed').verdict, 'correct');
});
test('false complete zero is rejected after incomplete coverage was actually read', () => {
  const mutant = changed('M20/incomplete', o => { o.body = structuredClone(observation('M20/covered-empty').body); });
  const verdict = scoreRun(mutant, inputs).scores.find(s => s.id === 'M20/incomplete');
  assert.equal(verdict.verdict, 'wrong figure');
  assert.ok(observation('M20/incomplete').trace.sql.some(s => s.kind === 'inventory' && s.row_count > 0));
  assert.equal(score('M20/covered-empty').verdict, 'correct');
});
for (const fault of ['sql', 'bind', 'network', 'credential', 'subprocess', 'module', 'write']) {
  test(`strict ${fault} miss stays fatal outside product error handling`, () => {
    const broken = replay({ cases: [input('M06/typed')], fault });
    const o = broken.observations[0];
    assert.equal(o.execution_status, 'harness_error'); assert.ok(o.fatal.length > 0);
    assert.ok(o.trace.denied_effects.length > 0);
    if (fault === 'sql' || fault === 'bind' || fault === 'write') assert.ok(o.trace.sql.length > 0);
    if (fault === 'sql' || fault === 'bind') assert.equal(o.body.code, 'ledger_unavailable');
    assert.equal(scoreRun(broken, [input('M06/typed')]).scores[0].verdict, null);
    assert.equal(score('M06/typed').execution_status, 'complete');
    assert.equal(score('M06/typed').verdict, 'correct');
  });
}
test('comparison refuses changed evidence, changed keys and missing cases', () => {
  assert.equal(compareRuns(run, structuredClone(run), inputs).regression_gate, true);
  assert.equal(compareRuns(run, run, inputs).promotion_ready, false);
  const otherInput = { ...run, input_set_digest: 'different' };
  assert.throws(() => compareRuns(run, otherInput, inputs), /IDENTITY_MISMATCH/);
  const otherKey = { ...run, scoring_identity: 'different' };
  assert.throws(() => compareRuns(run, otherKey, inputs), /IDENTITY_MISMATCH/);
  assert.throws(() => scoreRun({ ...run, observations: run.observations.slice(1) }, inputs), /RUN_SET_MISMATCH/);
});
test('optional conditional fields cannot masquerade as lost required facts', () => {
  const mutant = changed('M04', o => { delete o.body.ledger.if_own_transfers; });
  const after = scoreRun(mutant, inputs).scores.find(s => s.id === 'M04');
  assert.equal(after.verdict, score('M04').verdict);
  assert.equal(after.utility, score('M04').utility);
  assert.equal(compareRuns(run, mutant, inputs).regression_gate, true);
});
test('empty citations cannot satisfy expense membership on nonempty relevant input', () => {
  const mutant = changed('M06/typed', o => { o.body.citations = []; });
  const after = scoreRun(mutant, inputs).scores.find(s => s.id === 'M06/typed');
  assert.ok(observation('M06/typed').trace.rows_read.length > 0);
  assert.equal(after.checks.find(c => c.id === 'expense-evidence-membership').ok, false);
  assert.equal(score('M06/typed').checks.find(c => c.id === 'expense-evidence-membership').ok, true);
  assert.equal(compareRuns(run, mutant, inputs).regression_gate, false);
});
test('frozen owner clock governs month boundaries through the real answer path', () => {
  const c = input('M06/typed');
  const previous = replay({ cases: [{ ...c, clock: { ...c.clock, now_utc: '2026-10-01T01:00:00Z' }, period: PERIODS.PREV }] }).observations[0];
  assert.equal(previous.body.ledger.from, '2026-09-01'); assert.equal(previous.body.ledger.to, '2026-09-30');
  assert.equal(previous.body.ledger.total_minor, 0); assert.ok(previous.trace.rows_read.length > 0);
  assert.equal(observation('M06/typed').body.ledger.total_minor, 61000);
});
test('DST fold and leap day use the owner calendar, with a reached coverage refusal peer', () => {
  const c = input('M06/typed');
  const otherZone = replay({ cases: [{ ...c, clock: { now_utc: '2026-11-01T06:30:00Z', owner_time_zone: 'America/New_York' },
    period: { rule: 'owner month through today', from: '2026-11-01', to: '2026-11-01' } }] }).observations[0];
  assert.equal(otherZone.body.ledger.from, '2026-11-01'); assert.equal(otherZone.body.ledger.total_minor, 700003);
  assert.ok(otherZone.trace.rows_read.some(r => r.id === 13));
  const leap = replay({ cases: [{ ...c, clock: { ...c.clock, now_utc: '2024-03-01T01:00:00Z' },
    period: { rule: 'owner leap month through today', from: '2024-02-01', to: '2024-02-29' } }] }).observations[0];
  assert.equal(leap.trace.parsed_intents[0].to, '2024-02-29');
  assert.equal(leap.body.code, 'period_outside_coverage');
  assert.ok(leap.trace.sql.some(s => s.kind === 'inventory' && s.row_count === 3));
  assert.equal(score('M06/typed').verdict, 'correct');
  assert.throws(() => validateInputs([{ ...c, clock: { ...c.clock, owner_time_zone: '' } }]), /INVALID_CASE/);
});
test('twelve-case warm timing is measured separately from migration setup', t => {
  const measurements = Array.from({ length: 3 }, () => replay({ cases: BASE_CASES }));
  assert.ok(measurements.every(r => r.observations.length === 12 && r.observations.every(o => o.execution_status === 'complete')));
  t.diagnostic(JSON.stringify({ runs: 3, base_cases: 12, warm_ms: measurements.map(r => r.warm_ms),
    setup_ms: measurements.map(r => r.setup_ms), wall_ms: measurements.map(r => r.wall_ms) }));
});
