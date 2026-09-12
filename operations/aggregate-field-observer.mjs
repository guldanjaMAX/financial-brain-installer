/**
 * Privacy-safe progress observer for the disposable recovery bootstrap.
 *
 * The module deliberately owns no provider client, credential resolver,
 * retry loop, clock, filesystem path, or mutation callback. A reviewed field
 * adapter supplies three narrow read functions. The D1 read receives one
 * fixed SELECT whose result contains counts and ordinal positions only. Raw
 * chunk cursors, batch cursors, mutation ids, errors, paths, and source data
 * never cross this boundary.
 */

export const AGGREGATE_FIELD_OBSERVER_SCHEMA_VERSION = 1;
export const AGGREGATE_FIELD_OBSERVER_KIND = "disposable_bootstrap_aggregate_observation";

const SHA256_RE = /^[0-9a-f]{64}$/;
const BOOTSTRAP_PHASES = new Set(["building", "waiting", "complete"]);
const PROJECTION_STATES = new Set(["bootstrap_required", "pending", "verified"]);
const PROJECTION_STATE_ORDER = Object.freeze({
  bootstrap_required: 0,
  pending: 1,
  verified: 2,
});

const D1_ROW_FIELDS = Object.freeze([
  "projection_status",
  "bootstrap_protocol",
  "epoch",
  "base_count",
  "cursor_set",
  "high_water_set",
  "cursor_position",
  "high_water_position",
  "cursor_valid",
  "high_water_valid",
  "cursor_not_after_high_water",
  "high_water_matches_max",
  "cursor_matches_batch_end",
  "documents",
  "chunks",
  "fts",
  "all_batches",
  "current_batches",
  "queued_batches",
  "submitted_batches",
  "confirmed_batches",
  "failed_batches",
  "batch_rows_total",
  "queued_batch_rows",
  "submitted_batch_rows",
  "confirmed_batch_rows",
  "batch_start_position",
  "batch_end_position",
  "batch_sequence_valid",
  "batch_chain_breaks",
  "batch_row_mismatches",
  "foreign_batches",
  "outbox_pending",
  "outbox_queued",
  "outbox_submitted",
  "outbox_failed",
  "outbox_retrying",
  "foreign_outbox",
  "non_upsert_outbox",
  "projection_fence_pending",
]);

const BOOTSTRAP_RECEIPT_FIELDS = Object.freeze([
  "protocol",
  "phase",
  "epoch",
  "total",
  "confirmed",
  "queued",
  "submitted",
  "remaining",
  "in_flight_batches",
  "failed",
  "retrying",
  "complete",
  "vector_ready",
  "expected_vectors",
  "actual_vectors",
]);

const OBSERVATION_FIELDS = Object.freeze([
  "schema_version",
  "kind",
  "aggregate_only",
  "read_only",
  "target_identity_fingerprint",
  "bootstrap",
  "batches",
  "outbox",
  "d1",
  "vectorize",
  "complete",
]);
const BOOTSTRAP_OUTPUT_FIELDS = Object.freeze([
  "protocol",
  "phase",
  "projection_status",
  "epoch",
  "cursor_position",
  "high_water_position",
  "total",
  "confirmed",
  "remaining",
  "retrying",
  "complete",
]);
const BATCH_OUTPUT_FIELDS = Object.freeze([
  "epoch",
  "total",
  "queued",
  "submitted",
  "confirmed",
  "failed",
  "rows_total",
  "rows_queued",
  "rows_submitted",
  "rows_confirmed",
]);
const OUTBOX_OUTPUT_FIELDS = Object.freeze([
  "pending",
  "queued",
  "submitted",
  "failed",
  "retrying",
]);
const D1_OUTPUT_FIELDS = Object.freeze(["documents", "chunks", "fts"]);
const VECTOR_OUTPUT_FIELDS = Object.freeze(["expected", "actual", "ready"]);

const EXPECTED_FIELDS = Object.freeze([
  "target_identity_fingerprint",
  "documents",
  "chunks",
  "fts",
]);
const VALIDATION_INPUT_FIELDS = Object.freeze([
  "expected",
  "observedIdentityFingerprint",
  "bootstrapReceipt",
  "d1Row",
  "vectorize",
  "previous",
]);
const FACTORY_FIELDS = Object.freeze([
  "expected",
  "readIdentityAggregate",
  "readD1Aggregate",
  "readVectorizeAggregate",
]);

