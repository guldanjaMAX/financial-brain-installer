import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import worker from '../src/index.js';
import { searchKeyword, searchVector } from '../src/lib/store-d1.js';
import { verifyDriveIncrementalWorker } from '../../operations/drive-incremental.mjs';
import { readDocumentEvidence } from '../src/lib/document-answer.js';

// Only the D1 transport is substituted. HTTP authorization, finalization,
// revision ownership, receipts, triggers and retrieval all use product code.
globalThis.fetch = async () => { throw new Error('network forbidden'); };
function fixture({ through = 65 } = {}) {
  const db = new DatabaseSync(':memory:');
  const directory = new URL('../../migrations/d1/', import.meta.url);
  for (const name of readdirSync(directory).filter(n => n.endsWith('.sql') && Number(n.slice(0,4)) <= through).sort()) db.exec(readFileSync(new URL(name, directory), 'utf8'));
  db.exec("INSERT INTO install_state(id,client_slug,product_version,installed_at) VALUES(1,'fixture','0.0.0','2026-01-01')");
  db.exec("INSERT INTO sources(name,kind,created_at) VALUES('drive','drive','2026-01-01'),('gmail','gmail','2026-01-01')");
  db.prepare('UPDATE install_state SET schema_version=? WHERE id=1').run(through);
  const calls = [], plans = [];
  let fault = () => false;
  function statement(sql, binds = []) {
    // D1 numbered parameters bind by ordinal; node:sqlite uses named numeric keys.
    const run = () => {
      calls.push(sql);
      if (fault(sql)) throw new Error('synthetic interrupted write');
      const s = db.prepare(sql), params = Object.fromEntries(binds.map((v,i) => [String(i+1),v]));
      const args = binds.length ? [params] : [];
      if (/^(?:WITH candidates|SELECT COUNT\(\*\) AS stored_documents)/.test(sql.trim()) || /drive_family_base/.test(sql)) {
        plans.push(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(r => r.detail));
      }
      return s.columns().length ? { results: s.all(...args), meta: { changes: 0 } }
        : { meta: { changes: Number(s.run(...args).changes) } };
    };
    return { sql, bind: (...values) => statement(sql, values), all: async () => run(),
      first: async () => run().results?.[0] ?? null, run: async () => run(), execute: run };
  }
  const env = { STORAGE: 'd1', ADMIN_KEY: randomBytes(32).toString('hex'), VECTORIZE: {},
    DB: { prepare: statement, batch: async items => {
      db.exec('BEGIN IMMEDIATE');
      try { const results = items.map(i => i.execute()); db.exec('COMMIT'); return results; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    } } };
  async function post(path, body) {
    const response = await worker.fetch(new Request(`https://owner.invalid${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': env.ADMIN_KEY }, body: JSON.stringify(body) }), env, { waitUntil() {} });
    assert.equal(response.status, 200, 'real handler reached');
    return response.json();
  }
  const envelope = (content, source = 'drive') => ({ source_type: source, source_id: 'record', title: 'Owner record', content,
    metadata: { brain_retained_ingest: 1 } });
  return { db, env, calls, plans, envelope, setFault: f => { fault = f; },
    ingest: e => post('/api/admin/brain/ingest/batch', { docs: [e] }),
    receipt: b => post('/api/admin/brain/source-receipt', { source: 'drive', kind: 'drive', lane: 'incremental', run_id: 'fixture_run', ...b }),
    text: () => db.prepare("SELECT text FROM chunks WHERE doc_uid='drive:record' ORDER BY chunk_ix").all().map(r => r.text).join('\n') };
}
// Only operation counts cross the evidence boundary; never source bytes or ids.
function workCounts(f) {
  return JSON.stringify({ d1Statements:f.calls.length,
    journalWrites:f.calls.filter(sql=>/INSERT INTO retained_ingest_stages/.test(sql)).length,
    activations:f.calls.filter(sql=>/INSERT INTO retained_ingest_activations/.test(sql)).length,
    reads:f.calls.filter(sql=>/^\s*(?:SELECT|WITH)\b/.test(sql)).length,
    receipts:f.calls.filter(sql=>/INSERT INTO sync_runs/.test(sql)).length,
    deletes:f.calls.filter(sql=>/DELETE FROM (?:documents|chunks)\b/.test(sql)).length });
}
const oldText = 'Previously accepted source evidence. '.repeat(2500);
const newText = 'Replacement evidence with a changed amount. '.repeat(2500);

for (const phase of ['staging', 'activation']) test(`DRIVE-R2: interruption during ${phase} retains the complete accepted revision; retry succeeds`, async t => {
  const f = fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); });
  assert.equal((await f.ingest(f.envelope(oldText))).created, 1);
  const accepted = f.text(), marker = f.db.prepare("SELECT content_hash FROM documents WHERE doc_uid='drive:record'").get().content_hash;
  let reached = 0, writes = 0;
  f.setFault(sql => {
    const decision = phase === 'staging' ? /INSERT.*(?:retained_ingest_stages|chunks)/s.test(sql)
      : /INSERT INTO chunks/.test(sql);
    if (decision && ++writes === (phase === 'activation' ? 2 : 1)) { reached++; return true; }
    return false;
  });
  const failed = await f.ingest(f.envelope(newText));
  assert.equal(reached, 1, 'fault decision point reached');
  assert.equal(failed.failed, 1);
  assert.ok(f.text() === accepted, 'accepted text remains fully readable');
  assert.equal(f.db.prepare("SELECT content_hash FROM documents WHERE doc_uid='drive:record'").get().content_hash, marker);
  f.setFault(() => false);
  assert.equal((await f.ingest(f.envelope(newText))).updated, 1, 'successful update control');
});

test('DRIVE-R2: shorter revision is current in the answer reader while old text is retained and no deletion is issued', async t => {
  const f = fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); });
  assert.equal((await f.ingest(f.envelope(oldText))).created, 1);
  const before = f.calls.length;
  assert.equal((await f.ingest(f.envelope('Current owner evidence with the revised figure.'))).updated, 1);
  const reads = await readDocumentEvidence(f.env, [{ doc_uid: 'drive:record' }]);
  assert.equal(reads[0].read_complete, true);
  assert.equal(reads[0].snippet, '[Owner record]\n\nCurrent owner evidence with the revised figure.');
  assert.ok(!f.calls.slice(before).some(s => /DELETE FROM (?:documents|chunks)/.test(s)), 'no automatic deletion');
  const history = f.db.prepare('SELECT prior_chunks FROM retained_ingest_stages WHERE prior_document IS NOT NULL').all();
  assert.ok(history.some(r => r.prior_chunks.includes('Previously accepted source evidence')), 'accepted history preserved');
});

test('DRIVE-R1: real Drive and Gmail finalizers and seed/error receipts do not recount the unrelated corpus', async t => {
  const f = fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); });
  // Owner-scale document cardinality; chunk payload is small to keep this offline
  // query-plan probe light. Plans, rather than timing, prove index point lookups.
  f.db.exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<61600)
    INSERT INTO documents(doc_uid,source,source_id,ingested_at,content_hash,meta)
    SELECT 'drive:bulk-'||i,'drive','bulk-'||i,1,'fixture','{}' FROM n`);
  for (const source of ['drive', 'gmail']) {
    const e = f.envelope('Accepted changed source record.', source);
    delete e.metadata.brain_retained_ingest; // Exercise the real shared finalizer too.
    const response = await f.ingest(e);
    assert.equal(response.created, 1, `${source} changed-document control commits`);
  }
  assert.ok(f.plans.length >= 2, 'production finalization statistics decisions reached');
  assert.ok(!f.calls.some(sql => /source_counts AS/.test(sql)), 'no source-sized recount CTE');
  assert.deepEqual(f.plans.flat().filter(p => /SCAN (?:documents|chunks)\b/.test(p)), [], 'no source recount');
  for (const status of ['ready', 'error']) {
    const r = await f.receipt({ status, docs_added: 0, docs_refused: 0, docs_failed: status === 'error' ? 1 : 0 });
    assert.equal(r.counts_measured, false);
    assert.equal(r.documents, null, 'unmeasured total cannot appear exact');
  }
  assert.ok(f.plans.length >= 2, 'production finalization statistics decisions reached');
  const full = f.plans.flat().filter(p => /SCAN (?:documents|chunks)\b/.test(p));
  assert.deepEqual(full, [], 'unrelated corpus size cannot add a full table traversal');
  assert.ok(!f.calls.some(s => /COUNT\(DISTINCT family_doc_uid\)/.test(s)), 'receipt avoids family recount');
});

for (const [label, body, accepted, checked] of [
  ['seed', { status:'error', walk_complete:false, provider_check_complete:false, docs_failed:0 }, false, false],
  ['changed', { status:'ready', walk_complete:true, provider_check_complete:true, docs_added:1, docs_failed:0 }, true, true],
  ['quiet', { status:'ready', walk_complete:true, provider_check_complete:true, files_seen:0, docs_failed:0 }, false, true],
  ['held', { status:'error', walk_complete:false, provider_check_complete:false, docs_refused:1, docs_failed:0 }, false, false],
  ['partial', { status:'error', walk_complete:false, provider_check_complete:false, docs_added:1, docs_failed:0 }, false, false],
]) test(`DRIVE-R5: real ${label} receipt separates accepted work, feed check and history coverage`, async t => {
  const f = fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); });
  const at = '2026-11-01T00:00:00.000Z';
  await f.receipt({ docs_refused:0, docs_added:0, docs_updated:0, docs_unchanged:0, files_seen:1,
    completed_at:at, complete_sweep:false, ...body });
  const run = f.db.prepare("SELECT * FROM sync_runs WHERE run_id='fixture_run'").get();
  assert.equal(run.metrics_version, 1, 'measured receipt decision reached');
  assert.equal(run.provider_check_complete, checked ? 1 : 0);
  const source = f.db.prepare("SELECT * FROM sources WHERE name='drive'").get();
  assert.equal(source.last_ingest_at, accepted || checked ? at : null, 'registry preserves its verified-last-read contract');
  const acceptedAt = f.db.prepare("SELECT MAX(finished_at) AS at FROM sync_runs WHERE error IS NULL AND (docs_added>0 OR docs_updated>0 OR docs_unchanged>0)").get().at;
  assert.equal(acceptedAt, accepted ? Date.parse(at) : null, 'last accepted work remains separate from a quiet check');
  assert.equal(source.last_complete_sweep_at, null);
});

test('DRIVE-R4: backup-first procedure and disposable restore preserve database and checkpoint together', async t => {
  const procedure = readFileSync(new URL('../../docs/drive-incremental-recovery.md', import.meta.url), 'utf8');
  assert.ok(procedure.indexOf('Backup first') < procedure.indexOf('brain update'), 'backup precedes update instructions');
  assert.match(procedure, /restore window/);
  assert.match(procedure, /clean Vectorize index/);
  const { backup } = await import('node:sqlite');
  const { mkdtempSync, writeFileSync, copyFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { loadState } = await import('../../ingest/run.mjs');
  const { RECOVERY_EXPORT_TABLES } = await import('../../operations/cloudflare-recovery-adapter.mjs');
  assert.ok(RECOVERY_EXPORT_TABLES.includes('retained_ingest_stages'));
  assert.ok(RECOVERY_EXPORT_TABLES.includes('retained_ingest_activations'));
  const f = fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); });
  assert.equal((await f.ingest(f.envelope('Accepted evidence before the canary.'))).created, 1);
  const dir = mkdtempSync(join(process.env.HOME, 'restore-'));
  const saved = join(dir, 'database.sqlite'), restored = join(dir, 'restored.sqlite');
  const checkpoint = join(dir, 'checkpoint.json'), savedCheckpoint = join(dir, 'checkpoint-backup.json');
  const before = JSON.stringify({ version:1, done:{ 'drive:record':'accepted' }, skipped:{}, sync_token:'before-page' });
  writeFileSync(checkpoint, before, { mode:0o600 }); copyFileSync(checkpoint, savedCheckpoint);
  await backup(f.db, saved);
  assert.equal((await f.ingest(f.envelope('New evidence after the canary.'))).updated, 1, 'changed-data control');
  writeFileSync(checkpoint, JSON.stringify({ version:1, done:{}, sync_token:'after-page' }));
  // Restore only a disposable copy. The changed database and its stage journal
  // remain available; a production restore needs its own current owner plan.
  copyFileSync(saved, restored); copyFileSync(savedCheckpoint, checkpoint);
  const recovered = new DatabaseSync(restored); t.after(() => recovered.close());
  assert.equal(recovered.prepare("SELECT text FROM chunks WHERE doc_uid='drive:record'").get().text,
    '[Owner record]\n\nAccepted evidence before the canary.');
  assert.equal(recovered.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  assert.equal(loadState(checkpoint, { strict:true }).sync_token, 'before-page');
  assert.equal(readFileSync(checkpoint, 'utf8'), before);
  assert.ok(f.text().includes('New evidence after the canary.'), 'post-bookmark data is retained separately');
});


