import { readFileSync } from 'node:fs';
import { sha, validateSourceOverrides, PINNED_HTTP_BASELINE } from './money-replay.mjs';
import { sourceInventory } from './batch1-sources.mjs';

export const BASELINE = '34a8f83243609df3b0e7ea5ed6beed0fd6e1f5a2';
export const LEDGER_MODULES = Object.freeze([
  'ledger-analysis.js', 'ledger-answer.js', 'ledger-question.js', 'ledger-reader.js',
]);
const BASELINE_INVENTORY = 'bd2cfc0f0ce37cb9c5b11074887c9c8b8982980b26a639ac361d3a0ca01ee6a6';

export function baselineSources() {
  const frozen = JSON.parse(readFileSync(new URL('../../test/fixtures/fastloop-day3/baseline-sources.json', import.meta.url)));
  validateSourceOverrides(frozen.files);
  const inventory = sourceInventory(frozen.files);
  if (frozen.revision !== BASELINE || JSON.stringify(Object.keys(frozen.files)) !== JSON.stringify(LEDGER_MODULES) ||
    sha(inventory) !== BASELINE_INVENTORY || JSON.stringify(inventory) !== JSON.stringify(frozen.source_sha256))
    throw Error('BASELINE_SOURCE_MISMATCH');
  return frozen.files;
}

export function workingTreeSources() {
  return Object.fromEntries(LEDGER_MODULES.map(name => [name,
    readFileSync(new URL(`../../worker/src/lib/${name}`, import.meta.url), 'utf8')]));
}

export function baselineHttpSources() {
  const frozen = JSON.parse(readFileSync(new URL('../../test/fixtures/fastloop-day3/baseline-http-source.json', import.meta.url)));
  if (frozen.revision !== BASELINE || frozen.source_sha256 !== PINNED_HTTP_BASELINE['money-veto.js'] ||
    sha(frozen.source) !== frozen.source_sha256) throw Error('BASELINE_HTTP_SOURCE_MISMATCH');
  return { ...baselineSources(), 'money-veto.js': frozen.source };
}

// Bind the bytes selected before launch to the bytes actually executed. Merely
// hashing the host files would miss an omitted override inside either child.
export function verifyExecutedSources(run, sources) {
  validateSourceOverrides(sources);
  for (const [name, hash] of Object.entries(sourceInventory(sources)))
    if (run.source_files?.[`worker/src/lib/${name}`] !== hash) throw Error(`EXECUTED_SOURCE_MISMATCH:${name}`);
}


// The three historical helpers matching the original bytes stay pinned. The
// reviewed D1/kind modules only supply DEFAULT_TENANT to historical readers;
// the frozen reader retains its original inventory query and grouping logic.
export function verifyHistoricalSources(run) {
  const bytes = readFileSync(new URL('../../test/fixtures/fastloop-day3/historical-shared-v1.json', import.meta.url), 'utf8');
  // The reviewed core change is behind the callLLM tape seam; both historical arms share the same core.
  if (sha(bytes) !== '3339a99896ebce28a8e9909184a584d59b1e848d40d1d9b9e6022039e0fb3eff') throw Error('HISTORICAL_SHARED_INVALID');
  const frozen = JSON.parse(bytes);
  for (const [name, hash] of Object.entries(frozen.source_sha256))
    if (run.source_files?.[`worker/src/lib/${name}`] !== hash) throw Error(`HISTORICAL_SHARED_MISMATCH:${name}`);
}