/**
 * One aggregate-only D1 statement. Cursor values participate in comparisons
 * inside D1 but are never selected. The ordinal checks also prove that every
 * durable batch is contiguous and covers the number of rows it claims.
 */
export const AGGREGATE_FIELD_OBSERVER_D1_SQL = `WITH
  observer_state AS (
    SELECT vector_projection_status AS projection_status,
           vector_projection_bootstrap_protocol AS bootstrap_protocol,
           vector_projection_bootstrap_epoch AS epoch,
           vector_projection_bootstrap_base_count AS base_count,
           vector_projection_bootstrap_cursor AS cursor_value,
           vector_projection_bootstrap_high_water AS high_water_value,
           CASE WHEN vector_projection_mutation_id IS NULL THEN 0 ELSE 1 END AS projection_fence_pending
      FROM install_state
     WHERE id = 1
  ),
  current_batches AS (
    SELECT b.epoch, b.batch_no, b.start_cursor, b.end_cursor, b.row_count, b.status
      FROM vector_bootstrap_batches b
      JOIN observer_state s ON b.epoch = s.epoch
  )
SELECT s.projection_status,
       s.bootstrap_protocol,
       s.epoch,
       s.base_count,
       CASE WHEN s.cursor_value IS NULL THEN 0 ELSE 1 END AS cursor_set,
       CASE WHEN s.high_water_value IS NULL THEN 0 ELSE 1 END AS high_water_set,
       (SELECT COUNT(*) FROM chunks c WHERE s.cursor_value IS NOT NULL AND c.chunk_uid <= s.cursor_value) AS cursor_position,
       (SELECT COUNT(*) FROM chunks c WHERE s.high_water_value IS NOT NULL AND c.chunk_uid <= s.high_water_value) AS high_water_position,
       CASE WHEN s.cursor_value IS NULL OR EXISTS (SELECT 1 FROM chunks c WHERE c.chunk_uid = s.cursor_value) THEN 1 ELSE 0 END AS cursor_valid,
       CASE WHEN s.high_water_value IS NULL OR EXISTS (SELECT 1 FROM chunks c WHERE c.chunk_uid = s.high_water_value) THEN 1 ELSE 0 END AS high_water_valid,
       CASE WHEN s.cursor_value IS NULL OR (s.high_water_value IS NOT NULL AND s.cursor_value <= s.high_water_value) THEN 1 ELSE 0 END AS cursor_not_after_high_water,
       CASE WHEN (SELECT COUNT(*) FROM chunks) = 0 THEN CASE WHEN s.high_water_value IS NULL THEN 1 ELSE 0 END
            WHEN s.high_water_value = (SELECT MAX(chunk_uid) FROM chunks) THEN 1 ELSE 0 END AS high_water_matches_max,
       CASE WHEN NOT EXISTS (SELECT 1 FROM current_batches) THEN CASE WHEN s.base_count = (SELECT COUNT(*) FROM chunks c WHERE s.cursor_value IS NOT NULL AND c.chunk_uid <= s.cursor_value) THEN 1 ELSE 0 END
            WHEN s.cursor_value = (SELECT end_cursor FROM current_batches ORDER BY batch_no DESC LIMIT 1) THEN 1 ELSE 0 END AS cursor_matches_batch_end,
       (SELECT COUNT(*) FROM documents) AS documents,
       (SELECT COUNT(*) FROM chunks) AS chunks,
       (SELECT COUNT(*) FROM chunks_fts) AS fts,
       (SELECT COUNT(*) FROM vector_bootstrap_batches) AS all_batches,
       (SELECT COUNT(*) FROM current_batches) AS current_batches,
       (SELECT COUNT(*) FROM current_batches WHERE status = 'queued') AS queued_batches,
       (SELECT COUNT(*) FROM current_batches WHERE status = 'submitted') AS submitted_batches,
       (SELECT COUNT(*) FROM current_batches WHERE status = 'confirmed') AS confirmed_batches,
       (SELECT COUNT(*) FROM current_batches WHERE status NOT IN ('queued','submitted','confirmed')) AS failed_batches,
       COALESCE((SELECT SUM(row_count) FROM current_batches), 0) AS batch_rows_total,
       COALESCE((SELECT SUM(row_count) FROM current_batches WHERE status = 'queued'), 0) AS queued_batch_rows,
       COALESCE((SELECT SUM(row_count) FROM current_batches WHERE status = 'submitted'), 0) AS submitted_batch_rows,
       COALESCE((SELECT SUM(row_count) FROM current_batches WHERE status = 'confirmed'), 0) AS confirmed_batch_rows,
       CASE WHEN NOT EXISTS (SELECT 1 FROM current_batches) THEN s.base_count
            ELSE (SELECT COUNT(*) FROM chunks c WHERE c.chunk_uid <= (SELECT start_cursor FROM current_batches ORDER BY batch_no LIMIT 1)) END AS batch_start_position,
       CASE WHEN NOT EXISTS (SELECT 1 FROM current_batches) THEN s.base_count
            ELSE (SELECT COUNT(*) FROM chunks c WHERE c.chunk_uid <= (SELECT end_cursor FROM current_batches ORDER BY batch_no DESC LIMIT 1)) END AS batch_end_position,
       CASE WHEN NOT EXISTS (SELECT 1 FROM current_batches) THEN 1
            WHEN (SELECT MIN(batch_no) FROM current_batches) = 1
             AND (SELECT MAX(batch_no) FROM current_batches) = (SELECT COUNT(*) FROM current_batches)
             AND (SELECT COUNT(DISTINCT batch_no) FROM current_batches) = (SELECT COUNT(*) FROM current_batches)
            THEN 1 ELSE 0 END AS batch_sequence_valid,
       (SELECT COUNT(*)
          FROM current_batches b
          LEFT JOIN current_batches prior ON prior.batch_no = b.batch_no - 1
         WHERE (b.batch_no = 1 AND (SELECT COUNT(*) FROM chunks c WHERE c.chunk_uid <= b.start_cursor) <> s.base_count)
            OR (b.batch_no > 1 AND (prior.batch_no IS NULL OR prior.end_cursor <> b.start_cursor))) AS batch_chain_breaks,
       (SELECT COUNT(*)
          FROM current_batches b
         WHERE b.row_count <> (SELECT COUNT(*) FROM chunks c WHERE c.chunk_uid > b.start_cursor AND c.chunk_uid <= b.end_cursor)) AS batch_row_mismatches,
       (SELECT COUNT(*) FROM vector_bootstrap_batches b WHERE b.epoch <> s.epoch) AS foreign_batches,
       (SELECT COUNT(*) FROM vector_outbox) AS outbox_pending,
       (SELECT COUNT(*) FROM vector_outbox WHERE submitted_mutation_id IS NULL) AS outbox_queued,
       (SELECT COUNT(*) FROM vector_outbox WHERE submitted_mutation_id IS NOT NULL) AS outbox_submitted,
       (SELECT COUNT(*)
          FROM vector_outbox o
          JOIN vector_outbox_retry_state r ON r.chunk_uid = o.chunk_uid AND r.generation = o.generation
         WHERE r.quarantined_at IS NOT NULL) AS outbox_failed,
       (SELECT COUNT(*)
          FROM vector_outbox o
          LEFT JOIN vector_outbox_retry_state r ON r.chunk_uid = o.chunk_uid AND r.generation = o.generation
         WHERE r.quarantined_at IS NULL AND COALESCE(r.attempts, o.attempts, 0) > 0) AS outbox_retrying,
       (SELECT COUNT(*) FROM vector_outbox o WHERE o.bootstrap_epoch IS NULL OR o.bootstrap_epoch <> s.epoch) AS foreign_outbox,
       (SELECT COUNT(*) FROM vector_outbox WHERE op <> 'upsert') AS non_upsert_outbox,
       s.projection_fence_pending
  FROM observer_state s`.replace(/\s+/g, " ").trim();