test('shortened revision cannot hydrate an obsolete keyword or semantic tail', async t => {
  const f = fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); });
  assert.equal((await f.ingest(f.envelope(oldText + " Obsolete tail figure 99999."))).created, 1);
  const tail = f.db.prepare("SELECT chunk_uid,vector_id FROM chunks WHERE doc_uid='drive:record' ORDER BY chunk_ix DESC LIMIT 1").get();
  assert.equal((await f.ingest(f.envelope('Current figure is 12345.'))).updated, 1);
  assert.ok(f.db.prepare('SELECT text FROM chunks WHERE chunk_uid=?').get(tail.chunk_uid).text.includes('99999'), 'obsolete durable text is retained');
  assert.deepEqual(await searchKeyword(f.env, '99999', { limit:5 }), []);
  f.env.VECTORIZE.query = async () => ({ matches:[{ id:tail.vector_id, score:1 }] });
  assert.deepEqual(await searchVector(f.env, [0.1], { limit:5 }), []);
  assert.equal((await searchKeyword(f.env, '12345', { limit:5 })).length, 1, 'current figure control remains retrievable');
});

test('paired-runtime capability read rejects paused and old schemas before any writer', async t => {
  const f = fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); });
  let decisions = 0;
  const request = (url, options) => { decisions++; return worker.fetch(new Request(url, options), f.env, {}); };
  await verifyDriveIncrementalWorker('https://owner.invalid', f.env.ADMIN_KEY, { request });
  f.env.VECTOR_DRAIN_MODE = 'paused-for-upgrade';
  await assert.rejects(verifyDriveIncrementalWorker('https://owner.invalid', f.env.ADMIN_KEY, { request }), /protocol unavailable/);
  delete f.env.VECTOR_DRAIN_MODE;
  f.db.exec('UPDATE install_state SET schema_version=64 WHERE id=1');
  await assert.rejects(verifyDriveIncrementalWorker('https://owner.invalid', f.env.ADMIN_KEY, { request }), /protocol unavailable/);
  assert.equal(decisions, 3, 'all real authenticated capability decisions reached');
  assert.ok(!f.calls.some(sql => /INSERT INTO (?:chunks|retained_ingest_stages|sync_runs)/.test(sql)));
});

test('producer metadata cannot hide accepted chunks behind a forged active range', async t => {
  const f = fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); });
  const envelope = f.envelope('The supported amount is 12345.');
  delete envelope.metadata.brain_retained_ingest;
  envelope.metadata.brain_active_chunk_count = 0;
  assert.equal((await f.ingest(envelope)).created, 1, 'ingest decision reached');
  const read = await readDocumentEvidence(f.env, [{ doc_uid:'drive:record' }]);
  assert.equal(read[0].read_complete, true);
  assert.match(read[0].snippet, /12345/);
});

test('lost activation response is recovered by exact unchanged replay and retains both representations', async t => {
  const f = fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); });
  assert.equal((await f.ingest(f.envelope(oldText))).created, 1);
  const batch = f.env.DB.batch;
  let lost = 0;
  f.env.DB.batch = async items => {
    const outcome = await batch(items);
    if (items.some(item => /INSERT INTO retained_ingest_activations/.test(item.sql)) && lost++ === 0) throw new Error('lost committed response');
    return outcome;
  };
  assert.equal((await f.ingest(f.envelope(newText))).failed, 1);
  assert.equal(lost, 1, 'post-commit response fault reached');
  const reading = await readDocumentEvidence(f.env, [{ doc_uid:'drive:record' }]);
  assert.equal(reading[0].read_complete, true);
  assert.ok(reading[0].snippet.includes('Replacement evidence'));
  assert.ok(f.db.prepare('SELECT prior_chunks FROM retained_ingest_stages WHERE prior_document IS NOT NULL').all()
    .some(row => row.prior_chunks.includes('Previously accepted source evidence')));
  assert.equal((await f.ingest(f.envelope(newText))).unchanged, 1, 'exact replay control');
});

test('unfinished receipt cleanup is a bounded resumable indexed slice', async t => {
  const f = fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); });
  f.db.exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<120)
    INSERT INTO sync_runs(run_id,source,lane,started_at) SELECT 'old_'||i,'drive','incremental',1 FROM n`);
  for (const expected of [70,20,0]) {
    await f.receipt({ status:'indexing', started_at:'2026-11-01T00:00:00.000Z' });
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM sync_runs WHERE source='drive' AND finished_at IS NULL AND run_id<>'fixture_run'").get().n, expected);
  }
  assert.ok(f.calls.some(sql => /idx_sync_runs_open_source[\s\S]*LIMIT 50/.test(sql)), 'bounded cleanup decision reached');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sync_runs').get().n, 121, 'no receipt deletion');
});

test('schema-65 DDL is restart-safe and never rewrites retained content', async t => {
  const f = fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); });
  assert.equal((await f.ingest(f.envelope('Accepted source text.'))).created, 1);
  const before = f.db.prepare('SELECT * FROM retained_ingest_stages').all();
  const sql = readFileSync(new URL('../../migrations/d1/0065_retained_ingest_stages.sql', import.meta.url), 'utf8');
  f.db.exec(sql); f.db.exec(sql);
  assert.deepEqual(f.db.prepare('SELECT * FROM retained_ingest_stages').all(), before);
  assert.ok(f.text().includes('Accepted source text.'), 'accepted-text control remains readable');
});

test('legacy per-document receipt validation visits only a fixed physical chunk page', async t => {
  const f = fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); });
  assert.equal((await f.ingest(f.envelope('Accepted existing document.'))).created, 1);
  f.db.exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<5000)
    INSERT INTO chunks(chunk_uid,doc_uid,chunk_ix,text,source)
    SELECT 'drive:record#'||i,'drive:record',i,'Legacy retained source section.','drive' FROM n`);
  let visits = 0;
  f.db.function('row_visit', value => { visits++; return value; });
  const prepare = f.env.DB.prepare;
  // Instrument the real receipt predicate, leaving its relational semantics
  // unchanged. Counting predicate evaluations detects a LIMIT after filtering.
  f.env.DB.prepare = sql => prepare(sql.replace(/((?:AND|WHERE)\s+)(receipt_(?:chunks|page)\.bound_document_revision_id)/g,
    '$1row_visit($2)'));
  const result = await f.ingest(f.envelope('Updated source text.'));
  assert.equal(result.failed, 1, 'oversized prior revision decision reached');
  assert.ok(visits > 0, 'real receipt predicate reached');
  assert.ok(visits <= 513, `receipt predicate exceeded its physical page: ${visits}`);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE doc_uid='drive:record'").get().n, 5001);
  const control = fixture(); t.after(() => control.db.close());
  assert.equal((await control.ingest(control.envelope('Bounded accepted control.'))).created, 1);
});

test('bounded corpus counters stay aligned with physical rows without a source recount', async t => {
  const f = fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); });
  for (const content of ['Accepted source text.', newText, 'Shorter replacement.']) {
    const result = await f.ingest(f.envelope(content));
    assert.equal(result.failed, 0, 'real changed-document control commits');
    const cached = f.db.prepare("SELECT documents,chunks FROM corpus_stats WHERE source='drive'").get();
    const actual = f.db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE doc_uid='drive:record'").get().n;
    assert.equal(cached.documents, 1);
    assert.equal(cached.chunks, actual, 'projection bookkeeping cannot invent provider-only vectors');
  }
});


test('schema-64 upgrade retains the established counter baseline and row deltas survive lifecycle transitions', async t => {
  const f = fixture({ through:64 }); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); });
  f.db.exec(`INSERT INTO documents(doc_uid,source,source_id,ingested_at,content_hash,meta)
    VALUES('drive:record','drive','record',1,'legacy','{}');
    INSERT INTO chunks(chunk_uid,doc_uid,chunk_ix,text,source) VALUES('drive:record#0','drive:record',0,'Accepted legacy text.','drive');
    INSERT INTO corpus_stats(source,documents,chunks) VALUES('drive',1,1);`);
  const migration = readFileSync(new URL('../../migrations/d1/0065_retained_ingest_stages.sql', import.meta.url), 'utf8');
  f.db.exec(migration);
  f.db.exec('UPDATE install_state SET schema_version=65 WHERE id=1');
  assert.equal((await f.ingest(f.envelope(newText))).updated, 1);
  const counters = () => f.db.prepare("SELECT documents,chunks FROM corpus_stats WHERE source='drive'").get();
  const count = f.db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE doc_uid='drive:record'").get().n;
  assert.equal(counters().documents, 1); assert.equal(counters().chunks, count);
  f.db.exec("UPDATE documents SET deleted_at=2 WHERE doc_uid='drive:record'");
  assert.equal(counters().documents, 0); assert.equal(counters().chunks, 0);
  f.db.exec("UPDATE documents SET deleted_at=NULL WHERE doc_uid='drive:record'");
  assert.equal(counters().documents, 1); assert.equal(counters().chunks, count);
  // Explicit fixture deletion checks cascade accounting, not a connector path.
  f.db.exec("DELETE FROM documents WHERE doc_uid='drive:record'");
  assert.equal(counters().documents, 0); assert.equal(counters().chunks, 0);
});

