-- 0043_source_original_result_bindings
--
-- An accepted source-original observation must prove that the current stored
-- document revision came from the exact raw bytes assessed on the trusted
-- local machine. The document columns below identify the current revision and
-- its binding receipt. They remain NULL for legacy and explicitly unbound
-- rows; this migration does not manufacture provenance for existing content.

ALTER TABLE documents ADD COLUMN document_revision_id TEXT
  CHECK (document_revision_id IS NULL OR (
    length(document_revision_id) = 71
    AND substr(document_revision_id, 1, 7) = 'rev-v1:'
    AND substr(document_revision_id, 8) = lower(substr(document_revision_id, 8))
    AND substr(document_revision_id, 8) NOT GLOB '*[^0-9a-f]*'
  ));

ALTER TABLE documents ADD COLUMN source_original_binding_hash TEXT
  CHECK (source_original_binding_hash IS NULL OR (
    NOT (document_revision_id IS NULL)
    AND length(source_original_binding_hash) = 71
    AND substr(source_original_binding_hash, 1, 7) = 'sha256:'
    AND substr(source_original_binding_hash, 8) = lower(substr(source_original_binding_hash, 8))
    AND substr(source_original_binding_hash, 8) NOT GLOB '*[^0-9a-f]*'
  ));

-- The ledger no longer repeats doc_uid, so the random revision id must be a
-- one-to-one link rather than something two current document rows can share.
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_unique_revision_id
  ON documents (document_revision_id)
  WHERE document_revision_id IS NOT NULL;

-- One immutable row binds one globally random document revision id to one
-- opaque original and its exact raw-byte receipt. There is deliberately no
-- doc_uid because it contains the source-relative locator. There is also no
-- raw locator, title, URI, provider id, source path, or foreign key to
-- documents: old bindings remain privacy-preserving evidence after a later
-- revision or an approved document deletion, and schema-first recovery
-- restores the complete history around the current document rows.
CREATE TABLE IF NOT EXISTS source_original_result_bindings (
  sequence                      INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_version              INTEGER NOT NULL,
  tenant_id                     TEXT NOT NULL,
  source                        TEXT NOT NULL,
  original_id                   TEXT NOT NULL,
  locator_kind                  TEXT NOT NULL,
  document_revision_id          TEXT NOT NULL,
  original_content_sha256       TEXT NOT NULL,
  original_byte_count           INTEGER NOT NULL,
  document_content_hash         TEXT NOT NULL,
  provenance_receipt_digest     TEXT NOT NULL,
  binding_hash                  TEXT NOT NULL,
  bound_at                      INTEGER NOT NULL,

  UNIQUE (binding_hash),
  UNIQUE (document_revision_id),
  CHECK (contract_version = 1),
  CHECK (tenant_id = 'primary'),
  CHECK (source GLOB '[a-z0-9]*' AND source NOT GLOB '*[^a-z0-9_-]*' AND length(source) BETWEEN 1 AND 64),
  CHECK (length(original_id) = 76 AND substr(original_id,1,12) = 'hmac-sha256:' AND
         substr(original_id,13) = lower(substr(original_id,13)) AND
         substr(original_id,13) NOT GLOB '*[^0-9a-f]*'),
  CHECK (locator_kind = 'source_relative_path'),
  CHECK (length(document_revision_id) = 71 AND substr(document_revision_id,1,7) = 'rev-v1:' AND
         substr(document_revision_id,8) = lower(substr(document_revision_id,8)) AND
         substr(document_revision_id,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(original_content_sha256) = 64 AND
         original_content_sha256 = lower(original_content_sha256) AND
         original_content_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(original_byte_count) = 'integer' AND
         original_byte_count BETWEEN 0 AND 9007199254740991),
  CHECK (length(document_content_hash) = 64 AND
         document_content_hash = lower(document_content_hash) AND
         document_content_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(provenance_receipt_digest) = 64 AND
         provenance_receipt_digest = lower(provenance_receipt_digest) AND
         provenance_receipt_digest NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(binding_hash) = 71 AND substr(binding_hash,1,7) = 'sha256:' AND
         substr(binding_hash,8) = lower(substr(binding_hash,8)) AND
         substr(binding_hash,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(bound_at) = 'integer' AND bound_at >= 0)
);

CREATE INDEX IF NOT EXISTS idx_source_original_result_bindings_original_sequence
  ON source_original_result_bindings (source, original_id, sequence DESC);

-- INSERT OR REPLACE performs an implicit delete without firing DELETE
-- triggers under SQLite's default recursive_triggers setting. Reject every
-- colliding insert before SQLite can replace immutable history. Exact
-- application retries read and verify the existing receipt instead.
CREATE TRIGGER IF NOT EXISTS source_original_result_binding_no_duplicate_insert
BEFORE INSERT ON source_original_result_bindings
WHEN EXISTS (
  SELECT 1 FROM source_original_result_bindings
   WHERE sequence = NEW.sequence
      OR binding_hash = NEW.binding_hash
      OR document_revision_id = NEW.document_revision_id
)
BEGIN
  SELECT RAISE(ABORT, 'source original result binding cannot be replaced');
END;

CREATE TRIGGER IF NOT EXISTS source_original_result_binding_no_update
BEFORE UPDATE ON source_original_result_bindings
BEGIN
  SELECT RAISE(ABORT, 'source original result bindings are append-only');
END;

CREATE TRIGGER IF NOT EXISTS source_original_result_binding_no_delete
BEFORE DELETE ON source_original_result_bindings
BEGIN
  SELECT RAISE(ABORT, 'source original result bindings are append-only');
END;

-- Accepted remains impossible, but schema 42's original error would now make a
-- false claim: schema 43 does provide the raw-original/current-revision
-- binding. Replace only the explanation, not the fail-closed behavior. The
-- temporary guard is created first and removed last because D1 migrations can
-- commit statement by statement; there must be no writer-visible interval in
-- which an accepted row can slip between DROP and CREATE. A later schema must
-- enforce the full result family, exact chunks and retrieval chain before
-- application code and these guards may enable accepted outcomes.
CREATE TRIGGER IF NOT EXISTS source_original_observation_accepted_schema43_guard
BEFORE INSERT ON source_original_observations
WHEN NEW.outcome = 'accepted'
BEGIN
  SELECT RAISE(ABORT, 'accepted source-original outcomes require a future result-family receipt and retrieval proof');
END;

DROP TRIGGER IF EXISTS source_original_observation_accepted_disabled;
CREATE TRIGGER source_original_observation_accepted_disabled
BEFORE INSERT ON source_original_observations
WHEN NEW.outcome = 'accepted'
BEGIN
  SELECT RAISE(ABORT, 'accepted source-original outcomes require a future result-family receipt and retrieval proof');
END;

DROP TRIGGER source_original_observation_accepted_schema43_guard;
