/**
 * A bootstrap receipt may carry `reprojected_residue` while a residue-only
 * re-projection epoch is open (UPDATE-003, third lane). The aggregate-only
 * contract must accept it as optional: a Worker that reports it and one that
 * never does both complete, and a malformed value is refused.
 */
import assert from "node:assert/strict";
import { runAcceleratedBootstrap, validateAcceleratedBootstrapReceipt, ACCELERATED_BOOTSTRAP_STALL_MS } from "../brain.mjs";

const receipt = (o) => ({
  protocol: "bootstrap-v2", phase: "building", epoch: 5, total: 1213, confirmed: 13, queued: 1200,
  submitted: 0, remaining: 1200, in_flight_batches: 0, failed: 0, complete: false,
  vector_ready: false, expected_vectors: 1213, actual_vectors: 13, ...o,
});
const res = (body) => ({ status: 200, ok: true, text: async () => JSON.stringify(body) });
let clock = 0;
const opts = () => ({ now: () => clock, sleep: async (ms) => { clock += ms; }, maxDurationMs: 600_000 });
const done = receipt({ phase: "complete", epoch: 6, confirmed: 1213, queued: 0, remaining: 0, complete: true, vector_ready: true, actual_vectors: 1213 });

{
  const seq = [receipt({ reprojected_residue: 1200 }), receipt({ reprojected_residue: 1200, confirmed: 1013, queued: 200, remaining: 200 }), done];
  let i = 0;
  const out = await runAcceleratedBootstrap({ ...opts(), request: async () => res(seq[Math.min(i++, seq.length - 1)]) });
  assert.equal(out.complete, true, "receipts carrying reprojected_residue validate and the update completes");
  assert.equal(i, 3);
}
{
  const seq = [receipt(), done];
  let i = 0;
  const out = await runAcceleratedBootstrap({ ...opts(), request: async () => res(seq[Math.min(i++, seq.length - 1)]) });
  assert.equal(out.complete, true, "receipts without the optional field still complete");
}
{
  const v = validateAcceleratedBootstrapReceipt(receipt({ reprojected_residue: 1200 }));
  assert.equal(v.reprojected_residue, 1200, "the optional count is carried onto the validated receipt");
  assert.equal(validateAcceleratedBootstrapReceipt(receipt()).reprojected_residue, undefined);
  await assert.rejects(async () => validateAcceleratedBootstrapReceipt(receipt({ reprojected_residue: -1 })), /count|complete/i,
    "a negative count is refused");
}

// A cleanup receipt naming quarantine ends the update at once, by name, with the remedy.
{
  clock = 0; let i = 0;
  const blocked = receipt({ phase: "legacy_drain", confirmed: 13, queued: 0, remaining: 1200, blocked_on: "quarantine", blocked_rows: 50 });
  await assert.rejects(
    runAcceleratedBootstrap({ ...opts(), request: async () => { i++; return res(blocked); } }),
    /50 quarantined row\(s\)[\s\S]*vector-retry[\s\S]*brain forget/,
    "quarantine is refused by name with both remedies");
  assert.equal(i, 1, "refused on the first receipt, no waiting");
}
// A cleanup receipt naming the fence waits the movement budget, then dies naming the fence.
{
  clock = 0; let i = 0;
  const blocked = receipt({ phase: "legacy_drain", confirmed: 13, queued: 0, remaining: 1200, blocked_on: "fence", blocked_rows: 1 });
  await assert.rejects(
    runAcceleratedBootstrap({ ...opts(), maxDurationMs: 3_600_000, request: async () => { i++; return res(blocked); } }),
    /ordering fence did not open for 1 submitted row/,
    "a stranded fence is named as the fence, not as a slow drain");
  assert.ok(clock >= ACCELERATED_BOOTSTRAP_STALL_MS, `time-bounded by the movement budget, clock=${clock}`);
}
// An unknown cause is a contract violation.
{
  await assert.rejects(async () => validateAcceleratedBootstrapReceipt(receipt({ blocked_on: "weather" })), /contract/,
    "an unknown blocked_on is refused");
}
console.log("bootstrap-receipt-reprojection: all checks passed");