export const AGGREGATE_FIELD_OBSERVER_READS = Object.freeze({
  identity: Object.freeze({
    effect: "read_only",
    resource: "target_identity",
    fields: Object.freeze(["target_identity_fingerprint"]),
  }),
  d1: Object.freeze({
    effect: "read_only",
    resource: "d1",
    sql: AGGREGATE_FIELD_OBSERVER_D1_SQL,
  }),
  vectorize: Object.freeze({
    effect: "read_only",
    resource: "vectorize",
    fields: Object.freeze(["actual_vectors"]),
  }),
});

export class AggregateFieldObserverError extends Error {
  constructor(code) {
    super(code);
    this.name = "AggregateFieldObserverError";
    this.code = code;
  }
}

function refuse(code) {
  throw new AggregateFieldObserverError(code);
}

function exactKeys(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse(code);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    refuse(code);
  }
}

function count(value, code) {
  const normalized = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(normalized) || normalized < 0) refuse(code);
  return normalized;
}

function bit(value, code) {
  const normalized = count(value, code);
  if (normalized !== 0 && normalized !== 1) refuse(code);
  return normalized;
}

function fingerprint(value, code) {
  if (typeof value !== "string" || !SHA256_RE.test(value)) refuse(code);
  return value;
}

function freezeObservation(value) {
  Object.freeze(value.bootstrap);
  Object.freeze(value.batches);
  Object.freeze(value.outbox);
  Object.freeze(value.d1);
  Object.freeze(value.vectorize);
  return Object.freeze(value);
}

