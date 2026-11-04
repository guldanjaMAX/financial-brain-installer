// Deliberate port of the seven-arm retrieval plan. Expected evidence is asserted
// in tests, rather than reclassifying the result with a copy of product logic.
import { sha256, typed } from './exact-tape.mjs';

export const ARMS = [
  { id: 'both-success-evidence', keyword: 'evidence', vector: 'evidence' },
  { id: 'both-success-empty', keyword: 'empty', vector: 'empty' },
  { id: 'keyword-failure-only', keyword: 'failure', vector: 'evidence' },
  { id: 'vector-failure-only', keyword: 'evidence', vector: 'failure' },
  { id: 'two-independent-failures', keyword: 'failure', vector: 'failure' },
  { id: 'shared-storage-failure', keyword: 'failure', vector: 'failure', shared: true },
  { id: 'invalid-scope-control', keyword: 'evidence', vector: 'evidence', invalidScope: true },
];
export const ROLE_ROW = {
  chunk_uid: 'role-source:role-record#0', doc_uid: 'role-source:role-record',
  text: 'The owner role approved the role record.', source: 'role-source',
  source_kind: 'unregistered', source_id: 'role-record', title: 'Role record',
  document_date: Date.parse('2026-01-01T00:00:00Z'), text_source: 'native', text_reliable: 1,
  date_source: 'fixture:fixed-date', date_reliable: 1,
};

const SQL = new Map([
  ['d7a9457dd4ea64485b36c028ce5d967c2036f0dbe15fdf6f2eeb19a234edaf8f',
    { kind: 'schema', binds: ['custom_api_current_jobs', 'custom_api_document_versions'] }],
  ['8cf5312882805c3ff1bbbce4dd0105e2e17a9beee9b984306e2adcd72d48cceb',
    { kind: 'keyword', binds: ['"owner" OR "role" OR "record"', 100] }],
  ['f28d794f9606732c0d38274e74a5eb8463bef5a0f2b6b1614a90c83ac6250a33',
    { kind: 'hydration', binds: [ROLE_ROW.chunk_uid] }],
]);

export async function runRetrievalArm(search, arm, { fail, fault = null }) {
  const calls = { sql: [], vector: [], keyword_errors: 0, vector_errors: 0, scope_refusals: 0,
    returned_rows: 0, shared_error_identity: false };
  const shared = Error('SYNTHETIC_SHARED_FAILURE');
  const keywordFailure = arm.shared ? shared : Error('SYNTHETIC_KEYWORD_FAILURE');
  const vectorFailure = arm.shared ? shared : Error('SYNTHETIC_VECTOR_FAILURE');
  const errors = [];
  const env = {
    DB: { prepare(sql) {
      let binds = [];
      return {
        bind(...args) { binds = args; return this; },
        async all() {
          const targeted = SQL.get(sha256(sql))?.kind === 'keyword';
          const observedSql = targeted && fault === 'arm-sql' ? `${sql} ` : sql;
          const observedBinds = targeted && fault === 'arm-bind' ? [...binds, null] : binds;
          calls.sql.push({ sql: observedSql, binds: observedBinds });
          const contract = SQL.get(sha256(observedSql));
          if (!contract || JSON.stringify(typed(observedBinds)) !== JSON.stringify(typed(contract.binds))) return fail('SNAPSHOT_MISS');
          const keyword = contract.kind === 'keyword';
          const hydration = contract.kind === 'hydration';
          if (keyword && arm.keyword === 'failure') {
            calls.keyword_errors++; errors.push(keywordFailure); throw keywordFailure;
          }
          const evidence = keyword ? arm.keyword === 'evidence' : hydration && arm.vector === 'evidence';
          return { results: evidence && fault !== 'drop-evidence' ? [ROLE_ROW] : [] };
        },
      };
    } },
    VECTORIZE: { async query(...args) {
      calls.vector.push(args);
      if (JSON.stringify(typed(args)) !== JSON.stringify(typed([[0.1], {
        topK: 100, returnValues: false, returnMetadata: 'none',
      }]))) return fail('SNAPSHOT_MISS');
      if (arm.vector === 'failure') { calls.vector_errors++; errors.push(vectorFailure); throw vectorFailure; }
      return { matches: arm.vector === 'evidence' ? [{ id: ROLE_ROW.chunk_uid, score: 0.9 }] : [] };
    } },
  };
  let result = null;
  try {
    result = await search(env, { query: 'owner role record', embedding: [0.1], limit: 5,
      filters: arm.invalidScope ? { role: 'owner-role' } : {}, projectionReadiness: { ready: true } });
    calls.returned_rows = result.results.length;
  } catch (error) {
    if (!arm.invalidScope || error.code !== 'unsupported_filter') throw error;
    calls.scope_refusals++;
  }
  calls.shared_error_identity = errors.length > 1 && errors.every(error => error === errors[0]);
  return { id: arm.id, result, calls };
}
