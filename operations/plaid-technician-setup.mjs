/**
 * Owner-controlled Plaid application-secret setup for the technician workflow.
 *
 * Provider values arrive as hidden-input Buffers owned by the caller. This
 * module never accepts them through argv or ambient environment variables. The
 * independent wrapping key is generated locally and committed to the owner's
 * existing protected credential-store machinery before Cloudflare is changed,
 * so an interrupted or ambiguous request can safely converge on the same key.
 *
 * Cloudflare's script secrets-bulk endpoint applies the three values in one
 * JSON Merge Patch. Secrets omitted from that request remain untouched. Exact
 * per-name reads then prove that only the intended bindings are present without
 * asking Cloudflare to reveal their values.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  loadTokens,
  saveTokens,
  tokenStorageDescription,
} from "../connectors/google-auth.mjs";
import {
  BANK_ACCESS_WRAPPING_KEY_SECRET,
  generateBankAccessWrappingKey,
  validateBankAccessWrappingKey,
} from "./bank-access-wrapping-key.mjs";
import { withSourceIngestLock } from "./source-ingest-lock.mjs";

export const PLAID_WORKER_SECRET_NAMES = Object.freeze([
  "BANK_FEED_CLIENT_ID",
  "BANK_FEED_SECRET",
  BANK_ACCESS_WRAPPING_KEY_SECRET,
]);

export const BANK_FEED_WRAPPING_KEY_STORE_ENV = "BRAIN_BANK_FEED_WRAPPING_KEY_STORE";
export const BANK_FEED_WRAPPING_KEY_KEYCHAIN_SERVICE =
  "brain-installer.bank-feed-wrapping-key-v2";

const WORKER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,60}$/;
const WORKERS_DEV_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * Derive the authenticated proof origin only from the resolved Cloudflare
 * account and Worker. The customer-facing brain.domain is intentionally not an
 * input because it is not an identity proof for a request carrying X-Admin-Key.
 */
export async function resolvePlaidWorkerProofBase({
  accountId,
  scriptName,
  apiRequest,
} = {}) {
  const account = String(accountId || "").trim();
  const script = String(scriptName || "").trim();
  if (!account || typeof apiRequest !== "function") {
    throw new TypeError("the Plaid proof route needs the resolved Cloudflare account boundary");
  }
  if (!WORKER_NAME_PATTERN.test(script)) {
    throw new Error("the resolved Worker name is not safe for a workers.dev proof route");
  }
  const accountPath = `/accounts/${encodeURIComponent(account)}`;
  const workerPath = `${accountPath}/workers/scripts/${encodeURIComponent(script)}`;
  let response;
  try {
    const route = await apiRequest(`${workerPath}/subdomain`);
    if (route?.enabled !== true) {
      throw new Error("workers_dev_route_disabled");
    }
    response = await apiRequest(`${accountPath}/workers/subdomain`);
  } catch {
    throw new Error(
      "The exact Worker's workers.dev proof route is not enabled or could not be verified. " +
        "Fix its Cloudflare route access and rerun `brain deploy`, then retry this ceremony. " +
        "No credential prompt or authenticated Brain request was opened.",
    );
  }
  const label = typeof response?.subdomain === "string" ? response.subdomain.trim() : "";
  if (!WORKERS_DEV_LABEL_PATTERN.test(label)) {
    throw new Error(
      "The exact Cloudflare account did not return a safe workers.dev hostname. " +
        "No credential prompt or authenticated Brain request was opened.",
    );
  }
  return `https://${script}.${label.toLowerCase()}.workers.dev`;
}

function bindingFingerprint(accountId, scriptName) {
  const account = String(accountId || "").trim();
  const script = String(scriptName || "").trim();
  if (!account || !script) {
    throw new TypeError("a resolved Cloudflare account and Worker name are required");
  }
  return createHash("sha256")
    .update(`bank-feed-wrapping-key-v2\0${account}\0${script}`)
    .digest("hex")
    .slice(0, 32);
}

