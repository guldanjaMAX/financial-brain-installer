import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { queryMoney } from '../worker/src/lib/money-query.js';
import { moneyGuideFor, MONEY_TOOLS } from '../worker/src/lib/money-query-contract.js';
import { handleMcp } from '../worker/src/lib/mcp-endpoint.js';
import { documentResponseConfidence } from '../worker/src/lib/confidence.js';
import { withFirstPartySourceProvenance } from '../worker/src/lib/provenance-receipt.js';

const period = { period_from: '2026-09-01', period_to: '2026-09-30' };
const clock = () => Date.parse('2026-10-01T12:00:00Z');
function fixture(t) {
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../migrations/d1/', import.meta.url)).filter(f => f.endsWith('.sql')).sort())
    db.exec(readFileSync(new URL('../migrations/d1/' + file, import.meta.url), 'utf8'));
  t.after(() => db.close());
  const run = (sql, ...binds) => db.prepare(sql).run(...binds);
  run("INSERT INTO install_state(id,client_slug,product_version,schema_version,gate_version,installed_at,ring) VALUES (1,'synthetic','0.0.0-test',61,0,'2026-10-01','test')");
  const statement = (sql, binds = []) => ({ bind: (...b) => statement(sql, b),
    all: async () => ({ success: true, results: db.prepare(sql).all(...binds) }), first: async () => db.prepare(sql).get(...binds) });
  const env = { BRAIN_TIMEZONE: 'America/Chicago', DB: { prepare: statement } };
  run("INSERT INTO fin_entities(entity_slug,legal_name,kind,provenance,basis_state,recorded_at) VALUES ('business','Owner business','business','owner_stated','confirmed','2026-10-01')");
  const account = (slug = 'operating', mask = '1111') => run("INSERT INTO fin_accounts(account_slug,entity_slug,label,institution,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at) VALUES (?,'business',?,'Synthetic bank','checking','asset',?,'live','owner_stated','confirmed','2026-10-01')", slug, slug, mask);
  const row = (uid, slug = 'operating', day = '2026-09-10', amount = 100000, pending = 0, description = 'client revenue') => run("INSERT INTO fin_transactions(txn_uid,account_slug,posted_on,amount_minor,direction,pending,description,provenance,basis_state,recorded_at) VALUES (?,?,?,?,'inflow',?,?,'owner_stated','confirmed','2026-10-01')", uid, slug, day, amount, pending, description);
  const coverage = (slug = 'operating', to = '2026-09-30', note = null) => run("INSERT INTO fin_account_coverage(account_slug,coverage_status,covered_from,covered_to,basis_note,provenance,basis_state,computed_at,recorded_at) VALUES (?,'complete','2026-01-01',?,?,'owner_stated','confirmed','2026-10-01','2026-10-01')", slug, to, note);
  const query = (extra = {}, sql = 'SELECT sum(income_minor) AS income_minor FROM txn') => queryMoney(env, { sql, ...period, ...extra }, { now: clock });
  return { db, run, env, account, row, coverage, query:async(...args)=>{const r=await query(...args);assert.ok(r.confidence.percent<=r.confidence.evidence_percent,'final score cannot exceed any required evidence');if(r.confidence.percent<100)assert.ok(r.confidence.reasons.length && r.confidence.missing.length);return r;} };
}

