import { bankCoverageGaps } from './bank-coverage-intervals.js';
import { moneyMinorText } from './money-format.js';
import { moneyOverlapGroups } from './money-query-overlap.js';
import { openingRowSql, historyCoverageStartSql, historyHoles } from './money-history.js';
import { pendingInScope } from './money-pending.js';
import { ASSIGNED_MONEY_FEED_SQL as assignedFeed, ASSIGNED_MONEY_FEED_SYNC_SQL, DISCOVERED_PROVIDER_CONFLICT_SQL,
  DISCOVERED_LEDGER_REFERENCE_SQL, MONEY_FEED_ASSIGNMENTS_SQL, SIMPLEFIN_LEDGER_REFERENCE_SQL } from './money-feed-assignment.js';

export function verifiedMoneySyncInstant(receipt, instant) {
  const parts = typeof receipt === 'string' &&
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(receipt);
  if (!parts || parts[0] !== receipt) return null;
  const [year, month, day, hour, minute, second = 0, offsetHour = 0, offsetMinute = 0] =
    parts.slice(1).map(value => value === undefined ? undefined : Number(value));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLength = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  // Date.parse normalizes some impossible civil times, including November 31.
  if (!monthLength || day < 1 || day > monthLength || hour > 23 || minute > 59 ||
      second > 59 || offsetHour > 23 || offsetMinute > 59) return null;
  const sync = Date.parse(receipt);
  return sync <= instant ? sync : null;
}

// The saved request bounds the provider history, never a rolling date computed
// at answer time. Completion and readable confirmed coverage are separate facts.
// Keep this fixed projection shared with the independent overview inventory.
const requestedHistory = completed => `(SELECT MIN(date(substr(h.queued_at,1,10),printf('-%d days',h.requested_days-1)))
  FROM bank_feed_items b JOIN bank_feed_backfill h ON h.tenant_id=b.tenant_id AND h.item_ref=b.item_ref
  WHERE ${assignedFeed} AND h.requested_days BETWEEN 1 AND 2000
    AND date(substr(h.queued_at,1,10),'+0 days')=substr(h.queued_at,1,10)
    ${completed ? `AND h.state='complete' AND h.unread_lines=0 AND h.finished_at>=h.queued_at
      AND h.finished_at<=b.last_synced_at AND (h.provider_history_state='HISTORICAL_UPDATE_COMPLETE'
        OR EXISTS(SELECT 1 FROM simplefin_account_assignments s WHERE s.tenant_id=a.tenant_id
          AND s.item_ref=b.item_ref AND s.entity_slug IS NOT NULL AND ${SIMPLEFIN_LEDGER_REFERENCE_SQL}))` : ''})`;
const firstPostedSql = `(SELECT MIN(t.posted_on) FROM fin_transactions t WHERE t.tenant_id=a.tenant_id
    AND t.account_slug=a.account_slug AND t.pending=0 AND t.removed_at IS NULL AND t.superseded_by_id IS NULL
    AND date(t.posted_on,'+0 days')=t.posted_on)`;
export const MONEY_ACCOUNT_HISTORY_SQL = `json_object(
  'first_posted',${firstPostedSql},'first_row_opening',${openingRowSql('a',firstPostedSql)},
  'requested_from',${requestedHistory(false)},'completed_from',${requestedHistory(true)})`;

// Confidence is an evidence score, never permission to withhold an answer.
// Keep private connection reads fixed and project only safe facts. This runs in
// the same SQLite statement as its clean evidence snapshot, which must match
// the completed amount snapshot before it can certify anything. No credential
// or provider identifier is selected.
export const MONEY_CONFIDENCE_SNAPSHOT_SQL = `SELECT 'confidence_accounts' AS snapshot_kind,json_object(
  'tenant_id',a.tenant_id,'account_slug',a.account_slug,'last4',a.mask,'currency',a.currency,'feed_mode',a.feed_mode,
  'opened_on',a.opened_on,'closed_on',a.closed_on,'history',${MONEY_ACCOUNT_HISTORY_SQL},
  'connected',EXISTS(SELECT 1 FROM bank_feed_items b WHERE ${assignedFeed}),
  'last_sync',${ASSIGNED_MONEY_FEED_SYNC_SQL},
  'covered_from',${historyCoverageStartSql('a',firstPostedSql,"c.coverage_status='complete' AND c.basis_state='confirmed'")},'covered_to',c.covered_to,
  'coverage_confirmed',CASE WHEN c.coverage_status='complete' AND c.basis_state='confirmed'
    AND date(c.covered_from,'+0 days')=c.covered_from AND date(c.covered_to,'+0 days')=c.covered_to
    AND c.covered_from<=c.covered_to AND COALESCE(c.basis_note,'') NOT LIKE 'Read from a bank export covering %'
    THEN 1 ELSE 0 END
) AS value,NULL AS value2 FROM (SELECT * FROM fin_accounts WHERE superseded_by_id IS NULL ORDER BY tenant_id,account_slug LIMIT 1001) a
LEFT JOIN fin_account_coverage c ON c.tenant_id=a.tenant_id AND c.account_slug=a.account_slug AND c.superseded_by_id IS NULL
UNION ALL SELECT 'confidence_unassigned',json_object('tenant_id',p.tenant_id,'account_count',count(*),
  'provider_conflict_count',SUM(${DISCOVERED_PROVIDER_CONFLICT_SQL})),NULL
FROM (${MONEY_FEED_ASSIGNMENTS_SQL}) p
WHERE EXISTS(SELECT 1 FROM bank_feed_items b WHERE b.tenant_id=p.tenant_id AND b.item_ref=p.item_ref
  AND b.environment='production' AND b.removed_at IS NULL)
  AND NOT EXISTS(SELECT 1 FROM fin_accounts a WHERE a.tenant_id=p.tenant_id AND a.superseded_by_id IS NULL
    AND ${DISCOVERED_LEDGER_REFERENCE_SQL})
GROUP BY p.tenant_id
UNION ALL SELECT 'confidence_pending',json_object('tenant_id',tenant_id,'account_slug',account_slug,
  'posted_on',posted_on,'currency',currency,'direction',direction,'amount_minor',SUM(amount_minor),'row_count',count(*)),NULL
FROM fin_transactions t WHERE pending=1 AND removed_at IS NULL AND superseded_by_id IS NULL
  AND NOT EXISTS(SELECT 1 FROM fin_transactions p WHERE p.tenant_id=t.tenant_id AND p.account_slug=t.account_slug
    AND p.pending=0 AND p.removed_at IS NULL AND p.superseded_by_id IS NULL AND p.source_provider IS t.source_provider
    AND t.external_id IS NOT NULL AND p.pending_transaction_id=t.external_id)
GROUP BY tenant_id,account_slug,posted_on,currency,direction`;

