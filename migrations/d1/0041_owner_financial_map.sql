-- 0041_owner_financial_map
--
-- The owner financial map is the denominator for a completeness review. It is
-- not inferred from documents and it does not rewrite the financial ledger.
-- A preview has no authority. Only a fresh receipt-bound owner passkey can
-- append an immutable snapshot, and every snapshot points at the one prior
-- head so two stale interviews cannot create competing histories.
-- The per-database random salt is immutable and independent of session-key
-- rotation. It makes public evidence references opaque without coupling the
-- durable map chain to a login credential.

CREATE TABLE IF NOT EXISTS owner_financial_map_key_state (
  tenant_id   TEXT PRIMARY KEY,
  signing_salt TEXT NOT NULL,
  CHECK (tenant_id GLOB '[a-z0-9]*' AND tenant_id NOT GLOB '*[^a-z0-9_-]*' AND length(tenant_id) BETWEEN 1 AND 64),
  CHECK (length(signing_salt) = 64 AND lower(signing_salt) NOT GLOB '*[^0-9a-f]*')
);

-- A normal install or upgrade already has install_state when this migration
-- runs. A verified recovery applies schema before importing durable data, so
-- it intentionally leaves this row empty for the source salt to be restored.
INSERT OR IGNORE INTO owner_financial_map_key_state (tenant_id, signing_salt)
SELECT 'primary', lower(hex(randomblob(32)))
 WHERE EXISTS (SELECT 1 FROM install_state WHERE id = 1);

CREATE TRIGGER IF NOT EXISTS owner_financial_map_key_salt_no_update
BEFORE UPDATE OF signing_salt ON owner_financial_map_key_state
WHEN NEW.signing_salt <> OLD.signing_salt
BEGIN
  SELECT RAISE(ABORT, 'owner financial map signing salt is immutable');
END;

CREATE TRIGGER IF NOT EXISTS owner_financial_map_key_no_delete
BEFORE DELETE ON owner_financial_map_key_state
BEGIN
  SELECT RAISE(ABORT, 'owner financial map key state is required');
END;

-- The counter is a local compare-and-swap fence for previews. It is derived
-- during a recovery as financial rows replay through the triggers, so it is
-- not part of the durable recovery payload.
CREATE TABLE IF NOT EXISTS owner_financial_map_inventory_state (
  tenant_id   TEXT PRIMARY KEY,
  generation  INTEGER NOT NULL DEFAULT 0,
  CHECK (tenant_id GLOB '[a-z0-9]*' AND tenant_id NOT GLOB '*[^a-z0-9_-]*' AND length(tenant_id) BETWEEN 1 AND 64),
  CHECK (generation >= 0)
);

INSERT OR IGNORE INTO owner_financial_map_inventory_state (tenant_id, generation)
VALUES ('primary', 0);

CREATE TRIGGER IF NOT EXISTS owner_financial_map_inventory_no_delete
BEFORE DELETE ON owner_financial_map_inventory_state
BEGIN
  SELECT RAISE(ABORT, 'owner financial map inventory state is required');
END;

-- Conservative invalidation is intentional. Changes to replaced rows are not
-- part of the current map, but invalidating an in-flight preview is safer than
-- allowing a low-level ledger edit to escape its owner review boundary.
CREATE TRIGGER IF NOT EXISTS owner_financial_map_entities_ai
AFTER INSERT ON fin_entities
BEGIN
  INSERT INTO owner_financial_map_inventory_state (tenant_id, generation)
  VALUES (NEW.tenant_id, 1)
  ON CONFLICT(tenant_id) DO UPDATE SET generation = generation + 1;
END;

CREATE TRIGGER IF NOT EXISTS owner_financial_map_entities_au
AFTER UPDATE ON fin_entities
BEGIN
  INSERT INTO owner_financial_map_inventory_state (tenant_id, generation)
  SELECT OLD.tenant_id, 1
  WHERE OLD.tenant_id <> NEW.tenant_id
  ON CONFLICT(tenant_id) DO UPDATE SET generation = generation + 1;
  INSERT INTO owner_financial_map_inventory_state (tenant_id, generation)
  VALUES (NEW.tenant_id, 1)
  ON CONFLICT(tenant_id) DO UPDATE SET generation = generation + 1;
END;

CREATE TRIGGER IF NOT EXISTS owner_financial_map_entities_ad
AFTER DELETE ON fin_entities
BEGIN
  INSERT INTO owner_financial_map_inventory_state (tenant_id, generation)
  VALUES (OLD.tenant_id, 1)
  ON CONFLICT(tenant_id) DO UPDATE SET generation = generation + 1;
END;

