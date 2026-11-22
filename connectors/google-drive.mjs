/**
 * Google Drive as an ingest source.
 *
 * Produces the SAME envelopes the local folder walker produces, so everything
 * downstream (splitting, batching, the credential gate, resume state) is shared
 * rather than reimplemented.
 *
 * THE THREE THINGS THAT MAKE THIS NON-OBVIOUS
 *
 * 1. A Google Doc has no bytes. files.get?alt=media returns 403 for native
 *    types; they must be exported, and the export format decides retrieval
 *    quality. text/plain for Docs, XLSX for Sheets so every worksheet survives
 *    one bounded export, and text/plain for Slides.
 *
 * 2. modifiedTime is a TRAP as a document date. A sync, a permission change or
 *    a bulk move rewrites it. Storing it made 80% of a real corpus look like it
 *    was written this year, which silently disabled staleness reporting. This
 *    uses createdTime, and lets the shared date ladder override from the
 *    filename when one is present. modifiedTime is used ONLY to decide whether
 *    a file changed, which is what it is actually for.
 *
 * 3. The second run must be cheap or nobody re-runs it. The changes feed makes
 *    it proportional to what changed rather than to the corpus, and it is the
 *    only way deletions are ever learned.
 */

import { extract, canExtract, extensionOf } from "../ingest/extract.mjs";
import "../ingest/formats.mjs";
import { textQuality, isLikelyBinary } from "../ingest/quality.mjs";
import { documentDate } from "../ingest/doc-date.mjs";
import { isBinaryFormat } from "../ingest/extract.mjs";
import { withFirstPartySourceProvenance } from "../worker/src/lib/provenance-receipt.js";

export const API = "https://www.googleapis.com/drive/v3";
export const SOURCE_TYPE = "drive";

/** Native Google types, and what to ask for instead of bytes. */
export const EXPORTS = {
  "application/vnd.google-apps.document": { mime: "text/plain", ext: ".txt" },
  "application/vnd.google-apps.spreadsheet": {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ext: ".xlsx",
  },
  "application/vnd.google-apps.presentation": { mime: "text/plain", ext: ".txt" },
};

/** Google's export ceiling. Past this it returns 403 exportSizeLimitExceeded. */
export const EXPORT_LIMIT = 10 * 1024 * 1024;
export const DOWNLOAD_LIMIT = 8 * 1024 * 1024;
const GOOGLE_PAGE_TOKEN_MAX_LENGTH = 8_192;

export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";

const FILE_FIELDS =
  "id, name, mimeType, size, createdTime, modifiedTime, trashed, parents, webViewLink, md5Checksum, driveId, shortcutDetails(targetId,targetMimeType)";
const FIELDS = `nextPageToken, incompleteSearch, files(${FILE_FIELDS})`;

/** Never worth fetching: they carry no text and cost a request each. */
const SKIP_MIME = /^(image|video|audio)\//;

export class DriveError extends Error {
  constructor(message, status, reason, {
    retryable = false, cause, providerReason = null, providerStatus = null,
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "DriveError";
    this.status = status;
    this.reason = reason;
    // `reason` also names local connector conditions such as networkError and
    // repeatedPageToken. Only this separate field came from a parsed Google
    // error response and may be collapsed into durable provider metadata.
    this.providerReason = providerReason;
    this.providerStatus = providerStatus;
    this.retryable = retryable;
  }
}

function googlePageToken(value, lane, { required = false } = {}) {
  if (value == null && !required) return null;
  const token = typeof value === "string" ? value : "";
  if (!token || token !== token.trim() || token.length > GOOGLE_PAGE_TOKEN_MAX_LENGTH) {
    throw new DriveError(`Google Drive returned an invalid ${lane} page token`, 200, "invalidPageToken");
  }
  return token;
}

const retryDelay = (attempt) => Math.min(2 ** attempt * 1000, 32_000) + Math.random() * 1000;

const errorMessage = (error) => {
  const message = String(error?.message || error || "unknown error").trim();
  return message || "unknown error";
};

/**
 * Fetch failures that are about one particular file, rather than the health of
 * the connector. These may be recorded as skips without making a completed
 * changes page retry forever.
 *
 * Keep this list explicit. A broad `403 => skip` would turn a revoked token,
 * disabled API or account-level policy failure into apparent success and let
 * the changes cursor move past every affected file.
 */
const PERMANENT_FILE_REASONS = new Set([
  "appNotAuthorizedToFile",
  "cannotDownloadFile",
  "cannotExportFile",
  "exportSizeLimitExceeded",
  "fileNotDownloadable",
  "insufficientFilePermissions",
]);

export function isPermanentFileFailure(error) {
  if (!(error instanceof DriveError)) return false;
  if (error.status === 404) return true;
  return PERMANENT_FILE_REASONS.has(String(error.reason || ""));
}

// Bound bytes before JSON parsing. Oversized Gmail history switches to its
// checkpointed mailbox walk instead of expanding or replaying an unbounded page.
async function boundedJsonResponse(response, limit) {
  if (!response.body?.getReader) throw new DriveError("bounded response stream unavailable", 200, "responseLimit");
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new DriveError("Google response exceeded the bounded read budget", 200, "responseLimit");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } finally { reader.releaseLock(); }
}

/**
 * One API call with the retry policy Google actually requires.
 *
 * 403 rateLimitExceeded and 429 are RETRYABLE and common on a large walk; 403
 * for any other reason is a permission problem and must fail fast rather than
 * being retried into a long silence.
 */
