import { createHash } from "node:crypto";

import {
  V048_D1_DELETION_STATE_FTS_SHADOW_TABLES,
  fingerprintV048D1DeletionState,
  normalizeV048D1DeletionStateSequences,
} from "./v048-d1-deletion-state-contract.mjs";
import {
  V048_WORKER_ANSWER_MODEL,
} from "./v048-worker-version-contract.mjs";

export const V048_TARGET_EVAL_IMMUTABILITY_SCHEMA_VERSION = 1;
export const V048_TARGET_EVAL_IMMUTABLE_STATE_KIND =
  "v048_target_eval_immutable_state_v1";
export const V048_TARGET_EVAL_LLM_APPEND_KIND =
  "v048_target_eval_llm_append_v1";
export const V048_TARGET_EVAL_MUTABLE_TABLE = "llm_call_log";
export const V048_TARGET_EVAL_ALLOWED_LLM_LABELS = Object.freeze([
  "rag-evidence-gate",
  "rag-think",
]);
export const V048_TARGET_EVAL_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const V048_TARGET_EVAL_MAX_WINDOW_MS = 31 * 60 * 1000;
export const V048_TARGET_EVAL_LLM_CALL_LOG_SQL =
  "SELECT id,ts,day,label,model,status,est_cost_usd_micros " +
  "FROM llm_call_log ORDER BY id ASC";

const SHA256_RE = /^[a-f0-9]{64}$/u;
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const ISO_TIMESTAMP_RE =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u;
const ISO_DAY_RE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const LLM_ROW_KEYS = Object.freeze([
  "id",
  "ts",
  "day",
  "label",
  "model",
  "status",
  "est_cost_usd_micros",
]);

export class V048TargetEvalImmutabilityContractError extends Error {
  constructor(code) {
    super(code);
    this.name = "V048TargetEvalImmutabilityContractError";
    this.code = code;
  }
}

function refuse(code) {
  throw new V048TargetEvalImmutabilityContractError(code);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function binaryCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactKeys(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(value, key))) {
    refuse(code);
  }
  return value;
}

function boundedText(value, maximum, code, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !value || value.length > maximum ||
      value.includes("\0") || CONTROL_RE.test(value)) {
    refuse(code);
  }
  return value;
}

function nonNegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) refuse(code);
  return value;
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) refuse(code);
  return value;
}

function exactIsoTimestamp(value, code) {
  if (typeof value !== "string" || !ISO_TIMESTAMP_RE.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    refuse(code);
  }
  return value;
}

/**
 * Derive the exact number of /think executions in a one-pass release eval.
 * Raw questions stay private; callers retain only this aggregate count. A
 * successful /think always logs one rag-think row and can log at most one
 * additional rag-evidence-gate row, including for an unanswerable case whose
 * cited draft is ultimately rejected. A passing deterministic-answer case
 * necessarily contributes that additional gate, which supplies the lower
 * bound returned here.
 */
export function deriveV048TargetEvalExpectedLlmCallBounds(
  golden,
  { repeat = 1 } = {},
) {
  const code = "V048_TARGET_EVAL_EXPECTATIONS_INVALID";
  if (!golden || typeof golden !== "object" || Array.isArray(golden) ||
      !Array.isArray(golden.questions) || golden.questions.length < 1 || repeat !== 1) {
    refuse(code);
  }
  let ragThink = 0;
  let minimumEvidenceGate = 0;
  for (const question of golden.questions) {
    if (!question || typeof question !== "object" || Array.isArray(question)) refuse(code);
    const kind = question.kind;
    if (kind !== undefined && (typeof kind !== "string" || !kind ||
        kind.length > 64 || CONTROL_RE.test(kind))) {
      refuse(code);
    }
    if (kind === "unanswerable") {
      ragThink++;
    } else if (question.answer_expect !== undefined) {
      ragThink++;
      minimumEvidenceGate++;
    }
  }
  return Object.freeze({
    ragThink,
    minimumEvidenceGate,
    maximumEvidenceGate: ragThink,
  });
}

function normalizeDurableTables(durableTables) {
  const code = "V048_TARGET_EVAL_IMMUTABLE_TABLES_INVALID";
  if (!Array.isArray(durableTables) || durableTables.length < 2 ||
      durableTables.length > 256) {
    refuse(code);
  }
  const normalized = durableTables.map((table) => {
    if (typeof table !== "string" || table.length > 128 ||
        !IDENTIFIER_RE.test(table)) {
      refuse(code);
    }
    return table;
  });
  const reserved = new Set([
    "chunks_fts",
    ...V048_D1_DELETION_STATE_FTS_SHADOW_TABLES,
  ]);
  if (new Set(normalized).size !== normalized.length ||
      normalized.filter((table) => table === V048_TARGET_EVAL_MUTABLE_TABLE).length !== 1 ||
      normalized.some((table) => reserved.has(table))) {
    refuse(code);
  }
  return Object.freeze(normalized);
}

