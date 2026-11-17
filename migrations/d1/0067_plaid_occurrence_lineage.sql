-- The retained provider pages and owner decisions are the occurrence journal.
-- Derive heads from its edges, never from an account-bound mutable alias. Views
-- also reconstruct already-published schema-66 moves without rewriting history.
CREATE TRIGGER IF NOT EXISTS replacement_events_no_update BEFORE UPDATE ON plaid_replacement_events
BEGIN SELECT RAISE(ABORT,'replacement occurrence journal is append only'); END;
CREATE TRIGGER IF NOT EXISTS replacement_events_no_delete BEFORE DELETE ON plaid_replacement_events
BEGIN SELECT RAISE(ABORT,'replacement occurrence journal is append only'); END;
CREATE TRIGGER IF NOT EXISTS replacement_decisions_no_update BEFORE UPDATE ON plaid_replacement_decisions
BEGIN SELECT RAISE(ABORT,'replacement occurrence journal is append only'); END;
CREATE TRIGGER IF NOT EXISTS replacement_decisions_no_delete BEFORE DELETE ON plaid_replacement_decisions
BEGIN SELECT RAISE(ABORT,'replacement occurrence journal is append only'); END;

CREATE VIEW IF NOT EXISTS plaid_replacement_item_lineage AS
WITH RECURSIVE chain(tenant_id,operation_ref,item_ref) AS (
  SELECT tenant_id,operation_ref,old_item_ref FROM plaid_item_replacements
  UNION SELECT tenant_id,operation_ref,new_item_ref FROM plaid_item_replacements WHERE new_item_ref IS NOT NULL
  UNION SELECT c.tenant_id,c.operation_ref,p.old_item_ref FROM chain c JOIN plaid_item_replacements p
    ON p.tenant_id=c.tenant_id AND p.new_item_ref=c.item_ref AND p.published_revision>0
  UNION SELECT c.tenant_id,c.operation_ref,p.new_item_ref FROM chain c JOIN plaid_item_replacements p
    ON p.tenant_id=c.tenant_id AND p.old_item_ref=c.item_ref AND p.published_revision>0 AND p.new_item_ref IS NOT NULL
)
SELECT tenant_id,operation_ref,item_ref FROM chain;

CREATE VIEW IF NOT EXISTS plaid_occurrence_links AS
SELECT d.tenant_id,d.operation_ref,d.revision,d.event_index,d.old_row_id AS origin_row_id,t.id AS successor_row_id
FROM plaid_replacement_decisions d
JOIN plaid_replacement_events e ON e.tenant_id=d.tenant_id AND e.operation_ref=d.operation_ref
  AND e.revision=d.revision AND e.event_index=d.event_index
JOIN fin_transactions t ON t.tenant_id=d.tenant_id
  AND t.txn_uid='replacement:'||e.operation_ref||':'||e.provider_id||':'||e.revision
WHERE d.action='replace' AND d.old_row_id IS NOT NULL AND d.old_row_id<>t.id;

CREATE VIEW IF NOT EXISTS plaid_occurrence_heads AS
WITH RECURSIVE walk(tenant_id,origin_row_id,head_row_id) AS (
  SELECT tenant_id,id,id FROM fin_transactions
  UNION
  SELECT w.tenant_id,w.origin_row_id,l.successor_row_id FROM walk w JOIN plaid_occurrence_links l
    ON l.tenant_id=w.tenant_id AND l.origin_row_id=w.head_row_id
)
SELECT w.tenant_id,w.origin_row_id,w.head_row_id FROM walk w
WHERE NOT EXISTS(SELECT 1 FROM plaid_occurrence_links l WHERE l.tenant_id=w.tenant_id AND l.origin_row_id=w.head_row_id);

-- Identity is provider connection + transaction ID, independent of account.
-- Exact duplicate/correction decisions bridge changed IDs and connections.
-- Pending IDs inherit only an explicitly reconciled pending-to-posted link.
CREATE VIEW IF NOT EXISTS plaid_occurrence_identities AS
SELECT tenant_id,substr(source_feed,11) AS item_ref,external_id AS provider_id,id AS origin_row_id
FROM fin_transactions WHERE external_id IS NOT NULL AND source_feed LIKE 'bank-feed:%'
UNION
SELECT e.tenant_id,r.new_item_ref,e.provider_id,
  CASE WHEN d.action IN ('duplicate','remove') THEN d.old_row_id ELSE t.id END
FROM plaid_replacement_events e JOIN plaid_item_replacements r
  ON r.tenant_id=e.tenant_id AND r.operation_ref=e.operation_ref
JOIN plaid_replacement_decisions d ON d.tenant_id=e.tenant_id AND d.operation_ref=e.operation_ref
  AND d.revision=e.revision AND d.event_index=e.event_index
LEFT JOIN fin_transactions t ON t.tenant_id=e.tenant_id
  AND t.txn_uid='replacement:'||e.operation_ref||':'||e.provider_id||':'||e.revision
WHERE d.action IN ('admit','duplicate','replace','remove')
UNION
SELECT e.tenant_id,r.new_item_ref,json_extract(e.payload_json,'$.pending_id'),d.old_row_id
FROM plaid_replacement_events e JOIN plaid_item_replacements r
  ON r.tenant_id=e.tenant_id AND r.operation_ref=e.operation_ref
JOIN plaid_replacement_decisions d ON d.tenant_id=e.tenant_id AND d.operation_ref=e.operation_ref
  AND d.revision=e.revision AND d.event_index=e.event_index
WHERE d.action='replace' AND json_extract(e.payload_json,'$.pending_id') IS NOT NULL;

-- A no-money settlement is a new withdrawal event, including when its source
-- page redelivered an added row. Neither that page nor any old row is deleted.
CREATE VIEW IF NOT EXISTS plaid_occurrence_events AS
SELECT d.tenant_id,d.operation_ref,d.revision,d.event_index,
  CASE WHEN d.action='remove' THEN 'withdrawal' ELSE d.action END AS event_type,
  CASE WHEN d.action IN ('duplicate','remove','replace') THEN d.old_row_id ELSE t.id END AS origin_row_id,
  CASE WHEN d.action IN ('duplicate','remove') THEN d.old_row_id ELSE t.id END AS observed_row_id,
  d.evidence,e.digest
FROM plaid_replacement_decisions d JOIN plaid_replacement_events e
  ON e.tenant_id=d.tenant_id AND e.operation_ref=d.operation_ref AND e.revision=d.revision AND e.event_index=d.event_index
LEFT JOIN fin_transactions t ON t.tenant_id=e.tenant_id
  AND t.txn_uid='replacement:'||e.operation_ref||':'||e.provider_id||':'||e.revision;
