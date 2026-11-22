export const GMAIL_QUOTA_PAUSE = "Google asked us to slow down. Gmail will continue on the next run.";
export const GMAIL_QUOTA_EXHAUSTED = "gmailQuotaWaitExhausted";

const MAX_WAIT_MS = 120_000;

function retryAfterMs(value, now) {
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

// One wait budget and one request queue for the ingest run, including its
// already-dispatched wave. Drain that wave before releasing any quota retry.
export function createGmailQuota({
  now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  random = Math.random,
} = {}) {
  const active = new Set();
  let tail = Promise.resolve();
  let slowed = false;
  let exhausted = false;
  let waited = 0;
  let delay = 0;
  let attempt = 0;

  async function request(task) {
    try {
      return { value: await task() };
    } catch (error) {
      if (error?.reason !== "googleQuotaResponse") throw error;
      slowed = true;
      if (!delay) delay = Math.min(2 ** attempt++ * 1_000, 32_000) + Math.floor(random() * 1_000);
      delay = Math.max(delay, retryAfterMs(error.retryAfter, now()));
      return null;
    }
  }

  function schedule(task, deadlineAt) {
    if (!slowed) {
      const current = request(task);
      active.add(current);
      const remove = () => active.delete(current);
      current.then(remove, remove);
      return current;
    }
    const current = tail.then(async () => {
      await Promise.allSettled(active);
      if (delay > MAX_WAIT_MS - waited || (delay && delay >= deadlineAt - now())) exhausted = true;
      if (exhausted) throw Object.assign(new Error(GMAIL_QUOTA_PAUSE), { reason: GMAIL_QUOTA_EXHAUSTED });
      if (delay) {
        waited += delay;
        await sleep(delay);
        delay = 0;
      }
      return request(task);
    });
    tail = current.catch(() => {});
    return current;
  }

  return {
    async run(task, deadlineAt = Infinity) {
      for (;;) {
        const result = await schedule(task, deadlineAt);
        if (result) return result.value;
      }
    },
  };
}
