import { same } from './money-oracle.mjs';
import { scoreRun } from './money-score.mjs';

export function compareRuns(baseline, candidate, inputs) {
  for (const key of ['schema', 'mode', 'bank_version', 'input_set_digest', 'migration_digest', 'scoring_identity', 'harness_digest', 'node_version']) {
    if (!baseline[key] || baseline[key] !== candidate[key]) throw Error(`COMPARISON_IDENTITY_MISMATCH:${key}`);
  }
  const before = scoreRun(baseline, inputs), after = scoreRun(candidate, inputs);
  if (!same(before.scores.map(s => s.id), after.scores.map(s => s.id))) throw Error('COMPARISON_CASE_MISMATCH');
  const failures = [];
  if (before.invalid || after.invalid) failures.push('INVALID_EXECUTION');
  const transitions = after.scores.map((score, i) => {
    const prior = before.scores[i];
    if (score.verdict === 'wrong figure' && prior.verdict !== 'wrong figure') failures.push(`NEW_WRONG_FIGURE:${score.id}`);
    for (const failure of score.safety_failures) if (!prior.safety_failures.includes(failure)) failures.push(`NEW_UNSUPPORTED_CLAIM:${score.id}:${failure}`);
    for (const figure of score.figure_results.filter(f => !f.ok)) {
      if (!prior.figure_results.some(p => !p.ok && p.id === figure.id && p.actual === figure.actual && p.expected === figure.expected))
        failures.push(`NEW_WRONG_FIGURE_CLAIM:${score.id}:${figure.id}`);
    }
    if (prior.verdict === 'correct' && score.verdict !== 'correct') failures.push(`LOST_CORRECT:${score.id}`);
    if (prior.verdict === 'honest refusal' && score.verdict !== 'honest refusal') failures.push(`LOST_REQUIRED_REFUSAL:${score.id}`);
    // Only frozen required facts define loss. Renderer validation checks are
    // safety witnesses, not extra obligations that grow with output shape.
    for (const id of prior.required_obligations.filter(id => prior.checks.some(c => c.id === id && c.ok)))
      if (!score.checks.some(c => c.id === id && c.ok)) failures.push(`LOST_FACT:${score.id}:${id}`);
    for (const check of score.checks.filter(c => c.failure === 'missing_source'))
      if (!prior.checks.some(c => c.id === check.id && c.failure === 'missing_source')) failures.push(`LOST_SOURCE_HONESTY:${score.id}:${check.id}`);
    return { id: score.id, before: prior.verdict, after: score.verdict, utility_before: prior.utility, utility_after: score.utility };
  });
  const improved = transitions.some(t => t.utility_after > t.utility_before);
  const inheritedWrong = after.scores.filter(s => s.verdict === 'wrong figure').map(s => s.id);
  return { regression_gate: failures.length === 0, failures, improved, inherited_wrong_figures: inheritedWrong,
    promotion_ready: false, promotion_blockers: ['DAY1_OFFLINE_ONLY', ...(!improved ? ['NO_QUALITY_IMPROVEMENT'] : []),
      ...(inheritedWrong.length ? ['REMAINING_WRONG_FIGURES'] : [])], transitions, baseline: before, candidate: after,
    baseline_source_digest: baseline.source_digest, candidate_source_digest: candidate.source_digest };
}
