-- 0045_source_original_accepted_resolutions
--
-- An accepted observation is portable history, but its authority is narrower:
-- it records that one previously unresolved, directly observed original was
-- represented by one exact result family under one deployment-local retrieval
-- verification. Recovery preserves that history without preserving current
-- Vectorize authority. A target deployment must verify and activate it again.
--
-- Normal admission uses one ephemeral row. Its AFTER trigger inserts the
-- portable resolution, the deployment-local activation, and the accepted
-- observation, then consumes the row. The complete trigger body is one SQLite
-- statement and the Worker executes it in one D1 batch, so no partial accepted
-- chain can commit. Raw locators, queries, document ids, titles, text, answers,
-- and citation references are absent from every table below.

-- Result-family verification hashes cover the complete bounded retrieval
-- response, not just the member that ranked first.  Vector readiness fences
-- semantic projection, but D1 metadata, keyword ranking, registered-source
-- authority, and the memory-supersession ledger can all change that response
-- without changing Vectorize counts.  Keep one deployment-local generation for
-- those authoritative inputs. Existing schema-44 verifications retain NULL and
-- are historical only; every schema-45 verification must bind a live integer.
ALTER TABLE install_state ADD COLUMN source_original_retrieval_generation INTEGER
  NOT NULL DEFAULT 0
  CHECK (
    typeof(source_original_retrieval_generation) = 'integer'
    AND source_original_retrieval_generation BETWEEN 0 AND 9007199254740991
  );

ALTER TABLE source_original_result_family_verifications ADD COLUMN retrieval_generation INTEGER
  CHECK (
    retrieval_generation IS NULL OR (
      typeof(retrieval_generation) = 'integer'
      AND retrieval_generation BETWEEN 0 AND 9007199254740991
    )
  );

-- The counter is a monotonic local fence, not a freely writable status field.
-- Refuse rollback and make INSERT OR REPLACE advance it before replacing the
-- singleton, so an older verification can never be revived by resetting the
-- counter. The install-state upsert uses the same exact next-generation rule.
CREATE TRIGGER IF NOT EXISTS source_original_retrieval_generation_no_reset_update
BEFORE UPDATE OF source_original_retrieval_generation ON install_state
WHEN NEW.source_original_retrieval_generation IS NOT OLD.source_original_retrieval_generation
 AND NEW.source_original_retrieval_generation <> OLD.source_original_retrieval_generation + 1
BEGIN
  SELECT RAISE(ABORT, 'source original retrieval generation must advance monotonically');
END;

CREATE TRIGGER IF NOT EXISTS source_original_retrieval_generation_no_replace_insert
BEFORE INSERT ON install_state
WHEN EXISTS (SELECT 1 FROM install_state old WHERE old.id = NEW.id)
 AND NOT EXISTS (
   SELECT 1 FROM install_state old
    WHERE old.id = NEW.id
           AND NEW.source_original_retrieval_generation = old.source_original_retrieval_generation + 1
 )
BEGIN
  SELECT RAISE(ABORT, 'source original retrieval generation must advance on singleton replacement');
END;

CREATE TRIGGER IF NOT EXISTS source_original_retrieval_generation_no_singleton_delete
BEFORE DELETE ON install_state
WHEN OLD.id = 1
BEGIN
  SELECT RAISE(ABORT, 'source original retrieval generation singleton cannot be deleted');
END;

-- Recovery imports an authenticated corpus before it can have any local
-- retrieval authority. Do not count those portable rows as post-verification
-- mutations. The marker can only open on an empty target and schema 45 blocks
-- all local verifications while it is present.
CREATE TRIGGER IF NOT EXISTS source_original_retrieval_generation_documents_ai
AFTER INSERT ON documents
WHEN NOT EXISTS (
  SELECT 1 FROM source_original_result_family_recovery_state
   WHERE id = 1 AND mode = 'verified_recovery_import'
)
BEGIN
  SELECT RAISE(ABORT, 'source original retrieval generation singleton is unavailable')
   WHERE (SELECT COUNT(*) FROM install_state WHERE id = 1) <> 1;
  UPDATE install_state
     SET source_original_retrieval_generation = source_original_retrieval_generation + 1
   WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS source_original_retrieval_generation_documents_ad
AFTER DELETE ON documents
WHEN NOT EXISTS (
  SELECT 1 FROM source_original_result_family_recovery_state
   WHERE id = 1 AND mode = 'verified_recovery_import'
)
BEGIN
  SELECT RAISE(ABORT, 'source original retrieval generation singleton is unavailable')
   WHERE (SELECT COUNT(*) FROM install_state WHERE id = 1) <> 1;
  UPDATE install_state
     SET source_original_retrieval_generation = source_original_retrieval_generation + 1
   WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS source_original_retrieval_generation_documents_au
AFTER UPDATE ON documents
WHEN NOT EXISTS (
       SELECT 1 FROM source_original_result_family_recovery_state
        WHERE id = 1 AND mode = 'verified_recovery_import'
     )
 AND (
   NEW.doc_uid IS NOT OLD.doc_uid OR NEW.source IS NOT OLD.source OR
   NEW.source_id IS NOT OLD.source_id OR NEW.title IS NOT OLD.title OR
   NEW.uri IS NOT OLD.uri OR NEW.document_date IS NOT OLD.document_date OR
   NEW.date_source IS NOT OLD.date_source OR NEW.date_reliable IS NOT OLD.date_reliable OR
   NEW.client IS NOT OLD.client OR NEW.category IS NOT OLD.category OR
   NEW.ingested_at IS NOT OLD.ingested_at OR NEW.content_hash IS NOT OLD.content_hash OR
   NEW.meta IS NOT OLD.meta OR NEW.deleted_at IS NOT OLD.deleted_at OR
   NEW.removal_reason IS NOT OLD.removal_reason OR NEW.top_folder IS NOT OLD.top_folder OR
   NEW.platform IS NOT OLD.platform OR NEW.zone IS NOT OLD.zone OR
   NEW.text_source IS NOT OLD.text_source OR NEW.text_reliable IS NOT OLD.text_reliable OR
   NEW.entity_slug IS NOT OLD.entity_slug OR
   NEW.provenance_receipt_version IS NOT OLD.provenance_receipt_version OR
   NEW.provenance_receipt_status IS NOT OLD.provenance_receipt_status OR
   NEW.provenance_receipt_reason IS NOT OLD.provenance_receipt_reason OR
   NEW.provenance_receipt_digest IS NOT OLD.provenance_receipt_digest OR
   NEW.document_revision_id IS NOT OLD.document_revision_id OR
   NEW.source_original_binding_hash IS NOT OLD.source_original_binding_hash
 )
BEGIN
  SELECT RAISE(ABORT, 'source original retrieval generation singleton is unavailable')
   WHERE (SELECT COUNT(*) FROM install_state WHERE id = 1) <> 1;
  UPDATE install_state
     SET source_original_retrieval_generation = source_original_retrieval_generation + 1
   WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS source_original_retrieval_generation_chunks_ai
AFTER INSERT ON chunks
WHEN NOT EXISTS (
  SELECT 1 FROM source_original_result_family_recovery_state
   WHERE id = 1 AND mode = 'verified_recovery_import'
)
BEGIN
  SELECT RAISE(ABORT, 'source original retrieval generation singleton is unavailable')
   WHERE (SELECT COUNT(*) FROM install_state WHERE id = 1) <> 1;
  UPDATE install_state
     SET source_original_retrieval_generation = source_original_retrieval_generation + 1
   WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS source_original_retrieval_generation_chunks_ad
AFTER DELETE ON chunks
WHEN NOT EXISTS (
  SELECT 1 FROM source_original_result_family_recovery_state
   WHERE id = 1 AND mode = 'verified_recovery_import'
)
BEGIN
  SELECT RAISE(ABORT, 'source original retrieval generation singleton is unavailable')
   WHERE (SELECT COUNT(*) FROM install_state WHERE id = 1) <> 1;
  UPDATE install_state
     SET source_original_retrieval_generation = source_original_retrieval_generation + 1
   WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS source_original_retrieval_generation_chunks_au
AFTER UPDATE ON chunks
WHEN NOT EXISTS (
       SELECT 1 FROM source_original_result_family_recovery_state
        WHERE id = 1 AND mode = 'verified_recovery_import'
     )
 AND (
   NEW.id IS NOT OLD.id OR NEW.chunk_uid IS NOT OLD.chunk_uid OR
   NEW.doc_uid IS NOT OLD.doc_uid OR NEW.chunk_ix IS NOT OLD.chunk_ix OR
   NEW.text IS NOT OLD.text OR NEW.source IS NOT OLD.source OR
   NEW.title IS NOT OLD.title OR NEW.document_date IS NOT OLD.document_date OR
   NEW.client IS NOT OLD.client OR NEW.category IS NOT OLD.category OR
   NEW.vector_id IS NOT OLD.vector_id OR NEW.top_folder IS NOT OLD.top_folder OR
   NEW.platform IS NOT OLD.platform OR NEW.zone IS NOT OLD.zone OR
   NEW.bound_document_revision_id IS NOT OLD.bound_document_revision_id OR
   NEW.result_chunk_receipt_hash IS NOT OLD.result_chunk_receipt_hash
 )
