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

import {
  assertV048ExclusiveCampaignResourceCustodyAuthority,
  verifyV048ExclusiveCampaignResourceCustodyWithAuthority,
} from "./v048-exclusive-resource-custody-contract.mjs";
import {
  normalizeV048WorkerReferenceSnapshot,
} from "./v048-worker-reference-contract.mjs";
import {
  assertV048SourceWorkerVersion,
} from "./v048-worker-version-contract.mjs";

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
const CAMPAIGN_WORKER_PAGE_SIZE = 100;
const MAX_ACCOUNT_WORKERS = 10_000;
const MIN_TOKEN_BYTES = 16;
const MAX_TOKEN_BYTES = 8 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/iu;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const SCRIPT_NAME_RE = /^[a-z0-9_][a-z0-9_-]*$/u;
const VECTORIZE_NAME_RE = /^[a-z]+[a-z0-9_-]*[a-z0-9]+$/u;
const BINDING_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const MODULE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const WORKER_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u;
const PROVISION_WORKER_ID_RE = /^[a-f0-9]{32}$/iu;
const CAMPAIGN_PROOF_HASH_DOMAIN =
  "financial-brain:v0.4.8:disposable-campaign-transport-proof:v1";
const RESOURCE_INSTANCE_HASH_DOMAIN =
  "financial-brain:v0.4.8:disposable-resource-instance:v1";
const VECTORIZE_INSTANCE_AUTHORITY_HASH_DOMAIN =
  "financial-brain:v0.4.8:disposable-vectorize-instance-authority:v1";
const WORKER_IDENTITY_HASH_DOMAIN =
  "financial-brain:v0.4.8:disposable-worker-identity:v1";
const REVIEWED_GENERATION_HASH_DOMAIN =
  "financial-brain:v0.4.8:disposable-reviewed-worker-generation:v1";
const WORKER_GENERATION_HASH_DOMAIN =
  "financial-brain:v0.4.8:disposable-worker-generation:v1";
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

function domainHash(domain, value) {
  const serialized = canonical(value);
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(String(Buffer.byteLength(serialized)), "ascii")
    .update("\0", "utf8")
    .update(serialized, "utf8")
    .digest("hex");
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

function cleanSha256(value, code) {
  const hash = String(value ?? "").toLowerCase();
  if (!SHA256_RE.test(hash)) refuse(code);
  return hash;
}

function cleanWorkerId(value, code) {
  const id = String(value ?? "");
  if (!WORKER_ID_RE.test(id)) refuse(code);
  return id;
}

function cleanProvisionWorkerId(
  value,
  code = "CF_DISPOSABLE_TRANSPORT_TARGET_INVALID",
) {
  const id = String(value ?? "").toLowerCase();
  if (!PROVISION_WORKER_ID_RE.test(id)) refuse(code);
  return id;
}

function cleanWorkersDevDomain(value, workerName, code) {
  const domain = cleanText(value, 253, code);
  if (domain.endsWith(".") || domain.split(".").some((label) => !DNS_LABEL_RE.test(label)) ||
      !domain.startsWith(`${workerName}.`) || !domain.endsWith(".workers.dev") ||
      domain === `${workerName}.workers.dev`) {
    refuse(code);
  }
  return domain;
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

function assertAbsentEnvelope(body) {
  const fields = ["errors", "messages", "result", "success"].sort();
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      canonical(Object.keys(body).sort()) !== canonical(fields) ||
      body.success !== false || body.result !== null ||
      !Array.isArray(body.messages) || body.messages.length !== 0 ||
      !Array.isArray(body.errors) || body.errors.length < 1 || body.errors.length > 16 ||
      body.errors.some((entry) => !onlyKeys(entry, ["code", "message"], ["code", "message"]) ||
        !Number.isSafeInteger(entry.code) || typeof entry.message !== "string" ||
        entry.message.length < 1 || entry.message.length > 4096 || CONTROL_RE.test(entry.message))) {
    refuse("CF_DISPOSABLE_TRANSPORT_ABSENCE_RESPONSE_INVALID");
  }
  return null;
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
  allowAbsent404 = false,
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
      if (allowAbsent404 && response.status === 404) {
        assertAbsentEnvelope(parsed.value);
        return {
          absent: true,
          body: parsed.value,
          result: null,
          evidence: responseEvidence(response, parsed.rawSha256, parsed.contentType),
        };
      }
      if (response.status !== 200) refuse("CF_DISPOSABLE_TRANSPORT_API_REFUSED");
      const result = assertEnvelope(parsed.value, { allowResultInfo });
      return {
        absent: false,
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
      if (!(exactKeys(binding, ["name", "type"]) ||
          exactKeys(binding, ["name", "project", "type"])) ||
          (Object.hasOwn(binding, "project") && binding.project !== "<catalog>")) {
        refuse("CF_DISPOSABLE_TRANSPORT_VERSION_RESPONSE_INVALID");
      }
      // Cloudflare may expose the catalog marker in version readback. It is
      // validated here but excluded from the upload-shape comparison because
      // callers do not send this provider-owned field.
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

function cleanProvisionSecretBindings(values, occupiedNames) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 8) {
    refuse("CF_DISPOSABLE_TRANSPORT_SECRET_INPUT_INVALID");
  }
  const bindings = values.map((value) => {
    if (!exactKeys(value, ["name", "text"])) {
      refuse("CF_DISPOSABLE_TRANSPORT_SECRET_INPUT_INVALID");
    }
    const name = cleanBindingName(value.name);
    if (occupiedNames.has(name) || typeof value.text !== "string" ||
        value.text !== value.text.trim() || value.text.length < 16 ||
        Buffer.byteLength(value.text, "utf8") > 4096 || CONTROL_RE.test(value.text)) {
      refuse("CF_DISPOSABLE_TRANSPORT_SECRET_INPUT_INVALID");
    }
    return { name, text: value.text, type: "secret_text" };
  }).sort((left, right) => compareText(left.name, right.name));
  if (bindings.some((entry, index) =>
    index > 0 && entry.name === bindings[index - 1].name)) {
    refuse("CF_DISPOSABLE_TRANSPORT_SECRET_INPUT_INVALID");
  }
  return bindings;
}

function containsAnySecret(value, secrets) {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (secrets.some((secret) => current.includes(secret))) return true;
    } else if (Array.isArray(current)) {
      for (const child of current) pending.push(child);
    } else if (current && typeof current === "object") {
      for (const child of Object.values(current)) pending.push(child);
    }
  }
  return false;
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

function reviewedWorkerGeneration(version, protection) {
  const code = "CF_DISPOSABLE_TRANSPORT_WORKER_GENERATION_INVALID";
  try {
    const resources = version?.resources;
    const bindings = resources?.bindings;
    const script = resources?.script;
    const runtime = resources?.script_runtime;
    if (!Array.isArray(bindings) || !script || !runtime) refuse(code);
    const one = (type, name) => {
      const matches = bindings.filter((entry) => entry?.type === type && entry?.name === name);
      if (matches.length !== 1) refuse(code);
      return matches[0];
    };
    const database = one("d1", "DB");
    const vectorize = one("vectorize", "VECTORIZE");
    const binding = Object.freeze({
      clientSlug: one("plain_text", "BRAIN_NAME").text,
      databaseId: database.database_id,
      displayName: one("plain_text", "BRAIN_OWNER").text,
      productVersion: one("plain_text", "BRAIN_VERSION").text,
      vectorizeIndex: vectorize.index_name,
    });
    const projected = Object.freeze({
      id: version.id,
      resources: Object.freeze({
        bindings,
        script: Object.freeze({
          etag: script.etag,
          handlers: script.handlers,
          last_deployed_from: script.last_deployed_from,
          named_handlers: script.named_handlers,
        }),
        script_runtime: Object.freeze({
          compatibility_date: runtime.compatibility_date,
          usage_model: runtime.usage_model,
        }),
      }),
    });
    const inspected = assertV048SourceWorkerVersion(
      projected,
      binding,
      cleanSha256(script.etag, code),
      protection.role === "source"
        ? { role: "source" }
        : { role: "target", expectedMode: protection.expectedMode },
    );
    return domainHash(REVIEWED_GENERATION_HASH_DOMAIN, {
      schema_version: 1,
      role: protection.role,
      mode: protection.role === "source" ? "active" : protection.expectedMode,
      version_id: cleanUuid(inspected.versionId, code),
      script_etag: script.etag,
      secret_names: inspected.secretNames,
      bindings_sha256: sha256(canonical(bindings)),
      code_sha256: sha256(canonical(projected.resources.script)),
      runtime_sha256: sha256(canonical(projected.resources.script_runtime)),
    });
  } catch (error) {
    if (error instanceof CloudflareDisposableDeploymentTransportError) throw error;
    refuse(code);
  }
}

function workerGenerationSha256({
  role,
  mode,
  workerIdentitySha256,
  deploymentId,
  versionId,
  reviewedWorkerGenerationSha256,
}) {
  return domainHash(WORKER_GENERATION_HASH_DOMAIN, {
    schema_version: 1,
    role,
    mode,
    worker_identity_sha256: cleanSha256(
      workerIdentitySha256,
      "CF_DISPOSABLE_TRANSPORT_WORKER_GENERATION_INVALID",
    ),
    deployment_id: cleanUuid(
      deploymentId,
      "CF_DISPOSABLE_TRANSPORT_WORKER_GENERATION_INVALID",
    ),
    version_id: cleanUuid(
      versionId,
      "CF_DISPOSABLE_TRANSPORT_WORKER_GENERATION_INVALID",
    ),
    reviewed_worker_generation_sha256: cleanSha256(
      reviewedWorkerGenerationSha256,
      "CF_DISPOSABLE_TRANSPORT_WORKER_GENERATION_INVALID",
    ),
  });
}

function campaignGenerationAuthority({
  role,
  mode,
  workerIdentitySha256,
  deploymentId,
  versionId,
  reviewedWorkerGenerationSha256,
}) {
  const authority = Object.freeze({
    schema_version: 1,
    role,
    mode,
    worker_identity_sha256: workerIdentitySha256,
    deployment_id: deploymentId,
    version_id: versionId,
    reviewed_worker_generation_sha256: reviewedWorkerGenerationSha256,
  });
  return Object.freeze({
    ...authority,
    worker_generation_sha256: workerGenerationSha256({
      role,
      mode,
      workerIdentitySha256,
      deploymentId,
      versionId,
      reviewedWorkerGenerationSha256,
    }),
  });
}

/** Build one recomputable generation preimage for durable private evidence. */
export function createCloudflareDisposableCampaignGenerationAuthority(input) {
  if (!exactKeys(input, [
    "role", "mode", "worker_identity_sha256", "deployment_id", "version_id",
    "reviewed_worker_generation_sha256",
  ]) || !["source", "target"].includes(input.role)) {
    refuse("CF_DISPOSABLE_TRANSPORT_CAMPAIGN_AUTHORITY_INVALID");
  }
  return assertCampaignGenerationAuthority(campaignGenerationAuthority({
    role: input.role,
    mode: input.mode,
    workerIdentitySha256: input.worker_identity_sha256,
    deploymentId: input.deployment_id,
    versionId: input.version_id,
    reviewedWorkerGenerationSha256:
      input.reviewed_worker_generation_sha256,
  }), input.role);
}

