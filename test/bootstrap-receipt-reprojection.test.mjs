/**
 * A bootstrap receipt may carry `reprojected_residue` while a residue-only
 * re-projection epoch is open (UPDATE-003, third lane). The aggregate-only
 * contract must accept it as optional: a Worker that reports it and one that
 * never does both complete, and a malformed value is refused.
 */
import assert from "node:assert/strict";
import { runAcceleratedBootstrap, validateAcceleratedBootstrapReceipt, ACCELERATED_BOOTSTRAP_STALL_MS } from "../brain.mjs";
import { createContinuousObservationClock } from "../operations/continuous-observation-clock.mjs";

const receipt = (o) => ({
  protocol: "bootstrap-v2", phase: "building", epoch: 5, total: 1213, confirmed: 13, queued: 1200,
  submitted: 0, remaining: 1200, in_flight_batches: 0, failed: 0, complete: false,
  vector_ready: false, expected_vectors: 1213, actual_vectors: 13, ...o,
});
const res = (body) => ({ status: 200, ok: true, text: async () => JSON.stringify(body) });
let clock = 0;
const opts = () => ({ now: () => clock, sleep: async (ms) => { clock += ms; }, maxDurationMs: 600_000 });
const done = receipt({ phase: "complete", epoch: 6, confirmed: 1213, queued: 0, remaining: 0, complete: true, vector_ready: true, actual_vectors: 1213 });

