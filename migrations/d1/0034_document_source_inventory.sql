-- 0034_document_source_inventory
--
-- Missing source-registry rows qualify every categorical absence answer. The
-- original check grouped the complete live documents index on every question.
-- That is exact, but its cost grows with the corpus even when the result is the
-- ordinary empty set.
--
-- Keep one row per live document source at the database boundary. The table is
-- a materialized inventory, not a second document authority. Triggers
-- cover inserts, physical deletes, soft-delete transitions, restores, and
-- source moves. The final reconciliation is deliberately last: if an older live
-- Worker writes between independently committed migration statements, the
-- backfill reconciles every earlier transition after all triggers exist. A
-- restart repeats the same exact aggregate and remains safe.

CREATE TABLE IF NOT EXISTS document_source_inventory (
  source TEXT PRIMARY KEY
) WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS documents_source_inventory_ai
AFTER INSERT ON documents
WHEN NEW.deleted_at IS NULL
BEGIN
  INSERT OR IGNORE INTO document_source_inventory (source) VALUES (NEW.source);
END;

CREATE TRIGGER IF NOT EXISTS documents_source_inventory_ad
AFTER DELETE ON documents
WHEN OLD.deleted_at IS NULL
BEGIN
  DELETE FROM document_source_inventory
   WHERE source = OLD.source
     AND NOT EXISTS (
       SELECT 1 FROM documents
        WHERE source = OLD.source AND deleted_at IS NULL
     );
END;

CREATE TRIGGER IF NOT EXISTS documents_source_inventory_remove_au
AFTER UPDATE OF source, deleted_at ON documents
WHEN OLD.deleted_at IS NULL
 AND (NEW.deleted_at IS NOT NULL OR NEW.source IS NOT OLD.source)
BEGIN
  DELETE FROM document_source_inventory
   WHERE source = OLD.source
     AND NOT EXISTS (
       SELECT 1 FROM documents
        WHERE source = OLD.source AND deleted_at IS NULL
     );
END;

CREATE TRIGGER IF NOT EXISTS documents_source_inventory_add_au
AFTER UPDATE OF source, deleted_at ON documents
WHEN NEW.deleted_at IS NULL
 AND (OLD.deleted_at IS NOT NULL OR NEW.source IS NOT OLD.source)
BEGIN
  INSERT OR IGNORE INTO document_source_inventory (source) VALUES (NEW.source);
END;

DELETE FROM document_source_inventory
 WHERE source NOT IN (
      SELECT DISTINCT source FROM documents WHERE deleted_at IS NULL
    );

INSERT OR IGNORE INTO document_source_inventory (source)
SELECT DISTINCT source
  FROM documents
 WHERE deleted_at IS NULL;

-- corpus_stats is a derived cache. Reconcile every historical source from the
-- authoritative live document and chunk rows so an upgrade repairs an earlier
-- interrupted cache update without inventing a new freshness timestamp.
UPDATE corpus_stats
   SET documents = 0,
       chunks = 0
 WHERE NOT EXISTS (
       SELECT 1 FROM documents
        WHERE documents.source = corpus_stats.source
          AND documents.deleted_at IS NULL
     );

INSERT INTO corpus_stats (source, documents, chunks, last_ingest_at)
SELECT documents.source,
       COUNT(DISTINCT documents.doc_uid),
       COUNT(chunks.chunk_uid),
       (SELECT last_ingest_at FROM corpus_stats existing
         WHERE existing.source = documents.source)
  FROM documents
  LEFT JOIN chunks ON chunks.doc_uid = documents.doc_uid
 WHERE documents.deleted_at IS NULL
 GROUP BY documents.source
ON CONFLICT(source) DO UPDATE SET
  documents = excluded.documents,
  chunks = excluded.chunks;