function vectorizeInstanceAuthority({
  role,
  indexName,
  dimensions,
  metric,
  createdOn,
}) {
  const code = "CF_DISPOSABLE_TRANSPORT_CAMPAIGN_AUTHORITY_INVALID";
  if (!["source", "target"].includes(role) || dimensions !== 768 ||
      metric !== "cosine") {
    refuse(code);
  }
  const semantic = Object.freeze({
    schema_version: 1,
    role,
    index_name: cleanVectorizeName(indexName, code),
    dimensions,
    metric,
    created_on: cleanIsoTimestamp(createdOn, code),
  });
  return Object.freeze({
    ...semantic,
    instance_sha256: domainHash(
      VECTORIZE_INSTANCE_AUTHORITY_HASH_DOMAIN,
      semantic,
    ),
  });
}

/** Build one credential-free, recomputable Vectorize instance preimage. */
export function createCloudflareDisposableCampaignVectorizeInstanceAuthority(input) {
  if (!exactKeys(input, [
    "role", "index_name", "dimensions", "metric", "created_on",
  ])) {
    refuse("CF_DISPOSABLE_TRANSPORT_CAMPAIGN_AUTHORITY_INVALID");
  }
  return vectorizeInstanceAuthority({
    role: input.role,
    indexName: input.index_name,
    dimensions: input.dimensions,
    metric: input.metric,
    createdOn: input.created_on,
  });
}

function assertCampaignVectorizeInstanceAuthority(value, role) {
  const code = "CF_DISPOSABLE_TRANSPORT_CAMPAIGN_AUTHORITY_INVALID";
  if (!exactKeys(value, [
    "schema_version", "role", "index_name", "dimensions", "metric",
    "created_on", "instance_sha256",
  ]) || value.schema_version !== 1 || value.role !== role) {
    refuse(code);
  }
  const normalized = vectorizeInstanceAuthority({
    role,
    indexName: value.index_name,
    dimensions: value.dimensions,
    metric: value.metric,
    createdOn: value.created_on,
  });
  if (canonical(normalized) !== canonical(value)) refuse(code);
  return normalized;
}

function assertCampaignGenerationAuthority(value, role) {
  const code = "CF_DISPOSABLE_TRANSPORT_CAMPAIGN_AUTHORITY_INVALID";
  if (!exactKeys(value, [
    "schema_version", "role", "mode", "worker_identity_sha256",
    "deployment_id", "version_id", "reviewed_worker_generation_sha256",
    "worker_generation_sha256",
  ]) || value.schema_version !== 1 || value.role !== role ||
      value.mode !== (role === "source" ? "active" : value.mode) ||
      !["active", "paused"].includes(value.mode)) {
    refuse(code);
  }
  const normalized = campaignGenerationAuthority({
    role,
    mode: value.mode,
    workerIdentitySha256: cleanSha256(value.worker_identity_sha256, code),
    deploymentId: cleanUuid(value.deployment_id, code),
    versionId: cleanUuid(value.version_id, code),
    reviewedWorkerGenerationSha256: cleanSha256(
      value.reviewed_worker_generation_sha256,
      code,
    ),
  });
  if (canonical(normalized) !== canonical(value)) refuse(code);
  return normalized;
}

/**
 * Recompute every enclosing census and generation hash in a transport proof.
 * Provider payloads and credentials remain excluded; the persisted authority
 * contains only the privacy-safe normalized census and reviewed hash leaves.
 */
export function assertCloudflareDisposableCampaignCustodyProof(value) {
  const code = "CF_DISPOSABLE_TRANSPORT_CAMPAIGN_AUTHORITY_INVALID";
  if (!exactKeys(value, [
    "schema_version", "operation", "captures", "teardown_role", "roles",
    "campaign_custody", "campaign_custody_authority",
    "generation_authority", "vectorize_instance_authority", "proof_sha256",
  ]) || value.schema_version !== 1 || value.operation !== "read_campaign_custody" ||
      value.captures !== 2 || !["source", "target"].includes(value.teardown_role) ||
      !exactKeys(value.roles, ["source", "target"]) ||
      !exactKeys(value.generation_authority, ["source", "target"]) ||
      !exactKeys(value.vectorize_instance_authority, ["source", "target"])) {
    refuse(code);
  }
  let custody;
  try {
    custody = assertV048ExclusiveCampaignResourceCustodyAuthority(
      value.campaign_custody_authority,
    );
  } catch {
    refuse(code);
  }
  if (canonical(custody.receipt) !== canonical(value.campaign_custody) ||
      custody.authority.campaign.teardown_role !== value.teardown_role) {
    refuse(code);
  }
  for (const role of ["source", "target"]) {
    const roleProof = value.roles[role];
    if (!exactKeys(roleProof, [
      "state", "worker_instance_sha256", "d1_instance_sha256",
      "vectorize_instance_sha256", "worker_protection",
    ]) || !exactKeys(roleProof.state, ["worker", "d1", "vectorize"]) ||
        Object.values(roleProof.state).some((state) =>
          !["present", "absent"].includes(state)) ||
        custody.authority.campaign[role].worker_state !==
          roleProof.state.worker) {
      refuse(code);
    }
    for (const [kind, field] of [
      ["worker", "worker_instance_sha256"],
      ["d1", "d1_instance_sha256"],
      ["vectorize", "vectorize_instance_sha256"],
    ]) {
      if (roleProof.state[kind] === "present") cleanSha256(roleProof[field], code);
      else if (roleProof[field] !== null) refuse(code);
    }
    if (roleProof.state.worker === "absent") {
      if (roleProof.worker_protection !== null ||
          value.generation_authority[role] !== null) {
        refuse(code);
      }
    } else {
      if (!exactKeys(roleProof.worker_protection, [
        "schema_version", "worker_identity_proved", "worker_identity_sha256",
        "worker_reference_snapshot_sha256", "reviewed_worker_generation_sha256",
        "worker_generation_proved", "worker_generation_sha256",
      ]) || roleProof.worker_protection.schema_version !== 1 ||
          roleProof.worker_protection.worker_identity_proved !== true ||
          roleProof.worker_protection.worker_generation_proved !== true) {
        refuse(code);
      }
      for (const hash of [
        roleProof.worker_protection.worker_identity_sha256,
        roleProof.worker_protection.worker_reference_snapshot_sha256,
        roleProof.worker_protection.reviewed_worker_generation_sha256,
        roleProof.worker_protection.worker_generation_sha256,
      ]) cleanSha256(hash, code);
      const generation = assertCampaignGenerationAuthority(
        value.generation_authority[role],
        role,
      );
      if (generation.worker_identity_sha256 !==
            roleProof.worker_protection.worker_identity_sha256 ||
          generation.reviewed_worker_generation_sha256 !==
            roleProof.worker_protection.reviewed_worker_generation_sha256 ||
          generation.worker_generation_sha256 !==
            roleProof.worker_protection.worker_generation_sha256) {
        refuse(code);
      }
    }
    if (roleProof.state.vectorize === "absent") {
      if (value.vectorize_instance_authority[role] !== null) refuse(code);
    } else {
      const vectorizeInstance = assertCampaignVectorizeInstanceAuthority(
        value.vectorize_instance_authority[role],
        role,
      );
      if (vectorizeInstance.index_name !==
            custody.authority.campaign[role].vectorize_index_name ||
          vectorizeInstance.instance_sha256 !==
            roleProof.vectorize_instance_sha256) {
        refuse(code);
      }
    }
    if (roleProof.state.d1 === "present" &&
        typeof custody.authority.campaign[role].d1_database_id !== "string") {
      refuse(code);
    }
  }
  const { proof_sha256: _proofSha256, ...semantic } = value;
  if (cleanSha256(value.proof_sha256, code) !==
      domainHash(CAMPAIGN_PROOF_HASH_DOMAIN, semantic)) {
    refuse(code);
  }
  return deepFreeze(structuredClone(value));
}

/** Build and immediately recompute one complete or partial custody proof. */
export function createCloudflareDisposableCampaignCustodyProof(input) {
  if (!exactKeys(input, [
    "teardown_role", "roles", "campaign_custody", "campaign_custody_authority",
    "generation_authority", "vectorize_instance_authority",
  ]) || !["source", "target"].includes(input.teardown_role)) {
    refuse("CF_DISPOSABLE_TRANSPORT_CAMPAIGN_AUTHORITY_INVALID");
  }
  const semantic = {
    schema_version: CLOUDFLARE_DISPOSABLE_DEPLOYMENT_TRANSPORT_SCHEMA_VERSION,
    operation: "read_campaign_custody",
    captures: 2,
    teardown_role: input.teardown_role,
    roles: input.roles,
    campaign_custody: input.campaign_custody,
    campaign_custody_authority: input.campaign_custody_authority,
    generation_authority: input.generation_authority,
    vectorize_instance_authority: input.vectorize_instance_authority,
  };
  return assertCloudflareDisposableCampaignCustodyProof({
    ...semantic,
    proof_sha256: domainHash(CAMPAIGN_PROOF_HASH_DOMAIN, semantic),
  });
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
  const behavior = normalizeNeutralVersionBehavior(
    runtime, "CF_DISPOSABLE_TRANSPORT_VERSION_MISMATCH",
  );
  const bindings = normalizeBindingList(resources.bindings, normalizeReadBinding,
    "CF_DISPOSABLE_TRANSPORT_VERSION_RESPONSE_INVALID");
  if (canonical(bindings) !== canonical(expected.bindings)) {
    refuse("CF_DISPOSABLE_TRANSPORT_VERSION_MISMATCH");
  }
  const withoutMode = expected.mode_binding_name === null
    ? bindings
    : bindings.filter((binding) => binding.name !== expected.mode_binding_name);
  const reviewedWorkerGenerationSha256 = expected.protection === null
    ? null
    : reviewedWorkerGeneration(value, expected.protection);
  return {
    versionId,
    scriptEtag,
    handlers,
    bindingsSha256: sha256(canonical(bindings)),
    bindingsWithoutModeSha256: sha256(canonical(withoutMode)),
    behaviorSha256: sha256(canonical(behavior)),
    namedHandlersCount: script.named_handlers.length,
    reviewedWorkerGenerationSha256,
  };
}

function cleanProvisionCompatibilityDate(value) {
  const text = cleanText(value, 64,
    "CF_DISPOSABLE_TRANSPORT_PROVISION_VERSION_INVALID");
  const match = /^(\d{4}-\d{2}-\d{2})(?:T00:00:00(?:\.000)?Z)?$/u.exec(text);
  if (!match || new Date(`${match[1]}T00:00:00.000Z`).toISOString().slice(0, 10) !==
      match[1]) {
    refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_VERSION_INVALID");
  }
  return match[1];
}

function emptyOptionalObject(value, key, code) {
  if (!Object.hasOwn(value, key) || value[key] === null) return null;
  if (!exactKeys(value[key], [])) refuse(code);
  return null;
}

function emptyOptionalArray(value, key, code) {
  if (!Object.hasOwn(value, key) || value[key] === null) return Object.freeze([]);
  if (!Array.isArray(value[key]) || value[key].length !== 0) refuse(code);
  return Object.freeze([]);
}

function neutralCacheOptions(value, code) {
  if (value === undefined || value === null) {
    return Object.freeze({ enabled: false, cross_version_cache: false });
  }
  if (!onlyKeys(value, ["enabled", "cross_version_cache"]) ||
      Object.hasOwn(value, "enabled") && value.enabled !== false ||
      Object.hasOwn(value, "cross_version_cache") && value.cross_version_cache !== false) {
    refuse(code);
  }
  return Object.freeze({ enabled: false, cross_version_cache: false });
}