/**
 * Return the only table order allowed for the target-evaluation immutable raw
 * export. The one intentional evaluation mutation is excluded; the four FTS5
 * shadow tables are included because their raw state is not represented by an
 * export of the logical external-content virtual table.
 */
export function deriveV048TargetEvalImmutableExportTables(durableTables) {
  const normalized = normalizeDurableTables(durableTables);
  return Object.freeze([
    ...normalized.filter((table) => table !== V048_TARGET_EVAL_MUTABLE_TABLE),
    ...V048_D1_DELETION_STATE_FTS_SHADOW_TABLES,
  ]);
}

export function deriveV048TargetEvalExpectedInventory(durableTables) {
  return Object.freeze([
    ...normalizeDurableTables(durableTables),
    "chunks_fts",
    ...V048_D1_DELETION_STATE_FTS_SHADOW_TABLES,
  ].sort(binaryCompare));
}

function exactArray(value, expected, code) {
  if (!Array.isArray(value) || canonical(value) !== canonical(expected)) {
    refuse(code);
  }
  return value;
}

function validateSchemaTableInventory(schemaRows, expectedInventory, code) {
  if (!Array.isArray(schemaRows)) refuse(code);
  let tableNames;
  try {
    tableNames = schemaRows
      .filter((row) => row?.type === "table")
      .map((row) => boundedText(row?.name, 256 * 1024, code));
  } catch (error) {
    if (error instanceof V048TargetEvalImmutabilityContractError) throw error;
    refuse(code);
  }
  if (canonical(tableNames) !== canonical(expectedInventory)) refuse(code);
}

function partitionSequences(sequenceRows, expectedInventory, code) {
  let normalized;
  try {
    normalized = normalizeV048D1DeletionStateSequences(
      sequenceRows,
      expectedInventory,
    );
  } catch {
    refuse(code);
  }
  const mutable = normalized.filter(
    (row) => row.name === V048_TARGET_EVAL_MUTABLE_TABLE,
  );
  if (mutable.length !== 1 || mutable[0].seq_type !== "integer" ||
      !Number.isSafeInteger(mutable[0].seq) || mutable[0].seq < 0) {
    refuse(code);
  }
  return Object.freeze({
    mutableSequence: mutable[0].seq,
    immutableSequences: Object.freeze(normalized.filter(
      (row) => row.name !== V048_TARGET_EVAL_MUTABLE_TABLE,
    )),
    // The full deletion contract requires the exact two reviewed sequence
    // rows. Replace only the intentionally mutable LLM high-water mark with a
    // canonical constant so the immutable-state hash retains the shared
    // allowlist/cardinality check without changing across evaluation.
    neutralizedSequences: Object.freeze(normalized.map((row) =>
      row.name === V048_TARGET_EVAL_MUTABLE_TABLE
        ? Object.freeze({ ...row, seq: 0, seq_type: "integer", seq_quote: "0" })
        : row)),
  });
}

/**
 * Hash the target-bound D1 state that must remain byte-for-byte immutable
 * across release evaluation. Raw export and schema material never leaves this
 * function; the caller receives only a domain-separated SHA-256.
 */
export function fingerprintV048TargetEvalImmutableState({
  binding,
  durableTables,
  immutableExportTables,
  migrations,
  quickCheck,
  inventory,
  schemaRows,
  immutableExportSha256,
  immutableExportBytes,
  sequenceRows,
  ftsCount,
} = {}) {
  const code = "V048_TARGET_EVAL_IMMUTABLE_STATE_INVALID";
  const expectedExportTables = deriveV048TargetEvalImmutableExportTables(durableTables);
  exactArray(immutableExportTables, expectedExportTables, code);
  const expectedInventory = deriveV048TargetEvalExpectedInventory(durableTables);
  exactArray(inventory, expectedInventory, code);
  validateSchemaTableInventory(schemaRows, expectedInventory, code);
  if (!SHA256_RE.test(immutableExportSha256 || "")) refuse(code);
  const partition = partitionSequences(sequenceRows, expectedInventory, code);

  let baseStateSha256;
  try {
    baseStateSha256 = fingerprintV048D1DeletionState({
      role: "target",
      binding,
      migrations,
      quickCheck,
      inventory,
      schemaRows,
      durableExportSha256: immutableExportSha256,
      durableExportBytes: immutableExportBytes,
      sequenceRows: partition.neutralizedSequences,
      ftsCount,
    });
  } catch {
    refuse(code);
  }

  return sha256(canonical(Object.freeze({
    schema_version: V048_TARGET_EVAL_IMMUTABILITY_SCHEMA_VERSION,
    kind: V048_TARGET_EVAL_IMMUTABLE_STATE_KIND,
    mutable_table_excluded: V048_TARGET_EVAL_MUTABLE_TABLE,
    immutable_export_tables_sha256: sha256(canonical(expectedExportTables)),
    target_state_sha256: baseStateSha256,
  })));
}

