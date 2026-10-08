-- 0049_simplefin_bank_feed
--
-- SimpleFIN shares the encrypted bank_feed_items custody boundary and the
-- provider-neutral fin_* ledger. These tables hold only provider-specific
-- claim receipts, request budgets, staged rows, and owner assignments. The
-- Setup Token and Access URL are deliberately absent from every table here.

CREATE TABLE IF NOT EXISTS simplefin_claim_operations (
  tenant_id           TEXT NOT NULL DEFAULT 'primary',
  request_id          TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  state               TEXT NOT NULL,
  item_ref            TEXT,
  error_code          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  PRIMARY KEY (tenant_id, request_id),
  CHECK (request_id GLOB '[A-Za-z0-9_-]*' AND length(request_id) BETWEEN 16 AND 128),
  CHECK (request_fingerprint GLOB '[0-9a-f]*' AND length(request_fingerprint) = 64),
  CHECK (state IN ('claiming', 'claimed', 'outcome_unknown')),
  CHECK (state <> 'claimed' OR item_ref IS NOT NULL),
  CHECK (state <> 'outcome_unknown' OR error_code IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_simplefin_claim_fingerprint
  ON simplefin_claim_operations (tenant_id, request_fingerprint);

CREATE TABLE IF NOT EXISTS simplefin_connections (
  tenant_id          TEXT NOT NULL DEFAULT 'primary',
  item_ref           TEXT NOT NULL,
  backfill_start     TEXT NOT NULL,
  backfill_next      TEXT NOT NULL,
  backfill_end       TEXT NOT NULL,
  next_pull_at       TEXT NOT NULL,
  request_day        TEXT,
  requests_today     INTEGER NOT NULL DEFAULT 0,
  last_errlist_json  TEXT NOT NULL DEFAULT '[]',
  last_pull_partial  INTEGER NOT NULL DEFAULT 0,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (tenant_id, item_ref),
  CHECK (backfill_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (backfill_next GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (backfill_end GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (requests_today BETWEEN 0 AND 24),
  CHECK (json_valid(last_errlist_json)),
  CHECK (last_pull_partial IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_simplefin_connections_due
  ON simplefin_connections (next_pull_at);

CREATE TABLE IF NOT EXISTS simplefin_sync_windows (
  tenant_id       TEXT NOT NULL DEFAULT 'primary',
  item_ref        TEXT NOT NULL,
  window_start    TEXT NOT NULL,
  window_end      TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'staged',
  errlist_json    TEXT NOT NULL DEFAULT '[]',
  fetched_at      TEXT NOT NULL,
  promoted_at     TEXT,
  PRIMARY KEY (tenant_id, item_ref, window_start, window_end),
  CHECK (window_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (window_end GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (state IN ('staged', 'promoted')),
  CHECK (json_valid(errlist_json)),
  CHECK (state <> 'promoted' OR promoted_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS simplefin_account_assignments (
  tenant_id          TEXT NOT NULL DEFAULT 'primary',
  item_ref           TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  account_ref        TEXT NOT NULL,
  account_label      TEXT,
  institution_label  TEXT,
  currency           TEXT NOT NULL,
  entity_slug        TEXT,
  first_seen_at      TEXT NOT NULL,
  last_seen_at       TEXT NOT NULL,
  assigned_at        TEXT,
  PRIMARY KEY (tenant_id, item_ref, provider_account_id),
  UNIQUE (tenant_id, account_ref),
  CHECK (account_ref GLOB 'sfa_[0-9a-f]*' AND length(account_ref) = 36
         AND substr(account_ref, 5) NOT GLOB '*[^0-9a-f]*'),
  CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  CHECK (entity_slug IS NULL OR (entity_slug GLOB '[a-z0-9]*' AND entity_slug NOT GLOB '*[^a-z0-9_-]*'))
);

CREATE INDEX IF NOT EXISTS idx_simplefin_assignment_pending
  ON simplefin_account_assignments (tenant_id, item_ref) WHERE entity_slug IS NULL;

CREATE TABLE IF NOT EXISTS simplefin_assignment_requests (
  tenant_id   TEXT NOT NULL DEFAULT 'primary',
  request_id  TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  entity_slug TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (tenant_id, request_id),
  CHECK (json_valid(response_json))
);

CREATE TABLE IF NOT EXISTS simplefin_stage_accounts (
  tenant_id           TEXT NOT NULL DEFAULT 'primary',
  item_ref            TEXT NOT NULL,
  window_start        TEXT NOT NULL,
  window_end          TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  account_label       TEXT,
  institution_label   TEXT,
  currency            TEXT NOT NULL,
  balance_decimal     TEXT,
  available_decimal   TEXT,
  balance_epoch       INTEGER,
  PRIMARY KEY (tenant_id, item_ref, window_start, window_end, provider_account_id)
);

CREATE TABLE IF NOT EXISTS simplefin_stage_transactions (
  tenant_id              TEXT NOT NULL DEFAULT 'primary',
  item_ref               TEXT NOT NULL,
  window_start           TEXT NOT NULL,
  window_end             TEXT NOT NULL,
  provider_account_id    TEXT NOT NULL,
  provider_transaction_id TEXT NOT NULL,
  posted_epoch           INTEGER,
  transacted_epoch       INTEGER,
  amount_decimal         TEXT,
  description            TEXT,
  payee                  TEXT,
  memo                    TEXT,
  currency               TEXT NOT NULL,
  PRIMARY KEY (
    tenant_id, item_ref, window_start, window_end,
    provider_account_id, provider_transaction_id
  )
);

CREATE INDEX IF NOT EXISTS idx_simplefin_stage_window
  ON simplefin_stage_transactions (tenant_id, item_ref, window_start, window_end);
