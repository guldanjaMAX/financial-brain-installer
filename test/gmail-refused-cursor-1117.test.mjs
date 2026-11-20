import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { SUPPORT_ERROR_CODES } from "../support-journal.mjs";
import { SUPPORT_RECOVERY_CATALOG, renderSupportRecovery } from "../support-recovery.mjs";
import { fixture } from "./helpers/gmail-batch-fixture.mjs";
import { credentialRefusalOf, cmdApplyIngestRemovals } from "../brain.mjs";
import { createProductFixture } from "../worker/test/product-contract-fixture.mjs";
import { coverageGapReport, sourceInventory } from "../worker/src/lib/store-d1.js";
import * as ingest from "../ingest/run.mjs";
import { runDailyRefresh } from "../operations/daily-refresh-run.mjs";

const ORIGIN = Date.parse("2026-11-01T12:00:00.000Z");
const CODE = "GMAIL_MESSAGES_REFUSED";
// Construct the scanner probe at runtime; no credential-shaped fixture literal.
const privateBody = () => ["PRIVATE-CONTENT-SENTINEL", ["sk", "proj", "A7".repeat(20)].join("-")].join(" ");
const configureRefusal = f => {
  f.ids = ["refused-entry", "healthy-entry"];
  const body = privateBody();
  assert.ok(credentialRefusalOf({ content: body }), "the actual privacy decision is reached");
  f.content = id => id === "refused-entry" ? body : "Ordinary synthetic owner correspondence for this offline probe.";
  return body;
};
const assertPrivate = (f, run, body) => {
  const exposed = JSON.stringify([run.receipt, run.state, run.result, run.output, [...f.remoteParts.values()]]);
  assert.equal(exposed.includes(body), false, "refused body must not enter any persisted or printed surface");
  assert.equal(exposed.includes("PRIVATE-CONTENT-SENTINEL"), false, "even non-secret refused prose stays private");
};

async function workerPost(product, body) {
  const response = await product.post("/api/admin/brain/source-receipt", body, { "X-Admin-Key": product.env.ADMIN_KEY });
  assert.equal(response.status, 200, "the real receipt route must accept the measured shape");
}
async function sendReceipts(product, f, offset = 0) {
  for (const receipt of f.receipts.slice(offset)) await workerPost(product, receipt);
}
const dailyPlan = { ready: true, enabled: true, identity: { id: "offline-gmail" }, max_runtime_minutes: 1,
  sources: [{ key: "gmail", run_key: "gmail", source_names: ["gmail"], class: "machine-pull", owner: "daily-task", status: "ready" }] };

for (const existing of [false, true]) test(`refusal advances and stays private, prior stored family=${existing}`, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: ORIGIN });
  await fixture(async f => {
    const body = configureRefusal(f);
    if (existing) {
      f.stored.add("gmail:refused-entry");
      f.previewTargets = ["gmail:refused-entry"];
    }
    const first = await f.once();
    assert.ok(f.reads.includes("refused-entry") && f.calls.flat().includes("healthy-entry"), "both decisions reached");
    assert.equal(first.error, null, "an owner removal decision cannot fail an add-only run");
    assert.equal(first.state.history_id, "next");
    assert.equal(first.receipt.status, "ready");
    assert.equal(first.receipt.docs_refused, 1);
    assert.deepEqual(first.state.gmail_refusals?.["gmail:refused-entry"], {
      version: 1, reason_code: "credential_detected", policy_fingerprint: first.state.gmail_policy_fingerprint,
    });
    assert.equal(first.state.gmail_retry, undefined);
    assert.equal(f.forgotten, 0);
    if (existing) assert.ok(f.stored.has("gmail:refused-entry"), "prior copy kept");
    assert.match(first.output, new RegExp(`${CODE}.*https://financialbrain\\.ai/help/${CODE}`));
    assertPrivate(f, first, body);
    const reads = f.reads.length;
    f.ids = ["refused-entry"]; f.marker = "later";
    const again = await f.once();
    assert.equal(again.error, null);
    assert.equal(again.state.history_id, "later");
    assert.equal(f.reads.length, reads, "an immutable refused message is never downloaded again under the same policy");
    assertPrivate(f, again, body);
  });
});

