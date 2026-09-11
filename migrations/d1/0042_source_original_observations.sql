-- 0042_source_original_observations
--
-- Retrospective repair needs an identity for the original artifact that does
-- not change when a session credential rotates and does not require storing a
-- path. The per-database salt below exists only for that HMAC domain. It is
-- independent of login, recovery-artifact and owner-map keys.

CREATE TABLE IF NOT EXISTS source_original_id_key_state (
  tenant_id     TEXT PRIMARY KEY,
  signing_salt  TEXT NOT NULL,
  CHECK (tenant_id GLOB '[a-z0-9]*' AND tenant_id NOT GLOB '*[^a-z0-9_-]*' AND length(tenant_id) BETWEEN 1 AND 64),
  CHECK (length(signing_salt) = 64 AND signing_salt = lower(signing_salt) AND signing_salt NOT GLOB '*[^0-9a-f]*')
) WITHOUT ROWID;

-- Existing installs already have install_state. Recovery creates schema first
-- and intentionally leaves this empty so the original salt can be imported.
INSERT INTO source_original_id_key_state (tenant_id, signing_salt)
SELECT 'primary', lower(hex(randomblob(32)))
 WHERE EXISTS (SELECT 1 FROM install_state WHERE id = 1)
   AND NOT EXISTS (
     SELECT 1 FROM source_original_id_key_state WHERE tenant_id = 'primary'
   );

-- INSERT OR REPLACE performs an implicit delete without firing DELETE triggers
-- under SQLite's default recursive_triggers setting. Rejecting every duplicate
-- at BEFORE INSERT keeps that shortcut from rotating the identity domain.
CREATE TRIGGER IF NOT EXISTS source_original_id_key_no_duplicate_insert
BEFORE INSERT ON source_original_id_key_state
WHEN EXISTS (
  SELECT 1 FROM source_original_id_key_state WHERE tenant_id = NEW.tenant_id
)
BEGIN
  SELECT RAISE(ABORT, 'source original identity key state cannot be replaced');
END;

CREATE TRIGGER IF NOT EXISTS source_original_id_key_no_update
BEFORE UPDATE ON source_original_id_key_state
BEGIN
  SELECT RAISE(ABORT, 'source original identity key state is immutable');
END;

CREATE TRIGGER IF NOT EXISTS source_original_id_key_no_delete
BEFORE DELETE ON source_original_id_key_state
BEGIN
  SELECT RAISE(ABORT, 'source original identity key state is required');
END;

