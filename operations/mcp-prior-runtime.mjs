import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

// These six releases carried the same reviewed bytes. Keep their hash boundary
// even though later releases use a locator-bound replacement rule.
const PRIOR_INSTALLER_MCP_RUNTIME_SHA256 = Object.freeze({
  "0.4.0": "7de0808beebd990df4affb5e146baf6c5f484ff379471dbe1392affed742e47a",
  "0.4.1": "7de0808beebd990df4affb5e146baf6c5f484ff379471dbe1392affed742e47a",
  "0.4.2": "7de0808beebd990df4affb5e146baf6c5f484ff379471dbe1392affed742e47a",
  "0.4.3": "7de0808beebd990df4affb5e146baf6c5f484ff379471dbe1392affed742e47a",
  "0.4.4": "7de0808beebd990df4affb5e146baf6c5f484ff379471dbe1392affed742e47a",
  "0.4.5": "7de0808beebd990df4affb5e146baf6c5f484ff379471dbe1392affed742e47a",
});
const NUMBER = "(?:0|[1-9][0-9]*)";
const PRERELEASE = "(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)";
const SEMVER = `${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-${PRERELEASE}(?:\\.${PRERELEASE})*)?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?`;
const SEMVER_PATTERN = new RegExp(`^${SEMVER}$`);
const SESSION_SUFFIX = "(?:-(?:[0-9]{8}|[0-9]{4}-[0-9]{2}-[0-9]{2})(?:-[0-9]{6})?|\\.parked-[0-9a-z]+(?:[.-][0-9a-z]+)*)?";
const INSTALLER_PREFIX = new RegExp(`^(?:\\.financial-brain|financialbrain|\\.financial-brain-v${SEMVER}|\\.financial-brain-owner-session-[0-9]{4}${SESSION_SUFFIX}/install)$`, "i");

function semverParts(value) {
  if (typeof value !== "string" || !SEMVER_PATTERN.test(value)) return null;
  const [core, prerelease] = value.split("+", 1)[0].split(/-(.*)/s);
  return { core: core.split(".").map(BigInt), prerelease: prerelease?.split(".") ?? [] };
}

function compareSemver(left, right) {
  for (let index = 0; index < 3; index++) {
    if (left.core[index] !== right.core[index]) return left.core[index] < right.core[index] ? -1 : 1;
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    return left.prerelease.length ? -1 : right.prerelease.length ? 1 : 0;
  }
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index++) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === b) continue;
    if (a === undefined || b === undefined) return a === undefined ? -1 : 1;
    const numericA = /^[0-9]+$/.test(a);
    const numericB = /^[0-9]+$/.test(b);
    if (numericA && numericB) return BigInt(a) < BigInt(b) ? -1 : 1;
    if (numericA !== numericB) return numericA ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

function structuralPriorVersion(version, runningVersion) {
  const prior = semverParts(version);
  const current = semverParts(runningVersion);
  return Boolean(prior && current) && compareSemver(prior, semverParts("0.4.6")) >= 0 &&
    compareSemver(prior, current) < 0;
}

function priorInstallerPackageRoot(runtimePath) {
  if (typeof runtimePath !== "string" || !isAbsolute(runtimePath) ||
      runtimePath !== resolve(runtimePath) ||
      basename(runtimePath) !== "brain-mcp.mjs" || basename(dirname(runtimePath)) !== "components") return null;
  const packageRoot = dirname(dirname(resolve(runtimePath)));
  const nodeModules = dirname(packageRoot);
  if (basename(packageRoot) !== "brain-installer" || basename(nodeModules) !== "node_modules") return null;
  const container = dirname(nodeModules);
  const prefix = basename(container).toLowerCase() === "lib" ? dirname(container) : container;
  const prefixShape = basename(prefix).toLowerCase() === "install"
    ? `${basename(dirname(prefix))}/${basename(prefix)}` : basename(prefix);
  return INSTALLER_PREFIX.test(prefixShape) ? packageRoot : null;
}

function pathHasNoSymlinks(path) {
  for (let cursor = resolve(path); ; cursor = dirname(cursor)) {
    if (lstatSync(cursor).isSymbolicLink()) return false;
    if (dirname(cursor) === cursor) return true;
  }
}

function sameOpenedFile(before, opened) {
  return before.isFile() && opened.isFile() && before.dev === opened.dev &&
    before.ino === opened.ino && before.uid === opened.uid && before.gid === opened.gid &&
    before.mode === opened.mode && before.size === opened.size && before.nlink === 1 && opened.nlink === 1;
}

/** Read metadata only. Acceptance permits replacing this path, never running it. */
export function recognizedPriorInstallerRuntime(runtimePath, { runningVersion, allowStructural = false } = {}) {
  const packageRoot = priorInstallerPackageRoot(runtimePath);
  if (!packageRoot) return false;
  try {
    const packageRootStat = lstatSync(packageRoot);
    const runtimeStat = lstatSync(runtimePath);
    const canonicalRuntime = resolve(realpathSync(runtimePath));
    if (!packageRootStat.isDirectory() || packageRootStat.isSymbolicLink() ||
        !runtimeStat.isFile() || runtimeStat.isSymbolicLink() || runtimeStat.nlink !== 1 ||
        runtimeStat.size > 16 * 1024 * 1024 ||
        (typeof process.getuid === "function" &&
          (packageRootStat.uid !== process.getuid() || runtimeStat.uid !== process.getuid())) ||
        !priorInstallerPackageRoot(canonicalRuntime) || !pathHasNoSymlinks(runtimePath)) return false;
    const runtimeFd = openSync(runtimePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    let runtimeBytes;
    try {
      const openedRuntime = fstatSync(runtimeFd);
      if (!sameOpenedFile(runtimeStat, openedRuntime)) return false;
      runtimeBytes = readFileSync(runtimeFd);
      if (runtimeBytes.length !== openedRuntime.size) return false;
    } finally {
      closeSync(runtimeFd);
    }
    const packagePath = join(packageRoot, "package.json");
    const before = lstatSync(packagePath);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 64 * 1024 ||
        (typeof process.getuid === "function" && before.uid !== process.getuid())) return false;
    const fd = openSync(packagePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const opened = fstatSync(fd);
      if (!sameOpenedFile(before, opened)) return false;
      const bytes = readFileSync(fd);
      if (bytes.length !== opened.size) return false;
      const pkg = JSON.parse(bytes.toString("utf8"));
      if (pkg?.name !== "brain-installer" || typeof pkg.version !== "string") return false;
      if (Object.hasOwn(PRIOR_INSTALLER_MCP_RUNTIME_SHA256, pkg.version)) {
        return createHash("sha256").update(runtimeBytes).digest("hex") ===
          PRIOR_INSTALLER_MCP_RUNTIME_SHA256[pkg.version];
      }
      // Later kits have no complete fingerprint catalogue. The caller must
      // prove the exact current owner locator before this bounded replacement.
      return allowStructural && structuralPriorVersion(pkg.version, runningVersion);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}
