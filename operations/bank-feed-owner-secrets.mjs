/**
 * Owner-present Plaid application-credential custody for `brain connect bank`.
 *
 * The owner types their own Plaid client ID and secret at a hidden prompt, and
 * this module writes them, with a freshly generated wrapping key, straight onto
 * the owner's Worker. Nothing is read from the environment, a flag, the
 * manifest, or a file, and nothing but secret NAMES is ever reported back.
 *
 * Four invariants are enforced here rather than trusted to the caller:
 *
 * - An ambient bank value is refused before any Cloudflare read. The same
 *   refusal `brain secrets` makes: a value in a shell is a value in history.
 * - An existing BANK_FEED_WRAPPING_KEY_V2 is never replaced. Disabling the feed
 *   deletes the provider pair but deliberately keeps the wrapping key, because
 *   retained encrypted access references can only be recovered with it. A
 *   re-enable that regenerated it would silently orphan them. `--replace-keys`
 *   touches only the provider pair for the same reason.
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
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
  } catch {
    throw new Error(
      `Plaid could not be reached to check these keys for the ${environment} environment, so nothing ` +
        "was written. Check this computer's internet connection and run the same command again.",
    );
  } finally {
    clearTimeout(timer);
  }
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (response.ok && Array.isArray(body?.institutions)) return Object.freeze({ environment, accepted: true });
  const code = typeof body?.error_code === "string" ? body.error_code.replace(/[^A-Z0-9_]/g, "").slice(0, 60) : "";
  if (code === "INVALID_API_KEYS") {
    throw new Error(
      `Plaid rejected this client_id and secret for the ${environment} environment. The likely cause: ` +
        "the secret is for a different Plaid environment (sandbox, development or production). " +
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
 * Make sure all three bank secret names exist on the Worker, prompting the
 * owner only for what is actually missing, or for the whole Plaid pair when
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
  generateWrappingKey = generateBankAccessWrappingKey,
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
  if (replaceKeys === true && !present.has(BANK_ACCESS_WRAPPING_KEY_SECRET)) {
    throw new Error(
      `--replace-keys changes only the Plaid client_id and secret, and this Worker has no ` +
        `${BANK_ACCESS_WRAPPING_KEY_SECRET} yet. Run \`brain connect bank <manifest>\` without ` +
        "--replace-keys to finish the first setup. Nothing was prompted or written.",
    );
  }
  if (replaceKeys !== true && !absent.length) {
    return Object.freeze({ written: Object.freeze([]), names: BANK_FEED_OWNER_SECRET_NAMES, replaced: false });
  }

  // The client ID and secret are one pair from one Plaid environment. If either
  // is missing, ask for both so a stale half can never be paired with a new one.
  const needsProvider = replaceKeys === true ||
    BANK_FEED_PROVIDER_SECRET_NAMES.some((name) => !present.has(name));
  const needsWrappingKey = replaceKeys !== true && !present.has(BANK_ACCESS_WRAPPING_KEY_SECRET);
  const writes = [];
  if (needsProvider) {
    report(replaceKeys === true
      ? `replacing ${BANK_FEED_PROVIDER_SECRET_NAMES.join(" and ")} on the Worker. Enter both Plaid keys ` +
        `from the owner's own dashboard${environment ? ` for the ${environment} environment` : ""}. ` +
        `${BANK_ACCESS_WRAPPING_KEY_SECRET} is kept as it is.`
      : `missing on the Worker: ${absent.join(", ")}. Enter the Plaid keys from the owner's own dashboard` +
        `${environment ? ` for the ${environment} environment` : ""}.`);
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
  if (needsWrappingKey) writes.push([BANK_ACCESS_WRAPPING_KEY_SECRET, generateWrappingKey()]);

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
