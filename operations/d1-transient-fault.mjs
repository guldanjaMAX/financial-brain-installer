/**
 * The one response-body shape that identifies a Cloudflare D1 fault worth
 * repeating.
 *
 * PROVENANCE. The production string was captured on 2026-09-22 and supplied
 * verbatim, confirmed with od -c:
 *
 *   D1_ERROR: D1 DB exceeded its CPU time limit and was reset.
 *
 * It reaches the CLI as:
 *   SITE 1  source-family inventory was not accepted (500): D1_ERROR: D1 DB
 *           exceeded its CPU time limit and was reset.
 *   SITE 2  split-document cleanup failed: HTTP 400: D1_ERROR: D1 DB exceeded
 *           its CPU time limit and was reset.
 *
 * Production says "exceeded ITS CPU time limit". This repository's eight
 * D1_ERROR test fixtures say "exceeded CPU time limit" with no possessive, which
 * is a string production does not emit. Both spellings now have a witness, so
 * the possessive stays optional rather than narrowed to either. Correcting the
 * other fixtures is a separate cleanup and not this module's job.
 *
 * WHY A SUBSET, AND WHY NOT "was reset". Not every D1_ERROR is transient, and
 * repeating a permanent one spends more of the budget that is already failing.
 * Matching the trailing "and was reset" alone would be too loose: a permanent D1
 * error that happens to mention a reset would be replayed forever. So the
 * transient cases stay enumerated.
 *   transient  exceeded [its] CPU time limit   a per-invocation ceiling that
 *              varies with load, so the identical query can pass on a retry.
 *   transient  network connection lost         the interrupted round trip.
 *   PERMANENT  no such table                   a migration fixes it, a retry cannot.
 *   PERMANENT  free tier daily row read limit  a 24 hour account quota. Bounded
 *              retry cannot clear it, and every attempt reads more rows.
 *   PERMANENT  query exceeded the memory limit deterministic in the query shape.
 *
 * THE REASON IS ANCHORED TO ITS MARKER. A body can carry a PERMANENT D1 error
 * and an unrelated transient phrase somewhere else entirely. Matching the two
 * independently would replay exactly the daily-quota case this split exists to
 * refuse, so a reason only counts inside the D1 message it belongs to, and
 * reason whitespace never crosses a line boundary.
 */

/** Intra-line whitespace. \s would let one reason span two unrelated lines. */
const GAP = "[^\\S\\r\\n]+";

export const D1_TRANSIENT_FAULT_REASONS = Object.freeze([
  new RegExp(`exceeded${GAP}(?:its${GAP})?CPU${GAP}time${GAP}limit`, "i"),
  new RegExp(`network${GAP}connection${GAP}lost`, "i"),
]);

/** A D1 message ends at a line break or at the close of the JSON string holding it. */
const D1_MESSAGE_END = /[\r\n"]/;

/**
 * True only for a body that names D1 and, in that same message, gives a reason
 * repeating can actually clear. Deliberately narrower than the generic HTTP
 * status rules: a body this does not recognize keeps whatever its status decided.
 */
export function isD1TransientFaultBody(raw) {
  // This decides whether a DESTRUCTIVE request is replayed. Every caller hands
  // it the string from res.text(), so anything else is a programming error
  // rather than a response, and the safe answer to one of those is "do not
  // replay". Failing closed also makes hostile input a non-question: nothing is
  // converted, so nothing can throw, and a Symbol cannot smuggle a marker in
  // through its description.
  if (typeof raw !== "string") return false;
  const text = raw;
  for (const match of text.matchAll(/D1_ERROR/gi)) {
    const rest = text.slice(match.index + match[0].length);
    const end = rest.search(D1_MESSAGE_END);
    const message = end === -1 ? rest : rest.slice(0, end);
    if (D1_TRANSIENT_FAULT_REASONS.some((reason) => reason.test(message))) return true;
  }
  return false;
}

/**
 * Name a D1 reset where it happened, during a bounded removal group.
 *
 * Without this the fault is swallowed and the run continues to an inventory
 * readback that finds the families still stored, so the operator is shown a
 * message about the READBACK for a fault that happened three steps earlier and
 * is never told that the database reset.
 *
 * It says "could not be confirmed", not "nothing was removed". A reset can land
 * mid-batch, so part of the group may already be gone on the server. What is
 * true from here is that no removal in this group was confirmed and none was
 * recorded.
 */
export function d1ResetDuringRemovalMessage({ label, count }) {
  return (
    `${count} ${label}(s) could not be confirmed as removed: the brain's database hit a ` +
    "temporary Cloudflare D1 limit and reset while the request was running.\n" +
    "      A reset can land mid-batch, so some of this group may already be gone.\n" +
    "      Nothing was recorded as removed, and the next run re-reads the source inventory first.\n" +
    "      The source cursor was not advanced. Re-running the same sync retries exactly these families."
  );
}
