import { queryMeasureRisks, queryContextRisks, moneyRiskMateriality, questionMoneyEvidence, requestedMoneyRanking, inferredPostedMeasure } from './money-query-risk.js';
import { certifyMoneyQuery } from './money-query-certificate.js';
import { headlineCertificate, checkHeadlineSupport } from './money-headline-support.js';
import { moneyTypeCertificate } from './money-type-certificate.js';
import { PENDING_LEAD_DAYS } from './money-pending.js';
import { moneyMinorText } from './money-format.js';
import { ownerMoneyDay as ownerLedgerDay } from './money-format.js';
import { moneyBankFreshness } from './bank-feed-health.js';
import { moneyQueryQuality } from './money-query-quality.js';
import { CONTRIBUTION_FIELDS } from './clean-money-contributions.js';
import { MONEY_TABLES, MONEY_TABLE_COLUMNS, unavailableMoneyQuery, localDateFor } from './money-query-contract.js';
import { cleanMoneyCtes, CLEAN_MONEY_VIEWS, CLEAN_MONEY_SNAPSHOT_SQL, classifiedMoneyCtes, moneyMembershipDecisions, MoneySnapshotLimitError } from './clean-money.js';
export { CLEAN_MONEY_CTES, CLEAN_MONEY_VIEWS } from './clean-money.js';
import { MONEY_CONFIDENCE_SNAPSHOT_SQL, moneyConfidenceScope, confidenceAmountsSql,
  scoreMoneyConfidence, unknownMoneyConfidence, confidenceText, paymentEvidenceConfidence, limitMoneyConfidence } from './money-confidence.js';
import { moneySqlConfidence, moneySqlUsesClock } from './money-confidence.js';
import { moneyQueryConfidence, moneyQueryEvidence, readsRepaymentMeasure, repaymentUncertainty } from './money-query-confidence.js';
import { loanProceedsConfidence } from './money-loan-proceeds-confidence.js';
import { portableMoneyMedian } from './money-query-median.js';
import { transactionInput, needsTenantProof, TENANT_PROOF_SQL, pairingWorkProbe, moneyQuerySelection, moneyQueryWindow, isoDay, shiftDay, POSTING_DATE_FLOOR, POSTING_DATE_CEILING } from './money-query-budget.js';
import { loopWork, sourceAliases, callerCteNames, loopBounds, loopName, formatWorkMultiplier } from './money-query-plan.js';
import { customApiVisibilitySql, readWithCustomApiVisibility } from './custom-api-visibility.js';
import { readBalanceRecomputeSnapshot, balanceRecomputeCtes } from './money-balance-recompute.js';
import { moneyAccountsCte, readMoneyBalanceEvidence, balanceResultScope } from './money-balance-evidence.js';
export { loopWork } from './money-query-plan.js';
export { MONEY_TABLES, MONEY_GUIDE, MONEY_EXAMPLE_SQL } from './money-query-contract.js';

const allowed = new Set(MONEY_TABLES);
const virtual = new Set(CLEAN_MONEY_VIEWS);
const documentViews = new Set(['document_index','document_sources']);
const MAX_RESULT_CHARS = 1_000_000;

const functions = new Set(('concat concat_ws octet_length unhex sign soundex likely unlikely likelihood sqlite_version sqlite_source_id sqlite_compileoption_get sqlite_compileoption_used ceil ceiling floor trunc mod pow power sqrt exp ln log log10 log2 acos acosh asin asinh atan atan2 atanh cos cosh sin sinh tan tanh degrees radians pi json_error_position json_pretty jsonb jsonb_array jsonb_object jsonb_extract jsonb_insert jsonb_replace jsonb_set jsonb_remove jsonb_patch jsonb_group_array jsonb_group_object abs avg count sum total min max round coalesce ifnull nullif iif length substr substring instr lower upper trim ltrim rtrim typeof cast date time datetime julianday strftime unixepoch timediff current_date current_time current_timestamp printf format group_concat string_agg json json_array json_object json_extract json_valid json_type json_array_length json_group_array json_group_object row_number rank dense_rank lag lead first_value last_value nth_value ntile percent_rank cume_dist random hex quote unicode char').split(' '));
const internalError = Symbol('money-query-error');
const reasons = {
  not_one_statement:'Send exactly one SELECT, VALUES or nonrecursive WITH statement.',
  unbalanced_parentheses:'Balance every opening and closing parenthesis.',
  write_or_schema:'Writes and schema statements are not available.',
  virtual_table_not_allowed:'Only json_each() and json_tree() table readers are available.',
  recursive:'Recursive CTEs are not supported; use window functions.',
  reserved_name:'Names starting with mq_ are reserved, and a CTE cannot be named txn, coverage, transfer_pairs, fin_transactions, document_index or document_sources when it also reads that view.',
  window_incomplete:'Pass both from and through for a period.',
  window_date:'Use real calendar dates in YYYY-MM-DD form for from and through.',
  window_order:'from must be on or before through.',
  window_raw_mix:'For raw fin_transactions lifecycle reads, omit from/through (and to); keep period_from/period_to and explicit posted_on bounds in SQL. Do not mix raw rows with txn in that request. Until the lookup completes, the lifecycle amount is unknown, never $0 or none.',
  too_long:'SQL must be at most 20,000 characters.',
  too_many_tokens:'SQL must contain at most 4,000 tokens; split the query.',
  unsupported_character:'Bind parameters and unsupported SQL characters are not accepted; use literal values.',
  unterminated:'Close every quoted value, quoted identifier and block comment.',
  max_rows:'max_rows must be a positive integer; at most 1,000 rows are returned.',
  value_too_big:'A value in this query grew past the 2,000,000-byte database limit. Return rows instead of aggregating many rows into one cell, or select fewer columns.',
};
const error = (code = 'MONEY_QUERY_INVALID', reason = null, detail = null, limit = null) => {
  const sentence = reason === 'table_not_readable' ? `${detail??'That table'} is not readable. Readable tables and views are listed in brain_money_guide.` :
    reason === 'function_not_allowed' ? `${detail}() is not available. For a median, use window functions.` :
    reason === 'unsupported_character' && ['?',':','@','$'].includes(detail) ? `Unsupported character: ${detail}. Use literal values instead of bind parameters.` :
    reason === 'sql_error' ? detail ? `SQLite said: ${detail}.` : 'The SQL did not compile.' : reasons[reason];
  return Object.assign(new Error({
  MONEY_QUERY_WINDOW: 'from and to must both be YYYY-MM-DD dates with from on or before to.',
  MONEY_QUERY_INVALID: 'Use one read-only SELECT over the money or document-metadata tables in brain_money_guide.',
  MONEY_QUERY_TIMEOUT: 'The money query timed out and may still be finishing inside the Brain\'s database. Wait 40 seconds, then send a narrower query; do not resend the same query.',
  MONEY_QUERY_BUSY: 'A previous money query is still finishing inside the Brain\'s database. Wait 40 seconds, then send a narrower query. Do not resend the same query.',
  MONEY_QUERY_TOO_HEAVY: reason==='pairing' ? `Too many possible transfer pairs fall in this period (about ${detail} candidates; the limit is ${limit}). Narrow from/through, or read fin_transactions without them using account_slug='...' AND posted_on BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD', with removed_at IS NULL AND superseded_by_id IS NULL AND pending=0. State that own transfers, card payments and duplicate feeds have not been removed.` : `This query would compare too many rows with each other (about ${detail} row visits; the limit is ${limit}). Join on id, account_identity, or an exact amount and date; aggregate with GROUP BY; use window functions such as SUM() OVER (ORDER BY posted_on) or LAG() instead of a self-join or correlated subquery; or narrow from/through.`,
  MONEY_QUERY_SCAN_LIMIT: detail==='raw' ? "This raw transaction input exceeds the scan budget. Read fin_transactions with id BETWEEN literal bounds, or account_slug='...' AND posted_on BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD', without from/through. Keep the selected input below the budget; a returned-row LIMIT does not reduce the input." : 'This Brain has more transaction rows than one query can read at once. Pass from and through (YYYY-MM-DD) to brain_money_query to read txn, coverage and transfer_pairs for a period. Split a long period into shorter ones and add the results. A returned-row LIMIT does not reduce the input.',
  MONEY_QUERY_HISTORY_LIMIT: "This Brain's transaction history is larger than the clean views can read (more than 200,000 stored rows), so txn, coverage and transfer_pairs are not available here. Read one account at a time from fin_transactions with account_slug='...' AND posted_on BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD', keep rows where removed_at IS NULL AND superseded_by_id IS NULL AND pending=0, and state that own transfers, card payments and duplicate feeds have not been removed.",
  MONEY_QUERY_UNAVAILABLE: 'The money query could not complete. Check the guide and retry a narrower query.',
}[code] + (code === 'MONEY_QUERY_INVALID' && sentence ? ' Reason: ' + sentence : '')), { code, reason, detail, [internalError]: true });
};

function sqlError(failure) {
  const detail = /(?:no such (?:column|table|function): [\w.$]{1,64}|ambiguous column name: [\w.$]{1,64}|near "[^"\n]{0,40}": syntax error|circular reference: [\w$]{1,64})(?![\w.$])/.exec(String(failure?.message ?? ''))?.[0] ?? null;
  return error('MONEY_QUERY_INVALID','sql_error',detail);
}

