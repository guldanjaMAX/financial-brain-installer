/**
 * Fail-closed verification for the dependencies embedded in the npm package.
 *
 * npm silently omits bundleDependencies that are not installed, and it can
 * include extra files that appear inside an installed bundled dependency.
 * The reviewed manifest is therefore derived from the exact package-lock
 * integrity archives, not from the mutable node_modules tree. Verification
 * compares both npm's pack metadata and the final tarball with that manifest.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { gunzipSync } from "node:zlib";
import {
  UPDATE_RUNTIME_IDENTITY_SCHEME,
  deriveUpdateRuntimePayloadSha256,
} from "./update-preview.mjs";

export const REVIEWED_BUNDLE_MANIFEST_RELATIVE =
  "privacy/reviewed-package-bundles.json";

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
const MAX_FILES = 20_000;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const WINDOWS_FORBIDDEN_RE = /[<>:"|?*]/u;
const WINDOWS_RESERVED_RE = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;
const SHA1_RE = /^[a-f0-9]{40}$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
const USTAR_MAGIC_VERSION = Buffer.from([0x75, 0x73, 0x74, 0x61, 0x72, 0, 0x30, 0x30]);
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export class PackageBundleVerificationError extends Error {
  constructor(code) {
    super(code);
    this.name = "PackageBundleVerificationError";
    this.code = code;
  }
}

function refuse(code = "PACKAGE_BUNDLE_CONTRACT_INVALID") {
  throw new PackageBundleVerificationError(code);
}

function digest(algorithm, value) {
  return createHash(algorithm).update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function identity(info) {
  return {
    dev: info.dev,
    ino: info.ino,
    nlink: info.nlink,
    size: info.size,
    mode: info.mode,
    uid: info.uid,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
  };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino &&
    left.nlink === right.nlink && left.size === right.size &&
    left.mode === right.mode && left.uid === right.uid &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function within(root, path) {
  const suffix = relative(root, path);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) &&
    !isAbsolute(suffix));
}

export function readStableRegularFile(pathInput, {
  root = null,
  maxBytes = MAX_ARCHIVE_BYTES,
  failureCode = "PACKAGE_BUNDLE_ARCHIVE_INVALID",
} = {}) {
  const path = resolve(pathInput);
  let descriptor;
  let raw;
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
        maxBytes > MAX_UNPACKED_BYTES) refuse(failureCode);
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
        before.size < 1 || before.size > maxBytes) refuse(failureCode);
    const canonicalPath = realpathSync(path);
    if (root && !within(realpathSync(root), canonicalPath)) refuse(failureCode);
    descriptor = openSync(path, fsConstants.O_RDONLY |
      (fsConstants.O_NOFOLLOW || 0) | (fsConstants.O_NONBLOCK || 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size < 1 ||
        opened.size > maxBytes ||
        !sameIdentity(identity(before), identity(opened))) refuse(failureCode);
    raw = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < raw.length) {
      const read = readSync(descriptor, raw, offset, raw.length - offset, offset);
      if (read < 1) refuse(failureCode);
      offset += read;
    }
    const probe = Buffer.alloc(1);
    try {
      if (readSync(descriptor, probe, 0, 1, raw.length) !== 0) refuse(failureCode);
    } finally {
      probe.fill(0);
    }
    const afterDescriptor = fstatSync(descriptor);
    const afterPath = lstatSync(path);
    if (!afterDescriptor.isFile() || afterDescriptor.nlink !== 1 ||
        !afterPath.isFile() || afterPath.isSymbolicLink() || afterPath.nlink !== 1 ||
        !sameIdentity(identity(opened), identity(afterDescriptor)) ||
        !sameIdentity(identity(opened), identity(afterPath)) ||
        realpathSync(path) !== canonicalPath) refuse(failureCode);
    return raw;
  } catch (error) {
    raw?.fill(0);
    if (error instanceof PackageBundleVerificationError) throw error;
    refuse(failureCode);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readJson(path, code) {
  let raw;
  try {
    raw = readStableRegularFile(path, { maxBytes: MAX_METADATA_BYTES, failureCode: code });
    return JSON.parse(raw.toString("utf8"));
  } catch (error) {
    if (error instanceof PackageBundleVerificationError) throw error;
    refuse(code);
  } finally {
    raw?.fill(0);
  }
}

function normalizeArchivePath(value, code = "PACKAGE_BUNDLE_ARCHIVE_INVALID") {
  if (typeof value !== "string") refuse(code);
  const path = value;
  const parts = path.split("/");
  if (!path || path !== path.normalize("NFC") || path.startsWith("/") ||
      path.includes("\\") || CONTROL_RE.test(path) ||
      WINDOWS_FORBIDDEN_RE.test(path) || parts.some(
        (part) => !part || part === "." || part === ".." ||
          /[. ]$/u.test(part) || WINDOWS_RESERVED_RE.test(part),
      )) refuse(code);
  return path;
}

function assertCanonicalPathSet(paths, code = "PACKAGE_BUNDLE_ARCHIVE_INVALID") {
  const files = new Set();
  const directories = new Set();
  for (const path of paths) {
    const key = path.toLowerCase().normalize("NFC");
    if (files.has(key) || directories.has(key)) refuse(code);
    const parts = key.split("/");
    for (let index = 1; index < parts.length; index++) {
      const ancestor = parts.slice(0, index).join("/");
      if (files.has(ancestor)) refuse(code);
      directories.add(ancestor);
    }
    files.add(key);
  }
  return true;
}

function parseOctal(bytes) {
  const text = bytes.toString("ascii").replace(/\0.*$/su, "").trim();
  if (!/^[0-7]+$/u.test(text)) refuse("PACKAGE_BUNDLE_ARCHIVE_INVALID");
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    refuse("PACKAGE_BUNDLE_ARCHIVE_INVALID");
  }
  return value;
}

function tarText(bytes) {
  const end = bytes.indexOf(0);
  try { return UTF8.decode(end < 0 ? bytes : bytes.subarray(0, end)); }
  catch { refuse("PACKAGE_BUNDLE_ARCHIVE_INVALID"); }
}

function verifyTarHeader(header) {
  if (header.length !== 512 ||
      !header.subarray(257, 265).equals(USTAR_MAGIC_VERSION)) {
    refuse("PACKAGE_BUNDLE_ARCHIVE_INVALID");
  }
  const expected = parseOctal(header.subarray(148, 156));
  let sum = 0;
  for (let index = 0; index < header.length; index++) {
    sum += index >= 148 && index < 156 ? 32 : header[index];
  }
  if (sum !== expected) refuse("PACKAGE_BUNDLE_ARCHIVE_INVALID");
}

/** Parse the deliberately narrow regular-file npm tarball shape. */
export function inspectNpmArchiveBytes(archive) {
  if (!Buffer.isBuffer(archive) || archive.length < 1 || archive.length > MAX_ARCHIVE_BYTES) {
    refuse("PACKAGE_BUNDLE_ARCHIVE_INVALID");
  }
  let tar;
  try { tar = gunzipSync(archive, { maxOutputLength: MAX_UNPACKED_BYTES }); }
  catch { refuse("PACKAGE_BUNDLE_ARCHIVE_INVALID"); }
  const rows = [];
  const seen = new Set();
  let packageJson = null;
  let offset = 0;
  let ended = false;
  try {
    if (tar.length < 3 * 512 || tar.length % 512 !== 0) {
      refuse("PACKAGE_BUNDLE_ARCHIVE_INVALID");
    }
    while (offset + 512 <= tar.length) {
      const header = tar.subarray(offset, offset + 512);
      if (header.every((byte) => byte === 0)) {
        if (offset + 1024 > tar.length ||
            !tar.subarray(offset, offset + 1024).every((byte) => byte === 0) ||
            !tar.subarray(offset + 1024).every((byte) => byte === 0)) {
          refuse("PACKAGE_BUNDLE_ARCHIVE_INVALID");
        }
        ended = true;
        break;
      }
      verifyTarHeader(header);
      const type = header[156];
      if (type !== 0 && type !== 0x30) refuse("PACKAGE_BUNDLE_ARCHIVE_INVALID");
      if (tarText(header.subarray(157, 257))) refuse("PACKAGE_BUNDLE_ARCHIVE_INVALID");
      const name = tarText(header.subarray(0, 100));
      const prefix = tarText(header.subarray(345, 500));
      const archivedPath = prefix ? `${prefix}/${name}` : name;
      if (!archivedPath.startsWith("package/")) refuse("PACKAGE_BUNDLE_ARCHIVE_INVALID");
      const path = normalizeArchivePath(archivedPath.slice("package/".length));
      if (seen.has(path) || rows.length >= MAX_FILES) {
        refuse("PACKAGE_BUNDLE_ARCHIVE_INVALID");
      }
      seen.add(path);
      const bytes = parseOctal(header.subarray(124, 136));
      const mode = parseOctal(header.subarray(100, 108));
      if (mode > 0o777) refuse("PACKAGE_BUNDLE_ARCHIVE_INVALID");
      const contentStart = offset + 512;
      const contentEnd = contentStart + bytes;
      const paddedEnd = contentStart + Math.ceil(bytes / 512) * 512;
      if (contentEnd > tar.length || paddedEnd > tar.length ||
          !tar.subarray(contentEnd, paddedEnd).every((byte) => byte === 0)) {
        refuse("PACKAGE_BUNDLE_ARCHIVE_INVALID");
      }
      const content = tar.subarray(contentStart, contentEnd);
      rows.push(Object.freeze({
        path,
        bytes,
        mode,
        sha256: digest("sha256", content),
      }));
      if (path === "package.json") {
        try { packageJson = JSON.parse(UTF8.decode(content)); }
        catch { refuse("PACKAGE_BUNDLE_ARCHIVE_INVALID"); }
      }
      offset = paddedEnd;
    }
    if (!ended || rows.length < 1) refuse("PACKAGE_BUNDLE_ARCHIVE_INVALID");
    rows.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    assertCanonicalPathSet(rows.map(({ path }) => path));
    return Object.freeze({ rows: Object.freeze(rows), packageJson });
  } finally {
    tar.fill(0);
  }
}

