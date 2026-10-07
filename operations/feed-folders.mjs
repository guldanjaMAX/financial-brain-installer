import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  resolve,
  win32 as win32Path,
} from "node:path";

import { retiredFolderLocationVariant } from "./folder-retirement.mjs";

export const MAX_FEED_FOLDERS = 6;
export const DEFAULT_FEED_FOLDERS = Object.freeze([
  Object.freeze({ name: "Client files", source: "client_files" }),
  Object.freeze({ name: "Transcripts", source: "transcripts" }),
]);

const nativeRealpath = realpathSync.native || realpathSync;

function feedFs(overrides = {}) {
  return {
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    realpathNative: nativeRealpath,
    rmdirSync,
    statSync,
    ...overrides,
  };
}

function platformPath(platform) {
  return platform === "win32"
    ? win32Path
    : { dirname, isAbsolute, join, resolve };
}

function normalizedPath(value, platform, pathApi = platformPath(platform)) {
  let output = String(value || "").replace(/\\/gu, "/");
  while (output.length > 1 && output.endsWith("/")) output = output.slice(0, -1);
  if (platform === "darwin" || platform === "win32") output = output.toLowerCase();
  // Resolve only after checking absoluteness. win32.resolve otherwise borrows
  // the host process drive, which is not the path the owner approved.
  return output || String(pathApi.resolve(value));
}

function sameOrInside(child, parent) {
  return Boolean(child && parent && (child === parent || child.startsWith(`${parent}/`)));
}

function overlaps(left, right) {
  return sameOrInside(left, right) || sameOrInside(right, left);
}

function uploadFolderEntries(manifest) {
  const folders = manifest?.corpora?.upload?.folders;
  if (folders === undefined) return [];
  if (!Array.isArray(folders)) throw new Error("corpora.upload.folders must be an array");
  return folders.map((entry) => {
    if (typeof entry === "string") return { path: entry, source: null, feed: false };
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("each corpora.upload.folders entry must be a path or an object");
    }
    return { path: entry.path, source: entry.source || null, feed: entry.feed === true };
  });
}

function safeCanonicalPath(path, io, platform, pathApi) {
  try {
    return normalizedPath(io.realpathNative(path), platform, pathApi);
  } catch {
    return normalizedPath(path, platform, pathApi);
  }
}

function cloudManagedReason(path, platform) {
  const normalized = String(path || "").replace(/\\/gu, "/").toLowerCase();
  if (platform === "darwin") {
    const roots = [
      "/library/mobile documents",
      "/library/cloudstorage",
      "/library/application support/clouddocs",
      "/library/fileprovider",
      "/library/containers/com.apple.clouddocs",
    ];
    if (roots.some((root) => normalized.includes(`${root}/`) || normalized.endsWith(root)) ||
        /\/(?:icloud drive)(?:\/|$)/u.test(normalized)) {
      return "iCloud, CloudDocs, Mobile Documents, and File Provider roots cannot be Brain feeds";
    }
  }
  if (platform === "win32" &&
      /\/(?:onedrive(?: - [^/]+)?|icloud ?drive|cloudstorage)(?:\/|$)/u.test(normalized)) {
    return "cloud-synced File Provider roots cannot be Brain feeds";
  }
  return null;
}

function retiredUploadRoots(manifest) {
  const upload = manifest?.corpora?.upload;
  if (!upload || typeof upload !== "object" || Array.isArray(upload) ||
      typeof upload.retired_at !== "string" || !upload.retired_at.trim()) return [];
  try {
    return uploadFolderEntries(manifest).map((entry) => entry.path).filter(Boolean);
  } catch {
    return [];
  }
}

function feedDecision(callback, path, source, outcome, reason = null) {
  callback?.(Object.freeze({ path: String(path), source: String(source), outcome, reason }));
}

/**
 * Validate one owner-selected landing folder without reading any file below it.
 * The returned path is the canonical directory identity persisted in the
 * manifest. Every refusal happens before a manifest or directory write.
 */
