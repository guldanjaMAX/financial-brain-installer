import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductFixture } from './product-contract-fixture.mjs';
import { refreshContentDates } from '../src/lib/content-freshness-maintenance.js';
import { storeFor } from '../src/lib/store.js';

const NOW = Date.parse('2026-10-11T12:00:00Z');
test('ingest and existing-document repair preserve rows and queue exact date projections', async () => {
  const f = await createProductFixture();
  try {
    const envelope = { source_type: 'files', source_id: 'state', title: 'State (2026-08-04).md',
      content: '# State\nLast updated 2026-09-21\nThe workspace setting is enabled.',
      occurred_at: '2026-08-04', date_source: 'filename', date_reliable: true,
      text_source: 'native', text_reliable: true, metadata: {} };
    await storeFor(f.env).ingest(f.env, envelope);
    let doc = f.first('SELECT * FROM documents WHERE doc_uid=?', 'files:state');
    assert.equal(doc.document_date, Date.parse('2026-09-21'));
    assert.equal(doc.date_source, 'content');
    // Mutation: simulate the shipped filename-first index without changing text.
    f.raw("UPDATE documents SET document_date=?,date_source='filename' WHERE doc_uid=?", Date.parse('2026-08-04'), 'files:state');
    f.raw('UPDATE chunks SET document_date=? WHERE doc_uid=?', Date.parse('2026-08-04'), 'files:state');
    const before = f.rows('SELECT chunk_uid,text FROM chunks ORDER BY chunk_uid');
    const preview = await refreshContentDates(f.env, { now: NOW });
    assert.equal(preview.planned, 1, 'preview reached a non-empty repair plan');
    assert.equal(preview.updated, 0);
    assert.equal(f.first('SELECT date_source FROM documents').date_source, 'filename');
    const changed = await refreshContentDates(f.env, { dryRun: false, approve: preview.plan_hash, now: NOW });
    assert.equal(changed.updated, 1);
    assert.equal(changed.complete, true);
    assert.deepEqual(f.rows('SELECT chunk_uid,text FROM chunks ORDER BY chunk_uid'), before);
    assert.ok(f.first("SELECT COUNT(*) AS n FROM vector_outbox WHERE op='upsert'").n > 0);
    assert.equal(f.first('SELECT document_date FROM chunks').document_date, Date.parse('2026-09-21'));
    assert.equal((await refreshContentDates(f.env, { dryRun: false, approve: preview.plan_hash, now: NOW })).updated, 0);
  } finally { f.sqlite.close(); }
});

test('maintenance detects revision races and truncated documents without advancing past them', async () => {
  const f = await createProductFixture();
  try {
    await storeFor(f.env).ingest(f.env, { source_type: 'files', source_id: 'race', title: 'State.md',
      content: 'Updated 2026-09-21\nThe setting is enabled.', text_source: 'native', text_reliable: true, metadata: {} });
    f.raw("UPDATE documents SET document_date=NULL,date_source='none',date_reliable=0 WHERE doc_uid='files:race'");
    const plan = await refreshContentDates(f.env, { now: NOW });
    assert.equal(plan.planned, 1);
    let batches = 0;
    const batch = f.env.DB.batch;
    f.env.DB.batch = async statements => {
      batches++;
      f.raw("UPDATE documents SET content_hash='synthetic-new-revision' WHERE doc_uid='files:race'");
      return batch(statements);
    };
    await assert.rejects(refreshContentDates(f.env, { dryRun: false, approve: plan.plan_hash, now: NOW }), /stale/);
    assert.equal(batches, 1, 'mutation reached the write decision');
    assert.equal(f.first('SELECT document_date FROM documents').document_date, null);
    f.env.DB.batch = batch;
    const stable = await refreshContentDates(f.env, { now: NOW });
    const good = await refreshContentDates(f.env, { dryRun: false, approve: stable.plan_hash, now: NOW });
    assert.equal(good.updated, 1, 'control repairs the same row when revision is stable');
    f.raw("UPDATE documents SET document_date=NULL,date_source='none',date_reliable=0 WHERE doc_uid='files:race'");
    for (let i = 1; i <= 500; i++) {
      f.raw('INSERT INTO chunks(chunk_uid,doc_uid,chunk_ix,text,source) VALUES (?,?,?,?,?)',
        `files:race#${i}`, 'files:race', i, 'Additional section.', 'files');
    }
    const bounded = await refreshContentDates(f.env, { now: NOW });
    assert.equal(bounded.blocked_documents, 1);
    await assert.rejects(refreshContentDates(f.env, { dryRun: false, approve: bounded.plan_hash, now: NOW }), /500 chunks/);
    assert.equal(bounded.cursor, 0);
    assert.equal(bounded.updated, 0);
    assert.ok(f.seen.sql.some(sql => /ORDER BY chunk_ix LIMIT 501/.test(sql)));
  } finally { f.sqlite.close(); }
});

test('metadata spelling fallback observes exact source filters before reading text', async () => {
  const { search } = await import('../src/lib/store-d1.js');
  const f = await createProductFixture();
  try {
    for (const source of ['allowed', 'excluded']) {
      await storeFor(f.env).ingest(f.env, { source_type: source, source_id: 'notes', title: 'Review notes',
        content: 'The launch checklist needs review.', text_source: 'native', text_reliable: true,
        metadata: { attendees: [source === 'allowed' ? 'Zorvyn' : 'Zorven'] } });
    }
    const result = await search(f.env, { query: 'Zorvan', filters: { source: 'allowed' }, limit: 5 });
    assert.ok(f.seen.sql.some(sql => /name-variant-metadata/.test(sql)));
    assert.ok(f.seen.sql.some(sql => /name-variant-hydration/.test(sql)));
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].source, 'allowed');
    assert.equal(result.results[0].query_variant.matched, 'Zorvyn');
    const ambiguous = await search(f.env, { query: 'Zorvan', limit: 5 });
    assert.equal(ambiguous.results.length, 0, 'unscoped ambiguous names cannot silently choose an identity');
    const sql = f.seen.sql.filter(text => /name-variant-(?:metadata|hydration)/.test(text));
    assert.ok(sql.some(text => /d\.source =/.test(text)));
  } finally { f.sqlite.close(); }
});

