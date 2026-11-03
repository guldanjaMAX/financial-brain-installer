import { mkdirSync, writeFileSync } from 'node:fs';
import { runBench } from './day3-bench.mjs';

const args = process.argv.slice(2);
if (args.length && !(args.length === 2 && args[0] === '--candidate' && ['batch1', 'working-tree'].includes(args[1])))
  throw Error('USAGE: --candidate working-tree|batch1');
const { summary, runs, direct } = runBench({ candidate: args[1] || 'working-tree' });
mkdirSync(new URL('../../lane-evidence', import.meta.url), { recursive: true });
writeFileSync(new URL('../../lane-evidence/day3-results.json', import.meta.url), JSON.stringify(summary, null, 2) + '\n');
writeFileSync(new URL('../../lane-evidence/day3-executions.json', import.meta.url), JSON.stringify({ runs, direct }, null, 2) + '\n');
const label = summary.candidate_mode === 'batch1' ? 'batch1' : 'candidate';
const table = ['| Case | Answerability | Baseline | Candidate |', '|---|---|---|---|',
  ...summary.transitions.map(t => `| ${t.id} | ${t.answerability} | ${t.before} | ${t.after || t.execution_status} |`)].join('\n');
writeFileSync(new URL('../../lane-evidence/day3-table.md', import.meta.url), table + '\n');
console.log(JSON.stringify({ counts: summary.counts, gates: summary.gates, timings: summary.timings,
  baseline: summary.scores.baseline.counts, candidate: summary.scores[label].counts,
  candidate_mode: summary.candidate_mode, candidate_source_files: summary.candidate_source_files,
  misses: summary.misses, controls: summary.controls }, null, 2));
console.log(table);
process.exitCode = summary.gates.headline_gate ? 0 : 1;
