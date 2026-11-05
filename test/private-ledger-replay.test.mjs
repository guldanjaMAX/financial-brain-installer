import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, statSync, readdirSync, symlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { ROOT, waitForQuiet } from '../eval/fast-loop/money-replay.mjs';
import { MONEY_JARGON } from '../worker/test/fixtures/plain-copy-expectations.mjs';
import { exportQueries, validateEnvelope } from '../eval/fast-loop/private-ledger-contract.mjs';
import { runReplayChild } from '../eval/fast-loop/child-run.mjs';

const entry = resolve(ROOT, 'eval/fast-loop/private-ledger-replay.mjs');
const scratch = resolve(process.env.PRIVATE_REPLAY_TEST_SCRATCH || resolve(ROOT, 'lane-evidence/private-replay'));
mkdirSync(scratch, { recursive: true });
const home = resolve(scratch, 'home-test');
mkdirSync(home, { recursive: true });
const env = { PATH: '/usr/bin:/bin', HOME: home, BRAIN_NO_WRANGLER_LOGIN: '1', TZ: 'UTC' };
for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) if (process.platform === 'win32' && process.env[key]) env[key] = process.env[key];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function cli(args) {
  waitForQuiet(env);
  // A comparison may run two arms, each with two bounded 120 s attempts.
  const child = spawnSync(process.execPath, [entry, ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 490000, maxBuffer: 1024 * 1024 });
  if (child.status === 0) {
    // Expected recovery diagnostics belong in the CI log. Keep every other
    // byte subject to the existing empty-stderr assertion in successful().
    const diagnostics = [], unexpected = [];
    for (const line of child.stderr.split('\n')) {
      if (/^REPLAY_CHILD_TIMEOUT PRIVATE_REPLAY attempt=1 ms=\d+ stderr=[^\r\n]{0,400}$/.test(line)) diagnostics.push(line);
      else unexpected.push(line);
    }
    if (diagnostics.length) {
      assert.ok(diagnostics.length <= (args.includes('--baseline') ? 2 : 1), 'one recovered timeout per executed arm');
      for (const line of diagnostics) process.stderr.write(line + '\n');
      child.stderr = unexpected.join('\n');
    }
  }
  return child;
}
test('private replay entry point exists and rejects missing arguments without content', () => {
  assert.ok(existsSync(entry), 'offline replay entry point must exist');
  const child = cli([]);
  assert.equal(child.status, 2);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr.trim(), 'PRIVATE_REPLAY_INVALID_ARGUMENTS');
});

