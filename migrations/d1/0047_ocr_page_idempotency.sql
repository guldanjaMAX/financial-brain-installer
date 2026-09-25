-- 0047_ocr_page_idempotency
--
-- A page-level OCR request can finish inside Workers AI after the installer's
-- 60-second HTTP deadline. Retrying that POST without a durable receipt can
-- bill the owner twice for the same rendered page and return two independent
-- transcriptions. Reserve the opaque page request before inference, then move
-- it to an explicit in-flight state immediately before the model call. Only a
-- pre-call reservation may expire and be reclaimed automatically. An expired
-- in-flight row is held for review because billing is ambiguous.
--
-- A completed row keeps a permanent content-free tombstone. A bounded replay
-- handoff may accompany it as AES-GCM ciphertext whose key exists only in the
-- caller that submitted the page. OCR plaintext must still reach the complete-
-- document credential gate before any durable corpus write. An expired
-- ciphertext handoff is cleared opportunistically; that cleanup never removes
-- the tombstone or authorizes another model call. No
-- source locator, file name or document identity is stored.

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
