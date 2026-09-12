import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cmdIngestCalendar,
  cmdIngestRemote,
  credentialScannerFingerprint,
  runCliCommandWithCredentialBoundary,
} from "../brain.mjs";
import {
  aggregateConnectorPreviewRequested,
  aggregateRemovalCandidateCounts,
  assertConnectorAggregatePreviewReceipt,
  connectorAggregatePreviewFailure,
  connectorAggregatePreviewReceipt,
  renderConnectorAggregatePreview,
} from "../operations/connector-aggregate-preview.mjs";

const PRIVATE = Object.freeze({
  filename: "Acquisition targets 2027.xlsx",
  path: "Executive/Private/Acquisition targets 2027.xlsx",
  title: "Northwind confidential board review",
  subject: "Private tax strategy with outside counsel",
  documentId: "drive-file-private-7QYQ",
  sourceId: "calendar-event-private-98ZP",
  url: "https://docs.example.invalid/private/capability-token-77",
  content: "The private acquisition ceiling is 9100000 credits.",
  providerError: "Google raw error at /private/account/771?access_token=never-print-this",
  credential: `sk-proj-${"A7".repeat(24)}`,
});

function sandboxFixture() {
  const root = mkdtempSync(join(tmpdir(), "brain-aggregate-preview-"));
  const manifestPath = join(root, "brain.manifest.json");
  writeFileSync(manifestPath, "{}\n", { mode: 0o600 });
  return { root, manifestPath };
}