function expectedContract(value) {
  const code = "FIELD_OBSERVER_EXPECTATION_INVALID";
  exactKeys(value, EXPECTED_FIELDS, code);
  const expected = {
    target_identity_fingerprint: fingerprint(value.target_identity_fingerprint, code),
    documents: count(value.documents, code),
    chunks: count(value.chunks, code),
    fts: count(value.fts, code),
  };
  if (expected.documents > expected.chunks || expected.fts !== expected.chunks) refuse(code);
  return Object.freeze(expected);
}

function normalizeD1Row(value) {
  const code = "FIELD_OBSERVER_D1_RESPONSE_INVALID";
  exactKeys(value, D1_ROW_FIELDS, code);
  if (!PROJECTION_STATES.has(value.projection_status) || value.bootstrap_protocol !== "bootstrap-v2") {
    refuse(code);
  }
  const row = {
    projection_status: value.projection_status,
    bootstrap_protocol: value.bootstrap_protocol,
  };
  for (const field of D1_ROW_FIELDS.slice(2)) row[field] = count(value[field], code);
  for (const field of [
    "cursor_set", "high_water_set", "cursor_valid", "high_water_valid",
    "cursor_not_after_high_water", "high_water_matches_max",
    "cursor_matches_batch_end", "batch_sequence_valid", "projection_fence_pending",
  ]) row[field] = bit(row[field], code);

  if (row.foreign_batches !== 0 || row.foreign_outbox !== 0) {
    refuse("FIELD_OBSERVER_MIXED_EPOCH");
  }

  if (row.documents > row.chunks || row.fts !== row.chunks ||
      row.base_count > row.chunks || row.cursor_position > row.high_water_position ||
      row.high_water_position !== row.chunks ||
      row.cursor_valid !== 1 || row.high_water_valid !== 1 ||
      row.cursor_not_after_high_water !== 1 || row.high_water_matches_max !== 1 ||
      row.cursor_matches_batch_end !== 1 ||
      (row.chunks === 0
        ? row.cursor_set !== 0 || row.high_water_set !== 0
        : row.high_water_set !== 1) ||
      row.current_batches !== row.all_batches ||
      row.current_batches !== row.queued_batches + row.submitted_batches +
        row.confirmed_batches + row.failed_batches ||
      row.failed_batches !== 0 || row.batch_sequence_valid !== 1 ||
      row.batch_chain_breaks !== 0 || row.batch_row_mismatches !== 0 ||
      row.batch_rows_total !== row.queued_batch_rows + row.submitted_batch_rows +
        row.confirmed_batch_rows ||
      row.batch_start_position !== row.base_count ||
      row.batch_end_position !== row.cursor_position ||
      row.base_count + row.batch_rows_total !== row.cursor_position ||
      row.cursor_position > row.chunks ||
      row.outbox_pending !== row.outbox_queued + row.outbox_submitted ||
      row.outbox_pending !== row.queued_batch_rows + row.submitted_batch_rows ||
      row.outbox_queued !== row.queued_batch_rows ||
      row.outbox_submitted !== row.submitted_batch_rows ||
      row.outbox_failed > row.outbox_pending || row.outbox_retrying > row.outbox_pending ||
      row.non_upsert_outbox !== 0) {
    refuse("FIELD_OBSERVER_COUNTERS_INVALID");
  }
  if (row.projection_status === "verified" && (
    row.cursor_position !== row.high_water_position ||
    row.queued_batches !== 0 || row.submitted_batches !== 0 ||
    row.outbox_pending !== 0 || row.outbox_failed !== 0 ||
    row.projection_fence_pending !== 0
  )) {
    refuse("FIELD_OBSERVER_COUNTERS_INVALID");
  }
  return Object.freeze(row);
}

