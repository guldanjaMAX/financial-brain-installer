import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as drive from "../connectors/google-drive.mjs";
import { cmdIngestRemote, driveConnectorConfig, drivePolicyFingerprint,
  credentialScannerFingerprint } from "../brain.mjs";
import { batchStream, splitOversized, prefetch } from "../ingest/run.mjs";
import { ingestPlanStore } from "./helpers/ingest-plan-store.mjs";

globalThis.fetch = async () => { throw new Error("unexpected network attempt"); };
const content = "This synthetic document records a reviewed project decision. The owner approved the schedule and the next review will confirm progress against the plan.";
const textFile = (id, parent, name = `${id}.txt`, extra = {}) => ({
  id, name, mimeType: "text/plain", parents: [parent], size: String(content.length),
  createdTime: "2026-10-01T00:00:00Z", modifiedTime: "2026-10-01T00:00:00Z", ...extra,
});
const folder = (id, name, parent) => ({ id, name, mimeType: drive.FOLDER_MIME, parents: parent ? [parent] : [] });

function fixture({ omitLoose = false, incomplete = false, repeat = false } = {}) {
  const entries = [
    folder("my-drive-id", "My Drive"), folder("reviewed", "Reviewed Root", "my-drive-id"),
    folder("unselected", "Unselected", "my-drive-id"), folder("design", "Design", "reviewed"),
    folder("design-notes", "Design Notes", "reviewed"),
    textFile("loose", "my-drive-id"), textFile("excluded-id", "my-drive-id"),
    textFile("private", "my-drive-id", "_Private draft.txt"),
    textFile("name-excluded", "my-drive-id", "scratch draft.txt"),
    textFile("path-excluded", "my-drive-id", "omit.txt"),
    textFile("large", "my-drive-id", "large.txt", { size: drive.DOWNLOAD_LIMIT + 1 }),
    textFile("image", "my-drive-id", "image.png", { mimeType: "image/png" }),
    textFile("shortcut", "my-drive-id", "shortcut", { mimeType: drive.SHORTCUT_MIME }),
    textFile("rooted", "reviewed"), textFile("design-file", "design"),
    textFile("design-note", "design-notes"), textFile("outside", "unselected"),
  ];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const calls = [];
  const opts = { attempts: 1, fetchImpl: async (input) => {
    const url = new URL(input);
    const id = url.pathname.split("/").at(-1);
    const query = url.searchParams.get("q");
    calls.push({ id, query, page: url.searchParams.get("pageToken"), media: url.searchParams.get("alt") === "media" });
    if (id === "files") {
      const parent = /^'([^']+)' in parents and trashed\s*=\s*false$/.exec(query)?.[1];
      assert.ok(parent, "every listing must be bounded to one parent");
      const children = entries.filter((entry) => entry.parents.includes(parent === "root" ? "my-drive-id" : parent));
      if (parent === "root") {
        const selected = children.filter((entry) => !omitLoose || entry.id !== "loose");
        const secondPage = url.searchParams.has("pageToken");
        return Response.json({ files: secondPage ? selected.slice(3) : selected.slice(0, 3),
          ...(incomplete ? { incompleteSearch: true } : {}),
          ...(!secondPage || repeat ? { nextPageToken: "page-2" } : {}) });
      }
      return Response.json({ files: children });
    }
    if (url.searchParams.get("alt") === "media") {
      assert.ok(byId.has(id));
      return new Response(content);
    }
    assert.ok(byId.has(id === "root" ? "my-drive-id" : id), "unexpected metadata lookup");
    return Response.json(byId.get(id === "root" ? "my-drive-id" : id));
  } };
  return { opts, calls, byId };
}
const token = async () => randomBytes(16).toString("hex");
const collect = async (iterable) => { const out = []; for await (const item of iterable) out.push(item); return out; };
const policy = { excludeFileIds: ["excluded-id"], excludePaths: ["omit.txt", "Reviewed Root/Design"],
  excludeNameParts: ["scratch"], privatePrefixes: ["_Private"] };