function summaryRows(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_FILES) {
    refuse("PACKAGE_BUNDLE_INVENTORY_INVALID");
  }
  const normalized = rows.map((row) => ({
    path: normalizeArchivePath(row.path, "PACKAGE_BUNDLE_INVENTORY_INVALID"),
    bytes: row.bytes,
    mode: row.mode,
    ...(row.sha256 ? { sha256: row.sha256 } : {}),
  })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  assertCanonicalPathSet(
    normalized.map(({ path }) => path),
    "PACKAGE_BUNDLE_INVENTORY_INVALID",
  );
  if (normalized.length < 1 || normalized.some((row, index) =>
    !Number.isSafeInteger(row.bytes) || row.bytes < 0 ||
    !Number.isInteger(row.mode) || row.mode < 0 || row.mode > 0o777 ||
    (row.sha256 !== undefined && !SHA256_RE.test(row.sha256)) ||
    (index > 0 && normalized[index - 1].path === row.path))) {
    refuse("PACKAGE_BUNDLE_INVENTORY_INVALID");
  }
  const metadataRows = normalized.map(({ path, bytes, mode }) => ({ path, bytes, mode }));
  const contentRows = normalized.map(({ path, bytes, mode, sha256 }) =>
    ({ path, bytes, mode, sha256 }));
  const totalBytes = normalized.reduce((sum, row) => sum + row.bytes, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_UNPACKED_BYTES) {
    refuse("PACKAGE_BUNDLE_INVENTORY_INVALID");
  }
  return Object.freeze({
    file_count: normalized.length,
    total_bytes: totalBytes,
    path_inventory_sha256: digest("sha256", canonical(normalized.map(({ path }) => path))),
    metadata_inventory_sha256: digest("sha256", canonical(metadataRows)),
    content_inventory_sha256: normalized.every((row) => row.sha256)
      ? digest("sha256", canonical(contentRows))
      : null,
  });
}

