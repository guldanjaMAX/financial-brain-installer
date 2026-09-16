// npm builds the release once on Linux. A Windows checkout is a consumer, not
// a package producer: NTFS does not retain the POSIX executable bit from npm's
// installed dependency tree, so a Windows-local `npm pack` writes the one
// nested dependency bin as 0644 instead of its reviewed registry mode 0755.
//
// Keep that host-only limitation inside test fixtures. Each helper accepts
// exactly that one known loss and changes nothing on another platform. The
// strict production bundle verifier still compares every archive mode exactly.
export const WINDOWS_LOCAL_PACK_EXECUTABLE =
  "node_modules/@e965/xlsx/bin/xlsx.njs";

function normalizeOne(entries, sizeKey, { platform = process.platform } = {}) {
  if (platform !== "win32") return Object.freeze({ entries, normalized: false });
  if (!Array.isArray(entries)) throw new Error("Windows local pack fixture has no entries");
  const matches = entries.filter((entry) => entry?.path === WINDOWS_LOCAL_PACK_EXECUTABLE);
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0]?.[sizeKey]) ||
      matches[0][sizeKey] < 0 || matches[0]?.mode !== 0o644) {
    throw new Error("Windows local pack fixture has an unexpected nested-bin mode delta");
  }
  const normalized = entries.map((entry) => entry === matches[0]
    ? { ...entry, mode: 0o755 }
    : entry);
  return Object.freeze({ entries: Object.freeze(normalized), normalized: true });
}

export function normalizeWindowsLocalPackMetadata(metadata, options = {}) {
  const result = normalizeOne(metadata?.files, "size", options);
  return Object.freeze({
    metadata: result.normalized ? { ...metadata, files: result.entries } : metadata,
    normalized: result.normalized,
  });
}

export function normalizeWindowsLocalPackRows(rows, options = {}) {
  const result = normalizeOne(rows, "bytes", options);
  return Object.freeze({ rows: result.entries, normalized: result.normalized });
}
