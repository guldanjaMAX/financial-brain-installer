import { moneyMinorSql } from './money-format.js';
import { MONEY_KIND_DOUBTS } from './clean-money-evidence.js';
import { coverageInPeriod } from './clean-money-period.js';
import { moneyMovementReading, moneyProcessor, cleanPairEvidence, loanCardPaymentAccount, possibleOwnedMovement, unresolvedMovementFee, normalizeLedgerText, normalizeMerchantText, reversalForm, LEGACY_PAYMENT_REVERSAL, EXPENSE_CATEGORY_WORDS, PAYMENT_EXPENSE_DESCRIPTIONS } from './money-analysis.js';
import { markFeedDuplicates } from './clean-money-duplicates.js';
import { historyCoverageStartSql } from './money-history.js';
import { accountKindReviewSql, applyAccountKindReview } from './fin-account-kinds.js';
import { cleanMoneyContributions, CONTRIBUTION_FIELDS } from './clean-money-contributions.js';
import { matchPlatformReserves } from './money-platform.js';
import { refineTransferPairs, processorSweepEstimates } from './clean-money-transfers.js';
import { refineLoanDrawPairs, loanDrawReading } from './clean-money-loan-proceeds.js';
import { PLAID_LEDGER_REFERENCE_SQL, SIMPLEFIN_LEDGER_REFERENCE_SQL } from './money-feed-assignment.js';

// Request-local definitions shared by the money route and available to other
// SQL readers. Nothing creates a stored view or changes owner truth.
export const CLEAN_MONEY_VIEWS = Object.freeze(['txn', 'coverage', 'transfer_pairs']);

// Must match accountLinkIdentity in fin-account-links.js. The parity fixture
// constructs approvals through that function, including all nullable fields.
const snapshot = a => `json_array(${['id', 'account_slug', 'entity_slug', 'mask', 'account_kind',
  'institution', 'currency', 'balance_role', 'feed_mode', 'external_ref', 'source_feed'].map(k => `${a}.${k}`).join(',')})`;
const validCoverage = `c.coverage_status='complete' AND c.basis_state='confirmed'
  AND c.covered_from IS NOT NULL AND c.covered_to IS NOT NULL
  AND date(c.covered_from,'+0 days')=c.covered_from AND date(c.covered_to,'+0 days')=c.covered_to
  AND c.covered_from<=c.covered_to
  AND COALESCE(c.basis_note,'') NOT LIKE 'Read from a bank export covering %'`;

// Remove only locator/channel syntax; digit boundaries and the entire directed
// shape are checked below. A bare amount or a longer account number is no proof.
function memoSql(column) {
  let sql = `lower(COALESCE(${column},''))`;
  for (const [from, to] of [['*', 'x'], ['•', 'x'], ['account ', ''], ['acct ', ''], ['ending in ', ''],
    ['ending ', ''], ['online ', ''], ['internet ', ''], ['mobile ', ''], ['automatic ', ''], ['x', '']])
    sql = `replace(${sql},'${from}','${to}')`;
  for (let n = 0; n < 3; n++) sql = `replace(${sql},'  ',' ')`;
  return `trim(${sql})`;
}
const directedMemo = (row, from, to, direction) => `(${row}.memo='transfer from '||${from}.account||' to '||${to}.account
  OR ${row}.memo='transfer ${direction} '||${direction === 'to' ? to : from}.account)`;
const transferCategory = row => `(${row}.category_basis_state='confirmed' OR ${row}.provenance='feed') AND
  upper(COALESCE(${row}.category,'')) IN ('TRANSFER','INTERNAL_TRANSFER','BANK_TRANSFER',
    'TRANSFER_${row === 'o' ? 'OUT' : 'IN'}','TRANSFER_${row === 'o' ? 'OUT' : 'IN'}_ACCOUNT_TRANSFER')`;
const supportedPayee = (row, other) => `lower(trim(COALESCE(${row}.payee,''))) IN
  ('','transfer','online transfer','internet transfer','mobile transfer','automatic transfer',
   'card payment','credit card payment','loan payment','payment thank you',
   lower(COALESCE(${other}.account_label,'')),lower(COALESCE(${other}.institution,'')))`;
const words = row => `(' '||lower(replace(COALESCE(${row}.category,'')||' '||COALESCE(${row}.description,''),'_',' '))||' ')`;
const categoryTokens = row => ['_', '/', '-', '.', ','].reduce((sql,c)=>`replace(${sql},'${c}',' ')`,`lower(COALESCE(${row}.category,''))`);
const expenseSql = row => EXPENSE_CATEGORY_WORDS
  .map(word => `(' '||${categoryTokens(row)}||' ') GLOB '* ${word} *'`).join(' OR ') +
  ` OR (${row}.direction='outflow' AND ${row}.memo IN (${PAYMENT_EXPENSE_DESCRIPTIONS.map(text => `'${text}'`).join(',')}))`;
const outsideMoney = row => ['refund', 'refunds', 'refunded', 'reversal', 'reversals', 'reversed', 'chargeback', 'chargebacks', 'dispute', 'return', 'returned', 'reimbursement', 'invoice', 'customer', 'client', 'revenue', 'sale', 'sales']
  .map(word => `${words(row)} GLOB '* ${word} *'`).join(' OR ');
// Legacy coded-sweep candidate evidence only. Public identity is frozen once
// by moneyProcessor; SQL never decides the public processor or payer group.
const processorSql = row => `CASE ${['stripe', 'square', 'paypal', 'shopify'].map(name =>
  `WHEN lower(trim(replace(replace(COALESCE(${row}.payee,''),',',''),'.',''))) IN ('${name}','${name} inc','${name} payments')
    OR lower(trim(COALESCE(${row}.description,'')))='${name} payout'
    OR lower(trim(COALESCE(${row}.description,'')))='${name} transfer'
    OR lower(trim(COALESCE(${row}.description,'')))='transfer from ${name}'
    OR lower(COALESCE(${row}.description,'')) GLOB '${name} payout *'
    OR lower(COALESCE(${row}.description,'')) GLOB '${name} transfer *' THEN '${name}'`).join(' ')} END`;
// A bank category cannot turn a named outside payment into an owned movement.
const transferLeg = row => `((${transferCategory(row)}) OR ${row}.memo='transfer' OR ${row}.memo GLOB 'transfer *')`;
const outsideRail = row => ['zelle', 'venmo', 'cash app', 'payroll', 'wire', 'check']
  .map(word => `${words(row)} GLOB '* ${word} *'`).join(' OR ');
