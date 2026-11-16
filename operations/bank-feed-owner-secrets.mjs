/**
 * Owner-present Plaid application-credential custody for `brain connect bank`.
 *
 * The owner types their own Plaid client ID and secret at a hidden prompt, and
 * this module writes that pair straight onto the owner's Worker only after the
 * deploy-owned wrapping key is present. Nothing is read from the environment,
 * a flag, the manifest, or a file, and nothing but secret NAMES is ever
 * reported back.
 *
 * Four invariants are enforced here rather than trusted to the caller:
 *
 * - An ambient bank value is refused before any Cloudflare read. The same
 *   refusal `brain secrets` makes: a value in a shell is a value in history.
 * - BANK_FEED_WRAPPING_KEY_V2 must already exist. Deploy is the only creator.
 *   Disabling the feed deletes the provider pair but deliberately keeps the
 *   wrapping key, because retained encrypted access references can only be
 *   recovered with it. `--replace-keys` touches only the provider pair.
 * - A typed pair is proven against the manifest's Plaid environment with one
 *   harmless authenticated read before anything is written. Field evidence:
 *   two operators pasted a secret from the wrong environment, the write
 *   "succeeded", and the failure surfaced only as a Link error in the browser.
 * - Success is the re-listed Worker inventory, not the PUT responses.
 */
import {
  BANK_ACCESS_WRAPPING_KEY_SECRET,
  generateBankAccessWrappingKey,
} from "./bank-access-wrapping-key.mjs";
import { PLAID_PROFILE } from "../worker/src/lib/bank-feed-profiles.js";

export const BANK_FEED_PROVIDER_SECRET_NAMES = Object.freeze([
  "BANK_FEED_CLIENT_ID",
  "BANK_FEED_SECRET",
]);

export const BANK_FEED_OWNER_SECRET_NAMES = Object.freeze([
  ...BANK_FEED_PROVIDER_SECRET_NAMES,
  BANK_ACCESS_WRAPPING_KEY_SECRET,
]);

/**
 * Waits before each re-read when a key that existed before the upload is not
 * listed right after it. Field evidence (an owner Brain, 2026-11-16): one
 * name-only read taken seconds after an active upload left out a key that
 * the same run had listed minutes earlier, and the old code replaced it.
 */
export const BANK_WRAPPING_KEY_CONFIRM_DELAYS_MS = Object.freeze([2_000, 5_000, 10_000]);

const defaultSleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

/**
 * Read, BEFORE a Worker upload, whether the bank wrapping key already exists.
 *
 * Returns "present", "absent" (listed without it, or the Worker itself does
 * not exist yet: a fresh install), or "unknown" (the read failed or was
 * ambiguous). Never throws: an unknown answer only forbids creating a key
 * later; it never blocks the upload by itself.
 */
export async function readBankWrappingKeyBeforeUpload({
  listSecretNames,
  isWorkerMissing = () => false,
} = {}) {
  if (typeof listSecretNames !== "function") return "unknown";
  try {
    return namesFromInventory(await listSecretNames()).has(BANK_ACCESS_WRAPPING_KEY_SECRET)
      ? "present"
      : "absent";
  } catch (error) {
    try {
      if (isWorkerMissing(error) === true) return "absent";
    } catch {
      // An unreadable failure is never proof that the Worker is missing.
    }
    return "unknown";
  }
}

// Only what this command can prove: it wrote nothing. Whether an earlier
// command already damaged a connection is not knowable from a name list.
const NOTHING_WRITTEN =
  "No new key was created and nothing was replaced, so this command did not change your bank connections. ";

function keyNotConfirmedError(beforeUpload) {
  const opening = beforeUpload === "present"
    ? "Cloudflare did not list the bank wrapping key (BANK_FEED_WRAPPING_KEY_V2) after this upload, " +
      "although it was there just before it. "
    : beforeUpload === "recorded"
      ? "Cloudflare does not list the bank wrapping key (BANK_FEED_WRAPPING_KEY_V2) on this Worker, " +
        "although an earlier run on this computer saw it there. "
      : "the Worker's secret names could not be read before this upload, and Cloudflare does not list the " +
        "bank wrapping key (BANK_FEED_WRAPPING_KEY_V2) after it. ";
  return new Error(
    opening +
      NOTHING_WRITTEN +
      "This is usually a short Cloudflare delay: wait a few minutes, then rerun the same command. " +
      (beforeUpload === "recorded"
        ? "If it stops here again, do not reconnect a bank; ask for help, because a new key could never open " +
          "a connection sealed with the old one. "
        : "") +
      "No wrapping-key value was saved locally.",
  );
}