BEGIN
  SELECT RAISE(ABORT, 'source original retrieval generation singleton is unavailable')
   WHERE (SELECT COUNT(*) FROM install_state WHERE id = 1) <> 1;
  UPDATE install_state
     SET source_original_retrieval_generation = source_original_retrieval_generation + 1
   WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS source_original_retrieval_generation_sources_ai
AFTER INSERT ON sources
WHEN NOT EXISTS (
  SELECT 1 FROM source_original_result_family_recovery_state
   WHERE id = 1 AND mode = 'verified_recovery_import'
)
BEGIN
  SELECT RAISE(ABORT, 'source original retrieval generation singleton is unavailable')
   WHERE (SELECT COUNT(*) FROM install_state WHERE id = 1) <> 1;
  UPDATE install_state
     SET source_original_retrieval_generation = source_original_retrieval_generation + 1
   WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS source_original_retrieval_generation_sources_ad
AFTER DELETE ON sources
WHEN NOT EXISTS (
  SELECT 1 FROM source_original_result_family_recovery_state
   WHERE id = 1 AND mode = 'verified_recovery_import'
)
BEGIN
  SELECT RAISE(ABORT, 'source original retrieval generation singleton is unavailable')
   WHERE (SELECT COUNT(*) FROM install_state WHERE id = 1) <> 1;
  UPDATE install_state
     SET source_original_retrieval_generation = source_original_retrieval_generation + 1
   WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS source_original_retrieval_generation_sources_au
AFTER UPDATE OF name, kind, zone ON sources
WHEN NOT EXISTS (
       SELECT 1 FROM source_original_result_family_recovery_state
        WHERE id = 1 AND mode = 'verified_recovery_import'
     )
 AND (NEW.name IS NOT OLD.name OR NEW.kind IS NOT OLD.kind OR NEW.zone IS NOT OLD.zone)
BEGIN
  SELECT RAISE(ABORT, 'source original retrieval generation singleton is unavailable')
   WHERE (SELECT COUNT(*) FROM install_state WHERE id = 1) <> 1;
  UPDATE install_state
     SET source_original_retrieval_generation = source_original_retrieval_generation + 1
   WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS source_original_retrieval_generation_memory_ai
AFTER INSERT ON memory_supersessions
WHEN NOT EXISTS (
  SELECT 1 FROM source_original_result_family_recovery_state
   WHERE id = 1 AND mode = 'verified_recovery_import'
)
BEGIN
  SELECT RAISE(ABORT, 'source original retrieval generation singleton is unavailable')
   WHERE (SELECT COUNT(*) FROM install_state WHERE id = 1) <> 1;
  UPDATE install_state
     SET source_original_retrieval_generation = source_original_retrieval_generation + 1
   WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS source_original_retrieval_generation_memory_ad
AFTER DELETE ON memory_supersessions
WHEN NOT EXISTS (
  SELECT 1 FROM source_original_result_family_recovery_state
   WHERE id = 1 AND mode = 'verified_recovery_import'
)
BEGIN
  SELECT RAISE(ABORT, 'source original retrieval generation singleton is unavailable')
   WHERE (SELECT COUNT(*) FROM install_state WHERE id = 1) <> 1;
  UPDATE install_state
     SET source_original_retrieval_generation = source_original_retrieval_generation + 1
   WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS source_original_retrieval_generation_memory_au
AFTER UPDATE ON memory_supersessions
WHEN NOT EXISTS (
       SELECT 1 FROM source_original_result_family_recovery_state
        WHERE id = 1 AND mode = 'verified_recovery_import'
     )
 AND (
   NEW.predecessor_doc_uid IS NOT OLD.predecessor_doc_uid OR
   NEW.successor_doc_uid IS NOT OLD.successor_doc_uid OR
   NEW.predecessor_content_hash IS NOT OLD.predecessor_content_hash OR
   NEW.successor_content_hash IS NOT OLD.successor_content_hash OR
   NEW.channel IS NOT OLD.channel OR NEW.created_at IS NOT OLD.created_at
 )
BEGIN
  SELECT RAISE(ABORT, 'source original retrieval generation singleton is unavailable')
   WHERE (SELECT COUNT(*) FROM install_state WHERE id = 1) <> 1;
  UPDATE install_state
     SET source_original_retrieval_generation = source_original_retrieval_generation + 1
   WHERE id = 1;
END;

