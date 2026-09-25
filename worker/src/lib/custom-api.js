/**
 * Declarative, Worker-hosted JSON API source.
 *
 * The manifest is compiled into the CUSTOM_API_CONFIG plain-text binding. The
 * bearer value remains a separately named Worker secret and is looked up only
 * for the duration of a pull. Provider response bodies and raw errors never
 * enter logs or lifecycle receipts.
 */

import { scan as scanSecrets } from "./secret-scan.js";
import { restampFirstPartySourceProvenance } from "./provenance-receipt.js";
import { backendOf, D1, storeFor } from "./store.js";
import { ingestEnvelopeValidationError } from "./ingest-envelope.js";
import { forget } from "./store-d1.js";
import {
  currentCustomApiDocumentSql, customApiVersionedSourceId,
} from "./custom-api-visibility.js";

const SAFE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SAFE_SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
const RESERVED_SECRET_NAME = /^(?:(?:ADMIN_KEY|AI|DB|VECTORIZE|R2|CUSTOM_API_CONFIG)$|(?:BRAIN|BANK|GOOGLE|ZOOM|PROVIDER)_)/;
const SAFE_FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ALLOWED_CONFIG_KEYS = new Set([
  "_comment", "enabled", "display_name", "source", "base_url", "token_secret",
  "cadence_seconds", "timeout_ms", "max_response_bytes", "max_rows",
  "max_pages", "retries", "endpoints",
]);
const ALLOWED_ENDPOINT_KEYS = new Set([
  "name", "path", "row_key", "legacy_row_key", "document", "documents",
]);
const ALLOWED_DOCUMENT_KEYS = new Set([
  "name", "group_by", "title_template", "body_template", "aggregates", "formats",
  "fields", "expected_values",
]);
const ALLOWED_AGGREGATES = new Set(["sum", "min", "max"]);
const ALLOWED_FORMATS = new Set(["currency", "number", "integer", "text"]);
const ALLOWED_ENVELOPE_KEYS = new Set(["data", "next", "next_page", "pagination", "has_more"]);
const ALLOWED_PAGINATION_KEYS = new Set(["next"]);

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_ROWS = 10_000;
const DEFAULT_MAX_PAGES = 20;
const DEFAULT_RETRIES = 3;
const ROW_CHUNK_SIZE = 50;
const ROW_CHUNK_MAX_BYTES = 64 * 1024;
const MAX_JOB_STAGE_STATEMENTS = 500;
const ROW_GC_SLICE_SIZE = 25;
const DOCUMENT_GC_SLICE_SIZE = 25;

const isPlainObject = (value) => value !== null && typeof value === "object" &&
  !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function unexpectedKey(value, allowed) {
  return Object.keys(value).find((key) => !allowed.has(key));
}

function boundedInteger(value, fallback, min, max, label) {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(candidate) || candidate < min || candidate > max) {
    throw new TypeError(`${label} must be an integer from ${min} through ${max}`);
  }
  return candidate;
}

function fieldList(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) ||
      value.some((field) => typeof field !== "string" || !SAFE_FIELD.test(field)) ||
      new Set(value).size !== value.length) {
    throw new TypeError(`${label} must be ${allowEmpty ? "a" : "a non-empty"} unique field-name array`);
  }
  return [...value];
}

function safeTemplate(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 8_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${label} must be non-empty plain text of at most 8000 characters`);
  }
  return value;
}

function normalizeDocument(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be an object`);
  const extra = unexpectedKey(value, ALLOWED_DOCUMENT_KEYS);
  if (extra) throw new TypeError(`${label}.${extra} is not supported`);
  const aggregates = value.aggregates ?? {};
  const formats = value.formats ?? {};
  if (!isPlainObject(aggregates) || Object.entries(aggregates).some(([field, operation]) =>
    !SAFE_FIELD.test(field) || !ALLOWED_AGGREGATES.has(operation))) {
    throw new TypeError(`${label}.aggregates contains an unsupported field or operation`);
  }
  if (!isPlainObject(formats) || Object.entries(formats).some(([field, format]) =>
    !SAFE_FIELD.test(field) || !ALLOWED_FORMATS.has(format))) {
    throw new TypeError(`${label}.formats contains an unsupported field or format`);
  }
  const fields = fieldList(value.fields, `${label}.fields`);
  const expectedValues = value.expected_values ?? {};
  if (!isPlainObject(expectedValues) || Object.entries(expectedValues).some(([field, values]) =>
    !SAFE_FIELD.test(field) || !Array.isArray(values) || values.length < 1 || values.length > 50 ||
    new Set(values).size !== values.length || values.some((item) =>
      typeof item !== "string" || !item || item.length > 120 || /[\u0000-\u001f\u007f]/.test(item)))) {
    throw new TypeError(`${label}.expected_values must map fields to unique bounded string arrays`);
  }
  return Object.freeze({
    name: value.name == null ? null : (() => {
      const name = String(value.name);
      if (!SAFE_NAME.test(name)) throw new TypeError(`${label}.name is invalid`);
      return name;
    })(),
    group_by: fieldList(value.group_by ?? [], `${label}.group_by`, { allowEmpty: true }),
    title_template: safeTemplate(value.title_template, `${label}.title_template`),
    body_template: safeTemplate(value.body_template, `${label}.body_template`),
    aggregates: Object.freeze({ ...aggregates }),
    formats: Object.freeze({ ...formats }),
    fields: Object.freeze(fields),
    expected_values: Object.freeze(Object.fromEntries(
      Object.entries(expectedValues).map(([field, values]) => [field, Object.freeze([...values])]),
    )),
  });
}

export function validateCustomApiConfig(value) {
  if (!isPlainObject(value)) throw new TypeError("custom_api must be an object");
  const extra = unexpectedKey(value, ALLOWED_CONFIG_KEYS);
  if (extra) throw new TypeError(`custom_api.${extra} is not supported`);
  if (value.enabled !== true) throw new TypeError("custom_api.enabled must be true");
  const source = String(value.source || "");
  if (!SAFE_NAME.test(source)) throw new TypeError("custom_api.source is invalid");
  const tokenSecret = String(value.token_secret || "");
  if (!SAFE_SECRET_NAME.test(tokenSecret) || RESERVED_SECRET_NAME.test(tokenSecret)) {
    throw new TypeError("custom_api.token_secret must name a dedicated uppercase Worker secret");
  }
  let base;
  try {
    base = new URL(String(value.base_url || ""));
  } catch {
    throw new TypeError("custom_api.base_url must be an HTTPS URL");
  }
  if (base.protocol !== "https:" || base.username || base.password || base.port || base.search || base.hash) {
    throw new TypeError("custom_api.base_url must be one HTTPS origin and path with no credentials, port, query, or fragment");
  }
  base.pathname = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  if (!Array.isArray(value.endpoints) || value.endpoints.length < 1 || value.endpoints.length > 20) {
    throw new TypeError("custom_api.endpoints must contain 1 through 20 endpoints");
  }
  const endpointNames = new Set();
  const endpoints = value.endpoints.map((endpoint, index) => {
    const label = `custom_api.endpoints[${index}]`;
    if (!isPlainObject(endpoint)) throw new TypeError(`${label} must be an object`);
    const endpointExtra = unexpectedKey(endpoint, ALLOWED_ENDPOINT_KEYS);
    if (endpointExtra) throw new TypeError(`${label}.${endpointExtra} is not supported`);
    const name = String(endpoint.name || "");
    if (!SAFE_NAME.test(name) || endpointNames.has(name)) throw new TypeError(`${label}.name is invalid or duplicated`);
    endpointNames.add(name);
    const path = String(endpoint.path || "");
    if (!/^\/[A-Za-z0-9][A-Za-z0-9/_-]*$/.test(path) || path.includes("..") || path.includes("//")) {
      throw new TypeError(`${label}.path must be one absolute-looking path with no query or traversal`);
    }
    const rawDocuments = endpoint.documents ?? (endpoint.document ? [endpoint.document] : null);
    if (!Array.isArray(rawDocuments) || rawDocuments.length < 1 || rawDocuments.length > 4) {
      throw new TypeError(`${label} must declare document or 1 through 4 documents`);
    }
    if (endpoint.document !== undefined && endpoint.documents !== undefined) {
      throw new TypeError(`${label} cannot declare both document and documents`);
    }
    const documents = rawDocuments.map((document, documentIndex) =>
      normalizeDocument(document, `${label}.${endpoint.documents ? `documents[${documentIndex}]` : "document"}`));
    if (documents.length > 1 && (documents.some((document) => !document.name) ||
        new Set(documents.map((document) => document.name)).size !== documents.length)) {
      throw new TypeError(`${label}.documents must have unique names when more than one document layout is declared`);
    }
    return Object.freeze({
      name,
      path,
      row_key: fieldList(endpoint.row_key, `${label}.row_key`),
      legacy_row_key: endpoint.legacy_row_key == null
        ? null
        : fieldList(endpoint.legacy_row_key, `${label}.legacy_row_key`),
      documents: Object.freeze(documents),
    });
  });
  return Object.freeze({
    enabled: true,
    display_name: String(value.display_name || "custom business API").replace(/\s+/g, " ").trim().slice(0, 80) || "custom business API",
    source,
    base_url: base.href,
    token_secret: tokenSecret,
    cadence_seconds: boundedInteger(value.cadence_seconds, 86400, 3600, 31 * 86400, "custom_api.cadence_seconds"),
    timeout_ms: boundedInteger(value.timeout_ms, DEFAULT_TIMEOUT_MS, 250, 60_000, "custom_api.timeout_ms"),
    max_response_bytes: boundedInteger(value.max_response_bytes, DEFAULT_MAX_RESPONSE_BYTES, 1024, 10 * 1024 * 1024, "custom_api.max_response_bytes"),
    max_rows: boundedInteger(value.max_rows, DEFAULT_MAX_ROWS, 1, 10_000, "custom_api.max_rows"),
    max_pages: boundedInteger(value.max_pages, DEFAULT_MAX_PAGES, 1, 100, "custom_api.max_pages"),
    retries: boundedInteger(value.retries, DEFAULT_RETRIES, 1, 5, "custom_api.retries"),
    endpoints: Object.freeze(endpoints),
  });
}

