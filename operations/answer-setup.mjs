import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { basename, dirname, join } from "node:path";

import {
  captureRenameIdentity,
  captureStagedProofWithRetry,
  removeOwnedStaging,
  renameIdentityMatches,
  renameWithRetrySync,
  sameRenameIdentity,
  stagedBytesMatch,
} from "./rename-retry.mjs";

import {
  BILLING,
  BUSY,
  CHECK_FAILED,
  CHECK_PENDING,
  CHECK_PROBLEM,
  CLIPBOARD_CLEAR_WARNING,
  DAILY_RECONCILE_FAILED,
  DASHBOARD_STEPS,
  DONE_LINES,
  HALF_RUN,
  KEEP_KEY_MISSING,
  KEY_KEPT_FOR_RERANK,
  KEY_REJECTED,
  KEY_SHAPE,
  LIMIT_ALREADY_REACHED,
  MODEL_NOT_REVIEWED,
  MODEL_UNAVAILABLE,
  ROLLBACK_INCOMPLETE,
  ROLLED_BACK_BUILT_IN,
  ROLLED_BACK_PREVIOUS,
  UNREACHABLE,
  UPDATE_FIRST,
} from "./answer-setup-copy.mjs";

export const BUILT_IN_ANSWER_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const REVIEWED_CLAUDE_ANSWER_MODELS = Object.freeze([
  "claude-opus-5-5",
  "claude-sonnet-5-5",
]);
export const RECOMMENDED_ANSWER_SETUP = Object.freeze({
  answer_model: "claude-opus-5-5",
  gate_model: "claude-sonnet-5-5",
});
export const RECOMMENDED_CLAUDE_DAILY_CAP_USD = 5;
export const ANTHROPIC_SECRET_NAME = "ANTHROPIC_API_KEY";
export const ANSWER_SETUP_JOURNAL = ".answer-setup-journal.json";
export const ANSWER_SETUP_INTERRUPTED_CARD = Object.freeze([
  "Answer setup was interrupted.",
  "Nothing more will run automatically.",
  "Your Brain keeps working as before.",
  "Contact your Financial Brain partner.",
]);
export const ANTHROPIC_KEY_REPLACEMENT_UNSUPPORTED =
  "This Brain already uses your Claude key. Replacing the key is not supported in this version. Nothing was changed. Contact your partner.";

export function answerSetupInterruptedMessage(state = "ambiguous") {
  const safeState = ["original", "changed", "ambiguous"].includes(state) ? state : "ambiguous";
  return [`Recovery state: ${safeState}`, ...ANSWER_SETUP_INTERRUPTED_CARD].join("\n");
}

export function resolvedAnswerModels(manifest = {}) {
  const answerModel = String(manifest.retrieval?.answer_model || BUILT_IN_ANSWER_MODEL);
  const gateModel = String(manifest.retrieval?.gate_model || answerModel);
  return Object.freeze({ answer_model: answerModel, gate_model: gateModel });
}

export function answerSetupOf(manifest = {}) {
  const models = resolvedAnswerModels(manifest);
  if (models.answer_model.startsWith("@cf/") && models.gate_model.startsWith("@cf/")) return "built-in";
  if (models.answer_model === RECOMMENDED_ANSWER_SETUP.answer_model &&
      models.gate_model === RECOMMENDED_ANSWER_SETUP.gate_model) return "opus-sonnet";
  return "custom";
}

const reviewedModel = (id) => id.startsWith("@cf/") || REVIEWED_CLAUDE_ANSWER_MODELS.includes(id);

export function assertReviewedAnswerModels(manifest = {}, { manifestPath = "<manifest>", fail } = {}) {
  const models = resolvedAnswerModels(manifest);
  for (const field of ["answer_model", "gate_model"]) {
    const id = models[field];
    if (reviewedModel(id)) continue;
    const error = new Error(MODEL_NOT_REVIEWED({ field, id, manifest: manifestPath }));
    error.supportCode = "ANSWER_MODEL_NOT_REVIEWED";
    error.field = field;
    error.model = id;
    if (typeof fail === "function") return fail(error.message, error.supportCode, error);
    throw error;
  }
  return models;
}

export function validAnthropicKeyShape(value) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 2_048) return false;
  if (/\r|\n| |[^\x21-\x7e]/.test(value)) return false;
  if (!value.startsWith("sk-ant-")) return false;
  if (value.startsWith("sk-ant-admin") || value.startsWith("sk-ant-oat")) return false;
  return true;
}