export async function api(getAccessToken, path, {
  search,
  raw = false,
  attempts = 5,
  requestTimeoutMs = 60_000,
  deadlineAt = Infinity,
  now = Date.now,
  maxResponseBytes = null,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  deferQuota = false,
} = {}) {
  const remaining = () => {
    const ms = deadlineAt - now();
    if (ms <= 0) throw new DriveError("Google read deadline reached; resume the saved window", 0, "requestDeadline");
    return ms;
  };
  const pauseRetry = async ms => { await sleep(Math.min(ms, remaining())); remaining(); };
  let lastErr;
  let forceRefresh = false;
  let authRefreshAttempted = false;
  const totalAttempts = Math.max(1, Number(attempts) || 1);
  for (let i = 0; i < totalAttempts; i++) {
    remaining();
    let token;
    try {
      token = await getAccessToken({ force: forceRefresh, deadlineAt, now });
      if (forceRefresh) {
        authRefreshAttempted = true;
        forceRefresh = false;
      }
    } catch (error) {
      // invalid_grant and its equivalents require a person to reconnect. They
      // are fatal immediately, while a transport/provider outage is retried and
      // remains fatal after the retry budget. Neither is a document skip.
      if (error?.needsReauth) throw error;
      remaining();
      lastErr = new DriveError(
        `access token could not be obtained: ${errorMessage(error)}`,
        0,
        "tokenRefreshError",
        { retryable: true, cause: error },
      );
      if (i + 1 >= totalAttempts) throw lastErr;
      await pauseRetry(retryDelay(i));
      continue;
    }

    const url = new URL(path.startsWith("http") ? path : API + path);
    for (const [k, v] of Object.entries(search || {})) if (v != null) url.searchParams.set(k, String(v));

    let res;
    try {
      const timeout = Math.max(1, Math.min(Number(requestTimeoutMs) || 60_000, remaining()));
      const signal = Number(timeout) > 0 && typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(timeout)
        : undefined;
      res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, ...(signal ? { signal } : {}) });
      if (res.ok) {
        // Reading a response body can fail or hang independently of receiving
        // its headers. Keep it inside the same retry boundary as fetch itself.
        return raw ? new Uint8Array(await res.arrayBuffer())
          : maxResponseBytes !== null ? await boundedJsonResponse(res, maxResponseBytes) : await res.json();
      }
    } catch (error) {
      if (error?.reason === "responseLimit") throw error;
      remaining();
      lastErr = new DriveError(
        `Google API request or response failed: ${errorMessage(error)}`,
        0,
        "networkError",
        { retryable: true, cause: error },
      );
      if (i + 1 >= totalAttempts) throw lastErr;
      await pauseRetry(retryDelay(i));
      continue;
    }

    const body = await (maxResponseBytes !== null ? boundedJsonResponse(res, maxResponseBytes) : res.json()).catch(error => {
      if (error?.reason === "responseLimit") throw error;
      remaining(); return {};
    });
    const reason = body?.error?.errors?.[0]?.reason || body?.error?.status || "";
    if (deferQuota && (res.status === 429 || (res.status === 403 &&
        /^(?:rateLimitExceeded|userRateLimitExceeded|quotaExceeded|rate_limit_exceeded)$/i.test(reason)))) {
      throw Object.assign(new DriveError("Google API requested a quota retry", res.status, "googleQuotaResponse"), {
        retryAfter: res.headers?.get("Retry-After"),
      });
    }
    // One 401 gets a forced access-token refresh. A second 401 is not a file
    // quality problem; it is a broken connection and must abort the sync.
    const retryAuth = res.status === 401 && !authRefreshAttempted;
    const retryable =
      retryAuth ||
      res.status === 429 ||
      res.status >= 500 ||
      (res.status === 403 && /rateLimit|userRateLimit|quotaExceeded|backendError/i.test(reason));

    lastErr = new DriveError(body?.error?.message || `HTTP ${res.status}`, res.status, reason, {
      retryable,
      providerReason: reason || null,
      providerStatus: res.status,
    });
    if (!retryable) throw lastErr;
    if (retryAuth) forceRefresh = true;
    if (i + 1 >= totalAttempts) throw lastErr;
    // Exponential with jitter. Google's own guidance, and without the jitter a
    // large parallel walk re-collides on every retry.
    await pauseRetry(retryDelay(i));
  }
  throw lastErr;
}

/**
 * Broad account search retained for the exact-name live fixture only.
 *
 * This is not an ingestion boundary. The deployed ingest path must use
 * listRootedFiles(), which proves every returned item's ancestry from one of
 * the manifest-owned roots before any content request is made.
 */
export async function* listFiles(getAccessToken, { pageSize = 1000, query, maxPages = 10_000, opts = {} } = {}) {
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new TypeError("Drive maxPages must be a positive integer");
  let pageToken;
  let pages = 0;
  const requestedPageTokens = new Set();
  do {
    if (++pages > maxPages) throw new DriveError(`Google Drive listing exceeded ${maxPages} pages`, 200, "pageLimit");
    if (pageToken) {
      if (requestedPageTokens.has(pageToken)) {
        throw new DriveError("Google Drive repeated a file-list page token", 200, "repeatedPageToken");
      }
      requestedPageTokens.add(pageToken);
    }
    const page = await api(getAccessToken, "/files", {
      search: {
        pageSize,
        pageToken,
        fields: FIELDS,
        // Without all three of these, files on Shared Drives are invisible and
        // the walk silently returns only My Drive.
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        corpora: "allDrives",
        q: query || "trashed = false",
        orderBy: "modifiedTime desc",
      },
      ...opts,
    });
    // With corpora=allDrives Google can answer 200 while explicitly admitting
    // that some corpora were not searched. A full sweep uses absence as proof
    // for deletion, so an incomplete page must abort before yielding even one
    // file. The caller then withholds cleanup and its source cursor.
    if (page.incompleteSearch === true) {
      throw new DriveError(
        "Google Drive reported an incomplete all-drives search; no full-sweep deletion was attempted",
        200,
        "incompleteSearch"
      );
    }
    if (page.files != null && !Array.isArray(page.files)) {
      throw new DriveError("Google Drive returned an invalid file list", 200, "invalidFileList");
    }
    const followingPageToken = googlePageToken(page.nextPageToken, "file-list");
    if (followingPageToken && requestedPageTokens.has(followingPageToken)) {
      throw new DriveError("Google Drive repeated a file-list page token", 200, "repeatedPageToken");
    }
    for (const f of page.files || []) yield f;
    pageToken = followingPageToken;
  } while (pageToken);
}

