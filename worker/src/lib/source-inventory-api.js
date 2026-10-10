/**
 * Owner-only, read-only source inventory for Optimize and local tooling.
 *
 * The response is deliberately paged in a private JSON body. A cursor carries
 * the snapshot digest and as-of time, so a changed D1 inventory is refused
 * instead of stitching together pages from two different moments.
 */

import { jsonResponse, privateNoStore, validateAdminKey } from "./core.js";
import { backendOf, D1 } from "./store.js";
import { ownerSessionPrincipal } from "./owner-auth.js";
import { sourceInventory, sourceRecoveryCandidates } from "./store-d1.js";
import { sourceInventoryScanPage, sourceFreshnessPage } from "./source-inventory-scan.js";
import { recoveryPlanSummary } from "./source-inventory-merge.js";

export const SOURCE_INVENTORY_PATH = "/api/admin/brain/sources";
export const SOURCE_INVENTORY_CONTRACT_VERSION = 3;
export const SOURCE_INVENTORY_DEFAULT_PAGE_SIZE = 100;
export const SOURCE_INVENTORY_MAX_PAGE_SIZE = 250;

const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_CURSOR_BYTES = 4 * 1024;
const encoder = new TextEncoder();

const respond = (body, status = 200) => privateNoStore(jsonResponse(body, status));

function encodeBase64Url(value) {
  let binary = "";
  for (const byte of encoder.encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function validAsOf(value) {
  if (typeof value !== "string" || value.length !== 24) return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

function decodeCursor(value, mode) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || encoder.encode(value).length > MAX_CURSOR_BYTES) return undefined;
  const decoded = decodeBase64Url(value);
  if (!decoded) return undefined;
  let cursor;
  try { cursor = JSON.parse(decoded); } catch { return undefined; }
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
  const fields = Object.keys(cursor).sort().join(",");
  if (fields !== (mode === "bounded" ? "after,as_of,mode,page,snapshot,source,v" : "after,as_of,mode,snapshot,source,v")) return undefined;
  if (mode === "bounded" && (!Number.isSafeInteger(cursor.page) || cursor.page < 1 || cursor.page >= 1000)) return undefined;
  if (cursor.v !== SOURCE_INVENTORY_CONTRACT_VERSION) return undefined;
  if (cursor.mode !== mode) return undefined;
  if (mode === "inventory" &&
      (typeof cursor.after !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(cursor.after))) {
    return undefined;
  }
  if (["recovery", "bounded"].includes(mode) && (!Number.isSafeInteger(cursor.after) || cursor.after < 1)) return undefined;
  if (!(cursor.source === null ||
        (typeof cursor.source === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(cursor.source)))) {
    return undefined;
  }
  if (mode !== "recovery" && cursor.source !== null) return undefined;
  if (typeof cursor.snapshot !== "string" || !/^[a-f0-9]{64}$/.test(cursor.snapshot)) return undefined;
  if (!validAsOf(cursor.as_of)) return undefined;
  return cursor;
}

async function digestHex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function inventoryBody(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_REQUEST_BYTES) return { error: "source inventory request is too large", status: 413 };
  let raw;
  let body;
  try {
    raw = await request.text();
    if (encoder.encode(raw).length > MAX_REQUEST_BYTES) {
      return { error: "source inventory request is too large", status: 413 };
    }
    body = JSON.parse(raw || "{}");
  } catch {
    return { error: "source inventory request must be a JSON object", status: 400 };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "source inventory request must be a JSON object", status: 400 };
  }
  if (Object.keys(body).some((field) =>
    !["cursor", "limit", "mode", "source", "source_group_cursor"].includes(field))) {
    return { error: "source inventory request has unknown fields", status: 400 };
  }
  const mode = body.mode === undefined ? "inventory" : body.mode;
  if (!["inventory", "recovery", "bounded", "freshness"].includes(mode)) {
    return { error: "mode must be inventory, bounded, freshness, or recovery", status: 400 };
  }
  const maximum = mode === "bounded" ? 5000 : SOURCE_INVENTORY_MAX_PAGE_SIZE;
  const limit = body.limit === undefined ? (mode === "bounded" ? 5000 : SOURCE_INVENTORY_DEFAULT_PAGE_SIZE) : body.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    return {
      error: `limit must be an integer from 1 to ${maximum}`,
      status: 400,
    };
  }
  if (mode === "freshness" && (body.cursor !== undefined || body.limit !== undefined)) {
    return { error: "freshness reads do not accept a cursor or limit", status: 400 };
  }
  const cursor = decodeCursor(body.cursor, mode);
  if (cursor === undefined) return { error: "cursor is not valid for this inventory", status: 400 };
  if (body.source !== undefined &&
      (typeof body.source !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(body.source))) {
    return { error: "source must be a normalized source id", status: 400 };
  }
  if (mode !== "recovery" && body.source !== undefined) {
    return { error: "source is available only in recovery mode", status: 400 };
  }
  if (body.source_group_cursor !== undefined &&
      (mode !== "recovery" || typeof body.source_group_cursor !== "string" ||
       !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(body.source_group_cursor))) {
    return { error: "source_group_cursor is available only in recovery mode and must be a normalized source id", status: 400 };
  }
  const source = body.source ?? cursor?.source ?? null;
  if (cursor && cursor.source !== source) {
    return { error: "source does not match this recovery cursor", status: 400 };
  }
  return {
    body: {
      limit,
      cursor,
      mode,
      source,
      sourceGroupCursor: body.source_group_cursor ?? null,
    },
  };
}

