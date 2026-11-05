-- Real indexed columns in a separate derived table avoid document rewrites,
-- removal-generation changes, and an unbounded JSON index build at upgrade.
-- No corpus backfill runs in migration DDL. Active cron fills at most 500
-- document identities per transaction; incomplete reads use the legacy query.
CREATE TABLE IF NOT EXISTS document_family_index (
  doc_uid TEXT PRIMARY KEY REFERENCES documents(doc_uid) ON DELETE CASCADE ON UPDATE CASCADE,
  family_doc_uid TEXT NOT NULL,
  declared_family_uid TEXT,
  live INTEGER NOT NULL CHECK (live IN (0,1))
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_document_family_live
  ON document_family_index(family_doc_uid,doc_uid) WHERE live=1;
CREATE INDEX IF NOT EXISTS idx_document_family_declared
  ON document_family_index(declared_family_uid,doc_uid)
  WHERE declared_family_uid IS NOT NULL;
CREATE TABLE IF NOT EXISTS document_family_index_state (
  id INTEGER PRIMARY KEY CHECK (id=1),
  cursor TEXT,
  complete INTEGER NOT NULL CHECK (complete IN (0,1))
);

CREATE TRIGGER IF NOT EXISTS documents_family_index_ai
AFTER INSERT ON documents
BEGIN
  INSERT INTO document_family_index(doc_uid,family_doc_uid,declared_family_uid,live)
  VALUES (NEW.doc_uid, CASE
  WHEN json_valid(NEW.meta) AND json_type(NEW.meta,'$.family_of') = 'text'
   AND length(json_extract(NEW.meta,'$.family_of')) > 0
    THEN json_extract(NEW.meta,'$.family_of')
  WHEN json_valid(NEW.meta) AND json_type(NEW.meta,'$.part_of') = 'text'
   AND length(json_extract(NEW.meta,'$.part_of')) > 0
    THEN CASE
      WHEN substr(json_extract(NEW.meta,'$.part_of'),1,length(NEW.source)+1) = NEW.source || ':'
        THEN json_extract(NEW.meta,'$.part_of')
      ELSE NEW.source || ':' || json_extract(NEW.meta,'$.part_of') END
  ELSE NEW.doc_uid END, CASE WHEN json_valid(NEW.meta)
  AND json_type(NEW.meta,'$.family_of') = 'text'
  THEN json_extract(NEW.meta,'$.family_of') ELSE NULL END, NEW.deleted_at IS NULL)
  ON CONFLICT(doc_uid) DO UPDATE SET family_doc_uid=excluded.family_doc_uid,
    declared_family_uid=excluded.declared_family_uid, live=excluded.live;
END;

CREATE TRIGGER IF NOT EXISTS documents_family_index_au
AFTER UPDATE OF doc_uid,source,meta,deleted_at ON documents
BEGIN
  DELETE FROM document_family_index WHERE doc_uid=OLD.doc_uid AND OLD.doc_uid IS NOT NEW.doc_uid;
  INSERT INTO document_family_index(doc_uid,family_doc_uid,declared_family_uid,live)
  VALUES (NEW.doc_uid, CASE
  WHEN json_valid(NEW.meta) AND json_type(NEW.meta,'$.family_of') = 'text'
   AND length(json_extract(NEW.meta,'$.family_of')) > 0
    THEN json_extract(NEW.meta,'$.family_of')
  WHEN json_valid(NEW.meta) AND json_type(NEW.meta,'$.part_of') = 'text'
   AND length(json_extract(NEW.meta,'$.part_of')) > 0
    THEN CASE
      WHEN substr(json_extract(NEW.meta,'$.part_of'),1,length(NEW.source)+1) = NEW.source || ':'
        THEN json_extract(NEW.meta,'$.part_of')
      ELSE NEW.source || ':' || json_extract(NEW.meta,'$.part_of') END
  ELSE NEW.doc_uid END, CASE WHEN json_valid(NEW.meta)
  AND json_type(NEW.meta,'$.family_of') = 'text'
  THEN json_extract(NEW.meta,'$.family_of') ELSE NULL END, NEW.deleted_at IS NULL)
  ON CONFLICT(doc_uid) DO UPDATE SET family_doc_uid=excluded.family_doc_uid,
    declared_family_uid=excluded.declared_family_uid, live=excluded.live;
END;

CREATE TRIGGER IF NOT EXISTS documents_family_index_ad
AFTER DELETE ON documents
BEGIN
  DELETE FROM document_family_index WHERE doc_uid=OLD.doc_uid;
END;
-- Install the cursor last, after every write is covered. Reapplying DDL must
-- preserve the durable cursor and cannot mark an unfinished walk complete.
INSERT OR IGNORE INTO document_family_index_state(id,cursor,complete) VALUES(1,NULL,0);
