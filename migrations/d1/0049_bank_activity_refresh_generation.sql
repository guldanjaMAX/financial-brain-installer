-- 0049_bank_activity_refresh_generation: fence derived bank-activity writers.
--
-- A reviewed account move changes the authority used to render every monthly
-- activity document for that account. An older writer can already have read
-- the previous owner before the move commits, so its later document write must
-- be rejected by D1 rather than relying on a read-then-write check in Worker
-- code. The singleton generation is advanced in the same transaction as the
-- move. Per-document claims bind a write to that generation and entity scope.

CREATE TABLE IF NOT EXISTS bank_activity_refresh_state (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  generation           INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  requested_at         TEXT,
  completed_generation INTEGER NOT NULL DEFAULT 0 CHECK (completed_generation >= 0),
  completed_at         TEXT,
  CHECK (completed_generation <= generation)
);

INSERT OR IGNORE INTO bank_activity_refresh_state
  (id,generation,requested_at,completed_generation,completed_at)
VALUES (1,0,NULL,0,NULL);

CREATE TABLE IF NOT EXISTS bank_activity_write_claims (
  source_id   TEXT PRIMARY KEY,
  generation  INTEGER NOT NULL CHECK (generation >= 0),
  entity_slug TEXT,
  claimed_at  TEXT NOT NULL
);

-- Upgraded installs can already have activity documents. Seed their exact
-- stored scope before installing the guards so schema-first recovery can also
-- import these claims ahead of the corresponding document rows.
INSERT OR IGNORE INTO bank_activity_write_claims
  (source_id,generation,entity_slug,claimed_at)
SELECT source_id,0,entity_slug,'schema-0049'
  FROM documents
 WHERE source='bank_activity';

-- The document writer has several transactions per revision. Keeping the
-- current claim durable lets both the initial upsert and its exact finalizer
-- prove that the rendered scope still belongs to the current generation. A
-- schema-first recovery imports already-committed hashes, so the insert guard
-- applies only to the pending marker every live writer must use. Updates,
-- including finalization, always remain fenced.
CREATE TRIGGER IF NOT EXISTS bank_activity_documents_generation_insert
BEFORE INSERT ON documents
WHEN NEW.source = 'bank_activity' AND NEW.content_hash LIKE 'pending:%' AND NOT EXISTS (
  SELECT 1
    FROM bank_activity_write_claims c
    JOIN bank_activity_refresh_state s ON s.id=1 AND s.generation=c.generation
   WHERE c.source_id=NEW.source_id AND c.entity_slug IS NEW.entity_slug
)
BEGIN
  SELECT RAISE(ABORT, 'bank activity document generation was superseded');
END;

CREATE TRIGGER IF NOT EXISTS bank_activity_documents_generation_update
BEFORE UPDATE OF title,uri,document_date,date_source,date_reliable,client,category,
                 ingested_at,content_hash,meta,entity_slug,document_revision_id
ON documents
WHEN NEW.source = 'bank_activity' AND NOT EXISTS (
  SELECT 1
    FROM bank_activity_write_claims c
    JOIN bank_activity_refresh_state s ON s.id=1 AND s.generation=c.generation
   WHERE c.source_id=NEW.source_id AND c.entity_slug IS NEW.entity_slug
)
BEGIN
  SELECT RAISE(ABORT, 'bank activity document generation was superseded');
END;