export class CustomApiError extends Error {
  constructor(code, message, { endpoint = null, status = null, retryable = false, refusalReason = null } = {}) {
    super(message);
    this.name = "CustomApiError";
    this.code = code;
    this.endpoint = endpoint;
    this.status = status;
    this.retryable = retryable;
    this.refusalReason = refusalReason;
  }
}

export function customApiOwnerMessage(code, displayName = "store dashboard") {
  const name = String(displayName || "store dashboard").replace(/\s+/g, " ").trim().slice(0, 80) || "store dashboard";
  if (code === "AUTH_REQUIRED") return `The ${name} refused the key. Ask its developer to check it.`;
  if (code === "RATE_LIMITED") return `The ${name} asked the Brain to wait. It will try again on the next scheduled pull.`;
  if (code === "REMOTE_UNAVAILABLE" || code === "NETWORK_UNREACHABLE") return `The ${name} could not be reached. The saved data was left unchanged.`;
  if (code === "RESPONSE_TOO_LARGE") return `The ${name} returned more data than this source allows. That endpoint was left unchanged. Ask its developer to add paging or narrow the endpoint.`;
  if (code === "REDIRECT_REFUSED") return `The ${name} tried to send the Brain to another address. The pull was refused before following it.`;
  if (code === "PERSISTENCE_VERIFY_FAILED") return `The Brain could not verify the saved ${name} update. The source remains marked for installer review.`;
  if (code === "CONFIG_INVALID") return `The ${name} setup is not valid. Ask the installer to review its manifest mapping.`;
  return `The ${name} returned data the Brain could not safely understand. The saved data was left unchanged.`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function endpointUrl(config, endpoint) {
  return new URL(endpoint.path.replace(/^\//, ""), config.base_url);
}

function assertAllowedUrl(url, config, endpoint) {
  const base = new URL(config.base_url);
  if (url.protocol !== "https:" || url.origin !== base.origin || !url.pathname.startsWith(base.pathname) ||
      url.username || url.password || url.hash) {
    throw new CustomApiError("REDIRECT_REFUSED", "custom API paging left the configured HTTPS boundary", { endpoint: endpoint.name });
  }
}

async function boundedJson(response, config, endpoint) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > config.max_response_bytes) {
    throw new CustomApiError("RESPONSE_TOO_LARGE", "custom API response exceeded its configured byte limit", { endpoint: endpoint.name });
  }
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    throw new CustomApiError("INVALID_RESPONSE", "custom API response was not JSON", { endpoint: endpoint.name });
  }
  if (!response.body?.getReader) {
    throw new CustomApiError("INVALID_RESPONSE", "custom API response could not be read safely", { endpoint: endpoint.name });
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > config.max_response_bytes) {
        await reader.cancel().catch(() => {});
        throw new CustomApiError("RESPONSE_TOO_LARGE", "custom API response exceeded its configured byte limit", { endpoint: endpoint.name });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)), bytes };
  } catch {
    throw new CustomApiError("INVALID_RESPONSE", "custom API returned malformed JSON", { endpoint: endpoint.name });
  }
}

function pageShape(value, currentUrl, config, endpoint) {
  if (Array.isArray(value)) return { rows: value, next: null };
  if (!isPlainObject(value)) {
    throw new CustomApiError("INVALID_RESPONSE", "custom API response was neither an array nor a data envelope", { endpoint: endpoint.name });
  }
  const extra = unexpectedKey(value, ALLOWED_ENVELOPE_KEYS);
  if (extra || !Array.isArray(value.data)) {
    throw new CustomApiError("INVALID_RESPONSE", "custom API data envelope was not recognized", { endpoint: endpoint.name });
  }
  if (value.pagination !== undefined && (!isPlainObject(value.pagination) || unexpectedKey(value.pagination, ALLOWED_PAGINATION_KEYS))) {
    throw new CustomApiError("INVALID_RESPONSE", "custom API pagination envelope was not recognized", { endpoint: endpoint.name });
  }
  if (value.has_more !== undefined && typeof value.has_more !== "boolean") {
    throw new CustomApiError("INVALID_RESPONSE", "custom API has_more value was not boolean", { endpoint: endpoint.name });
  }
  const candidates = [value.next, value.next_page, value.pagination?.next]
    .filter((candidate) => candidate !== undefined && candidate !== null && candidate !== false && candidate !== "");
  if (candidates.length > 1) {
    throw new CustomApiError("INVALID_RESPONSE", "custom API response supplied conflicting paging values", { endpoint: endpoint.name });
  }
  if (value.has_more === true && candidates.length === 0) {
    throw new CustomApiError("INVALID_RESPONSE", "custom API said more data exists without a next page", { endpoint: endpoint.name });
  }
  if (candidates.length === 0) return { rows: value.data, next: null };
  const candidate = candidates[0];
  let next;
  if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0) {
    next = new URL(currentUrl.href);
    next.searchParams.set("page", String(candidate));
  } else if (typeof candidate === "string" && candidate.length <= 2_000) {
    next = new URL(candidate, currentUrl);
  } else {
    throw new CustomApiError("INVALID_RESPONSE", "custom API next page was not recognized", { endpoint: endpoint.name });
  }
  assertAllowedUrl(next, config, endpoint);
  return { rows: value.data, next };
}

function normalizeRow(value, endpoint, token) {
  if (!isPlainObject(value) || Object.keys(value).length === 0 || Object.keys(value).length > 100) {
    throw new CustomApiError("INVALID_RESPONSE", "custom API row was not a bounded object", { endpoint: endpoint.name });
  }
  const row = {};
  for (const [field, item] of Object.entries(value)) {
    if (!SAFE_FIELD.test(field) || (item !== null && !["string", "number", "boolean"].includes(typeof item)) ||
        (typeof item === "number" && !Number.isFinite(item)) ||
        (typeof item === "string" && (item.length > 8_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(item)))) {
      throw new CustomApiError("INVALID_RESPONSE", "custom API row contained an unsupported field or value", { endpoint: endpoint.name });
    }
    row[field] = item;
  }
  const serialized = canonicalJson(row);
  if ((token && serialized.includes(token)) || scanSecrets(serialized).shouldRefuse) {
    throw new CustomApiError("SECRET_IN_RESPONSE", "custom API response was held by the credential scanner", { endpoint: endpoint.name });
  }
  return row;
}

function hasKeyFields(row, fields) {
  return fields.every((field) => Object.hasOwn(row, field) && row[field] !== "");
}

function validateKnownRow(row, endpoint) {
  const currencyIsValid = (value) => {
    const cents = typeof value === "number" ? value * 100 : Number.NaN;
    const tolerance = Number.EPSILON * Math.max(1, Math.abs(cents)) * 8;
    return Number.isFinite(cents) && Math.abs(cents - Math.round(cents)) <= tolerance;
  };
  const refuse = (reason, message) => {
    throw new CustomApiError("ROW_REFUSED", message, { endpoint: endpoint.name, refusalReason: reason });
  };
  if (endpoint.name === "sales") {
    if (typeof row.period !== "string" || !/^\d{4}-(?:0[1-9]|1[0-2])-01$/.test(row.period)) {
      refuse("invalid_period", "custom API sales row had an invalid monthly period");
    }
    if (!currencyIsValid(row.net_sales)) refuse("invalid_net_sales", "custom API sales row had missing or invalid net_sales");
    for (const field of ["transactions", "units", "puppies_sold"]) {
      if (Object.hasOwn(row, field) && (!Number.isSafeInteger(row[field]))) {
        refuse(`invalid_${field}`, `custom API sales row had invalid ${field}`);
      }
    }
    return;
  }
  if (endpoint.name === "inventory") {
    if (!Number.isSafeInteger(row.count)) refuse("invalid_inventory_count", "custom API inventory row had missing or invalid count");
    return;
  }
  if (endpoint.name === "costs") {
    if (!currencyIsValid(row.avg_cost)) refuse("invalid_avg_cost", "custom API cost row had missing or invalid avg_cost");
    if (Object.hasOwn(row, "received") && !Number.isSafeInteger(row.received)) {
      refuse("invalid_received", "custom API cost row had invalid received");
    }
  }
}

function rowIdentity(row, endpoint) {
  const fields = hasKeyFields(row, endpoint.row_key)
    ? endpoint.row_key
    : endpoint.legacy_row_key && hasKeyFields(row, endpoint.legacy_row_key)
      ? endpoint.legacy_row_key
      : null;
  if (!fields) {
    throw new CustomApiError("INVALID_ROW_KEY", "custom API row did not contain its declared identity", { endpoint: endpoint.name });
  }
  return fields.map((field) => `${field}=${JSON.stringify(row[field])}`).join("|");
}

