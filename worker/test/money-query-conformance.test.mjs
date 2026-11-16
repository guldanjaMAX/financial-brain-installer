import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, constants as C } from 'node:sqlite';
const { validateMoneySql, MONEY_TABLES, queryMoney } = await import(process.env.MONEY_QUERY_TEST_MODULE || '../src/lib/money-query.js');

// The authorizer oracle is independent of the product EXPLAIN decision.
// Enforce both mismatch directions on every run, including the offline chain.
const listed = new Set(MONEY_TABLES);
const SEED = 0x1111c;
// Node 22's SQLite binding lacks the authorizer. Keep that missing host proof
// visible in TAP; never substitute the product lexer as its own reference.
const oracleOptions = { skip: typeof DatabaseSync.prototype.setAuthorizer !== 'function'
  ? 'SQLite authorizer unavailable: run this reference gate on Node 24.18 or newer' : false };

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  for (const name of readdirSync(new URL('../../migrations/d1/', import.meta.url)).filter(n => n.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(`../../migrations/d1/${name}`, import.meta.url), 'utf8'));
  }
  db.exec(`INSERT INTO fin_entities(entity_slug,legal_name,kind,provenance,basis_state,recorded_at)
    VALUES ('business','Synthetic business','business','owner_stated','confirmed','2026-01-01');
    INSERT INTO fin_accounts(account_slug,entity_slug,label,account_kind,balance_role,feed_mode,provenance,basis_state,recorded_at)
    VALUES ('synthetic','business','Synthetic account','checking','asset','manual','owner_stated','confirmed','2026-01-01');`);
  // json_each may initialize its eponymous virtual table during first prepare.
  // Warm it before installing the authorizer, so internal initialization is not
  // mistaken for a write requested by the submitted statement.
  db.prepare("SELECT value FROM json_each('[1]')").all();
  return db;
}

// Independent SQL statement boundary scanner; unlike the product lexer it
// accepts SQLite quoting, comments and an optional final semicolon. Preparation
// alone is insufficient: SQLite prepares only the first statement of a batch.
function statements(sql) {
  const parts = []; let start = 0, quote = null, content = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i], next = sql[i + 1];
    if (quote) {
      if (ch === quote) {
        if (quote !== ']' && next === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (ch === '-' && next === '-') { while (i < sql.length && sql[i] !== '\n') i++; continue; }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) throw new Error('unterminated reference comment');
      i = end + 1; continue;
    }
    if (ch === ';') {
      if (content) parts.push(sql.slice(start, i));
      start = i + 1; content = false; continue;
    }
    if (!/\s/.test(ch)) content = true;
    if (['"', "'", '`', '['].includes(ch)) quote = ch === '[' ? ']' : ch;
  }
  if (quote) throw new Error('unterminated reference quote');
  if (content) parts.push(sql.slice(start));
  return parts;
}

function reference(db, sql) {
  const reads = new Set(), actions = new Set();
  const parts = statements(sql);
  if (parts.length !== 1) return { safe: false, reason: 'multiple-statements', reads: [] };
  let valid = true;
  db.setAuthorizer((action, table) => {
    actions.add(action);
    if (action === C.SQLITE_READ) reads.add(table.toLowerCase());
    // Compile, never execute user SQL. Authorizer events include reads in
    // scalar subqueries/CTEs even when SQLite optimizes their execution away.
    return C.SQLITE_OK;
  });
  try { db.prepare(`EXPLAIN ${parts[0]}`).all(); }
  catch { valid = false; }
  finally { db.setAuthorizer(null); }
  const readOnly = [...actions].every(a => [C.SQLITE_SELECT, C.SQLITE_READ, C.SQLITE_FUNCTION, C.SQLITE_RECURSIVE].includes(a));
  // The grammar has finite literals, at most two relation leaves per SELECT,
  // and no explosive functions. Its only unbounded production is an infinite
  // recursive CTE. SQLITE_RECURSIVE detects it without ever running it. This is
  // a grammar-scoped work proof, not a claim about arbitrary SQL or live size.
  const bounded = !actions.has(C.SQLITE_RECURSIVE);
  const outside = [...reads].filter(n => !listed.has(n) && n !== 'json_each');
  const reason = !valid ? 'invalid' : !readOnly ? 'write' : !bounded ? 'unbounded' : outside.length ? 'outside-table' : 'safe';
  return { safe: reason === 'safe', reason, valid, readOnly, bounded, reads: [...reads].sort() };
}

