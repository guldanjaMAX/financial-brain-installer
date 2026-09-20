/** Shared validation for every corpus ingest door, including Zoom. */

import { evidenceLineageValidationError } from "./evidence-lineage.js";
import { parseCanonicalEvidenceDate } from "./query-intent.js";
import { provenanceReceiptValidationError, TEXT_SOURCES } from "./provenance-receipt.js";
import {
  normalizeSourceOriginalLocator,
  normalizeSourceOriginalReceipt,
} from "./source-original-binding.js";

const INGEST_SOURCE_TYPE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const INGEST_DATE_SOURCE_MAX_CHARS = 200;
const INGEST_DATE_SOURCE_CONTROL = /[\u0000-\u001f\u007f]/;

const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

/** Validate the optional private exact-byte attestation and its family shape. */
export function sourceOriginalReceiptValidationError(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) ||
      !owns(envelope, "source_original_receipt")) return null;

  let receipt;
  try {
    receipt = normalizeSourceOriginalReceipt(envelope.source_original_receipt);
  } catch (error) {
    return String(error?.message || "source original receipt is invalid");
  }

  const metadata = envelope.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return "metadata must be an object";
  }
  if (owns(metadata, "family_of")) {
    return "source original receipt cannot bind an ambiguous multi-record family_of export";
  }

  const structuralFields = ["part", "part_count", "part_of"];
  const structural = structuralFields.some((field) => owns(metadata, field));
  let locator = envelope.source_id;
  if (structural) {
    if (!structuralFields.every((field) => owns(metadata, field)) ||
        !Number.isSafeInteger(metadata.part) || metadata.part < 1 ||
        !Number.isSafeInteger(metadata.part_count) || metadata.part_count < 2 ||
        metadata.part > metadata.part_count || typeof metadata.part_of !== "string" ||
        envelope.source_id !== `${metadata.part_of}#part${metadata.part}of${metadata.part_count}`) {
      return "source original receipt requires one exact structural #partNofM family";
    }
    locator = metadata.part_of;
  }

  try {
    normalizeSourceOriginalLocator(receipt.locator_kind, locator);
  } catch (error) {
    return String(error?.message || "source original locator is invalid");
  }
  return null;
}

export function ingestEnvelopeValidationError(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return "ingest body must be a document object";
  }
  if (typeof envelope.source_type !== "string" || !INGEST_SOURCE_TYPE.test(envelope.source_type)) {
    return "source_type must be 1-64 lowercase letters, digits, hyphens or underscores, starting with a letter or digit";
  }
  if (typeof envelope.source_id !== "string" || !envelope.source_id.trim()) {
    return "source_id must be a non-empty string";
  }
  if (typeof envelope.content !== "string") return "content must be a string";
  if (!envelope.metadata || typeof envelope.metadata !== "object" || Array.isArray(envelope.metadata)) {
    return "metadata must be an object";
  }
  const lineageError = evidenceLineageValidationError(envelope.metadata);
  if (lineageError) return lineageError;

  const occurredAt = envelope.occurred_at;
  const hasOccurredAt = occurredAt !== undefined && occurredAt !== null;
  if (hasOccurredAt &&
      (typeof occurredAt !== "string" || parseCanonicalEvidenceDate(occurredAt) === null)) {
    return "occurred_at must be YYYY-MM-DD, an RFC 3339 timestamp, or null";
  }

  const dateSource = envelope.date_source;
  const hasDateSource = dateSource !== undefined && dateSource !== null;
  if (hasDateSource &&
      (typeof dateSource !== "string" || !dateSource.trim() ||
       dateSource.length > INGEST_DATE_SOURCE_MAX_CHARS || INGEST_DATE_SOURCE_CONTROL.test(dateSource))) {
    return `date_source must be a non-empty string of at most ${INGEST_DATE_SOURCE_MAX_CHARS} characters or null`;
  }

  if (envelope.date_reliable !== undefined && typeof envelope.date_reliable !== "boolean") {
    return "date_reliable must be a boolean when provided";
  }
  if (envelope.date_reliable === true &&
      (!hasOccurredAt || !hasDateSource || dateSource.trim().toLowerCase() === "none")) {
    return "date_reliable true requires occurred_at and a specific date_source";
  }

  if (typeof envelope.text_source !== "string" || !TEXT_SOURCES.has(envelope.text_source)) {
    return "text_source must be native, ocr, ocr_partial or unknown";
  }
  if (typeof envelope.text_reliable !== "boolean") {
    return "text_reliable must be a boolean";
  }
  if (envelope.text_source === "unknown" && envelope.text_reliable) {
    return "text_source unknown requires text_reliable false";
  }
  const sourceOriginalError = sourceOriginalReceiptValidationError(envelope);
  if (sourceOriginalError) return sourceOriginalError;
  return provenanceReceiptValidationError(envelope);
}
