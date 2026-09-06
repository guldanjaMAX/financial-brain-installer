import { PLAID_PROFILE } from "./bank-feed-profiles.js";

export const PLAID_WEBHOOK_PATH = "/api/webhooks/plaid";
export const PLAID_SYNC_COUNT = 500;
export const PLAID_SYNC_MAX_PAGES_PER_INVOCATION = 1000;
export const PLAID_SYNC_MAX_WINDOW_PAGES = 4096;
export const PLAID_WEBHOOK_MAX_AGE_SECONDS = 5 * 60;
export const PLAID_WEBHOOK_FUTURE_SKEW_SECONDS = 30;
export const PLAID_MUTATION_CODE = "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION";
export const PLAID_HISTORY_STATE = Object.freeze({
  UNKNOWN: "TRANSACTIONS_UPDATE_STATUS_UNKNOWN",
  NOT_READY: "NOT_READY",
  INITIAL: "INITIAL_UPDATE_COMPLETE",
  HISTORICAL: "HISTORICAL_UPDATE_COMPLETE",
});

const PLAID_HISTORY_RANK = new Map([
  [PLAID_HISTORY_STATE.UNKNOWN, 0],
  [PLAID_HISTORY_STATE.NOT_READY, 1],
  [PLAID_HISTORY_STATE.INITIAL, 2],
  [PLAID_HISTORY_STATE.HISTORICAL, 3],
]);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class PlaidProtocolError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "PlaidProtocolError";
    this.code = code;
    this.details = details;
  }
}

function requiredText(value, field) {
  const text = String(value || "").trim();
  if (!text) throw new PlaidProtocolError("INVALID_INPUT", `${field} is required`);
  return text;
}

function optionalText(value) {
  const text = String(value || "").trim();
  return text || null;
}

export function normalisePlaidHistoryState(value) {
  const state = optionalText(value);
  return PLAID_HISTORY_RANK.has(state) ? state : PLAID_HISTORY_STATE.UNKNOWN;
}

export function mergePlaidHistoryState(current, observed) {
  const left = normalisePlaidHistoryState(current);
  const right = normalisePlaidHistoryState(observed);
  return PLAID_HISTORY_RANK.get(right) > PLAID_HISTORY_RANK.get(left) ? right : left;
}

export function plaidWebhookHistoryState(payload) {
  if (payload?.historical_update_complete === true) return PLAID_HISTORY_STATE.HISTORICAL;
  if (payload?.initial_update_complete === true) return PLAID_HISTORY_STATE.INITIAL;
  if (payload?.historical_update_complete === false || payload?.initial_update_complete === false) {
    return PLAID_HISTORY_STATE.NOT_READY;
  }
  return PLAID_HISTORY_STATE.UNKNOWN;
}

