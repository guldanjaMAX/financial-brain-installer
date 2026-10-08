import assert from "node:assert/strict";
import { ingestionOutcome } from "../ingest/outcome.mjs";
import {
  ProviderDeliveryError,
  providerSnapshotRemovalFingerprint,
  runProviderConnector,
} from "../connectors/provider-runtime.mjs";
import { SourceIngestLockError } from "../operations/source-ingest-lock.mjs";

let ran = 0;
const check = (name, value, detail = "") => {
  ran++;
  assert.ok(value, `${name}${detail ? `: ${detail}` : ""}`);
  console.log(`PASS  ${name}`);
};
const document = (id = "one") => ({
  source_type: "fixture-provider", source_id: id, title: id, content: `Fixture content ${id}`,
  occurred_at: null, date_source: "none", date_reliable: false, uri: null, metadata: {},
});
const completeResult = () => ({
  provider: "fixture-provider",
  documents: [document()],
  deletions: [{ source_type: "fixture-provider", source_id: "gone" }],
  warnings: [],
  deletion_authority: "authoritative",
  proposed_cursor: { page: "opaque-next" },
  cursor_can_advance: true,
  outcome: ingestionOutcome("completed"),
});

function harness(overrides = {}) {
  const receipts = [];
  const states = [];
  const calls = { syncCursor: undefined, deletions: [] };
  let tick = 0;
  return {
    receipts, states, calls,
    options: {
      provider: "fixture-provider",
      source: "fixture",
      kind: "upload",
      configurationFingerprint: "config-v1",
      base: "https://brain.invalid",
      adminKey: "admin-fixture",
      runId: "sync_fixture",
      now: () => new Date(Date.UTC(2026, 7, 30, 0, 0, tick++)),
      resolveAccess: async () => ({ accessToken: "access", connection: {} }),
      loadState: async () => ({ cursor: { page: "opaque-old" }, configuration_fingerprint: "config-v1" }),
      saveState: async (state) => { states.push(state); },
      sync: async ({ cursor }) => { calls.syncCursor = cursor; return completeResult(); },
      sendBatch: async ({ docs }) => ({
        res: { ok: true },
        raw: JSON.stringify({ results: docs.map((doc) => ({ source_id: doc.source_id, status: "unchanged" })) }),
      }),
      removeDocuments: async ({ uids }) => { calls.deletions.push(...uids); return { applied: uids.length, pending: 0 }; },
      listStoredFamilies: async () => new Set(),
      postReceipt: async (_base, _key, receipt) => { receipts.push(receipt); return receipt; },
      approvedSnapshotFingerprint: providerSnapshotRemovalFingerprint("fixture", ["fixture:gone"]),
      ...overrides,
    },
  };
}

const lostSourceLease = () => new SourceIngestLockError(
  "the fixture source lease changed",
  { code: "source_ingest_lock_lost" },
);

{
  const conflict = completeResult();
  conflict.deletions = [{ source_type: "fixture-provider", source_id: "one" }];
  let batchesSent = 0;
  let error;
  const h = harness({
    sync: async () => conflict,
    sendBatch: async () => { batchesSent++; throw new Error("identity conflict reached delivery"); },
  });
  try { await runProviderConnector(h.options); } catch (caught) { error = caught; }
  check("a provider identity cannot be live and deleted in one cursor window",
    error?.code === "provider_identity_conflict" && batchesSent === 0 && h.states.length === 0 &&
      h.receipts.map((receipt) => receipt.status).join(",") === "indexing,error");
}

{
  const duplicate = completeResult();
  duplicate.documents = [document("one"), { ...document("one"), content: "Conflicting second body" }];
  let error;
  const h = harness({ sync: async () => duplicate });
  try { await runProviderConnector(h.options); } catch (caught) { error = caught; }
  check("duplicate live identities across provider pages fail before delivery",
    error?.code === "invalid_provider_identity" && h.states.length === 0 && h.receipts.at(-1).status === "error");
}

{
  let batchesSent = 0;
  const h = harness({
    approvedSnapshotFingerprint: null,
    listStoredFamilies: async () => new Set(["fixture:gone"]),
    sendBatch: async ({ docs }) => { batchesSent++; return { results: docs.map((doc) => ({ source_id: doc.source_id, status: "unchanged" })) }; },
  });
  let error;
  try { await runProviderConnector(h.options); } catch (caught) { error = caught; }
  check("a provider tombstone set stops before removal after preserving accepted document work",
    error?.code === "provider_removal_review_required" && /separate apply command/.test(error.message) &&
    batchesSent === 1 && h.calls.deletions.length === 0 && h.receipts.map((receipt) => receipt.status).join(",") === "indexing,error");
}