function exactRegistryArchiveUrl(name, version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    refuse("PACKAGE_BUNDLE_CONTRACT_INVALID");
  }
  const leaf = name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name;
  return `https://registry.npmjs.org/${name}/-/${leaf}-${version}.tgz`;
}

function packageInputs(rootInput) {
  const root = realpathSync(resolve(rootInput));
  const packageJson = readJson(join(root, "package.json"), "PACKAGE_BUNDLE_CONTRACT_INVALID");
  const lock = readJson(join(root, "package-lock.json"), "PACKAGE_BUNDLE_CONTRACT_INVALID");
  const names = Array.isArray(packageJson.bundleDependencies)
    ? [...packageJson.bundleDependencies]
    : [];
  const sorted = [...names].sort();
  const lockRoot = lock.packages?.[""];
  const lockRootBundles = Array.isArray(lockRoot?.bundleDependencies)
    ? [...lockRoot.bundleDependencies]
    : [];
  const inBundleKeys = Object.entries(lock.packages || {})
    .filter(([, entry]) => entry?.inBundle === true)
    .map(([key]) => key)
    .sort();
  const expectedInBundleKeys = sorted.map((name) => `node_modules/${name}`).sort();
  if (!packageJson.name || !packageJson.version || lock.lockfileVersion !== 3 ||
      names.length < 1 ||
      new Set(names).size !== names.length ||
      names.some((name) => typeof name !== "string" ||
        !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u.test(name)) ||
      canonical(names) !== canonical(lockRootBundles) ||
      canonical(inBundleKeys) !== canonical(expectedInBundleKeys) ||
      packageJson.name !== lock.name || packageJson.version !== lock.version ||
      packageJson.name !== lockRoot?.name ||
      packageJson.version !== lockRoot?.version) {
    refuse("PACKAGE_BUNDLE_CONTRACT_INVALID");
  }
  for (const name of sorted) {
    const version = packageJson.dependencies?.[name];
    const entry = lock.packages?.[`node_modules/${name}`];
    if (typeof version !== "string" || !entry || entry.version !== version ||
        lockRoot.dependencies?.[name] !== version || entry.inBundle !== true ||
        entry.dev || entry.devOptional || entry.link || entry.optional ||
        entry.resolved !== exactRegistryArchiveUrl(name, version) ||
        !INTEGRITY_RE.test(String(entry.integrity || ""))) {
      refuse("PACKAGE_BUNDLE_CONTRACT_INVALID");
    }
  }
  return Object.freeze({ root, packageJson, lock, names: Object.freeze(sorted) });
}

function integrityParts(integrity, failureCode = "PACKAGE_BUNDLE_CONTRACT_INVALID") {
  if (typeof integrity !== "string" || !INTEGRITY_RE.test(integrity)) {
    refuse(failureCode);
  }
  const encoded = integrity.slice("sha512-".length);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== encoded) {
    bytes.fill(0);
    refuse(failureCode);
  }
  const hex = bytes.toString("hex");
  bytes.fill(0);
  return Object.freeze({
    first: hex.slice(0, 2),
    second: hex.slice(2, 4),
    leaf: hex.slice(4),
    expectedSha512: hex,
  });
}

function cacheArchivePath(cacheContentRootInput, integrity) {
  const cacheContentRoot = realpathSync(resolve(cacheContentRootInput));
  const parts = integrityParts(integrity);
  const path = resolve(cacheContentRoot, parts.first, parts.second, parts.leaf);
  if (!within(cacheContentRoot, path) || path === cacheContentRoot) {
    refuse("PACKAGE_BUNDLE_CONTRACT_INVALID");
  }
  return Object.freeze({
    cacheContentRoot,
    path,
    expectedSha512: parts.expectedSha512,
  });
}

