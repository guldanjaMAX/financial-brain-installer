-- An additive, empty journal: no corpus rewrite or backfill at upgrade.
-- Stage bytes precede activation. Accepted snapshots and abandoned stages are
-- retained indefinitely; cleanup is a separately reviewed owner operation.
CREATE TABLE IF NOT EXISTS retained_ingest_stages (
  stage_id TEXT PRIMARY KEY,
  doc_uid TEXT NOT NULL,
  prior_document TEXT,
  prior_chunks TEXT NOT NULL CHECK (json_valid(prior_chunks)),
  next_envelope TEXT NOT NULL CHECK (json_valid(next_envelope)),
  next_chunks TEXT NOT NULL CHECK (json_valid(next_chunks)),
  pending_marker TEXT NOT NULL,
  document_revision_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_retained_ingest_document
  ON retained_ingest_stages(doc_uid,created_at,stage_id);
CREATE TABLE IF NOT EXISTS retained_ingest_activations (
  stage_id TEXT PRIMARY KEY REFERENCES retained_ingest_stages(stage_id),
  verified INTEGER NOT NULL CHECK (verified=1)
) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS retained_ingest_stages_immutable
BEFORE UPDATE ON retained_ingest_stages BEGIN
  SELECT RAISE(ABORT, 'retained ingest stages are immutable');
END;
-- Only unfinished receipt bookkeeping is visited by an incremental check.
CREATE INDEX IF NOT EXISTS idx_sync_runs_open_source
  ON sync_runs(source,run_id) WHERE finished_at IS NULL;

-- The existing cache was established by schema 34 and the prior writer's live
-- counts. Preserve that baseline; maintain subsequent physical-row deltas in
-- the owning transaction, including failed/pending stages and exact retries.
-- Ingest finalization no longer scans the source. Receipt logical totals remain
-- unknown rather than confusing these physical counters with family counts.
-- The existing schema-first recovery marker disables these derived deltas while
-- the sealed artifact restores its exact corpus_stats rows after corpus data.
CREATE TRIGGER IF NOT EXISTS corpus_counter_documents_ai
AFTER INSERT ON documents WHEN NEW.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM source_original_result_family_recovery_state WHERE id=1) BEGIN
  INSERT INTO corpus_stats(source,documents) VALUES(NEW.source,1)
  ON CONFLICT(source) DO UPDATE SET documents=corpus_stats.documents+1;
END;
CREATE TRIGGER IF NOT EXISTS corpus_counter_documents_bd
BEFORE DELETE ON documents WHEN OLD.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM source_original_result_family_recovery_state WHERE id=1) BEGIN
  SELECT RAISE(ABORT,'document lifecycle exceeds the bounded counter page')
    WHERE EXISTS(SELECT 1 FROM chunks WHERE doc_uid=OLD.doc_uid ORDER BY chunk_ix LIMIT 1 OFFSET 512);
  UPDATE corpus_stats SET documents=documents-1,
    chunks=chunks-(SELECT COUNT(*) FROM (SELECT 1 FROM chunks WHERE doc_uid=OLD.doc_uid ORDER BY chunk_ix LIMIT 512))
    WHERE source=OLD.source;
END;
CREATE TRIGGER IF NOT EXISTS corpus_counter_documents_au
AFTER UPDATE OF source,deleted_at ON documents
WHEN (NEW.source IS NOT OLD.source OR NEW.deleted_at IS NOT OLD.deleted_at) AND NOT EXISTS(SELECT 1 FROM source_original_result_family_recovery_state WHERE id=1) BEGIN
  SELECT RAISE(ABORT,'document lifecycle exceeds the bounded counter page')
    WHERE EXISTS(SELECT 1 FROM chunks WHERE doc_uid=NEW.doc_uid ORDER BY chunk_ix LIMIT 1 OFFSET 512);
  UPDATE corpus_stats SET documents=documents-1,
    chunks=chunks-(SELECT COUNT(*) FROM (SELECT 1 FROM chunks WHERE doc_uid=NEW.doc_uid ORDER BY chunk_ix LIMIT 512))
    WHERE source=OLD.source AND OLD.deleted_at IS NULL;
  INSERT INTO corpus_stats(source,documents,chunks)
    SELECT NEW.source,1,(SELECT COUNT(*) FROM (SELECT 1 FROM chunks WHERE doc_uid=NEW.doc_uid ORDER BY chunk_ix LIMIT 512))
    WHERE NEW.deleted_at IS NULL
    ON CONFLICT(source) DO UPDATE SET documents=corpus_stats.documents+1,chunks=corpus_stats.chunks+excluded.chunks;
END;
CREATE TRIGGER IF NOT EXISTS corpus_counter_chunks_ai
AFTER INSERT ON chunks WHEN NOT EXISTS(SELECT 1 FROM source_original_result_family_recovery_state WHERE id=1) BEGIN
  INSERT INTO corpus_stats(source,chunks)
    SELECT source,1 FROM documents WHERE doc_uid=NEW.doc_uid AND deleted_at IS NULL
    ON CONFLICT(source) DO UPDATE SET chunks=corpus_stats.chunks+1;
END;
CREATE TRIGGER IF NOT EXISTS corpus_counter_chunks_ad
AFTER DELETE ON chunks WHEN NOT EXISTS(SELECT 1 FROM source_original_result_family_recovery_state WHERE id=1) BEGIN
  -- A cascading document delete already accounted for its bounded child page
  -- before the parent disappeared. Explicit child deletes still see the parent.
  UPDATE corpus_stats SET chunks=chunks-1 WHERE source IN (
    SELECT source FROM documents WHERE doc_uid=OLD.doc_uid AND deleted_at IS NULL);
END;
CREATE TRIGGER IF NOT EXISTS corpus_counter_chunks_au
AFTER UPDATE OF doc_uid ON chunks WHEN NEW.doc_uid IS NOT OLD.doc_uid AND NOT EXISTS(SELECT 1 FROM source_original_result_family_recovery_state WHERE id=1) BEGIN
  UPDATE corpus_stats SET chunks=chunks-1 WHERE source IN (
    SELECT source FROM documents WHERE doc_uid=OLD.doc_uid AND deleted_at IS NULL);
  INSERT INTO corpus_stats(source,chunks)
    SELECT source,1 FROM documents WHERE doc_uid=NEW.doc_uid AND deleted_at IS NULL
    ON CONFLICT(source) DO UPDATE SET chunks=corpus_stats.chunks+1;
END;
