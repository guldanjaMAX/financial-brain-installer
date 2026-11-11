import assert from 'node:assert/strict';
export const decode = ([type, value]) => type === 'object'
  ? Object.fromEntries(value.map(([key, field]) => [key, decode(field)]))
  : type === 'array' ? value.map(decode) : type === 'null' ? null
    : type === 'number' ? Number(value) : type === 'boolean' ? value === 'true' : value;
function equivalentRows(before, after) {
  const rows = after.filter(row => row.chunk_uid !== null).map(row => {
    const { _keyword_rowid, _keyword_candidate_count, institution_status, backfill_state, ...kept } = row;
    if (institution_status !== undefined) assert.equal(institution_status, null);
    if (backfill_state !== undefined) assert.equal(backfill_state, null);
    return kept;
  });
  // Retain the frozen score bytes across host arithmetic differences.
  rows.forEach((row, index) => {
    if (typeof row.score === 'number' && typeof before[index]?.score === 'number' &&
        Math.abs(row.score - before[index].score) <= Number.EPSILON * Math.max(Math.abs(row.score), Math.abs(before[index].score))) {
      row.score = before[index].score;
      after[index].score = before[index].score;
    }
  });
  assert.deepEqual(rows, before, 'all existing fixture facts and figures stay frozen');
}
export function reviewedStatement(before, after, priorOutput, output) {
  assert.equal(after.method, before.method);
  assert.deepEqual(after.binds, before.binds, 'typed bindings remain unchanged');
  if (before.sql === after.sql) return false;
  if (after.sql.includes('WITH keyword_candidates AS MATERIALIZED')) {
    assert.match(before.sql, /FROM chunks_fts/);
    assert.match(after.sql, /ORDER BY top.score, top.rowid LIMIT \?2/);
  } else {
    assert.equal(after.sql, before.sql.replace('c.basis_state AS coverage_basis,i.last_synced_at,',
      'c.basis_state AS coverage_basis,i.last_synced_at,i.status AS institution_status,\n      b.state AS backfill_state,'));
  }
  equivalentRows(priorOutput.results, output.results);
  return true;
}