-- One immutable row records one direct observation of one bounded original.
-- There is deliberately no raw locator column and no foreign key to sources:
-- the evidence survives source retirement and recovery/import ordering.
CREATE TABLE IF NOT EXISTS source_original_observations (
  sequence                    INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_version            INTEGER NOT NULL,
  tenant_id                   TEXT NOT NULL,
  source                      TEXT NOT NULL,
  original_id                 TEXT NOT NULL,
  locator_kind                TEXT NOT NULL,
  run_id                      TEXT NOT NULL,
  plan_id                     TEXT NOT NULL,
  source_snapshot_id          TEXT NOT NULL,
  target_set_hash             TEXT NOT NULL,
  target_count                INTEGER NOT NULL,
  observation_stage           TEXT NOT NULL,
  outcome                     TEXT NOT NULL,
  reason_code                 TEXT NOT NULL,
  text_state                  TEXT NOT NULL,
  original_content_sha256     TEXT,
  original_byte_count         INTEGER,
  page_count                  INTEGER,
  page_count_state            TEXT NOT NULL,
  result_document_count       INTEGER NOT NULL,
  result_document_set_hash    TEXT NOT NULL,
  resolves_observation_hash   TEXT,
  observation_hash            TEXT NOT NULL,
  recorded_at                 INTEGER NOT NULL,

  UNIQUE (run_id, original_id),
  CHECK (contract_version = 1),
  CHECK (tenant_id = 'primary'),
  CHECK (source GLOB '[a-z0-9]*' AND source NOT GLOB '*[^a-z0-9_-]*' AND length(source) BETWEEN 1 AND 64),
  CHECK (length(original_id) = 76 AND substr(original_id,1,12) = 'hmac-sha256:' AND substr(original_id,13) NOT GLOB '*[^0-9a-f]*'),
  CHECK (locator_kind = 'source_relative_path'),
  CHECK (run_id GLOB '[A-Za-z0-9]*' AND run_id NOT GLOB '*[^A-Za-z0-9_-]*' AND length(run_id) BETWEEN 1 AND 128),
  CHECK (length(plan_id) = 64 AND plan_id = lower(plan_id) AND plan_id NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(source_snapshot_id) = 71 AND substr(source_snapshot_id,1,7) = 'sha256:' AND substr(source_snapshot_id,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(target_set_hash) = 71 AND substr(target_set_hash,1,7) = 'sha256:' AND substr(target_set_hash,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (target_count BETWEEN 1 AND 10),
  CHECK (observation_stage IN ('discovery','repair')),
  CHECK (outcome IN ('accepted','gap','adjudicated_exclusion','failed')),
  CHECK (reason_code IN (
    'accepted_provenance_verified','provenance_unassessed','ocr_partial_review',
    'scan_only_ocr_needed','empty_original','password_protected',
    'unsupported_format','extraction_failed','original_unavailable',
    'source_policy_excluded','current_document_missing','index_write_failed'
  )),
  CHECK (text_state IN (
    'native_readable','ocr_reliable','ocr_partial','scan_only_ocr_needed',
    'empty','password_protected','unsupported','extraction_failed','unavailable'
  )),
  CHECK (
    (outcome = 'accepted' AND reason_code = 'accepted_provenance_verified' AND text_state IN ('native_readable','ocr_reliable')) OR
    (outcome = 'gap' AND (
      (reason_code IN ('provenance_unassessed','current_document_missing') AND text_state IN ('native_readable','ocr_reliable','unavailable')) OR
      (reason_code = 'ocr_partial_review' AND text_state = 'ocr_partial') OR
      (reason_code = 'scan_only_ocr_needed' AND text_state = 'scan_only_ocr_needed') OR
      (reason_code = 'password_protected' AND text_state = 'password_protected') OR
      (reason_code = 'unsupported_format' AND text_state = 'unsupported') OR
      (reason_code = 'extraction_failed' AND text_state = 'extraction_failed') OR
      (reason_code = 'original_unavailable' AND text_state = 'unavailable')
    )) OR
    (outcome = 'adjudicated_exclusion' AND (
      (reason_code = 'empty_original' AND text_state = 'empty') OR
      (reason_code = 'source_policy_excluded' AND text_state IN ('unsupported','unavailable'))
    )) OR
    (outcome = 'failed' AND (
      (reason_code = 'extraction_failed' AND text_state = 'extraction_failed') OR
      (reason_code IN ('original_unavailable','index_write_failed') AND text_state = 'unavailable')
    ))
  ),
  CHECK (
    (text_state = 'unavailable' AND original_content_sha256 IS NULL AND original_byte_count IS NULL) OR
    (text_state <> 'unavailable' AND length(original_content_sha256) = 64 AND
      original_content_sha256 = lower(original_content_sha256) AND
      original_content_sha256 NOT GLOB '*[^0-9a-f]*' AND original_byte_count >= 0)
  ),
  CHECK (page_count_state IN ('authoritative','not_applicable','unavailable')),
  CHECK (
    (page_count_state = 'authoritative' AND page_count BETWEEN 1 AND 10000) OR
    (page_count_state IN ('not_applicable','unavailable') AND page_count IS NULL)
  ),
  CHECK (result_document_count BETWEEN 0 AND 256),
  CHECK (outcome <> 'accepted' OR result_document_count > 0),
  CHECK (length(result_document_set_hash) = 71 AND substr(result_document_set_hash,1,7) = 'sha256:' AND substr(result_document_set_hash,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (
    (observation_stage = 'repair' AND outcome = 'accepted' AND
      length(resolves_observation_hash) = 71 AND substr(resolves_observation_hash,1,7) = 'sha256:' AND substr(resolves_observation_hash,8) NOT GLOB '*[^0-9a-f]*') OR
    ((observation_stage <> 'repair' OR outcome <> 'accepted') AND resolves_observation_hash IS NULL)
  ),
  CHECK (length(observation_hash) = 71 AND substr(observation_hash,1,7) = 'sha256:' AND substr(observation_hash,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (recorded_at >= 0)
);

CREATE INDEX IF NOT EXISTS idx_source_original_observations_source_sequence
  ON source_original_observations (source, sequence);
CREATE INDEX IF NOT EXISTS idx_source_original_observations_run_sequence
  ON source_original_observations (run_id, sequence);
CREATE INDEX IF NOT EXISTS idx_source_original_observations_original_sequence
  ON source_original_observations (source, original_id, sequence DESC);

-- Schema 42 can preserve discovery/failure/exclusion evidence, but the
-- current documents table has no authoritative raw-original byte receipt.
-- Until a later migration adds that binding, neither application code nor a
-- recovery import/direct SQL write may manufacture an accepted repair row.
CREATE TRIGGER IF NOT EXISTS source_original_observation_accepted_disabled
BEFORE INSERT ON source_original_observations
WHEN NEW.outcome = 'accepted'
BEGIN
  SELECT RAISE(ABORT, 'accepted source-original outcomes require a future raw-original binding');
END;

-- Application retries skip an exact existing row before insertion. A changed
-- replay with the same run/original key aborts the complete D1 batch here.
CREATE TRIGGER IF NOT EXISTS source_original_observation_run_binding_insert
BEFORE INSERT ON source_original_observations
WHEN EXISTS (
  SELECT 1 FROM source_original_observations
   WHERE run_id = NEW.run_id
     AND (
       source <> NEW.source OR
       plan_id <> NEW.plan_id OR
       source_snapshot_id <> NEW.source_snapshot_id OR
       target_set_hash <> NEW.target_set_hash OR
       target_count <> NEW.target_count
     )
)
BEGIN
  SELECT RAISE(ABORT, 'source original observation run binding is immutable');
END;

CREATE TRIGGER IF NOT EXISTS source_original_observation_run_cardinality_insert
BEFORE INSERT ON source_original_observations
WHEN NOT EXISTS (
  SELECT 1 FROM source_original_observations
   WHERE run_id = NEW.run_id AND original_id = NEW.original_id
) AND (
  SELECT COUNT(*) FROM source_original_observations WHERE run_id = NEW.run_id
) >= NEW.target_count
BEGIN
  SELECT RAISE(ABORT, 'source original observation run exceeds its sealed target count');
END;

-- The same SQLite REPLACE behavior can otherwise delete and recreate a ledger
-- row without reaching the DELETE trigger. Exact application retries skip
-- existing rows and verify readback, so every duplicate insert is an error at
-- the durable boundary, including a collision on an explicit sequence.
CREATE TRIGGER IF NOT EXISTS source_original_observation_no_duplicate_insert
BEFORE INSERT ON source_original_observations
WHEN EXISTS (
  SELECT 1 FROM source_original_observations
   WHERE sequence = NEW.sequence
      OR (run_id = NEW.run_id AND original_id = NEW.original_id)
)
BEGIN
  SELECT RAISE(ABORT, 'source original observation cannot be replaced');
END;

CREATE TRIGGER IF NOT EXISTS source_original_observation_conflicting_insert
BEFORE INSERT ON source_original_observations
WHEN EXISTS (
  SELECT 1 FROM source_original_observations
   WHERE run_id = NEW.run_id
     AND original_id = NEW.original_id
     AND observation_hash <> NEW.observation_hash
)
BEGIN
  SELECT RAISE(ABORT, 'source original observation conflicts with immutable receipt');
END;

CREATE TRIGGER IF NOT EXISTS source_original_observation_no_update
BEFORE UPDATE ON source_original_observations
BEGIN
  SELECT RAISE(ABORT, 'source original observations are append-only');
END;

CREATE TRIGGER IF NOT EXISTS source_original_observation_no_delete
BEFORE DELETE ON source_original_observations
BEGIN
  SELECT RAISE(ABORT, 'source original observations are append-only');
END;
