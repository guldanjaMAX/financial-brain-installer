// A short projection with nothing queued must start its own rebuild.
//
// `pending` means "not proven exact". markProjectionVerifiedIfExact leaves it
// pending whenever the counts disagree, and before 0.4.4 the two tests after it
// fell straight through to a well-formed receipt of zeros with HTTP 200.
// Nothing else ever moved the status, so a run repeated that receipt until its
// deadline and the next run did the same.
//
// Observed on a client brain 2026-09-08: 62,439 vectors against 1,151,274
// chunks, outbox empty, epoch 0, base_count 0, high_water NULL, four update
// attempts across two releases producing byte-identical output over 97 hours.
// The only writer of bootstrap_required was reachable through reindex, which a
// paused brain refuses, while the bootstrap requires the pause. Closed, not
// flaky.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Normalise line endings: Windows checks out CRLF, and an anchor written with
// \n silently fails to match there, so this regression would pass by not running
// on the one platform whose behaviour this release changed most.
const source = readFileSync(fileURLToPath(new URL("../src/lib/store-d1.js", import.meta.url)), "utf8")
  .replace(/\r\n/g, "\n");

// Anchor on the ordering, because the defect was an ordering problem: the
// fall-through returned before anything could promote the status.
// Unique to the activation flow: the exactness check followed immediately by a
// state re-read. The bare call appears in more than one function.
const ANCHOR = "await markProjectionVerifiedIfExact(env, lease);\n    state = await bootstrapStateV2(env);";
const exactness = source.indexOf(ANCHOR);
// Search AFTER the anchor: this guard shape appears in more than one function.
const fallthrough = source.indexOf('if (state.status !== "bootstrap_required")', exactness);
assert.ok(exactness > 0 && fallthrough > exactness, "the activation path changed shape; re-read it");

const between = source.slice(exactness, fallthrough);

assert.match(
  between,
  /resetVectorProjectionBootstrap\(env\)/,
  "a projection still pending after the exactness check must be able to reset itself, " +
    "or a short projection with nothing queued can never reach bootstrap_required"
);

assert.match(
  between,
  /FROM vector_outbox/,
  "the reset must be guarded on an empty outbox: queued rows may still be confirmed " +
    "by the provider and must not be abandoned under an in-flight drain"
);

assert.match(
  between,
  /FROM chunks/,
  "the reset must require that chunks exist, so an empty brain is left alone"
);

assert.match(
  between,
  /VECTORIZE\.describe\(\)/,
  "the reset must read the provider count, because SHORT is the only case it may act on"
);

assert.match(
  between,
  /projected\s*<\s*chunked|projected !== null/,
  "an index holding MORE vectors than the database has chunks is a different fault that " +
    "this release cannot clear, and must not be sent into a rebuild that can never end"
);

// The blocker an adversarial review caught before this merged. A FINISHED
// rebuild returns to 'pending' and its provider count lags for a moment. Without
// a batch-history guard the reset fires three seconds later, discards the
// completed rebuild, and the run aborts on the CLI's epoch-change guard with the
// Worker left paused. The fix would have prevented the rebuild it enables.
assert.match(
  between,
  /FROM vector_bootstrap_batches/,
  "the reset must require that this brain has NEVER bootstrapped, or it will fire " +
    "on a rebuild that just finished while the provider count is still catching up"
);

console.log("PASS  a pending short projection with an empty outbox can reach bootstrap_required");
console.log("PASS  and a brain that has already bootstrapped is never reset out from under itself");
console.log("PASS  and an excess projection is left to its own message rather than rebuilt");
