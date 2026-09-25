/** Offline fixture for version-aware active Drive skip handling. */

import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";

const userRoot = String(process.env.BRAIN_DRIVE_SKIP_USER_ROOT || "");
const evidencePath = String(process.env.BRAIN_DRIVE_SKIP_EVIDENCE || "");
const fixtureMode = String(process.env.BRAIN_DRIVE_SKIP_MODE || "mixed");
if (!userRoot) throw new Error("BRAIN_DRIVE_SKIP_USER_ROOT is required");
if (!evidencePath) throw new Error("BRAIN_DRIVE_SKIP_EVIDENCE is required");
if (!["mixed", "adjudicated-only", "quality-review", "quality-new-item", "binary-new-item"].includes(fixtureMode)) {
  throw new Error("invalid Drive active-skip fixture mode");
}

os.homedir = () => userRoot;
syncBuiltinESMExports();

const MIGRATED = "drive:active-migrated";
const STALE = "drive:active-stale";
const SENSITIVE = "drive:active-sensitive";
const MISSING = "drive:source-missing";
const QUALITY = "drive:active-quality";
const QUALITY_NEW = "drive:active-quality-new";
const ALLOWED_REMOVALS = new Set([STALE, SENSITIVE, MISSING]);

const initialEvidence = () => ({
  forgetRequests: 0,
  reconcileRequests: 0,
  removedFamilies: 0,
  inventoryReads: 0,
  ingestBatchWrites: 0,
  retainedFamilyReachedForget: false,
  contentRefusalReachedForget: false,
  receipts: { indexing: 0, error: 0, ready: 0 },
  lastFinalReceipt: null,
});

function readEvidence() {
  try {
    const parsed = JSON.parse(readFileSync(evidencePath, "utf8"));
    return { ...initialEvidence(), ...parsed, receipts: { ...initialEvidence().receipts, ...(parsed.receipts || {}) } };
  } catch (error) {
    if (error?.code === "ENOENT") return initialEvidence();
    throw error;
  }
}

function saveEvidence(evidence) {
  writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", date: new Date().toUTCString() },
  });
}

function raw(body) {
  return new Response(body, { status: 200, headers: { "content-type": "application/octet-stream" } });
}

function requestUrl(input) {
  return new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
}

function parseBody(options) {
  return JSON.parse(String(options.body || "{}"));
}

function files() {
  const all = [
    {
      id: "active-migrated", name: "migrated.png", mimeType: "image/png", size: "200",
      createdTime: "2025-01-01T00:00:00Z", modifiedTime: "2026-08-20T00:00:00Z", md5Checksum: "migrated-current", parents: ["fixture-root"],
    },
    {
      id: "active-stale", name: "changed.bin", mimeType: "application/octet-stream", size: "200",
      createdTime: "2025-01-01T00:00:00Z", modifiedTime: "2026-08-21T00:00:00Z", md5Checksum: "stale-current", parents: ["fixture-root"],
    },
    {
      id: "active-sensitive", name: "sensitive.txt", mimeType: "text/plain", size: "300",
      createdTime: "2025-01-01T00:00:00Z", modifiedTime: "2026-08-22T00:00:00Z", md5Checksum: "sensitive-current", parents: ["fixture-root"],
    },
  ];
  if (fixtureMode === "quality-review") {
    return [{
      id: "active-quality", name: "changed-text.txt", mimeType: "text/plain", size: "8000",
      createdTime: "2025-01-01T00:00:00Z", modifiedTime: "2026-08-23T00:00:00Z",
      md5Checksum: "quality-current", parents: ["fixture-root"],
    }];
  }
  if (fixtureMode === "quality-new-item") {
    return [{
      id: "active-quality-new", name: "decode-failure.txt", mimeType: "text/plain", size: "8000",
      createdTime: "2025-01-01T00:00:00Z", modifiedTime: "2026-08-24T00:00:00Z",
      md5Checksum: "quality-new-current", parents: ["fixture-root"],
    }];
  }
  if (fixtureMode === "binary-new-item") {
    return [{
      id: "active-binary-new", name: "binary-as-text.txt", mimeType: "text/plain", size: "8000",
      createdTime: "2025-01-01T00:00:00Z", modifiedTime: "2026-08-25T00:00:00Z",
      md5Checksum: "binary-new-current", parents: ["fixture-root"],
    }];
  }
  return fixtureMode === "adjudicated-only" ? [all[0]] : all;
}

