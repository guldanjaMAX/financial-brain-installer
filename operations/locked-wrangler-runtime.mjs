/**
 * Immutable, credential-free Wrangler runtime for the disposable recovery
 * field proof.
 *
 * Preparation starts from the exact SHA-512 cache objects named by
 * package-lock.json, not from the mutable installed node_modules tree. It
 * extracts only Wrangler's host-compatible dependency closure into a fixed
 * owner-only directory, inventories every regular file, and compares those
 * trusted bytes with the checkout installation used by the offline test suite.
 * The live adapter later copies only that prepared closure and its pinned
 * resolution guard into a fresh 0700 call directory. The guard confines both
 * CommonJS and ESM resolution to that copy while Node global search paths are
 * disabled. No npm command, registry, PATH lookup, credential, or provider is
 * used by this module.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import * as nodeModule from "node:module";
import { arch as operatingSystemArch } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { gunzipSync } from "node:zlib";

export const LOCKED_WRANGLER_PACKAGE = "wrangler";
export const LOCKED_WRANGLER_VERSION = "4.127.1";
export const LOCKED_WRANGLER_RUNTIME_DIRECTORY = "wrangler-runtime-v1";
export const LOCKED_WRANGLER_ENTRYPOINT = "node_modules/wrangler/bin/wrangler.js";
export const LOCKED_WRANGLER_RESOLUTION_GUARD = "resolution-guard.cjs";
export const LOCKED_WRANGLER_RESOLUTION_GUARD_MIN_NODE = "22.15.0";

export const LOCKED_WRANGLER_RESOLUTION_GUARD_SOURCE = `"use strict";
const { realpathSync } = require("node:fs");
const { registerHooks } = require("node:module");
const { isAbsolute, relative, sep } = require("node:path");
const { fileURLToPath } = require("node:url");

const REFUSAL = "LOCKED_WRANGLER_RESOLUTION_OUTSIDE_RUNTIME";
function refuse() {
  const error = new Error(REFUSAL);
  error.code = REFUSAL;
  throw error;
}

if (typeof registerHooks !== "function") refuse();
const runtimeRoot = realpathSync(__dirname);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (!result || typeof result.url !== "string") refuse();
    if (result.url.startsWith("node:")) return result;
    if (!result.url.startsWith("file:")) refuse();
    let target;
    try { target = realpathSync(fileURLToPath(result.url)); } catch { refuse(); }
    const fromRoot = relative(runtimeRoot, target);
    if (fromRoot === "" ||
        (fromRoot !== ".." && !fromRoot.startsWith(".." + sep) &&
         !isAbsolute(fromRoot))) return result;
    refuse();
  },
});
`;

const MAX_PACKAGES = 256;
const MAX_FILES = 12_000;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_CACHE_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_PACKAGE_UNPACKED_BYTES = 512 * 1024 * 1024;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export class LockedWranglerRuntimeError extends Error {
  constructor(code) {
    super(code);
    this.name = "LockedWranglerRuntimeError";
    this.code = code;
  }
}

function fail(code = "LOCKED_WRANGLER_RUNTIME_INVALID") {
  throw new LockedWranglerRuntimeError(code);
}

function digest(algorithm, value) {
  return createHash(algorithm).update(value).digest("hex");
}

const LOCKED_WRANGLER_RESOLUTION_GUARD_BYTES = Buffer.from(
  LOCKED_WRANGLER_RESOLUTION_GUARD_SOURCE,
  "utf8",
);
export const LOCKED_WRANGLER_RESOLUTION_GUARD_SHA256 = digest(
  "sha256",
  LOCKED_WRANGLER_RESOLUTION_GUARD_BYTES,
);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function identity(info) {
  return Object.freeze({
    dev: info.dev,
    ino: info.ino,
    nlink: info.nlink,
    size: info.size,
    mode: info.mode,
    uid: info.uid,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
  });
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino &&
    left.nlink === right.nlink && left.size === right.size &&
    left.mode === right.mode && left.uid === right.uid &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function assertResolutionGuardSupport() {
  if (typeof nodeModule.registerHooks !== "function") {
    fail("LOCKED_WRANGLER_RESOLUTION_GUARD_UNSUPPORTED");
  }
  return true;
}

function assertOwnerOnly(info) {
  if (process.platform === "win32") return true;
  if ((info.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && info.uid !== process.getuid())) fail();
  return true;
}

function normalizeRelative(value) {
  const normalized = String(value || "").split(sep).join("/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\\") ||
      CONTROL_RE.test(normalized) || normalized.split("/").some(
        (part) => !part || part === "." || part === "..",
      )) fail();
  return normalized;
}

function within(root, path) {
  return path === root || path.startsWith(`${root}${sep}`);
}

function readStableRegularFile(path, root, {
  ownerOnly = false,
  maxBytes = MAX_TOTAL_BYTES,
} = {}) {
  let descriptor;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
        before.size < 0 || before.size > maxBytes) fail();
    if (ownerOnly) assertOwnerOnly(before);
    const canonicalPath = realpathSync(path);
    if (!within(root, canonicalPath)) fail();
    descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    if (!sameIdentity(identity(before), identity(opened))) fail();
    const raw = readFileSync(descriptor);
    const afterDescriptor = fstatSync(descriptor);
    const afterPath = lstatSync(path);
    if (!sameIdentity(identity(opened), identity(afterDescriptor)) ||
        !sameIdentity(identity(opened), identity(afterPath))) fail();
    return Object.freeze({ raw, hash: digest("sha256", raw), identity: identity(opened) });
  } catch (error) {
    if (error instanceof LockedWranglerRuntimeError) throw error;
    fail();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function packageDependencyKey(packages, fromKey, dependency) {
  const parts = fromKey.split("/");
  while (parts.length > 0) {
    const candidate = normalizeRelative([
      ...parts,
      "node_modules",
      ...dependency.split("/"),
    ].join("/"));
    if (packages[candidate]) return candidate;
    const marker = parts.lastIndexOf("node_modules");
    if (marker < 0) break;
    parts.splice(marker);
  }
  const rootCandidate = normalizeRelative(["node_modules", ...dependency.split("/")].join("/"));
  return packages[rootCandidate] ? rootCandidate : null;
}

function selectorMatches(values, actual) {
  if (values === undefined) return true;
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value)) {
    fail();
  }
  if (values.includes(`!${actual}`)) return false;
  const positive = values.filter((value) => !value.startsWith("!"));
  return positive.length === 0 || positive.includes(actual);
}

function packageSupportsHost(entry, host) {
  return selectorMatches(entry.os, host.platform) &&
    selectorMatches(entry.cpu, host.arch) &&
    (host.platform !== "linux" || selectorMatches(entry.libc, host.libc));
}

function validateLock(lock) {
  const packages = lock?.packages;
  const rootEntry = packages?.[""];
  const first = "node_modules/wrangler";
  if (!packages || typeof packages !== "object" || Array.isArray(packages) ||
      rootEntry?.name !== "brain-installer" || rootEntry?.version !== "0.4.8" ||
      rootEntry?.devDependencies?.wrangler !== LOCKED_WRANGLER_VERSION ||
      packages[first]?.version !== LOCKED_WRANGLER_VERSION ||
      packages[first]?.bin?.wrangler !== "bin/wrangler.js") fail();
  return packages;
}

function lockedClosure(lock, host) {
  const packages = validateLock(lock);
  const queue = ["node_modules/wrangler"];
  const closure = new Set();
  let visits = 0;
  while (queue.length > 0) {
    const key = queue.shift();
    if (closure.has(key)) continue;
    if (++visits > MAX_PACKAGES) fail();
    const entry = packages[key];
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        typeof entry.version !== "string" ||
        !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(String(entry.integrity || "")) ||
        !packageSupportsHost(entry, host)) fail();
    closure.add(key);
    const dependencyNames = new Set([
      ...Object.keys(entry.dependencies || {}),
      ...Object.keys(entry.optionalDependencies || {}),
      ...Object.keys(entry.peerDependencies || {}),
    ]);
    for (const name of [...dependencyNames].sort()) {
      const optional = Object.hasOwn(entry.optionalDependencies || {}, name) ||
        entry.peerDependenciesMeta?.[name]?.optional === true;
      const dependencyKey = packageDependencyKey(packages, key, name);
      if (!dependencyKey || !packageSupportsHost(packages[dependencyKey], host)) {
        if (!optional) fail();
        continue;
      }
      queue.push(dependencyKey);
    }
  }
  return Object.freeze([...closure].sort());
}

function hostIdentity(input = {}) {
  let libc = input.libc;
  if (!libc && (input.platform ?? process.platform) === "linux") {
    libc = process.report?.getReport?.()?.header?.glibcVersionRuntime ? "glibc" : "musl";
  }
  return Object.freeze({
    platform: input.platform ?? process.platform,
    arch: input.arch ?? operatingSystemArch(),
    libc: libc ?? "none",
  });
}

function packageNameForKey(packageKey) {
  const marker = packageKey.lastIndexOf("node_modules/");
  return packageKey.slice(marker + "node_modules/".length);
}

function collectPackageFiles(root, packageKey, lockEntry, rows, pins, directories, ownerOnly) {
  const packageRoot = resolve(root, packageKey);
  if (!within(root, packageRoot) || packageRoot === root) fail();
  const packageRootInfo = lstatSync(packageRoot);
  if (!packageRootInfo.isDirectory() || packageRootInfo.isSymbolicLink()) fail();
  if (ownerOnly) assertOwnerOnly(packageRootInfo);
  directories.push(Object.freeze({
    path: packageRoot,
    relative: packageKey,
    identity: identity(packageRootInfo),
  }));

  let observedPackage = null;
  const walk = (directory) => {
    const before = lstatSync(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) fail();
    if (ownerOnly) assertOwnerOnly(before);
    const directoryRelative = normalizeRelative(relative(root, directory));
    if (directory !== packageRoot) {
      directories.push(Object.freeze({
        path: directory,
        relative: directoryRelative,
        identity: identity(before),
      }));
    }
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) fail();
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (rows.length >= MAX_FILES) fail();
      const loaded = readStableRegularFile(path, root, { ownerOnly });
      const fileRelative = normalizeRelative(relative(root, path));
      if (fileRelative === `${packageKey}/package.json`) {
        try { observedPackage = JSON.parse(loaded.raw.toString("utf8")); }
        catch { loaded.raw.fill(0); fail(); }
      }
      rows.push(Object.freeze({
        package: packageKey,
        package_version: lockEntry.version,
        lock_integrity: lockEntry.integrity,
        path: fileRelative,
        bytes: loaded.raw.length,
        sha256: loaded.hash,
        executable: Boolean(loaded.identity.mode & 0o111),
      }));
      pins.push(Object.freeze({
        path,
        relative: fileRelative,
        hash: loaded.hash,
        identity: loaded.identity,
      }));
      loaded.raw.fill(0);
    }
    const after = lstatSync(directory);
    if (!sameIdentity(identity(before), identity(after))) fail();
  };
  walk(packageRoot);
  const expectedName = lockEntry.name ?? packageNameForKey(packageKey);
  if (!observedPackage || observedPackage.name !== expectedName ||
      observedPackage.version !== lockEntry.version) fail();
}

function assertExactPreparedTree(root, packageKeys, pins, ownerOnly) {
  const packageRoots = packageKeys.map((key) => resolve(root, key));
  const allowedFiles = new Set(["package-lock.json", ...pins.map((pin) => pin.relative)]);
  const walk = (directory) => {
    const before = lstatSync(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) fail();
    if (ownerOnly) assertOwnerOnly(before);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath = normalizeRelative(relative(root, path));
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) fail();
      if (entry.isFile()) {
        if (!allowedFiles.has(relativePath)) fail();
        continue;
      }
      const relevant = packageRoots.some((packageRoot) =>
        within(path, packageRoot) || within(packageRoot, path));
      if (!relevant) fail();
      walk(path);
    }
    const after = lstatSync(directory);
    if (!sameIdentity(identity(before), identity(after))) fail();
  };
  walk(root);
}

export function inspectLockedWranglerRuntime(rootInput, options = {}) {
  assertResolutionGuardSupport();
  let root;
  try { root = realpathSync(resolve(rootInput)); }
  catch { fail(); }
  const ownerOnly = options.ownerOnly === true;
  const exactRoot = options.exactRoot === true;
  const rootInfo = lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail();
  if (ownerOnly) assertOwnerOnly(rootInfo);
  const lockPath = join(root, "package-lock.json");
  const lockFile = readStableRegularFile(lockPath, root, { ownerOnly });
  let lock;
  try { lock = JSON.parse(lockFile.raw.toString("utf8")); }
  catch { lockFile.raw.fill(0); fail(); }
  lockFile.raw.fill(0);

  const host = hostIdentity(options);
  const packageKeys = lockedClosure(lock, host);
  const rows = [];
  const pins = [];
  const directories = [];
  for (const packageKey of packageKeys) {
    collectPackageFiles(
      root,
      packageKey,
      lock.packages[packageKey],
      rows,
      pins,
      directories,
      ownerOnly,
    );
  }
  const resolutionGuardRow = Object.freeze({
    package: "@financial-brain/locked-wrangler-runtime",
    package_version: "1",
    lock_integrity: `sha256-${LOCKED_WRANGLER_RESOLUTION_GUARD_SHA256}`,
    path: LOCKED_WRANGLER_RESOLUTION_GUARD,
    bytes: LOCKED_WRANGLER_RESOLUTION_GUARD_BYTES.length,
    sha256: LOCKED_WRANGLER_RESOLUTION_GUARD_SHA256,
    executable: false,
  });
  let resolutionGuardPath = null;
  if (exactRoot) {
    const path = join(root, LOCKED_WRANGLER_RESOLUTION_GUARD);
    const loaded = readStableRegularFile(path, root, { ownerOnly });
    if (loaded.hash !== LOCKED_WRANGLER_RESOLUTION_GUARD_SHA256 ||
        !loaded.raw.equals(LOCKED_WRANGLER_RESOLUTION_GUARD_BYTES)) {
      loaded.raw.fill(0);
      fail();
    }
    loaded.raw.fill(0);
    resolutionGuardPath = path;
    pins.push(Object.freeze({
      path,
      relative: LOCKED_WRANGLER_RESOLUTION_GUARD,
      hash: loaded.hash,
      identity: loaded.identity,
    }));
  }
  rows.push(resolutionGuardRow);
  rows.sort((left, right) => left.path.localeCompare(right.path));
  pins.sort((left, right) => left.relative.localeCompare(right.relative));
  directories.sort((left, right) => left.relative.localeCompare(right.relative));
  const totalBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
  if (rows.length < 1 || rows.length > MAX_FILES ||
      totalBytes < 1 || totalBytes > MAX_TOTAL_BYTES) fail();
  const entrypoint = pins.find((pin) => pin.relative === LOCKED_WRANGLER_ENTRYPOINT);
  if (!entrypoint) fail();
  if (exactRoot) assertExactPreparedTree(root, packageKeys, pins, ownerOnly);

  const nodeRoot = realpathSync(dirname(process.execPath));
  const node = readStableRegularFile(process.execPath, nodeRoot, {
    maxBytes: MAX_CACHE_ARCHIVE_BYTES,
  });
  node.raw.fill(0);
  const inventorySha256 = digest("sha256", canonical({
    schema_version: 3,
    host,
    node: { version: process.version, sha256: node.hash },
    package_lock_sha256: lockFile.hash,
    entrypoint: LOCKED_WRANGLER_ENTRYPOINT,
    resolution_guard: {
      path: LOCKED_WRANGLER_RESOLUTION_GUARD,
      sha256: LOCKED_WRANGLER_RESOLUTION_GUARD_SHA256,
      minimum_node_version: LOCKED_WRANGLER_RESOLUTION_GUARD_MIN_NODE,
    },
    packages: packageKeys,
    files: rows,
  }));
  return Object.freeze({
    schemaVersion: 3,
    packageName: LOCKED_WRANGLER_PACKAGE,
    packageVersion: LOCKED_WRANGLER_VERSION,
    packageLockSha256: lockFile.hash,
    entrypointRelative: LOCKED_WRANGLER_ENTRYPOINT,
    entrypointPath: entrypoint.path,
    entrypointSha256: entrypoint.hash,
    resolutionGuardRelative: LOCKED_WRANGLER_RESOLUTION_GUARD,
    resolutionGuardPath,
    resolutionGuardSha256: LOCKED_WRANGLER_RESOLUTION_GUARD_SHA256,
    resolutionGuardMinimumNodeVersion: LOCKED_WRANGLER_RESOLUTION_GUARD_MIN_NODE,
    inventorySha256,
    packageCount: packageKeys.length,
    fileCount: rows.length,
    totalBytes,
    host,
    nodeVersion: process.version,
    nodeExecPath: process.execPath,
    nodeExecSha256: node.hash,
    ownerOnly,
    exactRoot,
    lockPin: Object.freeze({
      path: lockPath,
      relative: "package-lock.json",
      hash: lockFile.hash,
      identity: lockFile.identity,
    }),
    nodePin: Object.freeze({
      path: process.execPath,
      hash: node.hash,
      identity: node.identity,
    }),
    filePins: Object.freeze(pins),
    directoryPins: Object.freeze(directories),
  });
}

function assertPublicRuntimeIdentity(left, right, code) {
  const keys = [
    "schemaVersion", "packageName", "packageVersion", "packageLockSha256",
    "entrypointRelative", "entrypointSha256", "inventorySha256", "packageCount",
    "fileCount", "totalBytes", "nodeVersion", "nodeExecSha256",
    "resolutionGuardRelative", "resolutionGuardSha256",
    "resolutionGuardMinimumNodeVersion",
  ];
  if (keys.some((key) => left?.[key] !== right?.[key]) ||
      canonical(left?.host) !== canonical(right?.host)) fail(code);
  return true;
}

export function assertLockedWranglerRuntimeUnchanged(expected) {
  if (!expected || expected.schemaVersion !== 3) {
    fail("LOCKED_WRANGLER_RUNTIME_CHANGED");
  }
  const current = inspectLockedWranglerRuntime(dirname(expected.lockPin.path), {
    ownerOnly: expected.ownerOnly,
    exactRoot: expected.exactRoot,
    ...expected.host,
  });
  assertPublicRuntimeIdentity(current, expected, "LOCKED_WRANGLER_RUNTIME_CHANGED");
  if (current.entrypointPath !== expected.entrypointPath ||
      current.resolutionGuardPath !== expected.resolutionGuardPath ||
      current.nodeExecPath !== expected.nodeExecPath ||
      !sameIdentity(current.lockPin.identity, expected.lockPin.identity) ||
      !sameIdentity(current.nodePin.identity, expected.nodePin.identity) ||
      current.filePins.length !== expected.filePins.length ||
      current.directoryPins.length !== expected.directoryPins.length) {
    fail("LOCKED_WRANGLER_RUNTIME_CHANGED");
  }
  for (let index = 0; index < current.filePins.length; index++) {
    const left = current.filePins[index];
    const right = expected.filePins[index];
    if (left.relative !== right.relative || left.hash !== right.hash ||
        !sameIdentity(left.identity, right.identity)) {
      fail("LOCKED_WRANGLER_RUNTIME_CHANGED");
    }
  }
  for (let index = 0; index < current.directoryPins.length; index++) {
    const left = current.directoryPins[index];
    const right = expected.directoryPins[index];
    if (left.relative !== right.relative || !sameIdentity(left.identity, right.identity)) {
      fail("LOCKED_WRANGLER_RUNTIME_CHANGED");
    }
  }
  return true;
}

function parseOctal(bytes) {
  const text = bytes.toString("ascii").replace(/\0.*$/s, "").trim();
  if (!/^[0-7]+$/.test(text)) fail("LOCKED_WRANGLER_CACHE_ARCHIVE_INVALID");
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("LOCKED_WRANGLER_CACHE_ARCHIVE_INVALID");
  }
  return value;
}

function tarText(bytes) {
  const end = bytes.indexOf(0);
  try { return UTF8.decode(end < 0 ? bytes : bytes.subarray(0, end)); }
  catch { fail("LOCKED_WRANGLER_CACHE_ARCHIVE_INVALID"); }
}

function verifyTarHeader(header) {
  if (header.length !== 512 || tarText(header.subarray(257, 263)) !== "ustar") {
    fail("LOCKED_WRANGLER_CACHE_ARCHIVE_INVALID");
  }
  const expected = parseOctal(header.subarray(148, 156));
  let sum = 0;
  for (let index = 0; index < header.length; index++) {
    sum += index >= 148 && index < 156 ? 32 : header[index];
  }
  if (sum !== expected) fail("LOCKED_WRANGLER_CACHE_ARCHIVE_INVALID");
}

function extractPackageArchive(archive, destination, packageKey) {
  let tar;
  try { tar = gunzipSync(archive, { maxOutputLength: MAX_PACKAGE_UNPACKED_BYTES }); }
  catch { fail("LOCKED_WRANGLER_CACHE_ARCHIVE_INVALID"); }
  const packageRoot = resolve(destination, packageKey);
  if (!within(destination, packageRoot) || packageRoot === destination) fail();
  const seen = new Set();
  let offset = 0;
  let ended = false;
  try {
    while (offset + 512 <= tar.length) {
      const header = tar.subarray(offset, offset + 512);
      if (header.every((byte) => byte === 0)) {
        if (!tar.subarray(offset).every((byte) => byte === 0)) {
          fail("LOCKED_WRANGLER_CACHE_ARCHIVE_INVALID");
        }
        ended = true;
        break;
      }
      verifyTarHeader(header);
      const type = header[156];
      if (type !== 0 && type !== 0x30) fail("LOCKED_WRANGLER_CACHE_ARCHIVE_INVALID");
      if (tarText(header.subarray(157, 257))) fail("LOCKED_WRANGLER_CACHE_ARCHIVE_INVALID");
      const name = tarText(header.subarray(0, 100));
      const prefix = tarText(header.subarray(345, 500));
      const archivedPath = prefix ? `${prefix}/${name}` : name;
      if (!archivedPath.startsWith("package/")) fail("LOCKED_WRANGLER_CACHE_ARCHIVE_INVALID");
      const packageRelative = normalizeRelative(archivedPath.slice("package/".length));
      if (seen.has(packageRelative)) fail("LOCKED_WRANGLER_CACHE_ARCHIVE_INVALID");
      seen.add(packageRelative);
      const size = parseOctal(header.subarray(124, 136));
      const mode = parseOctal(header.subarray(100, 108));
      const contentStart = offset + 512;
      const contentEnd = contentStart + size;
      const paddedEnd = contentStart + Math.ceil(size / 512) * 512;
      if (contentEnd > tar.length || paddedEnd > tar.length ||
          !tar.subarray(contentEnd, paddedEnd).every((byte) => byte === 0)) {
        fail("LOCKED_WRANGLER_CACHE_ARCHIVE_INVALID");
      }
      const target = resolve(packageRoot, packageRelative);
      if (!within(packageRoot, target) || target === packageRoot) fail();
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, tar.subarray(contentStart, contentEnd), {
        flag: "wx",
        mode: mode & 0o111 ? 0o700 : 0o600,
      });
      if (process.platform !== "win32") chmodSync(target, mode & 0o111 ? 0o700 : 0o600);
      offset = paddedEnd;
    }
    if (!ended || seen.size < 1) fail("LOCKED_WRANGLER_CACHE_ARCHIVE_INVALID");
  } finally {
    tar.fill(0);
  }
}

function cacheArchivePath(cacheContentRoot, integrity) {
  const encoded = integrity.slice("sha512-".length);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== encoded) {
    fail("LOCKED_WRANGLER_CACHE_ARCHIVE_INVALID");
  }
  const hex = bytes.toString("hex");
  bytes.fill(0);
  return resolve(cacheContentRoot, hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
}

/** Build the fixed runtime solely from lock-integrity cache objects. */
export function prepareLockedWranglerRuntimeFromCache({
  sourceRoot: sourceRootInput,
  destination: destinationInput,
  cacheContentRoot: cacheContentRootInput,
  ...hostInput
}) {
  const sourceRoot = realpathSync(resolve(sourceRootInput));
  const cacheContentRoot = realpathSync(resolve(cacheContentRootInput));
  const destination = resolve(destinationInput);
  if (within(sourceRoot, destination) || within(destination, sourceRoot)) {
    fail("LOCKED_WRANGLER_RUNTIME_DESTINATION_INVALID");
  }
  const sourceLock = readStableRegularFile(join(sourceRoot, "package-lock.json"), sourceRoot);
  let lock;
  try { lock = JSON.parse(sourceLock.raw.toString("utf8")); }
  catch { sourceLock.raw.fill(0); fail(); }
  const host = hostIdentity(hostInput);
  const packageKeys = lockedClosure(lock, host);
  try {
    mkdirSync(destination, { recursive: false, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(destination, 0o700);
    writeFileSync(join(destination, "package-lock.json"), sourceLock.raw, {
      flag: "wx",
      mode: 0o600,
    });
    if (process.platform !== "win32") chmodSync(join(destination, "package-lock.json"), 0o600);
    writeFileSync(
      join(destination, LOCKED_WRANGLER_RESOLUTION_GUARD),
      LOCKED_WRANGLER_RESOLUTION_GUARD_BYTES,
      { flag: "wx", mode: 0o600 },
    );
    if (process.platform !== "win32") {
      chmodSync(join(destination, LOCKED_WRANGLER_RESOLUTION_GUARD), 0o600);
    }
    for (const packageKey of packageKeys) {
      const entry = lock.packages[packageKey];
      const archivePath = cacheArchivePath(cacheContentRoot, entry.integrity);
      if (!within(cacheContentRoot, archivePath) || archivePath === cacheContentRoot) {
        fail("LOCKED_WRANGLER_CACHE_ARCHIVE_INVALID");
      }
      const cached = readStableRegularFile(archivePath, cacheContentRoot, {
        maxBytes: MAX_CACHE_ARCHIVE_BYTES,
      });
      try {
        const expected = Buffer.from(entry.integrity.slice("sha512-".length), "base64")
          .toString("hex");
        if (digest("sha512", cached.raw) !== expected) {
          fail("LOCKED_WRANGLER_CACHE_INTEGRITY_MISMATCH");
        }
        extractPackageArchive(cached.raw, destination, packageKey);
      } finally {
        cached.raw.fill(0);
      }
    }
    const prepared = inspectLockedWranglerRuntime(destination, {
      ownerOnly: true,
      exactRoot: true,
      ...host,
    });
    const installed = inspectLockedWranglerRuntime(sourceRoot, host);
    assertPublicRuntimeIdentity(
      installed,
      prepared,
      "LOCKED_WRANGLER_RUNTIME_SOURCE_MISMATCH",
    );
    return prepared;
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    if (error instanceof LockedWranglerRuntimeError) throw error;
    fail("LOCKED_WRANGLER_RUNTIME_PREPARATION_FAILED");
  } finally {
    sourceLock.raw.fill(0);
  }
}

export function materializeLockedWranglerRuntime(expected, destinationInput) {
  if (!expected?.exactRoot || !expected.resolutionGuardPath) {
    fail("LOCKED_WRANGLER_RUNTIME_COPY_FAILED");
  }
  assertLockedWranglerRuntimeUnchanged(expected);
  const destination = resolve(destinationInput);
  mkdirSync(destination, { recursive: false, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(destination, 0o700);
  const sources = [expected.lockPin, ...expected.filePins];
  try {
    for (const source of sources) {
      const target = resolve(destination, source.relative);
      if (!within(destination, target) || target === destination) {
        fail("LOCKED_WRANGLER_RUNTIME_COPY_FAILED");
      }
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      copyFileSync(source.path, target, fsConstants.COPYFILE_FICLONE);
      const executable = source.relative !== "package-lock.json" &&
        Boolean(source.identity.mode & 0o111);
      if (process.platform !== "win32") chmodSync(target, executable ? 0o700 : 0o600);
    }
    const descriptor = inspectLockedWranglerRuntime(destination, {
      ownerOnly: true,
      exactRoot: true,
      ...expected.host,
    });
    assertPublicRuntimeIdentity(
      descriptor,
      expected,
      "LOCKED_WRANGLER_RUNTIME_COPY_FAILED",
    );
    return Object.freeze({
      root: destination,
      entrypointPath: descriptor.entrypointPath,
      resolutionGuardPath: descriptor.resolutionGuardPath,
      resolutionGuardSha256: descriptor.resolutionGuardSha256,
      inventorySha256: descriptor.inventorySha256,
      descriptor,
      filePins: descriptor.filePins,
    });
  } catch (error) {
    if (error instanceof LockedWranglerRuntimeError) throw error;
    fail("LOCKED_WRANGLER_RUNTIME_COPY_FAILED");
  }
}

export function assertMaterializedWranglerRuntimeUnchanged(materialized) {
  if (!materialized?.descriptor ||
      materialized.entrypointPath !== materialized.descriptor.entrypointPath ||
      materialized.resolutionGuardPath !==
        materialized.descriptor.resolutionGuardPath ||
      materialized.resolutionGuardSha256 !==
        materialized.descriptor.resolutionGuardSha256 ||
      materialized.inventorySha256 !== materialized.descriptor.inventorySha256) {
    fail("LOCKED_WRANGLER_RUNTIME_COPY_CHANGED");
  }
  try { return assertLockedWranglerRuntimeUnchanged(materialized.descriptor); }
  catch { fail("LOCKED_WRANGLER_RUNTIME_COPY_CHANGED"); }
}
