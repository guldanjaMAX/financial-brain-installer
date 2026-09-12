-- 0040_source_failure_evidence
--
-- Migration 0039 is intentionally reserved for document provenance
-- assessment in the integration candidate. This migration stores only the
-- Worker's reconstructed, closed Gmail failure-evidence object. Provider
-- messages, remote identifiers, source content, paths, cursors, and tokens are
-- never admitted to this column.

ALTER TABLE sync_runs ADD COLUMN failure_evidence TEXT;
