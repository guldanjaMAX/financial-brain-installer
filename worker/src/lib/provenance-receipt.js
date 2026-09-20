/**
 * Normalized provenance receipt for every corpus write.
 *
 * The receipt describes what the ingest boundary actually knows. Missing
 * producer metadata is represented as unavailable; it is never upgraded to a
 * native, reliable extraction merely because an older caller omitted fields.
 *
 * `complete` has one deliberately narrow meaning: lineage and text-origin
 * fields were both recorded. It is not a claim that extraction was high
 * quality, a document date is known, or any statement in the text is true.
 */

import { evidenceLineageValidationError } from "./evidence-lineage.js";

export const PROVENANCE_RECEIPT_VERSION = 1;
export const PROVENANCE_STATUSES = Object.freeze(["complete", "partial", "unavailable"]);
export const PROVENANCE_REASONS = Object.freeze([
  "lineage_and_text_recorded",
  "text_provenance_unavailable",
  "lineage_unavailable",
  "provenance_unavailable",
]);
export const TEXT_SOURCES = new Set(["native", "ocr", "ocr_partial", "unknown"]);

const STATUS_SET = new Set(PROVENANCE_STATUSES);
const REASON_SET = new Set(PROVENANCE_REASONS);
const MAX_ROOT_IDS = 16;
const MAX_ROOT_ID_CHARS = 512;
const CONTROL = /[\u0000-\u001f\u007f]/;
const encoder = new TextEncoder();

const owns = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validRootId(value) {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= MAX_ROOT_ID_CHARS && !CONTROL.test(value);
}

function normalizedRootIds(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ROOT_IDS ||
      value.some((id) => !validRootId(id))) return null;
  const roots = [...new Set(value.map((id) => id.trim()))].sort();
  return roots.length ? roots : null;
}

function qualifiedFamily(sourceType, value) {
  if (!validRootId(value)) return null;
  const family = String(value).trim();
  return family.startsWith(`${sourceType}:`) ? family : `${sourceType}:${family}`;
}

/**
 * Determine the physical/derivation family without using filenames, titles,
 * content, or any other field that could turn a guess into durable metadata.
 */
export function provenanceRootIds(envelope = {}) {
  const sourceType = typeof envelope.source_type === "string" ? envelope.source_type : "";
  const sourceId = typeof envelope.source_id === "string" ? envelope.source_id : "";
  const metadata = envelope.metadata && typeof envelope.metadata === "object" &&
    !Array.isArray(envelope.metadata) ? envelope.metadata : {};

  const lineage = metadata.evidence_lineage;
  const lineageError = evidenceLineageValidationError(metadata);
  const lineageRoots = !lineageError && lineage && typeof lineage === "object"
    ? normalizedRootIds(lineage.root_ids)
    : null;
  // A derived record's named inputs are its durable provenance roots. Physical
  // wrappers added by later splitting or import-family grouping must not erase
  // those upstream identities.
  if (lineageRoots && (lineage.kind === "derived_record" || lineage.kind === "agent_derived")) {
    return lineageRoots;
  }

  if (validRootId(metadata.family_of)) return [String(metadata.family_of).trim()];
  const partFamily = qualifiedFamily(sourceType, metadata.part_of);
  if (partFamily) return [partFamily];

  if (lineageRoots) return lineageRoots;

  const identity = sourceType && sourceId ? `${sourceType}:${sourceId}` : "";
  return validRootId(identity) ? [identity] : [];
}

function assessmentFor(envelope) {
  const metadata = envelope.metadata;
  const lineage = metadata.evidence_lineage;
  const roots = lineage && typeof lineage === "object"
    ? normalizedRootIds(lineage.root_ids)
    : null;
  const hasLineage = owns(metadata, "evidence_lineage") &&
    evidenceLineageValidationError(metadata) === null &&
    (lineage?.kind === "source_record" || Boolean(roots?.length));
  const hasText = typeof envelope.text_source === "string" &&
    envelope.text_source !== "unknown" && TEXT_SOURCES.has(envelope.text_source);
  if (hasLineage && hasText) {
    return { status: "complete", reason: "lineage_and_text_recorded" };
  }
  if (hasLineage) return { status: "partial", reason: "text_provenance_unavailable" };
  if (hasText) return { status: "partial", reason: "lineage_unavailable" };
  return { status: "unavailable", reason: "provenance_unavailable" };
}

/**
 * Add the conservative receipt used by legacy and omission-capable producers.
 * Existing receipts are never repaired or overwritten; malformed claims must
 * reach validation and fail before storage.
 */
