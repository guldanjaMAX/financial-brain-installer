import { isD1TransientFaultBody as transientD1Failure } from "./d1-transient-fault.mjs";

const transientMember = (result) => result.status === "failed" && (
  transientD1Failure(result.error) ||
  result.error === "ingest finalization failed; retry this document" ||
  result.error === "ingest revision could not be verified; retry this document"
);

const transientResponse = (res, raw) => {
  if ([408, 425, 429].includes(res.status) || res.status >= 500) return true;
  if (res.status !== 400) return false;
  try { return transientD1Failure(JSON.parse(raw)?.error); } catch { return false; }
};

/**
 * Retry only unresolved members, preserving every exact accepted receipt.
 * The caller supplies a single-attempt idempotent POST and its normal receipt
 * validator. One shared budget bounds HTTP, transport and finalization retries.
 * Exhaustion is a failed receipt, never invented acceptance: the Gmail runner
 * must durably retain the logical identities before advancing its cursor.
 */
export async function retryIngestFinalization({
  docs, send, validate, assertOwned = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onRetry = () => {},
}) {
  let pending = docs;
  const settled = new Map();
  const attempts = 5;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    assertOwned?.();
    let response;
    try { response = await send(pending); }
    catch (error) {
      if (error?.retryable !== true) throw error;
    }
    if (response) {
      const { res, raw } = response;
      if (res.ok) {
        // Validate the complete subset before trusting any one member. Missing,
        // duplicated or foreign acknowledgements must keep the cursor pinned.
        const results = validate(JSON.parse(raw), pending);
        const retryIds = new Set();
        for (const result of results) {
          if (transientMember(result)) retryIds.add(String(result.source_id));
          else settled.set(String(result.source_id), result);
        }
        pending = pending.filter((doc) => retryIds.has(String(doc.source_id)));
      } else if (!transientResponse(res, raw)) {
        return response;
      }
    }
    if (pending.length === 0) break;
    if (attempt < attempts) {
      onRetry(attempt, attempts - 1);
      await sleep(2000 * (2 ** (attempt - 1)));
    }
  }
  // Do not retain provider error bodies, document text, or partial receipts in
  // retry state. The normal family settlement stores only the logical ids.
  for (const doc of pending) settled.set(String(doc.source_id), {
    source_id: doc.source_id, status: "failed",
    error: "ingest finalization remains unconfirmed after bounded retries",
  });
  const results = docs.map((doc) => settled.get(String(doc.source_id)));
  const tally = { created: 0, updated: 0, unchanged: 0, refused: 0, failed: 0 };
  for (const result of results) tally[result.status]++;
  const raw = JSON.stringify({ ...tally, total: results.length, results });
  return { res: new Response(raw, { status: 200 }), raw };
}
