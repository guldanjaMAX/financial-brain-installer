import assert from "node:assert/strict";
import test from "node:test";
import { collectBoundedInventory, requestInventoryPage } from "../operations/source-inventory-pages.mjs";
const first = () => ({ contract_version: 3, kind: "source_inventory_scan", snapshot: "a".repeat(64),
  as_of: "2026-10-01T00:00:00.000Z", scan: { page: 1, scanned: 2, limit: 2 },
  complete: false, truncated: true, cursor: "first", sources: [], families: [], limitations: {} });
const next = () => ({ ...first(), scan: { page: 2, scanned: 0, limit: 2 },
  complete: true, truncated: false, cursor: null });

test("bounded collector completes a control and rejects cursor and snapshot mutations", async () => {
  const outcomes = [];
  for (const arm of ["control", "changed", "stalled", "rewound", "family"]) {
    let reads = 0; let progress = 0;
    const run = () => collectBoundedInventory(first(), async () => {
      reads++;
      const page = next();
      if (arm === "changed") page.snapshot = "b".repeat(64);
      if (arm === "stalled") Object.assign(page, { complete: false, truncated: true, cursor: "first",
        scan: { page: 2, scanned: 2, limit: 2 } });
      if (arm === "rewound") page.scan.page = 1;
      if (arm === "family") page.families = [["missing", "hmac-sha256:" + "c".repeat(64)]];
      return Response.json(page);
    }, { onProgress: () => progress++, now: () => 0 });
    if (arm === "control") { assert.equal((await run()).complete, true); outcomes.push("complete"); }
    else { await assert.rejects(run); outcomes.push("refused"); }
    assert.equal(reads, 1, "each mutation reached the second page decision");
    assert.ok(progress >= 1, "every arm accepted the control prefix");
  }
  assert.deepEqual(outcomes, ["complete", "refused", "refused", "refused", "refused"]);
});

test("page retry budgets include waits and transport failures without retrying permanent errors", async () => {
  const outcomes = [];
  for (const arm of ["control", "transport", "permanent", "deadline"]) {
    let reads = 0, clock = 0;
    const waits = [];
    const run = () => requestInventoryPage(async () => {
      reads++;
      if (arm === "permanent" || (arm === "transport" && reads === 1)) {
        throw Object.assign(new Error("synthetic read failure"), { retryable: arm === "transport" });
      }
      return new Response(null, { status: arm === "deadline" ? 503 : 200 });
    }, { mode: "freshness" }, { now: () => clock, deadline: 2000,
      sleep: async ms => { waits.push(ms); clock += ms; } });
    if (["control", "transport"].includes(arm)) {
      assert.equal((await run()).status, 200); outcomes.push("complete");
    } else {
      await assert.rejects(run, arm === "deadline" ? /inventory_time_limit/ : /synthetic read failure/);
      outcomes.push("failed");
    }
    assert.equal(reads, ["transport", "deadline"].includes(arm) ? 2 : 1, "the real retry decision was reached");
    assert.deepEqual(waits, ["transport", "deadline"].includes(arm) ? [1000] : []);
  }
  assert.deepEqual(outcomes, ["complete", "complete", "failed", "failed"]);
});

test("bounded collector stops on its total work and clock budgets", async () => {
  for (const arm of ["pages", "clock"]) {
    let reads = 0; let reached = 0; let tick = 0;
    await assert.rejects(() => collectBoundedInventory(first(), async () => { reads++; return Response.json(next()); }, {
      maxPages: arm === "pages" ? 1 : 1000,
      now: () => tick,
      onProgress: () => { reached++; if (arm === "clock") tick = 600001; },
    }), /inventory_(page|time)_limit/);
    assert.equal(reached, 1, "a non-empty work page reached the budget decision");
    assert.equal(reads, 0, "budget refusal occurs before another request");
  }
});

test("a transient continuation resumes its cursor without replaying the accepted prefix", async () => {
  for (const arm of ["control", "busy", "unreadable", "changed", "unauthorized"]) {
    const requests = [], waits = [];
    let progress = 0;
    const run = () => collectBoundedInventory(first(), async body => {
      requests.push(body);
      if (arm === "unreadable" || (arm === "busy" && requests.length === 1)) {
        return Response.json({ code: "source_inventory_unavailable" }, { status: 503 });
      }
      if (arm === "changed" || arm === "unauthorized") {
        return Response.json({}, { status: arm === "changed" ? 409 : 403 });
      }
      return Response.json(next());
    }, { now: () => 0, sleep: async ms => waits.push(ms), onProgress: () => progress++ });
    if (["control", "busy"].includes(arm)) assert.equal((await run()).complete, true);
    else await assert.rejects(run, error => error.code === (arm === "changed" ? "inventory_snapshot_changed" : "source_inventory_unavailable"));
    assert.equal(requests.length, arm === "busy" ? 2 : arm === "unreadable" ? 4 : 1,
      "every outcome reaches the continuation decision and remains bounded");
    assert.ok(requests.every(body => body.cursor === "first"), "never restart or advance a failed page");
    assert.equal(progress, ["control", "busy"].includes(arm) ? 2 : 1, "a failed page is never merged");
    assert.equal(waits.length, arm === "busy" ? 1 : arm === "unreadable" ? 3 : 0);
  }
});
