import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { replay, ROOT } from '../eval/fast-loop/money-replay.mjs';
import { BASE_CASES } from './fixtures/fastloop-money/input.mjs';
import { runBench, CASES, loadTapes } from '../eval/fast-loop/day3-bench.mjs';
import { scoreBank, scoreCase } from '../eval/fast-loop/day3-score.mjs';
import { PERMANENT } from './fixtures/fastloop-day3/permanent.mjs';
import { DEVELOPMENT } from './fixtures/fastloop-day3/development.mjs';
import { RESERVED } from './fixtures/fastloop-day3/reserved.mjs';
import { GOLD, goldForCase } from './fixtures/fastloop-day3/gold.mjs';
import { validateBank } from './fixtures/fastloop-day3/builders.mjs';
import { replayRoute } from '../eval/fast-loop/route-replay.mjs';
import { sha, waitForQuiet } from '../eval/fast-loop/money-replay.mjs';
import { readFileSync } from 'node:fs';
import { batch1Sources } from '../eval/fast-loop/batch1-sources.mjs';
import { baselineSources, baselineHttpSources, workingTreeSources, verifyExecutedSources, verifyHistoricalSources, LEDGER_MODULES, BASELINE } from '../eval/fast-loop/ledger-sources.mjs';

let bench;
test.before(() => { bench = runBench(); });

const modules = ['ledger-analysis.js', 'ledger-answer.js', 'ledger-question.js'];
const candidate = batch1Sources();

test('read-only candidate overrides reach the real decision and change the executed source hash', () => {
  const cases = [BASE_CASES.find(c => c.id === 'M05')];
  const baseline = replay({ cases, sourceOverrides: baselineSources() });
  const changed = replay({ cases, sourceOverrides: candidate });
  assert.ok(baseline.observations[0].trace.parsed_intents.length > 0);
  assert.equal(baseline.observations[0].trace.fallback_calls, 1);
  assert.equal(changed.observations[0].execution_status, 'complete');
  assert.ok(changed.observations[0].trace.rows_read.length > 0);
  assert.equal(changed.observations[0].body.ledger?.expense_total_minor, 61000);
  assert.notEqual(changed.source_digest, baseline.source_digest);
});

test('the complete bank has 19 permanent, 20 development and 10 sealed reserved fact families', () => {
  assert.equal(PERMANENT.length, 19); assert.equal(DEVELOPMENT.length, 20); assert.equal(RESERVED.length, 10);
  assert.deepEqual(PERMANENT.map(c => c.id), Array.from({ length: 19 }, (_, i) => `Q${i + 1}`));
  assert.deepEqual(Object.keys(GOLD), CASES.map(c => c.id));
  assert.equal(new Set(CASES.map(c => c.family)).size, 49);
  for (const c of CASES) assert.ok(goldForCase(c.id).answerability);
  for (const set of [DEVELOPMENT, RESERVED]) for (const category of ['money', 'calendar', 'messages', 'documents', 'status'])
    assert.ok(set.some(c => c.category === category), `${category} absent`);
  assert.ok(RESERVED.every(c => c.split === 'reserved'));
  const used = new Set([...PERMANENT, ...DEVELOPMENT].flatMap(c => (c.documents || []).map(d => d.doc_uid)));
  for (const c of RESERVED) for (const d of c.documents || []) assert.ok(!used.has(d.doc_uid));
  assert.equal(sha(RESERVED), 'fc70eddeb1f56e3d38bd067b29e038d58c9a52ede17378b99421b090e2103355');
  assert.throws(() => validateBank([...CASES, CASES[0]]), /INVALID_BANK_SET/);
  assert.throws(() => goldForCase('absent'), /UNBOUND_DAY3_GOLD/);
});

test('both revisions execute and score every HTTP case and all 19 direct money peers', () => {
  for (const label of ['baseline', 'batch1']) {
    const score = bench.summary.scores[label];
    assert.deepEqual([score.planned, score.attempted, score.complete, score.adjudicated, score.invalid], [49, 49, 49, 49, 0]);
    const direct = bench.direct[label];
    assert.equal(direct.run.observations.length, 19);
    assert.ok(direct.scores.every(s => s.execution_status === 'complete' && s.verdict));
    for (const o of bench.runs[label].observations) {
      assert.equal(o.http_status, 200); assert.equal(o.trace.ledger_entries.length, 1);
      assert.ok(o.trace.parsed_intents.length > 0); assert.deepEqual(o.fatal, []);
      assert.equal(o.trace.tasks, o.trace.drained_tasks);
    }
    assert.equal(bench.runs[label].provider_calls, 0); assert.equal(bench.runs[label].production_writes, 0);
  }
});

