// Trusted offline adapter. Product code has the same restricted VM boundary
// as money-worker.mjs. Private results use fd 3, never stdout or stderr.
import { DatabaseSync } from 'node:sqlite';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
import { readFileSync, readdirSync, realpathSync, writeSync } from 'node:fs';
import { resolve, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TABLES, sha256, figures, fail } from './private-ledger-contract.mjs';
import { armReplayStall } from './child-stall.mjs';

import { SQL_CONTRACTS } from './ledger-sql-contracts.mjs';
const LEGACY_BALANCES = '52e835bb7e812bb49c4b295f6bc663cc1a365d0fb13974d824997bf47fc45209';
const copy = value => JSON.parse(JSON.stringify(value));
function migrations(root) {
  const dir = realpathSync(resolve(root, 'migrations/d1'));
  if (dir !== resolve(root, 'migrations/d1')) fail('SOURCE_INVALID');
  return readdirSync(dir).filter(f => f.endsWith('.sql')).sort().map(f => {
    const path = resolve(dir, f);
    if (realpathSync(path) !== path) fail('SOURCE_INVALID');
    return [f, readFileSync(path, 'utf8')];
  });
}
function loadTables(db, tables) {
  for (const table of TABLES) {
    // Omitted provider credentials must never be fabricated to satisfy NOT NULL
    // constraints. TEMP projections shadow only the three status dependencies.
    if (table.columns) db.exec(`CREATE TEMP TABLE ${table.name} AS SELECT ${table.columns.join(',')} FROM main.${table.name} WHERE 0`);
    const columns = new Set(db.prepare(`PRAGMA table_info(${table.name})`).all().map(c => c.name));
    for (const row of tables[table.name]) {
      const names = Object.keys(row);
      if (names.some(name => !columns.has(name))) fail('EXPORT_INVALID');
      const quote = name => `"${name.replaceAll('"', '""')}"`;
      db.prepare(`INSERT INTO ${table.name} (${names.map(quote).join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map(name => row[name]));
    }
  }
}
export async function executePrivateReplay(request) {
  const root = realpathSync(request.root), trustedRoot = realpathSync(request.trusted_root);
  const migrationSources = migrations(root);
  // A new schema needs a separately reviewed adapter. Never execute arbitrary
  // candidate migration SQL before the product capability boundary exists.
  if (!migrationSources.length || sha256(migrationSources) !== sha256(migrations(trustedRoot))) fail('MIGRATIONS_UNREVIEWED');
  const db = new DatabaseSync(':memory:');
  const sourceFiles = new Map(), observations = [];
  try {
    for (const [, sql] of migrationSources) db.exec(sql);
    loadTables(db, request.tables);
    db.exec('PRAGMA query_only=ON');
    const writes = db.prepare('SELECT total_changes() n').get().n;
    for (const question of request.questions) {
      const trace = { parsed_intents: [], sql: [], batches: [], denied_effects: [], rows_read: [],
        fallback_calls: 0, model_calls: 0, clock_now: request.meta.now_utc,
        owner_time_zone: request.meta.owner_time_zone, source_row_counts: Object.fromEntries(TABLES.map(t => [t.name, request.tables[t.name].length])) };
      trace.host_guards = {
        transport_tripwire: Boolean(globalThis[Symbol.for('brain.test.cli-side-effect-tripwire.installed')]),
        scoped_read: process.permission.has('fs.read', root),
        external_read: process.permission.has('fs.read', '/private-replay-no-access'),
        subprocess: process.permission.has('child'), filesystem_write: process.permission.has('fs.write', root),
      };
      if (!trace.host_guards.transport_tripwire || !trace.host_guards.scoped_read || trace.host_guards.external_read ||
          trace.host_guards.subprocess || trace.host_guards.filesystem_write) fail('HOST_GUARD_MISSING');
      const fatal = [];
      const deny = kind => { fatal.push(kind); trace.denied_effects.push(kind); throw Error('OFFLINE_DEPENDENCY_DENIED'); };
      const context = createContext({ Response, Request, Headers, URL, TextEncoder, TextDecoder,
        fetch: () => deny('network'), WebSocket: function () { return deny('network'); },
        process: new Proxy({}, { get: () => deny('process') }), require: () => deny('subprocess'),
      }, { codeGeneration: { strings: false, wasm: false } });
      // Freeze ambient Date as well as the explicit withLedgerAnswer clock.
      const clockModule = new SourceTextModule(`const NativeDate = Date; globalThis.Date = class extends NativeDate {
        constructor(...args) { super(...(args.length ? args : [${Date.parse(request.meta.now_utc)}])); }
        static now() { return ${Date.parse(request.meta.now_utc)}; }
      };`, { context });
      await clockModule.link(() => deny('module'));
      await clockModule.evaluate({ timeout: 1000 });
      const cache = new Map(), base = resolve(root, 'worker/src/lib');
      const linker = (specifier, parent) => {
        if (!specifier.startsWith('./')) return deny('module');
        return load(resolve(dirname(parent.identifier), specifier));
      };
      const load = path => {
        if (cache.has(path)) return cache.get(path);
        const inside = relative(base, path);
        if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || !inside.endsWith('.js') || realpathSync(path) !== path) return deny('module');
        const source = readFileSync(path, 'utf8');
        const sourceKey = relative(root, path).split(sep).join('/');
        if (sourceFiles.has(sourceKey) && sourceFiles.get(sourceKey) !== sha256(source)) return deny('source-changed');
        sourceFiles.set(sourceKey, sha256(source));
        const module = new SourceTextModule(source, { context, identifier: path, importModuleDynamically: () => deny('dynamic-import') });
        cache.set(path, module);
        return module;
      };
      // Let VM link each whole graph once; recursive per-module linking races
      // shared dependencies still in the linking state. Trace the leaf first.
      {
        const path = resolve(base, 'ledger-question.js');
        const module = load(path);
        await module.link(linker);
        await module.evaluate({ timeout: 1000 });
        const wrapped = new SyntheticModule(Object.keys(module.namespace), function () {
          for (const name of Object.keys(module.namespace)) this.setExport(name, name === 'classifyLedgerQuestion'
            ? (...args) => { const intent = module.namespace[name](...args); trace.parsed_intents.push(copy(intent)); return intent; }
            : module.namespace[name]);
        }, { context, identifier: path + ':trace' });
        await wrapped.link(() => deny('module'));
        await wrapped.evaluate();
        cache.set(path, wrapped);
      }
      let batchNumber = 0;
      const execute = (sql, binds, method, batch = null) => {
        const call = { sql, binds: binds.map(value => ({ type: value === null ? 'null' : typeof value, value })), method, batch };
        trace.sql.push(call);
        if (!/^(SELECT|WITH)\b/.test(sql.trim()) || /\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|ATTACH|PRAGMA)\b/i.test(sql)) return deny('database-write');
        const kind = SQL_CONTRACTS.get(sha256(sql));
        if (!kind || (batch === null && (kind !== 'inventory' || method !== 'all')) ||
            (kind === 'inventory' && (binds.length !== 2 || binds[0] !== request.meta.tenant_id || binds[1] !== 201)) ||
            (kind === 'transactions' && (binds.length !== 6 || binds[1] !== request.meta.tenant_id || binds[5] !== 5001)) ||
            (kind === 'balances' && (binds[1] !== request.meta.tenant_id || (sha256(sql) === LEGACY_BALANCES ? binds.length !== 2 :
              binds.length !== 3 || binds[2] !== new Intl.DateTimeFormat('en-CA', { timeZone: request.meta.owner_time_zone,
                year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(request.meta.now_utc)))))) return deny('sql-contract');
        let rows;
        try { rows = db.prepare(sql).all(...binds); }
        catch { return deny('sqlite-read'); }
        call.kind = kind; call.row_count = rows.length; call.rows = copy(rows);
        if (kind === 'transactions') trace.rows_read.push(...copy(rows));
        return { success: true, results: rows };
      };
      const prepared = (sql, binds = []) => ({ sql, binds, bind: (...values) => prepared(sql, values),
        all: async () => execute(sql, binds, 'all'), first: async () => execute(sql, binds, 'first').results[0] || null,
        run: async () => execute(sql, binds, 'run'),
      });
      const binding = { prepare: prepared, async batch(statements) {
        const batch = ++batchNumber;
        trace.batches.push({ id: batch, size: statements.length });
        if (statements.length !== 2 || SQL_CONTRACTS.get(sha256(statements[0].sql)) !== 'inventory') return deny('sql-contract');
        db.exec('SAVEPOINT private_batch');
        try { const result = statements.map(s => execute(s.sql, s.binds, 'batch', batch)); db.exec('RELEASE private_batch'); return result; }
        catch (error) { db.exec('ROLLBACK TO private_batch'); db.exec('RELEASE private_batch'); throw error; }
      } };
      let body = null;
      try {
        const module = load(resolve(base, 'ledger-answer.js'));
        await module.link(linker);
        await module.evaluate({ timeout: 1000 });
        const response = await module.namespace.withLedgerAnswer({
          env: { STORAGE: 'd1', BANK_FEED_TENANT: request.meta.tenant_id, BRAIN_TIMEZONE: request.meta.owner_time_zone, DB: binding,
            AI: { run: () => { trace.model_calls++; return deny('model'); } },
            VECTORIZE: new Proxy({}, { get: () => deny('vector') }) },
          question: question.question, now: request.meta.now_utc, scopePrincipalKind: 'owner', grantScope: { all: true },
        }, async gap => {
          trace.fallback_calls++;
          return Response.json({ answer: null, citations: [], gaps: gap ? [gap] : [], document_path_tested: false });
        });
        body = await response.json();
        trace.cents = figures(body);
      } catch { if (!fatal.length) fatal.push('unexpected-dependency'); }
      trace.product_writes = db.prepare('SELECT total_changes() n').get().n - writes;
      if (trace.product_writes) fatal.push('write-detected');
      trace.route = body?.ledger ? `ledger:${body.ledger.kind}` : trace.fallback_calls ? 'documents_unexecuted' : 'ledger:refusal';
      trace.semantic_exclusions = { own_account_payments: body?.ledger?.own_account_payments ?? null,
        own_transfer_minor: body?.ledger?.excluded_own_transfer_minor ?? null, default_exclusions: body?.ledger?.default_exclusions ?? null };
      const reached = trace.sql.some(call => call.kind === 'transactions');
      const readIds = new Set(trace.rows_read.map(row => row.id));
      trace.reader_exclusions = request.tables.fin_transactions.filter(row => !readIds.has(row.id)).map(row => ({
        id: row.id, reason: !reached ? 'transaction reader not reached' : row.pending ? 'pending SQL filter'
          : row.superseded_by_id !== null && row.superseded_by_id !== undefined ? 'superseded SQL filter'
            : row.removed_at ? 'removed SQL filter' : 'outside selected SQL mapping or interval',
      }));
      const intent = trace.parsed_intents[0];
      trace.answer_window_exclusions = intent?.from && intent?.to ? trace.rows_read.filter(row => row.posted_on &&
        (row.posted_on < intent.from || row.posted_on > intent.to)).map(row => ({ id: row.id, reason: 'read padding outside parsed answer interval' })) : [];
      observations.push({ id: question.id, execution_status: fatal.length ? 'harness_error' : 'complete', fatal,
        body, trace, question_digest: sha256(question) });
    }
    return { schema: 1, mode: 'private-ledger-offline', node_version: process.version, input_digest: request.input_digest,
      migration_digest: sha256(migrationSources), source_files: Object.fromEntries(sourceFiles),
      source_digest: sha256([...sourceFiles].sort(([a], [b]) => a.localeCompare(b))), observations,
      complete: observations.filter(o => o.execution_status === 'complete').length,
      invalid: observations.filter(o => o.execution_status !== 'complete').length,
      provider_calls: observations.reduce((n, o) => n + o.trace.model_calls, 0),
      production_writes: observations.reduce((n, o) => n + o.trace.product_writes, 0) };
  } finally { db.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  armReplayStall();
  try { writeSync(3, JSON.stringify(await executePrivateReplay(JSON.parse(readFileSync(0, 'utf8'))))); }
  catch { process.stderr.write('PRIVATE_REPLAY_WORKER_FAILED\n'); process.exitCode = 2; }
}