export function prepareFeedAddition(manifest, requestedPath, source, options = {}) {
  const platform = options.platform || process.platform;
  const pathApi = options.pathApi || platformPath(platform);
  const io = feedFs(options.fs);
  const notify = options.onDecision;
  const rawPath = typeof requestedPath === "string" ? requestedPath.trim() : "";
  const sourceName = typeof source === "string" ? source.trim() : "";
  const refuse = (message) => {
    feedDecision(notify, rawPath, sourceName, "refused", message);
    throw new Error(`${message}. Nothing changed.`);
  };

  if (!rawPath || !pathApi.isAbsolute(rawPath)) {
    return refuse("a feed path must be absolute");
  }
  const cloudReason = cloudManagedReason(rawPath, platform);
  if (cloudReason) return refuse(cloudReason);

  let folders;
  try {
    folders = uploadFolderEntries(manifest);
  } catch (error) {
    return refuse(String(error?.message || error));
  }
  const lexical = normalizedPath(rawPath, platform, pathApi);
  const local = manifest?.corpora?.local_folder;
  if (local && typeof local === "object" && !Array.isArray(local) &&
      typeof local.retired_at === "string" && local.retired_at.trim()) {
    for (const retiredPath of [local.retired_path, local.retired_identity?.realpath, local.path]) {
      if (retiredPath && overlaps(lexical, normalizedPath(retiredPath, platform, pathApi))) {
        return refuse("the selected path overlaps a retired watched folder");
      }
    }
  }
  for (const retiredPath of retiredUploadRoots(manifest)) {
    if (overlaps(lexical, normalizedPath(retiredPath, platform, pathApi))) {
      return refuse("the selected path overlaps a retired feed root");
    }
  }

  // Declared paths remain safety boundaries even when temporarily absent. A
  // missing drive must not make its parent eligible as a different feed.
  for (const existing of folders) {
    if (!existing.path) continue;
    const declared = safeCanonicalPath(existing.path, io, platform, pathApi);
    if (lexical === normalizedPath(existing.path, platform, pathApi) &&
        existing.source === sourceName && existing.feed) {
      // Still inspect the live root below. An idempotent rerun must not bless a
      // directory that was replaced by a link since the first declaration.
      continue;
    }
    if (overlaps(lexical, declared)) {
      return refuse("the selected path is a parent or child of another declared feed");
    }
  }

  const exists = io.existsSync(rawPath);
  if (!exists && !options.allowMissing) return refuse("the selected feed folder does not exist");
  let canonical = rawPath;
  if (exists) {
    let named;
    try {
      named = io.lstatSync(rawPath);
    } catch {
      return refuse("the selected feed folder could not be inspected safely");
    }
    if (named.isSymbolicLink?.()) {
      return refuse("a symbolic link or reparse point cannot be a Brain feed");
    }
    if (!named.isDirectory?.()) return refuse("the selected feed path is not a folder");
    try {
      canonical = io.realpathNative(rawPath);
    } catch {
      return refuse("the selected feed folder could not be resolved safely");
    }
    const resolvedCloudReason = cloudManagedReason(canonical, platform);
    if (resolvedCloudReason) return refuse(resolvedCloudReason);
    if (local && typeof local === "object" && !Array.isArray(local) &&
        typeof local.retired_at === "string" && local.retired_at.trim()) {
      const variant = retiredFolderLocationVariant(local, canonical, {
        platform,
        path: pathApi,
        fs: io,
      });
      if (variant) return refuse("the selected path overlaps a retired watched folder");
    }
  }

  const canonicalNormalized = normalizedPath(canonical, platform, pathApi);
  const exact = folders.find((entry) => entry.path &&
    safeCanonicalPath(entry.path, io, platform, pathApi) === canonicalNormalized);
  if (exact) {
    if (exact.source === sourceName && exact.feed) {
      feedDecision(notify, canonical, sourceName, "accepted", "already-declared");
      return Object.freeze({ changed: false, path: canonical, source: sourceName, manifest });
    }
    return refuse("the selected path is already declared with different feed settings");
  }
  if (folders.some((existing) => existing.source && existing.source === sourceName)) {
    return refuse(`source ${sourceName} is already assigned to another folder`);
  }
  for (const existing of folders) {
    if (!existing.path) continue;
    if (overlaps(canonicalNormalized, safeCanonicalPath(existing.path, io, platform, pathApi))) {
      return refuse("the selected path is a parent or child of another declared feed");
    }
  }
  if (folders.filter((folder) => folder.feed).length >= MAX_FEED_FOLDERS) {
    return refuse(`this Brain already has the maximum of ${MAX_FEED_FOLDERS} feeds`);
  }

  const intended = JSON.parse(JSON.stringify(manifest));
  if (!intended.corpora || typeof intended.corpora !== "object" || Array.isArray(intended.corpora)) {
    intended.corpora = {};
  }
  const previousUpload = intended.corpora.upload;
  if (!previousUpload || typeof previousUpload !== "object" || Array.isArray(previousUpload)) {
    intended.corpora.upload = {};
  }
  intended.corpora.upload.enabled = true;
  intended.corpora.upload.folders = [
    ...(Array.isArray(intended.corpora.upload.folders) ? intended.corpora.upload.folders : []),
    { path: canonical, source: sourceName, feed: true },
  ];
  feedDecision(notify, canonical, sourceName, "accepted", "add");
  return Object.freeze({ changed: true, path: canonical, source: sourceName, manifest: intended });
}