/** One protected, independently auditable wrapping-key record per Worker. */
export function bankFeedWrappingKeyStorageOptions({
  accountId,
  scriptName,
  home = homedir(),
  ...options
} = {}) {
  const fingerprint = bindingFingerprint(accountId, scriptName);
  const platform = options.platform ?? process.platform;
  return {
    keychainService: BANK_FEED_WRAPPING_KEY_KEYCHAIN_SERVICE,
    keychainAccount: `worker-${fingerprint}`,
    keychainComment: "Financial Brain bank access wrapping key v2",
    storeEnv: BANK_FEED_WRAPPING_KEY_STORE_ENV,
    path: join(home, ".brain", `bank-feed-wrapping-key-v2-${fingerprint}.json`),
    // The standard ceremony selects the protected backend from the operating
    // system. An ambient environment variable cannot redirect key custody.
    backend: platform === "darwin" ? "keychain" : "file",
    platform,
    ...options,
  };
}

function sameText(left, right) {
  const a = Buffer.from(String(left), "utf8");
  const b = Buffer.from(String(right), "utf8");
  try {
    return a.length === b.length && timingSafeEqual(a, b);
  } finally {
    a.fill(0);
    b.fill(0);
  }
}

function wrappingKeyFingerprint(value) {
  validateBankAccessWrappingKey(value);
  const bytes = Buffer.from(value.slice(3), "base64url");
  try {
    return createHash("sha256").update(bytes).digest("hex");
  } finally {
    bytes.fill(0);
  }
}

function checkedRemoteWrappingKeyProof(value) {
  const exactFields = ["configured", "key_fingerprint", "key_version"];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== exactFields.join(",") ||
      typeof value.configured !== "boolean" || value.key_version !== 2 ||
      (value.configured
        ? !/^[a-f0-9]{64}$/.test(String(value.key_fingerprint || ""))
        : value.key_fingerprint !== null)) {
    throw new Error("the deployed Brain returned an invalid bank wrapping-key proof");
  }
  return value;
}

async function readRemoteWrappingKeyProof(remoteWrappingKeyProof) {
  if (typeof remoteWrappingKeyProof !== "function") {
    throw new Error("the deployed Brain wrapping-key proof boundary is unavailable");
  }
  return checkedRemoteWrappingKeyProof(await remoteWrappingKeyProof());
}

const waitFor = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForRemoteWrappingKey({
  remoteWrappingKeyProof,
  expectedKey,
  attempts = 30,
  delayMs = 2_000,
  wait = waitFor,
  now = Date.now,
  timeoutMs = 60_000,
  onWait = null,
  checkpoint = () => true,
  requireStableUntilDeadline = false,
}) {
  const expectedFingerprint = wrappingKeyFingerprint(expectedKey);
  const boundedAttempts = Math.max(1, Math.min(30, Number(attempts) || 1));
  const boundedDelay = Math.max(0, Math.min(2_000, Number(delayMs) || 0));
  const deadline = now() + Math.max(0, Math.min(60_000, Number(timeoutMs) || 0));
  for (let attempt = 0; attempt < boundedAttempts; attempt++) {
    if (attempt > 0 && now() >= deadline) break;
    await checkpoint();
    let proof = null;
    try { proof = await readRemoteWrappingKeyProof(remoteWrappingKeyProof); } catch { /* bounded retry */ }
    await checkpoint();
    const matched = Boolean(proof?.configured &&
      sameText(proof.key_fingerprint, expectedFingerprint));
    if (matched && !requireStableUntilDeadline) return true;
    if (!matched && requireStableUntilDeadline) return false;
    if (matched && now() >= deadline) return true;
    if (attempt === 0 && boundedAttempts > 1 && typeof onWait === "function") onWait();
    if (attempt + 1 < boundedAttempts && now() < deadline) {
      await wait(Math.min(boundedDelay, Math.max(0, deadline - now())));
    }
  }
  if (requireStableUntilDeadline && now() < deadline) {
    await wait(Math.max(0, deadline - now()));
  }
  if (requireStableUntilDeadline) {
    await checkpoint();
    let proof = null;
    try { proof = await readRemoteWrappingKeyProof(remoteWrappingKeyProof); } catch { /* fail closed below */ }
    await checkpoint();
    return Boolean(now() >= deadline && proof?.configured &&
      sameText(proof.key_fingerprint, expectedFingerprint));
  }
  return false;
}

