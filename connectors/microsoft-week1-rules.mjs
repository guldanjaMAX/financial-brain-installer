/** Settled Microsoft D1-D4 policies. */

// D1: provider observations never authorize destruction of retained history.
export const MICROSOFT_ADD_ONLY = true;
// D3: permanent extraction gaps are coverage evidence, not an unfinished walk.
export const MICROSOFT_SKIP_UNREADABLE_FILES = true;
// D4: changing this rule requires the separately reviewed consumer consent path.
export const MICROSOFT_WORK_ACCOUNTS_ONLY = true;
export const MICROSOFT_CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
export const MICROSOFT_ACCOUNT_NOT_SUPPORTED_TEXT = "Microsoft did not accept this kind of account. Use your work or school Microsoft 365 account, the one with your Outlook mail. Run the same command again and pick that account. Outlook.com personal accounts are not supported yet.";

export function microsoftAccountNotSupported() {
  return Object.assign(new Error(`${MICROSOFT_ACCOUNT_NOT_SUPPORTED_TEXT} https://financialbrain.ai/help/MICROSOFT_ACCOUNT_NOT_SUPPORTED`), {
    code: "MICROSOFT_ACCOUNT_NOT_SUPPORTED", supportCode: "MICROSOFT_ACCOUNT_NOT_SUPPORTED",
  });
}

export function assertMicrosoftAccountSupported({ accounts = [], tenantId = null } = {}) {
  if (!MICROSOFT_WORK_ACCOUNTS_ONLY) return;
  const consumer = accounts.some(value => /@(outlook|hotmail|live|msn)\.com$/i.test(String(value || "").trim()));
  if (consumer || String(tenantId || "").toLowerCase() === MICROSOFT_CONSUMER_TENANT) throw microsoftAccountNotSupported();
}

// A decoder may only reject a consumer claim here. It cannot establish account
// identity or authorize a grant: that still requires the authenticated /me read.
export function microsoftTokenTenant(value) {
  try {
    const payload = JSON.parse(Buffer.from(String(value || "").split(".")[1], "base64url").toString("utf8"));
    return typeof payload.tid === "string" ? payload.tid : null;
  } catch { return null; }
}

// The retry permission is tied to exact token custody under the renewal lease.
// Unknown legacy fences, lost bodies, persistence failures and other providers
// never borrow the timeout exception. The retry is consumed before sending.
export function microsoftTimeoutRetryAllowed(provider, connection, fingerprint) {
  const fence = connection?.oauth_refresh_fence;
  return provider === "microsoft" && !connection?.quickbooks_refresh_fence && fence?.state === "outcome_unknown" &&
    fence.microsoft_timeout_retry_spent !== true && fence.microsoft_timeout_retry === 1 && fence.token_fingerprint === fingerprint;
}
export function microsoftRefreshFailedBeforeSend(error, responseReceived = false) {
  return !responseReceived && ["ENOTFOUND", "ENETUNREACH", "ECONNREFUSED"].includes(error?.cause?.code || error?.code);
}

export const MICROSOFT_FILE_MAX_BYTES = 8 * 1024 * 1024;
export const MICROSOFT_FILE_SKIP_CODES = Object.freeze([
  "file_too_large", "unsupported_file_type", "unreadable_file", "incomplete_extraction", "low_quality_text", "extracted_text_too_large",
]);
export function microsoftFileSkipBeforeDownload(item) {
  if (Number(item?.size) > MICROSOFT_FILE_MAX_BYTES) return "file_too_large";
  if (/\.(?:jpe?g|png|gif|heic|webp|bmp|tiff?|zip|7z|rar|mp4|mov|avi|mkv|mp3|wav|doc|ppt|pst|msg|one|loop|whiteboard|url)$/i.test(String(item?.name || ""))) return "unsupported_file_type";
  return null;
}