/**
 * The D1 rows that can only be opened with BANK_FEED_WRAPPING_KEY_V2: every
 * stored bank access reference at key version 2 or later (removed ones too,
 * since disconnect keeps unresolved history evidence), and every Plaid Link
 * receipt still holding a sealed value. Version-1 rows use the legacy derived
 * key and are rewrapped only once a V2 key exists, so they do not count.
 */
export const BANK_SEALED_REFERENCE_CHECKS = Object.freeze([
  Object.freeze({
    table: "bank_feed_items",
    sql: "SELECT COUNT(*) AS sealed FROM bank_feed_items WHERE key_version >= 2",
  }),
  Object.freeze({
    table: "plaid_link_operations",
    sql: "SELECT COUNT(*) AS sealed FROM plaid_link_operations " +
      "WHERE link_key_version IS NOT NULL OR link_ciphertext IS NOT NULL",
  }),
]);

function isMissingTable(error, table) {
  return new RegExp(`no such table:\\s*(?:main\\.)?${table}\\b`, "i").test(String(error?.message || ""));
}

/**
 * Count the Brain's stored values sealed with the bank wrapping key.
 *
 * `query(sql)` runs one read-only statement on the Brain's D1 and resolves to
 * `{ results: [...] }`. A table that does not exist yet (a database migrated
 * before the bank feed) holds nothing; every other failure, and any answer
 * that is not one non-negative whole number, throws, so no key is created on
 * an unproven zero.
 */
export async function countSealedBankAccessReferences({ query } = {}) {
  if (typeof query !== "function") {
    throw new TypeError("the sealed bank reference check needs a database query operation");
  }
  let total = 0;
  for (const check of BANK_SEALED_REFERENCE_CHECKS) {
    let result;
    try {
      result = await query(check.sql);
    } catch (error) {
      if (isMissingTable(error, check.table)) continue;
      throw new Error(`the Brain's database could not be checked for values sealed with the bank wrapping key (${check.table})`);
    }
    const rows = result?.results;
    const value = Array.isArray(rows) && rows.length === 1 ? rows[0]?.sealed : undefined;
    const count = typeof value === "number" ? value
      : typeof value === "bigint" ? Number(value)
        : typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value)
          : Number.NaN;
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`the Brain's database returned an unreadable count for ${check.table}`);
    }
    total += count;
  }
  return total;
}

function sealedReferencesPresentError(count) {
  return new Error(
    "Cloudflare does not list the bank wrapping key (BANK_FEED_WRAPPING_KEY_V2) on this Worker, but this " +
      `Brain's database holds ${count} bank connection record${count === 1 ? "" : "s"} sealed with that key. ` +
      NOTHING_WRITTEN +
      "A short Cloudflare delay can hide the key: wait a few minutes, then rerun the same command. " +
      "If it stops here again, do not reconnect a bank; ask for help, because a new key could never open " +
      "those records. No wrapping-key value was saved locally.",
  );
}

function sealedReferencesUnknownError() {
  return new Error(
    "Cloudflare does not list the bank wrapping key (BANK_FEED_WRAPPING_KEY_V2) on this Worker, and this " +
      "Brain's database could not be checked for bank connections sealed with it. " +
      NOTHING_WRITTEN +
      "Wait a few minutes, then rerun the same command. No wrapping-key value was saved locally.",
  );
}

/**
 * Establish only the independent bank wrapping key during a Worker lifecycle.
 *
 * Provider credentials still belong to their owner-present setup path. This
 * helper receives and returns names only, apart from passing the new value
 * directly from the reviewed generator to the injected Worker secret writer.
 * An existing key is never read, replaced, validated, or derived from another
 * credential. Rotation therefore remains impossible from install, update, and
 * deploy.
 *
 * `beforeUpload` is what the caller knew before the upload this call follows:
 * "present" (listed before it, or earlier in this run), "recorded" (this
 * computer saw it on this Worker in an earlier run), "absent", or anything
 * else, which is "unknown". A key is created ONLY when it was "absent" before
 * the upload AND is absent after it AND `countSealedReferences()` proves the
 * Brain's database holds nothing sealed with a wrapping key. In every other
 * case a missing name after the upload is treated as a read that has not
 * caught up: the inventory is re-read after short waits, and if the name
 * never comes back the call stops WITHOUT writing. A PUT replaces an existing
 * value, so writing on a false-absent read would orphan every stored bank
 * access reference; two false-absent reads in a row are why the database
 * check exists.
 */
