import { moneyMinorText } from './money-format.js';
import { MONEY_TABLE_COLUMNS } from './money-query-columns.js';
import { applyAccountKindReview, accountKindReviewSql } from './fin-account-kinds.js';

const CSV = new Set(['csv_paired_debit_and_credit_columns','csv_signed_amount_with_type_column',
  'csv_signed_amount_verified_against_running_balance']);
const HOLDER = new Set([...CSV,'ofx_trnamt_negative_is_outflow']);
const liability = a => ['card','loan','line_of_credit'].includes(a.account_kind) && a.balance_role==='liability';
const exact = Number.isSafeInteger;
const day = d => typeof d==='string' && /^\d{4}-\d{2}-\d{2}$/.test(d) &&
  Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0,10)===d;
const key = a => JSON.stringify([a.tenant_id,a.account_slug]);

// This function consumes recorded evidence only. In particular, never invent an
// opening balance by subtracting a row from the suspect closing: that makes the
// proposed newest-first proof a tautology. The old file writer lost openings.
export function recomputeImportedBalance(account, observation, statements, transactions, coverage = []) {
  if (observation.balance_recompute) return observation;
  if (observation.provenance!=='extracted' || observation.provider_position_minor!=null ||
      !exact(observation.current_minor)) return observation;
  const proof={status:'unproved',corrected:false,sign_proved:false,notes:[],gaps:[],
    stored_current_minor:observation.current_minor,statement_closing_minor:null};
  const finish=() => ({...observation,balance_recompute:proof});
  const gap=text => {proof.status='unproved';proof.corrected=false;proof.statement_closing_minor=null;proof.notes=[];proof.gaps.push(text);return finish();};
  if(!observation.source_doc_uid) return gap('The exact imported statement document identity is missing.');
  const matches=statements.filter(s=>s.tenant_id===observation.tenant_id && s.account_slug===observation.account_slug &&
    s.source_doc_uid===observation.source_doc_uid && s.currency===observation.currency &&
    s.period_end===observation.as_of_date && s.provenance==='extracted' && s.superseded_by_id==null);
  if(matches.length!==1) return gap('One exact imported statement with the same account, document, currency and closing date is missing or ambiguous.');
  const s=matches[0];proof.statement_uid=s.statement_uid;
  if(s.basis_state!=='confirmed' || s.parse_state!=='parsed' || !day(s.period_start) || !day(s.period_end) ||
      s.period_start>s.period_end || s.closing_balance_minor!==observation.current_minor)
    return gap('The imported statement and stored balance observation do not agree on a confirmed closing figure and period.');
  // A reviewed exact source cell proves a deposit observation independently
  // of activity. A balance-only account in a multi-account OFX stays usable.
  const isLiability=liability(account);
  const exactClosingCell=/#balance\/(?:csv\/row-[1-9]\d*\/column-[1-9]\d*|LEDGERBAL\/BALAMT)$/.test(observation.source_locator || '');
  if(!isLiability && !exact(s.opening_balance_minor) && exactClosingCell) {
    proof.status='source_cell';return finish();
  }
  const rows=transactions.filter(t=>t.tenant_id===s.tenant_id && t.account_slug===s.account_slug &&
    t.statement_uid===s.statement_uid && t.removed_at==null && t.superseded_by_id==null && t.pending===0);
  proof.row_count=rows.length;
  if(!rows.length || !exact(s.line_count_stated) || rows.length!==s.line_count_stated || rows.some(t=>
    t.provenance!=='extracted' || t.source_doc_uid!==s.source_doc_uid || t.currency!==s.currency ||
    t.basis_state!=='confirmed' || !day(t.posted_on) || t.posted_on<s.period_start || t.posted_on>s.period_end ||
    !exact(t.amount_minor) || t.amount_minor<0 || !['inflow','outflow'].includes(t.direction)))
    return gap('Complete confirmed posted statement rows are missing, unreadable, outside the period or inconsistent with the stated row count.');
  const signed=t=>t.direction==='inflow'?t.amount_minor:-t.amount_minor;
  const net=rows.reduce((n,t)=>n+BigInt(signed(t)),0n);
  if(net>BigInt(Number.MAX_SAFE_INTEGER) || net<BigInt(Number.MIN_SAFE_INTEGER))
    return gap('Statement arithmetic exceeds exact minor-unit bounds.');
  const holderRows=rows.every(t=>HOLDER.has(t.raw_sign_convention) && t.raw_amount_minor===signed(t)) &&
    rows.some(t=>t.direction==='outflow' && t.amount_minor>0);
  proof.net_minor=Number(net);
  if(!exact(s.opening_balance_minor)) {
    return gap(`The opening balance is missing; neither the closing identity nor the newest-first identity can be proved${isLiability?'; the liability balance sign is also unproved':''}.`);
  }
  // line_count_stated is the parser's count, not a bank-stated period total.
  // Only an independent owner confirmation of complete ledger activity can
  // justify replacing a legacy endpoint. Import-derived coverage cannot.
  proof.complete_period_proved=coverage.some(c=>c.tenant_id===s.tenant_id && c.account_slug===s.account_slug &&
    c.source_doc_uid===s.source_doc_uid && c.covered_via_account_slug==null &&
    c.superseded_by_id==null && c.provenance==='owner_stated' && c.coverage_status==='complete' &&
    c.basis_state==='confirmed' && !/^Read from a bank export covering /i.test(c.basis_note || '') &&
    day(c.covered_from) && day(c.covered_to) && c.covered_from<=s.period_start && c.covered_to>=s.period_end);
  const opening=BigInt(s.opening_balance_minor),closing=BigInt(s.closing_balance_minor);
  const position=opening+net===closing;
  const owed=isLiability && holderRows && opening-net===closing;
  let effective=closing,sign=position?'position':owed?'owed_positive':null;
  if(!position && !owed) {
    // A latest source-cell closing is independent evidence. A partial export
    // can coincidentally satisfy the earliest-row identity while omitting an
    // intervening movement, so arithmetic must never overwrite that cell.
    if(exactClosingCell || !proof.complete_period_proved)
      return gap(`Statement balance mismatch: opening plus recorded signed rows equals ${observation.currency} ${moneyMinorText(opening+net,observation.currency)}, but the stored closing is ${s.closing_balance_minor} minor units. ${exactClosingCell?'The exact closing source cell is retained; conflicting activity does not prove a mistaken endpoint. ':''}Independent complete-period statement activity is missing or conflicts with the closing; the parsed row count alone cannot prove completeness.`);
    const earliest=rows.map(t=>t.posted_on).sort()[0];
    const first=rows.filter(t=>t.posted_on===earliest);
    const csvRows=rows.every(t=>CSV.has(t.raw_sign_convention));
    const firstNet=first.length===1?BigInt(signed(first[0])):null;
    const patterns=firstNet===null || !csvRows ? [] : [
      ...(opening+firstNet===closing?[{sign:'position',value:closing+net-firstNet}]:[]),
      ...(isLiability && holderRows && opening-firstNet===closing?[{sign:'owed_positive',value:closing-net+firstNet}]:[]),
    ];
    if(patterns.length!==1) return gap(`Statement balance mismatch: opening ${s.opening_balance_minor} minor units plus signed posted rows ${Number(net)} minor units equals ${observation.currency} ${moneyMinorText(opening+net,observation.currency)} (${opening+net} minor units), but the stored closing is ${s.closing_balance_minor} minor units; the newest-first identity is not uniquely proved.`);
    effective=patterns[0].value;sign=patterns[0].sign;
    proof.corrected=true;proof.status='newest_first';
    proof.notes.push("corrected from the imported statement's rows: the stored closing equals the balance after the unique earliest-dated row; later posted rows complete the period.");
  } else proof.status='reconciled';
  if(effective>BigInt(Number.MAX_SAFE_INTEGER) || effective<BigInt(Number.MIN_SAFE_INTEGER))
    return gap('Corrected balance exceeds exact minor-unit bounds.');
  proof.statement_closing_minor=Number(effective);
  let current=Number(effective);
  if(isLiability) {
    // Transaction signs alone do not identify the balance sign. The independent
    // opening/closing identity must distinguish position from positive owed.
    if(!proof.complete_period_proved)
      return gap('Independent complete-period statement activity is missing; the parsed row count alone cannot prove the liability balance sign.');
    if(!holderRows || position && owed || sign==='position' && effective>=0n)
      return gap('The liability balance sign is unproved; statement charges, payments and a negative holder-side closing must prove the positive-owed convention.');
    proof.sign_proved=true;
    if(sign==='position') {
      current=-current;proof.corrected=true;
      proof.notes.push("corrected from the imported statement's rows: negative holder-side closing and signed charges/payments reconcile; the balance is shown as positive amount owed.");
    }
  }
  return {...observation,current_minor:current,balance_recompute:proof};
}

