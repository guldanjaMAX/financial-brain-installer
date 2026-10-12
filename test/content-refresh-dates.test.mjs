import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { ApiError, ownerError } from '../frontend/src/lib/api.ts';
import { RECOVERY_DURABLE_TABLES, V048_RECOVERY_DURABLE_TABLES, RECOVERY_AGGREGATE_SQL, recoveryExportTables } from '../operations/cloudflare-recovery-adapter.mjs';
import { createProductFixture } from '../worker/test/product-contract-fixture.mjs';
import { refreshContentDates } from '../worker/src/lib/content-freshness-maintenance.js';
import { renderCliCommands } from '../operations/cli-guidance.mjs';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const PATH = '/api/admin/brain/content/refresh-dates';
const ARGS = ['refresh-dates', 'synthetic.manifest.json'];
let network = 0, processes = 0;
globalThis.fetch = async () => { network++; throw new Error('network forbidden'); };
test.before(() => {
  mock.method(Date, 'now', () => NOW);
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) {
    mock.method(childProcess, name, () => { processes++; throw new Error('host tool forbidden'); });
  }
  syncBuiltinESMExports();
});
test.after(() => { assert.equal(network, 0); assert.equal(processes, 0); mock.restoreAll(); syncBuiltinESMExports(); });

async function fixture(t, count = 1) {
  const f = await createProductFixture(); t.after(f.close);
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'content-dates-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const keyPath = join(home, 'fixture-admin-key');
  writeFileSync(keyPath, randomBytes(32).toString('hex'), { mode: 0o600 });
  f.env.ADMIN_KEY = readFileSync(keyPath, 'utf8');
  for (let i = 1; i <= count; i++) {
    f.raw(`INSERT INTO documents(doc_uid,source,source_id,title,document_date,date_source,date_reliable,content_hash,ingested_at)
      VALUES (?,'files',?,'Workspace notes',?,'filename',0,?,?)`, `files:${i}`, String(i),
    Date.parse('2026-08-04'), `revision-${i}`, NOW);
    f.raw(`INSERT INTO chunks(chunk_uid,doc_uid,chunk_ix,text,source,document_date)
      VALUES (?,?,0,'Last updated 2026-09-21\nThe workspace setting is enabled.','files',?)`,
    `files:${i}#0`, `files:${i}`, Date.parse('2026-08-04'));
  }
  const brain = await import('../brain.mjs');
  const calls = [], output = [], io = { manifests: 0, credentials: 0 };
  const deps = {
    loadManifest() { io.manifests++; return { m: { brain: { domain: 'brain.invalid' }, admin_key_file: keyPath } }; },
    resolveAdminKey() { io.credentials++; return readFileSync(keyPath, 'utf8'); },
    write(value) { output.push(value); },
    launchctl() { processes++; throw new Error('launch forbidden'); },
    async fetchImpl(url, init) {
      calls.push({ path: new URL(url).pathname, body: JSON.parse(init.body), redirect: init.redirect });
      return f.worker.fetch(new Request(url, init), f.env, {});
    },
  };
  const cli = (...args) => brain.cmdContent([...ARGS, ...args], deps);
  const rawPost = f.post;
  const post = body => rawPost(PATH, body, { 'X-Admin-Key': f.env.ADMIN_KEY });
  return Object.assign(f, { brain, deps, calls, output, io, cli, post });
}

function state(f) {
  return ['documents', 'chunks', 'vector_outbox'].map(table => f.rows(`SELECT * FROM ${table} ORDER BY rowid`));
}
function identities(f) {
  return [f.rows('SELECT doc_uid,title,content_hash FROM documents ORDER BY doc_uid'),
    f.rows('SELECT chunk_uid,doc_uid,text FROM chunks ORDER BY chunk_uid')];
}

// This probe reaches the existing unsafe write path before the entry point exists.
test('direct maintenance cannot mutate a non-empty page without approval', async t => {
  const f = await fixture(t);
  const plan = await refreshContentDates(f.env, { now: NOW });
  assert.equal(plan.planned, 1);
  const before = state(f);
  await assert.rejects(refreshContentDates(f.env, { dryRun: false, now: NOW }), /approval/i);
  assert.deepEqual(state(f), before);
  const good = await refreshContentDates(f.env, { dryRun: false, approve: plan.plan_hash, now: NOW });
  assert.equal(good.updated, 1);
});

