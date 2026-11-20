import { currentPartsFixture, driveChangesFixture } from './helpers/current-sync-fixture.mjs';
import { gmailPolicyFingerprint } from '../connectors/gmail.mjs';
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as brain from "../brain.mjs";
globalThis.fetch = async () => { throw new Error("unexpected unmocked request"); };
import { batchStream, prefetch, splitOversized } from "../ingest/run.mjs";

test("remote per-item isolation has one shared command-path constructor", () => {
  assert.equal(typeof brain.makeRemotePreparationErrorIsolator, "function");
});

const goodEnvelope = (source, id) => ({
  source_type: source,
  source_id: id,
  title: `Synthetic ${source} item`,
  content: `Readable synthetic content for ${source} item ${id}`,
});

// FIX-P1-REMOVAL-CAUSE-1117: a failed Gmail refresh reaches the owner only as
// the reviewed product copy, never the provider exception text. The receipts,
// sends and state each test checks still prove what happened.
function assertGmailOwnerFailure(error, privateText) {
  assert.match(error?.message || "", /Gmail refresh did not finish/);
  assert.equal(error?.supportCode, "INGEST_FAILED");
  assert.match(error?.message || "", /Help: https:\/\/financialbrain\.ai\/help\/INGEST_FAILED/);
  assert.equal(error.message.includes(privateText), false, "the exception text stays private");
  return true;
}

async function* orderedPrefetch(items, mapper) {
  for await (const item of items) yield await mapper(item);
}

