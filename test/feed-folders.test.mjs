import assert from "node:assert/strict";
import { test } from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 as win32Path } from "node:path";

import {
  cmdFolder,
  cmdIngestLocal,
  credentialScannerFingerprint,
  planLoad,
} from "../brain.mjs";
import * as ingestRuntime from "../ingest/run.mjs";

const FIXED_NOW = new Date("2026-10-06T18:05:06.789Z");
const ROOT = process.env.FEED_FOLDERS_TEST_ROOT || tmpdir();
mkdirSync(ROOT, { recursive: true });
// Feeds refuse linked ancestors; macOS tmpdir() sits under the /var -> /private/var link.
const sandbox = realpathSync(mkdtempSync(join(ROOT, "feed-folders-test-")));

function manifestBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function baseManifest(upload = { enabled: false }) {
  return {
    manifest_version: 1,
    client: { slug: "fixture-brain", display_name: "Fixture Brain" },
    brain: { version: "0.4.9", domain: "fixture.invalid" },
    infrastructure: { cloudflare: { account_id: "fixture-account", storage: "d1" } },
    safety: { credential_scanner: { enabled: true }, private_path_prefixes: [] },
    corpora: { upload },
  };
}

function fixture({ manifest = baseManifest() } = {}) {
  const root = mkdtempSync(join(sandbox, "case-"));
  const home = join(root, "home");
  const manifestPath = join(root, "settings", "brain.manifest.json");
  mkdirSync(home, { recursive: true });
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, manifestBytes(manifest), { mode: 0o600 });
  return { root, home, manifestPath, manifest };
}

function folderOptions(f, extra = {}) {
  return {
    platform: "darwin",
    home: f.home,
    now: () => new Date(FIXED_NOW),
    ...extra,
  };
}

