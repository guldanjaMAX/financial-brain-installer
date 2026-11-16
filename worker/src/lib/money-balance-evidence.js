import { balanceRecomputeCtes } from './money-balance-recompute.js';
import { MONEY_TABLE_COLUMNS } from './money-query-columns.js';
import { effectiveAccountKindSql, effectiveAccountRoleSql, accountKindReviewSql, applyAccountKindReview } from './fin-account-kinds.js';
import { moneyMinorText } from './money-format.js';

// Keep the public account shape while applying the same identity-bound owner
// review used by clean money. Raw storage and the private review table stay private.
export function moneyAccountsCte(filter = '') {
  return `fin_accounts AS MATERIALIZED (SELECT ${MONEY_TABLE_COLUMNS.fin_accounts.map(c =>
    c === 'account_kind' ? `${effectiveAccountKindSql('a')} AS account_kind` :
    c === 'balance_role' ? `${effectiveAccountRoleSql('a')} AS balance_role` : `a.${c}`).join(',')}
    FROM main.fin_accounts a ${filter})`;
}

export async function readMoneyBalanceEvidence(read, asOf, frozen) {
  const binds=[asOf];
  const ctes=frozen?`${balanceRecomputeCtes(frozen,binds)},fin_accounts AS MATERIALIZED (SELECT * FROM mq_balance_accounts),fin_balance_snapshots AS MATERIALIZED (SELECT * FROM mq_balance_observations)`:moneyAccountsCte();
  const rows = await read(`WITH ${ctes}
    SELECT a.*, b.id AS observation_id,b.as_of_date,b.current_minor,b.provider_position_minor,b.basis_state AS observation_basis,
      stored.account_kind AS stored_account_kind,stored.balance_role AS stored_balance_role,
      ${accountKindReviewSql('stored')} AS account_kind_review_json,
      b.currency AS observation_currency,b.provenance AS observation_provenance,b.unparsed_reason AS observation_gap,
      b.source_locator AS observation_locator,
      (SELECT json_object('status',c.coverage_status,'basis',c.basis_state,'from',c.covered_from,'to',c.covered_to)
        FROM main.fin_account_coverage c WHERE c.tenant_id=a.tenant_id AND c.account_slug=a.account_slug
          AND c.superseded_by_id IS NULL ORDER BY c.computed_at DESC,c.id DESC LIMIT 1) AS coverage_json,
      EXISTS(SELECT 1 FROM simplefin_account_assignments s WHERE s.tenant_id=b.tenant_id
        AND ('simplefin-'||substr(s.account_ref,5))=b.account_slug AND b.source_feed=('bank-feed:'||s.item_ref)) AS legacy_simplefin,
      (SELECT json_group_array(json_object('id',t.id,'posted_on',t.posted_on,'direction',t.direction,
        'amount_minor',t.amount_minor,'currency',t.currency)) FROM
        (SELECT id,posted_on,direction,amount_minor,currency FROM main.fin_transactions t
         WHERE t.tenant_id=a.tenant_id AND t.account_slug=a.account_slug AND t.pending=0
           AND t.removed_at IS NULL AND t.superseded_by_id IS NULL
           AND t.posted_on>b.as_of_date AND t.posted_on<=?1 ORDER BY t.posted_on,t.id LIMIT 101) t) AS later_rows_json
    FROM fin_accounts a JOIN main.fin_accounts stored ON stored.id=a.id AND stored.tenant_id=a.tenant_id
    LEFT JOIN fin_balance_snapshots b ON b.id=(SELECT x.id FROM fin_balance_snapshots x
      WHERE x.tenant_id=a.tenant_id AND x.account_slug=a.account_slug AND date(x.as_of_date,'+0 days')=x.as_of_date
        AND x.as_of_date<=?1 ORDER BY x.as_of_date DESC,x.recorded_at DESC,x.id DESC LIMIT 1)
    WHERE a.superseded_by_id IS NULL LIMIT 1001`, binds);
  if (rows.length > 1000) throw Error('Balance evidence account bound exceeded');
  return rows.map(a => {
    const account=frozen?.accounts.find(x=>x.tenant_id===a.tenant_id && x.id===a.id) ||
      applyAccountKindReview({...a,account_kind:a.stored_account_kind,balance_role:a.stored_balance_role});
    const observations=frozen?.balances.filter(b=>b.tenant_id===a.tenant_id && b.account_slug===a.account_slug && b.as_of_date<=asOf) || [];
    // A readable closing cell or signed position does not supply the opening
    // lost by older imports. Assess stored evidence independently of whether
    // recomputation needed to change the figure or returned a proof at all.
    const statementsFor = b => (frozen?.statements || []).filter(s=>s.tenant_id===b.tenant_id && s.account_slug===b.account_slug &&
        s.source_doc_uid===b.source_doc_uid && s.currency===b.currency && s.period_end===b.as_of_date &&
        s.provenance==='extracted' && s.superseded_by_id==null);
    const openingMissing = b => {
      if(b?.provenance!=='extracted')return false;
      const statements=statementsFor(b);
      return statements.length!==1 || !Number.isSafeInteger(statements[0].opening_balance_minor);
    };
    // Signed positions bypass recomputation, but must still agree with the
    // retained statement and current field. Compare liabilities as positive
    // owed versus signed holder position; never rewrite either stored figure.
    const statementGaps = b => {
      if(b?.provenance!=='extracted' || b.balance_recompute?.corrected)return [];
      const statements=statementsFor(b);
      if(statements.length!==1 || !Number.isSafeInteger(statements[0].closing_balance_minor))return [];
      const closing=statements[0].closing_balance_minor,position=b.provider_position_minor,
        liability=account.balance_role==='liability' && ['card','loan','line_of_credit'].includes(account.account_kind);
      const signed=position!=null,expected=signed?(liability?-position:position):b.current_minor;
      if(b.current_minor===expected && (closing===b.current_minor || signed && liability && closing===position))return [];
      const amount=n=>Number.isSafeInteger(n)?`${b.currency} ${moneyMinorText(n,b.currency)}`:'amount missing';
      return [`Imported statement disagreement: stored current ${amount(b.current_minor)}, statement closing ${amount(closing)}${signed?`, signed position ${amount(position)}`:''}. Reconcile the original closing figure and account sign convention.`];
    };
    const current=observations.find(b=>b.id===a.observation_id);
    return {...a,...account,
      balance_recompute:current?.balance_recompute,balance_opening_missing:openingMissing(current),
      balance_statement_gaps:statementGaps(current),
      balance_recompute_history:observations.filter(b=>b.id!==a.observation_id && (b.balance_recompute || b.provenance==='extracted')).map(b=>({
        as_of_date:b.as_of_date,current_minor:b.current_minor,currency:b.currency,notes:[],gaps:[],
        ...b.balance_recompute,statement_gaps:statementGaps(b),opening_balance_missing:openingMissing(b),observation_gap:b.unparsed_reason})),
      basis_state:a.observation_basis,currency:a.observation_currency || a.currency,
      later_rows:JSON.parse(a.later_rows_json),balance_coverage:a.coverage_json ? JSON.parse(a.coverage_json) : null};
  });
}

