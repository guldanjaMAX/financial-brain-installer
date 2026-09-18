/** Offline Drive fixture for rooted-change and absence-classification safety. */

import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";

const userRoot = String(process.env.BRAIN_DRIVE_SCOPE_USER_ROOT || "");
const evidencePath = String(process.env.BRAIN_DRIVE_SCOPE_EVIDENCE || "");
const mode = String(process.env.BRAIN_DRIVE_SCOPE_MODE || "");
const inventoryLabelMode = String(process.env.BRAIN_DRIVE_SCOPE_LABELS || "available");
const inventoryLabelsAvailable = inventoryLabelMode !== "none";
const inventoryDateAvailable = process.env.BRAIN_DRIVE_SCOPE_DATE !== "none";
const testedStoredUid = String(process.env.BRAIN_DRIVE_SCOPE_STORED_UID || "drive:");
const MODES = new Set([
  "changed-outside",
  "full-malformed",
  "full-identity",
  "full-unresolved",
  "full-unresolved-subthreshold",
  "incremental-unresolved",
  "incremental-identity",
  "incremental-unresolved-batch",
  "incremental-gone",
  "incremental-restored",
  "incremental-trash",
  "incremental-left-scope",
  "incremental-stale-marker-404",
  "incremental-stale-marker-live",
  "incremental-review-empty",
  "incremental-transient-batch",
]);
if (!userRoot) throw new Error("BRAIN_DRIVE_SCOPE_USER_ROOT is required");
if (!evidencePath) throw new Error("BRAIN_DRIVE_SCOPE_EVIDENCE is required");
if (!MODES.has(mode)) throw new Error("BRAIN_DRIVE_SCOPE_MODE is invalid");

os.homedir = () => userRoot;
syncBuiltinESMExports();

const ROOT_ID = "root-fixture";
const MISSING_ID = "missing-sensitive";
const MISSING_UID = `drive:${MISSING_ID}`;
const BATCH_MISSING_IDS = Array.from({ length: 10 }, (_, index) =>
  `missing-batch-${String(index).padStart(2, "0")}`
);
const BATCH_MISSING_UIDS = BATCH_MISSING_IDS.map((id) => `drive:${id}`);
const BATCH_RETAINED_UIDS = Array.from({ length: 100 }, (_, index) =>
  `drive:batch-retained-${String(index).padStart(3, "0")}`
);
const RETAINED_UIDS = Array.from({ length: 10 }, (_, index) =>
  `drive:retained-${String(index).padStart(2, "0")}`
);

const blankEvidence = () => ({
  changesReads: 0,
  rootedWalks: 0,
  absenceMetadataReads: 0,
  outsideContentReads: 0,
  inventoryReads: 0,
  ingestBatchWrites: 0,
  forgetRequests: 0,
  removedFamilies: 0,
  receipts: { indexing: 0, error: 0, ready: 0 },
  lastErrorReceipt: null,
});

function readEvidence() {
  try {
    const parsed = JSON.parse(readFileSync(evidencePath, "utf8"));
    return {
      ...blankEvidence(),
      ...parsed,
      receipts: { ...blankEvidence().receipts, ...(parsed.receipts || {}) },
    };
  } catch (error) {
    if (error?.code === "ENOENT") return blankEvidence();
    throw error;
  }
}

function saveEvidence(evidence) {
  writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
}

function json(body, status = 200, includeDate = true) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...(includeDate ? { date: new Date().toUTCString() } : {}),
    },
  });
}

function requestUrl(input) {
  return new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
}

function requestBody(options) {
  return JSON.parse(String(options.body || "{}"));
}

