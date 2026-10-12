-- Only an explicit owner approval authorizes manual/live precedence. Unlink
-- closes the approval without deleting either account, its money, or history.
-- No triggers: the maintenance batch guards and verifies its own writes.
CREATE TABLE IF NOT EXISTS fin_account_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  manual_account_slug TEXT NOT NULL,
  live_account_slug TEXT NOT NULL,
  identity_json TEXT NOT NULL,
  link_plan_hash TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  unlinked_at TEXT,
  unlink_plan_hash TEXT,
  CHECK (tenant_id GLOB '[a-z0-9]*' AND tenant_id NOT GLOB '*[^a-z0-9_-]*' AND length(tenant_id) BETWEEN 1 AND 64),
  CHECK (manual_account_slug GLOB '[a-z0-9]*' AND manual_account_slug NOT GLOB '*[^a-z0-9_-]*' AND length(manual_account_slug) BETWEEN 1 AND 64),
  CHECK (live_account_slug GLOB '[a-z0-9]*' AND live_account_slug NOT GLOB '*[^a-z0-9_-]*' AND length(live_account_slug) BETWEEN 1 AND 64),
  CHECK (manual_account_slug <> live_account_slug),
  CHECK (json_valid(identity_json)),
  CHECK (length(link_plan_hash) = 64),
  CHECK ((unlinked_at IS NULL AND unlink_plan_hash IS NULL) OR
    (unlinked_at IS NOT NULL AND length(unlink_plan_hash) = 64))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_fin_account_links_manual
  ON fin_account_links(tenant_id,manual_account_slug) WHERE unlinked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_fin_account_links_live
  ON fin_account_links(tenant_id,live_account_slug) WHERE unlinked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fin_account_links_pair
  ON fin_account_links(tenant_id,manual_account_slug,live_account_slug,id);