function checkedSecretBuffer(value, label) {
  if (!Buffer.isBuffer(value)) {
    throw new TypeError(`${label} must come from the hidden-input prompt`);
  }
  const bytes = Buffer.from(value);
  if (!bytes.length || bytes.length > 2048 ||
      [...bytes].some((byte) => byte < 0x21 || byte > 0x7e)) {
    bytes.fill(0);
    throw new TypeError(`${label} must be 1 to 2048 printable characters with no spaces`);
  }
  return bytes;
}

function wrappingKeyRecord(value, fingerprint) {
  return {
    schema_version: 1,
    binding_fingerprint: fingerprint,
    wrapping_key: validateBankAccessWrappingKey(value),
  };
}

function readBankFeedWrappingKey({
  accountId,
  scriptName,
  storage = {},
  loadStore = loadTokens,
  describeStore = tokenStorageDescription,
} = {}) {
  const fingerprint = bindingFingerprint(accountId, scriptName);
  const options = bankFeedWrappingKeyStorageOptions({ accountId, scriptName, ...storage });
  const existing = loadStore(options);
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    throw new Error("the protected bank wrapping-key record could not be read");
  }
  if (!Object.keys(existing).length) {
    return Object.freeze({ value: null, storage: describeStore(options), fingerprint, options });
  }
  if (existing.schema_version !== 1 || existing.binding_fingerprint !== fingerprint) {
    throw new Error("the protected bank wrapping-key record belongs to a different Worker or format");
  }
  validateBankAccessWrappingKey(existing.wrapping_key);
  return Object.freeze({
    value: existing.wrapping_key,
    storage: describeStore(options),
    fingerprint,
    options,
  });
}

/**
 * Return the existing protected key or generate, persist, and exactly read back
 * one new independent key. No Cloudflare call occurs in this function.
 */
export function ensureBankFeedWrappingKey({
  accountId,
  scriptName,
  storage = {},
  loadStore = loadTokens,
  saveStore = saveTokens,
  describeStore = tokenStorageDescription,
  generate = generateBankAccessWrappingKey,
} = {}) {
  const current = readBankFeedWrappingKey({
    accountId,
    scriptName,
    storage,
    loadStore,
    describeStore,
  });
  if (current.value) {
    return Object.freeze({
      value: current.value,
      status: "reused",
      storage: current.storage,
    });
  }

  const generated = generate();
  validateBankAccessWrappingKey(generated);
  saveStore(wrappingKeyRecord(generated, current.fingerprint), current.options);
  const verified = loadStore(current.options);
  if (!verified || verified.schema_version !== 1 ||
      verified.binding_fingerprint !== current.fingerprint ||
      !sameText(verified.wrapping_key, generated)) {
    throw new Error("the protected bank wrapping key did not read back exactly");
  }
  validateBankAccessWrappingKey(verified.wrapping_key);
  return Object.freeze({
    value: verified.wrapping_key,
    status: "generated",
    storage: current.storage,
  });
}

function workerSecret(name, text) {
  return { name, text, type: "secret_text" };
}

function checkedBinding(binding, expectedName) {
  return Boolean(binding && binding.name === expectedName && binding.type === "secret_text");
}

function isMissingBindingError(error) {
  return error?.status === 404 || /\(404\)/.test(String(error?.message || ""));
}

