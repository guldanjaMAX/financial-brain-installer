import { symlinkSync } from "node:fs";

export const SYMLINK_PRIVILEGE_UNAVAILABLE_REASON =
  "symlink privilege unavailable on this account";

const PRIVILEGE_ERRORS = new Set(["EACCES", "EPERM"]);

function isPrivilegeUnavailable(error) {
  return PRIVILEGE_ERRORS.has(error?.code);
}

/**
 * Create one hostile-link fixture without turning an ordinary Windows account
 * into a file-wide test failure. Directory cases retain refusal coverage by
 * retrying the same fixture as an unprivileged Windows junction.
 */
export function createTestSymlink({
  target,
  path,
  type,
  platform = process.platform,
  symlink = symlinkSync,
  onSkip,
}) {
  const attempt = (linkType) => {
    symlink(target, path, linkType);
    return { created: true, type: linkType ?? null };
  };

  try {
    return attempt(type);
  } catch (error) {
    if (!isPrivilegeUnavailable(error)) throw error;
  }

  if (platform === "win32" && type === "dir") {
    try {
      return attempt("junction");
    } catch (error) {
      if (!isPrivilegeUnavailable(error)) throw error;
    }
  }

  if (typeof onSkip !== "function") {
    throw new TypeError("a symlink fixture privilege failure requires an onSkip callback");
  }
  onSkip(SYMLINK_PRIVILEGE_UNAVAILABLE_REASON);
  return { created: false, type: null };
}
