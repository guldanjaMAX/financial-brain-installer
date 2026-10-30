-- 0057_bank_provider_transition
--
-- A local manifest changes before its separately invoked deploy. Keep the live
-- provider authoritative in D1 and fence every old-Worker bank write during
-- that interval. The triggers matter because the Worker that is still live
-- cannot know about code shipped in the pending deploy.

CREATE TABLE IF NOT EXISTS bank_provider_runtime_state (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  deployed_provider     TEXT NOT NULL,
  transition_target     TEXT,
  transition_ref        TEXT,
  transition_started_at TEXT,
  updated_at            TEXT NOT NULL,
  CHECK (deployed_provider IN ('unknown', 'plaid', 'simplefin', 'custom')),
  CHECK (transition_target IS NULL OR transition_target = 'simplefin'),
  CHECK (
    (transition_target IS NULL AND transition_ref IS NULL AND transition_started_at IS NULL) OR
    (transition_target = 'simplefin' AND
     transition_ref NOT GLOB '*[^0-9a-f]*' AND length(transition_ref) = 64 AND
     transition_started_at IS NOT NULL)
  )
);

INSERT OR IGNORE INTO bank_provider_runtime_state
  (id, deployed_provider, transition_target, transition_ref, transition_started_at, updated_at)
SELECT 1,
       CASE
         WHEN EXISTS (
           SELECT 1 FROM bank_feed_items i
           LEFT JOIN simplefin_connections s
             ON s.tenant_id=i.tenant_id AND s.item_ref=i.item_ref
           WHERE i.removed_at IS NULL AND s.item_ref IS NULL
         ) THEN 'plaid'
         WHEN EXISTS (SELECT 1 FROM simplefin_connections) THEN 'simplefin'
         ELSE 'unknown'
       END,
       NULL, NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now');

CREATE TRIGGER IF NOT EXISTS bank_provider_fence_bank_feed_items_insert
BEFORE INSERT ON bank_feed_items
WHEN EXISTS (SELECT 1 FROM bank_provider_runtime_state WHERE id=1 AND transition_target='simplefin')
BEGIN
  SELECT RAISE(ABORT, 'bank provider transition fenced');
END;

CREATE TRIGGER IF NOT EXISTS bank_provider_fence_bank_feed_items_update
BEFORE UPDATE ON bank_feed_items
WHEN EXISTS (SELECT 1 FROM bank_provider_runtime_state WHERE id=1 AND transition_target='simplefin')
BEGIN
  SELECT RAISE(ABORT, 'bank provider transition fenced');
END;

CREATE TRIGGER IF NOT EXISTS bank_provider_fence_fin_entities_insert
BEFORE INSERT ON fin_entities
WHEN NEW.source_feed LIKE 'bank-feed:%' AND
     EXISTS (SELECT 1 FROM bank_provider_runtime_state WHERE id=1 AND transition_target='simplefin')
BEGIN SELECT RAISE(ABORT, 'bank provider transition fenced'); END;
CREATE TRIGGER IF NOT EXISTS bank_provider_fence_fin_entities_update
BEFORE UPDATE ON fin_entities
WHEN (OLD.source_feed LIKE 'bank-feed:%' OR NEW.source_feed LIKE 'bank-feed:%') AND
     EXISTS (SELECT 1 FROM bank_provider_runtime_state WHERE id=1 AND transition_target='simplefin')
BEGIN SELECT RAISE(ABORT, 'bank provider transition fenced'); END;

CREATE TRIGGER IF NOT EXISTS bank_provider_fence_fin_accounts_insert
BEFORE INSERT ON fin_accounts
WHEN NEW.source_feed LIKE 'bank-feed:%' AND
     EXISTS (SELECT 1 FROM bank_provider_runtime_state WHERE id=1 AND transition_target='simplefin')
BEGIN SELECT RAISE(ABORT, 'bank provider transition fenced'); END;
CREATE TRIGGER IF NOT EXISTS bank_provider_fence_fin_accounts_update
BEFORE UPDATE ON fin_accounts
WHEN (OLD.source_feed LIKE 'bank-feed:%' OR NEW.source_feed LIKE 'bank-feed:%') AND
     EXISTS (SELECT 1 FROM bank_provider_runtime_state WHERE id=1 AND transition_target='simplefin')
BEGIN SELECT RAISE(ABORT, 'bank provider transition fenced'); END;

CREATE TRIGGER IF NOT EXISTS bank_provider_fence_fin_account_coverage_insert
BEFORE INSERT ON fin_account_coverage
WHEN NEW.source_feed LIKE 'bank-feed:%' AND
     EXISTS (SELECT 1 FROM bank_provider_runtime_state WHERE id=1 AND transition_target='simplefin')
