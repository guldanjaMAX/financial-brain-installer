/**
 * Narrow Cloudflare API transport for the disposable recovery deployment.
 *
 * This module is wired only through the fixed disposable provider. It owns
 * only HTTP construction, bounded response handling, and provider-shape
 * validation. The caller must durably journal an intended mutation before
 * invoking either mutation method and must independently bind the returned
 * observations into the recovery receipt.
 *
 * Cloudflare's Version Upload API creates a version but does not deploy it.
 * Secrets are never supplied as values: every named secret is inherited from
 * one exact baseline version with `bindings_inherit=strict`.
 */

import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

export const CLOUDFLARE_DISPOSABLE_DEPLOYMENT_TRANSPORT_SCHEMA_VERSION = 1;
export const CLOUDFLARE_DISPOSABLE_DEPLOYMENT_API_ORIGIN = "https://api.cloudflare.com";

const API_PREFIX = "/client/v4";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_CHUNKS = 8 * 1024;
const MAX_MODULE_COUNT = 512;
const MAX_MODULE_BYTES = 12 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MIN_TOKEN_BYTES = 16;
const MAX_TOKEN_BYTES = 8 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/iu;
const SCRIPT_NAME_RE = /^[a-z0-9_][a-z0-9_-]*$/u;
const VECTORIZE_NAME_RE = /^[a-z]+[a-z0-9_-]*[a-z0-9]+$/u;
const BINDING_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const MODULE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const MODULE_CONTENT_TYPES = new Set([
  "application/javascript+module",
  "text/javascript+module",
  "application/javascript",
  "text/javascript",
  "text/x-python",
  "text/x-python-requirement",
  "application/wasm",
  "text/plain",
  "application/octet-stream",
  "application/source-map",
]);

export class CloudflareDisposableDeploymentTransportError extends Error {
  constructor(code) {
    super(code);
    this.name = "CloudflareDisposableDeploymentTransportError";
    this.code = code;
  }
}

function refuse(code) {
  throw new CloudflareDisposableDeploymentTransportError(code);
}

function exactKeys(value, fields) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field));
}

function onlyKeys(value, allowed, required = []) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((field) => allowed.includes(field)) &&
    required.every((field) => Object.hasOwn(value, field));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function cleanText(value, maximumBytes, code, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || value !== value.trim() || CONTROL_RE.test(value) ||
      (!allowEmpty && value.length === 0) || Buffer.byteLength(value, "utf8") > maximumBytes) {
    refuse(code);
  }
  return value;
}

function cleanAccountId(value) {
  const accountId = String(value ?? "").toLowerCase();
  if (!ACCOUNT_ID_RE.test(accountId)) refuse("CF_DISPOSABLE_TRANSPORT_TARGET_INVALID");
  return accountId;
}

function cleanUuid(value, code = "CF_DISPOSABLE_TRANSPORT_TARGET_INVALID") {
  const id = String(value ?? "").toLowerCase();
  if (!UUID_RE.test(id)) refuse(code);
  return id;
}

function cleanScriptName(value) {
  const name = cleanText(value, 255, "CF_DISPOSABLE_TRANSPORT_TARGET_INVALID");
  if (!SCRIPT_NAME_RE.test(name)) refuse("CF_DISPOSABLE_TRANSPORT_TARGET_INVALID");
  return name;
}

function cleanVectorizeName(value, code = "CF_DISPOSABLE_TRANSPORT_TARGET_INVALID") {
  const name = cleanText(value, 64, code);
  if (!VECTORIZE_NAME_RE.test(name)) refuse(code);
  return name;
}

function cleanBindingName(value) {
  const name = String(value ?? "");
  if (!BINDING_NAME_RE.test(name) || name.length > 128) {
    refuse("CF_DISPOSABLE_TRANSPORT_BINDING_INVALID");
  }
  return name;
}

function cleanCompatibilityDate(value) {
  const date = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) ||
      new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date) {
    refuse("CF_DISPOSABLE_TRANSPORT_VERSION_INPUT_INVALID");
  }
  return date;
}

function cleanNonNegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) refuse(code);
  return value;
}

function encoded(value) {
  return encodeURIComponent(value);
}

function accountPath(accountId, suffix = "") {
  return `/accounts/${encoded(cleanAccountId(accountId))}${suffix}`;
}

function apiUrl(path, query = null) {
  if (typeof path !== "string" || !path.startsWith("/accounts/") || path.includes("//") ||
      path.includes("?") || path.includes("#")) {
    refuse("CF_DISPOSABLE_TRANSPORT_TARGET_INVALID");
  }
  const expectedPathname = `${API_PREFIX}${path}`;
  const url = new URL(expectedPathname, CLOUDFLARE_DISPOSABLE_DEPLOYMENT_API_ORIGIN);
  if (query) {
    for (const [name, value] of query) url.searchParams.append(name, value);
  }
  if (url.origin !== CLOUDFLARE_DISPOSABLE_DEPLOYMENT_API_ORIGIN ||
      url.protocol !== "https:" || url.username || url.password || url.hash ||
      url.pathname !== expectedPathname ||
      !url.pathname.startsWith(`${API_PREFIX}/accounts/`)) {
    refuse("CF_DISPOSABLE_TRANSPORT_TARGET_INVALID");
  }
  return url;
}

function responseEvidence(response, rawSha256, contentType) {
  return deepFreeze({
    schema_version: CLOUDFLARE_DISPOSABLE_DEPLOYMENT_TRANSPORT_SCHEMA_VERSION,
    status: response.status,
    content_type: contentType,
    body_sha256: rawSha256,
  });
}

