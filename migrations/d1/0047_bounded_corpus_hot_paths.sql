-- 0047_bounded_corpus_hot_paths
--
-- Health, update preview, source-family paging, and family forget used to
-- derive their counts and family identities by scanning every live document
-- and chunk. At roughly 500,000 documents / 1,700,000 chunks that can exceed
-- D1's per-query CPU budget and reset the database. Keep the exact projections
-- at the write boundary so those reads use one small counter row per source or
-- a keyset range over a narrow covering index.
--
-- D1 documents its SQLite SQL surface and index guidance here:
-- https://developers.cloudflare.com/d1/sql-api/sql-statements/
-- https://developers.cloudflare.com/d1/best-practices/use-indexes/
-- This migration uses ordinary tables, indexes, and triggers from that surface;
-- it does not depend on an unproved generated-column or expression-index form.

ALTER TABLE corpus_stats ADD COLUMN logical_documents INTEGER NOT NULL DEFAULT 0
  CHECK (logical_documents >= 0);

-- Every corpus-sized upgrade pass below advances an indexed keyset cursor in
-- the same statement that materializes its page. The migration runner repeats
-- only statements carrying the schema47_bounded_page CTE until one page writes
-- zero rows. A committed page is therefore a durable restart boundary.
CREATE TABLE IF NOT EXISTS schema47_backfill_state (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  initialized  INTEGER NOT NULL DEFAULT 0 CHECK (initialized IN (0,1))
);
INSERT OR IGNORE INTO schema47_backfill_state (id,initialized) VALUES (1,0);

CREATE TABLE IF NOT EXISTS schema47_backfill_progress (
  phase          TEXT PRIMARY KEY CHECK (phase IN ('documents','chunks','outbox')),
  cursor_text    TEXT,
  cursor_integer INTEGER,
  rows_projected INTEGER NOT NULL DEFAULT 0 CHECK (rows_projected >= 0),
  complete       INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0,1))
) WITHOUT ROWID;
INSERT OR IGNORE INTO schema47_backfill_progress (phase) VALUES ('documents');
INSERT OR IGNORE INTO schema47_backfill_progress (phase) VALUES ('chunks');
INSERT OR IGNORE INTO schema47_backfill_progress (phase) VALUES ('outbox');

-- The runner records schema_migrations only after every statement finishes.
-- Installing this guard before the first page also proves that no interrupted
-- or manually shortened run can activate schema 47 prematurely.
CREATE TRIGGER IF NOT EXISTS schema47_require_complete
BEFORE INSERT ON schema_migrations
WHEN NEW.version=47 AND EXISTS (
  SELECT 1 FROM schema47_backfill_progress WHERE complete<>1
)
BEGIN
  SELECT RAISE(ABORT,'schema 47 bounded backfill is incomplete');
END;

-- corpus_stats existed before schema 47 and may already contain stale cached
-- values. Reset it exactly once, before any page can advance. A crash between
-- this reset and the initialized receipt only repeats the zeroing; a crash
-- after the receipt preserves every later page's accumulated counters.
UPDATE corpus_stats
   SET documents=0,logical_documents=0,chunks=0
 WHERE EXISTS (SELECT 1 FROM schema47_backfill_state WHERE id=1 AND initialized=0);
UPDATE schema47_backfill_state SET initialized=1 WHERE id=1 AND initialized=0;

-- Projection readiness compares Vectorize's provider count with every physical
-- chunk, including any legacy soft-deleted row that has not yet been cleaned
-- up. Keep that separate from corpus_stats.chunks, whose public contract counts
-- chunks belonging to live documents only.
CREATE TABLE IF NOT EXISTS corpus_runtime_totals (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  chunks   INTEGER NOT NULL DEFAULT 0 CHECK (chunks >= 0)
);
INSERT OR IGNORE INTO corpus_runtime_totals (id,chunks) VALUES (1,0);

-- Health and think also read queue readiness. A stalled large projection can
-- put one row per chunk in the outbox, so COUNT/SUM over that table is another
-- corpus-sized health query unless its aggregate is maintained at writes.
CREATE TABLE IF NOT EXISTS vector_outbox_runtime_totals (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  pending    INTEGER NOT NULL DEFAULT 0 CHECK (pending >= 0),
  upserts    INTEGER NOT NULL DEFAULT 0 CHECK (upserts >= 0),
  deletes    INTEGER NOT NULL DEFAULT 0 CHECK (deletes >= 0),
  submitted  INTEGER NOT NULL DEFAULT 0 CHECK (submitted >= 0)
);
INSERT OR IGNORE INTO vector_outbox_runtime_totals
  (id,pending,upserts,deletes,submitted) VALUES (1,0,0,0,0);