function normalizeBootstrapReceipt(value) {
  const code = "FIELD_OBSERVER_BOOTSTRAP_RECEIPT_INVALID";
  exactKeys(value, BOOTSTRAP_RECEIPT_FIELDS, code);
  if (value.protocol !== "bootstrap-v2" || !BOOTSTRAP_PHASES.has(value.phase) ||
      typeof value.complete !== "boolean" || typeof value.vector_ready !== "boolean") {
    refuse(code);
  }
  const receipt = {
    protocol: value.protocol,
    phase: value.phase,
  };
  for (const field of BOOTSTRAP_RECEIPT_FIELDS.slice(2, 11)) {
    receipt[field] = count(value[field], code);
  }
  receipt.complete = value.complete;
  receipt.vector_ready = value.vector_ready;
  receipt.expected_vectors = count(value.expected_vectors, code);
  receipt.actual_vectors = count(value.actual_vectors, code);
  if (receipt.confirmed > receipt.total || receipt.remaining !== receipt.total - receipt.confirmed ||
      receipt.queued + receipt.submitted > receipt.remaining ||
      receipt.in_flight_batches > 3 || receipt.failed !== 0 ||
      receipt.actual_vectors > receipt.expected_vectors ||
      (receipt.phase === "complete") !== receipt.complete ||
      (receipt.vector_ready && !receipt.complete) ||
      (receipt.complete && (
        receipt.remaining !== 0 || receipt.queued !== 0 || receipt.submitted !== 0 ||
        receipt.in_flight_batches !== 0 || receipt.retrying !== 0 ||
        !receipt.vector_ready || receipt.actual_vectors !== receipt.expected_vectors
      ))) {
    refuse(code);
  }
  return Object.freeze(receipt);
}

function normalizeVectorize(value) {
  const code = "FIELD_OBSERVER_VECTORIZE_RESPONSE_INVALID";
  exactKeys(value, ["actual_vectors"], code);
  return Object.freeze({ actual_vectors: count(value.actual_vectors, code) });
}

function assertD1Bracket(before, after) {
  const stable = [
    "bootstrap_protocol", "epoch", "base_count", "high_water_set",
    "high_water_position", "high_water_valid", "high_water_matches_max",
    "documents", "chunks", "fts",
  ];
  if (stable.some((field) => before[field] !== after[field])) {
    refuse("FIELD_OBSERVER_MIXED_SNAPSHOT");
  }
  if (PROJECTION_STATE_ORDER[after.projection_status] < PROJECTION_STATE_ORDER[before.projection_status] ||
      after.cursor_position < before.cursor_position ||
      after.current_batches < before.current_batches ||
      after.batch_rows_total < before.batch_rows_total ||
      after.confirmed_batches < before.confirmed_batches ||
      after.confirmed_batch_rows < before.confirmed_batch_rows) {
    refuse("FIELD_OBSERVER_PROGRESS_REGRESSION");
  }
}

