-- Provider-neutral operational health. No access references or raw errors.
-- Successful sync means a fresh, complete provider read committed to the ledger;
-- a resumed snapshot, historical-only window or partial response is not current.
CREATE TABLE IF NOT EXISTS bank_feed_health (
  tenant_id TEXT NOT NULL,
  item_ref TEXT NOT NULL,
  last_attempt_at TEXT,
  last_successful_sync_at TEXT,
  data_through TEXT,
  last_webhook_at TEXT,
  last_error_code TEXT,
  last_error_meaning TEXT,
  PRIMARY KEY (tenant_id,item_ref)
);

-- Only complete, settled legacy Plaid receipts can seed successful health.
-- SimpleFIN's former last_synced_at advanced even on partial provider reads.
INSERT OR IGNORE INTO bank_feed_health (tenant_id,item_ref,last_successful_sync_at,data_through)
SELECT i.tenant_id,i.item_ref,i.last_synced_at,substr(i.last_synced_at,1,10)
  FROM bank_feed_items i JOIN bank_feed_backfill b
    ON b.tenant_id=i.tenant_id AND b.item_ref=i.item_ref
  WHERE i.removed_at IS NULL AND i.status='connected' AND i.last_synced_at IS NOT NULL
    AND b.state='complete' AND b.provider_history_state='HISTORICAL_UPDATE_COMPLETE'
    AND NOT EXISTS (SELECT 1 FROM simplefin_connections c WHERE c.tenant_id=i.tenant_id AND c.item_ref=i.item_ref)
    AND NOT EXISTS (SELECT 1 FROM plaid_sync_windows w WHERE w.tenant_id=i.tenant_id AND w.item_ref=i.item_ref)
    AND NOT EXISTS (SELECT 1 FROM plaid_reconciliation r WHERE r.tenant_id=i.tenant_id AND r.item_ref=i.item_ref
      AND (r.state<>'complete' AND r.reason<>'scheduled'));

-- Legacy SimpleFIN timestamps cannot seed health, so request verified current
-- evidence immediately. Replay must preserve an observed attempt's retry time.
UPDATE simplefin_connections SET next_pull_at='1970-01-01T00:00:00.000Z'
  WHERE NOT EXISTS (SELECT 1 FROM bank_feed_health h
    WHERE h.tenant_id=simplefin_connections.tenant_id AND h.item_ref=simplefin_connections.item_ref);

-- Document projections cannot refresh a bank connection's operational clock.
CREATE TRIGGER IF NOT EXISTS bank_activity_health_insert
AFTER INSERT ON sources
WHEN NEW.name='bank_activity' AND EXISTS(SELECT 1 FROM bank_feed_items WHERE removed_at IS NULL)
  AND (NEW.last_ingest_at IS NOT (SELECT CASE WHEN COUNT(*)=COUNT(h.last_successful_sync_at) THEN MIN(h.last_successful_sync_at) END
  FROM bank_feed_items i LEFT JOIN bank_feed_health h ON h.tenant_id=i.tenant_id AND h.item_ref=i.item_ref
  WHERE i.removed_at IS NULL) OR NEW.expected_refresh_seconds IS NOT 86400)
BEGIN
  UPDATE sources SET last_ingest_at=(SELECT CASE WHEN COUNT(*)=COUNT(h.last_successful_sync_at) THEN MIN(h.last_successful_sync_at) END
  FROM bank_feed_items i LEFT JOIN bank_feed_health h ON h.tenant_id=i.tenant_id AND h.item_ref=i.item_ref
  WHERE i.removed_at IS NULL),expected_refresh_seconds=86400 WHERE name=NEW.name;
END;

-- Document projections cannot refresh a bank connection's operational clock.
CREATE TRIGGER IF NOT EXISTS bank_activity_health_update
AFTER UPDATE OF last_ingest_at,expected_refresh_seconds ON sources
WHEN NEW.name='bank_activity' AND EXISTS(SELECT 1 FROM bank_feed_items WHERE removed_at IS NULL)
  AND (NEW.last_ingest_at IS NOT (SELECT CASE WHEN COUNT(*)=COUNT(h.last_successful_sync_at) THEN MIN(h.last_successful_sync_at) END
  FROM bank_feed_items i LEFT JOIN bank_feed_health h ON h.tenant_id=i.tenant_id AND h.item_ref=i.item_ref
  WHERE i.removed_at IS NULL) OR NEW.expected_refresh_seconds IS NOT 86400)
BEGIN
  UPDATE sources SET last_ingest_at=(SELECT CASE WHEN COUNT(*)=COUNT(h.last_successful_sync_at) THEN MIN(h.last_successful_sync_at) END
  FROM bank_feed_items i LEFT JOIN bank_feed_health h ON h.tenant_id=i.tenant_id AND h.item_ref=i.item_ref
  WHERE i.removed_at IS NULL),expected_refresh_seconds=86400 WHERE name=NEW.name;
END;
