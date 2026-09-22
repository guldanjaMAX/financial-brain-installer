/**
 * The source-family inventory had no retry boundary of any kind, so a single
 * Cloudflare D1 reset (an HTTP 500 from the Worker's global catch) aborted the
 * whole walk. These are the boundary's own direct tests: no CLI, no HTTP, just
 * the helper and an injected request.
 */
import assert from "node:assert/strict";

import {
  requestSourceFamilyPageWithRetry,
  sourceFamilyInventoryRetryNotice,
  SOURCE_FAMILY_INVENTORY_RETRY_DELAYS_MS,
} from "../operations/source-family-inventory-retry.mjs";

// The CLI's own rule, passed in rather than restated in the module under test.
const isRetryableStatus = (status) => new Set([408, 425, 429]).has(Number(status)) || Number(status) >= 500;

function reply(status, body = "{}") {
  return { ok: status >= 200 && status < 300, status, async text() { return body; } };
}

function harness(statuses, { delaysMs = [1, 2, 3] } = {}) {
  let calls = 0;
  const slept = [];
  const notices = [];
  return {
    calls: () => calls,
    slept,
    notices,
    run: () => requestSourceFamilyPageWithRetry(
      async () => { const s = statuses[Math.min(calls, statuses.length - 1)]; calls += 1; return reply(s, `body-${s}`); },
      { isRetryableStatus, delaysMs, sleep: async (ms) => { slept.push(ms); }, onRetry: (a) => notices.push(a) },
    ),
  };
}

assert.ok(Object.isFrozen(SOURCE_FAMILY_INVENTORY_RETRY_DELAYS_MS), "the delay schedule is a frozen named constant");
assert.equal(SOURCE_FAMILY_INVENTORY_RETRY_DELAYS_MS.length, 3, "the retry is bounded");

// A success is returned on the first call, with its body already read.
{
  const h = harness([200]);
  const page = await h.run();
  assert.equal(page.res.status, 200);
  assert.equal(page.raw, "body-200", "the body is read once and handed back");
  assert.equal(page.retries, 0);
  assert.equal(page.exhausted, false);
  assert.equal(h.calls(), 1);
  assert.equal(h.slept.length, 0);
}

// A transient status is repeated to the bound, then the last response is returned
// so the caller raises exactly the error it raised before.
{
  const h = harness([500]);
  const page = await h.run();
  assert.equal(h.calls(), 4, "500 must use one initial attempt plus three bounded retries");
  assert.deepEqual(h.slept, [1, 2, 3], "each retry backs off on its own delay");
  assert.equal(page.retries, 3);
  assert.equal(page.exhausted, true, "the caller can tell the bound was reached");
  assert.equal(page.res.status, 500, "the LAST response is returned, not a synthesized one");
  assert.equal(page.raw, "body-500");
}

// A transient status that clears returns the success.
{
  const h = harness([500, 503, 200]);
  const page = await h.run();
  assert.equal(page.res.status, 200);
  assert.equal(h.calls(), 3, "the retry stops as soon as the page succeeds");
  assert.equal(page.retries, 2);
  assert.equal(page.exhausted, false);
}

// 429 is retryable by status and is repeated.
{
  const h = harness([429, 200]);
  await h.run();
  assert.equal(h.calls(), 2, "429 is already a retryable status and must be repeated");
}

// A 400 is the compatibility ladder's signal. Repeating it cannot change the
// answer, and retrying would change which rung the ladder takes.
for (const status of [400, 404, 413]) {
  const h = harness([status]);
  const page = await h.run();
  assert.equal(h.calls(), 1, `HTTP ${status} must not be retried`);
  assert.equal(page.retries, 0);
  assert.equal(page.exhausted, false, `HTTP ${status} is not an exhausted retry`);
  assert.equal(h.slept.length, 0, `HTTP ${status} must not back off`);
}

// The notice names the status, the attempt and the wait, and never the cursor or
// any document identity.
{
  const h = harness([500, 200]);
  await h.run();
  assert.equal(h.notices.length, 1);
  assert.deepEqual(h.notices[0], { status: 500, retry: 1, maxRetries: 3, delayMs: 1 });
  const text = sourceFamilyInventoryRetryNotice({ status: 500, retry: 1, maxRetries: 3, delayMs: 1_000 });
  assert.match(text, /temporary HTTP 500/);
  assert.match(text, /Nothing has been changed/);
  assert.match(text, /retry 1 of 3/);
  assert.match(text, /in 1 second\(s\)/);
}

// An empty schedule is a valid "no retry" configuration rather than an error.
{
  const h = harness([500], { delaysMs: [] });
  const page = await h.run();
  assert.equal(h.calls(), 1);
  assert.equal(page.exhausted, true);
}

// Misuse is refused rather than silently degrading into no retry.
await assert.rejects(async () => requestSourceFamilyPageWithRetry("not a function", { isRetryableStatus }),
  /request must be a function/);
await assert.rejects(async () => requestSourceFamilyPageWithRetry(async () => reply(200), {}),
  /retryable-status predicate/);
await assert.rejects(async () => requestSourceFamilyPageWithRetry(async () => reply(200), { isRetryableStatus, sleep: 1 }),
  /sleep must be a function/);
await assert.rejects(async () => requestSourceFamilyPageWithRetry(async () => reply(200), { isRetryableStatus, onRetry: 1 }),
  /retry reporter must be a function/);

console.log("source-family inventory retry: a transient page is repeated in place, a capability signal is not");
