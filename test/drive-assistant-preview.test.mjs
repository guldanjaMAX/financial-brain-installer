import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cmdIngestRemote } from "../brain.mjs";
import * as driveRuntime from "../connectors/google-drive.mjs";

test("assistant Drive preview is bounded, aggregate-only, and writes no Brain or checkpoint state", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "brain-drive-agent-preview-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifestPath = join(directory, "brain.manifest.json");
  writeFileSync(manifestPath, "{}\n");
  const statePath = join(directory, ".brain-ingest-drive.json");
  const privateValues = [
    "private-root-id", "Private Client Folder", "private-file-id",
    "Private Filing Name.pdf", "Private Filing Title", "/private/customer/path",
  ];
  let checkpointWrites = 0;
  let brainBoundaryCalls = 0;
  let fullWalkCalls = 0;
  let tokenCalls = 0;

  const drive = {
    ...driveRuntime,
    async *listRootedFilesPreview(_getToken, { limit }) {
      assert.equal(limit, 2);
      yield { id: privateValues[2], name: privateValues[3], mimeType: "application/pdf" };
      yield { id: "second-private-id", name: "Second Private Name.txt", mimeType: "text/plain" };
    },
    async *listRootedFiles() { fullWalkCalls++; },
    async startPageToken() { tokenCalls++; return "private-token"; },
    updateFolderIndex() { return {}; },
    folderPathFor() { return privateValues[5]; },
    exclusionReason() { return null; },
    driveVersion(file) { return `private-version-${file.id}`; },
    async toEnvelope(_token, file) {
      if (file.id === privateValues[2]) {
        return { skip: { path: privateValues[5], id: file.id, reason: "private refusal detail", code: "quality_refused" } };
      }
      return {
        version: "private-version",
        envelope: {
          source_type: "drive",
          source_id: file.id,
          title: privateValues[4],
          content: "Synthetic safe content that must remain inside the process.",
          metadata: {},
        },
      };
    },
  };
  const ingestLib = async () => ({
    loadState() { return { version: 1, done: {}, skipped: {} }; },
    saveState() { checkpointWrites++; },
    splitOversized(envelope) { return [envelope]; },
    prefetch(values) { return values; },
    async *batchStream(files, prepare, { onSkip }) {
      const group = [];
      for (const file of files) {
        const prepared = await prepare(file);
        if (prepared?.skip) onSkip(prepared.skip);
        else for (const envelope of prepared?.envelopes || []) group.push({ ...prepared, envelope });
      }
      if (group.length) yield group;
    },
  });
  const manifest = {
    brain: { domain: "private-owner.invalid" },
    corpora: { google_drive: { enabled: true, root_folder_ids: [privateValues[0]] } },
    safety: {
      credential_scanner: { enabled: true },
      private_path_prefixes: [privateValues[1]],
    },
  };
  const lines = [];
  const originalLog = console.log;
  console.log = (...values) => lines.push(values.join(" "));
  let receipt;
  try {
    receipt = await cmdIngestRemote(
      manifest,
      manifestPath,
      { from: "drive", source: "drive", "dry-run": true, json: true, limit: "2" },
      {
        drive,
        ingestLib,
        getAccessToken: async () => "private-access-token",
        resolveAdminKey: () => { brainBoundaryCalls++; throw new Error("admin key must not be read"); },
        resolveBaseUrl: async () => { brainBoundaryCalls++; throw new Error("Brain must not be contacted"); },
        postSourceReceipt: async () => { brainBoundaryCalls++; throw new Error("receipt must not be written"); },
      },
    );
  } finally {
    console.log = originalLog;
  }

  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), receipt);
  assert.equal(receipt.operation, "drive.bounded_preview");
  assert.equal(receipt.status, "partial_preview");
  assert.deepEqual(receipt.counts, { scanned: 2, would_send: 1, unchanged: 0, skipped: 1 });
  assert.deepEqual(receipt.effects, {
    brain_documents_sent: 0,
    brain_receipts_written: 0,
    checkpoint_written: false,
    source_cursor_advanced: false,
    ocr_calls: 0,
  });
  assert.equal(checkpointWrites, 0);
  assert.equal(brainBoundaryCalls, 0);
  assert.equal(fullWalkCalls, 0);
  assert.equal(tokenCalls, 0);
  assert.equal(readFileSync(manifestPath, "utf8"), "{}\n");
  assert.equal(existsSync(statePath), false);
  const output = lines[0];
  for (const value of privateValues) assert.doesNotMatch(output, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
});

test("assistant Drive preview aggregate receipt refuses invalid counts", () => {
  for (const invalid of [Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => driveRuntime.driveAssistantPreviewSummary({
        limit: 25,
        configuredRootCount: 1,
        scanned: invalid,
        wouldSend: 0,
        unchanged: 0,
        skipped: 0,
      }),
      (error) => error instanceof driveRuntime.DriveError && error.reason === "invalidPreviewReceipt",
    );
  }
  assert.throws(
    () => driveRuntime.driveAssistantPreviewSummary({
      limit: 0,
      configuredRootCount: 1,
      scanned: 0,
      wouldSend: 0,
      unchanged: 0,
      skipped: 0,
    }),
    (error) => error instanceof driveRuntime.DriveError && error.reason === "invalidPreviewReceipt",
  );
});

test("assistant Drive preview failures collapse private provider details into closed JSON", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "brain-drive-agent-failure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifestPath = join(directory, "brain.manifest.json");
  writeFileSync(manifestPath, "{}\n");
  const privateFailure = "Private Client Folder/private-file-title.pdf provider-id-123";
  const drive = {
    ...driveRuntime,
    async *listRootedFilesPreview() { throw new Error(privateFailure); },
  };
  const ingestLib = async () => ({
    loadState() { return { version: 1, done: {}, skipped: {} }; },
    saveState() { throw new Error("a preview failure must not write its checkpoint"); },
    splitOversized(envelope) { return [envelope]; },
    prefetch(values) { return values; },
    async *batchStream() { /* the provider fails before batching */ },
  });
  await assert.rejects(
    () => cmdIngestRemote(
      {
        brain: { domain: "private-owner.invalid" },
        corpora: { google_drive: { enabled: true, root_folder_ids: ["private-root-id"] } },
      },
      manifestPath,
      { from: "drive", source: "drive", "dry-run": true, json: true },
      { drive, ingestLib, getAccessToken: async () => "private-access-token" },
    ),
    (error) => {
      assert.equal(error.payload?.operation, "drive.bounded_preview");
      assert.equal(error.payload?.status, "unavailable");
      assert.equal(error.payload?.error_code, "drive_preview_unavailable");
      assert.doesNotMatch(error.message, /Private Client|private-file|provider-id|private-root/i);
      return true;
    },
  );
  assert.equal(existsSync(join(directory, ".brain-ingest-drive.json")), false);
});
