-- An apply receipt must commit with the exact repaired page. Otherwise a lost
-- response can repeat queue mutations or advance to an unapproved next page.
-- Previews remain read-only. This stores only hashes, cursors and count receipts.
CREATE TABLE IF NOT EXISTS content_date_refresh_receipts (
  plan_hash TEXT PRIMARY KEY CHECK (length(plan_hash)=64 AND plan_hash NOT GLOB '*[^a-f0-9]*'),
  start_cursor INTEGER NOT NULL CHECK (start_cursor >= 0),
  receipt TEXT NOT NULL CHECK (json_valid(receipt)),
  applied_at INTEGER NOT NULL CHECK (applied_at >= 0)
);
