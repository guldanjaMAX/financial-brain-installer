import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as drive from "../connectors/google-drive.mjs";
import {
  cmdIngestRemote, credentialScannerFingerprint, driveConnectorConfig, drivePolicyFingerprint,
} from "../brain.mjs";
import { batchStream, splitOversized, prefetch } from "../ingest/run.mjs";
import { driveFileInRoots, removeDriveFamilies } from "../operations/drive-sync.mjs";
import { DriveRemovalReviewRequired } from "../operations/drive-removal-plan.mjs";
import { ingestPlanStore } from "./helpers/ingest-plan-store.mjs";
import { scanPdf } from "./fixtures/scan-pdf.mjs";

// Packet 10: the daily Drive refresh follows the changes feed and acts on each
// change directly. Google and the Worker are in-process doubles; any other
// network attempt fails the test.
globalThis.fetch = async () => { throw new Error("unexpected network attempt"); };

const TEXT = "This synthetic record notes a reviewed planning decision for Store North. " +
  "The team agreed the schedule and will confirm progress at the next review meeting.";
const ROOT = "folder-alpha";
const OUTSIDE = "folder-outside";
const folder = (id, name, parent) => ({ id, name, mimeType: drive.FOLDER_MIME, parents: parent ? [parent] : [] });
const file = (id, parent = ROOT, extra = {}) => ({
  id, name: `${id}.txt`, mimeType: "text/plain", parents: [parent], size: String(TEXT.length),
  createdTime: "2026-09-01T00:00:00Z", modifiedTime: "2026-09-01T00:00:00Z", md5Checksum: `${id}-v1`, ...extra,
});
const BIG = { size: String(drive.DOWNLOAD_LIMIT + 1) };

function googleDouble(entries, { myDriveId = null } = {}) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const world = { byId, changes: [], startToken: "token-1", nextToken: "token-2", missing: new Set(), denied: new Set(),
    content: new Map(), changesExpired: false, rootLookupFailures: 0 };
  // Google answers the "root" alias with the real My Drive folder.
  const alias = (id) => (id === "root" && myDriveId ? myDriveId : id);
  const calls = [];
  const json = (body, status = 200) => Response.json(body, { status });
  const opts = { attempts: 1, fetchImpl: async (input) => {
    const url = new URL(input);
    const path = url.pathname.replace(/^\/drive\/v3/, "");
    const media = url.searchParams.get("alt") === "media";
    calls.push({ path, query: url.searchParams.get("q"), media });
    if (path === "/files/root" && world.rootLookupFailures > 0) {
      world.rootLookupFailures--;
      return json({ error: { message: "Backend error.", errors: [{ reason: "backendError" }] } }, 503);
    }
    if (path === "/changes/startPageToken") return json({ startPageToken: world.startToken });
    if (path === "/changes" && world.changesExpired) {
      return json({ error: { message: "The page token is no longer valid.", errors: [{ reason: "badRequest" }] } }, 410);
    }
    if (path === "/changes") return json({ changes: world.changes, newStartPageToken: world.nextToken });
    if (path === "/files") {
      const parent = alias(/^'([^']+)' in parents and trashed = false$/.exec(url.searchParams.get("q") || "")?.[1]);
      assert.ok(parent, "every listing must be bounded to one parent");
      return json({ files: [...byId.values()].filter((entry) => entry.parents.includes(parent) && !entry.trashed) });
    }
    const id = alias(path.split("/")[2]);
    if (world.missing.has(id) || !byId.has(id)) {
      return json({ error: { message: "File not found.", errors: [{ reason: "notFound" }] } }, 404);
    }
    if (world.denied.has(id)) {
      return json({ error: { message: "Access denied.", errors: [{ reason: "insufficientFilePermissions" }] } }, 403);
    }
    if (media) return new Response(world.content.get(id) ?? `${TEXT} Reference ${id}.`);
    return json(byId.get(id));
  } };
  const connector = {
    ...drive,
    startPageToken: (get) => drive.startPageToken(get, opts),
    listChanges: (get, token) => drive.listChanges(get, token, opts),
    listRootedFiles: (get, args) => drive.listRootedFiles(get, { ...args, opts }),
    listRootedFilesPreview: (get, args) => drive.listRootedFilesPreview(get, { ...args, opts }),
    classifyScopedAbsence: (get, id, args) => drive.classifyScopedAbsence(get, id, { ...args, opts }),
    getFileMetadata: (get, id) => drive.getFileMetadata(get, id, opts),
    toEnvelope: (get, entry, args) => drive.toEnvelope(get, entry, args, opts),
  };
  return { world, calls, connector };
}