// Resolve the retained canonical observation before choosing affected periods.
// An ID-only withdrawal has no incoming date/account/amount. Unknown lineage
// therefore affects every associated account/period until it is reconciled.
// This projection shares the amount snapshot; it exposes no provider IDs.
const pendingReplacementEventsSql = `WITH pending_events AS MATERIALIZED (
  SELECT v.*,x.old_item_ref,x.new_item_ref FROM plaid_replacement_events v JOIN plaid_item_replacements x
    ON x.tenant_id=v.tenant_id AND x.operation_ref=v.operation_ref
  WHERE x.tenant_id=a.tenant_id AND x.state<>'cancelled' AND (v.revision>x.published_revision OR NOT EXISTS(SELECT 1 FROM plaid_replacement_decisions d WHERE d.tenant_id=v.tenant_id AND d.operation_ref=v.operation_ref AND d.revision=v.revision AND d.event_index=v.event_index))
    AND (a.source_feed='bank-feed:'||x.old_item_ref OR EXISTS(SELECT 1 FROM plaid_replacement_bindings b
      WHERE b.tenant_id=x.tenant_id AND b.operation_ref=x.operation_ref AND b.account_slug=a.account_slug))
)`;
const legacyReplacementLineageSql = `, lineage AS (
  SELECT v.operation_ref,v.revision,v.event_index,t.account_slug,t.posted_on,t.currency,t.direction,t.amount_minor
  FROM pending_events v JOIN main.fin_transactions t ON t.tenant_id=v.tenant_id AND (
    EXISTS(SELECT 1 FROM plaid_replacement_aliases l WHERE l.tenant_id=v.tenant_id AND l.operation_ref=v.operation_ref
      AND l.provider_id IN (v.provider_id,json_extract(v.payload_json,'$.pending_id')) AND l.canonical_row_id=t.id)
    OR (NOT EXISTS(SELECT 1 FROM plaid_replacement_aliases l WHERE l.tenant_id=v.tenant_id AND l.operation_ref=v.operation_ref
        AND l.provider_id IN (v.provider_id,json_extract(v.payload_json,'$.pending_id')))
      AND (t.external_id IN (v.provider_id,json_extract(v.payload_json,'$.pending_id'))
        OR (json_extract(v.payload_json,'$.operation')='added' AND t.removed_at IS NULL AND t.superseded_by_id IS NULL
          AND t.amount_minor=json_extract(v.payload_json,'$.amount') AND t.currency=json_extract(v.payload_json,'$.currency')
          AND t.direction=json_extract(v.payload_json,'$.direction') AND (
            EXISTS(SELECT 1 FROM plaid_replacement_bindings b WHERE b.tenant_id=v.tenant_id AND b.operation_ref=v.operation_ref
              AND b.account_slug=t.account_slug AND b.new_provider_id=v.provider_account_id)
            OR NOT EXISTS(SELECT 1 FROM plaid_replacement_bindings b WHERE b.tenant_id=v.tenant_id AND b.operation_ref=v.operation_ref))))
      AND (t.source_feed IN ('bank-feed:'||v.old_item_ref,'bank-feed:'||v.new_item_ref) OR EXISTS(
        SELECT 1 FROM plaid_replacement_bindings b WHERE b.tenant_id=v.tenant_id AND b.operation_ref=v.operation_ref AND b.account_slug=t.account_slug))))
)`;
const replacementEffectsSql = `, effects AS (
  SELECT 'saved' AS phase,posted_on AS date,currency,direction,amount_minor AS amount
  FROM lineage WHERE account_slug=a.account_slug
  UNION ALL SELECT 'incoming',json_extract(v.payload_json,'$.date'),json_extract(v.payload_json,'$.currency'),
    json_extract(v.payload_json,'$.direction'),json_extract(v.payload_json,'$.amount') FROM pending_events v
  WHERE json_extract(v.payload_json,'$.operation')<>'removed' AND (
    EXISTS(SELECT 1 FROM plaid_replacement_bindings b WHERE b.tenant_id=v.tenant_id AND b.operation_ref=v.operation_ref
      AND b.account_slug=a.account_slug AND b.new_provider_id=v.provider_account_id)
    OR NOT EXISTS(SELECT 1 FROM plaid_replacement_bindings b WHERE b.tenant_id=v.tenant_id AND b.operation_ref=v.operation_ref))
  UNION ALL SELECT 'unknown',NULL,NULL,NULL,NULL FROM pending_events v
  WHERE (json_extract(v.payload_json,'$.operation') IN ('modified','removed') OR json_extract(v.payload_json,'$.pending_id') IS NOT NULL
    OR EXISTS(SELECT 1 FROM plaid_replacement_aliases l WHERE l.tenant_id=v.tenant_id AND l.operation_ref=v.operation_ref AND l.provider_id=v.provider_id))
    AND NOT EXISTS(SELECT 1 FROM lineage l WHERE l.operation_ref=v.operation_ref AND l.revision=v.revision AND l.event_index=v.event_index)
) SELECT json_group_array(json_object('phase',phase,'date',date,'currency',currency,'direction',direction,'amount',amount)) FROM effects`;
const legacyReplacementReviewValuesSql = pendingReplacementEventsSql+legacyReplacementLineageSql+replacementEffectsSql;

// Resolve all retained identities through the immutable correction edges.
// Conflicting branches expose every candidate, rather than allowing one stale
// account-bound alias to suppress the current head's affected dollars.
// Materialize the journal projections once per account snapshot. Re-expanding
// recursive identity/head views for each held event grows rapidly after moves
// and repeated connection replacements, despite the small number of rows.
const occurrenceReviewValuesSql = pendingReplacementEventsSql+`,
retained_identities AS MATERIALIZED (SELECT * FROM plaid_occurrence_identities WHERE tenant_id=a.tenant_id),
retained_links AS MATERIALIZED (SELECT origin_row_id,successor_row_id FROM plaid_occurrence_links WHERE tenant_id=a.tenant_id),
retained_items AS MATERIALIZED (SELECT * FROM plaid_replacement_item_lineage WHERE tenant_id=a.tenant_id),
roots AS MATERIALIZED (
  SELECT v.operation_ref,v.revision,v.event_index,i.origin_row_id FROM pending_events v
  JOIN retained_identities i ON i.tenant_id=v.tenant_id AND i.item_ref IN
    (SELECT item_ref FROM retained_items WHERE tenant_id=v.tenant_id AND operation_ref=v.operation_ref)
    AND i.provider_id IN (v.provider_id,json_extract(v.payload_json,'$.pending_id'))
  UNION SELECT v.operation_ref,v.revision,v.event_index,l.canonical_row_id FROM pending_events v
    JOIN plaid_replacement_aliases l ON l.tenant_id=v.tenant_id AND l.operation_ref=v.operation_ref
      AND l.provider_id IN (v.provider_id,json_extract(v.payload_json,'$.pending_id'))
  UNION SELECT v.operation_ref,v.revision,v.event_index,t.id FROM pending_events v JOIN main.fin_transactions t
    ON t.tenant_id=v.tenant_id AND json_extract(v.payload_json,'$.operation')='added'
    AND t.removed_at IS NULL AND t.superseded_by_id IS NULL AND t.amount_minor=json_extract(v.payload_json,'$.amount')
    AND t.currency=json_extract(v.payload_json,'$.currency') AND t.direction=json_extract(v.payload_json,'$.direction')
    AND (t.source_feed IN ('bank-feed:'||v.old_item_ref,'bank-feed:'||v.new_item_ref) OR EXISTS(
      SELECT 1 FROM plaid_replacement_bindings b WHERE b.tenant_id=v.tenant_id AND b.operation_ref=v.operation_ref AND b.account_slug=t.account_slug))
    AND NOT EXISTS(SELECT 1 FROM retained_identities i WHERE i.tenant_id=v.tenant_id
      AND i.item_ref IN (SELECT item_ref FROM retained_items WHERE tenant_id=v.tenant_id AND operation_ref=v.operation_ref)
      AND i.provider_id IN (v.provider_id,json_extract(v.payload_json,'$.pending_id')))
), forward AS (
  SELECT DISTINCT origin_row_id,origin_row_id AS head_row_id FROM roots
  UNION SELECT w.origin_row_id,l.successor_row_id FROM forward w JOIN retained_links l ON l.origin_row_id=w.head_row_id
), root_heads AS MATERIALIZED (
  SELECT w.origin_row_id,w.head_row_id FROM forward w
  WHERE NOT EXISTS(SELECT 1 FROM retained_links l WHERE l.origin_row_id=w.head_row_id)
), history AS (
  SELECT DISTINCT head_row_id,head_row_id AS row_id FROM root_heads
  UNION SELECT b.head_row_id,l.origin_row_id FROM history b JOIN retained_links l ON l.successor_row_id=b.row_id
), lineage AS MATERIALIZED (
  SELECT DISTINCT r.operation_ref,r.revision,r.event_index,t.account_slug,t.posted_on,t.currency,t.direction,t.amount_minor
  FROM roots r JOIN root_heads h ON h.origin_row_id=r.origin_row_id
  JOIN history ON history.head_row_id=h.head_row_id
  JOIN main.fin_transactions t ON t.tenant_id=a.tenant_id AND t.id=history.row_id
)`+replacementEffectsSql;

