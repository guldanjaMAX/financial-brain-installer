/**
 * The source statements must stay cheap enough for a whole corpus to fit.
 *
 * `brain sources` failed in the field with an opaque 503 on a large brain: the
 * inventory and recovery statements pushed every live document's `meta` JSON
 * through three corpus-sized materialised CTEs and every chunk's full text
 * through the sorter that counted chunks, so D1 aborted them while strictly
 * heavier aggregates over the same rows still completed. Four tests hold that
 * repair. The first proves the rewritten statements return rows byte-identical
 * to the shipped 0.4.8 SQL, which is kept verbatim below so the comparison is
 * against what actually failed rather than against the code under test. The
 * second reads the recovery statement's query plan and requires it to walk the
 * corpus once, which is what its `MATERIALIZED` hints buy and what their loss
 * costs. The third proves the statements' cost no longer moves when chunk text
 * grows from a token to the product's own chunk size. The fourth bounds them on
 * the corpus shape that failed — 200,000 documents and 1.8 million chunks — in
 * memory and, for recovery, in wall-clock, and bounds the memory slope between
 * that size and a smaller one, so the bound cannot be met by a lucky fixed
 * overhead at one comfortable corpus size.
 *
 * The first two tests run everywhere. The other two measure memory as a
 * resident-set delta, which reads as cost only where the allocator leaves the
 * freed pages mapped — of the three platforms CI runs, darwin alone; see
 * MEMORY_COST_IS_MEASURABLE for what runs instead where it does not, and why
 * there is nothing portable to measure.
 *
 * Every fixture here is synthetic.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { splitStatements } from "../../brain.mjs";
import {
  normalizeIngestEnvelopeProvenance,
  provenanceAssessmentMarker,
} from "../src/lib/provenance-receipt.js";
import {
  sourceInventorySql,
  sourceRecoveryPlan,
  sourceRecoverySql,
  sourceRecoverySummarySql,
} from "../src/lib/store-d1.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "migrations", "d1");

// Nine source names, one of them unregistered, covering the identity alphabet
// the inventory validates: plain, hyphenated, underscored, and digit-bearing.
const SOURCE_NAMES = Object.freeze([
  "calendar", "curated", "drive", "gmail", "imessage",
  "message", "private-ids", "whatsapp", "orphan_source9",
]);

/**
 * The source-inventory statement exactly as 0.4.8 shipped it, expanded.
 *
 * Kept here, never in `worker/src`, so the byte-identity comparison above is
 * against the statement that failed in the field. Do not regenerate it from
 * the code under test: a snapshot taken from the fix proves nothing.
 */