function scenario(t, entries, { driveConfig = {}, myDriveId = null } = {}) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "drive-simple-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifestPath = join(directory, "manifest.json");
  const manifest = {
    brain: { domain: "fixture.invalid" },
    corpora: { google_drive: { root_folder_ids: [ROOT], ...driveConfig } },
    safety: { credential_scanner: { enabled: true }, ocr: { enabled: false } },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const google = googleDouble(entries, { myDriveId });
  const store = ingestPlanStore();
  t.after(() => store.db.close());
  const state = { version: 1, done: {}, skipped: {}, credential_scanner_fingerprint: credentialScannerFingerprint(true) };
  const sent = [];
  const receipts = [];
  const failLoads = new Set();
  // `fail` makes the Worker's apply step fail the way the authenticated route does.
  const removal = { fail: false };
  let inventoryReads = 0;
  const inventory = async ({ includeServerObservedAt = false, includeLabels = false } = {}) => {
    inventoryReads++;
    const families = new Set(store.uids());
    return includeServerObservedAt || includeLabels
      ? { families, malformedIdentities: new Set(), serverObservedAt: "2026-10-01T00:00:00Z",
        labels: new Map(), labelsAvailable: true }
      : families;
  };
  const options = {
    withSourceIngestLock: async (_input, run) => run({ assertOwned() {} }),
    resolveBaseUrl: async () => "https://fixture.invalid",
    resolveAdminKey: () => "fixture-admin-key",
    getAccessToken: async () => "fixture-access-token",
    removalPlanRequest: async (input) => {
      if (removal.fail && input.body.action === "apply") {
        throw new DriveRemovalReviewRequired("Authenticated removal request failed. HTTP 503. " +
          "Some approved removals may have completed. The source cursor was not advanced. " +
          "Rerun the same approved command if the stored inventory is unchanged. If it changed, run ingestion " +
          "again and review the new removal plan; an old approval cannot resume a completed batch.");
      }
      return store.request(input);
    },
    removalPlanRuntime: () => "fixture-runtime",
    ingestLib: async () => ({ batchStream, splitOversized, prefetch, loadState: () => state, saveState() {} }),
    drive: google.connector,
    listStoredSourceFamilies: inventory,
    sendBatches: async ({ groups, onResult }) => {
      const tally = { created: 0, failed: 0 };
      for (const item of groups.flat()) {
        if (failLoads.has(item.envelope.source_id)) {
          onResult(item, { status: "failed", source_id: item.envelope.source_id, error: "synthetic worker refusal" });
          tally.failed++;
          continue;
        }
        sent.push(item.envelope.source_id);
        store.put(`drive:${item.envelope.source_id}`, {}, `rev-${sent.length}`);
        onResult(item, { status: "created", source_id: item.envelope.source_id, chunks: 1 });
        tally.created++;
      }
      return tally;
    },
    reconcileDocumentFamilies: async () => 0,
    applyDriveRemovals: async () => { throw new Error("the daily path must not use the legacy forget route"); },
    postSourceReceipt: async (_base, _key, receipt) => { receipts.push(receipt); return {}; },
  };
  const run = async (flags = {}) => {
    const lines = [];
    const log = console.log;
    console.log = (...args) => lines.push(args.join(" ").replace(/\x1b\[[0-9;]*m/g, ""));
    // Swallow only the run's own carriage-return progress writes. node:test
    // writes its results to the same stream, often while the next test runs,
    // so a blanket stub hid them and node --test could not name every test.
    const write = process.stdout.write;
    process.stdout.write = function progressOnly(chunk, ...rest) {
      if (typeof chunk === "string" && chunk.startsWith("\r")) return true;
      return write.call(this, chunk, ...rest);
    };
    let result;
    let error;
    try { result = await cmdIngestRemote(manifest, manifestPath, { from: "drive", ...flags }, options); }
    catch (caught) { error = caught; }
    finally { console.log = log; process.stdout.write = write; }
    return { result, error, output: lines.join("\n") };
  };
  // State exactly as a completed earlier run would leave it.
  const seedSynced = (storedFiles, folderEntries = entries.filter((entry) => entry.mimeType === drive.FOLDER_MIME)) => {
    const config = driveConnectorConfig(manifest, manifestPath);
    state.sync_token = "token-1";
    state.drive_policy_fingerprint = drivePolicyFingerprint(config, true, false);
    state.drive_last_full_sweep_at = new Date().toISOString();
    state.drive_folders = drive.updateFolderIndex(folderEntries);
    for (const entry of storedFiles) {
      state.done[`drive:${entry.id}`] = drive.driveVersion(entry, drive.folderPathFor(entry, state.drive_folders));
      store.put(`drive:${entry.id}`);
    }
  };
  return { ...google, manifest, store, state, sent, receipts, failLoads, removal, run, seedSynced, inventoryReads: () => inventoryReads };
}

const baseEntries = () => [
  folder("owner-drive", "Owner Drive"), folder(ROOT, "Folder Alpha", "owner-drive"),
  folder(OUTSIDE, "Folder Outside", "owner-drive"),
  file("keep-file"), file("edit-file"), file("trash-file"), file("gone-file"), file("move-file"),
  file("big-file", ROOT, BIG),
];

test("first run saves the start token, then makes one additive pass that removes nothing", async (t) => {
  const s = scenario(t, baseEntries());
  // Already in the Brain from an older load, now over the 8 MiB download limit.
  s.store.put("drive:big-file");
  const { error, output } = await s.run();
  assert.equal(error, undefined, error?.message);
  assert.equal(s.state.sync_token, "token-1", "the start token is saved as the next cursor");
  assert.equal(s.calls[0].path, "/changes/startPageToken", "the start token is taken before the walk");
  assert.deepEqual([...s.sent].sort(), ["edit-file", "gone-file", "keep-file", "move-file", "trash-file"]);
  assert.ok(s.store.uids().includes("drive:big-file"), "an unreadable stored file is never removed");
  assert.equal(s.calls.some((call) => call.media && call.path.includes("big-file")), false, "the big file is not downloaded");
  assert.equal(s.store.calls.apply, 0, "the additive pass never removes");
  assert.match(output, /nothing is removed on this pass/);
});

test("incremental run loads changed and new files, removes trashed and moved-out files at once, and keeps a file that only left this account's view", async (t) => {
  const entries = baseEntries();
  const s = scenario(t, entries);
  s.seedSynced(entries.filter((entry) => entry.mimeType !== drive.FOLDER_MIME));
  const changed = (id, extra) => ({ fileId: id, removed: false, file: { ...s.world.byId.get(id), ...extra } });
  s.world.changes = [
    changed("edit-file", { modifiedTime: "2026-10-10T00:00:00Z", md5Checksum: "edit-file-v2" }),
    { fileId: "new-file", removed: false, file: s.world.byId.set("new-file", file("new-file")).get("new-file") },
    changed("trash-file", { trashed: true }),
    { fileId: "gone-file", removed: true },
    changed("move-file", { parents: [OUTSIDE] }),
    changed("big-file", { modifiedTime: "2026-10-10T00:00:00Z", md5Checksum: "big-file-v2" }),
    { fileId: "noise-file", removed: false, file: file("noise-file", OUTSIDE) },
  ];
  const bigVersion = s.state.done["drive:big-file"];
  const { error, output } = await s.run();
  assert.equal(error, undefined, `${error?.message}\n${output.slice(-1200)}`);
  assert.deepEqual([...s.sent].sort(), ["edit-file", "new-file"]);
  assert.deepEqual(s.store.uids(), ["drive:big-file", "drive:edit-file", "drive:gone-file", "drive:keep-file", "drive:new-file"],
    "trashed and moved-out files lose their stored document; the big file and the no-longer-visible file stay");
  assert.match(output, /1 Drive file\(s\) are no longer visible to this account; their stored documents are kept/);
  assert.equal(s.state.done["drive:big-file"], bigVersion, "the over-limit file keeps its stored version");
  assert.deepEqual(s.calls.filter((call) => call.media).map((call) => call.path).sort(),
    ["/files/edit-file", "/files/new-file"], "only the changed readable files are downloaded");
  assert.equal(s.calls.some((call) => call.query), false, "no folder listing: no full re-walk");
  assert.equal(s.calls.some((call) => call.path === "/changes/startPageToken"), false);
  assert.equal(s.state.sync_token, "token-2", "the cursor advances to the feed's new start token");
  assert.ok(s.store.calls.apply >= 1, "removal applied without an approval stop");
  for (const uid of ["drive:trash-file", "drive:move-file"]) assert.equal(s.state.done[uid], undefined);
  assert.ok(s.state.done["drive:gone-file"], "the no-longer-visible file keeps its accepted version");
  assert.equal(s.receipts.at(-1).status, "error", "the skipped over-limit file is still reported as a coverage gap");
});

test("an unchanged run makes no Drive request beyond the one changes call", async (t) => {
  const entries = baseEntries();
  const s = scenario(t, entries);
  s.seedSynced(entries.filter((entry) => entry.mimeType !== drive.FOLDER_MIME && entry.id !== "big-file"));
  const before = s.store.uids();
  const { error } = await s.run();
  assert.equal(error, undefined, error?.message);
  assert.deepEqual(s.calls.map((call) => call.path), ["/changes"]);
  assert.deepEqual(s.sent, []);
  assert.deepEqual(s.store.uids(), before);
  assert.equal(s.store.calls.preview + s.store.calls.apply, 0);
  assert.equal(s.inventoryReads(), 0, "no stored-inventory read when nothing changed");
  assert.equal(s.state.sync_token, "token-2");
  assert.equal(s.receipts.at(-1).status, "ready");
});

test("a folder moved into a root brings its unchanged files with it", async (t) => {
  const entries = [...baseEntries(), folder("folder-beta", "Folder Beta", OUTSIDE), file("beta-file", "folder-beta")];
  const s = scenario(t, entries);
  s.seedSynced([s.world.byId.get("keep-file")]);
  s.world.byId.set("folder-beta", folder("folder-beta", "Folder Beta", ROOT));
  s.world.changes = [{ fileId: "folder-beta", removed: false, file: s.world.byId.get("folder-beta") }];
  const { error } = await s.run();
  assert.equal(error, undefined, error?.message);
  assert.deepEqual(s.sent, ["beta-file"]);
  assert.equal(s.calls.some((call) => call.query === "'folder-beta' in parents and trashed = false"), true);
  assert.equal(s.calls.some((call) => call.query?.includes(`'${ROOT}'`)), false, "the rest of the root is not re-walked");
});

test("progress prints every 100 files and each failed load names its own reason", async (t) => {
  const many = Array.from({ length: 250 }, (_, index) => file(`f-${String(index).padStart(4, "0")}`));
  const s = scenario(t, [folder(ROOT, "Folder Alpha"), ...many]);
  s.failLoads.add("f-0011");
  const toEnvelope = s.connector.toEnvelope;
  s.connector.toEnvelope = async (get, entry, args) => {
    if (entry.id === "f-0007") {
      throw Object.assign(new Error("could not parse private words from Store North"), {
        name: "ExtractionError", code: "EXTRACT_FAILED",
      });
    }
    return toEnvelope(get, entry, args);
  };
  const { error, output } = await s.run();
  assert.ok(error, "a run with failed loads does not report success");
  for (const count of [100, 200, 250]) assert.match(output, new RegExp(`Drive: ${count} file\\(s\\) checked`));
  assert.match(output, /Drive file f-0007 was not loaded: ExtractionError: EXTRACT_FAILED/);
  assert.match(output, /Drive file f-0011 was not loaded: synthetic worker refusal/);
  assert.equal(output.includes("private words"), false, "the failure line never quotes parsed content");
  assert.equal(s.state.sync_token, undefined, "failed loads keep the cursor for a retry");
});

test("cleanup --dry-run counts, then cleanup removes only gone or outside-root files in batches", async (t) => {
  const outsideFiles = Array.from({ length: 60 }, (_, index) => file(`out-${String(index).padStart(3, "0")}`, OUTSIDE));
  const s = scenario(t, [
    folder("owner-drive", "Owner Drive"), folder(ROOT, "Folder Alpha", "owner-drive"),
    folder(OUTSIDE, "Folder Outside", "owner-drive"),
    file("in-root"), file("trashed-x", ROOT, { trashed: true }), file("denied-x", OUTSIDE),
    file("split-x", OUTSIDE), ...outsideFiles,
  ]);
  s.world.denied.add("denied-x");
  for (const uid of ["drive:in-root", "drive:trashed-x", "drive:missing-x", "drive:denied-x",
    ...outsideFiles.map((entry) => `drive:${entry.id}`)]) s.store.put(uid);
  for (const part of [1, 2]) s.store.put(`drive:split-x#part${part}of2`, { part_of: "split-x" });
  const total = s.store.uids().length;

  const preview = await s.run({ cleanup: true, "dry-run": true });
  assert.equal(preview.error, undefined, preview.error?.message);
  assert.equal(s.store.uids().length, total, "a dry run removes nothing");
  assert.equal(s.store.calls.apply, 0);
  assert.equal(preview.result.would_remove, 64, "trashed + not found + split pair + 60 outside");
  assert.match(preview.output, /Nothing was removed/);
  assert.match(preview.output, /1 under a root \(kept\); 1 trashed at Google; 61 outside every root; 0 excluded by the current settings; 0 refused by the credential scanner; 1 kept/);
  assert.match(preview.output, /1 no longer visible to this account \(Google says not found\); a real run removes them/);
  assert.equal(preview.result.gone, 1);
  assert.equal(preview.result.not_visible, 1);

  const applied = await s.run({ cleanup: true });
  assert.equal(applied.error, undefined, applied.error?.message);
  assert.equal(applied.result.removed, 64);
  assert.equal(applied.result.not_visible, 1);
  assert.match(applied.output, /1 no longer visible to this account \(Google says not found\); removed below/);
  assert.deepEqual(s.store.uids(), ["drive:denied-x", "drive:in-root"]);
  assert.match(applied.output, /removal: 50 of 63 file\(s\) checked/);
  assert.match(applied.output, /removed 64 stored Drive document\(s\) for 63 file\(s\)/);
  assert.deepEqual(s.sent, [], "cleanup never loads documents");
});

test("an upgraded install with loose My Drive files reads the exact My Drive root id, so a changed loose file is kept", async (t) => {
  const entries = [folder("owner-drive", "Owner Drive"), folder(ROOT, "Folder Alpha", "owner-drive"),
    folder(OUTSIDE, "Folder Outside", "owner-drive"), file("loose-file", "owner-drive"), file("keep-file")];
  const s = scenario(t, entries, { driveConfig: { include_my_drive_root_files: true }, myDriveId: "owner-drive" });
  // Older builds never saved the id. This saved index has no My Drive entry,
  // so only Google's own answer for "root" can supply it.
  s.seedSynced([s.world.byId.get("loose-file"), s.world.byId.get("keep-file")],
    [folder(ROOT, "Folder Alpha", "owner-drive"), folder(OUTSIDE, "Folder Outside", "owner-drive")]);
  assert.equal(s.state.drive_my_drive_root_id, undefined);
  s.world.changes = [{ fileId: "loose-file", removed: false,
    file: { ...s.world.byId.get("loose-file"), modifiedTime: "2026-10-10T00:00:00Z", md5Checksum: "loose-file-v2" } }];
  const { error, output } = await s.run();
  assert.equal(error, undefined, `${error?.message}
${output.slice(-1200)}`);
  assert.equal(s.state.drive_my_drive_root_id, "owner-drive", "the id comes from the exact root lookup");
  assert.equal(s.calls.filter((call) => call.path === "/files/root").length, 1, "one exact root lookup");
  assert.equal(s.calls.some((call) => call.path === "/changes/startPageToken"), false, "the changes feed is trusted");
  assert.deepEqual(s.sent, ["loose-file"], "the changed loose file is reloaded, not removed");
  assert.deepEqual(s.store.uids(), ["drive:keep-file", "drive:loose-file"]);
  assert.equal(s.store.calls.apply, 0);
  assert.equal(s.state.sync_token, "token-2");
});

test("an upgraded install whose My Drive root lookup fails makes one additive pass instead", async (t) => {
  const myDrive = { ...folder("owner-drive", "Owner Drive"), scope_my_drive_root: true };
  const entries = [folder("owner-drive", "Owner Drive"), folder(ROOT, "Folder Alpha", "owner-drive"),
    folder(OUTSIDE, "Folder Outside", "owner-drive"), file("loose-file", "owner-drive"), file("keep-file")];
  const s = scenario(t, entries, { driveConfig: { include_my_drive_root_files: true }, myDriveId: "owner-drive" });
  // The saved index still holds the empty-name entry an older build wrote.
  // It is not trusted: only the exact lookup can supply the id, and it fails.
  s.seedSynced([s.world.byId.get("loose-file"), s.world.byId.get("keep-file")],
    [myDrive, folder(ROOT, "Folder Alpha", "owner-drive"), folder(OUTSIDE, "Folder Outside", "owner-drive")]);
  assert.equal(s.state.drive_folders["owner-drive"].name, "");
  s.world.rootLookupFailures = 1;
  s.world.byId.set("loose-file", { ...s.world.byId.get("loose-file"), modifiedTime: "2026-10-10T00:00:00Z", md5Checksum: "loose-file-v2" });
  s.world.changes = [{ fileId: "loose-file", removed: false, file: s.world.byId.get("loose-file") }];
  const { error, output } = await s.run();
  assert.equal(error, undefined, `${error?.message}
${output.slice(-1200)}`);
  assert.match(output, /My Drive root id is not known yet/);
  assert.equal(s.calls.some((call) => call.path === "/changes"), false, "the changes feed is not trusted on this run");
  assert.equal(s.calls[0].path, "/files/root", "the exact lookup comes first");
  assert.equal(s.calls[1].path, "/changes/startPageToken");
  assert.deepEqual(s.store.uids(), ["drive:keep-file", "drive:loose-file"], "nothing is removed");
  assert.equal(s.store.calls.apply, 0);
  assert.deepEqual(s.sent, ["loose-file"]);
  assert.equal(s.state.drive_my_drive_root_id, "owner-drive");
  assert.equal(s.state.sync_token, "token-1");
});

test("a moved-in folder whose child failed to load is walked again on the retry of the same window", async (t) => {
  const entries = [...baseEntries(), folder("folder-beta", "Folder Beta", OUTSIDE), file("beta-file", "folder-beta")];
  const s = scenario(t, entries);
  s.seedSynced([s.world.byId.get("keep-file")]);
  s.world.byId.set("folder-beta", folder("folder-beta", "Folder Beta", ROOT));
  s.world.changes = [{ fileId: "folder-beta", removed: false, file: s.world.byId.get("folder-beta") }];
  s.failLoads.add("beta-file");
  const first = await s.run();
  assert.ok(first.error, "a failed load does not report success");
  assert.equal(s.state.sync_token, "token-1", "the cursor is held back");
  assert.deepEqual(s.state.drive_folders["folder-beta"].parents, [OUTSIDE], "the folder index waits for the cursor");

  s.failLoads.clear();
  const second = await s.run();
  assert.equal(second.error, undefined, `${second.error?.message}
${second.output.slice(-1200)}`);
  assert.deepEqual(s.sent, ["beta-file"], "the retry walks the folder again and loads the unchanged child");
  assert.equal(s.state.sync_token, "token-2");
  assert.deepEqual(s.state.drive_folders["folder-beta"].parents, [ROOT]);
});

test("cleanup also removes stored files the current settings exclude or the current scanner refuses", async (t) => {
  const credential = ["sk", "a".repeat(32)].join("-");
  const entries = [folder("owner-drive", "Owner Drive"), folder(ROOT, "Folder Alpha", "owner-drive"),
    file("keep-file"), file("excluded-file"), file("secret-file"), file("clean-file")];
  const s = scenario(t, entries, { driveConfig: { exclude_file_ids: ["excluded-file"] } });
  s.world.content.set("secret-file", `${TEXT} Synthetic scanner fixture ${credential}`);
  // Both were stored by an older load, before the exclusion or the scanner rule.
  s.store.put("drive:excluded-file");
  s.store.put("drive:secret-file");

  const daily = await s.run();
  assert.equal(daily.error, undefined, daily.error?.message);
  assert.equal(s.receipts.at(-1).status, "error", "a credential refusal keeps the daily run visibly incomplete");
  assert.deepEqual(s.store.uids(), ["drive:clean-file", "drive:excluded-file", "drive:keep-file", "drive:secret-file"],
    "the first pass is add-only: it never removes the excluded or refused file");
  assert.match(String(s.state.skipped["drive:secret-file"]), /^refused: carries /);
  // A stale refusal marker on a file that is clean now must not remove it.
  s.state.skipped["drive:clean-file"] = "refused: carries a synthetic stale marker";

  const preview = await s.run({ cleanup: true, "dry-run": true });
  assert.equal(preview.error, undefined, preview.error?.message);
  assert.equal(preview.result.excluded, 1);
  assert.equal(preview.result.credential_refused, 1);
  assert.equal(preview.result.would_remove, 2);
  assert.match(preview.output, /1 excluded by the current settings; 1 refused by the credential scanner/);
  assert.equal(s.store.calls.apply, 0);

  const applied = await s.run({ cleanup: true });
  assert.equal(applied.error, undefined, applied.error?.message);
  assert.equal(applied.result.removed, 2);
  assert.deepEqual(s.store.uids(), ["drive:clean-file", "drive:keep-file"]);
  assert.equal(s.state.done["drive:excluded-file"], undefined);
  assert.equal(s.state.done["drive:secret-file"], undefined);
  const reads = (id) => s.calls.filter((call) => call.media && call.path === `/files/${id}`).length;
  assert.equal(reads("keep-file"), 1, "cleanup does not re-read a file that was never refused");
  assert.equal(reads("clean-file"), 3, "cleanup re-scans a marked file before removing it");
});

// A file accepted under an older scanner and refused by the current one keeps
// its stored copy on the add-only pass. Its refusal marker is what --cleanup
// looks for, so a later additive pass must not erase it as "unchanged".
for (const [label, forceAdditivePass] of [
  ["the change token expires", (s) => { s.world.changesExpired = true; }],
  ["the settings change", (s) => { s.manifest.corpora.google_drive.exclude_file_ids = ["unrelated-file"]; }],
]) {
  test(`a credential refusal survives a second additive pass when ${label}, so cleanup removes the file`, async (t) => {
    const credential = ["sk", "a".repeat(32)].join("-");
    const entries = [folder("owner-drive", "Owner Drive"), folder(ROOT, "Folder Alpha", "owner-drive"),
      file("keep-file"), file("secret-file")];
    const s = scenario(t, entries);
    // An older build accepted and stored both files at their current version.
    const accepted = await s.run();
    assert.equal(accepted.error, undefined, accepted.error?.message);
    const acceptedVersion = s.state.done["drive:secret-file"];
    assert.ok(acceptedVersion, "the older load recorded the accepted version");
    // The file itself never changes; only the scanner does. The double serves
    // the credential from now on to stand in for the older scanner passing it.
    s.world.content.set("secret-file", `${TEXT} Synthetic scanner fixture ${credential}`);
    s.state.credential_scanner_fingerprint = "older-scanner-fixture";
    s.state.drive_policy_fingerprint = "older-policy-fixture";

    const first = await s.run();
    assert.equal(first.error, undefined, first.error?.message);
    assert.match(first.output, /nothing is removed on this pass/);
    assert.ok(s.store.uids().includes("drive:secret-file"), "the first additive pass keeps the refused file");
    assert.match(String(s.state.skipped["drive:secret-file"]), /^refused: carries /);
    assert.equal(s.state.credential_scanner_fingerprint, credentialScannerFingerprint(true));
    assert.equal(s.state.sync_token, "token-1");

    forceAdditivePass(s);
    const second = await s.run();
    assert.equal(second.error, undefined, second.error?.message);
    assert.match(second.output, /nothing is removed on this pass/);
    assert.ok(s.store.uids().includes("drive:secret-file"), "the second additive pass keeps the refused file too");
    assert.match(String(s.state.skipped["drive:secret-file"]), /^refused: carries /,
      "a later additive pass erased the refusal marker cleanup depends on");

    s.world.changesExpired = false;
    const cleanup = await s.run({ cleanup: true });
    assert.equal(cleanup.error, undefined, cleanup.error?.message);
    assert.equal(cleanup.result.credential_refused, 1);
    assert.equal(cleanup.result.removed, 1);
    assert.match(cleanup.output, /0 excluded by the current settings; 1 refused by the credential scanner/);
    assert.deepEqual(s.store.uids(), ["drive:keep-file"], "the credential-bearing file is no longer stored");
  });
}

// A scanned PDF has text only through OCR. The page reader below stands in for
// the callback a run builds from the OCR settings, and is used only when the
// run actually passes one.
function scannedCredentialScenario(t) {
  const credential = ["sk", "a".repeat(32)].join("-");
  const scan = { ...file("scan-file"), name: "scan-file.pdf", mimeType: "application/pdf", size: String(scanPdf().length) };
  const s = scenario(t, [folder("owner-drive", "Owner Drive"), folder(ROOT, "Folder Alpha", "owner-drive"),
    file("keep-file"), scan]);
  s.manifest.safety.ocr.enabled = true;
  s.world.content.set("scan-file", scanPdf());
  s.store.put("drive:scan-file");
  const ocrPassed = [];
  const stubOcr = async () => ({ text: `${TEXT} Synthetic scanner fixture ${credential}` });
  stubOcr.model = "@cf/fixture/ocr";
  stubOcr.maxPages = 2;
  const toEnvelope = s.connector.toEnvelope;
  s.connector.toEnvelope = (get, entry, args) => {
    const configured = typeof args?.ocr === "function";
    if (entry.id === "scan-file") ocrPassed.push(configured);
    return toEnvelope(get, entry, { ...args, ocr: configured ? stubOcr : null });
  };
  return { ...s, ocrPassed };
}

test("cleanup re-reads a marked scanned PDF with the configured OCR and removes it when the scanner still refuses", async (t) => {
  const s = scannedCredentialScenario(t);
  const daily = await s.run();
  assert.equal(daily.error, undefined, daily.error?.message);
  assert.match(String(s.state.skipped["drive:scan-file"]), /^refused: carries /, "the OCR text is refused");
  assert.ok(s.store.uids().includes("drive:scan-file"), "the additive pass keeps the stored copy");

  const preview = await s.run({ cleanup: true, "dry-run": true });
  assert.equal(preview.error, undefined, preview.error?.message);
  assert.equal(preview.result.credential_refused, 0, "a dry run never sends a page to OCR");
  assert.equal(preview.result.credential_unreadable, 1, "so the scanned file is counted, not kept silently");
  assert.equal(preview.result.in_roots, 1);
  assert.match(preview.output,
    /1 marked as carrying a credential but could not be re-read[^\n]*run without --dry-run to re-read with OCR/);

  const applied = await s.run({ cleanup: true });
  assert.equal(applied.error, undefined, applied.error?.message);
  assert.equal(applied.result.credential_refused, 1);
  assert.equal(applied.result.credential_unreadable, 0);
  assert.equal(applied.result.removed, 1);
  assert.doesNotMatch(applied.output, /could not be re-read/);
  assert.deepEqual(s.store.uids(), ["drive:keep-file"]);
  assert.deepEqual(s.ocrPassed, [true, false, true],
    "the daily run and the real cleanup pass the configured OCR; the dry run does not");
});

test("cleanup without OCR counts a marked scanned PDF on its own line and keeps it, in the dry run and the real run", async (t) => {
  const s = scannedCredentialScenario(t);
  const daily = await s.run();
  assert.equal(daily.error, undefined, daily.error?.message);
  assert.match(String(s.state.skipped["drive:scan-file"]), /^refused: carries /);
  s.manifest.safety.ocr.enabled = false;

  const preview = await s.run({ cleanup: true, "dry-run": true });
  const applied = await s.run({ cleanup: true });
  for (const [name, run] of [["dry run", preview], ["real run", applied]]) {
    assert.equal(run.error, undefined, `${name}: ${run.error?.message}`);
    assert.equal(run.result.credential_unreadable, 1, `${name} counted the unreadable marked file as kept`);
    assert.equal(run.result.credential_refused, 0, name);
    assert.equal(run.result.in_roots, 1, name);
    assert.match(run.output,
      /1 marked as carrying a credential but could not be re-read[^\n]*run with OCR enabled or remove manually/, name);
  }
  assert.equal(preview.result.would_remove, 0);
  assert.equal(applied.result.removed, 0);
  assert.deepEqual(s.store.uids(), ["drive:keep-file", "drive:scan-file"], "a file that could not be re-read is kept");
  assert.match(String(s.state.skipped["drive:scan-file"]), /^refused: carries /, "its marker stays for a later cleanup");
  assert.deepEqual(s.ocrPassed, [true, false, false]);
});

test("a file that only left this account's view is counted daily, then --cleanup removes it on its own counted line", async (t) => {
  const entries = baseEntries();
  const s = scenario(t, entries);
  s.seedSynced(entries.filter((entry) => entry.mimeType !== drive.FOLDER_MIME && entry.id !== "big-file"));
  // Google now answers "not found" for it, and the feed says removed: true.
  s.world.byId.delete("gone-file");
  s.world.changes = [{ fileId: "gone-file", removed: true }];
  const daily = await s.run();
  assert.equal(daily.error, undefined, daily.error?.message);
  assert.match(daily.output, /1 Drive file\(s\) are no longer visible to this account; their stored documents are kept/);
  assert.ok(s.store.uids().includes("drive:gone-file"), "the daily run keeps it");
  assert.equal(s.store.calls.apply, 0);
  assert.equal(s.state.sync_token, "token-2", "the cursor advances");

  const preview = await s.run({ cleanup: true, "dry-run": true });
  assert.equal(preview.error, undefined, preview.error?.message);
  assert.equal(preview.result.not_visible, 1);
  assert.equal(preview.result.gone, 0);
  assert.equal(preview.result.would_remove, 1);
  assert.match(preview.output, /1 no longer visible to this account \(Google says not found\); a real run removes them/);
  assert.ok(s.store.uids().includes("drive:gone-file"), "a dry run removes nothing");

  const applied = await s.run({ cleanup: true });
  assert.equal(applied.error, undefined, applied.error?.message);
  assert.equal(applied.result.not_visible, 1);
  assert.equal(applied.result.removed, 1);
  assert.match(applied.output, /1 no longer visible to this account \(Google says not found\); removed below/);
  assert.equal(s.store.uids().includes("drive:gone-file"), false);
  assert.equal(s.state.done["drive:gone-file"], undefined);
});

test("the dry run's no-longer-visible line counts only files that were stored", async (t) => {
  const entries = baseEntries();
  const s = scenario(t, entries);
  s.seedSynced(entries.filter((entry) => entry.mimeType !== drive.FOLDER_MIME && entry.id !== "big-file"));
  s.world.byId.delete("gone-file");
  // gone-file was stored; the other two left this account's view without ever being stored.
  s.world.changes = [{ fileId: "gone-file", removed: true }, { fileId: "never-stored-a", removed: true },
    { fileId: "never-stored-b", removed: true }];
  const preview = await s.run({ "dry-run": true });
  assert.equal(preview.error, undefined, preview.error?.message);
  assert.match(preview.output, /(?:^|\s)1 Drive file\(s\) are no longer visible to this account; their stored documents are kept/);
  assert.doesNotMatch(preview.output, /[23] Drive file\(s\) are no longer visible/);
  assert.equal(s.store.calls.preview + s.store.calls.apply, 0, "a dry run touches nothing");
  assert.equal(s.state.sync_token, "token-1");

  // The real run counts the same way, from the stored inventory.
  const real = await s.run();
  assert.equal(real.error, undefined, real.error?.message);
  assert.match(real.output, /(?:^|\s)1 Drive file\(s\) are no longer visible to this account; their stored documents are kept/);

  // Nothing stored among them: no line at all.
  s.world.changes = [{ fileId: "never-stored-a", removed: true }];
  const none = await s.run({ "dry-run": true });
  assert.equal(none.error, undefined, none.error?.message);
  assert.doesNotMatch(none.output, /no longer visible/);
});

test("a trashed or moved-out file whose at-once removal fails stays pending with the retry code and holds the cursor; the next run removes it", async (t) => {
  const entries = baseEntries();
  const s = scenario(t, entries);
  s.seedSynced(entries.filter((entry) => entry.mimeType !== drive.FOLDER_MIME && entry.id !== "big-file"));
  s.world.changes = [
    { fileId: "trash-file", removed: false, file: { ...s.world.byId.get("trash-file"), trashed: true } },
    { fileId: "move-file", removed: false, file: { ...s.world.byId.get("move-file"), parents: [OUTSIDE] } },
  ];
  s.removal.fail = true;
  const failed = await s.run();
  assert.equal(failed.error?.code, "REMOVAL_RETRY_PENDING", `${failed.error?.name}: ${failed.error?.message}`);
  assert.equal(failed.error instanceof DriveRemovalReviewRequired, false, "not a review stop");
  assert.doesNotMatch(failed.error.message, /review/i);
  assert.match(failed.error.message,
    /^2 trashed, moved-out or excluded Drive file\(s\) were not removed yet \(Authenticated removal request failed\. HTTP 503\)\. They stay pending, the cursor was not advanced, and the next run retries them\.$/);
  assert.equal(s.receipts.at(-1).status, "error");
  assert.equal(s.receipts.at(-1).issue_code, "REMOVAL_RETRY_PENDING");
  assert.equal(s.state.sync_token, "token-1", "the cursor is held");
  assert.ok(s.store.uids().includes("drive:trash-file") && s.store.uids().includes("drive:move-file"), "both are still stored");
  assert.ok(s.state.done["drive:trash-file"], "the accepted version stays until the removal lands");

  s.removal.fail = false;
  const retried = await s.run();
  assert.equal(retried.error, undefined, `${retried.error?.message}
${retried.output.slice(-1200)}`);
  assert.equal(s.store.uids().includes("drive:trash-file"), false, "the next run retries and removes it");
  assert.equal(s.store.uids().includes("drive:move-file"), false);
  assert.match(retried.output, /removed 2 stored Drive document\(s\) for 2 trashed, moved-out or excluded file\(s\)/);
  assert.equal(s.state.sync_token, "token-2");
  assert.equal(s.receipts.at(-1).status, "ready");
});

test("a reloaded file whose stale split-part cleanup fails stays pending with the retry code and holds the cursor; the next run removes the parts", async (t) => {
  const entries = baseEntries();
  const s = scenario(t, entries);
  s.seedSynced(entries.filter((entry) => entry.mimeType !== drive.FOLDER_MIME && entry.id !== "big-file"));
  // An earlier load stored edit-file in two parts. It now fits in one document.
  s.store.db.prepare("DELETE FROM documents WHERE doc_uid='drive:edit-file'").run();
  for (const part of [1, 2]) s.store.put(`drive:edit-file#part${part}of2`, { part_of: "edit-file" });
  s.world.byId.set("edit-file", { ...s.world.byId.get("edit-file"), modifiedTime: "2026-10-10T00:00:00Z", md5Checksum: "edit-file-v2" });
  s.world.changes = [{ fileId: "edit-file", removed: false, file: s.world.byId.get("edit-file") }];
  s.removal.fail = true;
  const failed = await s.run();
  assert.equal(failed.error?.code, "REMOVAL_RETRY_PENDING", `${failed.error?.name}: ${failed.error?.message}`);
  assert.equal(failed.error instanceof DriveRemovalReviewRequired, false, "not a review stop");
  assert.doesNotMatch(failed.error.message, /review/i);
  assert.match(failed.error.message,
    /^1 set\(s\) of stale split parts of reloaded Drive file\(s\) were not removed yet \(Authenticated removal request failed\. HTTP 503\)\. They stay pending, the cursor was not advanced, and the next run retries them\.$/);
  assert.equal(s.receipts.at(-1).status, "error");
  assert.equal(s.receipts.at(-1).issue_code, "REMOVAL_RETRY_PENDING");
  assert.equal(s.state.sync_token, "token-1", "the cursor is held");
  assert.deepEqual(s.sent, ["edit-file"], "the reload itself was accepted");
  assert.deepEqual(s.store.uids().filter((uid) => uid.startsWith("drive:edit-file")),
    ["drive:edit-file", "drive:edit-file#part1of2", "drive:edit-file#part2of2"], "the stale parts are still stored, pending");

  s.removal.fail = false;
  const retried = await s.run();
  assert.equal(retried.error, undefined, `${retried.error?.message}
${retried.output.slice(-1200)}`);
  assert.deepEqual(s.store.uids().filter((uid) => uid.startsWith("drive:edit-file")), ["drive:edit-file"],
    "the next run retries and removes the stale parts");
  assert.match(retried.output, /removed 2 stale split part\(s\) of reloaded Drive file\(s\)/);
  assert.deepEqual(s.sent, ["edit-file"], "the accepted reload is not sent again");
  assert.equal(s.state.sync_token, "token-2");
  assert.equal(s.receipts.at(-1).status, "ready");
});

test("the saved My Drive id is ignored once include_my_drive_root_files is off", async (t) => {
  const entries = [folder("owner-drive", "Owner Drive"), folder(ROOT, "Folder Alpha", "owner-drive"),
    file("loose-file", "owner-drive"), file("keep-file")];
  const s = scenario(t, entries, { driveConfig: { include_my_drive_root_files: true }, myDriveId: "owner-drive" });
  const first = await s.run();
  assert.equal(first.error, undefined, first.error?.message);
  assert.equal(s.state.drive_my_drive_root_id, "owner-drive", "the first pass saved the id");
  assert.deepEqual([...s.sent].sort(), ["keep-file", "loose-file"]);

  s.manifest.corpora.google_drive.include_my_drive_root_files = false;
  const policyPass = await s.run();
  assert.equal(policyPass.error, undefined, policyPass.error?.message);
  assert.match(policyPass.output, /nothing is removed on this pass/);
  assert.equal(s.state.drive_my_drive_root_id, "owner-drive", "the saved id is still in state");

  s.sent.length = 0;
  const callsBefore = s.calls.length;
  s.world.byId.set("loose-file", { ...s.world.byId.get("loose-file"), modifiedTime: "2026-10-10T00:00:00Z", md5Checksum: "loose-file-v2" });
  s.world.changes = [{ fileId: "loose-file", removed: false, file: s.world.byId.get("loose-file") }];
  const daily = await s.run();
  assert.equal(daily.error, undefined, daily.error?.message);
  assert.deepEqual(s.sent, [], "a changed loose My Drive file is not loaded once the flag is off");
  assert.equal(s.calls.slice(callsBefore).some((call) => call.media), false, "it is not downloaded");
  assert.equal(s.store.uids().includes("drive:loose-file"), false,
    "like any changed file outside the roots, its stored copy is removed at once");
  assert.ok(s.store.uids().includes("drive:keep-file"));
  assert.equal(s.state.sync_token, "token-2");
});

test("root scope follows the saved folder index, and My Drive admits direct children only", () => {
  const folders = drive.updateFolderIndex([folder(ROOT, "Folder Alpha", "owner-drive"), folder("child", "Child", ROOT),
    folder(OUTSIDE, "Folder Outside", "owner-drive")]);
  const scope = { rootFolderIds: [ROOT], folders, myDriveRootId: "owner-drive" };
  assert.equal(driveFileInRoots(file("a", "child"), scope), true);
  assert.equal(driveFileInRoots(file("b", "owner-drive"), scope), true);
  assert.equal(driveFileInRoots(file("c", OUTSIDE), scope), false);
  assert.equal(driveFileInRoots(file("d", OUTSIDE), { ...scope, myDriveRootId: null }), false);
});

test("removal batches preview, apply with the preview marker, then read back", async () => {
  const bodies = [];
  let generation = 0;
  const gone = new Set();
  const request = async ({ body }) => {
    bodies.push(body.action);
    if (body.action === "preview") {
      return { marker: { generation }, targets: body.families.map((f) => f.base_doc_uid).filter((uid) => !gone.has(uid)) };
    }
    generation++;
    for (const uid of body.targets) gone.add(uid);
    return { documents: body.targets.length, marker: { generation } };
  };
  const families = Array.from({ length: 120 }, (_, i) => ({ base_doc_uid: `drive:x${i}`, keep_doc_uids: [] }));
  const lines = [];
  const result = await removeDriveFamilies({ families, base: "b", adminKey: "k", request, onProgress: (l) => lines.push(l) });
  assert.deepEqual(result, { matched: 120, removed: 120, preserved: 0 });
  assert.deepEqual(bodies, ["preview", "apply", "preview", "preview", "apply", "preview", "preview", "apply", "preview"]);
  assert.equal(lines.length, 3);
  gone.clear();
  bodies.length = 0;
  const dry = await removeDriveFamilies({ families, base: "b", adminKey: "k", request, dryRun: true, onProgress: () => {} });
  assert.equal(dry.removed, 0);
  assert.equal(dry.matched, 120);
  assert.deepEqual(bodies, ["preview", "preview", "preview"], "a dry run never applies");
  // A success-shaped apply that left the family behind is caught on readback.
  const stale = async ({ body }) => (body.action === "preview"
    ? { marker: { generation }, targets: body.families.map((f) => f.base_doc_uid) }
    : { documents: body.targets.length, marker: { generation: ++generation } });
  await assert.rejects(removeDriveFamilies({ families: families.slice(0, 1), base: "b", adminKey: "k", request: stale,
    onProgress: () => {} }), /Removal readback found remaining targets/);
});
