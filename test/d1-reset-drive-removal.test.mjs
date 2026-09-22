/**
 * A D1 reset during a bounded Drive removal group used to be swallowed. The
 * swallow wrote a state.removed marker for every family in the group, added to a
 * pending count nothing read, and let the run continue to the source-inventory
 * readback, which found the families still stored and failed with a message
 * about the READBACK. The operator was never told the database reset, and the
 * fault was named three steps away from where it happened.
 *
 * These tests drive the real applyDriveRemovals with an injected fetch.
 */
import assert from "node:assert/strict";

import { applyDriveRemovals } from "../brain.mjs";

const UIDS = ["drive:a", "drive:b"];
const RECEIPT = { documents: 2, chunks: 2, vectors: 2, targets: UIDS, dry_run: false };

function reply(status, json) {
  return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
}

function run(responder, { uids = UIDS } = {}) {
  const state = {};
  const warnings = [];
  return {
    state,
    warnings,
    result: applyDriveRemovals({
      uids,
      base: "https://fixture.invalid",
      adminKey: "fixture-admin",
      state,
      dryRun: false,
      label: "Drive source deletion",
      fetchImpl: responder,
    }),
  };
}

// A D1 reset stops the run, names the database, and records NOTHING.
{
  const attempt = run(async () => reply(400, { error: "D1_ERROR: exceeded CPU time limit" }));
  await assert.rejects(attempt.result, (error) => {
    assert.match(error.message, /temporary\s+Cloudflare D1 limit/,
      "the operator must be told the database reset, not shown a readback message");
    assert.match(error.message, /nothing was recorded as removed/i);
    assert.match(error.message, /source cursor was not advanced/i);
    assert.doesNotMatch(error.message, /readback/i,
      "the fault must be named where it happened, not blamed on the inventory readback");
    return true;
  });
  assert.deepEqual(attempt.state.removed, undefined,
    "a D1 reset must not write a completed-removal marker for a family that was never removed");
}

// The same holds for the other transient D1 spelling.
{
  const attempt = run(async () => reply(400, { error: "D1_ERROR: Network connection lost." }));
  await assert.rejects(attempt.result, /temporary\s+Cloudflare D1 limit/);
  assert.deepEqual(attempt.state.removed, undefined);
}

// A PERMANENT D1 fault is not this fault. It keeps the existing pending path, so
// the run is not converted into a stop that repeating cannot clear.
{
  const attempt = run(async () => reply(400, { error: "D1_ERROR: no such table: schema_migrations" }));
  const result = await attempt.result;
  assert.equal(result.applied, 0);
  assert.equal(result.pending, 2, "a permanent D1 fault still records pending removals");
  assert.equal(Object.keys(attempt.state.removed || {}).length, 2,
    "a permanent D1 fault still retains its families for the next run");
}

// An ordinary transport or refusal failure keeps exactly its old behaviour.
{
  const attempt = run(async () => reply(500, { error: "internal" }));
  const result = await attempt.result;
  assert.equal(result.pending, 2, "an unrelated failure still records pending removals");
  assert.equal(Object.keys(attempt.state.removed || {}).length, 2,
    "an unrelated failure still retains its families for the next run");
}
{
  const attempt = run(async () => { throw new Error("connection reset"); });
  const result = await attempt.result;
  assert.equal(result.pending, 2, "a transport failure still records pending removals");
  assert.equal(Object.keys(attempt.state.removed || {}).length, 2);
}

// A success still applies, and records no pending.
{
  const attempt = run(async () => reply(200, RECEIPT));
  const result = await attempt.result;
  assert.equal(result.applied, 2);
  assert.equal(result.pending, 0);
  assert.deepEqual(attempt.state.removed, undefined, "a clean removal leaves no markers");
}

// A D1 reset on a LATER group does not keep the earlier group's applied count as
// a completed run: the whole sync stops.
{
  let calls = 0;
  const many = Array.from({ length: 60 }, (_unused, i) => `drive:${i}`);
  const attempt = run(async () => {
    calls += 1;
    if (calls === 1) {
      return reply(200, {
        documents: 50, chunks: 50, vectors: 50,
        targets: many.slice(0, 50), dry_run: false,
      });
    }
    return reply(400, { error: "D1_ERROR: exceeded CPU time limit" });
  }, { uids: many });
  await assert.rejects(attempt.result, /temporary\s+Cloudflare D1 limit/);
  assert.equal(calls, 2, "removals are still sent in bounded groups of 50");
  assert.deepEqual(attempt.state.removed, undefined,
    "the failed second group must not be marked, and the applied first group needs no marker");
}

console.log("d1 reset drive removal: a database reset stops the run and is named where it happened");