function normalizeLlmRows(rows, code) {
  if (!Array.isArray(rows)) refuse(code);
  let previousId = 0;
  return Object.freeze(rows.map((row) => {
    exactKeys(row, LLM_ROW_KEYS, code);
    const id = positiveInteger(row.id, code);
    if (id <= previousId) refuse(code);
    previousId = id;
    return Object.freeze({
      id,
      ts: boundedText(row.ts, 64, code),
      day: boundedText(row.day, 32, code),
      label: boundedText(row.label, 128, code, { nullable: true }),
      model: boundedText(row.model, 512, code, { nullable: true }),
      status: boundedText(row.status, 32, code, { nullable: true }),
      est_cost_usd_micros: nonNegativeInteger(row.est_cost_usd_micros, code),
    });
  }));
}

function validateEvaluationWindow(startedAt, completedAt, code) {
  const started = Date.parse(exactIsoTimestamp(startedAt, code));
  const completed = Date.parse(exactIsoTimestamp(completedAt, code));
  if (completed < started || completed - started > V048_TARGET_EVAL_MAX_WINDOW_MS) {
    refuse(code);
  }
  return Object.freeze({
    minimum: started - V048_TARGET_EVAL_CLOCK_SKEW_MS,
    maximum: completed + V048_TARGET_EVAL_CLOCK_SKEW_MS,
  });
}

function validateNewLlmRow(row, code, expectedModel, window) {
  const timestamp = Date.parse(row.ts);
  if (!ISO_TIMESTAMP_RE.test(row.ts) || !Number.isFinite(Date.parse(row.ts)) ||
      new Date(row.ts).toISOString() !== row.ts || !ISO_DAY_RE.test(row.day) ||
      row.day !== row.ts.slice(0, 10) ||
      !V048_TARGET_EVAL_ALLOWED_LLM_LABELS.includes(row.label) ||
      row.status !== "ok" || row.model !== expectedModel ||
      timestamp < window.minimum || timestamp > window.maximum) {
    refuse(code);
  }
}

/**
 * Validate the sole allowed target mutation across release evaluation. The
 * returned receipt contains counts and hashes only, never LLM log values.
 */
