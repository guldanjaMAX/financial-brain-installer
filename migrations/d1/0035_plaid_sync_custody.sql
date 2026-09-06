-- 0035_plaid_sync_custody
--
-- A cron, owner refresh and resumed refresh can reach the same Plaid Item at
-- once. A pagination-mutation reset must never erase another invocation's
-- staged prefix. Every sync mutation batch proves this unexpired owner token
-- inside the same D1 transaction. Expired owners cannot write after takeover.
-- The database clock owns expiry; a caller-supplied receipt timestamp does not.
-- A claim's immutable ten-minute hard deadline also bounds a still-running old
-- deployment. Renewals cannot outlive it; the existing twenty-minute update
-- cutover grace remains required before schema changes.

CREATE TABLE IF NOT EXISTS plaid_sync_leases (
  tenant_id TEXT NOT NULL,
  item_ref TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  hard_deadline_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, item_ref),
  CHECK (length(owner_token) > 0),
  CHECK (expires_at > 0 AND expires_at <= hard_deadline_at)
) WITHOUT ROWID;

-- Ordered SHA-256 cursor digests bind every staged page across interruptions.
-- [] marks a legacy window whose prefix must restart from the committed cursor.
ALTER TABLE plaid_sync_windows ADD COLUMN cursor_history_json TEXT NOT NULL DEFAULT '[]';