async function runRemoteCase(source, {
  systemic = false,
  dryRun = false,
  ids = ["good-before", "bad", "good-after"],
  prefetchImpl = orderedPrefetch,
  prepareGmailItem = null,
  duringRun = null,
  expectSuccess = false,
  paceVectorsPerMinute = null,
  resultChunks = 1,
  resumedGmailIds = [],
  proveResumedScanner = true,
  ordinaryErrorClass = Error,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), `brain-${source}-isolation-`));
  const manifestPath = join(root, "brain.manifest.json");
  const manifest = {
    brain: { domain: "brain.example.invalid" },
    safety: {
      credential_scanner: { enabled: true },
      ocr: { enabled: false },
      private_path_prefixes: [],
    },
    corpora: { google_drive: { root_folder_ids: ["fixture-root"] } },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));

  const priorCursor = source === "drive"
    ? { sync_token: "prior-drive-cursor" }
    : source === "gmail"
      ? { history_id: "prior-gmail-cursor" }
      : {};
  const priorFamily = source === "imap" ? "imap:prior-family" : `${source}:bad`;
  const state = {
    version: 1,
    done: {
      ...(expectSuccess ? {} : { [priorFamily]: "prior-version" }),
      ...Object.fromEntries(resumedGmailIds.map((id) => [`gmail:${id}`, `version-${id}`])),
    },
    skipped: {},
    ...(resumedGmailIds.length && proveResumedScanner
      ? { credential_scanner_fingerprint: brain.credentialScannerFingerprint(true) }
      : {}),
    ...priorCursor,
  };
  const parts = currentPartsFixture();
  for (const id of resumedGmailIds) parts.accept(goodEnvelope("gmail", id));
  if (proveResumedScanner) for (const id of resumedGmailIds) {
    state.gmail_accepted_parts ||= {};
    state.gmail_accepted_parts[`gmail:${id}`] = { ...await parts.read({ source: "gmail", envelopes: [goodEnvelope("gmail", id)] }),
      revision: `version-${id}`, policy_fingerprint: gmailPolicyFingerprint({ credentialScannerFingerprint: brain.credentialScannerFingerprint(true), since: null }) };
  }
  const savedStates = [];
  const receipts = [];
  const sent = [];
  const prepared = [];
  const reviewed = [];
  const removals = [];
  const removalCalls = [];
  const logs = [];
  const paceSleeps = [];
  const systemicError = Object.assign(
    new Error(`synthetic ${source} systemic failure`),
    source === "drive"
      ? { name: "DriveError", status: 503, providerStatus: 503, retryable: true }
      : source === "gmail"
        ? { operationClass: "gmail_message_read", providerStatus: 503, retryable: true }
        : { name: "ImapError" },
  );
  const ordinaryError = new ordinaryErrorClass(`synthetic ${source} per-item failure`);
  const selectedError = systemic ? systemicError : ordinaryError;

  const drive = {
    startPageToken: async () => "next-drive-cursor",
    listRootedFiles: async function* () {
      for (const id of ids) yield {
        id,
        name: `${id}.txt`,
        mimeType: "text/plain",
        modifiedTime: "2026-09-24T00:00:00.000Z",
        parents: ["fixture-root"],
      };
    },
    updateFolderIndex: () => ({}),
    folderPathFor: () => "",
    exclusionReason: () => null,
    driveVersion: (file) => `version-${file.id}`,
    toEnvelope: async (_token, file) => {
      prepared.push(file.id);
      if (file.id === "bad") throw selectedError;
      return { version: `version-${file.id}`, envelope: goodEnvelope("drive", file.id) };
    },
  };

  const gmail = {
    currentHistoryId: async () => "next-gmail-cursor",
    listMessages: () => ids,
    listMessagePage: async () => ({ ids, nextPageToken: null }),
    messagePolicy: async () => ({ allowed: true }),
    toEnvelope: async (_token, id) => {
      prepared.push(id);
      if (prepareGmailItem) {
        return prepareGmailItem({ id, selectedError, prepared });
      }
      if (id === "bad") throw selectedError;
      return { version: `version-${id}`, envelope: goodEnvelope("gmail", id) };
    },
  };

  const folder = { name: "INBOX", role: "inbox", flags: [] };
  const imap = {
    DEFAULT_IMAP_PORT: 993,
    loadImapCredentials: () => ({ host: "mail.example.invalid", username: "fixture", password: "fixture" }),
    ImapClient: class {
      async connect() {}
      async login() {}
      async list() { return [folder]; }
      async examine() { return { uidvalidity: 7 }; }
      async logout() {}
    },
    partitionFolders: () => ({ included: [folder], skipped: [], unlisted: [], unclassified: [], containers: [] }),
    folderSyncDecision: () => ({ resynced: false, reason: null, searchCriteria: "ALL", floor: 0 }),
    streamFolder: async function* () {
      for (let index = 0; index < ids.length; index++) {
        yield { folder: folder.name, uid: index + 1, fixtureId: ids[index] };
      }
    },
    toEnvelope: async (message) => {
      const id = message.fixtureId;
      prepared.push(id);
      if (id === "bad") throw selectedError;
      return { version: `version-${id}`, envelope: goodEnvelope("imap", id) };
    },
    assertUidvalidityStable: () => true,
    mergeFolderWatermarks: (_saved, observed) => observed,
  };

  const listStoredSourceFamilies = async (_request) => {
    const families = new Set([
      ...(expectSuccess ? [] : [priorFamily]),
      ...resumedGmailIds.map((id) => `gmail:${id}`),
    ]);
    if (source === "drive" && _request?.includeServerObservedAt) {
      return {
        families,
        malformedIdentities: new Set(),
        serverObservedAt: "2026-09-24T00:00:00.000Z",
      };
    }
    if (source === "gmail" && _request.singlePage) return { families, nextCursor: null };
    return _request?.uids ? new Set([...families].filter(uid => _request.uids.includes(uid))) : families;
  };

  const feed = driveChangesFixture(drive, ids.map(id => ({ id, name: `${id}.txt`,
    mimeType: "text/plain", parents: ["fixture-root"] })), { token: "prior-drive-cursor", next: "next-drive-cursor" });
  const options = {
    verifyDriveIncrementalWorker: async () => {}, readDriveFamily: async () => true,
    readCurrentIngestParts: parts.read, driveNow: () => Date.parse("2026-11-01T00:00:00Z"),
    withSourceIngestLock: async (_lock, run) => run({ assertOwned: () => true }),
    resolveBaseUrl: async () => "https://brain.example.invalid",
    resolveAdminKey: () => "fixture-owner-proof",
    getAccessToken: async () => "fixture-access-token",
    ingestLib: async () => ({
      batchStream,
      splitOversized,
      loadState: () => state,
      saveState: (_path, value) => savedStates.push(structuredClone(value)),
      prefetch: prefetchImpl,
    }),
    drive: dryRun ? drive : feed.drive,
    gmail,
    imap,
    listStoredSourceFamilies,
    applyDriveRemovals: async ({ uids, dryRun: removalDryRun }) => {
      removalCalls.push({ uids: [...uids], dryRun: removalDryRun });
      if (!removalDryRun) removals.push(...uids);
      return { applied: removalDryRun ? 0 : uids.length };
    },
    postSourceReceipt: async (_base, _key, receipt) => {
      receipts.push(structuredClone(receipt));
      return receipt;
    },
    sendBatches: async ({ groups, onResult }) => {
      const items = groups.flat();
      for (const item of items) {
        sent.push(item.envelope.source_id);
        parts.accept(item.envelope);
        onResult?.(item, {
          source_id: item.envelope.source_id,
          status: "created",
          chunks: resultChunks,
        });
      }
      return { created: items.length, updated: 0, unchanged: 0, refused: 0, failed: 0 };
    },
    removalPlanRequest: async ({ body }) => {
      assert.equal(body.action, "preview", "isolation fixtures contain no stale parts to apply");
      reviewed.push(...body.families);
      return { marker: { instance: "fixture", nonce: "fixture", generation: 1, runtime: "fixture" }, targets: [], documents: 0 };
    },
    paceSleep: async (milliseconds) => {
      paceSleeps.push(milliseconds);
    },
  };

  const priorLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    const run = brain.cmdIngestRemote(
      manifest,
      manifestPath,
      {
        from: source,
        source,
        ...(dryRun ? { "dry-run": true } : {}),
        ...(paceVectorsPerMinute === null
          ? {}
          : { "pace-vectors-per-minute": String(paceVectorsPerMinute) }),
      },
      options,
    );
    await duringRun?.({ run, prepared });
    if (expectSuccess) {
      await run;
    } else if (systemic && source === "gmail") {
      // The owner copy no longer carries the systemic exception itself; its
      // error receipt still names the failed operation and provider status.
      await assert.rejects(run, (error) => assertGmailOwnerFailure(error, systemicError.message));
      assert.equal(receipts.at(-1)?.failure_evidence?.operation_class, "gmail_message_read");
      assert.equal(receipts.at(-1)?.failure_evidence?.http_status, 503);
    } else if (systemic) {
      await assert.rejects(run, (error) => source === "drive"
        ? error.supportCode === "INGEST_FAILED" && error.status === 503 : error === systemicError);
    } else if (source === "drive" && !dryRun) {
      const result = await run;
      assert.equal(result.retryable_failures, 1, "the incremental entry failure was measured");
    } else if (source === "gmail") {
      await assert.rejects(run, (error) => assertGmailOwnerFailure(error, ordinaryError.message));
    } else {
      await assert.rejects(run, /1 stored part failed, so this ingest is incomplete/);
    }
    return {
      state,
      savedStates,
      receipts,
      sent,
      prepared,
      reviewed,
      removals,
      removalCalls,
      logs,
      paceSleeps,
      priorFamily,
      ordinaryError,
    };
  } finally {
    console.log = priorLog;
    rmSync(root, { recursive: true, force: true });
  }
}