export function validateV048TargetEvalLlmAppend({
  durableTables,
  beforeRows,
  afterRows,
  beforeSequenceRows,
  afterSequenceRows,
  expectedModel,
  expectedCallBounds,
  evaluationStartedAt,
  evaluationCompletedAt,
} = {}) {
  const code = "V048_TARGET_EVAL_LLM_APPEND_INVALID";
  if (expectedModel !== V048_WORKER_ANSWER_MODEL) refuse(code);
  exactKeys(
    expectedCallBounds,
    ["ragThink", "minimumEvidenceGate", "maximumEvidenceGate"],
    code,
  );
  const expectedThink = nonNegativeInteger(expectedCallBounds.ragThink, code);
  const minimumEvidenceGate = nonNegativeInteger(
    expectedCallBounds.minimumEvidenceGate,
    code,
  );
  const maximumEvidenceGate = nonNegativeInteger(
    expectedCallBounds.maximumEvidenceGate,
    code,
  );
  if (minimumEvidenceGate > maximumEvidenceGate || maximumEvidenceGate !== expectedThink) {
    refuse(code);
  }
  const evaluationWindow = validateEvaluationWindow(
    evaluationStartedAt,
    evaluationCompletedAt,
    code,
  );
  const expectedInventory = deriveV048TargetEvalExpectedInventory(durableTables);
  const before = normalizeLlmRows(beforeRows, code);
  const after = normalizeLlmRows(afterRows, code);
  if (after.length < before.length ||
      canonical(after.slice(0, before.length)) !== canonical(before)) {
    refuse(code);
  }
  const appended = after.slice(before.length);
  appended.forEach((row, index) => {
    validateNewLlmRow(row, code, expectedModel, evaluationWindow);
    if (row.id !== (before.at(-1)?.id || 0) + index + 1) refuse(code);
  });
  let prefixThink = 0;
  let prefixEvidenceGate = 0;
  for (const row of appended) {
    if (row.label === "rag-think") prefixThink++;
    if (row.label === "rag-evidence-gate") prefixEvidenceGate++;
    if (prefixEvidenceGate > prefixThink) refuse(code);
  }
  const observedCounts = Object.fromEntries(
    V048_TARGET_EVAL_ALLOWED_LLM_LABELS.map((label) => [
      label,
      appended.filter((row) => row.label === label).length,
    ]),
  );
  if (observedCounts["rag-think"] !== expectedThink ||
      observedCounts["rag-evidence-gate"] < minimumEvidenceGate ||
      observedCounts["rag-evidence-gate"] > maximumEvidenceGate ||
      observedCounts["rag-evidence-gate"] > observedCounts["rag-think"]) {
    refuse(code);
  }

  const beforeSequences = partitionSequences(beforeSequenceRows, expectedInventory, code);
  const afterSequences = partitionSequences(afterSequenceRows, expectedInventory, code);
  if (canonical(beforeSequences.immutableSequences) !==
      canonical(afterSequences.immutableSequences)) {
    refuse(code);
  }
  const beforeMaxId = before.at(-1)?.id || 0;
  const afterMaxId = after.at(-1)?.id || 0;
  if (beforeSequences.mutableSequence !== beforeMaxId ||
      afterSequences.mutableSequence !== afterMaxId ||
      (appended.length > 0 &&
        afterSequences.mutableSequence <= beforeSequences.mutableSequence) ||
      (appended.length === 0 &&
        afterSequences.mutableSequence !== beforeSequences.mutableSequence)) {
    refuse(code);
  }

  const transitionSha256 = sha256(canonical(Object.freeze({
    schema_version: V048_TARGET_EVAL_IMMUTABILITY_SCHEMA_VERSION,
    kind: V048_TARGET_EVAL_LLM_APPEND_KIND,
    before_rows_sha256: sha256(canonical(before)),
    after_rows_sha256: sha256(canonical(after)),
    before_sequence: beforeSequences.mutableSequence,
    after_sequence: afterSequences.mutableSequence,
    immutable_sequences_sha256: sha256(canonical(beforeSequences.immutableSequences)),
    expected_contract_sha256: sha256(canonical({
      expected_model: expectedModel,
      expected_rag_think_count: expectedThink,
      minimum_rag_evidence_gate_count: minimumEvidenceGate,
      maximum_rag_evidence_gate_count: maximumEvidenceGate,
      evaluation_started_at: evaluationStartedAt,
      evaluation_completed_at: evaluationCompletedAt,
      clock_skew_ms: V048_TARGET_EVAL_CLOCK_SKEW_MS,
    })),
  })));
  return Object.freeze({
    schema_version: V048_TARGET_EVAL_IMMUTABILITY_SCHEMA_VERSION,
    kind: V048_TARGET_EVAL_LLM_APPEND_KIND,
    before_rows: before.length,
    appended_rows: appended.length,
    after_rows: after.length,
    rag_think_rows: observedCounts["rag-think"],
    rag_evidence_gate_rows: observedCounts["rag-evidence-gate"],
    transition_sha256: transitionSha256,
  });
}

/**
 * Revalidate the privacy-safe aggregate before it becomes durable recovery
 * evidence. The private rows used to derive this receipt are deliberately not
 * retained in the state journal.
 */
export function validateV048TargetEvalLlmAppendReceipt(input) {
  const code = "V048_TARGET_EVAL_LLM_APPEND_RECEIPT_INVALID";
  exactKeys(input, [
    "schema_version",
    "kind",
    "before_rows",
    "appended_rows",
    "after_rows",
    "rag_think_rows",
    "rag_evidence_gate_rows",
    "transition_sha256",
  ], code);
  if (input.schema_version !== V048_TARGET_EVAL_IMMUTABILITY_SCHEMA_VERSION ||
      input.kind !== V048_TARGET_EVAL_LLM_APPEND_KIND ||
      !SHA256_RE.test(String(input.transition_sha256 || ""))) {
    refuse(code);
  }
  const beforeRows = nonNegativeInteger(input.before_rows, code);
  const appendedRows = nonNegativeInteger(input.appended_rows, code);
  const afterRows = nonNegativeInteger(input.after_rows, code);
  const ragThinkRows = nonNegativeInteger(input.rag_think_rows, code);
  const ragEvidenceGateRows = nonNegativeInteger(input.rag_evidence_gate_rows, code);
  if (afterRows !== beforeRows + appendedRows ||
      appendedRows !== ragThinkRows + ragEvidenceGateRows ||
      ragEvidenceGateRows > ragThinkRows) {
    refuse(code);
  }
  return Object.freeze(structuredClone(input));
}