test('B2: a requested month beyond all coverage is Low 30 and names the exact missing dates', async t => {
  const f = fixture(t); f.account(); f.coverage('operating', '2026-08-31'); f.row('old', 'operating', '2026-08-31');
  const r = await f.query();
  assert.equal(r.confidence.evidence_percent, 30); assert.equal(r.confidence.band, 'Low');
  assert.match(r.confidence.reasons.join(' '), /1111.*2026-09-01 through 2026-09-30/);
  assert.equal(r.evidence.accounts[0].rows_in_period, 0); assert.equal(r.evidence.accounts[0].stated_from, null);
});
test('B2: a clean declared month is High 95; undeclared period is Medium 89', async t => {
  const f = fixture(t); f.account(); f.coverage(); f.row('income');
  assert.equal((await f.query()).confidence.evidence_percent, 95);
  const r = await f.query({ period_from: undefined, period_to: undefined });
  assert.equal(r.confidence.evidence_percent, 89); assert.match(r.confidence.reasons.join(' '), /No requested period was declared/);
});
test('M1: an interior gap has no claimed dates and lowers confidence even when another account has rows', async t => {
  const f = fixture(t); f.account(); f.account('reserve', '2222');
  f.row('june', 'operating', '2026-06-10'); f.row('early', 'reserve', '2026-01-05'); f.row('late', 'reserve', '2026-09-28');
  const r = await f.query({ period_from: '2026-06-01', period_to: '2026-06-30' });
  assert.ok(r.confidence.percent <= 60);
  const a = r.evidence.accounts.find(a => a.last4 === '2222');
  assert.equal(a.rows_in_period, 0); assert.equal(a.stated_from, null); assert.equal(a.stated_through, null);
});
test('M2: export-note coverage and impossible dates never verify coverage', async t => {
  const f = fixture(t); f.account(); f.row('income'); f.coverage('operating', '2026-09-30', 'Read from a bank export covering 2026-01-01 to 2026-09-30');
  let r = await f.query(); assert.equal(r.evidence.accounts[0].coverage_verified, false); assert.equal(r.confidence.evidence_percent, 70);
  f.run("UPDATE fin_account_coverage SET basis_note=NULL,covered_from='2026-02-30'");
  r = await f.query(); assert.equal(r.evidence.accounts[0].coverage_verified, false); assert.equal(r.confidence.evidence_percent, 70);
});
test('M3: uncertainty and pending dollars are period scoped, in dollars, and omit internal slugs', async t => {
  const f = fixture(t); f.account(); f.row('old', 'operating', '2024-01-10', 12345600, 0, 'ACH');
  f.row('current', 'operating', '2026-09-10', 50000, 0, 'ACH'); f.row('pending', 'operating', '2026-09-11', 20000, 1);
  f.row('old-pending', 'operating', '2024-01-11', 900000, 1);
  const r = await f.query(); const a = r.evidence.accounts[0];
  // As of 2026-10-01 the 09-11 hold is older than fourteen days: fix step 8
  // reports it as a stale hold with unknown status, still in dollars.
  assert.equal(a.uncertain.inflow_minor, 50000); assert.equal(a.pending.inflow_minor, 0); assert.equal(a.pending.stale.inflow_minor, 20000);
  assert.equal(a.stated_from, '2026-09-10'); assert.equal(a.stated_through, '2026-09-10');
  assert.match(r.confidence.reasons.join(' '), /\$500\.00/); assert.match(r.confidence.reasons.join(' '), /stale.*\$200\.00/);
  assert.doesNotMatch(r.confidence.reasons.join(' '), /123456|123,456|minor units|primary\/operating|9,000/);
});
for (const [reason, update] of [
  ['closed_without_date', "status='closed'"], ['before_opened', "opened_on='2026-10-01'"],
  ['after_closed', "status='closed',closed_on='2026-08-31'"], ['outside_confirmed_coverage', null],
]) test(`B3: ${reason} counted conflicts disclose exact dollars from the same snapshot`, async t => {
  const f = fixture(t); f.account('operating', '2222');
  if (update) f.run('UPDATE fin_accounts SET ' + update); else f.coverage('operating', '2026-08-31');
  for (let i = 0; i < 40; i++) f.row('excluded-' + i, 'operating', '2026-09-10', 30000);
  const r = await f.query({}, 'SELECT * FROM coverage');
  const a = r.evidence.accounts[0]; assert.equal(a.lifecycle_conflicts[0].reason, reason);
  assert.equal(a.lifecycle_conflicts[0].rows, 40); assert.equal(a.lifecycle_conflicts[0].inflow_minor, 1200000);
  assert.equal(r.rows[0].excluded_inflow_minor,0);assert.equal(r.rows[0].excluded_rows,0);assert.equal(r.rows[0].rows_outside_account_dates,40);
  const counted=await f.query();assert.equal(counted.rows[0].income_minor,1200000);assert.equal(a.excluded.length,0);
  assert.ok(r.confidence.percent <= 60); assert.match(r.confidence.reasons.join(' '), /2222.*\$12,000\.00/);
});
test('scope ignores another account pending rows; mixed raw and clean query never scores as clean', async t => {
  const f = fixture(t); f.account(); f.coverage(); f.row('income'); f.account('reserve', '2222'); f.row('pending', 'reserve', '2026-09-10', 1000, 1);
  const r = await f.query({ account_slugs: ['operating'] }); assert.equal(r.confidence.evidence_percent, 95); assert.equal(r.evidence.accounts.length, 1);
  const mixed = await f.query({}, 'SELECT (SELECT sum(amount_minor) FROM fin_transactions) AS raw, sum(income_minor) AS clean FROM txn');
  assert.ok(mixed.confidence.percent <= 55);
});
test('M7: every result carries a fresh owner-local date; period arguments are validated and advertised', async t => {
  const f = fixture(t);
  const r = await f.query({}, 'SELECT 1');
  assert.deepEqual(r.evidence.as_of, { date: '2026-10-01', time_zone: 'America/Chicago', configured: true });
  for (const extra of [{period_from:'2026-02-30'}, {period_to:'2026-08-01'}, {account_slugs: 'operating'}, {account_slugs:Array(51).fill('x')}])
    await assert.rejects(f.query(extra, 'SELECT 1'), {code:'MONEY_QUERY_INVALID'});
  for (const field of ['period_from','period_to','account_slugs']) assert.ok(MONEY_TOOLS[0].inputSchema.properties[field]);
});
test('M4 M1 M7: guide specifies first-line scope, fresh dates, evidence, and an executable per-account recipe under 60 lines', async t => {
  const f = fixture(t); f.account(); f.account('empty', '2222'); f.row('income');
  const guide = moneyGuideFor({ now: clock(), timeZone:'America/Chicago' });
  assert.ok(guide.split('\n').length < 60);
  for (const phrase of ['in the order business, personal, unassigned','evidence.as_of','last quarter','last week','past N days','coverage_verified=1','evidence.accounts','last 4 not recorded']) assert.ok(guide.includes(phrase), phrase);
  const sql = guide.match(/^By account:[^\n]*\n(SELECT [^\n]+)/m)?.[1]; assert.ok(sql);
  const r = await f.query({}, sql); assert.equal(r.rows.length, 2); assert.equal(r.rows.find(a => a.account_slug==='empty').row_count, 0);
});
test('M5: balance confidence responds to confirmed, missing, old, and proposed observations', async t => {
  const f = fixture(t); f.account();
  const sql = 'SELECT * FROM fin_balance_snapshots';
  f.run("INSERT INTO fin_balance_snapshots(account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at) VALUES ('operating','2026-10-01',100000,'owner_stated','confirmed','2026-10-01')");
  assert.equal((await f.query({}, sql)).confidence.evidence_percent,60,'an observation after the requested cutoff does not prove a prior balance');
  f.run("UPDATE fin_balance_snapshots SET as_of_date='2026-09-30'");
  assert.equal((await f.query({}, sql)).confidence.evidence_percent, 95);
  f.run("UPDATE fin_balance_snapshots SET basis_state='proposed'"); assert.equal((await f.query({}, sql)).confidence.evidence_percent, 80);
  f.run("UPDATE fin_balance_snapshots SET basis_state='confirmed',as_of_date='2026-08-20'"); assert.equal((await f.query({}, sql)).confidence.percent, 40);
  f.run("UPDATE fin_balance_snapshots SET as_of_date='2026-09-30'"); f.account('missing', '2222');
  const missing = await f.query({}, sql); assert.equal(missing.confidence.evidence_percent, 60); assert.match(missing.confidence.reasons.join(' '), /2222/);
  const metadata = await f.query({}, 'SELECT * FROM fin_obligations'); assert.equal(metadata.confidence.percent, 50); assert.match(metadata.confidence.reasons.join(' '), /complete and current was not assessed/);
});
test('M9: superseded rows do not consume clean budget; 10001 current rows do', async t => {
  const f = fixture(t); f.account();
  f.db.exec("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10001) INSERT INTO fin_transactions(txn_uid,account_slug,posted_on,amount_minor,direction,superseded_by_id,provenance,basis_state,recorded_at) SELECT 'row-'||x,'operating','2026-09-10',1,'inflow',CASE WHEN x<=9000 THEN 1 END,'owner_stated','confirmed','2026-10-01' FROM n");
  assert.equal((await f.query()).rows[0].income_minor, 1001);
  f.run('UPDATE fin_transactions SET superseded_by_id=NULL'); const expanded=await f.query();assert.equal(expanded.rows[0].income_minor,10001);assert.equal(expanded.complete,true);
  const bounded=await queryMoney(f.env,{sql:'SELECT sum(income_minor) AS income_minor FROM txn',...period},{now:clock,maxSnapshotRows:10000});assert.equal(bounded.complete,false);assert.equal(bounded.rows[0].income_minor,10000);assert.equal(bounded.confidence.percent,0);assert.equal(bounded.confidence.gaps.find(g=>g.code==='input_incomplete').missing_rows,1);
});
async function rpc(env, profile, name, args = {}, deps = {}) {
  const url = new URL('https://brain.invalid/mcp');
  const message = name === 'tools/list' ? {method:name} : {method:'tools/call',params:{name,arguments:args}};
  return (await (await handleMcp(env, new Request(url, {method:'POST',body:JSON.stringify({id:1,...message})}), url, {grant:{profile},...deps})).json()).result;
}
test('M8: technician and break-glass cannot list or directly execute money SQL; librarian retains reviewed read access', async t => {
  const f = fixture(t);
  for (const profile of ['technician','break-glass']) {
    assert.ok(!(await rpc(f.env, profile, 'tools/list')).tools.some(t=>t.name==='brain_money_query'));
    assert.equal((await rpc(f.env, profile, 'brain_money_query', {sql:'SELECT 1'})).isError, true);
    assert.equal((await rpc(f.env, profile, 'brain_money_guide')).isError, true);
  }
  assert.ok((await rpc(f.env,'librarian','tools/list')).tools.some(t=>t.name==='brain_money_query'));
  assert.equal(JSON.parse((await rpc(f.env,'librarian','brain_money_query',{sql:'SELECT 1 AS n',...period})).content[0].text).rows[0].n, 1);
  const forwarded = JSON.parse((await rpc(f.env,'structured-contributor','brain_money_query',{sql:'SELECT 1 AS n',...period})).content[0].text);
  assert.deepEqual(forwarded.evidence.period,{from:'2026-09-01',to:'2026-09-30'});
});
test('M6: healthy and unavailable document search return data-based confidence and missing evidence', async () => {
  const rows = Array.from({length:3}, (_,i)=>({source:'synthetic',source_id:String(i),title:'Owner record',ts:'2026-09-10',date_reliable:true,text_source:'native',text_reliable:true}));
  const healthy = JSON.parse((await rpc({},'librarian','search',{query:'renewal'},{search:async()=>({results:rows,gaps:[]})})).content[0].text);
  assert.ok(healthy.confidence.percent>0); assert.ok(healthy.confidence.basis.length); assert.ok(healthy.confidence.missing.length);
  const unavailable = JSON.parse((await rpc({},'librarian','search',{query:'renewal'},{search:async()=>({results:[],status:'search_unavailable',degraded:'vector',gaps:[]})})).content[0].text);
  assert.equal(unavailable.confidence.band,'Low'); assert.match(unavailable.confidence.basis.join(' '), /vector|unavailable/);
  assert.ok(unavailable.confidence.percent<healthy.confidence.percent);
});