// Positive disk runs need an output root outside every Git worktree. A lane
// with tighter write restrictions must get its scratch exception first.
function outputRoot() {
  return mkdtempSync(join(process.env.PRIVATE_REPLAY_TEST_OUT_ROOT || tmpdir(), 'replay-'));
}
async function fixture() {
  const api = await import('../eval/fast-loop/private-ledger-replay.mjs');
  const dir = mkdtempSync(join(scratch, 'input-'));
  const now = '2026-11-01T01:00:00Z'; // Still October in the owner's zone.
  const basis = { provenance: 'owner_stated', basis_state: 'confirmed', recorded_at: now, tenant_id: 'primary' };
  const tables = Object.fromEntries(api.TABLES.map(table => [table.name, []]));
  tables.fin_entities.push({ ...basis, id: 1, entity_slug: 'owner', legal_name: 'Synthetic owner', display_label: 'Synthetic owner', kind: 'business', status: 'active', relationship: 'owned' });
  tables.fin_accounts.push({ ...basis, id: 1, account_slug: 'cash', entity_slug: 'owner', mask: '3131', label: 'Operating account', account_kind: 'checking', balance_role: 'asset', feed_mode: 'manual' });
  tables.fin_account_coverage.push({ ...basis, id: 1, account_slug: 'cash', coverage_status: 'complete', covered_from: '2026-09-01', covered_to: '2026-10-31', computed_at: now });
  tables.fin_balance_snapshots.push({ ...basis, id: 1, account_slug: 'cash', as_of_date: '2026-10-31', current_minor: 76543 });
  for (const [id, posted_on, amount_minor, pending] of [[1, '2026-10-12', 12345, 0], [2, '2026-10-14', 2345, 0], [3, '2026-10-31', 99999, 1], [4, '2026-11-01', 88888, 0]]) {
    tables.fin_transactions.push({ ...basis, id, txn_uid: `synthetic-${id}`, account_slug: 'cash', posted_on, amount_minor, pending, direction: 'outflow', description: 'Store Unit', payee: 'Store Unit' });
  }
  const counts = Object.fromEntries(api.TABLES.map(table => [table.name, tables[table.name].length]));
  const d1 = rows => [{ success: true, results: rows, meta: { changes: 0, rows_written: 0 } }];
  const put = (name, data) => writeFileSync(join(dir, name), JSON.stringify(data), { mode: 0o600 });
  put('export.json', { schema: 1, now_utc: now, owner_time_zone: 'America/Phoenix', tenant_id: 'primary', consistency: 'owner-reviewed-stable-money-window' });
  put('counts-before.json', d1(api.TABLES.map(table => ({ table_name: table.name, row_count: counts[table.name] }))));
  put('counts-after.json', d1(api.TABLES.map(table => ({ table_name: table.name, row_count: counts[table.name] }))));
  for (const table of api.TABLES) put(`${table.name}.json`, d1(tables[table.name]));
  const questions = join(dir, 'questions.json');
  put('questions.json', [{ id: 'expense', question: 'What are my expenses?' }, { id: 'balance', question: 'What are my account balances?' }, { id: 'rows', question: 'Show my last ten transactions.' }]);
  return { api, dir, questions, put, tables, counts, d1 };
}
function request(f) {
  const meta = JSON.parse(readFileSync(join(f.dir, 'export.json'), 'utf8'));
  meta.now_utc = new Date(meta.now_utc).toISOString();
  const questions = JSON.parse(readFileSync(f.questions, 'utf8'));
  return { meta, tables: f.tables, questions, input_digest: hash(JSON.stringify([meta, f.tables, questions])) };
}
test('private file writer uses exclusive files and owner-only modes on synthetic scratch', async () => {
  const f = await fixture(), out = join(f.dir, 'writer');
  f.api.writeArtifacts(out, { 'synthetic.json': { count: 3 } });
  if (process.platform !== 'win32') {
    assert.equal(statSync(out).mode & 0o777, 0o700);
    assert.equal(statSync(join(out, 'synthetic.json')).mode & 0o777, 0o600);
  }
  assert.throws(() => f.api.writeArtifacts(out, { 'synthetic.json': { count: 4 } }), { code: 'EEXIST' });
  assert.deepEqual(read(out, 'synthetic.json'), { count: 3 });
});
test('output guard reaches lexical and canonical Git boundaries before any write', async () => {
  const f = await fixture();
  const outside = resolve('/private/tmp/private-replay-output-guard-synthetic');
  assert.equal(f.api.checkOutput(outside, [ROOT]), outside);
  assert.throws(() => f.api.checkOutput(join(f.dir, 'output'), [ROOT]), /OUTPUT_IN_WORKTREE/);
  if (process.platform !== 'win32') {
    const link = join(f.dir, 'link');
    symlinkSync(ROOT, link);
    assert.throws(() => f.api.checkOutput(join(link, 'output'), []), /OUTPUT_IN_WORKTREE/);
  }
  const child = cli([f.dir, f.questions, join(f.dir, 'cli-output')]);
  assert.equal(child.status, 2);
  assert.equal(child.stderr.trim(), 'PRIVATE_REPLAY_OUTPUT_IN_WORKTREE');
  assert.equal(existsSync(join(f.dir, 'cli-output')), false);
  assert.equal(f.tables.fin_transactions.length, 4);
});
test('export contract requires all table counts, exact provider projections and safe integer values', async () => {
  const f = await fixture(), r = request(f);
  const counts = f.api.TABLES.map(t => ({ table_name: t.name, row_count: f.tables[t.name].length }));
  const check = (tables = r.tables, after = counts) => validateEnvelope(r.meta, tables, counts, after, r.questions);
  assert.equal(check().now_utc, r.meta.now_utc);
  assert.throws(() => validateEnvelope({ ...r.meta, now_utc: '2026-02-31T01:00:00Z' }, r.tables, counts, counts, r.questions), /EXPORT_INVALID/);
  assert.throws(() => check(r.tables, []), /EXPORT_INVALID/);
  const bad = structuredClone(r.tables);
  bad.fin_transactions[0].amount_minor = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => check(bad), /EXPORT_INVALID/);
  const projection = structuredClone(r.tables);
  projection.bank_feed_items = [{ tenant_id: 'primary', item_ref: 'synthetic', last_synced_at: null, status: 'connected', removed_at: null }];
  const withItem = counts.map(t => ({ ...t, row_count: t.row_count + (t.table_name === 'bank_feed_items' ? 1 : 0) }));
  assert.ok(validateEnvelope(r.meta, projection, withItem, withItem, r.questions));
  projection.bank_feed_items[0].access_ciphertext = 'omitted';
  assert.throws(() => validateEnvelope(r.meta, projection, withItem, withItem, r.questions), /EXPORT_INVALID/);
});
test('argument parsing rejects unknown, duplicate and unpaired comparison options', async () => {
  const f = await fixture();
  assert.equal(f.api.parseArgs(['export', 'questions', 'out']).candidate, ROOT);
  for (const args of [[], ['export', 'questions', 'out', '--baseline', ROOT],
    ['export', 'questions', 'out', '--candidate', ROOT, '--candidate', ROOT],
    ['export', 'questions', 'out', '--unknown', 'value']]) assert.throws(() => f.api.parseArgs(args), /INVALID_ARGUMENTS/);
});
test('export plan covers exact bounded money reads without credential columns', () => {
  const queries = exportQueries('primary');
  assert.equal(Object.keys(queries).length, 13);
  assert.ok(Object.hasOwn(queries, 'fin_account_kind_reviews.sql'));
  assert.match(queries['simplefin_account_assignments.sql'], /^SELECT tenant_id,item_ref,account_ref FROM/);
  assert.match(queries['simplefin_sync_windows.sql'], /^SELECT tenant_id,item_ref,state,revision,staging_revision,errlist_json FROM/);
  for (const sql of Object.values(queries)) {
    assert.match(sql, /LIMIT 10001/);
    assert.doesNotMatch(sql, /access_ciphertext|access_iv|cursor|chunks|vectors|INSERT|UPDATE|DELETE/i);
  }
});
test('count plan is one non-compound SELECT returning every table in order', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { TABLES } = await import('../eval/fast-loop/private-ledger-contract.mjs');
  const sql = exportQueries('primary')['counts.sql'];
  assert.doesNotMatch(sql, /\bUNION\b|\bINTERSECT\b|\bEXCEPT\b/i);
  const db = new DatabaseSync(':memory:');
  TABLES.forEach((t, i) => {
    db.exec(`CREATE TABLE ${t.name} (tenant_id TEXT)`);
    for (let n = 0; n < i; n++) db.exec(`INSERT INTO ${t.name} VALUES ('primary')`);
    db.exec(`INSERT INTO ${t.name} VALUES ('other')`);
  });
  assert.deepEqual(db.prepare(sql.replace(/;\s*$/, '')).all().map(r => [r.table_name, r.row_count]),
    TABLES.map((t, i) => [t.name, i]));
  db.close();
});
test('in-memory worker executes three real paths without a disk output exception', async () => {
  const f = await fixture();
  const meta = JSON.parse(readFileSync(join(f.dir, 'export.json'), 'utf8'));
  meta.now_utc = new Date(meta.now_utc).toISOString();
  const child = runReplayChild({ label: 'PRIVATE_REPLAY', beforeAttempt: () => waitForQuiet(env),
    args: ['--experimental-vm-modules', '--permission', '--no-warnings', `--allow-fs-read=${ROOT}`,
    '--import', pathToFileURL(resolve(ROOT, 'test/fixtures/cli-side-effect-tripwire.mjs')).href, resolve(ROOT, 'eval/fast-loop/private-ledger-worker.mjs')], options: {
    cwd: ROOT, env, stdio: ['pipe', 'ignore', 'pipe', 'pipe'], encoding: 'utf8',
    input: JSON.stringify({ root: ROOT, trusted_root: ROOT, tables: f.tables, meta, questions: JSON.parse(readFileSync(f.questions, 'utf8')), input_digest: 'synthetic' }),
  } });
  assert.equal(child.status, 0, child.stderr);
  const run = JSON.parse(child.output[3]);
  assert.equal(run.invalid, 0);
  assert.equal(run.complete, 3);
  assert.equal(run.observations[0].body.ledger.expense_total_minor, 14690);
  assert.equal(run.observations[1].body.ledger.accounts[0].current_minor, 76543);
  assert.equal(run.observations[2].body.citations.length, 2);
  assert.equal(child.stdout, null, 'worker has no stdout channel');
});
test('synthetic export is read through the actual file loader before in-memory replay', async () => {
  const f = await fixture();
  const loaded = f.api.readPrivateInputs(f.dir, f.questions);
  assert.equal(loaded.input_digest.length, 64);
  assert.equal(loaded.tables.fin_transactions.length, 4);
  const run = f.api.runPrivateArm(ROOT, loaded);
  assert.equal(run.complete, 3);
  assert.equal(run.invalid, 0);
  assert.equal(run.observations[0].body.ledger.expense_total_minor, 14690);
  f.put('fin_accounts.json', []);
  assert.throws(() => f.api.readPrivateInputs(f.dir, f.questions), /EXPORT_INVALID/);
});
const read = (out, file = 'answers.json') => JSON.parse(readFileSync(join(out, file), 'utf8'));
function successful(f, out, extra = []) {
  const child = cli([f.dir, f.questions, out, ...extra]);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /^questions=3 complete=3 invalid=0 files=\d+\n/);
  assert.doesNotMatch(child.stdout, /Store Unit|12345|76543|expenses|SELECT/);
  assert.equal(child.stderr, '');
  return read(out);
}
test('synthetic D1 export replays three real ledger paths with clock, SQL witnesses and private modes', async () => {
  const f = await fixture(), out = join(outputRoot(), 'out'), run = successful(f, out);
  assert.equal(run.observations.length, 3);
  assert.equal(run.observations[0].body.ledger.expense_total_minor, 14690);
  assert.equal(run.observations[0].body.ledger.to, '2026-10-31');
  assert.equal(run.observations[0].body.ledger.time_zone, 'America/Phoenix');
  assert.equal(run.observations[1].body.ledger.accounts[0].current_minor, 76543);
  assert.deepEqual(run.observations[2].body.citations.map(c => c.ref), ['ledger:transaction:2', 'ledger:transaction:1']);
  for (const o of run.observations) {
    assert.equal(o.execution_status, 'complete');
    assert.equal(o.trace.parsed_intents.length, 1);
    assert.ok(o.trace.sql.some(call => call.kind === 'inventory' && call.row_count === 1));
    assert.ok(o.trace.batches.length > 0);
    assert.equal(o.trace.product_writes, 0);
    assert.equal(o.trace.clock_now, '2026-11-01T01:00:00.000Z');
    assert.equal(o.trace.host_guards.transport_tripwire, true);
  }
  assert.ok(run.observations[0].trace.sql.some(call => call.kind === 'transactions' && call.row_count > 0));
  assert.ok(run.observations[0].trace.reader_exclusions.some(row => row.id === 3 && row.reason === 'pending SQL filter'));
  assert.ok(run.observations[0].trace.answer_window_exclusions.some(row => row.id === 4));
  assert.equal(run.provider_calls, 0);
  assert.equal(run.production_writes, 0);
  if (process.platform !== 'win32') {
    assert.equal(statSync(out).mode & 0o777, 0o700);
    for (const file of readdirSync(out)) assert.equal(statSync(join(out, file)).mode & 0o777, 0o600);
  }
  const again = successful(f, join(outputRoot(), 'repeat'));
  assert.deepEqual(again.observations, run.observations, 'frozen decisions are deterministic');
});
test('in-worktree output is refused before export parsing, including a symlink into the worktree', async () => {
  const f = await fixture(), out = join(f.dir, 'refused');
  const child = cli([f.dir, f.questions, out]);
  assert.equal(child.status, 2);
  assert.equal(child.stderr.trim(), 'PRIVATE_REPLAY_OUTPUT_IN_WORKTREE');
  assert.equal(existsSync(out), false);
  assert.equal(f.tables.fin_transactions.length, 4, 'nonempty same input as green peer');
  successful(f, join(outputRoot(), 'green'));
  if (process.platform !== 'win32') {
    const link = join(outputRoot(), 'link');
    symlinkSync(f.dir, link);
    assert.equal(cli([f.dir, f.questions, join(link, 'refused')]).stderr.trim(), 'PRIVATE_REPLAY_OUTPUT_IN_WORKTREE');
  }
});
test('existing output is preserved and never overwritten', async () => {
  const f = await fixture(), out = join(outputRoot(), 'existing');
  successful(f, out);
  const bytes = readFileSync(join(out, 'answers.json'));
  const child = cli([f.dir, f.questions, out]);
  assert.equal(child.status, 2);
  assert.equal(child.stderr.trim(), 'PRIVATE_REPLAY_OUTPUT_EXISTS');
  assert.deepEqual(readFileSync(join(out, 'answers.json')), bytes);
});
test('incomplete exports, provider secrets and unsafe integer cents fail closed with a green peer', async () => {
  const f = await fixture();
  successful(f, join(outputRoot(), 'green'));
  f.put('counts-after.json', f.d1([]));
  assert.equal(cli([f.dir, f.questions, join(outputRoot(), 'counts')]).stderr.trim(), 'PRIVATE_REPLAY_EXPORT_INVALID');
  f.put('counts-after.json', f.d1(f.api.TABLES.map(table => ({ table_name: table.name, row_count: f.counts[table.name] }))));
  const countsWithItem = f.api.TABLES.map(table => ({ table_name: table.name, row_count: f.counts[table.name] + (table.name === 'bank_feed_items' ? 1 : 0) }));
  f.put('counts-before.json', f.d1(countsWithItem));
  f.put('counts-after.json', f.d1(countsWithItem));
  f.put('bank_feed_items.json', f.d1([{ tenant_id: 'primary', item_ref: 'synthetic', last_synced_at: null, status: 'connected', removed_at: null, access_ciphertext: 'omitted' }]));
  assert.equal(cli([f.dir, f.questions, join(outputRoot(), 'projection')]).stderr.trim(), 'PRIVATE_REPLAY_EXPORT_INVALID');
  f.put('bank_feed_items.json', f.d1([]));
  for (const name of ['counts-before', 'counts-after']) f.put(`${name}.json`, f.d1(f.api.TABLES.map(table => ({ table_name: table.name, row_count: f.counts[table.name] }))));
  f.tables.fin_transactions[0].amount_minor = Number.MAX_SAFE_INTEGER + 1;
  f.put('fin_transactions.json', f.d1(f.tables.fin_transactions));
  assert.equal(cli([f.dir, f.questions, join(outputRoot(), 'integer')]).stderr.trim(), 'PRIVATE_REPLAY_EXPORT_INVALID');
});
async function candidate(f, mutate) {
  const root = mkdtempSync(join(scratch, 'candidate-'));
  mkdirSync(join(root, '.git'));
  const inventory = [];
  function copy(source, target) {
    const bytes = readFileSync(source);
    mkdirSync(resolve(target, '..'), { recursive: true });
    writeFileSync(target, bytes);
    inventory.push({ source: source.slice(ROOT.length + 1), sha256: hash(bytes) });
  }
  for (const name of readdirSync(join(ROOT, 'migrations/d1'))) if (name.endsWith('.sql')) copy(join(ROOT, 'migrations/d1', name), join(root, 'migrations/d1', name));
  const baseline = f.api.runPrivateArm(ROOT, request(f));
  for (const name of Object.keys(baseline.source_files)) copy(join(ROOT, name), join(root, name));
  writeFileSync(join(root, 'copied-sources.json'), JSON.stringify(inventory, null, 2));
  const path = join(root, 'worker/src/lib/ledger-answer.js');
  const source = readFileSync(path, 'utf8');
  writeFileSync(path, mutate(source));
  return root;
}
test('in-memory comparison detects a candidate figure mutation and preserves unchanged peers', async () => {
  const f = await fixture(), r = request(f);
  const root = await candidate(f, source => source.replace('if (answer.ledger.kind !== "balance") answer.answer +=', 'if (answer.ledger.expense_total_minor != null) answer.ledger.expense_total_minor += 1;\n          if (answer.ledger.kind !== "balance") answer.answer +='));
  const baseline = f.api.runPrivateArm(ROOT, r), changed = f.api.runPrivateArm(root, r);
  const diff = f.api.comparePrivateRuns(baseline, changed);
  assert.equal(baseline.invalid, 0);
  assert.equal(changed.invalid, 0);
  assert.equal(diff.changed_questions, 1);
  assert.ok(diff.questions[0].figures.some(v => v.path === 'ledger.expense_total_minor' && v.delta === '1'));
  assert.equal(diff.questions[1].changed, false);
  assert.equal(diff.questions[2].changed, false);
  assert.notEqual(baseline.source_digest, changed.source_digest);
});
test('in-memory network and write mutants remain fatal with reached SQL and a green control', async () => {
  const f = await fixture(), r = request(f);
  const green = f.api.runPrivateArm(ROOT, r);
  assert.equal(green.invalid, 0);
  for (const [kind, snippet] of [
    ['network', 'try { await fetch("https://synthetic.invalid"); } catch {}'],
    ['database-write', 'try { await options.env.DB.prepare("DELETE FROM fin_transactions").run(); } catch {}'],
    ['sql-contract', 'try { await options.env.DB.prepare("SELECT 1").all(); } catch {}'],
  ]) {
    const root = await candidate(f, source => source.replace('export async function withLedgerAnswer(options, next) {', `export async function withLedgerAnswer(options, next) { ${snippet}`));
    const broken = f.api.runPrivateArm(root, r);
    assert.equal(broken.invalid, 3);
    for (const o of broken.observations) {
      assert.ok(o.trace.denied_effects.includes(kind));
      assert.ok(o.trace.sql.some(call => call.kind === 'inventory' && call.row_count === 1));
      assert.equal(o.execution_status, 'harness_error');
    }
  }
});
test('in-memory provider projections change the real empty-history coverage decision', async () => {
  const f = await fixture(), r = request(f), sync = '2026-10-31T18:00:00Z';
  r.tables.fin_transactions = [];
  Object.assign(r.tables.fin_accounts[0], { feed_mode: 'live', source_feed: 'bank-feed:synthetic-item' });
  Object.assign(r.tables.fin_account_coverage[0], { covered_from: null, provenance: 'feed', source_feed: 'bank-feed:synthetic-item' });
  Object.assign(r.tables.fin_balance_snapshots[0], { current_minor: 0, available_minor: 0 });
  r.tables.bank_feed_items = [{ tenant_id: 'primary', item_ref: 'synthetic-item', status: 'connected', removed_at: null, last_synced_at: sync }];
  r.tables.bank_feed_backfill = [{ tenant_id: 'primary', item_ref: 'synthetic-item', state: 'complete', provider_history_state: 'HISTORICAL_UPDATE_COMPLETE', unread_lines: 0, requested_days: 730, queued_at: sync, finished_at: sync }];
  const green = f.api.runPrivateArm(ROOT, r);
  assert.equal(green.invalid, 0);
  assert.equal(green.observations[0].body.ledger.expense_total_minor, 0);
  assert.ok(green.observations[0].trace.sql[0].rows[0].empty_provider_from);
  r.tables.plaid_sync_windows = [{ tenant_id: 'primary', item_ref: 'synthetic-item' }];
  const refused = f.api.runPrivateArm(ROOT, r).observations[0];
  assert.equal(refused.execution_status, 'complete');
  assert.equal(refused.body.answer, null);
  assert.equal(refused.body.code, 'period_outside_coverage');
  assert.equal(refused.trace.sql[0].row_count, 1);
  assert.equal(refused.trace.sql[0].rows[0].empty_provider_from, null);
  assert.equal(refused.trace.source_row_counts.plaid_sync_windows, 1);
});
test('private replay requires versioned SimpleFIN evidence with real refusal and green peers', async () => {
  const f = await fixture(), r = request(f);
  Object.assign(r.tables.fin_accounts[0], { feed_mode: 'live', source_feed: 'bank-feed:synthetic-item', external_ref: 'synthetic-account' });
  Object.assign(r.tables.fin_account_coverage[0], { provenance: 'feed', source_feed: 'bank-feed:synthetic-item' });
  r.tables.simplefin_account_assignments = [{ tenant_id: 'primary', item_ref: 'synthetic-item', account_ref: 'synthetic-account' }];
  const { SIMPLEFIN_POSTED_HISTORY_REVISION } = await import('../worker/src/lib/bank-feed-profiles.js');
  const proof = { tenant_id: 'primary', item_ref: 'synthetic-item', state: 'promoted',
    revision: `${SIMPLEFIN_POSTED_HISTORY_REVISION}fixture`, staging_revision: `${SIMPLEFIN_POSTED_HISTORY_REVISION}fixture`, errlist_json: '[]' };
  for (const fault of [{ revision: 'legacy', staging_revision: 'legacy' }, { state: 'staged' }, { staging_revision: 'racing' }, { errlist_json: '["gap"]' }]) {
    r.tables.simplefin_sync_windows = [proof];
    const green = f.api.runPrivateArm(ROOT, r).observations[0];
    assert.equal(green.execution_status, 'complete');
    assert.ok(green.body.ledger?.expense_total_minor > 0, 'versioned source reaches the real expense decision');
    r.tables.simplefin_sync_windows = [{ ...proof, ...fault }];
    const refused = f.api.runPrivateArm(ROOT, r).observations[0];
    assert.equal(refused.execution_status, 'complete');
    assert.equal(refused.body.answer, null);
    assert.equal(refused.trace.sql[0].row_count, 1, 'invalid evidence reaches the same nonempty inventory');
    assert.equal(refused.trace.sql[0].rows[0].coverage_review_required, 1);
  }
});