globalThis.fetch = async (input, options = {}) => {
  const url = requestUrl(input);

  if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
    return json({ access_token: "fixture-access", expires_in: 3600 });
  }
  if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/changes/startPageToken") {
    return json({ startPageToken: "fixture-skip-next-cursor" });
  }
  if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/changes") {
    return json({ changes: [], newStartPageToken: "fixture-skip-no-change-cursor" });
  }
  if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/files") {
    if (!String(url.searchParams.get("q") || "").includes("'fixture-root' in parents")) {
      throw new Error("Drive ingest attempted an unscoped account-wide listing");
    }
    return json({ files: files(), nextPageToken: null, incompleteSearch: false });
  }
  if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/files/fixture-root") {
    return json({ id: "fixture-root", name: "Reviewed Root", mimeType: "application/vnd.google-apps.folder" });
  }
  if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/files/source-missing") {
    return json({ id: "source-missing", name: "missing.txt", mimeType: "text/plain", trashed: true, parents: ["fixture-root"] });
  }
  if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/files/active-sensitive") {
    // Invented test-only credential shape. The fixture never writes it to its
    // evidence file or returns it from the connector.
    return raw(`Operations note with enough ordinary prose to pass quality. Temporary access key: AKIA${"Z".repeat(16)}.`);
  }
  if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/files/active-quality") {
    return raw(Array.from({ length: 260 }, (_, i) => `xqz${i} brt${i} nvm${i} :::`).join(" "));
  }
  if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/files/active-quality-new") {
    return raw("\ufffd".repeat(500) + " deterministic decode failure control");
  }
  if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/files/active-binary-new") {
    return raw(Buffer.from("binary\0content presented through a text media type"));
  }

  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/source-families") {
    const request = parseBody(options);
    const evidence = readEvidence();
    evidence.inventoryReads++;
    saveEvidence(evidence);
    const families = fixtureMode === "quality-review"
      ? [QUALITY]
      : ["quality-new-item", "binary-new-item"].includes(fixtureMode)
      ? []
      : fixtureMode === "adjudicated-only"
      ? (evidence.removedFamilies >= 3 ? [] : [MIGRATED])
      : evidence.removedFamilies
        ? [MIGRATED, STALE]
        : [MIGRATED, STALE, SENSITIVE, MISSING].sort();
    return json({
      source: request.source,
      families,
      ...(request.include_labels === true ? {
        family_details: families.map((uid) => ({ uid, name: null, folder_path: null })),
      } : {}),
      next_cursor: null,
    });
  }

  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/forget") {
    const request = parseBody(options);
    const evidence = readEvidence();
    const plans = request.families || [];
    const families = plans.map((family) => String(family?.base_doc_uid || ""));
    if (fixtureMode === "quality-review" && families.length === 1 && families[0] === QUALITY &&
        Array.isArray(plans[0]?.keep_doc_uids) && plans[0].keep_doc_uids.includes(QUALITY)) {
      evidence.reconcileRequests++;
      saveEvidence(evidence);
      return json({ dry_run: false, documents: 0, chunks: 0, vectors: 0, targets: [] });
    }
    evidence.forgetRequests++;
    if ((families.includes(MIGRATED) && fixtureMode !== "adjudicated-only") ||
        families.includes(QUALITY) || families.includes(QUALITY_NEW)) {
      evidence.retainedFamilyReachedForget = true;
    }
    if (families.includes(STALE)) evidence.contentRefusalReachedForget = true;
    const allowed = new Set([
      ...ALLOWED_REMOVALS,
      ...(fixtureMode === "adjudicated-only" ? [MIGRATED] : []),
    ]);
    if (!families.length || request.confirm !== true || families.some((uid) => !allowed.has(uid))) {
      saveEvidence(evidence);
      throw new Error("fixture received an unsafe active-skip removal");
    }
    evidence.removedFamilies += families.length;
    saveEvidence(evidence);
    return json({
      dry_run: false,
      documents: families.length,
      chunks: families.length,
      vectors: families.length,
      targets: families,
    });
  }

  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/ingest/batch") {
    const request = parseBody(options);
    const evidence = readEvidence();
    evidence.ingestBatchWrites++;
    saveEvidence(evidence);
    if (fixtureMode === "quality-review" && Array.isArray(request.docs) && request.docs.length === 1) {
      return json({
        results: request.docs.map((doc) => ({ source_id: doc.source_id, status: "updated" })),
      });
    }
    throw new Error("active skip fixture must not send an ingest batch");
  }

  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/source-receipt") {
    const receipt = parseBody(options);
    const evidence = readEvidence();
    if (Object.hasOwn(evidence.receipts, receipt.status)) evidence.receipts[receipt.status]++;
    if (receipt.status !== "indexing") {
      evidence.lastFinalReceipt = {
        status: receipt.status,
        complete_sweep: receipt.complete_sweep ?? null,
        walk_complete: receipt.walk_complete ?? null,
        docs_refused: receipt.docs_refused ?? null,
        docs_failed: receipt.docs_failed ?? null,
        issue_code: receipt.issue_code || null,
        detail: receipt.detail || null,
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