test("root files are paginated without descending into unselected folders", async () => {
  const f = fixture();
  const files = await collect(drive.listRootedFiles(token, {
    rootFolderIds: ["reviewed"], includeMyDriveRootFiles: true, opts: f.opts,
  }));
  assert.ok(files.some((file) => file.id === "loose"), "the direct-root listing must be reached");
  assert.equal(f.calls.filter((call) => call.query?.startsWith("'root' in parents")).length, 2);
  assert.ok(files.some((file) => file.id === "design-file"), "the selected recursive root remains a green control");
  assert.equal(files.some((file) => file.id === "unselected" || file.id === "outside"), false);
  assert.equal(f.calls.some((call) => call.query?.includes("'unselected'")), false);
  const index = drive.updateFolderIndex(files);
  assert.equal(drive.folderPathFor(f.byId.get("loose"), index), "");
  assert.equal(drive.folderPathFor(f.byId.get("rooted"), index), "Reviewed Root");
  const envelope = await drive.toEnvelope(token, f.byId.get("loose"), { pathOf: (file) => drive.folderPathFor(file, index) }, f.opts);
  assert.equal(envelope.envelope.metadata.top_folder, null);
  assert.equal(envelope.envelope.metadata.folder, null);
});

test("root-only policy is explicit, boolean, and invalidates the incremental policy", () => {
  const manifest = (flag, roots = []) => ({ corpora: { google_drive: { root_folder_ids: roots,
    ...(flag === undefined ? {} : { include_my_drive_root_files: flag }) } } });
  const cfg = driveConnectorConfig(manifest(true), "fixture.json");
  assert.equal(cfg.includeMyDriveRootFiles, true);
  assert.deepEqual(cfg.rootFolderIds, []);
  assert.throws(() => driveConnectorConfig(manifest(false), "fixture.json"), /root_folder_ids/);
  assert.throws(() => driveConnectorConfig(manifest("true", ["reviewed"]), "fixture.json"), /boolean/);
  const off = driveConnectorConfig(manifest(false, ["reviewed"]), "fixture.json");
  assert.equal(drivePolicyFingerprint(off), drivePolicyFingerprint(driveConnectorConfig(manifest(undefined, ["reviewed"]), "fixture.json")));
  assert.notEqual(drivePolicyFingerprint(off), drivePolicyFingerprint({ ...off, includeMyDriveRootFiles: true }));
});

test("root-only previews remain bounded and never walk child folders", async () => {
  const f = fixture();
  const files = await collect(drive.listRootedFilesPreview(token, {
    rootFolderIds: [], includeMyDriveRootFiles: true, limit: 5, opts: f.opts,
  }));
  assert.ok(files.some((file) => file.id === "loose"));
  assert.ok(files.length <= 5);
  assert.ok(f.calls.some((call) => call.query));
  assert.equal(f.calls.some((call) => call.query && !call.query.startsWith("'root' in parents")), false);
});

test("a complete root-only listing needs no recursive root and honors traversal limits", async () => {
  const f = fixture();
  const files = await collect(drive.listRootedFiles(token, {
    rootFolderIds: [], includeMyDriveRootFiles: true, opts: f.opts,
  }));
  assert.ok(files.some((file) => file.id === "loose"));
  assert.equal(files.some((file) => file.id === "rooted"), false);
  assert.equal(f.calls.filter((call) => call.query).length, 2);
  for (const [bound, reason] of [[{ maxFiles: 1 }, "fileLimit"], [{ maxPages: 1 }, "pageLimit"]]) {
    const limited = fixture();
    const emitted = [];
    await assert.rejects(async () => {
      for await (const file of drive.listRootedFiles(token, {
        rootFolderIds: [], includeMyDriveRootFiles: true, ...bound, opts: limited.opts,
      })) emitted.push(file);
    }, (error) => error.reason === reason);
    assert.ok(limited.calls.some((call) => call.query), "the bounded listing decision was reached");
    assert.deepEqual(emitted, []);
  }
});

