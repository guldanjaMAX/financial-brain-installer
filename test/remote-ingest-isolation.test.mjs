import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as brain from "../brain.mjs";
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
    done: { [priorFamily]: "prior-version" },
    skipped: {},
    ...priorCursor,
  };
  const savedStates = [];
  const receipts = [];
  const sent = [];
  const prepared = [];
  const reconciled = [];
  const removals = [];
  const removalCalls = [];
  const logs = [];
  const systemicError = Object.assign(
    new Error(`synthetic ${source} systemic failure`),
    source === "drive"
      ? { name: "DriveError", providerStatus: 503, retryable: true }
      : source === "gmail"
        ? { operationClass: "gmail_message_read", providerStatus: 503, retryable: true }
        : { name: "ImapError" },
  );
  const ordinaryError = new Error(`synthetic ${source} per-item failure`);
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
    const families = new Set([priorFamily]);
    if (source === "drive" && _request?.includeServerObservedAt) {
      return {
        families,
        malformedIdentities: new Set(),
        serverObservedAt: "2026-09-24T00:00:00.000Z",
      };
    }
    return families;
  };

  const options = {
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
    drive,
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
        onResult?.(item, { source_id: item.envelope.source_id, status: "created" });
      }
      return { created: items.length, updated: 0, unchanged: 0, refused: 0, failed: 0 };
    },
    reconcileDocumentFamilies: async ({ families }) => {
      reconciled.push(...families);
      return 0;
    },
  };

  const priorLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    const run = brain.cmdIngestRemote(
      manifest,
      manifestPath,
      { from: source, source, ...(dryRun ? { "dry-run": true } : {}) },
      options,
    );
    await duringRun?.({ run, prepared });
    if (systemic) {
      await assert.rejects(run, (error) => error === systemicError);
    } else {
      await assert.rejects(run, /1 stored part failed, so this ingest is incomplete/);
    }
    return {
      state,
      savedStates,
      receipts,
      sent,
      prepared,
      reconciled,
      removals,
      removalCalls,
      logs,
      priorFamily,
      ordinaryError,
    };
  } finally {
    console.log = priorLog;
    rmSync(root, { recursive: true, force: true });
  }
}

for (const source of ["drive", "gmail", "imap"]) {
  test(`${source} isolates one ordinary bad item while good neighbors complete`, async () => {
    const result = await runRemoteCase(source);
    assert.deepEqual(result.prepared, ["good-before", "bad", "good-after"]);
    assert.deepEqual(result.sent, ["good-before", "good-after"]);
    assert.equal(result.receipts.at(-1)?.status, "error");
    assert.equal(result.receipts.at(-1)?.docs_failed, 1);
    assert.equal(result.receipts.at(-1)?.complete_sweep, false);
    assert.equal(result.removals.includes(result.priorFamily), false);
    assert.match(result.state.skipped[source === "imap" ? "imap:INBOX#2" : `${source}:bad`], /prior family was retained/);
    assert.doesNotMatch(JSON.stringify(result.state.skipped), /synthetic .* per-item failure/);
    if (source === "drive") assert.equal(result.state.sync_token, "prior-drive-cursor");
    if (source === "gmail") assert.equal(result.state.history_id, "prior-gmail-cursor");
    if (source === "imap") assert.equal(Object.hasOwn(result.state, "imap_folders"), false);
  });

  test(`${source} dry run reports one ordinary bad item and exits incomplete after inspecting both neighbors`, async () => {
    const result = await runRemoteCase(source, { dryRun: true });
    assert.deepEqual(result.prepared, ["good-before", "bad", "good-after"]);
    assert.match(result.logs.join("\n"), /1 failed/);
    assert.deepEqual(result.sent, []);
    assert.deepEqual(result.reconciled, []);
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
    assert.deepEqual(result.sent, []);
    assert.deepEqual(result.reconciled, []);
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
  assert.deepEqual(result.sent, []);
  assert.deepEqual(result.reconciled, []);
  assert.deepEqual(result.removals, []);
  assert.equal(result.receipts.at(-1)?.walk_complete, false);
});