test('real CLI page recovery composes with retained D1 activation and the real batch/receipt transport', async t => {
  const { cmdIngestRemote, credentialScannerFingerprint } = await import('../../brain.mjs');
  const ingest = await import('../../ingest/run.mjs');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const f = fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); });
  assert.equal((await f.ingest(f.envelope(oldText))).created, 1);
  const accepted = f.text();
  const directory = mkdtempSync(join(process.env.HOME, 'composed-'));
  const manifestPath = join(directory, 'manifest.json'), statePath = join(directory, '.brain-ingest-drive.json');
  const keyPath = join(directory, '.brain-admin-key');
  writeFileSync(keyPath, f.env.ADMIN_KEY, { mode:0o600 });
  const launchctl = join(directory, 'launchctl-fixture');
  writeFileSync(launchctl, '#!/bin/sh\nexit 99\n', { mode:0o700 });
  const manifest = { brain:{ domain:'owner.invalid' }, corpora:{ google_drive:{ enabled:true,root_folder_ids:['reviewed'] } },
    safety:{ credential_scanner:{ enabled:true }, ocr:{ enabled:false } } };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  ingest.saveState(statePath, { version:1, done:{ 'drive:record':'prior-version' }, skipped:{}, sync_token:'prior-page',
    credential_scanner_fingerprint:credentialScannerFingerprint(true) });
  const file = { id:'record',name:'record.txt',mimeType:'text/plain',parents:['reviewed'] };
  let feedReads = 0, chunkWrites = 0, interruptions = 0;
  const connector = {
    FOLDER_MIME:'application/vnd.google-apps.folder', driveVersion:()=> 'next-version',
    startPageToken:async()=> { throw new Error('unexpected reseed'); },
    listChangePage:async(_get,token)=> { feedReads++; return { changes:token==='prior-page'?[{ fileId:file.id,file }]:[],nextToken:'next-page',terminal:true }; },
    getFileMetadata:async()=>file, isPermanentFileFailure:()=>false,
    changeScope:async()=>({ inScope:true,rootIds:['reviewed'],folders:{} }), folderPathFor:()=>'', exclusionReason:()=>null,
    toEnvelope:async()=>({ envelope:f.envelope(newText),version:'next-version' }),
  };
  const options = { drive:connector, ingestLib:async()=>ingest, getAccessToken:async()=>randomBytes(16).toString('hex'),
    resolveBaseUrl:async()=> 'https://owner.invalid', resolveAdminKey:()=>readFileSync(keyPath,'utf8'),
    withSourceIngestLock:async(_input,run)=>run({ assertOwned(){} }),
    launchctl, driveNow:()=>Date.parse('2026-11-01T00:00:00.000Z'), write:()=>{},
    applyDriveRemovals:async()=>{ throw new Error('automatic removal reached'); },
  };
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(new URL(request.url).origin, 'https://owner.invalid', 'only in-memory Worker transport');
    return worker.fetch(request, f.env, { waitUntil(){} });
  };
  t.after(()=>{ globalThis.fetch = savedFetch; });
  f.setFault(sql => {
    if (/INSERT INTO chunks/.test(sql) && ++chunkWrites === 2) { interruptions++; return true; }
    return false;
  });
  assert.equal((await cmdIngestRemote(manifest, manifestPath, { from:'drive' }, options)).complete,false);
  assert.equal(interruptions, 1, 'real writer fault reached through CLI');
  assert.ok(f.text() === accepted, 'complete accepted revision survives the failed CLI run');
  const failedState = ingest.loadState(statePath, { strict:true });
  assert.equal(failedState.sync_token, 'next-page');
  assert.equal(failedState.drive_change_page, undefined);
  assert.equal(failedState.drive_failures['drive:record'].code,'ingest_write_failed');
  assert.equal(failedState.done['drive:record'], 'prior-version');
  f.setFault(()=>false);
  const resumed = await cmdIngestRemote(manifest, manifestPath, { from:'drive' }, options);
  assert.equal(resumed.updated, 1, 'successful composed resume control');
  assert.equal(feedReads, 2, 'settled page plus quiet check; the durable identity is retried without reseeding');
  assert.equal(ingest.loadState(statePath, { strict:true }).sync_token, 'next-page');
  assert.ok(!f.calls.some(sql=>/DELETE FROM (?:documents|chunks)/.test(sql)));
});

// R3 exercises the real CLI, checkpoint loader, sender, receipt handler and D1
// writer together. A metadata-only double is the sole provider substitution.
async function driveFeedFixture(t, f, ids) {
  const { cmdIngestRemote, credentialScannerFingerprint } = await import('../../brain.mjs');
  const ingest = await import('../../ingest/run.mjs');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(process.env.HOME, 'r3-feed-'));
  const manifestPath = join(directory, 'manifest.json'), statePath = join(directory, '.brain-ingest-drive.json');
  const keyPath = join(directory, '.brain-admin-key'), launchctl = join(directory, 'launchctl-fixture');
  writeFileSync(keyPath, f.env.ADMIN_KEY, { mode:0o600 });
  writeFileSync(launchctl, '#!/bin/sh\nexit 99\n', { mode:0o700 });
  const manifest = { brain:{ domain:'owner.invalid' }, corpora:{ google_drive:{ enabled:true,root_folder_ids:['reviewed'] } },
    safety:{ credential_scanner:{ enabled:true }, ocr:{ enabled:false } } };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  ingest.saveState(statePath, { version:1, done:{ 'drive:record':'prior-version' }, skipped:{}, sync_token:'prior-page',
    credential_scanner_fingerprint:credentialScannerFingerprint(true) });
  const files = new Map(ids.map(id => [id, { id,name:`${id}.txt`,mimeType:'text/plain',parents:['reviewed'] }]));
  let feeds = 0, preparations = 0;
  const messages = [];
  const connector = {
    FOLDER_MIME:'application/vnd.google-apps.folder', driveVersion:()=> 'next-version',
    startPageToken:async()=> { throw new Error('unexpected reseed'); },
    listChangePage:async(_get, token)=> { feeds++; return token === 'prior-page'
      ? { changes:ids.map(id => ({ fileId:id,file:files.get(id) })),nextToken:'next-page',terminal:true }
      : { changes:[],nextToken:token,terminal:true }; },
    getFileMetadata:async(_get,id)=>files.get(id), isPermanentFileFailure:()=>false,
    changeScope:async()=>({ inScope:true,rootIds:['reviewed'],folders:{} }), folderPathFor:()=>'', exclusionReason:()=>null,
    toEnvelope:async(_get,file)=> { preparations++; return {
      envelope:{ ...f.envelope(`Current evidence for ${file.id}.`),source_id:file.id },version:'next-version' }; },
  };
  const options = { drive:connector, ingestLib:async()=>ingest, getAccessToken:async()=>randomBytes(16).toString('hex'),
    resolveBaseUrl:async()=> 'https://owner.invalid', resolveAdminKey:()=>readFileSync(keyPath,'utf8'),
    withSourceIngestLock:async(_input,run)=>run({ assertOwned(){} }), launchctl,
    driveNow:()=>Date.parse('2026-11-01T00:00:00.000Z'), write:s=>messages.push(s),
    applyDriveRemovals:async()=>{ throw new Error('automatic removal reached'); },
  };
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(new URL(request.url).origin, 'https://owner.invalid');
    return worker.fetch(request, f.env, { waitUntil(){} });
  };
  t.after(()=>{ globalThis.fetch = savedFetch; });
  return { options, connector, messages, statePath, manifest,
    saveState:value=>ingest.saveState(statePath,value),
    counts:()=>({ feeds,preparations }), state:()=>ingest.loadState(statePath,{ strict:true }),
    run:flags=>cmdIngestRemote(manifest,manifestPath,{ from:'drive',...flags },options) };
}

