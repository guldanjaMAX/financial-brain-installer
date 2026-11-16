// 11-16: a large Brain's database briefly refused the read-only part readback
// right after a Gmail write batch ("D1 DB is overloaded"), failing every daily
// Gmail run. The readback now waits and reads again for that transient refusal
// only, and still fails at once for any other error.
import assert from "node:assert/strict";
import test from "node:test";
import { readCurrentIngestParts, setPartReadbackSleepForTest, PART_READBACK_RETRY_DELAYS_MS } from "../operations/ingest-part-proof.mjs";

const hash = "a".repeat(64);
const proof = { geometry: { size: 1500, overlap: 300 }, parts: [{ source_id: "m1", content_hash: hash, chunk_count: 1 }] };
const okBody = () => JSON.stringify({ source: "gmail", database: { instance: "1".repeat(32), nonce: "2".repeat(32), generation: 7 },
  geometry: { size: 1500, overlap: 300 }, parts: [{ source_id: "m1", content_hash: hash, chunk_count: 1 }] });
const overloaded = () => new Response(JSON.stringify({ error: "D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window." }), { status: 500 });

function run(responses, extra = {}) {
  const calls = [];
  const waits = [];
  setPartReadbackSleepForTest(async ms => { waits.push(ms); });
  const request = async () => { calls.push(1); const next = responses.shift(); return typeof next === "function" ? next() : next; };
  return { calls, waits, promise: readCurrentIngestParts({ base: "https://brain.invalid", adminKey: "k", source: "gmail", proof, request, ...extra }) };
}

test("transient D1 overload: waits and reads again, then confirms the part", async () => {
  const { calls, waits, promise } = run([overloaded, overloaded, () => new Response(okBody(), { status: 200 })]);
  const result = await promise;
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, PART_READBACK_RETRY_DELAYS_MS.slice(0, 2));
  assert.equal(result.parts.length, 1);
});

test("CPU reset wording is also treated as transient", async () => {
  const reset = () => new Response(JSON.stringify({ error: "D1_ERROR: Database reset because it exceeded its CPU time limit" }), { status: 500 });
  const { calls, promise } = run([reset, () => new Response(okBody(), { status: 200 })]);
  assert.equal((await promise).parts.length, 1);
  assert.equal(calls.length, 2);
});

test("any other server error still fails at once, with no retry", async () => {
  const { calls, waits, promise } = run([() => new Response(JSON.stringify({ error: "something else" }), { status: 500 })]);
  await assert.rejects(promise, /readback failed/);
  assert.equal(calls.length, 1);
  assert.equal(waits.length, 0);
});

test("a refusal that never clears stops after the bounded retries", async () => {
  const { calls, promise } = run([overloaded, overloaded, overloaded, overloaded, overloaded]);
  await assert.rejects(promise, /readback failed/);
  assert.equal(calls.length, PART_READBACK_RETRY_DELAYS_MS.length + 1);
});

test("no retry wait is started past the caller's deadline", async () => {
  let t = 0;
  const { calls, waits, promise } = run([overloaded, () => new Response(okBody(), { status: 200 })], { deadlineAt: 1500, now: () => t });
  await assert.rejects(promise, /readback failed/);
  assert.equal(calls.length, 1);
  assert.equal(waits.length, 0);
});

test("a client error is never retried", async () => {
  const { calls, promise } = run([() => new Response(JSON.stringify({ error: "Part readback needs bounded exact source identities." }), { status: 400 })]);
  await assert.rejects(promise, /readback failed/);
  assert.equal(calls.length, 1);
});
