// Explicit read-only Git export into synthetic bench fixtures. No replay calls this.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { ROOT, sha } from './money-replay.mjs';
import { BATCH1, SOURCE_HASHES } from './batch1-sources.mjs';

const files = Object.fromEntries(Object.keys(SOURCE_HASHES).map(name => {
  const source = execFileSync('git', ['show', `${BATCH1}:worker/src/lib/${name}`],
    { cwd: ROOT, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', TMPDIR: ROOT + '/lane-evidence' } });
  assert.equal(sha(source), SOURCE_HASHES[name], 'copied source must match the reviewed object');
  return [name, source];
}));
writeFileSync(new URL('../../test/fixtures/fastloop-day3/batch1-sources.json', import.meta.url),
  JSON.stringify({ revision: BATCH1, source_sha256: SOURCE_HASHES, files }) + '\n');
console.log(JSON.stringify(SOURCE_HASHES));