test('M6: fetched native documents have a score, and partial pages lower it', async t => {
  const f = fixture(t);
  f.run("INSERT INTO documents(doc_uid,source,source_id,title,content_hash,ingested_at,document_date,date_reliable,text_source,text_reliable) VALUES ('synthetic:one','synthetic','one','Owner record',?,1,?,1,'native',1)",'a'.repeat(64),Date.parse('2026-09-10'));
  const proven = withFirstPartySourceProvenance({source_type:'synthetic',source_id:'one',content:'Synthetic renewal clause'},{textSource:'native',textReliable:true});
  f.run('UPDATE documents SET meta=?',JSON.stringify(proven.metadata));
  f.run("INSERT INTO chunks(chunk_uid,doc_uid,chunk_ix,text,source,title) VALUES ('synthetic:one#0','synthetic:one',0,'Synthetic renewal clause','synthetic','Owner record')");
  const fetch = async offset => JSON.parse((await rpc(f.env,'librarian','fetch',{id:'synthetic:one',offset})).content[0].text);
  const complete = await fetch(0); assert.equal(complete.confidence.percent,80); assert.ok(complete.confidence.missing.length);
  f.run('UPDATE chunks SET text=?','x'.repeat(60001));
  const partial = await fetch(0); assert.equal(partial.page.complete,false); assert.equal(partial.confidence.percent,65);
  const continuation = await fetch(partial.page.next_offset); assert.equal(continuation.page.complete,true); assert.equal(continuation.confidence.percent,65);
});