async function withPlaidWorkerLock({
  accountId,
  scriptName,
  wrappingKeyOptions,
  mutationMayHaveStarted = false,
}, task) {
  const storageOptions = bankFeedWrappingKeyStorageOptions({
    accountId,
    scriptName,
    ...(wrappingKeyOptions.storage || {}),
  });
  const withLock = wrappingKeyOptions.withLock || withSourceIngestLock;
  try {
    return await withLock({
      sourceName: "plaid-technician-setup",
      statePath: storageOptions.path,
      home: wrappingKeyOptions.storage?.home,
      platform: storageOptions.platform,
    }, ({ assertOwned = () => true } = {}) => task(assertOwned));
  } catch (error) {
    if (String(error?.code || "").startsWith("source_ingest_")) {
      throw new Error(
        "Plaid application setup could not obtain or retain its private per-Worker lock. " +
          `Let any current run finish, then rerun this step. ${mutationMayHaveStarted
            ? "If an update had already begun, the protected wrapping key was kept for that exact retry."
            : "No Worker secret was changed by this preflight."}`,
      );
    }
    throw error;
  }
}

async function inspectPlaidWrappingKeyCustody({
  accountId,
  scriptName,
  apiRequest,
  remoteWrappingKeyProof,
  assertContextUnchanged,
  wrappingKeyOptions,
  assertOwned,
  stabilizeExistingProof = false,
}) {
  const checkpoint = async ({ mutationMayHaveStarted = false } = {}) => {
    await assertContextUnchanged({ mutationMayHaveStarted });
    assertOwned();
  };
  await checkpoint();
  const base = `/accounts/${encodeURIComponent(String(accountId))}` +
    `/workers/scripts/${encodeURIComponent(String(scriptName))}`;
  let protectedState;
  try {
    protectedState = readBankFeedWrappingKey({
      accountId,
      scriptName,
      storage: wrappingKeyOptions.storage,
      loadStore: wrappingKeyOptions.loadStore,
      describeStore: wrappingKeyOptions.describeStore,
    });
  } catch {
    throw new Error(
      "The protected bank wrapping key could not be stored and read back. " +
        "No Worker secret was changed. Fix the protected credential store, then rerun this Plaid technician step.",
    );
  }
  let remoteBindingPresent = false;
  try {
    const remote = await apiRequest(
      `${base}/secrets/${encodeURIComponent(BANK_ACCESS_WRAPPING_KEY_SECRET)}`,
    );
    if (!checkedBinding(remote, BANK_ACCESS_WRAPPING_KEY_SECRET)) {
      throw new Error("unverified_remote_bank_wrapping_key_state");
    }
    remoteBindingPresent = true;
  } catch (error) {
    if (!isMissingBindingError(error)) {
      throw new Error(
        "The existing bank wrapping-key binding could not be checked. No Worker secret was changed. " +
          "Fix Cloudflare access, then rerun this Plaid technician step.",
      );
    }
  }
  await checkpoint();

  if (remoteBindingPresent && !protectedState.value) {
    throw new Error(
      "This Worker already has BANK_FEED_WRAPPING_KEY_V2, but this machine has no matching protected local record. " +
        "No Worker secret was changed. Recover the owner's existing wrapping-key custody before retrying; " +
        "generating a replacement here could make stored bank access references unreadable.",
    );
  }
  if (remoteBindingPresent) {
    const matched = await waitForRemoteWrappingKey({
      remoteWrappingKeyProof,
      expectedKey: protectedState.value,
      attempts: wrappingKeyOptions.proofAttempts,
      delayMs: wrappingKeyOptions.proofDelayMs,
      wait: wrappingKeyOptions.wait,
      now: wrappingKeyOptions.now,
      timeoutMs: wrappingKeyOptions.proofTimeoutMs,
      onWait: wrappingKeyOptions.onProofWait,
      checkpoint,
      requireStableUntilDeadline: stabilizeExistingProof,
    });
    if (!matched) {
      throw new Error(
        "This machine's protected bank wrapping key could not be proved equal to the deployed Brain. " +
          "No Worker secret was changed. Recover the owner's matching custody or let a recent secret update settle before retrying; " +
          "overwriting the Worker could make stored bank access references unreadable.",
      );
    }
  } else {
    let proofBefore;
    try {
      proofBefore = await readRemoteWrappingKeyProof(remoteWrappingKeyProof);
    } catch {
      throw new Error(
        "The deployed Brain could not prove its current bank wrapping-key state. No Worker secret was changed. " +
          "Fix the deployed authenticated proof path, then rerun this Plaid technician step.",
      );
    }
    await checkpoint();
    if (proofBefore.configured) {
      throw new Error(
        "Cloudflare binding metadata and the deployed Brain disagree about the bank wrapping key. " +
          "No Worker secret was changed. Resolve that deployment state before retrying.",
      );
    }
  }
  await checkpoint();
  return { base, checkpoint, protectedState, remoteBindingPresent };
}