function sourceInventoryLimitations() {
  return {
    entity_year_coverage: "not_available",
    financial_reconciliation: "not_available",
    tax_completeness: "not_available",
    scan_only_classification: "not_available",
    meaning: "This inventory reports only source, masked configuration, storage, receipt, readability, provenance, and freshness evidence recorded in this Brain.",
  };
}

function sourceRecoveryLimitations() {
  return {
    read_only: true,
    repair_performed: false,
    ocr_performed: false,
    scan_only_classification: "not_available",
    raw_locator_disclosure: "not_available",
    entity_year_coverage: "not_available",
    meaning: "This is a bounded recovery preview from stored provenance and text receipts. Empty text is an OCR candidate, not proof that the original is a scan.",
  };
}

/**
 * Describe why the inventory refused, without letting the cause become a leak.
 *
 * The first 0.4.8 field failure returned one opaque code for a D1 resource
 * abort, an invalid source identity, and a failed recovery summary alike, so
 * diagnosing it needed a whole read-only investigation. This keeps the public
 * code stable and adds a bounded description: the error class, the store's own
 * failure code when it set one, and a message reduced to an allowlisted
 * alphabet with every quoted segment removed, so no SQL text, row value,
 * document metadata, path, or identifier can ride out on it.
 */
function inventoryFailureDetail(error) {
  const errorClass = /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(String(error?.name || ""))
    ? String(error.name)
    : "Error";
  const failureCode = /^[a-z][a-z0-9_]{0,63}$/.test(String(error?.code || ""))
    ? String(error.code)
    : null;
  const reason = String(error?.message || "")
    .split("\n")[0]
    .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, " ")
    .replace(/[^A-Za-z0-9 ,.:()/_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return {
    error_class: errorClass,
    failure_code: failureCode,
    reason: reason || null,
    redacted: true,
  };
}

/** Record the refusal where the owner can retrieve it, never its payload. */
function logInventoryFailure(stage, detail) {
  console.warn(
    `[source-inventory] ${stage} refused: ${detail.error_class}`
    + `${detail.failure_code ? ` (${detail.failure_code})` : ""}`
    + `${detail.reason ? `: ${detail.reason}` : ""}`,
  );
}

/** Handle the one source-inventory route, including its narrow auth boundary. */
export async function handleSourceInventoryApi(env, request) {
  let authorized = validateAdminKey(request, env);
  if (!authorized) {
    let principal;
    try {
      principal = await ownerSessionPrincipal(request, env);
    } catch {
      return respond({ error: "unavailable", code: "owner_auth_unavailable" }, 503);
    }
    if (principal?.denied || (principal && (principal.kind !== "owner" || principal.grantId !== null))) {
      return respond({ error: "forbidden", code: "owner_required" }, 403);
    }
    authorized = principal?.kind === "owner" && principal.grantId === null;
  }
  if (!authorized) return respond({ error: "unauthorized", code: "owner_required" }, 401);

  if (request.method !== "POST") {
    return respond({
      error: "source inventory must use a JSON POST body so private cursors never enter URLs",
    }, 405);
  }

  if (backendOf(env) !== D1) {
    return respond({ error: "source inventory applies to the d1 backend only" }, 400);
  }
  const parsed = await inventoryBody(request);
  if (!parsed.body) return respond({ error: parsed.error }, parsed.status);

  const { limit, cursor, mode, source, sourceGroupCursor } = parsed.body;
  const asOf = cursor?.as_of || new Date().toISOString();
  if (mode === "freshness") {
    try {
      const sources = await sourceFreshnessPage(env, { now: Date.parse(asOf) });
      return respond({ contract_version: 3, kind: "source_freshness", as_of: asOf, sources });
    } catch {
      return respond({ error: "source freshness is unavailable", code: "source_inventory_unavailable" }, 503);
    }
  }
  if (mode === "bounded") {
    try {
      const inventory = await sourceInventoryScanPage(env, {
        after: cursor?.after || 0, limit, now: Date.parse(asOf), snapshot: cursor?.snapshot ?? null,
      });
      const page = (cursor?.page || 0) + 1;
      if (!inventory.complete && page >= 1000) throw new Error("inventory page limit");
      const { after: _after, through: _through, ...scan } = inventory.scan;
      const nextCursor = inventory.complete ? null : encodeBase64Url(JSON.stringify({
        v: SOURCE_INVENTORY_CONTRACT_VERSION, mode, page, after: inventory.scan.through,
        snapshot: inventory.snapshot, as_of: asOf, source: null,
      }));
      return respond({ contract_version: 3, kind: "source_inventory_scan",
        complete: inventory.complete, truncated: !inventory.complete, cursor: nextCursor,
        as_of: asOf, snapshot: inventory.snapshot, scan: { ...scan, page },
        sources: inventory.rows, families: inventory.families, limitations: sourceInventoryLimitations(),
      });
    } catch (error) {
      const changed = error?.code === "source_inventory_changed";
      return respond({ error: changed ? "source inventory changed; restart from the first page"
        : "bounded source inventory is unavailable", code: changed ? "source_inventory_changed"
        : "source_inventory_unavailable" }, changed ? 409 : 503);
    }
  }
  if (mode === "recovery") {
    let recovery;
    try {
      recovery = await sourceRecoveryCandidates(env, {
        source,
        afterRowId: cursor?.after || 0,
        afterSourceId: sourceGroupCursor,
        limit,
      });
    } catch (error) {
      const changed = error?.code === "source_recovery_changed";
      const detail = inventoryFailureDetail(error);
      logInventoryFailure(changed ? "recovery snapshot" : "recovery", detail);
      return respond({
        error: changed
          ? "source recovery inventory changed; restart from the first page"
          : "source recovery inventory is unavailable",
        code: changed ? "source_inventory_changed" : "source_inventory_unavailable",
        detail,
      }, changed ? 409 : 503);
    }
    const snapshot = await digestHex(JSON.stringify({
      contract_version: SOURCE_INVENTORY_CONTRACT_VERSION,
      mode,
      as_of: asOf,
      source,
      marker: recovery.marker,
    }));
    if (cursor && cursor.snapshot !== snapshot) {
      return respond({
        error: "source recovery inventory changed; restart from the first page",
        code: "source_inventory_changed",
      }, 409);
    }
    const truncated = recovery.truncated;
    const nextCursor = truncated && recovery.nextAfterRowId !== null
      ? encodeBase64Url(JSON.stringify({
          v: SOURCE_INVENTORY_CONTRACT_VERSION,
          mode,
          after: recovery.nextAfterRowId,
          snapshot,
          as_of: asOf,
          source,
        }))
      : null;
    return respond({
      contract_version: SOURCE_INVENTORY_CONTRACT_VERSION,
      kind: "source_recovery_plan",
      complete: !truncated,
      total: recovery.total,
      returned: recovery.rows.length,
      truncated,
      cursor: nextCursor,
      as_of: asOf,
      snapshot: {
        id: `sha256:${snapshot}`,
        as_of: asOf,
        stable: true,
        total: recovery.total,
        basis: "corpus_mutation_receipt",
      },
      source_filter: source,
      recovery_plan_summary: {
        ...recovery.summary,
        candidate_pages_at_requested_size: Math.ceil(recovery.total / limit),
        page: {
          limit,
          returned: recovery.rows.length,
          truncated,
        },
      },
      candidates: recovery.rows,
      limitations: sourceRecoveryLimitations(),
    });
  }

  let inventory;
  try {
    inventory = await sourceInventory(env, { now: Date.parse(asOf) });
  } catch (error) {
    const code = error?.code === "source_inventory_too_large"
      ? "source_inventory_too_large"
      : "source_inventory_unavailable";
    const detail = inventoryFailureDetail(error);
    logInventoryFailure("inventory", detail);
    return respond({
      error: code === "source_inventory_too_large"
        ? "source inventory is too large for one safe snapshot"
        : "source inventory is unavailable",
      code,
      detail,
    }, 503);
  }

  const snapshot = await digestHex(JSON.stringify({
    contract_version: SOURCE_INVENTORY_CONTRACT_VERSION,
    as_of: asOf,
    sources: inventory.rows,
  }));
  if (cursor && cursor.snapshot !== snapshot) {
    return respond({
      error: "source inventory changed; restart from the first page",
      code: "source_inventory_changed",
    }, 409);
  }

  let recoverySummary;
  try {
    recoverySummary = recoveryPlanSummary(inventory.rows);
  } catch (error) {
    const detail = inventoryFailureDetail(error);
    logInventoryFailure("inventory recovery summary", detail);
    return respond({
      error: "source inventory recovery summary is unavailable",
      code: "source_inventory_unavailable",
      detail,
    }, 503);
  }

  let start = 0;
  if (cursor) {
    const index = inventory.rows.findIndex((row) => row.source_id === cursor.after);
    if (index < 0) return respond({ error: "cursor is not valid for this inventory" }, 400);
    start = index + 1;
  }
  const sources = inventory.rows.slice(start, start + limit);
  const truncated = start + sources.length < inventory.total;
  const nextCursor = truncated && sources.length
      ? encodeBase64Url(JSON.stringify({
        v: SOURCE_INVENTORY_CONTRACT_VERSION,
        mode,
        after: sources[sources.length - 1].source_id,
        snapshot,
        as_of: asOf,
        source: null,
      }))
    : null;

  return respond({
    contract_version: SOURCE_INVENTORY_CONTRACT_VERSION,
    kind: "source_inventory",
    complete: !truncated,
    total: inventory.total,
    returned: sources.length,
    truncated,
    cursor: nextCursor,
    as_of: asOf,
    snapshot: { id: `sha256:${snapshot}`, as_of: asOf, stable: true, total: inventory.total },
    sources,
    recovery_plan_summary: recoverySummary,
    limitations: sourceInventoryLimitations(),
  });
}