function storedFamilies(evidence) {
  if (mode === "changed-outside") return [];
  if (mode === "full-malformed") return ["drive:", ...RETAINED_UIDS].sort();
  if (["full-identity", "incremental-identity"].includes(mode)) return [testedStoredUid];
  if (mode === "incremental-unresolved-batch") {
    const removed = evidence.removedFamilies ? new Set(BATCH_MISSING_UIDS.slice(3)) : new Set();
    return [...BATCH_MISSING_UIDS, ...BATCH_RETAINED_UIDS]
      .filter((uid) => !removed.has(uid))
      .sort();
  }
  if (mode === "incremental-transient-batch") return BATCH_MISSING_UIDS;
  if (["full-unresolved-subthreshold", "incremental-stale-marker-404", "incremental-stale-marker-live", "incremental-review-empty"].includes(mode)) {
    return (mode === "incremental-review-empty" && evidence.removedFamilies
      ? RETAINED_UIDS
      : [MISSING_UID, ...RETAINED_UIDS]).sort();
  }
  if (["full-unresolved", "incremental-unresolved", "incremental-restored"].includes(mode)) {
    return evidence.removedFamilies ? [] : [MISSING_UID];
  }
  return evidence.removedFamilies ? RETAINED_UIDS : [MISSING_UID, ...RETAINED_UIDS].sort();
}

function storedFamilyDetails(families) {
  return families.map((uid) => {
    if (!inventoryLabelsAvailable) return { uid, name: null, folder_path: null };
    if (uid === MISSING_UID) {
      return { uid, name: "Owner tax return.txt", folder_path: "Reviewed Root/Tax" };
    }
    const retained = /^drive:retained-(\d{2})$/.exec(uid);
    if (retained) {
      return { uid, name: `Retained ${retained[1]}.txt`, folder_path: "Reviewed Root" };
    }
    return { uid, name: "Stored Drive item.txt", folder_path: "Reviewed Root" };
  });
}

function changedOutsideFile() {
  return {
    id: "outside-file",
    name: "Outside reviewed roots.txt",
    mimeType: "text/plain",
    size: "240",
    createdTime: "2026-01-01T00:00:00Z",
    modifiedTime: "2026-09-01T00:00:00Z",
    md5Checksum: "outside-version",
    trashed: false,
    parents: ["outside-folder"],
  };
}

function restoredFile() {
  return {
    id: MISSING_ID,
    name: "Restored fixture.txt",
    mimeType: "text/plain",
    size: "240",
    createdTime: "2026-01-01T00:00:00Z",
    modifiedTime: "2026-09-02T00:00:00Z",
    md5Checksum: "restored-version",
    trashed: false,
    parents: [ROOT_ID],
  };
}

function retainedFile(index) {
  const suffix = String(index).padStart(2, "0");
  return {
    id: `retained-${suffix}`,
    name: `Retained ${suffix}.txt`,
    mimeType: "text/plain",
    size: "240",
    createdTime: "2026-01-01T00:00:00Z",
    modifiedTime: "2026-09-02T00:00:00Z",
    md5Checksum: `retained-version-${suffix}`,
    trashed: false,
    parents: [ROOT_ID],
  };
}