test('R4 M-1: declared period and accounts constrain txn and coverage after full-history classification', async t => {
  const f = fixture(t); f.account(); f.coverage(); f.account('reserve','2222'); f.coverage('reserve');
  f.row('august','operating','2026-08-10',100); f.row('september','operating','2026-09-10',100);
  f.row('other','reserve','2026-09-10',900);
  const one = await f.query({period_from:'2026-09-10',period_to:'2026-09-10',account_slugs:['operating']});
  assert.equal(one.rows[0].income_minor,100); assert.equal(one.confidence.evidence_percent,95);
  const c = await f.query({account_slugs:['operating']},'SELECT account_slug FROM coverage');
  assert.deepEqual(c.rows.map(r=>r.account_slug),['operating']);
  const recurring = moneyGuideFor().match(/^Recurring:[^\n]*\n(SELECT [^\n]+)/m)[1];
  const two = await f.query({period_from:'2026-08-01',account_slugs:['operating']},recurring);
  assert.equal(two.rows[0].months,2); assert.equal(two.rows[0].likely_monthly_minor,100);
  const all = await f.query({period_from:undefined,period_to:undefined});
  assert.equal(all.rows[0].income_minor,1100); assert.equal(all.confidence.evidence_percent,89);
  assert.match(moneyGuideFor(),/txn only returns rows inside period_from\/period_to and account_slugs/);
});