export function normalizeIngestEnvelopeProvenance(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return envelope;
  if (envelope.metadata !== undefined &&
      (!envelope.metadata || typeof envelope.metadata !== "object" || Array.isArray(envelope.metadata))) {
    return envelope;
  }

  const metadata = envelope.metadata || {};
  const hasReceipt = owns(metadata, "provenance_receipt");
  const textSource = envelope.text_source === undefined || envelope.text_source === null
    ? "unknown"
    : envelope.text_source;
  const textReliable = envelope.text_reliable === undefined || envelope.text_reliable === null
    ? false
    : envelope.text_reliable;

  if (hasReceipt && envelope.text_source === textSource && envelope.text_reliable === textReliable) {
    return envelope;
  }

  const normalized = {
    ...envelope,
    text_source: textSource,
    text_reliable: textReliable,
    metadata: { ...metadata },
  };
  if (!hasReceipt) {
    const assessment = assessmentFor(normalized);
    normalized.metadata.provenance_receipt = {
      version: PROVENANCE_RECEIPT_VERSION,
      status: assessment.status,
      reason: assessment.reason,
      root_ids: provenanceRootIds(normalized),
    };
  }
  return normalized;
}

/**
 * Stamp facts known by a first-party direct source adapter before it reaches
 * splitting. Callers must name the extraction method; this helper never
 * promotes an omission to native/reliable on their behalf.
 */
export function withFirstPartySourceProvenance(envelope, {
  textSource,
  textReliable,
} = {}) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return envelope;
  const metadata = envelope.metadata && typeof envelope.metadata === "object" &&
    !Array.isArray(envelope.metadata) ? envelope.metadata : {};
  if (owns(metadata, "provenance_receipt")) return normalizeIngestEnvelopeProvenance(envelope);
  const roots = provenanceRootIds(envelope);
  const lineage = owns(metadata, "evidence_lineage")
    ? metadata.evidence_lineage
    : roots.length === 1
      ? { version: 1, kind: "source_record", root_ids: roots }
      : undefined;
  return normalizeIngestEnvelopeProvenance({
    ...envelope,
    ...(textSource === undefined ? {} : { text_source: textSource }),
    ...(textReliable === undefined ? {} : { text_reliable: textReliable }),
    metadata: {
      ...metadata,
      ...(lineage === undefined ? {} : { evidence_lineage: lineage }),
    },
  });
}

/**
 * Re-stamp a product-created envelope after an internal transform changes its
 * source namespace or declares a stronger physical family. A malformed input
 * is intentionally left untouched so the shared validator can refuse it; this
 * helper is never a repair path for an untrusted claim.
 */
export function restampFirstPartySourceProvenance(envelope, {
  textSource,
  textReliable,
  sourceType,
  metadataPatch,
} = {}) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return envelope;
  const metadata = envelope.metadata && typeof envelope.metadata === "object" &&
    !Array.isArray(envelope.metadata) ? envelope.metadata : {};
  const transformed = {
    ...envelope,
    ...(sourceType === undefined ? {} : { source_type: sourceType }),
    metadata: {
      ...metadata,
      ...(metadataPatch && typeof metadataPatch === "object" && !Array.isArray(metadataPatch)
        ? metadataPatch
        : {}),
    },
  };
  if (owns(metadata, "provenance_receipt") && provenanceReceiptValidationError(envelope)) {
    return normalizeIngestEnvelopeProvenance(transformed);
  }
  const nextMetadata = { ...transformed.metadata };
  delete nextMetadata.provenance_receipt;
  if (nextMetadata.evidence_lineage?.kind === "source_record") {
    delete nextMetadata.evidence_lineage;
  }
  return withFirstPartySourceProvenance({ ...transformed, metadata: nextMetadata }, {
    textSource,
    textReliable,
  });
}

/** Return a plain validation error for the normalized receipt contract. */
export function provenanceReceiptValidationError(envelope) {
  if (!envelope?.metadata || typeof envelope.metadata !== "object" || Array.isArray(envelope.metadata)) {
    return "metadata must be an object";
  }
  const receipt = envelope.metadata.provenance_receipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return "metadata.provenance_receipt must be an object";
  }
  const allowed = new Set(["version", "status", "reason", "root_ids"]);
  if (Object.keys(receipt).some((key) => !allowed.has(key))) {
    return "metadata.provenance_receipt accepts only version, status, reason and root_ids";
  }
  if (receipt.version !== PROVENANCE_RECEIPT_VERSION) {
    return `metadata.provenance_receipt.version must be ${PROVENANCE_RECEIPT_VERSION}`;
  }
  if (!STATUS_SET.has(receipt.status)) {
    return `metadata.provenance_receipt.status must be one of: ${PROVENANCE_STATUSES.join(" | ")}`;
  }
  if (!REASON_SET.has(receipt.reason)) {
    return `metadata.provenance_receipt.reason must be one of: ${PROVENANCE_REASONS.join(" | ")}`;
  }
  const roots = normalizedRootIds(receipt.root_ids);
  if (!roots) {
    return `metadata.provenance_receipt.root_ids must contain 1-${MAX_ROOT_IDS} printable strings of at most ${MAX_ROOT_ID_CHARS} characters`;
  }
  if (JSON.stringify(roots) !== JSON.stringify(receipt.root_ids)) {
    return "metadata.provenance_receipt.root_ids must be sorted, unique and trimmed";
  }
  const expectedRoots = provenanceRootIds({
    ...envelope,
    metadata: { ...envelope.metadata, provenance_receipt: undefined },
  });
  if (JSON.stringify(roots) !== JSON.stringify(expectedRoots)) {
    return "metadata.provenance_receipt.root_ids must match the recorded document family";
  }
  const expected = assessmentFor(envelope);
  if (receipt.status !== expected.status || receipt.reason !== expected.reason) {
    return `metadata.provenance_receipt must use status ${expected.status} and reason ${expected.reason}`;
  }
  return null;
}