export function cleanMoneyCtes(window = null, frozenMembership = false) {
  const within = alias => window ? `${alias}.posted_on BETWEEN '${window.from}' AND '${window.through}'` : '1';
  const membership = name => frozenMembership ? `t.mq_${name}` : `m.${name}`;
  return `mq_base_accounts AS MATERIALIZED (
  -- Masks and kinds describe accounts; only a current owner-approved link
  -- authorizes suppressing another account's overlapping rows.
  SELECT a.*,e.kind AS entity_kind,e.relationship,e.basis_state AS entity_basis,
    CASE WHEN e.kind IN ('person','household') THEN 'personal'
      WHEN e.kind IN ('business','property') THEN 'business' ELSE 'unassigned' END AS side,
    json_array(a.tenant_id,'account',a.account_slug) AS base_identity
  FROM fin_accounts a LEFT JOIN fin_entities e ON e.tenant_id=a.tenant_id
    AND e.entity_slug=a.entity_slug AND e.superseded_by_id IS NULL
  WHERE a.superseded_by_id IS NULL
), mq_links AS MATERIALIZED (
  SELECT l.tenant_id,l.manual_account_slug,l.live_account_slug,json_array(v.tenant_id,'account',v.account_slug) AS account_identity
  FROM fin_account_links l JOIN fin_accounts m ON m.tenant_id=l.tenant_id AND m.account_slug=l.manual_account_slug
  JOIN fin_accounts v ON v.tenant_id=l.tenant_id AND v.account_slug=l.live_account_slug
  JOIN fin_entities e ON e.tenant_id=m.tenant_id AND e.entity_slug=m.entity_slug AND e.superseded_by_id IS NULL
  WHERE l.unlinked_at IS NULL AND m.feed_mode='manual' AND v.feed_mode='live'
    AND m.superseded_by_id IS NULL AND v.superseded_by_id IS NULL
    AND m.basis_state='confirmed' AND v.basis_state='confirmed'
    AND e.relationship='owned' AND e.basis_state='confirmed'
    AND m.currency=v.currency AND m.entity_slug=v.entity_slug AND m.balance_role=v.balance_role
    AND l.identity_json=json_array(${snapshot('m')},${snapshot('v')})
), mq_accounts AS MATERIALIZED (
  SELECT a.*,COALESCE(l.account_identity,a.base_identity) AS account_identity,
    CASE WHEN l.account_identity IS NOT NULL THEN 'owner_link'
      WHEN EXISTS(SELECT 1 FROM fin_account_links stale WHERE stale.tenant_id=a.tenant_id AND stale.unlinked_at IS NULL
        AND (stale.manual_account_slug=a.account_slug OR stale.live_account_slug=a.account_slug)) THEN 'stale_link'
      ELSE 'separate_account' END AS identity_basis
  FROM mq_base_accounts a LEFT JOIN mq_links l ON l.tenant_id=a.tenant_id
    AND (l.manual_account_slug=a.account_slug OR l.live_account_slug=a.account_slug)
), mq_posted AS MATERIALIZED (
  SELECT t.*,a.account_identity,a.mask AS account,a.label AS account_label,
    a.institution,a.account_kind,a.basis_state AS account_basis,a.entity_slug AS entity,a.relationship,a.entity_basis,a.side,a.identity_basis,
    a.opened_on,a.closed_on,a.status AS account_status,a.feed_mode
  FROM fin_transactions t JOIN mq_accounts a
    ON a.tenant_id=t.tenant_id AND a.account_slug=t.account_slug
  WHERE t.removed_at IS NULL AND t.superseded_by_id IS NULL AND t.pending=0
), mq_pending AS MATERIALIZED (
  SELECT t.* FROM fin_transactions t JOIN fin_accounts a
    ON a.tenant_id=t.tenant_id AND a.account_slug=t.account_slug
  WHERE a.superseded_by_id IS NULL AND t.removed_at IS NULL AND t.superseded_by_id IS NULL AND t.pending=1
    AND NOT EXISTS(SELECT 1 FROM main.fin_transactions p WHERE p.removed_at IS NULL AND p.superseded_by_id IS NULL AND p.pending=0 AND p.tenant_id=t.tenant_id AND p.account_slug=t.account_slug
      AND p.source_provider IS t.source_provider AND t.external_id IS NOT NULL
      AND p.pending_transaction_id=t.external_id)
), mq_history AS MATERIALIZED (
  -- Feed edges and coverage describe the whole history, even when pairing
  -- uses an indexed period plus its six-day uniqueness margin.
  SELECT tenant_id,account_slug,
    MIN(CASE WHEN ok THEN posted_on END) AS first_posted,MAX(CASE WHEN ok THEN posted_on END) AS last_posted,
    count(*) AS raw_row_count,total(NOT ok) AS unreadable_rows,total(basis_state<>'confirmed') AS unconfirmed_rows
  FROM (SELECT tenant_id,account_slug,posted_on,basis_state,
    (amount_minor IS NOT NULL AND direction IS NOT NULL AND date(posted_on,'+0 days') IS posted_on AND posted_on IS NOT NULL) AS ok
    FROM main.fin_transactions WHERE removed_at IS NULL AND superseded_by_id IS NULL AND pending=0)
  GROUP BY tenant_id,account_slug
), mq_ranges AS MATERIALIZED (
  SELECT a.tenant_id,a.account_slug,a.account_identity,a.feed_mode,
    CASE WHEN ${validCoverage} THEN c.covered_from ELSE h.first_posted END AS first_posted,
    CASE WHEN ${validCoverage} THEN c.covered_to ELSE h.last_posted END AS last_posted,
    COALESCE((${validCoverage}),0) AS verified
  FROM mq_accounts a LEFT JOIN mq_history h ON h.tenant_id=a.tenant_id AND h.account_slug=a.account_slug
  LEFT JOIN fin_account_coverage c ON c.tenant_id=a.tenant_id AND c.account_slug=a.account_slug AND c.superseded_by_id IS NULL
  GROUP BY a.tenant_id,a.account_slug
), mq_duplicate_rows AS MATERIALIZED (
  -- Distinct nonempty account groups have different min/max slugs. One scan
  -- also avoids expanding the posting CTE twice when compiling coverage.
  SELECT tenant_id,account_slug,posted_on,
    min(account_slug) OVER duplicates <> max(account_slug) OVER duplicates AS possible_duplicate
  FROM mq_posted
  WHERE posted_on IS NOT NULL AND amount_minor IS NOT NULL AND direction IS NOT NULL AND currency IS NOT NULL
  WINDOW duplicates AS (PARTITION BY tenant_id,posted_on,amount_minor,direction,currency)
), mq_decisions AS MATERIALIZED (
  -- Both flags use the same overlapping peers. Expanding that account-range
  -- lookup twice for each snapshot branch can exceed SQLite's cursor limit.
  SELECT t.*,own.first_posted AS effective_from,own.last_posted AS effective_to,own.verified AS coverage_verified,
    (SELECT json_object('source_duplicate',COALESCE(max(other.feed_mode='live' AND own.feed_mode<>'live'
          OR other.feed_mode=own.feed_mode AND (other.first_posted>own.first_posted
            OR other.first_posted=own.first_posted AND other.account_slug<own.account_slug)),0),
        'manual_peer',COALESCE(max(other.feed_mode<>'live'),0))
      FROM mq_ranges other WHERE other.account_identity=t.account_identity
        AND other.account_slug<>t.account_slug AND t.posted_on BETWEEN other.first_posted AND other.last_posted
    ) AS precedence
  FROM mq_posted t JOIN mq_ranges own ON own.tenant_id=t.tenant_id AND own.account_slug=t.account_slug
), mq_row_status AS MATERIALIZED (
  -- Keep the dollars behind every lifecycle/coverage refusal. A smaller clean
  -- total is not evidence that those posted rows had no financial impact.
  SELECT t.*,CASE WHEN json_extract(t.precedence,'$.source_duplicate')=1 THEN 'duplicate_feed'
    WHEN t.opened_on IS NOT NULL AND t.posted_on<t.opened_on THEN 'before_opened'
    WHEN t.closed_on IS NOT NULL AND t.posted_on>t.closed_on THEN 'after_closed'
    WHEN t.account_status='closed' AND t.closed_on IS NULL THEN 'closed_without_date'
    WHEN t.feed_mode='live' AND t.posted_on NOT BETWEEN t.effective_from AND t.effective_to THEN 'outside_confirmed_coverage'
    END AS reason,
    CASE WHEN json_extract(t.precedence,'$.source_duplicate')=0 AND
      (t.feed_mode<>'live' OR t.identity_basis<>'owner_link' OR t.posted_on BETWEEN t.effective_from AND t.effective_to
        OR json_extract(t.precedence,'$.manual_peer')=0)
    THEN 1 ELSE 0 END AS kept
  FROM mq_decisions t
  WHERE t.amount_minor IS NOT NULL AND t.direction IS NOT NULL AND date(t.posted_on,'+0 days')=t.posted_on
), mq_kept AS MATERIALIZED (
  SELECT * FROM mq_row_status WHERE kept
), mq_rows AS MATERIALIZED (
  SELECT t.*,${moneyMinorSql('t.amount_minor', 't.currency')} AS amount,
    CASE WHEN t.feed_mode='live' THEN COALESCE(t.source_provider,'live') ELSE 'import' END AS feed_kind,
    ${memoSql('t.description')} AS memo
  FROM mq_kept t
), mq_out AS MATERIALIZED (SELECT * FROM mq_rows WHERE direction='outflow'),
mq_in AS MATERIALIZED (SELECT * FROM mq_rows WHERE direction='inflow'), mq_candidates AS (
  SELECT o.id AS out_id,i.id AS in_id,o.tenant_id,o.amount_minor,o.currency,
    o.posted_on AS out_date,i.posted_on AS in_date,
    o.account_identity AS out_account_identity,i.account_identity AS in_account_identity,
    o.account_kind AS out_kind,i.account_kind AS in_kind,
    count(*) OVER (PARTITION BY o.id) AS out_matches,count(*) OVER (PARTITION BY i.id) AS in_matches,
    CASE WHEN o.relationship='owned' AND i.relationship='owned' AND o.entity_basis='confirmed' AND i.entity_basis='confirmed'
      AND o.basis_state='confirmed' AND i.basis_state='confirmed' AND o.account_basis='confirmed' AND i.account_basis='confirmed'
      AND o.account_kind IN ('merchant','point_of_sale') AND i.account_kind IN ('checking','savings') AND o.entity=i.entity
      AND (${transferCategory('o')}) AND (${transferCategory('i')})
      AND ${processorSql('o')} IS NOT NULL AND ${processorSql('o')}=${processorSql('i')}
      AND NOT (${expenseSql('o')}) AND NOT (${expenseSql('i')})
      AND NOT (${outsideMoney('o')}) AND NOT (${outsideMoney('i')}) THEN 'processor_sweep'
    WHEN o.relationship='owned' AND i.relationship='owned' AND o.entity_basis='confirmed' AND i.entity_basis='confirmed'
      AND o.basis_state='confirmed' AND i.basis_state='confirmed' AND o.account_basis='confirmed' AND i.account_basis='confirmed'
      AND ${supportedPayee('o', 'i')} AND ${supportedPayee('i', 'o')}
      AND NOT (${expenseSql('o')}) AND NOT (${expenseSql('i')})
      AND NOT (${outsideMoney('o')}) AND NOT (${outsideMoney('i')})
      AND (o.memo NOT GLOB 'transfer *' OR ${directedMemo('o', 'o', 'i', 'to')})
      AND (i.memo NOT GLOB 'transfer *' OR ${directedMemo('i', 'o', 'i', 'from')})
      THEN CASE WHEN ((${transferCategory('o')}) OR (${transferCategory('i')}))
          AND ${transferLeg('o')} AND ${transferLeg('i')}
          AND NOT (${outsideRail('o')}) AND NOT (${outsideRail('i')}) THEN 'bank_category'
        WHEN o.account GLOB '[0-9][0-9][0-9][0-9]' AND i.account GLOB '[0-9][0-9][0-9][0-9]'
          AND (SELECT count(DISTINCT account_identity) FROM mq_accounts a WHERE a.tenant_id=o.tenant_id AND a.mask=o.account)=1
          AND (SELECT count(DISTINCT account_identity) FROM mq_accounts a WHERE a.tenant_id=i.tenant_id AND a.mask=i.account)=1
          AND (${directedMemo('o', 'o', 'i', 'to')} OR ${directedMemo('i', 'o', 'i', 'from')})
        THEN 'counterpart_memo' END END AS evidence
  FROM mq_out o JOIN mq_in i ON o.direction='outflow' AND i.direction='inflow'
    AND o.tenant_id=i.tenant_id AND o.amount_minor>0 AND o.amount_minor=i.amount_minor AND o.currency=i.currency
    AND o.account_identity<>i.account_identity
    AND abs(julianday(o.posted_on)-julianday(i.posted_on))<=3
), mq_pairs_all AS MATERIALIZED (
  SELECT *, (out_matches=1 AND in_matches=1) AS unique_match,
    (out_matches=1 AND in_matches=1 AND evidence IS NOT NULL) AS proved FROM mq_candidates
), mq_pair_ends AS MATERIALIZED (
  SELECT out_id AS id,proved,evidence FROM mq_pairs_all
  UNION ALL SELECT in_id,proved,evidence FROM mq_pairs_all
), mq_pair_flags AS MATERIALIZED (
  -- Aggregate endpoints once; scanning all candidate pairs for each row is quadratic.
  SELECT id,max(proved=0) AS possible_transfer,
    max(CASE WHEN proved=1 THEN evidence END) AS transfer_basis
  FROM mq_pair_ends GROUP BY id
), mq_coverage_rows AS MATERIALIZED (
  SELECT t.tenant_id,t.account_slug,
    min(CASE WHEN ${within('t')} THEN t.posted_on END) AS first_row,
    max(CASE WHEN ${within('t')} THEN t.posted_on END) AS last_row,
    count(CASE WHEN ${within('t')} THEN 1 END) AS row_count,
    count(CASE WHEN t.posted_on<t.opened_on OR t.posted_on>t.closed_on OR t.account_status='closed' AND t.closed_on IS NULL
      OR t.coverage_verified AND t.posted_on NOT BETWEEN t.effective_from AND t.effective_to THEN 1 END) AS rows_outside_account_dates
  FROM mq_kept t GROUP BY t.tenant_id,t.account_slug
), mq_coverage_pending AS MATERIALIZED (
  SELECT tenant_id,account_slug,count(*) AS pending_rows,min(posted_on) AS pending_oldest_on,
    sum(CASE WHEN direction='inflow' THEN amount_minor END) AS pending_in_minor,
    sum(CASE WHEN direction='outflow' THEN amount_minor END) AS pending_out_minor
  FROM mq_pending GROUP BY tenant_id,account_slug
), mq_coverage_excluded AS MATERIALIZED (
  SELECT t.tenant_id,t.account_slug,
    count(CASE WHEN t.reason='duplicate_feed' AND ${within('t')} THEN 1 END) AS duplicate_rows_removed,
    count(CASE WHEN t.reason<>'duplicate_feed' THEN 1 END) AS excluded_rows,
    sum(CASE WHEN t.reason<>'duplicate_feed' AND t.direction='inflow' THEN t.amount_minor END) AS excluded_inflow_minor,
    sum(CASE WHEN t.reason<>'duplicate_feed' AND t.direction='outflow' THEN t.amount_minor END) AS excluded_outflow_minor
  FROM mq_row_status t WHERE t.reason IS NOT NULL AND NOT t.kept GROUP BY t.tenant_id,t.account_slug
), mq_tagged AS MATERIALIZED (
  SELECT t.*,
    COALESCE(${membership('money_kind')},'ordinary') AS movement_kind,
    ${membership('classification')} AS movement_classification,${membership('processor_name')} AS recorded_processor,
    ${membership('uncertain_kind')} AS uncertain_kind,
    ${CONTRIBUTION_FIELDS.map(k=>membership(k)+' AS '+k).join(',')},
    COALESCE(${membership('estimated')},1) AS estimated,${membership('estimate_reason')} AS estimate_reason,
    f.transfer_basis,COALESCE(f.possible_transfer,0) AS possible_transfer
  FROM mq_rows t LEFT JOIN mq_pair_flags f ON f.id=t.id
  ${frozenMembership ? '' : 'LEFT JOIN mq_membership m ON m.id=t.id'}
), mq_processors AS MATERIALIZED (
  SELECT t.*,CASE WHEN t.direction='inflow' AND t.movement_kind IN ('ordinary','own_transfer')
    AND COALESCE(t.estimate_reason,'')<>'possible_processor_advance_counted' THEN t.recorded_processor END AS processor FROM mq_tagged t
), mq_txn_all AS MATERIALIZED (
  SELECT id,tenant_id,txn_uid,posted_on,amount_minor,amount,direction,currency,payee,description,category,
    category_basis_state,basis_state,account_slug,account_identity,account,account_label,account_kind,entity,relationship,side,feed_kind,
    identity_basis,movement_classification,estimated,estimate_reason,uncertain_kind,
    CASE WHEN uncertain_kind IS NOT NULL THEN amount_minor ELSE 0 END AS uncertain_minor,CASE WHEN processor IS NOT NULL AND movement_kind='ordinary' THEN 'payout' ELSE movement_kind END AS money_kind,
    possible_transfer,transfer_basis,processor,${CONTRIBUTION_FIELDS.join(',')},
    COALESCE(reversal_payer_group,CASE WHEN processor IS NOT NULL THEN 'processor:'||processor ELSE lower(trim(COALESCE(payee,description))) END) AS payer_group,
    COALESCE(income_adjust_minor,0)+CASE WHEN direction='inflow' AND movement_kind='ordinary' AND account_kind NOT IN ('card','loan','line_of_credit') THEN amount_minor ELSE 0 END AS income_minor,
    CASE WHEN direction='outflow' AND movement_kind='ordinary' THEN amount_minor ELSE 0 END AS expense_minor
  FROM mq_processors
), txn AS MATERIALIZED (
  SELECT * FROM mq_txn_all t WHERE ${within('t')}
), transfer_pairs AS MATERIALIZED (
  SELECT * FROM mq_pairs_all WHERE ${window ? `out_date BETWEEN '${window.from}' AND '${window.through}' OR in_date BETWEEN '${window.from}' AND '${window.through}'` : '1'}
), coverage AS (
  SELECT a.tenant_id,a.account_identity,a.account_slug,a.mask AS account,a.label AS account_label,a.entity_slug AS entity,a.side,
    a.currency,a.identity_basis,a.opened_on,a.closed_on,a.status,
    CASE WHEN a.feed_mode<>'live' THEN 'import'
      -- Pending capability belongs to the current assigned feed. An old Plaid
      -- posting must not certify pending collection after a SimpleFIN switch.
      WHEN EXISTS(SELECT 1 FROM simplefin_account_assignments s WHERE s.tenant_id=a.tenant_id AND ${SIMPLEFIN_LEDGER_REFERENCE_SQL}) THEN 'simplefin'
      WHEN EXISTS(SELECT 1 FROM plaid_account_entity_assignments p WHERE p.tenant_id=a.tenant_id AND ${PLAID_LEDGER_REFERENCE_SQL}) THEN 'plaid'
      ELSE COALESCE((SELECT t.source_provider FROM mq_posted t WHERE t.tenant_id=a.tenant_id
        AND t.account_slug=a.account_slug AND t.source_provider IS NOT NULL LIMIT 1),'live') END AS feed_kind,
    r.first_row,r.last_row,COALESCE(r.row_count,0) AS row_count,
    COALESCE(h.raw_row_count,0) AS raw_row_count,
    COALESCE(x.duplicate_rows_removed,0) AS duplicate_rows_removed,
    (SELECT count(*) FROM mq_duplicate_rows t WHERE t.tenant_id=a.tenant_id AND t.account_slug=a.account_slug
      AND t.possible_duplicate AND ${within('t')}) AS possible_duplicate_count,
    COALESCE(h.unreadable_rows,0) AS unreadable_rows,COALESCE(h.unconfirmed_rows,0) AS unconfirmed_rows,
    COALESCE(r.rows_outside_account_dates,0) AS rows_outside_account_dates,
    COALESCE(pending.pending_rows,0) AS pending_rows,COALESCE(pending.pending_in_minor,0) AS pending_in_minor,
    COALESCE(pending.pending_out_minor,0) AS pending_out_minor,pending.pending_oldest_on,
    NULL AS last_sync,'unavailable_private_connection_state' AS sync_basis,
    (SELECT MAX(observed_at) FROM (
      SELECT p.last_seen_at AS observed_at FROM plaid_account_entity_assignments p WHERE p.tenant_id=a.tenant_id AND ${PLAID_LEDGER_REFERENCE_SQL}
      UNION ALL SELECT s.last_seen_at FROM simplefin_account_assignments s WHERE s.tenant_id=a.tenant_id AND ${SIMPLEFIN_LEDGER_REFERENCE_SQL})) AS last_observed_at,
    COALESCE((${validCoverage}),0) AS coverage_verified,
    COALESCE(x.excluded_rows,0) AS excluded_rows,COALESCE(x.excluded_inflow_minor,0) AS excluded_inflow_minor,
    COALESCE(x.excluded_outflow_minor,0) AS excluded_outflow_minor,
    c.computed_at AS coverage_computed_at,c.basis_state AS coverage_basis_state,c.coverage_status,
    ${historyCoverageStartSql('a','h.first_posted',validCoverage)} AS covered_from,c.covered_to,
    'recorded' AS pending_collection,0 AS pending_stale_rows,0 AS pending_stale_in_minor,0 AS pending_stale_out_minor,0 AS history_gap_days,
    ${window ? `'${window.from}'` : 'NULL'} AS window_from,${window ? `'${window.through}'` : 'NULL'} AS window_through,
    h.first_posted AS history_first_row,h.last_posted AS history_last_row
  FROM mq_accounts a LEFT JOIN mq_history h ON h.tenant_id=a.tenant_id AND h.account_slug=a.account_slug
  LEFT JOIN mq_coverage_rows r ON r.tenant_id=a.tenant_id AND r.account_slug=a.account_slug
  LEFT JOIN mq_coverage_pending pending ON pending.tenant_id=a.tenant_id AND pending.account_slug=a.account_slug
  LEFT JOIN mq_coverage_excluded x ON x.tenant_id=a.tenant_id AND x.account_slug=a.account_slug
  LEFT JOIN fin_account_coverage c ON c.tenant_id=a.tenant_id
    AND c.account_slug=a.account_slug AND c.superseded_by_id IS NULL
)`;
}
export const CLEAN_MONEY_CTES = cleanMoneyCtes();