async function boundedJson(response, maximumBytes, signal) {
  if (!response || typeof response.status !== "number" ||
      !response.headers || typeof response.headers.get !== "function" ||
      !response.body || typeof response.body.getReader !== "function") {
    refuse("CF_DISPOSABLE_TRANSPORT_RESPONSE_INVALID");
  }
  const rawContentType = String(response.headers.get("content-type") ?? "")
    .trim().toLowerCase();
  const contentType = rawContentType === "application/json"
    ? "application/json"
    : /^application\/json\s*;\s*charset\s*=\s*"?utf-8"?$/u.test(rawContentType)
      ? "application/json; charset=utf-8"
      : null;
  if (!contentType) {
    refuse("CF_DISPOSABLE_TRANSPORT_RESPONSE_INVALID");
  }
  const declaredValue = response.headers.get("content-length");
  if (declaredValue !== null && declaredValue !== "") {
    if (!/^\d+$/u.test(declaredValue)) refuse("CF_DISPOSABLE_TRANSPORT_RESPONSE_INVALID");
    const declared = Number(declaredValue);
    if (!Number.isSafeInteger(declared)) refuse("CF_DISPOSABLE_TRANSPORT_RESPONSE_INVALID");
    if (declared > maximumBytes) refuse("CF_DISPOSABLE_TRANSPORT_RESPONSE_OVERSIZED");
  }

  let reader;
  try { reader = response.body.getReader(); }
  catch { refuse("CF_DISPOSABLE_TRANSPORT_RESPONSE_INVALID"); }
  if (!reader || typeof reader.read !== "function" || typeof reader.cancel !== "function" ||
      typeof reader.releaseLock !== "function") {
    refuse("CF_DISPOSABLE_TRANSPORT_RESPONSE_INVALID");
  }
  const cancelReader = async () => {
    try { await reader.cancel(); } catch {}
  };
  const abortMarker = Symbol("response-read-aborted");
  let resolveOnAbort;
  const aborted = new Promise((resolve) => {
    resolveOnAbort = resolve;
  });
  const onAbort = () => {
    void cancelReader();
    resolveOnAbort(abortMarker);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  const chunks = [];
  let total = 0;
  let chunkCount = 0;
  try {
    for (;;) {
      let item;
      try { item = await Promise.race([reader.read(), aborted]); }
      catch {
        refuse(signal.aborted
          ? "CF_DISPOSABLE_TRANSPORT_REQUEST_TIMEOUT"
          : "CF_DISPOSABLE_TRANSPORT_RESPONSE_INVALID");
      }
      if (item === abortMarker) refuse("CF_DISPOSABLE_TRANSPORT_REQUEST_TIMEOUT");
      if (item.done) break;
      chunkCount += 1;
      if (chunkCount > MAX_RESPONSE_CHUNKS) {
        await cancelReader();
        refuse("CF_DISPOSABLE_TRANSPORT_RESPONSE_INVALID");
      }
      if (!(item.value instanceof Uint8Array)) {
        refuse("CF_DISPOSABLE_TRANSPORT_RESPONSE_INVALID");
      }
      total += item.value.byteLength;
      if (total > maximumBytes) {
        await cancelReader();
        refuse("CF_DISPOSABLE_TRANSPORT_RESPONSE_OVERSIZED");
      }
      chunks.push(Buffer.from(item.value));
    }
    const bytes = Buffer.concat(chunks, total);
    try {
      const rawSha256 = sha256(bytes);
      let value;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        value = JSON.parse(text);
      }
      catch { refuse("CF_DISPOSABLE_TRANSPORT_RESPONSE_INVALID"); }
      return { value, rawSha256, contentType };
    } finally {
      bytes.fill(0);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    for (const chunk of chunks) chunk.fill(0);
    try { reader.releaseLock(); } catch {}
  }
}

function assertEnvelope(body, { allowResultInfo = false } = {}) {
  const fields = Object.keys(body || {}).sort();
  const base = ["errors", "messages", "result", "success"].sort();
  const withInfo = [...base, "result_info"].sort();
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      (canonical(fields) !== canonical(base) &&
       (!allowResultInfo || canonical(fields) !== canonical(withInfo))) ||
      body.success !== true || !Array.isArray(body.errors) || body.errors.length !== 0 ||
      !Array.isArray(body.messages) || body.messages.length !== 0 ||
      !Object.hasOwn(body, "result")) {
    refuse("CF_DISPOSABLE_TRANSPORT_API_REFUSED");
  }
  return body.result;
}

function cleanToken(value) {
  if (!Buffer.isBuffer(value) || value.length < MIN_TOKEN_BYTES || value.length > MAX_TOKEN_BYTES) {
    if (Buffer.isBuffer(value)) value.fill(0);
    refuse("CF_DISPOSABLE_TRANSPORT_TOKEN_INVALID");
  }
  const tokenText = value.toString("utf8");
  if (Buffer.byteLength(tokenText, "utf8") !== value.length || tokenText !== tokenText.trim() ||
      CONTROL_RE.test(tokenText)) {
    value.fill(0);
    refuse("CF_DISPOSABLE_TRANSPORT_TOKEN_INVALID");
  }
  return tokenText;
}

function bodyContainsToken(body, token) {
  if (!body || !token) return false;
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  const tokenBytes = Buffer.from(token, "utf8");
  try { return bytes.indexOf(tokenBytes) !== -1; }
  finally {
    tokenBytes.fill(0);
    if (!Buffer.isBuffer(body)) bytes.fill(0);
  }
}

function jsonContainsToken(value, token) {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (current.includes(token)) return true;
    } else if (Array.isArray(current)) {
      for (const child of current) pending.push(child);
    } else if (current && typeof current === "object") {
      for (const [name, child] of Object.entries(current)) {
        if (name.includes(token)) return true;
        pending.push(child);
      }
    }
  }
  return false;
}