CREATE TABLE IF NOT EXISTS source_original_accepted_resolution_admissions (
  resolution_hash              TEXT PRIMARY KEY,
  contract_version             INTEGER NOT NULL,
  tenant_id                    TEXT NOT NULL,
  source                       TEXT NOT NULL,
  original_id                  TEXT NOT NULL,
  locator_kind                 TEXT NOT NULL,
  run_id                       TEXT NOT NULL,
  plan_id                      TEXT NOT NULL,
  source_snapshot_id           TEXT NOT NULL,
  target_set_hash              TEXT NOT NULL,
  target_count                 INTEGER NOT NULL,
  text_state                   TEXT NOT NULL,
  original_content_sha256      TEXT NOT NULL,
  original_byte_count          INTEGER NOT NULL,
  page_count                   INTEGER,
  page_count_state             TEXT NOT NULL,
  result_document_count        INTEGER NOT NULL,
  result_document_set_hash     TEXT NOT NULL,
  resolves_observation_hash    TEXT NOT NULL,
  accepted_observation_hash    TEXT NOT NULL,
  family_receipt_hash          TEXT NOT NULL,
  verification_hash            TEXT NOT NULL,
  activation_hash              TEXT NOT NULL,
  recorded_at                  INTEGER NOT NULL,
  activated_at                 INTEGER NOT NULL,

  CHECK (contract_version = 1),
  CHECK (tenant_id = 'primary'),
  CHECK (source GLOB '[a-z0-9]*' AND source NOT GLOB '*[^a-z0-9_-]*' AND length(source) BETWEEN 1 AND 64),
  CHECK (length(original_id) = 76 AND substr(original_id,1,12) = 'hmac-sha256:' AND
         substr(original_id,13) = lower(substr(original_id,13)) AND
         substr(original_id,13) NOT GLOB '*[^0-9a-f]*'),
  CHECK (locator_kind = 'source_relative_path'),
  CHECK (run_id GLOB '[A-Za-z0-9]*' AND run_id NOT GLOB '*[^A-Za-z0-9_-]*' AND length(run_id) BETWEEN 1 AND 128),
  CHECK (length(plan_id) = 64 AND plan_id = lower(plan_id) AND plan_id NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(source_snapshot_id) = 71 AND substr(source_snapshot_id,1,7) = 'sha256:' AND
         substr(source_snapshot_id,8) = lower(substr(source_snapshot_id,8)) AND
         substr(source_snapshot_id,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(target_set_hash) = 71 AND substr(target_set_hash,1,7) = 'sha256:' AND
         substr(target_set_hash,8) = lower(substr(target_set_hash,8)) AND
         substr(target_set_hash,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(target_count) = 'integer' AND target_count = 1),
  CHECK (text_state IN ('native_readable','ocr_reliable')),
  CHECK (length(original_content_sha256) = 64 AND
         original_content_sha256 = lower(original_content_sha256) AND
         original_content_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(original_byte_count) = 'integer' AND
         original_byte_count BETWEEN 0 AND 9007199254740991),
  CHECK (page_count_state IN ('authoritative','not_applicable')),
  CHECK ((page_count_state = 'authoritative' AND typeof(page_count) = 'integer' AND page_count BETWEEN 1 AND 10000) OR
         (page_count_state = 'not_applicable' AND page_count IS NULL)),
  CHECK (typeof(result_document_count) = 'integer' AND result_document_count BETWEEN 1 AND 256),
  CHECK (length(result_document_set_hash) = 71 AND substr(result_document_set_hash,1,7) = 'sha256:' AND
         substr(result_document_set_hash,8) = lower(substr(result_document_set_hash,8)) AND
         substr(result_document_set_hash,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(resolves_observation_hash) = 71 AND substr(resolves_observation_hash,1,7) = 'sha256:' AND
         substr(resolves_observation_hash,8) = lower(substr(resolves_observation_hash,8)) AND
         substr(resolves_observation_hash,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(accepted_observation_hash) = 71 AND substr(accepted_observation_hash,1,7) = 'sha256:' AND
         substr(accepted_observation_hash,8) = lower(substr(accepted_observation_hash,8)) AND
         substr(accepted_observation_hash,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(family_receipt_hash) = 71 AND substr(family_receipt_hash,1,7) = 'sha256:' AND
         substr(family_receipt_hash,8) = lower(substr(family_receipt_hash,8)) AND
         substr(family_receipt_hash,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(verification_hash) = 71 AND substr(verification_hash,1,7) = 'sha256:' AND
         substr(verification_hash,8) = lower(substr(verification_hash,8)) AND
         substr(verification_hash,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(activation_hash) = 71 AND substr(activation_hash,1,7) = 'sha256:' AND
         substr(activation_hash,8) = lower(substr(activation_hash,8)) AND
         substr(activation_hash,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(resolution_hash) = 71 AND substr(resolution_hash,1,7) = 'sha256:' AND
         substr(resolution_hash,8) = lower(substr(resolution_hash,8)) AND
         substr(resolution_hash,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(recorded_at) = 'integer' AND recorded_at >= 0),
  CHECK (typeof(activated_at) = 'integer' AND activated_at >= recorded_at)
) WITHOUT ROWID;

-- The portable row is deliberately compact. The original deployment's
-- verification digest is history, not current authority after recovery.
CREATE TABLE IF NOT EXISTS source_original_accepted_resolutions (
  sequence                       INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_version               INTEGER NOT NULL,
  tenant_id                      TEXT NOT NULL,
  source                         TEXT NOT NULL,
  original_id                   TEXT NOT NULL,
  locator_kind                  TEXT NOT NULL,
  original_content_sha256       TEXT NOT NULL,
  original_byte_count           INTEGER NOT NULL,
  resolves_observation_hash     TEXT NOT NULL,
  accepted_observation_hash     TEXT NOT NULL,
  result_document_count         INTEGER NOT NULL,
  result_document_set_hash      TEXT NOT NULL,
  family_receipt_hash           TEXT NOT NULL,
  admission_verification_hash   TEXT NOT NULL,
  resolution_hash               TEXT NOT NULL UNIQUE,
  admitted_at                   INTEGER NOT NULL,

  UNIQUE (source, original_id, resolves_observation_hash),
  UNIQUE (source, original_id, accepted_observation_hash),
  CHECK (contract_version = 1),
  CHECK (tenant_id = 'primary'),
  CHECK (source GLOB '[a-z0-9]*' AND source NOT GLOB '*[^a-z0-9_-]*' AND length(source) BETWEEN 1 AND 64),
  CHECK (length(original_id) = 76 AND substr(original_id,1,12) = 'hmac-sha256:' AND
         substr(original_id,13) = lower(substr(original_id,13)) AND
         substr(original_id,13) NOT GLOB '*[^0-9a-f]*'),
  CHECK (locator_kind = 'source_relative_path'),
  CHECK (length(original_content_sha256) = 64 AND
         original_content_sha256 = lower(original_content_sha256) AND
         original_content_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(original_byte_count) = 'integer' AND
         original_byte_count BETWEEN 0 AND 9007199254740991),
  CHECK (length(resolves_observation_hash) = 71 AND substr(resolves_observation_hash,1,7) = 'sha256:' AND
         substr(resolves_observation_hash,8) = lower(substr(resolves_observation_hash,8)) AND
         substr(resolves_observation_hash,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(accepted_observation_hash) = 71 AND substr(accepted_observation_hash,1,7) = 'sha256:' AND
         substr(accepted_observation_hash,8) = lower(substr(accepted_observation_hash,8)) AND
         substr(accepted_observation_hash,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(result_document_count) = 'integer' AND result_document_count BETWEEN 1 AND 256),
  CHECK (length(result_document_set_hash) = 71 AND substr(result_document_set_hash,1,7) = 'sha256:' AND
         substr(result_document_set_hash,8) = lower(substr(result_document_set_hash,8)) AND
         substr(result_document_set_hash,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(family_receipt_hash) = 71 AND substr(family_receipt_hash,1,7) = 'sha256:' AND
         substr(family_receipt_hash,8) = lower(substr(family_receipt_hash,8)) AND
         substr(family_receipt_hash,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(admission_verification_hash) = 71 AND substr(admission_verification_hash,1,7) = 'sha256:' AND
         substr(admission_verification_hash,8) = lower(substr(admission_verification_hash,8)) AND
         substr(admission_verification_hash,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(resolution_hash) = 71 AND substr(resolution_hash,1,7) = 'sha256:' AND
         substr(resolution_hash,8) = lower(substr(resolution_hash,8)) AND
         substr(resolution_hash,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(admitted_at) = 'integer' AND admitted_at >= 0)
);

CREATE INDEX IF NOT EXISTS idx_source_original_accepted_resolutions_original_sequence
  ON source_original_accepted_resolutions (source, original_id, sequence DESC);

-- Activations are local to the current D1/Vectorize deployment. They are
-- append-only evidence, but presence alone is never currentness; the view below
-- dynamically repeats the family, queue and install-state fences.
CREATE TABLE IF NOT EXISTS source_original_accepted_resolution_activations (
  sequence          INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_version  INTEGER NOT NULL,
  tenant_id         TEXT NOT NULL,
  resolution_hash   TEXT NOT NULL,
  verification_hash TEXT NOT NULL,
  activation_hash   TEXT NOT NULL UNIQUE,
  activated_at      INTEGER NOT NULL,

  UNIQUE (resolution_hash, verification_hash),
  CHECK (contract_version = 1),
  CHECK (tenant_id = 'primary'),
  CHECK (length(resolution_hash) = 71 AND substr(resolution_hash,1,7) = 'sha256:' AND
         substr(resolution_hash,8) = lower(substr(resolution_hash,8)) AND
         substr(resolution_hash,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(verification_hash) = 71 AND substr(verification_hash,1,7) = 'sha256:' AND
         substr(verification_hash,8) = lower(substr(verification_hash,8)) AND
         substr(verification_hash,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(activation_hash) = 71 AND substr(activation_hash,1,7) = 'sha256:' AND
         substr(activation_hash,8) = lower(substr(activation_hash,8)) AND
         substr(activation_hash,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(activated_at) = 'integer' AND activated_at >= 0)
);

CREATE INDEX IF NOT EXISTS idx_source_original_accepted_resolution_activations_resolution_sequence
  ON source_original_accepted_resolution_activations (resolution_hash, sequence DESC);

-- One schema-44 verification is current only while the exact deployment and
-- every member of the exact family still match. This view intentionally repeats
-- the schema-44 insertion fence so later callers cannot mistake immutable proof
-- history for live authority.
CREATE VIEW IF NOT EXISTS source_original_current_result_family_verifications AS
SELECT v.verification_hash, v.family_receipt_hash, v.verified_at
  FROM source_original_result_family_verifications v
  JOIN source_original_result_family_receipts r
    ON r.family_receipt_hash = v.family_receipt_hash
   AND r.tenant_id = v.tenant_id
  JOIN sources registered
    ON registered.name = r.source
   AND registered.kind = 'upload'
  JOIN install_state i ON i.id = 1
 WHERE i.schema_version >= 45
   AND NOT EXISTS (
     SELECT 1 FROM source_original_result_family_recovery_state
      WHERE id = 1 AND mode = 'verified_recovery_import'
   )
   AND typeof(v.retrieval_generation) = 'integer'
   AND i.source_original_retrieval_generation = v.retrieval_generation
   AND i.outbox_generation = v.outbox_generation
   AND i.vector_projection_mutation_id IS v.vector_projection_mutation_id
   AND i.vector_projection_submitted_at IS v.vector_projection_submitted_at
   AND i.vector_projection_bootstrap_epoch = v.vector_projection_bootstrap_epoch
   AND i.vector_projection_status = v.vector_projection_status
   AND v.vector_projection_status = 'verified'
   AND v.expected_vector_count = (SELECT count(*) FROM chunks)
   AND v.actual_vector_count = v.expected_vector_count
   AND v.global_outbox_count = (SELECT count(*) FROM vector_outbox)
   AND v.global_outbox_count = 0
   AND v.target_outbox_count = 0
   AND NOT EXISTS (
     SELECT 1
       FROM vector_outbox o
       JOIN chunks c ON c.chunk_uid = o.chunk_uid
       JOIN source_original_result_family_members m
         ON m.family_receipt_hash = v.family_receipt_hash
        AND m.document_revision_id = c.bound_document_revision_id
        AND m.chunk_ix = c.chunk_ix
        AND m.chunk_receipt_hash = c.result_chunk_receipt_hash
   )
   AND NOT EXISTS (
     SELECT 1
       FROM source_original_result_family_members m
       LEFT JOIN documents d ON d.document_revision_id = m.document_revision_id
       LEFT JOIN chunks c ON c.doc_uid = d.doc_uid AND c.chunk_ix = m.chunk_ix
       LEFT JOIN source_original_result_bindings b
         ON b.binding_hash = m.source_original_binding_hash
        AND b.document_revision_id = m.document_revision_id
      WHERE m.family_receipt_hash = v.family_receipt_hash
        AND (d.doc_uid IS NULL OR d.deleted_at IS NOT NULL OR d.source IS NOT r.source OR
             d.source_original_binding_hash IS NOT m.source_original_binding_hash OR
             d.provenance_receipt_version IS NOT 1 OR
             d.provenance_receipt_status IS NOT 'complete' OR
             d.provenance_receipt_reason IS NOT 'lineage_and_text_recorded' OR
             d.text_source NOT IN ('native','ocr') OR d.text_reliable IS NOT 1 OR
             NOT json_valid(d.meta) OR
             json_extract(CASE WHEN json_valid(d.meta) THEN d.meta ELSE '{}' END,
                          '$.provenance_receipt.version') IS NOT 1 OR
             json_extract(CASE WHEN json_valid(d.meta) THEN d.meta ELSE '{}' END,
                          '$.provenance_receipt.status') IS NOT 'complete' OR
             json_extract(CASE WHEN json_valid(d.meta) THEN d.meta ELSE '{}' END,
                          '$.provenance_receipt.reason') IS NOT 'lineage_and_text_recorded' OR
             json_type(CASE WHEN json_valid(d.meta) THEN d.meta ELSE '{}' END,
                       '$.provenance_receipt.root_ids') IS NOT 'array' OR
             json_array_length(CASE WHEN json_valid(d.meta) THEN d.meta ELSE '{}' END,
                               '$.provenance_receipt.root_ids') NOT BETWEEN 1 AND 16 OR
             c.chunk_uid IS NULL OR c.source IS NOT d.source OR c.title IS NOT d.title OR
             c.bound_document_revision_id IS NOT m.document_revision_id OR
             c.result_chunk_receipt_hash IS NOT m.chunk_receipt_hash OR
             b.sequence IS NULL OR b.tenant_id IS NOT r.tenant_id OR b.source IS NOT r.source OR
             b.original_id IS NOT r.original_id OR b.locator_kind IS NOT r.locator_kind OR
             b.original_content_sha256 IS NOT r.original_content_sha256 OR
             b.original_byte_count IS NOT r.original_byte_count OR
             b.document_content_hash IS NOT d.content_hash OR
             b.provenance_receipt_digest IS NOT d.provenance_receipt_digest)
   )
   AND (SELECT count(*)
          FROM source_original_result_family_members m
         WHERE m.family_receipt_hash = v.family_receipt_hash) = r.chunk_count
   AND (SELECT count(DISTINCT m.document_revision_id)
          FROM source_original_result_family_members m
         WHERE m.family_receipt_hash = v.family_receipt_hash) = r.document_count
   AND (SELECT count(*)
          FROM documents d
          JOIN source_original_result_bindings b
            ON b.binding_hash = d.source_original_binding_hash
           AND b.document_revision_id = d.document_revision_id
         WHERE d.deleted_at IS NULL
           AND b.tenant_id = r.tenant_id
           AND b.source = r.source
           AND b.original_id = r.original_id
           AND b.locator_kind = r.locator_kind
           AND b.original_content_sha256 = r.original_content_sha256
           AND b.original_byte_count = r.original_byte_count) = r.document_count
   AND (SELECT count(*)
          FROM chunks c
          JOIN documents d ON d.doc_uid = c.doc_uid
          JOIN source_original_result_bindings b
            ON b.binding_hash = d.source_original_binding_hash
           AND b.document_revision_id = d.document_revision_id
         WHERE d.deleted_at IS NULL
           AND b.tenant_id = r.tenant_id
           AND b.source = r.source
           AND b.original_id = r.original_id
           AND b.locator_kind = r.locator_kind
           AND b.original_content_sha256 = r.original_content_sha256
           AND b.original_byte_count = r.original_byte_count) = r.chunk_count
   AND EXISTS (
     SELECT 1 FROM source_original_result_family_members m
      WHERE m.family_receipt_hash = v.family_receipt_hash
        AND m.document_revision_id = v.retrieved_document_revision_id_a
        AND m.chunk_ix = v.retrieved_chunk_ix_a
   )
   AND EXISTS (
     SELECT 1 FROM source_original_result_family_members m
      WHERE m.family_receipt_hash = v.family_receipt_hash
        AND m.document_revision_id = v.cited_document_revision_id_a
   );

-- Once a portable family header seals one document revision, the fields used by
-- accepted-observation evidence or its production retrieval projection may move
-- only to a genuinely new revision and binding. A soft deletion may demote that
-- historical revision, but it may not
-- later be undeleted under its old receipts. SQLite cannot recompute the
-- JavaScript provenance or observation hashes, so permitting an old sealed
-- revision to leave and later reappear would let UPDATE or INSERT OR REPLACE
-- revive stale authority under old digests. An authenticated schema-first
-- recovery is the sole bounded exception: it imports the exact signed/encrypted
-- rows before closing the recovery marker.
CREATE TRIGGER IF NOT EXISTS documents_source_original_sealed_evidence_no_revival_update
BEFORE UPDATE OF doc_uid,source,source_id,title,uri,document_date,date_source,
                 date_reliable,client,category,top_folder,platform,entity_slug,
                 ingested_at,content_hash,meta,
                 text_source,text_reliable,provenance_receipt_version,
                 provenance_receipt_status,provenance_receipt_reason,
                 provenance_receipt_digest,document_revision_id,
                 source_original_binding_hash,deleted_at ON documents
WHEN NOT EXISTS (
       SELECT 1 FROM source_original_result_family_recovery_state
        WHERE id = 1 AND mode = 'verified_recovery_import'
     )
 AND EXISTS (
   SELECT 1
     FROM source_original_result_family_members member
     JOIN source_original_result_family_receipts family
       ON family.family_receipt_hash = member.family_receipt_hash
    WHERE member.document_revision_id = NEW.document_revision_id
      AND member.source_original_binding_hash = NEW.source_original_binding_hash
 )
 AND (
   OLD.doc_uid IS NOT NEW.doc_uid OR OLD.source IS NOT NEW.source OR
   OLD.source_id IS NOT NEW.source_id OR OLD.title IS NOT NEW.title OR
   OLD.uri IS NOT NEW.uri OR OLD.document_date IS NOT NEW.document_date OR
   OLD.date_source IS NOT NEW.date_source OR OLD.date_reliable IS NOT NEW.date_reliable OR
   OLD.client IS NOT NEW.client OR OLD.category IS NOT NEW.category OR
   OLD.top_folder IS NOT NEW.top_folder OR OLD.platform IS NOT NEW.platform OR
   OLD.entity_slug IS NOT NEW.entity_slug OR
   OLD.ingested_at IS NOT NEW.ingested_at OR OLD.content_hash IS NOT NEW.content_hash OR
   OLD.meta IS NOT NEW.meta OR OLD.text_source IS NOT NEW.text_source OR
   OLD.text_reliable IS NOT NEW.text_reliable OR
   OLD.provenance_receipt_version IS NOT NEW.provenance_receipt_version OR
   OLD.provenance_receipt_status IS NOT NEW.provenance_receipt_status OR
   OLD.provenance_receipt_reason IS NOT NEW.provenance_receipt_reason OR
   OLD.provenance_receipt_digest IS NOT NEW.provenance_receipt_digest OR
   OLD.document_revision_id IS NOT NEW.document_revision_id OR
   OLD.source_original_binding_hash IS NOT NEW.source_original_binding_hash OR
   (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL)
 )
BEGIN
  SELECT RAISE(ABORT, 'sealed source-original document evidence cannot be revised or revived');
END;

CREATE TRIGGER IF NOT EXISTS documents_source_original_sealed_evidence_no_revival_insert
BEFORE INSERT ON documents
WHEN NOT EXISTS (
       SELECT 1 FROM source_original_result_family_recovery_state
        WHERE id = 1 AND mode = 'verified_recovery_import'
     )
 AND EXISTS (
   SELECT 1
     FROM source_original_result_family_members member
     JOIN source_original_result_family_receipts family
       ON family.family_receipt_hash = member.family_receipt_hash
    WHERE member.document_revision_id = NEW.document_revision_id
      AND member.source_original_binding_hash = NEW.source_original_binding_hash
 )
 AND NOT EXISTS (
   SELECT 1 FROM documents old
    WHERE old.doc_uid = NEW.doc_uid
      AND old.source IS NEW.source
      AND old.source_id IS NEW.source_id
      AND old.title IS NEW.title
      AND old.uri IS NEW.uri
      AND old.document_date IS NEW.document_date
      AND old.date_source IS NEW.date_source
      AND old.date_reliable IS NEW.date_reliable
      AND old.client IS NEW.client
      AND old.category IS NEW.category
      AND old.top_folder IS NEW.top_folder
      AND old.platform IS NEW.platform
      AND old.entity_slug IS NEW.entity_slug
      AND old.ingested_at IS NEW.ingested_at
      AND old.content_hash IS NEW.content_hash
      AND old.meta IS NEW.meta
      AND old.text_source IS NEW.text_source
      AND old.text_reliable IS NEW.text_reliable
      AND old.provenance_receipt_version IS NEW.provenance_receipt_version
      AND old.provenance_receipt_status IS NEW.provenance_receipt_status
      AND old.provenance_receipt_reason IS NEW.provenance_receipt_reason
      AND old.provenance_receipt_digest IS NEW.provenance_receipt_digest
      AND old.document_revision_id IS NEW.document_revision_id
      AND old.source_original_binding_hash IS NEW.source_original_binding_hash
      AND old.deleted_at IS NEW.deleted_at
 )
BEGIN
  SELECT RAISE(ABORT, 'sealed source-original document evidence cannot be reinserted');
END;

-- Verification receipts describe the source deployment's Vectorize state.
-- Recovery never imports them, and refusing them at insertion avoids creating
-- append-only local state that would make the recovery fence impossible to close.
CREATE TRIGGER IF NOT EXISTS source_original_result_family_verification_recovery_block
BEFORE INSERT ON source_original_result_family_verifications
WHEN EXISTS (
  SELECT 1 FROM source_original_result_family_recovery_state
   WHERE id = 1 AND mode = 'verified_recovery_import'
)
BEGIN
  SELECT RAISE(ABORT, 'source original result family verification is unavailable during recovery');
END;

-- A schema-44 receipt has NULL here and remains useful only as immutable
-- deployment history. New verification can become current only if no
-- retrieval-visible D1 input changed after the two production probes.
CREATE TRIGGER IF NOT EXISTS source_original_result_family_verification_retrieval_generation_validate
BEFORE INSERT ON source_original_result_family_verifications
WHEN typeof(NEW.retrieval_generation) <> 'integer'
  OR NOT EXISTS (
    SELECT 1 FROM install_state i
     WHERE i.id = 1
       AND i.schema_version >= 45
       AND i.source_original_retrieval_generation = NEW.retrieval_generation
  )
BEGIN
  SELECT RAISE(ABORT, 'retrieval corpus changed before verification seal');
END;

-- A changed chunk may legitimately move away from an old sealed receipt and
-- make that family stale. It may never move back to a sealed digest, and no
-- retrieval-visible field may change while the sealed tuple remains current:
-- SQLite cannot recompute SHA-256, so either path would let direct SQL make
-- immutable verification history look current over different results. Recovery
-- imports authenticated rows before their family seal and is the only bounded
-- exception.
CREATE TRIGGER IF NOT EXISTS chunks_source_original_sealed_receipt_no_revival_update
BEFORE UPDATE OF id,chunk_uid,doc_uid,chunk_ix,text,source,title,document_date,
                 client,category,top_folder,platform,vector_id,
                 bound_document_revision_id,result_chunk_receipt_hash ON chunks
WHEN NOT EXISTS (
       SELECT 1 FROM source_original_result_family_recovery_state
        WHERE id = 1 AND mode = 'verified_recovery_import'
     )
 AND (
   NEW.id IS NOT OLD.id OR NEW.chunk_uid IS NOT OLD.chunk_uid OR
   NEW.doc_uid IS NOT OLD.doc_uid OR NEW.chunk_ix IS NOT OLD.chunk_ix OR
   NEW.text IS NOT OLD.text OR NEW.source IS NOT OLD.source OR
   NEW.title IS NOT OLD.title OR NEW.document_date IS NOT OLD.document_date OR
   NEW.client IS NOT OLD.client OR NEW.category IS NOT OLD.category OR
   NEW.top_folder IS NOT OLD.top_folder OR NEW.platform IS NOT OLD.platform OR
   NEW.vector_id IS NOT OLD.vector_id OR
   NEW.bound_document_revision_id IS NOT OLD.bound_document_revision_id OR
   NEW.result_chunk_receipt_hash IS NOT OLD.result_chunk_receipt_hash
 )
 AND EXISTS (
   SELECT 1
     FROM source_original_result_family_members member
     JOIN source_original_result_family_receipts family
       ON family.family_receipt_hash = member.family_receipt_hash
    WHERE member.document_revision_id = NEW.bound_document_revision_id
      AND member.chunk_ix = NEW.chunk_ix
      AND member.chunk_receipt_hash = NEW.result_chunk_receipt_hash
 )
BEGIN
  SELECT RAISE(ABORT, 'a sealed source-original chunk receipt cannot be revived');
END;

-- INSERT OR REPLACE can otherwise perform the same rollback without reaching
-- the UPDATE trigger. Permit only an exact replay of the existing row. A new or
-- changed row cannot claim a digest already named by portable family history.
CREATE TRIGGER IF NOT EXISTS chunks_source_original_sealed_receipt_no_revival_insert
BEFORE INSERT ON chunks
WHEN NOT EXISTS (
       SELECT 1 FROM source_original_result_family_recovery_state
        WHERE id = 1 AND mode = 'verified_recovery_import'
     )
 AND EXISTS (
   SELECT 1
     FROM source_original_result_family_members member
     JOIN source_original_result_family_receipts family
       ON family.family_receipt_hash = member.family_receipt_hash
    WHERE member.document_revision_id = NEW.bound_document_revision_id
      AND member.chunk_ix = NEW.chunk_ix
      AND member.chunk_receipt_hash = NEW.result_chunk_receipt_hash
 )
 AND NOT EXISTS (
   SELECT 1 FROM chunks old
    WHERE old.id IS NEW.id
      AND old.chunk_uid = NEW.chunk_uid
      AND old.doc_uid = NEW.doc_uid
      AND old.chunk_ix = NEW.chunk_ix
      AND old.text IS NEW.text
      AND old.source IS NEW.source
      AND old.title IS NEW.title
      AND old.document_date IS NEW.document_date
      AND old.client IS NEW.client
      AND old.category IS NEW.category
      AND old.top_folder IS NEW.top_folder
      AND old.platform IS NEW.platform
      AND old.vector_id IS NEW.vector_id
      AND old.bound_document_revision_id IS NEW.bound_document_revision_id
      AND old.result_chunk_receipt_hash IS NEW.result_chunk_receipt_hash
 )
BEGIN
  SELECT RAISE(ABORT, 'a sealed source-original chunk receipt cannot be reinserted');
END;

CREATE TRIGGER IF NOT EXISTS source_original_accepted_resolution_no_duplicate_insert
BEFORE INSERT ON source_original_accepted_resolutions
WHEN EXISTS (
  SELECT 1 FROM source_original_accepted_resolutions
   WHERE sequence = NEW.sequence OR resolution_hash = NEW.resolution_hash OR
         (source = NEW.source AND original_id = NEW.original_id AND
          (resolves_observation_hash = NEW.resolves_observation_hash OR
           accepted_observation_hash = NEW.accepted_observation_hash))
)
BEGIN
  SELECT RAISE(ABORT, 'source original accepted resolution cannot be replaced');
END;

-- Outside recovery, only the still-present ephemeral admission row may create
-- portable history. The AFTER admission trigger consumes it only after all
-- children have succeeded.
CREATE TRIGGER IF NOT EXISTS source_original_accepted_resolution_requires_admission
BEFORE INSERT ON source_original_accepted_resolutions
WHEN NOT EXISTS (
       SELECT 1 FROM source_original_result_family_recovery_state
        WHERE id = 1 AND mode = 'verified_recovery_import'
     )
 AND NOT EXISTS (
   SELECT 1 FROM source_original_accepted_resolution_admissions a
    WHERE a.resolution_hash = NEW.resolution_hash
      AND a.contract_version = NEW.contract_version
      AND a.tenant_id = NEW.tenant_id
      AND a.source = NEW.source
      AND a.original_id = NEW.original_id
      AND a.locator_kind = NEW.locator_kind
      AND a.original_content_sha256 = NEW.original_content_sha256
      AND a.original_byte_count = NEW.original_byte_count
      AND a.resolves_observation_hash = NEW.resolves_observation_hash
      AND a.accepted_observation_hash = NEW.accepted_observation_hash
      AND a.result_document_count = NEW.result_document_count
      AND a.result_document_set_hash = NEW.result_document_set_hash
      AND a.family_receipt_hash = NEW.family_receipt_hash
      AND a.verification_hash = NEW.admission_verification_hash
      AND a.recorded_at = NEW.admitted_at
 )
BEGIN
  SELECT RAISE(ABORT, 'source original accepted resolution requires an atomic admission');
END;

-- Recovery imports the already accepted observation before this compact row.
-- Portable relations remain fully checked even though the old deployment's
-- verification row is deliberately absent.
CREATE TRIGGER IF NOT EXISTS source_original_accepted_resolution_validate_recovery_insert
BEFORE INSERT ON source_original_accepted_resolutions
WHEN EXISTS (
  SELECT 1 FROM source_original_result_family_recovery_state
   WHERE id = 1 AND mode = 'verified_recovery_import'
) AND NOT EXISTS (
  SELECT 1
    FROM source_original_observations accepted
    JOIN source_original_result_family_receipts family
      ON family.family_receipt_hash = NEW.family_receipt_hash
     AND family.tenant_id = NEW.tenant_id
     AND family.source = NEW.source
     AND family.original_id = NEW.original_id
     AND family.locator_kind = NEW.locator_kind
     AND family.original_content_sha256 = NEW.original_content_sha256
     AND family.original_byte_count = NEW.original_byte_count
     AND family.document_count = NEW.result_document_count
   WHERE accepted.source = NEW.source
     AND accepted.original_id = NEW.original_id
     AND accepted.locator_kind = NEW.locator_kind
     AND accepted.observation_hash = NEW.accepted_observation_hash
     AND accepted.observation_stage = 'repair'
     AND accepted.outcome = 'accepted'
     AND accepted.reason_code = 'accepted_provenance_verified'
     AND accepted.original_content_sha256 = NEW.original_content_sha256
     AND accepted.original_byte_count = NEW.original_byte_count
     AND accepted.resolves_observation_hash = NEW.resolves_observation_hash
     AND accepted.result_document_count = NEW.result_document_count
     AND accepted.result_document_set_hash = NEW.result_document_set_hash
     AND accepted.recorded_at = NEW.admitted_at
     AND (SELECT count(*) FROM source_original_observations prior
           WHERE prior.source = NEW.source
             AND prior.original_id = NEW.original_id
             AND prior.locator_kind = NEW.locator_kind
             AND prior.observation_hash = NEW.resolves_observation_hash
             AND prior.outcome IN ('gap','failed')
             AND prior.original_content_sha256 = NEW.original_content_sha256
             AND prior.original_byte_count = NEW.original_byte_count
             AND prior.recorded_at <= NEW.admitted_at
             AND (prior.result_document_count <> accepted.result_document_count OR
                  prior.result_document_set_hash <> accepted.result_document_set_hash)) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'recovered source original accepted resolution is not exact portable history');
END;

CREATE TRIGGER IF NOT EXISTS source_original_accepted_resolution_no_update
BEFORE UPDATE ON source_original_accepted_resolutions
BEGIN
  SELECT RAISE(ABORT, 'source original accepted resolutions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS source_original_accepted_resolution_no_delete
BEFORE DELETE ON source_original_accepted_resolutions
BEGIN
  SELECT RAISE(ABORT, 'source original accepted resolutions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS source_original_accepted_resolution_activation_no_duplicate_insert
BEFORE INSERT ON source_original_accepted_resolution_activations
WHEN EXISTS (
  SELECT 1 FROM source_original_accepted_resolution_activations
   WHERE sequence = NEW.sequence OR activation_hash = NEW.activation_hash OR
         (resolution_hash = NEW.resolution_hash AND verification_hash = NEW.verification_hash)
)
BEGIN
  SELECT RAISE(ABORT, 'source original accepted resolution activation cannot be replaced');
END;

-- Every activation is an admission child, including reactivation after
-- recovery. Requiring that still-present ephemeral row prevents direct SQL
-- from turning portable history into current authority with an invented hash.
CREATE TRIGGER IF NOT EXISTS source_original_accepted_resolution_activation_validate_insert
BEFORE INSERT ON source_original_accepted_resolution_activations
WHEN EXISTS (
       SELECT 1 FROM source_original_result_family_recovery_state
        WHERE id = 1 AND mode = 'verified_recovery_import'
     ) OR NOT EXISTS (
  SELECT 1
    FROM source_original_accepted_resolutions resolution
    JOIN source_original_result_family_verifications verification
      ON verification.verification_hash = NEW.verification_hash
     AND verification.family_receipt_hash = resolution.family_receipt_hash
     AND verification.tenant_id = NEW.tenant_id
    JOIN source_original_current_result_family_verifications current
      ON current.verification_hash = verification.verification_hash
     AND current.family_receipt_hash = verification.family_receipt_hash
    JOIN source_original_accepted_resolution_admissions admission
      ON admission.resolution_hash = resolution.resolution_hash
     AND admission.contract_version = NEW.contract_version
     AND admission.tenant_id = NEW.tenant_id
     AND admission.verification_hash = NEW.verification_hash
     AND admission.activation_hash = NEW.activation_hash
     AND admission.activated_at = NEW.activated_at
   WHERE resolution.resolution_hash = NEW.resolution_hash
     AND resolution.tenant_id = NEW.tenant_id
     AND verification.verified_at <= NEW.activated_at
)
BEGIN
  SELECT RAISE(ABORT, 'source original accepted resolution activation requires a current exact admission and verification');
END;

CREATE TRIGGER IF NOT EXISTS source_original_accepted_resolution_activation_no_update
BEFORE UPDATE ON source_original_accepted_resolution_activations
BEGIN
  SELECT RAISE(ABORT, 'source original accepted resolution activations are append-only');
END;

CREATE TRIGGER IF NOT EXISTS source_original_accepted_resolution_activation_no_delete
BEFORE DELETE ON source_original_accepted_resolution_activations
BEGIN
  SELECT RAISE(ABORT, 'source original accepted resolution activations are append-only');
END;

-- Validate every independently observed relation immediately before the
-- ephemeral gate can create its children. Current verification is a view over
-- live D1 state, so a concurrent family or outbox writer that commits first
-- makes this statement fail. D1 serializes the batch transaction after that
-- check; a later corpus write makes current status disappear dynamically.
CREATE TRIGGER IF NOT EXISTS source_original_accepted_resolution_admission_validate_insert
BEFORE INSERT ON source_original_accepted_resolution_admissions
BEGIN
  SELECT RAISE(ABORT, 'source original accepted resolution admission is unavailable during recovery') WHERE EXISTS (
    SELECT 1 FROM source_original_result_family_recovery_state
     WHERE id = 1 AND mode = 'verified_recovery_import'
  );

  SELECT RAISE(ABORT, 'source original accepted resolution requires one unresolved exact-byte observation') WHERE
    (SELECT count(*) FROM source_original_observations prior
      WHERE prior.source = NEW.source
        AND prior.original_id = NEW.original_id
        AND prior.locator_kind = NEW.locator_kind
        AND prior.observation_hash = NEW.resolves_observation_hash
        AND prior.outcome IN ('gap','failed')
        AND prior.original_content_sha256 = NEW.original_content_sha256
        AND prior.original_byte_count = NEW.original_byte_count
        AND prior.recorded_at <= NEW.recorded_at
        AND (prior.result_document_count <> NEW.result_document_count OR
             prior.result_document_set_hash <> NEW.result_document_set_hash)) <> 1;

  SELECT RAISE(ABORT, 'source original accepted resolution family does not match the proposed observation') WHERE NOT EXISTS (
    SELECT 1 FROM source_original_result_family_receipts family
     WHERE family.family_receipt_hash = NEW.family_receipt_hash
       AND family.tenant_id = NEW.tenant_id
       AND family.source = NEW.source
       AND family.original_id = NEW.original_id
       AND family.locator_kind = NEW.locator_kind
       AND family.original_content_sha256 = NEW.original_content_sha256
       AND family.original_byte_count = NEW.original_byte_count
       AND family.document_count = NEW.result_document_count
       AND family.sealed_at <= NEW.recorded_at
  );

  SELECT RAISE(ABORT, 'source original accepted resolution verification is stale') WHERE NOT EXISTS (
    SELECT 1
      FROM source_original_result_family_verifications verification
      JOIN source_original_current_result_family_verifications current
        ON current.verification_hash = verification.verification_hash
       AND current.family_receipt_hash = verification.family_receipt_hash
     WHERE verification.verification_hash = NEW.verification_hash
       AND verification.family_receipt_hash = NEW.family_receipt_hash
       AND verification.tenant_id = NEW.tenant_id
       AND verification.verified_at <= NEW.activated_at
       AND NOT EXISTS (
         SELECT 1
           FROM source_original_result_family_members member
           JOIN documents document
             ON document.document_revision_id = member.document_revision_id
            AND document.source_original_binding_hash = member.source_original_binding_hash
          WHERE member.family_receipt_hash = NEW.family_receipt_hash
            AND (
              (NEW.text_state = 'native_readable' AND document.text_source IS NOT 'native') OR
              (NEW.text_state = 'ocr_reliable' AND document.text_source IS NOT 'ocr')
            )
       )
       AND (
         verification.verified_at <= NEW.recorded_at OR EXISTS (
           SELECT 1 FROM source_original_accepted_resolutions resolution
            WHERE resolution.resolution_hash = NEW.resolution_hash
              AND resolution.admitted_at = NEW.recorded_at
         )
       )
  );

  -- Existing portable history is usable only when it is exact. The local
  -- verification and activation may legitimately differ after recovery.
  SELECT RAISE(ABORT, 'source original accepted resolution conflicts with immutable history') WHERE
    (
      EXISTS (
        SELECT 1 FROM source_original_accepted_resolutions resolution
         WHERE resolution.resolution_hash = NEW.resolution_hash
            OR (resolution.source = NEW.source AND resolution.original_id = NEW.original_id AND
                (resolution.resolves_observation_hash = NEW.resolves_observation_hash OR
                 resolution.accepted_observation_hash = NEW.accepted_observation_hash))
      ) OR EXISTS (
        SELECT 1 FROM source_original_observations accepted
         WHERE (accepted.source = NEW.source AND accepted.original_id = NEW.original_id AND
                accepted.observation_hash = NEW.accepted_observation_hash)
            OR (accepted.run_id = NEW.run_id AND accepted.original_id = NEW.original_id)
      )
    ) AND NOT (
      EXISTS (
        SELECT 1 FROM source_original_accepted_resolutions resolution
         WHERE resolution.resolution_hash = NEW.resolution_hash
           AND resolution.contract_version = NEW.contract_version
           AND resolution.tenant_id = NEW.tenant_id
           AND resolution.source = NEW.source
           AND resolution.original_id = NEW.original_id
           AND resolution.locator_kind = NEW.locator_kind
           AND resolution.original_content_sha256 = NEW.original_content_sha256
           AND resolution.original_byte_count = NEW.original_byte_count
           AND resolution.resolves_observation_hash = NEW.resolves_observation_hash
           AND resolution.accepted_observation_hash = NEW.accepted_observation_hash
           AND resolution.result_document_count = NEW.result_document_count
           AND resolution.result_document_set_hash = NEW.result_document_set_hash
           AND resolution.family_receipt_hash = NEW.family_receipt_hash
           AND resolution.admitted_at = NEW.recorded_at
      ) AND EXISTS (
        SELECT 1 FROM source_original_observations accepted
         WHERE accepted.contract_version = NEW.contract_version
           AND accepted.tenant_id = NEW.tenant_id
           AND accepted.source = NEW.source
           AND accepted.original_id = NEW.original_id
           AND accepted.locator_kind = NEW.locator_kind
           AND accepted.run_id = NEW.run_id
           AND accepted.plan_id = NEW.plan_id
           AND accepted.source_snapshot_id = NEW.source_snapshot_id
           AND accepted.target_set_hash = NEW.target_set_hash
           AND accepted.target_count = NEW.target_count
           AND accepted.observation_stage = 'repair'
           AND accepted.outcome = 'accepted'
           AND accepted.reason_code = 'accepted_provenance_verified'
           AND accepted.text_state = NEW.text_state
           AND accepted.original_content_sha256 = NEW.original_content_sha256
           AND accepted.original_byte_count = NEW.original_byte_count
           AND accepted.page_count IS NEW.page_count
           AND accepted.page_count_state = NEW.page_count_state
           AND accepted.result_document_count = NEW.result_document_count
           AND accepted.result_document_set_hash = NEW.result_document_set_hash
           AND accepted.resolves_observation_hash = NEW.resolves_observation_hash
           AND accepted.observation_hash = NEW.accepted_observation_hash
           AND accepted.recorded_at = NEW.recorded_at
      )
    );

  -- A serialized loser of the same-timestamp admission race must not look like
  -- a successful new record. Abort the all-no-op child insert so the Worker can
  -- reconcile the exact winner through its integrity-checked readback path.
  SELECT RAISE(ABORT, 'source original accepted resolution exact replay already committed') WHERE EXISTS (
    SELECT 1 FROM source_original_accepted_resolution_activations activation
     WHERE activation.contract_version = NEW.contract_version
       AND activation.tenant_id = NEW.tenant_id
       AND activation.resolution_hash = NEW.resolution_hash
       AND activation.verification_hash = NEW.verification_hash
       AND activation.activation_hash = NEW.activation_hash
       AND activation.activated_at = NEW.activated_at
  );

  SELECT RAISE(ABORT, 'source original accepted resolution activation conflicts with immutable history') WHERE EXISTS (
    SELECT 1 FROM source_original_accepted_resolution_activations activation
     WHERE (activation.resolution_hash = NEW.resolution_hash AND
            activation.verification_hash = NEW.verification_hash)
        OR activation.activation_hash = NEW.activation_hash
  ) AND NOT EXISTS (
    SELECT 1 FROM source_original_accepted_resolution_activations activation
     WHERE activation.contract_version = NEW.contract_version
       AND activation.tenant_id = NEW.tenant_id
       AND activation.resolution_hash = NEW.resolution_hash
       AND activation.verification_hash = NEW.verification_hash
       AND activation.activation_hash = NEW.activation_hash
       AND activation.activated_at = NEW.activated_at
  );
END;

CREATE TRIGGER IF NOT EXISTS source_original_accepted_resolution_admission_no_update
BEFORE UPDATE ON source_original_accepted_resolution_admissions
BEGIN
  SELECT RAISE(ABORT, 'source original accepted resolution admissions cannot be updated');
END;

-- The portable relation is inserted first, then its local activation, then the
-- accepted observation. The admission row remains visible to each child guard
-- until the final DELETE. Any RAISE aborts the complete outer statement.
CREATE TRIGGER IF NOT EXISTS source_original_accepted_resolution_admission_commit
AFTER INSERT ON source_original_accepted_resolution_admissions
BEGIN
  INSERT INTO source_original_accepted_resolutions
    (contract_version,tenant_id,source,original_id,locator_kind,
     original_content_sha256,original_byte_count,resolves_observation_hash,
     accepted_observation_hash,result_document_count,result_document_set_hash,
     family_receipt_hash,admission_verification_hash,
     resolution_hash,admitted_at)
  SELECT
     NEW.contract_version,NEW.tenant_id,NEW.source,NEW.original_id,NEW.locator_kind,
     NEW.original_content_sha256,NEW.original_byte_count,NEW.resolves_observation_hash,
     NEW.accepted_observation_hash,NEW.result_document_count,NEW.result_document_set_hash,
     NEW.family_receipt_hash,NEW.verification_hash,
     NEW.resolution_hash,NEW.recorded_at
   WHERE NOT EXISTS (
     SELECT 1 FROM source_original_accepted_resolutions resolution
      WHERE resolution.resolution_hash = NEW.resolution_hash
   );

  INSERT INTO source_original_accepted_resolution_activations
    (contract_version,tenant_id,resolution_hash,verification_hash,activation_hash,activated_at)
  SELECT
     NEW.contract_version,NEW.tenant_id,NEW.resolution_hash,NEW.verification_hash,
     NEW.activation_hash,NEW.activated_at
   WHERE NOT EXISTS (
     SELECT 1 FROM source_original_accepted_resolution_activations activation
      WHERE activation.resolution_hash = NEW.resolution_hash
        AND activation.verification_hash = NEW.verification_hash
        AND activation.activation_hash = NEW.activation_hash
   );

  INSERT INTO source_original_observations
    (contract_version,tenant_id,source,original_id,locator_kind,run_id,plan_id,
     source_snapshot_id,target_set_hash,target_count,observation_stage,outcome,
     reason_code,text_state,original_content_sha256,original_byte_count,page_count,
     page_count_state,result_document_count,result_document_set_hash,
     resolves_observation_hash,observation_hash,recorded_at)
  SELECT
     NEW.contract_version,NEW.tenant_id,NEW.source,NEW.original_id,NEW.locator_kind,
     NEW.run_id,NEW.plan_id,NEW.source_snapshot_id,NEW.target_set_hash,NEW.target_count,
     'repair','accepted','accepted_provenance_verified',NEW.text_state,
     NEW.original_content_sha256,NEW.original_byte_count,NEW.page_count,
     NEW.page_count_state,NEW.result_document_count,NEW.result_document_set_hash,
     NEW.resolves_observation_hash,NEW.accepted_observation_hash,NEW.recorded_at
   WHERE NOT EXISTS (
     SELECT 1 FROM source_original_observations accepted
      WHERE accepted.source = NEW.source
        AND accepted.original_id = NEW.original_id
        AND accepted.observation_hash = NEW.accepted_observation_hash
   );

  DELETE FROM source_original_accepted_resolution_admissions
   WHERE resolution_hash = NEW.resolution_hash;
END;

-- An acceptance is currently verified only through a local activation whose
-- verification still satisfies the live schema-44 family and vector fences.
-- Recovery restores neither side of that deployment-local join.
CREATE VIEW IF NOT EXISTS source_original_current_accepted_resolutions AS
SELECT resolution.sequence,
       resolution.source,
       resolution.original_id,
       resolution.locator_kind,
       resolution.resolves_observation_hash,
       resolution.accepted_observation_hash,
       resolution.family_receipt_hash,
       resolution.resolution_hash,
       resolution.admitted_at
  FROM source_original_accepted_resolutions resolution
  JOIN source_original_observations accepted
    ON accepted.source = resolution.source
   AND accepted.original_id = resolution.original_id
   AND accepted.locator_kind = resolution.locator_kind
   AND accepted.observation_hash = resolution.accepted_observation_hash
   AND accepted.observation_stage = 'repair'
   AND accepted.outcome = 'accepted'
   AND accepted.reason_code = 'accepted_provenance_verified'
   AND accepted.original_content_sha256 = resolution.original_content_sha256
   AND accepted.original_byte_count = resolution.original_byte_count
   AND accepted.resolves_observation_hash = resolution.resolves_observation_hash
   AND accepted.result_document_count = resolution.result_document_count
   AND accepted.result_document_set_hash = resolution.result_document_set_hash
  JOIN source_original_result_family_receipts family
    ON family.family_receipt_hash = resolution.family_receipt_hash
   AND family.tenant_id = resolution.tenant_id
   AND family.source = resolution.source
   AND family.original_id = resolution.original_id
   AND family.locator_kind = resolution.locator_kind
   AND family.original_content_sha256 = resolution.original_content_sha256
   AND family.original_byte_count = resolution.original_byte_count
   AND family.document_count = resolution.result_document_count
 WHERE EXISTS (
   SELECT 1
     FROM source_original_accepted_resolution_activations activation
     JOIN source_original_current_result_family_verifications current
       ON current.verification_hash = activation.verification_hash
      AND current.family_receipt_hash = resolution.family_receipt_hash
    WHERE activation.resolution_hash = resolution.resolution_hash
      AND activation.tenant_id = resolution.tenant_id
 )
   AND accepted.text_state IN ('native_readable','ocr_reliable')
   AND NOT EXISTS (
     SELECT 1
       FROM source_original_result_family_members member
       JOIN documents document
         ON document.document_revision_id = member.document_revision_id
        AND document.source_original_binding_hash = member.source_original_binding_hash
      WHERE member.family_receipt_hash = resolution.family_receipt_hash
        AND (
          (accepted.text_state = 'native_readable' AND document.text_source IS NOT 'native') OR
          (accepted.text_state = 'ocr_reliable' AND document.text_source IS NOT 'ocr')
        )
   );

-- Recovery may import accepted observations before their portable resolution
-- rows. The marker is the only such interval. Closing it proves the complete
-- portable bijection and proves that no source-deployment verification or local
-- authority leaked into the target artifact.
CREATE TRIGGER IF NOT EXISTS source_original_accepted_resolution_recovery_close_validate
BEFORE DELETE ON source_original_result_family_recovery_state
WHEN OLD.id = 1 AND OLD.mode = 'verified_recovery_import'
BEGIN
  SELECT RAISE(ABORT, 'source original accepted resolution recovery contains deployment-local state') WHERE
    EXISTS (SELECT 1 FROM source_original_result_family_verifications)
    OR EXISTS (SELECT 1 FROM source_original_accepted_resolution_activations)
    OR EXISTS (SELECT 1 FROM source_original_accepted_resolution_admissions);

  SELECT RAISE(ABORT, 'recovered accepted observations require exact portable resolutions') WHERE EXISTS (
    SELECT 1 FROM source_original_observations accepted
     WHERE accepted.outcome = 'accepted'
       AND (SELECT count(*) FROM source_original_accepted_resolutions resolution
             WHERE resolution.tenant_id = accepted.tenant_id
               AND resolution.source = accepted.source
               AND resolution.original_id = accepted.original_id
               AND resolution.locator_kind = accepted.locator_kind
               AND resolution.original_content_sha256 = accepted.original_content_sha256
               AND resolution.original_byte_count = accepted.original_byte_count
               AND resolution.resolves_observation_hash = accepted.resolves_observation_hash
               AND resolution.accepted_observation_hash = accepted.observation_hash
               AND resolution.result_document_count = accepted.result_document_count
               AND resolution.result_document_set_hash = accepted.result_document_set_hash
               AND resolution.admitted_at = accepted.recorded_at) <> 1
  );

  SELECT RAISE(ABORT, 'recovered source original accepted resolutions require exact portable history') WHERE EXISTS (
    SELECT 1 FROM source_original_accepted_resolutions resolution
     WHERE (
       SELECT count(*)
         FROM source_original_observations accepted
         JOIN source_original_result_family_receipts family
           ON family.family_receipt_hash = resolution.family_receipt_hash
          AND family.tenant_id = resolution.tenant_id
          AND family.source = resolution.source
          AND family.original_id = resolution.original_id
          AND family.locator_kind = resolution.locator_kind
          AND family.original_content_sha256 = resolution.original_content_sha256
          AND family.original_byte_count = resolution.original_byte_count
          AND family.document_count = resolution.result_document_count
        WHERE accepted.source = resolution.source
          AND accepted.original_id = resolution.original_id
          AND accepted.locator_kind = resolution.locator_kind
          AND accepted.observation_hash = resolution.accepted_observation_hash
          AND accepted.observation_stage = 'repair'
          AND accepted.outcome = 'accepted'
          AND accepted.reason_code = 'accepted_provenance_verified'
          AND accepted.original_content_sha256 = resolution.original_content_sha256
          AND accepted.original_byte_count = resolution.original_byte_count
          AND accepted.resolves_observation_hash = resolution.resolves_observation_hash
          AND accepted.result_document_count = resolution.result_document_count
          AND accepted.result_document_set_hash = resolution.result_document_set_hash
          AND accepted.recorded_at = resolution.admitted_at
          AND (SELECT count(*) FROM source_original_observations prior
                WHERE prior.source = resolution.source
                  AND prior.original_id = resolution.original_id
                  AND prior.locator_kind = resolution.locator_kind
                  AND prior.observation_hash = resolution.resolves_observation_hash
                  AND prior.outcome IN ('gap','failed')
                  AND prior.original_content_sha256 = resolution.original_content_sha256
                  AND prior.original_byte_count = resolution.original_byte_count
                  AND prior.recorded_at <= resolution.admitted_at
                  AND (prior.result_document_count <> accepted.result_document_count OR
                       prior.result_document_set_hash <> accepted.result_document_set_hash)) = 1
     ) <> 1
  );
END;

CREATE TRIGGER IF NOT EXISTS source_original_accepted_resolution_recovery_state_validate_insert
BEFORE INSERT ON source_original_result_family_recovery_state
WHEN EXISTS (SELECT 1 FROM source_original_id_key_state)
  OR EXISTS (SELECT 1 FROM source_original_observations)
  OR EXISTS (SELECT 1 FROM source_original_accepted_resolutions)
  OR EXISTS (SELECT 1 FROM source_original_accepted_resolution_activations)
  OR EXISTS (SELECT 1 FROM source_original_accepted_resolution_admissions)
BEGIN
  SELECT RAISE(ABORT, 'source original accepted resolution recovery marker requires an empty target');
END;

-- Install the replacement before removing schema 43's unconditional guard.
-- Thus every independently committed migration prefix still blocks accepted
-- rows unless the exact schema-45 admission is currently executing.
CREATE TRIGGER IF NOT EXISTS source_original_observation_accepted_admission_required
BEFORE INSERT ON source_original_observations
WHEN NEW.outcome = 'accepted'
 AND NOT EXISTS (
       SELECT 1 FROM source_original_result_family_recovery_state
        WHERE id = 1 AND mode = 'verified_recovery_import'
     )
 AND NOT EXISTS (
   SELECT 1
     FROM source_original_accepted_resolution_admissions admission
     JOIN source_original_accepted_resolutions resolution
       ON resolution.resolution_hash = admission.resolution_hash
      AND resolution.accepted_observation_hash = admission.accepted_observation_hash
      AND resolution.resolves_observation_hash = admission.resolves_observation_hash
      AND resolution.family_receipt_hash = admission.family_receipt_hash
     JOIN source_original_accepted_resolution_activations activation
       ON activation.resolution_hash = admission.resolution_hash
      AND activation.verification_hash = admission.verification_hash
      AND activation.activation_hash = admission.activation_hash
      AND activation.activated_at = admission.activated_at
    WHERE admission.source = NEW.source
      AND admission.original_id = NEW.original_id
      AND admission.locator_kind = NEW.locator_kind
      AND admission.run_id = NEW.run_id
      AND admission.plan_id = NEW.plan_id
      AND admission.source_snapshot_id = NEW.source_snapshot_id
      AND admission.target_set_hash = NEW.target_set_hash
      AND admission.target_count = NEW.target_count
      AND NEW.observation_stage = 'repair'
      AND NEW.reason_code = 'accepted_provenance_verified'
      AND admission.text_state = NEW.text_state
      AND admission.original_content_sha256 = NEW.original_content_sha256
      AND admission.original_byte_count = NEW.original_byte_count
      AND admission.page_count IS NEW.page_count
      AND admission.page_count_state = NEW.page_count_state
      AND admission.result_document_count = NEW.result_document_count
      AND admission.result_document_set_hash = NEW.result_document_set_hash
      AND admission.resolves_observation_hash = NEW.resolves_observation_hash
      AND admission.accepted_observation_hash = NEW.observation_hash
      AND admission.recorded_at = NEW.recorded_at
 )
BEGIN
  SELECT RAISE(ABORT, 'accepted source-original outcomes require an atomic schema-45 admission');
END;

DROP TRIGGER IF EXISTS source_original_observation_accepted_disabled;
