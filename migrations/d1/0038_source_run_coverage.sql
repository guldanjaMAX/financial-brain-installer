-- 0038_source_run_coverage
--
-- A source receipt already distinguishes a completed traversal from a complete
-- historical sweep, but its durable run row could not say how many documents
-- were refused or failed. The owner coverage projection attempted to read both
-- fields anyway, so they were permanently null. Store those measured outcomes
-- explicitly, together with optional connector-declared date bounds.
--
-- metrics_version keeps legacy default zeroes honest. A row written before this
-- migration did not measure refused/failed counts, so backfilling those rows as
-- zero would invent success. New terminal receipts set metrics_version to 1.

ALTER TABLE sync_runs ADD COLUMN docs_refused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_runs ADD COLUMN docs_failed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_runs ADD COLUMN metrics_version INTEGER NOT NULL DEFAULT 0;

-- These bounds keep source-specific proof and observation separate. Confirmed
-- bounds remain NULL unless a connector has an authoritative boundary, such as
-- Calendar's configured full-sync start. A locally traversed message database
-- span is recorded only as a target because deleted or device-only history is
-- not visible to that walk.
ALTER TABLE sync_runs ADD COLUMN confirmed_from TEXT;
ALTER TABLE sync_runs ADD COLUMN confirmed_through TEXT;
ALTER TABLE sync_runs ADD COLUMN target_from TEXT;
ALTER TABLE sync_runs ADD COLUMN target_through TEXT;