async function readJsonWithToken({
  fetchImpl,
  token,
  url,
  method,
  body = undefined,
  contentType = null,
  timeoutMs,
  maximumBytes,
  mutation,
  allowResultInfo = false,
}) {
  let authorization = cleanToken(token);
  if (url.href.includes(authorization) || bodyContainsToken(body, authorization)) {
    authorization = null;
    refuse("CF_DISPOSABLE_TRANSPORT_TOKEN_PLACEMENT_REFUSED");
  }
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${authorization}`,
    "Cache-Control": "no-store",
  };
  if (contentType) headers["Content-Type"] = contentType;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    try {
      response = await fetchImpl(url, {
        method,
        body,
        headers,
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
      });
    } catch {
      const code = mutation
        ? "CF_DISPOSABLE_TRANSPORT_MUTATION_AMBIGUOUS"
        : controller.signal.aborted
          ? "CF_DISPOSABLE_TRANSPORT_REQUEST_TIMEOUT"
          : "CF_DISPOSABLE_TRANSPORT_REQUEST_FAILED";
      authorization = null;
      refuse(code);
    } finally {
      delete headers.Authorization;
    }

    try {
      if (response?.redirected === true || response?.status >= 300 && response?.status < 400) {
        refuse("CF_DISPOSABLE_TRANSPORT_REDIRECT_REFUSED");
      }
      if (response?.url) {
        let finalUrl;
        try { finalUrl = new URL(response.url); }
        catch { refuse("CF_DISPOSABLE_TRANSPORT_RESPONSE_INVALID"); }
        if (finalUrl.href !== url.href ||
            finalUrl.origin !== CLOUDFLARE_DISPOSABLE_DEPLOYMENT_API_ORIGIN) {
          refuse("CF_DISPOSABLE_TRANSPORT_REDIRECT_REFUSED");
        }
      }
      const parsed = await boundedJson(response, maximumBytes, controller.signal);
      // A provider response must never be able to reflect the bearer credential
      // into a later sanitized observation.
      if (jsonContainsToken(parsed.value, authorization)) {
        refuse("CF_DISPOSABLE_TRANSPORT_TOKEN_RESPONSE_REFUSED");
      }
      if (controller.signal.aborted) refuse("CF_DISPOSABLE_TRANSPORT_REQUEST_TIMEOUT");
      if (response.status !== 200) refuse("CF_DISPOSABLE_TRANSPORT_API_REFUSED");
      const result = assertEnvelope(parsed.value, { allowResultInfo });
      return {
        body: parsed.value,
        result,
        evidence: responseEvidence(response, parsed.rawSha256, parsed.contentType),
      };
    } catch (error) {
      if (mutation) refuse("CF_DISPOSABLE_TRANSPORT_MUTATION_AMBIGUOUS");
      if (controller.signal.aborted) refuse("CF_DISPOSABLE_TRANSPORT_REQUEST_TIMEOUT");
      if (!(error instanceof CloudflareDisposableDeploymentTransportError)) {
        refuse("CF_DISPOSABLE_TRANSPORT_RESPONSE_INVALID");
      }
      throw error;
    }
  } finally {
    clearTimeout(timeout);
    delete headers.Authorization;
    authorization = null;
  }
}

function validateMutationResult(action) {
  try { return action(); }
  catch { refuse("CF_DISPOSABLE_TRANSPORT_MUTATION_AMBIGUOUS"); }
}

function normalizeUploadBinding(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    refuse("CF_DISPOSABLE_TRANSPORT_BINDING_INVALID");
  }
  const name = cleanBindingName(binding.name);
  switch (binding.type) {
    case "ai":
      if (!exactKeys(binding, ["name", "type"])) {
        refuse("CF_DISPOSABLE_TRANSPORT_BINDING_INVALID");
      }
      return { name, type: "ai" };
    case "d1": {
      if (!exactKeys(binding, ["name", "type", "database_id"])) {
        refuse("CF_DISPOSABLE_TRANSPORT_BINDING_INVALID");
      }
      return { database_id: cleanUuid(binding.database_id,
        "CF_DISPOSABLE_TRANSPORT_BINDING_INVALID"), name, type: "d1" };
    }
    case "vectorize":
      if (!exactKeys(binding, ["name", "type", "index_name"])) {
        refuse("CF_DISPOSABLE_TRANSPORT_BINDING_INVALID");
      }
      return {
        index_name: cleanVectorizeName(binding.index_name,
          "CF_DISPOSABLE_TRANSPORT_BINDING_INVALID"),
        name,
        type: "vectorize",
      };
    case "plain_text":
      if (!exactKeys(binding, ["name", "type", "text"])) {
        refuse("CF_DISPOSABLE_TRANSPORT_BINDING_INVALID");
      }
      return {
        name,
        text: cleanText(binding.text, 16 * 1024,
          "CF_DISPOSABLE_TRANSPORT_BINDING_INVALID", { allowEmpty: true }),
        type: "plain_text",
      };
    default:
      // In particular, callers cannot provide `secret_text` or `inherit`.
      refuse("CF_DISPOSABLE_TRANSPORT_BINDING_INVALID");
  }
}

function normalizeReadBinding(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    refuse("CF_DISPOSABLE_TRANSPORT_VERSION_RESPONSE_INVALID");
  }
  const name = cleanBindingName(binding.name);
  switch (binding.type) {
    case "ai":
      if (!exactKeys(binding, ["name", "type"])) {
        refuse("CF_DISPOSABLE_TRANSPORT_VERSION_RESPONSE_INVALID");
      }
      return { name, type: "ai" };
    case "d1": {
      if (!onlyKeys(binding, ["name", "type", "database_id", "id"],
        ["name", "type"]) || (!binding.database_id && !binding.id)) {
        refuse("CF_DISPOSABLE_TRANSPORT_VERSION_RESPONSE_INVALID");
      }
      const databaseId = cleanUuid(binding.database_id ?? binding.id,
        "CF_DISPOSABLE_TRANSPORT_VERSION_RESPONSE_INVALID");
      if (binding.database_id && binding.id &&
          cleanUuid(binding.id, "CF_DISPOSABLE_TRANSPORT_VERSION_RESPONSE_INVALID") !== databaseId) {
        refuse("CF_DISPOSABLE_TRANSPORT_VERSION_RESPONSE_INVALID");
      }
      return { database_id: databaseId, name, type: "d1" };
    }
    case "vectorize":
      if (!exactKeys(binding, ["name", "type", "index_name"])) {
        refuse("CF_DISPOSABLE_TRANSPORT_VERSION_RESPONSE_INVALID");
      }
      return {
        index_name: cleanVectorizeName(binding.index_name,
          "CF_DISPOSABLE_TRANSPORT_VERSION_RESPONSE_INVALID"),
        name,
        type: "vectorize",
      };
    case "plain_text":
      if (!exactKeys(binding, ["name", "type", "text"])) {
        refuse("CF_DISPOSABLE_TRANSPORT_VERSION_RESPONSE_INVALID");
      }
      return {
        name,
        text: cleanText(binding.text, 16 * 1024,
          "CF_DISPOSABLE_TRANSPORT_VERSION_RESPONSE_INVALID", { allowEmpty: true }),
        type: "plain_text",
      };
    case "secret_text":
      // A secret value in a readback response must never be accepted or copied.
      if (!exactKeys(binding, ["name", "type"])) {
        refuse("CF_DISPOSABLE_TRANSPORT_SECRET_RESPONSE_REFUSED");
      }
      return { name, type: "secret_text" };
    default:
      refuse("CF_DISPOSABLE_TRANSPORT_VERSION_RESPONSE_INVALID");
  }
}

function normalizeBindingList(bindings, normalizer, code) {
  if (!Array.isArray(bindings) || bindings.length < 1 || bindings.length > 128) refuse(code);
  const normalized = bindings.map(normalizer).sort((left, right) =>
    compareText(left.name, right.name) || compareText(left.type, right.type));
  if (normalized.some((entry, index) => index > 0 && entry.name === normalized[index - 1].name)) {
    refuse(code);
  }
  return normalized;
}

function cleanSecretNames(values, occupiedNames) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 32) {
    refuse("CF_DISPOSABLE_TRANSPORT_SECRET_INHERITANCE_INVALID");
  }
  const names = values.map(cleanBindingName).sort();
  if (names.some((name, index) =>
    occupiedNames.has(name) || index > 0 && name === names[index - 1])) {
    refuse("CF_DISPOSABLE_TRANSPORT_SECRET_INHERITANCE_INVALID");
  }
  return names;
}

function cleanModules(records, mainModule) {
  if (!Array.isArray(records) || records.length < 1 || records.length > MAX_MODULE_COUNT) {
    refuse("CF_DISPOSABLE_TRANSPORT_MODULE_INVENTORY_INVALID");
  }
  const modules = [];
  let totalModuleBytes = 0;
  try {
    for (const record of records) {
      if (!exactKeys(record, ["name", "content_type", "bytes"]) ||
          typeof record.name !== "string" || !MODULE_NAME_RE.test(record.name) ||
          record.name.includes("//") || record.name.split("/").some((part) =>
            !part || part === "." || part === "..") || record.name.length > 256 ||
          !MODULE_CONTENT_TYPES.has(record.content_type) ||
          !(Buffer.isBuffer(record.bytes) || record.bytes instanceof Uint8Array) ||
          record.bytes.byteLength < 1 || record.bytes.byteLength > MAX_MODULE_BYTES) {
        refuse("CF_DISPOSABLE_TRANSPORT_MODULE_INVENTORY_INVALID");
      }
      totalModuleBytes += record.bytes.byteLength;
      if (totalModuleBytes > MAX_UPLOAD_BYTES) {
        refuse("CF_DISPOSABLE_TRANSPORT_UPLOAD_OVERSIZED");
      }
      modules.push({
        name: record.name,
        content_type: record.content_type,
        bytes: Buffer.from(record.bytes),
      });
    }
    modules.sort((left, right) => compareText(left.name, right.name));
    if (modules.some((entry, index) => index > 0 && entry.name === modules[index - 1].name) ||
        !modules.some((entry) => entry.name === mainModule)) {
      refuse("CF_DISPOSABLE_TRANSPORT_MODULE_INVENTORY_INVALID");
    }
    return modules;
  } catch (error) {
    for (const module of modules) module.bytes.fill(0);
    throw error;
  }
}

function multipartBoundary(metadataBytes, modules) {
  const digest = createHash("sha256").update(metadataBytes);
  for (const module of modules) {
    digest.update("\0", "utf8").update(module.name, "utf8").update("\0", "utf8")
      .update(module.content_type, "utf8").update("\0", "utf8").update(module.bytes);
  }
  const root = digest.digest("hex");
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const boundary = `financial-brain-${root.slice(0, 40)}-${suffix}`;
    const needle = Buffer.from(boundary, "ascii");
    const collision = metadataBytes.indexOf(needle) !== -1 ||
      modules.some((module) => module.bytes.indexOf(needle) !== -1);
    needle.fill(0);
    if (!collision) return boundary;
  }
  refuse("CF_DISPOSABLE_TRANSPORT_MULTIPART_INVALID");
}

function multipartBody(metadata, modules) {
  const metadataBytes = Buffer.from(canonical(metadata), "utf8");
  const boundary = multipartBoundary(metadataBytes, modules);
  const chunks = [];
  const addText = (value) => chunks.push(Buffer.from(value, "utf8"));
  addText(`--${boundary}\r\n`);
  addText('Content-Disposition: form-data; name="metadata"\r\n');
  addText("Content-Type: application/json\r\n\r\n");
  chunks.push(metadataBytes);
  addText("\r\n");
  for (const module of modules) {
    addText(`--${boundary}\r\n`);
    addText(`Content-Disposition: form-data; name="${module.name}"; ` +
      `filename="${module.name}"\r\n`);
    addText(`Content-Type: ${module.content_type}\r\n\r\n`);
    chunks.push(module.bytes);
    addText("\r\n");
  }
  addText(`--${boundary}--\r\n`);
  const totalBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  if (totalBytes > MAX_UPLOAD_BYTES) {
    for (const chunk of chunks) chunk.fill(0);
    refuse("CF_DISPOSABLE_TRANSPORT_UPLOAD_OVERSIZED");
  }
  const bytes = Buffer.concat(chunks, totalBytes);
  for (const chunk of chunks) chunk.fill(0);
  return { boundary, bytes };
}

function moduleInventory(modules, mainModule) {
  const entries = modules.map((module) => ({
    name: module.name,
    content_type: module.content_type,
    bytes: module.bytes.length,
    sha256: sha256(module.bytes),
  }));
  const inventorySha256 = sha256(canonical({ main_module: mainModule, modules: entries }));
  return deepFreeze({
    main_module: mainModule,
    modules: entries,
    sha256: inventorySha256,
  });
}

function uploadResult(value) {
  const allowed = [
    "resources", "id", "exports_reconciliation", "metadata", "number", "startup_time_ms",
  ];
  if (!onlyKeys(value, allowed, ["id"])) {
    refuse("CF_DISPOSABLE_TRANSPORT_UPLOAD_RESPONSE_INVALID");
  }
  const versionId = cleanUuid(value.id, "CF_DISPOSABLE_TRANSPORT_UPLOAD_RESPONSE_INVALID");
  if (value.resources !== undefined &&
      (!value.resources || typeof value.resources !== "object" || Array.isArray(value.resources)) ||
      value.exports_reconciliation !== undefined &&
      (!value.exports_reconciliation || typeof value.exports_reconciliation !== "object" ||
       Array.isArray(value.exports_reconciliation)) ||
      value.metadata !== undefined &&
      (!value.metadata || typeof value.metadata !== "object" || Array.isArray(value.metadata)) ||
      value.number !== undefined && (!Number.isSafeInteger(value.number) || value.number < 1) ||
      value.startup_time_ms !== undefined &&
      (typeof value.startup_time_ms !== "number" || !Number.isFinite(value.startup_time_ms) ||
       value.startup_time_ms < 0)) {
    refuse("CF_DISPOSABLE_TRANSPORT_UPLOAD_RESPONSE_INVALID");
  }
  let scriptEtag = null;
  if (value.resources?.script?.etag !== undefined) {
    scriptEtag = cleanText(value.resources.script.etag, 256,
      "CF_DISPOSABLE_TRANSPORT_UPLOAD_RESPONSE_INVALID");
  }
  return { versionId, scriptEtag };
}

function deploymentVersions(value, code) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) refuse(code);
  const versions = value.map((entry) => {
    if (!exactKeys(entry, ["percentage", "version_id"]) ||
        typeof entry.percentage !== "number" || !Number.isFinite(entry.percentage) ||
        entry.percentage < 0.01 || entry.percentage > 100) {
      refuse(code);
    }
    return {
      percentage: entry.percentage,
      version_id: cleanUuid(entry.version_id, code),
    };
  });
  if (new Set(versions.map((entry) => entry.version_id)).size !== versions.length ||
      Math.abs(versions.reduce((sum, entry) => sum + entry.percentage, 0) - 100) > 1e-9) {
    refuse(code);
  }
  return versions.sort((left, right) => compareText(left.version_id, right.version_id));
}

function normalizeDeployment(value, code) {
  const allowed = [
    "id", "created_on", "source", "strategy", "versions", "annotations", "author_email",
  ];
  if (!onlyKeys(value, allowed, ["id", "created_on", "source", "strategy", "versions"]) ||
      typeof value.created_on !== "string" ||
      !Number.isFinite(Date.parse(value.created_on)) || typeof value.source !== "string" ||
      value.strategy !== "percentage" ||
      value.annotations !== undefined &&
      (!value.annotations || typeof value.annotations !== "object" ||
       Array.isArray(value.annotations)) ||
      value.author_email !== undefined && typeof value.author_email !== "string") {
    refuse(code);
  }
  return {
    deploymentId: cleanUuid(value.id, code),
    versions: deploymentVersions(value.versions, code),
  };
}

function normalizeVersionReadback(value, expected) {
  if (!onlyKeys(value, ["resources", "id", "metadata", "number"],
    ["resources", "id"])) {
    refuse("CF_DISPOSABLE_TRANSPORT_VERSION_RESPONSE_INVALID");
  }
  const versionId = cleanUuid(value.id, "CF_DISPOSABLE_TRANSPORT_VERSION_RESPONSE_INVALID");
  const resources = value.resources;
  if (!exactKeys(resources, ["bindings", "script", "script_runtime"])) {
    refuse("CF_DISPOSABLE_TRANSPORT_VERSION_RESPONSE_INVALID");
  }
  const script = resources.script;
  if (!exactKeys(script, ["etag", "handlers", "last_deployed_from", "named_handlers"]) ||
      !Array.isArray(script.handlers) || !Array.isArray(script.named_handlers) ||
      script.named_handlers.some((entry) =>
        !onlyKeys(entry, ["handlers", "name"], ["handlers", "name"]) ||
        !Array.isArray(entry.handlers) || typeof entry.name !== "string") ||
      script.last_deployed_from !== "api") {
    refuse("CF_DISPOSABLE_TRANSPORT_VERSION_RESPONSE_INVALID");
  }
  const scriptEtag = cleanText(script.etag, 256,
    "CF_DISPOSABLE_TRANSPORT_VERSION_RESPONSE_INVALID");
  const handlers = script.handlers.map((handler) => cleanText(handler, 128,
    "CF_DISPOSABLE_TRANSPORT_VERSION_RESPONSE_INVALID")).sort();
  if (new Set(handlers).size !== handlers.length ||
      canonical(handlers) !== canonical([...expected.handlers].sort())) {
    refuse("CF_DISPOSABLE_TRANSPORT_VERSION_MISMATCH");
  }
  const runtime = resources.script_runtime;
  if (!onlyKeys(runtime, [
    "compatibility_date", "compatibility_flags", "exports", "limits", "migration_tag",
    "usage_model",
  ], ["compatibility_date", "usage_model"]) ||
      runtime.compatibility_date !== expected.compatibility_date ||
      runtime.usage_model !== "standard") {
    refuse("CF_DISPOSABLE_TRANSPORT_VERSION_MISMATCH");
  }
  const bindings = normalizeBindingList(resources.bindings, normalizeReadBinding,
    "CF_DISPOSABLE_TRANSPORT_VERSION_RESPONSE_INVALID");
  if (canonical(bindings) !== canonical(expected.bindings)) {
    refuse("CF_DISPOSABLE_TRANSPORT_VERSION_MISMATCH");
  }
  const withoutMode = expected.mode_binding_name === null
    ? bindings
    : bindings.filter((binding) => binding.name !== expected.mode_binding_name);
  return {
    versionId,
    scriptEtag,
    handlers,
    bindingsSha256: sha256(canonical(bindings)),
    bindingsWithoutModeSha256: sha256(canonical(withoutMode)),
    namedHandlersCount: script.named_handlers.length,
  };
}

function cleanVersionExpectation(value) {
  if (!exactKeys(value, [
    "compatibility_date", "handlers", "bindings", "mode_binding_name",
  ]) || !Array.isArray(value.handlers) || value.handlers.length < 1 ||
      value.handlers.length > 16 ||
      (value.mode_binding_name !== null && typeof value.mode_binding_name !== "string")) {
    refuse("CF_DISPOSABLE_TRANSPORT_VERSION_INPUT_INVALID");
  }
  const handlers = value.handlers.map((handler) => cleanText(handler, 128,
    "CF_DISPOSABLE_TRANSPORT_VERSION_INPUT_INVALID")).sort();
  if (new Set(handlers).size !== handlers.length) {
    refuse("CF_DISPOSABLE_TRANSPORT_VERSION_INPUT_INVALID");
  }
  const bindings = normalizeBindingList(value.bindings, normalizeReadBinding,
    "CF_DISPOSABLE_TRANSPORT_VERSION_INPUT_INVALID");
  const modeBindingName = value.mode_binding_name === null
    ? null
    : cleanBindingName(value.mode_binding_name);
  if (modeBindingName && !bindings.some((binding) => binding.name === modeBindingName)) {
    refuse("CF_DISPOSABLE_TRANSPORT_VERSION_INPUT_INVALID");
  }
  return {
    compatibility_date: cleanCompatibilityDate(value.compatibility_date),
    handlers,
    bindings,
    mode_binding_name: modeBindingName,
  };
}

function validateResultInfo(value, resultLength) {
  if (value === undefined) return;
  if (!onlyKeys(value, ["count", "page", "per_page", "total_count", "total_pages"]) ||
      Object.values(value).some((entry) => !Number.isSafeInteger(entry) || entry < 0) ||
      value.count !== undefined && value.count !== resultLength ||
      value.page !== undefined && value.page !== 1 ||
      value.total_pages !== undefined && value.total_pages > 1) {
    refuse("CF_DISPOSABLE_TRANSPORT_RESOURCE_RESPONSE_INVALID");
  }
}

function cleanResourceRequest(value) {
  if (!exactKeys(value, [
    "account_id", "script_name", "database", "vectorize", "expected",
  ]) || !exactKeys(value.database, ["id", "name"]) ||
      !exactKeys(value.vectorize, ["name", "dimensions", "metric"]) ||
      !exactKeys(value.expected, [
        "workers_dev_enabled", "previews_enabled", "routes_count",
        "custom_domains_count", "schedules",
      ]) || typeof value.expected.workers_dev_enabled !== "boolean" ||
      typeof value.expected.previews_enabled !== "boolean" ||
      !Array.isArray(value.expected.schedules) || value.expected.schedules.length > 64) {
    refuse("CF_DISPOSABLE_TRANSPORT_RESOURCE_INPUT_INVALID");
  }
  const dimensions = cleanNonNegativeInteger(value.vectorize.dimensions,
    "CF_DISPOSABLE_TRANSPORT_RESOURCE_INPUT_INVALID");
  if (dimensions < 1 || dimensions > 1536 ||
      !["cosine", "euclidean", "dot-product"].includes(value.vectorize.metric)) {
    refuse("CF_DISPOSABLE_TRANSPORT_RESOURCE_INPUT_INVALID");
  }
  const schedules = value.expected.schedules.map((cron) => cleanText(cron, 256,
    "CF_DISPOSABLE_TRANSPORT_RESOURCE_INPUT_INVALID")).sort();
  if (new Set(schedules).size !== schedules.length) {
    refuse("CF_DISPOSABLE_TRANSPORT_RESOURCE_INPUT_INVALID");
  }
  return {
    accountId: cleanAccountId(value.account_id),
    scriptName: cleanScriptName(value.script_name),
    databaseId: cleanUuid(value.database.id),
    databaseName: cleanText(value.database.name, 128,
      "CF_DISPOSABLE_TRANSPORT_RESOURCE_INPUT_INVALID"),
    vectorizeName: cleanVectorizeName(value.vectorize.name),
    dimensions,
    metric: value.vectorize.metric,
    expected: {
      workersDevEnabled: value.expected.workers_dev_enabled,
      previewsEnabled: value.expected.previews_enabled,
      routesCount: cleanNonNegativeInteger(value.expected.routes_count,
        "CF_DISPOSABLE_TRANSPORT_RESOURCE_INPUT_INVALID"),
      customDomainsCount: cleanNonNegativeInteger(value.expected.custom_domains_count,
        "CF_DISPOSABLE_TRANSPORT_RESOURCE_INPUT_INVALID"),
      schedules,
    },
  };
}

/**
 * Create a transport with no ambient credential or network dependency.
 * `resolveToken` must return a fresh Buffer; that buffer is wiped after use.
 */
export function createCloudflareDisposableDeploymentTransport({
  fetchImpl,
  resolveToken,
  requestTimeoutMs = DEFAULT_TIMEOUT_MS,
  maximumResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) {
  if (typeof fetchImpl !== "function" || typeof resolveToken !== "function" ||
      !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 ||
      requestTimeoutMs > 300_000 || !Number.isSafeInteger(maximumResponseBytes) ||
      maximumResponseBytes < 1 || maximumResponseBytes > MAX_RESPONSE_BYTES) {
    refuse("CF_DISPOSABLE_TRANSPORT_DEPENDENCY_INVALID");
  }

  const withToken = async (action) => {
    let token;
    try {
      try { token = await resolveToken(); }
      catch { refuse("CF_DISPOSABLE_TRANSPORT_TOKEN_UNAVAILABLE"); }
      if (!Buffer.isBuffer(token)) refuse("CF_DISPOSABLE_TRANSPORT_TOKEN_INVALID");
      return await action(token);
    } finally {
      if (Buffer.isBuffer(token)) token.fill(0);
      token = null;
    }
  };

  const request = (token, values) => readJsonWithToken({
    fetchImpl,
    token,
    timeoutMs: requestTimeoutMs,
    maximumBytes: maximumResponseBytes,
    ...values,
  });

  async function uploadVersion(input) {
    if (!exactKeys(input, [
      "account_id", "script_name", "main_module", "modules", "compatibility_date",
      "bindings", "secret_names", "baseline_version_id", "tag", "message",
    ])) {
      refuse("CF_DISPOSABLE_TRANSPORT_VERSION_INPUT_INVALID");
    }
    const accountId = cleanAccountId(input.account_id);
    const scriptName = cleanScriptName(input.script_name);
    const mainModule = cleanText(input.main_module, 256,
      "CF_DISPOSABLE_TRANSPORT_MODULE_INVENTORY_INVALID");
    if (!MODULE_NAME_RE.test(mainModule) || mainModule.includes("//") ||
        mainModule.split("/").some((part) => !part || part === "." || part === "..")) {
      refuse("CF_DISPOSABLE_TRANSPORT_MODULE_INVENTORY_INVALID");
    }
    const compatibilityDate = cleanCompatibilityDate(input.compatibility_date);
    const baselineVersionId = cleanUuid(input.baseline_version_id,
      "CF_DISPOSABLE_TRANSPORT_SECRET_INHERITANCE_INVALID");
    const tag = cleanText(input.tag, 100, "CF_DISPOSABLE_TRANSPORT_VERSION_INPUT_INVALID");
    const message = cleanText(input.message, 1000,
      "CF_DISPOSABLE_TRANSPORT_VERSION_INPUT_INVALID");
    const bindings = normalizeBindingList(input.bindings, normalizeUploadBinding,
      "CF_DISPOSABLE_TRANSPORT_BINDING_INVALID");
    const secretNames = cleanSecretNames(input.secret_names,
      new Set(bindings.map((binding) => binding.name)));
    const inherited = secretNames.map((name) => ({
      name,
      type: "inherit",
      version_id: baselineVersionId,
    }));
    const allBindings = [...bindings, ...inherited].sort((left, right) =>
      compareText(left.name, right.name));
    const modules = cleanModules(input.modules, mainModule);
    let body;
    try {
      const inventory = moduleInventory(modules, mainModule);
      const metadata = {
        annotations: {
          "workers/message": message,
          "workers/tag": tag,
        },
        bindings: allBindings,
        compatibility_date: compatibilityDate,
        main_module: mainModule,
        usage_model: "standard",
      };
      const metadataSha256 = sha256(canonical(metadata));
      const multipart = multipartBody(metadata, modules);
      body = multipart.bytes;
      const requestBodySha256 = sha256(body);
      const url = apiUrl(accountPath(accountId,
        `/workers/scripts/${encoded(scriptName)}/versions`), [["bindings_inherit", "strict"]]);
      const response = await withToken((token) => request(token, {
        url,
        method: "POST",
        body,
        contentType: `multipart/form-data; boundary=${multipart.boundary}`,
        mutation: true,
      }));
      const uploaded = validateMutationResult(() => uploadResult(response.result));
      return deepFreeze({
        schema_version: CLOUDFLARE_DISPOSABLE_DEPLOYMENT_TRANSPORT_SCHEMA_VERSION,
        operation: "upload_version",
        version_id: uploaded.versionId,
        script_etag: uploaded.scriptEtag,
        deployed: false,
        request: {
          body_sha256: requestBodySha256,
          metadata_sha256: metadataSha256,
          bindings_sha256: sha256(canonical(allBindings)),
          module_inventory_sha256: inventory.sha256,
          module_count: inventory.modules.length,
        },
        response: response.evidence,
      });
    } finally {
      if (body) body.fill(0);
      for (const module of modules) module.bytes.fill(0);
    }
  }

  async function readVersion(input) {
    if (!exactKeys(input, ["account_id", "script_name", "version_id", "expected"])) {
      refuse("CF_DISPOSABLE_TRANSPORT_VERSION_INPUT_INVALID");
    }
    const accountId = cleanAccountId(input.account_id);
    const scriptName = cleanScriptName(input.script_name);
    const versionId = cleanUuid(input.version_id,
      "CF_DISPOSABLE_TRANSPORT_VERSION_INPUT_INVALID");
    const expected = cleanVersionExpectation(input.expected);
    const url = apiUrl(accountPath(accountId,
      `/workers/scripts/${encoded(scriptName)}/versions/${encoded(versionId)}`));
    const response = await withToken((token) => request(token, {
      url,
      method: "GET",
      mutation: false,
    }));
    const readback = normalizeVersionReadback(response.result, expected);
    if (readback.versionId !== versionId) {
      refuse("CF_DISPOSABLE_TRANSPORT_VERSION_MISMATCH");
    }
    return deepFreeze({
      schema_version: CLOUDFLARE_DISPOSABLE_DEPLOYMENT_TRANSPORT_SCHEMA_VERSION,
      operation: "read_version",
      version_id: versionId,
      script_etag: readback.scriptEtag,
      bindings_sha256: readback.bindingsSha256,
      bindings_without_mode_sha256: readback.bindingsWithoutModeSha256,
      bindings_exact: true,
      compatibility_and_usage_model_exact: true,
      handlers: readback.handlers,
      named_handlers_count: readback.namedHandlersCount,
      response: response.evidence,
    });
  }

  async function deployVersion(input) {
    if (!exactKeys(input, ["account_id", "script_name", "version_id"])) {
      refuse("CF_DISPOSABLE_TRANSPORT_DEPLOYMENT_INPUT_INVALID");
    }
    const accountId = cleanAccountId(input.account_id);
    const scriptName = cleanScriptName(input.script_name);
    const versionId = cleanUuid(input.version_id,
      "CF_DISPOSABLE_TRANSPORT_DEPLOYMENT_INPUT_INVALID");
    const body = Buffer.from(canonical({
      strategy: "percentage",
      versions: [{ percentage: 100, version_id: versionId }],
    }), "utf8");
    try {
      const url = apiUrl(accountPath(accountId,
        `/workers/scripts/${encoded(scriptName)}/deployments`));
      const response = await withToken((token) => request(token, {
        url,
        method: "POST",
        body,
        contentType: "application/json",
        mutation: true,
      }));
      const deployment = validateMutationResult(() => {
        const value = normalizeDeployment(response.result,
          "CF_DISPOSABLE_TRANSPORT_DEPLOYMENT_RESPONSE_INVALID");
        if (value.versions.length !== 1 ||
            value.versions[0].version_id !== versionId ||
            value.versions[0].percentage !== 100) {
          refuse("CF_DISPOSABLE_TRANSPORT_DEPLOYMENT_MISMATCH");
        }
        return value;
      });
      return deepFreeze({
        schema_version: CLOUDFLARE_DISPOSABLE_DEPLOYMENT_TRANSPORT_SCHEMA_VERSION,
        operation: "deploy_version",
        accepted: true,
        deployment_id: deployment.deploymentId,
        version_id: versionId,
        percentage: 100,
        request_body_sha256: sha256(body),
        response: response.evidence,
      });
    } finally {
      body.fill(0);
    }
  }

  async function readCurrentDeployment(input) {
    if (!exactKeys(input, ["account_id", "script_name"])) {
      refuse("CF_DISPOSABLE_TRANSPORT_DEPLOYMENT_INPUT_INVALID");
    }
    const accountId = cleanAccountId(input.account_id);
    const scriptName = cleanScriptName(input.script_name);
    const url = apiUrl(accountPath(accountId,
      `/workers/scripts/${encoded(scriptName)}/deployments`));
    const response = await withToken((token) => request(token, {
      url,
      method: "GET",
      mutation: false,
    }));
    if (!exactKeys(response.result, ["deployments"]) ||
        !Array.isArray(response.result.deployments) ||
        response.result.deployments.length < 1) {
      refuse("CF_DISPOSABLE_TRANSPORT_DEPLOYMENT_RESPONSE_INVALID");
    }
    const deployment = normalizeDeployment(response.result.deployments[0],
      "CF_DISPOSABLE_TRANSPORT_DEPLOYMENT_RESPONSE_INVALID");
    return deepFreeze({
      schema_version: CLOUDFLARE_DISPOSABLE_DEPLOYMENT_TRANSPORT_SCHEMA_VERSION,
      operation: "read_current_deployment",
      deployment_id: deployment.deploymentId,
      strategy: "percentage",
      versions: deployment.versions,
      response: response.evidence,
    });
  }

  async function readDeployment(input) {
    if (!exactKeys(input, ["account_id", "deployment_id", "script_name"])) {
      refuse("CF_DISPOSABLE_TRANSPORT_DEPLOYMENT_INPUT_INVALID");
    }
    const accountId = cleanAccountId(input.account_id);
    const scriptName = cleanScriptName(input.script_name);
    const deploymentId = cleanUuid(input.deployment_id,
      "CF_DISPOSABLE_TRANSPORT_DEPLOYMENT_INPUT_INVALID");
    const url = apiUrl(accountPath(accountId,
      `/workers/scripts/${encoded(scriptName)}/deployments/${encoded(deploymentId)}`));
    const response = await withToken((token) => request(token, {
      url,
      method: "GET",
      mutation: false,
    }));
    const deployment = normalizeDeployment(response.result,
      "CF_DISPOSABLE_TRANSPORT_DEPLOYMENT_RESPONSE_INVALID");
    if (deployment.deploymentId !== deploymentId) {
      refuse("CF_DISPOSABLE_TRANSPORT_DEPLOYMENT_MISMATCH");
    }
    return deepFreeze({
      schema_version: CLOUDFLARE_DISPOSABLE_DEPLOYMENT_TRANSPORT_SCHEMA_VERSION,
      operation: "read_deployment",
      deployment_id: deployment.deploymentId,
      strategy: "percentage",
      versions: deployment.versions,
      response: response.evidence,
    });
  }

  async function readResourceContract(input) {
    const value = cleanResourceRequest(input);
    const base = accountPath(value.accountId);
    const scriptPath = `/workers/scripts/${encoded(value.scriptName)}`;
    return withToken(async (token) => {
      const observations = [];
      const get = async (label, path, query = null, allowResultInfo = false) => {
        const result = await request(token, {
          url: apiUrl(`${base}${path}`, query),
          method: "GET",
          mutation: false,
          allowResultInfo,
        });
        observations.push({ operation: label, ...result.evidence });
        return result;
      };

      const scriptsResponse = await get("list_workers", "/workers/scripts");
      if (!Array.isArray(scriptsResponse.result)) {
        refuse("CF_DISPOSABLE_TRANSPORT_RESOURCE_RESPONSE_INVALID");
      }
      const scripts = scriptsResponse.result.filter((entry) => entry?.id === value.scriptName);
      const scriptFields = [
        "id", "cache_options", "compatibility_date", "compatibility_flags", "created_on",
        "etag", "exports", "handlers", "has_assets", "has_modules", "last_deployed_from",
        "logpush", "migration_tag", "modified_on", "named_handlers", "observability",
        "placement", "placement_mode", "placement_status", "routes", "tag", "tags",
        "tail_consumers", "usage_model",
      ];
      if (scripts.length !== 1 || !onlyKeys(scripts[0], scriptFields, ["id", "routes"]) ||
          !Array.isArray(scripts[0].routes) || scripts[0].routes.some((route) =>
            !onlyKeys(route, ["id", "pattern", "script"], ["id", "pattern"]) ||
            typeof route.id !== "string" || typeof route.pattern !== "string" ||
            route.script !== undefined && route.script !== value.scriptName)) {
        refuse("CF_DISPOSABLE_TRANSPORT_RESOURCE_RESPONSE_INVALID");
      }
      const routesCount = scripts[0].routes.length;

      const subdomainResponse = await get("read_worker_subdomain", `${scriptPath}/subdomain`);
      if (!exactKeys(subdomainResponse.result, ["enabled", "previews_enabled"]) ||
          typeof subdomainResponse.result.enabled !== "boolean" ||
          typeof subdomainResponse.result.previews_enabled !== "boolean") {
        refuse("CF_DISPOSABLE_TRANSPORT_RESOURCE_RESPONSE_INVALID");
      }

      const schedulesResponse = await get("read_worker_schedules", `${scriptPath}/schedules`);
      if (!exactKeys(schedulesResponse.result, ["schedules"]) ||
          !Array.isArray(schedulesResponse.result.schedules)) {
        refuse("CF_DISPOSABLE_TRANSPORT_RESOURCE_RESPONSE_INVALID");
      }
      const schedules = schedulesResponse.result.schedules.map((schedule) => {
        if (!onlyKeys(schedule, ["cron", "created_on", "modified_on"], ["cron"]) ||
            typeof schedule.cron !== "string") {
          refuse("CF_DISPOSABLE_TRANSPORT_RESOURCE_RESPONSE_INVALID");
        }
        return cleanText(schedule.cron, 256,
          "CF_DISPOSABLE_TRANSPORT_RESOURCE_RESPONSE_INVALID");
      }).sort();

      const domainsResponse = await get("list_worker_domains", "/workers/domains",
        [["service", value.scriptName]], true);
      if (!Array.isArray(domainsResponse.result) || domainsResponse.result.some((domain) =>
        !onlyKeys(domain, [
          "id", "cert_id", "environment", "hostname", "service", "zone_id", "zone_name",
        ], ["id", "cert_id", "hostname", "service", "zone_id", "zone_name"]) ||
        domain.service !== value.scriptName || typeof domain.id !== "string" ||
        typeof domain.cert_id !== "string" ||
        domain.environment !== undefined && typeof domain.environment !== "string" ||
        typeof domain.hostname !== "string" || typeof domain.zone_id !== "string" ||
        typeof domain.zone_name !== "string")) {
        refuse("CF_DISPOSABLE_TRANSPORT_RESOURCE_RESPONSE_INVALID");
      }
      validateResultInfo(domainsResponse.body.result_info, domainsResponse.result.length);
      const customDomainsCount = domainsResponse.result.length;

      const d1Response = await get("read_d1_database",
        `/d1/database/${encoded(value.databaseId)}`, [["fields", "uuid,name"]]);
      if (!exactKeys(d1Response.result, ["name", "uuid"]) ||
          d1Response.result.uuid !== value.databaseId ||
          d1Response.result.name !== value.databaseName) {
        refuse("CF_DISPOSABLE_TRANSPORT_RESOURCE_MISMATCH");
      }

      const vectorResponse = await get("read_vectorize_index",
        `/vectorize/v2/indexes/${encoded(value.vectorizeName)}`);
      if (!onlyKeys(vectorResponse.result,
        ["config", "created_on", "description", "modified_on", "name"],
        ["config", "name"]) || vectorResponse.result.name !== value.vectorizeName ||
          !exactKeys(vectorResponse.result.config, ["dimensions", "metric"]) ||
          vectorResponse.result.config.dimensions !== value.dimensions ||
          vectorResponse.result.config.metric !== value.metric) {
        refuse("CF_DISPOSABLE_TRANSPORT_RESOURCE_MISMATCH");
      }

      const vectorInfoResponse = await get("read_vectorize_info",
        `/vectorize/v2/indexes/${encoded(value.vectorizeName)}/info`);
      if (!onlyKeys(vectorInfoResponse.result, [
        "dimensions", "processedUpToDatetime", "processedUpToMutation", "vectorCount",
      ], ["dimensions", "vectorCount"]) ||
          vectorInfoResponse.result.dimensions !== value.dimensions ||
          !Number.isSafeInteger(vectorInfoResponse.result.vectorCount) ||
          vectorInfoResponse.result.vectorCount < 0) {
        refuse("CF_DISPOSABLE_TRANSPORT_RESOURCE_MISMATCH");
      }

      if (routesCount !== value.expected.routesCount ||
          customDomainsCount !== value.expected.customDomainsCount ||
          subdomainResponse.result.enabled !== value.expected.workersDevEnabled ||
          subdomainResponse.result.previews_enabled !== value.expected.previewsEnabled ||
          canonical(schedules) !== canonical(value.expected.schedules)) {
        refuse("CF_DISPOSABLE_TRANSPORT_RESOURCE_MISMATCH");
      }

      return deepFreeze({
        schema_version: CLOUDFLARE_DISPOSABLE_DEPLOYMENT_TRANSPORT_SCHEMA_VERSION,
        operation: "read_resource_contract",
        worker_exists: true,
        d1_exists: true,
        vectorize_exists: true,
        d1_name_and_id_exact: true,
        vectorize_name_exact: true,
        vector_dimensions: value.dimensions,
        vector_metric: value.metric,
        vector_count: vectorInfoResponse.result.vectorCount,
        workers_dev_enabled: subdomainResponse.result.enabled,
        previews_enabled: subdomainResponse.result.previews_enabled,
        routes_count: routesCount,
        custom_domains_count: customDomainsCount,
        schedules_count: schedules.length,
        provider_readback: true,
        responses: observations,
      });
    });
  }

  return Object.freeze({
    uploadVersion,
    readVersion,
    deployVersion,
    readCurrentDeployment,
    readDeployment,
    readResourceContract,
  });
}
