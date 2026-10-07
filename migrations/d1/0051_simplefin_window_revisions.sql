-- Staging chunks and ledger writes are fenced by one replacement revision.
-- The published marker changes only after the complete response is durable.
-- Retain older staged rows for recovery; readers select the published revision.
ALTER TABLE simplefin_sync_windows ADD COLUMN revision TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE simplefin_sync_windows ADD COLUMN staging_revision TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE simplefin_stage_accounts ADD COLUMN revision TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE simplefin_stage_transactions ADD COLUMN revision TEXT NOT NULL DEFAULT 'legacy';

-- Old windows have no revision completeness receipt, and the old cursor could
-- advance before promotion. Revisit retained history, including previously
-- promoted partial responses. Existing ledger and staging rows remain intact.
UPDATE simplefin_connections SET backfill_next=MIN(backfill_next, (
  SELECT MIN(window_start) FROM simplefin_sync_windows w
   WHERE w.tenant_id=simplefin_connections.tenant_id
     AND w.item_ref=simplefin_connections.item_ref AND w.revision='legacy'
)) WHERE EXISTS (
  SELECT 1 FROM simplefin_sync_windows w
   WHERE w.tenant_id=simplefin_connections.tenant_id
     AND w.item_ref=simplefin_connections.item_ref AND w.revision='legacy'
);
UPDATE bank_feed_backfill SET state='queued',finished_at=NULL WHERE EXISTS (
  SELECT 1 FROM simplefin_sync_windows w
   WHERE w.tenant_id=bank_feed_backfill.tenant_id
     AND w.item_ref=bank_feed_backfill.item_ref AND w.revision='legacy'
);
UPDATE simplefin_sync_windows SET staging_revision='legacy-unverified' WHERE revision='legacy';
