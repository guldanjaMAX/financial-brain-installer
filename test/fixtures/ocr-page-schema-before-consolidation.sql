-- Test-only snapshot of the unshipped 0047-0049 OCR migration suffix.
-- It lets the migration suite prove that the consolidated 0047 produces the
-- same normalized sqlite_master rows without keeping 0048 or 0049 in the
-- product migration inventory.

CREATE TABLE IF NOT EXISTS ocr_page_requests (
  request_id       TEXT PRIMARY KEY
    CHECK (
      length(request_id) = 64
      AND request_id = lower(request_id)
      AND request_id NOT GLOB '*[^0-9a-f]*'
    ),
  input_sha256     TEXT NOT NULL
    CHECK (
      length(input_sha256) = 64
      AND input_sha256 = lower(input_sha256)
      AND input_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  status           TEXT NOT NULL CHECK (status IN ('pending','in_flight','completed')),
  owner_token      TEXT NOT NULL CHECK (length(owner_token) BETWEEN 32 AND 64),
  started_at       TEXT NOT NULL,
  model_started_at TEXT,
  completed_at     TEXT,
  expires_at       TEXT NOT NULL,
  response_status  INTEGER,
  response_json    TEXT,
  replay_key_sha256 TEXT,
  replay_expires_at TEXT,
  replay_iv         TEXT,
  replay_ciphertext TEXT,
  CHECK (
    (status = 'pending' AND model_started_at IS NULL AND completed_at IS NULL
      AND response_status IS NULL AND response_json IS NULL)
    OR
    (status = 'in_flight' AND model_started_at IS NOT NULL AND completed_at IS NULL
      AND response_status IS NULL AND response_json IS NULL)
    OR
    (status = 'completed' AND model_started_at IS NOT NULL AND completed_at IS NOT NULL
      AND response_status BETWEEN 200 AND 599 AND response_json IS NOT NULL
      AND (
        (replay_key_sha256 IS NULL AND replay_expires_at IS NULL
          AND replay_iv IS NULL AND replay_ciphertext IS NULL)
        OR
        (length(replay_key_sha256) = 64 AND replay_key_sha256 = lower(replay_key_sha256)
          AND replay_key_sha256 NOT GLOB '*[^0-9a-f]*'
          AND replay_expires_at IS NOT NULL AND replay_iv IS NOT NULL
          AND replay_ciphertext IS NOT NULL)
      ))
  )
);

CREATE INDEX IF NOT EXISTS idx_ocr_page_requests_expiry
  ON ocr_page_requests(status, replay_expires_at);

ALTER TABLE ocr_page_requests
  ADD COLUMN acknowledged_at TEXT;

ALTER TABLE ocr_page_requests
  ADD COLUMN reread_count INTEGER NOT NULL DEFAULT 0
    CHECK (reread_count IN (0, 1));

ALTER TABLE ocr_page_requests
  ADD COLUMN provider_failed_at TEXT;

ALTER TABLE ocr_page_requests
  ADD COLUMN model_call_count INTEGER NOT NULL DEFAULT 0
    CHECK (model_call_count BETWEEN 0 AND 3);

ALTER TABLE ocr_page_requests
  ADD COLUMN model_call_window_started_at TEXT;

UPDATE ocr_page_requests
   SET model_call_count = CASE
         WHEN model_started_at IS NULL THEN reread_count
         ELSE reread_count + 1
       END,
       model_call_window_started_at = CASE
         WHEN model_started_at IS NULL AND reread_count = 0 THEN NULL
         ELSE COALESCE(model_started_at, started_at)
       END;
