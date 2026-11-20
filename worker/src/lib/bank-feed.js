/**
 * bank-feed — a hosted, read-only bank connection, running inside the CLIENT's
 * own worker and writing into the client's own ledger.
 *
 * WHAT THIS IS, IN THE OWNER'S WORDS
 *
 * The account holder connects their own bank, themselves, in their own browser.
 * The bank login happens on the bank's own site or on the aggregator's hosted
 * screen. No password, no one-time code, no security question and no bank
 * credential of any kind is ever seen, requested, handled or stored by the
 * operator, by this code, or by anyone but the account holder and their bank.
 * What comes back is a read-only reference for FETCHING transaction history. It
 * cannot move money, and it lives encrypted in the client's own database inside
 * the client's own cloud account.
 *
 * The read-only guarantee is not enforced by this code being careful. It is
 * enforced at authorisation time by never requesting a product that can move
 * money — see `REQUESTED_PRODUCTS` and `FORBIDDEN_PRODUCTS`, which a test
 * asserts against literally so a future "just add one more scope" cannot land
 * unreviewed.
 *
 * WHY EVERY IDENTIFIER COMES FROM `env`
 *
 * The two service identifiers are read from the environment, never from a
 * module constant, and the aggregator's own hostname with them. That is what
 * keeps the deployment model reversible: per-client credentials (recommended:
 * one client's blast radius is one client) and a shared operator account differ
 * only in what values are set, not in what code runs. The tenant reference is
 * confined to `tenantReference()` for the same reason — under per-client it is
 * cosmetic, under shared it is load-bearing, and there is exactly one place to
 * change it.
 *
 * THE SIGN CONVENTION — read this before touching an amount.
 *
 * This provider reports a POSITIVE number when money LEAVES the account, and a
 * negative one when money arrives. That is the opposite of a downloaded OFX
 * file, where a negative amount is money leaving. Both are normalised at the
 * one write boundary (`fin-import.js`) into an unsigned amount plus an explicit
 * direction, and the signed source figure travels with it. Getting this
 * backwards turns income into spending and a profit into a loss while every
 * citation still resolves, which is the most expensive mistake available here.
 */

import { jsonResponse, privateNoStore, validateAdminKey } from "./core.js";
import { FAVICON } from "./app-page.js";
import { OWNER_PAGE_CSS } from "./owner-page-style.js";
import { acceptsOwnerHtml, ownerMessageResponse } from "./owner-message-response.js";
import { ownerNavigationPrincipal, ownerSessionPrincipal } from "./owner-auth.js";
import { importBankExport, balanceRoleFor } from "./fin-import.js";
import { bankFeedProfile } from "./bank-feed-profiles.js";
import {
  assignPlaidAccountEntity,
  PlaidAccountEntityError,
  plaidOwnerAccountStatus,
  reassignPlaidAccountEntity,
} from "./plaid-account-entities.js";

/**
 * THE HOSTED FEED'S SIGN CONVENTION, WRITTEN DOWN ONCE.
 *
 *     amount is POSITIVE  ->  money LEAVES the account  ->  outflow
 *     amount is NEGATIVE  ->  money ARRIVES             ->  inflow
 *
 * Pinned by `worker/test/bank-feed.test.mjs`. Inverting the two lines in
 * `directionFor()` below makes that test fail by name.
 */
export const BANK_FEED_SIGN_CONVENTION = "feed_positive_amount_is_outflow";

/** THE CONVENTION, APPLIED. The only place a feed amount becomes a direction. */
export function directionFor(amount) {
  return amount > 0 ? "outflow" : "inflow";
}

/**
 * The only products this brain ever asks for. `transactions` is read-only: it
 * has no capability to move money, and none of the products that do is here.
 */
export const REQUESTED_PRODUCTS = Object.freeze(["transactions"]);

/**
 * Never request these. The first three can initiate money movement. The fourth
 * returns full account and routing numbers: still read-only, but it converts
 * this database into a store of directly actionable payment details and changes
 * the consequence of a breach entirely. If a stated requirement ever needs one,
 * it needs a decision record, not a diff.
 */
export const FORBIDDEN_PRODUCTS = Object.freeze([
  "transfer", "payment_initiation", "standing_orders", "auth",
]);

/** Two years, the same depth the reference implementation requested. */
export const BACKFILL_DAYS = 730;

/** Pages per invocation. Bounded so a long load resumes instead of restarting. */
export const MAX_PAGES_PER_SLICE = 4;
const PAGE_SIZE = 250;
const CALL_TIMEOUT_MS = 20_000;
export const BANK_FEED_ITEM_ENTITY_MAP_VERSION = 1;
const ENTITY_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/* ------------------------------------------------------------ configuration */

class FeedConfigError extends Error {}

/**
 * Resolve only an explicit, owner-reviewed mapping for this exact connection.
 * A single global entity is unsafe when one owner connects personal and
 * business accounts, so the former BANK_FEED_ENTITY binding is deliberately
 * ignored. Account-level assignment is supported by the Plaid profile; this
 * compatibility connector remains paused unless this per-item P0 contract is
 * present.
 */
export function reviewedBankFeedEntityForItem(env, itemRef) {
  const raw = env?.BANK_FEED_REVIEWED_ITEM_ENTITIES;
  let contract;
  try {
    contract = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!contract || typeof contract !== "object" || Array.isArray(contract) ||
      contract.version !== BANK_FEED_ITEM_ENTITY_MAP_VERSION ||
      !contract.items || typeof contract.items !== "object" || Array.isArray(contract.items) ||
      Object.keys(contract).some((key) => !["version", "items"].includes(key))) return null;
  const entry = contract.items[String(itemRef || "")];
  if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
      Object.keys(entry).some((key) => !["entity_slug", "reviewed_at", "reviewed_by"].includes(key)) ||
      !ENTITY_SLUG.test(String(entry.entity_slug || "")) || entry.reviewed_by !== "owner" ||
      typeof entry.reviewed_at !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(entry.reviewed_at) ||
      !Number.isFinite(Date.parse(entry.reviewed_at))) return null;
  return {
    entity_slug: entry.entity_slug,
    reviewed_at: entry.reviewed_at,
    reviewed_by: "owner",
  };
}

/**
 * Everything this connector needs, read from the environment.
 *
 * There is no default host and no default credential anywhere in this file on
 * purpose: a missing configuration must fail loudly at the operator, not
 * silently reach somebody else's endpoint.
 */
export function bankFeedConfig(env) {
  const clientId = env.BANK_FEED_CLIENT_ID;
  const secret = env.BANK_FEED_SECRET;
  const environment = env.BANK_FEED_ENV === "production" ? "production" : "sandbox";
  const profile = bankFeedProfile(env, environment);
  const apiBase = profile.apiBase;
  if (profile.provider === "simplefin") {
    if (!bankAccessWrappingKeyConfigured(env)) {
      throw new FeedConfigError(
        `the bank feed is not configured on this brain (${BANK_ACCESS_WRAPPING_KEY_SECRET} not set). ` +
        "Run the reviewed bank connection setup first.",
      );
    }
    return {
      clientId: null,
      secret: null,
      environment: "production",
      provider: "simplefin",
      apiBase: null,
      linkSdkUrl: null,
      linkGlobal: null,
      displayName: env.BANK_FEED_DISPLAY_NAME || env.BRAIN_NAME || "this brain",
      countryCodes: [],
    };
  }
  const missing = [
    !clientId && "BANK_FEED_CLIENT_ID",
    !secret && "BANK_FEED_SECRET",
    !apiBase && "BANK_FEED_API_BASE",
    !bankAccessWrappingKeyConfigured(env) && BANK_ACCESS_WRAPPING_KEY_SECRET,
  ].filter(Boolean);
  if (missing.length) {
    throw new FeedConfigError(
      `the bank feed is not configured on this brain (${missing.join(", ")} not set). ` +
      "Run `brain connect bank <manifest>` to finish bank connection setup.",
    );
  }
  let base;
  try { base = new URL(apiBase); } catch {
    throw new FeedConfigError("BANK_FEED_API_BASE is not a valid URL");
  }
  if (base.protocol !== "https:") {
    throw new FeedConfigError("BANK_FEED_API_BASE must be https");
  }
  let linkSdkUrl = null;
  if (profile.linkSdkUrl) {
    let parsedSdk;
    try { parsedSdk = new URL(profile.linkSdkUrl); } catch {
      throw new FeedConfigError("BANK_FEED_LINK_SDK_URL is not a valid URL");
    }
    if (parsedSdk.protocol !== "https:") {
      throw new FeedConfigError("BANK_FEED_LINK_SDK_URL must be https");
    }
    linkSdkUrl = parsedSdk.href;
  }
  return {
    clientId, secret, environment,
    provider: profile.provider,
    apiBase: base.origin,
    linkSdkUrl,
    // The browser global the provider's SDK installs. Configured, never
    // hard-coded, for the same reason the host is: a change of aggregator
    // should be a manifest edit and not a code change in every install.
    linkGlobal: profile.linkGlobal,
    displayName: env.BANK_FEED_DISPLAY_NAME || env.BRAIN_NAME || "this brain",
    countryCodes: String(env.BANK_FEED_COUNTRIES || "US").split(",").map((c) => c.trim()).filter(Boolean),
  };
}

export function bankFeedEnabled(env) {
  const environment = env.BANK_FEED_ENV === "production" ? "production" : "sandbox";
  const profile = bankFeedProfile(env, environment);
  if (profile.provider === "simplefin") return bankAccessWrappingKeyConfigured(env);
  return Boolean(
    env.BANK_FEED_CLIENT_ID &&
    env.BANK_FEED_SECRET &&
    profile.apiBase &&
    bankAccessWrappingKeyConfigured(env)
  );
}

/**
 * THE TENANT REFERENCE, IN ONE FUNCTION.
 *
 * `tenantId` scopes every ledger row. `endUserRef` is what the aggregator files
 * this authorisation under. Under the recommended per-client deployment both
 * are effectively cosmetic, because isolation comes from separate accounts and
 * separate databases. Under a shared operator account `endUserRef` becomes the
 * key that keeps two clients' bank data apart, and this is the one function
 * that would change. Keeping it here is what makes that decision reversible
 * instead of a rewrite.
 *
 * It is derived from the install's own slug and never from a person's name.
 */
export function tenantReference(env) {
  const tenantId = String(env.BANK_FEED_TENANT || "primary");
  const slug = String(env.BRAIN_NAME || "brain").toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 60);
  return { tenantId, endUserRef: `install:${slug || "brain"}` };
}

/**
 * The scope key for everything this connection writes into the ledger.
 * One equality match removes it all, the same property `sources.name` gives the
 * document corpus.
 */
export function feedScopeKey(itemRef) {
  return `bank-feed:${itemRef}`;
}

/**
 * The address the bank returns the browser to.
 *
 * This must be REGISTERED WITH THE PROVIDER, per host, before it will work, and
 * every brain has its own hostname. That is why `brain doctor` checks it: the
 * alternative is finding out while a client is sitting there mid-login.
 */
export function redirectUriFor(url) {
  return `${new URL(url).origin}/app/connect/bank`;
}

/* ------------------------------------------------------------ the transport */

class FeedError extends Error {
  constructor(message, code = null, status = null) {
    super(message);
    this.name = "FeedError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Anything that could carry a secret, removed before a message is stored,
 * logged, or shown.
 *
 * The provider attaches its full request context to some errors, and the
 * reference implementation put `String(e.message)` straight into an API
 * response. That is how an access reference ends up in a support ticket. This
 * strips UUID-shaped values and long opaque tokens, and it is applied on EVERY
 * path out of this module, not only the ones that look risky.
 */
export function redactFeedText(text) {
  return String(text || "")
    .replace(/access-(?:production|sandbox|development)-[0-9a-f-]{8,}/gi, "[redacted access reference]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[redacted identifier]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]")
    .slice(0, 300);
}

/** A message safe to show a person, derived from any thrown thing. */
export function safeFeedError(error) {
  if (error instanceof FeedConfigError) return error.message;
  if (bankFeedRefusalReason(error) === "invalid_api_keys") {
    return "Plaid did not accept the keys saved on this Brain for its Plaid environment (INVALID_API_KEYS). " +
      "Re-enter both keys with brain connect bank <manifest> --replace-keys";
  }
  const code = error?.code ? ` (${String(error.code).slice(0, 60)})` : "";
  return `the bank feed could not be reached${code}: ${redactFeedText(error?.message)}`;
}

/**
 * The two provider refusals an owner or installer can fix themselves, named by
 * a fixed reason. Plaid answers INVALID_API_KEYS when the client_id and secret
 * do not belong to the environment being called, and INVALID_FIELD naming the
 * redirect URI when the page address is not on the dashboard's allowed list.
 * Only the reason leaves this function, never provider text.
 */
export function bankFeedRefusalReason(error) {
  const code = String(error?.code || "");
  if (code === "INVALID_API_KEYS") return "invalid_api_keys";
  if (code === "INVALID_FIELD" && /redirect/i.test(String(error?.message || ""))) return "redirect_uri_not_allowed";
  return null;
}

/** Owner-facing recovery must preserve a provider's no-retry boundary. */
export function bankFeedOwnerErrorMessage(data, status) {
  const code = data && typeof data.code === "string" ? data.code : null;
  if (data?.outcome_unknown === true && data?.retry_safe === false) {
    const base = "The provider may have accepted this one-time step, but its result could not be confirmed. Keep this page open and ask a technician to review this connection before starting another one or retrying.";
    return code ? `${base} Reference code: ${code}.` : base;
  }
  // Both refusals below happen before Plaid opens, so nothing was connected or
  // changed, and repeating the same click cannot succeed until the cause is fixed.
  if (code === "INVALID_API_KEYS" || data?.reason === "invalid_api_keys") {
    const environment = data && typeof data.environment === "string" ? `${data.environment} ` : "";
    const base = `Plaid did not accept the keys saved on this Brain for its ${environment}environment, so the connection could not start. Nothing was changed. The keys probably belong to a different Plaid environment. From a terminal, re-enter both keys with: brain connect bank <your manifest file> --replace-keys. Then return to this page.`;
    return `${base} Reference code: ${code || "INVALID_API_KEYS"}.`;
  }
  if (data?.reason === "redirect_uri_not_allowed") {
    const address = data && typeof data.redirect_uri === "string" ? data.redirect_uri : "this page's address";
    const base = `This page's address is not on the Allowed redirect URIs list in your Plaid dashboard, so Plaid would not open. Nothing was changed. In the Plaid dashboard for this environment, add exactly ${address} under Developers, API, Allowed redirect URIs. Then select Connect a bank again.`;
    return `${base} Reference code: ${code || "INVALID_FIELD"}.`;
  }
  const messages = {
    session_required: "Your sign-in has ended. Return to your Brain, sign in, and open this page again.",
    owner_required: "This page is available only to the Brain owner.",
    plaid_account_inventory_unavailable: "The bank is connected, but its account list is still arriving. Wait a moment and check again.",
    bank_account_status_unavailable: "We could not safely read the account list. Your connection is unchanged. Please check again.",
    bank_account_assignment_unavailable: "We could not safely save that choice. Nothing was moved. Please try the same choice again.",
    bank_account_reassignment_requires_review: "This account already has financial history under another business. A technician should review it before anything moves.",
    bank_account_reassignment_scope_changed: "The account owner changed since this move was reviewed. Refresh the account list and review it again.",
    bank_account_reassignment_period_closed: "A closed financial period protects one of these owners. Nothing was moved.",
    bank_account_reassignment_reconciled: "This account has a saved reconciliation that must be reviewed before its owner can change.",
    bank_account_reassignment_unavailable: "We could not safely finish that reviewed move. Nothing was moved. Retry the same request.",
    entity_not_found: "That business is no longer available. Refresh the list and choose an active business.",
    entity_not_owned: "That business is not owner-controlled, so the account was not assigned to it.",
    request_id_conflict: "This saved retry belongs to a different choice. Refresh the page and try again.",
    plaid_duplicate_connection_review: "This bank may already be connected. Review the saved connections before adding another copy. If no connection is listed or these are separate accounts, contact support to review the overlap. We have not added another copy.",
    plaid_reconnect_support_required: "This disconnected bank has saved history or prior sync progress. Contact support before reconnecting it so that history is not counted twice. No replacement connection was added, and your saved history is unchanged.",
    plaid_connection_in_progress: "Another bank connection is still finishing. Check its result before starting another connection. Your saved accounts are unchanged.",
    plaid_link_handoff_rejected: "That connection link is no longer usable. Your existing accounts are unchanged. Select Connect a bank to start again.",
    LINK_SESSION_STALE: "This saved bank connection session is no longer usable. Select Connect a bank to start the connection again.",
    BANK_WRITES_PAUSED: "Your Brain is finishing a verified update. Your bank connections and saved choices are safe. Please return to this step after the update finishes.",
    BANK_PROVIDER_TRANSITION_FENCED: "Your Brain is finishing a reviewed bank-provider change. No bank connection or saved financial history was changed. Please return after deployment finishes.",
  };
  const base = (code && messages[code]) || (status === 503
    ? "This step is temporarily unavailable. Your earlier progress is safe. Please try again."
    : "That step did not finish. Your earlier progress is safe. Please try again.");
  if (code) return `${base} Reference code: ${code}.`;
  // The route supplies safeFeedError output, never the raw provider response.
  const detail = typeof data?.error === "string" ? data.error.trim().slice(0, 300) : "";
  return detail
    ? `${base} Details: ${detail} Reference code: BANK_FEED_REQUEST_FAILED.`
    : base;
}

/**
 * One call to the provider.
 *
 * Timed out, because a hung fetch inside a scheduled invocation costs the whole
 * slice. The credentials are attached here and only here; no caller ever holds
 * them, and no error raised here carries the request body.
 */
async function callFeed(env, path, body, { fetchImpl = fetch, timeoutMs = CALL_TIMEOUT_MS } = {}) {
  const config = bankFeedConfig(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${config.apiBase}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ client_id: config.clientId, secret: config.secret, ...body }),
    });
  } catch (error) {
    throw new FeedError(
      error?.name === "AbortError" ? "the request timed out" : redactFeedText(error?.message),
      "TRANSPORT",
    );
  } finally {
    clearTimeout(timer);
  }
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    // Deliberately NOT the provider's whole error object. The code is what a
    // person or a state machine can act on; the rest is a leak surface.
    throw new FeedError(
      redactFeedText(payload?.error_message || `request failed with status ${response.status}`),
      payload?.error_code || null,
      response.status,
    );
  }
  return payload || {};
}