export async function ensureBankFeedWrappingKey({
  enabled = false,
  listSecretNames,
  putSecret,
  generateWrappingKey = generateBankAccessWrappingKey,
  beforeUpload = "unknown",
  countSealedReferences,
  confirmDelaysMs = BANK_WRAPPING_KEY_CONFIRM_DELAYS_MS,
  sleep = defaultSleep,
  onConfirmRetry = () => {},
} = {}) {
  if (enabled !== true) {
    return Object.freeze({ created: false, name: BANK_ACCESS_WRAPPING_KEY_SECRET });
  }
  if (typeof listSecretNames !== "function" || typeof putSecret !== "function") {
    throw new TypeError("bank wrapping-key custody needs Worker secret-list and secret-put operations");
  }
  const before = ["present", "recorded", "absent"].includes(beforeUpload) ? beforeUpload : "unknown";

  let present;
  try {
    present = namesFromInventory(await listSecretNames());
  } catch {
    throw new Error(
      "the Worker's secret names could not be checked, so the independent bank wrapping key was not changed. " +
        "Rerun the same command after Workers Scripts access is available.",
    );
  }
  if (present.has(BANK_ACCESS_WRAPPING_KEY_SECRET)) {
    return Object.freeze({ created: false, name: BANK_ACCESS_WRAPPING_KEY_SECRET, before, confirmRetries: 0 });
  }

  if (before !== "absent") {
    // Never write here. Only re-read, and stop if the name stays missing.
    const delays = Array.isArray(confirmDelaysMs) ? confirmDelaysMs : BANK_WRAPPING_KEY_CONFIRM_DELAYS_MS;
    let retries = 0;
    for (const delay of delays) {
      retries += 1;
      try { onConfirmRetry({ attempt: retries, delayMs: delay, before }); } catch {}
      await sleep(delay);
      let names;
      try {
        names = namesFromInventory(await listSecretNames());
      } catch {
        continue;
      }
      if (names.has(BANK_ACCESS_WRAPPING_KEY_SECRET)) {
        return Object.freeze({ created: false, name: BANK_ACCESS_WRAPPING_KEY_SECRET, before, confirmRetries: retries });
      }
    }
    throw keyNotConfirmedError(before);
  }

  // Absent before the upload and after it. The last proof before a write that
  // would replace any key Cloudflare left out of both lists: nothing in the
  // Brain's database may depend on a wrapping key. A fresh setup migrates
  // before it deploys, so it reads zero here and gets its key.
  if (typeof countSealedReferences !== "function") throw sealedReferencesUnknownError();
  let sealed;
  try {
    sealed = await countSealedReferences();
  } catch {
    throw sealedReferencesUnknownError();
  }
  if (!Number.isSafeInteger(sealed) || sealed < 0) throw sealedReferencesUnknownError();
  if (sealed > 0) throw sealedReferencesPresentError(sealed);

  const generated = generateWrappingKey();
  try {
    await putSecret(BANK_ACCESS_WRAPPING_KEY_SECRET, generated);
  } catch {
    throw new Error(
      "the independent bank wrapping key could not be created or confirmed on the Worker. " +
        "The write result is unknown, and the Worker may already contain the key. " +
        "Rerun the same setup, update, or deploy command; it will recheck the secret names before " +
        "deciding whether a write is needed. No wrapping-key value was saved locally.",
    );
  }

  let verified;
  try {
    verified = namesFromInventory(await listSecretNames());
  } catch {
    throw new Error(
      "the independent bank wrapping key write could not be verified by listing the Worker's secret names again. " +
        "Rerun the same setup, update, or deploy command before opening bank setup.",
    );
  }
  if (!verified.has(BANK_ACCESS_WRAPPING_KEY_SECRET)) {
    throw new Error(
      "the independent bank wrapping key was not listed after its Worker write. " +
        "Rerun the same setup, update, or deploy command before opening bank setup.",
    );
  }
  return Object.freeze({ created: true, name: BANK_ACCESS_WRAPPING_KEY_SECRET, before, confirmRetries: 0 });
}

const PROMPT_LABELS = Object.freeze({
  BANK_FEED_CLIENT_ID: "client_id",
  BANK_FEED_SECRET: "secret",
});

const VALIDATION_TIMEOUT_MS = 20_000;

function promptFor(name, environment) {
  const scope = environment ? `the ${environment} environment` : "this environment";
  return `  Plaid ${PROMPT_LABELS[name]} for ${scope} (hidden): `;
}