function addLegacyChunks(f, count) {
  f.db.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<?1)
    INSERT INTO chunks(chunk_uid,doc_uid,chunk_ix,text,source)
    SELECT 'drive:record#'||i,'drive:record',i,'Accepted legacy section '||i,'drive' FROM n`).run(count - 1);
}

test('DRIVE-R7: storage admission and transient failures return distinct safe codes and retry classes', async t => {
  const f = fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); });
  assert.equal((await f.ingest(f.envelope('Accepted legacy evidence.'))).created,1);
  addLegacyChunks(f,513);
  const before = f.calls.length;
  const limited = await f.ingest(f.envelope('Replacement evidence.'));
  assert.ok(f.calls.slice(before).some(sql=>/physical_chunk_count/.test(sql)), 'real admission decision reached');
  assert.equal(limited.results[0].code,'retained_prior_revision_limit');
  assert.equal(limited.results[0].retryable,false);
  assert.equal(limited.results[0].retry_class,'owner_recovery');
  let faults = 0;
  f.setFault(sql=>{ if (/INSERT INTO retained_ingest_stages/.test(sql)) { faults++; return true; } return false; });
  const temporary = await f.ingest({ ...f.envelope('Transient write evidence.'),source_id:'temporary' });
  assert.equal(faults,1,'transient storage decision reached');
  assert.equal(temporary.results[0].code,'ingest_write_failed');
  assert.equal(temporary.results[0].retryable,true);
  assert.equal(temporary.results[0].retry_class,'retry');
  f.setFault(()=>false);
  assert.equal((await f.ingest({ ...f.envelope('Accepted control.'),source_id:'control' })).created,1);
});

// R4 keeps the provider boundary synthetic while using the real connector,
// including HTTP error classification, scope resolution and content extraction.
async function realDriveFeed(t, f, ids = ['record','addition']) {
  const drive = await import('../../connectors/google-drive.mjs');
  const h = await driveFeedFixture(t,f,ids);
  const stamp = '2026-11-01T00:00:00.000Z';
  const files = new Map(ids.map(id=>[id,{ id,name:`${id}.txt`,mimeType:'text/plain',
    parents:['reviewed'],modifiedTime:stamp }]));
  files.set('reviewed',{ id:'reviewed',name:'Reviewed',mimeType:drive.FOLDER_MIME,parents:[] });
  const calls=[], faults=new Map(), pages=new Map();
  const content='The owner approved this synthetic project record. The next review checks the accepted evidence and the current plan. This source records the decision and the supporting facts for that review.';
  const opts={ attempts:1,fetchImpl:async input=>{
    const url=new URL(input), id=decodeURIComponent(url.pathname.split('/').at(-1));
    const media=url.searchParams.get('alt')==='media', token=url.searchParams.get('pageToken');
    calls.push({ id,media,token });
    if (faults.get(id)==='transport') throw new Error('synthetic provider transport failure');
    if (faults.has(id)) {
      const {status,reason}=faults.get(id);
      return Response.json({error:{message:'Synthetic provider failure',errors:[{reason}]}},{status});
    }
    if (id==='changes') return Response.json(pages.get(token) || (token==='prior-page'
      ? {changes:ids.map(fileId=>({fileId,file:files.get(fileId)})),newStartPageToken:'next-page'}
      : {changes:[],newStartPageToken:token}));
    assert.notEqual(id,'startPageToken','a held retry never reseeds');
    assert.notEqual(id,'files','no provider full walk');
    assert.ok(files.has(id),'only explicit fixture metadata may be read');
    return media ? new Response(content) : Response.json(files.get(id));
  }};
  h.options.drive=new Proxy(drive,{get(target,name){
    if (['getFileMetadata','startPageToken'].includes(name)) return (...args)=>target[name](...args,opts);
    if (name==='listChangePage') return (get,token,config)=>target[name](get,token,{...config,...opts});
    if (name==='changeScope') return (get,file,config)=>target[name](get,file,{...config,opts});
    if (name==='toEnvelope') return (get,file,config)=>target[name](get,file,config,opts);
    return target[name];
  }});
  return {...h,drive,files,calls,faults,pages,content,opts};
}

const latestDriveReceipt=f=>f.db.prepare("SELECT * FROM sync_runs WHERE source='drive' AND finished_at IS NOT NULL ORDER BY rowid DESC LIMIT 1").get();
const noDriveDelete=f=>assert.ok(!f.calls.some(sql=>/DELETE FROM (?:documents|chunks)/.test(sql)),'no automatic deletion');

for (const [status,reason] of [[404,'notFound'],[403,'insufficientFilePermissions']])
test(`DRIVE-R8: permanent ancestor ${status} is a durable scope skip before a later accepted file`,async t=>{
  const f=fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); });
  assert.equal((await f.ingest(f.envelope('Previously accepted evidence.'))).created,1);
  const before=f.text(), h=await realDriveFeed(t,f);
  h.files.get('record').parents=['unavailable']; h.faults.set('unavailable',{status,reason});
  let error; const result=await h.run().catch(e=>{error=e;});
  assert.ok(h.calls.some(c=>c.id==='unavailable'),'real ancestor request reached');
  assert.equal(error,undefined,'file-specific ancestor failure must settle without blocking the page');
  assert.equal(h.calls.some(c=>c.id==='record'&&c.media),false,'unproved scope never downloads');
  assert.equal(result.created,1,'accessible later-file control'); assert.equal(result.complete,false);
  assert.equal(h.state().sync_token,'next-page'); assert.equal(f.text(),before);
  const held=h.state().drive_failures['drive:record'];
  assert.equal(held.code,'ancestor_unavailable'); assert.equal(held.retryable,false);
  assert.equal(held.version,h.drive.driveVersion(h.files.get('record'),''));
  assert.equal(h.state().done['drive:record'],'prior-version');
  await h.run(); assert.deepEqual(h.state().drive_failures['drive:record'],held,'reason/version survive a quiet restart');
  assert.equal(latestDriveReceipt(f).error==='INGEST_FAILED',true); noDriveDelete(f);
});

test('DRIVE-R8: accessible ancestors accept the replacement through the real connector',async t=>{
  const f=fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); });
  assert.equal((await f.ingest(f.envelope('Previously accepted evidence.'))).created,1);
  const h=await realDriveFeed(t,f);
  h.files.get('record').parents=['child'];
  h.files.set('child',{id:'child',name:'Child',mimeType:h.drive.FOLDER_MIME,parents:['reviewed']});
  const result=await h.run(); assert.ok(h.calls.some(c=>c.id==='child'),'ancestor decision reached');
  assert.equal(result.updated,1); assert.equal(result.created,1); assert.ok(f.text().includes(h.content));
  assert.equal(h.state().sync_token,'next-page'); noDriveDelete(f);
});

for (const fault of [{status:503,reason:'backendError'},{status:403,reason:'accessNotConfigured'},
  {status:401,reason:'authError'},'transport'])
test(`DRIVE-R8: ancestor ${typeof fault==='string'?fault:fault.reason} holds the page and recovers`,async t=>{
  const f=fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); }); const h=await realDriveFeed(t,f);
  h.files.get('record').parents=['child']; h.faults.set('child',fault);
  await assert.rejects(h.run());
  assert.ok(h.calls.some(c=>c.id==='child'),'unsafe ancestor error decision reached');
  assert.equal(h.calls.some(c=>c.media),false); assert.equal(h.state().sync_token,'prior-page');
  assert.equal(h.state().drive_change_page.offset,0); assert.equal(h.state().drive_failures['drive:record'].retryable,true);
  h.faults.delete('child'); h.files.set('child',{id:'child',name:'Child',mimeType:h.drive.FOLDER_MIME,parents:['reviewed']});
  assert.equal((await h.run()).created,2,'recovery accepts both files from the saved page');
  assert.equal(h.state().sync_token,'next-page'); assert.deepEqual(h.state().drive_failures,{}); noDriveDelete(f);
});

test('DRIVE-R8: the reached 100-ancestor bound is a visible skip and preserves accepted text',async t=>{
  const f=fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); });
  assert.equal((await f.ingest(f.envelope('Previously accepted deep evidence.'))).created,1);
  const before=f.text(), h=await realDriveFeed(t,f); h.files.get('record').parents=['parent-0'];
  for(let i=0;i<=100;i++) h.files.set(`parent-${i}`,{id:`parent-${i}`,name:'Parent',mimeType:h.drive.FOLDER_MIME,
    parents:[i===100?'reviewed':`parent-${i+1}`]});
  let error; const result=await h.run().catch(e=>{error=e;});
  assert.equal(h.calls.filter(c=>c.id.startsWith('parent-')).length,100,'depth decision reached at the unchanged bound');
  assert.equal(error,undefined,'depth admission cannot monopolize the feed');
  assert.equal(h.calls.some(c=>c.id==='record'&&c.media),false); assert.equal(f.text(),before);
  assert.equal(h.state().drive_failures['drive:record'].code,'ancestor_depth_limit');
  assert.equal(h.state().drive_failures['drive:record'].retryable,false);
  assert.equal(h.state().sync_token,'next-page'); assert.equal(result.created,1,'later shallow-file control');
  assert.equal(result.complete,false); assert.ok(latestDriveReceipt(f).docs_failed>0); noDriveDelete(f);
});

test('DRIVE-R9: a same-identity single-part update and quiet check both complete with exact family readback',async t=>{
  const {describeLoadResult}=await import('../../brain.mjs');
  const f=fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); });
  assert.equal((await f.ingest(f.envelope('Previously accepted single-part evidence.'))).created,1);
  const h=await realDriveFeed(t,f,['record']);
  const result=await h.run();
  assert.equal(result.updated,1,'retained update writer reached'); assert.equal(result.feed_caught_up,true,'completion decision reached');
  assert.equal(result.complete,true,'ordinary single-part update is complete');
  assert.equal(describeLoadResult(result).refreshSucceeded,true,'load reports a successful refresh');
  assert.ok(f.text().includes(h.content));
  assert.ok(f.db.prepare('SELECT prior_chunks FROM retained_ingest_stages').all().some(r=>r.prior_chunks.includes('Previously accepted single-part evidence')));
  assert.deepEqual(h.state().drive_pending_removals,{}); assert.deepEqual(h.state().ingest_pending_families,{});
  assert.equal(latestDriveReceipt(f).error,null); assert.equal(latestDriveReceipt(f).provider_check_complete,1);
  const quiet=await h.run(); assert.equal(quiet.complete,true); assert.equal(describeLoadResult(quiet).refreshSucceeded,true);
  assert.equal(latestDriveReceipt(f).error,null);
  assert.ok(f.calls.some(sql=>/drive_family_base/.test(sql)),'bounded family readback decision reached'); noDriveDelete(f);
});

test('DRIVE-R9: a real obsolete family holds an accepted update and a failed readback never clears it',async t=>{
  const f=fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); }); const h=await realDriveFeed(t,f,['record']);
  assert.equal((await f.ingest(f.envelope('Previously accepted family base.'))).created,1);
  assert.equal((await f.ingest({...f.envelope('Previously accepted family part.'),source_id:'record#part1of2',
    metadata:{brain_retained_ingest:1,part_of:'record',part:1,part_count:2}})).created,1);
  const result=await h.run(); assert.equal(result.updated,1,'replacement writer reached');
  assert.ok(f.calls.some(sql=>/drive_family_base/.test(sql)),'real family readback reached');
  assert.equal(result.complete,false); assert.equal(h.state().drive_pending_removals['drive:record'].reason,'replacement_family_needs_review');
  assert.equal(latestDriveReceipt(f).error,'SAFETY_REVIEW_REQUIRED');
  let faults=0;
  f.setFault(sql=>{ if(/drive_family_base/.test(sql)) {faults++; return true;} return false; });
  assert.equal((await h.run()).complete,false); assert.equal(faults,1,'failed readback decision reached');
  assert.ok(h.state().drive_pending_removals['drive:record']);
  f.setFault(()=>false); assert.equal((await h.run()).complete,false,'successful read still observes the real part');
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM documents WHERE doc_uid='drive:record#part1of2'").get().n,1); noDriveDelete(f);
});

test('DRIVE-R9: exact family endpoint is owner-only, bounded and fails closed on foreign or malformed identity',async t=>{
  const f=fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); });
  assert.equal((await f.ingest(f.envelope('Accepted base.'))).created,1);
  const request=async(body,key=f.env.ADMIN_KEY)=>worker.fetch(new Request('https://owner.invalid/api/admin/brain/drive-family',
    {method:'POST',headers:{'Content-Type':'application/json','X-Admin-Key':key},body:JSON.stringify(body)}),f.env,{});
  const body={source:'drive',file_id:'record'};
  assert.equal((await request(body,randomBytes(32).toString('hex'))).status,401);
  assert.equal(f.calls.some(sql=>/drive_family_base/.test(sql)),false,'unauthorized request never reaches private read');
  for(const invalid of [{...body,extra:true},{...body,file_id:' record'}, {...body,file_id:'record#part1of2'},
    {...body,file_id:'x'.repeat(1100)}]) assert.equal((await request(invalid)).status,400);
  assert.equal((await (await request(body)).json()).same_identity_single_part,true,'authorized exact identity control');
  assert.equal((await (await request({...body,file_id:'absent'})).json()).same_identity_single_part,false);
  assert.equal((await (await request({...body,source:'other'})).json()).same_identity_single_part,false);
  const originalMeta=f.db.prepare("SELECT meta FROM documents WHERE doc_uid='drive:record'").get().meta;
  f.db.prepare("UPDATE documents SET meta=? WHERE doc_uid='drive:record'").run(JSON.stringify({part_of:0}));
  assert.equal((await (await request(body)).json()).same_identity_single_part,false,'malformed family provenance cannot prove absence');
  f.db.prepare("UPDATE documents SET meta=? WHERE doc_uid='drive:record'").run(originalMeta);
  f.db.exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<2000)
    INSERT INTO documents(doc_uid,source,source_id,ingested_at,content_hash,meta)
    SELECT 'drive:record#part'||i||'of2000','drive','record#part'||i||'of2000',1,'fixture','{}' FROM n`);
  assert.equal((await (await request(body)).json()).same_identity_single_part,false,'even ambiguous old parts hold coverage');
  const reads=f.calls.filter(sql=>/drive_family_base/.test(sql));
  assert.equal(reads.length,5,'all authorized family decisions reached');
  assert.ok(reads.every(sql=>(sql.match(/LIMIT 1/g)||[]).length===2),'one base and one candidate, independent of family size');
  assert.ok(!f.plans.flat().some(plan=>/SCAN (?:documents|chunks)\b/.test(plan)),'PK and range seeks do not scan a family or source');
  noDriveDelete(f);
});

for (const obsolete of [false,true])
test(`DRIVE-R9: quiet restart ${obsolete?'retains real obsolete-part':'clears an existing false'} hold after exact readback`,async t=>{
  const f=fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); }); const h=await realDriveFeed(t,f,['record']);
  assert.equal((await f.ingest(f.envelope(h.content))).created,1);
  if (obsolete) assert.equal((await f.ingest({...f.envelope('Accepted obsolete part.'),source_id:'record#part1of2',
    metadata:{brain_retained_ingest:1,part_of:'record',part:1,part_count:2}})).created,1);
  // Earn the exact accepted-version proof through the paired CLI. A hand-made
  // done hash alone is deliberately insufficient after database recovery.
  await h.run();
  assert.ok(h.state().drive_accepted_parts['drive:record'].parts.length);
  h.calls.length=0;
  const state=h.state(), version=h.drive.driveVersion(h.files.get('record'),'Reviewed');
  state.sync_token='next-page'; state.done['drive:record']=version;
  state.drive_pending_removals={'drive:record':{id:'record',reason:'replacement_family_needs_review'}};
  state.ingest_pending_families={'drive:record':{stateKey:'drive:record',hash:version,
    family:{base_doc_uid:'drive:record',keep_doc_uids:['drive:record'],family_kind:'structural'}}};
  h.saveState(state);
  const result=await h.run(); assert.equal(result.feed_caught_up,true,'quiet completion reached');
  assert.ok(f.calls.some(sql=>/drive_family_base/.test(sql)),'real exact family readback reached');
  assert.equal(result.complete,!obsolete);
  assert.equal(Boolean(h.state().drive_pending_removals['drive:record']),obsolete);
  assert.equal(Boolean(h.state().ingest_pending_families['drive:record']),obsolete);
  assert.equal(latestDriveReceipt(f).error===null,!obsolete);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM documents WHERE doc_uid='drive:record#part1of2'").get().n,obsolete?1:0);
  assert.equal(h.calls.some(c=>c.media),false,'unchanged current identity needs no content download'); noDriveDelete(f);
});