// Pair on the whole history before applying a question's date bounds. In
// particular, month-end outgoing and next-month incoming must stay one pair.
// A kind-only estimate must not add excluded payments to the spending example.
// Earlier estimates keep their previous membership; every new doubt remains
// visible in txn and the account/date confidence disclosure.
const kindOnlyReasons = MONEY_KIND_DOUBTS.filter(reason=>reason!=='prior_estimate').map(reason=>`'${reason}'`).join(',');
export const CLEAN_MONEY_EXAMPLE_SQL = `SELECT posted_on,amount_minor,direction,payee,account,account_label,side,currency,
  money_kind,movement_classification,estimated,estimate_reason,uncertain_kind,uncertain_minor,possible_transfer,processor,payer_group,income_minor,expense_minor
FROM txn WHERE (estimated=1 AND estimate_reason NOT IN (${kindOnlyReasons})) OR money_kind NOT IN ('own_transfer','card_payment','loan_payment','loan_proceeds','liability_credit')
ORDER BY posted_on,id`;

// Read all membership evidence in one statement. SQL consumes these decisions
// instead of maintaining its own payment grammar or endpoint resolver.
const ROW_FIELDS = ['id','tenant_id','txn_uid','account_slug','posted_on','amount_minor','direction','currency','payee','description','category','category_basis_state','basis_state','provenance','source_doc_uid','source_feed','source_provider','external_id',
  'amount','account_identity','account','account_label','institution','account_kind','account_basis','entity','relationship','entity_basis','side','identity_basis','feed_kind','memo'];