/**
 * Build the denormalized marker stored beside a document after the complete
 * envelope has passed the shared receipt validator. Aggregate inventory reads
 * can inspect this small marker without attempting to recreate JavaScript
 * validation over every row in a large Brain. The digest is never exposed as a
 * document locator; it only binds the marker to the provenance-bearing fields.
 */
export async function provenanceAssessmentMarker(envelope) {
  const error = provenanceReceiptValidationError(envelope);
  if (error) throw new TypeError(error);
  const metadata = envelope.metadata;
  const receipt = metadata.provenance_receipt;
  const digest = await sha256Hex(canonicalJson({
    version: PROVENANCE_RECEIPT_VERSION,
    source_type: String(envelope.source_type || ""),
    source_id: String(envelope.source_id || ""),
    text_source: envelope.text_source,
    text_reliable: envelope.text_reliable === true,
    provenance_receipt: receipt,
    evidence_lineage: owns(metadata, "evidence_lineage") ? metadata.evidence_lineage : null,
    family_of: owns(metadata, "family_of") ? metadata.family_of : null,
    part_of: owns(metadata, "part_of") ? metadata.part_of : null,
  }));
  return Object.freeze({
    provenance_receipt_version: PROVENANCE_RECEIPT_VERSION,
    provenance_receipt_status: receipt.status,
    provenance_receipt_reason: receipt.reason,
    provenance_receipt_digest: digest,
  });
}

function receiptFromMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const receipt = metadata.provenance_receipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return null;
  const keys = Object.keys(receipt).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["reason", "root_ids", "status", "version"])) return null;
  if (receipt.version !== PROVENANCE_RECEIPT_VERSION || !STATUS_SET.has(receipt.status) ||
      !REASON_SET.has(receipt.reason)) return null;
  const coherentReason = receipt.status === "complete"
    ? receipt.reason === "lineage_and_text_recorded"
    : receipt.status === "unavailable"
      ? receipt.reason === "provenance_unavailable"
      : receipt.reason === "text_provenance_unavailable" || receipt.reason === "lineage_unavailable";
  if (!coherentReason) return null;
  const roots = normalizedRootIds(receipt.root_ids);
  if (!roots || JSON.stringify(roots) !== JSON.stringify(receipt.root_ids)) return null;
  return { ...receipt, root_ids: roots };
}

const TEXT_SOURCE_FIDELITY = Object.freeze({
  unknown: 0,
  ocr_partial: 1,
  ocr: 2,
  native: 3,
});