CREATE TRIGGER IF NOT EXISTS owner_financial_map_accounts_ai
AFTER INSERT ON fin_accounts
BEGIN
  INSERT INTO owner_financial_map_inventory_state (tenant_id, generation)
  VALUES (NEW.tenant_id, 1)
  ON CONFLICT(tenant_id) DO UPDATE SET generation = generation + 1;
END;

CREATE TRIGGER IF NOT EXISTS owner_financial_map_accounts_au
AFTER UPDATE ON fin_accounts
BEGIN
  INSERT INTO owner_financial_map_inventory_state (tenant_id, generation)
  SELECT OLD.tenant_id, 1
  WHERE OLD.tenant_id <> NEW.tenant_id
  ON CONFLICT(tenant_id) DO UPDATE SET generation = generation + 1;
  INSERT INTO owner_financial_map_inventory_state (tenant_id, generation)
  VALUES (NEW.tenant_id, 1)
  ON CONFLICT(tenant_id) DO UPDATE SET generation = generation + 1;
END;

CREATE TRIGGER IF NOT EXISTS owner_financial_map_accounts_ad
AFTER DELETE ON fin_accounts
BEGIN
  INSERT INTO owner_financial_map_inventory_state (tenant_id, generation)
  VALUES (OLD.tenant_id, 1)
  ON CONFLICT(tenant_id) DO UPDATE SET generation = generation + 1;
END;

CREATE TABLE IF NOT EXISTS owner_financial_map_previews (
  receipt_hash               TEXT PRIMARY KEY,
  tenant_id                  TEXT NOT NULL,
  contract_version           INTEGER NOT NULL,
  snapshot_json              TEXT NOT NULL,
  map_hash                   TEXT NOT NULL,
  denominator_hash           TEXT NOT NULL,
  inventory_hash             TEXT NOT NULL,
  inventory_generation       INTEGER NOT NULL,
  expected_head_snapshot_id  TEXT,
  expected_head_map_hash     TEXT,
  expected_sequence_no       INTEGER NOT NULL,
  population_state           TEXT NOT NULL,
  tax_year_start             INTEGER NOT NULL,
  tax_year_end               INTEGER NOT NULL,
  entity_count               INTEGER NOT NULL,
  account_count              INTEGER NOT NULL,
  entity_year_count          INTEGER NOT NULL,
  filing_unit_count          INTEGER NOT NULL,
  obligation_count           INTEGER NOT NULL,
  preview_seal               TEXT NOT NULL,
  expires_at                 INTEGER NOT NULL,
  state                      TEXT NOT NULL DEFAULT 'previewed',
  request_id                 TEXT,
  request_hash               TEXT,
  activated_snapshot_id      TEXT,
  created_at                 INTEGER NOT NULL,
  activated_at               INTEGER,
  CHECK (contract_version = 1),
  CHECK (length(receipt_hash) = 64 AND lower(receipt_hash) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(map_hash) = 64 AND lower(map_hash) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(denominator_hash) = 64 AND lower(denominator_hash) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(inventory_hash) = 64 AND lower(inventory_hash) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(preview_seal) = 64 AND lower(preview_seal) NOT GLOB '*[^0-9a-f]*'),
  CHECK (expected_head_map_hash IS NULL OR (length(expected_head_map_hash) = 64 AND lower(expected_head_map_hash) NOT GLOB '*[^0-9a-f]*')),
  CHECK (inventory_generation >= 0 AND expected_sequence_no >= 1),
  CHECK (population_state IN ('owner_asserted_complete','known_partial','unknown')),
  CHECK (tax_year_start BETWEEN 1900 AND 2200 AND tax_year_end BETWEEN tax_year_start AND 2200 AND tax_year_end - tax_year_start <= 20),
  CHECK (entity_count >= 0 AND account_count >= 0 AND entity_year_count >= 0 AND filing_unit_count >= 0 AND obligation_count >= 0),
  CHECK (state IN ('previewed','invalidated','activated')),
  CHECK ((expected_sequence_no = 1 AND expected_head_snapshot_id IS NULL AND expected_head_map_hash IS NULL) OR
         (expected_sequence_no > 1 AND expected_head_snapshot_id IS NOT NULL AND expected_head_map_hash IS NOT NULL)),
  CHECK (request_id IS NULL OR (request_id GLOB '[A-Za-z0-9_-]*' AND request_id NOT GLOB '*[^A-Za-z0-9_-]*' AND length(request_id) BETWEEN 1 AND 128)),
  CHECK (request_hash IS NULL OR (length(request_hash) = 64 AND lower(request_hash) NOT GLOB '*[^0-9a-f]*'))
);

CREATE INDEX IF NOT EXISTS idx_owner_financial_map_previews_expiry
  ON owner_financial_map_previews (tenant_id, state, expires_at);