for (const onlyRefusal of [false, true]) test(`real Worker and daily certify Gmail freshness, refusal-only=${onlyRefusal}`, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: ORIGIN });
  const product = await createProductFixture();
  t.after(() => product.close());
  await fixture(async f => {
    const body = configureRefusal(f);
    if (onlyRefusal) f.ids = ["refused-entry"];
    let executions = 0;
    const daily = await runDailyRefresh({ plan: dailyPlan, now: () => new Date(ORIGIN),
      acquireLock: () => ({ assertOwned() {}, release() {} }), writeReceipt() {},
      runSource: async () => {
        executions++;
        const offset = f.receipts.length;
        const run = await f.once({ only: "gmail" }, { deferGmailRemovals: true, allowPartialRefresh: true });
        assert.equal(run.error, null);
        assert.equal(run.receipt.docs_refused, 1, "refusal measured even without accepted work");
        assert.equal(run.receipt.complete_sweep, false, "freshness never invents complete history");
        assertPrivate(f, run, body);
        await sendReceipts(product, f, offset);
        return run.result;
      },
      readFreshness: async () => {
        const inventory = await sourceInventory(product.env, { now: ORIGIN });
        return Object.fromEntries(inventory.rows.map(row => [row.name, { ...row.receipt, kind: row.kind }]));
      },
    });
    assert.equal(executions, 1, "actual daily source leg executed");
    assert.equal(f.state().history_id, "next");
    assert.equal(daily.sources[0].check_verified, true, "daily verifies the actual Worker receipt");
    assert.equal(daily.status, "complete", "daily finishes ok with measured policy omissions");
    assert.equal(daily.sources[0].docs_refused, 1);
    assert.equal(daily.sources[0].docs_withheld, 1);
    const currentInventory = await sourceInventory(product.env, { now: ORIGIN });
    assert.equal(currentInventory.rows.find(row => row.name === "gmail").freshness.state, "ok");
    const gaps = await coverageGapReport(product.env, { now: ORIGIN, allowedSources: ["gmail"] });
    assert.equal(gaps.unavailable, false);
    assert.ok(gaps.gaps.some(gap => gap.type === "history_unproven"), "history caveat control remains");
    assert.equal(gaps.gaps.some(gap => ["sync_broken", "never_synced", "sync_review"].includes(gap.type)), false);
  });
});

for (const deleted of [false, true]) for (const healthy of [false, true]) test(`add-only removal review keeps mail and completes daily, deletion=${deleted}, healthy=${healthy}`, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: ORIGIN });
  const product = await createProductFixture();
  t.after(() => product.close());
  await fixture(async f => {
    f.ids = healthy ? ["healthy-entry"] : ["kept-entry"];
    if (!healthy) f.policy = () => ({ allowed: false, policy_skip: true,
      removal_cause: "scope_or_filter_change", skip: { reason: "Synthetic excluded mailbox label" } });
    f.stored.add("gmail:kept-entry");
    f.previewTargets = ["gmail:kept-entry"];
    f.setState({ ...f.state(), gmail_owner_removals: { "gmail:kept-entry": "explicit_deletion" },
      removed: { "gmail:kept-entry": "2026-10-01T00:00:00.000Z" } });
    if (deleted) f.history = () => ({ ids: healthy ? f.ids : [], deletedIds: ["kept-entry"],
      removal_causes: { "kept-entry": "explicit_deletion" }, historyId: f.marker });
    const daily = await runDailyRefresh({ plan: dailyPlan, now: () => new Date(ORIGIN),
      acquireLock: () => ({ assertOwned() {}, release() {} }), writeReceipt() {},
      runSource: async () => {
        const run = await f.once({ only: "gmail" }, { deferGmailRemovals: true, allowPartialRefresh: true });
        assert.equal(run.error, null);
        assert.equal(run.receipt.status, "ready");
        assert.equal(run.state.history_id, "next");
        assert.ok(run.state.gmail_owner_removals["gmail:kept-entry"], "decision retained durably");
        await sendReceipts(product, f);
        return run.result;
      },
      readFreshness: async () => {
        const inventory = await sourceInventory(product.env, { now: ORIGIN });
        return Object.fromEntries(inventory.rows.map(row => [row.name, { ...row.receipt, kind: row.kind }]));
      },
    });
    assert.equal(f.historyReads, 1, "the actual provider window was read");
    if (healthy) assert.ok(f.calls.flat().includes("healthy-entry"), "healthy delivery reaches the decision boundary");
    else if (!deleted) assert.ok(f.policyReads.includes("kept-entry"), "the actual policy decision was reached");
    assert.ok(f.stored.has("gmail:kept-entry"));
    assert.equal(f.forgotten, 0);
    assert.equal(f.previews, 0, "daily keeps the nonempty decision without opening a removal preview");
    assert.ok(daily.sources[0].pending_removals > 0, "the kept decision stays visible in the daily receipt");
    assert.equal(daily.sources[0].check_verified, true);
    assert.equal(daily.status, "complete");
  });
});