const ORIGINAL_SOURCE_INVENTORY_SQL = `

  WITH live_documents AS MATERIALIZED (
    SELECT d.rowid AS document_rowid,
           d.doc_uid,
           d.source AS physical_source,
           d.source_id,
           d.ingested_at,
           d.meta,
           d.text_source,
           d.text_reliable,
           d.provenance_receipt_version,
           d.provenance_receipt_status,
           d.provenance_receipt_reason,
           d.provenance_receipt_digest,
           CASE WHEN
  d.provenance_receipt_version = 1
  AND d.provenance_receipt_status IN ('complete','partial','unavailable')
  AND (
    (d.provenance_receipt_status = 'complete' AND d.provenance_receipt_reason = 'lineage_and_text_recorded')
    OR (d.provenance_receipt_status = 'partial' AND d.provenance_receipt_reason IN ('text_provenance_unavailable','lineage_unavailable'))
    OR (d.provenance_receipt_status = 'unavailable' AND d.provenance_receipt_reason = 'provenance_unavailable')
  )
  AND length(COALESCE(d.provenance_receipt_digest,'')) = 64
  AND d.provenance_receipt_digest = lower(d.provenance_receipt_digest)
  AND lower(d.provenance_receipt_digest) NOT GLOB '*[^0-9a-f]*'
  AND json_valid(d.meta)
  AND json_type(d.meta,'$.provenance_receipt') = 'object'
  AND json_extract(d.meta,'$.provenance_receipt.version') = d.provenance_receipt_version
  AND json_extract(d.meta,'$.provenance_receipt.status') = d.provenance_receipt_status
  AND json_extract(d.meta,'$.provenance_receipt.reason') = d.provenance_receipt_reason
THEN 1 ELSE 0 END AS provenance_marker_valid,
           CASE
  WHEN (CASE WHEN
  d.provenance_receipt_version = 1
  AND d.provenance_receipt_status IN ('complete','partial','unavailable')
  AND (
    (d.provenance_receipt_status = 'complete' AND d.provenance_receipt_reason = 'lineage_and_text_recorded')
    OR (d.provenance_receipt_status = 'partial' AND d.provenance_receipt_reason IN ('text_provenance_unavailable','lineage_unavailable'))
    OR (d.provenance_receipt_status = 'unavailable' AND d.provenance_receipt_reason = 'provenance_unavailable')
  )
  AND length(COALESCE(d.provenance_receipt_digest,'')) = 64
  AND d.provenance_receipt_digest = lower(d.provenance_receipt_digest)
  AND lower(d.provenance_receipt_digest) NOT GLOB '*[^0-9a-f]*'
  AND json_valid(d.meta)
  AND json_type(d.meta,'$.provenance_receipt') = 'object'
  AND json_extract(d.meta,'$.provenance_receipt.version') = d.provenance_receipt_version
  AND json_extract(d.meta,'$.provenance_receipt.status') = d.provenance_receipt_status
  AND json_extract(d.meta,'$.provenance_receipt.reason') = d.provenance_receipt_reason
THEN 1 ELSE 0 END) = 1
   AND json_valid(d.meta)
   AND json_type(d.meta,'$.family_of') = 'text'
   AND length(json_extract(d.meta,'$.family_of')) > 0
    THEN json_extract(d.meta,'$.family_of')
  WHEN (CASE WHEN
  d.provenance_receipt_version = 1
  AND d.provenance_receipt_status IN ('complete','partial','unavailable')
  AND (
    (d.provenance_receipt_status = 'complete' AND d.provenance_receipt_reason = 'lineage_and_text_recorded')
    OR (d.provenance_receipt_status = 'partial' AND d.provenance_receipt_reason IN ('text_provenance_unavailable','lineage_unavailable'))
    OR (d.provenance_receipt_status = 'unavailable' AND d.provenance_receipt_reason = 'provenance_unavailable')
  )
  AND length(COALESCE(d.provenance_receipt_digest,'')) = 64
  AND d.provenance_receipt_digest = lower(d.provenance_receipt_digest)
  AND lower(d.provenance_receipt_digest) NOT GLOB '*[^0-9a-f]*'
  AND json_valid(d.meta)
  AND json_type(d.meta,'$.provenance_receipt') = 'object'
  AND json_extract(d.meta,'$.provenance_receipt.version') = d.provenance_receipt_version
  AND json_extract(d.meta,'$.provenance_receipt.status') = d.provenance_receipt_status
  AND json_extract(d.meta,'$.provenance_receipt.reason') = d.provenance_receipt_reason
THEN 1 ELSE 0 END) = 1
   AND json_valid(d.meta)
   AND json_type(d.meta,'$.part_of') = 'text'
   AND length(json_extract(d.meta,'$.part_of')) > 0
    THEN CASE
      WHEN substr(json_extract(d.meta,'$.part_of'), 1, length(d.source) + 1) = d.source || ':'
        THEN json_extract(d.meta,'$.part_of')
      ELSE d.source || ':' || json_extract(d.meta,'$.part_of')
    END
  ELSE d.doc_uid
END AS family_doc_uid
      FROM documents d
     WHERE d.deleted_at IS NULL
  ),
  attributed_documents AS MATERIALIZED (
    SELECT live_documents.*,
           CASE
             WHEN instr(family_doc_uid, ':') BETWEEN 2 AND 65
              AND substr(family_doc_uid, 1, instr(family_doc_uid, ':') - 1) GLOB '[a-z0-9]*'
              AND substr(family_doc_uid, 1, instr(family_doc_uid, ':') - 1) NOT GLOB '*[^a-z0-9_-]*'
               THEN substr(family_doc_uid, 1, instr(family_doc_uid, ':') - 1)
             ELSE physical_source
           END AS inventory_source
      FROM live_documents
  ),
  chunk_per_document AS (
    SELECT a.doc_uid,
           COUNT(c.chunk_uid) AS chunk_count,
           COALESCE(SUM(CASE WHEN trim(c.text) != '' THEN 1 ELSE 0 END),0) AS nonblank_chunk_count
      FROM attributed_documents a
      LEFT JOIN chunks c ON c.doc_uid=a.doc_uid
     GROUP BY a.doc_uid
  ),
  document_flags AS MATERIALIZED (
    SELECT a.*,
           COALESCE(c.chunk_count,0) AS chunk_count,
           COALESCE(c.nonblank_chunk_count,0) AS nonblank_chunk_count,
           CASE WHEN a.provenance_marker_valid=1 AND trim(COALESCE(a.source_id,'')) != '' THEN 1 ELSE 0 END AS has_source_identity,
           CASE WHEN a.provenance_marker_valid=1
                     AND lower(COALESCE(a.text_source,'')) IN ('native','ocr','ocr_partial') THEN 1 ELSE 0 END AS has_extraction_method,
           CASE WHEN a.provenance_marker_valid=1
                     AND lower(COALESCE(a.text_source,'')) IN ('native','ocr','ocr_partial')
                     AND a.text_reliable IN (0,1) THEN 1 ELSE 0 END AS has_text_reliability,
           CASE WHEN a.provenance_marker_valid=1 AND json_valid(a.meta)
                     AND json_type(a.meta,'$.evidence_lineage')='object' THEN 1 ELSE 0 END AS declared_lineage,
           CASE WHEN a.provenance_marker_valid=1 THEN CASE WHEN
  json_valid(meta)
  AND json_type(meta,'$.evidence_lineage') = 'object'
  AND json_type(meta,'$.evidence_lineage.version') = 'integer'
  AND json_extract(meta,'$.evidence_lineage.version') = 1
  AND json_type(meta,'$.evidence_lineage.kind') = 'text'
  AND json_extract(meta,'$.evidence_lineage.kind') IN ('source_record','derived_record','agent_derived')
  AND NOT EXISTS (
    SELECT 1 FROM json_each(json_extract(meta,'$.evidence_lineage')) lineage_field
     WHERE lineage_field.key NOT IN ('version','kind','root_ids')
  )
  AND (
    json_type(meta,'$.evidence_lineage.root_ids') IS NULL
    OR (
      json_type(meta,'$.evidence_lineage.root_ids') = 'array'
      AND json_array_length(json_extract(meta,'$.evidence_lineage.root_ids')) <= 16
      AND NOT EXISTS (
        SELECT 1 FROM json_each(json_extract(meta,'$.evidence_lineage.root_ids')) lineage_root
         WHERE lineage_root.type != 'text'
            OR length(trim(lineage_root.value)) = 0
            OR length(lineage_root.value) > 512
      )
    )
  )
  AND (
    json_extract(meta,'$.evidence_lineage.kind') != 'derived_record'
    OR (
      json_type(meta,'$.evidence_lineage.root_ids') = 'array'
      AND json_array_length(json_extract(meta,'$.evidence_lineage.root_ids')) > 0
    )
  )
  AND (
    json_extract(meta,'$.evidence_lineage.kind') != 'source_record'
    OR json_type(meta,'$.evidence_lineage.root_ids') IS NULL
    OR json_array_length(json_extract(meta,'$.evidence_lineage.root_ids')) <= 1
  )
THEN 1 ELSE 0 END ELSE 0 END AS recognized_lineage,
           CASE WHEN a.provenance_marker_valid=1 AND json_valid(a.meta) AND (
             (json_type(a.meta,'$.family_of')='text' AND length(trim(json_extract(a.meta,'$.family_of'))) > 0)
             OR (json_type(a.meta,'$.part_of')='text' AND length(trim(json_extract(a.meta,'$.part_of'))) > 0)
           ) THEN 1 ELSE 0 END AS family_lineage,
           CASE WHEN a.provenance_marker_valid=1 AND (
             a.provenance_receipt_status='complete'
             OR a.provenance_receipt_reason='text_provenance_unavailable'
           ) THEN 1 ELSE 0 END AS has_lineage
      FROM attributed_documents a
      LEFT JOIN chunk_per_document c ON c.doc_uid=a.doc_uid
  ),
  source_names AS (
    SELECT name FROM sources
    UNION
    SELECT inventory_source AS name FROM attributed_documents
  ),
  document_rollup AS (
    SELECT inventory_source AS source,
           COUNT(*) AS physical_documents,
           COUNT(DISTINCT family_doc_uid) AS logical_documents,
           MIN(ingested_at) AS first_stored_ingest_at,
           MAX(ingested_at) AS last_stored_ingest_at,
           SUM(chunk_count) AS chunks,
           SUM(CASE WHEN nonblank_chunk_count > 0 THEN 1 ELSE 0 END) AS readable_documents,
           SUM(CASE WHEN nonblank_chunk_count = 0 THEN 1 ELSE 0 END) AS unreadable_documents,
           SUM(CASE WHEN chunk_count = 0 THEN 1 ELSE 0 END) AS empty_documents,
           SUM(CASE WHEN chunk_count > 0 AND nonblank_chunk_count = 0 THEN 1 ELSE 0 END) AS blank_only_documents,
           SUM(CASE WHEN has_text_reliability=1 AND text_reliable=1 THEN 1 ELSE 0 END) AS text_reliable_documents,
           SUM(CASE WHEN has_text_reliability=1 AND text_reliable=0 THEN 1 ELSE 0 END) AS text_unreliable_documents,
           SUM(CASE WHEN has_text_reliability=0 THEN 1 ELSE 0 END) AS text_reliability_unknown_documents,
           SUM(CASE WHEN has_extraction_method=1 AND lower(COALESCE(text_source,''))='native' THEN 1 ELSE 0 END) AS native_text_documents,
           SUM(CASE WHEN has_extraction_method=1 AND lower(COALESCE(text_source,''))='ocr' THEN 1 ELSE 0 END) AS ocr_documents,
           SUM(CASE WHEN has_extraction_method=1 AND lower(COALESCE(text_source,''))='ocr_partial' THEN 1 ELSE 0 END) AS ocr_partial_documents,
           SUM(CASE WHEN has_extraction_method=0 THEN 1 ELSE 0 END) AS unknown_text_source_documents,
           SUM(CASE WHEN nonblank_chunk_count=0 AND (has_extraction_method=0
                     OR lower(COALESCE(text_source,'')) NOT IN ('ocr','ocr_partial')) THEN 1 ELSE 0 END) AS likely_ocr_candidates,
           SUM(CASE WHEN nonblank_chunk_count=0 AND has_extraction_method=1
                     AND lower(COALESCE(text_source,'')) IN ('ocr','ocr_partial') THEN 1 ELSE 0 END) AS ocr_retry_candidates,
           SUM(has_source_identity) AS source_identity_documents,
           SUM(CASE WHEN provenance_marker_valid=0 THEN 1 ELSE 0 END) AS unassessed_provenance_documents,
           SUM(declared_lineage) AS declared_lineage_documents,
           SUM(recognized_lineage) AS recognized_lineage_documents,
           SUM(CASE WHEN declared_lineage=1 AND recognized_lineage=0 THEN 1 ELSE 0 END) AS unrecognized_lineage_documents,
           SUM(family_lineage) AS family_lineage_documents,
           SUM(has_lineage) AS recorded_lineage_documents,
           SUM(CASE WHEN provenance_marker_valid=1 AND provenance_receipt_status='complete'
                    THEN 1 ELSE 0 END) AS complete_provenance_documents,
           SUM(CASE WHEN nonblank_chunk_count=0
                     OR (has_extraction_method=1 AND lower(COALESCE(text_source,''))='ocr_partial')
                     OR provenance_marker_valid=0
                     OR has_source_identity=0 OR has_extraction_method=0 OR has_text_reliability=0
                     OR has_lineage=0
                     OR (declared_lineage=1 AND recognized_lineage=0)
                    THEN 1 ELSE 0 END) AS recovery_candidate_documents
      FROM document_flags
     GROUP BY inventory_source
  ),
  source_events_rollup AS (
    SELECT source_name AS source,
           MIN(CASE WHEN event='ingest' THEN at END) AS first_ingest_event_at,
           MAX(CASE WHEN event='ingest' THEN at END) AS last_ingest_event_at
      FROM source_events
     GROUP BY source_name
  ),
  run_rollup AS (
    SELECT source,
           MIN(started_at) AS first_run_started_at,
           -- A bounded run may successfully ingest every item it attempted
           -- without proving a whole-source walk. Keep that operational
           -- success distinct from the latest-run and history-completeness
           -- fields below, while never advancing it past measured loss.
           MAX(CASE WHEN finished_at IS NOT NULL AND error IS NULL AND refusal_reason IS NULL
                         AND COALESCE(docs_refused,0)=0 AND COALESCE(docs_failed,0)=0
                    THEN finished_at END) AS last_successful_run_at
      FROM sync_runs
     GROUP BY source
  ),
  latest_runs AS (
    SELECT source,lane,started_at,finished_at,walk_complete,files_seen,
           docs_added,docs_updated,docs_unchanged,docs_refused,docs_failed,metrics_version,
           confirmed_from,confirmed_through,target_from,target_through,proposed_deletes,
           delete_action,refusal_reason,error,
           failure_evidence
      FROM (
        SELECT sr.*,
               ROW_NUMBER() OVER (
                 PARTITION BY source ORDER BY started_at DESC, run_id DESC
               ) AS source_rank
          FROM sync_runs sr
      )
     WHERE source_rank=1
  )
  SELECT n.name,
         COALESCE(s.kind,'unregistered') AS kind,
         s.zone,
         s.status,
         s.created_at,
         s.last_ingest_at,
         s.last_complete_sweep_at,
         s.scope,
         s.sync_cursor,
         s.cursor_updated_at,
         s.expected_refresh_seconds,
         s.stale_reason,
         s.document_count AS reported_logical_documents,
         CASE WHEN s.name IS NULL THEN 0 ELSE 1 END AS registered,
         COALESCE(d.physical_documents,0) AS physical_documents,
         COALESCE(d.logical_documents,0) AS logical_documents,
         d.first_stored_ingest_at,
         d.last_stored_ingest_at,
         COALESCE(d.readable_documents,0) AS readable_documents,
         COALESCE(d.unreadable_documents,0) AS unreadable_documents,
         COALESCE(d.empty_documents,0) AS empty_documents,
         COALESCE(d.blank_only_documents,0) AS blank_only_documents,
         COALESCE(d.text_reliable_documents,0) AS text_reliable_documents,
         COALESCE(d.text_unreliable_documents,0) AS text_unreliable_documents,
         COALESCE(d.text_reliability_unknown_documents,0) AS text_reliability_unknown_documents,
         COALESCE(d.native_text_documents,0) AS native_text_documents,
         COALESCE(d.ocr_documents,0) AS ocr_documents,
         COALESCE(d.ocr_partial_documents,0) AS ocr_partial_documents,
         COALESCE(d.unknown_text_source_documents,0) AS unknown_text_source_documents,
         COALESCE(d.likely_ocr_candidates,0) AS likely_ocr_candidates,
         COALESCE(d.ocr_retry_candidates,0) AS ocr_retry_candidates,
         COALESCE(d.source_identity_documents,0) AS source_identity_documents,
         COALESCE(d.unassessed_provenance_documents,0) AS unassessed_provenance_documents,
         COALESCE(d.declared_lineage_documents,0) AS declared_lineage_documents,
         COALESCE(d.recognized_lineage_documents,0) AS recognized_lineage_documents,
         COALESCE(d.unrecognized_lineage_documents,0) AS unrecognized_lineage_documents,
         COALESCE(d.family_lineage_documents,0) AS family_lineage_documents,
         COALESCE(d.recorded_lineage_documents,0) AS recorded_lineage_documents,
         COALESCE(d.complete_provenance_documents,0) AS complete_provenance_documents,
         COALESCE(d.recovery_candidate_documents,0) AS recovery_candidate_documents,
         COALESCE(d.chunks,0) AS chunks,
         e.first_ingest_event_at,
         e.last_ingest_event_at,
         rr.first_run_started_at,
         rr.last_successful_run_at,
         r.lane AS run_lane,
         r.started_at AS run_started_at,
         r.finished_at AS run_finished_at,
         r.walk_complete AS run_walk_complete,
         r.files_seen AS run_files_seen,
         r.docs_added AS run_docs_added,
         r.docs_updated AS run_docs_updated,
         r.docs_unchanged AS run_docs_unchanged,
         r.docs_refused AS run_docs_refused,
         r.docs_failed AS run_docs_failed,
         r.metrics_version AS run_metrics_version,
         r.confirmed_from AS run_confirmed_from,
         r.confirmed_through AS run_confirmed_through,
         r.target_from AS run_target_from,
         r.target_through AS run_target_through,
         r.proposed_deletes AS run_proposed_deletes,
         r.delete_action AS run_delete_action,
         r.failure_evidence AS run_failure_evidence,
         CASE
           WHEN r.source IS NULL THEN NULL
           WHEN r.finished_at IS NULL THEN 'in_progress'
           WHEN r.error IS NOT NULL THEN 'failed'
           WHEN r.refusal_reason IS NOT NULL THEN 'refused'
           WHEN COALESCE(r.walk_complete,0)<>1
             OR COALESCE(r.docs_refused,0)>0
             OR COALESCE(r.docs_failed,0)>0 THEN 'partial'
           ELSE 'completed'
         END AS run_outcome,
         CASE WHEN r.error IS NULL THEN 0 ELSE 1 END AS run_had_error,
         CASE WHEN r.refusal_reason IS NULL THEN 0 ELSE 1 END AS run_was_refused,
         COUNT(*) OVER () AS inventory_total
    FROM source_names n
    LEFT JOIN sources s ON s.name=n.name
    LEFT JOIN document_rollup d ON d.source=n.name
    LEFT JOIN source_events_rollup e ON e.source=n.name
    LEFT JOIN run_rollup rr ON rr.source=n.name
    LEFT JOIN latest_runs r ON r.source=n.name
   ORDER BY n.name ASC
   LIMIT ?1`;