-- A tenant can have only one map awaiting owner review. The application
-- invalidates the old preview before inserting a replacement, and this index
-- keeps that invariant true even if two writers race or bypass the handler.
CREATE UNIQUE INDEX IF NOT EXISTS ux_owner_financial_map_one_pending_preview
  ON owner_financial_map_previews (tenant_id)
  WHERE state = 'previewed';

CREATE TABLE IF NOT EXISTS owner_financial_map_snapshots (
  snapshot_id          TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL,
  sequence_no          INTEGER NOT NULL,
  previous_snapshot_id TEXT,
  previous_map_hash    TEXT,
  contract_version     INTEGER NOT NULL,
  snapshot_json        TEXT NOT NULL,
  map_hash             TEXT NOT NULL,
  denominator_hash     TEXT NOT NULL,
  inventory_hash       TEXT NOT NULL,
  inventory_generation INTEGER NOT NULL,
  population_state     TEXT NOT NULL,
  tax_year_start       INTEGER NOT NULL,
  tax_year_end         INTEGER NOT NULL,
  entity_count         INTEGER NOT NULL,
  account_count        INTEGER NOT NULL,
  entity_year_count    INTEGER NOT NULL,
  filing_unit_count    INTEGER NOT NULL,
  obligation_count     INTEGER NOT NULL,
  snapshot_seal        TEXT NOT NULL,
  credential_ref       TEXT NOT NULL,
  request_id           TEXT NOT NULL,
  request_hash         TEXT NOT NULL,
  activated_at         INTEGER NOT NULL,
  UNIQUE (tenant_id, sequence_no),
  UNIQUE (tenant_id, previous_snapshot_id),
  UNIQUE (tenant_id, request_id),
  CHECK (tenant_id GLOB '[a-z0-9]*' AND tenant_id NOT GLOB '*[^a-z0-9_-]*' AND length(tenant_id) BETWEEN 1 AND 64),
  CHECK (snapshot_id GLOB 'ofm_[A-Za-z0-9_-]*' AND snapshot_id NOT GLOB '*[^A-Za-z0-9_-]*' AND length(snapshot_id) BETWEEN 20 AND 80),
  CHECK (sequence_no >= 1),
  CHECK ((sequence_no = 1 AND previous_snapshot_id IS NULL AND previous_map_hash IS NULL) OR
         (sequence_no > 1 AND previous_snapshot_id IS NOT NULL AND previous_map_hash IS NOT NULL)),
  CHECK (contract_version = 1),
  CHECK (length(map_hash) = 64 AND lower(map_hash) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(denominator_hash) = 64 AND lower(denominator_hash) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(inventory_hash) = 64 AND lower(inventory_hash) NOT GLOB '*[^0-9a-f]*'),
  CHECK (previous_map_hash IS NULL OR (length(previous_map_hash) = 64 AND lower(previous_map_hash) NOT GLOB '*[^0-9a-f]*')),
  CHECK (length(snapshot_seal) = 64 AND lower(snapshot_seal) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(credential_ref) = 64 AND lower(credential_ref) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(request_hash) = 64 AND lower(request_hash) NOT GLOB '*[^0-9a-f]*'),
  CHECK (request_id GLOB '[A-Za-z0-9_-]*' AND request_id NOT GLOB '*[^A-Za-z0-9_-]*' AND length(request_id) BETWEEN 1 AND 128),
  CHECK (inventory_generation >= 0),
  CHECK (population_state IN ('owner_asserted_complete','known_partial','unknown')),
  CHECK (tax_year_start BETWEEN 1900 AND 2200 AND tax_year_end BETWEEN tax_year_start AND 2200 AND tax_year_end - tax_year_start <= 20),
  CHECK (entity_count >= 0 AND account_count >= 0 AND entity_year_count >= 0 AND filing_unit_count >= 0 AND obligation_count >= 0)
);

-- SQLite considers NULLs distinct in UNIQUE constraints. This partial index
-- makes the genesis snapshot singular even under a direct concurrent writer.
CREATE UNIQUE INDEX IF NOT EXISTS ux_owner_financial_map_one_genesis
  ON owner_financial_map_snapshots (tenant_id)
  WHERE previous_snapshot_id IS NULL;

CREATE TRIGGER IF NOT EXISTS owner_financial_map_snapshots_no_update
BEFORE UPDATE ON owner_financial_map_snapshots
BEGIN
  SELECT RAISE(ABORT, 'owner financial map snapshots are append-only');
END;

CREATE TRIGGER IF NOT EXISTS owner_financial_map_snapshots_no_delete
BEFORE DELETE ON owner_financial_map_snapshots
BEGIN
  SELECT RAISE(ABORT, 'owner financial map snapshots are append-only');
END;
