-- 0039_document_provenance_assessment
--
-- Migration 0020 populated legacy extraction columns with native/1 even when
-- no producer receipt existed. Those values are useful legacy hints, but they
-- are not proof. Keep a separate marker that is written only after the shared
-- JavaScript ingest boundary validates the complete v1 provenance receipt.
-- Existing rows intentionally remain NULL until an authoritative reingest or
-- recovery writes a valid receipt.

ALTER TABLE documents ADD COLUMN provenance_receipt_version INTEGER
  CHECK (provenance_receipt_version IS NULL OR provenance_receipt_version = 1);
ALTER TABLE documents ADD COLUMN provenance_receipt_status TEXT
  CHECK (provenance_receipt_status IS NULL OR provenance_receipt_status IN ('complete','partial','unavailable'));
ALTER TABLE documents ADD COLUMN provenance_receipt_reason TEXT
  CHECK (provenance_receipt_reason IS NULL OR provenance_receipt_reason IN (
    'lineage_and_text_recorded',
    'text_provenance_unavailable',
    'lineage_unavailable',
    'provenance_unavailable'
  ));
ALTER TABLE documents ADD COLUMN provenance_receipt_digest TEXT
  CHECK (provenance_receipt_digest IS NULL OR (
    length(provenance_receipt_digest) = 64
    AND lower(provenance_receipt_digest) NOT GLOB '*[^0-9a-f]*'
  ));

-- Application writes replace the marker together with any provenance-bearing
-- field. A later low-level edit that changes those fields but leaves the old
-- marker behind is demoted to unassessed instead of inheriting stale proof.
CREATE TRIGGER IF NOT EXISTS documents_provenance_assessment_invalidate_au
AFTER UPDATE OF source, source_id, text_source, text_reliable, meta ON documents
WHEN NEW.provenance_receipt_digest IS OLD.provenance_receipt_digest
 AND (
   NEW.source IS NOT OLD.source
   OR NEW.source_id IS NOT OLD.source_id
   OR NEW.text_source IS NOT OLD.text_source
   OR NEW.text_reliable IS NOT OLD.text_reliable
   OR json_extract(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.provenance_receipt')
      IS NOT json_extract(CASE WHEN json_valid(OLD.meta) THEN OLD.meta ELSE '{}' END, '$.provenance_receipt')
   OR json_extract(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.evidence_lineage')
      IS NOT json_extract(CASE WHEN json_valid(OLD.meta) THEN OLD.meta ELSE '{}' END, '$.evidence_lineage')
   OR json_extract(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.family_of')
      IS NOT json_extract(CASE WHEN json_valid(OLD.meta) THEN OLD.meta ELSE '{}' END, '$.family_of')
   OR json_extract(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.part_of')
      IS NOT json_extract(CASE WHEN json_valid(OLD.meta) THEN OLD.meta ELSE '{}' END, '$.part_of')
 )
BEGIN
  UPDATE documents
     SET provenance_receipt_version = NULL,
         provenance_receipt_status = NULL,
         provenance_receipt_reason = NULL,
         provenance_receipt_digest = NULL
   WHERE doc_uid = NEW.doc_uid;
END;
