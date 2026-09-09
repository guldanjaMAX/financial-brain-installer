-- Durable receipts for vector projection bookkeeping changes that a later
-- audit must be able to see. A residue-only re-projection recomputes the
-- bootstrap base count and opens an epoch that walks only queued rows, and
-- nothing else in the schema records that it happened. upgrade_runs is the
-- rollback ledger (`brain rollback` marks its newest row), so it cannot carry
-- these rows. Later reviewed recoveries (recreating the provider index) record
-- their before/after counts here too.
CREATE TABLE IF NOT EXISTS vector_projection_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  epoch_before  INTEGER,
  epoch_after   INTEGER,
  base_before   INTEGER,
  base_after    INTEGER,
  rows          INTEGER,
  chunks        INTEGER,
  detail        TEXT
);

CREATE INDEX IF NOT EXISTS idx_vector_projection_events_at
  ON vector_projection_events(at DESC);

-- The epoch of an open residue-only re-projection, or NULL. Kept OUT of the
-- protocol column on purpose: every shipped Worker branches on that column and
-- its legacy branch deletes queued upserts before refusing, so a marker there
-- would turn an interrupted update re-run from an older kit into data loss.
-- Older Workers never read this column.
ALTER TABLE install_state ADD COLUMN vector_projection_residue_epoch INTEGER;