const PAIR_FIELDS = ['out_id','in_id','tenant_id','amount_minor','currency','out_date','in_date','out_account_identity','in_account_identity','out_kind','in_kind','out_matches','in_matches','evidence','unique_match','proved'];
const COVERAGE_FIELDS = ['tenant_id','account_identity','account_slug','account','account_label','entity','side','currency','identity_basis','opened_on','closed_on','status','feed_kind','first_row','last_row','row_count','raw_row_count','duplicate_rows_removed','possible_duplicate_count','unreadable_rows','unconfirmed_rows','rows_outside_account_dates','pending_rows','pending_in_minor','pending_out_minor','pending_oldest_on','last_sync','sync_basis','last_observed_at','coverage_computed_at','coverage_basis_state','coverage_status','covered_from','covered_to','coverage_verified','excluded_rows','excluded_inflow_minor','excluded_outflow_minor','window_from','window_through','history_first_row','history_last_row','pending_collection','pending_stale_rows','pending_stale_in_minor','pending_stale_out_minor','history_gap_days'];
const ACCOUNT_FIELDS = ['tenant_id','account_slug','account_identity','mask','label','institution','account_kind','balance_role','basis_state','relationship','entity_basis','feed_mode','account_kind_review_json','status','opened_on','closed_on'];
const snapshotRows = (kind, table, fields) => {
  const object = group => 'json_object(' + group.map(k => "'" + k + "'," + k).join(',') + ')';
  // D1 limits functions to 32 arguments. Coverage grows independently of the
  // row shape, so merge bounded groups rather than assuming two are enough.
  const groups = [];
  for (let i=15;i<fields.length;i+=15) groups.push(object(fields.slice(i,i+15)));
  const rest = groups.reduce((left,right) => left ? 'json_patch(' + left + ',' + right + ')' : right, '');
  return "SELECT '" + kind + "' AS snapshot_kind," + object(fields.slice(0,15)) + ' AS value,' +
    (rest || 'NULL') + ' AS value2 FROM ' + table;
};
// Each record stays a separate result row; aggregating a whole corpus into one
// JSON cell would exceed native row/transport limits before the scan budget.
const snapshotSelections = [snapshotRows('rows','mq_rows',ROW_FIELDS),
  snapshotRows('accounts',`(SELECT a.*,${accountKindReviewSql('a')} AS account_kind_review_json FROM mq_accounts a)`,ACCOUNT_FIELDS),
  snapshotRows('entities','(SELECT tenant_id,legal_name,display_label,kind FROM fin_entities WHERE superseded_by_id IS NULL)',
    ['tenant_id','legal_name','display_label','kind']),
  snapshotRows('pairs','mq_pairs_all',PAIR_FIELDS),
  snapshotRows('coverage','coverage',COVERAGE_FIELDS),
  snapshotRows('unreadable',`(SELECT t.id,t.tenant_id,t.account_slug,t.account,t.posted_on,t.amount_minor,t.direction,t.currency,t.side,t.entity,t.account_identity,
    CASE WHEN date(substr(t.posted_on,1,10),'+0 days')=substr(t.posted_on,1,10) THEN substr(t.posted_on,1,10) END AS readable_day
    FROM mq_posted t
    WHERE t.amount_minor IS NULL OR t.direction IS NULL OR date(t.posted_on,'+0 days') IS NOT t.posted_on OR t.posted_on IS NULL)`,
    ['id','tenant_id','account_slug','account','posted_on','amount_minor','direction','currency','side','entity','account_identity','readable_day']),
  snapshotRows('settled',`(SELECT t.tenant_id,t.account_slug,a.mask AS account,t.posted_on AS pending_on,p.posted_on,t.amount_minor,t.direction,t.currency,a.side,a.entity_slug AS entity,a.account_identity
    FROM fin_transactions t JOIN mq_accounts a ON a.tenant_id=t.tenant_id AND a.account_slug=t.account_slug
    JOIN main.fin_transactions p ON p.tenant_id=t.tenant_id AND p.account_slug=t.account_slug AND p.source_provider IS t.source_provider
    AND t.external_id IS NOT NULL AND p.pending_transaction_id=t.external_id AND p.pending=0 AND p.removed_at IS NULL AND p.superseded_by_id IS NULL
    WHERE t.pending=1 AND t.removed_at IS NULL AND t.superseded_by_id IS NULL)`,
    ['tenant_id','account_slug','account','pending_on','posted_on','amount_minor','direction','currency','side','entity','account_identity']),
  snapshotRows('pending','mq_pending',['id','tenant_id','account_slug','posted_on','amount_minor','direction','currency']),
  `SELECT 'quality' AS snapshot_kind,json_object('tenant_id',tenant_id,'account_slug',account_slug,'posted_on',posted_on,'currency',currency,'direction',direction,'amount_minor',sum(amount_minor),'unreadable_rows',count(*)) AS value,NULL AS value2 FROM mq_posted WHERE amount_minor IS NULL OR direction IS NULL OR date(posted_on,'+0 days') IS NOT posted_on OR posted_on IS NULL GROUP BY tenant_id,account_slug,posted_on,currency,direction`,
  `SELECT CASE WHEN kept THEN 'conflicts' ELSE 'excluded' END AS snapshot_kind,json_object('tenant_id',tenant_id,'account_slug',account_slug,'posted_on',posted_on,'currency',currency,'direction',direction,'reason',reason,'row_count',count(*),'amount_minor',sum(amount_minor)) AS value,NULL AS value2 FROM mq_row_status WHERE reason IS NOT NULL GROUP BY tenant_id,account_slug,posted_on,currency,direction,reason,kept`];
