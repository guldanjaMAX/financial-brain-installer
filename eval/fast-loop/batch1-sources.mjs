import { readFileSync } from 'node:fs';
import { sha } from './money-replay.mjs';

export const BATCH1 = 'f919202f8add92e359b4ed0d65197488e51f222c';
export const SOURCE_HASHES = Object.freeze({
  'ledger-analysis.js': 'e90492833ff160b822571c54b57fceb0e8d4a734266a07b06d4c8927521d96c2',
  'ledger-answer.js': '9c3fdcccb4738c49cb33630f367395cfb56dff12014da48da5cdde65b244d772',
  'ledger-question.js': 'b78f4e655ba6db82b3f8344d4c5e0f6a782c5d2c11385360ad12d66e259e00fa',
});
export function batch1Sources() {
  const frozen = JSON.parse(readFileSync(new URL('../../test/fixtures/fastloop-day3/batch1-sources.json', import.meta.url)));
  if (frozen.revision !== BATCH1 || JSON.stringify(sourceInventory(frozen.files)) !== JSON.stringify(SOURCE_HASHES) ||
    JSON.stringify(frozen.source_sha256) !== JSON.stringify(SOURCE_HASHES)) throw Error('BATCH1_SOURCE_MISMATCH');
  return frozen.files;
}
export const sourceInventory = sources => Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, sha(source)]));