function neutralWorkerExports(value, code) {
  if (value === undefined || value === null || exactKeys(value, [])) {
    return Object.freeze({ default_worker_only: true, cache_enabled: false });
  }
  if (!exactKeys(value, ["default"])) refuse(code);
  const worker = value.default;
  if (!onlyKeys(worker, ["type", "state", "cache"], ["type"]) ||
      worker.type !== "worker" ||
      Object.hasOwn(worker, "state") && worker.state !== "created") {
    refuse(code);
  }
  if (Object.hasOwn(worker, "cache")) {
    if (!exactKeys(worker.cache, ["enabled"]) || worker.cache.enabled !== false) refuse(code);
  }
  return Object.freeze({ default_worker_only: true, cache_enabled: false });
}

function neutralObservability(value, code) {
  if (value === undefined || value === null || exactKeys(value, [])) {
    return Object.freeze({ enabled: false });
  }
  if (!exactKeys(value, ["enabled"]) || value.enabled !== false) refuse(code);
  return Object.freeze({ enabled: false });
}

function normalizeNeutralVersionBehavior(value, code) {
  emptyOptionalObject(value, "assets", code);
  emptyOptionalArray(value, "compatibility_flags", code);
  emptyOptionalArray(value, "containers", code);
  const exportsValue = neutralWorkerExports(value.exports, code);
  if (Object.hasOwn(value, "exports_reconciliation") &&
      value.exports_reconciliation !== null &&
      !(Array.isArray(value.exports_reconciliation) &&
        value.exports_reconciliation.length === 0) &&
      !exactKeys(value.exports_reconciliation, [])) {
    refuse(code);
  }
  emptyOptionalObject(value, "limits", code);
  if (Object.hasOwn(value, "migration_tag") && value.migration_tag !== null) refuse(code);
  if (Object.hasOwn(value, "migrations") && value.migrations !== null &&
      !(Array.isArray(value.migrations) && value.migrations.length === 0) &&
      !exactKeys(value.migrations, [])) {
    refuse(code);
  }
  emptyOptionalArray(value, "package_dependencies", code);
  emptyOptionalObject(value, "placement", code);
  if (Object.hasOwn(value, "source") && value.source !== null && value.source !== "api") {
    refuse(code);
  }
  if (Object.hasOwn(value, "startup_time_ms") &&
      (!Number.isFinite(value.startup_time_ms) || value.startup_time_ms < 0)) {
    refuse(code);
  }
  return Object.freeze({
    assets: false,
    cache: neutralCacheOptions(value.cache_options, code),
    compatibility_flags: Object.freeze([]),
    containers: Object.freeze([]),
    exports: exportsValue,
    limits: null,
    migrations: null,
    package_dependencies: Object.freeze([]),
    placement: null,
  });
}

function normalizeNeutralSettingsBehavior(value, expectedWorkerTag, code) {
  emptyOptionalObject(value, "assets", code);
  if (Object.hasOwn(value, "capnp_schema") && value.capnp_schema !== null) refuse(code);
  emptyOptionalArray(value, "compatibility_flags", code);
  if (Object.hasOwn(value, "keep_assets") && value.keep_assets !== false) refuse(code);
  emptyOptionalObject(value, "limits", code);
  if (Object.hasOwn(value, "logpush") && value.logpush !== false) refuse(code);
  if (Object.hasOwn(value, "migrations") && value.migrations !== null &&
      !(Array.isArray(value.migrations) && value.migrations.length === 0) &&
      !exactKeys(value.migrations, [])) {
    refuse(code);
  }
  const observability = neutralObservability(value.observability, code);
  emptyOptionalObject(value, "placement", code);
  emptyOptionalArray(value, "tail_consumers", code);
  if (Object.hasOwn(value, "tags") &&
      (!Array.isArray(value.tags) || value.tags.length !== 1 ||
       value.tags[0] !== expectedWorkerTag)) {
    refuse(code);
  }
  return Object.freeze({
    assets: false,
    cache: neutralCacheOptions(value.cache_options, code),
    capnp_schema: null,
    compatibility_flags: Object.freeze([]),
    keep_assets: false,
    limits: null,
    logpush: false,
    migrations: null,
    observability,
    placement: null,
    tail_consumers: Object.freeze([]),
  });
}

function normalizeProvisionVersion(value, { includeModules = false } = {}) {
  const allowed = [
    "id", "created_on", "number", "urls", "annotations", "assets",
    "author_email", "author_id", "bindings", "cache_options",
    "compatibility_date", "compatibility_flags", "containers", "exports",
    "exports_reconciliation", "limits", "main_module", "migration_tag",
    "migrations", "modules", "package_dependencies", "placement", "source",
    "startup_time_ms", "usage_model",
  ];
  const required = ["id", "created_on", "number", "urls"];
  if (includeModules) required.push(
    "annotations", "bindings", "compatibility_date", "main_module", "modules", "usage_model",
  );
  if (!onlyKeys(value, allowed, required) ||
      !Number.isSafeInteger(value.number) || value.number < 0 ||
      !Array.isArray(value.urls) || value.urls.some((entry) => typeof entry !== "string")) {
    refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_VERSION_INVALID");
  }
  const versionId = cleanUuid(value.id,
    "CF_DISPOSABLE_TRANSPORT_PROVISION_VERSION_INVALID");
  const createdOn = cleanIsoTimestamp(value.created_on,
    "CF_DISPOSABLE_TRANSPORT_PROVISION_VERSION_INVALID");
  if (!includeModules) {
    // The list endpoint is used only as an exhaustive immutable-ID inventory.
    // Cloudflare omits code unless the exact-version GET requests
    // `include=modules`, so no list row is trusted as content evidence.
    return { version_id: versionId, created_on: createdOn, number: value.number };
  }
  if (!onlyKeys(value.annotations,
    ["workers/message", "workers/tag", "workers/triggered_by"],
    ["workers/message", "workers/tag"]) || value.usage_model !== "standard") {
    refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_VERSION_INVALID");
  }
  const mainModule = cleanText(value.main_module, 256,
    "CF_DISPOSABLE_TRANSPORT_PROVISION_VERSION_INVALID");
  if (!MODULE_NAME_RE.test(mainModule)) {
    refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_VERSION_INVALID");
  }
  const compatibilityDate = cleanProvisionCompatibilityDate(value.compatibility_date);
  const tag = cleanText(value.annotations["workers/tag"], 100,
    "CF_DISPOSABLE_TRANSPORT_PROVISION_VERSION_INVALID");
  const message = cleanText(value.annotations["workers/message"], 1000,
    "CF_DISPOSABLE_TRANSPORT_PROVISION_VERSION_INVALID");
  const bindings = normalizeBindingList(value.bindings, normalizeReadBinding,
    "CF_DISPOSABLE_TRANSPORT_PROVISION_VERSION_INVALID");
  const behavior = normalizeNeutralVersionBehavior(
    value, "CF_DISPOSABLE_TRANSPORT_PROVISION_VERSION_INVALID",
  );
  if (!Array.isArray(value.modules) || value.modules.length < 1 ||
      value.modules.length > MAX_MODULE_COUNT) {
    refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_VERSION_INVALID");
  }
  const moduleEntries = [];
  let totalBytes = 0;
  for (const module of value.modules) {
    if (!exactKeys(module, ["content_base64", "content_type", "name"]) ||
        typeof module.content_base64 !== "string" ||
        !MODULE_CONTENT_TYPES.has(module.content_type) ||
        typeof module.name !== "string" || !MODULE_NAME_RE.test(module.name) ||
        module.name.includes("//") || module.name.split("/").some((part) =>
          !part || part === "." || part === "..") || module.name.length > 256) {
      refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_VERSION_INVALID");
    }
    let bytes;
    try {
      bytes = Buffer.from(module.content_base64, "base64");
      if (bytes.length < 1 || bytes.length > MAX_MODULE_BYTES ||
          bytes.toString("base64") !== module.content_base64) {
        refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_VERSION_INVALID");
      }
      totalBytes += bytes.length;
      if (totalBytes > MAX_UPLOAD_BYTES) {
        refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_VERSION_INVALID");
      }
      moduleEntries.push({
        name: module.name,
        content_type: module.content_type,
        bytes: bytes.length,
        sha256: sha256(bytes),
      });
    } finally {
      bytes?.fill(0);
    }
  }
  moduleEntries.sort((left, right) => compareText(left.name, right.name));
  if (moduleEntries.some((entry, index) =>
    index > 0 && entry.name === moduleEntries[index - 1].name) ||
      !moduleEntries.some((entry) => entry.name === mainModule)) {
    refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_VERSION_INVALID");
  }
  return {
    version_id: versionId,
    created_on: createdOn,
    number: value.number,
    tag_sha256: sha256(tag),
    message_sha256: sha256(message),
    compatibility_date: compatibilityDate,
    main_module: mainModule,
    bindings_sha256: sha256(canonical(bindings)),
    behavior_exact: true,
    behavior_sha256: sha256(canonical(behavior)),
    module_inventory_sha256: sha256(canonical({
      main_module: mainModule,
      modules: moduleEntries,
    })),
  };
}


