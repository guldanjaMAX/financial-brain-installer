import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cmdIngestLocal, cmdIngestProvider, cmdIngestRemote, cmdIngestCalendar, cmdApplyIngestRemovals, credentialScannerFingerprint } from "../brain.mjs";
import { ingestPlanStore } from "./helpers/ingest-plan-store.mjs";
import { batchStream, splitOversized, prefetch, removedSinceLastRun } from "../ingest/run.mjs";

// Exercise the actual ingest orchestrator. Provider and authenticated storage
// are in-process doubles; an unexpected fetch must never leave this process.
globalThis.fetch = async () => { throw new Error("unexpected network attempt"); };

test("ordinary Drive ingest preserves additions and stops before a small removal", async () => {
  const root = mkdtempSync(join(tmpdir(), "ingest-plan-"));
  const manifestPath = join(root, "manifest.json");
  const manifest = {
    brain: { domain: "fixture.invalid" },
    corpora: { google_drive: { root_folder_ids: ["fixture-root"] } },
    safety: { ocr: { enabled: false }, credential_scanner: { enabled: true } },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const ids = Array.from({ length: 20 }, (_, i) => `item${i}`);
  const store = ingestPlanStore();
  const stored = new Set(ids.map((id) => `drive:${id}`));
  for (const uid of stored) store.put(uid);
  const state = { version: 1, done: {}, skipped: {},
    credential_scanner_fingerprint: credentialScannerFingerprint(true) };
  let inventoryReads = 0;
  const sent = [];
  const forgotten = [];
  const key = randomBytes(32).toString("hex");
  const options = {
    removalPlanRequest: store.request,
    removalPlanRuntime: () => "fixture-runtime",
    withSourceIngestLock: async (_input, run) => run({ assertOwned() {} }),
    resolveBaseUrl: async () => "https://fixture.invalid",
    resolveAdminKey: () => key,
    getAccessToken: async () => key,
    ingestLib: async () => ({ batchStream, splitOversized, prefetch,
      loadState: () => state, saveState() {} }),
    drive: {
      startPageToken: async () => "next-cursor",
      listRootedFiles: async function* () {
        for (const id of [...ids, "added"]) yield { id, name: `${id}.txt`,
          mimeType: "text/plain", parents: ["fixture-root"] };
      },
      updateFolderIndex: () => ({}), folderPathFor: () => "",
      exclusionReason: (file) => file.id === "item0" ? "excluded by source policy" : null,
      driveVersion: (file) => `v-${file.id}`,
      toEnvelope: async (_token, file) => ({ version: `v-${file.id}`, envelope: {
        source_type: "drive", source_id: file.id, title: "Synthetic document",
        content: "A readable synthetic document for the offline test.",
      } }),
    },
    listStoredSourceFamilies: async ({ includeServerObservedAt }) => {
      inventoryReads++;
      return includeServerObservedAt
        ? { families: new Set(stored), malformedIdentities: new Set(), serverObservedAt: "2026-10-01T00:00:00Z" }
        : new Set(stored);
    },
    sendBatches: async ({ groups, onResult }) => {
      for (const item of groups.flat()) {
        sent.push(item.envelope.source_id);
        stored.add(`drive:${item.envelope.source_id}`);
        store.put(`drive:${item.envelope.source_id}`);
        onResult(item, { status: "created" });
      }
      return { created: groups.flat().length };
    },
    reconcileDocumentFamilies: async () => 0,
    applyDriveRemovals: async ({ uids }) => {
      for (const uid of uids) { forgotten.push(uid); stored.delete(uid); }
      return { applied: uids.length, pending: 0 };
    },
    postSourceReceipt: async () => ({}),
  };
  try {
    let error;
    try { await cmdIngestRemote(manifest, manifestPath, { from: "drive" }, options); }
    catch (caught) { error = caught; }
    assert.ok(inventoryReads > 0, "authenticated inventory decision was reached");
    assert.ok(sent.includes("added"), "accepted addition landed before the review boundary");
    assert.equal(stored.size + forgotten.length, 21, "the nonempty one-of-twenty plan was exercised");
    assert.deepEqual(forgotten, [], "ordinary ingest must not apply an under-threshold removal");
    assert.equal(error?.code, "SAFETY_REVIEW_REQUIRED");
    assert.equal(store.calls.apply, 0);
    assert.deepEqual(state.ingest_removal_plan.targets, ["drive:item0"]);
    assert.ok(state.done["drive:added"]);
    const result = await cmdApplyIngestRemovals(manifest, manifestPath, {
      source: "drive", "apply-removals": state.ingest_removal_plan.fingerprint,
    }, options);
    assert.equal(result.removed, 1);
    assert.equal(store.calls.apply, 1);
    assert.equal(store.uids().length, 20);
    assert.equal(store.uids().includes("drive:item0"), false);
    assert.equal(store.uids().includes("drive:added"), true);
    assert.equal(state.sync_token, undefined);
    store.db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const source of ["upload", "gmail", "microsoft"]) {
  test(`${source} ingest saves accepted work before source/family removal and exact apply`, async () => {
    const root = mkdtempSync(join(tmpdir(), "ingest-source-plan-"));
    const manifestPath = join(root, "manifest.json");
    const manifest = {
      brain: { domain: "fixture.invalid" },
      corpora: { microsoft: { enabled: true } },
      safety: { credential_scanner: { enabled: true }, ocr: { enabled: false } },
    };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const store = ingestPlanStore();
    const ids = Array.from({ length: 20 }, (_, i) => `item${i}`);
    for (const id of ids) store.put(`${source}:${id}`);
    if (source !== "microsoft") store.put(`${source}:item1#part1of2`, { part_of: "item1" });
    let state = { version: 1, done: Object.fromEntries(ids.map((id) => [
      source === "upload" ? id : `${source}:${id}`, "old-version",
    ])), skipped: {}, credential_scanner_fingerprint: credentialScannerFingerprint(true) };
    let providerCursorWrites = 0;
    let providerCheckpoint = "prior-provider-cursor";
    let accepted = 0;
    const key = randomBytes(32).toString("hex");
    const envelope = (id) => ({ source_type: source, source_id: id, title: "Synthetic document",
      content: "Readable source content for this synthetic ingest." });
    const active = ids.slice(1).concat("added");
    const options = {
      withSourceIngestLock: async (_input, run) => run({ assertOwned() {} }),
      resolveBaseUrl: async () => "https://fixture.invalid", resolveAdminKey: () => key,
      getAccessToken: async () => key,
      removalPlanRequest: store.request, removalPlanRuntime: () => "fixture-runtime",
      ingestLib: async () => ({ batchStream, splitOversized, prefetch, removedSinceLastRun,
        loadState: () => state, saveState: (_path, next) => { state = next; },
        walk: () => ({ files: active.map((rel) => ({ rel, name: rel })), skipped: [], complete: true }),
        prepare: async (file) => ({ hash: "new-version", envelope: envelope(file.rel) }),
      }),
      listStoredSourceFamilies: store.inventory,
      sendBatches: async ({ groups, onResult }) => {
        for (const item of groups.flat()) {
          store.put(`${source}:${item.envelope.source_id}`, item.envelope.metadata);
          accepted++;
          onResult(item, { status: "updated" });
        }
        return { updated: groups.flat().length };
      },
      gmail: { currentHistoryId: async () => "next-cursor", listMessages: () => active,
        toEnvelope: async (_token, id) => ({ version: "new-version", envelope: envelope(id) }) },
      oauth: {
        loadProviderSyncState: () => ({ cursor: providerCheckpoint }),
        saveProviderSyncState: () => { providerCursorWrites++; },
        providerAccessToken: async () => ({ accessToken: key, connection: {} }),
      },
      sync: async () => ({
        documents: [envelope("added")], deletions: [{ source_type: source, source_id: "item0" }],
        outcome: { kind: "completed" }, proposed_cursor: "next-provider-cursor", cursor_can_advance: true,
      }),
      requestIngestBatch: async ({ docs }) => {
        for (const doc of docs) { store.put(`${source}:${doc.source_id}`, doc.metadata); accepted++; }
        return { results: docs.map((doc) => ({ source_id: doc.source_id, status: "created" })) };
      },
      applyDriveRemovals: async () => { throw new Error("unreviewed removal reached"); },
      reconcileDocumentFamilies: async () => { throw new Error("unreviewed reconciliation reached"); },
      postSourceReceipt: async () => ({}), reportBacklog: async () => ({}),
    };
    try {
      const run = source === "upload" ? cmdIngestLocal : source === "microsoft" ? cmdIngestProvider : cmdIngestRemote;
      const flags = source === "upload" ? { source, path: root } : { from: source, source, ...(source === "gmail" ? { reset: true } : {}) };
      await assert.rejects(run(manifest, manifestPath, flags, options), { code: "SAFETY_REVIEW_REQUIRED" });
      assert.ok(accepted > 0);
      assert.ok(store.calls.inventory > 0 && store.calls.preview > 0);
      assert.equal(store.calls.apply, 0);
      const targets = state.ingest_removal_plan.targets;
      assert.deepEqual(targets, source === "microsoft" ? ["microsoft:item0"]
        : [`${source}:item0`, `${source}:item1#part1of2`]);
      assert.ok(store.uids().includes(`${source}:added`));
      const applyFlags = { source, ...(source === "microsoft" ? { from: source } : {}),
        "apply-removals": state.ingest_removal_plan.fingerprint };
      await assert.rejects(run(manifest, manifestPath, { ...applyFlags, "apply-removals": "f".repeat(64) }, options));
      assert.equal(store.calls.apply, 0);
      if (source === "microsoft") {
        providerCheckpoint = "changed-provider-cursor";
        await assert.rejects(run(manifest, manifestPath, applyFlags, options), /Provider cursor state changed/);
        assert.equal(store.calls.apply, 0);
        providerCheckpoint = "prior-provider-cursor";
      }
      const result = await run(manifest, manifestPath, applyFlags, options);
      assert.equal(result.removed, targets.length);
      assert.equal(store.calls.apply, 1);
      assert.ok(store.uids().includes(`${source}:added`));
      assert.ok(store.uids().includes(`${source}:item1`));
      for (const uid of targets) assert.equal(store.uids().includes(uid), false);
      assert.equal(providerCursorWrites, 0);
    } finally { store.db.close(); rmSync(root, { recursive: true, force: true }); }
  });
}

test("a changed scan with OCR off preserves its old family and accepts a neighboring addition", async () => {
  const root = mkdtempSync(join(tmpdir(), "ingest-scan-plan-"));
  const manifestPath = join(root, "manifest.json");
  const manifest = { brain: { domain: "fixture.invalid" },
    safety: { ocr: { enabled: false }, credential_scanner: { enabled: true } } };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const store = ingestPlanStore();
  store.put("upload:scan.pdf");
  const state = { version: 1, done: { "scan.pdf": "old-scan" }, skipped: {},
    credential_scanner_fingerprint: credentialScannerFingerprint(true) };
  let prepared = 0;
  try {
    const result = await cmdIngestLocal(manifest, manifestPath, { path: root, source: "upload" }, {
      withSourceIngestLock: async (_input, run) => run({ assertOwned() {} }),
      resolveBaseUrl: async () => "https://fixture.invalid", resolveAdminKey: () => randomBytes(32).toString("hex"),
      removalPlanRequest: store.request, removalPlanRuntime: () => "fixture-runtime",
      ingestLib: async () => ({ batchStream, splitOversized, removedSinceLastRun,
        loadState: () => state, saveState() {},
        walk: () => ({ files: ["scan.pdf", "addition.txt"].map((rel) => ({ rel, name: rel })), skipped: [], complete: true }),
        prepare: async (file, { ocr }) => {
          prepared++;
          assert.equal(ocr, null);
          return file.rel === "scan.pdf" ? { hash: "new-scan", skip: { path: file.rel, reason: "scan needs OCR" } }
            : { hash: "addition", envelope: { source_type: "upload", source_id: file.rel,
              content: "A readable synthetic addition.", title: "Synthetic addition" } };
        },
      }),
      sendBatches: async ({ groups, onResult }) => {
        for (const item of groups.flat()) {
          store.put(`upload:${item.envelope.source_id}`);
          onResult(item, { status: "created" });
        }
        return { created: groups.flat().length };
      },
      listStoredSourceFamilies: store.inventory, postSourceReceipt: async () => ({}), reportBacklog: async () => ({}),
    });
    assert.equal(prepared, 2);
    assert.equal(result.created, 1);
    assert.equal(store.calls.apply, 0);
    assert.deepEqual(store.uids(), ["upload:addition.txt", "upload:scan.pdf"]);
    assert.equal(state.done["scan.pdf"], "old-scan");
  } finally { store.db.close(); rmSync(root, { recursive: true, force: true }); }
});


test("Calendar cancellation saves an addition but requires a separate exact apply", async () => {
  const store = ingestPlanStore();
  const root = mkdtempSync(join(tmpdir(), "ingest-calendar-plan-"));
  const path = join(root, "manifest.json");
  const manifest = { brain: { domain: "fixture.invalid" } };
  writeFileSync(path, JSON.stringify(manifest));
  let state = { primary: { sync_token: "prior" } };
  for (let index = 0; index < 20; index++) store.put(`calendar:item${index}`);
  let accepted = 0;
  let unreviewed = 0;
  const options = {
    withSourceIngestLock: async (_input, run) => run({ assertOwned() {} }),
    resolveBaseUrl: async () => "https://fixture.invalid", resolveAdminKey: () => randomBytes(32).toString("hex"),
    getAccessToken: async () => { throw new Error("unexpected provider request"); },
    removalPlanRequest: store.request, removalPlanRuntime: () => "fixture-runtime",
    listStoredSourceFamilies: store.inventory,
    loadCalendarState: () => state, saveCalendarState: (_path, next) => { state = next; },
    ingestLib: async () => ({ loadState: () => state, saveState: (_path, next) => { state = next; } }),
    googleCalendar: {
      syncAll: async () => ({ ok: true,
        documents: [{ source_type: "calendar", source_id: "added", content: "Synthetic event" }],
        deletions: [{ source_id: "item0" }],
        state: { primary: { sync_token: "next" } },
        summary: { events_seen: 2, calendars_ok: 1, skipped: 0 },
        calendars: [{ ok: true, mode: "incremental", authoritative_snapshot: true }],
      }),
      ingestEnvelopes: async () => { accepted++; store.put("calendar:added");
        return { created: 1, updated: 0, unchanged: 0, errors: [], refused: [] }; },
    },
    applyDriveRemovals: async ({ uids }) => { unreviewed++; return { applied: uids.length, pending: 0 }; },
    postSourceReceipt: async () => ({}),
  };
  try {
    let stopped;
    try { await cmdIngestCalendar(manifest, path, {}, options); } catch (error) { stopped = error; }
    assert.equal(accepted, 1);
    assert.equal(unreviewed, 0, "ordinary Calendar cancellation must not call forget");
    assert.equal(stopped?.code, "SAFETY_REVIEW_REQUIRED");
    assert.deepEqual(state.ingest_removal_plan.targets, ["calendar:item0"]);
    assert.equal(state.primary.sync_token, "prior");
    await cmdIngestCalendar(manifest, path, { source: "calendar", "apply-removals": state.ingest_removal_plan.fingerprint }, options);
    assert.equal(store.calls.apply, 1);
    assert.ok(store.uids().includes("calendar:added"));
    assert.equal(store.uids().includes("calendar:item0"), false);
    assert.equal(state.primary.sync_token, "prior");
  } finally { store.db.close(); rmSync(root, { recursive: true, force: true }); }
});