// D1 limits each compound chain to five terms, including this fixed inventory.
export const CLEAN_MONEY_SNAPSHOT_SQL = Array.from({length:Math.ceil(snapshotSelections.length/5)},(_,index) =>
  'SELECT * FROM (' + snapshotSelections.slice(index*5,index*5+5).join(' UNION ALL ') + ')').join(' UNION ALL ');

export class MoneySnapshotLimitError extends Error {
  constructor() { super('Money snapshot exceeds the bounded input.'); this.code='MONEY_QUERY_SCAN_LIMIT'; }
}

function snapshotCte(name, fields, rows, binds, overrides = {}) {
  const parameters = [], encoder = new TextEncoder();
  let records = [], bytes = 2;
  const flush = () => {

    binds.push('[' + records.join(',') + ']');parameters.push('?' + binds.length);
    records=[];bytes=2;
  };
  // Each bind is a complete JSON array below D1's value limit. Concatenating
  // chunks inside SQLite would rebuild the same oversized value and fail.
  for(const row of rows) {
    const record=JSON.stringify(row), size=encoder.encode(record).length;
    if(size+2>900000)throw Object.assign(new MoneySnapshotLimitError(),{message:'Money snapshot record exceeds the value budget'});
    if(bytes+size+(records.length?1:0)>900000)flush();
    bytes+=size+(records.length?1:0);records.push(record);
  }
  if(records.length||!parameters.length)flush();
  const columns=fields.map(k => (overrides[k] ?? "json_extract(value,'$." + k + "')") + ' AS ' + k).join(',');
  // JSON chunks are rows, not compound SELECT arms. At the bind ceiling an
  // otherwise valid frozen snapshot exceeds D1's five-term compound limit.
  return name + ' AS MATERIALIZED (SELECT ' + columns + ' FROM (VALUES ' +
    parameters.map(p => '(' + p + ')').join(',') + ') AS chunks, json_each(chunks.column1))';
}


