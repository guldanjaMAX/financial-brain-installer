export const DRIVE_STORED_FAMILY_UID_MAX_BYTES = 256;

/**
 * Validate a stored logical-family identity without rewriting it. Drive
 * provider ids are printable ASCII only; other source namespaces retain their
 * existing opaque, non-control identity contract, including spaces.
 */
export function isCanonicalStoredFamilyUid(value, source = null) {
  if (typeof value !== "string") return false;
  const separator = value.indexOf(":");
  if (separator < 1) return false;
  const uidSource = value.slice(0, separator);
  const sourceId = value.slice(separator + 1);
  if (source !== null && uidSource !== source) return false;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(uidSource)) return false;
  if (uidSource === "drive") {
    return new TextEncoder().encode(value).length <= DRIVE_STORED_FAMILY_UID_MAX_BYTES &&
      /^[\x21-\x7e]+$/.test(sourceId);
  }
  return /^[^\u0000-\u001f\u007f-\u009f]+$/u.test(sourceId);
}