async function accepts(db, sql) { try { await validateMoneySql(sql, async q => db.prepare(q).all()); return true; } catch { return false; } }
async function compare(db, cases, decision = sql => accepts(db, sql)) {
  return Promise.all(cases.map(async c => {
    const ref = reference(db, c.sql), accepted = await decision(c.sql);
    return { ...c, ref, accepted, mismatch: accepted && !ref.safe ? 'mismatch_accept' : !accepted && ref.safe ? 'mismatch_reject' : null };
  }));
}
function assertConforms(rows) {
  const bad = rows.filter(r => r.mismatch);
  const summary = ['mismatch_accept', 'mismatch_reject'].map(k => `${k}=${bad.filter(r => r.mismatch === k).length}`).join(' ');
  assert.equal(bad.length, 0, summary);
}

function corpus() {
  const cases = [], seen = new Set();
  const add = (kind, sql, feature = kind) => { if (!seen.has(sql)) { seen.add(sql); cases.push({ kind, feature, sql }); } };
  const spellings = [
    ['bare', n => n], ['upper', n => n.toUpperCase()], ['double-quoted', n => `"${n}"`],
    ['bracketed', n => `[${n}]`], ['backtick', n => '`' + n + '`'],
    ['single-quoted', n => `'${n}'`], ['schema-qualified', n => `main.${n}`],
  ];
  const forms = [
    ['alias', r => `SELECT 1 AS n FROM ${r} AS a LIMIT 2`],
    ['cte', r => `WITH x AS (SELECT 1 AS n FROM ${r}) SELECT n FROM x LIMIT 2`],
    ['in', r => `SELECT 1 FROM fin_accounts WHERE 1 IN (SELECT 1 FROM ${r}) LIMIT 2`],
    ['exists', r => `SELECT 1 FROM fin_accounts WHERE EXISTS (SELECT 1 FROM ${r}) LIMIT 2`],
    ['scalar', r => `SELECT (SELECT count(*) FROM ${r}) AS n`],
    ['union', r => `SELECT 1 FROM ${r} UNION SELECT 1 FROM fin_accounts LIMIT 2`],
    ['derived', r => `SELECT n FROM (SELECT 1 AS n FROM ${r}) LIMIT 2`],
  ];
  for (const table of [...MONEY_TABLES, 'owner_passkeys', 'bank_feed_items', 'chunks']) {
    for (const [feature, spelling] of spellings) {
      const relation = spelling(table);
      add('identifier', `SELECT count(*) FROM ${relation}`, feature);
      for (const [kind, form] of forms) add(kind, form(relation), feature);
    }
  }
  for (const [kind, sql] of [
    ['json_each', "SELECT value FROM json_each('[1,2]')"],
    ['json_each', "SELECT a.id,j.value FROM fin_accounts a,json_each('[1,2]') j"],
    ['values', 'WITH x(n) AS (VALUES (1),(2)) SELECT n FROM x'],
    ['values', 'SELECT * FROM (VALUES (1),(2))'],
    ['values', 'SELECT 1 IN (VALUES (1),(2))'],
    ['cte-shadow', 'WITH fin_accounts AS (SELECT 1 AS id) SELECT id FROM fin_accounts'],
    ['cte-forward', 'WITH x AS (SELECT * FROM y),y AS (SELECT id FROM fin_accounts) SELECT * FROM x'],
    ['cte-private-name', 'WITH owner_passkeys AS (SELECT 1 AS id) SELECT id FROM owner_passkeys'],
    ['in-shorthand', 'WITH x(n) AS (VALUES (1)) SELECT 1 IN x'],
    ['semicolon', 'SELECT 1;'],
    ['comment', 'SELECT 1 -- synthetic\n'],
    ['literal-private-name', "SELECT 'owner_passkeys'"],
    ['literal-semicolon', "SELECT ';'"],
    ['literal-recursive', "SELECT 'recursive'"],
    ['literal-comment', "SELECT '--'"],
    ['multiple', 'SELECT 1; SELECT 2'],
    ['write', 'UPDATE fin_accounts SET label=label'],
    ['write', 'DELETE FROM fin_accounts'],
    ['unbounded', 'WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM x) SELECT count(*) FROM x'],
  ]) add(kind, sql);
  // Fixed-seed composition varies nesting, relation, case and quote spelling;
  // exhaustive shallow productions above retain small reproducible witnesses.
  let state = SEED;
  const pick = n => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n; };
  for (let i = 0; i < 1200; i++) {
    const table = [...MONEY_TABLES, 'owner_passkeys', 'chunks'][pick(MONEY_TABLES.length + 2)];
    const [kind, form] = forms[pick(forms.length)];
    const [feature, spelling] = spellings[pick(spellings.length)];
    let sql = form(spelling(table));
    if (pick(2)) sql = `WITH selected AS (${sql}) SELECT * FROM selected LIMIT 2`;
    if (pick(2)) sql = sql.replace(/SELECT|FROM|WHERE|WITH|AS|LIMIT/g, w => w[0] + w.slice(1).toLowerCase());
    add(`generated-${kind}`, sql, feature);
  }
  return cases;
}