test("Gmail pacing waits for accepted chunks and the unpaced control does not", async () => {
  const paced = await runRemoteCase("gmail", {
    ids: ["good-before", "good-after"],
    expectSuccess: true,
    paceVectorsPerMinute: 40,
    resultChunks: 3,
  });
  assert.deepEqual(paced.sent, ["good-before", "good-after"]);
  // Single-part mail is now settled at acceptance without sibling cleanup.
  // Actual accepted ids above and the measured pacing below prove this path.
  assert.deepEqual(paced.reviewed, [], "single-part pacing does not query sibling cleanup");
  assert.deepEqual(paced.paceSleeps, [4_500, 4_500], "each accepted message checkpoints before its pace wait");

  const control = await runRemoteCase("gmail", {
    ids: ["good-before", "good-after"],
    expectSuccess: true,
    resultChunks: 3,
  });
  assert.deepEqual(control.sent, ["good-before", "good-after"]);
  assert.deepEqual(control.paceSleeps, []);
});

test("a resumed Gmail sweep re-lists accepted mail without fetching its body again", async () => {
  const resumed = await runRemoteCase("gmail", {
    ids: ["already-stored", "needs-work"],
    expectSuccess: true,
    resumedGmailIds: ["already-stored"],
  });
  assert.deepEqual(resumed.prepared, ["needs-work"]);
  assert.deepEqual(resumed.sent, ["needs-work"]);
  assert.equal(resumed.state.done["gmail:already-stored"], "version-already-stored");

  const unprovenScanner = await runRemoteCase("gmail", {
    ids: ["already-stored", "needs-work"],
    expectSuccess: true,
    resumedGmailIds: ["already-stored"],
    proveResumedScanner: false,
  });
  assert.deepEqual(unprovenScanner.prepared, ["already-stored", "needs-work"]);
  assert.deepEqual(unprovenScanner.sent, ["already-stored", "needs-work"]);
});