/* -------------------------------------------------- access reference custody */

/**
 * Version 1 is the released legacy contract. It derived the encryption key
 * from SESSION_SIGNING_KEY (or ADMIN_KEY), so restoring or rotating either
 * secret could strand an otherwise valid bank connection.
 *
 * Version 2 is intentionally a different Worker secret with a version in its
 * name and value. It must be copied or rewrapped deliberately during recovery;
 * session and admin signing material are never accepted as a substitute.
 */
export const LEGACY_BANK_ACCESS_KEY_VERSION = 1;
export const BANK_ACCESS_WRAPPING_KEY_VERSION = 2;
export const BANK_ACCESS_WRAPPING_KEY_SECRET = (["BANK_FEE","D_WRAPPI","NG_KEY_V","2"].join(""));

const BANK_ACCESS_REAUTH_DETAIL =
  "This bank connection's protected access reference cannot be opened with the current wrapping key. " +
  "The account holder must connect it again before new activity can be read.";

class BankAccessKeyError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "BankAccessKeyError";
    this.code = code;
  }
}

function bytes(text) { return new TextEncoder().encode(String(text)); }

function toBase64(buffer) {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(String(text));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function fromBase64Url(text) {
  const normalized = String(text).replace(/-/g, "+").replace(/_/g, "/");
  return fromBase64(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
}

/**
 * The encryption key, derived rather than stored.
 *
 * Derived from a worker secret the database does not contain, so a copy of the
 * database is not a copy of the bank connections. Fails closed: no key material
 * means no storage, never plaintext storage.
 */
async function legacyAccessKey(env) {
  const material = env.SESSION_SIGNING_KEY || env.ADMIN_KEY;
  if (!material) {
    throw new BankAccessKeyError(
      "the legacy bank access-reference key is unavailable",
      "BANK_ACCESS_LEGACY_KEY_UNAVAILABLE",
    );
  }
  const base = await crypto.subtle.importKey("raw", bytes(material), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: bytes("brain.bank-feed.v1"), info: bytes("access-reference") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function wrappingKeyBytes(env) {
  const value = env?.[BANK_ACCESS_WRAPPING_KEY_SECRET];
  if (typeof value !== "string" || !/^v2\.[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new BankAccessKeyError(
      `${BANK_ACCESS_WRAPPING_KEY_SECRET} is missing or invalid; run the reviewed bank-key ceremony before storing a connection`,
      "BANK_ACCESS_WRAPPING_KEY_UNAVAILABLE",
    );
  }
  const decoded = fromBase64Url(value.slice(3));
  if (decoded.length !== 32) {
    throw new BankAccessKeyError(
      `${BANK_ACCESS_WRAPPING_KEY_SECRET} is invalid`,
      "BANK_ACCESS_WRAPPING_KEY_INVALID",
    );
  }
  return decoded;
}

async function dedicatedAccessKey(env) {
  const base = await crypto.subtle.importKey(
    "raw", wrappingKeyBytes(env), "HKDF", false, ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: bytes("brain.bank-feed.wrapping.v2"),
      info: bytes("access-reference-aes-gcm-v2"),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function accessKey(env, keyVersion) {
  if (Number(keyVersion) === LEGACY_BANK_ACCESS_KEY_VERSION) return legacyAccessKey(env);
  if (Number(keyVersion) === BANK_ACCESS_WRAPPING_KEY_VERSION) return dedicatedAccessKey(env);
  throw new BankAccessKeyError(
    "the bank access reference uses an unsupported wrapping-key version",
    "BANK_ACCESS_WRAPPING_KEY_VERSION_UNSUPPORTED",
  );
}

export function bankAccessWrappingKeyConfigured(env) {
  try {
    wrappingKeyBytes(env);
    return true;
  } catch {
    return false;
  }
}

function hex(bytesValue) {
  return Array.from(new Uint8Array(bytesValue), (value) => value.toString(16).padStart(2, "0")).join("");
}

/**
 * Return a non-secret equality proof for recovery. The wrapping key is a full
 * random 256-bit value, so its SHA-256 fingerprint lets a disposable target
 * prove exact custody without returning the key or accepting it in a request.
 */
export async function bankAccessWrappingKeyProof(env) {
  if (!bankAccessWrappingKeyConfigured(env)) {
    return {
      configured: false,
      key_version: BANK_ACCESS_WRAPPING_KEY_VERSION,
      key_fingerprint: null,
    };
  }
  const material = wrappingKeyBytes(env);
  try {
    return {
      configured: true,
      key_version: BANK_ACCESS_WRAPPING_KEY_VERSION,
      key_fingerprint: hex(await crypto.subtle.digest("SHA-256", material)),
    };
  } finally {
    material.fill(0);
  }
}

export async function encryptAccessReference(
  env,
  reference,
  { keyVersion = BANK_ACCESS_WRAPPING_KEY_VERSION } = {},
) {
  const key = await accessKey(env, keyVersion);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes(reference));
  return { ciphertext: toBase64(sealed), iv: toBase64(iv), keyVersion };
}

export async function decryptAccessReference(env, { ciphertext, iv, keyVersion = null }) {
  const version = keyVersion ?? LEGACY_BANK_ACCESS_KEY_VERSION;
  const key = await accessKey(env, version);
  try {
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(iv) }, key, fromBase64(ciphertext),
    );
    return new TextDecoder().decode(opened);
  } catch (error) {
    if (error instanceof BankAccessKeyError) throw error;
    throw new BankAccessKeyError(
      "the bank access reference cannot be opened with its declared wrapping key",
      "BANK_ACCESS_REFERENCE_UNREADABLE",
    );
  }
}

/* ------------------------------------------------------------ normalisation */

const KIND_BY_TYPE = new Map([
  ["depository:checking", "checking"],
  ["depository:savings", "savings"],
  ["depository:money market", "savings"],
  ["credit:credit card", "card"],
  ["loan:auto", "loan"],
  ["loan:mortgage", "loan"],
  ["loan:student", "loan"],
  ["loan:line of credit", "line_of_credit"],
  ["investment:brokerage", "investment"],
  ["investment:ira", "retirement"],
  ["investment:401k", "retirement"],
]);

/**
 * The provider's account type onto the ledger's account kind.
 *
 * The default is `other`, which the ledger records with a balance role of
 * `neither`. That is the point: an account whose kind is unrecognised must not
 * be counted as cash on the strength of a guess. A loan or a card counted as an
 * asset would inflate a net position by the size of the owner's debts, which is
 * the failure this mapping exists to prevent.
 */
export function accountKindFor(type, subtype) {
  const key = `${String(type || "").toLowerCase()}:${String(subtype || "").toLowerCase()}`;
  if (KIND_BY_TYPE.has(key)) return KIND_BY_TYPE.get(key);
  const base = String(type || "").toLowerCase();
  if (base === "credit") return "card";
  if (base === "loan") return "loan";
  if (base === "depository") return "checking";
  return "other";
}

function minorUnits(amount, currency) {
  if (amount === null || amount === undefined) return null;
  const exponent = currency === "JPY" || currency === "KRW" ? 0 : 2;
  // The provider sends a JSON number. It is converted through its own decimal
  // string, never by multiplying a float, so 12.34 cannot become 1233.
  const text = typeof amount === "number" ? amount.toFixed(exponent) : String(amount);
  const negative = text.trim().startsWith("-");
  const digits = text.replace(/[^0-9.]/g, "");
  const [whole = "0", fraction = ""] = digits.split(".");
  const scaled = Number(`${whole}${fraction.slice(0, exponent).padEnd(exponent, "0")}`);
  if (!Number.isSafeInteger(scaled)) return null;
  return negative ? -scaled : scaled;
}

/**
 * One page of feed data, into the SAME envelope a downloaded file produces.
 *
 * That sameness is deliberate: the ledger write path has one implementation and
 * one place where a sign becomes a direction. A second normaliser here would be
 * a second convention waiting to drift.
 */
export function normaliseFeedPage({ itemRef, accounts = [], added = [], modified = [], now }) {
  const byId = new Map();
  for (const account of accounts) {
    const currency = String(account.balances?.iso_currency_code || "USD").toUpperCase();
    const kind = accountKindFor(account.type, account.subtype);
    byId.set(account.account_id, {
      accountKey: `feed-${itemRef}-${account.account_id}`.replace(/[^a-z0-9_-]/gi, "-").toLowerCase().slice(0, 64),
      institution: null,
      label: account.name || null,
      mask: account.mask ? String(account.mask).replace(/\D/g, "").slice(-4) : null,
      accountKind: kind,
      balanceRole: balanceRoleFor(kind),
      currency,
      externalRef: account.account_id,
      periodStart: null,
      periodEnd: null,
      ledgerBalanceMinor: minorUnits(account.balances?.current, currency),
      availableBalanceMinor: minorUnits(account.balances?.available, currency),
      balanceAsOf: now ? String(now).slice(0, 10) : null,
      transactions: [],
    });
  }

  for (const raw of [...added, ...modified]) {
    const account = byId.get(raw.account_id);
    if (!account) continue;
    const rawMinor = minorUnits(raw.amount, account.currency);
    const postedOn = /^\d{4}-\d{2}-\d{2}$/.test(String(raw.date || "")) ? raw.date : null;
    if (rawMinor === null || postedOn === null) {
      account.transactions.push({
        locator: `feed/${raw.transaction_id || "unknown"}`,
        externalId: raw.transaction_id || null,
        postedOn,
        description: raw.name || null,
        payee: raw.merchant_name || null,
        rawAmountMinor: null,
        amountMinor: null,
        direction: null,
        pending: Boolean(raw.pending),
        unparsedReason: rawMinor === null
          ? "the amount the feed reported could not be read as an exact figure"
          : "the feed reported no usable posting date",
      });
      continue;
    }
    account.transactions.push({
      locator: `feed/${raw.transaction_id || "unknown"}`,
      externalId: raw.transaction_id || null,
      postedOn,
      description: raw.name || null,
      payee: raw.merchant_name || null,
      rawAmountMinor: rawMinor,
      amountMinor: Math.abs(rawMinor),
      direction: directionFor(rawMinor),
      pending: Boolean(raw.pending),
      unparsedReason: null,
    });
  }

  const populated = [...byId.values()];
  for (const account of populated) {
    const dated = account.transactions.map((t) => t.postedOn).filter(Boolean).sort();
    account.periodStart = dated[0] || null;
    account.periodEnd = dated[dated.length - 1] || null;
  }
  return {
    ok: true,
    format: "feed",
    signConvention: BANK_FEED_SIGN_CONVENTION,
    establishedBy: "the provider documents a positive amount as money leaving the account",
    sourceDocUid: null,
    sourceLabel: feedScopeKey(itemRef),
    accounts: populated,
  };
}

const BANK_RECOVERY_PROTOCOL = "bank-security-v1";

function bankRecoveryTime(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new BankAccessKeyError("the recovery security timestamp is invalid", "BANK_RECOVERY_PROOF_INVALID");
  }
  return value;
}

function bankRecoveryCanonical(value) {
  if (Array.isArray(value)) return `[${value.map(bankRecoveryCanonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${bankRecoveryCanonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

const bankRecoveryHash = async (value) => hex(await crypto.subtle.digest(
  "SHA-256", new TextEncoder().encode(bankRecoveryCanonical(value)),
));

/**
 * A bounded, read-only semantic proof of the one allowed recovery transform.
 * Each pair commits the exact original row and its one permitted result. All
 * columns (including identity) are hashed. Readable references normalize only
 * their wrapping bytes. Unreadable legacy rows retain an exact original hash
 * alongside the predetermined reauthorization result, never a wildcard state.
 * Only hashes and positional pagination leave Worker, never row identifiers.
 * The adapter brackets this proof with exact full exports before storing it.
 */
export async function bankRecoverySnapshotPage(env, { offset = 0, reconciliationAt } = {}) {
  const stamp = bankRecoveryTime(reconciliationAt);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 900 || offset % 100 !== 0) {
    throw new BankAccessKeyError("the recovery security cursor is invalid", "BANK_RECOVERY_PROOF_INVALID");
  }
  const rows = (await env.DB.prepare(
    "SELECT * FROM bank_feed_items ORDER BY id LIMIT 101 OFFSET ?",
  ).bind(offset).all())?.results;
  if (!Array.isArray(rows) || rows.length > 101) {
    throw new BankAccessKeyError("the recovery security inventory is unavailable", "BANK_RECOVERY_PROOF_INVALID");
  }
  const proofs = [];
  let previous = 0;
  for (const row of rows.slice(0, 100)) {
    if (!Number.isSafeInteger(row.id) || row.id <= previous) {
      throw new BankAccessKeyError("the recovery security inventory is invalid", "BANK_RECOVERY_PROOF_INVALID");
    }
    previous = row.id;
    const stable = { ...row };
    let allowed = null;
    if (row.removed_at === null) {
      if (![LEGACY_BANK_ACCESS_KEY_VERSION, BANK_ACCESS_WRAPPING_KEY_VERSION].includes(row.key_version)) {
        throw new BankAccessKeyError("the recovery security key version is unsupported", "BANK_RECOVERY_PROOF_INVALID");
      }
      let reference;
      try {
        reference = await decryptAccessReference(env, {
          ciphertext: row.access_ciphertext, iv: row.access_iv, keyVersion: row.key_version,
        });
      } catch {
        if (row.key_version !== LEGACY_BANK_ACCESS_KEY_VERSION) {
          throw new BankAccessKeyError("the protected bank reference cannot be proven", "BANK_RECOVERY_PROOF_INVALID");
        }
        // A legacy row whose released key is unavailable keeps its exact
        // ciphertext/IV. Only these fixed fields may become reauth-required.
        // Existing reauth rows are left entirely exact, including their time.
        if (row.status !== "reauth_required") {
          allowed = { ...stable, status: "reauth_required",
            status_detail: BANK_ACCESS_REAUTH_DETAIL, last_error_at: stamp };
        }
      }
      if (reference !== undefined) {
        stable.access_ciphertext = await bankRecoveryHash({ protocol: BANK_RECOVERY_PROTOCOL, reference });
        stable.access_iv = null;
        // Rewrap is one-way. A v2 baseline must never authorize a downgrade
        // merely because its plaintext still opens with the old signing key.
        if (row.key_version === LEGACY_BANK_ACCESS_KEY_VERSION && row.status !== "reauth_required") {
          allowed = { ...stable, key_version: BANK_ACCESS_WRAPPING_KEY_VERSION };
        }
      }
    }
    const original = await bankRecoveryHash(stable);
    proofs.push([original, allowed ? await bankRecoveryHash(allowed) : original]);
  }
  return {
    protocol: BANK_RECOVERY_PROTOCOL,
    count: proofs.length,
    fingerprint: await bankRecoveryHash({ protocol: BANK_RECOVERY_PROTOCOL, proofs }),
    proofs,
    next_offset: rows.length > 100 ? offset + 100 : null,
  };
}

/* ------------------------------------------------------------------ storage */

async function loadItem(env, tenantId, itemRef) {
  return env.DB.prepare(
    `SELECT item_ref, institution_label, access_ciphertext, access_iv, key_version, environment,
            cursor, status, status_detail, last_synced_at
       FROM bank_feed_items
      WHERE tenant_id = ? AND item_ref = ? AND removed_at IS NULL`,
  ).bind(tenantId, itemRef).first();
}

function accessReferenceState(row, env) {
  if (row?.status === "reauth_required") return "reauthorization_required";
  if (Number(row?.key_version) === LEGACY_BANK_ACCESS_KEY_VERSION) return "legacy_rewrap_required";
  if (Number(row?.key_version) !== BANK_ACCESS_WRAPPING_KEY_VERSION) return "unsupported_key_version";
  return bankAccessWrappingKeyConfigured(env) ? "protected" : "wrapping_key_unavailable";
}

async function recordBankAccessReauthorizationRequired(env, row, now) {
  const result = await env.DB.prepare(
    `UPDATE bank_feed_items
        SET status = 'reauth_required', status_detail = ?, last_error_at = ?
      WHERE tenant_id = ? AND item_ref = ? AND key_version = ?
        AND access_ciphertext = ? AND access_iv = ? AND removed_at IS NULL`,
  ).bind(
    BANK_ACCESS_REAUTH_DETAIL,
    now,
    row.tenant_id,
    row.item_ref,
    row.key_version,
    row.access_ciphertext,
    row.access_iv,
  ).run();
  return Number(result?.meta?.changes || 0) === 1;
}

/**
 * Move released version-1 rows to the dedicated version-2 secret.
 *
 * Each row is compare-and-swap updated and then decrypted from the exact
 * readback. A stop before the write changes nothing; a stop after it resumes
 * by observing key_version=2. If the released derivation is no longer
 * available, the row becomes explicitly reauthorization-required instead of
 * staying "connected" while every scheduled read fails.
 *
 * `mutationBoundary` is a deterministic drill seam. It receives only a fixed
 * stage name and aggregate ordinal, never an item id, ciphertext, or token.
 */
export async function rewrapBankAccessReferences(env, {
  limit = 100,
  now = null,
  mutationBoundary = null,
} = {}) {
  if (!bankAccessWrappingKeyConfigured(env)) {
    throw new BankAccessKeyError(
      `${BANK_ACCESS_WRAPPING_KEY_SECRET} is required before legacy bank access references can be rewrapped`,
      "BANK_ACCESS_WRAPPING_KEY_UNAVAILABLE",
    );
  }
  const bounded = Math.max(1, Math.min(Number(limit) || 100, 100));
  const rows = (await env.DB.prepare(
    `SELECT tenant_id, item_ref, access_ciphertext, access_iv, key_version, status
       FROM bank_feed_items
      WHERE removed_at IS NULL AND key_version = ? AND status <> 'reauth_required'
      ORDER BY id
      LIMIT ?`,
  ).bind(LEGACY_BANK_ACCESS_KEY_VERSION, bounded).all())?.results || [];
  const report = { scanned: rows.length, rewrapped: 0, reauthorization_required: 0, raced: 0 };
  const boundary = async (stage, ordinal) => {
    if (typeof mutationBoundary === "function") await mutationBoundary({ stage, ordinal });
  };
  const stamp = now || new Date().toISOString();

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const ordinal = index + 1;
    let reference;
    try {
      reference = await decryptAccessReference(env, {
        ciphertext: row.access_ciphertext,
        iv: row.access_iv,
        keyVersion: row.key_version,
      });
    } catch {
      await boundary("before_reauthorization_required_write", ordinal);
      const changed = await recordBankAccessReauthorizationRequired(env, row, stamp);
      await boundary("after_reauthorization_required_write", ordinal);
      if (changed) report.reauthorization_required++;
      else report.raced++;
      continue;
    }

    const sealed = await encryptAccessReference(env, reference);
    await boundary("before_rewrap_write", ordinal);
    const write = await env.DB.prepare(
      `UPDATE bank_feed_items
          SET access_ciphertext = ?, access_iv = ?, key_version = ?
        WHERE tenant_id = ? AND item_ref = ? AND key_version = ?
          AND access_ciphertext = ? AND access_iv = ? AND removed_at IS NULL`,
    ).bind(
      sealed.ciphertext,
      sealed.iv,
      sealed.keyVersion,
      row.tenant_id,
      row.item_ref,
      row.key_version,
      row.access_ciphertext,
      row.access_iv,
    ).run();
    await boundary("after_rewrap_write", ordinal);

    if (Number(write?.meta?.changes || 0) !== 1) {
      report.raced++;
      continue;
    }
    const verified = await env.DB.prepare(
      `SELECT access_ciphertext, access_iv, key_version
         FROM bank_feed_items
        WHERE tenant_id = ? AND item_ref = ? AND removed_at IS NULL`,
    ).bind(row.tenant_id, row.item_ref).first();
    if (!verified || Number(verified.key_version) !== BANK_ACCESS_WRAPPING_KEY_VERSION ||
        await decryptAccessReference(env, {
          ciphertext: verified.access_ciphertext,
          iv: verified.access_iv,
          keyVersion: verified.key_version,
        }) !== reference) {
      throw new BankAccessKeyError(
        "a bank access-reference rewrap did not read back exactly",
        "BANK_ACCESS_REWRAP_READBACK_FAILED",
      );
    }
    report.rewrapped++;
  }
  const inventory = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN key_version = ? AND status <> 'reauth_required' THEN 1 ELSE 0 END),0)
         AS legacy_rewrap_required,
       COALESCE(SUM(CASE WHEN key_version = ? AND status <> 'reauth_required' THEN 1 ELSE 0 END),0)
         AS protected,
       COALESCE(SUM(CASE WHEN status = 'reauth_required' THEN 1 ELSE 0 END),0)
         AS reauthorization_required_total,
       COALESCE(SUM(CASE WHEN key_version NOT IN (?,?) THEN 1 ELSE 0 END),0)
         AS unsupported_key_versions
       FROM bank_feed_items WHERE removed_at IS NULL`,
  ).bind(
    LEGACY_BANK_ACCESS_KEY_VERSION,
    BANK_ACCESS_WRAPPING_KEY_VERSION,
    LEGACY_BANK_ACCESS_KEY_VERSION,
    BANK_ACCESS_WRAPPING_KEY_VERSION,
  ).first();
  return {
    ...report,
    legacy_rewrap_required: Number(inventory?.legacy_rewrap_required || 0),
    protected: Number(inventory?.protected || 0),
    reauthorization_required_total: Number(inventory?.reauthorization_required_total || 0),
    unsupported_key_versions: Number(inventory?.unsupported_key_versions || 0),
  };
}

/* ----------------------------------------------------------- authorisation */

/**
 * Start an authorisation the OWNER completes.
 *
 * Returns only the short-lived handoff value the browser needs and the address
 * the bank returns to. Nothing here is a credential, and nothing here is
 * written to the database.
 */
export async function createLinkToken(env, {
  url,
  mode = "connect",
  itemRef = null,
  requestId = null,
  fetchImpl = fetch,
} = {}) {
  const config = bankFeedConfig(env);
  if (config.provider === "plaid") {
    const { createPlaidLinkToken } = await import("./plaid-bank-feed.js");
    return createPlaidLinkToken(env, { url, mode, itemRef, sessionRef: requestId, fetchImpl });
  }
  const { tenantId, endUserRef } = tenantReference(env);
  const redirectUri = redirectUriFor(url);
  const body = {
    user: { client_user_id: endUserRef },
    client_name: config.displayName,
    country_codes: config.countryCodes,
    language: "en",
    redirect_uri: redirectUri,
  };
  if (mode === "reauthorise") {
    if (!itemRef) throw new FeedError("a re-authorisation must name the connection it is repairing", "NO_ITEM");
    const item = await loadItem(env, tenantId, itemRef);
    if (!item) throw new FeedError("that connection is not on this brain", "NO_ITEM");
    // Re-authorisation reuses the SAME connection. Exchanging a new reference
    // here would leave the old one orphaned and the history split in two.
    body.access_token = await decryptAccessReference(env, {
      ciphertext: item.access_ciphertext, iv: item.access_iv, keyVersion: item.key_version,
    });
  } else {
    body.products = [...REQUESTED_PRODUCTS];
    body.transactions = { days_requested: BACKFILL_DAYS };
  }
  const created = await callFeed(env, "/link/token/create", body, { fetchImpl });
  const now = new Date().toISOString();
  const sessionRef = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO bank_feed_link_sessions
       (tenant_id, session_ref, mode, item_ref, redirect_uri, created_at, expires_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(
    tenantId, sessionRef, mode === "reauthorise" ? "reauthorise" : "connect", itemRef,
    redirectUri, now, created.expiration || new Date(Date.now() + 30 * 60_000).toISOString(),
  ).run();
  return {
    link_token: created.link_token,
    expiration: created.expiration || null,
    session_ref: sessionRef,
    redirect_uri: redirectUri,
    environment: config.environment,
  };
}

/**
 * Turn the owner's completed authorisation into a stored, encrypted reference,
 * and QUEUE the history load. The two-year backfill is deliberately not run
 * here: it cannot finish inside one request, and a request that dies halfway
 * through would leave the owner staring at a spinner with nothing to resume.
 */
export async function exchangePublicToken(env, {
  sessionRef = null, publicToken, institutionRef = null, institutionLabel = null, accounts = null, fetchImpl = fetch,
} = {}) {
  const config = bankFeedConfig(env);
  if (config.provider === "plaid") {
    const { completePlaidLink } = await import("./plaid-bank-feed.js");
    return completePlaidLink(env, {
      sessionRef, publicToken, institutionRef, institutionLabel, accounts, fetchImpl,
    });
  }
  const { tenantId } = tenantReference(env);
  if (!publicToken || typeof publicToken !== "string") {
    throw new FeedError("no authorisation handoff value was supplied", "NO_PUBLIC_TOKEN");
  }
  const exchanged = await callFeed(env, "/item/public_token/exchange", { public_token: publicToken }, { fetchImpl });
  const itemRef = exchanged.item_id;
  if (!itemRef || !exchanged.access_token) {
    throw new FeedError("the provider returned no usable connection reference", "NO_ITEM");
  }
  const sealed = await encryptAccessReference(env, exchanged.access_token);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO bank_feed_items
       (tenant_id, item_ref, institution_ref, institution_label, access_ciphertext, access_iv,
        key_version, environment, status, connected_at)
     VALUES (?,?,?,?,?,?,?,?,'connected',?)
     ON CONFLICT (tenant_id, item_ref) DO UPDATE SET
       access_ciphertext = excluded.access_ciphertext,
       access_iv = excluded.access_iv,
       key_version = excluded.key_version,
       institution_ref = COALESCE(excluded.institution_ref, bank_feed_items.institution_ref),
       institution_label = COALESCE(excluded.institution_label, bank_feed_items.institution_label),
       status = 'connected',
       status_detail = NULL,
       removed_at = NULL`,
  ).bind(
    tenantId, itemRef, institutionRef, institutionLabel,
    sealed.ciphertext, sealed.iv, sealed.keyVersion, config.environment, now,
  ).run();

  await env.DB.prepare(
    `INSERT INTO bank_feed_backfill (tenant_id, item_ref, requested_days, state, queued_at)
     VALUES (?,?,?,'queued',?)
     ON CONFLICT (tenant_id, item_ref) DO UPDATE SET
       state = CASE WHEN bank_feed_backfill.state = 'complete' THEN 'complete' ELSE 'queued' END,
       last_error = NULL`,
  ).bind(tenantId, itemRef, BACKFILL_DAYS, now).run();

  return {
    item_ref: itemRef,
    institution_label: institutionLabel,
    environment: config.environment,
    history: {
      state: "queued",
      requested_days: BACKFILL_DAYS,
      note: "Two years of history is being loaded in the background. Progress is on the connection status.",
    },
  };
}

/* ------------------------------------------------------------------- syncing */

/**
 * One bounded slice of work for one connection.
 *
 * The cursor is committed AFTER EVERY PAGE, together with that page's rows, and
 * the slice stops after `maxPages`. Committing only at the end means a first
 * load that cannot finish inside one invocation never finishes at all: it is
 * killed by the clock, the cursor never moves, and the next run repeats the
 * same doomed work forever.
 */
export async function syncItemSlice(env, itemRef, {
  maxPages = MAX_PAGES_PER_SLICE, fetchImpl = fetch, now = null,
} = {}) {
  if (bankFeedConfig(env).provider === "plaid") {
    const { syncPlaidItem } = await import("./plaid-bank-feed.js");
    return syncPlaidItem(env, itemRef, { fetchImpl, now });
  }
  const reviewedEntity = reviewedBankFeedEntityForItem(env, itemRef);
  if (!reviewedEntity) {
    return {
      item_ref: itemRef,
      ok: false,
      pages: 0,
      transactions: 0,
      unread_lines: 0,
      status: "error",
      reason: "this exact bank-feed item has no valid owner-reviewed entity mapping; the feed remains paused",
    };
  }
  const configuredEntity = reviewedEntity.entity_slug;
  const { tenantId } = tenantReference(env);
  const item = await loadItem(env, tenantId, itemRef);
  if (!item) return { item_ref: itemRef, ok: false, reason: "that connection is not on this brain" };
  const stamp = now || new Date().toISOString();
  let cursor = item.cursor || undefined;
  let pages = 0;
  let transactions = 0;
  let unread = 0;
  let hasMore = true;
  let accounts = [];

  try {
    const accessReference = await decryptAccessReference(env, {
      ciphertext: item.access_ciphertext, iv: item.access_iv, keyVersion: item.key_version,
    });
    // Structure comes from the cached endpoint. The live balance endpoint pulls
    // from the institution in real time and is rate limited far more tightly;
    // spending that budget on every routine sync is how a feed starts failing
    // at exactly the moment somebody is watching it.
    const structure = await callFeed(env, "/accounts/get", { access_token: accessReference }, { fetchImpl });
    accounts = structure.accounts || [];

    while (hasMore && pages < maxPages) {
      const page = await callFeed(env, "/transactions/sync", {
        access_token: accessReference, cursor, count: PAGE_SIZE,
      }, { fetchImpl });
      const envelope = normaliseFeedPage({
        itemRef,
        accounts,
        added: page.added || [],
        modified: page.modified || [],
        now: stamp,
      });
      const receipt = await importBankExport(env, envelope, {
        tenantId,
        entitySlug: configuredEntity,
        now: stamp,
        origin: { provenance: "feed", sourceFeed: feedScopeKey(itemRef) },
      });
      transactions += receipt.transactions;
      unread += receipt.unread_lines;

      // A removed line is TOMBSTONED, never deleted. Deleting makes "why did
      // last month's total change" unanswerable and is unrecoverable; the
      // corpus already takes this position for documents and a ledger has less
      // excuse than a corpus.
      for (const removed of page.removed || []) {
        if (!removed?.transaction_id) continue;
        await env.DB.prepare(
          `UPDATE fin_transactions
              SET removed_at = ?, removal_reason = 'the feed withdrew this line'
            WHERE tenant_id = ? AND external_id = ? AND removed_at IS NULL`,
        ).bind(stamp, tenantId, removed.transaction_id).run();
      }

      cursor = page.next_cursor || cursor;
      hasMore = Boolean(page.has_more);
      pages++;
      // Committed with the page, not at the end of the run.
      await env.DB.prepare(
        `UPDATE bank_feed_items
            SET cursor = ?, cursor_updated_at = ?, last_synced_at = ?, status = 'connected', status_detail = NULL
          WHERE tenant_id = ? AND item_ref = ?`,
      ).bind(cursor || null, stamp, stamp, tenantId, itemRef).run();
    }
  } catch (error) {
    const status = error instanceof BankAccessKeyError
      ? { state: "reauth_required", detail: BANK_ACCESS_REAUTH_DETAIL }
      : classifyItemError(error?.code);
    await env.DB.prepare(
      `UPDATE bank_feed_items SET status = ?, status_detail = ?, last_error_at = ?
        WHERE tenant_id = ? AND item_ref = ?`,
    ).bind(status.state, status.detail, stamp, tenantId, itemRef).run();
    return {
      item_ref: itemRef, ok: false, pages, transactions, unread_lines: unread,
      status: status.state, reason: safeFeedError(error),
    };
  }

  return { item_ref: itemRef, ok: true, pages, transactions, unread_lines: unread, has_more: hasMore };
}

/**
 * A failing connection is not a failed sync. It is a brain that has quietly
 * stopped seeing money move, and it gets a state of its own so health and the
 * answer path can say so instead of reporting a smaller month.
 */
export function classifyItemError(code) {
  switch (code) {
    case "ITEM_LOGIN_REQUIRED":
    case "PENDING_EXPIRATION":
      return { state: "reauth_required", detail: "This bank connection needs the account holder to sign in again before any new activity can be read." };
    case "USER_PERMISSION_REVOKED":
    case "ITEM_NOT_FOUND":
      return { state: "permission_revoked", detail: "This bank connection was revoked, so nothing further can be read from it." };
    default:
      return { state: "error", detail: "This bank connection could not be read on the last attempt." };
  }
}

/**
 * Drain queued history loads and refresh connected items, bounded.
 * Returns a progress report rather than a checkmark, because the operator has
 * to be able to tell the client where the load has got to.
 */
export async function runFeedSlice(env, { maxItems = 3, maxPages = MAX_PAGES_PER_SLICE, fetchImpl = fetch, now = null, daily = false } = {}) {
  if (bankFeedConfig(env).provider === "plaid") {
    const { runPlaidFeedSlice } = await import("./plaid-bank-feed.js");
    return runPlaidFeedSlice(env, { maxItems, fetchImpl, now, daily });
  }
  if (bankFeedConfig(env).provider === "simplefin") {
    const { runSimpleFinMaintenance } = await import("./simplefin-bank-feed.js");
    return runSimpleFinMaintenance(env, { maxItems, maxRequestsPerItem: maxPages, fetchImpl, now, daily });
  }
  const { tenantId } = tenantReference(env);
  const stamp = now || new Date().toISOString();
  const pending = (await env.DB.prepare(
    `SELECT i.item_ref, COALESCE(b.state, 'complete') AS backfill_state
       FROM bank_feed_items i
       LEFT JOIN bank_feed_backfill b ON b.tenant_id = i.tenant_id AND b.item_ref = i.item_ref
      WHERE i.tenant_id = ? AND i.removed_at IS NULL AND i.status IN ('connected', 'error')
      ORDER BY CASE COALESCE(b.state, 'complete') WHEN 'queued' THEN 0 WHEN 'running' THEN 0 ELSE 1 END,
               COALESCE(i.last_synced_at, '')
      LIMIT ?`,
  ).bind(tenantId, maxItems).all())?.results || [];

  const report = [];
  for (const row of pending) {
    const backfilling = row.backfill_state === "queued" || row.backfill_state === "running";
    if (backfilling) {
      await env.DB.prepare(
        `UPDATE bank_feed_backfill SET state = 'running', started_at = COALESCE(started_at, ?),
                attempts = attempts + 1
          WHERE tenant_id = ? AND item_ref = ?`,
      ).bind(stamp, tenantId, row.item_ref).run();
    }
    const result = await syncItemSlice(env, row.item_ref, { maxPages, fetchImpl, now: stamp });
    if (backfilling) {
      const finished = result.ok && !result.has_more;
      await env.DB.prepare(
        `UPDATE bank_feed_backfill
            SET pages_done = pages_done + ?, transactions_seen = transactions_seen + ?,
                unread_lines = unread_lines + ?,
                state = ?, finished_at = ?, last_error = ?
          WHERE tenant_id = ? AND item_ref = ?`,
      ).bind(
        result.pages || 0, result.transactions || 0, result.unread_lines || 0,
        finished ? "complete" : (result.ok ? "running" : "failed"),
        finished ? stamp : null,
        result.ok ? null : (result.reason || "the history load could not continue"),
        tenantId, row.item_ref,
      ).run();
    }
    report.push({ ...result, backfilling });
  }
  return { ran: report.length, items: report };
}

/**
 * A committed owner assignment changes rendered bank metadata even when the
 * provider has no new ledger page. Reuse the provider-triggered writer when it
 * ran, and otherwise start one bounded metadata generation directly.
 */
export async function refreshBankActivityAfterAccountAssignment(env, {
  fetchImpl = fetch,
  now = null,
  runFeedSliceImpl = runFeedSlice,
  writeBankActivityDocumentsImpl = null,
} = {}) {
  let sync;
  let syncError = null;
  try {
    sync = await runFeedSliceImpl(env, { fetchImpl, now });
    if (sync?.bank_activity?.outcome !== "no_committed_promotion") return sync;
  } catch (error) {
    syncError = error;
  }
  const writer = writeBankActivityDocumentsImpl ||
    (await import("./bank-activity-doc.js")).writeBankActivityDocuments;
  const bankActivity = await writer(env, { metadataChanges: 1, at: now });
  if (syncError) throw syncError;
  return { ...sync, bank_activity: bankActivity };
}

/**
 * What the operator and the owner both need to see: which banks are connected,
 * which need attention, and how far the history load has got. No reference, no
 * ciphertext, no provider payload.
 */
export async function feedStatus(env, options = {}) {
  if (env.BANK_FEED_PROVIDER === "plaid") {
    const { plaidFeedStatus } = await import("./plaid-bank-feed.js");
    return plaidFeedStatus(env, options);
  }
  if (env.BANK_FEED_PROVIDER === "simplefin") {
    const { simpleFinFeedStatus } = await import("./simplefin-bank-feed.js");
    return simpleFinFeedStatus(env, options);
  }
  const { tenantId } = tenantReference(env);
  // Read stored receipts even when a missing provider variable prevents a
  // scheduled pass. Do not infer a provider or attempt a provider request here.
  const {bankHealthMap}=await import('./bank-feed-health.js');
  const health=await bankHealthMap(env,options.now || new Date().toISOString());
  const items = (await env.DB.prepare(
    `SELECT i.item_ref, i.institution_label, i.environment, i.status, i.status_detail, i.key_version,
            i.connected_at, i.last_synced_at,
            b.state AS history_state, b.pages_done, b.transactions_seen, b.unread_lines, b.last_error,
            ((SELECT COUNT(*) FROM plaid_account_entity_assignments a
              WHERE a.tenant_id=i.tenant_id AND a.item_ref=i.item_ref AND a.entity_slug IS NULL)
            +(SELECT COUNT(*) FROM simplefin_account_assignments a
              WHERE a.tenant_id=i.tenant_id AND a.item_ref=i.item_ref AND a.entity_slug IS NULL)) AS accounts_needing_owner
       FROM bank_feed_items i
       LEFT JOIN bank_feed_backfill b ON b.tenant_id = i.tenant_id AND b.item_ref = i.item_ref
      WHERE i.tenant_id = ? AND i.removed_at IS NULL
      ORDER BY i.connected_at`,
  ).bind(tenantId).all())?.results || [];
  let environment = null;
  try { environment = bankFeedConfig(env).environment; } catch { environment = null; }
  return {
    configured: bankFeedEnabled(env),
    environment,
    connections: items.map((row) => ({
      item_ref: row.item_ref,
      institution_label: row.institution_label,
      environment: row.environment,
      status: row.status,
      status_detail: row.status_detail,
      access_reference_state: accessReferenceState(row, env),
      connected_at: row.connected_at,
      last_synced_at: row.last_synced_at,
      health:health.get(row.item_ref),
      status_line:health.get(row.item_ref)?.status_line,
      accounts_needing_owner:Number(row.accounts_needing_owner || 0),
      history: {
        state: row.history_state || "none",
        pages_done: row.pages_done ?? 0,
        transactions_seen: row.transactions_seen ?? 0,
        unread_lines: row.unread_lines ?? 0,
        last_error: row.last_error || null,
      },
    })),
    // A connection in this list means every financial answer is now missing
    // whatever has happened at that bank since it broke. Surfacing it here is
    // the difference between a stale answer and a stale answer that says so.
    needs_attention: items
      .filter((row) => row.status !== "connected" || health.get(row.item_ref)?.state !== 'healthy' || row.accounts_needing_owner>0)
      .map((row) => ({ item_ref: row.item_ref, status: row.status, detail: row.status_detail })),
  };
}

/**
 * Disconnect a bank. The connection is revoked at the provider and the encrypted
 * reference is destroyed. The ledger rows STAY: deleting a client's financial
 * history because they unplugged a feed is unrecoverable and nobody asked for it.
 */
export async function disconnectItem(env, itemRef, { fetchImpl = fetch, now = null } = {}) {
  if (bankFeedConfig(env).provider === "plaid") {
    const { disconnectPlaidItem } = await import("./plaid-bank-feed.js");
    return disconnectPlaidItem(env, itemRef, { fetchImpl, now });
  }
  if (bankFeedConfig(env).provider === "simplefin") {
    const { disconnectSimpleFinConnection } = await import("./simplefin-bank-feed.js");
    return disconnectSimpleFinConnection(env, itemRef, { now });
  }
  const { tenantId } = tenantReference(env);
  const item = await loadItem(env, tenantId, itemRef);
  if (!item) return { ok: false, reason: "that connection is not on this brain" };
  const stamp = now || new Date().toISOString();
  let revoked = true;
  let detail = "The account holder disconnected this bank.";
  try {
    const reference = await decryptAccessReference(env, {
      ciphertext: item.access_ciphertext, iv: item.access_iv, keyVersion: item.key_version,
    });
    await callFeed(env, "/item/remove", { access_token: reference }, { fetchImpl });
  } catch (error) {
    revoked = false;
    detail = `The account holder disconnected this bank. The provider was not reached to revoke it: ${safeFeedError(error)}`;
  }
  await env.DB.prepare(
    `UPDATE bank_feed_items
        SET status = 'removed', status_detail = ?, removed_at = ?,
            access_ciphertext = 'REMOVED0000000000000000', access_iv = 'REMOVED000000000'
      WHERE tenant_id = ? AND item_ref = ?`,
  ).bind(detail, stamp, tenantId, itemRef).run();
  return { ok: true, revoked_at_provider: revoked, history_kept: true, detail };
}

/* -------------------------------------------------------------------- routes */

/**
 * The owner's connect page.
 *
 * The default owner-page policy is `default-src 'none'` with no external
 * script, which would block the provider's browser SDK — silently, as a console
 * violation nobody sees. So this ONE route gets a policy widened to exactly the
 * SDK's own origin, derived from the configured URL rather than hard-coded, and
 * the widening never touches any other page.
 *
 * The page carries no admin key and never asks for one. Its authorisation is
 * the owner's passkey session, which is the same thing `/app` uses.
 */
export function connectPageHtml(config, { ownerEntityCount = null } = {}) {
  const sdk = config.linkSdkUrl;
  // A new Brain has no owner yet, so every account choice would be an empty
  // list and the only remedy would sit inside a collapsed section. Open it.
  // The page script repeats this decision whenever the owner list is read.
  const addOwnerOpen = ownerEntityCount === 0 ? " open" : "";
  const sdkOrigin = sdk ? new URL(sdk).origin : null;
  const apiOrigin = config.apiBase ? new URL(config.apiBase).origin : null;
  const connectOrigins = [...new Set([apiOrigin, sdkOrigin].filter(Boolean))];
  // The SDK's global is configuration, not a constant. An unconfigured page
  // says so plainly rather than failing at a name that is not there.
  const global = String(config.linkGlobal || "").replace(/[^A-Za-z0-9_$]/g, "").slice(0, 40);
  const csp = [
    "default-src 'none'",
    `script-src 'unsafe-inline'${sdkOrigin ? ` ${sdkOrigin}` : ""}`,
    "style-src 'unsafe-inline'",
    "img-src data:",
    `connect-src 'self'${connectOrigins.length ? ` ${connectOrigins.join(" ")}` : ""}`,
    `frame-src${sdkOrigin ? ` ${sdkOrigin}` : " 'none'"}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect a bank</title>
<link rel="icon" href="${FAVICON}">
<link rel="apple-touch-icon" href="${FAVICON}">
<style>${OWNER_PAGE_CSS}
/* The step script owns visibility and completion; these rules only present it. */
[hidden] { display: none !important; }
.back { display: inline-flex; align-items: center; min-height: var(--control-h); }
.panel { margin-top: var(--space-8); }
h2, #accounts-heading { font-size: var(--text-lg); font-weight: var(--weight-semibold); line-height: var(--leading-body); }
#connections-heading { font-size: var(--text-md); }
#connect-heading, #accounts-heading, #sync-heading { margin-bottom: var(--space-3); }
#connect-heading::before, #accounts-heading::before, #sync-heading::before {
  content: ""; display: inline-block; width: 10px; height: 10px; margin-right: var(--space-2);
  border-radius: 50%; background: var(--color-accent); vertical-align: middle;
}
#connect-heading.ok, #accounts-heading.ok, #sync-heading.ok { font-size: var(--text-base); font-weight: var(--weight-medium); margin-bottom: 0; }
#connect-heading.ok::before, #accounts-heading.ok::before, #sync-heading.ok::before { display: none; }
summary { cursor: pointer; min-height: var(--control-h); padding-block: var(--space-2); }
summary.ok { list-style: none; }
summary.ok::-webkit-details-marker { display: none; }
#connect-body > p { color: var(--color-ink-soft); font-size: var(--text-sm); line-height: var(--leading-prose); margin-bottom: var(--space-4); }
#account-step > p, #entity-details, #entity-create p { margin-top: var(--space-3); }
#entity-details > summary { font-size: var(--text-sm); font-weight: var(--weight-medium); }
#entity-details > .note { margin-block: var(--space-2); }
#entity-create label { font-size: var(--text-sm); }
#entity-name { border-radius: var(--radius-control); }
button { min-height: var(--control-h); max-width: 100%; padding: var(--space-3) var(--control-pad-x);
  border: var(--border) solid transparent; border-radius: var(--radius-control);
  background: var(--color-accent); color: var(--color-accent-ink);
  font: var(--weight-semibold) 0.9375rem/var(--leading-tight) var(--font-sans); cursor: pointer; }
button.secondary { background: var(--color-card); color: var(--color-ink); border-color: var(--color-line-strong); }
button.quiet { background: transparent; color: var(--color-accent); border-color: transparent;
  padding-inline: var(--space-2); margin-inline: calc(-1 * var(--space-2)); font-weight: var(--weight-medium); }
button:disabled { opacity: .5; cursor: default; }
.note { font-size: var(--text-sm); color: var(--color-ink-soft); }
.err { color: var(--color-bad); white-space: pre-wrap; }
.ok { color: var(--color-good); white-space: pre-wrap; }
#status:not(:empty), #arrival-status:not(:empty) { margin-top: var(--space-4); }
#status.err, #account-status.err, #arrival-status.err, #sync-status.err { padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-bad-line); border-radius: var(--radius-control); background: var(--color-bad-bg); font-size: var(--text-sm); }
#arrival-status.note { background: var(--color-wait-bg); color: var(--color-wait); border: 1px solid var(--color-wait-line);
  padding: var(--space-3) var(--space-4); border-radius: var(--radius-control); }
#sync-status.note { background: var(--color-wait-bg); color: var(--color-wait); border: 1px solid var(--color-wait-line);
  padding: var(--space-3) var(--space-4); border-radius: var(--radius-control); }
#account-status:empty, #entity-status:empty, #status:empty { display: none; }
.bank-group { border-top: 1px solid var(--color-line); padding-top: var(--space-4); margin-top: var(--space-5); }
.bank-group > h3 { font-size: var(--text-base); font-weight: var(--weight-semibold); margin-bottom: var(--space-1); }
.bank-group > .ok { margin-top: var(--space-2); }
.bank-group fieldset { min-width: 0; padding: 0; margin: var(--space-4) 0; border: 0; }
.bank-group legend { font-size: var(--text-sm); font-weight: var(--weight-semibold); margin-bottom: var(--space-2); }
.owner-choice { min-height: var(--control-h); padding: var(--space-3); border: 1px solid var(--color-line-strong);
  border-radius: var(--radius-control); background: var(--color-card); cursor: pointer; }
.owner-choice:has(input:checked) { border-color: var(--color-accent); background: var(--color-accent-soft); }
.owner-choice input { width: 18px; height: 18px; margin: 0; flex: none; accent-color: var(--color-accent); }
.account { background: var(--color-card); border-top: 1px solid var(--color-line); padding: var(--space-3) var(--space-4); }
.account:first-child { border-top: 0; }
.account h3 { font-size: var(--text-sm); font-weight: var(--weight-semibold); }
.account p { margin-top: var(--space-1); font-size: var(--text-sm); }
.assign { display: flex; gap: var(--control-gap); align-items: center; flex-wrap: wrap; margin-top: var(--space-2); }
.assign select, .assign input:not([type=radio]) { flex: 1 1 11rem; min-width: 0; }
.bank-owner-review:not(:empty) { margin-block: var(--space-4); font-size: var(--text-sm); }
.bank-owner-review ul { margin-block: var(--space-2); padding-inline-start: var(--space-5); }
.bank-save { margin-block: var(--space-4); }
.bank-results:not(:empty) { margin-block: var(--space-3); font-size: var(--text-sm); }
.bank-results > p + p { margin-top: var(--space-2); }
.connection-row { border-top: 1px solid var(--color-line); padding: var(--space-4) 0; }
.connection-row:first-child { border-top: 0; padding-top: 0; }
.connection-row:last-child { padding-bottom: 0; }
.connection-row h3 { font-size: var(--text-base); font-weight: var(--weight-medium); }
.connection-row p { margin-top: var(--space-1); }
.connection-row a, footer a { display: inline-flex; align-items: center; min-height: var(--control-h); }
footer { border-top: 1px solid var(--color-line); margin-top: var(--space-8); padding-top: var(--space-4); }
footer p + p { margin-top: var(--space-2); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
</style></head><body>
<main class="task">
<a class="back" href="/app">← Back to your Brain</a>
<h1 class="h1">Connect your bank</h1>
<section class="panel card" aria-labelledby="connect-heading">
  <h2 id="connect-heading">STEP 1 of 3 · Connect your bank</h2>
  <div id="connect-body">
    <p>⏱ About 2 minutes. Sign in through ${config.provider === "plaid" ? "Plaid" : "your bank connection provider"} or your bank's secure screen. Financial Brain does not receive your bank
password or security codes. This connection reads your accounts and transactions. It cannot move money.</p>
    <button id="start" class="primary">Connect my bank</button>
  </div>
</section>
<p id="status" role="status" aria-live="polite"></p>
<p id="arrival-status" role="status" aria-live="polite" hidden></p>
<details class="panel card" id="account-step" aria-labelledby="accounts-heading" hidden>
  <summary id="accounts-heading">STEP 2 of 3 · Whose accounts are these?</summary>
  <p class="note">Your bank may return personal and business accounts together. Choose the person, household, or business that owns each account. Transactions stay waiting until every account has a choice.</p>
  <p class="note">Each account belongs to one choice. If you use one account for both personal and business spending, those transactions are not automatically split between them.</p>
  <details id="entity-details"${addOwnerOpen}>
    <summary>Add a person, household, or business</summary>
    <p class="note">If a choice is missing, add its name here. You can assign an account to it as soon as it is saved.</p>
    <form id="entity-create">
      <p><label for="entity-name">Name</label><br><input id="entity-name" type="text" maxlength="120" required autocomplete="off" style="font:inherit;padding:.6rem;width:100%;box-sizing:border-box"></p>
      <p><label for="entity-kind">What is it?</label><br><select id="entity-kind">
        <option value="business">Business</option><option value="person">Person</option>
        <option value="household">Household</option><option value="trust">Trust</option>
        <option value="property">Property</option><option value="investment">Investment</option>
      </select></p>
      <button id="entity-save" type="submit" class="secondary">Save this choice</button>
      <p id="entity-status" role="status" aria-live="polite"></p>
    </form>
  </details>
  <p id="account-status" role="status" aria-live="polite">Looking for connected accounts…</p>
  <div id="accounts"></div>
</details>
<section class="panel card" id="sync-step" aria-labelledby="sync-heading" hidden>
  <h2 id="sync-heading">STEP 3 of 3 · Loading your transactions</h2>
  <p id="sync-status" role="status" aria-live="polite"></p>
  <button id="another" class="secondary" type="button" hidden>Connect another bank</button>
</section>
<section class="panel card" id="saved-connections" aria-labelledby="connections-heading" hidden>
  <h2 id="connections-heading">Your saved connections</h2>
  <div id="connections" aria-live="polite"></div>
</section>
<footer class="note">
  <p>${config.environment === "sandbox" ? "Test mode: practice banks, no real money." : "Environment: " + config.environment + "."}</p>
  <p>To disconnect a bank later, open your Brain and go to Access &gt; Banks &gt; Disconnect. Disconnecting is not done on this page, and your saved history stays.</p>
  <div class="actions"><button id="refresh" class="secondary" type="button">Check again</button><a href="/app">Back to your Brain</a></div>
</footer>
</main>
${sdk ? `<script src="${sdk}"></script>` : ""}
<script>
const el = (id) => document.getElementById(id);
const appHeaders = { "Content-Type": "application/json", "X-Brain-App": "1" };
const say = (text, bad) => { const target = el("status"); target.textContent = String(text || ""); target.className = bad ? "err" : "ok"; };
const accountSay = (text, bad) => { const target = el("account-status"); target.textContent = String(text || ""); target.className = bad ? "err" : "note"; };
const errorMessage = ${bankFeedOwnerErrorMessage.toString()};
const NO_OWNER_LINE = "Add an owner first. Choose who each account belongs to.";
async function requestJson(path, init) {
  const r = await fetch(path, { credentials: "same-origin", ...init, headers: appHeaders });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const error = new Error(errorMessage(d, r.status)); error.code = d.code; throw error; }
  return d;
}
const post = (path, body) => requestJson(path, { method: "POST", body: JSON.stringify(body || {}) });
const get = (path) => requestJson(path, { method: "GET" });
function linkRequestId(mode, itemRef) {
  const key = "bank_link_request_id:" + mode + ":" + (itemRef || "");
  let value = null;
  try { value = sessionStorage.getItem(key); } catch (e) {}
  if (!value) {
    value = crypto.randomUUID();
    try { sessionStorage.setItem(key, value); } catch (e) {}
  }
  return { key, value };
}
function assignmentRequestId(accountRef, entitySlug) {
  const key = "bank_assignment_request:" + accountRef + ":" + entitySlug;
  let value = null;
  try { value = sessionStorage.getItem(key); } catch (e) {}
  if (!value) {
    value = crypto.randomUUID();
    try { sessionStorage.setItem(key, value); } catch (e) {}
  }
  return { key, value };
}
function reassignmentRequestId(accountRef, fromEntitySlug, toEntitySlug) {
  const key = "bank_reassignment_request:" + accountRef + ":" + fromEntitySlug + ":" + toEntitySlug;
  let value = null;
  try { value = sessionStorage.getItem(key); } catch (e) {}
  if (!value) {
    value = crypto.randomUUID();
    try { sessionStorage.setItem(key, value); } catch (e) {}
  }
  return { key, value };
}
function make(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
function entityCreateRequest(name, kind) {
  const key = "bank_entity_create";
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(key)); } catch (e) {}
  if (!saved || saved.legal_name !== name || saved.kind !== kind) {
    const stem = name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 45) || "entity";
    saved = { request_id: crypto.randomUUID(), entity_slug: stem + "-" + crypto.randomUUID().slice(0, 8), legal_name: name, kind };
    try { sessionStorage.setItem(key, JSON.stringify(saved)); } catch (e) {}
  }
  return { key, body: saved };
}
el("entity-create").onsubmit = async (event) => {
  event.preventDefault();
  const name = el("entity-name").value.trim();
  const status = el("entity-status");
  if (!name) { status.textContent = "Enter a name so you can recognize this choice."; return; }
  const button = el("entity-save");
  if (button.disabled) return;
  button.disabled = true;
  status.textContent = "Saving…";
  const retry = entityCreateRequest(name, el("entity-kind").value);
  try {
    await post("/api/owner/entities/create", retry.body);
    try { sessionStorage.removeItem(retry.key); } catch (e) {}
    el("entity-name").value = "";
    status.textContent = "Saved. You can choose it for an account below.";
    await loadAccounts();
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
};
async function ownedEntities() {
  const data = await post("/api/fin/snapshot", { sections: ["entities"] });
  if (!Array.isArray(data.entities)) throw new Error("The business list is unavailable. No account choices were changed.");
  return data.entities.filter((entity) => entity && entity.status === "active" && entity.relationship === "owned");
}
const pendingAccountChoices = new Map();
const assignmentStates = new Map();
const assignmentPromises = new Map();
const assignmentQueue = [];
const bankAssignmentStates = new Map();
const bankAssignmentResults = new Map();
const bankOwnerPicks = new Map();
const bankPickBusy = new Set();
const accountAssignmentResults = new Map();
let assignmentQueueBusy = false;
let accountRenderVersion = 0;
async function saveAccountAssignment(account, entitySlug) {
  const retry = assignmentRequestId(account.account_ref, entitySlug);
  accountSay("Saving that choice…");
  try {
    const result = await post("/api/bank-feed/accounts/assign", {
      request_id: retry.value,
      account_ref: account.account_ref,
      entity_slug: entitySlug,
    });
    try { sessionStorage.removeItem(retry.key); } catch (e) {}
    pendingAccountChoices.delete(account.account_ref);
    accountAssignmentResults.delete(account.account_ref);
    const message = result.changed === false
      ? "That account was already assigned there. Nothing else changed."
      : "Saved. Loading can continue once every account has a choice.";
    accountSay(message);
    return { saved: true, message };
  } catch (error) {
    const message = error.message + (/code:/i.test(error.message) ? "" : " Code: " + (error.code || "BANK_FEED_REQUEST_FAILED") + ".");
    accountAssignmentResults.set(account.account_ref, message);
    accountSay(message, true);
    return { saved: false, message };
  }
}
async function drainAssignmentQueue() {
  if (assignmentQueueBusy) return;
  assignmentQueueBusy = true;
  while (assignmentQueue.length > 0) {
    const job = assignmentQueue.shift();
    assignmentStates.set(job.account.account_ref, "saving");
    if (job.button) job.button.textContent = "Saving…";
    const result = await saveAccountAssignment(job.account, job.entitySlug);
    assignmentStates.delete(job.account.account_ref);
    assignmentPromises.delete(job.account.account_ref);
    if (!result.saved && job.button) {
      job.button.disabled = false;
      job.button.textContent = "Assign account";
    }
    if (job.reload && result.saved) await loadAccounts({ quiet: true });
    job.resolve(result);
  }
  assignmentQueueBusy = false;
}
function enqueueAccountAssignment(account, entitySlug, { button = null, reload = false } = {}) {
  if (assignmentStates.has(account.account_ref)) return null;
  pendingAccountChoices.set(account.account_ref, entitySlug);
  assignmentStates.set(account.account_ref, assignmentQueueBusy ? "queued" : "saving");
  const result = new Promise((resolve) => assignmentQueue.push({ account, entitySlug, button, reload, resolve }));
  assignmentPromises.set(account.account_ref, result);
  if (button) {
    button.disabled = true;
    button.textContent = assignmentQueueBusy ? "Queued…" : "Saving…";
  }
  drainAssignmentQueue();
  return result;
}
function queueAccountAssignment(account, entitySlug, button) {
  if (!enqueueAccountAssignment(account, entitySlug, { button, reload: true })) {
    accountSay("That account already has a choice waiting to save.", true);
  }
}
async function assignBankAccounts(bankKey, accounts, entitySlug, button, resultsRoot, { reload = true } = {}) {
  if (bankAssignmentStates.has(bankKey)) return;
  // A whole-bank choice must never overwrite a more specific choice that the
  // owner already queued on one account. Both paths use the same queue, and
  // the bank path leaves every account already represented there alone.
  const pending = accounts.filter((account) =>
    (!account.assignment || account.assignment.state !== "assigned") &&
    !assignmentStates.has(account.account_ref) && !pendingAccountChoices.has(account.account_ref));
  if (pending.length === 0) return;
  bankAssignmentStates.set(bankKey, "saving");
  bankAssignmentResults.set(bankKey, []);
  button.disabled = true;
  button.textContent = "Assigning…";
  resultsRoot.replaceChildren();
  const jobs = pending.map((account) => {
    const label = account.masked_identifier || "Bank account";
    const line = make("p", label + ": Saving…", "note");
    resultsRoot.append(line);
    return enqueueAccountAssignment(account, entitySlug).then((outcome) => {
      const result = { label, saved: outcome.saved, message: outcome.message };
      bankAssignmentResults.get(bankKey).push(result);
      line.textContent = label + (outcome.saved ? ": Saved." : ": Not saved. " + outcome.message);
      line.className = outcome.saved ? "ok" : "err";
      return result;
    });
  });
  const results = await Promise.all(jobs);
  bankAssignmentStates.delete(bankKey);
  if (reload) await loadAccounts({ quiet: true });
  const failures = results.filter((result) => !result.saved);
  if (failures.length > 0) accountSay(failures[failures.length - 1].message, true);
}
function appendReassignmentControl(card, account, entities) {
  const accountRef = account.account_ref;
  const renderVersion = accountRenderVersion;
  const fromEntitySlug = account.assignment && account.assignment.entity_scope
    ? account.assignment.entity_scope.entity_slug
    : null;
  if (!fromEntitySlug) return;
  const alternatives = entities.filter((entity) => entity.entity_slug !== fromEntitySlug);
  if (alternatives.length === 0) return;
  const start = make("button", "Move to another owner");
  start.type = "button";
  start.className = "secondary quiet";
  start.onclick = () => {
    start.disabled = true;
    const panel = make("div", null, "assign control-row");
    const label = make("label", "Move this account to");
    const select = make("select");
    label.htmlFor = select.id = "reassign-entity-" + accountRef;
    select.append(make("option", "Choose a different owner"));
    select.options[0].value = "";
    for (const entity of alternatives) {
      const option = make("option", entity.label || entity.legal_name || entity.entity_slug);
      option.value = entity.entity_slug;
      select.append(option);
    }
    const review = make("button", "Review move");
    review.type = "button";
    const result = make("div", null, "note");
    let reviewVersion = 0;
    let reviewedMove = null;
    let currentApply = null;
    let applying = false;
    const currentSource = () => account.assignment && account.assignment.state === "assigned" &&
      account.assignment.entity_scope ? account.assignment.entity_scope.entity_slug : null;
    const currentAccount = () => accountRenderVersion === renderVersion &&
      account.account_ref === accountRef && currentSource() === fromEntitySlug;
    const staleAccountMessage = () => currentSource() !== fromEntitySlug
      ? "The account owner changed. Refresh the account list and review it again."
      : "The account list changed. Refresh the account list and review it again.";
    const invalidateReview = (message) => {
      reviewVersion += 1;
      reviewedMove = null;
      if (currentApply) currentApply.disabled = true;
      currentApply = null;
      result.replaceChildren(make("p", message));
      result.className = "note";
      review.disabled = false;
    };
    select.onchange = () => {
      if (!applying) invalidateReview("The choice changed. Review this move again before applying it.");
    };
    review.onclick = async () => {
      if (applying || review.disabled) return;
      if (!currentAccount()) { invalidateReview(staleAccountMessage()); return; }
      if (!select.value) { result.textContent = "Choose a different owner first."; return; }
      const toEntitySlug = select.value;
      const version = ++reviewVersion;
      reviewedMove = null;
      if (currentApply) currentApply.disabled = true;
      currentApply = null;
      review.disabled = true;
      result.replaceChildren();
      result.className = "note";
      result.textContent = "Checking the account history and review locks…";
      try {
        const preview = await post("/api/bank-feed/accounts/reassign", {
          mode: "preview",
          account_ref: accountRef,
          from_entity_slug: fromEntitySlug,
          to_entity_slug: toEntitySlug,
        });
        // An older response cannot revive approval after a selection change or
        // account-list refresh, even when the choice changes away and back.
        if (version !== reviewVersion) return;
        if (!currentAccount()) { invalidateReview(staleAccountMessage()); return; }
        if (select.value !== toEntitySlug) {
          invalidateReview("The choice changed. Review this move again before applying it.");
          return;
        }
        if (preview?.account_ref !== accountRef || preview.can_apply !== true ||
            preview.from_owner?.entity_slug !== fromEntitySlug ||
            preview.to_owner?.entity_slug !== toEntitySlug ||
            !Number.isSafeInteger(preview.history?.transactions) || preview.history.transactions < 0 ||
            !Number.isSafeInteger(preview.history?.balance_snapshots) || preview.history.balance_snapshots < 0) {
          throw new Error("The reviewed move preview was incomplete. Nothing was moved.");
        }
        const approvedMove = Object.freeze({
          account_ref: accountRef,
          from_entity_slug: fromEntitySlug,
          to_entity_slug: toEntitySlug,
        });
        reviewedMove = approvedMove;
        const transactions = preview.history.transactions;
        const balances = preview.history.balance_snapshots;
        result.replaceChildren();
        result.append(make("p", "Move from " + preview.from_owner.label + " to " + preview.to_owner.label +
          ". This keeps " + transactions + " " + (transactions === 1 ? "transaction" : "transactions") +
          " and " + balances + " " + (balances === 1 ? "balance snapshot" : "balance snapshots") +
          " with the account."));
        const apply = make("button", "Move account history");
        apply.type = "button";
        currentApply = apply;
        apply.onclick = async () => {
          if (apply.disabled || applying) return;
          if (!currentAccount()) { invalidateReview(staleAccountMessage()); return; }
          if (reviewedMove !== approvedMove || version !== reviewVersion ||
              select.value !== approvedMove.to_entity_slug) {
            invalidateReview("The choice changed. Review this move again before applying it.");
            return;
          }
          applying = true;
          select.disabled = true;
          review.disabled = true;
          apply.disabled = true;
          apply.textContent = "Moving…";
          const retry = reassignmentRequestId(approvedMove.account_ref,
            approvedMove.from_entity_slug, approvedMove.to_entity_slug);
          try {
            const moved = await post("/api/bank-feed/accounts/reassign", {
              mode: "apply",
              request_id: retry.value,
              ...approvedMove,
            });
            if (moved?.moved !== true || moved.changed !== true ||
                moved.request_id !== retry.value || moved.account_ref !== approvedMove.account_ref ||
                moved.from_owner?.entity_slug !== approvedMove.from_entity_slug ||
                moved.to_owner?.entity_slug !== approvedMove.to_entity_slug ||
                moved.entity_scope?.entity_slug !== approvedMove.to_entity_slug ||
                typeof moved.to_owner.label !== "string" || !moved.to_owner.label.trim()) {
              const message = "The move response could not be verified. Check the account list before trying again.";
              invalidateReview(message);
              accountSay(message, true);
              return;
            }
            try { sessionStorage.removeItem(retry.key); } catch (e) {}
            reviewedMove = null;
            const refreshed = await loadAccounts({ quiet: true });
            accountSay("The account and its saved history now belong to " + moved.to_owner.label + "." +
              (refreshed < 0 ? " The account list could not refresh. Check again." : ""), refreshed < 0);
          } catch (error) {
            accountSay(error.message, true);
            if (error.code === "bank_account_reassignment_scope_changed" ||
                error.code === "request_id_conflict" || !currentAccount()) {
              invalidateReview(error.message);
            } else if (reviewedMove === approvedMove && version === reviewVersion &&
                select.value === approvedMove.to_entity_slug) {
              // A lost response may have committed. Retain the exact receipt
              // identity and let only the same reviewed choice be retried.
              apply.disabled = false;
              apply.textContent = "Move account history";
            } else {
              invalidateReview("The choice changed. Review this move again before applying it.");
            }
          } finally {
            applying = false;
            select.disabled = false;
            if (!reviewedMove) review.disabled = false;
          }
        };
        result.append(apply);
      } catch (error) {
        if (version !== reviewVersion) return;
        result.textContent = error.message;
        result.className = "err";
        review.disabled = false;
      }
    };
    panel.append(label, select, review);
    card.append(panel, result);
  };
  card.append(start);
}
function renderAccountCard(account, entities, { editable = true, onChoice = null } = {}) {
    const waiting = !account.assignment || account.assignment.state !== "assigned";
    const card = make("article", null, waiting ? "account waiting" : "account");
    card.append(make("h3", account.masked_identifier || "Bank account"));
    const institution = "";
    if (account.assignment && account.assignment.state === "assigned") {
      card.append(make("p", institution + "Assigned to " + (account.assignment.entity_label || "the selected owner") + "."));
      appendReassignmentControl(card, account, entities);
    } else if (!editable) {
      card.append(make("p", "Waiting for your bank choice.", "note"));
    } else if (entities.length === 0) {
      // An empty list with a disabled button is a dead end. Point to the one
      // thing that unblocks every account instead.
      card.append(make("p", institution + NO_OWNER_LINE, "note"));
    } else {
      card.append(make("p", institution + "Choose who owns this account."));
      const row = make("div", null, "assign control-row");
      const label = make("label", "Account owner", "sr-only");
      const select = make("select");
      label.htmlFor = select.id = "entity-" + account.account_ref;
      select.append(make("option", "Choose an account owner"));
      select.options[0].value = "";
      for (const entity of entities) {
        const option = make("option", entity.label || entity.legal_name || entity.entity_slug);
        option.value = entity.entity_slug;
        select.append(option);
      }
      const pendingChoice = pendingAccountChoices.get(account.account_ref);
      if (pendingChoice && entities.some((entity) => entity.entity_slug === pendingChoice)) select.value = pendingChoice;
      select.onchange = () => {
        if (select.value) pendingAccountChoices.set(account.account_ref, select.value);
        else pendingAccountChoices.delete(account.account_ref);
        if (onChoice) onChoice();
      };
      const assignmentState = assignmentStates.get(account.account_ref);
      const button = make("button", assignmentState === "saving" ? "Saving…" : assignmentState === "queued" ? "Queued…" : "Assign account");
      button.type = "button";
      button.disabled = entities.length === 0 || Boolean(assignmentState);
      button.onclick = () => {
        if (!select.value) { accountSay("Choose who owns this account first.", true); return; }
        queueAccountAssignment(account, select.value, button);
      };
      row.append(label, select, button);
      card.append(row);
    }
    const failure = accountAssignmentResults.get(account.account_ref);
    if (waiting && failure) card.append(make("p", "Not saved. " + failure, "err"));
    return card;
}
function entityLabel(entity) {
  return entity.label || entity.legal_name || entity.entity_slug;
}
function bankOwnerChoices(entities, mode) {
  if (mode === "mixed") return entities;
  return entities.filter((entity) => mode === "person"
    ? entity.kind === "person" || entity.kind === "household"
    : entity.kind === "business");
}
function singleOwnerPickPolicy(entities) {
  // Founder Q1 is open. Keep this decision in one branch; changing it still
  // leaves the account-name question and individual-choice fences in place.
  const REQUIRE_SINGLE_OWNER_PICK = true;
  return { owner: entities.length === 1 ? entities[0] : null, requirePick: REQUIRE_SINGLE_OWNER_PICK };
}
function bankOwnerPickLabel(mode, entities) {
  const policy = singleOwnerPickPolicy(entities);
  if (policy.requirePick && policy.owner && mode !== "mixed" && bankOwnerChoices(entities, mode).length === 1) {
    return "All " + entityLabel(entities[0]) + "'s";
  }
  return mode === "person" ? "All mine" : mode === "business" ? "All my business" : "Some of each";
}
function bankOwnerNeedsQuestion(account, owner) {
  // Provider words can only ask a question. They never establish ownership.
  const name = account.masked_identifier || "";
  // maskedIdentifier caps the label at 80 before adding an optional mask.
  // A distinguishing owner word may be beyond that cap. Hold long display
  // strings for an individual choice, including the ambiguous exact boundary;
  // absent words in a shortened label are never proof of the bulk owner.
  if (name.length >= 80) return true;
  if (owner.kind === "person" || owner.kind === "household") return /\\b(business|llc|inc|corp|company)\\b/i.test(name);
  return owner.kind === "business" && /\\bpersonal\\b/i.test(name);
}
function appendBankOwnerPick(group, bankKey, accounts, entities) {
  const version = accountRenderVersion;
  const pick = bankOwnerPicks.get(bankKey) || { mode: "", entitySlug: "", name: "" };
  const policy = singleOwnerPickPolicy(entities);
  const automatic = policy.owner && !policy.requirePick && !pick.mode;
  if (automatic) { pick.mode = "mixed"; pick.entitySlug = policy.owner.entity_slug; }
  bankOwnerPicks.set(bankKey, pick);
  const waiting = (account) => account.assignment?.state !== "assigned";
  const fieldset = make("fieldset");
  fieldset.append(make("legend", "Whose accounts are these?"));
  const body = make("div");
  const radios = [];
  for (const mode of ["person", "business", "mixed"]) {
    const label = make("label", null, "assign owner-choice");
    const radio = make("input");
    radio.type = "radio";
    radio.name = "bank-owner-" + accounts[0].account_ref;
    radio.value = mode;
    radio.checked = pick.mode === mode;
    radio.disabled = bankPickBusy.has(bankKey);
    radio.onchange = () => {
      if (bankPickBusy.has(bankKey) || version !== accountRenderVersion) return;
      pick.mode = mode; pick.entitySlug = ""; pick.name = "";
      for (const other of radios) other.checked = other === radio;
      draw();
    };
    radios.push(radio);
    label.append(radio, make("span", bankOwnerPickLabel(mode, entities)));
    fieldset.append(label);
  }
  group.append(fieldset, body);
  function draw() {
    body.replaceChildren();
    if (entities.length === 0) {
      const needsOwnerForm = [...bankOwnerPicks.values()].some((choice) => choice.mode === "mixed");
      el("entity-details").hidden = !needsOwnerForm;
      el("entity-details").open = needsOwnerForm;
    }
    if (!pick.mode) {
      for (const account of accounts) body.append(renderAccountCard(account, entities, { editable: false }));
      return;
    }
    const choices = bankOwnerChoices(entities, pick.mode);
    const creating = pick.mode !== "mixed" && choices.length === 0;
    const owner = () => creating ? { kind: pick.mode, label: pick.name.trim() || "this owner" }
      : choices.find((entity) => entity.entity_slug === pick.entitySlug);
    if (creating) {
      const label = make("label", "Name · " + (pick.mode === "person" ? "Person" : "Business"), "assign");
      const input = make("input", null, "bank-owner-name");
      input.type = "text"; input.maxLength = 120; input.autocomplete = "off";
      input.style = "font:inherit;padding:.6rem;max-width:100%;box-sizing:border-box";
      input.value = pick.name;
      input.oninput = () => { pick.name = input.value; renderCards(); preview(); };
      label.append(input); body.append(label);
    } else {
      const label = make("label", pick.mode === "mixed" ? "Most of these →" : "Account owner", "assign");
      const select = make("select", null, "bank-owner-select");
      const blank = make("option", "Choose…"); blank.value = ""; select.append(blank);
      for (const entity of choices) {
        const option = make("option", entityLabel(entity)); option.value = entity.entity_slug; select.append(option);
      }
      select.value = choices.some((entity) => entity.entity_slug === pick.entitySlug) ? pick.entitySlug : "";
      pick.entitySlug = select.value;
      select.onchange = () => { pick.entitySlug = select.value; draw(); };
      label.append(select); body.append(label);
      if (!choices.length) body.append(make("p", "Add an owner above, then choose who owns most of these accounts.", "note"));
    }
    const review = make("div", null, "bank-owner-review");
    const cards = make("div");
    const results = make("div", null, "bank-results");
    const save = make("button", "Save accounts", "bank-save"); save.type = "button";
    body.append(review, cards, save, results);
    const renderCards = () => {
      cards.replaceChildren();
      for (const account of accounts) {
        const selected = owner();
        const held = waiting(account) && selected && bankOwnerNeedsQuestion(account, selected);
        const card = renderAccountCard(account, entities, { editable: pick.mode === "mixed" || held, onChoice: preview });
        if (held) card.append(make("p", "Is this one " + entityLabel(selected) + "'s too? Choose its owner separately.", "note"));
        cards.append(card);
      }
    };
    function preview() {
      review.replaceChildren();
      const selected = owner();
      save.disabled = bankPickBusy.has(bankKey) || !selected || (creating && !pick.name.trim());
      if (!selected) return;
      review.append(make("p", "Review the accounts before saving:"));
      const list = make("ul");
      for (const account of accounts.filter(waiting)) {
        const exception = pendingAccountChoices.get(account.account_ref);
        const explicit = entities.find((entity) => entity.entity_slug === exception);
        const held = !exception && bankOwnerNeedsQuestion(account, selected);
        list.append(make("li", (account.masked_identifier || "Bank account") + " → " +
          (explicit ? entityLabel(explicit) : held ? "Choose separately" : entityLabel(selected))));
      }
      review.append(list);
    }
    renderCards(); preview();
    if (bankPickBusy.has(bankKey)) {
      for (const node of [...body.querySelectorAll("input"), ...body.querySelectorAll("select"), ...body.querySelectorAll("button")]) node.disabled = true;
    }
    save.onclick = async () => {
      if (save.disabled || bankPickBusy.has(bankKey)) return;
      if (version !== accountRenderVersion) { accountSay("The account list changed. Review it again. Code: bank_account_status_unavailable.", true); return; }
      const selected = owner();
      if (!selected) return;
      // Capture all individual choices before posting any bulk work. A failed
      // exception stays waiting, and cannot fall back to the majority owner.
      const exceptions = accounts.filter((account) => waiting(account) && pendingAccountChoices.has(account.account_ref));
      const exceptionRefs = new Set(exceptions.map((account) => account.account_ref));
      const bulk = accounts.filter((account) => waiting(account) && !exceptionRefs.has(account.account_ref) && !bankOwnerNeedsQuestion(account, selected));
      const exceptionJobs = exceptions.map((account) => ({ account, slug: pendingAccountChoices.get(account.account_ref),
        saving: assignmentPromises.get(account.account_ref) }));
      bankPickBusy.add(bankKey);
      for (const node of [...group.querySelectorAll("input"), ...group.querySelectorAll("select"), ...group.querySelectorAll("button")]) node.disabled = true;
      let failure = null;
      try {
        let slug = pick.entitySlug;
        if (creating) {
          const retry = entityCreateRequest(pick.name.trim(), pick.mode);
          await post("/api/owner/entities/create", retry.body);
          const readback = await ownedEntities();
          const created = readback.find((entity) => entity.entity_slug === retry.body.entity_slug && entity.kind === pick.mode);
          if (!created) throw new Error("The new owner could not be confirmed. Check again. Code: bank_account_status_unavailable.");
          slug = created.entity_slug; pick.entitySlug = slug;
          try { sessionStorage.removeItem(retry.key); } catch (e) {}
        }
        const outcomes = await Promise.all(exceptionJobs.map((job) => job.saving ||
          enqueueAccountAssignment(job.account, job.slug) || Promise.resolve({ saved: false })));
        if (outcomes.some((outcome) => !outcome.saved)) {
          failure = outcomes.find((outcome) => !outcome.saved).message || "An account is still waiting. Review its message before saving the rest. Code: bank_account_assignment_unavailable.";
          return;
        }
        // No bulk call can include an exception, even after its queue state
        // has cleared. The account list is an older snapshot until readback.
        await assignBankAccounts(bankKey, bulk, slug, save, results, { reload: false });
        failure = bankAssignmentResults.get(bankKey)?.find((result) => !result.saved)?.message || null;
      } catch (error) {
        failure = error.message + (/code:/i.test(error.message) ? "" : " Code: bank_account_assignment_unavailable.");
      } finally {
        bankPickBusy.delete(bankKey);
        await loadAccounts({ quiet: true });
        if (failure) accountSay(failure, true);
      }
    };
  }
  draw();
  if (automatic) {
    const save = [...body.querySelectorAll("button")].find((node) => node.textContent === "Save accounts");
    if (save && !save.disabled) save.onclick();
  }
}
function renderAccounts(accounts, entities) {
  accountRenderVersion += 1;
  const root = el("accounts");
  root.replaceChildren();
  el("entity-details").hidden = entities.length === 0;
  const groups = new Map();
  for (const account of accounts) {
    const bankKey = account.institution_label || "Saved bank connection";
    if (!groups.has(bankKey)) groups.set(bankKey, []);
    groups.get(bankKey).push(account);
  }
  for (const [bankKey, bankAccounts] of groups) {
    const group = make("section", null, "bank-group");
    group.append(make("h3", bankKey));
    const pending = bankAccounts.filter((account) => !account.assignment || account.assignment.state !== "assigned");
    group.append(make("p", pending.length + " of " + bankAccounts.length + " " +
      (bankAccounts.length === 1 ? "account" : "accounts") + " still " +
      (pending.length === 1 ? "needs" : "need") + " an owner.", "note bank-progress"));
    const filed = new Map();
    for (const account of bankAccounts) {
      if (account.assignment?.state !== "assigned") continue;
      const slug = account.assignment.entity_scope?.entity_slug;
      if (!slug) continue;
      const saved = filed.get(slug) || { count: 0, label: account.assignment.entity_label || "the selected owner" };
      saved.count++; filed.set(slug, saved);
    }
    for (const saved of filed.values()) group.append(make("p", "✅ " + saved.count +
      (saved.count === 1 ? " account filed under " : " accounts filed under ") + saved.label + ".", "ok"));
    if (pending.length > 0) appendBankOwnerPick(group, bankKey, bankAccounts, entities);
    else {
      const change = make("button", "Change one"); change.type = "button"; change.className = "secondary";
      const cards = make("div");
      change.onclick = () => { cards.replaceChildren(); for (const account of bankAccounts) cards.append(renderAccountCard(account, entities)); };
      group.append(change, cards);
    }
    const savedResults = bankAssignmentResults.get(bankKey);
    if (savedResults && savedResults.length > 0) {
      const results = make("div", null, "bank-results");
      for (const result of savedResults) {
        results.append(make("p", result.label + (result.saved ? ": Saved." : ": Not saved. " + result.message), result.saved ? "ok" : "err"));
      }
      group.append(results);
    }
    root.append(group);
  }
}
async function loadAccounts(options) {
  const quiet = options && options.quiet;
  if (!quiet) accountSay("Checking connected accounts…");
  try {
    const values = await Promise.all([get("/api/bank-feed/accounts"), ownedEntities()]);
    const data = values[0];
    const entities = values[1];
    if (!Array.isArray(data.accounts)) throw new Error("The account list is unavailable. Nothing is being shown as empty.");
    if (entities.length === 0) el("entity-details").open = true;
    renderAccounts(data.accounts, entities);
    if (data.accounts.length === 0) {
      accountSay("No accounts have arrived yet. If you just connected, wait a moment and check again.");
    } else if (data.summary && data.summary.assignment_required > 0) {
      const pending = data.summary.assignment_required;
      accountSay(pending + " of " + data.accounts.length + " " +
        (data.accounts.length === 1 ? "account" : "accounts") + " still " +
        (pending === 1 ? "needs" : "need") + " an owner." +
        (entities.length === 0 ? " Choose once for this bank, then review any exceptions." : ""));
    } else if (data.state === "current") {
      accountSay("Every account is assigned and current.");
    } else {
      accountSay("Every account is assigned. Some history is still loading or needs attention.");
    }
    return data.accounts.length;
  } catch (error) {
    accountSay(error.message, true);
    return -1;
  }
}
async function waitForAccounts() {
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1250));
    const count = await loadAccounts({ quiet: true });
    if (count > 0) return;
  }
  accountSay("The connection is saved, but the account list is still loading. You can leave this page open or check again in a few minutes.");
}
// Page-only copy of the Access bank outcome mapping. This never changes the
// stored health, exceptions, or the confidence used by money answers.
function bankRowOutcome(bank, now) {
  const pending = Number(bank.accounts_needing_owner);
  if (Number.isSafeInteger(pending) && pending > 0) return {
    kind: "needs_you", line: "△ Needs you · " + pending + (pending === 1 ? " account needs an owner." : " accounts need an owner."),
  };
  const health = bank.health || {};
  const code = health.last_error_code;
  const connected = Date.parse(bank.connected_at);
  const age = now - connected;
  const loading = bank.status === "connected" && !health.last_successful_sync_at &&
    Number.isFinite(age) && age >= 0 && age <= 48 * 60 * 60 * 1000 &&
    !health.overdue && !health.pending_overdue && !health.needs_sign_in && !health.needs_reconnect &&
    !bank.replacement_ref && bank.access_reference_state !== "unreadable" &&
    (!code || code === "BANK_SYNC_PARTIAL");
  if (loading) return { kind: "working", line: "○ Working on it · Loading your transactions." };
  const successAge = now - Date.parse(health.last_successful_sync_at);
  if (bank.status === "connected" && health.state === "healthy" && Number.isFinite(successAge) && successAge >= 0 && successAge <= 48 * 60 * 60 * 1000 &&
      !health.overdue && !health.pending_overdue && !health.needs_sign_in && !health.needs_reconnect &&
      !bank.replacement_ref && bank.access_reference_state !== "unreadable" && !code) return {
    kind: "current", line: "● Current · Last checked " + health.last_successful_sync_at,
  };
  return { kind: "problem", line: "✕ Problem · " + (bank.status_line || health.status_line || "This connection needs attention.") };
}
let stepConnections = [];
let stepAccounts = null;
let stepOwnersDone = false;
let addingBank = false;
let addingBankCount = 0;
let connectionLoadBusy = false;
let progressTimer = null;
const progressStartedAt = Date.now();
const repairParams = new URLSearchParams(location.search);
let repairRequested = repairParams.get("mode") === "reauthorise";
let repairSyncAt;
let repairSignInFinished = false;
let repairFinished = false;
function renderBankSteps() {
  const accounts = stepAccounts;
  const connected = !addingBank && !(repairRequested && !repairSignInFinished && !repairFinished) && (stepConnections.length > 0 || (accounts && accounts.length > 0));
  // Owner choices can unblock the sync itself, including on a reopened repair.
  // Never hide existing accounts behind proof that their transactions loaded.
  const hasAccounts = !addingBank && accounts && accounts.length > 0;
  // A successful connection is not proof of an account owner or a completed
  // download. Require both readbacks before collapsing the later steps.
  const ownersDone = connected && hasAccounts && accounts.every((account) => account.assignment?.state === "assigned") &&
    stepConnections.length > 0 && stepConnections.every((bank) => Number(bank.accounts_needing_owner) === 0);
  const outcomes = stepConnections.map((bank) => bankRowOutcome(bank, Date.now()));
  const current = ownersDone && (!repairRequested || repairFinished) && outcomes.every((outcome) => outcome.kind === "current");
  el("connect-heading").textContent = connected ? "✓ STEP 1 of 3 · Bank connected" : "STEP 1 of 3 · Connect your bank";
  el("connect-heading").className = connected ? "ok" : "";
  el("connect-body").hidden = connected;
  el("account-step").hidden = !hasAccounts;
  if (Boolean(ownersDone) !== stepOwnersDone || !ownersDone) el("account-step").open = Boolean(hasAccounts && !ownersDone);
  stepOwnersDone = Boolean(ownersDone);
  el("accounts-heading").textContent = ownersDone ? "✓ STEP 2 of 3 · Every account has an owner" : "STEP 2 of 3 · Whose accounts are these?";
  el("accounts-heading").className = ownersDone ? "ok" : "";
  if (hasAccounts && location.hash === "#accounts") el("account-step").open = true;
  el("arrival-status").hidden = !connected || Boolean(hasAccounts);
  const problem = outcomes.find((outcome) => outcome.kind === "problem");
  el("arrival-status").textContent = problem ? problem.line : "○ Working on it · Plaid is sending your accounts. Usually under a minute. We check for up to 30 minutes; then use Check again.";
  el("arrival-status").className = problem ? "err" : "note";
  el("sync-step").hidden = !ownersDone;
  el("sync-heading").textContent = current ? "STEP 3 of 3 · Done ✓" : "STEP 3 of 3 · Loading your transactions";
  el("sync-heading").className = current ? "ok" : "";
  el("sync-status").textContent = current ? "Transactions are in." : problem ? problem.line :
    "○ Working on it · Loading your transactions. ⏱ The last 30 days usually come first; older history keeps loading in the background. You can close this page. We check for up to 30 minutes; then use Check again.";
  el("sync-status").className = problem && !current ? "err" : "note";
  el("another").hidden = !current;
}
function scheduleBankProgress() {
  if (progressTimer !== null || document.visibilityState !== "visible" || Date.now() - progressStartedAt >= 30 * 60 * 1000) return;
  progressTimer = setTimeout(() => { progressTimer = null; loadConnections(); }, 5000);
}
async function loadConnections() {
  if (connectionLoadBusy) return;
  connectionLoadBusy = true;
  const root = el("connections");
  try {
    const data = await get("/api/bank-feed/status");
    if (!Array.isArray(data.connections)) throw new Error("The saved connection list is unavailable. Please check again before adding a bank.");
    stepConnections = data.connections;
    if (addingBank && stepConnections.length > addingBankCount) addingBank = false;
    if (repairRequested) {
      const target = stepConnections.find((bank) => bank.item_ref === repairParams.get("item_ref"));
      const successAt = target?.health?.last_successful_sync_at || null;
      if (repairSyncAt === undefined) repairSyncAt = successAt;
      // Keep Link reachable on a repair URL, including a healthy-bank repair.
      // A fresh sync can finish a restored repair; a sign-in receipt alone
      // never proves transactions loaded or makes STEP 3 Done.
      else if (successAt !== repairSyncAt && target && bankRowOutcome(target, Date.now()).kind === "current") repairFinished = true;
    }
    el("saved-connections").hidden = data.connections.length === 0;
    root.replaceChildren();
    for (const connection of data.connections) {
      const row = make("div", null, "connection-row");
      row.append(make("h3", connection.institution_label || "Saved bank connection"));
      const outcome = bankRowOutcome(connection, Date.now());
      row.append(make("p", outcome.line, outcome.kind === "problem" ? "err" : "note"));
      if (connection.health?.needs_reconnect || connection.replacement_ref) {
        row.append(make('p','Needs reconnect. Saved history is kept.'));
        const recover=make('a',connection.replacement_ref ? 'Continue recovery' : 'Replace unreadable connection');
        recover.href='/app/connect/bank?mode=replace&item_ref='+encodeURIComponent(connection.item_ref)+(connection.replacement_ref ? '&operation_ref='+encodeURIComponent(connection.replacement_ref) : '');
        row.append(recover);
      } else if (connection.health?.needs_sign_in || connection.status === "reauth_required" || connection.status === "permission_revoked") {
        const repair = make("a", "Repair connection");
        repair.href = "/app/connect/bank?mode=reauthorise&item_ref=" + encodeURIComponent(connection.item_ref);
        row.append(repair);
      }
      root.append(row);
    }
    const progress = await get("/api/bank-feed/accounts");
    if (!Array.isArray(progress.accounts)) throw new Error("The account list is unavailable. Nothing is being shown as empty.");
    stepAccounts = progress.accounts;
    // Only reload the existing owner UI when the account inventory changes.
    // Status polling must not reset an owner's unsaved per-account choices.
    if (el("accounts").querySelectorAll("article").length !== stepAccounts.length) await loadAccounts({ quiet: true });
    renderBankSteps();
  } catch (error) {
    stepAccounts = null;
    renderBankSteps();
    el("saved-connections").hidden = false;
    root.replaceChildren(make("p", error.message, "err"));
  } finally { connectionLoadBusy = false; scheduleBankProgress(); }
}
el("another").onclick = () => {
  // start() reads the URL for its fenced request identity. Leave the repaired
  // Item behind before showing the action for an independent new connection.
  window.history.replaceState(null, "", "/app/connect/bank");
  repairRequested = false;
  repairSignInFinished = false;
  repairFinished = false;
  repairSyncAt = undefined;
  el("start").textContent = "Connect my bank";
  addingBank = true;
  addingBankCount = stepConnections.length;
  renderBankSteps();
};
window.onhashchange = () => { if (location.hash === "#accounts" && !el("account-step").hidden) el("account-step").open = true; };
window.onfocus = () => loadConnections();
// OAuth returns to the registered shared path. Restore only the operation
// identity; all replacement authority is rechecked by the owner-only routes.
if (new URLSearchParams(location.search).has('oauth_state_id')) {
  let replacement=null; try {replacement=JSON.parse(sessionStorage.getItem('bank-replacement-current'));} catch {}
  if(replacement?.item && replacement?.op) {
    const continuation=new URL(location.href); continuation.searchParams.set('mode','replace'); continuation.searchParams.set('item_ref',replacement.item);
    location.replace(continuation.href);
  }
}
let linkBusy = false;
function finishLink() { linkBusy = false; el("start").disabled = false; }
async function start(existing) {
  if (linkBusy) return;
  linkBusy = true;
  el("start").disabled = true;
  say("Preparing a secure connection…");
  const params = new URLSearchParams(window.location.search);
  const requestedMode = params.get("mode") === "reauthorise" ? "reauthorise" : "connect";
  const retry = linkRequestId(requestedMode, requestedMode === "reauthorise" ? params.get("item_ref") : null);
  let begun = existing;
  try {
    begun = begun || await post("/api/bank-feed/link-token", {
      request_id: retry.value,
      mode: requestedMode,
      item_ref: requestedMode === "reauthorise" ? params.get("item_ref") : null,
    });
  } catch (error) {
    if (error.code === "plaid_link_handoff_rejected") {
      try { sessionStorage.removeItem("bank_link_session"); sessionStorage.removeItem(retry.key); } catch (ignored) {}
    }
    throw error;
  }
  const token = begun.link_token;
  try { sessionStorage.setItem("bank_link_session", JSON.stringify(begun)); } catch (e) {}
  const config = {
    token,
    onSuccess: async (publicToken, meta) => {
      say("Finishing up…");
      try {
        const done = await post("/api/bank-feed/exchange", {
          session_ref: begun.session_ref,
          public_token: publicToken,
          institution_ref: meta && meta.institution && meta.institution.institution_id,
          institution_label: meta && meta.institution && meta.institution.name,
          accounts: meta && Array.isArray(meta.accounts) ? meta.accounts.map((account) => ({
            id: account.id, name: account.name, mask: account.mask, type: account.type, subtype: account.subtype,
          })) : null,
        });
        try {
          sessionStorage.removeItem("bank_link_session");
          sessionStorage.removeItem(retry.key);
        } catch (e) {}
        if (requestedMode === "reauthorise" && done.updated === true && done.health_verified === true &&
            done.item_ref === params.get("item_ref")) repairSignInFinished = true;
        say(requestedMode === "reauthorise"
          ? "Your bank sign-in is repaired. We’re checking for updates. Your saved history stays in place."
          : "Connected. We’re finding your accounts now. Choose who owns each one before its transactions are added.");
        loadConnections();
        waitForAccounts();
      } catch (e) {
        // A failed completion must not pin this tab (or a restored copy) to the
        // same Link token. The server still fences any unknown exchange outcome.
        try { sessionStorage.removeItem("bank_link_session"); sessionStorage.removeItem(retry.key); } catch (ignored) {}
        say(e.message, true);
      } finally { finishLink(); }
    },
    onExit: (err) => { if (err) say("The connection was not completed.", true); finishLink(); },
  };
  // Many banks bounce the browser out to their own site and back. Both halves
  // of that return leg are required: without them every bank that uses its own
  // login page fails silently at the last step.
  if (window.location.search.indexOf("oauth_state_id") >= 0) config.receivedRedirectUri = window.location.href;
  const sdk = window[${JSON.stringify(global)}];
  if (!sdk || typeof sdk.create !== "function") { say("The bank connection library is not available on this page.", true); finishLink(); return; }
  sdk.create(config).open();
}
el("start").onclick = () => start().catch((e) => { say(e.message, true); finishLink(); });
if (new URLSearchParams(window.location.search).get("mode") === "reauthorise") el("start").textContent = "Repair connection";
el("refresh").onclick = () => { loadAccounts(); loadConnections(); };
loadAccounts();
loadConnections();
if (window.location.search.indexOf("oauth_state_id") >= 0) {
  let saved = null; try { saved = JSON.parse(sessionStorage.getItem("bank_link_session")); } catch (e) {}
  if (saved) start(saved).catch((e) => { say(e.message, true); finishLink(); });
}
</script></body></html>`;
  return { html, csp };
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

/**
 * The connector's routes.
 *
 * Owner routes are authorised by the passkey session and NEVER by an admin key
 * typed into a page: the admin key can ingest, purge, reindex and drain, and a
 * client-facing form that asks for it trains people to paste it anywhere.
 * Operator routes take the admin key and no session.
 */
export async function handleBankFeed(env, request, url, path, ctx) {
  if (env.VECTOR_DRAIN_MODE === "paused-for-upgrade" && request.method === "POST" &&
      path.startsWith("/api/bank-feed/") &&
      !["/api/bank-feed/recovery-key-proof", "/api/bank-feed/reconcile-recovery"].includes(path)) {
    return privateNoStore(jsonResponse({ error: "unavailable", code: "BANK_WRITES_PAUSED", paused: true }, 503));
  }
  let ownerPrincipalLoaded = false;
  let ownerPrincipal = null;
  const ownerAccess = async () => {
    if (!ownerPrincipalLoaded) {
      ownerPrincipal = await ownerSessionPrincipal(request, env);
      ownerPrincipalLoaded = true;
    }
    return {
      authorised: ownerPrincipal?.kind === "owner" && ownerPrincipal.grantId === null,
      scoped: Boolean(ownerPrincipal),
    };
  };
  const ownerRefusal = (access) => access.scoped
    ? jsonResponse({ error: "forbidden", code: "owner_required" }, 403)
    : jsonResponse({ error: "unauthorized", code: "session_required" }, 401);
  const operatorAuthorised = () => validateAdminKey(request, env);
  const ownerJson = (body, status = 200) => privateNoStore(jsonResponse(body, status));

  try {
    if (path === "/app/connect/bank") {
      if (request.method !== "GET") return jsonResponse({ error: "method not allowed" }, 405);
      const principal = await ownerNavigationPrincipal(request, env);
      const access = {
        authorised: principal?.kind === "owner" && principal.grantId === null,
        scoped: Boolean(principal),
      };
      if (!access.authorised) {
        if (access.scoped) {
          if (acceptsOwnerHtml(request)) {
            return ownerMessageResponse({
              title: "Only the owner can connect a bank",
              line: "Open your Brain to return to your documents.",
              code: "OWNER_REQUIRED",
              action: { label: "Back to your documents", href: "/app" },
            }, 403);
          }
          return new Response("Only the owner can connect a bank.", { status: 403 });
        }
        return ownerMessageResponse({
          title: "Sign in to connect your bank",
          line: "STEP 1 of 3",
          code: "SIGN_IN_REQUIRED",
          action: { label: "Sign in with a passkey", href: "/app?then=connect-bank" },
        }, 401);
      }
      if (!bankFeedEnabled(env)) {
        return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="10"><title>Getting your bank page ready</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:38rem;margin:3rem auto;padding:0 1.25rem;color:#202124}h1{font-size:1.5rem}p{color:#444}</style></head>
<body><main><h1>STEP 1 of 3 · Getting your bank page ready</h1>
<p>○ Almost ready. Your Brain is getting its bank keys. This page refreshes by itself; it usually takes under a minute. If it isn't ready in 10 minutes, tell your installer.</p>
<p>Code: BANK_KEYS_NOT_SET</p></main></body></html>`, {
          status: 503,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
            "X-Frame-Options": "DENY",
            "Referrer-Policy": "no-referrer",
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Retry-After": "10",
          },
        });
      }
      if (url.searchParams.get('mode')==='replace') {
        const { replacementPage } = await import('./bank-replacement-page.js');
        return replacementPage();
      }
      // Only the count is read, and an unreadable count leaves the section in
      // its default state; the page script corrects it once the list loads.
      let ownerEntityCount = null;
      try {
        const owners = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM fin_entities
            WHERE tenant_id=? AND superseded_by_id IS NULL AND status='active' AND relationship='owned'`,
        ).bind(tenantReference(env).tenantId).first();
        const count = Number(owners?.n);
        ownerEntityCount = Number.isSafeInteger(count) && count >= 0 ? count : null;
      } catch {
        ownerEntityCount = null;
      }
      const runtime = bankFeedConfig(env);
      const { html, csp } = runtime.provider === "simplefin"
        ? (await import("./simplefin-bank-feed.js")).simpleFinConnectPageHtml(runtime, { ownerEntityCount })
        : connectPageHtml(runtime, { ownerEntityCount });
      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": csp,
          "X-Frame-Options": "DENY",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "private, no-store",
        },
      });
    }

    if (path === "/api/bank-feed/simplefin/review" && request.method === "POST") {
      const access = await ownerAccess();
      if (!access.authorised) return privateNoStore(ownerRefusal(access));
      if (env.BANK_FEED_PROVIDER !== "simplefin") return ownerJson({ code: "simplefin_provider_not_selected" },404);
      const body = await readJson(request);
      if (typeof body.dry_run !== 'boolean') return ownerJson({ code:'simplefin_review_preview_required' },400);
      const options = { dryRun:body.dry_run,approve:body.approve,
        ...(ctx?.bankFeedNow ? { now:ctx.bankFeedNow } : {}) };
      try {
        let receipt;
        if (body.action === 'kind') {
          const { maintainAccountKind } = await import('./fin-account-kinds.js');
          receipt = await maintainAccountKind(env,{ ...options,selector:body.account_slug,kind:body.kind,role:body.role });
        } else if (body.action === 'coverage') {
          const { maintainSimpleFinCoverage } = await import('./simplefin-coverage-review.js');
          receipt = await maintainSimpleFinCoverage(env,{ ...options,accountRef:body.account_ref,
            from:body.from,to:body.to,confirmSourceComparison:body.confirm_source_comparison });
        } else if (body.action === 'replacement') {
          const { reviewSimpleFinReplacement } = await import('./simplefin-reconciliation.js');
          receipt = await reviewSimpleFinReplacement(env,{ ...options,accountRef:body.account_ref,
            predecessorId:body.predecessor_id,successorId:body.successor_id,confirmSameEvent:body.confirm_same_event });
        } else if (body.action === 'identity') {
          const { bindLegacySimpleFinAccount } = await import('./simplefin-ledger.js');
          receipt = await bindLegacySimpleFinAccount(env,{ ...options,accountRef:body.account_ref,connectionId:body.connection_id });
        } else return ownerJson({ code:'simplefin_review_action_invalid' },400);
        return ownerJson(receipt);
      } catch {
        return ownerJson({ code:'simplefin_review_required',message:'This review could not be verified. Compare the bank record and preview again before confirming.' },409);
      }
    }

    if (path === "/api/bank-feed/simplefin/repair" && request.method === "POST") {
      const access = await ownerAccess();
      if (!access.authorised) return privateNoStore(ownerRefusal(access));
      if (bankFeedConfig(env).provider !== "simplefin") {
        return ownerJson({ code: "simplefin_provider_not_selected" }, 404);
      }
      const body = await readJson(request);
      const { repairSimpleFinAccess } = await import("./simplefin-bank-feed.js");
      return ownerJson(await repairSimpleFinAccess(env, {
        itemRef: body.item_ref,
        fetchImpl: ctx?.bankFeedFetchImpl || fetch,
        now: ctx?.bankFeedNow || null,
      }));
    }

    if (path === "/api/bank-feed/simplefin/claim" && request.method === "POST") {
      const access = await ownerAccess();
      if (!access.authorised) return privateNoStore(ownerRefusal(access));
      if (bankFeedConfig(env).provider !== "simplefin") {
        return ownerJson({ error: "not found", code: "simplefin_provider_not_selected" }, 404);
      }
      const body = await readJson(request);
      const { claimSimpleFinAccess } = await import("./simplefin-bank-feed.js");
      const result = await claimSimpleFinAccess(env, {
        requestId: body.request_id,
        setupToken: body.setup_token,
        fetchImpl: ctx?.bankFeedFetchImpl || fetch,
        now: ctx?.bankFeedNow || null,
      });
      return ownerJson(result.body, result.status);
    }

    if (path === "/api/bank-feed/link-token" && request.method === "POST") {
      const access = await ownerAccess();
      if (!access.authorised) return ownerRefusal(access);
      const body = await readJson(request);
      const runtime = bankFeedConfig(env);
      if (runtime.provider === "simplefin") {
        return ownerJson({ error: "invalid_request", code: "simplefin_claim_required" }, 400);
      }
      if (runtime.provider === "plaid" &&
          (typeof body.request_id !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(body.request_id))) {
        return jsonResponse({
          error: "invalid request",
          code: "plaid_link_request_id_required",
        }, 400);
      }
      return jsonResponse(await createLinkToken(env, {
        url: url.href,
        mode: body.mode === "reauthorise" ? "reauthorise" : "connect",
        itemRef: body.item_ref || null,
        requestId: body.request_id || null,
        fetchImpl: ctx?.bankFeedFetchImpl || fetch,
      }));
    }

    if (path === "/api/bank-feed/exchange" && request.method === "POST") {
      const access = await ownerAccess();
      if (!access.authorised) return ownerRefusal(access);
      if (bankFeedConfig(env).provider === "simplefin") {
        return ownerJson({ error: "invalid_request", code: "simplefin_claim_required" }, 400);
      }
      const body = await readJson(request);
      const result = await exchangePublicToken(env, {
        sessionRef: body.session_ref || null,
        publicToken: body.public_token,
        institutionRef: body.institution_ref || null,
        institutionLabel: body.institution_label || null,
        accounts: body.accounts,
        fetchImpl: ctx?.bankFeedFetchImpl || fetch,
      });
      // The history load runs OUTSIDE this request. The owner gets an answer
      // now and the two years arrive behind them.
      if (ctx?.waitUntil) {
        ctx.waitUntil(runFeedSlice(env, {
          fetchImpl: ctx?.bankFeedFetchImpl || fetch,
        }).catch(() => {}));
      }
      return jsonResponse(result);
    }

    if (path.startsWith('/api/bank-feed/replacement/')) {
      const access = await ownerAccess();
      if (!access.authorised) return privateNoStore(ownerRefusal(access));
      const recovery = await import('./plaid-item-replacement.js');
      const action = path.slice('/api/bank-feed/replacement/'.length);
      try {
        if (action==='status' && request.method==='GET') return ownerJson(await recovery.replacementStatus(env,{operationRef:url.searchParams.get('operation_ref')}));
        if (request.method!=='POST') return ownerJson({code:'replacement_method_required'},405);
        const body=await readJson(request);
        const options={operationRef:body.operation_ref,itemRef:body.item_ref,now:ctx?.bankFeedNow || null};
        let receipt;
        if(action==='preview') receipt=await recovery.replacementPreview(env,options);
        else if(action==='approve') receipt=await recovery.approveReplacement(env,{...options,approve:body.approve,expiresAt:body.expires_at,confirmUnrecoverable:body.confirm_unrecoverable===true});
        else if(action==='link') receipt=await recovery.replacementLink(env,{...options,url:url.href,fetchImpl:ctx?.bankFeedFetchImpl || fetch});
        else if(action==='complete') receipt=await recovery.completeReplacementLink(env,{...options,publicToken:body.public_token,fetchImpl:ctx?.bankFeedFetchImpl || fetch});
        else if(action==='stage') receipt=await recovery.stageReplacement(env,{...options,fetchImpl:ctx?.bankFeedFetchImpl || fetch});
        else if(action==='review' || action==='activate') {
          const review={...options,mappings:body.mappings,choices:body.choices,intervals:body.intervals,expiresAt:body.expires_at};
          receipt=action==='review' ? await recovery.reviewReplacement(env,review) : await recovery.activateReplacement(env,{...review,approve:body.approve});
        } else if(action==='rollback') receipt=await recovery.rollbackReplacement(env,{...options,approve:body.approve ?? null});
        else if(action==='resume') receipt=await recovery.resumeReplacement(env,{...options,approve:body.approve ?? null});
        else if(action==='cancel') receipt=await recovery.cancelReplacement(env,options);
        else return ownerJson({code:'replacement_action_unknown'},404);
        // Private SQL snapshots never leave the Worker, even on owner routes.
        const {_snapshot,_accounts,...publicReceipt}=receipt;
        return ownerJson(publicReceipt);
      } catch(error) {
        const guidance={
          replacement_review_expired:'This review expired. Refresh your choices and confirm again. Saved history is kept.',
          replacement_resume_required:'Accounts still point to the old connection. Review and confirm resuming this recovery before a separate handover.',
          replacement_review_stale_or_unresolved:'Some choices or saved records need another review. Check the current account and occurrence choices. Saved history is kept.',
          replacement_exchange_outcome_unknown:'The bank sign-in result is uncertain. Continue this same recovery with the installer; do not start another sign-in.',
          replacement_institution_mismatch:'The provider returned a different bank. Review this sign-in with the installer. Saved history is kept.',
          replacement_atomic_batch_too_large:'This recovery needs a larger reviewed handover. Keep the staged history and ask the installer to review it.',
          replacement_cancel_needs_custody_review:'Bank sign-in has started. Keep this recovery and review its saved outcome with the installer before cancellation.'
        };
        return ownerJson({code:/^replacement_[a-z_]+$/.test(error?.code || '') ? error.code : 'replacement_review_required',
          history_kept:true,detail:guidance[error?.code] || 'Saved history is kept. Continue the same recovery after reviewing this result.'},409);
      }
    }

    if (path === "/api/bank-feed/custody" && request.method === "GET") {
      const access = await ownerAccess();
      if (!access.authorised && !operatorAuthorised()) return ownerRefusal(access);
      const { bankCustodyReport } = await import('./bank-custody.js');
      return ownerJson(await bankCustodyReport(env));
    }

    if (path === "/api/bank-feed/status" && request.method === "GET") {
      const access = await ownerAccess();
      if (!access.authorised && !operatorAuthorised()) return ownerRefusal(access);
      const status = await feedStatus(env, {now:ctx?.bankFeedNow || null});
      if ((url ?? new URL(request.url)).searchParams.get("update_selfcheck") !== "1") return jsonResponse(status);
      const { bankReadabilityForStatus } = await import("./bank-custody.js");
      return ownerJson({ update_selfcheck: await bankReadabilityForStatus(env, status) });
    }

    if (path === "/api/bank-feed/accounts" && request.method === "GET") {
      const access = await ownerAccess();
      if (!access.authorised) return privateNoStore(ownerRefusal(access));
      const runtime = bankFeedConfig(env);
      if (runtime.provider === "simplefin") {
        const { simpleFinOwnerAccountStatus } = await import("./simplefin-bank-feed.js");
        return ownerJson(await simpleFinOwnerAccountStatus(env));
      }
      if (runtime.provider !== "plaid") {
        return ownerJson({
          error: "unavailable",
          code: "plaid_account_assignment_unavailable",
          unavailable: true,
          sections_unavailable: ["accounts"],
        }, 503);
      }
      const status = await plaidOwnerAccountStatus(env);
      return ownerJson(status, status.unavailable ? 503 : 200);
    }

    if (path === "/api/bank-feed/accounts/assign" && request.method === "POST") {
      const access = await ownerAccess();
      if (!access.authorised) return privateNoStore(ownerRefusal(access));
      const runtime = bankFeedConfig(env);
      if (runtime.provider === "simplefin") {
        const body = await readJson(request);
        const { assignSimpleFinAccountEntity } = await import("./simplefin-bank-feed.js");
        const assigned = await assignSimpleFinAccountEntity(env, body);
        return ownerJson(assigned.body, assigned.status);
      }
      if (runtime.provider !== "plaid") {
        return ownerJson({
          error: "unavailable",
          code: "plaid_account_assignment_unavailable",
          unavailable: true,
        }, 503);
      }
      const body = await readJson(request);
      const assigned = await assignPlaidAccountEntity(env, body);
      if (assigned.body?.changed && assigned.body?.replayed !== true && ctx?.waitUntil) {
        // Resume only once every discovered account has an owner-confirmed
        // scope. A status read after the committed assignment is advisory: if
        // it is unavailable, keep the successful receipt and let the regular
        // scheduled worker retry instead of turning a committed write into a
        // misleading 503 response.
        let readyToResume = false;
        try {
          const status = await plaidOwnerAccountStatus(env);
          readyToResume = !status.unavailable && status.summary?.assignment_required === 0;
        } catch {}
        if (readyToResume) {
          ctx.waitUntil(refreshBankActivityAfterAccountAssignment(env, {
            fetchImpl: ctx?.bankFeedFetchImpl || fetch,
            now: ctx?.bankFeedNow || null,
          }).catch(() => {}));
        }
      }
      return ownerJson(assigned.body, assigned.status);
    }

    if (path === "/api/bank-feed/accounts/reassign" && request.method === "POST") {
      const access = await ownerAccess();
      if (!access.authorised) return privateNoStore(ownerRefusal(access));
      const runtime = bankFeedConfig(env);
      if (runtime.provider !== "plaid") {
        return ownerJson({
          error: "unavailable",
          code: "bank_account_reassignment_unavailable",
          unavailable: true,
        }, 503);
      }
      const body = await readJson(request);
      const reassigned = await reassignPlaidAccountEntity(env, body, {
        now: ctx?.bankFeedNow || null,
      });
      if (reassigned.body?.changed && reassigned.body?.replayed !== true && ctx?.waitUntil) {
        ctx.waitUntil(refreshBankActivityAfterAccountAssignment(env, {
          fetchImpl: ctx?.bankFeedFetchImpl || fetch,
          now: ctx?.bankFeedNow || null,
        }).catch(() => {}));
      }
      return ownerJson(reassigned.body, reassigned.status);
    }

    if (path === "/api/bank-feed/sync" && request.method === "POST") {
      if (!operatorAuthorised()) return jsonResponse({ error: "unauthorized" }, 401);
      const body = await readJson(request);
      if (body.daily === true && (['plaid','simplefin'].includes(env.BANK_FEED_PROVIDER) ||
          (!env.BANK_FEED_PROVIDER && !env.BANK_FEED_API_BASE))) {
        // Health debt is durable even when missing provider settings make the
        // next step fail. This never chooses a provider or bypasses the pause.
        const {reconcileBankFeedHealth}=await import('./bank-feed-health.js');
        await reconcileBankFeedHealth(env,ctx?.bankFeedNow || new Date().toISOString());
      }
      return jsonResponse(await runFeedSlice(env, {
        daily: body.daily === true,
        fetchImpl: ctx?.bankFeedFetchImpl || fetch,
        now: ctx?.bankFeedNow || null,
        maxItems: Math.min(Number(body.max_items) || 3, 10),
        maxPages: Math.min(Number(body.max_pages) || MAX_PAGES_PER_SLICE, 20),
      }));
    }

    if (path === "/api/bank-feed/recovery-key-proof" && request.method === "POST") {
      if (!operatorAuthorised()) return jsonResponse({ error: "unauthorized" }, 401);
      if (request.body !== null) {
        const body = await readJson(request);
        if (body?.protocol !== BANK_RECOVERY_PROTOCOL ||
            Object.keys(body).sort().join(",") !== "offset,protocol,reconciliation_at") {
          return jsonResponse({ error: "invalid recovery proof request", code: "BANK_RECOVERY_PROOF_INVALID" }, 400);
        }
        return privateNoStore(jsonResponse(await bankRecoverySnapshotPage(env, {
          offset: body.offset, reconciliationAt: body.reconciliation_at,
        })));
      }
      return jsonResponse(await bankAccessWrappingKeyProof(env));
    }

    if (path === "/api/bank-feed/reconcile-recovery" && request.method === "POST") {
      if (!operatorAuthorised()) return jsonResponse({ error: "unauthorized" }, 401);
      let stamp = null;
      if (request.body !== null) {
        const body = await readJson(request);
        if (body?.protocol !== BANK_RECOVERY_PROTOCOL ||
            Object.keys(body).sort().join(",") !== "protocol,reconciliation_at") {
          return jsonResponse({ error: "invalid recovery reconciliation request", code: "BANK_RECOVERY_PROOF_INVALID" }, 400);
        }
        stamp = bankRecoveryTime(body.reconciliation_at);
      }
      return jsonResponse(await rewrapBankAccessReferences(env, { limit: 100, now: stamp }));
    }

    if (path === "/api/bank-feed/disconnect" && request.method === "POST") {
      const access = await ownerAccess();
      if (!access.authorised && !operatorAuthorised()) return ownerRefusal(access);
      const body = await readJson(request);
      if (!body.item_ref) return jsonResponse({ error: "name the connection to disconnect" }, 400);
      return jsonResponse(await disconnectItem(env, String(body.item_ref), {
        fetchImpl: ctx?.bankFeedFetchImpl || fetch,
      }));
    }

    return jsonResponse({ error: "not found" }, 404);
  } catch (error) {
    // Every failure uses fixed text or the existing safe error projection, so
    // no path out of this module can carry a provider payload or a credential
    // into a response. In particular, HTML never interpolates an error's code.
    if (path === "/app/connect/bank" || path.startsWith("/app/connect/bank/")) {
      const outcomeUnknown = error?.outcome_unknown === true;
      const code = outcomeUnknown ? "BANK_OUTCOME_UNKNOWN" : "BANK_FEED_REQUEST_FAILED";
      const message = outcomeUnknown
        ? "We couldn't confirm the last step. Don't try again yet; your installer will check."
        : "Your bank page could not be opened. Tell your installer.";
      return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Getting your bank page ready</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:38rem;margin:3rem auto;padding:0 1.25rem;color:#202124}h1{font-size:1.5rem}p{color:#444}</style></head>
<body><main><h1>STEP 1 of 3 · Getting your bank page ready</h1><p>${message}</p>
<p>Code: ${code}</p></main></body></html>`, {
        status: error instanceof FeedConfigError || outcomeUnknown ? 503 : 502,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
          "X-Frame-Options": "DENY",
          "Referrer-Policy": "no-referrer",
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    if (error?.provider === "simplefin" && typeof error?.code === "string") {
      const status = Number.isInteger(error.status) ? error.status : 502;
      return privateNoStore(jsonResponse({
        error: status === 409 ? "conflict" : status === 400 ? "invalid_request" : "unavailable",
        code: String(error.code).slice(0, 80),
        ...(status >= 500 ? { unavailable: true } : {}),
      }, status));
    }
    if (error instanceof PlaidAccountEntityError) {
      const errorName = error.status === 503
        ? "unavailable"
        : error.status === 409
          ? "conflict"
          : error.status === 404
            ? "not_found"
            : error.status === 403
              ? "forbidden"
              : "invalid_request";
      return privateNoStore(jsonResponse({
        error: errorName,
        code: error.code,
        ...(error.status === 503 ? { unavailable: true } : {}),
      }, error.status));
    }
    const outcomeUnknown = error?.outcome_unknown === true;
    const reason = bankFeedRefusalReason(error);
    let environment = null;
    try { environment = bankFeedConfig(env).environment; } catch { environment = null; }
    const body = {
      error: safeFeedError(error),
      ...(error instanceof FeedConfigError
        ? { code: "BANK_KEYS_NOT_SET" }
        : error?.code ? { code: String(error.code).slice(0, 80) } : {}),
      // The page names the exact fix. The redirect URI is the one this Brain
      // sends with every Link request, never text copied from the provider.
      ...(reason ? { reason } : {}),
      ...(reason === "redirect_uri_not_allowed" ? { redirect_uri: redirectUriFor(url.href) } : {}),
      ...(reason === "invalid_api_keys" && environment ? { environment } : {}),
      ...(outcomeUnknown ? {
        outcome_unknown: true,
        retry_safe: false,
        recovery: "The provider may have accepted the one-time handoff. Keep this page open and ask the technician to review this connection before starting another one.",
      } : {}),
    };
    return jsonResponse(body, error instanceof FeedConfigError || outcomeUnknown ? 503 : 502);
  }
}
