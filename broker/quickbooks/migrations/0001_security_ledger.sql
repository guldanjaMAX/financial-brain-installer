-- Broker-only schema. Never apply this migration to an owner Brain database.
-- Deliberately no arbitrary JSON, URLs, company identity or credential columns.
CREATE TABLE IF NOT EXISTS qbo_broker_events (
  protocol TEXT NOT NULL CHECK (protocol = 'qbo-broker/1'),
  event_id_hash TEXT PRIMARY KEY NOT NULL CHECK (length(event_id_hash) = 43 AND event_id_hash NOT GLOB '*[^A-Za-z0-9_-]*'),
  request_id_hash TEXT CHECK (request_id_hash IS NULL OR (length(request_id_hash) = 43 AND request_id_hash NOT GLOB '*[^A-Za-z0-9_-]*')),
  route TEXT NOT NULL CHECK (route IN ('/v1/quickbooks/installations/issue','/v1/quickbooks/authorizations','/v1/quickbooks/launch','/v1/quickbooks/oauth/callback','/v1/quickbooks/tokens/refresh','/v1/quickbooks/tokens/revoke','/health')),
  install_fingerprint TEXT CHECK (install_fingerprint IS NULL OR (length(install_fingerprint) = 43 AND install_fingerprint NOT GLOB '*[^A-Za-z0-9_-]*')),
  intent_hash TEXT CHECK (intent_hash IS NULL OR (length(intent_hash) = 43 AND intent_hash NOT GLOB '*[^A-Za-z0-9_-]*')),
  state_hash TEXT CHECK (state_hash IS NULL OR (length(state_hash) = 43 AND state_hash NOT GLOB '*[^A-Za-z0-9_-]*')),
  phase TEXT NOT NULL CHECK (phase IN ('enrollment','start','launched','exchange_started','delivered','refresh_started','refreshed','revoke_started','revoked','failed','canceled','expired','not_sent','proof_consumed')),
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted','delivered','refreshed','revoked','owner_canceled','invalid_request','unauthorized','expired','replayed','binding_mismatch','quota_exceeded','ledger_unavailable','provider_rejected','provider_uncertain','delivery_unconfirmed','receipt_invalid','wrapping_key_unavailable','reauthorization_required','no_provider_contact','local_destroyed_remote_unknown','failed','manual_provider_removal_required')),
  http_status_class TEXT NOT NULL CHECK (http_status_class IN ('2xx','3xx','4xx','5xx')),
  build_id TEXT NOT NULL CHECK (length(build_id) = 43 AND build_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  key_generation INTEGER NOT NULL CHECK (key_generation BETWEEN 1 AND 9007199254740991),
  created_at INTEGER NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at AND expires_at <= 9007199254740991),
  duration_ms INTEGER NOT NULL CHECK (duration_ms BETWEEN 0 AND 600000),
  attempt_count INTEGER NOT NULL CHECK (attempt_count BETWEEN 0 AND 3),
  retention_ms INTEGER NOT NULL CHECK (retention_ms BETWEEN 1 AND 2592000000),
  CHECK (expires_at <= created_at + retention_ms)
) STRICT;
CREATE INDEX IF NOT EXISTS qbo_broker_events_expiry ON qbo_broker_events(expires_at);
CREATE INDEX IF NOT EXISTS qbo_broker_events_revocation ON qbo_broker_events(install_fingerprint, phase, expires_at);
CREATE INDEX IF NOT EXISTS qbo_broker_events_circuit ON qbo_broker_events(route, outcome, created_at);

