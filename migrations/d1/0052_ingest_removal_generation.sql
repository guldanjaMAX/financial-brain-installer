-- A removal approval must expire even when metadata changes without a vector
-- write. Outbox generation alone does not cover that case. This marker is
-- advanced in the same transaction as every durable document/chunk change.
-- The random nonce also distinguishes equal counters after a restored history forks.
CREATE TABLE IF NOT EXISTS ingest_removal_generation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  instance TEXT NOT NULL,
  nonce TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 0)
);
INSERT OR IGNORE INTO ingest_removal_generation VALUES (1, lower(hex(randomblob(16))), lower(hex(randomblob(16))), 0);

CREATE TRIGGER IF NOT EXISTS ingest_removal_documents_ai AFTER INSERT ON documents BEGIN
  UPDATE ingest_removal_generation SET generation = generation + 1, nonce = lower(hex(randomblob(16))) WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS ingest_removal_documents_au AFTER UPDATE ON documents BEGIN
  UPDATE ingest_removal_generation SET generation = generation + 1, nonce = lower(hex(randomblob(16))) WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS ingest_removal_documents_ad AFTER DELETE ON documents BEGIN
  UPDATE ingest_removal_generation SET generation = generation + 1, nonce = lower(hex(randomblob(16))) WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS ingest_removal_chunks_ai AFTER INSERT ON chunks BEGIN
  UPDATE ingest_removal_generation SET generation = generation + 1, nonce = lower(hex(randomblob(16))) WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS ingest_removal_chunks_au AFTER UPDATE ON chunks BEGIN
  UPDATE ingest_removal_generation SET generation = generation + 1, nonce = lower(hex(randomblob(16))) WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS ingest_removal_chunks_ad AFTER DELETE ON chunks BEGIN
  UPDATE ingest_removal_generation SET generation = generation + 1, nonce = lower(hex(randomblob(16))) WHERE id = 1;
END;