const objectSql=(alias,columns) => `json_object(${columns.flatMap(c=>[`'${c}'`,`${alias}.${c}`]).join(',')})`;
const fields=MONEY_TABLE_COLUMNS;
const txnFields='tenant_id account_slug statement_uid posted_on amount_minor direction raw_amount_minor raw_sign_convention currency pending provenance source_doc_uid basis_state removed_at superseded_by_id'.split(' ');

// Freeze the amounts and their arithmetic inputs in ONE SQLite read, before
// running caller aggregates. A concurrent import cannot pair new amounts with
// old correction decisions. Oversize/older storage falls back to readable raw
// figures below High at the caller, never to a refusal or an invented zero.
// Bound ledger visits before filtering: a sparse statement in a large feed
// must not scan the entire history before the fallback can retain its figure.
export async function readBalanceRecomputeSnapshot(read, minorUnitEvidenceSql = '') {
  // Nest the optional receipt inside the transaction arm to keep D1's
  // five-term compound limit at the outer level.
  const records=await read(`WITH mq_rb AS MATERIALIZED (SELECT * FROM main.fin_balance_snapshots LIMIT 10001),
    mq_rs AS MATERIALIZED (SELECT * FROM main.fin_statements LIMIT 10001),
    mq_rc AS MATERIALIZED (SELECT * FROM main.fin_account_coverage WHERE superseded_by_id IS NULL LIMIT 1001),
    mq_ra AS MATERIALIZED (SELECT a.*,${accountKindReviewSql('a')} AS account_kind_review_json FROM main.fin_accounts a LIMIT 1001),
    mq_rt AS MATERIALIZED (SELECT * FROM
      (SELECT * FROM main.fin_transactions LIMIT 10001) t
      WHERE EXISTS (SELECT 1 FROM mq_rb b WHERE b.provenance='extracted' AND b.provider_position_minor IS NULL))
    SELECT 'balances' AS kind,${objectSql('b',fields.fin_balance_snapshots)} AS value FROM mq_rb b
    UNION ALL SELECT 'statements',${objectSql('s',fields.fin_statements)} FROM mq_rs s
    UNION ALL SELECT 'accounts',json_set(${objectSql('a',fields.fin_accounts)},'$.account_kind_review_json',a.account_kind_review_json) FROM mq_ra a
    UNION ALL SELECT 'coverage',${objectSql('c',fields.fin_account_coverage)} FROM mq_rc c
    UNION ALL SELECT evidence.kind,evidence.value FROM (
      SELECT 'transactions' AS kind,${objectSql('t',txnFields)} AS value FROM mq_rt t
      ${minorUnitEvidenceSql ? `UNION ALL SELECT 'simplefin_minor_units',(${minorUnitEvidenceSql})` : ''}
    ) AS evidence`);
  const data={balances:[],statements:[],accounts:[],transactions:[],coverage:[]};
  let minorUnits;
  for(const row of records) {
    if(row.kind==='simplefin_minor_units') {
      minorUnits=JSON.parse(row.value);
      continue;
    }
    if(!Object.hasOwn(data,row.kind) || typeof row.value!=='string')throw Error('Balance arithmetic snapshot unavailable');
    data[row.kind].push(JSON.parse(row.value));
  }
  if(data.balances.length>10000 || data.statements.length>10000 || data.accounts.length>1000 || data.transactions.length>10000 || data.coverage.length>1000)
    throw Error('Balance arithmetic snapshot bound exceeded');
  // JSON numbers must preserve every integer exactly, including join ids.
  // Otherwise two SQLite identities can collapse before a caller aggregate.
  for(const rows of Object.values(data)) if(rows.some(row=>Object.values(row).some(value=>
    typeof value==='number' && !Number.isSafeInteger(value)))) throw Error('Balance snapshot integer precision unavailable');
  data.accounts=data.accounts.map(applyAccountKindReview);
  const accounts=new Map(data.accounts.map(a=>[key(a),a]));
  const statementKey=s=>JSON.stringify([s.tenant_id,s.account_slug,s.source_doc_uid,s.period_end]);
  const statements=new Map(),transactions=new Map();
  for(const s of data.statements) {const k=statementKey(s);if(!statements.has(k))statements.set(k,[]);statements.get(k).push(s);}
  for(const t of data.transactions) {const k=JSON.stringify([t.tenant_id,t.account_slug,t.statement_uid]);if(!transactions.has(k))transactions.set(k,[]);transactions.get(k).push(t);}
  data.balances=data.balances.map(b=>{
    const ss=statements.get(statementKey({...b,period_end:b.as_of_date})) || [];
    return recomputeImportedBalance(accounts.get(key(b)) || {},b,ss,
      ss.flatMap(s=>transactions.get(JSON.stringify([s.tenant_id,s.account_slug,s.statement_uid])) || []),data.coverage);
  });
  return minorUnitEvidenceSql ? {...data,minorUnits} : data;
}

