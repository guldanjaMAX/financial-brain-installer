import assert from "node:assert/strict";
import test from "node:test";
import { runProviderConnector } from "../connectors/provider-runtime.mjs";
import { ingestionOutcome } from "../ingest/outcome.mjs";

const NOW = "2026-10-14T12:00:00.000Z";
const document = id => ({ source_type: "fixture", source_id: id, title: "Synthetic private title",
  content: "Synthetic private content", metadata: {}, uri: null });

function fixture({ provider = "microsoft", statuses = [{ status: "refused", labels: ["env_assignment"] }], transport = false } = {}) {
  const receipts = [], calls = { sync: 0, sends: 0, saves: 0, owned: 0, removals: 0 };
  let state = { cursor: { page: "prior" } };
  const options = {
    provider, now: () => new Date(NOW), runId: "fixture_run",
    assertOwned: () => { calls.owned++; },
    loadState: () => state,
    saveState: value => { calls.saves++; state = value; },
    resolveAccess: async () => ({}),
    sync: async ({ cursor }) => {
      calls.sync++;
      const documents = cursor.page === "prior" ? statuses.map((_, i) => document(`item${i}`)) : [];
      return { documents, deletions: [], warnings: [], outcome: ingestionOutcome("completed"),
        walk_complete: true, provider_check_complete: true, cursor_can_advance: true,
        proposed_cursor: { page: "next" }, authoritative_snapshot: false };
    },
    sendBatch: async ({ docs }) => {
      calls.sends++;
      if (transport) throw new Error("synthetic transport failure");
      return { results: docs.map((doc, i) => ({ source_id: doc.source_id, ...statuses[i] })) };
    },
    postReceipt: async (_base, _key, receipt) => { receipts.push(receipt); },
    removeDocuments: async () => { calls.removals++; },
  };
  return { options, receipts, calls, state: () => state };
}

for (const provider of ["microsoft", "slack", "notion", "dropbox", "hubspot", "quickbooks"]) {
  test(`${provider}: permanent refusal advances once and the second run does not resend`, async () => {
    const f = fixture({ provider });
    const first = await runProviderConnector(f.options);
    assert.equal(f.calls.sync, 1);
    assert.equal(f.calls.sends, 1);
    assert.equal(f.calls.saves, 1);
    assert.ok(f.calls.owned > 0);
    assert.equal(first.cursor_advanced, true);
    assert.equal(first.outcome.kind, "partial");
    assert.equal(first.refresh_succeeded, true);
    assert.equal(first.tally.withheld, 1);
    assert.deepEqual(first.tally.refusal_reasons, { credential_detected: 1 });
    const receipt = f.receipts.at(-1);
    assert.equal(receipt.status, "ready");
    assert.equal(receipt.walk_complete, true);
    assert.equal(receipt.complete_sweep, false);
    assert.match(receipt.detail, /1 item\(s\) withheld by design/);
    assert.doesNotMatch(JSON.stringify(receipt), /Synthetic private|item0|env_assignment/);
    const second = await runProviderConnector(f.options);
    assert.equal(second.cursor_advanced, true);
    assert.equal(f.calls.sync, 2);
    assert.equal(f.calls.sends, 1);
  });
}

for (const [name, statuses, transport] of [
  ["mixed failed", [{ status: "refused", labels: ["env_assignment"] }, { status: "failed" }]],
  ["unknown", [{ status: "refused", labels: ["future_policy"] }]],
  ["missing reason", [{ status: "refused" }]],
  ["custody", [{ status: "refused", labels: ["quickbooks_owner_required"] }]],
  ["mixed labels", [{ status: "refused", labels: ["env_assignment", "future_policy"] }]],
  ["suspected only", [{ status: "refused", labels: ["possible_bare_token_40"] }]],
  ["transport", [{ status: "refused", labels: ["env_assignment"] }], true],
]) {
  test(`${name} keeps the cursor after reaching delivery`, async () => {
    const f = fixture({ statuses, transport });
    await assert.rejects(runProviderConnector(f.options));
    assert.equal(f.calls.sync, 1);
    assert.equal(f.calls.sends, 1);
    assert.equal(f.calls.saves, 0);
    assert.equal(f.state().cursor.page, "prior");
    assert.equal(f.receipts.at(-1).status, "error");
    assert.equal(f.calls.removals, 0);
  });
}

test("accepted control completes without withholding", async () => {
  const f = fixture({ statuses: [{ status: "unchanged" }] });
  const result = await runProviderConnector(f.options);
  assert.equal(f.calls.sends, 1);
  assert.equal(f.calls.saves, 1);
  assert.equal(result.outcome.kind, "completed");
  assert.equal(f.receipts.at(-1).status, "ready");
});

test("a snapshot may re-read a withheld item on two runs without failing either", async () => {
  const f = fixture();
  const sync = f.options.sync;
  f.options.sync = options => sync({ ...options, cursor: { page: "prior" } });
  for (let run = 0; run < 2; run++) {
    const result = await runProviderConnector(f.options);
    assert.equal(result.tally.withheld, 1);
    assert.equal(result.outcome.kind, "partial");
    assert.equal(f.receipts.at(-1).status, "ready");
  }
  assert.equal(f.calls.sends, 2);
  assert.equal(f.calls.saves, 2);
});

test("permanent refusals do not override an explicitly unproven provider boundary", async () => {
  const f = fixture();
  const sync = f.options.sync;
  f.options.sync = async options => ({ ...await sync(options), provider_check_complete: false });
  await runProviderConnector(f.options);
  assert.equal(f.calls.sends, 1);
  assert.equal(f.receipts.at(-1).provider_check_complete, false);
});

test("permanent refusals cannot advance an unfinished provider walk", async () => {
  const f = fixture();
  const sync = f.options.sync;
  f.options.sync = async options => ({ ...await sync(options), walk_complete: false });
  const result = await runProviderConnector(f.options);
  assert.equal(f.calls.sends, 1);
  assert.equal(f.calls.saves, 0);
  assert.equal(result.refresh_succeeded, false);
  assert.equal(f.receipts.at(-1).status, "error");
});

test("permanent refusals retain removal review and ownership guards", async () => {
  const f = fixture();
  const sync = f.options.sync;
  f.options.sync = async options => ({ ...await sync(options), deletions: [{ source_id: "gone" }] });
  f.options.listStoredFamilies = async () => new Set(["microsoft:gone"]);
  let reviews = 0;
  f.options.reviewRemovals = async ({ uids }) => {
    reviews++;
    assert.deepEqual(uids, ["microsoft:gone"]);
    throw Object.assign(new Error("synthetic removal review"), { code: "provider_removal_review_required" });
  };
  await assert.rejects(runProviderConnector(f.options), { code: "provider_removal_review_required" });
  assert.equal(f.calls.sends, 1);
  assert.equal(reviews, 1);
  assert.equal(f.calls.saves, 0);
  assert.equal(f.calls.removals, 0);

  const owned = fixture();
  const send = owned.options.sendBatch;
  let lost = false;
  owned.options.sendBatch = async options => { const result = await send(options); lost = true; return result; };
  owned.options.assertOwned = () => {
    owned.calls.owned++;
    if (lost) throw Object.assign(new Error("synthetic lease loss"), { code: "source_ingest_lock_lost" });
  };
  await assert.rejects(runProviderConnector(owned.options), { code: "source_ingest_lock_lost" });
  assert.equal(owned.calls.sends, 1);
  assert.ok(owned.calls.owned > 1);
  assert.equal(owned.calls.saves, 0);
  assert.equal(owned.receipts.length, 1, "the old owner cannot publish a terminal receipt");
});
