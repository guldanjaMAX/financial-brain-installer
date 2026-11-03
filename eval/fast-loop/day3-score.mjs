import { readFileSync } from 'node:fs';
import { scoreObservation, VERDICTS } from './money-score.mjs';
import { sha } from './money-replay.mjs';
import { goldForCase } from '../../test/fixtures/fastloop-day3/gold.mjs';
import { CLAIMS } from '../../test/fixtures/fastloop-day3/claims.mjs';

export const SCORER_ID = sha(['./day3-score.mjs', './money-score.mjs', './money-oracle.mjs',
  '../../test/fixtures/fastloop-day3/gold.mjs', '../../test/fixtures/fastloop-day3/claims.mjs',
  '../../test/fixtures/fastloop-money/gold.mjs'].map(path => readFileSync(new URL(path, import.meta.url), 'utf8')));
const normalized = text => String(text || '').replace(/\s*\[\d+\]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

export function scoreCase(observation, input) {
  const gold = goldForCase(input.id);
  if (gold.judge === 'ledger') {
    const score = scoreObservation(observation, input, gold);
    return { ...score, answerability: gold.answerability };
  }
  const score = { id: input.id, answerability: gold.answerability,
    execution_status: observation?.execution_status || 'missing', verdict: null, checks: [],
    safety_failures: [], required_obligations: gold.facts?.map(f => f.id) || gold.required_obligations,
    required_facts_met: 0, required_facts_total: gold.facts?.length || gold.required_obligations.length, utility: 0 };
  if (score.execution_status !== 'complete') return score;
  if (!observation.trace?.parsed_intents?.length ||
    (!observation.trace.ledger_entries?.length && !observation.trace.route)) {
    score.execution_status = 'invalid_witness'; return score;
  }
  const body = observation.body, answer = body.answer || '';
  if (!answer) { score.verdict = 'over-refusal'; return score; }
  if (gold.judge === 'recurring') {
    const groups = body.ledger?.recurring || [];
    score.checks = [
      { id: 'detected-monthly-cadence', ok: groups.some(g => g.cadence === 'monthly' && String(g.typical_minor) === gold.cents) },
      { id: 'not-confirmed', ok: /detected, not confirmed/i.test(answer) },
      { id: 'three-posted-sources', ok: gold.ids.every(id => body.citations?.some(c => c.ref === `ledger:transaction:${id}`)) },
    ];
    score.required_facts_met = score.checks.filter(c => c.ok).length;
    score.verdict = score.checks.every(c => c.ok) ? 'partly' : 'over-refusal';
  } else {
    const refs = [...answer.matchAll(/\[(\d+)\]/g)].map(m => Number(m[1]));
    const cited = (body.citations || []).filter(c => refs.includes(c.n));
    for (const f of gold.facts) {
      const visible = normalized(answer).includes(normalized(f.text));
      const source = cited.some(c => c.ref === f.source);
      const delivered = observation.trace.delivered_spans.some(s => s.doc_uid === f.source &&
        normalized(s.text).includes(normalized(f.evidence)));
      score.checks.push({ id: f.id, ok: visible && source && delivered, visible, source, delivered });
    }
    const prose = normalized(answer).split(/(?<=[.!?])\s+/).filter(Boolean);
    const allowed = (CLAIMS[input.id] || []).map(normalized);
    for (const claim of prose) if (!allowed.includes(claim)) score.safety_failures.push(`unsupported_claim:${sha(claim)}`);
    if (refs.some(n => !body.citations?.some(c => c.n === n))) score.safety_failures.push('unresolved_reference');
    score.required_facts_met = score.checks.filter(c => c.ok).length;
    score.verdict = score.checks.some(c => !c.source || !c.delivered) ? 'missing source'
      : score.safety_failures.length ? 'partly'
      : score.checks.some(c => !c.visible) ? 'partly'
      : gold.answerability === 'honest refusal' ? 'honest refusal'
      : gold.answerability === 'partial' ? 'partly' : 'correct';
  }
  score.utility = score.required_facts_met / score.required_facts_total;
  return score;
}
export function scoreBank(run, cases) {
  const inputs = cases.map(c => ({ ...c, snapshot: c.snapshot,
    modelOutputs: c.modelOutputs || ['The documents do not answer the question.'] }));
  if (run.input_set_digest !== sha(inputs)) throw Error('DAY3_INPUT_IDENTITY_MISMATCH');
  if (run.mode !== 'actual-worker-http-recorded-strict' || run.provider_calls !== 0 || run.production_writes !== 0 ||
    !run.node_version || !Object.keys(run.source_files || {}).length || run.source_digest !== sha(run.source_files) ||
    !/^[a-f0-9]{64}$/.test(run.harness_digest || '') || !/^[a-f0-9]{64}$/.test(run.tape_digest || ''))
    throw Error('DAY3_RUN_IDENTITY_MISMATCH');
  if (run.observation_digest !== sha(run.observations) || run.observations.length !== cases.length ||
    JSON.stringify(run.observations.map(o => o.id)) !== JSON.stringify(cases.map(c => c.id)) ||
    new Set(cases.map(c => c.id)).size !== cases.length) throw Error('DAY3_RUN_SET_MISMATCH');
  const scores = cases.map((c, i) => scoreCase(run.observations[i], c));
  return { planned: cases.length, attempted: scores.length,
    complete: scores.filter(s => s.execution_status === 'complete').length,
    invalid: scores.filter(s => s.execution_status !== 'complete').length,
    adjudicated: scores.filter(s => VERDICTS.includes(s.verdict)).length,
    counts: Object.fromEntries(VERDICTS.map(v => [v, scores.filter(s => s.verdict === v).length])), scores };
}