/** Refuse a reingest that changes family identity or weakens known provenance. */
export function provenanceReceiptTransitionError(priorMetadata, incomingMetadata, {
  priorTextSource = "unknown",
  priorTextReliable = false,
  incomingTextSource = "unknown",
  incomingTextReliable = false,
  sameContent = false,
  priorProvenanceAssessed = undefined,
} = {}) {
  const prior = receiptFromMetadata(priorMetadata);
  const incoming = receiptFromMetadata(incomingMetadata);
  // Metadata alone cannot prove that receipt roots match the persisted row's
  // source/family identity. The caller must first validate the whole stored
  // row with storedProvenanceAssessment and opt in explicitly. This avoids
  // treating migration-0020 columns or a merely receipt-shaped JSON object as
  // extraction proof.
  const priorIsProof = priorProvenanceAssessed === true && Boolean(prior);
  if (priorIsProof) {
    if (!incoming) return "an existing provenance receipt cannot be removed or replaced with an invalid receipt";
    if (JSON.stringify(prior.root_ids) !== JSON.stringify(incoming.root_ids)) {
      return "a reingest cannot change the document's recorded provenance family";
    }
    const rank = { unavailable: 0, partial: 1, complete: 2 };
    if (rank[incoming.status] < rank[prior.status]) {
      return "a reingest cannot downgrade the document's recorded provenance assessment";
    }
  }

  const priorSource = TEXT_SOURCES.has(priorTextSource) ? priorTextSource : "unknown";
  const incomingSource = TEXT_SOURCES.has(incomingTextSource) ? incomingTextSource : "unknown";
  const priorReliable = priorTextReliable === true || priorTextReliable === 1 || priorTextReliable === "1";
  const incomingReliable = incomingTextReliable === true || incomingTextReliable === 1 || incomingTextReliable === "1";
  // A PROVEN prior origin must never disappear. Migration 0020 populated bare
  // native/1 columns without receipts; those are intentionally not proof and
  // must remain free to normalize to explicit unknown on the first reingest.
  if (priorIsProof && priorSource !== "unknown" && incomingSource === "unknown") {
    return "a reingest cannot erase recorded text provenance";
  }
  // `documents.content_hash` also includes chunk geometry, so it is not a
  // dependable same-text comparison across upgrades. The P0 rule is therefore
  // intentionally stronger: an established extraction origin never weakens
  // under the same durable document identity. A genuinely different artifact
  // must use its own source identity instead of overwriting stronger proof.
  void sameContent;
  if (priorIsProof && TEXT_SOURCE_FIDELITY[incomingSource] < TEXT_SOURCE_FIDELITY[priorSource]) {
    return "a reingest cannot downgrade recorded text-source fidelity";
  }
  if (priorIsProof && priorReliable && !incomingReliable) {
    return "a reingest cannot downgrade recorded text reliability";
  }
  return null;
}

function jsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function storedEnvelope(row = {}) {
  const metadata = jsonObject(
    row.authority_meta ?? row._authority_meta ?? row.meta ?? row.metadata,
  );
  const source = String(row.source || row.source_type || "").trim();
  const carriedId = String(row.source_id || "").trim();
  const docUid = String(row.doc_uid || "").trim();
  const sourceId = carriedId || (
    source && docUid.startsWith(`${source}:`) ? docUid.slice(source.length + 1) : ""
  );
  return {
    source_type: source,
    source_id: sourceId,
    content: "",
    text_source: TEXT_SOURCES.has(row.text_source) ? row.text_source : "unknown",
    text_reliable: row.text_reliable === true || row.text_reliable === 1 || row.text_reliable === "1",
    metadata: metadata || {},
  };
}

/**
 * Gate provenance read from a persisted row. Migration 0020 populated the
 * legacy columns with native/1, so those columns alone are not proof. Only a
 * receipt that validates against the same row can expose the stored claim.
 */
export function storedProvenanceAssessment(row = {}) {
  const envelope = storedEnvelope(row);
  const error = provenanceReceiptValidationError(envelope);
  if (error) {
    return {
      provenance_assessed: false,
      provenance_status: "unavailable",
      provenance_reason: "provenance_receipt_missing_or_invalid",
      text_source: "unknown",
      text_reliable: false,
    };
  }
  return {
    provenance_assessed: true,
    provenance_status: envelope.metadata.provenance_receipt.status,
    provenance_reason: envelope.metadata.provenance_receipt.reason,
    text_source: envelope.text_source,
    text_reliable: envelope.text_reliable,
  };
}

/**
 * Cheap marker-shape gate for synchronous callers. A legacy row with a valid-
 * looking receipt but no shared-boundary marker is deliberately not proven.
 */
export function hasStoredProvenanceMarker(row = {}, assessment = storedProvenanceAssessment(row)) {
  return Boolean(
    assessment?.provenance_assessed === true &&
    Number(row.provenance_receipt_version) === PROVENANCE_RECEIPT_VERSION &&
    row.provenance_receipt_status === assessment.provenance_status &&
    row.provenance_receipt_reason === assessment.provenance_reason &&
    /^[a-f0-9]{64}$/.test(String(row.provenance_receipt_digest || ""))
  );
}

/** Recompute the bounded row's marker before exposing individual provenance. */
export async function storedProvenanceMarkerAssessment(row = {}) {
  const assessment = storedProvenanceAssessment(row);
  if (!hasStoredProvenanceMarker(row, assessment)) {
    return {
      provenance_assessed: false,
      provenance_marker_valid: false,
      provenance_status: "unavailable",
      provenance_reason: "provenance_receipt_unassessed",
      text_source: "unknown",
      text_reliable: false,
    };
  }
  const expected = await provenanceAssessmentMarker(storedEnvelope(row));
  if (expected.provenance_receipt_digest !== row.provenance_receipt_digest) {
    return {
      provenance_assessed: false,
      provenance_marker_valid: false,
      provenance_status: "unavailable",
      provenance_reason: "provenance_receipt_unassessed",
      text_source: "unknown",
      text_reliable: false,
    };
  }
  return { ...assessment, provenance_marker_valid: true };
}
