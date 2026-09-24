/**
 * Durable local-folder identity and bounded relocation recovery.
 *
 * Paths are convenient locators, not identity. A bookmark or marker proves
 * which folder moved; a name match never does. The adjacent state moves with
 * the Brain folder, while the owner-private locator copy is what lets a CLI
 * recover that adjacent state after the manifest folder itself moves.
 */

import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

export const FOLDER_MARKER = ".financial-brain-folder.json";
export const FOLDER_STATE = ".brain-folder-identities.json";
export const FOLDER_STATE_VERSION = 1;
const LOCATOR_FILE = "folder-locator.json";
const MAX_JSON_BYTES = 256 * 1024;
const MAX_SEARCH_DEPTH = 5;
const MAX_SEARCH_DIRECTORIES = 25_000;
const MAX_WARNING_FILE_BYTES = 2 * 1024 * 1024;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export class FolderIdentityError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "FolderIdentityError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, message, detail) {
  throw new FolderIdentityError(code, message, detail);
}

function assertSafeAbsolutePath(value, label) {
  const path = String(value || "");
  if (!path || !isAbsolute(path) || CONTROL_RE.test(path) || path.length > 4096) {
    fail("FOLDER_PATH_INVALID", `${label} is not one safe absolute path`);
  }
  return resolve(path);
}

