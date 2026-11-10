import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { filterSql, scopeSql, documentAccessSql } from '../../src/lib/store-d1.js';
import { currentMemorySql } from '../../src/lib/memory-supersession.js';
import { customApiVisibilitySql } from '../../src/lib/custom-api-visibility.js';

export function candidateLimit(call) {
  const literal = call.sql.match(/ORDER BY score(?:, rowid)? LIMIT (\d+)/)?.[1];
  assert.ok(literal, 'candidate limit is an internal integer literal');
  const value = Number(literal);
  assert.ok(Number.isSafeInteger(value) && value >= 1 && value <= 25_600, 'candidate literal stays within cap');
  return value;
}

// A frozen copy of the pre-change projection and single-statement query. The
// only added ordering is rowid, which the retrieval contract permits for ties.
export function oldKeyword(db, terms, { limit = 5, filters = {}, scope = null, access = null } = {}, {
  memory = true, pointers = true,
} = {}) {
  const f = filterSql(filters, 'c', 3);
  const sc = scopeSql(scope, 'd', f.nextParam);
  const a = documentAccessSql(access, 'c', 'd', sc.nextParam);
  return db.prepare(`
    SELECT c.chunk_uid, c.doc_uid, c.text, d.source AS source,
           COALESCE(src.kind, 'unregistered') AS source_kind,
           c.title, c.document_date,
           c.client, c.category, c.top_folder, c.platform,
           d.source_id, d.uri, d.entity_slug, d.content_hash, d.date_source, d.date_reliable,
           d.text_source, d.text_reliable, d.meta AS authority_meta,
           (SELECT head.text FROM chunks head
             WHERE head.doc_uid = d.doc_uid AND head.chunk_ix = 0 LIMIT 1) AS authority_document_head,
           CASE WHEN d.date_source = 'calendar:event_start' AND json_valid(d.meta)
                THEN json_extract(d.meta, '$.start') END AS occurred_at,
           bm25(chunks_fts) AS score
    FROM chunks_fts
    JOIN chunks c ON c.id = chunks_fts.rowid
    JOIN documents d ON d.doc_uid = c.doc_uid
    LEFT JOIN sources src ON src.name = d.source
    WHERE chunks_fts MATCH ?1${f.clause}${sc.clause}${a.clause}${customApiVisibilitySql('d', pointers)}${memory ? currentMemorySql('d') : ''}
    ORDER BY bm25(chunks_fts), chunks_fts.rowid
    LIMIT ?2`).all(terms, limit, ...f.params, ...sc.params, ...a.params).map(row => ({ ...row }));
}