{
  const snapshot = completeResult();
  snapshot.authoritative_snapshot = true;
  snapshot.snapshot_source_ids = ["one"];
  snapshot.deletions = [];
  let familyRead = 0;
  const h = harness({
    sync: async () => snapshot,
    listStoredFamilies: async () => ++familyRead === 1
      ? new Set(["fixture:one", "fixture:stale"])
      : new Set(["fixture:one"]),
    approvedSnapshotFingerprint: providerSnapshotRemovalFingerprint("fixture", ["fixture:stale"]),
  });
  let reviewed = null;
  h.options.reviewRemovals = async (plan) => {
    reviewed = plan;
    throw new ProviderDeliveryError("Exact apply required", { code: "provider_removal_review_required" });
  };
  await assert.rejects(runProviderConnector(h.options), { code: "provider_removal_review_required" });
  check("an authoritative baseline plans stored families absent from the complete inventory",
    reviewed.uids.join(",") === "fixture:stale" && h.calls.deletions.length === 0 && h.states.length === 0);
  check("the provider aggregate safety fingerprint remains an additional review input",
    reviewed.requiredApproval === providerSnapshotRemovalFingerprint("fixture", ["fixture:stale"]));
}

{
  const h = harness({ listStoredFamilies: async () => new Set(["fixture:gone"]) });
  let error;
  try { await runProviderConnector(h.options); } catch (caught) { error = caught; }
  check("a supplied old deletion approval cannot advance a cursor while the stored family still needs review",
    error?.code === "provider_removal_review_required" && h.calls.deletions.length === 0 &&
    h.states.length === 0 && h.receipts.at(-1).status === "error");
}

{
  const h = harness({ reset: true });
  await runProviderConnector(h.options);
  check("an explicit reset ignores a saved opaque cursor", h.calls.syncCursor === null);
}

{
  let owned = true;
  let batchesSent = 0;
  let deletionCalls = 0;
  const h = harness({
    assertOwned: () => {
      if (!owned) throw lostSourceLease();
      return true;
    },
    sync: async () => {
      owned = false;
      return completeResult();
    },
    sendBatch: async () => { batchesSent++; throw new Error("a former owner sent a batch"); },
    removeDocuments: async () => { deletionCalls++; throw new Error("a former owner deleted data"); },
  });
  await assert.rejects(
    runProviderConnector(h.options),
    (error) => error instanceof SourceIngestLockError && error.code === "source_ingest_lock_lost",
  );
  check("ownership lost during a provider walk blocks every result mutation",
    batchesSent === 0 && deletionCalls === 0 && h.states.length === 0 &&
      h.receipts.map((receipt) => receipt.status).join(",") === "indexing");
}

{
  let owned = true;
  let batchesSent = 0;
  let deletionCalls = 0;
  const h = harness({
    assertOwned: () => {
      if (!owned) throw lostSourceLease();
      return true;
    },
    sendBatch: async ({ docs }) => {
      batchesSent++;
      owned = false;
      return {
        res: { ok: true },
        raw: JSON.stringify({ results: docs.map((doc) => ({ source_id: doc.source_id, status: "unchanged" })) }),
      };
    },
    removeDocuments: async () => { deletionCalls++; return { applied: 1, pending: 0 }; },
  });
  await assert.rejects(
    runProviderConnector(h.options),
    (error) => error instanceof SourceIngestLockError && error.code === "source_ingest_lock_lost",
  );
  check("ownership lost after an accepted provider batch blocks deletion and cursor advancement",
    batchesSent === 1 && deletionCalls === 0 && h.states.length === 0 &&
      h.receipts.map((receipt) => receipt.status).join(",") === "indexing");
}

{
  const noDeletion = completeResult();
  noDeletion.deletions = [];
  let owned = true;
  let batchesSent = 0;
  const h = harness({
    assertOwned: () => {
      if (!owned) throw lostSourceLease();
      return true;
    },
    sync: async () => noDeletion,
    sendBatch: async ({ docs }) => {
      batchesSent++;
      owned = false;
      return {
        res: { ok: true },
        raw: JSON.stringify({ results: docs.map((doc) => ({ source_id: doc.source_id, status: "unchanged" })) }),
      };
    },
  });
  await assert.rejects(
    runProviderConnector(h.options),
    (error) => error instanceof SourceIngestLockError && error.code === "source_ingest_lock_lost",
  );
  check("cursor save and terminal receipt require ownership after the last provider batch",
    batchesSent === 1 && h.states.length === 0 &&
      h.receipts.map((receipt) => receipt.status).join(",") === "indexing");
}

{
  const h = harness();
  const result = await runProviderConnector(h.options);
  check("provider delivery reuses the saved opaque cursor", h.calls.syncCursor.page === "opaque-old");
  check("stable unchanged documents count as accepted idempotent retries",
    result.tally.unchanged === 1 && result.tally.failed === 0);
  check("an already absent provider tombstone never sends a deletion",
    h.calls.deletions.length === 0);
  check("the terminal cursor commits only after document and deletion receipts",
    h.states.length === 1 && h.states[0].cursor.page === "opaque-next" && result.cursor_advanced === true);
  check("common source receipts close indexing as ready with proof fields",
    h.receipts.map((receipt) => receipt.status).join(",") === "indexing,ready" &&
    h.receipts[1].outcome_kind === "completed" && h.receipts[1].deletion_authority === "authoritative" &&
    h.receipts[1].files_seen === 1 && h.receipts[1].complete_sweep === false);
}

