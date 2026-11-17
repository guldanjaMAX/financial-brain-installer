-- Quarantine precedes exchange; one D1 batch is the only publication boundary.
-- Old runtime SQL is fenced in the database, including already-held leases.
CREATE TABLE IF NOT EXISTS plaid_item_replacements (
  tenant_id TEXT NOT NULL, operation_ref TEXT NOT NULL,
  old_item_ref TEXT NOT NULL, new_item_ref TEXT,
  state TEXT NOT NULL, snapshot_json TEXT NOT NULL, plan_hash TEXT NOT NULL, diagnosis_json TEXT NOT NULL,
  approved_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0, cursor TEXT, pages INTEGER NOT NULL DEFAULT 0,
  history_state TEXT, inventory_json TEXT, review_hash TEXT, review_snapshot TEXT,
  published_revision INTEGER NOT NULL DEFAULT 0, publishing INTEGER NOT NULL DEFAULT 0,
  fetch_owner TEXT, fetch_expires_at TEXT, updated_at TEXT NOT NULL,
  revocation_disposition TEXT NOT NULL DEFAULT 'unavailable_unreadable',
  PRIMARY KEY (tenant_id,operation_ref),
  CHECK (old_item_ref<>new_item_ref), CHECK (publishing IN (0,1)),
  CHECK (state IN ('owner_approved','link_pending','exchange_claimed','outcome_unknown','candidate_staged','history_review','active','rolled_back','cancelled'))
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS ux_plaid_replacement_old ON plaid_item_replacements(tenant_id,old_item_ref)
  WHERE state NOT IN ('cancelled','rolled_back');
CREATE UNIQUE INDEX IF NOT EXISTS ux_plaid_replacement_new ON plaid_item_replacements(tenant_id,new_item_ref) WHERE new_item_ref IS NOT NULL;
CREATE TABLE IF NOT EXISTS plaid_replacement_bindings (
  tenant_id TEXT NOT NULL,operation_ref TEXT NOT NULL,account_slug TEXT NOT NULL,
  old_provider_id TEXT NOT NULL,new_provider_id TEXT NOT NULL,new_account_ref TEXT NOT NULL,
  old_account_json TEXT NOT NULL,confirmed_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,operation_ref,account_slug),
  UNIQUE(tenant_id,operation_ref,new_provider_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS plaid_replacement_events (
  tenant_id TEXT NOT NULL,operation_ref TEXT NOT NULL,revision INTEGER NOT NULL,
  event_index INTEGER NOT NULL,provider_id TEXT NOT NULL,provider_account_id TEXT,
  payload_json TEXT NOT NULL,digest TEXT NOT NULL,
  PRIMARY KEY(tenant_id,operation_ref,revision,event_index)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS plaid_replacement_decisions (
  tenant_id TEXT NOT NULL,operation_ref TEXT NOT NULL,revision INTEGER NOT NULL,event_index INTEGER NOT NULL,
  action TEXT NOT NULL,old_row_id INTEGER,evidence TEXT NOT NULL,
  PRIMARY KEY(tenant_id,operation_ref,revision,event_index),
  CHECK(action IN ('admit','duplicate','replace','remove','review'))
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS ux_plaid_replacement_consumption ON plaid_replacement_decisions
  (tenant_id,operation_ref,revision,old_row_id) WHERE old_row_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS plaid_replacement_aliases (
  tenant_id TEXT NOT NULL,operation_ref TEXT NOT NULL,provider_id TEXT NOT NULL,
  account_slug TEXT NOT NULL,canonical_row_id INTEGER NOT NULL,created_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,operation_ref,provider_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS bank_account_coverage_intervals (
  tenant_id TEXT NOT NULL,account_slug TEXT NOT NULL,operation_ref TEXT NOT NULL,revision INTEGER NOT NULL,
  covered_from TEXT NOT NULL,covered_to TEXT NOT NULL,evidence TEXT NOT NULL,observed_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,account_slug,operation_ref,revision,covered_from,covered_to),
  CHECK(covered_from<=covered_to)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS plaid_replacement_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id TEXT NOT NULL,operation_ref TEXT NOT NULL,
  revision INTEGER NOT NULL,event TEXT NOT NULL,recorded_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS replacement_audit_no_update BEFORE UPDATE ON plaid_replacement_audit
BEGIN SELECT RAISE(ABORT,'replacement audit is append only'); END;
CREATE TRIGGER IF NOT EXISTS replacement_audit_no_delete BEFORE DELETE ON plaid_replacement_audit
BEGIN SELECT RAISE(ABORT,'replacement audit is append only'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_bank_feed_items_insert
BEFORE INSERT ON bank_feed_items
WHEN EXISTS(SELECT 1 FROM plaid_item_replacements r WHERE r.tenant_id=NEW.tenant_id AND r.publishing=0
 AND ((r.old_item_ref=NEW.item_ref AND r.state NOT IN ('cancelled','rolled_back'))
   OR (r.new_item_ref=NEW.item_ref AND r.state<>'cancelled')))
BEGIN SELECT RAISE(ABORT,'bank replacement writer fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_bank_feed_items_update
BEFORE UPDATE ON bank_feed_items
WHEN EXISTS(SELECT 1 FROM plaid_item_replacements r WHERE r.tenant_id=NEW.tenant_id AND r.publishing=0
 AND ((r.old_item_ref=NEW.item_ref AND r.state NOT IN ('cancelled','rolled_back'))
   OR (r.new_item_ref=NEW.item_ref AND r.state<>'cancelled')))
BEGIN SELECT RAISE(ABORT,'bank replacement writer fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_bank_feed_items_delete
BEFORE DELETE ON bank_feed_items
WHEN EXISTS(SELECT 1 FROM plaid_item_replacements r WHERE r.tenant_id=OLD.tenant_id AND r.publishing=0
 AND ((r.old_item_ref=OLD.item_ref AND r.state NOT IN ('cancelled','rolled_back'))
   OR (r.new_item_ref=OLD.item_ref AND r.state<>'cancelled')))
BEGIN SELECT RAISE(ABORT,'bank replacement writer fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_bank_feed_backfill_insert
BEFORE INSERT ON bank_feed_backfill
WHEN EXISTS(SELECT 1 FROM plaid_item_replacements r WHERE r.tenant_id=NEW.tenant_id AND r.publishing=0
 AND ((r.old_item_ref=NEW.item_ref AND r.state NOT IN ('cancelled','rolled_back'))
   OR (r.new_item_ref=NEW.item_ref AND r.state<>'cancelled')))
BEGIN SELECT RAISE(ABORT,'bank replacement writer fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_bank_feed_backfill_update
BEFORE UPDATE ON bank_feed_backfill
WHEN EXISTS(SELECT 1 FROM plaid_item_replacements r WHERE r.tenant_id=NEW.tenant_id AND r.publishing=0
 AND ((r.old_item_ref=NEW.item_ref AND r.state NOT IN ('cancelled','rolled_back'))
   OR (r.new_item_ref=NEW.item_ref AND r.state<>'cancelled')))
BEGIN SELECT RAISE(ABORT,'bank replacement writer fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_bank_feed_backfill_delete
BEFORE DELETE ON bank_feed_backfill
WHEN EXISTS(SELECT 1 FROM plaid_item_replacements r WHERE r.tenant_id=OLD.tenant_id AND r.publishing=0
 AND ((r.old_item_ref=OLD.item_ref AND r.state NOT IN ('cancelled','rolled_back'))
   OR (r.new_item_ref=OLD.item_ref AND r.state<>'cancelled')))
BEGIN SELECT RAISE(ABORT,'bank replacement writer fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_plaid_reconciliation_insert
BEFORE INSERT ON plaid_reconciliation
WHEN EXISTS(SELECT 1 FROM plaid_item_replacements r WHERE r.tenant_id=NEW.tenant_id AND r.publishing=0
 AND ((r.old_item_ref=NEW.item_ref AND r.state NOT IN ('cancelled','rolled_back'))
   OR (r.new_item_ref=NEW.item_ref AND r.state<>'cancelled')))
BEGIN SELECT RAISE(ABORT,'bank replacement writer fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_plaid_reconciliation_update
BEFORE UPDATE ON plaid_reconciliation
WHEN EXISTS(SELECT 1 FROM plaid_item_replacements r WHERE r.tenant_id=NEW.tenant_id AND r.publishing=0
 AND ((r.old_item_ref=NEW.item_ref AND r.state NOT IN ('cancelled','rolled_back'))
   OR (r.new_item_ref=NEW.item_ref AND r.state<>'cancelled')))
BEGIN SELECT RAISE(ABORT,'bank replacement writer fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_plaid_reconciliation_delete
BEFORE DELETE ON plaid_reconciliation
WHEN EXISTS(SELECT 1 FROM plaid_item_replacements r WHERE r.tenant_id=OLD.tenant_id AND r.publishing=0
 AND ((r.old_item_ref=OLD.item_ref AND r.state NOT IN ('cancelled','rolled_back'))
   OR (r.new_item_ref=OLD.item_ref AND r.state<>'cancelled')))
BEGIN SELECT RAISE(ABORT,'bank replacement writer fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_bank_feed_health_insert
BEFORE INSERT ON bank_feed_health
WHEN EXISTS(SELECT 1 FROM plaid_item_replacements r WHERE r.tenant_id=NEW.tenant_id AND r.publishing=0
 AND ((r.old_item_ref=NEW.item_ref AND r.state NOT IN ('cancelled','rolled_back'))
   OR (r.new_item_ref=NEW.item_ref AND r.state<>'cancelled')))
BEGIN SELECT RAISE(ABORT,'bank replacement writer fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_bank_feed_health_update
BEFORE UPDATE ON bank_feed_health
WHEN EXISTS(SELECT 1 FROM plaid_item_replacements r WHERE r.tenant_id=NEW.tenant_id AND r.publishing=0
 AND ((r.old_item_ref=NEW.item_ref AND r.state NOT IN ('cancelled','rolled_back'))
   OR (r.new_item_ref=NEW.item_ref AND r.state<>'cancelled')))
BEGIN SELECT RAISE(ABORT,'bank replacement writer fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_bank_feed_health_delete
BEFORE DELETE ON bank_feed_health
WHEN EXISTS(SELECT 1 FROM plaid_item_replacements r WHERE r.tenant_id=OLD.tenant_id AND r.publishing=0
 AND ((r.old_item_ref=OLD.item_ref AND r.state NOT IN ('cancelled','rolled_back'))
   OR (r.new_item_ref=OLD.item_ref AND r.state<>'cancelled')))
BEGIN SELECT RAISE(ABORT,'bank replacement writer fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_plaid_sync_windows_insert
BEFORE INSERT ON plaid_sync_windows
WHEN EXISTS(SELECT 1 FROM plaid_item_replacements r WHERE r.tenant_id=NEW.tenant_id AND r.publishing=0
 AND ((r.old_item_ref=NEW.item_ref AND r.state NOT IN ('cancelled','rolled_back'))
   OR (r.new_item_ref=NEW.item_ref AND r.state<>'cancelled')))
BEGIN SELECT RAISE(ABORT,'bank replacement writer fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_plaid_sync_windows_update
BEFORE UPDATE ON plaid_sync_windows
WHEN EXISTS(SELECT 1 FROM plaid_item_replacements r WHERE r.tenant_id=NEW.tenant_id AND r.publishing=0
 AND ((r.old_item_ref=NEW.item_ref AND r.state NOT IN ('cancelled','rolled_back'))
   OR (r.new_item_ref=NEW.item_ref AND r.state<>'cancelled')))
BEGIN SELECT RAISE(ABORT,'bank replacement writer fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_plaid_sync_windows_delete
BEFORE DELETE ON plaid_sync_windows
WHEN EXISTS(SELECT 1 FROM plaid_item_replacements r WHERE r.tenant_id=OLD.tenant_id AND r.publishing=0
 AND ((r.old_item_ref=OLD.item_ref AND r.state NOT IN ('cancelled','rolled_back'))
   OR (r.new_item_ref=OLD.item_ref AND r.state<>'cancelled')))
BEGIN SELECT RAISE(ABORT,'bank replacement writer fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_plaid_sync_leases_insert
BEFORE INSERT ON plaid_sync_leases
WHEN EXISTS(SELECT 1 FROM plaid_item_replacements r WHERE r.tenant_id=NEW.tenant_id AND r.publishing=0
 AND ((r.old_item_ref=NEW.item_ref AND r.state NOT IN ('cancelled','rolled_back'))
   OR (r.new_item_ref=NEW.item_ref AND r.state<>'cancelled')))
BEGIN SELECT RAISE(ABORT,'bank replacement writer fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_plaid_sync_leases_update
BEFORE UPDATE ON plaid_sync_leases
WHEN EXISTS(SELECT 1 FROM plaid_item_replacements r WHERE r.tenant_id=NEW.tenant_id AND r.publishing=0
 AND ((r.old_item_ref=NEW.item_ref AND r.state NOT IN ('cancelled','rolled_back'))
   OR (r.new_item_ref=NEW.item_ref AND r.state<>'cancelled')))
BEGIN SELECT RAISE(ABORT,'bank replacement writer fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_plaid_sync_leases_delete
BEFORE DELETE ON plaid_sync_leases
WHEN EXISTS(SELECT 1 FROM plaid_item_replacements r WHERE r.tenant_id=OLD.tenant_id AND r.publishing=0
 AND ((r.old_item_ref=OLD.item_ref AND r.state NOT IN ('cancelled','rolled_back'))
   OR (r.new_item_ref=OLD.item_ref AND r.state<>'cancelled')))
BEGIN SELECT RAISE(ABORT,'bank replacement writer fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_fin_accounts_insert
BEFORE INSERT ON fin_accounts
WHEN EXISTS(SELECT 1 FROM plaid_item_replacements r WHERE r.publishing=0 AND ((r.tenant_id=NEW.tenant_id AND ((NEW.source_feed='bank-feed:'||r.old_item_ref AND r.state NOT IN ('cancelled','rolled_back')) OR (NEW.source_feed='bank-feed:'||r.new_item_ref AND r.state<>'cancelled')))))
BEGIN SELECT RAISE(ABORT,'bank replacement ledger fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_fin_accounts_update
BEFORE UPDATE ON fin_accounts
WHEN EXISTS(SELECT 1 FROM plaid_item_replacements r WHERE r.publishing=0 AND ((r.tenant_id=OLD.tenant_id AND ((OLD.source_feed='bank-feed:'||r.old_item_ref AND r.state NOT IN ('cancelled','rolled_back')) OR (OLD.source_feed='bank-feed:'||r.new_item_ref AND r.state<>'cancelled'))) OR (r.tenant_id=NEW.tenant_id AND ((NEW.source_feed='bank-feed:'||r.old_item_ref AND r.state NOT IN ('cancelled','rolled_back')) OR (NEW.source_feed='bank-feed:'||r.new_item_ref AND r.state<>'cancelled')))))
BEGIN SELECT RAISE(ABORT,'bank replacement ledger fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_fin_accounts_delete
BEFORE DELETE ON fin_accounts
WHEN EXISTS(SELECT 1 FROM plaid_item_replacements r WHERE r.publishing=0 AND ((r.tenant_id=OLD.tenant_id AND ((OLD.source_feed='bank-feed:'||r.old_item_ref AND r.state NOT IN ('cancelled','rolled_back')) OR (OLD.source_feed='bank-feed:'||r.new_item_ref AND r.state<>'cancelled')))))
BEGIN SELECT RAISE(ABORT,'bank replacement ledger fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_fin_transactions_insert
BEFORE INSERT ON fin_transactions
WHEN EXISTS(SELECT 1 FROM plaid_item_replacements r WHERE r.publishing=0 AND ((r.tenant_id=NEW.tenant_id AND ((NEW.source_feed='bank-feed:'||r.old_item_ref AND r.state NOT IN ('cancelled','rolled_back')) OR (NEW.source_feed='bank-feed:'||r.new_item_ref AND r.state<>'cancelled')))))
BEGIN SELECT RAISE(ABORT,'bank replacement ledger fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_fin_transactions_update
BEFORE UPDATE ON fin_transactions
WHEN EXISTS(SELECT 1 FROM plaid_item_replacements r WHERE r.publishing=0 AND ((r.tenant_id=OLD.tenant_id AND ((OLD.source_feed='bank-feed:'||r.old_item_ref AND r.state NOT IN ('cancelled','rolled_back')) OR (OLD.source_feed='bank-feed:'||r.new_item_ref AND r.state<>'cancelled'))) OR (r.tenant_id=NEW.tenant_id AND ((NEW.source_feed='bank-feed:'||r.old_item_ref AND r.state NOT IN ('cancelled','rolled_back')) OR (NEW.source_feed='bank-feed:'||r.new_item_ref AND r.state<>'cancelled')))))
BEGIN SELECT RAISE(ABORT,'bank replacement ledger fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_fin_transactions_delete
BEFORE DELETE ON fin_transactions
WHEN EXISTS(SELECT 1 FROM plaid_item_replacements r WHERE r.publishing=0 AND ((r.tenant_id=OLD.tenant_id AND ((OLD.source_feed='bank-feed:'||r.old_item_ref AND r.state NOT IN ('cancelled','rolled_back')) OR (OLD.source_feed='bank-feed:'||r.new_item_ref AND r.state<>'cancelled')))))
BEGIN SELECT RAISE(ABORT,'bank replacement ledger fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_fin_balance_snapshots_insert
BEFORE INSERT ON fin_balance_snapshots
WHEN EXISTS(SELECT 1 FROM plaid_item_replacements r WHERE r.publishing=0 AND ((r.tenant_id=NEW.tenant_id AND ((NEW.source_feed='bank-feed:'||r.old_item_ref AND r.state NOT IN ('cancelled','rolled_back')) OR (NEW.source_feed='bank-feed:'||r.new_item_ref AND r.state<>'cancelled')))))
BEGIN SELECT RAISE(ABORT,'bank replacement ledger fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_fin_balance_snapshots_update
BEFORE UPDATE ON fin_balance_snapshots
WHEN EXISTS(SELECT 1 FROM plaid_item_replacements r WHERE r.publishing=0 AND ((r.tenant_id=OLD.tenant_id AND ((OLD.source_feed='bank-feed:'||r.old_item_ref AND r.state NOT IN ('cancelled','rolled_back')) OR (OLD.source_feed='bank-feed:'||r.new_item_ref AND r.state<>'cancelled'))) OR (r.tenant_id=NEW.tenant_id AND ((NEW.source_feed='bank-feed:'||r.old_item_ref AND r.state NOT IN ('cancelled','rolled_back')) OR (NEW.source_feed='bank-feed:'||r.new_item_ref AND r.state<>'cancelled')))))
BEGIN SELECT RAISE(ABORT,'bank replacement ledger fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_fin_balance_snapshots_delete
BEFORE DELETE ON fin_balance_snapshots
WHEN EXISTS(SELECT 1 FROM plaid_item_replacements r WHERE r.publishing=0 AND ((r.tenant_id=OLD.tenant_id AND ((OLD.source_feed='bank-feed:'||r.old_item_ref AND r.state NOT IN ('cancelled','rolled_back')) OR (OLD.source_feed='bank-feed:'||r.new_item_ref AND r.state<>'cancelled')))))
BEGIN SELECT RAISE(ABORT,'bank replacement ledger fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_fin_account_coverage_insert
BEFORE INSERT ON fin_account_coverage
WHEN EXISTS(SELECT 1 FROM plaid_item_replacements r WHERE r.publishing=0 AND ((r.tenant_id=NEW.tenant_id AND ((NEW.source_feed='bank-feed:'||r.old_item_ref AND r.state NOT IN ('cancelled','rolled_back')) OR (NEW.source_feed='bank-feed:'||r.new_item_ref AND r.state<>'cancelled')))))
BEGIN SELECT RAISE(ABORT,'bank replacement ledger fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_fin_account_coverage_update
BEFORE UPDATE ON fin_account_coverage
WHEN EXISTS(SELECT 1 FROM plaid_item_replacements r WHERE r.publishing=0 AND ((r.tenant_id=OLD.tenant_id AND ((OLD.source_feed='bank-feed:'||r.old_item_ref AND r.state NOT IN ('cancelled','rolled_back')) OR (OLD.source_feed='bank-feed:'||r.new_item_ref AND r.state<>'cancelled'))) OR (r.tenant_id=NEW.tenant_id AND ((NEW.source_feed='bank-feed:'||r.old_item_ref AND r.state NOT IN ('cancelled','rolled_back')) OR (NEW.source_feed='bank-feed:'||r.new_item_ref AND r.state<>'cancelled')))))
BEGIN SELECT RAISE(ABORT,'bank replacement ledger fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_fin_account_coverage_delete
BEFORE DELETE ON fin_account_coverage
WHEN EXISTS(SELECT 1 FROM plaid_item_replacements r WHERE r.publishing=0 AND ((r.tenant_id=OLD.tenant_id AND ((OLD.source_feed='bank-feed:'||r.old_item_ref AND r.state NOT IN ('cancelled','rolled_back')) OR (OLD.source_feed='bank-feed:'||r.new_item_ref AND r.state<>'cancelled')))))
BEGIN SELECT RAISE(ABORT,'bank replacement ledger fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_fin_obligations_insert
BEFORE INSERT ON fin_obligations
WHEN EXISTS(SELECT 1 FROM plaid_item_replacements r WHERE r.publishing=0 AND ((r.tenant_id=NEW.tenant_id AND ((NEW.source_feed='bank-feed:'||r.old_item_ref AND r.state NOT IN ('cancelled','rolled_back')) OR (NEW.source_feed='bank-feed:'||r.new_item_ref AND r.state<>'cancelled')))))
BEGIN SELECT RAISE(ABORT,'bank replacement ledger fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_fin_obligations_update
BEFORE UPDATE ON fin_obligations
WHEN EXISTS(SELECT 1 FROM plaid_item_replacements r WHERE r.publishing=0 AND ((r.tenant_id=OLD.tenant_id AND ((OLD.source_feed='bank-feed:'||r.old_item_ref AND r.state NOT IN ('cancelled','rolled_back')) OR (OLD.source_feed='bank-feed:'||r.new_item_ref AND r.state<>'cancelled'))) OR (r.tenant_id=NEW.tenant_id AND ((NEW.source_feed='bank-feed:'||r.old_item_ref AND r.state NOT IN ('cancelled','rolled_back')) OR (NEW.source_feed='bank-feed:'||r.new_item_ref AND r.state<>'cancelled')))))
BEGIN SELECT RAISE(ABORT,'bank replacement ledger fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_fin_obligations_delete
BEFORE DELETE ON fin_obligations
WHEN EXISTS(SELECT 1 FROM plaid_item_replacements r WHERE r.publishing=0 AND ((r.tenant_id=OLD.tenant_id AND ((OLD.source_feed='bank-feed:'||r.old_item_ref AND r.state NOT IN ('cancelled','rolled_back')) OR (OLD.source_feed='bank-feed:'||r.new_item_ref AND r.state<>'cancelled')))))
BEGIN SELECT RAISE(ABORT,'bank replacement ledger fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_plaid_sync_stage_accounts_insert
BEFORE INSERT ON plaid_sync_stage_accounts
WHEN EXISTS(SELECT 1 FROM plaid_sync_windows w JOIN plaid_item_replacements r
 ON r.tenant_id=w.tenant_id AND r.publishing=0 AND
 ((r.old_item_ref=w.item_ref AND r.state NOT IN ('cancelled','rolled_back')) OR (r.new_item_ref=w.item_ref AND r.state<>'cancelled'))
 WHERE w.tenant_id=NEW.tenant_id AND w.window_ref=NEW.window_ref)
BEGIN SELECT RAISE(ABORT,'bank replacement stage fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_plaid_sync_stage_accounts_update
BEFORE UPDATE ON plaid_sync_stage_accounts
WHEN EXISTS(SELECT 1 FROM plaid_sync_windows w JOIN plaid_item_replacements r
 ON r.tenant_id=w.tenant_id AND r.publishing=0 AND
 ((r.old_item_ref=w.item_ref AND r.state NOT IN ('cancelled','rolled_back')) OR (r.new_item_ref=w.item_ref AND r.state<>'cancelled'))
 WHERE w.tenant_id=NEW.tenant_id AND w.window_ref=NEW.window_ref)
BEGIN SELECT RAISE(ABORT,'bank replacement stage fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_plaid_sync_stage_accounts_delete
BEFORE DELETE ON plaid_sync_stage_accounts
WHEN EXISTS(SELECT 1 FROM plaid_sync_windows w JOIN plaid_item_replacements r
 ON r.tenant_id=w.tenant_id AND r.publishing=0 AND
 ((r.old_item_ref=w.item_ref AND r.state NOT IN ('cancelled','rolled_back')) OR (r.new_item_ref=w.item_ref AND r.state<>'cancelled'))
 WHERE w.tenant_id=OLD.tenant_id AND w.window_ref=OLD.window_ref)
BEGIN SELECT RAISE(ABORT,'bank replacement stage fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_plaid_sync_stage_transactions_insert
BEFORE INSERT ON plaid_sync_stage_transactions
WHEN EXISTS(SELECT 1 FROM plaid_sync_windows w JOIN plaid_item_replacements r
 ON r.tenant_id=w.tenant_id AND r.publishing=0 AND
 ((r.old_item_ref=w.item_ref AND r.state NOT IN ('cancelled','rolled_back')) OR (r.new_item_ref=w.item_ref AND r.state<>'cancelled'))
 WHERE w.tenant_id=NEW.tenant_id AND w.window_ref=NEW.window_ref)
BEGIN SELECT RAISE(ABORT,'bank replacement stage fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_plaid_sync_stage_transactions_update
BEFORE UPDATE ON plaid_sync_stage_transactions
WHEN EXISTS(SELECT 1 FROM plaid_sync_windows w JOIN plaid_item_replacements r
 ON r.tenant_id=w.tenant_id AND r.publishing=0 AND
 ((r.old_item_ref=w.item_ref AND r.state NOT IN ('cancelled','rolled_back')) OR (r.new_item_ref=w.item_ref AND r.state<>'cancelled'))
 WHERE w.tenant_id=NEW.tenant_id AND w.window_ref=NEW.window_ref)
BEGIN SELECT RAISE(ABORT,'bank replacement stage fenced'); END;

CREATE TRIGGER IF NOT EXISTS replacement_fence_plaid_sync_stage_transactions_delete
BEFORE DELETE ON plaid_sync_stage_transactions
WHEN EXISTS(SELECT 1 FROM plaid_sync_windows w JOIN plaid_item_replacements r
 ON r.tenant_id=w.tenant_id AND r.publishing=0 AND
 ((r.old_item_ref=w.item_ref AND r.state NOT IN ('cancelled','rolled_back')) OR (r.new_item_ref=w.item_ref AND r.state<>'cancelled'))
 WHERE w.tenant_id=OLD.tenant_id AND w.window_ref=OLD.window_ref)
BEGIN SELECT RAISE(ABORT,'bank replacement stage fenced'); END;

-- The ledger keeps one visible balance per day. Preserve replaced observations
-- separately before the reviewed same-day successor becomes visible.
CREATE TABLE IF NOT EXISTS plaid_replacement_balance_evidence (
  tenant_id TEXT NOT NULL,operation_ref TEXT NOT NULL,revision INTEGER NOT NULL,
  balance_id INTEGER NOT NULL,snapshot_json TEXT NOT NULL,recorded_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,operation_ref,revision,balance_id)
) WITHOUT ROWID;