test('DRIVE-R10: eleven held identities rotate durably across an interrupted retry and bounded later feed work',async t=>{
  const f=fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); });
  const ids=Array.from({length:11},(_,i)=>`held-${String(i).padStart(2,'0')}`), h=await realDriveFeed(t,f,ids);
  for(const id of ids) h.files.get(id).mimeType='image/png';
  assert.equal((await h.run()).skipped,11,'all eleven permanent decisions reached');
  const holds=h.state().drive_failures;
  h.files.get(ids[10]).mimeType='text/plain';
  h.files.set('later',{id:'later',name:'later.txt',mimeType:'text/plain',parents:['reviewed'],modifiedTime:'2026-11-01T00:00:00.000Z'});
  h.pages.set('next-page',{changes:[{fileId:'later',file:h.files.get('later')}],newStartPageToken:'later-page'});
  const first=await h.run({reset:true,limit:3}); assert.ok(first.scanned<=3);
  assert.equal(first.created,1,'retry budget reserves later feed progress');
  // Retry transport faults are now fail-local. Interrupt at the durable
  // checkpoint instead, preserving the original restart/fairness assertions.
  const ingest = await import('../../ingest/run.mjs'); let stopped = 0;
  h.options.ingestLib = async()=>({...ingest,saveState:(path,state)=>{
    ingest.saveState(path,state);
    if (state.drive_retry_after === `drive:${ids[2]}` && state.drive_failures?.[`drive:${ids[2]}`]?.retryable === true && stopped++ === 0)
      throw new Error('synthetic retry checkpoint interruption');
  }});
  h.faults.set(ids[2],'transport'); await assert.rejects(h.run({reset:true,limit:3}),/checkpoint interruption/);
  assert.ok(stopped>0,'durable retry checkpoint interruption reached');
  h.options.ingestLib = async()=>ingest;
  assert.ok(h.calls.some(c=>c.id===ids[2]),'interruption decision reached');
  const cursor=h.state().drive_retry_after; assert.equal(cursor,`drive:${ids[2]}`,'retry position checkpointed before interrupted attempt');
  const interrupted=h.state().drive_failures[`drive:${ids[2]}`];
  assert.equal(interrupted.version,holds[`drive:${ids[2]}`].version,'transient retry retains the original held version');
  assert.equal(interrupted.prior_skip.code,holds[`drive:${ids[2]}`].code,'transient retry retains the original permanent explanation');
  h.faults.delete(ids[2]);
  const start=h.calls.length;
  for(let i=0;i<7&&!h.state().done[`drive:${ids[10]}`];i++) {
    const result=await h.run({reset:true,limit:3}); assert.ok(result.scanned<=3,'each retry obeys total file budget');
  }
  assert.ok(h.state().done[`drive:${ids[10]}`],'repaired eleventh identity eventually accepted');
  assert.equal(h.calls.slice(start).find(c=>c.id.startsWith('held-')).id,ids[3],'restart does not repeat the failed prefix');
  assert.equal(Object.keys(h.state().drive_failures).length,10,'permanent held entries are never erased');
  for(const id of ids.slice(0,10)) {
    const held=h.state().drive_failures[`drive:${id}`]; assert.ok(held);
    assert.ok(h.calls.filter(c=>c.id===id&&!c.media).length>=2,'every held identity reaches a retry');
    assert.equal(held.version,holds[`drive:${id}`].version);
    if(id!==ids[2]) assert.equal(held.code,holds[`drive:${id}`].code);
  }
  assert.equal(h.state().sync_token,'later-page'); assert.equal(latestDriveReceipt(f).error,'INGEST_FAILED'); noDriveDelete(f);
});

test('DRIVE-R10: a one-entry retry accepts the repair without reseeding or erasing other state',async t=>{
  const f=fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); }); const h=await realDriveFeed(t,f,['record']);
  h.files.get('record').mimeType='image/png'; assert.equal((await h.run()).skipped,1);
  h.files.get('record').mimeType='text/plain';
  const result=await h.run({reset:true}); assert.equal(result.created,1,'repaired retry writer reached');
  assert.equal(result.complete,true); assert.equal(h.state().sync_token,'next-page');
  assert.deepEqual(h.state().drive_failures,{}); noDriveDelete(f);
});

test('DRIVE-R10: the one-item budget alternates a real held family and later feed work across restarts',async t=>{
  const f=fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); }); const h=await realDriveFeed(t,f,['record']);
  assert.equal((await f.ingest({...f.envelope('Accepted family part.'),source_id:'record#part1of2',
    metadata:{brain_retained_ingest:1,part_of:'record',part:1,part_count:2}})).created,1);
  assert.equal((await h.run()).complete,false,'real obsolete family control reached');
  const addition={id:'later',name:'later.txt',mimeType:'text/plain',parents:['reviewed'],modifiedTime:'2026-11-01T00:00:00.000Z'};
  h.files.set(addition.id,addition);
  h.pages.set('next-page',{changes:[{fileId:addition.id,file:addition}],newStartPageToken:'later-page'});
  const reviews=f.calls.filter(sql=>/drive_family_base/.test(sql)).length;
  const first=await h.run({limit:1}); assert.equal(first.scanned,1);
  assert.equal(f.calls.filter(sql=>/drive_family_base/.test(sql)).length,reviews+1,'held-family review decision reached');
  const second=await h.run({limit:1}); assert.equal(second.scanned,1);
  assert.equal(second.created,1,'the following single-slot run reaches later feed work');
  assert.equal(h.state().sync_token,'later-page'); assert.equal(second.complete,false);
  assert.ok(h.state().drive_pending_removals['drive:record'],'real hold is never erased for progress'); noDriveDelete(f);
});

test('R3 shared finalizer keeps the shipped Gmail bounded retry decision reachable', async t=>{
  const f=fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); });
  const { retryIngestFinalization }=await import('../../operations/ingest-finalization-retry.mjs');
  const envelope=f.envelope('Accepted mail evidence.','gmail'); delete envelope.metadata.brain_retained_ingest;
  let faults=0,retries=0,sends=0;
  f.setFault(sql=>{ if (/WITH candidates/.test(sql) && faults++===0) return true; return false; });
  const response=await retryIngestFinalization({ docs:[envelope],
    send:async()=>{ sends++; const body=await f.ingest(envelope); const raw=JSON.stringify(body);
      return {res:new Response(raw,{status:200}),raw}; },
    validate:body=>body.results,sleep:async()=>{retries++;} });
  assert.ok(faults>0,'real shared finalization fault reached');
  assert.equal(retries,1,'temporary finalization still gets its bounded retry');
  assert.equal(sends,2); assert.equal(JSON.parse(response.raw).failed,0,'successful mail control');
});