const driveQueryValue = (value) => String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

export function normalizeRootFolderIds(values, { includeMyDriveRootFiles = false } = {}) {
  if (!Array.isArray(values)) {
    throw new DriveError("corpora.google_drive.root_folder_ids must be an array", 0, "rootPolicyMissing");
  }
  const roots = [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))].sort();
  if (!roots.length && includeMyDriveRootFiles !== true) {
    throw new DriveError(
      "Google Drive requires corpora.google_drive.root_folder_ids to name a reviewed folder or include_my_drive_root_files: true",
      0,
      "rootPolicyMissing",
    );
  }
  return roots;
}

export async function getFileMetadata(getAccessToken, fileId, opts = {}) {
  return api(getAccessToken, `/files/${encodeURIComponent(String(fileId))}`, {
    search: { fields: FILE_FIELDS, supportsAllDrives: true },
    ...opts,
  });
}

/**
 * Traverse reviewed roots recursively, including Shared Drives. The optional
 * My Drive root scope admits only direct files, never its child folders.
 *
 * A shortcut is returned as the shortcut object but never followed. Following
 * it would let a shortcut placed inside an approved folder silently authorize
 * an unrelated target elsewhere in the account. Overlapping roots are safe:
 * Drive ids are deduplicated and their exact authorizing roots are merged.
 */
export async function* listRootedFiles(getAccessToken, {
  rootFolderIds,
  includeMyDriveRootFiles = false,
  pageSize = 1000,
  maxFiles = 250_000,
  maxFolders = 100_000,
  maxPages = 100_000,
  opts = {},
} = {}) {
  const roots = normalizeRootFolderIds(rootFolderIds, { includeMyDriveRootFiles });
  const found = new Map();
  let pages = 0;
  let folders = 0;

  const scopes = roots.map((rootId) => ({ rootId, shallow: false }));
  if (includeMyDriveRootFiles === true) scopes.push({ rootId: "root", shallow: true });
  for (const { rootId, shallow } of scopes) {
    let root;
    try {
      root = await getFileMetadata(getAccessToken, rootId, opts);
    } catch (error) {
      if (error instanceof DriveError && (error.status === 403 || error.status === 404)) {
        throw new DriveError(
          `reviewed Drive root ${rootId} is unavailable; existing indexed content was preserved`,
          error.status,
          "rootUnavailable",
          { cause: error },
        );
      }
      throw error;
    }
    if (!root?.id || root?.trashed === true || root?.mimeType !== FOLDER_MIME) {
      throw new DriveError(
        `reviewed Drive root ${rootId} is not an active folder; existing indexed content was preserved`,
        0,
        "rootUnavailable",
      );
    }

    const queue = [root];
    const visitedFolders = new Set();
    while (queue.length) {
      const folder = queue.shift();
      const folderId = String(folder.id || "");
      if (!folderId || visitedFolders.has(folderId)) continue;
      visitedFolders.add(folderId);
      folders++;
      if (folders > maxFolders) {
        throw new DriveError(`root-scoped Drive walk exceeded ${maxFolders} folders`, 0, "folderLimit");
      }

      const priorRoot = found.get(folderId);
      found.set(folderId, {
        ...(priorRoot || folder),
        scope_root_ids: [...new Set([...(priorRoot?.scope_root_ids || []), ...(shallow ? [] : [rootId])])].sort(),
        // Keep the canonical root id for absence checks without introducing
        // a "My Drive" path segment or authorizing its child folders.
        ...(shallow ? { scope_my_drive_root: true } : {}),
      });

      let pageToken;
      const seenPageTokens = new Set();
      do {
        if (pageToken && seenPageTokens.has(pageToken)) {
          throw new DriveError(
            `Google Drive repeated a page token while reading reviewed root ${rootId}`,
            200,
            "repeatedPageToken",
          );
        }
        if (pageToken) seenPageTokens.add(pageToken);
        pages++;
        if (pages > maxPages) {
          throw new DriveError(`root-scoped Drive walk exceeded ${maxPages} pages`, 0, "pageLimit");
        }
        const page = await api(getAccessToken, "/files", {
          search: {
            pageSize,
            pageToken,
            fields: FIELDS,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
            corpora: "allDrives",
            q: `'${driveQueryValue(shallow ? "root" : folderId)}' in parents and trashed = false`,
            orderBy: "name",
          },
          ...opts,
        });
        if (page.incompleteSearch === true) {
          throw new DriveError(
            `Google Drive reported an incomplete search under reviewed root ${rootId}; existing indexed content was preserved`,
            200,
            "incompleteSearch",
          );
        }
        for (const file of page.files || []) {
          if (!file?.id || file.trashed === true) continue;
          if (shallow && file.mimeType === FOLDER_MIME) continue;
          const id = String(file.id);
          const prior = found.get(id);
          found.set(id, {
            ...(prior || file),
            scope_root_ids: [...new Set([...(prior?.scope_root_ids || []), ...(shallow ? [] : [rootId])])].sort(),
          });
          if (found.size > maxFiles) {
            throw new DriveError(`root-scoped Drive walk exceeded ${maxFiles} files`, 0, "fileLimit");
          }
          if (!shallow && file.mimeType === FOLDER_MIME) queue.push(file);
        }
        pageToken = page.nextPageToken || null;
      } while (pageToken);
    }
  }

  for (const file of found.values()) yield file;
}

