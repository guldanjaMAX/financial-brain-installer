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
import { isD1TransientFaultBody } from "../operations/d1-transient-fault.mjs";
import { listStoredSourceFamilies } from "../brain.mjs";

const PRODUCTION_D1_RESET = "D1_ERROR: D1 DB exceeded its CPU time limit and was reset.";

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


// ---------------------------------------------------------------------------
// The predicate receives the BODY as well as the status, because at this site
// the status alone cannot decide.
// ---------------------------------------------------------------------------

{
  const seen = [];
  let calls = 0;
  await requestSourceFamilyPageWithRetry(
    async () => { calls += 1; return reply(calls === 1 ? 500 : 200, calls === 1 ? "first-body" : "{}"); },
    {
      isRetryableStatus: (status, body) => { seen.push([status, body]); return status === 500; },
      delaysMs: [1],
      sleep: async () => {},
    },
  );
  assert.deepEqual(seen[0], [500, "first-body"],
    "the predicate must see the status AND the body it has to classify");
  assert.equal(calls, 2);
}

// A D1-scoped predicate, which is what the CLI passes at this site.
const d1Only = (_status, body) => isD1TransientFaultBody(body);
{
  let calls = 0;
  const page = await requestSourceFamilyPageWithRetry(
    async () => { calls += 1; return reply(500, JSON.stringify({ error: PRODUCTION_D1_RESET })); },
    { isRetryableStatus: d1Only, delaysMs: [1, 2, 3], sleep: async () => {} },
  );
  assert.equal(calls, 4, "a 500 carrying a D1 reset must use the bounded retry");
  assert.equal(page.exhausted, true);
}
for (const [status, body, why] of [
  [500, '{"error":"fixture refusal"}', "a bare 500 here is a capability signal, not a D1 reset"],
  [413, '{"error":"fixture refusal"}', "413 is a capability signal"],
  [429, '{"error":"fixture refusal"}', "429 keeps its one-call behaviour under a D1-scoped rule"],
  [400, '{"error":"fixture refusal"}', "400 is the compatibility ladder's signal"],
]) {
  let calls = 0;
  await requestSourceFamilyPageWithRetry(
    async () => { calls += 1; return reply(status, body); },
    { isRetryableStatus: d1Only, delaysMs: [1, 2, 3], sleep: async () => {} },
  );
  assert.equal(calls, 1, `HTTP ${status}: ${why}`);
}

// B4d: a bad delay schedule is an UNBOUNDED REQUEST LOOP, not a throw, so it is
// checked like every other option rather than being the one that is not.
for (const bad of ["1000", 1000, [1000, -1], [1000, "soon"], [Number.NaN], [Infinity], null]) {
  await assert.rejects(
    async () => requestSourceFamilyPageWithRetry(async () => reply(200), {
      isRetryableStatus: d1Only, delaysMs: bad,
    }),
    /retry delays must be an array of non-negative numbers/,
    `a delay schedule of ${JSON.stringify(bad)} must be refused`,
  );
}

// ---------------------------------------------------------------------------
// SITE 1 end to end. listStoredSourceFamilies uses globalThis.fetch, not an
// injected fetchImpl, so this monkeypatches it the way drive-removal-guard does.
// ---------------------------------------------------------------------------

{
  const originalFetch = globalThis.fetch;
  try {
    // A 500 carrying the verbatim production string is retried, and the message
    // after the bound is exhausted is the same one the walk always raised.
    let d1Calls = 0;
    const slept = [];
    globalThis.fetch = async () => {
      d1Calls += 1;
      return new Response(JSON.stringify({ error: PRODUCTION_D1_RESET }), {
        status: 500, headers: { "content-type": "application/json" },
      });
    };
    await assert.rejects(
      listStoredSourceFamilies({
        base: "https://fixture.invalid",
        adminKey: "fixture-admin",
        source: "drive",
        retryDelaysMs: [1, 2, 3],
        sleep: async (ms) => { slept.push(ms); },
      }),
      /not accepted \(500\)/i,
      "the exhausted message must be the one the walk always raised",
    );
    assert.equal(d1Calls, 4, "a D1 reset at SITE 1 must use the bounded retry");
    assert.deepEqual(slept, [1, 2, 3]);

    // The same status WITHOUT a D1 body is a capability signal and is not retried.
    let bareCalls = 0;
    globalThis.fetch = async () => {
      bareCalls += 1;
      return new Response(JSON.stringify({ error: "fixture refusal" }), {
        status: 500, headers: { "content-type": "application/json" },
      });
    };
    await assert.rejects(
      listStoredSourceFamilies({
        base: "https://fixture.invalid",
        adminKey: "fixture-admin",
        source: "drive",
        retryDelaysMs: [1, 2, 3],
        sleep: async () => {},
      }),
      /not accepted \(500\)/i,
    );
    assert.equal(bareCalls, 1, "a bare 500 must keep its capability-signal behaviour");

    // Retrying happens INSIDE the page: the same cursor is re-requested, so the
    // repeated-cursor guard must not fire and page one must not be re-read.
    let pageOne = 0;
    let pageTwo = 0;
    globalThis.fetch = async (_input, options = {}) => {
      const body = JSON.parse(String(options.body || "{}"));
      if (!body.cursor) {
        pageOne += 1;
        return new Response(JSON.stringify({
          source: "drive", families: ["drive:a"], next_cursor: "drive:a",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      pageTwo += 1;
      return new Response(JSON.stringify({ error: PRODUCTION_D1_RESET }), {
        status: 500, headers: { "content-type": "application/json" },
      });
    };
    await assert.rejects(
      listStoredSourceFamilies({
        base: "https://fixture.invalid",
        adminKey: "fixture-admin",
        source: "drive",
        retryDelaysMs: [1, 2],
        sleep: async () => {},
      }),
      /not accepted \(500\)/i,
      "never the repeated-cursor error: a retried page does not re-enter the walk",
    );
    assert.equal(pageOne, 1, "a retried page two restarted the inventory walk");
    assert.equal(pageTwo, 3, "page two must be retried in place");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log("source-family inventory retry: a transient page is repeated in place, a capability signal is not");