export function clipboardAnthropicKey(value) {
  if (typeof value !== "string") return value;
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

export function classifyAnthropicResponse({ status, body, networkError = false } = {}) {
  if (networkError) return "unreachable";
  const code = Number(status);
  if (code >= 200 && code < 300) return "ok";
  if (code === 401 || code === 403) return "key_rejected";
  if (code === 402) return "billing";
  if (code === 400 && /credit balance/i.test(String(body?.error?.message || ""))) return "billing";
  if (code === 400) return "error";
  if (code === 404) return "model_unavailable";
  if (code === 429 || code === 529 || code >= 500) return "busy";
  return "error";
}

export const PREFLIGHT_COPY = Object.freeze({
  key_rejected: KEY_REJECTED,
  billing: BILLING,
  model_unavailable: MODEL_UNAVAILABLE,
  busy: BUSY,
  unreachable: UNREACHABLE,
  error: CHECK_FAILED,
});

async function readBoundedJson(response) {
  try {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > 64 * 1024) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function preflightAnthropicKey(key, {
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 30_000,
  checkBound = () => {},
} = {}) {
  const requests = [
    { url: "https://api.anthropic.com/v1/models", method: "GET" },
    ...Object.values(RECOMMENDED_ANSWER_SETUP).map((model) => ({
      url: "https://api.anthropic.com/v1/messages",
      method: "POST",
      body: {
        model,
        max_tokens: 128,
        messages: [{ role: "user", content: "Reply with OK." }],
        output_config: { effort: "low" },
      },
    })),
  ];
  for (const request of requests) {
    let lastClass = "error";
    for (let attempt = 0; attempt < 3; attempt++) {
      checkBound();
      let response;
      try {
        response = await fetchImpl(request.url, {
          method: request.method,
          headers: {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            ...(request.body ? { "content-type": "application/json" } : {}),
          },
          ...(request.body ? { body: JSON.stringify(request.body) } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const body = response.status === 400 ? await readBoundedJson(response) : null;
        lastClass = classifyAnthropicResponse({ status: response.status, body });
      } catch {
        lastClass = "unreachable";
      }
      if (lastClass === "ok") break;
      if (!["busy", "unreachable"].includes(lastClass) || attempt === 2) {
        return { status: lastClass };
      }
      await sleep(attempt === 0 ? 5_000 : 10_000);
      checkBound();
    }
    if (lastClass !== "ok") return { status: lastClass };
  }
  return { status: "ok" };
}

export function parseAnthropicConnectFlags(flags = {}) {
  const accepted = new Set([
    "from-clipboard",
    "key-set-in-dashboard",
    "keep-key",
    "daily-cap",
    "json",
    "recover",
    "confirm-recovery",
  ]);
  const unknown = Object.keys(flags).find((name) => !accepted.has(name));
  if (unknown) throw new Error(`brain connect anthropic does not recognize --${unknown}`);
  const recovery = flags.recover;
  const confirmation = flags["confirm-recovery"];
  if (recovery !== undefined) {
    if (recovery === true) throw new Error("--recover needs the rollback action");
    if (recovery !== "rollback") throw new Error("--recover supports only rollback");
    const ordinary = ["from-clipboard", "key-set-in-dashboard", "keep-key", "daily-cap"]
      .find((name) => flags[name] !== undefined);
    if (ordinary) throw new Error(`--recover cannot be combined with --${ordinary}`);
    if (confirmation !== undefined && (confirmation === true || typeof confirmation !== "string" || !confirmation)) {
      throw new Error("--confirm-recovery needs the confirmation identifier from preview");
    }
    if (flags.json !== undefined && flags.json !== true) throw new Error("--json does not take a value");
    return Object.freeze({
      modeFlag: null,
      dailyCap: undefined,
      json: flags.json === true,
      recovery,
      confirmation: confirmation || null,
    });
  }
  if (confirmation !== undefined) throw new Error("--confirm-recovery requires --recover rollback");
  const modes = ["from-clipboard", "key-set-in-dashboard", "keep-key"].filter((name) => flags[name] === true);
  if (modes.length > 1) throw new Error("choose only one of --from-clipboard, --key-set-in-dashboard, or --keep-key");
  for (const name of ["from-clipboard", "key-set-in-dashboard", "keep-key", "json"]) {
    if (flags[name] !== undefined && flags[name] !== true) throw new Error(`--${name} does not take a value`);
  }
  let dailyCap;
  if (flags["daily-cap"] !== undefined) {
    if (flags["daily-cap"] === true) throw new Error("--daily-cap needs a USD amount");
    dailyCap = Number(flags["daily-cap"]);
    if (!Number.isFinite(dailyCap) || dailyCap < 0.5 || dailyCap > 50) {
      throw new Error("--daily-cap must be from 0.5 through 50 USD");
    }
  }
  return Object.freeze({
    modeFlag: modes[0] || null,
    dailyCap,
    json: flags.json === true,
    recovery: null,
    confirmation: null,
  });
}

export function nextUtcResetIso(now = new Date()) {
  const value = now instanceof Date ? now : new Date(now);
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() + 1)).toISOString();
}

export function displayResetTime(iso, timezone = "UTC") {
  try {
    return `${new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone,
    }).format(new Date(iso))} (${timezone})`;
  } catch {
    return iso;
  }
}

export function answerSetupJournalPath(manifestPath) {
  return join(dirname(manifestPath), ANSWER_SETUP_JOURNAL);
}

/** Update blocks on presence alone, including an empty, malformed, or non-file journal. */
export function answerSetupNeedsRecovery(manifestPath, { inspect = lstatSync } = {}) {
  try {
    inspect(answerSetupJournalPath(manifestPath));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new Error("the interrupted answer setup journal could not be inspected", { cause: error });
  }
}

/** Distinguish current evidence from the one exact legacy schema. */
export function answerSetupHasSchema2RecoveryJournal(manifestPath, deps = {}) {
  const observed = stableReadFile(answerSetupJournalPath(manifestPath), deps);
  const journal = JSON.parse(observed.bytes.toString("utf8"));
  if (journal?.schema_version === ANSWER_SETUP_RECOVERY_SCHEMA ||
      journal?.operation === "answer-setup") return true;
  if (journalIsLegacyAnswerSetup(journal)) return false;
  throw new Error("the interrupted answer setup journal format is unrecognized");
}

const ANSWER_SETUP_RECOVERY_SCHEMA = 2;
const RECOVERY_PUBLICATION_ATTEMPTS = 10;
const RECOVERY_PUBLICATION_WAIT_MS = 225;
const RECOVERY_ELAPSED_BOUND_MS = 8 * 60 * 1000;
const RECOVERY_STAGE_PREFIX = ".answer-setup-stage-";

const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const byteReceipt = (bytes) => Object.freeze({
  byte_length: bytes.length,
  sha256: sha256(bytes),
});

function regularSingleFile(identity) {
  return identity?.isFile?.() === true && identity?.isSymbolicLink?.() !== true && identity.nlink === 1;
}

function identityReceipt(identity) {
  return Object.freeze({
    dev: identity.dev,
    ino: identity.ino,
    nlink: identity.nlink,
    size: identity.size,
    mtime_ms: identity.mtimeMs,
    ctime_ms: identity.ctimeMs,
    mode: identity.mode,
  });
}

function validIdentityReceipt(value) {
  return value && typeof value === "object" &&
    ["dev", "ino", "nlink", "size", "mtime_ms", "ctime_ms", "mode"]
      .every((key) => Number.isFinite(value[key]));
}

function identityMatchesReceipt(identity, receipt) {
  return regularSingleFile(identity) && validIdentityReceipt(receipt) &&
    identity.dev === receipt.dev && identity.ino === receipt.ino && identity.nlink === receipt.nlink &&
    identity.size === receipt.size && identity.mtimeMs === receipt.mtime_ms &&
    identity.ctimeMs === receipt.ctime_ms && identity.mode === receipt.mode;
}

function samePublishedStageIdentity(actual, expected) {
  return regularSingleFile(actual) && regularSingleFile(expected) &&
    ["dev", "ino", "nlink", "size", "mtimeMs", "mode"]
      .every((key) => actual[key] === expected[key]);
}

function stableReadFile(path, { inspect = lstatSync, read = readFileSync } = {}) {
  const opening = inspect(path);
  if (!regularSingleFile(opening)) throw new Error("recovery file identity is not a regular single-link file");
  const bytes = Buffer.from(read(path));
  const closing = inspect(path);
  if (!sameRenameIdentity(opening, closing) || bytes.length !== opening.size) {
    throw new Error("recovery file identity changed during read");
  }
  return Object.freeze({
    bytes,
    identity: closing,
    openingIdentity: opening,
    closingIdentity: closing,
  });
}

function proveOwnedStagePhase(manifestPath, stageReceipt, expectedPhase, fileOptions = {}) {
  const path = join(dirname(manifestPath), stageReceipt.name);
  try {
    const observed = stableReadFile(path, fileOptions);
    if (expectedPhase !== "present" ||
        !identityMatchesReceipt(observed.identity, stageReceipt.identity) ||
        !matchesByteReceipt(observed.bytes, stageReceipt)) {
      return Object.freeze({ ok: false, path, present: true, observed });
    }
    return Object.freeze({ ok: true, path, present: true, observed });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return Object.freeze({ ok: expectedPhase === "absent", path, present: false, observed: null });
    }
    return Object.freeze({ ok: false, path, present: null, observed: null });
  }
}

function publicationOptions(options = {}) {
  return {
    fs: options.fs,
    platform: options.platform ?? process.platform,
    rename: options.rename ?? renameSync,
    sleep: options.sleep,
  };
}

function createOwnedStage(targetPath, bytes, operationId, role, options = {}) {
  const name = `${RECOVERY_STAGE_PREFIX}${operationId}-${role}`;
  const path = join(dirname(targetPath), name);
  writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
  const created = captureRenameIdentity(path);
  const published = publicationOptions(options);
  const proof = captureStagedProofWithRetry(path, bytes, created, {
    fs: published.fs,
    platform: published.platform,
    ...(published.sleep ? { sleep: published.sleep } : {}),
  });
  if (!proof) {
    const error = new Error("the staged answer-setup bytes could not be proved");
    error.code = "ANSWER_SETUP_PUBLICATION_REFUSED";
    throw error;
  }
  return Object.freeze({
    name,
    path,
    bytes,
    created,
    proof,
    receipt: Object.freeze({
      name,
      identity: identityReceipt(proof),
      ...byteReceipt(bytes),
    }),
  });
}

function publicationRefusal() {
  const error = new Error("the staged answer-setup bytes changed before publication");
  error.code = "ANSWER_SETUP_PUBLICATION_REFUSED";
  throw error;
}

function publishOwnedStage(stage, targetPath, predecessor, options = {}, predecessorBytes = null) {
  const published = publicationOptions(options);
  renameWithRetrySync(stage.path, targetPath, {
    revalidate() {
      if (predecessor === null) {
        if (captureRenameIdentity(targetPath) !== null) publicationRefusal();
        return;
      }
      if (predecessorBytes === null) {
        if (!renameIdentityMatches(targetPath, predecessor)) publicationRefusal();
        return;
      }
      try {
        const observed = stableReadFile(targetPath);
        if (!sameRenameIdentity(observed.identity, predecessor) ||
            !observed.bytes.equals(predecessorBytes)) publicationRefusal();
      } catch {
        publicationRefusal();
      }
    },
    staged: { expected: stage.proof, bytes: stage.bytes, refuse: publicationRefusal },
    fs: published.fs,
    platform: published.platform,
    rename: published.rename,
    ...(published.sleep ? { sleep: published.sleep } : {}),
  });
}

function atomicBytesWrite(path, bytes, {
  operationId = randomBytes(12).toString("hex"),
  role = "atomic",
  predecessor = captureRenameIdentity(path),
  publication = {},
} = {}) {
  const stage = createOwnedStage(path, bytes, operationId, role, publication);
  publishOwnedStage(stage, path, predecessor, publication);
  return stage;
}

function atomicJsonWrite(path, value, options = {}) {
  return atomicBytesWrite(path, jsonBytes(value), options);
}

export function saveManifestAtomically(path, manifest, options = {}) {
  atomicJsonWrite(path, manifest, {
    role: "manifest",
    publication: options,
  });
  return manifest;
}

function captureField(object, field) {
  return Object.freeze({ present: Object.hasOwn(object || {}, field), value: object?.[field] });
}

export function answerSetupJournal(manifest, { mode, secretExisted }) {
  return Object.freeze({
    schema_version: 1,
    previous: Object.freeze({
      answer_model: captureField(manifest.retrieval, "answer_model"),
      gate_model: captureField(manifest.retrieval, "gate_model"),
      daily_llm_spend_cap_usd: captureField(manifest.safety, "daily_llm_spend_cap_usd"),
    }),
    secret_name_existed: secretExisted === true,
    mode,
  });
}

function restoreField(target, field, receipt) {
  if (receipt.present) target[field] = receipt.value;
  else delete target[field];
}

export function restoreManifestFromAnswerSetupJournal(current, journal, { builtIn = false } = {}) {
  const restored = structuredClone(current);
  restored.retrieval ||= {};
  restored.safety ||= {};
  if (builtIn) {
    delete restored.retrieval.answer_model;
    delete restored.retrieval.gate_model;
  } else {
    restoreField(restored.retrieval, "answer_model", journal.previous.answer_model);
    restoreField(restored.retrieval, "gate_model", journal.previous.gate_model);
  }
  restoreField(restored.safety, "daily_llm_spend_cap_usd", journal.previous.daily_llm_spend_cap_usd);
  return restored;
}

function captureOptionalFile(path) {
  try {
    const observed = stableReadFile(path);
    return Object.freeze({ present: true, ...byteReceipt(observed.bytes) });
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ present: false });
    throw error;
  }
}

function sameJsonValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validByteReceipt(value) {
  return value && Number.isSafeInteger(value.byte_length) && value.byte_length >= 0 &&
    typeof value.sha256 === "string" && /^[0-9a-f]{64}$/u.test(value.sha256);
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validExactByteReceipt(value) {
  return hasExactKeys(value, ["byte_length", "sha256"]) && validByteReceipt(value);
}

function validExactIdentityReceipt(value) {
  return hasExactKeys(value, ["dev", "ino", "nlink", "size", "mtime_ms", "ctime_ms", "mode"]) &&
    validIdentityReceipt(value);
}

function validStageReceipt(value, operationId) {
  return hasExactKeys(value, ["name", "identity", "byte_length", "sha256"]) &&
    validOwnedName(value.name, operationId) && validExactIdentityReceipt(value.identity) &&
    validByteReceipt(value);
}

function validStagedByteReceipt(value, operationId) {
  return hasExactKeys(value, ["byte_length", "sha256", "stage"]) &&
    validByteReceipt(value) && validStageReceipt(value.stage, operationId) &&
    value.stage.sha256 === value.sha256 && value.stage.byte_length === value.byte_length;
}

function validCapturedField(value, kind) {
  if (!value || typeof value !== "object" || typeof value.present !== "boolean") return false;
  if (value.present === false) return hasExactKeys(value, ["present"]);
  if (!hasExactKeys(value, ["present", "value"])) return false;
  if (kind === "model") return typeof value.value === "string" && value.value.length > 0;
  return typeof value.value === "number" && Number.isFinite(value.value);
}

function validGuideRecord(value) {
  if (!value || typeof value !== "object" || typeof value.present !== "boolean") return false;
  if (value.present === false) return hasExactKeys(value, ["present"]);
  return hasExactKeys(value, ["present", "byte_length", "sha256"]) && validByteReceipt(value);
}

function validOwnedName(name, operationId) {
  return typeof name === "string" && basename(name) === name &&
    name.startsWith(`${RECOVERY_STAGE_PREFIX}${operationId}-`);
}

function matchesByteReceipt(bytes, receipt) {
  return validByteReceipt(receipt) && bytes.length === receipt.byte_length && sha256(bytes) === receipt.sha256;
}

function prepareRecoveryTransaction(manifestPath, originalManifest, intendedManifest, {
  mode,
  secretExisted,
  publication = {},
} = {}) {
  const originalObservation = stableReadFile(manifestPath);
  let parsedOriginal;
  try { parsedOriginal = JSON.parse(originalObservation.bytes.toString("utf8")); }
  catch { throw new Error("the answer-setup manifest bytes could not be validated"); }
  if (!sameJsonValue(parsedOriginal, originalManifest)) {
    throw new Error("the answer-setup manifest changed before recovery evidence was staged");
  }
  const originalBytes = originalObservation.bytes;
  const intendedBytes = jsonBytes(intendedManifest);
  if (timingSafeEqual(Buffer.from(sha256(originalBytes), "hex"), Buffer.from(sha256(intendedBytes), "hex"))) {
    return null;
  }

  const operationId = randomBytes(12).toString("hex");
  const originalStage = createOwnedStage(manifestPath, originalBytes, operationId, "original", publication);
  const intendedStage = createOwnedStage(manifestPath, intendedBytes, operationId, "intended", publication);
  const canonicalTarget = realpathSync.native(manifestPath);
  const journal = Object.freeze({
    schema_version: ANSWER_SETUP_RECOVERY_SCHEMA,
    operation: "answer-setup",
    operation_id: operationId,
    target: Object.freeze({
      canonical_identity_sha256: sha256(Buffer.from(canonicalTarget, "utf8")),
      predecessor: identityReceipt(originalObservation.identity),
    }),
    original: Object.freeze({ ...byteReceipt(originalBytes), stage: originalStage.receipt }),
    intended: Object.freeze({ ...byteReceipt(intendedBytes), stage: intendedStage.receipt }),
    previous: Object.freeze({
      answer_model: captureField(originalManifest.retrieval, "answer_model"),
      gate_model: captureField(originalManifest.retrieval, "gate_model"),
      daily_llm_spend_cap_usd: captureField(originalManifest.safety, "daily_llm_spend_cap_usd"),
    }),
    secret_name_existed: secretExisted === true,
    secret_phases: Object.freeze({
      write_intended: ["clipboard", "prompt"].includes(mode),
      receipt_name: `${RECOVERY_STAGE_PREFIX}${operationId}-secret-receipt`,
    }),
    allowed_forward_additions: Object.freeze([]),
    forward_policy: Object.freeze({
      paths: Object.freeze(["brain.domain"]),
      intent_recorded: true,
      receipt_name: `${RECOVERY_STAGE_PREFIX}${operationId}-forward-receipt`,
    }),
    guides: Object.freeze({
      claude: captureOptionalFile(join(dirname(manifestPath), "CLAUDE.md")),
      codex: captureOptionalFile(join(dirname(manifestPath), "AGENTS.md")),
    }),
    publication_bounds: Object.freeze({
      attempts: RECOVERY_PUBLICATION_ATTEMPTS,
      waits: RECOVERY_PUBLICATION_ATTEMPTS - 1,
      wait_ms: RECOVERY_PUBLICATION_WAIT_MS,
      elapsed_ms: RECOVERY_ELAPSED_BOUND_MS,
    }),
    mode,
  });
  return {
    operationId,
    journal,
    originalManifest: parsedOriginal,
    intendedManifest,
    originalBytes,
    intendedBytes,
    originalStage,
    intendedStage,
    originalObservation,
    forward: null,
    secretReceipt: null,
    rollbackStages: [],
    consumedStagePaths: new Set(),
    journalReceipt: null,
    cleanupRefused: false,
    targetProof: Object.freeze({
      identity: originalObservation.identity,
      bytes: Buffer.from(originalBytes),
      rollbackBytes: Buffer.from(originalBytes),
    }),
  };
}

function journalIsLegacyAnswerSetup(journal) {
  return hasExactKeys(journal, [
    "schema_version",
    "previous",
    "secret_name_existed",
    "mode",
  ]) && journal.schema_version === 1 &&
    hasExactKeys(journal.previous, [
      "answer_model",
      "gate_model",
      "daily_llm_spend_cap_usd",
    ]) &&
    validCapturedField(journal.previous.answer_model, "model") &&
    validCapturedField(journal.previous.gate_model, "model") &&
    validCapturedField(journal.previous.daily_llm_spend_cap_usd, "number") &&
    typeof journal.secret_name_existed === "boolean" &&
    ["clipboard", "dashboard", "keep", "prompt"].includes(journal.mode);
}

function journalIsRecoveryCapable(journal) {
  const operationId = journal?.operation_id;
  const modes = ["clipboard", "dashboard", "keep", "prompt"];
  return hasExactKeys(journal, [
    "schema_version",
    "operation",
    "operation_id",
    "target",
    "original",
    "intended",
    "previous",
    "secret_name_existed",
    "secret_phases",
    "allowed_forward_additions",
    "forward_policy",
    "guides",
    "publication_bounds",
    "mode",
  ]) && journal.schema_version === ANSWER_SETUP_RECOVERY_SCHEMA &&
    journal.operation === "answer-setup" &&
    typeof operationId === "string" && /^[0-9a-f]{24}$/u.test(operationId) &&
    hasExactKeys(journal.target, ["canonical_identity_sha256", "predecessor"]) &&
    typeof journal.target?.canonical_identity_sha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(journal.target.canonical_identity_sha256) &&
    validExactIdentityReceipt(journal.target.predecessor) &&
    validStagedByteReceipt(journal.original, operationId) &&
    validStagedByteReceipt(journal.intended, operationId) &&
    journal.original.sha256 !== journal.intended.sha256 &&
    hasExactKeys(journal.previous, ["answer_model", "gate_model", "daily_llm_spend_cap_usd"]) &&
    validCapturedField(journal.previous.answer_model, "model") &&
    validCapturedField(journal.previous.gate_model, "model") &&
    validCapturedField(journal.previous.daily_llm_spend_cap_usd, "number") &&
    typeof journal.secret_name_existed === "boolean" &&
    hasExactKeys(journal.secret_phases, ["write_intended", "receipt_name"]) &&
    typeof journal.secret_phases.write_intended === "boolean" &&
    journal.secret_phases.write_intended === ["clipboard", "prompt"].includes(journal.mode) &&
    validOwnedName(journal.secret_phases.receipt_name, operationId) &&
    hasExactKeys(journal.forward_policy, ["paths", "intent_recorded", "receipt_name"]) &&
    journal.forward_policy?.intent_recorded === true &&
    Array.isArray(journal.forward_policy?.paths) &&
    journal.forward_policy.paths.length === 1 && journal.forward_policy.paths[0] === "brain.domain" &&
    validOwnedName(journal.forward_policy?.receipt_name, operationId) &&
    Array.isArray(journal.allowed_forward_additions) && journal.allowed_forward_additions.length === 0 &&
    hasExactKeys(journal.guides, ["claude", "codex"]) &&
    validGuideRecord(journal.guides.claude) && validGuideRecord(journal.guides.codex) &&
    hasExactKeys(journal.publication_bounds, ["attempts", "waits", "wait_ms", "elapsed_ms"]) &&
    journal.publication_bounds?.attempts === RECOVERY_PUBLICATION_ATTEMPTS &&
    journal.publication_bounds?.waits === RECOVERY_PUBLICATION_ATTEMPTS - 1 &&
    journal.publication_bounds?.wait_ms === RECOVERY_PUBLICATION_WAIT_MS &&
    journal.publication_bounds?.elapsed_ms === RECOVERY_ELAPSED_BOUND_MS &&
    modes.includes(journal.mode);
}

function writePhaseReceipt(manifestPath, name, value, operationId, publication = {}) {
  const path = join(dirname(manifestPath), name);
  const bytes = jsonBytes(value);
  const stage = atomicJsonWrite(path, value, {
    operationId,
    role: `receipt-${randomBytes(4).toString("hex")}`,
    predecessor: null,
    publication,
  });
  const published = stableReadFile(path);
  if (!stagedBytesMatch(path, stage.proof, bytes) || !published.bytes.equals(bytes)) {
    publicationRefusal();
  }
  return Object.freeze({
    path,
    name,
    stage,
    value,
    bytes,
    published: Object.freeze({ path, bytes, identity: published.identity }),
  });
}

function recordSecretReadback(runtime, manifestPath, publication = {}) {
  const value = Object.freeze({
    schema_version: 1,
    operation: "answer-setup-secret-phase",
    operation_id: runtime.operationId,
    phase: "write-readback-complete",
    secret_name_sha256: sha256(Buffer.from(ANTHROPIC_SECRET_NAME, "utf8")),
  });
  try {
    runtime.secretReceipt = writePhaseReceipt(
      manifestPath,
      runtime.journal.secret_phases.receipt_name,
      value,
      runtime.operationId,
      publication,
    );
  } catch (error) {
    runtime.cleanupRefused = true;
    throw error;
  }
}

function withoutForwardDomain(value) {
  const copy = structuredClone(value);
  if (!copy.brain || typeof copy.brain !== "object") return copy;
  delete copy.brain.domain;
  return copy;
}

function rememberRuntimeTarget(runtime, observed, rollbackBytes) {
  runtime.targetProof = Object.freeze({
    identity: observed.identity,
    bytes: Buffer.from(observed.bytes),
    rollbackBytes: Buffer.from(rollbackBytes),
  });
}

function requireRuntimeTarget(runtime, manifestPath) {
  const expected = runtime.targetProof;
  if (!expected) throw new Error("the rollback target has no transaction proof");
  let observed;
  try { observed = stableReadFile(manifestPath); }
  catch { throw new Error("the rollback target could not be proved"); }
  if (!sameRenameIdentity(observed.identity, expected.identity) ||
      !observed.bytes.equals(expected.bytes)) {
    throw new Error("the rollback target changed after its transaction proof");
  }
  return expected;
}

function observeForwardManifest(runtime, manifestPath, publication = {}) {
  const observed = stableReadFile(manifestPath);
  if (matchesByteReceipt(observed.bytes, runtime.journal.intended)) {
    if (!runtime.targetProof ||
        !sameRenameIdentity(observed.identity, runtime.targetProof.identity) ||
        !observed.bytes.equals(runtime.targetProof.bytes)) {
      throw new Error("the deployed answer-setup manifest is an unproved replacement");
    }
    return { manifest: runtime.intendedManifest, bytes: observed.bytes, forward: null };
  }
  let value;
  try { value = JSON.parse(observed.bytes.toString("utf8")); }
  catch { throw new Error("the deployed answer-setup manifest is not an exact recovery candidate"); }
  if (typeof value.brain?.domain !== "string" || !value.brain.domain ||
      !sameJsonValue(withoutForwardDomain(value), runtime.intendedManifest) ||
      runtime.originalManifest.brain?.domain !== undefined || runtime.intendedManifest.brain?.domain !== undefined) {
    throw new Error("the deployed answer-setup manifest has an unproved forward change");
  }

  const originalComposite = structuredClone(runtime.originalManifest);
  originalComposite.brain ||= {};
  originalComposite.brain.domain = value.brain.domain;
  const originalCompositeBytes = jsonBytes(originalComposite);
  // This is the only permitted forward target class. Remember its complete
  // observation before later local evidence work can fail, so rollback never
  // adopts whatever happens to occupy the path afterward.
  rememberRuntimeTarget(runtime, observed, originalCompositeBytes);
  let originalCompositeStage;
  try {
    originalCompositeStage = createOwnedStage(
      manifestPath,
      originalCompositeBytes,
      runtime.operationId,
      "original-forward",
      publication,
    );
  } catch (error) {
    runtime.cleanupRefused = true;
    throw error;
  }
  const receipt = Object.freeze({
    schema_version: 1,
    operation: "answer-setup-forward-addition",
    operation_id: runtime.operationId,
    addition: "brain.domain",
    target_identity_sha256: runtime.journal.target.canonical_identity_sha256,
    intended_composite: Object.freeze({ ...byteReceipt(observed.bytes) }),
    original_composite: Object.freeze({
      ...byteReceipt(originalCompositeBytes),
      stage: originalCompositeStage.receipt,
    }),
  });
  let stored;
  try {
    stored = writePhaseReceipt(
      manifestPath,
      runtime.journal.forward_policy.receipt_name,
      receipt,
      runtime.operationId,
      publication,
    );
  } catch (error) {
    runtime.cleanupRefused = true;
    throw error;
  }
  runtime.forward = Object.freeze({
    receipt,
    stored,
    originalComposite,
    originalCompositeBytes,
    originalCompositeStage,
    intendedComposite: value,
    intendedCompositeBytes: observed.bytes,
  });
  return { manifest: value, bytes: observed.bytes, forward: runtime.forward };
}

function readOptionalOwnedJson(manifestPath, name, operationId) {
  if (!validOwnedName(name, operationId)) throw new Error("invalid recovery evidence name");
  const path = join(dirname(manifestPath), name);
  try {
    const observed = stableReadFile(path);
    return Object.freeze({
      path,
      observed,
      value: JSON.parse(observed.bytes.toString("utf8")),
    });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function reasonReceipt(state, secretState, reasons, proofId = null) {
  return Object.freeze({
    state,
    secret_state: secretState,
    reasons: Object.freeze([...reasons]),
    proof_id: proofId,
  });
}

function ambiguousClassification(reason) {
  const receipt = reasonReceipt("ambiguous", "ambiguous", [reason]);
  return { receipt, proof: null, journal: null, private: null };
}

function proofIdentity(identity) {
  return {
    dev: identity.dev,
    ino: identity.ino,
    nlink: identity.nlink,
    size: identity.size,
    mtime_ms: identity.mtimeMs,
    ctime_ms: identity.ctimeMs,
    mode: identity.mode,
  };
}

async function classifyRecoveryInternal({ manifestPath, journalPath }, deps = {}) {
  let journalObserved;
  let journal;
  try {
    journalObserved = stableReadFile(journalPath, deps.journalFile || {});
    journal = JSON.parse(journalObserved.bytes.toString("utf8"));
    if (!journalIsRecoveryCapable(journal)) return ambiguousClassification("journal_invalid");
    const canonical = realpathSync.native(manifestPath);
    if (sha256(Buffer.from(canonical, "utf8")) !== journal.target.canonical_identity_sha256) {
      return ambiguousClassification("target_identity_changed");
    }
  } catch {
    return ambiguousClassification("journal_unavailable");
  }

  let manifestObserved;
  let manifestValue;
  try {
    manifestObserved = stableReadFile(manifestPath, deps.manifestFile || {});
    manifestValue = JSON.parse(manifestObserved.bytes.toString("utf8"));
    if (!manifestValue || typeof manifestValue !== "object" || Array.isArray(manifestValue)) {
      return ambiguousClassification("manifest_invalid");
    }
  }
  catch { return ambiguousClassification("manifest_unavailable"); }

  const originalStagePhase = proveOwnedStagePhase(
    manifestPath,
    journal.original.stage,
    "present",
    deps.stageFile || {},
  );
  if (!originalStagePhase.ok) return ambiguousClassification("original_stage_unavailable");
  const originalStage = originalStagePhase.observed;

  let forward = null;
  try {
    const stored = readOptionalOwnedJson(
      manifestPath,
      journal.forward_policy.receipt_name,
      journal.operation_id,
    );
    if (stored) {
      const value = stored.value;
      if (!hasExactKeys(value, [
        "schema_version",
        "operation",
        "operation_id",
        "addition",
        "target_identity_sha256",
        "intended_composite",
        "original_composite",
      ]) || value.schema_version !== 1 || value.operation !== "answer-setup-forward-addition" ||
          value.operation_id !== journal.operation_id || value.addition !== "brain.domain" ||
          value.target_identity_sha256 !== journal.target.canonical_identity_sha256 ||
          !validExactByteReceipt(value.intended_composite) ||
          !validStagedByteReceipt(value.original_composite, journal.operation_id)) {
        return ambiguousClassification("forward_receipt_invalid");
      }
      const stagePath = join(dirname(manifestPath), value.original_composite.stage.name);
      const stage = stableReadFile(stagePath, deps.stageFile || {});
      if (!identityMatchesReceipt(stage.identity, value.original_composite.stage.identity) ||
          !matchesByteReceipt(stage.bytes, value.original_composite.stage)) {
        return ambiguousClassification("forward_stage_changed");
      }
      let original;
      let originalComposite;
      try {
        original = JSON.parse(originalStage.bytes.toString("utf8"));
        originalComposite = JSON.parse(stage.bytes.toString("utf8"));
      } catch {
        return ambiguousClassification("forward_composite_invalid");
      }
      const domain = originalComposite?.brain?.domain;
      if (typeof domain !== "string" || !domain || original?.brain?.domain !== undefined ||
          !sameJsonValue(withoutForwardDomain(originalComposite), original) ||
          !matchesByteReceipt(jsonBytes(originalComposite), value.original_composite)) {
        return ambiguousClassification("forward_composite_invalid");
      }
      forward = { stored, value, stage, stagePath, domain };
    }
  } catch {
    return ambiguousClassification("forward_receipt_unavailable");
  }

  const originalCandidates = [journal.original];
  const intendedCandidates = [journal.intended];
  if (forward) {
    const currentDomain = manifestValue?.brain?.domain;
    if (currentDomain !== forward.domain) {
      return ambiguousClassification("forward_composite_invalid");
    }
    const intendedBaseBytes = jsonBytes(withoutForwardDomain(manifestValue));
    if (matchesByteReceipt(intendedBaseBytes, journal.intended) &&
        matchesByteReceipt(jsonBytes(manifestValue), forward.value.intended_composite) &&
        matchesByteReceipt(manifestObserved.bytes, forward.value.intended_composite)) {
      intendedCandidates.push(forward.value.intended_composite);
    } else if (matchesByteReceipt(manifestObserved.bytes, forward.value.original_composite)) {
      return ambiguousClassification("forward_original_unprovable");
    }
  }
  const originalMatches = originalCandidates.filter((candidate) => matchesByteReceipt(manifestObserved.bytes, candidate));
  const intendedMatches = intendedCandidates.filter((candidate) => matchesByteReceipt(manifestObserved.bytes, candidate));
  let state;
  if (originalMatches.length === 1 && intendedMatches.length === 0) state = "original";
  else if (intendedMatches.length === 1 && originalMatches.length === 0) state = "changed";
  else return ambiguousClassification("manifest_not_exact_candidate");

  // Before publication, an original manifest requires the exact intended
  // stage. After publication, a changed manifest requires that consumed stage
  // path to remain absent. Any other combination is contradictory evidence.
  const intendedStagePhase = proveOwnedStagePhase(
    manifestPath,
    journal.intended.stage,
    state === "original" ? "present" : "absent",
    deps.stageFile || {},
  );
  if (!intendedStagePhase.ok) return ambiguousClassification("intended_stage_phase_invalid");
  const intendedStageProof = intendedStagePhase.present
    ? Object.freeze({
      present: true,
      ...byteReceipt(intendedStagePhase.observed.bytes),
      identity: proofIdentity(intendedStagePhase.observed.identity),
    })
    : Object.freeze({ present: false });

  if (typeof deps.listSecretNames !== "function") {
    const proof = Object.freeze({
      schema_version: 1,
      action: "none",
      journal: Object.freeze({ ...byteReceipt(journalObserved.bytes), identity: proofIdentity(journalObserved.identity) }),
      manifest: Object.freeze({ ...byteReceipt(manifestObserved.bytes), identity: proofIdentity(manifestObserved.identity) }),
      intended_stage: intendedStageProof,
      secret_state: "uninspected",
      secret_present: null,
      secret_receipt: null,
      forward_receipt: forward ? byteReceipt(forward.stored.observed.bytes) : null,
      publication_bounds: journal.publication_bounds,
    });
    const proofId = sha256(Buffer.from(JSON.stringify(proof), "utf8"));
    return {
      receipt: reasonReceipt(state, "uninspected", [`manifest_${state}`, "secret_uninspected"], proofId),
      proof,
      journal,
      private: {
        journalObserved,
        manifestObserved,
        originalStage,
        intendedStage: intendedStagePhase.observed,
        forward,
        secretReceipt: null,
      },
    };
  }

  let inventoriedNames;
  try { inventoriedNames = new Set(await deps.listSecretNames()); }
  catch { return ambiguousClassification("secret_inventory_unavailable"); }
  const secretPresent = inventoriedNames.has(ANTHROPIC_SECRET_NAME);
  let secretReceipt = null;
  let secretState;
  if (journal.secret_name_existed) {
    if (!secretPresent) return ambiguousClassification("prior_secret_missing");
    secretState = "original";
  } else if (!secretPresent) {
    secretState = "original";
  } else {
    if (journal.secret_phases.write_intended !== true ||
        !["clipboard", "prompt"].includes(journal.mode)) {
      return ambiguousClassification("fresh_secret_write_not_intended");
    }
    try {
      secretReceipt = readOptionalOwnedJson(
        manifestPath,
        journal.secret_phases.receipt_name,
        journal.operation_id,
      );
      const value = secretReceipt?.value;
      if (value?.schema_version !== 1 || value.operation !== "answer-setup-secret-phase" ||
          value.operation_id !== journal.operation_id || value.phase !== "write-readback-complete" ||
          value.secret_name_sha256 !== sha256(Buffer.from(ANTHROPIC_SECRET_NAME, "utf8"))) {
        return ambiguousClassification("fresh_secret_unproved");
      }
      secretState = "changed";
    } catch {
      return ambiguousClassification("secret_receipt_unavailable");
    }
  }

  const proof = Object.freeze({
    schema_version: 1,
    action: "none",
    journal: Object.freeze({ ...byteReceipt(journalObserved.bytes), identity: proofIdentity(journalObserved.identity) }),
    manifest: Object.freeze({ ...byteReceipt(manifestObserved.bytes), identity: proofIdentity(manifestObserved.identity) }),
    intended_stage: intendedStageProof,
    secret_state: secretState,
    secret_present: secretPresent,
    secret_receipt: secretReceipt ? byteReceipt(secretReceipt.observed.bytes) : null,
    forward_receipt: forward ? byteReceipt(forward.stored.observed.bytes) : null,
    publication_bounds: journal.publication_bounds,
  });
  const proofId = sha256(Buffer.from(JSON.stringify(proof), "utf8"));
  const receipt = reasonReceipt(state, secretState, [`manifest_${state}`, `secret_${secretState}`], proofId);
  return {
    receipt,
    proof,
    journal,
    private: {
      journalObserved,
      manifestObserved,
      originalStage,
      intendedStage: intendedStagePhase.observed,
      originalStagePath: join(dirname(manifestPath), journal.original.stage.name),
      forward,
      secretReceipt,
    },
  };
}

export async function classifyAnswerSetupRecoveryState({ manifestPath, journalPath }, deps = {}) {
  const classified = await classifyRecoveryInternal({ manifestPath, journalPath }, deps);
  return classified.receipt;
}

function recoveryFailed(code) {
  const error = new Error("The rollback stopped because a required recovery proof did not match.");
  error.code = code;
  error.supportCode = code;
  return error;
}

function presentStageArtifact(stage) {
  return stage && Object.freeze({
    path: stage.path,
    expected: "present",
    identity: stage.proof,
    bytes: stage.bytes,
  });
}

function absentStageArtifact(stage) {
  return stage && Object.freeze({ path: stage.path, expected: "absent" });
}

function publishedArtifact(receipt) {
  return receipt?.published && Object.freeze({
    path: receipt.published.path,
    expected: "present",
    identity: receipt.published.identity,
    bytes: receipt.published.bytes,
  });
}

function runtimeArtifactPlan(runtime) {
  const plan = [
    presentStageArtifact(runtime.originalStage),
    runtime.consumedStagePaths.has(runtime.intendedStage.path)
      ? absentStageArtifact(runtime.intendedStage)
      : presentStageArtifact(runtime.intendedStage),
    publishedArtifact(runtime.secretReceipt),
    absentStageArtifact(runtime.secretReceipt?.stage),
    publishedArtifact(runtime.forward?.stored),
    absentStageArtifact(runtime.forward?.stored?.stage),
    presentStageArtifact(runtime.forward?.originalCompositeStage),
    ...runtime.rollbackStages.map((stage) => runtime.consumedStagePaths.has(stage.path)
      ? absentStageArtifact(stage)
      : presentStageArtifact(stage)),
    absentStageArtifact(runtime.journalReceipt?.stage),
  ].filter(Boolean);
  const unique = new Map();
  for (const artifact of plan) unique.set(artifact.path, artifact);
  return [...unique.values()];
}

function artifactIsAbsent(path, inspect = lstatSync) {
  try {
    inspect(path);
    return false;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

function artifactMatches(artifact) {
  if (artifact.expected === "absent") return artifactIsAbsent(artifact.path);
  try {
    const observed = stableReadFile(artifact.path);
    return sameRenameIdentity(observed.identity, artifact.identity) &&
      observed.bytes.equals(artifact.bytes);
  } catch {
    return false;
  }
}

function defaultRemoveOwned(artifact) {
  if (!artifactMatches(artifact) || artifact.expected !== "present") return false;
  return removeOwnedStaging(artifact.path, artifact.identity, {
    proof: artifact.identity,
    bytes: artifact.bytes,
  });
}

async function removeProvedArtifact(artifact, deps = {}) {
  if (deps.removeRecoveryStagedFile) {
    await deps.removeRecoveryStagedFile(artifact.path, Object.freeze({
      created: artifact.identity,
      proof: artifact.identity,
      bytes: artifact.bytes,
    }));
    return artifactIsAbsent(artifact.path);
  }
  return defaultRemoveOwned(artifact);
}

async function removeRuntimeArtifacts(runtime, deps = {}) {
  if (runtime?.cleanupRefused || !runtime?.journalReceipt?.published) {
    throw recoveryFailed("RECOVERY_CLEANUP_FAILED");
  }
  const artifacts = runtimeArtifactPlan(runtime);
  const journalArtifact = publishedArtifact(runtime.journalReceipt);

  // Refuse the whole cleanup before its first unlink when any path no longer
  // has the exact phase, identity, and bytes created by this transaction.
  if (!artifactMatches(journalArtifact) || artifacts.some((artifact) => !artifactMatches(artifact))) {
    throw recoveryFailed("RECOVERY_CLEANUP_FAILED");
  }
  for (const artifact of artifacts) {
    if (artifact.expected === "absent") continue;
    if (!await removeProvedArtifact(artifact, deps)) throw recoveryFailed("RECOVERY_CLEANUP_FAILED");
  }
  if (artifacts.some((artifact) => !artifactIsAbsent(artifact.path))) {
    throw recoveryFailed("RECOVERY_CLEANUP_FAILED");
  }
  if (!artifactMatches(journalArtifact)) throw recoveryFailed("RECOVERY_CLEANUP_FAILED");
  if (deps.removeJournal) {
    await deps.removeJournal(journalArtifact.path, Object.freeze({
      created: journalArtifact.identity,
      proof: journalArtifact.identity,
      bytes: journalArtifact.bytes,
    }));
    if (!artifactIsAbsent(journalArtifact.path)) throw recoveryFailed("RECOVERY_CLEANUP_FAILED");
  } else if (!defaultRemoveOwned(journalArtifact)) {
    throw recoveryFailed("RECOVERY_CLEANUP_FAILED");
  }
}

export async function recoverAnthropicAnswerSetup({
  manifestPath,
}, deps = {}) {
  const journalPath = answerSetupJournalPath(manifestPath);
  let classified;
  try {
    classified = await classifyRecoveryInternal({ manifestPath, journalPath }, deps);
  } catch {
    classified = ambiguousClassification("classification_boundary_failed");
  }
  return Object.freeze({
    status: "recovery_preview",
    recovery_state: classified.receipt.state,
    secret_state: classified.receipt.secret_state,
    receipt: classified.receipt,
  });
}

const asTime = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  return date.getTime();
};

const failureLine = (status) => status === "check_problem" ? CHECK_PROBLEM : PREFLIGHT_COPY[status] || CHECK_FAILED;

function chooseMode(parsed, { platform, stdinIsTTY }) {
  if (parsed.modeFlag === "from-clipboard") return "clipboard";
  if (parsed.modeFlag === "key-set-in-dashboard") return "dashboard";
  if (parsed.modeFlag === "keep-key") return "keep";
  if (platform === "darwin" && stdinIsTTY === true) return "prompt";
  return "clipboard";
}

function capAfterEdit(manifest, explicitCap) {
  if (explicitCap !== undefined) return explicitCap;
  const existing = manifest.safety?.daily_llm_spend_cap_usd;
  return existing === undefined || existing === 10 ? RECOMMENDED_CLAUDE_DAILY_CAP_USD : existing;
}

function resultReceipt(manifest, check, extras = {}) {
  const models = resolvedAnswerModels(manifest);
  return Object.freeze({
    preset: answerSetupOf(manifest),
    ...models,
    daily_cap_usd: manifest.safety?.daily_llm_spend_cap_usd ?? 10,
    secret_name: ANTHROPIC_SECRET_NAME,
    key_written: extras.keyWritten === true,
    worker_check: check,
    rolled_back: extras.rolledBack === true,
    rollback_target: extras.rollbackTarget || null,
  });
}

/**
 * Run the mutation while every external boundary remains injected.
 *
 * The caller supplies Cloudflare, scheduler, deployment, lock, prompt, clock,
 * and Worker-check adapters. Defaults below are local file operations only.
 */
export async function runAnthropicAnswerSetup({ manifestPath, flags = {} }, deps = {}) {
  if (!manifestPath || String(manifestPath).startsWith("--")) {
    throw new Error("usage: brain connect anthropic <manifest> [--from-clipboard|--key-set-in-dashboard|--keep-key] [--daily-cap <usd>] [--json]");
  }
  const parsed = parseAnthropicConnectFlags(flags);
  if (parsed.recovery) throw new Error("answer-setup recovery must use recoverAnthropicAnswerSetup");
  const platform = deps.platform ?? process.platform;
  const mode = chooseMode(parsed, { platform, stdinIsTTY: deps.stdinIsTTY ?? process.stdin.isTTY });
  const path = answerSetupJournalPath(manifestPath);
  const now = deps.now ?? (() => new Date());
  const started = asTime(now());
  const deadline = started + 8 * 60 * 1000;
  const log = deps.log ?? (() => {});
  const checkBound = () => {
    if (asTime(now()) > deadline) {
      const error = new Error("the answer setup exceeded its eight-minute safety limit");
      error.answerSetupClass = "error";
      throw error;
    }
  };
  const readManifest = deps.loadManifest ?? ((file) => JSON.parse(readFileSync(file, "utf8")));
  const useRecoveryWriter = deps.writeJournal === undefined && deps.saveManifestAtomically === undefined;
  const writeManifest = deps.saveManifestAtomically ?? ((file, value) =>
    saveManifestAtomically(file, value, deps.publicationOptions || {}));
  const journalExists = deps.journalExists ?? (() => existsSync(path));
  const writeJournal = deps.writeJournal ?? ((value) => atomicJsonWrite(path, value, {
    role: "journal",
    predecessor: null,
    publication: deps.publicationOptions || {},
  }));
  const removeJournal = deps.removeJournal ?? (() => { if (existsSync(path)) unlinkSync(path); });
  const lock = deps.acquireLock ?? (async (_input, action) => action());
  let clearClipboard = mode === "clipboard";
  let clipboardCleared = mode !== "clipboard";
  const clearClipboardNow = async () => {
    if (!clearClipboard) return clipboardCleared;
    clearClipboard = false;
    try {
      await deps.clearClipboard?.();
      clipboardCleared = true;
    } catch {
      clipboardCleared = false;
      log(CLIPBOARD_CLEAR_WARNING);
    }
    return clipboardCleared;
  };
  let journal = null;
  let currentManifest = null;
  let originalManifest = null;
  let keyWritten = false;
  let completed = false;
  let rollbackComplete = false;
  let recoveryRuntime = null;

  return lock({ manifestPath, operation: "answer-setup" }, async () => {
    try {
      if (journalExists()) {
        const error = new Error(HALF_RUN(manifestPath));
        error.code = "HALF_RUN";
        throw error;
      }
      currentManifest = await readManifest(manifestPath);
      const selectedModels = resolvedAnswerModels(currentManifest);
      const alreadyUsesClaude = [selectedModels.answer_model, selectedModels.gate_model]
        .some((model) => REVIEWED_CLAUDE_ANSWER_MODELS.includes(model));
      if (["clipboard", "prompt", "dashboard"].includes(mode) && alreadyUsesClaude) {
        const error = new Error(ANTHROPIC_KEY_REPLACEMENT_UNSUPPORTED);
        error.code = "ANTHROPIC_KEY_REPLACEMENT_UNSUPPORTED";
        error.supportCode = "ANTHROPIC_KEY_REPLACEMENT_UNSUPPORTED";
        throw error;
      }
      originalManifest = structuredClone(currentManifest);
      assertReviewedAnswerModels(currentManifest, { manifestPath });
      checkBound();
      try {
        await deps.verifyVersion?.(currentManifest);
      } catch (cause) {
        const error = new Error(UPDATE_FIRST(manifestPath), { cause });
        error.code = "UPDATE_FIRST";
        throw error;
      }
      checkBound();
      let key = null;
      let keyPreflightOk = false;
      if (!["dashboard", "keep"].includes(mode)) {
        key = mode === "clipboard"
          ? clipboardAnthropicKey(await deps.readClipboard())
          : await deps.readSecret?.();
        if (!validAnthropicKeyShape(key)) {
          const error = new Error(KEY_SHAPE);
          error.code = "ANTHROPIC_KEY_NOT_ACCEPTED";
          error.supportCode = "ANTHROPIC_KEY_NOT_ACCEPTED";
          throw error;
        }
        const preflight = await (deps.preflight ?? preflightAnthropicKey)(key, { checkBound });
        if (preflight?.status !== "ok") {
          const error = new Error(failureLine(preflight?.status));
          error.code = preflight?.status || "error";
          error.supportCode = preflight?.status === "key_rejected" ? "ANTHROPIC_KEY_NOT_ACCEPTED"
            : preflight?.status === "billing" ? "ANTHROPIC_ACCOUNT_NEEDS_CREDIT"
              : "ANTHROPIC_CHECK_FAILED";
          throw error;
        }
        keyPreflightOk = true;
      }
      let names = new Set(await deps.listSecretNames());
      const secretExisted = names.has(ANTHROPIC_SECRET_NAME);
      if (mode === "dashboard" && !secretExisted) {
        log(DASHBOARD_STEPS);
        return { status: "nothing_changed", reason: "dashboard_secret_missing" };
      }
      if (mode === "keep" && !secretExisted) {
        const error = new Error(KEEP_KEY_MISSING(manifestPath));
        error.code = "KEEP_KEY_MISSING";
        throw error;
      }
      checkBound();

      const skipMutation = mode === "keep" && parsed.dailyCap === undefined;
      if (!skipMutation) {
        const edited = structuredClone(currentManifest);
        edited.retrieval ||= {};
        edited.safety ||= {};
        if (mode !== "keep") Object.assign(edited.retrieval, RECOMMENDED_ANSWER_SETUP);
        const cap = capAfterEdit(edited, parsed.dailyCap);
        if (parsed.dailyCap === undefined && ![undefined, 10].includes(edited.safety.daily_llm_spend_cap_usd)) {
          log(`Daily limit kept at $${edited.safety.daily_llm_spend_cap_usd}.`);
        }
        edited.safety.daily_llm_spend_cap_usd = cap;
        try {
          await deps.prepareDaily?.(manifestPath, {
            previousManifest: originalManifest,
            afterManifest: edited,
          });
        } catch (cause) {
          const error = new Error(
            `${DAILY_RECONCILE_FAILED(manifestPath)} Support code: DAILY_RECONCILE_FAILED.`,
            { cause },
          );
          error.code = "DAILY_RECONCILE_FAILED";
          error.answerSetupClass = "error";
          throw error;
        }
        checkBound();
        if (useRecoveryWriter) {
          recoveryRuntime = prepareRecoveryTransaction(manifestPath, currentManifest, edited, {
            mode,
            secretExisted,
            publication: deps.publicationOptions || {},
          });
          journal = recoveryRuntime?.journal || null;
          if (journal) {
            const journalStage = atomicJsonWrite(path, journal, {
              operationId: recoveryRuntime.operationId,
              role: "journal",
              predecessor: null,
              publication: deps.publicationOptions || {},
            });
            try {
              const publishedJournal = stableReadFile(path);
              const journalBytes = jsonBytes(journal);
              if (!stagedBytesMatch(path, journalStage.proof, journalBytes) ||
                  !publishedJournal.bytes.equals(journalBytes)) publicationRefusal();
              recoveryRuntime.journalReceipt = Object.freeze({
                path,
                stage: journalStage,
                published: Object.freeze({
                  path,
                  bytes: journalBytes,
                  identity: publishedJournal.identity,
                }),
              });
            } catch (error) {
              recoveryRuntime.cleanupRefused = true;
              throw error;
            }
            publishOwnedStage(
              recoveryRuntime.intendedStage,
              manifestPath,
              recoveryRuntime.originalObservation.identity,
              deps.publicationOptions || {},
            );
            recoveryRuntime.consumedStagePaths.add(recoveryRuntime.intendedStage.path);
            const publishedTarget = stableReadFile(manifestPath);
            if (!samePublishedStageIdentity(publishedTarget.identity, recoveryRuntime.intendedStage.proof) ||
                !publishedTarget.bytes.equals(recoveryRuntime.intendedBytes)) {
              recoveryRuntime.cleanupRefused = true;
              publicationRefusal();
            }
            rememberRuntimeTarget(
              recoveryRuntime,
              publishedTarget,
              recoveryRuntime.originalBytes,
            );
          }
        } else {
          journal = answerSetupJournal(currentManifest, { mode, secretExisted });
          await writeJournal(journal);
          await writeManifest(manifestPath, edited);
        }
        currentManifest = edited;
        checkBound();
        const deferDaily = deps.deferDailyUntilAfterDeploy === true && !originalManifest.brain?.domain;
        if (!deferDaily) {
          try {
            await deps.reconcileDaily?.(manifestPath, { previousManifest: originalManifest });
          } catch (cause) {
            const error = new Error(
              `${DAILY_RECONCILE_FAILED(manifestPath)} Support code: DAILY_RECONCILE_FAILED.`,
              { cause },
            );
            error.code = "DAILY_RECONCILE_FAILED";
            error.answerSetupClass = "error";
            throw error;
          }
        }
        if (["clipboard", "prompt"].includes(mode)) {
          try {
            await deps.putSecret(ANTHROPIC_SECRET_NAME, key);
          } catch {
            const error = new Error("the Anthropic secret could not be stored");
            error.answerSetupClass = "error";
            error.supportCode = "ANTHROPIC_CHECK_FAILED";
            throw error;
          }
          keyWritten = true;
          names = new Set(await deps.listSecretNames());
          if (!names.has(ANTHROPIC_SECRET_NAME)) throw new Error("the Anthropic secret name was not present after write readback");
          if (recoveryRuntime) recordSecretReadback(
            recoveryRuntime,
            manifestPath,
            deps.publicationOptions || {},
          );
        }
        checkBound();
        await deps.verifyDeploy?.(currentManifest);
        await deps.deploy?.(manifestPath);
        if (recoveryRuntime) {
          const observed = observeForwardManifest(
            recoveryRuntime,
            manifestPath,
            deps.publicationOptions || {},
          );
          currentManifest = observed.manifest;
        } else if (typeof deps.readManifestAfterDeploy === "function") {
          currentManifest = await deps.readManifestAfterDeploy(manifestPath);
        }
        if (deferDaily) {
          try {
            await deps.reconcileDaily?.(manifestPath, { previousManifest: originalManifest });
          } catch (cause) {
            const error = new Error(
              `${DAILY_RECONCILE_FAILED(manifestPath)} Support code: DAILY_RECONCILE_FAILED.`,
              { cause },
            );
            error.code = "DAILY_RECONCILE_FAILED";
            error.answerSetupClass = "error";
            throw error;
          }
        }
      }

      let workerCheck;
      let echoMatched = false;
      const expected = resolvedAnswerModels(currentManifest);
      const checkStarted = asTime(now());
      do {
        checkBound();
        workerCheck = await deps.checkWorker(currentManifest);
        echoMatched = workerCheck?.answer?.model === expected.answer_model &&
          workerCheck?.check?.model === expected.gate_model;
        if (echoMatched) break;
        if (asTime(now()) - checkStarted >= 60_000) break;
        const sleeper = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        await sleeper(2_000);
      } while (true);

      const statuses = [workerCheck?.answer?.status, workerCheck?.check?.status];
      const allOk = echoMatched && statuses.every((status) => status === "ok");
      const dailyLimit = echoMatched && statuses.every((status) => ["ok", "daily_limit"].includes(status)) && statuses.includes("daily_limit");
      const transient = !echoMatched || statuses.some((status) =>
        ["busy", "spend_check_paused", "check_problem"].includes(status));
      if (allOk || dailyLimit) {
        completed = true;
        await clearClipboardNow();
        if (journal) {
          if (recoveryRuntime) await removeRuntimeArtifacts(recoveryRuntime, deps);
          else await removeJournal();
        }
        const reset = displayResetTime(
          nextUtcResetIso(now()),
          String(currentManifest.client?.timezone || "UTC"),
        );
        if (dailyLimit) log(LIMIT_ALREADY_REACHED(manifestPath, reset));
        for (const line of DONE_LINES({
          cap: currentManifest.safety?.daily_llm_spend_cap_usd ?? 10,
          reset,
          clipboard: mode === "clipboard" && clipboardCleared,
        })) log(line);
        return resultReceipt(currentManifest, workerCheck, { keyWritten });
      }
      if (transient && (!["clipboard", "prompt"].includes(mode) || keyPreflightOk)) {
        completed = true;
        await clearClipboardNow();
        if (journal) {
          if (recoveryRuntime) await removeRuntimeArtifacts(recoveryRuntime, deps);
          else await removeJournal();
        }
        log(statuses.includes("check_problem") ? CHECK_PROBLEM : CHECK_PENDING(manifestPath));
        return resultReceipt(currentManifest, workerCheck, { keyWritten });
      }
      const failureStatus = statuses.find((status) => status && status !== "ok") || "error";
      const failure = new Error(failureLine(failureStatus));
      failure.answerSetupClass = failureStatus;
      failure.supportCode = failureStatus === "key_rejected" ? "ANTHROPIC_KEY_NOT_ACCEPTED"
        : failureStatus === "billing" ? "ANTHROPIC_ACCOUNT_NEEDS_CREDIT"
          : "ANTHROPIC_CHECK_FAILED";
      failure.workerCheck = workerCheck;
      throw failure;
    } catch (error) {
      if (!journal || completed) throw error;
      const failureClass = error?.answerSetupClass || error?.code || "error";
      const writtenKeyRejected = keyWritten && Boolean(error?.workerCheck) && failureClass === "key_rejected";
      const previousManifest = restoreManifestFromAnswerSetupJournal(currentManifest, journal);
      const previousSetup = answerSetupOf(previousManifest);
      const keepPrevious = previousSetup === "built-in" ||
        (previousSetup !== "built-in" && journal.secret_name_existed && !writtenKeyRejected);
      const rollbackManifest = keepPrevious
        ? previousManifest
        : restoreManifestFromAnswerSetupJournal(currentManifest, journal, { builtIn: true });
      const rollbackTarget = keepPrevious && previousSetup !== "built-in" ? "previous" : "built-in";
      try {
        if (recoveryRuntime) {
          // Prove the exact last accepted target before creating any rollback
          // artifact. A current pathname observation is evidence, never authority.
          const rollbackProof = requireRuntimeTarget(recoveryRuntime, manifestPath);
          const exactRollback = createOwnedStage(
            manifestPath,
            rollbackProof.rollbackBytes,
            recoveryRuntime.operationId,
            `rollback-${randomBytes(4).toString("hex")}`,
            deps.publicationOptions || {},
          );
          recoveryRuntime.rollbackStages.push(exactRollback);
          publishOwnedStage(
            exactRollback,
            manifestPath,
            rollbackProof.identity,
            deps.publicationOptions || {},
            rollbackProof.bytes,
          );
          recoveryRuntime.consumedStagePaths.add(exactRollback.path);
          currentManifest = JSON.parse(exactRollback.bytes.toString("utf8"));
        } else {
          await writeManifest(manifestPath, rollbackManifest);
          currentManifest = rollbackManifest;
        }
        const shouldDelete = !rollbackManifest.retrieval?.rerank &&
          ((keyWritten && !journal.secret_name_existed) || writtenKeyRejected);
        if (shouldDelete) {
          try {
            await deps.deleteSecret?.(ANTHROPIC_SECRET_NAME);
          } catch (deleteError) {
            if (deleteError?.status !== 404) throw deleteError;
          }
          const names = new Set(await deps.listSecretNames());
          if (names.has(ANTHROPIC_SECRET_NAME)) throw new Error("the Anthropic secret delete did not read back");
        } else if (rollbackManifest.retrieval?.rerank === true) {
          log(KEY_KEPT_FOR_RERANK);
        }
        await deps.reconcileDaily?.(manifestPath, { previousManifest: originalManifest, rollback: true });
        await deps.verifyDeploy?.(currentManifest);
        await deps.deploy?.(manifestPath);
        rollbackComplete = true;
        await clearClipboardNow();
        if (recoveryRuntime) await removeRuntimeArtifacts(recoveryRuntime, deps);
        else await removeJournal();
        log(rollbackTarget === "previous" ? ROLLED_BACK_PREVIOUS : ROLLED_BACK_BUILT_IN);
        log(failureLine(failureClass));
        error.rolledBack = true;
        error.rollbackTarget = rollbackTarget;
      } catch (rollbackError) {
        const incomplete = new Error(`${ROLLBACK_INCOMPLETE(manifestPath, journal.secret_name_existed)} Support code: ANTHROPIC_ROLLBACK_INCOMPLETE.`, { cause: rollbackError });
        incomplete.supportCode = "ANTHROPIC_ROLLBACK_INCOMPLETE";
        throw incomplete;
      }
      if (rollbackComplete) throw error;
      throw error;
    } finally {
      await clearClipboardNow();
    }
  });
}