test('R4 M-2: every referenced table contributes its weakest confidence', async t => {
  const f = fixture(t); f.account(); f.coverage(); f.row('income');
  f.run("INSERT INTO fin_balance_snapshots(account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at) VALUES ('operating','2026-09-30',100000,'owner_stated','confirmed','2026-09-30')");
  const raw = await f.query({},'SELECT (SELECT sum(amount_minor) FROM fin_transactions) AS t,(SELECT count(*) FROM fin_balance_snapshots) AS n');
  assert.ok(raw.confidence.percent<=55);
  f.run("UPDATE fin_balance_snapshots SET as_of_date='2026-06-30'");
  const runway = await f.query({},'SELECT (SELECT sum(income_minor)-sum(expense_minor) FROM txn) AS net,(SELECT sum(current_minor) FROM fin_balance_snapshots) AS cash');
  assert.ok(runway.confidence.percent<=40); assert.match(runway.confidence.reasons.join(' '),/2026-06-30/);
  for (const table of ['fin_obligations','fin_deadlines','fin_statements']) {
    const r = await f.query({},`SELECT (SELECT sum(income_minor) FROM txn) AS income,(SELECT count(*) FROM ${table}) AS n`);
    assert.ok(r.confidence.percent<=50); assert.match(r.confidence.reasons.join(' '),new RegExp(table+'.*completeness was not assessed'));
  }
});