test('DRIVE-R6: owner-scale CLI feed advances past 513 retained chunks, preserves the skip and accepts later changes', async t => {
  const f = fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); });
  assert.equal((await f.ingest(f.envelope('Accepted legacy evidence.'))).created,1);
  addLegacyChunks(f,513);
  const old = f.text();
  f.db.exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<61600)
    INSERT INTO documents(doc_uid,source,source_id,ingested_at,content_hash,meta)
    SELECT 'drive:bulk-'||i,'drive','bulk-'||i,1,'fixture','{}' FROM n`);
  assert.equal((await f.ingest({ ...f.envelope('Prior small evidence.'),source_id:'small' })).created,1);
  const h = await driveFeedFixture(t,f,['record','small','addition']);
  const before = f.calls.length;
  const result = await h.run();
  assert.ok(f.calls.slice(before).some(sql=>/physical_chunk_count/.test(sql)), 'real admission decision reached');
  assert.equal(h.counts().preparations,3,'later small-update and addition controls reached');
  assert.equal(result.created,1); assert.equal(result.updated,1); assert.equal(result.skipped,1);
  assert.equal(result.complete,false); assert.equal(result.feed_caught_up,true);
  const state = h.state(), held = state.drive_failures['drive:record'];
  assert.equal(state.sync_token,'next-page'); assert.equal(state.drive_change_page,undefined);
  assert.equal(state.done['drive:record'],'prior-version');
  assert.equal(held.code,'retained_prior_revision_limit'); assert.equal(held.retryable,false);
  assert.equal(held.retry_class,'owner_recovery'); assert.equal(held.version,'next-version');
  assert.match(held.reason,/bounded.*revision|snapshot limit/);
  assert.match(state.skipped['drive:record'],/bounded.*revision|snapshot limit/);
  assert.equal(f.text(),old,'all 513 accepted chunks remain byte-identical');
  assert.equal(f.db.prepare("SELECT status FROM sources WHERE name='drive'").get().status,'error','skipped evidence cannot certify source completeness');
  assert.ok(f.db.prepare("SELECT docs_failed FROM sync_runs WHERE source='drive' AND finished_at IS NOT NULL ORDER BY rowid DESC LIMIT 1").get().docs_failed>0);
  assert.ok(!f.calls.slice(before).some(sql=>/DELETE FROM (?:documents|chunks)/.test(sql)));
  assert.ok(!f.plans.flat().some(plan=>/SCAN (?:documents|chunks)\b/.test(plan)), 'unrelated corpus never scanned');
  assert.equal((await h.run()).scanned,0,'ordinary next run progresses without retrying deterministic skip');
  assert.equal(f.db.prepare("SELECT status FROM sources WHERE name='drive'").get().status,'error','quiet check cannot clear a retained gap');
  assert.equal(h.state().drive_failures['drive:record'].code,held.code,'skip survives repeated runs');
  const later={ id:'later',name:'later.txt',mimeType:'text/plain',parents:['reviewed'] };
  const metadata=h.connector.getFileMetadata;
  h.connector.getFileMetadata=async(get,id)=>id===later.id?later:metadata(get,id);
  h.connector.listChangePage=async(_get,token)=>{
    assert.equal(token,'next-page','later provider changes use the advanced token');
    return {changes:[{fileId:later.id,file:later}],nextToken:'later-page',terminal:true};
  };
  assert.equal((await h.run()).created,1,'later provider changes remain reachable on another run');
  assert.equal(h.state().sync_token,'later-page');
  assert.equal(h.state().drive_failures['drive:record'].code,held.code);
  h.options.resolveAdminKey=()=>{ throw new Error('status reached credentials'); };
  await h.run({ status:true });
  assert.match(h.messages.at(-1),/Skipped items: 1/);
  assert.match(h.messages.at(-1),/owner_recovery.*bounded|bounded.*owner_recovery/);
  assert.match(h.messages.at(-1),/version next-version/);
});

test('DRIVE-R7: transient part reason survives real sender and checkpoint, then successful replay clears it', async t => {
  const f = fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); });
  const h = await driveFeedFixture(t,f,['record','addition']);
  let faults=0;
  f.setFault(sql=>{ if (/INSERT INTO retained_ingest_stages/.test(sql) && faults===0) { faults++; return true; } return false; });
  const partial=await h.run();
  assert.equal(partial.complete,false); assert.equal(partial.created,1,'healthy suffix accepted during writer fault');
  assert.equal(faults,1,'real transient writer decision reached');
  const state=h.state(), held=state.drive_failures['drive:record'];
  assert.equal(state.sync_token,'next-page'); assert.equal(state.drive_change_page,undefined);
  assert.equal(held.code,'ingest_write_failed'); assert.equal(held.retry_class,'retry'); assert.equal(held.retryable,true);
  assert.match(held.reason,/write failed/); assert.doesNotMatch(held.reason,/not all accepted/);
  assert.equal(held.parts[0].code,'ingest_write_failed');
  f.setFault(()=>false);
  assert.equal((await h.run()).created,1,'ordinary retry repairs the failed writer identity');
  assert.equal(h.counts().feeds,2); assert.equal(h.state().sync_token,'next-page');
  assert.deepEqual(h.state().drive_failures,{});
});

test('DRIVE-R6: interruption after durable skip but before page settlement replays safely and recovers on a later valid update', async t => {
  const f=fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); });
  assert.equal((await f.ingest(f.envelope('Accepted legacy evidence.'))).created,1);
  addLegacyChunks(f,513); const old=f.text();
  const h=await driveFeedFixture(t,f,['record','addition']);
  const ingest=await import('../../ingest/run.mjs');
  let stopped=0;
  h.options.ingestLib=async()=>({ ...ingest, saveState:(path,state)=>{
    ingest.saveState(path,state);
    if (state.drive_failures?.['drive:record']?.retryable===false && state.drive_change_page?.offset===0 && stopped++===0)
      throw new Error('synthetic checkpoint interruption');
  } });
  await assert.rejects(h.run(),/checkpoint interruption/);
  assert.ok(stopped>0,'post-skip checkpoint fault reached'); assert.equal(f.text(),old);
  assert.equal(h.state().sync_token,'prior-page'); assert.equal(h.state().drive_change_page.offset,0);
  h.options.ingestLib=async()=>ingest;
  assert.equal((await h.run()).created,1,'later addition succeeds after interruption');
  assert.equal(h.state().sync_token,'next-page'); assert.equal(f.text(),old);
  // A subsequent supported update is a recovery control. No fixture chunk is
  // deleted to evade the limit; the owner supplies a new, bounded file revision.
  h.connector.listChangePage=async()=>({ changes:[{ fileId:'addition',file:{ id:'addition' } }],nextToken:'recovered-page',terminal:true });
  h.connector.driveVersion=()=> 'recovered-version';
  h.connector.toEnvelope=async(_get,file)=>({ envelope:{ ...f.envelope('Recovered readable evidence.'),source_id:file.id },version:'recovered-version' });
  assert.equal((await h.run()).updated,1,'supported later revision accepted');
  assert.equal(h.state().sync_token,'recovered-page'); assert.equal(f.text(),old);
});

// R5 probes keep the CLI, real connector, sender, retained store and receipts
// composed. Each request is in-process and every negative has a reached control.
async function obsoleteFamily(t, ids = ['record']) {
  const f = fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); });
  const h = await realDriveFeed(t, f, ids);
  assert.equal((await f.ingest(f.envelope('Accepted prior base evidence.'))).created, 1);
  assert.equal((await f.ingest({ ...f.envelope('Accepted obsolete part evidence.'), source_id:'record#part1of2',
    metadata:{ brain_retained_ingest:1, part_of:'record', part:1, part_count:2 } })).created, 1);
  assert.equal((await h.run()).complete, false, 'real obsolete-family creation reached');
  assert.equal(h.state().drive_pending_removals['drive:record'].reason, 'replacement_family_needs_review');
  assert.ok(f.calls.some(sql => /drive_family_base/.test(sql)), 'real family decision reached');
  return { f, h };
}
function laterFile(h, id = 'later') {
  const file = { id, name:`${id}.txt`, mimeType:'text/plain', parents:['reviewed'], modifiedTime:'2026-11-01T00:00:00.000Z' };
  h.files.set(id, file);
  return { fileId:id, file };
}

for (const limit of [undefined, 3]) for (const fault of ['transport', { status:503, reason:'backendError' }])
test(`DRIVE-R11: automatic held retry ${typeof fault === 'string' ? fault : fault.status} allows later feed at limit ${limit || 'default'}`, async t => {
  const { f, h } = await obsoleteFamily(t);
  const prior = f.text();
  h.faults.set('record', fault);
  const baseline = h.calls.length;
  for (let run = 0; run < 2; run++) {
    const addition = laterFile(h, `later-${run}`), token = run ? 'later-page-0' : 'next-page';
    h.pages.set(token, { changes:[addition], newStartPageToken:`later-page-${run}` });
    let error;
    const result = await h.run(limit ? { limit } : {}).catch(e => { error = e; });
    assert.ok(h.calls.slice(baseline).some(c => c.id === 'record' && !c.media), 'failed metadata retry reached');
    assert.equal(error, undefined, 'one failed held identity cannot abort unrelated feed work');
    assert.equal(result.created, 1, 'later good addition accepted through retained writer');
    assert.equal(result.complete, false);
    assert.equal(result.feed_caught_up, true);
    assert.equal(h.state().sync_token, `later-page-${run}`);
    assert.ok(h.state().drive_pending_removals['drive:record']);
    assert.equal(h.state().drive_failures['drive:record'].retryable, true);
    assert.equal(latestDriveReceipt(f).provider_check_complete, 0, 'source coverage remains incomplete despite feed catch-up');
    assert.ok(latestDriveReceipt(f).docs_failed > 0);
    assert.equal(f.text(), prior, 'accepted base survives repeated fault/restart');
  }
  assert.equal(h.calls.slice(baseline).filter(c => c.id === 'changes').length, 2, 'two independent feed checks reached');
  h.faults.delete('record');
  assert.equal((await h.run()).complete, false, 'healthy-held recovery still sees a genuine obsolete part');
  assert.equal(h.state().drive_failures['drive:record'], undefined, 'recovered metadata clears retry failure only');
  assert.ok(h.state().drive_pending_removals['drive:record']);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM documents WHERE doc_uid='drive:record#part1of2'").get().n, 1);
  noDriveDelete(f);
  t.diagnostic(JSON.stringify({ metadata:h.calls.filter(c=>c.id==='record'&&!c.media).length,
    feed:h.calls.filter(c=>c.id==='changes').length, activation:f.calls.filter(sql=>/INSERT INTO retained_ingest_activations/.test(sql)).length,
    receipts:f.calls.filter(sql=>/INSERT INTO sync_runs/.test(sql)).length }));
});

test('DRIVE-R11: healthy held metadata is a passing later-feed control', async t => {
  const { f, h } = await obsoleteFamily(t);
  h.pages.set('next-page', { changes:[laterFile(h)], newStartPageToken:'later-page' });
  const result = await h.run();
  assert.equal(result.created, 1); assert.equal(result.complete, false);
  assert.ok(h.calls.filter(c => c.id === 'record' && !c.media).length >= 2, 'healthy automatic retry reached');
  assert.ok(h.state().drive_pending_removals['drive:record']); noDriveDelete(f);
});

test('DRIVE-R11: retry time exhaustion durably gives the next ordinary run a feed turn', async t => {
  const { f, h } = await obsoleteFamily(t);
  h.pages.set('next-page', { changes:[laterFile(h)], newStartPageToken:'later-page' });
  h.faults.set('record', { status:503, reason:'backendError' });
  let clock = Date.parse('2026-11-01T00:00:00.000Z');
  h.options.driveNow = () => clock;
  h.options.driveLimits = { timeBudgetMs:10 };
  const connector = h.options.drive;
  h.options.drive = new Proxy(connector, { get(target, key) {
    if (key === 'getFileMetadata') return async (...args) => {
      try { return await target[key](...args); }
      finally { if (args[1] === 'record') clock += 11; }
    };
    return target[key];
  } });
  await h.run().catch(() => {});
  assert.equal(h.calls.filter(c => c.id === 'record' && !c.media).length, 2, 'budget-consuming retry reached');
  const saved = h.state();
  assert.ok(saved.drive_failures['drive:record'], 'failed retry checkpointed');
  const result = await h.run();
  assert.equal(result.created, 1, 'restart reserves execution of feed within its own budget');
  assert.equal(result.complete, false); assert.equal(h.state().sync_token, 'later-page');
  noDriveDelete(f);
});

test('DRIVE-R11: a current-page transport failure remains unsettled and has a successful recovery control', async t => {
  const f = fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); }); const h = await realDriveFeed(t, f, ['record','addition']);
  h.faults.set('record', 'transport');
  await assert.rejects(h.run());
  assert.ok(h.calls.some(c => c.id === 'record'), 'current-page transport decision reached');
  assert.equal(h.state().drive_change_page.offset, 0); assert.equal(h.state().sync_token, 'prior-page');
  assert.equal(latestDriveReceipt(f).provider_check_complete, 0);
  h.faults.delete('record'); assert.equal((await h.run()).created, 2, 'healthy saved-page replay control');
  noDriveDelete(f);
});

test('DRIVE-R11 composed: failed retry, family read, ancestor and admission each permit a later good feed addition', async t => {
  const { f, h } = await obsoleteFamily(t);
  const accepted = f.text();
  const ids = ['family','scope','admission','good'];
  const changes = ids.map(id => laterFile(h, id));
  h.files.get('scope').parents = ['unavailable'];
  h.faults.set('unavailable', { status:404, reason:'notFound' });
  h.faults.set('record', { status:503, reason:'backendError' });
  assert.equal((await f.ingest({ ...f.envelope('Accepted admission evidence.'), source_id:'admission' })).created, 1);
  f.db.exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<512)
    INSERT INTO chunks(chunk_uid,doc_uid,chunk_ix,text,source)
    SELECT 'drive:admission#'||i,'drive:admission',i,'Accepted legacy admission section.','drive' FROM n`);
  const oldAdmission = f.db.prepare("SELECT text FROM chunks WHERE doc_uid='drive:admission' ORDER BY chunk_ix").all();
  let familyReads = 0, familyFailures = 0;
  f.setFault(sql => {
    if (!/drive_family_base/.test(sql)) return false;
    familyReads++;
    if (familyReads === 1) { familyFailures++; return true; }
    return false;
  });
  h.pages.set('next-page', { changes, newStartPageToken:'composed-page' });
  let error; const result = await h.run().catch(e => { error = e; });
  assert.ok(h.calls.filter(c => c.id === 'record' && !c.media).length >= 2, 'retry decision reached');
  assert.equal(error, undefined, 'per-item recovery failure must stay local');
  assert.equal(familyFailures, 1, 'family read failure reached');
  assert.equal(familyReads, 2, 'healthy later-family readback control reached');
  assert.ok(h.calls.some(c => c.id === 'unavailable'), 'ancestor failure reached');
  assert.ok(f.calls.some(sql => /physical_chunk_count/.test(sql)), 'writer admission reached');
  assert.equal(result.created, 2, 'held-family base and independent good addition accepted');
  assert.equal(result.skipped, 4, 'retry, family read, ancestor and admission attempts are all visibly skipped'); assert.equal(result.complete, false); assert.equal(result.feed_caught_up, true);
  assert.equal(h.state().sync_token, 'composed-page');
  assert.ok(h.state().done['drive:good']);
  assert.equal(h.state().drive_failures['drive:record'].retryable, true);
  assert.ok(h.state().drive_pending_removals['drive:record']);
  assert.ok(h.state().drive_pending_removals['drive:family']);
  assert.equal(h.state().drive_failures['drive:scope'].code, 'ancestor_unavailable');
  assert.equal(h.state().drive_failures['drive:admission'].code, 'retained_prior_revision_limit');
  assert.equal(h.calls.some(c => c.id === 'scope' && c.media), false);
  assert.equal(f.text(), accepted);
  assert.deepEqual(f.db.prepare("SELECT text FROM chunks WHERE doc_uid='drive:admission' ORDER BY chunk_ix").all(), oldAdmission);
  assert.equal(latestDriveReceipt(f).provider_check_complete, 0); assert.ok(latestDriveReceipt(f).docs_failed >= 3);
  noDriveDelete(f);
  t.diagnostic(JSON.stringify({ retry:h.calls.filter(c=>c.id==='record'&&!c.media).length-1, familyReads, familyFailures,
    ancestor:h.calls.filter(c=>c.id==='unavailable').length, accepted:result.created, skipped:result.skipped }));
});