test('real CLI and authenticated Worker preview, apply, lost receipt replay and no deletion', async t => {
  const f = await fixture(t, 2);
  assert.equal(typeof f.brain.cmdContent, 'function');
  const before = state(f), retained = identities(f);
  const preview = await f.cli('--preview');
  assert.equal(preview.documents, 2); assert.equal(preview.planned, 2);
  assert.equal(preview.chunks, 2); assert.equal(preview.blocked_documents, 0);
  assert.equal(preview.queue_depth, 0); assert.equal(preview.updated, 0);
  assert.equal(preview.complete, true); assert.match(preview.plan_hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(state(f), before);
  assert.deepEqual(f.calls.map(c => c.path), [PATH]); assert.equal(f.calls[0].redirect, 'error');
  assert.ok(f.output.join('\n').includes(renderCliCommands('brain content refresh-dates')));
  const done = await f.cli('--apply', '--approve', preview.plan_hash);
  assert.equal(done.updated, 2); assert.equal(done.chunks_requeued, 2); assert.equal(done.complete, true);
  assert.equal(f.first("SELECT COUNT(*) n FROM documents WHERE date_source='content' AND date_reliable=1").n, 2);
  assert.equal(f.first('SELECT COUNT(*) n FROM chunks WHERE document_date=?', Date.parse('2026-09-21')).n, 2);
  const after = state(f);
  const replay = await f.cli('--apply', '--approve', preview.plan_hash);
  assert.equal(replay.replayed, true); assert.equal(replay.updated, 0); assert.equal(replay.chunks_requeued, 0);
  assert.equal(replay.next_cursor, done.next_cursor); assert.equal(replay.complete, true);
  assert.deepEqual(state(f), after); assert.deepEqual(identities(f), retained);
  assert.ok(!f.seen.sql.some(sql => /\bDELETE\s+FROM\b|\bREPLACE\s+INTO\b/i.test(sql)));
  const text = f.output.join('\n');
  for (const privateValue of ['Workspace notes', 'The workspace setting', 'files:1', f.env.ADMIN_KEY]) {
    assert.equal(text.includes(privateValue), false, 'receipts contain no private data');
  }
});

test('stale approval, unauthenticated apply and missing approval refuse a real non-empty plan', async t => {
  const f = await fixture(t);
  const p = await f.cli('--preview'); assert.equal(p.planned, 1);
  const before = state(f);
  const unauthorized = await f.worker.fetch(new Request('https://brain.invalid' + PATH, {
    method: 'POST', body: JSON.stringify({ dry_run: false, approve: p.plan_hash }),
  }), f.env, {});
  assert.equal(unauthorized.status, 401);
  const missing = await f.post({ dry_run: false }); assert.equal(missing.status, 400);
  await assert.rejects(f.cli('--apply', '--approve', '0'.repeat(64)), /stale|preview/i);
  assert.equal(f.calls.length, 2); assert.deepEqual(state(f), before);
  const io = { ...f.io };
  await assert.rejects(f.cli('--apply'), /approve/i);
  assert.deepEqual(f.io, io, 'invalid CLI arguments refuse before manifest and credential use');
  assert.equal((await f.cli('--apply', '--approve', p.plan_hash)).updated, 1);
});

test('nondefault pages resume with apply inferring the approved limit until complete', async t => {
  const f = await fixture(t, 5);
  let cursor = '0', updated = 0;
  for (let page = 0; page < 3; page++) {
    const p = await f.cli('--preview', '--limit', '2', '--cursor', cursor);
    assert.equal(p.documents, page < 2 ? 2 : 1);
    const done = await f.cli('--apply', '--approve', p.plan_hash, '--cursor', cursor);
    assert.equal(done.documents, p.documents); updated += done.updated;
    assert.equal(done.complete, page === 2); assert.ok(Number(done.next_cursor) > Number(cursor));
    cursor = done.next_cursor;
  }
  assert.equal(updated, 5);
});

test('queue budget refuses existing backlog and projected overflow with a green bounded control', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 501; i++) f.raw("INSERT INTO vector_outbox(chunk_uid,vector_id,op,queued_at) VALUES (?,?,'upsert',?)", `pending-${i}`, `pending-${i}`, NOW);
  const p = await f.cli('--preview'); assert.equal(p.planned, 1); assert.equal(p.queue_depth, 501);
  const before = state(f);
  await assert.rejects(f.cli('--apply', '--approve', p.plan_hash), /queue.*budget/i);
  await assert.rejects(f.cli('--apply', '--approve', p.plan_hash, '--queue-budget', '501'), /queue.*budget/i);
  assert.equal(f.calls.length, 3); assert.deepEqual(state(f), before);
  assert.equal((await f.cli('--apply', '--approve', p.plan_hash, '--queue-budget', '502')).updated, 1);
});