test('SQLite oracle distinguishes table reads, writes, batches and unbounded recursion', oracleOptions, async t => {
  const db = fixture(t);
  assert.deepEqual(reference(db, 'SELECT count(*) FROM fin_accounts').reads, ['fin_accounts']);
  for (const sql of ['SELECT 1;', "SELECT ';'", 'SELECT 1 -- synthetic\n', "SELECT value FROM json_each('[1]')"]) assert.equal(reference(db, sql).safe, true, sql);
  for (const [sql, reason] of [
    ['SELECT count(*) FROM owner_passkeys', 'outside-table'],
    ['SELECT (SELECT count(*) FROM owner_passkeys) FROM fin_accounts', 'outside-table'],
    ["UPDATE fin_accounts SET label='Changed synthetic'", 'write'],
    ['DELETE FROM fin_accounts', 'write'],
    ['SELECT 1; SELECT 2', 'multiple-statements'],
    ['WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM x) SELECT count(*) FROM x', 'unbounded'],
  ]) assert.equal(reference(db, sql).reason, reason, sql);
  assert.equal(db.prepare('SELECT label FROM fin_accounts').get().label, 'Synthetic account', 'reference never executes writes');
  assert.equal(db.prepare('SELECT count(*) AS n FROM fin_accounts').get().n, 1, 'reference never executes deletion');
});

test('generated validator decisions are compared in both directions with minimal grammar witnesses', oracleOptions, async t => {
  const db = fixture(t), cases = corpus(), rows = await compare(db, cases);
  assert.ok(cases.length > 2000);
  // Every positive production must compile against the real migrations. An
  // invalid generated query is a harness bug, never a validator rejection win.
  assert.deepEqual(rows.filter(r => r.ref.reason === 'invalid').map(r => r.sql), []);
  const counts = Object.fromEntries(['mismatch_accept', 'mismatch_reject'].map(k => [k, rows.filter(r => r.mismatch === k).length]));
  t.diagnostic(`seed=${SEED} statements=${rows.length} mismatch_accept=${counts.mismatch_accept} mismatch_reject=${counts.mismatch_reject}`);
  const minimal = new Map();
  for (const row of rows.filter(r => r.mismatch)) {
    const key = `${row.mismatch}/${row.feature}/${row.ref.reason}`;
    if (!minimal.has(key) || row.sql.length < minimal.get(key).sql.length) minimal.set(key, row);
  }
  for (const [kind, row] of [...minimal].sort(([a], [b]) => a.localeCompare(b))) t.diagnostic(`${kind}: ${JSON.stringify(row.sql)} reads=${JSON.stringify(row.ref.reads)}`);
  assert.equal(counts.mismatch_accept, 0, 'unsafe acceptance is always a failing property');
  assertConforms(rows);
});

test('strict conformance assertion kills accept-all and reject-all decision mutants', oracleOptions, async t => {
  const db = fixture(t);
  for (const [kind, sql] of [
    ['outside-table', 'SELECT count(*) FROM owner_passkeys'],
    ['write', 'DELETE FROM fin_accounts'],
    ['multiple', 'SELECT 1; SELECT 2'],
    ['unbounded', 'WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM x) SELECT count(*) FROM x'],
  ]) {
    const control = await compare(db, [{ kind, sql }], () => false);
    assertConforms(control);
    const mutant = await compare(db, [{ kind, sql }], () => true);
    assert.equal(mutant[0].mismatch, 'mismatch_accept');
    assert.throws(() => assertConforms(mutant), assert.AssertionError, kind);
  }
  const positive = [{ kind: 'safe', sql: 'SELECT id FROM fin_accounts' }];
  assertConforms(await compare(db, positive, () => true));
  const mutant = await compare(db, positive, () => false);
  assert.equal(mutant[0].mismatch, 'mismatch_reject');
  assert.throws(() => assertConforms(mutant), assert.AssertionError);
  t.diagnostic('mutants_killed=5/5 (private read, write, batch, unbounded recursion, safe rejection)');
});

test('SQLite plan detects recursion without relying on the optional RECURSIVE keyword', async t => {
  const db = fixture(t);
  const read = async sql => db.prepare(sql).all();
  await assert.rejects(Promise.resolve().then(() => validateMoneySql('WITH x(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM x) SELECT count(*) FROM x', read)), e => e.code === 'MONEY_QUERY_INVALID');
  await validateMoneySql('WITH "recursive step" AS (SELECT 1 AS n) SELECT n FROM "recursive step"', read);
});