for (const source of ["drive", "gmail", "imap"]) {
  test(`${source} isolates one ordinary bad item while good neighbors complete`, async () => {
    const result = await runRemoteCase(source);
    assert.deepEqual(result.prepared, ["good-before", "bad", "good-after"]);
    assert.deepEqual(result.sent, ["good-before", "good-after"]);
    assert.equal(result.receipts.at(-1)?.status, "error");
    assert.equal(result.receipts.at(-1)?.docs_failed, 1);
    assert.equal(result.receipts.at(-1)?.complete_sweep, false);
    assert.equal(result.removals.includes(result.priorFamily), false);
    if (source === "drive") {
      // Reviewed R6 retains a durable entry gap while the healthy suffix advances.
      assert.equal(result.state.drive_failures["drive:bad"].retryable, true);
      assert.doesNotMatch(JSON.stringify(result.state.drive_failures), /synthetic .* per-item failure/,
        "the reached preparation failure cannot persist its raw exception text");
      assert.equal(result.state.done["drive:bad"], "prior-version");
    } else assert.match(result.state.skipped[source === "imap" ? "imap:INBOX#2" : `${source}:bad`], /prior family was retained/);
    assert.doesNotMatch(JSON.stringify(result.state.skipped), /synthetic .* per-item failure/);
    if (source === "drive") assert.equal(result.state.sync_token, "next-drive-cursor");
    if (source === "gmail") assert.equal(result.state.history_id, "prior-gmail-cursor");
    if (source === "imap") assert.equal(Object.hasOwn(result.state, "imap_folders"), false);
  });

  test(`${source} dry run reports one ordinary bad item and exits incomplete after inspecting both neighbors`, async () => {
    const result = await runRemoteCase(source, { dryRun: true });
    assert.deepEqual(result.prepared, ["good-before", "bad", "good-after"]);
    assert.match(result.logs.join("\n"), /1 failed/);
    assert.deepEqual(result.sent, []);
    assert.deepEqual(result.reviewed, []);
    assert.deepEqual(result.removals, []);
    assert.equal(result.removalCalls.some((call) => call.dryRun !== true), false);
    assert.equal(result.savedStates.length, 0);
    assert.match(result.state.skipped[source === "imap" ? "imap:INBOX#2" : `${source}:bad`], /prior family was retained/);
  });
}

for (const source of ["drive", "imap"]) {
  test(`${source} rethrows a systemic preparation failure before later sends or cleanup`, async () => {
    const result = await runRemoteCase(source, { systemic: true });
    assert.deepEqual(result.prepared, ["good-before", "bad"]);
    assert.deepEqual(result.sent, source === "drive" ? ["good-before"] : [],
      "reviewed incremental writes preserve the accepted prefix before a global stop");
    assert.deepEqual(result.reviewed, []);
    assert.deepEqual(result.removals, []);
    assert.equal(result.receipts.length, 2);
    assert.equal(result.receipts.at(-1)?.status, "error");
    assert.equal(result.receipts.at(-1)?.walk_complete, false);
  });
}

test("gmail systemic refusal stops new prefetch work after the concurrent consumer observes it", async () => {
  let releaseFirst;
  let releaseBad;
  let initialWindowStarted;
  let badSettled;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const badGate = new Promise((resolve) => { releaseBad = resolve; });
  const initialWindow = new Promise((resolve) => { initialWindowStarted = resolve; });
  const badResultReady = new Promise((resolve) => { badSettled = resolve; });
  const ids = [
    "good-before",
    "bad",
    ...Array.from({ length: 6 }, (_, index) => `already-prefetched-${index + 1}`),
    "refilled-after-first-result",
    "refilled-before-refusal-is-observed",
    "must-not-start-after-refusal",
  ];

  const result = await runRemoteCase("gmail", {
    systemic: true,
    ids,
    prefetchImpl: prefetch,
    prepareGmailItem: async ({ id, selectedError, prepared }) => {
      if (prepared.length === 8) initialWindowStarted();
      if (id === "good-before") await firstGate;
      if (id === "bad") {
        await badGate;
        badSettled();
        throw selectedError;
      }
      return { version: `version-${id}`, envelope: goodEnvelope("gmail", id) };
    },
    duringRun: async () => {
      await initialWindow;
      releaseBad();
      await badResultReady;
      await Promise.resolve();
      releaseFirst();
    },
  });

  // The bounded window legitimately refills before each ordered yield, so later
  // fetch/preparation work can start before the consumer reaches the earlier
  // refusal. Once it does, the source iterator closes and no new item starts.
  assert.deepEqual(result.prepared, ids.slice(0, 10));
  assert.deepEqual(result.sent, ["good-before"], "accepted prefix is durable before the later global failure");
  assert.deepEqual(result.reviewed, []);
  assert.deepEqual(result.removals, []);
  assert.equal(result.receipts.at(-1)?.walk_complete, false);
});

// Unexpected exception subclasses have the same privacy boundary as Error.
test("Drive redacts an untyped extractor exception subclass while its healthy neighbors finish", async () => {
  const result = await runRemoteCase("drive", { ordinaryErrorClass: TypeError });
  assert.deepEqual(result.prepared, ["good-before", "bad", "good-after"], "the subclass failure was reached");
  assert.deepEqual(result.sent, ["good-before", "good-after"], "populated healthy controls completed");
  assert.doesNotMatch(JSON.stringify([result.state.skipped, result.state.drive_failures]), /synthetic .* per-item failure/);
  assert.equal(result.state.drive_failures["drive:bad"].retryable, true);
  assert.equal(result.state.done["drive:bad"], "prior-version");
  assert.equal(result.receipts.at(-1).complete_sweep, false);
  assert.deepEqual(result.removals, []);
});