function assertObservationShape(value) {
  const code = "FIELD_OBSERVER_PREVIOUS_INVALID";
  exactKeys(value, OBSERVATION_FIELDS, code);
  if (value.schema_version !== AGGREGATE_FIELD_OBSERVER_SCHEMA_VERSION ||
      value.kind !== AGGREGATE_FIELD_OBSERVER_KIND || value.aggregate_only !== true ||
      value.read_only !== true || typeof value.complete !== "boolean") refuse(code);
  fingerprint(value.target_identity_fingerprint, code);
  exactKeys(value.bootstrap, BOOTSTRAP_OUTPUT_FIELDS, code);
  exactKeys(value.batches, BATCH_OUTPUT_FIELDS, code);
  exactKeys(value.outbox, OUTBOX_OUTPUT_FIELDS, code);
  exactKeys(value.d1, D1_OUTPUT_FIELDS, code);
  exactKeys(value.vectorize, VECTOR_OUTPUT_FIELDS, code);
  if (value.bootstrap.protocol !== "bootstrap-v2" ||
      !BOOTSTRAP_PHASES.has(value.bootstrap.phase) ||
      !PROJECTION_STATES.has(value.bootstrap.projection_status) ||
      typeof value.bootstrap.complete !== "boolean" || typeof value.vectorize.ready !== "boolean") {
    refuse(code);
  }
  for (const [group, fields] of [
    [value.bootstrap, ["epoch", "cursor_position", "high_water_position", "total", "confirmed", "remaining", "retrying"]],
    [value.batches, BATCH_OUTPUT_FIELDS.filter((field) => field !== "epoch")],
    [value.outbox, OUTBOX_OUTPUT_FIELDS],
    [value.d1, D1_OUTPUT_FIELDS],
    [value.vectorize, ["expected", "actual"]],
  ]) for (const field of fields) count(group[field], code);
  count(value.batches.epoch, code);
  if (value.batches.epoch !== value.bootstrap.epoch ||
      value.bootstrap.total !== value.d1.chunks ||
      value.bootstrap.confirmed > value.bootstrap.total ||
      value.bootstrap.remaining !== value.bootstrap.total - value.bootstrap.confirmed ||
      value.bootstrap.cursor_position > value.bootstrap.high_water_position ||
      value.bootstrap.high_water_position !== value.d1.chunks ||
      value.batches.total !== value.batches.queued + value.batches.submitted +
        value.batches.confirmed + value.batches.failed ||
      value.batches.rows_total !== value.batches.rows_queued + value.batches.rows_submitted +
        value.batches.rows_confirmed ||
      value.outbox.pending !== value.outbox.queued + value.outbox.submitted ||
      value.outbox.failed > value.outbox.pending || value.outbox.retrying > value.outbox.pending ||
      value.d1.documents > value.d1.chunks || value.d1.fts !== value.d1.chunks ||
      value.vectorize.expected !== value.d1.chunks ||
      value.vectorize.actual > value.vectorize.expected ||
      (value.vectorize.ready && (
        value.vectorize.actual !== value.vectorize.expected || value.outbox.pending !== 0 ||
        value.outbox.failed !== 0 || value.batches.queued !== 0 || value.batches.submitted !== 0
      )) || value.complete !== value.bootstrap.complete ||
      (value.complete && (!value.vectorize.ready || value.bootstrap.projection_status !== "verified"))) {
    refuse(code);
  }
  return value;
}

function assertProgress(previous, current) {
  if (previous === null) return;
  assertObservationShape(previous);
  if (previous.target_identity_fingerprint !== current.target_identity_fingerprint ||
      previous.bootstrap.epoch !== current.bootstrap.epoch ||
      previous.bootstrap.total !== current.bootstrap.total ||
      previous.bootstrap.high_water_position !== current.bootstrap.high_water_position ||
      previous.d1.documents !== current.d1.documents || previous.d1.chunks !== current.d1.chunks ||
      previous.d1.fts !== current.d1.fts) {
    refuse("FIELD_OBSERVER_MIXED_SNAPSHOT");
  }
  if (PROJECTION_STATE_ORDER[current.bootstrap.projection_status] <
        PROJECTION_STATE_ORDER[previous.bootstrap.projection_status] ||
      current.bootstrap.cursor_position < previous.bootstrap.cursor_position ||
      current.bootstrap.confirmed < previous.bootstrap.confirmed ||
      current.bootstrap.remaining > previous.bootstrap.remaining ||
      current.batches.total < previous.batches.total ||
      current.batches.rows_total < previous.batches.rows_total ||
      current.batches.confirmed < previous.batches.confirmed ||
      current.batches.rows_confirmed < previous.batches.rows_confirmed ||
      current.vectorize.actual < previous.vectorize.actual ||
      (previous.complete && !current.complete)) {
    refuse("FIELD_OBSERVER_PROGRESS_REGRESSION");
  }
}

