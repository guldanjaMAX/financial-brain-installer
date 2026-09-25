-- 0048_ocr_page_acknowledgement
--
-- A completed OCR handoff is still needed until the source document that uses
-- it has been confirmed stored. Keep the acknowledgement and the one permitted
-- legacy re-read count on the original request receipt. This lets cleanup
-- distinguish safe ciphertext pruning from an unconsumed paid result without
-- storing document identity or transcription text.

ALTER TABLE ocr_page_requests
  ADD COLUMN acknowledged_at TEXT;

ALTER TABLE ocr_page_requests
  ADD COLUMN reread_count INTEGER NOT NULL DEFAULT 0
    CHECK (reread_count IN (0, 1));