test('R5 matrix DRIVE-R1: exact indexed inventory never falls back while its projection is unfinished', async t => {
  const { backfillSourceFamilyIndex } = await import('../src/lib/source-family-index.js');
  const f = fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); });
  assert.equal((await f.ingest(f.envelope('Indexed inventory control.'))).created, 1);
  const request = () => worker.fetch(new Request('https://owner.invalid/api/admin/brain/source-families', {
    method:'POST', headers:{'Content-Type':'application/json','X-Admin-Key':f.env.ADMIN_KEY},
    body:JSON.stringify({source:'drive',uids:['drive:record'],limit:1}),
  }), f.env, {});
  const before = f.calls.length;
  const pending = await request();
  assert.ok(f.calls.slice(before).some(sql=>/SELECT cursor, complete FROM document_family_index_state/.test(sql)), 'projection readiness decision reached');
  assert.equal(pending.status, 503, 'unfinished exact inventory refuses unsafe corpus fallback');
  assert.equal((await pending.json()).code, 'source_family_index_not_ready');
  assert.equal(f.calls.slice(before).some(sql=>/FROM documents\s+WHERE deleted_at/s.test(sql)), false);
  assert.equal((await backfillSourceFamilyIndex(f.env)).complete, true, 'real shipped projection control');
  const queries = [], prepare = f.env.DB.prepare;
  f.env.DB.prepare = sql => {
    const stmt = prepare(sql);
    return { ...stmt, bind:(...values) => {
      if (/FROM document_family_index/.test(sql) && /family_doc_uid IN/.test(sql)) queries.push({sql,values});
      return stmt.bind(...values);
    } };
  };
  const ready = await request(); assert.equal(ready.status, 200);
  assert.deepEqual((await ready.json()).families, ['drive:record']);
  assert.equal(queries.length, 1, 'exact indexed query decision reached');
  assert.deepEqual(queries[0].values, ['drive','',2,'drive:record']);
  assert.match(queries[0].sql, /family_doc_uid IN \(\?4\)/);
  const params = Object.fromEntries(queries[0].values.map((v,i)=>[String(i+1),v]));
  const plan = f.db.prepare(`EXPLAIN QUERY PLAN ${queries[0].sql}`).all(params).map(row=>row.detail);
  assert.ok(plan.some(detail=>/SEARCH document_family_index USING/.test(detail)), 'shipped index seek reached');
  assert.equal(plan.some(detail=>/SCAN (?:documents|chunks|document_family_index)\b/.test(detail)), false);
  noDriveDelete(f); t.diagnostic(JSON.stringify({ readiness:2, exactQueries:queries.length, boundRows:2, plan }));
});

for (const quiet of [false,true])
test(`R5 matrix DRIVE-R4: actual rollback ${quiet ? 'restores a matched disposable pair after verified quiet' : 'blocks unknown writer idle and keeps the pause'}`, async t => {
  const { cmdRollback } = await import('../../brain.mjs');
  const { mkdtempSync, writeFileSync, copyFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { backup } = await import('node:sqlite');
  const ingest = await import('../../ingest/run.mjs');
  const f = fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); });
  const directory = mkdtempSync(join(process.env.HOME, 'r5-rollback-'));
  const manifestPath = join(directory,'manifest.json'), checkpoint = join(directory,'checkpoint.json');
  const snapshot = join(directory,'before.sqlite'), savedCheckpoint = join(directory,'before-checkpoint.json');
  const restoredPath = join(directory,'restored.sqlite');
  const launchctl = join(directory,'launchctl-fixture');
  writeFileSync(launchctl,'#!/bin/sh\nexit 99\n',{mode:0o700});
  writeFileSync(join(directory,'.brain-admin-key'),f.env.ADMIN_KEY,{mode:0o600});
  writeFileSync(manifestPath, JSON.stringify({brain:{domain:'owner.invalid'}, infrastructure:{cloudflare:{
    storage:'d1',account_id:'fixture-account',d1_database_id:'fixture-database',vectorize_index:'fixture-index'}}, operations:{}}));
  assert.equal((await f.ingest(f.envelope('Matched pre-bookmark evidence.'))).created, 1);
  ingest.saveState(checkpoint,{version:1,done:{'drive:record':'accepted'},skipped:{},sync_token:'before-page'});
  copyFileSync(checkpoint,savedCheckpoint); await backup(f.db,snapshot);
  assert.equal((await f.ingest(f.envelope('Retained later-write evidence.'))).updated, 1);
  ingest.saveState(checkpoint,{version:1,done:{'drive:record':'later'},skipped:{},sync_token:'later-page'});
  const laterText = f.text(), laterCheckpoint = readFileSync(checkpoint,'utf8');
  // This restore control starts after confirmed projection completion. The
  // composed guard must still reject a free lease with pending vector work.
  let providerInfo;
  if (quiet) {
    const provider = (await import('../../test/fixtures/vector-fence-env.mjs')).makeEnv();
    t.after(() => provider.db.close());
    f.env.VECTORIZE = provider.env.VECTORIZE;
    const { drainOutbox } = await import('../src/lib/store-d1.js');
    const sent = await drainOutbox(f.env, { now: () => 1, embed: async () => [0.1], disableBootstrapAdvance: true });
    assert.ok(sent.submitted > 0, 'actual projection submission reached');
    while (provider.env._processNextVectorMutation()) {}
    const settled = await drainOutbox(f.env, { now: () => 2, embed: async () => [0.1], disableBootstrapAdvance: true });
    assert.ok(settled.drained > 0, 'actual projection settlement reached');
    providerInfo = await provider.env.VECTORIZE.describe();
  }
  let paused = false, idleReads = 0, restores = 0, readbacks = 0, clock = Date.parse('2026-11-01T00:00:00.000Z');
  let restored;
  const options = {
    confirmed:true, launchctl, resolveAccount:async()=>({id:'fixture-account'}),
    cmdDeploy:async(_path,config)=>{ assert.equal(config.pauseVectorDrainForUpgrade,true); paused = true; },
    cmdHealth:async(_path,config)=>{ assert.equal(paused,true); assert.equal(config.expectDrainMode,'paused-for-upgrade'); },
    now:()=>clock, waitForVectorDrainQuiescence:async ms=>{clock+=ms;},
    dailyRefreshOptions:{platform:'linux'},
    cf:async(path,config)=>{
      if (path.endsWith('/fixture-index/info')) {
        return providerInfo;
      }
      restores++; assert.equal(paused,true); assert.equal(config.method,'POST');
      assert.match(path,/\/fixture-database\/time_travel\/restore\?bookmark=fixture-bookmark$/);
      copyFileSync(snapshot,restoredPath); restored = new DatabaseSync(restoredPath); t.after(()=>restored.close());
      copyFileSync(savedCheckpoint,checkpoint);
    },
    d1Query:async(_account,_database,sql)=>{
      assert.equal(paused,true);
      if (!restores) {
        idleReads++;
        if (!quiet) throw new Error('synthetic writer state unavailable');
        const plans = f.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(row=>row.detail);
        assert.ok(plans.some(detail=>/idx_vector_outbox_submitted/.test(detail)), 'bounded submitted-mutation seek reached');
        assert.ok(/EXISTS\(SELECT 1 FROM vector_outbox\)/.test(sql), 'pending work is checked as well as submitted mutations');
        const submittedPlan = f.db.prepare('EXPLAIN QUERY PLAN SELECT EXISTS(SELECT 1 FROM vector_outbox WHERE submitted_mutation_id IS NOT NULL)').all().map(row=>row.detail);
        assert.equal(submittedPlan.some(detail=>/SCAN vector_outbox\b/.test(detail)),false, 'submitted-mutation proof still uses its bounded index');
        return {results:f.db.prepare(sql).all()};
      }
      if (/SELECT schema_version/.test(sql)) return {results:[{schema_version:65}]};
      if (/SELECT vector_projection_status/.test(sql)) {
        readbacks++;
        return {results:[{status:'bootstrap_required',lease_owner:null,lease_expires_at:null,
          mutation_id:null,mutation_submitted_at:null,cursor:null,high_water:'fixture#0',chunk_high_water:'fixture#0',
          submitted_rows:0,bootstrap_protocol:null,bootstrap_base_count:0,bootstrap_batch_count:0,tagged_rows:0}]};
      }
      return {results:[],meta:{changes:1}};
    },
  };
  let error; const result = await cmdRollback(manifestPath,'fixture-bookmark',options).catch(e=>{error=e;});
  assert.equal(paused,true,'actual paused deployment/health boundary reached');
  assert.ok(idleReads>0,'actual writer-idle decision reached');
  if (!quiet) {
    assert.match(error?.message || '',/quiescence|writer.*(?:unverified|verified)/i);
    assert.equal(restores,0,'unknown idle cannot start a destructive restore');
    assert.equal(readFileSync(checkpoint,'utf8'),laterCheckpoint,'unknown idle preserves later cursor');
  } else {
    assert.equal(error,undefined); assert.equal(result.restored,true); assert.equal(restores,1); assert.equal(readbacks,1);
    assert.equal(ingest.loadState(checkpoint,{strict:true}).sync_token,'before-page');
    assert.equal(restored.prepare("SELECT text FROM chunks WHERE doc_uid='drive:record' LIMIT 1").get().text,
      '[Owner record]\n\nMatched pre-bookmark evidence.');
    assert.equal(restored.prepare('PRAGMA quick_check').get().quick_check,'ok');
  }
  assert.equal(paused,true,'rollback never resumes writers against an unreconciled index');
  assert.equal(f.text(),laterText,'post-bookmark database retained separately');
  t.diagnostic(JSON.stringify({idleReads,restores,readbacks,paused}));
});

test('R5 matrix DRIVE-R3: an unreadable checkpoint artifact reaches strict CLI recovery without reseeding', async t => {
  const { mkdirSync, lstatSync } = await import('node:fs');
  const f = fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); }); const h = await realDriveFeed(t,f,['record']);
  // A directory at the checkpoint path cannot be read as checkpoint bytes on
  // any supported platform, including test users that bypass chmod restrictions.
  const { renameSync } = await import('node:fs');
  renameSync(h.statePath,`${h.statePath}.preserved`); mkdirSync(h.statePath);
  let reached = 0; const ingest = await import('../../ingest/run.mjs');
  h.options.ingestLib = async()=>({...ingest,loadState:(path,config)=>{reached++;return ingest.loadState(path,config);}});
  await assert.rejects(h.run(),/checkpoint.*recovery/i);
  assert.equal(reached,1); assert.equal(lstatSync(h.statePath).isDirectory(),true);
  assert.equal(h.calls.length,0); assert.equal(f.calls.filter(sql=>/INSERT INTO sync_runs/.test(sql)).length,0);
});

test('R5 matrix DRIVE-R5: real CLI checked-empty and partial windows persist distinct measured receipts', async t => {
  const f = fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); }); const h = await realDriveFeed(t,f,['record','addition']);
  assert.equal((await h.run({limit:1})).complete,false,'bounded partial admission reached');
  let receipt = latestDriveReceipt(f);
  assert.equal(receipt.metrics_version,1); assert.equal(receipt.provider_check_complete,0); assert.equal(receipt.walk_complete,0);
  assert.equal((await h.run({limit:1})).complete,true,'saved suffix accepted control');
  const feeds = h.calls.filter(c=>c.id==='changes').length;
  const beforeReceipts = f.calls.filter(sql=>/INSERT INTO sync_runs/.test(sql)).length;
  const quiet = await h.run(); assert.equal(quiet.scanned,0); assert.equal(quiet.complete,true);
  assert.equal(h.calls.filter(c=>c.id==='changes').length,feeds+1,'provider checked the empty window');
  assert.equal(f.calls.filter(sql=>/INSERT INTO sync_runs/.test(sql)).length,beforeReceipts+2,'start and terminal receipts written');
  receipt = latestDriveReceipt(f); assert.equal(receipt.metrics_version,1); assert.equal(receipt.provider_check_complete,1);
  assert.equal(receipt.walk_complete,1); assert.equal(receipt.docs_added,0); assert.equal(receipt.docs_failed,0); assert.equal(receipt.error,null);
  noDriveDelete(f); t.diagnostic(JSON.stringify({emptyFeedChecks:1,receiptWrites:2,partialProviderCheck:0,quietProviderCheck:1}));
});