/**
 * A deliberately bounded rooted walk for assistant-visible previews.
 *
 * The ordinary full walk must finish before yielding because its result can
 * authorize deletion. This preview can authorize nothing, so it validates
 * every configured root first and then stops provider traversal as soon as the
 * requested aggregate sample is full. Names and ids stay inside the process.
 */
export async function* listRootedFilesPreview(getAccessToken, {
  rootFolderIds,
  includeMyDriveRootFiles = false,
  limit = 25,
  pageSize = 100,
  maxFolders = 10_000,
  maxPages = 10_000,
  opts = {},
} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new DriveError("the assistant Drive preview limit must be between 1 and 100", 0, "previewLimit");
  }
  const roots = normalizeRootFolderIds(rootFolderIds, { includeMyDriveRootFiles });
  const validatedRoots = [];
  const scopes = roots.map((rootId) => ({ rootId, shallow: false }));
  if (includeMyDriveRootFiles === true) scopes.push({ rootId: "root", shallow: true });
  for (const { rootId, shallow } of scopes) {
    let root;
    try { root = await getFileMetadata(getAccessToken, rootId, opts); }
    catch (error) {
      if (error instanceof DriveError && (error.status === 403 || error.status === 404)) {
        throw new DriveError("a reviewed Drive root is unavailable", error.status, "rootUnavailable", { cause: error });
      }
      throw error;
    }
    if (!root?.id || root?.trashed === true || root?.mimeType !== FOLDER_MIME) {
      throw new DriveError("a reviewed Drive root is not an active folder", 0, "rootUnavailable");
    }
    validatedRoots.push({ ...root, scope_root_ids: shallow ? [] : [rootId],
      ...(shallow ? { scope_my_drive_root: true } : {}) });
  }

  const queue = [...validatedRoots];
  const visitedFolders = new Set();
  const emitted = new Set();
  let pages = 0;
  let folders = 0;
  let count = 0;
  // If My Drive itself is also an explicit recursive root, visit it once with
  // that stronger scope, while preserving its root-level path convention.
  const myDriveRootId = validatedRoots.find((root) => root.scope_my_drive_root)?.id;
  while (queue.length && count < limit) {
    const folder = queue.shift();
    const folderId = String(folder?.id || "");
    if (!folderId || visitedFolders.has(folderId)) continue;
    visitedFolders.add(folderId);
    folders++;
    if (folders > maxFolders) {
      throw new DriveError("bounded Drive preview exceeded its folder limit", 0, "folderLimit");
    }
    if (!emitted.has(folderId)) {
      emitted.add(folderId);
      count++;
      yield folderId === myDriveRootId ? { ...folder, scope_my_drive_root: true } : folder;
      if (count >= limit) return;
    }

    let pageToken;
    const seenPageTokens = new Set();
    do {
      if (pageToken && seenPageTokens.has(pageToken)) {
        throw new DriveError("Google Drive repeated a preview page token", 200, "repeatedPageToken");
      }
      if (pageToken) seenPageTokens.add(pageToken);
      pages++;
      if (pages > maxPages) {
        throw new DriveError("bounded Drive preview exceeded its page limit", 0, "pageLimit");
      }
      const page = await api(getAccessToken, "/files", {
        search: {
          pageSize: Math.min(pageSize, Math.max(1, limit - count)),
          pageToken,
          fields: FIELDS,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          corpora: "allDrives",
          q: `'${driveQueryValue(folder.scope_my_drive_root ? "root" : folderId)}' in parents and trashed = false`,
          orderBy: "name",
        },
        ...opts,
      });
      if (page.incompleteSearch === true) {
        throw new DriveError("Google Drive reported an incomplete bounded preview", 200, "incompleteSearch");
      }
      for (const file of page.files || []) {
        if (!file?.id || file.trashed === true) continue;
        if (folder.scope_my_drive_root && file.mimeType === FOLDER_MIME) continue;
        const id = String(file.id);
        if (emitted.has(id)) continue;
        const scoped = { ...file, scope_root_ids: [...(folder.scope_root_ids || [])] };
        emitted.add(id);
        if (file.mimeType === FOLDER_MIME) queue.push(scoped);
        count++;
        yield scoped;
        if (count >= limit) return;
      }
      pageToken = page.nextPageToken || null;
    } while (pageToken && count < limit);
  }
}

export function driveAssistantPreviewSummary({
  limit,
  configuredRootCount,
  includeMyDriveRootFiles = false,
  scanned,
  wouldSend,
  unchanged,
  skipped,
} = {}) {
  const count = (value, label) => {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new DriveError(`the bounded Drive preview returned an invalid ${label} count`, 0, "invalidPreviewReceipt");
    }
    return value;
  };
  const previewLimit = count(limit, "limit");
  const rootCount = count(configuredRootCount, "root");
  if (previewLimit < 1 || previewLimit > 100 || (rootCount < 1 && includeMyDriveRootFiles !== true)) {
    throw new DriveError("the bounded Drive preview receipt has an invalid scope", 0, "invalidPreviewReceipt");
  }
  return Object.freeze({
    schema_version: 1,
    operation: "drive.bounded_preview",
    status: "partial_preview",
    read_only: true,
    scope_complete: false,
    preview_limit: previewLimit,
    configured_root_count: rootCount,
    ...(includeMyDriveRootFiles === true ? { include_my_drive_root_files: true } : {}),
    counts: Object.freeze({
      scanned: count(scanned, "scanned"),
      would_send: count(wouldSend, "would-send"),
      unchanged: count(unchanged, "unchanged"),
      skipped: count(skipped, "skipped"),
    }),
    effects: Object.freeze({
      brain_documents_sent: 0,
      brain_receipts_written: 0,
      checkpoint_written: false,
      source_cursor_advanced: false,
      ocr_calls: 0,
    }),
  });
}