/**
 * Validate already-normalized aggregate reads. This is the integration seam
 * for a field runner that owns its own reviewed, read-only provider adapter.
 */
export function validateAggregateFieldObservation(input) {
  exactKeys(input, VALIDATION_INPUT_FIELDS, "FIELD_OBSERVER_ARGUMENTS_INVALID");
  const expected = expectedContract(input.expected);
  const observedIdentity = fingerprint(
    input.observedIdentityFingerprint,
    "FIELD_OBSERVER_IDENTITY_INVALID",
  );
  if (observedIdentity !== expected.target_identity_fingerprint) {
    refuse("FIELD_OBSERVER_IDENTITY_MISMATCH");
  }
  const receipt = normalizeBootstrapReceipt(input.bootstrapReceipt);
  const d1 = normalizeD1Row(input.d1Row);
  const vector = normalizeVectorize(input.vectorize);
  if (d1.documents !== expected.documents || d1.chunks !== expected.chunks ||
      d1.fts !== expected.fts || receipt.epoch !== d1.epoch ||
      receipt.total !== d1.chunks || receipt.expected_vectors !== d1.chunks ||
      receipt.confirmed > d1.base_count + d1.confirmed_batch_rows ||
      receipt.actual_vectors > vector.actual_vectors ||
      vector.actual_vectors > d1.chunks) {
    refuse("FIELD_OBSERVER_MIXED_SNAPSHOT");
  }

  const durableConfirmed = d1.base_count + d1.confirmed_batch_rows;
  const vectorReady = d1.projection_status === "verified" &&
    d1.cursor_position === d1.high_water_position &&
    d1.queued_batches === 0 && d1.submitted_batches === 0 &&
    d1.outbox_pending === 0 && d1.outbox_failed === 0 &&
    d1.projection_fence_pending === 0 && vector.actual_vectors === d1.chunks;
  if ((receipt.complete || receipt.vector_ready) && !vectorReady) {
    refuse("FIELD_OBSERVER_MIXED_SNAPSHOT");
  }
  const complete = receipt.complete && vectorReady;
  const observation = freezeObservation({
    schema_version: AGGREGATE_FIELD_OBSERVER_SCHEMA_VERSION,
    kind: AGGREGATE_FIELD_OBSERVER_KIND,
    aggregate_only: true,
    read_only: true,
    target_identity_fingerprint: observedIdentity,
    bootstrap: {
      protocol: receipt.protocol,
      phase: complete ? "complete" : receipt.phase,
      projection_status: d1.projection_status,
      epoch: d1.epoch,
      cursor_position: d1.cursor_position,
      high_water_position: d1.high_water_position,
      total: d1.chunks,
      confirmed: durableConfirmed,
      remaining: d1.chunks - durableConfirmed,
      retrying: d1.outbox_retrying,
      complete,
    },
    batches: {
      epoch: d1.epoch,
      total: d1.current_batches,
      queued: d1.queued_batches,
      submitted: d1.submitted_batches,
      confirmed: d1.confirmed_batches,
      failed: d1.failed_batches,
      rows_total: d1.batch_rows_total,
      rows_queued: d1.queued_batch_rows,
      rows_submitted: d1.submitted_batch_rows,
      rows_confirmed: d1.confirmed_batch_rows,
    },
    outbox: {
      pending: d1.outbox_pending,
      queued: d1.outbox_queued,
      submitted: d1.outbox_submitted,
      failed: d1.outbox_failed,
      retrying: d1.outbox_retrying,
    },
    d1: {
      documents: d1.documents,
      chunks: d1.chunks,
      fts: d1.fts,
    },
    vectorize: {
      expected: d1.chunks,
      actual: vector.actual_vectors,
      ready: vectorReady,
    },
    complete,
  });
  assertObservationShape(observation);
  assertProgress(input.previous, observation);
  return observation;
}