-- Preserve the old per-source `embedded` receipt without hydrating every
-- queued chunk on each read. Delete rows are mapped while their chunk still
-- exists; a legacy orphan without a chunk was not attributed by the old join
-- either, so backfill keeps that exact behavior.
CREATE TABLE IF NOT EXISTS vector_outbox_sources (
  chunk_uid  TEXT PRIMARY KEY,
  source     TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS vector_outbox_source_counts (
  source   TEXT PRIMARY KEY,
  pending  INTEGER NOT NULL DEFAULT 0 CHECK (pending >= 0)
) WITHOUT ROWID;

-- One narrow row per live physical document. `logical_uid` preserves the
-- existing /documents aggregate contract (part_of, otherwise source_id).
-- `family_uid` preserves source-family paging (family_of, part_of, otherwise
-- doc_uid). They are deliberately separate because changing that distinction
-- would change owner-visible document counts during a performance repair.
CREATE TABLE IF NOT EXISTS document_family_members (
  doc_uid                 TEXT PRIMARY KEY,
  row_source              TEXT NOT NULL,
  logical_uid,
  family_uid              TEXT NOT NULL,
  family_source           TEXT NOT NULL,
  declared_family_uid     TEXT,
  family_name             TEXT,
  folder_path             TEXT
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_document_family_members_logical
  ON document_family_members (row_source, logical_uid);
CREATE INDEX IF NOT EXISTS idx_document_family_members_family
  ON document_family_members (family_source, family_uid, doc_uid);
CREATE INDEX IF NOT EXISTS idx_document_family_members_global_family
  ON document_family_members (family_uid, doc_uid);
CREATE INDEX IF NOT EXISTS idx_document_family_members_declared
  ON document_family_members (declared_family_uid, doc_uid)
  WHERE declared_family_uid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_document_family_members_name
  ON document_family_members (family_uid,family_name)
  WHERE family_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_document_family_members_folder
  ON document_family_members (family_uid,folder_path)
  WHERE folder_path IS NOT NULL;

-- Inventory reads one maintained row per logical family, so LIMIT applies
-- before any physical member expansion. member_count is also the exact delete
-- preview denominator for the family.
CREATE TABLE IF NOT EXISTS document_family_catalog (
  family_uid    TEXT PRIMARY KEY,
  family_source TEXT NOT NULL,
  family_name   TEXT,
  folder_path   TEXT,
  member_count  INTEGER NOT NULL CHECK (member_count > 0)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_document_family_catalog_source
  ON document_family_catalog (family_source,family_uid);

CREATE TABLE IF NOT EXISTS source_family_stats (
  family_source       TEXT PRIMARY KEY,
  stored_documents    INTEGER NOT NULL DEFAULT 0 CHECK (stored_documents >= 0),
  logical_documents   INTEGER NOT NULL DEFAULT 0 CHECK (logical_documents >= 0)
) WITHOUT ROWID;

-- Centralize the legacy JSON projection so migration backfill and every trigger
-- use byte-for-byte the same rules. Queries against one doc_uid use the
-- documents primary key; this view is never a hot-path inventory surface.
CREATE VIEW IF NOT EXISTS live_document_family_projection AS
SELECT d.doc_uid,
       d.source AS row_source,
       COALESCE(
         CASE WHEN json_valid(d.meta) THEN json_extract(d.meta,'$.part_of') END,
         d.source_id
       ) AS logical_uid,
       CASE
         WHEN json_valid(d.meta)
          AND json_type(d.meta,'$.family_of') = 'text'
          AND length(json_extract(d.meta,'$.family_of')) > 0
           THEN json_extract(d.meta,'$.family_of')
         WHEN json_valid(d.meta)
          AND json_type(d.meta,'$.part_of') = 'text'
          AND length(json_extract(d.meta,'$.part_of')) > 0
           THEN CASE
             WHEN substr(json_extract(d.meta,'$.part_of'), 1, length(d.source) + 1) = d.source || ':'
               THEN json_extract(d.meta,'$.part_of')
             ELSE d.source || ':' || json_extract(d.meta,'$.part_of')
           END
         ELSE d.doc_uid
       END AS family_uid,
       CASE
         WHEN instr(
           CASE
             WHEN json_valid(d.meta) AND json_type(d.meta,'$.family_of')='text'
              AND length(json_extract(d.meta,'$.family_of')) > 0
               THEN json_extract(d.meta,'$.family_of')
             WHEN json_valid(d.meta) AND json_type(d.meta,'$.part_of')='text'
              AND length(json_extract(d.meta,'$.part_of')) > 0
               THEN CASE
                 WHEN substr(json_extract(d.meta,'$.part_of'),1,length(d.source)+1)=d.source||':'
                   THEN json_extract(d.meta,'$.part_of')
                 ELSE d.source||':'||json_extract(d.meta,'$.part_of')
               END
             ELSE d.doc_uid
           END,
           ':'
         ) > 1
           THEN substr(
             CASE
               WHEN json_valid(d.meta) AND json_type(d.meta,'$.family_of')='text'
                AND length(json_extract(d.meta,'$.family_of')) > 0
                 THEN json_extract(d.meta,'$.family_of')
               WHEN json_valid(d.meta) AND json_type(d.meta,'$.part_of')='text'
                AND length(json_extract(d.meta,'$.part_of')) > 0
                 THEN CASE
                   WHEN substr(json_extract(d.meta,'$.part_of'),1,length(d.source)+1)=d.source||':'
                     THEN json_extract(d.meta,'$.part_of')
                   ELSE d.source||':'||json_extract(d.meta,'$.part_of')
                 END
               ELSE d.doc_uid
             END,
             1,
             instr(
               CASE
                 WHEN json_valid(d.meta) AND json_type(d.meta,'$.family_of')='text'
                  AND length(json_extract(d.meta,'$.family_of')) > 0
                   THEN json_extract(d.meta,'$.family_of')
                 WHEN json_valid(d.meta) AND json_type(d.meta,'$.part_of')='text'
                  AND length(json_extract(d.meta,'$.part_of')) > 0
                   THEN CASE
                     WHEN substr(json_extract(d.meta,'$.part_of'),1,length(d.source)+1)=d.source||':'
                       THEN json_extract(d.meta,'$.part_of')
                     ELSE d.source||':'||json_extract(d.meta,'$.part_of')
                   END
                 ELSE d.doc_uid
               END,
               ':'
             ) - 1
           )
         ELSE d.source
       END AS family_source,
       CASE WHEN json_valid(d.meta)
              AND json_type(d.meta,'$.family_of')='text'
              AND length(json_extract(d.meta,'$.family_of')) > 0
         THEN json_extract(d.meta,'$.family_of') END AS declared_family_uid,
       CASE
         WHEN length(trim(d.title)) = 0 THEN NULL
         WHEN json_valid(d.meta)
          AND json_type(d.meta,'$.part') = 'integer'
          AND json_type(d.meta,'$.part_count') = 'integer'
          AND substr(
            trim(d.title),
            -length(' (part ' || json_extract(d.meta,'$.part') || ' of ' || json_extract(d.meta,'$.part_count') || ')')
          ) = ' (part ' || json_extract(d.meta,'$.part') || ' of ' || json_extract(d.meta,'$.part_count') || ')'
           THEN substr(
             trim(d.title),
             1,
             length(trim(d.title)) -
               length(' (part ' || json_extract(d.meta,'$.part') || ' of ' || json_extract(d.meta,'$.part_count') || ')')
           )
         ELSE trim(d.title)
       END AS family_name,
       CASE WHEN json_valid(d.meta)
              AND json_type(d.meta,'$.folder')='text'
              AND length(trim(json_extract(d.meta,'$.folder'))) > 0
         THEN trim(json_extract(d.meta,'$.folder')) END AS folder_path
  FROM documents d
 WHERE d.deleted_at IS NULL;

-- The projection itself owns document and family aggregates. That makes the
-- same row-level invariant serve both bounded upgrade pages and future writes.
CREATE TRIGGER IF NOT EXISTS document_family_members_stats_ai
AFTER INSERT ON document_family_members
BEGIN
  INSERT INTO corpus_stats
    (source,documents,logical_documents,chunks,last_ingest_at)
  VALUES (NEW.row_source,0,0,0,NULL)
  ON CONFLICT(source) DO NOTHING;
  UPDATE corpus_stats
     SET documents=documents+1,
         logical_documents=logical_documents + CASE WHEN (
           SELECT count(*) FROM document_family_members
            WHERE row_source=NEW.row_source AND logical_uid IS NEW.logical_uid
         )=1 THEN 1 ELSE 0 END
   WHERE source=NEW.row_source;
  INSERT INTO source_family_stats
    (family_source,stored_documents,logical_documents)
  VALUES (NEW.family_source,0,0)
  ON CONFLICT(family_source) DO NOTHING;
  UPDATE source_family_stats
     SET stored_documents=stored_documents+1,
         logical_documents=logical_documents + CASE WHEN (
           SELECT count(*) FROM document_family_members
            WHERE family_source=NEW.family_source AND family_uid=NEW.family_uid
         )=1 THEN 1 ELSE 0 END
   WHERE family_source=NEW.family_source;
  INSERT INTO document_family_catalog
    (family_uid,family_source,family_name,folder_path,member_count)
  VALUES (NEW.family_uid,NEW.family_source,NEW.family_name,NEW.folder_path,1)
  ON CONFLICT(family_uid) DO UPDATE SET
    member_count=document_family_catalog.member_count+1,
    family_name=CASE
      WHEN excluded.family_name IS NOT NULL AND
           (document_family_catalog.family_name IS NULL OR
            excluded.family_name > document_family_catalog.family_name)
        THEN excluded.family_name ELSE document_family_catalog.family_name END,
    folder_path=CASE
      WHEN excluded.folder_path IS NOT NULL AND
           (document_family_catalog.folder_path IS NULL OR
            excluded.folder_path > document_family_catalog.folder_path)
        THEN excluded.folder_path ELSE document_family_catalog.folder_path END
  WHERE 1=1;
  UPDATE schema47_backfill_progress
     SET cursor_text=CASE WHEN cursor_text IS NULL OR NEW.doc_uid > cursor_text
                          THEN NEW.doc_uid ELSE cursor_text END,
         rows_projected=rows_projected+1
   WHERE phase='documents' AND complete=0;
END;

CREATE TRIGGER IF NOT EXISTS document_family_members_stats_bd
BEFORE DELETE ON document_family_members
BEGIN
  UPDATE corpus_stats
     SET documents=documents-1,
         logical_documents=logical_documents - CASE WHEN (
           SELECT count(*) FROM document_family_members
            WHERE row_source=OLD.row_source AND logical_uid IS OLD.logical_uid
         )=1 THEN 1 ELSE 0 END
   WHERE source=OLD.row_source;
  UPDATE source_family_stats
     SET stored_documents=stored_documents-1,
         logical_documents=logical_documents - CASE WHEN (
           SELECT count(*) FROM document_family_members
            WHERE family_source=OLD.family_source AND family_uid=OLD.family_uid
         )=1 THEN 1 ELSE 0 END
   WHERE family_source=OLD.family_source;
  UPDATE document_family_catalog
     SET member_count=member_count-1,
         family_name=(SELECT max(family_name) FROM document_family_members
                       WHERE family_uid=OLD.family_uid AND doc_uid<>OLD.doc_uid),
         folder_path=(SELECT max(folder_path) FROM document_family_members
                       WHERE family_uid=OLD.family_uid AND doc_uid<>OLD.doc_uid)
   WHERE family_uid=OLD.family_uid AND member_count>1;
  DELETE FROM document_family_catalog
   WHERE family_uid=OLD.family_uid AND member_count=1;
END;

WITH schema47_bounded_page AS (
  SELECT * FROM live_document_family_projection
   WHERE doc_uid > COALESCE((SELECT cursor_text FROM schema47_backfill_progress
                              WHERE phase='documents'),'')
   ORDER BY doc_uid
   LIMIT 1000
)
INSERT INTO document_family_members
  (doc_uid,row_source,logical_uid,family_uid,family_source,
   declared_family_uid,family_name,folder_path)
SELECT doc_uid,row_source,logical_uid,family_uid,family_source,
       declared_family_uid,family_name,folder_path
  FROM schema47_bounded_page;

UPDATE schema47_backfill_progress
   SET complete=1
 WHERE phase='documents' AND complete=0
   AND NOT EXISTS (
     SELECT 1 FROM documents
      WHERE deleted_at IS NULL
        AND doc_uid > COALESCE((SELECT cursor_text FROM schema47_backfill_progress
                                 WHERE phase='documents'),'')
      ORDER BY doc_uid LIMIT 1
   );

-- Physical chunk totals and live per-source chunk totals advance by integer
-- chunks.id. The seen table is temporary upgrade state; its trigger commits the
-- counters and cursor atomically with each bounded page row.
CREATE TABLE IF NOT EXISTS schema47_chunk_backfill_rows (
  chunk_id    INTEGER PRIMARY KEY,
  live_source TEXT
);
CREATE TRIGGER IF NOT EXISTS schema47_chunk_backfill_ai
AFTER INSERT ON schema47_chunk_backfill_rows
BEGIN
  UPDATE corpus_runtime_totals SET chunks=chunks+1 WHERE id=1;
  UPDATE corpus_stats SET chunks=chunks+1
   WHERE NEW.live_source IS NOT NULL AND source=NEW.live_source;
  UPDATE schema47_backfill_progress
     SET cursor_integer=MAX(COALESCE(cursor_integer,0),NEW.chunk_id),
         rows_projected=rows_projected+1
   WHERE phase='chunks' AND complete=0;
END;
WITH schema47_bounded_page AS (
  SELECT c.id AS chunk_id,
         CASE WHEN d.deleted_at IS NULL THEN d.source END AS live_source
    FROM chunks c LEFT JOIN documents d ON d.doc_uid=c.doc_uid
   WHERE c.id > COALESCE((SELECT cursor_integer FROM schema47_backfill_progress
                           WHERE phase='chunks'),0)
   ORDER BY c.id
   LIMIT 1000
)
INSERT INTO schema47_chunk_backfill_rows (chunk_id,live_source)
SELECT chunk_id,live_source FROM schema47_bounded_page;
UPDATE schema47_backfill_progress
   SET complete=1
 WHERE phase='chunks' AND complete=0
   AND NOT EXISTS (
     SELECT 1 FROM chunks
      WHERE id > COALESCE((SELECT cursor_integer FROM schema47_backfill_progress
                            WHERE phase='chunks'),0)
      ORDER BY id LIMIT 1
   );

-- The outbox pass preserves orphan semantics while bounding both the base scan
-- and the chunk lookup to one indexed row per page member.
CREATE TABLE IF NOT EXISTS schema47_outbox_backfill_rows (
  chunk_uid TEXT PRIMARY KEY,
  op        TEXT NOT NULL,
  submitted INTEGER NOT NULL CHECK (submitted IN (0,1)),
  source    TEXT
) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS schema47_outbox_backfill_ai
AFTER INSERT ON schema47_outbox_backfill_rows
BEGIN
  UPDATE vector_outbox_runtime_totals
     SET pending=pending+1,
         upserts=upserts+CASE WHEN NEW.op='upsert' THEN 1 ELSE 0 END,
         deletes=deletes+CASE WHEN NEW.op='delete' THEN 1 ELSE 0 END,
         submitted=submitted+NEW.submitted
   WHERE id=1;
  INSERT INTO vector_outbox_sources (chunk_uid,source)
  SELECT NEW.chunk_uid,NEW.source WHERE NEW.source IS NOT NULL;
  INSERT INTO vector_outbox_source_counts (source,pending)
  SELECT NEW.source,1 WHERE NEW.source IS NOT NULL
  ON CONFLICT(source) DO UPDATE SET pending=pending+1;
  UPDATE schema47_backfill_progress
     SET cursor_text=CASE WHEN cursor_text IS NULL OR NEW.chunk_uid > cursor_text
                          THEN NEW.chunk_uid ELSE cursor_text END,
         rows_projected=rows_projected+1
   WHERE phase='outbox' AND complete=0;
END;
WITH schema47_bounded_page AS (
  SELECT o.chunk_uid,o.op,
         CASE WHEN o.submitted_mutation_id IS NULL THEN 0 ELSE 1 END AS submitted,
         c.source
    FROM vector_outbox o LEFT JOIN chunks c ON c.chunk_uid=o.chunk_uid
   WHERE o.chunk_uid > COALESCE((SELECT cursor_text FROM schema47_backfill_progress
                                  WHERE phase='outbox'),'')
   ORDER BY o.chunk_uid
   LIMIT 1000
)
INSERT INTO schema47_outbox_backfill_rows (chunk_uid,op,submitted,source)
SELECT chunk_uid,op,submitted,source FROM schema47_bounded_page;
UPDATE schema47_backfill_progress
   SET complete=1
 WHERE phase='outbox' AND complete=0
   AND NOT EXISTS (
     SELECT 1 FROM vector_outbox
      WHERE chunk_uid > COALESCE((SELECT cursor_text FROM schema47_backfill_progress
                                   WHERE phase='outbox'),'')
      ORDER BY chunk_uid LIMIT 1
   );

DROP TRIGGER IF EXISTS schema47_chunk_backfill_ai;
DROP TRIGGER IF EXISTS schema47_outbox_backfill_ai;
DROP TABLE IF EXISTS schema47_chunk_backfill_rows;
DROP TABLE IF EXISTS schema47_outbox_backfill_rows;

CREATE TRIGGER IF NOT EXISTS documents_hot_path_stats_ai
AFTER INSERT ON documents
WHEN NEW.deleted_at IS NULL
BEGIN
  INSERT INTO document_family_members
    (doc_uid,row_source,logical_uid,family_uid,family_source,
     declared_family_uid,family_name,folder_path)
  SELECT doc_uid,row_source,logical_uid,family_uid,family_source,
         declared_family_uid,family_name,folder_path
    FROM live_document_family_projection WHERE doc_uid=NEW.doc_uid;
END;

CREATE TRIGGER IF NOT EXISTS documents_hot_path_stats_bd
BEFORE DELETE ON documents
WHEN OLD.deleted_at IS NULL
BEGIN
  UPDATE corpus_stats
     SET chunks=chunks-(SELECT count(*) FROM chunks WHERE doc_uid=OLD.doc_uid)
   WHERE source=OLD.source;
  DELETE FROM document_family_members WHERE doc_uid=OLD.doc_uid;
END;

CREATE TRIGGER IF NOT EXISTS documents_hot_path_stats_au
AFTER UPDATE OF doc_uid,source,source_id,title,meta,deleted_at ON documents
WHEN OLD.deleted_at IS NOT NEW.deleted_at
  OR OLD.doc_uid IS NOT NEW.doc_uid
  OR OLD.source IS NOT NEW.source
  OR OLD.source_id IS NOT NEW.source_id
  OR OLD.title IS NOT NEW.title
  OR OLD.meta IS NOT NEW.meta
BEGIN
  UPDATE corpus_stats
     SET chunks=chunks - CASE WHEN OLD.deleted_at IS NULL
           AND (NEW.deleted_at IS NOT NULL OR NEW.source IS NOT OLD.source)
           THEN (SELECT count(*) FROM chunks WHERE doc_uid=OLD.doc_uid) ELSE 0 END
   WHERE source=OLD.source;
  DELETE FROM document_family_members WHERE doc_uid=OLD.doc_uid;
  INSERT INTO corpus_stats
    (source,documents,logical_documents,chunks,last_ingest_at)
  SELECT NEW.source,0,0,0,NULL
   WHERE NEW.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM corpus_stats WHERE source=NEW.source);
  UPDATE corpus_stats
     SET chunks=chunks + CASE WHEN NEW.deleted_at IS NULL
           AND (OLD.deleted_at IS NOT NULL OR NEW.source IS NOT OLD.source)
           THEN (SELECT count(*) FROM chunks WHERE doc_uid=NEW.doc_uid) ELSE 0 END
   WHERE source=NEW.source AND NEW.deleted_at IS NULL;
  INSERT INTO document_family_members
    (doc_uid,row_source,logical_uid,family_uid,family_source,
     declared_family_uid,family_name,folder_path)
  SELECT doc_uid,row_source,logical_uid,family_uid,family_source,
         declared_family_uid,family_name,folder_path
    FROM live_document_family_projection WHERE doc_uid=NEW.doc_uid;
END;

CREATE TRIGGER IF NOT EXISTS chunks_hot_path_stats_ai
AFTER INSERT ON chunks
BEGIN
  UPDATE corpus_runtime_totals SET chunks=chunks+1 WHERE id=1;
  UPDATE corpus_stats
     SET chunks=chunks+1
   WHERE source=(SELECT source FROM documents
                  WHERE doc_uid=NEW.doc_uid AND deleted_at IS NULL);
END;

CREATE TRIGGER IF NOT EXISTS chunks_hot_path_stats_ad
AFTER DELETE ON chunks
BEGIN
  UPDATE corpus_runtime_totals SET chunks=chunks-1 WHERE id=1;
  UPDATE corpus_stats
     SET chunks=chunks-1
   WHERE source=(SELECT source FROM documents
                  WHERE doc_uid=OLD.doc_uid AND deleted_at IS NULL);
END;

CREATE TRIGGER IF NOT EXISTS chunks_hot_path_stats_au
AFTER UPDATE OF doc_uid ON chunks
WHEN OLD.doc_uid IS NOT NEW.doc_uid
BEGIN
  UPDATE corpus_stats
     SET chunks=chunks-1
   WHERE source=(SELECT source FROM documents
                  WHERE doc_uid=OLD.doc_uid AND deleted_at IS NULL);
  UPDATE corpus_stats
     SET chunks=chunks+1
   WHERE source=(SELECT source FROM documents
                  WHERE doc_uid=NEW.doc_uid AND deleted_at IS NULL);
END;

-- The owner-facing pending count preserves the schema-46 join contract:
-- only outbox rows whose chunk currently exists belong to a source. Forget
-- deliberately keeps a delete row after removing its chunk, while a legacy
-- orphan can acquire a chunk again before an ON CONFLICT requeue. Maintain
-- both transitions at the chunk boundary so the projection never subtracts a
-- stale delete from a source whose live chunk count is already zero.
CREATE TRIGGER IF NOT EXISTS chunks_outbox_source_ai
AFTER INSERT ON chunks
WHEN EXISTS (SELECT 1 FROM vector_outbox WHERE chunk_uid=NEW.chunk_uid)
 AND NOT EXISTS (SELECT 1 FROM vector_outbox_sources WHERE chunk_uid=NEW.chunk_uid)
BEGIN
  INSERT INTO vector_outbox_source_counts (source,pending)
  VALUES (NEW.source,0)
  ON CONFLICT(source) DO NOTHING;
  UPDATE vector_outbox_source_counts
     SET pending=pending+1
   WHERE source=NEW.source;
  INSERT INTO vector_outbox_sources (chunk_uid,source)
  VALUES (NEW.chunk_uid,NEW.source);
END;

CREATE TRIGGER IF NOT EXISTS chunks_outbox_source_bd
BEFORE DELETE ON chunks
WHEN EXISTS (SELECT 1 FROM vector_outbox_sources WHERE chunk_uid=OLD.chunk_uid)
BEGIN
  UPDATE vector_outbox_source_counts
     SET pending=MAX(pending-1,0)
   WHERE source=(SELECT source FROM vector_outbox_sources WHERE chunk_uid=OLD.chunk_uid);
  DELETE FROM vector_outbox_sources WHERE chunk_uid=OLD.chunk_uid;
END;

CREATE TRIGGER IF NOT EXISTS chunks_outbox_source_au
AFTER UPDATE OF chunk_uid,source ON chunks
WHEN OLD.chunk_uid IS NOT NEW.chunk_uid OR OLD.source IS NOT NEW.source
BEGIN
  UPDATE vector_outbox_source_counts
     SET pending=MAX(pending-1,0)
   WHERE source=(SELECT source FROM vector_outbox_sources WHERE chunk_uid=OLD.chunk_uid);
  DELETE FROM vector_outbox_sources WHERE chunk_uid=OLD.chunk_uid;
  INSERT INTO vector_outbox_source_counts (source,pending)
  SELECT NEW.source,0
   WHERE EXISTS (SELECT 1 FROM vector_outbox WHERE chunk_uid=NEW.chunk_uid)
  ON CONFLICT(source) DO NOTHING;
  UPDATE vector_outbox_source_counts
     SET pending=pending+1
   WHERE source=NEW.source
     AND EXISTS (SELECT 1 FROM vector_outbox WHERE chunk_uid=NEW.chunk_uid)
     AND NOT EXISTS (SELECT 1 FROM vector_outbox_sources WHERE chunk_uid=NEW.chunk_uid);
  INSERT INTO vector_outbox_sources (chunk_uid,source)
  SELECT NEW.chunk_uid,NEW.source
   WHERE EXISTS (SELECT 1 FROM vector_outbox WHERE chunk_uid=NEW.chunk_uid)
     AND NOT EXISTS (SELECT 1 FROM vector_outbox_sources WHERE chunk_uid=NEW.chunk_uid);
END;

CREATE TRIGGER IF NOT EXISTS vector_outbox_hot_path_stats_ai
AFTER INSERT ON vector_outbox
BEGIN
  UPDATE vector_outbox_runtime_totals
     SET pending=pending+1,
         upserts=upserts+CASE WHEN NEW.op='upsert' THEN 1 ELSE 0 END,
         deletes=deletes+CASE WHEN NEW.op='delete' THEN 1 ELSE 0 END,
         submitted=submitted+CASE WHEN NEW.submitted_mutation_id IS NOT NULL THEN 1 ELSE 0 END
   WHERE id=1;
  INSERT INTO vector_outbox_source_counts (source,pending)
  SELECT c.source,0 FROM chunks c
   WHERE c.chunk_uid=NEW.chunk_uid
     AND NOT EXISTS (SELECT 1 FROM vector_outbox_sources s WHERE s.chunk_uid=NEW.chunk_uid)
     AND NOT EXISTS (SELECT 1 FROM vector_outbox_source_counts counts
                      WHERE counts.source=c.source);
  UPDATE vector_outbox_source_counts
     SET pending=pending+1
   WHERE source=(SELECT source FROM chunks WHERE chunk_uid=NEW.chunk_uid)
     AND NOT EXISTS (SELECT 1 FROM vector_outbox_sources WHERE chunk_uid=NEW.chunk_uid);
  INSERT INTO vector_outbox_sources (chunk_uid,source)
  SELECT NEW.chunk_uid,c.source FROM chunks c
   WHERE c.chunk_uid=NEW.chunk_uid
     AND NOT EXISTS (SELECT 1 FROM vector_outbox_sources s WHERE s.chunk_uid=NEW.chunk_uid);
END;

CREATE TRIGGER IF NOT EXISTS vector_outbox_hot_path_stats_ad
AFTER DELETE ON vector_outbox
BEGIN
  UPDATE vector_outbox_runtime_totals
     SET pending=pending-1,
         upserts=upserts-CASE WHEN OLD.op='upsert' THEN 1 ELSE 0 END,
         deletes=deletes-CASE WHEN OLD.op='delete' THEN 1 ELSE 0 END,
         submitted=submitted-CASE WHEN OLD.submitted_mutation_id IS NOT NULL THEN 1 ELSE 0 END
   WHERE id=1;
  UPDATE vector_outbox_source_counts
     SET pending=MAX(pending-1,0)
   WHERE source=(SELECT source FROM vector_outbox_sources WHERE chunk_uid=OLD.chunk_uid);
  DELETE FROM vector_outbox_sources WHERE chunk_uid=OLD.chunk_uid;
END;

CREATE TRIGGER IF NOT EXISTS vector_outbox_hot_path_stats_au
AFTER UPDATE OF op,submitted_mutation_id ON vector_outbox
BEGIN
  UPDATE vector_outbox_runtime_totals
     SET upserts=upserts-CASE WHEN OLD.op='upsert' THEN 1 ELSE 0 END
                         +CASE WHEN NEW.op='upsert' THEN 1 ELSE 0 END,
         deletes=deletes-CASE WHEN OLD.op='delete' THEN 1 ELSE 0 END
                         +CASE WHEN NEW.op='delete' THEN 1 ELSE 0 END,
         submitted=submitted-CASE WHEN OLD.submitted_mutation_id IS NOT NULL THEN 1 ELSE 0 END
                             +CASE WHEN NEW.submitted_mutation_id IS NOT NULL THEN 1 ELSE 0 END
   WHERE id=1;
  INSERT INTO vector_outbox_source_counts (source,pending)
  SELECT c.source,0 FROM chunks c
   WHERE c.chunk_uid=NEW.chunk_uid
     AND NOT EXISTS (SELECT 1 FROM vector_outbox_sources s WHERE s.chunk_uid=NEW.chunk_uid)
     AND NOT EXISTS (SELECT 1 FROM vector_outbox_source_counts counts
                      WHERE counts.source=c.source);
  UPDATE vector_outbox_source_counts
     SET pending=pending+1
   WHERE source=(SELECT source FROM chunks WHERE chunk_uid=NEW.chunk_uid)
     AND NOT EXISTS (SELECT 1 FROM vector_outbox_sources WHERE chunk_uid=NEW.chunk_uid);
  INSERT INTO vector_outbox_sources (chunk_uid,source)
  SELECT NEW.chunk_uid,c.source FROM chunks c
   WHERE c.chunk_uid=NEW.chunk_uid
     AND NOT EXISTS (SELECT 1 FROM vector_outbox_sources s WHERE s.chunk_uid=NEW.chunk_uid);
END;