/**
 * Explain why a formerly indexed item is absent from a complete rooted walk.
 *
 * Drive can hide an item's existence with 404 when this credential has no
 * access. A 404, and the equivalent 403 notFound response, therefore proves
 * only that Drive no longer returns the item to this credential. The caller
 * must keep that outcome out of every deletion plan until independent local
 * history corroborates it. Visible trash and a visible move outside the
 * approved folder set remain authoritative removal evidence.
 */
export async function classifyScopedAbsence(getAccessToken, fileId, {
  scopedFolderIds = new Set(),
  opts = {},
} = {}) {
  let file;
  try {
    file = await getFileMetadata(getAccessToken, fileId, opts);
  } catch (error) {
    if (error instanceof DriveError && (
      error.status === 404 ||
      (error.status === 403 && (
        /not[ _-]?found/i.test(String(error.providerReason || error.reason || "")) ||
        /\bfile\s+not\s+found\b/i.test(String(error.message || ""))
      ))
    )) {
      return {
        kind: "unresolved_not_returned",
        reason: "Drive no longer returns this item to this credential",
        retryable: true,
      };
    }
    if (error instanceof DriveError && error.status === 403) {
      return {
        kind: "unresolved_access",
        reason: "Drive denied access to the file metadata",
        retryable: true,
      };
    }
    throw error;
  }
  if (file?.trashed === true) {
    return { kind: "source_deleted", reason: "Drive reports the file is in trash", retryable: false };
  }
  const parents = Array.isArray(file?.parents) ? file.parents.map(String) : [];
  if (parents.some((parent) => scopedFolderIds.has(parent))) {
    return {
      kind: "present_in_scope",
      reason: "Drive still places the file under a reviewed folder but omitted it from the completed traversal",
      retryable: true,
      visible_in_scope: true,
    };
  }
  return { kind: "left_scope", reason: "the visible file moved outside every reviewed root", retryable: false };
}

/** The token that makes the NEXT run incremental. Fetch before the first walk. */
export async function startPageToken(getAccessToken, opts = {}) {
  const r = await api(getAccessToken, "/changes/startPageToken", {
    search: { supportsAllDrives: true },
    ...opts,
  });
  return googlePageToken(r.startPageToken, "start", { required: true });
}

const validDriveChangeId = (id) => typeof id === "string" && id.length <= 250 && /^[\x21-\x7e]+$/.test(id);

