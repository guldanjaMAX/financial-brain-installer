-- Provider fields remain observations. Owner reviews are separate durable facts
-- bound to an exact account identity; revocation retains the full review history.
CREATE TABLE IF NOT EXISTS fin_account_kind_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  account_id INTEGER NOT NULL,
  identity_json TEXT NOT NULL CHECK (json_valid(identity_json)),
  kind TEXT NOT NULL CHECK (kind IN ('checking','savings','card','loan','line_of_credit','other')),
  role TEXT NOT NULL CHECK (role IN ('asset','liability')),
  reviewer TEXT NOT NULL CHECK (reviewer='owner'),
  source TEXT NOT NULL CHECK (source='owner_account_kind'),
  reviewed_at TEXT NOT NULL,
  review_plan_hash TEXT NOT NULL CHECK (length(review_plan_hash)=64),
  revoked_at TEXT,
  revoke_plan_hash TEXT,
  CHECK ((kind IN ('checking','savings') AND role='asset') OR
    (kind IN ('card','loan','line_of_credit') AND role='liability') OR kind='other'),
  CHECK ((revoked_at IS NULL AND revoke_plan_hash IS NULL) OR
    (revoked_at IS NOT NULL AND length(revoke_plan_hash)=64))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_fin_account_kind_reviews_active
  ON fin_account_kind_reviews(tenant_id,account_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fin_account_kind_reviews_history
  ON fin_account_kind_reviews(tenant_id,account_id,id);