function cacheArchiveDestinationPath(cacheContentRootInput, integrity) {
  const cacheContentRoot = resolve(cacheContentRootInput);
  const parts = integrityParts(integrity);
  const path = resolve(cacheContentRoot, parts.first, parts.second, parts.leaf);
  if (!within(cacheContentRoot, path) || path === cacheContentRoot) {
    refuse("PACKAGE_BUNDLE_CONTRACT_INVALID");
  }
  return Object.freeze({ cacheContentRoot, path, expectedSha512: parts.expectedSha512 });
}

function inspectPrivateCacheTree(rootInput) {
  const root = realpathSync(resolve(rootInput));
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const info = lstatSync(path);
      if (info.isSymbolicLink() || realpathSync(path) !== path ||
          (process.platform !== "win32" && ((info.mode & 0o077) !== 0 ||
            (typeof process.getuid === "function" && info.uid !== process.getuid())))) {
        refuse("PACKAGE_BUNDLE_CACHE_DESTINATION_INVALID");
      }
      if (info.isDirectory()) visit(path);
      else if (info.isFile() && info.nlink === 1) {
        files.push(relative(root, path).split(sep).join("/"));
      } else refuse("PACKAGE_BUNDLE_CACHE_DESTINATION_INVALID");
    }
  };
  visit(root);
  return files.sort();
}

function privateDirectoryPin(pathInput) {
  const requestedPath = resolve(pathInput);
  let info;
  try {
    info = lstatSync(requestedPath);
    if (!info.isDirectory() || info.isSymbolicLink() ||
        (process.platform !== "win32" && ((info.mode & 0o077) !== 0 ||
          (typeof process.getuid === "function" && info.uid !== process.getuid())))) {
      refuse("PACKAGE_BUNDLE_CACHE_DESTINATION_INVALID");
    }
    const path = realpathSync(requestedPath);
    const canonicalInfo = lstatSync(path);
    if (!canonicalInfo.isDirectory() || canonicalInfo.isSymbolicLink() ||
        !sameIdentity(identity(info), identity(canonicalInfo))) {
      refuse("PACKAGE_BUNDLE_CACHE_DESTINATION_INVALID");
    }
    info = canonicalInfo;
    return Object.freeze({
      path,
      dev: info.dev,
      ino: info.ino,
      mode: info.mode,
      uid: info.uid,
    });
  } catch (error) {
    if (error instanceof PackageBundleVerificationError) throw error;
    refuse("PACKAGE_BUNDLE_CACHE_DESTINATION_INVALID");
  }
}

function assertDirectoryPin(pin) {
  const current = privateDirectoryPin(pin.path);
  if (current.dev !== pin.dev || current.ino !== pin.ino ||
      current.mode !== pin.mode || current.uid !== pin.uid) {
    refuse("PACKAGE_BUNDLE_CACHE_DESTINATION_INVALID");
  }
  return true;
}

function assertDestinationAbsent(path) {
  try {
    lstatSync(path);
    refuse("PACKAGE_BUNDLE_CACHE_DESTINATION_INVALID");
  } catch (error) {
    if (error instanceof PackageBundleVerificationError) throw error;
    if (error?.code !== "ENOENT") refuse("PACKAGE_BUNDLE_CACHE_DESTINATION_INVALID");
  }
}