BEGIN SELECT RAISE(ABORT, 'bank provider transition fenced'); END;
CREATE TRIGGER IF NOT EXISTS bank_provider_fence_fin_account_coverage_update
BEFORE UPDATE ON fin_account_coverage
WHEN (OLD.source_feed LIKE 'bank-feed:%' OR NEW.source_feed LIKE 'bank-feed:%') AND
     EXISTS (SELECT 1 FROM bank_provider_runtime_state WHERE id=1 AND transition_target='simplefin')
BEGIN SELECT RAISE(ABORT, 'bank provider transition fenced'); END;

CREATE TRIGGER IF NOT EXISTS bank_provider_fence_fin_documents_insert
BEFORE INSERT ON fin_documents
WHEN NEW.source_feed LIKE 'bank-feed:%' AND
     EXISTS (SELECT 1 FROM bank_provider_runtime_state WHERE id=1 AND transition_target='simplefin')
BEGIN SELECT RAISE(ABORT, 'bank provider transition fenced'); END;
CREATE TRIGGER IF NOT EXISTS bank_provider_fence_fin_documents_update
BEFORE UPDATE ON fin_documents
WHEN (OLD.source_feed LIKE 'bank-feed:%' OR NEW.source_feed LIKE 'bank-feed:%') AND
     EXISTS (SELECT 1 FROM bank_provider_runtime_state WHERE id=1 AND transition_target='simplefin')
BEGIN SELECT RAISE(ABORT, 'bank provider transition fenced'); END;

CREATE TRIGGER IF NOT EXISTS bank_provider_fence_fin_statements_insert
BEFORE INSERT ON fin_statements
WHEN NEW.source_feed LIKE 'bank-feed:%' AND
     EXISTS (SELECT 1 FROM bank_provider_runtime_state WHERE id=1 AND transition_target='simplefin')
BEGIN SELECT RAISE(ABORT, 'bank provider transition fenced'); END;
CREATE TRIGGER IF NOT EXISTS bank_provider_fence_fin_statements_update
BEFORE UPDATE ON fin_statements
WHEN (OLD.source_feed LIKE 'bank-feed:%' OR NEW.source_feed LIKE 'bank-feed:%') AND
     EXISTS (SELECT 1 FROM bank_provider_runtime_state WHERE id=1 AND transition_target='simplefin')
BEGIN SELECT RAISE(ABORT, 'bank provider transition fenced'); END;

CREATE TRIGGER IF NOT EXISTS bank_provider_fence_fin_transactions_insert
BEFORE INSERT ON fin_transactions
WHEN NEW.source_feed LIKE 'bank-feed:%' AND
     EXISTS (SELECT 1 FROM bank_provider_runtime_state WHERE id=1 AND transition_target='simplefin')
BEGIN SELECT RAISE(ABORT, 'bank provider transition fenced'); END;
CREATE TRIGGER IF NOT EXISTS bank_provider_fence_fin_transactions_update
BEFORE UPDATE ON fin_transactions
WHEN (OLD.source_feed LIKE 'bank-feed:%' OR NEW.source_feed LIKE 'bank-feed:%') AND
     EXISTS (SELECT 1 FROM bank_provider_runtime_state WHERE id=1 AND transition_target='simplefin')
BEGIN SELECT RAISE(ABORT, 'bank provider transition fenced'); END;

CREATE TRIGGER IF NOT EXISTS bank_provider_fence_fin_balance_snapshots_insert
BEFORE INSERT ON fin_balance_snapshots
WHEN NEW.source_feed LIKE 'bank-feed:%' AND
     EXISTS (SELECT 1 FROM bank_provider_runtime_state WHERE id=1 AND transition_target='simplefin')
BEGIN SELECT RAISE(ABORT, 'bank provider transition fenced'); END;
CREATE TRIGGER IF NOT EXISTS bank_provider_fence_fin_balance_snapshots_update
BEFORE UPDATE ON fin_balance_snapshots
WHEN (OLD.source_feed LIKE 'bank-feed:%' OR NEW.source_feed LIKE 'bank-feed:%') AND
     EXISTS (SELECT 1 FROM bank_provider_runtime_state WHERE id=1 AND transition_target='simplefin')
BEGIN SELECT RAISE(ABORT, 'bank provider transition fenced'); END;

