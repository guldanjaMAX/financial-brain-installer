/**
 * Pure contract for the reviewed v0.4.8 disposable Worker version.
 * Provider payloads remain ephemeral; callers persist only aggregate proofs.
 */

const SHA256_RE = /^[a-f0-9]{64}$/;
const REQUIRED_SECRET_NAMES = Object.freeze([
  "ADMIN_KEY", "RAG_PROXY_KEY", "SESSION_SIGNING_KEY",
]);
const BANK_SECRET_NAMES = Object.freeze(["BANK_FEED_CLIENT_ID", "BANK_FEED_SECRET"]);
const ZOOM_SECRET_NAMES = Object.freeze([
  "ZOOM_ACCOUNT_ID", "ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET", "ZOOM_WEBHOOK_SECRET_TOKEN",
]);
const OPTIONAL_SECRET_NAMES = new Set([
  ...BANK_SECRET_NAMES, "BANK_FEED_WRAPPING_KEY_V2", ...ZOOM_SECRET_NAMES,
]);

export const V048_WORKER_ANSWER_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const V048_WORKER_DAILY_LLM_CAP_USD = "10";
export const V048_WORKER_CREDENTIAL_SCANNER = "on";
export const V048_WORKER_CHUNK_SIZE = "1500";
export const V048_WORKER_CHUNK_OVERLAP = "300";

export class V048WorkerVersionContractError extends Error {
  constructor(code) {
    super(code);
    this.name = "V048WorkerVersionContractError";
    this.code = code;
  }
}

