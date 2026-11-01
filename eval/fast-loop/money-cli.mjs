import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_CASES, CONTROLS } from '../../test/fixtures/fastloop-money/input.mjs';
import { replay, ROOT } from './money-replay.mjs';
import { scoreRun, SCORING_IDENTITY } from './money-score.mjs';
import { compareRuns } from './money-compare.mjs';

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
    if (!['--out', '--baseline', '--candidate'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw Error('USAGE: --out lane-evidence/run.json OR --baseline lane-evidence/base.json --candidate lane-evidence/candidate.json');
    options[args[i]] = safePath(args[++i]);
  }
  if (options['--baseline'] || options['--candidate']) {
    if (!options['--baseline'] || !options['--candidate'] || options['--out']) throw Error('COMPARISON_REQUIRES_TWO_RUNS');
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
  for (const score of report.scores) console.log(`${score.id}: ${score.verdict || score.execution_status}`);
  console.log(JSON.stringify({ base_cases: BASE_CASES.length, child_controls: CONTROLS.length,
    complete: report.complete, invalid: report.invalid, counts: report.counts,
    cold_setup_ms: run.setup_ms, warm_all_ms: run.warm_ms, wall_ms: run.wall_ms,
    provider_calls: run.provider_calls, production_writes: run.production_writes,
    source_digest: run.source_digest, input_set_digest: run.input_set_digest }, null, 2));
  return report.invalid || report.counts['wrong figure'] ? 1 : 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
