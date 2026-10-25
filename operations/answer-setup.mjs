import { captureRenameIdentity, renameIdentityMatches, renameWithRetrySync, captureStagedProof, removeOwnedStaging, stagedBytesMatch } from "./rename-retry.mjs";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

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
  const accepted = new Set(["from-clipboard", "key-set-in-dashboard", "keep-key", "daily-cap", "json"]);
  const unknown = Object.keys(flags).find((name) => !accepted.has(name));
  if (unknown) throw new Error(`brain connect anthropic does not recognize --${unknown}`);
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

function atomicJsonWrite(path, value, options = {}) {
  const predecessor = captureRenameIdentity(path, { bigint: true });
  const refuse = () => { throw new Error("the JSON file changed before it could be replaced"); };
  const priorPublication = options.expectedPublication;
  const predecessorMatches = () => priorPublication
    ? stagedBytesMatch(path, priorPublication.proof, priorPublication.bytes)
    : renameIdentityMatches(path, predecessor);
  if (!predecessorMatches()) refuse();
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const descriptor = openSync(temp, "wx", 0o600);
  let created;
  try {
    created = fstatSync(descriptor, { bigint: true });
    writeFileSync(descriptor, bytes);
  } finally { closeSync(descriptor); }
  const staged = captureStagedProof(temp, bytes, created);
  renameWithRetrySync(temp, path, { staged: { expected: staged, bytes, refuse }, revalidate() {
    if (!predecessorMatches()) refuse();
  } });
  const proof = captureStagedProof(path, bytes, created);
  const publication = Object.freeze({ created, proof, bytes,
    isCurrent: () => stagedBytesMatch(path, proof, bytes),
  });
  options.onPublished?.(publication);
  if (!proof) refuse();
  return publication;
}

export function saveManifestAtomically(path, manifest, options = {}) {
  atomicJsonWrite(path, manifest, options);
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
  const writeManifest = deps.saveManifestAtomically ?? saveManifestAtomically;
  const journalExists = deps.journalExists ?? (() => existsSync(path));
  let journalPublication = null;
  let manifestPublication = null;
  let manifestPublished = false;
  const writeJournal = deps.writeJournal ?? ((value, options) => atomicJsonWrite(path, value, options));
  const removeJournal = deps.removeJournal ?? (() => {
    if (!journalPublication?.proof || !removeOwnedStaging(path, journalPublication.created, {
      proof: journalPublication.proof, bytes: journalPublication.bytes,
    })) throw new Error("the answer setup journal changed before it could be removed");
  });
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

  return lock({ manifestPath, operation: "answer-setup" }, async () => {
    try {
      if (journalExists()) {
        const error = new Error(HALF_RUN(manifestPath));
        error.code = "HALF_RUN";
        throw error;
      }
      currentManifest = await readManifest(manifestPath);
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
        const intendedJournal = answerSetupJournal(currentManifest, { mode, secretExisted });
        await writeJournal(intendedJournal, { onPublished(publication) {
          journalPublication = publication;
          journal = intendedJournal;
        } });
        journal = intendedJournal;
        await writeManifest(manifestPath, edited, { onPublished(publication) {
          manifestPublication = publication;
          manifestPublished = true;
        } });
        manifestPublished = true;
        currentManifest = edited;
        checkBound();
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
        }
        checkBound();
        await deps.verifyDeploy?.(currentManifest);
        await deps.deploy?.(manifestPath, {
          // Deployment may save a verified domain. Keep that owned write inside
          // this transaction instead of invalidating its rollback authority.
          saveManifest: async (file, value) => {
            if (file !== manifestPath || !manifestPublication?.isCurrent?.()) {
              throw new Error("the answer setup manifest changed before deployment could save it");
            }
            await writeManifest(file, value, {
              expectedPublication: manifestPublication,
              onPublished(publication) { manifestPublication = publication; },
            });
          },
        });
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
        if (journal) await removeJournal();
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
        if (journal) await removeJournal();
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
      // A refused forward write gives no authority to replace a newer file.
      // Only the journal was published in this branch, so undo only that item.
      if (!manifestPublished) {
        try { await removeJournal(); } catch { /* the refused publication remains the primary error */ }
        throw error;
      }
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
        if (!manifestPublication?.isCurrent?.()) {
          throw new Error("the answer setup manifest changed before rollback");
        }
        await writeManifest(manifestPath, rollbackManifest, { expectedPublication: manifestPublication });
        currentManifest = rollbackManifest;
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
        // The rollback restores the original manifest, including domain absence.
        await deps.deploy?.(manifestPath, { persistDomain: false });
        rollbackComplete = true;
        await clearClipboardNow();
        await removeJournal();
        log(rollbackTarget === "previous" ? ROLLED_BACK_PREVIOUS : ROLLED_BACK_BUILT_IN);
        log(failureLine(failureClass));
        error.rolledBack = true;
        error.rollbackTarget = rollbackTarget;
      } catch (rollbackError) {
        const incomplete = new Error(`${ROLLBACK_INCOMPLETE(manifestPath)} Support code: ANTHROPIC_ROLLBACK_INCOMPLETE.`, { cause: rollbackError });
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

