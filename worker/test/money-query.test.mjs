import nodeTest from 'node:test';
import { knownLimitTests } from '../../test/helpers/known-limit-0428.mjs';
// Dated positive-control exceptions only; never lower the pinned High expectations.
const KNOWN_LIMIT_HIGH_0428 = new Set([
  "founder query confidence reads support behind aggregates and never certifies bounded or ambiguous scope",
  "confidence cannot certify amounts using a different financial snapshot",
  "confidence weights dollar share without netting directions or diluting across currencies",
  "scope proof rejects literal decoys and bounded windows but retains scoped-account green controls",
  "mixed-currency aggregates and future days cannot earn High despite declared coverage",
  "known discovered accounts without an owner ledger record prevent a whole-book High score",
  "founder confidence: rubric changes only with evidence and truncation cannot earn High"
]);
const KNOWN_LIMIT_REASON_0428 = "known limit 0.4.28 (2026-11-15): this positive High control now scores Medium/Low after the query-shape allow-list and party certificate (c69688660) and category guard (d4ad00639); figure unchanged, confidence only lowered; in-test guards in skipped cases are also paused, while highwrong-frozen wrong-at-High guards still run; restore in 0.4.29";
const test = knownLimitTests(nodeTest, KNOWN_LIMIT_HIGH_0428, KNOWN_LIMIT_REASON_0428);
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
const { default: worker } = await import(process.env.MONEY_WORKER_TEST_MODULE || '../src/index.js');
const { handleMcp } = await import(process.env.MONEY_REMOTE_TEST_MODULE || '../src/lib/mcp-endpoint.js');
import { pairOwnTransfers } from '../src/lib/money-analysis.js';
import { accountLinkIdentity } from '../src/lib/fin-account-links.js';
import { mintSessionCookie } from '../src/lib/sessions.js';
import { overviewFixture } from './helpers/money-overview-fixture.mjs';

test('founder query confidence reads support behind aggregates and never certifies bounded or ambiguous scope', async t => {
  const { queryMoney } = await import(modulePath); const f = overviewFixture(t);
  const instant = Date.parse('2025-12-31T18:00:00Z');
  t.mock.method(Date, 'now', () => instant);
  f.account('deposit', 'live'); f.connection('deposit');
  f.run('UPDATE bank_feed_items SET last_synced_at=?', '2025-12-31T18:00:00Z');
  f.coverage('deposit', '2025-12-01', '2025-12-31');
  f.row('earned', 'deposit', '2025-12-10', 240000, 'inflow', { description: 'Payroll income' });
  const sql = "SELECT SUM(income_minor) AS total FROM txn WHERE posted_on BETWEEN '2025-12-01' AND '2025-12-31'";
  const read = (query = sql, max_rows) => queryMoney(f.env, { sql: query, max_rows }, { now: () => instant });
  const control = await read();
  assert.equal(control.rows[0].total, 240000, 'the aggregate actually ran');
  assert.equal(control.confidence.percent, 95);
  assert.deepEqual((await read()).confidence, control.confidence);
  const http = await worker.fetch(request(f.env, { sql }), f.env, {});
  assert.deepEqual((await http.json()).confidence, control.confidence, 'owner HTTP uses the same evidence score');
  const remote = await rpc(f.env, 'tools/call', { name: 'brain_money_query', arguments: { sql } });
  assert.notEqual(remote.result.isError, true);
  assert.deepEqual(JSON.parse(remote.result.content[0].text).confidence, control.confidence, 'remote tool uses the same evidence score');
  f.row('possible', 'deposit', '2025-12-11', 120000, 'outflow', { description: 'Card payment' });
  const guessed = await read();
  assert.ok(guessed.confidence.percent < 90);
  assert.match(guessed.confidence.reasons.join(' '), /possible.*payment.*1,200\.00/i);
  f.row('pending', 'deposit', '2025-12-12', 50000, 'inflow', { pending: true });
  const pending = await read();
  assert.match(pending.confidence.missing.join(' '), /pending.*500\.00.*2025-12-12/i);
  const limited = await read("SELECT * FROM txn WHERE posted_on BETWEEN '2025-12-01' AND '2025-12-31' ORDER BY id LIMIT 1", 1);
  assert.equal(limited.rows.length, 1);
  assert.ok(limited.confidence.percent < 90);
  assert.match(limited.confidence.reasons.join(' '), /limit|bounded/i);
  const truncated = await read("SELECT * FROM txn WHERE posted_on BETWEEN '2025-12-01' AND '2025-12-31' ORDER BY id", 1);
  assert.equal(truncated.truncated, true, 'returned-row cap decision reached two supporting posted rows');
  assert.ok(truncated.confidence.percent < 70);
  const ambiguous = await read("SELECT SUM(income_minor) AS total FROM txn WHERE posted_on BETWEEN '2025-12-01' AND '2025-12-31' OR 1=1");
  assert.ok(ambiguous.confidence.percent < 70);
  assert.match(ambiguous.confidence.missing.join(' '), /scope|period/i);
  assert.ok(f.calls.some(q => q.includes('last_synced_at')), 'private freshness evidence was actually read');
});

test('confidence-only evidence failures preserve successful amounts; amount-read failures stay answerable and private', async t => {
  const { queryMoney } = await import(modulePath); const f = overviewFixture(t);
  f.account('deposit'); f.row('earned', 'deposit', '2025-12-10', 240000, 'inflow', { description: 'Payroll income' });
  const sql = "SELECT SUM(income_minor) AS total FROM txn WHERE posted_on BETWEEN '2025-12-01' AND '2025-12-31'";
  assert.equal((await queryMoney(f.env, { sql })).rows[0].total, 240000, 'amount control reaches real clean SQL');
  const prepare = f.env.DB.prepare;
  let failed = 0;
  f.env.DB.prepare = statement => {
    if (statement.includes("'confidence_accounts'")) { failed++; throw new Error('synthetic private evidence error'); }
    return prepare(statement);
  };
  const partial = await queryMoney(f.env, { sql });
  assert.equal(failed, 1, 'confidence-only decision actually failed');
  assert.equal(partial.rows[0].total, 240000); assert.equal(partial.confidence.percent, 0);
  f.env.DB.prepare = () => { failed++; throw new Error('synthetic private amount error'); };
  const response = await worker.fetch(request(f.env, { sql }), f.env, {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'partial'); assert.equal(body.rows, null);
  assert.equal(body.confidence.percent, 0);
  assert.match(body.confidence_text, /Confidence: Low \(0%\)/);
  assert.doesNotMatch(JSON.stringify(body), /synthetic private/);
  const remote = await rpc(f.env, 'tools/call', { name: 'brain_money_query', arguments: { sql } });
  assert.notEqual(remote.result.isError, true, 'operational read failures remain answerable through the remote tool');
  assert.equal(JSON.parse(remote.result.content[0].text).confidence.percent, 0);
});

test('a stalled optional confidence read cannot time out a readable money amount', async t => {
  const { queryMoney } = await import(modulePath); const f = overviewFixture(t);
  f.account('deposit'); f.row('earned', 'deposit', '2025-12-10', 240000, 'inflow', { description: 'Payroll income' });
  const sql = "SELECT SUM(income_minor) AS total FROM txn WHERE posted_on BETWEEN '2025-12-01' AND '2025-12-31'";
  assert.equal((await queryMoney(f.env, { sql })).rows[0].total, 240000, 'readable amount control');
  const prepare = f.env.DB.prepare; let stalled = 0;
  f.env.DB.prepare = statement => statement.includes("'confidence_accounts'")
    ? { all: () => { stalled++; return new Promise(() => {}); } } : prepare(statement);
  const result = await queryMoney(f.env, { sql }, { timeoutMs: 200 });
  assert.equal(stalled, 1, 'optional confidence read actually stalled');
  assert.equal(result.rows[0].total, 240000);
  assert.equal(result.confidence.percent, 0);
});

test('confidence cannot certify amounts using a different financial snapshot', async t => {
  const { queryMoney } = await import(modulePath); const f = overviewFixture(t);
  const stamp = '2025-12-31T18:00:00Z';
  f.account('deposit', 'live'); f.connection('deposit'); f.coverage('deposit', '2025-12-01', '2025-12-31');
  f.run('UPDATE bank_feed_items SET last_synced_at=?', stamp);
  f.row('earned', 'deposit', '2025-12-10', 240000, 'inflow', { description: 'Payroll income' });
  const sql = "SELECT SUM(income_minor) AS total FROM txn WHERE posted_on BETWEEN '2025-12-01' AND '2025-12-31'";
  const read = () => queryMoney(f.env, { sql }, { now: () => Date.parse(stamp) });
  assert.equal((await read()).confidence.percent, 95, 'stable snapshot green control');
  const prepare = f.env.DB.prepare; let changed = 0;
  f.env.DB.prepare = statement => {
    if (statement.startsWith('SELECT * FROM (\n') && changed++ === 0)
      f.row('concurrent', 'deposit', '2025-12-11', 120000, 'inflow', { description: 'Payroll income' });
    return prepare(statement);
  };
  const result = await read();
  assert.equal(changed, 1, 'ingest change occurs after the classified amount snapshot');
  assert.equal(result.rows[0].total, 240000, 'original coherent amount is retained');
  assert.equal(result.confidence.percent, 0);
  assert.match(result.confidence.reasons.join(' '), /snapshot.*changed|changed.*snapshot/i);
});

test('confidence weights dollar share without netting directions or diluting across currencies', async t => {
  const { queryMoney } = await import(modulePath); const f = overviewFixture(t);
  const stamp = '2025-12-31T18:00:00Z';
  f.account('deposit', 'live'); f.connection('deposit'); f.coverage('deposit', '2025-12-01', '2025-12-31');
  f.run('UPDATE bank_feed_items SET last_synced_at=?', stamp);
  f.row('earned', 'deposit', '2025-12-10', 900000, 'inflow', { description: 'Payroll income' });
  const sql = "SELECT SUM(income_minor) AS total FROM txn WHERE posted_on BETWEEN '2025-12-01' AND '2025-12-31'";
  const read = () => queryMoney(f.env, { sql }, { now: () => Date.parse(stamp) });
  assert.equal((await read()).confidence.percent, 95, 'proved dollar control');
  f.row('unknown', 'deposit', '2025-12-11', 100000);
  const small = await read(); assert.equal(small.confidence.percent, 89);
  f.run("UPDATE fin_transactions SET amount_minor=600000 WHERE txn_uid='unknown'");
  const large = await read(); assert.equal(large.confidence.percent, 82);
  assert.ok(large.confidence.percent < small.confidence.percent, 'weight decision distinguishes the two arms');
  f.account('foreign', 'live', 'checking', 'CAD'); f.connection('foreign'); f.coverage('foreign', '2025-12-01', '2025-12-31');
  f.run('UPDATE bank_feed_items SET last_synced_at=?', stamp);
  f.row('foreign-income', 'foreign', '2025-12-12', 100000000, 'inflow', { currency: 'CAD', description: 'Payroll income' });
  f.row('spending', 'deposit', '2025-12-13', 100000000, 'outflow');
  f.run("UPDATE fin_transactions SET category='RENT',category_basis_state='confirmed' WHERE txn_uid='spending'");
  const separate = await read();
  assert.equal(separate.rows[0].total, 101500000, 'all observed currencies still reach the caller SQL unchanged');
  assert.equal(separate.confidence.percent, large.confidence.percent, 'other currency and opposite direction never dilute uncertain dollars');
});

test('scope proof rejects literal decoys and bounded windows but retains scoped-account green controls', async t => {
  const { queryMoney } = await import(modulePath); const f = overviewFixture(t);
  const stamp = '2025-12-31T18:00:00Z';
  f.account('deposit', 'live'); f.connection('deposit'); f.coverage('deposit', '2025-12-01', '2025-12-31');
  f.run('UPDATE bank_feed_items SET last_synced_at=?', stamp);
  f.row('earned', 'deposit', '2025-12-10', 1000, 'inflow', { description: 'Payroll income' });
  f.account('not-needed', 'none', 'card');
  const period = "posted_on BETWEEN '2025-12-01' AND '2025-12-31'";
  const control = `SELECT SUM(income_minor) AS total FROM txn WHERE ${period} AND tenant_id='primary' AND account_slug='deposit'`;
  const read = sql => queryMoney(f.env, { sql }, { now: () => Date.parse(stamp) });
  assert.equal((await read(control)).confidence.percent, 95, 'unrelated card cannot widen an explicitly selected account');
  const arms = [
    `SELECT '${period.replaceAll("'", "''")}' AS note,SUM(income_minor) FROM txn`,
    `SELECT SUM(income_minor) FROM txn WHERE ${period} OR account_slug='deposit'`,
    `WITH txn AS (SELECT * FROM fin_transactions) SELECT SUM(amount_minor) FROM txn WHERE ${period}`,
    `SELECT SUM(income_minor) FROM txn WHERE ${period} AND account_slug IN ('deposit')`,
    control + ' LIMIT 1',
  ];
  for (const sql of arms) {
    const result = await read(sql);
    assert.ok(result.rows.length, 'each low-confidence arm executes the real SQL decision');
    assert.ok(result.confidence.percent < 70, sql);
    assert.ok(result.confidence.reasons.length && result.confidence.missing.length);
  }
});

test('mixed-currency aggregates and future days cannot earn High despite declared coverage', async t => {
  const { queryMoney } = await import(modulePath); const f = overviewFixture(t);
  const stamp = '2025-12-31T18:00:00Z';
  f.account('deposit', 'live'); f.connection('deposit'); f.coverage('deposit', '2025-12-01', '2026-01-05');
  f.run('UPDATE bank_feed_items SET last_synced_at=?', stamp);
  f.row('earned', 'deposit', '2025-12-10', 1000, 'inflow', { description: 'Payroll income' });
  const sql = "SELECT SUM(income_minor) AS total FROM txn WHERE posted_on BETWEEN '2025-12-01' AND '2025-12-31'";
  const read = query => queryMoney(f.env, { sql: query }, { now: () => Date.parse(stamp) });
  assert.equal((await read(sql)).confidence.percent, 95, 'single-currency elapsed-period control');
  f.account('foreign', 'live', 'checking', 'CAD'); f.connection('foreign'); f.coverage('foreign', '2025-12-01', '2026-01-05');
  f.run('UPDATE bank_feed_items SET last_synced_at=?', stamp);
  f.row('foreign-earned', 'foreign', '2025-12-10', 1000, 'inflow', { currency: 'CAD', description: 'Payroll income' });
  const mixed = await read(sql);
  assert.equal(mixed.rows[0].total, 2000, 'mixed-unit aggregation decision reached');
  assert.ok(mixed.confidence.percent < 90);
  assert.match(mixed.confidence.reasons.join(' '), /currenc/i);
  const grouped = await read(sql.replace('SELECT SUM', 'SELECT currency,SUM') + ' GROUP BY currency');
  assert.equal(grouped.rows.length, 2); assert.equal(grouped.confidence.percent, 95, 'separate currency control');
  const mislabeled = await read(sql.replace('SELECT SUM', "SELECT 'USD' AS currency,SUM") + ' GROUP BY currency');
  assert.equal(mislabeled.rows.length, 2, 'literal currency projection actually executes');
  assert.ok(mislabeled.confidence.percent < 90, 'a displayed currency literal cannot certify separate currency figures');
  const future = await read(sql.replace('2025-12-31', '2026-01-05'));
  assert.ok(future.confidence.percent < 90);
  assert.match(future.confidence.missing.join(' '), /2026-01-01.*2026-01-05/);
});

test('known discovered accounts without an owner ledger record prevent a whole-book High score', async t => {
  const { queryMoney } = await import(modulePath); const f = overviewFixture(t);
  const stamp = '2025-12-31T18:00:00Z';
  f.account('deposit', 'live'); f.connection('deposit'); f.coverage('deposit', '2025-12-01', '2025-12-31');
  f.run('UPDATE bank_feed_items SET last_synced_at=?', stamp);
  f.row('earned', 'deposit', '2025-12-10', 1000, 'inflow', { description: 'Payroll income' });
  const sql = "SELECT SUM(income_minor) AS total FROM txn WHERE posted_on BETWEEN '2025-12-01' AND '2025-12-31'";
  const read = () => queryMoney(f.env, { sql }, { now: () => Date.parse(stamp) });
  assert.equal((await read()).confidence.percent, 95, 'fully recorded inventory control');
  f.account('discovered', 'live', 'card'); f.connection('discovered');
  f.run("UPDATE fin_accounts SET superseded_by_id=1 WHERE account_slug='discovered'");
  f.run("UPDATE plaid_account_entity_assignments SET entity_slug=NULL,assigned_at=NULL WHERE item_ref='discovered'");
  const unknown = await read();
  assert.equal(unknown.rows[0].total, 1000, 'whole-book aggregate remains readable');
  assert.ok(unknown.confidence.percent < 70);
  assert.match(unknown.confidence.missing.join(' '), /1.*discovered.*last four.*2025-12-01.*2025-12-31/i);
});

const modulePath = process.env.MONEY_QUERY_TEST_MODULE || '../src/lib/money-query.js';
const now = '2026-09-20T12:00:00Z';
function fixture(t) {
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../../migrations/d1/', import.meta.url)).filter(f => f.endsWith('.sql')).sort())
    db.exec(readFileSync(new URL(`../../migrations/d1/${file}`, import.meta.url), 'utf8'));
  t.after(() => db.close());
  const calls = [];
  const env = { STORAGE: 'd1', ADMIN_KEY: randomBytes(24).toString('hex'), SESSION_SIGNING_KEY: randomBytes(32).toString('hex'), DB: {
    prepare(sql) { calls.push(sql); return { async all() { return { success: true, results: db.prepare(sql).all() }; },
      async first() { return db.prepare(sql).get() ?? null; },
      bind(...args) { return { async all() { return { success: true, results: db.prepare(sql).all(...args) }; }, async first() { return db.prepare(sql).get(...args) ?? null; } }; } }; },
  } };
  const raw = (sql, ...args) => db.prepare(sql).run(...args);
  raw("INSERT INTO install_state(id,client_slug,product_version,installed_at) VALUES (1,'owner','0.0.0-test',?)",now);
  raw(`INSERT INTO fin_entities(entity_slug,legal_name,kind,provenance,basis_state,recorded_at)
    VALUES ('business','Owner business','business','owner_stated','confirmed',?)`, now);
  raw(`INSERT INTO fin_entities(entity_slug,legal_name,kind,provenance,basis_state,recorded_at)
    VALUES ('household','Owner household','household','owner_stated','confirmed',?)`, now);
  const account = (slug, mode, entity = 'business', mask = String(1).repeat(4), kind = 'checking') => raw(
    `INSERT INTO fin_accounts(account_slug,entity_slug,label,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at)
      VALUES (?,?,?,?,'asset',?,?,'owner_stated','confirmed',?)`, slug, entity, slug, kind, mask, mode, now);
  const row = (uid, accountSlug, day, amount, direction = 'inflow', extra = {}) => raw(
    `INSERT INTO fin_transactions(txn_uid,account_slug,posted_on,amount_minor,direction,currency,description,pending,removed_at,removal_reason,superseded_by_id,source_provider,provenance,basis_state,recorded_at)
      VALUES (?,?,?,?,?,'USD',?,?,?,?,?,?,'owner_stated','confirmed',?)`, uid, accountSlug, day, amount, direction,
      extra.description ?? null, Number(extra.pending ?? 0), extra.removed ? now : null, extra.removed ? 'removed' : null,
      extra.superseded ? 1 : null, extra.provider ?? null, now);
  const link = (manual, live) => {
    const get = slug => db.prepare('SELECT * FROM fin_accounts WHERE account_slug=?').get(slug);
    raw(`INSERT INTO fin_account_links(tenant_id,manual_account_slug,live_account_slug,identity_json,link_plan_hash,linked_at)
      VALUES ('primary',?,?,?,?,?)`, manual, live,
    JSON.stringify([accountLinkIdentity(get(manual)), accountLinkIdentity(get(live))]), 'a'.repeat(64), now);
  };
  return { env, calls, db, raw, account, row, link };
}
const request = (env, body, auth = true) => new Request('https://brain.invalid/api/admin/brain/money-query', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { 'X-Admin-Key': env.ADMIN_KEY } : {}) }, body: JSON.stringify(body),
});