test('a large document blocks the entire page without cursor advance or earlier writes', async t => {
  const f = await fixture(t, 2);
  for (let i = 1; i <= 500; i++) f.raw("INSERT INTO chunks(chunk_uid,doc_uid,chunk_ix,text,source) VALUES (?,'files:2',?,'Synthetic section.','files')", `files:2#${i}`, i);
  const p = await f.cli('--preview'); assert.equal(p.documents, 2); assert.equal(p.planned, 1);
  assert.equal(p.blocked_documents, 1); assert.equal(p.complete, false); assert.equal(p.next_cursor, '0');
  const before = state(f);
  await assert.rejects(f.cli('--apply', '--approve', p.plan_hash), /500 chunks/i);
  assert.equal(f.calls.length, 2); assert.deepEqual(state(f), before);
  const small = await f.cli('--preview', '--limit', '1'); assert.equal(small.planned, 1);
  assert.equal((await f.cli('--apply', '--approve', small.plan_hash)).updated, 1);
});

test('page revision and queue races are checked inside the atomic batch', async t => {
  const f = await fixture(t, 2);
  let p = await f.cli('--preview'); assert.equal(p.planned, 2);
  const batch = f.env.DB.batch; let reached = 0;
  f.env.DB.batch = async statements => {
    reached++;
    f.raw("UPDATE documents SET content_hash='new-revision' WHERE doc_uid='files:2'");
    return batch(statements);
  };
  await assert.rejects(f.cli('--apply', '--approve', p.plan_hash), /preview/i);
  assert.equal(reached, 1); assert.equal(f.first("SELECT COUNT(*) n FROM documents WHERE date_source='content'").n, 0);
  assert.equal(f.first('SELECT COUNT(*) n FROM vector_outbox').n, 0);
  f.env.DB.batch = batch;
  p = await f.cli('--preview');
  f.env.DB.batch = async statements => {
    reached++;
    f.raw("INSERT INTO vector_outbox(chunk_uid,vector_id,op,queued_at) VALUES ('race','race','upsert',?)", NOW);
    return batch(statements);
  };
  await assert.rejects(f.cli('--apply', '--approve', p.plan_hash, '--queue-budget', '2'), /queue.*budget/i);
  assert.equal(reached, 2); assert.equal(f.first("SELECT COUNT(*) n FROM documents WHERE date_source='content'").n, 0);
  f.env.DB.batch = batch;
  assert.equal((await f.cli('--apply', '--approve', p.plan_hash)).updated, 2);
});

test('invalid arguments and unsafe domains refuse before credentials with a valid control', async t => {
  const f = await fixture(t);
  for (const args of [[], ['--apply'], ['--preview', '--apply'], ['--preview', '--approve', '0'.repeat(64)],
    ['--preview', '--limit', '11'], ['--preview', '--limit', '0'], ['--preview', '--limit', '1', '--limit', '2'],
    ['--preview', '--cursor', ' 1'], ['--preview', '--cursor', '01'], ['--preview', '--cursor', '9007199254740992'],
    ['--preview', '--queue-budget', '-1'], ['--preview', '--queue-budget', '10001'], ['--preview', '--cursor']]) {
    await assert.rejects(f.cli(...args), /refresh-dates/);
  }
  assert.equal(f.io.credentials, 0); assert.equal(f.io.manifests, 0); assert.equal(f.calls.length, 0);
  const load = f.deps.loadManifest;
  f.deps.loadManifest = () => ({ m: { brain: { domain: 'http://brain.invalid' } } });
  await assert.rejects(f.cli('--preview'), /HTTPS/); assert.equal(f.io.credentials, 0);
  f.deps.loadManifest = load;
  assert.equal((await f.cli('--preview')).planned, 1); assert.equal(f.io.credentials, 1);
  let boundary = 0;
  const controlled = await f.brain.runCliCommandWithCredentialBoundary('content', () => f.cli('--preview'), {
    withWranglerSession() { boundary++; throw new Error('control-plane credential path forbidden'); },
  });
  assert.equal(controlled.planned, 1); assert.equal(boundary, 0);

  const windows = { platform: 'win32', nodePath: 'C:\\runtime\\node.exe', scriptPath: 'C:\\fixture\\brain.mjs', env: { PATH: '' }, existsSync: () => false };
  assert.equal(renderCliCommands('brain content refresh-dates', windows), renderCliCommands('brain setup', windows).replace(/ setup$/, ' content refresh-dates'));
});

