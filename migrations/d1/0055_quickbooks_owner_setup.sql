-- Short-lived owner/companion coordination. No provider credentials or content.
CREATE TABLE IF NOT EXISTS quickbooks_owner_setup (
  operation_id TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  installation_fingerprint TEXT NOT NULL,
  public_key TEXT NOT NULL,
  owner_session_hash TEXT,
  stage TEXT NOT NULL DEFAULT 'preparing',
  sequence INTEGER NOT NULL DEFAULT 0,
  last_import_at INTEGER,
  next_check_at INTEGER,
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
  CHECK (length(operation_id) BETWEEN 16 AND 128),
  CHECK (length(installation_fingerprint) = 64),
  CHECK (json_valid(public_key)),
  CHECK (sequence >= 0),
  CHECK (stage IN ('preparing','owner_action','awaiting_intuit','keys_staged','connecting','connected','import_pending','reconnect','revocation_uncertain','disconnected'))
);
CREATE INDEX IF NOT EXISTS quickbooks_owner_setup_expiry ON quickbooks_owner_setup(expires_at);
