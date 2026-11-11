import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PERMANENT } from '../../test/fixtures/fastloop-day3/permanent.mjs';
import { DEVELOPMENT } from '../../test/fixtures/fastloop-day3/development.mjs';
import { RESERVED } from '../../test/fixtures/fastloop-day3/reserved.mjs';
import { validateBank } from '../../test/fixtures/fastloop-day3/builders.mjs';
import { replay, sha } from './money-replay.mjs';
import { replayRoute } from './route-replay.mjs';
import { batch1Sources, sourceInventory, BATCH1 } from './batch1-sources.mjs';
import { scoreBank, scoreCase, SCORER_ID } from './day3-score.mjs';
import { candidateTapes } from './day3-tapes.mjs';
import { baselineSources, baselineHttpSources, workingTreeSources, verifyExecutedSources, verifyHistoricalSources, BASELINE } from './ledger-sources.mjs';

export const CASES = [...PERMANENT, ...DEVELOPMENT, ...RESERVED];
export function loadTapes({ router = true, disclosure = true } = {}) {
  const dev = JSON.parse(readFileSync(new URL('../../test/fixtures/fastloop-day3/development-tapes.json', import.meta.url)));
  const reserved = JSON.parse(readFileSync(new URL('../../test/fixtures/fastloop-day3/reserved-tapes.json', import.meta.url)));
  const historical = Object.fromEntries(['baseline', 'batch1'].map(k => [k, { ...dev[k], ...reserved[k] }]));
  return { ...historical, candidate: candidateTapes(historical.batch1, { router, disclosure }) };
}
export function controlsFor(run) {
  const controls = [];
  const mutate = (id, name, change, reject) => {
    const input = CASES.find(c => c.id === id), good = run.observations.find(o => o.id === id);
    const peerScore = scoreCase(good, input);
    if (good.execution_status !== 'complete' || peerScore.verdict !== 'correct') {
      controls.push({ name, decision_calls: good.trace.sql.length, good: 'BLOCKED', known_bad: 'BLOCKED',
        execution_status: good.execution_status, verdict: peerScore.verdict });
      return;
    }
    assert.equal(scoreCase(good, input).verdict, 'correct', `${name}: green peer`);
    assert.ok(good.trace.sql.length > 0 && good.trace.parsed_intents.length > 0, `${name}: decision witness`);
    const bad = structuredClone(good); change(bad);
    assert.notEqual(JSON.stringify(good), JSON.stringify(bad));
    const score = scoreCase(bad, input);
    assert.ok(reject(score), `${name}: bad control was accepted`);
    controls.push({ name, decision_calls: good.trace.sql.length, good: 'PASS', known_bad: 'FAIL', verdict: score.verdict });
  };
  mutate('D02', 'one-cent-display', o => { o.body.answer = o.body.answer.replace('$610.00', '$610.01'); }, s => s.verdict === 'wrong figure');
  mutate('D02', 'blanket-refusal', o => { o.body = { answer: null, citations: [] }; }, s => s.verdict === 'over-refusal');
  mutate('D13', 'missing-source', o => { o.body.citations = []; }, s => s.verdict === 'missing source');
  mutate('D13', 'undelivered-evidence', o => { o.trace.delivered_spans = []; }, s => s.verdict === 'missing source');
  mutate('D13', 'unsupported-claim', o => { o.body.answer += ' Release is approved.'; }, s => s.safety_failures.length > 0);
  const missing = { ...run, observations: run.observations.slice(1) };
  missing.observation_digest = sha(missing.observations);
  assert.throws(() => scoreBank(missing, CASES), /RUN_SET_MISMATCH/);
  controls.push({ name: 'dropped-case', decision_calls: run.observations.length, good: 'PASS', known_bad: 'FAIL' });
  return controls;
}
export function runBench({ candidate = 'batch1', fixtures = loadTapes() } = {}) {
  if (!['batch1', 'working-tree'].includes(candidate)) throw Error('INVALID_CANDIDATE_MODE');
  validateBank(CASES);
  assert.equal(PERMANENT.length, 19); assert.equal(DEVELOPMENT.length, 20); assert.equal(RESERVED.length, 10);
  const baseline = baselineSources();
  const overrides = candidate === 'working-tree' ? workingTreeSources() : { ...batch1Sources(), 'ledger-reader.js': baseline['ledger-reader.js'] };
  const candidateLabel = candidate === 'working-tree' ? 'candidate' : 'batch1';
  const runs = {}, scores = {}, direct = {}, timings = {}, controls = {};
  const money = CASES.filter(c => c.category === 'money');
  const parity = {};
  for (const [label, sourceOverrides, tapeLabel] of [['baseline', baseline, 'baseline'], [candidateLabel, overrides, candidate === 'working-tree' ? 'candidate' : 'batch1']]) {
    assert.deepEqual(Object.keys(fixtures[tapeLabel]), CASES.map(c => c.id), 'every frozen tape has one declared case');
    // The selected versioned arm is exact. Any further product drift is a miss.
    const httpSources = label === 'baseline' || candidate === 'batch1'
      ? { ...sourceOverrides, 'money-veto.js': baselineHttpSources()['money-veto.js'] } : sourceOverrides;
    const run = replayRoute({ cases: CASES, fixtures: fixtures[tapeLabel], sourceOverrides: httpSources });
    verifyExecutedSources(run, httpSources);
    if (label === 'baseline' || candidate === 'batch1') verifyHistoricalSources(run);
    runs[label] = run;
    scores[label] = scoreBank(run, CASES);
    const ledger = replay({ cases: money, sourceOverrides, validateCases: validateBank });
    verifyExecutedSources(ledger, sourceOverrides);
    if (label === 'baseline' || candidate === 'batch1') verifyHistoricalSources(ledger);
    direct[label] = { run: ledger, scores: money.map((c, i) => scoreCase(ledger.observations[i], c)) };
    if (label === 'baseline' || candidate === 'batch1') {
      assert.equal(scores[label].complete, 49, `${label}: complete HTTP count`);
      assert.equal(scores[label].adjudicated, 49, `${label}: scored HTTP count`);
    }
    assert.equal(ledger.observations.length, money.length);
    parity[label] = [];
    for (const o of ledger.observations) {
      assert.equal(o.execution_status, 'complete', `${label}:${o.id}`);
      assert.ok(o.trace.parsed_intents.length > 0);
      const peer = run.observations.find(p => p.id === o.id);
      if (peer.execution_status !== 'complete') {
        parity[label].push({ id: o.id, status: 'not_comparable', execution_status: peer.execution_status });
        continue;
      }
      if (o.body.ledger) {
        const { timing, ...body } = peer.body;
        assert.deepEqual(body, o.body, `${label}:${o.id}: direct/HTTP parity`);
      } else assert.ok(o.trace.fallback_calls > 0 || o.trace.sql.length > 0);
      parity[label].push({ id: o.id, status: 'checked' });
    }
    assert.equal(run.provider_calls + ledger.provider_calls, 0);
    assert.equal(run.production_writes + ledger.production_writes, 0);
    controls[label] = controlsFor(run);
    timings[label] = { http_warm_ms: run.warm_ms, http_wall_ms: run.wall_ms,
      direct_setup_ms: ledger.setup_ms, direct_warm_ms: ledger.warm_ms, direct_wall_ms: ledger.wall_ms };
  }
  const transitionsFor = (beforeScores, afterScores) => afterScores.map((s, i) => {
    const before = beforeScores[i];
    const newSafety = s.safety_failures.filter(f => !before.safety_failures.includes(f));
    const newFigures = (s.figure_results || []).filter(f => !f.ok && !(before.figure_results || [])
      .some(p => !p.ok && p.id === f.id && p.actual === f.actual && p.expected === f.expected)).map(f => f.id);
    const lost = before.checks.filter(c => c.ok && before.required_obligations.includes(c.id))
      .filter(c => !s.checks.some(after => after.id === c.id && after.ok)).map(c => c.id);
    return { id: s.id, answerability: s.answerability, before: before.verdict, after: s.verdict,
      execution_status: s.execution_status,
      facts_before: before.required_facts_met, facts_after: s.required_facts_met, new_safety: newSafety,
      new_wrong_figures: newFigures, lost_facts: lost,
      lost_correct: before.verdict === 'correct' && s.verdict !== 'correct' };
  });
  const transitions = transitionsFor(scores.baseline.scores, scores[candidateLabel].scores);
  const directTransitions = transitionsFor(direct.baseline.scores, direct[candidateLabel].scores);
  const allExecute = Object.values(scores).every(s => s.complete === 49 && s.adjudicated === 49 && s.invalid === 0);
  const controlsDiscriminate = Object.values(controls).every(list => list.every(c => c.good === 'PASS' && c.known_bad === 'FAIL'));
  const noRegression = list => list.every(t => t.execution_status === 'complete' && !t.new_safety.length &&
    !t.new_wrong_figures.length && !t.lost_facts.length && !t.lost_correct);
  const misses = Object.fromEntries(Object.entries(runs).map(([label, run]) => [label,
    run.observations.filter(o => o.execution_status !== 'complete').map(o => ({ id: o.id,
      execution_status: o.execution_status, fatal: o.fatal, attempted_sql: o.trace.sql.length,
      attempted_models: o.trace.models.length }))]));
  const summary = { schema: 1, bank_version: 'route-day3-v1', release_evidence: false,
    counts: { permanent: 19, development: 20, reserved: 10, http_per_revision: 49, direct_per_revision: money.length },
    gates: { all_execute: allExecute, no_dropped_cases: true, controls_discriminate: controlsDiscriminate,
      no_regression: allExecute && noRegression(transitions),
      headline_gate: allExecute && controlsDiscriminate && transitions.every(t => !t.new_wrong_figures.length && !t.new_safety.length),
      direct_no_regression: noRegression(directTransitions),
      product_quality: allExecute && scores[candidateLabel].scores.every(s => !s.safety_failures.length &&
        ['correct', 'honest refusal'].includes(s.verdict)) },
    scorer_id: SCORER_ID, input_digest: sha(CASES), reserved_digest: sha(RESERVED),
    tape_digest: sha(fixtures), baseline_revision: BASELINE, baseline_source_files: sourceInventory(baseline),
    baseline_http_source_files: sourceInventory(baselineHttpSources()),
    candidate_mode: candidate, candidate_revision: candidate === 'batch1' ? BATCH1 : 'working-tree',
    candidate_source_files: sourceInventory(overrides),
    timings, controls, scores, transitions, direct_transitions: directTransitions, misses, parity,
    sources: Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, { source_digest: r.source_digest,
      source_files: r.source_files, harness_digest: r.harness_digest, node_version: r.node_version }])),
    direct_scores: Object.fromEntries(Object.entries(direct).map(([k, r]) => [k, r.scores])) };
  return { summary, runs, direct };
}