test('R4 M-3: historical balance confidence uses the requested cutoff', async t => {
  const f = fixture(t); f.account();
  f.run("INSERT INTO fin_balance_snapshots(account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at) VALUES ('operating','2026-11-10',100000,'owner_stated','confirmed','2026-11-10')");
  const sql = moneyGuideFor().match(/^Balances:[^\n]*\n(SELECT [^\n]+)/m)[1];
  const r = await f.query({},sql);
  assert.equal(r.rows[0].current_minor,null); assert.ok(r.confidence.percent<=60);
  assert.match(r.confidence.reasons.join(' '),/1111: no usable balance observation on or before 2026-09-30/);
});

test('R4 M-4: raw cannot outscore missing clean coverage; over-budget clean assessment stays Low 40', async t => {
  const f = fixture(t); f.account(); f.coverage('operating','2026-08-31'); f.row('old','operating','2026-08-31');
  const r = await f.query({},"SELECT sum(amount_minor) FROM fin_transactions WHERE posted_on BETWEEN '2026-09-01' AND '2026-09-30'");
  assert.equal(r.confidence.evidence_percent,30); assert.equal(r.evidence.accounts[0].last4,'1111');
  f.db.exec("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<11000) INSERT INTO fin_transactions(txn_uid,account_slug,posted_on,amount_minor,direction,provenance,basis_state,recorded_at) SELECT 'large-'||x,'operating','2026-08-10',1,'inflow','owner_stated','confirmed','2026-10-01' FROM n");
  const sql = moneyGuideFor().match(/^Large ledger:[^\n]*\n(SELECT [^\n]+)/m)[1];
  const large = await f.query({},sql); assert.equal(large.confidence.percent,40);
  assert.match(large.confidence.reasons.join(' '),/Ledger too large for the clean check; coverage, transfers and duplicates were not assessed/);
});

test('R4 M-5: coverage share prices one observed day and identifies the unverified dates', async t => {
  const f = fixture(t); f.account(); f.coverage('operating','2026-09-01'); f.row('one','operating','2026-09-01');
  const r = await f.query(); assert.equal(r.confidence.evidence_percent,60);
  assert.equal(r.evidence.accounts[0].period_days,30); assert.equal(r.evidence.accounts[0].verified_days,1);
  assert.equal(r.evidence.accounts[0].observed_through,'2026-09-01');
  assert.match(r.confidence.reasons.join(' '),/1111.*2026-09-02 through 2026-09-30.*\$0 quantified; amount unknown/);
  f.run("UPDATE fin_account_coverage SET covered_to='2026-09-20'"); assert.equal((await f.query()).confidence.evidence_percent,80);
  f.run("UPDATE fin_account_coverage SET covered_to='2026-09-30'"); assert.equal((await f.query()).confidence.evidence_percent,95);
  f.run("UPDATE fin_account_coverage SET basis_state='proposed'"); assert.equal((await f.query()).confidence.evidence_percent,70);
});