test('lost HTTP response, queue drain and concurrent replay cannot create another mutation', async t => {
  const f = await fixture(t);
  const p = await f.cli('--preview'); assert.equal(p.planned, 1);
  const fetchImpl = f.deps.fetchImpl;
  let lost = 0;
  f.deps.fetchImpl = async (...args) => { await fetchImpl(...args); lost++; throw new Error('lost response'); };
  await assert.rejects(f.cli('--apply', '--approve', p.plan_hash), /could not be verified/);
  assert.equal(lost, 1); assert.equal(f.first("SELECT COUNT(*) n FROM documents WHERE date_source='content'").n, 1);
  // Simulate provider confirmation, not a maintenance deletion.
  f.raw('DELETE FROM vector_outbox');
  const generation = f.first('SELECT outbox_generation FROM install_state').outbox_generation;
  f.deps.fetchImpl = fetchImpl;
  const replay = await f.cli('--apply', '--approve', p.plan_hash, '--queue-budget', '0');
  assert.equal(replay.replayed, true); assert.equal(replay.updated, 0); assert.equal(replay.queue_depth, 0);
  assert.equal(f.first('SELECT outbox_generation FROM install_state').outbox_generation, generation);
  assert.equal(f.first('SELECT COUNT(*) n FROM vector_outbox').n, 0);
  await assert.rejects(f.cli('--apply', '--approve', p.plan_hash, '--cursor', '1'), /stale/);

  f.raw("UPDATE documents SET date_source='none',date_reliable=0,document_date=NULL");
  const fresh = await f.cli('--preview'); assert.equal(fresh.planned, 1);
  const batch = f.env.DB.batch; let reached = 0;
  f.env.DB.batch = async statements => {
    reached++; f.env.DB.batch = batch;
    const winner = await refreshContentDates(f.env, { dryRun: false, approve: fresh.plan_hash, now: NOW });
    assert.equal(winner.updated, 1);
    return batch(statements);
  };
  const raced = await f.cli('--apply', '--approve', fresh.plan_hash);
  assert.equal(reached, 1); assert.equal(raced.replayed, true); assert.equal(raced.updated, 0);
  assert.equal(f.first('SELECT COUNT(*) n FROM content_date_refresh_receipts').n, 2);
});

test('metadata and chunk edits invalidate approval; readback and receipt failures roll back the whole page', async t => {
  const f = await fixture(t, 2);
  for (const mutation of [
    () => f.raw("UPDATE chunks SET text=text||' Synthetic revision.' WHERE doc_uid='files:2'"),
    () => f.raw("UPDATE documents SET title='Revised workspace notes' WHERE doc_uid='files:2'"),
  ]) {
    const p = await f.cli('--preview'); assert.equal(p.planned, 2); mutation();
    const before = state(f);
    await assert.rejects(f.cli('--apply', '--approve', p.plan_hash), /stale/);
    assert.deepEqual(state(f), before);
  }
  const p = await f.cli('--preview');
  for (const failure of [/content date readback failed/, /INSERT INTO content_date_refresh_receipts/]) {
    f.control.failOn = failure;
    const before = state(f);
    const seen = f.seen.sql.length;
    await assert.rejects(f.cli('--apply', '--approve', p.plan_hash), /Preview/);
    assert.ok(f.seen.sql.slice(seen).some(sql => failure.test(sql)), 'failure reached the transaction decision');
    assert.deepEqual(state(f), before);
    assert.equal(f.first('SELECT COUNT(*) n FROM content_date_refresh_receipts').n, 0);
  }
  f.control.failOn = null;
  assert.equal((await f.cli('--apply', '--approve', p.plan_hash)).updated, 2);
});

