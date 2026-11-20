-- "Clean my Brain": a removal the owner approved is remembered, so a full
-- re-read of Gmail or Drive (history gap, setting change, --reset) cannot bring
-- the removed item back.
--
-- One row per removed document family (the family key is already computed on
-- every insert by schema 59: gmail:<messageId>, drive:<fileId>). The row is
-- written by the same D1 batch that deletes the documents, so the memory and
-- the delete commit together or not at all. Only removals the owner asked for
-- through `brain clean` write it; removals ingest plans itself never do.
-- restored_at keeps the row and the why when the owner brings an item back.
CREATE TABLE IF NOT EXISTS owner_removals (
  family_uid TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  removed_at INTEGER NOT NULL,
  run_id TEXT,
  batch_no INTEGER,
  reason TEXT,
  restored_at INTEGER
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_owner_removals_run
  ON owner_removals(run_id, batch_no) WHERE run_id IS NOT NULL;

-- Backstop: any writer that skips the explicit checks still cannot make a
-- removed family live again. BEFORE INSERT also fires for the index's upsert.
CREATE TRIGGER IF NOT EXISTS owner_removals_block_reload
BEFORE INSERT ON document_family_index
WHEN NEW.live = 1 AND EXISTS (
  SELECT 1 FROM owner_removals
   WHERE family_uid = NEW.family_doc_uid AND restored_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'OWNER_REMOVED');
END;