function cleanVersionExpectation(value) {
  if (!(exactKeys(value, [
    "compatibility_date", "handlers", "bindings", "mode_binding_name",
  ]) || exactKeys(value, [
    "compatibility_date", "handlers", "bindings", "mode_binding_name", "protection",
  ])) || !Array.isArray(value.handlers) || value.handlers.length < 1 ||
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
  let protection = null;
  if (Object.hasOwn(value, "protection")) {
    if (!exactKeys(value.protection, ["expected_mode", "role"]) ||
        !["source", "target"].includes(value.protection.role) ||
        (value.protection.role === "source"
          ? value.protection.expected_mode !== null
          : !["active", "paused"].includes(value.protection.expected_mode))) {
      refuse("CF_DISPOSABLE_TRANSPORT_VERSION_INPUT_INVALID");
    }
    protection = Object.freeze({
      role: value.protection.role,
      expectedMode: value.protection.expected_mode,
    });
  }
  return {
    compatibility_date: cleanCompatibilityDate(value.compatibility_date),
    handlers,
    bindings,
    mode_binding_name: modeBindingName,
    protection,
  };
}

function validateResultInfo(value, resultLength) {
  if (value === undefined) return;
  if (!onlyKeys(value, ["count", "page", "per_page", "total_count", "total_pages"]) ||
      Object.values(value).some((entry) => !Number.isSafeInteger(entry) || entry < 0) ||
      value.count !== undefined && value.count !== resultLength ||
      value.page !== undefined && value.page !== 1 ||
      value.per_page !== undefined && value.per_page < 1 ||
      value.total_count !== undefined && value.total_count < resultLength) {
    refuse("CF_DISPOSABLE_TRANSPORT_RESOURCE_RESPONSE_INVALID");
  }
}

function workerSurfaceProof(worker, expectedName) {
  const code = "CF_DISPOSABLE_TRANSPORT_WORKER_SURFACE_INVALID";
  if (!worker || typeof worker !== "object" || Array.isArray(worker) ||
      worker.id !== expectedName || typeof worker.created_on !== "string" ||
      typeof worker.modified_on !== "string" || !Number.isFinite(Date.parse(worker.created_on)) ||
      !Number.isFinite(Date.parse(worker.modified_on)) ||
      typeof worker.etag !== "string" || worker.etag.length < 1 || worker.etag.length > 256 ||
      !worker.cache_options || typeof worker.cache_options !== "object" ||
      Array.isArray(worker.cache_options) || worker.cache_options.enabled !== false ||
      !Array.isArray(worker.tail_consumers) || worker.tail_consumers.length !== 0 ||
      worker.has_assets !== false || worker.logpush !== false ||
      !Array.isArray(worker.named_handlers) || worker.named_handlers.length !== 0 ||
      !worker.exports || typeof worker.exports !== "object" || Array.isArray(worker.exports) ||
      Object.keys(worker.exports).some((name) => name !== "default")) {
    refuse(code);
  }
  const defaultExport = worker.exports.default;
  if (defaultExport !== undefined &&
      (!defaultExport || typeof defaultExport !== "object" || Array.isArray(defaultExport) ||
       defaultExport.type !== "worker" || ![undefined, "created"].includes(defaultExport.state) ||
       defaultExport.cache !== undefined &&
       (!defaultExport.cache || typeof defaultExport.cache !== "object" ||
        Array.isArray(defaultExport.cache) || defaultExport.cache.enabled !== false))) {
    refuse(code);
  }
  return Object.freeze({
    cache_enabled: false,
    extra_exports: 0,
    tail_consumers: 0,
    assets: false,
    logpush: false,
    classic_identity_sha256: domainHash(WORKER_IDENTITY_HASH_DOMAIN, {
      worker_name: expectedName,
      created_on: worker.created_on,
      modified_on: worker.modified_on,
      etag: worker.etag,
      cache_enabled: false,
      extra_exports: 0,
      tail_consumers: 0,
      assets: false,
      logpush: false,
    }),
  });
}

function combinedWorkerIdentitySha256(surface, referenceSnapshot) {
  return domainHash(WORKER_IDENTITY_HASH_DOMAIN, {
    schema_version: 1,
    classic_identity_sha256: surface.classic_identity_sha256,
    worker_reference_snapshot_sha256: referenceSnapshot.snapshot_sha256,
  });
}

function cleanIsoTimestamp(value, code) {
  const text = cleanText(value, 128, code);
  if (!Number.isFinite(Date.parse(text))) refuse(code);
  return text;
}

function normalizeProvisionWorker(value, expectedName, expectedTag, code) {
  if (!onlyKeys(value, [
    "id", "created_on", "deployed_on", "logpush", "name", "observability",
    "subdomain", "tags", "tail_consumers", "updated_on", "references",
  ], ["id", "created_on", "name", "subdomain", "tags"]) || value.name !== expectedName ||
      !Array.isArray(value.tags) || value.tags.length !== 1 ||
      value.tags[0] !== expectedTag) {
    refuse(code);
  }
  const subdomain = value.subdomain;
  if (!onlyKeys(subdomain, [
    "enabled", "preview_url_suffix", "previews_enabled", "url",
  ], ["enabled", "previews_enabled", "url"]) || subdomain.enabled !== true ||
      subdomain.previews_enabled !== false) {
    refuse(code);
  }
  let url;
  try { url = new URL(subdomain.url); } catch { refuse(code); }
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      url.pathname !== "/" || url.search || url.hash ||
      !url.hostname.endsWith(".workers.dev")) {
    refuse(code);
  }
  return {
    workerId: cleanProvisionWorkerId(value.id, code),
    createdOn: cleanIsoTimestamp(value.created_on, code),
    hostname: url.hostname,
  };
}

function normalizeProvisionD1(value, expectedName, code) {
  if (!onlyKeys(value, [
    "created_at", "file_size", "jurisdiction", "name", "num_tables",
    "read_replication", "uuid", "version",
  ], ["created_at", "name", "uuid"]) || value.name !== expectedName) {
    refuse(code);
  }
  return {
    databaseId: cleanUuid(value.uuid, code),
    createdOn: cleanIsoTimestamp(value.created_at, code),
  };
}

function normalizeProvisionVectorize(value, expectedName, code) {
  if (!onlyKeys(value, ["config", "created_on", "description", "modified_on", "name"],
    ["config", "created_on", "name"]) || value.name !== expectedName ||
      !exactKeys(value.config, ["dimensions", "metric"]) ||
      value.config.dimensions !== 768 || value.config.metric !== "cosine") {
    refuse(code);
  }
  return { createdOn: cleanIsoTimestamp(value.created_on, code) };
}

function jsonMutationBody(value) {
  const body = Buffer.from(canonical(value), "utf8");
  if (body.length > 64 * 1024) {
    body.fill(0);
    refuse("CF_DISPOSABLE_TRANSPORT_REQUEST_INVALID");
  }
  return body;
}