export function moneyMembershipDecisions(snapshot) {
  const decisions = [], readingRows=[], depositOriginal=new Map(),transferOriginal=new Map();
  const endpoints = new Map();
  for (const tenant of new Set(snapshot.rows.map(r => r.tenant_id))) {
    const accounts = new Map(), effective = new Map(), identities = new Map(), postingKinds = new Map();
    for (const raw of snapshot.accounts.filter(a => a.tenant_id === tenant)) {
      const a = applyAccountKindReview(raw);
      // Kind evidence survives loss of ownership; endpoint authority does not.
      postingKinds.set(a.account_slug,a.account_kind);
      if (a.relationship !== 'owned' || a.entity_basis !== 'confirmed' || a.basis_state !== 'confirmed') continue;
      let account = identities.get(a.account_identity);
      if (!account) { account = {...a,members:[]}; identities.set(a.account_identity,account); }
      // Match the product reader's live primary while retaining every linked
      // member for exact-mask resolution and review-conflict checks.
      if (a.feed_mode === 'live' && account.feed_mode !== 'live') Object.assign(account,a);
      account.members.push(a);
    }
    for (const account of identities.values()) {
      accounts.set(account.account_slug,account);
      for (const member of account.members) effective.set(member.account_slug,account.account_slug);
    }
    const rows = snapshot.rows.filter(r => r.tenant_id === tenant).map(r => ({...r,account_kind:postingKinds.get(r.account_slug) ?? r.account_kind,effective_account_slug:effective.get(r.account_slug)}));
    readingRows.push(...rows);
    // Compare like currencies and exact normalized payer identities. A customer
    // refunded once is not a vendor when their receipts exceed the refund.
    const payeeFlow=new Map();
    for(const row of rows){
      // A partial record without integer cents supplies no vendor evidence.
      const payee=normalizeMerchantText(row.payee),cents=Number(row.amount_minor);if(!payee || !Number.isSafeInteger(cents))continue;
      const key=JSON.stringify([row.currency,payee]),flow=payeeFlow.get(key)||{out_minor:0n,in_minor:0n};
      flow[row.direction==='outflow'?'out_minor':'in_minor']+=BigInt(cents);payeeFlow.set(key,flow);
    }
    // An equal amount only nominates an original when the debit itself has a
    // closed return grammar. Consume once, latest first, inside the read margin.
    const usedDeposits=new Set();
    // An undated partial record sorts first and, with no date, matches nothing.
    const day=r=>String(r.posted_on ?? '');
    for(const row of [...rows].sort((a,b)=>day(a).localeCompare(day(b))||a.id-b.id)){
      const form=reversalForm(row,['card','loan','line_of_credit'].includes(row.account_kind));
      if(!['deposit_b','transfer'].includes(form?.kind))continue;
      const originals=rows.filter(p=>p.account_identity===row.account_identity && p.direction!==row.direction && p.currency===row.currency && p.amount_minor===row.amount_minor &&
        !usedDeposits.has(p.id) && p.posted_on<=row.posted_on && Date.parse(row.posted_on)-Date.parse(p.posted_on)<=6*86400000 &&
        !LEGACY_PAYMENT_REVERSAL.test(normalizeLedgerText(p.description)) && !reversalForm(p,['card','loan','line_of_credit'].includes(p.account_kind)));
      originals.sort((a,b)=>day(b).localeCompare(day(a))||b.id-a.id);
      if(originals.length){(form.kind==='transfer'?transferOriginal:depositOriginal).set(row.id,originals[0].id);usedDeposits.add(originals[0].id);}
    }
    const byId = new Map(rows.map(r => [r.id,r]));
    const {likelyPairs}=refineTransferPairs(snapshot,rows,accounts);
    const loanDrawConflicts=refineLoanDrawPairs(snapshot,rows,accounts);
    const processorSweeps=processorSweepEstimates(rows,accounts);
    const candidateIds=new Set(),conflictingPairIds=new Set(),possiblePayments=new Map(),pairs=[];
    for(const p of snapshot.pairs.filter(p=>p.tenant_id===tenant && byId.has(p.out_id) && byId.has(p.in_id))){
      candidateIds.add(p.out_id);candidateIds.add(p.in_id);
      const pair={out:byId.get(p.out_id),in:byId.get(p.in_id),proved:true,evidence:p.evidence};
      if([pair.out,pair.in].some(unresolvedMovementFee)){p.proved=0;p.evidence=null;}
      if(snapshot.partial){p.proved=0;p.evidence=null;}
      // A later generic proof must not restore a rejected borrowing endpoint.
      if(!snapshot.partial && !p.proved && p.unique_match && !loanDrawConflicts.has(p)){const evidence=cleanPairEvidence(pair,accounts);if(evidence){p.proved=1;p.evidence=evidence;}}
      if(!p.proved && p.unique_match && ['checking','savings'].includes(accounts.get(pair.out.effective_account_slug)?.account_kind) &&
        ['card','loan','line_of_credit'].includes(accounts.get(pair.in.effective_account_slug)?.account_kind) &&
        /\b(?:credit crd|credit card|card|loan|mortgage)\b.*\b(?:autopay|payment|pmt|pymt)\b/i.test(pair.out.description || '') &&
        /^(?:(?:online|automatic|mobile|internet|auto)\s+)?payment\s*[- ]\s*thank you$/i.test(pair.in.description || '')){
        const kind=accounts.get(pair.in.effective_account_slug).account_kind==='card'?'card':'loan';
        possiblePayments.set(pair.out.id,'possible_'+kind+'_payment_matched_credit_counted');
      }
      if(!p.proved && p.unique_match && [pair.out,pair.in].every(r=>/\btransfer (?:to|from)\b/i.test(r.description || '')) &&
        ![pair.out,pair.in].some(r=>r.payee && r.payee!==r.description)){
        conflictingPairIds.add(p.out_id);conflictingPairIds.add(p.in_id);
      }
      if(p.proved)pairs.push(pair);
    }
    const dates=new Map();for(const row of rows){const key=row.effective_account_slug;const days=dates.get(key)||[];days.push(row.posted_on);dates.set(key,days);}
    const hasRowsNear=(slug,day,n)=>(dates.get(slug)||[]).some(d=>Math.abs(Date.parse(d)-Date.parse(day))<=n*86400000);
    const payingPairs=new Map(pairs.map(p=>[p.out.id,p]));
    for (const row of rows) {
      // Keep identity evidence beside the row. Borrowing proof is a clean SQL
      // policy layered over the shared reader, never a change to owner Ask.
      row.clean_transfer_reason=likelyPairs.get(row.id);
      row.clean_processor_sweep=processorSweeps.get(row.id);
      const reading = moneyMovementReading(row, accounts, pairs, {clean:true,candidateIds,conflictingPairIds,possiblePayments,hasRowsNear,payeeFlow,depositOriginal,incomplete:snapshot.partial});
      const {classification,money_kind,estimated,estimate_reason,uncertain_kind} = loanDrawReading(row,reading,accounts,pairs);
      decisions.push({id:row.id,classification,money_kind,estimated:Number(estimated),estimate_reason,uncertain_kind,processor_name:moneyProcessor(row)});
      if(processorSweeps.has(row.id))decisions.at(-1).sweep_covered_minor=processorSweeps.get(row.id).covered_minor;
      const pair=payingPairs.get(row.id);
      const target=pair ? accounts.get(pair.in.effective_account_slug) : row.direction==='outflow' && ['card_payment','loan_payment'].includes(money_kind)
        ? loanCardPaymentAccount(row,accounts) : row.direction==='inflow' && ['card','loan','line_of_credit'].includes(row.account_kind)
          ? accounts.get(row.effective_account_slug) ?? {account_slug:row.account_slug,mask:row.account,account_kind:row.account_kind} : null;
      endpoints.set(row.id,{slug:target?.account_slug ?? null,mask:target?.mask ?? null,source_kind:row.account_kind,destination_kind:target?.account_kind ?? null});
    }
    const ownDecisions=decisions.filter(d=>byId.has(d.id));
    matchPlatformReserves(rows,ownDecisions,accounts);
    const sides=new Map(snapshot.coverage.filter(c=>c.tenant_id===tenant).map(c=>[c.account_slug,c.side]));
    for (const d of ownDecisions) if(d.money_kind==='own_transfer') {
      const r=byId.get(d.id),pair=pairs.find(p=>p.out.id===r.id || p.in.id===r.id),
        counterpart=pair ? (pair.out.id===r.id ? pair.in.account_slug : pair.out.account_slug) : possibleOwnedMovement(r,accounts)?.counterpart;
      d.counterpart_side=sides.get(counterpart);
    }
    markFeedDuplicates(rows,ownDecisions,new Set(pairs.flatMap(p=>[p.out.id,p.in.id])),snapshot.coverage);
  }
  cleanMoneyContributions(readingRows,decisions,snapshot.pairs,snapshot.accounts,{depositOriginal,transferOriginal,endpoints,entities:snapshot.entities ?? []});
  return decisions;
}