test('a mismatched SQL readback aborts earlier writes, and a stable readback commits', async t => {
  const f = await fixture(t, 2);
  const p = await f.cli('--preview'); assert.equal(p.planned, 2);
  const before = state(f);
  f.sqlite.exec(`CREATE TRIGGER synthetic_readback_fault AFTER UPDATE OF document_date ON documents
    WHEN NEW.doc_uid='files:2' BEGIN UPDATE chunks SET document_date=0 WHERE doc_uid=NEW.doc_uid; END;`);
  await assert.rejects(f.cli('--apply', '--approve', p.plan_hash), /Preview/);
  assert.ok(f.seen.sql.some(sql => sql.includes('content date readback failed')), 'SQL validation was executed');
  assert.deepEqual(state(f), before);
  assert.equal(f.first('SELECT COUNT(*) n FROM content_date_refresh_receipts').n, 0);
  f.sqlite.exec('DROP TRIGGER synthetic_readback_fault');
  assert.equal((await f.cli('--apply', '--approve', p.plan_hash)).updated, 2);
});

test('route rejects malformed values, read keys and upgrade-paused writes with an authenticated control', async t => {
  const f = await fixture(t);
  const p = await f.cli('--preview'); assert.equal(p.planned, 1);
  const before = state(f);
  for (const body of [{ dry_run: 'false' }, { dry_run: false, approve: p.plan_hash, limit: 1 },
    { dry_run: true, cursor: 1 }, { dry_run: true, cursor: '-1' }, { dry_run: true, limit: 11 },
    { dry_run: true, queue_budget: 10001 }, { dry_run: true, surprise: 'ignored' }]) {
    assert.equal((await f.post(body)).status, 400);
  }
  f.env.READ_KEY = randomBytes(32).toString('hex');
  const readOnly = await f.worker.fetch(new Request('https://brain.invalid' + PATH, {
    method: 'POST', headers: { 'X-Admin-Key': f.env.READ_KEY }, body: JSON.stringify({ dry_run: false, approve: p.plan_hash }),
  }), f.env, {});
  assert.equal(readOnly.status, 401);
  f.env.VECTOR_DRAIN_MODE = 'paused-for-upgrade';
  const paused = await f.post({ dry_run: false, approve: p.plan_hash }); assert.equal(paused.status, 503);
  assert.deepEqual(state(f), before);
  f.env.VECTOR_DRAIN_MODE = 'active';
  assert.equal((await f.cli('--apply', '--approve', p.plan_hash)).updated, 1);
});

test('empty pages complete and queue boundary admits exactly the available capacity', async t => {
  const f = await fixture(t, 0);
  const p = await f.cli('--preview'); assert.equal(p.documents, 0); assert.equal(p.complete, true);
  assert.equal((await f.cli('--apply', '--approve', p.plan_hash, '--queue-budget', '0')).updated, 0);
  const withRows = await fixture(t);
  const q = await withRows.cli('--preview'); assert.equal(q.chunks, 1);
  await assert.rejects(withRows.cli('--apply', '--approve', q.plan_hash, '--queue-budget', '0'), /queue.*budget/);
  assert.equal((await withRows.cli('--apply', '--approve', q.plan_hash, '--queue-budget', '1')).updated, 1);
});

test('owner error codes explain repair actions; receipts and unknown errors never echo server content', async t => {
  for (const [code, status] of [['content_dates_d1_required', 409], ['content_dates_approval_required', 400], ['content_dates_stale', 409],
    ['content_dates_blocked', 409], ['content_dates_queue_budget', 409], ['content_dates_unavailable', 503]]) {
    const message = ownerError(new ApiError(status, { code })).message;
    assert.match(message, /installer/); assert.doesNotMatch(message, /HTTP/);
  }
  const f = await fixture(t);
  const preview = await f.cli('--preview'); assert.equal(preview.planned, 1);
  f.deps.fetchImpl = async () => new Response(JSON.stringify({ ...preview, private_text: 'Synthetic private text' }));
  await f.cli('--preview'); assert.equal(f.output.join('\n').includes('Synthetic private text'), false);
  f.deps.fetchImpl = async () => new Response(JSON.stringify({ reason: 'Synthetic private error' }), { status: 500 });
  await assert.rejects(f.cli('--preview'), error => !error.message.includes('Synthetic private error') && /Preview/.test(error.message));
  for (const wrong of [{ documents: 11 }, { updated: 1 }, { next_cursor: 'private cursor' }, { plan_hash: 'bad' }]) {
    f.deps.fetchImpl = async () => new Response(JSON.stringify({ ...preview, ...wrong }));
    await assert.rejects(f.cli('--preview'), /Invalid.*receipt/);
  }
});

