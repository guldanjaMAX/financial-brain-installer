import assert from "node:assert/strict";
import test from "node:test";
import { runDailyRefresh } from "../operations/daily-refresh-run.mjs";

const origin = Date.parse("2026-01-01T12:00:00.000Z");
const plan = { ready: true, enabled: true, identity: { id: "fixture-daily" }, max_runtime_minutes: 1,
  sources: [{ key: "gmail", run_key: "gmail", source_names: ["gmail"],
    class: "machine-pull", owner: "daily-task", status: "ready" }] };

async function daily({ pages = 3, elapsedPerPage = 0 } = {}) {
  let elapsed = 0; let calls = 0; let freshnessReads = 0;
  const receipts = [];
  const result = await runDailyRefresh({ plan,
    now: () => new Date(origin + elapsed),
    acquireLock: () => ({ assertOwned() {}, release() {} }),
    runSource: async () => {
      calls++; elapsed += elapsedPerPage;
      return { loaded: 1, more_history: calls < pages,
        entries: [{ key: "gmail", status: calls < pages ? "partial" : "loaded" }] };
    },
    readFreshness: async () => {
      freshnessReads++;
      return { gmail: { last_successful_run_at: new Date(origin - (freshnessReads === 1 ? 1000 : 0)).toISOString() } };
    },
    writeReceipt: receipt => receipts.push(receipt),
  });
  return { calls, receipts, result };
}

test("GMAIL-05: daily entry drains a multi-page backlog", async () => {
  const f = await daily();
  assert.equal(f.calls, 3, "all three nonempty continuation decisions reached");
  assert.equal(f.result.status, "complete");
  assert.equal(f.result.sources[0].freshness_advanced, true);
});

test("GMAIL-05: budget expiry saves a continuation and defines the next attempt", async () => {
  const f = await daily({ pages: 5, elapsedPerPage: 40000 });
  assert.equal(f.calls, 2, "budget reached after two bounded source windows");
  const receipt = f.result.sources[0];
  assert.equal(receipt.status, "deferred");
  assert.equal(receipt.more_history, true);
  assert.equal(receipt.freshness_advanced, false);
  assert.equal(receipt.retry_policy, "next_scheduled_daily_run");
  const control = await daily({ pages: 1 });
  assert.equal(control.result.status, "complete");
});