async function captureStreams(task) {
  let stdout = "";
  let stderr = "";
  let value;
  let error = null;
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  process.stdout.write = function captureStdout(chunk, encoding, callback) {
    stdout += Buffer.isBuffer(chunk) ? chunk.toString(typeof encoding === "string" ? encoding : "utf8") : String(chunk);
    if (typeof encoding === "function") encoding();
    if (typeof callback === "function") callback();
    return true;
  };
  process.stderr.write = function captureStderr(chunk, encoding, callback) {
    stderr += Buffer.isBuffer(chunk) ? chunk.toString(typeof encoding === "string" ? encoding : "utf8") : String(chunk);
    if (typeof encoding === "function") encoding();
    if (typeof callback === "function") callback();
    return true;
  };
  try {
    value = await task();
  } catch (caught) {
    error = caught;
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
  return { stdout, stderr, value, error };
}

function assertNoPrivateSurface(value) {
  const surface = typeof value === "string" ? value : JSON.stringify(value);
  for (const forbidden of Object.values(PRIVATE)) {
    assert.equal(surface.includes(forbidden), false, `private fixture escaped: ${forbidden}`);
  }
  assert.equal(/access_token|capability-token/i.test(surface), false, "a private token label escaped");
}

function parseOnlyJsonObject(output) {
  assert.ok(output.endsWith("\n"), "machine output ends with one newline");
  const parsed = JSON.parse(output);
  assert.equal(Array.isArray(parsed), false);
  return parsed;
}

function ingestLib(state) {
  return async () => ({
    loadState: () => state,
    saveState: () => { throw new Error("aggregate dry run attempted to save source state"); },
    splitOversized: (envelope) => [envelope],
    prefetch: async function* (items, prepare) {
      for await (const item of items) yield prepare(item);
    },
    batchStream: async function* (items, prepare, { onSkip = () => {} } = {}) {
      const group = [];
      for await (const item of items) {
        const prepared = await prepare(item);
        if (!prepared) continue;
        if (prepared.skip) {
          onSkip(prepared.skip);
          continue;
        }
        if (prepared.unchanged) continue;
        for (const envelope of prepared.envelopes || []) group.push({ ...prepared, envelope });
      }
      if (group.length) yield group;
    },
  });
}

function driveFixture({ includeCredential = false } = {}) {
  const files = [
    { id: "send-id", name: PRIVATE.filename, version: "v-send", mode: "send" },
    { id: "excluded-id", name: "Sealed plan.docx", version: "v-excluded", mode: "excluded" },
    { id: "skip-id", name: "Private recording.mov", version: "v-skip", mode: "skip" },
    ...(includeCredential
      ? [{ id: "credential-id", name: `Credential ${PRIVATE.credential}.txt`, version: "v-credential", mode: "credential" }]
      : []),
    { id: "unchanged-id", name: "Already loaded.pdf", version: "v-unchanged", mode: "unchanged" },
  ];
  return {
    startPageToken: async () => "provider-cursor-private-value",
    listRootedFiles: async function* () {
      for (const file of files) yield file;
    },
    updateFolderIndex: () => ({}),
    folderPathFor: () => PRIVATE.path,
    exclusionReason: (file) => file.mode === "excluded" ? `private policy for ${PRIVATE.path}` : null,
    driveVersion: (file) => file.version,
    toEnvelope: async (_token, file) => {
      if (file.mode === "skip") {
        return {
          skip: {
            path: PRIVATE.path,
            id: PRIVATE.documentId,
            reason: PRIVATE.providerError,
            code: "non_text_media",
          },
        };
      }
      return {
        version: file.version,
        envelope: {
          source_type: "drive",
          source_id: file.id,
          title: file.name,
          uri: PRIVATE.url,
          content: file.mode === "credential" ? PRIVATE.credential : PRIVATE.content,
          metadata: { folder: PRIVATE.path },
        },
      };
    },
  };
}

function calendarResult({ failed = false } = {}) {
  return {
    ok: !failed,
    documents: [{
      source_type: "calendar_event",
      source_id: PRIVATE.sourceId,
      title: PRIVATE.subject,
      uri: PRIVATE.url,
      content: PRIVATE.content,
      occurred_at: "2026-09-11T09:00:00-07:00",
    }],
    deletions: [{ source_id: "cancelled-private-event-id" }],
    state: { primary: { sync_token: "private-sync-token" } },
    calendars: [{
      calendar_key: "private-calendar-id",
      ok: !failed,
      mode: "full",
      authoritative_snapshot: !failed,
      ...(failed ? { error: new Error(PRIVATE.providerError) } : {}),
    }],
    summary: {
      events_seen: 2,
      calendars_ok: failed ? 0 : 1,
      calendars_failed: failed ? 1 : 0,
      skipped: 0,
      needs_reconsent: false,
    },
  };
}

test("aggregate receipt schema is exact and candidate identities never survive counting", () => {
  const removals = aggregateRemovalCandidateCounts({
    sourcePolicy: [PRIVATE.documentId, PRIVATE.documentId],
    sourceDeleted: [PRIVATE.documentId, PRIVATE.sourceId],
    intentionalSkip: [PRIVATE.sourceId, "third-private-id"],
  });
  assert.deepEqual(removals, {
    source_policy: 1,
    source_deleted: 1,
    intentional_skip: 1,
  });
  const receipt = connectorAggregatePreviewReceipt({
    source: "drive",
    status: "complete",
    scope: "full",
    counts: { observed: 5, would_send: 2, unchanged: 0, skipped: 3, removal_candidates: 3 },
    removalCandidates: removals,
    coverage: { complete: true, bounded: false, units_total: 1, units_succeeded: 1, units_failed: 0 },
  });
  assert.equal(assertConnectorAggregatePreviewReceipt(receipt), receipt);
  assertNoPrivateSurface(receipt);
  assert.throws(
    () => assertConnectorAggregatePreviewReceipt({ ...receipt, title: PRIVATE.title }),
    /fields outside/,
  );
  assert.throws(
    () => assertConnectorAggregatePreviewReceipt({
      ...receipt,
      counts: { ...receipt.counts, removal_candidates: 4 },
    }),
    /removal total/,
  );
});

test("Drive aggregate mode emits one counts-only JSON object and writes no state or receipt", async () => {
  const fixture = sandboxFixture();
  const state = {
    version: 1,
    done: { "drive:unchanged-id": "v-unchanged" },
    skipped: {},
    credential_scanner_fingerprint: credentialScannerFingerprint(true),
  };
  let receipts = 0;
  let brainBoundaryCalls = 0;
  try {
    const captured = await captureStreams(() => cmdIngestRemote(
      {
        corpora: { google_drive: { root_folder_ids: ["private-root-folder-id"] } },
        safety: { private_path_prefixes: ["Executive", "Private"] },
      },
      fixture.manifestPath,
      { from: "drive", "dry-run": true, "aggregate-json": true },
      {
        googleDrive: driveFixture(),
        getAccessToken: async () => "private-provider-access-token",
        ingestLib: ingestLib(state),
        resolveAccount: async () => { brainBoundaryCalls++; throw new Error("must not resolve account"); },
        resolveBaseUrl: async () => { brainBoundaryCalls++; throw new Error("must not resolve Brain URL"); },
        resolveAdminKey: () => { brainBoundaryCalls++; throw new Error("must not resolve admin key"); },
        postSourceReceipt: async () => { receipts++; throw new Error("must not post receipt"); },
      },
    ));
    assert.equal(captured.error, null, captured.error?.message);
    assert.equal(captured.stderr, "");
    const receipt = parseOnlyJsonObject(captured.stdout);
    assert.deepEqual(receipt, captured.value);
    assert.deepEqual(receipt.counts, {
      observed: 4,
      would_send: 1,
      unchanged: 1,
      skipped: 2,
      removal_candidates: 2,
    });
    assert.deepEqual(receipt.removal_candidates, {
      source_policy: 1,
      source_deleted: 0,
      intentional_skip: 1,
    });
    assert.equal(receipt.status, "complete");
    assert.equal(receipt.coverage.complete, true);
    assertNoPrivateSurface(captured.stdout);
    assert.equal(brainBoundaryCalls, 0);
    assert.equal(receipts, 0);
    assert.equal(existsSync(join(fixture.root, ".brain-ingest-drive.json")), false);
    assert.equal(readFileSync(fixture.manifestPath, "utf8"), "{}\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Calendar aggregate mode emits one counts-only JSON object while ordinary preview keeps owner detail", async () => {
  const fixture = sandboxFixture();
  let receipts = 0;
  let saves = 0;
  const options = {
    getAccessToken: async () => "private-provider-access-token",
    loadCalendarState: () => ({}),
    saveCalendarState: () => { saves++; throw new Error("aggregate dry run attempted to save state"); },
    postSourceReceipt: async () => { receipts++; throw new Error("aggregate dry run attempted to post receipt"); },
    googleCalendar: {
      syncAll: async () => calendarResult(),
      ingestEnvelopes: async () => { throw new Error("aggregate dry run attempted to send an event"); },
    },
  };
  try {
    const captured = await captureStreams(() => cmdIngestCalendar(
      { calendar: { calendars: ["private-calendar-id"] } },
      fixture.manifestPath,
      { from: "calendar", "dry-run": true, "aggregate-json": true },
      options,
    ));
    assert.equal(captured.error, null, captured.error?.message);
    assert.equal(captured.stderr, "");
    const receipt = parseOnlyJsonObject(captured.stdout);
    assert.deepEqual(receipt, captured.value);
    assert.equal(receipt.counts.observed, 2);
    assert.equal(receipt.counts.would_send, 1);
    assert.equal(receipt.counts.removal_candidates, 1);
    assert.equal(receipt.removal_candidates.source_deleted, 1);
    assert.equal(receipt.coverage.complete, true);
    assertNoPrivateSurface(captured.stdout);
    assert.equal(receipts, 0);
    assert.equal(saves, 0);
    assert.equal(existsSync(join(fixture.root, ".brain-ingest-calendar.json")), false);

    const human = await captureStreams(() => cmdIngestCalendar(
      { calendar: { calendars: ["private-calendar-id"] } },
      fixture.manifestPath,
      { from: "calendar", "dry-run": true },
      options,
    ));
    assert.equal(human.error, null, human.error?.message);
    assert.match(human.stdout, /first few that WOULD be sent/);
    assert.ok(human.stdout.includes(PRIVATE.subject), "ordinary owner preview still names the synthetic event");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("aggregate failure paths expose only closed codes and stay silent until the CLI renders JSON", async () => {
  const fixture = sandboxFixture();
  try {
    const calendar = await captureStreams(() => cmdIngestCalendar(
      { calendar: { calendars: ["private-calendar-id"] } },
      fixture.manifestPath,
      { from: "calendar", "dry-run": true, "aggregate-json": true },
      {
        getAccessToken: async () => "private-provider-access-token",
        loadCalendarState: () => ({}),
        saveCalendarState: () => { throw new Error("must not save"); },
        postSourceReceipt: async () => { throw new Error("must not post a receipt"); },
        googleCalendar: {
          syncAll: async () => calendarResult({ failed: true }),
          ingestEnvelopes: async () => { throw new Error("must not send"); },
        },
      },
    ));
    assert.equal(calendar.stdout, "");
    assert.equal(calendar.stderr, "");
    assert.ok(calendar.error?.payload);
    assert.equal(calendar.error.payload.status, "incomplete");
    assert.equal(calendar.error.payload.failure.code, "PROVIDER_SCOPE_INCOMPLETE");
    const calendarCliOutput = renderConnectorAggregatePreview(calendar.error.payload);
    parseOnlyJsonObject(calendarCliOutput);
    assertNoPrivateSurface(calendarCliOutput);

    const noBoundaryResult = calendarResult();
    noBoundaryResult.calendars[0].authoritative_snapshot = false;
    const noBoundary = await captureStreams(() => cmdIngestCalendar(
      { calendar: { calendars: ["private-calendar-id"] } },
      fixture.manifestPath,
      { from: "calendar", "dry-run": true, "aggregate-json": true },
      {
        getAccessToken: async () => "private-provider-access-token",
        loadCalendarState: () => ({}),
        saveCalendarState: () => { throw new Error("must not save"); },
        googleCalendar: {
          syncAll: async () => noBoundaryResult,
          ingestEnvelopes: async () => { throw new Error("must not send"); },
        },
      },
    ));
    assert.equal(noBoundary.stdout, "");
    assert.equal(noBoundary.stderr, "");
    assert.equal(noBoundary.error?.payload?.status, "incomplete");
    assert.equal(noBoundary.error?.payload?.failure?.code, "PROVIDER_SCOPE_INCOMPLETE");
    assertNoPrivateSurface(renderConnectorAggregatePreview(noBoundary.error.payload));

    const providerError = Object.assign(new Error(PRIVATE.providerError), {
      status: 403,
      providerReason: PRIVATE.providerError,
    });
    const drive = await captureStreams(() => cmdIngestRemote(
      { corpora: { google_drive: { root_folder_ids: ["private-root-folder-id"] } } },
      fixture.manifestPath,
      { from: "drive", "dry-run": true, "aggregate-json": true },
      {
        googleDrive: {
          ...driveFixture(),
          startPageToken: async () => { throw providerError; },
          listRootedFiles: async function* () { throw providerError; },
        },
        getAccessToken: async () => "private-provider-access-token",
        ingestLib: ingestLib({ version: 1, done: {}, skipped: {} }),
      },
    ));
    assert.equal(drive.stdout, "");
    assert.equal(drive.stderr, "");
    assert.ok(drive.error?.payload);
    assert.equal(drive.error.payload.status, "failed");
    assert.equal(drive.error.payload.failure.code, "PERMISSION_DENIED");
    const driveCliOutput = renderConnectorAggregatePreview(drive.error.payload);
    parseOnlyJsonObject(driveCliOutput);
    assertNoPrivateSurface(driveCliOutput);

    const credentialGap = await captureStreams(() => cmdIngestRemote(
      { corpora: { google_drive: { root_folder_ids: ["private-root-folder-id"] } } },
      fixture.manifestPath,
      { from: "drive", "dry-run": true, "aggregate-json": true },
      {
        googleDrive: driveFixture({ includeCredential: true }),
        getAccessToken: async () => "private-provider-access-token",
        ingestLib: ingestLib({
          version: 1,
          done: { "drive:unchanged-id": "v-unchanged" },
          skipped: {},
          credential_scanner_fingerprint: credentialScannerFingerprint(true),
        }),
      },
    ));
    assert.equal(credentialGap.stdout, "");
    assert.equal(credentialGap.stderr, "");
    assert.equal(credentialGap.error?.payload?.status, "incomplete");
    assert.equal(credentialGap.error?.payload?.failure?.code, "SOURCE_COVERAGE_INCOMPLETE");
    assertNoPrivateSurface(renderConnectorAggregatePreview(credentialGap.error.payload));

    const bounded = await captureStreams(() => cmdIngestRemote(
      { corpora: { google_drive: { root_folder_ids: ["private-root-folder-id"] } } },
      fixture.manifestPath,
      { from: "drive", "dry-run": true, "aggregate-json": true, limit: "1" },
      {
        googleDrive: driveFixture(),
        getAccessToken: async () => "private-provider-access-token",
        ingestLib: ingestLib({ version: 1, done: {}, skipped: {} }),
      },
    ));
    assert.equal(bounded.stdout, "");
    assert.equal(bounded.stderr, "");
    assert.equal(bounded.error?.payload?.status, "incomplete");
    assert.equal(bounded.error?.payload?.coverage?.bounded, true);
    assert.equal(bounded.error?.payload?.failure?.code, "PREVIEW_BOUNDED");
    assertNoPrivateSurface(renderConnectorAggregatePreview(bounded.error.payload));

    const source = readFileSync(new URL("../brain.mjs", import.meta.url), "utf8");
    const jsonCatch = source.slice(
      source.indexOf("if (e instanceof JsonFatal)"),
      source.indexOf("const supportEventId = recordSupportFailure", source.indexOf("if (e instanceof JsonFatal)")),
    );
    assert.match(jsonCatch, /console\.log\(e\.message\)/);
    assert.match(jsonCatch, /process\.exit\(1\)/);
    assert.equal(/recordSupportFailure|printSupportReceipt/.test(jsonCatch), false,
      "aggregate JSON failures must exit before support-journal output or writes");
    assert.equal(existsSync(join(fixture.root, ".brain-ingest-drive.json")), false);
    assert.equal(existsSync(join(fixture.root, ".brain-ingest-calendar.json")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("aggregate preview flag contract fails closed before connector access", () => {
  assert.equal(aggregateConnectorPreviewRequested({}, "drive"), false);
  assert.throws(
    () => aggregateConnectorPreviewRequested({ "aggregate-json": "yes", "dry-run": true }, "drive"),
    /does not take a value/,
  );
  assert.throws(
    () => aggregateConnectorPreviewRequested({ "aggregate-json": true }, "drive"),
    /requires --dry-run/,
  );
  assert.throws(
    () => aggregateConnectorPreviewRequested({ "aggregate-json": true, "dry-run": true }, "gmail"),
    /only --from drive and --from calendar/,
  );

  const failed = connectorAggregatePreviewFailure("drive", Object.assign(new Error(PRIVATE.providerError), {
    status: 429,
    providerReason: PRIVATE.providerError,
  }));
  assert.equal(failed.failure.code, "RATE_LIMITED");
  assert.equal(failed.failure.retryable, true);
  assertNoPrivateSurface(failed);
});

test("invalid aggregate arguments return a safe machine failure before connector access", async () => {
  const fixture = sandboxFixture();
  let connectorCalls = 0;
  try {
    const captured = await captureStreams(() => cmdIngestCalendar(
      { calendar: { calendars: ["private-calendar-id"] } },
      fixture.manifestPath,
      { from: "calendar", "dry-run": true, "aggregate-json": true, limit: "1" },
      {
        googleCalendar: {
          syncAll: async () => { connectorCalls++; return calendarResult(); },
        },
      },
    ));
    assert.equal(captured.stdout, "");
    assert.equal(captured.stderr, "");
    assert.equal(captured.error?.payload?.failure?.code, "INVALID_REQUEST");
    assertNoPrivateSurface(renderConnectorAggregatePreview(captured.error.payload));
    assert.equal(connectorCalls, 0);
    assert.equal(existsSync(join(fixture.root, ".brain-ingest-calendar.json")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("aggregate ingest bypasses the Cloudflare credential session", async () => {
  let credentialBoundaryCalls = 0;
  const result = await runCliCommandWithCredentialBoundary(
    "ingest",
    async () => "provider-only-preview",
    {
      argv: ["node", "brain.mjs", "ingest", "fixture.manifest.json", "--aggregate-json"],
      withWranglerSession: async () => {
        credentialBoundaryCalls++;
        throw new Error("aggregate preview must not open the Cloudflare credential boundary");
      },
    },
  );
  assert.equal(result, "provider-only-preview");
  assert.equal(credentialBoundaryCalls, 0);
});
