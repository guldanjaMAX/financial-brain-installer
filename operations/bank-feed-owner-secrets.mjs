/**
 * Owner-present Plaid application-credential custody for `brain connect bank`.
 *
 * The owner types their own Plaid client ID and secret at a hidden prompt, and
 * this module writes them, with a freshly generated wrapping key, straight onto
 * the owner's Worker. Nothing is read from the environment, a flag, the
 * manifest, or a file, and nothing but secret NAMES is ever reported back.
 *
 * Three invariants are enforced here rather than trusted to the caller:
 *
 * - An ambient bank value is refused before any Cloudflare read. The same
 *   refusal `brain secrets` makes: a value in a shell is a value in history.
 * - An existing BANK_FEED_WRAPPING_KEY_V2 is never replaced. Disabling the feed
 *   deletes the provider pair but deliberately keeps the wrapping key, because
 *   retained encrypted access references can only be recovered with it. A
 *   re-enable that regenerated it would silently orphan them.
 * - Success is the re-listed Worker inventory, not the PUT responses.
 */
import {
  BANK_ACCESS_WRAPPING_KEY_SECRET,
  generateBankAccessWrappingKey,
} from "./bank-access-wrapping-key.mjs";

export const BANK_FEED_PROVIDER_SECRET_NAMES = Object.freeze([
  "BANK_FEED_CLIENT_ID",
  "BANK_FEED_SECRET",
]);

export const BANK_FEED_OWNER_SECRET_NAMES = Object.freeze([
  ...BANK_FEED_PROVIDER_SECRET_NAMES,
  BANK_ACCESS_WRAPPING_KEY_SECRET,
]);

const PROMPTS = Object.freeze({
  BANK_FEED_CLIENT_ID: "  Plaid client_id for this environment (hidden): ",
  BANK_FEED_SECRET: "  Plaid secret for this environment (hidden): ",
});

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
 * Make sure all three bank secret names exist on the Worker, prompting the
 * owner only for what is actually missing.
 *
 * `listSecretNames()` resolves to the Worker's secret names (read-only).
 * `putSecret(name, text)` writes one secret_text binding.
 * `readSecret(prompt)` reads one hidden value from the owner's terminal.
 */
export async function ensureBankFeedWorkerSecrets({
  env = {},
  listSecretNames,
  putSecret,
  readSecret,
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
  if (!absent.length) {
    return Object.freeze({ written: Object.freeze([]), names: BANK_FEED_OWNER_SECRET_NAMES });
  }

  // The client ID and secret are one pair from one Plaid environment. If either
  // is missing, ask for both so a stale half can never be paired with a new one.
  const needsProvider = BANK_FEED_PROVIDER_SECRET_NAMES.some((name) => !present.has(name));
  const needsWrappingKey = !present.has(BANK_ACCESS_WRAPPING_KEY_SECRET);
  const writes = [];
  if (needsProvider) {
    report(`missing on the Worker: ${absent.join(", ")}. Enter the Plaid keys from the owner's own dashboard.`);
    for (const name of BANK_FEED_PROVIDER_SECRET_NAMES) {
      writes.push([name, normalizeProviderValue(name, await readSecret(PROMPTS[name]))]);
    }
    if (writes[0][1] === writes[1][1]) {
      throw new Error(
        "the Plaid client_id and secret were entered as the same value. No bank secret was written.",
      );
    }
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
          " Rerun `brain connect bank`; it rechecks the Worker and asks only for what is still missing.",
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
  return Object.freeze({ written, names: BANK_FEED_OWNER_SECRET_NAMES });
}