async function fetchPage(url, config, endpoint, token, { fetchImpl, sleep }) {
  for (let attempt = 1; attempt <= config.retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeout_ms);
    let response;
    try {
      response = await fetchImpl(url.href, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      if (attempt < config.retries) {
        await sleep(250 * (2 ** (attempt - 1)));
        continue;
      }
      throw new CustomApiError("NETWORK_UNREACHABLE", "custom API request did not complete", { endpoint: endpoint.name, retryable: true });
    }
    if (response.status >= 300 && response.status < 400) {
      clearTimeout(timer);
      await response.body?.cancel().catch(() => {});
      if (response.status === 308) {
        throw new CustomApiError("CONFIG_INVALID", "custom API endpoint path redirected permanently; use its exact canonical path", {
          endpoint: endpoint.name,
          status: response.status,
        });
      }
      throw new CustomApiError("REDIRECT_REFUSED", "custom API redirect was refused", { endpoint: endpoint.name, status: response.status });
    }
    if (response.status === 401 || response.status === 403) {
      clearTimeout(timer);
      await response.body?.cancel().catch(() => {});
      throw new CustomApiError("AUTH_REQUIRED", "custom API refused its bearer credential", { endpoint: endpoint.name, status: response.status });
    }
    if (response.status === 429 || response.status >= 500) {
      clearTimeout(timer);
      if (attempt < config.retries) {
        await response.body?.cancel().catch(() => {});
        await sleep(250 * (2 ** (attempt - 1)));
        continue;
      }
      throw new CustomApiError(response.status === 429 ? "RATE_LIMITED" : "REMOTE_UNAVAILABLE", "custom API remained unavailable after bounded retries", {
        endpoint: endpoint.name, status: response.status, retryable: true,
      });
    }
    if (!response.ok) {
      clearTimeout(timer);
      await response.body?.cancel().catch(() => {});
      throw new CustomApiError("INVALID_RESPONSE", "custom API returned an unsupported status", { endpoint: endpoint.name, status: response.status });
    }
    try {
      return await boundedJson(response, config, endpoint);
    } catch (error) {
      if (error instanceof CustomApiError) throw error;
      if (attempt < config.retries) {
        await sleep(250 * (2 ** (attempt - 1)));
        continue;
      }
      throw new CustomApiError("NETWORK_UNREACHABLE", "custom API response did not complete", { endpoint: endpoint.name, retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }
  throw new CustomApiError("REMOTE_UNAVAILABLE", "custom API retry loop ended unexpectedly", { endpoint: endpoint.name });
}

async function fetchEndpoint(config, endpoint, token, dependencies) {
  let url = endpointUrl(config, endpoint);
  const visited = new Set();
  const rows = [];
  const responseDigests = [];
  let responseBytes = 0;
  let refusedRows = 0;
  const refusalReasons = {};
  const refused = [];
  const identities = new Set();
  while (url) {
    assertAllowedUrl(url, config, endpoint);
    if (visited.has(url.href) || visited.size >= config.max_pages) {
      throw new CustomApiError("INVALID_RESPONSE", "custom API paging repeated or exceeded its limit", { endpoint: endpoint.name });
    }
    visited.add(url.href);
    const page = await fetchPage(url, config, endpoint, token, dependencies);
    responseBytes += page.bytes.byteLength;
    if (responseBytes > config.max_response_bytes) {
      throw new CustomApiError("RESPONSE_TOO_LARGE", "custom API endpoint exceeded its configured byte limit across pages", { endpoint: endpoint.name });
    }
    responseDigests.push(await sha256(page.bytes));
    const shaped = pageShape(page.value, url, config, endpoint);
    for (const value of shaped.rows) {
      if (rows.length + refusedRows >= config.max_rows) {
        throw new CustomApiError("RESPONSE_TOO_LARGE", "custom API returned too many rows", { endpoint: endpoint.name });
      }
      try {
        const row = normalizeRow(value, endpoint, token);
        const key = rowIdentity(row, endpoint);
        if (identities.has(key)) {
          throw new CustomApiError("DUPLICATE_ROW_KEY", "custom API returned the same row identity more than once", { endpoint: endpoint.name });
        }
        identities.add(key);
        validateKnownRow(row, endpoint);
        rows.push({ row_key: key, row });
      } catch (error) {
        if (error instanceof CustomApiError && error.code === "ROW_REFUSED") {
          refusedRows++;
          const reason = error.refusalReason || "invalid_known_field";
          refusalReasons[reason] = Number(refusalReasons[reason] || 0) + 1;
          const row = normalizeRow(value, endpoint, token);
          refused.push({ row_key: rowIdentity(row, endpoint), reason });
          continue;
        }
        throw error;
      }
    }
    url = shaped.next;
  }
  const keyed = [];
  for (const item of rows) {
    keyed.push({ ...item, row_hash: await sha256(canonicalJson(item.row)) });
  }
  return {
    rows: keyed,
    response_hash: await sha256(responseDigests.join(":")),
    pages: visited.size,
    rows_received: rows.length + refusedRows,
    refused_rows: refusedRows,
    refusal_reasons: Object.freeze({ ...refusalReasons }),
    refused: Object.freeze(refused.map((item) => Object.freeze({ ...item }))),
  };
}

function formatValue(value, format = "text", field = "") {
  if (value === null) return field === "store" ? "unassigned" : "";
  if (value === undefined) return "";
  if (format === "currency") {
    const number = Number(value);
    return Number.isFinite(number)
      ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(number)
      : String(value);
  }
  if (format === "number") {
    const number = Number(value);
    return Number.isFinite(number) ? new Intl.NumberFormat("en-US").format(number) : String(value);
  }
  if (format === "integer") {
    const number = Number(value);
    return Number.isFinite(number) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(number) : String(value);
  }
  return String(value);
}

function markdownTable(rows, formats, configuredFields) {
  const fields = configuredFields;
  const header = `| ${fields.join(" | ")} |`;
  const divider = `| ${fields.map(() => "---").join(" | ")} |`;
  const body = rows.map((item) => `| ${fields.map((field) =>
    formatValue(item.row[field], formats[field], field).replaceAll("|", "\\|").replace(/\s+/g, " ").trim()
  ).join(" | ")} |`);
  return [header, divider, ...body].join("\n");
}

function aggregate(rows, field, operation, format) {
  const numbers = rows.map((item) => Number(item.row[field])).filter(Number.isFinite);
  if (!numbers.length) return null;
  if (operation === "sum" && format === "currency") {
    return numbers.reduce((sum, value) => sum + Math.round(value * 100), 0) / 100;
  }
  if (operation === "sum") return numbers.reduce((sum, value) => sum + value, 0);
  if (operation === "min") return Math.min(...numbers);
  return Math.max(...numbers);
}

function documentTableRows(endpoint, document, rows) {
  if (endpoint.name !== "sales" || !document.name) return rows;
  const numericFields = document.fields.filter((field) => Object.hasOwn(document.aggregates, field));
  const summaryRow = (labelField, label, items, extras = {}) => ({
    row_key: `${labelField}:${label}`,
    row: {
      [labelField]: label,
      ...extras,
      ...Object.fromEntries(numericFields.map((field) => [
        field,
        aggregate(items, field, "sum", document.formats[field]),
      ])),
    },
  });
  if (document.name === "monthly") {
    const stores = new Map();
    for (const item of rows) {
      const key = item.row.store === null ? "unassigned" : String(item.row.store);
      if (!stores.has(key)) stores.set(key, []);
      stores.get(key).push(item);
    }
    const tableRows = [];
    for (const [store, items] of [...stores].sort(([left], [right]) => left.localeCompare(right))) {
      tableRows.push(...items);
      tableRows.push(summaryRow("store", `${store} total`, items, { revenue_stream: "all" }));
    }
    if (rows.length) tableRows.push(summaryRow("store", "Grand total", rows, { revenue_stream: "all" }));
    return tableRows;
  }
  if (document.name === "store-history") {
    const periods = new Map();
    for (const item of rows) {
      const key = String(item.row.period);
      if (!periods.has(key)) periods.set(key, []);
      periods.get(key).push(item);
    }
    return [...periods].sort(([left], [right]) => left.localeCompare(right))
      .map(([period, items]) => summaryRow("period", period, items));
  }
  return rows;
}

function renderTemplate(template, context) {
  return template.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (_match, path) => {
    const value = path.split(".").reduce((current, key) => current?.[key], context);
    if (value === undefined || value === null) {
      throw new CustomApiError("CONFIG_INVALID", `custom API document template references unavailable ${path}`);
    }
    return String(value);
  });
}

function buildDocuments(config, endpoint, rows, priorPresentRows, fetchedAt, responseHash) {
  const fetchedDate = fetchedAt.slice(0, 10);
  const documents = [];
  const currentLogicalSourceIds = [];
  for (const document of endpoint.documents) {
    const groups = new Map();
    const addGroup = (item, prior = false) => {
      const values = document.group_by.map((field) => field === "store" && item.row[field] === null ? "unassigned" : item.row[field]);
      if (values.some((value) => value === undefined || value === null || value === "")) {
        throw new CustomApiError("INVALID_RESPONSE", "custom API row cannot be grouped by the declared document fields", { endpoint: endpoint.name });
      }
      const key = canonicalJson(values);
      if (!groups.has(key)) groups.set(key, { values, rows: [], changed: false });
      if (!prior) groups.get(key).rows.push(item);
      if (!prior && item.action !== "unchanged") groups.get(key).changed = true;
    };
    for (const item of rows) addGroup(item);
    for (const item of priorPresentRows) {
      addGroup(item, true);
      if (!rows.some((current) => current.row_key === item.row_key)) {
        const values = document.group_by.map((field) => field === "store" && item.row[field] === null ? "unassigned" : item.row[field]);
        groups.get(canonicalJson(values)).changed = true;
      }
    }
    for (const group of groups.values()) {
      // A group with no current rows disappeared from the provider snapshot.
      // It must be absent from the exact version map, not promoted as an empty
      // replacement document.
      if (group.rows.length === 0) continue;
      const sourceIdParts = document.group_by.length ? group.values : [fetchedDate];
      const layout = endpoint.documents.length > 1 ? `${document.name}:` : "";
      const sourceId = `${endpoint.name}:${layout}${sourceIdParts.map(String).join(":")}`;
      currentLogicalSourceIds.push(sourceId);
      // Ungrouped documents include fetched_date in their logical identity and
      // prose, so a new dated snapshot always needs its own physical version.
      if (!group.changed && document.group_by.length > 0) continue;
      group.rows.sort((a, b) => a.row_key.localeCompare(b.row_key));
    const context = { fetched_date: fetchedDate, row_count: group.rows.length, sum: {}, min: {}, max: {}, missing: {} };
      document.group_by.forEach((field, index) => { context[field] = group.values[index]; });
    for (const [field, operation] of Object.entries(document.aggregates)) {
      context[operation][field] = formatValue(
        aggregate(group.rows, field, operation, document.formats[field]),
        document.formats[field],
        field,
      );
    }
    for (const [field, expected] of Object.entries(document.expected_values)) {
      const present = new Set(group.rows.map((item) => item.row[field]));
      context.missing[field] = expected
        .filter((value) => !present.has(value))
        .map((value) => `no ${value.replaceAll("_", " ")} sales recorded`)
        .join("; ");
    }
    context.rows_table = markdownTable(
      documentTableRows(endpoint, document, group.rows),
      document.formats,
      document.fields,
    );
    const title = renderTemplate(document.title_template, context);
    const content = renderTemplate(document.body_template, context);
    const metadata = {
      connector: "custom_api",
      endpoint: endpoint.path,
      fetched_at: fetchedAt,
      response_hash: responseHash,
      row_keys: group.rows.map((item) => item.row_key),
    };
    const envelope = {
      source_type: config.source,
      source_id: sourceId,
      title,
      content,
      occurred_at: document.group_by.includes("period")
        ? String(context.period)
        : fetchedDate,
      date_source: document.group_by.includes("period")
        ? "custom_api:period"
        : "custom_api:fetched_date",
      date_reliable: true,
      text_source: "native",
      text_reliable: true,
      metadata,
    };
    if (scanSecrets(canonicalJson(envelope)).shouldRefuse) {
      throw new CustomApiError("SECRET_IN_RESPONSE", "custom API document was held by the credential scanner", { endpoint: endpoint.name });
    }
      documents.push(envelope);
    }
  }
  return { documents, currentLogicalSourceIds };
}

function planEndpoint(config, endpoint, fetched, priorRows, fetchedAt) {
  const prior = new Map((priorRows || []).map((item) => [String(item.row_key), item]));
  const refused = new Map((fetched.refused || []).map((item) => [String(item.row_key), item.reason]));
  const rowChanges = fetched.rows.map((item) => ({
    ...item,
    prior_hash: prior.get(item.row_key)?.row_hash || null,
    prior_revision: Number(prior.get(item.row_key)?.revision || 0),
    first_seen_at: prior.get(item.row_key)?.first_seen_at || null,
    last_seen_at: prior.get(item.row_key)?.last_seen_at || null,
    history_hashes: Array.isArray(prior.get(item.row_key)?.history_hashes)
      ? prior.get(item.row_key).history_hashes
      : [],
    action: !prior.has(item.row_key)
      ? "created"
      : prior.get(item.row_key).present === false
        ? "updated"
        : prior.get(item.row_key).row_hash === item.row_hash
          ? "unchanged"
          : "updated",
  }));
  const present = new Set(rowChanges.map((item) => item.row_key));
  const carriedRefused = [...refused.entries()]
    .filter(([rowKey]) => !present.has(rowKey) && prior.get(rowKey)?.present !== false && isPlainObject(prior.get(rowKey)?.row))
    .map(([rowKey, reason]) => ({
      ...prior.get(rowKey),
      row_key: rowKey,
      row_hash: String(prior.get(rowKey).row_hash),
      row: prior.get(rowKey).row,
      action: "unchanged_refused",
      prior_revision: Number(prior.get(rowKey).revision || 0),
      prior_hash: String(prior.get(rowKey).row_hash),
      refresh_status: "not refreshed (refused)",
      refusal_reason: reason,
    }));
  const retained = [...prior.values()]
    .filter((item) => !present.has(String(item.row_key)) && !refused.has(String(item.row_key)) && isPlainObject(item.row))
    .map((item) => ({
      ...item,
      row_key: String(item.row_key), row_hash: String(item.row_hash), row: item.row,
      action: item.present === false ? "unchanged_missing" : "missing",
      prior_revision: Number(item.revision || 0), prior_hash: String(item.row_hash),
    }));
  const priorPresent = [...prior.values()].filter((item) => item.present !== false && isPlainObject(item.row));
  const { documents, currentLogicalSourceIds } = buildDocuments(
    config,
    endpoint,
    [...rowChanges, ...carriedRefused],
    priorPresent,
    fetchedAt,
    fetched.response_hash,
  );
  return {
    rowChanges: [...rowChanges, ...carriedRefused, ...retained],
    retained,
    carriedRefused,
    documents,
    currentLogicalSourceIds,
  };
}

export async function runCustomApiPull(rawConfig, {
  token,
  fetchImpl = fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = () => new Date(),
  persistence,
  dryRun = false,
  logger = { info() {}, warn() {} },
} = {}) {
  const config = validateCustomApiConfig(rawConfig);
  if (typeof token !== "string" || !token || token.length > 2_048) {
    throw new CustomApiError("AUTH_REQUIRED", "custom API Worker secret is missing");
  }
  if (!persistence || typeof persistence.loadRows !== "function" ||
      (typeof persistence.persist !== "function" && typeof persistence.stageJob !== "function")) {
    throw new TypeError("custom API pull needs persistence loadRows and a persistence writer");
  }
  const fetchedAt = now().toISOString();
  if (dryRun !== true && typeof persistence.loadActiveJob === "function") {
    const active = await persistence.loadActiveJob({ source: config.source });
    if (active) return persistence.advanceJob(active);
  }
  const total = { created: 0, updated: 0, unchanged: 0 };
  let documents = 0;
  let retained = 0;
  let refusedRows = 0;
  let acceptedRows = 0;
  const endpointResults = [];
  const planned = [];
  for (const endpoint of config.endpoints) {
    logger.info(`custom API: fetching ${endpoint.name}`);
    const fetched = await fetchEndpoint(config, endpoint, token, { fetchImpl, sleep });
    acceptedRows += fetched.rows.length;
    const priorResponseHash = typeof persistence.loadResponseHash === "function"
      ? await persistence.loadResponseHash({ source: config.source, endpoint: endpoint.name })
      : null;
    if (fetched.refused_rows === 0 && priorResponseHash === fetched.response_hash) {
      total.unchanged += fetched.rows.length;
      refusedRows += fetched.refused_rows;
      endpointResults.push(Object.freeze({
        name: endpoint.name,
        rows_received: fetched.rows_received,
        rows_accepted: fetched.rows.length,
        rows_refused: fetched.refused_rows,
        refusal_reasons: fetched.refusal_reasons,
        rows: Object.freeze({ created: 0, updated: 0, unchanged: fetched.rows.length }),
        documents: 0,
        retained_missing_rows: 0,
        body_unchanged: true,
      }));
      continue;
    }
    const prior = await persistence.loadRows({ source: config.source, endpoint: endpoint.name });
    const plan = planEndpoint(config, endpoint, fetched, prior, fetchedAt);
    for (const row of plan.rowChanges) {
      if (row.action === "created" || row.action === "updated" || row.action === "unchanged") total[row.action]++;
    }
    documents += plan.documents.length;
    retained += plan.retained.length;
    refusedRows += fetched.refused_rows;
    endpointResults.push(Object.freeze({
      name: endpoint.name,
      rows_received: fetched.rows_received,
      rows_accepted: fetched.rows.length,
      rows_refused: fetched.refused_rows,
      refusal_reasons: fetched.refusal_reasons,
      rows: Object.freeze({
        created: plan.rowChanges.filter((row) => row.action === "created").length,
        updated: plan.rowChanges.filter((row) => row.action === "updated").length,
        unchanged: plan.rowChanges.filter((row) => row.action === "unchanged").length,
      }),
      documents: plan.documents.length,
      retained_missing_rows: plan.retained.length,
      rows_carried_refused: plan.carriedRefused.length,
      body_unchanged: false,
    }));
    planned.push({ endpoint, fetched, plan });
    if (!dryRun && typeof persistence.stageJob !== "function") {
      await persistence.persist({
        source: config.source,
        endpoint: endpoint.name,
        rowChanges: plan.rowChanges,
        documentChanges: plan.documents,
        fetchedAt,
        responseHash: fetched.response_hash,
      });
    }
  }
  if (acceptedRows === 0 && refusedRows > 0) {
    return Object.freeze({
      status: "refused", dry_run: dryRun, source: config.source,
      endpoints: config.endpoints.length, rows: Object.freeze(total), documents: 0,
      refused_rows: refusedRows, endpoint_results: Object.freeze(endpointResults),
      retained_missing_rows: 0, fetched_at: fetchedAt, saved: false,
      meaning_search_ready: false,
      next_pull_at: new Date(Date.parse(fetchedAt) + config.cadence_seconds * 1000).toISOString(),
    });
  }
  if (!dryRun && typeof persistence.stageJob === "function") {
    const verified = typeof persistence.loadVerifiedSnapshot === "function"
      ? await persistence.loadVerifiedSnapshot({ source: config.source })
      : null;
    const hashes = Object.fromEntries(planned.map(({ endpoint, fetched }) => [endpoint.name, fetched.response_hash]));
    if (verified && canonicalJson(verified.response_hashes) === canonicalJson(hashes)) {
      const meaningSearchReady = await persistence.meaningSearchReady({ source: config.source });
      return Object.freeze({
        status: "completed", dry_run: false, source: config.source, endpoints: config.endpoints.length,
        rows: Object.freeze(total), documents: 0, refused_rows: refusedRows,
        endpoint_results: Object.freeze(endpointResults), retained_missing_rows: 0,
        fetched_at: fetchedAt, next_pull_at: new Date(Date.parse(fetchedAt) + config.cadence_seconds * 1000).toISOString(),
        job_id: verified.job_id, job_phase: "verified", saved: true,
        meaning_search_ready: meaningSearchReady,
      });
    }
    const staged = await persistence.stageJob({
      source: config.source,
      fetchedAt,
      responseHashes: hashes,
      planned,
      stats: {
        rows: total, documents, refused_rows: refusedRows,
        endpoint_results: endpointResults, retained_missing_rows: retained,
        endpoints: config.endpoints.length,
        next_pull_at: new Date(Date.parse(fetchedAt) + config.cadence_seconds * 1000).toISOString(),
      },
    });
    return Object.freeze({
      status: "in_progress", dry_run: false, source: config.source,
      ...staged, saved: false, meaning_search_ready: false,
    });
  }
  return Object.freeze({
    status: "completed",
    dry_run: dryRun,
    source: config.source,
    endpoints: config.endpoints.length,
    rows: Object.freeze(total),
    documents,
    refused_rows: refusedRows,
    endpoint_results: Object.freeze(endpointResults),
    retained_missing_rows: retained,
    fetched_at: fetchedAt,
    next_pull_at: new Date(Date.parse(fetchedAt) + config.cadence_seconds * 1000).toISOString(),
  });
}

function chunked(values, size) {
  const groups = [];
  for (let index = 0; index < values.length; index += size) groups.push(values.slice(index, index + size));
  return groups;
}

function chunkRows(values) {
  const groups = [];
  let current = [];
  for (const value of values) {
    const candidate = [...current, value];
    const bytes = new TextEncoder().encode(canonicalJson(candidate)).byteLength;
    if (current.length && (current.length >= ROW_CHUNK_SIZE || bytes > ROW_CHUNK_MAX_BYTES)) {
      groups.push(current);
      current = [value];
    } else {
      current = candidate;
    }
    if (new TextEncoder().encode(canonicalJson(current)).byteLength > ROW_CHUNK_MAX_BYTES) {
      throw new CustomApiError("RESPONSE_TOO_LARGE", "custom API row could not fit a bounded structured-row chunk");
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

/** D1 adapter kept here so scheduled and manual runs share one checkpointed writer. */
export function customApiD1Persistence(env, hooks = {}) {
  const ingestDocument = hooks.ingestDocument ?? (async (envelope) => storeFor(env).ingest(env, envelope));
  const forgetDocuments = hooks.forgetDocuments ?? (async (docUids) =>
    forget(env, { docUids, dryRun: false }));

  const parseJob = (row) => {
    if (!row) return null;
    let stats;
    let responseHashes;
    try {
      stats = JSON.parse(row.stats_json);
      responseHashes = JSON.parse(row.response_hashes_json);
    } catch {
      throw new CustomApiError("PERSISTENCE_VERIFY_FAILED", "custom API job receipt could not be parsed");
    }
    return {
      job_id: String(row.job_id), source: String(row.source), fetched_at: String(row.fetched_at),
      status: String(row.status), next_slice: Number(row.next_slice), total_slices: Number(row.total_slices),
      job_hash: String(row.job_hash), cleanup_documents_queued: Number(row.cleanup_documents_queued || 0),
      stats, response_hashes: responseHashes,
    };
  };

  const progress = async (job, overrides = {}) => Object.freeze({
    status: "in_progress",
    job_id: job.job_id,
    job_phase: job.next_slice >= job.total_slices ? "verifying" : job.status,
    slice_completed: job.next_slice,
    slices_total: job.total_slices,
    saved: false,
    meaning_search_ready: false,
    ...overrides,
  });

  const completed = async (job) => Object.freeze({
    status: "completed", dry_run: false, source: job.source,
    ...job.stats,
    fetched_at: job.fetched_at,
    job_id: job.job_id, job_phase: "verified", saved: true,
    meaning_search_ready: await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM vector_outbox"
    ).first().then((row) => Number(row?.n || 0) === 0),
  });

  const collectPriorRowChunks = async (job) => {
    const pointer = await env.DB.prepare(
      "SELECT job_id FROM custom_api_current_jobs WHERE source=?1"
    ).bind(job.source).first();
    if (pointer?.job_id !== job.job_id) {
      throw new CustomApiError("PERSISTENCE_VERIFY_FAILED", "custom API current-job pointer did not read back exactly");
    }
    const staleResult = await env.DB.prepare(
      `SELECT d.doc_uid
         FROM documents d
        WHERE d.source=?1 AND d.deleted_at IS NULL
          AND CASE WHEN json_valid(d.meta) THEN json_extract(d.meta,'$.connector') END='custom_api'
          AND NOT EXISTS (
            SELECT 1 FROM custom_api_document_versions v
             WHERE v.source=?1 AND v.job_id=?2 AND v.document_source_id=d.source_id
          )
        ORDER BY d.doc_uid LIMIT ?3`
    ).bind(job.source, job.job_id, DOCUMENT_GC_SLICE_SIZE).all();
    const staleDocUids = (staleResult?.results || []).map((row) => String(row.doc_uid));
    if (staleDocUids.length) {
      const forgotten = await forgetDocuments(staleDocUids);
      if (Number(forgotten?.documents) !== staleDocUids.length || forgotten?.dry_run !== false) {
        throw new CustomApiError("PERSISTENCE_VERIFY_FAILED", "custom API obsolete document cleanup did not queue exactly");
      }
      const expectedQueued = Number(job.cleanup_documents_queued || 0) + staleDocUids.length;
      await env.DB.prepare(
        `UPDATE custom_api_jobs SET cleanup_documents_queued=?2
          WHERE job_id=?1 AND status='promoted' AND cleanup_documents_queued=?3`
      ).bind(job.job_id, expectedQueued, Number(job.cleanup_documents_queued || 0)).run();
      const tracked = await env.DB.prepare(
        "SELECT cleanup_documents_queued FROM custom_api_jobs WHERE job_id=?1 AND status='promoted'"
      ).bind(job.job_id).first();
      if (Number(tracked?.cleanup_documents_queued) !== expectedQueued) {
        throw new CustomApiError("PERSISTENCE_VERIFY_FAILED", "custom API obsolete document cleanup progress did not read back exactly");
      }
      await hooks.afterDocumentCleanupSlice?.({ jobId: job.job_id, queued: staleDocUids.length, totalQueued: expectedQueued });
      return progress({ ...job, cleanup_documents_queued: expectedQueued }, {
        job_phase: "collecting_documents", saved: true,
        cleanup_documents_queued: expectedQueued,
      });
    }
    await env.DB.prepare(
      `DELETE FROM custom_api_row_chunks
        WHERE rowid IN (
          SELECT rowid FROM custom_api_row_chunks
           WHERE source=?1 AND job_id<>?2
           ORDER BY rowid LIMIT ?3
        )`
    ).bind(job.source, job.job_id, ROW_GC_SLICE_SIZE).run();
    const residue = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM custom_api_row_chunks WHERE source=?1 AND job_id<>?2"
    ).bind(job.source, job.job_id).first();
    await hooks.afterGarbageCollectSlice?.({ jobId: job.job_id, remaining: Number(residue?.n || 0) });
    if (Number(residue?.n || 0) > 0) {
      return progress(job, { job_phase: "collecting", saved: true });
    }
    await env.DB.prepare(
      "UPDATE custom_api_jobs SET status='verified' WHERE job_id=?1 AND status='promoted'"
    ).bind(job.job_id).run();
    const stagedPlan = await readStagedPlan(job);
    const terminal = await env.DB.prepare(
      `SELECT j.status,j.verified_at,c.job_id AS current_job_id,c.promoted_at,
              f.job_id AS fetch_job_id,f.source AS fetch_source,f.fetched_at AS fetch_fetched_at,
              f.response_hashes_json AS fetch_hashes,f.stats_json AS fetch_stats,
              f.verified_at AS fetch_verified_at,
              (SELECT COUNT(*) FROM custom_api_document_versions v
                WHERE v.job_id=j.job_id AND v.source=j.source) AS version_count,
              (SELECT COUNT(*) FROM custom_api_document_versions v
                JOIN documents d ON d.source=v.source AND d.source_id=v.document_source_id
                 AND d.deleted_at IS NULL
               WHERE v.job_id=c.job_id AND v.source=c.source
                 AND CASE WHEN json_valid(d.meta) THEN json_extract(d.meta,'$.connector') END='custom_api'
                 AND CASE WHEN json_valid(d.meta) THEN json_extract(d.meta,'$.custom_api_source_id') END=v.logical_source_id
              ) AS visible_version_count
         FROM custom_api_jobs j
         LEFT JOIN custom_api_current_jobs c ON c.source=j.source
         LEFT JOIN custom_api_fetches f ON f.job_id=j.job_id
        WHERE j.job_id=?1`
    ).bind(job.job_id).first();
    if (terminal?.status !== "verified" || terminal?.verified_at !== job.fetched_at ||
        terminal?.current_job_id !== job.job_id || terminal?.promoted_at !== job.fetched_at ||
        terminal?.fetch_job_id !== job.job_id || terminal?.fetch_source !== job.source ||
        terminal?.fetch_fetched_at !== job.fetched_at || terminal?.fetch_verified_at !== job.fetched_at ||
        terminal?.fetch_hashes !== canonicalJson(job.response_hashes) || terminal?.fetch_stats !== canonicalJson(job.stats) ||
        Number(terminal?.version_count) !== stagedPlan.versions.length ||
        Number(terminal?.visible_version_count) !== stagedPlan.versions.length) {
      throw new CustomApiError("PERSISTENCE_VERIFY_FAILED", "custom API terminal receipt did not read back exactly");
    }
    return completed(job);
  };

  const readStagedPlan = async (job) => {
    const sliceResult = await env.DB.prepare(
      `SELECT slice_index,kind,payload_hash,verified_at
         FROM custom_api_job_slices WHERE job_id=?1 ORDER BY slice_index`
    ).bind(job.job_id).all();
    const versionResult = await env.DB.prepare(
      `SELECT logical_source_id,document_source_id
         FROM custom_api_document_versions WHERE job_id=?1 AND source=?2
        ORDER BY logical_source_id`
    ).bind(job.job_id, job.source).all();
    const slices = sliceResult?.results || [];
    const versions = versionResult?.results || [];
    const jobHash = await sha256(canonicalJson({
      slice_hashes: slices.map((slice) => slice.payload_hash),
      document_versions: versions.map((version) => ({
        logical_source_id: version.logical_source_id,
        document_source_id: version.document_source_id,
      })),
    }));
    if (slices.length !== job.total_slices || jobHash !== job.job_hash ||
        slices.some((slice) => slice.kind === "rows" && slice.verified_at == null)) {
      throw new CustomApiError("PERSISTENCE_VERIFY_FAILED", "custom API staged plan did not read back exactly");
    }
    return { slices, versions };
  };

  const verifyStagedPlan = async (job) => {
    const { slices, versions } = await readStagedPlan(job);
    await hooks.afterStagedPlanReadback?.({
      jobId: job.job_id,
      rowSlices: slices.filter((slice) => slice.kind === "rows").length,
      documentSlices: slices.filter((slice) => slice.kind === "document").length,
      documentVersions: versions.length,
    });
  };

  return {
    async loadRows({ source, endpoint }) {
      const result = await env.DB.prepare(
        `SELECT rows_json FROM custom_api_row_chunks
          WHERE source=?1 AND endpoint=?2
            AND job_id=(SELECT job_id FROM custom_api_current_jobs WHERE source=?1)
          ORDER BY chunk_index`
      ).bind(source, endpoint).all();
      const rows = [];
      for (const chunk of result?.results || []) {
        let parsed;
        try { parsed = JSON.parse(chunk.rows_json); } catch { parsed = null; }
        if (!Array.isArray(parsed)) {
          throw new CustomApiError("PERSISTENCE_VERIFY_FAILED", "custom API row chunk could not be parsed", { endpoint });
        }
        for (const item of parsed) if (isPlainObject(item) && isPlainObject(item.row)) rows.push(item);
      }
      return rows;
    },

    async loadActiveJob({ source }) {
      return parseJob(await env.DB.prepare(
        `SELECT job_id,source,fetched_at,status,next_slice,total_slices,job_hash,stats_json,response_hashes_json,
                cleanup_documents_queued
           FROM custom_api_jobs
          WHERE source=?1 AND status IN ('staged','applying','promoting','promoted')
          ORDER BY created_at DESC,rowid DESC LIMIT 1`
      ).bind(source).first());
    },

    async loadVerifiedSnapshot({ source }) {
      return parseJob(await env.DB.prepare(
        `SELECT job_id,source,fetched_at,status,next_slice,total_slices,job_hash,stats_json,response_hashes_json,
                cleanup_documents_queued
           FROM custom_api_jobs
          WHERE job_id=(SELECT job_id FROM custom_api_current_jobs WHERE source=?1)`
      ).bind(source).first());
    },

    async meaningSearchReady({ source }) {
      void source;
      const row = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM vector_outbox"
      ).first();
      return Number(row?.n || 0) === 0;
    },

    async stageJob({ source, fetchedAt, responseHashes, planned, stats }) {
      const jobId = crypto.randomUUID();
      const rowSlices = [];
      const documentSlices = [];
      const currentLogicalSourceIds = new Set();
      const changedDocumentVersions = new Map();
      for (const { endpoint, plan } of planned) {
        for (const logicalSourceId of plan.currentLogicalSourceIds) {
          if (currentLogicalSourceIds.has(logicalSourceId)) {
            throw new CustomApiError("PERSISTENCE_VERIFY_FAILED", "custom API logical document identity was duplicated", { endpoint: endpoint.name });
          }
          currentLogicalSourceIds.add(logicalSourceId);
        }
        const durableRows = plan.rowChanges
          .map((item) => {
            const changed = ["created", "updated", "missing"].includes(item.action);
            const present = !["missing", "unchanged_missing"].includes(item.action);
            const history = Array.isArray(item.history_hashes) ? [...item.history_hashes] : [];
            if (item.action === "updated" && item.prior_hash && !history.includes(item.prior_hash)) history.push(item.prior_hash);
            return {
              row_key: item.row_key,
              row_hash: item.row_hash,
              row: item.row,
              revision: Number(item.prior_revision || item.revision || 0) + (changed ? 1 : 0),
              first_seen_at: item.first_seen_at || fetchedAt,
              last_seen_at: present ? fetchedAt : (item.last_seen_at || item.updated_at || fetchedAt),
              present,
              history_hashes: history,
              ...(item.action === "unchanged_refused" ? {
                refresh_status: item.refresh_status,
                refusal_reason: item.refusal_reason,
              } : {}),
            };
          })
          .sort((a, b) => a.row_key.localeCompare(b.row_key));
        for (const [chunkIndex, rows] of chunkRows(durableRows).entries()) {
          const payload = canonicalJson(rows);
          rowSlices.push({ kind: "rows", endpoint: endpoint.name, target: String(chunkIndex), payload });
        }
        for (const document of plan.documents) {
          const logicalSourceId = document.source_id;
          const documentSourceId = customApiVersionedSourceId(logicalSourceId, jobId);
          const unstamped = {
            ...document,
            source_id: documentSourceId,
            metadata: {
              ...document.metadata,
              custom_api_job_id: jobId,
              custom_api_source_id: logicalSourceId,
            },
          };
          const stagedEnvelope = restampFirstPartySourceProvenance(unstamped, {
            textSource: "native", textReliable: true, sourceType: source,
          });
          const validationError = ingestEnvelopeValidationError(stagedEnvelope);
          if (validationError) {
            throw new CustomApiError(
              "INVALID_RESPONSE",
              `custom API document failed the storage contract: ${validationError}`,
              { endpoint: endpoint.name },
            );
          }
          const payload = canonicalJson(stagedEnvelope);
          documentSlices.push({ kind: "document", endpoint: endpoint.name, target: JSON.parse(payload).source_id, payload });
          changedDocumentVersions.set(logicalSourceId, documentSourceId);
        }
      }
      const priorResult = await env.DB.prepare(
        `SELECT v.logical_source_id,v.document_source_id
           FROM custom_api_document_versions v
           JOIN custom_api_current_jobs c ON c.source=v.source AND c.job_id=v.job_id
          WHERE v.source=?1`
      ).bind(source).all();
      const priorVersions = new Map((priorResult?.results || []).map((version) => [
        String(version.logical_source_id),
        String(version.document_source_id),
      ]));
      const documentVersions = [...currentLogicalSourceIds].sort().map((logicalSourceId) => {
        const documentSourceId = changedDocumentVersions.get(logicalSourceId) ?? priorVersions.get(logicalSourceId);
        if (!documentSourceId) {
          throw new CustomApiError(
            "PERSISTENCE_VERIFY_FAILED",
            "custom API unchanged document has no prior verified version",
          );
        }
        return { logical_source_id: logicalSourceId, document_source_id: documentSourceId };
      });
      // All durable row versions are applied and read back before the first
      // document enters the live ingest machinery. Document versions then use
      // a separate promotion phase. The complete version map remains hidden
      // until the current-job pointer flips.
      const slices = [...rowSlices, ...documentSlices];
      if (slices.length + documentVersions.length + 1 > MAX_JOB_STAGE_STATEMENTS) {
        throw new CustomApiError("RESPONSE_TOO_LARGE", "custom API snapshot needs too many bounded job slices");
      }
      for (const slice of slices) slice.hash = await sha256(`${slice.kind}:${slice.endpoint}:${slice.target}:${slice.payload}`);
      const jobHash = await sha256(canonicalJson({
        slice_hashes: slices.map((slice) => slice.hash),
        document_versions: documentVersions,
      }));
      const statements = [env.DB.prepare(
        `INSERT INTO custom_api_jobs
          (job_id,source,fetched_at,status,next_slice,total_slices,job_hash,response_hashes_json,stats_json,created_at)
         VALUES (?1,?2,?3,'staged',0,?4,?5,?6,?7,?3)`
      ).bind(jobId, source, fetchedAt, slices.length, jobHash, canonicalJson(responseHashes), canonicalJson(stats))];
      slices.forEach((slice, index) => statements.push(env.DB.prepare(
        `INSERT INTO custom_api_job_slices
          (job_id,slice_index,kind,endpoint,target_key,payload_json,payload_hash)
         VALUES (?1,?2,?3,?4,?5,?6,?7)`
      ).bind(jobId, index, slice.kind, slice.endpoint, slice.target, slice.payload, slice.hash)));
      documentVersions.forEach((version) => statements.push(env.DB.prepare(
        `INSERT INTO custom_api_document_versions
          (source,job_id,logical_source_id,document_source_id)
         VALUES (?1,?2,?3,?4)`
      ).bind(source, jobId, version.logical_source_id, version.document_source_id)));
      await env.DB.batch(statements);
      const receipt = await env.DB.prepare(
        `SELECT j.job_hash,j.total_slices,
                (SELECT COUNT(*) FROM custom_api_job_slices s WHERE s.job_id=j.job_id) AS stored_slices,
                (SELECT COUNT(*) FROM custom_api_document_versions v WHERE v.job_id=j.job_id) AS stored_versions
           FROM custom_api_jobs j WHERE j.job_id=?1`
      ).bind(jobId).first();
      if (receipt?.job_hash !== jobHash || Number(receipt?.stored_slices) !== slices.length ||
          Number(receipt?.stored_versions) !== documentVersions.length || Number(receipt?.total_slices) !== slices.length) {
        throw new CustomApiError("PERSISTENCE_VERIFY_FAILED", "custom API staged job did not read back exactly");
      }
      await hooks.afterStageReadback?.({ jobId, slices: slices.length });
      return { job_id: jobId, job_phase: "staged", slice_completed: 0, slices_total: slices.length };
    },

    async advanceJob(inputJob) {
      let job = inputJob;
      if (job.status === "promoted") return collectPriorRowChunks(job);
      if (job.status === "verified") return completed(job);
      if (job.next_slice < job.total_slices) {
        const slice = await env.DB.prepare(
          `SELECT kind,endpoint,target_key,payload_json,payload_hash
             FROM custom_api_job_slices WHERE job_id=?1 AND slice_index=?2`
        ).bind(job.job_id, job.next_slice).first();
        if (!slice) throw new CustomApiError("PERSISTENCE_VERIFY_FAILED", "custom API job slice is missing");
        if (await sha256(`${slice.kind}:${slice.endpoint}:${slice.target_key}:${slice.payload_json}`) !== slice.payload_hash) {
          throw new CustomApiError("PERSISTENCE_VERIFY_FAILED", "custom API job slice hash did not verify");
        }
        if (slice.kind === "rows") {
          if (job.status === "promoting") {
            throw new CustomApiError("PERSISTENCE_VERIFY_FAILED", "custom API row slice appeared after promotion began");
          }
          await env.DB.prepare(
            `INSERT INTO custom_api_row_chunks
              (source,endpoint,chunk_index,rows_json,content_hash,job_id,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT(job_id,endpoint,chunk_index) DO UPDATE SET
               rows_json=excluded.rows_json,content_hash=excluded.content_hash,
               source=excluded.source,updated_at=excluded.updated_at`
          ).bind(job.source, slice.endpoint, Number(slice.target_key), slice.payload_json, slice.payload_hash, job.job_id, job.fetched_at).run();
          const stored = await env.DB.prepare(
            `SELECT content_hash,job_id FROM custom_api_row_chunks
              WHERE source=?1 AND endpoint=?2 AND chunk_index=?3 AND job_id=?4`
          ).bind(job.source, slice.endpoint, Number(slice.target_key), job.job_id).first();
          if (stored?.content_hash !== slice.payload_hash || stored?.job_id !== job.job_id) {
            throw new CustomApiError("PERSISTENCE_VERIFY_FAILED", "custom API row slice did not read back exactly", { endpoint: slice.endpoint });
          }
        } else if (slice.kind === "document") {
          if (job.status !== "promoting") {
            await verifyStagedPlan(job);
            await env.DB.prepare(
              `UPDATE custom_api_jobs SET status='promoting'
                WHERE job_id=?1 AND status IN ('staged','applying') AND next_slice=?2`
            ).bind(job.job_id, job.next_slice).run();
            const promoting = await env.DB.prepare(
              "SELECT status,next_slice FROM custom_api_jobs WHERE job_id=?1"
            ).bind(job.job_id).first();
            if (promoting?.status !== "promoting" || Number(promoting?.next_slice) !== job.next_slice) {
              throw new CustomApiError("PERSISTENCE_VERIFY_FAILED", "custom API promotion cursor did not read back exactly");
            }
            job = { ...job, status: "promoting" };
          }
          let document;
          try { document = JSON.parse(slice.payload_json); } catch { document = null; }
          const validationError = isPlainObject(document)
            ? ingestEnvelopeValidationError(document)
            : "ingest body must be a document object";
          if (validationError) {
            await env.DB.prepare(
              `UPDATE custom_api_jobs SET status='failed'
                WHERE job_id=?1 AND status IN ('staged','applying','promoting')`
            ).bind(job.job_id).run();
            const failed = await env.DB.prepare("SELECT status FROM custom_api_jobs WHERE job_id=?1").bind(job.job_id).first();
            if (failed?.status !== "failed") {
              throw new CustomApiError("PERSISTENCE_VERIFY_FAILED", "custom API invalid staged job could not be failed safely");
            }
            await hooks.afterJobFailed?.({ jobId: job.job_id, sliceIndex: job.next_slice });
            throw new CustomApiError("PERSISTENCE_VERIFY_FAILED", `staged custom API document is invalid: ${validationError}`);
          }
          await ingestDocument(document);
          const stored = await env.DB.prepare(
            "SELECT meta FROM documents WHERE source=?1 AND source_id=?2 AND deleted_at IS NULL"
          ).bind(job.source, slice.target_key).first();
          let meta;
          try { meta = JSON.parse(stored?.meta); } catch { meta = null; }
          if (meta?.custom_api_job_id !== job.job_id) {
            throw new CustomApiError("PERSISTENCE_VERIFY_FAILED", "custom API document slice did not read back exactly", { endpoint: slice.endpoint });
          }
        } else {
          throw new CustomApiError("PERSISTENCE_VERIFY_FAILED", "custom API job slice kind was invalid");
        }
        await hooks.afterSliceReadback?.({ jobId: job.job_id, sliceIndex: job.next_slice, kind: slice.kind });
        const next = job.next_slice + 1;
        await env.DB.batch([
          env.DB.prepare(
            "UPDATE custom_api_job_slices SET verified_at=?3 WHERE job_id=?1 AND slice_index=?2"
          ).bind(job.job_id, job.next_slice, job.fetched_at),
          env.DB.prepare(
            `UPDATE custom_api_jobs SET status=?4,next_slice=?2
              WHERE job_id=?1 AND next_slice=?3`
          ).bind(job.job_id, next, job.next_slice, slice.kind === "document" ? "promoting" : "applying"),
        ]);
        const cursor = await env.DB.prepare(
          "SELECT status,next_slice FROM custom_api_jobs WHERE job_id=?1"
        ).bind(job.job_id).first();
        const expectedStatus = slice.kind === "document" ? "promoting" : "applying";
        if (Number(cursor?.next_slice) !== next || cursor?.status !== expectedStatus) {
          throw new CustomApiError("PERSISTENCE_VERIFY_FAILED", "custom API job cursor did not read back exactly");
        }
        job = { ...job, status: expectedStatus, next_slice: next };
        return progress(job);
      }

      if (job.status !== "promoting") {
        await verifyStagedPlan(job);
        await env.DB.prepare(
          `UPDATE custom_api_jobs SET status='promoting'
            WHERE job_id=?1 AND status IN ('staged','applying') AND next_slice=total_slices`
        ).bind(job.job_id).run();
        job = { ...job, status: "promoting" };
      }
      const receipt = await env.DB.prepare(
        `SELECT COUNT(*) AS slices,
                SUM(CASE WHEN s.verified_at IS NOT NULL THEN 1 ELSE 0 END) AS verified,
                SUM(CASE
                  WHEN s.kind='rows' AND r.content_hash=s.payload_hash AND r.job_id=s.job_id THEN 1
                  WHEN s.kind='document' AND json_extract(d.meta,'$.custom_api_job_id')=s.job_id THEN 1
                  ELSE 0 END) AS exact
           FROM custom_api_job_slices s
           LEFT JOIN custom_api_row_chunks r
             ON s.kind='rows' AND r.source=?2 AND r.endpoint=s.endpoint
              AND r.chunk_index=CAST(s.target_key AS INTEGER) AND r.job_id=s.job_id
           LEFT JOIN documents d
             ON s.kind='document' AND d.source=?2 AND d.source_id=s.target_key AND d.deleted_at IS NULL
          WHERE s.job_id=?1`
      ).bind(job.job_id, job.source).first();
      if (Number(receipt?.slices) !== job.total_slices || Number(receipt?.verified) !== job.total_slices || Number(receipt?.exact) !== job.total_slices) {
        throw new CustomApiError("PERSISTENCE_VERIFY_FAILED", "custom API terminal verification did not match every slice");
      }
      const stagedPlan = await readStagedPlan(job);
      const versionReceipt = await env.DB.prepare(
        `SELECT COUNT(*) AS versions,
                SUM(CASE
                  WHEN d.source_id IS NOT NULL
                   AND CASE WHEN json_valid(d.meta) THEN json_extract(d.meta,'$.connector') END='custom_api'
                   AND CASE WHEN json_valid(d.meta) THEN json_extract(d.meta,'$.custom_api_source_id') END=v.logical_source_id
                  THEN 1 ELSE 0 END) AS exact
           FROM custom_api_document_versions v
           LEFT JOIN documents d ON d.source=v.source AND d.source_id=v.document_source_id
            AND d.deleted_at IS NULL
          WHERE v.job_id=?1 AND v.source=?2`
      ).bind(job.job_id, job.source).first();
      if (Number(versionReceipt?.versions) !== stagedPlan.versions.length ||
          Number(versionReceipt?.exact) !== stagedPlan.versions.length) {
        throw new CustomApiError("PERSISTENCE_VERIFY_FAILED", "custom API terminal version map did not match every current document");
      }
      await hooks.afterTerminalReadback?.({ jobId: job.job_id });
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE custom_api_jobs SET status='promoted',verified_at=?2
            WHERE job_id=?1 AND status IN ('promoting','promoted') AND next_slice=total_slices`
        ).bind(job.job_id, job.fetched_at),
        env.DB.prepare(
          `INSERT INTO custom_api_current_jobs (source,job_id,promoted_at)
           SELECT source,job_id,?2 FROM custom_api_jobs WHERE job_id=?1 AND status='promoted'
           ON CONFLICT(source) DO UPDATE SET job_id=excluded.job_id,promoted_at=excluded.promoted_at`
        ).bind(job.job_id, job.fetched_at),
        env.DB.prepare(
          `INSERT INTO custom_api_fetches (job_id,source,fetched_at,response_hashes_json,stats_json,verified_at)
           SELECT job_id,source,fetched_at,response_hashes_json,stats_json,?3
             FROM custom_api_jobs WHERE job_id=?1 AND source=?2 AND status='promoted'
           ON CONFLICT(job_id) DO UPDATE SET verified_at=excluded.verified_at`
        ).bind(job.job_id, job.source, job.fetched_at),
      ]);
      const terminal = await env.DB.prepare(
        `SELECT j.status,j.verified_at,c.job_id AS current_job_id,c.promoted_at,
                f.job_id AS fetch_job_id,f.source AS fetch_source,f.fetched_at AS fetch_fetched_at,
                f.response_hashes_json AS fetch_hashes,f.stats_json AS fetch_stats,
                f.verified_at AS fetch_verified_at,
                (SELECT COUNT(*) FROM custom_api_document_versions v
                  WHERE v.job_id=j.job_id AND v.source=j.source) AS version_count,
                (SELECT COUNT(*) FROM custom_api_document_versions v
                  JOIN documents d ON d.source=v.source AND d.source_id=v.document_source_id
                   AND d.deleted_at IS NULL
                 WHERE v.job_id=c.job_id AND v.source=c.source
                   AND CASE WHEN json_valid(d.meta) THEN json_extract(d.meta,'$.connector') END='custom_api'
                   AND CASE WHEN json_valid(d.meta) THEN json_extract(d.meta,'$.custom_api_source_id') END=v.logical_source_id
                ) AS visible_version_count
           FROM custom_api_jobs j
           LEFT JOIN custom_api_current_jobs c ON c.source=j.source
           LEFT JOIN custom_api_fetches f ON f.job_id=j.job_id
          WHERE j.job_id=?1`
      ).bind(job.job_id).first();
      if (terminal?.status !== "promoted" || terminal?.verified_at !== job.fetched_at ||
          terminal?.current_job_id !== job.job_id || terminal?.promoted_at !== job.fetched_at ||
          terminal?.fetch_job_id !== job.job_id || terminal?.fetch_source !== job.source ||
          terminal?.fetch_fetched_at !== job.fetched_at || terminal?.fetch_verified_at !== job.fetched_at ||
          terminal?.fetch_hashes !== canonicalJson(job.response_hashes) || terminal?.fetch_stats !== canonicalJson(job.stats) ||
          Number(terminal?.version_count) !== stagedPlan.versions.length ||
          Number(terminal?.visible_version_count) !== stagedPlan.versions.length) {
        throw new CustomApiError("PERSISTENCE_VERIFY_FAILED", "custom API terminal receipt did not read back exactly");
      }
      await hooks.afterPromotionReadback?.({ jobId: job.job_id });
      return collectPriorRowChunks({ ...job, status: "promoted" });
    },
  };
}

function configFromEnv(env) {
  if (!env.CUSTOM_API_CONFIG) return null;
  let parsed;
  try { parsed = JSON.parse(env.CUSTOM_API_CONFIG); } catch {
    throw new CustomApiError("CONFIG_INVALID", "custom API Worker configuration is not valid JSON");
  }
  return validateCustomApiConfig(parsed);
}

async function setSourceState(env, config, state, { at, message = null } = {}) {
  if (state === "indexing") {
    const existing = await env.DB.prepare("SELECT kind FROM sources WHERE name=?1").bind(config.source).first();
    if (existing && String(existing.kind).trim().toLowerCase() !== "custom_api") {
      throw new CustomApiError("CONFIG_INVALID", "custom API source name is already owned by another source kind");
    }
    await env.DB.prepare(
      `INSERT INTO sources (name,kind,status,created_at,expected_refresh_seconds,stale_reason)
       VALUES (?1,'custom_api','indexing',?2,?3,NULL)
       ON CONFLICT(name) DO UPDATE SET status='indexing',expected_refresh_seconds=?3,stale_reason=NULL
       WHERE lower(trim(sources.kind))='custom_api'`
    ).bind(config.source, at, config.cadence_seconds).run();
    const claimed = await env.DB.prepare("SELECT kind FROM sources WHERE name=?1").bind(config.source).first();
    if (String(claimed?.kind || "").trim().toLowerCase() !== "custom_api") {
      throw new CustomApiError("CONFIG_INVALID", "custom API source identity could not be read back");
    }
    await env.DB.prepare(
      "INSERT INTO source_events (source_name,event,at,detail) VALUES (?1,'ingest',?2,'custom API pull started')"
    ).bind(config.source, at).run();
    return;
  }
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM documents d
      WHERE source=?1 AND deleted_at IS NULL${currentCustomApiDocumentSql("d")}`
  ).bind(config.source).first();
  if (state === "ready") {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE sources SET status='ready',last_ingest_at=?2,document_count=?3,
           expected_refresh_seconds=?4,stale_reason=NULL WHERE name=?1 AND kind='custom_api'`
      ).bind(config.source, at, Number(count?.n || 0), config.cadence_seconds),
      env.DB.prepare(
        "INSERT INTO source_events (source_name,event,at,documents,detail) VALUES (?1,'ingest',?2,?3,'custom API pull completed')"
      ).bind(config.source, at, Number(count?.n || 0)),
    ]);
    return;
  }
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE sources SET status='error',expected_refresh_seconds=?2,stale_reason=?3
       WHERE name=?1 AND kind='custom_api'`
    ).bind(config.source, config.cadence_seconds, message),
    env.DB.prepare(
      "INSERT INTO source_events (source_name,event,at,detail) VALUES (?1,'error',?2,?3)"
    ).bind(config.source, at, message),
  ]);
}

async function acquireRunLease(env, config, { at, scheduled }) {
  const nowMs = Date.parse(at);
  const token = crypto.randomUUID();
  const leaseMs = Math.min(15 * 60_000, Math.max(60_000, config.timeout_ms * config.endpoints.length * config.retries + 30_000));
  const row = await env.DB.prepare(
    `INSERT INTO custom_api_schedule_state (source,last_success_at,lease_token,lease_expires_at)
     VALUES (?1,NULL,?2,?3)
     ON CONFLICT(source) DO UPDATE SET lease_token=?2,lease_expires_at=?3
       WHERE custom_api_schedule_state.lease_expires_at IS NULL
          OR custom_api_schedule_state.lease_expires_at<=?4
     RETURNING last_success_at,lease_token`
  ).bind(config.source, token, nowMs + leaseMs, nowMs).first();
  if (row?.lease_token !== token) {
    throw new CustomApiError("RUN_BUSY", "another custom API pull already owns the run lease", { retryable: true });
  }
  if (scheduled && Number.isFinite(Date.parse(row.last_success_at)) &&
      nowMs - Date.parse(row.last_success_at) < config.cadence_seconds * 1000) {
    await env.DB.prepare(
      "UPDATE custom_api_schedule_state SET lease_token=NULL,lease_expires_at=NULL WHERE source=?1 AND lease_token=?2"
    ).bind(config.source, token).run();
    return { token: null, due: false };
  }
  return { token, due: true };
}

async function releaseRunLease(env, config, token, { successAt = null } = {}) {
  if (!token) return;
  await env.DB.prepare(
    `UPDATE custom_api_schedule_state
        SET last_success_at=COALESCE(?3,last_success_at),lease_token=NULL,lease_expires_at=NULL
      WHERE source=?1 AND lease_token=?2`
  ).bind(config.source, token, successAt).run();
}

/** Shared scheduled/manual Worker entry point. */
export async function runCustomApiWorker(env, options = {}) {
  if (backendOf(env) !== D1) {
    throw new CustomApiError("CONFIG_INVALID", "custom API sources require the D1 backend");
  }
  const config = configFromEnv(env);
  if (!config) return { status: "disabled", dry_run: options.dryRun === true };
  const token = env[config.token_secret];
  const at = (options.now ?? (() => new Date()))().toISOString();
  let lease = null;
  let sourceStarted = false;
  if (options.dryRun !== true) {
    lease = await acquireRunLease(env, config, { at, scheduled: options.scheduled === true });
    if (!lease.due) return { status: "not_due", dry_run: false };
    await setSourceState(env, config, "indexing", { at });
    sourceStarted = true;
  }
  try {
    const result = await runCustomApiPull(config, {
      token,
      fetchImpl: options.fetchImpl ?? fetch,
      sleep: options.sleep,
      now: options.now,
      dryRun: options.dryRun === true,
      persistence: options.persistence ?? customApiD1Persistence(env),
      logger: options.logger,
    });
    if (options.dryRun !== true) {
      if (result.status === "completed" && result.saved !== false) {
        await setSourceState(env, config, "ready", { at: result.fetched_at });
        await releaseRunLease(env, config, lease.token, { successAt: result.fetched_at });
      } else if (result.status === "refused") {
        await setSourceState(env, config, "error", { at: result.fetched_at, message: "INPUT_REFUSED" });
        await releaseRunLease(env, config, lease.token);
      } else {
        await releaseRunLease(env, config, lease.token);
      }
    }
    return result;
  } catch (error) {
    const safe = error instanceof CustomApiError
      ? error
      : new CustomApiError("INTERNAL_ERROR", "custom API pull failed internally");
    if (options.dryRun !== true && sourceStarted) {
      await setSourceState(env, config, "error", {
        at,
        message: customApiOwnerMessage(safe.code, config.display_name),
      }).catch(() => {});
    }
    if (options.dryRun !== true) await releaseRunLease(env, config, lease?.token).catch(() => {});
    throw safe;
  }
}

export function customApiWorkerBinding(manifest) {
  const raw = manifest?.corpora?.custom_api;
  if (!raw || raw.enabled !== true) return null;
  return {
    type: "plain_text",
    name: "CUSTOM_API_CONFIG",
    text: JSON.stringify(validateCustomApiConfig(raw)),
  };
}

export const CUSTOM_API_RUN_PATH = "/api/admin/brain/custom-api";
