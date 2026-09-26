import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { basename, dirname, isAbsolute, resolve } from "node:path";

const nativeRealpath = realpathSync.native || realpathSync;

function fsApi(overrides = {}) {
  return {
    closeSync,
    fchmodSync,
    fstatSync,
    fsyncSync,
    lstatSync,
    openSync,
    readFileSync,
    realpathNative: nativeRealpath,
    renameSync,
    statSync,
    unlinkSync,
    writeSync,
    ...overrides,
  };
}

function sameFile(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function linkCountIsOne(value) {
  return value === 1 || value === 1n;
}

function writeAll(io, descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = io.writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (!written) throw new Error("the manifest write stopped before all bytes were durable");
    offset += written;
  }
}

function writeExclusive(io, path, bytes, mode) {
  const noFollow = fsConstants.O_NOFOLLOW || 0;
  let descriptor = null;
  try {
    descriptor = io.openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      mode,
    );
    writeAll(io, descriptor, bytes);
    io.fchmodSync(descriptor, mode);
    io.fsyncSync(descriptor);
  } catch (error) {
    if (descriptor !== null) {
      try { io.closeSync(descriptor); } catch { /* preserve the write failure */ }
      descriptor = null;
      try { io.unlinkSync(path); } catch { /* preserve the write failure */ }
    }
    throw error;
  } finally {
    if (descriptor !== null) io.closeSync(descriptor);
  }
}

function defaultSyncDirectory(directory, io) {
  const descriptor = io.openSync(
    directory,
    fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0) | (fsConstants.O_NOFOLLOW || 0),
  );
  try {
    io.fsyncSync(descriptor);
  } finally {
    io.closeSync(descriptor);
  }
}