function namesFromInventory(inventory) {
  if (!Array.isArray(inventory) || inventory.some((name) => typeof name !== "string")) {
    throw new Error("Cloudflare returned an invalid Worker secret inventory. No bank secret was written.");
  }
  const canonicalByFoldedName = new Map(BANK_FEED_OWNER_SECRET_NAMES.map((name) => [name.toLowerCase(), name]));
  for (const name of inventory) {
    const canonical = canonicalByFoldedName.get(name.trim().toLowerCase());
    if (canonical && name !== canonical) {
      throw new Error(
        `Cloudflare returned an ambiguous spelling of ${canonical}. No bank secret was written.`,
      );
    }
  }
  return new Set(inventory);
}

/** A pasted key is one printable token. Whitespace inside it is a paste error. */
function normalizeProviderValue(name, raw) {
  const value = String(raw ?? "").trim();
  if (!value) throw new Error(`no value was entered for ${name}. No bank secret was written.`);
  if (value.length > 256 || !/^[\x21-\x7e]+$/.test(value)) {
    throw new Error(
      `the value entered for ${name} is not a single printable key. Copy it again from the Plaid ` +
        "dashboard Keys page. No bank secret was written.",
    );
  }
  return value;
}

/**
 * Prove one typed client_id and secret against a Plaid environment.
 *
 * `/institutions/get` with count 1 is an authenticated read of public directory
 * data. It creates no Item, touches no bank, and moves no money, so it is safe
 * to call at the prompt. Plaid answers INVALID_API_KEYS when the pair does not
 * belong to the environment it was sent to, which is the mistake this exists
 * to stop before the Worker is changed. No value is ever echoed: messages are
 * built only from the environment name and Plaid's bounded error code.
 */
export async function validatePlaidApplicationKeys({
  environment,
  clientId,
  secret,
  countryCodes = ["US"],
  fetchImpl = fetch,
  timeoutMs = VALIDATION_TIMEOUT_MS,
} = {}) {
  const apiBase = Object.hasOwn(PLAID_PROFILE.apiBases, String(environment))
    ? PLAID_PROFILE.apiBases[environment]
    : null;
  if (!apiBase) {
    throw new Error(
      "corpora.bank_feed.environment must be sandbox or production before Plaid keys can be checked. " +
        "No bank secret was written.",
    );
  }
  const countries = Array.isArray(countryCodes) &&
    countryCodes.length > 0 && countryCodes.every((code) => /^[A-Z]{2}$/.test(String(code)))
    ? countryCodes.map(String)
    : ["US"];
  const unreachable = () => new Error(
    `Plaid could not be reached to check these keys for the ${environment} environment, so nothing ` +
      "was written. Check this computer's internet connection and run the same command again.",
  );
  // One deadline covers the headers and the body. A reply that stalls after
  // its headers must not leave the owner at a hung prompt.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let body = null;
  try {
    response = await fetchImpl(`${apiBase}/institutions/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId, secret, count: 1, offset: 0, country_codes: countries,
      }),
      redirect: "error",
      signal: controller.signal,
    });
    body = await Promise.race([
      response.json().catch(() => null),
      new Promise((resolve) => {
        if (controller.signal.aborted) resolve(null);
        controller.signal.addEventListener("abort", () => resolve(null), { once: true });
      }),
    ]);
  } catch {
    throw unreachable();
  } finally {
    clearTimeout(timer);
  }
  if (controller.signal.aborted) throw unreachable();
  if (response.ok && Array.isArray(body?.institutions)) return Object.freeze({ environment, accepted: true });
  const code = typeof body?.error_code === "string" ? body.error_code.replace(/[^A-Z0-9_]/g, "").slice(0, 60) : "";
  if (code === "INVALID_API_KEYS") {
    throw new Error(
      `Plaid rejected this client_id and secret for the ${environment} environment. The likely cause: ` +
        "the secret is for a different Plaid environment (sandbox or production). " +
        `Copy the ${environment} secret from the owner's Plaid dashboard (Developers, Keys) and run the ` +
        "same command again. Nothing was written.",
    );
  }
  throw new Error(
    `Plaid did not confirm these keys for the ${environment} environment ` +
      `(${code ? `reference code ${code}` : `HTTP ${Number(response.status) || "unknown"}`}). Nothing was written. ` +
      "Run the same command again, and check both keys on the Plaid dashboard if it repeats.",
  );
}

