-- 0047_custom_api_source
--
-- Current structured rows from a declarative read-only business API remain
-- queryable without asking the language model to recover exact figures from
-- prose. Searchable documents are still written through the ordinary corpus
-- path. These tables are a future financial-map input, not ledger rows.

CREATE TABLE IF NOT EXISTS custom_api_rows (
  source        TEXT NOT NULL,
  endpoint      TEXT NOT NULL,
  row_key       TEXT NOT NULL,
  row_hash      TEXT NOT NULL,
  row_json      TEXT NOT NULL,
  revision      INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  first_seen_at TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (source, endpoint, row_key),
  CHECK (source GLOB '[a-z0-9]*' AND source NOT GLOB '*[^a-z0-9_-]*' AND length(source) BETWEEN 1 AND 64),
  CHECK (endpoint GLOB '[a-z0-9]*' AND endpoint NOT GLOB '*[^a-z0-9_-]*' AND length(endpoint) BETWEEN 1 AND 64),
  CHECK (length(row_hash) = 64 AND row_hash NOT GLOB '*[^a-f0-9]*'),
  CHECK (json_valid(row_json))
);

CREATE INDEX IF NOT EXISTS idx_custom_api_rows_endpoint ON custom_api_rows (source, endpoint);

-- Corrections are append-only evidence. The current row changes in place, but
-- its prior and replacement hashes remain attributable without retaining a
-- second copy of provider content.
CREATE TABLE IF NOT EXISTS custom_api_row_revisions (
  source       TEXT NOT NULL,
  endpoint     TEXT NOT NULL,
  row_key      TEXT NOT NULL,
  revision     INTEGER NOT NULL CHECK (revision >= 2),
  prior_hash   TEXT NOT NULL,
  new_hash     TEXT NOT NULL,
  revised_at   TEXT NOT NULL,
  PRIMARY KEY (source, endpoint, row_key, revision),
  FOREIGN KEY (source, endpoint, row_key)
    REFERENCES custom_api_rows(source, endpoint, row_key) ON DELETE RESTRICT,
  CHECK (length(prior_hash) = 64 AND prior_hash NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(new_hash) = 64 AND new_hash NOT GLOB '*[^a-f0-9]*')
);

CREATE TABLE IF NOT EXISTS custom_api_fetches (
  run_id          TEXT PRIMARY KEY,
  source          TEXT NOT NULL,
  endpoint        TEXT NOT NULL,
  fetched_at      TEXT NOT NULL,
  response_hash   TEXT NOT NULL,
  rows_seen       INTEGER NOT NULL CHECK (rows_seen >= 0),
  rows_created    INTEGER NOT NULL CHECK (rows_created >= 0),
  rows_updated    INTEGER NOT NULL CHECK (rows_updated >= 0),
  rows_unchanged  INTEGER NOT NULL CHECK (rows_unchanged >= 0),
  CHECK (length(response_hash) = 64 AND response_hash NOT GLOB '*[^a-f0-9]*')
);

CREATE INDEX IF NOT EXISTS idx_custom_api_fetches_source ON custom_api_fetches (source, fetched_at DESC);

-- One lease prevents a manual pull and a cron pull from writing the same
-- correction concurrently. last_success_at is also the cadence gate: the
-- existing every-minute Worker cron can host a daily source without a second
-- Cloudflare schedule.
CREATE TABLE IF NOT EXISTS custom_api_schedule_state (
  source           TEXT PRIMARY KEY,
  last_success_at  TEXT,
  lease_token      TEXT,
  lease_expires_at INTEGER,
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);