for (const [status,reason] of [[401,'authError'],[403,'accessNotConfigured'],[429,'rateLimitExceeded']])
test(`DRIVE-R11: account-wide held retry ${status} still stops before unrelated writes`, async t => {
  const { f, h } = await obsoleteFamily(t);
  h.pages.set('next-page',{changes:[laterFile(h)],newStartPageToken:'later-page'});
  h.faults.set('record',{status,reason}); const start = h.calls.length;
  await assert.rejects(h.run());
  assert.equal(h.calls.slice(start).filter(c=>c.id==='record'&&!c.media).length,1,'account failure decision reached');
  assert.equal(h.calls.slice(start).filter(c=>c.id==='changes').length,0);
  assert.equal(h.state().sync_token,'next-page'); assert.ok(h.state().drive_pending_removals['drive:record']);
  h.faults.delete('record'); assert.equal((await h.run()).created,1,'healthy account/feed recovery control'); noDriveDelete(f);
});

for (const stop of ['checkpoint','ownership'])
test(`DRIVE-R11: ${stop} failure during retry cannot be swallowed as item-local`, async t => {
  const { f, h } = await obsoleteFamily(t); const ingest = await import('../../ingest/run.mjs');
  h.pages.set('next-page',{changes:[laterFile(h)],newStartPageToken:'later-page'});
  let reached = 0; const originalConnector = h.options.drive;
  if (stop === 'checkpoint') h.options.ingestLib = async()=>({...ingest,saveState:(path,state)=>{
    if (state.drive_retry_after === 'drive:record' && reached++ === 0) throw new Error('synthetic checkpoint failure');
    return ingest.saveState(path,state);
  }});
  else {
    const connector = h.options.drive;
    h.options.drive = new Proxy(connector,{get(target,key){
      if (key === 'getFileMetadata') return async()=>{reached++; throw Object.assign(new Error('synthetic source lock lost'),{code:'source_ingest_lock_lost'});};
      return target[key];
    }});
  }
  const start = h.calls.length;
  await assert.rejects(h.run(),/checkpoint failure|source lock lost/);
  assert.ok(reached>0,'run-wide failure decision reached');
  assert.equal(h.calls.slice(start).filter(c=>c.id==='changes').length,0);
  assert.equal(h.state().sync_token,'next-page'); assert.ok(h.state().drive_pending_removals['drive:record']);
  h.options.ingestLib = async()=>ingest;
  h.options.drive = originalConnector;
  assert.equal((await h.run()).created,1,'healthy checkpoint/ownership recovery control'); noDriveDelete(f);
});

test('DRIVE-R11: failed held metadata preserves the exact accepted version and retry class', async t => {
  const { f, h } = await obsoleteFamily(t); const acceptedVersion = h.state().done['drive:record'];
  h.faults.set('record',{status:503,reason:'backendError'});
  await h.run();
  assert.ok(h.calls.filter(c=>c.id==='record'&&!c.media).length>=2,'failed metadata decision reached');
  const failure = h.state().drive_failures['drive:record'];
  assert.equal(failure.version,acceptedVersion,'failure retains the accepted family version across metadata unavailability');
  assert.equal(failure.retry_class,'retry'); assert.equal(failure.retryable,true);
  assert.equal(h.state().drive_pending_removals['drive:record'].reason,'replacement_family_needs_review');
  h.faults.delete('record'); await h.run();
  assert.equal(h.state().drive_failures['drive:record'],undefined,'healthy metadata/readback control'); noDriveDelete(f);
});

// R6 composes the actual CLI OCR factory, PDF extractor, connector, durable
// checkpoint reload, retained writer and receipts. Only transports and clocks
// are injected; the pending-page decision is the production OCR decision.
async function pendingOcrFeed(t, { healthy = false, exhaustBudget = false } = {}) {
  const { makeOcrCallback } = await import('../../brain.mjs');
  const { scanPdf } = await import('../../test/fixtures/scan-pdf.mjs');
  const f = fixture(); t.after(() => { t.diagnostic(workCounts(f)); f.db.close(); });
  assert.equal((await f.ingest(f.envelope('Accepted evidence before the pending OCR replacement.'))).created, 1);
  const prior = f.text(), h = await realDriveFeed(t, f);
  Object.assign(h.files.get('record'), { name:'scan.pdf', mimeType:'application/pdf' });
  h.manifest.safety.ocr = { enabled:true, max_pages:2 };
  const fetchMedia = h.opts.fetchImpl;
  h.opts.fetchImpl = async input => {
    const url = new URL(input);
    if (url.pathname.endsWith('/record') && url.searchParams.get('alt') === 'media') {
      h.calls.push({ id:'record', media:true }); return new Response(scanPdf({ pages:2 }));
    }
    return fetchMedia(input);
  };
  const counts = { pending:0, success:0, health:0, ack:0, offsets:[] };
  t.after(()=>t.diagnostic(JSON.stringify(counts)));
  let clock = Date.parse('2026-11-01T00:00:00.000Z'), ocrClock = clock, repaired = healthy;
  h.options.driveNow = () => clock;
  if (exhaustBudget) h.options.driveLimits = { timeBudgetMs:10 };
  h.options.makeOcrCallback = args => makeOcrCallback({ ...args, attempts:1, now:()=>ocrClock,
    sleep:async ms => { ocrClock += ms; }, random:()=>0, onRetry:()=>{}, onSkip:()=>{}, onPage:()=>{},
    httpImpl:async (input, init) => {
      if (new URL(input).pathname === '/health') { counts.health++; return Response.json({ ok:true }); }
      const body = JSON.parse(init.body);
      if (!repaired && body.page === 1) {
        counts.pending++; if (exhaustBudget) clock += 11;
        return Response.json({ ocr_request_pending:true, ocr_model_call_cap_exhausted:true,
          model_calls_in_24_hours:3, retry_after_ms:60_000 }, { status:425 });
      }
      counts.success++; return Response.json({ text:h.content });
    } });
  const ingest = await import('../../ingest/run.mjs');
  h.options.ingestLib = async () => ({ ...ingest, saveState:(path,state) => {
    if (state.drive_change_page) counts.offsets.push(state.drive_change_page.offset);
    return ingest.saveState(path,state);
  } });
  const request = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (new URL(input).pathname === '/api/admin/brain/ocr') {
      const ids = JSON.parse(init.body).acknowledge_request_ids;
      assert.ok(ids.length > 0, 'actual stored-page acknowledgement reached'); counts.ack++;
      return Response.json({ ocr_acknowledged:ids.length });
    }
    return request(input, init);
  };
  return { f,h,counts,prior,repair:()=>{repaired=true;} };
}

for (const exhaustBudget of [false,true])
test(`DRIVE-R12: pending OCR page permits later acceptance across ordinary restarts, budget=${exhaustBudget}`, async t => {
  const { f,h,counts,prior,repair } = await pendingOcrFeed(t,{exhaustBudget});
  let error; const first = await h.run().catch(e=>{error=e;});
  assert.equal(counts.pending,1,'real 425 pending/call-cap response reached');
  assert.equal(counts.health,1,'real OCR post-timeout health decision reached');
  assert.equal(counts.success,1,'remaining PDF page assessed');
  assert.equal(error,undefined,'a healthy-transport OCR retry must stay local');
  assert.equal(first.complete,false);
  assert.equal(f.text(),prior,'pending replacement retains accepted bytes');
  let held=h.state().drive_failures['drive:record'];
  assert.equal(held.code,'ocr_page_timeout'); assert.equal(held.retry_class,'retry');
  assert.equal(held.retryable,true); assert.ok(held.version);
  assert.ok(counts.offsets.includes(1),'failed entry durably settles its page offset');
  if (exhaustBudget) {
    assert.equal(h.state().drive_change_page.offset,1);
    assert.equal(first.created,0,'time budget still enforced');
    assert.equal((await h.run()).created,1,'next run uses its reserved feed opportunity');
  } else assert.equal(first.created,1,'healthy later entry accepted in the same run');
  assert.ok(h.calls.some(c=>c.id==='addition'&&c.media),'later media decision reached');
  assert.ok(h.state().done['drive:addition']); assert.equal(h.state().sync_token,'next-page');
  assert.equal(latestDriveReceipt(f).provider_check_complete,0);
  assert.ok(latestDriveReceipt(f).docs_failed>0,'pending OCR remains an incomplete receipt');
  // No reset: a quiet ordinary pass must retry the saved document fairly.
  await h.run();
  assert.equal(counts.pending,2,'durable retry remains automatically reachable');
  assert.equal(f.text(),prior);
  held=h.state().drive_failures['drive:record']; assert.equal(held.code,'ocr_page_timeout');
  repair();
  let complete=false;
  for(let run=0;run<3&&!complete;run++) complete=(await h.run()).complete;
  assert.equal(complete,true,'recovered OCR control clears only the repaired gap');
  assert.equal(h.state().drive_failures['drive:record'],undefined); assert.equal(counts.ack,1);
  assert.ok(f.text().includes(h.content)); assert.ok(f.calls.some(sql=>/INSERT INTO retained_ingest_activations/.test(sql)));
  assert.ok(!h.calls.some(c=>c.id==='startPageToken'||c.id==='files'),'reached work never reseeds or walks'); noDriveDelete(f);
  t.diagnostic(JSON.stringify(counts));
});

test('DRIVE-R12: healthy OCR is a green control through the same CLI and writer', async t => {
  const { f,h,counts } = await pendingOcrFeed(t,{healthy:true});
  const result=await h.run();
  assert.equal(result.updated,1); assert.equal(result.created,1); assert.equal(result.complete,true);
  assert.equal(counts.success,2); assert.equal(counts.pending,0); assert.equal(counts.ack,1);
  assert.equal(counts.health,0); assert.equal(h.state().sync_token,'next-page'); noDriveDelete(f);
});

for(const status of [401,403])
test(`R6 global control: real batch HTTP ${status} keeps the page before healthy suffix work`,async t=>{
  const f=fixture(); t.after(()=>{t.diagnostic(workCounts(f));f.db.close();});
  const h=await realDriveFeed(t,f);
  const transport=globalThis.fetch; let reached=0;
  globalThis.fetch=async(input,init)=>{
    if(new URL(input).pathname==='/api/admin/brain/ingest/batch'){
      reached++;return Response.json({error:'Synthetic account denial'},{status});
    }
    return transport(input,init);
  };
  await assert.rejects(h.run()); assert.equal(reached,1,'real sender account failure reached');
  assert.equal(h.state().sync_token,'prior-page'); assert.equal(h.state().drive_change_page.offset,0);
  assert.ok(!h.calls.some(c=>c.id==='addition'&&c.media));
  globalThis.fetch=transport; assert.equal((await h.run()).created,2,'same-path healthy batch control'); noDriveDelete(f);
});

for(const stop of ['checkpoint','ownership-health','ownership-request'])
test(`DRIVE-R12 global control: ${stop} after OCR pending stops the current page`,async t=>{
  const { f,h,counts }=await pendingOcrFeed(t); let reached=0;
  if(stop==='checkpoint'){
    const lib=h.options.ingestLib;
    h.options.ingestLib=async()=>{
      const ingest=await lib();return {...ingest,saveState:(path,state)=>{
        if(state.drive_failures?.['drive:record']?.code==='ocr_page_timeout'&&reached++===0)
          throw new Error('Synthetic OCR checkpoint failure');
        return ingest.saveState(path,state);
      }};
    };
  }else{
    const factory=h.options.makeOcrCallback;
    h.options.makeOcrCallback=args=>factory({...args,assertOwned:()=>{
      if((stop==='ownership-request'||counts.pending>0)&&reached++===0)
        throw Object.assign(new Error('Synthetic OCR ownership loss'),{code:'source_ingest_lock_lost'});
    }});
  }
  await assert.rejects(h.run()); assert.ok(reached>0,'OCR stop decision reached'); assert.equal(counts.pending,stop==='ownership-request'?0:1);
  assert.equal(h.state().sync_token,'prior-page'); assert.equal(h.state().drive_change_page.offset,0);
  assert.ok(!h.calls.some(c=>c.id==='addition'&&c.media),'suffix cannot write after a global stop');
  assert.ok((await h.run()).created===1,'same-path recovered ownership/checkpoint permits healthy suffix'); noDriveDelete(f);
});