const sameRows = (left,right) => {
  const stable = rows => rows.map(r => JSON.stringify(Object.entries(r).sort(([a],[b])=>a.localeCompare(b)))).sort();
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
};

function openStatusFilter(tokens) {
  // Equality of totals alone is insufficient: two stale closed balances could
  // cancel. Require a simple outer conjunct, with no alternative query arm or
  // renamed status field, and then verify the exact result by replay as well.
  if(tokens.some((t,i)=>t.kind==='word' && ['or','union','except','intersect'].includes(t.v) ||
    t.v==='status' && tokens[i-1]?.v==='as'))return false;
  let depth=0,start=-1,end=tokens.length;
  const depths=[];
  for(let i=0;i<tokens.length;i++) {
    if(tokens[i].v===')')depth--;
    depths[i]=depth;
    if(depth===0 && tokens[i].v==='where')start=i;
    if(start>=0 && depth===0 && ['group','order','limit','having','window'].includes(tokens[i].v)){end=i;break;}
    if(tokens[i].v==='(')depth++;
  }
  if(start<0)return false;
  for(let i=start+1;i<end;i++) {
    if(depths[i]!==0 || tokens[i].v!=='status' || tokens[i+1]?.v!=='=' || tokens[i+2]?.kind!=='string' || tokens[i+2].v!=='open')continue;
    const beginning=tokens[i-1]?.v==='.'?i-2:i;
    if(['where','and'].includes(tokens[beginning-1]?.v) && (i+3===end || tokens[i+3]?.v==='and'))return true;
  }
  return false;
}

// Scope proof is deliberately narrow; unproved SQL keeps its figure below High.
export async function balanceResultScope({balances,asOf,run,rows,tokens,accountsRead}) {
  const scopedRaw = tokens.some((t,i)=>t.v==='main' && tokens[i+1]?.v==='.' && ['fin_accounts','fin_balance_snapshots','fin_statements'].includes(tokens[i+2]?.v));
  const closed = balances.some(a=>a.status==='closed' && a.closed_on && a.closed_on<=asOf);
  const closedNotCounted = closed && accountsRead && !scopedRaw && openStatusFilter(tokens) && sameRows(rows,await run(
    `WHERE NOT (a.status='closed' AND a.closed_on IS NOT NULL AND a.closed_on<='${asOf}')`));
  const currencies=[...new Set(balances.filter(a=>a.as_of_date).map(a=>a.currency))];
  let currenciesSeparated=currencies.length<=1;
  if (!currenciesSeparated && currencies.length<=8 && currencies.every(c=>/^[A-Z]{3}$/.test(c)) && !scopedRaw) {
    const separated=[];
    for(const c of currencies) separated.push(...await run(`WHERE a.currency='${c}'`,c));
    currenciesSeparated=sameRows(rows,separated);
  }
  return {closedNotCounted,currenciesSeparated,scopedRaw};
}
