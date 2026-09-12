/**
 * Fixed synthetic corpus for the disposable v0.4.8 recovery field campaign.
 *
 * This module has no live transport, credential lookup, file reader, or corpus
 * input. A field adapter must inject the two authenticated data-plane calls.
 * The returned receipt contains aggregate evidence only. The built-in fixture
 * is exported solely so a reviewed adapter can submit those exact documents.
 */

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withFirstPartySourceProvenance } from "../worker/src/lib/provenance-receipt.js";

export const DISPOSABLE_RECOVERY_SEED_PROTOCOL = "disposable-recovery-seed-v1";
export const DISPOSABLE_RECOVERY_SEED_DOCUMENTS = 3_201;
export const DISPOSABLE_RECOVERY_SEED_BATCH_SIZE = 50;
export const DISPOSABLE_RECOVERY_SEED_BATCHES = Math.ceil(
  DISPOSABLE_RECOVERY_SEED_DOCUMENTS / DISPOSABLE_RECOVERY_SEED_BATCH_SIZE,
);
export const DISPOSABLE_RECOVERY_MINIMUM_D1_CHUNKS = 3_201;
export const DISPOSABLE_RECOVERY_EXPECTED_WORKER_VERSION = "0.4.8";
export const DISPOSABLE_RECOVERY_MARKER = "v048-orchid-ledger-field-marker";

const DATA_CLASS = "deterministic_fictional_synthetic_only";
const FIXTURE_SOURCE_TYPE = "recovery_field_v048";
const SHA256_RE = /^[a-f0-9]{64}$/u;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function fixtureDocument(index) {
  const ordinal = String(index).padStart(4, "0");
  const content = index === 0
    ? `Synthetic recovery marker ${DISPOSABLE_RECOVERY_MARKER}. This fictional record is only for a disposable field test.`
    : `Synthetic fictional recovery record ${ordinal}. This deterministic text exists only to test D1 ingestion and recovery.`;
  return deepFreeze(withFirstPartySourceProvenance({
    source_type: FIXTURE_SOURCE_TYPE,
    source_id: `record-${ordinal}`,
    title: `Synthetic recovery record ${ordinal}`,
    content,
    metadata: {
      platform: "synthetic",
      fixture_protocol: DISPOSABLE_RECOVERY_SEED_PROTOCOL,
      ordinal: index,
    },
  }, { textSource: "native", textReliable: true }));
}

const FIXTURE = deepFreeze(Array.from(
  { length: DISPOSABLE_RECOVERY_SEED_DOCUMENTS },
  (_, index) => fixtureDocument(index),
));

export const DISPOSABLE_RECOVERY_FIXTURE_SHA256 = sha256(canonicalJson(FIXTURE));

export class DisposableRecoverySeedError extends Error {
  constructor(code, message, {
    mayHaveWritten = false,
    safeToRetry = false,
    confirmedDocuments = 0,
    ambiguousDocuments = 0,
  } = {}) {
    super(message);
    this.name = "DisposableRecoverySeedError";
    this.code = code;
    this.may_have_written = mayHaveWritten;
    this.safe_to_retry = safeToRetry;
    this.confirmed_documents = confirmedDocuments;
    this.ambiguous_documents = ambiguousDocuments;
  }
}

function fail(code, message, state) {
  throw new DisposableRecoverySeedError(code, message, state);
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function exactKeys(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => keys.includes(field));
}

function validateRuntimeInventory(body, { final = false, errorState } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      body.version !== DISPOSABLE_RECOVERY_EXPECTED_WORKER_VERSION ||
      body.backend !== "d1" || body.vector_drain_mode !== "active" ||
      !Array.isArray(body.rows)) {
    fail("inventory_contract_mismatch", "The D1 inventory did not match the sealed v0.4.8 campaign contract.", errorState);
  }

  if (!final) {
    if (body.rows.length !== 0) {
      fail("inventory_not_disposable", "The destination was not an empty disposable Brain, so nothing was seeded.");
    }
    return null;
  }

  const matches = body.rows.filter((row) => row?.source_type === FIXTURE_SOURCE_TYPE);
  const row = matches[0] || null;
  if (body.rows.length !== 1 || matches.length !== 1 ||
      row.document_counts_exact !== true || row.chunk_counts_exact !== true ||
      row.documents !== DISPOSABLE_RECOVERY_SEED_DOCUMENTS ||
      row.logical_documents !== DISPOSABLE_RECOVERY_SEED_DOCUMENTS ||
      row.stored_documents !== DISPOSABLE_RECOVERY_SEED_DOCUMENTS ||
      !safeInteger(row.chunks) || row.chunks < DISPOSABLE_RECOVERY_MINIMUM_D1_CHUNKS ||
      row.total !== row.chunks) {
    fail("d1_count_proof_failed", "Exact D1 inventory did not prove the required synthetic documents and chunks.", errorState);
  }
  return row;
}