function assertNoLinkedDirectoryAncestor(pathInput) {
  let current = resolve(pathInput);
  while (true) {
    let info;
    try {
      info = lstatSync(current);
    } catch {
      refuse("PACKAGE_BUNDLE_CACHE_DESTINATION_INVALID");
    }
    const isCanonicalDarwinRootAlias = process.platform === "darwin" &&
      info.isSymbolicLink() && info.uid === 0 &&
      ["/etc", "/tmp", "/var"].includes(current) &&
      realpathSync(current) === `/private${current}`;
    if ((!info.isDirectory() || info.isSymbolicLink()) &&
        !isCanonicalDarwinRootAlias) {
      refuse("PACKAGE_BUNDLE_CACHE_DESTINATION_INVALID");
    }
    const parent = dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

function cleanupPinnedDestination(pin, parentPin) {
  if (!pin || !parentPin) return;
  try {
    assertDirectoryPin(parentPin);
    if (dirname(pin.path) !== parentPin.path) return;
    assertDirectoryPin(pin);
    rmSync(pin.path, { recursive: true, force: true });
  } catch { /* Never remove a destination whose pinned identity changed. */ }
}

function planPrivateDestinationPath(destinationInput) {
  const requested = resolve(destinationInput);
  const missing = [];
  let existing = requested;
  while (true) {
    try {
      lstatSync(existing);
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        refuse("PACKAGE_BUNDLE_CACHE_DESTINATION_INVALID");
      }
      const parent = dirname(existing);
      if (parent === existing) refuse("PACKAGE_BUNDLE_CACHE_DESTINATION_INVALID");
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
  if (missing.length < 1) refuse("PACKAGE_BUNDLE_CACHE_DESTINATION_INVALID");
  assertNoLinkedDirectoryAncestor(existing);
  const basePin = privateDirectoryPin(existing);
  const path = missing.reduce((parent, part) => join(parent, part), basePin.path);
  return Object.freeze({ basePin, parts: Object.freeze(missing), path });
}

function createPinnedDestinationPath(plan) {
  let parentPin = plan.basePin;
  let firstCreatedPin = null;
  try {
    for (const part of plan.parts) {
      if (!part || part === "." || part === "..") {
        refuse("PACKAGE_BUNDLE_CACHE_DESTINATION_INVALID");
      }
      assertDirectoryPin(parentPin);
      const child = join(parentPin.path, part);
      assertDestinationAbsent(child);
      try {
        mkdirSync(child, { recursive: false, mode: 0o700 });
      } catch (error) {
        if (error?.code === "EEXIST") {
          refuse("PACKAGE_BUNDLE_CACHE_DESTINATION_INVALID");
        }
        throw error;
      }
      const childPin = privateDirectoryPin(child);
      assertDirectoryPin(parentPin);
      firstCreatedPin ||= childPin;
      parentPin = childPin;
    }
    if (parentPin.path !== plan.path) {
      refuse("PACKAGE_BUNDLE_CACHE_DESTINATION_INVALID");
    }
    return Object.freeze({
      rootPin: parentPin,
      cleanupPin: firstCreatedPin,
      cleanupParentPin: plan.basePin,
    });
  } catch (error) {
    cleanupPinnedDestination(firstCreatedPin, plan.basePin);
    throw error;
  }
}

function createPrivateDescendantDirectories(rootPin, directoryInput, knownDirectories) {
  const directory = resolve(directoryInput);
  if (!within(rootPin.path, directory)) {
    refuse("PACKAGE_BUNDLE_CACHE_DESTINATION_INVALID");
  }
  const suffix = relative(rootPin.path, directory);
  let currentPin = rootPin;
  if (!suffix) return currentPin;
  for (const part of suffix.split(sep)) {
    if (!part || part === "." || part === "..") {
      refuse("PACKAGE_BUNDLE_CACHE_DESTINATION_INVALID");
    }
    assertDirectoryPin(currentPin);
    const child = join(currentPin.path, part);
    if (!knownDirectories.has(child)) {
      assertDestinationAbsent(child);
      try {
        mkdirSync(child, { recursive: false, mode: 0o700 });
      } catch (error) {
        if (error?.code === "EEXIST") {
          refuse("PACKAGE_BUNDLE_CACHE_DESTINATION_INVALID");
        }
        throw error;
      }
      knownDirectories.add(child);
    }
    const childPin = privateDirectoryPin(child);
    assertDirectoryPin(currentPin);
    currentPin = childPin;
  }
  return currentPin;
}

export function resolveNpmCacheContentRoot(
  environment = process.env,
  { platform = process.platform, userHome = homedir() } = {},
) {
  const cache = environment.NPM_CONFIG_CACHE || environment.npm_config_cache ||
    (platform === "win32"
      ? join(environment.LOCALAPPDATA || join(userHome, "AppData", "Local"), "npm-cache")
      : join(userHome, ".npm"));
  return resolve(cache, "_cacache", "content-v2", "sha512");
}

export function bundleManifestInventorySha256(bundles) {
  if (!Array.isArray(bundles)) refuse("PACKAGE_BUNDLE_MANIFEST_INVALID");
  return digest("sha256", canonical(bundles));
}

/** Build the compact reviewed manifest from exact lock-integrity cache bytes. */
export function buildReviewedBundleManifest({
  root = MODULE_ROOT,
  cacheContentRoot,
} = {}) {
  if (!cacheContentRoot) refuse("PACKAGE_BUNDLE_CACHE_REQUIRED");
  const inputs = packageInputs(root);
  const bundles = [];
  for (const name of inputs.names) {
    const entry = inputs.lock.packages[`node_modules/${name}`];
    const cached = cacheArchivePath(cacheContentRoot, entry.integrity);
    const archive = readStableRegularFile(cached.path, {
      root: cached.cacheContentRoot,
      failureCode: "PACKAGE_BUNDLE_CACHE_ARCHIVE_INVALID",
    });
    try {
      if (digest("sha512", archive) !== cached.expectedSha512) {
        refuse("PACKAGE_BUNDLE_CACHE_INTEGRITY_MISMATCH");
      }
      const inspected = inspectNpmArchiveBytes(archive);
      if (inspected.packageJson?.name !== name ||
          inspected.packageJson?.version !== entry.version) {
        refuse("PACKAGE_BUNDLE_CACHE_ARCHIVE_INVALID");
      }
      bundles.push(Object.freeze({
        name,
        version: entry.version,
        integrity: entry.integrity,
        ...summaryRows(inspected.rows),
      }));
    } finally {
      archive.fill(0);
    }
  }
  const manifest = {
    schema_version: 1,
    derivation: "package-lock direct bundle integrity archives",
    root_package: { name: inputs.packageJson.name, version: inputs.packageJson.version },
    bundles,
    inventory_sha256: bundleManifestInventorySha256(bundles),
  };
  return Object.freeze(manifest);
}

export function loadVerifiedBundleContract({
  root = MODULE_ROOT,
  cacheContentRoot = resolveNpmCacheContentRoot(),
  manifestPath = null,
} = {}) {
  const inputs = packageInputs(root);
  const manifest = readJson(
    manifestPath || join(inputs.root, REVIEWED_BUNDLE_MANIFEST_RELATIVE),
    "PACKAGE_BUNDLE_MANIFEST_INVALID",
  );
  if (manifest?.schema_version !== 1 ||
      manifest.derivation !== "package-lock direct bundle integrity archives" ||
      manifest.root_package?.name !== inputs.packageJson.name ||
      manifest.root_package?.version !== inputs.packageJson.version ||
      !Array.isArray(manifest.bundles) ||
      !SHA256_RE.test(String(manifest.inventory_sha256 || "")) ||
      bundleManifestInventorySha256(manifest.bundles) !== manifest.inventory_sha256) {
    refuse("PACKAGE_BUNDLE_MANIFEST_INVALID");
  }
  const byName = new Map();
  for (const bundle of manifest.bundles) {
    const entry = inputs.lock.packages[`node_modules/${bundle?.name}`];
    if (!bundle || Object.keys(bundle).sort().join("|") !== [
      "content_inventory_sha256", "file_count", "integrity", "metadata_inventory_sha256",
      "name", "path_inventory_sha256", "total_bytes", "version",
    ].sort().join("|") ||
        !inputs.names.includes(bundle.name) || byName.has(bundle.name) ||
        bundle.version !== inputs.packageJson.dependencies[bundle.name] ||
        bundle.version !== entry?.version || bundle.integrity !== entry?.integrity ||
        !Number.isSafeInteger(bundle.file_count) || bundle.file_count < 1 ||
        !Number.isSafeInteger(bundle.total_bytes) || bundle.total_bytes < 1 ||
        !SHA256_RE.test(bundle.path_inventory_sha256) ||
        !SHA256_RE.test(bundle.metadata_inventory_sha256) ||
        !SHA256_RE.test(bundle.content_inventory_sha256)) {
      refuse("PACKAGE_BUNDLE_MANIFEST_INVALID");
    }
    byName.set(bundle.name, Object.freeze({ ...bundle }));
  }
  if (byName.size !== inputs.names.length ||
      inputs.names.some((name) => !byName.has(name))) {
    refuse("PACKAGE_BUNDLE_MANIFEST_INVALID");
  }
  const derived = buildReviewedBundleManifest({
    root: inputs.root,
    cacheContentRoot,
  });
  if (canonical(derived) !== canonical(manifest)) {
    refuse("PACKAGE_BUNDLE_MANIFEST_LOCK_DERIVATION_MISMATCH");
  }
  return Object.freeze({ ...inputs, manifest, byName, cacheContentRoot });
}

/** Copy only the reviewed lock-integrity archives into a fresh private npm
 * cache. Both the source and completed destination are independently checked. */
export function materializeVerifiedBundleCache({
  root = MODULE_ROOT,
  sourceCacheContentRoot,
  destinationCacheContentRoot,
  writeArchive = writeFileSync,
} = {}) {
  if (!sourceCacheContentRoot || !destinationCacheContentRoot) {
    refuse("PACKAGE_BUNDLE_CACHE_REQUIRED");
  }
  const sourceRoot = realpathSync(resolve(sourceCacheContentRoot));
  const destinationPlan = planPrivateDestinationPath(destinationCacheContentRoot);
  const destinationRoot = destinationPlan.path;
  if (within(sourceRoot, destinationRoot) || within(destinationRoot, sourceRoot)) {
    refuse("PACKAGE_BUNDLE_CACHE_DESTINATION_INVALID");
  }
  const contract = loadVerifiedBundleContract({
    root,
    cacheContentRoot: sourceRoot,
  });
  let destinationCreation = null;
  let destinationPin = null;
  try {
    destinationCreation = createPinnedDestinationPath(destinationPlan);
    destinationPin = destinationCreation.rootPin;
    const knownDirectories = new Set([destinationPin.path]);
    for (const name of contract.names) {
      const entry = contract.lock.packages[`node_modules/${name}`];
      const source = cacheArchivePath(sourceRoot, entry.integrity);
      const destination = cacheArchiveDestinationPath(destinationRoot, entry.integrity);
      const archive = readStableRegularFile(source.path, {
        root: source.cacheContentRoot,
        failureCode: "PACKAGE_BUNDLE_CACHE_ARCHIVE_INVALID",
      });
      try {
        if (digest("sha512", archive) !== source.expectedSha512) {
          refuse("PACKAGE_BUNDLE_CACHE_INTEGRITY_MISMATCH");
        }
        const leafPin = createPrivateDescendantDirectories(
          destinationPin,
          dirname(destination.path),
          knownDirectories,
        );
        assertDirectoryPin(destinationPin);
        const pinnedDestinationPath = join(leafPin.path, basename(destination.path));
        if (pinnedDestinationPath !== destination.path) {
          refuse("PACKAGE_BUNDLE_CACHE_DESTINATION_INVALID");
        }
        assertDestinationAbsent(pinnedDestinationPath);
        assertDirectoryPin(leafPin);
        writeArchive(pinnedDestinationPath, archive, { flag: "wx", mode: 0o600 });
        assertDirectoryPin(leafPin);
        assertDirectoryPin(destinationPin);
      } finally {
        archive.fill(0);
      }
    }
    const expectedFiles = contract.names.map((name) => {
      const entry = contract.lock.packages[`node_modules/${name}`];
      return relative(
        destinationRoot,
        cacheArchiveDestinationPath(destinationRoot, entry.integrity).path,
      ).split(sep).join("/");
    }).sort();
    if (canonical(inspectPrivateCacheTree(destinationRoot)) !== canonical(expectedFiles)) {
      refuse("PACKAGE_BUNDLE_CACHE_DESTINATION_INVALID");
    }
    assertDirectoryPin(destinationPin);
    assertDirectoryPin(destinationCreation.cleanupParentPin);
    const privateContract = loadVerifiedBundleContract({
      root,
      cacheContentRoot: destinationRoot,
    });
    assertDirectoryPin(destinationPin);
    assertDirectoryPin(destinationCreation.cleanupParentPin);
    return Object.freeze({
      cache_content_root: destinationRoot,
      bundle_count: privateContract.names.length,
      inventory_sha256: privateContract.manifest.inventory_sha256,
    });
  } catch (error) {
    cleanupPinnedDestination(
      destinationCreation?.cleanupPin,
      destinationCreation?.cleanupParentPin,
    );
    if (error instanceof PackageBundleVerificationError) throw error;
    refuse("PACKAGE_BUNDLE_CACHE_MATERIALIZATION_FAILED");
  }
}

function rowsByBundle(rows, contract, { requireContent }) {
  const grouped = new Map(contract.names.map((name) => [name, []]));
  for (const row of rows) {
    if (!row.path.startsWith("node_modules/")) continue;
    const name = contract.names.find((candidate) =>
      row.path.startsWith(`node_modules/${candidate}/`));
    if (!name) refuse("PACKAGE_BUNDLE_SET_MISMATCH");
    grouped.get(name).push({
      path: row.path.slice(`node_modules/${name}/`.length),
      bytes: row.bytes,
      mode: row.mode,
      ...(requireContent ? { sha256: row.sha256 } : {}),
    });
  }
  return grouped;
}

function assertBundleRows(rows, contract, { requireContent }) {
  const grouped = rowsByBundle(rows, contract, { requireContent });
  let fileCount = 0;
  let totalBytes = 0;
  for (const name of contract.names) {
    const expected = contract.byName.get(name);
    const actual = summaryRows(grouped.get(name));
    if (actual.file_count !== expected.file_count ||
        actual.total_bytes !== expected.total_bytes ||
        actual.path_inventory_sha256 !== expected.path_inventory_sha256 ||
        actual.metadata_inventory_sha256 !== expected.metadata_inventory_sha256) {
      refuse("PACKAGE_BUNDLE_METADATA_INVENTORY_MISMATCH");
    }
    if (requireContent &&
        actual.content_inventory_sha256 !== expected.content_inventory_sha256) {
      refuse("PACKAGE_BUNDLE_CONTENT_INVENTORY_MISMATCH");
    }
    fileCount += actual.file_count;
    totalBytes += actual.total_bytes;
  }
  return Object.freeze({
    bundle_count: contract.names.length,
    bundle_file_count: fileCount,
    bundle_bytes: totalBytes,
    inventory_sha256: contract.manifest.inventory_sha256,
  });
}

function metadataRows(metadata) {
  if (!metadata || !Array.isArray(metadata.files) || metadata.files.length < 1 ||
      metadata.files.length > MAX_FILES || metadata.entryCount !== metadata.files.length ||
      !Number.isSafeInteger(metadata.size) || metadata.size < 1 ||
      metadata.size > MAX_ARCHIVE_BYTES ||
      !SHA1_RE.test(String(metadata.shasum || ""))) {
    refuse("PACKAGE_BUNDLE_METADATA_INVALID");
  }
  integrityParts(metadata.integrity, "PACKAGE_BUNDLE_METADATA_INVALID");
  const rows = metadata.files.map((entry) => ({
    path: normalizeArchivePath(entry?.path, "PACKAGE_BUNDLE_METADATA_INVALID"),
    bytes: entry?.size,
    mode: entry?.mode,
  })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (rows.some(({ bytes, mode }) =>
    !Number.isSafeInteger(bytes) || bytes < 0 ||
    !Number.isInteger(mode) || mode < 0 || mode > 0o777) ||
      new Set(rows.map((row) => row.path)).size !== rows.length) {
    refuse("PACKAGE_BUNDLE_METADATA_INVALID");
  }
  assertCanonicalPathSet(
    rows.map(({ path }) => path),
    "PACKAGE_BUNDLE_METADATA_INVALID",
  );
  const aggregateBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
  if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes > MAX_UNPACKED_BYTES ||
      metadata.unpackedSize !== aggregateBytes) {
    refuse("PACKAGE_BUNDLE_METADATA_INVALID");
  }
  return rows;
}

export function readStableNpmPackMetadata(path) {
  let raw;
  try {
    raw = readStableRegularFile(path, {
      maxBytes: MAX_METADATA_BYTES,
      failureCode: "PACKAGE_BUNDLE_METADATA_INVALID",
    });
    const parsed = JSON.parse(UTF8.decode(raw));
    if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0]) {
      refuse("PACKAGE_BUNDLE_METADATA_INVALID");
    }
    metadataRows(parsed[0]);
    return parsed[0];
  } catch (error) {
    if (error instanceof PackageBundleVerificationError) throw error;
    refuse("PACKAGE_BUNDLE_METADATA_INVALID");
  } finally {
    raw?.fill(0);
  }
}

function assertPackedMetadataWithContract(metadata, contract) {
  if (!Array.isArray(metadata?.bundled) ||
      metadata.bundled.length !== contract.names.length) {
    refuse("PACKAGE_BUNDLE_SET_MISMATCH");
  }
  const bundled = [...metadata.bundled].sort();
  if (new Set(bundled).size !== bundled.length ||
      canonical(bundled) !== canonical(contract.names)) {
    refuse("PACKAGE_BUNDLE_SET_MISMATCH");
  }
  return assertBundleRows(metadataRows(metadata), contract, { requireContent: false });
}

export function assertPackedBundleMetadata({
  root = MODULE_ROOT,
  metadata,
  cacheContentRoot = resolveNpmCacheContentRoot(),
  manifestPath = null,
} = {}) {
  const contract = loadVerifiedBundleContract({ root, cacheContentRoot, manifestPath });
  return assertPackedMetadataWithContract(metadata, contract);
}

/** Verify already-inspected archive rows. Kept separate so callers can pin the
 *  file identity before parsing and tests can exercise each refusal exactly. */
export function assertPackedBundleRows({
  root = MODULE_ROOT,
  metadata,
  rows,
  cacheContentRoot = resolveNpmCacheContentRoot(),
  manifestPath = null,
} = {}) {
  const contract = loadVerifiedBundleContract({ root, cacheContentRoot, manifestPath });
  const metadataProof = assertPackedMetadataWithContract(metadata, contract);
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_FILES ||
      rows.some((row) => !SHA256_RE.test(String(row?.sha256 || "")))) {
    refuse("PACKAGE_BUNDLE_ARCHIVE_INVALID");
  }
  summaryRows(rows);
  const fromMetadata = metadataRows(metadata);
  const fromRows = rows.map(({ path, bytes, mode }) => ({ path, bytes, mode }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (canonical(fromMetadata) !== canonical(fromRows)) {
    refuse("PACKAGE_BUNDLE_ARCHIVE_METADATA_MISMATCH");
  }
  const contentProof = assertBundleRows(rows, contract, { requireContent: true });
  if (canonical(metadataProof) !== canonical(contentProof)) {
    refuse("PACKAGE_BUNDLE_ARCHIVE_METADATA_MISMATCH");
  }
  return contentProof;
}

export function assertPackedBundleArchive({
  root = MODULE_ROOT,
  metadata,
  archivePath,
  cacheContentRoot = resolveNpmCacheContentRoot(),
  manifestPath = null,
} = {}) {
  const contract = loadVerifiedBundleContract({ root, cacheContentRoot, manifestPath });
  const metadataProof = assertPackedMetadataWithContract(metadata, contract);
  const archive = readStableRegularFile(archivePath, {
    failureCode: "PACKAGE_BUNDLE_ARCHIVE_INVALID",
  });
  try {
    if (metadata.size !== archive.length) refuse("PACKAGE_BUNDLE_ARCHIVE_METADATA_MISMATCH");
    const receiptIntegrity = integrityParts(
      metadata.integrity,
      "PACKAGE_BUNDLE_METADATA_INVALID",
    );
    if (!SHA1_RE.test(String(metadata.shasum || ""))) {
      refuse("PACKAGE_BUNDLE_METADATA_INVALID");
    }
    if (digest("sha512", archive) !== receiptIntegrity.expectedSha512 ||
        digest("sha1", archive) !== metadata.shasum) {
      refuse("PACKAGE_BUNDLE_ARCHIVE_METADATA_MISMATCH");
    }
    const inspected = inspectNpmArchiveBytes(archive);
    const packedBundleNames = Array.isArray(inspected.packageJson?.bundleDependencies)
      ? [...inspected.packageJson.bundleDependencies].sort()
      : [];
    if (inspected.packageJson?.name !== contract.packageJson.name ||
        inspected.packageJson?.version !== contract.packageJson.version ||
        canonical(packedBundleNames) !== canonical(contract.names) ||
        contract.names.some((name) =>
          inspected.packageJson?.dependencies?.[name] !==
            contract.packageJson.dependencies[name])) {
      refuse("PACKAGE_BUNDLE_ARCHIVE_METADATA_MISMATCH");
    }
    const fromMetadata = metadataRows(metadata);
    const archiveMetadata = inspected.rows.map(({ path, bytes, mode }) =>
      ({ path, bytes, mode }));
    if (canonical(fromMetadata) !== canonical(archiveMetadata)) {
      refuse("PACKAGE_BUNDLE_ARCHIVE_METADATA_MISMATCH");
    }
    const contentProof = assertBundleRows(inspected.rows, contract, { requireContent: true });
    if (canonical(metadataProof) !== canonical(contentProof)) {
      refuse("PACKAGE_BUNDLE_ARCHIVE_METADATA_MISMATCH");
    }
    return Object.freeze({
      ...contentProof,
      archive_sha256: digest("sha256", archive),
      identity_scheme: UPDATE_RUNTIME_IDENTITY_SCHEME,
      runtime_payload_sha256: deriveUpdateRuntimePayloadSha256(
        inspected.rows.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
      ),
      archive_integrity: metadata.integrity,
      archive_shasum: metadata.shasum,
      archive_bytes: archive.length,
      archive_file_count: inspected.rows.length,
      archive_unpacked_bytes: metadata.unpackedSize,
    });
  } finally {
    archive.fill(0);
  }
}