/** The source-recovery statement exactly as 0.4.8 shipped it, expanded. */
const ORIGINAL_SOURCE_RECOVERY_SQL = `

  WITH live_documents AS MATERIALIZED (
    SELECT d.rowid AS document_rowid,
           d.doc_uid,
           d.source AS physical_source,
           d.source_id,
           d.ingested_at,
           d.meta,
           d.text_source,
           d.text_reliable,
           d.provenance_receipt_version,
           d.provenance_receipt_status,
           d.provenance_receipt_reason,
           d.provenance_receipt_digest,
           CASE WHEN
  d.provenance_receipt_version = 1
  AND d.provenance_receipt_status IN ('complete','partial','unavailable')
  AND (
    (d.provenance_receipt_status = 'complete' AND d.provenance_receipt_reason = 'lineage_and_text_recorded')
    OR (d.provenance_receipt_status = 'partial' AND d.provenance_receipt_reason IN ('text_provenance_unavailable','lineage_unavailable'))
    OR (d.provenance_receipt_status = 'unavailable' AND d.provenance_receipt_reason = 'provenance_unavailable')
  )
  AND length(COALESCE(d.provenance_receipt_digest,'')) = 64
  AND d.provenance_receipt_digest = lower(d.provenance_receipt_digest)
  AND lower(d.provenance_receipt_digest) NOT GLOB '*[^0-9a-f]*'
  AND json_valid(d.meta)
  AND json_type(d.meta,'$.provenance_receipt') = 'object'
  AND json_extract(d.meta,'$.provenance_receipt.version') = d.provenance_receipt_version
  AND json_extract(d.meta,'$.provenance_receipt.status') = d.provenance_receipt_status
  AND json_extract(d.meta,'$.provenance_receipt.reason') = d.provenance_receipt_reason
THEN 1 ELSE 0 END AS provenance_marker_valid,
           CASE
  WHEN (CASE WHEN
  d.provenance_receipt_version = 1
  AND d.provenance_receipt_status IN ('complete','partial','unavailable')
  AND (
    (d.provenance_receipt_status = 'complete' AND d.provenance_receipt_reason = 'lineage_and_text_recorded')
    OR (d.provenance_receipt_status = 'partial' AND d.provenance_receipt_reason IN ('text_provenance_unavailable','lineage_unavailable'))
    OR (d.provenance_receipt_status = 'unavailable' AND d.provenance_receipt_reason = 'provenance_unavailable')
  )
  AND length(COALESCE(d.provenance_receipt_digest,'')) = 64
  AND d.provenance_receipt_digest = lower(d.provenance_receipt_digest)
  AND lower(d.provenance_receipt_digest) NOT GLOB '*[^0-9a-f]*'
  AND json_valid(d.meta)
  AND json_type(d.meta,'$.provenance_receipt') = 'object'
  AND json_extract(d.meta,'$.provenance_receipt.version') = d.provenance_receipt_version
  AND json_extract(d.meta,'$.provenance_receipt.status') = d.provenance_receipt_status
  AND json_extract(d.meta,'$.provenance_receipt.reason') = d.provenance_receipt_reason
THEN 1 ELSE 0 END) = 1
   AND json_valid(d.meta)
   AND json_type(d.meta,'$.family_of') = 'text'
   AND length(json_extract(d.meta,'$.family_of')) > 0
    THEN json_extract(d.meta,'$.family_of')
  WHEN (CASE WHEN
  d.provenance_receipt_version = 1
  AND d.provenance_receipt_status IN ('complete','partial','unavailable')
  AND (
    (d.provenance_receipt_status = 'complete' AND d.provenance_receipt_reason = 'lineage_and_text_recorded')
    OR (d.provenance_receipt_status = 'partial' AND d.provenance_receipt_reason IN ('text_provenance_unavailable','lineage_unavailable'))
    OR (d.provenance_receipt_status = 'unavailable' AND d.provenance_receipt_reason = 'provenance_unavailable')
  )
  AND length(COALESCE(d.provenance_receipt_digest,'')) = 64
  AND d.provenance_receipt_digest = lower(d.provenance_receipt_digest)
  AND lower(d.provenance_receipt_digest) NOT GLOB '*[^0-9a-f]*'
  AND json_valid(d.meta)
  AND json_type(d.meta,'$.provenance_receipt') = 'object'
  AND json_extract(d.meta,'$.provenance_receipt.version') = d.provenance_receipt_version
  AND json_extract(d.meta,'$.provenance_receipt.status') = d.provenance_receipt_status
  AND json_extract(d.meta,'$.provenance_receipt.reason') = d.provenance_receipt_reason
THEN 1 ELSE 0 END) = 1
   AND json_valid(d.meta)
   AND json_type(d.meta,'$.part_of') = 'text'
   AND length(json_extract(d.meta,'$.part_of')) > 0
    THEN CASE
      WHEN substr(json_extract(d.meta,'$.part_of'), 1, length(d.source) + 1) = d.source || ':'
        THEN json_extract(d.meta,'$.part_of')
      ELSE d.source || ':' || json_extract(d.meta,'$.part_of')
    END
  ELSE d.doc_uid
END AS family_doc_uid
      FROM documents d
     WHERE d.deleted_at IS NULL
  ),
  attributed_documents AS MATERIALIZED (
    SELECT live_documents.*,
           CASE
             WHEN instr(family_doc_uid, ':') BETWEEN 2 AND 65
              AND substr(family_doc_uid, 1, instr(family_doc_uid, ':') - 1) GLOB '[a-z0-9]*'
              AND substr(family_doc_uid, 1, instr(family_doc_uid, ':') - 1) NOT GLOB '*[^a-z0-9_-]*'
               THEN substr(family_doc_uid, 1, instr(family_doc_uid, ':') - 1)
             ELSE physical_source
           END AS inventory_source
      FROM live_documents
  ),
  chunk_per_document AS (
    SELECT a.doc_uid,
           COUNT(c.chunk_uid) AS chunk_count,
           COALESCE(SUM(CASE WHEN trim(c.text) != '' THEN 1 ELSE 0 END),0) AS nonblank_chunk_count
      FROM attributed_documents a
      LEFT JOIN chunks c ON c.doc_uid=a.doc_uid
     GROUP BY a.doc_uid
  ),
  document_flags AS MATERIALIZED (
    SELECT a.*,
           COALESCE(c.chunk_count,0) AS chunk_count,
           COALESCE(c.nonblank_chunk_count,0) AS nonblank_chunk_count,
           CASE WHEN a.provenance_marker_valid=1 AND trim(COALESCE(a.source_id,'')) != '' THEN 1 ELSE 0 END AS has_source_identity,
           CASE WHEN a.provenance_marker_valid=1
                     AND lower(COALESCE(a.text_source,'')) IN ('native','ocr','ocr_partial') THEN 1 ELSE 0 END AS has_extraction_method,
           CASE WHEN a.provenance_marker_valid=1
                     AND lower(COALESCE(a.text_source,'')) IN ('native','ocr','ocr_partial')
                     AND a.text_reliable IN (0,1) THEN 1 ELSE 0 END AS has_text_reliability,
           CASE WHEN a.provenance_marker_valid=1 AND json_valid(a.meta)
                     AND json_type(a.meta,'$.evidence_lineage')='object' THEN 1 ELSE 0 END AS declared_lineage,
           CASE WHEN a.provenance_marker_valid=1 THEN CASE WHEN
  json_valid(meta)
  AND json_type(meta,'$.evidence_lineage') = 'object'
  AND json_type(meta,'$.evidence_lineage.version') = 'integer'
  AND json_extract(meta,'$.evidence_lineage.version') = 1
  AND json_type(meta,'$.evidence_lineage.kind') = 'text'
  AND json_extract(meta,'$.evidence_lineage.kind') IN ('source_record','derived_record','agent_derived')
  AND NOT EXISTS (
    SELECT 1 FROM json_each(json_extract(meta,'$.evidence_lineage')) lineage_field
     WHERE lineage_field.key NOT IN ('version','kind','root_ids')
  )
  AND (
    json_type(meta,'$.evidence_lineage.root_ids') IS NULL
    OR (
      json_type(meta,'$.evidence_lineage.root_ids') = 'array'
      AND json_array_length(json_extract(meta,'$.evidence_lineage.root_ids')) <= 16
      AND NOT EXISTS (
        SELECT 1 FROM json_each(json_extract(meta,'$.evidence_lineage.root_ids')) lineage_root
         WHERE lineage_root.type != 'text'
            OR length(trim(lineage_root.value)) = 0
            OR length(lineage_root.value) > 512
      )
    )
  )
  AND (
    json_extract(meta,'$.evidence_lineage.kind') != 'derived_record'
    OR (
      json_type(meta,'$.evidence_lineage.root_ids') = 'array'
      AND json_array_length(json_extract(meta,'$.evidence_lineage.root_ids')) > 0
    )
  )
  AND (
    json_extract(meta,'$.evidence_lineage.kind') != 'source_record'
    OR json_type(meta,'$.evidence_lineage.root_ids') IS NULL
    OR json_array_length(json_extract(meta,'$.evidence_lineage.root_ids')) <= 1
  )
THEN 1 ELSE 0 END ELSE 0 END AS recognized_lineage,
           CASE WHEN a.provenance_marker_valid=1 AND json_valid(a.meta) AND (
             (json_type(a.meta,'$.family_of')='text' AND length(trim(json_extract(a.meta,'$.family_of'))) > 0)
             OR (json_type(a.meta,'$.part_of')='text' AND length(trim(json_extract(a.meta,'$.part_of'))) > 0)
           ) THEN 1 ELSE 0 END AS family_lineage,
           CASE WHEN a.provenance_marker_valid=1 AND (
             a.provenance_receipt_status='complete'
             OR a.provenance_receipt_reason='text_provenance_unavailable'
           ) THEN 1 ELSE 0 END AS has_lineage
      FROM attributed_documents a
      LEFT JOIN chunk_per_document c ON c.doc_uid=a.doc_uid
  ),
  candidate_rows AS MATERIALIZED (
    SELECT f.*,
           COALESCE(s.kind,'unregistered') AS source_kind,
           s.zone AS source_zone,
           CASE WHEN s.name IS NULL THEN 0 ELSE 1 END AS registered,
           CASE WHEN f.chunk_count=0 THEN 1 ELSE 0 END AS reason_no_stored_chunks,
           CASE WHEN f.chunk_count>0 AND f.nonblank_chunk_count=0 THEN 1 ELSE 0 END AS reason_blank_only_chunks,
           CASE WHEN f.has_extraction_method=1 AND lower(COALESCE(f.text_source,''))='ocr_partial' THEN 1 ELSE 0 END AS reason_ocr_partial_review,
           CASE WHEN f.provenance_marker_valid=0 THEN 1 ELSE 0 END AS reason_provenance_receipt_unassessed,
           CASE WHEN f.has_extraction_method=0 THEN 1 ELSE 0 END AS reason_extraction_method_missing,
           CASE WHEN f.has_text_reliability=0 THEN 1 ELSE 0 END AS reason_text_reliability_missing,
           CASE WHEN f.has_source_identity=0 THEN 1 ELSE 0 END AS reason_source_record_id_missing,
           CASE WHEN f.has_lineage=0 THEN 1 ELSE 0 END AS reason_derivation_lineage_missing,
           CASE WHEN f.declared_lineage=1 AND f.recognized_lineage=0 THEN 1 ELSE 0 END AS reason_lineage_contract_unrecognized
      FROM document_flags f
      LEFT JOIN sources s ON s.name=f.inventory_source
     WHERE (?1 IS NULL OR f.inventory_source=?1)
       AND (
         f.nonblank_chunk_count=0
         OR (f.has_extraction_method=1 AND lower(COALESCE(f.text_source,''))='ocr_partial')
         OR f.provenance_marker_valid=0
         OR f.has_source_identity=0
         OR f.has_extraction_method=0
         OR f.has_text_reliability=0
         OR f.has_lineage=0
         OR (f.declared_lineage=1 AND f.recognized_lineage=0)
       )
  ),
  source_groups AS MATERIALIZED (
    SELECT inventory_source AS source_id,
           source_kind,
           source_zone AS zone,
           COUNT(*) AS candidate_documents,
           SUM(reason_no_stored_chunks) AS no_stored_chunks,
           SUM(reason_blank_only_chunks) AS blank_only_chunks,
           SUM(reason_ocr_partial_review) AS ocr_partial_review,
           SUM(reason_provenance_receipt_unassessed) AS provenance_receipt_unassessed,
           SUM(reason_extraction_method_missing) AS extraction_method_missing,
           SUM(reason_text_reliability_missing) AS text_reliability_missing,
           SUM(reason_source_record_id_missing) AS source_record_id_missing,
           SUM(reason_derivation_lineage_missing) AS derivation_lineage_missing,
           SUM(reason_lineage_contract_unrecognized) AS lineage_contract_unrecognized
      FROM candidate_rows
     GROUP BY inventory_source,source_kind,source_zone
  ),
  global_summary AS (
    SELECT COUNT(*) AS recovery_total,
           (SELECT COUNT(*) FROM source_groups) AS recovery_source_group_total,
           COALESCE(SUM(reason_no_stored_chunks),0) AS total_no_stored_chunks,
           COALESCE(SUM(reason_blank_only_chunks),0) AS total_blank_only_chunks,
           COALESCE(SUM(reason_ocr_partial_review),0) AS total_ocr_partial_review,
           COALESCE(SUM(reason_provenance_receipt_unassessed),0) AS total_provenance_receipt_unassessed,
           COALESCE(SUM(reason_extraction_method_missing),0) AS total_extraction_method_missing,
           COALESCE(SUM(reason_text_reliability_missing),0) AS total_text_reliability_missing,
           COALESCE(SUM(reason_source_record_id_missing),0) AS total_source_record_id_missing,
           COALESCE(SUM(reason_derivation_lineage_missing),0) AS total_derivation_lineage_missing,
           COALESCE(SUM(reason_lineage_contract_unrecognized),0) AS total_lineage_contract_unrecognized
      FROM candidate_rows
  )
  SELECT candidate_rows.*,
         global_summary.*,
         CASE WHEN candidate_rows.document_rowid=(
           SELECT MIN(next_candidate.document_rowid)
             FROM candidate_rows next_candidate
            WHERE next_candidate.document_rowid>?2
         ) THEN (SELECT json_group_array(json_object(
            'source_id',ordered.source_id,
            'source_kind',ordered.source_kind,
            'zone',ordered.zone,
            'candidate_documents',ordered.candidate_documents,
            'no_stored_chunks',ordered.no_stored_chunks,
            'blank_only_chunks',ordered.blank_only_chunks,
            'ocr_partial_review',ordered.ocr_partial_review,
            'provenance_receipt_unassessed',ordered.provenance_receipt_unassessed,
            'extraction_method_missing',ordered.extraction_method_missing,
            'text_reliability_missing',ordered.text_reliability_missing,
            'source_record_id_missing',ordered.source_record_id_missing,
            'derivation_lineage_missing',ordered.derivation_lineage_missing,
            'lineage_contract_unrecognized',ordered.lineage_contract_unrecognized
          )) FROM (SELECT * FROM source_groups ORDER BY source_id LIMIT 250) ordered)
         ELSE NULL END AS recovery_source_groups
    FROM candidate_rows
    CROSS JOIN global_summary
   WHERE document_rowid>?2
   ORDER BY document_rowid ASC
   LIMIT ?3`;

