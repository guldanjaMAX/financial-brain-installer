/**
 * A bounded retry for ONE page of the source-family inventory.
 *
 * listStoredSourceFamilies walks a cursor and had no retry boundary of any kind:
 * no retryTransient, no loop, no backoff. A Cloudflare D1 reset surfaces there as
 * an HTTP 500 from the Worker's global catch (worker/src/index.js:3349-3350), and
 * 500 is already retryable by status. What did not exist was anywhere to retry,
 * so a single reset aborted the whole inventory read.
 *
 * THE RETRY IS INSIDE THE PAGE, NOT AROUND THE WALK. The walk refuses a repeated
 * cursor ("source-family inventory repeated a cursor") so a Worker cannot loop it
 * forever, and it clears its accumulated families on each compatibility restart.
 * Re-requesting one page must therefore not re-enter the walk: this repeats the
 * request for a single fixed cursor and hands back the last response for the
 * caller to classify exactly as it did before.
 *
 * THE 400 COMPATIBILITY LADDER IS DELIBERATELY NOT RETRIED. Five separate 400
 * restarts encode "this Worker is older than this CLI". Repeating such a request
 * cannot change the answer, and retrying one would change which rung a 400 takes.
 * Only a status the CLI already considers transient is repeated, and that
 * predicate is INJECTED rather than restated here so this module cannot drift
 * from the one definition of a retryable status.
 */
export const SOURCE_FAMILY_INVENTORY_RETRY_DELAYS_MS = Object.freeze([1_000, 2_000, 4_000]);

export function sourceFamilyInventoryRetryNotice({ status, retry, maxRetries, delayMs }) {
  return (
    `The brain returned a temporary HTTP ${status} while reading the stored source inventory. ` +
    "Nothing has been changed, and the same page is safe to request again. " +
    `Retrying it in ${delayMs / 1_000} second(s) (retry ${retry} of ${maxRetries}).`
  );
}

/**
 * Run one exact inventory page request, repeating only a transient failure.
 *
 * Returns the last response together with the body text already read, because a
 * response body can only be read once and the caller needs the same bytes to
 * classify compatibility, build its error message, and parse the page.
 *
 * The predicate receives BOTH the status and the body, because at this site the
 * status alone cannot decide: a 413 or a bare 500 here is a capability signal
 * that must not be repeated, while a 500 carrying a D1 reset must be. The status
 * parameter stays in the signature even for a caller whose rule ignores it, so
 * this helper remains usable by one that does not.
 */
export async function requestSourceFamilyPageWithRetry(request, {
  isRetryableStatus,
  delaysMs = SOURCE_FAMILY_INVENTORY_RETRY_DELAYS_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onRetry = () => {},
} = {}) {
  if (typeof request !== "function") throw new TypeError("inventory page request must be a function");
  if (typeof isRetryableStatus !== "function") {
    throw new TypeError("inventory page retry needs a retryable-status predicate");
  }
  if (typeof sleep !== "function") throw new TypeError("inventory page sleep must be a function");
  if (typeof onRetry !== "function") throw new TypeError("inventory page retry reporter must be a function");
  // Checked like the others. A bad schedule here is not an immediate throw but an
  // unbounded request loop, which is the worse failure of the two.
  if (!Array.isArray(delaysMs) ||
      delaysMs.some((ms) => !Number.isFinite(Number(ms)) || Number(ms) < 0)) {
    throw new TypeError("inventory page retry delays must be an array of non-negative numbers");
  }

  let retries = 0;
  for (;;) {
    const res = await request();
    const raw = await res.text();
    if (res.ok || !isRetryableStatus(res.status, raw) || retries >= delaysMs.length) {
      return Object.freeze({ res, raw, retries, exhausted: !res.ok && retries >= delaysMs.length });
    }
    const delayMs = delaysMs[retries];
    retries += 1;
    onRetry(Object.freeze({ status: res.status, retry: retries, maxRetries: delaysMs.length, delayMs }));
    await sleep(delayMs);
  }
}
