/**
 * Privilege-separated Cloudflare provider for the fixed v0.4.8 teardown.
 *
 * The coordinator invokes this exact, package-pinned program through an
 * owner-only wrapper. The wrapper reads the Cloudflare token from macOS
 * Keychain and streams it to stdin; the request arrives on descriptor 3.
 * Credentials therefore never enter argv, the environment, or output.
 *
 * This provider can address only the two retired-after-use campaign names.
 * It returns hashes, counts, booleans, and HTTP status categories. Raw account
 * IDs, resource IDs, hostnames, routes, bindings, provider bodies, and errors
 * never cross the child boundary.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { TextDecoder } from "node:util";

export const CLOUDFLARE_DISPOSABLE_TEARDOWN_PROVIDER_SCHEMA_VERSION = 1;
export const CLOUDFLARE_DISPOSABLE_TEARDOWN_API_ORIGIN = "https://api.cloudflare.com";

export const DISPOSABLE_TEARDOWN_NAMES = Object.freeze({
  source: "brain-test-v048-field-source-recovery-gate-a48f1101",
  target: "brain-test-v048-field-target-recovery-gate-a48f1102",
});

const API_PREFIX = "/client/v4";
const CHILD_FLAG = "--campaign-teardown-provider-child";
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_RESPONSE_CHUNKS = 4096;
const MAX_PAGES = 100;
const PAGE_SIZE = 100;
const MAX_WORKERS = 200;
const MAX_VERSIONS_PER_WORKER = 200;
const MAX_STORAGE_RESOURCES = MAX_PAGES * PAGE_SIZE;
const MAX_SCHEDULES = 64;
const MAX_TOKEN_BYTES = 8 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/u;
const WORKER_ID_RE = /^[a-f0-9]{32}$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const RESOURCE_ORDER = Object.freeze(["worker", "vectorize", "d1"]);

export class CloudflareDisposableTeardownProviderError extends Error {
  constructor(code) {
    super(code);
    this.name = "CloudflareDisposableTeardownProviderError";
    this.code = code;
  }
}

function refuse(code) {
  throw new CloudflareDisposableTeardownProviderError(code);
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, fields) {
  return plainObject(value) && Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function exactUtcRfc3339(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u
    .exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  return calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day &&
    calendar.getUTCHours() === hour && calendar.getUTCMinutes() === minute &&
    calendar.getUTCSeconds() === second;
}

function checkedMaintenanceWindow(value) {
  if (!exactKeys(value, ["single_operator", "other_actors_paused"]) ||
      value.single_operator !== true || value.other_actors_paused !== true) {
    refuse("CF_TEARDOWN_MAINTENANCE_WINDOW_REQUIRED");
  }
  return deepFreeze(structuredClone(value));
}

function checkedTarget(value, role) {
  if (!exactKeys(value, [
    "account_id", "worker_id", "worker_name", "database_id", "database_name",
    "vectorize_name", "vectorize_created_on", "other_worker_name",
  ]) || !["source", "target"].includes(role)) {
    refuse("CF_TEARDOWN_TARGET_INVALID");
  }
  const name = DISPOSABLE_TEARDOWN_NAMES[role];
  const otherRole = role === "source" ? "target" : "source";
  if (!ACCOUNT_ID_RE.test(String(value.account_id || "").toLowerCase()) ||
      !WORKER_ID_RE.test(String(value.worker_id || "").toLowerCase()) ||
      !UUID_RE.test(String(value.database_id || "").toLowerCase()) ||
      value.worker_name !== name || value.database_name !== name ||
      value.vectorize_name !== name ||
      !exactUtcRfc3339(value.vectorize_created_on) ||
      value.other_worker_name !== DISPOSABLE_TEARDOWN_NAMES[otherRole]) {
    refuse("CF_TEARDOWN_TARGET_INVALID");
  }
  return deepFreeze({
    accountId: value.account_id.toLowerCase(),
    workerId: value.worker_id.toLowerCase(),
    workerName: value.worker_name,
    databaseId: value.database_id.toLowerCase(),
    databaseName: value.database_name,
    vectorizeName: value.vectorize_name,
    vectorizeCreatedOn: value.vectorize_created_on,
    otherWorkerName: value.other_worker_name,
  });
}

export function validateDisposableTeardownProviderRequest(value) {
  if (!exactKeys(value, [
    "schema_version", "operation", "role", "kind", "target",
    "expected_instance_fingerprint", "maintenance_window",
  ]) || value.schema_version !== 1 ||
      !["preview", "delete", "reconcile"].includes(value.operation) ||
      !["source", "target"].includes(value.role)) {
    refuse("CF_TEARDOWN_REQUEST_INVALID");
  }
  const target = checkedTarget(value.target, value.role);
  const maintenanceWindow = checkedMaintenanceWindow(value.maintenance_window);
  if (value.operation === "preview") {
    if (value.kind !== null || value.expected_instance_fingerprint !== null) {
      refuse("CF_TEARDOWN_REQUEST_INVALID");
    }
  } else if (!RESOURCE_ORDER.includes(value.kind) ||
      !SHA256_RE.test(String(value.expected_instance_fingerprint || ""))) {
    refuse("CF_TEARDOWN_REQUEST_INVALID");
  }
  return deepFreeze({
    schema_version: 1,
    operation: value.operation,
    role: value.role,
    kind: value.kind,
    target,
    expectedInstanceFingerprint: value.expected_instance_fingerprint,
    maintenanceWindow,
  });
}

function encoded(value) {
  return encodeURIComponent(value);
}

function apiUrl(accountId, suffix, query = null) {
  if (!ACCOUNT_ID_RE.test(accountId) || typeof suffix !== "string" ||
      !suffix.startsWith("/") || suffix.includes("//") ||
      suffix.includes("?") || suffix.includes("#")) {
    refuse("CF_TEARDOWN_ENDPOINT_INVALID");
  }
  const expectedPath = `${API_PREFIX}/accounts/${encoded(accountId)}${suffix}`;
  const url = new URL(expectedPath, CLOUDFLARE_DISPOSABLE_TEARDOWN_API_ORIGIN);
  if (query) {
    for (const [key, value] of query) url.searchParams.append(key, value);
  }
  if (url.protocol !== "https:" ||
      url.origin !== CLOUDFLARE_DISPOSABLE_TEARDOWN_API_ORIGIN ||
      url.pathname !== expectedPath || url.username || url.password || url.hash) {
    refuse("CF_TEARDOWN_ENDPOINT_INVALID");
  }
  return url;
}

async function boundedBytes(response, signal, { allowEmpty = false } = {}) {
  if (!response || typeof response.status !== "number" ||
      !response.headers || typeof response.headers.get !== "function") {
    refuse("CF_TEARDOWN_RESPONSE_INVALID");
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && declared !== "") {
    if (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES) {
      refuse("CF_TEARDOWN_RESPONSE_INVALID");
    }
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    if (allowEmpty && (declared === null || declared === "" || declared === "0")) {
      return Buffer.alloc(0);
    }
    refuse("CF_TEARDOWN_RESPONSE_INVALID");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (let count = 0;; count += 1) {
      if (count >= MAX_RESPONSE_CHUNKS) refuse("CF_TEARDOWN_RESPONSE_INVALID");
      let item;
      try { item = await reader.read(); }
      catch { refuse(signal.aborted ? "CF_TEARDOWN_REQUEST_TIMEOUT" : "CF_TEARDOWN_RESPONSE_INVALID"); }
      if (signal.aborted) refuse("CF_TEARDOWN_REQUEST_TIMEOUT");
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) refuse("CF_TEARDOWN_RESPONSE_INVALID");
      total += item.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch {}
        refuse("CF_TEARDOWN_RESPONSE_INVALID");
      }
      chunks.push(Buffer.from(item.value));
    }
    if (total === 0 && !allowEmpty) refuse("CF_TEARDOWN_RESPONSE_INVALID");
    return Buffer.concat(chunks, total);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    try { reader.releaseLock(); } catch {}
  }
}

function parseJsonBytes(bytes, contentType) {
  const normalized = String(contentType || "").trim().toLowerCase();
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*"?utf-8"?)?$/u.test(normalized)) {
    refuse("CF_TEARDOWN_RESPONSE_INVALID");
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(text);
    if (!plainObject(value)) refuse("CF_TEARDOWN_RESPONSE_INVALID");
    return value;
  } catch (error) {
    if (error instanceof CloudflareDisposableTeardownProviderError) throw error;
    refuse("CF_TEARDOWN_RESPONSE_INVALID");
  }
}

function envelope(value, { allowResultInfo = false } = {}) {
  const allowed = new Set(["success", "errors", "messages", "result", "result_info"]);
  if (!plainObject(value) || Object.keys(value).some((key) => !allowed.has(key)) ||
      !Object.hasOwn(value, "result") || value.success !== true ||
      !Array.isArray(value.errors) || value.errors.length !== 0 ||
      !Array.isArray(value.messages) || value.messages.length !== 0 ||
      (!allowResultInfo && Object.hasOwn(value, "result_info"))) {
    refuse("CF_TEARDOWN_PROVIDER_REFUSED");
  }
  return value;
}

// The Workers Beta DELETE endpoint deliberately has no `result` member. Keep
// this operation-specific so no read/list response can silently lose its
// result-body requirement.
function workerDeleteEnvelope(value) {
  if (!exactKeys(value, ["success", "errors", "messages"]) ||
      value.success !== true || !Array.isArray(value.errors) ||
      value.errors.length !== 0 || !Array.isArray(value.messages) ||
      value.messages.length !== 0) {
    refuse("CF_TEARDOWN_PROVIDER_REFUSED");
  }
  return value;
}

function diagnosticText(value, maximum) {
  return typeof value === "string" && value.length >= 1 &&
    value.length <= maximum && !CONTROL_RE.test(value);
}

function diagnosticSource(value) {
  if (!plainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => key === "pointer") &&
    (!Object.hasOwn(value, "pointer") || diagnosticText(value.pointer, 1024));
}

function diagnosticEntry(value) {
  if (!plainObject(value)) return false;
  const allowed = new Set(["code", "message", "documentation_url", "source"]);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.has(key)) ||
      !Object.hasOwn(value, "code") || !Object.hasOwn(value, "message") ||
      !Number.isSafeInteger(value.code) || value.code < 1000 ||
      !diagnosticText(value.message, 1024) ||
      Object.hasOwn(value, "source") && !diagnosticSource(value.source)) {
    return false;
  }
  if (Object.hasOwn(value, "documentation_url")) {
    if (!diagnosticText(value.documentation_url, 2048)) return false;
    let url;
    try { url = new URL(value.documentation_url); } catch { return false; }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      return false;
    }
  }
  return true;
}

function missingEnvelope(value, kind) {
  if (!exactKeys(value, ["success", "errors", "messages", "result"]) ||
      value.success !== false || value.result !== null ||
      !Array.isArray(value.messages) || value.messages.length > 16 ||
      value.messages.some((message) => !diagnosticEntry(message)) ||
      !Array.isArray(value.errors) ||
      value.errors.length < 1 || value.errors.length > 16 ||
      value.errors.some((error) => !diagnosticEntry(error)) ||
      kind === "worker" &&
        (value.errors.length !== 1 || value.errors[0].code !== 10007)) {
    refuse("CF_TEARDOWN_MISSING_ENVELOPE_INVALID");
  }
  return sha256(canonical({ codes: value.errors.map((error) => error.code).sort() }));
}

function tokenText(token) {
  if (!Buffer.isBuffer(token) || token.length < 16 || token.length > MAX_TOKEN_BYTES) {
    refuse("CF_TEARDOWN_TOKEN_INVALID");
  }
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(token); }
  catch { refuse("CF_TEARDOWN_TOKEN_INVALID"); }
  if (text.endsWith("\n")) text = text.slice(0, -1);
  if (text.endsWith("\r")) text = text.slice(0, -1);
  if (text.length < 16 || CONTROL_RE.test(text) || text !== text.trim()) {
    refuse("CF_TEARDOWN_TOKEN_INVALID");
  }
  return text;
}

function tokenReflected(value, secret) {
  const pending = [value];
  while (pending.length) {
    const next = pending.pop();
    if (typeof next === "string" && next.includes(secret)) return true;
    if (Array.isArray(next)) pending.push(...next);
    else if (next && typeof next === "object") pending.push(...Object.values(next));
  }
  return false;
}

async function providerRequest(fetchImpl, token, url, {
  method = "GET",
  json = true,
  allow404 = false,
  allowResultInfo = false,
  workerDeleteSuccess = false,
  missingKind = null,
} = {}) {
  const secret = tokenText(token);
  if (url.href.includes(secret)) refuse("CF_TEARDOWN_TOKEN_PLACEMENT_REFUSED");
  const headers = {
    Accept: json ? "application/json" : "*/*",
    Authorization: `Bearer ${secret}`,
    "Cache-Control": "no-store",
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  let dispatched = false;
  try {
    try {
      // From this assignment onward, any DELETE failure is ambiguous. A
      // response parser, redirect check, body limit, or timeout cannot prove
      // that Cloudflare did not commit the name-only operation.
      dispatched = true;
      response = await fetchImpl(url, {
        method,
        headers,
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      refuse(method === "DELETE"
        ? "CF_TEARDOWN_DELETE_OUTCOME_UNKNOWN"
        : controller.signal.aborted
          ? "CF_TEARDOWN_REQUEST_TIMEOUT"
          : "CF_TEARDOWN_REQUEST_FAILED");
    } finally {
      delete headers.Authorization;
    }
    if (!response || typeof response.status !== "number") {
      refuse("CF_TEARDOWN_RESPONSE_INVALID");
    }
    if (response?.redirected === true || response?.status >= 300 && response.status < 400) {
      refuse("CF_TEARDOWN_REDIRECT_REFUSED");
    }
    if (response?.url) {
      let observed;
      try { observed = new URL(response.url); } catch { refuse("CF_TEARDOWN_RESPONSE_INVALID"); }
      if (observed.href !== url.href ||
          observed.origin !== CLOUDFLARE_DISPOSABLE_TEARDOWN_API_ORIGIN) {
        refuse("CF_TEARDOWN_REDIRECT_REFUSED");
      }
    }
    const is404 = response.status === 404;
    const isSuccess = response.status >= 200 && response.status < 300;
    if (!isSuccess && !(allow404 && is404)) {
      // Consume a bounded body but never expose it. A malformed body is still
      // a refusal, and a non-404 never becomes absence proof.
      const rejected = await boundedBytes(response, controller.signal, { allowEmpty: true });
      rejected.fill(0);
      refuse(method === "DELETE"
        ? "CF_TEARDOWN_DELETE_OUTCOME_UNKNOWN"
        : "CF_TEARDOWN_PROVIDER_REFUSED");
    }
    const bytes = await boundedBytes(response, controller.signal);
    try {
      const bodySha256 = sha256(bytes);
      let body = null;
      if ((json || is404) && bytes.length > 0) {
        body = parseJsonBytes(bytes, response.headers.get("content-type"));
        if (tokenReflected(body, secret)) refuse("CF_TEARDOWN_TOKEN_RESPONSE_REFUSED");
        if (isSuccess) {
          if (workerDeleteSuccess) workerDeleteEnvelope(body);
          else envelope(body, { allowResultInfo });
        }
      }
      const missingCodeSha256 = is404 ? missingEnvelope(body, missingKind) : null;
      if (json && body === null) {
        refuse("CF_TEARDOWN_RESPONSE_INVALID");
      }
      return deepFreeze({
        status: response.status,
        missing: is404,
        body,
        bodySha256,
        missingCodeSha256,
      });
    } finally {
      bytes.fill(0);
    }
  } catch (error) {
    if (method === "DELETE" && dispatched) {
      if (error instanceof CloudflareDisposableTeardownProviderError &&
          error.code === "CF_TEARDOWN_DELETE_OUTCOME_UNKNOWN") {
        throw error;
      }
      refuse("CF_TEARDOWN_DELETE_OUTCOME_UNKNOWN");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function resultOf(response, { allowResultInfo = false } = {}) {
  return envelope(response.body, { allowResultInfo }).result;
}

function resultRows(result) {
  if (Array.isArray(result)) return result;
  refuse("CF_TEARDOWN_RESPONSE_INVALID");
}

function d1PaginationState(body, rows, page, entriesBefore, expected) {
  if (!Array.isArray(rows) || rows.length > PAGE_SIZE) {
    refuse("CF_TEARDOWN_PAGINATION_INVALID");
  }
  const info = body?.result_info;
  const allowed = ["count", "page", "per_page", "total_count"];
  if (info !== undefined && !plainObject(info)) {
    refuse("CF_TEARDOWN_PAGINATION_INVALID");
  }
  const keys = info === undefined ? null : Object.keys(info).sort();
  if (info !== undefined && (keys.some((key) => !allowed.includes(key)) ||
      Object.values(info).some((value) =>
        !Number.isSafeInteger(value) || value < 0) ||
      Object.hasOwn(info, "count") && info.count !== rows.length ||
      Object.hasOwn(info, "page") && info.page !== page ||
      Object.hasOwn(info, "per_page") && info.per_page !== PAGE_SIZE ||
      Object.hasOwn(info, "total_count") &&
        info.total_count > MAX_STORAGE_RESOURCES)) {
    refuse("CF_TEARDOWN_PAGINATION_INVALID");
  }
  const keyFingerprint = keys === null ? null : keys.join("\0");
  const totalCount = Object.hasOwn(info ?? {}, "total_count")
    ? info.total_count
    : null;
  if (expected && (expected.key_fingerprint !== keyFingerprint ||
      expected.total_count !== totalCount)) {
    refuse("CF_TEARDOWN_PAGINATION_INVALID");
  }
  const entriesAfter = entriesBefore + rows.length;
  let complete = rows.length < PAGE_SIZE;
  if (totalCount !== null) {
    if (entriesAfter > totalCount ||
        complete && entriesAfter !== totalCount) {
      refuse("CF_TEARDOWN_PAGINATION_INVALID");
    }
    complete = entriesAfter === totalCount;
  }
  return Object.freeze({
    key_fingerprint: keyFingerprint,
    total_count: totalCount,
    complete,
  });
}

async function pagedD1Rows(fetchImpl, token, accountId) {
  const all = [];
  const seenIds = new Set();
  const pageHashes = new Set();
  let expected = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await providerRequest(
      fetchImpl,
      token,
      apiUrl(accountId, "/d1/database", [
        ["page", String(page)],
        ["per_page", String(PAGE_SIZE)],
      ]),
      { allowResultInfo: true },
    );
    const rows = resultRows(resultOf(response, { allowResultInfo: true }));
    const pageHash = sha256(canonical(rows));
    if (rows.length > 0 && pageHashes.has(pageHash)) {
      refuse("CF_TEARDOWN_PAGINATION_INVALID");
    }
    pageHashes.add(pageHash);
    for (const row of rows) {
      const id = d1ListIdentity(row).id;
      if (seenIds.has(id)) refuse("CF_TEARDOWN_PAGINATION_INVALID");
      seenIds.add(id);
    }
    const state = d1PaginationState(
      response.body,
      rows,
      page,
      all.length,
      expected,
    );
    all.push(...rows);
    expected ||= state;
    if (state.complete) {
      if (state.total_count !== null && all.length !== state.total_count) {
        refuse("CF_TEARDOWN_PAGINATION_INVALID");
      }
      return all;
    }
  }
  refuse("CF_TEARDOWN_PAGINATION_INCOMPLETE");
}

async function pagedWorkerVersionRows(fetchImpl, token, target, workerName) {
  const rows = [];
  const seenIds = new Set();
  for (let page = 1; page <= Math.ceil(MAX_VERSIONS_PER_WORKER / PAGE_SIZE) + 1;
    page += 1) {
    const response = await providerRequest(
      fetchImpl,
      token,
      apiUrl(target.accountId, `/workers/scripts/${encoded(workerName)}/versions`, [
        ["page", String(page)],
        ["per_page", String(PAGE_SIZE)],
      ]),
    );
    const result = resultOf(response);
    if (!exactKeys(result, ["items"]) || !Array.isArray(result.items) ||
        result.items.length > PAGE_SIZE) {
      refuse("CF_TEARDOWN_RESPONSE_INVALID");
    }
    if (page > Math.ceil(MAX_VERSIONS_PER_WORKER / PAGE_SIZE) &&
        result.items.length > 0) {
      refuse("CF_TEARDOWN_INVENTORY_TOO_LARGE");
    }
    for (const row of result.items) {
      const id = versionId(row);
      if (seenIds.has(id)) refuse("CF_TEARDOWN_PAGINATION_INVALID");
      seenIds.add(id);
      rows.push(row);
    }
    if (result.items.length < PAGE_SIZE) return rows;
  }
  refuse("CF_TEARDOWN_PAGINATION_INCOMPLETE");
}

async function singleCompleteRows(fetchImpl, token, accountId, suffix, query = []) {
  const response = await providerRequest(
    fetchImpl,
    token,
    apiUrl(accountId, suffix, query),
  );
  return resultRows(resultOf(response));
}

function checkedDomainRows(rows, target) {
  for (const row of rows) {
    if (!plainObject(row) || row.service !== target.workerName) {
      refuse("CF_TEARDOWN_RESOURCE_MISMATCH");
    }
  }
  return rows;
}

function domainResultInfo(info, rows) {
  // This endpoint is SinglePage. Its count is for the requested service, but
  // total_count/total_pages describe the wider account and are informational.
  // Never turn those global values into an invented second filtered request.
  const allowed = new Set([
    "count", "page", "per_page", "total_count", "total_pages",
  ]);
  if (!plainObject(info) || Object.keys(info).some((key) => !allowed.has(key)) ||
      Object.keys(info).length === 0 ||
      Object.values(info).some((value) =>
        !Number.isSafeInteger(value) || value < 0) ||
      Object.hasOwn(info, "count") && info.count !== rows.length ||
      Object.hasOwn(info, "page") && info.page !== 1 ||
      Object.hasOwn(info, "per_page") &&
        (info.per_page < 1 || rows.length > info.per_page) ||
      Object.hasOwn(info, "total_count") &&
        info.total_count < rows.length ||
      Object.hasOwn(info, "total_pages") &&
        (!Object.hasOwn(info, "total_count") ||
         !Object.hasOwn(info, "per_page") ||
         info.total_pages !== Math.max(
           1,
           Math.ceil(info.total_count / info.per_page),
         )) ||
      Object.hasOwn(info, "total_count") &&
        Object.hasOwn(info, "per_page") &&
        Object.hasOwn(info, "page") &&
        rows.length > Math.min(
          info.per_page,
          Math.max(0, info.total_count - ((info.page - 1) * info.per_page)),
        )) {
    refuse("CF_TEARDOWN_PAGINATION_INVALID");
  }
  return true;
}

async function exactFilteredWorkerDomains(fetchImpl, token, target) {
  const response = await providerRequest(
    fetchImpl,
    token,
    apiUrl(target.accountId, "/workers/domains", [["service", target.workerName]]),
    { allowResultInfo: true },
  );
  const rows = checkedDomainRows(
    resultRows(resultOf(response, { allowResultInfo: true })),
    target,
  );
  const info = response.body.result_info;
  if (info === undefined) {
    // With the exact service filter, this endpoint also documents a complete
    // single-response form that omits result_info.
    return rows;
  }
  domainResultInfo(info, rows);
  return rows;
}

function versionId(row) {
  if (!plainObject(row) || Object.hasOwn(row, "version_id")) {
    refuse("CF_TEARDOWN_RESPONSE_INVALID");
  }
  const value = String(row?.id ?? "").toLowerCase();
  if (!UUID_RE.test(value)) refuse("CF_TEARDOWN_RESPONSE_INVALID");
  return value;
}

function bindingList(value) {
  if (!plainObject(value) || Object.hasOwn(value, "bindings") ||
      !plainObject(value.resources) ||
      !Object.hasOwn(value.resources, "bindings")) {
    refuse("CF_TEARDOWN_RESPONSE_INVALID");
  }
  const selected = value.resources.bindings;
  if (!Array.isArray(selected) || selected.length > 256) {
    refuse("CF_TEARDOWN_RESPONSE_INVALID");
  }
  return selected;
}

function bindingReference(binding, target) {
  if (!plainObject(binding) || typeof binding.type !== "string") {
    refuse("CF_TEARDOWN_RESPONSE_INVALID");
  }
  const type = binding.type;
  const normalizedType = type.toLowerCase();
  if (normalizedType !== type && [
    "service", "service_binding", "d1", "d1_database", "vectorize",
  ].includes(normalizedType)) {
    refuse("CF_TEARDOWN_RESPONSE_INVALID");
  }
  if (["service_binding", "d1_database"].includes(type)) {
    refuse("CF_TEARDOWN_RESPONSE_INVALID");
  }
  if (type === "service") {
    const service = binding.service;
    if (!Object.hasOwn(binding, "service") ||
        Object.hasOwn(binding, "service_name") ||
        Object.hasOwn(binding, "script_name") ||
        typeof service !== "string" || !service || service.length > 255 ||
        CONTROL_RE.test(service)) {
      refuse("CF_TEARDOWN_RESPONSE_INVALID");
    }
    return service === target.workerName ? "service" : null;
  }
  if (type === "d1") {
    if (!Object.hasOwn(binding, "id") ||
        Object.hasOwn(binding, "database_id") ||
        Object.hasOwn(binding, "uuid")) {
      refuse("CF_TEARDOWN_RESPONSE_INVALID");
    }
    const id = String(binding.id ?? "").toLowerCase();
    if (!UUID_RE.test(id)) refuse("CF_TEARDOWN_RESPONSE_INVALID");
    return id === target.databaseId ? "version" : null;
  }
  if (type === "vectorize") {
    if (!Object.hasOwn(binding, "index_name") ||
        Object.hasOwn(binding, "index") ||
        Object.hasOwn(binding, "vectorize_name") ||
        typeof binding.index_name !== "string" || !binding.index_name ||
        binding.index_name.length > 255 || CONTROL_RE.test(binding.index_name)) {
      refuse("CF_TEARDOWN_RESPONSE_INVALID");
    }
    return binding.index_name === target.vectorizeName ? "version" : null;
  }
  return null;
}

function tailConsumerNames(row) {
  if (row?.tail_consumers === undefined || row.tail_consumers === null) {
    refuse("CF_TEARDOWN_CUSTODY_UNPROVEN");
  }
  if (!Array.isArray(row.tail_consumers)) refuse("CF_TEARDOWN_RESPONSE_INVALID");
  return row.tail_consumers.map((entry) => {
    const name = plainObject(entry) ? entry.service : null;
    if (typeof name !== "string" || !name || name.length > 255 ||
        CONTROL_RE.test(name) || plainObject(entry) &&
        (Object.hasOwn(entry, "service_name") ||
         Object.hasOwn(entry, "script_name") || Object.hasOwn(entry, "name"))) {
      refuse("CF_TEARDOWN_RESPONSE_INVALID");
    }
    return name;
  });
}

async function listWorkerVersions(fetchImpl, token, target, workerName) {
  const rows = await pagedWorkerVersionRows(fetchImpl, token, target, workerName);
  if (rows.length > MAX_VERSIONS_PER_WORKER) refuse("CF_TEARDOWN_INVENTORY_TOO_LARGE");
  const ids = rows.map(versionId);
  if (new Set(ids).size !== ids.length) refuse("CF_TEARDOWN_RESPONSE_INVALID");
  const details = [];
  for (const id of ids) {
    const response = await providerRequest(
      fetchImpl,
      token,
      apiUrl(target.accountId,
        `/workers/scripts/${encoded(workerName)}/versions/${encoded(id)}`),
    );
    const value = resultOf(response);
    if (!plainObject(value) || versionId(value) !== id) {
      refuse("CF_TEARDOWN_RESPONSE_INVALID");
    }
    details.push({ id, value, bindings: bindingList(value) });
  }
  return details;
}

function scriptName(row) {
  if (!plainObject(row) || Object.hasOwn(row, "script_name")) {
    refuse("CF_TEARDOWN_RESPONSE_INVALID");
  }
  const name = row?.id;
  if (typeof name !== "string" || !name || name.length > 255 || CONTROL_RE.test(name)) {
    refuse("CF_TEARDOWN_RESPONSE_INVALID");
  }
  return name;
}

function routeCount(row) {
  if (row?.routes === undefined || row.routes === null) {
    refuse("CF_TEARDOWN_CUSTODY_UNPROVEN");
  }
  if (!Array.isArray(row.routes)) refuse("CF_TEARDOWN_RESPONSE_INVALID");
  return row.routes.length;
}

function checkedSchedules(value) {
  if (!plainObject(value) || !exactKeys(value, ["schedules"]) ||
      !Array.isArray(value.schedules) || value.schedules.length > MAX_SCHEDULES) {
    refuse("CF_TEARDOWN_RESPONSE_INVALID");
  }
  for (const schedule of value.schedules) {
    const allowed = new Set(["cron", "created_on", "modified_on"]);
    if (!plainObject(schedule) ||
        Object.keys(schedule).some((key) => !allowed.has(key)) ||
        !diagnosticText(schedule.cron, 256) ||
        Object.hasOwn(schedule, "created_on") &&
          !exactUtcRfc3339(schedule.created_on) ||
        Object.hasOwn(schedule, "modified_on") &&
          !exactUtcRfc3339(schedule.modified_on)) {
      refuse("CF_TEARDOWN_RESPONSE_INVALID");
    }
  }
  return value.schedules;
}

async function exactWorkerSchedules(fetchImpl, token, target, workerPresent) {
  const response = await providerRequest(
    fetchImpl,
    token,
    apiUrl(target.accountId,
      `/workers/scripts/${encoded(target.workerName)}/schedules`),
    { allow404: true, missingKind: "worker" },
  );
  if (response.missing) {
    if (workerPresent) refuse("CF_TEARDOWN_RESOURCE_MISMATCH");
    return deepFreeze({
      count: 0,
      exact_endpoint_status: 404,
      missing_code_sha256: response.missingCodeSha256,
      schedules_sha256: sha256(canonical([])),
    });
  }
  if (!workerPresent) refuse("CF_TEARDOWN_RESOURCE_MISMATCH");
  const schedules = checkedSchedules(resultOf(response));
  if (schedules.length !== 0) refuse("CF_TEARDOWN_CUSTODY_NOT_EMPTY");
  return deepFreeze({
    count: 0,
    exact_endpoint_status: 200,
    missing_code_sha256: null,
    schedules_sha256: sha256(canonical(schedules)),
  });
}

async function inspectInventory(fetchImpl, token, target) {
  const scripts = await singleCompleteRows(
    fetchImpl,
    token,
    target.accountId,
    "/workers/scripts",
  );
  if (scripts.length > MAX_WORKERS) refuse("CF_TEARDOWN_INVENTORY_TOO_LARGE");
  const names = scripts.map(scriptName);
  if (new Set(names).size !== names.length) refuse("CF_TEARDOWN_RESPONSE_INVALID");
  const selectedRows = scripts.filter((row) => scriptName(row) === target.workerName);
  if (selectedRows.length > 1) refuse("CF_TEARDOWN_RESOURCE_AMBIGUOUS");

  let versionsInspected = 0;
  let bindingsInspected = 0;
  let versionReferences = 0;
  let serviceBindings = 0;
  let tailConsumers = 0;
  let selectedVersionIdentity = [];
  const workerInventory = [];
  for (const row of scripts) {
    const name = scriptName(row);
    const listedRoutes = routeCount(row);
    const tails = tailConsumerNames(row);
    if (name === target.workerName && tails.length > 0) {
      refuse("CF_TEARDOWN_CUSTODY_NOT_EMPTY");
    }
    if (name !== target.workerName) {
      tailConsumers += tails.filter((entry) => entry === target.workerName).length;
    }
    const versions = await listWorkerVersions(fetchImpl, token, target, name);
    versionsInspected += versions.length;
    for (const version of versions) {
      bindingsInspected += version.bindings.length;
      if (name !== target.workerName) {
        for (const binding of version.bindings) {
          const reference = bindingReference(binding, target);
          if (reference === "service") serviceBindings += 1;
          if (reference === "version") versionReferences += 1;
        }
      }
    }
    if (name === target.workerName) {
      selectedVersionIdentity = versions.map(({ id, bindings }) => ({
        id,
        bindings_sha256: sha256(canonical(bindings)),
      }));
    }
    workerInventory.push({
      name,
      routes_count: listedRoutes,
      script_record_sha256: sha256(canonical(row)),
      versions: versions.map(({ id, bindings, value }) => ({
        id,
        version_record_sha256: sha256(canonical(value)),
        bindings_sha256: sha256(canonical(bindings)),
      })),
    });
  }

  const selected = selectedRows[0] || null;
  const [domains, workerSchedules] = await Promise.all([
    exactFilteredWorkerDomains(fetchImpl, token, target),
    exactWorkerSchedules(fetchImpl, token, target, Boolean(selected)),
  ]);
  const routes = selected ? routeCount(selected) : 0;
  if (routes !== 0 || domains.length !== 0 || versionReferences !== 0 ||
      serviceBindings !== 0 || tailConsumers !== 0) {
    refuse("CF_TEARDOWN_CUSTODY_NOT_EMPTY");
  }
  return deepFreeze({
    selected,
    selectedVersionIdentity,
    pagination_complete: true,
    workers_inspected: scripts.length,
    versions_inspected: versionsInspected,
    bindings_inspected: bindingsInspected,
    other_campaign_worker_inspected: names.includes(target.otherWorkerName),
    incoming_references: {
      version_references: versionReferences,
      service_bindings: serviceBindings,
      tail_consumers: tailConsumers,
    },
    routes,
    custom_domains: domains.length,
    worker_schedules: workerSchedules,
    inventory_sha256: sha256(canonical({
      workers: workerInventory.sort((left, right) => left.name.localeCompare(right.name)),
      custom_domains_sha256: sha256(canonical(domains)),
      worker_schedules: workerSchedules,
    })),
  });
}

function d1ListIdentity(row) {
  if (!plainObject(row) || Object.hasOwn(row, "id")) {
    refuse("CF_TEARDOWN_RESPONSE_INVALID");
  }
  const id = String(row.uuid ?? "").toLowerCase();
  if (!UUID_RE.test(id) || typeof row.name !== "string" || !row.name ||
      row.name.length > 255 || CONTROL_RE.test(row.name)) {
    refuse("CF_TEARDOWN_RESPONSE_INVALID");
  }
  return { id, name: row.name, record_sha256: sha256(canonical(row)) };
}

function vectorListIdentity(row) {
  if (!plainObject(row) || typeof row.name !== "string" || !row.name ||
      row.name.length > 255 || CONTROL_RE.test(row.name)) {
    refuse("CF_TEARDOWN_RESPONSE_INVALID");
  }
  return { name: row.name, record_sha256: sha256(canonical(row)) };
}

async function inspectStorageLists(fetchImpl, token, target) {
  const [databases, indexes] = await Promise.all([
    pagedD1Rows(fetchImpl, token, target.accountId),
    singleCompleteRows(
      fetchImpl,
      token,
      target.accountId,
      "/vectorize/v2/indexes",
    ),
  ]);
  if (databases.length > MAX_STORAGE_RESOURCES ||
      indexes.length > MAX_STORAGE_RESOURCES) {
    refuse("CF_TEARDOWN_INVENTORY_TOO_LARGE");
  }
  const d1Inventory = databases.map(d1ListIdentity).sort((left, right) =>
    left.id.localeCompare(right.id));
  const vectorInventory = indexes.map(vectorListIdentity).sort((left, right) =>
    left.name.localeCompare(right.name));
  if (new Set(d1Inventory.map((row) => row.id)).size !== d1Inventory.length ||
      new Set(vectorInventory.map((row) => row.name)).size !== vectorInventory.length) {
    refuse("CF_TEARDOWN_RESPONSE_INVALID");
  }
  const d1Matches = d1Inventory.filter((row) =>
    row.id === target.databaseId || row.name === target.databaseName);
  const vectorMatches = vectorInventory.filter((row) =>
    row.name === target.vectorizeName);
  if (d1Matches.length > 1 || vectorMatches.length > 1 ||
      d1Matches.length === 1 &&
        (d1Matches[0].id !== target.databaseId ||
         d1Matches[0].name !== target.databaseName) ||
      vectorMatches.length === 1 && vectorMatches[0].name !== target.vectorizeName) {
    refuse("CF_TEARDOWN_RESOURCE_AMBIGUOUS");
  }
  const d1InventorySha256 = sha256(canonical(d1Inventory));
  const vectorInventorySha256 = sha256(canonical(vectorInventory));
  return deepFreeze({
    pagination_complete: true,
    d1_entries_inspected: databases.length,
    vectorize_entries_inspected: indexes.length,
    d1_present: d1Matches.length === 1,
    vectorize_present: vectorMatches.length === 1,
    inventory_pass: {
      d1: {
        resource_kind: "d1",
        pagination_complete: true,
        entries_inspected: databases.length,
        matching_resources: d1Matches.length,
        inventory_sha256: d1InventorySha256,
      },
      vectorize: {
        resource_kind: "vectorize",
        pagination_complete: true,
        entries_inspected: indexes.length,
        matching_resources: vectorMatches.length,
        inventory_sha256: vectorInventorySha256,
      },
    },
    inventory_sha256: sha256(canonical({
      d1_inventory_sha256: d1InventorySha256,
      vectorize_inventory_sha256: vectorInventorySha256,
    })),
  });
}

async function exactWorker(fetchImpl, token, target) {
  return providerRequest(
    fetchImpl,
    token,
    apiUrl(target.accountId, `/workers/workers/${encoded(target.workerId)}`),
    { allow404: true, missingKind: "worker" },
  );
}

async function exactD1(fetchImpl, token, target) {
  return providerRequest(
    fetchImpl,
    token,
    apiUrl(target.accountId, `/d1/database/${encoded(target.databaseId)}`,
      [["fields", "uuid,name"]]),
    { allow404: true, missingKind: "d1" },
  );
}

async function exactVectorize(fetchImpl, token, target) {
  return providerRequest(
    fetchImpl,
    token,
    apiUrl(target.accountId, `/vectorize/v2/indexes/${encoded(target.vectorizeName)}`),
    { allow404: true, missingKind: "vectorize" },
  );
}

function checkedD1(value, target) {
  const result = resultOf(value);
  const id = String(result?.uuid ?? "").toLowerCase();
  if (!plainObject(result) || Object.hasOwn(result, "id") ||
      !UUID_RE.test(id) ||
      typeof result.name !== "string" || !result.name ||
      result.name.length > 255 || CONTROL_RE.test(result.name)) {
    refuse("CF_TEARDOWN_RESPONSE_INVALID");
  }
  if (id !== target.databaseId || result.name !== target.databaseName) {
    refuse("CF_TEARDOWN_RESOURCE_MISMATCH");
  }
  return {
    uuid: target.databaseId,
    name: target.databaseName,
  };
}

function checkedWorkerReferences(value) {
  const fields = [
    "dispatch_namespace_outbounds", "domains", "durable_objects", "queues",
    "workers",
  ];
  if (!exactKeys(value, fields) ||
      fields.some((field) => !Array.isArray(value[field]) || value[field].length !== 0)) {
    refuse("CF_TEARDOWN_RESOURCE_MISMATCH");
  }
  return value;
}

function checkedWorker(value, target) {
  const result = resultOf(value);
  if (!plainObject(result) ||
      String(result.id ?? "").toLowerCase() !== target.workerId ||
      result.name !== target.workerName ||
      typeof result.deployed_on !== "string" ||
      !Number.isFinite(Date.parse(result.deployed_on)) ||
      !Array.isArray(result.tail_consumers) || result.tail_consumers.length !== 0) {
    refuse("CF_TEARDOWN_RESOURCE_MISMATCH");
  }
  const references = checkedWorkerReferences(result.references);
  return {
    id: target.workerId,
    name: target.workerName,
    deployed_on: result.deployed_on,
    references_sha256: sha256(canonical(references)),
    tail_consumers_sha256: sha256(canonical(result.tail_consumers)),
    subdomain_sha256: sha256(canonical(result.subdomain ?? null)),
  };
}

function checkedVectorize(value, target) {
  const result = resultOf(value);
  if (!plainObject(result) || result.name !== target.vectorizeName ||
      !plainObject(result.config) || result.config.dimensions !== 768 ||
      result.config.metric !== "cosine" || !exactUtcRfc3339(result.created_on) ||
      result.created_on !== target.vectorizeCreatedOn) {
    refuse("CF_TEARDOWN_RESOURCE_MISMATCH");
  }
  return {
    name: target.vectorizeName,
    created_on: result.created_on,
    config: { dimensions: 768, metric: "cosine" },
  };
}

async function snapshotOnce(fetchImpl, token, request) {
  const { target } = request;
  const [worker, d1, vectorize, inventory, storageLists] = await Promise.all([
    exactWorker(fetchImpl, token, target),
    exactD1(fetchImpl, token, target),
    exactVectorize(fetchImpl, token, target),
    inspectInventory(fetchImpl, token, target),
    inspectStorageLists(fetchImpl, token, target),
  ]);
  if (worker.missing !== !inventory.selected) {
    refuse("CF_TEARDOWN_RESOURCE_MISMATCH");
  }
  if (d1.missing === storageLists.d1_present ||
      vectorize.missing === storageLists.vectorize_present) {
    refuse("CF_TEARDOWN_RESOURCE_MISMATCH");
  }
  const states = {
    worker: worker.missing ? "absent" : "present",
    vectorize: vectorize.missing ? "absent" : "present",
    d1: d1.missing ? "absent" : "present",
  };
  const accountFingerprint = sha256(canonical({
    kind: "cloudflare_account",
    account_id: target.accountId,
  }));
  const exactWorkerIdentity = worker.missing ? null : checkedWorker(worker, target);
  const workerIdentity = worker.missing ? null : {
    ...exactWorkerIdentity,
    script_record_sha256: sha256(canonical(inventory.selected)),
    versions: inventory.selectedVersionIdentity,
  };
  const d1Identity = d1.missing ? null : checkedD1(d1, target);
  const vectorIdentity = vectorize.missing ? null : checkedVectorize(vectorize, target);
  const instances = {
    worker: workerIdentity ? sha256(canonical({
      account_fingerprint: accountFingerprint,
      kind: "worker",
      identity: workerIdentity,
    })) : null,
    vectorize: vectorIdentity ? sha256(canonical({
      account_fingerprint: accountFingerprint,
      kind: "vectorize",
      identity: vectorIdentity,
    })) : null,
    d1: d1Identity ? sha256(canonical({
      account_fingerprint: accountFingerprint,
      kind: "d1",
      identity: d1Identity,
    })) : null,
  };
  const endpointStatuses = {
    worker: worker.status,
    vectorize: vectorize.status,
    d1: d1.status,
  };
  const missingCodeSha256 = {
    worker: worker.missingCodeSha256,
    vectorize: vectorize.missingCodeSha256,
    d1: d1.missingCodeSha256,
  };
  const absenceAuthority = {
    worker: worker.missing ? "exact_id_404_code_10007" : "present",
    vectorize: vectorize.missing
      ? "two_stable_exhaustive_account_inventories"
      : "present",
    d1: d1.missing ? "two_stable_exhaustive_account_inventories" : "present",
  };
  const base = {
    schema_version: 1,
    operation: "preview",
    role: request.role,
    account_fingerprint: accountFingerprint,
    target_fingerprint: sha256(canonical({
      role: request.role,
      account_id: target.accountId,
      worker_id: target.workerId,
      worker_name: target.workerName,
      database_id: target.databaseId,
      vectorize_name: target.vectorizeName,
      vectorize_created_on: target.vectorizeCreatedOn,
    })),
    maintenance_window_sha256: sha256(canonical(request.maintenanceWindow)),
    states,
    instance_fingerprints: instances,
    exact_endpoint_statuses: endpointStatuses,
    exact_endpoint_missing_code_sha256: missingCodeSha256,
    absence_authority: absenceAuthority,
    custody: {
      pagination_complete: inventory.pagination_complete,
      workers_inspected: inventory.workers_inspected,
      versions_inspected: inventory.versions_inspected,
      bindings_inspected: inventory.bindings_inspected,
      d1_entries_inspected: storageLists.d1_entries_inspected,
      vectorize_entries_inspected: storageLists.vectorize_entries_inspected,
      other_campaign_worker_inspected: inventory.other_campaign_worker_inspected,
      incoming_references: inventory.incoming_references,
      routes: inventory.routes,
      custom_domains: inventory.custom_domains,
      worker_schedules: inventory.worker_schedules,
      storage_inventory_passes: {
        d1: [storageLists.inventory_pass.d1],
        vectorize: [storageLists.inventory_pass.vectorize],
      },
      inventory_sha256: sha256(canonical({
        workers: inventory.inventory_sha256,
        storage: storageLists.inventory_sha256,
      })),
    },
  };
  return deepFreeze({ ...base, snapshot_sha256: sha256(canonical(base)) });
}


async function snapshot(fetchImpl, token, request) {
  // A single concurrent account walk can combine observations from different
  // moments. Two complete, sequentially identical captures are the admission
  // boundary for preview and every pre-delete identity check.
  const opening = await snapshotOnce(fetchImpl, token, request);
  const closing = await snapshotOnce(fetchImpl, token, request);
  if (canonical(opening) !== canonical(closing)) {
    refuse("CF_TEARDOWN_SNAPSHOT_CHANGED");
  }
  const base = {
    ...opening,
    custody: {
      ...opening.custody,
      storage_inventory_passes: {
        d1: [
          opening.custody.storage_inventory_passes.d1[0],
          closing.custody.storage_inventory_passes.d1[0],
        ],
        vectorize: [
          opening.custody.storage_inventory_passes.vectorize[0],
          closing.custody.storage_inventory_passes.vectorize[0],
        ],
      },
    },
  };
  delete base.snapshot_sha256;
  base.custody.inventory_sha256 = sha256(canonical({
    opening_inventory_sha256: opening.custody.inventory_sha256,
    storage_inventory_passes: base.custody.storage_inventory_passes,
  }));
  return deepFreeze({ ...base, snapshot_sha256: sha256(canonical(base)) });
}

function resourceUrl(request) {
  const { target, kind } = request;
  if (kind === "worker") {
    return apiUrl(target.accountId, `/workers/workers/${encoded(target.workerId)}`);
  }
  if (kind === "vectorize") {
    return apiUrl(target.accountId,
      `/vectorize/v2/indexes/${encoded(target.vectorizeName)}`);
  }
  if (kind === "d1") {
    return apiUrl(target.accountId, `/d1/database/${encoded(target.databaseId)}`);
  }
  refuse("CF_TEARDOWN_REQUEST_INVALID");
}

async function reconcile(fetchImpl, token, request) {
  const current = await snapshot(fetchImpl, token, request);
  if (current.states[request.kind] === "absent") {
    return deepFreeze({
      schema_version: 1,
      operation: "reconcile",
      role: request.role,
      kind: request.kind,
      expected_instance_fingerprint: request.expectedInstanceFingerprint,
      maintenance_window_sha256: sha256(canonical(request.maintenanceWindow)),
      exact_endpoint_status: 404,
      missing_code_sha256:
        current.exact_endpoint_missing_code_sha256[request.kind],
      absence_authority: current.absence_authority[request.kind],
      absent: true,
      current_instance_fingerprint: null,
    });
  }
  const fingerprint = current.instance_fingerprints[request.kind];
  if (fingerprint !== request.expectedInstanceFingerprint) {
    refuse("CF_TEARDOWN_RESOURCE_REPLACED");
  }
  return deepFreeze({
    schema_version: 1,
    operation: "reconcile",
    role: request.role,
    kind: request.kind,
    expected_instance_fingerprint: request.expectedInstanceFingerprint,
    maintenance_window_sha256: sha256(canonical(request.maintenanceWindow)),
    exact_endpoint_status: 200,
    missing_code_sha256: null,
    absence_authority: "present",
    absent: false,
    current_instance_fingerprint: fingerprint,
  });
}

async function remove(fetchImpl, token, request) {
  const current = await snapshot(fetchImpl, token, request);
  if (current.states[request.kind] !== "present" ||
      current.instance_fingerprints[request.kind] !==
        request.expectedInstanceFingerprint) {
    refuse("CF_TEARDOWN_RESOURCE_REPLACED");
  }
  if (request.kind === "vectorize") {
    // Vectorize DELETE is name-only and Cloudflare exposes no conditional
    // delete. The caller-attested single-operator maintenance window is the
    // residual race control; this final exact read makes the provisioned
    // created_on identity the last provider observation before dispatch.
    const exact = await exactVectorize(fetchImpl, token, request.target);
    if (exact.missing) refuse("CF_TEARDOWN_RESOURCE_REPLACED");
    const identity = checkedVectorize(exact, request.target);
    const accountFingerprint = sha256(canonical({
      kind: "cloudflare_account",
      account_id: request.target.accountId,
    }));
    const immediateFingerprint = sha256(canonical({
      account_fingerprint: accountFingerprint,
      kind: "vectorize",
      identity,
    }));
    if (immediateFingerprint !== request.expectedInstanceFingerprint) {
      refuse("CF_TEARDOWN_RESOURCE_REPLACED");
    }
  }
  const response = await providerRequest(fetchImpl, token, resourceUrl(request), {
    method: "DELETE",
    json: true,
    workerDeleteSuccess: request.kind === "worker",
  });
  if (response.status !== 200 || response.body === null) {
    refuse("CF_TEARDOWN_DELETE_OUTCOME_UNKNOWN");
  }
  return deepFreeze({
    schema_version: 1,
    operation: "delete",
    role: request.role,
    kind: request.kind,
    expected_instance_fingerprint: request.expectedInstanceFingerprint,
    maintenance_window_sha256: sha256(canonical(request.maintenanceWindow)),
    accepted: true,
    response_status: response.status,
    response_body_sha256: response.bodySha256,
  });
}

export async function executeDisposableTeardownProvider(requestInput, {
  fetchImpl = globalThis.fetch,
  token,
} = {}) {
  const request = validateDisposableTeardownProviderRequest(requestInput);
  if (typeof fetchImpl !== "function" || !Buffer.isBuffer(token)) {
    refuse("CF_TEARDOWN_DEPENDENCY_INVALID");
  }
  if (request.operation === "preview") return snapshot(fetchImpl, token, request);
  if (request.operation === "reconcile") return reconcile(fetchImpl, token, request);
  return remove(fetchImpl, token, request);
}

function readBoundedDescriptor(fd, maximum, code) {
  let bytes;
  try { bytes = readFileSync(fd); } catch { refuse(code); }
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > maximum) {
    bytes?.fill?.(0);
    refuse(code);
  }
  return bytes;
}

function sanitizedFailure(error) {
  const code = error instanceof CloudflareDisposableTeardownProviderError &&
    /^CF_TEARDOWN_[A-Z0-9_]+$/u.test(error.code || "")
    ? error.code
    : "CF_TEARDOWN_UNEXPECTED_FAILURE";
  return { schema_version: 1, ok: false, code };
}

export async function runDisposableTeardownProviderChild({
  stdinFd = 0,
  requestFd = 3,
  stdout = (line) => process.stdout.write(line),
  fetchImpl = globalThis.fetch,
} = {}) {
  let token;
  let requestBytes;
  try {
    token = readBoundedDescriptor(stdinFd, MAX_TOKEN_BYTES, "CF_TEARDOWN_TOKEN_INVALID");
    requestBytes = readBoundedDescriptor(
      requestFd,
      MAX_REQUEST_BYTES,
      "CF_TEARDOWN_REQUEST_INVALID",
    );
    let request;
    try { request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(requestBytes)); }
    catch { refuse("CF_TEARDOWN_REQUEST_INVALID"); }
    const result = await executeDisposableTeardownProvider(request, { fetchImpl, token });
    stdout(`${JSON.stringify({ schema_version: 1, ok: true, result })}\n`);
    return 0;
  } catch (error) {
    stdout(`${JSON.stringify(sanitizedFailure(error))}\n`);
    return 1;
  } finally {
    token?.fill?.(0);
    requestBytes?.fill?.(0);
  }
}

if (process.argv.includes(CHILD_FLAG)) {
  process.exitCode = await runDisposableTeardownProviderChild();
}
