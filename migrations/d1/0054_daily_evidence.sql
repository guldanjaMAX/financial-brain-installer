-- Older Calendar walks did not prove a validated terminal provider boundary.
-- They stay unknown until a new connector run supplies explicit evidence.
ALTER TABLE sync_runs ADD COLUMN provider_check_complete INTEGER NOT NULL DEFAULT 0
  CHECK (provider_check_complete IN (0,1));

-- Cover the status aggregate without reading recording rows or sorting them.
-- Do not add delivery triggers: D1 includes trigger writes in meta.changes,
-- while delivery claim and outcome leases require exactly one changed row.
-- Lifetime totals still visit retained status-index entries.
CREATE INDEX IF NOT EXISTS zoom_deliveries_status ON zoom_deliveries(status);
