-- 0044_source_original_result_family_receipts
--
-- Schema 43 binds exact source-original bytes to one current document revision.
-- Acceptance needs a stronger, separately sealed cut: every current revision in
-- that logical family, every exact stored chunk after title prefixing, and a
-- deployment-local proof that the derived vector and retrieval paths are ready.
--
-- The portable family tables deliberately store no raw locator, doc_uid, title,
-- text, URI, query, answer, or citation reference. Revision ids and hashes are
-- sufficient to verify the current D1 rows without copying private source names
-- into an immutable ledger. The verification table is deployment-local because
-- recovery creates a new Vectorize projection and must prove it again.

ALTER TABLE chunks ADD COLUMN bound_document_revision_id TEXT
  CHECK (bound_document_revision_id IS NULL OR (
    length(bound_document_revision_id) = 71
    AND substr(bound_document_revision_id, 1, 7) = 'rev-v1:'
    AND substr(bound_document_revision_id, 8) = lower(substr(bound_document_revision_id, 8))
    AND substr(bound_document_revision_id, 8) NOT GLOB '*[^0-9a-f]*'
  ));

-- The Worker hashes canonical {contract_version, document_revision_id,
-- chunk_ix, title, text} after chunkText has prepended the title. SQLite has no
-- SHA-256 primitive, so the database enforces exact row-to-receipt equality and
-- the title-prefix invariant; application readback recomputes the digest.
ALTER TABLE chunks ADD COLUMN result_chunk_receipt_hash TEXT
  CHECK (
    (result_chunk_receipt_hash IS NULL AND bound_document_revision_id IS NULL) OR
    (
      length(result_chunk_receipt_hash) = 71
      AND substr(result_chunk_receipt_hash, 1, 7) = 'sha256:'
      AND substr(result_chunk_receipt_hash, 8) = lower(substr(result_chunk_receipt_hash, 8))
      AND substr(result_chunk_receipt_hash, 8) NOT GLOB '*[^0-9a-f]*'
      AND NOT (bound_document_revision_id IS NULL)
      AND (
        title IS NULL OR title = '' OR
        substr(text, 1, length(title) + 4) = '[' || title || ']' || char(10) || char(10)
      )
    )
  );

-- Recovery recreates schema before importing its authenticated, encrypted data
-- artifact. This marker exists before the chunk guards because a schema-43
-- snapshot can legitimately contain a bound document whose adopted chunks are
-- still NULL/NULL. Its activation guard is created after every proof table.
CREATE TABLE IF NOT EXISTS source_original_result_family_recovery_state (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL CHECK (mode = 'verified_recovery_import')
) WITHOUT ROWID;

-- A bound document may never receive an unbound or differently revisioned
-- chunk. Unbound legacy rows retain NULL/NULL and require an authoritative
-- reingest before they can participate in a family seal. Schema-first recovery
-- alone may replay that exact adopted NULL/NULL state; any supplied receipt is
-- always required to match the current document revision.
CREATE TRIGGER IF NOT EXISTS chunks_source_original_receipt_insert
BEFORE INSERT ON chunks
WHEN (
  (NEW.bound_document_revision_id IS NOT NULL OR NEW.result_chunk_receipt_hash IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM documents d
     WHERE d.doc_uid = NEW.doc_uid
       AND d.source_original_binding_hash IS NOT NULL
       AND d.document_revision_id = NEW.bound_document_revision_id
       AND NEW.result_chunk_receipt_hash IS NOT NULL
       AND (
         d.deleted_at IS NULL OR EXISTS (
           SELECT 1 FROM source_original_result_family_recovery_state
            WHERE id = 1 AND mode = 'verified_recovery_import'
         )
       )
  )
) OR (
  NEW.bound_document_revision_id IS NULL
  AND NEW.result_chunk_receipt_hash IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM source_original_result_family_recovery_state
     WHERE id = 1 AND mode = 'verified_recovery_import'
  )
  AND EXISTS (
    SELECT 1 FROM documents d
     WHERE d.doc_uid = NEW.doc_uid AND d.source_original_binding_hash IS NOT NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'bound source-original chunks require the exact current document revision and chunk receipt');
