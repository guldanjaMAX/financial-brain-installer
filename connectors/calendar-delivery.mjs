import { createHash } from "node:crypto";

// The local checkpoint binds acknowledgments to the exact outgoing revision.
// Re-reading Google is safe even if event ordering or payloads have changed.
export async function sendCalendarWindows({
  envelopes, deletions, scope, checkpoint, readStored, saveCheckpoint, sendWindow,
}) {
  const savedItems = checkpoint.scope === scope && Array.isArray(checkpoint.items) ? checkpoint.items : [];
  const items = new Map(savedItems.filter(Array.isArray));
  // A reviewed cancellation can remove an earlier acknowledged revision
  // while the old Google token is still held.
  const cachedItems = items.size;
  for (const { source_id } of deletions) items.delete(calendarDeliveryDigest(source_id));
  if (items.size !== cachedItems) saveCheckpoint({ scope, items: [...items] });

  const sent = { created: 0, updated: 0, unchanged: 0, resumed_skipped: 0, refused: [], errors: [], total: envelopes.length };
  const windowSize = 25;
  const candidates = envelopes.map((envelope) => ({
    envelope,
    key: calendarDeliveryDigest(envelope.source_id),
    revision: envelope.metadata.calendar_revision,
  }));
  const acknowledged = candidates.filter(({ key, revision }) =>
    items.get(key)?.revision === revision && items.get(key)?.code === "accepted");
  const stored = acknowledged.length ? await readStored(acknowledged.map(({ envelope }) => envelope)) : new Set();
  const pending = candidates.filter(({ envelope }) => !stored.has(envelope.source_id));
  sent.resumed_skipped = candidates.length - pending.length;
  for (let offset = 0; offset < pending.length; offset += windowSize) {
    const window = pending.slice(offset, offset + windowSize);
    const result = await sendWindow(window.map(({ envelope }) => envelope));
    const failures = new Map([
      ...result.errors.map(({ source_id }) => [source_id, "INGEST_FAILED"]),
      ...result.refused.map(({ source_id }) => [source_id, "INPUT_REFUSED"]),
    ]);
    // A malformed batch result must leave the whole window eligible for
    // replay. Failure records never count as delivery acknowledgments.
    const accepted = [result.created, result.updated, result.unchanged];
    if (accepted.some((count) => !Number.isSafeInteger(count) || count < 0) ||
        result.created + result.updated + result.unchanged + failures.size !== window.length ||
        result.errors.length + result.refused.length !== failures.size ||
        window.filter(({ envelope }) => failures.has(envelope.source_id)).length !== failures.size) {
      throw new Error("Calendar delivery window did not account for every event");
    }
    for (const { envelope, key, revision } of window) {
      const code = failures.get(envelope.source_id);
      items.set(key, code ? { code } : { revision, code: "accepted" });
    }
    saveCheckpoint({ scope, items: [...items] });
    sent.created += result.created;
    sent.updated += result.updated;
    sent.unchanged += result.unchanged;
    sent.refused.push(...result.refused);
    sent.errors.push(...result.errors);
  }
  return sent;
}

export const calendarDeliveryDigest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