function normalizeIdentityEnvelope(value) {
  const code = "FIELD_OBSERVER_IDENTITY_RESPONSE_INVALID";
  exactKeys(value, ["effect", "redirected", "target_identity_fingerprint"], code);
  if (value.effect !== "read_only") refuse("FIELD_OBSERVER_READ_ONLY_VIOLATION");
  if (value.redirected !== false) refuse("FIELD_OBSERVER_REDIRECT_REFUSED");
  return fingerprint(value.target_identity_fingerprint, code);
}

function normalizeD1Envelope(value) {
  const code = "FIELD_OBSERVER_D1_RESPONSE_INVALID";
  exactKeys(value, ["effect", "redirected", "rows"], code);
  if (value.effect !== "read_only") refuse("FIELD_OBSERVER_READ_ONLY_VIOLATION");
  if (value.redirected !== false) refuse("FIELD_OBSERVER_REDIRECT_REFUSED");
  if (!Array.isArray(value.rows) || value.rows.length !== 1) refuse(code);
  return normalizeD1Row(value.rows[0]);
}

function normalizeVectorEnvelope(value) {
  const code = "FIELD_OBSERVER_VECTORIZE_RESPONSE_INVALID";
  exactKeys(value, ["effect", "redirected", "actual_vectors"], code);
  if (value.effect !== "read_only") refuse("FIELD_OBSERVER_READ_ONLY_VIOLATION");
  if (value.redirected !== false) refuse("FIELD_OBSERVER_REDIRECT_REFUSED");
  return normalizeVectorize({ actual_vectors: value.actual_vectors });
}

async function invokeRead(reader, contract) {
  try {
    return await reader(contract);
  } catch {
    // A provider exception can contain a path, response body, identifier, or
    // credential. Never retain it as a cause and never interpolate it.
    refuse("FIELD_OBSERVER_READ_FAILED");
  }
}

/**
 * Create a one-shot, no-retry observer. Each observation is bracketed by the
 * same target identity and two D1 reads. Corpus/epoch/high-water drift fails;
 * monotonic bootstrap progress inside the bracket is permitted.
 */
export function createAggregateFieldObserver(config) {
  exactKeys(config, FACTORY_FIELDS, "FIELD_OBSERVER_ARGUMENTS_INVALID");
  const expected = expectedContract(config.expected);
  for (const reader of [
    config.readIdentityAggregate,
    config.readD1Aggregate,
    config.readVectorizeAggregate,
  ]) if (typeof reader !== "function") refuse("FIELD_OBSERVER_ARGUMENTS_INVALID");

  return Object.freeze({
    observe: async (input = {}) => {
      exactKeys(input, ["bootstrapReceipt", "previous"], "FIELD_OBSERVER_ARGUMENTS_INVALID");
      const { bootstrapReceipt, previous } = input;
      const identityBefore = normalizeIdentityEnvelope(await invokeRead(
        config.readIdentityAggregate,
        AGGREGATE_FIELD_OBSERVER_READS.identity,
      ));
      if (identityBefore !== expected.target_identity_fingerprint) {
        refuse("FIELD_OBSERVER_IDENTITY_MISMATCH");
      }
      const d1Before = normalizeD1Envelope(await invokeRead(
        config.readD1Aggregate,
        AGGREGATE_FIELD_OBSERVER_READS.d1,
      ));
      const vector = normalizeVectorEnvelope(await invokeRead(
        config.readVectorizeAggregate,
        AGGREGATE_FIELD_OBSERVER_READS.vectorize,
      ));
      const d1After = normalizeD1Envelope(await invokeRead(
        config.readD1Aggregate,
        AGGREGATE_FIELD_OBSERVER_READS.d1,
      ));
      const identityAfter = normalizeIdentityEnvelope(await invokeRead(
        config.readIdentityAggregate,
        AGGREGATE_FIELD_OBSERVER_READS.identity,
      ));
      if (identityBefore !== identityAfter || identityAfter !== expected.target_identity_fingerprint) {
        refuse("FIELD_OBSERVER_IDENTITY_MISMATCH");
      }
      assertD1Bracket(d1Before, d1After);
      return validateAggregateFieldObservation({
        expected,
        observedIdentityFingerprint: identityAfter,
        bootstrapReceipt,
        d1Row: d1After,
        vectorize: vector,
        previous,
      });
    },
  });
}