test('R4 M-6: closed and future accounts do not penalize periods outside their life', async t => {
  const f = fixture(t); f.account(); f.coverage(); f.row('income'); f.account('closed','2222'); f.account('future','3333');
  f.run("UPDATE fin_accounts SET status='closed',closed_on='2025-12-31' WHERE account_slug='closed'");
  f.run("UPDATE fin_accounts SET opened_on='2027-01-01' WHERE account_slug='future'");
  const r = await f.query(); assert.equal(r.confidence.evidence_percent,95);
  assert.equal(r.evidence.accounts.find(a=>a.last4==='2222').open_in_period,false);
  assert.equal(r.evidence.accounts.find(a=>a.last4==='2222').closed_on,'2025-12-31');
  assert.match(r.confidence.reasons.join(' '),/2222: closed December 31, 2025; \$0 expected/);
  f.run("INSERT INTO fin_balance_snapshots(account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at) VALUES ('operating','2026-09-30',100000,'owner_stated','confirmed','2026-09-30'),('closed','2025-12-31',0,'owner_stated','confirmed','2025-12-31')");
  assert.equal((await f.query({},'SELECT * FROM fin_balance_snapshots')).confidence.evidence_percent,95);
  f.run("UPDATE fin_accounts SET closed_on=NULL WHERE account_slug='closed'");
  assert.ok((await f.query()).confidence.percent<=60);
  assert.ok((await f.query({},'SELECT * FROM fin_balance_snapshots')).confidence.percent<=60);
});

test('R4 M-7: remote missing-answer evidence keeps its internal ceiling without an owner score line', async () => {
  for (const answer of [null,'The documents do not answer this question.']) {
    const thought = {answer,results:[],gaps:[],confidence:{percent:80,band:'moderate',basis:['x']}};
    const before = structuredClone(thought);
    let calls = 0;
    const r = await rpc({},'librarian','ask',{question:'When does the synthetic lease renew?'},{think:async()=>{ calls++; return thought; }});
    assert.equal(calls,1,'the remote ask reached the reading and presentation decision');
    const score = documentResponseConfidence(thought);
    assert.equal(score.band,'Low');
    assert.equal(score.percent,20,'the old refusal score cannot certify an answer');
    assert.match(score.basis.join(' '),/No record read here answers the question/);
    assert.match(score.missing.join(' '),/A record that states the answer/);
    assert.match(r.content[0].text,/I can try a more specific search/);
    assert.match(r.content[0].text,/No record read here answers the question/);
    assert.match(r.content[0].text,/Still needed: A record that states the answer/);
    assert.doesNotMatch(r.content[0].text,/Confidence:|\b(?:High|Medium|Low)\b|\d+%/);
    assert.deepEqual(thought,before,'the renderer leaves the returned internal assessment unchanged');
  }
  const thought = {answer:'The lease renews on October 1, 2027.',results:[],gaps:[],
    answer_contract:{version:1,kind:'document'},confidence:{percent:95,band:'High',basis:[],missing:[]}};
  let calls = 0;
  const control = await rpc({},'librarian','ask',{question:'When does the synthetic lease renew?'},{think:async()=>{ calls++; return thought; }});
  assert.equal(calls,1,'the populated green control reaches the same remote ask route');
  assert.match(control.content[0].text,/The lease renews on October 1, 2027/);
  assert.equal(documentResponseConfidence(thought).percent,95,'hiding owner scores cannot lower verified metadata');
  assert.doesNotMatch(control.content[0].text,/Confidence:|\b(?:High|Medium|Low)\b|\d+%/);
});