test('the executed candidate is exactly the three reviewed modules and product source stays pinned', () => {
  for (const name of modules) {
    const path = `worker/src/lib/${name}`;
    assert.equal(bench.runs.batch1.source_files[path], sha(candidate[name]));
    assert.equal(bench.runs.baseline.source_files[path], sha(baselineSources()[name]));
    assert.notEqual(bench.runs.baseline.source_files[path], bench.runs.batch1.source_files[path]);
  }
  assert.equal(bench.runs.baseline.input_set_digest, bench.runs.batch1.input_set_digest);
  assert.equal(bench.runs.baseline.harness_digest, bench.runs.batch1.harness_digest);
  assert.throws(() => replay({ cases: [BASE_CASES[0]], sourceOverrides: { 'core.js': 'export {};' } }), /INVALID_SOURCE_OVERRIDE/);
  assert.throws(() => replayRoute({ sourceOverrides: { '../ledger-answer.js': 'export {};' } }), /INVALID_SOURCE_OVERRIDE/);
});
test('baseline HTTP also executes the pinned money veto rather than borrowing the current product module', () => {
  assert.equal(bench.runs.baseline.observations.length, 49);
  assert.ok(bench.runs.baseline.observations.some(o => o.trace.models.length > 0));
  assert.equal(bench.runs.baseline.source_files['worker/src/lib/money-veto.js'],
    '7a49c89bfa75cc702a9668b98cc198de9a2f37fd76652b204ffedded6f2b5788');
  verifyExecutedSources(bench.runs.baseline, baselineHttpSources());
  assert.throws(() => replayRoute({ sourceOverrides: { 'money-veto.js': 'export {};' } }), /INVALID_SOURCE_OVERRIDE/);
});

test('six known-bad controls fail with green peers and nonempty decision witnesses in both revisions', () => {
  for (const label of ['baseline', 'batch1']) {
    assert.equal(bench.summary.controls[label].length, 6);
    for (const control of bench.summary.controls[label]) {
      assert.equal(control.good, 'PASS'); assert.equal(control.known_bad, 'FAIL');
      assert.ok(control.decision_calls > 0);
    }
    assert.ok(new Set(bench.summary.scores[label].scores.map(s => s.verdict)).size > 2);
  }
});

test('missing, duplicate and reordered cases cannot silently disappear', () => {
  const run = bench.runs.baseline;
  for (const observations of [run.observations.slice(1), [...run.observations.slice(1), run.observations[1]],
    [...run.observations].reverse()]) {
    assert.throws(() => scoreBank({ ...run, observations, observation_digest: sha(observations) }, CASES), /RUN_SET_MISMATCH/);
  }
  assert.equal(scoreBank(run, CASES).complete, 49);
});

test('changed input identity cannot borrow a complete recorded run', () => {
  assert.equal(bench.runs.baseline.observations.length, 49);
  assert.throws(() => scoreBank({ ...bench.runs.baseline, input_set_digest: sha('different') }, CASES), /INPUT_IDENTITY/);
  assert.equal(scoreBank(bench.runs.baseline, CASES).complete, 49);
});

test('SQL and model misses fail after actual attempts with separate green route peers', () => {
  const fixtures = loadTapes().baseline;
  const sourceOverrides = baselineHttpSources();
  for (const [id, fault, status, witness] of [['D02', 'sql', 'snapshot_miss', 'sql'], ['D13', 'model', 'model_tape_miss', 'models']]) {
    const input = CASES.find(c => c.id === id);
    const bad = replayRoute({ cases: [input], fixtures, sourceOverrides, fault }).observations[0];
    assert.equal(bad.execution_status, status); assert.ok(bad.trace[witness].length > 0);
    assert.equal(scoreCase(bad, input).verdict, null);
    assert.equal(replayRoute({ cases: [input], fixtures, sourceOverrides }).observations[0].execution_status, 'complete');
  }
});

