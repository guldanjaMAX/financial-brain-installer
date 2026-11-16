-- Notification and owner-choice writers may move due_at earlier. A provider
-- cooldown is independent debt and is checked again under the sync lease.
ALTER TABLE plaid_reconciliation ADD COLUMN provider_retry_not_before TEXT;

UPDATE plaid_reconciliation SET provider_retry_not_before=due_at
  WHERE last_error_code='RATE_LIMIT_EXCEEDED' AND provider_retry_not_before IS NULL;
