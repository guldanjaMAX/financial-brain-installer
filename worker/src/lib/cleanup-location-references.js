function objectFromJson(value) {
  if (!value) return {};
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Only citation-safe location fields are allowed out of private document metadata. */
export function cleanupLocationReferences(value) {
  const refs = objectFromJson(value).cleanup_location_references;
  if (!Array.isArray(refs)) return [];
  return refs.flatMap((item) => {
    if (!item || typeof item !== "object" || !item.source || !item.source_id) return [];
    return [{
      source: String(item.source),
      source_id: String(item.source_id),
      title: item.title == null ? null : String(item.title),
      uri: item.uri == null ? null : String(item.uri),
    }];
  }).slice(0, 50);
}