// Heartbeats count a long awake timer without trusting the timer's requested
// length. A single suspend-sized event-loop gap is excluded, and sampling then
// resumes normally.
{
  let wall = 100;
  let heartbeat = null;
  let heartbeatDelay = null;
  let clearCount = 0;
  let unrefed = false;
  const timer = { unref: () => { unrefed = true; } };
  const observed = createContinuousObservationClock({
    now: () => wall,
    startedAt: wall,
    heartbeatMs: 5_000,
    maximumTickGapMs: 10_000,
    setIntervalFn: (callback, milliseconds) => {
      heartbeat = callback;
      heartbeatDelay = milliseconds;
      return timer;
    },
    clearIntervalFn: (handle) => {
      assert.equal(handle, timer);
      clearCount += 1;
    },
  });
  assert.equal(heartbeatDelay, 5_000);
  assert.equal(unrefed, true, "the observation heartbeat does not keep the CLI alive");
  for (let elapsed = 0; elapsed < 20 * 60_000; elapsed += heartbeatDelay) {
    wall += heartbeatDelay;
    heartbeat();
  }
  assert.deepEqual(observed.checkpoint(), { observedElapsedMs: 20 * 60_000, excludedGapCount: 0 },
    "twenty awake minutes count even though one awaited timer could be that long");
  wall += 21 * 60_000;
  assert.deepEqual(observed.checkpoint(), { observedElapsedMs: 20 * 60_000, excludedGapCount: 1 },
    "a twenty-one-minute suspend gap does not consume semantic stall time");
  wall += 5_000;
  assert.deepEqual(observed.checkpoint(), { observedElapsedMs: 20 * 60_000 + 5_000, excludedGapCount: 1 });
  observed.stop();
  observed.stop();
  assert.equal(clearCount, 1, "the heartbeat is cleared exactly once when the runner stops");
}

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
// Closing a laptop during the ordinary poll timer used to spend the entire
// 15-minute no-movement budget in one jump. The first identical receipt after
// wake must remain inside the budget, then fresh progress can complete.
{
  clock = 0;
  const blocked = receipt({ phase: "legacy_drain", confirmed: 13, queued: 0, remaining: 1200,
    blocked_on: "fence", blocked_rows: 1 });
  const moved = receipt({ phase: "legacy_drain", confirmed: 14, queued: 0, remaining: 1199,
    actual_vectors: 14, blocked_on: "fence", blocked_rows: 1 });
  const seq = [blocked, blocked, moved, done];
  let i = 0;
  let slept = false;
  const out = await runAcceleratedBootstrap({
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      if (!slept) {
        slept = true;
        clock += ACCELERATED_BOOTSTRAP_STALL_MS + 60_000;
      }
    },
    maxDurationMs: 3 * 60 * 60_000,
    request: async () => res(seq[Math.min(i++, seq.length - 1)]),
  });
  assert.equal(out.complete, true, "a suspend-sized timer gap does not falsely declare the paused bootstrap stalled");
  assert.equal(i, 4, "the first identical post-wake receipt was accepted and fresh progress completed");
}
// The Worker may ask this runner to wait twenty minutes behind another bounded
// request. Sleeping for twenty-one real minutes during that supported backoff
// must not be called twenty-one awake minutes merely because it is close to the
// requested timer length.
{
  clock = 0;
  const blocked = receipt({ phase: "legacy_drain", confirmed: 13, queued: 0, remaining: 1200,
    blocked_on: "fence", blocked_rows: 1 });
  const moved = receipt({ phase: "legacy_drain", confirmed: 14, queued: 0, remaining: 1199,
    actual_vectors: 14, blocked_on: "fence", blocked_rows: 1 });
  const busy = {
    status: 409,
    ok: false,
    text: async () => JSON.stringify({
      protocol: "bootstrap-v2", busy: true, remaining: 1200, retry_after_seconds: 1200,
    }),
  };
  const seq = [res(blocked), busy, res(blocked), res(moved), res(done)];
  let i = 0;
  const out = await runAcceleratedBootstrap({
    now: () => clock,
    sleep: async (ms) => {
      clock += ms === 1_200_000 ? 21 * 60_000 : ms;
    },
    maxDurationMs: 3 * 60 * 60_000,
    request: async () => seq[Math.min(i++, seq.length - 1)],
  });
  assert.equal(out.complete, true, "a suspend overlapping the longest supported busy backoff resumes safely");
  assert.equal(i, 5);
}
// The raw six-hour boundary remains authoritative even though an unobserved
// suspend gap is excluded from the shorter movement budget.
{
  clock = 0;
  const blocked = receipt({ phase: "legacy_drain", confirmed: 13, queued: 0, remaining: 1200,
    blocked_on: "fence", blocked_rows: 1 });
  let slept = false;
  await assert.rejects(
    runAcceleratedBootstrap({
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        if (!slept) {
          slept = true;
          clock += 7 * 60 * 60_000;
        }
      },
      request: async () => res(blocked),
    }),
    /6-hour wall-clock safety limit[\s\S]*Worker remains paused/,
    "a suspend that crosses the outer wall-clock boundary still fails closed",
  );
}
// The raw boundary is enforced after every awaited stage, not only before an
// attempt starts. An expired hook or HTTP operation can never return a receipt
// that is accepted as completion.
{
  clock = 0;
  let requested = false;
  await assert.rejects(
    runAcceleratedBootstrap({
      now: () => clock,
      beforeRequest: async () => { clock += 7 * 60 * 60_000; },
      request: async () => { requested = true; return res(done); },
    }),
    /6-hour wall-clock safety limit[\s\S]*Worker remains paused/,
    "a seven-hour preflight hook cannot start an expired request",
  );
  assert.equal(requested, false);
}
{
  clock = 0;
  let bodyRead = false;
  let postflightRan = false;
  await assert.rejects(
    runAcceleratedBootstrap({
      now: () => clock,
      request: async () => {
        clock += 7 * 60 * 60_000;
        return { status: 200, ok: true, text: async () => { bodyRead = true; return JSON.stringify(done); } };
      },
      afterRequest: async () => { postflightRan = true; },
    }),
    /6-hour wall-clock safety limit[\s\S]*Worker remains paused/,
    "a request that returns after seven hours cannot complete the bootstrap",
  );
  assert.equal(bodyRead, false, "the expired response body is not accepted");
  assert.equal(postflightRan, true, "the postflight pin check still runs after the expired request");
}
{
  clock = 0;
  let postflightRan = false;
  await assert.rejects(
    runAcceleratedBootstrap({
      now: () => clock,
      request: async () => ({
        status: 200,
        ok: true,
        text: async () => {
          clock += 7 * 60 * 60_000;
          return JSON.stringify(done);
        },
      }),
      afterRequest: async () => { postflightRan = true; },
    }),
    /6-hour wall-clock safety limit[\s\S]*Worker remains paused/,
    "a response body that arrives after seven hours cannot complete the bootstrap",
  );
  assert.equal(postflightRan, true);
}
{
  clock = 0;
  await assert.rejects(
    runAcceleratedBootstrap({
      now: () => clock,
      request: async () => res(done),
      afterRequest: async () => { clock += 7 * 60 * 60_000; },
    }),
    /6-hour wall-clock safety limit[\s\S]*Worker remains paused/,
    "a postflight hook that crosses the wall cannot release a completion receipt",
  );
}
// Fresh aggregate movement resets the continuously observed quiet budget.
{
  clock = 0;
  const blocked = receipt({ phase: "legacy_drain", confirmed: 13, queued: 0, remaining: 1200,
    blocked_on: "fence", blocked_rows: 1 });
  const moved = receipt({ phase: "legacy_drain", confirmed: 14, queued: 0, remaining: 1199,
    actual_vectors: 14, blocked_on: "fence", blocked_rows: 1 });
  let i = 0;
  const original = console.log;
  console.log = () => {};
  try {
    const out = await runAcceleratedBootstrap({
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      maxDurationMs: 3 * 60 * 60_000,
      request: async () => {
        i += 1;
        if (i <= 300) return res(blocked);
        if (i <= 600) return res(moved);
        return res(done);
      },
    });
    assert.equal(out.complete, true, "fresh movement resets the observed no-progress budget");
    assert.equal(i, 601);
  } finally {
    console.log = original;
  }
}
// Transport failures provide no comparable aggregate receipt. Their awake
// request and retry time must remain bounded by retry/raw timers, but must not
// be misreported as an unchanged-receipt fence stall.
{
  clock = 0;
  const blocked = receipt({ phase: "legacy_drain", confirmed: 13, queued: 0, remaining: 1200,
    blocked_on: "fence", blocked_rows: 1 });
  const moved = receipt({ phase: "legacy_drain", confirmed: 14, queued: 0, remaining: 1199,
    actual_vectors: 14, blocked_on: "fence", blocked_rows: 1 });
  let requests = 0;
  const sleeps = [];
  const original = console.log;
  console.log = () => {};
  try {
    const out = await runAcceleratedBootstrap({
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
      maxDurationMs: 3 * 60 * 60_000,
      request: async () => {
        requests += 1;
        if (requests <= 300) return res(blocked);
        if (requests === 301) {
          clock += 10_000;
          const error = new Error("test transport interruption");
          error.retryable = true;
          throw error;
        }
        if (requests === 302) return res(blocked);
        if (requests === 303) return res(moved);
        return res(done);
      },
    });
    assert.equal(out.complete, true, "transport-unobserved time does not become a semantic stall cause");
    assert.equal(requests, 304);
    assert.ok(sleeps.includes(2_000), "the bounded transient retry timer still ran");
  } finally {
    console.log = original;
  }
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
  // Worker-shaped: quarantined rows ARE the `failed` count and are excluded from
  // `retrying` (store-d1 counts retrying only for unquarantined attempts); the
  // walk has ended (phase waiting).
  const blocked = receipt({ phase: "waiting", confirmed: 1163, queued: 50, remaining: 50, failed: 50, retrying: 0,
    actual_vectors: 1163, blocked_on: "quarantine", blocked_rows: 50 });
  await assert.rejects(
    runAcceleratedBootstrap({ ...opts(), request: async () => { i++; return res(blocked); } }),
    /50 quarantined row\(s\)[\s\S]*vector-retry[\s\S]*brain forget/,
    "quarantine is refused by name with both remedies, before the not-yet-visible wait");
  assert.equal(i, 1, "refused on the first receipt, no waiting");
}
// A cleanup receipt naming the fence waits the movement budget, then dies naming the fence.
// The fence is announced ONCE on the way, not on every poll.
{
  clock = 0; let i = 0;
  const blocked = receipt({ phase: "legacy_drain", confirmed: 13, queued: 0, remaining: 1200, blocked_on: "fence", blocked_rows: 1 });
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.join(" ")); };
  try {
    await assert.rejects(
      runAcceleratedBootstrap({ ...opts(), maxDurationMs: 3_600_000, request: async () => { i++; return res(blocked); } }),
      /ordering fence did not open for 1 submitted row/,
      "a stranded fence is named as the fence, not as a slow drain");
  } finally { console.log = original; }
  assert.ok(clock >= ACCELERATED_BOOTSTRAP_STALL_MS, `time-bounded by the movement budget, clock=${clock}`);
  const announced = lines.filter((line) => /waiting on the index's ordering fence/.test(line)).length;
  assert.equal(announced, 1, `fence announced once across ${i} polls, saw ${announced}`);
}
// blocked_rows without blocked_on is a contract violation, not a silently ignored number.
{
  await assert.rejects(async () => validateAcceleratedBootstrapReceipt(receipt({ blocked_rows: 5 })), /contract/,
    "blocked_rows alone is refused");
}
// An unknown cause is a contract violation.
{
  await assert.rejects(async () => validateAcceleratedBootstrapReceipt(receipt({ blocked_on: "weather" })), /contract/,
    "an unknown blocked_on is refused");
}
console.log("bootstrap-receipt-reprojection: all checks passed");
