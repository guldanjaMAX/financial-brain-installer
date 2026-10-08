-- Reserved centrally for financial contract v1. All source/normalized bytes
-- and findings are immutable; only the separately fenced head can advance.
CREATE TABLE IF NOT EXISTS financial_snapshots (
  tenant_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  scope_hash TEXT NOT NULL CHECK (length(scope_hash) = 64),
  generation INTEGER NOT NULL CHECK (generation > 0),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  source_id TEXT NOT NULL,
  source_doc_ref TEXT NOT NULL,
  previous_snapshot_id TEXT,
  previous_content_hash TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 1048576),
  raw_bytes BLOB NOT NULL CHECK (typeof(raw_bytes) = 'blob' AND length(raw_bytes) BETWEEN 1 AND 524288),
  PRIMARY KEY (tenant_id, snapshot_id),
  UNIQUE (tenant_id, scope_hash, generation),
  CHECK (json_extract(payload_json, '$.schema_version') IS 'financial-snapshot-1'),
  CHECK (json_extract(payload_json, '$.scope.tenant') IS tenant_id),
  CHECK (json_extract(payload_json, '$.snapshot_id') IS snapshot_id),
  CHECK (json_extract(payload_json, '$.generation') IS generation),
  CHECK (json_extract(payload_json, '$.content_hash') IS content_hash),
  CHECK (json_extract(payload_json, '$.source_id') IS source_id),
  CHECK (json_extract(payload_json, '$.source_document_ref') IS source_doc_ref),
  CHECK (json_extract(payload_json, '$.coverage.state') IS 'complete_for_report_scope'),
  CHECK ((generation = 1 AND previous_snapshot_id IS NULL AND previous_content_hash IS NULL) OR
         (generation > 1 AND previous_snapshot_id IS NOT NULL AND previous_content_hash IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS financial_snapshot_heads (
  tenant_id TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  PRIMARY KEY (tenant_id, scope_hash),
  FOREIGN KEY (tenant_id, snapshot_id) REFERENCES financial_snapshots(tenant_id, snapshot_id)
);

CREATE TRIGGER IF NOT EXISTS financial_snapshots_insert_guard
BEFORE INSERT ON financial_snapshots
BEGIN
  SELECT RAISE(ABORT, 'financial snapshots are immutable') WHERE EXISTS
    (SELECT 1 FROM financial_snapshots WHERE tenant_id = NEW.tenant_id AND snapshot_id = NEW.snapshot_id);
  -- Recovery can restore immutable generations in any order. Publication is
  -- guarded at the separate head, after every required generation is present.
END;

CREATE TRIGGER IF NOT EXISTS financial_snapshots_no_update
BEFORE UPDATE ON financial_snapshots
BEGIN
  SELECT RAISE(ABORT, 'financial snapshots are immutable');
END;

CREATE TRIGGER IF NOT EXISTS financial_snapshots_no_delete
BEFORE DELETE ON financial_snapshots
BEGIN
  SELECT RAISE(ABORT, 'financial snapshots are immutable');
END;

CREATE TRIGGER IF NOT EXISTS financial_heads_insert_guard
BEFORE INSERT ON financial_snapshot_heads
BEGIN
  SELECT RAISE(ABORT, 'financial head history incomplete') WHERE NOT EXISTS
    (SELECT 1 FROM financial_snapshot_heads WHERE tenant_id = NEW.tenant_id AND scope_hash = NEW.scope_hash)
    AND ((SELECT count(*) FROM financial_snapshots WHERE tenant_id = NEW.tenant_id AND scope_hash = NEW.scope_hash
      AND generation <= NEW.generation) <> NEW.generation OR EXISTS
      (SELECT 1 FROM financial_snapshots AS child WHERE child.tenant_id = NEW.tenant_id AND child.scope_hash = NEW.scope_hash
        AND child.generation BETWEEN 2 AND NEW.generation AND NOT EXISTS
        (SELECT 1 FROM financial_snapshots AS parent WHERE parent.tenant_id = child.tenant_id AND parent.scope_hash = child.scope_hash
          AND parent.generation = child.generation - 1 AND parent.snapshot_id = child.previous_snapshot_id AND parent.content_hash = child.previous_content_hash)));
  SELECT RAISE(ABORT, 'financial head conflict') WHERE EXISTS
    (SELECT 1 FROM financial_snapshot_heads AS old WHERE old.tenant_id = NEW.tenant_id AND old.scope_hash = NEW.scope_hash
      AND NOT ((NEW.generation = old.generation AND NEW.snapshot_id = old.snapshot_id AND NEW.content_hash = old.content_hash) OR
        (NEW.generation = old.generation + 1 AND EXISTS
          (SELECT 1 FROM financial_snapshots WHERE tenant_id = NEW.tenant_id AND snapshot_id = NEW.snapshot_id
            AND previous_snapshot_id = old.snapshot_id AND previous_content_hash = old.content_hash))));
  SELECT RAISE(ABORT, 'financial head binding') WHERE NOT EXISTS
    (SELECT 1 FROM financial_snapshots WHERE tenant_id = NEW.tenant_id AND scope_hash = NEW.scope_hash
      AND snapshot_id = NEW.snapshot_id AND content_hash = NEW.content_hash AND generation = NEW.generation);
END;

CREATE TRIGGER IF NOT EXISTS financial_heads_update_guard
BEFORE UPDATE ON financial_snapshot_heads
BEGIN
  SELECT RAISE(ABORT, 'financial head conflict') WHERE NEW.tenant_id <> OLD.tenant_id OR NEW.scope_hash <> OLD.scope_hash
    OR NEW.generation <> OLD.generation + 1 OR NOT EXISTS
    (SELECT 1 FROM financial_snapshots WHERE tenant_id = NEW.tenant_id AND scope_hash = NEW.scope_hash
      AND snapshot_id = NEW.snapshot_id AND content_hash = NEW.content_hash AND generation = NEW.generation
      AND previous_snapshot_id = OLD.snapshot_id AND previous_content_hash = OLD.content_hash);
END;

CREATE TRIGGER IF NOT EXISTS financial_heads_no_delete
BEFORE DELETE ON financial_snapshot_heads
BEGIN
  SELECT RAISE(ABORT, 'financial head history is required');
END;

CREATE TABLE IF NOT EXISTS financial_findings (
  tenant_id TEXT NOT NULL,
  finding_id TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 1048576),
  PRIMARY KEY (tenant_id, finding_id),
  CHECK (json_extract(payload_json, '$.schema_version') IS 'books-finding-1'),
  CHECK (json_extract(payload_json, '$.scope.tenant') IS tenant_id),
  CHECK (json_extract(payload_json, '$.finding_id') IS finding_id),
  CHECK (json_extract(payload_json, '$.content_hash') IS content_hash),
  CHECK (json_extract(payload_json, '$.financial_authority') IS 0)
);

CREATE TRIGGER IF NOT EXISTS financial_findings_no_replace
BEFORE INSERT ON financial_findings
WHEN EXISTS (SELECT 1 FROM financial_findings WHERE tenant_id = NEW.tenant_id AND finding_id = NEW.finding_id)
BEGIN
  SELECT RAISE(ABORT, 'financial findings are immutable');
END;

CREATE TRIGGER IF NOT EXISTS financial_findings_no_update
BEFORE UPDATE ON financial_findings
BEGIN
  SELECT RAISE(ABORT, 'financial findings are immutable');
END;

CREATE TRIGGER IF NOT EXISTS financial_findings_no_delete
BEFORE DELETE ON financial_findings
BEGIN
  SELECT RAISE(ABORT, 'financial findings are immutable');
END;

CREATE TABLE IF NOT EXISTS financial_run_events (
  tenant_id TEXT NOT NULL,
  event_hash TEXT NOT NULL CHECK (length(event_hash) = 64),
  snapshot_id TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('started', 'incomplete', 'published')),
  implementation_sha TEXT NOT NULL CHECK (length(implementation_sha) = 40),
  observed_at TEXT NOT NULL,
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  dependencies_json TEXT NOT NULL CHECK (json_valid(dependencies_json)),
  PRIMARY KEY (tenant_id, event_hash)
);

CREATE TRIGGER IF NOT EXISTS financial_run_events_no_replace
BEFORE INSERT ON financial_run_events
WHEN EXISTS (SELECT 1 FROM financial_run_events WHERE tenant_id = NEW.tenant_id AND event_hash = NEW.event_hash)
BEGIN
  SELECT RAISE(ABORT, 'financial run events are immutable');
END;

CREATE INDEX IF NOT EXISTS financial_run_events_snapshot
ON financial_run_events (tenant_id, snapshot_id, event_kind, event_hash);

CREATE TRIGGER IF NOT EXISTS financial_run_events_no_update
BEFORE UPDATE ON financial_run_events
BEGIN
  SELECT RAISE(ABORT, 'financial run events are immutable');
END;

CREATE TRIGGER IF NOT EXISTS financial_run_events_no_delete
BEFORE DELETE ON financial_run_events
BEGIN
  SELECT RAISE(ABORT, 'financial run events are immutable');
END;