function asIsoDate(value) {
  const text = optionalText(value);
  return text && /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function decimalSource(value) {
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new PlaidProtocolError("INVALID_AMOUNT", "Plaid returned a non-decimal transaction amount");
}

function base64UrlBytes(value) {
  const input = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = input + "=".repeat((4 - (input.length % 4 || 4)) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    throw new PlaidProtocolError("INVALID_WEBHOOK_JWT", "Plaid webhook JWT is not valid base64url");
  }
}

function parseJwtPart(value, label) {
  try {
    return JSON.parse(textDecoder.decode(base64UrlBytes(value)));
  } catch (error) {
    if (error instanceof PlaidProtocolError) throw error;
    throw new PlaidProtocolError("INVALID_WEBHOOK_JWT", `Plaid webhook JWT ${label} is not valid JSON`);
  }
}

function constantTimeEqual(left, right) {
  const a = textEncoder.encode(String(left));
  const b = textEncoder.encode(String(right));
  let different = a.length ^ b.length;
  // SHA-256 hex is always 64 bytes. Keep the comparison loop fixed even when
  // an attacker supplies a shorter or longer claim.
  for (let index = 0; index < 64; index += 1) {
    different |= (a[index] || 0) ^ (b[index] || 0);
  }
  return different === 0;
}

async function sha256Hex(value) {
  const bytes = typeof value === "string" ? textEncoder.encode(value) : value;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Build the only two Link request shapes this connector permits. */
export function buildPlaidLinkTokenRequest({
  mode = "connect",
  clientName,
  endUserRef,
  redirectUri,
  webhookUri,
  accessToken = null,
  countryCodes = ["US"],
  language = "en",
  daysRequested = 730,
} = {}) {
  const common = {
    client_name: requiredText(clientName, "clientName"),
    country_codes: countryCodes.map((code) => requiredText(code, "countryCode")),
    language: requiredText(language, "language"),
    user: { client_user_id: requiredText(endUserRef, "endUserRef") },
    redirect_uri: requiredText(redirectUri, "redirectUri"),
  };

  if (mode === "reauthorise") {
    return { ...common, access_token: requiredText(accessToken, "accessToken") };
  }
  if (mode !== "connect") {
    throw new PlaidProtocolError("INVALID_LINK_MODE", `unsupported Plaid Link mode: ${mode}`);
  }
  return {
    ...common,
    products: ["transactions"],
    webhook: requiredText(webhookUri, "webhookUri"),
    transactions: { days_requested: daysRequested },
  };
}

/** Update mode keeps the existing access token and must never exchange a public token. */
export function plaidLinkCompletion({ mode, publicToken = null } = {}) {
  if (mode === "reauthorise") {
    return { action: "keep_existing_access_token", exchangeRequired: false };
  }
  if (mode === "connect") {
    return {
      action: "exchange_public_token",
      exchangeRequired: true,
      publicToken: requiredText(publicToken, "publicToken"),
    };
  }
  throw new PlaidProtocolError("INVALID_LINK_MODE", `unsupported Plaid Link mode: ${mode}`);
}

/**
 * Link tokens are short-lived session values, not Item access credentials. A
 * durable ready receipt is replayed after browser response loss. If provider
 * creation ended ambiguously before a token was stored, issuing a replacement
 * is safe because no Item has been authorized yet.
 */
export function plaidLinkTokenDecision(session, requestFingerprint, { now = Date.now() } = {}) {
  if (!session || session.requestFingerprint !== requestFingerprint) {
    throw new PlaidProtocolError("LINK_SESSION_MISMATCH", "Plaid Link session does not match this request");
  }
  if (session.state === "link_ready" && session.receipt) {
    const expiresAt = Date.parse(session.receipt.expiresAt || "");
    if (Number.isFinite(expiresAt) && expiresAt > now) {
      return { action: "return_link_receipt", receipt: session.receipt };
    }
    return { action: "create_replacement", reason: "expired" };
  }
  if (session.state === "link_create_started") {
    return { action: "create_replacement", reason: "provider_outcome_unknown" };
  }
  if (session.state === "new" || session.state === "link_create_failed") {
    return { action: "create_link_token" };
  }
  throw new PlaidProtocolError("LINK_SESSION_NOT_STARTABLE", "Plaid Link session cannot create another Link token");
}

/**
 * A completed exchange receipt is the idempotency boundary presented to Link.
 * Replaying the same session returns the receipt without calling Plaid again.
 */
export function plaidExchangeDecision(session, requestFingerprint) {
  if (!session || session.requestFingerprint !== requestFingerprint) {
    throw new PlaidProtocolError("LINK_SESSION_MISMATCH", "Plaid Link session does not match this completion");
  }
  if (session.state === "completed" && session.receipt) {
    return { action: "return_receipt", receipt: session.receipt };
  }
  if (session.state === "exchange_started") {
    return {
      action: "manual_recovery",
      code: "PLAID_EXCHANGE_OUTCOME_UNKNOWN",
      reason: "Plaid public tokens are single-use, so an interrupted provider exchange cannot be replayed safely.",
    };
  }
  if (session.state !== "link_completed") {
    throw new PlaidProtocolError("LINK_SESSION_NOT_READY", "Plaid Link session is not ready for token exchange");
  }
  return { action: "exchange_once" };
}

export function normalisePlaidAccount(account) {
  return {
    providerAccountId: requiredText(account?.account_id, "account.account_id"),
    name: requiredText(account?.official_name || account?.name, "account.name"),
    mask: optionalText(account?.mask),
    type: optionalText(account?.type) || "unknown",
    subtype: optionalText(account?.subtype),
    currentBalance: account?.balances?.current == null ? null : decimalSource(account.balances.current),
    availableBalance: account?.balances?.available == null ? null : decimalSource(account.balances.available),
    isoCurrencyCode: optionalText(account?.balances?.iso_currency_code),
    unofficialCurrencyCode: optionalText(account?.balances?.unofficial_currency_code),
    provenance: {
      provider: PLAID_PROFILE.provider,
      endpoint: "/accounts/get",
      providerAccountId: requiredText(account?.account_id, "account.account_id"),
    },
  };
}

function invalidSyncPage(field) {
  // Only fixed schema field names reach the error; never echo a bank payload.
  throw new PlaidProtocolError("INVALID_SYNC_PAGE", `Plaid sync returned an invalid ${field}`);
}

function syncRecord(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidSyncPage(field);
}

function syncText(value, field, { nullable = false, identity = false } = {}) {
  if (nullable && value == null) return;
  if (typeof value !== "string" || (!nullable && !value.trim()) ||
      (identity && value !== value.trim())) invalidSyncPage(field);
}

function syncDate(value, field, { nullable = false } = {}) {
  if (nullable && value == null) return;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalidSyncPage(field);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) invalidSyncPage(field);
}

function validateSyncTransaction(transaction) {
  syncRecord(transaction, "transaction");
  syncText(transaction.transaction_id, "transaction.transaction_id", { identity: true });
  syncText(transaction.account_id, "transaction.account_id", { identity: true });
  if (typeof transaction.pending !== "boolean") invalidSyncPage("transaction.pending");
  syncDate(transaction.date, "transaction.date");
  syncDate(transaction.authorized_date, "transaction.authorized_date", { nullable: true });
  for (const field of ["name", "merchant_name", "pending_transaction_id", "iso_currency_code", "unofficial_currency_code"]) {
    syncText(transaction[field], `transaction.${field}`, { nullable: true, identity: field === "pending_transaction_id" });
  }
  if (!optionalText(transaction.merchant_name) && !optionalText(transaction.name)) invalidSyncPage("transaction.name");
  if (transaction.personal_finance_category != null) {
    syncRecord(transaction.personal_finance_category, "transaction.personal_finance_category");
    syncText(transaction.personal_finance_category.primary, "transaction.personal_finance_category.primary");
    syncText(transaction.personal_finance_category.detailed, "transaction.personal_finance_category.detailed");
  }
}

export function normalisePlaidTransaction(transaction) {
  validateSyncTransaction(transaction);
  const providerTransactionId = requiredText(transaction?.transaction_id, "transaction.transaction_id");
  return {
    providerTransactionId,
    pendingTransactionId: optionalText(transaction?.pending_transaction_id),
    providerAccountId: requiredText(transaction?.account_id, "transaction.account_id"),
    amount: decimalSource(transaction?.amount),
    isoCurrencyCode: optionalText(transaction?.iso_currency_code),
    unofficialCurrencyCode: optionalText(transaction?.unofficial_currency_code),
    date: asIsoDate(transaction?.date),
    authorizedDate: asIsoDate(transaction?.authorized_date),
    pending: transaction?.pending === true,
    name: requiredText(transaction?.merchant_name || transaction?.name, "transaction.name"),
    merchantName: optionalText(transaction?.merchant_name),
    categoryPrimary: optionalText(transaction?.personal_finance_category?.primary),
    categoryDetailed: optionalText(transaction?.personal_finance_category?.detailed),
    provenance: {
      provider: PLAID_PROFILE.provider,
      endpoint: "/transactions/sync",
      providerTransactionId,
      providerAccountId: requiredText(transaction?.account_id, "transaction.account_id"),
    },
  };
}

export function plaidErrorCode(error) {
  return optionalText(error?.code || error?.error_code || error?.body?.error_code || error?.details?.error_code);
}

/** Version-one history: SHA-256 of JSON cursor values, in exact page order. */
export async function validatePlaidSyncCursorHistory({
  originalCursor = null, resumeCursor = null, pageIndex = 0, cursorDigests = [], complete = false,
} = {}) {
  const invalid = () => { throw new PlaidProtocolError("INVALID_SYNC_CURSOR_HISTORY", "The bank refresh cursor history could not be verified. Earlier progress is preserved."); };
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || (complete && pageIndex === 0) || pageIndex > PLAID_SYNC_MAX_WINDOW_PAGES ||
      !Array.isArray(cursorDigests) || cursorDigests.length > PLAID_SYNC_MAX_WINDOW_PAGES + 1 ||
      Array.from(cursorDigests).some(value => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))) invalid();
  const original = await sha256Hex(JSON.stringify(originalCursor ?? null));
  const resume = await sha256Hex(JSON.stringify(resumeCursor ?? null));
  // Migration 35 leaves an empty array on old windows. A caller must restart
  // a paged legacy window from its committed cursor, never invent a prefix.
  if (cursorDigests.length === 0) {
    if (pageIndex > 0) return null;
    if (original !== resume) invalid();
    return [original];
  }
  if (cursorDigests.length !== pageIndex + 1 || cursorDigests[0] !== original || cursorDigests.at(-1) !== resume) invalid();
  const seen = new Set();
  for (let index = 0; index < cursorDigests.length; index++) {
    const digest = cursorDigests[index];
    if (seen.has(digest) && !(complete && index === cursorDigests.length - 1 &&
        index > 0 && digest === cursorDigests[index - 1])) invalid();
    seen.add(digest);
  }
  return [...cursorDigests];
}