/** Create only the missing empty directories for the explicit default-feeds action. */
export function createDefaultFeedDirectories(options = {}) {
  const platform = options.platform || process.platform;
  const pathApi = options.pathApi || platformPath(platform);
  const io = feedFs(options.fs);
  const home = options.home || homedir();
  const parent = pathApi.join(home, "Brain Feeds");
  const targets = DEFAULT_FEED_FOLDERS.map((feed) => ({
    ...feed,
    path: pathApi.join(parent, feed.name),
  }));
  const allowNonEmpty = new Set([...(options.allowNonEmpty || [])].map(String));
  const nonEmptyIsAllowed = (path) => {
    if (allowNonEmpty.has(String(path))) return true;
    try { return allowNonEmpty.has(String(io.realpathNative(path))); } catch { return false; }
  };
  const created = [];
  const rollback = () => {
    for (const path of [...created].reverse()) {
      try { io.rmdirSync(path); } catch { /* preserve the primary failure */ }
    }
  };
  try {
    if (io.existsSync(parent)) {
      const parentState = io.lstatSync(parent);
      if (parentState.isSymbolicLink?.() || !parentState.isDirectory?.()) {
        throw new Error("the Brain Feeds parent is not one safe local folder");
      }
      const allowedNames = new Set(DEFAULT_FEED_FOLDERS.map((feed) => feed.name));
      const unexpected = io.readdirSync(parent).filter((name) => !allowedNames.has(String(name)));
      if (unexpected.length) {
        throw new Error("the existing Brain Feeds parent contains other material; nothing was changed");
      }
    }
    for (const path of [parent, ...targets.map((target) => target.path)]) {
      if (io.existsSync(path)) {
        const state = io.lstatSync(path);
        if (state.isSymbolicLink?.()) {
          throw new Error("a symbolic link or reparse point cannot be used for Brain Feeds");
        }
        if (!state.isDirectory?.()) throw new Error("a Brain Feeds path exists but is not a folder");
        if (path !== parent && !nonEmptyIsAllowed(path) && io.readdirSync(path).length) {
          throw new Error("an existing landing folder is not empty; nothing was changed");
        }
        continue;
      }
      io.mkdirSync(path);
      created.push(path);
    }
    return Object.freeze({ parent, targets: Object.freeze(targets), created: Object.freeze(created), rollback });
  } catch (error) {
    rollback();
    throw error;
  }
}

/** Counts only regular files and never returns a name from inside the feed. */
export function inspectFeedFolder(entry, options = {}) {
  const platform = options.platform || process.platform;
  const pathApi = options.pathApi || platformPath(platform);
  const io = feedFs(options.fs);
  const path = String(entry?.path || "");
  const source = String(entry?.source || "");
  if (!path || !io.existsSync(path)) {
    return Object.freeze({ path, source, exists: false, fileCount: 0, newestFileTime: null, readable: false });
  }
  let root;
  try {
    root = io.lstatSync(path);
  } catch {
    return Object.freeze({ path, source, exists: true, fileCount: null, newestFileTime: null, readable: false });
  }
  if (root.isSymbolicLink?.() || !root.isDirectory?.()) {
    return Object.freeze({ path, source, exists: true, fileCount: null, newestFileTime: null, readable: false });
  }
  let fileCount = 0;
  let newestMs = null;
  let readable = true;
  const visit = (directory) => {
    let entries;
    try {
      entries = io.readdirSync(directory, { withFileTypes: true });
    } catch {
      readable = false;
      return;
    }
    for (const child of entries) {
      const full = pathApi.join(directory, child.name);
      if (child.isSymbolicLink?.()) continue;
      if (child.isDirectory?.()) {
        visit(full);
      } else if (child.isFile?.()) {
        fileCount += 1;
        try {
          const state = io.statSync(full);
          const time = Number(state.mtimeMs ?? state.mtime?.getTime?.());
          if (Number.isFinite(time) && (newestMs === null || time > newestMs)) newestMs = time;
        } catch {
          readable = false;
        }
      }
    }
  };
  visit(path);
  return Object.freeze({
    path,
    source,
    exists: true,
    fileCount,
    newestFileTime: newestMs === null ? null : new Date(newestMs).toISOString(),
    readable,
  });
}

export function declaredFeeds(manifest) {
  return uploadFolderEntries(manifest).filter((entry) => entry.feed === true);
}