/** One bounded changes page. The consumer owns durable page settlement. */
export async function listChangePage(getAccessToken, pageToken, { pageSize = 50, ...opts } = {}) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new TypeError("Drive incremental pageSize must be from 1 through 100");
  }
  const token = googlePageToken(pageToken, "changes", { required: true });
  const page = await api(getAccessToken, "/changes", {
    ...opts,
    search: { pageToken: token, pageSize, supportsAllDrives: true,
      includeItemsFromAllDrives: true, includeRemoved: true,
      fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))` },
  });
  if (!Array.isArray(page.changes) || page.changes.length > pageSize) {
    throw new DriveError("Google Drive returned an invalid bounded changes list", 200, "invalidChangeList");
  }
  const terminal = page.newStartPageToken != null;
  const nextToken = googlePageToken(terminal ? page.newStartPageToken : page.nextPageToken, "next changes", { required: true });
  if ((nextToken === token && (!terminal || page.changes.length > 0)) || (terminal && page.nextPageToken != null)) {
    throw new DriveError("Google Drive returned an ambiguous or repeated changes token", 200, "repeatedPageToken");
  }
  // Keep each slot for durable settlement and discard untrusted metadata.
  const changes = page.changes.map((change) => {
    const id = change?.fileId;
    if (!validDriveChangeId(id)) {
      return { fileId: null, identityFailure: "Drive change has no valid printable file ID of at most 250 characters" };
    }
    if (change.file == null ? change.removed !== true : change.file.id !== id) {
      return { fileId: id, identityFailure: change.file == null
        ? "Drive change is missing file metadata" : "Drive change file ID does not match its file metadata" };
    }
    return change;
  });
  return { changes, nextToken, terminal };
}

/** Resolve current ancestors, never trusting the old full-walk index for scope. */
export async function changeScope(getAccessToken, file, {
  rootFolderIds = [], includeMyDriveRootFiles = false, metadata = new Map(),
  maxDepth = 100, opts = {},
} = {}) {
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 100) throw new TypeError("Drive ancestor depth must be from 1 through 100");
  const unresolved = (code) => ({ unresolved: { code, reason: code === 'ancestor_depth_limit'
    ? `Scope could not be proved within ${maxDepth} ancestor visits; accepted text is retained. Review the source scope before retrying.`
    : 'A required ancestor is unavailable for this file; scope is unproved and accepted text is retained. Restore ancestor access before retrying.' } });
  const malformedAncestor = () => new DriveError("Drive ancestor metadata is incomplete or mismatched", 200, "invalidAncestor");
  const get = async (id) => {
    if (!metadata.has(id)) {
      try { metadata.set(id, await getFileMetadata(getAccessToken, id, opts)); }
      catch (error) {
        // A provider's file-specific denial can settle this event, but auth,
        // account policy, malformed replies and unknown transport cannot.
        if (error instanceof DriveError && !error.retryable &&
            ((error.status === 404 && ['', 'notFound', 'NOT_FOUND'].includes(error.reason || '')) ||
             (error.status === 403 && PERMANENT_FILE_REASONS.has(error.reason)))) return null;
        throw error;
      }
    }
    const value = metadata.get(id);
    if (!value?.id || (id !== "root" && value.id !== id) || value.mimeType !== FOLDER_MIME ||
        (value.parents != null && !Array.isArray(value.parents))) {
      throw malformedAncestor();
    }
    return { ...value, parents: value.parents || [] };
  };
  if (!file.parents?.length) return { inScope: false };
  const canonicalRoot = includeMyDriveRootFiles || rootFolderIds.includes("root") ? await get("root") : null;
  if ((includeMyDriveRootFiles || rootFolderIds.includes('root')) && !canonicalRoot) return unresolved('ancestor_unavailable');
  const roots = new Set(rootFolderIds.map((id) => id === "root" ? canonicalRoot.id : id));
  const path = new Map();
  let visits = 0;
  let unproved;
  let invalidAncestor;
  let invalidMetadata;
  const walk = async (parents) => {
    const validParents = parents.filter(validDriveChangeId);
    // A malformed edge cannot prove absence or veto a proved sibling path.
    if (validParents.length !== parents.length) {
      invalidMetadata ||= malformedAncestor();
      invalidAncestor ||= invalidMetadata;
    }
    // Cached visits also consume the shared budget. A graph can have far more
    // paths than unique folders, and a cycle only invalidates its own path.
    for (const id of [...new Set(validParents)].sort()) {
      if (visits >= maxDepth) {
        unproved = 'ancestor_depth_limit';
        return null;
      }
      visits++;
      if (id === file.id || path.has(id)) {
        invalidAncestor ||= new DriveError("Drive ancestor chain is cyclic", 200, "ancestorLimit");
        continue;
      }
      let parent;
      try { parent = await get(id); }
      catch (error) {
        if (!(error instanceof DriveError) || error.reason !== "invalidAncestor") throw error;
        invalidMetadata ||= error;
        invalidAncestor ||= error;
        continue;
      }
      if (!parent) { unproved ||= 'ancestor_unavailable'; continue; }
      if (parent.trashed) continue;
      path.set(id, parent);
      // Prove the full branch before trimming to the highest configured root,
      // so exclusions still see the full path between overlapping roots.
      const scope = parent.parents.length ? await walk(parent.parents) : scopeForPath();
      path.delete(id);
      if (scope) return scope;
    }
    return null;
  };
  const scopeForPath = () => {
    const ids = [...path.keys()];
    const parentId = ids[0];
    const rootIds = ids.filter(id => roots.has(id));
    const directRootFile = includeMyDriveRootFiles && parentId === canonicalRoot.id && file.mimeType !== FOLDER_MIME;
    if (!rootIds.length && !directRootFile) return null;
    const highestRoot = rootIds.at(-1) ?? parentId;
    const selected = ids.slice(0, ids.indexOf(highestRoot) + 1);
    const folders = Object.fromEntries(selected.map((id, index) => {
      const parent = path.get(id);
      return [id, { name: parent.id === canonicalRoot?.id ? "" : parent.name || "",
        parents: index + 1 < selected.length ? [selected[index + 1]] : [] }];
    }));
    return { inScope: true, folders, rootIds: rootIds.sort(), parentId };
  };
  const scope = await walk(file.parents);
  if (scope) return scope;
  if (unproved === 'ancestor_depth_limit') {
    // A bounded walk cannot turn an observed metadata gap into a manual hold.
    if (invalidMetadata) throw invalidMetadata;
    return unresolved(unproved);
  }
  if (invalidAncestor) throw invalidAncestor;
  return unproved ? unresolved(unproved) : { inScope: false };
}

/**
 * Everything that changed since a saved token.
 *
 * Returns { changed, removed, nextToken }. `removed` covers deletion, trashing,
 * and a file that merely left this credential's view. The caller must classify
 * a stored removed id with classifyScopedAbsence() before treating it as source
 * deletion. A removed change-feed event can annotate a not-returned review
 * record, but it cannot corroborate deletion or shorten the seven-day window.
 */
export async function listChanges(getAccessToken, pageToken, opts = {}) {
  const changed = [];
  const removed = [];
  let token = googlePageToken(pageToken, "changes", { required: true });
  let nextToken = null;
  let pages = 0;
  const maxPages = opts.maxPages ?? 10_000;
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new TypeError("Drive maxPages must be a positive integer");
  const apiOpts = { ...opts };
  delete apiOpts.maxPages;
  const requestedPageTokens = new Set();

  while (token) {
    token = googlePageToken(token, "changes", { required: true });
    if (requestedPageTokens.has(token)) {
      throw new DriveError("Google Drive repeated a changes page token", 200, "repeatedPageToken");
    }
    requestedPageTokens.add(token);
    if (++pages > maxPages) throw new DriveError(`Google Drive changes exceeded ${maxPages} pages`, 200, "pageLimit");
    const page = await api(getAccessToken, "/changes", {
      search: {
        pageToken: token,
        pageSize: 1000,
        fields: `nextPageToken, newStartPageToken, changes(fileId, removed, file(${FIELDS.replace(/^nextPageToken, files\(|\)$/g, "")}))`,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        includeRemoved: true,
      },
      ...apiOpts,
    });
    if (page.changes != null && !Array.isArray(page.changes)) {
      throw new DriveError("Google Drive returned an invalid changes list", 200, "invalidChangeList");
    }
    for (const c of page.changes || []) {
      if (c.removed || c.file?.trashed) removed.push(c.fileId);
      else if (c.file) changed.push(c.file);
    }
    if (page.newStartPageToken != null) {
      nextToken = googlePageToken(page.newStartPageToken, "terminal changes", { required: true });
      break;
    }
    if (page.nextPageToken == null) {
      throw new DriveError(
        "Google Drive ended a changes window without a terminal start page token",
        200,
        "incompleteChangeFeed",
      );
    }
    token = googlePageToken(page.nextPageToken, "changes", { required: true });
  }
  if (!nextToken) {
    throw new DriveError("Google Drive returned no terminal changes token", 200, "incompleteChangeFeed");
  }
  return { changed, removed, nextToken };
}

/** Should this file be fetched at all? Decided before spending a request. */
export function triage(file) {
  if (file.trashed) return { skip: "the file is in the trash", skipCode: "source_deleted" };
  if (file.mimeType === FOLDER_MIME) return { skip: null, folder: true };
  if (file.mimeType === SHORTCUT_MIME) {
    return {
      skip: "Drive shortcuts are not followed across the reviewed folder boundary",
      skipCode: "shortcut_not_followed",
    };
  }
  if (file.mimeType?.startsWith("application/vnd.google-apps.")) {
    const e = EXPORTS[file.mimeType];
    if (!e) {
      return {
        skip: `Google ${file.mimeType.split(".").pop()} files cannot be exported as text`,
        skipCode: "unsupported_google_type",
      };
    }
    return { export: e };
  }
  if (SKIP_MIME.test(file.mimeType || "")) {
    return { skip: `${file.mimeType} carries no text`, skipCode: "non_text_media" };
  }
  if (!canExtract(file.name)) {
    return {
      skip: `no extractor for "${extensionOf(file.name) || "(no extension)"}" files`,
      skipCode: "unsupported_extension",
    };
  }
  if (Number(file.size) > DOWNLOAD_LIMIT) {
    return {
      skip: `${(Number(file.size) / 1048576).toFixed(1)}MB, over the ${DOWNLOAD_LIMIT / 1048576}MB limit`,
      skipCode: "download_limit",
    };
  }
  return { download: true };
}

/**
 * Keep the small amount of folder state needed to turn opaque parent ids into
 * stable, human-readable paths. A full walk supplies every visible folder;
 * incremental runs merge changed folders into the saved snapshot.
 */
export function updateFolderIndex(files, prior = {}) {
  const out = { ...(prior || {}) };
  for (const file of files || []) {
    if (file?.mimeType !== FOLDER_MIME || !file.id) continue;
    if (file.trashed) delete out[file.id];
    else out[file.id] = {
      name: file.scope_my_drive_root === true ? "" : String(file.name || "").trim(),
      parents: Array.isArray(file.parents) ? file.parents.filter(Boolean).map(String) : [],
    };
  }
  return out;
}

/** Folder path only, not the filename. Unknown roots are intentionally absent. */
export function folderPathFor(file, folders = {}) {
  const parts = [];
  const seen = new Set();
  let id = Array.isArray(file?.parents) ? file.parents[0] : null;
  while (id && !seen.has(id)) {
    seen.add(id);
    const folder = folders[id];
    if (!folder) break;
    if (folder.name) parts.unshift(folder.name);
    id = Array.isArray(folder.parents) ? folder.parents[0] : null;
  }
  return parts.join("/");
}

const pathSegments = (value) => String(value || "").replace(/\\/g, "/").split("/").map((x) => x.trim()).filter(Boolean);
const normalPath = (value) => pathSegments(value).join("/").toLowerCase();

/**
 * Everything that can change the stored document without changing its bytes.
 *
 * A Drive changes feed reports a moved parent folder, but it does not emit a
 * change for every descendant. The periodic full sweep therefore has to notice
 * that a child's resolved path changed even when its own modifiedTime and md5
 * did not. Including the path also refreshes top_folder/private-path metadata
 * after an ancestor rename or move.
 */
export function driveVersion(file, folderPath = "") {
  return JSON.stringify([
    String(file?.modifiedTime || ""),
    String(file?.md5Checksum || file?.size || ""),
    String(file?.name || ""),
    String(file?.mimeType || ""),
    pathSegments(folderPath).join("/"),
    // Two legacy parents can have the same path label but different custody.
    ...(file?.scope_parent_id ? [file.scope_parent_id] : []),
  ]);
}

/**
 * Decide source-policy exclusions before downloading file bytes.
 *
 * Exact ids carry reviewed migration/dedupe decisions. Path rules are matched
 * on segment boundaries so excluding `Legal/Sealed` cannot also exclude a
 * sibling named `Legal/Sealed Notes`. Private prefixes match whole segments,
 * the same contract used by local-folder ingest.
 */
export function exclusionReason(file, folderPath = "", {
  excludeFileIds = [], excludePaths = [], excludeNameParts = [], privatePrefixes = [],
} = {}) {
  const ids = excludeFileIds instanceof Set ? excludeFileIds : new Set((excludeFileIds || []).map(String));
  if (ids.has(String(file?.id || ""))) return "excluded by reviewed file-id policy";

  const fullPath = [...pathSegments(folderPath), String(file?.name || "").trim()].filter(Boolean).join("/");
  const normalized = normalPath(fullPath);
  for (const configured of excludePaths || []) {
    const prefix = normalPath(configured);
    if (prefix && (normalized === prefix || normalized.startsWith(`${prefix}/`))) {
      return `excluded path: ${configured}`;
    }
  }

  const lowerName = String(file?.name || "").toLowerCase();
  for (const part of excludeNameParts || []) {
    if (String(part || "").trim() && lowerName.includes(String(part).toLowerCase())) {
      return `excluded name part: ${part}`;
    }
  }

  const privateSet = [...new Set((privatePrefixes || []).map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
  const privatePart = pathSegments(fullPath).find((part) =>
    privateSet.some((prefix) => part.toLowerCase().startsWith(prefix))
  );
  if (privatePart) return `private path segment: ${privatePart}`;
  return null;
}

/** Fetch one file's bytes, exporting when it is a native Google type. */
export async function fetchContent(getAccessToken, file, plan, opts = {}) {
  if (plan.export) {
    if (Number(file.size) > EXPORT_LIMIT) {
      throw new DriveError(`Google's export limit is ${EXPORT_LIMIT / 1048576}MB and this file is larger`, 403, "exportSizeLimitExceeded");
    }
    return api(getAccessToken, `/files/${file.id}/export`, {
      search: { mimeType: plan.export.mime, supportsAllDrives: true },
      raw: true,
      ...opts,
    });
  }
  return api(getAccessToken, `/files/${file.id}`, {
    search: { alt: "media", supportsAllDrives: true },
    raw: true,
    ...opts,
  });
}