/**
 * Fetch and stage one complete Transactions Sync update window. The committed
 * cursor is never advanced here. promoteWindow owns the single atomic flip.
 */
export async function stagePlaidSyncWindow({
  originalCursor = null,
  originalHistoryState = PLAID_HISTORY_STATE.UNKNOWN,
  resumeCursor = null,
  resumeHistoryState = PLAID_HISTORY_STATE.UNKNOWN,
  resumePageIndex = 0,
  resumeCounts = null,
  resumeCursorDigests = [],
  requestPage,
  resetWindow,
  stagePage,
  promoteWindow,
  maxMutationRestarts = 3,
  maxPagesPerInvocation = PLAID_SYNC_MAX_PAGES_PER_INVOCATION,
} = {}) {
  if (typeof requestPage !== "function" || typeof resetWindow !== "function" ||
      typeof stagePage !== "function" || typeof promoteWindow !== "function") {
    throw new PlaidProtocolError("INVALID_SYNC_CALLBACKS", "Plaid sync requires request, stage, reset, and promote callbacks");
  }

  let cursor = resumeCursor ?? originalCursor;
  let historyState = mergePlaidHistoryState(originalHistoryState, resumeHistoryState);
  let pageIndex = Number.isInteger(resumePageIndex) && resumePageIndex >= 0 ? resumePageIndex : 0;
  let mutationRestarts = 0;
  let added = Number.isInteger(resumeCounts?.added) && resumeCounts.added >= 0 ? resumeCounts.added : 0;
  let modified = Number.isInteger(resumeCounts?.modified) && resumeCounts.modified >= 0 ? resumeCounts.modified : 0;
  let removed = Number.isInteger(resumeCounts?.removed) && resumeCounts.removed >= 0 ? resumeCounts.removed : 0;
  if (!Number.isSafeInteger(maxPagesPerInvocation) || maxPagesPerInvocation < 1 ||
      maxPagesPerInvocation > PLAID_SYNC_MAX_PAGES_PER_INVOCATION) {
    throw new PlaidProtocolError("INVALID_SYNC_PAGE_BUDGET", "The bank refresh page budget is invalid");
  }
  let cursorDigests = await validatePlaidSyncCursorHistory({ originalCursor, resumeCursor: cursor,
    pageIndex, cursorDigests: resumeCursorDigests });
  if (!cursorDigests) throw new PlaidProtocolError("INVALID_SYNC_CURSOR_HISTORY", "The earlier bank refresh must restart from its committed cursor before resuming");
  let seenCursors = new Set(cursorDigests);
  let pagesThisInvocation = 0;

  if (pageIndex === 0) await resetWindow({ originalCursor, historyState, reason: "start", cursorDigests });

  for (;;) {
    if (pageIndex >= PLAID_SYNC_MAX_WINDOW_PAGES) {
      throw new PlaidProtocolError("SYNC_WINDOW_PAGE_LIMIT", "This bank refresh reached its safe window limit. Earlier progress is preserved and needs review.");
    }
    if (pagesThisInvocation >= maxPagesPerInvocation) {
      throw new PlaidProtocolError("SYNC_PAGE_BUDGET_EXCEEDED", "This bank refresh reached its page budget. The next refresh can resume its staged progress.");
    }
    pagesThisInvocation += 1;
    let page;
    try {
      page = await requestPage({ cursor, count: PLAID_SYNC_COUNT, pageIndex, originalCursor });
    } catch (error) {
      if (plaidErrorCode(error) !== PLAID_MUTATION_CODE || mutationRestarts >= maxMutationRestarts) throw error;
      mutationRestarts += 1;
      cursor = originalCursor;
      historyState = normalisePlaidHistoryState(originalHistoryState);
      pageIndex = 0;
      added = 0;
      modified = 0;
      removed = 0;
      cursorDigests = [await sha256Hex(JSON.stringify(originalCursor ?? null))];
      seenCursors = new Set(cursorDigests);
      await resetWindow({ originalCursor, historyState, reason: "mutation", mutationRestarts, cursorDigests });
      continue;
    }

    // Validate the entire page before any durable staging callback. Coercing a
    // missing flag/array into a completed empty page would discard changes and
    // promote a cursor that permanently skips them. Array.from also visits holes.
    syncRecord(page, "page");
    if (typeof page.has_more !== "boolean") invalidSyncPage("has_more");
    for (const field of ["added", "modified", "removed"]) {
      if (!Array.isArray(page[field])) invalidSyncPage(field);
    }
    // Plaid documents a 256-character upper bound for the reusable sync cursor:
    // https://plaid.com/docs/api/products/transactions/#transactionssync-request-cursor
    if (typeof page.next_cursor !== "string" || page.next_cursor !== page.next_cursor.trim() ||
        page.next_cursor.length > 256) invalidSyncPage("next_cursor");
    if (page.transactions_update_status != null && typeof page.transactions_update_status !== "string") {
      invalidSyncPage("transactions_update_status");
    }
    const nextCursor = page.next_cursor;
    const stagedPage = {
      pageIndex,
      requestCursor: cursor,
      nextCursor,
      hasMore: page.has_more,
      historyState: mergePlaidHistoryState(historyState, page.transactions_update_status),
      added: Array.from(page.added, normalisePlaidTransaction),
      modified: Array.from(page.modified, normalisePlaidTransaction),
      removed: Array.from(page.removed, (entry) => {
        syncRecord(entry, "removed transaction");
        syncText(entry.transaction_id, "removed.transaction_id", { identity: true });
        return { providerTransactionId: entry.transaction_id };
      }),
    };
    // Plaid documents an empty cursor only before initial transactions exist.
    // This does not reset an existing cursor, continue pagination, or establish
    // initial/historical completion; the runtime keeps this receipt partial.
    if (!nextCursor && !(pageIndex === 0 && !originalCursor && !cursor &&
        added === 0 && modified === 0 && removed === 0 && !stagedPage.hasMore &&
        stagedPage.added.length === 0 && stagedPage.modified.length === 0 && stagedPage.removed.length === 0 &&
        [PLAID_HISTORY_STATE.UNKNOWN, PLAID_HISTORY_STATE.NOT_READY].includes(stagedPage.historyState))) {
      invalidSyncPage("next_cursor");
    }
    const nextDigest = await sha256Hex(JSON.stringify(nextCursor));
    if (seenCursors.has(nextDigest) && (stagedPage.hasMore || nextCursor !== cursor)) {
      invalidSyncPage("repeated next_cursor");
    }
    stagedPage.cursorDigests = [...cursorDigests, nextDigest];
    await stagePage(stagedPage);
    cursorDigests = stagedPage.cursorDigests;
    seenCursors.add(nextDigest);
    historyState = stagedPage.historyState;
    added += stagedPage.added.length;
    modified += stagedPage.modified.length;
    removed += stagedPage.removed.length;
    pageIndex += 1;
    cursor = nextCursor;

    if (!stagedPage.hasMore) {
      return promoteWindow({
        originalCursor,
        finalCursor: nextCursor,
        pageCount: pageIndex,
        mutationRestarts,
        counts: { added, modified, removed },
        historyState,
      });
    }
  }
}