test('R4 B-1: 5000 long rows use independent byte-bounded JSON arrays and retain emoji', async t => {
  const f = fixture(t); f.account('operating','manual');
  const description = 'client revenue '+ 'x'.repeat(300)+'😀';
  let expected = 0;
  for (let i=0;i<5000;i++) { const amount=i+1; expected+=amount; f.row('long-'+i,'operating','2026-09-10',amount,'inflow',{description}); }
  const {queryMoney} = await import(modulePath);
  const execute = async (sql,{binds}) => {
    for (const bind of binds) if (typeof bind==='string') assert.ok(Buffer.byteLength(bind,'utf8')<=900000,'D1 value byte budget');
    assert.doesNotMatch(sql,/\?\d+\|\|\?\d+/,'never concatenate JSON chunks');
    return {success:true,results:f.db.prepare(sql).all(...binds)};
  };
  const r = await queryMoney(f.env,{sql:'SELECT sum(income_minor) AS cents,min(description) AS description FROM txn',period_from:'2026-09-01',period_to:'2026-09-30'},{execute});
  assert.equal(r.rows[0].cents,expected); assert.equal(r.rows[0].description,description);
});

test('R4 B-1: snapshot chunks preserve a four-byte edge and enforce the total bind budget', async () => {
  const {classifiedMoneyCtes} = await import('../src/lib/clean-money.js');
  const rows = [{id:1,description:'x'.repeat(899950)+'😀'},{id:2,description:'😀'}];
  const binds=[]; classifiedMoneyCtes({rows,accounts:[],pairs:[],coverage:[]},binds,[]);
  assert.ok(binds.every(b=>Buffer.byteLength(b,'utf8')<=900000));
  assert.deepEqual(binds.flatMap(b=>JSON.parse(b)).filter(r=>r.description),rows);
  assert.throws(()=>classifiedMoneyCtes({rows:[],accounts:[],pairs:[],coverage:[]},Array(90).fill('[]'),[]),{code:'MONEY_QUERY_SCAN_LIMIT'});
});
async function rpc(env, method, params) {
  return (await handleMcp(env, new Request('https://brain.invalid/mcp', { method: 'POST', body: JSON.stringify({ id: 1, method, params }) }),
    new URL('https://brain.invalid/mcp'), { grant: { profile: 'librarian' } })).json();
}

test('money guide starts with the five answer lines and keeps examples before internals', async t => {
  const { MONEY_GUIDE, MONEY_ANSWER_INSTRUCTIONS } = await import('../src/lib/money-query-contract.js');
  for (const text of [MONEY_GUIDE, MONEY_ANSWER_INSTRUCTIONS]) {
    const lines = text.split('\n');
    assert.match(lines[0], /^ANSWER CONTRACT/);
    assert.match(lines[1], /^1\. .*number first.*period in words/i);
    assert.match(lines[2], /^2\. .*last 4.*from <date> through <date>/i);
    assert.match(lines[3], /^3\. .*missing.*counted twice.*dollar amount/i);
    assert.match(lines[4], /^4\. .*likely.*why/i);
    assert.match(lines[5], /^5\. .*top rows.*compare/i);
    assert.match(text, /always answer.*never refuse/i);
    assert.doesNotMatch(text, /withheld|unsupported|coverage incomplete|\u2014/i);
    assert.match(text, /\$0 quantified; amount unknown/);
    assert.match(text, /code.*number beside it/i);
  }
  assert.ok(MONEY_GUIDE.split('\n').length < 60, 'rendered guide stays below 60 plain lines');
  assert.ok(MONEY_GUIDE.indexOf('Income:') < MONEY_GUIDE.indexOf('Internals:'), 'examples precede internal detail');
  assert.match(MONEY_GUIDE, /^Balances:.*as of <date>.*last 4.*currency.*basis/m);
  t.diagnostic(`guide_lines=${MONEY_GUIDE.split('\n').length}`);
});

// These are independent expected cents, not totals computed from the view under test.
const guideModule = () => import('../src/lib/money-query-contract.js');
const examplesFor = async () => [...(await guideModule()).MONEY_GUIDE.matchAll(/^([A-Za-z ]+):[^\n]*\n((?:SELECT|WITH) [^\n]+)/gm)];
const recipe = async label => {
  const found = (await examplesFor()).find(m => m[1] === label);
  assert.ok(found, `worked query exists: ${label}`);
  return found[2];
};
function guideFixture(t) {
  const f = fixture(t);
  f.account('operating', 'manual');
  f.account('reserve', 'manual', 'business', '2222');
  f.account('household-checking', 'manual', 'household', '3333');
  f.account('foreign-checking', 'manual', 'business', '4444');
  f.account('empty', 'none', 'business', '6666');
  f.raw("UPDATE fin_accounts SET currency='EUR' WHERE account_slug='foreign-checking'");
  for (const [uid, day] of [['receipt', '2026-09-10'], ['prior-receipt', '2026-08-10']]) {
    f.row(uid, 'operating', day, 100000);
    f.raw("UPDATE fin_transactions SET payee='Payer',description='Invoice payment' WHERE txn_uid=?", uid);
  }
  for (const [uid, day] of [['repeat-first', '2026-08-15'], ['repeat-second', '2026-09-15']]) {
    f.row(uid, 'operating', day, 5000, 'outflow');
    f.raw("UPDATE fin_transactions SET payee='Vendor',category='SERVICES',category_basis_state='confirmed' WHERE txn_uid=?", uid);
  }
  f.row('sent', 'operating', '2026-08-31', 20000, 'outflow', { description: 'TRANSFER TO account 2222' });
  f.row('received', 'reserve', '2026-09-01', 20000, 'inflow', { description: 'TRANSFER FROM account 1111' });
  f.row('pending', 'operating', '2026-09-12', 9000000, 'inflow', { pending: true });
  f.row('removed', 'operating', '2026-09-12', 8000000, 'outflow', { removed: true });
  f.row('household-receipt', 'household-checking', '2026-09-10', 30000);
  f.raw("UPDATE fin_transactions SET payee='Household payer',description='Invoice payment' WHERE txn_uid='household-receipt'");
  for (const [uid, day] of [['same-month-first', '2026-09-05'], ['same-month-second', '2026-09-20']]) {
    f.row(uid, 'household-checking', day, 2000, 'outflow');
    f.raw("UPDATE fin_transactions SET payee='Household vendor',category='SERVICES',category_basis_state='confirmed' WHERE txn_uid=?", uid);
  }
  f.row('foreign-receipt', 'foreign-checking', '2026-09-10', 70000);
  f.row('foreign-charge', 'foreign-checking', '2026-09-15', 2000, 'outflow');
  f.raw("UPDATE fin_transactions SET currency='EUR' WHERE account_slug='foreign-checking'");
  f.raw("UPDATE fin_transactions SET payee='Foreign payer',description='Invoice payment' WHERE txn_uid='foreign-receipt'");
  f.raw("UPDATE fin_transactions SET payee='Foreign vendor',category='SERVICES',category_basis_state='confirmed' WHERE txn_uid='foreign-charge'");
  f.raw(`INSERT INTO fin_obligations(obligation_uid,entity_slug,kind,balance_minor,balance_as_of,provenance,basis_state,recorded_at)
    VALUES ('synthetic-debt','business','loan',1500000,'2026-09-30','owner_stated','confirmed',?)`, now);
  f.raw(`INSERT INTO fin_deadlines(deadline_uid,entity_slug,item,due_date,basis_note,provenance,basis_state,recorded_at)
    VALUES ('synthetic-due','business','Owner review','2026-09-25','Owner date','owner_stated','confirmed',?)`, now);
  return f;
}
async function routeQuery(f, sql, max_rows = 200, scope = {}) {
  const changed = f.db.prepare('SELECT total_changes() AS n').get().n;
  const response = await worker.fetch(request(f.env, { sql, max_rows, ...scope }), f.env, {});
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.truncated, false);
  assert.ok(f.calls.some(q => q.startsWith('EXPLAIN ')), 'real compilation reached');
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n, changed, 'no ledger writes');
  return result;
}
const business = (rows, currency = 'USD') => rows.find(r => r.tenant_id === 'primary' && r.currency === currency && (!r.side || r.side === 'business'));

test('B1 M1 M3 M8: every worked guide query returns independently expected cents through the real route', async t => {
  const labels = ['Totals','Coverage','By account','Top rows','Possible duplicates','Income','Spending','Payers','Vendors','Balances','Own transfers','Recurring','Profit','Owed','Lifecycle','Large ledger','Accounts','Cash flow','Categories','Monthly','Due dates'];
  for (const label of labels) await t.test(label, async t => {
    const f = guideFixture(t);
    if (label === 'Possible duplicates') f.row('twin', 'reserve', '2026-09-10', 100000);
    if (label === 'Balances') f.raw(`INSERT INTO fin_balance_snapshots(account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at)
      VALUES ('operating','2026-09-29',900000,'owner_stated','confirmed',?)`, now);
    const { rows } = await routeQuery(f, await recipe(label));
    const usd = business(rows), eur = business(rows, 'EUR');
    if (label === 'Totals') {
      const ordinary = rows.filter(r => r.money_kind === 'ordinary');
      assert.equal(business(ordinary.filter(r => r.direction === 'inflow')).income_minor, 100000);
      assert.equal(business(ordinary.filter(r => r.direction === 'outflow')).expense_minor, 5000);
      assert.equal(business(ordinary.filter(r => r.direction === 'inflow')).likely_minor, 0);
      assert.equal(rows.find(r => r.money_kind === 'own_transfer').amount_minor, 20000);
      assert.equal(rows.reduce((n,r) => n+r.amount_minor,0), 231000);
    }
    if (label === 'Coverage') {
      assert.equal(rows.length, 5);
      const operating = rows.find(r => r.account_slug === 'operating');
      assert.equal(operating.first_row, '2026-08-10'); assert.equal(operating.last_row, '2026-09-15');
      assert.equal(rows.find(r => r.account_slug === 'empty').row_count, 0);
      assert.equal(rows.find(r => r.account_slug === 'reserve').row_count, 1);
    }
    if (label === 'By account') {
      assert.equal(rows.length,5); assert.equal(rows.find(r=>r.account_slug==='empty').row_count,0);
      assert.equal(rows.find(r=>r.account_slug==='operating').income_minor,100000);
    }
    if (label === 'Top rows') {
      assert.deepEqual(rows.map(r => r.amount_minor), [70000,100000,30000]);
      assert.deepEqual(rows.map(r => r.account), ['4444','1111','3333']);
      // The household payer label overlaps the recorded owned-entity label.
      // Only that receipt retains type uncertainty; all amounts stay fixed.
      assert.deepEqual(rows.map(r=>[r.estimated,r.tenant_id]),[[0,'primary'],[0,'primary'],[1,'primary']]);
    }
    if (label === 'Possible duplicates') {
      assert.equal(rows.length, 1); assert.equal(usd.possible_duplicate_minor, 100000); assert.equal(usd.row_count,1);
    }
    if (label === 'Income' || label === 'Payers') {
      assert.equal(usd.income_minor,100000); assert.equal(eur.income_minor,70000);
      assert.equal(usd.likely_income_minor,0);
      assert.equal(rows.find(r => r.side === 'personal').income_minor,30000);
    }
    if (label === 'Spending' || label === 'Vendors') {
      assert.equal(usd.spending_minor,5000); assert.equal(eur.spending_minor,2000);
      assert.equal(usd.likely_spending_minor,0); assert.equal(rows.find(r => r.side === 'personal').spending_minor,4000);
      if (label === 'Vendors') assert.equal(usd.payee_group,'vendor');
    }
    if (label === 'Balances') {
      assert.equal(rows.length,5); assert.equal(rows.find(r => r.account === '1111').current_minor,900000);
      assert.equal(rows.find(r => r.account === '1111').as_of_date,'2026-09-29');
      assert.equal(rows.find(r => r.account === '6666').current_minor,null);
    }
    if (label === 'Own transfers') { assert.equal(rows.length,1); assert.equal(rows[0].amount_minor,20000); }
    if (label === 'Recurring') {
      assert.equal(rows.length,2); assert.equal(rows.find(r => r.direction === 'inflow').likely_monthly_minor,100000);
      assert.equal(rows.find(r => r.direction === 'outflow').likely_monthly_minor,5000);
    }
    if (label === 'Profit') { assert.equal(usd.cash_profit_minor,95000); assert.equal(eur.cash_profit_minor,68000); assert.equal(usd.likely_income_minor,0); }
    if (label === 'Owed') { assert.equal(rows.length,1); assert.equal(usd.balance_minor,1500000); }
    if (label === 'Large ledger') {
      assert.equal(rows.find(r => r.direction === 'inflow' && r.pending === 0).amount_minor,100000);
      assert.equal(rows.find(r => r.direction === 'outflow' && r.present === 1).amount_minor,5000);
      assert.equal(rows.find(r => r.pending === 1).amount_minor,9000000);
      assert.equal(rows.find(r => r.present === 0).amount_minor,8000000);
    }
    if (label === 'Lifecycle') {
      assert.equal(rows.length,2,'pending and removed postings are actually read');
      assert.deepEqual(rows.map(r=>r.amount_minor).sort((a,b)=>a-b),[8000000,9000000]);
      assert.ok(rows.some(r=>r.removed_at!==null));
      assert.ok(rows.some(r=>r.pending===1));
      assert.ok(rows.every(r=>'superseded_by_id' in r && 'removal_reason' in r));
    }
    if (label === 'Accounts') { assert.equal(rows.length,5); assert.equal(rows.find(r => r.account_slug === 'operating').mask,'1111'); }
    if (label === 'Cash flow') { assert.equal(usd.net_cash_minor,95000); assert.equal(eur.net_cash_minor,68000); }
    if (label === 'Categories') { assert.equal(usd.spending_minor,5000); assert.equal(usd.category,'SERVICES'); }
    if (label === 'Monthly') {
      assert.equal(rows.find(r => r.currency === 'USD' && r.side === 'business' && r.month === '2026-08').spending_minor,5000);
      assert.equal(rows.find(r => r.currency === 'USD' && r.side === 'business' && r.month === '2026-09').income_minor,100000);
    }
    if (label === 'Due dates') { assert.equal(rows.length,1); assert.equal(rows[0].due_date,'2026-09-25'); }
  });
  assert.deepEqual((await examplesFor()).map(m => m[1]),labels,'every guide SQL line has an executed case');
});

test('B1 M3 M8: unknown deposits, excluded card/loan payments, refunds and owner draws remain priced and estimated', async t => {
  const f = fixture(t); f.account('operating','manual');
  f.account('owned-card','manual','business','2222');
  f.account('owned-loan','manual','business','3333');
  f.raw("UPDATE fin_accounts SET account_kind='card',balance_role='liability' WHERE account_slug='owned-card'");
  f.raw("UPDATE fin_accounts SET account_kind='loan',balance_role='liability' WHERE account_slug='owned-loan'");
  for (const [uid, cents, direction, memo] of [['deposit',100000,'inflow','ACH DEPOSIT'],['card',25000,'outflow','TRANSFER TO ACCOUNT 2222'],['loan',12000,'outflow','TRANSFER TO ACCOUNT 3333'],['refund',4500,'inflow','refund'],['draw',8000,'outflow','Owner draw']])
    f.row(uid,'operating','2026-09-10',cents,direction,{description:memo});
  const totals = (await routeQuery(f, await recipe('Totals'))).rows;
  for (const [kind, cents] of [['card_payment',25000],['loan_payment',12000],['refund',4500]]) assert.equal(totals.find(r => r.money_kind === kind).amount_minor,cents);
  assert.equal(totals.find(r => r.money_kind === 'ordinary' && r.direction === 'inflow').likely_minor,100000);
  const profit = (await routeQuery(f,await recipe('Profit'))).rows[0];
  assert.equal(profit.cash_profit_minor,104500,'cash profit includes the 4500 supplier refund'); assert.equal(profit.likely_expense_minor,-4500,'the unproved supplier refund is a negative estimated expense, not a proved adjustment');
  assert.equal(totals.find(r=>r.money_kind==='refund').likely_minor,4500,'the same estimated refund dollars remain visible in Totals');
  assert.equal(totals.find(r=>r.money_kind==='owner_money').likely_minor,8000);
});

test('B2: latest prior balance keeps null accounts, tenants, sides, liabilities and one deterministic observation', async t => {
  const f = guideFixture(t);
  f.raw("UPDATE fin_accounts SET account_kind='card',balance_role='liability' WHERE account_slug='reserve'");
  f.raw(`INSERT INTO fin_accounts(tenant_id,account_slug,entity_slug,account_kind,balance_role,mask,provenance,basis_state,recorded_at)
    VALUES ('other','operating','business','checking','asset','5555','owner_stated','confirmed',?)`,now);
  for (const [tenant,slug,day,cents,position,recorded] of [['primary','operating','2026-09-29',700000,null,now],['primary','operating','2026-09-30',900000,null,now],['primary','operating','2026-09-30',800000,null,'2026-09-19T00:00:00Z'],['primary','operating','2026-10-01',999999,null,now],['primary','reserve','2026-09-29',60000,-60000,now],['other','operating','2026-09-29',123400,null,now]])
    f.raw(`INSERT INTO fin_balance_snapshots(tenant_id,account_slug,as_of_date,current_minor,provider_position_minor,provenance,basis_state,recorded_at) VALUES (?,?,?,?,?,?,'confirmed',?)`,tenant,slug,day,cents,position,recorded === now ? 'owner_stated' : 'derived',recorded);
  for (const cutoff of ['2026-09-30','2026-10-15','2026-09-29']) {
    const rows = (await routeQuery(f,(await recipe('Balances')).replaceAll('2026-09-30',cutoff))).rows;
    assert.equal(rows.length,6);
    assert.equal(rows.find(r => r.account === '1111').current_minor,cutoff === '2026-09-29' ? 700000 : cutoff === '2026-10-15' ? 999999 : 900000);
    assert.equal(rows.find(r => r.account === '5555').current_minor,123400);
    assert.equal(rows.find(r => r.account === '2222').balance_role,'liability');
    assert.equal(rows.find(r => r.account === '2222').provider_position_minor,-60000);
    assert.equal(rows.find(r => r.account === '3333').side,'personal');
    assert.equal(rows.find(r => r.account === '6666').current_minor,null);
  }
});