test("explicitly selected My Drive stays recursive and overlapping scopes deduplicate", async () => {
  for (const listing of [drive.listRootedFiles, drive.listRootedFilesPreview]) {
    const f = fixture();
    const files = await collect(listing(token, {
      rootFolderIds: ["my-drive-id", "reviewed"], includeMyDriveRootFiles: true, limit: 100, opts: f.opts,
    }));
    assert.ok(files.some((file) => file.id === "outside"), "the explicit recursive root authorizes its descendants");
    assert.equal(files.filter((file) => file.id === "loose").length, 1);
    assert.equal(drive.folderPathFor(f.byId.get("loose"), drive.updateFolderIndex(files)), "");
  }
});

test("root files use the same exclusions, media rules and download size ceiling", async () => {
  const f = fixture();
  const files = await collect(drive.listRootedFiles(token, {
    rootFolderIds: ["reviewed"], includeMyDriveRootFiles: true, opts: f.opts,
  }));
  const index = drive.updateFolderIndex(files);
  const accepted = [];
  const skipped = [];
  for (const file of files) {
    const pathOf = (entry) => drive.folderPathFor(entry, index);
    const reason = drive.exclusionReason(file, pathOf(file), policy);
    if (reason) { skipped.push(file.id); continue; }
    const result = await drive.toEnvelope(token, file, { pathOf }, f.opts);
    if (result?.skip) skipped.push(file.id);
    if (result?.envelope) accepted.push(file.id);
  }
  assert.deepEqual(accepted.sort(), ["design-note", "loose", "rooted"]);
  for (const id of ["excluded-id", "private", "name-excluded", "path-excluded", "large", "image", "shortcut", "design-file"]) {
    assert.ok(skipped.includes(id), "the exclusion decision must be reached");
    assert.equal(f.calls.some((call) => call.id === id && call.media), false);
  }
  assert.equal(drive.exclusionReason(f.byId.get("design-file"), "Reviewed Root/Design", { excludePaths: ["Design"] }), null,
    "a bare child name is not a path prefix under the named root");
  assert.ok(drive.exclusionReason(f.byId.get("design-file"), "Reviewed Root/Design", { excludePaths: ["reviewed root/design/"] }));
});

for (const fault of ["incomplete", "repeat"]) test(`root-only ${fault} listing refuses before yielding any files`, async () => {
  const f = fixture({ [fault]: true });
  const yielded = [];
  await assert.rejects(async () => {
    for await (const file of drive.listRootedFiles(token, { rootFolderIds: ["reviewed"], includeMyDriveRootFiles: true, opts: f.opts })) yielded.push(file);
  }, (error) => error.reason === (fault === "incomplete" ? "incompleteSearch" : "repeatedPageToken"));
  assert.ok(f.calls.some((call) => call.query?.startsWith("'root' in parents")), "the failed listing was attempted");
  assert.deepEqual(yielded, []);
});