END;

CREATE TRIGGER IF NOT EXISTS chunks_source_original_receipt_update
BEFORE UPDATE OF doc_uid, bound_document_revision_id, result_chunk_receipt_hash ON chunks
WHEN (
  NEW.bound_document_revision_id IS NOT NULL OR
  NEW.result_chunk_receipt_hash IS NOT NULL OR
  EXISTS (
    SELECT 1 FROM documents d
     WHERE d.doc_uid = NEW.doc_uid AND d.source_original_binding_hash IS NOT NULL
  )
) AND NOT EXISTS (
  SELECT 1 FROM documents d
   WHERE d.doc_uid = NEW.doc_uid
     AND d.deleted_at IS NULL
     AND d.source_original_binding_hash IS NOT NULL
     AND d.document_revision_id = NEW.bound_document_revision_id
     AND NEW.result_chunk_receipt_hash IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'bound source-original chunks require the exact current document revision and chunk receipt');
END;

-- A low-level edit cannot retain a digest stamped over different chunk bytes or
-- a different source/title/index/revision. Normal ingest supplies a freshly
-- computed hash in the same upsert that changes these fields.
CREATE TRIGGER IF NOT EXISTS chunks_source_original_receipt_no_stale_update
BEFORE UPDATE OF doc_uid, chunk_ix, text, source, title, bound_document_revision_id ON chunks
WHEN OLD.result_chunk_receipt_hash IS NOT NULL
 AND NEW.result_chunk_receipt_hash IS OLD.result_chunk_receipt_hash
 AND (
   NEW.doc_uid IS NOT OLD.doc_uid OR
   NEW.chunk_ix IS NOT OLD.chunk_ix OR
   NEW.text IS NOT OLD.text OR
   NEW.source IS NOT OLD.source OR
   NEW.title IS NOT OLD.title OR
   NEW.bound_document_revision_id IS NOT OLD.bound_document_revision_id
 )
BEGIN
  SELECT RAISE(ABORT, 'a changed source-original chunk requires a new chunk receipt');
END;

-- INSERT OR REPLACE performs its implicit delete after BEFORE INSERT triggers
-- and may not fire DELETE triggers. Refuse reuse of a committed digest over a
-- changed canonical tuple before SQLite can replace the row. A normal new
-- document revision carries a newly computed digest and remains writable.
CREATE TRIGGER IF NOT EXISTS chunks_source_original_receipt_no_stale_replace
BEFORE INSERT ON chunks
WHEN EXISTS (
  SELECT 1 FROM chunks old
   WHERE old.chunk_uid = NEW.chunk_uid
     AND old.result_chunk_receipt_hash IS NOT NULL
     AND NEW.result_chunk_receipt_hash IS old.result_chunk_receipt_hash
     AND (
       NEW.doc_uid IS NOT old.doc_uid OR
       NEW.chunk_ix IS NOT old.chunk_ix OR
       NEW.text IS NOT old.text OR
       NEW.source IS NOT old.source OR
       NEW.title IS NOT old.title OR
       NEW.bound_document_revision_id IS NOT old.bound_document_revision_id
     )
)
BEGIN
  SELECT RAISE(ABORT, 'a changed source-original chunk cannot reuse a chunk receipt');
END;