function refuse(code) {
  throw new V048WorkerVersionContractError(code);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactString(value, code) {
  if (typeof value !== "string" || !value || value.length > 4096 ||
      /[\u0000-\u001f\u007f]/u.test(value)) refuse(code);
  return value;
}

function assertCompleteOptionalGroup(secretNames, group) {
  const present = group.filter((name) => secretNames.includes(name)).length;
  if (present !== 0 && present !== group.length) refuse("V048_SOURCE_WORKER_BINDINGS_INVALID");
}

export function assertV048SourceWorkerVersion(
  version,
  binding,
  expectedScriptEtag,
  { role = "source", expectedMode = role === "target" ? "active" : null } = {},
) {
  if (!version || typeof version !== "object" || Array.isArray(version) ||
      !binding || typeof binding !== "object" || Array.isArray(binding) ||
      !new Set(["source", "target"]).has(role) ||
      (role === "source" && expectedMode !== null) ||
      (role === "target" && !new Set(["paused", "active"]).has(expectedMode)) ||
      !SHA256_RE.test(String(expectedScriptEtag || ""))) {
    refuse("V048_SOURCE_WORKER_VERSION_INVALID");
  }
  exactString(version.id, "V048_SOURCE_WORKER_VERSION_INVALID");
  const resources = version.resources;
  if (!resources || typeof resources !== "object" || Array.isArray(resources) ||
      canonical(Object.keys(resources).sort()) !==
        canonical(["bindings", "script", "script_runtime"])) {
    refuse("V048_SOURCE_WORKER_VERSION_INVALID");
  }
  const script = resources.script;
  const runtime = resources.script_runtime;
  if (!script || typeof script !== "object" || Array.isArray(script) ||
      canonical(Object.keys(script).sort()) !==
        canonical(["etag", "handlers", "last_deployed_from", "named_handlers"]) ||
      !runtime || typeof runtime !== "object" || Array.isArray(runtime) ||
      canonical(Object.keys(runtime).sort()) !==
        canonical(["compatibility_date", "usage_model"]) ||
      script.etag !== expectedScriptEtag || script.last_deployed_from !== "api" ||
      canonical([...(script.handlers || [])].sort()) !== canonical(["fetch", "scheduled"]) ||
      !Array.isArray(script.named_handlers) || script.named_handlers.length !== 0 ||
      runtime.compatibility_date !== "2026-01-01" || runtime.usage_model !== "standard") {
    refuse("V048_SOURCE_WORKER_CODE_INVALID");
  }

  const bindings = resources.bindings;
  if (!Array.isArray(bindings) || bindings.some((entry) =>
    !entry || typeof entry !== "object" || Array.isArray(entry))) {
    refuse("V048_SOURCE_WORKER_BINDINGS_INVALID");
  }
  const requiredNonSecret = [
    "AI", "ANSWER_MODEL", "BRAIN_NAME", "BRAIN_OWNER", "BRAIN_VERSION",
    "CHUNK_OVERLAP", "CHUNK_SIZE", "CREDENTIAL_SCANNER", "DAILY_LLM_CAP_USD",
    "DB", "STORAGE", "VECTORIZE",
    ...(role === "target" && expectedMode === "paused" ? ["VECTOR_DRAIN_MODE"] : []),
  ].sort();
  const nonSecretNames = bindings
    .filter((entry) => entry.type !== "secret_text")
    .map((entry) => exactString(entry.name, "V048_SOURCE_WORKER_BINDINGS_INVALID"))
    .sort();
  if (canonical(nonSecretNames) !== canonical(requiredNonSecret)) {
    refuse("V048_SOURCE_WORKER_BINDINGS_INVALID");
  }
  const exactlyOne = (predicate) => bindings.filter(predicate).length === 1;
  if (!exactlyOne((entry) => entry.type === "d1" && entry.name === "DB" &&
        entry.id === binding.databaseId && entry.database_id === binding.databaseId) ||
      !exactlyOne((entry) => entry.type === "vectorize" && entry.name === "VECTORIZE" &&
        entry.index_name === binding.vectorizeIndex) ||
      !exactlyOne((entry) => entry.type === "ai" && entry.name === "AI" &&
        entry.project === "<catalog>") ||
      !exactlyOne((entry) => entry.type === "plain_text" && entry.name === "STORAGE" &&
        entry.text === "d1") ||
      !exactlyOne((entry) => entry.type === "plain_text" && entry.name === "BRAIN_NAME" &&
        entry.text === binding.clientSlug) ||
      !exactlyOne((entry) => entry.type === "plain_text" && entry.name === "BRAIN_VERSION" &&
        entry.text === binding.productVersion) ||
      (role === "target" && expectedMode === "paused" &&
        !exactlyOne((entry) => entry.type === "plain_text" &&
          entry.name === "VECTOR_DRAIN_MODE" && entry.text === "paused-for-upgrade"))) {
    refuse("V048_SOURCE_WORKER_BINDINGS_INVALID");
  }
  const plainText = (name) => {
    const matches = bindings.filter((entry) => entry.type === "plain_text" && entry.name === name);
    if (matches.length !== 1) refuse("V048_SOURCE_WORKER_BINDINGS_INVALID");
    return exactString(matches[0].text, "V048_SOURCE_WORKER_BINDINGS_INVALID");
  };
  const chunkSize = plainText("CHUNK_SIZE");
  const chunkOverlap = plainText("CHUNK_OVERLAP");
  const dailyCap = plainText("DAILY_LLM_CAP_USD");
  const expectedOwner = exactString(
    binding.displayName,
    "V048_SOURCE_WORKER_BINDINGS_INVALID",
  );
  if (chunkSize !== V048_WORKER_CHUNK_SIZE ||
      chunkOverlap !== V048_WORKER_CHUNK_OVERLAP ||
      dailyCap !== V048_WORKER_DAILY_LLM_CAP_USD ||
      plainText("CREDENTIAL_SCANNER") !== V048_WORKER_CREDENTIAL_SCANNER ||
      plainText("BRAIN_OWNER") !== expectedOwner ||
      plainText("ANSWER_MODEL") !== V048_WORKER_ANSWER_MODEL) {
    refuse("V048_SOURCE_WORKER_BINDINGS_INVALID");
  }

  const secretNames = bindings
    .filter((entry) => entry.type === "secret_text")
    .map((entry) => exactString(entry.name, "V048_SOURCE_WORKER_BINDINGS_INVALID"))
    .sort();
  if (new Set(secretNames).size !== secretNames.length ||
      REQUIRED_SECRET_NAMES.some((name) => !secretNames.includes(name)) ||
      (role === "target" && !secretNames.includes("BANK_FEED_WRAPPING_KEY_V2")) ||
      secretNames.some((name) => !REQUIRED_SECRET_NAMES.includes(name) &&
        !OPTIONAL_SECRET_NAMES.has(name))) {
    refuse("V048_SOURCE_WORKER_BINDINGS_INVALID");
  }
  assertCompleteOptionalGroup(secretNames, BANK_SECRET_NAMES);
  assertCompleteOptionalGroup(secretNames, ZOOM_SECRET_NAMES);
  return Object.freeze({ versionId: version.id, secretNames: Object.freeze(secretNames) });
}
