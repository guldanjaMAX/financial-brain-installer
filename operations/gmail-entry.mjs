import { isGmailItemFailure } from "./gmail-batch-window.mjs";

export const gmailDeadlineError = () => Object.assign(new Error("Gmail daily deadline reached; the saved window remains pending"),
  { name: "TimeoutError", reason: "requestDeadline" });

export function gmailDeadlineSleep(sleep, deadlineAt, now) {
  if (!Number.isFinite(deadlineAt)) return sleep;
  const pause = sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  return async ms => {
    const remaining = deadlineAt - now();
    if (remaining <= 0) throw gmailDeadlineError();
    await pause(Math.min(ms, remaining));
    if (now() >= deadlineAt) throw gmailDeadlineError();
  };
}

// Overlap read-only acquisition, but serialize every decision and mutation for
// one logical message. A read rejection is data until the same entry boundary
// observes it; it must not escape the prefetch iterator and poison siblings.
// The prior field trace measured about 300ms per serial read and sevenfold
// improvement with eight in flight. Retain that read overlap; message-level
// dispatch latency is a separate field measurement for this implementation.
export async function processGmailEntries({
  ids, prefetch, read, processEntry, hold, budgetExpired, concurrency = 8,
  isItemFailure = isGmailItemFailure,
  onDeadline = null,
}) {
  const entries = prefetch(ids, async id => {
    try { return { id, value: await read(id) }; }
    catch (error) { return { id, error }; }
  }, { concurrency });
  for await (const entry of entries) {
    // Once a read has completed, let its message reach a durable outcome before
    // consulting the deadline again. No later body is needed to flush it.
    try {
      if (entry.error) throw entry.error;
      await processEntry(entry.id, entry.value);
    } catch (error) {
      if (error?.reason === "requestDeadline" && onDeadline) {
        await onDeadline(entry.id);
        break;
      }
      if (!isItemFailure(error)) throw error;
      // Persistence and lease failures in hold are deliberately outside this
      // catch. Without a durable retry, neither continuation nor success is safe.
      await hold(entry.id, error);
    }
    if (budgetExpired()) break;
  }
}