function folderOffTimestamp(date) {
  const iso = date.toISOString();
  return iso.replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

function unlinkIfPresent(io, path) {
  try {
    io.unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

/**
 * Replace a manifest without following a link, changing its mode, or exposing
 * a partial JSON file. A verified backup and same-directory staging file are
 * durable before rename. Any post-rename failure restores the exact original
 * bytes before the error leaves this boundary.
 */
export function writeManifestAtomically(manifestPath, intendedManifest, options = {}) {
  if (!intendedManifest || typeof intendedManifest !== "object" || Array.isArray(intendedManifest)) {
    throw new TypeError("the intended manifest must be one JSON object");
  }
  const io = fsApi(options.fs);
  const platform = options.platform || process.platform;
  const now = options.now ? options.now() : new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("the folder-off timestamp is invalid");
  }
  const absolute = resolve(manifestPath);
  const directory = dirname(absolute);
  const named = io.lstatSync(absolute);
  if (named.isSymbolicLink()) {
    throw new Error("the brain manifest must not be a symbolic link");
  }
  if (!named.isFile()) throw new Error("the brain manifest must be a regular file");
  if (!linkCountIsOne(named.nlink)) {
    throw new Error("the brain manifest must not have multiple filesystem links");
  }

  const descriptor = io.openSync(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  let originalBytes;
  let opened;
  try {
    opened = io.fstatSync(descriptor);
    if (!opened.isFile() || !linkCountIsOne(opened.nlink) || !sameFile(named, opened)) {
      throw new Error("the brain manifest changed while it was opened");
    }
    originalBytes = io.readFileSync(descriptor);
    const after = io.fstatSync(descriptor);
    const current = io.lstatSync(absolute);
    if (!sameFile(opened, after) || !sameFile(opened, current) ||
        !linkCountIsOne(after.nlink) || after.size !== originalBytes.length) {
      throw new Error("the brain manifest changed while it was read");
    }
  } finally {
    io.closeSync(descriptor);
  }

  const mode = Number(opened.mode) & 0o7777;
  const intendedBytes = Buffer.from(`${JSON.stringify(intendedManifest, null, 2)}\n`, "utf8");
  const stamp = folderOffTimestamp(now);
  const backupPath = `${absolute}.before-folder-off-${stamp}`;
  const nonce = (options.randomBytes || randomBytes)(12).toString("hex");
  const temporaryPath = `${directory}/.${basename(absolute)}.folder-off-${nonce}.tmp`;
  const rollbackPath = `${directory}/.${basename(absolute)}.folder-off-${nonce}.rollback.tmp`;
  const syncDirectory = options.syncDirectory || ((path) => defaultSyncDirectory(path, io));
  let backupCreated = false;
  let renamed = false;

  try {
    writeExclusive(io, backupPath, originalBytes, mode);
    backupCreated = true;
    if (!io.readFileSync(backupPath).equals(originalBytes)) {
      throw new Error("the folder-off backup did not read back exactly");
    }
    writeExclusive(io, temporaryPath, intendedBytes, mode);
    options.beforeRename?.({ manifestPath: absolute, backupPath, temporaryPath });
    io.renameSync(temporaryPath, absolute);
    renamed = true;
    if (platform !== "win32") syncDirectory(directory);

    const readbackBytes = io.readFileSync(absolute);
    let readback;
    try {
      readback = JSON.parse(readbackBytes.toString("utf8"));
    } catch {
      throw new Error("the folder-off manifest readback was not valid JSON");
    }
    if (!readbackBytes.equals(intendedBytes) || !isDeepStrictEqual(readback, intendedManifest)) {
      throw new Error("the folder-off manifest did not read back exactly");
    }
    const finalState = io.lstatSync(absolute);
    if (!finalState.isFile() || finalState.isSymbolicLink() ||
        !linkCountIsOne(finalState.nlink) || (Number(finalState.mode) & 0o7777) !== mode) {
      throw new Error("the folder-off manifest mode or file identity is unsafe after replacement");
    }
    return Object.freeze({ backupPath, manifestPath: absolute, mode });
  } catch (error) {
    let restorationError = null;
    if (renamed) {
      try {
        writeExclusive(io, rollbackPath, originalBytes, mode);
        io.renameSync(rollbackPath, absolute);
        if (platform !== "win32") {
          try { syncDirectory(directory); } catch { /* exact byte readback below remains authoritative */ }
        }
        if (!io.readFileSync(absolute).equals(originalBytes)) {
          throw new Error("the original manifest bytes were not restored");
        }
      } catch (restoreError) {
        restorationError = restoreError;
      }
    }
    try { unlinkIfPresent(io, temporaryPath); } catch { /* preserve the primary error */ }
    try { unlinkIfPresent(io, rollbackPath); } catch { /* preserve the primary error */ }
    if (backupCreated) {
      try { unlinkIfPresent(io, backupPath); } catch { /* preserve the primary error */ }
    }
    if (restorationError) {
      throw new Error(
        `${error.message}; the original manifest could not be restored exactly: ${restorationError.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

/** Retirement is active solely from the durable timestamp, never enabled. */
export function retiredLocalFolderOf(manifest) {
  const local = manifest?.corpora?.local_folder;
  return local && typeof local === "object" && !Array.isArray(local) &&
    typeof local.retired_at === "string" && local.retired_at.trim() !== ""
    ? local
    : null;
}

/** Capture only directory identity. No entry below the folder is opened. */
export function retiredIdentityOfPath(path, options = {}) {
  if (typeof path !== "string" || !isAbsolute(path)) return null;
  const io = fsApi(options.fs);
  try {
    const named = io.lstatSync(path);
    if (!named.isDirectory() || named.isSymbolicLink()) return null;
    const realpath = io.realpathNative(path);
    const identity = io.statSync(realpath, { bigint: true });
    if (!identity.isDirectory()) return null;
    return Object.freeze({
      realpath,
      dev: String(identity.dev),
      ino: String(identity.ino),
    });
  } catch {
    return null;
  }
}

function normalizedPath(value, platform) {
  let output = String(value || "").replace(/\\/gu, "/");
  while (output.length > 1 && output.endsWith("/")) output = output.slice(0, -1);
  return platform === "darwin" || platform === "win32" ? output.toLowerCase() : output;
}

function sameOrInside(child, parent) {
  return Boolean(child && parent && (child === parent || child.startsWith(`${parent}/`)));
}

export function sameRetiredDirectoryIdentity(state, retiredIdentity) {
  if (!state || !retiredIdentity || typeof retiredIdentity !== "object") return false;
  return String(state.dev) === String(retiredIdentity.dev) &&
    String(state.ino) === String(retiredIdentity.ino);
}

function ancestorHasIdentity(rootRealpath, retiredIdentity, io) {
  if (!retiredIdentity) return false;
  let current = rootRealpath;
  while (current) {
    try {
      if (sameRetiredDirectoryIdentity(io.statSync(current, { bigint: true }), retiredIdentity)) return true;
    } catch {
      return false;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

/**
 * Match only the filesystem-location variants. Source-name precedence belongs
 * to the CLI because those checks intentionally need no filesystem access.
 */
export function retiredFolderLocationVariant(retired, root, options = {}) {
  if (!retired || typeof root !== "string") return null;
  const io = fsApi(options.fs);
  const platform = options.platform || process.platform;
  let rootRealpath;
  try {
    rootRealpath = io.realpathNative(root);
  } catch {
    return null;
  }
  const rootNormalized = normalizedPath(rootRealpath, platform);
  const retiredPaths = [retired?.retired_identity?.realpath, retired?.retired_path]
    .map((value) => normalizedPath(value, platform))
    .filter(Boolean);

  if (ancestorHasIdentity(rootRealpath, retired.retired_identity, io) ||
      retiredPaths.some((candidate) => sameOrInside(rootNormalized, candidate))) {
    return "inside_retired";
  }

  if (retiredPaths.some((candidate) => sameOrInside(candidate, rootNormalized))) {
    return "contains_retired";
  }

  // If the recorded path still exists, bind its current canonical location to
  // the same dev/ino signal. This covers a spelling alias without scanning the
  // requested root; a moved descendant is caught by the walk-level check.
  for (const candidate of [retired?.retired_identity?.realpath, retired?.retired_path]) {
    if (!candidate) continue;
    try {
      const real = io.realpathNative(candidate);
      const state = io.statSync(real, { bigint: true });
      if (sameRetiredDirectoryIdentity(state, retired.retired_identity) &&
          sameOrInside(normalizedPath(real, platform), rootNormalized)) {
        return "contains_retired";
      }
    } catch {
      // A missing recorded path is expected after an owner moves the folder.
    }
  }
  return null;
}