CREATE TRIGGER IF NOT EXISTS bank_provider_fence_fin_obligations_insert
BEFORE INSERT ON fin_obligations
WHEN NEW.source_feed LIKE 'bank-feed:%' AND
     EXISTS (SELECT 1 FROM bank_provider_runtime_state WHERE id=1 AND transition_target='simplefin')
BEGIN SELECT RAISE(ABORT, 'bank provider transition fenced'); END;
CREATE TRIGGER IF NOT EXISTS bank_provider_fence_fin_obligations_update
BEFORE UPDATE ON fin_obligations
WHEN (OLD.source_feed LIKE 'bank-feed:%' OR NEW.source_feed LIKE 'bank-feed:%') AND
     EXISTS (SELECT 1 FROM bank_provider_runtime_state WHERE id=1 AND transition_target='simplefin')
BEGIN SELECT RAISE(ABORT, 'bank provider transition fenced'); END;

CREATE TRIGGER IF NOT EXISTS bank_provider_fence_fin_deadlines_insert
BEFORE INSERT ON fin_deadlines
WHEN NEW.source_feed LIKE 'bank-feed:%' AND
     EXISTS (SELECT 1 FROM bank_provider_runtime_state WHERE id=1 AND transition_target='simplefin')
BEGIN SELECT RAISE(ABORT, 'bank provider transition fenced'); END;
CREATE TRIGGER IF NOT EXISTS bank_provider_fence_fin_deadlines_update
BEFORE UPDATE ON fin_deadlines
WHEN (OLD.source_feed LIKE 'bank-feed:%' OR NEW.source_feed LIKE 'bank-feed:%') AND
     EXISTS (SELECT 1 FROM bank_provider_runtime_state WHERE id=1 AND transition_target='simplefin')
BEGIN SELECT RAISE(ABORT, 'bank provider transition fenced'); END;

CREATE TRIGGER IF NOT EXISTS bank_provider_fence_fin_exceptions_insert
BEFORE INSERT ON fin_exceptions
WHEN NEW.source_feed LIKE 'bank-feed:%' AND
     EXISTS (SELECT 1 FROM bank_provider_runtime_state WHERE id=1 AND transition_target='simplefin')
BEGIN SELECT RAISE(ABORT, 'bank provider transition fenced'); END;
CREATE TRIGGER IF NOT EXISTS bank_provider_fence_fin_exceptions_update
BEFORE UPDATE ON fin_exceptions
WHEN (OLD.source_feed LIKE 'bank-feed:%' OR NEW.source_feed LIKE 'bank-feed:%') AND
     EXISTS (SELECT 1 FROM bank_provider_runtime_state WHERE id=1 AND transition_target='simplefin')
BEGIN SELECT RAISE(ABORT, 'bank provider transition fenced'); END;

CREATE TRIGGER IF NOT EXISTS bank_provider_fence_fin_open_items_insert
BEFORE INSERT ON fin_open_items
WHEN NEW.source_feed LIKE 'bank-feed:%' AND
     EXISTS (SELECT 1 FROM bank_provider_runtime_state WHERE id=1 AND transition_target='simplefin')
BEGIN SELECT RAISE(ABORT, 'bank provider transition fenced'); END;
CREATE TRIGGER IF NOT EXISTS bank_provider_fence_fin_open_items_update
BEFORE UPDATE ON fin_open_items
WHEN (OLD.source_feed LIKE 'bank-feed:%' OR NEW.source_feed LIKE 'bank-feed:%') AND
     EXISTS (SELECT 1 FROM bank_provider_runtime_state WHERE id=1 AND transition_target='simplefin')
BEGIN SELECT RAISE(ABORT, 'bank provider transition fenced'); END;

CREATE TRIGGER IF NOT EXISTS bank_provider_fence_fin_reconciliation_claims_insert
BEFORE INSERT ON fin_reconciliation_claims
WHEN NEW.source_feed LIKE 'bank-feed:%' AND
     EXISTS (SELECT 1 FROM bank_provider_runtime_state WHERE id=1 AND transition_target='simplefin')
BEGIN SELECT RAISE(ABORT, 'bank provider transition fenced'); END;
CREATE TRIGGER IF NOT EXISTS bank_provider_fence_fin_reconciliation_claims_update
BEFORE UPDATE ON fin_reconciliation_claims
WHEN (OLD.source_feed LIKE 'bank-feed:%' OR NEW.source_feed LIKE 'bank-feed:%') AND
     EXISTS (SELECT 1 FROM bank_provider_runtime_state WHERE id=1 AND transition_target='simplefin')
BEGIN SELECT RAISE(ABORT, 'bank provider transition fenced'); END;
