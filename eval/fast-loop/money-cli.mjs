import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_CASES, CONTROLS } from '../../test/fixtures/fastloop-money/input.mjs';
import { replay, ROOT } from './money-replay.mjs';
import { scoreRun, scoreObservation, SCORING_IDENTITY } from './money-score.mjs';
import { compareRuns } from './money-compare.mjs';
import { replayRoute } from './route-replay.mjs';

const inputs = [...BASE_CASES, ...CONTROLS];
const safePath = name => {
  const path = resolve(ROOT, name);
  const inside = relative(resolve(ROOT, 'lane-evidence'), path);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw Error('RECEIPT_PATH_OUTSIDE_WORKSPACE_EVIDENCE');
  return path;
};
export function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--routes' && !options.routes) { options.routes = true; continue; }
    if (!['--out', '--baseline', '--candidate'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw Error('USAGE: --out lane-evidence/run.json OR --baseline lane-evidence/base.json --candidate lane-evidence/candidate.json');
    options[args[i]] = safePath(args[++i]);
  }
  if (options['--baseline'] || options['--candidate']) {
    if (!options['--baseline'] || !options['--candidate'] || options['--out'] || options.routes) throw Error('COMPARISON_REQUIRES_TWO_RUNS');
    const result = compareRuns(JSON.parse(readFileSync(options['--baseline'], 'utf8')),
      JSON.parse(readFileSync(options['--candidate'], 'utf8')), inputs);
    console.log(JSON.stringify({ regression_gate: result.regression_gate, improved: result.improved,
      promotion_ready: result.promotion_ready, promotion_blockers: result.promotion_blockers,
      failures: result.failures, transitions: result.transitions }, null, 2));
    return result.regression_gate ? 0 : 1;
  }
  const run = replay();
  run.scoring_identity = SCORING_IDENTITY;
  // Freeze execution before loading any expected key into the scorer.
  if (options['--out']) writeFileSync(options['--out'], `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 });
  const report = scoreRun(run, inputs);
  const route = options.routes ? replayRoute({ cases: inputs }) : null;
  const routeScores = route?.observations.map((o, i) => scoreObservation(o, inputs[i]));
  for (const [index, score] of report.scores.entries()) {
    const other = routeScores?.[index];
    console.log(`${score.id}: ${score.verdict || score.execution_status}${other
      ? ` | HTTP: ${other.verdict || other.execution_status} | ${route.observations[index].body?.ledger ? 'ledger' : 'documents-empty'}` : ''}`);
  }
  console.log(JSON.stringify({ base_cases: BASE_CASES.length, child_controls: CONTROLS.length,
    complete: report.complete, invalid: report.invalid, counts: report.counts,
    cold_setup_ms: run.setup_ms, warm_all_ms: run.warm_ms, wall_ms: run.wall_ms,
    provider_calls: run.provider_calls, production_writes: run.production_writes,
    source_digest: run.source_digest, input_set_digest: run.input_set_digest,
    ...(route ? { http_complete: route.observations.filter(o => o.execution_status === 'complete').length,
      http_invalid: routeScores.filter(o => o.execution_status !== 'complete').length,
      http_warm_ms: route.warm_ms, http_wall_ms: route.wall_ms,
      combined_wall_ms: run.wall_ms + route.wall_ms,
      http_provider_calls: route.provider_calls, http_production_writes: route.production_writes,
      http_tape_digest: route.tape_digest, http_harness_digest: route.harness_digest,
      http_observation_digest: route.observation_digest } : {}) }, null, 2));
  return report.invalid || report.counts['wrong figure'] || routeScores?.some(o => o.execution_status !== 'complete' || o.verdict === 'wrong figure') ? 1 : 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
