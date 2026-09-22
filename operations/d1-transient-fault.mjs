/**
 * The one response-body shape that identifies a Cloudflare D1 fault worth
 * repeating, for a request whose HTTP status does not already say so.
 *
 * A D1 CPU-limit reset reaches the CLI through the forget route's families
 * sub-branch, which maps every exception to 400 (worker/src/index.js:3224-3228).
 * 400 is not retryable and must not become retryable, so the body is the only
 * thing left that can tell a transient D1 fault from an ordinary bad request.
 *
 * PROVENANCE, READ THIS BEFORE WIDENING IT. This text is NOT production-observed
 * in this repository. Nothing in worker/src or brain.mjs produces, parses or
 * matches "D1_ERROR"; its only witnesses are eight hand-typed test fixtures:
 *   test/checksum-reconciliation.test.mjs:216   no such table: schema_migrations
 *   test/database-read-failure.test.mjs:13      free tier daily row read limit
 *   test/database-read-failure.test.mjs:15      the assertion on that message
 *   test/diagnose.test.mjs:823                  exceeded CPU time limit
 *   test/message-session.test.mjs:174           Network connection lost.
 *   worker/test/routes.test.mjs:4958            exceeded CPU time limit
 *   worker/test/source-inventory.test.mjs:843   query exceeded the memory limit
 *   worker/test/spend-cap.test.mjs:40           network connection lost
 * When a real captured body arrives, this file is the single place to change and
 * it has its own direct tests.
 *
 * ON THE POSSESSIVE. The wording specified for this work was "exceeded its CPU
 * time limit". This repository's own fixtures say "exceeded CPU time limit",
 * with no possessive, so a pattern carrying "its" would match none of its own
 * witnesses. Which one Cloudflare actually emits is not established here, so the
 * possessive is optional rather than guessed at.
 *
 * NOT EVERY D1_ERROR IS TRANSIENT, and repeating a permanent one spends more of
 * the budget that is already failing:
 *   transient  exceeded CPU time limit   a per-invocation ceiling that depends on
 *              load, so the identical query can pass on a later attempt.
 *   transient  network connection lost   the classic interrupted round trip.
 *   PERMANENT  no such table             a schema problem. A migration fixes it;
 *              a retry cannot.
 *   PERMANENT  free tier daily row read limit   a 24 hour account quota.
 *              Seconds of bounded retry cannot clear it, and each attempt reads
 *              more rows. brain.mjs already explains this one to the operator in
 *              databaseReadFailureDetail, including that it resets at midnight UTC.
 *   PERMANENT  query exceeded the memory limit   a deterministic property of the
 *              query shape, so an identical retry fails identically.
 */
export const D1_FAULT_MARKER = /D1_ERROR/i;

export const D1_TRANSIENT_FAULT_REASONS = Object.freeze([
  /exceeded\s+(?:its\s+)?CPU\s+time\s+limit/i,
  /network\s+connection\s+lost/i,
]);

/**
 * True only for a body that both names D1 and names a reason that repeating can
 * actually clear. Deliberately narrower than the generic HTTP status rules: a
 * body this does not recognize keeps whatever its status already decided.
 */
export function isD1TransientFaultBody(raw) {
  const text = String(raw ?? "");
  if (!D1_FAULT_MARKER.test(text)) return false;
  return D1_TRANSIENT_FAULT_REASONS.some((reason) => reason.test(text));
}

/**
 * Name a D1 reset where it happened, during a bounded removal group.
 *
 * Without this the fault is swallowed and the run continues to an inventory
 * readback that finds the families still stored, so the operator is shown a
 * message about the readback for a fault that happened three steps earlier and
 * is never told that the database reset.
 */
export function d1ResetDuringRemovalMessage({ label, count }) {
  return (
    `${count} ${label}(s) could not be removed: the brain's database hit a temporary ` +
    "Cloudflare D1 limit and reset while the request was running.\n" +
    "      Nothing in this group was removed, and nothing was recorded as removed.\n" +
    "      The source cursor was not advanced. Re-running the same sync retries exactly these families."
  );
}