export function moneyConfidenceSnapshotSql(replacementTables=false,occurrenceTables=replacementTables) {
  return replacementTables ? MONEY_CONFIDENCE_SNAPSHOT_SQL.replace("  'connected',",`  'replacement_intervals',json((SELECT json_group_array(json_object('from',i.covered_from,'to',i.covered_to))
    FROM bank_account_coverage_intervals i WHERE i.tenant_id=a.tenant_id AND i.account_slug=a.account_slug)),
  'replacement_review_values',json((${occurrenceTables ? occurrenceReviewValuesSql : legacyReplacementReviewValuesSql})),
  'replacement_review_from',(SELECT MIN(CASE WHEN x.operation_ref IS NOT NULL THEN COALESCE(date(c.covered_to,'+1 day'),'0001-01-01') END)
    FROM plaid_item_replacements x WHERE x.tenant_id=a.tenant_id AND x.state NOT IN ('cancelled','active')
      AND (x.state<>'rolled_back' OR EXISTS(SELECT 1 FROM plaid_replacement_events v
        WHERE v.tenant_id=x.tenant_id AND v.operation_ref=x.operation_ref AND (v.revision>x.published_revision OR NOT EXISTS(SELECT 1 FROM plaid_replacement_decisions d WHERE d.tenant_id=v.tenant_id AND d.operation_ref=v.operation_ref AND d.revision=v.revision AND d.event_index=v.event_index))))
      AND (a.source_feed='bank-feed:'||x.old_item_ref OR EXISTS(SELECT 1 FROM plaid_replacement_bindings b
        WHERE b.tenant_id=x.tenant_id AND b.operation_ref=x.operation_ref AND b.account_slug=a.account_slug))),
  'connected',`) : MONEY_CONFIDENCE_SNAPSHOT_SQL;
}

const DAY = 86400000;
const dateValue = day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) &&
  Number.isFinite(Date.parse(day + 'T12:00:00Z')) && new Date(day + 'T12:00:00Z').toISOString().slice(0, 10) === day;