/** The failure-evidence switch is the only difference between the variants. */
function originalInventorySql({ includeFailureEvidence = true } = {}) {
  if (includeFailureEvidence) return ORIGINAL_SOURCE_INVENTORY_SQL;
  const marker = "\n           failure_evidence\n";
  assert.equal(
    ORIGINAL_SOURCE_INVENTORY_SQL.split(marker).length - 1, 1,
    "the shipped statement selected failure_evidence exactly once",
  );
  return ORIGINAL_SOURCE_INVENTORY_SQL.replace(marker, "\n           NULL AS failure_evidence\n");
}

function migratedDb(label = "scale-fixture") {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort()) {
    for (const statement of splitStatements(readFileSync(join(MIGRATIONS, file), "utf8"))) {
      db.exec(statement);
    }
  }
  db.prepare(
    `INSERT INTO install_state (id,client_slug,product_version,installed_at)
     VALUES (1,?,'0.0.0-test','2026-01-01T00:00:00.000Z')`,
  ).run(label);
  // D1 has no scratch filesystem, so a materialised CTE lives in RAM there.
  // Local SQLite would spill it to a temp file and hide the failure entirely.
  db.exec("PRAGMA temp_store=MEMORY");
  db.exec("PRAGMA cache_size=-2000");
  return db;
}

const INGESTED_AT = Date.parse("2026-09-09T00:00:00.000Z");

async function validMarker(source, sourceId, textSource, textReliable, metadata = {}) {
  const envelope = normalizeIngestEnvelopeProvenance({
    source_type: source,
    source_id: sourceId,
    content: "fixture",
    text_source: textSource,
    text_reliable: textReliable,
    metadata,
  });
  return {
    meta: JSON.stringify(envelope.metadata),
    marker: await provenanceAssessmentMarker(envelope),
  };
}