/** Verify the Plaid-Verification JWT against the exact raw request body. */
export async function verifyPlaidWebhook({ rawBody, verificationJwt, getJwk, now = Date.now() } = {}) {
  if (typeof rawBody !== "string" && !(rawBody instanceof Uint8Array)) {
    throw new PlaidProtocolError("INVALID_WEBHOOK_BODY", "Plaid webhook verification requires the exact raw body bytes");
  }
  if (String(verificationJwt || "").length > 4096) {
    throw new PlaidProtocolError("INVALID_WEBHOOK_JWT", "Plaid webhook JWT is too large");
  }
  const parts = String(verificationJwt || "").split(".");
  if (parts.length !== 3) throw new PlaidProtocolError("INVALID_WEBHOOK_JWT", "Plaid webhook JWT has the wrong shape");
  const header = parseJwtPart(parts[0], "header");
  const claims = parseJwtPart(parts[1], "claims");
  if (header.alg !== "ES256" || !optionalText(header.kid)) {
    throw new PlaidProtocolError("INVALID_WEBHOOK_JWT", "Plaid webhook JWT must use ES256 and include kid");
  }
  if (typeof getJwk !== "function") throw new PlaidProtocolError("INVALID_WEBHOOK_KEY_SOURCE", "Plaid webhook key lookup is required");
  const jwk = await getJwk(header.kid);
  if (!jwk || jwk.kid !== header.kid || jwk.kty !== "EC" || jwk.crv !== "P-256") {
    throw new PlaidProtocolError("INVALID_WEBHOOK_KEY", "Plaid webhook verification key does not match the signed key id");
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    base64UrlBytes(parts[2]),
    textEncoder.encode(`${parts[0]}.${parts[1]}`),
  );
  if (!verified) throw new PlaidProtocolError("INVALID_WEBHOOK_SIGNATURE", "Plaid webhook signature is invalid");

  const nowSeconds = Math.floor(now / 1000);
  if (!Number.isInteger(claims.iat) || nowSeconds - claims.iat > PLAID_WEBHOOK_MAX_AGE_SECONDS ||
      claims.iat - nowSeconds > PLAID_WEBHOOK_FUTURE_SKEW_SECONDS) {
    throw new PlaidProtocolError("STALE_WEBHOOK", "Plaid webhook JWT is outside the accepted time window");
  }
  const bodyHash = await sha256Hex(rawBody);
  if (!constantTimeEqual(bodyHash, claims.request_body_sha256)) {
    throw new PlaidProtocolError("WEBHOOK_BODY_MISMATCH", "Plaid webhook body hash does not match its signature");
  }
  return {
    kid: header.kid,
    issuedAt: claims.iat,
    bodyHash,
    deliveryId: await sha256Hex(String(verificationJwt)),
  };
}