function validateBatchReceipt(body, documents, expectedStatus, errorState) {
  const counters = ["created", "updated", "unchanged", "refused", "failed", "total"];
  if (!exactKeys(body, [...counters, "results"]) ||
      counters.some((key) => !safeInteger(body[key])) ||
      body.total !== documents.length ||
      body.created + body.updated + body.unchanged + body.refused + body.failed !== body.total ||
      body[expectedStatus] !== documents.length ||
      (expectedStatus === "created" ? body.unchanged !== 0 : body.created !== 0) ||
      body.updated !== 0 || body.refused !== 0 || body.failed !== 0 ||
      !Array.isArray(body.results) || body.results.length !== documents.length) {
    fail("ingest_receipt_rejected", "A synthetic ingest batch was not accepted exactly as submitted.", errorState);
  }

  for (let index = 0; index < documents.length; index++) {
    const result = body.results[index];
    const document = documents[index];
    if (!exactKeys(result, ["source_type", "source_id", "doc_uid", "status", "chunks"]) ||
        result.status !== expectedStatus ||
        result.source_type !== document.source_type || result.source_id !== document.source_id ||
        result.doc_uid !== `${document.source_type}:${document.source_id}` ||
        (expectedStatus === "created" && (!safeInteger(result.chunks) || result.chunks < 1)) ||
        (expectedStatus === "unchanged" && result.chunks !== 0)) {
      fail("ingest_result_unbound", "A synthetic ingest result was missing its exact ordered receipt binding.", errorState);
    }
  }
}

async function inventoryThrough(readInventory, errorState) {
  try {
    return await readInventory();
  } catch {
    fail("inventory_transport_failed", "The authenticated D1 inventory could not be read, so no field proof was issued.", errorState);
  }
}

function completionTime(now, errorState) {
  let date;
  try {
    date = new Date(now());
  } catch {
    fail("clock_invalid", "The field receipt clock was invalid.", errorState);
  }
  if (!Number.isFinite(date.getTime())) fail("clock_invalid", "The field receipt clock was invalid.", errorState);
  return date.toISOString();
}

export function disposableRecoverySeedPlan() {
  return deepFreeze({
    schema_version: 1,
    protocol: DISPOSABLE_RECOVERY_SEED_PROTOCOL,
    operation: "plan",
    data_class: DATA_CLASS,
    writes: false,
    external_source_input: false,
    expected_worker_version: DISPOSABLE_RECOVERY_EXPECTED_WORKER_VERSION,
    fixture_sha256: DISPOSABLE_RECOVERY_FIXTURE_SHA256,
    fixture_documents: DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
    maximum_batch_documents: DISPOSABLE_RECOVERY_SEED_BATCH_SIZE,
    fixture_batches: DISPOSABLE_RECOVERY_SEED_BATCHES,
    minimum_d1_chunks: DISPOSABLE_RECOVERY_MINIMUM_D1_CHUNKS,
    authenticated_d1_inventory_required: true,
  });
}

/** Return the immutable built-in fixture for a reviewed transport adapter. */
export function disposableRecoveryFixture() {
  return FIXTURE;
}

/**
 * Seed the fixed fixture and issue an aggregate receipt only after the live
 * inventory callback proves actual D1 rows. No generated-length calculation
 * can satisfy this gate.
 */