function directoryExists(path, stat = lstatSync) {
  try {
    const info = stat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

function canonicalDirectoryPath(path) {
  try { return realpathSync.native(resolve(path)); } catch { return resolve(path); }
}

function privateStateDirectory({
  stateDirectory,
  platform = process.platform,
  environment = process.env,
  home = homedir(),
} = {}) {
  if (stateDirectory) return resolve(stateDirectory);
  if (platform === "win32" && environment?.LOCALAPPDATA && isAbsolute(environment.LOCALAPPDATA)) {
    return join(environment.LOCALAPPDATA, "FinancialBrain", "state");
  }
  return join(assertSafeAbsolutePath(home, "the user home folder"), ".financial-brain", "state");
}

export function folderIdentityStatePath(manifestPath) {
  return join(dirname(assertSafeAbsolutePath(manifestPath, "the Brain manifest")), FOLDER_STATE);
}

export function folderLocatorPath(options = {}) {
  return join(privateStateDirectory(options), LOCATOR_FILE);
}

function safeJson(path, { allowMissing = true } = {}) {
  let info;
  try { info = lstatSync(path); } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    fail("FOLDER_STATE_UNREADABLE", "the folder identity record could not be inspected");
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 2 || info.size > MAX_JSON_BYTES) {
    fail("FOLDER_STATE_UNSAFE", "the folder identity record is not one safe regular file");
  }
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch {
    fail("FOLDER_STATE_INVALID", "the folder identity record is not valid JSON");
  }
  return parsed;
}

function atomicJson(path, value, { mode = 0o600 } = {}) {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = join(parent, `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let descriptor;
  let created = false;
  try {
    descriptor = openSync(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0),
      mode,
    );
    created = true;
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    if (process.platform !== "win32") chmodSync(temporary, mode);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    created = false;
    const readback = safeJson(path, { allowMissing: false });
    if (JSON.stringify(readback) !== JSON.stringify(value)) {
      fail("FOLDER_STATE_WRITE_INCOMPLETE", "the folder identity record did not verify after writing");
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (created) {
      try { unlinkSync(temporary); } catch { /* preserve the original failure */ }
    }
  }
}

function markerValue(record, brainId) {
  return { id: record.id, role: record.role, brain: brainId };
}

function readMarker(folder) {
  const value = safeJson(join(folder, FOLDER_MARKER));
  if (!value) return null;
  if (!value || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "brain,id,role" ||
      typeof value.id !== "string" || !/^[0-9a-f-]{36}$/.test(value.id) ||
      typeof value.brain !== "string" || !/^[0-9a-f-]{36}$/.test(value.brain) ||
      typeof value.role !== "string" || !/^(?:manifest-home|source:[a-z0-9][a-z0-9_-]{0,63})$/.test(value.role)) {
    fail("FOLDER_MARKER_INVALID", `the folder marker at ${folder} is invalid`);
  }
  return value;
}

function ensureMarker(folder, record, brainId, options = {}) {
  const existing = readMarker(folder);
  const expected = markerValue(record, brainId);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(expected)) {
      fail(
        "FOLDER_MARKER_CONFLICT",
        `the folder at ${folder} already belongs to a different tracked role; nothing was changed`,
      );
    }
    return false;
  }
  const markerPath = join(folder, FOLDER_MARKER);
  atomicJson(markerPath, expected);
  if ((options.platform ?? process.platform) === "win32") {
    const result = (options.spawnSync ?? spawnSync)("attrib", ["+h", markerPath], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    if (result.status !== 0) {
      fail("FOLDER_MARKER_HIDE_FAILED", "the Windows folder marker could not be made hidden safely");
    }
  }
  return true;
}

function runJxa(script, args, spawn = spawnSync) {
  const result = spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, ...args], {
    encoding: "utf8",
    // Folder tracking must never turn a normal CLI start into a long pause if
    // the macOS automation service is wedged. The marker remains the portable
    // fallback, so a bounded bookmark attempt is safer than blocking ingest.
    timeout: 5_000,
    env: { PATH: "/usr/bin:/bin" },
  });
  if (result.status !== 0) return null;
  const output = String(result.stdout || "").trim();
  return output || null;
}

export function createMacFolderBookmark(path, options = {}) {
  const script = String.raw`
ObjC.import('Foundation');
function run(argv) {
  const url = $.NSURL.fileURLWithPath(argv[0]);
  const data = url.bookmarkDataWithOptionsIncludingResourceValuesForKeysRelativeToURLError(0, [], undefined, undefined);
  if (!data) throw new Error('bookmark creation failed');
  return ObjC.unwrap(data.base64EncodedStringWithOptions(0));
}`;
  return runJxa(script, [path], options.spawnSync ?? spawnSync);
}

export function resolveMacFolderBookmark(bookmark, options = {}) {
  const script = String.raw`
ObjC.import('Foundation');
function run(argv) {
  const data = $.NSData.alloc.initWithBase64EncodedStringOptions(argv[0], 0);
  if (!data) throw new Error('invalid bookmark');
  const url = $.NSURL.URLByResolvingBookmarkDataOptionsRelativeToURLBookmarkDataIsStaleError(data, 0, undefined, undefined, undefined);
  if (!url) throw new Error('bookmark resolution failed');
  return ObjC.unwrap(url.path);
}`;
  return runJxa(script, [bookmark], options.spawnSync ?? spawnSync);
}

function windowsFileId(path, options = {}) {
  if ((options.platform ?? process.platform) !== "win32") return null;
  const spawn = options.spawnSync ?? spawnSync;
  const result = spawn("fsutil", ["file", "queryfileid", path], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  return String(result.stdout || "").match(/0x[0-9a-f]+/i)?.[0]?.toLowerCase() || null;
}

function nativeIdentity(path, options) {
  const platform = options.platform ?? process.platform;
  return {
    bookmark: platform === "darwin"
      ? (options.createBookmark ?? createMacFolderBookmark)(path, options) || null
      : null,
    windows_file_id: platform === "win32" ? windowsFileId(path, options) : null,
  };
}

function candidateRoots(options = {}) {
  if (Array.isArray(options.candidateRoots)) {
    return [...new Set(options.candidateRoots.filter(Boolean).map((item) => resolve(item)))];
  }
  const home = resolve(options.home || homedir());
  const environment = options.environment ?? process.env;
  const roots = [
    home,
    join(home, "Desktop"),
    join(home, "Documents"),
    join(home, "Library", "Mobile Documents", "com~apple~CloudDocs"),
  ];
  const cloudStorage = join(home, "Library", "CloudStorage");
  try {
    for (const entry of readdirSync(cloudStorage, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) roots.push(join(cloudStorage, entry.name));
    }
  } catch { /* optional root */ }
  if (environment.USERPROFILE && isAbsolute(environment.USERPROFILE)) roots.push(environment.USERPROFILE);
  if (environment.OneDrive && isAbsolute(environment.OneDrive)) roots.push(environment.OneDrive);
  return [...new Set(roots.filter((root) => directoryExists(root)))];
}

export function findFolderMarkers(identity, options = {}) {
  const matches = [];
  const fileIdMatches = [];
  const seen = new Set();
  let visited = 0;
  const inspect = (folder, depth) => {
    const canonical = resolve(folder);
    if (seen.has(canonical) || visited >= (options.maxDirectories ?? MAX_SEARCH_DIRECTORIES)) return;
    seen.add(canonical);
    visited++;
    let marker;
    try { marker = readMarker(canonical); } catch (error) {
      if (error?.code !== "FOLDER_STATE_UNREADABLE") throw error;
    }
    if (marker?.id === identity.id && marker?.brain === identity.brain_id && marker?.role === identity.role) {
      matches.push(canonicalDirectoryPath(canonical));
    } else if (!marker && (options.platform ?? process.platform) === "win32" && identity.windows_file_id) {
      const observed = windowsFileId(canonical, options);
      if (observed && observed === identity.windows_file_id) {
        const matched = canonicalDirectoryPath(canonical);
        matches.push(matched);
        fileIdMatches.push(matched);
      }
    }
    if (depth >= (options.maxDepth ?? MAX_SEARCH_DEPTH)) return;
    let entries;
    try { entries = readdirSync(canonical, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (["node_modules", ".git", ".Trash", "$RECYCLE.BIN"].includes(entry.name)) continue;
      inspect(join(canonical, entry.name), depth + 1);
    }
  };
  for (const root of candidateRoots(options)) inspect(root, 0);
  return {
    matches: [...new Set(matches)].sort(),
    fileIdMatches: [...new Set(fileIdMatches)].sort(),
    visited,
  };
}

function resolveMissingIdentity(identity, options = {}) {
  const platform = options.platform ?? process.platform;
  let bookmarked = null;
  if (platform === "darwin" && identity.bookmark) {
    const candidate = (options.resolveBookmark ?? resolveMacFolderBookmark)(identity.bookmark, options);
    if (candidate && directoryExists(candidate)) {
      const marker = readMarker(candidate);
      if (marker?.id === identity.id && marker?.brain === identity.brain_id && marker?.role === identity.role) {
        bookmarked = canonicalDirectoryPath(candidate);
      }
    }
  }
  const searched = findFolderMarkers(identity, options);
  const matches = [...new Set([...(bookmarked ? [bookmarked] : []), ...searched.matches]
    .map(canonicalDirectoryPath))].sort();
  if (matches.length === 1) {
    return {
      status: "moved",
      path: matches[0],
      via: bookmarked === matches[0]
        ? "bookmark"
        : searched.fileIdMatches.includes(matches[0]) ? "file-id" : "marker",
      matches,
    };
  }
  if (matches.length > 1) {
    return { status: "ambiguous", path: null, via: "marker", matches };
  }
  return { status: "missing", path: null, via: null, matches: [] };
}

function missingMessage(identity) {
  const label = identity.role === "manifest-home" ? "Brain folder" : "Brain Source folder";
  return `Your ${label} is no longer at ${identity.path}. Nothing was deleted. ` +
    `Put it back or run brain relocate --to <new>.`;
}

function ambiguousMessage(identity, matches) {
  return `More than one folder has the identity for ${identity.role}:\n` +
    matches.map((path) => `  ${path}`).join("\n") +
    "\nNothing was changed. Choose one with brain relocate --to <path>.";
}

function trackedSources(manifest) {
  const found = [];
  const local = manifest?.corpora?.local_folder;
  if (local?.enabled === true && typeof local.path === "string" && local.path) {
    found.push({ role: `source:${String(local.source || "documents")}`, path: local.path, locator: ["local_folder"] });
  }
  const upload = manifest?.corpora?.upload;
  const declared = upload?.folders ?? upload?.paths ?? (upload?.path ? [upload.path] : []);
  if (upload?.enabled === true && Array.isArray(declared)) {
    declared.forEach((entry, index) => {
      const path = typeof entry === "string" ? entry : entry?.path;
      const source = typeof entry === "object" && entry?.source ? entry.source : "upload";
      if (typeof path === "string" && path) {
        found.push({ role: `source:${String(source)}`, path, locator: ["upload", index] });
      }
    });
  }
  const deduped = [];
  for (const item of found) {
    const canonical = resolve(item.path);
    const existing = deduped.find((one) => one.role === item.role && resolve(one.path) === canonical);
    if (existing) existing.locators.push(item.locator);
    else deduped.push({ ...item, path: canonical, locators: [item.locator] });
  }
  return deduped;
}

function replaceManifestPath(manifest, locator, nextPath) {
  if (locator[0] === "local_folder") manifest.corpora.local_folder.path = nextPath;
  if (locator[0] !== "upload") return;
  const upload = manifest.corpora.upload;
  const key = Array.isArray(upload.folders) ? "folders" : Array.isArray(upload.paths) ? "paths" : "path";
  if (key === "path") {
    upload.path = nextPath;
    return;
  }
  const current = upload[key][locator[1]];
  upload[key][locator[1]] = typeof current === "string" ? nextPath : { ...current, path: nextPath };
}

function newIdentity(role, path, brainId, options) {
  return {
    id: randomUUID(),
    brain_id: brainId,
    role,
    path: resolve(path),
    ...nativeIdentity(resolve(path), options),
  };
}

function validateState(value) {
  if (!value || value.version !== FOLDER_STATE_VERSION ||
      typeof value.brain_id !== "string" || !Array.isArray(value.folders)) {
    fail("FOLDER_STATE_INVALID", "the folder identity record has an unsupported format");
  }
  return value;
}

function saveManifestWithBackup(manifestPath, manifest, options = {}) {
  const original = readFileSync(manifestPath);
  const backupPath = join(dirname(manifestPath), ".brain-folder-relocation-backup.json");
  if (options.writeBackup !== false) {
    const prior = (() => { try { return JSON.parse(original.toString("utf8")); } catch { return { unreadable: true }; } })();
    atomicJson(backupPath, {
      version: 1,
      created_at: (options.now ?? (() => new Date()))().toISOString(),
      manifest_path: manifestPath,
      manifest: prior,
    });
  }
  atomicJson(manifestPath, manifest);
  return backupPath;
}

export function writeManifestRelocationBackup(manifestPath, oldPath, options = {}) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const backupPath = join(dirname(manifestPath), ".brain-folder-relocation-backup.json");
  atomicJson(backupPath, {
    version: 1,
    created_at: (options.now ?? (() => new Date()))().toISOString(),
    manifest_path: manifestPath,
    previous_manifest_path: oldPath,
    manifest,
  });
  return backupPath;
}

function updateLocator(manifestPath, state, options = {}, extra = {}) {
  const manifestRecord = state.folders.find((folder) => folder.role === "manifest-home");
  if (!manifestRecord) return;
  atomicJson(folderLocatorPath(options), {
    version: FOLDER_STATE_VERSION,
    brain_id: state.brain_id,
    manifest_path: resolve(manifestPath),
    manifest_name: basename(manifestPath),
    folder: manifestRecord,
    ...extra,
  });
}

export function pendingManifestReferenceRepair(manifestPath, options = {}) {
  const locator = safeJson(folderLocatorPath(options));
  if (!locator?.reference_repair_pending ||
      resolve(locator.manifest_path || "") !== resolve(manifestPath)) return null;
  return { ...locator.reference_repair_pending };
}

export function completeManifestReferenceRepair(manifestPath, options = {}) {
  const locator = safeJson(folderLocatorPath(options), { allowMissing: false });
  if (resolve(locator.manifest_path || "") !== resolve(manifestPath)) {
    fail("FOLDER_STATE_INVALID", "the manifest reference repair locator changed before commit");
  }
  const { reference_repair_pending: _pending, ...complete } = locator;
  atomicJson(folderLocatorPath(options), complete);
}

/**
 * Record existing folders and adopt uniquely proven moved source roots.
 * The returned manifest is the exact object written after an adoption.
 */
export function reconcileTrackedFolders(manifestPath, manifest, options = {}) {
  const canonicalManifest = assertSafeAbsolutePath(manifestPath, "the Brain manifest");
  const statePath = folderIdentityStatePath(canonicalManifest);
  const prior = safeJson(statePath);
  const state = prior ? validateState(prior) : {
    version: FOLDER_STATE_VERSION,
    brain_id: randomUUID(),
    folders: [],
  };
  let stateChanged = !prior;
  const extraSources = Array.isArray(options.additionalSources)
    ? options.additionalSources.map((item) => ({
        role: `source:${String(item?.source || "upload")}`,
        path: assertSafeAbsolutePath(item?.path, "the folder source"),
        locators: [],
      }))
    : [];
  const desiredInput = [
    { role: "manifest-home", path: dirname(canonicalManifest), locators: [] },
    ...trackedSources(manifest),
    ...extraSources,
  ];
  const desired = [];
  for (const item of desiredInput) {
    const existing = desired.find((one) => one.role === item.role && resolve(one.path) === resolve(item.path));
    if (existing) existing.locators.push(...(item.locators || []));
    else desired.push({ ...item, locators: [...(item.locators || [])] });
  }
  const changes = [];
  const statuses = [];
  for (const item of desired) {
    let identity = state.folders.find((folder) =>
      folder.role === item.role && resolve(folder.path) === resolve(item.path));
    if (!identity) {
      const sameRole = state.folders.filter((folder) => folder.role === item.role);
      identity = sameRole.length === 1 && !directoryExists(sameRole[0].path)
        ? sameRole[0]
        : null;
    }
    if (!identity) {
      if (!directoryExists(item.path)) fail("FOLDER_MISSING", missingMessage({ ...item, path: resolve(item.path) }));
      identity = newIdentity(item.role, item.path, state.brain_id, options);
      state.folders.push(identity);
      ensureMarker(item.path, identity, state.brain_id, options);
      stateChanged = true;
      statuses.push({ role: item.role, status: "found", path: resolve(item.path) });
      continue;
    }
    if (directoryExists(identity.path)) {
      statuses.push({ role: identity.role, status: "found", path: identity.path });
      continue;
    }
    const resolved = resolveMissingIdentity(identity, options);
    if (resolved.status === "ambiguous") {
      fail("FOLDER_AMBIGUOUS", ambiguousMessage(identity, resolved.matches), {
        role: identity.role, matches: resolved.matches, decision_reached: true,
      });
    }
    if (resolved.status === "missing") {
      fail("FOLDER_MISSING", missingMessage(identity), {
        role: identity.role, old_path: identity.path, decision_reached: true,
      });
    }
    const oldPath = identity.path;
    identity.path = resolved.path;
    Object.assign(identity, nativeIdentity(resolved.path, options));
    ensureMarker(resolved.path, identity, state.brain_id, options);
    stateChanged = true;
    for (const locator of item.locators || []) replaceManifestPath(manifest, locator, resolved.path);
    changes.push({ role: identity.role, oldPath, newPath: resolved.path, via: resolved.via });
    statuses.push({ role: identity.role, status: "moved", path: resolved.path, oldPath });
  }
  if (changes.some((change) => change.role !== "manifest-home")) {
    saveManifestWithBackup(canonicalManifest, manifest, options);
  }
  if (stateChanged) atomicJson(statePath, state);
  if (options.writeLocator === true) {
    updateLocator(canonicalManifest, state, options);
  }
  return { manifest, state, statePath, changes, statuses };
}

/** Resolve only the manifest home before any caller attempts to read the file. */
export function resolveTrackedManifestPath(requestedPath, options = {}) {
  if (!requestedPath) return { path: requestedPath, status: "unselected", changes: [] };
  const requested = assertSafeAbsolutePath(requestedPath, "the Brain manifest");
  if (existsSync(requested)) return { path: requested, status: "found", changes: [] };
  const locator = safeJson(folderLocatorPath(options));
  if (!locator || locator.version !== FOLDER_STATE_VERSION ||
      resolve(locator.manifest_path || "") !== requested || !locator.folder) {
    return { path: requested, status: "untracked", changes: [] };
  }
  const identity = { ...locator.folder, brain_id: locator.brain_id };
  const resolved = options.forcePath
    ? { status: "moved", path: resolve(options.forcePath), via: "owner", matches: [resolve(options.forcePath)] }
    : resolveMissingIdentity(identity, options);
  if (resolved.status === "ambiguous") {
    fail("FOLDER_AMBIGUOUS", ambiguousMessage(identity, resolved.matches), {
      role: identity.role, matches: resolved.matches, decision_reached: true,
    });
  }
  if (resolved.status !== "moved") {
    fail("FOLDER_MISSING", missingMessage(identity), {
      role: identity.role, old_path: identity.path, decision_reached: true,
    });
  }
  const marker = readMarker(resolved.path);
  if (!marker || marker.id !== identity.id || marker.brain !== identity.brain_id || marker.role !== identity.role) {
    fail("FOLDER_RELOCATION_TARGET_MISMATCH", `The folder at ${resolved.path} is not the tracked ${identity.role}. Nothing was changed.`);
  }
  const nextManifest = join(resolved.path, locator.manifest_name || basename(requested));
  if (!existsSync(nextManifest)) {
    fail("FOLDER_RELOCATION_TARGET_MISSING_MANIFEST", `The tracked folder at ${resolved.path} does not contain the Brain manifest. Nothing was changed.`);
  }
  identity.path = resolved.path;
  Object.assign(identity, nativeIdentity(resolved.path, options));
  const statePath = folderIdentityStatePath(nextManifest);
  const state = validateState(safeJson(statePath, { allowMissing: false }));
  const current = state.folders.find((folder) => folder.id === identity.id);
  if (!current) fail("FOLDER_STATE_INVALID", "the moved Brain folder does not carry its matching identity record");
  Object.assign(current, identity);
  atomicJson(statePath, state);
  updateLocator(nextManifest, state, options, {
    reference_repair_pending: {
      old_manifest_path: requested,
      new_manifest_path: nextManifest,
    },
  });
  return {
    path: nextManifest,
    status: "moved",
    changes: [{ role: "manifest-home", oldPath: dirname(requested), newPath: resolved.path, via: resolved.via }],
  };
}

/** Owner choice for an ambiguous or otherwise missing identity. */
export function relocateTrackedFolder({ manifestPath, to, role = null }, options = {}) {
  const target = assertSafeAbsolutePath(to, "the relocation target");
  if (!directoryExists(target)) fail("FOLDER_RELOCATION_TARGET_MISSING", `No folder exists at ${target}. Nothing was changed.`);
  if (!manifestPath || !existsSync(manifestPath)) {
    return resolveTrackedManifestPath(manifestPath, { ...options, forcePath: target });
  }
  const state = validateState(safeJson(folderIdentityStatePath(manifestPath), { allowMissing: false }));
  const missing = state.folders.filter((folder) => !directoryExists(folder.path));
  const candidates = role ? missing.filter((folder) => folder.role === role) : missing;
  if (candidates.length !== 1) {
    fail(
      "FOLDER_RELOCATION_ROLE_REQUIRED",
      `Relocation needs exactly one missing tracked folder, but found ${candidates.length}. Nothing was changed.`,
      { decision_reached: true, candidates: candidates.map((item) => item.role) },
    );
  }
  const identity = candidates[0];
  const marker = readMarker(target);
  if (!marker || marker.id !== identity.id || marker.brain !== state.brain_id || marker.role !== identity.role) {
    fail("FOLDER_RELOCATION_TARGET_MISMATCH", `The folder at ${target} is not the tracked ${identity.role}. Nothing was changed.`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const desired = trackedSources(manifest).find((item) => item.role === identity.role && resolve(item.path) === resolve(identity.path));
  if (!desired) fail("FOLDER_STATE_INVALID", "the missing folder identity no longer matches the manifest");
  const oldPath = identity.path;
  identity.path = target;
  Object.assign(identity, nativeIdentity(target, options));
  for (const locator of desired.locators) replaceManifestPath(manifest, locator, target);
  saveManifestWithBackup(manifestPath, manifest, options);
  atomicJson(folderIdentityStatePath(manifestPath), state);
  updateLocator(manifestPath, state, options);
  return {
    path: manifestPath,
    status: "moved",
    changes: [{ role: identity.role, oldPath, newPath: target, via: "owner" }],
    manifest,
  };
}

function scanFileForOldPath(path, oldPath) {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_WARNING_FILE_BYTES) return false;
    return readFileSync(path, "utf8").includes(oldPath);
  } catch {
    return false;
  }
}

/** Scan only the two owner-controlled scopes named by the relocation contract. */
export function oldPathOwnerFileWarnings({ brainHome, oldPath, home = homedir() } = {}) {
  const matches = [];
  const productOwnedNames = new Set([
    "brain.manifest.json",
    FOLDER_MARKER,
    FOLDER_STATE,
    ".brain-folder-relocation-backup.json",
    "CLAUDE.md",
  ]);
  const visit = (root, depth = 0) => {
    if (!directoryExists(root) || depth > MAX_SEARCH_DEPTH) return;
    let entries;
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(root, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(path, depth + 1);
      else if (entry.isFile() && !productOwnedNames.has(entry.name) &&
          !entry.name.startsWith(".brain-ingest-") && scanFileForOldPath(path, oldPath)) matches.push(path);
    }
  };
  visit(brainHome);
  const scheduled = join(home, ".claude", "scheduled-tasks");
  try {
    for (const task of readdirSync(scheduled, { withFileTypes: true })) {
      if (!task.isDirectory() || task.isSymbolicLink()) continue;
      const skill = join(scheduled, task.name, "SKILL.md");
      if (scanFileForOldPath(skill, oldPath)) matches.push(skill);
    }
  } catch { /* optional owner scope */ }
  return [...new Set(matches)].sort();
}

export function formatFolderMove(change) {
  return `You moved ${change.role} from ${change.oldPath} to ${change.newPath}. I've updated myself.`;
}

export function relativeFolderStateIsPortable(state = {}) {
  return Object.keys(state.done || {}).every((key) => !isAbsolute(key) && !String(key).split(/[\\/]/).includes(".."));
}