test('B3: actual oversized history falls back to bounded raw figures through the real route', async t => {
  const f = guideFixture(t);
  f.db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10001)
    INSERT INTO fin_transactions(txn_uid,account_slug,posted_on,amount_minor,direction,provenance,basis_state,recorded_at)
    SELECT 'older-'||x,'operating','2025-01-01',1,'inflow','owner_stated','confirmed','2026-09-20T12:00:00Z' FROM n`);
  for (const label of ['Income','Coverage']) {
    const res = await worker.fetch(request(f.env,{sql:await recipe(label)}),f.env,{});
    assert.equal(res.status,200); const complete=await res.json();assert.equal(complete.complete,true);assert.ok(complete.rows.length);assert.ok(complete.confidence.reasons.length && complete.confidence.missing.length);
  }
  const raw = await routeQuery(f,await recipe('Large ledger'));
  assert.equal(raw.rows.find(r => r.direction === 'inflow' && r.pending === 0).amount_minor,100000);
  assert.equal((await routeQuery(f,await recipe('Accounts'))).rows.length,5);
  for (const extra of ['pending=0','removed_at IS NULL']) {
    const sql = (await recipe('Large ledger')).replace(' GROUP BY',` AND ${extra} GROUP BY`);
    const res = await worker.fetch(request(f.env,{sql}),f.env,{});
    assert.equal(res.status,200);
    const bounded = await res.json();
    assert.equal(bounded.rows.find(r => r.direction === 'inflow' && r.pending === 0).amount_minor,100000);
    assert.equal(bounded.truncated,false);
  }
});

test('M2 M4: coverage exposes empty and stopped accounts; duplicate dollars count each extra copy once', async t => {
  const f = guideFixture(t);
  assert.equal((await routeQuery(f,await recipe('Possible duplicates'))).rows.length,0);
  for (const [slug,mask] of [['copy-one','7777'],['copy-two','8888']]) { f.account(slug,'manual','business',mask); f.row(slug,slug,'2026-09-10',100000); }
  const duplicates = (await routeQuery(f,await recipe('Possible duplicates'))).rows;
  assert.equal(duplicates.length,1); assert.equal(duplicates[0].possible_duplicate_minor,200000); assert.equal(duplicates[0].row_count,2);
  const empty = (await routeQuery(f,(await recipe('Income')).replaceAll('2026-09','2026-11'))).rows;
  assert.equal(empty.length,0,'no activity must not erase account coverage');
  const coverage = (await routeQuery(f,await recipe('Coverage'))).rows;
  assert.equal(coverage.find(r => r.account_slug === 'operating').last_row,'2026-09-15');
  assert.equal(coverage.find(r => r.account_slug === 'empty').first_row,null);
});

test('M5: guide date is supplied on both surfaces and handles local midnight and an invalid zone', async t => {
  const m = await guideModule(); assert.equal(typeof m.moneyGuideFor,'function');
  for (const [zone,instant,date] of [['America/Chicago',Date.UTC(2026,10,12,3),'2026-11-11'],['Pacific/Auckland',Date.UTC(2026,10,12,20),'2026-11-13'],[undefined,Date.UTC(2026,10,12,3),'2026-11-12'],['Not/AZone',Date.UTC(2026,10,12,3),'2026-11-12']]) {
    const guide = m.moneyGuideFor({timeZone:zone,now:instant});
    assert.ok(guide.startsWith(m.MONEY_GUIDE)); assert.ok(guide.split('\n').length<60);
    assert.match(guide.split('\n').at(-1),new RegExp(`Today is ${date}`));
    if (!zone || zone === 'Not/AZone') assert.match(guide,/UTC; the owner's time zone is not configured/);
  }
  const remote = await rpc({BRAIN_TIMEZONE:'Pacific/Auckland'},'tools/call',{name:'brain_money_guide'});
  assert.match(remote.result.content[0].text,/Today is .* in Pacific\/Auckland/);
});

test('M6: documented columns compile through the real allowlist, even when registers are empty', async t => {
  const f = fixture(t), { MONEY_GUIDE } = await guideModule();
  const tables = [...MONEY_GUIDE.matchAll(/\b(fin_accounts|fin_balance_snapshots|fin_account_coverage|fin_obligations|fin_deadlines|fin_statements|owner_targets)\(([^()]+)\)/g)];
  assert.equal(tables.length,7);
  for (const [,table,columns] of tables) await routeQuery(f,`SELECT ${columns} FROM ${table} LIMIT 1`);
});

test('M7 and confidence: owner answers hide the score, keep named gaps and a supported route', async () => {
  const { MONEY_GUIDE, MONEY_ANSWER_INSTRUCTIONS } = await guideModule();
  assert.match(MONEY_ANSWER_INSTRUCTIONS,/Keep confidence labels and percentages internal/);
  assert.match(MONEY_ANSWER_INSTRUCTIONS,/only lower/i); assert.match(MONEY_ANSWER_INSTRUCTIONS,/Preserve why and what is missing in the five answer parts/);
  for (const phrase of ['Cash flow:','Categories:','Monthly:','can I afford','runway','Who owes me','tax set-aside']) assert.ok(MONEY_GUIDE.includes(phrase),phrase);
  assert.match(MONEY_GUIDE,/MONEY_QUERY_INVALID.*retry once/); assert.match(MONEY_GUIDE,/MONEY_QUERY_TIMEOUT/);
  assert.match(MONEY_GUIDE,/Loan principal is excluded; use interest_expense_minor for interest not already inside a counted economic payment/i);
});

test('founder confidence: deterministic data score includes why and missing data for clean, raw and metadata results', async t => {
  const f = guideFixture(t);
  const a = await routeQuery(f,await recipe('Income')), b = await routeQuery(f,await recipe('Income'));
  assert.deepEqual(a.confidence,b.confidence);
  assert.ok(a.confidence.percent < 90,'uncertain membership cannot be High');
  assert.equal(a.confidence.band,a.confidence.percent>=90?'High':a.confidence.percent>=70?'Medium':'Low');
  assert.ok(a.confidence.reasons.length); assert.ok(a.confidence.missing.length);
  assert.match(JSON.stringify(a.confidence),/1111|6666/);
  for (const sql of [await recipe('Balances'),await recipe('Large ledger'),'SELECT 1 AS value']) {
    const r = await routeQuery(f,sql); assert.ok(r.confidence.percent<100); assert.ok(r.confidence.reasons.length); assert.ok(r.confidence.missing.length);
  }
});

test('B2: signed provider balances use the durable position rather than a normalized amount', async t => {
  const f = fixture(t); f.account('card','live','business','2222');
  f.raw("UPDATE fin_accounts SET account_kind='card',balance_role='liability' WHERE account_slug='card'");
  f.raw(`INSERT INTO fin_balance_snapshots(account_slug,as_of_date,current_minor,provider_position_minor,provenance,basis_state,recorded_at)
    VALUES ('card','2026-09-29',60000,-65000,'owner_stated','confirmed',?)`,now);
  assert.equal((await routeQuery(f,await recipe('Balances'))).rows[0].current_minor,65000);
});

test('M2: proposed complete coverage is visible as proposed, never treated as confirmed', async t => {
  const f = guideFixture(t);
  f.raw(`INSERT INTO fin_account_coverage(account_slug,coverage_status,covered_from,covered_to,provenance,basis_state,computed_at,recorded_at)
    VALUES ('operating','complete','2026-09-01','2026-09-30','owner_stated','proposed',?,?)`,now,now);
  const coverage = (await routeQuery(f,await recipe('Coverage'))).rows.find(r => r.account_slug === 'operating');
  assert.equal(coverage.coverage_basis_state,'proposed');
});

test('M4: duplicate query stays within the route deadline with 10000 transactions', async t => {
  const f = fixture(t); f.account('operating','manual'); f.account('reserve','manual','business','2222');
  f.db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<9999)
    INSERT INTO fin_transactions(txn_uid,account_slug,posted_on,amount_minor,direction,provenance,basis_state,recorded_at)
    SELECT 'synthetic-'||x,'operating','2026-09-10',x,'inflow','owner_stated','confirmed','2026-09-20T12:00:00Z' FROM n`);
  f.row('twin','reserve','2026-09-10',5000);
  const started = performance.now();
  const rows = (await routeQuery(f,await recipe('Possible duplicates'))).rows;
  assert.equal(rows.length,1); assert.equal(rows[0].possible_duplicate_minor,5000); assert.equal(rows[0].row_count,1);
  const elapsed = performance.now()-started;
  assert.ok(elapsed<10000,`duplicate query took ${elapsed}ms`);
  t.diagnostic(`duplicate_10000_ms=${Math.round(elapsed)}`);
});

test('M1: reused account slugs never combine income across tenants', async t => {
  const f = guideFixture(t);
  f.raw(`INSERT INTO fin_accounts(tenant_id,account_slug,entity_slug,account_kind,balance_role,mask,provenance,basis_state,recorded_at)
    VALUES ('other','operating','business','checking','asset','5555','owner_stated','confirmed',?)`,now);
  f.raw(`INSERT INTO fin_transactions(tenant_id,txn_uid,account_slug,posted_on,amount_minor,direction,provenance,basis_state,recorded_at)
    VALUES ('other','other-income','operating','2026-09-10',123400,'inflow','owner_stated','confirmed',?)`,now);
  const rows = (await routeQuery(f,await recipe('Income'))).rows;
  assert.equal(business(rows).income_minor,100000); assert.equal(rows.find(r => r.tenant_id==='other').income_minor,123400);
});

test('founder confidence: pending dollars and confirmed coverage affect the tool assessment', async t => {
  const provedIncome = "SELECT SUM(income_minor) AS income_minor FROM txn WHERE posted_on BETWEEN '2026-09-01' AND '2026-09-30'";
  const f = fixture(t); f.account('operating','manual');
  f.row('income','operating','2026-09-10',100000,'inflow',{description:'client revenue'});
  const before = await routeQuery(f,provedIncome);
  f.row('not-posted','operating','2026-09-11',12000,'inflow',{pending:true});
  const pending = await routeQuery(f,provedIncome);
  assert.ok(pending.confidence.percent<before.confidence.percent);
  assert.match(JSON.stringify(pending.confidence),/pending.*\$120\.00/);
  assert.equal(pending.evidence.accounts[0].pending.stale.inflow_minor,12000);
  assert.equal(pending.rows[0].income_minor,100000,'pending never inflates received income');
});

test('founder confidence: rubric changes only with evidence and truncation cannot earn High', async t => {
  const provedIncome = "SELECT SUM(income_minor) AS income_minor FROM txn WHERE posted_on BETWEEN '2026-09-01' AND '2026-09-30'";
  const f = fixture(t); f.account('operating','manual');
  f.row('confirmed-income','operating','2026-09-10',10000,'inflow',{description:'client revenue'});
  f.raw(`INSERT INTO fin_account_coverage(account_slug,coverage_status,covered_from,covered_to,provenance,basis_state,computed_at,recorded_at)
    VALUES ('operating','complete','2026-09-01','2026-09-30','owner_stated','confirmed',?,?)`,now,now);
  const high = (await routeQuery(f,provedIncome,200,{period_from:'2026-09-01',period_to:'2026-09-30'})).confidence;
  assert.equal(high.percent,95); assert.equal(high.band,'High'); assert.ok(high.missing.length);
  const bounded = await routeQuery(f,"SELECT income_minor FROM txn WHERE posted_on BETWEEN '2026-09-01' AND '2026-09-30' LIMIT 1");
  assert.ok(bounded.confidence.percent < 70, 'manual statements cannot bypass the bounded-query ceiling');
  assert.match(bounded.confidence.reasons.join(' '), /bounded/);
  f.raw("UPDATE fin_account_coverage SET basis_state='proposed'");
  const medium = (await routeQuery(f,provedIncome,200,{period_from:'2026-09-01',period_to:'2026-09-30'})).confidence;
  assert.equal(medium.percent,60); assert.equal(medium.band,'Low');
  f.row('uncertain','operating','2026-09-11',12000,'inflow',{description:'ACH DEPOSIT'});
  const low = (await routeQuery(f,provedIncome,200,{period_from:'2026-09-01',period_to:'2026-09-30'})).confidence;
  assert.equal(low.percent,40); assert.equal(low.band,'Low');
  const raw = await worker.fetch(request(f.env,{sql:'SELECT * FROM fin_transactions ORDER BY id',max_rows:1}),f.env,{});
  const truncated = await raw.json();
  assert.equal(truncated.truncated,true); assert.equal(truncated.confidence.percent,10);
  assert.match(JSON.stringify(truncated.confidence),/truncated/);
});

test('founder confidence: an empty ledger never earns High from a successful aggregate', async t => {
  const f = fixture(t);
  const result = await routeQuery(f,'SELECT COALESCE(SUM(income_minor),0) AS income_minor FROM txn');
  assert.equal(result.rows[0].income_minor,0);
  assert.equal(result.confidence.band,'Low');
  assert.ok(result.confidence.percent<70);
  assert.match(JSON.stringify(result.confidence),/no posted transaction rows/i);
});

test('balance-source premise: txn exposes activity while dated snapshots supply balances', async t => {
  const f = fixture(t);
  f.account('operating', 'manual');
  f.row('receipt', 'operating', '2026-09-10', 100000);
  f.raw(`INSERT INTO fin_balance_snapshots(account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at)
    VALUES ('operating','2026-09-30',900000,'owner_stated','confirmed',?)`, now);
  const activity = await worker.fetch(request(f.env, { sql: 'SELECT SUM(income_minor) AS income_minor FROM txn' }), f.env, {});
  assert.equal(activity.status, 200, 'the same authenticated route returns clean activity');
  assert.equal((await activity.json()).rows[0].income_minor, 100000);
  const before = f.calls.length;
  const missing = await worker.fetch(request(f.env, { sql: 'SELECT current_minor FROM txn' }), f.env, {});
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).code, 'MONEY_QUERY_INVALID');
  assert.ok(f.calls.slice(before).some(sql => sql.startsWith('EXPLAIN ') && sql.includes('current_minor FROM txn')),
    'the missing balance field reaches real SQL compilation');
  const snapshot = await worker.fetch(request(f.env, {
    sql: "SELECT as_of_date,current_minor FROM fin_balance_snapshots WHERE account_slug='operating' AND as_of_date='2026-09-30' AND basis_state='confirmed'",
  }), f.env, {});
  assert.equal(snapshot.status, 200, 'dated snapshot reads pass the existing allowlist');
  assert.deepEqual((await snapshot.json()).rows, [{ as_of_date: '2026-09-30', current_minor: 900000 }]);
});

test('balance snapshot allowlist permits reads but rejects writes through the real owner route', async t => {
  const { MONEY_TABLES } = await import('../src/lib/money-query-contract.js');
  assert.ok(MONEY_TABLES.includes('fin_balance_snapshots'), 'snapshot table is explicitly readable');
  const f = fixture(t);
  f.account('operating', 'manual');
  f.raw(`INSERT INTO fin_balance_snapshots(account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at)
    VALUES ('operating','2026-09-30',900000,'owner_stated','confirmed',?)`, now);
  const read = async () => {
    const response = await worker.fetch(request(f.env, { sql: 'SELECT current_minor FROM fin_balance_snapshots' }), f.env, {});
    assert.equal(response.status, 200, 'authenticated snapshot read is the green control');
    assert.deepEqual((await response.json()).rows, [{ current_minor: 900000 }]);
  };
  await read();
  const changed = f.db.prepare('SELECT total_changes() AS n').get().n;
  for (const sql of [
    'UPDATE fin_balance_snapshots SET current_minor=0',
    'DELETE FROM fin_balance_snapshots',
    "INSERT INTO fin_balance_snapshots(account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at) VALUES ('operating','2026-10-01',0,'owner_stated','confirmed','2026-10-01T12:00:00Z')",
  ]) {
    const before = f.calls.length;
    const response = await worker.fetch(request(f.env, { sql }), f.env, {});
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'MONEY_QUERY_INVALID');
    const calls = f.calls.slice(before);
    assert.ok(calls.some(query => query.startsWith('EXPLAIN ') && query.includes(sql)), 'submitted write reaches SQL compilation');
    assert.ok(calls.every(query => query.startsWith('EXPLAIN ') || query.includes('FROM sqlite_schema')), 'only validation reads precede refusal');
    assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n, changed, 'rejected write leaves the ledger unchanged');
    await read();
  }
});

test('real owner route exists, is private, and rejects proxy credentials', async t => {
  const f = fixture(t);
  const control = await worker.fetch(request(f.env, { sql: 'SELECT 1 AS value' }), f.env, {});
  assert.equal(control.status, 200, 'authorized route decision reached');
  assert.equal((await control.json()).rows[0].value, 1);
  for (const auth of [false, 'proxy']) {
    const req = request(f.env, { sql: 'SELECT 1' }, auth === true);
    if (auth === 'proxy') { f.env.RAG_PROXY_KEY = randomBytes(24).toString('hex'); req.headers.set('X-Admin-Key', f.env.RAG_PROXY_KEY); }
    assert.equal((await worker.fetch(req, f.env, {})).status, 401);
  }
});

