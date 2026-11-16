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

// Exact complete-tape identities bind the answer-boundary additions. Ordinary
// replay never records replacements or repairs an altered fixture.
const ANSWER_PATCH_SHA256 = '96cc0580decbd9e38c1ba01fb072b80e1d1d3c786db0fcd157623a062ea47d3f';
function answerPatch() {
  const bytes = readFileSync(new URL('../../test/fixtures/fastloop-route/owner-answer-contract-v1.json', import.meta.url), 'utf8');
  if (sha256(bytes) !== ANSWER_PATCH_SHA256) throw Error('OWNER_ANSWER_TAPE_INVALID');
  const patch = JSON.parse(bytes);
  if (patch.schema !== 1 || patch.version !== 'owner-answer-contract-v1' || patch.entries.some(entry =>
    sha256(entry.before) !== entry.before_sha256 || sha256(entry.after) !== entry.after_sha256)) throw Error('OWNER_ANSWER_TAPE_INVALID');
  return patch;
}
export function ownerAnswerTapes(fixtures) {
  const entries = new Map(answerPatch().entries.map(entry => [entry.before_sha256, entry.after]));
  return Object.fromEntries(Object.entries(fixtures).map(([id,tape]) => [id, clone(entries.get(sha256(tape)) || tape)]));
}
// The C3 authoring proof still compares its historical inventory edits. Undo
// only a whole, exact reviewed answer overlay; any drift retains its mismatch.
export function historicalAnswerTape(tape, preferred) {
  const entry = answerPatch().entries.find(entry => entry.after_sha256 === sha256(tape) &&
    (!preferred || entry.before_sha256 === sha256(preferred)));
  if (!entry) return clone(tape);
  const schemas = value => !value || typeof value !== 'object' ? [] :
    [...(Object.hasOwn(value, 'schema_version') ? [value.schema_version] : []), ...Object.values(value).flatMap(schemas)];
  const schema = schemas(entry.after)[0];
  const restore = value => Array.isArray(value) ? value.map(restore) : value && typeof value === 'object' ?
    Object.fromEntries(Object.entries(value).map(([key,child]) => [key,key === 'schema_version' ? schema : restore(child)])) : value;
  return restore(clone(entry.before));
}
