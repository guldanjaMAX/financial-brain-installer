// Trusted host adapter. Product modules run without host filesystem/process imports.
import { DatabaseSync } from 'node:sqlite';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, relative, dirname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const digest = value => createHash('sha256').update(value).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
// Exact reviewed templates over a complete tiny relational envelope. A SQL
// edit needs an explicit adapter review, rather than a successful empty read.
const SQL_CONTRACTS = new Map([
  ['4854d478915c18d7ae5b6a21138d35925f4053a5c5bf0f5499f412a88dea0c17', 'inventory'],
  ['75a8b53f9dd622790714fac513fd4d5f38797b9a7f7667bf5967b80891223c7d', 'transactions'],
  ['52e835bb7e812bb49c4b295f6bc663cc1a365d0fb13974d824997bf47fc45209', 'balances'],
]);
export async function executeReplay(request) {
  const started = performance.now();
  const root = realpathSync(request.root);
  const db = new DatabaseSync(':memory:');
  const migrations = readdirSync(resolve(root, 'migrations/d1')).filter(f => f.endsWith('.sql')).sort();
  const migrationSources = migrations.map(f => [f, readFileSync(resolve(root, 'migrations/d1', f), 'utf8')]);
  for (const [, source] of migrationSources) db.exec(source);
  const migrationDigest = digest(JSON.stringify(migrationSources));
  const setupMs = performance.now() - started;
  const sourceDigests = new Map();
  const observations = [];
  const warmStarted = performance.now();
  try {
    for (const input of request.inputs) {
      const caseStarted = performance.now();
      const trace = { parsed_intents: [], sql: [], batches: [], dependencies: [], rows_read: [],
        exclusions: [], fixture_rows: input.snapshot.rows.length, fixture_accounts: input.snapshot.accounts.length,
        fallback_calls: 0, model_calls: 0, denied_effects: [], import: null };
      trace.host_guards = { transport_tripwire: Boolean(globalThis[Symbol.for('brain.test.cli-side-effect-tripwire.installed')]),
        scoped_read: process.permission.has('fs.read', root),
        external_read: process.permission.has('fs.read', resolve(root, '../synthetic-private')),
        subprocess: process.permission.has('child'), filesystem_write: process.permission.has('fs.write', root) };
      if (!trace.host_guards.transport_tripwire || !trace.host_guards.scoped_read || trace.host_guards.external_read ||
        trace.host_guards.subprocess || trace.host_guards.filesystem_write) throw Error('HOST_GUARD_MISSING');
      const fatal = [];
      const fail = (code, kind = code) => { fatal.push(code); trace.denied_effects.push(kind); throw Error(code); };
      const context = createContext({
        Response, Request, Headers, URL, TextEncoder, TextDecoder,
        fetch: () => fail('CAPABILITY_DENIED', 'network'),
        WebSocket: function () { return fail('CAPABILITY_DENIED', 'network'); },
        process: new Proxy({}, { get: () => fail('CAPABILITY_DENIED', 'process') }),
        require: () => fail('CAPABILITY_DENIED', 'subprocess'),
      }, { codeGeneration: { strings: false, wasm: false } });
      const moduleCache = new Map();
      const base = resolve(root, 'worker/src/lib');
      const linker = async (specifier, parent) => {
        if (!specifier.startsWith('./')) return fail('CAPABILITY_DENIED', 'module');
        return load(resolve(dirname(parent.identifier), specifier));
      };
      const load = async path => {
        if (moduleCache.has(path)) return moduleCache.get(path);
        const inside = relative(base, path);
        if (!inside || inside.startsWith(`..${sep}`) || inside === '..' || !inside.endsWith('.js') ||
          realpathSync(path) !== path) return fail('CAPABILITY_DENIED', 'module');
        const source = readFileSync(path, 'utf8');
        sourceDigests.set(relative(root, path), digest(source));
        const module = new SourceTextModule(source, { context, identifier: path,
          importModuleDynamically: () => fail('CAPABILITY_DENIED', 'dynamic-import') });
        moduleCache.set(path, module);
        await module.link(linker);
        // Observe the actual exported classifier called inside withLedgerAnswer.
        if (path === resolve(base, 'ledger-question.js')) {
          await module.evaluate({ timeout: 1000 });
          const names = Object.keys(module.namespace);
          const wrapped = new SyntheticModule(names, function () {
            for (const name of names) this.setExport(name, name === 'classifyLedgerQuestion'
              ? (...args) => { const intent = module.namespace[name](...args); trace.parsed_intents.push(copy(intent)); return intent; }
              : module.namespace[name]);
          }, { context, identifier: `${path}:trace` });
          await wrapped.link(() => fail('CAPABILITY_DENIED', 'module'));
          await wrapped.evaluate();
          moduleCache.set(path, wrapped);
          return wrapped;
        }
        return module;
      };
      db.exec('BEGIN');
      try {
        seed(db, input.snapshot, input.clock.now_utc);
        if (input.snapshot.reset_import) {
          const importer = await load(resolve(base, 'fin-import.js'));
          await importer.evaluate({ timeout: 1000 });
          const reset = input.snapshot.reset_import;
          const plan = importer.namespace.prepareBankExportImport({ ok: true, accounts: [{
            accountKey: reset.account, accountKind: reset.kind, balanceRole: reset.role,
            mask: '4242', transactions: [],
          }] }, { entitySlug: 'owner', now: input.clock.now_utc,
            origin: { provenance: 'feed', sourceFeed: 'bank-feed:synthetic' } });
          trace.import = { statements: plan.statements.length,
            before: copy(db.prepare("SELECT account_kind,balance_role FROM fin_accounts WHERE account_slug='debt'").get()) };
          if (!plan.receipt.imported || plan.statements.length < 2) fail('IMPORT_PLAN_MISSING');
          for (const [sql, binds] of plan.statements) db.prepare(sql).run(...binds);
          trace.import.after = copy(db.prepare("SELECT account_kind,balance_role FROM fin_accounts WHERE account_slug='debt'").get());
        }
        const snapshotCounts = db.prepare('SELECT total_changes() n').get().n;
        db.exec('PRAGMA query_only=ON');
        let batchNumber = 0;
        const execute = (sql, binds, method, batch = null) => {
          if (request.fault === 'sql') sql = 'SELECT 1 AS unrecorded';
          if (request.fault === 'bind') binds = ['outside-snapshot', ...binds.slice(1)];
          const call = { sql, binds: binds.map(v => ({ type: v === null ? 'null' : typeof v, value: v })), method, batch };
          trace.sql.push(call);
          if (!/^(?:SELECT|WITH)\b/.test(sql.trim()) || /\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|ATTACH|PRAGMA)\b/i.test(sql)) return fail('WRITE_DENIED', 'database-write');
          const kind = SQL_CONTRACTS.get(digest(sql));
          if (!kind || (kind !== 'inventory' && batch === null) ||
            (batch === null && method !== 'all') ||
            (kind === 'inventory' && (binds.length !== 2 || binds[0] !== 'primary' || binds[1] !== 201))) return fail('SNAPSHOT_MISS');
          if (kind === 'transactions') {
            // The envelope is the complete tiny synthetic database, including
            // padding, pending and future rows. Wider requests are never empty defaults.
            if (binds.length !== 6 || binds[1] !== 'primary' || binds[2] < '2026-06-25' || binds[3] > '2026-11-07' || binds[5] !== 5001 ||
              ![null, 'number'].includes(binds[4] === null ? null : typeof binds[4]))
              return fail('SNAPSHOT_MISS');
            const mapping = JSON.parse(binds[0]);
            if (!mapping.length || mapping.some(m => !input.snapshot.accounts.some(a => a.slug === m.slug))) return fail('SNAPSHOT_MISS');
          }
          if (kind === 'balances' && (binds.length !== 2 || binds[1] !== 'primary')) return fail('SNAPSHOT_MISS');
          trace.dependencies.push(kind);
          let result;
          try { result = db.prepare(sql).all(...binds); } catch { return fail('SQLITE_DEPENDENCY_FAILURE'); }
          call.kind = kind; call.row_count = result.length; call.row_ids = result.map(r => r.id);
          call.rows = copy(result);
          if (kind === 'transactions') trace.rows_read.push(...copy(result));
          return { success: true, results: result };
        };
        const prepared = (sql, binds = []) => ({ sql, binds,
          bind: (...values) => prepared(sql, values),
          all: async () => execute(sql, binds, 'all'),
          first: async () => { const result = execute(sql, binds, 'first'); return result.results[0] || null; },
          run: async () => execute(sql, binds, 'run'),
        });
        const binding = { prepare: prepared, async batch(statements) {
          const batch = ++batchNumber;
          trace.batches.push({ id: batch, size: statements.length });
          if (statements.length !== 2 || !statements[0].sql.startsWith('SELECT a.id,a.account_slug')) return fail('SNAPSHOT_MISS');
          db.exec('SAVEPOINT replay_batch');
          try {
            const result = statements.map(s => execute(s.sql, s.binds, 'batch', batch));
            db.exec('RELEASE replay_batch'); return result;
          } catch (error) { db.exec('ROLLBACK TO replay_batch'); db.exec('RELEASE replay_batch'); throw error; }
        } };
        const env = { STORAGE: 'd1', BRAIN_TIMEZONE: input.clock.owner_time_zone, DB: binding,
          AI: { run: () => { trace.model_calls++; return fail('MODEL_TAPE_MISS'); } },
          VECTORIZE: new Proxy({}, { get: () => fail('SNAPSHOT_MISS') }) };
        const module = await load(resolve(base, 'ledger-answer.js'));
        await module.evaluate({ timeout: 1000 });
        if (request.fault === 'transport') await fetch('https://synthetic.invalid');
        if (request.fault === 'network') { try { await context.fetch('https://synthetic.invalid'); } catch {} }
        if (request.fault === 'credential') { try { context.process.env; } catch {} }
        if (request.fault === 'subprocess') { try { context.require('node:child_process'); } catch {} }
        if (request.fault === 'module') {
          const probe = new SourceTextModule("import 'node:fs';", { context, identifier: resolve(base, 'probe.js') });
          try { await probe.link(linker); } catch {}
        }
        if (request.fault === 'write') { try { await binding.prepare('DELETE FROM fin_transactions').run(); } catch {} }
        const response = await module.namespace.withLedgerAnswer({ env, question: input.question,
          now: input.clock.now_utc, scopePrincipalKind: input.principal.kind,
          grantScope: { all: input.principal.all } }, async gap => {
          trace.fallback_calls++;
          return Response.json({ answer: null, citations: [], gaps: gap ? [gap] : [], document_path_tested: false });
        });
        const body = await response.json();
        const after = db.prepare('SELECT total_changes() n').get().n;
        if (after !== snapshotCounts) fail('REPLAY_WRITE_DETECTED');
        trace.product_writes = after - snapshotCounts;
        trace.route = body.ledger ? `ledger:${body.ledger.kind}` : trace.fallback_calls ? 'documents_unexecuted' : 'ledger:refusal';
        trace.cents = monetaryFields(body.ledger || {});
        const readIds = new Set(trace.rows_read.map(r => r.id));
        trace.exclusions = input.snapshot.rows.filter(r => !readIds.has(r.id)).map(r => ({ id: r.id,
          reason: !trace.dependencies.includes('transactions') ? 'transaction reader not reached'
            : r.pending ? 'pending SQL filter' : 'outside selected SQL interval' }));
        trace.semantic_exclusions = { own_account_payments: body.ledger?.own_account_payments || null,
          own_transfer_minor: body.ledger?.excluded_own_transfer_minor ?? null,
          default_exclusions: body.ledger?.default_exclusions || null };
        const intent = trace.parsed_intents[0];
        trace.answer_window_exclusions = intent?.from && intent?.to ? trace.rows_read
          .filter(r => r.posted_on && (r.posted_on < intent.from || r.posted_on > intent.to))
          .map(r => ({ id: r.id, reason: 'read padding outside parsed answer interval' })) : [];
        observations.push({ id: input.id, base: input.base, route: trace.route,
          execution_status: fatal.length ? 'harness_error' : 'complete', fatal: [...fatal],
          body, trace, input_digest: digest(JSON.stringify(input)), elapsed_ms: performance.now() - caseStarted });
      } catch (error) {
        observations.push({ id: input.id, base: input.base, execution_status: 'harness_error',
          fatal: [...fatal, fatal.length ? null : 'UNEXPECTED_DEPENDENCY'].filter(Boolean),
          error_code: error.code || error.name, trace, input_digest: digest(JSON.stringify(input)), elapsed_ms: performance.now() - caseStarted });
      } finally { db.exec('PRAGMA query_only=OFF'); db.exec('ROLLBACK'); }
    }
    return { schema: 1, mode: 'real-ledger-synthetic-sqlite', node_version: process.version, observations,
      setup_ms: setupMs, warm_ms: performance.now() - warmStarted,
      migration_digest: migrationDigest,
      source_digest: digest(JSON.stringify([...sourceDigests].sort(([a], [b]) => a.localeCompare(b)))),
      source_files: Object.fromEntries(sourceDigests),
      provider_calls: observations.reduce((sum, o) => sum + o.trace.model_calls, 0),
      production_writes: observations.reduce((sum, o) => sum + (o.trace.product_writes || 0), 0) };
  } finally { db.close(); }
}

