/**
 * Evidence derivation and corroboration lineage.
 *
 * Retrieval relevance and evidence independence are different questions. A
 * generated summary can be an excellent hit and can accurately quote a
 * ledger, but the two are still one source family. This module keeps that
 * relationship out of ranking while making it available to the answer and
 * confidence paths.
 *
 * Root identifiers are deliberately private. They may contain durable source
 * ids outside the caller's current scope, so public responses receive only the
 * bounded status object. The non-enumerable symbol survives the Worker path
 * without being serialized by JSON.stringify.
 */

export const EVIDENCE_LINEAGE_VERSION = 1;
export const EVIDENCE_LINEAGE_KINDS = Object.freeze([
  "source_record",
  "derived_record",
  "agent_derived",
]);

const KIND_SET = new Set(EVIDENCE_LINEAGE_KINDS);
const MAX_ROOT_IDS = 16;
const MAX_ROOT_ID_CHARS = 512;
const CONTROL = /[\u0000-\u001f\u007f]/;
const AGENT_MARKER = /^Evidence-Lineage:[ \t]*agent-derived[ \t]*$/im;
const AGENT_WRITERS = new Set(["agent", "connector"]);
const DIRECT_CONNECTOR_KINDS = new Set([
  "bank", "bank-feed", "billing_system", "plaid", "qbo", "quickbooks",
  "stripe", "subscription_system", "xero",
]);
const ROOTS = Symbol("evidence-lineage-roots");

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

function sourceKind(row) {
  if (Object.hasOwn(row || {}, "source_kind")) {
    return String(row?.source_kind || "unregistered").toLowerCase().trim() || "unregistered";
  }
  return String(row?.source || "").toLowerCase().trim();
}

function documentUid(row) {
  const carried = String(row?.doc_uid || "").trim();
  if (carried) return carried;
  const source = String(row?.source || "").trim();
  const id = String(row?.source_id || row?.ref_key || "").trim();
  return source && id ? `${source}:${id}` : "";
}

function validRootId(value) {
  return typeof value === "string" && value.length > 0 &&
    value.length <= MAX_ROOT_ID_CHARS && !CONTROL.test(value);
}

function normalizedRootIds(value) {
  if (!Array.isArray(value) || value.length > MAX_ROOT_IDS || value.some((id) => !validRootId(id))) {
    return null;
  }
  return [...new Set(value.map((id) => id.trim()).filter(Boolean))].sort();
}

/** Return a plain validation error for a newly submitted metadata contract. */
export function evidenceLineageValidationError(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
      !Object.hasOwn(metadata, "evidence_lineage")) return null;
  const lineage = metadata.evidence_lineage;
  if (!lineage || typeof lineage !== "object" || Array.isArray(lineage)) {
    return "metadata.evidence_lineage must be an object";
  }
  const allowed = new Set(["version", "kind", "root_ids"]);
  if (Object.keys(lineage).some((key) => !allowed.has(key))) {
    return "metadata.evidence_lineage accepts only version, kind and root_ids";
  }
  if (lineage.version !== EVIDENCE_LINEAGE_VERSION) {
    return `metadata.evidence_lineage.version must be ${EVIDENCE_LINEAGE_VERSION}`;
  }
  if (!KIND_SET.has(lineage.kind)) {
    return `metadata.evidence_lineage.kind must be one of: ${EVIDENCE_LINEAGE_KINDS.join(" | ")}`;
  }
  const roots = lineage.root_ids === undefined ? [] : normalizedRootIds(lineage.root_ids);
  if (!roots) {
    return `metadata.evidence_lineage.root_ids must contain at most ${MAX_ROOT_IDS} printable strings of at most ${MAX_ROOT_ID_CHARS} characters`;
  }
  if (lineage.kind === "derived_record" && roots.length === 0) {
    return "metadata.evidence_lineage.root_ids is required for a derived_record";
  }
  if (lineage.kind === "source_record" && roots.length > 0 && roots.length !== 1) {
    return "metadata.evidence_lineage.source_record may name at most one root id";
  }
  return null;
}

function publicLineage(kind, status, reason) {
  return Object.freeze({
    kind,
    status,
    derived: kind === "derived_record" || kind === "agent_derived",
    reason,
  });
}

function result(kind, roots, reason) {
  const rootIds = Array.isArray(roots) ? [...new Set(roots)].sort() : [];
  return {
    lineage: publicLineage(kind, rootIds.length ? "known" : "unknown", reason),
    root_ids: rootIds,
  };
}

/**
 * Assess lineage from durable metadata and provenance that the product itself
 * controls. Titles and filenames are intentionally absent from this decision.
 */
