/**
 * A Cloudflare D1 CPU-limit reset reaches the split-document cleanup as an HTTP
 * 400, because the forget route's families sub-branch maps every exception to
 * that status. 400 is not retryable and must not become retryable, so the fault
 * is identified from the response body instead.
 *
 * The predicate is tested here directly, with no HTTP fake, against every
 * D1_ERROR string that exists anywhere in this repository. Those eight fixtures
 * are the ONLY witnesses to this wording: nothing in worker/src or brain.mjs
 * produces or parses it. See operations/d1-transient-fault.mjs for the
 * provenance note and for why only some of them are treated as transient.
 */
import assert from "node:assert/strict";

import {
  D1_TRANSIENT_FAULT_REASONS,
  isD1TransientFaultBody,
} from "../operations/d1-transient-fault.mjs";
import { reconcileDocumentFamilies } from "../brain.mjs";

// ---------------------------------------------------------------------------
// The predicate, directly. All eight repository fixtures, verbatim.
// ---------------------------------------------------------------------------

// Transient: repeating the identical query can clear these.
for (const [body, where] of [
  ["D1_ERROR: exceeded CPU time limit", "test/diagnose.test.mjs:823"],
  ["D1_ERROR: exceeded CPU time limit", "worker/test/routes.test.mjs:4958"],
  ["D1_ERROR: Network connection lost.", "test/message-session.test.mjs:174"],
  ["D1_ERROR: network connection lost", "worker/test/spend-cap.test.mjs:40"],
]) {
  assert.equal(isD1TransientFaultBody(body), true, `${where} must be treated as transient: ${body}`);
}

// Permanent: repeating these cannot clear them, and each retry spends more of
// the budget that is already failing.
for (const [body, where] of [
  ["D1_ERROR: no such table: schema_migrations", "test/checksum-reconciliation.test.mjs:216"],
  [
    "D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.",
    "test/database-read-failure.test.mjs:13",
  ],
  [
    "D1_ERROR: query exceeded the memory limit while reading the requested rows",
    "worker/test/source-inventory.test.mjs:843",
  ],
  ["The database said: D1_ERROR", "test/database-read-failure.test.mjs:15"],
]) {
  assert.equal(isD1TransientFaultBody(body), false, `${where} is permanent and must not be retried: ${body}`);
}

// The possessive is optional, not chosen. The wording specified for this work was
// "exceeded its CPU time limit"; this repository's own fixtures omit "its", so a
// pattern carrying it would match none of its own witnesses.
assert.equal(isD1TransientFaultBody("D1_ERROR: exceeded its CPU time limit"), true,
  "the owner-supplied wording with the possessive must match");
assert.equal(isD1TransientFaultBody("D1_ERROR: EXCEEDED CPU TIME LIMIT"), true, "matching is case-insensitive");
assert.equal(isD1TransientFaultBody('{"error":"D1_ERROR: exceeded CPU time limit"}'), true,
  "the predicate reads the raw JSON body the Worker actually sends");

// Ordinary 400 bodies. None names D1, so none may be retried.
for (const body of [
  '{"error":"families must be used alone and contain at most 50 entries"}',
  '{"error":"source must be used alone"}',
  '{"error":"source-family request has unknown fields","code":"unknown_field","field":"limit"}',
  '{"error":"confirm is required"}',
  "",
]) {
  assert.equal(isD1TransientFaultBody(body), false, `an ordinary 400 body must not be retryable: ${body || "(empty)"}`);
}

// A transient reason WITHOUT the D1 marker is not this fault. Keeping the marker
// mandatory is what stops an unrelated message from replaying a mutation.
assert.equal(isD1TransientFaultBody("exceeded CPU time limit"), false,
  "a reason with no D1 marker is not a D1 fault");
assert.equal(isD1TransientFaultBody("network connection lost"), false,
  "a reason with no D1 marker is not a D1 fault");
// A D1 marker with an unrecognized reason is not proved transient.
assert.equal(isD1TransientFaultBody("D1_ERROR: something nobody has seen yet"), false,
  "an unrecognized D1 reason is not assumed transient");

assert.equal(isD1TransientFaultBody(undefined), false);
assert.equal(isD1TransientFaultBody(null), false);
assert.ok(D1_TRANSIENT_FAULT_REASONS.length >= 2, "the transient subset is a named, inspectable list");
assert.ok(Object.isFrozen(D1_TRANSIENT_FAULT_REASONS), "the transient subset is frozen");

// ---------------------------------------------------------------------------
// The caller. A D1 400 retries; an ordinary 400 does not.
// ---------------------------------------------------------------------------

const FAMILIES = [{ base_doc_uid: "drive:a", keep_doc_uids: [] }];
// The shape validateForgetReceipt requires: documents must equal targets.length
// and dry_run must be explicitly false.
const FORGET_RECEIPT = { documents: 1, chunks: 1, vectors: 1, targets: ["drive:a"], dry_run: false };

function runReconcile(bodies) {
  let calls = 0;
  const slept = [];
  const fetchImpl = async () => {
    const body = bodies[Math.min(calls, bodies.length - 1)];
    calls += 1;
    return new Response(JSON.stringify(body.json), {
      status: body.status,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    result: reconcileDocumentFamilies({
      families: FAMILIES,
      base: "https://fixture.invalid",
      adminKey: "fixture-admin",
      fetchImpl,
      delayMs: 1,
      maxDelayMs: 1,
      sleep: async (ms) => { slept.push(ms); },
      onRetry: () => {},
    }),
    calls: () => calls,
    slept,
  };
}

// A D1 reset is retried to the bound and then reported, cursor not advanced.
{
  const run = runReconcile([{ status: 400, json: { error: "D1_ERROR: exceeded CPU time limit" } }]);
  await assert.rejects(run.result, /split-document cleanup failed/);
  assert.equal(run.calls(), 3, "a D1 400 must use all three bounded attempts");
  assert.equal(run.slept.length, 2, "a D1 400 must back off between attempts");
}

// A D1 reset that clears on the second attempt completes.
{
  const run = runReconcile([
    { status: 400, json: { error: "D1_ERROR: Network connection lost." } },
    { status: 200, json: FORGET_RECEIPT },
  ]);
  assert.equal(await run.result, 1, "a cleared D1 reset must finish the cleanup");
  assert.equal(run.calls(), 2, "a cleared D1 reset must not keep retrying");
}

// An ordinary 400 fails on attempt one. This is the proof that 400 did not
// become generally retryable.
{
  const run = runReconcile([
    { status: 400, json: { error: "families must be used alone and contain at most 50 entries" } },
  ]);
  await assert.rejects(run.result, /split-document cleanup failed/);
  assert.equal(run.calls(), 1, "an ordinary 400 was retried; 400 must not be generally retryable");
  assert.equal(run.slept.length, 0, "an ordinary 400 must not back off");
}

// A permanent D1 fault also fails on attempt one.
{
  const run = runReconcile([
    { status: 400, json: { error: "D1_ERROR: no such table: schema_migrations" } },
  ]);
  await assert.rejects(run.result, /split-document cleanup failed/);
  assert.equal(run.calls(), 1, "a permanent D1 fault must not be retried");
}

// A 500 still retries on status alone, unchanged by this work.
{
  const run = runReconcile([{ status: 500, json: { error: "internal" } }]);
  await assert.rejects(run.result, /split-document cleanup failed/);
  assert.equal(run.calls(), 3, "a 500 must still retry on status alone");
}

console.log("d1 transient fault: a D1 reset body is retryable where its 400 status is not, and an ordinary 400 still is not");