function cleanResourceRequest(value) {
  if (!exactKeys(value, [
    "account_id", "script_name", "database", "vectorize", "expected",
  ]) || !exactKeys(value.database, ["id", "name"]) ||
      !exactKeys(value.vectorize, ["name", "dimensions", "metric"]) ||
      !exactKeys(value.expected, [
        "workers_dev_enabled", "previews_enabled", "routes_count",
        "custom_domains_count", "domain", "schedules",
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
      domain: cleanWorkersDevDomain(
        value.expected.domain,
        cleanScriptName(value.script_name),
        "CF_DISPOSABLE_TRANSPORT_RESOURCE_INPUT_INVALID",
      ),
      schedules,
    },
  };
}

function cleanCampaignRoleResource(value) {
  const code = "CF_DISPOSABLE_TRANSPORT_CAMPAIGN_INPUT_INVALID";
  if (!exactKeys(value, [
    "worker_name", "d1_database_id", "d1_database_name",
    "vectorize_index_name", "domain",
  ])) refuse(code);
  const workerName = cleanScriptName(value.worker_name);
  return Object.freeze({
    workerName,
    d1DatabaseId: cleanUuid(value.d1_database_id, code),
    d1DatabaseName: cleanText(value.d1_database_name, 128, code),
    vectorizeIndexName: cleanVectorizeName(value.vectorize_index_name, code),
    domain: cleanWorkersDevDomain(value.domain, workerName, code),
  });
}

function cleanExpectedCampaignWorker(value) {
  const code = "CF_DISPOSABLE_TRANSPORT_CAMPAIGN_INPUT_INVALID";
  if (!exactKeys(value, [
    "deployment_id", "version_id", "script_etag",
    "reviewed_worker_generation_sha256",
  ]) || (value.deployment_id !== null && typeof value.deployment_id !== "string") ||
      typeof value.script_etag !== "string" || value.script_etag.length < 1 ||
      value.script_etag.length > 256 || CONTROL_RE.test(value.script_etag) ||
      (value.reviewed_worker_generation_sha256 !== null &&
       typeof value.reviewed_worker_generation_sha256 !== "string")) {
    refuse(code);
  }
  return Object.freeze({
    deploymentId: value.deployment_id === null
      ? null
      : cleanUuid(value.deployment_id, code),
    versionId: cleanUuid(value.version_id, code),
    scriptEtag: value.script_etag,
    reviewedWorkerGenerationSha256:
      value.reviewed_worker_generation_sha256 === null
        ? null
        : cleanSha256(value.reviewed_worker_generation_sha256, code),
  });
}

function cleanCampaignCustodyRequest(value) {
  const code = "CF_DISPOSABLE_TRANSPORT_CAMPAIGN_INPUT_INVALID";
  if (!exactKeys(value, [
    "account_id", "teardown_role", "campaign_resources", "expected_workers",
  ]) || !["source", "target"].includes(value.teardown_role) ||
      !exactKeys(value.campaign_resources, ["source", "target"]) ||
      !exactKeys(value.expected_workers, ["source", "target"])) {
    refuse(code);
  }
  const source = cleanCampaignRoleResource(value.campaign_resources.source);
  const target = cleanCampaignRoleResource(value.campaign_resources.target);
  if (source.workerName === target.workerName ||
      source.d1DatabaseId === target.d1DatabaseId ||
      source.vectorizeIndexName === target.vectorizeIndexName) {
    refuse(code);
  }
  return Object.freeze({
    accountId: cleanAccountId(value.account_id),
    teardownRole: value.teardown_role,
    campaignResources: Object.freeze({ source, target }),
    expectedWorkers: Object.freeze({
      source: cleanExpectedCampaignWorker(value.expected_workers.source),
      target: cleanExpectedCampaignWorker(value.expected_workers.target),
    }),
  });
}

function assertCampaignLifecycleStates(roles, teardownRole) {
  const selected = roles[teardownRole].state;
  const sequence = `${selected.worker === "present" ? "P" : "A"}` +
    `${selected.vectorize === "present" ? "P" : "A"}` +
    `${selected.d1 === "present" ? "P" : "A"}`;
  if (!["PPP", "APP", "AAP", "AAA"].includes(sequence)) {
    refuse("CF_DISPOSABLE_TRANSPORT_CAMPAIGN_STATE_INVALID");
  }
  const requiredRole = teardownRole === "source" ? "target" : "source";
  const required = roles[requiredRole].state;
  const requiredSequence = `${required.worker === "present" ? "P" : "A"}` +
    `${required.vectorize === "present" ? "P" : "A"}` +
    `${required.d1 === "present" ? "P" : "A"}`;
  if (requiredSequence !== (teardownRole === "source" ? "PPP" : "AAA")) {
    refuse("CF_DISPOSABLE_TRANSPORT_CAMPAIGN_STATE_INVALID");
  }
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

  const evidenceEntry = (operation, evidence) => Object.freeze({ operation, ...evidence });

  async function exhaustiveBetaWorkerList(token, accountId, observations) {
    const code = "CF_DISPOSABLE_TRANSPORT_WORKER_INVENTORY_INVALID";
    const workers = [];
    let page = 1;
    let totalCount = null;
    let totalPages = null;
    do {
      const response = await request(token, {
        url: apiUrl(accountPath(accountId, "/workers/workers"), [
          ["order", "asc"], ["order_by", "name"], ["page", String(page)],
          ["per_page", String(CAMPAIGN_WORKER_PAGE_SIZE)],
        ]),
        method: "GET",
        mutation: false,
        allowResultInfo: true,
      });
      observations.push(evidenceEntry(`list_beta_workers_page_${page}`, response.evidence));
      const info = response.body.result_info;
      if (!Array.isArray(response.result) || !exactKeys(info, [
        "count", "page", "per_page", "total_count", "total_pages",
      ]) || Object.values(info).some((entry) => !Number.isSafeInteger(entry) || entry < 0) ||
          info.page !== page || info.per_page !== CAMPAIGN_WORKER_PAGE_SIZE ||
          info.count !== response.result.length || info.total_count > MAX_ACCOUNT_WORKERS ||
          info.total_pages !== Math.ceil(info.total_count / CAMPAIGN_WORKER_PAGE_SIZE) ||
          (page > 1 && (info.total_count !== totalCount || info.total_pages !== totalPages))) {
        refuse(code);
      }
      const expectedCount = info.total_count === 0
        ? 0
        : Math.min(
          CAMPAIGN_WORKER_PAGE_SIZE,
          info.total_count - ((page - 1) * CAMPAIGN_WORKER_PAGE_SIZE),
        );
      if (info.count !== expectedCount) refuse(code);
      totalCount ??= info.total_count;
      totalPages ??= info.total_pages;
      for (const worker of response.result) {
        if (!worker || typeof worker !== "object" || Array.isArray(worker) ||
            typeof worker.name !== "string" || cleanScriptName(worker.name) !== worker.name ||
            cleanWorkerId(worker.id, code) !== worker.id ||
            !Object.hasOwn(worker, "deployed_on") ||
            (worker.deployed_on !== null &&
             (typeof worker.deployed_on !== "string" ||
              !Number.isFinite(Date.parse(worker.deployed_on))))) {
          refuse(code);
        }
        workers.push(worker);
      }
      page += 1;
    } while (page <= totalPages);
    if (workers.length !== totalCount ||
        new Set(workers.map((worker) => worker.id)).size !== workers.length ||
        new Set(workers.map((worker) => worker.name)).size !== workers.length ||
        workers.some((worker, index) => index > 0 &&
          compareText(workers[index - 1].name, worker.name) >= 0)) {
      refuse(code);
    }
    return Object.freeze({ total_count: totalCount, workers: Object.freeze(workers) });
  }

  async function readProvisioningCollisions(input) {
    if (!exactKeys(input, ["account_id", "resource_name"])) {
      refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_INPUT_INVALID");
    }
    const accountId = cleanAccountId(input.account_id);
    const resourceName = cleanScriptName(input.resource_name);
    cleanVectorizeName(resourceName, "CF_DISPOSABLE_TRANSPORT_PROVISION_INPUT_INVALID");
    const base = accountPath(accountId);
    return withToken(async (token) => {
      const responses = [];
      const get = async (operation, path, query, allowResultInfo = false) => {
        const response = await request(token, {
          url: apiUrl(`${base}${path}`, query),
          method: "GET",
          mutation: false,
          allowResultInfo,
        });
        responses.push({ operation, ...response.evidence });
        return response;
      };
      // Worker listing has no name filter. Exhaust every declared page in a
      // stable name order; a missing or contradictory pagination envelope is
      // not absence proof.
      const workerRows = [];
      let workerPage = 1;
      let workerTotalPages = null;
      for (;;) {
        const page = await get(`list_workers_for_provision_page_${workerPage}`,
          "/workers/workers", [
            ["order_by", "name"], ["order", "asc"],
            ["page", String(workerPage)], ["per_page", "100"],
          ], true);
        if (!Array.isArray(page.result) || !page.body.result_info ||
            !onlyKeys(page.body.result_info,
              ["count", "page", "per_page", "total_count", "total_pages"],
              ["count", "page", "per_page", "total_count", "total_pages"]) ||
            page.body.result_info.page !== workerPage ||
            page.body.result_info.per_page !== 100 ||
            page.body.result_info.count !== page.result.length ||
            !Number.isSafeInteger(page.body.result_info.total_pages) ||
            page.body.result_info.total_pages < 1 || page.body.result_info.total_pages > 1000 ||
            !Number.isSafeInteger(page.body.result_info.total_count) ||
            page.body.result_info.total_count < 0) {
          refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_RESPONSE_INVALID");
        }
        if (workerTotalPages === null) workerTotalPages = page.body.result_info.total_pages;
        if (page.body.result_info.total_pages !== workerTotalPages) {
          refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_RESPONSE_INVALID");
        }
        workerRows.push(...page.result);
        if (workerPage === workerTotalPages) {
          if (workerRows.length !== page.body.result_info.total_count) {
            refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_RESPONSE_INVALID");
          }
          break;
        }
        workerPage += 1;
      }
      const d1 = await get("list_d1_for_provision", "/d1/database", [
        ["name", resourceName], ["page", "1"], ["per_page", "100"],
      ], true);
      // The official Vectorize inventory is a single-page endpoint and accepts
      // no name/page parameters, so read the complete account inventory.
      const vector = await get("list_vectorize_for_provision", "/vectorize/v2/indexes");
      if (!Array.isArray(d1.result) || !d1.body.result_info ||
          !Array.isArray(vector.result)) {
        refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_RESPONSE_INVALID");
      }
      if (!onlyKeys(d1.body.result_info,
        ["count", "page", "per_page", "total_count", "total_pages"],
        ["count", "page", "per_page", "total_count", "total_pages"]) ||
          d1.body.result_info.page !== 1 || d1.body.result_info.per_page !== 100 ||
          d1.body.result_info.count !== d1.result.length ||
          d1.body.result_info.total_count !== d1.result.length ||
          d1.body.result_info.total_pages !== 1) {
        refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_RESPONSE_INVALID");
      }
      const workerMatches = workerRows.filter((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
            typeof entry.name !== "string" || typeof entry.id !== "string") {
          refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_RESPONSE_INVALID");
        }
        if (entry.name !== resourceName) return false;
        cleanProvisionWorkerId(entry.id, "CF_DISPOSABLE_TRANSPORT_PROVISION_RESPONSE_INVALID");
        return true;
      });
      const d1Matches = d1.result.filter((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
            typeof entry.name !== "string" || typeof entry.uuid !== "string") {
          refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_RESPONSE_INVALID");
        }
        if (entry.name !== resourceName) return false;
        cleanUuid(entry.uuid, "CF_DISPOSABLE_TRANSPORT_PROVISION_RESPONSE_INVALID");
        return true;
      });
      const vectorMatches = vector.result.filter((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
            typeof entry.name !== "string") {
          refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_RESPONSE_INVALID");
        }
        return entry.name === resourceName;
      });
      if (workerMatches.length > 1 || d1Matches.length > 1 || vectorMatches.length > 1) {
        refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_RESPONSE_INVALID");
      }
      return deepFreeze({
        schema_version: CLOUDFLARE_DISPOSABLE_DEPLOYMENT_TRANSPORT_SCHEMA_VERSION,
        operation: "read_provisioning_collisions",
        account_id: accountId,
        resource_name: resourceName,
        worker_exists: workerMatches.length === 1,
        d1_exists: d1Matches.length === 1,
        vectorize_exists: vectorMatches.length === 1,
        worker_ids: workerMatches.map((entry) => String(entry.id).toLowerCase()),
        d1_ids: d1Matches.map((entry) => String(entry.uuid).toLowerCase()),
        vectorize_names: vectorMatches.map((entry) => String(entry.name)),
        vectorize_created_on: vectorMatches.length === 0
          ? null
          : cleanIsoTimestamp(vectorMatches[0].created_on,
            "CF_DISPOSABLE_TRANSPORT_PROVISION_RESPONSE_INVALID"),
        responses,
      });
    });
  }

  async function createD1Database(input) {
    if (!exactKeys(input, ["account_id", "name"])) {
      refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_INPUT_INVALID");
    }
    const accountId = cleanAccountId(input.account_id);
    const name = cleanText(input.name, 128, "CF_DISPOSABLE_TRANSPORT_PROVISION_INPUT_INVALID");
    let body = jsonMutationBody({ name });
    try {
      const response = await withToken((token) => request(token, {
        url: apiUrl(accountPath(accountId, "/d1/database")),
        method: "POST",
        body,
        contentType: "application/json",
        mutation: true,
      }));
      const created = validateMutationResult(() => normalizeProvisionD1(
        response.result, name, "CF_DISPOSABLE_TRANSPORT_PROVISION_RESPONSE_INVALID",
      ));
      return deepFreeze({
        schema_version: 1,
        operation: "create_d1_database",
        database_id: created.databaseId,
        created_on: created.createdOn,
        request_body_sha256: sha256(body),
        response: response.evidence,
      });
    } finally { body.fill(0); }
  }

  async function createVectorizeIndex(input) {
    if (!exactKeys(input, ["account_id", "name", "dimensions", "metric"]) ||
        input.dimensions !== 768 || input.metric !== "cosine") {
      refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_INPUT_INVALID");
    }
    const accountId = cleanAccountId(input.account_id);
    const name = cleanVectorizeName(input.name,
      "CF_DISPOSABLE_TRANSPORT_PROVISION_INPUT_INVALID");
    let body = jsonMutationBody({ config: { dimensions: 768, metric: "cosine" }, name });
    try {
      const response = await withToken((token) => request(token, {
        url: apiUrl(accountPath(accountId, "/vectorize/v2/indexes")),
        method: "POST",
        body,
        contentType: "application/json",
        mutation: true,
      }));
      const created = validateMutationResult(() => normalizeProvisionVectorize(
        response.result, name, "CF_DISPOSABLE_TRANSPORT_PROVISION_RESPONSE_INVALID",
      ));
      return deepFreeze({
        schema_version: 1,
        operation: "create_vectorize_index",
        accepted: true,
        created_on: created.createdOn,
        request_body_sha256: sha256(body),
        response: response.evidence,
      });
    } finally { body.fill(0); }
  }

  async function createVectorizeMetadataIndex(input) {
    if (!exactKeys(input, ["account_id", "index_name", "property_name", "index_type"]) ||
        !["string", "number", "boolean"].includes(input.index_type)) {
      refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_INPUT_INVALID");
    }
    const accountId = cleanAccountId(input.account_id);
    const indexName = cleanVectorizeName(input.index_name,
      "CF_DISPOSABLE_TRANSPORT_PROVISION_INPUT_INVALID");
    const propertyName = cleanBindingName(input.property_name);
    let body = jsonMutationBody({ propertyName, indexType: input.index_type });
    try {
      const response = await withToken((token) => request(token, {
        url: apiUrl(accountPath(accountId,
          `/vectorize/v2/indexes/${encoded(indexName)}/metadata_index/create`)),
        method: "POST",
        body,
        contentType: "application/json",
        mutation: true,
      }));
      validateMutationResult(() => {
        if (!onlyKeys(response.result, ["mutationId"], []) ||
            response.result.mutationId !== undefined &&
            (typeof response.result.mutationId !== "string" ||
             response.result.mutationId.length < 1 || response.result.mutationId.length > 64)) {
          refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_RESPONSE_INVALID");
        }
        return true;
      });
      return deepFreeze({
        schema_version: 1,
        operation: "create_vectorize_metadata_index",
        accepted: true,
        property_name: propertyName,
        index_type: input.index_type,
        request_body_sha256: sha256(body),
        response: response.evidence,
      });
    } finally { body.fill(0); }
  }

  async function readVectorizeMetadataIndexes(input) {
    if (!exactKeys(input, ["account_id", "index_name"])) {
      refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_INPUT_INVALID");
    }
    const accountId = cleanAccountId(input.account_id);
    const indexName = cleanVectorizeName(input.index_name,
      "CF_DISPOSABLE_TRANSPORT_PROVISION_INPUT_INVALID");
    const response = await withToken((token) => request(token, {
      url: apiUrl(accountPath(accountId,
        `/vectorize/v2/indexes/${encoded(indexName)}/metadata_index/list`)),
      method: "GET",
      mutation: false,
    }));
    if (!onlyKeys(response.result, ["metadataIndexes"], ["metadataIndexes"]) ||
        !Array.isArray(response.result.metadataIndexes) ||
        response.result.metadataIndexes.length > 10) {
      refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_RESPONSE_INVALID");
    }
    const indexes = response.result.metadataIndexes.map((entry) => {
      if (!onlyKeys(entry, ["propertyName", "indexType"], ["propertyName", "indexType"]) ||
          !["string", "number", "boolean"].includes(String(entry.indexType).toLowerCase())) {
        refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_RESPONSE_INVALID");
      }
      return {
        property_name: cleanBindingName(entry.propertyName),
        index_type: String(entry.indexType).toLowerCase(),
      };
    }).sort((left, right) => compareText(left.property_name, right.property_name));
    if (indexes.some((entry, index) => index > 0 &&
        entry.property_name === indexes[index - 1].property_name)) {
      refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_RESPONSE_INVALID");
    }
    return deepFreeze({
      schema_version: 1,
      operation: "read_vectorize_metadata_indexes",
      indexes,
      response: response.evidence,
    });
  }

  async function createWorkerIdentity(input) {
    if (!exactKeys(input, ["account_id", "name", "tag"])) {
      refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_INPUT_INVALID");
    }
    const accountId = cleanAccountId(input.account_id);
    const name = cleanScriptName(input.name);
    const tag = cleanText(input.tag, 100,
      "CF_DISPOSABLE_TRANSPORT_PROVISION_INPUT_INVALID");
    let body = jsonMutationBody({
      name,
      subdomain: { enabled: true, previews_enabled: false },
      tags: [tag],
    });
    try {
      const response = await withToken((token) => request(token, {
        url: apiUrl(accountPath(accountId, "/workers/workers")),
        method: "POST",
        body,
        contentType: "application/json",
        mutation: true,
      }));
      const created = validateMutationResult(() => normalizeProvisionWorker(
        response.result, name, tag, "CF_DISPOSABLE_TRANSPORT_PROVISION_RESPONSE_INVALID",
      ));
      return deepFreeze({
        schema_version: 1,
        operation: "create_worker_identity",
        worker_id: created.workerId,
        created_on: created.createdOn,
        hostname: created.hostname,
        tag_sha256: sha256(tag),
        request_body_sha256: sha256(body),
        response: response.evidence,
      });
    } finally { body.fill(0); }
  }

  async function readWorkerIdentity(input) {
    if (!exactKeys(input, ["account_id", "worker_id", "expected_name", "expected_tag"])) {
      refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_INPUT_INVALID");
    }
    const accountId = cleanAccountId(input.account_id);
    const workerId = cleanProvisionWorkerId(input.worker_id,
      "CF_DISPOSABLE_TRANSPORT_PROVISION_INPUT_INVALID");
    const expectedName = cleanScriptName(input.expected_name);
    const expectedTag = cleanText(input.expected_tag, 100,
      "CF_DISPOSABLE_TRANSPORT_PROVISION_INPUT_INVALID");
    const response = await withToken((token) => request(token, {
      url: apiUrl(accountPath(accountId, `/workers/workers/${encoded(workerId)}`)),
      method: "GET",
      mutation: false,
    }));
    const worker = normalizeProvisionWorker(response.result, expectedName, expectedTag,
      "CF_DISPOSABLE_TRANSPORT_PROVISION_RESPONSE_INVALID");
    if (worker.workerId !== workerId) {
      refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_RESOURCE_CHANGED");
    }
    return deepFreeze({
      schema_version: 1,
      operation: "read_worker_identity",
      worker_id: worker.workerId,
      created_on: worker.createdOn,
      hostname: worker.hostname,
      tag_sha256: sha256(expectedTag),
      response: response.evidence,
    });
  }

  async function readWorkerVersionInventory(input) {
    if (!exactKeys(input, ["account_id", "worker_id"])) {
      refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_INPUT_INVALID");
    }
    const accountId = cleanAccountId(input.account_id);
    const workerId = cleanProvisionWorkerId(input.worker_id,
      "CF_DISPOSABLE_TRANSPORT_PROVISION_INPUT_INVALID");
    return withToken(async (token) => {
      const versions = [];
      const responses = [];
      let pageNumber = 1;
      let totalPages = null;
      let totalCount = null;
      for (;;) {
        const response = await request(token, {
          url: apiUrl(accountPath(accountId,
            `/workers/workers/${encoded(workerId)}/versions`), [
            ["page", String(pageNumber)], ["per_page", "100"],
          ]),
          method: "GET",
          mutation: false,
          allowResultInfo: true,
        });
        const info = response.body.result_info;
        if (!Array.isArray(response.result) || !info || !onlyKeys(info,
          ["count", "page", "per_page", "total_count", "total_pages"],
          ["count", "page", "per_page", "total_count", "total_pages"]) ||
            info.page !== pageNumber || info.per_page !== 100 ||
            info.count !== response.result.length ||
            !Number.isSafeInteger(info.total_count) || info.total_count < 0 ||
            !Number.isSafeInteger(info.total_pages) || info.total_pages < 0 ||
            info.total_pages > 1000 ||
            info.total_pages === 0 && info.total_count !== 0) {
          refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_VERSION_INVALID");
        }
        if (totalPages === null) {
          totalPages = info.total_pages;
          totalCount = info.total_count;
        } else if (info.total_pages !== totalPages || info.total_count !== totalCount) {
          refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_VERSION_INVALID");
        }
        versions.push(...response.result.map(normalizeProvisionVersion));
        responses.push({
          operation: `list_worker_versions_for_provision_page_${pageNumber}`,
          ...response.evidence,
        });
        if (totalPages === 0 || pageNumber === totalPages) break;
        pageNumber += 1;
      }
      if (versions.length !== totalCount || new Set(versions.map((entry) =>
        entry.version_id)).size !== versions.length ||
          new Set(versions.map((entry) => entry.number)).size !== versions.length) {
        refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_VERSION_INVALID");
      }
      versions.sort((left, right) => compareText(left.version_id, right.version_id));
      return deepFreeze({
        schema_version: CLOUDFLARE_DISPOSABLE_DEPLOYMENT_TRANSPORT_SCHEMA_VERSION,
        operation: "read_worker_version_inventory",
        worker_id: workerId,
        version_count: versions.length,
        versions,
        responses,
      });
    });
  }

  async function readWorkerVersionForProvisioning(input) {
    if (!exactKeys(input, ["account_id", "worker_id", "version_id"])) {
      refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_INPUT_INVALID");
    }
    const accountId = cleanAccountId(input.account_id);
    const workerId = cleanProvisionWorkerId(input.worker_id,
      "CF_DISPOSABLE_TRANSPORT_PROVISION_INPUT_INVALID");
    const versionId = cleanUuid(input.version_id,
      "CF_DISPOSABLE_TRANSPORT_PROVISION_INPUT_INVALID");
    const response = await withToken((token) => request(token, {
      url: apiUrl(accountPath(accountId,
        `/workers/workers/${encoded(workerId)}/versions/${encoded(versionId)}`), [
        ["include", "modules"],
      ]),
      method: "GET",
      mutation: false,
    }));
    const version = normalizeProvisionVersion(response.result, { includeModules: true });
    if (version.version_id !== versionId) {
      refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_RESOURCE_CHANGED");
    }
    return deepFreeze({
      schema_version: CLOUDFLARE_DISPOSABLE_DEPLOYMENT_TRANSPORT_SCHEMA_VERSION,
      operation: "read_worker_version_for_provisioning",
      worker_id: workerId,
      ...version,
      response: response.evidence,
    });
  }

  async function createWorkerBaseline(input) {
    if (!exactKeys(input, [
      "account_id", "worker_id", "main_module", "modules", "compatibility_date",
      "bindings", "secret_bindings", "tag", "message",
    ])) {
      refuse("CF_DISPOSABLE_TRANSPORT_PROVISION_INPUT_INVALID");
    }
    const accountId = cleanAccountId(input.account_id);
    const workerId = cleanProvisionWorkerId(input.worker_id,
      "CF_DISPOSABLE_TRANSPORT_PROVISION_INPUT_INVALID");
    const mainModule = cleanText(input.main_module, 256,
      "CF_DISPOSABLE_TRANSPORT_MODULE_INVENTORY_INVALID");
    if (!MODULE_NAME_RE.test(mainModule)) {
      refuse("CF_DISPOSABLE_TRANSPORT_MODULE_INVENTORY_INVALID");
    }
    const bindings = normalizeBindingList(input.bindings, normalizeUploadBinding,
      "CF_DISPOSABLE_TRANSPORT_BINDING_INVALID");
    const secretBindings = cleanProvisionSecretBindings(input.secret_bindings,
      new Set(bindings.map((binding) => binding.name)));
    const secretValues = secretBindings.map((binding) => binding.text);
    const allBindings = [...bindings, ...secretBindings].sort((left, right) =>
      compareText(left.name, right.name));
    const modules = cleanModules(input.modules, mainModule);
    let body;
    try {
      const inventory = moduleInventory(modules, mainModule);
      const metadata = {
        annotations: {
          "workers/message": cleanText(input.message, 1000,
            "CF_DISPOSABLE_TRANSPORT_PROVISION_INPUT_INVALID"),
          "workers/tag": cleanText(input.tag, 100,
            "CF_DISPOSABLE_TRANSPORT_PROVISION_INPUT_INVALID"),
        },
        bindings: allBindings,
        compatibility_date: cleanCompatibilityDate(input.compatibility_date),
        main_module: mainModule,
        usage_model: "standard",
      };
      // The immutable-ID Workers beta endpoint is a JSON API. Its module
      // contract carries base64 content inline; multipart belongs to the
      // name-addressed /workers/scripts/{name}/versions endpoint used by the
      // later secret-inheriting uploads.
      body = Buffer.from(canonical({
        ...metadata,
        modules: modules.map((module) => ({
          content_base64: module.bytes.toString("base64"),
          content_type: module.content_type,
          name: module.name,
        })),
      }), "utf8");
      if (body.byteLength > MAX_UPLOAD_BYTES) {
        body.fill(0);
        body = null;
        refuse("CF_DISPOSABLE_TRANSPORT_UPLOAD_OVERSIZED");
      }
      const response = await withToken((token) => request(token, {
        url: apiUrl(accountPath(accountId,
          `/workers/workers/${encoded(workerId)}/versions`), [["deploy", "true"]]),
        method: "POST",
        body,
        contentType: "application/json",
        mutation: true,
      }));
      if (containsAnySecret(response.body, secretValues)) {
        refuse("CF_DISPOSABLE_TRANSPORT_SECRET_RESPONSE_REFUSED");
      }
      const versionId = validateMutationResult(() => cleanUuid(
        response.result?.id, "CF_DISPOSABLE_TRANSPORT_PROVISION_RESPONSE_INVALID",
      ));
      return deepFreeze({
        schema_version: 1,
        operation: "create_worker_baseline",
        deployed: true,
        version_id: versionId,
        request: {
          // Never retain a digest of the secret-bearing body or metadata. A
          // brute-forceable secret must not acquire a durable verifier.
          redacted_semantic_sha256: sha256(canonical({
            compatibility_date: metadata.compatibility_date,
            main_module: mainModule,
            bindings: allBindings.map((binding) => binding.type === "secret_text"
              ? { name: binding.name, type: binding.type }
              : binding),
            module_inventory_sha256: inventory.sha256,
            tag: metadata.annotations["workers/tag"],
          })),
          module_inventory_sha256: inventory.sha256,
        },
        response: response.evidence,
      });
    } finally {
      if (body) body.fill(0);
      for (const module of modules) module.bytes.fill(0);
      for (const binding of secretBindings) binding.text = "";
      secretValues.fill("");
    }
  }

  async function queryD1(input) {
    if (!exactKeys(input, ["account_id", "database_id", "sql", "params"]) ||
        typeof input.sql !== "string" || !input.sql.trim() ||
        Buffer.byteLength(input.sql, "utf8") > 1024 * 1024 ||
        !Array.isArray(input.params) || input.params.length > 1024) {
      refuse("CF_DISPOSABLE_TRANSPORT_D1_QUERY_INPUT_INVALID");
    }
    const accountId = cleanAccountId(input.account_id);
    const databaseId = cleanUuid(input.database_id,
      "CF_DISPOSABLE_TRANSPORT_D1_QUERY_INPUT_INVALID");
    let body = jsonMutationBody({ params: input.params, sql: input.sql });
    try {
      const response = await withToken((token) => request(token, {
        url: apiUrl(accountPath(accountId,
          `/d1/database/${encoded(databaseId)}/query`)),
        method: "POST",
        body,
        contentType: "application/json",
        mutation: true,
      }));
      const queryResult = validateMutationResult(() => {
        if (!Array.isArray(response.result) || response.result.length !== 1 ||
            !onlyKeys(response.result[0], ["meta", "results", "success"],
              ["meta", "results", "success"]) || response.result[0].success !== true ||
            !Array.isArray(response.result[0].results) ||
            !response.result[0].meta || typeof response.result[0].meta !== "object" ||
            Array.isArray(response.result[0].meta)) {
          refuse("CF_DISPOSABLE_TRANSPORT_D1_QUERY_RESPONSE_INVALID");
        }
        return response.result[0];
      });
      return deepFreeze({
        schema_version: 1,
        operation: "query_d1",
        request_body_sha256: sha256(body),
        results: queryResult.results,
        response: response.evidence,
      });
    } finally { body.fill(0); }
  }


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
      behavior_exact: true,
      behavior_sha256: readback.behaviorSha256,
      compatibility_and_usage_model_exact: true,
      handlers: readback.handlers,
      named_handlers_count: readback.namedHandlersCount,
      reviewed_worker_generation_sha256: readback.reviewedWorkerGenerationSha256,
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

  async function readCurrentDeploymentState(input) {
    if (!exactKeys(input, ["account_id", "script_name"])) {
      refuse("CF_DISPOSABLE_TRANSPORT_DEPLOYMENT_INPUT_INVALID");
    }
    const accountId = cleanAccountId(input.account_id);
    const scriptName = cleanScriptName(input.script_name);
    const response = await withToken((token) => request(token, {
      url: apiUrl(accountPath(accountId,
        `/workers/scripts/${encoded(scriptName)}/deployments`)),
      method: "GET",
      mutation: false,
    }));
    if (!exactKeys(response.result, ["deployments"]) ||
        !Array.isArray(response.result.deployments)) {
      refuse("CF_DISPOSABLE_TRANSPORT_DEPLOYMENT_RESPONSE_INVALID");
    }
    const deployments = response.result.deployments.map((entry) =>
      normalizeDeployment(entry, "CF_DISPOSABLE_TRANSPORT_DEPLOYMENT_RESPONSE_INVALID"));
    return deepFreeze({
      schema_version: CLOUDFLARE_DISPOSABLE_DEPLOYMENT_TRANSPORT_SCHEMA_VERSION,
      operation: "read_current_deployment_state",
      deployment_count: deployments.length,
      current: deployments.length === 0 ? null : {
        deployment_id: deployments[0].deploymentId,
        strategy: "percentage",
        versions: deployments[0].versions,
      },
      response: response.evidence,
    });
  }

  async function readWorkerVersionSettings(input) {
    if (!exactKeys(input, [
      "account_id", "script_name", "main_module", "compatibility_date",
      "bindings", "tag", "message", "worker_tag",
    ])) {
      refuse("CF_DISPOSABLE_TRANSPORT_VERSION_INPUT_INVALID");
    }
    const accountId = cleanAccountId(input.account_id);
    const scriptName = cleanScriptName(input.script_name);
    const mainModule = cleanText(input.main_module, 256,
      "CF_DISPOSABLE_TRANSPORT_VERSION_INPUT_INVALID");
    const compatibilityDate = cleanCompatibilityDate(input.compatibility_date);
    const bindings = normalizeBindingList(input.bindings, normalizeReadBinding,
      "CF_DISPOSABLE_TRANSPORT_BINDING_INVALID");
    const tag = cleanText(input.tag, 100, "CF_DISPOSABLE_TRANSPORT_VERSION_INPUT_INVALID");
    const message = cleanText(input.message, 1000,
      "CF_DISPOSABLE_TRANSPORT_VERSION_INPUT_INVALID");
    const workerTag = cleanText(input.worker_tag, 100,
      "CF_DISPOSABLE_TRANSPORT_VERSION_INPUT_INVALID");
    const response = await withToken((token) => request(token, {
      url: apiUrl(accountPath(accountId,
        `/workers/scripts/${encoded(scriptName)}/settings`)),
      method: "GET",
      mutation: false,
    }));
    const allowed = [
      "annotations", "assets", "bindings", "capnp_schema", "compatibility_date",
      "compatibility_flags", "keep_assets", "limits", "logpush", "main_module",
      "migrations", "observability", "placement", "tail_consumers", "usage_model",
      "cache_options", "tags",
    ];
    if (!onlyKeys(response.result, allowed, [
      "annotations", "bindings", "compatibility_date", "main_module", "usage_model",
    ]) || !onlyKeys(response.result.annotations,
      ["workers/message", "workers/tag", "workers/triggered_by"],
      ["workers/message", "workers/tag"]) ||
        response.result.annotations["workers/message"] !== message ||
        response.result.annotations["workers/tag"] !== tag ||
        response.result.main_module !== mainModule ||
        response.result.compatibility_date !== compatibilityDate ||
        response.result.usage_model !== "standard") {
      refuse("CF_DISPOSABLE_TRANSPORT_VERSION_MISMATCH");
    }
    const observedBindings = normalizeBindingList(
      response.result.bindings, normalizeReadBinding,
      "CF_DISPOSABLE_TRANSPORT_VERSION_RESPONSE_INVALID",
    );
    const behavior = normalizeNeutralSettingsBehavior(
      response.result, workerTag, "CF_DISPOSABLE_TRANSPORT_VERSION_MISMATCH",
    );
    if (canonical(observedBindings) !== canonical(bindings)) {
      refuse("CF_DISPOSABLE_TRANSPORT_VERSION_MISMATCH");
    }
    return deepFreeze({
      schema_version: CLOUDFLARE_DISPOSABLE_DEPLOYMENT_TRANSPORT_SCHEMA_VERSION,
      operation: "read_worker_version_settings",
      tag_sha256: sha256(tag),
      message_sha256: sha256(message),
      bindings_sha256: sha256(canonical(observedBindings)),
      behavior_exact: true,
      behavior_sha256: sha256(canonical(behavior)),
      main_module: mainModule,
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
      const surface = workerSurfaceProof(scripts[0], value.scriptName);

      const betaInventory = await exhaustiveBetaWorkerList(
        token,
        value.accountId,
        observations,
      );
      const betaMatches = betaInventory.workers.filter((entry) =>
        entry.name === value.scriptName);
      if (betaMatches.length !== 1 || betaMatches[0].deployed_on === null) {
        refuse("CF_DISPOSABLE_TRANSPORT_WORKER_IDENTITY_INVALID");
      }
      const betaWorker = betaMatches[0];
      const betaDetail = await get(
        "read_beta_worker",
        `/workers/workers/${encoded(betaWorker.id)}`,
      );
      let referenceSnapshot;
      try {
        referenceSnapshot = normalizeV048WorkerReferenceSnapshot(betaDetail.result, {
          expectedWorkerName: value.scriptName,
          expectedWorkerId: betaWorker.id,
          expectedDomain: value.expected.domain,
        });
      } catch {
        refuse("CF_DISPOSABLE_TRANSPORT_WORKER_IDENTITY_INVALID");
      }
      const workerIdentitySha256 = combinedWorkerIdentitySha256(
        surface,
        referenceSnapshot,
      );

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
        vectorize_created_on: vectorResponse.result.created_on === undefined
          ? null
          : cleanIsoTimestamp(vectorResponse.result.created_on,
            "CF_DISPOSABLE_TRANSPORT_RESOURCE_RESPONSE_INVALID"),
        vector_dimensions: value.dimensions,
        vector_metric: value.metric,
        vector_count: vectorInfoResponse.result.vectorCount,
        workers_dev_enabled: subdomainResponse.result.enabled,
        previews_enabled: subdomainResponse.result.previews_enabled,
        routes_count: routesCount,
        custom_domains_count: customDomainsCount,
        schedules_count: schedules.length,
        provider_readback: true,
        network_isolation: {
          worker_identity_proved: true,
          worker_identity_sha256: workerIdentitySha256,
          workers_dev_identity_proved: true,
          worker_previews_disabled: true,
          worker_cache_enabled: false,
          worker_extra_exports: 0,
          worker_tail_consumers: 0,
          worker_assets: false,
          worker_logpush: false,
          cron_triggers: schedules.length,
          routes: routesCount,
          custom_domains: customDomainsCount,
        },
        responses: observations,
      });
    });
  }

  async function captureCampaignCustody(token, context) {
    const observations = [];
    const get = async (operation, path, { allowAbsent404 = false } = {}) => {
      const response = await request(token, {
        url: apiUrl(accountPath(context.accountId, path)),
        method: "GET",
        mutation: false,
        allowAbsent404,
      });
      observations.push(evidenceEntry(operation, response.evidence));
      return response;
    };

    const openingInventory = await exhaustiveBetaWorkerList(
      token,
      context.accountId,
      observations,
    );
    const classicResponse = await get("list_classic_workers", "/workers/scripts");
    if (!Array.isArray(classicResponse.result)) {
      refuse("CF_DISPOSABLE_TRANSPORT_CAMPAIGN_RESPONSE_INVALID");
    }
    const campaignNames = new Set(["source", "target"].map((role) =>
      context.campaignResources[role].workerName));
    const roles = {};
    const generationAuthority = { source: null, target: null };
    const vectorizeInstanceAuthorityByRole = { source: null, target: null };
    const workerEvidence = {};

    for (const role of ["source", "target"]) {
      const resource = context.campaignResources[role];
      const expected = context.expectedWorkers[role];
      const betaMatches = openingInventory.workers.filter((worker) =>
        worker.name === resource.workerName);
      const classicMatches = classicResponse.result.filter((worker) =>
        worker?.id === resource.workerName);
      if (betaMatches.length > 1 || classicMatches.length > 1 ||
          betaMatches.length !== classicMatches.length) {
        refuse("CF_DISPOSABLE_TRANSPORT_CAMPAIGN_WORKER_STATE_INVALID");
      }
      const workerState = betaMatches.length === 1 ? "present" : "absent";

      const d1Response = await get(
        `${role}_read_d1_database`,
        `/d1/database/${encoded(resource.d1DatabaseId)}`,
        { allowAbsent404: true },
      );
      if (!d1Response.absent &&
          (!exactKeys(d1Response.result, ["name", "uuid"]) ||
           d1Response.result.uuid !== resource.d1DatabaseId ||
           d1Response.result.name !== resource.d1DatabaseName)) {
        refuse("CF_DISPOSABLE_TRANSPORT_CAMPAIGN_RESOURCE_MISMATCH");
      }
      const d1State = d1Response.absent ? "absent" : "present";
      const d1InstanceSha256 = d1Response.absent
        ? null
        : domainHash(RESOURCE_INSTANCE_HASH_DOMAIN, {
          kind: "d1",
          role,
          result: d1Response.result,
        });

      const vectorResponse = await get(
        `${role}_read_vectorize_index`,
        `/vectorize/v2/indexes/${encoded(resource.vectorizeIndexName)}`,
        { allowAbsent404: true },
      );
      if (!vectorResponse.absent &&
          (!onlyKeys(vectorResponse.result,
            ["config", "created_on", "description", "modified_on", "name"],
            ["config", "created_on", "name"]) ||
           vectorResponse.result.name !== resource.vectorizeIndexName ||
           !exactKeys(vectorResponse.result.config, ["dimensions", "metric"]) ||
           vectorResponse.result.config.dimensions !== 768 ||
           vectorResponse.result.config.metric !== "cosine" ||
           typeof vectorResponse.result.created_on !== "string" ||
           !Number.isFinite(Date.parse(vectorResponse.result.created_on)))) {
        refuse("CF_DISPOSABLE_TRANSPORT_CAMPAIGN_RESOURCE_MISMATCH");
      }
      const vectorizeState = vectorResponse.absent ? "absent" : "present";
      const vectorizeAuthority = vectorResponse.absent
        ? null
        : vectorizeInstanceAuthority({
          role,
          indexName: vectorResponse.result.name,
          dimensions: vectorResponse.result.config.dimensions,
          metric: vectorResponse.result.config.metric,
          createdOn: vectorResponse.result.created_on,
        });
      const vectorizeInstanceSha256 =
        vectorizeAuthority?.instance_sha256 ?? null;
      vectorizeInstanceAuthorityByRole[role] = vectorizeAuthority;

      let workerInstanceSha256 = null;
      let workerProtection = null;
      if (workerState === "present") {
        const betaWorker = betaMatches[0];
        if (betaWorker.deployed_on === null) {
          refuse("CF_DISPOSABLE_TRANSPORT_CAMPAIGN_WORKER_STATE_INVALID");
        }
        const surface = workerSurfaceProof(classicMatches[0], resource.workerName);
        const detail = await get(
          `${role}_read_beta_worker`,
          `/workers/workers/${encoded(betaWorker.id)}`,
        );
        let referenceSnapshot;
        try {
          referenceSnapshot = normalizeV048WorkerReferenceSnapshot(detail.result, {
            expectedWorkerName: resource.workerName,
            expectedWorkerId: betaWorker.id,
            expectedDomain: resource.domain,
          });
        } catch {
          refuse("CF_DISPOSABLE_TRANSPORT_CAMPAIGN_WORKER_REFERENCE_INVALID");
        }
        const workerIdentitySha256 = combinedWorkerIdentitySha256(
          surface,
          referenceSnapshot,
        );
        const deploymentPath =
          `/workers/scripts/${encoded(resource.workerName)}/deployments`;
        const deploymentBefore = await get(
          `${role}_read_current_deployment_before`,
          deploymentPath,
        );
        if (!exactKeys(deploymentBefore.result, ["deployments"]) ||
            !Array.isArray(deploymentBefore.result.deployments) ||
            deploymentBefore.result.deployments.length < 1) {
          refuse("CF_DISPOSABLE_TRANSPORT_CAMPAIGN_WORKER_GENERATION_INVALID");
        }
        const deployment = normalizeDeployment(
          deploymentBefore.result.deployments[0],
          "CF_DISPOSABLE_TRANSPORT_CAMPAIGN_WORKER_GENERATION_INVALID",
        );
        if (deployment.versions.length !== 1 || deployment.versions[0].percentage !== 100 ||
            deployment.versions[0].version_id !== expected.versionId ||
            (expected.deploymentId !== null &&
             deployment.deploymentId !== expected.deploymentId) ||
            betaWorker.deployed_on !==
              deploymentBefore.result.deployments[0].created_on) {
          refuse("CF_DISPOSABLE_TRANSPORT_CAMPAIGN_WORKER_GENERATION_CHANGED");
        }
        const versionResponse = await get(
          `${role}_read_current_version`,
          `/workers/scripts/${encoded(resource.workerName)}/versions/` +
            encoded(expected.versionId),
        );
        if (versionResponse.result?.resources?.script?.etag !== expected.scriptEtag) {
          refuse("CF_DISPOSABLE_TRANSPORT_CAMPAIGN_WORKER_GENERATION_CHANGED");
        }
        const mode = role === "source"
          ? "active"
          : versionResponse.result.resources.bindings.some((binding) =>
            binding?.type === "plain_text" && binding?.name === "VECTOR_DRAIN_MODE")
            ? "paused"
            : "active";
        const reviewed = reviewedWorkerGeneration(versionResponse.result, {
          role,
          expectedMode: role === "source" ? null : mode,
        });
        if (expected.reviewedWorkerGenerationSha256 !== null &&
            reviewed !== expected.reviewedWorkerGenerationSha256) {
          refuse("CF_DISPOSABLE_TRANSPORT_CAMPAIGN_WORKER_GENERATION_CHANGED");
        }
        const deploymentAfter = await get(
          `${role}_read_current_deployment_after`,
          deploymentPath,
        );
        if (canonical(deploymentAfter.result) !== canonical(deploymentBefore.result)) {
          refuse("CF_DISPOSABLE_TRANSPORT_CAMPAIGN_WORKER_GENERATION_CHANGED");
        }
        workerInstanceSha256 = domainHash(RESOURCE_INSTANCE_HASH_DOMAIN, {
          kind: "worker",
          role,
          beta_worker: betaWorker,
          worker_reference_snapshot_sha256: referenceSnapshot.snapshot_sha256,
        });
        workerProtection = Object.freeze({
          schema_version: 1,
          worker_identity_proved: true,
          worker_identity_sha256: workerIdentitySha256,
          worker_reference_snapshot_sha256: referenceSnapshot.snapshot_sha256,
          reviewed_worker_generation_sha256: reviewed,
          worker_generation_proved: true,
          worker_generation_sha256: workerGenerationSha256({
            role,
            mode,
            workerIdentitySha256,
            deploymentId: deployment.deploymentId,
            versionId: expected.versionId,
            reviewedWorkerGenerationSha256: reviewed,
          }),
        });
        generationAuthority[role] = campaignGenerationAuthority({
          role,
          mode,
          workerIdentitySha256,
          deploymentId: deployment.deploymentId,
          versionId: expected.versionId,
          reviewedWorkerGenerationSha256: reviewed,
        });
      }

      roles[role] = Object.freeze({
        state: Object.freeze({
          worker: workerState,
          d1: d1State,
          vectorize: vectorizeState,
        }),
        worker_instance_sha256: workerInstanceSha256,
        d1_instance_sha256: d1InstanceSha256,
        vectorize_instance_sha256: vectorizeInstanceSha256,
        worker_protection: workerProtection,
      });
      workerEvidence[role] = Object.freeze({
        workerState,
      });
    }

    assertCampaignLifecycleStates(roles, context.teardownRole);

    const nonCampaignWorkers = [];
    for (const worker of openingInventory.workers.filter((entry) =>
      !campaignNames.has(entry.name))) {
      const deploymentPath = `/workers/scripts/${encoded(worker.name)}/deployments`;
      const before = await get(
        `non_campaign_${nonCampaignWorkers.length}_deployment_before`,
        deploymentPath,
      );
      if (!exactKeys(before.result, ["deployments"]) ||
          !Array.isArray(before.result.deployments)) {
        refuse("CF_DISPOSABLE_TRANSPORT_CAMPAIGN_RESPONSE_INVALID");
      }
      const trafficVersions = [];
      if (before.result.deployments.length > 0) {
        const deployment = normalizeDeployment(
          before.result.deployments[0],
          "CF_DISPOSABLE_TRANSPORT_CAMPAIGN_RESPONSE_INVALID",
        );
        if (worker.deployed_on === null ||
            worker.deployed_on !== before.result.deployments[0].created_on) {
          refuse("CF_DISPOSABLE_TRANSPORT_CAMPAIGN_WORKER_STATE_INVALID");
        }
        for (const traffic of deployment.versions) {
          const version = await get(
            `non_campaign_${nonCampaignWorkers.length}_traffic_version`,
            `/workers/scripts/${encoded(worker.name)}/versions/${encoded(traffic.version_id)}`,
          );
          trafficVersions.push(version.result);
        }
      } else if (worker.deployed_on !== null) {
        refuse("CF_DISPOSABLE_TRANSPORT_CAMPAIGN_WORKER_STATE_INVALID");
      }
      const after = await get(
        `non_campaign_${nonCampaignWorkers.length}_deployment_after`,
        deploymentPath,
      );
      if (canonical(after.result) !== canonical(before.result)) {
        refuse("CF_DISPOSABLE_TRANSPORT_CAMPAIGN_WORKER_GENERATION_CHANGED");
      }
      nonCampaignWorkers.push(Object.freeze({
        workerId: worker.id,
        workerName: worker.name,
        deploymentList: before.result,
        trafficVersions: Object.freeze(trafficVersions),
      }));
    }

    let campaignCustody;
    try {
      campaignCustody = verifyV048ExclusiveCampaignResourceCustodyWithAuthority({
        campaignResources: {
          teardownRole: context.teardownRole,
          source: {
            workerName: context.campaignResources.source.workerName,
            workerState: workerEvidence.source.workerState,
            d1DatabaseId: context.campaignResources.source.d1DatabaseId,
            vectorizeIndexName: context.campaignResources.source.vectorizeIndexName,
          },
          target: {
            workerName: context.campaignResources.target.workerName,
            workerState: workerEvidence.target.workerState,
            d1DatabaseId: context.campaignResources.target.d1DatabaseId,
            vectorizeIndexName: context.campaignResources.target.vectorizeIndexName,
          },
        },
        initialWorkerList: openingInventory,
        nonCampaignWorkers,
      });
    } catch {
      refuse("CF_DISPOSABLE_TRANSPORT_CAMPAIGN_CUSTODY_INVALID");
    }

    const closingInventory = await exhaustiveBetaWorkerList(
      token,
      context.accountId,
      observations,
    );
    if (canonical(closingInventory) !== canonical(openingInventory)) {
      refuse("CF_DISPOSABLE_TRANSPORT_CAMPAIGN_INVENTORY_CHANGED");
    }
    return Object.freeze({
      semantic: deepFreeze({
        roles: Object.freeze(roles),
        campaign_custody: campaignCustody.receipt,
        campaign_custody_authority: campaignCustody.authority,
        generation_authority: Object.freeze(generationAuthority),
        vectorize_instance_authority:
          Object.freeze(vectorizeInstanceAuthorityByRole),
      }),
      responses: Object.freeze(observations),
    });
  }

  async function readCampaignCustody(input) {
    const context = cleanCampaignCustodyRequest(input);
    return withToken(async (token) => {
      const first = await captureCampaignCustody(token, context);
      const second = await captureCampaignCustody(token, context);
      if (canonical(first.semantic) !== canonical(second.semantic)) {
        refuse("CF_DISPOSABLE_TRANSPORT_CAMPAIGN_CAPTURE_CHANGED");
      }
      const semantic = {
        schema_version: CLOUDFLARE_DISPOSABLE_DEPLOYMENT_TRANSPORT_SCHEMA_VERSION,
        operation: "read_campaign_custody",
        captures: 2,
        teardown_role: context.teardownRole,
        roles: first.semantic.roles,
        campaign_custody: first.semantic.campaign_custody,
        campaign_custody_authority: first.semantic.campaign_custody_authority,
        generation_authority: first.semantic.generation_authority,
        vectorize_instance_authority:
          first.semantic.vectorize_instance_authority,
      };
      const proof = deepFreeze({
        ...semantic,
        proof_sha256: domainHash(CAMPAIGN_PROOF_HASH_DOMAIN, semantic),
        responses: [...first.responses, ...second.responses],
      });
      assertCloudflareDisposableCampaignCustodyProof((({ responses, ...value }) =>
        value)(proof));
      return proof;
    });
  }

  return Object.freeze({
    readProvisioningCollisions,
    createD1Database,
    createVectorizeIndex,
    createVectorizeMetadataIndex,
    readVectorizeMetadataIndexes,
    createWorkerIdentity,
    readWorkerIdentity,
    readWorkerVersionInventory,
    readWorkerVersionForProvisioning,
    createWorkerBaseline,
    queryD1,
    uploadVersion,
    readVersion,
    deployVersion,
    readCurrentDeployment,
    readCurrentDeploymentState,
    readDeployment,
    readWorkerVersionSettings,
    readResourceContract,
    readCampaignCustody,
  });
}