/**
 * One Drive file to one ingest envelope, or a reasoned skip.
 *
 * Deliberately mirrors ingest/run.mjs prepare() so a Drive document and a local
 * one are judged by exactly the same rules.
 */
export async function toEnvelope(getAccessToken, file, { sourceName = SOURCE_TYPE, pathOf = () => "", ocr = null } = {}, opts = {}) {
  const plan = triage(file);
  if (plan.folder) return null;
  if (plan.skip) {
    return { skip: { path: file.name, id: file.id, reason: plan.skip, code: plan.skipCode || "unknown" } };
  }

  let buf;
  try {
    buf = await fetchContent(getAccessToken, file, plan, opts);
  } catch (e) {
    // Only a file-specific permanent condition is safe to forget. Network,
    // server and auth failures must escape to the sync runner so it can record
    // a failure and withhold the source cursor for a retry.
    if (!isPermanentFileFailure(e)) throw e;
    return {
      skip: {
        path: file.name,
        id: file.id,
        reason: `could not be fetched: ${e.message.slice(0, 120)}`,
        code: "file_unavailable",
      },
    };
  }

  const name = plan.export ? file.name + plan.export.ext : file.name;
  if (!isBinaryFormat(name) && isLikelyBinary(buf)) {
    return {
      skip: { path: file.name, id: file.id, reason: "the file is binary, not text", code: "binary_content" },
    };
  }

  // Extractor options were never passed on this path, so a Drive PDF has been
  // judged by different rules than a local one despite the comment above
  // promising otherwise. OCR is threaded through explicitly here, because
  // Drive is where a client's scanned filing cabinet actually lives.
  const got = await extract(buf, name, ocr ? {
    ocr,
    ocrDocument: { source: sourceName, sourceItemId: String(file.id) },
  } : {});
  if (got.error || got.text == null) {
    return {
      skip: {
        path: file.name,
        id: file.id,
        reason: got.error || "extraction produced nothing",
        code: got.code || "extraction_refused",
        ...(got.retryable === true ? { retryable: true } : {}),
      },
    };
  }
  const q = textQuality(got.text);
  if (!q.ok) {
    return {
      skip: { path: file.name, id: file.id, reason: q.reason, metrics: q.metrics, code: "quality_refused" },
    };
  }

  // createdTime, never modifiedTime. The filename still wins when it carries a
  // date, because a human naming a file "2026-03 statement" is stating the
  // document's date more reliably than Drive's metadata ever does.
  const folder = pathOf(file);
  const dd = documentDate({ filename: file.name, relPath: folder, contentHead: got.text.slice(0, 1200) });
  const created = file.createdTime ? Date.parse(file.createdTime) : NaN;
  const occurred = dd.value ?? (Number.isFinite(created) ? created : null);

  return {
    ...(Array.isArray(got.ocr_page_request_ids)
      ? { ocrPageRequestIds: [...got.ocr_page_request_ids] }
      : {}),
    // The bare Drive file id, not the name and not `drive:<id>`. The store owns
    // namespacing and constructs `<source_type>:<source_id>` exactly once. This
    // is also the identity used by the Supabase migration, so the first live
    // sync updates that document instead of creating `drive:drive:<id>`.
    envelope: withFirstPartySourceProvenance({
      source_type: sourceName,
      source_id: String(file.id),
      title: file.name,
      content: got.text,
      occurred_at: occurred ? new Date(occurred).toISOString() : null,
      date_source: dd.value ? dd.source : Number.isFinite(created) ? "drive_created" : "none",
      date_reliable: dd.value ? dd.reliable : false,
      uri: file.webViewLink || null,
      ...(got.provenance
        ? { text_source: got.provenance.text_source, text_reliable: got.provenance.text_reliable }
        : {}),
      metadata: {
        extracted_as: got.how,
        drive_id: file.id,
        root_folder_ids: Array.isArray(file.scope_root_ids) ? [...file.scope_root_ids].sort() : [],
        ...(file.scope_parent_id ? { parent_folder_id: file.scope_parent_id } : {}),
        drive_id_kind: file.mimeType === SHORTCUT_MIME ? "shortcut" : "file",
        mime: file.mimeType,
        platform: "drive",
        // Null is deliberate for a root-level file: it clears a stale folder
        // filter when a file is moved out of a subfolder.
        top_folder: pathSegments(folder)[0] || null,
        folder: folder || null,
        ...(got.note ? { extraction_note: got.note } : {}),
        ...(got.incomplete === true ? { extraction_incomplete: true } : {}),
        ...(got.provenance ? { ocr: got.provenance } : {}),
      },
    }, {
      textSource: got.provenance?.text_source || "native",
      textReliable: got.provenance?.text_reliable ?? got.incomplete !== true,
    }),
    // Drive's own change signal. Cheaper than hashing content we already have,
    // and it is what the changes feed reports against.
    version: driveVersion(file, folder),
    note: got.note || null,
    incomplete: got.incomplete === true,
  };
}