function seed(db, snapshot, now) {
  db.prepare(`INSERT INTO fin_entities (entity_slug,legal_name,display_label,kind,status,relationship,provenance,basis_state,recorded_at)
    VALUES ('owner','Synthetic owner','Synthetic owner','business','active','owned','owner_stated','confirmed',?)`).run(now);
  for (const a of snapshot.accounts) {
    db.prepare(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,basis_state,recorded_at)
      VALUES (?,'owner',?,?,?,?,'manual','owner_stated','confirmed',?)`).run(a.slug, a.kind, a.role, a.mask, a.label, now);
    db.prepare(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES (?,?,?,?,?,'owner_stated','confirmed',?)`).run(a.slug, a.coverage, a.from, a.to, now, now);
    db.prepare(`INSERT INTO fin_balance_snapshots (account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at)
      VALUES (?,?,?,'owner_stated','confirmed',?)`).run(a.slug, a.observed, Number(a.balance), now);
  }
  for (const r of snapshot.rows) db.prepare(`INSERT INTO fin_transactions
    (id,txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,pending,provenance,basis_state,recorded_at)
    VALUES (?,?,?,?,?,?,?,?,?,'owner_stated','confirmed',?)`).run(r.id, r.uid, r.account, r.date, Number(r.cents), r.direction, r.description, r.payee, r.pending, now);
}

function monetaryFields(value, path = '') {
  return Object.entries(value).flatMap(([name, item]) => {
    const next = path ? `${path}.${name}` : name;
    if (/_minor$/.test(name) && item !== null && typeof item !== 'object') return [{ path: next, cents: String(item) }];
    return item && typeof item === 'object' ? monetaryFields(item, next) : [];
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url))) {
  try {
    const request = JSON.parse(readFileSync(0, 'utf8'));
    process.stdout.write(JSON.stringify(await executeReplay(request)));
  } catch { process.stderr.write('REPLAY_HOST_FAILURE\n'); process.exitCode = 2; }
}
