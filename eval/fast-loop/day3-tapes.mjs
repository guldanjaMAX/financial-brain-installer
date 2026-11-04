import { readFileSync } from 'node:fs';
import { clone, sha256 } from './exact-tape.mjs';

const PATCH_SHA256 = 'bf169f305299bff6df550eae3f66dba9077b97962fb4b4dfa2045bca51191bbf';
export function candidateTapes(base, { router = true } = {}) {
  const bytes = readFileSync(new URL('../../test/fixtures/fastloop-day3/candidate-inventory-v1.json', import.meta.url), 'utf8');
  if (sha256(bytes) !== PATCH_SHA256) throw Error('CANDIDATE_TAPE_PATCH_INVALID');
  const patch = JSON.parse(bytes);
  if (patch.schema !== 1 || patch.version !== 'account-kind-inventory-v1' ||
      sha256(base) !== patch.base_sha256 || sha256(patch.sql) !== patch.sql_sha256)
    throw Error('CANDIDATE_TAPE_BASE_MISMATCH');
  const result = clone(base);
  const at = (value, path) => path.reduce((v, key) => v[key], value);
  // Every occurrence is reviewed separately, including inventory inside batches.
  // The independent synthetic inputs have no reviews. SQL and all other reply
  // fields remain exact; ordinary replay never captures replacement responses.
  for (const change of patch.patches) {
    const entry = result[change.id]?.d1[change.index];
    if (!entry || sha256(entry) !== change.before_sha256) throw Error('CANDIDATE_TAPE_ENTRY_MISMATCH');
    for (const path of change.sql_paths) {
      if (sha256(at(entry, path)) !== patch.before_sql_sha256) throw Error('CANDIDATE_TAPE_SQL_MISMATCH');
      at(entry, path.slice(0, -1))[path.at(-1)] = patch.sql;
    }
    for (const path of change.row_paths) for (const row of at(entry, path)) {
      if (Object.hasOwn(row, 'account_kind_review_json')) throw Error('CANDIDATE_TAPE_ROW_MISMATCH');
      row.account_kind_review_json = null;
    }
  }
  // Six arms restore changed routes or balance reads. Q11 additionally binds
  // the plain bank refusal in the model input; its SQL and reply stay exact.
  // These streams are authored explicitly from frozen synthetic inputs.
  for (const change of patch.additional) {
    if (sha256(result[change.id]) !== change.before_sha256) throw Error('CANDIDATE_TAPE_CASE_MISMATCH');
    result[change.id] = clone(change.tape);
  }
  return softCopyTapes(router ? routerTapes(result) : result);
}

function routerTapes(base) {
  const bytes = readFileSync(new URL('../../test/fixtures/fastloop-day3/candidate-router-v1.json', import.meta.url), 'utf8');
  if (sha256(bytes) !== ROUTER_PATCH_SHA256) throw Error('ROUTER_TAPE_PATCH_INVALID');
  const patch = JSON.parse(bytes);
  if (patch.schema !== 1 || patch.version !== 'router-inventory-v1' ||
      sha256(base) !== patch.base_sha256) throw Error('ROUTER_TAPE_BASE_MISMATCH');
  const result = clone(base);
  for (const change of patch.changes) {
    if (!Object.hasOwn(result, change.id) || sha256(result[change.id]) !== change.before_sha256)
      throw Error('ROUTER_TAPE_CASE_MISMATCH');
    for (const edit of change.edits) {
      const parent = edit.path.slice(0, -1).reduce((value, key) => {
        if (!Object.hasOwn(value, key)) throw Error('ROUTER_TAPE_PATH_MISMATCH');
        return value[key];
      }, result[change.id]);
      const key = edit.path.at(-1);
      if (edit.missing ? Object.hasOwn(parent, key)
        : !Object.hasOwn(parent, key) || sha256(parent[key]) !== edit.before_sha256)
        throw Error('ROUTER_TAPE_VALUE_MISMATCH');
      parent[key] = clone(edit.value);
    }
  }
  return result;
}

const ROUTER_PATCH_SHA256 = '2a41a6a0b2962543b435e87c17737fe6432fb8ee5504a1e27960445d4b85d118';

// Change only the reviewed refusal inside one exact model request. Frozen SQL,
// outputs and historical arms remain byte-for-byte inputs to the same matcher.
function softCopyTapes(result) {
  const bytes = readFileSync(new URL('../../test/fixtures/fastloop-day3/candidate-soft-copy-v1.json', import.meta.url), 'utf8');
  if (sha256(bytes) !== SOFT_COPY_PATCH_SHA256) throw Error('SOFT_COPY_TAPE_PATCH_INVALID');
  const patch = JSON.parse(bytes);
  if (patch.schema !== 1 || patch.version !== 'soft-refusal-copy-v1' || patch.case !== 'Q11' || patch.model_index !== 0)
    throw Error('SOFT_COPY_TAPE_PATCH_INVALID');
  const entry = result[patch.case].model[patch.model_index];
  if (sha256(entry) !== patch.before_sha256) throw Error('SOFT_COPY_TAPE_ENTRY_MISMATCH');
  let changed = 0;
  const rewrite = value => {
    if (typeof value === 'string') {
      changed += value.split(patch.from).length - 1;
      return value.replace(patch.from, patch.to);
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
    return value;
  };
  entry.input = rewrite(entry.input);
  if (changed !== 1 || sha256(entry) !== patch.after_sha256) throw Error('SOFT_COPY_TAPE_ENTRY_MISMATCH');
  return result;
}

const SOFT_COPY_PATCH_SHA256 = 'a95b2923f286f64e772db9cab8fcd4f92ecedc4652801d05a0943eb22fe67fcd';