/**
 * Every document shape the statements branch on, in one corpus.
 *
 * Rows deliberately include unparsable metadata, metadata that is not an
 * object, absent metadata, unassessed pre-0.4.8 provenance, a corrupted
 * receipt digest, `family_of` and `part_of` attribution with and without a
 * source prefix, an attribution prefix that is not a legal source name, every
 * recognised and unrecognised `evidence_lineage` shape, all four text sources,
 * documents with no chunks, with blank-only chunks and with readable chunks,
 * and a deleted document that must stay out of every count.
 */
async function mixedFixture(db) {
  const insertSource = db.prepare(
    `INSERT INTO sources
       (name,kind,status,created_at,last_ingest_at,document_count,
        sync_cursor,cursor_updated_at,scope,
        expected_refresh_seconds,last_complete_sweep_at,stale_reason,zone)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const kinds = ["calendar", "upload", "drive", "gmail", "imessage", "message", "upload", "whatsapp"];
  for (const [index, name] of SOURCE_NAMES.slice(0, 8).entries()) {
    insertSource.run(
      name, kinds[index], index === 3 ? "error" : "ready",
      "2026-08-01T00:00:00.000Z", "2026-09-09T00:00:00.000Z", index,
      index % 2 ? null : `synthetic-cursor-${index}`,
      index % 2 ? null : "2026-09-09T00:01:00.000Z",
      index % 3 ? null : JSON.stringify({ root_folder_ids: [`synthetic-root-${index}`] }),
      index % 2 ? 86400 : null,
      index % 4 ? "2026-09-09T00:00:00.000Z" : null,
      index === 3 ? "AUTH_EXPIRED" : null,
      index % 5 ? null : "books",
    );
  }

  const insertDocument = db.prepare(
    `INSERT INTO documents
       (doc_uid,source,source_id,title,uri,document_date,date_source,date_reliable,
        client,category,ingested_at,content_hash,meta,text_source,text_reliable,
        deleted_at,provenance_receipt_version,provenance_receipt_status,
        provenance_receipt_reason,provenance_receipt_digest)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insertChunk = db.prepare(
    `INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source,title,document_date,client,category)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  const add = (docUid, source, sourceId, meta, textSource, textReliable, marker, {
    deletedAt = null, chunks = [],
  } = {}) => {
    insertDocument.run(
      docUid, source, sourceId, `Synthetic ${docUid}`, null,
      Date.parse("2026-08-01T00:00:00.000Z"), "fixture", 1, null, null,
      INGESTED_AT, `hash-${docUid}`, meta, textSource, textReliable, deletedAt,
      marker?.provenance_receipt_version ?? null,
      marker?.provenance_receipt_status ?? null,
      marker?.provenance_receipt_reason ?? null,
      marker?.provenance_receipt_digest ?? null,
    );
    for (const [index, text] of chunks.entries()) {
      insertChunk.run(`${docUid}#${index}`, docUid, index, text, source, `Synthetic ${docUid}`, 1, null, null);
    }
  };

  // Valid receipts across every lineage and attribution shape.
  const lineageCases = [
    ["source-record", { evidence_lineage: { version: 1, kind: "source_record", root_ids: ["calendar:one"] } }],
    ["source-record-bare", { evidence_lineage: { version: 1, kind: "source_record" } }],
    ["derived-record", { evidence_lineage: { version: 1, kind: "derived_record", root_ids: ["drive:two", "drive:three"] } }],
    ["derived-no-roots", { evidence_lineage: { version: 1, kind: "derived_record", root_ids: [] } }],
    ["agent-derived", { evidence_lineage: { version: 1, kind: "agent_derived", root_ids: ["gmail:four"] } }],
    ["lineage-version-99", { evidence_lineage: { version: 99, kind: "source_record", root_ids: [] } }],
    ["lineage-extra-field", { evidence_lineage: { version: 1, kind: "source_record", root_ids: [], note: "extra" } }],
    ["lineage-too-many-roots", { evidence_lineage: { version: 1, kind: "derived_record", root_ids: Array.from({ length: 17 }, (_, i) => `curated:${i}`) } }],
    ["lineage-blank-root", { evidence_lineage: { version: 1, kind: "derived_record", root_ids: ["   "] } }],
    ["lineage-numeric-root", { evidence_lineage: { version: 1, kind: "derived_record", root_ids: [7] } }],
    ["lineage-not-object", { evidence_lineage: "source_record" }],
    ["family-same-source", { family_of: "calendar:one", evidence_lineage: { version: 1, kind: "source_record", root_ids: ["calendar:one"] } }],
    ["family-other-source", { family_of: "whatsapp:shared", evidence_lineage: { version: 1, kind: "source_record", root_ids: ["whatsapp:shared"] } }],
    ["family-illegal-prefix", { family_of: "Not A Source:x" }],
    ["part-of-prefixed", { part_of: "drive:parent" }],
    ["part-of-bare", { part_of: "parent-record" }],
    ["no-lineage", {}],
  ];
  const textShapes = [
    ["native", true, ["readable text"]],
    ["ocr", false, []],
    ["ocr_partial", false, ["   "]],
    ["native", false, ["readable text", "   "]],
  ];
  for (const [index, [label, metadata]] of lineageCases.entries()) {
    const source = SOURCE_NAMES[index % 8];
    const [textSource, textReliable, chunks] = textShapes[index % textShapes.length];
    const { meta, marker } = await validMarker(source, label, textSource, textReliable, metadata);
    add(`${source}:${label}`, source, label, meta, textSource, textReliable ? 1 : 0, marker, { chunks });
  }

  // Receipts that must never be treated as proven.
  const unprovable = [
    ["unparsable-meta", "{not json", "native", 1, null],
    ["array-meta", JSON.stringify([1, 2, 3]), "native", 1, null],
    ["null-meta", null, "native", 1, null],
    ["empty-meta", "", "ocr", 0, null],
    ["unassessed", JSON.stringify({ evidence_lineage: { version: 1, kind: "source_record" } }), "native", 1, null],
    // The marker columns pass every shape test the SQL can run, but the digest
    // does not match the row: only the shared JS boundary can catch that, so
    // the statement must still report the flags it can actually prove.
    ["digest-mismatch", JSON.stringify({
      provenance_receipt: { version: 1, status: "complete", reason: "lineage_and_text_recorded" },
      evidence_lineage: { version: 1, kind: "source_record", root_ids: ["drive:one"] },
    }), "native", 1, {
      provenance_receipt_version: 1,
      provenance_receipt_status: "complete",
      provenance_receipt_reason: "lineage_and_text_recorded",
      provenance_receipt_digest: "d".repeat(64),
    }],
    ["receipt-column-disagreement", JSON.stringify({
      provenance_receipt: { version: 1, status: "partial", reason: "lineage_unavailable" },
    }), "native", 1, {
      provenance_receipt_version: 1,
      provenance_receipt_status: "complete",
      provenance_receipt_reason: "lineage_and_text_recorded",
      provenance_receipt_digest: "e".repeat(64),
    }],
    ["unknown-text-source", JSON.stringify({ provenance_receipt: { version: 1, status: "complete", reason: "lineage_and_text_recorded" } }), "scanned", 1, {
      provenance_receipt_version: 1,
      provenance_receipt_status: "complete",
      provenance_receipt_reason: "lineage_and_text_recorded",
      provenance_receipt_digest: "b".repeat(64),
    }],
    ["null-text-source", JSON.stringify({ provenance_receipt: { version: 1, status: "unavailable", reason: "provenance_unavailable" } }), null, null, {
      provenance_receipt_version: 1,
      provenance_receipt_status: "unavailable",
      provenance_receipt_reason: "provenance_unavailable",
      provenance_receipt_digest: "c".repeat(64),
    }],
  ];
  for (const [index, [label, meta, textSource, textReliable, marker]] of unprovable.entries()) {
    const source = SOURCE_NAMES[index % SOURCE_NAMES.length];
    add(`${source}:${label}`, source, index === 3 ? "" : label, meta, textSource, textReliable, marker, {
      chunks: index % 3 === 0 ? [] : ["readable text"],
    });
  }

  // A deleted document and an empty-source registration stay out of the counts.
  const deleted = await validMarker("drive", "deleted", "native", true);
  add("drive:deleted", "drive", "deleted", deleted.meta, "native", 1, deleted.marker, {
    deletedAt: INGESTED_AT,
    chunks: ["readable text"],
  });

  const insertRun = db.prepare(
    `INSERT INTO sync_runs
       (run_id,source,lane,started_at,finished_at,walk_complete,files_seen,
        docs_added,docs_updated,docs_unchanged,docs_refused,docs_failed,metrics_version,
        confirmed_from,confirmed_through,target_from,target_through,
        proposed_deletes,delete_action,refusal_reason,error,failure_evidence)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const [index, name] of SOURCE_NAMES.slice(0, 8).entries()) {
    insertRun.run(
      `${name}-older`, name, "sweep",
      Date.parse("2026-09-06T00:00:00.000Z"), Date.parse("2026-09-06T00:01:00.000Z"),
      1, 2, 1, 0, 1, 0, 0, 1,
      "2020-01-01T00:00:00.000Z", "2026-09-06T00:00:00.000Z",
      "2020-01-01T00:00:00.000Z", "2026-09-06T00:00:00.000Z",
      0, "applied", null, null, null,
    );
    insertRun.run(
      `${name}-latest`, name, index % 2 ? "incremental" : "sweep",
      Date.parse("2026-09-09T00:00:00.000Z"),
      index === 7 ? null : Date.parse("2026-09-09T00:01:00.000Z"),
      index % 3 ? 1 : 0, 3, 1, 0, 1, index === 4 ? 2 : 0, index === 5 ? 1 : 0, 1,
      index % 2 ? "2020-01-01T00:00:00.000Z" : null,
      index % 2 ? "2026-09-09T00:00:00.000Z" : null,
      null, null, 0, "applied",
      index === 6 ? "SYNTHETIC_REFUSAL" : null,
      index === 3 ? "SYNTHETIC_ERROR" : null,
      index === 3 ? JSON.stringify({ version: 1, operation_class: "gmail_message_read", http_status: 400 }) : null,
    );
  }

  const insertEvent = db.prepare(
    `INSERT INTO source_events (source_name,event,at,detail) VALUES (?,?,?,?)`,
  );
  for (const [index, name] of SOURCE_NAMES.slice(0, 8).entries()) {
    insertEvent.run(name, "ingest", Date.parse("2026-08-15T00:00:00.000Z") + index, null);
    insertEvent.run(name, "ingest", Date.parse("2026-09-09T00:00:00.000Z") + index, null);
  }
}

const rowsOf = (db, sql, binds) => db.prepare(sql).all(...binds);

test("the rewritten source statements return the shipped 0.4.8 rows byte for byte", async () => {
  const db = migratedDb();
  await mixedFixture(db);

  for (const includeFailureEvidence of [true, false]) {
    const before = rowsOf(db, originalInventorySql({ includeFailureEvidence }), [10001]);
    const after = rowsOf(db, sourceInventorySql({ includeFailureEvidence }), [10001]);
    assert.ok(before.length >= SOURCE_NAMES.length, "the fixture must exercise every source");
    // A comparison of two statements that both report nothing proves nothing,
    // so require the fixture to move every flag the rewrite touched.
    for (const column of [
      "logical_documents", "readable_documents", "unreadable_documents", "empty_documents",
      "blank_only_documents", "ocr_partial_documents", "unknown_text_source_documents",
      "likely_ocr_candidates", "ocr_retry_candidates", "unassessed_provenance_documents",
      "declared_lineage_documents", "recognized_lineage_documents",
      "unrecognized_lineage_documents", "family_lineage_documents",
      "recorded_lineage_documents", "recovery_candidate_documents",
    ]) {
      assert.ok(
        before.reduce((total, row) => total + Number(row[column] || 0), 0) > 0,
        `the fixture never produced a ${column}`,
      );
    }
    assert.equal(
      JSON.stringify(after), JSON.stringify(before),
      `inventory rows changed (failure evidence ${includeFailureEvidence})`,
    );
    assert.deepEqual(Object.keys(after[0]), Object.keys(before[0]), "column order changed");
  }

  const recoveryBinds = [
    [null, 0, 251],
    [null, 0, 4],
    [null, 6, 4],
    ["drive", 0, 251],
    ["gmail", 0, 2],
    ["orphan_source9", 0, 251],
    ["curated", 9999999, 251],
  ];
  for (const binds of recoveryBinds) {
    const before = rowsOf(db, ORIGINAL_SOURCE_RECOVERY_SQL, binds);
    const after = rowsOf(db, sourceRecoverySql, binds);
    const keys = after.length ? Object.keys(after[0]) : [];
    const projectedBefore = before.map((row) => Object.fromEntries(keys.map((key) => [key, row[key]])));
    assert.equal(
      JSON.stringify(after), JSON.stringify(projectedBefore),
      `recovery rows changed for ${JSON.stringify(binds)}`,
    );
    if (after.length) {
      assert.ok("meta" in after[0], "the recovery page still carries the metadata its JS boundary reads");
    }
  }
  for (const source of [null, "drive", "gmail", "orphan_source9", "curated"]) {
    const before = rowsOf(db, ORIGINAL_SOURCE_RECOVERY_SQL, [source, 0, 251]);
    const expected = before.length ? JSON.parse(before[0].recovery_source_groups) : [];
    const after = rowsOf(db, sourceRecoverySummarySql, [source, null, 251]);
    const groupFields = [
      "source_id", "source_kind", "zone", "candidate_documents",
      "no_stored_chunks", "blank_only_chunks", "ocr_partial_review",
      "provenance_receipt_unassessed", "extraction_method_missing",
      "text_reliability_missing", "source_record_id_missing",
      "derivation_lineage_missing", "lineage_contract_unrecognized",
    ];
    const projectedAfter = after.map((row) =>
      Object.fromEntries(groupFields.map((field) => [field, row[field]])));
    assert.equal(
      JSON.stringify(projectedAfter), JSON.stringify(expected),
      `recovery source summary changed for ${source}`,
    );
  }
  assert.ok(
    rowsOf(db, ORIGINAL_SOURCE_RECOVERY_SQL, [null, 0, 251]).length > 10,
    "the fixture must produce recovery candidates to compare",
  );
  db.close();
});

/**
 * The recovery statement must read the corpus once, not four times.
 *
 * `candidate_rows` has four readers — `source_groups`, `global_summary`, the
 * returned page, and the `MIN(document_rowid)` probe that decides which row
 * carries the group summary. Without its `MATERIALIZED` hint SQLite re-derives
 * it from `live_documents` once per reader and rebuilds the automatic covering
 * index over `chunk_per_document` each time. That is what the hints were
 * dropped into, and it is the thing a timing bound cannot reliably catch: on
 * the machine this was measured on, the un-hinted statement cost 2,918 ms cold
 * against 2,367 ms hinted, and would have passed the 3-second bound below.
 * The plan is what actually holds the hints, so the plan is what is asserted.
 *
 * `EXPLAIN QUERY PLAN` is deterministic, needs no corpus, and costs nothing, so
 * this runs on every platform. The fixture is an empty schema-46 database on
 * purpose: SQLite honours an explicit `MATERIALIZED` hint regardless of table
 * size, and the plan below was confirmed identical against the 200,000-document
 * fixture.
 */
test("the recovery plan uses separate one-pass summary and page statements", () => {
  const db = migratedDb("plan-fixture");
  const recoveryPlan = sourceRecoveryPlan({ source: null, afterRowId: 0, limit: 250 });
  assert.equal(recoveryPlan.length, 2);
  const plans = recoveryPlan.map((step) => ({
    kind: step.kind,
    details: db.prepare(`EXPLAIN QUERY PLAN ${step.sql}`).all(...step.binds)
      .map((row) => String(row.detail)),
  }));
  db.close();

  for (const { kind, details } of plans) {
    const corpusPasses = details.filter((detail) => /^(SCAN|SEARCH) live_documents\b/.test(detail));
    assert.ok(
      corpusPasses.length <= 1,
      `${kind} walks live_documents ${corpusPasses.length} times: ${JSON.stringify(corpusPasses)}`,
    );
    const coveringIndexBuilds = details.filter((detail) =>
      detail.includes("AUTOMATIC COVERING INDEX"));
    assert.ok(
      coveringIndexBuilds.length <= 1,
      `${kind} builds ${coveringIndexBuilds.length} automatic covering indexes`,
    );
    for (const cte of ["candidate_rows", "live_documents"]) {
      assert.ok(
        details.includes(`MATERIALIZE ${cte}`),
        `${kind} no longer materialises ${cte}: ${JSON.stringify(details)}`,
      );
    }
  }
});

// The shape that failed in the field: about 200,000 live documents and 1.7
// million chunks, roughly nine chunks per document. Both halves of the cost
// this rewrite removes are corpus-sized, and at a comfortably smaller corpus
// the shipped statements fit as well, so a bound measured there would hold
// whether or not `brain sources` recovers on a real brain.
const FIELD_DOCUMENTS = 200_000;
const SMALL_DOCUMENTS = 50_000;
const SCALE_CHUNKS_PER_DOCUMENT = 9;
const SCALE_META_BYTES = 1000;
// `CHUNK_SIZE` in worker/src/lib/store.js: what one real chunk's text costs.
// The shipped statement pushed every one of them through a sorter.
const PRODUCT_CHUNK_TEXT_BYTES = 1500;
const THIN_CHUNK_TEXT_BYTES = 15;

/*
 * Measured here on a schema-46-shaped SQLite, nine chunks and a kilobyte of
 * metadata per document, resident-set proxy, one child process per statement:
 *
 *   documents   rewritten            shipped 0.4.8
 *      50,000    20 MB /  27 MB      309 MB /  399 MB
 *     200,000    73 MB /  97 MB     1.23 GB / 1.59 GB
 *
 * Both bounds sit below what the same statements cost with only the metadata
 * half of the repair applied — 55/59 MB at 50,000 and 218/233 MB at 200,000 —
 * so losing either half fails this test instead of passing on the other's
 * margin. They are a resident-set proxy, not exact SQLite accounting.
 */
const SMALL_MEMORY_BOUND_BYTES = 48 * 1024 * 1024;
const FIELD_MEMORY_BOUND_BYTES = 192 * 1024 * 1024;
// What remains is linear in documents: 0.35 KB and 0.47 KB per document across
// those two sizes. The slope is asserted as well as the endpoint, so a change
// that moves cost out of a fixed overhead and into the per-document term
// cannot hide inside a single bound.
const MEMORY_PER_DOCUMENT_BOUND_BYTES = 768;
// 30 s at 50,000 documents, 120 s at 200,000. A machine slower than that is
// not one whose memory numbers are worth asserting on.
const SCALE_BUILD_BUDGET_MS_PER_DOCUMENT = 0.6;
const CHUNK_TEXT_DOCUMENTS = 10_000;

/**
 * Where the resident-set proxy means anything, and what runs where it does not.
 *
 * The probe reads `process.memoryUsage().rss` on either side of one `.all()`.
 * That reports what the statement peaked at only where the allocator leaves
 * the sorter's arena mapped in the process until the second reading is taken,
 * which is what macOS libmalloc does. Windows hands large blocks straight back
 * to the OS on free. So does glibc: anything past its mmap threshold is served
 * with `mmap` and released with `munmap`, and that threshold tops out far
 * below what a corpus-sized sorter asks for. On both, the working set is
 * already back where it started by the time the second reading is taken.
 *
 * Two CI runs have now measured it, each across the hundredfold chunk-text
 * step that moves the shipped statement 3.5x on darwin:
 *
 *   35249051915  windows  shipped-inventory   4.10 MB ->  4.60 MB   1.12x
 *   35273588253  ubuntu   shipped-recovery   59.00 MB -> 59.04 MB   1.00x  node 24
 *   35273588253  ubuntu   shipped-recovery   58.88 MB -> 58.78 MB   1.00x  node 22
 *
 * Not less growth on either platform: none, and on node 22 the corpus with a
 * hundred times the chunk text read fractionally lower than the thin one. The
 * control assertion below correctly refused to treat that as proof of
 * anything, on both.
 *
 * There is no portable substitute to switch to. node:sqlite exposes no memory
 * API at all (no `sqlite3_memory_used`, no `sqlite3_status`), and the SQLite it
 * bundles reports `DEFAULT_MEMSTATUS=0` and `SYSTEM_MALLOC` in
 * `PRAGMA compile_options`, so those counters are not collected and its
 * allocations never reach V8's `external` or `arrayBuffers` either. A peak
 * working-set reading (`process.resourceUsage().maxRSS`) should survive the
 * free-back, and the probe now reports one, but no run has yet confirmed that
 * anywhere the free-back happens, and a memory bound nobody has watched hold
 * is not a bound.
 *
 * So the cost assertions run only where the proxy has been watched to carry a
 * cost, which is darwin and nowhere else yet. An allowlist rather than a list
 * of known-bad platforms, on purpose: glibc sat on the good list above until
 * run 35273588253 actually measured it, and a reading nobody has checked is
 * not evidence that it works. That is also why the whole set goes together
 * rather than the control alone. Every other memory assertion here has the
 * form `cost < bound`, and a reading that understates can only make those
 * pass, so on a platform that frees back they would go on quietly passing
 * while measuring nothing — which is worse than not running them.
 *
 * Off darwin the same statements still run against the same fixtures and must
 * still return the same aggregates — every source row, every document, every
 * chunk — within a bounded wall-clock time, and every unasserted number is
 * printed with its reason rather than dropped. What the rewrite is actually
 * for — that the statements return the shipped 0.4.8 rows byte for byte — is
 * asserted on every platform by the first test, and the single corpus pass the
 * repair turns on is asserted on every platform by the second. Neither test
 * touches any of this.
 *
 * `BRAIN_TEST_PLATFORM` exists only so the other branch can be exercised from
 * a development machine; nothing in the product reads it.
 */
const TEST_PLATFORM = process.env.BRAIN_TEST_PLATFORM || process.platform;
const MEMORY_COST_IS_MEASURABLE = TEST_PLATFORM === "darwin";
// A liveness bound, not a cost bound. The rewritten statements take 2.3 s on
// 200,000 documents and 0.1 s on the 10,000-document chunk-text fixture on the
// machine the memory numbers above were measured on, so this allows about 40x
// that: it catches a statement that stopped returning on a field-sized corpus,
// not one that got somewhat more expensive.
const SCALE_STATEMENT_BUDGET_MS_PER_DOCUMENT = 0.5;

/**
 * What the recovery statement may cost in wall-clock at the field corpus.
 *
 * This one is asserted where the memory bounds are, because the field failure
 * it guards was a clock and not the memory ceiling: `brain sources --json
 * --recovery` died at a 28-second client-side abort against the CLI's 30 s
 * `AbortSignal.timeout`, and D1 documents its own maximum query duration at the
 * same 30 seconds. Local wall-clock is not D1 wall-clock, but the only anchor
 * anyone has between them — `sources --json` at 10.5 s live against 0.9–2.9 s
 * for the same statement offline — puts D1 at roughly 3.6x to 11.8x local, so a
 * statement that stays near 1 s here projects to 3.4–11 s there and one that
 * drifts to 3 s here is already racing the clock.
 *
 * Measured on the machine these numbers come from (darwin, Node v24.13.1),
 * 200,000 documents, own process, fixture rebuilt immediately before: recovery
 * 2,367 ms cold and 947 / 946 / 948 ms warm. The bound is set at 3 s — a little
 * over the cold reading and about 3x the warm one — because the probe below
 * runs second on a page cache the inventory probe has already warmed, and
 * because this is a bound on a slow machine's honest work, not a tight
 * regression detector.
 *
 * It is deliberately NOT the guard on the `MATERIALIZED` hints. The un-hinted
 * statement measured 2,918 ms cold and 1,337 / 1,339 / 1,384 ms warm on the
 * same fixture, which this bound would not have caught. The plan assertion in
 * "the recovery statement derives its candidates once" is what catches that.
 */
const FIELD_RECOVERY_MS_BOUND = 3_000;

/**
 * Each statement is measured in its own process.
 *
 * Resident memory does not fall back after a large statement finishes, so two
 * measurements in one process would report the second as nearly free no matter
 * how much it allocated. A fresh child per statement makes the numbers
 * comparable and independent of the order they run in.
 */
const SCALE_PROBE = `
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const [dbPath, sqlPath, bindJson] = process.argv.slice(2);
const db = new DatabaseSync(dbPath, { readOnly: true });
// D1 keeps a materialised CTE in RAM; local SQLite would spill it to a temp
// file and hide the very cost this probe exists to measure.
db.exec("PRAGMA temp_store=MEMORY");
db.exec("PRAGMA cache_size=-2000");
const statement = db.prepare(readFileSync(sqlPath, "utf8"));
const before = process.memoryUsage().rss;
const peakBefore = process.resourceUsage().maxRSS;
const startedAt = Date.now();
const rows = statement.all(...JSON.parse(bindJson));
const ms = Date.now() - startedAt;
const cost = process.memoryUsage().rss - before;
// The high-water reading is reported but never asserted on. It is the evidence
// a run on a platform that frees back leaves behind for whoever wants to
// re-enable the cost assertions there: see MEMORY_COST_IS_MEASURABLE. maxRSS
// is kilobytes.
const peakCost = (process.resourceUsage().maxRSS - peakBefore) * 1024;
// Report what the answer actually counted, so a statement that stayed under
// the bound by returning empty rows cannot pass for one that aggregated the
// whole corpus.
const total = (column) => rows.reduce((sum, row) => sum + Number(row[column] ?? 0), 0);
const inventory = rows.length > 0 && "physical_documents" in rows[0];
const recoverySummary = rows.length > 0 && "candidate_documents" in rows[0];
process.stdout.write(JSON.stringify({
  rows: rows.length,
  cost,
  peakCost,
  ms,
  documents: inventory
    ? total("physical_documents")
    : recoverySummary
      ? total("candidate_documents")
      : rows[0]?.recovery_total !== undefined ? Number(rows[0].recovery_total) : rows.length,
  chunks: inventory ? total("chunks") : null,
}));
`;

/** One probe runner per temporary root; each statement gets its own child. */
function scaleProbe(root) {
  const probePath = join(root, "probe.mjs");
  writeFileSync(probePath, SCALE_PROBE);
  return (label, dbPath, sql, binds) => {
    const sqlPath = join(root, `${label}.sql`);
    writeFileSync(sqlPath, sql);
    const probe = spawnSync(
      process.execPath,
      ["--no-warnings", probePath, dbPath, sqlPath, JSON.stringify(binds)],
      { encoding: "utf8" },
    );
    assert.equal(probe.status, 0, `${label} probe failed: ${probe.stderr}`);
    return JSON.parse(probe.stdout);
  };
}

function buildScaleCorpus(dbPath, { documents, chunkTextBytes }) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=OFF");
  db.exec("PRAGMA synchronous=OFF");
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort()) {
    for (const statement of splitStatements(readFileSync(join(MIGRATIONS, file), "utf8"))) {
      db.exec(statement);
    }
  }
  db.prepare(
    `INSERT INTO install_state (id,client_slug,product_version,installed_at)
     VALUES (1,'scale','0.0.0-test','2026-01-01T00:00:00.000Z')`,
  ).run();
  const kinds = ["calendar", "upload", "drive", "gmail", "imessage", "message", "upload", "whatsapp", "upload"];
  for (const [index, name] of SOURCE_NAMES.entries()) {
    db.prepare(
      `INSERT INTO sources (name,kind,status,created_at,last_ingest_at,document_count)
       VALUES (?,?,'ready','2026-08-01T00:00:00.000Z','2026-09-09T00:00:00.000Z',0)`,
    ).run(name, kinds[index]);
  }
  const insertDocument = db.prepare(
    `INSERT INTO documents
       (doc_uid,source,source_id,title,uri,document_date,date_source,date_reliable,
        client,category,ingested_at,content_hash,meta,text_source,text_reliable)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insertChunk = db.prepare(
    `INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source,title,document_date,client,category)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  const padding = "x".repeat(SCALE_META_BYTES);
  const chunkText = "synthetic chunk text ".repeat(Math.ceil(chunkTextBytes / 21)).slice(0, chunkTextBytes);
  db.exec("BEGIN");
  for (let index = 0; index < documents; index++) {
    const source = SOURCE_NAMES[index % SOURCE_NAMES.length];
    const docUid = `${source}:doc-${index}`;
    // Migration 0039 leaves pre-0.4.8 rows unassessed by design, so an upgraded
    // corpus is entirely recovery candidates. That is the case that failed.
    const meta = JSON.stringify({
      evidence_lineage: { version: 1, kind: "source_record", root_ids: [docUid] },
      padding,
    });
    insertDocument.run(
      docUid, source, `record-${index}`, `Synthetic ${index}`, null,
      Date.parse("2026-08-01T00:00:00.000Z"), "fixture", 1, null, null,
      INGESTED_AT, `hash-${index}`, meta, "native", 1,
    );
    for (let chunk = 0; chunk < SCALE_CHUNKS_PER_DOCUMENT; chunk++) {
      insertChunk.run(
        `${docUid}#${chunk}`, docUid, chunk, chunkText,
        source, `Synthetic ${index}`, 1, null, null,
      );
    }
    // One transaction per 20,000 documents: the whole corpus in one keeps the
    // rollback journal in memory and competes with the measurement it feeds.
    if (index % 20_000 === 19_999) {
      db.exec("COMMIT");
      db.exec("BEGIN");
    }
  }
  db.exec("COMMIT");
  db.close();
}