export async function seedDisposableRecoveryFixture(options) {
  const allowed = new Set(["ingestBatch", "readInventory", "now"]);
  if (!options || typeof options !== "object" || Array.isArray(options) ||
      Object.keys(options).some((key) => !allowed.has(key)) ||
      typeof options.ingestBatch !== "function" || typeof options.readInventory !== "function" ||
      (options.now !== undefined && typeof options.now !== "function")) {
    fail("invalid_dependencies", "The synthetic seeder requires only reviewed ingest and D1 inventory transports.");
  }

  const opening = await inventoryThrough(options.readInventory, { safeToRetry: true });
  validateRuntimeInventory(opening);

  for (let offset = 0; offset < FIXTURE.length; offset += DISPOSABLE_RECOVERY_SEED_BATCH_SIZE) {
    const documents = Object.freeze(FIXTURE.slice(offset, offset + DISPOSABLE_RECOVERY_SEED_BATCH_SIZE));
    const errorState = {
      mayHaveWritten: true,
      safeToRetry: false,
      confirmedDocuments: offset,
      ambiguousDocuments: documents.length,
    };
    let body;
    try {
      body = await options.ingestBatch(documents);
    } catch {
      fail("ingest_transport_failed", "A synthetic ingest batch could not be confirmed. Recreate the disposable destination before retrying.", errorState);
    }
    validateBatchReceipt(body, documents, "created", errorState);
  }

  const seededState = {
    mayHaveWritten: true,
    safeToRetry: false,
    confirmedDocuments: DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
  };
  const inventory = await inventoryThrough(options.readInventory, seededState);
  validateRuntimeInventory(inventory, { final: true, errorState: seededState });

  // A second full pass is intentionally mandatory. Exact unchanged receipts
  // bind the final D1 identities and content hashes to the sealed fixture; a
  // generated document count or an unrelated 3,201-row corpus cannot pass.
  for (let offset = 0; offset < FIXTURE.length; offset += DISPOSABLE_RECOVERY_SEED_BATCH_SIZE) {
    const documents = Object.freeze(FIXTURE.slice(offset, offset + DISPOSABLE_RECOVERY_SEED_BATCH_SIZE));
    const errorState = { ...seededState, ambiguousDocuments: documents.length };
    let body;
    try {
      body = await options.ingestBatch(documents);
    } catch {
      fail("replay_transport_failed", "The synthetic verification replay could not be confirmed, so no field proof was issued.", errorState);
    }
    validateBatchReceipt(body, documents, "unchanged", errorState);
  }

  const verifiedInventory = await inventoryThrough(options.readInventory, seededState);
  const row = validateRuntimeInventory(verifiedInventory, { final: true, errorState: seededState });
  const receipt = {
    schema_version: 1,
    protocol: DISPOSABLE_RECOVERY_SEED_PROTOCOL,
    status: "passed",
    completed_at: completionTime(options.now || Date.now, seededState),
    data_class: DATA_CLASS,
    fixture: {
      sha256: DISPOSABLE_RECOVERY_FIXTURE_SHA256,
      documents: DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
      batches: DISPOSABLE_RECOVERY_SEED_BATCHES,
      maximum_batch_documents: DISPOSABLE_RECOVERY_SEED_BATCH_SIZE,
    },
    ingest: {
      accepted_documents: DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
      created_documents: DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
      unchanged_documents: 0,
      updated_documents: 0,
      refused_documents: 0,
      failed_documents: 0,
    },
    verification_replay: {
      batches: DISPOSABLE_RECOVERY_SEED_BATCHES,
      unchanged_documents: DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
      exact_identity_and_content_replay: true,
    },
    d1: {
      worker_version: verifiedInventory.version,
      documents: row.documents,
      chunks: row.chunks,
      minimum_chunks: DISPOSABLE_RECOVERY_MINIMUM_D1_CHUNKS,
      document_counts_exact: true,
      chunk_counts_exact: true,
      minimum_chunk_count_met: true,
    },
    proof_boundary: {
      external_source_input: false,
      aggregate_only: true,
      authenticated_d1_inventory_verified: true,
      vectorize_proven: false,
      retrieval_proven: false,
      recovery_proven: false,
    },
  };
  if (!SHA256_RE.test(receipt.fixture.sha256)) {
    fail("fixture_digest_invalid", "The fixed synthetic fixture digest was invalid.");
  }
  return deepFreeze(receipt);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== "--plan") {
    process.stderr.write("Usage: node operations/disposable-recovery-seeder.mjs --plan\n");
    process.exitCode = 2;
  } else {
    process.stdout.write(`${JSON.stringify(disposableRecoverySeedPlan(), null, 2)}\n`);
  }
}
