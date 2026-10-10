import assert from "node:assert/strict";
import test from "node:test";
import { collectBoundedInventory } from "../operations/source-inventory-pages.mjs";
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
