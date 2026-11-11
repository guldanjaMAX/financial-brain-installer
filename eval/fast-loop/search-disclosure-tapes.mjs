import { readFileSync } from 'node:fs';
import { clone, sha256 } from './exact-tape.mjs';

// A versioned, explicitly authored overlay keeps historical model/provider
// streams frozen. Unknown entries remain exact misses, never capture requests.
export function searchDisclosureTapes(fixtures, patch) {
  if (!patch) {
    const bytes = readFileSync(new URL('../../test/fixtures/fastloop-route/search-disclosure-v1.json', import.meta.url), 'utf8');
    if (sha256(bytes) !== PATCH_SHA256) throw Error('SEARCH_DISCLOSURE_TAPE_INVALID');
    patch = JSON.parse(bytes);
  }
  const entries = new Map(patch.entries.map(entry => [entry.before_sha256, entry.after]));
  const result = clone(fixtures);
  for (const tape of Object.values(result)) {
    tape.d1 = tape.d1.map(entry => clone(entries.get(sha256(entry)) || entry));
  }
  return result;
}

const PATCH_SHA256 = 'dbb859bfb313fd39f851a70cdc1d8d85b3ad3d3ca97c8a52a373a027b19f6429';