test('schema 56 receipt migration is idempotent and recovery never carries local approvals', async t => {
  const f = await fixture(t);
  const sql = readFileSync(new URL('../migrations/d1/0056_content_date_refresh_receipts.sql', import.meta.url), 'utf8');
  f.sqlite.exec(sql); f.sqlite.exec(sql);
  assert.equal(f.first("SELECT COUNT(*) n FROM sqlite_master WHERE name='content_date_refresh_receipts'").n, 1);
  assert.ok(RECOVERY_DURABLE_TABLES.includes('content_date_refresh_receipts'));
  assert.ok(!V048_RECOVERY_DURABLE_TABLES.includes('content_date_refresh_receipts'));
  assert.ok(recoveryExportTables([{ version: 56 }]).includes('documents'));
  for (const version of [55, 56]) assert.ok(!recoveryExportTables([{ version }]).includes('content_date_refresh_receipts'));
});

test('mutation oracle detects an apply path that silently manufactures its own approval', async t => {
  const f = await fixture(t);
  const plan = await refreshContentDates(f.env, { now: NOW }); assert.equal(plan.planned, 1);
  const sourceUrl = new URL('../worker/src/lib/content-freshness-maintenance.js', import.meta.url);
  const source = readFileSync(sourceUrl, 'utf8');
  const decision = '  if ((!dryRun && (typeof approve';
  assert.equal(source.split(decision).length, 2, 'mutation names the real approval decision exactly once');
  const mutant = source.replace(decision,
    "  if (!dryRun && approve === undefined) approve = (await refreshContentDates(env, { after, limit, now })).plan_hash;\n" + decision)
    .replace(/from '(\.\/[^']+)'/g, (_match, path) => `from '${new URL(path, sourceUrl).href}'`);
  const mutated = await import(`data:text/javascript;base64,${Buffer.from(mutant).toString('base64')}`);
  async function refuses(handler) {
    try { await handler(f.env, { dryRun: false, now: NOW }); return false; }
    catch (error) { assert.match(error.message, /approval/); return true; }
  }
  assert.equal(await refuses(refreshContentDates), true, 'green control refuses without mutation');
  assert.equal(f.first("SELECT COUNT(*) n FROM documents WHERE date_source='content'").n, 0);
  assert.equal(await refuses(mutated.refreshContentDates), false, 'approval bypass is killed by the refusal oracle');
  assert.equal(f.first("SELECT COUNT(*) n FROM documents WHERE date_source='content'").n, 1, 'mutant reached a real SQLite write');
});

test('legacy storage cannot report an empty D1 repair as complete', async t => {
  const f = await fixture(t);
  const control = await f.cli('--preview'); assert.equal(control.planned, 1);
  f.env.STORAGE = 'supabase';
  const before = state(f), reads = f.seen.sql.length;
  const response = await f.post({ dry_run: true });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'content_dates_d1_required');
  assert.equal(f.seen.sql.slice(reads).some(sql => /FROM documents/.test(sql)), false);
  assert.deepEqual(state(f), before);
  f.env.STORAGE = 'd1';
  assert.equal((await f.cli('--apply', '--approve', control.plan_hash)).updated, 1);
});


test('recovery aggregate SQL works both with and without the schema 56 receipt table', async t => {
  const f = await fixture(t);
  const present = f.first(RECOVERY_AGGREGATE_SQL);
  assert.equal(present.documents, '1', 'green control executes the actual aggregate query');
  f.sqlite.exec('DROP TABLE content_date_refresh_receipts');
  const older = f.first(RECOVERY_AGGREGATE_SQL);
  assert.equal(older.documents, '1'); assert.equal(older.content_date_refresh_receipts, '0');
});

test('unreadable replies and transport failures cannot expose private response text', async t => {
  const f = await fixture(t);
  assert.equal((await f.cli('--preview')).planned, 1, 'green control reaches the real request');
  let decisions = 0;
  for (const fail of [
    async () => { decisions++; return new Response('Synthetic private response text'); },
    async () => { decisions++; throw new Error('Synthetic private transport text'); },
  ]) {
    f.deps.fetchImpl = fail;
    await assert.rejects(f.cli('--preview'), error => /could not be verified/.test(error.message) && !/Synthetic private/.test(error.message));
  }
  assert.equal(decisions, 2, 'both response and transport decisions were reached');
});