test("the rewritten source statements no longer pay for chunk text", () => {
  const root = mkdtempSync(join(tmpdir(), "brain-source-inventory-chunk-text-"));
  try {
    const measure = scaleProbe(root);
    const corpora = {};
    for (const [label, chunkTextBytes] of [
      ["thin", THIN_CHUNK_TEXT_BYTES],
      ["product", PRODUCT_CHUNK_TEXT_BYTES],
    ]) {
      const dbPath = join(root, `corpus-${label}.db`);
      buildScaleCorpus(dbPath, { documents: CHUNK_TEXT_DOCUMENTS, chunkTextBytes });
      corpora[label] = dbPath;
    }

    const statements = [
      ["rewritten-inventory", sourceInventorySql(), [10001], true, CHUNK_TEXT_DOCUMENTS],
      ["rewritten-recovery-summary", sourceRecoverySummarySql, [null, null, 251], true, CHUNK_TEXT_DOCUMENTS],
      ["rewritten-recovery-page", sourceRecoverySql, [null, 0, 101], true, 101],
      ["shipped-inventory", originalInventorySql(), [10001], false, CHUNK_TEXT_DOCUMENTS],
      ["shipped-recovery", ORIGINAL_SOURCE_RECOVERY_SQL, [null, 0, 101], false, CHUNK_TEXT_DOCUMENTS],
    ];
    for (const [label, sql, binds, rewritten, expectedDocuments] of statements) {
      const thin = measure(`${label}-thin`, corpora.thin, sql, binds);
      const product = measure(`${label}-product`, corpora.product, sql, binds);
      assert.equal(product.documents, expectedDocuments, `${label} answered a different question`);
      assert.equal(thin.documents, expectedDocuments, `${label} answered a different question`);
      if (!MEMORY_COST_IS_MEASURABLE) {
        // The statements still run against both corpora and are still held to
        // their answers above; only the comparison between the two costs is
        // dropped, because this platform's reading cannot carry it.
        if (rewritten) {
          const budget = CHUNK_TEXT_DOCUMENTS * SCALE_STATEMENT_BUDGET_MS_PER_DOCUMENT;
          assert.ok(
            product.ms < budget,
            `${label} took ${product.ms}ms on ${CHUNK_TEXT_DOCUMENTS} documents at`
            + ` ${PRODUCT_CHUNK_TEXT_BYTES}-byte chunk text, over the ${budget}ms bound`,
          );
        }
        console.log(
          `${TEST_PLATFORM}: ${label} chunk-text cost is measured but not asserted`
          + ` (resident-set delta ${thin.cost} -> ${product.cost} bytes,`
          + ` peak delta ${thin.peakCost} -> ${product.peakCost} bytes,`
          + ` ${thin.ms}ms -> ${product.ms}ms across the`
          + ` ${THIN_CHUNK_TEXT_BYTES} -> ${PRODUCT_CHUNK_TEXT_BYTES} byte step)`,
        );
        continue;
      }
      if (rewritten) {
        // Measured 6.14 MB against 6.21 MB, and 7.98 MB against 8.03 MB: the
        // chunk aggregate now decides the blank test per chunk and forwards
        // two integers, so a hundredfold more chunk text costs nothing.
        assert.ok(
          product.cost <= thin.cost * 1.25,
          `${label} cost ${product.cost} bytes at ${PRODUCT_CHUNK_TEXT_BYTES}-byte chunk text`
          + ` against ${thin.cost} at ${THIN_CHUNK_TEXT_BYTES}: chunk text is reaching memory again`,
        );
      } else {
        // The other direction, so the fixture is known to be able to see the
        // effect at all: the shipped statements grew 3.5x and 2.9x here.
        assert.ok(
          product.cost >= thin.cost * 2,
          `${label} cost ${product.cost} bytes against ${thin.cost}; if chunk text no longer`
          + " moves the shipped statement, this comparison no longer proves anything",
        );
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(`the rewritten source statements stay bounded on ${FIELD_DOCUMENTS} documents`, (t) => {
  const root = mkdtempSync(join(tmpdir(), "brain-source-inventory-scale-"));
  try {
    const measure = scaleProbe(root);
    const costs = new Map();
    for (const documents of [SMALL_DOCUMENTS, FIELD_DOCUMENTS]) {
      const dbPath = join(root, `corpus-${documents}.db`);
      const started = Date.now();
      // Chunk text is thin here on purpose: the test above proves the rewritten
      // statements no longer pay for it, and a field-sized corpus at the
      // product's chunk size would be several gigabytes of fixture.
      buildScaleCorpus(dbPath, { documents, chunkTextBytes: THIN_CHUNK_TEXT_BYTES });
      const buildMs = Date.now() - started;
      if (buildMs > documents * SCALE_BUILD_BUDGET_MS_PER_DOCUMENT) {
        t.skip(`building ${documents} synthetic documents took ${buildMs}ms on this machine`);
        return;
      }

      const bound = documents === FIELD_DOCUMENTS ? FIELD_MEMORY_BOUND_BYTES : SMALL_MEMORY_BOUND_BYTES;
      const measured = new Map();
      for (const [label, sql, binds, expectedRows, expectedDocuments] of [
        ["rewritten-inventory", sourceInventorySql(), [10001], SOURCE_NAMES.length, documents],
        ["rewritten-recovery-summary", sourceRecoverySummarySql, [null, null, 251], SOURCE_NAMES.length, documents],
        ["rewritten-recovery-page", sourceRecoverySql, [null, 0, 101], 101, 101],
      ]) {
        const probe = measure(`${label}-${documents}`, dbPath, sql, binds);
        assert.equal(probe.rows, expectedRows, `${label} answered a different question`);
        assert.equal(probe.documents, expectedDocuments, `${label} answered a different document scope`);
        if (probe.chunks !== null) {
          assert.equal(
            probe.chunks, documents * SCALE_CHUNKS_PER_DOCUMENT,
            `${label} did not count every chunk`,
          );
        }
        if (!MEMORY_COST_IS_MEASURABLE) {
          // Same statement, same field-sized fixture, same answers checked
          // above; what is dropped is the memory bound this platform cannot
          // measure, replaced by the bound it can.
          const budget = documents * SCALE_STATEMENT_BUDGET_MS_PER_DOCUMENT;
          assert.ok(
            probe.ms < budget,
            `${label} took ${probe.ms}ms on ${documents} documents, over the ${budget}ms bound`,
          );
          console.log(
            `${TEST_PLATFORM}: ${label} memory is measured but not asserted on ${documents}`
            + ` documents (resident-set delta ${probe.cost} bytes, peak delta ${probe.peakCost}`
            + ` bytes, ${probe.ms}ms, against the ${bound} byte bound)`,
          );
          continue;
        }
        assert.ok(
          probe.cost < bound,
          `${label} used ${probe.cost} bytes on ${documents} documents, over the ${bound} byte bound`,
        );
        if (label.startsWith("rewritten-recovery-") && documents === FIELD_DOCUMENTS) {
          // See FIELD_RECOVERY_MS_BOUND: the field failure here was a clock,
          // and this is the only place it is measured at the size that failed.
          assert.ok(
            probe.ms < FIELD_RECOVERY_MS_BOUND,
            `${label} took ${probe.ms}ms on ${documents} documents, over the`
            + ` ${FIELD_RECOVERY_MS_BOUND}ms bound. At the 3.6-11.8x D1 multiplier that is`
            + " at or past the 30 s D1 query-duration limit and the CLI's own 30 s abort.",
          );
        }
        // Printed rather than only asserted, so a run leaves the wall-clock
        // numbers behind next to the memory ones.
        console.log(
          `${TEST_PLATFORM}: ${label} on ${documents} documents`
          + ` — resident-set delta ${probe.cost} bytes, ${probe.ms}ms`,
        );
        measured.set(label, probe.cost);
      }
      costs.set(documents, measured);

      if (documents === SMALL_DOCUMENTS) {
        // The shipped statements are measured only at the smaller size. At the
        // field size they want well over a gigabyte — which is the failure
        // itself — and one reproduction is enough to show this fixture still
        // exercises what broke.
        for (const [label, sql, binds] of [
          ["shipped-inventory", originalInventorySql(), [10001]],
          ["shipped-recovery", ORIGINAL_SOURCE_RECOVERY_SQL, [null, 0, 101]],
        ]) {
          const probe = measure(`${label}-${documents}`, dbPath, sql, binds);
          if (!MEMORY_COST_IS_MEASURABLE) {
            console.log(
              `${TEST_PLATFORM}: ${label} is measured but not asserted on ${documents}`
              + ` documents (resident-set delta ${probe.cost} bytes, peak delta`
              + ` ${probe.peakCost} bytes, ${probe.ms}ms, against the ${bound} byte bound`
              + " it is expected to exceed)",
            );
            continue;
          }
          assert.ok(
            probe.cost > bound,
            `${label} used ${probe.cost} bytes and was expected to exceed the bound;`
            + " if the shipped statement now fits, this regression test no longer proves anything",
          );
        }
      }
      // Each corpus is removed before the next is built: the pair would
      // otherwise hold more than a gigabyte of fixture on disk at once.
      rmSync(dbPath, { force: true });
    }

    if (!MEMORY_COST_IS_MEASURABLE) {
      console.log(
        `${TEST_PLATFORM}: the per-document memory slope between ${SMALL_DOCUMENTS} and`
        + ` ${FIELD_DOCUMENTS} documents is not asserted, for the same reason as the`
        + " endpoints above; the statements ran and answered on both corpora",
      );
      return;
    }
    for (const label of [
      "rewritten-inventory", "rewritten-recovery-summary", "rewritten-recovery-page",
    ]) {
      const growth = costs.get(FIELD_DOCUMENTS).get(label) - costs.get(SMALL_DOCUMENTS).get(label);
      const perDocument = growth / (FIELD_DOCUMENTS - SMALL_DOCUMENTS);
      assert.ok(
        perDocument < MEMORY_PER_DOCUMENT_BOUND_BYTES,
        `${label} grew ${perDocument.toFixed(1)} bytes per document between ${SMALL_DOCUMENTS}`
        + ` and ${FIELD_DOCUMENTS}, over the ${MEMORY_PER_DOCUMENT_BOUND_BYTES} byte slope bound`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