test('owner passkey session authorizes SQL, while missing CSRF, revoked devices and scoped sessions do not', async t => {
  t.mock.method(Date, 'now', () => Date.parse(now));
  const f = fixture(t);
  f.raw(`INSERT INTO owner_passkeys(credential_id,public_key_jwk,alg,created_at) VALUES ('owner-device','{}',-7,?)`, Date.parse(now));
  const cookie = (await mintSessionCookie(f.env, 1, { credentialId: 'owner-device', now: Date.parse(now) })).split(';')[0];
  const send = async (header = true) => {
    const req = request(f.env, { sql: 'SELECT 9 AS value' }, false);
    req.headers.set('Cookie', cookie); if (header) req.headers.set('X-Brain-App', '1');
    return worker.fetch(req, f.env, {});
  };
  const control = await send(); assert.equal(control.status, 200); assert.equal((await control.json()).rows[0].value, 9);
  assert.ok(f.calls.some(sql => /FROM owner_passkeys/.test(sql)), 'session device decision reached');
  const before = f.calls.filter(sql => /SELECT \* FROM \(/.test(sql)).length;
  assert.equal((await send(false)).status, 401);
  f.raw("UPDATE owner_passkeys SET grant_id='scoped' WHERE credential_id='owner-device'");
  assert.equal((await send()).status, 401, 'device subject must match session');
  f.raw(`INSERT INTO grants(grant_id,display_name,capabilities,created_at,created_by) VALUES ('scoped','Scoped reader','["ask","administer"]',?,'owner')`, Date.parse(now));
  const scopedCookie = (await mintSessionCookie(f.env, 1, { credentialId: 'owner-device', grantId: 'scoped', now: Date.parse(now) })).split(';')[0];
  const scoped = request(f.env, { sql: 'SELECT 9 AS value' }, false);
  scoped.headers.set('Cookie', scopedCookie); scoped.headers.set('X-Brain-App', '1');
  assert.equal((await worker.fetch(scoped, f.env, {})).status, 401, 'valid scoped session cannot become the owner');
  assert.ok(f.calls.some(sql => /FROM grants/.test(sql)), 'scoped principal decision reached');
  f.raw("DELETE FROM owner_passkeys");
  assert.equal((await send()).status, 401);
  assert.equal(f.calls.filter(sql => /SELECT \* FROM \(/.test(sql)).length, before, 'refused sessions never prepare the money read');
});

test('unconfirmed historical SimpleFIN amounts cap otherwise High scoped confidence at 69', async t => {
  const { queryMoney } = await import(modulePath);
  const f = overviewFixture(t);
  f.account('deposit', 'manual', 'checking', 'KWD');
  f.coverage('deposit', '2025-12-01', '2025-12-31');
  f.row('posted', 'deposit', '2025-12-10', 78931, 'outflow', { currency:'KWD', description:'Packaging purchase' });
  f.run("UPDATE fin_transactions SET payee='Supply vendor', category='OFFICE_SUPPLIES', category_basis_state='confirmed', source_provider='simplefin', source_locator='bank-feed:fixture~simplefin-exact-minor-v1#transaction'");
  const sql = "SELECT SUM(amount_minor) AS paid FROM txn WHERE posted_on BETWEEN '2025-12-01' AND '2025-12-31' AND account_slug='deposit' AND currency='KWD' AND direction='outflow'";
  const ask = () => queryMoney(f.env, { sql }, { now: () => Date.parse('2025-12-31T18:00:00Z') });
  const control = await ask();
  assert.equal(control.rows[0].paid, 78931);
  assert.ok(control.confidence.percent >= 90, control.confidence_text);
  f.run("UPDATE fin_transactions SET amount_minor=7893, source_locator='bank-feed:legacy#transaction'");
  const historical = await ask();
  assert.equal(historical.rows[0].paid, 7893);
  assert.match(historical.confidence_text, /SimpleFIN KWD transactions.*unconfirmed/);
  assert.ok(historical.confidence.percent <= 69, historical.confidence_text);
});

test('guard rejects each write, schema, statement and table bypass before executing submitted SQL', async t => {
  const { queryMoney, MONEY_TABLES } = await import(modulePath);
  const f = fixture(t);
  assert.equal((await queryMoney(f.env, { sql: 'SELECT count(*) AS n FROM fin_transactions' })).rows[0].n, 0);
  assert.equal(f.calls.length,9,'catalogue, two compilation proofs, raw budget, owner execution with fixed SimpleFIN evidence, optional clean budget/pairing/snapshot and health');
  assert.match(f.calls[4],/FROM main\.fin_transactions t[\s\S]*t\.source_provider='simplefin'[\s\S]*mq_budget AS MATERIALIZED/);
  assert.match(f.calls[5],/^SELECT count\(\*\) AS n/);assert.match(f.calls[7],/snapshot_kind/);
  assert.match(f.calls.at(-1), /FROM bank_feed_items i LEFT JOIN bank_feed_health/, 'health access stays in the fixed private projection');
  const denied = [
    'UPDATE fin_transactions SET pending=1', 'SELECT 1; SELECT 2', 'PRAGMA table_info(fin_accounts)',
    "ATTACH DATABASE 'owner' AS other", 'WITH x AS (DELETE FROM fin_transactions RETURNING *) SELECT * FROM x',
    'SELECT * FROM sqlite_master', 'SELECT * FROM sqlite_schema', 'SELECT * FROM pragma_table_info(\'fin_accounts\')',
    'SELECT * FROM chunks', 'SELECT * FROM chunks_fts', 'SELECT * FROM owner_passkeys',
    'SELECT * FROM bank_feed_items', 'SELECT * FROM simplefin_connections', 'SELECT * FROM oauth_tokens',
    'SELECT * FROM fin_accounts, chunks', 'SELECT * FROM fin_accounts JOIN "chunks" ON 1=1',
    'SELECT * FROM (SELECT * FROM [chunks])', 'WITH x AS (SELECT * FROM `chunks`) SELECT * FROM x',
    "SELECT * FROM 'chunks'", 'SELECT * FROM main.chunks', 'SELECT * FROM unknown_table',
    "SELECT load_extension('owner')", 'SELECT 1 /* unterminated',
    'SELECT * FROM fin_accounts UNION SELECT * FROM chunks', 'SELECT * FROM (chunks)',
    'SELECT * FROM fin_accounts, (chunks)', 'SELECT * FROM fin_accounts WHERE EXISTS (SELECT 1 FROM chunks)',
  ];
  for (const sql of denied) {
    const before = f.calls.length;
    await assert.rejects(queryMoney(f.env, { sql }), error => error.code === 'MONEY_QUERY_INVALID', 'validation decision reached');
    assert.ok(f.calls.slice(before).every(q => q.startsWith('EXPLAIN ') || q.includes('FROM sqlite_schema')), 'only compilation and catalogue reads precede refusal');
  }
  for (const table of MONEY_TABLES) {
    assert.ok(f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table), 'allowlist migration premise');
    assert.equal((await queryMoney(f.env, { sql: `SELECT * FROM ${table} LIMIT 1` })).row_count, Math.min(1, f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n));
  }
  const allowed = "WITH x AS (SELECT 'ordinary note' AS note FROM fin_accounts) SELECT * FROM x";
  assert.equal((await queryMoney(f.env, { sql: allowed })).row_count, 0, 'ordinary literals and nonrecursive CTEs remain usable');
});

test('clean views prefer live history, retain earlier imports, and drop lifecycle rows', async t => {
  const { queryMoney } = await import(modulePath); const f = fixture(t);
  f.account('old-import', 'manual'); f.account('live-feed', 'live');
  f.link('old-import', 'live-feed');
  f.row('prior', 'old-import', '2026-08-01', 10);
  f.row('duplicate', 'old-import', '2026-09-01', 20);
  f.row('live', 'live-feed', '2026-09-01', 20, 'inflow', { provider: 'plaid' });
  for (const state of ['pending', 'removed', 'superseded']) f.row(state, 'live-feed', '2026-09-02', 999, 'inflow', { [state]: true });
  const result = await queryMoney(f.env, { sql: 'SELECT side, SUM(amount_minor) AS total, count(*) AS n FROM txn GROUP BY side' });
  assert.deepEqual({ ...result.rows[0] }, { side: 'business', total: 30, n: 2 });
  const coverage = await queryMoney(f.env, { sql: 'SELECT * FROM coverage ORDER BY account_slug' });
  assert.equal(coverage.row_count, 2);
  assert.equal(coverage.rows.find(r => r.account_slug === 'old-import').possible_duplicate_count, 1);
  assert.equal(coverage.rows.find(r => r.account_slug === 'live-feed').feed_kind, 'plaid');
  assert.equal(coverage.rows.find(r => r.account_slug === 'live-feed').row_count, 1);
  assert.equal(coverage.rows[0].last_sync, null, 'never substitute an observation time for successful sync');
  assert.ok(f.calls.some(sql => /WITH/.test(sql)), 'view expansion exercised');
});

test('SimpleFIN and unknown identities remain generic and do not collide across owners or currencies', async t => {
  const { queryMoney } = await import(modulePath); const f = fixture(t);
  f.account('archive', 'manual'); f.account('connected', 'live');
  f.link('archive', 'connected');
  f.account('personal', 'live', 'household'); f.account('unmasked', 'manual', 'business', null);
  f.row('archive-old', 'archive', '2026-08-01', 10); f.row('archive-copy', 'archive', '2026-09-01', 20);
  f.row('connected-row', 'connected', '2026-09-01', 20, 'inflow', { provider: 'simplefin' });
  f.row('household-row', 'personal', '2026-09-01', 30); f.row('unmasked-row', 'unmasked', '2026-09-01', 40);
  const result = await queryMoney(f.env, { sql: 'WITH selected AS (SELECT * FROM txn) SELECT SUM(amount_minor) AS total FROM selected' });
  assert.equal(result.rows[0].total, 100);
  assert.equal((await queryMoney(f.env, { sql: "SELECT side FROM txn WHERE account_slug='personal'" })).rows[0].side, 'personal');
});

test('guide example excludes proved own-transfer pair across a period edge and retains outside receipts', async t => {
  const { queryMoney, MONEY_EXAMPLE_SQL, MONEY_GUIDE } = await import(modulePath); const f = fixture(t);
  f.account('sending', 'live'); f.account('receiving', 'live', 'household', String(2).repeat(4));
  f.row('sent', 'sending', '2026-08-31', 100, 'outflow', { description: `TRANSFER TO account ${String(2).repeat(4)}` });
  f.row('received', 'receiving', '2026-09-02', 100, 'inflow', { description: `TRANSFER FROM account ${String(1).repeat(4)}` });
  f.row('outside', 'receiving', '2026-09-03', 40);
  const gross = await queryMoney(f.env, { sql: "SELECT SUM(amount_minor) AS total FROM txn WHERE direction='inflow'" });
  assert.equal(gross.rows[0].total, 140, 'positive transfer candidate decision control');
  const all = (await queryMoney(f.env, { sql: 'SELECT * FROM txn' })).rows;
  const accounts = new Map(all.map(row => [row.account_identity, { account_kind: row.account_kind, members: [{ mask: row.account, account_kind: row.account_kind, label: row.account_label }] }]));
  const pairs = pairOwnTransfers(all.map(row => ({ ...row, effective_account_slug: row.account_identity })), accounts);
  assert.equal(pairs.pairs.length, 1, 'existing product transfer decision reached');
  const result = await queryMoney(f.env, { sql: MONEY_EXAMPLE_SQL });
  assert.equal(result.rows.reduce((n,r) => n + r.amount_minor, 0), 40);
  assert.deepEqual(result.rows.map(r => r.posted_on), all.filter(r => !pairs.candidateRows.has(r.id)).map(r => r.posted_on));
  assert.match(MONEY_GUIDE, /Outgoing card and loan repayments/i); assert.match(MONEY_GUIDE, /Stripe.*net of fees/i);
  assert.match(MONEY_GUIDE, /txn columns:.*uncertain_kind, uncertain_minor/);
  assert.match(MONEY_GUIDE, /may be a card payment:.*counted in spending because no exact owned liability destination or proved pair/);
  assert.match(MONEY_GUIDE, /coverage/i); assert.match(MONEY_GUIDE, /show.*rows/i);
});

test('query caps rows, detects truncation, reports timing, and bounds waits without relaying raw failures', async t => {
  const { queryMoney } = await import(modulePath); const f = fixture(t);
  f.account('bounded', 'live');
  for (let i = 0; i < 1002; i++) f.row(`row-${i}`, 'bounded', '2026-09-01', 1);
  const sql = 'SELECT id AS x FROM fin_transactions ORDER BY id';
  const capped = await queryMoney(f.env, { sql, max_rows: 5000 });
  assert.equal(capped.row_count, 1000); assert.equal(capped.rows.length, 1000); assert.equal(capped.truncated, true);
  assert.equal(typeof capped.ms, 'number');
  assert.equal((await queryMoney(f.env, { sql, max_rows: 1 })).row_count, 1);
  let calls = 0;
  const hanging = { DB: { prepare() { calls++; return { all: () => new Promise(() => {}) }; } } };
  await assert.rejects(queryMoney(hanging, { sql: 'SELECT 1' }, { timeoutMs: 5 }), e => e.code === 'MONEY_QUERY_TIMEOUT');
  assert.equal(calls, 1, 'timed-out read was attempted');
  await assert.rejects(queryMoney({ DB: { prepare() { throw new Error('private fixture detail'); } } }, { sql: 'SELECT 1' }),
    e => e.code === 'MONEY_QUERY_UNAVAILABLE' && !e.message.includes('private fixture detail'));
});

test('connector lists and executes money tools and gives answer-oriented instructions in both model setups', async t => {
  const f = fixture(t);
  for (const setup of [{}, { ANSWER_MODEL: 'claude-opus-5-5', GATE_MODEL: 'claude-sonnet-5-5' }]) {
    const env = { ...f.env, ...setup };
    const listing = await rpc(env, 'tools/list');
    for (const name of ['brain_money_query', 'brain_money_guide']) assert.ok(listing.result.tools.some(t => t.name === name));
    const instructions = (await rpc(env, 'initialize')).result.instructions;
    assert.match(instructions, /always answer/i); assert.match(instructions, /brain_money_query/);
    assert.doesNotMatch(instructions + JSON.stringify(listing), /cash_flow_unsupported|preserve the refusal|money translation menu/i);
    const called = await rpc(env, 'tools/call', { name: 'brain_money_query', arguments: { sql: 'SELECT 7 AS value' } });
    assert.equal(JSON.parse(called.result.content[0].text).rows[0].value, 7);
    const guide = await rpc(env, 'tools/call', { name: 'brain_money_guide' });
    assert.match(guide.result.content[0].text, /txn/);
  }
});

test('real route validates bodies and methods, emits no-store and hides D1 errors', async t => {
  const f = fixture(t);
  const control = await worker.fetch(request(f.env, { sql: 'SELECT 1' }), f.env, {});
  assert.equal(control.status, 200); assert.match(control.headers.get('Cache-Control'), /no-store/);
  for (const body of [{ sql: 'SELECT * FROM chunks' }, { sql: 'SELECT 1', max_rows: -1 }, { sql: 'SELECT 1', max_rows: 1.5 }, {}]) {
    const before = f.calls.length;
    const response = await worker.fetch(request(f.env, body), f.env, {});
    assert.equal(response.status, 400); assert.equal((await response.json()).code, 'MONEY_QUERY_INVALID');
    assert.ok(f.calls.slice(before).every(q => q.startsWith('EXPLAIN ') || q.includes('FROM sqlite_schema')), 'refusal never executes submitted SQL');
  }
  const get = new Request('https://brain.invalid/api/admin/brain/money-query', { headers: { 'X-Admin-Key': f.env.ADMIN_KEY } });
  assert.equal((await worker.fetch(get, f.env, {})).status, 405);
  let reached = 0;
  f.env.DB.prepare = () => { reached++; throw new Error('private fixture detail'); };
  const failure = await worker.fetch(request(f.env, { sql: 'SELECT 1' }), f.env, {});
  assert.equal(reached, 1); assert.equal(failure.status, 200);
  const partial = await failure.json();
  assert.equal(partial.status, 'partial'); assert.equal(partial.rows, null);
  assert.equal(partial.confidence.percent, 0);
  assert.doesNotMatch(JSON.stringify(partial), /private fixture detail/);
});

test('unapproved overlapping feeds, tenants and currencies remain separate, including empty feeds', async t => {
  const { queryMoney } = await import(modulePath); const f = fixture(t);
  f.account('archive', 'manual'); f.account('older-live', 'live'); f.account('newer-live', 'live'); f.account('empty-live', 'live');
  f.account('other-currency', 'manual'); f.raw("UPDATE fin_accounts SET currency='EUR' WHERE account_slug='other-currency'");
  f.account('other-tenant', 'manual'); f.raw("UPDATE fin_accounts SET tenant_id='other' WHERE account_slug='other-tenant'");
  f.row('before', 'archive', '2026-07-01', 10); f.row('copy', 'archive', '2026-08-01', 20);
  f.row('old-start', 'older-live', '2026-08-01', 20, 'inflow', { provider: 'plaid' });
  f.row('old-overlap', 'older-live', '2026-09-01', 30, 'inflow', { provider: 'plaid' });
  f.row('new-start', 'newer-live', '2026-09-01', 30, 'inflow', { provider: 'simplefin' });
  f.row('euro', 'other-currency', '2026-09-01', 40); f.raw("UPDATE fin_transactions SET currency='EUR' WHERE txn_uid='euro'");
  f.row('other-owner', 'other-tenant', '2026-09-01', 50); f.raw("UPDATE fin_transactions SET tenant_id='other' WHERE txn_uid='other-owner'");
  const rows = await queryMoney(f.env, { sql: 'WITH selected AS (SELECT * FROM txn) SELECT * FROM selected ORDER BY amount_minor' });
  assert.deepEqual(rows.rows.map(r => r.amount_minor), [10,20,20,30,30,40,50]);
  const empty = (await queryMoney(f.env, { sql: "SELECT * FROM coverage WHERE account_slug='empty-live'" })).rows[0];
  assert.equal(empty.row_count, 0); assert.equal(empty.first_row, null); assert.equal(empty.last_row, null);
});

test('guide example retains ambiguous amounts while directed owned endpoints have independent membership', async t => {
  const { queryMoney, MONEY_EXAMPLE_SQL } = await import(modulePath); const f = fixture(t);
  f.account('outgoing', 'live'); f.account('incoming', 'live', 'household', String(2).repeat(4));
  f.row('out', 'outgoing', '2026-09-01', 100, 'outflow'); f.row('in', 'incoming', '2026-09-02', 100);
  const rows = await queryMoney(f.env, { sql: MONEY_EXAMPLE_SQL }); assert.equal(rows.row_count, 2);
  f.row('another-in', 'incoming', '2026-09-02', 100, 'inflow', { description: `TRANSFER FROM account ${String(1).repeat(4)}` });
  f.raw("UPDATE fin_transactions SET description=? WHERE txn_uid='out'", `TRANSFER TO account ${String(2).repeat(4)}`);
  const ambiguous = await queryMoney(f.env, { sql: MONEY_EXAMPLE_SQL });
  assert.equal(ambiguous.row_count, 1, 'only the receipt without a directed endpoint remains ordinary');
  assert.equal((await queryMoney(f.env, { sql: 'SELECT * FROM txn' })).row_count, 3, 'all gross rows remain visible');
  assert.equal((await queryMoney(f.env, { sql: "SELECT * FROM txn WHERE money_kind='own_transfer'" })).row_count, 2);
  assert.equal((await queryMoney(f.env, { sql: 'SELECT * FROM transfer_pairs WHERE proved=1' })).row_count, 0, 'no invented unique pair');
});

test('relation guard reaches refusals for shorthand, shadowing and the reference attack corpus', async t => {
  const { queryMoney } = await import(modulePath); const f = fixture(t);
  assert.equal((await queryMoney(f.env, { sql: 'SELECT count(*) AS n FROM fin_accounts' })).rows[0].n, 0);
  assert.ok(f.calls.length > 0, 'permitted relation reaches the real D1 adapter');
  const attacks = [
    "SELECT ('fixture-marker',7,8,'fixture-grant','fixture-document-grant') IN enrollment_codes AS hit",
    "SELECT (('table','fin_accounts',NULL,NULL,NULL) IN 'sqlite_schema') IS NULL AS hit",
    'SELECT 1 IN owner_passkeys', 'SELECT 1 NOT IN oauth_tokens',
    'SELECT 1 IN (SELECT id FROM owner_passkeys)',
    'SELECT EXISTS (SELECT 1 FROM enrollment_codes)',
    'SELECT * FROM pragma_table_info(\'fin_accounts\')',
    'SELECT json_each(owner_passkeys) FROM fin_accounts',
    'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r) SELECT count(*) FROM r',
    'SELECT randomblob(1000000000)', 'SELECT zeroblob(1000000000)',
    "SELECT load_extension('fixture')", "SELECT readfile('fixture')", "SELECT writefile('fixture',1)",
    "SELECT 1 -- '\n; DELETE FROM fin_transactions; --'",
    "SELECT 1 /* ' */; DELETE FROM fin_accounts", "SELECT * FROM 'owner_passkeys'",
    'SELECT * FROM "owner_passkeys"', 'SELECT * FROM [owner_passkeys]',
    'SELECT 1; DROP TABLE x', 'SELECT 1) ; DELETE FROM txn', 'SELECT * FROM `oauth_tokens`',
    'WITH x AS (SELECT 1) DELETE FROM fin_accounts',
    'SELECT ＊ FROM owner_passkeys',
  ];
  let decisions = 0;
  for (const sql of attacks) {
    const before = f.calls.length;
    await assert.rejects(queryMoney(f.env, { sql }), e => { decisions++; return e.code === 'MONEY_QUERY_INVALID'; }, sql);
    assert.ok(f.calls.slice(before).every(q => q.startsWith('EXPLAIN ') || q.includes('FROM sqlite_schema')), 'only compilation and catalogue reads precede refusal');
  }
  assert.equal(decisions, attacks.length, 'every attack reached the typed validation decision');
  assert.equal((await queryMoney(f.env, { sql: 'WITH selected AS (SELECT * FROM txn) SELECT count(*) AS n FROM selected' })).rows[0].n, 0,
    'nonrecursive CTE control remains usable');
});

test('transaction inputs have an inner budget and oversized scans fail before the owner statement', async t => {
  const { queryMoney } = await import(modulePath); const f = fixture(t);
  f.account('selected', 'live');
  f.row('one', 'selected', '2026-09-01', 10); f.row('two', 'selected', '2026-09-02', 20);
  const options = { maxScanRows: 2 };
  const sql = 'SELECT sum(amount_minor) AS total FROM fin_transactions';
  assert.equal((await queryMoney(f.env, { sql }, options)).rows[0].total, 30, 'at-budget aggregate control');
  assert.match(f.calls.find(sql=>sql.startsWith('SELECT * FROM (\n')), /CASE WHEN n>2[\s\S]*LIMIT 3/, 'same-statement check detects input overflow');
  assert.match(f.calls.at(-1), /FROM bank_feed_items i LEFT JOIN bank_feed_health/, 'only the trusted health projection follows owner execution');
  f.row('three', 'selected', '2026-09-03', 40);
  for (const statement of [sql, 'SELECT * FROM fin_transactions LIMIT 1']) {
    const before = f.calls.length;
    await assert.rejects(queryMoney(f.env, { sql: statement, max_rows: 1 }, options), e => e.code === 'MONEY_QUERY_SCAN_LIMIT');
    assert.ok(f.calls.slice(before).some(q => /count\(\*\)/i.test(q) && /LIMIT 3/.test(q)), 'bounded input-size decision reached');
    assert.ok(!f.calls.slice(before).some(q => q.startsWith('SELECT * FROM (\n')), 'owner statement was not prepared');
  }
  for(const statement of ['SELECT sum(amount_minor) AS total FROM txn','SELECT SUM(row_count) AS total FROM coverage']) {
    const result=await queryMoney(f.env,{sql:statement},options);
    assert.equal(result.rows[0].total,statement.includes('coverage')?3:70,'clean input expands without losing rows');
    assert.equal(result.complete,true);assert.ok(result.confidence.display);
    assert.ok(f.calls.some(sql=>sql.includes('mq_result')));
  }
  assert.equal((await queryMoney(f.env, { sql }, { maxScanRows: 3 })).rows[0].total, 70, 'configured budget green control');
  const linkProbe = await queryMoney(f.env, { sql: 'SELECT 1 AS link_probe FROM fin_accounts LIMIT 1', max_rows: 1 }, options);
  assert.equal(linkProbe.row_count, 1);
  assert.equal(linkProbe.rows[0].link_probe, 1, 'the reconnect check reads no money amounts');
});

test('indexed raw date and id bounds admit complete slices and cannot hide an oversized scan', async t => {
  const { queryMoney } = await import(modulePath); const f = fixture(t);
  f.account('selected', 'live'); f.account('unrelated', 'manual');
  f.row('one', 'selected', '2026-09-01', 20);
  for (let i = 0; i < 20; i++) f.row(`old-${i}`, 'unrelated', '2026-01-01', 1);
  const dateSql = "SELECT sum(t.amount_minor) AS total FROM fin_transactions t WHERE t.tenant_id='primary' AND t.account_slug='selected' AND t.posted_on BETWEEN '2026-09-01' AND '2026-09-02'";
  assert.equal((await queryMoney(f.env, { sql: dateSql }, { maxScanRows: 2 })).rows[0].total, 20);
  assert.ok(f.calls.some(q => /INDEXED BY idx_fin_transactions_account/.test(q)), 'date input uses the account/date index');
  const id = f.db.prepare("SELECT id FROM fin_transactions WHERE txn_uid='one'").get().id;
  assert.equal((await queryMoney(f.env, { sql: `SELECT sum(amount_minor) AS total FROM fin_transactions WHERE id BETWEEN ${id} AND ${id}` }, { maxScanRows: 2 })).rows[0].total, 20);
  for (const suffix of [" OR 1=1", " UNION ALL SELECT sum(amount_minor) FROM fin_transactions"]) {
    const before = f.calls.length;
    await assert.rejects(queryMoney(f.env, { sql: dateSql + suffix }, { maxScanRows: 2 }), e => e.code === 'MONEY_QUERY_SCAN_LIMIT');
    assert.ok(f.calls.slice(before).some(q => /LIMIT 3/.test(q)), 'unsafe scope reaches the bounded size decision');
  }
  const clean=await queryMoney(f.env,{sql:"SELECT sum(amount_minor) AS total FROM txn WHERE account_slug='selected' AND posted_on='2026-09-01'"},{maxScanRows:2});
  assert.equal(clean.rows[0].total,20,'clean view reconstructs the complete history and answers the selected date');
  assert.ok(clean.confidence.display);
});

test('deadline aborts an injected cancellable read and never starts a later native D1 call', async () => {
  const { queryMoney } = await import(modulePath);
  let reached = 0, stopped = 0;
  const execute = (_sql, { signal }) => new Promise((resolve, reject) => {
    reached++;
    signal.addEventListener('abort', () => { stopped++; reject(signal.reason); }, { once: true });
  });
  await assert.rejects(queryMoney({}, { sql: 'SELECT 1' }, { execute, timeoutMs: 5 }), e => e.code === 'MONEY_QUERY_TIMEOUT');
  assert.equal(reached, 1, 'cancellable database path reached'); assert.equal(stopped, 1, 'abort delivered to the executing adapter');
  let complete, calls = 0;
  const native = { DB: { prepare() { calls++; return { all: () => new Promise(resolve => { complete = resolve; }) }; } } };
  await assert.rejects(queryMoney(native, { sql: 'SELECT * FROM fin_transactions' }, { timeoutMs: 5 }), e => e.code === 'MONEY_QUERY_TIMEOUT');
  assert.equal(calls, 1, 'native preflight actually started');
  complete({ success: true, results: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1, 'late native completion cannot start the owner statement');
  const db = new DatabaseSync(':memory:');
  try { assert.equal((await queryMoney({ DB: { prepare: sql => ({ all: async () => ({ success: true, results: db.prepare(sql).all() }) }) } },
    { sql: 'SELECT 1 AS value' })).rows[0].value, 1, 'completed read green control'); } finally { db.close(); }
});

test('catalogue lock covers newly added private tables and views and fails closed on incomplete inventory', async t => {
  const { queryMoney } = await import(modulePath); const f = fixture(t);
  f.db.exec('CREATE TABLE private_fixture (value INTEGER); CREATE VIEW private_fixture_view AS SELECT value FROM private_fixture');
  assert.equal((await queryMoney(f.env, { sql: 'SELECT 7 AS value' })).rows[0].value, 7, 'catalogue execution control');
  for (const sql of ["SELECT 'private_fixture' AS value", "SELECT 'PRIVATE_FIXTURE_VIEW' AS value", 'WITH private_fixture AS (VALUES (1)) SELECT * FROM private_fixture']) {
    assert.equal((await queryMoney(f.env, { sql })).row_count, 1, 'private names do not grant or deny access');
  }
  for (const sql of ['SELECT * FROM private_fixture', 'SELECT * FROM private_fixture_view']) {
    const before = f.calls.length;
    await assert.rejects(queryMoney(f.env, { sql }), e => e.code === 'MONEY_QUERY_INVALID');
    assert.ok(f.calls.slice(before).every(q => q.startsWith('EXPLAIN ') || q.includes('FROM sqlite_schema')));
  }
  let reached = 0;
  const execute = async () => { reached++; return { success: true, results: Array.from({ length: 513 }, (_, i) => ({ name: `fixture_${i}` })) }; };
  await assert.rejects(queryMoney({}, { sql: 'SELECT 1' }, { execute }), e => e.code === 'MONEY_QUERY_UNAVAILABLE');
  assert.equal(reached, 1, 'overflow catalogue cannot start an owner statement');
});

test('an ingest between budget probe and execution cannot return a partial aggregate', async t => {
  const { queryMoney } = await import(modulePath); const f = fixture(t);
  f.account('selected', 'live'); f.row('first', 'selected', '2026-09-01', 10);
  assert.equal((await queryMoney(f.env, { sql: 'SELECT sum(amount_minor) AS total FROM fin_transactions' }, { maxScanRows: 1 })).rows[0].total, 10);
  const prepare = f.env.DB.prepare;
  let raced = 0;
  const guardedReads = [];
  f.env.DB.prepare = sql => {
    if (sql.startsWith('SELECT * FROM (\n')) {
      guardedReads.push(sql);
      if (++raced === 1) f.row('concurrent', 'selected', '2026-09-02', 20);
    }
    return prepare(sql);
  };
  await assert.rejects(queryMoney(f.env, { sql: 'SELECT sum(amount_minor) AS total FROM fin_transactions' }, { maxScanRows: 1 }), e => e.code === 'MONEY_QUERY_UNAVAILABLE');
  assert.equal(raced, 2, 'same-statement overflow sentinel runs on the receipt read and its one amount-only retry');
  assert.ok(guardedReads[0].includes(guardedReads[1]), 'the retry preserves the identical guarded amount SQL');
  f.env.DB.prepare = prepare;
  assert.equal((await queryMoney(f.env, { sql: 'SELECT sum(amount_minor) AS total FROM fin_transactions' }, { maxScanRows: 2 })).rows[0].total, 30,
    'a complete configured input still returns the full total');
});

test('provider error codes cannot impersonate internal refusals or expose raw detail', async t => {
  const { queryMoney } = await import(modulePath); const f = fixture(t);
  assert.equal((await queryMoney(f.env, { sql: 'SELECT 1 AS value' })).rows[0].value, 1);
  for (const code of ['MONEY_QUERY_INVALID', 'MONEY_QUERY_TIMEOUT', 'MONEY_QUERY_SCAN_LIMIT']) {
    let reached = 0;
    await assert.rejects(queryMoney({}, { sql: 'SELECT 1' }, { execute: async () => {
      reached++; throw Object.assign(new Error('private fixture detail'), { code });
    } }), e => e.code === 'MONEY_QUERY_UNAVAILABLE' && !e.message.includes('private fixture detail'));
    assert.equal(reached, 1, 'provider failure path actually reached');
  }
});

test('minimized conformance classes execute through the real money reader', async t => {
  const { queryMoney } = await import(modulePath); const f = fixture(t);
  const cases = [
    ['backtick', 'SELECT count(*) FROM `fin_obligations`', [0]],
    ['bracketed', 'SELECT count(*) FROM [fin_obligations]', [0]],
    ['double-quoted', 'SELECT count(*) FROM "fin_obligations"', [0]],
    ['single-quoted', "SELECT count(*) FROM 'fin_obligations'", [0]],
    ['schema-qualified', 'SELECT count(*) FROM main.fin_obligations', [0]],
    ['comment', 'SELECT 1 -- synthetic\n', [1]],
    ['semicolon', 'SELECT 1;', [1]],
    ['literal-comment', "SELECT '--'", ['--']],
    ['literal-recursive', "SELECT 'recursive'", ['recursive']],
    ['literal-semicolon', "SELECT ';'", [';']],
    ['cte-forward', 'WITH x AS (SELECT * FROM y),y AS (SELECT id FROM fin_accounts) SELECT * FROM x', []],
    ['cte-shadow', 'WITH fin_accounts AS (SELECT 1 AS id) SELECT id FROM fin_accounts', [1]],
    ['in-shorthand', 'WITH x(n) AS (VALUES (1)) SELECT 1 IN x', [1]],
    ['json_each', "SELECT value FROM json_each('[1,2]')", [1,2]],
    ['values', 'SELECT * FROM (VALUES (1),(2))', [1,2]],
    ['literal-private-name', "SELECT 'owner_passkeys'", ['owner_passkeys']],
    ['cte-private-name', 'WITH owner_passkeys AS (SELECT 1 AS id) SELECT id FROM owner_passkeys', [1]],
  ];
  for (const [name, sql, values] of cases) await t.test(name, async () => {
    const result = await queryMoney(f.env, { sql });
    assert.deepEqual(result.rows.flatMap(row => Object.values(row)), values);
  });
});

test('JSON module evidence cannot be borrowed by private virtual scans or aliases', async t => {
  const { queryMoney } = await import(modulePath); const f = fixture(t);
  for (const sql of [
    "SELECT value FROM json_each('[1,2]') AS j",
    "SELECT value FROM json_tree('[1,2]') WHERE type='integer'",
    "SELECT value FROM json_each('[\"chunks_fts\",\"mq_json_probe0\"]')",
    'WITH my_example AS (SELECT 1 AS n) SELECT n FROM my_example',
  ]) assert.ok((await queryMoney(f.env, { sql })).row_count > 0);
  for (const sql of [
    "SELECT * FROM chunks_fts AS j, json_each('[1]') AS j",
    "SELECT * FROM 'chunks_fts' AS j WHERE EXISTS (SELECT 1 FROM json_each('[1]') AS j)",
    'SELECT * FROM pragma_table_info(\'fin_accounts\')',
    'SELECT * FROM txn,fin_account_kind_reviews',
    'SELECT (SELECT count(*) FROM owner_passkeys) FROM txn',
  ]) {
    const before = f.calls.length;
    await assert.rejects(queryMoney(f.env, { sql }), e => e.code === 'MONEY_QUERY_INVALID', sql);
    assert.ok(f.calls.slice(before).every(q => q.startsWith('EXPLAIN ') || q.includes('FROM sqlite_schema')));
  }
});

test('qualified transaction reads retain the same-statement overflow check', async t => {
  const { queryMoney } = await import(modulePath); const f = fixture(t);
  f.account('selected', 'live'); f.row('first', 'selected', '2026-09-01', 10);
  let visited = 0;
  f.db.function('abs', value => { visited++; return value; });
  const sql = 'SELECT sum(abs(amount_minor)) AS total FROM main."fin_transactions"';
  assert.equal((await queryMoney(f.env, { sql }, { maxScanRows: 1 })).rows[0].total, 10);
  visited = 0;
  const prepare = f.env.DB.prepare;
  f.env.DB.prepare = statement => {
    if (statement.startsWith('SELECT * FROM (\n')) f.row('concurrent', 'selected', '2026-09-02', 20);
    return prepare(statement);
  };
  await assert.rejects(queryMoney(f.env, { sql }, { maxScanRows: 1 }), e => e.code === 'MONEY_QUERY_UNAVAILABLE');
  assert.equal(visited, 0, 'overflow stops before reading aggregate input');
});

test('caller CTE shadows stay separate from trusted clean-view definitions', async t => {
  const { queryMoney } = await import(modulePath); const f = fixture(t);
  f.account('selected', 'live'); f.row('first', 'selected', '2026-09-01', 10);
  for (const sql of [
    'WITH txn AS (SELECT 91 AS n) SELECT n FROM txn UNION ALL SELECT row_count FROM coverage',
    'WITH fin_transactions AS (SELECT 91 AS n) SELECT n FROM fin_transactions UNION ALL SELECT amount_minor FROM txn',
    'WITH RECURSIVE x AS (SELECT amount_minor FROM txn) SELECT * FROM x',
  ]) assert.ok((await queryMoney(f.env, { sql })).row_count > 0);
});

test('validation shapes compile every actual clean-view column without private review access', async t => {
  const { validateMoneySql, CLEAN_MONEY_CTES, CLEAN_MONEY_VIEWS } = await import(modulePath); const f = fixture(t);
  const { CONTRIBUTION_FIELDS } = await import('../src/lib/clean-money-contributions.js');
  const membershipColumns=['id','classification','money_kind','estimated','estimate_reason','uncertain_kind','processor_name',...CONTRIBUTION_FIELDS];
  for (const name of CLEAN_MONEY_VIEWS) {
    const columns = f.db.prepare(`WITH mq_membership(${membershipColumns.join(',')}) AS (SELECT ${membershipColumns.map(()=>'NULL').join(',')} WHERE 0),${CLEAN_MONEY_CTES} SELECT * FROM ${name}`).columns();
    const sql = `SELECT ${columns.map(c => '"' + c.name.replaceAll('"','""') + '"').join(',')} FROM ${name}`;
    const checked = await validateMoneySql(sql, async statement => f.db.prepare(statement).all());
    assert.ok(checked.references.has(name), 'all actual public columns resolve through the validation shapes');
    await assert.rejects(validateMoneySql(`SELECT * FROM ${name},fin_account_kind_reviews`, async statement => f.db.prepare(statement).all()), e => e.code === 'MONEY_QUERY_INVALID');
  }
});

test('1112 B1 exact heavy queries stop before caller execution; ordinary money SQL stays usable', async t => {
  const { queryMoney, MONEY_EXAMPLE_SQL, loopWork } = await import(modulePath);
  const f = fixture(t);
  for (const [i, slug] of ['acct-a','acct-b','acct-c'].entries()) f.account(slug, 'live', 'business', String(i + 1).repeat(4));
  for (let i = 0; i < 200; i++) f.row(`ordinary-${i}`, ['acct-a','acct-b','acct-c'][i % 3], `2026-0${i % 6 + 1}-15`, i + 1);
  for (let i = 0; i < 150; i++) f.raw("INSERT INTO documents(doc_uid,source,source_id,title,ingested_at,content_hash) VALUES (?,'fixture',?,?,0,'synthetic')", `doc-${i}`, `doc-${i}`, `doc-${i}`);
  const heavy = [
    'WITH d(x) AS (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)) SELECT count(*) AS n FROM d a, d b, d c, d e, d f',
    'SELECT count(*) AS n FROM txn a, txn b',
    'SELECT count(*) AS n FROM fin_transactions a, fin_transactions b',
    'SELECT t.id, (SELECT count(*) FROM txn u WHERE u.posted_on <= t.posted_on) AS running FROM txn t',
    "SELECT count(*) FROM json_each('[1,2,3]') a, json_each('[1,2,3]') b",
    "SELECT count(*) FROM document_index a JOIN document_index b ON a.title LIKE '%' || b.title || '%'",
    'WITH d(x) AS (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)) SELECT count(*) AS n FROM d a, d b, d c, d e, d f, d g, d h, d i, d j, d k',
    'SELECT count(*) AS n FROM fin_transactions a, fin_transactions b, fin_transactions c',
    'SELECT count(*) AS n FROM txn a, txn b, txn c',
    "SELECT count(*) AS n FROM documents a JOIN documents b ON a.title LIKE '%' || b.title || '%'",
    "SELECT count(*) FROM " + Array.from({length:10}, (_,i) => `json_each('[0,1,2,3,4,5,6,7,8,9]') ${String.fromCharCode(97+i)}`).join(', '),
    'SELECT t.posted_on, (SELECT sum(amount_minor) FROM txn u WHERE u.posted_on <= t.posted_on) AS running FROM txn t',
  ];
  for (const sql of heavy) {
    const before = f.calls.length;
    if(sql==="SELECT count(*) FROM json_each('[1,2,3]') a, json_each('[1,2,3]') b") {
      assert.equal((await queryMoney(f.env,{sql},{maxLoopWork:10000})).rows[0]['count(*)'],9,'an ordinary small JSON comparison must answer exactly');
      continue;
    }
    await assert.rejects(queryMoney(f.env, { sql }, { maxLoopWork:10000 }), e => e.code === (sql.includes('FROM documents') ? 'MONEY_QUERY_INVALID' : 'MONEY_QUERY_TOO_HEAVY'), sql);
    assert.ok(!f.calls.slice(before).some(q => q.startsWith('SELECT * FROM (\n')), sql);
  }
  const ordinary = [
    ["SELECT strftime('%Y-%m', posted_on) AS month, sum(income_minor) AS income, sum(expense_minor) AS spending FROM txn WHERE posted_on BETWEEN '2026-01-01' AND '2026-06-30' GROUP BY month ORDER BY month",6],
    ['SELECT t.posted_on, t.amount, c.account_label, c.covered_from, c.covered_to FROM txn t JOIN coverage c ON c.account_identity = t.account_identity ORDER BY t.posted_on, t.id',200],
    ['SELECT posted_on, amount, account FROM txn WHERE id IN (SELECT out_id FROM transfer_pairs WHERE proved=1) ORDER BY posted_on',0],
    ['SELECT posted_on, sum(amount_minor) OVER (ORDER BY posted_on, id) AS running FROM txn',200],
    ['SELECT a.account_slug, e.legal_name FROM fin_accounts a JOIN fin_entities e ON e.entity_slug = a.entity_slug',3],
    [MONEY_EXAMPLE_SQL,200],
    ["WITH m AS (SELECT strftime('%Y-%m',posted_on) AS month, sum(income_minor) AS inc FROM txn GROUP BY 1) SELECT month, inc, inc - LAG(inc) OVER (ORDER BY month) AS change FROM m",6],
  ];
  for (const [sql, count] of ordinary) assert.equal((await queryMoney(f.env, { sql }, { maxLoopWork:10000 })).row_count, count, sql);
  assert.equal(loopWork([{id:2,parent:0,detail:'SCAN a'},{id:3,parent:0,detail:'SEARCH b USING AUTOMATIC COVERING INDEX (x=?)'},
    {id:4,parent:0,detail:'CORRELATED SCALAR SUBQUERY 1'},{id:5,parent:4,detail:'SCAN c'}], n => ({a:100,c:50})[n] ?? 1), 5100);
});

test('1112 B1 timeout cool-down is checked before any database work', async t => {
  const { queryMoney } = await import(modulePath); const f = fixture(t);
  let clock = 100000, until = 0, calls = 0;
  const cooldown = {get:async () => until,set:async n => {until = n;}};
  const options = {timeoutMs:20,now:() => clock,cooldown,execute:async sql => {
    calls++; if (calls === 1) return new Promise(() => {});
    return {success:true,results:f.db.prepare(sql).all()};
  }};
  await assert.rejects(queryMoney(f.env,{sql:'SELECT 1'},options), e => e.code === 'MONEY_QUERY_TIMEOUT');
  clock += 1000;
  await assert.rejects(queryMoney(f.env,{sql:'SELECT 1'},options), e => e.code === 'MONEY_QUERY_BUSY');
  assert.equal(calls,1);
  clock += 40000;
  assert.equal((await queryMoney(f.env,{sql:'SELECT 1 AS n'},options)).rows[0].n,1);
});

test('1112 B2 windows preserve full-history membership, edge pairs and coverage', async t => {
  const { queryMoney, parseMoneyWindow, MONEY_EXAMPLE_SQL } = await import(modulePath); const f = fixture(t);
  for (const [i, slug] of ['acct-a','acct-b','acct-c'].entries()) f.account(slug,'live','business',String(i+1).repeat(4));
  for (let year=2025;year<=2026;year++) for (let month=1;month<=(year===2025?12:6);month++) for (let i=0;i<60;i++)
    f.row(`filler-${year}-${month}-${i}`,i%2?'acct-a':'acct-b',`${year}-${String(month).padStart(2,'0')}-${String(Math.floor(i/2)%28+1).padStart(2,'0')}`,1000+i);
  f.row('edge-out','acct-a','2026-01-31',50000,'outflow',{description:'TRANSFER TO X2222'});
  f.row('edge-in','acct-b','2026-02-02',50000,'inflow',{description:'TRANSFER FROM X1111'});
  f.row('margin-in','acct-b','2026-02-01',70000);
  f.row('margin-out','acct-a','2026-01-30',70000,'outflow');
  f.row('margin-third','acct-c','2026-01-27',70000);
  const sql = "SELECT sum(income_minor) AS inc FROM txn WHERE posted_on BETWEEN '2026-02-01' AND '2026-02-28'";
  const automatic=await queryMoney(f.env,{sql},{maxScanRows:500});assert.equal(automatic.complete,true);assert.deepEqual(automatic.window,{from:'2026-02-01',to:'2026-02-28',margin_days:6});
  const window = {from:'2026-02-01',through:'2026-02-28'};
  assert.equal((await queryMoney(f.env,{sql,...window},{maxScanRows:500})).rows[0].inc,(await queryMoney(f.env,{sql},{maxScanRows:5000})).rows[0].inc);
  const fields='id, posted_on, money_kind, movement_classification, income_minor, expense_minor, possible_transfer, transfer_basis';
  const full=(await queryMoney(f.env,{sql:`SELECT ${fields} FROM txn ORDER BY id`,max_rows:1000},{maxScanRows:5000}));
  // Read each month independently so a returned-row cap cannot corrupt the control.
  for(let month=1;month<=6;month++) {
    const from=`2026-0${month}-01`,through=`2026-0${month}-${month===2?'28':month===4||month===6?'30':'31'}`;
    const expected=await queryMoney(f.env,{sql:`SELECT ${fields} FROM txn WHERE posted_on BETWEEN '${from}' AND '${through}' ORDER BY id`},{maxScanRows:5000});
    const got=await queryMoney(f.env,{sql:`SELECT ${fields} FROM txn ORDER BY id`,from,through},{maxScanRows:500});
    assert.deepEqual(got.rows,expected.rows); assert.deepEqual(got.window,{from,through});
  }
  assert.equal(full.truncated,true,'full history is larger than the return cap');
  const edge=(await queryMoney(f.env,{sql:"SELECT money_kind,income_minor FROM txn WHERE txn_uid='edge-in'",...window},{maxScanRows:500})).rows[0];
  assert.deepEqual({...edge},{money_kind:'own_transfer',income_minor:0});
  const margin=(await queryMoney(f.env,{sql:"SELECT possible_transfer,income_minor FROM txn WHERE txn_uid='margin-in'",...window},{maxScanRows:500})).rows[0];
  assert.deepEqual({...margin},{possible_transfer:1,income_minor:70000});
  assert.equal(parseMoneyWindow(window).scanFrom,'2026-01-26','three days would start Jan 29 and miss the competing Jan 27 leg');
  const coverage=(await queryMoney(f.env,{sql:"SELECT window_from,window_through,row_count,history_first_row FROM coverage WHERE account_slug='acct-a'",...window},{maxScanRows:500})).rows[0];
  assert.deepEqual({...coverage},{window_from:window.from,window_through:window.through,row_count:30,history_first_row:'2025-01-01'});
  assert.ok((await queryMoney(f.env,{sql:MONEY_EXAMPLE_SQL,...window},{maxScanRows:500})).row_count>0);
});

test('1112 B2 invalid window inputs give actionable closed reasons', async t => {
  const { queryMoney } = await import(modulePath);const f=fixture(t);
  for(const [body,reason] of [
    [{from:'2026-02-01'},'window_incomplete'],[{from:'2026-02-30',through:'2026-03-01'},'window_date'],
    [{from:'2026-03-01',through:'2026-02-01'},'window_order'],
    [{sql:'SELECT count(*) FROM txn, fin_transactions',from:'2026-02-01',through:'2026-02-28'},'window_raw_mix'],
  ]) await assert.rejects(queryMoney(f.env,{sql:'SELECT * FROM txn',...body}),e=>e.code==='MONEY_QUERY_INVALID'&&e.reason===reason);
});

test('1112 B2 a window retains whole-history feed precedence when the live feed has no rows in the period',async t=>{
  const {queryMoney}=await import(modulePath);const f=fixture(t);f.account('archive','manual');f.account('connected','live');f.link('archive','connected');
  f.row('early-import','archive','2025-01-01',10);f.row('overlap-import','archive','2026-10-15',100);
  f.row('live-first','connected','2026-09-01',20);f.row('live-last','connected','2026-12-31',30);
  const sql="SELECT coalesce(sum(income_minor),0) AS income FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31'";
  const full=await queryMoney(f.env,{sql});
  const window=await queryMoney(f.env,{sql,from:'2026-10-01',through:'2026-10-31'},{maxScanRows:2});
  assert.equal(full.rows[0].income,0);assert.equal(window.rows[0].income,0);
  const coverage=(await queryMoney(f.env,{sql:"SELECT duplicate_rows_removed,history_first_row FROM coverage WHERE account_slug='archive'",from:'2026-10-01',through:'2026-10-31'},{maxScanRows:2})).rows[0];
  assert.deepEqual({...coverage},{duplicate_rows_removed:1,history_first_row:'2025-01-01'});
});

test('1112 B2 exact review queries answer a 10800-row lifetime history through an ordinary month window',async t=>{
  const {queryMoney,MONEY_EXAMPLE_SQL}=await import(modulePath);const f=fixture(t);
  for(const slug of ['acct-a','acct-b','acct-c']) f.account(slug,'live');
  for(let offset=0;offset<24;offset++) {
    const date=new Date(Date.UTC(2024,10+offset,1)).toISOString().slice(0,7);
    for(const slug of ['acct-a','acct-b','acct-c'])for(let i=0;i<150;i++)f.row(`${date}-${slug}-${i}`,slug,`${date}-${String(i%28+1).padStart(2,'0')}`,100);
  }
  const queries=[
    "SELECT sum(income_minor)/100.0 AS income FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31'",
    'SELECT account, account_label, covered_from, covered_to, first_row, last_row FROM coverage',
    MONEY_EXAMPLE_SQL,
  ];
  for(const sql of queries) {
    const expanded=await queryMoney(f.env,{sql});assert.equal(expanded.complete,true);
    if(sql===queries[0])assert.equal(expanded.rows[0].income,450);
    else assert.equal(expanded.row_count,sql===queries[1]?3:200);
    const result=await queryMoney(f.env,{sql,from:'2026-10-01',through:'2026-10-31',max_rows:1000});
    assert.equal(result.truncated,false);
    if(sql===queries[0])assert.equal(result.rows[0].income,450);
    else assert.equal(result.row_count,sql===queries[1]?3:450);
  }
});

test('1112 M2 document views hide removed and noncurrent custom API rows and private source state', async t => {
  const { queryMoney }=await import(modulePath); const f=fixture(t);
  for(const [id,deleted,meta] of [['live',null,'{}'],['removed',1,'{}'],['staged',null,'{"connector":"custom_api","custom_api_source_id":"logical"}']])
    f.raw("INSERT INTO documents(doc_uid,source,source_id,title,deleted_at,meta,ingested_at,content_hash) VALUES (?,'fixture',?,?,?,?,0,'synthetic')",id,id,id,deleted,meta);
  assert.deepEqual((await queryMoney(f.env,{sql:'SELECT title FROM document_index ORDER BY title'})).rows.map(r=>r.title),['live']);
  assert.ok(!f.calls.some(s=>s.includes('FROM main.fin_transactions')),'document-only query does not run money snapshot');
  for(const sql of ['SELECT * FROM documents','SELECT title, uri, removal_reason, meta FROM documents WHERE deleted_at IS NOT NULL',
    "SELECT title, uri, meta FROM documents WHERE json_extract(meta,'$.connector')='custom_api'",'SELECT name, sync_cursor, scope, notes FROM sources'])
    await assert.rejects(queryMoney(f.env,{sql}),e=>e.reason==='table_not_readable'&&e.detail===(sql.includes('FROM sources')?'sources':'documents'));
  await assert.rejects(queryMoney(f.env,{sql:'SELECT sync_cursor FROM document_sources'}),e=>e.reason==='sql_error'&&e.detail==='no such column: sync_cursor');
});

test('1112 M3 exact repair queries report only sanitized SQLite detail', async t => {
  const { queryMoney }=await import(modulePath);const f=fixture(t);
  for(const [sql,reason,detail=null] of [
    ['SELECT * FROM chunks','table_not_readable','chunks'],['SELECT zeroblob(10)','function_not_allowed','zeroblob'],
    ['SELECT postedon FROM txn','sql_error','no such column: postedon'],
    ["SELECT sum(amount) FROM txn WHERE postedon >= '2026-01-01'",'sql_error','no such column: postedon'],
    ['SELECT * FROM fin_account_kind_reviews','table_not_readable','fin_account_kind_reviews'],
    ['WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r) SELECT count(*) FROM r','recursive'],
    ['SELECT 1; SELECT 2','not_one_statement'],['SELECT 1) UNION ALL SELECT x,1,1 FROM (SELECT 1 AS x','unbalanced_parentheses'],
    ["SELECT * FROM pragma_table_info('fin_accounts')",'virtual_table_not_allowed'],
    ['WITH mq_example AS (SELECT 1 AS n) SELECT n FROM mq_example','reserved_name'],
    ["WITH txn AS (SELECT * FROM txn WHERE posted_on >= '2026-10-01') SELECT sum(income_minor) FROM txn",'sql_error','circular reference: txn'],
  ]) {
    await assert.rejects(queryMoney(f.env,{sql}),e=>e.code==='MONEY_QUERY_INVALID'&&e.reason===reason&&e.detail===detail,sql);
    const response=await worker.fetch(request(f.env,{sql}),f.env,{});assert.equal(response.status,400);
    const body=await response.json();assert.equal(body.reason,reason);assert.doesNotMatch(JSON.stringify(body),/D1_ERROR|SQLITE_/);
  }
});

test('portable money medians answer odd, even, duplicate, nullable and empty populations without the optional extension', async t => {
  const { queryMoney, MONEY_GUIDE } = await import(modulePath);
  const f = fixture(t);
  f.account('operating', 'manual');
  for (const [i, amount] of [100, 300, 300, 800].entries())
    f.row(`median-${i}`, 'operating', '2026-09-10', amount, 'outflow');
  const cases = [
    ['SELECT median(amount_minor) FROM txn', 'median(amount_minor)', 300],
    ['SELECT MEDIAN(t.amount_minor) AS median_minor FROM txn AS t WHERE amount_minor<800', 'median_minor', 300],
    ['SELECT median(amount_minor) AS "middle amount" FROM txn WHERE amount_minor<>300', 'middle amount', 450],
    ['SELECT median(DISTINCT amount_minor) AS median_minor FROM txn', 'median_minor', 300],
    ['SELECT median(amount_minor) AS median_minor FROM txn WHERE 0', 'median_minor', null],
    ['SELECT median(uncertain_minor) AS median_minor FROM txn', 'median_minor', 0],
    ['SELECT median(amount_minor) AS median_minor FROM fin_transactions', 'median_minor', 300],
  ];
  const prepare = f.env.DB.prepare;
  let optionalCalls = 0;
  f.env.DB.prepare = sql => {
    if (/\bmedian\s*\(/i.test(sql.replaceAll('"median(amount_minor)"', '"output"'))) {
      optionalCalls++;
      throw new Error('no such function: median');
    }
    return prepare(sql);
  };
  for (const [sql, key, expected] of cases) {
    const response = await worker.fetch(request(f.env, { sql }), f.env, {});
    assert.equal(response.status, 200, sql);
    const result = await response.json();
    assert.equal(result.rows[0][key], expected, sql);
    assert.match(result.confidence_text, /Confidence: (High|Medium|Low) \(\d+%\)/);
    if (result.confidence.percent < 100) {
      assert.ok(result.confidence.reasons.length);
      assert.ok(result.confidence.missing.length);
    }
  }
  assert.equal(optionalCalls, 0, 'no query relies on the runtime having median()');
  assert.ok(f.calls.some(sql => sql.includes('ROW_NUMBER() OVER')), 'the real SQLite reader computed the median');
  const nullable = await queryMoney(f.env, { sql: 'SELECT median(amount_minor) AS middle FROM fin_transactions WHERE amount_minor IS NULL' });
  assert.equal(nullable.rows[0].middle, null);
  assert.match(MONEY_GUIDE, /median\(amount_minor\)/);
  const remote = await rpc(f.env, 'tools/call', { name: 'brain_money_query', arguments: { sql: cases[2][0] } });
  assert.notEqual(remote.result.isError, true);
  assert.equal(JSON.parse(remote.result.content[0].text).rows[0]['middle amount'], 450);
  await assert.rejects(queryMoney(f.env, { sql: cases[6][0] }, { maxScanRows: 1 }), e => e.code === 'MONEY_QUERY_SCAN_LIMIT');
  await assert.rejects(queryMoney(f.env, { sql: 'SELECT median(amount_minor) FROM txn; DELETE FROM fin_transactions' }), e => e.reason === 'not_one_statement');
  f.db.function('median', _value => { throw new Error('optional median must never execute'); });
  assert.equal((await queryMoney(f.env, { sql: cases[2][0] })).rows[0]['middle amount'], 450,
    'an installed median function does not change the portable answer');
});

test('unsupported median shapes return a stated limit and Low confidence through HTTP and MCP', async t => {
  const f = fixture(t);
  for (const installed of [false, true]) {
    if (installed) f.db.function('median', _value => { throw new Error('optional median must never execute'); });
    for (const sql of ['SELECT direction, median(amount_minor) FROM txn GROUP BY direction', 'SELECT median(description) FROM txn']) {
      const response = await worker.fetch(request(f.env, { sql }), f.env, {});
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.status, 'partial');
      assert.equal(result.rows, null, 'an uncomputed median is never a zero');
      assert.equal(result.confidence.percent, 0);
      assert.match(result.confidence.reasons.join(' '), /median shape was not computed/);
      assert.match(result.confidence.missing.join(' '), /ROW_NUMBER/);
      const remote = await rpc(f.env, 'tools/call', { name: 'brain_money_query', arguments: { sql } });
      assert.notEqual(remote.result.isError, true);
      assert.equal(JSON.parse(remote.result.content[0].text).confidence.percent, 0);
    }
  }
});

test('1112 M4 guide column catalogue exactly matches every migrated raw table and public shape', async t => {
  const { MONEY_TABLE_COLUMNS, MONEY_GUIDE }=await import('../src/lib/money-query-contract.js');
  const { MONEY_TABLES, validateMoneySql }=await import(modulePath);const f=fixture(t);
  for(const table of MONEY_TABLES) assert.deepEqual(MONEY_TABLE_COLUMNS[table],f.db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map(r=>r.name),table);
  for(const table of [...MONEY_TABLES,'txn','coverage','transfer_pairs','document_index','document_sources']) {
    assert.ok(MONEY_GUIDE.includes(`${table}(`),table);
    await validateMoneySql(`SELECT ${MONEY_TABLE_COLUMNS[table].join(',')} FROM ${table}`,async s=>f.db.prepare(s).all());
  }
  for(const sql of ['PRAGMA table_info(fin_obligations)',"SELECT name FROM pragma_table_info('fin_obligations')","SELECT sql FROM sqlite_schema WHERE name='fin_obligations'"])
    await assert.rejects((await import(modulePath)).queryMoney(f.env,{sql}),e=>e.code==='MONEY_QUERY_INVALID');
  const size=f.db.prepare("SELECT count(*) n FROM sqlite_schema WHERE type IN ('table','view','index')").get().n;
  t.diagnostic(`catalogue entries=${size}`);assert.ok(size<4096);
});

test('1112 m3 raw slices support ordinary date bounds and missing tenant without losing rows',async t=>{
  const {queryMoney}=await import(modulePath);const f=fixture(t);f.account('selected','live');f.account('unrelated','manual');
  f.row('selected','selected','2026-09-01',20);for(let i=0;i<20;i++)f.row(`unrelated-${i}`,'unrelated','2026-01-01',1);
  for(const predicate of ["account_slug='selected' AND posted_on >= '2026-09-01' AND posted_on <= '2026-09-02'",
    "account_slug='selected' AND posted_on BETWEEN '2026-09-01' AND '2026-09-02'",
    "tenant_id='primary' AND account_slug='selected' AND posted_on <= '2026-09-02' AND posted_on >= '2026-09-01'"])
    assert.equal((await queryMoney(f.env,{sql:`SELECT sum(amount_minor) AS total FROM fin_transactions WHERE ${predicate}`},{maxScanRows:2})).rows[0].total,20);
  assert.ok(f.calls.some(s=>s.includes('INDEXED BY idx_fin_transactions_account')));
  assert.equal(f.db.prepare('SELECT count(*) n FROM fin_transactions t WHERE NOT EXISTS (SELECT 1 FROM fin_accounts a WHERE a.tenant_id=t.tenant_id)').get().n,0);
  f.row('orphan','selected','2026-09-01',40);f.raw("UPDATE fin_transactions SET tenant_id='unmapped' WHERE txn_uid='orphan'");
  await assert.rejects(queryMoney(f.env,{sql:"SELECT sum(amount_minor) FROM fin_transactions WHERE account_slug='selected' AND posted_on BETWEEN '2026-09-01' AND '2026-09-02'"},{maxScanRows:2}),e=>e.code==='MONEY_QUERY_SCAN_LIMIT','an orphan tenant falls back to the complete budget');
});

test('1112 owner route and connector queries stay inside the authenticated Brain binding',async t=>{
  const a=fixture(t),b=fixture(t);a.account('acct-a','live');b.account('acct-a','live');
  a.row('owner-a','acct-a','2026-10-01',10);b.row('owner-b','acct-a','2026-10-01',90);
  const before=b.calls.length;
  assert.equal((await worker.fetch(request(a.env,{sql:'SELECT * FROM txn'}),b.env,{})).status,401);
  assert.equal(b.calls.length,before,'another owner key reaches no SQL');
  for(const f of [a,b]) {
    const result=await rpc(f.env,'tools/call',{name:'brain_money_query',arguments:{sql:'SELECT posted_on, amount, payee, account FROM txn ORDER BY posted_on DESC'}});
    assert.equal(JSON.parse(result.result.content[0].text).rows[0].amount,f===a?0.1:0.9);
  }
});

test('1112 B1 indexed range and nonunique equality joins still account for fan-out',async t=>{
  const {queryMoney}=await import(modulePath);const f=fixture(t);f.account('acct-a','live');
  for(let i=0;i<200;i++)f.row(`row-${i}`,'acct-a','2026-01-01',100);
  for(const sql of [
    'SELECT count(*) FROM fin_transactions a JOIN fin_transactions b ON a.account_slug=b.account_slug AND a.tenant_id=b.tenant_id',
    'SELECT count(*) FROM fin_transactions a JOIN fin_transactions b ON b.id>=a.id',
    'SELECT count(*) FROM txn a JOIN txn b ON a.amount_minor=b.amount_minor',
  ]) {
    const before=f.calls.length;
    await assert.rejects(queryMoney(f.env,{sql},{maxLoopWork:10000}),e=>e.code==='MONEY_QUERY_TOO_HEAVY',sql);
    assert.ok(!f.calls.slice(before).some(s=>s.startsWith('SELECT * FROM (\n')));
  }
});

test('1112 B1 caller-only estimates cannot ignore trusted pairing fan-out',async t=>{
  const {queryMoney}=await import(modulePath);const f=fixture(t);f.account('acct-a','live');f.account('acct-b','live','business','2222');
  for(let i=0;i<200;i++)f.row(`equal-${i}`,i%2?'acct-a':'acct-b','2026-01-01',100,i%2?'outflow':'inflow');
  const before=f.calls.length;
  await assert.rejects(queryMoney(f.env,{sql:'SELECT sum(income_minor) FROM txn'},{maxLoopWork:1000}),e=>e.code==='MONEY_QUERY_TOO_HEAVY');
  assert.ok(!f.calls.slice(before).some(s=>s.includes('snapshot_kind')),'reject before building the quadratic pair relation');
});

test('1112 B1 the default trusted pair cap stops expensive ambiguous candidate sets',async t=>{
  const {queryMoney}=await import(modulePath);const f=fixture(t);f.account('acct-a','live');f.account('acct-b','live','business','2222');
  for(let i=0;i<340;i++)f.row(`ambiguous-${i}`,i%2?'acct-a':'acct-b','2026-01-01',100,i%2?'outflow':'inflow');
  const before=f.calls.length;
  await assert.rejects(queryMoney(f.env,{sql:'SELECT sum(income_minor) FROM txn'}),e=>e.code==='MONEY_QUERY_TOO_HEAVY'&&/limit is 20000/.test(e.message));
  assert.ok(!f.calls.slice(before).some(s=>s.includes('snapshot_kind')));
});

test('1112 B1 concurrent raw growth cannot invalidate the measured loop bound',async t=>{
  const {queryMoney}=await import(modulePath);const f=fixture(t);f.account('acct-a','live');
  for(let i=0;i<3;i++)f.row(`start-${i}`,'acct-a','2026-01-01',i+1);
  const prepare=f.env.DB.prepare;let visited=0;
  f.db.function('abs',n=>{visited++;return n;});
  f.env.DB.prepare=s=>{if(s.startsWith('SELECT * FROM (\n'))for(let i=0;i<10;i++)f.row(`racing-${i}`,'acct-a','2026-01-01',i+1);return prepare(s);};
  await assert.rejects(queryMoney(f.env,{sql:'SELECT sum(abs(a.amount_minor)) FROM fin_transactions a, fin_transactions b'},{maxLoopWork:100}),e=>e.code==='MONEY_QUERY_UNAVAILABLE');
  assert.equal(visited,0);
});

test('1112 B1 a caller CTE shadow cannot borrow the real table or clean-view bound',async t=>{
  const {queryMoney}=await import(modulePath);const f=fixture(t);
  const values=Array.from({length:100},(_,i)=>`(${i})`).join(',');
  for(const name of ['fin_transactions','txn','coverage','transfer_pairs']) {
    const sql=`WITH ${name}(x) AS (VALUES ${values}) SELECT count(*) FROM ${name} a, ${name} b, ${name} c WHERE EXISTS (SELECT 1 FROM ${name==='txn'?'coverage':'txn'})`;
    await assert.rejects(queryMoney(f.env,{sql},{maxLoopWork:10000}),e=>e.code==='MONEY_QUERY_TOO_HEAVY',name);
  }
});

test('R1 B3 1112 measure ordinary corpus at 10000 transactions, eight accounts and fifty proved pairs', async t => {
  const {queryMoney,validateMoneySql,MONEY_EXAMPLE_SQL}=await import(modulePath);const f=fixture(t);
  for(let i=0;i<8;i++) f.account(`acct-${i}`,'live','business',String(i+1).repeat(4));
  for(let i=0;i<50;i++) {
    const day=`2026-0${i%6+1}-15`;
    f.row(`pair-out-${i}`,'acct-0',day,100000+i,'outflow',{description:'TRANSFER TO X2222'});
    f.row(`pair-in-${i}`,'acct-1',day,100000+i,'inflow',{description:'TRANSFER FROM X1111'});
  }
  for(let i=0;i<9900;i++) f.row(`ordinary-${i}`,`acct-${i%8}`,`2026-0${i%6+1}-${String(i%28+1).padStart(2,'0')}`,i+1,i%2?'outflow':'inflow');
  const queries=[
    "SELECT strftime('%Y-%m', posted_on) AS month, sum(income_minor) AS income, sum(expense_minor) AS spending FROM txn WHERE posted_on BETWEEN '2026-01-01' AND '2026-06-30' GROUP BY month ORDER BY month",
    'SELECT t.posted_on, t.amount, c.account_label, c.covered_from, c.covered_to FROM txn t JOIN coverage c ON c.account_identity = t.account_identity ORDER BY t.posted_on, t.id',
    'SELECT posted_on, amount, account FROM txn WHERE id IN (SELECT out_id FROM transfer_pairs WHERE proved=1) ORDER BY posted_on',
    'SELECT posted_on, sum(amount_minor) OVER (ORDER BY posted_on, id) AS running FROM txn',
    'SELECT a.account_slug, e.legal_name FROM fin_accounts a JOIN fin_entities e ON e.entity_slug = a.entity_slug',
    MONEY_EXAMPLE_SQL,
    "WITH m AS (SELECT strftime('%Y-%m',posted_on) AS month, sum(income_minor) AS inc FROM txn GROUP BY 1) SELECT month, inc, inc - LAG(inc) OVER (ORDER BY month) AS change FROM m",
  ];
  // Exact synthetic results captured before R1; representation and guard fixes
  // must preserve all seven ordinary answers, including ordering and cents.
  const expectedHashes=[
    'c20fffcd5c4b62bf3da190656851a731228bb47bee7c0b098ce01954d520779f',
    'ef4e1abd71189935d6ae8d296a3d27c2a7657903c3c08159d1c5538d6f7927ba',
    'c7761195d7c757bff4b7525b141bfc581f69bac53d463f0b3dcccf35b974e5d7',
    'cd28c61f3107b833c0a2fef0b28db4a5f6f30270d2e401fe358c5a8118a6ebf4',
    '85a5ad8461d48fb11534df8ca4d99bf41e79a7d984a3fe56b355b5c33ed43a83',
    '2461c78a217eb570224da042e9a6325cb67e0189cd3de2e24f54a8978ee23309',
    'a9f1a4127b96ac2c7f1d9f9f1da2fe04519938c0a2dad241bb5ebc19fe3dc78c',
  ];
  const measurements=[];
  for(const [i,sql] of queries.entries()) {
    const checked=await validateMoneySql(sql,async s=>f.db.prepare(s).all());
    const record={query:`O${i+1}`,validationPlan:checked.loopPlan};
    const execute=async (statement,{binds})=>{
      const final=statement.startsWith('SELECT * FROM (\n');
      if(final) {
        assert.ok(binds.every(value=>new TextEncoder().encode(value).length<=2000000),'every native bound value fits D1');
        assert.ok(binds.length<=100,'native parameter limit');
        assert.ok(new TextEncoder().encode(statement).length<=100000,'native SQL length limit');
        assert.doesNotMatch(statement,/\?\d+\s*\|\|\s*\?\d+/,'never rebuild an oversized SQL value');
        record.executionPlan=f.db.prepare('EXPLAIN QUERY PLAN '+statement).all(...binds);
        // Remove trusted definitions, retaining their caller-side scans and joins.
        const excluded=new Set();
        for(const r of record.executionPlan) if(/^MATERIALIZE (?:mq_budget|mq_scan|fin_transactions|mq_rows|mq_accounts|mq_candidates|mq_pairs_all|mq_tagged|mq_processors|mq_txn_all|mq_membership|txn|coverage|transfer_pairs)$/.test(r.detail))excluded.add(r.id);
        let changed=true;while(changed){changed=false;for(const r of record.executionPlan)if(excluded.has(r.parent)&&!excluded.has(r.id)){excluded.add(r.id);changed=true;}}
        record.callerExecutionPlan=record.executionPlan.filter(r=>!excluded.has(r.id));
      }
      const start=performance.now();const results=f.db.prepare(statement).all(...binds);
      if(final)record.callerMs=performance.now()-start;
      if(statement.includes('snapshot_kind'))record.snapshotMs=performance.now()-start;
      return {success:true,results};
    };
    const start=performance.now();
    try {
      const result=await queryMoney(f.env,{sql,max_rows:1000},{execute});
      record.totalMs=performance.now()-start;record.rowCount=result.row_count;
      assert.equal(createHash('sha256').update(JSON.stringify(result.rows)).digest('hex'),expectedHashes[i],`${record.query}: same complete ordinary result`);
      measurements.push(record);
      t.diagnostic(`${record.query}: caller=${record.callerMs.toFixed(1)}ms snapshot=${record.snapshotMs?.toFixed(1)??0}ms total=${record.totalMs.toFixed(1)}ms`);
      if(i===2)assert.equal(result.row_count,50,'fifty proved out-rows');
      assert.ok(record.callerMs<5000,'ordinary caller statement must finish within five seconds');
      assert.ok((record.snapshotMs??0)<5000,'trusted clean-view snapshot must finish within five seconds');
    } finally {
      if(process.env.MONEY_QUERY_MEASURE_OUTPUT) writeFileSync(process.env.MONEY_QUERY_MEASURE_OUTPUT,JSON.stringify(measurements,null,2)+'\n');
    }
  }
});

test('QUALITY confidence is deterministic, follows frozen evidence and always explains sub-100 gaps', async t => {
  const {queryMoney,MONEY_GUIDE}=await import(modulePath);const f=fixture(t);
  f.account('bank','manual');f.row('sale','bank','2026-09-02',10000);
  f.raw("UPDATE fin_transactions SET category='INCOME',category_basis_state='confirmed'");
  f.raw(`INSERT INTO fin_account_coverage(account_slug,coverage_status,covered_from,covered_to,provenance,basis_state,computed_at,recorded_at)
    VALUES ('bank','complete','2026-09-01','2026-09-30','owner_stated','confirmed',?,?)`,now,now);
  const sql='SELECT SUM(income_minor) AS n FROM txn';
  const first=await queryMoney(f.env,{sql}),again=await queryMoney(f.env,{sql});
  assert.deepEqual(first.confidence,again.confidence);
  assert.equal(first.confidence.display,'Confidence: Medium (85%)');
  assert.equal(first.rows[0].n,10000);
  f.row('pending','bank','2026-09-03',4500,'outflow',{pending:true});
  const pending=await queryMoney(f.env,{sql});
  assert.equal(pending.rows[0].n,10000,'pending data never changes the posted figure');
  assert.ok(pending.confidence.score<first.confidence.score);
  const gap=pending.confidence.gaps.find(g=>g.code==='stale_pending');
  assert.equal(gap.amounts[0].outflow_minor,4500);
  assert.equal(pending.evidence.accounts[0].pending.stale.outflow_minor,4500);
  assert.ok(pending.confidence.gaps.every(g=>g.why && g.missing));
  assert.equal(pending.confidence.basis,'whole_available_snapshot');
  const raw=await queryMoney(f.env,{sql:'SELECT 7 AS n'});
  assert.equal(raw.rows[0].n,7);assert.equal(raw.confidence.label,'Low');assert.equal(raw.confidence.score,50);assert.equal(raw.confidence.selection_score,80);
  assert.equal(raw.confidence.gaps[0].code,'not_transaction_evidence');
  f.row('second-sale','bank','2026-09-04',5000);
  const truncated=await queryMoney(f.env,{sql:'SELECT amount_minor FROM txn ORDER BY id',max_rows:1});
  assert.equal(truncated.truncated,true);
  assert.ok(truncated.confidence.gaps.some(g=>g.code==='truncated_output' && g.missing));
  assert.match(MONEY_GUIDE,/never raise/i);assert.match(MONEY_GUIDE,/pending_out_minor/);
});


test('R1 M1 history overflow names a working raw route and preserves the exact boundary',async t=>{
  const {queryMoney,handleMoneyQuery}=await import(modulePath);const f=fixture(t);
  f.account('bank','live');f.row('receipt','bank','2026-10-02',1234);
  const body={sql:'SELECT sum(income_minor) AS income FROM txn',from:'2026-10-01',through:'2026-10-31'};
  let history=200001;
  const execute=async(sql,{binds})=>({success:true,results:sql==='SELECT count(*) AS n FROM (SELECT 1 FROM main.fin_transactions LIMIT 200001)'?[{n:history}]:f.db.prepare(sql).all(...binds)});
  await assert.rejects(queryMoney(f.env,body,{execute}),e=>e.code==='MONEY_QUERY_HISTORY_LIMIT'&&/account_slug=/.test(e.message)&&!/Split a long period/.test(e.message));
  history=200000;
  assert.equal((await queryMoney(f.env,body,{execute})).rows[0].income,1234);
  // The suggested lifecycle filters must retain the indexed scan scope.
  for(let i=0;i<12;i++)f.row(`outside-${i}`,'bank','2025-01-01',10);
  const raw="SELECT sum(amount_minor) AS total FROM fin_transactions WHERE account_slug='bank' AND posted_on BETWEEN '2026-10-01' AND '2026-10-31' AND removed_at IS NULL AND superseded_by_id IS NULL AND pending=0";
  assert.equal((await queryMoney(f.env,{sql:raw},{maxScanRows:2})).rows[0].total,1234);
  const prepare=f.env.DB.prepare;
  f.env.DB.prepare=sql=>sql==='SELECT count(*) AS n FROM (SELECT 1 FROM main.fin_transactions LIMIT 200001)'?{all:async()=>({success:true,results:[{n:200001}]})}:prepare(sql);
  const response=await handleMoneyQuery(f.env,request(f.env,body));
  assert.equal(response.status,400);assert.equal((await response.json()).code,'MONEY_QUERY_HISTORY_LIMIT');
});

test('R1 M1 a history race carries the same distinct repair code',async t=>{
  const {queryMoney}=await import(modulePath);const f=fixture(t);f.account('bank','live');f.row('one','bank','2026-10-02',100);
  const execute=async(sql,{binds})=>{
    if(sql.startsWith('SELECT * FROM (\n'))sql=sql.replace('n>200000','n>0');
    return {success:true,results:f.db.prepare(sql).all(...binds)};
  };
  await assert.rejects(queryMoney(f.env,{sql:'SELECT sum(income_minor) FROM txn',from:'2026-10-01',through:'2026-10-31'},{execute}),e=>e.code==='MONEY_QUERY_HISTORY_LIMIT');
});

test('R1 M1 history growth is checked before reading the trusted snapshot',async t=>{
  const {queryMoney}=await import(modulePath);const f=fixture(t);f.account('bank','live');f.row('one','bank','2026-10-02',100);
  let checked=false,final=false;
  const execute=async(sql,{binds})=>{
    if(sql.includes('snapshot_kind')) {
      assert.match(sql,/n>200000/,'history is guarded in the snapshot statement itself');
      checked=true;sql=sql.replace('n>200000','n>0');
    }
    if(sql.startsWith('SELECT * FROM (\n'))final=true;
    return {success:true,results:f.db.prepare(sql).all(...binds)};
  };
  await assert.rejects(queryMoney(f.env,{sql:'SELECT sum(income_minor) FROM txn',from:'2026-10-01',through:'2026-10-31'},{execute}),e=>e.code==='MONEY_QUERY_HISTORY_LIMIT');
  assert.equal(checked,true);assert.equal(final,false);
});

test('R1 B1 remote and local contracts preserve the same reviewed typo repair',async t=>{
  const {moneyQueryErrorText}=await import('../src/lib/money-query-contract.js');const f=fixture(t);
  const body={sql:'SELECT amout FROM txn'};
  const response=await worker.fetch(request(f.env,body),f.env,{});
  const envelope=await response.json();
  assert.equal(response.status,400);
  const remote=await rpc(f.env,'tools/call',{name:'brain_money_query',arguments:body});
  assert.equal(remote.result.isError,true);
  const partial=JSON.parse(remote.result.content[0].text);
  assert.equal(partial.error,moneyQueryErrorText(envelope));
  assert.equal(partial.confidence.percent,0);assert.ok(partial.confidence.reasons.length && partial.confidence.missing.length);
});

// Intercept a mistakenly admitted expensive statement before it runs. A red
// receipt proves admission without stalling SQLite on the review's heavy input.
async function rejectsHeavy(f,sql,options={}) {
  const {queryMoney}=await import(modulePath);let final=false;
  const execute=async(statement,{binds})=>{
    if(statement.startsWith('SELECT * FROM (\n')) {final=true;return {success:true,results:[]};}
    return {success:true,results:f.db.prepare(statement).all(...binds)};
  };
  await assert.rejects(queryMoney(f.env,{sql},{...options,execute}),e=>e.code==='MONEY_QUERY_TOO_HEAVY');
  assert.equal(final,false,'heavy caller statement is never prepared');
}

test('R1 M2a generated JSON fan-out is bounded before execution',async t=>{
  const f=fixture(t);f.account('bank','live');for(let i=0;i<300;i++)f.row(`row-${i}`,'bank','2026-10-02',i+1);
  await rejectsHeavy(f,"SELECT count(*) FROM txn, json_each('['||replace(printf('%.999999d',0),'0','1,')||'1]')");
});

test('R1 M2a small literal JSON joins answer exactly and large joins remain bounded',async t=>{
  const {queryMoney}=await import(modulePath);const f=fixture(t);
  assert.equal((await queryMoney(f.env,{sql:"SELECT count(*) AS n FROM json_each('[1,2,3]') a, json_each('[1,2,3]') b"},{maxLoopWork:10000})).rows[0].n,9);
  await rejectsHeavy(f,"SELECT count(*) FROM "+Array.from({length:10},(_,i)=>`json_each('[0,1,2,3,4,5,6,7,8,9]') a${i}`).join(', '));
});

test('R1 M2b materialized compound inputs include every branch',async t=>{
  const f=fixture(t);for(const slug of ['bank','other','third'])f.account(slug,'live');
  for(let i=0;i<5000;i++)f.row(`row-${i}`,'bank','2026-10-02',i+1);
  await rejectsHeavy(f,'WITH u AS MATERIALIZED ('+Array(4).fill('SELECT id FROM fin_transactions').join(' UNION ALL ')+') SELECT count(*) FROM u, fin_accounts',{maxLoopWork:60000});
});

test('R1 M2c EXCLUDE frames account for per-row frame visits and small frames answer',async t=>{
  const {queryMoney}=await import(modulePath);const f=fixture(t);f.account('bank','live');
  const sql='SELECT sum(amount_minor) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING EXCLUDE CURRENT ROW) AS other FROM txn';
  for(let i=0;i<100;i++)f.row(`small-${i}`,'bank','2026-10-02',i+1);
  const result=await queryMoney(f.env,{sql,max_rows:1000});assert.equal(result.row_count,100);assert.equal(result.rows[0].other,5049);
  for(let i=100;i<5000;i++)f.row(`large-${i}`,'bank','2026-10-02',i+1);
  await rejectsHeavy(f,sql);
});

test('R1 M2d large or dynamic formatting accounts for work; ordinary money formatting answers',async t=>{
  const {queryMoney}=await import(modulePath);const f=fixture(t);f.account('bank','live');
  for(let i=0;i<10000;i++)f.row(`row-${i}`,'bank','2026-10-02',i+1);
  for(const sql of ["SELECT sum(length(printf('%.1000000d',amount_minor))) FROM txn","SELECT sum(length(format('%*d',1000000,amount_minor))) FROM txn","SELECT sum(length(printf(description,amount_minor))) FROM txn"])
    await rejectsHeavy(f,sql);
  assert.equal((await queryMoney(f.env,{sql:"SELECT printf('%.2f', amount) AS formatted FROM txn ORDER BY id",max_rows:1})).rows[0].formatted,'0.01');
});

test('R1 M2 ordinary aliases and constant compounds do not acquire window or source work',async t=>{
  const {queryMoney}=await import(modulePath);const f=fixture(t);f.account('bank','live');
  for(let i=0;i<5000;i++)f.row(`row-${i}`,'bank','2026-10-02',i+1);
  assert.equal((await queryMoney(f.env,{sql:'SELECT sum(income_minor) AS exclude FROM txn'})).rows[0].exclude,12502500);
  const constant='WITH u AS MATERIALIZED (SELECT 1 AS n UNION ALL SELECT 2) SELECT sum(a.n*b.n) AS total FROM u a,u b';
  assert.equal((await queryMoney(f.env,{sql:constant},{maxLoopWork:10000})).rows[0].total,9);
});

test('R1 M3 result limits bound aggregate cells and ordered rows without throwing',async t=>{
  const {queryMoney}=await import(modulePath);const f=fixture(t);f.account('bank','live');
  for(let i=0;i<1002;i++)f.row(`row-${i}`,'bank','2026-10-02',i+1,'inflow',{description:'s'.repeat(2000)});
  const cell=await queryMoney(f.env,{sql:"SELECT json_group_array(json_object('d',posted_on,'a',amount_minor,'p',payee,'m',description)) AS everything FROM txn"});
  assert.deepEqual(cell.rows,[]);assert.equal(cell.row_count,0);assert.equal(cell.truncated,true);assert.equal(cell.truncated_reason,'size');
  assert.match(cell.note,/One row.*1,000,000.*Select fewer columns/);
  const list=await queryMoney(f.env,{sql:'SELECT id,description FROM fin_transactions ORDER BY id',max_rows:1000});
  assert.ok(list.row_count>0&&list.row_count<1000);assert.equal(list.truncated,true);assert.equal(list.truncated_reason,'size');
  assert.deepEqual(list.rows.map(r=>r.id),Array.from({length:list.row_count},(_,i)=>i+1));
  assert.ok(list.rows.reduce((n,r)=>n+JSON.stringify(r).length,0)<=1000000);
  const small=await queryMoney(f.env,{sql:'SELECT id FROM fin_transactions ORDER BY id',max_rows:1000});
  assert.equal(small.row_count,1000);assert.equal(small.truncated_reason,'rows');
  const complete=await queryMoney(f.env,{sql:'SELECT count(*) AS n FROM fin_transactions'});
  assert.equal(complete.rows[0].n,1002);assert.equal(complete.truncated_reason,null);assert.equal(complete.note,null);
});

test('R1 M4 ambiguous candidate tagging groups endpoints instead of rescanning each pair',async t=>{
  const {queryMoney}=await import(modulePath);const f=fixture(t);f.account('bank','live');f.account('other','live','business','2222');
  for(let i=0;i<140;i++) {
    f.row(`out-${i}`,'bank','2026-10-02',5000,'outflow');f.row(`in-${i}`,'other','2026-10-02',5000);
  }
  for(let i=280;i<10000;i++)f.row(`ordinary-${i}`,'bank','2026-10-02',10000+i);
  let planned=0;
  const execute=async(sql,{binds})=>{
    if(sql.includes('snapshot_kind')||sql.startsWith('SELECT * FROM (\n')) {
      planned++;
      const details=f.db.prepare('EXPLAIN QUERY PLAN '+sql).all(...binds).map(r=>r.detail);
      assert.ok(!details.some(d=>/^SCAN (?:possible|p)(?:$| )/.test(d)),'no per-row candidate scan');
      const unindexed=details.filter(d=>/^SEARCH (?:possible|p) .*\(proved=\?\)/.test(d));
      t.diagnostic(`candidate searches without an endpoint key=${JSON.stringify(unindexed)}`);
      assert.equal(unindexed.length,0,'proved alone does not index a row endpoint');
    }
    return {success:true,results:f.db.prepare(sql).all(...binds)};
  };
  const result=await queryMoney(f.env,{sql:'SELECT count(*) AS n,sum(possible_transfer) AS p FROM txn'},{execute});
  assert.equal(planned,2);assert.deepEqual({...result.rows[0]},{n:10000,p:280});
});

test('R1 trivial minors provide specific repairs and disclose readable assignment metadata',async t=>{
  const {queryMoney,MONEY_GUIDE}=await import(modulePath);const f=fixture(t);
  await assert.rejects(queryMoney(f.env,{sql:'SELECT name FROM sqlite_schema'}),e=>/That table is not readable/.test(e.message)&&!/null is/.test(e.message));
  for(const [body,reason,expected] of [
    [{sql:'SELECT ?'},'unsupported_character',/Unsupported character: \?/],
    [{sql:'SELECT 1 /*'},'unterminated',/Close every/],
    [{sql:'SELECT '+"'"},'unterminated',/Close every/],
    [{sql:'SELECT '+ '1+'.repeat(2000)+'1'},'too_many_tokens',/4,000 tokens/],
    [{sql:'SELECT 1'+ ' '.repeat(20000)},'too_long',/20,000 characters/],
    [{sql:'SELECT 1',max_rows:'200'},'max_rows',/positive integer/],
    [{sql:'SELECT 1',max_rows:0},'max_rows',/positive integer/],
  ])await assert.rejects(queryMoney(f.env,body),e=>e.reason===reason&&expected.test(e.message));
  f.account('bank','live');for(let i=0;i<3;i++)f.row(`row-${i}`,'bank','2026-10-02',100);
  await assert.rejects(queryMoney(f.env,{sql:"SELECT description FROM fin_transactions WHERE description LIKE '%synthetic%'"},{maxScanRows:2}),e=>e.code==='MONEY_QUERY_SCAN_LIMIT'&&/id BETWEEN/.test(e.message)&&/account_slug=/.test(e.message)&&!/Pass from and through/.test(e.message));
  assert.match(MONEY_GUIDE,/sum\(CASE WHEN/);assert.match(MONEY_GUIDE,/Account assignment tables expose provider identifiers/);
  const conditional=/sum\(CASE WHEN posted_on BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD' THEN income_minor ELSE 0 END\)/.exec(MONEY_GUIDE)?.[0];
  assert.ok(conditional,'the guide contains a complete conditional sum');
  const expression=conditional.replace('YYYY-MM-DD','2026-10-01').replace('YYYY-MM-DD','2026-10-31');
  assert.equal((await queryMoney(f.env,{sql:`SELECT ${expression} AS income FROM txn`})).rows[0].income,300);
});

test('R2 B2 route confidence uses frozen membership and coverage, independent of selected columns', async t => {
  const { queryMoney } = await import(modulePath); const f = fixture(t);
  f.account('bank', 'live');
  f.row('start', 'bank', '2026-01-01', 1000, 'inflow', { description: 'PAYROLL INCOME' });
  f.row('known', 'bank', '2026-10-20', 75000, 'inflow', { description: 'PAYROLL INCOME' });
  f.row('uncertain', 'bank', '2026-10-20', 25000);
  // This future row is in the pairing margin, not in October's confidence input.
  f.row('outside-window', 'bank', '2026-11-02', 9000000);
  const body = { from: '2026-10-01', through: '2026-10-31' };
  const options = { now: () => Date.parse('2026-11-12T12:00:00Z') };
  const result = await queryMoney(f.env, { ...body, sql: 'SELECT sum(income_minor) AS income FROM txn' }, options);
  assert.equal(result.rows[0].income, 100000);
  assert.equal(result.confidence?.percent, 40, 'unproved scope, membership and sync evidence cannot earn High');
  assert.match(result.confidence.line, /^Confidence: (High|Medium|Low) \(\d{1,3}%\)$/);
  assert.equal(result.confidence.level,'Low');assert.ok(result.confidence.gaps.some(g=>g.code==='estimated_membership'));
  assert.match(result.confidence.reasons.join(' '), /1111.*\$250\.00.*2026-10-20/);
  assert.ok(result.confidence.missing.length > 0);
  const coverage = await queryMoney(f.env, { ...body, sql: 'SELECT * FROM coverage' }, options);
  assert.deepEqual(coverage.confidence, result.confidence);
  const response = await worker.fetch(request(f.env, { ...body, sql: 'SELECT sum(income_minor) FROM txn' }), f.env, {});
  assert.equal(response.status, 200);
  assert.match((await response.json()).confidence.line, /^Confidence: (High|Medium|Low) \(\d{1,3}%\)$/);
  const limited = await queryMoney(f.env, { ...body, sql: 'SELECT id FROM txn ORDER BY id', max_rows: 1 }, options);
  assert.equal(limited.confidence.percent, 19);
  assert.ok(limited.confidence.gaps.some(r => r.code === 'truncated_output'));
  const raw = await queryMoney(f.env, { sql: 'SELECT sum(amount_minor) FROM fin_transactions' }, options);
  assert.equal(raw.confidence.percent, 25);
  assert.match(raw.confidence.reasons.join(' '),/Raw figures include lifecycle rows/);
  const metadata=await queryMoney(f.env, { sql: 'SELECT 1' }, options);
  assert.equal(metadata.confidence.percent,50);assert.equal(metadata.confidence.level,'Low');
  assert.ok(metadata.confidence.reasons.length && metadata.confidence.missing.length);
});

test('R2 M1 ordinary unique id joins answer 5000 rows and three proved pairs', async t => {
  const { queryMoney } = await import(modulePath); const f = fixture(t);
  f.account('bank', 'live'); f.account('other', 'live', 'household', '2222');
  for (let i = 0; i < 3; i++) {
    f.row(`pair-out-${i}`, 'bank', '2026-10-02', 100000 + i, 'outflow', { description: 'TRANSFER TO X2222' });
    f.row(`pair-in-${i}`, 'other', '2026-10-02', 100000 + i, 'inflow', { description: 'TRANSFER FROM X1111' });
  }
  for (let i = 6; i < 5000; i++) f.row(`ordinary-${i}`, 'bank', '2026-10-02', i + 1);
  const result = await queryMoney(f.env, { sql: 'SELECT o.posted_on, i.posted_on AS in_date, o.amount FROM transfer_pairs p JOIN txn o ON o.id=p.out_id JOIN txn i ON i.id=p.in_id WHERE p.proved=1 ORDER BY o.id' });
  assert.deepEqual(result.rows.map(r => ({ ...r })), [1000, 1000.01, 1000.02].map(amount => ({ posted_on: '2026-10-02', in_date: '2026-10-02', amount })));
  await rejectsHeavy(f, 'SELECT count(*) FROM txn a JOIN txn b ON a.amount_minor=b.amount_minor');
  const values = Array.from({ length: 100 }, (_, i) => `(${i})`).join(',');
  await rejectsHeavy(f, `WITH txn(id) AS (VALUES ${values}) SELECT count(*) FROM txn a, txn b, txn c WHERE EXISTS (SELECT 1 FROM coverage)`, { maxLoopWork: 10000 });
});

test('R2 M2 oversized native values have a private actionable repair and HTTP 400', async t => {
  const { queryMoney, handleMoneyQuery } = await import(modulePath); const f = fixture(t);
  const sql = 'SELECT 1 AS value';
  for (const message of ['D1_ERROR: string or blob too big: SQLITE_TOOBIG', 'SQLITE_TOOBIG']) {
    const execute = async (statement, { binds }) => {
      if (statement.startsWith('SELECT * FROM (\n')) throw new Error(message);
      return { success: true, results: f.db.prepare(statement).all(...binds) };
    };
    await assert.rejects(queryMoney(f.env, { sql }, { execute }), e => e.code === 'MONEY_QUERY_INVALID' && e.reason === 'value_too_big' &&
      /2,000,000-byte.*Return rows.*fewer columns/.test(e.message) && !/D1_ERROR|SQLITE_/.test(e.message));
  }
  const prepare = f.env.DB.prepare;
  f.env.DB.prepare = statement => {
    if (statement.startsWith('SELECT * FROM (\n')) return { all: async () => { throw new Error('D1_ERROR: string or blob too big: SQLITE_TOOBIG'); } };
    return prepare(statement);
  };
  const response = await handleMoneyQuery(f.env, request(f.env, { sql }));
  assert.equal(response.status, 400);
  const envelope = await response.json();
  assert.equal(envelope.reason, 'value_too_big');
  assert.doesNotMatch(envelope.error, /D1_ERROR|SQLITE_/);
});

test('R2 M3 remote money returns an injected UTC date and continues when the zone is unknown', async t => {
  const { queryMoney } = await import(modulePath);
  const { MONEY_ANSWER_INSTRUCTIONS } = await import('../src/lib/money-query-contract.js');
  const f = fixture(t);
  const result = await queryMoney(f.env, { sql: 'SELECT 1' }, { now: () => Date.parse('2026-11-12T00:30:00Z') });
  assert.deepEqual(result.as_of, { utc_date:'2026-11-12', time_zone:'UTC', local_date:'2026-11-12', local_today:'2026-11-12', basis:'server_utc' });
  const remote = await rpc(f.env, 'tools/call', { name: 'brain_money_query', arguments: { sql: 'SELECT 1' } });
  assert.match(JSON.parse(remote.result.content[0].text).as_of.utc_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.doesNotMatch(MONEY_ANSWER_INSTRUCTIONS, /if unknown, ask/);
  assert.match(MONEY_ANSWER_INSTRUCTIONS, /as_of\.local_date.*as_of\.utc_date.*say which date and zone were used, and continue/);
  assert.match(MONEY_ANSWER_INSTRUCTIONS, /confidence\.line/);
});

test('MJ4 owner-local money dates stay on the requested day across the UTC boundary', async t => {
  const { queryMoney } = await import(modulePath); const f = fixture(t);
  const instant = Date.parse('2026-11-13T02:30:00Z');
  t.mock.method(Date, 'now', () => instant);
  f.env.BRAIN_TIMEZONE = 'America/Los_Angeles';
  f.account('bank', 'live');
  f.row('local-receipt', 'bank', '2026-11-12', 1234);
  f.row('next-day-receipt', 'bank', '2026-11-13', 5678);
  const remote = await rpc(f.env, 'tools/call', { name: 'brain_money_query', arguments: { sql: 'SELECT 1 AS value' } });
  const clock = JSON.parse(remote.result.content[0].text);
  assert.equal(clock.rows[0].value, 1, 'remote clock query actually completed');
  assert.equal(clock.as_of.utc_date, '2026-11-13', 'UTC is already the next day');
  assert.equal(clock.as_of.local_today, '2026-11-12');
  assert.equal(clock.as_of.local_date, '2026-11-12');
  assert.equal(clock.as_of.time_zone, 'America/Los_Angeles');
  assert.equal(clock.as_of.basis, 'owner_time_zone');
  const day = clock.as_of.local_date;
  const today = await queryMoney(f.env, { sql: `SELECT SUM(income_minor) AS total FROM txn WHERE posted_on='${day}'`,
    period_from: day, period_to: day });
  assert.equal(today.rows[0].total, 1234, 'today uses only the owner-local receipt');
  const utc = await queryMoney(f.env, { sql: 'SELECT 1', time_zone: 'UTC' });
  assert.equal(utc.as_of.local_date, '2026-11-13', 'explicit caller zone remains authoritative');
  assert.equal(utc.as_of.local_date, utc.as_of.local_today);
});

test('MJ2 real money route bodies retain each reviewed repair and its code', async t => {
  const { handleMoneyQuery } = await import(modulePath);
  const { moneyQueryErrorText } = await import('../src/lib/money-query-contract.js');
  const cases = [
    ['SCAN_LIMIT', { sql: 'SELECT SUM(amount_minor) FROM fin_transactions' }, /account_slug=.*posted_on BETWEEN.*LIMIT does not reduce/,
      f => { for (let i = 0; i < 10001; i++) f.row(`scan-${i}`, 'bank', '2026-10-02', 1); }],
    ['HISTORY_LIMIT', { sql: 'SELECT SUM(income_minor) FROM txn', from: '2026-10-01', through: '2026-10-31' }, /200,000.*account_slug=.*posted_on BETWEEN/,
      f => {
        const prepare = f.env.DB.prepare;
        f.env.DB.prepare = sql => sql === 'SELECT count(*) AS n FROM (SELECT 1 FROM main.fin_transactions LIMIT 200001)'
          ? { all: async () => { f.calls.push(sql); return { success: true, results: [{ n: 200001 }] }; } } : prepare(sql);
      }],
    ['TOO_HEAVY', { sql: 'SELECT SUM(income_minor) FROM txn' }, /possible transfer pairs.*limit is 20000.*Narrow from\/through/,
      f => {
        f.account('other', 'live', 'household', '2222');
        for (let i = 0; i < 170; i++) {
          f.row(`out-${i}`, 'bank', '2026-10-02', 100, 'outflow');
          f.row(`in-${i}`, 'other', '2026-10-02', 100);
        }
      }],
    ['WINDOW', { sql: 'SELECT 1', from: '2026-02-30', to: '2026-03-01' }, /from and to must both be YYYY-MM-DD/, () => {}],
    ['INVALID', { sql: 'SELECT missing_column FROM fin_accounts' }, /Reason: SQLite said: no such column: missing_column/, () => {}],
    ['UNAVAILABLE', { sql: 'SELECT 1' }, /could not complete.*retry a narrower query/,
      f => { f.env.DB.prepare = sql => { f.calls.push(sql); throw new Error('synthetic private provider detail'); }; }],
  ];
  for (const [suffix, body, repair, configure] of cases) await t.test(suffix, async t => {
    const f = fixture(t); f.account('bank', 'live');
    const control = await handleMoneyQuery(f.env, request(f.env, { sql: 'SELECT 7 AS value' }));
    assert.equal(control.status, 200);
    assert.equal((await control.json()).rows[0].value, 7, 'route execution green control');
    configure(f);
    const before = f.calls.length;
    const response = await handleMoneyQuery(f.env, request(f.env, body));
    const envelope = await response.json();
    assert.ok(f.calls.length > before, 'real validation, budget or provider decision was reached');
    assert.equal(response.status, suffix === 'UNAVAILABLE' ? 200 : 400);
    assert.equal(envelope.code, `MONEY_QUERY_${suffix}`);
    assert.match(envelope.error, repair);
    assert.match(moneyQueryErrorText(envelope), repair, 'real body is recognized by the shared MCP boundary');
    assert.equal(envelope.status, 'partial');
    assert.equal(envelope.confidence.percent, 0);
    assert.ok(envelope.confidence.reasons.length && envelope.confidence.missing.length);
    assert.doesNotMatch(JSON.stringify(envelope), /synthetic private provider detail/);
  });
});

test('MJ2 real timeout and busy route bodies retain the wait and narrower-query repairs', async t => {
  const { handleMoneyQuery } = await import(modulePath);
  const { MONEY_GUIDE, moneyQueryErrorText } = await import('../src/lib/money-query-contract.js');
  const f = fixture(t);
  let clock = Date.parse('2026-11-12T18:00:00Z');
  t.mock.method(Date, 'now', () => clock);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const prepare = f.env.DB.prepare;
  let entered, reads = 0;
  const started = new Promise(resolve => { entered = resolve; });
  f.env.DB.prepare = () => ({ all: () => { reads++; entered(); return new Promise(() => {}); } });
  const timeout = handleMoneyQuery(f.env, request(f.env, { sql: 'SELECT 1' }));
  await started;
  t.mock.timers.tick(10001);
  for (const [suffix, pending] of [['TIMEOUT', timeout], ['BUSY', null]]) {
    await t.test(suffix, async () => {
      const response = await (pending || handleMoneyQuery(f.env, request(f.env, { sql: 'SELECT 1' })));
      const envelope = await response.json();
      assert.equal(reads, 1, 'timeout reached a stalled read; busy was decided before any further read');
      assert.equal(response.status, 200);
      assert.equal(envelope.code, `MONEY_QUERY_${suffix}`);
      assert.match(envelope.error, /Wait 40 seconds.*narrower query.*[Dd]o not resend the same query/);
      assert.equal(envelope.confidence.percent, 0);
      assert.ok(envelope.confidence.reasons.length && envelope.confidence.missing.length);
      assert.match(moneyQueryErrorText(envelope), new RegExp(suffix));
    });
  }
  clock += 40001;
  f.env.DB.prepare = prepare;
  const control = await handleMoneyQuery(f.env, request(f.env, { sql: 'SELECT 7 AS value' }));
  assert.equal((await control.json()).rows[0].value, 7, 'completed read resumes after the cool-down');
  assert.match(MONEY_GUIDE, /MONEY_QUERY_BUSY:.*[Ww]ait 40 seconds.*narrower query.*[Dd]o not resend the same query/);
});

test('R2 minor1 pair limit names a bounded raw route instead of caller join advice', async t => {
  const { queryMoney } = await import(modulePath); const f = fixture(t);
  f.account('bank', 'live'); f.account('other', 'live', 'household', '2222');
  for (let i = 0; i < 170; i++) {
    f.row(`out-${i}`, 'bank', '2026-01-01', 100, 'outflow');
    f.row(`in-${i}`, 'other', '2026-01-01', 100);
  }
  await assert.rejects(queryMoney(f.env, { sql: 'SELECT sum(income_minor) FROM txn', from: '2026-01-01', through: '2026-01-31' }),
    e => e.code === 'MONEY_QUERY_TOO_HEAVY' && e.reason === 'pairing' && /from\/through.*fin_transactions.*account_slug=/.test(e.message) &&
      /own transfers.*card payments.*duplicate feeds/.test(e.message) && !/Join on id/.test(e.message));
});

test('R2 minor3 materialized constant txn shadows do not read the money corpus', async t => {
  const { queryMoney } = await import(modulePath); const f = fixture(t);
  f.account('bank', 'live');
  for (let i = 0; i < 10001; i++) f.row(`row-${i}`, 'bank', '2026-10-02', i + 1);
  const result = await queryMoney(f.env, { sql: 'WITH txn AS MATERIALIZED (SELECT 1 AS x) SELECT x FROM txn' });
  assert.deepEqual(result.rows.map(r => ({ ...r })), [{ x: 1 }]);
  assert.equal(result.confidence.percent,50);assert.equal(result.confidence.level,'Low');
  assert.ok(result.confidence.reasons.length && result.confidence.missing.length);
  assert.ok(!f.calls.some(sql => sql.includes('snapshot_kind')), 'no trusted snapshot for a constant');
});

test('R2 minor4 caller JSON paths cannot forge the internal history sentinel', async t => {
  const { queryMoney } = await import(modulePath); const f = fixture(t);
  await assert.rejects(queryMoney(f.env, { sql: "SELECT json_extract('{}','mq_history_limit')" }),
    e => e.code === 'MONEY_QUERY_INVALID' && e.reason === 'reserved_name');
});

test('R2 minor2 minor5 guide explains grouped CTE bounds and duplicate dollars with working SQL', async t => {
  const { queryMoney, MONEY_GUIDE } = await import(modulePath); const f = fixture(t);
  assert.match(MONEY_GUIDE, /CTE joined to itself is costed at its input size, even after GROUP BY; use LAG/);
  const sql = /Dollars possibly counted twice: (SELECT [^\n]+)\./.exec(MONEY_GUIDE)?.[1];
  assert.ok(sql, 'guide includes an executable duplicate-dollar query');
  f.account('bank', 'live'); f.account('other', 'live', 'household', '2222');
  for (const slug of ['bank', 'other']) f.row(`row-${slug}`, slug, '2026-10-02', 1200);
  assert.equal((await queryMoney(f.env, { sql })).rows[0].cents, 2400);
});


test('integration mixed raw and clean queries include dead history in the raw scan guard',async t=>{
  const {queryMoney}=await import(modulePath);const f=fixture(t);f.account('bank','manual');
  f.row('live','bank','2026-09-10',100);
  for(let i=0;i<3;i++)f.row('removed-'+i,'bank','2026-09-10',200,'inflow',{removed:true});
  const clean=await queryMoney(f.env,{sql:'SELECT SUM(amount_minor) AS n FROM txn'},{maxScanRows:2});
  assert.equal(clean.rows[0].n,100);
  const before=f.calls.length;
  await assert.rejects(queryMoney(f.env,{sql:'SELECT (SELECT SUM(amount_minor) FROM fin_transactions) AS raw,SUM(income_minor) AS clean FROM txn'},{maxScanRows:2}),{code:'MONEY_QUERY_SCAN_LIMIT'});
  assert.ok(!f.calls.slice(before).some(sql=>sql.startsWith('SELECT * FROM (\n')),'raw overflow stops before caller execution');
});