test('baseline and candidate use identical inputs and expose per-question structured figure changes', async () => {
  const f = await fixture();
  const candidateRoot = await candidate(f, source => source.replace('if (answer.ledger.kind !== "balance") answer.answer +=', 'if (answer.ledger.expense_total_minor != null) answer.ledger.expense_total_minor += 1;\n          if (answer.ledger.kind !== "balance") answer.answer +='));
  const out = join(outputRoot(), 'compare');
  successful(f, out, ['--baseline', ROOT, '--candidate', candidateRoot]);
  const comparison = read(out, 'comparison.json');
  assert.equal(comparison.questions.length, 3);
  assert.equal(comparison.changed_questions, 1);
  assert.ok(comparison.questions[0].figures.some(d => d.path === 'ledger.expense_total_minor' && d.baseline === '14690' && d.candidate === '14691' && d.delta === '1'));
  assert.equal(comparison.questions[1].changed, false);
  assert.equal(comparison.questions[2].changed, false);
  assert.notEqual(read(out, 'baseline.json').source_digest, read(out, 'candidate.json').source_digest);
  assert.equal(read(out, 'baseline.json').input_digest, read(out, 'candidate.json').input_digest);
});
for (const [label, snippet, expected] of [
  ['network', 'try { await fetch("https://synthetic.invalid"); } catch {}', 'network'],
  ['builtin', 'try { await import("node:net"); } catch {}', 'dynamic-import'],
  ['write', 'try { await options.env.DB.prepare("DELETE FROM fin_transactions").run(); } catch {}', 'database-write'],
  ['unknown SQL', 'try { await options.env.DB.prepare("SELECT 1").all(); } catch {}', 'sql-contract'],
]) test(`candidate ${label} request remains fatal even when the product catches it`, async () => {
  const f = await fixture();
  const root = await candidate(f, source => source.replace('export async function withLedgerAnswer(options, next) {', `export async function withLedgerAnswer(options, next) { ${snippet}`));
  const out = join(outputRoot(), 'blocked');
  const child = cli([f.dir, f.questions, out, '--candidate', root]);
  assert.equal(child.status, 1);
  const run = read(out);
  assert.equal(run.invalid, 3);
  for (const o of run.observations) {
    assert.equal(o.execution_status, 'harness_error');
    assert.ok(o.trace.denied_effects.includes(expected), 'attempt witness survives caught exception');
    assert.ok(o.trace.sql.some(call => call.kind === 'inventory' && call.row_count > 0), 'actual ledger path also ran');
  }
});
test('offline export plan names exactly twelve reviewed tables and no credential projection', async () => {
  const f = await fixture(), out = join(outputRoot(), 'plan');
  const child = cli(['--export-plan', out, '--tenant', 'primary']);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(readdirSync(out).filter(name => name.endsWith('.sql')).length, 13);
  for (const table of f.api.TABLES) {
    const sql = readFileSync(join(out, `${table.name}.sql`), 'utf8');
    assert.match(sql, new RegExp(`FROM ${table.name} WHERE tenant_id='primary'`));
    assert.match(sql, /LIMIT 10001/);
    assert.doesNotMatch(sql, /access_ciphertext|access_iv|cursor|chunks|vectors|INSERT|UPDATE|DELETE/i);
  }
});

