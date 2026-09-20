/**
 * The one response shape that field evidence has proved safe to retry for a
 * zone assignment. A Cloudflare edge or upstream proxy can return an HTML 500
 * after the Worker has already committed one bounded repair pass. Repeating
 * the same source-to-zone assignment is idempotent and resumes from D1.
 *
 * Keep this classifier deliberately narrower than the generic HTTP retry
 * rules. A JSON 500 came from the Brain and needs its real error surfaced. A
 * transport failure or any other status does not prove what answered, so the
 * CLI must stop instead of replaying a mutation by guesswork.
 */
export function isHtmlDocumentBody(raw) {
  return /^\s*<(?:!doctype|html|head|body)\b/i.test(String(raw ?? ""));
}

export const ZONE_HTML_RETRY_DELAYS_MS = Object.freeze([1_000, 2_000, 4_000]);

function checkpointLabel(source, zone) {
  return `${JSON.stringify(String(source ?? "").trim())} -> ${JSON.stringify(String(zone ?? "").trim())}`;
}

export function zoneAssignmentRetryNotice({ source, zone, retry, maxRetries, delayMs }) {
  return (
    `Cloudflare returned a web page after the ${checkpointLabel(source, zone)} repair pass. ` +
    "That pass may already be saved. " +
    `Retrying the same checkpoint in ${delayMs / 1_000} second(s) ` +
    `(retry ${retry} of ${maxRetries}).`
  );
}

export function zoneAssignmentRecoveredNotice({ source, zone, retries }) {
  return (
    `The connection recovered. The same ${checkpointLabel(source, zone)} checkpoint resumed ` +
    `after ${retries} retr${retries === 1 ? "y" : "ies"}.`
  );
}

export function zoneAssignmentExhaustedMessage({ source, zone, status, detail }) {
  return (
    `zone command failed (${status}): ${detail}\n` +
    `  All ${ZONE_HTML_RETRY_DELAYS_MS.length} bounded retries were exhausted for ` +
    `${checkpointLabel(source, zone)}. A previous pass may already be saved.\n` +
    "  This command confirmed no checkpoint. If an earlier brain zone run succeeded, that prior output remains the last confirmed checkpoint.\n" +
    "  It is safe to rerun the same brain zone command later; it resumes from the stored pending count."
  );
}

/**
 * Run one exact zone assignment with at most three retries of the verified
 * HTML/proxy 500 case. Non-success response bodies are consumed here so the
 * caller can classify and render the same bytes without attempting a second
 * read from the response stream.
 */
export async function requestZoneAssignmentWithRetry(request, {
  source = "",
  zone = "",
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onRetry = () => {},
} = {}) {
  if (typeof request !== "function") throw new TypeError("zone assignment request must be a function");
  if (typeof sleep !== "function") throw new TypeError("zone assignment sleep must be a function");
  if (typeof onRetry !== "function") throw new TypeError("zone assignment retry reporter must be a function");
  const exactAssignment = typeof source === "string" && source.trim() &&
    typeof zone === "string" && zone.trim();

  let retries = 0;
  while (true) {
    const response = await request();
    if (response?.ok) {
      return Object.freeze({ response, raw: null, retries, recovered: retries > 0, exhausted: false });
    }

    const raw = await response.text();
    const retryable = Boolean(exactAssignment) &&
      Number(response.status) === 500 && isHtmlDocumentBody(raw);
    if (!retryable || retries >= ZONE_HTML_RETRY_DELAYS_MS.length) {
      return Object.freeze({
        response,
        raw,
        retries,
        recovered: false,
        exhausted: retryable && retries >= ZONE_HTML_RETRY_DELAYS_MS.length,
      });
    }

    const delayMs = ZONE_HTML_RETRY_DELAYS_MS[retries];
    retries += 1;
    onRetry(Object.freeze({
      retry: retries,
      maxRetries: ZONE_HTML_RETRY_DELAYS_MS.length,
      delayMs,
    }));
    await sleep(delayMs);
  }
}
