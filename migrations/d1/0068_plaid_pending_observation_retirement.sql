-- Only the observation retires when a linked pending row becomes posted.
-- Its decision has no economic head to consume; the exact pending predecessor
-- remains retained here and in the immutable provider/decision journal.
ALTER TABLE plaid_replacement_decisions ADD COLUMN pending_observation_row_id INTEGER
  CHECK(pending_observation_row_id IS NULL OR (action='remove' AND old_row_id IS NULL));
DROP VIEW IF EXISTS plaid_occurrence_identities;
CREATE VIEW IF NOT EXISTS plaid_occurrence_identities AS
SELECT tenant_id,substr(source_feed,11) AS item_ref,external_id AS provider_id,id AS origin_row_id
FROM fin_transactions WHERE external_id IS NOT NULL AND source_feed LIKE 'bank-feed:%'
UNION
SELECT e.tenant_id,r.new_item_ref,e.provider_id,
  CASE WHEN d.action IN ('duplicate','remove') THEN COALESCE(d.old_row_id,d.pending_observation_row_id) ELSE t.id END
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


DROP VIEW IF EXISTS plaid_occurrence_events;
CREATE VIEW IF NOT EXISTS plaid_occurrence_events AS
SELECT d.tenant_id,d.operation_ref,d.revision,d.event_index,
  CASE WHEN d.pending_observation_row_id IS NOT NULL THEN 'pending_retired' WHEN d.action='remove' THEN 'withdrawal' ELSE d.action END AS event_type,
  CASE WHEN d.action IN ('duplicate','remove','replace') THEN COALESCE(d.old_row_id,d.pending_observation_row_id) ELSE t.id END AS origin_row_id,
  CASE WHEN d.action IN ('duplicate','remove') THEN COALESCE(d.old_row_id,d.pending_observation_row_id) ELSE t.id END AS observed_row_id,
  d.evidence,e.digest
FROM plaid_replacement_decisions d JOIN plaid_replacement_events e
  ON e.tenant_id=d.tenant_id AND e.operation_ref=d.operation_ref AND e.revision=d.revision AND e.event_index=d.event_index
LEFT JOIN fin_transactions t ON t.tenant_id=e.tenant_id
  AND t.txn_uid='replacement:'||e.operation_ref||':'||e.provider_id||':'||e.revision;