async function runCommand(t, { enabled, omitLoose = false, preview = false, rootOnly = false, excludeLoose = false, cleanup = false, connector = drive }) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "drive-root-files-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifestPath = join(directory, "manifest.json");
  const manifest = { brain: { domain: "fixture.invalid" },
    corpora: { google_drive: { root_folder_ids: rootOnly ? [] : ["reviewed"], include_my_drive_root_files: enabled,
      exclude_paths: ["omit.txt", "Reviewed Root/Design"], exclude_file_ids: ["excluded-id", ...(excludeLoose ? ["loose"] : [])],
      exclude_name_parts: ["scratch", "large", "image", "shortcut"] } },
    safety: { private_path_prefixes: ["_Private"], credential_scanner: { enabled: true }, ocr: { enabled: false } } };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const f = fixture({ omitLoose });
  const stored = new Set(["drive:loose", "drive:outside"]);
  const store = ingestPlanStore();
  t.after(() => store.db.close());
  for (const uid of stored) store.put(uid);
  const state = { version: 1, done: {}, skipped: {}, credential_scanner_fingerprint: credentialScannerFingerprint(true) };
  let inventoryReads = 0;
  let credentialReads = 0;
  const sent = [];
  const options = {
    removalPlanRequest: store.request, removalPlanRuntime: () => "fixture-runtime",
    withSourceIngestLock: async (_input, run) => run({ assertOwned() {} }),
    resolveBaseUrl: async () => "https://fixture.invalid",
    resolveAdminKey: () => { credentialReads++; return randomBytes(32).toString("hex"); },
    getAccessToken: token,
    ingestLib: async () => ({ batchStream, splitOversized, prefetch, loadState: () => state, saveState() {} }),
    drive: { ...connector,
      startPageToken: async () => "next-cursor",
      listRootedFiles: (get, args) => connector.listRootedFiles(get, { ...args, opts: f.opts }),
      listRootedFilesPreview: (get, args) => connector.listRootedFilesPreview(get, { ...args, opts: f.opts }),
      classifyScopedAbsence: (get, id, args) => connector.classifyScopedAbsence(get, id, { ...args, opts: f.opts }),
      toEnvelope: (get, file, args) => connector.toEnvelope(get, file, args, f.opts),
    },
    listStoredSourceFamilies: async ({ includeServerObservedAt, includeLabels }) => {
      inventoryReads++;
      if (includeServerObservedAt || includeLabels) return { families: new Set(stored), malformedIdentities: new Set(),
        serverObservedAt: "2026-10-12T00:00:00Z", labels: new Map(), labelsAvailable: true };
      return new Set(stored);
    },
    sendBatches: async ({ groups, onResult }) => {
      for (const item of groups.flat()) {
        sent.push(item.envelope);
        stored.add(`drive:${item.envelope.source_id}`);
        store.put(`drive:${item.envelope.source_id}`);
        onResult(item, { status: "created" });
      }
      return { created: groups.flat().length };
    },
    reconcileDocumentFamilies: async () => 0,
    applyDriveRemovals: async () => { throw new Error("ordinary ingest must not remove"); },
    postSourceReceipt: async () => ({}),
  };
  let result, error;
  const log = console.log;
  console.log = () => {};
  try {
    result = await cmdIngestRemote(manifest, manifestPath, { from: "drive",
      ...(preview ? { "dry-run": true, json: true } : {}), ...(cleanup ? { cleanup: true } : {}) }, options);
  }
  catch (caught) { error = caught; }
  finally { console.log = log; }
  return { result, error, state, inventoryReads, sent, calls: f.calls, store, credentialReads };
}

// Packet 10: the daily first pass is add-only; the one-time --cleanup is where
// stored files outside the current scope are removed.
for (const enabled of [true, false]) test(`daily first pass is add-only and cleanup ${enabled ? "keeps" : "removes"} loose files with flag ${enabled}`, async (t) => {
  const daily = await runCommand(t, { enabled });
  assert.equal(daily.error, undefined, daily.error?.message);
  assert.ok(daily.inventoryReads > 0);
  assert.equal(daily.store.calls.apply, 0, "the first pass never removes");
  assert.deepEqual(daily.store.uids().filter((uid) => ["drive:loose", "drive:outside"].includes(uid)), ["drive:loose", "drive:outside"]);
  assert.equal(daily.state.ingest_removal_plan, undefined);
  assert.ok(daily.sent.some((entry) => entry.source_id === "rooted"), "the green control was ingested");
  if (enabled) assert.equal(daily.sent.find((entry) => entry.source_id === "loose").metadata.top_folder, null);
  else assert.equal(daily.calls.some((call) => call.query?.startsWith("'root' in parents")), false);

  const cleanup = await runCommand(t, { enabled, cleanup: true });
  assert.equal(cleanup.error, undefined, cleanup.error?.message);
  assert.deepEqual(cleanup.store.uids(), enabled ? ["drive:loose"] : []);
  assert.equal(cleanup.result.outside_roots, enabled ? 1 : 2);
});