for (const arm of ['current', 'revoked']) test(`private replay preserves ${arm} account-kind review facts`, async () => {
  const f = await fixture(), r = request(f);
  const { accountKindIdentity } = await import('../worker/src/lib/fin-account-kinds.js');
  const account = r.tables.fin_accounts[0];
  Object.assign(account, { account_kind: 'other', balance_role: 'neither',
    currency: 'USD', external_ref: null, source_feed: null, institution: null });
  r.tables.fin_account_kind_reviews.push({ id: 1, tenant_id: 'primary', account_id: account.id,
    identity_json: accountKindIdentity(account), kind: 'checking', role: 'asset', reviewer: 'owner',
    source: 'owner_account_kind', reviewed_at: r.meta.now_utc, review_plan_hash: hash('synthetic review'),
    revoked_at: arm === 'revoked' ? r.meta.now_utc : null,
    revoke_plan_hash: arm === 'revoked' ? hash('synthetic revoke') : null });
  const counts = f.api.TABLES.map(t => ({ table_name: t.name, row_count: r.tables[t.name].length }));
  validateEnvelope(r.meta, r.tables, counts, counts, r.questions);
  const omitted = { ...r.tables };
  delete omitted.fin_account_kind_reviews;
  assert.throws(() => validateEnvelope(r.meta, omitted, counts, counts, r.questions), /EXPORT_INVALID/);
  const run = f.api.runPrivateArm(ROOT, r), o = run.observations[0];
  assert.equal(run.complete, r.questions.length);
  assert.equal(o.trace.source_row_counts.fin_account_kind_reviews, 1);
  const inventory = o.trace.sql.find(c => c.kind === 'inventory');
  assert.ok(inventory?.rows.length > 0, 'actual reviewed inventory query reached');
  assert.equal(JSON.parse(inventory.rows[0].account_kind_review_json).revoked_at, arm === 'revoked' ? r.meta.now_utc : null);
  if (arm === 'current') {
    assert.ok(o.trace.rows_read.length > 0);
    assert.equal(o.body.ledger.complete, true);
    assert.equal(o.body.ledger.classification_uncertain, false);
    assert.equal(o.body.evidence_gate.complete, true);
    assert.equal(o.body.ledger.expense_total_minor, 14690);
  } else if (arm === 'revoked') {
    assert.equal(o.body.ledger.expense_total_minor, null);
    assert.equal(o.body.ledger.classification_complete, false);
    assert.ok(o.body.answer.includes("Here is the money out I could check, with spending still unconfirmed. The account types for your account ending 3131 have not been confirmed, so some payments may be between your own accounts.\n"));
    // Deterministic ledger answers end with exactly one shared final offer, after the coverage lines.
    assert.ok(o.body.answer.endsWith("\nWant me to show your account balances?"));
    assert.equal(o.body.answer.match(/Want me to/g)?.length, 1);
    assert.doesNotMatch(o.body.answer, MONEY_JARGON);
  }
  assert.equal(run.provider_calls, 0);
  assert.equal(run.production_writes, 0);
});