export function parseMoneyWindow(body) {
  const {from = null, through = null} = body ?? {};
  if (from === null && through === null) return null;
  if (from === null || through === null) throw error('MONEY_QUERY_INVALID','window_incomplete');
  const valid = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    Number.isFinite(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().slice(0,10) === v;
  if (![from,through].every(valid)) throw error('MONEY_QUERY_INVALID','window_date');
  if (from > through) throw error('MONEY_QUERY_INVALID','window_order');
  const add = shiftDay;
  // Three days finds partners; another three finds their competing partners.
  // A three-day slice would falsely prove the Jan 30 / Feb 1 pair when a
  // competing Jan 27 receipt exists. Membership reads no other row evidence.
  return {from,through,scanFrom:add(from,-6),scanThrough:add(through,6)};
}

// Tokenization establishes statement/parenthesis boundaries and reserved names.
// SQLite resolves CTE visibility and read targets; wording is never authority.
function tokensOf(sql) {
  const tokens = []; let i = 0;
  while (i < sql.length) {
    const tail = sql.slice(i);
    let m;
    if ((m = /^\s+/.exec(tail))) { i += m[0].length; continue; }
    if (tail.startsWith('--')) { const end = tail.indexOf('\n'); i += end < 0 ? tail.length : end; continue; }
    if (tail.startsWith('/*')) { const end = tail.indexOf('*/', 2); if (end < 0) throw error('MONEY_QUERY_INVALID','unterminated'); i += end + 2; continue; }
    const tokenStart = i;
    const quote = tail[0];
    if (["'", '"', '`', '['].includes(quote)) {
      const close = quote === '[' ? ']' : quote; let value = ''; let ended = false; i++;
      while (i < sql.length) {
        if (sql[i] === close) {
          if (quote !== '[' && sql[i + 1] === close) { value += close; i += 2; continue; }
          i++; ended = true; break;
        }
        value += sql[i++];
      }
      if (!ended) throw error('MONEY_QUERY_INVALID','unterminated');
      tokens.push({ v: value.toLowerCase(), kind: quote === "'" ? 'string' : 'identifier' });
    } else if ((m = /^[a-z_-￿][a-z_0-9$-￿]*/i.exec(tail))) {
      tokens.push({ v: m[0].toLowerCase(), kind: 'word' }); i += m[0].length;
    } else if ((m = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(tail))) {
      tokens.push({ v: m[0], kind: 'number' }); i += m[0].length;
    } else {
      if (!/[(),.;*+\-/%=<>!|&~]/.test(quote)) throw error('MONEY_QUERY_INVALID','unsupported_character',quote);
      tokens.push({ v: quote, kind: 'punctuation' }); i++;
    }
    tokens.at(-1).start = tokenStart; tokens.at(-1).end = i; tokens.at(-1).raw = sql.slice(tokenStart, i);
    if (tokens.length > 4000) throw error('MONEY_QUERY_INVALID','too_many_tokens');
  }
  return tokens;
}

// EXPLAIN compiles but never runs submitted SQL. A SELECT wrapper excludes
// writes, PRAGMAs and control statements even when hidden behind WITH.
export async function validateMoneySql(sql, read) {
  if (typeof sql !== 'string' || !sql.trim()) throw error();
  if(sql.length>20000)throw error('MONEY_QUERY_INVALID','too_long');
  const tokens = tokensOf(sql);
  if (tokens.at(-1)?.v === ';' && tokens.at(-1)?.kind === 'punctuation') tokens.pop();
  if (!tokens.length || tokens.some(t => t.kind === 'punctuation' && t.v === ';')) throw error('MONEY_QUERY_INVALID','not_one_statement');
  let depth = 0;
  for (const t of tokens) {
    if (['word','identifier'].includes(t.kind) && t.v.startsWith('mq_')) throw error('MONEY_QUERY_INVALID','reserved_name');
    // The history guard uses an invalid JSON path as a private sentinel. A
    // caller literal cannot impersonate that diagnostic in the error handler.
    if (t.kind === 'string' && t.v.includes('mq_history_limit')) throw error('MONEY_QUERY_INVALID','reserved_name');
    if (t.kind !== 'punctuation') continue;
    if (t.v === '(') depth++;
    if (t.v === ')' && --depth < 0) throw error('MONEY_QUERY_INVALID','unbalanced_parentheses');
  }
  if (depth !== 0) throw error('MONEY_QUERY_INVALID','unbalanced_parentheses');
  const medianSql = portableMoneyMedian(sql, tokens);
  if (medianSql) return validateMoneySql(medianSql, read);
  if (!['select','with','values'].includes(tokens[0].v)) {
    // Compile only inside a SELECT wrapper: even an otherwise valid write
    // cannot execute here. Keep SQLite's validation boundary observable.
    try { await read('EXPLAIN SELECT * FROM (\n' + sql + '\n)'); }
    catch (failure) { if (failure?.[internalError]) throw failure; }
    throw error('MONEY_QUERY_INVALID','write_or_schema');
  }
  const query = sql.slice(tokens[0].start, tokens.at(-1).end);
  const prefixEnd = tokens[0].v === 'with' ? (tokens[1]?.kind === 'word' && tokens[1]?.v === 'recursive' ? tokens[1].end : tokens[0].end) - tokens[0].start : null;
  const catalogue = await read("SELECT name,type,tbl_name,rootpage FROM sqlite_schema WHERE type IN ('table','view','index') LIMIT 4097");
  if (catalogue.length > 4096 || catalogue.some(r => typeof r.name !== 'string' || !Number.isSafeInteger(r.rootpage))) throw error('MONEY_QUERY_UNAVAILABLE');
  const roots = new Map(catalogue.filter(r => r.rootpage > 0).map(r => [r.rootpage, r.tbl_name.toLowerCase()]));
  let plan, expanded = query, usedShapes = false;
  // Both JSON module identities come from the same compiled VM as the
  // submitted query. Pointer text is request-local, never cached across D1 calls.
  let marker = 'mq_json_probe';
  while (sql.includes(marker)) marker += '_';
  const probes = ['json_each', 'json_tree'].map((name, i) => ({name, value: JSON.stringify([marker + i])}));
  const wrap = q => 'SELECT *, ' + probes.map(p => '(SELECT count(*) FROM ' + p.name + "('" + p.value + "'))").join(',') + ' FROM (\n' + q + '\n)';
  const explain = q => read('EXPLAIN ' + wrap(q));
  try { plan = await explain(query); }
  catch (e) {
    if (e?.[internalError]) throw e;
    // Clean views are request-local definitions. Try them only after SQLite
    // cannot resolve the plain statement, so harmless CTE shadows still work.
    // Empty public shapes isolate caller access from the trusted classifier's
    // private review evidence. They are compilation inputs, never answer data.
    const shapes = [...virtual,...documentViews];
    // A constant-row shape makes SQLite choose full scans for every join, even
    // when the real frozen view supports an automatic id index. An empty JSON
    // reader preserves that planning choice without adding data or authority.
    const ctes = shapes.map(name => name + ' AS MATERIALIZED (SELECT ' + MONEY_TABLE_COLUMNS[name].map(f => 'NULL AS ' + f).join(',') + " FROM json_each('[]') AS mq_shape WHERE 0)").join(',');
    expanded = 'WITH ' + ctes + ' SELECT * FROM (\n' + query + '\n)';
    usedShapes = true;
    try { plan = await explain(expanded); }
    catch (failure) { if (failure?.[internalError]) throw failure; throw sqlError(failure); }
  }
  if (!plan.length || plan.some(r => typeof r.opcode !== 'string')) throw error('MONEY_QUERY_UNAVAILABLE');
  const references = new Set();
  for (const row of plan) {
    if (row.opcode === 'OpenRead' || row.opcode === 'ReopenIdx') {
      const table = roots.get(row.p2);
      if (row.p3 !== 0 || !allowed.has(table)) throw error('MONEY_QUERY_INVALID','table_not_readable',table ?? null);
      references.add(table);
    }
    if (['OpenWrite','CreateBtree','Destroy','Clear','ParseSchema','SetCookie','VUpdate','Vacuum','JournalMode','Checkpoint'].includes(row.opcode)) throw error('MONEY_QUERY_INVALID','write_or_schema');
    if (row.opcode === 'Transaction' && row.p2 !== 0) throw error('MONEY_QUERY_INVALID','write_or_schema');
    if (['Function','PureFunc','AggStep','AggStep1','AggValue','AggFinal'].includes(row.opcode)) {
      const name = String(row.p4).split('(')[0].toLowerCase();
      if (!functions.has(name) && !['like','glob','replace','json_quote','json_patch','json_remove','json_set','json_insert','json_replace','->','->>'].includes(name)) throw error('MONEY_QUERY_INVALID','function_not_allowed',name);
    }
  }
  const qp = await read('EXPLAIN QUERY PLAN ' + expanded);
  if (!qp.length || qp.some(r => !Number.isSafeInteger(r.id) || !Number.isSafeInteger(r.parent) || typeof r.detail !== 'string')) throw error('MONEY_QUERY_UNAVAILABLE');
  if (qp.some(r => /^RECURSIVE STEP(?:$| )/i.test(r.detail))) throw error('MONEY_QUERY_INVALID','recursive');
  const jsonModules = new Set();
  for (const probe of probes) {
    const argument = plan.findIndex(r => r.opcode === 'String8' && r.p4 === probe.value);
    const open = plan.slice(0, argument).findLast(r => r.opcode === 'VOpen');
    if (argument < 0 || !open || typeof open.p4 !== 'string') throw error('MONEY_QUERY_UNAVAILABLE');
    jsonModules.add(open.p4);
  }
  if (plan.some(r => r.opcode === 'VOpen' && !jsonModules.has(r.p4))) throw error('MONEY_QUERY_INVALID','virtual_table_not_allowed');
  for (const row of usedShapes ? qp : []) {
    const name = /^MATERIALIZE (\S+)$/.exec(row.detail)?.[1]?.toLowerCase();
    if (virtual.has(name) || documentViews.has(name)) references.add(name);
  }
  const callerCtes = callerCteNames(tokens);
  return { sql: query, references, prefixEnd, tokens, loopPlan:qp, aliases:sourceAliases(tokens,callerCtes), callerCtes };
}

const busyDatabases = new WeakMap();
function databaseCooldown(env) {
  const db = env.DB ?? env;
  return {
    async get() {
      let until = busyDatabases.get(db) ?? 0;
      try { if(globalThis.caches) until=Math.max(until,Number(await (await caches.default.match('https://money-query-cooldown.invalid/brain'))?.text())||0); } catch { /* In-isolate protection remains available. */ }
      return until;
    },
    async set(until) {
      busyDatabases.set(db,until);
      try { if(globalThis.caches) await caches.default.put('https://money-query-cooldown.invalid/brain',new Response(String(until),{headers:{'Cache-Control':'max-age=40'}})); } catch { /* Cache availability cannot erase the local cool-down. */ }
    },
  };
}

function snapshotOf(rows) {
  const snapshot = { rows: [], accounts: [], entities: [], pairs: [], coverage: [], counts: [], pending: [], missing: [], excluded: [], quality: [], conflicts: [], confidence_accounts: [], confidence_pending: [], confidence_unassigned: [], unreadable: [], settled: [] };
  for (const row of rows) snapshot[row.snapshot_kind].push({...JSON.parse(row.value),...(row.value2?JSON.parse(row.value2):{})});
  return snapshot;
}

function sameFinancialSnapshot(left, right) {
  // Compare complete records, order independently, never log or persist them.
  // A second read may certify old amounts only when all their evidence agrees.
  const canonical = rows => JSON.stringify(rows.map(row => JSON.stringify(row)).sort());
  return ['rows', 'accounts', 'entities', 'pairs', 'coverage', 'pending', 'quality', 'excluded', 'conflicts', 'unreadable', 'settled'].every(kind => canonical(left[kind] ?? []) === canonical(right[kind] ?? []));
}

export async function queryMoney(env, body, { timeoutMs = 10000, supportTimeoutMs = 2000, maxScanRows = 10000, maxLoopWork = 20_000_000, now = Date.now, execute, confidenceScope, maxSnapshotRows = 100000, maxBinds = 90, cooldown = databaseCooldown(env), pendingQuestion, onHeadlineProof } = {}) {

  const started = now();
  const as_of = { utc_date: new Date(started).toISOString().slice(0,10) };
  if (started < await cooldown.get()) throw error('MONEY_QUERY_BUSY');
  const usesTo = Object.hasOwn(body || {},'to');
  let window=null, incompleteLegacyWindow=null;
  if(!usesTo) {
    try {window=parseMoneyWindow(body);}
    catch(e) {
      // A lone from may be repaired by an independently closed SQL period.
      // Keep the legacy typed refusal when that proof is unavailable.
      if(e.reason!=='window_incomplete' || body?.from===undefined)throw e;
      incompleteLegacyWindow=e;
    }
  }
  let windowAdjustments=[];
  let inferredWindow=null, requestedWindow=null, selection=null, scored=null, partial=false;
  let limit=maxScanRows, input;
  if(!Number.isSafeInteger(maxSnapshotRows)||maxSnapshotRows<1||maxSnapshotRows>100000||!Number.isSafeInteger(maxBinds)||maxBinds<1||maxBinds>95)throw error();
  const n = body?.max_rows ?? 200;
  if (!Number.isSafeInteger(n) || n < 1) throw error('MONEY_QUERY_INVALID','max_rows');
  if (!Number.isSafeInteger(maxScanRows) || maxScanRows < 1 || maxScanRows > 100000 || !Number.isSafeInteger(maxLoopWork) || maxLoopWork < 1 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw error();
  const cap = Math.min(1000, n);
  let period=null, readPeriod=null, sqlPeriod=null;
  if(body?.period_from!==undefined || body?.period_to!==undefined) {
    if(!isoDay(body.period_from)||!isoDay(body.period_to)||body.period_from>body.period_to)throw error();
    period={from:body.period_from,to:body.period_to};
  }
  const accountSlugs=body?.account_slugs;
  if(accountSlugs!==undefined && (!Array.isArray(accountSlugs)||!accountSlugs.length||accountSlugs.length>50||accountSlugs.some(s=>typeof s!=='string'||!s.trim()||s.length>200)))throw error();
  const asOf=localDateFor({timeZone:body?.time_zone || env.BRAIN_TIMEZONE,now:started});
  Object.assign(as_of,{time_zone:asOf.time_zone,local_date:asOf.date,local_today:asOf.date,basis:asOf.configured?'owner_time_zone':'server_utc'});
  const controller = new AbortController();
  let timer, rejectDeadline;
  const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
  timer = setTimeout(() => {
    void Promise.resolve(cooldown.set(now()+40000)).catch(()=>{});
    const reason = error('MONEY_QUERY_TIMEOUT'); controller.abort(reason); rejectDeadline(reason);
  }, timeoutMs);
  const read = async (sql, binds = []) => {
    controller.signal.throwIfAborted();
    // Native D1 all() has no AbortSignal parameter. An injected transport can
    // cancel in flight; the native path can only prevent subsequent reads.

    const result = await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        if (execute) return execute(sql, { signal: controller.signal, binds });
        const statement = env.DB.prepare(sql);
        return (binds.length ? statement.bind(...binds) : statement).all();
      }), deadline,
    ]);
    controller.signal.throwIfAborted();
    if (result?.success === false || !Array.isArray(result?.results)) throw error('MONEY_QUERY_UNAVAILABLE');
    return result.results;
  };
  const readCount = async sql => {
    const rows = await read(sql);
    if (rows.length !== 1 || !Number.isSafeInteger(rows[0]?.n) || rows[0].n < 0) throw error('MONEY_QUERY_UNAVAILABLE');
    return rows[0].n;
  };
  try {
    const checked = await validateMoneySql(body?.sql, read);
    // Only a caller's pending question earns the pending-collection ceiling;
    // a fixed status read (the overview) passes pendingQuestion:false.
    const pendingRequested = pendingQuestion ?? checked.tokens.some(t=>/^pending_/.test(t.v));
    const usesClean = [...checked.references].some(name => virtual.has(name));
    const readsRaw=checked.references.has('fin_transactions');
    const sqlScope=moneyConfidenceScope(checked);
    // Sentinels describe lifecycle bounds, never an owner's posting period.
    const sqlDates=checked.tokens.filter(t=>t.kind==='string' && isoDay(t.v) && t.v>=POSTING_DATE_FLOOR && t.v<=POSTING_DATE_CEILING).map(t=>t.v).sort();
    sqlPeriod=sqlScope ? {from:sqlScope.from,to:sqlScope.to} : sqlDates.length ? {from:sqlDates[0],to:sqlDates.at(-1)} : null;
    // A declared period supplies a default, never permission to erase SQL's
    // comparison months. Keep the owner's declaration separate from the read.
    readPeriod=period && {from:[period.from,...sqlDates].sort()[0],to:[period.to,...sqlDates].sort().at(-1)};
    if(window && checked.references.has('fin_transactions')) throw error('MONEY_QUERY_INVALID','window_raw_mix');
    if(!usesClean) window = null;
    const calendar={timeZone:asOf.time_zone};
    selection=moneyQuerySelection(checked,calendar);
    // The closed SQL selection (with corrected calendar bounds) is SQL's own period too.
    if(readPeriod && selection?.from)readPeriod={from:[readPeriod.from,selection.from].sort()[0],to:[readPeriod.to,selection.to].sort().at(-1)};
    // A corrected SQL period (reversed or past-month-end bounds) is the period
    // the rewritten SQL reads, so the scored scope uses the same bounds.
    if(sqlScope && selection?.rewrites && selection.from){sqlScope.from=selection.from;sqlScope.to=selection.to;sqlPeriod={from:selection.from,to:selection.to};}
    for(const rewrite of [...(selection?.rewrites||[])].sort((a,b)=>b.start-a.start)) {
      const offset=checked.tokens[0].start;
      checked.sql=checked.sql.slice(0,rewrite.start-offset)+rewrite.text+checked.sql.slice(rewrite.end-offset);
    }
    // SQL supplies recoverable closed bounds only after its ordinary read guards.
    if(incompleteLegacyWindow) {
      if(!usesClean || !selection?.from)throw incompleteLegacyWindow;
      const recovered=moneyQueryWindow(body,selection,calendar);
      window=parseMoneyWindow({from:recovered.from,through:recovered.to});
      windowAdjustments=recovered.adjustments || [];
    }
    if(usesTo) {
      try {
        const w=moneyQueryWindow(body,usesClean?selection:null,calendar);
        windowAdjustments=w?.adjustments || [];
        if(readsRaw)throw error('MONEY_QUERY_INVALID','window_raw_mix');
        if(usesClean)window=parseMoneyWindow({from:w.from,through:w.to});
      } catch(e) { if(e?.[internalError])throw e; throw error('MONEY_QUERY_WINDOW'); }
    }
    if(usesClean) {
      inferredWindow=moneyQueryWindow({},selection,calendar);
      requestedWindow=window && {from:window.from,to:window.through};
      if(window) {
        const dates=[...sqlDates,...(readPeriod?[readPeriod.from,readPeriod.to]:[])];
        if(selection?.from)dates.push(selection.from,selection.to);
        window=parseMoneyWindow({from:[window.from,...dates].sort()[0],through:[window.through,...dates].sort().at(-1)});
      }
    }
    scored=sqlScope ? {table:'txn',from:sqlScope.from,to:sqlScope.to,...sqlScope.filters} :
      selection?.from ? selection : window ? {...(selection||{table:'txn'}),from:window.from,to:window.through,source:'request_window'} : selection;
    const documentCtes = present => [...checked.references].filter(name=>documentViews.has(name)).map(name=>name==='document_index' ?
      `document_index AS MATERIALIZED (SELECT d.doc_uid,d.source,d.title,d.uri,d.document_date,d.date_source,d.date_reliable,d.client,d.category,d.ingested_at FROM main.documents d WHERE d.deleted_at IS NULL${customApiVisibilitySql('d',present)})` :
      'document_sources AS MATERIALIZED (SELECT name,kind,status,created_at,last_ingest_at,document_count,last_complete_sweep_at,stale_reason FROM main.sources)').join(',');
    let ctes = '';
    let snapshot, decisions, baseSnapshotSql;
    const binds = [];
    let budgetGuard = '';
    const knownCounts = {};
    const workGuards = [];
    if (usesClean || checked.references.has('fin_transactions')) {
      let tenantProof = false;
      if(!usesClean && needsTenantProof(checked)) tenantProof=(await read(TENANT_PROOF_SQL))[0]?.ok===1;
      const historyProbe = 'SELECT count(*) AS n FROM (SELECT 1 FROM main.fin_transactions LIMIT 200001)';
      if(window && await readCount(historyProbe)>200000) throw error('MONEY_QUERY_HISTORY_LIMIT');
      limit=usesClean?Math.min(maxScanRows,maxSnapshotRows):maxScanRows;
      input=transactionInput(checked,limit,window,tenantProof,{clean:usesClean && !readsRaw});
      let count=await readCount(input.probe);
      if(count>limit && usesClean && !readsRaw && !window && inferredWindow) {
        window=parseMoneyWindow({from:inferredWindow.from,through:inferredWindow.to});
        input=transactionInput(checked,limit,window,tenantProof,{clean:true}); count=await readCount(input.probe);
      }
      if(count>limit && usesClean && !readsRaw && limit<maxSnapshotRows) {
        limit=maxSnapshotRows;input=transactionInput(checked,limit,window,tenantProof,{clean:true});count=await readCount(input.probe);
      }
      if(count>limit) {
        if(readsRaw || !usesClean)throw error('MONEY_QUERY_SCAN_LIMIT',null,'raw');
        partial=true;input=transactionInput(checked,limit,window,tenantProof,{clean:true,partial:true});
      }
      knownCounts.fin_transactions=Math.min(count,limit);
      if(readsRaw)workGuards.push(`SELECT CASE WHEN n>${count} THEN json_extract('!', '$') ELSE 1 END AS ok FROM (${input.probe})`);
      ctes=usesClean?input.ctes:'';
      budgetGuard=partial?'SELECT 1 AS ok':`SELECT CASE WHEN n>${limit} THEN json_extract('!', '$') ELSE 1 END AS ok FROM (${input.probe})`;
      if(tenantProof)budgetGuard=`SELECT CASE WHEN (${TENANT_PROOF_SQL}) AND ok THEN 1 ELSE json_extract('!', '$') END AS ok FROM (${budgetGuard})`;
      if(window)budgetGuard=`SELECT CASE WHEN n>200000 THEN json_extract('{}', 'mq_history_limit') ELSE ok END AS ok FROM (${historyProbe}) CROSS JOIN (${budgetGuard})`;
    }
    if (usesClean) {
      for(;;) {
        const pairProbe=pairingWorkProbe(input.ctes),pairCount=await readCount(pairProbe);
        const pairLimit=Math.min(maxLoopWork,20000);
        if(pairCount>pairLimit)throw error('MONEY_QUERY_TOO_HEAVY','pairing',pairCount,pairLimit);
        const pairGuard=`SELECT CASE WHEN n>${pairLimit} THEN json_extract('!', '$') ELSE 1 END AS ok FROM (${pairProbe})`;
        const membershipFields=['id','classification','money_kind','estimated','estimate_reason','uncertain_kind','processor_name',...CONTRIBUTION_FIELDS];
        const omitted=partial?` UNION ALL SELECT 'missing',json_object('currency',currency,'direction',direction,'n',count(*),'minor',SUM(amount_minor),'first',MIN(posted_on),'last',MAX(posted_on)),NULL
          FROM (${input.base}) WHERE pending=0 ${window?`AND posted_on BETWEEN '${(readPeriod||scored||{from:window.from}).from}' AND '${(readPeriod||scored||{to:window.through}).to}'`:''} AND id NOT IN (SELECT id FROM (${input.base} ORDER BY id LIMIT ${limit})) GROUP BY currency,direction`:'';
        baseSnapshotSql=`WITH ${input.ctes},mq_membership(${membershipFields.join(',')}) AS (SELECT ${membershipFields.map(()=>'NULL').join(',')} WHERE 0),${cleanMoneyCtes(window)},mq_read_guard AS MATERIALIZED (${budgetGuard}),mq_pair_guard AS MATERIALIZED (${pairGuard})
SELECT mq_snapshot.* FROM mq_read_guard CROSS JOIN mq_pair_guard CROSS JOIN (${CLEAN_MONEY_SNAPSHOT_SQL}${omitted}) AS mq_snapshot WHERE mq_read_guard.ok AND mq_pair_guard.ok`;
        snapshot=snapshotOf(await read(baseSnapshotSql));snapshot.partial=partial;snapshot.readFrom=window?.scanFrom ?? null;
        decisions=moneyMembershipDecisions(snapshot);
        binds.length=0;
        try { ctes=classifiedMoneyCtes(snapshot,binds,window,decisions,{maxBinds,period:readPeriod,accountSlugs,coveragePeriod:scored?.from?scored:null,asOf:asOf.date}); }
        catch(e) {
          if(!e.snapshotTooLarge)throw e;
          if(!window && inferredWindow)window=parseMoneyWindow({from:inferredWindow.from,through:inferredWindow.to});
          else {if(limit===1)throw e;partial=true;limit=Math.max(1,Math.min(limit-1,Math.floor(limit*maxBinds/e.snapshotTooLarge*0.8)));}
          input=transactionInput(checked,limit,window,false,{clean:true,partial});
          const historyProbe='SELECT count(*) AS n FROM (SELECT 1 FROM main.fin_transactions LIMIT 200001)';
          budgetGuard=partial?'SELECT 1 AS ok':`SELECT CASE WHEN n>${limit} THEN json_extract('!', '$') ELSE 1 END AS ok FROM (${input.probe})`;
          if(window)budgetGuard=`SELECT CASE WHEN n>200000 THEN json_extract('{}', 'mq_history_limit') ELSE ok END AS ok FROM (${historyProbe}) CROSS JOIN (${budgetGuard})`;
          continue;
        }
        knownCounts.txn=snapshot.rows.length;knownCounts.coverage=snapshot.coverage.length;knownCounts.transfer_pairs=snapshot.pairs.length;
        break;
      }
    }
    const boundOf = await loopBounds(checked,knownCounts,async name => {
      const probeSql = present => `SELECT count(*) AS n FROM (SELECT 1 FROM ${name==='document_index' ?
        `main.documents d WHERE d.deleted_at IS NULL${customApiVisibilitySql('d',present)}` : name==='document_sources' ? 'main.sources' : `main."${name}"`} LIMIT 100001)`;
      const probe = async present => read(probeSql(present));
      const rows=checked.references.has('document_index')?await readWithCustomApiVisibility(env,probe,{probe:false}):await probe(false);
      if(rows.length!==1||!Number.isSafeInteger(rows[0]?.n))throw error('MONEY_QUERY_UNAVAILABLE');
      workGuards.push(present => `SELECT CASE WHEN n>${rows[0].n} THEN json_extract('!', '$') ELSE 1 END AS ok FROM (${probeSql(present)})`);
      return rows[0].n>=100001?Number.MAX_SAFE_INTEGER:rows[0].n;
    });
    let work=loopWork(checked.loopPlan,boundOf);
    // EXCLUDE is also a valid result alias. Only a frame clause ending in
    // PRECEDING, FOLLOWING or CURRENT ROW adds the frame-rescan cost.
    if(checked.tokens.some((t,i)=>t.kind==='word'&&t.v==='exclude'&&
      ['preceding','following','row'].includes(checked.tokens[i-1]?.v)))
      work*=Math.max(1,...checked.loopPlan.map(r=>/^(SCAN|SEARCH) /.test(r.detail)?boundOf(loopName(r.detail)):1));
    work*=formatWorkMultiplier(checked.tokens);
    if(work>maxLoopWork)throw error('MONEY_QUERY_TOO_HEAVY',null,Math.round(work),maxLoopWork);
    let accountReviewsUnavailable=false,balanceRecomputeUnavailable=false,balanceRead;
    let balanceReadCtes='';
    const balanceBaseBinds=binds.length;
    if(checked.references.has('fin_balance_snapshots') || checked.references.has('fin_statements')) {
      const beforeBinds=binds.length;
      try {
        balanceRead=await readBalanceRecomputeSnapshot(read);
        balanceReadCtes=balanceRecomputeCtes(balanceRead,binds);
        if(binds.length>maxBinds)throw Error('Balance snapshot bind bound exceeded');
      } catch {
        binds.length=beforeBinds;balanceRead=undefined;balanceReadCtes='';balanceRecomputeUnavailable=true;
      }
    }
    const run = async (present, accountFilter = '', currency = null) => {
    let executionGuard=budgetGuard;
    if(workGuards.length) {
      const guards=[budgetGuard,...workGuards.map(g=>typeof g==='function'?g(present):g)].filter(Boolean);
      executionGuard=`SELECT ${guards.map((_,i)=>`g${i}.ok`).join(' AND ')} AS ok FROM ${guards.map((s,i)=>`(${s}) AS g${i}`).join(' CROSS JOIN ')}`;
    }
    const balanceCurrencyCte = balanceRead || currency ? `fin_balance_snapshots AS MATERIALIZED (SELECT * FROM ${balanceRead?'mq_balance_observations':'main.fin_balance_snapshots'}${currency?` WHERE currency='${currency}'`:''})` : '';
    const accountsCte = checked.references.has('fin_accounts') && !accountReviewsUnavailable ? (balanceRead?
      `fin_accounts AS MATERIALIZED (SELECT a.* FROM mq_balance_accounts a ${accountFilter})`:moneyAccountsCte(accountFilter)) : '';
    const allCtes = [ctes,documentCtes(present),balanceReadCtes,accountsCte,balanceCurrencyCte, balanceRead && checked.references.has('fin_statements')?'fin_statements AS MATERIALIZED (SELECT * FROM mq_balance_statements)':''].filter(Boolean).join(',');
    const sql = !allCtes ? checked.sql : `WITH ${allCtes} SELECT * FROM (\n${checked.sql}\n)`;
    // CROSS JOIN fixes the guard before the caller input. An outer WHERE alone
    // can evaluate only after SQLite has already aggregated an oversized input.
    // LIMIT -1 is an optimizer fence: the guard join must preserve caller ORDER BY.
    const guarded = !executionGuard ? sql : `WITH mq_budget AS MATERIALIZED (${executionGuard})
SELECT mq_result.* FROM mq_budget CROSS JOIN (SELECT * FROM (\n${sql}\n) LIMIT -1) AS mq_result WHERE mq_budget.ok`;
    try { return await read(`SELECT * FROM (\n${guarded}\n) LIMIT ${cap + 1}`, binds); }
    catch (failure) {
      // Request-local projection limits must not turn a readable stored amount
      // into an error. Retry once without that projection and lower confidence.
      if(balanceRead) {
        balanceRead=undefined;balanceReadCtes='';binds.length=balanceBaseBinds;balanceRecomputeUnavailable=true;
        return run(present,accountFilter,currency);
      }
      // Older or incomplete storage must still supply its readable source
      // figures. Missing review evidence can lower confidence, never erase them.
      if (!accountReviewsUnavailable && checked.references.has('fin_accounts') &&
          /no such table: (?:main\.)?fin_account_kind_reviews\b/i.test(String(failure?.message))) {
        accountReviewsUnavailable=true;
        return run(present,accountFilter,currency);
      }
      throw failure;
    }
    };
    const rows = checked.references.has('document_index') ? await readWithCustomApiVisibility(env,run,{probe:false}) : await run(false);
    const kept=[];let chars=0;
    for(const row of rows.slice(0,cap)) {
      const size=JSON.stringify(row).length;
      if(chars+size>MAX_RESULT_CHARS)break;
      kept.push(row);chars+=size;
    }
    const sizeLimited=kept.length<Math.min(rows.length,cap);
    const truncated_reason=sizeLimited?'size':rows.length>cap?'rows':null;
    const note=sizeLimited?(kept.length===0?'One row is larger than the 1,000,000-character result limit. Select fewer columns, or return rows instead of aggregating many rows into one cell; page with ORDER BY and max_rows.':'The result reached the 1,000,000-character limit. Select fewer columns or page with ORDER BY and max_rows.'):null;
    const truncated=truncated_reason!==null;
    const assessmentPeriod=readPeriod || (window?{from:window.from,to:window.through}:sqlPeriod);
    const assessedScope=confidenceScope || sqlScope;
    // The pairing read has a wider margin than the asked posting period.
    // Keep those source rows for matching, without charging an earlier hold
    // against this question's coverage or pending-dollar confidence.
    const periodEvidenceSnapshot=snapshot && usesClean && assessmentPeriod ? {...snapshot,
      pending:(snapshot.pending||[]).filter(r=>!isoDay(r.posted_on) || r.posted_on>=assessmentPeriod.from && r.posted_on<=assessmentPeriod.to)}:snapshot;
    const measure=inferredPostedMeasure(checked.tokens,assessedScope,body.measure);
    const questionEvidence=questionMoneyEvidence(periodEvidenceSnapshot,decisions,assessedScope,measure,checked.tokens);
    let assessmentSnapshot=questionEvidence.snapshot;
    let assessmentDecisions=questionEvidence.decisions;
    const explicitPosted=assessmentSnapshot!==periodEvidenceSnapshot;
    const completeRanking=explicitPosted && requestedMoneyRanking(checked.tokens,measure,body.rank_limit);
    const questionMeasure=explicitPosted || !['net_receipts','posted_spending'].includes(measure)?measure:null;
    const assessedRows=(assessmentSnapshot?.rows || []).filter(r=>
      (!assessmentPeriod || r.posted_on>=assessmentPeriod.from && r.posted_on<=assessmentPeriod.to) &&
      (!accountSlugs || accountSlugs.includes(r.account_slug)) &&
      ['account_slug','account_identity','account','tenant_id','side','currency','entity'].every(k=>!assessedScope?.filters?.[k] || r[k]===assessedScope.filters[k]));
    const evidenceSlugs=assessedScope && snapshot ? snapshot.coverage.filter(c=>
      (!accountSlugs || accountSlugs.includes(c.account_slug)) &&
      ['account_slug','account_identity','account','tenant_id','side','currency','entity'].every(k=>!assessedScope.filters?.[k] || c[k]===assessedScope.filters[k])).map(c=>c.account_slug) : accountSlugs;
    const immaterialRisk=moneyRiskMateriality({tokens:checked.tokens,result:rows,rows:assessedRows,decisions:assessmentDecisions,contextRows:snapshot?.rows});
    let cleanCheckTooLarge=false,balances,evidence;
    let guideAssessment;
    try {
      // Optional assessment follows a successful amount read. Missing global
      // identity/coverage evidence cannot erase an otherwise readable raw slice.
      if(!snapshot && checked.references.has('fin_transactions')) {
        const assessmentInput=transactionInput({references:new Set(['txn']),tokens:[]},maxScanRows,null,false,{clean:true});
        cleanCheckTooLarge=await readCount(assessmentInput.probe)>maxScanRows;
        if(!cleanCheckTooLarge) {
          const pairs=await readCount(pairingWorkProbe(assessmentInput.ctes));
          if(pairs>Math.min(maxLoopWork,20000))cleanCheckTooLarge=true;
          else {
            const fields=['id','classification','money_kind','estimated','estimate_reason','uncertain_kind','processor_name',...CONTRIBUTION_FIELDS];
            snapshot=snapshotOf(await read(`WITH ${assessmentInput.ctes},mq_membership(${fields.join(',')}) AS (SELECT ${fields.map(()=>'NULL').join(',')} WHERE 0),${cleanMoneyCtes()} ${CLEAN_MONEY_SNAPSHOT_SQL}`));
            decisions=moneyMembershipDecisions(snapshot);
          }
        }
      }
      assessmentSnapshot ||= snapshot;
      if(!usesClean)assessmentDecisions=decisions;
      const balanceAsOf=period && period.to<asOf.date?period.to:asOf.date;
      let balanceScope;
      if(checked.references.has('fin_balance_snapshots') || checked.references.has('fin_statements')) {
        balances=await readMoneyBalanceEvidence(read,balanceAsOf,balanceRead);
        if(balanceRecomputeUnavailable) balances=balances.map(a=>({...a,balance_recompute_unavailable:true}));
        balanceScope=await balanceResultScope({balances,asOf:balanceAsOf,rows,tokens:checked.tokens,accountsRead:checked.references.has('fin_accounts'),
          run:(filter,currency)=>run(false,filter,currency)});
      }
      evidence=moneyQueryEvidence({snapshot:assessmentSnapshot,decisions:assessmentDecisions,period:assessmentPeriod,accountSlugs:evidenceSlugs,asOf});
      guideAssessment=moneyQueryConfidence({ pendingRequested:pendingRequested,snapshot:assessmentSnapshot,decisions:assessmentDecisions,period:assessmentPeriod,accountSlugs:evidenceSlugs,immaterialRisk,evidence,balances,balanceScope,asOf,balanceAsOf,cleanCheckTooLarge,references:[...checked.references],raw:checked.references.has('fin_transactions'),truncated});
    } catch {
      evidence=moneyQueryEvidence({asOf,period:assessmentPeriod});
      guideAssessment=unknownMoneyConfidence('The amount was read, but its period/account evidence assessment could not be completed.','Complete bounded account, date, balance and classification evidence.');
    }
    let confidence, paymentsChecked = false, qualityAccounts = [];
    try {
      // The override is a trusted internal overview window, never a tool-body
      // option. Unsupported caller SQL still returns its result with low scope
      // confidence. Evidence failure after a successful query cannot erase it.
      const scope = confidenceScope || sqlScope;
      const staticEvidence = !confidenceScope && body.payment_evidence === undefined &&
        (!snapshot || snapshot.accounts.every(a => a.feed_mode === 'manual'));
      const assessStatic = () => {
        if(balances)return {...guideAssessment,level:guideAssessment.band};
        const assessed = moneyQueryConfidence({ pendingRequested:pendingRequested, snapshot:assessmentSnapshot, decisions:assessmentDecisions, period:assessmentPeriod, accountSlugs:evidenceSlugs, immaterialRisk, evidence, raw: checked.references.has('fin_transactions'), truncated });
        return { ...assessed, level: assessed.band };
      };
      if (snapshot && scope) {
        if (!confidenceScope && scope.currenciesSeparated && !rows.every(row => typeof row.currency === 'string' && /^[A-Z]{3}$/.test(row.currency))) scope.currenciesSeparated = false;
        const evidence = snapshotOf(await read(`${baseSnapshotSql} UNION ALL ${MONEY_CONFIDENCE_SNAPSHOT_SQL}`));
        evidence.partial=partial;evidence.readFrom=window?.scanFrom ?? null;moneyMembershipDecisions(evidence);
        if (!sameFinancialSnapshot(snapshot, evidence)) confidence = unknownMoneyConfidence(
          'The financial snapshot changed between the amount and confidence reads; the original coherent amount is retained.',
          'Repeat one complete bounded read of the requested accounts and dates to obtain matching financial and confidence evidence; changed dollar impact is unknown.');
        else {
          // Match inventory filters to the very same frozen public identities.
          // Private connection facts keep their fixed, credential-free shape.
          qualityAccounts = evidence.confidence_accounts.map(a=>({...a,...Object.fromEntries(
            ['account','account_identity','entity','side'].map(k=>[k,evidence.coverage.find(c=>c.tenant_id===a.tenant_id && c.account_slug===a.account_slug)?.[k]]))}));
          const evidenceBinds = [...binds];
          const amountSql=confidenceAmountsSql(ctes, scope, evidenceBinds);
          if(evidenceBinds.length>maxBinds)throw new Error('confidence parameter budget');
          let amounts = await read(amountSql, evidenceBinds);
          if(explicitPosted) {
            const byId=new Map(assessmentDecisions.map(d=>[d.id,d]));
            amounts=assessedRows.map(r=>({...r,kind:byId.get(r.id)?.estimated || byId.get(r.id)?.kind_unproved?'unproved membership':'proved',from_date:r.posted_on,to_date:r.posted_on}));
          }
          confidence = scoreMoneyConfidence({ accounts: qualityAccounts.filter(a=>!accountSlugs || accountSlugs.includes(a.account_slug)), coverage: evidence.coverage.filter(a=>!accountSlugs || accountSlugs.includes(a.account_slug)),
            pending: (explicitPosted?[]:evidence.confidence_pending).filter(a=>(!accountSlugs || accountSlugs.includes(a.account_slug)) &&
              (!assessmentPeriod || !isoDay(a.posted_on) || a.posted_on>=assessmentPeriod.from && a.posted_on<=assessmentPeriod.to)), unassigned: evidence.confidence_unassigned,
            amounts, scope:completeRanking?{...scope,bounded:false}:scope, historyRows:snapshot.rows, immaterialRisk, pendingRequested:pendingRequested, instant: started, timeZone: env.BRAIN_TIMEZONE, truncated });
          if (staticEvidence) confidence = assessStatic();
          for (const amount of amounts.filter(a=>a.kind==='unproved processor attribution')) {
            const account=qualityAccounts.find(a=>a.tenant_id===amount.tenant_id && a.account_slug===amount.account_slug);
            confidence=limitMoneyConfidence(confidence,
              `Account ending ${account?.last4 || '(unknown)'}: ${amount.currency} ${moneyMinorText(amount.amount_minor, amount.currency, { grouped: false })} ${amount.direction} from ${amount.from_date} through ${amount.to_date} names the requested processor but has unproved processor attribution and may be omitted by that filter.`,
              'Reconcile the named processor payout report, bank description and refund/transfer membership before certifying this processor total.',89);
          }
          if (staticEvidence && !scope.filters?.account_slug) for (const a of evidence.confidence_unassigned) {
            if (scope.filters?.tenant_id && scope.filters.tenant_id!==a.tenant_id) continue;
            confidence=limitMoneyConfidence(confidence,
              `${a.account_count} discovered feed accounts have no current ledger account; their coverage and dollar impact are unknown.`,
              'Record the discovered accounts and connect complete history for the requested dates.',69);
          }
          confidence = paymentEvidenceConfidence(confidence, body.payment_evidence, evidence.confidence_accounts, snapshot.rows);
          paymentsChecked = true;
        }
      } else {
        confidence = staticEvidence ? assessStatic() : scoreMoneyConfidence({ scope: null, truncated });
        if (snapshot && !staticEvidence) {
          // An unproved SQL scope cannot gain confidence, but its frozen
          // account and uncertain-dollar facts still explain what is missing.
          const observed = moneyQueryConfidence({ pendingRequested:pendingRequested, snapshot:assessmentSnapshot, decisions:assessmentDecisions, period:assessmentPeriod, accountSlugs, evidence, truncated });
          const percent = Math.min(confidence.percent, observed.percent);
          confidence = { level: percent >= 90 ? 'High' : percent >= 70 ? 'Medium' : 'Low', percent,
            reasons: [...confidence.reasons, ...observed.reasons], missing: [...confidence.missing, ...observed.missing] };
        }
      }
    } catch { confidence = unknownMoneyConfidence('The amount was read, but its confidence evidence could not be completed.',
      'Read account connections, confirmed date coverage, successful sync timestamps and all supporting amounts. Keep the returned amount scoped to the rows actually read.'); }
    if (body.payment_evidence !== undefined && !paymentsChecked) confidence = limitMoneyConfidence(confidence,
      'The document payment could not be compared with a complete connected-account transaction snapshot.',
      'Keep the cited document amount separate and repeat a literal-date-bounded txn query with payment_evidence to identify the paying account or card.', 0);
    if (!confidenceScope && usesClean) confidence=moneySqlConfidence(confidence,
      {checked,scope:sqlScope,snapshot:assessmentSnapshot,decisions:assessmentDecisions,period:assessmentPeriod,accountSlugs,immaterialRisk});
    if (!confidenceScope && moneySqlUsesClock(checked)) confidence=limitMoneyConfidence(confidence,
      `The SQL reads the database clock, which does not prove the owner's date ${asOf.date} (${asOf.time_zone}). The returned figure follows that SQL clock.`,
      `Use literal dates from the owner's calendar (${asOf.date}, ${asOf.time_zone}) and repeat the query.`,40);
    if (accountReviewsUnavailable) confidence=limitMoneyConfidence(confidence,
      'The owner account-kind review store was unavailable; the figure uses the readable source account kinds.',
      'Restore the owner review store and repeat the Balances or Accounts recipe to apply the confirmed account kinds.',0);
    if (period && sqlPeriod && (period.from!==sqlPeriod.from || period.to!==sqlPeriod.to)) confidence=limitMoneyConfidence(confidence,
      `The declared period ${period.from} through ${period.to} differs from SQL dates ${sqlPeriod.from} through ${sqlPeriod.to}; the figure follows SQL and the read covers ${readPeriod.from} through ${readPeriod.to}.`,
      'Match the declared period with all SQL dates, including comparison periods, and verify coverage for those dates.',89);
    if (requestedWindow && (requestedWindow.from!==window.from || requestedWindow.to!==window.through)) confidence=limitMoneyConfidence(confidence,
      `The requested window ${requestedWindow.from} through ${requestedWindow.to} differs from the SQL read ${window.from} through ${window.through}; the figure follows SQL.`,
      'Match the requested window with every SQL comparison period and verify the complete read range.',89);
    if (!confidenceScope && !completeRanking && checked.tokens.some(token => token.kind === 'word' && token.v === 'limit')) {
      confidence = limitMoneyConfidence(confidence,
        'The SQL contains a bounded row selection; a complete answer scope has not been proved.',
        'Use a complete aggregate or all ordered pages for the requested accounts and dates.', 69);
    }
    if(!confidenceScope && (period || accountSlugs || checked.references.has('fin_balance_snapshots') || checked.references.has('fin_transactions'))) {
      const percent=Math.min(confidence.percent,guideAssessment.percent);
      confidence={...confidence,percent,level:percent>=90?'High':percent>=70?'Medium':'Low',
        reasons:[...new Set([...confidence.reasons,...guideAssessment.reasons])],missing:[...new Set([...confidence.missing,...guideAssessment.missing])]};
    }
    if(partial)confidence=unknownMoneyConfidence('The returned figure uses a bounded partial snapshot; some current source rows were omitted.','Read the omitted accounts, dates and directional amounts shown in the input_incomplete gap.');
    const repaymentGaps=!confidenceScope && snapshot && decisions && readsRepaymentMeasure(checked.tokens)
      ? repaymentUncertainty({snapshot,decisions,period:assessmentPeriod,accountSlugs,selection,
        readsPaid:checked.tokens.some(t=>t.v==='paid_minor' || t.v==='*')}) : [];
    for(const gap of repaymentGaps)confidence=limitMoneyConfidence(confidence,gap.why,gap.missing,89);
    // Apply to every measure and internal overview scope, independently of the
    // SQL projection. Retain the successful figure and frozen row membership.
    const loanDisclosures=usesClean?loanProceedsConfidence({snapshot:explicitPosted && assessedScope?.rowFilters?.category ? assessmentSnapshot:snapshot,decisions,period:assessmentPeriod,accountSlugs:evidenceSlugs,selection:assessedScope?.filters}):[];
    const loanGaps=loanDisclosures.filter(g=>!g.proved);
    for(const gap of loanGaps)confidence=limitMoneyConfidence(confidence,gap.why,gap.missing,89);
    confidence.reasons.push(...loanDisclosures.filter(g=>g.proved).map(g=>g.why));
    if(usesClean && snapshot && assessedRows.length) {
      try {
        const covered=snapshot.coverage.filter(c=>!evidenceSlugs || evidenceSlugs.includes(c.account_slug));
        for(const gap of await queryContextRisks({read:(sql,values=[])=>{
          if(values.length>maxBinds)throw new Error('Context parameter budget');
          return read(sql,values);
        },rows:assessedRows,coverage:covered,period:assessmentPeriod,tokens:checked.tokens}))
          confidence=limitMoneyConfidence(confidence,gap.why,gap.missing,89);
      } catch {
        confidence=limitMoneyConfidence(confidence,'The amount was read, but recorded reconciliation, processor financing and fiscal-period checks could not be completed.',
          'Read the selected account reconciliation records, recorded processor obligations and owner fiscal-period preference.',89);
      }
    }
    for(const gap of queryMeasureRisks({tokens:checked.tokens,rows:assessedRows,decisions:assessmentDecisions,scope:assessedScope,measure:questionMeasure,accounts:snapshot?.accounts,readFrom:snapshot?.readFrom,contextRows:(snapshot?.rows||[]).filter(r=>(!assessmentPeriod || r.posted_on>=assessmentPeriod.from && r.posted_on<=assessmentPeriod.to) &&
      (!(accountSlugs || ['account_slug','account_identity','account'].some(k=>assessedScope?.filters?.[k])) || evidenceSlugs?.includes(r.account_slug)))}))
      confidence=limitMoneyConfidence(confidence,gap.why,gap.missing,89);
    const queryCertificate=certifyMoneyQuery(checked);
    const shapeGaps=queryCertificate.certified?[]:[queryCertificate];
    for(const gap of shapeGaps)confidence=limitMoneyConfidence(confidence,gap.why,gap.missing,89);
    if(usesClean)try {
      for(const gap of moneyTypeCertificate({tokens:checked.tokens,rows:assessedRows,
        decisions:assessmentDecisions,snapshot:assessmentSnapshot,scope:assessedScope,period:assessmentPeriod,certificate:queryCertificate}))
        confidence=limitMoneyConfidence(confidence,gap.why,gap.missing,89);
    } catch {
      confidence=limitMoneyConfidence(confidence,'The figure was read, but every contributing party type certificate could not be completed; the unchecked dollar impact is unknown.',
        'Resolve each contributing party, verify its SQL grouping, and read and reconcile its complete history before using High confidence.',89);
    }
    if(usesClean && !asOf.configured && assessmentPeriod &&
      Date.parse(asOf.date)-Date.parse(assessmentPeriod.to)>=0 && Date.parse(asOf.date)-Date.parse(assessmentPeriod.to)<=86400000)
      confidence=limitMoneyConfidence(confidence,'The owner time zone is unconfigured at this recent period boundary; the UTC calendar may select a different relative period or hide the remaining part of the owner day.',
        'The owner IANA time zone and confirmation of the asked dates and completed observation through the end of that owner day.',89);
    const freshnessScope = confidenceScope || (period && usesClean ? {from:period.from,to:period.to,filters:accountSlugs?.length===1?{account_slug:accountSlugs[0]}:{}} : moneyConfidenceScope(checked));
    const periodEnd = [period?.to,window?.through,freshnessScope?.to].filter(isoDay).sort().at(-1) ||
      (isoDay(body?.period_end)?body.period_end:null) || ownerLedgerDay(started,env.BRAIN_TIMEZONE)?.day || null;
    let freshnessGaps, freshnessFailed = false;
    try { freshnessGaps = await moneyBankFreshness(env, { read, periodEnd, now:started, scope:{...freshnessScope,accountSlugs:evidenceSlugs}, ownerDay:value=>ownerLedgerDay(value,env.BRAIN_TIMEZONE)?.day }); }
    catch {
      freshnessFailed = true;
      freshnessGaps = [{reason:'Bank connection freshness could not be verified.',missing:'A successful connection health read and bank activity through the asked period.'}];
    }
    for (const gap of freshnessGaps) confidence = limitMoneyConfidence(confidence, gap.reason, gap.missing, freshnessFailed ? 0 : 69);
    if (!confidenceScope) confidence = { ...confidence, period_end:periodEnd, may_only_lower:true,
      line:confidenceText(confidence).split('\n')[0] };
    if (!confidenceScope || snapshot && decisions) {
      // Overview and direct queries disclose the same private type evidence.
      const qualitySelection=confidenceScope ? {...(confidenceScope.filters||{}),from:confidenceScope.from,to:confidenceScope.to}
        : period?{...(scored||{}),from:period.from,to:period.to,...(accountSlugs?.length===1?{account_slug:accountSlugs[0]}:{})}:scored;
      const quality = balances ? {score:guideAssessment.percent,basis:'dated_balance_observations',caveats:[],gaps:guideAssessment.reasons.map((why,i)=>({code:'balance_evidence',why,missing:guideAssessment.missing[i] || guideAssessment.missing.join(' ')}))} : moneyQueryQuality(assessmentSnapshot, assessmentDecisions, { truncated, selection:qualitySelection, readsRawTransactions:checked.references.has('fin_transactions') && !usesClean, accountEvidence:qualityAccounts, measure:questionMeasure,asOf:asOf.date,pendingRequested:pendingRequested,immaterialRisk });
      // Selection quality is another ceiling, never permission to raise the
      // connection, freshness or optional-evidence assessment.
      const percent = Math.min(confidence.percent, quality.score);
      const level = percent >= 90 ? 'High' : percent >= 70 ? 'Medium' : 'Low';
      confidence = { ...confidence, percent, level, band:level, score:percent, label:level,
        evidence_percent:guideAssessment.percent, display:`Confidence: ${level} (${percent}%)`, line:`Confidence: ${level} (${percent}%)`, basis:quality.basis, selection_score:quality.score, caveats:quality.caveats,
        selection_gaps:[...quality.gaps,...shapeGaps],
        reasons:percent===100?[]:[...new Set([...confidence.reasons,...quality.gaps.map(g=>g.why)])],
        missing:percent===100?[]:[...new Set([...confidence.missing,...quality.gaps.map(g=>g.missing)])],
        gaps:percent === 100 ? [] : [...quality.gaps,...shapeGaps,...repaymentGaps,...loanGaps,...(confidence.reasons.length ? [{code:'evidence_score',why:confidence.reasons.join(' '),missing:confidence.missing.join(' ')}] : [])] };
    }
    if(explicitPosted) {
      confidence.caveats ||= [];
      if(completeRanking)confidence.caveats.push({code:'requested_top_groups',why:`This is the requested top ${body.rank_limit??Number(checked.tokens.at(-1).v)} groups by posted spending, not the sum of all groups.`});
      confidence.caveats.push({code:'posted_measure',why:measure==='net_receipts'
        ? 'This is posted net cash received, before purchase refunds, with processor payouts at their bank settlement amount; it is not gross sales or individual customer sales.'
        : 'This is separately posted spending before refunds, excluding transfers and repayments; processor withholding and unseparated repayment interest are not included.'});
      const holds=(snapshot.pending||[]).filter(r=>(!assessmentPeriod || !r.posted_on || r.posted_on>=assessmentPeriod.from && r.posted_on<=assessmentPeriod.to) && (!evidenceSlugs || evidenceSlugs.includes(r.account_slug)));
      if(holds.length)confidence.caveats.push({code:'pending_excluded_posted_measure',why:'Pending holds are not posted cash received or spent. They remain excluded from this explicitly posted measure.',rows:holds});
    }
    if(usesClean && snapshot && assessmentPeriod) {
      const outsideAccounts=new Map(snapshot.coverage.filter(c=>(!evidenceSlugs || evidenceSlugs.includes(c.account_slug)) &&
        ['account_slug','account_identity','account','tenant_id','side','currency','entity'].every(k=>!assessedScope?.filters?.[k] || c[k]===assessedScope.filters[k]))
        .map(c=>[JSON.stringify([c.tenant_id,c.account_slug]),c]));
      const outside=(snapshot.pending||[]).filter(r=>outsideAccounts.has(JSON.stringify([r.tenant_id,r.account_slug])) && isoDay(r.posted_on) &&
        r.posted_on<assessmentPeriod.from && r.posted_on>=shiftDay(assessmentPeriod.from,-PENDING_LEAD_DAYS));
      if(outside.length) {
        const amounts=[...new Set(outside.map(r=>r.currency))].map(currency=>{
          const sum=direction=>{const n=outside.filter(r=>r.currency===currency && r.direction===direction && Number.isSafeInteger(r.amount_minor) && r.amount_minor>=0).reduce((n,r)=>n+BigInt(r.amount_minor),0n);return Number.isSafeInteger(Number(n))?Number(n):n.toString();};
          return {currency,inflow_minor:sum('inflow'),outflow_minor:sum('outflow'),unknown_amount_rows:outside.filter(r=>r.currency===currency && (!Number.isSafeInteger(r.amount_minor) || r.amount_minor<0)).length};
        });
        confidence.caveats ||= [];
        confidence.caveats.push({code:'pending_outside_period',affects_confidence:false,
          why:'Earlier pending holds in the matching margin are outside the asked posting period. Their separate dollars are disclosed without lowering this answer.',amounts,
          rows:outside.map(r=>({account:outsideAccounts.get(JSON.stringify([r.tenant_id,r.account_slug]))?.account,
            posted_on:r.posted_on,currency:r.currency,direction:r.direction,amount_minor:r.amount_minor}))});
      }
    }
    if(requestedWindow && (requestedWindow.from!==window.from || requestedWindow.to!==window.through)) {
      confidence.caveats ||= [];
      confidence.caveats.push({code:'request_window_differs',why:`The SQL contains dates outside the requested window; the figure follows SQL and the read covers ${window.from} through ${window.through}.`});
    }
    const adjustments=[...(selection?.adjustments||[]),...windowAdjustments];
    confidence.caveats ||= [];
    if(adjustments.length)confidence.caveats.push({code:'period_adjusted',why:'The closed SQL period supplied corrected calendar bounds.',adjustments});
    if(!asOf.configured)confidence.caveats.push({code:'local_date_basis',why:'The owner time zone was absent or invalid; local_today uses UTC. Supply an IANA time zone before interpreting relative periods.'});
    if(period && sqlPeriod && (period.from!==sqlPeriod.from || period.to!==sqlPeriod.to)) {
      confidence.caveats ||= [];
      confidence.caveats.push({code:'declared_period_differs',why:`Declared ${period.from} through ${period.to}; SQL ${sqlPeriod.from} through ${sqlPeriod.to}. The figure follows SQL; read ${readPeriod.from} through ${readPeriod.to}.`});
    }
    const result = { complete:!partial, evidence, rows: kept, row_count: kept.length, truncated, truncated_reason, note, as_of, ms: now() - started,
      confidence: confidenceScope ? confidence : { ...confidence, band: confidence.level }, confidence_text: confidenceText(confidence), window:window?(usesTo || !requestedWindow ? {from:window.from,to:window.through,margin_days:6} : {from:window.from,through:window.through}):null };
    if(!confidenceScope && usesClean && queryCertificate.certified && !partial && !truncated && sqlScope) {
      try {
        result.certificate=await headlineCertificate(body,result,snapshot,decisions);
        onHeadlineProof?.({scope:sqlScope,grammar:queryCertificate,
          readRows:async ids=>{
            if(!ids.length)return {rows:[],selected:[]};
            const predicate=`id IN (${ids.join(',')})`;
            const rows=await read(`WITH ${ctes} SELECT * FROM txn WHERE ${predicate} LIMIT 1001`,binds);
            const selected=await read(`WITH ${ctes} SELECT id FROM (${queryCertificate.populationSql}) WHERE ${predicate} LIMIT 1001`,binds);
            return {rows,selected:selected.map(r=>r.id)};
          },
          countRows:async()=>Number((await read(`WITH ${ctes} SELECT COUNT(*) AS n FROM (${queryCertificate.populationSql})`,binds))[0].n)});
      } catch { /* A certificate failure cannot erase a successfully read amount. */ }
    }
    if(body.supports!==undefined && !confidenceScope) {
      // The amount read is finished. Optional proof gets one separate bounded
      // budget, including post-replay membership reads, and no cooldown writes.
      // A slow proof must retain these rows and leave the next query available.
      clearTimeout(timer);
      const proofTimeout=Number.isFinite(supportTimeoutMs) && supportTimeoutMs>0?Math.min(supportTimeoutMs,2000):2000;
      Object.assign(result,await checkHeadlineSupport({body,result,checked,snapshot,timeoutMs:proofTimeout,
        replay:(query,onHeadlineProof,signal)=>queryMoney(env,query,{now,maxScanRows,maxSnapshotRows,maxBinds,
          maxLoopWork:Math.min(maxLoopWork,2_000_000),timeoutMs:proofTimeout,
          cooldown:{get:async()=>0,set:async()=>{}},
          execute:async(sql,{binds})=>{
            signal.throwIfAborted();
            const response=await (execute?execute(sql,{binds,signal}):(()=>{
              const statement=env.DB.prepare(sql);return (binds.length?statement.bind(...binds):statement).all();
            })());
            signal.throwIfAborted();return response;
          },onHeadlineProof})}));
    }
    result.ms=now()-started;
    return result;
  } catch (e) {
    if (e?.[internalError] && (e.reason === 'function_not_allowed' && e.detail === 'median' ||
      e.reason === 'sql_error' && e.detail === 'no such function: median')) {
      const result = unavailableMoneyQuery('MONEY_QUERY_UNAVAILABLE');
      result.confidence = unknownMoneyConfidence(
        'This median shape was not computed; the portable scalar reader supports one numeric money column from txn or fin_transactions, with an optional WHERE filter. Its dollar impact is unknown.',
        'Use SELECT median(amount_minor) AS median_minor FROM txn WHERE currency=\'USD\', adding the requested account and dates, or rank each group with ROW_NUMBER() and COUNT() and average its middle one or two values.');
      return { ...result, confidence_text: confidenceText(result.confidence), as_of };
    }
    if(e instanceof MoneySnapshotLimitError)throw error('MONEY_QUERY_SCAN_LIMIT');
    if (e?.[internalError]) throw e;
    if(/(?:bad JSON path:|JSON path error near) 'mq_history_limit'/.test(String(e?.message??'')))throw error('MONEY_QUERY_HISTORY_LIMIT');
    if(/string or blob too big|SQLITE_TOOBIG/i.test(String(e?.message??'')))throw error('MONEY_QUERY_INVALID','value_too_big');
    throw error('MONEY_QUERY_UNAVAILABLE');
  } finally { clearTimeout(timer); }
}

export async function handleMoneyQuery(env, request) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' };
  if (request.method !== 'POST') return new Response(JSON.stringify({ ...unavailableMoneyQuery('MONEY_QUERY_INVALID'), error: 'Use a private JSON POST body.' }), { status: 405, headers });
  let body;
  try { body = await request.json(); } catch { return new Response(JSON.stringify({ ...unavailableMoneyQuery('MONEY_QUERY_INVALID'), error: 'A JSON body is required.' }), { status: 400, headers }); }
  try { return new Response(JSON.stringify(await queryMoney(env, body)), { headers }); }
  catch (e) {
    const partial = unavailableMoneyQuery(e.code);
    return new Response(JSON.stringify({ ...partial, error:e.message, reason:e.reason }),
      { status: ['MONEY_QUERY_INVALID','MONEY_QUERY_WINDOW','MONEY_QUERY_TOO_HEAVY','MONEY_QUERY_SCAN_LIMIT','MONEY_QUERY_HISTORY_LIMIT'].includes(e.code) ? 400 : 200, headers });
  }
}