const days = (from, to) => Math.round((Date.parse(to + 'T12:00:00Z') - Date.parse(from + 'T12:00:00Z')) / DAY) + 1;
const shift = (day, n) => new Date(Date.parse(day + 'T12:00:00Z') + n * DAY).toISOString().slice(0, 10);
const identity = a => `Account ending ${/^\d{4}$/.test(a.last4) ? a.last4 : '(last four unknown)'}`;
// Same word normalization as ledger-analysis.js, kept local to avoid an import cycle.
const normalizeLedgerText = value => (String(value || '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).join(' ');
const money = (currency, minor) => `${currency} ${currency === 'USD' ? '$' : ''}${moneyMinorText(minor, currency)}`;
const key = a => JSON.stringify([a.tenant_id, a.account_slug]);

export function moneyAccountStart(account) {
  if (dateValue(account.opened_on)) return account.opened_on;
  // A memo that says opening/initial deposit does not prove the account's
  // lifetime. Only the independently recorded opening date clips required days.
  return null;
}

export function confidenceText(confidence) {
  return `Confidence: ${confidence.level} (${confidence.percent}%)` + (confidence.percent === 100 ? '' :
    `\nReasons: ${confidence.reasons.join(' ')}\nMissing: ${confidence.missing.join(' ')}`);
}

export function unknownMoneyConfidence(reason = 'Money evidence could not be read.', missing = 'Read the accounts, confirmed date coverage, successful sync times and supporting rows to verify the amount.') {
  return { level: 'Low', percent: 0, reasons: [reason], missing: [missing] };
}

export function limitMoneyConfidence(confidence, reason, missing, cap = 69) {
  const percent = Math.min(confidence.percent, cap);
  return { level: percent >= 90 ? 'High' : percent >= 70 ? 'Medium' : 'Low', percent,
    reasons: [...confidence.reasons, reason], missing: [...confidence.missing, missing] };
}

// This is deliberately a small proof grammar, not a SQL guesser. A literal in a
// projection, subquery, OR arm or CTE must never certify the caller's period.
// Unsupported SQL still executes; it simply cannot earn a verified scope.
export function moneyConfidenceScope({ tokens }, table = 'txn') {
  const words = tokens.filter(t => t.kind === 'word').map(t => t.v);
  if (tokens[0]?.v !== 'select' || words.filter(v => v === 'select').length !== 1 ||
      words.filter(v => v === 'from').length !== 1 || words.some(v => ['join','or','union','except','intersect','offset','window','over'].includes(v))) return null;
  const from = tokens.findIndex(t => t.kind === 'word' && t.v === 'from');
  if (tokens[from + 1]?.v !== table) return null;
  let i = from + 2, alias = table;
  if (tokens[i]?.v === 'as') i++;
  if (tokens[i]?.kind === 'word' && tokens[i].v !== 'where') alias = tokens[i++].v;
  if (tokens[i++]?.v !== 'where') return null;
  const scope = { filters: {}, bounded: words.includes('limit') }, seen = new Set();
  while (i < tokens.length) {
    // A null-safe category exclusion selects rows, not accounts. Preserve its
    // literal for the evidence slice instead of rejecting an ordinary recipe.
    if (tokens.slice(i,i+8).map(t=>t.v).join(' ')==="coalesce ( category ,  ) < >" &&
        tokens[i+4]?.kind==='string' && tokens[i+4].raw==="''" && tokens[i+8]?.kind==='string') {
      (scope.rowFilters ||= {}).categoryExcluded=tokens[i+8].raw.slice(1,-1).replaceAll("''","'"); i+=9;
      if(i===tokens.length || ['group','order','limit'].includes(tokens[i]?.v))break;
      if(tokens[i++]?.v!=='and')return null;
      continue;
    }
    // These guide predicates select a contribution or a named detail. Keep
    // them out of inventory filters: a processor is not an account, and a
    // positive-contribution filter cannot prove that excluded rows are safe.
    if (tokens[i]?.v === 'lower' && tokens[i+1]?.v === '(') {
      let j=i+2, column=tokens[j++];
      if (tokens[j]?.v==='.' && [alias,table].includes(column?.v)) { j++; column=tokens[j++]; }
      if (column?.v!=='description' || tokens[j++]?.v!==')' || tokens[j++]?.v!=='like' ||
          tokens[j]?.kind!=='string' || !['%interest%','%fee%'].includes(tokens[j].raw.slice(1,-1))) return null;
      if (seen.has('description')) return null;
      scope.detailFilter=tokens[j].v==='%fee%'?'fee':'interest';
      seen.add('description'); i=j+1;
      if (i===tokens.length || ['group','order','limit'].includes(tokens[i]?.v)) break;
      if (tokens[i++]?.v!=='and') return null;
      continue;
    }
    let column = tokens[i++];
    if (tokens[i]?.v === '.') {
      if (column.v !== alias && column.v !== table) return null;
      i++; column = tokens[i++];
    }
    if (!['word','identifier'].includes(column?.kind) || seen.has(column.v) && column.v!=='posted_on') return null;
    seen.add(column.v);
    let op = tokens[i++]?.v;
    if (op==='<' && tokens[i]?.v==='>' || op==='!' && tokens[i]?.v==='=') op+=tokens[i++].v;
    else if (['<','>'].includes(op) && tokens[i]?.v==='=') op+=tokens[i++].v;
    const value = tokens[i++];
    if (column.v === 'posted_on') {
      if (op === 'between' && !scope.from && !scope.to) {
        if (tokens[i++]?.v !== 'and') return null;
        const end = tokens[i++];
        if (value?.kind !== 'string' || end?.kind !== 'string' || !dateValue(value.raw.slice(1, -1)) || !dateValue(end.raw.slice(1, -1))) return null;
        scope.from = value.raw.slice(1, -1); scope.to = end.raw.slice(1, -1);
      } else if (op === '=' && !scope.from && !scope.to && value?.kind === 'string' && dateValue(value.raw.slice(1, -1))) scope.from = scope.to = value.raw.slice(1, -1);
      // Inclusive paired comparisons are the same closed posting interval as
      // BETWEEN. Repeated, exclusive and incomplete bounds prove no scope.
      else if (['>=','<='].includes(op) && value?.kind==='string' && dateValue(value.raw.slice(1,-1))) {
        const bound=op==='>='?'from':'to';
        if(scope[bound])return null;
        scope[bound]=value.raw.slice(1,-1);
      }
      else return null;
    } else if (table==='fin_transactions' &&
        (column.v==='amount_minor' && ['=','<>','!=','>','>=','<','<='].includes(op) && value?.kind==='number' ||
         column.v==='source_provider' && ['=','<>','!='].includes(op) && value?.kind==='string')) {
      // These posting predicates leave the account and date bounds intact.
    } else {
      if (['income_minor','expense_minor'].includes(column.v) && op==='>' && value?.kind==='number' && value.v==='0') {
        (scope.positiveContributions ||= []).push(column.v);
      } else if (['income_minor','expense_minor'].includes(column.v) && ['<>','!='].includes(op) && value?.kind==='number' && value.v==='0') {
        // A non-zero contribution filter drops only zero rows, so it keeps
        // signed reversals and cannot change a SUM. The guide's Income and
        // Payers recipes use it; it proves nothing about inventory either.
        (scope.nonzeroContributions ||= []).push(column.v);
      } else {
        if (!['tenant_id','account_slug','account_identity','account','entity','side','currency','direction','processor','money_kind','payment_kind','category'].includes(column.v) ||
            !['=','<>','!='].includes(op) || value?.kind !== 'string' || op!=='=' && column.v!=='money_kind') return null;
        // raw retains case; tokenizer v is lowercased for validation only.
        const literal=value.raw.slice(1, -1).replaceAll("''", "'");
        if (column.v==='category') (scope.rowFilters ||= {}).category={op,value:literal};
        else if (['processor','money_kind','payment_kind'].includes(column.v)) {
          const allowed={processor:['stripe','square','paypal','shopify'],payment_kind:['card','loan'],
            money_kind:['ordinary','own_transfer','card_payment','loan_payment','loan_proceeds','liability_credit','payout','refund','payment_reversal','refund_reversal','deposit_reversal']};
          if (!allowed[column.v].includes(literal)) return null;
          (scope.rowFilters ||= {})[column.v]={op,value:literal};
        } else scope.filters[column.v] = literal;
        if (column.v==='direction' && !['inflow','outflow'].includes(scope.filters[column.v])) return null;
      }
    }
    if (i === tokens.length || ['group','order','limit'].includes(tokens[i]?.v)) break;
    if (tokens[i++]?.v !== 'and') return null;
  }
  const having=tokens.findIndex(t=>t.v==='having');
  if(having>=0) {
    const clause=tokens.slice(having).map(t=>t.v).join(' ');
    const fixed=/^having count \( distinct substr \( posted_on , 1 , 7 \) \) = (\d+) and min \( amount_minor \) = max \( amount_minor \)$/.exec(clause);
    const months=scope.from && scope.to && (Number(scope.to.slice(0,4))-Number(scope.from.slice(0,4)))*12+Number(scope.to?.slice(5,7))-Number(scope.from?.slice(5,7))+1;
    const end=scope.to && new Date(Date.parse(scope.to)+86400000).toISOString().slice(8,10);
    if(!fixed || scope.from?.slice(8)!=='01' || end!=='01' || Number(fixed[1])!==months || !scope.positiveContributions?.includes('expense_minor'))return null;
    const recurringGroup=tokens.findIndex(t=>t.v==='group');
    const grouping=tokens.slice(recurringGroup+2,having).map(t=>t.v).join(' ');
    if(!['payee , currency','currency , payee'].includes(grouping))return null;
    const fields=[];let depth=0,start=1;
    for(let n=1;n<=from;n++) {
      if(n===from || tokens[n].v===',' && depth===0){fields.push(tokens.slice(start,n));start=n+1;}
      else if(tokens[n].v==='(')depth++;else if(tokens[n].v===')')depth--;
    }
    // This closed recurrence shape certifies a per-party monthly charge, not
    // an arbitrary expression or a MIN across unrelated vendor groups.
    for(const field of fields) {
      const alias=field.at(-2)?.v==='as'?field.at(-1).v:null;
      if(alias)field.splice(-2);
      const value=field.map(t=>t.v).join(' ');
      if(field.some(t=>t.kind==='string') || !/^(?:payee|currency|(?:min|max) \( amount_minor \)|count \( distinct substr \( posted_on , 1 , 7 \) \))$/.test(value))return null;
      const aliases=value==='payee'?['vendor','payee']:value==='currency'?['currency']:
        value.startsWith('count')?['months']:['cents','amount_minor','monthly_minor','charge_minor'];
      if(alias && !aliases.includes(alias))return null;
    }
    scope.recurring=true;
  }
  // Only a literal column GROUP BY proves separate currency aggregation.
  // The caller also checks that the returned currency field survives projection.
  const group = tokens.findIndex((t, index) => index >= i && t.kind === 'word' && t.v === 'group');
  if (group >= 0 && tokens[group + 1]?.v === 'by') {
    let depth=0,start=group+2;
    for(let cursor=start;cursor<=tokens.length;cursor++) {
      const t=tokens[cursor];
      if(!t || depth===0 && [',','having','order','limit'].includes(t.v)) {
        const item=tokens.slice(start,cursor),values=item.map(t=>t.v);
        if(item.every(t=>t.kind!=='string') && (values.join(' ')==='currency' ||
          values.length===3 && [alias,table].includes(values[0]) && values[1]==='.' && values[2]==='currency'))scope.currenciesSeparated=true;
        if(t?.v!==',')break;
        start=cursor+1;
      } else if(t.v==='(')depth++;else if(t.v===')')depth--;
    }
  }
  if (scope.currenciesSeparated) {
    const projections = []; let depth = 0, start = 1;
    for (let n = 1; n <= from; n++) {
      if (n === from || tokens[n].v === ',' && depth === 0) { projections.push(tokens.slice(start, n)); start = n + 1; }
      else if (tokens[n].v === '(') depth++;
      else if (tokens[n].v === ')') depth--;
    }
    const directCurrency = p => {
      const values = p.map(t => t.v);
      if (values.at(-2) === 'as' && values.at(-1) === 'currency') values.splice(-2);
      return values.length === 1 && values[0] === 'currency' && p[0].kind !== 'string' ||
        values.length === 3 && [alias, table].includes(values[0]) && values[1] === '.' && values[2] === 'currency';
    };
    // A literal/CASE alias or duplicate currency projection must not relabel
    // a correctly grouped amount and then inherit High from its grouping.
    const namedCurrency = projections.filter(p => p.some(t => t.v === 'currency'));
    scope.currenciesSeparated = namedCurrency.length === 1 && directCurrency(namedCurrency[0]);
  }
  return scope.from && scope.from <= scope.to ? scope : null;
}

function matches(row, scope) {
  return Object.entries(scope.filters || {}).every(([column, value]) => column === 'direction' ||
    (column==='account' ? row.account ?? row.last4 : row[column]) === value);
}

// These are ceilings on every caller path, including confirmed manual
// statements. Coverage and a returned field called currency do not prove SQL.
export function moneySqlConfidence(confidence, {checked, scope, snapshot, decisions = [], period, accountSlugs, immaterialRisk=false}) {
  // Adding redundant period arguments must not change an inventory claim.
  // Literal SQL proves the recorded selection, never undeclared accounts.
  if (scope) confidence=limitMoneyConfidence(confidence,
    'The complete expected-account inventory is not independently verified.',
    'Owner-confirmed expected accounts and verified statement coverage for the requested dates.',95);
  if (!scope) confidence=limitMoneyConfidence(confidence,
    'The SQL selection is outside the proved literal-date and AND-only account/filter grammar; period arguments do not prove that selection.',
    'Verify the SQL filters against the requested question and use a literal-bounded clean txn selection. Unproved filters may omit amounts whose impact is unknown.',89);
  if (!snapshot) return confidence;
  const range=scope || period;
  const selected=r=>(!accountSlugs || accountSlugs.includes(r.account_slug)) &&
    (!range || r.posted_on>=range.from && r.posted_on<=range.to) &&
    (!scope || matches(r,scope) && (!scope.filters.direction || r.direction===scope.filters.direction));
  const rows=snapshot.rows.filter(selected);
  const membership=new Map(decisions.map(d=>[d.id,d]));
  const projection=checked.tokens.slice(0,checked.tokens.findIndex(t=>t.kind==='word' && t.v==='from'));
  const categoryLiteral=scope?.rowFilters?.category?.value;
  const categoryVariants=categoryLiteral?rows.filter(r=>r.category && r.category!==categoryLiteral && normalizeLedgerText(r.category)===normalizeLedgerText(categoryLiteral)):[];
  for(const currency of new Set(categoryVariants.map(r=>r.currency))) {
    const group=categoryVariants.filter(r=>r.currency===currency),known=group.every(r=>Number.isSafeInteger(r.amount_minor) && r.amount_minor>=0);
    confidence=limitMoneyConfidence(confidence,
      `${known?money(currency,group.reduce((n,r)=>n+BigInt(r.amount_minor),0n)):'An amount not quantified'} has a case or spacing variant of the selected category and can be omitted by the exact SQL literal.`,
      'Use the exact recorded category or confirm the category aliases before certifying this subtotal.',89);
  }
  if(scope?.rowFilters?.category && rows.some(r=>{
    const d=membership.get(r.id);
    const relevant=scope.positiveContributions?.includes('income_minor')?r.direction==='inflow':
      scope.positiveContributions?.includes('expense_minor')?r.direction==='outflow':true;
    return relevant && (d?.money_kind==='ordinary' || d?.estimated || d?.kind_unproved) &&
      (!r.category || r.category_basis_state!=='confirmed');
  }))confidence=limitMoneyConfidence(confidence,
    'The SQL selection has an unproved category population; uncategorized or unconfirmed postings could belong in the requested category.',
    'Owner-confirmed categories for the selected period and accounts, including each uncategorized posting.',89);
  const paired=new Set((snapshot.pairs || []).filter(p=>p.proved).flatMap(p=>[p.out_id,p.in_id]));
  // A LIKE '%fee%' / '%interest%' detail filter is a substring, not a closed
  // set of fee or interest rows. Name the dollars it may wrongly include
  // (COFFEE, INTERESTING ...) or leave out (SERVICE CHARGE, FINANCE CHARGE).
  if (scope?.detailFilter) {
    const fee=scope.detailFilter==='fee';
    const word=fee ? /\bfees?\b/ : /\binterest\b/;
    const synonym=fee ? /\b(?:(?:service|monthly|maintenance|overdraft|nsf|returned item|wire|late|annual|bank|account) charges?|overdraft|nsf|penalty|penalties)\b/
      : /\b(?:finance charges?|purchase charges?|int (?:chg|charge)|apr charge|periodic rate)\b/;
    const text=r=>normalizeLedgerText(r.description);
    const loose=rows.filter(r=>String(r.description || '').toLowerCase().includes(scope.detailFilter) && !word.test(text(r)));
    const missed=rows.filter(r=>!String(r.description || '').toLowerCase().includes(scope.detailFilter) && synonym.test(text(r)));
    for (const [group,what] of [[loose,`match '%${scope.detailFilter}%' only inside another word`],[missed,`look like ${fee?'fees':'interest'} but do not contain '${scope.detailFilter}'`]]) {
      for (const currency of new Set(group.map(r=>r.currency))) {
        const own=group.filter(r=>r.currency===currency);
        confidence=limitMoneyConfidence(confidence,
          `${money(currency,own.reduce((n,r)=>n+r.amount_minor,0))} in ${own.length} posting(s) ${what} (${[...new Set(own.map(r=>String(r.description || '').slice(0,40)))].slice(0,3).join('; ')}); the description filter is not a closed ${fee?'fee':'interest'} list.`,
          `Check each listed posting against the statement and select ${fee?'fee':'interest'} rows by whole words or by row id before certifying the total.`,89);
      }
    }
  }
  // Party identity, grouping and read-history proof for both income and expense
  // contributions is enforced once by moneyTypeCertificate at query completion.
  const postedFee=rows.some(r=>r.direction==='outflow' && /\bfees?\b/i.test(r.description || '') && membership.get(r.id)?.money_kind==='ordinary');
  if ((scope?.detailFilter==='fee' || projection.some(t=>t.kind==='string' && /\bfees?\b/.test(t.v))) &&
      (scope?.rowFilters?.processor || !postedFee) &&
      rows.some(r=>r.direction==='inflow' && /\b(?:stripe|square|paypal|shopify)\b/i.test([r.payee,r.description].filter(Boolean).join(' '))))
    confidence=limitMoneyConfidence(confidence,
      'A processor deposit can be net of fees; the bank postings do not establish the total processor fee amount, including an apparent zero.',
      'Read the processor settlement statement showing gross receipts, withheld fees, refunds and reserves, and reconcile its net payout to the bank deposit.',89);
  for (const r of rows) if (r.direction==='inflow' && !['card','loan','line_of_credit'].includes(r.account_kind) &&
      ['card_payment','loan_payment'].includes(membership.get(r.id)?.money_kind) && !paired.has(r.id))
    confidence=limitMoneyConfidence(confidence,
      `Account ending ${r.account || '(unknown)'}: ${money(r.currency,r.amount_minor)} received on ${r.posted_on} is classified as a card or loan repayment without a proved owned paying counterpart; receipt membership remains unresolved.`,
      'Reconcile the receipt with the paying account and any principal, interest or merchant-sales evidence before excluding it from income or calling it an owner repayment.',89);
  const unpaired=rows.filter(r=>membership.get(r.id)?.money_kind==='own_transfer' && !paired.has(r.id));
  for (const currency of new Set(unpaired.map(r=>r.currency))) {
    const own=unpaired.filter(r=>r.currency===currency);
    confidence=limitMoneyConfidence(confidence,
      `${money(currency,own.reduce((n,r)=>n+r.amount_minor,0))} of excluded own-transfer postings have no proved equal-amount counterpart in the read; omitted fees or unmatched movements remain unresolved.`,
      'Reconcile both posted transfer legs, their amounts and any separately stated fee; an owned endpoint alone does not prove a completed matching movement.',89);
  }
  const byId=new Map(snapshot.rows.map(r=>[r.id,r]));
  const selectedIds=new Set(rows.map(r=>r.id));
  for (const p of snapshot.pairs || []) {
    const out=byId.get(p.out_id),incoming=byId.get(p.in_id);
    if (!p.proved || !out || !incoming || !selectedIds.has(out.id) && !selectedIds.has(incoming.id)) continue;
    const processor=/\b(stripe|square|paypal|shopify)\b/i.exec([incoming.payee,incoming.description].filter(Boolean).join(' '))?.[1];
    if (processor && !new RegExp(`\\b${processor}\\b`,'i').test([out.institution,out.account_label].filter(Boolean).join(' ')))
      confidence=limitMoneyConfidence(confidence,
        `${money(incoming.currency,incoming.amount_minor)} on ${incoming.posted_on} names a processor but is excluded as an own transfer without a matching processor-account endpoint.`,
        'Reconcile the processor payout report and the exact owned processor-account leg; bank transfer categories and equal amounts alone do not establish payout membership.',89);
    if (scope?.rowFilters?.money_kind && scope.rowFilters.money_kind.op!=='=' && scope.rowFilters.money_kind.value==='own_transfer' && out.side!==incoming.side)
      confidence=limitMoneyConfidence(confidence,
        `${money(incoming.currency,incoming.amount_minor)} of cash crosses recorded sides (${out.side} to ${incoming.side}) but the own-transfer filter excludes it from the reported cash movement.`,
        'Define the requested cash-account and business/personal boundary, and include transfers crossing that boundary before certifying cash flow.',89);
  }
  const unresolvedReturns=new Map();
  for (const r of rows) if (/\b(?:payment|pymt|pmt)\b/i.test(r.description || '') &&
      /\b(?:return(?:ed)?|reversal|reversed|nsf|insufficient)\b/i.test(r.description || '') && membership.get(r.id)?.money_kind!=='payment_reversal') {
    const k=JSON.stringify([r.tenant_id,r.account_slug,r.currency,r.direction]);
    const group=unresolvedReturns.get(k) || {...r,minor:0,from:r.posted_on,to:r.posted_on};
    group.minor+=r.amount_minor;group.from=group.from<r.posted_on?group.from:r.posted_on;group.to=group.to>r.posted_on?group.to:r.posted_on;
    unresolvedReturns.set(k,group);
  }
  for (const r of unresolvedReturns.values())
    confidence=limitMoneyConfidence(confidence,
      `Account ending ${r.account || '(unknown)'} has ${money(r.currency,r.minor)} ${r.direction} from ${r.from} through ${r.to} with unresolved payment-return membership; the SQL figure is retained.`,
      'Reconcile the returned or reversed payment with its unique original and both posted account legs before treating it as spending or a completed repayment.',89);
  // A recognized return can still leave interest, refunds, sales adjustments
  // or principal/payment contributions behind. Exact coverage cannot certify
  // that figure. Use the actual consumed original, never a second fuzzy match,
  // and inspect the all-history book before account/date/direction filtering.
  for (const d of decisions) if (d.reversal_contribution_gaps?.length) {
    const r=byId.get(d.id),original=byId.get(d.reversal_original_id);
    if (!r || !original || !selected(r) && !selected(original)) continue;
    const labels={paid_minor:'repayment',credited_minor:'principal/payment credit',debt_moved_minor:'debt movement',
      refund_minor:'refund',sales_adjust_minor:'sales adjustment',income_adjust_minor:'income adjustment',
      interest_stated_minor:'stated interest',interest_expense_minor:'interest expense',cross_side_minor:'cash crossing business/personal sides'};
    const disputed=d.reversal_contribution_gaps.map(g=>
      `${money(r.currency,Math.abs(g.residual_minor))} of ${labels[g.field] || g.field.replace(/_minor$/,'').replaceAll('_',' ')}`).join('; ');
    confidence=limitMoneyConfidence(confidence,
      `Account ending ${r.account || '(unknown)'}: the original on ${original.posted_on} and its matched return on ${r.posted_on} leave disputed signed contributions (${disputed}; each component is listed separately, not added together). The return does not negate the original contribution; the SQL figure is retained.`,
      'Obtain the account/lender statement and reconcile the unique original with its posted return, including each signed interest, refund, sales adjustment and principal/payment component.',89);
  }
  const selectedCoverage=scope ? snapshot.coverage.filter(c=>(!accountSlugs || accountSlugs.includes(c.account_slug)) && matches(c,scope)) : [];
  if (scope && !selectedCoverage.length)
    confidence=limitMoneyConfidence(confidence,
      'The literal account filters match no recorded account coverage; an empty SQL sum does not establish a complete zero.',
      'Confirm the exact account identity and supply its dated coverage and posted rows.',30);
  if (scope?.filters.account && new Set(selectedCoverage.map(c=>JSON.stringify([c.tenant_id,c.account_identity]))).size>1)
    confidence=limitMoneyConfidence(confidence,
      'The last-four filter matches multiple recorded account identities; the intended account is unresolved.',
      'Select the exact tenant and account_slug or owner-approved account_identity before attributing this figure to one account.',89);
  if (scope?.positiveContributions?.includes('income_minor') && rows.some(r=>(membership.get(r.id)?.income_adjust_minor || 0)<0))
    confidence=limitMoneyConfidence(confidence,
      'The positive income filter leaves out a signed income reversal in the requested period; the retained figure is gross positive income.',
      'Include signed income adjustments when answering net income and reconcile the reversal with its original deposit.',89);
  const scopedAccount=accountSlugs?.length || ['account','account_slug','account_identity'].some(k=>scope?.filters[k]);
  if (scopedAccount && projection.some(t=>['word','identifier'].includes(t.kind) && t.v==='paid_minor') &&
      rows.some(r=>r.direction==='inflow' && ['card_payment','loan_payment'].includes(membership.get(r.id)?.money_kind) && membership.get(r.id)?.paid_minor===0))
    confidence=limitMoneyConfidence(confidence,
      'This account selection contains a receiving payment leg whose paid contribution is counted on another account; the scoped payment sum may omit it.',
      'Reconcile the receiving account with its paying counterpart before attributing repayments to one card or loan.',89);
  const overlaps=moneyOverlapGroups(rows);
  if (!immaterialRisk && (overlaps.length || rows.some(r=>membership.get(r.id)?.estimated || membership.get(r.id)?.classification==='unknown')))
    confidence=limitMoneyConfidence(confidence,
      overlaps.length ? 'Possible duplicate or overlapping imports remain unresolved; the figure retains every counted posting.' : 'Some counted or excluded postings have unproved money membership.',
      overlaps.length ? 'Compare same-date, currency, direction and amount candidates with source statements, including imports with different descriptions, before proving they are distinct.' : 'Prove each flagged posting with source statements and owned counterpart or classification evidence.',89);
  for (const currency of new Set((immaterialRisk?[]:overlaps).map(group=>group[0].currency))) {
    const groups=overlaps.filter(group=>group[0].currency===currency);
    const minor=groups.reduce((n,group)=>n+group[0].amount_minor*(group.length-1),0);
    const dates=groups.flat().map(r=>r.posted_on).sort();
    confidence=limitMoneyConfidence(confidence,
      `${money(currency,minor)} may repeat postings from ${dates[0]} through ${dates.at(-1)} in accounts ending ${[...new Set(groups.flat().map(r=>r.account || '(unknown)'))].join(', ')}; the dollars remain counted.`,
      'Reconcile each overlapping source row to the original statement; matching amounts nominate duplicates but do not prove removal.',89);
  }
  const currencies=[...new Set(rows.map(r=>r.currency))].sort();
  if (currencies.length>1 && !scope?.currenciesSeparated) {
    const amounts=currencies.map(currency=>money(currency,rows.filter(r=>r.currency===currency).reduce((n,r)=>n+r.amount_minor,0)));
    confidence=limitMoneyConfidence(confidence,
      `The read contains multiple currencies without proved separate currency output: ${amounts.join('; ')}. A bare or literal currency label does not separate a sum.`,
      'Filter to one currency, or GROUP BY currency and return the actual currency column for every amount.',89);
  }
  // Inspect each aggregate's own argument. A diagnostic SUM of flagged dollars
  // must not turn an independent SUM(expense_minor) into a gross-movement sum.
  const gross=projection.some((t,index)=>{
    if (t.kind!=='word' || !['sum','total','avg'].includes(t.v) || projection[index+1]?.v!=='(') return false;
    let depth=1,end=index+2;
    for (;end<projection.length && depth;end++) {
      if (projection[end].v==='(') depth++;
      if (projection[end].v===')') depth--;
    }
    const argument=projection.slice(index+2,end-1);
    if (!argument.some(t=>['word','identifier'].includes(t.kind) && ['amount','amount_minor'].includes(t.v))) return false;
    const unqualified=argument.filter((t,i)=>argument[i+1]?.v!=='.' && t.v!=='.').map(t=>t.v).join(' ');
    if (/^case when (?:estimated|possible_transfer) = 1 then (?:amount|amount_minor) else 0 end$/.test(unqualified)) return false;
    // An explicit movement-kind contribution is already a named measure.
    if (/^case when money_kind = (?:payout|refund|card_payment|loan_payment|loan_proceeds|liability_credit)(?: and direction = (?:inflow|outflow))? then (?:amount|amount_minor) else 0 end$/.test(unqualified)) return false;
    return true;
  });
  if (scope && gross) {
    const groups=new Map();
    for (const r of rows) {
      const kind=membership.get(r.id)?.money_kind;
      if (!['own_transfer','card_payment','loan_payment'].includes(kind) ||
          scope.rowFilters?.money_kind?.op==='=' ||
          scope.rowFilters?.money_kind && scope.rowFilters.money_kind.value===kind) continue;
      const k=JSON.stringify([r.currency,r.direction,kind]);
      groups.set(k,(groups.get(k)||0)+r.amount_minor);
    }
    if (groups.size) {
      const detail=[...groups].sort(([a],[b])=>a.localeCompare(b)).map(([k,minor])=>{
        const [currency,direction,kind]=JSON.parse(k);
        return `${money(currency,minor)} ${direction} (${kind.replaceAll('_',' ')})`;
      }).join('; ');
      confidence=limitMoneyConfidence(confidence,
        `The gross amount includes ${detail}. These movements are not income or spending and repayments may repeat purchases. The SQL figure is retained.`,
        'Confirm whether the question asks for gross bank movement, income, spending or repayments; use the corresponding signed contribution column and disclose the included movements.',89);
    }
  }
  return confidence;
}

export function moneySqlUsesClock({tokens}) {
  for (let i=0;i<tokens.length;i++) {
    const t=tokens[i];
    if (t.kind==='word' && tokens[i-1]?.v!=='as' && ['current_date','current_time','current_timestamp'].includes(t.v)) return true;
    if (!['word','identifier'].includes(t.kind) || !['date','time','datetime','julianday','unixepoch','strftime'].includes(t.v) || tokens[i+1]?.v!=='(') continue;
    let depth=0, args=0;
    for (let j=i+2;j<tokens.length;j++) {
      const a=tokens[j];
      if (a.v===')' && depth===0) break;
      if (j===i+2 || a.v===',' && depth===0) args++;
      if (a.kind==='string' && ['now','subsec','subsecond'].includes(a.v)) return true;
      if (a.v==='(') depth++;
      if (a.v===')') depth--;
    }
    if (!args || t.v==='strftime' && args===1) return true;
  }
  return false;
}

export function confidenceAmountsSql(ctes, scope, binds) {
  const parameter = value => { binds.push(value); return '?' + binds.length; };
  const where = [`posted_on BETWEEN ${parameter(scope.from)} AND ${parameter(scope.to)}`,
    ...Object.entries(scope.filters || {}).map(([column, value]) => `${column}=${parameter(value)}`)].join(' AND ');
  const processor=scope.rowFilters?.processor?.value;
  const attribution=processor ? `WHEN (lower(COALESCE(description,'')) LIKE ${parameter('%'+processor+'%')} OR lower(COALESCE(payee,'')) LIKE ${parameter('%'+processor+'%')})
      AND COALESCE(processor,'')<>${parameter(processor)} THEN 'unproved processor attribution'` : '';
  return `WITH ${ctes} SELECT tenant_id,account_slug,currency,direction,
    CASE ${attribution} WHEN possible_transfer=1 THEN 'unproved transfer'
      WHEN estimated=1 AND (money_kind IN ('card_payment','loan_payment') OR uncertain_kind IN ('card_payment','loan_payment')) THEN 'possible card or loan payment'
      WHEN estimated=1 THEN 'guessed classification'
      WHEN basis_state<>'confirmed' THEN 'unconfirmed amount' ELSE 'proved' END AS kind,
    MIN(posted_on) AS from_date,MAX(posted_on) AS to_date,SUM(ABS(amount_minor)) AS amount_minor,count(*) AS row_count
    FROM txn WHERE ${where} GROUP BY tenant_id,account_slug,currency,direction,kind
    ORDER BY tenant_id,account_slug,currency,direction,kind`;
}

export function moneyDiscoveryGaps(unassigned, scope) {
  const gaps = [];
  let count = 0;
  if (!scope.filters?.account_slug) for (const a of unassigned || []) {
    if (scope.filters?.tenant_id && scope.filters.tenant_id !== a.tenant_id) continue;
    count += a.account_count;
    gaps.push({
      reason: `${a.account_count} discovered feed accounts have no current ledger account; their coverage and dollar impact are unknown.`,
      missing: `${a.account_count} discovered accounts: record their last four, confirm the owner assignment and connect complete history for ${scope.from} through ${scope.to}.`,
    });
    if (a.provider_conflict_count) gaps.push({
      reason: `${a.provider_conflict_count} discovered feed accounts have a provider conflict between their assignment and Item; their coverage and dollar impact are unknown.`,
      missing: 'Verify the provider and Item for the discovered accounts before using their feed evidence.',
    });
  }
  return { count, gaps };
}

export function scoreMoneyConfidence({ accounts, coverage, amounts, pending, unassigned, scope, instant, timeZone, truncated = false, historyRows=[], pendingRequested=false,immaterialRisk=false }) {
  if (!scope) return { level: 'Low', percent: truncated ? 20 : 40,
    reasons: ['The query period and account scope are not proved by a simple literal-bounded clean transaction selection.' + (truncated ? ' Returned rows are truncated.' : '')],
    missing: ['Prove the requested period and account scope using confirmed coverage and a clean txn selection with literal posted_on BETWEEN dates and AND-only account filters. Review raw lifecycle states, duplicate feeds and document evidence separately.'] };
  if (!Array.isArray(accounts) || accounts.length > 1000 || !Array.isArray(amounts) || !dateValue(scope.from) || !dateValue(scope.to) || !Number.isFinite(instant))
    return unknownMoneyConfidence();
  const discovery = moneyDiscoveryGaps(unassigned, scope);
  const inventory = accounts.filter(a => matches(a, scope));
  if (!inventory.length) return discovery.gaps.reduce((confidence, { reason, missing }) => limitMoneyConfidence(confidence, reason, missing),
    unknownMoneyConfidence('No needed accounts are verified in the recorded inventory.', 'Record and connect the needed accounts, with last four and confirmed coverage for ' + scope.from + ' through ' + scope.to + '. Missing dollar impact is unknown.'));
  const selected = inventory.filter(a => (!moneyAccountStart(a) || moneyAccountStart(a) <= scope.to) && (!dateValue(a.closed_on) || a.closed_on >= scope.from));
  let score = 100, ceiling = 100, missingAccounts = 0, missingDays = 0, totalDays = 0;
  const reasons = [], missing = [];
  const lower = (cap, reason, fix) => { ceiling = Math.min(ceiling, cap); reasons.push(reason); missing.push(fix); };
  // A period wholly outside every recorded account's life has no covering
  // history at all. An empty or zero sum there is not a proved zero.
  if (!selected.length) {
    const starts = inventory.map(a => moneyAccountStart(a)).filter(dateValue).sort();
    lower(30, `No recorded account was open between ${scope.from} and ${scope.to}${starts.length ? ` (the earliest recorded account starts ${starts[0]})` : ''}; the figure does not show what happened in that period.`,
      `Record and connect the accounts held between ${scope.from} and ${scope.to}, or supply their statements; missing dollar impact is unknown.`);
  }
  if (scope.filters?.account && inventory.length>1) lower(89,
    `The last-four filter matches ${inventory.length} recorded accounts; the intended account is unresolved.`,
    'Select the exact tenant and account_slug or the owner-approved account_identity before attributing this figure to one account.');
  let calendar;
  try { calendar = new Intl.DateTimeFormat('en-US', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch { calendar = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }); }
  const parts = Object.fromEntries(calendar.formatToParts(instant).map(p => [p.type, p.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  for (const a of selected) {
    const label = identity(a);
    const affected=(a.replacement_review_values || []).filter(row=>!dateValue(row.date) || row.date>=scope.from && row.date<=scope.to);
    if(affected.length || a.replacement_review_from && a.replacement_review_from<=scope.to) {
      const values=affected.map(row=>Number.isSafeInteger(row.amount) && row.amount>=0 && /^[A-Z]{3}$/.test(row.currency) && ['inflow','outflow'].includes(row.direction)
        ? `${row.phase==='saved'?'Saved':'Incoming'} occurrence: ${money(row.currency,row.amount)} ${row.direction} on ${dateValue(row.date)?row.date:'an unknown date'}.`
        : 'A correction has unknown affected dates or dollars.');
      lower(69,`${label} has replacement activity awaiting review. ${[...new Set(values)].join(' ')} Saved and incoming values are alternatives pending reconciliation, not amounts to add together. Missing or possibly duplicated dollar impact remains unresolved.`,
        `${label}: reconcile the saved and incoming occurrences, withdrawals, account mapping and complete statement coverage for ${scope.from} through ${scope.to}; unknown dates or dollars need the original statement.`);
    }
    const accountStart = moneyAccountStart(a);
    const from = accountStart && accountStart > scope.from ? accountStart : scope.from;
    const to = dateValue(a.closed_on) && a.closed_on < scope.to ? a.closed_on : scope.to;
    const completeStatement=a.feed_mode==='manual' && a.coverage_confirmed===1 &&
      dateValue(a.covered_from) && dateValue(a.covered_to) && a.covered_from<=from && a.covered_to>=to && to<=today;
    totalDays += days(from, to);
    if (a.connected !== 1 && !completeStatement) {
      missingAccounts++;
      lower(69, `${label} is not connected for the needed period ${from} through ${to}; missing dollar impact is unknown.`,
        `${label}: connect the account and supply complete statements or confirmed feed history for ${from} through ${to}.`);
    }
    const coveredTo = a.covered_to > today ? today : a.covered_to;
    const intervals=Array.isArray(a.replacement_intervals) ? a.replacement_intervals.map(i=>({...i,to:i.to>today?today:i.to})) : [];
    if(a.coverage_confirmed && dateValue(a.covered_from) && dateValue(coveredTo) && a.covered_from<=coveredTo)
      intervals.push({from:a.covered_from,to:coveredTo});
    const gaps=bankCoverageGaps(from,to,intervals);
    for (const [start, end] of gaps) {
      const n = days(start, end); missingDays += n;
      const lateStart = a.coverage_confirmed && dateValue(a.covered_from) && from < a.covered_from && start === from;
      lower(a.replacement_intervals?.length ? 69 : 89, `${label}${lateStart ? `: bank history only starts ${a.covered_from}; it` : ''} has ${n} days without confirmed complete coverage: ${start} through ${end}; missing dollar impact is unknown.`,
        `${label}: ${start} through ${end} (${n} days). Supply complete statements or successfully synced history and confirm these coverage dates.`);
    }
    // Confirmed history can cover the period even when its sync receipt fails the clock check.
    const sync = verifiedMoneySyncInstant(a.last_sync, instant);
    if (!completeStatement && sync === null) {
      lower(69, `${label} has no verified successful sync time at this evidence instant.`, `${label}: record a successful feed sync with a valid completed timestamp; assignment observations are insufficient.`);
    } else if (!completeStatement && instant - sync > 2 * DAY && a.last_sync.slice(0,10)<to) {
      const age = Math.floor((instant - sync) / DAY);
      score -= Math.min(30, Math.ceil((instant - sync) / DAY) * 2);
      lower(89, `${label} has a stale feed: last successful sync ${a.last_sync} (${age} full days old).`,
        `${label}: complete a new successful feed sync and verify history for ${from} through ${to}.`);
    }
    const c = coverage?.find(c => key(c) === key(a));
    const holes=completeStatement?[]:historyHoles(historyRows,a,scope);
    for(const h of holes)lower(89,`${label}: possible feed hole ${h.from} through ${h.to} in a busy account; $0 quantified; amount unknown.`,
      `${label}: complete statements or a bank history reconciliation for ${h.from} through ${h.to}.`);
    if(pendingRequested && c?.feed_kind==='simplefin')lower(69,`${label}: pending not collected; amount unknown.`,`${label}: current bank pending entries or a feed that collects pending transactions.`);
    if (!c) lower(69, `${label} clean coverage could not be matched to the inventory.`, `${label}: read matching clean account coverage and supporting rows.`);
    else for (const [field, detail, fix] of [
      ['unreadable_rows', 'unreadable rows', 'correct the amounts, directions and dates against the source statement'],
      ['possible_duplicate_count', 'possible duplicate rows', 'compare source statements and confirm same-account feed links'],
    ]) if (c[field] > 0) lower(field === 'unreadable_rows' ? 69 : 89,
      `${label} has ${c[field]} ${detail} in its read history; their period and dollar impact are unknown.`, `${label}: ${fix} before certifying the requested period.`);
  }
  const unknownAccounts = discovery.count;
  for (const { reason, missing } of discovery.gaps) lower(69, reason, missing);
  score -= Math.ceil(40 * (missingAccounts + unknownAccounts) / Math.max(1, selected.length + unknownAccounts));
  if (totalDays) score -= Math.ceil(40 * missingDays / totalDays);
  const byAccount = new Map(selected.map(a => [key(a), a]));
  const groups = amounts.filter(a => byAccount.has(key(a)));
  const currencies = [...new Set([...selected, ...groups].map(a => a.currency))].sort();
  if (currencies.length > 1 && !scope.currenciesSeparated) lower(89,
    `The result has multiple currencies (${currencies.join(', ')}) without proved separate currency output.`,
    'Group and return currency separately, or filter to one currency. Do not interpret a mixed-currency sum as one money figure.');
  // One shared pending projection: the period plus its six-day lead, with
  // account details merged before matching and stale holds named separately.
  for (const p of pendingInScope(pending,scope)) if (byAccount.has(key(p)) && matches({...byAccount.get(key(p)),...p}, scope) &&
    (!scope.filters?.direction || p.direction === scope.filters.direction))
    groups.push({ ...p, kind: p.posted_on && p.posted_on<shift(today,-14)?'stale pending hold; status unknown':'pending row excluded', from_date: p.posted_on, to_date: p.posted_on });
  // Never net inflow against outflow, or mix currencies to dilute uncertainty.
  // Each row belongs to one reason bucket, even if several flags apply.
  const totals = new Map(), uncertain = new Map();
  for (const a of groups) {
    const amount = a.amount_minor;
    if (!Number.isSafeInteger(amount) || amount < 0) {
      lower(69, `${identity(byAccount.get(key(a)))} has an uncertain dollar amount.`, 'Read the original statement amount and resolve unreadable or unsafe numeric values.'); continue;
    }
    const bucket = JSON.stringify([a.currency, a.direction]);
    totals.set(bucket, (totals.get(bucket) || 0) + amount);
    if (a.kind !== 'proved') {
      uncertain.set(bucket, (uncertain.get(bucket) || 0) + amount);
      const detail = `${a.kind}: ${money(a.currency, amount)} (${a.direction}), ${a.from_date} through ${a.to_date}`;
      const label = identity(byAccount.get(key(a)));
      lower(immaterialRisk && !/pending/.test(a.kind)?95:89, `${label} has ${detail}.`, `${label}: resolve ${detail} with posted statement rows, a proved owned counterpart for transfers/payments, or confirmed classification evidence.`);
    }
  }
  const share = Math.max(0, ...[...uncertain].map(([bucket, amount]) => totals.get(bucket) ? amount / totals.get(bucket) : 0));
  if(!immaterialRisk)score -= Math.ceil(45 * share);
  if (truncated || scope.bounded) lower(69, 'A row limit or bounded output window may omit supporting amounts.', 'Remove SQL LIMIT/OFFSET and page the complete ordered supporting rows, or aggregate the complete requested period in SQL.');
  const percent = Math.max(0, Math.min(ceiling, score));
  return { level: percent >= 90 ? 'High' : percent >= 70 ? 'Medium' : 'Low', percent, reasons, missing };
}

export function paymentEvidenceConfidence(confidence, evidence, accounts, transactions) {
  if (evidence === undefined || Array.isArray(evidence) && evidence.length === 0) return confidence;
  const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value);
  const valid = p => p && typeof p === 'object' && !Array.isArray(p) && text(p.source_ref) && dateValue(p.paid_on) &&
    Number.isSafeInteger(p.amount_minor) && p.amount_minor > 0 && typeof p.currency === 'string' && /^[A-Z]{3}$/.test(p.currency) &&
    ['inflow','outflow'].includes(p.direction) && (p.account_last4 === undefined || typeof p.account_last4 === 'string' && /^\d{4}$/.test(p.account_last4)) &&
    (p.account_name === undefined || text(p.account_name)) && (p.tenant_id === undefined || text(p.tenant_id));
  if (!Array.isArray(evidence) || evidence.length > 20 || !evidence.every(valid)) return limitMoneyConfidence(confidence,
    'Document payment evidence has an invalid or incomplete date, amount, currency, direction or source reference.',
    'Read the payment document and supply its exact payment date, positive integer minor-unit amount, currency, direction and citation; name the paying account or card when recorded.', 0);
  for (const p of evidence) {
    const tenant = p.tenant_id || 'primary';
    const connected = new Set(accounts.filter(a => a.tenant_id === tenant && a.connected === 1 &&
      (!p.account_last4 || a.last4 === p.account_last4) && (!moneyAccountStart(a) || moneyAccountStart(a) <= p.paid_on) &&
      (!dateValue(a.closed_on) || a.closed_on >= p.paid_on)).map(key));
    const matches = transactions.filter(row => connected.has(key(row)) && row.posted_on === p.paid_on &&
      row.amount_minor === p.amount_minor && row.currency === p.currency && row.direction === p.direction);
    const named = [p.account_name, p.account_last4 ? `account or card ending ${p.account_last4}` : null].filter(Boolean).join(', ');
    const detail = `${money(p.currency, p.amount_minor)} (${p.direction}) on ${p.paid_on}; source ${JSON.stringify(p.source_ref)}`;
    // Caller-supplied document facts can only lower a bank score. Date/amount
    // equality is a reconciliation candidate, never proof of payment identity.
    confidence = matches.length ? limitMoneyConfidence(confidence,
      `Document payment ${detail} has ${matches.length} matching connected-account row candidates; exact payment identity is not reconciled.`,
      `Reconcile the cited document payment with its exact posted bank reference${named ? ` for ${named}` : ''}; equal dates and amounts alone are insufficient.`, 89) :
      limitMoneyConfidence(confidence,
        `Document payment ${detail}: this payment came from an account or card that is not connected${named ? ` (document names ${named})` : ''}.`,
        `${named || 'The account or card used for this payment'}: identify and connect the paying account or card, then reconcile its statement payment of ${detail}.`, 69);
  }
  return confidence;
}
