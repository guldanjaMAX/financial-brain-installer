-- 0048_custom_api_source
--
-- A provider pull is a durable job. The complete validated snapshot is staged
-- before any current row or readable document changes, then one bounded slice
-- advances per Worker request. Structured rows are packed into JSON arrays so
-- provider row count does not become D1 statement count. Each packed row keeps
-- its own content hash, presence flag, last-seen time, and correction hashes.

CREATE TABLE IF NOT EXISTS custom_api_row_chunks (
  source        TEXT NOT NULL,
  endpoint      TEXT NOT NULL,
  chunk_index   INTEGER NOT NULL CHECK (chunk_index >= 0),
  rows_json     TEXT NOT NULL CHECK (json_valid(rows_json) AND json_type(rows_json) = 'array'),
  content_hash  TEXT NOT NULL,
  job_id        TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (source, endpoint, chunk_index),
  CHECK (source GLOB '[a-z0-9]*' AND source NOT GLOB '*[^a-z0-9_-]*' AND length(source) BETWEEN 1 AND 64),
  CHECK (endpoint GLOB '[a-z0-9]*' AND endpoint NOT GLOB '*[^a-z0-9_-]*' AND length(endpoint) BETWEEN 1 AND 64),
  CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^a-f0-9]*')
);

CREATE INDEX IF NOT EXISTS idx_custom_api_row_chunks_endpoint
  ON custom_api_row_chunks (source, endpoint, chunk_index);

CREATE TABLE IF NOT EXISTS custom_api_jobs (
  job_id                 TEXT PRIMARY KEY,
  source                 TEXT NOT NULL,
  fetched_at             TEXT NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('staged','applying','failed','verified')),
  next_slice             INTEGER NOT NULL CHECK (next_slice >= 0),
  total_slices           INTEGER NOT NULL CHECK (total_slices >= 0),
  job_hash               TEXT NOT NULL,
  response_hashes_json   TEXT NOT NULL CHECK (json_valid(response_hashes_json) AND json_type(response_hashes_json) = 'object'),
  stats_json             TEXT NOT NULL CHECK (json_valid(stats_json) AND json_type(stats_json) = 'object'),
  created_at             TEXT NOT NULL,
  verified_at            TEXT,
  CHECK (next_slice <= total_slices),
  CHECK (length(job_hash) = 64 AND job_hash NOT GLOB '*[^a-f0-9]*'),
  CHECK ((status = 'verified') = (verified_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_api_jobs_one_active
  ON custom_api_jobs (source) WHERE status IN ('staged','applying','failed');

CREATE INDEX IF NOT EXISTS idx_custom_api_jobs_verified
  ON custom_api_jobs (source, verified_at DESC) WHERE status = 'verified';

CREATE TABLE IF NOT EXISTS custom_api_job_slices (
  job_id        TEXT NOT NULL REFERENCES custom_api_jobs(job_id) ON DELETE RESTRICT,
  slice_index   INTEGER NOT NULL CHECK (slice_index >= 0),
  kind          TEXT NOT NULL CHECK (kind IN ('rows','document')),
  endpoint      TEXT NOT NULL,
  target_key    TEXT NOT NULL,
  payload_json  TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_hash  TEXT NOT NULL,
  verified_at   TEXT,
  PRIMARY KEY (job_id, slice_index),
  CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^a-f0-9]*')
);

CREATE TABLE IF NOT EXISTS custom_api_fetches (
  job_id                 TEXT PRIMARY KEY REFERENCES custom_api_jobs(job_id) ON DELETE RESTRICT,
  source                 TEXT NOT NULL,
  fetched_at             TEXT NOT NULL,
  response_hashes_json   TEXT NOT NULL CHECK (json_valid(response_hashes_json) AND json_type(response_hashes_json) = 'object'),
  stats_json             TEXT NOT NULL CHECK (json_valid(stats_json) AND json_type(stats_json) = 'object'),
  verified_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_custom_api_fetches_source
  ON custom_api_fetches (source, verified_at DESC);

-- One lease prevents a manual pull and a cron pull from advancing the same
-- slice concurrently. last_success_at advances only after terminal proof.
CREATE TABLE IF NOT EXISTS custom_api_schedule_state (
  source           TEXT PRIMARY KEY,
  last_success_at  TEXT,
  lease_token      TEXT,
  lease_expires_at INTEGER,
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);