export function plaidWebhookDisposition({ deliverySeen, issuedAt, lastIssuedAt, payload } = {}) {
  const type = optionalText(payload?.webhook_type);
  const code = optionalText(payload?.webhook_code);
  const relevant = type === "TRANSACTIONS" || type === "ITEM";
  if (deliverySeen) {
    return {
      state: "replay",
      scheduleReconciliation: relevant,
      webhookType: type,
      webhookCode: code,
      itemId: optionalText(payload?.item_id),
      historyState: plaidWebhookHistoryState(payload),
    };
  }
  const outOfOrder = Number.isInteger(lastIssuedAt) && Number.isInteger(issuedAt) && issuedAt < lastIssuedAt;
  return {
    state: outOfOrder ? "out_of_order" : "accepted",
    scheduleReconciliation: relevant,
    webhookType: type,
    webhookCode: code,
    itemId: optionalText(payload?.item_id),
    historyState: plaidWebhookHistoryState(payload),
  };
}

/** Token erasure is permitted only after the provider confirms Item removal. */
export function plaidRevocationTransition({ state, providerResult = null } = {}) {
  if (state === "confirmed") {
    return {
      state: "confirmed",
      outcomeState: "confirmed",
      eraseAccessToken: true,
      retry: false,
      retrySafe: false,
    };
  }
  if (providerResult?.removed === true) {
    return {
      state: "confirmed",
      outcomeState: "confirmed",
      eraseAccessToken: true,
      retry: false,
      retrySafe: false,
    };
  }
  if (providerResult?.outcomeUnknown === true) {
    return {
      state: "pending",
      outcomeState: "unknown",
      eraseAccessToken: false,
      retry: true,
      retrySafe: false,
      errorCode: optionalText(providerResult?.errorCode) || "PLAID_REMOVE_OUTCOME_UNKNOWN",
    };
  }
  return {
    state: "pending",
    outcomeState: "not_removed",
    eraseAccessToken: false,
    retry: true,
    retrySafe: true,
    errorCode: optionalText(providerResult?.errorCode) || "PLAID_REMOVE_NOT_CONFIRMED",
  };
}
