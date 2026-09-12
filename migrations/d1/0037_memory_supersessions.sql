-- 0037_memory_supersessions
--
-- A conversational correction must not overwrite its history, and a string in
-- document metadata is not enough authority to hide another record. Keep the
-- server-verified link in its own append-only table. Retrieval treats the
-- predecessor as history only after both exact D1 rows and their content hashes
-- have been checked by the owner-note lifecycle.
--
-- There are deliberately no foreign keys here. Forgetting a document is an
-- independently audited owner action. Keeping this receipt means a removed
-- successor cannot accidentally make a known-wrong predecessor current again,
-- and a removed predecessor does not erase the provenance of its correction.

CREATE TABLE IF NOT EXISTS memory_supersessions (
  predecessor_doc_uid     TEXT PRIMARY KEY,
  successor_doc_uid       TEXT NOT NULL UNIQUE,
  predecessor_content_hash TEXT NOT NULL,
  successor_content_hash   TEXT NOT NULL,
  channel                  TEXT NOT NULL,
  created_at               INTEGER NOT NULL,
  CHECK (channel IN ('local_mcp', 'remote_mcp')),
  CHECK (predecessor_doc_uid <> successor_doc_uid)
);

CREATE INDEX IF NOT EXISTS idx_memory_supersessions_successor
  ON memory_supersessions(successor_doc_uid);
