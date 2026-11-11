-- Keep legacy references and approvals intact. NULL connection identity means
-- unbound legacy material, never permission to adopt a newly discovered tuple.
ALTER TABLE simplefin_account_assignments ADD COLUMN connection_id TEXT;
ALTER TABLE simplefin_account_assignments ADD COLUMN source_account_id TEXT;
UPDATE simplefin_account_assignments SET source_account_id=provider_account_id;
CREATE UNIQUE INDEX IF NOT EXISTS ux_simplefin_connection_account
  ON simplefin_account_assignments(tenant_id,item_ref,connection_id,source_account_id)
  WHERE connection_id IS NOT NULL;
ALTER TABLE simplefin_stage_accounts ADD COLUMN transactions_present INTEGER NOT NULL DEFAULT 0;
ALTER TABLE simplefin_stage_accounts ADD COLUMN connection_id TEXT;
ALTER TABLE simplefin_stage_accounts ADD COLUMN source_account_id TEXT;
ALTER TABLE simplefin_stage_accounts ADD COLUMN identity_account_ref TEXT;

-- Capture once before any ledger chunk. Retries must not treat partially
-- imported rows as the pre-change inventory or lose replacement candidates.
CREATE TABLE IF NOT EXISTS simplefin_promotion_intents (
  tenant_id TEXT NOT NULL,
  item_ref TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  revision TEXT NOT NULL,
  before_json TEXT NOT NULL CHECK(json_valid(before_json)),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,item_ref,account_ref,window_start,window_end,revision)
);

-- Only a completely promoted, warning-free account listing supplies a receipt.
CREATE TABLE IF NOT EXISTS simplefin_account_windows (
  tenant_id TEXT NOT NULL,
  item_ref TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  revision TEXT NOT NULL,
  complete INTEGER NOT NULL CHECK(complete IN (0,1)),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,item_ref,account_ref,window_start,window_end)
);

-- Source rows survive reconciliation. Co-presence revokes the relationship.
CREATE TABLE IF NOT EXISTS simplefin_transaction_lineage (
  tenant_id TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  predecessor_id INTEGER NOT NULL REFERENCES fin_transactions(id),
  successor_id INTEGER NOT NULL REFERENCES fin_transactions(id),
  item_ref TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  revision TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  reviewed_at TEXT,
  review_plan_hash TEXT,
  revoked_at TEXT,
  PRIMARY KEY(tenant_id,predecessor_id,successor_id),
  CHECK(predecessor_id<>successor_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_simplefin_active_lineage
  ON simplefin_transaction_lineage(tenant_id,predecessor_id) WHERE revoked_at IS NULL AND reviewed_at IS NOT NULL;

-- Pre-upgrade stages prove neither connection identity nor completeness.
-- Preserve them, rewind history, and require a fresh fenced response.
UPDATE simplefin_connections SET backfill_next=MIN(backfill_next,COALESCE((
  SELECT MIN(w.window_start) FROM simplefin_sync_windows w
  WHERE w.tenant_id=simplefin_connections.tenant_id AND w.item_ref=simplefin_connections.item_ref
),backfill_next));
UPDATE simplefin_sync_windows SET staging_revision='identity-unverified';

CREATE TABLE IF NOT EXISTS simplefin_account_identity_bindings (
  tenant_id TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  bound_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,account_ref)
);


-- SimpleFIN promises a subset, not a complete bank history. A separate owner
-- comparison of exact dates and ledger rows is required to certify a period.
CREATE TABLE IF NOT EXISTS simplefin_coverage_reviews (
  tenant_id TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  covered_from TEXT NOT NULL,
  covered_to TEXT NOT NULL,
  identity_json TEXT NOT NULL,
  transactions_json TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY(tenant_id,account_ref,covered_from,covered_to),
  CHECK(covered_from<=covered_to)
);