globalThis.fetch = async (input, options = {}) => {
  const url = requestUrl(input);

  if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
    return json({ access_token: "fixture-access", expires_in: 3600 });
  }

  if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/changes/startPageToken") {
    return json({ startPageToken: `fixture-prewalk-${mode}` });
  }

  if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/changes") {
    const evidence = readEvidence();
    evidence.changesReads++;
    saveEvidence(evidence);
    if (mode === "changed-outside") {
      return json({
        changes: [{ fileId: "outside-file", file: changedOutsideFile() }],
        newStartPageToken: "fixture-next-changed-outside",
      });
    }
    if (mode === "incremental-restored") {
      return json({
        changes: [{ fileId: MISSING_ID, file: restoredFile() }],
        newStartPageToken: "fixture-next-incremental-restored",
      });
    }
    if (mode === "incremental-identity") {
      return json({
        changes: [{ fileId: testedStoredUid.slice("drive:".length), removed: true }],
        newStartPageToken: "fixture-next-incremental-identity",
      });
    }
    if (["incremental-stale-marker-404", "incremental-stale-marker-live", "incremental-review-empty"].includes(mode)) {
      return json({ changes: [], newStartPageToken: `fixture-next-${mode}` });
    }
    if (mode.startsWith("incremental-")) {
      return json({
        changes: (["incremental-unresolved-batch", "incremental-transient-batch"].includes(mode)
          ? BATCH_MISSING_IDS
          : [MISSING_ID])
          .map((fileId) => ({ fileId, removed: true })),
        newStartPageToken: `fixture-next-${mode}`,
      });
    }
    throw new Error("a forced full-sweep fixture reached the changes feed");
  }

  if (url.hostname === "www.googleapis.com" && url.pathname === `/drive/v3/files/${ROOT_ID}`) {
    return json({
      id: ROOT_ID,
      name: "Reviewed Root",
      mimeType: "application/vnd.google-apps.folder",
      trashed: false,
      parents: [],
    });
  }

  if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/files") {
    const query = String(url.searchParams.get("q") || "");
    if (!query.includes(`'${ROOT_ID}' in parents`)) {
      throw new Error("Drive ingest attempted an unscoped account-wide listing");
    }
    const evidence = readEvidence();
    evidence.rootedWalks++;
    saveEvidence(evidence);
    return json({
      files: mode === "incremental-restored"
        ? [restoredFile()]
        : ["full-malformed", "full-unresolved-subthreshold", "incremental-stale-marker-404", "incremental-stale-marker-live"].includes(mode)
          ? RETAINED_UIDS.map((_, index) => retainedFile(index))
          : [],
      nextPageToken: null,
      incompleteSearch: false,
    });
  }

  if (url.hostname === "www.googleapis.com" && url.pathname === `/drive/v3/files/${MISSING_ID}`) {
    const evidence = readEvidence();
    evidence.absenceMetadataReads++;
    saveEvidence(evidence);
    if (["full-unresolved", "full-unresolved-subthreshold", "incremental-stale-marker-404", "incremental-review-empty"].includes(mode)) {
      return json({ error: { message: "File not found" } }, 404);
    }
    if (mode === "incremental-stale-marker-live") {
      return json({
        id: MISSING_ID,
        name: "Owner tax return.txt",
        mimeType: "text/plain",
        trashed: false,
        parents: [ROOT_ID],
      });
    }
    if (mode === "incremental-unresolved") {
      return json({
        error: {
          message: "insufficient permissions",
          errors: [{ reason: "insufficientFilePermissions" }],
        },
      }, 403);
    }
    if (mode === "incremental-gone") {
      return json({ error: { message: "File not found" } }, 404);
    }
    if (mode === "incremental-trash") {
      return json({
        id: MISSING_ID,
        name: "Removed fixture.txt",
        mimeType: "text/plain",
        trashed: true,
        parents: [ROOT_ID],
      });
    }
    if (mode === "incremental-left-scope") {
      return json({
        id: MISSING_ID,
        name: "Moved fixture.txt",
        mimeType: "text/plain",
        trashed: false,
        parents: ["outside-folder"],
      });
    }
    throw new Error("an unrelated changed item reached absence classification");
  }

  if (url.hostname === "www.googleapis.com" &&
      decodeURIComponent(url.pathname.slice("/drive/v3/files/".length)) === testedStoredUid.slice("drive:".length) &&
      ["full-identity", "incremental-identity"].includes(mode)) {
    const evidence = readEvidence();
    evidence.absenceMetadataReads++;
    saveEvidence(evidence);
    return json({ error: { message: "File not found" } }, 404);
  }

  const retainedMatch = /^\/drive\/v3\/files\/retained-(\d{2})$/.exec(url.pathname);
  if (url.hostname === "www.googleapis.com" && retainedMatch &&
      mode === "incremental-stale-marker-404") {
    const index = Number(retainedMatch[1]);
    if (url.searchParams.get("alt") === "media") {
      return new Response(`Retained fixture ${retainedMatch[1]} ${"reviewed source text ".repeat(20)}`, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    return json(retainedFile(index));
  }

  if (url.hostname === "www.googleapis.com" && url.pathname.startsWith("/drive/v3/files/missing-batch-")) {
    const fileId = url.pathname.slice("/drive/v3/files/".length);
    const index = BATCH_MISSING_IDS.indexOf(fileId);
    if (!["incremental-unresolved-batch", "incremental-transient-batch"].includes(mode) || index < 0) {
      throw new Error("an unrelated batch item reached absence classification");
    }
    const evidence = readEvidence();
    evidence.absenceMetadataReads++;
    saveEvidence(evidence);
    if (mode === "incremental-transient-batch" && index === 0) {
      return json({ error: { message: "temporary provider failure" } }, 503);
    }
    if (mode === "incremental-transient-batch" || index < 3) {
      return json({
        error: {
          message: "insufficient permissions",
          errors: [{ reason: "insufficientFilePermissions" }],
        },
      }, 403);
    }
    return json({
      id: fileId,
      name: "Removed batch fixture.txt",
      mimeType: "text/plain",
      trashed: true,
      parents: [ROOT_ID],
    });
  }

  if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/files/outside-file") {
    const evidence = readEvidence();
    evidence.outsideContentReads++;
    saveEvidence(evidence);
    throw new Error("an out-of-root changed file reached the content boundary");
  }

  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/source-families") {
    const request = requestBody(options);
    if (request.source !== "drive") throw new Error("fixture received the wrong source inventory request");
    const evidence = readEvidence();
    evidence.inventoryReads++;
    saveEvidence(evidence);
    const families = storedFamilies(evidence);
    return json({
      source: "drive",
      families,
      ...(request.include_labels === true && inventoryLabelMode !== "absent"
        ? { family_details: storedFamilyDetails(families) }
        : {}),
      next_cursor: null,
    }, 200, inventoryDateAvailable);
  }

  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/forget") {
    const request = requestBody(options);
    const families = Array.isArray(request.families) ? request.families : [];
    const evidence = readEvidence();
    if (mode === "incremental-stale-marker-404" && families.length &&
        families.every((family) => Array.isArray(family?.keep_doc_uids) && family.keep_doc_uids.length > 0)) {
      return json({
        dry_run: false,
        documents: families.length,
        chunks: 0,
        vectors: 0,
        targets: families.map((family) => family.base_doc_uid),
      });
    }
    evidence.forgetRequests++;
    const expectedUids = mode === "incremental-unresolved-batch"
      ? BATCH_MISSING_UIDS.slice(3)
      : [MISSING_UID];
    if (!["full-unresolved", "incremental-gone", "incremental-trash", "incremental-left-scope", "incremental-unresolved-batch", "incremental-review-empty"].includes(mode) ||
        request.confirm !== true || families.length !== expectedUids.length ||
        families.some((family, index) => family?.base_doc_uid !== expectedUids[index] ||
          !Array.isArray(family?.keep_doc_uids) || family.keep_doc_uids.length !== 0)) {
      saveEvidence(evidence);
      throw new Error("fixture received an unsafe absence removal");
    }
    evidence.removedFamilies = families.length;
    saveEvidence(evidence);
    return json({
      dry_run: false,
      documents: families.length,
      chunks: families.length,
      vectors: families.length,
      targets: expectedUids,
    });
  }

  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/ingest/batch") {
    const evidence = readEvidence();
    evidence.ingestBatchWrites++;
    saveEvidence(evidence);
    if (mode === "incremental-stale-marker-404") {
      const request = requestBody(options);
      return json({
        results: (request.docs || []).map((document) => ({
          source_id: document.source_id,
          status: "created",
        })),
      });
    }
    throw new Error("scope-boundary fixture must not send an ingest batch");
  }

  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/source-receipt") {
    const receipt = requestBody(options);
    const evidence = readEvidence();
    if (Object.hasOwn(evidence.receipts, receipt.status)) evidence.receipts[receipt.status]++;
    if (receipt.status === "error") {
      evidence.lastErrorReceipt = {
        issue_code: receipt.issue_code || null,
        walk_complete: receipt.walk_complete === true,
        docs_failed: receipt.docs_failed,
      };
    }
    saveEvidence(evidence);
    return json({ source: receipt.source, status: receipt.status, run_id: receipt.run_id });
  }

  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/documents") {
    return json({ vector_backlog: { pending: 0 } });
  }

  throw new Error(`unexpected fixture request: ${options.method || "GET"} ${url.origin}${url.pathname}`);
};