/** Read-only custody proof. This runs before either hidden provider prompt. */
export async function preflightPlaidWorkerSecretCustody({
  accountId,
  scriptName,
  apiRequest,
  remoteWrappingKeyProof,
  assertContextUnchanged = () => true,
  wrappingKeyOptions = {},
} = {}) {
  if (typeof apiRequest !== "function" || typeof remoteWrappingKeyProof !== "function") {
    throw new TypeError("the Plaid custody preflight needs both reviewed remote proof boundaries");
  }
  return withPlaidWorkerLock({
    accountId, scriptName, wrappingKeyOptions, mutationMayHaveStarted: false,
  }, async (assertOwned) => {
    const inspected = await inspectPlaidWrappingKeyCustody({
      accountId, scriptName, apiRequest, remoteWrappingKeyProof,
      assertContextUnchanged, wrappingKeyOptions, assertOwned,
      stabilizeExistingProof: false,
    });
    return Object.freeze({
      ready: true,
      remote_binding_present: inspected.remoteBindingPresent,
      local_custody: inspected.protectedState.value ? "verified" : "ready_to_generate",
    });
  });
}

/**
 * Atomically apply exactly the provider pair and independent wrapping key, then
 * read back those three binding names one at a time. The receipt contains no
 * credential value or provider response body.
 */
export async function setupPlaidWorkerSecrets({
  accountId,
  scriptName,
  clientId,
  clientSecret,
  apiRequest,
  remoteWrappingKeyProof,
  assertContextUnchanged = () => true,
  wrappingKeyOptions = {},
} = {}) {
  if (typeof apiRequest !== "function") {
    throw new TypeError("the Plaid setup ceremony needs the reviewed Cloudflare API boundary");
  }
  if (typeof assertContextUnchanged !== "function") {
    throw new TypeError("the Plaid setup ceremony needs a pinned install-record boundary");
  }
  return withPlaidWorkerLock({
    accountId, scriptName, wrappingKeyOptions, mutationMayHaveStarted: true,
  }, (assertOwned) => setupPlaidWorkerSecretsLocked({
    accountId, scriptName, clientId, clientSecret, apiRequest,
    remoteWrappingKeyProof, assertContextUnchanged, wrappingKeyOptions, assertOwned,
  }));
}