export function keywordFixture(count = 36_000, { maxBindings = Infinity } = {}) {
  const db = new DatabaseSync(':memory:');
  // Only the retrieval schema is needed. All statements, FTS5 ranking, JSON
  // predicates, joins and correlated authority reads execute in real SQLite.
  db.exec(`
    CREATE TABLE sources(name TEXT PRIMARY KEY, kind TEXT, zone TEXT);
    CREATE TABLE documents(doc_uid TEXT PRIMARY KEY, source TEXT, source_id TEXT,
      uri TEXT, entity_slug TEXT, content_hash TEXT, date_source TEXT,
      date_reliable INTEGER, text_source TEXT, text_reliable INTEGER, meta TEXT,
      category TEXT, deleted_at INTEGER);
    CREATE TABLE chunks(id INTEGER PRIMARY KEY, chunk_uid TEXT UNIQUE, doc_uid TEXT,
      chunk_ix INTEGER, text TEXT, source TEXT, title TEXT, document_date INTEGER,
      client TEXT, category TEXT, top_folder TEXT, platform TEXT);
    CREATE INDEX idx_chunks_doc ON chunks(doc_uid, chunk_ix);
    CREATE VIRTUAL TABLE chunks_fts USING fts5(text, title, content='chunks', content_rowid='id',
      tokenize='porter unicode61 remove_diacritics 2');
    CREATE TABLE document_access_documents(grant_id TEXT, document_id TEXT,
      entity_slug TEXT, revoked_at INTEGER);
    CREATE TABLE memory_supersessions(predecessor_doc_uid TEXT, predecessor_content_hash TEXT,
      successor_doc_uid TEXT, successor_content_hash TEXT, channel TEXT);
    CREATE INDEX idx_memory_predecessor ON memory_supersessions(predecessor_doc_uid);
    CREATE INDEX idx_memory_successor ON memory_supersessions(successor_doc_uid);
    CREATE TABLE custom_api_current_jobs(source TEXT PRIMARY KEY, job_id TEXT);
    CREATE TABLE custom_api_document_versions(source TEXT, job_id TEXT,
      logical_source_id TEXT, document_source_id TEXT);
    CREATE TABLE install_state(id INTEGER PRIMARY KEY, schema_version INTEGER);
    INSERT INTO install_state VALUES(1, 48);
  `);
  const source = db.prepare('INSERT INTO sources VALUES(?,?,?)');
  for (const [name, zone] of [['bulk', 'private'], ['narrow', 'books'], ['sparse', 'books'],
    ['owner-notes', 'books'], ['api', 'books']]) source.run(name, 'upload', zone);
  const document = db.prepare('INSERT INTO documents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const chunk = db.prepare('INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  let nextId = 1;
  const add = (id, source, text, { meta = '{}', entity = 'entity-a', category = 'record' } = {}) => {
    const uid = `${source}:${id}`;
    document.run(uid, source, id, 'https://example.invalid/record', entity, `hash-${id}`,
      'calendar:event_start', 1, 'native', 1, meta, category, null);
    chunk.run(nextId++, `${uid}#0`, uid, 0, text, source, 'Synthetic record',
      Date.parse('2026-01-01T00:00:00Z'), 'group-a', category, 'folder-a', 'upload');
    return uid;
  };
  db.exec('BEGIN');
  for (let i = 0; i < count; i++) {
    const source = i >= count - 20 ? 'sparse' : i >= 700 && i < 720 ? 'narrow' : 'bulk';
    add(String(i), source, 'invoice payment received the and' + (i % 10_000 === 9999 ? ' rareterm' : ''), {
      meta: '{"start":"2026-01-01T12:00:00Z"}',
    });
  }
  const note = { category: 'lesson', recorded_via: 'local_mcp', written_by: 'owner_assistant', agent_profile: 'owner-assistant' };
  const predecessor = add('memory-old', 'owner-notes', 'memorytoken invoice', { category: 'lesson', meta: JSON.stringify(note) });
  const successor = add('memory-current', 'owner-notes', 'memorytoken invoice', {
    category: 'lesson', meta: JSON.stringify({ ...note, supersedes: predecessor }),
  });
  add('memory-unlinked', 'owner-notes', 'memorytoken invoice', {
    category: 'lesson', meta: JSON.stringify({ ...note, supersedes: successor }),
  });
  db.prepare('INSERT INTO memory_supersessions VALUES(?,?,?,?,?)').run(predecessor, 'hash-memory-old', successor, 'hash-memory-current', 'local_mcp');
  for (const id of ['api-old', 'api-current', 'api-staged']) {
    add(id, 'api', 'apitoken invoice', { meta: JSON.stringify({ connector: 'custom_api', custom_api_source_id: 'logical' }) });
  }
  db.exec(`INSERT INTO custom_api_current_jobs VALUES('api','current');
    INSERT INTO custom_api_document_versions VALUES('api','current','logical','api-current');`);
  const grant = db.prepare('INSERT INTO document_access_documents VALUES(?,?,?,?)');
  for (let i = count - 10; i < count; i++) grant.run('grant-a', `sparse:${i}`, 'entity-a', null);
  grant.run('grant-a', 'bulk:0', 'entity-a', 1);
  grant.run('grant-a', 'bulk:1', 'entity-other', null);
  db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild'); COMMIT");
  const calls = [];
  const prepare = (sql, params = []) => ({
    bind: (...values) => prepare(sql, values),
    async all() {
      const call = { sql, params, rows: null };
      calls.push(call);
      if (params.length > maxBindings || [...sql.matchAll(/\?(\d+)/g)].some(match => Number(match[1]) > maxBindings)) {
        call.bindingRefused = true;
        throw new Error('D1_ERROR: too many SQL variables');
      }
      const results = db.prepare(sql).all(...params).map(row => ({ ...row }));
      call.rows = results.length;
      return { results };
    },
    async first() { calls.push({ sql, params }); return db.prepare(sql).get(...params) || null; },
  });
  return { db, env: { DB: { prepare } }, calls, count };
}

export async function differentialCases(searchKeyword, fixture) {
  const { db, env, calls } = fixture;
  const cases = [
    { name: 'no filter', query: 'invoice payment received', terms: '"invoice" OR "payment" OR "received"' },
    { name: 'source widening', filters: { source: 'narrow' }, widening: true },
    { name: 'source fallback', filters: { source: 'sparse' }, fallback: true },
    { name: 'zone scope', scope: { zones: ['books'], exclude: ['private'] }, widening: true },
    { name: 'zone exclusion', scope: { all: true, exclude: ['private'] }, widening: true },
    { name: 'grant access', access: { kind: 'grant', grantId: 'grant-a', entitySlug: 'entity-a' }, fallback: true },
    { name: 'memory supersession', query: 'memorytoken', terms: '"memorytoken"', ids: ['owner-notes:memory-current#0'] },
    { name: 'custom API', query: 'apitoken', terms: '"apitoken"', ids: ['api:api-current#0'] },
    { name: 'all stopwords', query: 'the and', terms: '"the" OR "and"' },
    { name: 'title-only term', query: 'synthetic', terms: '"synthetic"' },
    { name: 'porter stemming', query: 'payments', terms: '"payments"' },
    { name: 'equal score ties', ties: true },
    ...['client', 'category', 'top_folder', 'platform', 'entity_slug'].map(key => ({
      name: `${key} filter`, filters: { [key]: 'absent-value' }, empty: true,
    })),
    { name: 'from filter', filters: { from: '2026-02-01' }, empty: true },
    { name: 'to filter', filters: { to: '2025-12-31' }, empty: true },
    { name: 'zero survivors', filters: { source: 'absent-source' }, empty: true },
    { name: 'zero FTS matches', query: 'unmatchedtoken', terms: '"unmatchedtoken"', empty: true },
    { name: 'exhausted selective candidates', query: 'rareterm', terms: '"rareterm"', filters: { source: 'narrow' }, empty: true },
    { name: 'partial final page', filters: { source: 'narrow' }, limit: 30, fallback: true },
    { name: 'large limit', limit: 75 },
  ];
  for (const c of cases) {
    calls.length = 0;
    const options = { limit: 5, ...c };
    const expected = oldKeyword(db, c.terms || '"payment"', options);
    const actual = await searchKeyword(env, c.query || 'payment', options);
    assert.deepEqual(actual, expected, `${c.name}: exact rows, projection and bm25 scores`);
    const attempts = calls.filter(call => /chunks_fts MATCH/.test(call.sql));
    assert.ok(attempts.length > 0, `${c.name}: real FTS decision reached`);
    assert.equal(candidateLimit(attempts[0]), Math.max(400, 10 * options.limit), `${c.name}: initial candidate bound`);
    if (c.empty) assert.equal(actual.length, 0, `${c.name}: nothing visible`);
    else assert.ok(actual.length > 0, `${c.name}: positive result control`);
    if (c.ids) assert.deepEqual(actual.map(row => row.chunk_uid), c.ids, `${c.name}: independent visibility expectation`);
    if (c.widening || c.fallback) {
      assert.ok(attempts.some(call => /keyword_candidates/.test(call.sql)), `${c.name}: bounded candidate decision reached`);
      assert.ok(attempts.length > 1, `${c.name}: actually widened`);
      assert.ok(attempts[0].rows >= 1, `${c.name}: candidate-count sentinel survives zero eligible matches`);
    }
    if (c.fallback) assert.ok(attempts.some(call => !/keyword_candidates/.test(call.sql)), `${c.name}: exact fallback reached`);
    if (c.ties) {
      assert.equal(new Set(actual.map(row => row.score)).size, 1, 'fixture really has equal bm25 scores');
      assert.ok(attempts.every(call => /ORDER BY (?:score|bm25\(chunks_fts\)), (?:chunks_fts\.)?rowid/.test(call.sql)),
        'FTS candidate boundary has an explicit rowid tie-breaker');
      assert.ok(attempts.every(call => /ORDER BY top.score, top.rowid/.test(call.sql)),
        'filtered boundary has an explicit rowid tie-breaker');
    }
  }
  return cases.length;
}