CREATE TABLE IF NOT EXISTS qbo_broker_replays (
  protocol TEXT NOT NULL CHECK (protocol = 'qbo-broker/1'),
  route TEXT NOT NULL CHECK (route IN ('/v1/quickbooks/installations/issue','/v1/quickbooks/authorizations','/v1/quickbooks/launch','/v1/quickbooks/oauth/callback','/v1/quickbooks/tokens/refresh','/v1/quickbooks/tokens/revoke','/health')),
  request_id_hash TEXT PRIMARY KEY NOT NULL CHECK (length(request_id_hash) = 43 AND request_id_hash NOT GLOB '*[^A-Za-z0-9_-]*'),
  state_hash TEXT UNIQUE CHECK (state_hash IS NULL OR (length(state_hash) = 43 AND state_hash NOT GLOB '*[^A-Za-z0-9_-]*')),
  intent_hash TEXT CHECK (intent_hash IS NULL OR (length(intent_hash) = 43 AND intent_hash NOT GLOB '*[^A-Za-z0-9_-]*')),
  install_fingerprint TEXT NOT NULL CHECK (length(install_fingerprint) = 43 AND install_fingerprint NOT GLOB '*[^A-Za-z0-9_-]*'),
  phase TEXT NOT NULL CHECK (phase IN ('enrollment','start','launched','exchange_started','delivered','refresh_started','refreshed','revoke_started','revoked','failed','canceled','expired','not_sent','proof_consumed')),
  provider_attempts INTEGER NOT NULL CHECK (provider_attempts BETWEEN 0 AND 1),
  key_generation INTEGER NOT NULL CHECK (key_generation BETWEEN 1 AND 9007199254740991),
  created_at INTEGER NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at AND expires_at <= 9007199254740991 AND expires_at <= created_at + 2592000000),
  CHECK (phase NOT IN ('exchange_started','refresh_started','refreshed','revoke_started','revoked') OR provider_attempts = 1),
  CHECK (phase NOT IN ('enrollment','start','launched','canceled','expired','not_sent','proof_consumed') OR provider_attempts = 0),
  CHECK (route NOT IN ('/v1/quickbooks/tokens/refresh','/v1/quickbooks/tokens/revoke') OR intent_hash IS NOT NULL)
) STRICT;
CREATE INDEX IF NOT EXISTS qbo_broker_replays_expiry ON qbo_broker_replays(expires_at);
CREATE INDEX IF NOT EXISTS qbo_broker_replays_rate ON qbo_broker_replays(route, install_fingerprint, created_at);
-- A fresh request ID never authorizes repeating a token operation. The sole
-- exception replaces not_sent with proof_consumed in the same transaction.
CREATE UNIQUE INDEX IF NOT EXISTS qbo_broker_token_operation ON qbo_broker_replays(route, install_fingerprint, intent_hash)
  WHERE route IN ('/v1/quickbooks/tokens/refresh','/v1/quickbooks/tokens/revoke') AND phase <> 'proof_consumed';

CREATE TABLE IF NOT EXISTS qbo_broker_quotas (
  protocol TEXT NOT NULL CHECK (protocol = 'qbo-broker/1'),
  route TEXT NOT NULL CHECK (route IN ('/v1/quickbooks/installations/issue','/v1/quickbooks/authorizations','/v1/quickbooks/launch','/v1/quickbooks/oauth/callback','/v1/quickbooks/tokens/refresh','/v1/quickbooks/tokens/revoke','/health')),
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('install','network','global')),
  subject_hash TEXT NOT NULL CHECK (length(subject_hash) = 43 AND subject_hash NOT GLOB '*[^A-Za-z0-9_-]*'),
  window_start INTEGER NOT NULL CHECK (window_start BETWEEN 0 AND 9007199254740991),
  window_ms INTEGER NOT NULL CHECK (window_ms BETWEEN 1 AND 3600000),
  count INTEGER NOT NULL CHECK (count BETWEEN 0 AND 1000000000),
  expires_at INTEGER NOT NULL CHECK (expires_at > window_start AND expires_at <= 9007199254740991),
  retention_ms INTEGER NOT NULL CHECK (retention_ms BETWEEN 1 AND 1200000),
  PRIMARY KEY (route, subject_kind, subject_hash, window_start, window_ms),
  CHECK (expires_at <= window_start + retention_ms)
) STRICT;
CREATE INDEX IF NOT EXISTS qbo_broker_quotas_expiry ON qbo_broker_quotas(expires_at);

-- This global readiness record contains deployment identity, never install data.
CREATE TABLE IF NOT EXISTS qbo_broker_readiness (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  build_id TEXT NOT NULL CHECK (length(build_id) = 43 AND build_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  key_generation INTEGER NOT NULL CHECK (key_generation BETWEEN 1 AND 9007199254740991),
  ready INTEGER NOT NULL CHECK (ready IN (0,1)),
  updated_at INTEGER NOT NULL CHECK (updated_at BETWEEN 0 AND 9007199254740991)
) STRICT;
