function objectFromJson(value) {
  if (!value) return {};
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export const MAX_CLEANUP_LOCATION_REFERENCES = 1000;

const FIELD_LIMITS = Object.freeze({
  source: 64,
  source_id: 512,
  title: 512,
  uri: 2048,
});

function boundedString(value, limit, { required = false } = {}) {
  if (value == null) return required ? undefined : null;
  if (typeof value !== "string" || value.length > limit || (required && value.length === 0)) {
    return undefined;
  }
  return value;
}

/** Project one private value onto the exact citation-safe wire shape. */
export function cleanupLocationReference(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = boundedString(value.source, FIELD_LIMITS.source, { required: true });
  const sourceId = boundedString(value.source_id, FIELD_LIMITS.source_id, { required: true });
  const title = boundedString(value.title, FIELD_LIMITS.title);
  const uri = boundedString(value.uri, FIELD_LIMITS.uri);
  if (source === undefined || sourceId === undefined || title === undefined || uri === undefined) return null;
  return { source, source_id: sourceId, title, uri };
}

/** Only citation-safe location fields are allowed out of private document metadata. */
export function cleanupLocationReferences(value) {
  const refs = objectFromJson(value).cleanup_location_references;
  // A malformed or oversized legacy collection is not partially disclosed.
  // Cleanup itself refuses to create one, so every stored cleanup reference is
  // returned and citations never lose locations behind an undocumented cap.
  if (!Array.isArray(refs) || refs.length > MAX_CLEANUP_LOCATION_REFERENCES) return [];
  return refs.flatMap((item) => {
    const projected = cleanupLocationReference(item);
    return projected ? [projected] : [];
  });
}