/**
 * Verify the deploy-owned wrapping key and make sure the Plaid pair exists on
 * the Worker, prompting the owner only when that pair is missing or when
 * `replaceKeys` is set.
 *
 * `listSecretNames()` resolves to the Worker's secret names (read-only).
 * `putSecret(name, text)` writes one secret_text binding.
 * `readSecret(prompt)` reads one hidden value from the owner's terminal.
 * `validateKeys({ clientId, secret })` proves the typed pair with the provider
 * and throws a plain refusal; it is required whenever a pair is typed.
 */
export async function ensureBankFeedWorkerSecrets({
  env = {},
  listSecretNames,
  putSecret,
  readSecret,
  validateKeys,
  environment = null,
  replaceKeys = false,
  report = () => {},
} = {}) {
  // Presence, not validity, is the unsafe condition, so no value is inspected
  // or echoed and no network call has happened yet.
  const ambient = BANK_FEED_OWNER_SECRET_NAMES.filter((name) => Object.hasOwn(env, name));
  if (ambient.length) {
    throw new Error(
      `${ambient.join(", ")} ${ambient.length === 1 ? "is" : "are"} not accepted from environment ` +
        "variables. `brain connect bank` asks the owner for the Plaid keys at a hidden prompt. " +
        "Unset the bank variable(s) and rerun. No local or Worker secret was changed.",
    );
  }

  const present = namesFromInventory(await listSecretNames());
  const absent = BANK_FEED_OWNER_SECRET_NAMES.filter((name) => !present.has(name));
  if (!present.has(BANK_ACCESS_WRAPPING_KEY_SECRET)) {
    throw new Error(
      `this Worker has no ${BANK_ACCESS_WRAPPING_KEY_SECRET}. Run \`brain setup <manifest>\`, ` +
        "`brain update <manifest>`, or `brain deploy <manifest>` to create and verify it, then " +
        "rerun `brain connect bank`. Nothing was prompted or written.",
    );
  }
  if (replaceKeys !== true && !absent.length) {
    return Object.freeze({ written: Object.freeze([]), names: BANK_FEED_OWNER_SECRET_NAMES, replaced: false });
  }

  // The client ID and secret are one pair from one Plaid environment. If either
  // is missing, ask for both so a stale half can never be paired with a new one.
  const needsProvider = replaceKeys === true ||
    BANK_FEED_PROVIDER_SECRET_NAMES.some((name) => !present.has(name));
  const writes = [];
  if (needsProvider) {
    report(
      "Your Brain needs your two Plaid keys: the client_id, then the Sandbox or Production secret. " +
      "They are saved to your Brain, not to this computer.",
    );
    const pair = [];
    for (const name of BANK_FEED_PROVIDER_SECRET_NAMES) {
      pair.push([name, normalizeProviderValue(name, await readSecret(promptFor(name, environment)))]);
    }
    if (pair[0][1] === pair[1][1]) {
      throw new Error(
        "the Plaid client_id and secret were entered as the same value. No bank secret was written.",
      );
    }
    if (typeof validateKeys !== "function") {
      throw new Error("the Plaid keys cannot be checked before they are saved. No bank secret was written.");
    }
    // Refusals here are already plain sentences that repeat no typed value.
    await validateKeys({ clientId: pair[0][1], secret: pair[1][1] });
    writes.push(...pair);
  }
  // The writes are sequential PUTs with no rollback. A failure between the client_id and the
  // secret leaves a new client_id paired with the old secret. That fails loudly: the next
  // connection is refused as INVALID_API_KEYS, and its message names --replace-keys, which
  // rewrites both keys.
  for (const [name, text] of writes) {
    try {
      await putSecret(name, text);
    } catch (error) {
      const reason = String(error?.message || error);
      const leaked = writes.some(([, value]) => reason.includes(value));
      throw new Error(
        `the Worker secret ${name} could not be written` +
          (leaked ? "." : `: ${reason.slice(0, 200)}`) +
          (replaceKeys === true
            ? " Rerun `brain connect bank <manifest> --replace-keys` to enter both Plaid keys again."
            : " Rerun `brain connect bank`; it rechecks the Worker and asks only for what is still missing."),
      );
    }
  }

  const verified = namesFromInventory(await listSecretNames());
  const unverified = BANK_FEED_OWNER_SECRET_NAMES.filter((name) => !verified.has(name));
  if (unverified.length) {
    throw new Error(
      `Cloudflare did not list ${unverified.join(", ")} after the write. Do not start Plaid Link. ` +
        "Rerun `brain connect bank`.",
    );
  }
  const written = Object.freeze(writes.map(([name]) => name));
  return Object.freeze({ written, names: BANK_FEED_OWNER_SECRET_NAMES, replaced: replaceKeys === true });
}