test("cleanup keeps an omitted root file that Google still places in scope", async (t) => {
  const result = await runCommand(t, { enabled: true, omitLoose: true, cleanup: true });
  assert.equal(result.error, undefined, result.error?.message);
  assert.ok(result.calls.some((call) => call.id === "loose" && !call.media), "absence metadata decision was reached");
  assert.deepEqual(result.store.uids(), ["drive:loose"]);
  assert.equal(result.result.kept, 1);
});

test("cleanup removes a stored loose file the current settings exclude", async (t) => {
  const result = await runCommand(t, { enabled: true, excludeLoose: true, cleanup: true });
  assert.equal(result.error, undefined, result.error?.message);
  assert.ok(result.calls.some((call) => call.query?.startsWith("'root' in parents")));
  assert.equal(result.result.excluded, 1);
  assert.deepEqual(result.store.uids(), []);
});

test("real assistant preview supports only loose files with zero recursive roots", async (t) => {
  const result = await runCommand(t, { enabled: true, preview: true, rootOnly: true });
  assert.equal(result.error, undefined);
  assert.equal(result.result.configured_root_count, 0);
  assert.equal(result.result.include_my_drive_root_files, true);
  assert.equal(result.result.counts.would_send, 1);
  assert.equal(result.credentialReads, 0);
  assert.equal(result.inventoryReads, 0);
});

test("mutation controls catch missing root listing, folder scope leakage, and lost absence protection", async (t) => {
  const sourceUrl = new URL("../connectors/google-drive.mjs", import.meta.url);
  const source = readFileSync(sourceUrl, "utf8");
  const loadMutant = async (before, after) => {
    assert.ok(source.includes(before), "mutation must change the live decision point");
    const mutated = source.replace(before, after).replace(
      /((?:from\s+|import\s*)["'])(\.\.?\/[^"']+)(["'])/g,
      (_match, prefix, relative, suffix) => `${prefix}${new URL(relative, sourceUrl).href}${suffix}`,
    );
    return import(`data:text/javascript;base64,${Buffer.from(mutated).toString("base64")}`);
  };
  const assertListing = async (connector) => {
    const f = fixture();
    const files = await collect(connector.listRootedFiles(token, {
      rootFolderIds: ["reviewed"], includeMyDriveRootFiles: true, opts: f.opts,
    }));
    assert.ok(files.some((file) => file.id === "rooted"), "recursive green control must be reached");
    assert.ok(files.some((file) => file.id === "loose"), "missing direct root file");
    assert.equal(files.some((file) => file.id === "unselected"), false, "unselected folder leaked into scope");
  };
  await assertListing(drive);
  const noRoot = await loadMutant('if (includeMyDriveRootFiles === true) scopes.push', 'if (false) scopes.push');
  await assert.rejects(() => assertListing(noRoot), /missing direct root file/);
  const leakFolder = await loadMutant('if (shallow && file.mimeType === FOLDER_MIME) continue;', '/* mutation: admit unselected folders */');
  await assert.rejects(() => assertListing(leakFolder), /unselected folder leaked into scope/);
  const assertProtection = async (connector) => {
    const result = await runCommand(t, { enabled: true, omitLoose: true, cleanup: true, connector });
    assert.ok(result.calls.some((call) => call.id === "loose" && !call.media));
    assert.equal(result.store.uids().includes("drive:outside"), false, "nonempty removal control");
    assert.equal(result.store.uids().includes("drive:loose"), true, "lost root absence protection");
  };
  await assertProtection(drive);
  const noScopeCheck = await loadMutant('if (parents.some((parent) => scopedFolderIds.has(parent))) {', 'if (false) {');
  await assert.rejects(() => assertProtection(noScopeCheck), /lost root absence protection/);
});