async function capture(task) {
  const lines = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values) => lines.push(values.map(String).join(" "));
  console.error = (...values) => lines.push(values.map(String).join(" "));
  try {
    return { result: await task(), error: null, text: lines.join("\n") };
  } catch (error) {
    return { result: null, error, text: lines.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function addFeed(f, path, source, options = {}) {
  return capture(() => cmdFolder(
    f.manifestPath,
    ["add", "--path", path, "--source", source],
    folderOptions(f, options),
  ));
}

function readManifest(f) {
  return JSON.parse(readFileSync(f.manifestPath, "utf8"));
}

function rejectionProbe() {
  const events = [];
  return {
    events,
    option: (event) => events.push(event),
  };
}

async function assertRejectedUnchanged(f, path, source, pattern, options = {}) {
  const before = readFileSync(f.manifestPath);
  const probe = rejectionProbe();
  const attempt = await addFeed(f, path, source, {
    ...options,
    onFeedDecision: probe.option,
  });
  assert.match(attempt.error?.message || "", pattern);
  assert.equal(probe.events.length, 1, "the refusal must reach one feed decision point");
  assert.equal(probe.events[0].outcome, "refused");
  assert.deepEqual(readFileSync(f.manifestPath), before, "a refusal keeps the manifest byte-identical");
  return attempt;
}

test("add is atomic, idempotent, and feeds the manifest-derived daily load plan", async () => {
  const f = fixture();
  const first = join(f.home, "Client files");
  const second = join(f.home, "Transcripts");
  mkdirSync(first);
  mkdirSync(second);

  const addedFirst = await addFeed(f, first, "client_files");
  assert.ifError(addedFirst.error);
  assert.match(addedFirst.text, new RegExp(`Added feed: ${realpathSync(first).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(source: client_files\\)`));
  const firstManifest = readManifest(f);
  assert.deepEqual(firstManifest.corpora.upload, {
    enabled: true,
    folders: [{ path: realpathSync(first), source: "client_files", feed: true }],
  });
  assert.ok(existsSync(addedFirst.result.backupPath));
  assert.deepEqual(readFileSync(addedFirst.result.backupPath), Buffer.from(manifestBytes(f.manifest)));

  const afterFirst = readFileSync(f.manifestPath);
  const backupsBeforeRerun = readdirSync(dirname(f.manifestPath)).filter((name) => name.includes("before-folder-feed"));
  const rerun = await addFeed(f, first, "client_files");
  assert.ifError(rerun.error);
  assert.equal(rerun.result.changed, false);
  assert.deepEqual(readFileSync(f.manifestPath), afterFirst);
  assert.deepEqual(
    readdirSync(dirname(f.manifestPath)).filter((name) => name.includes("before-folder-feed")),
    backupsBeforeRerun,
    "an idempotent rerun creates no extra backup",
  );

  const addedSecond = await addFeed(f, second, "transcripts", {
    now: () => new Date("2026-10-06T18:05:07.123Z"),
  });
  assert.ifError(addedSecond.error);
  const current = readManifest(f);
  const plan = await planLoad({ m: current, manifestPath: f.manifestPath });
  const upload = plan.find((entry) => entry.key === "upload");
  assert.equal(upload.status, "ready");
  assert.deepEqual(upload.legs.map((leg) => ({ source: leg.source, detail: leg.detail })), [
    { source: "client_files", detail: realpathSync(first) },
    { source: "transcripts", detail: realpathSync(second) },
  ]);
});

test("schema and public template declare feed entries and exclusions", () => {
  const schema = JSON.parse(readFileSync(new URL("../manifest.schema.json", import.meta.url), "utf8"));
  const upload = schema.properties.corpora.properties.upload.properties;
  assert.equal(upload.folders.type, "array");
  assert.equal(upload.folders.items.oneOf[1].properties.feed.type, "boolean");
  assert.equal(upload.exclude.type, "array");
  const template = JSON.parse(readFileSync(new URL("../templates/brain.manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(template.corpora.upload.folders, []);
  assert.deepEqual(template.corpora.upload.exclude, []);
});

test("create-feeds makes two empty home folders in one owner-approved command", async () => {
  const f = fixture();
  const created = await capture(() => cmdFolder(
    f.manifestPath,
    ["create-feeds"],
    folderOptions(f),
  ));
  assert.ifError(created.error);
  const parent = join(f.home, "Brain Feeds");
  const clientFiles = join(parent, "Client files");
  const transcripts = join(parent, "Transcripts");
  assert.deepEqual(readdirSync(clientFiles), []);
  assert.deepEqual(readdirSync(transcripts), []);
  assert.deepEqual(readManifest(f).corpora.upload.folders, [
    { path: realpathSync(clientFiles), source: "client_files", feed: true },
    { path: realpathSync(transcripts), source: "transcripts", feed: true },
  ]);
  assert.match(created.text, /Created feed folder: .*Brain Feeds.*Client files \(source: client_files\)/);
  assert.match(created.text, /Created feed folder: .*Brain Feeds.*Transcripts \(source: transcripts\)/);
  assert.match(created.text, /Files removed from these folders stay in your Brain/);
  assert.equal(created.result.approvalCount, 1);
});

test("create-feeds rolls back newly created empty folders when the manifest write fails", async () => {
  const f = fixture();
  const before = readFileSync(f.manifestPath);
  let writes = 0;
  const failed = await capture(() => cmdFolder(
    f.manifestPath,
    ["create-feeds"],
    folderOptions(f, {
      writeManifestAtomically() {
        writes += 1;
        throw new Error("injected manifest write refusal");
      },
    }),
  ));
  assert.match(failed.error?.message || "", /injected manifest write refusal/);
  assert.equal(writes, 1, "the failure arm reaches the atomic manifest decision");
  assert.equal(existsSync(join(f.home, "Brain Feeds")), false);
  assert.deepEqual(readFileSync(f.manifestPath), before);

  const control = await capture(() => cmdFolder(f.manifestPath, ["create-feeds"], folderOptions(f)));
  assert.ifError(control.error);
  assert.equal(existsSync(join(f.home, "Brain Feeds", "Client files")), true);
  assert.equal(existsSync(join(f.home, "Brain Feeds", "Transcripts")), true);
});

test("status reports source, existence, count, and newest time without file names", async () => {
  const f = fixture();
  const feed = join(f.home, "Status feed");
  mkdirSync(feed);
  const older = join(feed, "synthetic-one.txt");
  const newest = join(feed, "synthetic-two.txt");
  writeFileSync(older, "synthetic older record with enough words for a fixture\n");
  writeFileSync(newest, "synthetic newer record with enough words for a fixture\n");
  utimesSync(older, new Date("2026-10-01T10:00:00.000Z"), new Date("2026-10-01T10:00:00.000Z"));
  utimesSync(newest, new Date("2026-10-02T11:12:13.000Z"), new Date("2026-10-02T11:12:13.000Z"));
  assert.ifError((await addFeed(f, feed, "status_feed")).error);

  const status = await capture(() => cmdFolder(f.manifestPath, ["status"], folderOptions(f)));
  assert.ifError(status.error);
  assert.match(status.text, /Feed status_feed \| exists \| 2 files \| newest 2026-10-02T11:12:13\.000Z \|/);
  assert.equal(status.text.includes("synthetic-one.txt"), false);
  assert.equal(status.text.includes("synthetic-two.txt"), false);
  assert.equal(status.result.feeds.length, 1);
  assert.equal(status.result.feeds[0].fileCount, 2);
});

test("Mac path refusals are non-vacuous and each has an allowed control", async (t) => {
  await t.test("iCloud, CloudDocs, Mobile Documents, and File Provider roots", async () => {
    for (const relative of [
      ["Library", "Mobile Documents", "com~apple~CloudDocs", "Feed"],
      ["Library", "Application Support", "CloudDocs", "Feed"],
      ["Library", "CloudStorage", "Provider", "Feed"],
      ["Library", "FileProvider", "Provider", "Feed"],
    ]) {
      const f = fixture();
      const rejected = join(f.home, ...relative);
      mkdirSync(rejected, { recursive: true });
      await assertRejectedUnchanged(f, rejected, "cloud_feed", /iCloud|CloudDocs|File Provider/i);
      const allowed = join(f.home, "Brain Feeds", relative.at(-2), "Feed");
      mkdirSync(allowed, { recursive: true });
      const control = await addFeed(f, allowed, "local_feed");
      assert.ifError(control.error);
    }
  });

  await t.test("retired watched folder and retired upload roots", async () => {
    const retired = join(sandbox, "retired-root");
    const allowed = join(sandbox, "current-root");
    mkdirSync(retired, { recursive: true });
    mkdirSync(allowed, { recursive: true });
    const retiredState = statSync(realpathSync(retired), { bigint: true });
    const manifest = baseManifest({
      enabled: false,
      retired_at: "2026-09-28T16:36:00.000Z",
      folders: [{ path: retired, source: "old_feed", feed: true }],
    });
    manifest.corpora.local_folder = {
      enabled: false,
      path: retired,
      source: "old_feed",
      retired_at: "2026-09-28T16:36:00.000Z",
      retired_path: retired,
      retired_identity: {
        realpath: realpathSync(retired),
        dev: String(retiredState.dev),
        ino: String(retiredState.ino),
      },
    };
    const f = fixture({ manifest });
    await assertRejectedUnchanged(f, join(retired, "child"), "new_feed", /retired/i);
    const control = await addFeed(f, allowed, "current_feed");
    assert.ifError(control.error);
  });

  await t.test("symlink roots", async () => {
    const f = fixture();
    const target = join(f.home, "Target");
    const link = join(f.home, "Alias");
    mkdirSync(target);
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    await assertRejectedUnchanged(f, link, "alias_feed", /symbolic link|reparse point/i);
    const control = await addFeed(f, target, "target_feed");
    assert.ifError(control.error);
  });

  await t.test("parent or child overlap", async () => {
    const f = fixture();
    const parent = join(f.home, "Parent");
    const child = join(parent, "Child");
    const sibling = join(f.home, "Sibling");
    mkdirSync(child, { recursive: true });
    mkdirSync(sibling);
    assert.ifError((await addFeed(f, parent, "parent_feed")).error);
    await assertRejectedUnchanged(f, child, "child_feed", /parent or child/i);
    const control = await addFeed(f, sibling, "sibling_feed", {
      now: () => new Date("2026-10-06T18:05:07.123Z"),
    });
    assert.ifError(control.error);
  });

  await t.test("non-existent path", async () => {
    const f = fixture();
    const missing = join(f.home, "Missing");
    await assertRejectedUnchanged(f, missing, "missing_feed", /does not exist/i);
    mkdirSync(missing);
    const control = await addFeed(f, missing, "present_feed");
    assert.ifError(control.error);
  });

  await t.test("six-feed maximum with no force bypass", async () => {
    const folders = [];
    const f = fixture({ manifest: baseManifest({ enabled: true, folders }) });
    for (let index = 0; index < 7; index++) {
      const path = join(f.home, `Feed ${index + 1}`);
      mkdirSync(path);
      folders.push({ path, source: `feed_${index + 1}`, feed: true });
    }
    const five = structuredClone(f.manifest);
    five.corpora.upload.folders = folders.slice(0, 5);
    writeFileSync(f.manifestPath, manifestBytes(five));
    const sixth = await addFeed(f, folders[5].path, folders[5].source);
    assert.ifError(sixth.error);
    await assertRejectedUnchanged(f, folders[6].path, folders[6].source, /maximum of 6/i, {
      now: () => new Date("2026-10-06T18:05:07.123Z"),
    });
  });
});

test("Windows paths use case-insensitive overlap and refuse reparse and cloud roots", async () => {
  const directoryStat = {
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false,
  };
  const reparseStat = { ...directoryStat, isSymbolicLink: () => true };
  const paths = new Map();
  const addPath = (path, stat = directoryStat) => paths.set(win32Path.normalize(path).toLowerCase(), stat);
  const fakeFs = {
    existsSync(path) { return paths.has(win32Path.normalize(path).toLowerCase()); },
    lstatSync(path) {
      const found = paths.get(win32Path.normalize(path).toLowerCase());
      if (!found) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return found;
    },
    realpathNative(path) {
      if (!paths.has(win32Path.normalize(path).toLowerCase())) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return win32Path.normalize(path);
    },
    readdirSync() { return []; },
    statSync() { return { ...directoryStat, mtime: new Date(0), mtimeMs: 0 }; },
  };

  const f = fixture();
  const existing = "C:\\Users\\Owner\\Brain Feeds\\Files";
  const child = "c:\\users\\owner\\brain feeds\\files\\Nested";
  const sibling = "C:\\Users\\Owner\\Brain Feeds\\Transcripts";
  const junction = "C:\\Users\\Owner\\Brain Feeds\\Alias";
  const cloud = "C:\\Users\\Owner\\OneDrive\\Feed";
  for (const path of [existing, child, sibling, cloud]) addPath(path);
  addPath(junction, reparseStat);

  const windows = { platform: "win32", home: "C:\\Users\\Owner", feedFs: fakeFs };
  assert.ifError((await addFeed(f, existing, "files", windows)).error);
  await assertRejectedUnchanged(f, child, "nested", /parent or child/i, windows);
  await assertRejectedUnchanged(f, junction, "alias", /symbolic link|reparse point/i, windows);
  await assertRejectedUnchanged(f, cloud, "cloud", /File Provider|cloud-synced/i, windows);
  const control = await addFeed(f, sibling, "transcripts", {
    ...windows,
    now: () => new Date("2026-10-06T18:05:07.123Z"),
  });
  assert.ifError(control.error);
});

test("feed ingest skips placeholders and exclusions and never enters document removal", async () => {
  const f = fixture();
  const feed = join(f.home, "Append only feed");
  const excluded = join(feed, "Former records");
  mkdirSync(excluded, { recursive: true });
  writeFileSync(join(feed, "current.txt"), "Synthetic current record with enough words to load as a document.\n");
  writeFileSync(join(feed, "cloud-stub.pdf"), "");
  writeFileSync(join(excluded, "decoy.txt"), "Synthetic excluded record that must never be prepared or loaded.\n");
  f.manifest.corpora.upload = {
    enabled: true,
    folders: [{ path: feed, source: "client_files", feed: true }],
    exclude: ["Former records/"],
  };
  writeFileSync(f.manifestPath, manifestBytes(f.manifest));
  const statePath = join(dirname(f.manifestPath), ".brain-ingest-client_files.json");
  const state = {
    version: 1,
    done: {
      "gone.txt": "gone-hash",
      "Former records/old.txt": "excluded-hash",
    },
    skipped: {},
  };
  writeFileSync(statePath, manifestBytes(state));
  const stateBefore = readFileSync(statePath);
  let removalDiffs = 0;
  let removalCalls = 0;
  const prepared = [];
  const result = await cmdIngestLocal(f.manifest, f.manifestPath, {
    path: feed,
    source: "client_files",
    "dry-run": true,
  }, {
    sourceIngestLockOptions: { home: join(f.root, "ingest-home"), platform: process.platform },
    ingestLib: async () => ({
      ...ingestRuntime,
      removedSinceLastRun(...args) {
        removalDiffs += 1;
        return ingestRuntime.removedSinceLastRun(...args);
      },
      async prepare(file, options) {
        prepared.push(String(file.rel).replaceAll("\\", "/"));
        return ingestRuntime.prepare(file, options);
      },
    }),
    applyDriveRemovals: async () => {
      removalCalls += 1;
      return { applied: 0, pending: 0 };
    },
  });
  assert.equal(result.would_send, 1);
  assert.equal(result.placeholders, 1);
  assert.equal(result.excluded, 1);
  assert.deepEqual(prepared, ["current.txt"]);
  assert.equal(removalDiffs, 0, "feed mode never computes vanished documents");
  assert.equal(removalCalls, 0, "feed mode has no whole-document removal call");
  assert.deepEqual(readFileSync(statePath), stateBefore, "the dry run preserves resume state exactly");

  const mirror = structuredClone(f.manifest);
  mirror.corpora.upload.folders[0].feed = false;
  removalDiffs = 0;
  removalCalls = 0;
  await cmdIngestLocal(mirror, f.manifestPath, {
    path: feed,
    source: "client_files",
    "dry-run": true,
  }, {
    sourceIngestLockOptions: { home: join(f.root, "mirror-home"), platform: process.platform },
    ingestLib: async () => ({
      ...ingestRuntime,
      removedSinceLastRun(...args) {
        removalDiffs += 1;
        return ingestRuntime.removedSinceLastRun(...args);
      },
    }),
    applyDriveRemovals: async () => {
      removalCalls += 1;
      return { applied: 0, pending: 0 };
    },
  });
  assert.equal(removalDiffs, 1, "the mirror control reaches vanished-document comparison");
  assert.equal(removalCalls, 2, "the mirror control reaches both dry-run removal previews");
});

test("a real feed load preserves a disappeared document without inventory or removal calls", async () => {
  const f = fixture();
  const feed = join(f.home, "Empty feed");
  mkdirSync(feed);
  const manifest = baseManifest({
    enabled: true,
    folders: [{ path: feed, source: "client_files", feed: true }],
    exclude: [],
  });
  writeFileSync(f.manifestPath, manifestBytes(manifest));
  const statePath = join(dirname(f.manifestPath), ".brain-ingest-client_files.json");
  writeFileSync(statePath, manifestBytes({
    version: 1,
    done: { "gone.txt": "accepted-content-hash" },
    skipped: {},
    credential_scanner_fingerprint: credentialScannerFingerprint(true),
  }));
  let inventoryCalls = 0;
  let removalCalls = 0;
  let backlogCalls = 0;
  const receipts = [];
  const result = await cmdIngestLocal(manifest, f.manifestPath, {
    path: feed,
    source: "client_files",
  }, {
    sourceIngestLockOptions: { home: join(f.root, "real-load-home"), platform: process.platform },
    resolveBaseUrl: async () => "https://fixture.invalid",
    resolveAdminKey: () => "fixture-admin-key",
    postSourceReceipt: async (_base, _key, receipt) => { receipts.push(receipt); return { ok: true }; },
    listStoredSourceFamilies: async () => {
      inventoryCalls += 1;
      throw new Error("feed mode must not list removal inventory");
    },
    applyDriveRemovals: async () => {
      removalCalls += 1;
      throw new Error("feed mode must not call document removal");
    },
    reportBacklog: async () => { backlogCalls += 1; },
  });
  assert.equal(result.scanned, 0);
  assert.equal(inventoryCalls, 0);
  assert.equal(removalCalls, 0);
  assert.equal(backlogCalls, 1, "the successful control reaches post-load reporting");
  assert.deepEqual(receipts.map((receipt) => receipt.status), ["indexing", "ready"]);
  const after = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(after.done["gone.txt"], "accepted-content-hash");
  assert.equal(after.credential_scanner_fingerprint, credentialScannerFingerprint(true));
});

test("feed exclusion and placeholder controls detect a disabled safety rule", async () => {
  const f = fixture();
  const feed = join(f.home, "Control feed");
  const excluded = join(feed, "Former records");
  mkdirSync(excluded, { recursive: true });
  writeFileSync(join(feed, "cloud-stub.txt"), "");
  writeFileSync(join(excluded, "decoy.txt"), "Synthetic decoy content with enough words to load.\n");

  const run = async (manifest, home) => {
    const prepared = [];
    const result = await cmdIngestLocal(manifest, f.manifestPath, {
      path: feed,
      source: "client_files",
      "dry-run": true,
    }, {
      sourceIngestLockOptions: { home, platform: process.platform },
      ingestLib: async () => ({
        ...ingestRuntime,
        async prepare(file, options) {
          prepared.push(String(file.rel).replaceAll("\\", "/"));
          return ingestRuntime.prepare(file, options);
        },
      }),
      applyDriveRemovals: async () => ({ applied: 0, pending: 0 }),
    });
    return { result, prepared };
  };

  const guarded = baseManifest({
    enabled: true,
    folders: [{ path: feed, source: "client_files", feed: true }],
    exclude: ["Former records/"],
  });
  const guardedRun = await run(guarded, join(f.root, "guarded-home"));
  assert.equal(guardedRun.result.placeholders, 1);
  assert.equal(guardedRun.result.excluded, 1);
  assert.deepEqual(guardedRun.prepared, []);

  const unguarded = structuredClone(guarded);
  unguarded.corpora.upload.exclude = [];
  writeFileSync(join(feed, "cloud-stub.txt"), "Synthetic hydrated content with enough words to load.\n");
  const unguardedRun = await run(unguarded, join(f.root, "unguarded-home"));
  assert.equal(unguardedRun.result.placeholders, 0);
  assert.equal(unguardedRun.result.excluded, 0);
  assert.deepEqual(unguardedRun.prepared.sort(), ["Former records/decoy.txt", "cloud-stub.txt"]);
});

test.after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});