test('domain rescue retrieves a direct record beyond generic keyword and vector candidates', async () => {
  const { search } = await import('../src/lib/store-d1.js');
  const f = await createProductFixture();
  try {
    const ids = [];
    for (let i = 0; i < 20; i++) {
      const id = `newsletter-${i}`;
      await storeFor(f.env).ingest(f.env, { source_type: 'messages', source_id: id, title: `Industry newsletter ${i}`,
        content: 'This newsletter mentions bloodwork and supplements as industry keywords.', metadata: {},
        text_source: 'native', text_reliable: true });
      ids.push(f.first('SELECT chunk_uid FROM chunks WHERE doc_uid=?', `messages:${id}`).chunk_uid);
    }
    await storeFor(f.env).ingest(f.env, { source_type: 'files', source_id: 'results', title: 'Owner panel results.md',
      content: 'Panel results are filed here.', metadata: {}, text_source: 'native', text_reliable: true });
    f.env.VECTORIZE.query = async () => ({ matches: ids.map(id => ({ id })) });
    const result = await search(f.env, { query: 'my bloodwork', embedding: [0.1], limit: 3, projectionReadiness: { ready: true } });
    assert.ok(result.results.some(row => row.source_id === 'results'), 'direct record survives the public top three');
    const queries = f.seen.sql.filter(sql => /chunks_fts MATCH/.test(sql));
    assert.equal(queries.length, 2, 'original and expanded keyword decisions were reached');
    const control = await search(f.env, { query: 'newsletter', embedding: [0.1], limit: 3, projectionReadiness: { ready: true } });
    assert.ok(control.results.every(row => row.source === 'messages'));
  } finally { f.sqlite.close(); }
});

test('name metadata lookup cannot cross source-zone authority', async () => {
  const { search } = await import('../src/lib/store-d1.js');
  const f = await createProductFixture();
  try {
    for (const [source, zone, name] of [['allowed', 'business', 'Zorvyn'], ['excluded', 'personal', 'Zorven']]) {
      f.raw('INSERT INTO sources(name,kind,zone,created_at) VALUES (?,?,?,?)', source, 'folder', zone, NOW);
      await storeFor(f.env).ingest(f.env, { source_type: source, source_id: 'review', title: 'Review notes',
        content: 'Prepare the checklist.', metadata: { sender: name }, text_source: 'native', text_reliable: true });
    }
    const result = await search(f.env, { query: 'Zorvan', scope: { zones: ['business'] }, limit: 5 });
    assert.ok(f.seen.sql.some(sql => /name-variant-hydration/.test(sql)));
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].source, 'allowed');
    const denied = await search(f.env, { query: 'Zorvan', scope: { zones: ['unassigned'] }, limit: 5 });
    assert.equal(denied.results.length, 0);
    assert.ok(f.seen.sql.filter(sql => /name-variant-metadata/.test(sql)).every(sql => /SELECT name FROM sources WHERE zone IN/.test(sql)));
    const exact = await search(f.env, { query: 'Zorvyn', scope: { zones: ['business'] }, limit: 5 });
    assert.equal(exact.results.length, 1, 'an exact name carried only in metadata also retrieves its record');
    assert.equal(exact.results[0].query_variant, undefined);
  } finally { f.sqlite.close(); }
});

test('metadata spelling rescue rechecks exact document grants at hydration', async () => {
  const { search } = await import('../src/lib/store-d1.js');
  const f = await createProductFixture();
  try {
    for (const [id, name] of [['one', 'Zorvyn'], ['two', 'Zorven']]) {
      await storeFor(f.env).ingest(f.env, { source_type: 'files', source_id: id, title: 'Review notes',
        content: 'Prepare the checklist.', metadata: { sender: name, entity_slug: 'fixture-entity' },
        text_source: 'native', text_reliable: true });
    }
    f.raw("INSERT INTO document_access_grants(grant_id,subject_label,entity_slug,created_at,created_by,create_request_id,request_fingerprint) VALUES ('fixture-grant','reviewer','fixture-entity',?,'owner','fixture-request','fixture-hash')", NOW);
    f.raw("INSERT INTO document_access_documents(grant_id,document_id,entity_slug,granted_at) VALUES ('fixture-grant','files:one','fixture-entity',?)", NOW);
    const access = { kind: 'grant', grantId: 'fixture-grant', entitySlug: 'fixture-entity' };
    const control = await search(f.env, { query: 'Zorvan', access, limit: 5 });
    assert.equal(control.results.length, 1);
    assert.equal(control.results[0].source_id, 'one');
    const sql = f.seen.sql.filter(value => /name-variant-(?:metadata|hydration)/.test(value));
    assert.ok(sql.length >= 2 && sql.every(value => /document_access_documents/.test(value)));
    f.raw("UPDATE document_access_documents SET revoked_at=? WHERE grant_id='fixture-grant'", NOW);
    const revoked = await search(f.env, { query: 'Zorvan', access, limit: 5 });
    assert.equal(revoked.results.length, 0);
  } finally { f.sqlite.close(); }
});