async function setupPlaidWorkerSecretsLocked({
  accountId,
  scriptName,
  clientId,
  clientSecret,
  apiRequest,
  remoteWrappingKeyProof,
  assertContextUnchanged,
  wrappingKeyOptions,
  assertOwned,
}) {
  let idBytes = null;
  let secretBytes = null;
  let keyBytes = null;
  let body = null;
  try {
    const { base, checkpoint } = await inspectPlaidWrappingKeyCustody({
      accountId, scriptName, apiRequest, remoteWrappingKeyProof,
      assertContextUnchanged, wrappingKeyOptions, assertOwned,
      stabilizeExistingProof: true,
    });

    idBytes = checkedSecretBuffer(clientId, "Plaid client ID");
    secretBytes = checkedSecretBuffer(clientSecret, "Plaid secret");
    let wrapping;
    try {
      wrapping = ensureBankFeedWrappingKey({
        accountId,
        scriptName,
        ...wrappingKeyOptions,
      });
    } catch {
      throw new Error(
        "The protected bank wrapping key could not be stored and read back. " +
          "No Worker secret was changed. Fix the protected credential store, then rerun this Plaid technician step.",
      );
    }
    keyBytes = Buffer.from(wrapping.value, "utf8");
    body = {
      secrets: {
        BANK_FEED_CLIENT_ID: workerSecret("BANK_FEED_CLIENT_ID", idBytes.toString("utf8")),
        BANK_FEED_SECRET: workerSecret("BANK_FEED_SECRET", secretBytes.toString("utf8")),
        [BANK_ACCESS_WRAPPING_KEY_SECRET]: workerSecret(
          BANK_ACCESS_WRAPPING_KEY_SECRET,
          keyBytes.toString("utf8"),
        ),
      },
    };
    await checkpoint();
    try {
      await apiRequest(`${base}/secrets-bulk`, { method: "PATCH", body });
    } catch {
      throw new Error(
        "Cloudflare did not confirm the atomic bank-secret update. The protected wrapping key was kept. Rerun the same Plaid technician step with the same provider values.",
      );
    }
    const postMutationCheckpoint = () => checkpoint({ mutationMayHaveStarted: true });
    await postMutationCheckpoint();
    for (const name of PLAID_WORKER_SECRET_NAMES) {
      let binding;
      try {
        binding = await apiRequest(`${base}/secrets/${encodeURIComponent(name)}`);
      } catch {
        throw new Error(
          "Cloudflare accepted the atomic bank-secret update, but exact binding-name readback did not finish. " +
            "The protected wrapping key was kept. Rerun the same Plaid technician step with the same provider values.",
        );
      }
      await postMutationCheckpoint();
      if (!checkedBinding(binding, name)) {
        throw new Error(
          "Cloudflare accepted the atomic bank-secret update, but exact binding-name readback differed. " +
            "The protected wrapping key was kept. Rerun the same Plaid technician step with the same provider values.",
        );
      }
    }
    const proofMatched = await waitForRemoteWrappingKey({
      remoteWrappingKeyProof,
      expectedKey: wrapping.value,
      attempts: wrappingKeyOptions.proofAttempts,
      delayMs: wrappingKeyOptions.proofDelayMs,
      wait: wrappingKeyOptions.wait,
      now: wrappingKeyOptions.now,
      timeoutMs: wrappingKeyOptions.proofTimeoutMs,
      onWait: wrappingKeyOptions.onProofWait,
      checkpoint: postMutationCheckpoint,
    });
    if (!proofMatched) {
      throw new Error(
        "Cloudflare accepted the atomic bank-secret update, but the deployed Brain did not prove the expected wrapping key before the bounded wait ended. " +
          "The protected wrapping key was kept. Rerun the same Plaid technician step with the same provider values.",
      );
    }
    await postMutationCheckpoint();
    return Object.freeze({
      applied_atomically: true,
      endpoint: "workers-script-secrets-bulk",
      secret_names_verified: PLAID_WORKER_SECRET_NAMES,
      wrapping_key_status: wrapping.status,
      wrapping_key_storage: wrapping.storage,
      opened_bank_connection: false,
      coordination_boundary: "single_supervised_owner_machine",
      remote_first_setup_compare_and_swap: false,
    });
  } finally {
    if (idBytes) idBytes.fill(0);
    if (secretBytes) secretBytes.fill(0);
    if (keyBytes) keyBytes.fill(0);
    if (body?.secrets) {
      for (const secret of Object.values(body.secrets)) secret.text = "";
    }
  }
}
