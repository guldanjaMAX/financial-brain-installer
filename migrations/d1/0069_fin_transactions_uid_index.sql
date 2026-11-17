-- Money-confidence snapshot joins replacement rows by txn_uid; the only existing
-- txn_uid index is partial (superseded_by_id IS NULL), so every published replace
-- decision scanned the whole tenant ledger. A full (tenant_id, txn_uid) index makes
-- that join a lookup.
CREATE INDEX IF NOT EXISTS idx_fin_transactions_tenant_txn_uid ON fin_transactions(tenant_id, txn_uid);