test("storage and account failures remain visible controls", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: ORIGIN });
  for (const status of [200, 401]) await fixture(async f => {
    configureRefusal(f);
    f.respond = docs => Response.json(status === 200 ? { results: docs.map(doc => ({ source_id: doc.source_id,
      status: "failed", error: "synthetic invalid document" })) } : { error: "synthetic account interruption" }, { status });
    const run = await f.once();
    assert.ok(f.calls.length > 0, "failure control reached storage");
    assert.ok(run.error);
    assert.equal(run.receipt.status, "error");
    assert.notEqual(run.receipt.complete_sweep, true);
    if (status === 401) assert.equal(run.state.history_id, "prior");
  });
});

test("owner-requested removal applies the exact plan after the source cursor advances", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: ORIGIN });
  await fixture(async f => {
    f.ids = [];
    f.stored.add("gmail:kept-entry");
    f.previewTargets = ["gmail:kept-entry"];
    f.history = () => ({ ids: [], deletedIds: ["kept-entry"], historyId: "next",
      removal_causes: { "kept-entry": "explicit_deletion" } });
    const run = await f.once();
    assert.equal(run.error, null);
    assert.equal(run.state.history_id, "next");
    const plan = run.state.ingest_removal_plan;
    assert.equal(plan.targets.length, 1, "nonempty exact decision reached before apply");
    let applies = 0;
    let generation = 1;
    const marker = () => ({ instance: "fixture", nonce: "fixture", generation, runtime: "fixture" });
    const result = await cmdApplyIngestRemovals(f.manifest, f.manifestPath, {
      from: "gmail", source: "gmail", "apply-removals": plan.fingerprint,
      ...(plan.sourcePlan?.tooLarge ? { "approve-removals": plan.sourcePlan.fingerprint } : {}),
    }, {
      withSourceIngestLock: async (_options, task) => task({ assertOwned() {} }),
      resolveBaseUrl: async () => "https://fixture.invalid",
      resolveAdminKey: () => ["synthetic", "offline", "value"].join("-"),
      ingestLib: async () => ingest,
      removalPlanRuntime: () => "fixture-runtime",
      removalPlanRequest: async ({ body }) => {
        if (body.action === "preview") return { marker: marker(),
          targets: applies ? [] : plan.targets, documents: applies ? 0 : 1 };
        assert.deepEqual(body.targets, ["gmail:kept-entry"]);
        applies++; generation++; f.stored.delete("gmail:kept-entry");
        return { marker: marker(), documents: 1 };
      },
    });
    assert.equal(result.removed, 1);
    assert.equal(applies, 1);
    assert.equal(f.state().history_id, "next", "apply preserves the already completed check");
    assert.equal(f.state().ingest_removal_plan, undefined);
    assert.equal(f.stored.has("gmail:kept-entry"), false);
  });
});

test("a stale removal plan cannot mask a new preview failure", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: ORIGIN });
  await fixture(async f => {
    f.ids = [];
    f.stored.add("gmail:kept-entry");
    f.previewTargets = ["gmail:kept-entry"];
    f.history = () => ({ ids: [], deletedIds: ["kept-entry"], historyId: f.marker,
      removal_causes: { "kept-entry": "explicit_deletion" } });
    const control = await f.once();
    assert.equal(control.error, null);
    assert.equal(control.state.ingest_removal_plan.targets.length, 1, "saved review control reached");
    f.marker = "later"; f.previewFailure = true;
    const failed = await f.once();
    assert.ok(f.previews >= 2, "the fresh preview decision was reached");
    assert.ok(failed.error);
    assert.equal(failed.receipt.status, "error");
    assert.ok(f.stored.has("gmail:kept-entry"));
    assert.equal(f.forgotten, 0);
  });
});

test("the stable Gmail code has matching owner guidance and a short help page", () => {
  assert.ok(SUPPORT_ERROR_CODES.includes(CODE));
  const entry = SUPPORT_RECOVERY_CATALOG[CODE];
  assert.equal(entry.code, CODE);
  assert.equal(entry.retry, "safe_now");
  const guidance = renderSupportRecovery(entry);
  assert.ok(guidance.includes(CODE), "the rendered recovery retains its stable code");
  assert.ok(guidance.includes(`https://financialbrain.ai/help/${CODE}`), "the owner can open the matching help page");
  assert.doesNotMatch(guidance, /`|<manifest>|--from|\bbrain ingest\b|\b(?:never|do not|don't|must)\b/i,
    "the recovery reads as plain guidance without command syntax");
  const page = readFileSync(new URL(`../docs/help/${CODE}.md`, import.meta.url), "utf8");
  assert.ok(page.includes(`code: ${CODE}`));
  assert.ok(page.includes(`title: ${entry.title}`));
  for (const heading of ["What this means.", "What you do.", "What Claude can do for you.",
    "The provider's own words.", "If it still fails.", "Safe to run again?"]) {
    assert.ok(page.includes(`**${heading}**`), "help page section is present");
  }
  assert.ok(page.split("\n").length <= 45);
  assert.equal(page.includes("\u2014"), false);
});