-- Child rows are staged first under the final receipt hash. The parent receipt
-- is inserted last and acts as the seal. There is intentionally no foreign key
-- to that not-yet-present parent; triggers make sealed rows immutable.
CREATE TABLE IF NOT EXISTS source_original_result_family_members (
  family_receipt_hash          TEXT NOT NULL,
  document_revision_id        TEXT NOT NULL,
  source_original_binding_hash TEXT NOT NULL,
  chunk_ix                     INTEGER NOT NULL,
  chunk_receipt_hash           TEXT NOT NULL,

  PRIMARY KEY (family_receipt_hash, document_revision_id, chunk_ix),
  CHECK (length(family_receipt_hash) = 71 AND substr(family_receipt_hash,1,7) = 'sha256:' AND
         substr(family_receipt_hash,8) = lower(substr(family_receipt_hash,8)) AND
         substr(family_receipt_hash,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(document_revision_id) = 71 AND substr(document_revision_id,1,7) = 'rev-v1:' AND
         substr(document_revision_id,8) = lower(substr(document_revision_id,8)) AND
         substr(document_revision_id,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(source_original_binding_hash) = 71 AND substr(source_original_binding_hash,1,7) = 'sha256:' AND
         substr(source_original_binding_hash,8) = lower(substr(source_original_binding_hash,8)) AND
         substr(source_original_binding_hash,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(chunk_ix) = 'integer' AND chunk_ix BETWEEN 0 AND 9007199254740991),
  CHECK (length(chunk_receipt_hash) = 71 AND substr(chunk_receipt_hash,1,7) = 'sha256:' AND
         substr(chunk_receipt_hash,8) = lower(substr(chunk_receipt_hash,8)) AND
         substr(chunk_receipt_hash,8) NOT GLOB '*[^0-9a-f]*')
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_source_original_result_family_members_revision
  ON source_original_result_family_members (document_revision_id);

CREATE TRIGGER IF NOT EXISTS source_original_result_family_member_no_duplicate_insert
BEFORE INSERT ON source_original_result_family_members
WHEN EXISTS (
  SELECT 1 FROM source_original_result_family_members
   WHERE family_receipt_hash = NEW.family_receipt_hash
     AND document_revision_id = NEW.document_revision_id
     AND chunk_ix = NEW.chunk_ix
)
BEGIN
  SELECT RAISE(ABORT, 'source original result family member cannot be replaced');
END;

CREATE TRIGGER IF NOT EXISTS source_original_result_family_member_after_seal_insert
BEFORE INSERT ON source_original_result_family_members
WHEN EXISTS (
  SELECT 1 FROM source_original_result_family_receipts
   WHERE family_receipt_hash = NEW.family_receipt_hash
)
BEGIN
  SELECT RAISE(ABORT, 'sealed source original result family members are immutable');
END;

CREATE TRIGGER IF NOT EXISTS source_original_result_family_member_no_update
BEFORE UPDATE ON source_original_result_family_members
BEGIN
  SELECT RAISE(ABORT, 'source original result family members are immutable');
END;

CREATE TRIGGER IF NOT EXISTS source_original_result_family_member_no_sealed_delete
BEFORE DELETE ON source_original_result_family_members
WHEN EXISTS (
  SELECT 1 FROM source_original_result_family_receipts
   WHERE family_receipt_hash = OLD.family_receipt_hash
)
BEGIN
  SELECT RAISE(ABORT, 'sealed source original result family members are immutable');
END;

CREATE TABLE IF NOT EXISTS source_original_result_family_receipts (
  sequence                INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_version        INTEGER NOT NULL,
  tenant_id               TEXT NOT NULL,
  source                  TEXT NOT NULL,
  original_id             TEXT NOT NULL,
  locator_kind            TEXT NOT NULL,
  original_content_sha256 TEXT NOT NULL,
  original_byte_count     INTEGER NOT NULL,
  document_count          INTEGER NOT NULL,
  document_set_hash       TEXT NOT NULL,
  chunk_count             INTEGER NOT NULL,
  chunk_set_hash          TEXT NOT NULL,
  family_receipt_hash     TEXT NOT NULL UNIQUE,
  sealed_at               INTEGER NOT NULL,

  CHECK (contract_version = 1),
  CHECK (tenant_id = 'primary'),
  CHECK (source GLOB '[a-z0-9]*' AND source NOT GLOB '*[^a-z0-9_-]*' AND length(source) BETWEEN 1 AND 64),
  CHECK (length(original_id) = 76 AND substr(original_id,1,12) = 'hmac-sha256:' AND
         substr(original_id,13) = lower(substr(original_id,13)) AND
         substr(original_id,13) NOT GLOB '*[^0-9a-f]*'),
  CHECK (locator_kind = 'source_relative_path'),
  CHECK (length(original_content_sha256) = 64 AND original_content_sha256 = lower(original_content_sha256) AND
         original_content_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(original_byte_count) = 'integer' AND original_byte_count BETWEEN 0 AND 9007199254740991),
  CHECK (typeof(document_count) = 'integer' AND document_count BETWEEN 1 AND 256),
  CHECK (length(document_set_hash) = 71 AND substr(document_set_hash,1,7) = 'sha256:' AND
         substr(document_set_hash,8) = lower(substr(document_set_hash,8)) AND
         substr(document_set_hash,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(chunk_count) = 'integer' AND chunk_count BETWEEN document_count AND 9007199254740991),
  CHECK (length(chunk_set_hash) = 71 AND substr(chunk_set_hash,1,7) = 'sha256:' AND
         substr(chunk_set_hash,8) = lower(substr(chunk_set_hash,8)) AND
         substr(chunk_set_hash,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(family_receipt_hash) = 71 AND substr(family_receipt_hash,1,7) = 'sha256:' AND
         substr(family_receipt_hash,8) = lower(substr(family_receipt_hash,8)) AND
         substr(family_receipt_hash,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(sealed_at) = 'integer' AND sealed_at >= 0)
);

CREATE INDEX IF NOT EXISTS idx_source_original_result_family_receipts_original_sequence
  ON source_original_result_family_receipts (source, original_id, sequence DESC);

CREATE TRIGGER IF NOT EXISTS source_original_result_family_receipt_no_duplicate_insert
BEFORE INSERT ON source_original_result_family_receipts
WHEN EXISTS (
  SELECT 1 FROM source_original_result_family_receipts
   WHERE sequence = NEW.sequence OR family_receipt_hash = NEW.family_receipt_hash
)
BEGIN
  SELECT RAISE(ABORT, 'source original result family receipt cannot be replaced');
END;

-- The receipt insert is the portable seal. Counts plus one-to-one joins prove
-- set equality without storing path-bearing document or chunk identifiers.
-- The immutable schema-43 binding ledger is the family relation: every live
-- document pointing at a binding for these exact original bytes must appear,
-- and every current chunk under those documents must have one member row.
CREATE TRIGGER IF NOT EXISTS source_original_result_family_receipt_validate_insert
BEFORE INSERT ON source_original_result_family_receipts
BEGIN
  SELECT RAISE(ABORT, 'source original result family member counts do not match the seal') WHERE
    (SELECT count(*) FROM source_original_result_family_members m
      WHERE m.family_receipt_hash = NEW.family_receipt_hash) <> NEW.chunk_count
    OR
    (SELECT count(DISTINCT m.document_revision_id)
       FROM source_original_result_family_members m
      WHERE m.family_receipt_hash = NEW.family_receipt_hash) <> NEW.document_count;

  -- Immutable schema-43 bindings are portable history. Validate them even
  -- during recovery, when the corresponding revision may no longer be current.
  SELECT RAISE(ABORT, 'source original result family member is not bound to the sealed original') WHERE EXISTS (
    SELECT 1
      FROM source_original_result_family_members m
      LEFT JOIN source_original_result_bindings b
        ON b.binding_hash = m.source_original_binding_hash
       AND b.document_revision_id = m.document_revision_id
     WHERE m.family_receipt_hash = NEW.family_receipt_hash
       AND (
         b.sequence IS NULL OR b.tenant_id IS NOT NEW.tenant_id OR b.source IS NOT NEW.source OR
         b.original_id IS NOT NEW.original_id OR b.locator_kind IS NOT NEW.locator_kind OR
         b.original_content_sha256 IS NOT NEW.original_content_sha256 OR
         b.original_byte_count IS NOT NEW.original_byte_count
       )
  );

  SELECT RAISE(ABORT, 'source original result family member is not an exact current bound chunk') WHERE EXISTS (
    SELECT 1
      FROM source_original_result_family_members m
      LEFT JOIN documents d
        ON d.document_revision_id = m.document_revision_id
      LEFT JOIN chunks c
        ON c.doc_uid = d.doc_uid AND c.chunk_ix = m.chunk_ix
      LEFT JOIN source_original_result_bindings b
        ON b.binding_hash = m.source_original_binding_hash
       AND b.document_revision_id = m.document_revision_id
     WHERE NOT EXISTS (
             SELECT 1 FROM source_original_result_family_recovery_state
              WHERE id = 1 AND mode = 'verified_recovery_import'
           )
       AND m.family_receipt_hash = NEW.family_receipt_hash
       AND (
         d.doc_uid IS NULL OR d.deleted_at IS NOT NULL OR d.source IS NOT NEW.source OR
         d.source_original_binding_hash IS NOT m.source_original_binding_hash OR
         c.chunk_uid IS NULL OR c.source IS NOT d.source OR c.title IS NOT d.title OR
         c.bound_document_revision_id IS NOT m.document_revision_id OR
         c.result_chunk_receipt_hash IS NOT m.chunk_receipt_hash OR
         b.sequence IS NULL OR b.tenant_id IS NOT NEW.tenant_id OR b.source IS NOT NEW.source OR
         b.original_id IS NOT NEW.original_id OR b.locator_kind IS NOT NEW.locator_kind OR
         b.original_content_sha256 IS NOT NEW.original_content_sha256 OR
         b.original_byte_count IS NOT NEW.original_byte_count OR
         b.document_content_hash IS NOT d.content_hash OR
         b.provenance_receipt_digest IS NOT d.provenance_receipt_digest
       )
  );

  SELECT RAISE(ABORT, 'source original result family seal omits a current revision or chunk') WHERE
    NOT EXISTS (
      SELECT 1 FROM source_original_result_family_recovery_state
       WHERE id = 1 AND mode = 'verified_recovery_import'
    ) AND (
    (SELECT count(*)
       FROM documents d
       JOIN source_original_result_bindings b
         ON b.binding_hash = d.source_original_binding_hash
        AND b.document_revision_id = d.document_revision_id
      WHERE d.deleted_at IS NULL
        AND b.tenant_id = NEW.tenant_id
        AND b.source = NEW.source
        AND b.original_id = NEW.original_id
        AND b.locator_kind = NEW.locator_kind
        AND b.original_content_sha256 = NEW.original_content_sha256
        AND b.original_byte_count = NEW.original_byte_count) <> NEW.document_count
    OR
    (SELECT count(*)
       FROM chunks c
       JOIN documents d ON d.doc_uid = c.doc_uid
       JOIN source_original_result_bindings b
         ON b.binding_hash = d.source_original_binding_hash
        AND b.document_revision_id = d.document_revision_id
      WHERE d.deleted_at IS NULL
        AND b.tenant_id = NEW.tenant_id
        AND b.source = NEW.source
        AND b.original_id = NEW.original_id
        AND b.locator_kind = NEW.locator_kind
        AND b.original_content_sha256 = NEW.original_content_sha256
        AND b.original_byte_count = NEW.original_byte_count) <> NEW.chunk_count
    );
END;

CREATE TRIGGER IF NOT EXISTS source_original_result_family_receipt_no_update
BEFORE UPDATE ON source_original_result_family_receipts
BEGIN
  SELECT RAISE(ABORT, 'source original result family receipts are append-only');
END;

CREATE TRIGGER IF NOT EXISTS source_original_result_family_receipt_no_delete
BEFORE DELETE ON source_original_result_family_receipts
BEGIN
  SELECT RAISE(ABORT, 'source original result family receipts are append-only');
END;

-- This seal is intentionally not portable across a recovery-created vector
-- index. It stores only opaque revision ids and hashes, never the private probe
-- query, answer text, title, locator, or citation reference.
CREATE TABLE IF NOT EXISTS source_original_result_family_verifications (
  sequence                         INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_version                 INTEGER NOT NULL,
  tenant_id                        TEXT NOT NULL,
  family_receipt_hash              TEXT NOT NULL,
  outbox_generation                INTEGER NOT NULL,
  vector_projection_mutation_id    TEXT,
  vector_projection_submitted_at   INTEGER,
  vector_projection_bootstrap_epoch INTEGER NOT NULL,
  vector_projection_status         TEXT NOT NULL,
  expected_vector_count            INTEGER NOT NULL,
  actual_vector_count              INTEGER NOT NULL,
  target_outbox_count              INTEGER NOT NULL,
  global_outbox_count              INTEGER NOT NULL,
  vector_readiness_hash            TEXT NOT NULL,
  retrieval_contract_version       INTEGER NOT NULL,
  retrieval_probe_id               TEXT NOT NULL,
  retrieval_status                 TEXT NOT NULL,
  retrieval_result_hash_a          TEXT NOT NULL,
  retrieval_result_hash_b          TEXT NOT NULL,
  retrieved_document_revision_id_a TEXT NOT NULL,
  retrieved_document_revision_id_b TEXT NOT NULL,
  retrieved_chunk_ix_a             INTEGER NOT NULL,
  retrieved_chunk_ix_b             INTEGER NOT NULL,
  citation_status                  TEXT NOT NULL,
  citation_set_hash_a              TEXT NOT NULL,
  citation_set_hash_b              TEXT NOT NULL,
  cited_document_revision_id_a     TEXT NOT NULL,
  cited_document_revision_id_b     TEXT NOT NULL,
  verification_hash                TEXT NOT NULL UNIQUE,
  verified_at                      INTEGER NOT NULL,

  CHECK (contract_version = 1),
  CHECK (tenant_id = 'primary'),
  CHECK (length(family_receipt_hash) = 71 AND substr(family_receipt_hash,1,7) = 'sha256:' AND
         substr(family_receipt_hash,8) = lower(substr(family_receipt_hash,8)) AND
         substr(family_receipt_hash,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(outbox_generation) = 'integer' AND outbox_generation BETWEEN 0 AND 9007199254740991),
  CHECK ((vector_projection_mutation_id IS NULL AND vector_projection_submitted_at IS NULL) OR
         (vector_projection_mutation_id IS NOT NULL AND vector_projection_submitted_at IS NOT NULL AND
          length(vector_projection_mutation_id) BETWEEN 1 AND 256 AND
          typeof(vector_projection_submitted_at) = 'integer' AND vector_projection_submitted_at >= 0)),
  CHECK (typeof(vector_projection_bootstrap_epoch) = 'integer' AND vector_projection_bootstrap_epoch BETWEEN 0 AND 9007199254740991),
  CHECK (vector_projection_status = 'verified'),
  CHECK (typeof(expected_vector_count) = 'integer' AND expected_vector_count BETWEEN 1 AND 9007199254740991),
  CHECK (typeof(actual_vector_count) = 'integer' AND actual_vector_count = expected_vector_count),
  CHECK (typeof(target_outbox_count) = 'integer' AND target_outbox_count = 0),
  CHECK (typeof(global_outbox_count) = 'integer' AND global_outbox_count = 0),
  CHECK (length(vector_readiness_hash) = 71 AND substr(vector_readiness_hash,1,7) = 'sha256:' AND
         substr(vector_readiness_hash,8) = lower(substr(vector_readiness_hash,8)) AND
         substr(vector_readiness_hash,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (retrieval_contract_version = 1),
  CHECK (length(retrieval_probe_id) = 73 AND substr(retrieval_probe_id,1,9) = 'probe-v1:' AND
         substr(retrieval_probe_id,10) = lower(substr(retrieval_probe_id,10)) AND
         substr(retrieval_probe_id,10) NOT GLOB '*[^0-9a-f]*'),
  CHECK (retrieval_status = 'deterministic'),
  CHECK (retrieval_result_hash_a = retrieval_result_hash_b),
  CHECK (length(retrieval_result_hash_a) = 71 AND substr(retrieval_result_hash_a,1,7) = 'sha256:' AND
         substr(retrieval_result_hash_a,8) = lower(substr(retrieval_result_hash_a,8)) AND
         substr(retrieval_result_hash_a,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (retrieved_document_revision_id_a = retrieved_document_revision_id_b),
  CHECK (length(retrieved_document_revision_id_a) = 71 AND substr(retrieved_document_revision_id_a,1,7) = 'rev-v1:' AND
         substr(retrieved_document_revision_id_a,8) = lower(substr(retrieved_document_revision_id_a,8)) AND
         substr(retrieved_document_revision_id_a,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(retrieved_chunk_ix_a) = 'integer' AND retrieved_chunk_ix_a >= 0 AND
         retrieved_chunk_ix_a = retrieved_chunk_ix_b),
  CHECK (citation_status = 'same_family'),
  CHECK (citation_set_hash_a = citation_set_hash_b),
  CHECK (length(citation_set_hash_a) = 71 AND substr(citation_set_hash_a,1,7) = 'sha256:' AND
         substr(citation_set_hash_a,8) = lower(substr(citation_set_hash_a,8)) AND
         substr(citation_set_hash_a,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (cited_document_revision_id_a = cited_document_revision_id_b),
  CHECK (length(cited_document_revision_id_a) = 71 AND substr(cited_document_revision_id_a,1,7) = 'rev-v1:' AND
         substr(cited_document_revision_id_a,8) = lower(substr(cited_document_revision_id_a,8)) AND
         substr(cited_document_revision_id_a,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(verification_hash) = 71 AND substr(verification_hash,1,7) = 'sha256:' AND
         substr(verification_hash,8) = lower(substr(verification_hash,8)) AND
         substr(verification_hash,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(verified_at) = 'integer' AND verified_at >= 0)
);

CREATE INDEX IF NOT EXISTS idx_source_original_result_family_verifications_family_sequence
  ON source_original_result_family_verifications (family_receipt_hash, sequence DESC);

CREATE TRIGGER IF NOT EXISTS source_original_result_family_verification_no_duplicate_insert
BEFORE INSERT ON source_original_result_family_verifications
WHEN EXISTS (
  SELECT 1 FROM source_original_result_family_verifications
   WHERE sequence = NEW.sequence OR verification_hash = NEW.verification_hash
)
BEGIN
  SELECT RAISE(ABORT, 'source original result family verification cannot be replaced');
END;

CREATE TRIGGER IF NOT EXISTS source_original_result_family_verification_validate_insert
BEFORE INSERT ON source_original_result_family_verifications
BEGIN
  SELECT RAISE(ABORT, 'source original result family receipt is not sealed') WHERE NOT EXISTS (
    SELECT 1 FROM source_original_result_family_receipts r
     WHERE r.family_receipt_hash = NEW.family_receipt_hash
       AND r.tenant_id = NEW.tenant_id
  );

  -- Vectorize is read first by the Worker. This D1 insert is the second half of
  -- the fence: a concurrent enqueue changes generation/pending/status or counts
  -- and makes the seal fail rather than blessing an older provider observation.
  SELECT RAISE(ABORT, 'global vector readiness changed before verification seal') WHERE NOT EXISTS (
    SELECT 1 FROM install_state i
     WHERE i.id = 1 AND i.schema_version >= 44
       AND i.outbox_generation = NEW.outbox_generation
       AND i.vector_projection_mutation_id IS NEW.vector_projection_mutation_id
       AND i.vector_projection_submitted_at IS NEW.vector_projection_submitted_at
       AND i.vector_projection_bootstrap_epoch = NEW.vector_projection_bootstrap_epoch
       AND i.vector_projection_status = NEW.vector_projection_status
       AND NEW.expected_vector_count = (SELECT count(*) FROM chunks)
       AND NEW.actual_vector_count = NEW.expected_vector_count
       AND NEW.global_outbox_count = (SELECT count(*) FROM vector_outbox)
       AND NEW.global_outbox_count = 0
  );

  SELECT RAISE(ABORT, 'target result family still has vector work queued') WHERE EXISTS (
    SELECT 1 FROM vector_outbox o
    JOIN chunks c ON c.chunk_uid = o.chunk_uid
    JOIN source_original_result_family_members m
      ON m.family_receipt_hash = NEW.family_receipt_hash
     AND m.document_revision_id = c.bound_document_revision_id
     AND m.chunk_ix = c.chunk_ix
     AND m.chunk_receipt_hash = c.result_chunk_receipt_hash
  ) OR NEW.target_outbox_count <> 0;

  -- Revalidate every sealed member against the current D1 revision and chunk.
  -- A historical family receipt remains append-only, but it cannot license a
  -- verification after a later document or chunk change.
  SELECT RAISE(ABORT, 'source original result family changed before verification seal') WHERE EXISTS (
    SELECT 1 FROM source_original_result_family_members m
    JOIN source_original_result_family_receipts r
      ON r.family_receipt_hash = m.family_receipt_hash
    LEFT JOIN documents d ON d.document_revision_id = m.document_revision_id
    LEFT JOIN chunks c ON c.doc_uid = d.doc_uid AND c.chunk_ix = m.chunk_ix
    LEFT JOIN source_original_result_bindings b
      ON b.binding_hash = m.source_original_binding_hash
     AND b.document_revision_id = m.document_revision_id
    WHERE m.family_receipt_hash = NEW.family_receipt_hash
      AND (d.doc_uid IS NULL OR d.deleted_at IS NOT NULL OR d.source IS NOT r.source OR
           d.source_original_binding_hash IS NOT m.source_original_binding_hash OR
           c.chunk_uid IS NULL OR c.source IS NOT d.source OR c.title IS NOT d.title OR
           c.bound_document_revision_id IS NOT m.document_revision_id OR
           c.result_chunk_receipt_hash IS NOT m.chunk_receipt_hash OR
           b.sequence IS NULL OR b.tenant_id IS NOT r.tenant_id OR b.source IS NOT r.source OR
           b.original_id IS NOT r.original_id OR b.locator_kind IS NOT r.locator_kind OR
           b.original_content_sha256 IS NOT r.original_content_sha256 OR
           b.original_byte_count IS NOT r.original_byte_count OR
           b.document_content_hash IS NOT d.content_hash OR
           b.provenance_receipt_digest IS NOT d.provenance_receipt_digest)
  );

  SELECT RAISE(ABORT, 'source original result family changed before verification seal') WHERE EXISTS (
    SELECT 1 FROM source_original_result_family_receipts r
     WHERE r.family_receipt_hash = NEW.family_receipt_hash
       AND (
         (SELECT count(*)
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
             AND b.original_byte_count = r.original_byte_count) <> r.document_count
         OR
         (SELECT count(*)
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
             AND b.original_byte_count = r.original_byte_count) <> r.chunk_count
       )
  );

  SELECT RAISE(ABORT, 'private retrieval did not resolve to the sealed result family') WHERE NOT EXISTS (
    SELECT 1 FROM source_original_result_family_members m
     WHERE m.family_receipt_hash = NEW.family_receipt_hash
       AND m.document_revision_id = NEW.retrieved_document_revision_id_a
       AND m.chunk_ix = NEW.retrieved_chunk_ix_a
  );

  SELECT RAISE(ABORT, 'citation did not resolve to the sealed result family') WHERE NOT EXISTS (
    SELECT 1 FROM source_original_result_family_members m
     WHERE m.family_receipt_hash = NEW.family_receipt_hash
       AND m.document_revision_id = NEW.cited_document_revision_id_a
  );
END;

CREATE TRIGGER IF NOT EXISTS source_original_result_family_verification_no_update
BEFORE UPDATE ON source_original_result_family_verifications
BEGIN
  SELECT RAISE(ABORT, 'source original result family verifications are append-only');
END;

CREATE TRIGGER IF NOT EXISTS source_original_result_family_verification_no_delete
BEFORE DELETE ON source_original_result_family_verifications
BEGIN
  SELECT RAISE(ABORT, 'source original result family verifications are append-only');
END;

-- Recovery mode may only be opened while the destination is still empty. The
-- trigger is intentionally created last so every portable proof table exists
-- when this guard is evaluated.
CREATE TRIGGER IF NOT EXISTS source_original_result_family_recovery_state_validate_insert
BEFORE INSERT ON source_original_result_family_recovery_state
WHEN EXISTS (SELECT 1 FROM schema_migrations)
  OR EXISTS (SELECT 1 FROM documents)
  OR EXISTS (SELECT 1 FROM chunks)
  OR EXISTS (SELECT 1 FROM source_original_result_bindings)
  OR EXISTS (SELECT 1 FROM source_original_result_family_members)
  OR EXISTS (SELECT 1 FROM source_original_result_family_receipts)
  OR EXISTS (SELECT 1 FROM source_original_result_family_verifications)
BEGIN
  SELECT RAISE(ABORT, 'source original result family recovery marker requires an empty recovery target');
END;