export function evidenceLineageFor(row = {}, { trustedSourceRecord = false } = {}) {
  const metadata = jsonObject(row.authority_meta ?? row._authority_meta) || {};
  const raw = metadata.evidence_lineage;
  const contractError = Object.hasOwn(metadata, "evidence_lineage")
    ? evidenceLineageValidationError(metadata)
    : null;
  const contract = !contractError && raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  const contractRoots = contract
    ? normalizedRootIds(contract.root_ids === undefined ? [] : contract.root_ids) || []
    : [];
  const head = String(
    row.authority_document_head ?? row._authority_document_head ?? row.text ?? row.snippet ?? "",
  );
  const agentMarked = AGENT_WRITERS.has(String(metadata.written_by || "").toLowerCase().trim()) ||
    AGENT_MARKER.test(head);

  // A product-authored marker is a one-way demotion. A copied agent note may
  // lose its JSON metadata during export and reingest, but this header remains
  // in its native text and prevents it from becoming primary by its new name.
  if (agentMarked) {
    const roots = contract?.kind === "agent_derived" ? contractRoots : [];
    return result(
      "agent_derived",
      roots,
      roots.length
        ? `agent-written material derived from ${roots.length} recorded source ${roots.length === 1 ? "family" : "families"}; it does not independently corroborate them`
        : "agent-written material whose source family was not recorded; it remains useful context, not independent corroboration",
    );
  }

  if (contractError) {
    return result("unclassified", [], `invalid lineage metadata: ${contractError}`);
  }
  if (contract?.kind === "derived_record") {
    return result(
      "derived_record",
      contractRoots,
      `prepared from ${contractRoots.length} recorded source ${contractRoots.length === 1 ? "family" : "families"}; it does not independently corroborate them`,
    );
  }
  if (contract?.kind === "agent_derived") {
    return result(
      "agent_derived",
      contractRoots,
      contractRoots.length
        ? `agent-written material derived from ${contractRoots.length} recorded source ${contractRoots.length === 1 ? "family" : "families"}; it does not independently corroborate them`
        : "agent-written material whose source family was not recorded; it remains useful context, not independent corroboration",
    );
  }

  const uid = documentUid(row);
  const family = validRootId(metadata.family_of) ? String(metadata.family_of).trim() : "";
  if (contract?.kind === "source_record") {
    const roots = contractRoots.length ? contractRoots : family ? [family] : uid ? [uid] : [];
    return result(
      "source_record",
      roots,
      roots.length
        ? "direct source record with a recorded derivation family"
        : "declared direct source record, but its derivation family could not be identified",
    );
  }

  // Only a registered connector kind earns this implicit source declaration.
  // Falling back from a customer-chosen source name is useful for old tier
  // display code, but it is not enough to prove an independent derivation
  // family.
  const registeredDirectConnector = Object.hasOwn(row || {}, "source_kind") &&
    DIRECT_CONNECTOR_KINDS.has(sourceKind(row));
  if (trustedSourceRecord || registeredDirectConnector) {
    const roots = family ? [family] : uid ? [uid] : [];
    return result(
      "source_record",
      roots,
      roots.length
        ? "direct record from a provenance-controlled source"
        : "direct provenance-controlled record, but its derivation family could not be identified",
    );
  }

  if (family) {
    return result(
      "unclassified",
      [family],
      "physical document family is recorded, but whether this is a source or derived record is not",
    );
  }
  return result(
    "unclassified",
    [],
    "derivation family was not recorded; this document may support what it directly says but cannot count as independent corroboration",
  );
}

/** Attach private root ids without adding them to an API response. */
export function attachEvidenceLineage(target, assessment) {
  Object.defineProperty(target, ROOTS, {
    value: Object.freeze([...(assessment?.root_ids || [])]),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return target;
}

/** Read private lineage roots from a search row or an internal answer row. */
export function evidenceLineageRootIds(row = {}) {
  if (Array.isArray(row[ROOTS])) return [...row[ROOTS]];
  if (Array.isArray(row._lineage_root_ids)) return [...row._lineage_root_ids];
  const publicTokens = row?.lineage?.status === "known" && Array.isArray(row.lineage.family_tokens)
    ? row.lineage.family_tokens.filter((token) => typeof token === "string" && token)
    : [];
  if (publicTokens.length) return publicTokens.map((token) => `public:${token}`);
  return [];
}

/**
 * Add opaque family tokens after retrieval. The tokens reveal only which
 * results share roots, not the durable ids of any parent documents.
 */
export async function annotateLineageFamilyTokens(rows = []) {
  const withRoots = rows
    .map((row) => ({ row, roots: evidenceLineageRootIds(row) }))
    .filter((item) => item.roots.length);
  const uniqueRoots = [...new Set(withRoots.flatMap((item) => item.roots))];
  // Number roots only within this result set. A stable digest would let a
  // scoped reader compare a hidden parent id across otherwise unrelated
  // searches, and predictable provider ids could be guessed offline. The
  // answer path needs only response-local equality.
  const tokenByRoot = new Map(uniqueRoots.map((root, index) => [root, `family-${index + 1}`]));
  withRoots.forEach((item) => {
    item.row.lineage = Object.freeze({
      ...item.row.lineage,
      family_tokens: Object.freeze(item.roots.map((root) => tokenByRoot.get(root)).sort()),
    });
  });
  return rows;
}

/**
 * Count connected source families, not filenames or citation ids. Any overlap
 * joins two records into the same derivation component. Unknown rows earn no
 * independence credit.
 */
export function independentEvidenceSummary(rows = []) {
  const sets = rows.map((row) => [...new Set(evidenceLineageRootIds(row))]).filter((roots) => roots.length);
  const parent = sets.map((_, index) => index);
  const find = (index) => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (left, right) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent[b] = a;
  };
  const ownerByRoot = new Map();
  sets.forEach((roots, index) => {
    for (const root of roots) {
      if (ownerByRoot.has(root)) union(index, ownerByRoot.get(root));
      else ownerByRoot.set(root, index);
    }
  });
  return {
    groups: new Set(sets.map((_, index) => find(index))).size,
    known_documents: sets.length,
    unknown_documents: Math.max(0, rows.length - sets.length),
  };
}