test('private replay retains provider conflicts and the supported review peer', async () => {
  const f = await fixture(), r = request(f);
  const { accountKindIdentity } = await import('../worker/src/lib/fin-account-kinds.js');
  const debt = { ...r.tables.fin_accounts[0], id: 2, account_slug: 'debt', mask: '4242',
    account_kind: 'loan', balance_role: 'liability', currency: 'USD', external_ref: null, source_feed: null, institution: null };
  r.tables.fin_accounts.push(debt);
  r.tables.fin_account_coverage.push({ ...r.tables.fin_account_coverage[0], id: 2, account_slug: 'debt' });
  Object.assign(r.tables.fin_transactions[0], { description: 'payment to account 4242', payee: 'payment' });
  const review = { id: 1, tenant_id: 'primary', account_id: debt.id, identity_json: accountKindIdentity(debt),
    kind: 'loan', role: 'liability', reviewer: 'owner', source: 'owner_account_kind', reviewed_at: r.meta.now_utc,
    review_plan_hash: hash('synthetic review'), revoked_at: null, revoke_plan_hash: null };
  r.tables.fin_account_kind_reviews.push(review);
  r.questions = [r.questions[0]];
  const green = f.api.runPrivateArm(ROOT, r).observations[0];
  assert.ok(green.trace.rows_read.length > 0);
  assert.equal(green.body.ledger.expense_total_minor, 2345);
  assert.equal(green.body.ledger.own_account_payments.total_minor, 12345);
  Object.assign(review, { kind: 'checking', role: 'asset' });
  const bad = f.api.runPrivateArm(ROOT, r).observations[0];
  assert.equal(bad.execution_status, 'complete');
  assert.equal(bad.trace.source_row_counts.fin_account_kind_reviews, 1);
  assert.ok(bad.trace.rows_read.length > 0, 'directed conflict decision reached');
  const imported = bad.trace.sql.find(c => c.kind === 'inventory').rows.find(a => a.mask === '4242');
  assert.equal(imported.balance_role, 'liability');
  assert.equal(JSON.parse(imported.account_kind_review_json).kind, 'checking');
  assert.equal(bad.body.answer, null);
  assert.equal(bad.body.code, 'ledger_account_kind_review_required');
});