test('gold and reserved prose never enter the replay child module graph', () => {
  const names = Object.keys(bench.runs.baseline.source_files);
  assert.ok(names.length > 10);
  assert.ok(names.every(name => name.startsWith('worker/src/')));
  const source = readFileSync(new URL('../eval/fast-loop/route-worker.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /goldForCase|fastloop-day3\/gold|CLAIMS/);
  for (const c of CASES.filter(c => c.documents?.length))
    assert.ok(bench.runs.baseline.observations.find(o => o.id === c.id).trace.sql.length > 0);
});

test('candidate sources remain usable when subprocesses and historical Git reads are unavailable', () => {
  const env = { PATH: '/usr/bin:/bin', HOME: ROOT + '/lane-evidence/home-day3', BRAIN_NO_WRANGLER_LOGIN: '1' };
  for (const name of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) if (process.platform === 'win32' && process.env[name]) env[name] = process.env[name];
  waitForQuiet(env);
  const child = spawnSync(process.execPath, ['--permission', `--allow-fs-read=${ROOT}`,
    'test/fixtures/fastloop-day3/source-portability.mjs'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), Object.fromEntries(modules.map(name => [name, sha(candidate[name])])));
});

test('source omissions have full-route supported peers that can satisfy the same independent key', () => {
  for (const [id, source, sentence, verdict] of [
    ['Q10', 'zoom:review-followup', 'The owner owes the partner a revised outline by 2026-10-31', 'correct'],
    ['Q12', 'zoom:reply-call', 'The store owner is waiting for a review-time confirmation in the recorded call', 'partly'],
  ]) {
    const input = CASES.find(c => c.id === id);
    const before = bench.runs.baseline.observations.find(o => o.id === id);
    assert.equal(scoreCase(before, input).verdict, 'missing source');
    assert.ok(before.trace.delivered_spans.some(s => s.doc_uid === source));
    const number = before.body.results.findIndex(r => r.doc_uid === source) + 1;
    assert.ok(number > 0, 'the source reached actual retrieval and the delivered prompt');
    // Explicitly author a new synthetic positive arm before replay. Its answer
    // changes the check prompt, so the unchanged negative tape cannot be reused.
    const positive = { ...input, modelOutputs: [input.modelOutputs[0] + ` ${sentence} [${number}].`, ...input.modelOutputs.slice(1)] };
    const authored = replayRoute({ cases: [positive], capture: true });
    assert.equal(authored.observations[0].execution_status, 'complete');
    const after = replayRoute({ cases: [positive], fixtures: authored.tapes }).observations[0];
    assert.equal(after.execution_status, 'complete');
    assert.ok(after.trace.models.length >= 2);
    assert.ok(after.body.citations.some(c => c.ref === source), 'the added supported source reaches the final gate');
    const score = scoreCase(after, input);
    assert.equal(score.verdict, verdict);
    assert.equal(score.utility, 1);
    assert.deepEqual(score.safety_failures, []);
  }
});

test('current-tree mode executes all four selected modules against the pinned baseline without replacing tapes', () => {
  const tapesBefore = sha(loadTapes());
  const integrated = runBench({ candidate: 'working-tree' });
  const { summary, runs, direct } = integrated;
  assert.equal(summary.candidate_mode, 'working-tree');
  assert.equal(summary.baseline_revision, BASELINE);
  assert.equal(runs.baseline.observations.length, 49);
  assert.equal(runs.candidate.observations.length, 49);
  assert.equal(direct.candidate.run.observations.length, 19);
  assert.deepEqual(Object.keys(summary.candidate_source_files), LEDGER_MODULES);
  for (const [label, sources] of [['baseline', baselineSources()], ['candidate', workingTreeSources()]]) {
    verifyExecutedSources(runs[label], sources);
    verifyExecutedSources(direct[label].run, sources);
  }
  assert.equal(summary.scores.baseline.complete, 49, 'green full-route control');
  for (const miss of summary.misses.candidate) {
    const observation = runs.candidate.observations.find(o => o.id === miss.id);
    const peer = runs.baseline.observations.find(o => o.id === miss.id);
    assert.ok(miss.attempted_sql + miss.attempted_models > 0, 'miss reached an exact dependency decision');
    assert.ok(observation.trace.parsed_intents.length > 0);
    assert.equal(peer.execution_status, 'complete', 'same-input green peer');
    assert.equal(summary.scores.candidate.scores.find(s => s.id === miss.id).verdict, null);
  }
  if (summary.misses.candidate.length) {
    assert.equal(summary.gates.all_execute, false);
    assert.equal(summary.gates.headline_gate, false);
    assert.equal(summary.gates.no_regression, false);
    assert.equal(summary.gates.product_quality, false);
  }
  assert.equal(sha(loadTapes()), tapesBefore);
  assert.throws(() => runBench({ candidate: 'absent' }), /INVALID_CANDIDATE_MODE/);
});

test('executed-source checks reject an omitted reader or different executed bytes after a real green run', () => {
  const run = bench.runs.baseline, sources = baselineSources();
  assert.equal(run.observations.length, 49);
  assert.ok(run.observations.some(o => o.trace.sql.length > 0));
  verifyExecutedSources(run, sources);
  for (const change of [files => { delete files['worker/src/lib/ledger-reader.js']; },
    files => { files['worker/src/lib/ledger-reader.js'] = sha('different'); }]) {
    const bad = structuredClone(run); change(bad.source_files);
    assert.throws(() => verifyExecutedSources(bad, sources), /EXECUTED_SOURCE_MISMATCH:ledger-reader/);
  }
});

for (const id of ['Q4', 'Q5', 'Q7']) test(`integrated direct ${id} binds the reviewed display and query amount to independent facts`, () => {
  const input = CASES.find(c => c.id === id);
  const run = replay({ cases: [input], validateCases: validateBank, sourceOverrides: workingTreeSources() });
  const good = run.observations[0];
  assert.equal(good.execution_status, 'complete');
  assert.ok(good.trace.rows_read.length > 0, 'real fact read reached');
  assert.equal(scoreCase(good, input).verdict, 'correct', 'supported green peer');
  const bad = structuredClone(good);
  if (id === 'Q7') bad.body.ledger.amount_minor++;
  else if (id === 'Q5') bad.body.answer = bad.body.answer.replace('September 12', 'September 11');
  else bad.body.answer = bad.body.answer.replace('July 31 to October 31', 'July 30 to October 31');
  assert.notEqual(JSON.stringify(bad), JSON.stringify(good));
  assert.ok(scoreCase(bad, input).safety_failures.length > 0);
});

test('the versioned candidate arm executes every current HTTP and direct case', () => {
  const result = runBench({ candidate: 'working-tree' });
  assert.equal(result.summary.scores.candidate.complete, 49);
  assert.equal(result.direct.candidate.run.observations.length, 19);
  assert.ok(result.direct.candidate.run.observations.every(o => o.execution_status === 'complete'));
  assert.equal(result.summary.gates.headline_gate, true, JSON.stringify(result.summary.transitions.filter(t => t.new_safety.length || t.new_wrong_figures.length)));
  assert.equal(result.summary.gates.controls_discriminate, true);
  assert.ok(result.runs.candidate.observations.some(o => o.trace.sql.some(s => s.request)));
});

test('router inventory tapes have a real green peer and reject the prior inventory', () => {
  const input = CASES.find(c => c.id === 'D02');
  const current = loadTapes(), previous = loadTapes({ router: false });
  assert.deepEqual(current.baseline, previous.baseline, 'historical baseline stays frozen');
  assert.deepEqual(current.batch1, previous.batch1, 'historical candidate stays frozen');
  for (const id of Object.keys(current.candidate)) {
    assert.deepEqual(current.candidate[id].model, previous.candidate[id].model, 'model requests and replies stay frozen');
    assert.deepEqual(current.candidate[id].provider, previous.candidate[id].provider, 'provider requests and replies stay frozen');
  }
  const options = { cases: [input], sourceOverrides: workingTreeSources() };
  const green = replayRoute({ ...options, fixtures: current.candidate }).observations[0];
  assert.equal(green.execution_status, 'complete');
  assert.ok(green.trace.sql.length > 0, 'real inventory decision reached');
  assert.equal(green.body.ledger.expense_total_minor, 61000, 'nonempty positive figure');
  const refused = replayRoute({ ...options, fixtures: previous.candidate }).observations[0];
  assert.equal(refused.execution_status, 'snapshot_miss');
  assert.ok(refused.trace.sql.length > 0, 'exact inventory mismatch reached');
  assert.ok(refused.fatal.includes('SNAPSHOT_MISS'));
});
test('restoring historical candidate tapes blocks the gate and retains every case receipt', () => {
  const green = runBench({ candidate: 'working-tree' });
  assert.equal(green.summary.scores.candidate.complete, 49);
  const fixtures = loadTapes();
  const bad = runBench({ candidate: 'working-tree', fixtures: { ...fixtures, candidate: fixtures.batch1 } });
  assert.equal(bad.runs.candidate.observations.length, 49);
  assert.equal(bad.direct.candidate.run.observations.length, 19);
  assert.ok(bad.summary.misses.candidate.length > 0, 'historical tape decision reached');
  assert.ok(bad.summary.misses.candidate.every(m => m.attempted_sql + m.attempted_models > 0));
  assert.ok(bad.summary.controls.candidate.some(c => c.good === 'BLOCKED' && c.decision_calls > 0));
  assert.equal(bad.summary.gates.controls_discriminate, false);
  assert.equal(bad.summary.gates.headline_gate, false);
  assert.equal(bad.summary.scores.baseline.complete, 49, 'green historical peer retained');
});


test('historical shared-module drift is rejected after completed green replays', () => {
  const coreHash = sha(readFileSync(new URL('../worker/src/lib/core.js', import.meta.url), 'utf8'));
  for (const run of [bench.runs.baseline, bench.direct.baseline.run, bench.runs.batch1, bench.direct.batch1.run]) {
    assert.ok(run.observations.length > 0);
    assert.ok(run.observations.every(o => o.execution_status === 'complete'), 'green replay decision reached');
    assert.equal(run.source_files['worker/src/lib/core.js'], coreHash, 'both arms execute the reviewed shared core');
    verifyHistoricalSources(run);
    for (const name of ['core.js', 'fin-account-links.js']) {
      const bad = structuredClone(run);
      bad.source_files[`worker/src/lib/${name}`] = sha('different shared identity');
      assert.throws(() => verifyHistoricalSources(bad), {
        message: `HISTORICAL_SHARED_MISMATCH:${name}`,
      });
    }
  }
});