test('R4 M-8: remote routing only names tools the profile can use', async () => {
  for (const profile of ['technician','break-glass','librarian']) for (const env of [{},{ANSWER_MODEL:'claude-opus-5-5',GATE_MODEL:'claude-sonnet-5-5'}]) {
    const url = new URL('https://brain.invalid/mcp');
    const init = await (await handleMcp(env,new Request(url,{method:'POST',body:JSON.stringify({id:1,method:'initialize'})}),url,{grant:{profile}})).json();
    const description = (await rpc(env,profile,'tools/list')).tools.find(t=>t.name==='ask').description;
    for (const text of [init.result.instructions,description]) {
      if (profile==='librarian') assert.match(text,/go straight to brain_money_query/);
      else { assert.doesNotMatch(text,/go straight to brain_money_query|recompute with brain_money_query/); assert.match(text,/no money SQL tools/); }
    }
  }
});

test('R4 trivial minors: clock override, evidence, priced malformed dates, legacy balances and error confidence', async t => {
  const f = fixture(t); f.account(); f.coverage(); f.row('good');
  assert.throws(()=>f.row('wrong-format','operating','09/10/2026',500000),/CHECK constraint failed/);
  f.row('bad','operating','2026-09-31',500000);
  const r = await f.query(); assert.ok(r.confidence.percent<90);
  assert.equal(r.evidence.accounts[0].unreadable_rows,1);
  assert.match(r.confidence.reasons.join(' '),/1111.*\$5,000.00.*unreadable date/);
  const guide = moneyGuideFor(); assert.ok(guide.split('\n').length<60);
  assert.match(guide,/Result: rows,row_count,truncated,ms,confidence,evidence/);
  assert.match(guide.split('\n').at(-1),/evidence.as_of on a query result overrides this line/);
  const {MONEY_QUERY_ERROR_TEXT,unavailableMoneyQuery} = await import('../worker/src/lib/money-query-contract.js');
  assert.ok(Object.keys(MONEY_QUERY_ERROR_TEXT).length>=4,'the reviewed error-message decision set is populated');
  for (const [code,message] of Object.entries(MONEY_QUERY_ERROR_TEXT)) {
    assert.match(message,/This attempt is incomplete because the query and evidence checks did not finish/);
    assert.doesNotMatch(message,/Confidence:|\b(?:High|Medium|Low)\b|\d+%/);
    const partial = unavailableMoneyQuery(code);
    assert.equal(partial.code,code);
    assert.equal(partial.status,'partial');
    assert.equal(partial.rows,null,'unread amounts remain unknown');
    assert.equal(partial.confidence.level,'Low');
    assert.equal(partial.confidence.percent,0);
    assert.match(partial.confidence_text,/^Confidence: Low \(0%\)\nReasons: The requested money rows could not be read; their dollar impact is unknown\.\nMissing: Read the requested accounts and dates /);
    assert.ok(partial.confidence.reasons.length && partial.confidence.missing.length);
    assert.match(partial.confidence.reasons.join(' '),/money rows could not be read; their dollar impact is unknown/);
    assert.match(partial.confidence.missing.join(' '),/requested accounts and dates/);
  }
  const {ownerConfidenceLine} = await import('../worker/src/lib/confidence.js');
  assert.equal(ownerConfidenceLine({percent:20,basis:['a','b'],missing:['c']}),'Confidence: Low (20%). Why: a; b. Missing: c.');
  const slug='simplefin-'+ 'a'.repeat(32); f.account(slug,'2222');
  f.run("INSERT INTO simplefin_account_assignments(item_ref,provider_account_id,account_ref,currency,first_seen_at,last_seen_at) VALUES ('synthetic-item','synthetic-account',?,'USD','2026-09-30','2026-09-30')",'sfa_'+ 'a'.repeat(32));
  f.run("INSERT INTO fin_balance_snapshots(account_slug,as_of_date,current_minor,source_feed,provenance,basis_state,recorded_at) VALUES (?,'2026-09-30',100000,'bank-feed:synthetic-item','feed','confirmed','2026-09-30')",slug);
  const balance = await f.query({account_slugs:[slug]},'SELECT * FROM fin_balance_snapshots');
  assert.ok(balance.confidence.percent<=60); assert.match(balance.confidence.reasons.join(' '),/2222: no usable balance/);
});
