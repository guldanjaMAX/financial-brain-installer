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
import { ingestPlanStore } from "./helpers/ingest-plan-store.mjs";

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
    content: new Map() };
  // Google answers the "root" alias with the real My Drive folder.
  const alias = (id) => (id === "root" && myDriveId ? myDriveId : id);
  const calls = [];
  const json = (body, status = 200) => Response.json(body, { status });
  const opts = { attempts: 1, fetchImpl: async (input) => {
    const url = new URL(input);
    const path = url.pathname.replace(/^\/drive\/v3/, "");
    const media = url.searchParams.get("alt") === "media";
    calls.push({ path, query: url.searchParams.get("q"), media });
    if (path === "/changes/startPageToken") return json({ startPageToken: world.startToken });
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
    removalPlanRequest: store.request,
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
    const write = process.stdout.write;
    process.stdout.write = () => true;
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
  return { ...google, store, state, sent, receipts, failLoads, run, seedSynced, inventoryReads: () => inventoryReads };
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

test("incremental run loads changed and new files and removes trashed, deleted and moved-out files at once", async (t) => {
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
  assert.deepEqual(s.store.uids(), ["drive:big-file", "drive:edit-file", "drive:keep-file", "drive:new-file"],
    "trashed, deleted and moved-out files lose their stored document; the big file stays");
  assert.equal(s.state.done["drive:big-file"], bigVersion, "the over-limit file keeps its stored version");
  assert.deepEqual(s.calls.filter((call) => call.media).map((call) => call.path).sort(),
    ["/files/edit-file", "/files/new-file"], "only the changed readable files are downloaded");
  assert.equal(s.calls.some((call) => call.query), false, "no folder listing: no full re-walk");
  assert.equal(s.calls.some((call) => call.path === "/changes/startPageToken"), false);
  assert.equal(s.state.sync_token, "token-2", "the cursor advances to the feed's new start token");
  assert.ok(s.store.calls.apply >= 1, "removal applied without an approval stop");
  for (const uid of ["drive:trash-file", "drive:gone-file", "drive:move-file"]) assert.equal(s.state.done[uid], undefined);
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
  assert.match(preview.output, /1 under a root \(kept\); 2 trashed or not found at Google; 61 outside every root; 0 excluded by the current settings; 0 refused by the credential scanner; 1 kept/);

  const applied = await s.run({ cleanup: true });
  assert.equal(applied.error, undefined, applied.error?.message);
  assert.equal(applied.result.removed, 64);
  assert.deepEqual(s.store.uids(), ["drive:denied-x", "drive:in-root"]);
  assert.match(applied.output, /removal: 50 of 63 file\(s\) checked/);
  assert.match(applied.output, /removed 64 stored Drive document\(s\) for 63 file\(s\)/);
  assert.deepEqual(s.sent, [], "cleanup never loads documents");
});

test("an upgraded install with loose My Drive files recovers the root id, so a changed loose file is kept", async (t) => {
  const myDrive = { ...folder("owner-drive", "Owner Drive"), scope_my_drive_root: true };
  const entries = [folder("owner-drive", "Owner Drive"), folder(ROOT, "Folder Alpha", "owner-drive"),
    folder(OUTSIDE, "Folder Outside", "owner-drive"), file("loose-file", "owner-drive"), file("keep-file")];
  const s = scenario(t, entries, { driveConfig: { include_my_drive_root_files: true }, myDriveId: "owner-drive" });
  // Older builds saved the My Drive root with an empty name and never saved its id.
  s.seedSynced([s.world.byId.get("loose-file"), s.world.byId.get("keep-file")],
    [myDrive, folder(ROOT, "Folder Alpha", "owner-drive"), folder(OUTSIDE, "Folder Outside", "owner-drive")]);
  assert.equal(s.state.drive_folders["owner-drive"].name, "");
  assert.equal(s.state.drive_my_drive_root_id, undefined);
  s.world.changes = [{ fileId: "loose-file", removed: false,
    file: { ...s.world.byId.get("loose-file"), modifiedTime: "2026-10-10T00:00:00Z", md5Checksum: "loose-file-v2" } }];
  const { error, output } = await s.run();
  assert.equal(error, undefined, `${error?.message}
${output.slice(-1200)}`);
  assert.equal(s.state.drive_my_drive_root_id, "owner-drive", "the id comes from the saved folder index");
  assert.deepEqual(s.sent, ["loose-file"], "the changed loose file is reloaded, not removed");
  assert.deepEqual(s.store.uids(), ["drive:keep-file", "drive:loose-file"]);
  assert.equal(s.store.calls.apply, 0);
  assert.equal(s.state.sync_token, "token-2");
});

test("an upgraded install whose My Drive root id cannot be recovered makes one additive pass instead", async (t) => {
  const entries = [folder("owner-drive", "Owner Drive"), folder(ROOT, "Folder Alpha", "owner-drive"),
    folder(OUTSIDE, "Folder Outside", "owner-drive"), file("loose-file", "owner-drive"), file("keep-file")];
  const s = scenario(t, entries, { driveConfig: { include_my_drive_root_files: true }, myDriveId: "owner-drive" });
  s.seedSynced([s.world.byId.get("loose-file"), s.world.byId.get("keep-file")],
    [folder(ROOT, "Folder Alpha", "owner-drive"), folder(OUTSIDE, "Folder Outside", "owner-drive")]);
  s.world.byId.set("loose-file", { ...s.world.byId.get("loose-file"), modifiedTime: "2026-10-10T00:00:00Z", md5Checksum: "loose-file-v2" });
  s.world.changes = [{ fileId: "loose-file", removed: false, file: s.world.byId.get("loose-file") }];
  const { error, output } = await s.run();
  assert.equal(error, undefined, `${error?.message}
${output.slice(-1200)}`);
  assert.match(output, /My Drive root id is not known yet/);
  assert.equal(s.calls.some((call) => call.path === "/changes"), false, "the changes feed is not trusted on this run");
  assert.equal(s.calls[0].path, "/changes/startPageToken");
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