function frozenCte(name,columns,rows,binds) {
  const parameters=[],encoder=new TextEncoder();let records=[],bytes=2;
  const flush=()=>{binds.push('['+records.join(',')+']');parameters.push('?'+binds.length);records=[];bytes=2;};
  for(const row of rows) {
    const record=JSON.stringify(Object.fromEntries(columns.map(c=>[c,row[c] ?? null]))),size=encoder.encode(record).length;
    if(size+2>900000)throw Error('Balance snapshot record bound exceeded');
    if(bytes+size+1>900000)flush();records.push(record);bytes+=size+1;
  }
  if(records.length || !parameters.length)flush();
  return `${name} AS MATERIALIZED (SELECT ${columns.map(c=>`json_extract(value,'$.${c}') AS ${c}`).join(',')}
    FROM (VALUES ${parameters.map(p=>'('+p+')').join(',')}) chunks,json_each(chunks.column1))`;
}
export function balanceRecomputeCtes(data,binds) {
  const correctedStatements=new Map();
  for(const b of data.balances) {
    const proof=b.balance_recompute;
    if(!proof?.corrected || proof.gaps.length)continue;
    const k=JSON.stringify([b.tenant_id,b.account_slug,proof.statement_uid]);
    if(!correctedStatements.has(k))correctedStatements.set(k,new Set());
    correctedStatements.get(k).add(proof.statement_closing_minor);
  }
  const statements=data.statements.map(s=>{
    const closings=correctedStatements.get(JSON.stringify([s.tenant_id,s.account_slug,s.statement_uid]));
    return closings?.size===1?{...s,closing_balance_minor:[...closings][0]}:s;
  });
  return [frozenCte('mq_balance_observations',fields.fin_balance_snapshots,data.balances,binds),
    frozenCte('mq_balance_accounts',fields.fin_accounts,data.accounts,binds),
    frozenCte('mq_balance_statements',fields.fin_statements,statements,binds)].join(',');
}