{
  const snapshot = completeResult();
  snapshot.authoritative_snapshot = true;
  snapshot.snapshot_source_ids = ["one"];
  snapshot.deletions = [];
  const h = harness({ sync: async () => snapshot, listStoredFamilies: async () => new Set(["fixture:one"]) });
  await runProviderConnector(h.options);
  check("an exact authoritative provider baseline is the only provider window that claims a complete sweep",
    h.receipts.at(-1).complete_sweep === true);
}

{
  const partial = completeResult();
  partial.deletion_authority = "unavailable";
  partial.warnings = ["hard deletion is not exposed"];
  partial.walk_complete = true;
  partial.outcome = ingestionOutcome("partial", { reason: partial.warnings[0] });
  const h = harness({ sync: async () => partial });
  const result = await runProviderConnector(h.options);
  check("a fully enumerated provider window stays ready while its deletion limitation remains explicit",
    result.outcome.kind === "partial" && result.tally.unchanged === 1 &&
    h.receipts.at(-1).status === "ready" && h.receipts.at(-1).walk_complete === true &&
    h.receipts.at(-1).complete_sweep === false && h.receipts.at(-1).outcome_kind === "partial");
  check("an explicit partial outcome overrides an inconsistent adapter cursor flag",
    partial.cursor_can_advance === true && partial.proposed_cursor.page === "opaque-next" &&
    h.states.length === 0 && result.cursor_advanced === false);
}

{
  const partial = completeResult();
  partial.deletion_authority = "unavailable";
  partial.warnings = ["one thread exceeded the bounded expansion limit"];
  partial.walk_complete = false;
  partial.outcome = ingestionOutcome("partial", { reason: partial.warnings[0] });
  const h = harness({ sync: async () => partial });
  await runProviderConnector(h.options);
  check("a bounded provider walk remains an error and cannot claim source enumeration",
    h.receipts.at(-1).status === "error" && h.receipts.at(-1).walk_complete === false &&
      h.receipts.at(-1).complete_sweep === false && h.states.length === 0);
}

{
  const h = harness({
    loadState: async () => ({ cursor: { page: "stale" }, configuration_fingerprint: "config-v0" }),
  });
  await runProviderConnector(h.options);
  check("a provider selection change discards its stale cursor before reading", h.calls.syncCursor === null);
}

{
  const h = harness({
    listStoredFamilies: async () => new Set(["fixture:gone"]),
    sendBatch: async ({ docs }) => ({
      res: { ok: true },
      raw: JSON.stringify({ results: docs.map((doc) => ({ source_id: doc.source_id, status: "failed" })) }),
    }),
  });
  let error;
  try { await runProviderConnector(h.options); } catch (caught) { error = caught; }
  check("a failed document makes the run fail and withholds the cursor",
    error instanceof ProviderDeliveryError && h.states.length === 0);
  check("a delivery failure closes the source as error, never ready",
    h.receipts.map((receipt) => receipt.status).join(",") === "indexing,error" &&
      h.receipts.at(-1).issue_code === "INGEST_FAILED" &&
      !("error" in h.receipts.at(-1)) && !("detail" in h.receipts.at(-1)));
  check("a provider delivery failure preserves its completed-walk outcome counts",
    h.receipts.at(-1).walk_complete === true &&
      h.receipts.at(-1).complete_sweep === false &&
      h.receipts.at(-1).docs_refused === 0 &&
      h.receipts.at(-1).docs_failed === 1 &&
      h.receipts.at(-1).files_seen === 2,
    JSON.stringify(h.receipts.at(-1)));
}

{
  let reviewReached = 0;
  const h = harness({
    listStoredFamilies: async () => new Set(["fixture:gone"]),
    reviewRemovals: async ({ uids }) => {
      reviewReached++;
      assert.deepEqual(uids, ["fixture:gone"]);
      throw new ProviderDeliveryError("Removal inventory not confirmed", { code: "provider_delivery_incomplete" });
    },
    removeDocuments: async () => { throw new Error("a missing removal proof reached deletion"); },
  });
  let error;
  try { await runProviderConnector(h.options); } catch (caught) { error = caught; }
  check("an unconfirmed provider deletion fails the run and withholds the cursor",
    error?.code === "provider_delivery_incomplete" && reviewReached === 1 && h.states.length === 0 && h.receipts.at(-1).status === "error");
  check("an unconfirmed provider deletion keeps traversal distinct from delivery completion",
    h.receipts.at(-1).walk_complete === true && h.receipts.at(-1).complete_sweep === false &&
      h.receipts.at(-1).docs_refused === 0 && h.receipts.at(-1).docs_failed === 0,
    JSON.stringify(h.receipts.at(-1)));
}

{
  const h = harness({
    sendBatch: async ({ docs }) => ({
      res: { ok: true },
      raw: JSON.stringify({ results: docs.slice(1).map((doc) => ({ source_id: doc.source_id, status: "created" })) }),
    }),
  });
  let error;
  try { await runProviderConnector(h.options); } catch (caught) { error = caught; }
  check("a truncated success-shaped receipt is refused",
    error?.code === "invalid_ingest_receipt" && h.receipts.at(-1).status === "error");
}

console.log(`\nprovider runtime: all ${ran} checks passed`);