export function moneyMembershipCte(snapshot, binds, decisions = moneyMembershipDecisions(snapshot)) {
  return snapshotCte('mq_membership',['id','classification','money_kind','estimated','estimate_reason','uncertain_kind','processor_name',...CONTRIBUTION_FIELDS],decisions,binds);
}

// Freeze the evidence used for classification. A sync between the snapshot and
// the caller's aggregate cannot combine fresh amounts with old membership.
export function classifiedMoneyCtes(snapshot, binds, window = null, decisions = moneyMembershipDecisions(snapshot), {maxBinds=90,period=null,accountSlugs,coveragePeriod=null,asOf=null} = {}) {
  if(Array.isArray(window)){decisions=window;window=null;}
  const selectedPeriod=coveragePeriod || period || (window && {from:window.from,to:window.through});
  const candidateIds=new Set(decisions.filter(d=>d.duplicate_minor || d.money_kind==='likely_duplicate' ||
    /duplicate_(?:feed|import)_counted/.test(d.estimate_reason||'')).map(d=>d.id));
  snapshot={...snapshot,coverage:coverageInPeriod(snapshot,selectedPeriod,asOf).map(c=>({...c,
    possible_duplicate_count:Math.max(c.possible_duplicate_count,snapshot.rows.filter(r=>r.tenant_id===c.tenant_id &&
      r.account_slug===c.account_slug && candidateIds.has(r.id) && (!selectedPeriod ||
        r.posted_on>=selectedPeriod.from && r.posted_on<=selectedPeriod.to)).length)}))};
  const ctes = cleanMoneyCtes(window, true);
  const tagging = ctes.slice(ctes.indexOf('mq_tagged AS'), ctes.indexOf(', coverage AS'));
  const pairing = ctes.slice(ctes.indexOf('mq_pair_ends AS'),ctes.indexOf(', mq_tagged AS'));
  const membership = new Map(decisions.map(row => [row.id,row]));
  // JSON-backed relations have tiny planner estimates. Joining 10,000 frozen
  // decisions back to 10,000 rows chose a quadratic scan in SQLite. Bind the
  // shared classifier's decision beside its exact row instead (same snapshot).
  const rows = snapshot.rows.map(row => ({...row,mq_classification:membership.get(row.id)?.classification,
    mq_money_kind:membership.get(row.id)?.money_kind,mq_estimated:membership.get(row.id)?.estimated,mq_estimate_reason:membership.get(row.id)?.estimate_reason,mq_uncertain_kind:membership.get(row.id)?.uncertain_kind,mq_processor_name:membership.get(row.id)?.processor_name,...Object.fromEntries(CONTRIBUTION_FIELDS.map(k=>['mq_'+k,membership.get(row.id)?.[k]]))}));
  const tables=[['mq_rows',[...ROW_FIELDS,'mq_classification','mq_money_kind','mq_estimated','mq_estimate_reason','mq_uncertain_kind','mq_processor_name',...CONTRIBUTION_FIELDS.map(k=>'mq_'+k)],rows],
    ['mq_accounts',ACCOUNT_FIELDS,snapshot.accounts],['mq_pairs_all',PAIR_FIELDS,snapshot.pairs],['coverage',COVERAGE_FIELDS,snapshot.coverage]];
  const start=binds.length;
  let frozen=tables.map(([name,fields,data])=>snapshotCte(name,fields,data,binds,name==='mq_rows'?{amount:moneyMinorSql("json_extract(value,'$.amount_minor')", "json_extract(value,'$.currency')")}:{}));
  if(binds.length>maxBinds){
    binds.length=start;
    const records=tables.flatMap(([kind,,data])=>data.map(record=>({kind,record})));
    frozen=[snapshotCte('mq_frozen',['kind','record'],records,binds),...tables.map(([name,fields])=>
      `${name} AS MATERIALIZED (SELECT ${fields.map(k=>(name==='mq_rows' && k==='amount'?moneyMinorSql("json_extract(record,'$.amount_minor')", "json_extract(record,'$.currency')"):"json_extract(record,'$."+k+"')")+' AS '+k).join(',')} FROM mq_frozen WHERE kind='${name}')`)];
  }
  if(binds.length>maxBinds)throw Object.assign(new MoneySnapshotLimitError(),{snapshotTooLarge:binds.length});
  if(!period && !accountSlugs)return [...frozen,pairing,tagging].join(',');
  // Scope only the public rows after all-history pairing and classification.
  // Bind account selectors as JSON; no owner value is interpolated into SQL.
  const select=table=>`SELECT * FROM mq_scoped_${table} WHERE ${table==='txn' && period?`posted_on BETWEEN '${period.from}' AND '${period.to}' AND `:''}${accountSlugs?'account_slug IN (SELECT value FROM json_each(?'+(binds.length+1)+'))':'1'}`;
  const scoped=tagging.replace(', txn AS MATERIALIZED (',', mq_scoped_txn AS MATERIALIZED (');
  const coverage=frozen.pop().replace(/^coverage AS/,'mq_scoped_coverage AS');
  // Packed transport keeps coverage in a projection, too; its position is stable.
  const result=[...frozen,coverage,pairing,scoped,`txn AS MATERIALIZED (${select('txn')})`,`coverage AS MATERIALIZED (${select('coverage')})`];
  if(accountSlugs)binds.push(JSON.stringify(accountSlugs));
  if(binds.length>maxBinds)throw Object.assign(new MoneySnapshotLimitError(),{snapshotTooLarge:binds.length});
  return result.join(',');
}
