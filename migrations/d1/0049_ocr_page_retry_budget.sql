-- 0049_ocr_page_retry_budget
--
-- A terminal provider error proves that its model call has ended, so it needs
-- only a short retry backoff rather than the ambiguity window reserved for a
-- lost response. Count every started model call in one durable rolling window
-- so repeated terminal failures cannot create unbounded spend.

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
